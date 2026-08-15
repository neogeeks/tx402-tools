/**
 * Opt-out, honoured within one crawl cycle.
 *
 * `docs/abuse-policy.md` promises four routes out, and this module implements
 * the three a machine can check:
 *
 *   1. `robots.txt`                          → `robots.ts`
 *   2. `/.well-known/x402-tools-optout`      → here, checked live
 *   3. the opt-out form, proven by DNS TXT or the well-known file → here, via D1
 *   4. email to abuse@tx402.io → a human writes the D1 row
 *
 * Two properties that the policy states and that are easy to lose:
 *
 * **Honoured at READ time, not only at crawl time.** An operator who opts out
 * should disappear from the site immediately, not at the next sweep. So the
 * check is a query any route can make, and `worker/routes/optout.ts` marks the
 * endpoint's stored status in the same transaction that records the opt-out.
 *
 * **Records already written are not deleted.** `term_changes` is append-only by
 * database trigger. Opting out stops the probing and stops the serving; it does
 * not rewrite history, because a change log that can be erased on request is
 * worth nothing to the operator it is later used against.
 */

import { CRAWLER_USER_AGENT } from "../lib/guard.js";
import { asString } from "./coerce.js";

/** The file an operator serves to opt out without talking to us at all. */
export const OPTOUT_WELL_KNOWN = "/.well-known/x402-tools-optout";

/** The DNS TXT name that proves control for the form. */
export const OPTOUT_TXT_NAME = "_x402-tools";

export interface OptOutRecord {
  scope: "origin" | "endpoint";
  target: string;
  method: "well-known" | "dns-txt" | "robots" | "email" | "manual";
  evidence: string | null;
  effective_at: string;
}

/**
 * Is this endpoint opted out, by origin or exactly?
 *
 * One query covering both scopes, because an origin-scoped opt-out must cover
 * every endpoint under it — including ones discovered after the opt-out was
 * recorded, which a set of per-endpoint rows written at opt-out time would
 * silently miss.
 */
export async function isOptedOut(
  db: D1Database,
  canonicalUrl: string,
  origin: string,
  now: string,
): Promise<OptOutRecord | null> {
  const row = await db
    .prepare(
      `SELECT scope, target, method, evidence, effective_at
         FROM optouts
        WHERE revoked_at IS NULL
          AND effective_at <= ?
          AND ((scope = 'endpoint' AND target = ?) OR (scope = 'origin' AND target = ?))
        ORDER BY effective_at
        LIMIT 1`,
    )
    .bind(now, canonicalUrl, origin)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    scope: row.scope === "origin" ? "origin" : "endpoint",
    target: asString(row.target, ""),
    method: asString(row.method, "manual") as OptOutRecord["method"],
    evidence: typeof row.evidence === "string" ? row.evidence : null,
    effective_at: asString(row.effective_at, now),
  };
}

/**
 * Check for the well-known opt-out file on an origin.
 *
 * Any 2xx counts, whatever the body — the policy says "with any content", and
 * requiring a particular payload would mean an operator who did the obvious
 * thing (an empty file) stays in the corpus while believing they left it.
 */
export async function checkWellKnownOptOut(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ optedOut: boolean; status: number; evidence: string | null }> {
  try {
    const response = await fetchImpl(`${origin}${OPTOUT_WELL_KNOWN}`, {
      method: "GET",
      headers: { "user-agent": CRAWLER_USER_AGENT },
      redirect: "follow",
    });
    if (!response.ok) return { optedOut: false, status: response.status, evidence: null };
    const body = (await response.text()).slice(0, 512);
    return {
      optedOut: true,
      status: response.status,
      evidence: body.trim().length > 0 ? body.trim() : "(empty file)",
    };
  } catch {
    return { optedOut: false, status: 0, evidence: null };
  }
}

/**
 * Record an opt-out and stop probing everything it covers, in one batch.
 *
 * The endpoint status update is not a nicety: `endpoints.status = 'opted_out'`
 * is what the corpus listing and every tool filter on, so an opt-out that wrote
 * only the `optouts` row would stop the crawler and keep serving the data.
 */
export async function recordOptOut(
  db: D1Database,
  optout: OptOutRecord & { id: string; requested_at: string; note?: string | null },
): Promise<{ endpointsAffected: number }> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO optouts (id, scope, target, method, evidence, requested_at, effective_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, target) DO UPDATE SET
           method = excluded.method,
           evidence = excluded.evidence,
           requested_at = excluded.requested_at,
           effective_at = excluded.effective_at,
           revoked_at = NULL,
           note = excluded.note`,
      )
      .bind(
        optout.id,
        optout.scope,
        optout.target,
        optout.method,
        optout.evidence,
        optout.requested_at,
        optout.effective_at,
        optout.note ?? null,
      ),
  ];

  if (optout.scope === "origin") {
    statements.push(
      db
        .prepare(
          `UPDATE endpoints
              SET status = 'opted_out', next_probe_at = NULL, updated_at = ?
            WHERE origin = ?`,
        )
        .bind(optout.requested_at, optout.target),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE endpoints
              SET status = 'opted_out', next_probe_at = NULL, updated_at = ?
            WHERE canonical_url = ?`,
        )
        .bind(optout.requested_at, optout.target),
    );
  }

  const results = await db.batch(statements);
  const updated = results[1] as unknown as { meta?: { changes?: number } } | undefined;
  return { endpointsAffected: updated?.meta?.changes ?? 0 };
}
