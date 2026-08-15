/**
 * GET /crawler.
 *
 * This is the page our User-Agent points at, so an operator who sees
 * `tx402-tools-crawler/1.0 (+https://tools.tx402.io/crawler)` in their access
 * log lands here and finds out what we are, what we record, and how to make us
 * stop. `docs/abuse-policy.md` is the contract; this renders it and reports the
 * live numbers next to it, because a policy page whose claims nobody can check
 * against the running system is a promise rather than a commitment.
 *
 * `optout` is re-exported from `./optout.js` rather than defined here:
 * `worker/router.ts` imports both from this module and does not own the
 * router, so the import site stays exactly as We wrote it while
 * the implementation lives in the file this change was allocated.
 */

import { envelope, json, markdown, html as htmlResponse } from "../http.js";
import { CRAWLER_USER_AGENT } from "../lib/guard.js";
import { page, pageHead } from "../../ui/components/page.js";
import { kvTable } from "../../ui/components/kv-table.js";
import { OPTOUT_WELL_KNOWN } from "../crawler/optout.js";
import { CRAWLER_UA_TOKEN } from "../crawler/robots.js";
import { maxProbesPerDay } from "../crawler/schedule.js";
import { MAX_PROBES_PER_CYCLE, TIER_INTERVAL_MINUTES } from "../crawler/types.js";
import type { RouteContext, RouteHandler } from "../types.js";

export { optout } from "./optout.js";

/**
 * The daily ceiling, derived from the schedule rather than restated.
 *
 * This page is the promise an endpoint operator holds us to, so the figure on
 * it has to be the figure the code enforces. `MAX_PROBES_PER_CYCLE × 96` was
 * not: one tick a day is the seed refresh and gets half the budget.
 */
const MAX_PROBES_PER_DAY = maxProbesPerDay(MAX_PROBES_PER_CYCLE);

const TITLE = "What the x402 crawler does, and how to stop it";
const SUMMARY =
  "tx402-tools-crawler reads the HTTP 402 payment challenge an endpoint serves and stops. " +
  "It never pays, never sends credentials, and honours robots.txt and a one-click opt-out.";

interface CrawlerStats {
  endpoints: number;
  probes_last_24h: number;
  cycles_last_24h: number;
  max_probes_per_cycle: number;
}

/**
 * Live numbers, or zeroes.
 *
 * Never throws: this page has to render for an operator who is annoyed with us
 * right now, and "500" is the wrong answer to "how do I make this stop".
 */
async function stats(ctx: RouteContext): Promise<CrawlerStats> {
  const base: CrawlerStats = {
    endpoints: 0,
    probes_last_24h: 0,
    cycles_last_24h: 0,
    max_probes_per_cycle: MAX_PROBES_PER_CYCLE,
  };

  try {
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + "Z";
    const [endpoints, cycles] = await ctx.env.DB.batch<Record<string, unknown>>([
      ctx.env.DB.prepare(
        `SELECT count(*) AS n FROM endpoints WHERE status NOT IN ('opted_out', 'gone')`,
      ),
      ctx.env.DB.prepare(
        `SELECT count(*) AS cycles, COALESCE(sum(probes_performed), 0) AS probes
           FROM crawl_cycles WHERE started_at >= ?`,
      ).bind(since),
    ]);

    base.endpoints = Number(endpoints?.results?.[0]?.n ?? 0);
    base.cycles_last_24h = Number(cycles?.results?.[0]?.cycles ?? 0);
    base.probes_last_24h = Number(cycles?.results?.[0]?.probes ?? 0);
  } catch {
    // Zeroes are honest before the first cycle runs.
  }

  return base;
}

export const crawlerInfo: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const live = await stats(ctx);

  const data = {
    user_agent: CRAWLER_USER_AGENT,
    robots_token: CRAWLER_UA_TOKEN,
    optout: {
      well_known: OPTOUT_WELL_KNOWN,
      robots: `Disallow the path for ${CRAWLER_UA_TOKEN} or *`,
      api: "POST /api/v1/optout",
      email: "abuse@tx402.io",
      honoured: "immediately, and always within one crawl cycle",
    },
    cadence_minutes: TIER_INTERVAL_MINUTES,
    limits: {
      max_probes_per_cycle: MAX_PROBES_PER_CYCLE,
      cycle_minutes: 15,
      max_probes_per_day: MAX_PROBES_PER_DAY,
      one_live_probe_per_endpoint_per_window: true,
    },
    never: [
      "pays, or constructs a payment signature",
      "sends cookies, Authorization headers or any credential",
      "follows a redirect into private address space",
      "uses any method other than GET",
      "stores your visitors' IP addresses, or ours",
    ],
    stats: live,
    policy_url: "https://github.com/neogeeks/tx402-tools/blob/main/docs/abuse-policy.md",
  };

  if (ctx.format === "json") return json(envelope(ctx.route, data), {}, ctx);

  if (ctx.format === "markdown") {
    return markdown(
      [
        `# ${TITLE}`,
        "",
        SUMMARY,
        "",
        "## Identifying us",
        "",
        "```",
        CRAWLER_USER_AGENT,
        "```",
        "",
        "## Making us stop",
        "",
        `1. **robots.txt** — disallow \`${CRAWLER_UA_TOKEN}\` or \`*\` for the paths in question.`,
        `2. **A well-known file** — serve \`${OPTOUT_WELL_KNOWN}\` with any content.`,
        "3. **The API** — `POST /api/v1/optout` with `{\"url\":\"https://…\"}` once either of the above is in place.",
        "4. **Email** — abuse@tx402.io from an address at the domain.",
        "",
        "All four are honoured immediately, and always within one crawl cycle.",
        "",
        "## What we never do",
        "",
        ...data.never.map((n) => `- It never ${n}.`),
        "",
        "## Rate limits",
        "",
        `- At most **${MAX_PROBES_PER_CYCLE} probes per 15-minute cycle** across the whole corpus ` +
          `(≤ ${MAX_PROBES_PER_DAY}/day, whatever its size).`,
        "- One live probe per endpoint per politeness window, however many people ask.",
        `- Re-probe cadence: active ${TIER_INTERVAL_MINUTES.active} min · ` +
          `corpus ${TIER_INTERVAL_MINUTES.corpus} min · dormant ${TIER_INTERVAL_MINUTES.cold} min.`,
        "",
        "## Right now",
        "",
        `- Endpoints in the corpus: ${live.endpoints}`,
        `- Probes in the last 24 hours: ${live.probes_last_24h}`,
        `- Crawl cycles in the last 24 hours: ${live.cycles_last_24h}`,
      ].join("\n"),
      {},
      ctx,
    );
  }

  const body = [
    pageHead(TITLE, SUMMARY),
    `<h2>Identifying us</h2>`,
    `<pre><code>${CRAWLER_USER_AGENT}</code></pre>`,
    `<h2>Making us stop</h2>`,
    `<ol>`,
    `<li><strong>robots.txt</strong> — disallow <code>${CRAWLER_UA_TOKEN}</code> or <code>*</code> for the paths in question.</li>`,
    `<li><strong>A well-known file</strong> — serve <code>${OPTOUT_WELL_KNOWN}</code> with any content.</li>`,
    `<li><strong>The API</strong> — <code>POST /api/v1/optout</code> once either of the above is in place.</li>`,
    `<li><strong>Email</strong> — <a href="mailto:abuse@tx402.io">abuse@tx402.io</a> from an address at the domain.</li>`,
    `</ol>`,
    `<p>All four are honoured immediately, and always within one crawl cycle. Probing stops and the endpoint stops being served. Records already written to the append-only change log are retained but no longer served — that table is append-only by database trigger, so nothing about it is quietly rewritten.</p>`,
    `<h2>What we never do</h2>`,
    `<ul>${data.never.map((n) => `<li>It never ${n}.</li>`).join("")}</ul>`,
    `<h2>Rate limits</h2>`,
    kvTable(
      [
        { label: "Probes per 15-minute cycle", value: `at most ${MAX_PROBES_PER_CYCLE}` },
        { label: "Probes per day (whole corpus)", value: `at most ${MAX_PROBES_PER_DAY}` },
        { label: "Per endpoint", value: "one live probe per politeness window, however many people ask" },
        { label: "Recently viewed", value: `every ${TIER_INTERVAL_MINUTES.active} minutes` },
        { label: "Corpus", value: `every ${TIER_INTERVAL_MINUTES.corpus} minutes` },
        { label: "Dormant", value: `every ${TIER_INTERVAL_MINUTES.cold} minutes` },
      ],
      "Crawl limits",
    ),
    `<h2>Right now</h2>`,
    kvTable(
      [
        { label: "Endpoints in the corpus", value: String(live.endpoints) },
        { label: "Probes in the last 24 hours", value: String(live.probes_last_24h) },
        { label: "Crawl cycles in the last 24 hours", value: String(live.cycles_last_24h) },
      ],
      "Live figures",
    ),
  ].join("\n");

  return htmlResponse(
    page({ title: TITLE, description: SUMMARY, path: ctx.url.pathname, body }),
    {},
    ctx,
  );
};
