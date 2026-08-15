/**
 * 402 Compare's view model.
 *
 * `CompareData` is the TypeScript face of `spec/schemas/compare.json` (SPEC
 * §5.5). It is produced **once**, by `worker/routes/compare.ts`, and rendered
 * three ways. SPEC §1.2: the markdown mirror is a rendering of the same JSON,
 * never a second computation.
 *
 * ── Why there are two types and not one ────────────────────────────────────
 *
 * `spec/schemas/compare.json` freezes `data.rows` with
 * `additionalProperties: false`, and the fields that make a comparison honest —
 * how long we have been watching each endpoint, how many times we probed it,
 * which scoring version its score was produced under, and what the listing
 * facilitator claims about usage — are not in that frozen row.
 *
 * They are not dropped and they are not smuggled into the frozen row either. `CompareRow` is
 * exactly the schema. `CompareRowDetail` carries everything else, is rendered in full on the page
 * and in the Markdown mirror, and is summarised into `data.notes` (which the schema exists to
 * carry: its own description names the differing-`score_version` case). The machine-readable long
 * form is on `/api/v1/endpoints`, which has no frozen schema.. proposes the row fields for the
 * integrator; until they land, the contract wins over the convenience.
 *
 * ── The one thing every renderer here must preserve ────────────────────────
 *
 * "Insufficient data" is a value, not a gap. A blank, a dash or a zero where we
 * mean "we have not looked yet" tells the reader something false about somebody
 * else's business. Every renderer in this directory goes
 * through `cell`/`emptyReason` rather than interpolating a value directly.
 */

import type { Requirement } from "../../../worker/lib/probe.js";
import type { Risk } from "../../../worker/lib/score.js";

export type { Requirement, Risk };

/** SPEC §5.5 — a curated category, or null for an ad-hoc `?urls=` comparison. */
export interface CompareCategory {
  slug: string;
  title: string;
  summary: string | null;
}

/** SPEC §5.5, frozen. Do not add a field here without changing the schema. */
export interface CompareRow {
  endpoint_id: string | null;
  url: string;
  title: string | null;
  terms: Requirement | null;
  availability_30d: number | null;
  latency_p50_ms: number | null;
  risk: Risk | null;
  insufficient_data: boolean;
  last_seen: string | null;
}

/** SPEC §5.5, frozen. This is what `/api/v1/compare` serves as `data`. */
export interface CompareData {
  category: CompareCategory | null;
  rows: CompareRow[];
  notes: string[];
}

/**
 * Why a cell is empty. Every one of these is a different fact about us, and
 * collapsing them into one blank is the failure this change exists to avoid.
 */
export type DataState =
  /** We probed it and it served terms. */
  | "observed"
  /** In the corpus, never probed. The crawler has not reached it yet. */
  | "not_probed"
  /** Probed; it answered, but not with an x402 challenge. */
  | "no_challenge"
  /** Probed; it did not answer. */
  | "unreachable"
  /** Not in the corpus at all — we have never seen this URL. */
  | "unknown_to_us";

/**
 * A facilitator's published usage figures, kept as a claim.
 *
 * Coinbase's Bazaar publishes `{l30DaysTotalCalls, l30DaysUniquePayers,
 * lastCalledAt}` per resource. It is
 * better data than anything we can measure — and it is somebody else's
 * bookkeeping, so it is labelled with whose it is everywhere it appears and is
 * never merged into a column of our own observations.
 */
export interface FacilitatorClaim {
  facilitator_id: string | null;
  calls_30d: number | null;
  unique_payers_30d: number | null;
  last_called_at: string | null;
  /** The listing's own `lastUpdated`. A claim about the resource, not a date we observed. */
  claimed_last_updated: string | null;
}

/**
 * What a facilitator's listing advertises, which is NOT what we observed.
 *
 *. decision 8: `terms_current` only ever holds what we probed,
 * and the advertised `accepts` stay in `endpoint_provenance.raw_json`. The two
 * are never blended into one column — a disagreement between them is a genuine
 * finding, and it is only expressible because they are stored apart.
 */
export interface AdvertisedTerms {
  amount: string | null;
  network: string | null;
  asset: string | null;
  scheme: string | null;
  pay_to: string | null;
  facilitator_id: string | null;
}

/** Everything the frozen row cannot carry. Rendered on the page and in Markdown. */
export interface CompareRowDetail {
  endpoint_id: string | null;
  url: string;
  host: string | null;
  data_state: DataState;
  /** Written once on insert, never moved. A date we observed. */
  first_seen: string | null;
  scan_count: number;
  /**
   * The span our observations actually cover: `first_seen` to `last_seen`.
   *
   * Deliberately not "days since we first saw it". For an endpoint we stopped
   * being able to reach, time-since keeps growing while the evidence does not,
   * and an availability figure is only ever a claim about the window it was
   * measured in. This is that window.
   */
  observation_days: number | null;
  status: string | null;
  discovery_source: string | null;
  wire_form: string | null;
  x402_version: number | null;
  /** The version in force when this row's score was written. Never recomputed. */
  score_version: string | null;
  quality: FacilitatorClaim | null;
  advertised: AdvertisedTerms | null;
  /** Set when the listing and the challenge disagree about price. A finding. */
  price_disagreement: { advertised: string; observed: string } | null;
  categories: string[];
}

export type SortKey = "given" | "name" | "price" | "score" | "usage";

/**
 * What we sorted by, what was asked for, and — when they differ — why.
 *
 * SPEC §7: "Compare refuses to rank rows scored under different versions
 * without saying so." The refusal is data, not a silently different order, so
 * all three representations carry the same sentence.
 */
export interface Ranking {
  requested: SortKey;
  applied: SortKey;
  refused: { key: SortKey; reason: string } | null;
}

/** The full render input. Only `data` is on the wire as JSON. */
export interface CompareView {
  data: CompareData;
  details: CompareRowDetail[];
  ranking: Ranking;
  /** Published categories, for the hub page and the cross-links. */
  categories: CategorySummary[];
  /** The `?urls=` the caller supplied, echoed for the form. */
  requestedUrls: string[];
  /** Canonical path for this comparison, e.g. `/compare/ai-inference`. */
  path: string;
}

export interface CategorySummary {
  slug: string;
  title: string;
  summary: string | null;
  definition: string | null;
  curated_by: string | null;
  published: boolean;
  endpoint_count: number;
  /** The Bazaar tags that place an endpoint in this category. */
  tags: string[];
}

// ── view helpers, shared by every renderer ───────────────────────────────

/** Whole days between two RFC 3339 dates. Null when either is absent. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

/**
 * The sentence that goes where a value would have been.
 *
 * Deliberately a full clause and not a dash: it is the answer to "why is this
 * empty", and is explicit that the empty state is the correct
 * display rather than a degraded one.
 */
export function emptyReason(state: DataState): string {
  switch (state) {
    case "unknown_to_us":
      return "not in our index yet";
    case "not_probed":
      return "not probed yet";
    case "no_challenge":
      return "no x402 challenge served";
    case "unreachable":
      return "did not answer";
    case "observed":
      return "not observed";
  }
}

/** Price for display. Never do arithmetic on this (SPEC §1.4). */
export function priceLabel(terms: Requirement | null): string | null {
  if (!terms) return null;
  const symbol = terms.asset?.symbol ?? null;
  if (terms.amount_decimal) {
    return symbol ? `${terms.amount_decimal} ${symbol}` : terms.amount_decimal;
  }
  if (terms.amount_atomic) {
    return symbol
      ? `${terms.amount_atomic} atomic units of ${symbol}`
      : `${terms.amount_atomic} atomic units`;
  }
  if (terms.amount_raw) return `${terms.amount_raw} (not a canonical atomic integer)`;
  return null;
}

/**
 * Is this price column a single scale?
 *
 * Two amounts denominated in different assets, on different networks, or with
 * different decimals are not comparable numbers, and a sorted price column that
 * mixes them is a ranking of nothing. Same shape of rule as `score_version`.
 */
export function priceComparable(rows: CompareRow[]): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    const terms = row.terms;
    if (!terms || (terms.amount_atomic === null && terms.amount_decimal === null)) continue;
    keys.add(
      [terms.network ?? "?", terms.asset?.address ?? "?", terms.asset?.decimals ?? "?"].join("|"),
    );
  }
  return keys.size <= 1;
}

/** The distinct `score_version`s present. More than one ⇒ no ranking by score. */
export function scoreVersions(rows: CompareRow[]): string[] {
  const versions = new Set<string>();
  for (const row of rows) if (row.risk) versions.add(row.risk.score_version);
  return [...versions].sort();
}

/**
 * Does this row's score carry the v1-wire-form penalty?
 *
 *. decision 5: `decodePaymentRequired` is v2-only, so a healthy
 * x402 v1 endpoint fails `challenge_decodes` and scores lower. In a sorted
 * column that reads as a verdict on the endpoint. It is a statement about what
 * this tool can decode, and the renderers mark it as one.
 */
export function scoredDownForV1(row: CompareRow, detail: CompareRowDetail): boolean {
  if (!row.risk) return false;
  if (detail.x402_version !== null && detail.x402_version >= 2) return false;
  const decodes = row.risk.reasons.find((r) => r.signal_id === "challenge_decodes");
  if (decodes && decodes.status === "fail") return true;
  return detail.x402_version === 1;
}
