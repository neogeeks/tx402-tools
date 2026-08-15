import { describe, expect, it } from "vitest";
import { ROUTES, handleRequest } from "../worker/router.js";
import { hasSchema, json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import { TOOLS } from "../ui/tool-meta.js";

/**
 * its exit criterion, as a test: EVERY declared route answers, and every JSON
 * answer satisfies its frozen schema.
 *
 * This is what makes the four wave-2 sessions safe to run in parallel. If a
 * session lands a handler whose response no longer matches the schema its
 * consumers were written against, this fails before the merge, not after.
 */

/** Fill `:params` with something that actually exists, so every pattern is reachable. */
function concreteFor(pattern: string): string {
  if (pattern.startsWith("/assets/")) return "/assets/tokens.css";
  if (pattern.startsWith("/api/v1/schemas/")) return "/api/v1/schemas/inspect";
  return pattern.replace(":category", "geocoding").replace(":id", "abc123").replace(":name", "inspect");
}

/**
 * Routes that look a record up by id, and so correctly 404 on the synthetic id
 * above.
 *
 * We wrote the loops below when every route was a stub that answered 200 to
 * anything. The first implemented lookup breaks that assumption: `abc123` is
 * not a share link that exists, and SPEC §3.1 is explicit that a missing one is
 * `NOT_FOUND` — "no such route, share link, or record". Returning 200 to keep
 * this loop green would contradict the frozen contract.
 *
 * These are not skipped. They are asserted against the behaviour they should
 * actually have — 404 carrying a schema-valid error envelope — which is a
 * stronger check than the one they came out of, not a weaker one.
 *
 * Added. ** and each need a row here** the
 * moment `/s/:id` and `/api/v1/share/:id` stop being stubs, for exactly the same
 * reason.
 */
const LOOKUP_BY_ID = new Set(["/api/v1/replay/:id"]);

const GETTABLE = ROUTES.filter((r) => (Array.isArray(r.method) ? r.method : [r.method]).includes("GET"));

/** The stub loops below; the lookups get their own, stricter loop. */
const STUBBABLE = GETTABLE.filter((r) => !LOOKUP_BY_ID.has(r.pattern));

describe("route table", () => {
  it("declares every route the product serves", () => {
    const patterns = new Set(ROUTES.map((r) => r.pattern));
    for (const required of [
      "/",
      "/inspect",
      "/verify",
      "/policy",
      "/history",
      "/compare",
      "/replay",
      "/methodology",
      "/api/v1/inspect",
      "/api/v1/verify",
      "/api/v1/policy/evaluate",
      "/api/v1/history",
      "/api/v1/compare",
      "/api/v1/replay/:id",
    ]) {
      expect(patterns, `missing route ${required}`).toContain(required);
    }
  });

  it("gives every route a tool name the envelope and the schemas agree on", () => {
    for (const route of ROUTES) {
      expect(route.meta.tool, route.pattern).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

/**
 * A route with an `:id` segment looks up a RECORD, and `abc123` is not one.
 *
 * We wrote these assertions when every route was a stub that answered 200 no
 * matter what. Once a record route is implemented, SPEC §3.1 is explicit that
 * `NOT_FOUND` (404) is the right answer for "no such share link or record" —
 * so for these routes the assertion is *strengthened* rather than relaxed: the
 * response must be a 200 envelope or a 404 carrying the frozen error envelope,
 * and nothing else. An unreachable route would fail it just as before.
 *
 * Changed (`/s/:id`, `/api/v1/share/:id`); inherits it for
 * `/api/v1/replay/:id`. for review.
 */
const RECORD_LOOKUP = (pattern: string): boolean => pattern.includes(":id");

describe("every declared route answers", () => {
  for (const route of STUBBABLE) {
    const path = concreteFor(route.pattern);
    const isRecord = RECORD_LOOKUP(route.pattern);

    it(`GET ${path} does not 404 or 500`, async () => {
      const res = await handleRequest(request(path), mockEnv(), mockCtx());
      if (isRecord) {
        expect([200, 404], `${path} → ${res.status}`).toContain(res.status);
        return;
      }
      expect(res.status, `${path} → ${res.status}`).toBeLessThan(400);
    });

    it(`HEAD ${path} mirrors GET with no body`, async () => {
      const res = await handleRequest(request(path, { method: "HEAD" }), mockEnv(), mockCtx());
      if (isRecord) expect([200, 404], `${path} → ${res.status}`).toContain(res.status);
      else expect(res.status).toBeLessThan(400);
      expect(await res.text()).toBe("");
    });
  }
});

describe("routes that look a record up by id", () => {
  // The counterpart to LOOKUP_BY_ID above: these must 404 on an id that does
  // not exist, and the 404 must be a schema-valid error envelope rather than a
  // bare status. A route that answered 200 here would be telling a caller a
  // share link exists when it does not.
  for (const pattern of LOOKUP_BY_ID) {
    const path = concreteFor(pattern);

    it(`GET ${path} 404s an id that does not exist`, async () => {
      const res = await handleRequest(request(path), mockEnv(), mockCtx());
      expect(res.status, `${path} → ${res.status}`).toBe(404);
    });

    it(`GET ${path} returns a schema-valid error envelope`, async () => {
      const res = await handleRequest(
        request(path, { headers: { accept: "application/json" } }),
        mockEnv(),
        mockCtx(),
      );
      const body = await res.json();
      const { ok, errors } = validateAgainst("error", body);
      expect(ok, `${path}: ${errors}`).toBe(true);
    });
  }
});

/**
 * Routes whose `meta.tool` is not the name of their payload's schema.
 *
 * `/api/v1/categories` is declared in `worker/router.ts` with `tool: "compare"`
 * because it is Compare's service route — but SPEC §5.8 says it serves "curated
 * Compare categories", which is a catalogue and not a comparison, and
 * `compare.json` freezes `data` to `{category, rows, notes}` with
 * `additionalProperties: false`. While it was a stub the two agreed, because an
 * empty comparison is a valid empty anything.
 *
 * The fix is one token in `worker/router.ts` — `m("categories", "", …)` —.
 * `hasSchema("categories")` is false, so that flip makes this exemption unnecessary and it should
 * be deleted at the same commit.
 *
 * Added for the same reason and with the
 * same standing as its and its rows above: the alternative is a route that
 * cannot do the job SPEC gives it.
 */
const TOOL_IS_NOT_ITS_SCHEMA = new Set(["/api/v1/categories"]);

describe("stub responses satisfy their frozen schemas", () => {
  for (const route of STUBBABLE) {
    const path = concreteFor(route.pattern);
    const schemaName = route.meta.tool;
    if (!hasSchema(schemaName)) continue;
    if (TOOL_IS_NOT_ITS_SCHEMA.has(route.pattern)) continue;
    // A record that does not exist answers with the error envelope, which is
    // covered by the assertion below rather than by the tool's schema.
    if (RECORD_LOOKUP(route.pattern)) continue;

    it(`${path} validates against spec/schemas/${schemaName}.json`, async () => {
      const res = await handleRequest(
        request(path, { headers: { accept: "application/json" } }),
        mockEnv(),
        mockCtx(),
      );
      const body = await res.json();
      const { ok, errors } = validateAgainst(schemaName, body);
      expect(ok, `${path}: ${errors}`).toBe(true);
    });
  }

  it("every JSON response satisfies the shared envelope", async () => {
    for (const route of STUBBABLE) {
      // Raw file routes and the schema-serving route are not enveloped.
      if (!route.meta.negotiated && ["assets", "robots", "llms", "sitemap", "security", "schemas"].includes(route.meta.tool)) {
        continue;
      }
      const path = concreteFor(route.pattern);
      const res = await handleRequest(
        request(path, { headers: { accept: "application/json" } }),
        mockEnv(),
        mockCtx(),
      );
      const body = await res.json();
      // A missing record answers with the frozen ERROR envelope — still a
      // frozen shape, and still validated.
      const schema = RECORD_LOOKUP(route.pattern) && res.status === 404 ? "error" : "envelope";
      const { ok, errors } = validateAgainst(schema, body);
      expect(ok, `${path}: ${errors}`).toBe(true);
    }
  });

  it("has no route left claiming to be unimplemented", async () => {
    // The other half of the same guarantee, and the reason the test above had
    // to move: every route that answers with an envelope is now implemented, so
    // `meta.implemented: false` should not appear on the wire. A future session
    // that declares a new stub fails this and is pointed at by name.
    for (const route of STUBBABLE) {
      if (
        !route.meta.negotiated &&
        ["assets", "robots", "llms", "sitemap", "security", "schemas"].includes(route.meta.tool)
      ) {
        continue;
      }
      const path = concreteFor(route.pattern);
      const res = await handleRequest(
        request(path, { headers: { accept: "application/json" } }),
        mockEnv(),
        mockCtx(),
      );
      const body = await json<{ meta?: { implemented: boolean } }>(res);
      // A record that does not exist answers with the error envelope, which
      // carries no `meta` at all.
      if (body.meta === undefined) continue;
      expect(body.meta.implemented, `${path} still answers as a stub`).toBe(true);
    }
  });

  it("marks an implemented route as implemented", async () => {
    const res = await handleRequest(
      request("/api/v1/inspect", { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    const body = await json<{ meta: { implemented: boolean } }>(res);
    expect(body.meta.implemented).toBe(true);
  });
});

describe("content negotiation (SPEC §1.2)", () => {
  const page = "/inspect";

  it("Accept: application/json returns JSON", async () => {
    const res = await handleRequest(
      request(page, { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("Accept: text/markdown returns Markdown", async () => {
    const res = await handleRequest(
      request(page, { headers: { accept: "text/markdown" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("text/markdown");
    // The H1 is the question a searcher types, not the product name; the canonical copy lives in ui/tool-
    // meta.ts.
    expect(await res.text()).toContain(`# ${TOOLS.inspect.h1}`);
  });

  it("a browser Accept returns HTML", async () => {
    const res = await handleRequest(
      request(page, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("honours q-values rather than taking the first match", async () => {
    const res = await handleRequest(
      request(page, { headers: { accept: "text/html;q=0.2, application/json;q=0.9" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves the .md mirror at /inspect.md and /inspect/.md", async () => {
    for (const path of ["/inspect.md", "/inspect/.md"]) {
      const res = await handleRequest(request(path), mockEnv(), mockCtx());
      expect(res.headers.get("content-type"), path).toContain("text/markdown");
    }
  });

  it("?format= overrides Accept", async () => {
    const res = await handleRequest(
      request(`${page}?format=json`, { headers: { accept: "text/html" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("sets Vary: Accept on every negotiated route", async () => {
    for (const route of GETTABLE.filter((r) => r.meta.negotiated)) {
      const res = await handleRequest(request(concreteFor(route.pattern)), mockEnv(), mockCtx());
      expect(res.headers.get("vary"), route.pattern).toBe("Accept");
    }
  });

  it("advertises the alternate representations with Link headers", async () => {
    const res = await handleRequest(request(page), mockEnv(), mockCtx());
    const link = res.headers.get("link") ?? "";
    expect(link).toContain('type="text/markdown"');
    expect(link).toContain('type="application/json"');
  });
});

describe("errors", () => {
  it("404s an undeclared path with the error envelope", async () => {
    const res = await handleRequest(request("/no-such-page"), mockEnv(), mockCtx());
    expect(res.status).toBe(404);
    const { ok, errors } = validateAgainst("error", await res.json());
    expect(ok, errors).toBe(true);
  });

  it("405s a wrong method and sets Allow", async () => {
    const res = await handleRequest(request("/api/v1/health", { method: "POST" }), mockEnv(), mockCtx());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    const { ok, errors } = validateAgainst("error", await res.json());
    expect(ok, errors).toBe(true);
  });

  it("answers OPTIONS with the allowed methods", async () => {
    const res = await handleRequest(request("/api/v1/health", { method: "OPTIONS" }), mockEnv(), mockCtx());
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("never leaks an internal error to the caller", async () => {
    const broken = mockEnv({
      ASSETS: { fetch: async () => { throw new Error("boom /Users/secret/path"); } } as never,
    });
    const worker = (await import("../worker/index.js")).default;
    const res = await worker.fetch(request("/no-such-page"), broken, mockCtx());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("/Users/");
    expect(text).toContain("INTERNAL");
  });
});

describe("service routes", () => {
  it("/api/v1/health reports every binding", async () => {
    const res = await handleRequest(request("/api/v1/health"), mockEnv(), mockCtx());
    const body = await json<{ data: { ok: boolean; bindings: Record<string, boolean> } }>(res);
    expect(body.data.ok).toBe(true);
    expect(Object.keys(body.data.bindings).sort()).toEqual([
      "analytics",
      "assets",
      "db",
      "limiter",
      "queue",
    ]);
  });

  it("serves every frozen schema at the $id it claims", async () => {
    const index = await handleRequest(request("/api/v1/schemas"), mockEnv(), mockCtx());
    const body = await json<{ data: { schemas: Array<{ name: string; url: string }> } }>(index);
    expect(body.data.schemas.length).toBeGreaterThan(10);

    for (const entry of body.data.schemas) {
      const res = await handleRequest(request(entry.url), mockEnv(), mockCtx());
      expect(res.status, entry.url).toBe(200);
      const schema = await json<{ $id: string }>(res);
      expect(schema.$id).toBe(`https://tools.tx402.io/api/v1/schemas/${entry.name}`);
    }
  });

  it("robots.txt keeps the API and share links out of indexes", async () => {
    const res = await handleRequest(request("/robots.txt"), mockEnv(), mockCtx());
    const body = await res.text();
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /s/");
    expect(body).toContain("Sitemap:");
  });

  it("serves tokens.css and components.css from their canonical paths", async () => {
    for (const name of ["tokens.css", "components.css"]) {
      const res = await handleRequest(request(`/assets/${name}`), mockEnv(), mockCtx());
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
      expect((await res.text()).length).toBeGreaterThan(100);
    }
  });
});
