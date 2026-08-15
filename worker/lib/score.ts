/**
 * `score(signals, version)` — the risk score.
 *
 * **Pure. Deterministic. No I/O, no clock, no randomness, no model.** Given the same signals it
 * returns the same number forever, on any machine, in any version of this Worker. That is not a
 * style preference: a public risk verdict about somebody else's business is a legal and
 * reputational surface, and "deterministic, published and appealable" is the only defensible
 * posture for one.
 *
 * ── Reproducibility IS the appeal mechanism ────────────────────────────────
 *
 * `reasons[]` carries the applied weight for **every** signal that was
 * evaluated, including the ones that passed and the ones that were skipped. A
 * merchant who disagrees with a score does not have to take our word for the
 * arithmetic: the raw signals and the per-signal weights are both in the same
 * response, and adding them up reproduces the number. `spec/risk-score.md`
 * publishes the same table in prose, and it is rendered at `/methodology` with
 * a test that the page and this file agree.
 *
 * ── What the number means, and what it does not ────────────────────────────
 *
 * The score is the share of **what we could check that checked out**. It is a
 * statement about our observations, never about an operator (SPEC §4.5). The
 * words *scam*, *fraud*, *fraudulent*, *unsafe*, *dangerous* and *malicious*
 * appear in no message this file can emit, and the band names describe the
 * level of caution our observations support.
 *
 * ── The two rules that stop it crying wolf ─────────────────────────────────
 *
 * 1. **An unobserved signal is excluded from both sides of the ratio** (SPEC
 *    §6.3). It does not reduce the score; it reduces the coverage. A brand-new
 *    endpoint with no history is not a suspicious endpoint.
 * 2. **The dynamic-`payTo` carve-out** (SPEC §6.4). `recipient_unstable_undeclared`
 *    is the only recipient-instability signal that may ever count against a
 *    score, and a bare "recipient changed" signal is forbidden in every
 *    version. It is unscoreable in v1 by construction — the historical half
 *    arrives with the corpus — and `assertNoBareRecipientSignal` enforces the ban in
 *    code so a future version cannot reintroduce it by accident.
 */

import type { Signal } from "./signals.js";

export type Band = "LOW" | "MEDIUM" | "HIGH";
export type ReasonStatus = "pass" | "warn" | "fail" | "skip";
export type Confidence = "static_only" | "with_history";

/** SPEC §4.5. */
export interface RiskReason {
  signal_id: string;
  status: ReasonStatus;
  weight: number;
  message: string;
}

export interface Risk {
  score: number;
  band: Band;
  score_version: string;
  confidence: Confidence;
  signals_evaluated: number;
  reasons: RiskReason[];
  methodology_url: string;
}

export const CURRENT_SCORE_VERSION = "v1" as const;

// ── the rule table ────────────────────────────────────────────────────────
// This table and `spec/risk-score.md` are the same document in two forms. A
// change to either is a `score_version` bump (SPEC §7) — including a bug fix,
// because a fix that changes an output score changes a published verdict.

interface Rule {
  id: string;
  weight: number;
  /**
   * `fail` for signals where a negative is a concrete defect in the challenge;
   * `warn` where a negative may simply mean "newer than our lists". The
   * severity does not change the arithmetic — the weight already carries that
   * — it tells a renderer how to phrase the finding.
   */
  severity: "fail" | "warn";
  /** Undefined ⇒ the signal was not evaluable, and it is skipped. */
  passes: (value: Signal["value"]) => boolean | undefined;
  onPass: string;
  onFail: string;
}

const isTrue = (v: Signal["value"]): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

const V1_RULES: readonly Rule[] = [
  {
    id: "challenge_decodes",
    weight: 25,
    severity: "fail",
    passes: isTrue,
    onPass: "The challenge decodes under the strict x402 decoder tx402 uses before paying.",
    onFail: "The challenge does not decode under the strict x402 decoder tx402 uses before paying.",
  },
  {
    id: "resource_origin_match",
    weight: 15,
    severity: "fail",
    passes: isTrue,
    onPass: "The challenge describes the endpoint that served it.",
    onFail: "The challenge's resource URL points at a different origin than the endpoint that served it.",
  },
  {
    id: "amount_canonical",
    weight: 12,
    severity: "fail",
    passes: isTrue,
    onPass: "The amount is a canonical atomic integer.",
    onFail: "The amount is not a canonical atomic integer, so its value is open to interpretation.",
  },
  {
    id: "pay_to_wellformed",
    weight: 12,
    severity: "fail",
    passes: isTrue,
    onPass: "The recipient is a well-formed address for the declared network.",
    onFail: "The recipient is not a well-formed address for the declared network.",
  },
  {
    id: "network_recognized",
    weight: 8,
    severity: "warn",
    passes: isTrue,
    onPass: "The network is in the tx402 signed release manifest.",
    onFail: "The network is not in the tx402 signed release manifest.",
  },
  {
    id: "asset_recognized",
    weight: 8,
    severity: "warn",
    passes: isTrue,
    onPass: "The asset is in the tx402 signed release manifest for this network.",
    onFail: "The asset is not in the tx402 signed release manifest for this network.",
  },
  {
    id: "facilitator_known",
    weight: 6,
    severity: "warn",
    passes: isTrue,
    onPass: "The facilitator is on the published list.",
    onFail: "The facilitator is not on the published list.",
  },
  {
    id: "scheme_known",
    weight: 6,
    severity: "warn",
    passes: isTrue,
    onPass: "The payment scheme is one tx402 can route.",
    onFail: "The payment scheme is not one tx402 can route.",
  },
  {
    id: "tls_ok",
    weight: 5,
    severity: "fail",
    passes: isTrue,
    onPass: "The endpoint was reached over a valid TLS connection.",
    onFail: "The endpoint was not reached over a valid TLS connection.",
  },
  {
    id: "timeout_sane",
    weight: 4,
    severity: "warn",
    passes: isTrue,
    onPass: "The authorization window is within the maximum tx402 will sign for.",
    onFail: "The authorization window is outside the maximum tx402 will sign for.",
  },
  {
    id: "redirect_scheme_downgrade",
    weight: 3,
    severity: "fail",
    // Inverted: passing means the downgrade did NOT happen.
    passes: (v) => (typeof v === "boolean" ? !v : undefined),
    onPass: "No redirect downgraded the connection.",
    onFail: "A redirect downgraded the connection to a plaintext scheme.",
  },
  {
    id: "wire_form",
    weight: 3,
    severity: "warn",
    passes: (v) =>
      typeof v === "string"
        ? v === "v2-header" || v === "both"
        : undefined,
    onPass: "The endpoint serves the x402 v2 header form.",
    onFail: "The endpoint serves only the legacy v1 body form, which tx402 does not accept.",
  },
  {
    id: "amount_magnitude_band",
    weight: 2,
    severity: "warn",
    passes: (v) =>
      typeof v === "string" ? (v === "unknown" ? undefined : v !== "extreme") : undefined,
    onPass: "The amount is within the range we see for x402 endpoints.",
    onFail: "The amount is far above the range we see for x402 endpoints.",
  },
];

/**
 * SPEC §6.4, enforced rather than merely documented.
 *
 * A bare "recipient changed" signal is forbidden in **every** version of the
 * scoring function, because dynamic `payTo` is a first-class x402 v2 feature
 * and a marketplace is not a rug. Only `recipient_unstable_undeclared` may ever
 * count. This runs over the rule table at module load, so reintroducing the
 * banned signal fails the test suite the moment it is added rather than after
 * the first angry merchant.
 */
export function assertNoBareRecipientSignal(rules: readonly Rule[] = V1_RULES): void {
  const banned = ["recipient_changed", "recipient_changes_90d", "pay_to_changed"];
  for (const rule of rules) {
    if (banned.includes(rule.id)) {
      throw new Error(
        `SPEC §6.4: "${rule.id}" may never be scored. Only recipient_unstable_undeclared counts.`,
      );
    }
  }
}

assertNoBareRecipientSignal();

// ── bands ─────────────────────────────────────────────────────────────────
// Published with the version, never with the deploy (SPEC §7).

export const V1_BANDS = { low: 80, medium: 55 } as const;

export function bandFor(score: number): Band {
  if (score >= V1_BANDS.low) return "LOW";
  if (score >= V1_BANDS.medium) return "MEDIUM";
  return "HIGH";
}

/**
 * Below this share of the total available weight, the observations are too thin
 * to support the score's own arithmetic — three passing signals out of thirteen
 * would otherwise read as 100. Coverage below the floor caps the band at
 * MEDIUM and says so in `reasons[]`. It never *lowers* a score, so SPEC §6.3
 * still holds: unknown is not treated as bad, it is treated as unknown.
 */
export const V1_COVERAGE_FLOOR = 0.5;

// ── the function ──────────────────────────────────────────────────────────

export interface ScoreOptions {
  confidence?: Confidence;
  methodologyBaseUrl?: string;
}

/**
 * Score a signal set.
 *
 * Returns `null` when there is nothing to score — specifically when the
 * endpoint served no x402 challenge at all. A URL that is simply not an x402
 * endpoint is not a risky endpoint, and rendering a band for it would be a
 * verdict about something we never assessed. SPEC §5.1 already types `risk` as
 * `Risk | null`, so this is the contract, not an extension of it.
 */
export function score(
  signals: Signal[],
  version: string = CURRENT_SCORE_VERSION,
  options: ScoreOptions = {},
): Risk | null {
  if (version !== CURRENT_SCORE_VERSION) {
    throw new Error(
      `Unknown score_version "${version}". Scores are only comparable within one version (SPEC §7).`,
    );
  }

  const byId = new Map(signals.map((s) => [s.id, s]));

  const served = byId.get("challenge_served");
  if (served && served.observed && served.value !== true) return null;

  const reasons: RiskReason[] = [];
  let earned = 0;
  let possible = 0;

  for (const rule of V1_RULES) {
    const signal = byId.get(rule.id);

    if (!signal || !signal.observed) {
      // SPEC §6.3: excluded from both sides. Still reported, because "we did
      // not check this" is information the reader is entitled to.
      reasons.push({
        signal_id: rule.id,
        status: "skip",
        weight: 0,
        message: signal?.detail ?? "Not observed, so it was not scored.",
      });
      continue;
    }

    const passed = rule.passes(signal.value);
    if (passed === undefined) {
      reasons.push({
        signal_id: rule.id,
        status: "skip",
        weight: 0,
        message: signal.detail ?? "Not evaluable, so it was not scored.",
      });
      continue;
    }

    possible += rule.weight;
    if (passed) {
      earned += rule.weight;
      reasons.push({
        signal_id: rule.id,
        status: "pass",
        weight: rule.weight,
        message: rule.onPass,
      });
    } else {
      reasons.push({
        signal_id: rule.id,
        status: rule.severity,
        weight: rule.weight,
        message: rule.onFail,
      });
    }
  }

  const totalWeight = V1_RULES.reduce((sum, r) => sum + r.weight, 0);
  const coverage = possible / totalWeight;
  const raw = possible === 0 ? 0 : Math.round((earned / possible) * 100);

  let band = bandFor(raw);
  if (coverage < V1_COVERAGE_FLOOR) {
    if (band === "LOW") band = "MEDIUM";
    reasons.push({
      signal_id: "coverage",
      status: "skip",
      weight: 0,
      message: `Only ${Math.round(coverage * 100)}% of the available checks could be observed, so the band is held at ${band}.`,
    });
  }

  return {
    score: raw,
    band,
    score_version: CURRENT_SCORE_VERSION,
    confidence: options.confidence ?? "static_only",
    signals_evaluated: reasons.filter((r) => r.status !== "skip").length,
    reasons,
    methodology_url: `${options.methodologyBaseUrl ?? "https://tools.tx402.io/methodology"}?v=${CURRENT_SCORE_VERSION}`,
  };
}

/**
 * Recompute a score from `reasons[]` alone.
 *
 * This is the appeal mechanism made executable: if this does not reproduce
 * `risk.score` from the very same response, the score is not reproducible and
 * the claim in is false. The test suite asserts it for every
 * fixture, so the property cannot quietly stop holding.
 */
export function reproduceScore(reasons: RiskReason[]): number {
  const scored = reasons.filter((r) => r.status !== "skip");
  const possible = scored.reduce((sum, r) => sum + r.weight, 0);
  const earned = scored
    .filter((r) => r.status === "pass")
    .reduce((sum, r) => sum + r.weight, 0);
  return possible === 0 ? 0 : Math.round((earned / possible) * 100);
}

/** The published weight table, exported so its methodology test can diff it. */
export const V1_WEIGHTS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(V1_RULES.map((r) => [r.id, r.weight])),
);

export const V1_SEVERITIES: Readonly<Record<string, "fail" | "warn">> = Object.freeze(
  Object.fromEntries(V1_RULES.map((r) => [r.id, r.severity])),
);
