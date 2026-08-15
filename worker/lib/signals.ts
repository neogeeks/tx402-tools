/**
 * Signal extraction (SPEC §6).
 *
 * Signals are raw observations, not judgements. `score.ts` is a pure function
 * of them, and `spec/risk-score.md` publishes what each one is worth. Keeping
 * the two apart is what makes a score appealable: a merchant can be handed the
 * signals and re-derive the number themselves.
 *
 * ── The rule that keeps this honest (SPEC §6.3) ────────────────────────────
 *
 * `observed: false` with `value: null` means **we could not determine it**, and
 * such a signal contributes nothing — it does not push a score down. The
 * alternative, treating unknown as bad, makes every brand-new endpoint look
 * suspicious, which is both wrong and the fastest way to make the tool useless.
 * Every `null` returned from here is a deliberate "we did not see", never a
 * shorthand for "no".
 *
 * ── Designed for the signals that are not here yet ──────────────────────────
 *
 * SPEC §6.2 lists the historical signals that arrive with the corpus:
 * `first_seen_age_days`, `scan_count`, `availability_30d`, `latency_p50_ms`,
 * `price_changes_90d`, `recipient_changes_90d`, `recipient_unstable_undeclared`
 * and `terms_changed_within_24h`. They are additive here: `extractSignals`
 * takes an optional `history` argument and emits them as unobserved when it is
 * absent. The crawler fills that argument in and **bumps `score_version`** (SPEC §7); no
 * caller of this module changes shape.
 */

import type { ProbeResult, Requirement } from "./probe.js";
import {
  MAX_AUTHORIZATION_SECONDS,
  isCanonicalAtomic,
  // `probe.ts` owns the address grammar, so there is exactly one definition of
  // "a well-formed recipient" in the repo.
  isWellFormedRecipient,
} from "./probe.js";

/** SPEC §4.4. */
export interface Signal {
  id: string;
  value: boolean | number | string | null;
  observed: boolean;
  detail: string | null;
}

/** Every v1 signal id, in the order SPEC §6.1 lists them. */
export const V1_SIGNAL_IDS = [
  "probe_ok",
  "challenge_served",
  "challenge_decodes",
  "wire_form",
  "x402_version",
  "tls_ok",
  "tls_protocol",
  "redirect_count",
  "redirect_scheme_downgrade",
  "resource_origin_match",
  "network_recognized",
  "asset_recognized",
  "facilitator_known",
  "amount_canonical",
  "amount_magnitude_band",
  "pay_to_wellformed",
  "pay_to_declared_dynamic",
  "timeout_sane",
  "scheme_known",
  "requirement_count",
  "challenge_size_bytes",
] as const;

export type V1SignalId = (typeof V1_SIGNAL_IDS)[number];

/** SPEC §6.2 — extracted, declared here so the interface is stable. */
export const V2_SIGNAL_IDS = [
  "first_seen_age_days",
  "scan_count",
  "availability_30d",
  "latency_p50_ms",
  "price_changes_90d",
  "recipient_changes_90d",
  "recipient_unstable_undeclared",
  "terms_changed_within_24h",
] as const;

export type V2SignalId = (typeof V2_SIGNAL_IDS)[number];

/**
 * What the crawler passes in. Every field optional and every absent field emitted as
 * unobserved, so the corpus can fill in one signal at a time.
 */
export interface HistoryInput {
  first_seen_age_days?: number | null;
  scan_count?: number | null;
  availability_30d?: number | null;
  latency_p50_ms?: number | null;
  price_changes_90d?: number | null;
  recipient_changes_90d?: number | null;
  /**
   * SPEC §6.4, and the one signal with a frozen definition:
   * `(recipient changed across scans) AND NOT pay_to_declared_dynamic`.
   * A bare "recipient changed" is forbidden in every version. the crawler computes this;
   * it is never derived here, because the historical half does not exist yet.
   */
  recipient_unstable_undeclared?: boolean | null;
  terms_changed_within_24h?: boolean | null;
}

export interface SignalContext {
  /** The facilitator list (`worker/lib/facilitators.ts`), already loaded. */
  knownFacilitators?: ReadonlySet<string>;
  /** Payment schemes tx402 can actually route. */
  knownSchemes?: ReadonlySet<string>;
  history?: HistoryInput;
}

const DEFAULT_SCHEMES: ReadonlySet<string> = new Set(["exact"]);

function signal(
  id: string,
  value: boolean | number | string | null,
  detail: string | null = null,
): Signal {
  return { id, value, observed: value !== null, detail };
}

/** An explicitly unobserved signal — the shape SPEC §6.3 requires. */
function unobserved(id: string, detail: string): Signal {
  return { id, value: null, observed: false, detail };
}

// ── amount magnitude bands ────────────────────────────────────────────────
// Published bands rather than the raw number, because the raw amount is already
// in `terms` and a band is what a *score* can defensibly use. Thresholds are in
// whole units of the asset, and an unknown `decimals` means an unknown band —
// not a guessed one.

export type MagnitudeBand = "micro" | "small" | "medium" | "large" | "extreme" | "unknown";

export function magnitudeBand(
  amountAtomic: string | null,
  decimals: number | null,
): MagnitudeBand {
  if (!amountAtomic || decimals === null) return "unknown";
  const units = Number(amountAtomic) / 10 ** decimals;
  if (!Number.isFinite(units)) return "unknown";
  if (units < 0.01) return "micro";
  if (units < 1) return "small";
  if (units < 10) return "medium";
  if (units < 100) return "large";
  return "extreme";
}

// ── origin comparison ─────────────────────────────────────────────────────

/**
 * The challenge's `resource` must point at the endpoint that served it.
 * A mismatch means the 402 is describing somebody else's resource, which is the
 * shape of a redirection-to-attacker-payment bug.
 */
export function originsMatch(resource: string | null, probedOrigin: string): boolean | null {
  if (!resource) return null;
  try {
    return new URL(resource).origin === probedOrigin;
  } catch {
    return false;
  }
}

// ── facilitator ───────────────────────────────────────────────────────────

/**
 * "Known facilitator" means exactly "its origin is on the published list". Compared by origin so a
 * path or a trailing slash cannot change the answer.
 */
export function facilitatorKnown(
  facilitator: string | null,
  known: ReadonlySet<string> | undefined,
): boolean | null {
  if (!facilitator) return null;
  if (!known || known.size === 0) return null;
  try {
    return known.has(new URL(facilitator).origin.toLowerCase());
  } catch {
    return false;
  }
}

// ── extraction ────────────────────────────────────────────────────────────

/**
 * The requirement a report speaks about when a challenge offers several.
 * First-listed wins: the x402 server states its preference by ordering, and
 * inventing our own selection rule here would mean scoring terms the buyer may
 * never be offered.
 */
export function primaryRequirement(result: ProbeResult): Requirement | null {
  return result.challenge.accepts[0] ?? result.observed_terms[0] ?? null;
}

/**
 * Extract the v1 signal set from one probe result.
 *
 * Static only — every value here comes from a single observation, which is why
 * scoring can run on a first-ever scan. `context.history` is the seam for the corpus.
 */
export function extractSignals(
  result: ProbeResult,
  context: SignalContext = {},
): Signal[] {
  const { challenge, probe: meta } = result;
  const requirement = primaryRequirement(result);
  const schemes = context.knownSchemes ?? DEFAULT_SCHEMES;

  const probeOk = meta.http_status !== null;
  const challengeServed = challenge.wire_form !== "none";

  const signals: Signal[] = [
    signal("probe_ok", probeOk),
    signal("challenge_served", challengeServed),
    signal(
      "challenge_decodes",
      challengeServed ? challenge.valid : null,
      // The decoder's own message, not just its code. It carries the reason and
      // the JSON path of the offending member (`/accepts/12`), which is the
      // difference between "this endpoint is broken" and "requirement 12 of 13
      // names a network tx402 cannot parse". A real production endpoint fails
      // here for exactly that reason, and an operator cannot act on a bare code.
      challengeServed
        ? (challenge.decode_error?.message ?? challenge.decode_error?.code ?? null)
        : "No challenge was served.",
    ),
    signal("wire_form", challenge.wire_form),
    challenge.x402_version === null
      ? unobserved("x402_version", "The challenge declared no version.")
      : signal("x402_version", challenge.x402_version),
    signal("tls_ok", meta.tls?.ok ?? null),
    meta.tls?.protocol
      ? signal("tls_protocol", meta.tls.protocol)
      : unobserved(
          "tls_protocol",
          "The negotiated TLS version is not exposed to the probe.",
        ),
    signal("redirect_count", meta.redirect_count),
    // The guard refuses a cross-scheme redirect outright, so a result that
    // exists at all never downgraded. Reported as an observed false rather than
    // omitted, because "we checked and it did not happen" is the useful fact.
    signal("redirect_scheme_downgrade", false, "Cross-scheme redirects are refused."),
  ];

  // ── challenge-derived signals ──
  if (!requirement) {
    const reason = challengeServed
      ? "The challenge could not be parsed into requirements."
      : "No challenge was served.";
    signals.push(
      unobserved("resource_origin_match", reason),
      unobserved("network_recognized", reason),
      unobserved("asset_recognized", reason),
      unobserved("facilitator_known", reason),
      unobserved("amount_canonical", reason),
      signal("amount_magnitude_band", "unknown", reason),
      unobserved("pay_to_wellformed", reason),
      unobserved("pay_to_declared_dynamic", reason),
      unobserved("timeout_sane", reason),
      unobserved("scheme_known", reason),
    );
  } else {
    const originMatch = originsMatch(requirement.resource, result.target.origin);
    const known = facilitatorKnown(requirement.facilitator, context.knownFacilitators);

    signals.push(
      originMatch === null
        ? unobserved(
            "resource_origin_match",
            "The challenge declared no resource URL.",
          )
        : signal("resource_origin_match", originMatch),
      requirement.network_recognized === null
        ? unobserved("network_recognized", "The challenge declared no network.")
        : signal(
            "network_recognized",
            requirement.network_recognized,
            "Recognized means present in the tx402 signed release manifest.",
          ),
      requirement.asset === null
        ? unobserved("asset_recognized", "The challenge declared no asset.")
        : signal(
            "asset_recognized",
            requirement.asset.recognized,
            "Recognized means present in the tx402 signed release manifest.",
          ),
      known === null
        ? unobserved(
            "facilitator_known",
            requirement.facilitator
              ? "The published facilitator list was not available."
              : "The challenge named no facilitator.",
          )
        : signal(
            "facilitator_known",
            known,
            "On the published list. That is the whole claim.",
          ),
      requirement.amount_raw === null
        ? unobserved("amount_canonical", "The challenge declared no amount.")
        : signal(
            "amount_canonical",
            isCanonicalAtomic(requirement.amount_raw),
            requirement.amount_atomic === null
              ? `Amount "${requirement.amount_raw}" is not a canonical atomic integer.`
              : null,
          ),
      signal(
        "amount_magnitude_band",
        magnitudeBand(requirement.amount_atomic, requirement.asset?.decimals ?? null),
      ),
      requirement.pay_to === null
        ? unobserved("pay_to_wellformed", "The challenge declared no recipient.")
        : signal(
            "pay_to_wellformed",
            isWellFormed(requirement),
          ),
      requirement.pay_to_dynamic === null
        ? unobserved(
            "pay_to_declared_dynamic",
            "No declaration surface was present.",
          )
        : signal(
            "pay_to_declared_dynamic",
            requirement.pay_to_dynamic,
            requirement.pay_to_dynamic
              ? "The recipient is a role constant, not a fixed address."
              : null,
          ),
      requirement.max_timeout_seconds === null
        ? unobserved("timeout_sane", "The challenge declared no authorization window.")
        : signal(
            "timeout_sane",
            requirement.max_timeout_seconds > 0 &&
              requirement.max_timeout_seconds <= MAX_AUTHORIZATION_SECONDS,
            requirement.max_timeout_seconds > MAX_AUTHORIZATION_SECONDS
              ? `Authorization window ${requirement.max_timeout_seconds}s exceeds the tx402 maximum of ${MAX_AUTHORIZATION_SECONDS}s.`
              : null,
          ),
      requirement.scheme === null
        ? unobserved("scheme_known", "The challenge declared no scheme.")
        : signal("scheme_known", schemes.has(requirement.scheme)),
    );
  }

  signals.push(
    signal("requirement_count", challenge.requirement_count),
    challenge.raw_bytes === null
      ? unobserved("challenge_size_bytes", "Nothing was read from the endpoint.")
      : signal("challenge_size_bytes", challenge.raw_bytes),
  );

  // ── v2 / historical (SPEC §6.2) ──
  // Always emitted, always unobserved until the corpus supplies them. Emitting them as
  // explicit unknowns rather than omitting them means the response shape does
  // not change when the corpus arrives, and a reader can see what we did not
  // know rather than having to notice an absence.
  signals.push(...historicalSignals(context.history));

  return signals;
}

function isWellFormed(requirement: Requirement): boolean {
  if (!requirement.pay_to) return false;
  // A declared role constant is legitimately not an address (SPEC §6.4), so it
  // must not be reported as a malformed recipient.
  if (requirement.pay_to_dynamic === true) return true;
  return isWellFormedRecipient(requirement.pay_to, requirement.network);
}

const HISTORY_ABSENT = "No history yet.";

export function historicalSignals(history: HistoryInput | undefined): Signal[] {
  const pick = (id: V2SignalId, value: number | boolean | null | undefined): Signal =>
    value === null || value === undefined
      ? unobserved(id, HISTORY_ABSENT)
      : signal(id, value);

  return [
    pick("first_seen_age_days", history?.first_seen_age_days),
    pick("scan_count", history?.scan_count),
    pick("availability_30d", history?.availability_30d),
    pick("latency_p50_ms", history?.latency_p50_ms),
    pick("price_changes_90d", history?.price_changes_90d),
    pick("recipient_changes_90d", history?.recipient_changes_90d),
    pick("recipient_unstable_undeclared", history?.recipient_unstable_undeclared),
    pick("terms_changed_within_24h", history?.terms_changed_within_24h),
  ];
}

/** Convenience for `score.ts` and for tests that assert on one signal. */
export function signalMap(signals: Signal[]): Map<string, Signal> {
  return new Map(signals.map((s) => [s.id, s]));
}
