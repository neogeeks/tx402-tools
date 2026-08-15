/**
 * Claim your endpoint.
 *
 * an operator must be able to claim an endpoint (DNS TXT or a
 * `/.well-known` file), **see exactly what was observed**, correct a wrong fact,
 * and opt out — and this ships WITH the first public risk score, not after the
 * first angry email. `/methodology` is the page that says how the score is
 * produced; this is the route that lets the person it is about answer back.
 *
 * ── Three calls ──────────────────────────────────────────────────────────
 *
 *   POST /api/v1/claim issue a challenge token for an origin
 *   POST /api/v1/claim/:id/verify check the DNS TXT record or the well-known file
 *   GET /api/v1/claim/:id the state, and once verified the whole dossier
 *
 * `POST /api/v1/appeal` is the fourth, in `./appeal.ts`, and it requires a
 * verified claim. The two are one flow: prove control, read what we published,
 * dispute a fact or ask to be removed.
 *
 * ── The dossier is the appeal mechanism, not a summary of it ─────────────
 *
 * A verified claim returns, per endpoint under the origin: the terms we hold,
 * the **raw signals** we scored, the score those signals produce **recomputed
 * live from them**, and `reproduced` — the same number derived a second time
 * from `reasons[]` alone by `reproduceScore`. makes
 * reproducibility the appeal mechanism, so an operator who disagrees is handed
 * the arithmetic rather than an assurance that it exists.
 *
 * ── Nobody is identified ─────────────────────────────────────────────────
 *
 * There is no account, no sign-in and no contact detail; see `claim-proof.ts`
 * and `migrations/0004_claims_no_people.sql`. Control of the domain is the whole
 * of the authentication story, and the claim id is the return address.
 */

import { envelope, errorResponse, json, nowIso } from "../http.js";
import { dohResolver, endpointId } from "../lib/guard.js";
import { withPoliteness } from "../lib/politeness.js";
import {
  CURRENT_SCORE_VERSION,
  reproduceScore,
  score,
  type Risk,
} from "../lib/score.js";
import type { Signal } from "../lib/signals.js";
import { isOptedOut } from "../crawler/optout.js";
import { asNumber, asString, asStringOrNull } from "../crawler/coerce.js";
import {
  CLAIM_TOKEN_TTL_HOURS,
  CLAIM_TXT_NAME,
  CLAIM_WELL_KNOWN,
  claimById,
  claimExpired,
  claimInstructions,
  claimTarget,
  dohTxtResolver,
  fetchWellKnown,
  insertClaim,
  matchToken,
  matchWellKnown,
  newChallengeToken,
  newClaimId,
  originOf,
  setClaimState,
  wellKnownUrl,
  type Claim,
  type ClaimInstructions,
  type ClaimMethod,
  type ProofResult,
  type TxtResolver,
  type WellKnownObservation,
} from "./claim-proof.js";
import { appealsForOrigin, type AppealRecord } from "./appeal.js";
import { BAND_NOTE } from "../../ui/pages/inspect/types.js";
import type { Connector, Resolver } from "../lib/guard.js";
import type { RouteContext, RouteHandler } from "../types.js";

// ── the response shape ────────────────────────────────────────────────────

export interface ObservedRisk {
  score: number;
  band: string;
  score_version: string;
  /** `reproduceScore(reasons)`. Equal to `score` or the claim in §6.2 is false. */
  reproduced: number;
  /** SPEC §4.5: a band never travels without the sentence that says what it is. */
  band_note: string;
  reasons: Risk["reasons"];
}

export interface ObservedEndpoint {
  canonical_url: string;
  status: string;
  first_seen: string | null;
  last_seen: string | null;
  /** O45: the honest count. `scan_count: 1` is a first observation, not a history. */
  scan_count: number;
  has_history: boolean;
  terms: Record<string, unknown> | null;
  signals: Signal[];
  risk: ObservedRisk | null;
  /** The score exactly as it was stored when it was served, never recomputed. */
  score_as_served: { score: number | null; band: string | null; score_version: string | null };
}

export interface ObservedChange {
  id: string;
  changed_at: string;
  change_kind: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_by: string;
  score_version: string | null;
  corrects_id: string | null;
}

export interface ClaimData {
  id: string | null;
  origin: string | null;
  method: ClaimMethod | null;
  state: string | null;
  challenge_token: string | null;
  instructions: ClaimInstructions | null;
  created_at: string | null;
  verified_at: string | null;
  token_expires_at: string | null;
  observed: {
    endpoints: ObservedEndpoint[];
    changes: ObservedChange[];
    opted_out: boolean;
  } | null;
  appeals: AppealRecord[] | null;
  next_steps: string[];
}

/** Ports, so tests drive real decision logic against fabricated answers. */
export interface ClaimDeps {
  txtResolver?: TxtResolver;
  resolver?: Resolver;
  connector?: Connector;
  now?: () => string;
}

// ── dispatch ──────────────────────────────────────────────────────────────

export function claimHandler(deps: ClaimDeps = {}): RouteHandler {
  return async (ctx: RouteContext): Promise<Response> => {
    const id = ctx.params.id;
    const isVerify = ctx.url.pathname.endsWith("/verify");

    if (ctx.request.method === "POST" && id && isVerify) return verifyClaim(ctx, id, deps);
    if (ctx.request.method === "POST" && !id) return createClaim(ctx, deps);
    if (id) return readClaim(ctx, id, deps);

    // GET /api/v1/claim is not a declared route, so this is unreachable through
    // the router; it exists so a direct call cannot fall through to undefined.
    return errorResponse("NOT_FOUND");
  };
}

export const claim: RouteHandler = claimHandler();

export { appeal } from "./appeal.js";

// ── POST /api/v1/claim ────────────────────────────────────────────────────

interface CreateBody {
  url?: unknown;
  method?: unknown;
}

async function createClaim(ctx: RouteContext, deps: ClaimDeps): Promise<Response> {
  let body: CreateBody;
  try {
    body = await ctx.request.json<CreateBody>();
  } catch {
    return errorResponse("BAD_REQUEST", { message: "The request body must be JSON." });
  }

  if (typeof body.url !== "string" || body.url.length === 0) {
    return errorResponse("VALIDATION_FAILED", {
      message: "A `url` is required — the endpoint you operate, or just its origin.",
      detail: { fields: ["url"] },
    });
  }

  const target = claimTarget(body.url);
  if (!target) {
    return errorResponse("VALIDATION_FAILED", {
      message: "That URL cannot be accepted.",
      detail: { fields: ["url"] },
    });
  }

  const method: ClaimMethod = body.method === "dns-txt" ? "dns-txt" : "well-known";
  const now = (deps.now ?? nowIso)();

  // Deliberately NOT idempotent per origin. Handing a second caller the pending
  // claim of the first would let a stranger poll somebody else's claim and
  // inherit it the moment the real operator verified it.
  const record: Claim = {
    id: newClaimId(),
    endpoint_id: null,
    origin: target.origin,
    method,
    challenge_token: newChallengeToken(),
    state: "pending",
    verified_at: null,
    created_at: now,
    updated_at: now,
  };

  await insertClaim(ctx.env.DB, record);

  return respond(ctx, claimData(record, now, null, null), 201);
}

// ── POST /api/v1/claim/:id/verify ─────────────────────────────────────────

async function verifyClaim(ctx: RouteContext, id: string, deps: ClaimDeps): Promise<Response> {
  const record = await claimById(ctx.env.DB, id);
  if (!record) return errorResponse("NOT_FOUND", { message: "No such claim." });

  const now = (deps.now ?? nowIso)();

  if (record.state === "revoked") {
    return errorResponse("NOT_FOUND", { message: "No such claim." });
  }

  if (record.state !== "verified" && claimExpired(record, now)) {
    // Not an error: the operator did nothing wrong, the token simply aged out.
    // Say so, and say what to do, rather than returning a 4xx they must decode.
    const data = claimData({ ...record, state: "failed" }, now, null, null);
    data.next_steps = [
      `This token was issued more than ${CLAIM_TOKEN_TTL_HOURS} hours ago and is no longer verifiable.`,
      "Start a new claim with POST /api/v1/claim and publish the new token.",
    ];
    return respond(ctx, data);
  }

  const looked = await lookUpProof(ctx, record, deps);

  if ("refusal" in looked) {
    // The politeness budget for this origin is spent. `TARGET_RATE_LIMITED` is
    // exactly this case in the frozen vocabulary — "the endpoint is over its
    // politeness budget" — and it is retryable, so a polling client backs off
    // instead of hammering somebody else's server through us.
    return errorResponse("TARGET_RATE_LIMITED", {
      message:
        "We checked this origin very recently. Try again shortly — nothing is lost, and the claim is still pending.",
      headers:
        looked.refusal === null ? {} : { "retry-after": String(looked.refusal) },
    });
  }

  const { proof, observedAgoSeconds } = looked;

  if (!proof.proven) {
    // Still 200: "we looked and it is not there yet" is the answer they came
    // for, and a 4xx would read as our failure rather than a propagation delay.
    const data = claimData(record, now, null, null);
    data.next_steps = [
      proof.detail ?? "The proof could not be confirmed yet.",
      ...(proof.evidence ? [`What we saw instead: ${proof.evidence}`] : []),
      ...(observedAgoSeconds === null
        ? []
        : [
            `That is what we saw ${observedAgoSeconds} seconds ago — we read each origin at most once per ` +
              `${PROOF_WINDOW_SECONDS} seconds so that a claim flow cannot be pointed at somebody else's ` +
              `server as a load generator. If you have just published the token, wait and call this again.`,
          ]),
      "Nothing is recorded against your endpoint by a failed check. Publish the token and call this again.",
    ];
    return respond(ctx, data);
  }

  await setClaimState(ctx.env.DB, record.id, "verified", now);
  const verified: Claim = { ...record, state: "verified", verified_at: now, updated_at: now };

  const observed = await dossier(ctx, verified, now);
  const appeals = await appealsForOrigin(ctx.env.DB, verified.origin);

  return respond(ctx, claimData(verified, now, observed, appeals));
}

/**
 * How often we will read one origin's proof, however many claims ask.
 *
 * `POST /api/v1/claim/:id/verify` is unauthenticated and makes us fetch a URL
 * on somebody else's server, which is the shape says ends the
 * project: "being a free DDoS cannon aimed at other people's paid APIs". So the
 * lookup goes through the same per-target politeness budget every probe does.
 *
 * Ten minutes would be right for a price; it is wrong here, because the person
 * on the other end has just published a record and is waiting. A minute bounds
 * the amplification to one request per origin per minute — comfortably polite —
 * while keeping the retry loop human.
 */
export const PROOF_WINDOW_SECONDS = 60;

interface ProofLookup {
  proof: ProofResult;
  /** Age of the observation when it came from the cache; null when it was fresh. */
  observedAgoSeconds: number | null;
}

/**
 * Look the proof up, sharing the *observation* between callers and never the
 * verdict.
 *
 * This is the part worth reading twice. The politeness layer caches whatever
 * the callback returns and hands it to the next caller for the same key — so
 * what is cached here is the TXT records, or the bytes of the well-known file,
 * and the token comparison happens afterwards, per claim. Caching the
 * `ProofResult` instead would let one origin's verified claim satisfy a second,
 * different claim's token, which is an authentication bug rather than a
 * performance one.
 *
 * The politeness key is namespaced away from the probe's, so a claim check can
 * neither consume an endpoint's probe budget nor be served a cached probe.
 */
async function lookUpProof(
  ctx: RouteContext,
  record: Claim,
  deps: ClaimDeps,
): Promise<ProofLookup | { refusal: number | null }> {
  const host = originOf(record.origin)?.hostname ?? record.origin;

  if (record.method === "dns-txt") {
    const name = `${CLAIM_TXT_NAME}.${host}`;
    const resolver = deps.txtResolver ?? dohTxtResolver();
    const outcome = await withPoliteness<string[]>(
      ctx.env,
      { endpointId: await endpointId(`claim-dns:${name}`), windowSeconds: PROOF_WINDOW_SECONDS },
      // Swallowed here rather than thrown: `withPoliteness` releases the lease
      // and rethrows, which would turn NXDOMAIN — the ordinary state of a name
      // nobody has published yet — into a 500. No records and no answer are the
      // same fact to the operator, and `matchToken` says the same thing for both.
      () => resolver.resolveTxt(name).catch(() => []),
    );

    if (outcome.result === null) return { refusal: outcome.refusal?.retryAfterSeconds ?? null };
    const records = outcome.result;
    return {
      proof: await matchToken(record.challenge_token, name, () => Promise.resolve(records)),
      observedAgoSeconds: outcome.cached ? outcome.cacheAgeSeconds : null,
    };
  }

  const url = wellKnownUrl(record.origin);
  const outcome = await withPoliteness<WellKnownObservation>(
    ctx.env,
    { endpointId: await endpointId(`claim-wellknown:${url}`), windowSeconds: PROOF_WINDOW_SECONDS },
    // `fetchWellKnown` already turns every guard refusal into `reached: false`,
    // so there is nothing here that can throw past the lease.
    () =>
      fetchWellKnown(record.origin, {
        resolver: deps.resolver ?? dohResolver(),
        connector: deps.connector,
      }),
  );

  if (outcome.result === null) return { refusal: outcome.refusal?.retryAfterSeconds ?? null };
  return {
    proof: matchWellKnown(record.challenge_token, url, outcome.result),
    observedAgoSeconds: outcome.cached ? outcome.cacheAgeSeconds : null,
  };
}

// ── GET /api/v1/claim/:id ─────────────────────────────────────────────────

async function readClaim(ctx: RouteContext, id: string, deps: ClaimDeps): Promise<Response> {
  const record = await claimById(ctx.env.DB, id);
  if (!record || record.state === "revoked") {
    return errorResponse("NOT_FOUND", { message: "No such claim." });
  }

  const now = (deps.now ?? nowIso)();

  if (record.state !== "verified") {
    return respond(ctx, claimData(record, now, null, null));
  }

  const observed = await dossier(ctx, record, now);
  const appeals = await appealsForOrigin(ctx.env.DB, record.origin);
  return respond(ctx, claimData(record, now, observed, appeals));
}

// ── the dossier ───────────────────────────────────────────────────────────

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Everything we hold about the origin, per endpoint.
 *
 * Two properties this owes the operator:
 *
 * **The score is recomputed in front of them.** `signals_json` is the stored
 * raw input; `score` runs over it here and `reproduceScore` runs over the
 * result. If the recomputation disagrees with `score_as_served`, that is not
 * hidden — both are in the response, and the difference is the appeal.
 *
 * **Nothing is recomputed silently.** `score_as_served` is the row exactly as
 * it was written, under the `score_version` in force at the time. SPEC §7:
 * historical scores are never recomputed, and a merchant appealing a verdict is
 * shown the score they actually received.
 */
async function dossier(
  ctx: RouteContext,
  record: Claim,
  now: string,
): Promise<ClaimData["observed"]> {
  const endpoints: ObservedEndpoint[] = [];
  const changes: ObservedChange[] = [];
  let optedOut = false;

  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT e.id AS id, e.canonical_url AS canonical_url, e.status AS status,
              e.first_seen AS first_seen, e.last_seen AS last_seen, e.scan_count AS scan_count,
              t.amount_atomic AS amount_atomic, t.amount_decimal AS amount_decimal,
              t.asset_symbol AS asset_symbol, t.asset_address AS asset_address,
              t.asset_decimals AS asset_decimals, t.network AS network, t.scheme AS scheme,
              t.pay_to AS pay_to, t.pay_to_dynamic AS pay_to_dynamic,
              t.max_timeout_seconds AS max_timeout_seconds, t.facilitator AS facilitator,
              t.wire_form AS wire_form, t.x402_version AS x402_version, t.resource AS resource,
              t.observed_at AS observed_at, t.signals_json AS signals_json,
              t.score AS score, t.band AS band, t.score_version AS score_version
         FROM endpoints e
         LEFT JOIN terms_current t ON t.endpoint_id = e.id
        WHERE e.origin = ?
        ORDER BY e.canonical_url
        LIMIT 200`,
    )
      .bind(record.origin)
      .all<Record<string, unknown>>();

    for (const row of rows.results ?? []) {
      const signals = parseJson<Signal[]>(row.signals_json, []);
      const scanCount = asNumber(row.scan_count, 0);

      endpoints.push({
        canonical_url: asString(row.canonical_url, ""),
        status: asString(row.status, "active"),
        first_seen: asStringOrNull(row.first_seen),
        last_seen: asStringOrNull(row.last_seen),
        scan_count: scanCount,
        // a row existing is not a history. One scan is a first
        // observation, and this flow must not tell an operator we have watched
        // them over time when we have looked at them once.
        has_history: scanCount > 1,
        terms:
          row.observed_at === null || row.observed_at === undefined
            ? null
            : {
                amount_atomic: row.amount_atomic ?? null,
                amount_decimal: row.amount_decimal ?? null,
                asset_symbol: row.asset_symbol ?? null,
                asset_address: row.asset_address ?? null,
                asset_decimals: row.asset_decimals ?? null,
                network: row.network ?? null,
                scheme: row.scheme ?? null,
                pay_to: row.pay_to ?? null,
                pay_to_declared_dynamic: Number(row.pay_to_dynamic ?? 0) === 1,
                max_timeout_seconds: row.max_timeout_seconds ?? null,
                facilitator: row.facilitator ?? null,
                wire_form: row.wire_form ?? null,
                x402_version: row.x402_version ?? null,
                resource: row.resource ?? null,
                observed_at: row.observed_at ?? null,
              },
        signals,
        risk: riskFrom(signals),
        score_as_served: {
          score: typeof row.score === "number" ? row.score : null,
          band: typeof row.band === "string" ? row.band : null,
          score_version: typeof row.score_version === "string" ? row.score_version : null,
        },
      });
    }

    const ids = (rows.results ?? []).map((r) => asString(r.id, "")).filter((id) => id.length > 0);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const changeRows = await ctx.env.DB.prepare(
        `SELECT id, changed_at, change_kind, field, old_value, new_value, detected_by,
                score_version, corrects_id
           FROM term_changes
          WHERE endpoint_id IN (${placeholders})
          ORDER BY changed_at DESC
          LIMIT 200`,
      )
        .bind(...ids)
        .all<Record<string, unknown>>();

      for (const row of changeRows.results ?? []) {
        changes.push({
          id: asString(row.id, ""),
          changed_at: asString(row.changed_at, ""),
          change_kind: asString(row.change_kind, ""),
          field: asString(row.field, ""),
          old_value: asStringOrNull(row.old_value),
          new_value: asStringOrNull(row.new_value),
          detected_by: asString(row.detected_by, "crawler"),
          score_version: asStringOrNull(row.score_version),
          corrects_id: asStringOrNull(row.corrects_id),
        });
      }
    }

    optedOut = (await isOptedOut(ctx.env.DB, record.origin, record.origin, now)) !== null;
  } catch {
    // An empty dossier is honest before the corpus has seen the origin, and a
    // 500 is the wrong answer to "show me what you have on me".
  }

  return { endpoints, changes, opted_out: optedOut };
}

function riskFrom(signals: Signal[]): ObservedRisk | null {
  if (signals.length === 0) return null;
  const risk = score(signals);
  if (!risk) return null;
  return {
    score: risk.score,
    band: risk.band,
    score_version: risk.score_version,
    reproduced: reproduceScore(risk.reasons),
    band_note: BAND_NOTE,
    reasons: risk.reasons,
  };
}

// ── assembly and rendering ────────────────────────────────────────────────

function expiryOf(record: Claim): string | null {
  const created = Date.parse(record.created_at);
  if (!Number.isFinite(created)) return null;
  return `${new Date(created + CLAIM_TOKEN_TTL_HOURS * 3_600_000).toISOString().slice(0, 19)}Z`;
}

function claimData(
  record: Claim,
  now: string,
  observed: ClaimData["observed"],
  appeals: AppealRecord[] | null,
): ClaimData {
  const host = originOf(record.origin)?.hostname ?? record.origin;
  const pending = record.state === "pending";
  const instructions = pending
    ? claimInstructions(record.origin, host, record.method, record.challenge_token)
    : null;

  const steps = pending
    ? [
        instructions?.summary ?? "",
        `POST /api/v1/claim/${record.id}/verify once it is published.`,
        `The token stops being verifiable ${CLAIM_TOKEN_TTL_HOURS} hours after it was issued.`,
      ]
    : record.state === "verified"
      ? [
          "You now hold a verified claim. Keep this claim id — it is how you read this dossier again and how you file an appeal, and there is no account to recover it from.",
          `POST /api/v1/appeal with {"claim_id":"${record.id}","disputed":"<signal id or change id>","argument":"…"} to dispute a fact.`,
          `POST /api/v1/appeal with {"claim_id":"${record.id}","remedy":"removal","disputed":"listing","argument":"…"} to be removed from the corpus entirely.`,
          "Losing the id costs you nothing permanent: claim the origin again and every appeal filed for it comes back.",
        ]
      : ["This claim is no longer verifiable. Start a new one with POST /api/v1/claim."];

  return {
    id: record.id,
    origin: record.origin,
    method: record.method,
    state: record.state,
    challenge_token: pending ? record.challenge_token : null,
    instructions,
    created_at: record.created_at,
    verified_at: record.verified_at,
    token_expires_at: pending ? expiryOf(record) : null,
    observed,
    appeals,
    next_steps: steps.filter((s) => s.length > 0),
  };
}

/**
 * JSON, and only JSON.
 *
 * `worker/router.ts` declares every `/api/v1/claim*` route with
 * `negotiated: false`, and `negotiate` resolves any `/api/` path to JSON by
 * construction (SPEC §1.2). The human surface for this flow is `/methodology`,
 * which documents the calls the way `/crawler` documents `POST /api/v1/optout`.
 * Rendering a second representation here would be code no request can reach.
 */
function respond(ctx: RouteContext, data: ClaimData, status = 200): Response {
  const meta = ctx.route;
  return json(envelope(meta, data, { scoreVersion: CURRENT_SCORE_VERSION }), { status }, ctx);
}

/** Re-exported for the methodology page, which documents this contract. */
export { CLAIM_TXT_NAME, CLAIM_WELL_KNOWN, CLAIM_TOKEN_TTL_HOURS };
