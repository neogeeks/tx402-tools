import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Env } from "../worker/types.js";

/**
 * A mock Env that behaves like the real bindings for the paths the router
 * exercises, and fails loudly for the ones it should not touch.
 *
 * `ASSETS` returns 404 so the router's fallthrough is actually tested rather
 * than being papered over by a mock that says yes to everything.
 */
export function mockEnv(overrides: Partial<Env> = {}): Env {
  const analytics: unknown[] = [];
  const queued: unknown[] = [];

  return {
    DB: {
      prepare: () => ({
        first: async () => ({ ok: 1 }),
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
        bind: function bind() {
          return this;
        },
      }),
    } as unknown as Env["DB"],

    PROBES: {
      writeDataPoint: (point: unknown) => {
        analytics.push(point);
      },
    },

    CRAWL_QUEUE: {
      send: async (msg: unknown) => {
        queued.push(msg);
      },
      sendBatch: async () => undefined,
    } as unknown as Env["CRAWL_QUEUE"],

    PROBE_LIMITER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response(null, { status: 501 }) }),
    } as unknown as Env["PROBE_LIMITER"],

    ASSETS: {
      fetch: async () => new Response("not found", { status: 404 }),
    } as unknown as Env["ASSETS"],

    ENVIRONMENT: "test",
    PUBLIC_ORIGIN: "https://tools.tx402.io",
    CRAWLER_ENABLED: "0",
    TURNSTILE_SITE_KEY: "",
    // Present because the deployed Worker always has it (wrangler.jsonc vars).
    // CF_ANALYTICS_TOKEN is deliberately absent: the Worker must behave
    // correctly without it, rendering "we could not ask" rather than a number.
    CF_ACCOUNT_ID: "test-account",
    ...overrides,
  };
}

export function mockCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://tools.tx402.io${path}`, init);
}

/**
 * `res.json` with the shape the caller expects.
 *
 * The assertion here is the only one in the test suite: the real checking is
 * `validateAgainst`, which runs the response through its frozen JSON Schema.
 * A TypeScript type on a parsed response proves nothing about the wire format.
 */
export function json<T>(res: Response): Promise<T> {
  return res.json<T>();
}

// ── schema validation, shared with `pnpm schema:check` ───────────────────

const schemasDir = join(process.cwd(), "spec", "schemas");

function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const file of readdirSync(schemasDir).filter((f: string) => f.endsWith(".json"))) {
    const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8")) as { $id: string };
    ajv.addSchema(schema, schema.$id);
  }
  return ajv;
}

const ajv = buildAjv();

/** Validate a value against a frozen schema by name, e.g. "inspect". */
export function validateAgainst(name: string, value: unknown): { ok: boolean; errors: string } {
  const validate = ajv.getSchema(`https://tools.tx402.io/api/v1/schemas/${name}`);
  if (!validate) return { ok: false, errors: `no schema named ${name}` };
  const ok = validate(value) as boolean;
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  return { ok, errors };
}

export function hasSchema(name: string): boolean {
  return ajv.getSchema(`https://tools.tx402.io/api/v1/schemas/${name}`) !== undefined;
}
