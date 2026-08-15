/**
 * In-process stand-ins for the Durable Object and D1 bindings — added.
 *
 * `test/helpers.ts`'s `mockEnv` is deliberately minimal: its D1 answers every
 * query with the same row and its `PROBE_LIMITER` returns 501, which is right
 * for the router tests (they must not depend on storage) and useless for a
 * route whose whole job is to probe once, cache the result and write the scan
 * into the corpus.
 *
 * So these are **fakes, not mocks**: they hold state and behave, so a test can
 * assert on what actually ended up in the corpus rather than on which functions
 * were called. The `ProbeLimiter` here is the real class from
 * `worker/do/probe-limiter.ts` driven against fake storage, exactly as
 * `test/politeness.test.ts` does — the politeness decision logic under test is
 * its own code, not a re-description of it.
 *
 * The D1 fake is not a SQL engine. It recognises the specific statements this
 * repository issues and applies them to maps. That is a real limitation and it
 * is the right trade: a hand-written matcher that fails loudly on an unknown
 * statement is more honest than a half-correct SQL parser that silently does
 * the wrong thing.
 *
 *  and should reuse this rather than hand-rolling a third set.
 */

import { ProbeLimiter } from "../worker/do/probe-limiter.js";
import type { Env } from "../worker/types.js";

// ── the Durable Object ────────────────────────────────────────────────────

function fakeStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    map,
    get alarmAt() {
      return alarm;
    },
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
    setAlarm: (at: number): Promise<void> => {
      alarm = at;
      return Promise.resolve();
    },
  };
}

/** A namespace whose objects are real `ProbeLimiter` instances, one per name. */
export function fakeLimiterNamespace(): Env["PROBE_LIMITER"] {
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

  return namespace as unknown as Env["PROBE_LIMITER"];
}

// ── D1 ────────────────────────────────────────────────────────────────────

export interface FakeCorpus {
  endpoints: Map<string, Record<string, unknown>>;
  terms: Map<string, Record<string, unknown>>;
  scans: Record<string, unknown>[];
  shares: Map<string, Record<string, unknown>>;
  /** Rows `readHistory` will return for `term_changes`. Empty by default. */
  changes: Record<string, unknown>[];
  /** Every statement issued, in order — for asserting what a route did. */
  statements: { sql: string; params: unknown[] }[];
  /** Flip to make every write fail, so the warning path can be exercised. */
  failWrites: boolean;
}

export function newCorpus(): FakeCorpus {
  return {
    endpoints: new Map(),
    terms: new Map(),
    scans: [],
    shares: new Map(),
    changes: [],
    statements: [],
    failWrites: false,
  };
}

type Row = Record<string, unknown>;

function applyEndpointInsert(corpus: FakeCorpus, p: unknown[]): void {
  const [id, canonical, url, origin, host, path, status, firstSeen, lastSeen, scanId, createdAt, updatedAt] = p;
  const existing = corpus.endpoints.get(String(id));
  if (existing) {
    existing.last_seen = lastSeen;
    existing.last_scan_id = scanId;
    existing.scan_count = Number(existing.scan_count ?? 0) + 1;
    existing.status = status;
    existing.updated_at = updatedAt;
    return;
  }
  corpus.endpoints.set(String(id), {
    id,
    canonical_url: canonical,
    url,
    origin,
    host,
    path,
    resource_type: "http",
    discovery_source: "human",
    status,
    robots_allowed: 1,
    first_seen: firstSeen,
    last_seen: lastSeen,
    last_scan_id: scanId,
    scan_count: 1,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

const TERMS_COLUMNS = [
  "endpoint_id", "x402_version", "wire_form", "scheme", "network", "asset_address", "asset_symbol",
  "asset_decimals", "amount_atomic", "amount_decimal", "pay_to", "pay_to_dynamic",
  "max_timeout_seconds", "facilitator", "resource", "mime_type", "description",
  "requirement_count", "extra_json", "challenge_hash", "challenge_json",
  "score", "band", "score_version", "signals_json", "observed_at", "scan_id", "updated_at",
] as const;

const SCAN_COLUMNS = [
  "id", "endpoint_id", "requested_at", "completed_at", "source", "retained_reason",
  "http_status", "wire_form", "x402_version", "challenge_valid",
  "challenge_hash", "challenge_json", "signals_json", "score", "band", "score_version",
  "latency_ms", "redirect_count", "tls_protocol", "bytes_read", "created_at",
] as const;

function zip(columns: readonly string[], params: unknown[]): Row {
  const row: Row = {};
  columns.forEach((column, i) => {
    row[column] = params[i] ?? null;
  });
  return row;
}

class FakeStatement {
  #params: unknown[] = [];

  constructor(
    private readonly corpus: FakeCorpus,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): FakeStatement {
    this.#params = params;
    return this;
  }

  get params(): unknown[] {
    return this.#params;
  }

  get statement(): string {
    return this.sql;
  }

  async first<T>(): Promise<T | null> {
    this.corpus.statements.push({ sql: this.sql, params: this.#params });

    if (this.sql.includes("FROM endpoints e")) {
      const endpoint = this.corpus.endpoints.get(String(this.#params[0]));
      if (!endpoint) return null;
      const terms = this.corpus.terms.get(String(this.#params[0]));
      return {
        first_seen: endpoint.first_seen,
        last_seen: endpoint.last_seen,
        scan_count: endpoint.scan_count,
        challenge_hash: terms?.challenge_hash ?? null,
      } as T;
    }

    if (this.sql.includes("FROM share_links")) {
      return (this.corpus.shares.get(String(this.#params[0])) ?? null) as T | null;
    }

    throw new Error(`fake D1: unrecognised first() statement:\n${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    this.corpus.statements.push({ sql: this.sql, params: this.#params });

    if (this.sql.includes("FROM term_changes")) {
      return { results: this.corpus.changes as T[], success: true, meta: {} };
    }
    if (this.sql.includes("FROM facilitators")) {
      // Empty, so `loadFacilitators` falls back to the bundled list — which is
      // exactly what a freshly migrated database does before the crawler seeds it.
      return { results: [], success: true, meta: {} };
    }

    throw new Error(`fake D1: unrecognised all() statement:\n${this.sql}`);
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    this.corpus.statements.push({ sql: this.sql, params: this.#params });
    if (this.corpus.failWrites) throw new Error("fake D1: writes disabled for this test");

    if (this.sql.includes("INSERT INTO endpoints")) {
      applyEndpointInsert(this.corpus, this.#params);
    } else if (this.sql.includes("INSERT INTO terms_current")) {
      this.corpus.terms.set(String(this.#params[0]), zip(TERMS_COLUMNS, this.#params));
    } else if (this.sql.includes("INSERT INTO scans")) {
      this.corpus.scans.push(zip(SCAN_COLUMNS, this.#params));
    } else if (this.sql.includes("INSERT INTO share_links")) {
      const [id, endpointId, payload, createdAt, expiresAt] = this.#params;
      this.corpus.shares.set(String(id), {
        id,
        kind: "inspect",
        endpoint_id: endpointId,
        payload_json: payload,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        view_count: 0,
      });
    } else if (this.sql.includes("UPDATE share_links SET view_count")) {
      const row = this.corpus.shares.get(String(this.#params[0]));
      if (row) row.view_count = Number(row.view_count ?? 0) + 1;
    } else {
      throw new Error(`fake D1: unrecognised run() statement:\n${this.sql}`);
    }

    return { success: true, meta: {} };
  }
}

export function fakeD1(corpus: FakeCorpus): Env["DB"] {
  const db = {
    prepare: (sql: string) => new FakeStatement(corpus, sql),
    batch: async (statements: FakeStatement[]) => {
      // D1 runs a batch in one transaction, so a failure leaves nothing behind.
      if (corpus.failWrites) throw new Error("fake D1: writes disabled for this test");
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
  return db as unknown as Env["DB"];
}
