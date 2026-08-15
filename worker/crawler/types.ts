/**
 * Crawler types.
 *
 * The shapes here are internal to the data plane. Anything a *tool* reads is
 * already frozen in `spec/SPEC.md` and typed in `worker/types.ts` — this file
 * never redefines one of those.
 */

/**
 * How often we re-probe an endpoint, and why.
 *
 * The tier is a property of our relationship with the endpoint, not of the
 * endpoint itself: `active` means a human looked at it recently or it changed
 * recently, and `corpus` is the default for something we found in a directory
 * and nobody has ever asked about. `cold` is where repeated failures land, so a
 * dead endpoint stops consuming the budget that a live one needs.
 *
 * There was a fourth tier, `watched` (60 minutes), for endpoints somebody had
 * asked to be told about. Watch was cut before it shipped and
 * nothing ever assigned that tier, so it is gone rather than left dormant —
 * `/crawler` publishes these cadences as a promise to endpoint operators, and a
 * promise about a state nothing can enter is noise in the one document they are
 * meant to be able to hold us to.
 */
export type ProbeTier = "active" | "corpus" | "cold";

/** Minutes between probes, per tier. Bounded above by the per-cycle budget. */
export const TIER_INTERVAL_MINUTES: Readonly<Record<ProbeTier, number>> = Object.freeze({
  active: 360,
  corpus: 1440,
  cold: 4320,
});

/**
 * The most outbound probes one 15-minute tick may perform.
 *
 * This is the bound asks for, and it is a constant rather than a
 * heuristic so that the worst case is a multiplication anyone can check:
 * 40 probes × 96 ticks = 3,840 probes/day, whatever the corpus size. A corpus
 * larger than that simply takes more than a day to come around, which is the
 * correct trade for a price that changes a handful of times a year.
 *
 * Measured against the real corpus.
 */
export const MAX_PROBES_PER_CYCLE = 40;

/**
 * The most discovery items one seed refresh will ingest per source.
 *
 * Coinbase's Bazaar alone advertises >15,000 resources (measured, see. Ingesting all of them in one
 * pass would put a corpus on the probe schedule that the probe budget cannot serve for weeks, and
 * would make the first cycle's cost the largest one we ever pay. Paging in over days keeps both
 * bounded, and the page offset is persisted so it genuinely resumes.
 */
export const MAX_SEED_ITEMS_PER_SOURCE = 500;

/**
 * Below this many endpoints, the next tick seeds the corpus whatever the hour.
 *
 * The daily refresh at 03:00 UTC is the right cadence for *keeping* a corpus
 * current, and the wrong one for *having* one: a fresh database deployed at
 * 03:51 would otherwise sit empty for 23 hours, and every tool that reads the
 * corpus would render its honest-but-useless empty state for a full day. A
 * cold start is not a daily event, so paying for it on the next tick is cheap;
 * the floor is what stops that becoming a second daily refresh.
 */
export const COLD_START_ENDPOINT_FLOOR = 50;

/** Bazaar pages come 100 at a time; this is the page size we request. */
export const BAZAAR_PAGE_SIZE = 100;

/** Per-host concurrency, so one busy host cannot occupy the whole batch. */
export const MAX_CONCURRENT_PER_HOST = 1;

/** Backoff after consecutive failures, in minutes, indexed by failure count. */
export const FAILURE_BACKOFF_MINUTES: readonly number[] = [15, 60, 240, 1440, 4320];

/** A normalized discovery item, whatever shape the source served it in. */
export interface DiscoveredResource {
  /** The resource URL as advertised. Canonicalized later, by the guard. */
  url: string;
  type: "http" | "mcp";
  serviceName: string | null;
  description: string | null;
  mimeType: string | null;
  tags: string[];
  iconUrl: string | null;
  /**
   * The source's own claim about when this resource last changed, kept verbatim
   * and unparsed. NEVER used as a first-seen date: it is a claim
   * by a third party about someone else's endpoint, and the Inspector's
   * "First seen" must only ever be a date we observed.
   */
  claimedLastUpdated: string | null;
  /** The advertised terms, for cross-checking against what we probe. */
  accepts: unknown[];
  /** The item as served, for `endpoint_provenance.raw_json`. */
  raw: unknown;
}

/** What one discovery source returned in one read. */
export interface DiscoveryPage {
  items: DiscoveredResource[];
  /** Total the source claims to hold, when it says. */
  total: number | null;
  /** Offset to request next, or null when the source is exhausted. */
  nextOffset: number | null;
  /** Which envelope shape we found, recorded because they differ in the wild. */
  envelope: "items" | "resources" | "array" | "unknown";
}

/** Per-cycle accounting, mirrored into the `crawl_cycles` table. */
export interface CycleStats {
  id: string;
  kind: "tick" | "sweep" | "seed_refresh" | "manual";
  cron: string | null;
  started_at: string;
  budget: number;
  considered: number;
  enqueued: number;
  probes_attempted: number;
  probes_performed: number;
  probes_cached: number;
  skipped_robots: number;
  skipped_optout: number;
  skipped_budget: number;
  changes_written: number;
  errors: number;
  endpoints_added: number;
  items_seen: number;
  note: string | null;
}

export function newCycle(
  id: string,
  kind: CycleStats["kind"],
  startedAt: string,
  budget: number,
  cron: string | null = null,
): CycleStats {
  return {
    id,
    kind,
    cron,
    started_at: startedAt,
    budget,
    considered: 0,
    enqueued: 0,
    probes_attempted: 0,
    probes_performed: 0,
    probes_cached: 0,
    skipped_robots: 0,
    skipped_optout: 0,
    skipped_budget: 0,
    changes_written: 0,
    errors: 0,
    endpoints_added: 0,
    items_seen: 0,
    note: null,
  };
}
