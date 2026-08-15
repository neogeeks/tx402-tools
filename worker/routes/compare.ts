/**
 * 402 Compare + categories.
 *
 * Contract: spec/SPEC.md §5.5 · Schema: spec/schemas/compare.json
 *
 * The curated category pages are the single best SEO asset in the suite, and
 * applies to every one of them: the title, H1 and metadata target
 * the CATEGORY term ("cheapest x402 geocoding API"), not the brand term.
 *
 * ── Compare reads the corpus. It never probes ──────────────────────────────
 *
 * A GET that fans out to N outbound requests is the amplifier
 * exists to prevent, and `?urls=` is attacker-controlled by construction. So
 * every figure here comes from what the crawler already observed. A URL we have
 * never seen renders as "not in our index yet" with a link to the Inspector,
 * which is the surface that is *allowed* to probe, one URL at a time, through
 * the politeness cache.
 *
 * ── Four ways a comparison can lie, and what stops each ────────────────────
 *
 *  1. **A gap that looks like a number.** A blank, a dash or a zero where we
 *     mean "we have not looked yet" is a false statement about somebody's
 *     business. Every empty cell carries its reason (`DataState`), rendered in
 *     the same muted "not observed" style `ui/components/kv-table.ts` uses.
 *
 *  2. **Unequal observation windows stacked as equals.** An availability figure
 *     over three days and one over six months are not the same measurement.
 *     `first_seen` and `scan_count` are on every row, the asymmetry is computed,
 *     and when it is large the comparison says so in all three representations.
 *
 *  3. **Ranking across `score_version`s.** SPEC §7: scores are comparable only
 *     within one version. A sort by score is *refused* when the rows disagree,
 *     and the refusal is data (`Ranking.refused`), not a quietly different
 *     order. The same rule is applied to price, because two amounts in
 *     different assets are no more comparable than two scores in different
 *     versions.
 *
 *  4. **A v1 endpoint reading as a bad endpoint.** `decodePaymentRequired` is
 *     v2-only, so a healthy x402 v1 endpoint fails `challenge_decodes` and
 *     scores lower. That is a claim about what this
 *     tool can decode. Any row it applies to is marked, and the note says which
 *     it means.
 *
 * ── Language ───────────────────────────────────────────────────────────────
 *
 * describe observations, never operators. Everything on these
 * pages is a statement about what we did or did not see, and the page carries
 * `observationNote: true` above the fold wherever it renders a band.
 */

import { envelope, errorResponse, html as htmlResponse, json, markdown } from "../http.js";
import { endpointId, validateUrl } from "../lib/guard.js";
import { asNumber, asString, asStringOrNull } from "../crawler/coerce.js";
import {
  CATEGORIES,
  categoriesForTags,
  categoryBySlug,
  publishedCategories,
  type CategoryDefinition,
} from "../../ui/pages/compare/catalogue.js";
import { comparePage } from "../../ui/pages/compare/page.js";
import { compareMarkdown } from "../../ui/pages/compare/markdown.js";
import {
  daysBetween,
  priceComparable,
  scoreVersions,
  type CategorySummary,
  type CompareCategory,
  type CompareData,
  type CompareRow,
  type CompareRowDetail,
  type CompareView,
  type Ranking,
  type SortKey,
} from "../../ui/pages/compare/types.js";
import {
  loadCategoryAssignments,
  loadCorpus,
  loadProvenance,
  riskFor,
  type CorpusRow,
} from "./endpoints.js";
import type { ErrorCode, RouteContext, RouteHandler } from "../types.js";

/**
 * A comparison wider than this is a spreadsheet, not a decision aid — and each
 * column is a D1 read on a public GET.
 */
const MAX_COMPARE_URLS = 8;

/** How many rows a category page renders before it pages. */
const CATEGORY_PAGE_SIZE = 25;

/**
 * The ratio at which two observation windows stop being comparable.
 *
 * 4× is a judgement, and it is stated rather than tuned: three days against two
 * weeks is a difference worth knowing; three days against six months is a
 * different kind of claim. Below the threshold the windows are still printed on
 * every row — the note only fires when the gap is large enough that a reader
 * skimming a table would draw the wrong conclusion from it.
 */
const WINDOW_ASYMMETRY_RATIO = 4;

function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * Run a set of writes, in batches where the D1 surface offers them.
 *
 * `batch` is the right call — one round trip instead of N — but it is the one
 * part of the D1 API a narrower implementation may not provide, and the
 * catalogue seed must not be the reason a listing 500s. The fallback is the
 * same statements, run in order, with the same result.
 */
async function runAll(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;

  if (typeof db.batch === "function") {
    // D1 caps a batch, and a corpus-wide sweep can produce more pairs than one
    // batch accepts.
    for (let i = 0; i < statements.length; i += 50) {
      await db.batch(statements.slice(i, i + 50));
    }
    return;
  }

  for (const statement of statements) await statement.run();
}

// ── the curated catalogue, in the database ───────────────────────────────

/**
 * Upsert the published catalogue into `categories`.
 *
 * Code and not a migration, for reason: `migrations/0003_*.sql`
 * belongs to and two sessions writing the same numbered file is exactly the
 * collision prevents. Idempotent, so it can run on any request.
 *
 * `curated_by` and `definition` are written because a category with neither is
 * an inference wearing a curator's clothes — and the definition is published so
 * that an operator who disagrees with their category has something specific to
 * disagree with.
 */
export async function seedCategories(db: D1Database, now: string): Promise<void> {
  await runAll(
    db,
    CATEGORIES.map((category) =>
      db
        .prepare(
          `INSERT INTO categories (slug, title, summary, definition, curated_by, published, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             title = excluded.title,
             summary = excluded.summary,
             definition = excluded.definition,
             curated_by = excluded.curated_by,
             published = excluded.published,
             updated_at = excluded.updated_at`,
        )
        .bind(
          category.slug,
          category.title,
          category.summary,
          category.definition,
          category.curatedBy,
          category.published ? 1 : 0,
          now,
          now,
        ),
    ),
  );
}

/**
 * Assign endpoints to categories from the facilitator's own Bazaar tags.
 *
 * `assigned_by = 'bazaar-tag'` — the auto-assignment is a starting point and
 * says so in the data. A curator row (`assigned_by = 'curator'`) is written by
 * hand, is never touched here, and is what makes the published set a human
 * decision rather than a tag match.
 *
 * The tags are read out of `endpoint_provenance.raw_json`, which is where
 * keeps the listing verbatim. `json_valid` guards the 1.4% of listings that the
 * 8 KiB provenance cap truncates mid-token (see `endpoints.ts`); those rows are
 * simply unassigned rather than crashing the query.
 *
 * Idempotent by primary key, so re-running it costs a no-op insert per pair.
 *
 * ── Where this SHOULD live, and why it does not ────────────────────────────
 *
 * The natural home is its seed-refresh phase: the sweep is a consequence of
 * ingesting a listing, and running it there would make it exactly-once per new
 * endpoint.  does not own `worker/crawler/`, so it runs on category reads
 * instead, short-circuited below and. for whoever
 * owns the crawler next.
 *
 * The short-circuit is the honest one: every provenance row carries the moment
 * we read it, and every assignment carries the moment we wrote it, so if the
 * newest assignment is at least as new as the newest provenance row then every
 * listing has already been considered and the sweep has nothing to find. New or
 * re-observed endpoints move `observed_at` forward and the sweep runs again.
 *
 * It does NOT know about a change to the catalogue in this file. Changing a
 * category's tag set means clearing the auto-assignments once so they are
 * recomputed — curator rows are untouched by that, which is the point of
 * `assigned_by`:
 *
 *     DELETE FROM endpoint_categories WHERE assigned_by = 'bazaar-tag';
 */
export async function assignFromBazaarTags(
  db: D1Database,
  now: string,
  options: { force?: boolean } = {},
): Promise<{ scanned: number; assigned: number; skipped: boolean }> {
  if (!options.force) {
    const marker = await db
      .prepare(
        `SELECT (SELECT max(observed_at) FROM endpoint_provenance) AS newest_listing,
                (SELECT max(created_at)  FROM endpoint_categories) AS newest_assignment`,
      )
      .first<Record<string, unknown>>();

    const newestListing = asStringOrNull(marker?.newest_listing);
    const newestAssignment = asStringOrNull(marker?.newest_assignment);
    if (newestListing && newestAssignment && newestAssignment >= newestListing) {
      return { scanned: 0, assigned: 0, skipped: true };
    }
  }

  const result = await db
    .prepare(
      `SELECT p.endpoint_id,
              CASE WHEN json_valid(p.raw_json) THEN json_extract(p.raw_json, '$.tags') END AS tags,
              COALESCE(
                CASE WHEN json_valid(p.raw_json) THEN json_extract(p.raw_json, '$.serviceName') END,
                e.title
              ) AS service_name
         FROM endpoint_provenance p
         JOIN endpoints e ON e.id = p.endpoint_id`,
    )
    .all<Record<string, unknown>>();

  const wanted = new Map<string, Set<string>>();
  let scanned = 0;

  for (const raw of result.results ?? []) {
    scanned += 1;
    const id = asString(raw.endpoint_id, "");
    if (!id) continue;

    let tags: string[] = [];
    if (typeof raw.tags === "string") {
      try {
        const parsed: unknown = JSON.parse(raw.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
      } catch {
        // A truncated listing is not a parse error worth failing an assignment
        // sweep over. It simply carries no tags.
      }
    }

    const slugs = categoriesForTags(tags, asStringOrNull(raw.service_name));
    if (slugs.length === 0) continue;

    const set = wanted.get(id) ?? new Set<string>();
    for (const slug of slugs) set.add(slug);
    wanted.set(id, set);
  }

  const statements: D1PreparedStatement[] = [];
  for (const [id, slugs] of wanted) {
    for (const slug of slugs) {
      statements.push(
        db
          .prepare(
            `INSERT INTO endpoint_categories (endpoint_id, category_slug, assigned_by, created_at)
             VALUES (?, ?, 'bazaar-tag', ?)
             ON CONFLICT(endpoint_id, category_slug) DO NOTHING`,
          )
          .bind(id, slug, now),
      );
    }
  }

  await runAll(db, statements);

  return { scanned, assigned: statements.length, skipped: false };
}

/** Member counts per category, opt-outs already excluded. */
async function categoryCounts(db: D1Database, now: string): Promise<Map<string, number>> {
  const result = await db
    .prepare(
      `SELECT ec.category_slug AS slug, count(*) AS n
         FROM endpoint_categories ec
         JOIN endpoints e ON e.id = ec.endpoint_id
        WHERE e.status <> 'opted_out'
          AND NOT EXISTS (
            SELECT 1 FROM optouts o
             WHERE o.revoked_at IS NULL
               AND o.effective_at <= ?
               AND ((o.scope = 'endpoint' AND o.target = e.canonical_url)
                 OR (o.scope = 'origin'   AND o.target = e.origin))
          )
        GROUP BY ec.category_slug`,
    )
    .bind(now)
    .all<Record<string, unknown>>();

  const counts = new Map<string, number>();
  for (const row of result.results ?? []) {
    counts.set(asString(row.slug, ""), asNumber(row.n, 0));
  }
  return counts;
}

async function categorySummaries(db: D1Database, now: string): Promise<CategorySummary[]> {
  const counts = await categoryCounts(db, now);
  return CATEGORIES.map((category) => ({
    slug: category.slug,
    title: category.title,
    summary: category.summary,
    definition: category.definition,
    curated_by: category.curatedBy,
    published: category.published,
    endpoint_count: counts.get(category.slug) ?? 0,
    tags: [...category.tags],
  }));
}

// ── building a comparison ────────────────────────────────────────────────

function rowFrom(corpus: CorpusRow): CompareRow {
  return {
    endpoint_id: corpus.endpoint_id,
    url: corpus.canonical_url,
    title: corpus.title,
    terms: corpus.terms,
    // Null, deliberately, and the notes say why.
    // These are aggregates over the sampled Analytics Engine dataset, and
    // closed the credential gap — so this is no longer "we
    // cannot ask". It is that `availabilityFor` asks per endpoint, one SQL
    // round trip each, and a category page is 25 rows: Compare would go from a
    // corpus read that touches nothing outside D1 to a public GET that fans
    // out 25 outbound calls. The per-endpoint figure exists and is rendered on
    // `/history?url=…`, which pays that cost one endpoint at a time.
    // The alternative — deriving a percentage from the `scans` rows in D1 — is
    // worse than absent. `scans` retains failures and deliberately drops
    // routine successes, so the ratio would look
    // worst for the endpoints we probe most. for the
    // batched query that would let this column fill honestly.
    availability_30d: null,
    latency_p50_ms: null,
    risk: riskFor(corpus),
    insufficient_data: corpus.terms === null,
    last_seen: corpus.terms ? corpus.observed_at : null,
  };
}

/** The row for a URL that is not in the corpus at all. Everything null, honestly. */
function unknownRow(canonicalUrl: string): CompareRow {
  return {
    endpoint_id: null,
    url: canonicalUrl,
    title: null,
    terms: null,
    availability_30d: null,
    latency_p50_ms: null,
    risk: null,
    insufficient_data: true,
    last_seen: null,
  };
}

function detailFrom(
  corpus: CorpusRow | null,
  row: CompareRow,
  now: string,
  facts: { quality: CompareRowDetail["quality"]; advertised: CompareRowDetail["advertised"] } | null,
  categories: string[],
): CompareRowDetail {
  const advertised = facts?.advertised ?? null;
  const observedAmount = row.terms?.amount_atomic ?? null;

  return {
    endpoint_id: row.endpoint_id,
    url: row.url,
    host: corpus?.host ?? hostOf(row.url),
    data_state: corpus?.data_state ?? "unknown_to_us",
    first_seen: corpus?.first_seen ?? null,
    scan_count: corpus?.scan_count ?? 0,
    observation_days: daysBetween(corpus?.first_seen ?? null, corpus?.last_seen ?? null),
    status: corpus?.status ?? null,
    discovery_source: corpus?.discovery_source ?? null,
    wire_form: corpus?.wire_form ?? null,
    x402_version: corpus?.x402_version ?? null,
    score_version: corpus?.score_version ?? null,
    quality: facts?.quality ?? null,
    advertised,
    price_disagreement:
      advertised?.amount && observedAmount && advertised.amount !== observedAmount
        ? { advertised: advertised.amount, observed: observedAmount }
        : null,
    categories,
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ── ranking: what we sorted by, and what we refused to ───────────────────

function parseSort(value: string | null, fallback: SortKey): SortKey {
  switch (value) {
    case "price":
    case "score":
    case "name":
    case "usage":
    case "given":
      return value;
    default:
      return fallback;
  }
}

/**
 * Decide the order, and record any refusal.
 *
 * The three refusals are the same rule applied to three columns: a ranking is
 * only a ranking if the values share a scale.
 */
function decideRanking(
  requested: SortKey,
  rows: CompareRow[],
  details: CompareRowDetail[],
  fallback: SortKey,
): Ranking {
  if (requested === "score") {
    const versions = scoreVersions(rows);
    if (versions.length > 1) {
      return {
        requested,
        applied: fallback,
        refused: {
          key: "score",
          reason: `These rows were scored under different methodology versions (${versions.join(
            ", ",
          )}). A score is only comparable within one version, so they are not ranked against each other.`,
        },
      };
    }
    if (versions.length === 0) {
      return {
        requested,
        applied: fallback,
        refused: {
          key: "score",
          reason: "None of these endpoints has been scored yet, so there is nothing to rank.",
        },
      };
    }
  }

  if (requested === "price" && !priceComparable(rows)) {
    return {
      requested,
      applied: fallback,
      refused: {
        key: "price",
        reason:
          "These endpoints price in different assets, networks or decimal precisions, so their amounts are not one scale and are not ranked against each other.",
      },
    };
  }

  if (requested === "usage") {
    const facilitators = new Set(
      details.filter((d) => d.quality).map((d) => d.quality?.facilitator_id ?? "unknown"),
    );
    if (facilitators.size !== 1) {
      return {
        requested,
        applied: fallback,
        refused: {
          key: "usage",
          reason:
            facilitators.size === 0
              ? "No facilitator publishes usage figures for these endpoints, so there is nothing to rank."
              : "The usage figures for these endpoints come from different facilitators' own bookkeeping, which are not one measurement and are not ranked against each other.",
        },
      };
    }
  }

  return { requested, applied: requested, refused: null };
}

function priceKey(row: CompareRow): number | null {
  const decimal = row.terms?.amount_decimal;
  if (decimal) {
    const parsed = Number.parseFloat(decimal);
    if (Number.isFinite(parsed)) return parsed;
  }
  const atomic = row.terms?.amount_atomic;
  if (atomic) {
    const parsed = Number.parseFloat(atomic);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Apply the order.
 *
 * Rows with nothing observed always sort last, whatever the key. They are not
 * "worst" — they are unmeasured, and putting them at the bottom of a price
 * column beside a "not probed yet" cell is the only placement that does not
 * imply a value they do not have.
 */
function applySort(
  key: SortKey,
  rows: CompareRow[],
  details: CompareRowDetail[],
): Array<{ row: CompareRow; detail: CompareRowDetail }> {
  const paired = rows.map((row, i) => ({ row, detail: details[i] as CompareRowDetail }));
  if (key === "given") return paired;

  const rank = (pair: { row: CompareRow; detail: CompareRowDetail }): [number, number, string] => {
    switch (key) {
      case "price": {
        const price = priceKey(pair.row);
        return [price === null ? 1 : 0, price ?? 0, pair.row.url];
      }
      case "score": {
        const score = pair.row.risk?.score ?? null;
        return [score === null ? 1 : 0, score === null ? 0 : -score, pair.row.url];
      }
      case "usage": {
        const calls = pair.detail.quality?.calls_30d ?? null;
        return [calls === null ? 1 : 0, calls === null ? 0 : -calls, pair.row.url];
      }
      default:
        return [0, 0, (pair.row.title ?? pair.detail.host ?? pair.row.url).toLowerCase()];
    }
  };

  return [...paired].sort((a, b) => {
    const [ax, ay, az] = rank(a);
    const [bx, by, bz] = rank(b);
    if (ax !== bx) return ax - bx;
    if (ay !== by) return ay - by;
    return az.localeCompare(bz);
  });
}

// ── the notes: everything the frozen row cannot carry ────────────────────

/**
 * `data.notes` is the schema's own escape hatch, and its description names the
 * differing-`score_version` case explicitly. It is where a comparison says the
 * things that would otherwise have to be inferred from a table — and it is what
 * a JSON consumer reads instead of the page's footnotes.
 */
function buildNotes(
  view: Omit<CompareView, "data"> & { rows: CompareRow[]; category: CompareCategory | null },
  extra: string[],
): string[] {
  const notes: string[] = [...extra];
  const { rows, details, ranking } = view;

  const missing = rows.filter((r) => r.insufficient_data).length;
  if (missing > 0) {
    notes.push(
      `${missing} of ${rows.length} endpoints here ${
        missing === 1 ? "has" : "have"
      } no observed terms yet. Each says which state it is in — not in our index, not probed yet, no x402 challenge served, or did not answer — and none of them is shown as a zero.`,
    );
  }

  if (ranking.refused) notes.push(ranking.refused.reason);

  const versions = scoreVersions(rows);
  if (versions.length > 1 && !ranking.refused) {
    notes.push(
      `Rows here carry scores from different methodology versions (${versions.join(
        ", ",
      )}). Scores are only comparable within one version, so they are listed rather than ranked.`,
    );
  }

  // Observation-window asymmetry (and the reason first_seen is
  // never a facilitator's claim).
  const windows = details
    .filter((d) => d.observation_days !== null && d.scan_count > 0)
    .map((d) => ({ detail: d, days: Math.max(d.observation_days ?? 0, 1) }));
  if (windows.length >= 2) {
    const shortest = windows.reduce((a, b) => (a.days <= b.days ? a : b));
    const longest = windows.reduce((a, b) => (a.days >= b.days ? a : b));
    if (longest.days >= shortest.days * WINDOW_ASYMMETRY_RATIO) {
      notes.push(
        `These endpoints have not been watched for the same length of time: our observations of ${label(
          shortest.detail,
        )} span ${shortest.days} day${shortest.days === 1 ? "" : "s"} across ${
          shortest.detail.scan_count
        } probe${shortest.detail.scan_count === 1 ? "" : "s"}, and our observations of ${label(
          longest.detail,
        )} span ${longest.days} days across ${
          longest.detail.scan_count
        } probes. A figure measured over days and one measured over months are not the same measurement.`,
      );
    }
  }

  if (rows.some((r) => r.availability_30d === null || r.latency_p50_ms === null)) {
    notes.push(
      "Availability and latency are not shown here. They are aggregates over the sampled probe dataset and are read one endpoint at a time, which is what the history page does — this page reads the index and makes no outbound request. Estimating them from the probe records kept in the database instead would over-report failure, because routine successful probes are deliberately not kept.",
    );
  }

  const v1Rows = details.filter((d) => d.x402_version === 1);
  if (v1Rows.length > 0) {
    notes.push(
      `${v1Rows
        .map(label)
        .join(", ")} serve${v1Rows.length === 1 ? "s" : ""} an x402 v1 challenge. The decoder these tools run is v2-only, so the "challenge decodes" signal fails and the score is lower. That is a statement about what this tool can read, not about the endpoint — a v1 endpoint can be entirely healthy for a v1 buyer.`,
    );
  }

  const claims = details.filter((d) => d.quality);
  if (claims.length > 0) {
    notes.push(
      `Usage figures on this page are published by the facilitator that lists the endpoint (${[
        ...new Set(claims.map((d) => d.quality?.facilitator_id ?? "an unnamed facilitator")),
      ].join(", ")}), not measured by us. They are shown because they are better data than anything we can collect — and attributed because they are somebody else's.`,
    );
  }

  const disagreements = details.filter((d) => d.price_disagreement);
  for (const detail of disagreements) {
    notes.push(
      `The facilitator's listing and the challenge we observed disagree about the price of ${label(
        detail,
      )}: the listing advertises ${detail.price_disagreement?.advertised} and the endpoint served ${
        detail.price_disagreement?.observed
      } atomic units. Both are recorded; the amount we observed is what the endpoint actually asked us for.`,
    );
  }

  return notes.map((note) => (note.length > 500 ? `${note.slice(0, 497)}...` : note));
}

function label(detail: CompareRowDetail): string {
  return detail.host ?? detail.url;
}

// ── URL parsing for `?urls=` ─────────────────────────────────────────────

interface ParsedUrls {
  canonical: string[];
  refused: number;
  firstFailure: ErrorCode | null;
}

function parseUrls(params: URLSearchParams): ParsedUrls {
  const raw: string[] = [];
  for (const value of params.getAll("urls")) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) raw.push(trimmed);
    }
  }
  for (const value of params.getAll("url")) {
    const trimmed = value.trim();
    if (trimmed.length > 0) raw.push(trimmed);
  }

  const canonical: string[] = [];
  let refused = 0;
  let firstFailure: ParsedUrls["firstFailure"] = null;

  for (const candidate of raw.slice(0, MAX_COMPARE_URLS)) {
    const validated = validateUrl(candidate);
    if (!validated.ok) {
      refused += 1;
      firstFailure = firstFailure ?? validated.failure.code;
      continue;
    }
    if (!canonical.includes(validated.value.canonical)) canonical.push(validated.value.canonical);
  }

  return { canonical, refused, firstFailure };
}

// ── the route ────────────────────────────────────────────────────────────

async function buildView(
  ctx: RouteContext,
  now: string,
): Promise<{ view: CompareView; status?: number } | Response> {
  const params = ctx.url.searchParams;
  const slug = ctx.params.category ?? params.get("category");

  if (slug !== null && slug !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return errorResponse("VALIDATION_FAILED", {
      message: "A category is a slug: lowercase letters, digits and hyphens.",
      detail: { field: "category" },
    });
  }

  const definition: CategoryDefinition | null = slug ? categoryBySlug(slug) : null;
  if (slug && !definition) {
    return errorResponse("NOT_FOUND", {
      message: "There is no published comparison category with that name.",
      detail: { category: slug, published: publishedCategories().map((c) => c.slug) },
    });
  }

  const parsed = parseUrls(params);
  const extraNotes: string[] = [];

  if (parsed.refused > 0) {
    extraNotes.push(
      parsed.canonical.length === 0
        ? "None of the URLs given could be compared. This service compares https URLs that resolve to public addresses."
        : `${parsed.refused} of the URLs given could not be compared. This service compares https URLs that resolve to public addresses.`,
    );
  }
  if (parsed.canonical.length === 0 && parsed.refused > 0 && parsed.firstFailure) {
    return errorResponse(parsed.firstFailure, { detail: { field: "urls" } });
  }

  // A category page needs its catalogue rows and its tag assignments to exist.
  if (definition) {
    await seedCategories(ctx.env.DB, now);
    await assignFromBazaarTags(ctx.env.DB, now);
  }

  let corpus: CorpusRow[] = [];
  let orderedUrls: string[] = [];

  if (parsed.canonical.length > 0) {
    const ids = await Promise.all(parsed.canonical.map((url) => endpointId(url)));
    corpus = await loadCorpus(ctx.env.DB, { now, ids });
    orderedUrls = parsed.canonical;
  } else if (definition) {
    corpus = await loadCorpus(ctx.env.DB, {
      now,
      category: definition.slug,
      limit: CATEGORY_PAGE_SIZE,
    });
    orderedUrls = corpus.map((c) => c.canonical_url);
  }

  const ids = corpus.map((c) => c.endpoint_id);
  const [provenance, assignments] = await Promise.all([
    loadProvenance(ctx.env.DB, ids),
    loadCategoryAssignments(ctx.env.DB, ids),
  ]);

  const byUrl = new Map(corpus.map((c) => [c.canonical_url, c]));

  const rows: CompareRow[] = [];
  const details: CompareRowDetail[] = [];

  for (const url of orderedUrls) {
    const found = byUrl.get(url) ?? null;
    const row = found ? rowFrom(found) : unknownRow(url);
    rows.push(row);
    details.push(
      detailFrom(
        found,
        row,
        now,
        found ? (provenance.get(found.endpoint_id) ?? null) : null,
        found ? (assignments.get(found.endpoint_id) ?? []) : [],
      ),
    );
  }

  // An opted-out endpoint is absent from the comparison, not greyed out in it.
  // `loadCorpus` already excluded it; when the caller named it explicitly, say
  // plainly that it is not listed — in the same words `/api/v1/optout` uses.
  const asked = parsed.canonical.length;
  const missingFromCorpus = rows.filter((r) => r.endpoint_id === null).length;
  if (asked > 0 && missingFromCorpus > 0) {
    extraNotes.push(
      `${missingFromCorpus} of the endpoints asked about ${
        missingFromCorpus === 1 ? "is" : "are"
      } not in our index. That is either because we have not discovered it yet — paste it into the Inspector and we will look — or because its operator has opted out.`,
    );
  }

  const fallback: SortKey = definition ? "price" : "given";
  const requested = parseSort(params.get("sort"), fallback);
  const ranking = decideRanking(requested, rows, details, definition ? "name" : "given");
  const sorted = applySort(ranking.applied, rows, details);

  const sortedRows = sorted.map((p) => p.row);
  const sortedDetails = sorted.map((p) => p.detail);

  const category: CompareCategory | null = definition
    ? { slug: definition.slug, title: definition.title, summary: definition.summary }
    : null;

  const categories = await categorySummaries(ctx.env.DB, now);

  const notes = buildNotes(
    {
      rows: sortedRows,
      category,
      details: sortedDetails,
      ranking,
      categories,
      requestedUrls: parsed.canonical,
      path: ctx.url.pathname,
    },
    extraNotes,
  );

  const data: CompareData = { category, rows: sortedRows, notes };

  return {
    view: {
      data,
      details: sortedDetails,
      ranking,
      categories,
      requestedUrls: parsed.canonical,
      path: definition ? `/compare/${definition.slug}` : "/compare",
    },
  };
}

export const compare: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const now = nowIso();
  const built = await buildView(ctx, now);
  if (built instanceof Response) return built;

  const { view } = built;
  const body = envelope(ctx.route, view.data, {
    scoreVersion: scoreVersions(view.data.rows)[0] ?? null,
    warnings: view.data.rows.some((r) => r.insufficient_data)
      ? [
          {
            code: "INSUFFICIENT_DATA",
            message:
              "Some rows have no observed terms yet. `insufficient_data` marks them and `notes` says why; they are never rendered as zeros.",
          },
        ]
      : [],
  });

  if (ctx.format === "json") return json(body, {}, ctx);
  if (ctx.format === "markdown") return markdown(compareMarkdown(view), {}, ctx);
  return htmlResponse(comparePage(view), {}, ctx);
};

/**
 * `GET /api/v1/categories` — the curated set (SPEC §5.8).
 *
 * Serves unpublished categories too, with `published: false`, because the
 * distinction between "we curate this" and "we show this" is exactly what a
 * consumer of this route needs to be able to see.
 */
export const categories: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const now = nowIso();
  await seedCategories(ctx.env.DB, now);
  await assignFromBazaarTags(ctx.env.DB, now);

  const summaries = await categorySummaries(ctx.env.DB, now);
  const body = envelope(ctx.route, {
    categories: summaries,
    total: summaries.length,
    published: summaries.filter((c) => c.published).length,
  });

  return json(body, {}, ctx);
};
