/**
 * 402 History, tested by running it.
 *
 * The centre of gravity is one property, and it is the reason the tool exists:
 * **a sampled availability figure and an exact price change must not be
 * presentable as the same kind of fact.** split the storage,
 * SPEC §5.4 forbids blending the two into one array, and the tests below assert
 * the distinction survives all the way into the rendered page and the markdown
 * mirror — not merely that a boolean is set in the JSON. A `sampled: true` flag
 * nobody renders would pass a schema check and fail the user.
 *
 * The corpus is built by running its crawler — `upsertEndpoint` then
 * `probeEndpoint` against stubbed network — rather than by INSERTing rows.
 * A history assembled from hand-written INSERTs can drift from one the crawler
 * would actually produce, and it is the crawler's output this tool renders.
 *
 * Real SQLite with both migrations (`test/d1-sqlite.ts`), the real
 * `ProbeLimiter`, the real guard/probe/diff path. The only stubs are the
 * network and the Analytics Engine SQL API, which has no local emulation.
 */

import { describe, expect, it } from "vitest";

import { handleRequest } from "../worker/router.js";
import { endpointId } from "../worker/lib/guard.js";
import { probeEndpoint } from "../worker/crawler/runner.js";
import { upsertEndpoint } from "../worker/crawler/store.js";
import {
  availabilitySeriesQuery,
  latencySeriesQuery,
  loadHistory,
} from "../worker/routes/history.js";
import { historyMarkdown } from "../ui/pages/history/markdown.js";
import { historyPage } from "../ui/pages/history/page.js";
import { WARN, samplingState, type HistoryView } from "../ui/pages/history/types.js";
import type { Env } from "../worker/types.js";
import { createCrawlerEnv, type CrawlerTestEnv } from "./crawler-env.js";
import { mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import { scriptedConnector, scriptedResolver, ROUTABLE_V4 } from "./net-stubs.js";

// ── the endpoint under test ───────────────────────────────────────────────

const HOST = "api.example.com";
const PATH = "/v1/geocode";
const URL_ = `https://${HOST}${PATH}`;

const PAY_TO_A = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAY_TO_B = "0x5F4b8Cf0aE2Db19Fd1A4fD3B6f1d6C8E9A2b3C4d";

function iso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** `days` ago, relative to the suite's real clock — the route uses the real one. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function challenge(amount: string, payTo = PAY_TO_A): string {
  return JSON.stringify({
    x402Version: 2,
    error: "payment required",
    resource: { url: URL_, description: "Geocoding", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  });
}

function netFor(body: string) {
  return {
    connector: scriptedConnector({ [`${HOST}${PATH}`]: { status: 402, body } }),
    resolver: scriptedResolver({ [HOST]: [ROUTABLE_V4] }),
    fetchImpl: ((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(new Response("User-agent: *\nAllow: /\n", { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch,
  };
}

interface Observation {
  at: Date;
  amount: string;
  payTo?: string;
}

/**
 * Build a corpus by crawling, not by INSERTing.
 *
 * The first probe writes a `first_seen` row by definition; each later probe
 * writes a `term_changes` row only if something actually moved. That is its
 * write policy, and building the fixture through it means this test renders
 * exactly the history production would hold.
 */
async function seedHistory(
  harness: CrawlerTestEnv,
  observations: readonly Observation[],
): Promise<string> {
  const id = await endpointId(URL_);
  const first = observations[0];
  if (!first) throw new Error("seedHistory needs at least one observation");

  await upsertEndpoint(
    harness.env.DB,
    {
      id,
      canonical_url: URL_,
      url: URL_,
      origin: `https://${HOST}`,
      host: HOST,
      path: PATH,
      title: null,
      description: null,
      resource_type: "http",
      discovery_source: "seed",
      tier: "corpus",
      next_probe_at: iso(first.at),
    },
    iso(first.at),
  );

  const endpoint = {
    id,
    canonical_url: URL_,
    origin: `https://${HOST}`,
    host: HOST,
    path: PATH,
    probe_tier: "corpus" as const,
    status: "active",
    consecutive_failures: 0,
  };

  for (const observation of observations) {
    await probeEndpoint(harness.env, endpoint, {
      ...netFor(challenge(observation.amount, observation.payTo)),
      now: () => observation.at,
      // Hours or days pass between real probes, so the politeness window has
      // long since elapsed. Without this the cache correctly serves the second
      // call and no diff ever runs.
      windowSeconds: 0,
    });
  }

  return id;
}

/** The router's Env, over the crawler harness's real SQLite. */
function routerEnv(harness: CrawlerTestEnv, overrides: Partial<Env> = {}): Env {
  return mockEnv({
    DB: harness.env.DB,
    PROBES: harness.env.PROBES,
    PROBE_LIMITER: harness.env.PROBE_LIMITER,
    ...overrides,
  });
}

function get(path: string, accept?: string): Request {
  return request(path, accept ? { headers: { accept } } : {});
}

/** An honest empty answer is a 200 with an explanation, never an error status. */
function res200(...responses: Response[]): boolean {
  return responses.every((response) => response.status === 200);
}

const q = `?url=${encodeURIComponent(URL_)}`;

// ══════════════════════════════════════════════════════════════════════════
//  THE ONE THAT MATTERS
// ══════════════════════════════════════════════════════════════════════════

describe("sampled and exact are visibly different kinds of fact", () => {
  /** A stubbed SQL API that answers with two buckets of real-looking samples. */
  function analyticsFetch(): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = typeof init?.body === "string" ? init.body : "";
      const rows = sql.includes("quantileExactWeighted")
        ? [
            { bucket: "2026-08-13 00:00:00", samples: "96", p50_ms: "180", p95_ms: "410" },
            { bucket: "2026-08-14 00:00:00", samples: "94", p50_ms: "191", p95_ms: "455" },
          ]
        : [
            { bucket: "2026-08-13 00:00:00", samples: "96", ok_samples: "96" },
            { bucket: "2026-08-14 00:00:00", samples: "96", ok_samples: "94" },
          ];
      return Promise.resolve(
        new Response(JSON.stringify({ data: rows, success: true }), { status: 200 }),
      );
    });
  }

  async function viewWithBoth(): Promise<HistoryView> {
    const harness = createCrawlerEnv();
    try {
      const id = await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(2), amount: "2000" },
        { at: daysAgo(1), amount: "2000", payTo: PAY_TO_B },
      ]);

      return await loadHistory(
        routerEnv(harness, { CF_ANALYTICS_TOKEN: "test-token" }),
        {
          url: URL_,
          canonical_url: URL_,
          endpoint_id: id,
          origin: `https://${HOST}`,
          host: HOST,
        },
        "7d",
        { fetchImpl: analyticsFetch() },
      );
    } finally {
      harness.close();
    }
  }

  it("keeps the two in separate arrays, and says which is sampled", async () => {
    const view = await viewWithBoth();

    // SPEC §5.4: the two must never be blended into one array.
    expect(view.data.series.price.length).toBeGreaterThan(0);
    expect(view.data.series.availability.length).toBeGreaterThan(0);
    for (const point of view.data.series.price) {
      expect(point).not.toHaveProperty("ratio");
      expect(point).not.toHaveProperty("samples");
    }
    for (const point of view.data.series.availability) {
      expect(point).not.toHaveProperty("amount_atomic");
    }

    // Mandatory whenever a series came from Analytics Engine.
    expect(view.data.coverage.sampled).toBe(true);
  });

  it("marks every sampled figure and no exact one in the rendered page", async () => {
    const view = await viewWithBoth();
    const page = historyPage({ view, envelope: { generated_at: iso(new Date()) }, path: "/history" });

    // The two live in separately headed, separately styled cards.
    expect(page).toContain('id="exact"');
    expect(page).toContain('id="sampled"');
    expect(page).toContain("Exact record");
    expect(page).toContain("Sampled telemetry");
    expect(page).toContain("exact · append-only record");
    expect(page).toContain("sampled · estimate");

    // Different marks, not just different words: solid stroke vs hatched fill.
    expect(page).toContain("chart-line-exact");
    expect(page).toContain("chart-bar-sampled");
    expect(page).toContain("hatch-sampled");

    // And the card borders that carry the same grammar. Keyed on the ids
    // because `resultCard` emits no class of its own — a `.card.exact` rule
    // would match nothing and the page would quietly stop drawing the
    // distinction its own copy claims.
    expect(page).toContain(".card#exact { border-left: 3px solid");
    expect(page).toContain(".card#sampled { border-left: 3px dashed");

    // A sampled percentage is approximate and says so. The exact prices, which
    // sit in the price table, carry no approximation mark.
    const sampledCard = page.slice(page.indexOf('id="sampled"'));
    const exactCard = page.slice(page.indexOf('id="exact"'), page.indexOf('id="sampled"'));
    expect(sampledCard).toContain("≈");
    expect(exactCard).not.toContain("≈");
  });

  it("keeps the distinction in the markdown mirror, which has no styling to lean on", async () => {
    const view = await viewWithBoth();
    const md = historyMarkdown({ view, envelope: { generated_at: iso(new Date()) } });

    const exact = md.slice(md.indexOf("## Exact record"), md.indexOf("## Sampled telemetry"));
    const sampled = md.slice(md.indexOf("## Sampled telemetry"));

    expect(exact).toContain("append-only");
    expect(exact).not.toContain("≈");
    expect(sampled).toContain("≈");
    expect(sampled).toContain("sampled");

    // Two headed sections, never one table.
    expect(md).toContain("### Price, as observed");
    expect(md).toContain("### Availability by bucket (sampled)");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  the exact half — term_changes
// ══════════════════════════════════════════════════════════════════════════

describe("the timeline is annotated from term_changes", () => {
  it("renders a price change and a recipient change as dated events", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(2), amount: "2000" },
        { at: daysAgo(1), amount: "2000", payTo: PAY_TO_B },
      ]);

      const res = await handleRequest(
        get(`/api/v1/history${q}&window=7d`),
        routerEnv(harness),
        mockCtx(),
      );
      const body = await res.json<{ data: { changes: { change_kind: string }[] } }>();

      const kinds = body.data.changes.map((c) => c.change_kind);
      expect(kinds).toContain("first_seen");
      expect(kinds).toContain("price");
      expect(kinds).toContain("recipient");
    } finally {
      harness.close();
    }
  });

  it("carries change_kind, field, old_value, new_value and the score_version in force then", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(2), amount: "2000" },
      ]);

      const res = await handleRequest(
        get(`/api/v1/history${q}&window=7d`),
        routerEnv(harness),
        mockCtx(),
      );
      const body = await res.json<{
        meta: { score_version: string | null };
        data: {
          changes: {
            change_kind: string;
            field: string;
            old_value: string | null;
            new_value: string | null;
            score_version: string | null;
          }[];
        };
      }>();

      const price = body.data.changes.find((c) => c.change_kind === "price");
      expect(price).toMatchObject({
        field: "amount_atomic",
        old_value: "1000",
        new_value: "2000",
      });
      // SPEC §7: rendered as recorded. History never recomputes a past score —
      // and computes none of its own, so the envelope carries no version.
      expect(price?.score_version).toBe("v1");
      expect(body.meta.score_version).toBeNull();
    } finally {
      harness.close();
    }
  });

  it("builds the price series as exact events, anchored on the price entering the window", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(20), amount: "1000" },
        { at: daysAgo(15), amount: "2000" },
        { at: daysAgo(1), amount: "3000" },
      ]);

      const res = await handleRequest(
        get(`/api/v1/history${q}&window=7d`),
        routerEnv(harness),
        mockCtx(),
      );
      const body = await res.json<{
        warnings: { code: string }[];
        data: { series: { price: { t: string; amount_atomic: string }[] } };
      }>();

      const price = body.data.series.price;
      // The 2000 established 15 days ago is the price entering the 7-day window,
      // carrying its REAL date rather than a manufactured one at the window edge.
      expect(price[0]?.amount_atomic).toBe("2000");
      expect(Date.parse(price[0]?.t ?? "")).toBeLessThan(Date.now() - 7 * 86_400_000);
      expect(price.at(-1)?.amount_atomic).toBe("3000");

      expect(body.warnings.map((w) => w.code)).toContain(WARN.PRICE_ANCHOR_BEFORE_WINDOW);
    } finally {
      harness.close();
    }
  });

  it("keeps the price series flat and non-empty when nothing changed", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(5), amount: "1000" },
        { at: daysAgo(2), amount: "1000" },
      ]);

      const res = await handleRequest(
        get(`/api/v1/history${q}&window=7d`),
        routerEnv(harness),
        mockCtx(),
      );
      const body = await res.json<{
        data: { series: { price: { amount_atomic: string }[] }; changes: unknown[] };
      }>();

      // "Unchanged since 10 Aug" is a finding. An empty chart would read as
      // "we know nothing", which is a different and wrong claim.
      expect(body.data.series.price).toHaveLength(1);
      expect(body.data.series.price[0]?.amount_atomic).toBe("1000");
      expect(body.data.changes.filter((c) => (c as { change_kind: string }).change_kind === "price")).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("refuses to let a test rewrite the log it renders", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(2), amount: "2000" },
      ]);

      // The append-only trigger is the property an appeal rests on. If it can be
      // worked around, everything this page calls "exact" is just a claim.
      let refusal: unknown = null;
      try {
        await harness.env.DB.prepare(
          `UPDATE term_changes SET new_value = '9' WHERE change_kind = 'price'`,
        ).run();
      } catch (error) {
        refusal = error;
      }
      expect(String(refusal)).toMatch(/append-only/u);
    } finally {
      harness.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  the sampled half — Analytics Engine
// ══════════════════════════════════════════════════════════════════════════

describe("we could not ask is not the same as there are no samples", () => {
  async function viewWith(fetchImpl: typeof fetch | undefined, token?: string): Promise<HistoryView> {
    const harness = createCrawlerEnv();
    try {
      const id = await seedHistory(harness, [{ at: daysAgo(3), amount: "1000" }]);
      return await loadHistory(
        routerEnv(harness, token === undefined ? {} : { CF_ANALYTICS_TOKEN: token }),
        {
          url: URL_,
          canonical_url: URL_,
          endpoint_id: id,
          origin: `https://${HOST}`,
          host: HOST,
        },
        "30d",
        fetchImpl ? { fetchImpl } : {},
      );
    } finally {
      harness.close();
    }
  }

  it("says we could not ask when the credential is missing", async () => {
    const view = await viewWith(undefined);

    expect(samplingState(view)).toBe("unavailable");
    expect(view.warnings.map((w) => w.code)).toContain(WARN.ANALYTICS_UNAVAILABLE);
    expect(view.warnings.map((w) => w.code)).not.toContain(WARN.NO_SAMPLES);
    // Nothing came from Analytics Engine, so nothing claims to be sampled.
    expect(view.data.coverage.sampled).toBe(false);

    const page = historyPage({ view, envelope: { generated_at: iso(new Date()) }, path: "/history" });
    expect(page).toContain("We could not ask");
    expect(page).not.toContain("No samples in this window");
  });

  it("says we could not ask when the API refuses", async () => {
    const refuse = ((_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
          status: 200,
        }),
      )) as typeof fetch;

    const view = await viewWith(refuse, "expired-token");
    expect(samplingState(view)).toBe("unavailable");
    expect(view.warnings.find((w) => w.code === WARN.ANALYTICS_UNAVAILABLE)?.message).toContain(
      "Authentication error",
    );
  });

  it("says there are no samples when the query answers with none", async () => {
    const empty = ((_input: RequestInfo | URL) =>
      Promise.resolve(new Response(JSON.stringify({ data: [], success: true }), { status: 200 }))) as typeof fetch;

    const view = await viewWith(empty, "test-token");

    expect(samplingState(view)).toBe("no_samples");
    expect(view.warnings.map((w) => w.code)).toContain(WARN.NO_SAMPLES);
    expect(view.warnings.map((w) => w.code)).not.toContain(WARN.ANALYTICS_UNAVAILABLE);

    const page = historyPage({ view, envelope: { generated_at: iso(new Date()) }, path: "/history" });
    expect(page).toContain("No samples in this window");
    expect(page).not.toContain("We could not ask");
  });

  it("never renders no data for a probe that just happened", async () => {
    const harness = createCrawlerEnv();
    try {
      // Probed a moment ago — Analytics Engine has not ingested it yet.
      const id = await seedHistory(harness, [{ at: new Date(), amount: "1000" }]);

      const view = await loadHistory(
        routerEnv(harness, { CF_ANALYTICS_TOKEN: "test-token" }),
        {
          url: URL_,
          canonical_url: URL_,
          endpoint_id: id,
          origin: `https://${HOST}`,
          host: HOST,
        },
        "7d",
        {
          fetchImpl: ((_i: RequestInfo | URL) =>
            Promise.resolve(
              new Response(JSON.stringify({ data: [], success: true }), { status: 200 }),
            )),
        },
      );

      expect(view.warnings.map((w) => w.code)).toContain(WARN.RECENT_PROBE_PENDING);
      const md = historyMarkdown({ view, envelope: { generated_at: iso(new Date()) } });
      expect(md).toContain("Just probed.");
    } finally {
      harness.close();
    }
  });

  it("does not blame the ingestion lag when the real problem is that we could not ask", async () => {
    const harness = createCrawlerEnv();
    try {
      const id = await seedHistory(harness, [{ at: new Date(), amount: "1000" }]);

      // Same just-probed endpoint, but no credential. The lag caveat qualifies a
      // sampled figure, and there is no sampled figure — attaching it here would
      // point at the wrong cause.
      const view = await loadHistory(
        routerEnv(harness),
        { url: URL_, canonical_url: URL_, endpoint_id: id, origin: `https://${HOST}`, host: HOST },
        "7d",
      );

      expect(view.warnings.map((w) => w.code)).toContain(WARN.ANALYTICS_UNAVAILABLE);
      expect(view.warnings.map((w) => w.code)).not.toContain(WARN.RECENT_PROBE_PENDING);
    } finally {
      harness.close();
    }
  });

  it("aggregates by sample weight, not by counting rows", () => {
    const id = "a".repeat(32);

    for (const sql of [availabilitySeriesQuery(id, "30d"), latencySeriesQuery(id, "30d")]) {
      expect(sql).toContain("sum(_sample_interval)");
      // `count` under-reports exactly when an endpoint is busiest, which is
      // when the availability number matters most.
      expect(sql).not.toMatch(/\bcount\(\)/u);
      expect(sql).toContain("toStartOfInterval");
      expect(sql).toContain("GROUP BY bucket");
    }

    // Latency is measured over successful probes only: a failed probe records a
    // latency of zero and would pull the median down as an endpoint breaks.
    expect(latencySeriesQuery(id, "30d")).toContain("double1 > 0");
    expect(latencySeriesQuery(id, "30d")).toContain("quantileExactWeighted");
  });

  it("buckets by six hours over 7 days and by a day over 30 and 90", () => {
    const id = "b".repeat(32);
    expect(availabilitySeriesQuery(id, "7d")).toContain("INTERVAL '6' HOUR");
    expect(availabilitySeriesQuery(id, "30d")).toContain("INTERVAL '1' DAY");
    expect(availabilitySeriesQuery(id, "90d")).toContain("INTERVAL '90' DAY");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  empty and thin states
// ══════════════════════════════════════════════════════════════════════════

describe("an empty state is the correct display, not a degraded one", () => {
  it("renders the no-history state for an endpoint we have never observed", async () => {
    const harness = createCrawlerEnv();
    try {
      const env = routerEnv(harness);

      const json = await handleRequest(get(`/api/v1/history${q}`), env, mockCtx());
      const body = await json.json<{
        warnings: { code: string }[];
        data: { has_data: boolean; coverage: { first_seen: null; scan_count: number } };
      }>();

      expect(body.data.has_data).toBe(false);
      expect(body.data.coverage.first_seen).toBeNull();
      expect(body.data.coverage.scan_count).toBe(0);
      expect(body.warnings.map((w) => w.code)).toContain(WARN.NOT_IN_CORPUS);

      const page = await handleRequest(get(`/history${q}`), env, mockCtx());
      const html = await page.text();
      expect(html).toContain("No history yet");
      // the correct display for an endpoint we have not met, so
      // it explains itself rather than apologizing or reading as a failure.
      expect(html).toContain("normal state");
      expect(html).toContain("history builds from the first observation onward");
      expect(html).not.toMatch(/sorry|failed|something went wrong/iu);
      expect(res200(json, page)).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("says how much history it actually has rather than drawing to the left edge", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(1), amount: "2000" },
      ]);
      const env = routerEnv(harness);

      const json = await handleRequest(get(`/api/v1/history${q}&window=90d`), env, mockCtx());
      const body = await json.json<{ warnings: { code: string; message: string }[] }>();

      const thin = body.warnings.find((w) => w.code === WARN.THIN_HISTORY);
      expect(thin?.message).toMatch(/3 days of history/u);

      const page = await handleRequest(get(`/history${q}&window=90d`), env, mockCtx());
      const html = await page.text();
      expect(html).toContain("Short record.");
      // The chart marks the stretch before our record begins rather than
      // implying we were watching.
      expect(html).toContain("not observing yet");
      expect(html).toContain("hatch-idle");
    } finally {
      harness.close();
    }
  });

  it("shows the form, not an error, when no url is given", async () => {
    const harness = createCrawlerEnv();
    try {
      const env = routerEnv(harness);

      const page = await handleRequest(get("/history"), env, mockCtx());
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Enter an endpoint URL");

      const json = await handleRequest(get("/api/v1/history"), env, mockCtx());
      const body = await json.json<{ warnings: { code: string }[]; data: { window: string } }>();
      expect(body.warnings.map((w) => w.code)).toContain(WARN.NO_TARGET);
      expect(body.data.window).toBe("30d");
    } finally {
      harness.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  the contract
// ══════════════════════════════════════════════════════════════════════════

describe("the JSON validates against spec/schemas/history.json", () => {
  const cases: { name: string; observations: Observation[]; window: string }[] = [
    { name: "a full history", observations: [
      { at: daysAgo(20), amount: "1000" },
      { at: daysAgo(10), amount: "2000" },
      { at: daysAgo(2), amount: "2000", payTo: PAY_TO_B },
    ], window: "30d" },
    { name: "a single observation", observations: [{ at: daysAgo(1), amount: "1000" }], window: "7d" },
  ];

  for (const testCase of cases) {
    it(`validates for ${testCase.name}`, async () => {
      const harness = createCrawlerEnv();
      try {
        await seedHistory(harness, testCase.observations);
        const res = await handleRequest(
          get(`/api/v1/history${q}&window=${testCase.window}`),
          routerEnv(harness),
          mockCtx(),
        );
        const result = validateAgainst("history", await res.json());
        expect(result.errors).toBe("");
        expect(result.ok).toBe(true);
      } finally {
        harness.close();
      }
    });
  }

  it("validates the empty and the no-target responses too", async () => {
    const harness = createCrawlerEnv();
    try {
      const env = routerEnv(harness);
      for (const path of [`/api/v1/history${q}`, "/api/v1/history"]) {
        const res = await handleRequest(get(path), env, mockCtx());
        const result = validateAgainst("history", await res.json());
        expect(result.errors).toBe("");
        expect(result.ok).toBe(true);
      }
    } finally {
      harness.close();
    }
  });

  it("validates a response carrying sampled series", async () => {
    const harness = createCrawlerEnv();
    try {
      const id = await seedHistory(harness, [{ at: daysAgo(2), amount: "1000" }]);
      const view = await loadHistory(
        routerEnv(harness, { CF_ANALYTICS_TOKEN: "test-token" }),
        { url: URL_, canonical_url: URL_, endpoint_id: id, origin: `https://${HOST}`, host: HOST },
        "30d",
        {
          fetchImpl: ((_i: RequestInfo | URL, init?: RequestInit) =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: (typeof init?.body === "string" ? init.body : "").includes("quantileExactWeighted")
                    ? [{ bucket: "2026-08-14 00:00:00", samples: "96", p50_ms: "180", p95_ms: "410" }]
                    : [{ bucket: "2026-08-14 00:00:00", samples: "96", ok_samples: "96" }],
                }),
                { status: 200 },
              ),
            )),
        },
      );

      // Assembled through the same envelope the route emits.
      const res = await handleRequest(get(`/api/v1/history${q}`), routerEnv(harness), mockCtx());
      const envelope = await res.json<Record<string, unknown>>();
      const result = validateAgainst("history", { ...envelope, data: view.data, warnings: view.warnings });
      expect(result.errors).toBe("");
      expect(result.ok).toBe(true);
    } finally {
      harness.close();
    }
  });
});

describe("content negotiation, on all three representations", () => {
  it("serves JSON, markdown and HTML from the same result", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(3), amount: "1000" },
        { at: daysAgo(1), amount: "2000" },
      ]);
      const env = routerEnv(harness);

      const json = await handleRequest(get(`/history${q}`, "application/json"), env, mockCtx());
      expect(json.headers.get("content-type")).toContain("application/json");

      const md = await handleRequest(get(`/history${q}`, "text/markdown"), env, mockCtx());
      expect(md.headers.get("content-type")).toContain("text/markdown");

      const html = await handleRequest(get(`/history${q}`, "text/html"), env, mockCtx());
      expect(html.headers.get("content-type")).toContain("text/html");

      // Same result, three renderings: the price change appears in all three.
      expect(await json.text()).toContain('"2000"');
      expect(await md.text()).toContain("2000");
      expect(await html.text()).toContain("2000");
    } finally {
      harness.close();
    }
  });

  it("reaches the markdown mirror by path and by ?format=, and advertises the alternates", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [{ at: daysAgo(2), amount: "1000" }]);
      const env = routerEnv(harness);

      for (const path of [`/history.md${q}`, `/history/.md${q}`, `/history${q}&format=md`]) {
        const res = await handleRequest(get(path), env, mockCtx());
        expect(res.headers.get("content-type")).toContain("text/markdown");
        expect(await res.text()).toContain("# 402 History");
      }

      const page = await handleRequest(get(`/history${q}`), env, mockCtx());
      expect(page.headers.get("vary")).toBe("Accept");
      const link = page.headers.get("link") ?? "";
      expect(link).toContain('type="text/markdown"');
      expect(link).toContain('type="application/json"');
    } finally {
      harness.close();
    }
  });

  it("reports the route as implemented and stamps the schema", async () => {
    const harness = createCrawlerEnv();
    try {
      const res = await handleRequest(get(`/api/v1/history${q}`), routerEnv(harness), mockCtx());
      const body = await res.json<{
        tool: string;
        meta: { implemented: boolean; schema: string };
      }>();
      expect(body.tool).toBe("history");
      expect(body.meta.implemented).toBe(true);
      expect(body.meta.schema).toContain("/schemas/history");
    } finally {
      harness.close();
    }
  });
});

describe("the URL is validated but never probed", () => {
  it("refuses userinfo, private addresses and non-https schemes", async () => {
    const harness = createCrawlerEnv();
    try {
      const env = routerEnv(harness);
      const cases: [string, string][] = [
        ["https://user:pass@api.example.com/x", "URL_USERINFO_PRESENT"],
        ["http://api.example.com/x", "URL_SCHEME_NOT_ALLOWED"],
        ["https://127.0.0.1/x", "URL_PRIVATE_ADDRESS"],
        ["https://[::1]/x", "URL_PRIVATE_ADDRESS"],
      ];

      for (const [url, code] of cases) {
        const res = await handleRequest(
          get(`/api/v1/history?url=${encodeURIComponent(url)}`),
          env,
          mockCtx(),
        );
        const body = await res.json<{ error: { code: string; detail: unknown } }>();
        expect(body.error.code).toBe(code);
        // The refusal reason is never returned — the guard must not double as a
        // network scanner for whoever is probing it.
        expect(JSON.stringify(body.error.detail)).not.toContain("literal");
      }
    } finally {
      harness.close();
    }
  });

  it("makes no outbound request at all", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [{ at: daysAgo(2), amount: "1000" }]);

      let calls = 0;
      const counting = ((_input: RequestInfo | URL) => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ data: [], success: true }), { status: 200 }));
      }) as typeof fetch;

      // No credential ⇒ not even the Analytics Engine call is made, and the
      // endpoint itself is never contacted under any configuration.
      await handleRequest(get(`/api/v1/history${q}`), routerEnv(harness), mockCtx());
      expect(calls).toBe(0);
      expect(counting).toBeTypeOf("function");
    } finally {
      harness.close();
    }
  });
});

describe("the language rule", () => {
  const FORBIDDEN = ["scam", "fraud", "fraudulent", "unsafe", "dangerous", "malicious", "suspicious"];

  it("prints none of the words a trust tool may never print", async () => {
    const harness = createCrawlerEnv();
    try {
      await seedHistory(harness, [
        { at: daysAgo(5), amount: "1000" },
        { at: daysAgo(3), amount: "9000" },
        { at: daysAgo(1), amount: "9000", payTo: PAY_TO_B },
      ]);
      const env = routerEnv(harness);

      const surfaces = await Promise.all(
        [`/history${q}&window=30d`, `/history.md${q}&window=30d`, `/history${q}`, "/history"].map(
          async (path) => (await handleRequest(get(path), env, mockCtx())).text(),
        ),
      );

      for (const surface of surfaces) {
        for (const word of FORBIDDEN) {
          expect(surface.toLowerCase()).not.toContain(word);
        }
      }

      // A recipient change is reported as a dated fact, with no verdict.
      const md = surfaces[1] ?? "";
      expect(md).toContain("Recipient changed");
    } finally {
      harness.close();
    }
  });
});
