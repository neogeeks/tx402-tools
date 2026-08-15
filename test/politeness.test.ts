/**
 * The politeness cache, tested on the property that actually matters.
 *
 * **one live probe per endpoint per N minutes no matter how many
 * users ask.** A rate limiter that only counts requests does not deliver that —
 * a hundred simultaneous callers all pass the count check, because none of them
 * has finished when the others arrive. So the test that earns its place is the
 * concurrent one: N callers, one outbound probe.
 *
 * The `ProbeLimiter` class is driven directly against an in-process fake of the
 * Durable Object storage API. That runs in the same Node pool as the rest of
 * the suite and exercises the real decision logic rather than
 * a mock of it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GLOBAL_BUDGET_NAME, ProbeLimiter } from "../worker/do/probe-limiter.js";
import {
  admitOnDemand,
  callerKey,
  peekOnDemandBudget,
  resetOnDemandMemoForTests,
  withPoliteness,
} from "../worker/lib/politeness.js";
import type { Env } from "../worker/types.js";

// The isolate-level "budget is gone" memo is module state, so a test that
// exhausts a budget would otherwise leak a refusal into the next one.
beforeEach(() => {
  resetOnDemandMemoForTests();
});

// ── an in-process stand-in for DurableObjectState.storage ─────────────────

function fakeStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    map,
    get alarmAt() {
      return alarm;
    },
    get: <T>(key: string): Promise<T | undefined> =>
      Promise.resolve(map.get(key) as T | undefined),
    put: (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string | string[]): Promise<boolean> => {
      for (const k of Array.isArray(key) ? key : [key]) map.delete(k);
      return Promise.resolve(true);
    },
    list: <T>({ prefix }: { prefix: string }): Promise<Map<string, T>> => {
      const out = new Map<string, T>();
      for (const [k, v] of map) if (k.startsWith(prefix)) out.set(k, v as T);
      return Promise.resolve(out);
    },
    setAlarm: (at: number): Promise<void> => {
      alarm = at;
      return Promise.resolve();
    },
  };
}

/**
 * A namespace whose objects are real `ProbeLimiter` instances, one per name.
 * Requests are dispatched exactly as the runtime would, so `withPoliteness` is
 * talking to the real class.
 */
function fakeNamespace(): Env["PROBE_LIMITER"] & {
  storages: Map<string, ReturnType<typeof fakeStorage>>;
} {
  const limiters = new Map<string, ProbeLimiter>();
  const storages = new Map<string, ReturnType<typeof fakeStorage>>();

  const namespace = {
    storages,
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      fetch: (url: string, init?: RequestInit) => {
        let limiter = limiters.get(id.name);
        if (!limiter) {
          const storage = fakeStorage();
          storages.set(id.name, storage);
          limiter = new ProbeLimiter(
            { storage } as unknown as DurableObjectState,
            {} as Env,
          );
          limiters.set(id.name, limiter);
        }
        return limiter.fetch(new Request(url, init));
      },
    }),
  };

  return namespace as unknown as Env["PROBE_LIMITER"] & {
    storages: Map<string, ReturnType<typeof fakeStorage>>;
  };
}

function envWith(namespace: Env["PROBE_LIMITER"]): Env {
  return { PROBE_LIMITER: namespace } as unknown as Env;
}

const ENDPOINT = "a".repeat(32);

describe("one probe per endpoint, however many callers", () => {
  it("collapses concurrent requests for the same endpoint into ONE probe", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;

    const probeFn = async (): Promise<{ value: string }> => {
      probes += 1;
      // Long enough that every other caller arrives while this is in flight —
      // which is exactly the case a counting rate limiter waves through.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { value: "the-one-result" };
    };

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        withPoliteness(env, { endpointId: ENDPOINT }, probeFn),
      ),
    );

    expect(probes).toBe(1);

    // Everyone got the answer, and everyone who did not run it was told so.
    for (const outcome of results) {
      expect(outcome.result).toEqual({ value: "the-one-result" });
    }
    expect(results.filter((r) => !r.cached)).toHaveLength(1);
    expect(results.filter((r) => r.cached)).toHaveLength(24);
  });

  it("serves later callers from cache and reports the age", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;
    const probeFn = () => {
      probes += 1;
      return Promise.resolve({ value: probes });
    };

    const first = await withPoliteness(env, { endpointId: ENDPOINT }, probeFn);
    expect(first.cached).toBe(false);
    expect(first.cacheAgeSeconds).toBeNull();

    const second = await withPoliteness(env, { endpointId: ENDPOINT }, probeFn);
    expect(probes).toBe(1);
    expect(second.cached).toBe(true);
    // SPEC §1.6: a cached answer says so and carries its age. A client is never
    // handed a stale number that claims to be live.
    expect(second.cacheAgeSeconds).not.toBeNull();
    expect(second.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(second.result).toEqual({ value: 1 });
  });

  it("does not let one endpoint's window block a different endpoint", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;
    const probeFn = () => {
      probes += 1;
      return Promise.resolve({ value: probes });
    };

    await withPoliteness(env, { endpointId: "a".repeat(32) }, probeFn);
    await withPoliteness(env, { endpointId: "b".repeat(32) }, probeFn);
    expect(probes).toBe(2);
  });

  it("probes again once the window has passed", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;
    const probeFn = () => {
      probes += 1;
      return Promise.resolve({ value: probes });
    };

    await withPoliteness(env, { endpointId: ENDPOINT, windowSeconds: 0 }, probeFn);
    await withPoliteness(env, { endpointId: ENDPOINT, windowSeconds: 0 }, probeFn);
    expect(probes).toBe(2);
  });
});

describe("a failed leader does not wedge the endpoint", () => {
  it("releases the lease when the probe throws, and lets the next caller run", async () => {
    const env = envWith(fakeNamespace());
    let attempts = 0;

    await expect(
      withPoliteness(env, { endpointId: ENDPOINT }, () => {
        attempts += 1;
        return Promise.reject(new Error("upstream exploded"));
      }),
    ).rejects.toThrow("upstream exploded");

    // Without the release, this second call would park on a lease that never
    // settles and time out — every later caller for this endpoint would be slow
    // because one probe failed.
    const second = await withPoliteness(env, { endpointId: ENDPOINT }, () => {
      attempts += 1;
      return Promise.resolve({ value: "recovered" });
    });

    expect(attempts).toBe(2);
    expect(second.result).toEqual({ value: "recovered" });
  });

  it("releases followers immediately rather than making them wait it out", async () => {
    const env = envWith(fakeNamespace());

    const leader = withPoliteness(env, { endpointId: ENDPOINT }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("boom");
    });
    // Let the leader take the lease first.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    const follower = withPoliteness(env, { endpointId: ENDPOINT }, () =>
      Promise.resolve({ value: "should not run" }),
    );

    await expect(leader).rejects.toThrow("boom");
    const outcome = await follower;

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).not.toBeNull();
    // Well under the 15s follower timeout.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("caller budget", () => {
  it("refuses a caller over its limit, with a retry hint", async () => {
    const env = envWith(fakeNamespace());
    const key = "test-caller";

    for (let i = 0; i < 3; i += 1) {
      await withPoliteness(
        env,
        { endpointId: ENDPOINT, callerKey: key, callerLimit: 3, windowSeconds: 0 },
        () => Promise.resolve({ value: i }),
      );
    }

    const refused = await withPoliteness(
      env,
      { endpointId: ENDPOINT, callerKey: key, callerLimit: 3, windowSeconds: 0 },
      () => Promise.resolve({ value: "should not run" }),
    );

    expect(refused.result).toBeNull();
    expect(refused.refusal?.reason).toBe("caller_limit");
    expect(refused.refusal?.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("the whole-service daily ceiling", () => {
  /**
   * The per-endpoint window bounds volume PER TARGET. It says nothing about one
   * caller walking a list of a thousand different URLs, because each of those is
   * a different object with a fresh window — which is why the cost model could
   * not put a number on the on-demand row until this existed.
   */
  it("bounds distinct endpoints, which the per-target window never did", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;
    const probeFn = () => {
      probes += 1;
      return Promise.resolve({ value: probes });
    };

    const outcomes = [];
    for (let i = 0; i < 8; i += 1) {
      outcomes.push(
        // A different endpoint every time: eight fresh politeness windows, and
        // before the ceiling existed, eight outbound probes.
        await withPoliteness(
          env,
          { endpointId: String(i).repeat(32).slice(0, 32), onDemand: true, onDemandLimit: 3 },
          probeFn,
        ),
      );
    }

    expect(probes).toBe(3);
    expect(outcomes.filter((o) => o.result !== null)).toHaveLength(3);

    const refused = outcomes.filter((o) => o.result === null);
    expect(refused).toHaveLength(5);
    for (const outcome of refused) {
      expect(outcome.refusal?.reason).toBe("daily_budget");
      // Retry-after points at the UTC rollover, so it is always positive and
      // never longer than a day.
      expect(outcome.refusal?.retryAfterSeconds).toBeGreaterThan(0);
      expect(outcome.refusal?.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    }
  });

  it("does not charge the ceiling for a cache hit", async () => {
    const env = envWith(fakeNamespace());
    const probeFn = () => Promise.resolve({ value: "x" });

    await withPoliteness(env, { endpointId: ENDPOINT, onDemand: true, onDemandLimit: 2 }, probeFn);
    // Same endpoint, inside the window: served from cache, so no outbound
    // request happened and no allowance should have been spent on it.
    await withPoliteness(env, { endpointId: ENDPOINT, onDemand: true, onDemandLimit: 2 }, probeFn);
    await withPoliteness(env, { endpointId: ENDPOINT, onDemand: true, onDemandLimit: 2 }, probeFn);

    const budget = await peekOnDemandBudget(env);
    expect(budget).not.toBeNull();
    // Exactly one admission for the one probe that actually left the building.
    expect(budget!.limit - budget!.remaining).toBe(1);
  });

  it("leaves the crawler's probes alone — the two budgets add, they do not share", async () => {
    const env = envWith(fakeNamespace());
    let probes = 0;
    const probeFn = () => {
      probes += 1;
      return Promise.resolve({ value: probes });
    };

    for (let i = 0; i < 5; i += 1) {
      // No `onDemand`: this is the crawler's call shape. Its ceiling is the
      // fixed per-cycle budget in worker/crawler/schedule.ts.
      await withPoliteness(env, { endpointId: String(i).repeat(32).slice(0, 32) }, probeFn);
    }

    expect(probes).toBe(5);
    const budget = await peekOnDemandBudget(env);
    expect(budget!.remaining).toBe(budget!.limit);
  });

  it("hands the lease back when it refuses, so the endpoint is not wedged", async () => {
    const env = envWith(fakeNamespace());

    const refused = await withPoliteness(
      env,
      { endpointId: ENDPOINT, onDemand: true, onDemandLimit: 0 },
      () => Promise.resolve({ value: "should not run" }),
    );
    expect(refused.result).toBeNull();
    expect(refused.refusal?.reason).toBe("daily_budget");

    // If the lease had leaked, this caller would park on a leader that will
    // never settle and wait out the 15-second follower timeout.
    resetOnDemandMemoForTests();
    const started = Date.now();
    const after = await withPoliteness(env, { endpointId: ENDPOINT }, () =>
      Promise.resolve({ value: "ran" }),
    );
    expect(after.result).toEqual({ value: "ran" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails CLOSED when the limiter cannot be reached", async () => {
    // A limiter we cannot ask is a budget we do not know the state of, and the
    // safe reading of "I do not know" for a free service that fetches arbitrary
    // URLs is "no". Failing open would turn an outage into the unbounded fetch
    // this whole mechanism exists to prevent.
    const broken = {
      idFromName: (name: string) => ({ toString: () => name, name }),
      get: () => ({
        fetch: () => Promise.reject(new Error("durable object unavailable")),
      }),
    } as unknown as Env["PROBE_LIMITER"];

    const admission = await admitOnDemand(envWith(broken));
    expect(admission.admitted).toBe(false);
  });

  it("refuses without re-asking the object once the isolate knows the day is spent", async () => {
    const namespace = fakeNamespace();
    let calls = 0;
    const counted = {
      idFromName: (name: string) => ({ toString: () => name, name }),
      get: (id: { name: string }) => {
        const stub = (namespace as unknown as Env["PROBE_LIMITER"]).get(
          { name: id.name } as unknown as DurableObjectId,
        );
        return {
          fetch: (url: string, init?: RequestInit) => {
            if (id.name === GLOBAL_BUDGET_NAME) calls += 1;
            return (stub as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> })
              .fetch(url, init);
          },
        };
      },
    } as unknown as Env["PROBE_LIMITER"];

    const spent = envWith(counted);
    await admitOnDemand(spent, { limit: 0 });
    expect(calls).toBe(1);

    // The memo answers the next twenty, so a sustained flood after exhaustion
    // does not make one Durable Object the service's hottest single thread.
    for (let i = 0; i < 20; i += 1) await admitOnDemand(spent, { limit: 0 });
    expect(calls).toBe(1);
  });

  it("routes the ceiling to one object, under a name no endpoint id can spell", () => {
    // Endpoint ids are 32 lowercase hex characters (SPEC §1.5), so a collision
    // here is unrepresentable rather than merely unlikely.
    expect(GLOBAL_BUDGET_NAME).not.toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("privacy (docs/abuse-policy.md)", () => {
  it("stores no address, and nothing that can be turned back into one", async () => {
    const namespace = fakeNamespace();
    const env = envWith(namespace);
    const address = "198.51.100.77";
    const key = await callerKey(address, "deployment-salt");

    await withPoliteness(
      env,
      { endpointId: ENDPOINT, callerKey: key },
      () => Promise.resolve({ value: "ok" }),
    );

    const stored = JSON.stringify([...namespace.storages.get(ENDPOINT)!.map.entries()]);
    expect(stored).not.toContain(address);
    expect(stored).not.toContain("198.51");
  });

  it("produces a different key for the same address in the next window", async () => {
    const now = 1_760_000_000_000;
    const a = await callerKey("198.51.100.77", "salt", 60, now);
    const b = await callerKey("198.51.100.77", "salt", 60, now + 60_000);
    const sameWindow = await callerKey("198.51.100.77", "salt", 60, now + 1_000);

    expect(a).toBe(sameWindow);
    // Correlating one caller across windows is not possible even for us. That
    // is what makes "short-lived" a property of the design rather than a
    // retention promise.
    expect(a).not.toBe(b);
  });

  it("is salted, so the key cannot be reversed by hashing the address space", async () => {
    const a = await callerKey("198.51.100.77", "salt-one", 60, 0);
    const b = await callerKey("198.51.100.77", "salt-two", 60, 0);
    expect(a).not.toBe(b);
  });

  it("is coarse, and absent when there is no caller to attribute", async () => {
    expect(await callerKey("198.51.100.77", "salt")).toHaveLength(12);
    expect(await callerKey(null, "salt")).toBeUndefined();
  });
});
