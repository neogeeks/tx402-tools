/**
 * Reconstructing the lifecycle.
 *
 * The sequence is the SDK's, from docs.tx402.io/guides/lifecycle/:
 *
 *   capture body → send → 402 → decode → normalize → POLICY → plan routes →
 *   RESERVE → sign → EXPOSE fence → retry once → read settlement → COMMIT
 *
 * SPEC §5.7 names eight phases, so those thirteen steps fold onto eight. The
 * fold is the only piece of judgement in this file and it is written out here
 * rather than inferred:
 *
 *   discover capture the body, send the unpaid request, receive the 402
 *   decode strict decode + normalize (SDK phase `parse`)
 *   policy domain → network → scheme/asset → per-request → per-hour
 *   route plan routes, read balances, rank candidates
 *   authorize RESERVE → sign → EXPOSE fence (SDK phase `sign`)
 *   submit the paid retry going on the wire (SDK phase `retry`)
 *   settle read the settlement response (SDK phase `complete`)
 *   deliver the resource arriving, and COMMIT
 *
 * `authorize` deliberately spans all three of reserve, sign and fence: they are
 * one atomic "money can now move" step from a debugger's point of view, and
 * splitting them would invite a reader to think a call could stop between the
 * fence and the wire. It cannot — that is the point of the fence.
 *
 * The SDK's `complete` covers both `settle` and `deliver`, so the mapping is
 * many-to-one in that direction. That is exactly the mismatch SPEC §5.7
 * anticipated when it constrained the phase *shape* rather than its membership.
 */

import { PHASES } from "./types.js";
import type { Disposition, LifecycleStep, Phase, RedactedTrace } from "./types.js";
import type { StopPoint } from "./taxonomy.js";

/** Human labels for each phase, used by the renderer and the step details. */
export const PHASE_LABELS: Record<Phase, string> = {
  discover: "Send the request and read the 402",
  decode: "Decode and normalize the challenge",
  policy: "Evaluate policy",
  route: "Plan routes",
  authorize: "Reserve, sign and raise the EXPOSE fence",
  submit: "Transmit the paid retry",
  settle: "Read the settlement response",
  deliver: "Receive the resource",
};

const indexOfPhase = (phase: Phase): number => PHASES.indexOf(phase);

/**
 * Build the eight-step lifecycle for one stop point.
 *
 * The rules, in order of application:
 *
 *  1. A phase before the stop ran and succeeded — you cannot reach the stop
 *     without it. It is `ok`.
 *  2. The stop phase is `fail`, except where the money is exposed: an exposed
 *     reservation means the transmit may well have succeeded, and `fail` would
 *     assert something the trace does not establish. It is `unknown`.
 *  3. A phase after the stop is `skip` — it never ran. `skip` is not `fail`.
 *  4. Exposure overrides rule 3 for the two phases that follow `submit`:
 *     `settle` is `unknown`, because we genuinely do not know; `deliver` is
 *     `fail`, because whatever else is uncertain, the resource did not arrive.
 *  5. A released delivery failure means settlement did not succeed, so `settle`
 *     is `fail` rather than `ok` — rule 1 would otherwise call it a success on
 *     the way to a failure.
 */
export function buildLifecycle(
  trace: RedactedTrace,
  stop: StopPoint | null,
  disposition: Disposition,
): LifecycleStep[] {
  // A call that never saw a 402 never entered the payment path at all. Steps 3
  // onward do not happen, and reporting them as failures would invent a
  // payment problem where there was none.
  if (stop === null && trace.sawChallenge === false) {
    return PHASES.map((phase) => ({
      phase,
      status: phase === "discover" || phase === "deliver" ? "ok" : "skip",
      at: trace.timestamps?.[phase] ?? null,
      detail:
        trace.notes?.[phase] ??
        (phase === "decode"
          ? "The endpoint did not answer 402, so no payment was attempted."
          : null),
    }));
  }

  // No error and a challenge was seen: the happy path, all twelve steps.
  if (stop === null) {
    return PHASES.map((phase) => ({
      phase,
      status: "ok",
      at: trace.timestamps?.[phase] ?? null,
      detail: trace.notes?.[phase] ?? null,
    }));
  }

  const stopAt = indexOfPhase(stop.phase);
  const exposed = disposition === "exposed";

  return PHASES.map((phase, index): LifecycleStep => {
    const at = trace.timestamps?.[phase] ?? null;
    const note = trace.notes?.[phase] ?? null;

    if (index < stopAt) {
      // Rule 5 — a released delivery failure did not settle.
      if (phase === "settle" && disposition === "released" && stop.phase === "deliver") {
        return {
          phase,
          status: "fail",
          at,
          detail: note ?? "No successful settlement was reported.",
        };
      }
      return { phase, status: "ok", at, detail: note };
    }

    if (index === stopAt) {
      return {
        phase,
        status: exposed ? "unknown" : "fail",
        at,
        detail: note ?? stopDetail(stop, exposed),
      };
    }

    // Rule 4 — after an exposure the outcome is genuinely unknown, and only
    // the delivery is certain.
    if (exposed && phase === "settle") {
      return {
        phase,
        status: "unknown",
        at,
        detail: note ?? "No settlement response was read, so the outcome is not known.",
      };
    }
    if (exposed && phase === "deliver") {
      return { phase, status: "fail", at, detail: note ?? "The resource was not delivered." };
    }

    return { phase, status: "skip", at: null, detail: note };
  });
}

function stopDetail(stop: StopPoint, exposed: boolean): string {
  if (exposed) {
    return "The authorization was transmitted and no usable settlement response came back.";
  }
  return `Stopped here: ${stop.code}.`;
}
