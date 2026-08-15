/**
 * Content negotiation, envelopes and error responses (SPEC §1.2, §2, §3).
 * Feature sessions call these helpers; they do not re-implement
 * negotiation, because a route that gets `Vary` wrong poisons a shared cache
 * for every other route.
 */

import type {
  Envelope,
  ErrorCode,
  ErrorEnvelope,
  Format,
  RouteContext,
  RouteMeta,
  Warning,
} from "./types.js";

export const API_VERSION = "v1" as const;

/** RFC 3339, UTC, second precision (SPEC §1.3). */
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

// ── negotiation ──────────────────────────────────────────────────────────

/**
 * Resolve the output format. Precedence (SPEC §1.2):
 *   1. `?format=` — it exists so a link can pin a representation
 *   2. a `.md` path suffix, including the `<page>/.md` convention
 *   3. an `/api/` path — JSON by construction
 *   4. the `Accept` header, by q-value; ties break json > markdown > html
 *   5. HTML, which is what a browser wanted anyway
 */
export function negotiate(url: URL, accept: string | null): Format {
  const forced = url.searchParams.get("format");
  if (forced === "json" || forced === "md" || forced === "markdown") {
    return forced === "json" ? "json" : "markdown";
  }
  if (forced === "html") return "html";

  if (url.pathname.endsWith(".md") || url.pathname.endsWith("/.md")) return "markdown";
  if (url.pathname.startsWith("/api/")) return "json";

  if (!accept) return "html";

  let best: { format: Format; q: number; rank: number } | null = null;
  const rank: Record<Format, number> = { json: 3, markdown: 2, html: 1 };

  for (const part of accept.split(",")) {
    const [rawType, ...params] = part.trim().split(";");
    const type = (rawType ?? "").trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split("=").map((s) => s.trim());
      if (k === "q") {
        const parsed = Number.parseFloat(v ?? "");
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q <= 0) continue;

    let format: Format | null = null;
    if (type === "application/json" || type === "application/*") format = "json";
    else if (type === "text/markdown") format = "markdown";
    else if (type === "text/html" || type === "text/*" || type === "*/*") format = "html";
    if (!format) continue;

    const candidate = { format, q, rank: rank[format] };
    if (!best || candidate.q > best.q || (candidate.q === best.q && candidate.rank > best.rank)) {
      best = candidate;
    }
  }

  return best?.format ?? "html";
}

/** Strip the markdown suffix so `/inspect.md` and `/inspect/.md` route as `/inspect`. */
export function stripMarkdownSuffix(pathname: string): string {
  if (pathname.endsWith("/.md")) return pathname.slice(0, -"/.md".length) || "/";
  if (pathname.endsWith(".md")) return pathname.slice(0, -".md".length) || "/";
  return pathname;
}

/**
 * The JSON mirror for a page path, or `null` when the page has none.
 *
 * ── Why this is a lookup and not a concatenation ───────────────────────────
 *
 * It used to be `` `/api/v1${page}` ``, which is right for the four tools whose
 * API mirror sits at exactly that path and wrong for everything else. We found
 * it live: **six of eleven negotiated page routes advertised a JSON alternate
 * that 404s** — `/policy`, `/compare/:category`, `/replay`, `/errors`,
 * `/crawler` and `/methodology`.
 *
 * That is a quiet failure with a loud consequence. The whole of
 * exists so an agent never has to scrape HTML; an agent doing the *correct*
 * thing — read `Link:`, follow the `application/json` alternate — got a 404 on
 * more than half the site, and the obvious fallback is to parse the HTML. The
 * Markdown alternate was correct everywhere, so nothing looked broken.
 *
 * SPEC §1.2 says the header advertises "the other two representations". A page
 * with no JSON representation therefore advertises **one** alternate, not a
 * fabricated second one. Returning `null` is what says that.
 */
function jsonMirrorFor(page: string, query: string): string | null {
  if (page === "/") return `/api/v1/meta${query}`;

  // The playground evaluates by POST; the page path is not the mirror.
  if (page === "/policy") return `/api/v1/policy/evaluate`;

  // A category is a query parameter on the Compare mirror, not a path segment.
  const category = page.match(/^\/compare\/([^/]+)$/u)?.[1];
  if (category) return `/api/v1/compare?category=${encodeURIComponent(category)}`;

  // Pages that are documents rather than views over data. `/replay` is here
  // deliberately: `/api/v1/replay/:id` and `/api/v1/replay/share` exist, but
  // neither is a mirror of this page — one is a lookup and one is a write.
  const NO_JSON_MIRROR = new Set(["/replay", "/errors", "/crawler", "/methodology"]);
  if (NO_JSON_MIRROR.has(page)) return null;

  return `/api/v1${page}${query}`;
}

/**
 * `Vary` plus the `Link: rel=alternate` headers that advertise the other
 * representations. Applied to every negotiated response — a cache that never
 * sees `Vary: Accept` will happily serve HTML to an agent.
 *
 * Exported because `ui/components/jsonld.ts` emits the same URLs as `<link>`
 * ELEMENTS in the document, for readers that never see the headers. There is
 * one derivation and both callers use it; `test/seo.test.ts` asserts the two
 * lists are equal.
 */
export function alternateUrls(pathname: string, search: string): { md: string; json: string | null } {
  const page = stripMarkdownSuffix(pathname);
  return {
    // Every page keeps the `<page>.md` form it has always advertised. The one
    // exception is the home page, which advertised `/index.md`  and has
    // always 404'd: `stripMarkdownSuffix` reduces it to `/index`, which is not
    // a declared route. `/.md` is the `<page>/.md` form SPEC §1.2 already
    // requires every route to accept, and it reduces to `/`. Found at the
    // wave-5 integration by widening the alternate check past `/api/` URLs;
    // confirmed against production, where `/index.md` returned 404 and `/.md`
    // returned the Markdown home page.
    md: page === "/" ? `/.md${search}` : `${page}.md${search}`,
    json: jsonMirrorFor(page, search),
  };
}

export function negotiationHeaders(ctx: RouteContext, headers: Headers): Headers {
  if (!ctx.route.negotiated) return headers;

  headers.set("vary", "Accept");

  const { md, json } = alternateUrls(ctx.url.pathname, ctx.url.search);

  headers.append("link", `<${md}>; rel="alternate"; type="text/markdown"`);
  if (json) headers.append("link", `<${json}>; rel="alternate"; type="application/json"`);
  return headers;
}

// ── envelopes ────────────────────────────────────────────────────────────

export function envelope<T>(
  meta: RouteMeta,
  data: T,
  opts: {
    warnings?: Warning[];
    cached?: boolean;
    cacheAgeSeconds?: number | null;
    scoreVersion?: string | null;
    tx402Version?: string | null;
  } = {},
): Envelope<T> {
  return {
    api_version: API_VERSION,
    tool: meta.tool,
    generated_at: nowIso(),
    meta: {
      implemented: meta.implemented,
      cached: opts.cached ?? false,
      cache_age_seconds: opts.cacheAgeSeconds ?? null,
      score_version: opts.scoreVersion ?? null,
      tx402_version: opts.tx402Version ?? null,
      schema: `https://tools.tx402.io/api/v1/schemas/${meta.tool}`,
    },
    warnings: opts.warnings ?? [],
    data,
  };
}

// ── responses ────────────────────────────────────────────────────────────

export function json(body: unknown, init: ResponseInit = {}, ctx?: RouteContext): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (ctx) negotiationHeaders(ctx, headers);
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { ...init, headers });
}

export function markdown(body: string, init: ResponseInit = {}, ctx?: RouteContext): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  if (ctx) negotiationHeaders(ctx, headers);
  return new Response(body.endsWith("\n") ? body : `${body}\n`, { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}, ctx?: RouteContext): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  if (ctx) negotiationHeaders(ctx, headers);
  return new Response(body, { ...init, headers });
}

export function text(body: string, contentType: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", contentType);
  return new Response(body.endsWith("\n") ? body : `${body}\n`, { ...init, headers });
}

// ── errors ───────────────────────────────────────────────────────────────

/** HTTP status per code (SPEC §3.1). Exported so `/errors` documents the real table. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_ACCEPTABLE: 406,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  URL_SCHEME_NOT_ALLOWED: 422,
  URL_USERINFO_PRESENT: 422,
  URL_BLOCKED: 422,
  URL_PRIVATE_ADDRESS: 422,
  TOO_MANY_REDIRECTS: 502,
  PROBE_TIMEOUT: 504,
  PROBE_FAILED: 502,
  RESPONSE_TOO_LARGE: 502,
  // A malformed challenge is a RESULT, not a transport failure — 200 with the
  // finding inside `data`. These three only reach here on the direct-POST path
  // where nothing at all could be parsed (SPEC §3.1).
  CHALLENGE_MALFORMED: 200,
  NOT_X402: 200,
  RATE_LIMITED: 429,
  TARGET_RATE_LIMITED: 429,
  TURNSTILE_REQUIRED: 401,
  TURNSTILE_FAILED: 403,
  ENDPOINT_OPTED_OUT: 403,
  NO_DATA: 200,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "PROBE_TIMEOUT",
  "PROBE_FAILED",
  "RATE_LIMITED",
  "TARGET_RATE_LIMITED",
  "INTERNAL",
]);

/**
 * Every blocked-URL code returns the SAME user-facing sentence. The guard must
 * not double as a network scanner for whoever is probing it;
 * `detail.stage` is the only differentiation and it is deliberately coarse.
 */
const GENERIC_URL_REFUSAL = "That URL cannot be probed.";

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: "The request could not be understood.",
  VALIDATION_FAILED: "One or more fields were invalid.",
  UNSUPPORTED_MEDIA_TYPE: "Send this request as application/json.",
  NOT_ACCEPTABLE: "No available representation matches the Accept header.",
  METHOD_NOT_ALLOWED: "That method is not allowed on this route.",
  NOT_FOUND: "Not found.",
  URL_SCHEME_NOT_ALLOWED: GENERIC_URL_REFUSAL,
  URL_USERINFO_PRESENT: "That URL carries credentials, so it will not be fetched.",
  URL_BLOCKED: GENERIC_URL_REFUSAL,
  URL_PRIVATE_ADDRESS: GENERIC_URL_REFUSAL,
  TOO_MANY_REDIRECTS: "The endpoint redirected too many times.",
  PROBE_TIMEOUT: "The endpoint did not answer in time.",
  PROBE_FAILED: "The endpoint could not be reached.",
  RESPONSE_TOO_LARGE: "The endpoint's response exceeded the size limit.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  TARGET_RATE_LIMITED: "This endpoint has been probed recently. A cached result may be available.",
  TURNSTILE_REQUIRED: "This request needs a Turnstile token.",
  TURNSTILE_FAILED: "The Turnstile token did not verify.",
  ENDPOINT_OPTED_OUT: "The operator of this endpoint has opted out.",
  NOT_IMPLEMENTED: "That is not available yet.",
  INTERNAL: "Something went wrong on our side.",
  NO_DATA: "No data yet.",
  CHALLENGE_MALFORMED: "The challenge could not be parsed.",
  NOT_X402: "That response did not carry an x402 challenge.",
};

export function errorBody(
  code: ErrorCode,
  opts: { message?: string; detail?: Record<string, unknown> | null } = {},
): ErrorEnvelope {
  return {
    api_version: API_VERSION,
    generated_at: nowIso(),
    error: {
      code,
      message: opts.message ?? MESSAGES[code] ?? "Request failed.",
      detail: opts.detail ?? null,
      retryable: RETRYABLE.has(code),
      docs: `https://tools.tx402.io/errors#${code.toLowerCase()}`,
    },
  };
}

export function errorResponse(
  code: ErrorCode,
  opts: {
    message?: string;
    detail?: Record<string, unknown> | null;
    status?: number;
    headers?: HeadersInit;
  } = {},
): Response {
  const headers = new Headers(opts.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(`${JSON.stringify(errorBody(code, opts), null, 2)}\n`, {
    status: opts.status ?? ERROR_STATUS[code],
    headers,
  });
}

// ── html escaping ────────────────────────────────────────────────────────

// Defined once, in the UI layer, so there is exactly one escaper in the repo.
export { escapeHtml } from "../ui/components/html.js";
