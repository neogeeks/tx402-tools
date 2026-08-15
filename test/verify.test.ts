/**
 * `worker/routes/verify.ts` —.
 *
 * The route is thin on purpose: the verdict comes from
 * `packages/tools-cli/src/verify-offline.ts`, which `test/verify-offline.test.ts`
 * covers in depth. What is tested here is everything the route adds — request
 * validation, the three content-negotiated representations, and the
 * offline/enriched boundary, which is the product.
 *
 * Every JSON response is validated against `spec/schemas/verify.json` rather
 * than against a TypeScript type, because the schema is what the CLI and the
 * MCP server build against and a type proves nothing about the
 * wire format.
 */

import { describe, expect, it } from "vitest";

import { handleRequest } from "../worker/router.js";
import { parseVerifyRequest, runVerify } from "../worker/routes/verify.js";
import { mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import type { Env } from "../worker/types.js";

const TARGET = "https://api.example.com/v1/geocode";

const SPEC_V2 = {
  x402Version: 2,
  error: "Payment authorization is required",
  resource: { url: TARGET, description: "Geocode one address", mimeType: "application/json" },
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

const header = Buffer.from(JSON.stringify(SPEC_V2), "utf8").toString("base64");

interface VerifyEnvelope {
  tool: string;
  meta: { implemented: boolean; score_version: string | null; tx402_version: string | null };
  warnings: { code: string; message: string }[];
  data: {
    verdict: string;
    challenge: { valid: boolean; wire_form: string } | null;
    checks: { id: string; status: string; offline: boolean; reason: string | null; detail: string | null }[];
    signals: { id: string; observed: boolean }[];
    risk: { score: number; band: string; score_version: string } | null;
    enrichment: Record<string, unknown> | null;
  };
}

async function post(body: unknown, env: Env = mockEnv()): Promise<Response> {
  return handleRequest(
    request("/api/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    mockCtx(),
  );
}

/** A corpus that has never seen anything — the state until the corpus lands. */
function emptyCorpus(): Env {
  return mockEnv({
    DB: {
      prepare: () => ({
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
        bind: function bind() {
          return this;
        },
      }),
    } as unknown as Env["DB"],
  });
}

/** A corpus with one endpoint on it, so the populated path is exercised too. */
function seededCorpus(row: Record<string, unknown>): Env {
  return mockEnv({
    DB: {
      prepare: (sql: string) => ({
        first: async () => (sql.includes("endpoints") ? row : null),
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
        bind: function bind() {
          return this;
        },
      }),
    } as unknown as Env["DB"],
  });
}

// ══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/verify", () => {
  it("returns a verdict that validates against spec/schemas/verify.json", async () => {
    const res = await post({ challenge: { header }, context: { url: TARGET } }, emptyCorpus());
    expect(res.status).toBe(200);

    const body = await res.json<VerifyEnvelope>();
    const { ok, errors } = validateAgainst("verify", body);
    expect(ok, errors).toBe(true);

    expect(body.tool).toBe("verify");
    expect(body.data.verdict).toBe("pass");
    expect(body.data.challenge?.valid).toBe(true);
    expect(body.meta.score_version).toBe("v1");
    expect(body.meta.tx402_version).toBeTruthy();
  });

  it("stamps meta.implemented true, since the route is real", async () => {
    // `worker/router.ts` still declares this as a stub and has exactly one
    // owner, so the envelope is corrected in the handler. The integrator flips
    // the router declaration at the next release —.
    const res = await post({ challenge: { header } }, emptyCorpus());
    const body = await res.json<VerifyEnvelope>();
    expect(body.meta.implemented).toBe(true);
  });

  it("reports a refused challenge as a 200 with the finding in data (SPEC §3.1)", async () => {
    // "An endpoint being broken is the answer the user came for, not a failure
    // of our service." A 4xx here would make every honest negative result look
    // like our bug.
    const res = await post({ challenge: { raw: "not a challenge" } }, emptyCorpus());
    expect(res.status).toBe(200);

    const body = await res.json<VerifyEnvelope>();
    expect(validateAgainst("verify", body).ok).toBe(true);
    expect(body.data.verdict).toBe("fail");
    expect(body.warnings.some((w) => w.code === "CHALLENGE_MALFORMED")).toBe(true);
  });

  it("validates the request body against the frozen request schema's shape", async () => {
    const cases: Array<[string, unknown]> = [
      ["no body at all", {}],
      ["no challenge", { context: { url: TARGET } }],
      ["empty challenge", { challenge: {} }],
      ["blank header", { challenge: { header: "   " } }],
      ["two of the three", { challenge: { header, raw: "x" } }],
    ];

    for (const [name, body] of cases) {
      const res = await post(body, emptyCorpus());
      expect(res.status, name).toBe(422);
      const error = await res.json<{ error: { code: string; detail: { fields: string[] } } }>();
      expect(validateAgainst("error", error).ok, name).toBe(true);
      expect(error.error.code, name).toBe("VALIDATION_FAILED");
      expect(error.error.detail.fields.length, name).toBeGreaterThan(0);
    }
  });

  it("rejects a body that is not JSON, and one that is too large", async () => {
    const bad = await handleRequest(
      request("/api/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      emptyCorpus(),
      mockCtx(),
    );
    expect(bad.status).toBe(400);

    const huge = await handleRequest(
      request("/api/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: { raw: "x".repeat(300 * 1024) } }),
      }),
      emptyCorpus(),
      mockCtx(),
    );
    expect(huge.status).toBe(400);
  });

  it("accepts every one of the three input forms", async () => {
    const forms = [
      { header },
      { body: SPEC_V2 },
      { raw: header },
      { raw: JSON.stringify(SPEC_V2) },
    ];
    for (const challenge of forms) {
      const res = await post({ challenge, context: { url: TARGET } }, emptyCorpus());
      const body = await res.json<VerifyEnvelope>();
      expect(validateAgainst("verify", body).ok).toBe(true);
      expect(body.data.challenge?.valid, JSON.stringify(challenge).slice(0, 40)).toBe(true);
    }
  });
});

describe("parseVerifyRequest", () => {
  it("defaults options.enrich to false — the caller opts in, never out", () => {
    for (const body of [
      { challenge: { header } },
      { challenge: { header }, options: {} },
      { challenge: { header }, options: { enrich: false } },
      { challenge: { header }, options: null },
    ]) {
      const parsed = parseVerifyRequest(body);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.options.enrich).toBe(false);
    }

    const opted = parseVerifyRequest({ challenge: { header }, options: { enrich: true } });
    expect(opted.ok && opted.value.options.enrich).toBe(true);
  });

  it("names the offending fields when more than one challenge form is sent", () => {
    const parsed = parseVerifyRequest({ challenge: { header, body: SPEC_V2, raw: "x" } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.fields).toEqual(["challenge.header", "challenge.body", "challenge.raw"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  The split — the product boundary
// ══════════════════════════════════════════════════════════════════════════

describe("the offline / hosted split", () => {
  it("without enrich, enrichment is null and the corpus checks skip", async () => {
    const res = await post({ challenge: { header }, context: { url: TARGET } }, emptyCorpus());
    const body = await res.json<VerifyEnvelope>();

    expect(body.data.enrichment).toBeNull();

    const hosted = body.data.checks.filter((c) => !c.offline);
    expect(hosted.map((c) => c.id)).toEqual([
      "amount_within_observed_range",
      "recipient_matches_observed",
      "endpoint_known",
    ]);
    for (const check of hosted) {
      expect(check.status, check.id).toBe("skip");
      expect(check.reason, check.id).toBe("offline_only");
    }
  });

  it("with enrich and an empty corpus, the answer is no data — never a pass", async () => {
    //. decision 5 and a missing history is
    // UNKNOWN. Reporting "we have no record of this endpoint" as a clean bill
    // of health is the single most damaging thing a verifier could do.
    const res = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      emptyCorpus(),
    );
    const body = await res.json<VerifyEnvelope>();
    expect(validateAgainst("verify", body).ok).toBe(true);

    expect(body.data.enrichment).not.toBeNull();
    expect(body.data.enrichment?.endpoint_known).toBe(false);
    expect(body.data.enrichment?.amount_within_observed_range).toBeNull();
    expect(body.data.enrichment?.recipient_matches_observed).toBeNull();

    for (const check of body.data.checks.filter((c) => !c.offline)) {
      expect(check.status, check.id).toBe("skip");
      expect(check.reason, check.id).toBe("no_data");
      expect(check.status, check.id).not.toBe("pass");
      expect(check.status, check.id).not.toBe("warn");
    }

    expect(body.warnings.some((w) => w.code === "NO_HISTORY")).toBe(true);
  });

  it("enrichment never changes the offline verdict", async () => {
    const plainRes = await post(
      { challenge: { header }, context: { url: TARGET } },
      emptyCorpus(),
    );
    const plain = await plainRes.json<VerifyEnvelope>();

    const enrichedRes = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      emptyCorpus(),
    );
    const enriched = await enrichedRes.json<VerifyEnvelope>();

    expect(enriched.data.verdict).toBe(plain.data.verdict);
    expect(enriched.data.risk?.score).toBe(plain.data.risk?.score);

    const offlineOf = (b: VerifyEnvelope): unknown => b.data.checks.filter((c) => c.offline);
    expect(offlineOf(enriched)).toEqual(offlineOf(plain));
  });

  it("enrich without a context.url says so instead of guessing", async () => {
    const res = await post({ challenge: { header }, options: { enrich: true } }, emptyCorpus());
    const body = await res.json<VerifyEnvelope>();

    expect(body.data.enrichment?.endpoint_known).toBe(false);
    expect(body.data.enrichment?.endpoint_id).toBeNull();
    for (const check of body.data.checks.filter((c) => !c.offline)) {
      expect(check.reason, check.id).toBe("no_context_url");
    }
    expect(body.warnings.some((w) => w.code === "NO_CONTEXT_URL")).toBe(true);
  });

  it("a single observation is not a range", async () => {
    // One data point is a data point. Reporting "within the observed range"
    // from it would be inventing a statistic — the same mistake
    // forbids for availability.
    const res = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      seededCorpus({
        amount_atomic: "1000",
        pay_to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        scan_count: 1,
        first_seen: "2026-08-01T00:00:00Z",
      }),
    );
    const body = await res.json<VerifyEnvelope>();

    const known = body.data.checks.find((c) => c.id === "endpoint_known");
    expect(known?.status).toBe("pass");

    const range = body.data.checks.find((c) => c.id === "amount_within_observed_range");
    expect(range?.status).toBe("skip");
    expect(range?.reason).toBe("insufficient_data");
    expect(body.data.enrichment?.observed_amount_range).toBeNull();
  });

  it("a changed recipient is reported without a verdict (SPEC §6.4)", async () => {
    // x402 v2 lets a server choose a payout address per request and gives the
    // client no way to tell that apart from an unstable recipient. So this is an observation, never a
    // finding, and a bare "the recipient changed" is forbidden in every
    // version of this tool.
    const res = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      seededCorpus({
        amount_atomic: "1000",
        pay_to: "0x0000000000000000000000000000000000000001",
        scan_count: 12,
        first_seen: "2026-06-01T00:00:00Z",
      }),
    );
    const body = await res.json<VerifyEnvelope>();

    const check = body.data.checks.find((c) => c.id === "recipient_matches_observed");
    expect(check?.status).toBe("skip");
    expect(check?.status).not.toBe("fail");
    expect(check?.status).not.toBe("warn");
    expect(check?.detail).toContain("per request");
    expect(body.data.verdict).not.toBe("fail");
  });

  it("an amount outside the observed range warns, and says prices change", async () => {
    const res = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      seededCorpus({
        amount_atomic: "9999",
        pay_to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        scan_count: 12,
        first_seen: "2026-06-01T00:00:00Z",
      }),
    );
    const body = await res.json<VerifyEnvelope>();

    const range = body.data.checks.find((c) => c.id === "amount_within_observed_range");
    expect(range?.status).toBe("warn");
    expect(range?.detail).toContain("Prices change");
    expect(body.data.verdict).toBe("warn");
  });

  it("an unreachable corpus degrades to no data rather than failing the request", async () => {
    const broken = mockEnv({
      DB: {
        prepare: () => {
          throw new Error("D1 unavailable");
        },
      } as unknown as Env["DB"],
    });
    const res = await post(
      { challenge: { header }, context: { url: TARGET }, options: { enrich: true } },
      broken,
    );
    expect(res.status).toBe(200);
    const body = await res.json<VerifyEnvelope>();
    expect(validateAgainst("verify", body).ok).toBe(true);
    expect(body.data.enrichment?.endpoint_known).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Content negotiation (SPEC §1.2)
// ══════════════════════════════════════════════════════════════════════════

describe("GET /verify — three representations of one result", () => {
  const query = `/verify?challenge=${encodeURIComponent(header)}&url=${encodeURIComponent(TARGET)}`;

  it("serves HTML to a browser, with the observation note above the fold", async () => {
    const res = await handleRequest(request(query), emptyCorpus(), mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toBe("Accept");

    const html = await res.text();
    expect(html).toContain("These are observations, not accusations");
    // The product boundary has to be visible on the page, not inferred.
    expect(html).toContain("Checked offline");
    expect(html).toContain("Checked against our data");
  });

  it("serves the same result as JSON", async () => {
    const res = await handleRequest(
      request(query, { headers: { accept: "application/json" } }),
      emptyCorpus(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<VerifyEnvelope>();
    expect(validateAgainst("verify", body).ok).toBe(true);
    expect(body.data.verdict).toBe("pass");
  });

  it("serves the markdown mirror, and it keeps the offline/hosted split", async () => {
    const res = await handleRequest(
      request(query, { headers: { accept: "text/markdown" } }),
      emptyCorpus(),
      mockCtx(),
    );
    expect(res.headers.get("content-type")).toContain("text/markdown");

    const md = await res.text();
    expect(md).toContain("# 402 Verify");
    expect(md).toContain("## CHECKED OFFLINE");
    expect(md).toContain("## CHECKED AGAINST OUR DATA");
    expect(md).toContain("Not requested");
    expect(md).toContain("PASS");
  });

  it("renders the empty form when nothing has been pasted", async () => {
    const res = await handleRequest(request("/verify"), emptyCorpus(), mockCtx());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Paste an x402 challenge");
  });

  it("answers the JSON mirror honestly when nothing has been pasted", async () => {
    const res = await handleRequest(
      request("/verify", { headers: { accept: "application/json" } }),
      emptyCorpus(),
      mockCtx(),
    );
    const body = await res.json<VerifyEnvelope>();
    // Still schema-valid, so the CLI and MCP can be written against it.
    expect(validateAgainst("verify", body).ok).toBe(true);
    expect(body.data.challenge).toBeNull();
    expect(body.data.checks).toEqual([]);
    expect(body.warnings.some((w) => w.code === "NO_DATA")).toBe(true);
  });

  it("turns a submitted form into its own permalink", async () => {
    // The result of verifying a challenge is a function of the challenge, so
    // the address bar is the share link and nothing needs storing.
    const form = new URLSearchParams({ challenge: header, url: TARGET });
    const res = await handleRequest(
      request("/verify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      emptyCorpus(),
      mockCtx(),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/verify?")).toBe(true);
    expect(new URL(location, "https://tools.tx402.io").searchParams.get("challenge")).toBe(header);
  });

  it("a GET never enriches — a link someone clicked is not an opt-in", async () => {
    const res = await handleRequest(
      request(`${query}&enrich=true`, { headers: { accept: "application/json" } }),
      emptyCorpus(),
      mockCtx(),
    );
    const body = await res.json<VerifyEnvelope>();
    expect(body.data.enrichment).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  — the language audit, over the rendered surfaces
// ══════════════════════════════════════════════════════════════════════════

describe("rendered language", () => {
  const FORBIDDEN = ["scam", "fraud", "fraudulent", "unsafe", "dangerous", "malicious"];

  it("no rendered surface uses a word that judges the operator", async () => {
    const challenges = [
      header,
      Buffer.from(
        JSON.stringify({ ...SPEC_V2, resource: { url: "https://elsewhere.example/x" } }),
        "utf8",
      ).toString("base64"),
      "garbage",
    ];

    for (const challenge of challenges) {
      const path = `/verify?challenge=${encodeURIComponent(challenge)}&url=${encodeURIComponent(TARGET)}`;
      for (const accept of ["text/html", "application/json", "text/markdown"]) {
        const res = await handleRequest(
          request(path, { headers: { accept } }),
          emptyCorpus(),
          mockCtx(),
        );
        const text = (await res.text()).toLowerCase();
        for (const word of FORBIDDEN) {
          expect(
            new RegExp(`\\b${word}\\b`).test(text),
            `"${word}" in ${accept} for ${challenge.slice(0, 24)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("says the band describes our observations, not the operator", async () => {
    const res = await handleRequest(
      request(`/verify?challenge=${encodeURIComponent(header)}`),
      emptyCorpus(),
      mockCtx(),
    );
    const html = await res.text();
    expect(html).toContain("not a judgement about whoever operates");
    expect(html).toContain("/methodology");
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe("runVerify", () => {
  it("works with no environment at all, which is how the CLI will call it", async () => {
    // The offline half must not depend on a binding. the CLI imports the same
    // function; this asserts the route's own wrapper does not smuggle a
    // requirement in.
    const outcome = await runVerify(
      {
        challenge: { header },
        context: { url: TARGET, expected_origin: null },
        options: { enrich: false },
      },
      null,
    );
    expect(outcome.data.verdict).toBe("pass");
    expect(outcome.data.enrichment).toBeNull();
  });

  it("says so when enrichment was asked for and no corpus is available", async () => {
    const outcome = await runVerify(
      {
        challenge: { header },
        context: { url: TARGET, expected_origin: null },
        options: { enrich: true },
      },
      null,
    );
    expect(outcome.warnings.some((w) => w.code === "NO_DATA")).toBe(true);
    expect(outcome.data.enrichment).toBeNull();
  });

  it("recomputes the verdict from the merged check list", async () => {
    // The frozen aggregation rule (SPEC §5.2) is applied to what is actually
    // reported, so an enrichment cannot leave a stale verdict behind it.
    const outcome = await runVerify(
      {
        challenge: { header },
        context: { url: TARGET, expected_origin: null },
        options: { enrich: true },
      },
      seededCorpus({
        amount_atomic: "9999",
        pay_to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        scan_count: 12,
        first_seen: "2026-06-01T00:00:00Z",
      }),
    );
    expect(outcome.data.checks.some((c) => c.status === "warn")).toBe(true);
    expect(outcome.data.verdict).toBe("warn");
  });
});
