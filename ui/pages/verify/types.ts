/**
 * The shapes `/verify` renders.
 *
 * These mirror `spec/schemas/verify.json` exactly. Where they and the schema
 * can disagree the schema wins (SPEC's own preamble), and `test/verify.test.ts`
 * validates every response against it so a disagreement is a failing test
 * rather than a surprise for the CLI.
 */

import type { Challenge } from "../../../worker/lib/probe.js";
import type { Risk } from "../../../worker/lib/score.js";
import type { Signal } from "../../../worker/lib/signals.js";
import type { Check, Verdict } from "../../../packages/tools-cli/src/verify-offline.js";

export type { Check, Verdict };

/**
 * The corpus half of the answer (SPEC §5.2). `null` whenever `options.enrich`
 * was false, which is the default — the offline verdict never depends on it.
 */
export interface Enrichment {
  endpoint_known: boolean;
  endpoint_id: string | null;
  amount_within_observed_range: boolean | null;
  observed_amount_range: { min_atomic: string; max_atomic: string; samples: number } | null;
  recipient_matches_observed: boolean | null;
  last_observed_pay_to: string | null;
}

export interface VerifyData {
  verdict: Verdict;
  challenge: Challenge | null;
  checks: Check[];
  signals: Signal[];
  risk: Risk | null;
  enrichment: Enrichment | null;
}

/**
 * One-line summaries of what each frozen check id asks, for the report.
 *
 * Phrased as questions about the challenge, never about whoever operates the
 * endpoint. The result's own `detail` carries the specifics;
 * this is the column header a reader scans.
 */
export const CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  wire_form_detected: "An x402 challenge was found",
  base64_strict: "The header is strict base64",
  size_within_limit: "Within the decoder's size limit",
  depth_within_limit: "Within the decoder's nesting limit",
  no_duplicate_keys: "No duplicate JSON keys",
  json_wellformed: "Well-formed JSON",
  x402_version_known: "A protocol version tx402 can read",
  accepts_present: "At least one way to pay is offered",
  accepts_within_limit: "Within the decoder's requirement limit",
  scheme_known: "A payment scheme tx402 can route",
  network_caip2_wellformed: "The network is a well-formed CAIP-2 id",
  network_recognized: "The network is in the tx402 signed manifest",
  asset_recognized: "The asset is in the tx402 signed manifest",
  amount_atomic_canonical: "The amount is a canonical atomic integer",
  amount_positive: "The amount is a positive charge",
  pay_to_wellformed: "The recipient is well-formed for its chain",
  max_timeout_sane: "The authorization window is one tx402 will sign for",
  resource_origin_match: "The resource belongs to the endpoint that served it",
  mime_type_wellformed: "The media type is well-formed",
  extra_wellformed: "`extra` is a JSON object",
  facilitator_known: "The facilitator is on the published list",
  amount_within_observed_range: "The amount is within the range we have observed",
  recipient_matches_observed: "The recipient matches the one we last observed",
  endpoint_known: "We have seen this endpoint before",
});

/** Human sentence for the top-line verdict. Observation, never accusation. */
export const VERDICT_SUMMARY: Readonly<Record<Verdict, string>> = Object.freeze({
  pass: "Every check we could run on this challenge passed.",
  warn: "This challenge decodes, and some checks returned something worth reading before you sign.",
  fail: "At least one check failed. tx402 would not pay this challenge as it stands.",
});

export const VERDICT_LABEL: Readonly<Record<Verdict, string>> = Object.freeze({
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
});
