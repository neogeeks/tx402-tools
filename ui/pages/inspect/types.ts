/**
 * The Inspector's view model.
 *
 * `InspectData` is the TypeScript face of `spec/schemas/inspect.json` (SPEC
 * §5.1). It is produced **once**, by `worker/routes/inspect.ts`, and then
 * rendered three ways: as JSON, as the plaintext report, and as the page. SPEC
 * §1.2 is explicit that the markdown mirror is "a rendering of the same JSON,
 * never a separate computation" — so every renderer in this directory takes
 * this type and nothing else, and none of them may reach for a probe result, a
 * database row or a clock.
 *
 * The view helpers at the bottom are the small set of decisions a renderer has
 * to make that are the same in all three surfaces. They live here so the page
 * and the report cannot disagree about, for example, whether the terms on
 * display were accepted by the decoder.
 */

import type { Challenge, ProbeMeta, Requirement } from "../../../worker/lib/probe.js";
import type { Signal } from "../../../worker/lib/signals.js";
import type { Risk } from "../../../worker/lib/score.js";

export type { Challenge, ProbeMeta, Requirement, Risk, Signal };

/** SPEC §4.3. Ids come from the frozen list in SPEC §5.2.1 — never invented. */
export interface Check {
  id: string;
  status: "pass" | "warn" | "fail" | "skip";
  offline: boolean;
  reason: string | null;
  detail: string | null;
}

/** SPEC §4.6. */
export interface TermChange {
  id: string;
  changed_at: string;
  change_kind: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_by?: string;
  score_version?: string | null;
}

export interface InspectTarget {
  url: string | null;
  canonical_url: string | null;
  endpoint_id: string | null;
  origin: string | null;
  host: string | null;
}

/**
 * What the corpus knows.
 *
 * `has_history: false` is the DEFAULT and CORRECT state, not a
 * degraded one: the Inspector ships before the crawler precisely so that human
 * scans seed the graph, and most pasted URLs will be new forever.
 *
 * `availability_30d` and `latency_p50_ms` are **always null here**. They come
 * from Analytics Engine aggregates, which are its to build and whose read path
 * is still unproven. One probe is not an availability
 * measurement, and rendering "100%" from a single 402 would be a fabricated
 * number in the one place this product cannot afford one.
 */
export interface InspectObserved {
  has_history: boolean;
  first_seen: string | null;
  last_seen: string | null;
  scan_count: number;
  availability_30d: number | null;
  latency_p50_ms: number | null;
  recent_changes: TermChange[];
}

export interface InspectLinks {
  html: string | null;
  markdown: string | null;
  json: string | null;
  history: string | null;
  methodology: string | null;
  share: string | null;
}

/** SPEC §5.1 — the frozen `data` shape. */
export interface InspectData {
  target: InspectTarget;
  probe: ProbeMeta | null;
  challenge: Challenge | null;
  terms: Requirement | null;
  checks: Check[];
  signals: Signal[];
  risk: Risk | null;
  observed: InspectObserved;
  links: InspectLinks;
}

/** Everything a renderer needs, and nothing it could compute differently. */
export interface InspectView {
  data: InspectData;
  /** The full envelope, so a renderer can show `meta` and `warnings`. */
  envelope: {
    meta: { cached: boolean; cache_age_seconds: number | null; tx402_version: string | null };
    warnings: { code: string; message: string }[];
  };
  /** Origin for absolute links, e.g. `https://tools.tx402.io`. */
  origin: string;
  /** Set on a `/s/:id` render: this report is a stored snapshot. */
  snapshot: { id: string; created_at: string; expires_at: string } | null;
}

// ── the decisions every renderer shares ───────────────────────────────────

export type Outcome = "valid" | "malformed" | "not_x402" | "no_input";

/**
 * Which of the four normal result states this is (SPEC §3.1).
 *
 * **None of them is an HTTP error.** A malformed challenge and a URL that is
 * not an x402 endpoint are both answers the user came for; only a guard refusal
 * produces an error envelope, and that never reaches this function.
 */
export function outcomeOf(data: InspectData): Outcome {
  if (data.probe === null || data.challenge === null) return "no_input";
  if (data.challenge.wire_form === "none") return "not_x402";
  return data.challenge.valid ? "valid" : "malformed";
}

/**
 * Where `data.terms` came from.
 *
 * SPEC §4.2 requires `challenge.accepts` to be empty when `valid` is false, so
 * a refused challenge can never look accepted. The probe still parses what it
 * saw into `observed_terms` because a report that shows nothing
 * for a broken endpoint is useless to the person trying to fix it — and
 * `data.terms` may therefore be a parsed-but-unaccepted requirement.
 *
 * **Every surface must label which it is showing.** Rendering `observed_terms`
 * as though the challenge validated is the one misreading of this report that
 * would matter, so the distinction is computed here once rather than
 * re-derived per renderer.
 */
export function termsAccepted(data: InspectData): boolean {
  return data.terms !== null && data.challenge?.valid === true;
}

/** Human phrase for a wire form. */
export function wireFormLabel(challenge: Challenge | null): string {
  switch (challenge?.wire_form) {
    case "v2-header":
      return "x402 v2 — PAYMENT-REQUIRED header";
    case "v1-body":
      return "x402 v1 — JSON response body";
    case "both":
      return "both the v2 header and a v1 body";
    default:
      return "no x402 challenge";
  }
}

/**
 * True when the endpoint serves only the legacy v1 form.
 *
 * This is worth calling out on every surface, because `challenge_decodes` and
 * `wire_form` both fail for a perfectly healthy v1 endpoint — tx402's decoder
 * is v2-only. `spec/risk-score.md` states it under Known limitations, and
 * `V1_NOTE` below is the sentence the renderers show so that the score is not
 * mistaken for a judgement about the operator.
 */
export function isLegacyV1(data: InspectData): boolean {
  return data.challenge?.wire_form === "v1-body" || data.challenge?.x402_version === 1;
}

/**
 * Verbatim from `spec/risk-score.md` § "A v1 endpoint scores lower, and that is
 * a claim about tx402, not about the endpoint". Kept as one exported constant
 * so the page, the report and any future surface say the same thing.
 */
export const V1_NOTE =
  "This endpoint serves the legacy x402 v1 form. tx402's decoder is v2-only, so a perfectly healthy v1 " +
  "endpoint fails the decode check here. That is a statement about what a tx402 buyer can pay today, not " +
  "about how this endpoint is run.";

/** The line under a risk band, on every surface (SPEC §4.5). */
export const BAND_NOTE =
  "A band describes how much of what we check we were able to confirm. It is not a judgement about the " +
  "operator of an endpoint.";

/** What the risk section says when there was no challenge to score. */
export const NOT_X402_NOTE =
  "This URL answered, but not with an x402 payment challenge, so there is nothing to score. That is a " +
  "description of the response, not a finding about the endpoint.";

/** Rendered whenever the corpus has never seen this endpoint before. */
export const NO_HISTORY_NOTE =
  "First seen: just now · no history yet. Availability and latency need repeated observations over " +
  "time; one probe is not a measurement of either, so neither is shown.";

// ── formatting shared by the report and the page ──────────────────────────

/** `0.001000 USDC` — display only. Never do arithmetic on this (SPEC §1.4). */
export function priceLabel(terms: Requirement | null): string | null {
  if (!terms) return null;
  const symbol = terms.asset?.symbol ?? null;
  if (terms.amount_decimal && symbol) return `${terms.amount_decimal} ${symbol}`;
  if (terms.amount_decimal) return terms.amount_decimal;
  if (terms.amount_atomic) return `${terms.amount_atomic} (atomic units)`;
  if (terms.amount_raw) return `${terms.amount_raw} (not a canonical atomic amount)`;
  return null;
}

/**
 * A money string the SDK's `parseMoneyAtomic` will accept: `<decimal> <SYMBOL>`
 * with the symbol matching `^[A-Z][A-Z0-9]{0,11}$`. Returns null rather than
 * guessing — a snippet with an amount the SDK rejects is worse than a snippet
 * that says the amount could not be determined.
 */
export function sdkMoney(terms: Requirement | null): string | null {
  const symbol = terms?.asset?.symbol ?? null;
  const decimal = terms?.amount_decimal ?? null;
  if (!symbol || !decimal) return null;
  if (!/^[A-Z][A-Z0-9]{0,11}$/u.test(symbol)) return null;
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(decimal)) return null;
  return `${decimal} ${symbol}`;
}

/** `184 ms`, or null when the probe did not report one. */
export function latencyLabel(probe: ProbeMeta | null): string | null {
  return probe?.latency_ms === null || probe?.latency_ms === undefined
    ? null
    : `${probe.latency_ms} ms`;
}

/** Truncate a long opaque value for display, keeping both ends recognizable. */
export function ellipsize(value: string, keep = 10): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
