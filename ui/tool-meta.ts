/**
 * Canonical copy and search metadata for every tool.
 *
 * It exists so that the copy survives the sessions that replace the stubs: when
 *  rewrites `worker/routes/inspect.ts` it still imports `TOOLS.inspect`, so
 * the title, the description and the H1 do not quietly revert to whatever that
 * session felt like typing.
 *
 * ── The rule this copy follows ──
 *
 * **Every string here targets a CATEGORY term, not the brand term.** Nobody
 * searches for a vendor when their payment just failed — they search for the
 * symptom. "why did my x402 payment fail", "what does this x402 endpoint
 * charge", "compare x402 APIs". So the tools are named after the question they
 * answer, and the brand appears in the title suffix and the CTA, which is where
 * it converts.
 *
 *  owns the full audit — JSON-LD, sitemap, canonical URLs, the cross-links
 * into docs and landing, and a page-by-page check against §3.1. This file is
 * the foundation it audits, not a substitute for it.
 */

export interface ToolMeta {
  /** Route path. */
  path: string;
  /** Short product name, used in nav and card headings. */
  name: string;
  /** `<title>`. Leads with the category term; the brand is the suffix. */
  title: string;
  /** `<meta name="description">` and the card blurb. One sentence, ~155 chars. */
  description: string;
  /** Page `<h1>`. Phrased as the question a searcher actually types. */
  h1: string;
  /** The search intent this page is for. Documented so can audit it. */
  intent: string;
  live: boolean;
}

// `satisfies` rather than an annotation: it type-checks every entry AND keeps
// the literal keys, so `TOOLS.inspect` is known to exist. Annotating it as
// Record<string, ToolMeta> would make every lookup possibly-undefined under
// noUncheckedIndexedAccess.
export const TOOLS = {
  inspect: {
    path: "/inspect",
    name: "402 Inspector",
    title: "x402 endpoint inspector — what does this API charge?",
    description:
      "See what an x402 API charges before you call it: price per request, token, network and payout address, decoded by the same strict decoder the tx402 SDK uses before it pays.",
    h1: "What does this x402 endpoint charge?",
    intent: "x402 inspector · x402 endpoint price · what does this x402 API cost",
    live: true,
  },

  verify: {
    path: "/verify",
    name: "402 Verify",
    title: "Verify an x402 payment challenge before you sign it",
    description:
      "Check an x402 payment challenge for problems before signing: strict decoding, canonical atomic amount, recognized network and asset, and whether the resource origin matches.",
    h1: "Verify an x402 payment challenge",
    intent: "verify x402 payment challenge · is this x402 challenge valid · x402 challenge checker",
    live: true,
  },

  policy: {
    path: "/policy",
    name: "402 Policy Playground",
    title: "x402 spend policy playground — test budgets and allowlists",
    description:
      "Try an x402 spend policy against a real payment challenge and see which rule allows or blocks it, in evaluation order, with the exact error your code would raise.",
    h1: "Test an x402 spend policy against a real challenge",
    intent: "x402 spend limit · x402 budget policy · agent payment guardrails",
    live: true,
  },

  history: {
    path: "/history",
    name: "402 History",
    title: "x402 API price history — track price and recipient changes",
    description:
      "See how an x402 endpoint's price, payout address, availability and latency have changed over time, with every terms change dated and recorded.",
    h1: "How has this x402 endpoint's price changed?",
    intent: "x402 price history · did this x402 API change its price · x402 endpoint uptime",
    live: true,
  },

  compare: {
    path: "/compare",
    name: "402 Compare",
    title: "Compare x402 APIs — price per call, uptime and latency",
    description:
      "Compare x402 endpoints side by side on price per call, network, asset, observed availability and latency — with explicit gaps where there is not enough data yet.",
    h1: "Compare x402 APIs side by side",
    intent: "cheapest x402 API · compare x402 endpoints · best x402 geocoding API",
    live: true,
  },

  replay: {
    path: "/replay",
    name: "402 Replay",
    title: "Why did my x402 payment fail? — replay the lifecycle",
    description:
      "Debug a failed x402 payment: reconstruct the lifecycle from your trace or typed error, find the phase that broke, and learn whether retrying is safe or would pay twice.",
    h1: "Why did my x402 payment fail?",
    intent: "x402 payment failed · x402 debugging · is it safe to retry an x402 payment",
    live: true,
  },
} satisfies Record<string, ToolMeta>;

export const SITE = {
  name: "tx402 tools",
  title: "x402 tools — inspect, verify and debug x402 payment endpoints",
  description:
    "Free tools for the x402 payment protocol: see what an endpoint charges, verify a payment challenge before you sign it, test a spend policy, and debug a failed payment.",
  h1: "Tools for the x402 payment protocol",
  tagline:
    "Challenge decoding and policy evaluation here run the same code the tx402 SDK runs before it pays — so what these tools say is what the SDK would do.",
};

/** Title suffix. The brand goes last: the category term is what earns the click. */
export function pageTitle(title: string): string {
  return title === SITE.title ? title : `${title} | ${SITE.name}`;
}
