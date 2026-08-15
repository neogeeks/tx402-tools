import { describe, expect, it } from "vitest";
import {
  BUNDLED_MANIFEST,
  MemorySpendStore,
  PACKAGE_VERSION,
  PolicyEngine,
  decodePaymentRequired,
  isTx402Error,
} from "tx402";

import { handleRequest } from "../worker/router.js";
import { evaluatePolicy } from "../worker/routes/policy.js";
import { PRESETS } from "../ui/pages/policy/presets.js";
import { requestFromUrl, urlFromRequest, challengeToText } from "../ui/pages/policy/permalink.js";
import { pythonSnippet, typescriptSnippet } from "../ui/pages/policy/snippets.js";
import { STAGES } from "../ui/pages/policy/types.js";
import type { PolicyRequest } from "../ui/pages/policy/types.js";
import type { Envelope } from "../worker/types.js";
import { json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";

/**
 * its exit criterion, as a test.
 *
 * The load-bearing claim of the whole tool is that the playground's verdict is
 * the SDK's verdict — so the oracle here is **the SDK, invoked independently**,
 * not a table of expected strings written by the same person who wrote the
 * route. A test that asserts `code === "TX402_POLICY_BUDGET"` only proves the
 * author agreed with themselves; a test that asserts the route and a
 * hand-driven `PolicyEngine` throw the *same object* proves the claim on the
 * page.
 */

const NOW = 1_785_711_360_000;

// ── the oracle: drive the SDK by hand, exactly as a buyer's client would ──

interface SdkOutcome {
  allowed: boolean;
  code: string | null;
  name: string | null;
  details: Record<string, unknown> | null;
  networks: string[];
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fail(error: unknown, networks: string[] = []): SdkOutcome {
  if (!isTx402Error(error)) throw error;
  return { allowed: false, code: error.code, name: error.name, details: { ...error.details }, networks };
}

/**
 * Everything the SDK would do for one playground request, written out longhand.
 *
 * Deliberately does NOT reuse the route's helpers — not its challenge encoding,
 * not its spend-store seeding, not its stage mapping. The ledger is seeded here
 * with the SDK's own `reserve`/`commit` at the same timestamps a real client's
 * history would carry, which is an independent construction of the same
 * scenario rather than a call into the code under test.
 */
async function sdkOutcome(input: PolicyRequest): Promise<SdkOutcome> {
  const body = input.challenge.body;
  const header =
    typeof body === "string" ? base64(body) : body ? base64(JSON.stringify(body)) : (input.challenge.header ?? "");

  const resourceUrl = ((): string => {
    if (input.request?.url) return input.request.url;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))));
    return (decoded as { resource: { url: string } }).resource.url;
  })();

  let paymentRequired;
  try {
    paymentRequired = decodePaymentRequired(header, {
      requestUrl: resourceUrl,
      requestMethod: input.request?.method ?? "GET",
      requestId: "oracle",
      clockEpochMs: NOW,
    });
  } catch (error) {
    return fail(error);
  }

  const { recipientPolicy, routing, ...policy } = input.policy;
  let engine: PolicyEngine;
  try {
    engine = new PolicyEngine(BUNDLED_MANIFEST, policy, routing ?? {}, recipientPolicy ?? {});
  } catch (error) {
    return fail(error);
  }

  const scope = new URL(paymentRequired.resource.url).hostname.toLowerCase();
  const store = new MemorySpendStore();
  const huge = (2n ** 96n).toString();
  const window = BigInt(input.state?.spent_in_window_atomic ?? "0");
  const total = BigInt(input.state?.spent_total_atomic ?? "0");

  // The asset the scenario spends in. Every preset offers USDC, and the engine
  // keys its ledger on `<network>/<standard>:<address>` — read off the decoded
  // challenge rather than recomputed, so a seed lands where the engine looks.
  const seedAssets = [
    ...new Set(
      paymentRequired.requirements.map((r) =>
        r.network.startsWith("eip155:") ? `${r.network}/erc20:${r.asset}` : `${r.network}/token:${r.asset}`,
      ),
    ),
  ];

  const seed = async (assetId: string, amount: bigint, at: number): Promise<void> => {
    if (amount <= 0n) return;
    const { reservation } = await store.reserve({
      requestId: "oracle-seed",
      policyScope: scope,
      requestFingerprint: "oracle-seed",
      assetId,
      amountAtomic: amount.toString(),
      maxPerHourAtomic: huge,
      nowEpochMs: at,
    });
    await store.commit({
      reservationId: reservation.reservationId,
      policyScope: scope,
      assetId,
      committedAtEpochMs: at,
    });
  };

  for (const assetId of seedAssets) {
    await seed(assetId, total > window ? total - window : 0n, NOW - 3_600_000 - 60_000);
    await seed(assetId, window, NOW - 1_000);
  }

  const networks = [...new Set(paymentRequired.requirements.map((r) => r.network))];

  let decision;
  try {
    decision = await engine.evaluate(paymentRequired, {
      requestId: "oracle",
      policyScope: scope,
      nowEpochMs: NOW,
      spendStore: store,
    });
  } catch (error) {
    return fail(error, networks);
  }

  // The cumulative cap lives in `reserve`, which is what a client calls next.
  const chosen = decision.requirements[0];
  if (chosen === undefined) return { allowed: true, code: null, name: null, details: null, networks };
  try {
    await store.reserve({
      requestId: "oracle",
      policyScope: scope,
      requestFingerprint: paymentRequired.headerHash,
      assetId: chosen.assetId,
      amountAtomic: chosen.amountAtomic,
      maxPerHourAtomic: chosen.maxPerHourAtomic,
      ...(chosen.maxTotalAtomic === undefined ? {} : { maxTotalAtomic: chosen.maxTotalAtomic }),
      nowEpochMs: NOW,
    });
  } catch (error) {
    return fail(error, networks);
  }

  return { allowed: true, code: null, name: null, details: null, networks };
}

// ── the route, driven the way a caller drives it ─────────────────────────

type PolicyEnvelope = Envelope<PolicyDataShape>;
interface PolicyDataShape {
  decision: "allow" | "deny";
  selected_requirement: unknown;
  evaluation: { stage: string; result: string; detail: string | null }[];
  error: { name: string; code: string; message: string; details: Record<string, unknown> | null } | null;
  tx402_version: string | null;
  engine: string;
}

async function callApi(input: PolicyRequest): Promise<{ res: Response; body: PolicyEnvelope }> {
  const res = await handleRequest(
    request("/api/v1/policy/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    mockEnv(),
    mockCtx(),
  );
  return { res, body: await json<PolicyEnvelope>(res) };
}

// ── the presets, against the SDK ─────────────────────────────────────────

describe("every preset agrees with the SDK", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: the API's verdict is the SDK's verdict`, async () => {
      const expected = await sdkOutcome(preset.request);
      const outcome = await evaluatePolicy(preset.request, { nowEpochMs: NOW, requestId: "oracle" });
      const data = outcome.data;

      expect(data.decision).toBe(expected.allowed ? "allow" : "deny");

      if (expected.allowed) {
        expect(data.error).toBeNull();
      } else {
        // The exact typed error, not an approximation of it.
        expect(data.error?.name).toBe(expected.name);
        expect(data.error?.code).toBe(expected.code);
        expect(data.error?.details).toEqual(expected.details);
      }
    });
  }
});

describe("the frozen stage vocabulary and order (SPEC §5.3)", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: reports all eight stages, in order`, async () => {
      const { data } = await evaluatePolicy(preset.request, { nowEpochMs: NOW });
      expect(data.evaluation.map((s) => s.stage)).toEqual([...STAGES]);
      for (const step of data.evaluation) expect(["pass", "fail", "skip"]).toContain(step.result);
    });

    it(`${preset.id}: nothing after the first failure claims to have run`, async () => {
      const { data } = await evaluatePolicy(preset.request, { nowEpochMs: NOW });
      const firstFail = data.evaluation.findIndex((s) => s.result === "fail");
      if (firstFail === -1) return;
      for (const step of data.evaluation.slice(firstFail + 1)) {
        expect(step.result).toBe("skip");
      }
      expect(data.evaluation.filter((s) => s.result === "fail")).toHaveLength(1);
    });
  }

  it("each preset trips the stage it was written to demonstrate", async () => {
    const actual: Record<string, string> = {};
    for (const preset of PRESETS) {
      const { data } = await evaluatePolicy(preset.request, { nowEpochMs: NOW });
      const failing = data.evaluation.find((s) => s.result === "fail");
      actual[preset.id] =
        data.decision === "allow" ? "allow" : (failing?.stage ?? "config");
    }
    const expected = Object.fromEntries(PRESETS.map((p) => [p.id, p.stage]));
    expect(actual).toEqual(expected);
  });

  it("a decode failure reaches no stage at all", async () => {
    const { data } = await evaluatePolicy(
      { policy: { maxPerRequest: "0.10 USDC" }, challenge: { body: "{not json" } },
      { nowEpochMs: NOW },
    );
    expect(data.decision).toBe("deny");
    expect(data.evaluation.every((s) => s.result === "skip")).toBe(true);
    expect(data.error?.name).toBe("InvalidPaymentRequiredError");
  });
});

// ── the frozen response contract ─────────────────────────────────────────

describe("the response contract", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: the request validates against policy-request.json`, () => {
      const result = validateAgainst("policy-request", preset.request);
      expect(result.errors).toBe("");
      expect(result.ok).toBe(true);
    });

    it(`${preset.id}: the response validates against policy.json`, async () => {
      const { res, body } = await callApi(preset.request);
      expect(res.status).toBe(200);
      const result = validateAgainst("policy", body);
      expect(result.errors).toBe("");
      expect(result.ok).toBe(true);
    });
  }

  it("stamps the tx402 version that actually evaluated the request", async () => {
    const { body } = await callApi(PRESETS[0]!.request);
    expect(body.data.tx402_version).toBe(PACKAGE_VERSION);
    expect(body.meta.tx402_version).toBe(PACKAGE_VERSION);
    expect(body.data.engine).toBe("PolicyEngine");
    // The route is no longer a stub, and says so.
    expect(body.meta.implemented).toBe(true);
    expect(body.warnings.some((w) => w.code === "NOT_IMPLEMENTED")).toBe(false);
  });

  it("refuses a body with no policy or challenge", async () => {
    const res = await handleRequest(
      request("/api/v1/policy/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: {} }),
      }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a body that is not JSON", async () => {
    const res = await handleRequest(
      request("/api/v1/policy/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{{{",
      }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.status).toBe(400);
  });
});

// ── the permalink ────────────────────────────────────────────────────────

describe("the permalink round-trips (no storage, no account)", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: url → request → url is stable`, () => {
      const url = new URL(`https://tools.tx402.io${urlFromRequest(preset.request)}`);
      const { request: parsed } = requestFromUrl(url);

      expect(parsed.policy).toEqual(preset.request.policy);
      expect(challengeToText(parsed.challenge)).toBe(challengeToText(preset.request.challenge));
      expect(parsed.state?.spent_in_window_atomic).toBe(preset.request.state?.spent_in_window_atomic ?? "0");
      expect(parsed.state?.spent_total_atomic).toBe(preset.request.state?.spent_total_atomic ?? "0");
    });

    it(`${preset.id}: a shared link produces the same verdict`, async () => {
      const url = new URL(`https://tools.tx402.io${urlFromRequest(preset.request)}`);
      const direct = await evaluatePolicy(preset.request, { nowEpochMs: NOW });
      const shared = await evaluatePolicy(requestFromUrl(url).request, { nowEpochMs: NOW });
      expect(shared.data.decision).toBe(direct.data.decision);
      expect(shared.data.error?.code).toBe(direct.data.error?.code);
      expect(shared.data.evaluation).toEqual(direct.data.evaluation);
    });
  }

  it("?preset=<id> loads that preset", () => {
    const { request: parsed, presetId } = requestFromUrl(new URL("https://tools.tx402.io/policy?preset=fleet"));
    expect(presetId).toBe("fleet");
    expect(parsed.policy.maxTotal).toBe("50.00 USDC");
  });

  it("a single parameter overrides the preset it names", () => {
    const { request: parsed } = requestFromUrl(
      new URL("https://tools.tx402.io/policy?preset=fleet&max_per_hour=9.00+USDC"),
    );
    expect(parsed.policy.maxPerHour).toBe("9.00 USDC");
    expect(parsed.policy.maxTotal).toBe("50.00 USDC");
  });

  it("an empty page loads the default preset rather than nothing", () => {
    const { presetId } = requestFromUrl(new URL("https://tools.tx402.io/policy"));
    expect(presetId).toBe("default");
  });

  it("a submitted form redirects to its own permalink", async () => {
    const form = new URLSearchParams({
      max_per_request: "0.01 USDC",
      max_per_hour: "5.00 USDC",
      domains: "api.example.com",
      networks: "eip155:8453",
      challenge: JSON.stringify(PRESETS[0]!.request.challenge.body),
      spent_window: "0",
      spent_total: "0",
    });
    const res = await handleRequest(
      request("/policy", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/policy?")).toBe(true);
    const { request: parsed } = requestFromUrl(new URL(`https://tools.tx402.io${location}`));
    expect(parsed.policy.maxPerRequest).toBe("0.01 USDC");
  });
});

// ── the three representations ──────────────────────────────

describe("content negotiation", () => {
  it("serves JSON, Markdown and HTML from one evaluation", async () => {
    const paths = "/policy?preset=per-request";
    const asJson = await handleRequest(request(paths, { headers: { accept: "application/json" } }), mockEnv(), mockCtx());
    const asMd = await handleRequest(request(paths, { headers: { accept: "text/markdown" } }), mockEnv(), mockCtx());
    const asHtml = await handleRequest(request(paths, { headers: { accept: "text/html" } }), mockEnv(), mockCtx());

    expect(asJson.headers.get("content-type")).toContain("application/json");
    expect(asMd.headers.get("content-type")).toContain("text/markdown");
    expect(asHtml.headers.get("content-type")).toContain("text/html");

    const body = await json<PolicyEnvelope>(asJson);
    expect(validateAgainst("policy", body).ok).toBe(true);

    const md = await asMd.text();
    const html = await asHtml.text();

    // The same verdict, and the same firing rule, in all three.
    expect(body.data.error?.code).toBe("TX402_POLICY_BUDGET");
    expect(md).toContain("TX402_POLICY_BUDGET");
    expect(html).toContain("TX402_POLICY_BUDGET");

    // The ladder is in the Markdown mirror too, in order.
    for (const stage of STAGES) expect(md).toContain(`\`${stage}\``);
    expect(md.indexOf("`domain`")).toBeLessThan(md.indexOf("`routing`"));
  });

  it("the HTML page renders all eight stages and the real version", async () => {
    const res = await handleRequest(request("/policy?preset=fleet"), mockEnv(), mockCtx());
    const html = await res.text();
    expect(html).toContain("This is the real engine.");
    expect(html).toContain(PACKAGE_VERSION);
    expect(html).toContain("https://docs.tx402.io/guides/policy/");
    expect((html.match(/class="stg /gu) ?? []).length).toBe(STAGES.length);
  });

  it("escapes attacker-controlled challenge text", async () => {
    const hostile = `<script>alert('xss')</script>`;
    const res = await handleRequest(
      request(`/policy?challenge=${encodeURIComponent(hostile)}&domains=${encodeURIComponent(hostile)}`),
      mockEnv(),
      mockCtx(),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── copy-as-code ─────────────────────────────────────────────────────────

describe("copy the config as working code", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: the TypeScript snippet's policy is the policy that was evaluated`, () => {
      const snippet = typescriptSnippet(preset.request);

      // Evaluate the object literal the snippet actually contains, rather than
      // matching strings: it proves the snippet parses AND carries the same
      // configuration, which is the thing a reader is going to paste.
      const start = snippet.indexOf("createTx402Client({");
      const literal = snippet.slice(start + "createTx402Client(".length, snippet.lastIndexOf("});") + 1);
      // Evaluating generated source is the point of this test: it proves the
      // snippet PARSES and carries the same configuration, which string
      // matching cannot. The input is this repository's own codegen over its
      // own presets, not anything a request can reach.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const built = new Function("signers", `return ${literal}`)({}) as {
        policy: Record<string, unknown>;
        recipientPolicy?: unknown;
        routing?: unknown;
      };

      const { recipientPolicy, routing, ...policy } = preset.request.policy;
      expect(built.policy).toEqual(policy);
      if (recipientPolicy?.mode !== undefined && recipientPolicy.mode !== "off") {
        expect(built.recipientPolicy).toEqual(recipientPolicy);
      }
      if (routing?.preferNetworks?.length || routing?.maxQuoteAgeMs !== undefined) {
        expect(built.routing).toEqual(routing);
      }
    });

    it(`${preset.id}: the snippet's policy behaves identically in the SDK`, async () => {
      const snippet = typescriptSnippet(preset.request);
      const start = snippet.indexOf("createTx402Client({");
      const literal = snippet.slice(start + "createTx402Client(".length, snippet.lastIndexOf("});") + 1);
      // Evaluating generated source is the point of this test: it proves the
      // snippet PARSES and carries the same configuration, which string
      // matching cannot. The input is this repository's own codegen over its
      // own presets, not anything a request can reach.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const built = new Function("signers", `return ${literal}`)({}) as {
        policy: PolicyRequest["policy"];
        recipientPolicy?: PolicyRequest["policy"]["recipientPolicy"];
        routing?: PolicyRequest["policy"]["routing"];
      };

      const rebuilt: PolicyRequest = {
        ...preset.request,
        policy: {
          ...built.policy,
          ...(built.recipientPolicy ? { recipientPolicy: built.recipientPolicy } : {}),
          ...(built.routing ? { routing: built.routing } : {}),
        },
      };

      const original = await evaluatePolicy(preset.request, { nowEpochMs: NOW });
      const fromSnippet = await evaluatePolicy(rebuilt, { nowEpochMs: NOW });
      expect(fromSnippet.data.decision).toBe(original.data.decision);
      expect(fromSnippet.data.error?.code).toBe(original.data.error?.code);
      expect(fromSnippet.data.evaluation).toEqual(original.data.evaluation);
    });

    it(`${preset.id}: the Python snippet uses the documented constructors`, () => {
      const snippet = pythonSnippet(preset.request);
      expect(snippet).toMatch(/^from tx402 import Tx402Client, Policy/mu);
      expect(snippet).toContain("tx402 = Tx402Client(");
      expect(snippet).toContain("policy=Policy(");
      // snake_case throughout — a camelCase key here is a snippet that raises
      // TypeError on the reader's first run.
      expect(snippet).not.toMatch(/\b(maxPerRequest|maxPerHour|maxTotal|allowedDomains|allowedNetworks)\b/u);
      if (preset.request.policy.maxPerRequest !== undefined) {
        expect(snippet).toContain(`max_per_request=${JSON.stringify(preset.request.policy.maxPerRequest)}`);
      }
      if (preset.request.policy.maxTotal !== undefined) {
        expect(snippet).toContain(`max_total=${JSON.stringify(preset.request.policy.maxTotal)}`);
      }
    });
  }

  it("neither snippet configures a signer", () => {
    for (const preset of PRESETS) {
      expect(typescriptSnippet(preset.request)).not.toMatch(/signers\s*:\s*\{/u);
      expect(pythonSnippet(preset.request)).not.toMatch(/private[_-]?key/iu);
    }
  });
});

// ── the hypothetical ledger is the SDK's ledger ──────────────────────────

describe("the spend state is replayed through the real ledger", () => {
  it("spend outside the rolling hour still counts against maxTotal", async () => {
    const base = PRESETS.find((p) => p.id === "cumulative");
    expect(base).toBeDefined();
    const { data } = await evaluatePolicy(base!.request, { nowEpochMs: NOW });

    // Nothing was spent in the last hour, so the hourly cap passes …
    const hourly = data.evaluation.find((s) => s.stage === "rolling_hour");
    expect(hourly?.result).toBe("pass");
    // … and the lifetime ceiling is still what refuses it.
    expect(data.evaluation.find((s) => s.stage === "total")?.result).toBe("fail");
    expect(data.error?.details?.capKind).toBe("cumulative");
  });

  it("with no maxTotal there is no cumulative stage to fail", async () => {
    const input: PolicyRequest = {
      ...PRESETS.find((p) => p.id === "cumulative")!.request,
      policy: {
        ...PRESETS.find((p) => p.id === "cumulative")!.request.policy,
        maxTotal: undefined,
      },
    };
    const { data } = await evaluatePolicy(input, { nowEpochMs: NOW });
    expect(data.decision).toBe("allow");
    expect(data.evaluation.find((s) => s.stage === "total")?.result).toBe("skip");
  });
});
