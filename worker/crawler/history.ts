/**
 * Historical signals — the SPEC §6.2 half that only exists once a corpus does.
 *
 *
 * `worker/lib/signals.ts` already accepts every field of `HistoryInput`
 * and emits each as unobserved when absent, so this module fills the interface
 * in rather than changing it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE RECIPIENT-INSTABILITY DECISION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **`recipient_unstable_undeclared` is left unobserved in v1. Deliberately.**
 * The full argument is. because has to defend it in
 * public; the short form, and the code that implements it, are here.
 *
 * SPEC §6.4 freezes the carve-out:
 *
 *     recipient_unstable_undeclared = (recipient changed) AND NOT pay_to_declared_dynamic
 *
 * and forbids a bare "recipient changed" signal in every version. The carve-out
 * is right. The problem is that
 * **x402 v2 has no on-the-wire declaration of a dynamic `payTo`**: it is a
 * server-side function resolved before serialization, so a marketplace rotating
 * payout addresses per request is field-for-field identical to an endpoint
 * whose recipient is unstable. `pay_to_declared_dynamic` is therefore usually
 * `observed: false`, the second conjunct is usually vacuous, and the signal
 * would fire on exactly the legitimate marketplaces the carve-out exists to
 * protect. That is crying-wolf failure arriving through the
 * mechanism designed to prevent it.
 *
 * So: **we collect the evidence and score nothing from it.** `classifyRecipients`
 * below computes the shape of an endpoint's recipient set — which IS observable
 * over time, and is the one thing that can eventually tell the two cases apart
 * — and reports it. `buildHistoryInput` passes `recipient_unstable_undeclared:
 * null`, which `signals.ts` emits as `observed: false`, which SPEC §6.3 says
 * contributes nothing to the score in either direction.
 *
 * Three consequences worth stating plainly:
 *
 *  - **`score_version` stays `v1`.** No historical signal enters `V1_RULES`, so
 *    no weight changes, so `spec/risk-score.md` needs no edit and
 *    no addendum-to-change-a-frozen-document. Every score already published
 *    stays reproducible.
 *  - **The observation is still reported.** The other seven historical signals
 *    are filled in and rendered; an operator or a buyer can see "this endpoint
 *    has paid to 14 distinct addresses in 90 days" without our attaching a
 *    verdict to it. Reporting an observation is not the same as scoring it, and
 *    language rule is about the verdict.
 *  - **The upgrade path is real, not rhetorical.** `recipient_observations`
 *    accumulates from today, so whoever revisits this (with operator
 *    claims, is the natural owner) has months of shape data to calibrate
 *    against rather than a cold start.
 */

import type { HistoryInput } from "../lib/signals.js";
import { recipientShape, type RecipientShape } from "./store.js";

/** How an endpoint's recipient set looks over time. Reported, never scored. */
export type RecipientClass =
  /** One recipient, ever. The overwhelmingly common case. */
  | "single"
  /** Rotates among a bounded, recurring set — marketplace-shaped. */
  | "bounded_set"
  /** An ever-growing set of addresses each seen once — per-order routing. */
  | "one_shot_series"
  /** Not enough observations to say anything. */
  | "insufficient_data";

export interface RecipientAssessment {
  classification: RecipientClass;
  distinct: number;
  observations: number;
  /** True when a challenge declared dynamic routing by an observable surface. */
  declared_dynamic: boolean;
  /**
   * Always null in v1. Present so the field exists at the call site and its
   * absence is visibly a decision rather than an omission.
   */
  unstable_undeclared: null;
  /** Renderable, and written to be quoted back to an operator verbatim. */
  detail: string;
}

/** Below this many observations, no shape claim is honest. */
const MIN_OBSERVATIONS = 4;

/**
 * Classify the recipient set.
 *
 * This deliberately does NOT return a verdict. `bounded_set` and
 * `one_shot_series` are both *shapes*, and the second is as consistent with a
 * legitimate per-order marketplace (the `v2-dynamic-payto` fixture's
 * `/v1/order/8f21` resource path is exactly this) as with anything else. What
 * separates them is information we do not have from the wire — which is the
 * whole finding.
 */
export function classifyRecipients(shape: RecipientShape): RecipientAssessment {
  const base = {
    distinct: shape.distinct,
    observations: shape.total_observations,
    declared_dynamic: shape.declared_dynamic,
    unstable_undeclared: null,
  } as const;

  if (shape.distinct === 0) {
    return {
      ...base,
      classification: "insufficient_data",
      detail: "No recipient has been observed yet.",
    };
  }

  if (shape.distinct === 1) {
    return {
      ...base,
      classification: "single",
      detail: `One recipient across ${shape.total_observations} observation(s).`,
    };
  }

  if (shape.total_observations < MIN_OBSERVATIONS) {
    return {
      ...base,
      classification: "insufficient_data",
      detail: `${shape.distinct} recipients across only ${shape.total_observations} observations — too few to describe a pattern.`,
    };
  }

  // Every address seen exactly once and more than a couple of them: the set is
  // growing one-for-one with the probes, which is what per-order routing looks
  // like. It is ALSO what an unstable recipient looks like. We say which shape
  // we saw and stop there.
  if (shape.seen_once === shape.distinct && shape.distinct >= 3) {
    return {
      ...base,
      classification: "one_shot_series",
      detail:
        `${shape.distinct} distinct recipients, each seen once. This is the shape of per-request ` +
        `payout routing, which is a supported x402 v2 feature; it is not scored.`,
    };
  }

  return {
    ...base,
    classification: "bounded_set",
    detail:
      `${shape.distinct} recipients recurring across ${shape.total_observations} observations — ` +
      `a bounded rotating set. Not scored.`,
  };
}

export interface HistoryFacts {
  first_seen: string | null;
  scan_count: number;
  price_changes_90d: number;
  recipient_changes_90d: number;
  last_change_at: string | null;
}

/** Everything D1 knows about an endpoint's past, in one round trip. */
export async function loadHistoryFacts(
  db: D1Database,
  endpointId: string,
  now: string,
): Promise<HistoryFacts> {
  const ninetyDaysAgo = new Date(Date.parse(now) - 90 * 86_400_000).toISOString();

  const [endpoint, changes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT first_seen, scan_count FROM endpoints WHERE id = ?`)
      .bind(endpointId),
    db
      .prepare(
        `SELECT
            COALESCE(sum(CASE WHEN change_kind = 'price' THEN 1 ELSE 0 END), 0) AS price_changes,
            COALESCE(sum(CASE WHEN change_kind = 'recipient' THEN 1 ELSE 0 END), 0) AS recipient_changes,
            max(changed_at) AS last_change_at
           FROM term_changes
          WHERE endpoint_id = ? AND changed_at >= ?`,
      )
      .bind(endpointId, ninetyDaysAgo),
  ]);

  const endpointRow = endpoint?.results?.[0];
  const changeRow = changes?.results?.[0];

  return {
    first_seen: typeof endpointRow?.first_seen === "string" ? endpointRow.first_seen : null,
    scan_count: Number(endpointRow?.scan_count ?? 0),
    price_changes_90d: Number(changeRow?.price_changes ?? 0),
    recipient_changes_90d: Number(changeRow?.recipient_changes ?? 0),
    last_change_at:
      typeof changeRow?.last_change_at === "string" ? changeRow.last_change_at : null,
  };
}

export function ageInDays(firstSeen: string | null, now: string): number | null {
  if (!firstSeen) return null;
  const from = Date.parse(firstSeen);
  const to = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

export interface AvailabilityInput {
  availability_30d?: number | null;
  latency_p50_ms?: number | null;
}

/**
 * Assemble the `HistoryInput` that `extractSignals` takes.
 *
 * Availability and latency are passed in rather than fetched here: they come
 * from Analytics Engine over an account-level HTTP API with a credential the
 * Worker does not currently hold (see `analytics.ts`., and a
 * probe that blocked on a third-party API call to enrich a signal would be a
 * bad trade. Absent ⇒ unobserved ⇒ not scored, which is already correct.
 */
export async function buildHistoryInput(
  db: D1Database,
  endpointId: string,
  now: string,
  availability: AvailabilityInput = {},
): Promise<{ history: HistoryInput; recipients: RecipientAssessment }> {
  const [facts, shape] = await Promise.all([
    loadHistoryFacts(db, endpointId, now),
    recipientShape(db, endpointId),
  ]);

  const recipients = classifyRecipients(shape);

  const changedWithin24h =
    facts.last_change_at === null
      ? null
      : Date.parse(now) - Date.parse(facts.last_change_at) <= 86_400_000;

  return {
    history: {
      first_seen_age_days: ageInDays(facts.first_seen, now),
      scan_count: facts.scan_count,
      availability_30d: availability.availability_30d ?? null,
      latency_p50_ms: availability.latency_p50_ms ?? null,
      price_changes_90d: facts.price_changes_90d,
      recipient_changes_90d: facts.recipient_changes_90d,

      // ── THE DECISION, in one line ──────────────────────────────────────
      // Not `recipients.classification === "one_shot_series"`, and not
      // `facts.recipient_changes_90d > 0 && !declared_dynamic`. Null, because
      // x402 v2 gives us no way to tell a marketplace from an unstable
      // recipient, and a signal that is confidently wrong about a whole
      // legitimate category is worse than no signal. SPEC §6.3: unobserved
      // contributes nothing in either direction.
      recipient_unstable_undeclared: null,

      terms_changed_within_24h: changedWithin24h,
    },
    recipients,
  };
}
