/**
 * ProbeLimiter — the per-endpoint politeness gate. Declared, implemented.
 *
 * **One live probe per endpoint per window, no matter how many people ask.**
 * Everyone else is served the cached result *with its age*. This is not a
 * performance optimisation; it is the thing that stops this service being a
 * free DDoS cannon aimed at other people's paid APIs. Being that ends the
 * project, so the limit is per TARGET first and per caller second.
 *
 * ── Collapsing concurrency, not just rate-limiting it ──────────────────────
 *
 * A plain rate limiter still lets N simultaneous requests through, because none
 * of them has finished yet when the others arrive. So `reserve` is
 * **single-flight**: the first caller gets the lease and everyone who asks
 * while that probe is running is parked on the leader's result and served it as
 * a cache hit. A hundred people pasting the same URL at once produce exactly
 * one outbound request. One Durable Object per endpoint id is what makes this
 * safe — the runtime serializes the decision, so there is no window in which
 * two callers can both believe they are the leader.
 *
 * ── Privacy (docs/abuse-policy.md) ───────────────────────────
 *
 * **No IP address is stored here, in any form.** The caller-side limiter is
 * keyed by a salted, coarse, short-lived token the Worker derives; this object
 * never receives an address and has nowhere to put one. Caller buckets expire
 * with their window and are never written to D1. Nothing about a caller
 * outlives its window.
 *
 * The cached *probe result* is a different thing and is deliberately shared: a
 * challenge is public data the endpoint serves to anyone who asks, and sharing
 * it is exactly how one probe answers many questions.
 */

import type { Env } from "../types.js";

// ── the wire contract ─────────────────────────────────────────────────────
// Internal to the Worker; a caller reaches it through `worker/lib/politeness.ts`
// rather than by constructing these URLs by hand.

export interface ReserveRequest {
  /** SPEC §1.5 endpoint id. One object per endpoint, so this is a sanity key. */
  endpoint_id: string;
  /**
   * Salted, coarse and short-lived (see the privacy note above). Optional
   * because the crawler has no caller to attribute.
   */
  caller_key?: string;
  /** Politeness window in seconds. */
  window_seconds?: number;
  /** Caller budget within the window. */
  caller_limit?: number;
  /** Set by a caller that has been told to wait and cannot wait any longer. */
  no_wait?: boolean;
}

export interface ReserveResponse {
  /** True ⇒ you are the leader and must call `record` or `release`. */
  allowed: boolean;
  /** Present when a fresh result was available or the leader's probe landed. */
  cached_result: unknown;
  cache_age_seconds: number | null;
  retry_after_seconds: number | null;
  /** Why the caller was refused, so the route can pick the right error code. */
  reason: "leader" | "cached" | "target_window" | "caller_limit" | "wait_timeout";
}

interface CacheEntry {
  result: unknown;
  stored_at: number;
}

interface CallerBucket {
  count: number;
  reset_at: number;
}

/** "N minutes". Ten is polite without making the tool feel stale. */
const DEFAULT_WINDOW_SECONDS = 600;
const DEFAULT_CALLER_LIMIT = 30;
const DEFAULT_CALLER_WINDOW_SECONDS = 60;
/** How long a follower waits for the leader before giving up and being told to retry. */
const MAX_WAIT_MS = 15_000;

export class ProbeLimiter implements DurableObject {
  /**
   * The in-flight probe, if any. In memory rather than in storage on purpose:
   * it describes a request that is happening *right now* in this object, and a
   * lease that outlived an eviction would deadlock every later caller.
   */
  private inFlight: {
    promise: Promise<CacheEntry | null>;
    settle: (entry: CacheEntry | null) => void;
    startedAt: number;
  } | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/reserve":
          return Response.json(await this.reserve(await this.body<ReserveRequest>(request)));
        case "/record":
          return Response.json(
            await this.record(
              await this.body<{ endpoint_id: string; result: unknown; window_seconds?: number }>(
                request,
              ),
            ),
          );
        case "/release":
          return Response.json(await this.release());
        case "/peek":
          return Response.json(await this.peek());
        default:
          return Response.json({ error: "unknown path" }, { status: 404 });
      }
    } catch (error) {
      // A limiter that fails open is a limiter that does not exist, so an
      // internal error refuses the probe rather than waving it through.
      return Response.json(
        { allowed: false, error: (error as Error).message },
        { status: 500 },
      );
    }
  }

  private async body<T>(request: Request): Promise<T> {
    return await request.json<T>();
  }

  private now(): number {
    return Date.now();
  }

  // ── reserve ─────────────────────────────────────────────────────────────

  private async reserve(input: ReserveRequest): Promise<ReserveResponse> {
    const windowSeconds = input.window_seconds ?? DEFAULT_WINDOW_SECONDS;
    const now = this.now();

    // Caller budget first: it is the cheapest refusal, and it must apply even
    // when the answer would have come from cache, or a single caller can pin
    // the service refreshing one endpoint forever.
    if (input.caller_key) {
      const overLimit = await this.chargeCaller(
        input.caller_key,
        input.caller_limit ?? DEFAULT_CALLER_LIMIT,
        now,
      );
      if (overLimit !== null) {
        return {
          allowed: false,
          cached_result: null,
          cache_age_seconds: null,
          retry_after_seconds: overLimit,
          reason: "caller_limit",
        };
      }
    }

    // A fresh result answers the question without touching the endpoint.
    const cached = await this.state.storage.get<CacheEntry>("entry");
    if (cached && now - cached.stored_at < windowSeconds * 1000) {
      return {
        allowed: false,
        cached_result: cached.result,
        cache_age_seconds: Math.floor((now - cached.stored_at) / 1000),
        retry_after_seconds: Math.ceil(
          (windowSeconds * 1000 - (now - cached.stored_at)) / 1000,
        ),
        reason: "cached",
      };
    }

    // Someone is already probing this endpoint. Park on their result rather
    // than starting a second identical request — this is the collapse.
    if (this.inFlight) {
      if (input.no_wait) {
        return {
          allowed: false,
          cached_result: null,
          cache_age_seconds: null,
          retry_after_seconds: 1,
          reason: "target_window",
        };
      }

      const leader = this.inFlight;
      const entry = await Promise.race([
        leader.promise,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), MAX_WAIT_MS),
        ),
      ]);

      if (entry === "timeout" || entry === null) {
        return {
          allowed: false,
          cached_result: null,
          cache_age_seconds: null,
          retry_after_seconds: 5,
          reason: entry === "timeout" ? "wait_timeout" : "target_window",
        };
      }

      return {
        allowed: false,
        cached_result: entry.result,
        cache_age_seconds: Math.max(0, Math.floor((this.now() - entry.stored_at) / 1000)),
        retry_after_seconds: null,
        reason: "cached",
      };
    }

    // Become the leader.
    let settle!: (entry: CacheEntry | null) => void;
    const promise = new Promise<CacheEntry | null>((resolve) => {
      settle = resolve;
    });
    this.inFlight = { promise, settle, startedAt: now };

    return {
      allowed: true,
      cached_result: null,
      cache_age_seconds: null,
      retry_after_seconds: null,
      reason: "leader",
    };
  }

  // ── record / release ────────────────────────────────────────────────────

  private async record(input: {
    result: unknown;
    window_seconds?: number;
  }): Promise<{ ok: true }> {
    const entry: CacheEntry = { result: input.result, stored_at: this.now() };
    await this.state.storage.put("entry", entry);

    // Wake every follower with the leader's result before clearing the lease.
    const leader = this.inFlight;
    this.inFlight = null;
    leader?.settle(entry);

    // The cache is a politeness window, not an archive: drop it once the window
    // has passed so a stale challenge is never served as if it were current.
    const windowSeconds = input.window_seconds ?? DEFAULT_WINDOW_SECONDS;
    await this.state.storage.setAlarm(this.now() + windowSeconds * 1000);

    return { ok: true };
  }

  /**
   * The probe failed. Followers are released with nothing rather than left to
   * wait out the timeout — a failed leader must not make everyone else slow.
   */
  private async release(): Promise<{ ok: true }> {
    const leader = this.inFlight;
    this.inFlight = null;
    leader?.settle(null);
    return { ok: true };
  }

  private async peek(): Promise<{
    cached: boolean;
    cache_age_seconds: number | null;
    in_flight: boolean;
  }> {
    const cached = await this.state.storage.get<CacheEntry>("entry");
    return {
      cached: cached !== undefined,
      cache_age_seconds: cached
        ? Math.floor((this.now() - cached.stored_at) / 1000)
        : null,
      in_flight: this.inFlight !== null,
    };
  }

  // ── caller budget ───────────────────────────────────────────────────────

  /** Returns null when the caller is within budget, else seconds until reset. */
  private async chargeCaller(
    callerKey: string,
    limit: number,
    now: number,
  ): Promise<number | null> {
    const key = `caller:${callerKey}`;
    const bucket = await this.state.storage.get<CallerBucket>(key);

    if (!bucket || bucket.reset_at <= now) {
      await this.state.storage.put(key, {
        count: 1,
        reset_at: now + DEFAULT_CALLER_WINDOW_SECONDS * 1000,
      });
      return null;
    }

    if (bucket.count >= limit) {
      return Math.ceil((bucket.reset_at - now) / 1000);
    }

    await this.state.storage.put(key, { ...bucket, count: bucket.count + 1 });
    return null;
  }

  /**
   * Expire the cached result and any caller buckets that have aged out. This is
   * the only place caller state is retained at all, and the alarm is what makes
   * "short-lived" true rather than aspirational.
   */
  async alarm(): Promise<void> {
    const now = this.now();

    const entry = await this.state.storage.get<CacheEntry>("entry");
    if (entry && now - entry.stored_at >= DEFAULT_WINDOW_SECONDS * 1000) {
      await this.state.storage.delete("entry");
    }

    const buckets = await this.state.storage.list<CallerBucket>({ prefix: "caller:" });
    const expired = [...buckets.entries()]
      .filter(([, bucket]) => bucket.reset_at <= now)
      .map(([key]) => key);
    if (expired.length > 0) await this.state.storage.delete(expired);
  }
}
