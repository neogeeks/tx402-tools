/**
 * 402 Compare, tested by running it.
 *
 * The centre of gravity is the second block: **an endpoint we have not looked
 * at must never render as a zero, a blank or a dash.** makes that
 * the design, and it is the one property of this tool that is a claim about
 * somebody else's business rather than about us — a price column showing "0"
 * for an endpoint nobody has probed says it is free, and it is not.
 *
 * Everything here runs against real SQLite with the real migrations
 * (`test/d1-sqlite.ts`,. decision 3), the corpus is built through
 * its own `ingestResources` so that dedupe and canonicalization are the real
 * ones, and the terms are written through its `writeTermsStatement`. The only
 * hand-written rows are the opt-outs, and those go through its `recordOptOut`.
 *
 * Nothing here reaches the network. The live Bazaar responses in
 * `test/fixtures/bazaar-discovery.json` are the real shapes, captured once.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleRequest } from "../worker/router.js";
import { endpointId } from "../worker/lib/guard.js";
import { score } from "../worker/lib/score.js";
import type { Signal } from "../worker/lib/signals.js";
import { parseDiscovery } from "../worker/crawler/bazaar.js";
import { ingestResources } from "../worker/crawler/ingest.js";
import { recordOptOut } from "../worker/crawler/optout.js";
import { newId, writeTermsStatement, scheduleNext } from "../worker/crawler/store.js";
import type { TermsSnapshot } from "../worker/crawler/diff.js";
import type { DiscoveredResource } from "../worker/crawler/types.js";
import {
  assignFromBazaarTags,
  seedCategories,
} from "../worker/routes/compare.js";
import { CATEGORIES, categoriesForTags } from "../ui/pages/compare/catalogue.js";
import { createCrawlerEnv, type CrawlerTestEnv } from "./crawler-env.js";
import { mockCtx, request, validateAgainst } from "./helpers.js";
import type { Env } from "../worker/types.js";

const here = dirname(fileURLToPath(import.meta.url));

interface DiscoveryFixture {
  cdp: unknown;
  solvador: unknown;
}

const FIXTURE = JSON.parse(
  readFileSync(join(here, "fixtures", "bazaar-discovery.json"), "utf8"),
) as DiscoveryFixture;

// ── seeding ──────────────────────────────────────────────────────────────

const LONG_AGO = "2026-02-16T09:00:00Z"; // 180 days before NOW
const RECENT = "2026-08-12T09:00:00Z"; // 3 days before NOW
const NOW = "2026-08-15T09:00:00Z";
/** In the real past, whatever day the suite runs on. See `seedCorpus`. */
const OPT_OUT_AT = "2026-01-02T00:00:00Z";

function signalsFor(kind: "healthy-v2" | "healthy-v1"): Signal[] {
  const v2 = kind === "healthy-v2";
  const observed = (id: string, value: Signal["value"]): Signal => ({
    id,
    value,
    observed: true,
    detail: null,
  });
  return [
    observed("probe_ok", true),
    observed("challenge_served", true),
    observed("challenge_decodes", v2),
    observed("wire_form", v2 ? "v2-header" : "v1-body"),
    observed("x402_version", v2 ? 2 : 1),
    observed("tls_ok", true),
    observed("tls_protocol", "TLSv1.3"),
    observed("redirect_count", 0),
    observed("redirect_scheme_downgrade", false),
    observed("resource_origin_match", true),
    observed("network_recognized", true),
    observed("asset_recognized", true),
    observed("facilitator_known", true),
    observed("amount_canonical", true),
    observed("amount_magnitude_band", "micro"),
    observed("pay_to_wellformed", true),
    observed("timeout_sane", true),
    observed("scheme_known", true),
    observed("requirement_count", 1),
    observed("challenge_size_bytes", 512),
  ];
}

const BASE_TERMS: TermsSnapshot = {
  x402_version: 2,
  wire_form: "v2-header",
  scheme: "exact",
  network: "eip155:8453",
  asset_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  asset_symbol: "USDC",
  asset_decimals: 6,
  amount_atomic: "3000",
  amount_decimal: "0.003",
  pay_to: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
  pay_to_dynamic: false,
  max_timeout_seconds: 60,
  facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
  resource: null,
  mime_type: "application/json",
  description: null,
  requirement_count: 1,
  extra_json: null,
  challenge_hash: null,
  challenge_json: null,
  score: null,
  band: null,
  score_version: "v1",
  signals_json: null,
  observed_at: NOW,
};

/**
 * Write observed terms the way the crawler writes them.
 *
 * `score` is the real scorer, so the stored number and the stored signals are
 * consistent — which is what lets `riskFor` derive `reasons` and verify them
 * against the number rather than inventing a rationale.
 */
async function writeTerms(
  db: D1Database,
  id: string,
  overrides: Partial<TermsSnapshot>,
  kind: "healthy-v2" | "healthy-v1" = "healthy-v2",
): Promise<void> {
  const signals = signalsFor(kind);
  const risk = score(signals);
  const snapshot: TermsSnapshot = {
    ...BASE_TERMS,
    score: risk?.score ?? null,
    band: risk?.band ?? null,
    score_version: "v1",
    signals_json: JSON.stringify(signals),
    ...overrides,
  };
  await writeTermsStatement(db, id, snapshot, newId(), snapshot.observed_at).run();
}

/** Bump `scan_count` the way a completed probe does. */
async function recordProbes(db: D1Database, id: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await scheduleNext(db, id, NOW, NOW, { ok: true });
  }
}

function resource(
  url: string,
  overrides: Partial<DiscoveredResource> = {},
): DiscoveredResource {
  const base: DiscoveredResource = {
    url,
    type: "http",
    serviceName: null,
    description: null,
    mimeType: null,
    tags: [],
    iconUrl: null,
    claimedLastUpdated: null,
    accepts: [],
    raw: { resource: url, ...overrides.raw as object },
  };
  return { ...base, ...overrides };
}

interface Corpus {
  test: CrawlerTestEnv;
  env: Env;
  db: D1Database;
  ids: Record<string, string>;
  close(): void;
}

/**
 * A corpus with every state Compare has to render side by side:
 * an old, well-probed endpoint; a brand-new one; one nobody has probed; one
 * that answered without an x402 challenge; one scored under a different
 * methodology version; one serving x402 v1; and one whose operator opted out.
 */
async function seedCorpus(): Promise<Corpus> {
  const test = createCrawlerEnv();
  const db = test.env.DB;

  const cdp = parseDiscovery(FIXTURE.cdp).items;
  const solvador = parseDiscovery(FIXTURE.solvador).items;

  const veteran = "https://veteran.example/api/price";
  const newcomer = "https://newcomer.example/api/price";
  const unprobed = "https://unprobed.example/api/geocode";
  const notX402 = "https://plain.example/api/thing";
  const oldVersion = "https://oldscore.example/api/data";
  const legacyV1 = "https://legacy.example/api/v1data";
  const optedOut = "https://quiet.example/api/data";

  // Real Bazaar listings, through its own ingestion — dedupe and
  // canonicalization are the guard's and nothing else's.
  await ingestResources(
    { DB: db },
    cdp,
    { source: "bazaar", sourceUrl: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources", facilitatorId: "coinbase-cdp", tier: "corpus" },
    LONG_AGO,
  );
  await ingestResources(
    { DB: db },
    solvador,
    { source: "bazaar", sourceUrl: "https://api.solvador.com/discovery/resources", facilitatorId: "solvador", tier: "corpus" },
    LONG_AGO,
  );

  // The long-watched endpoint, with the tags a market-data listing carries.
  await ingestResources(
    { DB: db },
    [
      resource(veteran, {
        serviceName: "Veteran Price Feed",
        tags: ["crypto", "market-data", "price"],
        claimedLastUpdated: "2025-01-01T00:00:00Z",
        raw: {
          resource: veteran,
          serviceName: "Veteran Price Feed",
          tags: ["crypto", "market-data", "price"],
          quality: {
            l30DaysTotalCalls: 819,
            l30DaysUniquePayers: 815,
            lastCalledAt: "2026-08-14T23:14:48.799Z",
          },
          accepts: [
            {
              amount: "9000",
              network: "eip155:8453",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              scheme: "exact",
              payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
            },
          ],
        },
      }),
      resource(oldVersion, { serviceName: "Older Methodology", tags: ["market-data"] }),
      resource(optedOut, { serviceName: "Quiet Co", tags: ["market-data"] }),
      resource(notX402, { serviceName: "Plain HTTP", tags: ["market-data"] }),
      resource(legacyV1, { serviceName: "Legacy v1 Feed", tags: ["market-data"] }),
    ],
    { source: "bazaar", sourceUrl: "https://example.test/discovery", facilitatorId: "coinbase-cdp", tier: "corpus" },
    LONG_AGO,
  );

  // Discovered three days ago, and a geocoding listing nobody has probed.
  await ingestResources(
    { DB: db },
    [
      resource(newcomer, { serviceName: "Newcomer Feed", tags: ["market-data"] }),
      resource(unprobed, {
        serviceName: "Unprobed Geocoder",
        tags: ["geocoding", "maps"],
        raw: { resource: unprobed, serviceName: "Unprobed Geocoder", tags: ["geocoding", "maps"] },
      }),
    ],
    { source: "bazaar", sourceUrl: "https://example.test/discovery", facilitatorId: "solvador", tier: "corpus" },
    RECENT,
  );

  const ids: Record<string, string> = {
    veteran: await endpointId(veteran),
    newcomer: await endpointId(newcomer),
    unprobed: await endpointId(unprobed),
    notX402: await endpointId(notX402),
    oldVersion: await endpointId(oldVersion),
    legacyV1: await endpointId(legacyV1),
    optedOut: await endpointId(optedOut),
  };

  // Observed terms. The veteran advertises 9000 and serves 5000 — a real
  // disagreement between a facilitator's listing and the challenge.
  await writeTerms(db, ids.veteran as string, { amount_atomic: "5000", amount_decimal: "0.005" });
  await recordProbes(db, ids.veteran as string, 180);

  await writeTerms(db, ids.newcomer as string, {
    amount_atomic: "1000",
    amount_decimal: "0.001",
  });
  await recordProbes(db, ids.newcomer as string, 3);

  // Scored under a methodology version that is not the one in force.
  await writeTerms(db, ids.oldVersion as string, {
    amount_atomic: "2000",
    amount_decimal: "0.002",
    score: 91,
    band: "LOW",
    score_version: "v2",
  });
  await recordProbes(db, ids.oldVersion as string, 20);

  // A healthy x402 v1 endpoint. `decodePaymentRequired` is v2-only, so it
  // fails `challenge_decodes` and scores lower.
  await writeTerms(
    db,
    ids.legacyV1 as string,
    { amount_atomic: "1500", amount_decimal: "0.0015", x402_version: 1, wire_form: "v1-body" },
    "healthy-v1",
  );
  await recordProbes(db, ids.legacyV1 as string, 20);

  // Probed, answered, served no challenge.
  await recordProbes(db, ids.notX402 as string, 4);
  await db
    .prepare(`UPDATE endpoints SET status = 'not_x402' WHERE id = ?`)
    .bind(ids.notX402)
    .run();

  await writeTerms(db, ids.optedOut as string, { amount_atomic: "100", amount_decimal: "0.0001" });
  await recordProbes(db, ids.optedOut as string, 12);
  // Effective well in the past, because the read-time predicate compares
  // `effective_at` against the request's own clock. An opt-out dated in the
  // future is correctly NOT yet in force, and a test that dated one that way
  // would be asserting the wrong thing.
  await recordOptOut(db, {
    id: newId(),
    scope: "origin",
    target: "https://quiet.example",
    method: "well-known",
    evidence: "(empty file)",
    requested_at: OPT_OUT_AT,
    effective_at: OPT_OUT_AT,
  });

  await seedCategories(db, NOW);
  await assignFromBazaarTags(db, NOW, { force: true });

  return { test, env: test.env, db, ids, close: () => test.close() };
}

async function get(
  corpus: Corpus,
  path: string,
  accept = "application/json",
): Promise<Response> {
  return handleRequest(request(path, { headers: { accept } }), corpus.env, mockCtx());
}

interface CompareBody {
  meta: { implemented: boolean };
  warnings: { code: string }[];
  data: {
    category: { slug: string; title: string } | null;
    rows: {
      endpoint_id: string | null;
      url: string;
      title: string | null;
      terms: { amount_atomic: string | null; network: string | null } | null;
      availability_30d: number | null;
      latency_p50_ms: number | null;
      risk: { score: number; band: string; score_version: string; reasons: unknown[] } | null;
      insufficient_data: boolean;
      last_seen: string | null;
    }[];
    notes: string[];
  };
}

function urlsQuery(...urls: string[]): string {
  return `urls=${urls.map((u) => encodeURIComponent(u)).join(",")}`;
}

// ── N endpoints side by side ─────────────────────────────────────────────

describe("N endpoints compare against real corpus rows", () => {
  it("returns one row per URL, in the order given, with the observed terms", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://newcomer.example/api/price",
          "https://unprobed.example/api/geocode",
        )}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json<CompareBody>();
      expect(body.data.rows.map((r) => r.url)).toEqual([
        "https://veteran.example/api/price",
        "https://newcomer.example/api/price",
        "https://unprobed.example/api/geocode",
      ]);

      expect(body.data.rows[0]?.terms?.amount_atomic).toBe("5000");
      expect(body.data.rows[1]?.terms?.amount_atomic).toBe("1000");
      expect(body.data.rows[0]?.terms?.network).toBe("eip155:8453");
      expect(body.data.rows[0]?.risk?.score_version).toBe("v1");
      // The reasons are derived from the stored signals only because the
      // recomputed score reproduces the stored one exactly.
      expect((body.data.rows[0]?.risk?.reasons ?? []).length).toBeGreaterThan(0);
    } finally {
      corpus.close();
    }
  });

  it("validates against spec/schemas/compare.json", async () => {
    const corpus = await seedCorpus();
    try {
      for (const path of [
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://unprobed.example/api/geocode",
        )}`,
        "/api/v1/compare?category=market-data",
        "/api/v1/compare?category=geocoding",
        "/api/v1/compare",
      ]) {
        const res = await get(corpus, path);
        const body = await res.json();
        const { ok, errors } = validateAgainst("compare", body);
        expect(ok, `${path}: ${errors}`).toBe(true);
      }
    } finally {
      corpus.close();
    }
  });

  it("caps the number of endpoints compared at once", async () => {
    const corpus = await seedCorpus();
    try {
      const many = Array.from({ length: 20 }, (_, i) => `https://a${i}.example/api`);
      const res = await get(corpus, `/api/v1/compare?${urlsQuery(...many)}`);
      const body = await res.json<CompareBody>();
      expect(body.data.rows.length).toBeLessThanOrEqual(8);
    } finally {
      corpus.close();
    }
  });
});

// ── "insufficient data" is a value, not a gap ────────────────────────────

describe("an endpoint with no observed terms renders as insufficient data", () => {
  it("marks it in JSON with a null price, never a zero", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery("https://unprobed.example/api/geocode")}`,
      );
      const body = await res.json<CompareBody>();
      const row = body.data.rows[0];

      expect(row?.insufficient_data).toBe(true);
      expect(row?.terms).toBeNull();
      expect(row?.risk).toBeNull();
      expect(row?.availability_30d).toBeNull();
      expect(row?.latency_p50_ms).toBeNull();
      expect(row?.last_seen).toBeNull();
      // The failure this test exists for: a zero anywhere in the row.
      expect(JSON.stringify(row)).not.toContain(":0");
      expect(body.warnings.some((w) => w.code === "INSUFFICIENT_DATA")).toBe(true);
    } finally {
      corpus.close();
    }
  });

  it("says WHY it is empty, differently for each reason, on the page", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/compare?${urlsQuery(
          "https://unprobed.example/api/geocode",
          "https://plain.example/api/thing",
          "https://never.example/api/seen",
        )}`,
        "text/html",
      );
      const page = await res.text();

      expect(page).toContain("not probed yet");
      expect(page).toContain("no x402 challenge served");
      expect(page).toContain("not in our index yet");
      expect(page).toContain("unobserved");
      // Availability is empty for a different reason: this page does not ask
      // for it, which is a fact about the page and not about the endpoint.
      expect(page).toContain("not compared here");
      expect(page).toContain("/history?url=");
    } finally {
      corpus.close();
    }
  });

  it("says why in the markdown mirror too", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://unprobed.example/api/geocode",
        )}`,
        "text/markdown",
      );
      const report = await res.text();

      expect(report).toContain("— not probed yet");
      expect(report).not.toMatch(/\|\s*0\s*\|/);
      expect(report).toContain("no observed terms yet");
    } finally {
      corpus.close();
    }
  });

  it("renders an empty category as a designed state, not an error", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/compare/weather", "text/html");
      expect(res.status).toBe(200);
      const page = await res.text();
      expect(page).toContain("No endpoints in this category yet");
      expect(page).toContain("not a claim that none exists");
    } finally {
      corpus.close();
    }
  });
});

// ── score_version and price scales ───────────────────────────────────────

describe("rows are not ranked across incomparable scales", () => {
  it("refuses to rank rows scored under different methodology versions, and says so", async () => {
    const corpus = await seedCorpus();
    try {
      const query = urlsQuery(
        "https://veteran.example/api/price",
        "https://oldscore.example/api/data",
      );
      const res = await get(corpus, `/api/v1/compare?${query}&sort=score`);
      const body = await res.json<CompareBody>();

      // The order is the one given, not a ranking.
      expect(body.data.rows.map((r) => r.url)).toEqual([
        "https://veteran.example/api/price",
        "https://oldscore.example/api/data",
      ]);
      expect(body.data.notes.join(" ")).toContain("different methodology versions");
      expect(body.data.notes.join(" ")).toContain("v1");
      expect(body.data.notes.join(" ")).toContain("v2");

      // And each row still carries its own version, unrecomputed.
      expect(body.data.rows[0]?.risk?.score_version).toBe("v1");
      expect(body.data.rows[1]?.risk?.score_version).toBe("v2");
      expect(body.data.rows[1]?.risk?.score).toBe(91);
      // A historical score is never re-derived, so it has no reasons attached.
      expect(body.data.rows[1]?.risk?.reasons).toEqual([]);
    } finally {
      corpus.close();
    }
  });

  it("refuses to rank prices denominated in different assets", async () => {
    const corpus = await seedCorpus();
    try {
      await writeTerms(corpus.db, corpus.ids.newcomer as string, {
        amount_atomic: "1000",
        amount_decimal: "0.001",
        asset_symbol: "DAI",
        asset_address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        asset_decimals: 18,
      });

      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://newcomer.example/api/price",
        )}&sort=price`,
      );
      const body = await res.json<CompareBody>();

      expect(body.data.notes.join(" ")).toContain("not one scale");
      expect(body.data.rows.map((r) => r.url)).toEqual([
        "https://veteran.example/api/price",
        "https://newcomer.example/api/price",
      ]);
    } finally {
      corpus.close();
    }
  });

  it("does rank by price when the rows share one scale", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://newcomer.example/api/price",
        )}&sort=price`,
      );
      const body = await res.json<CompareBody>();

      expect(body.data.rows.map((r) => r.terms?.amount_atomic)).toEqual(["1000", "5000"]);
      expect(body.data.notes.join(" ")).not.toContain("not one scale");
    } finally {
      corpus.close();
    }
  });

  it("puts unmeasured rows last rather than treating them as cheapest", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://unprobed.example/api/geocode",
          "https://newcomer.example/api/price",
        )}&sort=price`,
      );
      const body = await res.json<CompareBody>();
      expect(body.data.rows[0]?.url).toBe("https://newcomer.example/api/price");
      expect(body.data.rows[1]?.insufficient_data).toBe(true);
    } finally {
      corpus.close();
    }
  });
});

// ── unequal observation windows ──────────────────────────────────────────

describe("unequal observation windows are called out", () => {
  it("names both windows when one is much longer than the other", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://newcomer.example/api/price",
        )}`,
      );
      const body = await res.json<CompareBody>();
      const notes = body.data.notes.join(" ");

      expect(notes).toContain("not been watched for the same length of time");
      expect(notes).toContain("180 probes");
      expect(notes).toContain("3 probes");
      expect(notes).toContain("not the same measurement");
    } finally {
      corpus.close();
    }
  });

  it("shows each endpoint's window on the page", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://newcomer.example/api/price",
        )}`,
        "text/html",
      );
      const page = await res.text();
      expect(page).toContain("Watched for");
      expect(page).toContain("180 probes");
      expect(page).toContain("First seen by us");
      expect(page).toContain("Never a date a facilitator claimed");
    } finally {
      corpus.close();
    }
  });
});

// ── the v1 penalty is a claim about tx402 ────────────────────────────────

describe("a v1 endpoint's lower score is explained, not implied", () => {
  it("scores lower AND says the reason is the decoder", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://legacy.example/api/v1data",
        )}`,
      );
      const body = await res.json<CompareBody>();

      const v2Score = body.data.rows[0]?.risk?.score ?? 0;
      const v1Score = body.data.rows[1]?.risk?.score ?? 0;
      expect(v1Score).toBeLessThan(v2Score);

      const notes = body.data.notes.join(" ");
      expect(notes).toContain("x402 v1 challenge");
      expect(notes).toContain("v2-only");
      expect(notes).toContain("not about the endpoint");
    } finally {
      corpus.close();
    }
  });

  it("marks the cell on the page so a sorted column cannot imply a verdict", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://legacy.example/api/v1data",
        )}&sort=score`,
        "text/html",
      );
      const page = await res.text();
      expect(page).toContain("v2-only decoder cannot read");
    } finally {
      corpus.close();
    }
  });
});

// ── opt-out, honoured at read time ───────────────────────────────────────

describe("an opted-out endpoint is absent from every listing", () => {
  it("is absent from /api/v1/endpoints", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/endpoints?limit=200");
      const body = await res.json<{
        data: { endpoints: { url: string }[]; total: number };
      }>();
      expect(body.data.endpoints.some((e) => e.url.includes("quiet.example"))).toBe(false);
      expect(JSON.stringify(body)).not.toContain("quiet.example");
    } finally {
      corpus.close();
    }
  });

  it("is absent from a comparison that names it explicitly", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery(
          "https://veteran.example/api/price",
          "https://quiet.example/api/data",
        )}`,
      );
      const body = await res.json<CompareBody>();

      const optedOutRow = body.data.rows.find((r) => r.url.includes("quiet.example"));
      expect(optedOutRow?.endpoint_id).toBeNull();
      expect(optedOutRow?.terms).toBeNull();
      expect(optedOutRow?.risk).toBeNull();
      expect(optedOutRow?.title).toBeNull();
      expect(body.data.notes.join(" ")).toContain("opted out");
    } finally {
      corpus.close();
    }
  });

  it("is absent from its category page", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/compare?category=market-data");
      const body = await res.json<CompareBody>();
      expect(body.data.rows.some((r) => r.url.includes("quiet.example"))).toBe(false);
    } finally {
      corpus.close();
    }
  });

  it("excludes an endpoint discovered AFTER an origin-scoped opt-out", async () => {
    const corpus = await seedCorpus();
    try {
      // `recordOptOut` flipped `status` for the endpoints that existed then.
      // This one is ingested afterwards and is `active` — the read-time
      // predicate is the only thing that keeps it off a public listing.
      await ingestResources(
        { DB: corpus.db },
        [resource("https://quiet.example/api/another", { tags: ["market-data"] })],
        { source: "bazaar", sourceUrl: "https://example.test/discovery", facilitatorId: "solvador", tier: "corpus" },
        NOW,
      );

      const later = await corpus.db
        .prepare(`SELECT status FROM endpoints WHERE canonical_url = ?`)
        .bind("https://quiet.example/api/another")
        .first<{ status: string }>();
      expect(later?.status).toBe("active");

      const res = await get(corpus, "/api/v1/endpoints?limit=200");
      const body = await res.text();
      expect(body).not.toContain("quiet.example");
    } finally {
      corpus.close();
    }
  });
});

// ── curated categories, built from real Bazaar tags ──────────────────────

describe("category pages are built from real Bazaar tags", () => {
  it("assigns the real Solvador listing by its own tags", async () => {
    // The fixture's tags are verbatim from a live facilitator.
    const solvador = parseDiscovery(FIXTURE.solvador).items;
    expect(solvador[0]?.tags).toContain("agents");
    expect(categoriesForTags(solvador[0]?.tags ?? [], solvador[0]?.serviceName ?? null)).toContain(
      "ai-inference",
    );
  });

  it("lists exactly the endpoints whose listing carries a category's tags", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/compare?category=geocoding");
      const body = await res.json<CompareBody>();

      expect(body.data.category?.slug).toBe("geocoding");
      expect(body.data.rows.map((r) => r.url)).toEqual([
        "https://unprobed.example/api/geocode",
      ]);
    } finally {
      corpus.close();
    }
  });

  it("records the assignment as bazaar-tag, leaving curator rows distinguishable", async () => {
    const corpus = await seedCorpus();
    try {
      const rows = await corpus.db
        .prepare(
          `SELECT assigned_by, count(*) AS n FROM endpoint_categories GROUP BY assigned_by`,
        )
        .all<{ assigned_by: string; n: number }>();
      expect(rows.results?.map((r) => r.assigned_by)).toEqual(["bazaar-tag"]);

      // A curator row survives a re-sweep, which is what makes the published
      // set a human decision rather than a tag match.
      await corpus.db
        .prepare(
          `INSERT INTO endpoint_categories (endpoint_id, category_slug, assigned_by, created_at)
           VALUES (?, 'weather', 'curator', ?)`,
        )
        .bind(corpus.ids.veteran, NOW)
        .run();
      await assignFromBazaarTags(corpus.db, NOW, { force: true });

      const curator = await corpus.db
        .prepare(
          `SELECT assigned_by FROM endpoint_categories WHERE category_slug = 'weather'`,
        )
        .first<{ assigned_by: string }>();
      expect(curator?.assigned_by).toBe("curator");

      const res = await get(corpus, "/api/v1/compare?category=weather");
      const body = await res.json<CompareBody>();
      expect(body.data.rows.map((r) => r.url)).toEqual(["https://veteran.example/api/price"]);
    } finally {
      corpus.close();
    }
  });

  it("skips the sweep once every listing has been considered", async () => {
    const corpus = await seedCorpus();
    try {
      const again = await assignFromBazaarTags(corpus.db, NOW);
      expect(again.skipped).toBe(true);
    } finally {
      corpus.close();
    }
  });

  it("publishes the catalogue with an owner and a definition for every category", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/categories");
      const body = await res.json<{
        data: {
          categories: {
            slug: string;
            definition: string | null;
            curated_by: string | null;
            published: boolean;
            endpoint_count: number;
            tags: string[];
          }[];
        };
      }>();

      expect(body.data.categories.length).toBe(CATEGORIES.length);
      for (const category of body.data.categories) {
        expect(category.definition, category.slug).toBeTruthy();
        expect(category.curated_by, category.slug).toBeTruthy();
        expect(category.tags.length, category.slug).toBeGreaterThan(0);
      }

      const marketData = body.data.categories.find((c) => c.slug === "market-data");
      expect(marketData?.endpoint_count).toBeGreaterThan(0);

      const stored = await corpus.db
        .prepare(`SELECT count(*) AS n FROM categories WHERE published = 1`)
        .first<{ n: number }>();
      expect(Number(stored?.n)).toBe(CATEGORIES.filter((c) => c.published).length);
    } finally {
      corpus.close();
    }
  });

  it("404s a category nobody curates, rather than inventing one", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/compare?category=made-up");
      expect(res.status).toBe(404);
      const { ok, errors } = validateAgainst("error", await res.json());
      expect(ok, errors).toBe(true);
    } finally {
      corpus.close();
    }
  });
});

// ── the facilitator's claims stay the facilitator's ──────────────────────

describe("facilitator claims are attributed, never presented as our observation", () => {
  it("shows the usage figures with whose they are", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/compare?${urlsQuery("https://veteran.example/api/price")}`,
        "text/html",
      );
      const page = await res.text();

      expect(page).toContain("819 calls in 30 days from 815 unique payers");
      expect(page).toContain("Their measurement, not ours");
    } finally {
      corpus.close();
    }
  });

  it("attributes them in the JSON notes rather than blending them into a column", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery("https://veteran.example/api/price")}`,
      );
      const body = await res.json<CompareBody>();
      expect(body.data.notes.join(" ")).toContain("published by the facilitator");
      // The frozen row has no column for somebody else's bookkeeping, and this
      // is where the temptation to add one would show up.
      expect(JSON.stringify(body.data.rows)).not.toContain("819");
    } finally {
      corpus.close();
    }
  });

  it("reports a disagreement between the advertised and the observed price", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        `/api/v1/compare?${urlsQuery("https://veteran.example/api/price")}`,
      );
      const body = await res.json<CompareBody>();
      const notes = body.data.notes.join(" ");
      expect(notes).toContain("disagree about the price");
      expect(notes).toContain("9000");
      expect(notes).toContain("5000");
      expect(notes).toContain("what the endpoint actually asked us for");
    } finally {
      corpus.close();
    }
  });

  it("carries the long form on /api/v1/endpoints, which has no frozen row", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/endpoints?limit=200");
      const body = await res.json<{
        data: {
          endpoints: {
            url: string;
            first_seen: string;
            scan_count: number;
            score_version: string | null;
            facilitator_quality: { calls_30d: number | null } | null;
            categories: string[];
          }[];
        };
      }>();
      const veteran = body.data.endpoints.find((e) => e.url.includes("veteran.example"));
      expect(veteran?.first_seen).toBe(LONG_AGO);
      expect(veteran?.scan_count).toBe(180);
      expect(veteran?.score_version).toBe("v1");
      expect(veteran?.facilitator_quality?.calls_30d).toBe(819);
      expect(veteran?.categories).toContain("market-data");
    } finally {
      corpus.close();
    }
  });
});

// ── content negotiation ──────────────────────────────────────────────────

describe("all three representations of the same result", () => {
  it("serves json, markdown and html for a category page", async () => {
    const corpus = await seedCorpus();
    try {
      const json = await get(corpus, "/compare/market-data", "application/json");
      expect(json.headers.get("content-type")).toContain("application/json");
      expect(json.headers.get("vary")).toBe("Accept");

      const md = await get(corpus, "/compare/market-data", "text/markdown");
      expect(md.headers.get("content-type")).toContain("text/markdown");
      expect(await md.text()).toContain("Compare x402 crypto market data APIs");

      const html = await get(corpus, "/compare/market-data", "text/html");
      expect(html.headers.get("content-type")).toContain("text/html");
      const page = await html.text();
      expect(page).toContain("<h1>Compare x402 crypto market data APIs</h1>");
      expect(page).toContain("These are observations, not accusations");
    } finally {
      corpus.close();
    }
  });

  it("serves the .md path form", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/compare.md", "text/html");
      expect(res.headers.get("content-type")).toContain("text/markdown");
    } finally {
      corpus.close();
    }
  });

  it("leads the category page title with the category term, not the brand", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/compare/geocoding", "text/html");
      const page = await res.text();
      const title = /<title>([^<]*)<\/title>/u.exec(page)?.[1] ?? "";
      expect(title.startsWith("Cheapest x402 geocoding API")).toBe(true);
      expect(title.indexOf("tx402")).toBeGreaterThan(0);
      expect(page).toContain('rel="canonical" href="https://tools.tx402.io/compare/geocoding"');
    } finally {
      corpus.close();
    }
  });
});

// ── language ──────────────────────────────────────────────

describe("nothing on these pages is a statement about an operator", () => {
  const FORBIDDEN = ["scam", "fraud", "fraudulent", "unsafe", "dangerous", "malicious"];

  it("never uses a forbidden word in any representation", async () => {
    const corpus = await seedCorpus();
    try {
      for (const [path, accept] of [
        [`/compare?${urlsQuery("https://veteran.example/api/price", "https://legacy.example/api/v1data", "https://unprobed.example/api/geocode")}`, "text/html"],
        [`/compare?${urlsQuery("https://veteran.example/api/price", "https://legacy.example/api/v1data")}`, "text/markdown"],
        ["/compare/market-data", "text/html"],
        ["/api/v1/compare?category=market-data", "application/json"],
        ["/api/v1/categories", "application/json"],
        ["/api/v1/endpoints", "application/json"],
      ] as const) {
        const text = (await (await get(corpus, path, accept)).text()).toLowerCase();
        for (const word of FORBIDDEN) {
          expect(text.includes(word), `${path} contains "${word}"`).toBe(false);
        }
      }
    } finally {
      corpus.close();
    }
  });

  it("carries the observation note above the fold on every page that shows a band", async () => {
    const corpus = await seedCorpus();
    try {
      const page = await (
        await get(corpus, `/compare?${urlsQuery("https://veteran.example/api/price")}`, "text/html")
      ).text();
      const noteAt = page.indexOf("These are observations, not accusations");
      const bandAt = page.indexOf("LOW");
      expect(noteAt).toBeGreaterThan(-1);
      expect(noteAt).toBeLessThan(bandAt);
    } finally {
      corpus.close();
    }
  });
});

// ── pagination ───────────────────────────────────────────────────────────

describe("the corpus listing pages by keyset", () => {
  it("returns a cursor and does not repeat a row across pages", async () => {
    const corpus = await seedCorpus();
    try {
      const first = await (await get(corpus, "/api/v1/endpoints?limit=3")).json<{
        data: { endpoints: { endpoint_id: string }[]; cursor: string | null; total: number };
      }>();
      expect(first.data.endpoints.length).toBe(3);
      expect(first.data.cursor).toBe(first.data.endpoints[2]?.endpoint_id);
      expect(first.data.total).toBeGreaterThan(3);

      const second = await (
        await get(corpus, `/api/v1/endpoints?limit=3&cursor=${first.data.cursor}`)
      ).json<{ data: { endpoints: { endpoint_id: string }[] } }>();

      const firstIds = new Set(first.data.endpoints.map((e) => e.endpoint_id));
      for (const row of second.data.endpoints) {
        expect(firstIds.has(row.endpoint_id)).toBe(false);
      }
    } finally {
      corpus.close();
    }
  });

  it("filters to a category and to endpoints with observed terms", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/endpoints?category=market-data&has_terms=true");
      const body = await res.json<{
        data: { endpoints: { url: string; insufficient_data: boolean }[] };
      }>();
      expect(body.data.endpoints.length).toBeGreaterThan(0);
      for (const row of body.data.endpoints) expect(row.insufficient_data).toBe(false);
    } finally {
      corpus.close();
    }
  });
});

// ── the guard still applies to `?urls=` ──────────────────────────────────

describe("Compare reads the corpus and never fetches", () => {
  it("refuses a URL the guard would not fetch, rather than comparing it", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(corpus, "/api/v1/compare?urls=http://127.0.0.1/admin");
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      corpus.close();
    }
  });

  it("keeps the valid URLs when only some are refused", async () => {
    const corpus = await seedCorpus();
    try {
      const res = await get(
        corpus,
        "/api/v1/compare?urls=https://veteran.example/api/price,http://127.0.0.1/admin",
      );
      const body = await res.json<CompareBody>();
      expect(body.data.rows.map((r) => r.url)).toEqual(["https://veteran.example/api/price"]);
      expect(body.data.notes.join(" ")).toContain("could not be compared");
    } finally {
      corpus.close();
    }
  });
});
