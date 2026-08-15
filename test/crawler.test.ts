/**
 * The data plane, tested by running it.
 *
 * The centre of gravity is the first block: **a price change writes exactly one
 * `term_changes` row, and an unchanged re-probe writes none.**
 * makes that the whole design, and it is the property that every downstream
 * tool inherits — History annotates those rows, Watch alerts on them, and an
 * appeal is argued from them. A duplicate row is a duplicate alert about
 * somebody else's business; a missing one is a business event no later probe
 * can recover.
 *
 * Everything here runs against real SQLite with the real migrations, the real
 * `ProbeLimiter`, and the real guard/probe/signals/score path. The only
 * stubs are the network (`test/net-stubs.ts`, reused per ) and
 * Analytics Engine, which has no local emulation.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { endpointId } from "../worker/lib/guard.js";
import { diffTerms, type TermsSnapshot } from "../worker/crawler/diff.js";
import { parseDiscovery, normalizeItem } from "../worker/crawler/bazaar.js";
import { parseRobots, robotsAllows, verdictFor } from "../worker/crawler/robots.js";
import { parseAwesomeList, looksLikeEndpoint } from "../worker/crawler/seeds.js";
import { ingestResources } from "../worker/crawler/ingest.js";
import { probeEndpoint, nextProbeTime } from "../worker/crawler/runner.js";
import { phasesFor, budgetFor } from "../worker/crawler/schedule.js";
import { classifyRecipients, buildHistoryInput } from "../worker/crawler/history.js";
import { recordOptOut, isOptedOut } from "../worker/crawler/optout.js";
import {
  availabilityFor,
  availabilityQuery,
  pointFromProbe,
  PROBE_POINT_LAYOUT,
} from "../worker/crawler/analytics.js";
import { newId, upsertEndpoint, loadTerms, dueEndpoints } from "../worker/crawler/store.js";
import {
  COLD_START_ENDPOINT_FLOOR,
  MAX_PROBES_PER_CYCLE,
  type DiscoveredResource,
  type ProbeTier,
} from "../worker/crawler/types.js";
import { runQueue, runScheduled } from "../worker/crawler/index.js";
import { withPoliteness } from "../worker/lib/politeness.js";
import type { CrawlMessage } from "../worker/types.js";
import { createCrawlerEnv, fakeBatch, type CrawlerTestEnv } from "./crawler-env.js";
import { scriptedConnector, scriptedResolver, ROUTABLE_V4 } from "./net-stubs.js";

const here = dirname(fileURLToPath(import.meta.url));
const bazaarFixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "bazaar-discovery.json"), "utf8"),
) as Record<string, unknown>;

// ── a stubbed endpoint we can change the price of ─────────────────────────

const HOST = "api.example.com";
const PATH = "/v1/geocode";
const URL_ = `https://${HOST}${PATH}`;

/** A spec-shaped x402 v2 challenge (the shape its addendum A1 establishes). */
function challenge(amount: string, payTo = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C") {
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

function netFor(body: string, robots = "User-agent: *\nAllow: /\n") {
  const connector = scriptedConnector({
    [`${HOST}${PATH}`]: { status: 402, body },
  });
  const resolver = scriptedResolver({ [HOST]: [ROUTABLE_V4] });

  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url.endsWith("/robots.txt")) {
      return Promise.resolve(new Response(robots, { status: 200 }));
    }
    // The well-known opt-out probe: absent unless a test says otherwise.
    return Promise.resolve(new Response("", { status: 404 }));
  }) as typeof fetch;

  return { connector, resolver, fetchImpl };
}

async function seedEndpoint(harness: CrawlerTestEnv, now: string) {
  const id = await endpointId(URL_);
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
      next_probe_at: now,
    },
    now,
  );
  return {
    id,
    canonical_url: URL_,
    origin: `https://${HOST}`,
    host: HOST,
    path: PATH,
    probe_tier: "corpus" as const,
    status: "active",
    consecutive_failures: 0,
  };
}

async function countChanges(harness: CrawlerTestEnv, kind?: string) {
  const row = await harness.env.DB.prepare(
    kind
      ? `SELECT count(*) AS n FROM term_changes WHERE change_kind = ?`
      : `SELECT count(*) AS n FROM term_changes`,
  )
    .bind(...(kind ? [kind] : []))
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ══════════════════════════════════════════════════════════════════════════
//  THE ONE THAT MATTERS
// ══════════════════════════════════════════════════════════════════════════

describe("a change is recorded exactly once", () => {
  it("writes ONE price row on a price change, and NONE on an unchanged re-probe", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const endpoint = await seedEndpoint(harness, now.toISOString().slice(0, 19) + "Z");

    // ── probe 1: first sight. One `first_seen` row, by definition.
    let net = netFor(challenge("1000"));
    let outcome = await probeEndpoint(harness.env, endpoint, { ...net, now: () => now });

    expect(outcome.kind).toBe("probed");
    expect(await countChanges(harness)).toBe(1);
    expect(await countChanges(harness, "first_seen")).toBe(1);
    expect(await countChanges(harness, "price")).toBe(0);

    // ── probe 2: the SAME terms again. This is the common case by an enormous
    // margin and it must cost exactly nothing.
    const later = new Date("2026-08-14T11:00:00Z");
    net = netFor(challenge("1000"));
    outcome = await probeEndpoint(harness.env, endpoint, {
      ...net,
      now: () => later,
      // Hours pass between real probes, so the politeness window has long since
      // elapsed. A window of 0 expresses that; without it the cache correctly
      // serves the second call and the diff never runs.
      windowSeconds: 0,
    });

    expect(outcome).toMatchObject({ kind: "probed", changed: false, changes: 0 });
    expect(await countChanges(harness)).toBe(1); // still just the first_seen row

    // ── probe 3: the price moves. Exactly one row, of kind `price`.
    const later2 = new Date("2026-08-14T12:00:00Z");
    net = netFor(challenge("2000"));
    outcome = await probeEndpoint(harness.env, endpoint, {
      ...net,
      now: () => later2,
      windowSeconds: 0,
    });

    expect(outcome).toMatchObject({ kind: "probed", changed: true, changes: 1 });
    expect(await countChanges(harness, "price")).toBe(1);
    expect(await countChanges(harness)).toBe(2);

    const row = await harness.env.DB.prepare(
      `SELECT field, old_value, new_value, detected_by FROM term_changes WHERE change_kind = 'price'`,
    ).first<Record<string, unknown>>();

    expect(row).toMatchObject({
      field: "amount_atomic",
      old_value: "1000",
      new_value: "2000",
      detected_by: "crawler",
    });

    // terms_current is the materialized "right now" and holds only the latest.
    const terms = await loadTerms(harness.env.DB, endpoint.id);
    expect(terms?.amount_atomic).toBe("2000");

    harness.close();
  });

  it("re-serialization is not a change (canonical-hash keying)", () => {
    // The same terms with the keys in a different order hash identically, so
    // the diff never runs. its `challengeHash` canonicalizes; this asserts the
    // crawler actually depends on that rather than comparing raw strings.
    const base: TermsSnapshot = {
      x402_version: 2,
      wire_form: "v2-header",
      scheme: "exact",
      network: "eip155:8453",
      asset_address: "0xabc",
      asset_symbol: "USDC",
      asset_decimals: 6,
      amount_atomic: "1000",
      amount_decimal: "0.001",
      pay_to: "0xdef",
      pay_to_dynamic: false,
      max_timeout_seconds: 60,
      facilitator: null,
      resource: URL_,
      mime_type: "application/json",
      description: null,
      requirement_count: 1,
      extra_json: '{"a":1}',
      challenge_hash: "same-hash",
      challenge_json: '{"keys":"one order"}',
      score: 90,
      band: "LOW",
      score_version: "v1",
      signals_json: null,
      observed_at: "2026-08-14T10:00:00Z",
    };

    const reserialized: TermsSnapshot = {
      ...base,
      challenge_json: '{"keys":"a different order"}',
      observed_at: "2026-08-14T11:00:00Z",
    };

    expect(diffTerms(base, reserialized)).toEqual([]);
  });

  it("emits challenge_shape only when nothing else changed", () => {
    const before = { challenge_hash: "h1", amount_atomic: "1000", pay_to: "0xa" } as TermsSnapshot;

    // Hash moved, price moved: one `price` row and NO `challenge_shape` row —
    // otherwise one price move fires two Watch alerts.
    const priceMove = { challenge_hash: "h2", amount_atomic: "2000", pay_to: "0xa" } as TermsSnapshot;
    const moved = diffTerms(before, priceMove);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.change_kind).toBe("price");

    // Hash moved, nothing tracked moved: exactly one `challenge_shape` row.
    const shapeOnly = { challenge_hash: "h3", amount_atomic: "1000", pay_to: "0xa" } as TermsSnapshot;
    const shape = diffTerms(before, shapeOnly);
    expect(shape).toHaveLength(1);
    expect(shape[0]?.change_kind).toBe("challenge_shape");
  });

  it("a recipient change and a price change in one probe are two rows", () => {
    const before = { challenge_hash: "h1", amount_atomic: "1000", pay_to: "0xa" } as TermsSnapshot;
    const after = { challenge_hash: "h2", amount_atomic: "2000", pay_to: "0xb" } as TermsSnapshot;
    const changes = diffTerms(before, after);
    expect(changes.map((c) => c.change_kind).sort()).toEqual(["price", "recipient"]);
  });
});

describe("the write policy is the one in the schema", () => {
  it("keeps no scan row for a routine unchanged probe, and one for a change", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const endpoint = await seedEndpoint(harness, now.toISOString().slice(0, 19) + "Z");

    await probeEndpoint(harness.env, endpoint, {
      ...netFor(challenge("1000")),
      now: () => now,
    });

    const afterFirst = await harness.env.DB.prepare(
      `SELECT retained_reason FROM scans`,
    ).all<{ retained_reason: string }>();
    expect(afterFirst.results.map((r) => r.retained_reason)).toEqual(["first_seen"]);

    // Unchanged: Analytics Engine only. decision 8.
    await probeEndpoint(harness.env, endpoint, {
      ...netFor(challenge("1000")),
      now: () => new Date("2026-08-14T11:00:00Z"),
      windowSeconds: 0,
    });

    const afterUnchanged = await harness.env.DB.prepare(`SELECT count(*) AS n FROM scans`).first<{
      n: number;
    }>();
    expect(Number(afterUnchanged?.n)).toBe(1); // still only the first one

    //..but every probe wrote an availability point, including the quiet one.
    expect(harness.points.length).toBe(2);
    expect(harness.points[0]?.blobs?.[0]).toBe("probe");

    harness.close();
  });

  it("term_changes is append-only, enforced by the database and not by us", async () => {
    const harness = createCrawlerEnv();

    harness.database.raw.exec(
      `INSERT INTO term_changes (id, endpoint_id, changed_at, detected_by, change_kind, field, created_at)
       VALUES ('c1', 'e1', '2026-08-14T10:00:00Z', 'crawler', 'price', 'amount_atomic', '2026-08-14T10:00:00Z')`,
    );

    expect(() =>
      harness.database.raw.exec(`UPDATE term_changes SET new_value = 'tampered' WHERE id = 'c1'`),
    ).toThrow(/append-only/u);

    expect(() =>
      harness.database.raw.exec(`DELETE FROM term_changes WHERE id = 'c1'`),
    ).toThrow(/append-only/u);

    harness.close();
  });

  it("refuses a change_kind outside the schema vocabulary", async () => {
    const harness = createCrawlerEnv();
    expect(() =>
      harness.database.raw.exec(
        `INSERT INTO term_changes (id, endpoint_id, changed_at, detected_by, change_kind, field, created_at)
         VALUES ('c2', 'e1', '2026-08-14T10:00:00Z', 'crawler', 'vibes', 'amount_atomic', '2026-08-14T10:00:00Z')`,
      ),
    ).toThrow();
    harness.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Bazaar ingestion, against what facilitators really serve
// ══════════════════════════════════════════════════════════════════════════

describe("Bazaar ingestion", () => {
  it("parses all four envelope shapes observed in the wild", () => {
    const cdp = parseDiscovery(bazaarFixtures.cdp);
    expect(cdp.envelope).toBe("items");
    expect(cdp.items.length).toBe(3);
    expect(cdp.total).toBe(15073);

    const solvador = parseDiscovery(bazaarFixtures.solvador);
    expect(solvador.envelope).toBe("items");
    expect(solvador.items.length).toBe(2);

    // Primev uses `resources`, not `items` — the shape no specification names.
    const primev = parseDiscovery(bazaarFixtures.primev);
    expect(primev.envelope).toBe("resources");
    expect(primev.items).toEqual([]);

    const near = parseDiscovery(bazaarFixtures.near);
    expect(near.items).toEqual([]);
  });

  it("keeps the service metadata the category pages need", () => {
    const solvador = parseDiscovery(bazaarFixtures.solvador);
    const first = solvador.items[0];

    expect(first?.serviceName).toBe("Agent402.tools");
    expect(first?.tags).toContain("x402");
    expect(first?.mimeType).toBe("application/json");
    expect(first?.iconUrl).toBeTruthy();
  });

  it("reads lastUpdated whether it is an ISO string or a Unix integer", () => {
    // Every live facilitator sends a string; the v2 specification says integer.
    // Both are kept verbatim, and neither is ever parsed into a first-seen date.
    const asString = normalizeItem({
      resource: "https://a.example/x",
      lastUpdated: "2026-08-14T14:21:45.104Z",
    });
    expect(asString?.claimedLastUpdated).toBe("2026-08-14T14:21:45.104Z");

    const asInteger = normalizeItem({
      resource: "https://a.example/x",
      lastUpdated: 1766000000,
    });
    expect(asInteger?.claimedLastUpdated).toBe("1766000000");
  });

  it("reads metadata from `metadata` as the specification describes it", () => {
    const item = normalizeItem({
      resource: "https://a.example/x",
      metadata: { serviceName: "Spec Shaped", tags: ["geo"] },
    });
    expect(item?.serviceName).toBe("Spec Shaped");
    expect(item?.tags).toEqual(["geo"]);
  });

  it("does not page past the end when a source reports a total it cannot serve", () => {
    const page = parseDiscovery({ items: [], pagination: { total: 900, offset: 0, limit: 100 } });
    expect(page.nextOffset).toBeNull();
  });

  it("stores the facilitator's lastUpdated claim as provenance, never as first_seen", async () => {
    const harness = createCrawlerEnv();
    const now = "2026-08-14T10:00:00Z";

    const items = parseDiscovery(bazaarFixtures.solvador).items;
    await ingestResources(
      harness.env,
      items,
      { source: "bazaar", sourceUrl: "https://api.solvador.com/discovery/resources", facilitatorId: "solvador", tier: "corpus" },
      now,
    );

    const endpoint = await harness.env.DB.prepare(
      `SELECT first_seen, title FROM endpoints LIMIT 1`,
    ).first<Record<string, unknown>>();

    // The date we observed it — not the facilitator's claim about the resource.
    expect(endpoint?.first_seen).toBe(now);

    const provenance = await harness.env.DB.prepare(
      `SELECT claimed_last_updated, source, facilitator_id FROM endpoint_provenance LIMIT 1`,
    ).first<Record<string, unknown>>();

    expect(provenance?.source).toBe("bazaar");
    expect(provenance?.facilitator_id).toBe("solvador");
    expect(provenance?.claimed_last_updated).toBe("2026-08-14T14:21:45.104Z");
    expect(provenance?.claimed_last_updated).not.toBe(endpoint?.first_seen);

    harness.close();
  });
});

describe("dedupe across sources", () => {
  it("collapses the same endpoint from two sources onto one row and one first_seen", async () => {
    const harness = createCrawlerEnv();

    const fromBazaar: DiscoveredResource = {
      // Same endpoint, spelled differently: query order and a default port.
      url: "https://api.example.com:443/v1/geocode?b=2&a=1",
      type: "http",
      serviceName: "Geocoder",
      description: "From Bazaar",
      mimeType: null,
      tags: ["geo"],
      iconUrl: null,
      claimedLastUpdated: "2026-08-01T00:00:00Z",
      accepts: [],
      raw: {},
    };

    const fromAwesome: DiscoveredResource = {
      url: "https://api.example.com/v1/geocode?a=1&b=2",
      type: "http",
      serviceName: "Geocoder (list)",
      description: null,
      mimeType: null,
      tags: [],
      iconUrl: null,
      claimedLastUpdated: null,
      accepts: [],
      raw: {},
    };

    const first = await ingestResources(
      harness.env,
      [fromBazaar],
      { source: "bazaar", sourceUrl: "https://f.example/discovery/resources", facilitatorId: "f", tier: "corpus" },
      "2026-08-14T10:00:00Z",
    );
    expect(first.added).toBe(1);

    const second = await ingestResources(
      harness.env,
      [fromAwesome],
      { source: "awesome-x402", sourceUrl: "https://github.com/xpaysh/awesome-x402", facilitatorId: null, tier: "corpus" },
      "2026-08-20T10:00:00Z",
    );
    // Recognized as the same endpoint by canonical URL, not added again.
    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);

    const endpoints = await harness.env.DB.prepare(
      `SELECT id, first_seen, last_seen FROM endpoints`,
    ).all<Record<string, unknown>>();
    expect(endpoints.results).toHaveLength(1);

    // first_seen is the earlier date and did not move; last_seen did.
    expect(endpoints.results[0]?.first_seen).toBe("2026-08-14T10:00:00Z");
    expect(endpoints.results[0]?.last_seen).toBe("2026-08-20T10:00:00Z");

    // Both claims are retained, which is what makes the dedupe auditable.
    const provenance = await harness.env.DB.prepare(
      `SELECT source FROM endpoint_provenance ORDER BY source`,
    ).all<{ source: string }>();
    expect(provenance.results.map((r) => r.source)).toEqual(["awesome-x402", "bazaar"]);

    harness.close();
  });

  it("collapses duplicates inside a single batch before touching the database", async () => {
    const harness = createCrawlerEnv();
    const one = (url: string): DiscoveredResource => ({
      url,
      type: "http",
      serviceName: null,
      description: null,
      mimeType: null,
      tags: [],
      iconUrl: null,
      claimedLastUpdated: null,
      accepts: [],
      raw: {},
    });

    const result = await ingestResources(
      harness.env,
      [one("https://a.example/x"), one("https://a.example/x"), one("https://a.example/x/")],
      { source: "bazaar", sourceUrl: null, facilitatorId: null, tier: "corpus" },
      "2026-08-14T10:00:00Z",
    );

    expect(result.deduped).toBe(1); // the exact repeat
    expect(result.added).toBe(2); // `/x` and `/x/` are genuinely different paths
    harness.close();
  });

  it("refuses a discovered URL the guard would refuse", async () => {
    const harness = createCrawlerEnv();
    const bad = (url: string): DiscoveredResource => ({
      url,
      type: "http",
      serviceName: null,
      description: null,
      mimeType: null,
      tags: [],
      iconUrl: null,
      claimedLastUpdated: null,
      accepts: [],
      raw: {},
    });

    const result = await ingestResources(
      harness.env,
      [
        bad("http://insecure.example/x"),
        bad("https://10.0.0.5/internal"),
        bad("https://user:pass@api.example.com/x"),
        bad("not a url"),
      ],
      { source: "bazaar", sourceUrl: null, facilitatorId: null, tier: "corpus" },
      "2026-08-14T10:00:00Z",
    );

    expect(result.rejected).toBe(4);
    expect(result.added).toBe(0);
    harness.close();
  });
});

describe("awesome-x402 seeding", () => {
  it("keeps candidate endpoints and drops repositories, packages and docs", () => {
    const markdown = [
      "- [Octodamus](https://api.octodamus.com) — AI market-intelligence API.",
      "- [x402 Protocol](https://github.com/coinbase/x402) - Official implementation.",
      "- [x402 python](https://pypi.org/project/x402/) - Python SDK.",
      "- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) - Gasless transfer standard.",
      "- [Whitepaper](https://x402.org/x402-whitepaper.pdf) - Deep dive.",
      "- [Discovery](https://api.octodamus.com/.well-known/x402.json)",
      "- [Docs](https://docs.cdp.coinbase.com/x402) - Guide.",
    ].join("\n");

    const found = parseAwesomeList(markdown, "https://example/README.md");
    const urls = found.map((f) => f.url);

    expect(urls).toContain("https://api.octodamus.com");
    expect(urls).toContain("https://api.octodamus.com/.well-known/x402.json");
    expect(urls).not.toContain("https://github.com/coinbase/x402");
    expect(urls).not.toContain("https://pypi.org/project/x402/");
    expect(urls).not.toContain("https://eips.ethereum.org/EIPS/eip-3009");
    expect(urls).not.toContain("https://x402.org/x402-whitepaper.pdf");
    expect(urls).not.toContain("https://docs.cdp.coinbase.com/x402");
  });

  it("never treats an http: or code-hosting URL as an endpoint", () => {
    expect(looksLikeEndpoint("http://api.example.com/x")).toBe(false);
    expect(looksLikeEndpoint("https://gist.github.com/a/b")).toBe(false);
    expect(looksLikeEndpoint("https://api.example.com/v1/geocode")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Politeness: robots.txt and opt-out
// ══════════════════════════════════════════════════════════════════════════

describe("robots.txt is honoured", () => {
  it("parses groups, longest-prefix wins, and Allow beats Disallow on a tie", () => {
    const rules = parseRobots(
      [
        "User-agent: *",
        "Disallow: /private",
        "",
        "User-agent: tx402-tools-crawler",
        "Disallow: /v1",
        "Allow: /v1/public",
        "Crawl-delay: 5",
      ].join("\n"),
    );

    // A group naming us wins outright over `*`.
    expect(rules.crawlDelaySeconds).toBe(5);
    expect(robotsAllows(rules, "/v1/geocode")).toBe(false);
    expect(robotsAllows(rules, "/v1/public/data")).toBe(true);
    expect(robotsAllows(rules, "/private")).toBe(true); // the `*` group does not apply
  });

  it("treats an empty Disallow as allowing everything", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n");
    expect(robotsAllows(rules, "/anything")).toBe(true);
  });

  it("allows when robots.txt is missing and refuses when it is 403", () => {
    expect(verdictFor(null, 404, "/x").allowed).toBe(true);
    expect(verdictFor(null, 0, "/x").allowed).toBe(true);
    expect(verdictFor(null, 403, "/x").allowed).toBe(false);
    expect(verdictFor(null, 401, "/x").allowed).toBe(false);
  });

  it("stops the crawler probing a disallowed path, end to end", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const endpoint = await seedEndpoint(harness, now.toISOString().slice(0, 19) + "Z");

    const net = netFor(
      challenge("1000"),
      "User-agent: tx402-tools-crawler\nDisallow: /v1\n",
    );

    const outcome = await probeEndpoint(harness.env, endpoint, { ...net, now: () => now });

    expect(outcome.kind).toBe("robots_disallowed");
    // No outbound probe was made at all.
    expect(net.connector.requests).toEqual([]);
    expect(await countChanges(harness)).toBe(0);

    // And it is remembered, so the next sweep does not select it again.
    const row = await harness.env.DB.prepare(
      `SELECT robots_allowed, next_probe_at FROM endpoints WHERE id = ?`,
    )
      .bind(endpoint.id)
      .first<Record<string, unknown>>();
    expect(Number(row?.robots_allowed)).toBe(0);

    const due = await dueEndpoints(harness.env.DB, "2026-09-01T00:00:00Z", 10);
    expect(due).toEqual([]);

    harness.close();
  });
});

describe("opt-out is honoured", () => {
  it("stops probing and delists, within the same cycle", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const nowIso = now.toISOString().slice(0, 19) + "Z";
    const endpoint = await seedEndpoint(harness, nowIso);

    // It probes normally first, so the test proves a change of behaviour.
    const before = await probeEndpoint(harness.env, endpoint, {
      ...netFor(challenge("1000")),
      now: () => now,
    });
    expect(before.kind).toBe("probed");

    // The operator opts the whole origin out.
    const { endpointsAffected } = await recordOptOut(harness.env.DB, {
      id: newId(),
      scope: "origin",
      target: `https://${HOST}`,
      method: "well-known",
      evidence: "(empty file)",
      requested_at: nowIso,
      effective_at: nowIso,
    });
    expect(endpointsAffected).toBe(1);

    // Read-time: it is opted out immediately, not at the next cycle.
    const check = await isOptedOut(harness.env.DB, URL_, `https://${HOST}`, nowIso);
    expect(check?.method).toBe("well-known");

    // Crawl-time: the next probe makes no outbound request.
    const net = netFor(challenge("9999"));
    const after = await probeEndpoint(harness.env, endpoint, {
      ...net,
      now: () => new Date("2026-08-14T13:00:00Z"),
      windowSeconds: 0,
    });

    expect(after.kind).toBe("opted_out");
    expect(net.connector.requests).toEqual([]);

    // The price change at 9999 was never recorded, because it was never probed.
    expect(await countChanges(harness, "price")).toBe(0);

    // Delisted, and dropped from the sweep.
    const row = await harness.env.DB.prepare(`SELECT status FROM endpoints WHERE id = ?`)
      .bind(endpoint.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("opted_out");
    expect(await dueEndpoints(harness.env.DB, "2026-09-01T00:00:00Z", 10)).toEqual([]);

    // The append-only record survives — it is not served, but it is not erased.
    expect(await countChanges(harness, "first_seen")).toBe(1);

    harness.close();
  });

  it("an origin opt-out covers endpoints discovered after it was recorded", async () => {
    const harness = createCrawlerEnv();
    const nowIso = "2026-08-14T10:00:00Z";

    await recordOptOut(harness.env.DB, {
      id: newId(),
      scope: "origin",
      target: "https://later.example",
      method: "robots",
      evidence: null,
      requested_at: nowIso,
      effective_at: nowIso,
    });

    const found = await isOptedOut(
      harness.env.DB,
      "https://later.example/discovered/afterwards",
      "https://later.example",
      "2026-09-01T00:00:00Z",
    );
    expect(found).not.toBeNull();
    harness.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Scheduling and volume bounds
// ══════════════════════════════════════════════════════════════════════════

describe("the schedule branches on wall-clock, not on cron triggers", () => {
  it("pumps every tick, sweeps 6-hourly, refreshes seeds once a day", () => {
    expect(phasesFor(new Date("2026-08-14T10:15:00Z"))).toEqual({
      pump: true,
      sweep: false,
      seedRefresh: false,
    });
    expect(phasesFor(new Date("2026-08-14T06:00:00Z"))).toEqual({
      pump: true,
      sweep: true,
      seedRefresh: false,
    });
    expect(phasesFor(new Date("2026-08-14T03:00:00Z"))).toEqual({
      pump: true,
      sweep: false,
      seedRefresh: true,
    });
  });

  it("counts one seed refresh per day and four sweeps, across all 96 ticks", () => {
    let sweeps = 0;
    let refreshes = 0;
    for (let tick = 0; tick < 96; tick += 1) {
      const at = new Date(Date.UTC(2026, 7, 14, 0, 0, 0) + tick * 15 * 60_000);
      const phases = phasesFor(at);
      if (phases.sweep) sweeps += 1;
      if (phases.seedRefresh) refreshes += 1;
    }
    expect(sweeps).toBe(4);
    expect(refreshes).toBe(1);
  });

  it("bounds probe volume per cycle, and therefore per day", () => {
    const normal = budgetFor({ pump: true, sweep: false, seedRefresh: false }, MAX_PROBES_PER_CYCLE);
    expect(normal).toBe(MAX_PROBES_PER_CYCLE);

    // The daily ceiling costs the model against: 40 × 96.
    expect(MAX_PROBES_PER_CYCLE * 96).toBe(3840);

    // The seed-refresh tick spends its budget on ingestion instead.
    expect(budgetFor({ pump: true, sweep: false, seedRefresh: true }, MAX_PROBES_PER_CYCLE)).toBe(20);
  });

  it("never selects more endpoints than the budget allows", async () => {
    const harness = createCrawlerEnv();
    const now = "2026-08-14T10:00:00Z";

    for (let i = 0; i < 25; i += 1) {
      const url = `https://host${i}.example/v1/api`;
      await upsertEndpoint(
        harness.env.DB,
        {
          id: await endpointId(url),
          canonical_url: url,
          url,
          origin: `https://host${i}.example`,
          host: `host${i}.example`,
          path: "/v1/api",
          title: null,
          description: null,
          resource_type: "http",
          discovery_source: "bazaar",
          tier: "corpus",
          next_probe_at: now,
        },
        now,
      );
    }

    const due = await dueEndpoints(harness.env.DB, now, 10);
    expect(due).toHaveLength(10);
    harness.close();
  });

  it("backs off exponentially on repeated failures and recovers immediately", () => {
    const from = new Date("2026-08-14T10:00:00Z");
    expect(nextProbeTime("corpus", 1, from)).toBe("2026-08-14T10:15:00Z");
    expect(nextProbeTime("corpus", 2, from)).toBe("2026-08-14T11:00:00Z");
    expect(nextProbeTime("corpus", 5, from)).toBe("2026-08-17T10:00:00Z");
    // Capped, not unbounded.
    expect(nextProbeTime("corpus", 99, from)).toBe("2026-08-17T10:00:00Z");
    // A healthy probe returns to the tier cadence at once.
    expect(nextProbeTime("active", 0, from)).toBe("2026-08-14T16:00:00Z");
    // A tier this build does not know falls back to the corpus cadence rather
    // than scheduling an Invalid Date. `watched` was retired with Watch.
    expect(nextProbeTime("watched" as ProbeTier, 0, from)).toBe("2026-08-15T10:00:00Z");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  The recipient decision
// ══════════════════════════════════════════════════════════════════════════

describe("recipient instability is observed and NOT scored", () => {
  it("never produces a scored recipient_unstable_undeclared signal", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const nowIso = now.toISOString().slice(0, 19) + "Z";
    const endpoint = await seedEndpoint(harness, nowIso);

    // Four probes, four different recipients — the shape that a naive
    // implementation of SPEC §6.4 would fire on, and that belongs to exactly
    // the marketplaces the carve-out exists to protect. Four rather than three
    // because the classifier refuses to name a pattern from fewer observations
    // than that, which is itself part of the design.
    const recipients = [
      "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      "0x11dF9F6280632aB8F12926b3f569E493EaEcf81b",
      "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
    ];

    for (const [index, payTo] of recipients.entries()) {
      await probeEndpoint(harness.env, endpoint, {
        ...netFor(challenge("1000", payTo)),
        now: () => new Date(Date.parse(nowIso) + index * 3_600_000),
        windowSeconds: 0,
      });
    }

    // The observation IS recorded.
    expect(await countChanges(harness, "recipient")).toBe(3);

    const { history, recipients: assessment } = await buildHistoryInput(
      harness.env.DB,
      endpoint.id,
      "2026-08-14T20:00:00Z",
    );

    expect(history.recipient_changes_90d).toBe(3);
    expect(assessment.distinct).toBe(4);
    expect(assessment.classification).toBe("one_shot_series");

    //..and the scored signal is left unobserved. This is the decision.
    expect(history.recipient_unstable_undeclared).toBeNull();

    // Which means it contributes nothing in either direction (SPEC §6.3).
    const terms = await loadTerms(harness.env.DB, endpoint.id);
    const signals = JSON.parse(terms?.signals_json ?? "[]") as {
      id: string;
      observed: boolean;
      value: unknown;
    }[];
    const signal = signals.find((s) => s.id === "recipient_unstable_undeclared");
    expect(signal).toMatchObject({ observed: false, value: null });

    // And score_version has not moved, so every published score stays valid.
    expect(terms?.score_version).toBe("v1");

    harness.close();
  });

  it("describes the shape of a recipient set without judging it", () => {
    expect(
      classifyRecipients({ distinct: 1, total_observations: 40, seen_once: 0, declared_dynamic: false })
        .classification,
    ).toBe("single");

    expect(
      classifyRecipients({ distinct: 3, total_observations: 3, seen_once: 3, declared_dynamic: false })
        .classification,
    ).toBe("insufficient_data");

    expect(
      classifyRecipients({ distinct: 5, total_observations: 5, seen_once: 5, declared_dynamic: false })
        .classification,
    ).toBe("one_shot_series");

    expect(
      classifyRecipients({ distinct: 3, total_observations: 30, seen_once: 0, declared_dynamic: false })
        .classification,
    ).toBe("bounded_set");

    // Every one of them scores nothing.
    for (const shape of [
      { distinct: 1, total_observations: 40, seen_once: 0, declared_dynamic: false },
      { distinct: 5, total_observations: 5, seen_once: 5, declared_dynamic: false },
      { distinct: 3, total_observations: 30, seen_once: 0, declared_dynamic: true },
    ]) {
      expect(classifyRecipients(shape).unstable_undeclared).toBeNull();
    }
  });

  it("fills in the historical signals that ARE safe to observe", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const nowIso = now.toISOString().slice(0, 19) + "Z";
    const endpoint = await seedEndpoint(harness, nowIso);

    await probeEndpoint(harness.env, endpoint, { ...netFor(challenge("1000")), now: () => now });
    await probeEndpoint(harness.env, endpoint, {
      ...netFor(challenge("2000")),
      now: () => new Date("2026-08-15T10:00:00Z"),
      windowSeconds: 0,
    });

    const { history } = await buildHistoryInput(
      harness.env.DB,
      endpoint.id,
      "2026-08-20T10:00:00Z",
    );

    expect(history.first_seen_age_days).toBe(6);
    expect(history.scan_count).toBe(2);
    expect(history.price_changes_90d).toBe(1);
    expect(history.terms_changed_within_24h).toBe(false);

    // Absent because Analytics Engine is queried out of band — unobserved, and
    // therefore not scored, which is the correct default.
    expect(history.availability_30d).toBeNull();

    harness.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Analytics Engine
// ══════════════════════════════════════════════════════════════════════════

describe("Analytics Engine carries the telemetry half of the split", () => {
  it("writes one point per probe with the frozen column layout", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const endpoint = await seedEndpoint(harness, now.toISOString().slice(0, 19) + "Z");

    await probeEndpoint(harness.env, endpoint, { ...netFor(challenge("1000")), now: () => now });

    expect(harness.points).toHaveLength(1);
    const point = harness.points[0];

    expect(point?.blobs?.[0]).toBe("probe");
    expect(point?.blobs?.[1]).toBe(endpoint.id);
    expect(point?.blobs?.[2]).toBe(HOST);
    expect(point?.blobs?.[5]).toBe("crawler");
    expect(point?.indexes).toEqual([endpoint.id]);
    expect(point?.doubles?.[0]).toBe(1); // ok

    // The layout is frozen because AE columns are positional: reordering one is
    // a silent corruption of every row already written.
    expect(PROBE_POINT_LAYOUT.blob2).toBe("endpoint_id");
    expect(PROBE_POINT_LAYOUT.double2).toBe("latency_ms");

    harness.close();
  });

  it("builds an availability query that weights by the sample interval", () => {
    const sql = availabilityQuery("abc123", 30);
    // Counting rows rather than summing _sample_interval under-reports exactly
    // when an endpoint is busiest.
    expect(sql).toContain("sum(_sample_interval)");
    expect(sql).toContain("blob2 = 'abc123'");
    expect(sql).toContain("INTERVAL '30' DAY");
  });

  it("counts failures in availability and excludes them from latency", () => {
    //. A failed probe records a latency of 0, so leaving
    // those zeros in the quantile makes the median IMPROVE as an endpoint
    // breaks. Availability must count the failures; latency must not.
    const sql = availabilityQuery("abc123", 30);

    // Availability still counts every probe. Failures belong here — writing a
    // datapoint for one is the whole reason the failure path exists.
    expect(sql).toContain("sum(if(double1 > 0, _sample_interval, 0)) AS ok_samples");
    expect(sql).toContain("sum(_sample_interval) AS samples");

    // Both quantiles weight a failed probe at 0, dropping it from the
    // distribution. Verified equivalent to a `WHERE double1 > 0` control
    // against the live dataset: identical p50 over an identical sample count.
    for (const q of ["0.5", "0.95"]) {
      expect(sql).toContain(
        `quantileExactWeighted(${q})(double2, if(double1 > 0, _sample_interval, 0))`,
      );
    }
    // The unweighted spelling is the bug. It must not come back.
    expect(sql).not.toContain("(double2, _sample_interval)");
  });

  it("reports the latency denominator separately from the availability one", async () => {
    // After the fix the two figures are computed over different populations, so
    // a caller rendering "236 ms over 221 samples" would attach the wrong
    // denominator to a sampled figure.
    const { summary } = await availabilityFor(
      { accountId: "acct", token: "tok" },
      "abc123",
      30,
      (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: [{ samples: "221", ok_samples: "171", p50_ms: "236", p95_ms: "1141" }],
            }),
            { status: 200 },
          ),
        )),
    );

    expect(summary?.samples).toBe(221);
    expect(summary?.latency_samples).toBe(171);
    expect(summary?.availability).toBeCloseTo(171 / 221, 6);
    expect(summary?.p50_ms).toBe(236);
    expect(summary?.sampled).toBe(true);
  });

  it("reports a probe failure as an availability observation", () => {
    const point = pointFromProbe(
      {
        target: { url: URL_, canonical_url: URL_, endpoint_id: "e", origin: "o", host: HOST },
        probe: {
          observed_at: "2026-08-14T10:00:00Z",
          http_status: 200,
          latency_ms: 12,
          redirect_count: 0,
          tls: { ok: true, protocol: null },
          bytes_read: 4,
          served_from_cache: false,
          cache_age_seconds: null,
        },
        challenge: {
          wire_form: "none",
          x402_version: null,
          valid: false,
          decode_error: { code: "NOT_X402", message: "no challenge" },
          accepts: [],
          requirement_count: 0,
          raw_bytes: 4,
          hash: null,
          raw: null,
        },
        observed_terms: [],
        wire_forms_agree: null,
      },
      "crawler",
    );

    expect(point.ok).toBe(false);
    expect(point.errorCode).toBe("NOT_X402");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  The pipeline, end to end
// ══════════════════════════════════════════════════════════════════════════

describe("cron → queue → probe → diff → write", () => {
  it("enqueues due endpoints on a tick and probes them on the queue", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:15:00Z"); // a plain pump tick
    const nowIso = now.toISOString().slice(0, 19) + "Z";
    await seedEndpoint(harness, nowIso);

    // ── the cron half. Offline, because a single-endpoint corpus is below the
    // cold-start floor and this tick therefore also attempts a seed refresh —
    // which must not reach the real network from a test.
    const cycle = await runScheduled(
      harness.env,
      { cron: "*/15 * * * *" },
      { now: () => now, fetchImpl: () => Promise.reject(new Error("offline")) },
    );

    expect(cycle.considered).toBe(1);
    expect(cycle.enqueued).toBe(1);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({ kind: "probe", reason: "tier:corpus" });

    // The cycle is accounted for, because the accounting sums these rather than a log.
    // `budget` is recorded alongside the result so a later reader can tell
    // "we probed N" from "we were allowed N and wanted more".
    const recorded = await harness.env.DB.prepare(
      `SELECT kind, budget, considered, enqueued FROM crawl_cycles`,
    ).first<Record<string, unknown>>();
    expect(recorded).toMatchObject({ considered: 1, enqueued: 1 });
    expect(Number(recorded?.budget)).toBeGreaterThan(0);

    // ── the queue half, consuming exactly what the cron produced.
    const { batch, acked } = fakeBatch(harness.enqueued);
    const consumed = await runQueue(harness.env, batch, {
      ...netFor(challenge("1000")),
      now: () => now,
    });

    expect(consumed.probes_performed).toBe(1);
    expect(acked).toEqual([0]);

    // First sight, so exactly one first_seen row and a terms_current row.
    expect(await countChanges(harness, "first_seen")).toBe(1);
    const terms = await loadTerms(
      harness.env.DB,
      harness.enqueued[0]?.endpoint_id ?? "",
    );
    expect(terms?.amount_atomic).toBe("1000");

    harness.close();
  });

  it("seeds on the next tick when the corpus is cold, whatever the hour", async () => {
    const harness = createCrawlerEnv();
    // A plain pump tick — not 03:00, so `phasesFor` alone would not seed.
    const offPeak = new Date("2026-08-14T10:15:00Z");
    expect(phasesFor(offPeak).seedRefresh).toBe(false);

    const cycle = await runScheduled(
      harness.env,
      { cron: "*/15 * * * *" },
      {
        now: () => offPeak,
        fetchImpl: () => Promise.reject(new Error("offline")),
      },
    );

    // Promoted to a seed refresh because the corpus is empty. Without this a
    // database deployed just after 03:00 stays empty for 23 hours.
    expect(cycle.kind).toBe("seed_refresh");

    // The facilitator table is seeded even with every discovery fetch failing,
    // which is what makes the corpus reachable on the very next tick.
    const facilitators = await harness.env.DB.prepare(
      `SELECT count(*) AS n FROM facilitators`,
    ).first<{ n: number }>();
    expect(Number(facilitators?.n)).toBeGreaterThan(0);

    harness.close();
  });

  it("does NOT re-seed once the corpus is above the cold-start floor", async () => {
    const harness = createCrawlerEnv();
    const now = "2026-08-14T10:00:00Z";

    for (let i = 0; i < COLD_START_ENDPOINT_FLOOR; i += 1) {
      const url = `https://warm${i}.example/v1/api`;
      await upsertEndpoint(
        harness.env.DB,
        {
          id: await endpointId(url),
          canonical_url: url,
          url,
          origin: `https://warm${i}.example`,
          host: `warm${i}.example`,
          path: "/v1/api",
          title: null,
          description: null,
          resource_type: "http",
          discovery_source: "bazaar",
          tier: "corpus",
          next_probe_at: null,
        },
        now,
      );
    }

    const cycle = await runScheduled(
      harness.env,
      { cron: "*/15 * * * *" },
      {
        now: () => new Date("2026-08-14T10:15:00Z"),
        fetchImpl: () => Promise.reject(new Error("offline")),
      },
    );

    // A warm corpus goes back to the ordinary daily cadence, so the cold-start
    // path cannot quietly become a second daily refresh.
    expect(cycle.kind).toBe("tick");
    harness.close();
  });

  it("runs the seed refresh at 03:00 and halves the probe budget for that tick", async () => {
    const harness = createCrawlerEnv();
    const at3am = new Date("2026-08-14T03:00:00Z");

    const cycle = await runScheduled(
      harness.env,
      { cron: "*/15 * * * *" },
      {
        now: () => at3am,
        // No network: every discovery fetch fails, which is the honest way to
        // assert the phase RAN without reaching out to real facilitators.
        fetchImpl: () => Promise.reject(new Error("offline")),
      },
    );

    expect(cycle.kind).toBe("seed_refresh");
    expect(cycle.budget).toBe(20);

    // The facilitator table is seeded on every refresh, so a newly published
    // facilitator arrives without a deploy.
    const facilitators = await harness.env.DB.prepare(
      `SELECT count(*) AS n FROM facilitators`,
    ).first<{ n: number }>();
    expect(Number(facilitators?.n)).toBeGreaterThan(0);

    harness.close();
  });

  it("retries a queue message only when the politeness cache is holding it", async () => {
    const harness = createCrawlerEnv();
    const now = new Date("2026-08-14T10:00:00Z");
    const nowIso = now.toISOString().slice(0, 19) + "Z";
    const endpoint = await seedEndpoint(harness, nowIso);

    // A leader takes the politeness lease and never settles it, so the queued
    // follower is refused rather than served.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leader = withPoliteness(harness.env, { endpointId: endpoint.id }, async () => {
      await held;
      return "leader";
    });

    const message: CrawlMessage = {
      kind: "probe",
      endpoint_id: endpoint.id,
      url: endpoint.canonical_url,
      enqueued_at: nowIso,
    };
    const { batch, acked, retried } = fakeBatch([message]);

    await runQueue(harness.env, batch, { ...netFor(challenge("1000")), now: () => now });

    // Retried, not acked and not dead-lettered: coming back later genuinely
    // differs, which is not true of a robots disallow or an opt-out.
    expect(retried).toEqual([0]);
    expect(acked).toEqual([]);

    release?.();
    await leader;
    harness.close();
  });
});
