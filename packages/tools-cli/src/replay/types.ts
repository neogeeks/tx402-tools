/**
 * 402 Replay — the shapes.
 *
 * Contract: spec/SPEC.md §5.7 · Schema: spec/schemas/replay.json
 *
 * `ReplayAnalysis` is the frozen contract; everything else here is internal to
 * the CLI. The analysis is produced locally and is the only thing `--share`
 * ever uploads, alongside the redacted trace.
 */

// ── the frozen contract (spec/schemas/replay.json) ───────────────────────

/**
 * Canonical phase vocabulary (SPEC §5.7).
 *
 * The schema constrains the *shape* (`^[a-z][a-z0-9_]*$`), not the membership,
 * so the SDK's own coarser taxonomy can be mapped on without an addendum. The
 * mapping is in `lifecycle.ts`.
 */
export const PHASES = [
  "discover",
  "decode",
  "policy",
  "route",
  "authorize",
  "submit",
  "settle",
  "deliver",
] as const;

export type Phase = (typeof PHASES)[number];

/**
 * `skip` is not `pass` and `unknown` is not `fail`.
 *
 * - `ok`      — the phase ran and succeeded.
 * - `fail`    — the phase ran and failed, and we know that it failed.
 * - `skip`    — the phase never ran, because an earlier one stopped the call.
 * - `unknown` — the phase may or may not have completed and we cannot tell.
 *               This is the ambiguous payment, and rendering it as `fail`
 *               tells the reader the opposite of the truth.
 */
export type PhaseStatus = "ok" | "fail" | "skip" | "unknown";

export interface LifecycleStep {
  phase: string;
  status: PhaseStatus;
  at?: string | null;
  detail?: string | null;
}

export interface Diagnosis {
  code: string;
  title: string;
  explanation: string;
  guidance: string;
  /**
   * True whenever money may have moved. A correctness requirement, not a
   * suggestion: the merchant may hold a valid authorization and a retry can
   * pay twice.
   */
  do_not_retry: boolean;
}

export interface RedactionSummary {
  applied: boolean;
  fields_redacted: number;
}

export interface ReplayAnalysis {
  lifecycle: LifecycleStep[];
  diagnosis: Diagnosis;
  redaction: RedactionSummary;
}

// ── internal: what a trace looks like once parsed ────────────────────────

/** The four input shapes, in the priority order the detector tries them. */
export type TraceFormat = "cli_json" | "tx402_error" | "http_pair" | "cli_trace";

/**
 * Where the money ended up. Derived from the SDK's own failure table
 * (docs/guides/lifecycle.mdx, "Failure modes, by where they happen"), and the
 * single input to `do_not_retry`.
 *
 * - `none`      — no reservation was ever taken.
 * - `released`  — a reservation was taken and given back. Nothing was
 *                 transmitted, or the merchant refused with no settlement.
 * - `exposed`   — the authorization went on the wire and the outcome is
 *                 unknown. The reservation does not expire; it is held until
 *                 an operator reconciles it.
 * - `committed` — the payment settled. The money moved.
 */
export type Disposition = "none" | "released" | "exposed" | "committed";

/**
 * A parsed, **redacted** trace.
 *
 * The brand is not decoration. `analyze` is the only place that mints one —
 * it does so immediately after parsing and before anything else reads the
 * input — and every consumer downstream takes this type. Writing
 * `__redacted: true` by hand somewhere else is possible, but it is a
 * deliberate act with an obvious name, which is the point: routing around the
 * redactor has to be a decision rather than an omission.
 */
export interface RedactedTrace {
  readonly __redacted: true;
  format: TraceFormat;
  /** Redacted trace body, as uploaded by `--share`. */
  payload: unknown;
  /** The tx402 error code, if the trace carries one. */
  errorCode?: string | null;
  /** The SDK's own phase from `context.phase`, if present. */
  sdkPhase?: string | null;
  /** `context.paid` — `true`, `false` or the third state, `"unknown"`. */
  paid?: boolean | "unknown" | null;
  /** The error's own message, if the trace carries one. */
  message?: string | null;
  /** `details` from a typed error — redaction-safe by construction, but swept anyway. */
  details?: Record<string, unknown>;
  /** HTTP status of the resource response, if observed. */
  status?: number | null;
  /** Whether a 402 challenge was observed at all. */
  sawChallenge?: boolean;
  /** Whether the trace shows a paid retry being transmitted. */
  sawTransmission?: boolean;
  /** Whether a settlement response was read back. */
  sawSettlement?: boolean;
  /** Event names seen, for a CLI trace. */
  events?: string[];
  /** Timestamps per phase, where the trace carried them. */
  timestamps?: Partial<Record<Phase, string>>;
  /** Per-phase free-text detail recovered from the trace. */
  notes?: Partial<Record<Phase, string>>;
  redaction: RedactionSummary;
}

/** What `analyze` returns: the redacted trace plus its reconstruction. */
export interface ReplayResult {
  format: TraceFormat;
  trace: RedactedTrace;
  analysis: ReplayAnalysis;
  /** The CLI exit code this stop point maps to (SDK `src/cli/exit-codes.ts`). */
  exitCode: number;
  /** Where the money ended up. */
  disposition: Disposition;
  /** The docs.tx402.io page that explains this stop point. */
  docs: string;
}
