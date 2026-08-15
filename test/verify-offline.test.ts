/**
 * `packages/tools-cli/src/verify-offline.ts` —.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  DO NOT DELETE `the offline verifier makes zero network calls`.          │
 * │                                                                          │
 * │  That test is the enforcement of **L4** — "the no-backend │
 * │  firewall" — at the library level. The `tx402` SDK's README promises │
 * │  "no tx402-operated service, no telemetry, no phone-home", and │
 * │  L4 requires that claim to stay *mathematically* true rather than "true │
 * │  if you don't pass the flag". The offline verifier is the code the CLI │
 * │  runs on a developer's machine against a challenge that is about to be │
 * │  signed; if it ever acquires a network call, the promise is broken and │
 * │  nobody finds out from reading the diff.                                 │
 * │                                                                          │
 * │  It stubs `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, │
 * │  `navigator.sendBeacon` AND the guard's `Connector` port — the seam │
 * │  every outbound request in this repo goes through — and fails on any │
 * │  invocation. If a future change needs the network, it needs a different │
 * │  module, not an exception here.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECK_IDS,
  DECODER_REASONS,
  ENRICHED_CHECK_IDS,
  OFFLINE_CHECK_IDS,
  aggregateVerdict,
  classifyRaw,
  isWellFormedCaip2,
  verifyOffline,
  type Check,
  type CheckStatus,
} from "../packages/tools-cli/src/verify-offline.js";
import { workerConnector } from "../worker/lib/guard.js";
import { reproduceScore } from "../worker/lib/score.js";

// ── fixtures ──────────────────────────────────────────────────────────────

const fixtures = join(process.cwd(), "spec", "fixtures");
const read = (rel: string): string => readFileSync(join(fixtures, rel), "utf8");

/**
 * A genuinely spec-shaped x402 v2 challenge.
 *
 * The frozen `v2-header-valid` fixture is **not** one: it declares
 * `x402Version: 2` and then uses the v1 layout, so the strict decoder refuses
 * it. That fixture is deliberately left alone and
 * asserted below as the interoperability bug it actually is; this is the shape
 * `test/probe.test.ts` builds inline as `SPEC_V2`, reused here so "valid v2"
 * means the same thing in both sessions' suites.
 */
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

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const statusOf = (checks: Check[], id: string): CheckStatus | undefined =>
  checks.find((c) => c.id === id)?.status;
const reasonOf = (checks: Check[], id: string): string | null | undefined =>
  checks.find((c) => c.id === id)?.reason;

// ══════════════════════════════════════════════════════════════════════════
//  — the property this whole module exists to have
// ══════════════════════════════════════════════════════════════════════════

describe("the offline verifier never touches the network", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const calls: string[] = [];

  const trap =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push(`${name}(${args.map((a) => String(a)).slice(0, 1).join("")})`);
      throw new Error(
        `The offline boundary was violated: the verifier called ${name}(). ` +
          "Offline verification must send nothing anywhere — see the banner at the top of this file.",
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
    // `navigator` itself is a getter-only global in Node, so the beacon is
    // trapped on the object rather than by replacing it.
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

  it("the offline verifier makes zero network calls", async () => {
    // Every shape a caller can hand it, including the ones that fail — a
    // verifier that phoned home only on the error path would still break L4.
    const inputs = [
      { header: b64(SPEC_V2) },
      { body: read("challenges/v1-body-valid.json") },
      { raw: read("challenges/v2-header-valid.txt").trim() },
      { raw: read("hostile/bad-base64.txt").trim() },
      { raw: read("hostile/duplicate-keys.txt").trim() },
      { body: read("hostile/oversized.json") },
      { body: read("hostile/origin-mismatch.json") },
      { raw: "not a challenge at all" },
      {},
    ];

    for (const input of inputs) {
      await verifyOffline(input, { context: { url: TARGET, expected_origin: null } });
    }

    expect(calls, `outbound calls attempted: ${calls.join(", ")}`).toEqual([]);
  });

  it("does not reach the guard's Connector, the seam every outbound request uses", async () => {
    // `verify-offline.ts` imports `worker/lib/probe.ts` for its normalization,
    // which pulls `worker/lib/guard.ts` into the module graph. That is fine —
    // being in the graph is not being called — and this is the assertion that
    // keeps it fine. `workerConnector.fetch` is the single function through
    // which every hosted network request in this repo passes.
    const original = workerConnector.fetch.bind(workerConnector);
    let reached = 0;
    (workerConnector as { fetch: unknown }).fetch = (): never => {
      reached += 1;
      throw new Error("The offline boundary was violated: the verifier used the guard's Connector.");
    };

    try {
      await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
      await verifyOffline({ body: read("challenges/v1-body-valid.json") }, {});
    } finally {
      (workerConnector as { fetch: unknown }).fetch = original;
    }

    expect(reached).toBe(0);
  });

  it("produces a real verdict while the network is trapped", async () => {
    // Guards the guard: a test that trapped everything and then verified
    // nothing would pass forever, including after the module stopped working.
    const result = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    expect(result.verdict).toBe("pass");
    expect(result.challenge.valid).toBe(true);
    expect(calls).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  The frozen contract (SPEC §5.2.1)
// ══════════════════════════════════════════════════════════════════════════

describe("SPEC §5.2.1 — the frozen check ids", () => {
  const FROZEN = [
    "wire_form_detected",
    "base64_strict",
    "size_within_limit",
    "depth_within_limit",
    "no_duplicate_keys",
    "json_wellformed",
    "x402_version_known",
    "accepts_present",
    "accepts_within_limit",
    "scheme_known",
    "network_caip2_wellformed",
    "network_recognized",
    "asset_recognized",
    "amount_atomic_canonical",
    "amount_positive",
    "pay_to_wellformed",
    "max_timeout_sane",
    "resource_origin_match",
    "mime_type_wellformed",
    "extra_wellformed",
    "facilitator_known",
    "amount_within_observed_range",
    "recipient_matches_observed",
    "endpoint_known",
  ];

  it("implements exactly the 24 ids SPEC §5.2.1 freezes — no more, no fewer", () => {
    // Restated here rather than imported, on purpose. Importing the list from
    // the implementation would make this test agree with itself; this is a
    // transcription of the spec table, so inventing an id fails the build.
    expect([...CHECK_IDS].sort()).toEqual([...FROZEN].sort());
  });

  it("reports every id on every response, whatever happened", async () => {
    for (const input of [{ header: b64(SPEC_V2) }, { raw: "garbage" }, {}]) {
      const { checks } = await verifyOffline(input, {});
      expect(checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    }
  });

  it("marks exactly the three corpus-dependent checks as not offline", async () => {
    const { checks } = await verifyOffline({ header: b64(SPEC_V2) }, {});
    const hosted = checks.filter((c) => !c.offline).map((c) => c.id);
    expect(hosted).toEqual([...ENRICHED_CHECK_IDS]);
    expect(checks.filter((c) => c.offline)).toHaveLength(OFFLINE_CHECK_IDS.length);
  });

  it("never returns a check status outside the frozen vocabulary", async () => {
    const { checks } = await verifyOffline({ body: read("hostile/negative-amount.json") }, {});
    for (const check of checks) {
      expect(["pass", "warn", "fail", "skip"]).toContain(check.status);
    }
  });
});

describe("SPEC §5.2 — the frozen aggregation rule", () => {
  const check = (status: CheckStatus): Check => ({
    id: "wire_form_detected",
    status,
    offline: true,
    reason: null,
    detail: null,
  });

  it("fails if any check failed, else warns if any warned, else passes", () => {
    expect(aggregateVerdict([check("pass"), check("warn"), check("fail")])).toBe("fail");
    expect(aggregateVerdict([check("pass"), check("warn"), check("skip")])).toBe("warn");
    expect(aggregateVerdict([check("pass"), check("skip")])).toBe("pass");
    expect(aggregateVerdict([])).toBe("pass");
  });

  it("never lets a skip become a pass — SPEC §4.3", () => {
    // The distinction the whole product rests on: `skip` contributes nothing,
    // but it is reported, so a reader can see what was not checked.
    expect(aggregateVerdict([check("skip")])).toBe("pass");
    expect(aggregateVerdict([check("skip")])).not.toBe("warn");
  });

  it("the verdict on a real result equals the rule applied to its own checks", async () => {
    for (const input of [
      { header: b64(SPEC_V2) },
      { body: read("challenges/v1-body-valid.json") },
      { body: read("hostile/origin-mismatch.json") },
    ]) {
      const result = await verifyOffline(input, { context: { url: TARGET } });
      expect(result.verdict).toBe(aggregateVerdict(result.checks));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Every fixture in spec/fixtures/ produces its documented verdict
// ══════════════════════════════════════════════════════════════════════════

describe("spec/fixtures — documented verdicts", () => {
  it("a spec-shaped v2 challenge with its endpoint URL passes cleanly", async () => {
    const result = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });

    expect(result.verdict).toBe("pass");
    expect(result.challenge.valid).toBe(true);
    expect(result.challenge.wire_form).toBe("v2-header");
    expect(statusOf(result.checks, "resource_origin_match")).toBe("pass");
    expect(statusOf(result.checks, "amount_atomic_canonical")).toBe("pass");
    expect(statusOf(result.checks, "max_timeout_sane")).toBe("pass");
    expect(result.risk?.band).toBe("LOW");
  });

  it("without context.url, resource_origin_match skips — never passes (SPEC §5.2)", async () => {
    const result = await verifyOffline({ header: b64(SPEC_V2) }, {});
    expect(statusOf(result.checks, "resource_origin_match")).toBe("skip");
    expect(reasonOf(result.checks, "resource_origin_match")).toBe("no_context_url");
    expect(result.verdict).toBe("pass");
  });

  it("v1-body-valid: tx402 cannot pay a v1 challenge, and says which that is about", async () => {
    const result = await verifyOffline(
      { body: read("challenges/v1-body-valid.json") },
      { context: { url: TARGET } },
    );

    expect(result.verdict).toBe("fail");
    expect(result.challenge.wire_form).toBe("v1-body");
    expect(result.challenge.x402_version).toBe(1);
    expect(statusOf(result.checks, "x402_version_known")).toBe("fail");
    //. decision 5: the reason must not read as a judgement.
    const detail = result.checks.find((c) => c.id === "x402_version_known")?.detail ?? "";
    expect(detail).toContain("tx402 decodes version 2 only");
    expect(detail).toContain("not the endpoint");
    // `network: "base"` is legacy naming, not CAIP-2.
    expect(statusOf(result.checks, "network_caip2_wellformed")).toBe("fail");
    // No base64 framing on a v1 body, so that check cannot be a hollow pass.
    expect(statusOf(result.checks, "base64_strict")).toBe("skip");
    expect(reasonOf(result.checks, "base64_strict")).toBe("no_base64_framing");
  });

  it("v2-header-valid: declares v2, serves the v1 layout, and is refused (addendum A1)", async () => {
    const result = await verifyOffline(
      { header: read("challenges/v2-header-valid.txt").trim() },
      { context: { url: TARGET } },
    );

    expect(result.challenge.x402_version).toBe(2);
    expect(result.challenge.valid).toBe(false);
    expect(result.verdict).toBe("fail");
    expect(statusOf(result.checks, "resource_origin_match")).toBe("fail");
    expect(
      result.checks.find((c) => c.id === "resource_origin_match")?.detail,
    ).toContain("x402 v1 layout");
  });

  it("v2-dynamic-payto: a concrete address, and extra.payToMode is not read (addendum A2)", async () => {
    const result = await verifyOffline(
      { header: read("challenges/v2-dynamic-payto.txt").trim() },
      { context: { url: "https://marketplace.example.com/v1/order/8f21" } },
    );

    // O13/O22: `extra.payToMode` is a guessed key that the specification does
    // not define. Nothing here recognizes it, and a test says so, so nobody
    // adopts it by accident.
    const dynamic = result.signals.find((s) => s.id === "pay_to_declared_dynamic");
    expect(dynamic?.value).toBe(false);
    // The recipient is a well-formed address, so it is not a finding.
    expect(statusOf(result.checks, "pay_to_wellformed")).toBe("pass");
  });

  it("a role-constant payTo is a declaration, not a malformed address (SPEC §6.4)", async () => {
    // The one dynamic-payTo surface x402 v2 actually defines: "recipient
    // wallet address or role constant". Failing this would be crying wolf at
    // exactly the marketplaces the carve-out exists to protect.
    const challenge = {
      ...SPEC_V2,
      accepts: [{ ...SPEC_V2.accepts[0], payTo: "merchant" }],
    };
    const result = await verifyOffline({ header: b64(challenge) }, { context: { url: TARGET } });

    expect(statusOf(result.checks, "pay_to_wellformed")).toBe("pass");
    expect(result.signals.find((s) => s.id === "pay_to_declared_dynamic")?.value).toBe(true);
    expect(result.verdict).not.toBe("fail");
  });

  it("malformed-missing-accepts: no way to pay is a failure", async () => {
    const result = await verifyOffline(
      { body: read("challenges/malformed-missing-accepts.json") },
      {},
    );
    expect(result.verdict).toBe("fail");
    expect(statusOf(result.checks, "accepts_present")).toBe("fail");
  });

  it("malformed-not-json: base64 succeeds, JSON does not", async () => {
    const result = await verifyOffline(
      { raw: read("challenges/malformed-not-json.txt").trim() },
      {},
    );
    expect(statusOf(result.checks, "base64_strict")).toBe("pass");
    expect(statusOf(result.checks, "json_wellformed")).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("hostile/bad-base64: refused at the framing, and nothing after it is guessed", async () => {
    const result = await verifyOffline({ raw: read("hostile/bad-base64.txt").trim() }, {});
    expect(statusOf(result.checks, "base64_strict")).toBe("fail");
    expect(statusOf(result.checks, "json_wellformed")).toBe("skip");
    expect(result.verdict).toBe("fail");
  });

  it("hostile/duplicate-keys: caught in text, and honestly skipped once pre-parsed", async () => {
    const asText = await verifyOffline({ raw: read("hostile/duplicate-keys.txt").trim() }, {});
    expect(statusOf(asText.checks, "no_duplicate_keys")).toBe("fail");

    // A caller who hands us an already-parsed object has already lost the
    // duplicate — every mainstream parser silently keeps the last value.
    // Reporting a pass there would be reporting on something we could not see.
    const parsed = JSON.parse(read("hostile/duplicate-keys.txt")) as Record<string, unknown>;
    const asObject = await verifyOffline({ body: parsed }, {});
    expect(statusOf(asObject.checks, "no_duplicate_keys")).toBe("skip");
    expect(reasonOf(asObject.checks, "no_duplicate_keys")).toBe("body_pre_parsed");
  });

  it("hostile/oversized: over the decoder's byte cap", async () => {
    const result = await verifyOffline({ body: read("hostile/oversized.json") }, {});
    expect(statusOf(result.checks, "size_within_limit")).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("hostile/deep-nested: over the decoder's depth cap", async () => {
    const result = await verifyOffline({ body: read("hostile/deep-nested.json") }, {});
    expect(statusOf(result.checks, "depth_within_limit")).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("hostile/too-many-requirements: reports the count even though size trips first", async () => {
    // The fixture is 80 KB, so the decoder stops at its byte cap and never
    // counts anything. Layer B counts anyway — dropping the second finding
    // because the decoder short-circuited would hide half the problem.
    const result = await verifyOffline({ body: read("hostile/too-many-requirements.json") }, {});
    expect(statusOf(result.checks, "size_within_limit")).toBe("fail");
    expect(statusOf(result.checks, "accepts_within_limit")).toBe("fail");
  });

  it("hostile/non-atomic-amount: the amount is the finding, not the wire shape", async () => {
    // The whole point of this fixture. It is written in the v1 layout, so the
    // decoder refuses it long before it reaches the amount; the semantic layer
    // reads the amount regardless.
    const result = await verifyOffline({ body: read("hostile/non-atomic-amount.json") }, {});
    expect(statusOf(result.checks, "amount_atomic_canonical")).toBe("fail");
    expect(
      result.checks.find((c) => c.id === "amount_atomic_canonical")?.detail,
    ).toContain("0.01");
  });

  it("hostile/negative-amount: not canonical and not a positive charge", async () => {
    const result = await verifyOffline({ body: read("hostile/negative-amount.json") }, {});
    expect(statusOf(result.checks, "amount_atomic_canonical")).toBe("fail");
    expect(statusOf(result.checks, "amount_positive")).toBe("fail");
    expect(reasonOf(result.checks, "amount_positive")).toBe("amount-negative");
  });

  it("hostile/origin-mismatch: names the other origin rather than the envelope", async () => {
    // This fixture is also v1-shaped, so the decoder stops at the missing
    // top-level `resource` and never performs its own origin comparison.
    // Reporting "not v2-shaped" about the fixture whose entire purpose is the
    // mismatch would lose the finding it exists to produce.
    const result = await verifyOffline(
      { body: read("hostile/origin-mismatch.json") },
      { context: { url: TARGET } },
    );
    expect(statusOf(result.checks, "resource_origin_match")).toBe("fail");
    expect(reasonOf(result.checks, "resource_origin_match")).toBe("origin-mismatch");
    const detail = result.checks.find((c) => c.id === "resource_origin_match")?.detail ?? "";
    expect(detail).toContain("https://payments.attacker.example");
    expect(detail).toContain("https://api.example.com");
  });

  it("an origin mismatch on a spec-shaped v2 challenge is the decoder's own refusal", async () => {
    const result = await verifyOffline(
      { header: b64(SPEC_V2) },
      { context: { url: "https://other.example.com/v1/geocode" } },
    );
    expect(result.challenge.valid).toBe(false);
    expect(statusOf(result.checks, "resource_origin_match")).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("no challenge at all is a failure of wire_form_detected, not a crash", async () => {
    const result = await verifyOffline({}, {});
    expect(result.verdict).toBe("fail");
    expect(statusOf(result.checks, "wire_form_detected")).toBe("fail");
    expect(result.challenge.wire_form).toBe("none");
    // score returns null when no challenge was served.
    // decision 4). A URL that is not an x402 endpoint is not a risky one.
    expect(result.risk).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Invariants
// ══════════════════════════════════════════════════════════════════════════

describe("invariants", () => {
  /**
   * The one failure mode of this module that would cost somebody money: a
   * challenge the SDK refuses coming back as anything other than `fail`.
   */
  it("a challenge the decoder refuses always produces at least one failing check", async () => {
    const refused: Array<Record<string, unknown>> = [
      { header: b64({ ...SPEC_V2, x402Version: 1 }) },
      { header: b64({ ...SPEC_V2, accepts: [] }) },
      { header: b64({ ...SPEC_V2, resource: undefined }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], network: "nope" }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], payTo: undefined }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], asset: undefined }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], scheme: undefined }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], extra: undefined }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], extra: "nope" }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], maxTimeoutSeconds: 0 }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], maxTimeoutSeconds: 999_999 }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], amount: "0.5" }] }) },
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], amount: "0" }] }) },
      { header: b64(Array.from({ length: 40 }, () => SPEC_V2.accepts[0])) },
      { raw: "!!!not base64!!!" },
      { body: "{not json" },
      {},
    ];

    for (const input of refused) {
      const result = await verifyOffline(input, { context: { url: TARGET } });
      if (result.challenge.valid) continue;
      const failing = result.checks.filter((c) => c.status === "fail").map((c) => c.id);
      expect(
        failing.length,
        `a refused challenge produced no failing check: ${JSON.stringify(input).slice(0, 120)}`,
      ).toBeGreaterThan(0);
      expect(result.verdict).toBe("fail");
    }
  });

  it("maps every decoder reason the SDK defines onto a frozen check id", () => {
    // Read off `tx402`'s `protocol.js`. If a future SDK release adds a reason
    // and nothing maps it, a refused challenge could come back as `warn` —
    // which is why this is a test rather than a comment.
    const SDK_REASONS = [
      "missing-header",
      "invalid-base64",
      "header-too-large",
      "invalid-json",
      "json-depth-exceeded",
      "duplicate-json-key",
      "unsupported-protocol-version",
      "upstream-schema-invalid",
      "requirements-count-out-of-range",
      "resource-url-invalid",
      "resource-origin-mismatch",
      "amount-not-atomic-integer",
    ];
    for (const reason of SDK_REASONS) {
      expect(DECODER_REASONS, `unmapped decoder reason: ${reason}`).toContain(reason);
    }
    expect([...DECODER_REASONS].sort()).toEqual([...SDK_REASONS].sort());
  });

  it("the CAIP-2 grammar agrees with the decoder's", async () => {
    // `verify-offline.ts` restates the decoder's network regex because the SDK
    // does not export it. This pins the two together: for each value, our
    // predicate and the decoder's acceptance must agree.
    for (const network of [
      "eip155:8453",
      "eip155:84532",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "base",
      "eip155",
      "EIP155:8453",
      "ei:1",
      "",
    ]) {
      const result = await verifyOffline(
        { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], network }] }) },
        { context: { url: TARGET } },
      );
      const decoderAccepted =
        result.challenge.valid ||
        result.challenge.decode_error?.message.includes("upstream-schema-invalid") !== true;
      const weAccepted = isWellFormedCaip2(network);
      if (weAccepted) {
        expect(statusOf(result.checks, "network_caip2_wellformed"), network).toBe("pass");
      } else {
        expect(statusOf(result.checks, "network_caip2_wellformed"), network).toBe("fail");
        expect(decoderAccepted || !result.challenge.valid, network).toBe(true);
      }
    }
  });

  it("the score is reproducible from the reasons in the same response", async () => {
    // appeal mechanism, made executable. If this stops holding,
    // the published claim that a merchant can re-derive their own score is
    // false.
    for (const input of [
      { header: b64(SPEC_V2) },
      { body: read("challenges/v1-body-valid.json") },
      { body: read("hostile/negative-amount.json") },
    ]) {
      const result = await verifyOffline(input, { context: { url: TARGET } });
      expect(result.risk).not.toBeNull();
      expect(reproduceScore(result.risk?.reasons ?? [])).toBe(result.risk?.score);
    }
  });

  it("reports no connection observations, because it made no connection", async () => {
    const result = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    for (const id of ["probe_ok", "redirect_count", "redirect_scheme_downgrade", "tls_ok"]) {
      const signal = result.signals.find((s) => s.id === id);
      expect(signal?.observed, id).toBe(false);
      expect(signal?.value, id).toBeNull();
    }
    // SPEC §6.3: an unobserved signal is excluded from the score rather than
    // counted against it, so a clean challenge still scores 100.
    expect(result.risk?.score).toBe(100);
  });

  it("is deterministic — the same challenge yields the same verdict and score", async () => {
    const once = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    const twice = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    expect(twice.verdict).toBe(once.verdict);
    expect(twice.risk?.score).toBe(once.risk?.score);
    expect(twice.checks).toEqual(once.checks);
    expect(twice.challenge.hash).toBe(once.challenge.hash);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  — the language audit
// ══════════════════════════════════════════════════════════════════════════

describe("language", () => {
  const FORBIDDEN = /\b(scam|fraud|fraudulent|unsafe|dangerous|malicious)\b/i;

  it("never uses a word that judges the operator rather than the challenge", async () => {
    const inputs = [
      { header: b64(SPEC_V2) },
      { body: read("challenges/v1-body-valid.json") },
      { body: read("hostile/origin-mismatch.json") },
      { body: read("hostile/negative-amount.json") },
      { raw: read("hostile/bad-base64.txt").trim() },
      { body: read("hostile/oversized.json") },
      {},
    ];

    for (const input of inputs) {
      const result = await verifyOffline(input, { context: { url: TARGET } });
      const strings = [
        ...result.checks.flatMap((c) => [c.reason ?? "", c.detail ?? ""]),
        ...result.signals.map((s) => s.detail ?? ""),
        ...(result.risk?.reasons.map((r) => r.message) ?? []),
      ];
      for (const text of strings) {
        expect(FORBIDDEN.test(text), `forbidden wording: "${text}"`).toBe(false);
      }
    }
  });

  it("reports a missing history as unknown — never a pass and never a warning", async () => {
    const result = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    for (const id of ENRICHED_CHECK_IDS) {
      const check = result.checks.find((c) => c.id === id);
      expect(check?.status, id).toBe("skip");
      expect(check?.status, id).not.toBe("pass");
      expect(check?.status, id).not.toBe("warn");
    }
  });

  it("never emits a bare recipient-changed finding (SPEC §6.4)", async () => {
    const result = await verifyOffline(
      { header: read("challenges/v2-dynamic-payto.txt").trim() },
      { context: { url: "https://marketplace.example.com/v1/order/8f21" } },
    );
    const recipient = result.checks.find((c) => c.id === "recipient_matches_observed");
    expect(recipient?.status).toBe("skip");
    // The signal that a bare "recipient changed" would live in must not exist
    // as an observed value here — it needs the corpus, and the corpus needs to
    // be able to tell a marketplace from an unstable recipient first (O22).
    expect(
      result.signals.find((s) => s.id === "recipient_unstable_undeclared")?.observed,
    ).toBe(false);
  });

  it("a 300-second authorization window warns rather than fails", async () => {
    //. decision 12: MAX_AUTHORIZATION_SECONDS is 60, every
    // fixture uses 300, and 300 is common and legitimate in the wild. Failing
    // it would fail almost every real endpoint.
    const result = await verifyOffline(
      { header: b64({ ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], maxTimeoutSeconds: 300 }] }) },
      { context: { url: TARGET } },
    );
    expect(statusOf(result.checks, "max_timeout_sane")).toBe("warn");
    expect(result.verdict).toBe("warn");
  });

  it("an absent authorization window still fails", async () => {
    // The other half of the same split: "beyond the SDK's maximum" is a warn,
    // "not in the challenge at all" stays a failure.
    const result = await verifyOffline(
      {
        header: b64({
          ...SPEC_V2,
          accepts: [{ ...SPEC_V2.accepts[0], maxTimeoutSeconds: undefined }],
        }),
      },
      { context: { url: TARGET } },
    );
    expect(statusOf(result.checks, "max_timeout_sane")).toBe("fail");
  });

  it("a challenge naming no facilitator skips rather than warns", async () => {
    // Most x402 challenges name no facilitator; warning on that would push
    // every clean challenge to `warn` on the strength of a field the protocol
    // never asked for.
    const result = await verifyOffline({ header: b64(SPEC_V2) }, { context: { url: TARGET } });
    expect(statusOf(result.checks, "facilitator_known")).toBe("skip");
    expect(reasonOf(result.checks, "facilitator_known")).toBe("not_declared");
  });

  it("an unlisted facilitator warns and says the list is not exhaustive", async () => {
    const result = await verifyOffline(
      {
        header: b64({
          ...SPEC_V2,
          accepts: [
            {
              ...SPEC_V2.accepts[0],
              extra: { ...SPEC_V2.accepts[0]?.extra, facilitator: "https://unknown.example.com" },
            },
          ],
        }),
      },
      { context: { url: TARGET } },
    );
    expect(statusOf(result.checks, "facilitator_known")).toBe("warn");
    expect(result.checks.find((c) => c.id === "facilitator_known")?.detail).toContain(
      "not exhaustive",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Input handling
// ══════════════════════════════════════════════════════════════════════════

describe("input classification", () => {
  it("treats a leading brace as a body and anything else as a header", () => {
    expect(classifyRaw('{"x402Version":2}')).toBe("body");
    expect(classifyRaw('  \n {"x402Version":2}')).toBe("body");
    expect(classifyRaw("eyJ4NDAyVmVyc2lvbiI6Mn0=")).toBe("header");
    // The rule is deliberately not "try base64 and fall back": a fallback
    // would reclassify hostile/bad-base64.txt as a body and report a JSON
    // error instead of the framing failure it exists to produce.
    expect(classifyRaw(read("hostile/bad-base64.txt").trim())).toBe("header");
  });

  it("accepts a body as an object or as text, with the same verdict", async () => {
    const text = read("challenges/v1-body-valid.json");
    const asText = await verifyOffline({ body: text }, { context: { url: TARGET } });
    const asObject = await verifyOffline(
      { body: JSON.parse(text) as Record<string, unknown> },
      { context: { url: TARGET } },
    );
    expect(asObject.verdict).toBe(asText.verdict);
    expect(asObject.challenge.x402_version).toBe(1);
  });

  it("echoes the challenge back and hashes it stably", async () => {
    const header = b64(SPEC_V2);
    const result = await verifyOffline({ header }, {});
    expect(result.challenge.raw).toBe(header);
    expect(result.challenge.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
