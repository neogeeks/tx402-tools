/**
 * `spec/risk-score.md` is the source of truth for `score_version: "v1"`, and
 * it is rendered at `/methodology`. Its exit criteria include a test that the
 * page and `score` agree exactly — this is the start of that test, written
 * here so inherits it rather than building it from scratch against code it
 * did not write.
 *
 * The failure this prevents is specific and likely: someone adjusts a weight in
 * `score.ts` and the published methodology quietly becomes a lie. A public risk
 * verdict whose stated method does not match its actual method is exactly the
 * liability exists to avoid.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CURRENT_SCORE_VERSION,
  V1_BANDS,
  V1_COVERAGE_FLOOR,
  V1_SEVERITIES,
  V1_WEIGHTS,
  score,
} from "../worker/lib/score.js";
import { extractSignals } from "../worker/lib/signals.js";
import { facilitatorOrigins } from "../worker/lib/facilitators.js";
import { probe, type ProbeResult } from "../worker/lib/probe.js";
import { hostileResolver, scriptedConnector } from "./net-stubs.js";

const DOC = readFileSync(join(__dirname, "../spec/risk-score.md"), "utf8");

/** Parse the weight table out of the published page. */
function publishedRows(): Map<string, { weight: number; severity: string }> {
  const rows = new Map<string, { weight: number; severity: string }>();
  const pattern =
    /^\|\s*`([a-z0-9_]+)`\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*(fail|warn)\s*\|/gmu;
  for (const match of DOC.matchAll(pattern)) {
    rows.set(match[1]!, { weight: Number(match[2]), severity: match[3]! });
  }
  return rows;
}

describe("the published methodology matches score()", () => {
  const published = publishedRows();

  it("publishes every signal the scorer uses, and no others", () => {
    expect([...published.keys()].sort()).toEqual(Object.keys(V1_WEIGHTS).sort());
  });

  it("publishes the same weight and severity for every signal", () => {
    for (const [id, row] of published) {
      expect(row.weight, `${id} weight`).toBe(V1_WEIGHTS[id]);
      expect(row.severity, `${id} severity`).toBe(V1_SEVERITIES[id]);
    }
  });

  it("publishes the correct total available weight", () => {
    const total = Object.values(V1_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(DOC).toContain(`**Total available weight: ${total}.**`);
  });

  it("publishes the band thresholds the scorer applies", () => {
    expect(DOC).toContain(`| \`LOW\` | \`>= ${V1_BANDS.low}\` |`);
    expect(DOC).toContain(`| \`MEDIUM\` | \`${V1_BANDS.medium} – ${V1_BANDS.low - 1}\` |`);
    expect(DOC).toContain(`| \`HIGH\` | \`< ${V1_BANDS.medium}\` |`);
  });

  it("publishes the coverage floor the scorer applies", () => {
    expect(DOC).toContain(`less than **${V1_COVERAGE_FLOOR * 100}%**`);
  });

  it("documents the version it is the source of truth for", () => {
    expect(DOC).toContain(`\`score_version: "${CURRENT_SCORE_VERSION}"\``);
  });
});

describe("the worked examples are real", () => {
  const TARGET = "https://api.example.com/v1/geocode";

  const challenge = (amount: string) => ({
    x402Version: 2,
    resource: { url: TARGET, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
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
  });

  async function probeOf(amount: string): Promise<ProbeResult> {
    const result = await probe(TARGET, {
      resolver: hostileResolver(),
      connector: scriptedConnector({
        "api.example.com/v1/geocode": {
          status: 402,
          headers: {
            "payment-required": Buffer.from(
              JSON.stringify(challenge(amount)),
              "utf8",
            ).toString("base64"),
          },
        },
      }),
    });
    if (!result.ok) throw new Error(`probe failed: ${result.failure.reason}`);
    return result.value;
  }

  const scoreOf = async (amount: string) =>
    score(
      extractSignals(await probeOf(amount), {
        knownFacilitators: facilitatorOrigins(),
      }),
    );

  it("the well-formed example scores 100 / LOW as published", async () => {
    const risk = await scoreOf("1000");
    expect(risk?.score).toBe(100);
    expect(risk?.band).toBe("LOW");
    expect(risk?.reasons.filter((r) => r.status !== "skip")).toHaveLength(13);
    expect(DOC).toContain("**`score = 100`, band `LOW`**");
  });

  it("the non-atomic-amount example scores 65 / MEDIUM as published", async () => {
    const risk = await scoreOf("0.01");
    expect(risk?.score).toBe(65);
    expect(risk?.band).toBe("MEDIUM");

    const byId = new Map(risk!.reasons.map((r) => [r.signal_id, r]));
    expect(byId.get("challenge_decodes")?.status).toBe("fail");
    expect(byId.get("amount_canonical")?.status).toBe("fail");
    // The published page makes a point of this one: it skips rather than
    // failing, so a single defect is not charged twice.
    expect(byId.get("amount_magnitude_band")?.status).toBe("skip");

    const scored = risk!.reasons.filter((r) => r.status !== "skip");
    expect(scored.reduce((sum, r) => sum + r.weight, 0)).toBe(107);
    expect(
      scored.filter((r) => r.status === "pass").reduce((sum, r) => sum + r.weight, 0),
    ).toBe(70);
    expect(DOC).toContain("**`score = 65`, band `MEDIUM`**");
  });
});

describe("the language rules are kept by the document itself", () => {
  it("contains no character judgement outside the sentence that bans them", () => {
    // The page names the banned words once, in the list of words it bans. Any
    // other occurrence would mean the methodology page itself broke §6.2.
    const banned = /\b(scam|fraudulent|malicious)\b/giu;
    const occurrences = [...DOC.matchAll(banned)];
    const banList = DOC.slice(
      DOC.indexOf("- The words"),
      DOC.indexOf("- Every surface that renders a band"),
    );
    for (const match of occurrences) {
      expect(banList).toContain(match[0]);
    }
  });
});
