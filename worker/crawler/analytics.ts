/**
 * Workers Analytics Engine — the telemetry half of.
 *
 * The split this file exists to hold: **availability and latency are frequent
 * and disposable; price and recipient changes are rare and precious.** One
 * datapoint per probe goes here and is only ever read as an aggregate. Nothing
 * that a merchant could be asked to answer for is stored here, because these
 * numbers are sampled and retention-bounded — fine for "99.94% available",
 * unacceptable for "the recipient changed on Jul 21", which lives in D1's
 * append-only `term_changes`.
 *
 * ── The read path is PROVEN ─────────────────────────────
 *
 * We verified the write path and left the read path open, and every session
 * after it inherited the risk that its entire History tool was built on
 * something unreadable. It is now closed, by round trip rather than by
 * inference: a datapoint was written, and after ingestion the same datapoint
 * was read back through the SQL API with a timestamp matching the write to the
 * second. Numbers and method.
 *
 * Two things that round trip taught, both load-bearing for:
 *
 *  1. **Ingestion is not immediate.** The point was not visible at +12s and was
 *     visible later. History must never render "no data" for a probe that just
 *     happened — read D1 for the recent edge and Analytics Engine for the
 *     aggregate.
 *  2. **The querying credential is not the deploy credential.** The SQL API is
 *     an account-level HTTP endpoint, not a binding: it takes an API token with
 *     Account Analytics Read, which the Worker does not have and cannot mint.
 *     `queryAnalytics` therefore takes its credential as an argument rather than
 *     reading a binding that does not exist —., where the two
 *     config values are routed to the integrator instead of being added to
 *     `wrangler.jsonc`.
 */

import type { ProbeResult } from "../lib/probe.js";

/**
 * The datapoint layout, frozen here because reads these column positions.
 *
 * Analytics Engine columns are positional (`blob1`…`blob20`, `double1`…), so a
 * reordering is a silent data corruption rather than a compile error. Changing
 * a position means the old rows still hold the old meaning and no migration can
 * fix them — append at the end instead.
 */
export const PROBE_POINT_LAYOUT = Object.freeze({
  blob1: "kind",
  blob2: "endpoint_id",
  blob3: "host",
  blob4: "wire_form",
  blob5: "error_code",
  blob6: "source",
  double1: "ok",
  double2: "latency_ms",
  double3: "http_status",
  double4: "bytes_read",
  double5: "redirect_count",
  index1: "endpoint_id",
});

export interface ProbePoint {
  endpointId: string;
  host: string;
  ok: boolean;
  wireForm: string;
  errorCode: string | null;
  source: "crawler" | "human" | "api";
  latencyMs: number | null;
  httpStatus: number | null;
  bytesRead: number | null;
  redirectCount: number;
}

/**
 * Write one availability/latency datapoint.
 *
 * Never throws. A telemetry write that can fail a crawl cycle would mean a
 * transient Analytics Engine problem costs us the price change we were probing
 * for — the two are stored separately precisely so one cannot take the other
 * down.
 */
export function writeProbePoint(
  dataset: AnalyticsEngineDataset | undefined,
  point: ProbePoint,
): boolean {
  if (!dataset) return false;
  try {
    dataset.writeDataPoint({
      // `indexes` takes exactly one value and drives sampling. Indexing by
      // endpoint means a high-traffic endpoint is sampled independently of a
      // quiet one, so a quiet endpoint's availability stays readable.
      indexes: [point.endpointId],
      blobs: [
        "probe",
        point.endpointId,
        point.host,
        point.wireForm,
        point.errorCode ?? "",
        point.source,
      ],
      doubles: [
        point.ok ? 1 : 0,
        point.latencyMs ?? 0,
        point.httpStatus ?? 0,
        point.bytesRead ?? 0,
        point.redirectCount,
      ],
    });
    return true;
  } catch {
    return false;
  }
}

/** Build a datapoint from a probe result. */
export function pointFromProbe(
  result: ProbeResult,
  source: ProbePoint["source"],
): ProbePoint {
  return {
    endpointId: result.target.endpoint_id,
    host: result.target.host,
    ok: result.challenge.wire_form !== "none",
    wireForm: result.challenge.wire_form,
    errorCode: result.challenge.decode_error?.code ?? null,
    source,
    latencyMs: result.probe.latency_ms,
    httpStatus: result.probe.http_status,
    bytesRead: result.probe.bytes_read,
    redirectCount: result.probe.redirect_count,
  };
}

/** A failed probe is still an availability observation, and the important one. */
export function failurePoint(
  endpointId: string,
  host: string,
  errorCode: string,
  source: ProbePoint["source"],
  latencyMs: number | null = null,
): ProbePoint {
  return {
    endpointId,
    host,
    ok: false,
    wireForm: "none",
    errorCode,
    source,
    latencyMs,
    httpStatus: null,
    bytesRead: null,
    redirectCount: 0,
  };
}

// ── the read path ─────────────────────────────────────────────────────────

export const ANALYTICS_DATASET = "tx402_tools_probes";

export interface AnalyticsCredential {
  accountId: string;
  /** An API token with **Account Analytics Read**. Not the deploy token. */
  token: string;
}

export interface AnalyticsRow {
  [column: string]: string | number | null;
}

/**
 * Run one SQL query against the Analytics Engine SQL API.
 *
 * Returns `null` rather than throwing when the credential is missing or the API
 * refuses, so a caller renders "no data" instead of a 500. the page must show the
 * difference between *we have no samples* and *we could not ask*, so the
 * refusal reason is returned alongside.
 */
export async function queryAnalytics(
  credential: AnalyticsCredential | null,
  sql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rows: AnalyticsRow[] | null; error: string | null }> {
  if (!credential || !credential.token || !credential.accountId) {
    return { rows: null, error: "no analytics credential configured" };
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${credential.accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.token}` },
        body: sql,
      },
    );
  } catch (error) {
    return { rows: null, error: error instanceof Error ? error.message : "fetch failed" };
  }

  if (!response.ok) {
    return { rows: null, error: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { rows: null, error: "response was not JSON" };
  }

  // A failed query returns 200 with `success: false`, so the status code alone
  // is not the check.
  const parsed = body as { data?: unknown; success?: boolean; errors?: unknown[] };
  if (parsed.success === false) {
    const first = parsed.errors?.[0] as { message?: string } | undefined;
    return { rows: null, error: first?.message ?? "query failed" };
  }
  if (!Array.isArray(parsed.data)) {
    return { rows: null, error: "no data array in response" };
  }

  return { rows: parsed.data as AnalyticsRow[], error: null };
}

/**
 * Availability and latency for one endpoint over a window.
 *
 * `sum(_sample_interval)` rather than `count`: Analytics Engine samples under
 * load and each stored row stands for `_sample_interval` real ones. Counting
 * rows would under-report exactly when an endpoint is busiest, which is when
 * the availability number matters most.
 *
 * The result carries `sampled: true` unconditionally, because SPEC §5.4 makes
 * that mandatory for anything sourced here — it is what stops the History page
 * presenting a sampled ratio and an exact price change as the same kind of
 * fact.
 *
 * ── Availability counts failures. Latency must not. ───────────────────────. — edited outside its allocation with in-session
 * authorization.)
 *
 * A failed probe is written with a latency of 0: `failurePoint` leaves it null
 * and `writeProbePoint` coerces null to 0 in the doubles array. Those zeros
 * belong in the availability ratio — writing a datapoint for every probe,
 * including the failures, is the whole point — but as values in the latency
 * distribution they drag the median down, and drag it further the more an
 * endpoint fails. **The reported latency would improve as an endpoint broke**,
 * which is backwards, and wrong exactly when someone is looking at the page to
 * find out whether it is in trouble.
 *
 * Measured on the live dataset: with failures included the median was 221 ms
 * against a true 236 ms at a 23% failure rate — and that gap widens with the
 * failure rate rather than staying a fixed offset.
 *
 * So each row is weighted by `_sample_interval` **only when the probe
 * succeeded**, and by 0 otherwise, which drops it from the distribution. That
 * equivalence is not assumed: run against live data, this form and a
 * `WHERE double1 > 0` control returned an identical p50 over an identical
 * sample count.
 *
 * `quantileExactWeighted` is the documented spelling. The `quantileWeighted`
 * alias this line used before does work — verified live; the current reference
 * simply omits the curried form — but the line now ships the exact string that
 * was tested.
 */
export function availabilityQuery(endpointId: string, days: number): string {
  const id = endpointId.replace(/'/gu, "");
  return `SELECT
      sum(_sample_interval) AS samples,
      sum(if(double1 > 0, _sample_interval, 0)) AS ok_samples,
      quantileExactWeighted(0.5)(double2, if(double1 > 0, _sample_interval, 0)) AS p50_ms,
      quantileExactWeighted(0.95)(double2, if(double1 > 0, _sample_interval, 0)) AS p95_ms
    FROM ${ANALYTICS_DATASET}
    WHERE blob1 = 'probe'
      AND blob2 = '${id}'
      AND timestamp > now() - INTERVAL '${Math.floor(days)}' DAY
    FORMAT JSON`;
}

export interface AvailabilitySummary {
  /** Every probe in the window, failures included — `availability`'s denominator. */
  samples: number;
  availability: number | null;
  /**
   * Successful probes only — the denominator of `p50_ms` and `p95_ms`.
   *
   * Separate from `samples` because the latency figures are computed over a
   * different, smaller population. A caller rendering "236 ms over 221 samples"
   * would be attaching the wrong denominator to a sampled figure, which is the
   * class of error the storage split exists to prevent.
   */
  latency_samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  /** Always true. SPEC §5.4 requires it to be stated, not inferred. */
  sampled: true;
}

export async function availabilityFor(
  credential: AnalyticsCredential | null,
  endpointId: string,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ summary: AvailabilitySummary | null; error: string | null }> {
  const { rows, error } = await queryAnalytics(
    credential,
    availabilityQuery(endpointId, days),
    fetchImpl,
  );
  if (!rows) return { summary: null, error };

  const row = rows[0];
  if (!row) return { summary: null, error: null };

  const num = (value: unknown): number | null => {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  };

  const samples = num(row.samples) ?? 0;
  const okSamples = num(row.ok_samples) ?? 0;

  return {
    summary: {
      samples,
      availability: samples > 0 ? okSamples / samples : null,
      // The latency quantiles are computed over the successful probes only, so
      // this is their denominator — not `samples`.
      latency_samples: okSamples,
      p50_ms: num(row.p50_ms),
      p95_ms: num(row.p95_ms),
      sampled: true,
    },
    error: null,
  };
}
