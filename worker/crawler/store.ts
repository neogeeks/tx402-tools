/**
 * D1 reads and writes for the data plane.
 *
 * The three-way split of is enforced *here*, at the only place
 * that writes, rather than left to each caller to remember:
 *
 *   `term_changes`   append-only, one row only when something actually changed
 *   `terms_current`  the materialized "what does it cost right now"
 *   `scans`          evidence only — `retained_reason` is a CHECK constraint,
 *                    and a routine unchanged probe does not qualify. Those go
 *                    to Analytics Engine and nowhere else.
 */

import { asNumber, asString, asStringOrNull } from "./coerce.js";
import type { TermChangeDraft, TermsSnapshot } from "./diff.js";
import type { CycleStats, ProbeTier } from "./types.js";

/**
 * A sortable id: 48-bit millisecond timestamp then randomness, Crockford base32.
 *
 * Sortable because `term_changes` is an append-only log that is read in order,
 * and an id that sorts with time means "the change before this one" is an index
 * scan rather than a join against `changed_at`. Same shape as the `01J…` ids
 * SPEC §4.6 shows.
 */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = B32[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += B32[byte % 32];

  return time + random;
}

// ── endpoints ─────────────────────────────────────────────────────────────

export interface EndpointUpsert {
  id: string;
  canonical_url: string;
  url: string;
  origin: string;
  host: string;
  path: string;
  title: string | null;
  description: string | null;
  resource_type: "http" | "mcp";
  discovery_source: "bazaar" | "awesome-x402" | "human" | "crawler" | "seed" | "claim";
  tier: ProbeTier;
  next_probe_at: string | null;
}

/**
 * Insert an endpoint, or touch the one that is already there.
 *
 * `first_seen` is written ONCE, on insert, and the upsert branch deliberately
 * never touches it — that is the "First seen must never be a number we made up"
 * exit criterion expressed as SQL. A second source discovering the same
 * endpoint updates `last_seen` and adds a provenance row; it cannot move the
 * date we first observed it, forwards or backwards.
 *
 * Returns whether the row was new, which is what `crawl_cycles.endpoints_added`
 * counts.
 */
export async function upsertEndpoint(
  db: D1Database,
  endpoint: EndpointUpsert,
  now: string,
): Promise<{ added: boolean }> {
  const existing = await db
    .prepare(`SELECT id FROM endpoints WHERE id = ?`)
    .bind(endpoint.id)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE endpoints
            SET last_seen = ?,
                updated_at = ?,
                title = COALESCE(title, ?),
                description = COALESCE(description, ?)
          WHERE id = ?`,
      )
      .bind(now, now, endpoint.title, endpoint.description, endpoint.id)
      .run();
    return { added: false };
  }

  await db
    .prepare(
      `INSERT INTO endpoints
         (id, canonical_url, url, origin, host, path, title, description,
          resource_type, discovery_source, status, robots_allowed,
          first_seen, last_seen, scan_count, probe_tier, next_probe_at,
          consecutive_failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, 0, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      endpoint.id,
      endpoint.canonical_url,
      endpoint.url,
      endpoint.origin,
      endpoint.host,
      endpoint.path,
      endpoint.title,
      endpoint.description,
      endpoint.resource_type,
      endpoint.discovery_source,
      now,
      now,
      endpoint.tier,
      endpoint.next_probe_at,
      now,
      now,
    )
    .run();

  return { added: true };
}

export interface DueEndpoint {
  id: string;
  canonical_url: string;
  origin: string;
  host: string;
  path: string;
  probe_tier: ProbeTier;
  status: string;
  consecutive_failures: number;
}

/**
 * The N most overdue endpoints.
 *
 * `LIMIT` is the probe budget, and it is applied in SQL rather than in the
 * consumer so that an oversized corpus cannot produce an oversized batch on the
 * way to being trimmed. Opted-out and gone endpoints are excluded here as well
 * as at read time — the belt and the braces are cheap and the failure is not.
 */
export async function dueEndpoints(
  db: D1Database,
  now: string,
  limit: number,
): Promise<DueEndpoint[]> {
  const result = await db
    .prepare(
      `SELECT id, canonical_url, origin, host, path, probe_tier, status, consecutive_failures
         FROM endpoints
        WHERE status IN ('active', 'unreachable')
          AND robots_allowed = 1
          AND (next_probe_at IS NULL OR next_probe_at <= ?)
        ORDER BY next_probe_at IS NULL DESC, next_probe_at
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => ({
    id: asString(row.id, ""),
    canonical_url: asString(row.canonical_url, ""),
    origin: asString(row.origin, ""),
    host: asString(row.host, ""),
    path: asString(row.path, "/"),
    probe_tier: asString(row.probe_tier, "corpus") as ProbeTier,
    status: asString(row.status, "active"),
    consecutive_failures: asNumber(row.consecutive_failures, 0),
  }));
}

/** How many endpoints are due right now, for the cycle's `considered` count. */
export async function countDue(db: D1Database, now: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM endpoints
        WHERE status IN ('active', 'unreachable')
          AND robots_allowed = 1
          AND (next_probe_at IS NULL OR next_probe_at <= ?)`,
    )
    .bind(now)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function scheduleNext(
  db: D1Database,
  endpointId: string,
  nextProbeAt: string,
  now: string,
  outcome: { ok: boolean; status?: string; changed?: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE endpoints
          SET next_probe_at = ?,
              last_probe_at = ?,
              last_seen = ?,
              updated_at = ?,
              scan_count = scan_count + 1,
              consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
              last_change_at = CASE WHEN ? = 1 THEN ? ELSE last_change_at END,
              status = COALESCE(?, status)
        WHERE id = ?`,
    )
    .bind(
      nextProbeAt,
      now,
      now,
      now,
      outcome.ok ? 1 : 0,
      outcome.changed ? 1 : 0,
      now,
      outcome.status ?? null,
      endpointId,
    )
    .run();
}

/** Mark an endpoint disallowed by robots.txt so the sweep stops selecting it. */
export async function markRobotsDisallowed(
  db: D1Database,
  endpointId: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE endpoints SET robots_allowed = 0, next_probe_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(now, endpointId)
    .run();
}

// ── terms_current ─────────────────────────────────────────────────────────

const TERMS_COLUMNS = [
  "x402_version",
  "wire_form",
  "scheme",
  "network",
  "asset_address",
  "asset_symbol",
  "asset_decimals",
  "amount_atomic",
  "amount_decimal",
  "pay_to",
  "pay_to_dynamic",
  "max_timeout_seconds",
  "facilitator",
  "resource",
  "mime_type",
  "description",
  "requirement_count",
  "extra_json",
  "challenge_hash",
  "challenge_json",
  "score",
  "band",
  "score_version",
  "signals_json",
  "observed_at",
] as const;

export async function loadTerms(
  db: D1Database,
  endpointId: string,
): Promise<TermsSnapshot | null> {
  const row = await db
    .prepare(`SELECT ${TERMS_COLUMNS.join(", ")} FROM terms_current WHERE endpoint_id = ?`)
    .bind(endpointId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  const text = asStringOrNull;
  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : asNumber(value, 0);

  return {
    x402_version: num(row.x402_version),
    wire_form: text(row.wire_form),
    scheme: text(row.scheme),
    network: text(row.network),
    asset_address: text(row.asset_address),
    asset_symbol: text(row.asset_symbol),
    asset_decimals: num(row.asset_decimals),
    amount_atomic: text(row.amount_atomic),
    amount_decimal: text(row.amount_decimal),
    pay_to: text(row.pay_to),
    pay_to_dynamic: Number(row.pay_to_dynamic ?? 0) === 1,
    max_timeout_seconds: num(row.max_timeout_seconds),
    facilitator: text(row.facilitator),
    resource: text(row.resource),
    mime_type: text(row.mime_type),
    description: text(row.description),
    requirement_count: Number(row.requirement_count ?? 0),
    extra_json: text(row.extra_json),
    challenge_hash: text(row.challenge_hash),
    challenge_json: text(row.challenge_json),
    score: num(row.score),
    band: text(row.band),
    score_version: text(row.score_version),
    signals_json: text(row.signals_json),
    observed_at: text(row.observed_at) ?? "",
  };
}

export function writeTermsStatement(
  db: D1Database,
  endpointId: string,
  terms: TermsSnapshot,
  scanId: string | null,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO terms_current
         (endpoint_id, ${TERMS_COLUMNS.join(", ")}, scan_id, updated_at)
       VALUES (?, ${TERMS_COLUMNS.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT(endpoint_id) DO UPDATE SET
         ${TERMS_COLUMNS.map((c) => `${c} = excluded.${c}`).join(",\n         ")},
         scan_id = excluded.scan_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      endpointId,
      terms.x402_version,
      terms.wire_form,
      terms.scheme,
      terms.network,
      terms.asset_address,
      terms.asset_symbol,
      terms.asset_decimals,
      terms.amount_atomic,
      terms.amount_decimal,
      terms.pay_to,
      terms.pay_to_dynamic ? 1 : 0,
      terms.max_timeout_seconds,
      terms.facilitator,
      terms.resource,
      terms.mime_type,
      terms.description,
      terms.requirement_count,
      terms.extra_json,
      terms.challenge_hash,
      terms.challenge_json,
      terms.score,
      terms.band,
      terms.score_version,
      terms.signals_json,
      terms.observed_at,
      scanId,
      now,
    );
}

// ── term_changes ──────────────────────────────────────────────────────────

export function changeStatements(
  db: D1Database,
  endpointId: string,
  changes: TermChangeDraft[],
  context: {
    changedAt: string;
    detectedBy: "crawler" | "human" | "api" | "backfill";
    scanId: string | null;
    scoreVersion: string | null;
    oldHash: string | null;
    newHash: string | null;
  },
): D1PreparedStatement[] {
  return changes.map((change) =>
    db
      .prepare(
        `INSERT INTO term_changes
           (id, endpoint_id, changed_at, detected_by, change_kind, field,
            old_value, new_value, old_challenge_hash, new_challenge_hash,
            scan_id, score_version, note, corrects_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .bind(
        newId(),
        endpointId,
        context.changedAt,
        context.detectedBy,
        change.change_kind,
        change.field,
        change.old_value,
        change.new_value,
        context.oldHash,
        context.newHash,
        context.scanId,
        context.scoreVersion,
        context.changedAt,
      ),
  );
}

// ── scans ─────────────────────────────────────────────────────────────────

export type RetainedReason =
  | "first_seen"
  | "changed"
  | "error"
  | "human"
  | "sampled"
  | "claim_evidence";

export interface ScanRow {
  id: string;
  endpoint_id: string;
  requested_at: string;
  completed_at: string | null;
  source: "crawler" | "human" | "api" | "claim";
  retained_reason: RetainedReason;
  ok: boolean;
  http_status: number | null;
  error_code: string | null;
  error_detail: string | null;
  wire_form: string | null;
  x402_version: number | null;
  challenge_valid: boolean | null;
  challenge_hash: string | null;
  challenge_json: string | null;
  signals_json: string | null;
  score: number | null;
  band: string | null;
  score_version: string | null;
  latency_ms: number | null;
  redirect_count: number;
  bytes_read: number | null;
  served_from_cache: boolean;
}

export function scanStatement(db: D1Database, scan: ScanRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scans
         (id, endpoint_id, requested_at, completed_at, source, retained_reason, ok,
          http_status, error_code, error_detail, wire_form, x402_version,
          challenge_valid, challenge_hash, challenge_json, signals_json, score, band,
          score_version, latency_ms, redirect_count, tls_protocol, bytes_read,
          served_from_cache, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      scan.id,
      scan.endpoint_id,
      scan.requested_at,
      scan.completed_at,
      scan.source,
      scan.retained_reason,
      scan.ok ? 1 : 0,
      scan.http_status,
      scan.error_code,
      scan.error_detail,
      scan.wire_form,
      scan.x402_version,
      scan.challenge_valid === null ? null : scan.challenge_valid ? 1 : 0,
      scan.challenge_hash,
      scan.challenge_json,
      scan.signals_json,
      scan.score,
      scan.band,
      scan.score_version,
      scan.latency_ms,
      scan.redirect_count,
      scan.bytes_read,
      scan.served_from_cache ? 1 : 0,
      scan.completed_at ?? scan.requested_at,
    );
}

// ── provenance ────────────────────────────────────────────────────────────

export interface ProvenanceRow {
  endpoint_id: string;
  source: "bazaar" | "awesome-x402" | "ecosystem" | "human" | "crawler" | "seed" | "claim";
  source_url: string | null;
  facilitator_id: string | null;
  claimed_last_updated: string | null;
  observed_at: string;
  first_observed_at: string;
  raw_json: string | null;
}

/**
 * Record where an endpoint came from and what that source claimed.
 *
 * `claimed_last_updated` is stored here and NOWHERE else, which is the point:
 * a Bazaar `lastUpdated` is a facilitator's claim about a third party's
 * resource. Recording it as provenance keeps it available to show ("Coinbase's
 * Bazaar said this changed on…") while making it structurally impossible for it
 * to be mistaken for `endpoints.first_seen`.
 */
export function provenanceStatement(
  db: D1Database,
  row: ProvenanceRow,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO endpoint_provenance
         (id, endpoint_id, source, source_url, facilitator_id, claimed_last_updated,
          observed_at, first_observed_at, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint_id, source, facilitator_id) DO UPDATE SET
         claimed_last_updated = excluded.claimed_last_updated,
         observed_at = excluded.observed_at,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      newId(),
      row.endpoint_id,
      row.source,
      row.source_url,
      row.facilitator_id,
      row.claimed_last_updated,
      row.observed_at,
      row.first_observed_at,
      row.raw_json,
      now,
      now,
    );
}

// ── recipient observations ────────────────────────────────────────────────

/**
 * Record that this endpoint paid to this address at this moment.
 *
 * Collected but NOT scored in v1 — see `history.ts`. for the
 * reasoning. The table exists because the only thing that can distinguish a
 * marketplace from an unstable recipient is the *shape of the set over time*,
 * and that shape is invisible until somebody starts writing it down.
 */
export function recipientStatement(
  db: D1Database,
  endpointId: string,
  payTo: string,
  network: string | null,
  declaredDynamic: boolean,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recipient_observations
         (endpoint_id, pay_to, network, first_seen, last_seen, times_seen, declared_dynamic, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(endpoint_id, pay_to) DO UPDATE SET
         last_seen = excluded.last_seen,
         times_seen = times_seen + 1,
         declared_dynamic = MAX(declared_dynamic, excluded.declared_dynamic)`,
    )
    .bind(endpointId, payTo, network, now, now, declaredDynamic ? 1 : 0, now);
}

export interface RecipientShape {
  distinct: number;
  total_observations: number;
  seen_once: number;
  declared_dynamic: boolean;
}

export async function recipientShape(
  db: D1Database,
  endpointId: string,
): Promise<RecipientShape> {
  const row = await db
    .prepare(
      `SELECT count(*) AS distinct_count,
              COALESCE(sum(times_seen), 0) AS total,
              COALESCE(sum(CASE WHEN times_seen = 1 THEN 1 ELSE 0 END), 0) AS once,
              COALESCE(max(declared_dynamic), 0) AS dynamic
         FROM recipient_observations
        WHERE endpoint_id = ?`,
    )
    .bind(endpointId)
    .first<Record<string, unknown>>();

  return {
    distinct: Number(row?.distinct_count ?? 0),
    total_observations: Number(row?.total ?? 0),
    seen_once: Number(row?.once ?? 0),
    declared_dynamic: Number(row?.dynamic ?? 0) === 1,
  };
}

// ── cycles ────────────────────────────────────────────────────────────────

/**
 * Persist the cycle's accounting.
 *
 * A table and not a log line: we have to compute a bounded worst-case monthly
 * bill from these, and a log line is gone in a week and cannot be summed.
 */
export async function recordCycle(
  db: D1Database,
  stats: CycleStats,
  completedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO crawl_cycles
         (id, kind, cron, started_at, completed_at, budget, considered, enqueued,
          probes_attempted, probes_performed, probes_cached, skipped_robots,
          skipped_optout, skipped_budget, changes_written, errors, endpoints_added,
          items_seen, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         completed_at = excluded.completed_at,
         considered = excluded.considered,
         enqueued = excluded.enqueued,
         probes_attempted = excluded.probes_attempted,
         probes_performed = excluded.probes_performed,
         probes_cached = excluded.probes_cached,
         skipped_robots = excluded.skipped_robots,
         skipped_optout = excluded.skipped_optout,
         skipped_budget = excluded.skipped_budget,
         changes_written = excluded.changes_written,
         errors = excluded.errors,
         endpoints_added = excluded.endpoints_added,
         items_seen = excluded.items_seen,
         note = excluded.note`,
    )
    .bind(
      stats.id,
      stats.kind,
      stats.cron,
      stats.started_at,
      completedAt,
      stats.budget,
      stats.considered,
      stats.enqueued,
      stats.probes_attempted,
      stats.probes_performed,
      stats.probes_cached,
      stats.skipped_robots,
      stats.skipped_optout,
      stats.skipped_budget,
      stats.changes_written,
      stats.errors,
      stats.endpoints_added,
      stats.items_seen,
      stats.note,
      stats.started_at,
    )
    .run();
}
