import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../worker/router.js";
import { mockCtx, mockEnv, request } from "./helpers.js";
import { CATEGORIES } from "../ui/pages/compare/catalogue.js";
import { TOOLS } from "../ui/tool-meta.js";
import { sitemapUrls } from "../worker/routes/sitemap.js";

/**
 * `/llms.txt` and `/sitemap.xml` —.
 *
 * These two files are the only thing standing between "every page has a
 * Markdown mirror and a JSON mirror" and
 * anything knowing that. So the assertions below are mostly about **what an
 * agent could do after reading the file**: is the call spelled out, is the URL
 * real, and is anything claimed that is not true?
 *
 * The last one is the reason `describe("claims nothing untrue")` exists.
 * `tx402-tools` and `tx402-tools-mcp` are unpublished by design
 * and this file is exactly where a launch-shaped sentence would get
 * written by accident.
 */

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(request(path, init), mockEnv(), mockCtx());
}

async function body(path: string): Promise<string> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe("/llms.txt", () => {
  it("is served as plain text", async () => {
    const res = await get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("is no longer a placeholder", async () => {
    const text = await body("/llms.txt");
    expect(text).not.toContain("Stub:");
    expect(text).not.toContain("owns the final content");
  });

  it("names every tool with its own H1, not a slug", async () => {
    const text = await body("/llms.txt");
    for (const tool of Object.values(TOOLS)) {
      expect(text).toContain(tool.name);
      expect(text).toContain(tool.h1);
      // The stub rendered "- [/inspect](…): inspect", which tells an agent
      // nothing it did not already have from the path.
      expect(text).not.toContain(`): ${tool.path.slice(1)}\n`);
    }
  });

  it("gives the actual call for each tool, not just a page link", async () => {
    const text = await body("/llms.txt");
    for (const call of [
      "GET /api/v1/inspect?url=",
      "POST /api/v1/verify",
      "POST /api/v1/policy/evaluate",
      "GET /api/v1/history?url=",
      "GET /api/v1/compare?category=",
    ]) {
      expect(text).toContain(call);
    }
  });

  it("explains all three representations and how to pin one", async () => {
    const text = await body("/llms.txt");
    expect(text).toContain("Accept: application/json");
    expect(text).toContain("Accept: text/markdown");
    expect(text).toContain("Vary: Accept");
    expect(text).toContain("rel=alternate");
    expect(text).toContain("?format=");
    // SPEC §1.2's load-bearing sentence: the mirror is a rendering, not a
    // second computation. An agent that does not know this will re-derive
    // things from the Markdown rather than trusting the JSON.
    expect(text).toMatch(/rendering of the same JSON/iu);
  });

  it("lists every published category page", async () => {
    const text = await body("/llms.txt");
    for (const category of CATEGORIES.filter((c) => c.published)) {
      expect(text).toContain(`/compare/${category.slug}`);
    }
  });

  it("names both npm packages and what each one does without a browser", async () => {
    const text = await body("/llms.txt");
    expect(text).toContain("tx402-tools");
    expect(text).toContain("tx402-tools-mcp");
    expect(text).toContain("inspect_endpoint");
    expect(text).toContain("verify_challenge");
    // The CLI's reason to exist over the hosted probe.
    expect(text).toMatch(/localhost/u);
  });

  it("points at the machine-readable contracts", async () => {
    const text = await body("/llms.txt");
    for (const surface of [
      "/api/v1/schemas",
      "/api/v1/meta",
      "/api/v1/facilitators",
      "/sitemap.xml",
      "/.well-known/x402.json",
      "/methodology",
      "/crawler",
    ]) {
      expect(text).toContain(surface);
    }
  });

  it("cross-links the other two properties", async () => {
    const text = await body("/llms.txt");
    expect(text).toContain("https://tx402.io");
    expect(text).toContain("https://docs.tx402.io");
    // Deep pages, not just the two home pages — a link to a home page makes
    // the reader search again.
    expect(text).toContain("https://docs.tx402.io/guides/lifecycle/");
    expect(text).toContain("https://docs.tx402.io/guides/policy/");
    expect(text).toContain("https://docs.tx402.io/reference/errors/");
  });

  /**
   * Every same-origin Markdown link in the file is followed and must resolve.
   *
   * This exists because `/index.md` sat in this file advertising a Markdown
   * homepage that has 404'd since the first deploy: `stripMarkdownSuffix`
   * reduces it to `/index`, which is not a route. The identical URL in the home
   * page's `Link: rel=alternate` header was found and fixed by a check that
   * followed *headers*, and this copy survived it untouched — a check that
   * follows one half of a pair does not find the other half's bug.
   *
   * Links only, not every URL in the file: the `## How to call any of this`
   * block contains illustrative `?url=https://an.example/paid` calls, and
   * following those would probe rather than test.
   */
  it("follows every same-origin link it publishes and never gets a 404", async () => {
    const text = await body("/llms.txt");
    const origin = "https://tools.tx402.io";

    const paths = [...text.matchAll(/\]\((https:\/\/tools\.tx402\.io[^)\s]*)\)/gu)].map((m) =>
      m[1]!.slice(origin.length),
    );

    // If the extraction ever silently matches nothing, the test would pass by
    // checking zero URLs — which is the failure mode it was written to catch.
    expect(paths.length).toBeGreaterThan(10);

    for (const path of new Set(paths)) {
      // A handful of these are static files served by the Assets binding rather
      // than by the router, so `handleRequest` correctly 404s them here. They
      // are checked on disk instead — the question is the same one ("is there
      // something at the URL we published?") and skipping them silently is how
      // this whole class of bug survived in the first place.
      if (existsSync(join(process.cwd(), "public", path))) continue;

      const res = await get(path);
      expect(res.status, `${origin}${path} is published in /llms.txt`).toBeLessThan(400);
    }
  });

  it("uses the configured origin rather than a hardcoded one", async () => {
    const res = await handleRequest(
      request("/llms.txt"),
      mockEnv({ PUBLIC_ORIGIN: "https://preview.example" }),
      mockCtx(),
    );
    const text = await res.text();
    expect(text).toContain("https://preview.example/inspect");
    expect(text).not.toContain("https://tools.tx402.io/inspect");
  });
});

describe("/llms.txt claims nothing untrue", () => {
  /**
   * The invariant here was never "say the packages are unreleased" — it was
   * **never advertise a command that does not work**. For as long as both names
   * held a reserved `0.0.0` placeholder, this test asserted the install
   * commands were absent. They are published at 0.1.0, so it asserts the
   * opposite, and the claim it is really guarding is unchanged: what this file
   * tells an agent to run has to actually run.
   *
   * If a release is ever pulled, invert this back rather than deleting it.
   */
  it("advertises the install commands, now that both packages resolve", async () => {
    const text = await body("/llms.txt");
    expect(text).toMatch(/npm i(nstall)? -g tx402-tools\b/u);
    expect(text).toMatch(/npx -y tx402-tools-mcp/u);
    // The placeholder era is over; leaving the old caveat in would be its own
    // kind of wrong answer.
    expect(text).not.toMatch(/not released yet|reserved `0\.0\.0`/iu);
  });

  it("says this service cannot pay, before an agent asks it to", async () => {
    const text = await body("/llms.txt");
    expect(text).toMatch(/cannot pay/iu);
    expect(text).toMatch(/no signer, no key material/iu);
    // Credential vocabulary may appear only as a denial. Nothing on this
    // origin authenticates a caller and no route should start (worker/router.ts
    // says so where Watch and accounts were removed), so an agent must not read
    // this file and go looking for a key to obtain.
    expect(text).toMatch(/no account, no API key/iu);
    expect(text).not.toMatch(/\b(bearer token|sign in|your api[_ -]?key)\b/iu);
  });

  it("says what a band means before an agent can quote one", async () => {
    const text = await body("/llms.txt");
    //. The words this repo's user-facing strings never contain.
    expect(text).not.toMatch(/\b(scam|fraudulent|unsafe)\b/iu);
    // `\s+` because the file is hard-wrapped: the sentence spans two lines.
    expect(text).toMatch(/not a\s+judgement about the operator/iu);
    expect(text).toMatch(/score_version/u);
    expect(text).toMatch(/NO_DATA/u);
  });

  it("does not advertise a tool that is not live", async () => {
    const text = await body("/llms.txt");
    for (const tool of Object.values(TOOLS)) {
      if (!tool.live) expect(text).toContain(`${tool.path}](`);
    }
    // Every tool is live as of wave 4; if one is ever flipped back, the file
    // must mark it rather than silently advertising it.
    const notLive = Object.values(TOOLS).filter((t) => !t.live);
    if (notLive.length > 0) expect(text).toContain("*(not live yet)*");
  });
});

describe("/sitemap.xml", () => {
  it("is served as XML", async () => {
    const res = await get("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  });

  it("lists the home page and every live tool", async () => {
    const xml = await body("/sitemap.xml");
    expect(xml).toContain("<loc>https://tools.tx402.io/</loc>");
    for (const tool of Object.values(TOOLS).filter((t) => t.live)) {
      expect(xml).toContain(`<loc>https://tools.tx402.io${tool.path}</loc>`);
    }
  });

  it("lists every published Compare category page", async () => {
    // The stub did not, and these are the best SEO asset in the suite
    //: "cheapest x402 geocoding API" is §3.1's own worked example.
    const xml = await body("/sitemap.xml");
    for (const category of CATEGORIES.filter((c) => c.published)) {
      expect(xml).toContain(`<loc>https://tools.tx402.io/compare/${category.slug}</loc>`);
    }
  });

  it("omits the API, share permalinks and the .md mirrors", async () => {
    const xml = await body("/sitemap.xml");
    expect(xml).not.toContain("/api/");
    expect(xml).not.toContain("/s/");
    expect(xml).not.toContain(".md<");
  });

  it("omits lastmod, changefreq and priority rather than fabricating them", async () => {
    const xml = await body("/sitemap.xml");
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("has no duplicate URLs", async () => {
    const urls = sitemapUrls();
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("every URL it lists is a route this Worker answers", async () => {
    // A sitemap entry that 404s is worse than a missing one: it teaches a
    // crawler the sitemap is unreliable. `/methodology` is its and is
    // deliberately included — see worker/routes/sitemap.ts.
    for (const path of sitemapUrls()) {
      const res = await get(path);
      expect([200, 501], `${path} answered ${res.status}`).toContain(res.status);
    }
  });

  it("uses the configured origin", async () => {
    const res = await handleRequest(
      request("/sitemap.xml"),
      mockEnv({ PUBLIC_ORIGIN: "https://preview.example" }),
      mockCtx(),
    );
    expect(await res.text()).toContain("<loc>https://preview.example/</loc>");
  });
});

describe("robots.txt still agrees with the sitemap", () => {
  it("points at it, and disallows what the sitemap omits", async () => {
    const text = await body("/robots.txt");
    expect(text).toContain("Sitemap: https://tools.tx402.io/sitemap.xml");
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Disallow: /s/");
  });
});
