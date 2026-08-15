/**
 * robots.txt, fetched and honoured.
 *
 * `docs/abuse-policy.md` is the contract this implements, and it was written
 * before the crawler existed precisely so that this file has something specific
 * to be held to rather than a convention invented here:
 *
 *   - evaluated for `tx402-tools-crawler` and for `*`
 *   - a `Disallow` covering the path stops the probe
 *   - `Crawl-delay` is respected
 *   - unreachable ⇒ allowed (the usual convention)
 *   - **401 or 403 ⇒ disallowed** (less usual, and deliberate: an origin that
 *     refuses to show us its robots.txt has not invited us in)
 *   - cached with an expiry, so honouring it does not itself become a second
 *     request per probe
 */

import { CRAWLER_USER_AGENT } from "../lib/guard.js";

/** The product token from our UA, which is what a robots.txt names. */
export const CRAWLER_UA_TOKEN = "tx402-tools-crawler";

/** How long a robots.txt is trusted before we ask again. */
export const ROBOTS_TTL_SECONDS = 86_400;

/** Cap on the body we will read; a robots.txt is a small text file. */
export const MAX_ROBOTS_BYTES = 64 * 1024;

export interface RobotsRules {
  /** Path prefixes we may not fetch. */
  disallow: string[];
  /** Path prefixes explicitly re-allowed inside a disallowed prefix. */
  allow: string[];
  crawlDelaySeconds: number | null;
}

export interface RobotsVerdict {
  allowed: boolean;
  crawlDelaySeconds: number | null;
  /** Why, in a form the crawler log and the opt-out page can both render. */
  reason: string;
}

/**
 * Parse robots.txt into the rules that apply to us.
 *
 * Group selection follows the standard: a group naming our token wins outright,
 * and `*` applies only when no specific group exists. Consecutive `User-agent`
 * lines share one group of rules, which is a real and commonly-used form.
 */
export function parseRobots(body: string): RobotsRules {
  const specific: RobotsRules = { disallow: [], allow: [], crawlDelaySeconds: null };
  const wildcard: RobotsRules = { disallow: [], allow: [], crawlDelaySeconds: null };

  let current: RobotsRules[] = [];
  // A directive ends the run of user-agent lines that opened the group.
  let collectingAgents = false;

  for (const line of body.split(/\r?\n/u)) {
    const withoutComment = line.split("#")[0] ?? "";
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    const field = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents) {
        current = [];
        collectingAgents = true;
      }
      const agent = value.toLowerCase();
      if (agent === "*") current.push(wildcard);
      // Substring match: a robots.txt naming `tx402-tools-crawler/1.0` or just
      // `tx402-tools` is plainly addressing us, and reading it strictly would
      // let a good-faith opt-out silently fail.
      else if (
        CRAWLER_UA_TOKEN.startsWith(agent) ||
        agent.startsWith(CRAWLER_UA_TOKEN)
      ) {
        current.push(specific);
      }
      continue;
    }

    collectingAgents = false;
    if (current.length === 0) continue;

    for (const group of current) {
      if (field === "disallow") {
        // An empty Disallow means "nothing is disallowed" and must not be
        // stored as the prefix "", which would match every path.
        if (value.length > 0) group.disallow.push(value);
      } else if (field === "allow") {
        if (value.length > 0) group.allow.push(value);
      } else if (field === "crawl-delay") {
        const delay = Number(value);
        if (Number.isFinite(delay) && delay >= 0) group.crawlDelaySeconds = delay;
      }
    }
  }

  const hasSpecific =
    specific.disallow.length > 0 ||
    specific.allow.length > 0 ||
    specific.crawlDelaySeconds !== null;

  return hasSpecific ? specific : wildcard;
}

/** Longest matching prefix wins; `Allow` wins ties, per the usual reading. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      if (path.startsWith(pattern) && pattern.length > best) best = pattern.length;
    }
    return best;
  };

  const disallowed = longest(rules.disallow);
  if (disallowed === -1) return true;
  return longest(rules.allow) >= disallowed;
}

/**
 * Fetch an origin's robots.txt.
 *
 * A plain `fetch` for the same reason as the Bazaar listing: the origin here is
 * one the guard has ALREADY validated for the endpoint we are about to probe.
 * Re-validating the same origin would double the DNS work for no additional
 * safety, and the URL is constructed by us rather than supplied by anyone.
 */
export async function fetchRobots(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: string | null; status: number; allowsUs: boolean; reason: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/robots.txt`, {
      method: "GET",
      headers: { "user-agent": CRAWLER_USER_AGENT, accept: "text/plain" },
      redirect: "follow",
    });
  } catch {
    // Unreachable is allowed, per the policy page and the usual convention.
    return { body: null, status: 0, allowsUs: true, reason: "robots.txt unreachable" };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      body: null,
      status: response.status,
      allowsUs: false,
      reason: `robots.txt returned ${response.status}`,
    };
  }

  if (response.status === 404 || response.status >= 500) {
    return {
      body: null,
      status: response.status,
      allowsUs: true,
      reason: `no robots.txt (HTTP ${response.status})`,
    };
  }

  const text = (await response.text()).slice(0, MAX_ROBOTS_BYTES);
  return { body: text, status: response.status, allowsUs: true, reason: "robots.txt read" };
}

/** Evaluate a cached or freshly-read robots.txt against one path. */
export function verdictFor(
  body: string | null,
  status: number,
  path: string,
): RobotsVerdict {
  if (status === 401 || status === 403) {
    return {
      allowed: false,
      crawlDelaySeconds: null,
      reason: `robots.txt returned ${status}, so this origin is treated as disallowed`,
    };
  }

  if (body === null) {
    return { allowed: true, crawlDelaySeconds: null, reason: "no robots.txt" };
  }

  const rules = parseRobots(body);
  const allowed = robotsAllows(rules, path);

  return {
    allowed,
    crawlDelaySeconds: rules.crawlDelaySeconds,
    reason: allowed ? "robots.txt allows this path" : "robots.txt disallows this path",
  };
}
