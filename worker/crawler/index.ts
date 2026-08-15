/**
 * The crawler's entry points.
 *
 * `worker/index.ts` delegates its `scheduled` and `queue`
 * handlers here and does nothing else, so the whole data plane is inside the
 * directory this change owns.
 *
 * The pipeline is, in order:
 *
 *     cron → select due → queue → probe → diff → term_changes + Analytics Engine
 *
 * with the corpus bootstrap (§5.2) hanging off the daily seed refresh.
 */

import { loadFacilitators, seedFacilitators } from "../lib/facilitators.js";
import type { CrawlMessage, Env } from "../types.js";
import { fetchDiscoveryPage } from "./bazaar.js";
import { asNumber, asString } from "./coerce.js";
import { ingestResources } from "./ingest.js";
import { probeEndpoint, type RunnerOptions } from "./runner.js";
import { budgetFor, phasesFor } from "./schedule.js";
import { fetchAwesomeList } from "./seeds.js";
import {
  countDue,
  dueEndpoints,
  newId,
  recordCycle,
  type DueEndpoint,
} from "./store.js";
import {
  BAZAAR_PAGE_SIZE,
  COLD_START_ENDPOINT_FLOOR,
  MAX_PROBES_PER_CYCLE,
  MAX_SEED_ITEMS_PER_SOURCE,
  newCycle,
  type CycleStats,
} from "./types.js";

function iso(date: Date): string {
  return date.toISOString().slice(0, 19) + "Z";
}

/**
 * The cron handler.
 *
 * Never throws: an unhandled rejection in `scheduled` is invisible except as
 * a metric, and a crawler that dies silently on one bad endpoint looks exactly
 * like a crawler that has nothing to do.
 */
export async function runScheduled(
  env: Env,
  event: { cron?: string; scheduledTime?: number },
  options: RunnerOptions = {},
): Promise<CycleStats> {
  const now = options.now?.() ?? new Date();
  const phases = phasesFor(now);

  // Cold start: an empty corpus seeds on the next tick rather than waiting for
  // the daily window. Without this a database deployed at 03:51 stays empty
  // until 03:00 tomorrow, and every tool that reads the corpus renders an empty
  // state for 23 hours. Guarded by a floor so it cannot become a second daily
  // refresh, and it reads one indexed COUNT — cheap enough to do every tick.
  if (!phases.seedRefresh) {
    try {
      const row = await env.DB.prepare(
        `SELECT count(*) AS n FROM endpoints WHERE status NOT IN ('opted_out', 'gone')`,
      ).first<{ n: number }>();
      if (Number(row?.n ?? 0) < COLD_START_ENDPOINT_FLOOR) phases.seedRefresh = true;
    } catch {
      // A failed count must not stop the pump; it just means no cold-start seed.
    }
  }

  const budget = budgetFor(phases, MAX_PROBES_PER_CYCLE);

  const stats = newCycle(
    newId(now.getTime()),
    phases.seedRefresh ? "seed_refresh" : phases.sweep ? "sweep" : "tick",
    iso(now),
    budget,
    event.cron ?? null,
  );

  try {
    if (phases.seedRefresh) {
      const seeded = await refreshSeeds(env, now, options);
      stats.endpoints_added += seeded.added;
      stats.items_seen += seeded.seen;
    }

    if (phases.pump) {
      const pumped = await pump(env, now, budget, stats, options);
      stats.enqueued = pumped;
    }
  } catch (error) {
    stats.errors += 1;
    stats.note = error instanceof Error ? error.message.slice(0, 500) : "cycle failed";
  }

  // The cycle is recorded whatever happened. makes bounded probe
  // volume the mitigation for unbounded cost, and a bound nobody measures is
  // an assumption — the cost model is built on these rows.
  try {
    await recordCycle(env.DB, stats, iso(options.now?.() ?? new Date()));
  } catch {
    // Never let accounting failure mask the work that succeeded.
  }

  return stats;
}

/**
 * Select the endpoints that are due and hand them to the queue.
 *
 * The budget is applied in the SQL `LIMIT`, so an oversized corpus cannot
 * produce an oversized batch on its way to being trimmed.
 */
async function pump(
  env: Env,
  now: Date,
  budget: number,
  stats: CycleStats,
  options: RunnerOptions,
): Promise<number> {
  const nowIso = iso(now);

  stats.considered = await countDue(env.DB, nowIso);
  const due = await dueEndpoints(env.DB, nowIso, budget);
  stats.skipped_budget = Math.max(0, stats.considered - due.length);

  if (due.length === 0) return 0;

  const messages: { body: CrawlMessage }[] = due.map((endpoint) => ({
    body: {
      kind: "probe",
      endpoint_id: endpoint.id,
      url: endpoint.canonical_url,
      reason: `tier:${endpoint.probe_tier}`,
      enqueued_at: nowIso,
    },
  }));

  try {
    await env.CRAWL_QUEUE.sendBatch(messages);
    return messages.length;
  } catch {
    // No queue (or a queue outage) must not mean no crawl. Probing inline is
    // slower and bounded by the same budget, so the failure mode is "the cycle
    // takes longer", not "the corpus stops updating".
    for (const endpoint of due) {
      await runOne(env, endpoint, stats, { now: () => now, ...options });
    }
    return 0;
  }
}

/** Probe one endpoint and fold the outcome into the cycle's accounting. */
async function runOne(
  env: Env,
  endpoint: DueEndpoint,
  stats: CycleStats,
  options: RunnerOptions,
): Promise<void> {
  stats.probes_attempted += 1;
  try {
    const outcome = await probeEndpoint(env, endpoint, options);
    switch (outcome.kind) {
      case "probed":
        stats.probes_performed += 1;
        stats.changes_written += outcome.changes;
        break;
      case "cached":
        stats.probes_cached += 1;
        break;
      case "robots_disallowed":
        stats.skipped_robots += 1;
        break;
      case "opted_out":
        stats.skipped_optout += 1;
        break;
      case "rate_limited":
        stats.probes_cached += 1;
        break;
      case "error":
        stats.probes_performed += 1;
        stats.errors += 1;
        break;
    }
  } catch {
    stats.errors += 1;
  }
}

/**
 * The queue consumer: one message, one endpoint.
 *
 * Messages are acknowledged individually. `retry` is used only for a
 * politeness refusal, because that is the one outcome where trying again later
 * genuinely differs — a robots disallow or an opt-out will refuse identically
 * on every retry and belongs in the dead-letter queue no more than it belongs
 * in a loop.
 */
export async function runQueue(
  env: Env,
  batch: MessageBatch<CrawlMessage>,
  options: RunnerOptions = {},
): Promise<CycleStats> {
  const now = options.now?.() ?? new Date();
  const stats = newCycle(newId(now.getTime()), "tick", iso(now), batch.messages.length);

  for (const message of batch.messages) {
    const body = message.body;
    if (body.kind !== "probe" || !body.endpoint_id || !body.url) {
      message.ack();
      continue;
    }

    const endpoint = await env.DB.prepare(
      `SELECT id, canonical_url, origin, host, path, probe_tier, status, consecutive_failures
         FROM endpoints WHERE id = ?`,
    )
      .bind(body.endpoint_id)
      .first<Record<string, unknown>>();

    if (!endpoint) {
      message.ack();
      continue;
    }

    const due: DueEndpoint = {
      id: asString(endpoint.id, ""),
      canonical_url: asString(endpoint.canonical_url, ""),
      origin: asString(endpoint.origin, ""),
      host: asString(endpoint.host, ""),
      path: asString(endpoint.path, "/"),
      probe_tier: asString(endpoint.probe_tier, "corpus") as DueEndpoint["probe_tier"],
      status: asString(endpoint.status, "active"),
      consecutive_failures: asNumber(endpoint.consecutive_failures, 0),
    };

    stats.probes_attempted += 1;
    try {
      const outcome = await probeEndpoint(env, due, options);
      if (outcome.kind === "rate_limited") {
        // Someone else is probing this endpoint right now. Come back.
        message.retry();
        stats.probes_cached += 1;
        continue;
      }
      if (outcome.kind === "probed") {
        stats.probes_performed += 1;
        stats.changes_written += outcome.changes;
      } else if (outcome.kind === "cached") {
        stats.probes_cached += 1;
      } else if (outcome.kind === "robots_disallowed") {
        stats.skipped_robots += 1;
      } else if (outcome.kind === "opted_out") {
        stats.skipped_optout += 1;
      } else if (outcome.kind === "error") {
        stats.errors += 1;
        stats.probes_performed += 1;
      }
      message.ack();
    } catch {
      stats.errors += 1;
      message.ack();
    }
  }

  try {
    await recordCycle(env.DB, stats, iso(options.now?.() ?? new Date()));
  } catch {
    // Accounting is not worth failing a batch over.
  }

  return stats;
}

// ── corpus bootstrap ───────────────────────────────────────

export interface SeedSummary {
  seen: number;
  added: number;
  updated: number;
  rejected: number;
  sources: { id: string; url: string; items: number; error: string | null }[];
}

/**
 * Refresh the corpus from every discovery source, in order.
 *
 * (a) Bazaar across every listed facilitator, (b) awesome-x402. Source (c) —
 * URLs humans paste into the Inspector — needs no refresh here: the Inspector writes those
 * rows at the moment of the paste, which is the flywheel and the reason the
 * Inspector ships before the data plane.
 */
export async function refreshSeeds(
  env: Env,
  now: Date,
  options: RunnerOptions = {},
): Promise<SeedSummary> {
  const nowIso = iso(now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const summary: SeedSummary = { seen: 0, added: 0, updated: 0, rejected: 0, sources: [] };

  // The facilitator table is seeded by code, not by a migration,
  // and owns keeping it current. Idempotent, so calling it on
  // every refresh is how a newly-published facilitator arrives.
  try {
    await seedFacilitators(env.DB);
  } catch {
    // A seed failure must not stop ingestion — `loadFacilitators` falls back to
    // the bundled list and says so.
  }

  const { rows } = await loadFacilitators(env);

  // (a) Bazaar.
  for (const facilitator of rows) {
    if (facilitator.status !== "listed") continue;

    const discoveryUrl =
      facilitator.discovery_url ?? `${facilitator.base_url.replace(/\/$/u, "")}/discovery/resources`;

    let offset = 0;
    let ingested = 0;
    let error: string | null = null;

    while (ingested < MAX_SEED_ITEMS_PER_SOURCE) {
      const { page, error: pageError } = await fetchDiscoveryPage(
        discoveryUrl,
        offset,
        fetchImpl,
        BAZAAR_PAGE_SIZE,
      );

      if (!page) {
        error = pageError;
        break;
      }

      if (page.items.length > 0) {
        const result = await ingestResources(
          env,
          page.items,
          {
            source: "bazaar",
            sourceUrl: discoveryUrl,
            facilitatorId: facilitator.id,
            tier: "corpus",
          },
          nowIso,
        );
        summary.seen += result.seen;
        summary.added += result.added;
        summary.updated += result.updated;
        summary.rejected += result.rejected;
        ingested += result.seen;
      }

      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }

    summary.sources.push({
      id: facilitator.id,
      url: discoveryUrl,
      items: ingested,
      error,
    });
  }

  // (b) awesome-x402.
  const awesome = await fetchAwesomeList(fetchImpl);
  if (awesome.resources.length > 0) {
    const result = await ingestResources(
      env,
      awesome.resources.slice(0, MAX_SEED_ITEMS_PER_SOURCE),
      {
        source: "awesome-x402",
        sourceUrl: "https://github.com/xpaysh/awesome-x402",
        facilitatorId: null,
        tier: "corpus",
      },
      nowIso,
    );
    summary.seen += result.seen;
    summary.added += result.added;
    summary.updated += result.updated;
    summary.rejected += result.rejected;
  }
  summary.sources.push({
    id: "awesome-x402",
    url: "https://github.com/xpaysh/awesome-x402",
    items: awesome.resources.length,
    error: awesome.error,
  });

  return summary;
}
