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
import {
  GLOBAL_BUDGET_NAME,
  MAX_ON_DEMAND_PROBES_PER_DAY,
  type AdmitResponse,
  type ReserveRequest,
  type ReserveResponse,
} from "../do/probe-limiter.js";

export { GLOBAL_BUDGET_NAME, MAX_ON_DEMAND_PROBES_PER_DAY };

export interface PolitenessOptions {
  /** SPEC §1.5 endpoint id — also the Durable Object name, one per endpoint. */
  endpointId: string;
  callerKey?: string;
  windowSeconds?: number;
  callerLimit?: number;
  /** A caller that cannot afford to wait for the in-flight leader. */
  noWait?: boolean;
  /**
   * This probe was caused by a member of the public, so it draws on the daily
   * on-demand ceiling (`/admit`). The crawler leaves this off: its volume is
   * bounded by the fixed per-cycle budget, and letting it spend the on-demand
   * allowance would mean a busy crawl day denies the Inspector to people.
   *
   * Off by default so that adding it is a visible decision in a diff, and so
   * that no existing caller silently starts spending a budget it was not
   * written against.
   */
  onDemand?: boolean;
  /** Ceiling override, for tests that cannot afford to spend 5,000 admissions. */
  onDemandLimit?: number;
}

/**
 * Why no result came back. Every value the Durable Object can report, plus
 * `daily_budget` — the whole-service ceiling, which is refused on this side of
 * the wire because the endpoint's own object never learns about it.
 */
export type RefusalReason = ReserveResponse["reason"] | "daily_budget";

export interface PolitenessOutcome<T> {
  result: T | null;
  cached: boolean;
  cacheAgeSeconds: number | null;
  /** Set when no result is available and the caller must be told to retry. */
  refusal: { reason: RefusalReason; retryAfterSeconds: number | null } | null;
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

// ── the whole-service daily ceiling ───────────────────────────────────────

/**
 * When this isolate last learned the day's budget was gone.
 *
 * Without it, a flood of distinct URLs after exhaustion sends every single
 * request to one Durable Object — the object would refuse them all correctly and
 * become the service's hottest single-threaded point while doing it. With it,
 * a sustained flood costs at most one `/admit` call per isolate per second, and
 * the refusal is served from the Worker.
 *
 * It can only ever make the limiter *more* conservative for up to a second, and
 * it is never the thing that admits a probe — an admission always comes from the
 * object itself. That asymmetry is deliberate: a cache that can say "no" on
 * stale information is safe, and one that can say "yes" is not.
 */
let exhaustedUntil = 0;
const EXHAUSTION_MEMO_MS = 1_000;

/** Test-only: forget the isolate's memo of an exhausted budget. */
export function resetOnDemandMemoForTests(): void {
  exhaustedUntil = 0;
}

export interface Admission {
  admitted: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

/**
 * Charge one probe against the whole-service daily allowance.
 *
 * **Fails closed.** A Durable Object we cannot reach means we do not know
 * whether there is budget left, and the safe reading of "I do not know" for a
 * free service that fetches arbitrary URLs is "no". The alternative — waving
 * probes through whenever the limiter is unavailable — turns an outage into the
 * exact unbounded fetch this exists to prevent.
 */
export async function admitOnDemand(
  env: Env,
  options: { limit?: number } = {},
): Promise<Admission> {
  const now = Date.now();
  const limit = options.limit ?? MAX_ON_DEMAND_PROBES_PER_DAY;

  if (now < exhaustedUntil) {
    return { admitted: false, remaining: 0, limit, resetAt: exhaustedUntil };
  }

  try {
    const response = await call<AdmitResponse>(env, GLOBAL_BUDGET_NAME, "/admit", {
      cost: 1,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    // A 500 from the object's own error path answers with `{allowed:false}` and
    // no `admitted` field, so anything that is not an explicit `true` is a no.
    if (response?.admitted !== true) {
      exhaustedUntil = now + EXHAUSTION_MEMO_MS;
      return {
        admitted: false,
        remaining: response?.remaining ?? 0,
        limit: response?.limit ?? limit,
        resetAt: response?.reset_at ?? now + EXHAUSTION_MEMO_MS,
      };
    }

    return {
      admitted: true,
      remaining: response.remaining,
      limit: response.limit,
      resetAt: response.reset_at,
    };
  } catch {
    exhaustedUntil = now + EXHAUSTION_MEMO_MS;
    return { admitted: false, remaining: 0, limit, resetAt: now + EXHAUSTION_MEMO_MS };
  }
}

/**
 * Read the day's on-demand budget without spending any of it.
 *
 * `/api/v1/health` reports it, so that "the ceiling exists" is checkable from
 * outside rather than being a claim in a document.
 */
export async function peekOnDemandBudget(env: Env): Promise<Admission | null> {
  try {
    const response = await call<AdmitResponse>(env, GLOBAL_BUDGET_NAME, "/budget", {});
    if (typeof response?.remaining !== "number") return null;
    return {
      admitted: false,
      remaining: response.remaining,
      limit: response.limit,
      resetAt: response.reset_at,
    };
  } catch {
    return null;
  }
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

  // We hold the lease, and this is the last point at which an outbound request
  // can still be prevented. If the service's daily on-demand allowance is gone,
  // the lease is handed back immediately so nobody waits on a probe that will
  // never run.
  if (options.onDemand === true) {
    const admission = await admitOnDemand(
      env,
      options.onDemandLimit === undefined ? {} : { limit: options.onDemandLimit },
    );
    if (!admission.admitted) {
      await call(env, options.endpointId, "/release", { endpoint_id: options.endpointId });
      return {
        result: null,
        cached: false,
        cacheAgeSeconds: null,
        refusal: {
          reason: "daily_budget",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((admission.resetAt - Date.now()) / 1000),
          ),
        },
      };
    }
  }

  // Every exit from here MUST settle the lease, including the throwing one, or
  // followers wait out the timeout for nothing.
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
