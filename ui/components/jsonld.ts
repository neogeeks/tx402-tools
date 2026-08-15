/**
 * JSON-LD, canonical URLs and social metadata.
 *
 * ── Why this is a component and not a per-page concern ─────────────────────
 *
 * `ui/pages/*` has many owners. If structured data were
 * each page's job it would exist on the pages whose session happened to think
 * of it, in six dialects, and a later change rewriting a page would silently
 * drop it. So the page shell derives it from the path, and a page gets correct
 * `<head>` metadata by virtue of being a page. Nothing in `ui/pages/` had to
 * change for this change and nothing there can regress it.
 *
 * ── What the structured data claims, and what it must not ──────────────────
 *
 * Every tool is a `WebApplication` that is free (`offers.price: "0"`,
 * `isAccessibleForFree: true`). That is a factual claim about these hosted
 * pages and it is true — there is no account, no key and no charge (SPEC §1.7).
 *
 * There is deliberately **no `AggregateRating`, no `Review` and no `Rating`**
 * anywhere in this file. This site publishes risk bands about third-party
 * endpoints; emitting a review-shaped entity would invite a search engine to
 * render "tx402 rates this endpoint 2/5" as a rich result, which is precisely
 * the accusation forbids the product from making. A band describes
 * the confidence of our observations. Structured data has no vocabulary for
 * that distinction, so it says nothing rather than saying it wrong.
 *
 * ── §3.1, one more time ────────────────────────────────────────────────────
 *
 * Every `name` below comes from `ui/tool-meta.ts`, which targets the category
 * term. The brand appears in `publisher`/`provider` and in the title suffix —
 * where it converts — and never in the `name` a search result renders.
 */

import tokensCss from "../tokens.css";
import { alternateUrls } from "../../worker/http.js";
import { SITE, TOOLS } from "../tool-meta.js";
import type { ToolMeta } from "../tool-meta.js";
import { escapeHtml, raw } from "./html.js";
import type { Raw } from "./html.js";

/**
 * The canonical origin.
 *
 * A module constant rather than `env.PUBLIC_ORIGIN` because the page shell is a
 * pure function of its options — it has no `RouteContext` — and because a
 * canonical URL pointing anywhere but the production origin is a bug in every
 * environment, including a preview one. `ui/pages/compare/page.ts` already
 * hardcodes the same value for the same reason.
 */
export const ORIGIN = "https://tools.tx402.io";

/** The organisation behind all three properties, referenced by `@id` everywhere. */
const PUBLISHER_ID = "https://tx402.io/#org";
const WEBSITE_ID = `${ORIGIN}/#website`;

// ── theme colour, taken from the tokens file ──────────────────────────────

/**
 * `<meta name="theme-color">` needs literal colours: it is read by the browser
 * chrome, which cannot resolve a CSS custom property.
 *
 * Rather than paste two hexes here — which would put a raw colour outside
 * `ui/tokens.css`, the thing `pnpm gate:tokens` exists to prevent — this reads
 * `--bg` out of the tokens file itself. The file is already imported as text by
 * the Worker (`worker/routes/assets.ts`, and `rules` in wrangler.jsonc), so
 * this costs one regex at module load and cannot drift: change the token and
 * the browser chrome follows.
 */
function tokenBg(selector: RegExp): string | null {
  const block = tokensCss.match(selector);
  const value = block?.[0].match(/--bg:\s*([^;]+);/u)?.[1];
  return value?.trim() ?? null;
}

const DARK_BG = tokenBg(/:root,\s*:root\[data-theme='dark'\]\s*\{[^}]*\}/u);
const LIGHT_BG = tokenBg(/:root\[data-theme='light'\]\s*\{[^}]*\}/u);

/**
 * Dark first, because dark is the default in `ui/tokens.css` and a browser
 * that understands neither `media` attribute takes the first declaration.
 */
export function themeColorTags(): string {
  const tags: string[] = [];
  if (DARK_BG) tags.push(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK_BG}" />`);
  if (LIGHT_BG) tags.push(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${LIGHT_BG}" />`);
  return tags.join("\n    ");
}

// ── path → tool ───────────────────────────────────────────────────────────

const BY_PATH: ReadonlyMap<string, ToolMeta> = new Map(
  Object.values(TOOLS).map((t) => [t.path, t as ToolMeta]),
);

/**
 * The tool a path belongs to, or null for the home page and the non-tool pages
 * (`/methodology`, `/crawler`, `/errors`).
 *
 * `/compare/market-data` resolves to Compare: a category page is Compare
 * rendered for one category, and its own title and description are passed in by
 * the page rather than derived here.
 */
export function toolForPath(pathname: string): ToolMeta | null {
  const path = pathname.replace(/\.md$|\/\.md$/u, "") || "/";
  const exact = BY_PATH.get(path);
  if (exact) return exact;
  const parent = path.slice(0, path.indexOf("/", 1) === -1 ? path.length : path.indexOf("/", 1));
  return BY_PATH.get(parent) ?? null;
}

// ── serialisation ─────────────────────────────────────────────────────────

/**
 * Serialise one or more JSON-LD nodes into a `<script>` tag.
 *
 * `</` is escaped to `<\/`: a string containing `</script>` would otherwise end
 * the block and everything after it would be parsed as markup. That is the one
 * XSS vector a JSON-LD block has, and nothing here is request-derived today —
 * but a later change passing a category title through would not think to check.
 * `<` and `>` are escaped too, which is valid JSON and neutralises the same
 * class of mistake in HTML comment position (`<!--`).
 */
export function jsonLdScript(nodes: unknown[]): string {
  const payload = nodes.length === 1 ? nodes[0] : nodes;
  const body = JSON.stringify(payload)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
  return `<script type="application/ld+json">${body}</script>`;
}

// ── the nodes ─────────────────────────────────────────────────────────────

/**
 * Organisation + WebSite, emitted on every page.
 *
 * The publisher is `tx402.io`, not this subdomain: the two are one entity, and
 * saying so is the same-registrable-domain signal is spending this
 * whole session on. `sameAs` lists the properties a reader can check.
 */
export function organizationNode(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": PUBLISHER_ID,
    name: "tx402",
    url: "https://tx402.io",
    description:
      "Spend governance for x402 buyers: a non-custodial SDK that commits policy and budget before any signer is touched.",
    sameAs: [
      "https://docs.tx402.io",
      "https://tools.tx402.io",
      "https://github.com/neogeeks/tx402",
      "https://www.npmjs.com/package/tx402",
      "https://pypi.org/project/tx402/",
    ],
  };
}

/**
 * The site node. Present on every page so the per-page nodes have something to
 * hang `isPartOf` off, and so `name` is asserted consistently rather than
 * inferred from whichever page a crawler happened to land on first.
 *
 * **No `description`.** It would put `SITE.description` into the `<head>` of all twenty-odd pages,
 * duplicating copy that each page already states about itself in `<meta name="description">` — the
 * field a search engine actually reads. It is also the field that made `test/history.test.ts` fail
 * when this landed: that test asserts the empty state does not apologise, scans the whole document,
 * and `SITE.description` legitimately contains "debug a failed payment". The test is right about
 * the page. Worth knowing generally, and. : **site-wide copy in `<head>` is now inside every page's
 * whole-document assertions.**
 */
export function websiteNode(): Record<string, unknown> {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: `${ORIGIN}/`,
    name: SITE.name,
    inLanguage: "en",
    publisher: { "@id": PUBLISHER_ID },
  };
}

/**
 * One tool page.
 *
 * `WebApplication` rather than `SoftwareApplication`: these run in a browser at
 * a URL, with nothing to download. `browserRequirements` says the opposite of
 * what it looks like — the pages render server-side and work without
 * JavaScript, and claiming a requirement that does not exist would be a small
 * lie in a file whose entire job is machine-readable truth.
 */
export function toolNode(tool: ToolMeta, canonical: string): Record<string, unknown> {
  return {
    "@type": "WebApplication",
    "@id": `${canonical}#app`,
    url: canonical,
    name: tool.title,
    alternateName: tool.name,
    description: tool.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    inLanguage: "en",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    // The search intent this page is for, straight out of ui/tool-meta.ts —
    // the same strings is audited against, rather than a second
    // hand-written list that could disagree with it.
    keywords: tool.intent.split(" · ").join(", "),
    publisher: { "@id": PUBLISHER_ID },
    isPartOf: { "@id": WEBSITE_ID },
  };
}

/** A non-tool page: `/methodology`, `/crawler`, `/errors`, a category page. */
export function webPageNode(
  canonical: string,
  title: string,
  description: string,
): Record<string, unknown> {
  return {
    "@type": "WebPage",
    "@id": `${canonical}#page`,
    url: canonical,
    name: title,
    description,
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": PUBLISHER_ID },
  };
}

/**
 * Breadcrumbs. Two levels for a tool page, three for a Compare category page —
 * which is the one place on this site with real hierarchy, and the one place a
 * search result showing `tools.tx402.io › Compare › market-data` helps.
 */
export function breadcrumbNode(path: string, title: string): Record<string, unknown> | null {
  if (path === "/") return null;

  const items: Array<{ name: string; item: string }> = [{ name: SITE.name, item: `${ORIGIN}/` }];
  const segments = path.split("/").filter(Boolean);

  if (segments.length > 1) {
    const parent = toolForPath(`/${segments[0]}`);
    if (parent) items.push({ name: parent.name, item: `${ORIGIN}${parent.path}` });
  }
  items.push({ name: title, item: `${ORIGIN}${path}` });

  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: entry.name,
      item: entry.item,
    })),
  };
}

// ── the block the page shell emits ────────────────────────────────────────

export interface StructuredDataOptions {
  /** Canonical absolute URL for this page. */
  canonical: string;
  /** Path, for breadcrumbs and the tool lookup. */
  path: string;
  /**
   * The page's own title, WITHOUT the `| tx402 tools` suffix.
   *
   * Structured data takes the bare title on purpose: a
   * breadcrumb reading `tx402 tools › Compare › Cheapest x402 geocoding API`
   * is the category term in the position that earns the click, and repeating
   * the brand in the last crumb spends that position on the brand instead.
   */
  title: string;
  /** The `<title>` as rendered, brand suffix included. Used for `og:`/`twitter:`. */
  socialTitle: string;
  description: string;
}

/**
 * The full `@graph` for a page: publisher, site, the page itself, breadcrumbs.
 *
 * One `<script>` with a `@graph` rather than several blocks, so the nodes can
 * reference each other by `@id` instead of repeating the publisher four times.
 */
export function structuredData(opts: StructuredDataOptions): string {
  const tool = toolForPath(opts.path);
  const isHome = opts.path === "/";

  const nodes: Array<Record<string, unknown>> = [organizationNode(), websiteNode()];

  if (!isHome) {
    nodes.push(
      tool && tool.path === opts.path
        ? toolNode(tool, opts.canonical)
        : webPageNode(opts.canonical, opts.title, opts.description),
    );
    const crumbs = breadcrumbNode(opts.path, opts.title);
    if (crumbs) nodes.push(crumbs);
  }

  return jsonLdScript([{ "@context": "https://schema.org", "@graph": nodes }]);
}

// ── social cards + alternates ─────────────────────────────────────────────

/**
 * `Link: rel=alternate` is served as a HEADER on every negotiated response
 * (`worker/http.ts`, SPEC §1.2). These are the `<link>` ELEMENTS carrying the
 * same URLs in the document, for the readers that never see the headers: an
 * agent handed saved HTML, a page rendered from cache, anything parsing the DOM
 * rather than the response.
 *
 * **They call the same derivation the header does** — `alternateUrls` — so
 * they cannot disagree, and a page with no JSON mirror emits one element rather
 * than a fabricated second one. `test/seo.test.ts` asserts the element list
 * equals the header list on every page rather than trusting this comment.
 */
export function alternateLinks(path: string): string {
  const { md, json } = alternateUrls(path, "");
  return [
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(md)}" />`,
    json ? `<link rel="alternate" type="application/json" href="${escapeHtml(json)}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");
}

export interface SocialOptions {
  canonical: string;
  title: string;
  description: string;
}

/**
 * Open Graph + Twitter.
 *
 * `summary` rather than `summary_large_image`: the only image this site has is
 * a 180px icon, and declaring a large card without a large image renders as a
 * broken one. When an og image exists, this is the line that changes.
 *
 * `escapeHtml` is not called here — the page shell interpolates these through
 * the `html` tagged template's escaping before they reach the document.
 */
export function socialTags(opts: SocialOptions): Array<[string, string, string]> {
  return [
    ["property", "og:type", "website"],
    ["property", "og:site_name", SITE.name],
    ["property", "og:locale", "en_US"],
    ["property", "og:url", opts.canonical],
    ["property", "og:title", opts.title],
    ["property", "og:description", opts.description],
    ["property", "og:image", `${ORIGIN}/icon-180.png`],
    ["name", "twitter:card", "summary"],
    ["name", "twitter:title", opts.title],
    ["name", "twitter:description", opts.description],
    ["name", "twitter:image", `${ORIGIN}/icon-180.png`],
  ];
}

/** Rendered form, escaped. Kept next to `socialTags` so the two cannot drift. */
export function socialTagsHtml(opts: SocialOptions): string {
  return socialTags(opts)
    .map(([attr, key, value]) => `<meta ${attr}="${escapeHtml(key)}" content="${escapeHtml(value)}" />`)
    .join("\n    ");
}

/**
 * Everything adds to `<head>`, in document order. Consumed by `page`.
 *
 * Returned as `Raw` because it is markup this module produced. Every value
 * interpolated into it has been through `escapeHtml` above.
 */
export function headMetadata(opts: StructuredDataOptions): Raw {
  return raw(
    [
      `<link rel="canonical" href="${escapeHtml(opts.canonical)}" />`,
      alternateLinks(opts.path),
      themeColorTags(),
      socialTagsHtml({
        canonical: opts.canonical,
        title: opts.socialTitle,
        description: opts.description,
      }),
      structuredData(opts),
    ]
      .filter(Boolean)
      .join("\n    "),
  );
}
