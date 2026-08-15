/**
 * The exit-code table for the whole CLI.
 *
 * ── One table, not five ────────────────────────────────────────────────────
 *
 * `src/replay/taxonomy.ts` already has an `EXIT` map, and it is the SDK's own
 * `EXIT_CODE_BY_ERROR` reproduced, so that `if [ $? -eq 8 ]` means the same
 * thing in the script that replays a trace as in the script that produced it.
 * Every other verb reuses those numbers rather than inventing a second
 * vocabulary — a CLI whose `verify` and whose `replay` disagree about what 5
 * means is worse than one that has no codes at all.
 *
 * | code | name | when |
 * | ---- | ----------------- | ---- |
 * |  0   | success | the command answered and nothing it checked failed |
 * |  2   | usage | bad arguments, unreadable input, or a URL this CLI refuses |
 * |  3   | policy | replay: a policy stage stopped the call |
 * |  4   | liquidity | replay: insufficient balance |
 * |  5   | protocol | a challenge tx402 would refuse — `verify` verdict `fail`, `inspect` on an endpoint that
 * serves no decodable challenge |
 * |  6   | signer | replay: the signer failed |
 * |  7   | transport | the endpoint, or the hosted API, could not be reached |
 * |  8   | ambiguous payment | **`do_not_retry`** — money may have moved. Retrying can pay twice |
 * |  9   | resource failure | replay: paid, and the resource still did not arrive |
 *
 * ── Two rules that keep the table honest ───────────────────────────────────
 *
 * 1. **8 is never produced by anything but a real ambiguity.** its whole
 *    session turns on it, and a tool that cries wolf buries the one case that
 *    matters. `replay` is the only verb that can emit it, and only from
 *    `disposition === "exposed" | "committed"`.
 * 2. **The exit code never encodes a risk band.** `LOW/MEDIUM/HIGH` describes
 *    the confidence of our observations, not the merchant's character, and turning it into a CI failure would turn
 * a
 *    deliberately non-judgemental signal into a judgement. A HIGH band on a
 *    challenge that decodes exits 0.
 */

import { EXIT as REPLAY_EXIT } from "./replay/taxonomy.js";

/**
 * The single table. Built from the replay map rather than re-declared, so the
 * two cannot drift: adding a code here that `taxonomy.ts` does not have is a
 * compile error, and changing one there changes it here.
 */
export const EXIT = {
  success: REPLAY_EXIT.success,
  usage: REPLAY_EXIT.usage,
  policy: REPLAY_EXIT.policy,
  liquidity: REPLAY_EXIT.liquidity,
  protocol: REPLAY_EXIT.protocol,
  signer: REPLAY_EXIT.signer,
  transport: REPLAY_EXIT.transport,
  ambiguousPayment: REPLAY_EXIT.ambiguousPayment,
  resourceFailure: REPLAY_EXIT.resourceFailure,
} as const;

export type ExitName = keyof typeof EXIT;

/** Human labels, printed by `tx402-tools --help` and asserted by the tests. */
export const EXIT_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: "success",
  2: "usage",
  3: "policy",
  4: "liquidity",
  5: "protocol",
  6: "signer",
  7: "transport",
  8: "ambiguous payment — do not retry",
  9: "resource failure",
});

/**
 * The guard's error codes, mapped onto the table.
 *
 * A URL we refuse to fetch is a **usage** failure: the argument is the thing
 * to change, and for a private address `--allow-private` is exactly the change
 * (see `src/net/fetch.ts`). A URL we tried and could not reach is
 * **transport**. Keeping those apart is what lets CI tell "you pointed me
 * somewhere I will not go" from "the endpoint is down".
 */
export function exitForErrorCode(code: string): number {
  switch (code) {
    case "VALIDATION_FAILED":
    case "BAD_REQUEST":
    case "URL_SCHEME_NOT_ALLOWED":
    case "URL_USERINFO_PRESENT":
    case "URL_BLOCKED":
    case "URL_PRIVATE_ADDRESS":
    case "NOT_FOUND":
      return EXIT.usage;

    case "PROBE_TIMEOUT":
    case "PROBE_FAILED":
    case "TOO_MANY_REDIRECTS":
    case "RESPONSE_TOO_LARGE":
    case "RATE_LIMITED":
    case "TARGET_RATE_LIMITED":
    case "INTERNAL":
      return EXIT.transport;

    // SPEC §3.1's three HTTP-200 codes. An endpoint being broken is the answer
    // the user came for, so they are reported as results — but a challenge
    // tx402 cannot read is still a protocol failure for a script that was
    // about to pay it. `NO_DATA` is not: an empty corpus is a real answer.
    case "CHALLENGE_MALFORMED":
    case "NOT_X402":
      return EXIT.protocol;
    case "NO_DATA":
      return EXIT.success;

    default:
      return EXIT.transport;
  }
}
