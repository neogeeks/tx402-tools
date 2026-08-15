/**
 * The client side of the ProbeLimiter.
 *
 * Routes call `withPoliteness` and never talk to the Durable Object directly,
 * so the "reserve → probe → record/release" sequence exists in exactly one
 * place. A route that forgot the `release` on a failure path would wedge every
 * later caller for that endpoint behind a lease that never clears, and that is
 * not the kind of mistake to leave available.
 */

import type { Env } from "../types.js";
import type { ReserveRequest, ReserveResponse } from "../do/probe-limiter.js";

export interface PolitenessOptions {
  /** SPEC §1.5 endpoint id — also the Durable Object name, one per endpoint. */
  endpointId: string;
  callerKey?: string;
  windowSeconds?: number;
  callerLimit?: number;
  /** A caller that cannot afford to wait for the in-flight leader. */
  noWait?: boolean;
}

export interface PolitenessOutcome<T> {
  result: T | null;
  cached: boolean;
  cacheAgeSeconds: number | null;
  /** Set when no result is available and the caller must be told to retry. */
  refusal: { reason: ReserveResponse["reason"]; retryAfterSeconds: number | null } | null;
}

function stub(env: Env, endpointId: string): DurableObjectStub {
  return env.PROBE_LIMITER.get(env.PROBE_LIMITER.idFromName(endpointId));
}

async function call<T>(
  env: Env,
  endpointId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await stub(env, endpointId).fetch(
    `https://probe-limiter.internal${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return await response.json<T>();
}

/**
 * Run `probeFn` at most once per endpoint per window.
 *
 * The first caller in a window runs it. Everyone who asks while it is running
 * is served the same result with its age, and everyone who asks afterwards is
 * served the cached copy until the window closes. `probeFn` is not called at
 * all in either of those cases — that is the whole point, and it is why this
 * takes a function rather than returning a boolean for the caller to honour.
 */
export async function withPoliteness<T>(
  env: Env,
  options: PolitenessOptions,
  probeFn: () => Promise<T>,
): Promise<PolitenessOutcome<T>> {
  const request: ReserveRequest = {
    endpoint_id: options.endpointId,
    ...(options.callerKey === undefined ? {} : { caller_key: options.callerKey }),
    ...(options.windowSeconds === undefined
      ? {}
      : { window_seconds: options.windowSeconds }),
    ...(options.callerLimit === undefined ? {} : { caller_limit: options.callerLimit }),
    ...(options.noWait === undefined ? {} : { no_wait: options.noWait }),
  };

  const reservation = await call<ReserveResponse>(
    env,
    options.endpointId,
    "/reserve",
    request,
  );

  if (!reservation.allowed) {
    if (reservation.cached_result !== null) {
      return {
        result: reservation.cached_result as T,
        cached: true,
        cacheAgeSeconds: reservation.cache_age_seconds,
        refusal: null,
      };
    }
    return {
      result: null,
      cached: false,
      cacheAgeSeconds: null,
      refusal: {
        reason: reservation.reason,
        retryAfterSeconds: reservation.retry_after_seconds,
      },
    };
  }

  // We hold the lease. Every exit from here MUST settle it, including the
  // throwing one, or followers wait out the timeout for nothing.
  try {
    const result = await probeFn();
    await call(env, options.endpointId, "/record", {
      endpoint_id: options.endpointId,
      result,
      ...(options.windowSeconds === undefined
        ? {}
        : { window_seconds: options.windowSeconds }),
    });
    return { result, cached: false, cacheAgeSeconds: null, refusal: null };
  } catch (error) {
    await call(env, options.endpointId, "/release", {
      endpoint_id: options.endpointId,
    });
    throw error;
  }
}

/**
 * A caller key that is salted, coarse and short-lived — and that no part of the
 * system can turn back into an address (docs/abuse-policy.md).
 *
 * Three properties, all of them load-bearing:
 *
 *  - **Salted** with a per-deployment secret, so the digest cannot be reversed
 *    by hashing the whole IPv4 space and matching.
 *  - **Time-bucketed**, so the same address produces a different key in the
 *    next window. Correlating a caller across windows is not possible even for
 *    us, which is what makes "short-lived" a property of the design rather than
 *    a retention promise.
 *  - **Truncated** to 12 hex characters. Enough to separate callers within one
 *    window; too coarse to be an identifier.
 *
 * The address is never returned, logged or stored — it exists only as an input
 * to this digest.
 */
export async function callerKey(
  address: string | null,
  salt: string,
  windowSeconds = 60,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (!address) return undefined;
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${bucket}:${address}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}
