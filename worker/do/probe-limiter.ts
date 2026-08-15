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
 *
 * ── The second budget, and why the first one was not a bound ────────────────
 *
 * Everything above is per ENDPOINT. It makes "a thousand people paste the same
 * URL" cost one outbound request, and it says nothing whatsoever about "one
 * person pastes a thousand different URLs" — a different endpoint id is a
 * different object with a fresh window, so the per-target window is not a cap
 * on total volume, it is a cap on volume *per target*. The per-caller budget
 * did not close that either: it is keyed by a salt generated per isolate
 * (`worker/routes/inspect.ts`), so it resets whenever a request lands on a cold
 * isolate and is not a global quantity at all.
 *
 * So the total outbound volume from the on-demand surface was unbounded, and
 * `docs/cost-model.md` could not put a number on the row that matters most.
 * `/admit` is the fix: ONE object (`GLOBAL_BUDGET_NAME`) holds a daily ceiling
 * on probes that a member of the public can cause, and a probe that cannot be
 * admitted is refused with the cached result still available. The crawler does
 * not draw on it — its ceiling is the fixed per-cycle budget in
 * `worker/crawler/schedule.ts` — so the two are added rather than multiplied,
 * and the sum is the number published in the cost model.
 *
 * It is consulted only once leadership has been granted, so a cache hit costs
 * nothing here and the object's request rate is the outbound probe rate plus
 * refusals, never the read rate of the site.
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

export interface AdmitRequest {
  /** Probes to charge. One, unless a caller ever batches — it never does today. */
  cost?: number;
  /** Ceiling override, so a test does not have to spend 5,000 admissions. */
  limit?: number;
}

export interface AdmitResponse {
  admitted: boolean;
  /** Admissions left in the current UTC day, after this one. */
  remaining: number;
  limit: number;
  /** Epoch ms at which the counter rolls. Also the retry-after basis. */
  reset_at: number;
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

/** The whole-service on-demand budget, held in one object under this name. */
interface GlobalBudget {
  /** UTC day, `YYYY-MM-DD`. A different day is a different budget. */
  day: string;
  spent: number;
}

/** "N minutes". Ten is polite without making the tool feel stale. */
const DEFAULT_WINDOW_SECONDS = 600;
const DEFAULT_CALLER_LIMIT = 30;
const DEFAULT_CALLER_WINDOW_SECONDS = 60;
/** How long a follower waits for the leader before giving up and being told to retry. */
const MAX_WAIT_MS = 15_000;

/**
 * The single object that holds the on-demand budget.
 *
 * An endpoint id is 32 lowercase hex characters (SPEC §1.5), so no endpoint can
 * ever be routed to this name. It is not merely unlikely; it is unrepresentable.
 */
export const GLOBAL_BUDGET_NAME = "__on_demand_budget__";

/**
 * Outbound probes per UTC day that the public can cause, in total.
 *
 * The arithmetic behind the number is in `docs/cost-model.md`; the short version
 * is that it is comfortably above any plausible real day (the busiest measured
 * hour on the live service was 145 scans) and far enough below every metered
 * ceiling that the worst case is affordable rather than merely survivable. It
 * is a constant for the same reason the crawler's per-cycle budget is: a fixed
 * ceiling makes the worst case a multiplication anybody can check, and an
 * adaptive one makes a busy day into a bigger bill.
 *
 * Exhausting it degrades the service to "cached results only" for the rest of
 * the day. That is a bad day. It is not an unbounded invoice, and it is not
 * somebody else's API being hammered on our behalf.
 */
export const MAX_ON_DEMAND_PROBES_PER_DAY = 5_000;

/** UTC day key. Deliberately not locale-aware — the reset must be one instant. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Epoch ms of the next UTC midnight, which is when the budget rolls. */
function nextUtcMidnight(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;
}

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

  /**
   * Serializes the daily-budget read-modify-write. See `admit`.
   *
   * A rejected link would poison every later admission, so nothing on this chain
   * is allowed to reject: `admitLocked` returns a refusal rather than throwing,
   * and the `catch` is the belt to that brace.
   */
  private budgetChain: Promise<AdmitResponse> = Promise.resolve({
    admitted: false,
    remaining: 0,
    limit: 0,
    reset_at: 0,
  });

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
        case "/admit":
          return Response.json(await this.admit(await this.body<AdmitRequest>(request)));
        case "/budget":
          return Response.json(await this.budget());
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

      // The wait timer is CLEARED when the leader wins the race. Leaving it
      // pending would keep this object ineligible for hibernation for the
      // remaining wait — up to 15 seconds of billed duration after the work
      // finished, per follower, on an object charged for a full 128 MB whether
      // it uses it or not. That is a cost bug rather than a correctness one,
      // which is exactly the kind that survives a passing test suite.
      const leader = this.inFlight;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = await Promise.race([
        leader.promise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), MAX_WAIT_MS);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

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

  // ── the global on-demand budget ─────────────────────────────────────────

  /**
   * Charge one probe against the whole-service daily ceiling.
   *
   * Only ever called on the object named `GLOBAL_BUDGET_NAME`, and only after a
   * caller has already won leadership for its endpoint — so the call rate here
   * is the outbound probe rate plus whatever a flood adds, never the site's read
   * rate. The counter lives in storage rather than in memory because an
   * evicted object with an in-memory counter has a budget that resets whenever
   * Cloudflare feels like it, which is not a budget.
   *
   * The write is the expensive part (one DO SQLite row write per admission), and
   * it is bounded by the ceiling itself: at most `limit` writes per day plus one
   * per refusal. Refusals do not write — they read and return — so a flood after
   * exhaustion costs reads, not writes.
   */
  private admit(input: AdmitRequest): Promise<AdmitResponse> {
    // Serialized explicitly, not by trusting the runtime.
    //
    // `admit` is a read-modify-write, and twenty concurrent callers that each
    // read `spent` before any of them writes it all see room and are all
    // admitted — a ceiling of five that lets twenty through. Durable Objects do
    // have an input gate that would very likely prevent this, but "very likely,
    // by a runtime behaviour we did not test against" is not the footing for the
    // one mechanism that turns an unbounded bill into a bounded one. Chaining
    // the mutations makes the guarantee this object's own, and it is what the
    // `many-distinct-targets-many-callers` row in
    // spec/fixtures/hostile/amplification.json actually caught.
    const next = this.budgetChain.then(
      () => this.admitLocked(input),
      () => this.admitLocked(input),
    );
    // Kept unrejectable so one failed admission cannot wedge the day's budget.
    this.budgetChain = next.catch(() => ({
      admitted: false,
      remaining: 0,
      limit: input.limit ?? MAX_ON_DEMAND_PROBES_PER_DAY,
      reset_at: nextUtcMidnight(this.now()),
    }));
    return next;
  }

  private async admitLocked(input: AdmitRequest): Promise<AdmitResponse> {
    const limit = input.limit ?? MAX_ON_DEMAND_PROBES_PER_DAY;
    const cost = Math.max(1, Math.floor(input.cost ?? 1));
    const now = this.now();
    const day = utcDay(now);
    const resetAt = nextUtcMidnight(now);

    const stored = await this.state.storage.get<GlobalBudget>("budget");
    const budget: GlobalBudget =
      stored && stored.day === day ? stored : { day, spent: 0 };

    if (budget.spent + cost > limit) {
      return { admitted: false, remaining: Math.max(0, limit - budget.spent), limit, reset_at: resetAt };
    }

    budget.spent += cost;
    await this.state.storage.put("budget", budget);
    return { admitted: true, remaining: limit - budget.spent, limit, reset_at: resetAt };
  }

  /**
   * Today's spend, without charging for the question.
   *
   * `/api/v1/health` calls this, so a reader can check the published ceiling
   * against the running service instead of taking `docs/cost-model.md` on
   * trust. It reads and never writes, which is what makes it safe to expose on
   * an unauthenticated endpoint.
   */
  private async budget(): Promise<AdmitResponse> {
    const now = this.now();
    const day = utcDay(now);
    const stored = await this.state.storage.get<GlobalBudget>("budget");
    const spent = stored && stored.day === day ? stored.spent : 0;
    return {
      admitted: false,
      remaining: Math.max(0, MAX_ON_DEMAND_PROBES_PER_DAY - spent),
      limit: MAX_ON_DEMAND_PROBES_PER_DAY,
      reset_at: nextUtcMidnight(now),
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
