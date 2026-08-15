/**
 * The CLI's URL policy and its probe entry point.
 *
 * ── The one thing the hosted probe is forbidden from doing ─────────────────
 *
 * justifies a CLI on exactly one property: it can reach endpoints
 * the hosted Inspector must refuse. Two flags express that, and nothing else
 * about the probe differs — the guard, the redirect discipline, the byte caps,
 * the decoder and the report are the same code the Worker runs.
 *
 *   `http:`          on by default. `HOSTED_URL_POLICY` is `["https:"]` and
 *                    stays that way; a developer's dev server rarely has a
 *                    certificate, and refusing it makes the CLI useless for
 *                    the case it exists for.
 *   private space OFF by default, `--allow-private` to opt in. Off because
 *                    a CLI that reaches 169.254.169.254 by default is a
 *                    credential-exfiltration tool the first time somebody
 *                    pipes a URL into it from a file.
 *
 * Everything else the guard enforces still applies with the flag on: userinfo
 * is refused rather than stripped, redirects are capped at three and never
 * cross-scheme, the body cap aborts the read, and no credential is forwarded
 * because none is ever copied in.
 */

import { GUARD_LIMITS, HOSTED_URL_POLICY } from "../../../../worker/lib/guard.js";
import type { GuardResult, UrlPolicy } from "../../../../worker/lib/guard.js";
import { probe } from "../../../../worker/lib/probe.js";
import type { ProbeResult } from "../../../../worker/lib/probe.js";

import { nodeConnector } from "./connector.js";
import type { PinRecord } from "./connector.js";
import { nodeResolver } from "./resolver.js";

export { HOSTED_URL_POLICY };

export interface CliPolicyOptions {
  /** `--allow-private`. Off by default; see the note above. */
  allowPrivate?: boolean;
  /** `--no-http` narrows the CLI to the hosted probe's scheme list. */
  allowHttp?: boolean;
  /** `--timeout`, in milliseconds, applied as the total budget. */
  totalTimeoutMs?: number;
}

/**
 * The CLI's policy. Built rather than exported as a constant so that the two
 * differences from `HOSTED_URL_POLICY` are visible at the call site and in a
 * diff, which is the reason We made this a parameter in the first place.
 */
export function cliUrlPolicy(options: CliPolicyOptions = {}): UrlPolicy {
  const allowHttp = options.allowHttp !== false;
  return {
    allowedSchemes: allowHttp ? ["https:", "http:"] : ["https:"],
    allowPrivateAddresses: options.allowPrivate === true,
    limits: options.totalTimeoutMs
      ? {
          totalTimeoutMs: options.totalTimeoutMs,
          hopTimeoutMs: Math.min(GUARD_LIMITS.hopTimeoutMs, options.totalTimeoutMs),
        }
      : undefined,
  };
}

export interface CliProbeOptions extends CliPolicyOptions {
  /** `--insecure`: skip certificate validation. Your own dev server, nothing else. */
  insecure?: boolean;
  /** Injected by the tests. Defaults to the real, pinning Node stack. */
  resolver?: Parameters<typeof probe>[1]["resolver"];
  connector?: Parameters<typeof probe>[1]["connector"];
  now?: () => number;
}

export interface CliProbeOutcome {
  result: GuardResult<ProbeResult>;
  /** Every hop the connector pinned. Empty when a stub connector was injected. */
  pins: PinRecord[];
}

/**
 * Probe one URL with the CLI's policy.
 *
 * This calls `probe` from `worker/lib/probe.ts` — the same function the
 * hosted Inspector calls, through the same `guardedFetch`. There is no second
 * probe, no second decoder and no second wire-form classifier in this package,
 * which is what makes `tx402-tools inspect` and `/api/v1/inspect` answers
 * comparable rather than merely similar (SPEC §1.2).
 */
export async function cliProbe(
  rawUrl: string,
  options: CliProbeOptions = {},
): Promise<CliProbeOutcome> {
  const connector =
    options.connector ?? nodeConnector({ rejectUnauthorized: options.insecure !== true });
  const resolver = options.resolver ?? nodeResolver();

  const result = await probe(rawUrl, {
    policy: cliUrlPolicy(options),
    resolver,
    connector,
    ...(options.now ? { now: options.now } : {}),
  });

  const pins = "pins" in connector && Array.isArray(connector.pins) ? connector.pins : [];
  return { result, pins: pins as PinRecord[] };
}
