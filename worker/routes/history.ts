/**
 * 402 History.
 *
 * Contract: `spec/SPEC.md` §5.4 · Schema: `spec/schemas/history.json`
 * Deviations found while implementing:.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  TWO SOURCES, TWO KINDS OF FACT, NEVER ONE ARRAY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * split the storage on purpose and this route is where the split
 * becomes something a reader can see:
 *
 *   **D1 `term_changes` — exact.** Append-only, enforced by database trigger,
 *   one row only when something actually changed, each stamped with the
 *   `score_version` in force when it was observed. Price and recipient history
 *   come from here. This is the record an operator would be shown in an appeal,
 *   so it is rendered as dated events and never as a smoothed line.
 *
 *   **Analytics Engine — sampled.** Availability and latency. Each stored row
 *   stands for `_sample_interval` real ones and old rows age out. Aggregated
 *   with `sum(_sample_interval)`, never `count` — counting rows under-reports
 *   exactly when an endpoint is busiest, which is when the number matters most.
 *
 * `coverage.sampled` states which (SPEC §5.4), but a boolean nobody renders is
 * not a distinction. `ui/pages/history/` carries it into both representations:
 * a price change gets an exact date, a sampled figure gets `≈` and the word
 * "sampled". Getting this wrong is how "99.94% available" and "the recipient
 * changed on Jul 21" come to look equally authoritative when only one of them
 * is evidence.
 *
 * ── Three properties inherited that shape the code below ──────────
 *
 *  1. **The Analytics Engine credential may be absent.** The SQL API is an
 *     account-level HTTP endpoint, not a binding (`CF_ACCOUNT_ID` var +
 *     `CF_ANALYTICS_TOKEN` secret). `queryAnalytics` returns
 *     `{rows: null, error}` rather than throwing, so this route can — and must
 *     — render **"we could not ask"** differently from **"there are no
 *     samples"**. They carry different warning codes and different copy.
 *
 *  2. **Ingestion lags.** We measured a datapoint invisible at +12 s and
 *     visible later. So D1 is read for the recent edge (`last_probe_at`) and
 *     Analytics Engine only for the aggregate, and a probe inside the lag
 *     horizon produces a `RECENT_PROBE_PENDING` warning rather than a page that
 *     says "no data" about something that just happened.
 *
 *  3. **Historical scores are never recomputed** (SPEC §7). Every change row is
 *     rendered with the `score_version` it was written under. This route
 *     computes no score at all, so `meta.score_version` is null — History
 *     reports what changed and when, and leaves the verdict to `/inspect`.
 *
 * **This route never probes.** It reads what the crawler already recorded, so
 * the URL is validated syntactically (userinfo refused, scheme allowlisted,
 * canonicalized to the join key) and nothing is resolved or fetched.
 */

import { envelope, errorResponse, html as htmlResponse, json, markdown, nowIso } from "../http.js";
import {
  HOSTED_URL_POLICY,
  canonicalizeUrl,
  endpointId,
  validateUrl,
} from "../lib/guard.js";
import { toDecimalString } from "../lib/probe.js";
import {
  ANALYTICS_DATASET,
  queryAnalytics,
  type AnalyticsCredential,
} from "../crawler/analytics.js";
import { historyMarkdown } from "../../ui/pages/history/markdown.js";
import { historyPage } from "../../ui/pages/history/page.js";
import {
  DEFAULT_WINDOW,
  WARN,
  WINDOW_DAYS,
  parseWindow,
  windowStart,
  type AvailabilityPoint,
  type HistoryData,
  type HistoryView,
  type HistoryWindow,
  type LatencyPoint,
  type PricePoint,
  type TermChange,
} from "../../ui/pages/history/types.js";
import type { Env, RouteContext, RouteHandler, RouteMeta, Warning } from "../types.js";

/**
 * Bucket width per window, chosen so a chart has enough points to show a shape
 * and few enough that each bucket holds real samples. At the crawler's `corpus`
 * cadence (one probe per endpoint per 24 h) a 6-hour bucket on the 7-day window
 * is often a single sample — which is exactly why every bucket carries its own
 * `samples` count and the page renders thin buckets as thin.
 */
const BUCKET: Record<HistoryWindow, { sql: string; label: string }> = {
  "7d": { sql: "INTERVAL '6' HOUR", label: "6 hours" },
  "30d": { sql: "INTERVAL '1' DAY", label: "1 day" },
  "90d": { sql: "INTERVAL '1' DAY", label: "1 day" },
};

/**
 * How recent a probe has to be for us to say the sampled series may not have
 * caught up. We saw ingestion take longer than 12 s; 15 minutes is one crawler
 * tick and is generous rather than precise, which is the right direction for a
 * caveat.
 */
const INGESTION_LAG_SECONDS = 15 * 60;

/** SPEC §1.5 ids are 32 lowercase hex characters. */
const ENDPOINT_ID = /^[0-9a-f]{32}$/u;

const CANONICAL_ATOMIC = /^(0|[1-9][0-9]*)$/u;

// ── the target ────────────────────────────────────────────────────────────

interface Target {
  url: string;
  canonical_url: string;
  endpoint_id: string;
  origin: string;
  host: string;
}

/**
 * Everything that can be decided about the URL without touching the network.
 *
 * History reads stored observations; it never probes. So this deliberately
 * stops at `validateUrl` — no DNS, no connection, no politeness spend — and the
 * only thing it needs from the URL is SPEC §1.5's canonical form, which is the
 * join key for every table the corpus keeps.
 */
async function resolveTarget(raw: string): Promise<{ target: Target } | { error: Response }> {
  const validated = validateUrl(raw, HOSTED_URL_POLICY);
  if (!validated.ok) {
    return {
      // `failure.reason` is deliberately not returned: the guard must not
      // double as a network scanner for whoever is probing it.
      error: errorResponse(validated.failure.code, {
        detail: { stage: validated.failure.stage },
      }),
    };
  }

  const { url } = validated.value;
  const canonical = canonicalizeUrl(url);

  return {
    target: {
      url: raw,
      canonical_url: canonical,
      endpoint_id: await endpointId(canonical),
      origin: url.origin,
      host: url.hostname.toLowerCase(),
    },
  };
}

// ── D1: the exact half ────────────────────────────────────────────────────

interface EndpointRow {
  first_seen: string | null;
  last_seen: string | null;
  last_probe_at: string | null;
  scan_count: number;
  status: string | null;
}

interface CurrentTerms {
  amount_atomic: string | null;
  asset_symbol: string | null;
  asset_decimals: number | null;
  network: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The window's changes, the endpoint's coverage, the price in force entering
 * the window, and the current terms — in one round trip.
 *
 * The "price entering the window" query is the one that is easy to leave out
 * and expensive to be without: without it, an endpoint whose price has been
 * stable for a year renders an empty 30-day chart, which reads as "we know
 * nothing" when the truth is "it has not changed since June".
 */
async function loadExact(
  db: D1Database,
  id: string,
  from: string,
): Promise<{
  endpoint: EndpointRow | null;
  changes: TermChange[];
  priorPrice: { changed_at: string; new_value: string | null } | null;
  terms: CurrentTerms | null;
}> {
  const [endpointResult, changeResult, priorResult, termsResult] = await db.batch<
    Record<string, unknown>
  >([
    db
      .prepare(
        `SELECT first_seen, last_seen, last_probe_at, scan_count, status
           FROM endpoints WHERE id = ?`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT id, changed_at, change_kind, field, old_value, new_value,
                detected_by, score_version
           FROM term_changes
          WHERE endpoint_id = ? AND changed_at >= ?
          ORDER BY changed_at ASC, id ASC`,
      )
      .bind(id, from),
    db
      .prepare(
        `SELECT changed_at, new_value
           FROM term_changes
          WHERE endpoint_id = ? AND change_kind = 'price' AND changed_at < ?
          ORDER BY changed_at DESC
          LIMIT 1`,
      )
      .bind(id, from),
    db
      .prepare(
        `SELECT amount_atomic, asset_symbol, asset_decimals, network
           FROM terms_current WHERE endpoint_id = ?`,
      )
      .bind(id),
  ]);

  const endpointRow = endpointResult?.results?.[0];
  const priorRow = priorResult?.results?.[0];
  const termsRow = termsResult?.results?.[0];

  return {
    endpoint: endpointRow
      ? {
          first_seen: str(endpointRow.first_seen),
          last_seen: str(endpointRow.last_seen),
          last_probe_at: str(endpointRow.last_probe_at),
          scan_count: Number(endpointRow.scan_count ?? 0),
          status: str(endpointRow.status),
        }
      : null,
    changes: (changeResult?.results ?? []).map((row) => ({
      id: str(row.id) ?? "",
      changed_at: str(row.changed_at) ?? "",
      change_kind: (str(row.change_kind) ?? "status") as TermChange["change_kind"],
      field: str(row.field) ?? "",
      old_value: str(row.old_value),
      new_value: str(row.new_value),
      detected_by: (str(row.detected_by) ?? "crawler") as TermChange["detected_by"],
      score_version: str(row.score_version),
    })),
    priorPrice: priorRow
      ? { changed_at: str(priorRow.changed_at) ?? "", new_value: str(priorRow.new_value) }
      : null,
    terms: termsRow
      ? {
          amount_atomic: str(termsRow.amount_atomic),
          asset_symbol: str(termsRow.asset_symbol),
          asset_decimals:
            termsRow.asset_decimals === null || termsRow.asset_decimals === undefined
              ? null
              : Number(termsRow.asset_decimals),
          network: str(termsRow.network),
        }
      : null,
  };
}

/**
 * The value a field held at time `t`, reconstructed by walking the change log
 * backwards from the current value.
 *
 * This exists so a historical price point never carries today's asset symbol.
 * An endpoint that moved from one token to another would otherwise render its
 * old prices denominated in the new one — a small-looking error that makes
 * every number on the chart wrong. Where the log does not reach far enough the
 * answer is `null`, which the schema permits and which is honest.
 */
function valueAt(
  field: string,
  t: string,
  current: string | null,
  changes: readonly TermChange[],
): string | null {
  let value = current;
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    if (!change || change.field !== field) continue;
    if (change.changed_at > t) value = change.old_value;
    else break;
  }
  return value;
}

/**
 * The price series: **exact events with dates**, not samples.
 *
 * Every point is a price we observed, stamped with the moment we observed it.
 * The leading point is the price in force when the window opened, carrying its
 * real (possibly pre-window) date rather than a manufactured one at the window
 * edge — a fabricated timestamp on the one series that is meant to be evidence
 * would defeat the whole storage split. When that happens the response says so
 * with `PRICE_ANCHOR_BEFORE_WINDOW`.
 */
function buildPriceSeries(
  changes: readonly TermChange[],
  priorPrice: { changed_at: string; new_value: string | null } | null,
  terms: CurrentTerms | null,
  firstSeen: string | null,
  from: string,
): { points: PricePoint[]; anchorBeforeWindow: boolean } {
  const priceChanges = changes.filter((c) => c.change_kind === "price");

  const point = (t: string, atomic: string): PricePoint => {
    const symbol = valueAt("asset_symbol", t, terms?.asset_symbol ?? null, changes);
    const network = valueAt("network", t, terms?.network ?? null, changes);
    // Decimals are only known for the asset we currently hold terms for, so a
    // decimal rendering is offered only when the asset in force at `t` is that
    // same asset. Otherwise the atomic value stands alone and the page labels
    // it as atomic (SPEC §1.4: never silently rescale a price).
    const decimals =
      symbol !== null && symbol === (terms?.asset_symbol ?? null) ? (terms?.asset_decimals ?? null) : null;

    return {
      t,
      amount_atomic: atomic,
      amount_decimal: decimals === null ? null : toDecimalString(atomic, decimals),
      asset_symbol: symbol,
      network,
    };
  };

  const points: PricePoint[] = [];

  // The price entering the window, and the date it was actually established.
  const anchorAmount = priceChanges[0]?.old_value ?? terms?.amount_atomic ?? null;
  const anchorAt = priorPrice?.changed_at ?? firstSeen;
  let anchorBeforeWindow = false;

  if (anchorAmount && CANONICAL_ATOMIC.test(anchorAmount) && anchorAt) {
    const firstChangeAt = priceChanges[0]?.changed_at;
    if (!firstChangeAt || anchorAt < firstChangeAt) {
      points.push(point(anchorAt, anchorAmount));
      anchorBeforeWindow = anchorAt < from;
    }
  }

  for (const change of priceChanges) {
    // A non-canonical amount fails `spec/schemas/common.json#AtomicAmount`, so
    // it is kept out of the series — the change itself still appears in
    // `changes`, where it is a string we recorded rather than a number we chart.
    if (change.new_value && CANONICAL_ATOMIC.test(change.new_value)) {
      points.push(point(change.changed_at, change.new_value));
    }
  }

  return { points, anchorBeforeWindow };
}

// ── Analytics Engine: the sampled half ────────────────────────────────────

function credentialFrom(env: Env): AnalyticsCredential | null {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  return { accountId: env.CF_ACCOUNT_ID, token: env.CF_ANALYTICS_TOKEN };
}

/**
 * Availability per bucket.
 *
 * `sum(_sample_interval)` and `sumIf(_sample_interval, …)`, never `count`:
 * the dataset is sampled and each stored row stands for `_sample_interval` real
 * ones, so counting rows under-reports precisely when an endpoint is busiest.
 */
export function availabilitySeriesQuery(id: string, window: HistoryWindow): string {
  return `SELECT
      toStartOfInterval(timestamp, ${BUCKET[window].sql}) AS bucket,
      sum(_sample_interval) AS samples,
      sumIf(_sample_interval, double1 > 0) AS ok_samples
    FROM ${ANALYTICS_DATASET}
    WHERE blob1 = 'probe'
      AND blob2 = '${id}'
      AND timestamp > now() - INTERVAL '${WINDOW_DAYS[window]}' DAY
    GROUP BY bucket
    ORDER BY bucket ASC
    FORMAT JSON`;
}

/**
 * Latency per bucket, over **successful probes only** (`double1 > 0`).
 *
 * A failed probe records a latency of zero, so including failures would pull
 * the median down exactly when an endpoint is failing — a latency chart that
 * improves as an endpoint breaks. It is a second query rather than a weighted
 * trick so that a failure of one does not take the other with it: if this query
 * is refused, the availability series still renders.
 */
export function latencySeriesQuery(id: string, window: HistoryWindow): string {
  return `SELECT
      toStartOfInterval(timestamp, ${BUCKET[window].sql}) AS bucket,
      sum(_sample_interval) AS samples,
      quantileExactWeighted(0.5)(double2, _sample_interval) AS p50_ms,
      quantileExactWeighted(0.95)(double2, _sample_interval) AS p95_ms
    FROM ${ANALYTICS_DATASET}
    WHERE blob1 = 'probe'
      AND blob2 = '${id}'
      AND double1 > 0
      AND timestamp > now() - INTERVAL '${WINDOW_DAYS[window]}' DAY
    GROUP BY bucket
    ORDER BY bucket ASC
    FORMAT JSON`;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** `2026-08-14 06:00:00` (Analytics Engine) → `2026-08-14T06:00:00Z` (SPEC §1.3). */
function bucketToIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) return value;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/u.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : null;
}

interface SampledSeries {
  availability: AvailabilityPoint[];
  latency: LatencyPoint[];
  /** Set when we could not ask. Distinct from having asked and found nothing. */
  error: string | null;
}

/**
 * Both sampled series, fetched together.
 *
 * The two failure modes are kept apart all the way to the page: a `null` rows
 * array means *we could not ask*, an empty rows array means *we asked and there
 * is nothing here*. We shaped `queryAnalytics` this way on purpose, and
 * collapsing the two into "no data" would let a missing credential masquerade
 * as a quiet endpoint.
 */
async function loadSampled(
  env: Env,
  id: string,
  window: HistoryWindow,
  fetchImpl: typeof fetch = fetch,
): Promise<SampledSeries> {
  const credential = credentialFrom(env);
  if (!credential) {
    return { availability: [], latency: [], error: "no analytics credential configured" };
  }

  // The SQL API takes a raw string — there are no bound parameters — so the id
  // is checked against SPEC §1.5's shape before it is interpolated. It always
  // comes from `endpointId` and so always passes; the check is here because
  // "it always passes" is exactly the assumption a later edit breaks.
  if (!ENDPOINT_ID.test(id)) {
    return { availability: [], latency: [], error: "malformed endpoint id" };
  }

  const [availabilityResult, latencyResult] = await Promise.all([
    queryAnalytics(credential, availabilitySeriesQuery(id, window), fetchImpl),
    queryAnalytics(credential, latencySeriesQuery(id, window), fetchImpl),
  ]);

  // Availability is the load-bearing one: if it could not be asked, the sampled
  // half of the page is unknown rather than empty.
  if (!availabilityResult.rows) {
    return { availability: [], latency: [], error: availabilityResult.error ?? "query refused" };
  }

  const availability: AvailabilityPoint[] = [];
  for (const row of availabilityResult.rows) {
    const t = bucketToIso(row.bucket);
    const samples = num(row.samples) ?? 0;
    const ok = num(row.ok_samples) ?? 0;
    if (t === null || samples <= 0) continue;
    availability.push({
      t,
      // Clamped because the schema bounds it to [0,1] and a sampled ratio
      // should never be able to fail validation over a rounding artefact.
      ratio: Math.min(1, Math.max(0, ok / samples)),
      samples: Math.round(samples),
    });
  }

  const latency: LatencyPoint[] = [];
  for (const row of latencyResult.rows ?? []) {
    const t = bucketToIso(row.bucket);
    const samples = num(row.samples) ?? 0;
    if (t === null || samples <= 0) continue;
    const p50 = num(row.p50_ms);
    const p95 = num(row.p95_ms);
    latency.push({
      t,
      p50_ms: p50 === null ? null : Math.max(0, Math.round(p50)),
      p95_ms: p95 === null ? null : Math.max(0, Math.round(p95)),
      samples: Math.round(samples),
    });
  }

  return { availability, latency, error: null };
}

// ── assembling the answer ─────────────────────────────────────────────────

export interface LoadOptions {
  /** Injected in tests so the sampled half can be exercised without the API. */
  fetchImpl?: typeof fetch;
  now?: string;
}

/**
 * The whole result, from both stores, with the warnings that explain any gap.
 *
 * Every warning here is a fact about the answer's completeness (SPEC §2), and
 * they are the channel through which the page learns *why* a series is empty —
 * `spec/schemas/history.json` is frozen with `additionalProperties: false`, so
 * `data` has no room for a "we could not ask" flag and inventing one would be a
 * schema change to a file this change does not own.
 */
export async function loadHistory(
  env: Env,
  target: Target,
  window: HistoryWindow,
  options: LoadOptions = {},
): Promise<HistoryView> {
  const now = options.now ?? nowIso();
  const from = windowStart(now, window);
  const warnings: Warning[] = [];

  const { endpoint, changes, priorPrice, terms } = await loadExact(env.DB, target.endpoint_id, from);

  if (!endpoint) {
    // Not in the corpus. this is the correct display for an
    // endpoint we have not met, not a degraded one to apologize for. No
    // Analytics Engine call is made — there is nothing to aggregate, and asking
    // would only be able to answer about an id we have never written.
    return {
      data: {
        target,
        window,
        has_data: false,
        coverage: { first_seen: null, last_seen: null, scan_count: 0, sampled: false },
        series: { price: [], availability: [], latency: [] },
        changes: [],
      },
      warnings: [
        {
          code: WARN.NOT_IN_CORPUS,
          message: "We have no record of this endpoint, so there is no history to show.",
        },
      ],
    };
  }

  const sampled = await loadSampled(env, target.endpoint_id, window, options.fetchImpl);

  if (sampled.error !== null) {
    warnings.push({
      code: WARN.ANALYTICS_UNAVAILABLE,
      message: `Availability and latency could not be read: ${sampled.error}. This is not the same as there being no measurements.`,
    });
  } else if (sampled.availability.length === 0 && sampled.latency.length === 0) {
    warnings.push({
      code: WARN.NO_SAMPLES,
      message: `We asked, and there are no probe samples for this endpoint in the last ${window}.`,
    });
  }

  // The recent edge lives in D1, which knows about a probe before Analytics
  // Engine has ingested it. Saying so is what stops the
  // page reporting "no data" about something that happened a minute ago.
  // Only when we actually got an answer from Analytics Engine, including an
  // empty one — that empty answer is exactly what the caveat explains. When we
  // could not ask at all, there is no sampled figure for the lag to qualify and
  // the caveat would be noise attached to a different problem.
  const lastProbe = endpoint.last_probe_at ?? endpoint.last_seen;
  if (
    sampled.error === null &&
    lastProbe &&
    Date.parse(now) - Date.parse(lastProbe) < INGESTION_LAG_SECONDS * 1000
  ) {
    warnings.push({
      code: WARN.RECENT_PROBE_PENDING,
      message:
        "We probed this endpoint in the last few minutes, and the sampled figures may not include that probe yet.",
    });
  }

  const { points: price, anchorBeforeWindow } = buildPriceSeries(
    changes,
    priorPrice,
    terms,
    endpoint.first_seen,
    from,
  );

  if (anchorBeforeWindow) {
    warnings.push({
      code: WARN.PRICE_ANCHOR_BEFORE_WINDOW,
      message:
        "The first price shown was established before this window opened; its date is when we observed it, not the start of the window.",
    });
  }

  // A window that opens before we ever saw the endpoint. The chart must start
  // where our observations start rather than drawing a flat line to the left
  // edge, so the fact is stated rather than left to be inferred from a date.
  if (endpoint.first_seen && endpoint.first_seen > from) {
    const days = Math.max(
      0,
      Math.floor((Date.parse(now) - Date.parse(endpoint.first_seen)) / 86_400_000),
    );
    warnings.push({
      code: WARN.THIN_HISTORY,
      message:
        days === 0
          ? "We first observed this endpoint today, so this window is almost entirely before our record begins."
          : `We have ${days} day${days === 1 ? "" : "s"} of history for this endpoint, which is less than the ${window} window.`,
    });
  }

  const sampledPresent = sampled.availability.length > 0 || sampled.latency.length > 0;

  return {
    data: {
      target,
      window,
      has_data: changes.length > 0 || price.length > 0 || sampledPresent,
      coverage: {
        first_seen: endpoint.first_seen,
        last_seen: endpoint.last_seen,
        scan_count: endpoint.scan_count,
        // SPEC §5.4: mandatory whenever a series comes from Analytics Engine.
        // False when none did, so the flag says something rather than being
        // decoration that is always on.
        sampled: sampledPresent,
      },
      series: { price, availability: sampled.availability, latency: sampled.latency },
      changes,
    },
    warnings,
  };
}

/** The empty view a request with no `url` renders. */
function noTarget(window: HistoryWindow): HistoryView {
  return {
    data: {
      target: { url: null, canonical_url: null, endpoint_id: null, origin: null, host: null },
      window,
      has_data: false,
      coverage: { first_seen: null, last_seen: null, scan_count: 0, sampled: false },
      series: { price: [], availability: [], latency: [] },
      changes: [],
    },
    warnings: [
      { code: WARN.NO_TARGET, message: "Pass ?url= to see an endpoint's history." },
    ],
  };
}

// ── the route ─────────────────────────────────────────────────────────────

export const history: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const raw = ctx.url.searchParams.get("url");
  const window = parseWindow(ctx.url.searchParams.get("window"));
  const meta = ctx.route;

  let view: HistoryView;

  if (!raw || raw.trim().length === 0) {
    view = noTarget(window);
  } else {
    const resolved = await resolveTarget(raw.trim());
    if ("error" in resolved) return resolved.error;
    view = await loadHistory(ctx.env, resolved.target, window);
  }

  return render(ctx, meta, view);
};

/**
 * One result, three representations (SPEC §1.2).
 *
 * The markdown and the HTML are **renderings of the same `HistoryView`**, never
 * a second computation — they are handed the identical data and warnings the
 * JSON carries. If they could disagree about whether a number is sampled, the
 * design would be wrong.
 */
function render(ctx: RouteContext, meta: RouteMeta, view: HistoryView): Response {
  const body = envelope<HistoryData>(meta, view.data, {
    warnings: view.warnings,
    // History reports what changed and when. It computes no score, so there is
    // no score version to stamp (SPEC §2) — and the per-change `score_version`
    // in each row is the one that was in force then, never today's (SPEC §7).
    scoreVersion: null,
  });

  if (ctx.format === "json") return json(body, {}, ctx);
  if (ctx.format === "markdown") {
    return markdown(historyMarkdown({ view, envelope: body }), {}, ctx);
  }

  return htmlResponse(
    historyPage({
      view,
      envelope: body,
      path: "/history",
      turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY,
    }),
    {},
    ctx,
  );
}

export { DEFAULT_WINDOW };
