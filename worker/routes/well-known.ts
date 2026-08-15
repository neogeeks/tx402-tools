/**
 * robots.txt · llms.txt · sitemap.xml · /.well-known/security.txt
 *
 *  owns robots.txt and security.txt.  owns llms.txt and sitemap.xml
 * (agent-readability and SEO); the routes are declared here so that neither
 * session has to touch `worker/router.ts`.
 *
 * **we moved the two it owns into `routes/llms.ts` and `routes/sitemap.ts`** and re-exports them
 * here, so `router.ts` keeps importing this module and did not have to change. The stub versions
 * were a dozen lines each; the real ones are a file's worth apiece, and putting four unrelated
 * documents with three owners in one module is how a merge conflict gets manufactured. See. — SPEC
 * §8's route table names this file as the handler for both, and that is now the re-export rather
 * than the source.
 *
 * Note the direction of robots.txt here: this file governs what OTHER crawlers
 * may do to us. What OUR crawler does to other people is docs/abuse-policy.md,
 * and it is implemented in worker/crawler/.
 */

import { text } from "../http.js";
import type { RouteContext, RouteHandler } from "../types.js";

export { llmsTxt } from "./llms.js";
export { sitemap, sitemapUrls } from "./sitemap.js";

export const robots: RouteHandler = (ctx: RouteContext): Response =>
  text(
    [
      "# tools.tx402.io",
      "# What our own crawler does to other sites: https://tools.tx402.io/crawler",
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "# The JSON API is for clients, not indexes.",
      "Disallow: /api/",
      "# Share permalinks are unguessable and expiring; indexing them would defeat both.",
      "Disallow: /s/",
      "",
      `Sitemap: ${ctx.env.PUBLIC_ORIGIN}/sitemap.xml`,
    ].join("\n"),
    "text/plain; charset=utf-8",
  );

export const securityTxt: RouteHandler = (ctx: RouteContext): Response =>
  text(
    [
      "Contact: mailto:security@tx402.io",
      "Policy: https://github.com/neogeeks/tx402-tools/blob/main/SECURITY.md",
      "Preferred-Languages: en",
      `Canonical: ${ctx.env.PUBLIC_ORIGIN}/.well-known/security.txt`,
    ].join("\n"),
    "text/plain; charset=utf-8",
  );
