/**
 * Scoring tests.
 *
 * Three properties matter more than any individual number here, because they
 * are the ones makes public promises about:
 *
 *   1. **Deterministic** — same signals, same score, always.
 *   2. **Reproducible from the response** — `reasons[]` carries every applied
 *      weight, so the score can be re-derived from the same JSON. That is the
 *      appeal mechanism, so it is asserted rather than assumed.
 *   3. **It does not cry wolf** — an unobserved signal never counts as a
 *      failure (SPEC §6.3), and a declared-dynamic recipient is never treated
 *      as instability (SPEC §6.4).
 */

import { describe, expect, it } from "vitest";

import { extractSignals, magnitudeBand, type Signal } from "../worker/lib/signals.js";
import {
  CURRENT_SCORE_VERSION,
  V1_BANDS,
  V1_WEIGHTS,
  assertNoBareRecipientSignal,
  bandFor,
  reproduceScore,
  score,
} from "../worker/lib/score.js";
import { facilitatorOrigins } from "../worker/lib/facilitators.js";
import { probe, type ProbeResult } from "../worker/lib/probe.js";
import { hostileResolver, scriptedConnector } from "./net-stubs.js";

const TARGET = "https://api.example.com/v1/geocode";

const SPEC_V2 = {
  x402Version: 2,
  resource: { url: TARGET, mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: {
        name: "USD Coin",
        version: "2",
        facilitator: "https://x402.org/facilitator",
      },
    },
  ],
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function probeOf(payload: unknown, status = 402): Promise<ProbeResult> {
  const result = await probe(TARGET, {
    resolver: hostileResolver(),
    connector: scriptedConnector({
      "api.example.com/v1/geocode": {
        status,
        headers: payload ? { "payment-required": b64(payload) } : {},
        body: "",
      },
    }),
  });
  if (!result.ok) throw new Error(`probe failed: ${result.failure.reason}`);
  return result.value;
}

function signalsOf(result: ProbeResult): Signal[] {
  return extractSignals(result, { knownFacilitators: facilitatorOrigins() });
}

describe("determinism", () => {
  it("returns an identical result for identical signals", async () => {
    const signals = signalsOf(await probeOf(SPEC_V2));
    const a = score(signals);
    const b = score(structuredClone(signals));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not depend on signal ordering", async () => {
    const signals = signalsOf(await probeOf(SPEC_V2));
    const shuffled = [...signals].reverse();
    expect(score(shuffled)?.score).toBe(score(signals)?.score);
  });

  it("refuses an unknown score_version rather than guessing", () => {
    expect(() => score([], "v99")).toThrow(/only comparable within one version/iu);
  });
});

describe("reproducibility is the appeal mechanism", () => {
  it("re-derives the score from reasons[] alone", async () => {
    for (const payload of [
      SPEC_V2,
      { ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], amount: "0.01" }] },
      { ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], payTo: "not-an-address" }] },
      { ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], network: "eip155:999999" }] },
    ]) {
      const risk = score(signalsOf(await probeOf(payload)));
      expect(risk).not.toBeNull();
      if (risk) {
        // Anyone holding the response can do this arithmetic themselves.
        expect(reproduceScore(risk.reasons)).toBe(risk.score);
      }
    }
  });

  it("reports a weight for every signal it evaluated, and zero for skips", async () => {
    const risk = score(signalsOf(await probeOf(SPEC_V2)));
    expect(risk).not.toBeNull();
    if (!risk) return;

    for (const reason of risk.reasons) {
      if (reason.status === "skip") expect(reason.weight).toBe(0);
      else expect(reason.weight).toBeGreaterThan(0);
      expect(reason.message.length).toBeGreaterThan(0);
    }
    expect(risk.signals_evaluated).toBe(
      risk.reasons.filter((r) => r.status !== "skip").length,
    );
    expect(risk.score_version).toBe(CURRENT_SCORE_VERSION);
    expect(risk.methodology_url).toContain(`v=${CURRENT_SCORE_VERSION}`);
  });
});

describe("unknown is not bad (SPEC §6.3)", () => {
  it("skips an unobserved signal instead of failing it", () => {
    const observed: Signal[] = [
      { id: "challenge_served", value: true, observed: true, detail: null },
      { id: "challenge_decodes", value: true, observed: true, detail: null },
      { id: "tls_ok", value: true, observed: true, detail: null },
    ];
    const risk = score(observed);
    expect(risk).not.toBeNull();
    if (!risk) return;

    // Everything we could see, checked out.
    expect(risk.score).toBe(100);
    const skipped = risk.reasons.filter((r) => r.status === "skip");
    expect(skipped.length).toBeGreaterThan(0);
    for (const reason of skipped) expect(reason.weight).toBe(0);
  });

  it("holds the band back when coverage is thin rather than inventing confidence", () => {
    const thin: Signal[] = [
      { id: "challenge_served", value: true, observed: true, detail: null },
      { id: "tls_ok", value: true, observed: true, detail: null },
    ];
    const risk = score(thin);
    expect(risk?.score).toBe(100);
    // 100 from two signals is not a LOW-caution verdict.
    expect(risk?.band).not.toBe("LOW");
    expect(risk?.reasons.some((r) => r.signal_id === "coverage")).toBe(true);
  });

  it("never lets an unobserved signal reduce the score", async () => {
    const full = signalsOf(await probeOf(SPEC_V2));
    const withUnknowns = full.map((s) =>
      s.id === "facilitator_known" ? { ...s, value: null, observed: false } : s,
    );
    const before = score(full)!;
    const after = score(withUnknowns)!;
    // The facilitator passed before; making it unknown must not push the score
    // down — it leaves the ratio alone.
    expect(after.score).toBeGreaterThanOrEqual(before.score);
  });
});

describe("the dynamic-payTo carve-out (SPEC §6.4)", () => {
  it("forbids a bare recipient-changed signal in the rule table", () => {
    expect(() => assertNoBareRecipientSignal()).not.toThrow();
    expect(() =>
      assertNoBareRecipientSignal([
        {
          id: "recipient_changed",
          weight: 10,
          severity: "fail",
          passes: () => true,
          onPass: "",
          onFail: "",
        },
      ]),
    ).toThrow(/§6.4/u);
  });

  it("scores no recipient-instability signal in v1", async () => {
    const risk = score(signalsOf(await probeOf(SPEC_V2)));
    const ids = risk?.reasons.map((r) => r.signal_id) ?? [];
    expect(ids).not.toContain("recipient_changed");
    // The historical half arrives with the corpus; until then it is unscoreable, not
    // assumed good and not assumed bad.
    expect(ids).not.toContain("recipient_unstable_undeclared");
  });

  it("does not treat a declared role-constant recipient as malformed", async () => {
    const marketplace = {
      ...SPEC_V2,
      accepts: [{ ...SPEC_V2.accepts[0], payTo: "merchant" }],
    };
    const signals = signalsOf(await probeOf(marketplace));
    const wellFormed = signals.find((s) => s.id === "pay_to_wellformed");
    const declared = signals.find((s) => s.id === "pay_to_declared_dynamic");

    expect(declared?.value).toBe(true);
    // A marketplace is not a rug. Its role constant must not be
    // scored as a broken address.
    expect(wellFormed?.value).toBe(true);
  });
});

describe("language", () => {
  const BANNED = /\b(scam|fraud|fraudulent|unsafe|dangerous|malicious)\b/iu;

  it("emits no character judgement in any reason message", async () => {
    for (const payload of [
      SPEC_V2,
      { ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], amount: "0.01" }] },
      { ...SPEC_V2, accepts: [{ ...SPEC_V2.accepts[0], payTo: "zzz" }] },
      { ...SPEC_V2, x402Version: 1 },
    ]) {
      const risk = score(signalsOf(await probeOf(payload)));
      for (const reason of risk?.reasons ?? []) {
        expect(reason.message, reason.signal_id).not.toMatch(BANNED);
      }
    }
  });
});

describe("bands", () => {
  it("uses the published thresholds", () => {
    expect(bandFor(100)).toBe("LOW");
    expect(bandFor(V1_BANDS.low)).toBe("LOW");
    expect(bandFor(V1_BANDS.low - 1)).toBe("MEDIUM");
    expect(bandFor(V1_BANDS.medium)).toBe("MEDIUM");
    expect(bandFor(V1_BANDS.medium - 1)).toBe("HIGH");
    expect(bandFor(0)).toBe("HIGH");
  });

  it("declares static_only confidence until the corpus exists", async () => {
    expect(score(signalsOf(await probeOf(SPEC_V2)))?.confidence).toBe("static_only");
  });
});

describe("nothing to score", () => {
  it("returns null for an endpoint that served no challenge", async () => {
    const result = await probeOf(null, 200);
    // A URL that is not an x402 endpoint is not a risky endpoint. Rendering a
    // band here would be a verdict about something we never assessed.
    expect(score(signalsOf(result))).toBeNull();
  });
});

describe("a well-formed v2 endpoint scores well", () => {
  it("lands in LOW with a recognized network, asset and facilitator", async () => {
    const risk = score(signalsOf(await probeOf(SPEC_V2)));
    expect(risk).not.toBeNull();
    if (!risk) return;

    expect(risk.band).toBe("LOW");
    expect(risk.score).toBeGreaterThanOrEqual(V1_BANDS.low);

    const byId = new Map(risk.reasons.map((r) => [r.signal_id, r]));
    expect(byId.get("challenge_decodes")?.status).toBe("pass");
    expect(byId.get("resource_origin_match")?.status).toBe("pass");
    expect(byId.get("facilitator_known")?.status).toBe("pass");
    expect(byId.get("network_recognized")?.status).toBe("pass");
  });

  it("penalises a challenge the strict decoder refuses", async () => {
    const broken = {
      ...SPEC_V2,
      accepts: [{ ...SPEC_V2.accepts[0], amount: "0.01" }],
    };
    const risk = score(signalsOf(await probeOf(broken)));
    expect(risk).not.toBeNull();
    if (!risk) return;

    const decodes = risk.reasons.find((r) => r.signal_id === "challenge_decodes");
    expect(decodes?.status).toBe("fail");
    expect(decodes?.weight).toBe(V1_WEIGHTS.challenge_decodes);
    expect(risk.score).toBeLessThan(V1_BANDS.low);
  });
});

describe("magnitude bands", () => {
  it("bands amounts in whole units of the asset", () => {
    expect(magnitudeBand("1000", 6)).toBe("micro");
    expect(magnitudeBand("100000", 6)).toBe("small");
    expect(magnitudeBand("5000000", 6)).toBe("medium");
    expect(magnitudeBand("50000000", 6)).toBe("large");
    expect(magnitudeBand("500000000", 6)).toBe("extreme");
  });

  it("returns unknown rather than guessing when decimals are unknown", () => {
    expect(magnitudeBand("1000", null)).toBe("unknown");
    expect(magnitudeBand(null, 6)).toBe("unknown");
  });
});
