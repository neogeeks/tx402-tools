/**
 * Shared worker types. Sits alongside `router.ts` — a contributor
 * fills in its own `routes/<tool>.ts` and does not edit this file.
 *
 * The types here are the TypeScript face of `spec/SPEC.md`. Where the two can
 * disagree, the spec and its JSON Schemas win: they are what the CLI, the MCP
 * server and the tests all validate against.
 */

export interface Env {
  // ── bindings (wrangler.jsonc) ──
  DB: D1Database;
  PROBES: AnalyticsEngineDataset;
  CRAWL_QUEUE: Queue<CrawlMessage>;
  PROBE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;

  // ── vars ──
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  CRAWLER_ENABLED: string;
  TURNSTILE_SITE_KEY: string;
  /**
   * For the Analytics Engine SQL API, which is an account-level HTTP endpoint
   * rather than a binding. Not a secret. The `account_id` in
   * wrangler.jsonc is wrangler's own deploy-targeting field and is not readable
   * at runtime, which is why this exists separately.
   */
  CF_ACCOUNT_ID: string;

  // ── secrets (never in wrangler.jsonc) ──
  // Set with: wrangler secret put TURNSTILE_SECRET_KEY
  TURNSTILE_SECRET_KEY?: string;
  /**
   * An API token with **Account Analytics Read**, for the Analytics Engine SQL
   * API. Optional because the Worker must run without it: `queryAnalytics`
   * returns `{rows: null, error}` when it is absent, so History renders "we
   * could not ask" rather than a fabricated number.
   * Set with: wrangler secret put CF_ANALYTICS_TOKEN
   */
  CF_ANALYTICS_TOKEN?: string;
}

/** Queue payload for the crawler. Declared here so the binding types. */
export interface CrawlMessage {
  kind: "probe" | "seed" | "robots";
  endpoint_id?: string;
  url?: string;
  reason?: string;
  enqueued_at: string;
}

/** The three representations every tool route can serve (SPEC §1.2). */
export type Format = "json" | "markdown" | "html";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  /** Negotiated output format. Handlers must honour it (SPEC §1.2). */
  format: Format;
  /** Path parameters captured by the route pattern, e.g. `{ id: "abc" }`. */
  params: Record<string, string>;
  /** The route's declared identity, used to stamp the envelope. */
  route: RouteMeta;
}

export interface RouteMeta {
  /** Envelope `tool` value. */
  tool: string;
  /** False until the owning session lands. Stamped into `meta.implemented`. */
  implemented: boolean;
  /** Whether this route serves all three representations (SPEC §1.2). */
  negotiated: boolean;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: HttpMethod | HttpMethod[];
  /** Path pattern; `:name` captures a segment, a trailing `*` matches the rest. */
  pattern: string;
  meta: RouteMeta;
  handler: RouteHandler;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

// ── the error vocabulary (SPEC §3.1) ─────────────────────────────────────
// Closed on purpose. Adding a member is an addendum plus a schema bump, so a
// session cannot quietly invent an error shape that the CLI has never seen.
export const ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNSUPPORTED_MEDIA_TYPE",
  "NOT_ACCEPTABLE",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "URL_SCHEME_NOT_ALLOWED",
  "URL_USERINFO_PRESENT",
  "URL_BLOCKED",
  "URL_PRIVATE_ADDRESS",
  "TOO_MANY_REDIRECTS",
  "PROBE_TIMEOUT",
  "PROBE_FAILED",
  "RESPONSE_TOO_LARGE",
  "CHALLENGE_MALFORMED",
  "NOT_X402",
  "RATE_LIMITED",
  "TARGET_RATE_LIMITED",
  "TURNSTILE_REQUIRED",
  "TURNSTILE_FAILED",
  "ENDPOINT_OPTED_OUT",
  "NO_DATA",
  "NOT_IMPLEMENTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Warning {
  code: string;
  message: string;
}

export interface EnvelopeMeta {
  implemented: boolean;
  cached: boolean;
  cache_age_seconds: number | null;
  score_version: string | null;
  tx402_version: string | null;
  schema: string | null;
}

export interface Envelope<T> {
  api_version: "v1";
  tool: string;
  generated_at: string;
  meta: EnvelopeMeta;
  warnings: Warning[];
  data: T;
}

export interface ErrorEnvelope {
  api_version: "v1";
  generated_at: string;
  error: {
    code: ErrorCode;
    message: string;
    detail?: Record<string, unknown> | null;
    retryable: boolean;
    docs?: string | null;
  };
}
