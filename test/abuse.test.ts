/**
 * The abuse suite, run as an attacker rather than as a test author.
 *
 * `test/guard.test.ts` drives `spec/fixtures/hostile/urls.json`, and that table
 * was written by the person who wrote the guard. This file drives the three
 * tables that cover what a URL alone cannot express, and each of them exists
 * because the original table could not have been wrong about it — only silent:
 *
 *   resolutions.json      DNS answers that change, disagree, or hide one bad
 *                         record among good ones. A hostname is not a target;
 *                         it is a promise about a target, made by somebody else.
 *   redirect-chains.json  chains whose hostile hop is the LAST one. Every
 *                         redirect row in urls.json turns bad immediately, so
 *                         they all pass against a guard that validates hop 0 and
 *                         then hands the rest to the platform.
 *   amplification.json    volume. Nothing above concerns a URL that is wrong to
 *                         fetch; these are URLs that are fine to fetch once and
 *                         ruinous to fetch a thousand times for other people.
 *
 * The tables are read from the fixtures rather than restated here, for the same
 * reason `guard.test.ts` does it: a row that is added becomes a test the moment
 * it is added, and a row cannot be quietly skipped by editing a test file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  GUARD_LIMITS,
  guardedFetch,
  type Connector,
  type ParsedAddress,
  type Resolver,
} from "../worker/lib/guard.js";
import { ProbeLimiter } from "../worker/do/probe-limiter.js";
import { resetOnDemandMemoForTests, withPoliteness } from "../worker/lib/politeness.js";
import type { Env } from "../worker/types.js";
import { hostileResolver, scriptedConnector, scriptedResolver } from "./net-stubs.js";

const HOSTILE = join(__dirname, "../spec/fixtures/hostile");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(HOSTILE, name), "utf8")) as T;

beforeEach(() => {
  resetOnDemandMemoForTests();
});

// ── resolutions ───────────────────────────────────────────────────────────

interface ResolutionCase {
  id: string;
  hostname: string;
  /** answers[n] is the nth lookup; the last entry repeats thereafter. */
  answers: string[][];
  expect: "allow" | "reject";
  code: string | null;
  connects: number;
  pins: string | null;
  note: string;
}

/**
 * A resolver whose answer depends on how many times it has been asked.
 *
 * The lookup counter is what makes a rebinding case expressible at all: the
 * property under test is that the SECOND answer is the one the guard acts on,
 * and no fixed table can say that.
 */
function answeringResolver(
  hostname: string,
  answers: string[][],
): Resolver & { lookups: () => number } {
  let calls = 0;
  return {
    lookups: () => calls,
    resolve(host: string): Promise<string[]> {
      if (host.toLowerCase().replace(/\.$/u, "") !== hostname) {
        return Promise.reject(new Error(`NXDOMAIN ${host}`));
      }
      calls += 1;
      const answer = answers[Math.min(calls - 1, answers.length - 1)];
      return Promise.resolve(answer ?? []);
    },
  };
}

/** Records the pin the guard computed, which is the only checkable half of it. */
function pinRecordingConnector(): Connector & { requests: string[]; pins: string[] } {
  const requests: string[] = [];
  const pins: string[] = [];
  return {
    requests,
    pins,
    fetch(url: URL, _init, pin: { address: ParsedAddress }): Promise<Response> {
      requests.push(url.toString());
      pins.push(pin.address.text);
      return Promise.resolve(new Response("{}", { status: 402 }));
    },
  };
}

describe("DNS answers that change, disagree, or hide a bad record", () => {
  const table = read<{ cases: ResolutionCase[] }>("resolutions.json");

  it("covers every row in the fixture", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const testCase of table.cases) {
    it(`${testCase.id} — ${testCase.expect}${testCase.code ? ` ${testCase.code}` : ""}`, async () => {
      const connector = pinRecordingConnector();
      const result = await guardedFetch(`https://${testCase.hostname}/v1`, {
        resolver: answeringResolver(testCase.hostname, testCase.answers),
        connector,
      });

      if (testCase.expect === "allow") {
        expect(result.ok, testCase.id).toBe(true);
      } else {
        expect(result.ok, testCase.id).toBe(false);
        if (!result.ok) expect(result.failure.code, testCase.id).toBe(testCase.code);
      }

      // The assertion that separates a defence from a detection: for every
      // reject row this is 0, so the refusal happened before anything was sent.
      expect(connector.requests.length, `${testCase.id} outbound requests`).toBe(
        testCase.connects,
      );

      if (testCase.pins !== null) {
        expect(connector.pins[0], `${testCase.id} pinned address`).toBe(testCase.pins);
      }
    });
  }

  /**
   * The limitation, asserted rather than described.
   *
   * `late-rebind` is allowed through by design — the flip happens on a lookup
   * the guard never performs, because on Workers `fetch` resolves the hostname
   * itself. What the guard CAN do is compute and hand over the address it
   * validated, and a connector that honours the pin refuses. This is the test
   * that will start failing on the day the platform makes the pin enforceable,
   * which is the only way a known gap stays known.
   */
  it("hands a pin the hosted connector cannot enforce and a pinning one can", async () => {
    const row = table.cases.find((c) => c.id === "rebind-late-flip");
    expect(row, "the fixture must keep the late-flip row").toBeDefined();

    const resolver = answeringResolver(row!.hostname, row!.answers);
    let dialled: string | null = null;

    // A connector that behaves the way the CLI's does: it dials the address it
    // was told to dial, and re-checks it at the moment of connection.
    const pinning: Connector = {
      fetch(_url, _init, pin) {
        dialled = pin.address.text;
        return Promise.resolve(new Response("{}", { status: 402 }));
      },
    };

    const result = await guardedFetch(`https://${row!.hostname}/v1`, {
      resolver,
      connector: pinning,
    });

    expect(result.ok).toBe(true);
    // The pin is the address the guard VALIDATED, not the one the third lookup
    // would have returned. Enforcing it closes the window; the hosted connector
    // ignores it and the window stays open, which guard.ts says in prose and
    // this says in a way that can fail.
    expect(dialled).toBe("93.184.216.34");
    expect(dialled).not.toBe("169.254.169.254");
  });
});

// ── redirect chains ───────────────────────────────────────────────────────

interface Hop {
  path: string;
  status: number;
  location?: string;
  body?: string;
}

interface ChainCase {
  id: string;
  url: string;
  resolver: Record<string, string[] | string[][]>;
  hops: Hop[];
  expect: "allow" | "reject";
  code: string | null;
  connects: number;
  note: string;
}

/**
 * Build the stub pair a chain row describes.
 *
 * A resolver entry may be a flat list (a stable answer) or a list of lists (an
 * answer per lookup), which is how `rebind-on-a-redirect-target` expresses a
 * flip that happens on a hop rather than on the URL the caller supplied.
 */
function chainStubs(testCase: ChainCase): {
  resolver: Resolver;
  connector: ReturnType<typeof scriptedConnector>;
} {
  const table: Record<string, string[] | ((call: number) => string[])> = {};
  for (const [host, answer] of Object.entries(testCase.resolver)) {
    if (Array.isArray(answer[0])) {
      const answers = answer as string[][];
      table[host] = (call: number) => answers[Math.min(call - 1, answers.length - 1)] ?? [];
    } else {
      table[host] = answer as string[];
    }
  }

  const routes: Record<string, { status: number; headers?: Record<string, string>; body?: string; bytes?: number }> = {};
  for (const hop of testCase.hops) {
    const host = new URL(testCase.url).hostname;
    routes[`${host}${hop.path}`] = {
      status: hop.status,
      ...(hop.location === undefined ? {} : { headers: { location: hop.location } }),
      ...(hop.body === undefined ? {} : { body: hop.body }),
    };
  }
  // The one chain that redirects into the shared hostile host reuses its
  // oversized-body route rather than restating it.
  routes["slowloris.example.net/huge"] = { status: 200, bytes: 2_000_000 };

  return { resolver: scriptedResolver(table), connector: scriptedConnector(routes) };
}

describe("redirect chains whose hostile hop is the last one", () => {
  const table = read<{ cases: ChainCase[] }>("redirect-chains.json");

  it("covers every row in the fixture", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(11);
  });

  for (const testCase of table.cases) {
    it(`${testCase.id} — ${testCase.expect}${testCase.code ? ` ${testCase.code}` : ""}`, async () => {
      const { resolver, connector } = chainStubs(testCase);
      const result = await guardedFetch(testCase.url, {
        resolver,
        connector,
        limits: { maxBodyBytes: 1024 },
      });

      if (testCase.expect === "allow") {
        expect(result.ok, `${testCase.id}: ${testCase.note}`).toBe(true);
      } else {
        expect(result.ok, `${testCase.id}: ${testCase.note}`).toBe(false);
        if (!result.ok) expect(result.failure.code, testCase.id).toBe(testCase.code);
      }

      // The hostile hop must never have been requested. Everything before it
      // was, and that is the point: hop 0 being clean says nothing.
      expect(connector.requests.length, `${testCase.id} outbound requests`).toBe(
        testCase.connects,
      );
    });
  }

  it("never exceeds the documented hop count on any row", () => {
    for (const testCase of table.cases) {
      expect(testCase.connects, testCase.id).toBeLessThanOrEqual(GUARD_LIMITS.maxRedirects + 1);
    }
  });
});

// ── amplification ─────────────────────────────────────────────────────────

interface AmplificationCase {
  id: string;
  kind:
    | "concurrent_same_target"
    | "sequential_same_target"
    | "sequential_distinct_targets"
    | "concurrent_distinct_targets";
  callers: number;
  targets: number;
  distinct_caller_keys?: boolean;
  expensive?: boolean;
  daily_limit?: number;
  on_demand?: boolean;
  outbound: number;
  spent?: number;
  note: string;
}

function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string): Promise<T | undefined> => Promise.resolve(map.get(key) as T | undefined),
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
    setAlarm: (): Promise<void> => Promise.resolve(),
  };
}

/** Real `ProbeLimiter` instances, one per name, dispatched as the runtime would. */
function limiterEnv(): Env {
  const limiters = new Map<string, ProbeLimiter>();
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      fetch: (url: string, init?: RequestInit) => {
        let limiter = limiters.get(id.name);
        if (!limiter) {
          limiter = new ProbeLimiter(
            { storage: fakeStorage() } as unknown as DurableObjectState,
            {} as Env,
          );
          limiters.set(id.name, limiter);
        }
        return limiter.fetch(new Request(url, init));
      },
    }),
  };
  return { PROBE_LIMITER: namespace } as unknown as Env;
}

const endpointName = (n: number): string => n.toString(16).padStart(32, "0");

describe("amplification — the abuse this product is most likely to commit", () => {
  const table = read<{ cases: AmplificationCase[] }>("amplification.json");

  it("covers every row in the fixture", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(7);
  });

  for (const testCase of table.cases) {
    it(`${testCase.id} — ${testCase.outbound} outbound`, async () => {
      const env = limiterEnv();
      let outbound = 0;

      const probeFn = async (): Promise<{ value: number }> => {
        outbound += 1;
        // Long enough that every concurrent caller has arrived before this
        // resolves, which is the case a counting rate limiter waves through.
        // The "expensive" rows wait longer, standing in for the trickling
        // target whose probe runs until the total budget is spent.
        await new Promise((resolve) => setTimeout(resolve, testCase.expensive ? 60 : 30));
        return { value: outbound };
      };

      const optionsFor = (caller: number, target: number) => ({
        endpointId: endpointName(target),
        ...(testCase.distinct_caller_keys === true ? { callerKey: `caller-${caller}` } : {}),
        // Every row that is not explicitly the crawler's is public-initiated.
        ...(testCase.on_demand === false ? {} : { onDemand: true as const }),
        ...(testCase.daily_limit === undefined ? {} : { onDemandLimit: testCase.daily_limit }),
        // A caller budget high enough that it is never the reason a row passes.
        callerLimit: 10_000,
      });

      switch (testCase.kind) {
        case "concurrent_same_target":
          await Promise.all(
            Array.from({ length: testCase.callers }, (_, caller) =>
              withPoliteness(env, optionsFor(caller, 0), probeFn),
            ),
          );
          break;

        case "concurrent_distinct_targets":
          await Promise.all(
            Array.from({ length: testCase.callers }, (_, caller) =>
              withPoliteness(env, optionsFor(caller, caller % testCase.targets), probeFn),
            ),
          );
          break;

        case "sequential_distinct_targets":
          for (let target = 0; target < testCase.targets; target += 1) {
            resetOnDemandMemoForTests();
            await withPoliteness(env, optionsFor(0, target), probeFn);
          }
          break;

        case "sequential_same_target":
          for (let caller = 0; caller < testCase.callers; caller += 1) {
            await withPoliteness(env, optionsFor(caller, 0), probeFn);
          }
          break;
      }

      expect(outbound, `${testCase.id}: ${testCase.note}`).toBe(testCase.outbound);
    });
  }

  /**
   * The claim the whole per-target design rests on, checked against a real
   * hostile target rather than a resolved promise: the trickling response.
   * Twenty-five callers, one endpoint, one outbound request — and the twenty-four
   * followers must not each be made to wait out the 15-second follower timeout
   * because the leader's probe was the slow one.
   */
  it("collapses concurrent callers onto one request even when the target never finishes", async () => {
    const env = limiterEnv();
    const connector = scriptedConnector({
      "slowloris.example.net/slow": { status: 200, trickle: true },
    });

    const started = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, (_, caller) =>
        withPoliteness(
          env,
          {
            endpointId: endpointName(7),
            callerKey: `caller-${caller}`,
            callerLimit: 10_000,
            onDemand: true,
          },
          () =>
            guardedFetch("https://slowloris.example.net/slow", {
              resolver: hostileResolver(),
              connector,
              limits: { totalTimeoutMs: 300, hopTimeoutMs: 200 },
            }),
        ),
      ),
    );

    // One outbound request for twenty-five callers, against a target that is
    // actively trying to hold the connection open.
    expect(connector.requests).toHaveLength(1);

    // And it was bounded: the guard's total budget ended it, so the leader did
    // not sit there for as long as the attacker wanted to trickle.
    const leader = outcomes.find((o) => !o.cached);
    expect(leader?.result?.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
