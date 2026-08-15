/**
 * What runs on this tick.
 *
 * ── Why this is wall-clock arithmetic and not three cron triggers ─────────
 *
 * Cron triggers are capped at **five per ACCOUNT** on the Workers Free plan,
 * and this account is on it (— O2's "Queues are live therefore the
 * plan is paid" inference turned out to be wrong, discovered by a deploy
 * failing with error 10072). The budget is shared with `tx402-landing` and
 * everything else on the account, so declaring two more triggers here would
 * take them from another Worker.
 *
 *  therefore reduced three triggers to a single every-15-minutes one, and
 * moved the schedule decision into `scheduled`. This function IS that
 * decision.
 * Upgrading the plan is an integrator call with a cost model behind it,
 * not something a contributor buys by editing `wrangler.jsonc` — which
 * does not own anyway.
 *
 * Keeping it a pure function of a `Date` also means the schedule is testable
 * without a clock, which three cron expressions in a config file would not be.
 */

export interface CyclePhases {
  /** Select due endpoints and enqueue them. Every tick. */
  pump: boolean;
  /** Housekeeping: re-tier, expire caches, repair missing schedules. */
  sweep: boolean;
  /** Re-read Bazaar and the curated lists. */
  seedRefresh: boolean;
}

/**
 * A 15-minute trigger fires 96 times a day. This maps a firing to its phases.
 *
 * The boundaries are chosen so that the expensive phases never coincide with
 * each other: the seed refresh runs at 03:00 UTC, and the 6-hourly sweeps run
 * at 00:00, 06:00, 12:00 and 18:00. A tick that would otherwise do three things
 * at once is the one most likely to exceed a Worker's CPU budget and get killed
 * halfway through writing a change log.
 */
export function phasesFor(now: Date): CyclePhases {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // The first firing within the hour. The trigger fires at:00,:15,:30 and
  //:45, but the exact minute is not guaranteed, so this is a range rather than
  // an equality test.
  const topOfHour = minute < 15;

  return {
    pump: true,
    sweep: topOfHour && hour % 6 === 0,
    seedRefresh: topOfHour && hour === 3,
  };
}

/**
 * The probe budget for this tick.
 *
 * Constant, and deliberately not adaptive. An adaptive budget that grows with
 * the backlog is how a crawler turns a busy day into an outbound traffic spike
 * aimed at other people's paid APIs — the exact failure calls "a
 * free DDoS cannon". A fixed ceiling means the worst case is a multiplication
 * anybody can check, and a backlog simply takes longer to clear.
 */
export function budgetFor(phases: CyclePhases, maxPerCycle: number): number {
  // The seed-refresh tick spends its time on ingestion, so it probes less and
  // leaves the newly-discovered endpoints to the following ticks.
  return phases.seedRefresh ? Math.floor(maxPerCycle / 2) : maxPerCycle;
}

/** A 15-minute trigger fires this many times a day. */
export const TICKS_PER_DAY = 96;

/**
 * The most outbound probes the crawler can perform in a day.
 *
 * Computed rather than written down, because it is published to endpoint
 * operators at `/crawler` as a promise about how hard we will ever hit them,
 * and `MAX_PROBES_PER_CYCLE × 96` is not that number — exactly one tick a day
 * is a seed refresh and gets half the budget. The difference is twenty probes,
 * which matters not at all in cost and completely in whether the figure on the
 * page is the figure the code enforces. docs/cost-model.md multiplies this.
 */
export function maxProbesPerDay(maxPerCycle: number): number {
  const seedRefresh = budgetFor({ pump: true, sweep: false, seedRefresh: true }, maxPerCycle);
  const ordinary = budgetFor({ pump: true, sweep: false, seedRefresh: false }, maxPerCycle);
  return ordinary * (TICKS_PER_DAY - 1) + seedRefresh;
}
