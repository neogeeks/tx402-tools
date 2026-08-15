/**
 * A crawler `Env` whose parts are real wherever it matters.
 *
 *   DB real SQLite with both migrations applied (`d1-sqlite.ts`)
 *   PROBE_LIMITER the real `ProbeLimiter` class over an in-process storage
 *                  fake, exactly as `test/politeness.test.ts` drives it
 *   PROBES a recording stub — Analytics Engine has no local emulation,
 *                  and what the tests need to assert is *that a point was
 *                  written and what was in it*
 *   CRAWL_QUEUE a recording stub, so a test can assert what was enqueued
 *
 * The politeness cache being real is the point: the crawler must go through
 * `withPoliteness` rather than calling `probe` directly, and a mocked limiter
 * would let a regression through that the production path would not.
 */

import { ProbeLimiter } from "../worker/do/probe-limiter.js";
import type { CrawlMessage, Env } from "../worker/types.js";
import { createTestDb, type TestDatabase } from "./d1-sqlite.js";

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

function limiterNamespace(): Env["PROBE_LIMITER"] {
  const limiters = new Map<string, ProbeLimiter>();

  return {
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
  } as unknown as Env["PROBE_LIMITER"];
}

export interface AnalyticsPoint {
  indexes?: string[];
  blobs?: (string | null)[];
  doubles?: number[];
}

export interface CrawlerTestEnv {
  env: Env;
  database: TestDatabase;
  /** Every Analytics Engine datapoint written, in order. */
  points: AnalyticsPoint[];
  /** Every message sent to the crawl queue, in order. */
  enqueued: CrawlMessage[];
  close(): void;
}

export function createCrawlerEnv(): CrawlerTestEnv {
  const database = createTestDb();
  const points: AnalyticsPoint[] = [];
  const enqueued: CrawlMessage[] = [];

  const env = {
    DB: database.db,
    PROBES: {
      writeDataPoint: (point: AnalyticsPoint) => {
        points.push(point);
      },
    },
    CRAWL_QUEUE: {
      send: (body: CrawlMessage) => {
        enqueued.push(body);
        return Promise.resolve();
      },
      sendBatch: (messages: { body: CrawlMessage }[]) => {
        for (const message of messages) enqueued.push(message.body);
        return Promise.resolve();
      },
    } as unknown as Env["CRAWL_QUEUE"],
    PROBE_LIMITER: limiterNamespace(),
    ENVIRONMENT: "test",
    PUBLIC_ORIGIN: "https://tools.tx402.io",
    CRAWLER_ENABLED: "1",
    TURNSTILE_SITE_KEY: "",
  } as unknown as Env;

  return {
    env,
    database,
    points,
    enqueued,
    close: () => database.close(),
  };
}

/** A queue batch whose ack/retry calls are observable. */
export function fakeBatch(messages: CrawlMessage[]): {
  batch: MessageBatch<CrawlMessage>;
  acked: number[];
  retried: number[];
} {
  const acked: number[] = [];
  const retried: number[] = [];

  const batch = {
    queue: "tx402-tools-crawl",
    messages: messages.map((body, index) => ({
      id: `m${index}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => acked.push(index),
      retry: () => retried.push(index),
    })),
    ackAll: () => {
      messages.forEach((_, index) => acked.push(index));
    },
    retryAll: () => {
      messages.forEach((_, index) => retried.push(index));
    },
  } as unknown as MessageBatch<CrawlMessage>;

  return { batch, acked, retried };
}
