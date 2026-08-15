/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  DO NOT DELETE `verify_challenge makes zero network calls`.              │
 * │                                                                          │
 * │  It is `test/verify-offline.test.ts`'s banner, one layer up. That file │
 * │  proves the *library* sends nothing; this one proves the **MCP tool**    │
 * │  built on it sends nothing, which is a different claim and the one an │
 * │  operator is actually installing. the offline/hosted split │
 * │  is the product, not an optimisation — an agent asks this question with │
 * │  a challenge it is about to sign in hand, and shipping that challenge to │
 * │  a third party to find out whether it parses would be a strange thing to │
 * │  ask of anyone.                                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Everything here drives `Server.handle` — the same function the stdio
 * transport calls for every line it reads — rather than a parallel harness, so
 * a `tools/list` that passes here is the `tools/list` a client receives.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BAND_FRAMING,
  HostedClient,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  Server,
  TOOLS,
  TOOL_NAMES,
  baseUrlFromEnv,
  forbiddenTermsIn,
  handleLine,
  serve,
  type FetchLike,
  type JsonRpcResponse,
} from "../packages/tools-mcp/src/index.js";
import { workerConnector } from "../worker/lib/guard.js";
import { validateAgainst } from "./helpers.js";

// ── fixtures ──────────────────────────────────────────────────────────────

const fixtures = join(process.cwd(), "spec", "fixtures");
const read = (rel: string): string => readFileSync(join(fixtures, rel), "utf8");

const INSPECT_FULL = JSON.parse(read("responses/inspect-full.json")) as Record<string, unknown>;
const INSPECT_EMPTY = JSON.parse(read("responses/inspect-empty.json")) as Record<string, unknown>;

const TARGET = "https://api.example.com/v1/geocode";

/**
 * The one genuinely spec-shaped x402 v2 challenge in the repo.
 *
 * `challenges/v2-header-valid.txt` is deliberately *not* one — it declares version 2 and then uses
 * the v1 layout, which the strict decoder refuses. Both are exercised below: the frozen fixture for
 * the interoperability bug it actually is, and this for a clean pass.
 */
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

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

// ── driving the server the way a client does ──────────────────────────────

interface ToolCallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let nextId = 1;

async function rpc(server: Server, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const response = await server.handle({ jsonrpc: "2.0", id: nextId++, method, params });
  if (!response) throw new Error(`${method} produced no response`);
  return response;
}

async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await rpc(server, "tools/call", { name, arguments: args });
  expect(response.error, JSON.stringify(response.error)).toBeUndefined();
  return response.result as ToolCallResult;
}

function textOf(result: ToolCallResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/**
 * A `fetch` that answers from a script and records every URL it was given.
 *
 * The seam is `HostedClient`'s injected `fetch`, not a global patch, because a
 * global patch would also silence the zero-network traps below — and those are
 * the point of half this file.
 */
function stubFetch(
  respond: (url: string) => { status: number; body: unknown } | Promise<never>,
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(input);
    const answer = await respond(input);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, urls };
}

function serverWith(fetch: FetchLike): Server {
  return new Server({ client: new HostedClient({ baseUrl: "https://tools.tx402.io", fetch }) });
}

/** A server whose hosted client would throw if it were ever used. */
function offlineOnlyServer(): Server {
  return new Server({
    client: new HostedClient({
      fetch: () => {
        throw new Error("the hosted client was used by a tool that must not use it");
      },
    }),
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  Protocol — what a client sees before it sees a tool
// ══════════════════════════════════════════════════════════════════════════

describe("MCP protocol", () => {
  it("initialize echoes a protocol version it speaks and names the server", async () => {
    const server = offlineOnlyServer();
    const response = await rpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });

    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string; version: string };
      instructions: string;
    };

    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe(SERVER_NAME);
    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("initialize answers with its own version when the client asks for one we do not speak", async () => {
    const response = await rpc(offlineOnlyServer(), "initialize", { protocolVersion: "1999-01-01" });
    const result = response.result as { protocolVersion: string };
    // Guessing agreement is how an MCP session hangs. Answer with ours and let
    // the client decide.
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("still initializes when the client sends an older protocol version", async () => {
    const response = await rpc(offlineOnlyServer(), "initialize", { protocolVersion: "2024-11-05" });
    expect((response.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("answers ping", async () => {
    const response = await rpc(offlineOnlyServer(), "ping");
    expect(response.result).toEqual({});
  });

  it("returns nothing for a notification", async () => {
    // A response to a notification is a protocol violation some clients tolerate
    // and some do not.
    const server = offlineOnlyServer();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
  });

  it("reports an unknown method as a JSON-RPC error, not as a tool answer", async () => {
    const response = await rpc(offlineOnlyServer(), "resources/list");
    expect(response.error?.code).toBe(-32601);
    expect(response.result).toBeUndefined();
  });

  it("reports an unparseable line with a null id so a client can resynchronise", async () => {
    const response = await handleLine(offlineOnlyServer(), "{not json");
    expect(response?.error?.code).toBe(-32700);
    expect(response?.id).toBeNull();
  });

  it("an unknown tool name is a tool error, not a protocol error", async () => {
    // A model that guessed a name has to be able to read the correction. A
    // JSON-RPC error is handled by the client and may never reach it.
    const result = await callTool(offlineOnlyServer(), "inspect_challenge", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("inspect_endpoint");
    expect(textOf(result)).toContain("verify_challenge");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  tools/list — the frozen surface
// ══════════════════════════════════════════════════════════════════════════

describe("tools/list", () => {
  it("offers exactly two tools, and no others", async () => {
    const response = await rpc(offlineOnlyServer(), "tools/list");
    const tools = (response.result as { tools: { name: string }[] }).tools;
    // and §9.2 freeze the names. A third tool here is scope that was
    // taken rather than argued for.
    expect(tools.map((t) => t.name)).toEqual(["inspect_endpoint", "verify_challenge"]);
    expect(TOOL_NAMES).toEqual(["inspect_endpoint", "verify_challenge"]);
  });

  it("pins each input schema", async () => {
    const response = await rpc(offlineOnlyServer(), "tools/list");
    const tools = (response.result as { tools: typeof TOOLS }).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    const inspect = byName.get("inspect_endpoint");
    expect(inspect?.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(inspect?.inputSchema.properties ?? {})).toEqual(["url"]);
    expect(inspect?.inputSchema.additionalProperties).toBe(false);

    const verify = byName.get("verify_challenge");
    expect(verify?.inputSchema.required).toEqual(["challenge"]);
    expect(Object.keys(verify?.inputSchema.properties ?? {})).toEqual(["challenge", "url"]);
    expect(verify?.inputSchema.additionalProperties).toBe(false);
  });

  it("declares both tools read-only and non-destructive, and only one of them open-world", async () => {
    const response = await rpc(offlineOnlyServer(), "tools/list");
    const tools = (response.result as { tools: typeof TOOLS }).tools;
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
    // The honest difference between them: one reaches a service, the other cannot.
    expect(tools.find((t) => t.name === "inspect_endpoint")?.annotations.openWorldHint).toBe(true);
    expect(tools.find((t) => t.name === "verify_challenge")?.annotations.openWorldHint).toBe(false);
  });

  it("says out loud, in the server's own description, that it cannot pay", async () => {
    // and requirement 5 of this change: an agent's operator should
    // be able to see that the tool they just installed reads challenges and
    // cannot spend.
    expect(SERVER_INSTRUCTIONS).toMatch(/holds no keys/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/cannot pay/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/no signer/iu);
    // And that there is nothing to sign in to — Watch and accounts were cut in
    // wave 3, so no credential exists to be asked for.
    expect(SERVER_INSTRUCTIONS).toMatch(/no account, no API key and no token/iu);
  });

  it("tells the reader how to read a skip and an unobserved signal, before the first call", async () => {
    // A model decides how much to trust a tool from its description, before it
    // has seen a single result. decision 5 has to arrive there.
    for (const tool of TOOLS) {
      expect(tool.description).toMatch(/SKIP could not run/u);
      expect(tool.description).toContain(BAND_FRAMING);
    }
    expect(
      TOOLS.find((t) => t.name === "inspect_endpoint")?.description,
    ).toMatch(/not observed is something we could not determine/u);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  verify_challenge — local, and provably so
// ══════════════════════════════════════════════════════════════════════════

describe("verify_challenge sends nothing", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const calls: string[] = [];

  const trap =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push(`${name}(${args.map((a) => String(a)).slice(0, 1).join("")})`);
      throw new Error(
        `The offline boundary was violated: verify_challenge called ${name}(). ` +
          "See the banner at the top of this file.",
      );
    };

  const TRAPPED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
  let savedSendBeacon: unknown;

  beforeEach(() => {
    calls.length = 0;
    for (const name of TRAPPED) {
      saved.set(name, globals[name]);
      globals[name] = trap(name);
    }
    const nav = globals.navigator as Record<string, unknown> | undefined;
    if (nav) {
      savedSendBeacon = nav.sendBeacon;
      nav.sendBeacon = trap("navigator.sendBeacon");
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete globals[name];
      else globals[name] = value;
    }
    saved.clear();
    const nav = globals.navigator as Record<string, unknown> | undefined;
    if (nav) {
      if (savedSendBeacon === undefined) delete nav.sendBeacon;
      else nav.sendBeacon = savedSendBeacon;
    }
  });

  it("verify_challenge makes zero network calls", async () => {
    // Every shape a caller can hand the tool, including the ones that fail — a
    // tool that phoned home only on the error path would still break L4.
    const server = offlineOnlyServer();
    const inputs: Record<string, unknown>[] = [
      { challenge: b64(SPEC_V2), url: TARGET },
      { challenge: b64(SPEC_V2) },
      { challenge: read("challenges/v1-body-valid.json") },
      { challenge: read("challenges/v2-header-valid.txt").trim(), url: TARGET },
      { challenge: read("challenges/v2-dynamic-payto.txt").trim(), url: TARGET },
      { challenge: read("challenges/malformed-not-json.txt").trim() },
      { challenge: read("hostile/bad-base64.txt").trim() },
      { challenge: read("hostile/duplicate-keys.txt").trim() },
      { challenge: read("hostile/oversized.json") },
      { challenge: read("hostile/origin-mismatch.json"), url: TARGET },
      { challenge: read("hostile/non-atomic-amount.json") },
      { challenge: read("hostile/negative-amount.json") },
      { challenge: read("hostile/too-many-requirements.json") },
      { challenge: read("hostile/deep-nested.json") },
      { challenge: "not a challenge at all" },
      { challenge: "   " },
      {},
    ];

    for (const args of inputs) {
      await callTool(server, "verify_challenge", args);
    }

    expect(calls, `outbound calls attempted: ${calls.join(", ")}`).toEqual([]);
  });

  it("does not reach the guard's Connector, the seam every outbound request uses", async () => {
    const original = workerConnector.fetch.bind(workerConnector);
    let reached = 0;
    (workerConnector as { fetch: unknown }).fetch = (): never => {
      reached += 1;
      throw new Error("The offline boundary was violated: verify_challenge used the guard's Connector.");
    };

    try {
      const server = offlineOnlyServer();
      await callTool(server, "verify_challenge", { challenge: b64(SPEC_V2), url: TARGET });
      await callTool(server, "verify_challenge", {
        challenge: read("challenges/v1-body-valid.json"),
      });
    } finally {
      (workerConnector as { fetch: unknown }).fetch = original;
    }

    expect(reached).toBe(0);
  });

  it("produces a real verdict while the network is trapped", async () => {
    // Guards the guard: a suite that trapped everything and verified nothing
    // would pass forever, including after the tool stopped working.
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: b64(SPEC_V2),
      url: TARGET,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe("pass");
    expect(textOf(result)).toContain("Verdict: PASS");
    expect(calls).toEqual([]);
  });
});

describe("verify_challenge", () => {
  it("validates its own answer against the frozen verify contract", async () => {
    // makes spec/schemas/ the contract every surface validates
    // against. This surface validates in production too — `runVerifyChallenge`
    // discards a result that does not match — so a passing call is a call whose
    // structured answer already satisfied `verify.json`'s `data`.
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: b64(SPEC_V2),
      url: TARGET,
    });
    expect(result.isError).toBe(false);

    // And again, independently, through the suite's own ajv — a self-check that
    // only ever asks itself is not a check.
    const envelope = {
      api_version: "v1",
      tool: "verify",
      generated_at: "2026-08-15T00:00:00Z",
      meta: { implemented: true, cached: false },
      warnings: [],
      data: result.structuredContent,
    };
    const check = validateAgainst("verify", envelope);
    expect(check.ok, check.errors).toBe(true);
  });

  it("reports the three corpus checks as skip, never as pass, and says where to run them", async () => {
    //. decision 5. An agent will act on the difference.
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: b64(SPEC_V2),
      url: TARGET,
    });
    const checks = result.structuredContent?.checks as { id: string; status: string }[];
    for (const id of ["amount_within_observed_range", "recipient_matches_observed", "endpoint_known"]) {
      const check = checks.find((c) => c.id === id);
      expect(check?.status, id).toBe("skip");
    }
    const text = textOf(result);
    // Four, not three: `facilitator_known` also skips when a challenge names no
    // facilitator, which most do not. The count is
    // asserted loosely on purpose — the fixed claim is that these three ids are
    // `skip`, not how many other checks happen to be.
    expect(text).toMatch(/Checks that could not run \(\d+\)/u);
    expect(text).toContain("inspect_endpoint");
  });

  it("keeps skipped checks out of the section that says checks ran", async () => {
    // A model summarising "23 checks, 20 passed" from one mixed list is exactly
    // the failure decision 5 warns about. Section headings make it impossible.
    const text = textOf(
      await callTool(offlineOnlyServer(), "verify_challenge", { challenge: b64(SPEC_V2) }),
    );
    const ran = text.slice(text.indexOf("Checks that ran"), text.indexOf("Checks that could not run"));
    expect(ran).not.toContain("SKIP");
    expect(text).toMatch(/could not run\./u);
  });

  it("without a url, resource_origin_match skips rather than passes", async () => {
    // SPEC §5.2: we cannot compare an origin we were not given.
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: b64(SPEC_V2),
    });
    const checks = result.structuredContent?.checks as { id: string; status: string }[];
    expect(checks.find((c) => c.id === "resource_origin_match")?.status).toBe("skip");
    expect(textOf(result)).toContain("pass `url` to check it");
  });

  it("agrees with the library it imports, rather than reimplementing §5.2.1", async () => {
    // SPEC §5.2 requires the CLI and the API to agree bit for bit, and importing
    // its verifier is the only way that can hold. This asserts the tool did not
    // quietly filter, reorder or re-derive anything on the way out.
    const { verifyOffline } = await import("../packages/tools-cli/src/verify-offline.js");
    const direct = await verifyOffline(
      { raw: read("challenges/v2-header-valid.txt").trim() },
      { context: { url: TARGET } },
    );
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: read("challenges/v2-header-valid.txt").trim(),
      url: TARGET,
    });

    expect(result.structuredContent?.verdict).toBe(direct.verdict);
    expect(result.structuredContent?.checks).toEqual(direct.checks);
    expect(result.structuredContent?.signals).toEqual(direct.signals);
  });

  it("renders the frozen hostile fixtures as findings rather than as failures of ours", async () => {
    const server = offlineOnlyServer();
    const cases: [string, string][] = [
      ["hostile/non-atomic-amount.json", "amount_atomic_canonical"],
      ["hostile/negative-amount.json", "amount_positive"],
      ["hostile/too-many-requirements.json", "accepts_within_limit"],
      ["hostile/origin-mismatch.json", "resource_origin_match"],
    ];

    for (const [file, expectedFailingCheck] of cases) {
      const result = await callTool(server, "verify_challenge", {
        challenge: read(file),
        url: TARGET,
      });
      // A broken challenge is the answer the caller came for, not an error.
      expect(result.isError, file).toBe(false);
      expect(result.structuredContent?.verdict, file).toBe("fail");
      const checks = result.structuredContent?.checks as { id: string; status: string }[];
      expect(checks.find((c) => c.id === expectedFailingCheck)?.status, file).toBe("fail");
    }
  });

  it("reports a challenge that is not base64 without inventing a verdict about it", async () => {
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: read("hostile/bad-base64.txt").trim(),
    });
    expect(result.isError).toBe(false);
    const checks = result.structuredContent?.checks as { id: string; status: string }[];
    expect(checks.find((c) => c.id === "base64_strict")?.status).toBe("fail");
  });

  it("names a declared-dynamic recipient as the marketplace pattern it is", async () => {
    // SPEC §6.4's carve-out. Treating a role constant as a malformed address is
    // the crying-wolf failure exists to prevent.
    const dynamic = {
      ...SPEC_V2,
      accepts: [{ ...SPEC_V2.accepts[0], payTo: "dynamic" }],
    };
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {
      challenge: b64(dynamic),
      url: TARGET,
    });
    const checks = result.structuredContent?.checks as { id: string; status: string }[];
    expect(checks.find((c) => c.id === "pay_to_wellformed")?.status).toBe("pass");
    expect(textOf(result)).toContain("declared dynamic");
  });

  it("asks for the challenge rather than guessing when none was supplied", async () => {
    const result = await callTool(offlineOnlyServer(), "verify_challenge", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No challenge was supplied");
    expect(result.structuredContent).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  inspect_endpoint — against a stubbed transport
// ══════════════════════════════════════════════════════════════════════════

describe("inspect_endpoint", () => {
  it("asks the hosted API for the JSON representation of the frozen route", async () => {
    const { fetch, urls } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      `https://tools.tx402.io/api/v1/inspect?url=${encodeURIComponent(TARGET)}`,
    );
    expect(result.isError).toBe(false);
  });

  it("renders the frozen inspect fixture with its terms, its band and its empty history", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));

    expect(text).toContain("1000 atomic = 0.001000 USDC");
    expect(text).toContain("eip155:8453");
    expect(text).toContain("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
    expect(text).toContain("band LOW");
    // SPEC §5.1 / no history is a correct answer for a new
    // endpoint, and the report has to say so in words.
    expect(text).toContain("No history yet");
    expect(text).toMatch(/normal state for a new endpoint/u);
  });

  it("says one scan is not a history, even when has_history says otherwise", async () => {
    // Observed against a live `wrangler dev` while verifying this change: the
    // hosted route writes the corpus row before it reads it back, so an
    // endpoint's very first scan comes back `has_history: true` with
    // `scan_count: 1`, `availability_30d: null` and the corpus-dependent checks
    // reporting `skip / no_history`. A model reading one field and stopping
    // would conclude we have observed this endpoint before. Recorded for the
    // wave-4 integrator.; defended against here.
    const firstScan = structuredClone(INSPECT_FULL) as {
      data: { observed: Record<string, unknown> };
    };
    firstScan.data.observed = {
      has_history: true,
      first_seen: "2026-08-15T07:22:32Z",
      last_seen: "2026-08-15T07:22:32Z",
      scan_count: 1,
      availability_30d: null,
      latency_p50_ms: null,
      recent_changes: [],
    };

    const { fetch } = stubFetch(() => ({ status: 200, body: firstScan }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));
    expect(text).toContain("first recorded observation of this endpoint");
    expect(text).toMatch(/nothing yet to compare/u);
  });

  it("renders an endpoint we have observed before, changes included", async () => {
    const withHistory = structuredClone(INSPECT_FULL) as {
      warnings: unknown[];
      data: { observed: Record<string, unknown> };
    };
    withHistory.warnings = [];
    withHistory.data.observed = {
      has_history: true,
      first_seen: "2026-05-02T10:00:00Z",
      last_seen: "2026-08-14T09:41:05Z",
      scan_count: 122,
      availability_30d: 0.9994,
      latency_p50_ms: 180,
      recent_changes: [
        {
          id: "01JABC",
          changed_at: "2026-07-21T14:02:11Z",
          change_kind: "recipient",
          field: "pay_to",
          old_value: "0xabc",
          new_value: "0xdef",
          detected_by: "crawler",
        },
      ],
    };

    const { fetch } = stubFetch(() => ({ status: 200, body: withHistory }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));

    // own example of the register this product writes in.
    expect(text).toContain("recipient changed on 2026-07-21");
    expect(text).toContain("99.94%");
  });

  it("renders the honest empty state without claiming anything about the endpoint", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: INSPECT_EMPTY }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });
    expect(result.isError).toBe(false);
    expect(forbiddenTermsIn(textOf(result))).toEqual([]);
  });

  it("marks a stub route as a stub instead of passing its empty data off as an observation", async () => {
    const stubbed = structuredClone(INSPECT_FULL) as { meta: Record<string, unknown> };
    stubbed.meta.implemented = false;
    const { fetch } = stubFetch(() => ({ status: 200, body: stubbed }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));
    expect(text).toContain("meta.implemented: false");
    expect(text).toMatch(/Do not read it as a finding about this endpoint\./u);
  });

  it("renders warnings as facts about completeness, not as findings", async () => {
    // SPEC §2. `NO_HISTORY` reaching a model as a finding is a wrong answer.
    const { fetch } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));
    expect(text).toContain("these are not findings");
    expect(text).toContain("NO_HISTORY");
  });
});

describe("inspect_endpoint — the answers that look like failures and are not", () => {
  // SPEC §3.1: three codes deliberately return HTTP 200. An endpoint being
  // broken is the answer the caller came for. Surfacing them as transport
  // failures would be exactly backwards.
  const findings: [string, string][] = [
    ["NOT_X402", "not with an x402 payment challenge"],
    ["CHALLENGE_MALFORMED", "could not be parsed"],
    ["NO_DATA", "no observations of this endpoint"],
  ];

  for (const [code, phrase] of findings) {
    it(`${code} at HTTP 200 is a finding, not an error`, async () => {
      const { fetch } = stubFetch(() => ({
        status: 200,
        body: {
          api_version: "v1",
          generated_at: "2026-08-15T00:00:00Z",
          error: {
            code,
            message: "The endpoint answered and there is no x402 challenge to report.",
            retryable: false,
          },
        },
      }));

      const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });
      expect(result.isError, code).toBe(false);
      expect(textOf(result)).toContain(phrase);
      expect(result.structuredContent?.code).toBe(code);
    });
  }
});

describe("inspect_endpoint — degrading to 'could not ask'", () => {
  it("a transport failure is an error that says we do not know, never a verdict", async () => {
    //. and both set this precedent. It matters most here: the
    // reader is deciding whether to spend money.
    const fetch: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Could not ask");
    expect(text).toMatch(/nothing is known about this endpoint from this call/u);
    expect(text).toMatch(/not a finding about the endpoint/u);
    // Never a fabricated answer.
    expect(text).not.toMatch(/\bband (LOW|MEDIUM|HIGH)\b/u);
    expect(result.structuredContent).toBeUndefined();
  });

  it("a timeout says so, and says nothing else", async () => {
    const fetch: FetchLike = () =>
      Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const text = textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET }));
    expect(text).toMatch(/did not complete within \d+s/u);
  });

  it("a body that is not JSON is an unreachable service, not an empty answer", async () => {
    const fetch: FetchLike = async () =>
      new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } });
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not JSON");
  });

  it("a rate limit is reported as a refusal that may be retried", async () => {
    const { fetch } = stubFetch(() => ({
      status: 429,
      body: {
        api_version: "v1",
        generated_at: "2026-08-15T00:00:00Z",
        error: {
          code: "TARGET_RATE_LIMITED",
          message: "This endpoint is over its politeness budget.",
          retryable: true,
        },
      },
    }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("retrying may work");
    expect(textOf(result)).toContain("TARGET_RATE_LIMITED");
  });
});

describe("inspect_endpoint — a response that does not validate is discarded", () => {
  it("refuses to forward a payload that fails spec/schemas/inspect.json", async () => {
    // The one place in the suite where a malformed answer is not a rendering
    // bug: an agent may act on it and pay something.
    const broken = structuredClone(INSPECT_FULL) as { data: { terms: Record<string, unknown> } };
    broken.data.terms.amount_atomic = 1000; // a number, not the atomic string

    const { fetch } = stubFetch(() => ({ status: 200, body: broken }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("does not match the frozen inspect contract");
    expect(text).toMatch(/discarded rather than reported/u);
    // The amount that failed validation must not have leaked into the answer.
    expect(result.structuredContent).toBeUndefined();
    expect(text).not.toContain("band LOW");
  });

  it("refuses an error envelope that does not validate either", async () => {
    const { fetch } = stubFetch(() => ({
      status: 500,
      body: { api_version: "v1", generated_at: "2026-08-15T00:00:00Z", error: { code: "NOPE" } },
    }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("frozen error contract");
  });

  it("the fixture it does accept is one schema:check already validates", () => {
    // Keeps this file honest about what "valid" means: the same ajv, the same
    // frozen schema, the same fixture the repo already ships.
    expect(validateAgainst("inspect", INSPECT_FULL).ok).toBe(true);
    expect(validateAgainst("inspect", INSPECT_EMPTY).ok).toBe(true);
  });
});

describe("inspect_endpoint — refusals it makes before asking", () => {
  it("refuses a non-https URL as a property of the hosted probe, not a finding", async () => {
    const { fetch, urls } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", {
      url: "http://api.example.com/v1/geocode",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a finding about the endpoint/u);
    expect(urls).toEqual([]);
  });

  it("refuses a URL carrying credentials rather than stripping them", async () => {
    // refused, never normalized away. No credential is ever sent
    // anywhere by this tool.
    const { fetch, urls } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", {
      url: "https://user:pass@api.example.com/v1/geocode",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("userinfo");
    expect(urls).toEqual([]);
  });

  it("asks for a URL rather than guessing when none was supplied", async () => {
    const { fetch, urls } = stubFetch(() => ({ status: 200, body: INSPECT_FULL }));
    const result = await callTool(serverWith(fetch), "inspect_endpoint", {});
    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  — the language audit
// ══════════════════════════════════════════════════════════════════════════

describe("every user-visible string", () => {
  /** Every string this server can put in front of a model, across every path. */
  async function everyString(): Promise<string[]> {
    const out: string[] = [SERVER_INSTRUCTIONS];
    for (const tool of TOOLS) {
      out.push(tool.title, tool.description);
      for (const property of Object.values(tool.inputSchema.properties)) {
        out.push((property as { description: string }).description);
      }
    }

    const offline = offlineOnlyServer();
    const challenges = [
      { challenge: b64(SPEC_V2), url: TARGET },
      { challenge: read("challenges/v2-header-valid.txt").trim(), url: TARGET },
      { challenge: read("challenges/v1-body-valid.json") },
      { challenge: read("challenges/v2-dynamic-payto.txt").trim(), url: TARGET },
      { challenge: read("hostile/bad-base64.txt").trim() },
      { challenge: read("hostile/origin-mismatch.json"), url: TARGET },
      { challenge: read("hostile/non-atomic-amount.json") },
      { challenge: read("hostile/negative-amount.json") },
      { challenge: read("hostile/oversized.json") },
      { challenge: read("hostile/deep-nested.json") },
      { challenge: read("hostile/too-many-requirements.json") },
      { challenge: read("hostile/duplicate-keys.txt").trim() },
      { challenge: "not a challenge at all" },
      {},
    ];
    for (const args of challenges) {
      out.push(textOf(await callTool(offline, "verify_challenge", args)));
    }

    const bodies: { status: number; body: unknown }[] = [
      { status: 200, body: INSPECT_FULL },
      { status: 200, body: INSPECT_EMPTY },
      {
        status: 200,
        body: {
          api_version: "v1",
          generated_at: "2026-08-15T00:00:00Z",
          error: { code: "NOT_X402", message: "The endpoint did not serve a challenge.", retryable: false },
        },
      },
      {
        status: 422,
        body: {
          api_version: "v1",
          generated_at: "2026-08-15T00:00:00Z",
          error: { code: "URL_BLOCKED", message: "The URL is refused.", retryable: false },
        },
      },
      { status: 200, body: { nope: true } },
    ];
    for (const answer of bodies) {
      const { fetch } = stubFetch(() => answer);
      out.push(textOf(await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET })));
    }

    const dead: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    out.push(textOf(await callTool(serverWith(dead), "inspect_endpoint", { url: TARGET })));
    out.push(textOf(await callTool(offlineOnlyServer(), "not_a_tool", {})));

    return out;
  }

  it("never calls anything a scam, unsafe, fraudulent, dangerous or malicious", async () => {
    for (const text of await everyString()) {
      expect(forbiddenTermsIn(text), text.slice(0, 200)).toEqual([]);
    }
  });

  it("never emits a band without the sentence that says what a band is", async () => {
    // The rule this whole file exists to protect: a tool result has no page
    // around it, so the framing travels in the same string as the band or it
    // does not reach the reader at all.
    for (const text of await everyString()) {
      if (/\bband (LOW|MEDIUM|HIGH)\b/u.test(text)) {
        expect(text, "a band was emitted without its framing").toContain(BAND_FRAMING);
      }
    }
  });

  it("never presents a skipped check or an unobserved signal as a result", async () => {
    for (const text of await everyString()) {
      if (text.includes("SKIP")) {
        expect(text).toMatch(/could not run/u);
      }
      if (/could not determine \(\d+\)/u.test(text)) {
        expect(text).toMatch(/not a negative finding/u);
      }
    }
  });

  it("says 'observed' rather than passing judgement", async () => {
    const text = textOf(
      await callTool(offlineOnlyServer(), "verify_challenge", { challenge: b64(SPEC_V2), url: TARGET }),
    );
    expect(text).toContain("Observed signals");
    expect(text).toMatch(/claim about whoever operates the endpoint/u);
    expect(text).toMatch(/not a statement about whoever operates\nthe endpoint/u);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  The transport, driven the way a client drives it
// ══════════════════════════════════════════════════════════════════════════

describe("stdio transport", () => {
  it("answers requests as newline-delimited JSON and stays silent on notifications", async () => {
    const written: string[] = [];
    const logged: string[] = [];

    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n");

    // Chunked mid-message on purpose: a stream that only ever delivers whole
    // lines is not the stream a client provides.
    async function* stdin(): AsyncGenerator<string> {
      yield lines.slice(0, 40);
      yield lines.slice(40, 130);
      yield lines.slice(130);
    }

    await serve(
      { stdin: stdin(), write: (line) => written.push(line), log: (line) => logged.push(line) },
      offlineOnlyServer(),
    );

    // Two requests, two responses. The notification produced none.
    expect(written).toHaveLength(2);
    for (const line of written) expect(line.endsWith("\n")).toBe(true);
    const parsed = written.map((l) => JSON.parse(l) as JsonRpcResponse);
    expect(parsed.map((p) => p.id)).toEqual([1, 2]);
    expect((parsed[1]?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      "inspect_endpoint",
      "verify_challenge",
    ]);
  });

  it("handles a final message with no trailing newline", async () => {
    const written: string[] = [];
    async function* stdin(): AsyncGenerator<string> {
      yield JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" });
    }
    await serve(
      { stdin: stdin(), write: (line) => written.push(line), log: () => undefined },
      offlineOnlyServer(),
    );
    expect(written).toHaveLength(1);
  });

  it("never writes a bare newline inside a frame", async () => {
    // stdout is the wire. Every string this server returns is full of line
    // breaks, and `JSON.stringify` escaping them is what keeps one message on
    // one line — a corrupt frame makes a client hang rather than error.
    const written: string[] = [];
    async function* stdin(): AsyncGenerator<string> {
      yield `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "verify_challenge", arguments: { challenge: b64(SPEC_V2), url: TARGET } },
      })}\n`;
    }
    await serve(
      { stdin: stdin(), write: (line) => written.push(line), log: () => undefined },
      offlineOnlyServer(),
    );

    expect(written).toHaveLength(1);
    const frame = written[0] ?? "";
    expect(frame.slice(0, -1)).not.toContain("\n");
    const parsed = JSON.parse(frame) as JsonRpcResponse;
    expect((parsed.result as ToolCallResult).content[0]?.text).toContain("\n");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Configuration — there are no credentials to configure
// ══════════════════════════════════════════════════════════════════════════

describe("configuration", () => {
  it("defaults to the hosted origin and takes only a base URL from the environment", async () => {
    //.: Watch and accounts were cut, so there is no API key, no
    // login and no token anywhere in this product. The one variable this server
    // reads points it at a local `wrangler dev`, and it is not a credential.
    expect(baseUrlFromEnv({})).toBe("https://tools.tx402.io");
    expect(baseUrlFromEnv({ TX402_TOOLS_API: "http://localhost:8787" })).toBe(
      "http://localhost:8787",
    );
    expect(baseUrlFromEnv({ TX402_TOOLS_API: "  " })).toBe("https://tools.tx402.io");
  });

  it("sends no authorization header, because there is nothing to send", async () => {
    let seen: HeadersInit | undefined;
    const fetch: FetchLike = async (input, init) => {
      void input;
      seen = init?.headers;
      return new Response(JSON.stringify(INSPECT_FULL), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await callTool(serverWith(fetch), "inspect_endpoint", { url: TARGET });

    const headers = Object.keys((seen ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
    expect(headers).not.toContain("authorization");
    expect(headers).not.toContain("cookie");
    expect(headers).toContain("user-agent");
  });
});
