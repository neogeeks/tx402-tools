/**
 * `/sitemap.xml`.
 *
 * ── What changed from the original stub ──────────────────────────────────────────
 *
 * The stub listed the nav plus three static pages: ten URLs. It was missing
 * **the ten Compare category pages**, which are the single best SEO asset in
 * the suite — "cheapest x402 geocoding API" is §3.1's own worked
 * example and the page that answers it was not in the sitemap. That is the
 * substantive fix here; everything else is hygiene.
 *
 * ── What is deliberately NOT in it ─────────────────────────────────────────
 *
 * - **`.md` mirrors.** They are alternate representations of a URL already
 *   listed, advertised by `Link: rel=alternate` and `<link rel=alternate>`.
 *   Listing both would ask an index to treat one document as two.
 * - **`/api/v1/*`.** `robots.txt` disallows it: it is for clients, not indexes.
 * - **`/s/:id` share permalinks.** Unguessable and expiring by design;
 *   indexing them would defeat both properties.
 * - **`/inspect?url=…` and friends.** A report about a third party's endpoint
 *   is not a page this site should be submitting for indexing,
 *   and every distinct `url=` would be a separate indexable document. The page
 *   shell canonicalises them to the bare tool path for the same reason.
 * - **`<lastmod>`.** There is no honest source for it. These pages are
 *   generated per request from a corpus that changes continuously, so any date
 *   would either be "now" on every fetch — which trains a crawler to ignore the
 *   field — or a build timestamp this Worker does not have. An absent
 *   `lastmod` is valid; a fabricated one is worse than none.
 *
 * `<priority>` and `<changefreq>` are also absent, and that is not laziness:
 * Google has stated it ignores both, and they are the two fields that make a
 * sitemap look maintained while carrying no information.
 */

import { text } from "../http.js";
import { NAV } from "../../ui/components/header.js";
import { CATEGORIES } from "../../ui/pages/compare/catalogue.js";
import { TOOLS } from "../../ui/tool-meta.js";
import type { RouteContext, RouteHandler } from "../types.js";

/** Live-in-production tool paths, in nav order. */
function toolPaths(): string[] {
  const live = new Set(Object.values(TOOLS).filter((t) => t.live).map((t) => t.path));
  return NAV.map((n) => n.href).filter((href) => live.has(href));
}

/**
 * The static pages that are not tools but are indexable and worth ranking.
 *
 * `/methodology` is here even though is landing it alongside it: it is
 * linked from the observation note on every page that renders a verdict, and a
 * page that every risk band points at should be in the sitemap on the day it
 * goes live rather than the wave after. If slips, the URL 501s and a
 * crawler drops it — which is the correct behaviour and not a broken sitemap.
 */
const STATIC_PAGES = ["/methodology", "/crawler", "/errors"];

export function sitemapUrls(): string[] {
  return [
    "/",
    ...toolPaths(),
    ...CATEGORIES.filter((c) => c.published).map((c) => `/compare/${c.slug}`),
    ...STATIC_PAGES,
  ];
}

/** `&`, `<` and `>` are the three characters that can break a `<loc>`. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export const sitemap: RouteHandler = (ctx: RouteContext): Response => {
  const origin = ctx.env.PUBLIC_ORIGIN;
  const urls = sitemapUrls()
    .map((path) => `  <url><loc>${xmlEscape(`${origin}${path}`)}</loc></url>`)
    .join("\n");

  return text(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      urls,
      "</urlset>",
    ].join("\n"),
    "application/xml; charset=utf-8",
  );
};
