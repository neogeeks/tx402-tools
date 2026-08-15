import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES, handleRequest } from "../worker/router.js";
import { mockCtx, mockEnv, request } from "./helpers.js";
import { CATEGORIES } from "../ui/pages/compare/catalogue.js";
import { SITE, TOOLS } from "../ui/tool-meta.js";
import { footer } from "../ui/components/footer.js";
import { page } from "../ui/components/page.js";

/**
 * `<head>` metadata, JSON-LD and the §3.1 audit —.
 *
 * ── The §3.1 half is a real audit, not a spot check ────────────────────────
 *
 * "every title, H1, meta description and JSON-LD name targets a
 * CATEGORY term, not the brand term." The loop below runs that rule over every
 * tool and every category page rather than over the two somebody remembered, so
 * a later change that writes "tx402 Inspector" into a title fails here. The
 * page-by-page findings are written up.; this is the part
 * that keeps holding after the session ends.
 *
 * ── The negotiation half asserts agreement, not correctness ────────────────
 *
 * `Link: rel=alternate` and `Vary: Accept` are frozen in SPEC §1.2 and
 * implemented in `worker/http.ts`. The `<link>`
 * ELEMENTS added to the document this change must therefore agree with those
 * HEADERS — one wrong answer, not two. See `describe("known-bad alternates")`
 * at the bottom: six of them currently point at routes that do not exist, and
 * that is a defect in the helper routed to the wave-5 integrator, pinned
 * here so the fix cannot land silently.
 */

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(request(path, init), mockEnv(), mockCtx());
}

async function pageHtml(path: string): Promise<string> {
  const res = await get(path);
  expect([200, 501], `${path} answered ${res.status}`).toContain(res.status);
  return res.text();
}

function head(html: string): string {
  return html.slice(0, html.indexOf("</head>"));
}

/** The JSON-LD `@graph` from a rendered page. */
function graph(html: string): Array<Record<string, unknown>> {
  const match = head(html).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u);
  expect(match, "no JSON-LD block in <head>").toBeTruthy();
  const parsed = JSON.parse(match?.[1] ?? "{}") as { "@graph"?: Array<Record<string, unknown>> };
  return parsed["@graph"] ?? [];
}

function nodeOfType(html: string, type: string): Record<string, unknown> | undefined {
  return graph(html).find((n) => n["@type"] === type);
}

/** Undo the page shell's attribute escaping, so a value can be compared to its source. */
function unescape(value: string): string {
  return value
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function metaContent(html: string, selector: string): string | null {
  const re = new RegExp(`<meta (?:name|property)="${selector}" content="([^"]*)"`, "u");
  const value = head(html).match(re)?.[1];
  return value === undefined ? null : unescape(value);
}

/** Every negotiated page route, with a concrete path. */
const NEGOTIATED = ROUTES.filter(
  (r) => r.meta.negotiated && (Array.isArray(r.method) ? r.method : [r.method]).includes("GET"),
).map((r) => ({ pattern: r.pattern, path: r.pattern.replace(":category", "geocoding").replace(":id", "abc123") }));

/** Page routes that render the shell. `/s/:id` is a lookup that 404s here. */
const PAGES = NEGOTIATED.filter((r) => !r.pattern.startsWith("/s/"));

// ── the audit ─────────────────────────────────────────────────────────────

describe("every string targets the category term, not the brand", () => {
  /**
   * The rule is **leads with**, not **never mentions**.
   *
   * `TOOLS.inspect.description` ends "…decoded by the same strict decoder the
   * tx402 SDK uses before it pays", and that is the differentiator
   * says is the only one no other x402 tool can claim. It belongs in the
   * description — in the proof clause, after the category term has earned the
   * click. What §3.1 forbids is the brand in the position that has to do the
   * ranking. So: the title and H1 are brand-free outright, and a description
   * may name the brand only after it has said what the tool does.
   */
  const LEAD_CHARS = 60;

  it("no tool's title or h1 contains the brand at all", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      for (const field of ["title", "h1"] as const) {
        expect(tool[field].toLowerCase(), `TOOLS.${key}.${field}`).not.toContain("tx402");
      }
      // Every one of them mentions the protocol, which is the category term.
      expect(tool.title.toLowerCase(), `TOOLS.${key}.title`).toContain("x402");
      expect(tool.h1.toLowerCase(), `TOOLS.${key}.h1`).toContain("x402");
    }
  });

  it("no description leads with the brand", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      const lead = tool.description.slice(0, LEAD_CHARS).toLowerCase();
      expect(lead, `TOOLS.${key}.description`).not.toContain("tx402");
      expect(lead, `TOOLS.${key}.description`).toContain("x402");
    }
    expect(SITE.description.slice(0, LEAD_CHARS).toLowerCase()).not.toContain("tx402");
  });

  it("no category page's title or summary leads with the brand", () => {
    for (const category of CATEGORIES) {
      expect(category.seoTitle.toLowerCase(), category.slug).not.toContain("tx402");
      expect(category.title.toLowerCase(), category.slug).not.toContain("tx402");
      expect(category.summary.toLowerCase(), category.slug).not.toContain("tx402");
      expect(category.seoTitle.toLowerCase(), category.slug).toContain("x402");
    }
  });

  it("every meta description is a usable length and one sentence of substance", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.description.length, `TOOLS.${key}.description`).toBeGreaterThan(80);
      expect(tool.description.length, `TOOLS.${key}.description`).toBeLessThanOrEqual(220);
    }
    expect(SITE.description.length).toBeGreaterThan(80);
    expect(SITE.description.length).toBeLessThanOrEqual(220);
  });

  it("every tool declares the search intent it is for, in category terms", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      const terms = tool.intent.split(" · ");
      expect(terms.length, `TOOLS.${key}.intent`).toBeGreaterThanOrEqual(2);
      // Not every term needs "x402" — `TOOLS.policy.intent` ends "agent
      // payment guardrails", which is a real query from someone who has not
      // yet learned the protocol's name, and is exactly the kind of term §3.1
      // wants. What no term may be is the brand.
      for (const term of terms) expect(term.toLowerCase(), `TOOLS.${key}.intent`).not.toContain("tx402");
      expect(terms.some((t) => t.toLowerCase().includes("x402")), `TOOLS.${key}.intent`).toBe(true);
    }
  });

  it("renders the H1 from tool-meta on every tool page", async () => {
    for (const tool of Object.values(TOOLS)) {
      const html = await pageHtml(tool.path);
      const title = unescape(head(html).match(/<title>([^<]*)<\/title>/u)?.[1] ?? "");
      expect(title, `${tool.path} <title>`).toBe(`${tool.title} | ${SITE.name}`);
      expect(metaContent(html, "description"), `${tool.path} description`).toBe(tool.description);
    }
  });

  /**
   * its audit found `/replay` rendering its H1 — "Why did my x402 payment
   * fail?", own worked example and the highest-intent term in
   * the suite — as an `<h2>` inside `emptyState`, leaving the page with no
   * `<h1>` at all. Fixed at the wave-5 integration; this is
   * the assertion the characterization test was holding a place for.
   *
   * Exactly one `<h1>` per page, not "at least one": two competing top-level
   * headings is the other way to get this wrong, and it is the way that does
   * not show up as a missing element.
   */
  it("renders exactly one h1, carrying the tool-meta H1, on every tool page", async () => {
    for (const tool of Object.values(TOOLS)) {
      const html = await pageHtml(tool.path);
      const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gu)];
      expect(headings.length, `${tool.path} h1 count`).toBe(1);
      expect(unescape(headings[0]?.[1] ?? ""), `${tool.path} h1 text`).toContain(tool.h1);
    }
  });

  it("puts the category term, not the brand, in the JSON-LD name", async () => {
    for (const tool of Object.values(TOOLS)) {
      const app = nodeOfType(await pageHtml(tool.path), "WebApplication");
      expect(app?.name, tool.path).toBe(tool.title);
      expect(String(app?.name).toLowerCase(), tool.path).not.toContain("tx402");
    }
  });
});

// ── head metadata ─────────────────────────────────────────────────────────

describe("every page carries complete <head> metadata", () => {
  it("has a canonical URL on the production origin", async () => {
    for (const { path } of PAGES) {
      const html = await pageHtml(path);
      const canonical = head(html).match(/<link rel="canonical" href="([^"]+)"/u)?.[1];
      expect(canonical, `${path} canonical`).toBe(`https://tools.tx402.io${path}`);
    }
  });

  it("canonicalises a query string away, so one report is not a thousand pages", () => {
    // Unit-tested on the shell rather than through a route: every route passes
    // `ctx.url.pathname`, which has already dropped the query, so an end-to-end
    // request would test the routes' habit and not the shell's guarantee. This
    // is the guarantee — `/inspect?url=<anything>` is one indexable document,
    // not one per endpoint somebody pasted.
    const html = page({
      title: TOOLS.inspect.title,
      description: TOOLS.inspect.description,
      body: "",
      path: "/inspect?url=https://an.example/paid",
    });
    expect(head(html)).toContain('<link rel="canonical" href="https://tools.tx402.io/inspect" />');
    expect(metaContent(html, "og:url")).toBe("https://tools.tx402.io/inspect");
  });

  it("honours an explicit canonical while marking a different nav path", () => {
    // A Compare category page marks `/compare` current in the nav and is
    // canonically `/compare/<slug>`.
    const html = page({
      title: "Cheapest x402 geocoding API",
      description: "…",
      body: "",
      path: "/compare",
      canonical: "https://tools.tx402.io/compare/geocoding",
    });
    expect(head(html)).toContain('<link rel="canonical" href="https://tools.tx402.io/compare/geocoding" />');
  });

  it("has og: and twitter: tags that match the title and description", async () => {
    for (const { path } of PAGES) {
      const html = await pageHtml(path);
      const title = head(html).match(/<title>([^<]*)<\/title>/u)?.[1];
      const description = metaContent(html, "description");
      expect(metaContent(html, "og:title"), `${path} og:title`).toBe(title);
      expect(metaContent(html, "og:description"), `${path} og:description`).toBe(description);
      expect(metaContent(html, "twitter:title"), `${path} twitter:title`).toBe(title);
      expect(metaContent(html, "twitter:description"), `${path} twitter:description`).toBe(description);
      expect(metaContent(html, "og:type"), `${path} og:type`).toBe("website");
      expect(metaContent(html, "og:site_name"), `${path} og:site_name`).toBe(SITE.name);
      // `summary`, not `summary_large_image`: the only image is a 180px icon,
      // and a large card without a large image renders broken.
      expect(metaContent(html, "twitter:card"), `${path} twitter:card`).toBe("summary");
    }
  });

  it("takes theme-color from ui/tokens.css rather than hardcoding a hex", async () => {
    const tokens = readFileSync(join(process.cwd(), "ui", "tokens.css"), "utf8");
    const html = await pageHtml("/");
    const dark = head(html).match(/theme-color" media="\(prefers-color-scheme: dark\)" content="([^"]+)"/u)?.[1];
    const light = head(html).match(/theme-color" media="\(prefers-color-scheme: light\)" content="([^"]+)"/u)?.[1];
    expect(dark, "dark theme-color").toBeTruthy();
    expect(light, "light theme-color").toBeTruthy();
    expect(tokens, "dark theme-color is not a token value").toContain(`--bg: ${dark}`);
    expect(tokens, "light theme-color is not a token value").toContain(`--bg: ${light}`);
    expect(dark).not.toBe(light);
  });
});

// ── JSON-LD ───────────────────────────────────────────────────────────────

describe("JSON-LD", () => {
  it("is valid JSON, one @graph, on every page", async () => {
    for (const { path } of PAGES) {
      const nodes = graph(await pageHtml(path));
      expect(nodes.length, `${path} @graph`).toBeGreaterThanOrEqual(2);
      expect(nodes.map((n) => n["@type"]), path).toContain("Organization");
      expect(nodes.map((n) => n["@type"]), path).toContain("WebSite");
    }
  });

  it("escapes the characters that could end the script block", async () => {
    const html = await pageHtml("/");
    const block = head(html).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u)?.[1] ?? "";
    expect(block).not.toContain("<");
    expect(block).not.toContain(">");
    expect(block).not.toContain("&");
  });

  it("describes each tool page as a free WebApplication", async () => {
    for (const tool of Object.values(TOOLS)) {
      const app = nodeOfType(await pageHtml(tool.path), "WebApplication");
      expect(app, tool.path).toBeTruthy();
      expect(app?.url, tool.path).toBe(`https://tools.tx402.io${tool.path}`);
      expect(app?.isAccessibleForFree, tool.path).toBe(true);
      expect(app?.offers, tool.path).toMatchObject({ price: "0", priceCurrency: "USD" });
      expect(app?.description, tool.path).toBe(tool.description);
      expect(app?.keywords, tool.path).toBe(tool.intent.split(" · ").join(", "));
    }
  });

  it("emits no rating, review or aggregate-rating entity anywhere", async () => {
    // this site publishes observation bands about third parties.
    // A review-shaped entity invites a search engine to render "tx402 rates
    // this endpoint 2/5", which is exactly the accusation the product does not
    // make. Structured data has no vocabulary for "confidence of observation",
    // so it says nothing rather than saying it wrong.
    for (const { path } of PAGES) {
      const block = JSON.stringify(graph(await pageHtml(path)));
      for (const banned of ["AggregateRating", "Rating", "Review", "ratingValue", "reviewRating"]) {
        expect(block, `${path} emits ${banned}`).not.toContain(banned);
      }
    }
  });

  it("gives a category page a three-level breadcrumb ending in the category term", async () => {
    const html = await pageHtml("/compare/geocoding");
    const crumbs = nodeOfType(html, "BreadcrumbList");
    const items = (crumbs?.itemListElement ?? []) as Array<{ position: number; name: string; item: string }>;
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[1]?.item).toBe("https://tools.tx402.io/compare");
    expect(items[2]?.item).toBe("https://tools.tx402.io/compare/geocoding");
    expect(items[2]?.name.toLowerCase()).not.toContain("tx402");
  });

  it("names tx402.io as the publisher on every page, by @id", async () => {
    for (const { path } of PAGES) {
      const nodes = graph(await pageHtml(path));
      const org = nodes.find((n) => n["@type"] === "Organization");
      expect(org?.["@id"], path).toBe("https://tx402.io/#org");
      expect(org?.sameAs, path).toContain("https://docs.tx402.io");
    }
  });

  it("has no breadcrumb on the home page", async () => {
    expect(nodeOfType(await pageHtml("/"), "BreadcrumbList")).toBeUndefined();
  });
});

// ── the three representations ─────────────────────────────────────────────

describe("SPEC §1.2 is intact and the document says the same thing as the headers", () => {
  it("still sets Vary: Accept on every negotiated response", async () => {
    for (const { path } of NEGOTIATED) {
      const res = await get(path);
      expect(res.headers.get("vary"), `${path} vary`).toBe("Accept");
    }
  });

  it("still advertises the Markdown alternate on every negotiated response", async () => {
    // Every negotiated route has a Markdown mirror, without exception.
    for (const { path } of NEGOTIATED) {
      const link = (await get(path)).headers.get("link") ?? "";
      expect(link, `${path} link`).toContain('rel="alternate"; type="text/markdown"');
    }
  });

  it("advertises a JSON alternate only where one exists", async () => {
    // Before the wave-5 fix this was `/api/v1` + the page path for everything,
    // which advertised a 404 on six of eleven routes.
    // A page with no JSON representation now advertises one alternate rather
    // than a fabricated second one.
    const withJson = ["/inspect", "/verify", "/history", "/compare", "/policy", "/compare/geocoding", "/"];
    const withoutJson = ["/replay", "/errors", "/crawler", "/methodology"];

    for (const path of withJson) {
      const link = (await get(path)).headers.get("link") ?? "";
      expect(link, `${path} should advertise JSON`).toContain('rel="alternate"; type="application/json"');
    }
    for (const path of withoutJson) {
      const link = (await get(path)).headers.get("link") ?? "";
      expect(link, `${path} should not advertise JSON`).not.toContain("application/json");
    }
  });

  it("serves all three representations from one path", async () => {
    for (const tool of Object.values(TOOLS)) {
      const html = await get(tool.path);
      const json = await get(tool.path, { headers: { accept: "application/json" } });
      const md = await get(tool.path, { headers: { accept: "text/markdown" } });
      expect(html.headers.get("content-type"), tool.path).toContain("text/html");
      expect(json.headers.get("content-type"), tool.path).toContain("application/json");
      expect(md.headers.get("content-type"), tool.path).toContain("text/markdown");
    }
  });

  it("the <link rel=alternate> elements carry the same URLs as the Link: header", async () => {
    // One wrong answer, never two. `worker/http.ts` derives the header and
    // `ui/components/jsonld.ts` derives the element; this is what keeps them
    // from drifting, and what makes the integrator's fix below fix both.
    for (const { path } of PAGES) {
      const res = await get(path);
      const fromHeader = [...(res.headers.get("link") ?? "").matchAll(/<([^>]+)>/gu)].map((m) => m[1]);
      const html = await res.text();
      const fromDocument = [...head(html).matchAll(/<link rel="alternate" type="[^"]+" href="([^"]+)"/gu)].map(
        (m) => m[1],
      );
      expect(fromDocument, `${path} alternates`).toEqual(fromHeader);
    }
  });
});

describe("every advertised alternate actually resolves", () => {
  /**
   * The assertion that closes.
   *
   * L11's whole point is that an agent never has to scrape HTML. An agent doing
   * the correct thing — read `Link:`, follow the alternate — must not get a
   * 404, because the obvious fallback from a 404 is to parse the page. Before
   * the wave-5 fix, six of eleven routes failed this.
   *
   * A `GET` on a `POST`-only mirror answers 405 with an `allow` header, which
   * is a correct answer about a route that exists — `/policy` advertises
   * `/api/v1/policy/evaluate` and that is the right URL to advertise.
   */
  it("follows every Link: alternate on every page and never gets a 404", async () => {
    for (const { path } of PAGES) {
      const urls = [...((await get(path)).headers.get("link") ?? "").matchAll(/<([^>]+)>/gu)].map(
        (m) => m[1] ?? "",
      );
      expect(urls.length, `${path} advertises no alternates`).toBeGreaterThan(0);
      for (const url of urls) {
        const res = await get(url);
        expect(res.status, `${path} advertises ${url}, which answered ${res.status}`).not.toBe(404);
      }
    }
  });

  it("advertises a category page's JSON mirror as a query, not a path segment", async () => {
    const link = (await get("/compare/geocoding")).headers.get("link") ?? "";
    expect(link).toContain("/api/v1/compare?category=geocoding");
    const res = await get("/api/v1/compare?category=geocoding");
    expect(res.status).toBe(200);
  });
});

// ── cross-links ──────────────────────────────────────────────

describe("outbound cross-links", () => {
  const rendered = footer();

  it("links out to both sibling properties from every page", async () => {
    for (const { path } of PAGES) {
      const html = await pageHtml(path);
      expect(html, `${path} → tx402.io`).toContain('href="https://tx402.io"');
      expect(html, `${path} → docs`).toContain("https://docs.tx402.io/");
    }
  });

  it("links to deep docs pages, not just the docs home page", () => {
    expect(rendered).toContain("https://docs.tx402.io/guides/lifecycle/");
    expect(rendered).toContain("https://docs.tx402.io/guides/policy/");
    expect(rendered).toContain("https://docs.tx402.io/reference/errors/");
  });

  it("keeps the trust links reachable from every page", () => {
    expect(rendered).toContain('href="/methodology"');
    expect(rendered).toContain('href="/crawler"');
    expect(rendered).toContain('href="/errors"');
    expect(rendered).toContain('href="/llms.txt"');
  });

  it("names the two packages by source, never by an install command", () => {
    expect(rendered).toContain("packages/tools-cli");
    expect(rendered).toContain("packages/tools-mcp");
    expect(rendered).not.toMatch(/npm i|npx/u);
  });
});

// ── the discovery manifest ──────────────────────────────────

describe("/.well-known/x402.json", () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "public", ".well-known", "x402.json"), "utf8"),
  ) as {
    x402Version: number;
    accepts_payment: boolean;
    resources: Array<{ resource: string; type: string; accepts: unknown[] }>;
    mcp: { published: boolean; transport: string };
    cli: { published: boolean };
    listing_status: { bazaar: string };
    disclosure: Record<string, string>;
    capabilities: Record<string, unknown>;
  };

  it("states a zero price the only way this format can — an empty accepts", () => {
    expect(manifest.accepts_payment).toBe(false);
    expect(manifest.resources.length).toBeGreaterThan(0);
    for (const resource of manifest.resources) {
      expect(resource.accepts, resource.resource).toEqual([]);
    }
  });

  it("lists only API routes this Worker actually answers", async () => {
    const patterns = new Set(ROUTES.map((r) => r.pattern));
    for (const resource of manifest.resources) {
      const path = new URL(resource.resource).pathname;
      expect(patterns, `${path} is not a declared route`).toContain(path);
    }
  });

  it("covers every live tool that has a JSON API mirror", () => {
    const listed = new Set(manifest.resources.map((r) => new URL(r.resource).pathname));
    // Replay's primary surface is the CLI and its API is a share/lookup pair,
    // not a tool endpoint — so it is correctly absent.
    for (const path of [
      "/api/v1/inspect",
      "/api/v1/verify",
      "/api/v1/policy/evaluate",
      "/api/v1/history",
      "/api/v1/compare",
    ]) {
      expect(listed, `${path} missing from the manifest`).toContain(path);
    }
  });

  it("does not claim either package is published", () => {
    expect(manifest.mcp.published).toBe(false);
    expect(manifest.cli.published).toBe(false);
  });

  it("does not shape the stdio MCP server as a Bazaar mcp resource", () => {
    // Bazaar identifies an MCP resource by URL and requires streamable-http or
    // sse. This one is spawned over stdio and has no address; listing it with a
    // fabricated resource URL would be a false machine-readable claim.
    expect(manifest.mcp.transport).toBe("stdio");
    expect(manifest.resources.map((r) => r.type)).not.toContain("mcp");
  });

  it("says it is not listed on Bazaar, and why", () => {
    expect(manifest.listing_status.bazaar).toBe("not_listed");
  });

  it("names the self-reference and states what a band means", () => {
    expect(manifest.disclosure.self_reference).toMatch(/conflict/iu);
    expect(manifest.disclosure.mitigation).toContain("https://tools.tx402.io/methodology");
    expect(manifest.disclosure.band_meaning).toMatch(/not a judgement about its operator/iu);
  });

  it("states that this service cannot pay", () => {
    expect(manifest.capabilities.constructs_payment).toBe(false);
    expect(manifest.capabilities.holds_keys).toBe(false);
    expect(manifest.capabilities.custodies_funds).toBe(false);
  });

  it("carries no fabricated freshness timestamp", () => {
    const raw = readFileSync(join(process.cwd(), "public", ".well-known", "x402.json"), "utf8");
    expect(raw).not.toContain('"generated_at"');
    expect(raw).not.toContain('"lastUpdated"');
  });
});
