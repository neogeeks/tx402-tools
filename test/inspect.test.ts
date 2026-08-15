/**
 * The Inspector —.
 *
 * The suite is organised around the four result states SPEC §3.1 freezes,
 * because getting any of them wrong is a product failure rather than a bug: a
 * malformed challenge must be a report, a URL that is not an x402 endpoint must
 * not be scored, an empty corpus must look deliberate, and a guard refusal must
 * be indistinguishable from every other guard refusal.
 *
 * Everything runs the real handler through the real router, against its
 * `test/net-stubs.ts` resolver and connector ports and the
 * real `ProbeLimiter`. Every JSON response is validated against
 * `spec/schemas/inspect.json` — a TypeScript type on a parsed response proves
 * nothing about the wire format.
 */

import { afterEach, describe, expect, it } from "vitest";

import { handleRequest } from "../worker/router.js";
import { setProbeTransportForTests } from "../worker/routes/inspect.js";
import type { Connector } from "../worker/lib/guard.js";
import type { Env } from "../worker/types.js";

import { json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import { fakeD1, fakeLimiterNamespace, newCorpus } from "./do-stubs.js";
import type { FakeCorpus } from "./do-stubs.js";
import { ROUTABLE_V4, scriptedConnector, scriptedResolver } from "./net-stubs.js";
import type { ScriptedResponse } from "./net-stubs.js";

const TARGET = "https://api.example.com/v1/geocode";

/** The x402 v2 shape the strict decoder actually accepts. */
const SPEC_V2 = {
  x402Version: 2,
  error: "Payment authorization is required",
  resource: {
    url: TARGET,
    description: "Geocode one address",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  extensions: {},
};

/** A v1 endpoint: healthy, and refused by a v2-only decoder. */
const V1_BODY = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "2500",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      resource: TARGET,
      maxTimeoutSeconds: 300,
      mimeType: "application/json",
      description: "Geocode one address",
    },
  ],
};

function b64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function resolver() {
  return scriptedResolver({
    "api.example.com": [ROUTABLE_V4],
    "other.example.net": [ROUTABLE_V4],
    // Resolves into loopback: refused for where it goes, not what it is called.
    "internal.example.com": ["127.0.0.1"],
  });
}

interface Harness {
  env: Env;
  corpus: FakeCorpus;
  /** Every URL the connector was actually asked for. */
  requests: string[];
}

function harness(
  routes: Record<string, ScriptedResponse>,
  overrides: Partial<Env> = {},
  connectorOverride?: Connector,
): Harness {
  const corpus = newCorpus();
  const connector = scriptedConnector(routes);
  setProbeTransportForTests({
    resolver: resolver(),
    connector: connectorOverride ?? connector,
  });

  return {
    corpus,
    requests: connector.requests,
    env: mockEnv({
      DB: fakeD1(corpus),
      PROBE_LIMITER: fakeLimiterNamespace(),
      ...overrides,
    }),
  };
}

/** The v2 endpoint every "happy path" test points at. */
function v2Harness(overrides: Partial<Env> = {}): Harness {
  return harness(
    {
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
        body: "",
      },
    },
    overrides,
  );
}

async function get(env: Env, path: string, accept?: string): Promise<Response> {
  return handleRequest(
    request(path, accept === undefined ? {} : { headers: { accept } }),
    env,
    mockCtx(),
  );
}

function inspectUrl(target = TARGET, prefix = "/api/v1/inspect"): string {
  return `${prefix}?url=${encodeURIComponent(target)}`;
}

interface Envelope {
  tool: string;
  meta: { implemented: boolean; cached: boolean; cache_age_seconds: number | null; score_version: string | null };
  warnings: { code: string; message: string }[];
  data: {
    target: { url: string | null; endpoint_id: string | null; host: string | null };
    probe: { http_status: number | null; observed_at: string; served_from_cache: boolean } | null;
    challenge: { wire_form: string; valid: boolean; x402_version: number | null; accepts: unknown[]; decode_error: { code: string } | null } | null;
    terms: { amount_atomic: string | null; amount_decimal: string | null; pay_to: string | null; network: string | null } | null;
    checks: { id: string; status: string; offline: boolean }[];
    signals: { id: string; observed: boolean }[];
    risk: { band: string; score: number; score_version: string; confidence: string; reasons: { signal_id: string; status: string; weight: number; message: string }[] } | null;
    observed: { has_history: boolean; first_seen: string | null; scan_count: number; availability_30d: number | null; latency_p50_ms: number | null };
    links: { html: string | null; markdown: string | null; json: string | null; methodology: string | null };
  };
}

afterEach(() => {
  setProbeTransportForTests(null);
});

// ── state 1: a valid challenge ────────────────────────────────────────────

describe("a spec-shaped x402 v2 endpoint", () => {
  it("returns the full report and validates against spec/schemas/inspect.json", async () => {
    const { env } = v2Harness();
    const res = await get(env, inspectUrl());

    expect(res.status).toBe(200);
    const body = await json<Envelope>(res);

    const { ok, errors } = validateAgainst("inspect", body);
    expect(ok, errors).toBe(true);

    expect(body.meta.implemented).toBe(true);
    expect(body.data.challenge?.wire_form).toBe("v2-header");
    expect(body.data.challenge?.valid).toBe(true);
    expect(body.data.challenge?.x402_version).toBe(2);
    expect(body.data.terms?.amount_atomic).toBe("1000");
    // Derived from the asset's decimals in the tx402 signed manifest, not guessed.
    expect(body.data.terms?.amount_decimal).toBe("0.001000");
    expect(body.data.terms?.pay_to).toBe("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
    expect(body.data.target.endpoint_id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("renders score()'s band and reasons verbatim, and the score reproduces from them", async () => {
    const { env } = v2Harness();
    const body = await json<Envelope>(await get(env, inspectUrl()));

    const risk = body.data.risk;
    expect(risk).not.toBeNull();
    if (!risk) return;

    expect(["LOW", "MEDIUM", "HIGH"]).toContain(risk.band);
    expect(risk.score_version).toBe("v1");
    // No corpus yet, and the response says so rather than implying otherwise.
    expect(risk.confidence).toBe("static_only");

    // reproducibility from the same response IS the appeal
    // mechanism. If this stops holding, the published claim is false.
    const scored = risk.reasons.filter((r) => r.status !== "skip");
    const possible = scored.reduce((sum, r) => sum + r.weight, 0);
    const earned = scored.filter((r) => r.status === "pass").reduce((sum, r) => sum + r.weight, 0);
    expect(Math.round((earned / possible) * 100)).toBe(risk.score);
  });

  it("emits the frozen check ids only, and never counts a skip as a pass", async () => {
    const { env } = v2Harness();
    const body = await json<Envelope>(await get(env, inspectUrl()));

    // SPEC §5.2.1 freezes these. An id invented here would be one the CLI and
    // the MCP server have never seen.
    const FROZEN = new Set([
      "wire_form_detected", "base64_strict", "size_within_limit", "depth_within_limit",
      "no_duplicate_keys", "json_wellformed", "x402_version_known", "accepts_present",
      "accepts_within_limit", "scheme_known", "network_caip2_wellformed", "network_recognized",
      "asset_recognized", "amount_atomic_canonical", "amount_positive", "pay_to_wellformed",
      "max_timeout_sane", "resource_origin_match", "mime_type_wellformed", "extra_wellformed",
      "facilitator_known", "amount_within_observed_range", "recipient_matches_observed",
      "endpoint_known",
    ]);
    for (const check of body.data.checks) {
      expect(FROZEN, `unfrozen check id: ${check.id}`).toContain(check.id);
    }

    const historical = body.data.checks.filter((c) => !c.offline);
    expect(historical.length).toBeGreaterThan(0);
    // The corpus is empty, so every corpus-dependent check must be `skip`.
    // "No data" is never a pass — that is the difference between a trust tool
    // and a rubber stamp.
    for (const check of historical) expect(check.status).toBe("skip");
  });
});

// ── state 2: a malformed challenge ────────────────────────────────────────

describe("a malformed challenge", () => {
  it("is a report with failing checks at HTTP 200, not an error", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": {
        status: 402,
        body: JSON.stringify({ x402Version: 2, accepts: [] }),
      },
    });

    const res = await get(env, inspectUrl());
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(validateAgainst("inspect", body).ok).toBe(true);

    expect(body.data.challenge?.valid).toBe(false);
    expect(body.data.challenge?.decode_error).not.toBeNull();
    // SPEC §4.2: a refused challenge exposes no accepted requirements.
    expect(body.data.challenge?.accepts).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain("CHALLENGE_MALFORMED");

    // It IS scored — a broken challenge is a real finding, unlike a URL that
    // never claimed to speak x402 at all.
    expect(body.data.risk).not.toBeNull();
    expect(body.data.risk?.reasons.some((r) => r.signal_id === "challenge_decodes" && r.status === "fail")).toBe(true);
  });

  it("marks terms parsed from a refused challenge as 'as served', never as accepted", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 402, body: JSON.stringify(V1_BODY) },
    });

    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();
    expect(html).toContain("The decoder refused this challenge");
    expect(html).toContain("<strong>not</strong> terms tx402 would pay");

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    expect(md).toContain("The decoder REFUSED this challenge");
  });
});

// ── state 3: not an x402 endpoint ─────────────────────────────────────────

describe("a URL that is not an x402 endpoint", () => {
  it("says so plainly: risk is null, not HIGH, and it is not an error", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 200, body: '{"hello":"world"}' },
    });

    const res = await get(env, inspectUrl());
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(validateAgainst("inspect", body).ok).toBe(true);

    expect(body.data.challenge?.wire_form).toBe("none");
    // a URL that is not an x402 endpoint is not a risky
    // endpoint, and a band for one would be a verdict about something we never
    // assessed.
    expect(body.data.risk).toBeNull();
    expect(body.warnings.map((w) => w.code)).toContain("NOT_X402");
  });

  it("renders 'not an x402 endpoint' rather than a band, on both surfaces", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 200, body: '{"hello":"world"}' },
    });

    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();
    expect(html).toContain("not an x402 endpoint");
    expect(html).not.toContain(">HIGH<");

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    expect(md).toContain("## RISK — not an x402 endpoint");
    expect(md).not.toMatch(/RISK — HIGH/u);
  });

  it("does not claim the decoder refused something that was never served", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 200, body: '{"hello":"world"}' },
    });

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    expect(md).not.toMatch(/\| Decoder\b/u);
    expect(md).toContain("the only check that could run is the one that looks for one");

    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();
    expect(html).not.toContain("Strict decoder");
  });
});

// ── state 4: the guard refused ────────────────────────────────────────────

describe("a URL the guard refuses", () => {
  it("returns the error envelope and never probes", async () => {
    const { env, requests } = v2Harness();
    const res = await get(env, inspectUrl("https://internal.example.com/x"));

    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string; message: string; retryable: boolean } }>(res);
    expect(body.error.code).toBe("URL_PRIVATE_ADDRESS");
    expect(body.error.retryable).toBe(false);
    // Refusing after connecting would be a detection, not a defence.
    expect(requests).toHaveLength(0);
  });

  it("gives the SAME generic message for every blocked-URL code", async () => {
    const { env } = v2Harness();

    const blocked = await Promise.all(
      ["https://internal.example.com/x", "http://api.example.com/v1/geocode"].map(async (url) => {
        const res = await get(env, inspectUrl(url));
        return json<{ error: { code: string; message: string } }>(res);
      }),
    );

    const codes = new Set(blocked.map((b) => b.error.code));
    const messages = new Set(blocked.map((b) => b.error.message));
    // Different codes internally, one sentence externally: a guard that
    // explains itself precisely is a network scanner with extra steps.
    expect(codes.size).toBe(2);
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe("That URL cannot be probed.");
  });

  it("renders the refusal as a page for a browser, with that same message", async () => {
    const { env } = v2Harness();
    const res = await get(env, `/inspect?url=${encodeURIComponent("https://internal.example.com/x")}`, "text/html");

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("That URL cannot be probed.");
    expect(html).toContain("URL_PRIVATE_ADDRESS");
  });

  it("reports an unreachable endpoint as PROBE_FAILED and marks it retryable", async () => {
    const refuseToConnect: Connector = {
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const { env } = harness({}, {}, refuseToConnect);

    const res = await get(env, inspectUrl());
    expect(res.status).toBe(502);
    const body = await json<{ error: { code: string; retryable: boolean } }>(res);
    expect(body.error.code).toBe("PROBE_FAILED");
    expect(body.error.retryable).toBe(true);
  });
});

// ── the empty corpus is the default case ──────────────────────────────────

describe("the empty-corpus rendering", () => {
  it("never fabricates an availability percentage from one probe", async () => {
    const { env } = v2Harness();
    const body = await json<Envelope>(await get(env, inspectUrl()));

    expect(body.data.observed.has_history).toBe(false);
    expect(body.data.observed.availability_30d).toBeNull();
    expect(body.data.observed.latency_p50_ms).toBeNull();
    expect(body.data.observed.first_seen).toBe(body.data.probe?.observed_at);
    expect(body.warnings.map((w) => w.code)).toContain("NO_HISTORY");
  });

  it("looks deliberate on both rendered surfaces", async () => {
    // A fresh corpus per surface: the first scan of a URL is the state under
    // test here, and any scan writes the endpoint into the corpus.
    const html = await (
      await get(v2Harness().env, inspectUrl(TARGET, "/inspect"), "text/html")
    ).text();
    expect(html).toContain("First seen: just now · no history yet");

    const md = await (
      await get(v2Harness().env, inspectUrl(TARGET, "/inspect"), "text/markdown")
    ).text();
    expect(md).toContain("First seen: just now · no history yet");
    expect(md).not.toMatch(/Availability \(30d\)\s*\|\s*[0-9]/u);
  });

  it("reports history once the corpus has seen the endpoint before", async () => {
    const { env } = v2Harness();

    const first = await json<Envelope>(await get(env, inspectUrl()));
    expect(first.data.observed.has_history).toBe(false);
    expect(first.data.observed.scan_count).toBe(1);

    // A different endpoint id would defeat the point, so this is the same URL —
    // served from the politeness cache, and still reading the corpus row the
    // first scan wrote.
    const second = await json<Envelope>(await get(env, inspectUrl()));
    expect(second.data.observed.has_history).toBe(true);
    expect(second.data.observed.first_seen).toBe(first.data.observed.first_seen);
  });
});

// ── politeness ────────────────────────────────────────────────────────────

describe("the politeness cache", () => {
  it("probes once per endpoint however many times it is asked", async () => {
    const { env, requests } = v2Harness();

    await get(env, inspectUrl());
    await get(env, inspectUrl());
    await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown");

    expect(requests).toHaveLength(1);
  });

  it("says a result came from cache, and how old it is", async () => {
    const { env } = v2Harness();

    const first = await json<Envelope>(await get(env, inspectUrl()));
    expect(first.meta.cached).toBe(false);
    expect(first.data.probe?.served_from_cache).toBe(false);

    const second = await json<Envelope>(await get(env, inspectUrl()));
    expect(second.meta.cached).toBe(true);
    expect(second.meta.cache_age_seconds).not.toBeNull();
    expect(second.data.probe?.served_from_cache).toBe(true);
    // The observation is the leader's, and its timestamp says so rather than
    // being refreshed to now.
    expect(second.data.probe?.observed_at).toBe(first.data.probe?.observed_at);
  });

  it("records nothing new in the corpus for a cached answer", async () => {
    const { env, corpus } = v2Harness();

    await get(env, inspectUrl());
    await get(env, inspectUrl());
    await get(env, inspectUrl());

    // `last_seen` means "last observed", not "last asked about".
    expect(corpus.scans).toHaveLength(1);
    expect(corpus.endpoints.size).toBe(1);
  });

  it("does not count a cached read as a scan", async () => {
    const { env, corpus } = v2Harness();

    const first = await json<Envelope>(await get(env, inspectUrl()));
    expect(first.data.observed.scan_count).toBe(1);

    // Three people looking at one observation is one observation. Counting
    // views as scans would inflate every number the corpus reports.
    await get(env, inspectUrl());
    const third = await json<Envelope>(await get(env, inspectUrl()));
    expect(third.meta.cached).toBe(true);
    expect(third.data.observed.scan_count).toBe(1);
    expect(corpus.scans).toHaveLength(1);
  });
});

// ── the flywheel ──────────────────────────────────────────────────────────

describe("every scan seeds the corpus", () => {
  it("writes the endpoint, its current terms and the scan", async () => {
    const { env, corpus } = v2Harness();
    const body = await json<Envelope>(await get(env, inspectUrl()));
    const id = body.data.target.endpoint_id ?? "";

    const endpoint = corpus.endpoints.get(id);
    expect(endpoint).toBeDefined();
    expect(endpoint?.discovery_source).toBe("human");
    expect(endpoint?.host).toBe("api.example.com");
    expect(endpoint?.status).toBe("active");

    const terms = corpus.terms.get(id);
    expect(terms?.amount_atomic).toBe("1000");
    expect(terms?.network).toBe("eip155:8453");
    expect(terms?.band).toBe(body.data.risk?.band);
    expect(terms?.score_version).toBe("v1");

    expect(corpus.scans).toHaveLength(1);
    // `retained_reason` is a CHECK constraint, and the first
    // sight of an endpoint is exactly what `first_seen` is for.
    expect(corpus.scans[0]?.retained_reason).toBe("first_seen");
    expect(corpus.scans[0]?.source).toBe("api");
  });

  it("marks a URL that served no challenge as not_x402 rather than dropping it", async () => {
    const { env, corpus } = harness({
      "api.example.com/v1/geocode": { status: 200, body: "{}" },
    });
    await get(env, inspectUrl());
    expect([...corpus.endpoints.values()][0]?.status).toBe("not_x402");
  });

  it("degrades to a warning when the corpus cannot be written", async () => {
    const { env, corpus } = v2Harness();
    corpus.failWrites = true;

    const res = await get(env, inspectUrl());
    expect(res.status).toBe(200);
    const body = await json<Envelope>(res);
    expect(validateAgainst("inspect", body).ok).toBe(true);
    expect(body.warnings.map((w) => w.code)).toContain("CORPUS_WRITE_FAILED");
    // The report is about the endpoint. Our bookkeeping is not the user's problem.
    expect(body.data.terms?.amount_atomic).toBe("1000");
  });
});

// ── content negotiation (SPEC §1.2) ──────────────────────────

describe("the three representations are one computation", () => {
  it("serves JSON, Markdown and HTML from the same scan", async () => {
    const { env } = v2Harness();

    const jsonRes = await get(env, inspectUrl(TARGET, "/inspect"), "application/json");
    const mdRes = await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown");
    const htmlRes = await get(env, inspectUrl(TARGET, "/inspect"), "text/html");

    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    expect(htmlRes.headers.get("content-type")).toContain("text/html");

    // A cache that ignores this serves HTML to an agent.
    for (const res of [jsonRes, mdRes, htmlRes]) {
      expect(res.headers.get("vary")).toBe("Accept");
      expect(res.headers.get("link")).toContain('rel="alternate"');
    }
  });

  it("says the same thing in the markdown mirror as in the JSON", async () => {
    const { env } = v2Harness();

    const body = await json<Envelope>(await get(env, inspectUrl()));
    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();

    expect(md).toContain(`## RISK — ${body.data.risk?.band}`);
    expect(md).toContain(`${body.data.risk?.score}/100`);
    expect(md).toContain("0.001000 USDC");
    expect(md).toContain(body.data.target.endpoint_id ?? "");
    // Every reason string is the one score produced, unedited.
    for (const reason of body.data.risk?.reasons ?? []) {
      if (reason.status === "skip") continue;
      expect(md).toContain(reason.message);
    }
  });

  it("keeps the report's sections in the documented order", async () => {
    const { env } = v2Harness();
    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();

    const order = ["## ENDPOINT", "## PAYMENT", "## OBSERVED", "## SECURITY", "## RISK"];
    let cursor = -1;
    for (const heading of order) {
      const at = md.indexOf(heading);
      expect(at, `${heading} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("answers a bare /inspect with the paste box, the usage note and an empty envelope", async () => {
    const { env } = v2Harness();

    const html = await (await get(env, "/inspect", "text/html")).text();
    expect(html).toContain("Paste an endpoint URL to see what it charges");
    expect(html).toContain('name="url"');

    const md = await (await get(env, "/inspect", "text/markdown")).text();
    expect(md).toContain("## USAGE");
    expect(md).toContain("Accept: text/markdown");

    const body = await json<Envelope>(await get(env, "/api/v1/inspect"));
    expect(validateAgainst("inspect", body).ok).toBe(true);
    expect(body.data.target.url).toBeNull();
    expect(body.data.risk).toBeNull();
    expect(body.warnings.map((w) => w.code)).toContain("NO_URL");
  });
});

// ── the v1 honesty requirement ────────────────────────────

describe("a legacy v1 endpoint", () => {
  it("scores it honestly and says the shortfall is about tx402, not the operator", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 402, body: JSON.stringify(V1_BODY) },
    });

    const body = await json<Envelope>(await get(env, inspectUrl()));
    expect(validateAgainst("inspect", body).ok).toBe(true);
    expect(body.data.challenge?.wire_form).toBe("v1-body");
    expect(body.data.challenge?.x402_version).toBe(1);
    expect(body.data.challenge?.valid).toBe(false);

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    expect(md).toContain("That is a statement about what a tx402 buyer can pay today, not");
    expect(md).toContain("about how this endpoint is run");

    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();
    expect(html).toContain("tx402&#39;s decoder is v2-only");
  });

  it("still reports the terms it could read, so the operator can act on them", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": { status: 402, body: JSON.stringify(V1_BODY) },
    });
    const body = await json<Envelope>(await get(env, inspectUrl()));

    // `observed_terms`, surfaced as `terms` — never as `challenge.accepts`.
    expect(body.data.terms?.amount_atomic).toBe("2500");
    expect(body.data.challenge?.accepts).toEqual([]);
  });
});

// ── the language audit ─────────────────────────────────────

describe("the language rules", () => {
  const BANNED = ["scam", "fraud", "fraudulent", "unsafe", "dangerous", "malicious"];

  it("uses none of the forbidden words on any surface, in any result state", async () => {
    const cases: Record<string, ScriptedResponse> = {
      valid: { status: 402, headers: { "payment-required": b64(SPEC_V2) }, body: "" },
      malformed: { status: 402, body: JSON.stringify({ x402Version: 2, accepts: [] }) },
      notX402: { status: 200, body: "{}" },
    };

    for (const [name, response] of Object.entries(cases)) {
      const { env } = harness({ "api.example.com/v1/geocode": response });
      for (const accept of ["application/json", "text/markdown", "text/html"]) {
        const text = await (await get(env, inspectUrl(TARGET, "/inspect"), accept)).text();
        const lower = text.toLowerCase();
        for (const word of BANNED) {
          expect(lower.includes(word), `${name}/${accept} contains "${word}"`).toBe(false);
        }
      }
    }
  });

  it("carries the observation note above the fold wherever a band is rendered", async () => {
    const { env } = v2Harness();
    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();

    expect(html).toContain("These are observations, not accusations.");
    expect(html).toContain("/methodology");
    // The note has to precede the verdict it qualifies. Matched on the markup
    // rather than the class name, because the class names also appear in the
    // stylesheet in <head>.
    expect(html.indexOf('class="observation-note"')).toBeLessThan(
      html.indexOf('<section class="verdict">'),
    );
  });

  it("links the methodology page and shows the score version", async () => {
    const { env } = v2Harness();
    const body = await json<Envelope>(await get(env, inspectUrl()));

    expect(body.data.links.methodology).toBe("https://tools.tx402.io/methodology?v=v1");
    expect(body.meta.score_version).toBe("v1");

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    expect(md).toContain("score_version `v1`");
    expect(md).toContain("https://tools.tx402.io/methodology?v=v1");
  });
});

// ── the CTA ───────────────────────────────────────────────────────────────

describe("Test with tx402 →", () => {
  it("pre-fills the snippets with this endpoint's real terms", async () => {
    const { env } = v2Harness();
    const html = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/html")).text();

    expect(html).toContain("npx tx402 call");
    expect(html).toContain("--max-spend &quot;0.001000 USDC&quot;");
    expect(html).toContain("--dry-run");
    expect(html).toContain("createTx402Client");
    expect(html).toContain("Tx402Client(");
    expect(html).toContain("max_per_request=&quot;0.001000 USDC&quot;");
    expect(html).toContain("eip155:8453");
  });

  it("omits a cap it could not read rather than inventing one", async () => {
    const { env } = harness({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: {
          "payment-required": b64({
            ...SPEC_V2,
            accepts: [{ ...SPEC_V2.accepts[0], amount: "12.5", asset: "0xdeadbeef" }],
          }),
        },
        body: "",
      },
    });

    const md = await (await get(env, inspectUrl(TARGET, "/inspect"), "text/markdown")).text();
    // The flag is not emitted with a value; the only mention left is the
    // comment explaining why. A guessed cap is worse than no cap.
    expect(md).not.toMatch(/--max-spend "/u);
    expect(md).toContain("could not be read, so --max-spend is left for you to set");
  });
});

// ── Turnstile ───────────────────────────────────────────────

describe("Turnstile", () => {
  it("no-ops when no site key is configured, which is today", async () => {
    const { env } = v2Harness();
    const res = await handleRequest(
      request("/api/v1/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: TARGET }),
      }),
      env,
      mockCtx(),
    );

    expect(res.status).toBe(200);
    const body = await json<Envelope>(res);
    expect(validateAgainst("inspect", body).ok).toBe(true);
    expect(body.data.terms?.amount_atomic).toBe("1000");
  });

  it("requires a token once a widget is configured", async () => {
    const { env } = v2Harness({
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    });

    const res = await handleRequest(
      request("/api/v1/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: TARGET }),
      }),
      env,
      mockCtx(),
    );

    expect(res.status).toBe(401);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("TURNSTILE_REQUIRED");
  });

  it("renders the paste box as a POST form once a widget is configured", async () => {
    const { env } = v2Harness({ TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });
    const html = await (await get(env, "/inspect", "text/html")).text();

    expect(html).toContain('method="POST"');
    expect(html).toContain("cf-turnstile");
  });
});
