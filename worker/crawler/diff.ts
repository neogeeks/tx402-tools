/**
 * Change detection.
 *
 * is the whole of the design here: **a row is written to
 * `term_changes` only when something actually changed.** Everything else about
 * a probe — that it answered, how fast — goes to Analytics Engine. So this
 * module has exactly one job, and it has to be right in both directions:
 * a missed change is a lost business event that no later probe can recover,
 * and a spurious change is a false alert about somebody else's business.
 *
 * The change-detection key is `challenge.hash` from `worker/lib/probe.ts`,
 * which is a hash over the CANONICALIZED challenge. That matters: an endpoint
 * that re-serializes the same terms with its keys in a different order, or with
 * different whitespace, produces the same hash and therefore no change row.
 * `test/probe.test.ts` already asserts that property; this module depends on it
 * rather than re-implementing a comparison.
 */

import type { ProbeResult, Requirement } from "../lib/probe.js";
import type { Risk } from "../lib/score.js";

/**
 * The `terms_current`-shaped view of one probe.
 *
 * Field names are the `terms_current` column names on purpose: `term_changes`
 * records `field` as "a terms_current column name" (0001_init.sql), so keeping
 * one vocabulary means the change log can be joined back to the table it
 * describes without a translation layer nobody maintains.
 */
export interface TermsSnapshot {
  x402_version: number | null;
  wire_form: string | null;
  scheme: string | null;
  network: string | null;
  asset_address: string | null;
  asset_symbol: string | null;
  asset_decimals: number | null;
  amount_atomic: string | null;
  amount_decimal: string | null;
  pay_to: string | null;
  pay_to_dynamic: boolean;
  max_timeout_seconds: number | null;
  facilitator: string | null;
  resource: string | null;
  mime_type: string | null;
  description: string | null;
  requirement_count: number;
  extra_json: string | null;
  challenge_hash: string | null;
  challenge_json: string | null;
  score: number | null;
  band: string | null;
  score_version: string | null;
  signals_json: string | null;
  observed_at: string;
}

/** A `term_changes` row, before it is given an id and written. */
export interface TermChangeDraft {
  change_kind: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
}

/**
 * Which `change_kind` each tracked field reports under.
 *
 * The vocabulary is the CHECK constraint in `migrations/0001_init.sql` — a kind
 * that is not in that list fails the INSERT rather than being silently stored,
 * which is the correct direction for a table that backs an appeal.
 *
 * The ORDER here is the order changes are emitted in, so a probe that changes
 * several things produces a stable, reviewable sequence rather than whatever
 * order the object keys happened to enumerate in.
 */
const TRACKED: readonly (readonly [keyof TermsSnapshot, string])[] = Object.freeze([
  ["amount_atomic", "price"],
  ["pay_to", "recipient"],
  ["network", "network"],
  ["asset_address", "asset"],
  ["asset_symbol", "asset"],
  ["scheme", "scheme"],
  ["max_timeout_seconds", "timeout"],
  ["facilitator", "facilitator"],
  ["resource", "resource"],
  ["x402_version", "wire_version"],
  ["wire_form", "wire_version"],
]);

/**
 * The first requirement is the one every renderer shows as "the price".
 *
 * A challenge may offer several ways to pay. `terms_current` holds one row, so
 * it holds the primary requirement and `requirement_count` records that there
 * were others — rather than picking a "cheapest" and quietly hiding the rest,
 * which would make the stored price disagree with what the Inspector renders.
 */
function primary(result: ProbeResult): Requirement | null {
  return result.challenge.accepts[0] ?? result.observed_terms[0] ?? null;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Build the stored view of a probe result. */
export function snapshotFromProbe(
  result: ProbeResult,
  risk: Risk | null,
  signals: unknown,
): TermsSnapshot {
  const req = primary(result);

  return {
    x402_version: result.challenge.x402_version,
    wire_form: result.challenge.wire_form,
    scheme: req?.scheme ?? null,
    network: req?.network ?? null,
    asset_address: req?.asset?.address ?? null,
    asset_symbol: req?.asset?.symbol ?? null,
    asset_decimals: req?.asset?.decimals ?? null,
    amount_atomic: req?.amount_atomic ?? null,
    amount_decimal: req?.amount_decimal ?? null,
    pay_to: req?.pay_to ?? null,
    pay_to_dynamic: req?.pay_to_dynamic === true,
    max_timeout_seconds: req?.max_timeout_seconds ?? null,
    facilitator: req?.facilitator ?? null,
    resource: req?.resource ?? null,
    mime_type: req?.mime_type ?? null,
    description: req?.description ?? null,
    requirement_count: result.challenge.requirement_count,
    extra_json: req?.extra ? JSON.stringify(req.extra) : null,
    challenge_hash: result.challenge.hash,
    challenge_json: result.challenge.raw,
    score: risk?.score ?? null,
    band: risk?.band ?? null,
    score_version: risk?.score_version ?? null,
    signals_json: signals === undefined ? null : JSON.stringify(signals),
    observed_at: result.probe.observed_at,
  };
}

/**
 * The changes between two observations, or an empty array when nothing moved.
 *
 * Two rules that are easy to get wrong and are the reason this is a function
 * rather than a loop at the call site:
 *
 *  1. **An unchanged hash means no changes at all.** Not "compare the fields
 *     anyway" — the hash is over the canonical challenge, so if it matches, the
 *     terms are the same terms and any field difference would be a bug in our
 *     own extraction, not a change at the endpoint.
 *  2. **`challenge_shape` is emitted only when nothing else was.** An endpoint
 *     that changes its price also changes its challenge, and reporting both
 *     "price" and "challenge shape" would double-count one event — and would
 *     fire two Watch alerts for one price move.
 */
export function diffTerms(
  previous: TermsSnapshot | null,
  next: TermsSnapshot,
): TermChangeDraft[] {
  // First observation: one `first_seen` row, never a diff against nothing.
  if (previous === null) {
    return [
      {
        change_kind: "first_seen",
        field: "challenge_hash",
        old_value: null,
        new_value: next.challenge_hash,
      },
    ];
  }

  // Rule 1. A re-probe that returns the same canonical challenge is the common
  // case by an enormous margin, and it must cost nothing.
  if (
    previous.challenge_hash !== null &&
    next.challenge_hash !== null &&
    previous.challenge_hash === next.challenge_hash
  ) {
    return [];
  }

  const changes: TermChangeDraft[] = [];

  for (const [field, kind] of TRACKED) {
    const before = asText(previous[field]);
    const after = asText(next[field]);
    if (before === after) continue;
    changes.push({
      change_kind: kind,
      field,
      old_value: before,
      new_value: after,
    });
  }

  // Rule 2. The hash moved but no tracked field did — the endpoint changed
  // something we do not track as a term (a description, an `extra` key, the
  // order of `accepts`). That is worth recording as an observation and is not
  // worth calling a price change.
  if (changes.length === 0) {
    changes.push({
      change_kind: "challenge_shape",
      field: "challenge_hash",
      old_value: previous.challenge_hash,
      new_value: next.challenge_hash,
    });
  }

  return changes;
}

/**
 * Whether an availability transition happened, as its own change kind.
 *
 * Availability *samples* belong in Analytics Engine — but the
 * transition from reachable to unreachable is a business event a Watch should
 * fire on, and averaging it into a sampled ratio would lose the moment it
 * happened. So the ratio is telemetry and the edge is evidence.
 */
export function availabilityChange(
  previousStatus: string | null,
  nextStatus: string,
): TermChangeDraft | null {
  if (previousStatus === null || previousStatus === nextStatus) return null;
  return {
    change_kind: "availability_state",
    field: "status",
    old_value: previousStatus,
    new_value: nextStatus,
  };
}
