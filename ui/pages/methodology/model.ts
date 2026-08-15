/**
 * The methodology, built by interrogating the scorer rather than describing it.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * Nothing on `/methodology` is a claim about `score` that was typed by hand.
 * Weights and severities come from `V1_WEIGHTS` / `V1_SEVERITIES`; thresholds
 * from `V1_BANDS`; the coverage floor from `V1_COVERAGE_FLOOR`; the version
 * from `CURRENT_SCORE_VERSION`; the magnitude bands from `magnitudeBand`.
 * The per-signal sentences are obtained by **running `score` twice** — once
 * over a signal set built to pass every rule and once over one built to fail
 * every rule — and reading the `reasons[].message` it emits. So the wording a
 * merchant reads on this page is the same string the API would put in their
 * response, by construction and not by discipline.
 *
 * Only two columns cannot be derived that way — "passes when" and the
 * rationale — and those live in `published.ts`, generated from
 * `spec/risk-score.md` and pinned to it by `test/methodology-page.test.ts`.
 *
 * ── The worked example is a real score ────────────────────────────────────
 *
 * `WORKED_EXAMPLES` are not tables of numbers; they are the actual return
 * value of `score` over two signal sets, plus the output of
 * `reproduceScore` over the `reasons[]` it produced. makes
 * reproducibility the appeal mechanism, so the page shows a merchant the
 * arithmetic being redone on a concrete case rather than asserting that it
 * could be.
 *
 * All of it is pure: no I/O, no clock, no randomness, exactly like `score`.
 */

import {
  CURRENT_SCORE_VERSION,
  V1_BANDS,
  V1_COVERAGE_FLOOR,
  V1_SEVERITIES,
  V1_WEIGHTS,
  reproduceScore,
  score,
  type Band,
  type ReasonStatus,
  type Risk,
} from "../../../worker/lib/score.js";
import { magnitudeBand, type Signal } from "../../../worker/lib/signals.js";
import { PUBLISHED_PROSE } from "./published.js";

// ── driving the rules ─────────────────────────────────────────────────────

/**
 * A value that makes each rule pass, and one that makes it fail.
 *
 * This is the input that lets the page read its own copy out of `score`. It
 * is deliberately *not* a copy of the rule table: a wrong value here produces a
 * skip rather than a sentence, and `test/methodology-page.test.ts` asserts that
 * every signal in `V1_WEIGHTS` yields both a pass message and a fail message —
 * so a rule added to `score.ts` and not accounted for here fails the suite
 * instead of rendering a blank row.
 */
const DRIVERS: Readonly<Record<string, { pass: Signal["value"]; fail: Signal["value"] }>> =
  Object.freeze({
    challenge_decodes: { pass: true, fail: false },
    resource_origin_match: { pass: true, fail: false },
    amount_canonical: { pass: true, fail: false },
    pay_to_wellformed: { pass: true, fail: false },
    network_recognized: { pass: true, fail: false },
    asset_recognized: { pass: true, fail: false },
    facilitator_known: { pass: true, fail: false },
    scheme_known: { pass: true, fail: false },
    tls_ok: { pass: true, fail: false },
    timeout_sane: { pass: true, fail: false },
    // Inverted in the rule table: passing means the downgrade did NOT happen.
    redirect_scheme_downgrade: { pass: false, fail: true },
    wire_form: { pass: "v2-header", fail: "v1-body" },
    amount_magnitude_band: { pass: "small", fail: "extreme" },
  });

const SIGNAL_IDS: readonly string[] = Object.keys(V1_WEIGHTS);

function signalSet(pick: (id: string) => Signal["value"] | undefined): Signal[] {
  const signals: Signal[] = [{ id: "challenge_served", value: true, observed: true, detail: null }];
  for (const id of SIGNAL_IDS) {
    const value = pick(id);
    signals.push(
      value === undefined
        ? { id, value: null, observed: false, detail: "Not observed on this example." }
        : { id, value, observed: true, detail: null },
    );
  }
  return signals;
}

const allPassing = (): Signal[] => signalSet((id) => DRIVERS[id]?.pass);
const allFailing = (): Signal[] => signalSet((id) => DRIVERS[id]?.fail);

function messagesFrom(risk: Risk | null): Map<string, string> {
  return new Map((risk?.reasons ?? []).map((r) => [r.signal_id, r.message]));
}

const PASS_MESSAGES = messagesFrom(score(allPassing()));
const FAIL_MESSAGES = messagesFrom(score(allFailing()));

// ── the shape the page and the JSON both render ───────────────────────────

export interface MethodologySignal {
  signal_id: string;
  weight: number;
  severity: "fail" | "warn";
  /** Share of the total available weight, 0–1. Derived, never stated. */
  share: number;
  passes_when: string;
  rationale: string;
  /** The exact sentence the API emits when this signal passes. */
  on_pass: string;
  /** The exact sentence the API emits when it does not. */
  on_fail: string;
}

export interface WorkedExampleRow {
  signal_id: string;
  status: ReasonStatus;
  weight: number;
  message: string;
}

export interface WorkedExample {
  key: string;
  title: string;
  premise: string;
  rows: WorkedExampleRow[];
  earned: number;
  possible: number;
  score: number;
  band: Band;
  /** `reproduceScore(reasons)` — the same number, recomputed from the response. */
  reproduced: number;
  /** The reasons array a caller would hold, as JSON, for the appeal walkthrough. */
  reasons_json: string;
}

export interface MethodologyBand {
  band: Band;
  /** Inclusive lower bound; `null` means "no floor". */
  from: number | null;
  /** Inclusive upper bound; `null` means "no ceiling". */
  to: number | null;
}

export interface MethodologyData {
  score_version: string;
  total_available_weight: number;
  coverage_floor_percent: number;
  signals: MethodologySignal[];
  bands: MethodologyBand[];
  magnitude_examples: { whole_units: string; band: string }[];
  worked_examples: WorkedExample[];
  /** The arithmetic, as a formula a reader can apply to their own response. */
  formula: string;
  source_url: string;
  claim_path: string;
  optout_path: string;
}

export const TOTAL_AVAILABLE_WEIGHT = Object.values(V1_WEIGHTS).reduce((sum, w) => sum + w, 0);

export const FORMULA =
  'score = round(100 × Σ weight[status = "pass"] / Σ weight[status ≠ "skip"])';

/** Concrete amounts run through `magnitudeBand`, so the bands are demonstrated rather than asserted. */
const MAGNITUDE_SAMPLES = ["0.001", "0.05", "2.5", "40", "250"] as const;

function bandRows(): MethodologyBand[] {
  return [
    { band: "LOW", from: V1_BANDS.low, to: 100 },
    { band: "MEDIUM", from: V1_BANDS.medium, to: V1_BANDS.low - 1 },
    { band: "HIGH", from: 0, to: V1_BANDS.medium - 1 },
  ];
}

function signalRows(): MethodologySignal[] {
  const prose = new Map(PUBLISHED_PROSE.map((p) => [p.id, p]));

  return SIGNAL_IDS.map((id) => {
    const weight = V1_WEIGHTS[id] ?? 0;
    return {
      signal_id: id,
      weight,
      severity: V1_SEVERITIES[id] ?? "warn",
      share: weight / TOTAL_AVAILABLE_WEIGHT,
      passes_when: prose.get(id)?.passesWhen ?? "",
      rationale: prose.get(id)?.rationale ?? "",
      on_pass: PASS_MESSAGES.get(id) ?? "",
      on_fail: FAIL_MESSAGES.get(id) ?? "",
    };
  }).sort((a, b) => b.weight - a.weight);
}

function exampleFrom(
  key: string,
  title: string,
  premise: string,
  signals: Signal[],
): WorkedExample {
  const risk = score(signals);
  if (!risk) throw new Error(`methodology example "${key}" produced no score`);

  const scored = risk.reasons.filter((r) => r.status !== "skip");

  return {
    key,
    title,
    premise,
    rows: risk.reasons.map((r) => ({
      signal_id: r.signal_id,
      status: r.status,
      weight: r.weight,
      message: r.message,
    })),
    earned: scored.filter((r) => r.status === "pass").reduce((sum, r) => sum + r.weight, 0),
    possible: scored.reduce((sum, r) => sum + r.weight, 0),
    score: risk.score,
    band: risk.band,
    reproduced: reproduceScore(risk.reasons),
    reasons_json: JSON.stringify({ score: risk.score, band: risk.band, reasons: risk.reasons }, null, 2),
  };
}

/**
 * The second example mirrors the one published in `spec/risk-score.md`: a
 * non-atomic amount, which the strict decoder refuses.
 *
 * The interesting part is `amount_magnitude_band`, which **skips** rather than
 * failing — the band is computed from an atomic amount and there isn't one, so
 * it was never evaluable. Charging it as a second failure would bill one defect
 * twice, and rule 1 (unknown is not bad) is what stops that.
 */
function nonAtomicAmount(): Signal[] {
  const broken = new Set(["challenge_decodes", "amount_canonical"]);
  return signalSet((id) => {
    if (id === "amount_magnitude_band") return "unknown";
    return broken.has(id) ? DRIVERS[id]?.fail : DRIVERS[id]?.pass;
  });
}

export const WORKED_EXAMPLES: readonly WorkedExample[] = Object.freeze([
  exampleFrom(
    "everything-checked-out",
    "Everything we could check, checked out",
    "A v2 endpoint on a recognized network, priced in a recognized asset, through a facilitator on the published list.",
    allPassing(),
  ),
  exampleFrom(
    "non-atomic-amount",
    "One field is wrong: the amount is not atomic",
    'The amount is served as "0.01" where atomic units are required, so the strict decoder refuses the challenge.',
    nonAtomicAmount(),
  ),
]);

export function buildMethodology(): MethodologyData {
  return {
    score_version: CURRENT_SCORE_VERSION,
    total_available_weight: TOTAL_AVAILABLE_WEIGHT,
    coverage_floor_percent: V1_COVERAGE_FLOOR * 100,
    signals: signalRows(),
    bands: bandRows(),
    magnitude_examples: MAGNITUDE_SAMPLES.map((whole) => ({
      whole_units: whole,
      // 6 decimals is USDC; the band is a function of whole units, so any
      // consistent pair demonstrates the same boundary.
      band: magnitudeBand(String(Math.round(Number(whole) * 1e6)), 6),
    })),
    worked_examples: [...WORKED_EXAMPLES],
    formula: FORMULA,
    source_url:
      "https://github.com/neogeeks/tx402-tools/blob/main/spec/risk-score.md",
    claim_path: "/methodology#claim",
    optout_path: "/crawler",
  };
}
