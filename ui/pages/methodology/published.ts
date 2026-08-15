/**
 * The prose half of the methodology, lifted verbatim from `spec/risk-score.md`.
 *
 * ── Why this file exists at all ────────────────────────────────────────────
 *
 * `/methodology` must be **generated** from `worker/lib/score.ts` and
 * `spec/risk-score.md`, not transcribed from them: a methodology page that can
 * drift from the function it documents is worse than no page, because it is a
 * published claim about how we judge somebody that is quietly false.
 *
 * Every *number* on the page — weight, severity, band threshold, coverage
 * floor, score version, total available weight — is imported from `score.ts`
 * and never appears here. Every *message* on the page is produced by calling
 * `score` and reading `reasons[].message`. What is left is the two prose
 * columns of the published table, and a Worker cannot read the filesystem at
 * request time, so they are carried here as data.
 *
 * ── The rule that keeps this honest ────────────────────────────────────────
 *
 * **This file is generated, not typed.** `test/methodology-page.test.ts`
 * re-parses `spec/risk-score.md` with the same extraction and asserts deep
 * equality against the array below, in both directions. Editing a cell here
 * without editing the document — or the other way round — fails the suite.
 * The document wins: `spec/risk-score.md` says so in its own header, and its
 * exit criteria say so too.
 */

export interface PublishedProse {
  /** Signal id, matching a rule in `worker/lib/score.ts`. */
  id: string;
  /** The "Passes when" column, verbatim, inline markdown included. */
  passesWhen: string;
  /** The "Why it is worth this much" column, verbatim. */
  rationale: string;
}

export const PUBLISHED_PROSE: readonly PublishedProse[] = Object.freeze([
  {
    id: "challenge_decodes",
    passesWhen: "The strict x402 decoder accepts the challenge",
    rationale:
      "The single most load-bearing fact available. This is the same `decodePaymentRequired` the tx402 SDK runs *before it will pay*, so a failure here means a tx402 buyer cannot transact with this endpoint at all. Nothing else we check outranks \"it does not work\".",
  },
  {
    id: "resource_origin_match",
    passesWhen: "The challenge's `resource` origin equals the probed origin",
    rationale:
      "A 402 describing somebody else's resource is the shape of a payment-redirection bug: you ask A for a price and are handed B's invoice. Highest-severity thing we can see in a single observation.",
  },
  {
    id: "amount_canonical",
    passesWhen: "The amount is a canonical atomic integer (SPEC §1.4)",
    rationale:
      "`\"0.01\"` where atomic units are required is the most common real x402 mistake, and its failure mode is paying the wrong amount by orders of magnitude.",
  },
  {
    id: "pay_to_wellformed",
    passesWhen: "The recipient is a valid address for the chain family",
    rationale:
      "Money sent to a malformed address. Weighted equal to the amount because the consequence is the same size.",
  },
  {
    id: "network_recognized",
    passesWhen: "The network is in the tx402 signed release manifest",
    rationale:
      "`warn`, not `fail`: an unrecognized network may simply be newer than our manifest. Real information, weaker claim.",
  },
  {
    id: "asset_recognized",
    passesWhen: "The asset is in the manifest for that network",
    rationale:
      "Same reasoning. An unrecognized token contract is worth knowing and is not an accusation.",
  },
  {
    id: "facilitator_known",
    passesWhen: "The facilitator is on the [published list](#the-facilitator-list)",
    rationale:
      "Being absent from our list says something about *our list* as much as about the facilitator. Deliberately low.",
  },
  {
    id: "scheme_known",
    passesWhen: "The payment scheme is one tx402 can route",
    rationale:
      "An unroutable scheme means tx402 cannot pay it, but the ecosystem is adding schemes.",
  },
  {
    id: "tls_ok",
    passesWhen: "The endpoint was reached over valid TLS",
    rationale:
      "The hosted probe is https-only, so in practice this is always true when a result exists. It is scored so the CLI — which may use `http:` against localhost — produces comparable numbers.",
  },
  {
    id: "timeout_sane",
    passesWhen: "`0 < maxTimeoutSeconds <= 60`",
    rationale:
      "60s is tx402's `MAX_AUTHORIZATION_SECONDS`, the longest window it will sign for. Many endpoints use 300s and are perfectly legitimate, so this is a low-weight `warn` — it tells a tx402 buyer they will hit a limit, not that the endpoint is bad.",
  },
  {
    id: "redirect_scheme_downgrade",
    passesWhen: "No hop downgraded the scheme",
    rationale:
      "The guard refuses cross-scheme redirects outright, so a scored result never downgraded. Kept in the table because \"we checked and it did not happen\" is a fact worth publishing.",
  },
  {
    id: "wire_form",
    passesWhen: "The endpoint serves `v2-header` or `both`",
    rationale:
      "A v1-only endpoint is legacy, not broken. Low weight, because plenty of working endpoints are still v1.",
  },
  {
    id: "amount_magnitude_band",
    passesWhen: "The band is not `extreme`",
    rationale:
      "Weakest signal in the table by design. A large price is a business decision, not a defect.",
  },
]);
