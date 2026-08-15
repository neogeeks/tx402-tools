/**
 * The shape of a History result, and the copy that describes it.
 *
 * `HistoryData` is the TypeScript face of `spec/schemas/history.json`. Where
 * the two could disagree the schema wins — `test/history.test.ts` validates
 * every response against it, because a TypeScript type proves nothing about
 * the wire format.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ONE DISTINCTION THIS TOOL EXISTS TO PRESERVE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **An availability number is SAMPLED. A price change is EXACT. They are not
 * the same kind of fact and must never be rendered as though they were.**
 *
 * split them deliberately and SPEC §5.4 freezes the split:
 *
 *   `series.price` + `changes`   `term_changes` in D1. Append-only, enforced
 *                                by database trigger. One row only when
 *                                something actually changed, permanent,
 *                                joinable, and stamped with the `score_version`
 *                                in force when it was observed. This is
 *                                **evidence** — the record a merchant would be
 *                                shown in an appeal.
 *
 *   `series.availability`        Workers Analytics Engine. Sampled (each stored
 *   `series.latency`             row stands for `_sample_interval` real ones)
 *                                and retention-bounded. This is **telemetry** —
 *                                fine for "about 99.9% available", unacceptable
 *                                as the basis of a claim about a business.
 *
 * SPEC §5.4 makes `coverage.sampled` mandatory for anything sourced from
 * Analytics Engine and says the two "must never be blended into one array".
 * That is the floor, not the goal: a `sampled: true` field nobody renders is
 * not a distinction a reader can see. So the copy below is written once and
 * used by **both** the HTML page and the markdown mirror, which is why it lives
 * here rather than in either of them — the two representations cannot drift
 * into describing the same number two different ways.
 *
 * The failure this prevents: "99.94% available" and "the recipient changed on
 * Jul 21" rendered with equal authority, when only the second is evidence.
 */

// ── the wire shape (spec/schemas/history.json) ────────────────────────────

export const WINDOWS = ["7d", "30d", "90d"] as const;
export type HistoryWindow = (typeof WINDOWS)[number];

export const WINDOW_DAYS: Record<HistoryWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const DEFAULT_WINDOW: HistoryWindow = "30d";

export function parseWindow(value: string | null): HistoryWindow {
  return WINDOWS.find((w) => w === value) ?? DEFAULT_WINDOW;
}

export interface HistoryTarget {
  url: string | null;
  canonical_url: string | null;
  endpoint_id: string | null;
  origin: string | null;
  host: string | null;
}

export interface Coverage {
  first_seen: string | null;
  last_seen: string | null;
  scan_count: number;
  /** True whenever any series in this response came from Analytics Engine. */
  sampled: boolean;
}

/** An exact price observation, dated. From `term_changes`. */
export interface PricePoint {
  t: string;
  amount_atomic: string;
  amount_decimal?: string | null;
  asset_symbol?: string | null;
  network?: string | null;
}

/** A sampled availability ratio over one bucket. From Analytics Engine. */
export interface AvailabilityPoint {
  t: string;
  ratio: number;
  samples: number;
}

/** Sampled latency quantiles over one bucket. From Analytics Engine. */
export interface LatencyPoint {
  t: string;
  p50_ms: number | null;
  p95_ms?: number | null;
  samples: number;
}

export type ChangeKind =
  | "first_seen"
  | "price"
  | "recipient"
  | "network"
  | "asset"
  | "scheme"
  | "timeout"
  | "facilitator"
  | "resource"
  | "challenge_shape"
  | "wire_version"
  | "availability_state"
  | "status"
  | "correction";

export interface TermChange {
  id: string;
  changed_at: string;
  change_kind: ChangeKind;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_by?: "crawler" | "human" | "api" | "backfill";
  /**
   * The scoring version in force **when the change was observed**. Rendered as
   * recorded and never recomputed (SPEC §7): a merchant appealing is shown the
   * rules that actually applied, not today's.
   */
  score_version?: string | null;
}

export interface HistoryData {
  target: HistoryTarget;
  window: HistoryWindow;
  has_data: boolean;
  coverage: Coverage;
  series: {
    price: PricePoint[];
    availability: AvailabilityPoint[];
    latency: LatencyPoint[];
  };
  changes: TermChange[];
}

export interface Warning {
  code: string;
  message: string;
}

/** Everything both representations render from. Nothing else is computed. */
export interface HistoryView {
  data: HistoryData;
  warnings: Warning[];
}

// ── warning vocabulary ────────────────────────────────────────────────────
// These ride in the envelope's `warnings` array rather than in `data`, because
// `spec/schemas/history.json` sets `additionalProperties: false` and the schema
// is frozen. That is not a workaround: SPEC §2 defines a warning
// as "a fact about the answer's completeness", which is exactly what each of
// these is. The HTML and the markdown both read them, so both say the same
// thing about why a series is empty.

export const WARN = {
  /** No `url` was supplied — the page is showing its form. */
  NO_TARGET: "NO_TARGET",
  /** The endpoint is not in the corpus at all. */
  NOT_IN_CORPUS: "NOT_IN_CORPUS",
  /** We started observing after the window opened. The chart must say so. */
  THIN_HISTORY: "THIN_HISTORY",
  /**
   * We could not ask Analytics Engine. **Distinct from having asked and found
   * nothing** — We built `queryAnalytics` to return `{rows: null, error}` for
   * precisely this reason.
   */
  ANALYTICS_UNAVAILABLE: "ANALYTICS_UNAVAILABLE",
  /** We asked, and there are no samples in this window. A real answer. */
  NO_SAMPLES: "NO_SAMPLES",
  /**
   * Analytics Engine ingestion lags (We measured a datapoint invisible at +12s
   * and visible later). A probe inside that horizon may not be in the sampled
   * series yet, and D1 knows about it when Analytics Engine does not.
   */
  RECENT_PROBE_PENDING: "RECENT_PROBE_PENDING",
  /** The leading price point predates the window; it is the price entering it. */
  PRICE_ANCHOR_BEFORE_WINDOW: "PRICE_ANCHOR_BEFORE_WINDOW",
} as const;

/** Why the sampled half of the page is empty, if it is. */
export type SamplingState = "available" | "unavailable" | "no_samples";

export function samplingState(view: HistoryView): SamplingState {
  const has = (code: string): boolean => view.warnings.some((w) => w.code === code);
  if (has(WARN.ANALYTICS_UNAVAILABLE)) return "unavailable";
  if (has(WARN.NO_SAMPLES)) return "no_samples";
  return view.data.series.availability.length > 0 || view.data.series.latency.length > 0
    ? "available"
    : "no_samples";
}

export function warningMessage(view: HistoryView, code: string): string | null {
  return view.warnings.find((w) => w.code === code)?.message ?? null;
}

// ── the copy that carries the distinction ─────────────────────────────────
// Written once, rendered by both the page and the markdown mirror. A reader who
// only ever sees one of the two representations still gets the same claim about
// what kind of number they are looking at.

export const EXACT_HEADING = "Exact record";
export const SAMPLED_HEADING = "Sampled telemetry";

export const EXACT_LEAD =
  "Every entry below is a change we observed, written once to an append-only log and never edited. " +
  "The dates are the moment we observed the change. This is the record an operator would be shown.";

export const SAMPLED_LEAD =
  "These figures are estimates. They come from a sampled dataset: each stored measurement stands for " +
  "several real ones, and old measurements age out. They are good enough to describe a trend and are " +
  "not evidence about any particular request.";

export const EXACT_LABEL = "exact · append-only record";
export const SAMPLED_LABEL = "sampled · estimate";

/** Prefix every sampled figure. An exact figure never carries it. */
export const APPROX = "≈";

export const NOT_IN_CORPUS_TITLE = "No history yet";

export const NOT_IN_CORPUS_BODY =
  "We have not observed this endpoint, so there is nothing to chart. That is the normal state for an " +
  "endpoint we have not met — history builds from the first observation onward, and an empty chart is " +
  "the honest display for one, not a fault.";

export const ANALYTICS_UNAVAILABLE_TITLE = "We could not ask";

export const ANALYTICS_UNAVAILABLE_BODY =
  "The availability and latency figures come from a separate analytics service, and this request could " +
  "not reach it. This is not the same as there being no measurements: we do not know what they say. " +
  "The exact record above is unaffected — it comes from our own database.";

export const NO_SAMPLES_TITLE = "No samples in this window";

export const NO_SAMPLES_BODY =
  "We asked, and there are no probe samples for this endpoint in this window. The exact record above is " +
  "unaffected.";

// ── labels ────────────────────────────────────────────────────────────────
// "the recipient changed on 2026-07-21", never "suspicious". Each
// label states what moved. None of them characterises the operator, and the
// words this repo may never print appear in none of them.

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  first_seen: "First observed",
  price: "Price changed",
  recipient: "Recipient changed",
  network: "Network changed",
  asset: "Asset changed",
  scheme: "Payment scheme changed",
  timeout: "Authorization window changed",
  facilitator: "Facilitator changed",
  resource: "Resource URL changed",
  challenge_shape: "Challenge changed shape",
  wire_version: "Wire version changed",
  availability_state: "Reachability changed",
  status: "Status changed",
  correction: "Correction",
};

/**
 * A one-line statement of what a change row records.
 *
 * Values are printed verbatim from the row. `first_seen` has no `old_value` by
 * definition, and a `correction` names the row it corrects rather than quietly
 * replacing it — the table is append-only, so a correction is another entry.
 */
export function describeChange(change: TermChange): string {
  const label = CHANGE_KIND_LABEL[change.change_kind] ?? change.change_kind;

  if (change.change_kind === "first_seen") {
    return `${label} — this is where our record of this endpoint begins.`;
  }
  if (change.old_value === null && change.new_value !== null) {
    return `${label}: ${change.field} set to ${change.new_value}.`;
  }
  if (change.old_value !== null && change.new_value === null) {
    return `${label}: ${change.field} was ${change.old_value} and is no longer set.`;
  }
  if (change.old_value === null && change.new_value === null) {
    return `${label}: ${change.field}.`;
  }
  return `${label}: ${change.field} from ${change.old_value} to ${change.new_value}.`;
}

/** `2026-07-21T14:02:11Z` → `21 Jul 2026`. Dates are exact, so they are plain. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string | null): string {
  if (!iso) return "unknown";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "unknown";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)}, ${hh}:${mm} UTC`;
}

/** Days between two RFC 3339 stamps, or null when either is missing. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * A sampled ratio, as a percentage. Two decimals, and **always** carrying the
 * approximation mark: the precision of the arithmetic is not the precision of
 * the measurement.
 */
export function formatRatio(ratio: number): string {
  return `${APPROX}${(ratio * 100).toFixed(2)}%`;
}

export function formatMs(ms: number | null): string {
  return ms === null ? "not observed" : `${APPROX}${Math.round(ms)} ms`;
}

/**
 * A price, for display only. `amount_decimal` is derived and never used for
 * arithmetic (SPEC §1.4); when we do not know the asset's decimals the atomic
 * value is shown as-is, labelled, rather than being silently scaled.
 */
export function formatPrice(point: PricePoint): string {
  const symbol = point.asset_symbol ? ` ${point.asset_symbol}` : "";
  if (point.amount_decimal) return `${point.amount_decimal}${symbol}`;
  return `${point.amount_atomic}${symbol ? `${symbol} (atomic)` : " (atomic units)"}`;
}

/** The window's opening moment, given "now". */
export function windowStart(now: string, window: HistoryWindow): string {
  const at = Date.parse(now) - WINDOW_DAYS[window] * 86_400_000;
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}
