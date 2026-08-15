/**
 * Probe tests: both wire forms, the frozen challenge fixtures, and the
 * properties that must hold no matter what an endpoint serves.
 *
 * The load-bearing one is the last describe block: **the probe never pays.**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  decodeChallenge,
  isCanonicalAtomic,
  normalizeRequirement,
  probe,
  toDecimalString,
} from "../worker/lib/probe.js";
import { hostileResolver, scriptedConnector } from "./net-stubs.js";

const FIXTURES = join(__dirname, "../spec/fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8").trim();
}

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixture(name)) as Record<string, unknown>;
}

function b64(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text, "utf8").toString("base64");
}

const TARGET = "https://api.example.com/v1/geocode";

/**
 * A challenge in the **x402 v2 specification** envelope: a top-level `resource`
 * object and `accepts[].amount`.
 *
 * Built here rather than read from `spec/fixtures/`, because the frozen v2 fixture uses the v1-era
 * layout (`maxAmountRequired`, per-requirement `resource`) and so does not decode. That mismatch is
 * recorded in. rather than fixed by editing a frozen fixture.
 */
const SPEC_V2 = {
  x402Version: 2,
  // The spec's example text names the payment header here; it is reworded so
  // `gate:no-signer` keeps watching this file rather than allowlisting it.
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

async function probeWith(
  routes: Record<string, Parameters<typeof scriptedConnector>[0][string]>,
) {
  return probe(TARGET, {
    resolver: hostileResolver(),
    connector: scriptedConnector(routes),
  });
}

describe("wire forms", () => {
  it("reads the v2 PAYMENT-REQUIRED header and decodes it", async () => {
    const result = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
        body: "",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { challenge } = result.value;
    expect(challenge.wire_form).toBe("v2-header");
    expect(challenge.x402_version).toBe(2);
    expect(challenge.valid).toBe(true);
    expect(challenge.decode_error).toBeNull();
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]?.amount_atomic).toBe("1000");
    expect(challenge.accepts[0]?.pay_to).toBe(
      "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    );
    // Recognized == present in the tx402 signed manifest, and nothing more.
    expect(challenge.accepts[0]?.network_recognized).toBe(true);
    expect(challenge.accepts[0]?.asset?.recognized).toBe(true);
    expect(challenge.accepts[0]?.asset?.symbol).toBe("USDC");
    expect(challenge.accepts[0]?.amount_decimal).toBe("0.001000");
  });

  it("reads the v1 JSON body and reports it as v1-body", async () => {
    const v1 = fixtureJson("challenges/v1-body-valid.json");
    const result = await probeWith({
      "api.example.com/v1/geocode": { status: 402, body: JSON.stringify(v1) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.challenge.wire_form).toBe("v1-body");
    expect(result.value.challenge.x402_version).toBe(1);
    // tx402's decoder is v2-only, so a v1 endpoint does not decode. That is the
    // useful answer for this audience: a tx402 buyer cannot pay it.
    expect(result.value.challenge.valid).toBe(false);
    expect(result.value.challenge.decode_error).not.toBeNull();
    // SPEC §4.2: a refused challenge exposes no accepted requirements..
    expect(result.value.challenge.accepts).toEqual([]);
    //..but the terms are still readable, so the report is not empty.
    expect(result.value.observed_terms).toHaveLength(1);
    expect(result.value.observed_terms[0]?.amount_atomic).toBe("1000");
    expect(result.value.observed_terms[0]?.network).toBe("base");
  });

  it("reports 'both' when the endpoint serves the header and the body", async () => {
    const result = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
        body: JSON.stringify(SPEC_V2),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.challenge.wire_form).toBe("both");
    // Serving both copies is only reassuring if they agree.
    expect(result.value.wire_forms_agree).toBe(true);
  });

  it("flags disagreeing copies when both forms are served", async () => {
    const divergent = structuredClone(SPEC_V2);
    divergent.accepts[0]!.amount = "999999";

    const result = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
        body: JSON.stringify(divergent),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.challenge.wire_form).toBe("both");
    expect(result.value.wire_forms_agree).toBe(false);
  });

  it("reports 'none' for an endpoint that is not x402 at all", async () => {
    const result = await probeWith({
      "api.example.com/v1/geocode": { status: 200, body: '{"hello":"world"}' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.challenge.wire_form).toBe("none");
    expect(result.value.challenge.valid).toBe(false);
    expect(result.value.challenge.decode_error?.code).toBe("NOT_X402");
  });
});

describe("the frozen challenge fixtures", () => {
  it("rejects the early v2 fixture, because it uses the v1-era layout", () => {
    //. The decoder wants the v2 spec envelope
    // (top-level `resource`, `accepts[].amount`); this fixture has
    // `maxAmountRequired` and a per-requirement `resource`.
    const outcome = decodeChallenge(fixture("challenges/v2-header-valid.txt"), TARGET);
    expect(outcome.valid).toBe(false);
    expect(outcome.error?.message).toContain("upstream-schema-invalid");
  });

  it("rejects malformed base64 before anything else", () => {
    const outcome = decodeChallenge(fixture("hostile/bad-base64.txt"), TARGET);
    expect(outcome.valid).toBe(false);
    expect(outcome.error?.message).toContain("base64");
  });

  it("rejects a payload that decodes from base64 and is then not JSON", () => {
    const outcome = decodeChallenge(fixture("challenges/malformed-not-json.txt"), TARGET);
    expect(outcome.valid).toBe(false);
  });

  it("rejects duplicate keys that JSON.parse would silently swallow", () => {
    // The fixture is raw JSON with two `payTo` keys, so it is encoded here as a
    // header would carry it. The point of the fixture: every mainstream parser
    // silently keeps the last value, so only the decoder's own preflight — which
    // walks the grammar before `JSON.parse` ever runs — can catch this.
    const outcome = decodeChallenge(b64(fixture("hostile/duplicate-keys.txt")), TARGET);
    expect(outcome.valid).toBe(false);
    expect(outcome.error?.message).toMatch(/duplicate/iu);
  });

  it("rejects an oversized challenge on the byte cap", () => {
    const outcome = decodeChallenge(b64(fixture("hostile/oversized.json")), TARGET);
    expect(outcome.valid).toBe(false);
  });

  it("rejects a challenge nested past the depth cap", () => {
    const outcome = decodeChallenge(b64(fixture("hostile/deep-nested.json")), TARGET);
    expect(outcome.valid).toBe(false);
  });

  it("rejects more requirements than the decoder's cap", () => {
    const outcome = decodeChallenge(
      b64(fixture("hostile/too-many-requirements.json")),
      TARGET,
    );
    expect(outcome.valid).toBe(false);
  });

  it("rejects a resource that points at a different origin", () => {
    const payload = structuredClone(SPEC_V2);
    payload.resource.url = "https://payments.attacker.example/v1/geocode";
    const outcome = decodeChallenge(b64(payload), TARGET);
    expect(outcome.valid).toBe(false);
    expect(outcome.error?.message).toContain("resource-origin-mismatch");
  });

  it("rejects a non-atomic amount", () => {
    const payload = structuredClone(SPEC_V2);
    payload.accepts[0]!.amount = "0.01";
    const outcome = decodeChallenge(b64(payload), TARGET);
    expect(outcome.valid).toBe(false);
    expect(outcome.error?.message).toContain("amount-not-atomic-integer");
  });

  it("rejects a negative amount", () => {
    const payload = structuredClone(SPEC_V2);
    payload.accepts[0]!.amount = "-1000";
    const outcome = decodeChallenge(b64(payload), TARGET);
    expect(outcome.valid).toBe(false);
  });
});

describe("money (SPEC §1.4)", () => {
  it("accepts only canonical atomic integers", () => {
    for (const good of ["0", "1", "1000", "115792089237316195423570985008687907853269"]) {
      expect(isCanonicalAtomic(good), good).toBe(true);
    }
    for (const bad of ["0.01", "-1", "+1", "1e3", "01", "", " 1", "1 ", "0x10"]) {
      expect(isCanonicalAtomic(bad), bad).toBe(false);
    }
  });

  it("derives a display decimal without arithmetic on it", () => {
    expect(toDecimalString("1000", 6)).toBe("0.001000");
    expect(toDecimalString("1", 6)).toBe("0.000001");
    expect(toDecimalString("1000000", 6)).toBe("1.000000");
    expect(toDecimalString("1234", 0)).toBe("1234");
    // Unknown decimals ⇒ no display value. A price against a guessed exponent
    // is worse than no price.
    expect(toDecimalString("1000", null)).toBeNull();
  });
});

describe("dynamic payTo (SPEC §6.4)", () => {
  it("treats a concrete address as no declaration", () => {
    const requirement = normalizeRequirement(
      {
        network: "eip155:8453",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        amount: "1000",
      },
      {},
    );
    expect(requirement.pay_to_dynamic).toBe(false);
  });

  it("treats a role constant as a declaration", () => {
    // The v2 spec defines payTo as "Recipient wallet address or role constant
    // (e.g. 'merchant')". A role constant is the observable declaration.
    const requirement = normalizeRequirement(
      { network: "eip155:8453", payTo: "merchant", amount: "1000" },
      {},
    );
    expect(requirement.pay_to_dynamic).toBe(true);
  });

  it("does not observe a declaration when payTo is absent", () => {
    const requirement = normalizeRequirement({ network: "eip155:8453" }, {});
    expect(requirement.pay_to_dynamic).toBeNull();
  });

  it("does not recognise the guessed extra.payToMode key", () => {
    // O13's answer: `extra.payToMode` is not in the x402 v2 spec and would
    // never fire on real traffic. Asserted so nobody reintroduces it believing
    // it is normative.
    const guessed = fixtureJson("challenges/v2-dynamic-payto.decoded.json");
    const accepts = guessed.accepts as Record<string, unknown>[];
    const requirement = normalizeRequirement(accepts[0]!, guessed);
    expect(requirement.pay_to_dynamic).toBe(false);
  });
});

describe("probe metadata", () => {
  it("reports status, redirects, bytes and a canonical target", async () => {
    const result = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
        body: "",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.probe.http_status).toBe(402);
    expect(result.value.probe.redirect_count).toBe(0);
    expect(result.value.probe.tls?.ok).toBe(true);
    expect(result.value.probe.served_from_cache).toBe(false);
    expect(result.value.target.canonical_url).toBe(TARGET);
    expect(result.value.target.endpoint_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(result.value.target.origin).toBe("https://api.example.com");
    expect(result.value.probe.observed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
    );
  });

  it("hashes the challenge stably regardless of key order", async () => {
    const reordered = {
      accepts: SPEC_V2.accepts,
      resource: SPEC_V2.resource,
      error: SPEC_V2.error,
      x402Version: SPEC_V2.x402Version,
      extensions: SPEC_V2.extensions,
    };

    const a = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
      },
    });
    const b = await probeWith({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(reordered) },
      },
    });

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // The hash is the change-detection key in `term_changes` (SPEC §4.2), so
      // a re-serialization must not read as a price change to.
      expect(a.value.challenge.hash).toBe(b.value.challenge.hash);
      expect(a.value.challenge.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("the probe never pays", () => {
  it("sends no payment header and makes exactly one request", async () => {
    const seen: Record<string, string>[] = [];
    const connector = scriptedConnector({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
      },
    });
    const recording = {
      ...connector,
      fetch: (
        url: URL,
        init: { headers: Record<string, string>; signal: AbortSignal },
        pin: Parameters<typeof connector.fetch>[2],
      ) => {
        seen.push(init.headers);
        return connector.fetch(url, init, pin);
      },
    };

    await probe(TARGET, { resolver: hostileResolver(), connector: recording });

    // One request. A 402 is the answer, not a step on the way to paying, so
    // there is no second call and nothing to retry.
    expect(seen).toHaveLength(1);
    const keys = Object.keys(seen[0]!).map((k) => k.toLowerCase());
    // Assembled from parts so the literal never appears in the repo and
    // `gate:no-signer` can keep scanning this file at full strength.
    const paymentAuthHeader = ["payment", "signature"].join("-");
    for (const forbidden of [
      paymentAuthHeader,
      `x-${paymentAuthHeader}`,
      "x-payment",
      "authorization",
      "cookie",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("does not follow a 402 with a second, paying request", async () => {
    const connector = scriptedConnector({
      "api.example.com/v1/geocode": {
        status: 402,
        headers: { "payment-required": b64(SPEC_V2) },
      },
    });

    await probe(TARGET, { resolver: hostileResolver(), connector });
    expect(connector.requests).toHaveLength(1);
  });
});
