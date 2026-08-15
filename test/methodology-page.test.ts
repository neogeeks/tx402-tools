/**
 * `/methodology` must be GENERATED from `worker/lib/score.ts` and
 * `spec/risk-score.md`, not transcribed from them — its first exit criterion.
 *
 * `test/methodology.test.ts` already pins the *document* to the
 * *function*. This file pins the *published page* to both, which is the half
 * that matters to the person the score is about: the document lives in a
 * repository they will not read, and the page is what they are handed.
 *
 * The failure this exists to make impossible: somebody adjusts a weight in
 * `score.ts`, the page keeps rendering the old number, and a published claim
 * about how we judge somebody quietly becomes false. is the reason
 * that is a release-blocking bug rather than a documentation nit.
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
  reproduceScore,
} from "../worker/lib/score.js";
import { magnitudeBand } from "../worker/lib/signals.js";
import { methodology } from "../worker/routes/methodology.js";
import { handleRequest } from "../worker/router.js";
import {
  PUBLISHED_PROSE,
  buildMethodology,
  inlineMarkdown,
  methodologyMarkdown,
  methodologyPage,
  type ClaimDocs,
} from "../ui/pages/methodology/index.js";
import { json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";

const DOC = readFileSync(join(__dirname, "../spec/risk-score.md"), "utf8");
const DATA = buildMethodology();

const DOCS: ClaimDocs = {
  origin: "https://tools.tx402.io",
  txtName: "_x402-tools",
  wellKnown: "/.well-known/x402-tools-claim",
  optoutWellKnown: "/.well-known/x402-tools-optout",
  tokenTtlHours: 72,
  defaultMethod: "dns-txt",
};

const HTML = methodologyPage({ data: DATA, docs: DOCS });
const MD = methodologyMarkdown(DATA, DOCS);

/**
 * The same extraction `ui/pages/methodology/published.ts` was generated with.
 * Re-run here so the generated module is checked against its source rather than
 * trusted to have been generated correctly once.
 */
function proseFromDocument(): { id: string; passesWhen: string; rationale: string }[] {
  const rows: { id: string; passesWhen: string; rationale: string }[] = [];
  const pattern = /^\|\s*`([a-z0-9_]+)`\s*\|\s*\*{0,2}\d+\*{0,2}\s*\|\s*(?:fail|warn)\s*\|(.*)\|\s*$/gmu;
  for (const match of DOC.matchAll(pattern)) {
    const rest = match[2] ?? "";
    const cut = rest.indexOf(" | ");
    rows.push({
      id: match[1]!,
      passesWhen: rest.slice(0, cut).trim(),
      rationale: rest.slice(cut + 3).trim(),
    });
  }
  return rows;
}

describe("the page is generated from score.ts, not typed", () => {
  it("publishes every scored signal and no others", () => {
    expect(DATA.signals.map((s) => s.signal_id).sort()).toEqual(Object.keys(V1_WEIGHTS).sort());
  });

  it("takes every weight and severity straight from the rule table", () => {
    for (const signal of DATA.signals) {
      expect(signal.weight, `${signal.signal_id} weight`).toBe(V1_WEIGHTS[signal.signal_id]);
      expect(signal.severity, `${signal.signal_id} severity`).toBe(V1_SEVERITIES[signal.signal_id]);
    }
  });

  it("publishes the total available weight the rule table actually adds up to", () => {
    const total = Object.values(V1_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(DATA.total_available_weight).toBe(total);
    expect(HTML).toContain(String(total));
    expect(MD).toContain(`Total available weight: **${total}**`);
  });

  it("publishes the band thresholds the scorer applies", () => {
    const byBand = new Map(DATA.bands.map((b) => [b.band, b]));
    expect(byBand.get("LOW")?.from).toBe(V1_BANDS.low);
    expect(byBand.get("MEDIUM")?.from).toBe(V1_BANDS.medium);
    expect(byBand.get("MEDIUM")?.to).toBe(V1_BANDS.low - 1);
    expect(byBand.get("HIGH")?.to).toBe(V1_BANDS.medium - 1);
  });

  it("publishes the coverage floor the scorer applies", () => {
    expect(DATA.coverage_floor_percent).toBe(V1_COVERAGE_FLOOR * 100);
    expect(MD).toContain(`less than **${V1_COVERAGE_FLOOR * 100}%**`);
  });

  it("publishes the version it is the methodology for", () => {
    expect(DATA.score_version).toBe(CURRENT_SCORE_VERSION);
  });

  it("reads its per-signal wording out of score() rather than restating it", () => {
    // A rule added to score.ts without a driver in model.ts renders a blank
    // sentence rather than the real one. That is the drift this catches.
    for (const signal of DATA.signals) {
      expect(signal.on_pass, `${signal.signal_id} pass message`).not.toBe("");
      expect(signal.on_fail, `${signal.signal_id} fail message`).not.toBe("");
      expect(signal.on_pass).not.toBe(signal.on_fail);
    }
  });

  it("demonstrates the magnitude bands by running the function", () => {
    for (const example of DATA.magnitude_examples) {
      const atomic = String(Math.round(Number(example.whole_units) * 1e6));
      expect(magnitudeBand(atomic, 6), example.whole_units).toBe(example.band);
    }
    expect(new Set(DATA.magnitude_examples.map((m) => m.band)).size).toBeGreaterThan(1);
  });
});

describe("the page is pinned to spec/risk-score.md", () => {
  const fromDoc = proseFromDocument();

  it("carries exactly the document's rows, in both directions", () => {
    expect(PUBLISHED_PROSE.map((p) => p.id).sort()).toEqual(fromDoc.map((r) => r.id).sort());
  });

  it("carries the document's prose verbatim", () => {
    const byId = new Map(PUBLISHED_PROSE.map((p) => [p.id, p]));
    for (const row of fromDoc) {
      const published = byId.get(row.id);
      expect(published?.passesWhen, `${row.id} passes-when`).toBe(row.passesWhen);
      expect(published?.rationale, `${row.id} rationale`).toBe(row.rationale);
    }
  });

  it("renders that prose on the page rather than a paraphrase of it", () => {
    for (const row of fromDoc) {
      expect(MD, `${row.id} rationale in the markdown mirror`).toContain(row.rationale);
    }
  });
});

describe("the worked examples are real scores, computed on the page", () => {
  it("scores the all-passing example the way the document publishes it", () => {
    const example = DATA.worked_examples[0]!;
    expect(example.score).toBe(100);
    expect(example.band).toBe("LOW");
    expect(example.possible).toBe(DATA.total_available_weight);
    expect(DOC).toContain("**`score = 100`, band `LOW`**");
  });

  it("scores the non-atomic-amount example the way the document publishes it", () => {
    const example = DATA.worked_examples[1]!;
    expect(example.score).toBe(65);
    expect(example.band).toBe("MEDIUM");
    expect(example.earned).toBe(70);
    expect(example.possible).toBe(107);
    expect(DOC).toContain("**`score = 65`, band `MEDIUM`**");

    // The published page makes a point of this: the band skips rather than
    // failing, so one defect is not charged twice.
    const byId = new Map(example.rows.map((r) => [r.signal_id, r]));
    expect(byId.get("amount_magnitude_band")?.status).toBe("skip");
    expect(byId.get("challenge_decodes")?.status).toBe("fail");
  });

  it("shows the arithmetic being redone, and it agrees", () => {
    // This IS the appeal mechanism. If it ever stops holding,
    // the reproducibility claim on the page is false.
    for (const example of DATA.worked_examples) {
      expect(reproduceScore(example.rows), example.key).toBe(example.score);
      expect(example.reproduced).toBe(example.score);
    }
  });

  it("hands the reader the JSON the arithmetic is done over", () => {
    for (const example of DATA.worked_examples) {
      const parsed = JSON.parse(example.reasons_json) as { reasons: unknown[] };
      expect(reproduceScore(parsed.reasons as never)).toBe(example.score);
      expect(HTML).toContain(`id="${example.key}"`);
    }
  });
});

describe("§6.2: the language rules, over the rendered output", () => {
  // Not over the source. A sentence assembled at render time from three
  // constants is exactly the one a source-level grep would miss.
  const BANNED = ["scam", "fraud", "fraudulent", "unsafe", "dangerous", "malicious"];

  for (const [name, rendered] of [
    ["the HTML page", HTML],
    ["the markdown mirror", MD],
    ["the JSON", JSON.stringify(DATA)],
  ] as const) {
    it(`${name} contains no judgement about an operator`, () => {
      for (const word of BANNED) {
        expect(rendered.toLowerCase(), `"${word}" in ${name}`).not.toContain(word);
      }
    });
  }

  it("says what a band is above the fold, before any band appears", () => {
    // Two framings, both required, in this order:
    //   1. its shared note, which every surface carries and which is the FIRST
    //      thing in the page shell. The band words appear inside it — that is
    //      the point, since it is the sentence that defines them — so it must
    //      open before the first band, not merely exist somewhere.
    //   2. This page's own longer argument, which every other surface's caveat
    //      links here to read. It has to precede the signal table and the
    //      worked examples, which is where a band is used as a verdict.
    for (const [name, rendered] of [
      ["the HTML page", HTML],
      ["the markdown mirror", MD],
    ] as const) {
      const sharedNoteAt = rendered.indexOf("These are observations, not accusations.");
      const bandAt = rendered.search(/\b(LOW|MEDIUM|HIGH)\b/u);
      const ownFramingAt = rendered.indexOf("statement about our observations");
      const firstVerdictAt = rendered.indexOf("band LOW");

      expect(sharedNoteAt, `${name} never says what a band is`).toBeGreaterThan(-1);
      expect(bandAt, `${name} shows a band`).toBeGreaterThan(-1);
      expect(sharedNoteAt, `${name} shows a band before the framing`).toBeLessThan(bandAt);

      expect(ownFramingAt, `${name} omits this page's own framing`).toBeGreaterThan(-1);
      expect(firstVerdictAt, `${name} renders a band as a verdict`).toBeGreaterThan(-1);
      expect(ownFramingAt, `${name} renders a verdict before framing it`).toBeLessThan(firstVerdictAt);
    }
  });

  it("carries the shared observation note as well as its own lede", () => {
    expect(HTML).toContain("These are observations, not accusations.");
    expect(MD).toContain("These are observations, not accusations.");
  });

  it("never claims a band describes an operator", () => {
    expect(HTML).toContain("never about the operator of an");
    expect(MD).toContain("never about the operator of an");
  });
});

describe("the route", () => {
  it("serves JSON that validates against the frozen schema", async () => {
    const res = await handleRequest(
      request("/methodology", { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(res.status).toBe(200);
    const body = await json<unknown>(res);
    const { ok, errors } = validateAgainst("methodology", body);
    expect(ok, errors).toBe(true);
  });

  it("stamps itself implemented and carries the score version", async () => {
    const res = await handleRequest(
      request("/methodology", { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    const body = await json<{ meta: { implemented: boolean; score_version: string } }>(res);
    expect(body.meta.implemented).toBe(true);
    expect(body.meta.score_version).toBe(CURRENT_SCORE_VERSION);
  });

  it("serves all three representations", async () => {
    for (const [accept, type] of [
      ["application/json", "application/json"],
      ["text/markdown", "text/markdown"],
      ["text/html", "text/html"],
    ] as const) {
      const res = await handleRequest(request("/methodology", { headers: { accept } }), mockEnv(), mockCtx());
      expect(res.headers.get("content-type"), accept).toContain(type);
      expect(res.status).toBe(200);
    }
  });

  it("serves the current version at ?v= and refuses one it has never published", async () => {
    const current = await handleRequest(
      request(`/methodology?v=${CURRENT_SCORE_VERSION}`, { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(current.status).toBe(200);

    // SPEC §7: every version's methodology stays published forever. Being
    // handed v1's rules while asking for v2's would be worse than a 404.
    const unknown = await handleRequest(
      request("/methodology?v=v99", { headers: { accept: "application/json" } }),
      mockEnv(),
      mockCtx(),
    );
    expect(unknown.status).toBe(404);
    const body = await unknown.json();
    expect(validateAgainst("error", body).ok).toBe(true);
  });

  it("is pure: two renders of the same version are byte-identical", () => {
    const ctx = {
      request: request("/methodology"),
      env: mockEnv(),
      ctx: mockCtx(),
      url: new URL("https://tools.tx402.io/methodology"),
      format: "markdown" as const,
      params: {},
      route: { tool: "methodology", implemented: true, negotiated: true },
    };
    const first = methodology(ctx) as Response;
    const second = methodology(ctx) as Response;
    return Promise.all([first.text(), second.text()]).then(([a, b]) => {
      expect(a).toBe(b);
    });
  });
});

describe("the inline markdown renderer", () => {
  it("renders the three constructs the document's cells use", () => {
    expect(inlineMarkdown("a `code` b")).toBe("a <code>code</code> b");
    expect(inlineMarkdown("*emphasis*")).toBe("<em>emphasis</em>");
    expect(inlineMarkdown("[list](#the-facilitator-list)")).toBe(
      '<a href="#the-facilitator-list">list</a>',
    );
  });

  it("escapes everything else, including inside the constructs", () => {
    expect(inlineMarkdown("<script>")).toBe("&lt;script&gt;");
    expect(inlineMarkdown("`<script>`")).toBe("<code>&lt;script&gt;</code>");
  });

  it("refuses a link scheme that is not an anchor, a path or https", () => {
    const out = inlineMarkdown("[x](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("javascript");
  });
});
