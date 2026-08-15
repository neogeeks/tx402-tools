/**
 * The words on `/methodology`, in one place, so the HTML and the Markdown
 * mirror cannot say different things about how we judge somebody.
 *
 * ── Every string here is written against ─────────────────────
 *
 * A public risk verdict about someone else's business is a legal surface.
 * These strings describe **what we observed** and never what we believe about
 * an operator. The words *scam*, *fraud*, *fraudulent*, *unsafe*, *dangerous*
 * and *malicious* appear nowhere in them, in any language, ever, and
 * `test/methodology-page.test.ts` asserts it over the rendered output rather
 * than over this file — so a sentence assembled at render time is covered too.
 *
 * `ui/tool-meta.ts` is where this copy would normally live, alongside the other
 * six tools. That file is -owned and `/methodology` has no entry in it, so
 * the copy lives here and the wave-5 integrator adds the row; the shape below
 * matches `ToolMeta` so it can be moved without a rewrite.
 */

import { BAND_NOTE } from "../inspect/types.js";

export const META = {
  path: "/methodology",
  name: "Scoring methodology",
  title: "How an x402 endpoint risk score is calculated",
  description:
    "Every signal behind an x402 endpoint's risk score, what each one weighs and why, the exact band thresholds, and how to recompute the score yourself from the raw signals.",
  h1: "How is this x402 endpoint's risk score calculated?",
  intent:
    "x402 risk score · how is this x402 endpoint scored · x402 endpoint reputation methodology",
  live: true,
} as const;

/**
 * The sentence that has to be above the fold on every surface that renders a
 * band. On this page it is the lede, not a footnote:
 * every other surface's caveat links here, so if the framing were buried the
 * whole chain of caveats would point at nothing.
 */
export const ABOVE_THE_FOLD =
  "A band of LOW, MEDIUM or HIGH is a statement about our observations, and never about the operator of an " +
  "endpoint. It describes how much of what we can check we were able to confirm. A HIGH band most often " +
  "means we could not verify much, or that an endpoint has an interoperability bug — it is not a finding " +
  "that anyone has done anything wrong, and we do not have the evidence to say that even if we wanted to.";

export const LEDE =
  "The score is the share of the things we could check that checked out. It is arithmetic over a fixed " +
  "table of signals — not a model, not a heuristic, and not an opinion — and every number below is read " +
  "directly out of the function that produces it.";

export const NOT_A_VERDICT_HEADING = "What the score is not";

export const GENERATED_NOTE =
  "This page is generated from the scoring function itself: the weights, the severities, the thresholds " +
  "and the per-signal wording are read out of `worker/lib/score.ts` at render time, and the two prose " +
  "columns come from `spec/risk-score.md`. A test fails the build if they diverge, because a published " +
  "method that no longer matches the actual method is worse than no published method at all.";

export const RULE_ONE_HEADING = "Unknown is not bad";
export const RULE_ONE =
  "A signal we could not observe is excluded from both sides of the ratio. It does not reduce the score; " +
  "it reduces the coverage. The alternative — treating unknown as a failure — would make every " +
  "brand-new endpoint look questionable, and most endpoints anyone asks us about are ones we have never " +
  "seen before.";

export const RULE_TWO_HEADING = "A marketplace is not a rug";
export const RULE_TWO =
  "A different payout address per request is a first-class x402 v2 feature built for marketplaces and " +
  "multi-tenant APIs. So the only recipient-instability signal that may ever count against a score is one " +
  "that is both unstable AND not declared dynamic, and a bare “the recipient changed” signal is " +
  "forbidden in every version of the scoring function — enforced in code, not merely written down. In " +
  "v1 no recipient-instability signal is scored at all.";

export const COVERAGE_HEADING = "The coverage floor";
export const BANDS_HEADING = "Bands";
export const ARITHMETIC_HEADING = "The arithmetic";
export const SIGNALS_HEADING = "The signals and what each one weighs";
export const EXAMPLES_HEADING = "Worked examples, scored live on this page";
export const MAGNITUDE_HEADING = "Amount magnitude bands";
export const VERSION_HEADING = "Versioning";
export const APPEAL_HEADING = "If a score about your endpoint is wrong";

export const EXAMPLES_NOTE =
  "These are not tables somebody typed. Each one is the actual return value of the scoring function over a " +
  "signal set, rendered when you loaded this page. `reproduced` is the same number worked out a second " +
  "time from `reasons[]` alone — which is exactly what you can do with the JSON of any response we serve.";

export const REPRODUCE_NOTE =
  "Every score is reproducible from the response that contains it. `reasons[]` carries the applied weight " +
  "for every signal evaluated, including passes and skips, so the arithmetic can be redone by anyone " +
  "holding the JSON.";

export const VERSION_NOTE =
  "Scores are comparable only within one score version. Historical scores are never recomputed: a score " +
  "you received is the score you received, produced by the rules that applied at the time. Every " +
  "version's methodology stays published at /methodology?v=<version> forever, because removing one would " +
  "strand every score ever rendered under it.";

export const NO_SCORE_NOTE =
  "There is no score at all when an endpoint served no x402 challenge. A URL that is not an x402 endpoint " +
  "is not a risky endpoint, and rendering a band for one would be a verdict about something we never " +
  "assessed.";

export const APPEAL_INTRO =
  "You can prove you operate an endpoint, see every observation we hold about it, dispute a fact, and be " +
  "removed entirely. This ships with the first public score rather than after the first complaint. There " +
  "is no account and no sign-in anywhere in this product: control of the domain is the whole of the " +
  "proof, and we hold no contact details for anyone.";

export const APPEAL_CLAIM_ID_NOTE =
  "Keep the claim id the first call returns. It is how you read the dossier again and how you file an " +
  "appeal, and because there is no account there is nothing to recover it from. Losing it costs nothing " +
  "permanent: claim the origin again and every appeal ever filed for it comes back.";

export const APPEAL_CORRECTION_NOTE =
  "A correction is reviewed by a person and, if upheld, APPENDED to the change log as a correction row " +
  "pointing at the record it corrects. Nothing is overwritten — that table refuses updates and deletes at " +
  "the database level — so what we published and what we corrected both stay visible.";

export const APPEAL_REMOVAL_NOTE =
  "A removal is applied immediately, honoured at read time as well as at crawl time. Records already " +
  "written to the append-only change log are retained but stop being served.";

export { BAND_NOTE };
