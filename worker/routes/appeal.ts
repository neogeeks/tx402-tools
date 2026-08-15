/**
 * Appeal an observation.
 *
 * asks for four things and this route is the last two: correct a
 * wrong fact, and opt out. It ships **with** the first public risk score, not
 * after the first angry email.
 *
 * ── An appeal requires a verified claim, and that is the access control ───
 *
 * There is no sign-in anywhere in this product, so the only thing that can
 * authorise a change to what we publish about a domain is proof of control of
 * that domain. `claim_id` is that proof, already exercised. Accepting anonymous
 * appeals would turn this route into a way to file paperwork against somebody
 * else's business, and accepting anonymous *removals* would make it a
 * denial-of-listing vector — the exact asymmetry `worker/routes/optout.ts`
 * calls out.
 *
 * A claim that does not exist and a claim that exists but is unverified get the
 * **same** answer, deliberately. Distinguishing them would let a caller use
 * this route to confirm that a particular claim id is real.
 *
 * ── Two remedies ─────────────────────────────────────────────────────────
 *
 *   `correction`  the default. Recorded `open` and reviewed by a person. It is
 *                 not auto-upheld: we do not know whether the operator or the
 *                 observation is right, and a route that took their word for it
 *                 would make the corpus editable by whoever controls a domain.
 *                 An upheld correction APPENDS a `correction` row to
 *                 `term_changes` — that table is append-only by database
 *                 trigger, so nothing is ever quietly rewritten.
 *
 *   `removal`     applied immediately. Proof of control is the whole test for
 *                 an opt-out (docs/abuse-policy.md), it has already been passed,
 *                 and nothing about it needs our judgement. This is also the
 *                 **DNS-TXT opt-out path we deferred** to "its claim flow,
 *                 which already builds exactly that machinery".
 *
 * ── What we store of what they write ─────────────────────────────────────
 *
 * `argument` is prose the operator chose to send us. It is capped, stored as
 * sent, never published, and only ever served back through a verified claim for
 * the same origin. It is the one field in this flow that could contain a
 * person's details, and it contains them only if the operator types them — we
 * neither ask for nor require any.
 */

import { envelope, errorResponse, json, nowIso } from "../http.js";
import { asString, asStringOrNull } from "../crawler/coerce.js";
import { recordOptOut } from "../crawler/optout.js";
import { newId } from "../crawler/store.js";
import { claimById, newClaimId, type Claim } from "./claim-proof.js";
import type { RouteContext, RouteHandler } from "../types.js";

export type Remedy = "correction" | "removal";
export type AppealState = "open" | "upheld" | "corrected" | "declined";

/** The cap on operator-supplied prose. Generous for a paragraph, bounded for a database. */
export const MAX_ARGUMENT_CHARS = 4000;
export const MAX_DISPUTED_CHARS = 200;

export interface AppealRecord {
  id: string;
  origin: string;
  endpoint_id: string | null;
  claim_id: string | null;
  disputed: string;
  remedy: Remedy;
  argument: string;
  state: AppealState;
  resolution: string | null;
  correction_change_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface AppealData {
  appeal: AppealRecord;
  /** What happens next, in the operator's terms. */
  next_steps: string[];
  /** Set when `remedy: "removal"` was applied. */
  removal: { effective_at: string; endpoints_affected: number } | null;
}

const APPEAL_COLUMNS =
  "id, origin, endpoint_id, claim_id, disputed, remedy, argument, state, resolution, " +
  "correction_change_id, created_at, resolved_at";

function toAppeal(row: Record<string, unknown>): AppealRecord {
  return {
    id: asString(row.id, ""),
    origin: asString(row.origin, ""),
    endpoint_id: asStringOrNull(row.endpoint_id),
    claim_id: asStringOrNull(row.claim_id),
    disputed: asString(row.disputed, ""),
    remedy: row.remedy === "removal" ? "removal" : "correction",
    argument: asString(row.argument, ""),
    state: (row.state as AppealState) ?? "open",
    resolution: asStringOrNull(row.resolution),
    correction_change_id: asStringOrNull(row.correction_change_id),
    created_at: asString(row.created_at, ""),
    resolved_at: asStringOrNull(row.resolved_at),
  };
}

/**
 * Every appeal ever filed for an origin, whichever claim filed it.
 *
 * Keyed on the origin rather than the claim id on purpose: it is what makes
 * losing a claim id survivable. There is no account to recover from, so
 * re-proving control of the domain has to be enough to get the correspondence
 * back — and this is the query that makes that true.
 */
export async function appealsForOrigin(
  db: D1Database,
  origin: string,
): Promise<AppealRecord[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT ${APPEAL_COLUMNS} FROM appeals WHERE origin = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(origin)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(toAppeal);
  } catch {
    return [];
  }
}

// ── the route ─────────────────────────────────────────────────────────────

interface AppealBody {
  claim_id?: unknown;
  disputed?: unknown;
  argument?: unknown;
  remedy?: unknown;
}

export interface AppealDeps {
  now?: () => string;
}

export function appealHandler(deps: AppealDeps = {}): RouteHandler {
  return async (ctx: RouteContext): Promise<Response> => {
    let body: AppealBody;
    try {
      body = await ctx.request.json<AppealBody>();
    } catch {
      return errorResponse("BAD_REQUEST", { message: "The request body must be JSON." });
    }

    const fields: string[] = [];
    if (typeof body.claim_id !== "string" || body.claim_id.length === 0) fields.push("claim_id");
    if (typeof body.disputed !== "string" || body.disputed.trim().length === 0) fields.push("disputed");
    if (typeof body.argument !== "string" || body.argument.trim().length === 0) fields.push("argument");
    if (fields.length > 0) {
      return errorResponse("VALIDATION_FAILED", {
        message:
          "An appeal needs `claim_id` (a verified claim), `disputed` (the signal id, the change id, " +
          "or \"listing\") and `argument` (what is wrong, in your words).",
        detail: { fields },
      });
    }

    const disputed = (body.disputed as string).trim().slice(0, MAX_DISPUTED_CHARS);
    const argument = (body.argument as string).trim().slice(0, MAX_ARGUMENT_CHARS);
    const remedy: Remedy = body.remedy === "removal" ? "removal" : "correction";

    let claim: Claim | null = null;
    try {
      claim = await claimById(ctx.env.DB, body.claim_id as string);
    } catch {
      claim = null;
    }

    // One answer for "no such claim" and "claim not verified": this route must
    // not become an oracle for whether a claim id exists.
    if (!claim || claim.state !== "verified") {
      return errorResponse("VALIDATION_FAILED", {
        message:
          "`claim_id` must be a claim you have verified. Claim the origin with POST /api/v1/claim " +
          "and complete POST /api/v1/claim/:id/verify first.",
        detail: { fields: ["claim_id"] },
      });
    }

    const now = (deps.now ?? nowIso)();
    const record: AppealRecord = {
      // Sortable, because appeals are read in order and none of this is a
      // capability — the claim id is what confers access, not the appeal id.
      id: newId(),
      origin: claim.origin,
      endpoint_id: null,
      claim_id: claim.id,
      disputed,
      remedy,
      argument,
      state: "open",
      resolution: null,
      correction_change_id: null,
      created_at: now,
      resolved_at: null,
    };

    let removal: AppealData["removal"] = null;

    if (remedy === "removal") {
      const { endpointsAffected } = await recordOptOut(ctx.env.DB, {
        id: newClaimId(),
        scope: "origin",
        target: claim.origin,
        // The proof that was actually passed. `optouts.method` already carries
        // both spellings; the DNS-TXT one had no route until now.
        method: claim.method,
        evidence: `verified claim ${claim.id}`,
        requested_at: now,
        // The policy ceiling is one crawl cycle. There is no reason to make
        // somebody wait for a ceiling we only promised as a maximum.
        effective_at: now,
        note: `appeal ${record.id}`,
      });

      record.state = "upheld";
      record.resolution =
        "Removal applied. Probing has stopped and these endpoints are no longer served. Records " +
        "already written to the append-only change log are retained but not served — that table is " +
        "append-only by database trigger, so nothing about it is quietly rewritten.";
      record.resolved_at = now;
      removal = { effective_at: now, endpoints_affected: endpointsAffected };
    }

    await insertAppeal(ctx.env.DB, record);

    const data: AppealData = {
      appeal: record,
      removal,
      next_steps:
        remedy === "removal"
          ? [
              "The origin is opted out, effective immediately and honoured at read time as well as at crawl time.",
              "Nothing further is required from you.",
              `This appeal stays visible on any verified claim for ${claim.origin}.`,
            ]
          : [
              "Recorded. A correction is reviewed by a person: we do not know yet whether the observation or the objection is right, and a route that simply took your word for it would make the corpus editable by whoever controls a domain.",
              "An upheld correction is APPENDED to the change log as a `correction` row pointing at the record it corrects. Nothing is overwritten, so what we published and what we corrected both stay visible.",
              `Follow it with GET /api/v1/claim/${claim.id} — every appeal for ${claim.origin} is listed on any verified claim for it.`,
              "If the fact you dispute is the score itself, note that the score is arithmetic over the raw signals in the same response: recompute it with the weights in `reasons[]` and tell us which signal is wrong.",
            ],
    };

    return json(envelope(ctx.route, data), { status: 201 }, ctx);
  };
}

export const appeal: RouteHandler = appealHandler();

async function insertAppeal(db: D1Database, record: AppealRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO appeals
         (id, origin, endpoint_id, claim_id, disputed, remedy, argument, state, resolution,
          correction_change_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.origin,
      record.endpoint_id,
      record.claim_id,
      record.disputed,
      record.remedy,
      record.argument,
      record.state,
      record.resolution,
      record.correction_change_id,
      record.created_at,
      record.resolved_at,
    )
    .run();
}
