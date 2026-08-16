/**
 * `/llms.txt`.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 *
 * It is not a sitemap in prose. `/sitemap.xml` is the list of URLs; this is the
 * document an agent reads to decide **which of these tools to call, with what,
 * and what it will get back**. So every entry leads with the question the tool
 * answers, and then gives the exact call — the URL, the parameter and the
 * representation — rather than a description of a web page it would have to
 * scrape.
 *
 * already gave every tool page a Markdown mirror and a JSON mirror.
 * This is the index of that: without it, the mirrors exist and nothing knows.
 *
 * It mirrors what `tx402.io/llms.txt` and `docs.tx402.io/llms.txt` already do,
 * down to the one-blockquote summary and the `- [Name](url): what it is`
 * bullet shape, because an agent that has read one of the three should not have
 * to learn a second format for the third.
 *
 * ── Two things this file must not get wrong ────────────────────────────────
 *
 * 1. **`tx402-tools` and `tx402-tools-mcp` are installable as of 0.1.0**, and
 *    for a long time they were not — both names held a reserved `0.0.0`
 *    placeholder, and this file said so in as many words. The invariant is not
 *    "say they are unreleased"; it is **never advertise a command that does not
 *    work**. An agent that reads this file and runs `npx -y tx402-tools-mcp`
 *    must get the server, not a placeholder. If a release is ever pulled, this
 *    copy goes back rather than staying optimistic.
 * 2. **The route list is derived, never retyped.** Titles, descriptions and
 *    intents come from `ui/tool-meta.ts` and the live flags come with them, so
 *    a tool that is not live cannot be advertised here as if it were.
 */

import { text } from "../http.js";
import { SITE, TOOLS } from "../../ui/tool-meta.js";
import { CATEGORIES } from "../../ui/pages/compare/catalogue.js";
import type { RouteContext, RouteHandler } from "../types.js";

/**
 * The call an agent should actually make, per tool. This is the column
 * `ui/tool-meta.ts` does not have and should not: it is about the wire, not
 * about search intent.
 */
const INVOCATION: Record<keyof typeof TOOLS, { call: string; note: string }> = {
  inspect: {
    call: "GET /api/v1/inspect?url=<https url>",
    note: "Probes the endpoint once and returns terms, decoded challenge, per-check results and an observation band. Shared politeness cache: a repeat within the window returns the cached result with its age rather than re-probing somebody else's paid API.",
  },
  verify: {
    call: "POST /api/v1/verify  {challenge, url?}",
    note: "Static checks on a challenge you already hold. No probe, no network call to the endpoint. This is the one to call at the moment you are about to sign.",
  },
  policy: {
    call: "POST /api/v1/policy/evaluate  {challenge, policy}",
    note: "Runs the real tx402 PolicyEngine and returns the allow/deny plus the exact typed error your own code would raise.",
  },
  history: {
    call: "GET /api/v1/history?url=<https url>",
    note: "Price, payout address, availability and latency over time, with every terms change dated. Answers NO_DATA honestly for an endpoint nobody has probed yet.",
  },
  compare: {
    call: "GET /api/v1/compare?category=<slug>  ·  GET /api/v1/categories",
    note: "Endpoints in one curated category, side by side. Refuses to rank rows scored under different score_versions rather than ranking them wrongly.",
  },
  replay: {
    call: "GET /replay  (UI)  ·  tx402-tools replay <trace>  (CLI, local)",
    note: "Reconstructs a failed payment lifecycle from a trace you already have. The trace stays on your machine unless you explicitly share a redacted one.",
  },
};

const ORDER = ["inspect", "verify", "policy", "history", "compare", "replay"] as const;

export const llmsTxt: RouteHandler = (ctx: RouteContext): Response => {
  const origin = ctx.env.PUBLIC_ORIGIN;
  const lines: string[] = [];

  lines.push(
    "# tx402 tools",
    "",
    // One unwrapped line, matching `tx402.io/llms.txt` and
    // `docs.tx402.io/llms.txt`: the llms.txt convention is that the blockquote
    // immediately after the H1 is the whole-site summary, and a reader taking
    // just that line should get a complete sentence rather than a fragment.
    `> ${SITE.description} Every result is available as JSON, as a plaintext Markdown report, or as an HTML page — the same computation, three renderings. Challenge decoding and policy evaluation here run \`decodePaymentRequired\` and \`PolicyEngine\` from the \`tx402\` SDK itself, so what these tools say about a challenge is what the SDK would do with it. Free, no account, no API key.`,
    "",
  );

  // ── how to call anything, stated once and up front ──────────────────────
  // An agent that reads only the first screen of this file should already be
  // able to make a correct request. Everything below is which endpoint, not how.
  lines.push(
    "## How to call any of this",
    "",
    "```",
    `curl -H 'Accept: application/json' '${origin}/inspect?url=https://an.example/paid'   # structured`,
    `curl -H 'Accept: text/markdown'   '${origin}/inspect?url=https://an.example/paid'   # report`,
    `curl                              '${origin}/inspect.md?url=https://an.example/paid' # same, no header`,
    "```",
    "",
    "- `Accept: application/json` or the `/api/v1/…` path → the JSON envelope.",
    "- `Accept: text/markdown`, a `.md` suffix, or `?format=md` → the plaintext report.",
    "- `?format=` beats `Accept:`, so a link can pin one representation.",
    "- Every negotiated response carries `Vary: Accept` and `Link: rel=alternate` for the other two.",
    "- The Markdown report is a rendering of the same JSON. They cannot disagree.",
    "",
  );

  // ── the tools ───────────────────────────────────────────────────────────
  lines.push("## Tools", "");
  for (const key of ORDER) {
    const tool = TOOLS[key];
    const how = INVOCATION[key];
    lines.push(
      `### ${tool.name} — ${tool.h1}`,
      "",
      `- Page: [${tool.path}](${origin}${tool.path})${tool.live ? "" : " *(not live yet)*"}`,
      `- Call: \`${how.call}\``,
      `- Answers: ${tool.intent.split(" · ").join(", ")}.`,
      `- ${how.note}`,
      "",
    );
  }

  // ── category pages ──────────────────────────────────────────────────────
  // These are the "cheapest x402 <thing> API" pages. An agent shopping for an
  // endpoint wants the slug list, not a crawl of the hub page.
  const published = CATEGORIES.filter((c) => c.published);
  if (published.length > 0) {
    lines.push(
      "## Categories",
      "",
      "Curated comparison pages, one per category. Membership is assigned from the facilitator's own",
      "tags and the published set is a human decision with a written definition you can dispute.",
      "",
      ...published.map((c) => `- [${c.slug}](${origin}/compare/${c.slug}): ${c.summary}`),
      "",
      `Machine-readable index: [${origin}/api/v1/categories](${origin}/api/v1/categories)`,
      "",
    );
  }

  // ── run it without a browser ────────────────────────────────────────────
  lines.push(
    "## Without a browser",
    "",
    "Two packages put these tools where the work happens. Both are published, Apache-2.0, and neither",
    "one can pay for anything: they hold no keys and construct no payment signature.",
    "",
    "```bash",
    "npm i -g tx402-tools          # the CLI",
    "npx -y tx402-tools-mcp        # the MCP server, over stdio",
    "```",
    "",
    "- [`tx402-tools`](https://github.com/neogeeks/tx402-tools/tree/main/packages/tools-cli) — the CLI.",
    "  `inspect`, `verify`, `history`, `compare`, `replay`. It reaches `localhost` and private endpoints",
    "  the hosted probe is forbidden from touching, and `verify` runs fully offline: zero network calls,",
    "  asserted by a test that traps `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`.",
    "- [`tx402-tools-mcp`](https://github.com/neogeeks/tx402-tools/tree/main/packages/tools-mcp) — an MCP",
    "  server over stdio exposing `inspect_endpoint` (asks this service) and `verify_challenge` (local,",
    "  sends nothing). For an agent that is about to pay something, inside the client it already runs in.",
    "",
    "The buyer SDK that actually pays is a different package and a different repository:",
    "[`tx402`](https://www.npmjs.com/package/tx402) — non-custodial, operates no backend, and never",
    "contacts this service. That separation is enforced, not asserted.",
    "",
  );

  // ── contracts ───────────────────────────────────────────────────────────
  lines.push(
    "## Contracts",
    "",
    `- [JSON Schemas](${origin}/api/v1/schemas): one per response type, JSON Schema 2020-12. The CLI and`,
    "  the MCP server validate against these before a character reaches a model; you can too.",
    `- [Service metadata](${origin}/api/v1/meta): api_version, score_version, tx402_version, schema_version.`,
    `- [Error reference](${origin}/errors): every error code, its HTTP status, and whether retrying helps.`,
    "- [SPEC.md](https://github.com/neogeeks/tx402-tools/blob/main/spec/SPEC.md): the frozen contract.",
    `- [Known facilitators](${origin}/api/v1/facilitators): each row with a dated source, so "known`,
    '  facilitator" is checkable by the person it is being claimed at.',
    "",
  );

  // ── the things an agent should know before quoting us ───────────────────
  lines.push(
    "## What this service will and will not do",
    "",
    // The x402 signature header is named in SPEC §1.7, which this file links
    // to. It is not spelled out here because `pnpm gate:no-signer` scans every
    // source file for it and its prose allowlist is documentation-only —
    // allowlisting a route file to make a sentence read better would weaken the
    // gate that enforces the claim the sentence is making.
    "- **It cannot pay.** No signer, no key material, and no payment signature header is constructed",
    "  anywhere in this repository. CI greps for the shape of all three and fails the build.",
    "- **It never returns an IP address, a cookie, a visitor identifier or a request signature.**",
    "- **A LOW / MEDIUM / HIGH band describes how much of what we check we could confirm.** It is not a",
    "  judgement about the operator of an endpoint, and it must not be quoted as one.",
    `  Every signal, weight and threshold: [${origin}/methodology](${origin}/methodology).`,
    "- **Scores are only comparable within one `score_version`**, which every response carries.",
    "- **An endpoint we have never seen returns NO_DATA**, not a low score. Unknown is not bad.",
    `- **Operators can claim an endpoint, correct a fact, or opt out**: [${origin}/crawler](${origin}/crawler).`,
    "- Probes are rate-limited per target, not per caller, so a cached answer says `cached: true` and",
    "  gives its age rather than pretending to be live. There is also a whole-service daily ceiling on",
    "  probes the public can cause; past it, cached answers are still served and fresh ones are refused",
    `  with RATE_LIMITED. Both limits, and what they cost: [${origin}/api/v1/health](${origin}/api/v1/health).`,
    "- **Nobody is identified anywhere in this product.** No accounts, no sign-in, no cookies, no visitor",
    "  identifier, and no IP address stored in any form — there is no table in the schema in which a",
    `  person could be stored. [${origin}/privacy](${origin}/privacy).`,
    "",
  );

  // ── the rest of the ecosystem ───────────────────────────────────────────
  lines.push(
    "## The rest of tx402",
    "",
    "- [tx402.io](https://tx402.io): the buyer SDK — spend policy and budget committed before any signer",
    "  is touched, for TypeScript and Python.",
    "- [docs.tx402.io](https://docs.tx402.io): guides and reference. Every page has a `.md` mirror too.",
    "  Most useful next to these tools: [the payment lifecycle](https://docs.tx402.io/guides/lifecycle/),",
    "  [policy](https://docs.tx402.io/guides/policy/) and",
    "  [the typed error taxonomy](https://docs.tx402.io/reference/errors/).",
    "- [github.com/neogeeks/tx402-tools](https://github.com/neogeeks/tx402-tools): this service,",
    "  Apache-2.0, including the scoring function and every weight in it.",
    "",
    "## Machine-readable surfaces",
    "",
    `- [Sitemap](${origin}/sitemap.xml)`,
    // `/.md`, not `/index.md`. `stripMarkdownSuffix` reduces `/index.md` to
    // `/index`, which is not a route — the home page advertised that in its
    // `Link: rel=alternate` header from the first deploy and it 404'd the whole
    // time. That header was fixed; this line is the same wrong URL in the file
    // agents actually read, and it survived because the check that found the
    // header only followed headers.
    `- [Markdown homepage](${origin}/.md)`,
    `- [Payment discovery manifest](${origin}/.well-known/x402.json): what this service charges, which is`,
    "  nothing — an empty `accepts`, stated in the format a payment client already parses.",
    `- [Crawler policy](${origin}/robots.txt) · [Security contact](${origin}/.well-known/security.txt)`,
    `- [Privacy policy](${origin}/privacy) · [Crawler and opt-out](${origin}/crawler)`,
  );

  return text(lines.join("\n"), "text/plain; charset=utf-8");
};
