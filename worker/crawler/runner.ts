/**
 * One endpoint, probed and recorded.
 *
 * This is the "probe → diff → write" of pipeline, and the order
 * of the guards in front of it is the abuse policy in executable form:
 *
 *   opted out?      → stop, and do not touch the network
 *   robots.txt?     → stop, and remember so the next sweep does not re-ask
 *   politeness?     → one live probe per endpoint per window, cache for the rest
 *   then, and only then, probe
 *
 * **Every outbound probe goes through `withPoliteness`, never `probe`
 * directly.** The politeness cache is per-endpoint and single-flight — 25
 * concurrent callers produce exactly one outbound request (a test covers it) — and
 * the crawler is not exempt from it just because it is not a person. A crawler
 * that bypassed the cache would be able to out-request the humans it is
 * supposed to be sharing a budget with.
 */

import { dohResolver, workerConnector, type Connector, type Resolver } from "../lib/guard.js";
import { probe } from "../lib/probe.js";
import { extractSignals } from "../lib/signals.js";
import { score, CURRENT_SCORE_VERSION } from "../lib/score.js";
import { facilitatorOrigins, loadFacilitators } from "../lib/facilitators.js";
import { withPoliteness } from "../lib/politeness.js";
import type { Env } from "../types.js";
import { failurePoint, pointFromProbe, writeProbePoint } from "./analytics.js";
import { availabilityChange, diffTerms, snapshotFromProbe } from "./diff.js";
import { buildHistoryInput } from "./history.js";
import { isOptedOut } from "./optout.js";
import { ROBOTS_TTL_SECONDS, fetchRobots, verdictFor } from "./robots.js";
import {
  changeStatements,
  loadTerms,
  markRobotsDisallowed,
  newId,
  recipientStatement,
  scanStatement,
  scheduleNext,
  writeTermsStatement,
  type DueEndpoint,
} from "./store.js";
import { FAILURE_BACKOFF_MINUTES, TIER_INTERVAL_MINUTES, type ProbeTier } from "./types.js";

export interface RunnerOptions {
  resolver?: Resolver;
  connector?: Connector;
  /** Injected in tests; the crawler's own clock otherwise. */
  now?: () => Date;
  /** Injected so robots.txt can be served from a stub in tests. */
  fetchImpl?: typeof fetch;
  /** Politeness window. The crawler's own cadence is far longer than this. */
  windowSeconds?: number;
}

export type ProbeOutcome =
  | { kind: "opted_out"; reason: string }
  | { kind: "robots_disallowed"; reason: string }
  | { kind: "rate_limited"; reason: string }
  | { kind: "cached" }
  | { kind: "error"; code: string; detail: string }
  | { kind: "probed"; changed: boolean; changes: number; ok: boolean };

function iso(date: Date): string {
  return date.toISOString().slice(0, 19) + "Z";
}

function addMinutes(date: Date, minutes: number): string {
  return iso(new Date(date.getTime() + minutes * 60_000));
}

/**
 * When to come back.
 *
 * Failures back off exponentially and cap out, so a permanently dead endpoint
 * costs one probe every three days instead of one every cadence forever. A
 * healthy endpoint returns to its tier's interval immediately — a single blip
 * should not leave an endpoint in slow-mode for a week.
 */
export function nextProbeTime(
  tier: ProbeTier,
  consecutiveFailures: number,
  from: Date,
): string {
  if (consecutiveFailures > 0) {
    const index = Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MINUTES.length - 1);
    return addMinutes(from, FAILURE_BACKOFF_MINUTES[index] ?? 4320);
  }
  // `?? corpus` is not dead code: `probe_tier` is a TEXT column, so a row
  // written before a tier was retired can still carry a name this build does
  // not know, and scheduling `undefined` minutes ahead is an Invalid Date that
  // would quietly drop the endpoint out of the rotation forever.
  return addMinutes(from, TIER_INTERVAL_MINUTES[tier] ?? TIER_INTERVAL_MINUTES.corpus);
}

/**
 * Read robots.txt for an origin, from the cache when it is fresh.
 *
 * The cache is what stops honouring robots.txt from becoming a second request
 * per probe — which would double our traffic to every origin in the name of
 * being polite to it.
 */
export async function robotsFor(
  env: Pick<Env, "DB">,
  origin: string,
  path: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<{ allowed: boolean; crawlDelaySeconds: number | null; reason: string }> {
  const nowIso = iso(now);

  const cached = await env.DB.prepare(
    `SELECT body, fetch_status, expires_at FROM robots_cache WHERE origin = ?`,
  )
    .bind(origin)
    .first<Record<string, unknown>>();

  if (cached && typeof cached.expires_at === "string" && cached.expires_at > nowIso) {
    return verdictFor(
      typeof cached.body === "string" ? cached.body : null,
      Number(cached.fetch_status ?? 0),
      path,
    );
  }

  const fetched = await fetchRobots(origin, fetchImpl);
  const verdict = verdictFor(fetched.body, fetched.status, path);

  await env.DB.prepare(
    `INSERT INTO robots_cache (origin, body, fetched_at, expires_at, fetch_status, allows_us, crawl_delay_s)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(origin) DO UPDATE SET
       body = excluded.body,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at,
       fetch_status = excluded.fetch_status,
       allows_us = excluded.allows_us,
       crawl_delay_s = excluded.crawl_delay_s`,
  )
    .bind(
      origin,
      fetched.body,
      nowIso,
      addMinutes(now, ROBOTS_TTL_SECONDS / 60),
      fetched.status,
      fetched.allowsUs ? 1 : 0,
      verdict.crawlDelaySeconds,
    )
    .run();

  return verdict;
}

/**
 * Probe one endpoint and record what came back.
 *
 * The write policy, which is the part that has to be exactly right:
 *
 *   Analytics Engine ALWAYS — one availability/latency point per probe,
 *                     including failures, which are the interesting ones.
 *   terms_current always on a successful probe (it is "right now").
 *   term_changes ONLY when `diffTerms` returns rows.
 *   scans ONLY when `retained_reason` applies — first_seen, changed
 *                     or error. A routine unchanged crawler probe writes NO
 *                     scan row.
 */
export async function probeEndpoint(
  env: Env,
  endpoint: DueEndpoint,
  options: RunnerOptions = {},
): Promise<ProbeOutcome> {
  const now = options.now?.() ?? new Date();
  const nowIso = iso(now);
  const fetchImpl = options.fetchImpl ?? fetch;

  // 1. Opt-out, checked before anything touches the network.
  const optout = await isOptedOut(env.DB, endpoint.canonical_url, endpoint.origin, nowIso);
  if (optout) {
    await env.DB.prepare(
      `UPDATE endpoints SET status = 'opted_out', next_probe_at = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, endpoint.id)
      .run();
    return {
      kind: "opted_out",
      reason: `opted out by ${optout.method} on ${optout.scope} ${optout.target}`,
    };
  }

  // 2. robots.txt.
  const robots = await robotsFor(env, endpoint.origin, endpoint.path, now, fetchImpl);
  if (!robots.allowed) {
    await markRobotsDisallowed(env.DB, endpoint.id, nowIso);
    return { kind: "robots_disallowed", reason: robots.reason };
  }

  // 3. The probe itself, behind the politeness cache.
  const resolver = options.resolver ?? dohResolver();
  const connector = options.connector ?? workerConnector;

  const outcome = await withPoliteness(
    env,
    {
      endpointId: endpoint.id,
      ...(options.windowSeconds === undefined ? {} : { windowSeconds: options.windowSeconds }),
      // The crawler yields to whoever is already probing rather than queueing
      // behind them: it can always come back on the next sweep, and a human
      // waiting on the Inspector cannot.
      noWait: true,
    },
    () => probe(endpoint.canonical_url, { resolver, connector }),
  );

  if (outcome.result === null) {
    return {
      kind: "rate_limited",
      reason: outcome.refusal?.reason ?? "politeness window closed",
    };
  }

  const guarded = outcome.result;

  // A guard refusal is an availability observation and an error scan, not an
  // exception. Recording it is the point: "this endpoint stopped resolving" is
  // exactly what History is for.
  if (!guarded.ok) {
    writeProbePoint(
      env.PROBES,
      failurePoint(endpoint.id, endpoint.host, guarded.failure.code, "crawler"),
    );

    await env.DB.batch([
      scanStatement(env.DB, {
        id: newId(),
        endpoint_id: endpoint.id,
        requested_at: nowIso,
        completed_at: nowIso,
        source: "crawler",
        retained_reason: "error",
        ok: false,
        http_status: null,
        error_code: guarded.failure.code,
        error_detail: guarded.failure.reason,
        wire_form: null,
        x402_version: null,
        challenge_valid: null,
        challenge_hash: null,
        challenge_json: null,
        signals_json: null,
        score: null,
        band: null,
        score_version: null,
        latency_ms: null,
        redirect_count: 0,
        bytes_read: null,
        served_from_cache: false,
      }),
    ]);

    await scheduleNext(
      env.DB,
      endpoint.id,
      nextProbeTime(endpoint.probe_tier, endpoint.consecutive_failures + 1, now),
      nowIso,
      { ok: false, status: "unreachable" },
    );

    return { kind: "error", code: guarded.failure.code, detail: guarded.failure.stage };
  }

  const result = guarded.value;

  // Availability and latency: always, and only, here.
  writeProbePoint(env.PROBES, pointFromProbe(result, "crawler"));

  if (outcome.cached) {
    // Somebody else's probe answered this. It is a real observation and is
    // already recorded by whoever led; re-writing it would double-count.
    return { kind: "cached" };
  }

  // 4. Score it, with history filled in.
  const facilitators = await loadFacilitators(env);
  const { history, recipients } = await buildHistoryInput(env.DB, endpoint.id, nowIso);

  const signals = extractSignals(result, {
    knownFacilitators: facilitatorOrigins(facilitators.rows),
    history,
  });
  const risk = score(signals, CURRENT_SCORE_VERSION, {
    // Historical signals are reported but not scored (see history.ts), so the
    // confidence label reflects what we HAVE, not what we scored.
    confidence: history.scan_count && history.scan_count > 0 ? "with_history" : "static_only",
  });

  // 5. Diff against what we had.
  const previous = await loadTerms(env.DB, endpoint.id);
  const snapshot = snapshotFromProbe(result, risk, signals);
  const changes = diffTerms(previous, snapshot);

  const statusChange = availabilityChange(
    endpoint.status === "active" ? "active" : endpoint.status,
    "active",
  );
  if (statusChange) changes.push(statusChange);

  const scanId = changes.length > 0 || previous === null ? newId() : null;
  const statements = [writeTermsStatement(env.DB, endpoint.id, snapshot, scanId, nowIso)];

  if (changes.length > 0) {
    statements.push(
      ...changeStatements(env.DB, endpoint.id, changes, {
        changedAt: nowIso,
        detectedBy: "crawler",
        scanId,
        scoreVersion: risk?.score_version ?? null,
        oldHash: previous?.challenge_hash ?? null,
        newHash: snapshot.challenge_hash,
      }),
    );
  }

  // The scan row exists only for a reason the CHECK constraint accepts.
  if (scanId !== null) {
    statements.push(
      scanStatement(env.DB, {
        id: scanId,
        endpoint_id: endpoint.id,
        requested_at: nowIso,
        completed_at: nowIso,
        source: "crawler",
        retained_reason: previous === null ? "first_seen" : "changed",
        ok: true,
        http_status: result.probe.http_status,
        error_code: null,
        error_detail: null,
        wire_form: result.challenge.wire_form,
        x402_version: result.challenge.x402_version,
        challenge_valid: result.challenge.valid,
        challenge_hash: result.challenge.hash,
        challenge_json: result.challenge.raw,
        signals_json: JSON.stringify(signals),
        score: risk?.score ?? null,
        band: risk?.band ?? null,
        score_version: risk?.score_version ?? null,
        latency_ms: result.probe.latency_ms,
        redirect_count: result.probe.redirect_count,
        bytes_read: result.probe.bytes_read,
        served_from_cache: false,
      }),
    );
  }

  // Recipient evidence, collected and not scored (history.ts).
  if (snapshot.pay_to) {
    statements.push(
      recipientStatement(
        env.DB,
        endpoint.id,
        snapshot.pay_to,
        snapshot.network,
        snapshot.pay_to_dynamic || recipients.declared_dynamic,
        nowIso,
      ),
    );
  }

  await env.DB.batch(statements);

  // An origin that answered but served no x402 challenge is not an x402
  // endpoint. Marking it stops it consuming probe budget forever — which is
  // what makes a conservative-but-imperfect seed parser affordable (seeds.ts):
  // a wrong candidate costs exactly one probe, once.
  const servedChallenge = result.challenge.wire_form !== "none";

  await scheduleNext(
    env.DB,
    endpoint.id,
    nextProbeTime(endpoint.probe_tier, 0, now),
    nowIso,
    {
      ok: true,
      status: servedChallenge ? "active" : "not_x402",
      changed: changes.length > 0,
    },
  );

  return {
    kind: "probed",
    changed: changes.length > 0,
    changes: changes.length,
    ok: true,
  };
}
