/**
 * Seed sources other than Bazaar: `xpaysh/awesome-x402` and the x402.org
 * ecosystem page).
 *
 * ── Why this parser is fussy ──────────────────────────────────────────────
 *
 * `awesome-x402` is a 370 KB curated README containing **2,203 URLs**
 * (measured 2026-08-14), and the overwhelming majority are not x402 endpoints:
 * they are GitHub repositories, npm and PyPI packages, documentation, EIPs,
 * MDN, Discord invites and blog posts. A naive "extract every link" seeder
 * would put a couple of thousand rows into the corpus, of which a handful are
 * probeable endpoints — and then spend the probe budget for weeks discovering
 * that github.com does not serve a 402.
 *
 * So extraction is deliberately conservative in two ways:
 *
 *  1. **A host denylist** removes the categories that are structurally not
 *     endpoints. It is a denylist rather than an allowlist because the point of
 *     the list is to find endpoints we do not already know about.
 *  2. **A discovery-link preference.** A link to `/.well-known/x402.json` or a
 *     path that looks like an API is a far better lead than a project's home
 *     page, and both are kept when both appear.
 *
 * Whatever survives is still only a *candidate*. The first probe decides: an
 * origin that answers without an x402 challenge is marked `not_x402` and stops
 * consuming budget. That is the self-cleaning property that makes a
 * conservative-but-imperfect parser acceptable — a wrong guess costs one probe,
 * once.
 */

import { CRAWLER_USER_AGENT } from "../lib/guard.js";
import type { DiscoveredResource } from "./types.js";

export const AWESOME_X402_URL =
  "https://raw.githubusercontent.com/xpaysh/awesome-x402/main/README.md";

/**
 * Hosts that are never an x402 endpoint.
 *
 * Matched on the registrable suffix so `gist.github.com` and `api.github.com`
 * are both covered by one entry.
 */
const NEVER_ENDPOINTS: readonly string[] = Object.freeze([
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "pkg.go.dev",
  "eips.ethereum.org",
  "developer.mozilla.org",
  "en.wikipedia.org",
  "x.com",
  "twitter.com",
  "discord.gg",
  "discord.com",
  "t.me",
  "youtube.com",
  "youtu.be",
  "medium.com",
  "substack.com",
  "notion.so",
  "linkedin.com",
  "reddit.com",
  "stackoverflow.com",
  "shields.io",
  "img.shields.io",
  "smithery.ai",
  "glama.ai",
  "vercel.app",
  "netlify.app",
]);

/** Paths that are documentation even on a host that also serves endpoints. */
const DOC_PATH = /^\/(docs?|blog|guide|about|pricing|terms|privacy|legal)(\/|$)/iu;

/**
 * Subdomains that are documentation whatever the path.
 *
 * `docs.cdp.coinbase.com/x402` is the case that made this necessary: the path
 * carries no `/docs` segment, so a path-only rule reads a documentation site as
 * an endpoint and spends a probe finding out otherwise.
 */
const DOC_HOST = /^(docs?|developers?|blog|www\.docs|help|support|learn)\./iu;

export function looksLikeEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  for (const denied of NEVER_ENDPOINTS) {
    if (host === denied || host.endsWith(`.${denied}`)) return false;
  }

  if (DOC_HOST.test(host)) return false;

  // A file extension that is plainly a document rather than an API response.
  if (/\.(pdf|png|jpe?g|svg|gif|md|zip|tar\.gz)$/iu.test(url.pathname)) return false;

  if (DOC_PATH.test(url.pathname)) return false;

  return true;
}

/**
 * Pull candidate endpoint URLs out of a markdown document.
 *
 * Both inline links (`[text](url)`) and the parenthesised extras the list uses
 * for discovery documents (`([Discovery](https://…/.well-known/x402.json))`)
 * are the same markdown construct, so one pattern covers both.
 */
export function parseAwesomeList(markdown: string, sourceUrl: string): DiscoveredResource[] {
  const found = new Map<string, DiscoveredResource>();
  const link = /\[([^\]]{1,200})\]\((https:\/\/[^\s)]+)\)/gu;

  let match: RegExpExecArray | null;
  while ((match = link.exec(markdown)) !== null) {
    const label = (match[1] ?? "").trim();
    const url = (match[2] ?? "").trim();

    if (!looksLikeEndpoint(url)) continue;
    if (found.has(url)) continue;

    found.set(url, {
      url,
      type: "http",
      // The link text is the project's own name, which is the best
      // service name available from a document of this kind. It is
      // superseded the moment Bazaar or a probe supplies a better one.
      serviceName: label.length > 0 && label.length <= 120 ? label : null,
      description: null,
      mimeType: null,
      tags: [],
      iconUrl: null,
      // A curated list makes no claim about when a resource last changed.
      claimedLastUpdated: null,
      accepts: [],
      raw: { source: sourceUrl, label, url },
    });
  }

  return [...found.values()];
}

/** Fetch and parse the awesome-x402 list. */
export async function fetchAwesomeList(
  fetchImpl: typeof fetch = fetch,
  url: string = AWESOME_X402_URL,
): Promise<{ resources: DiscoveredResource[]; error: string | null }> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "user-agent": CRAWLER_USER_AGENT, accept: "text/plain" },
      redirect: "follow",
    });
    if (!response.ok) return { resources: [], error: `HTTP ${response.status}` };
    const body = await response.text();
    return { resources: parseAwesomeList(body, url), error: null };
  } catch (error) {
    return {
      resources: [],
      error: error instanceof Error ? error.message : "fetch failed",
    };
  }
}
