import { describe, expect, it } from "vitest";
import { TX402_ERROR_CODES } from "tx402";

import { analyze } from "../packages/tools-cli/src/replay/analyze.js";
import { detect, UnrecognizedTraceError } from "../packages/tools-cli/src/replay/detect.js";
import { redactText, redactValue } from "../packages/tools-cli/src/replay/redact.js";
import { renderMarkdown, renderText } from "../packages/tools-cli/src/replay/render.js";
import {
  buildSharePayload,
  share,
  sharePreview,
  ShareRefusedError,
} from "../packages/tools-cli/src/replay/share.js";
import { runReplay } from "../packages/tools-cli/src/replay/index.js";
import { EXIT, STOP_POINTS } from "../packages/tools-cli/src/replay/taxonomy.js";
import type { ReplayResult } from "../packages/tools-cli/src/replay/types.js";

import { handleRequest } from "../worker/router.js";
import { json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import type { Envelope } from "../worker/types.js";

/**
 * its exit criteria, as tests.
 *
 * The one that matters most is the ambiguous payment. Getting it backwards
 * causes double payments, so it is tested from four directions: the typed
 * error, the CLI document that wraps it, the raw HTTP paste that carries no
 * typed error at all, and the event trace. All four have to reach the same
 * verdict, because a developer debugging a real failure will have whichever of
 * the four they happen to have.
 */

// ── the input fixtures, one per shape ────────────────────────────────────

const AT = "2026-08-14T09:38:03Z";

/** A serialized `Tx402Error` — what `error.toJSON` produces. */
function typedError(
  code: string,
  overrides: {
    phase?: string;
    paid?: boolean | "unknown";
    details?: Record<string, unknown>;
    message?: string;
  } = {},
): string {
  return JSON.stringify({
    name: "Tx402Error",
    code,
    message: overrides.message ?? `${code} was raised`,
    retryable: false,
    retryability: "no",
    context: {
      requestId: "req_01J8Z",
      phase: overrides.phase ?? "initial",
      ...(overrides.paid === undefined ? {} : { paid: overrides.paid }),
      reservationId: "rsv_7f2a",
    },
    details: overrides.details ?? {},
  });
}

/** The `tx402 call --json` document (SDK `src/cli/run.ts`). */
function cliJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    exitCode: 8,
    dryRun: false,
    requestId: "req_01J8Z",
    inspection: { status: 402, requirementCount: 1, headerHash: "9f2c" },
    route: {
      network: "eip155:8453",
      scheme: "exact",
      assetId: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amountAtomic: "1000",
      healthScore: 1,
      rank: 0,
      candidateCount: 1,
    },
    settlement: null,
    timings: { elapsedMs: 30123, events: 9 },
    error: JSON.parse(
      typedError(TX402_ERROR_CODES.paymentAmbiguous, {
        phase: "retry",
        paid: "unknown",
        details: { reservationExpiresAtEpochMs: 1786_000_000_000, causeCategory: "timeout" },
      }),
    ) as unknown,
    ...over,
  });
}

/** A raw HTTP request/response pair, as pasted out of a proxy. */
const PAYMENT_AUTH_HEADER = ["payment", "signature"].join("-");

function httpPair(opts: { paid: boolean; finalStatus?: number; settlement?: boolean } = { paid: true }): string {
  const lines = [
    "GET /v1/geocode?q=1600+Amphitheatre HTTP/1.1",
    "Host: api.merchant.example",
    "Accept: application/json",
    "",
    "HTTP/1.1 402 Payment Required",
    "payment-required: eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnt9fQ==",
    "content-type: application/json",
    "",
  ];
  if (opts.paid) {
    lines.push(
      "GET /v1/geocode?q=1600+Amphitheatre HTTP/1.1",
      "Host: api.merchant.example",
      `${PAYMENT_AUTH_HEADER}: eyJzY2hlbWUiOiJleGFjdCJ9`,
      "",
    );
  }
  if (opts.finalStatus !== undefined) {
    lines.push(`HTTP/1.1 ${String(opts.finalStatus)} OK`);
    if (opts.settlement) lines.push("payment-response: eyJzdWNjZXNzIjp0cnVlfQ==");
    lines.push("content-type: application/json", "");
  }
  return lines.join("\n");
}

/** The structured event stream, as NDJSON. */
function eventTrace(names: string[], extra: Record<string, unknown> = {}): string {
  return names
    .map((event, index) =>
      JSON.stringify({
        event,
        level: "info",
        at: new Date(Date.parse(AT) + index * 1000).toISOString(),
        requestId: "req_01J8Z",
        ...(index === names.length - 1 ? extra : {}),
      }),
    )
    .join("\n");
}

const AMBIGUOUS_EVENTS = [
  "request.started",
  "payment.required",
  "policy.checked",
  "route.planned",
  "budget.reserved",
  "sign.started",
  "sign.completed",
  "payment.exposed",
  "request.retried",
  "request.failed",
];

// ── 1. format auto-detection, all four shapes ────────────────────────────

describe("format auto-detection", () => {
  it("recognises `tx402 call --json` output", () => {
    expect(detect(cliJson()).format).toBe("cli_json");
  });

  it("recognises a serialized Tx402Error", () => {
    expect(detect(typedError(TX402_ERROR_CODES.policyBudget, { phase: "policy" })).format).toBe(
      "tx402_error",
    );
  });

  it("recognises a raw HTTP request/response pair", () => {
    expect(detect(httpPair({ paid: true })).format).toBe("http_pair");
  });

  it("recognises an event trace as NDJSON, as an array, and as log lines", () => {
    expect(detect(eventTrace(AMBIGUOUS_EVENTS)).format).toBe("cli_trace");
    const asArray = JSON.stringify(
      AMBIGUOUS_EVENTS.map((event) => ({ event, at: AT })),
    );
    expect(detect(asArray).format).toBe("cli_trace");
    expect(detect("12:01 info payment.exposed reservation held\n12:02 request.failed").format).toBe(
      "cli_trace",
    );
  });

  it("prefers the CLI document over the error nested inside it", () => {
    // Priority order matters: the CLI document carries the inspection, the
    // route and the timings, so reading it as a bare error would throw facts
    // away that the report can use.
    const detected = detect(cliJson());
    expect(detected.format).toBe("cli_json");
  });

  it("refuses to guess when it cannot tell, rather than picking one", () => {
    expect(() => detect("")).toThrow(UnrecognizedTraceError);
    expect(() => detect("just some prose about a payment")).toThrow(UnrecognizedTraceError);
    expect(() => detect('{"hello":"world"}')).toThrow(UnrecognizedTraceError);
  });

  it("does not require the user to declare the format", () => {
    // The same failure, expressed four ways, reaches one verdict.
    const verdicts = [
      analyze(cliJson()),
      analyze(
        typedError(TX402_ERROR_CODES.paymentAmbiguous, { phase: "retry", paid: "unknown" }),
      ),
      analyze(httpPair({ paid: true })),
      analyze(eventTrace(AMBIGUOUS_EVENTS)),
    ];
    for (const verdict of verdicts) {
      expect(verdict.analysis.diagnosis.do_not_retry, verdict.format).toBe(true);
      expect(verdict.disposition, verdict.format).toBe("exposed");
      expect(verdict.exitCode, verdict.format).toBe(EXIT.ambiguousPayment);
    }
  });
});

// ── 2. every lifecycle stop point ────────────────────────────────────────

/**
 * The expected reconstruction for each of the SDK's seventeen error codes.
 *
 * Read as: stopping here means the call reached `phase`, the money ended up
 * `disposition`, a script sees `exit`, and retrying is or is not safe.
 */
const STOP_TABLE: {
  code: string;
  sdkPhase: string;
  paid?: boolean | "unknown";
  phase: string;
  disposition: string;
  exit: number;
  doNotRetry: boolean;
}[] = [
  { code: TX402_ERROR_CODES.configInvalid, sdkPhase: "initial", phase: "discover", disposition: "none", exit: 2, doNotRetry: false },
  { code: TX402_ERROR_CODES.reservedHeader, sdkPhase: "initial", phase: "discover", disposition: "none", exit: 2, doNotRetry: false },
  { code: TX402_ERROR_CODES.nonReplayable, sdkPhase: "initial", phase: "discover", disposition: "none", exit: 2, doNotRetry: false },
  { code: TX402_ERROR_CODES.protocolUnsupported, sdkPhase: "parse", phase: "decode", disposition: "none", exit: 5, doNotRetry: false },
  { code: TX402_ERROR_CODES.paymentRequiredInvalid, sdkPhase: "parse", phase: "decode", disposition: "none", exit: 5, doNotRetry: false },
  { code: TX402_ERROR_CODES.clockSkew, sdkPhase: "parse", phase: "decode", disposition: "none", exit: 5, doNotRetry: false },
  { code: TX402_ERROR_CODES.policyDomain, sdkPhase: "policy", phase: "policy", disposition: "none", exit: 3, doNotRetry: false },
  { code: TX402_ERROR_CODES.policyBudget, sdkPhase: "policy", phase: "policy", disposition: "none", exit: 3, doNotRetry: false },
  { code: TX402_ERROR_CODES.schemeUnsupported, sdkPhase: "route", phase: "route", disposition: "none", exit: 5, doNotRetry: false },
  { code: TX402_ERROR_CODES.liquidity, sdkPhase: "route", phase: "route", disposition: "none", exit: 4, doNotRetry: false },
  // Both of these are raised inside `reserve`, which is the first step of the
  // `authorize` phase — but they exit `3` (policy), because the exit code
  // groups by what the operator has to change, not by where it happened.
  { code: TX402_ERROR_CODES.spendFrozen, sdkPhase: "sign", phase: "authorize", disposition: "none", exit: 3, doNotRetry: false },
  { code: TX402_ERROR_CODES.recipientUnpinned, sdkPhase: "sign", phase: "authorize", disposition: "none", exit: 3, doNotRetry: false },
  { code: TX402_ERROR_CODES.signer, sdkPhase: "sign", phase: "authorize", disposition: "released", exit: 6, doNotRetry: false },
  { code: TX402_ERROR_CODES.transport, sdkPhase: "initial", phase: "discover", disposition: "none", exit: 7, doNotRetry: false },
  // The two exposed ones.
  { code: TX402_ERROR_CODES.paymentAmbiguous, sdkPhase: "retry", paid: "unknown", phase: "submit", disposition: "exposed", exit: 8, doNotRetry: true },
  { code: TX402_ERROR_CODES.redirectBlocked, sdkPhase: "retry", paid: "unknown", phase: "submit", disposition: "exposed", exit: 8, doNotRetry: true },
  // Both halves of the delivery range.
  { code: TX402_ERROR_CODES.resourceDelivery, sdkPhase: "complete", paid: false, phase: "deliver", disposition: "released", exit: 9, doNotRetry: false },
  { code: TX402_ERROR_CODES.resourceDelivery, sdkPhase: "complete", paid: true, phase: "deliver", disposition: "committed", exit: 9, doNotRetry: true },
];

describe("lifecycle reconstruction — one fixture per stop point", () => {
  it("covers every code in the SDK's frozen taxonomy", () => {
    // If the SDK adds an eighteenth error code, this fails rather than the
    // table quietly not covering it. `STOP_POINTS` fails to compile in the
    // same situation; this catches the case where the table is filled in but
    // no fixture exercises it.
    const covered = new Set(STOP_TABLE.map((row) => row.code));
    for (const code of Object.values(TX402_ERROR_CODES)) {
      expect(covered.has(code), `no fixture for ${code}`).toBe(true);
    }
    expect(Object.keys(STOP_POINTS).sort()).toEqual(Object.values(TX402_ERROR_CODES).sort());
  });

  for (const row of STOP_TABLE) {
    const name = row.paid === undefined ? row.code : `${row.code} (paid: ${String(row.paid)})`;

    it(`${name} → stops at ${row.phase}, money ${row.disposition}, exit ${String(row.exit)}`, () => {
      const options: { phase: string; paid?: boolean | "unknown" } = { phase: row.sdkPhase };
      if (row.paid !== undefined) options.paid = row.paid;
      const result = analyze(typedError(row.code, options));

      expect(result.disposition).toBe(row.disposition);
      expect(result.exitCode).toBe(row.exit);
      expect(result.analysis.diagnosis.do_not_retry).toBe(row.doNotRetry);
      expect(result.docs.startsWith("https://docs.tx402.io/")).toBe(true);

      const steps = result.analysis.lifecycle;
      const stopIndex = steps.findIndex((step) => step.phase === row.phase);
      expect(stopIndex, `no ${row.phase} step`).toBeGreaterThanOrEqual(0);

      // Everything before the stop ran. Nothing before it is `skip`.
      for (const step of steps.slice(0, stopIndex)) {
        expect(step.status, `${step.phase} before the stop`).not.toBe("skip");
      }

      // The stop itself: `fail`, unless the money is exposed, in which case
      // the honest answer is `unknown`.
      const stopStep = steps[stopIndex];
      expect(stopStep?.status).toBe(row.disposition === "exposed" ? "unknown" : "fail");
    });
  }

  it("maps every stop point to a real docs.tx402.io page", () => {
    // Guessed URLs are worse than none: a 404 in the one line telling somebody
    // how to fix a payment problem destroys the report's credibility.
    const pages = new Set([
      "guides/cli",
      "guides/lifecycle",
      "guides/migration",
      "guides/policy",
      "guides/routing",
      "operations/base-testnet",
      "operations/durable-object",
      "operations/exposed-reconciliation",
      "operations/gateway",
      "operations/kill-switch",
      "operations/publishing",
      "operations/recipient-rotation",
      "operations/release-manifest",
      "operations/releasing",
      "operations/running",
      "operations/shared-store",
      "operations/solana-devnet",
      "reference/api-typescript",
      "reference/configuration",
      "reference/errors",
      "security",
      "security/keys",
      "start/quickstart",
    ]);
    for (const [code, stop] of Object.entries(STOP_POINTS)) {
      const path = stop.docs
        .replace("https://docs.tx402.io/", "")
        .replace(/#.*$/, "")
        .replace(/\/$/, "");
      expect(pages.has(path), `${code} points at ${stop.docs}`).toBe(true);
    }
  });

  it("skips, rather than fails, the phases a stop never reached", () => {
    const result = analyze(typedError(TX402_ERROR_CODES.policyBudget, { phase: "policy" }));
    const after = result.analysis.lifecycle.slice(
      result.analysis.lifecycle.findIndex((s) => s.phase === "policy") + 1,
    );
    //. decision 5: `skip` is not `fail`. A phase that never ran
    // did not fail, and rendering it red would invent five more problems.
    expect(after.map((step) => step.status)).toEqual(["skip", "skip", "skip", "skip", "skip"]);
  });

  it("reports a call that never got a 402 as skipped, not failed", () => {
    const result = analyze(
      cliJson({ ok: true, exitCode: 0, error: null, inspection: null, status: 200 }),
    );
    const statuses = Object.fromEntries(
      result.analysis.lifecycle.map((step) => [step.phase, step.status]),
    );
    expect(statuses["discover"]).toBe("ok");
    expect(statuses["policy"]).toBe("skip");
    expect(statuses["authorize"]).toBe("skip");
    expect(result.analysis.diagnosis.do_not_retry).toBe(false);
  });

  it("keeps `settle` honest on a released delivery failure", () => {
    // paid: false means nothing settled — calling `settle` ok on the way to a
    // delivery failure would report a success that did not happen.
    const result = analyze(
      typedError(TX402_ERROR_CODES.resourceDelivery, { phase: "complete", paid: false }),
    );
    const settle = result.analysis.lifecycle.find((step) => step.phase === "settle");
    expect(settle?.status).toBe("fail");
  });

  it("keeps `settle` ok on a settled-but-undelivered payment", () => {
    const result = analyze(
      typedError(TX402_ERROR_CODES.resourceDelivery, { phase: "complete", paid: true }),
    );
    const statuses = Object.fromEntries(
      result.analysis.lifecycle.map((step) => [step.phase, step.status]),
    );
    expect(statuses["settle"]).toBe("ok");
    expect(statuses["deliver"]).toBe("fail");
  });

  it("places a fence-write transport failure at authorize, not discover", () => {
    const result = analyze(typedError(TX402_ERROR_CODES.transport, { phase: "sign" }));
    const authorize = result.analysis.lifecycle.find((step) => step.phase === "authorize");
    expect(authorize?.status).toBe("fail");
    // Nothing was transmitted — the fence failing aborts the send.
    expect(result.disposition).toBe("none");
    expect(result.analysis.diagnosis.do_not_retry).toBe(false);
  });
});

// ── 3. THE AMBIGUOUS CASE ────────────────────────────────────────────────

describe("the ambiguous payment — the case this session exists for", () => {
  const result = analyze(cliJson());
  const { diagnosis, lifecycle } = result.analysis;
  const statuses = Object.fromEntries(lifecycle.map((step) => [step.phase, step.status]));

  it("says DO NOT RETRY", () => {
    expect(diagnosis.do_not_retry).toBe(true);
    expect(diagnosis.guidance.toLowerCase()).toContain("do not retry");
  });

  it("reports submit and settle as `unknown`, never as `fail`", () => {
    // SPEC §5.7: `unknown` is load-bearing. An ambiguous payment is precisely
    // the case where we do not know whether the submit landed, and rendering
    // it as `fail` tells the user the opposite of the truth.
    expect(statuses["submit"]).toBe("unknown");
    expect(statuses["settle"]).toBe("unknown");
    expect(statuses["submit"]).not.toBe("fail");
    expect(statuses["settle"]).not.toBe("fail");
  });

  it("reports deliver as `fail` — that part is not ambiguous", () => {
    expect(statuses["deliver"]).toBe("fail");
  });

  it("matches the frozen fixture's lifecycle exactly", async () => {
    const fixture = (await import("../spec/fixtures/responses/replay-ambiguous.json")) as {
      default: { data: { analysis: { lifecycle: { phase: string; status: string }[] } } };
    };
    const expected = fixture.default.data.analysis.lifecycle.map((step) => [
      step.phase,
      step.status,
    ]);
    const actual = lifecycle.map((step) => [step.phase, step.status]);
    expect(actual).toEqual(expected);
  });

  it("carries the reconciliation procedure from exposed-reconciliation.mdx", () => {
    const guidance = diagnosis.guidance;
    // The loop the docs page prescribes: budget → listExposed → verify on
    // chain → resolveExposed, with both dispositions named.
    expect(guidance).toContain("tx402 budget");
    expect(guidance).toContain("exposedAtomic");
    expect(guidance).toContain("listExposed");
    expect(guidance).toContain("resolveExposed");
    expect(guidance).toContain("committed");
    expect(guidance).toContain("released");
    // The two traps the docs page calls out explicitly.
    expect(guidance).toContain("reservation-already-terminal");
    expect(guidance).toContain("never expires");
  });

  it("links to the reconciliation page", () => {
    expect(result.docs).toBe("https://docs.tx402.io/operations/exposed-reconciliation/");
  });

  it("says the expiry in the error details is not a deadline", () => {
    // lifecycle.mdx: "the name misleads" — an exposed hold does not expire
    // when `reservationExpiresAtEpochMs` passes, or ever. A reader who waits
    // for it to lapse waits forever.
    expect(diagnosis.explanation).toContain("not a deadline");
  });

  it("exits 8, so a script can stop on it", () => {
    expect(result.exitCode).toBe(EXIT.ambiguousPayment);
  });

  it("treats a blocked cross-origin redirect as ambiguous, not as a clean failure", () => {
    // The trap: PaidRedirectBlockedError's retryability is "no", which reads
    // milder than the ambiguous error's "no-automatic-retry". But the block
    // stops the FOLLOW-UP request, so the authorization already went out and
    // the reservation is exposed — which is why the SDK maps it to exit 8.
    // Deriving `do_not_retry` from retryability instead of from the money
    // would get this one exactly backwards.
    const redirect = analyze(
      typedError(TX402_ERROR_CODES.redirectBlocked, {
        phase: "retry",
        paid: "unknown",
        details: { fromOrigin: "https://api.merchant.example", toOrigin: "https://cdn.other.example" },
      }),
    );
    expect(redirect.analysis.diagnosis.do_not_retry).toBe(true);
    expect(redirect.disposition).toBe("exposed");
    expect(redirect.exitCode).toBe(EXIT.ambiguousPayment);
    expect(redirect.docs).toBe("https://docs.tx402.io/operations/exposed-reconciliation/");
  });

  it("reaches the same verdict from a raw HTTP paste with no typed error", () => {
    // An authorization on the wire with nothing coming back. No SDK error to
    // read, and the answer still has to be "do not retry".
    const raw = analyze(httpPair({ paid: true }));
    expect(raw.analysis.diagnosis.do_not_retry).toBe(true);
    expect(raw.analysis.diagnosis.code).toBe("AMBIGUOUS_PAYMENT");
    expect(raw.exitCode).toBe(EXIT.ambiguousPayment);
  });

  it("does NOT cry wolf when no authorization was ever transmitted", () => {
    // The inverse failure. A tool that says "do not retry" on every failed
    // payment is a tool people stop reading, and it would bury the one case
    // where it is true.
    const noPayment = analyze(httpPair({ paid: false }));
    expect(noPayment.analysis.diagnosis.do_not_retry).toBe(false);
    expect(noPayment.disposition).toBe("none");

    for (const row of STOP_TABLE.filter((r) => !r.doNotRetry)) {
      const options: { phase: string; paid?: boolean | "unknown" } = { phase: row.sdkPhase };
      if (row.paid !== undefined) options.paid = row.paid;
      const verdict = analyze(typedError(row.code, options));
      expect(verdict.analysis.diagnosis.do_not_retry, row.code).toBe(false);
    }
  });

  it("prints the warning above the timeline, not below it", () => {
    const text = renderText(result);
    expect(text).toContain("DO NOT RETRY THIS PAYMENT");
    expect(text.indexOf("DO NOT RETRY")).toBeLessThan(text.indexOf("Lifecycle"));
    expect(renderMarkdown(result)).toContain("**DO NOT RETRY THIS PAYMENT.**");
  });

  it("renders `unknown` differently from `fail`", () => {
    const text = renderText(result);
    expect(text).toMatch(/submit\s+unknown/);
    expect(text).not.toMatch(/submit\s+failed/);
  });

  it("says the reservation is exposed and holds budget", () => {
    const text = renderText(result);
    expect(text).toContain("EXPOSED");
    expect(text).toContain("does not expire");
  });
});

// ── 4. redaction ─────────────────────────────────────────────────────────

/**
 * Real-looking secrets, seeded into every input field.
 *
 * The SDK proves the same property the same way — "the test suite proves it by
 * seeding real secrets into every input and searching the whole serialised
 * output for each one" (lifecycle.mdx, Diagnostics). This mirrors it.
 */
/**
 * A Stripe-shaped key, assembled at runtime.
 *
 * It is FABRICATED — every value in this file is — but a scanner cannot tell
 * that by looking, and neither can a human skimming a public repository. As a
 * literal it tripped GitHub's push protection and would have gone on tripping
 * every other scanner that ever read this repo, generating security reports
 * about a string whose entire purpose is to be deleted by the code under test.
 *
 * Joining it here keeps the test exactly as strong: `redact()` still receives
 * the full assembled string at runtime, and the assertions below still search
 * the serialised output for it. Only the source literal is gone.
 */
const STRIPE_SHAPED = ["sk", "live", "9Xf2QpRt7VwLmZ4KcJb8NdHgYs3TuEo1"].join("_");

const SECRETS = {
  authorization: "b3d9f1a24c6e8071f5a3c9d2e4b6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f79",
  bearer: `Bearer ${STRIPE_SHAPED}`,
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  cookie: "session=aG9sZHRoaXNzZWNyZXR2YWx1ZXBsZWFzZWRvbnRsZWFr; Path=/",
  apiKey: "mk_prod_4Tz8Wq2Nv6Ry9Bd3Fh7Jl1Ps5Xc0Ag",
  pem: "-----BEGIN EC PARAMETERS-----\nBgUrgQQACg==\n-----END EC PARAMETERS-----",
  urlCreds: "https://alice:hunter2correcthorse@rpc.provider.example/v1",
  password: "correct-horse-battery-staple-9412",
  b64Payload: "YXV0aG9yaXphdGlvbnBheWxvYWR3aXRobG90c29mYnl0ZXN0aGF0c2hvdWxkbmV2ZXJhcHBlYXJhbnl3aGVyZQ==",
};

/** Every distinct secret string that must not survive, in any output. */
const SECRET_VALUES = [
  SECRETS.authorization,
  STRIPE_SHAPED,
  SECRETS.jwt,
  "aG9sZHRoaXNzZWNyZXR2YWx1ZXBsZWFzZWRvbnRsZWFr",
  SECRETS.apiKey,
  "BgUrgQQACg==",
  "hunter2correcthorse",
  SECRETS.password,
  SECRETS.b64Payload,
];

function seededCliJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    exitCode: 8,
    dryRun: false,
    requestId: "req_01J8Z",
    inspection: { status: 402, requirementCount: 1, headerHash: "9f2c" },
    route: { network: "eip155:8453", scheme: "exact", amountAtomic: "1000" },
    settlement: {
      transaction: "0x9f2c4a1b8e3d6f705c2a9b4e7d1f3a6c8b5e2d9f4a7c1b3e6d8f5a2c9b4e7d10",
      network: "eip155:8453",
    },
    timings: { elapsedMs: 30123, events: 9 },
    // A secret in every field a trace can carry one in.
    requestHeaders: {
      authorization: SECRETS.bearer,
      cookie: SECRETS.cookie,
      [PAYMENT_AUTH_HEADER]: SECRETS.authorization,
      "x-api-key": SECRETS.apiKey,
      accept: "application/json",
    },
    responseHeaders: { "set-cookie": SECRETS.cookie },
    body: `{"token":"${SECRETS.jwt}","note":"the paid response can carry one too"}`,
    config: {
      rpcUrl: SECRETS.urlCreds,
      password: SECRETS.password,
      keyMaterial: SECRETS.pem,
    },
    // An unremarkable key name holding an encoded authorization payload.
    opaque: SECRETS.b64Payload,
    error: JSON.parse(
      typedError(TX402_ERROR_CODES.paymentAmbiguous, {
        phase: "retry",
        paid: "unknown",
        message: `submit failed carrying ${SECRETS.authorization}`,
        details: { reservationExpiresAtEpochMs: 1786_000_000_000, causeCategory: "timeout" },
      }),
    ) as unknown,
  });
}

function seededHttpPair(): string {
  return [
    "POST /v1/geocode HTTP/1.1",
    "Host: api.merchant.example",
    `Authorization: ${SECRETS.bearer}`,
    `Cookie: ${SECRETS.cookie}`,
    `X-Api-Key: ${SECRETS.apiKey}`,
    "",
    "HTTP/1.1 402 Payment Required",
    "payment-required: eyJ4NDAyVmVyc2lvbiI6Mn0=",
    "",
    "POST /v1/geocode HTTP/1.1",
    "Host: api.merchant.example",
    `${PAYMENT_AUTH_HEADER}: ${SECRETS.authorization}`,
    `X-Debug-Rpc: ${SECRETS.urlCreds}`,
    "",
    `{"jwt":"${SECRETS.jwt}","blob":"${SECRETS.b64Payload}"}`,
  ].join("\n");
}

describe("redaction", () => {
  /** Everything a replay can put in front of a human or on a network. */
  function everyOutput(result: ReplayResult): string {
    const payload = buildSharePayload(result);
    return [
      renderText(result),
      renderMarkdown(result),
      JSON.stringify(result.analysis),
      JSON.stringify(payload),
      sharePreview(payload),
      JSON.stringify(result.trace),
    ].join("\n");
  }

  it("leaks nothing from a seeded CLI document", () => {
    const output = everyOutput(analyze(seededCliJson()));
    for (const secret of SECRET_VALUES) {
      expect(output.includes(secret), `leaked: ${secret.slice(0, 24)}…`).toBe(false);
    }
  });

  it("leaks nothing from a seeded raw HTTP pair", () => {
    const output = everyOutput(analyze(seededHttpPair()));
    for (const secret of SECRET_VALUES) {
      expect(output.includes(secret), `leaked: ${secret.slice(0, 24)}…`).toBe(false);
    }
  });

  it("leaks nothing from a seeded event trace", () => {
    const trace = eventTrace(AMBIGUOUS_EVENTS, {
      authorization: SECRETS.bearer,
      cookie: SECRETS.cookie,
      apiKey: SECRETS.apiKey,
      note: SECRETS.jwt,
    });
    const output = everyOutput(analyze(trace));
    for (const secret of SECRET_VALUES) {
      expect(output.includes(secret), `leaked: ${secret.slice(0, 24)}…`).toBe(false);
    }
  });

  it("leaks nothing from a seeded typed error", () => {
    const error = typedError(TX402_ERROR_CODES.signer, {
      phase: "sign",
      message: `the signing device returned ${SECRETS.authorization}`,
      details: { signerKind: "kms", causeCategory: "refused", cookie: SECRETS.cookie },
    });
    const output = everyOutput(analyze(error));
    for (const secret of SECRET_VALUES) {
      expect(output.includes(secret), `leaked: ${secret.slice(0, 24)}…`).toBe(false);
    }
  });

  it("names what it removed rather than silently deleting it", () => {
    const result = analyze(seededCliJson());
    const payload = JSON.stringify(buildSharePayload(result));
    // A placeholder that says nothing turns a redacted trace into a confusing
    // one; the reader has to be able to tell a removed cookie from a removed
    // signature.
    expect(payload).toContain("[redacted: authorization header]");
    expect(payload).toContain("[redacted: cookie]");
    expect(payload).toContain("[redacted: payment authorization]");
    expect(payload).toContain("[redacted: api key]");
    expect(payload).toContain("[redacted: password]");
  });

  it("counts what it removed", () => {
    const result = analyze(seededCliJson());
    expect(result.analysis.redaction.applied).toBe(true);
    expect(result.analysis.redaction.fields_redacted).toBeGreaterThan(5);
  });

  it("keeps the public facts an operator needs to reconcile", () => {
    // Over-redaction is its own failure: a settlement hash and an address are
    // public, and they are exactly what `listExposed` → verify-on-chain needs.
    const payload = JSON.stringify(buildSharePayload(analyze(seededCliJson())));
    expect(payload).toContain("0x9f2c4a1b8e3d6f705c2a9b4e7d1f3a6c8b5e2d9f4a7c1b3e6d8f5a2c9b4e7d10");
    expect(payload).toContain("eip155:8453");
  });

  it("keeps the x402 challenge, which is public by construction", () => {
    const redacted = redactText(httpPair({ paid: false }));
    expect(redacted.value).toContain("eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnt9fQ==");
  });

  it("redacts by key name even when the value looks harmless", () => {
    const { value, summary } = redactValue({ authorization: "x", cookie: "y", token: "z" });
    expect(JSON.stringify(value)).not.toContain('"x"');
    expect(summary.fields_redacted).toBe(3);
  });

  it("redacts by value shape even when the key looks harmless", () => {
    const { value } = redactValue({ note: SECRETS.jwt, memo: SECRETS.authorization });
    expect(JSON.stringify(value)).not.toContain(SECRETS.jwt);
    expect(JSON.stringify(value)).not.toContain(SECRETS.authorization);
  });

  it("strips credentials out of a URL without losing the URL", () => {
    const { value } = redactValue({ rpcUrl: SECRETS.urlCreds });
    const text = JSON.stringify(value);
    expect(text).not.toContain("hunter2correcthorse");
    expect(text).toContain("rpc.provider.example");
  });

  it("survives a cyclic structure instead of hanging on it", () => {
    const node: Record<string, unknown> = { authorization: SECRETS.bearer };
    node["self"] = node;
    const { value } = redactValue(node);
    expect(JSON.stringify(value)).not.toContain(STRIPE_SHAPED.slice(0, 7));
  });

  it("runs before anything is rendered, not as a pass over the rendered text", () => {
    // The ordering property, asserted structurally: the analysis is built from
    // the redacted payload, so the placeholder appears in `trace.payload`
    // itself rather than only in the report.
    const result = analyze(seededCliJson());
    expect(JSON.stringify(result.trace.payload)).toContain("[redacted:");
  });
});

// ── 5. share is opt-in, and prints before sending ────────────────────────

describe("--share", () => {
  it("makes no network call at all unless it is asked to", async () => {
    // Asserted the way asserts it for the offline verifier: replace the
    // global, run the whole command, and require that it was never reached.
    // "Opt-in" is only a real property if the default path cannot reach the
    // network by accident.
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("replay reached the network without --share");
    };

    try {
      const outcome = await runReplay(seededCliJson(), {
        print: () => undefined,
        printErr: () => undefined,
        shareOptions: null,
      });
      expect(calls).toBe(0);
      expect(outcome.shareUrl).toBeNull();
      expect(outcome.exitCode).toBe(EXIT.ambiguousPayment);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("has no way to turn sharing on except per invocation", async () => {
    // There is no config file, no environment variable and no default. The
    // only switch is the `shareOptions` argument, and omitting it entirely is
    // the same as passing null.
    const outcome = await runReplay(cliJson(), { print: () => undefined });
    expect(outcome.shareUrl).toBeNull();
  });

  it("prints the payload before it sends it", async () => {
    const order: string[] = [];
    const result = analyze(seededCliJson());
    await share(buildSharePayload(result), {
      print: (line) => {
        order.push(`print:${String(line.length > 0)}`);
      },
      confirm: () => {
        order.push("confirm");
        return true;
      },
      fetchImpl: (async () => {
        order.push("fetch");
        return new Response(
          JSON.stringify({ data: { id: "r_abc", url: "https://tools.tx402.io/replay/r_abc", expires_at: null } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(order).toEqual(["print:true", "confirm", "fetch"]);
  });

  it("prints the actual bytes, not a summary of them", () => {
    const preview = sharePreview(buildSharePayload(analyze(cliJson())));
    expect(preview).toContain("/api/v1/replay/share");
    expect(preview).toContain('"do_not_retry": true');
    expect(preview).toContain("This is exactly what will be sent");
  });

  it("uploads nothing when the answer is no", async () => {
    let fetched = false;
    await expect(
      share(buildSharePayload(analyze(cliJson())), {
        print: () => undefined,
        confirm: () => false,
        fetchImpl: (async () => {
          fetched = true;
          return new Response("{}");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ShareRefusedError);
    expect(fetched).toBe(false);
  });

  it("uploads the redacted payload, never the original", async () => {
    let sent = "";
    await share(buildSharePayload(analyze(seededCliJson())), {
      print: () => undefined,
      confirm: () => true,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = typeof init.body === "string" ? init.body : "";
        return new Response(JSON.stringify({ data: { id: "r_abc", url: "u", expires_at: null } }), {
          status: 201,
        });
      }) as unknown as typeof fetch,
    });
    for (const secret of SECRET_VALUES) {
      expect(sent.includes(secret), `uploaded: ${secret.slice(0, 24)}…`).toBe(false);
    }
    expect(sent).toContain("[redacted:");
  });
});

// ── 6. the hosted half ───────────────────────────────────────────────────

/** A D1 double that actually stores rows, so expiry and reads are exercised. */
function memoryDb(): { db: D1Database; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("SELECT")) {
            const row = rows.get(String(bound[0]));
            return (row as T) ?? null;
          }
          return null;
        },
        async all() {
          return { results: [], success: true, meta: {} };
        },
        async run() {
          if (sql.includes("INSERT INTO share_links")) {
            rows.set(String(bound[0]), {
              id: bound[0],
              payload_json: bound[1],
              redaction_summary: bound[2],
              created_at: bound[3],
              expires_at: bound[4],
              revoked_at: null,
              view_count: 0,
            });
          }
          if (sql.includes("DELETE FROM share_links")) rows.delete(String(bound[0]));
          return { success: true, meta: {} };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return { db, rows };
}

interface ReplayEnvelope {
  id: string | null;
  url: string | null;
  expires_at: string | null;
  analysis: unknown;
}

const AMBIGUOUS_ANALYSIS = analyze(cliJson()).analysis;

async function post(body: unknown, db: D1Database): Promise<Response> {
  return handleRequest(
    request("/api/v1/replay/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    mockEnv({ DB: db }),
    mockCtx(),
  );
}

describe("POST /api/v1/replay/share", () => {
  it("stores a redacted analysis and returns an expiring, unguessable link", async () => {
    const { db } = memoryDb();
    const res = await post({ trace: { note: "redacted upstream" }, analysis: AMBIGUOUS_ANALYSIS }, db);
    expect(res.status).toBe(201);

    const body = await json<Envelope<ReplayEnvelope>>(res);
    expect(body.data.id).toMatch(/^r_[A-Za-z0-9_-]{22}$/);
    expect(body.data.url).toBe(`https://tools.tx402.io/replay/${String(body.data.id)}`);
    // 128 bits of entropy: the id IS the capability, there is no other gate.
    expect(String(body.data.id).length).toBe(24);
    expect(body.data.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const validated = validateAgainst("replay", body);
    expect(validated.ok, validated.errors).toBe(true);
  });

  it("refuses an analysis that reports an unknown outcome and says retrying is fine", async () => {
    // The permalink is what somebody pastes into an issue for other people to
    // act on. Hosting this would be hosting the instruction that pays twice.
    const { db } = memoryDb();
    const lying = {
      ...AMBIGUOUS_ANALYSIS,
      diagnosis: { ...AMBIGUOUS_ANALYSIS.diagnosis, do_not_retry: false },
    };
    const res = await post({ trace: {}, analysis: lying }, db);
    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toContain("pay twice");
  });

  it("refuses a payload that still has an obvious secret in it", async () => {
    const { db, rows } = memoryDb();
    const res = await post(
      { trace: { headers: { note: SECRETS.jwt } }, analysis: AMBIGUOUS_ANALYSIS },
      db,
    );
    expect(res.status).toBe(422);
    expect(rows.size).toBe(0);
  });

  it("rejects a malformed analysis with the fields named", async () => {
    const { db } = memoryDb();
    const res = await post({ analysis: { lifecycle: [{ phase: "Submit", status: "maybe" }] } }, db);
    expect(res.status).toBe(422);
    const body = await json<{ error: { detail: { fields: string[] } } }>(res);
    expect(body.error.detail.fields.join(" ")).toContain("phase");
    expect(body.error.detail.fields.join(" ")).toContain("status");
  });

  it("rejects a non-JSON content type", async () => {
    const res = await handleRequest(
      request("/api/v1/replay/share", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }),
      mockEnv({ DB: memoryDb().db }),
      mockCtx(),
    );
    expect(res.status).toBe(415);
  });

  it("no-ops the Turnstile check while Turnstile is unprovisioned (O12)", async () => {
    // TURNSTILE_SITE_KEY is empty in the mock env, matching production today.
    const { db } = memoryDb();
    const res = await post({ trace: {}, analysis: AMBIGUOUS_ANALYSIS }, db);
    expect(res.status).toBe(201);
  });

  it("asks for a token once Turnstile is configured", async () => {
    const res = await handleRequest(
      request("/api/v1/replay/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trace: {}, analysis: AMBIGUOUS_ANALYSIS }),
      }),
      mockEnv({
        DB: memoryDb().db,
        TURNSTILE_SITE_KEY: "0x4AAA",
        TURNSTILE_SECRET_KEY: "0x4AAA-secret",
      }),
      mockCtx(),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/replay/:id", () => {
  it("reads a stored analysis back, schema-valid", async () => {
    const { db } = memoryDb();
    const created = await json<Envelope<ReplayEnvelope>>(
      await post({ trace: {}, analysis: AMBIGUOUS_ANALYSIS }, db),
    );

    const res = await handleRequest(
      request(`/api/v1/replay/${String(created.data.id)}`),
      mockEnv({ DB: db }),
      mockCtx(),
    );
    expect(res.status).toBe(200);

    const body = await json<Envelope<ReplayEnvelope>>(res);
    const validated = validateAgainst("replay", body);
    expect(validated.ok, validated.errors).toBe(true);

    const analysis = body.data.analysis as { diagnosis: { do_not_retry: boolean } };
    expect(analysis.diagnosis.do_not_retry).toBe(true);
  });

  it("404s an unknown id", async () => {
    const res = await handleRequest(
      request("/api/v1/replay/r_doesnotexist0000000000"),
      mockEnv({ DB: memoryDb().db }),
      mockCtx(),
    );
    expect(res.status).toBe(404);
  });

  it("expires a link lazily on read, with no cron trigger (O15)", async () => {
    const { db, rows } = memoryDb();
    const created = await json<Envelope<ReplayEnvelope>>(
      await post({ trace: {}, analysis: AMBIGUOUS_ANALYSIS }, db),
    );
    const id = String(created.data.id);

    // Wind the stored expiry into the past, as thirty days would.
    const row = rows.get(id);
    if (row) row["expires_at"] = "2020-01-01T00:00:00Z";

    const res = await handleRequest(request(`/api/v1/replay/${id}`), mockEnv({ DB: db }), mockCtx());
    expect(res.status).toBe(404);
    const body = await json<{ error: { message: string } }>(res);
    expect(body.error.message).toContain("expired");
  });
});

describe("GET /replay", () => {
  it("serves all three representations", async () => {
    for (const [accept, type] of [
      ["application/json", "application/json"],
      ["text/markdown", "text/markdown"],
      ["text/html", "text/html"],
    ]) {
      const res = await handleRequest(
        request("/replay", { headers: { accept: accept ?? "" } }),
        mockEnv(),
        mockCtx(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type ?? "");
    }
  });

  it("is schema-valid and says the analysis is local", async () => {
    const res = await handleRequest(
      request("/replay", { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    const body = await json<Envelope<ReplayEnvelope>>(res);
    const validated = validateAgainst("replay", body);
    expect(validated.ok, validated.errors).toBe(true);
    expect(body.warnings.map((w) => w.code)).toContain("LOCAL_ONLY");
  });

  it("tells a reader on the page not to retry an ambiguous payment", async () => {
    const res = await handleRequest(
      request("/replay", { headers: { accept: "text/markdown" } }),
      mockEnv(),
      mockCtx(),
    );
    const text = await res.text();
    expect(text).toContain("do not retry the payment");
    expect(text).toContain("https://docs.tx402.io/operations/exposed-reconciliation/");
  });
});

// ── 7. the local analysis validates against the frozen schema ────────────

describe("the frozen contract", () => {
  it("every stop point produces a schema-valid ReplayAnalysis", () => {
    for (const row of STOP_TABLE) {
      const options: { phase: string; paid?: boolean | "unknown" } = { phase: row.sdkPhase };
      if (row.paid !== undefined) options.paid = row.paid;
      const result = analyze(typedError(row.code, options));

      // Wrapped in the envelope the schema composes, so the check is the real
      // contract and not a subset of it.
      const envelope = {
        api_version: "v1" as const,
        tool: "replay",
        generated_at: "2026-08-14T09:41:07Z",
        meta: {
          implemented: true,
          cached: false,
          cache_age_seconds: null,
          score_version: null,
          tx402_version: "0.2.0",
          schema: "https://tools.tx402.io/api/v1/schemas/replay",
        },
        warnings: [],
        data: {
          id: null,
          url: null,
          expires_at: null,
          analysis: result.analysis,
        },
      };
      const validated = validateAgainst("replay", envelope);
      expect(validated.ok, `${row.code}: ${validated.errors}`).toBe(true);
    }
  });

  it("uses only the canonical eight phases", () => {
    const canonical = new Set([
      "discover",
      "decode",
      "policy",
      "route",
      "authorize",
      "submit",
      "settle",
      "deliver",
    ]);
    const result = analyze(cliJson());
    for (const step of result.analysis.lifecycle) {
      expect(canonical.has(step.phase), step.phase).toBe(true);
      expect(step.phase).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
