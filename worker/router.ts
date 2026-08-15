/**
 * THE ROUTE TABLE.
 *
 * Every route the Worker answers is declared here, in one list, with its
 * identity and whether it serves all three representations (SPEC §1.2).
 *
 * To implement a route: edit `worker/routes/<tool>.ts` and export a handler
 * with the same name. Nothing here changes. A new route is a spec change
 * first and a line in this table second — the frozen schemas in
 * `spec/schemas/` are what the API, the CLI, the MCP server and the tests all
 * validate against, so a route answering a shape nothing has agreed on is a
 * route nothing can consume.
 *
 * `negotiated` marks the routes that serve HTML, Markdown and JSON from one
 * computation. Everything under `/api/v1/` is JSON by construction, and its
 * page counterpart carries the other two.
 */

import { errorResponse, negotiate, stripMarkdownSuffix } from "./http.js";
import type { Env, HttpMethod, Route, RouteContext, RouteMeta } from "./types.js";

import { home } from "./routes/index.js";
import { inspect } from "./routes/inspect.js";
import { verify } from "./routes/verify.js";
import { policy } from "./routes/policy.js";
import { history } from "./routes/history.js";
import { compare, categories } from "./routes/compare.js";
import { replay } from "./routes/replay.js";
import { methodology } from "./routes/methodology.js";
import { crawlerInfo, optout } from "./routes/crawler-info.js";
import { errorsPage } from "./routes/errors-page.js";
import { privacy } from "./routes/privacy.js";
import { share } from "./routes/share.js";
import { endpoints } from "./routes/endpoints.js";
import { facilitators } from "./routes/facilitators.js";
import { claim, appeal } from "./routes/claim.js";
import { health, meta } from "./routes/health.js";
import { schemaIndex, schemaOne } from "./routes/schemas.js";
import { assets } from "./routes/assets.js";
import { llmsTxt, robots, securityTxt, sitemap } from "./routes/well-known.js";

/** Shorthand for a route's identity. */
const m = (tool: string, negotiated = true): RouteMeta => ({ tool, implemented: true, negotiated });

const GET = "GET" as const;
const POST = "POST" as const;

export const ROUTES: Route[] = [
  // ── pages (three representations each — SPEC §1.2) ─────────────────────
  { method: GET, pattern: "/", meta: m("home"), handler: home },
  { method: [GET, POST], pattern: "/inspect", meta: m("inspect"), handler: inspect },
  { method: [GET, POST], pattern: "/verify", meta: m("verify"), handler: verify },
  { method: [GET, POST], pattern: "/policy", meta: m("policy"), handler: policy },
  { method: GET, pattern: "/history", meta: m("history"), handler: history },
  { method: GET, pattern: "/compare", meta: m("compare"), handler: compare },
  { method: GET, pattern: "/compare/:category", meta: m("compare"), handler: compare },
  { method: GET, pattern: "/replay", meta: m("replay"), handler: replay },
  { method: GET, pattern: "/methodology", meta: m("methodology"), handler: methodology },
  { method: GET, pattern: "/crawler", meta: m("crawler"), handler: crawlerInfo },
  { method: GET, pattern: "/errors", meta: m("errors"), handler: errorsPage },
  { method: GET, pattern: "/privacy", meta: m("privacy"), handler: privacy },
  { method: GET, pattern: "/s/:id", meta: m("share"), handler: share },

  // ── files (no negotiation) ─────────────────────────────────────────────
  { method: GET, pattern: "/robots.txt", meta: m("robots", false), handler: robots },
  { method: GET, pattern: "/llms.txt", meta: m("llms", false), handler: llmsTxt },
  { method: GET, pattern: "/sitemap.xml", meta: m("sitemap", false), handler: sitemap },
  {
    method: GET,
    pattern: "/.well-known/security.txt",
    meta: m("security", false),
    handler: securityTxt,
  },
  { method: GET, pattern: "/assets/:name", meta: m("assets", false), handler: assets },

  // ── service API ────────────────────────────────────────────────────────
  { method: GET, pattern: "/api/v1/health", meta: m("health", false), handler: health },
  { method: GET, pattern: "/api/v1/meta", meta: m("meta", false), handler: meta },
  { method: GET, pattern: "/api/v1/schemas", meta: m("schemas", false), handler: schemaIndex },
  { method: GET, pattern: "/api/v1/schemas/:name", meta: m("schemas", false), handler: schemaOne },

  // ── tool API ───────────────────────────────────────────────────────────
  { method: [GET, POST], pattern: "/api/v1/inspect", meta: m("inspect", false), handler: inspect },
  { method: POST, pattern: "/api/v1/verify", meta: m("verify", false), handler: verify },
  {
    method: POST,
    pattern: "/api/v1/policy/evaluate",
    meta: m("policy", false),
    handler: policy,
  },
  { method: GET, pattern: "/api/v1/history", meta: m("history", false), handler: history },
  { method: GET, pattern: "/api/v1/compare", meta: m("compare", false), handler: compare },
  { method: GET, pattern: "/api/v1/categories", meta: m("compare", false), handler: categories },
  { method: GET, pattern: "/api/v1/endpoints", meta: m("endpoints", false), handler: endpoints },
  {
    method: GET,
    pattern: "/api/v1/facilitators",
    meta: m("facilitators", false),
    handler: facilitators,
  },

  // ── replay + share ─────────────────────────────────────────────────────
  { method: POST, pattern: "/api/v1/replay/share", meta: m("replay", false), handler: replay },
  { method: GET, pattern: "/api/v1/replay/:id", meta: m("replay", false), handler: replay },
  { method: POST, pattern: "/api/v1/share", meta: m("share", false), handler: share },
  { method: GET, pattern: "/api/v1/share/:id", meta: m("share", false), handler: share },

  // ── watch + accounts: REMOVED ──────────────────────────────────────────
  // `/watch`, `/api/v1/watch`, `/api/v1/auth/*` and `/api/v1/channels*` were
  // declared here. Watch was cut in wave 3, and
  // accounts went with it: they existed solely to deliver a Watch alert, so keeping sign-in would have meant
  // identifying a person
  // for nothing. **Nothing in this product authenticates a caller, and no route
  // here should start.** Re-adding an authenticated route is a plan decision
  // and a spec addendum, not a line in this table.

  // ── trust surface + opt-out ─────────────────────────────────
  { method: POST, pattern: "/api/v1/claim", meta: m("claim", false), handler: claim },
  { method: GET, pattern: "/api/v1/claim/:id", meta: m("claim", false), handler: claim },
  { method: POST, pattern: "/api/v1/claim/:id/verify", meta: m("claim", false), handler: claim },
  { method: POST, pattern: "/api/v1/appeal", meta: m("appeal", false), handler: appeal },
  { method: POST, pattern: "/api/v1/optout", meta: m("optout", false), handler: optout },
];

// ── matching ─────────────────────────────────────────────────────────────

interface Match {
  route: Route;
  params: Record<string, string>;
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = pathname.split("/");
  if (p.length !== s.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i] ?? "";
    const val = s[i] ?? "";
    if (seg.startsWith(":")) {
      if (val === "") return null;
      params[seg.slice(1)] = decodeURIComponent(val);
    } else if (seg !== val) {
      return null;
    }
  }
  return params;
}

function methodsOf(route: Route): HttpMethod[] {
  return Array.isArray(route.method) ? route.method : [route.method];
}

/** Find the route for a path, ignoring method. Returns null when nothing matches. */
function findByPath(pathname: string): Route[] {
  return ROUTES.filter((r) => matchPattern(r.pattern, pathname) !== null);
}

function resolve(pathname: string, method: string): Match | { allow: string[] } | null {
  const candidates = findByPath(pathname);
  if (candidates.length === 0) return null;

  const wanted = method === "HEAD" ? "GET" : method;
  for (const route of candidates) {
    if (methodsOf(route).includes(wanted as HttpMethod)) {
      return { route, params: matchPattern(route.pattern, pathname) ?? {} };
    }
  }

  const allow = [...new Set(candidates.flatMap(methodsOf))];
  if (allow.includes("GET")) allow.push("HEAD");
  allow.push("OPTIONS");
  return { allow };
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const format = negotiate(url, request.headers.get("accept"));
  // `/inspect.md` and `/inspect/.md` are the same route as `/inspect`; the
  // suffix only chose the representation (SPEC §1.2).
  const pathname = stripMarkdownSuffix(url.pathname);

  const resolved = resolve(pathname, request.method);

  if (resolved === null) {
    // Not a declared route: hand it to the static assets binding, which owns
    // fonts, icons and anything else in./public.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return errorResponse("NOT_FOUND");
  }

  if ("allow" in resolved) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: resolved.allow.join(", ") } });
    }
    return errorResponse("METHOD_NOT_ALLOWED", { headers: { allow: resolved.allow.join(", ") } });
  }

  const routeCtx: RouteContext = {
    request,
    env,
    ctx,
    url,
    format,
    params: resolved.params,
    route: resolved.route.meta,
  };

  const response = await resolved.route.handler(routeCtx);

  // HEAD is GET without a body. Handled centrally so no handler has to think
  // about it and none of them can get the headers subtly different.
  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }

  return response;
}
