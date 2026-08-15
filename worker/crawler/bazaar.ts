/**
 * x402 Bazaar ingestion — `GET {facilitator}/discovery/resources`.
 *
 * This is the corpus bootstrap: History, Compare and Watch are
 * worthless against an empty database, and Bazaar is how it is non-empty on day
 * one.
 *
 * ── The shape is not what any single document says it is ──────────────────
 *
 * Three descriptions of this endpoint were in front of me and **no live
 * facilitator matches any of them exactly**. Measured 2026-08-14, full table in. :
 *
 *   `extensions.bazaar{input,output,serviceName,tags,iconUrl}`
 *                     with `lastUpdated` unspecified
 *   x402 v2 spec §8   `metadata`, and `lastUpdated` as a **Unix integer**
 *   what is served top-level `serviceName`/`tags`/`iconUrl`, an
 *                     `extensions.bazaar.info{input,output}` sub-object, and
 *                     `lastUpdated` as an **ISO 8601 string** — on every one of
 *                     the four facilitators that answered
 *
 * and the envelope differs too: `{items, pagination}` on Coinbase, Solvador and
 * near-x402, `{resources, total, limit, offset}` on Primev.
 *
 * So this parser is deliberately tolerant in its input and strict in its
 * output. It accepts every shape above, reads metadata from whichever of the
 * three places carries it, and normalizes to `DiscoveredResource`. Being strict
 * about a shape the ecosystem does not actually agree on would mean an empty
 * corpus, which is the one outcome says we cannot have.
 *
 * What it does NOT do is trust any of it. A Bazaar listing is a claim by a
 * facilitator about somebody else's endpoint: the URL is a lead to probe, the
 * advertised `accepts` are recorded for cross-checking, and `lastUpdated` is
 * stored as a claim and never as a date we observed (and the
 * "First seen must never be a number we made up" exit criterion).
 */

import { CRAWLER_USER_AGENT } from "../lib/guard.js";
import {
  BAZAAR_PAGE_SIZE,
  type DiscoveredResource,
  type DiscoveryPage,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `lastUpdated`, kept as text whatever the source sent.
 *
 * The specification says integer; every live facilitator sends an ISO string.
 * Rather than pick a winner and drop the other, both are preserved verbatim —
 * an integer is stringified, a string is kept as-is. Nothing downstream parses
 * this into a date, because nothing downstream is entitled to treat a
 * third-party claim as an observation.
 */
function claimedLastUpdated(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * Metadata, from whichever of the three documented locations carries it.
 *
 * Order is most-specific-first: an explicit top-level field beats the spec's
 * `metadata` object, which beats the `bazaar` extension. Every facilitator
 * observed so far uses the first; the others are here because two written
 * specifications say so and a facilitator may yet follow one.
 */
function metadataOf(item: Record<string, unknown>): Record<string, unknown> {
  const meta = record(item.metadata) ?? {};
  const bazaar = record(record(item.extensions)?.bazaar) ?? {};
  const info = record(bazaar.info) ?? {};
  return { ...info, ...bazaar, ...meta, ...item };
}

/** One discovery item, normalized. Returns null when there is no usable URL. */
export function normalizeItem(value: unknown): DiscoveredResource | null {
  const item = record(value);
  if (!item) return null;

  // `resource` is the spec's field. Some listings use `url` or `endpoint`;
  // accepting them costs nothing and an unusable row is dropped below anyway.
  const url = str(item.resource) ?? str(item.url) ?? str(item.endpoint);
  if (!url) return null;

  const meta = metadataOf(item);
  const type = str(item.type) === "mcp" ? "mcp" : "http";

  return {
    url,
    type,
    serviceName: str(meta.serviceName) ?? str(meta.name) ?? null,
    description: str(meta.description) ?? null,
    mimeType: str(meta.mimeType) ?? null,
    tags: tagList(meta.tags),
    iconUrl: str(meta.iconUrl) ?? null,
    claimedLastUpdated: claimedLastUpdated(item.lastUpdated),
    accepts: Array.isArray(item.accepts) ? item.accepts : [],
    raw: value,
  };
}

/**
 * Parse a discovery response body, whatever envelope it arrived in.
 *
 * The `envelope` field of the result records which one it was. That is not
 * decoration: it is how.'s table of "what real facilitators
 * actually return" stays true as the ecosystem moves, without anyone having to
 * re-run this investigation by hand.
 */
export function parseDiscovery(body: unknown, requestedOffset = 0): DiscoveryPage {
  const root = record(body);

  let raw: unknown[] = [];
  let envelope: DiscoveryPage["envelope"] = "unknown";

  if (Array.isArray(body)) {
    raw = body;
    envelope = "array";
  } else if (root && Array.isArray(root.items)) {
    raw = root.items;
    envelope = "items";
  } else if (root && Array.isArray(root.resources)) {
    raw = root.resources;
    envelope = "resources";
  }

  const items = raw
    .map(normalizeItem)
    .filter((r): r is DiscoveredResource => r !== null);

  // Pagination is `{limit, offset, total}` nested under `pagination` on three
  // facilitators and flat on the fourth.
  const page = record(root?.pagination) ?? root ?? {};
  const total = typeof page.total === "number" ? page.total : null;
  const offset = typeof page.offset === "number" ? page.offset : requestedOffset;

  // Only advance when the source both claims more AND actually returned a full
  // page. A source that reports a large `total` and then serves nothing would
  // otherwise page forever.
  const consumed = offset + raw.length;
  const nextOffset =
    total !== null && consumed < total && raw.length > 0 ? consumed : null;

  return { items, total, nextOffset, envelope };
}

/**
 * Fetch one page of a facilitator's Bazaar listing.
 *
 * Deliberately a plain `fetch` and NOT `guardedFetch`: the guard's job is to
 * make an arbitrary user-supplied URL safe to fetch, and a facilitator base URL
 * is neither user-supplied nor arbitrary — it comes from the published,
 * dated, human-reviewed list in `worker/lib/facilitators.ts`. Running it through
 * the SSRF guard would imply the list is untrusted input, which would be the
 * wrong claim to encode. Every URL this returns is then probed *through* the
 * guard, which is where the untrusted data actually enters.
 */
export async function fetchDiscoveryPage(
  discoveryUrl: string,
  offset: number,
  fetchImpl: typeof fetch = fetch,
  pageSize: number = BAZAAR_PAGE_SIZE,
): Promise<{ page: DiscoveryPage | null; status: number; error: string | null }> {
  const url = new URL(discoveryUrl);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String(offset));

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { "user-agent": CRAWLER_USER_AGENT, accept: "application/json" },
    });
  } catch (error) {
    return {
      page: null,
      status: 0,
      error: error instanceof Error ? error.message : "fetch failed",
    };
  }

  if (!response.ok) {
    return { page: null, status: response.status, error: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A facilitator serving an HTML 404 page with a 200 status is a real case
    // (two of the seven listed do exactly this), and it is not an exception.
    return { page: null, status: response.status, error: "response was not JSON" };
  }

  return { page: parseDiscovery(body, offset), status: response.status, error: null };
}
