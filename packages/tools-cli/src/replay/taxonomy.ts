/**
 * The stop-point table: every tx402 error code mapped to where it stopped, what
 * happened to the money, which exit code a script sees, and which
 * docs.tx402.io page fixes it.
 *
 * `TX402_ERROR_CODES` is imported from the published `tx402` package rather
 * than copied, and `STOP_POINTS` is a `Record<Tx402ErrorCode, StopPoint>`, so
 * the table is **exhaustive by construction**: if the SDK adds an eighteenth
 * error code, this file stops compiling instead of silently classifying the new
 * code as an unknown stop. That is the same trick — and the same reason — as
 * the SDK's own `EXIT_CODE_BY_ERROR` in `src/cli/exit-codes.ts`.
 *
 * Two rows resist a static table and are resolved in `resolveStopPoint`
 * below, each for a reason the SDK documents explicitly:
 *
 *  1. `TX402_RESOURCE_DELIVERY` covers both halves of a range whose halves want
 *     opposite actions. `context.paid === false` means no money moved and
 *     retrying is safe; `true` means it settled and retrying can pay twice.
 *     The SDK's CLI "branches on `paid`, never on the exit code" and so does
 *     this.
 *  2. `TX402_TRANSPORT` can be raised before the request goes out or when the
 *     EXPOSE fence write itself fails. Both mean nothing was transmitted — the
 *     fence failing *aborts* the send — but they stop at different phases.
 */

import { TX402_ERROR_CODES } from "tx402";
import type { Tx402ErrorCode } from "tx402";
import type { Disposition, Phase } from "./types.js";

const DOCS = "https://docs.tx402.io";

/** The nine CLI exit codes (SDK SPEC §11, mirrored from `src/cli/exit-codes.ts`). */
export const EXIT = {
  success: 0,
  usage: 2,
  policy: 3,
  liquidity: 4,
  protocol: 5,
  signer: 6,
  transport: 7,
  ambiguousPayment: 8,
  resourceFailure: 9,
} as const;

export interface StopPoint {
  /** Where in the canonical eight-phase vocabulary the call stopped. */
  phase: Phase;
  /** Where the money ended up. The sole input to `do_not_retry`. */
  disposition: Disposition;
  /** The exit code a shell script sees. */
  exit: number;
  /** The docs page that explains what to change. */
  docs: string;
  /** Our short diagnosis code (SPEC §5.7 constrains the shape, not the set). */
  code: string;
  title: string;
  explanation: string;
  guidance: string;
}

/**
 * The reconciliation procedure, taken from
 * docs.tx402.io/operations/exposed-reconciliation/.
 *
 * This is the highest-risk string in the session. Getting it backwards causes
 * double payments, so it is written once, here, and every ambiguous outcome
 * points at it.
 */
export const DO_NOT_RETRY_GUIDANCE = [
  "Do not retry this request.",
  "The merchant may hold a valid authorization, and a retry can pay twice.",
  "",
  "The reservation is now exposed: tx402 recorded a durable fence before the authorization went on the wire, and an exposed reservation never expires. It keeps consuming both the per-hour window and the cumulative ceiling until an operator resolves it. That is deliberate — holding budget for a payment that may have settled is the conservative direction — and the price of it is one manual task.",
  "",
  "Reconcile it:",
  "  1. `tx402 budget <host> --network <network>` — a non-zero exposedAtomic is your signal that reconciliation is due.",
  "  2. `store.listExposed({ policyScope, assetId, nowEpochMs })` enumerates every unresolved exposure for that scope and asset. Each carries the { reservationId, policyScope, assetId } ref you resolve by. Python: `store.list_exposed(...)`.",
  "  3. Check the chain — the payer address, and the merchant's settlement identifier if you captured one — to establish whether the money actually moved.",
  "  4. `admin.resolveExposed(ref, 'committed', Date.now())` if it settled, or `admin.resolveExposed(ref, 'released', Date.now())` if you have confirmed no transfer. Use 'released' only when you have confirmed no transfer.",
  "",
  "Resolving an already-terminal reservation is not a silent no-op: every store refuses it with `reservation-already-terminal`. A retried reconciliation script must catch that refusal and treat it as already handled.",
  "",
  "There is no `tx402 resolve-exposed` verb, deliberately: resolving an exposure is a judgement about whether money moved, and that belongs in a reviewed script or an operator console with the chain data in front of you.",
].join("\n");

/**
 * `details.reservationExpiresAtEpochMs` is not a deadline, and the name
 * misleads. It is the reservation's pre-fence 120-second TTL, retained as
 * informational context — which is why it reads as a timestamp already in the
 * past. An exposed hold does not expire when it passes, or ever.
 */
export const EXPIRY_IS_NOT_A_DEADLINE =
  "details.reservationExpiresAtEpochMs is not a deadline. It is the reservation's original pre-fence TTL, kept as context; the EXPOSE fence removed the expiry. Do not wait for it to lapse — it will not.";

/** Guidance for a settled payment whose resource never arrived. */
export const PAID_NOT_DELIVERED_GUIDANCE = [
  "Do not retry this request.",
  "The payment settled — the merchant's own settlement response reported success — so the money has moved and retrying buys the same resource twice.",
  "",
  "Settlement evidence outranks the status line: whatever the merchant answered with, a successful settlement in its payment response means the spend is committed and context.paid is true.",
  "",
  "This is a delivery dispute, not a payment failure. Take it up with the merchant with the settlement identifier in hand. If your own spend store rejected the commit, the reservation is exposed rather than committed and also needs reconciling.",
].join("\n");

/** Guidance for a refusal that took no money. */
export const NOT_PAID_GUIDANCE = [
  "Retrying is safe. No money moved.",
  "The merchant either refused the settlement or reported success: false, and tx402 released the reservation — nothing settled, so holding budget would be wrong.",
].join("\n");

/**
 * Every code in the SDK's frozen taxonomy.
 *
 * Phases are the SDK's `Tx402Phase` mapped onto SPEC §5.7's vocabulary; the
 * mapping is in `lifecycle.ts` and written out.
 */
export const STOP_POINTS: Record<Tx402ErrorCode, StopPoint> = {
  [TX402_ERROR_CODES.configInvalid]: {
    phase: "discover",
    disposition: "none",
    exit: EXIT.usage,
    docs: `${DOCS}/reference/configuration/`,
    code: "CONFIG_INVALID",
    title: "The client was configured invalidly",
    explanation:
      "TX402_CONFIG_INVALID is raised synchronously from createTx402Client, before any request is sent. Nothing was requested and no money was involved.",
    guidance:
      "Fix the configuration named in details.configPath and run the call again.",
  },

  [TX402_ERROR_CODES.reservedHeader]: {
    phase: "discover",
    disposition: "none",
    exit: EXIT.usage,
    docs: `${DOCS}/reference/errors/`,
    code: "RESERVED_HEADER",
    title: "The call supplied a protocol-owned header",
    explanation:
      "TX402_RESERVED_HEADER is raised before the first request. tx402 owns the x402 headers on the paid retry, so a caller-supplied one is refused rather than overwritten.",
    guidance:
      "Remove the header named in details.headerName from the request and call again. Nothing was sent and no money was involved.",
  },

  [TX402_ERROR_CODES.nonReplayable]: {
    phase: "discover",
    disposition: "none",
    exit: EXIT.usage,
    docs: `${DOCS}/guides/lifecycle/#replayable-bodies`,
    code: "BODY_NOT_REPLAYABLE",
    title: "The request body cannot be replayed on the paid retry",
    explanation:
      "TX402_NON_REPLAYABLE is raised before the first request, not after. A paid call may send the body twice — once unpaid, once paid — and a stream cannot be replayed, so tx402 refuses upfront rather than consuming the stream and failing confusingly on the retry.",
    guidance:
      "Pass a bodyFactory that can produce the body again, or hand tx402 a string, a Uint8Array or a plain object. Nothing was sent and no money was involved.",
  },

  [TX402_ERROR_CODES.protocolUnsupported]: {
    phase: "decode",
    disposition: "none",
    exit: EXIT.protocol,
    docs: `${DOCS}/reference/errors/`,
    code: "PROTOCOL_UNSUPPORTED",
    title: "The merchant offered an x402 version this build does not implement",
    explanation:
      "TX402_PROTOCOL_UNSUPPORTED. The challenge decoded far enough to read its version and this client does not speak it. details.observedVersion and details.supportedVersions say which.",
    guidance:
      "Nothing you change locally makes this call work: either the merchant or the SDK has to move. No reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.paymentRequiredInvalid]: {
    phase: "decode",
    disposition: "none",
    exit: EXIT.protocol,
    docs: `${DOCS}/reference/errors/`,
    code: "CHALLENGE_REJECTED",
    title: "The 402 challenge failed strict decoding",
    explanation:
      "TX402_PAYMENT_REQUIRED_INVALID. The decoder enforces size, nesting depth, duplicate keys, a requirement ceiling and an origin binding, and this challenge broke one of them. details.reason and details.schemaPath name which.",
    guidance:
      "This is the merchant's challenge to fix. The refusal happened before policy, so no reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.clockSkew]: {
    phase: "decode",
    disposition: "none",
    exit: EXIT.protocol,
    docs: `${DOCS}/reference/errors/`,
    code: "CLOCK_SKEW",
    title: "The local clock is too far from the challenge's own timestamp",
    explanation:
      "TX402_CLOCK_SKEW is raised while validating the challenge's timestamp, alongside the other challenge-validation failures. tx402 never adjusts the clock for you.",
    guidance:
      "Correct the local clock — details.observedSkewMs against details.thresholdMs — and call again. No reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.policyDomain]: {
    phase: "policy",
    disposition: "none",
    exit: EXIT.policy,
    docs: `${DOCS}/guides/policy/`,
    code: "POLICY_REFUSED_DOMAIN",
    title: "Your policy does not allow paying this host",
    explanation:
      "TX402_POLICY_DOMAIN. The normalized host in details.normalizedHost is not in policy.allowedDomains. Policy runs before routing and before the signer, so this cost zero signatures — the signer was never called and a hardware wallet never prompted.",
    guidance:
      "Add the host to allowedDomains if you meant to pay it, or accept the refusal. No reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.policyBudget]: {
    phase: "policy",
    disposition: "none",
    exit: EXIT.policy,
    docs: `${DOCS}/guides/policy/`,
    code: "POLICY_REFUSED_BUDGET",
    title: "The price is over a cap you configured",
    explanation:
      "TX402_POLICY_BUDGET. details.capKind says which cap — per-request, per-hour or cumulative — and details carries the requested, cap, committed and reserved atomic amounts. Policy is evaluated locally and before any signer or balance call, so this cost zero signatures.",
    guidance:
      "Raise the cap or accept the refusal. No reservation was taken and no money was involved. If capKind is cumulative and the figure looks too high, check for exposed reservations — an unresolved exposed payment keeps consuming the ceiling until an operator reconciles it.",
  },

  [TX402_ERROR_CODES.spendFrozen]: {
    // Raised authoritatively inside `reserve`, which is step 7 — the first
    // step of our `authorize` phase. It stops the call BEFORE the signer, so
    // the exit code is `policy` (3) even though the phase is `authorize`.
    phase: "authorize",
    disposition: "none",
    exit: EXIT.policy,
    docs: `${DOCS}/operations/kill-switch/`,
    code: "SPEND_FROZEN",
    title: "The kill switch refused the reservation",
    explanation:
      "TX402_SPEND_FROZEN. The store refused to reserve because details.frozenScope is frozen — either this scope, or the whole store when the value is the sentinel '*'. This is a stop-future-authorization control, never a rollback, and it is refused by the store rather than by the caller, so a compromised client cannot relax it.",
    guidance:
      "Unfreeze the scope if the freeze is stale, or leave it in place. The reservation was refused, so no authorization was produced and no money was involved.",
  },

  [TX402_ERROR_CODES.recipientUnpinned]: {
    // Also raised inside `reserve`. Same phase/exit split as spendFrozen.
    phase: "authorize",
    disposition: "none",
    exit: EXIT.policy,
    docs: `${DOCS}/operations/recipient-rotation/`,
    code: "RECIPIENT_NOT_PINNED",
    title: "The reservation was refused because the recipient is not pinned",
    explanation:
      "TX402_RECIPIENT_UNPINNED. details.reason is one of not-allowlisted, pin-mismatch or assertion-required. The check is authoritative in reserve and driven by the store's administered pin record, so it happens before the signer is reachable.",
    guidance:
      "Confirm the recipient is the one you expect before pinning it — a pin-mismatch is exactly the signal this control exists to raise. No authorization was produced and no money was involved.",
  },

  [TX402_ERROR_CODES.schemeUnsupported]: {
    phase: "route",
    disposition: "none",
    exit: EXIT.protocol,
    docs: `${DOCS}/guides/routing/`,
    code: "NO_SUPPORTED_SCHEME",
    title: "No offered scheme and network pair is one this client can pay",
    explanation:
      "TX402_SCHEME_UNSUPPORTED means nothing was even attempted — there was no signer for any chain the merchant offered. It is deliberately a different error from TX402_LIQUIDITY, which means everything was attempted and fell short; reporting this one as that sends you to fund a wallet that was never the problem.",
    guidance:
      "Configure a signer for one of the networks in details.offeredNetworks. No reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.liquidity]: {
    phase: "route",
    disposition: "none",
    exit: EXIT.liquidity,
    docs: `${DOCS}/guides/routing/`,
    code: "NO_VIABLE_ROUTE",
    title: "Every offered route was attempted and none had the balance",
    explanation:
      "TX402_LIQUIDITY. Balances were read for each candidate and details.deficits carries the shortfall per network. Unlike TX402_SCHEME_UNSUPPORTED, the routes existed — they were just short.",
    guidance:
      "Fund one of the networks in details.deficits and call again. No reservation was taken and no money was involved.",
  },

  [TX402_ERROR_CODES.signer]: {
    phase: "authorize",
    disposition: "released",
    exit: EXIT.signer,
    docs: `${DOCS}/security/keys/`,
    code: "SIGNER_FAILED",
    title: "The signer refused, failed, or was unavailable",
    explanation:
      "TX402_SIGNER. A reservation had been taken by this point and was released, because the failure happened before anything went on the wire — nothing was transmitted, so nothing can have settled, and holding budget would be wrong. details.causeCategory is a coarse label by design: the signer's own message can embed key material.",
    guidance:
      "Check the signing device or credential named in details.signerKind, then call again. Nothing was transmitted and no money moved.",
  },

  [TX402_ERROR_CODES.transport]: {
    // Phase is refined in `resolveStopPoint` — see the note there.
    phase: "discover",
    disposition: "none",
    exit: EXIT.transport,
    docs: `${DOCS}/reference/errors/`,
    code: "TRANSPORT_FAILED",
    title: "The network failed before anything was transmitted",
    explanation:
      "TX402_TRANSPORT is the SDK's only automatically retryable error, and that is a statement about money: it is raised only where nothing can have settled. A network failure after the authorization is on the wire is not this error — it is TX402_PAYMENT_AMBIGUOUS.",
    guidance:
      "Retrying is safe. No money moved.",
  },

  [TX402_ERROR_CODES.paymentAmbiguous]: {
    phase: "submit",
    disposition: "exposed",
    exit: EXIT.ambiguousPayment,
    docs: `${DOCS}/operations/exposed-reconciliation/`,
    code: "AMBIGUOUS_PAYMENT",
    title: "The payment may have been authorized without the resource arriving",
    explanation:
      "TX402_PAYMENT_AMBIGUOUS. The authorization was transmitted and no usable settlement response came back — a timeout, a reset, a 5xx, or settlement metadata that would not decode. From the client's side there is no way to tell whether the merchant received and held a valid authorization or never received it at all. Both look identical from here, which is why context.paid is the third state, 'unknown', and not false.",
    guidance: DO_NOT_RETRY_GUIDANCE,
  },

  [TX402_ERROR_CODES.redirectBlocked]: {
    phase: "submit",
    disposition: "exposed",
    exit: EXIT.ambiguousPayment,
    docs: `${DOCS}/operations/exposed-reconciliation/`,
    code: "PAID_REDIRECT_BLOCKED",
    title: "A paid retry was redirected cross-origin and the outcome is unknown",
    explanation:
      "TX402_REDIRECT_BLOCKED. tx402 declined to follow a cross-origin redirect on the paid retry, and the block stops the follow-up request rather than the original one — so the authorization had already gone to details.fromOrigin and may have been honoured. context.paid is 'unknown' and the reservation is exposed. This is why the SDK maps this error to exit code 8, the ambiguous-payment code, and not to a transport or resource failure.",
    guidance: DO_NOT_RETRY_GUIDANCE,
  },

  [TX402_ERROR_CODES.resourceDelivery]: {
    // Both halves of a range. `resolveStopPoint` branches on `context.paid`
    // and replaces every field below except the phase.
    phase: "deliver",
    disposition: "released",
    exit: EXIT.resourceFailure,
    docs: `${DOCS}/guides/lifecycle/`,
    code: "NOT_DELIVERED",
    title: "The resource was not delivered",
    explanation:
      "TX402_RESOURCE_DELIVERY. Which half of this error you are looking at depends on context.paid, and the two halves want opposite actions.",
    guidance: NOT_PAID_GUIDANCE,
  },
};

/**
 * Resolve the static table against one trace.
 *
 * Everything a static table can say is already in `STOP_POINTS`. This function
 * exists for the two rows that a static table cannot express — and for nothing
 * else, so that the temptation to bury a special case in the renderer never
 * arises.
 */
export function resolveStopPoint(
  code: string | null | undefined,
  paid: boolean | "unknown" | null | undefined,
  sdkPhase: string | null | undefined,
): StopPoint | null {
  if (!code) return null;
  const base = STOP_POINTS[code as Tx402ErrorCode];
  if (!base) return null;

  // ── row 1: TX402_RESOURCE_DELIVERY branches on `paid`, never on the code ──
  // `paid: true`  — settlement succeeded and delivery then failed. The spend is
  //                 committed (or exposed, if your own ledger write failed).
  //                 Retrying is the one action that can pay twice.
  // `paid: false` — the merchant refused, or reported success: false. The
  //                 reservation was released. Retrying is safe.
  // The SDK emits a `settlement` object only in the first case, and its CLI
  // branches on `paid` rather than the exit code. So does this.
  if (code === TX402_ERROR_CODES.resourceDelivery) {
    if (paid === true) {
      return {
        ...base,
        disposition: "committed",
        code: "PAID_NOT_DELIVERED",
        title: "The payment settled and the resource still did not arrive",
        explanation:
          "TX402_RESOURCE_DELIVERY with context.paid true. Settlement evidence outranks the status line: the merchant's own settlement response reported success, so the money moved whatever the status code said, and the spend is committed. A settled payment whose ledger write then failed is still a settled payment — it is reported paid: true and left exposed.",
        guidance: PAID_NOT_DELIVERED_GUIDANCE,
      };
    }
    // `paid: "unknown"` never reaches here — that outcome is raised as
    // TX402_PAYMENT_AMBIGUOUS, not as a delivery failure. Treating an unknown
    // as "not paid" would be the exact inversion this change exists to avoid,
    // so it is refused rather than defaulted.
    if (paid === "unknown") {
      return {
        ...base,
        disposition: "exposed",
        exit: EXIT.ambiguousPayment,
        docs: `${DOCS}/operations/exposed-reconciliation/`,
        code: "AMBIGUOUS_PAYMENT",
        title: "The payment may have been authorized without the resource arriving",
        explanation:
          "TX402_RESOURCE_DELIVERY arrived carrying context.paid 'unknown'. Whatever produced it, an unknown outcome after transmission is an exposed reservation and is treated as one here — reporting it as a clean delivery failure would say no money moved, which is not something this trace establishes.",
        guidance: DO_NOT_RETRY_GUIDANCE,
      };
    }
    return {
      ...base,
      disposition: "released",
      code: "NOT_DELIVERED",
      title: "The resource was not delivered and nothing settled",
      explanation:
        "TX402_RESOURCE_DELIVERY with context.paid false. Either the merchant answered 4xx with no settlement response, or its settlement response reported success: false. Nothing settled, so tx402 released the reservation.",
      guidance: NOT_PAID_GUIDANCE,
    };
  }

  // ── row 2: TX402_TRANSPORT's phase depends on where it was raised ─────────
  // The default row assumes the unpaid request failed. The other case is the
  // EXPOSE fence write failing at step 9, which ABORTS the transmission — so
  // it is still "nothing moved", but it stopped at `authorize`, not at
  // `discover`, and saying `discover` would misplace it on the timeline.
  if (code === TX402_ERROR_CODES.transport && sdkPhase) {
    const phase = SDK_PHASE_TO_PHASE[sdkPhase];
    if (phase && phase !== base.phase) {
      return {
        ...base,
        phase,
        explanation:
          phase === "authorize"
            ? `${base.explanation} This one was raised at the EXPOSE fence: the durable write failed, so the request was not sent at all.`
            : base.explanation,
      };
    }
  }

  return base;
}

/**
 * The SDK's own `Tx402Phase` mapped onto SPEC §5.7's vocabulary.
 *
 * The SDK's taxonomy is coarser at the end — one `complete` covers reading the
 * settlement and delivering the resource — which is precisely why the schema
 * constrains the phase *shape* and not its membership. Recorded in.
 */
export const SDK_PHASE_TO_PHASE: Record<string, Phase> = {
  initial: "discover",
  parse: "decode",
  policy: "policy",
  route: "route",
  sign: "authorize",
  retry: "submit",
  complete: "settle",
};
