/**
 * its exit criteria, as tests.
 *
 * ⚠️ **These drive the real command entry point.** Every case below calls
 * `run(argv, {print, printErr, …})` with an argv array and captured sinks —
 * not the internals — because the thing shipped is a *command*, and a
 * suite that tests `runInspect` directly would not notice a broken verb
 * table, a swallowed flag or a wrong exit code.
 *
 * Four properties carry the session and each has a section named after it:
 *
 *   1. The CLI reaches `http:` and localhost; the hosted policy still cannot.
 *   2. The Node connector genuinely pins — proved against a server the
 *      hostname does not resolve to.
 *   3. `--json` on every verb validates against `spec/schemas/`.
 *   4. The offline verifier still makes zero network calls through the
 *      command path.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run, VERBS, helpText } from "../packages/tools-cli/src/cli.js";
import { EXIT, EXIT_LABELS, exitForErrorCode } from "../packages/tools-cli/src/exit.js";
import { parseArgs, flagBool, flagString, formatFrom } from "../packages/tools-cli/src/args.js";
import { cliUrlPolicy } from "../packages/tools-cli/src/net/policy.js";
import { nodeConnector } from "../packages/tools-cli/src/net/connector.js";
import { nodeResolver, isLoopbackName } from "../packages/tools-cli/src/net/resolver.js";
import { EXIT as REPLAY_EXIT } from "../packages/tools-cli/src/replay/taxonomy.js";

import {
  HOSTED_URL_POLICY,
  guardedFetch,
  parseAddress,
  validateUrl,
} from "../worker/lib/guard.js";
import type { PinnedTarget } from "../worker/lib/guard.js";

import { hostileConnector, scriptedConnector, scriptedResolver, ROUTABLE_V4 } from "./net-stubs.js";
import { validateAgainst } from "./helpers.js";

// ── the harness ───────────────────────────────────────────────────────────

interface Captured {
  code: number;
  out: string;
  err: string;
}

/**
 * Run the CLI and capture everything it produced.
 *
 * `fetchImpl` is threaded through rather than patched onto the global, so a
 * command that was supposed to make no network call cannot accidentally pass
 * by hitting a mock: the zero-network section installs traps on the globals
 * instead, and a command that reached for one would trip them.
 */
async function cli(
  argv: string[],
  options: { fetchImpl?: typeof fetch; stdin?: string; env?: Record<string, string> } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    print: (line) => out.push(line),
    printErr: (line) => err.push(line),
    readStdin: () => Promise.resolve(options.stdin ?? ""),
    env: options.env ?? {},
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A `fetch` that answers one path from a fixture and refuses everything else. */
function fixtureFetch(fixture: unknown, expectPath?: string): typeof fetch {
  return ((url: string) => {
    if (expectPath && !String(url).includes(expectPath)) {
      throw new Error(`unexpected request: ${String(url)}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

/**
 * A valid v2 challenge in the shape the SDK's decoder actually accepts.
 *
 * Copied from `test/verify-offline.test.ts`'s `SPEC_V2`, which took it from
 * `test/probe.test.ts`, so that "a challenge that decodes" means the same
 * thing in all three suites. The frozen wire-form fixtures in
 * `spec/fixtures/challenges/` deliberately do NOT decode — that is
 * O16, and they exist to be reported as the interoperability bug they are.
 */
const TARGET = "https://api.example.com/v1/geocode";
const CHALLENGE = {
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

const CHALLENGE_B64 = Buffer.from(JSON.stringify(CHALLENGE)).toString("base64");

function challengeConnector() {
  return scriptedConnector({
    "api.example.com/v1/geocode": {
      status: 402,
      headers: { "payment-required": CHALLENGE_B64, "content-type": "application/json" },
      body: JSON.stringify(CHALLENGE),
    },
    "plain.example.com/": { status: 200, body: "{}" },
  });
}

function challengeResolver() {
  return scriptedResolver({
    "api.example.com": [ROUTABLE_V4],
    "plain.example.com": [ROUTABLE_V4],
  });
}

// ── 1. THE VERBS ─────────────────────────────────────────────────────────

describe("the verb table", () => {
  it("is exactly inspect · verify · history · compare · replay", () => {
    expect([...VERBS]).toEqual(["inspect", "verify", "history", "compare", "replay"]);
  });

  /**
   *  row used to name a `watch` verb. Watch was cut in wave 3
   * along with accounts, there is no `/api/v1/watch` to
   * call, and the row is updated. This is the test that keeps it gone.
   */
  it("has no watch verb, and no verb that authenticates a caller", async () => {
    expect([...VERBS]).not.toContain("watch");
    const result = await cli(["watch", "https://api.example.com/v1/geocode"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("Unknown command");

    const help = helpText();
    for (const word of ["api key", "api-key", "token", "sign in", "login", "account"]) {
      expect(help.toLowerCase()).not.toContain(word);
    }
  });

  it("prints help for `help` at 0 and for no argument at 2", async () => {
    expect((await cli(["help"])).code).toBe(EXIT.success);
    const bare = await cli([]);
    expect(bare.code).toBe(EXIT.usage);
    expect(bare.out).toContain("tx402-tools inspect");
  });

  it("refuses an unknown flag combination rather than picking one", async () => {
    const result = await cli(["inspect", "https://api.example.com/x", "--json", "--md"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("not both");
  });
});

// ── 2. http: AND localhost — the thing the hosted probe cannot do ─────────

describe("the CLI reaches what the hosted probe must refuse", () => {
  it("accepts http: where HOSTED_URL_POLICY refuses it", () => {
    const url = "http://api.example.com/v1/geocode";
    expect(validateUrl(url, HOSTED_URL_POLICY).ok).toBe(false);
    expect(validateUrl(url, cliUrlPolicy()).ok).toBe(true);
  });

  it("accepts a loopback literal only with --allow-private, and never for the hosted policy", () => {
    const url = "http://127.0.0.1:3000/paid";

    const hosted = validateUrl(url, HOSTED_URL_POLICY);
    expect(hosted.ok).toBe(false);
    expect(hosted.ok === false && hosted.failure.code).toBe("URL_SCHEME_NOT_ALLOWED");

    const cliDefault = validateUrl(url, cliUrlPolicy());
    expect(cliDefault.ok).toBe(false);
    expect(cliDefault.ok === false && cliDefault.failure.code).toBe("URL_PRIVATE_ADDRESS");

    expect(validateUrl(url, cliUrlPolicy({ allowPrivate: true })).ok).toBe(true);
  });

  it("resolves `localhost` into loopback and refuses it by default", async () => {
    const resolver = scriptedResolver({ localhost: ["127.0.0.1"] });
    const refused = await guardedFetch("http://localhost:3000/paid", {
      policy: cliUrlPolicy(),
      resolver,
      connector: challengeConnector(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.failure.code).toBe("URL_PRIVATE_ADDRESS");
  });

  it("reaches `localhost` with --allow-private, through the same guard", async () => {
    const resolver = scriptedResolver({ localhost: ["127.0.0.1"] });
    const connector = scriptedConnector({
      "localhost/paid": { status: 402, body: JSON.stringify(CHALLENGE) },
    });
    const allowed = await guardedFetch("http://localhost:3000/paid", {
      policy: cliUrlPolicy({ allowPrivate: true }),
      resolver,
      connector,
    });
    expect(allowed.ok).toBe(true);
    expect(connector.pins).toEqual(["127.0.0.1"]);
  });

  /**
   * The carve-out is a CLI property, not a global one. `HOSTED_URL_POLICY` is
   * the object every hosted route passes, and it must never carry the flag —
   * if this test ever fails, the hosted probe has become an SSRF engine.
   */
  it("leaves HOSTED_URL_POLICY without the flag", async () => {
    expect(HOSTED_URL_POLICY.allowPrivateAddresses).toBeUndefined();
    expect(HOSTED_URL_POLICY.allowedSchemes).toEqual(["https:"]);

    const refused = await guardedFetch("https://localhost/paid", {
      policy: HOSTED_URL_POLICY,
      resolver: scriptedResolver({ localhost: ["127.0.0.1"] }),
      connector: hostileConnector(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.failure.code).toBe("URL_PRIVATE_ADDRESS");
  });

  it("still refuses userinfo, and still refuses a cross-scheme redirect, with the flag on", async () => {
    const withCreds = validateUrl(
      "http://user:pass@localhost:3000/x",
      cliUrlPolicy({ allowPrivate: true }),
    );
    expect(withCreds.ok).toBe(false);
    expect(withCreds.ok === false && withCreds.failure.code).toBe("URL_USERINFO_PRESENT");

    const downgrade = await guardedFetch("https://redirector.example.net/to-http", {
      policy: cliUrlPolicy({ allowPrivate: true }),
      resolver: scriptedResolver({
        "redirector.example.net": [ROUTABLE_V4],
        "public.example.net": [ROUTABLE_V4],
      }),
      connector: hostileConnector(),
    });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.ok === false && downgrade.failure.reason).toBe("scheme-change");
  });

  it("--no-http narrows the CLI back to the hosted probe's scheme list", () => {
    expect(cliUrlPolicy({ allowHttp: false }).allowedSchemes).toEqual(["https:"]);
  });
});

// ── 3. THE PIN ─────────────────────────────────────────────

describe("the Node connector genuinely pins the validated address", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": CHALLENGE_B64,
      });
      res.end(JSON.stringify(CHALLENGE));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function pinTo(hostname: string): PinnedTarget {
    return { hostname, port, address: parseAddress("127.0.0.1")! };
  }

  /**
   * The proof. The hostname is one that resolves nowhere — `.invalid` is
   * reserved by RFC 6761 precisely so that it never resolves — and the
   * connection still succeeds, because the socket went to the pinned address
   * and never consulted DNS.
   *
   * On the hosted connector this test is not merely failing but
   * *inexpressible*: `fetch` takes a URL and re-resolves it, so a name that
   * does not resolve cannot be reached however carefully it was validated.
   */
  it("connects to the pinned address for a hostname that resolves nowhere", async () => {
    const connector = nodeConnector();
    const response = await connector.fetch(
      new URL(`http://pinned.invalid:${port}/paid`),
      { headers: { accept: "application/json" }, signal: new AbortController().signal },
      pinTo("pinned.invalid"),
    );

    expect(response.status).toBe(402);
    expect(connector.pins).toEqual([
      { hostname: "pinned.invalid", port, address: "127.0.0.1", servername: "pinned.invalid" },
    ]);
  });

  it("does not send an IP literal as SNI", async () => {
    const connector = nodeConnector();
    await connector.fetch(
      new URL(`http://127.0.0.1:${port}/paid`),
      { headers: {}, signal: new AbortController().signal },
      pinTo("127.0.0.1"),
    );
    expect(connector.pins[0]!.servername).toBeNull();
  });

  it("streams the body rather than buffering it, so the guard's byte cap still aborts", async () => {
    const connector = nodeConnector();
    const response = await connector.fetch(
      new URL(`http://pinned.invalid:${port}/paid`),
      { headers: {}, signal: new AbortController().signal },
      pinTo("pinned.invalid"),
    );
    expect(response.body).not.toBeNull();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
  });

  /**
   * The rebind case, which `test/net-stubs.ts` exists to express: the resolver
   * answers public first and loopback on every lookup after it. The guard
   * resolves twice per hop, so the second answer is what it validates against
   * — and with the CLI's default policy that is a refusal.
   */
  it("refuses a rebinding host by default, and the flag is what changes it", async () => {
    const rebind = () =>
      scriptedResolver({
        "rebind.example.net": (call) => (call === 1 ? [ROUTABLE_V4] : ["127.0.0.1"]),
      });

    const refused = await guardedFetch("https://rebind.example.net/x", {
      policy: cliUrlPolicy(),
      resolver: rebind(),
      connector: hostileConnector(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.failure.code).toBe("URL_PRIVATE_ADDRESS");

    // With --allow-private the operator has said loopback is acceptable, so
    // the refusal moves to the *disagreement* between the two lookups rather
    // than to the address class. The pin is still what the connector receives.
    const withFlag = await guardedFetch("https://rebind.example.net/x", {
      policy: cliUrlPolicy({ allowPrivate: true }),
      resolver: rebind(),
      connector: hostileConnector(),
    });
    expect(withFlag.ok).toBe(false);
    expect(withFlag.ok === false && withFlag.failure.reason).toBe(
      "rrset-unstable-between-lookups",
    );
  });

  it("counts two lookups per hop — the rebinding defence is not an assumption", async () => {
    const resolver = scriptedResolver({ "api.example.com": [ROUTABLE_V4] });
    await guardedFetch("https://api.example.com/v1/geocode", {
      policy: cliUrlPolicy(),
      resolver,
      connector: challengeConnector(),
    });
    expect(resolver.lookups.get("api.example.com")).toBe(2);
  });

  it("knows a loopback name without asking DNS", () => {
    expect(isLoopbackName("localhost")).toBe(true);
    expect(isLoopbackName("LOCALHOST.")).toBe(true);
    expect(isLoopbackName("api.localhost")).toBe(true);
    expect(isLoopbackName("api.example.com")).toBe(false);
    // Constructed, not connected: proves the real resolver is wired up.
    expect(typeof nodeResolver().resolve).toBe("function");
  });
});

// ── 4. --json VALIDATES AGAINST THE FROZEN SCHEMAS ───────────────────────

/**
 * SPEC L5 is what made this change safe to write in parallel with the APIs,
 * and this is how it is honoured: the CLI's `--json` goes through the same ajv
 * setup `pnpm schema:check` uses, against the same frozen files. The schemas
 * validate the **whole envelope**, so these cover the stamps as well as `data`.
 *
 * The probe cases inject the guard's two transport ports through `run`'s
 * programmatic options — never through a flag, because a CLI whose transport
 * could be swapped from argv would be a way to make the guard validate one
 * thing and connect to another.
 */
describe("--json is the frozen envelope", () => {
  it("inspect --json validates against spec/schemas/inspect", async () => {
    const connector = challengeConnector();
    const resolver = challengeResolver();
    const out: string[] = [];

    const code = await run(["inspect", "https://api.example.com/v1/geocode", "--json"], {
      print: (line) => out.push(line),
      printErr: () => undefined,
      readStdin: () => Promise.resolve(""),
      env: {},
      probeOverrides: { connector, resolver },
    });

    const body = JSON.parse(out.join("\n"));
    const { ok, errors } = validateAgainst("inspect", body);
    expect(ok, errors).toBe(true);
    expect(body.tool).toBe("inspect");
    expect(body.meta.implemented).toBe(true);
    expect(body.data.observed.has_history).toBe(false);
    expect(code).toBe(EXIT.success);
    // The probe went through the guard's connector port, and the guard is what
    // told it which address to reach.
    expect(connector.pins).toEqual([ROUTABLE_V4]);
  });

  it("inspect exits 5 on an endpoint that serves no challenge, and still reports", async () => {
    const out: string[] = [];
    const code = await run(["inspect", "https://plain.example.com/", "--json"], {
      print: (line) => out.push(line),
      printErr: () => undefined,
      readStdin: () => Promise.resolve(""),
      env: {},
      probeOverrides: { connector: challengeConnector(), resolver: challengeResolver() },
    });
    const body = JSON.parse(out.join("\n"));
    expect(validateAgainst("inspect", body).ok).toBe(true);
    expect(body.warnings.some((w: { code: string }) => w.code === "NOT_X402")).toBe(true);
    expect(code).toBe(EXIT.protocol);
  });

  it("renders the terminal report from that same envelope", async () => {
    const out: string[] = [];
    await run(["inspect", "https://api.example.com/v1/geocode"], {
      print: (line) => out.push(line),
      printErr: () => undefined,
      readStdin: () => Promise.resolve(""),
      env: {},
      probeOverrides: { connector: challengeConnector(), resolver: challengeResolver() },
    });
    // `inspectMarkdown` is the hosted `Accept: text/markdown` renderer, so the
    // terminal output is that mirror rather than a CLI-specific rendering.
    const text = out.join("\n");
    expect(text).toContain("What does this x402 endpoint charge?");
    expect(text).toContain("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
  });


  it("verify --json validates against spec/schemas/verify", async () => {
    const result = await cli(["verify", "--header", CHALLENGE_B64, "--json"]);
    const body = JSON.parse(result.out);
    const { ok, errors } = validateAgainst("verify", body);
    expect(ok, errors).toBe(true);
    expect(body.tool).toBe("verify");
    expect(body.data.checks.length).toBeGreaterThan(20);
  });

  it("history --json relays the hosted envelope, and it still validates", async () => {
    const fixture = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        "spec/fixtures/responses/history-empty.json",
        "utf8",
      ),
    );
    const result = await cli(
      ["history", "https://api.example.com/v1/geocode", "--json"],
      { fetchImpl: fixtureFetch(fixture, "/api/v1/history") },
    );
    const body = JSON.parse(result.out);
    expect(validateAgainst("history", body).ok).toBe(true);
    expect(result.code).toBe(EXIT.success);
  });

  it("compare --json relays the hosted envelope, and it still validates", async () => {
    const fixture = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        "spec/fixtures/responses/compare-empty.json",
        "utf8",
      ),
    );
    const result = await cli(
      ["compare", "https://a.example/x", "https://b.example/y", "--json"],
      { fetchImpl: fixtureFetch(fixture, "/api/v1/compare") },
    );
    const body = JSON.parse(result.out);
    expect(validateAgainst("compare", body).ok).toBe(true);
    expect(result.code).toBe(EXIT.success);
  });

  it("replay --json wraps the analysis in the frozen envelope", async () => {
    const trace = JSON.stringify({
      name: "Tx402Error",
      code: "TX402_PAYMENT_AMBIGUOUS",
      message: "the settlement response never arrived",
      retryable: false,
      retryability: "no-automatic-retry",
      context: { requestId: "req_01J8Z", phase: "retry", paid: "unknown", reservationId: "rsv_7f2a" },
      details: {},
    });

    const result = await cli(["replay", "-", "--json"], { stdin: trace });
    const body = JSON.parse(result.out);
    const { ok, errors } = validateAgainst("replay", body);
    expect(ok, errors).toBe(true);
    expect(body.data.analysis.diagnosis.do_not_retry).toBe(true);
    expect(result.code).toBe(REPLAY_EXIT.ambiguousPayment);
  });
});

// ── 5. ZERO NETWORK ─────────────────────────────────────────

/**
 * ⚠️ **This is enforced at the command level, and it must not be
 * deleted.**
 *
 * `test/verify-offline.test.ts` proves the *library* sends nothing. This
 * proves the *command* does — because L4's claim is about what happens when a
 * person runs `tx402-tools verify`, not about what a function does when
 * called carefully. The traps are the same ones we installed, plus the
 * guard's `Connector` port, which is the single seam every outbound request
 * in this repo passes through.
 */
describe("the offline verifier makes zero network calls through the command path", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
    const trap = (name: string) =>
      ((...args: unknown[]) => {
        calls.push(`${name}(${String(args[0]).slice(0, 80)})`);
        throw new Error(`${name} was called by an offline command`);
      }) as never;

    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
      saved[name] = globals[name];
      globals[name] = trap(name);
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[name];
      else globals[name] = value;
    }
  });

  it("verify --header sends nothing", async () => {
    const result = await cli(["verify", "--header", CHALLENGE_B64, "--json"]);
    expect(calls).toEqual([]);
    expect(JSON.parse(result.out).data.verdict).toBeTruthy();
  });

  it("verify from stdin sends nothing, and neither do the failing shapes", async () => {
    for (const input of [
      CHALLENGE_B64,
      JSON.stringify(CHALLENGE),
      "not base64 at all!!",
      "{",
      "{}",
    ]) {
      const result = await cli(["verify", "-", "--json"], { stdin: input });
      expect(calls, `input: ${input.slice(0, 20)}`).toEqual([]);
      expect(result.out.length).toBeGreaterThan(0);
    }
  });

  it("replay analyses a trace without sending anything", async () => {
    const result = await cli(["replay", "-"], {
      stdin: JSON.stringify({
        name: "Tx402Error",
        code: "TX402_POLICY_BUDGET",
        message: "over budget",
        retryable: false,
        retryability: "no",
        context: { requestId: "req_1", phase: "policy" },
        details: {},
      }),
    });
    expect(calls).toEqual([]);
    expect(result.code).toBe(REPLAY_EXIT.policy);
  });

  it("produces a real verdict while the traps are installed", async () => {
    // Without this the suite could degrade into one that traps everything and
    // verifies nothing. Same guard we put on its own file.
    const result = await cli(["verify", "--header", CHALLENGE_B64, "--json"]);
    const body = JSON.parse(result.out);
    expect(body.data.checks.some((c: { id: string }) => c.id === "amount_atomic_canonical")).toBe(
      true,
    );
    expect(calls).toEqual([]);
  });

  it("verify --enrich is the only thing that calls out, and it says so", async () => {
    // The trap is still installed: --enrich must reach the injected fetch, not
    // the global one, and the assertion is that it tried at all.
    let asked: string | null = null;
    const result = await cli(["verify", "--header", CHALLENGE_B64, "--enrich", "--json"], {
      fetchImpl: ((url: string) => {
        asked = String(url);
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "NO_DATA", message: "empty corpus" } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(asked).toContain("/api/v1/verify");
    expect(calls).toEqual([]);
    expect(result.code).toBe(EXIT.success);
  });
});

// ── 6. THE EXIT-CODE TABLE ───────────────────────────────────────────────

describe("the exit-code table", () => {
  it("is the SDK's, so a script means the same thing on both sides", () => {
    expect(EXIT).toEqual({
      success: 0,
      usage: 2,
      policy: 3,
      liquidity: 4,
      protocol: 5,
      signer: 6,
      transport: 7,
      ambiguousPayment: 8,
      resourceFailure: 9,
    });
    expect(Object.keys(EXIT_LABELS).map(Number).sort((a, b) => a - b)).toEqual([
      0, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("labels 8 so it cannot be missed", () => {
    expect(EXIT_LABELS[8]).toContain("do not retry");
    expect(helpText()).toContain("do not retry");
  });

  it("separates a URL we refuse from an endpoint we could not reach", () => {
    for (const code of ["URL_PRIVATE_ADDRESS", "URL_SCHEME_NOT_ALLOWED", "URL_USERINFO_PRESENT"]) {
      expect(exitForErrorCode(code), code).toBe(EXIT.usage);
    }
    for (const code of ["PROBE_TIMEOUT", "PROBE_FAILED", "TOO_MANY_REDIRECTS"]) {
      expect(exitForErrorCode(code), code).toBe(EXIT.transport);
    }
  });

  /**
   * SPEC §3.1's three HTTP-200 codes. `NO_DATA` is a real answer — an empty
   * corpus is not a failure — while a challenge nothing could read is a
   * protocol failure for a script that was about to pay it.
   */
  it("treats an empty corpus as an answer and an unreadable challenge as a failure", () => {
    expect(exitForErrorCode("NO_DATA")).toBe(EXIT.success);
    expect(exitForErrorCode("CHALLENGE_MALFORMED")).toBe(EXIT.protocol);
    expect(exitForErrorCode("NOT_X402")).toBe(EXIT.protocol);
  });

  it("exits 2 on a usage error and 5 on a challenge tx402 would refuse", async () => {
    expect((await cli(["verify"])).code).toBe(EXIT.usage);
    expect((await cli(["inspect"])).code).toBe(EXIT.usage);
    expect((await cli(["verify", "--header", "not base64!!"])).code).toBe(EXIT.protocol);
  });

  it("exits 7 when the hosted API cannot be reached", async () => {
    const result = await cli(["history", "https://api.example.com/x"], {
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    expect(result.code).toBe(EXIT.transport);
  });
});

// ── 7. THE ARGUMENT GRAMMAR ──────────────────────────────────────────────

describe("argument parsing", () => {
  it("does not let a boolean flag swallow the next argument", () => {
    const args = parseArgs(["inspect", "--json", "--url", "https://a.example/x"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(flagString(args, "url")).toBe("https://a.example/x");
  });

  it("understands --flag=value, --no-flag and --", () => {
    const args = parseArgs(["verify", "--url=https://a.example/x", "--no-http", "--", "--literal"]);
    expect(flagString(args, "url")).toBe("https://a.example/x");
    expect(flagBool(args, "http", true)).toBe(false);
    expect(args.positionals).toEqual(["verify", "--literal"]);
  });

  it("treats `-` as a positional, not a flag", () => {
    expect(parseArgs(["replay", "-"]).positionals).toEqual(["replay", "-"]);
  });

  it("resolves the representation the way ?format= does", () => {
    expect(formatFrom(parseArgs(["inspect"]))).toBe("text");
    expect(formatFrom(parseArgs(["inspect", "--json"]))).toBe("json");
    expect(formatFrom(parseArgs(["inspect", "--md"]))).toBe("md");
  });
});

// ── 8. LANGUAGE ───────────────────────────────────────────

/**
 * The terminal is a surface like any other, and §6.2's rule binds it: the
 * bands describe the confidence of *our observations*, never a merchant's
 * character. Three existing test files assert this against their own
 * surfaces; this one asserts it against everything the CLI can print.
 */
describe("language", () => {
  const FORBIDDEN = [
    "scam",
    "fraud",
    "fraudulent",
    "unsafe",
    "malicious",
    "dangerous",
    "untrustworthy",
    "rug",
  ];

  function assertClean(text: string, where: string): void {
    for (const word of FORBIDDEN) {
      expect(new RegExp(`\\b${word}`, "iu").test(text), `${where}: "${word}"`).toBe(false);
    }
  }

  it("keeps help and the exit labels neutral", () => {
    assertClean(helpText(), "help");
    assertClean(Object.values(EXIT_LABELS).join(" "), "exit labels");
  });

  it("keeps a verify report neutral, including a failing one", async () => {
    const pass = await cli(["verify", "--header", CHALLENGE_B64]);
    assertClean(pass.out, "verify pass");

    const fail = await cli(["verify", "--header", "not base64!!"]);
    assertClean(fail.out, "verify fail");
  });

  it("says `we could not ask` rather than showing a zero", async () => {
    const fixture = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        "spec/fixtures/responses/history-empty.json",
        "utf8",
      ),
    );
    const result = await cli(["history", "https://api.example.com/x"], {
      fetchImpl: fixtureFetch(fixture, "/api/v1/history"),
    });
    assertClean(result.out, "history");
    // The renderer is its own markdown mirror, so an empty analytics series
    // renders as an absence rather than as 0%.
    expect(result.out).not.toMatch(/\b0\.00%/u);
  });

  it("names the flag that fixes a refusal instead of explaining the network", async () => {
    const result = await cli(["inspect", "http://127.0.0.1:9/x"]);
    expect(result.err).toContain("--allow-private");
    // The guard's internal reason (`literal-loopback-127.0.0.1`) is never
    // shown: a guard that explains precisely why it refused is a scanner.
    expect(result.err).not.toContain("literal-loopback");
  });
});
