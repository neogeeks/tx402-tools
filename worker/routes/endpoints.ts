/**
 * Corpus listing. (the crawler populates what it lists).
 *
 * Opted-out endpoints are excluded at READ time as well as at crawl time, so an
 * operator does not have to wait for the next cycle to disappear
 * (docs/abuse-policy.md).
 *
 * ── Why the read-time filter is two conditions and not one ─────────────────
 *
 * its `recordOptOut` flips `endpoints.status = 'opted_out'` in the same batch
 * that writes the `optouts` row, so `status` alone catches every endpoint that
 * existed when the opt-out was recorded. It does not catch the one discovered
 * *afterwards* under an origin-scoped opt-out: the crawler ingests it as
 * `active`, and it would appear on a public listing belonging to an operator
 * who has already asked to be left out. So the listing filters on `status`
 * **and** on a live `optouts` predicate — the same predicate its `isOptedOut`
 * uses, expressed in SQL so it costs one query rather than one per row.
 *
 * ── This module is also Compare's read layer ───────────────────────────────
 *
 * `worker/routes/compare.ts` reads the same rows through the same functions.
 * Two implementations of "what is in the corpus" would eventually disagree
 * about exactly the case above, which is the one that matters.
 */

import { envelope, errorResponse, json } from "../http.js";
import { asNumber, asString, asStringOrNull } from "../crawler/coerce.js";
import { CURRENT_SCORE_VERSION, score as scoreSignals } from "../lib/score.js";
import type { Risk } from "../lib/score.js";
import type { Signal } from "../lib/signals.js";
import type { Requirement } from "../lib/probe.js";
import type {
  AdvertisedTerms,
  DataState,
  FacilitatorClaim,
} from "../../ui/pages/compare/types.js";
import type { RouteContext, RouteHandler } from "../types.js";

/** A page bigger than this is a scrape, not a listing. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The opt-out predicate, as a SQL fragment over an `endpoints` alias.
 *
 * Takes one bound parameter: `now`. Kept as a single exported string so the
 * listing, the category pages and the `?urls=` comparison cannot drift into
 * three slightly different definitions of "excluded".
 */
export function optedOutExclusion(alias: string): string {
  return `${alias}.status <> 'opted_out'
      AND NOT EXISTS (
        SELECT 1 FROM optouts o
         WHERE o.revoked_at IS NULL
           AND o.effective_at <= ?
           AND ((o.scope = 'endpoint' AND o.target = ${alias}.canonical_url)
             OR (o.scope = 'origin'   AND o.target = ${alias}.origin))
      )`;
}

export interface CorpusRow {
  endpoint_id: string;
  canonical_url: string;
  url: string;
  origin: string;
  host: string;
  title: string | null;
  description: string | null;
  status: string;
  discovery_source: string;
  resource_type: string;
  first_seen: string;
  last_seen: string;
  scan_count: number;
  terms: Requirement | null;
  wire_form: string | null;
  x402_version: number | null;
  score: number | null;
  band: string | null;
  score_version: string | null;
  signals: Signal[] | null;
  observed_at: string | null;
  data_state: DataState;
}

const CORPUS_COLUMNS = `
  e.id, e.canonical_url, e.url, e.origin, e.host, e.title, e.description,
  e.status, e.discovery_source, e.resource_type, e.first_seen, e.last_seen, e.scan_count,
  t.x402_version, t.wire_form, t.scheme, t.network, t.asset_address, t.asset_symbol,
  t.asset_decimals, t.amount_atomic, t.amount_decimal, t.pay_to, t.pay_to_dynamic,
  t.max_timeout_seconds, t.facilitator, t.resource, t.mime_type,
  t.description AS terms_description, t.extra_json, t.signals_json,
  t.score, t.band, t.score_version, t.observed_at`;

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function signalValue(signals: Signal[] | null, id: string): Signal | null {
  if (!signals) return null;
  return signals.find((s) => s.id === id) ?? null;
}

function booleanSignal(signals: Signal[] | null, id: string): boolean | null {
  const signal = signalValue(signals, id);
  if (!signal || !signal.observed) return null;
  return typeof signal.value === "boolean" ? signal.value : null;
}

/**
 * Rebuild the `Requirement` we observed from the flat `terms_current` columns.
 *
 * `network_recognized` and `asset.recognized` are not columns — they are
 * signals, and they are read back out of the stored `signals_json` rather than
 * recomputed against today's manifest. A recognized-network answer produced
 * today would be a claim about today attached to an observation from March.
 * Absent ⇒ `null`, which renders as "not observed" and never as `false`.
 */
function requirementFrom(row: Record<string, unknown>, signals: Signal[] | null): Requirement | null {
  const hasTerms = row.observed_at !== null && row.observed_at !== undefined;
  if (!hasTerms) return null;

  const decimals = row.asset_decimals === null || row.asset_decimals === undefined
    ? null
    : asNumber(row.asset_decimals, 0);
  const address = asStringOrNull(row.asset_address);
  const symbol = asStringOrNull(row.asset_symbol);

  const asset =
    address === null && symbol === null && decimals === null
      ? null
      : {
          address,
          symbol,
          decimals,
          recognized: booleanSignal(signals, "asset_recognized"),
        };

  return {
    scheme: asStringOrNull(row.scheme),
    network: asStringOrNull(row.network),
    network_recognized: booleanSignal(signals, "network_recognized"),
    asset,
    amount_atomic: asStringOrNull(row.amount_atomic),
    amount_raw: null,
    amount_decimal: asStringOrNull(row.amount_decimal),
    pay_to: asStringOrNull(row.pay_to),
    pay_to_dynamic: Number(row.pay_to_dynamic ?? 0) === 1,
    max_timeout_seconds:
      row.max_timeout_seconds === null || row.max_timeout_seconds === undefined
        ? null
        : asNumber(row.max_timeout_seconds, 0),
    resource: asStringOrNull(row.resource),
    mime_type: asStringOrNull(row.mime_type),
    description: asStringOrNull(row.terms_description),
    facilitator: asStringOrNull(row.facilitator),
    extra: parseJson<Record<string, unknown>>(row.extra_json) ?? {},
  };
}

/**
 * Which of the five empty states this row is in.
 *
 * Every one of these is a different fact about *us*, and rendering all five as
 * a blank cell is the thing forbids.
 */
function dataStateFor(row: {
  terms: Requirement | null;
  scan_count: number;
  status: string;
}): DataState {
  if (row.terms) return "observed";
  if (row.scan_count === 0) return "not_probed";
  if (row.status === "not_x402") return "no_challenge";
  if (row.status === "unreachable" || row.status === "gone") return "unreachable";
  return "not_probed";
}

function toCorpusRow(raw: Record<string, unknown>): CorpusRow {
  const signals = parseJson<Signal[]>(raw.signals_json);
  const terms = requirementFrom(raw, signals);
  const status = asString(raw.status, "active");
  const scan_count = asNumber(raw.scan_count, 0);

  return {
    endpoint_id: asString(raw.id, ""),
    canonical_url: asString(raw.canonical_url, ""),
    url: asString(raw.url, ""),
    origin: asString(raw.origin, ""),
    host: asString(raw.host, ""),
    title: asStringOrNull(raw.title),
    description: asStringOrNull(raw.description),
    status,
    discovery_source: asString(raw.discovery_source, "seed"),
    resource_type: asString(raw.resource_type, "http"),
    first_seen: asString(raw.first_seen, ""),
    last_seen: asString(raw.last_seen, ""),
    scan_count,
    terms,
    wire_form: asStringOrNull(raw.wire_form),
    x402_version:
      raw.x402_version === null || raw.x402_version === undefined
        ? null
        : asNumber(raw.x402_version, 0),
    score: raw.score === null || raw.score === undefined ? null : asNumber(raw.score, 0),
    band: asStringOrNull(raw.band),
    score_version: asStringOrNull(raw.score_version),
    signals,
    observed_at: asStringOrNull(raw.observed_at),
    data_state: dataStateFor({ terms, scan_count, status }),
  };
}

export interface CorpusQuery {
  now: string;
  /** Exact endpoint ids. Used by `?urls=`; order is restored by the caller. */
  ids?: string[];
  /** Category slug, joined through `endpoint_categories`. */
  category?: string;
  host?: string;
  /** Only rows whose terms we have actually observed. */
  observedOnly?: boolean;
  limit?: number;
  /** Keyset cursor: the last `endpoint_id` of the previous page. */
  after?: string | null;
}

/**
 * Read corpus rows, opt-outs already excluded.
 *
 * Pagination is a keyset on `endpoints.id`, not an OFFSET. The corpus grows on
 * a 15-minute tick, and an OFFSET page 2 taken after an insert silently skips
 * or repeats rows. `id` is the primary key and is immutable once written, so a
 * keyset over it cannot.
 */
export async function loadCorpus(db: D1Database, query: CorpusQuery): Promise<CorpusRow[]> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const binds: unknown[] = [];
  const where: string[] = [];

  // `optedOutExclusion` binds `now` first, so it goes first here too.
  where.push(optedOutExclusion("e"));
  binds.push(query.now);

  if (query.ids) {
    if (query.ids.length === 0) return [];
    where.push(`e.id IN (${query.ids.map(() => "?").join(", ")})`);
    binds.push(...query.ids);
  }

  if (query.category) {
    where.push(
      `EXISTS (SELECT 1 FROM endpoint_categories ec
                WHERE ec.endpoint_id = e.id AND ec.category_slug = ?)`,
    );
    binds.push(query.category);
  }

  if (query.host) {
    where.push(`e.host = ?`);
    binds.push(query.host.toLowerCase());
  }

  if (query.observedOnly) where.push(`t.observed_at IS NOT NULL`);

  if (query.after) {
    where.push(`e.id > ?`);
    binds.push(query.after);
  }

  const sql = `SELECT ${CORPUS_COLUMNS}
                 FROM endpoints e
                 LEFT JOIN terms_current t ON t.endpoint_id = e.id
                WHERE ${where.join("\n                  AND ")}
                ORDER BY e.id
                LIMIT ?`;

  binds.push(query.ids ? Math.min(query.ids.length, MAX_PAGE_SIZE) : limit);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map(toCorpusRow);
}

/** How many rows the corpus holds under this filter, opt-outs excluded. */
export async function countCorpus(db: D1Database, query: CorpusQuery): Promise<number> {
  const binds: unknown[] = [query.now];
  const where: string[] = [optedOutExclusion("e")];

  if (query.category) {
    where.push(
      `EXISTS (SELECT 1 FROM endpoint_categories ec
                WHERE ec.endpoint_id = e.id AND ec.category_slug = ?)`,
    );
    binds.push(query.category);
  }
  if (query.host) {
    where.push(`e.host = ?`);
    binds.push(query.host.toLowerCase());
  }
  if (query.observedOnly) {
    where.push(`EXISTS (SELECT 1 FROM terms_current t WHERE t.endpoint_id = e.id)`);
  }

  const row = await db
    .prepare(`SELECT count(*) AS n FROM endpoints e WHERE ${where.join(" AND ")}`)
    .bind(...binds)
    .first<{ n: number }>();

  return Number(row?.n ?? 0);
}

// ── provenance: the facilitator's claims, kept as claims ─────────────────

export interface ProvenanceFacts {
  quality: FacilitatorClaim | null;
  advertised: AdvertisedTerms | null;
  tags: string[];
  service_name: string | null;
}

/**
 * `json_valid` is not belt-and-braces here — it is load-bearing.
 *
 * `ingestResources` stores `raw_json` truncated to 8,192 bytes, which cuts a
 * large listing mid-token and leaves a string that is not JSON. Measured
 * 2026-08-15 against 802 live Bazaar resources: 11 (1.4%) exceed the cap, and
 * every one of them loses its `tags` and its `quality` object. Without the
 * guard `json_extract` raises and the whole query fails; with it those rows
 * simply carry no claim, which renders as "not observed" — the honest answer.
 * Recorded for.
 */
function jsonField(path: string): string {
  return `CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '${path}') END`;
}

export async function loadProvenance(
  db: D1Database,
  endpointIds: string[],
): Promise<Map<string, ProvenanceFacts>> {
  const out = new Map<string, ProvenanceFacts>();
  if (endpointIds.length === 0) return out;

  const result = await db
    .prepare(
      `SELECT endpoint_id, source, facilitator_id, claimed_last_updated, observed_at,
              ${jsonField("$.quality.l30DaysTotalCalls")} AS calls_30d,
              ${jsonField("$.quality.l30DaysUniquePayers")} AS unique_payers_30d,
              ${jsonField("$.quality.lastCalledAt")} AS last_called_at,
              COALESCE(${jsonField("$.accepts[0].amount")},
                       ${jsonField("$.accepts[0].maxAmountRequired")}) AS adv_amount,
              ${jsonField("$.accepts[0].network")} AS adv_network,
              ${jsonField("$.accepts[0].asset")} AS adv_asset,
              ${jsonField("$.accepts[0].scheme")} AS adv_scheme,
              ${jsonField("$.accepts[0].payTo")} AS adv_pay_to,
              ${jsonField("$.tags")} AS tags,
              COALESCE(${jsonField("$.serviceName")},
                       ${jsonField("$.metadata.serviceName")}) AS service_name
         FROM endpoint_provenance
        WHERE endpoint_id IN (${endpointIds.map(() => "?").join(", ")})
        ORDER BY observed_at`,
    )
    .bind(...endpointIds)
    .all<Record<string, unknown>>();

  for (const raw of result.results ?? []) {
    const id = asString(raw.endpoint_id, "");
    const existing = out.get(id) ?? {
      quality: null,
      advertised: null,
      tags: [],
      service_name: null,
    };

    const calls = raw.calls_30d;
    if (calls !== null && calls !== undefined) {
      existing.quality = {
        facilitator_id: asStringOrNull(raw.facilitator_id),
        calls_30d: asNumber(calls, 0),
        unique_payers_30d:
          raw.unique_payers_30d === null || raw.unique_payers_30d === undefined
            ? null
            : asNumber(raw.unique_payers_30d, 0),
        last_called_at: asStringOrNull(raw.last_called_at),
        claimed_last_updated: asStringOrNull(raw.claimed_last_updated),
      };
    }

    const advAmount = asStringOrNull(raw.adv_amount);
    const advNetwork = asStringOrNull(raw.adv_network);
    if (advAmount !== null || advNetwork !== null) {
      existing.advertised = {
        amount: advAmount,
        network: advNetwork,
        asset: asStringOrNull(raw.adv_asset),
        scheme: asStringOrNull(raw.adv_scheme),
        pay_to: asStringOrNull(raw.adv_pay_to),
        facilitator_id: asStringOrNull(raw.facilitator_id),
      };
    }

    const tags = parseJson<unknown[]>(raw.tags);
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (typeof tag === "string" && tag.length > 0 && !existing.tags.includes(tag)) {
          existing.tags.push(tag);
        }
      }
    }

    existing.service_name = existing.service_name ?? asStringOrNull(raw.service_name);
    out.set(id, existing);
  }

  return out;
}

/** Which categories an endpoint has been assigned to, and by whom. */
export async function loadCategoryAssignments(
  db: D1Database,
  endpointIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (endpointIds.length === 0) return out;

  const result = await db
    .prepare(
      `SELECT endpoint_id, category_slug
         FROM endpoint_categories
        WHERE endpoint_id IN (${endpointIds.map(() => "?").join(", ")})
        ORDER BY category_slug`,
    )
    .bind(...endpointIds)
    .all<Record<string, unknown>>();

  for (const raw of result.results ?? []) {
    const id = asString(raw.endpoint_id, "");
    const list = out.get(id) ?? [];
    list.push(asString(raw.category_slug, ""));
    out.set(id, list);
  }

  return out;
}

/**
 * The `Risk` for a corpus row, with the score exactly as it was written.
 *
 * SPEC §7: historical scores are never recomputed. So the stored `score`,
 * `band` and `score_version` are what is served, always. The only thing derived
 * is `reasons`, and only when the stored version is the one in force AND
 * re-running `score` over the stored signals reproduces the stored number to
 * the point. If it does not — a weight moved without a version bump, a signal
 * changed meaning — the row keeps its score and loses its reasons rather than
 * being served a rationale that does not add up to the number beside it.
 */
export function riskFor(row: CorpusRow, methodologyBase = "https://tools.tx402.io/methodology"): Risk | null {
  if (row.score === null || row.band === null || row.score_version === null) return null;

  const band = row.band === "LOW" || row.band === "MEDIUM" || row.band === "HIGH" ? row.band : "MEDIUM";
  const base: Risk = {
    score: row.score,
    band,
    score_version: row.score_version,
    confidence: row.scan_count > 0 ? "with_history" : "static_only",
    signals_evaluated: row.signals?.length ?? 0,
    reasons: [],
    methodology_url: `${methodologyBase}?v=${row.score_version}`,
  };

  if (row.score_version !== CURRENT_SCORE_VERSION || !row.signals) return base;

  const recomputed = scoreSignals(row.signals, CURRENT_SCORE_VERSION, {
    methodologyBaseUrl: methodologyBase,
  });
  if (!recomputed || recomputed.score !== row.score) return base;

  return {
    ...base,
    signals_evaluated: recomputed.signals_evaluated,
    reasons: recomputed.reasons,
  };
}

// ── the route ────────────────────────────────────────────────────────────

interface EndpointListing {
  endpoint_id: string;
  url: string;
  canonical_url: string;
  host: string;
  title: string | null;
  resource_type: string;
  discovery_source: string;
  status: string;
  first_seen: string;
  last_seen: string;
  scan_count: number;
  /** The reason a cell is empty, when it is (SPEC §5.5's `insufficient_data`). */
  data_state: DataState;
  insufficient_data: boolean;
  terms: Requirement | null;
  score: number | null;
  band: string | null;
  score_version: string | null;
  categories: string[];
  /** The listing facilitator's own figures. A claim, labelled as one. */
  facilitator_quality: FacilitatorClaim | null;
  advertised: AdvertisedTerms | null;
}

/**
 * `GET /api/v1/endpoints` — the corpus listing (SPEC §5.8).
 *
 * This route has no frozen schema, which is why it — and not `/api/v1/compare`
 * — carries the long-form per-endpoint facts: `first_seen`, `scan_count`, the
 * row's own `score_version`, the facilitator's usage claim and its advertised
 * terms. `compare.json` freezes its rows with `additionalProperties: false`, so
 * Compare's JSON mirror summarises those into `notes` and links here for the
 * machine-readable form.
 */
export const endpoints: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const now = `${new Date().toISOString().slice(0, 19)}Z`;
  const params = ctx.url.searchParams;

  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const category = params.get("category");
  const host = params.get("host");
  const observedOnly = params.get("has_terms") === "true";
  const after = params.get("cursor");

  if (category !== null && !/^[a-z0-9][a-z0-9-]*$/.test(category)) {
    return errorResponse("VALIDATION_FAILED", {
      message: "`category` must be a slug: lowercase letters, digits and hyphens.",
      detail: { field: "category" },
    });
  }

  const query: CorpusQuery = {
    now,
    category: category ?? undefined,
    host: host ?? undefined,
    observedOnly,
    limit,
    after,
  };

  const rows = await loadCorpus(ctx.env.DB, query);
  const total = await countCorpus(ctx.env.DB, query);

  const ids = rows.map((r) => r.endpoint_id);
  const [provenance, assignments] = await Promise.all([
    loadProvenance(ctx.env.DB, ids),
    loadCategoryAssignments(ctx.env.DB, ids),
  ]);

  const listing: EndpointListing[] = rows.map((row) => {
    const facts = provenance.get(row.endpoint_id);
    return {
      endpoint_id: row.endpoint_id,
      url: row.canonical_url,
      canonical_url: row.canonical_url,
      host: row.host,
      title: row.title,
      resource_type: row.resource_type,
      discovery_source: row.discovery_source,
      status: row.status,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      scan_count: row.scan_count,
      data_state: row.data_state,
      insufficient_data: row.terms === null,
      terms: row.terms,
      score: row.score,
      band: row.band,
      score_version: row.score_version,
      categories: assignments.get(row.endpoint_id) ?? [],
      facilitator_quality: facts?.quality ?? null,
      advertised: facts?.advertised ?? null,
    };
  });

  const body = envelope(
    ctx.route,
    {
      endpoints: listing,
      total,
      cursor: rows.length === limit ? (rows[rows.length - 1]?.endpoint_id ?? null) : null,
      filters: {
        category: category ?? null,
        host: host ?? null,
        has_terms: observedOnly,
      },
    },
    {
      warnings:
        listing.some((e) => e.insufficient_data)
          ? [
              {
                code: "INSUFFICIENT_DATA",
                message:
                  "Some endpoints in this page have no observed terms yet. `data_state` says why for each one; it is never a zero.",
              },
            ]
          : [],
    },
  );

  return json(body, {}, ctx);
};
