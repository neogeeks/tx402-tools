/**
 * 402 Verify.
 *
 * Contract: `spec/SPEC.md` §5.2, frozen check ids in §5.2.1.
 * Schemas: `spec/schemas/verify.json`, `spec/schemas/verify-request.json`.
 * Deviations found while implementing:.
 *
 * ── The split is the product ──────────────────────────────────
 *
 * Verification here has two halves and the boundary between them is visible in
 * every representation this route serves:
 *
 *   (a) **Offline.** Decode and validate the challenge with
 *       `decodePaymentRequired`, check the network and asset against the tx402
 *       signed release manifest, the amount for canonical atomic form, the
 *       recipient's shape, the facilitator against the published list, and the
 *       resource origin against the endpoint. This is
 *       `packages/tools-cli/src/verify-offline.ts` — the *same function* the
 *       CLI runs locally, which touches no network at all. The route imports
 *       it rather than reimplementing it, so the hosted verdict and the local
 *       verdict are produced by one piece of code and cannot drift.
 *
 *   (b) **Hosted enrichment.** "Is this amount within the range we have
 *       observed for this endpoint", "is this the recipient we saw last time",
 *       "do we know this endpoint at all". These need the corpus, so they are
 *       an explicit opt-in: `options.enrich` defaults to **false**, and with it
 *       false the route reads nothing and `enrichment` is `null`.
 *
 * The corpus is built by the crawler. Until then — and afterwards, for every endpoint we
 * have not seen — the enriched checks report **`skip` with "no data"**, never
 * `pass`. A missing history is UNKNOWN. decision 5,
 * §6.2). Reporting "we have no record of this endpoint" as if it were a clean
 * bill of health is the single most damaging thing a verifier could do.
 *
 * ── What this route may never say ─────────────────────────────────────────
 *
 * Every string is an observation about a challenge. `pass` / `warn` / `fail`
 * and `LOW` / `MEDIUM` / `HIGH` describe the level of caution our observations
 * support, and the page says so above the fold. The words *scam*, *fraud*,
 * *fraudulent*, *unsafe*, *dangerous* and *malicious* appear nowhere. A
 * recipient that changes under a declared dynamic scheme is a marketplace, and
 * a bare "recipient changed" finding is forbidden in every version of this
 * tool (SPEC §6.4).
 */

import { PACKAGE_VERSION } from "tx402";

import { envelope, errorResponse, html, json, markdown } from "../http.js";
import { facilitatorOrigins, loadFacilitators } from "../lib/facilitators.js";
import { CURRENT_SCORE_VERSION } from "../lib/score.js";
import {
  ENRICHED_CHECK_IDS,
  aggregateVerdict,
  classifyRaw,
  verifyOffline,
  type Check,
  type ChallengeInput,
  type VerifyContext,
} from "../../packages/tools-cli/src/verify-offline.js";
import { verifyMarkdown } from "../../ui/pages/verify/markdown.js";
import { verifyPage } from "../../ui/pages/verify/page.js";
import type { Enrichment, VerifyData } from "../../ui/pages/verify/types.js";
import type { Env, RouteContext, RouteHandler, Warning } from "../types.js";

/** The version string rendered on the page. It is the package that just ran. */
export const TX402_VERSION = PACKAGE_VERSION;

/**
 * Body ceiling. The decoder's own header cap is 64 KiB; this leaves room for
 * the JSON wrapper around it without becoming a memory lever.
 */
const MAX_BODY_BYTES = 256 * 1024;

// ── request parsing ───────────────────────────────────────────────────────

export interface VerifyRequest {
  challenge: ChallengeInput;
  context: VerifyContext | null;
  options: { enrich: boolean };
}

async function readJsonBody(request: Request): Promise<{ value: unknown } | { error: Response }> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return { error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }) };
  }
  if (text.trim().length === 0) return { value: {} };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: errorResponse("BAD_REQUEST", { message: "The request body is not valid JSON." }) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type ParsedRequest =
  | { ok: true; value: VerifyRequest }
  | { ok: false; fields: string[]; message: string };

/**
 * Validate the body against `spec/schemas/verify-request.json`'s shape.
 *
 * Strict about *which* fields are present — "exactly one of header / body /
 * raw" is a real constraint and a caller who sends two has a bug we should
 * name rather than silently resolve — and permissive about their contents,
 * because judging the challenge is the entire job of the thing downstream.
 */
export function parseVerifyRequest(value: unknown): ParsedRequest {
  const body = asRecord(value);
  if (!body) {
    return { ok: false, fields: ["challenge"], message: "Send a JSON object with a `challenge`." };
  }

  const challenge = asRecord(body.challenge);
  if (!challenge) {
    return {
      ok: false,
      fields: ["challenge"],
      message: "Send a `challenge` object with exactly one of `header`, `body` or `raw`.",
    };
  }

  const supplied = (["header", "body", "raw"] as const).filter((key) => {
    const v = challenge[key];
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim().length > 0;
    return typeof v === "object";
  });

  if (supplied.length === 0) {
    return {
      ok: false,
      fields: ["challenge"],
      message: "The `challenge` object must carry one of `header`, `body` or `raw`.",
    };
  }
  if (supplied.length > 1) {
    return {
      ok: false,
      fields: supplied.map((k) => `challenge.${k}`),
      message: `Send exactly one of \`header\`, \`body\` or \`raw\`; ${supplied.length} were supplied.`,
    };
  }

  const context = asRecord(body.context);
  const options = asRecord(body.options);

  return {
    ok: true,
    value: {
      challenge: {
        header: typeof challenge.header === "string" ? challenge.header : null,
        body:
          typeof challenge.body === "string" || asRecord(challenge.body) !== null
            ? (challenge.body as string | Record<string, unknown>)
            : null,
        raw: typeof challenge.raw === "string" ? challenge.raw : null,
      },
      context: context
        ? {
            url: nonEmptyString(context.url),
            expected_origin: nonEmptyString(context.expected_origin),
          }
        : null,
      // Defaulting to false is the product decision, not an implementation
      // detail: the caller opts in to the hosted lookup, never out of it.
      options: { enrich: options?.enrich === true },
    },
  };
}

/** The page form: one textarea, and we work out what was pasted. */
function requestFromUrl(url: URL): VerifyRequest | null {
  const pasted = url.searchParams.get("challenge");
  if (!pasted || pasted.trim().length === 0) return null;
  const endpoint = nonEmptyString(url.searchParams.get("url"));
  return {
    challenge: { raw: pasted.trim() },
    context: endpoint ? { url: endpoint, expected_origin: null } : null,
    // The page never enriches on a GET. Enrichment is a deliberate act, and a
    // link someone clicks is not one.
    options: { enrich: false },
  };
}

// ── enrichment (b) ────────────────────────────────────────────────────────

/**
 * The corpus half, and the honest empty answer.
 *
 * the corpus is not populated yet, so in practice every call here returns "no data" today.
 * The query is written against the real `endpoints` / `terms_current` tables
 * from `migrations/0001_init.sql` anyway, so what ships is the actual code
 * path rather than a placeholder that will need rewriting — and the empty
 * result it produces now is exactly the result it will produce, forever, for
 * an endpoint nobody has scanned.
 *
 * `recipient_matches_observed` deserves its own note. SPEC §6.4 and. between them mean it cannot be
 * answered from one challenge and must never be answered as a bare "the recipient changed": x402 v2
 * has no on-the-wire declaration of dynamic `payTo`, so a marketplace rotating payout addresses is
 * field-for-field identical to an unstable recipient. It therefore reports the *observation* and
 * never a judgement, and it stays `skip` until the corpus can tell those two apart.
 */
async function enrich(
  env: Pick<Env, "DB">,
  endpointUrl: string | null,
  payTo: string | null,
  amountAtomic: string | null,
): Promise<{ enrichment: Enrichment; checks: Check[]; warnings: Warning[] }> {
  const skipAll = (reason: string, detail: string): Check[] =>
    ENRICHED_CHECK_IDS.map((id) => ({ id, status: "skip" as const, offline: false, reason, detail }));

  if (!endpointUrl) {
    return {
      enrichment: {
        endpoint_known: false,
        endpoint_id: null,
        amount_within_observed_range: null,
        observed_amount_range: null,
        recipient_matches_observed: null,
        last_observed_pay_to: null,
      },
      checks: skipAll(
        "no_context_url",
        "Enrichment looks an endpoint up by URL, and no `context.url` was supplied.",
      ),
      warnings: [
        {
          code: "NO_CONTEXT_URL",
          message: "Enrichment was requested without a `context.url`, so nothing could be looked up.",
        },
      ],
    };
  }

  const id = await endpointIdFor(endpointUrl);
  const row = await readTerms(env, id);

  if (!row) {
    return {
      enrichment: {
        endpoint_known: false,
        endpoint_id: id,
        amount_within_observed_range: null,
        observed_amount_range: null,
        recipient_matches_observed: null,
        last_observed_pay_to: null,
      },
      checks: [
        {
          id: "endpoint_known",
          status: "skip",
          offline: false,
          reason: "no_data",
          // "We have never seen it" is the correct answer for a new endpoint,
          // not a degraded one. It is emphatically not a pass.
          detail:
            "We have no record of this endpoint. That is the normal state for one we have not scanned, and it is not a finding either way.",
        },
        {
          id: "amount_within_observed_range",
          status: "skip",
          offline: false,
          reason: "no_data",
          detail: "No amounts have been observed for this endpoint, so there is no range to compare against.",
        },
        {
          id: "recipient_matches_observed",
          status: "skip",
          offline: false,
          reason: "no_data",
          detail: "No recipient has been observed for this endpoint, so there is nothing to compare against.",
        },
      ],
      warnings: [
        {
          code: "NO_HISTORY",
          message: "This endpoint is not in the corpus yet, so the historical checks report no data.",
        },
      ],
    };
  }

  const checks: Check[] = [
    {
      id: "endpoint_known",
      status: "pass",
      offline: false,
      reason: null,
      detail: `This endpoint is in the corpus, first seen ${row.first_seen ?? "at an unrecorded time"}.`,
    },
  ];

  // One observation is not a range. Reporting "within the observed range" from
  // a single sample would be inventing a statistic, which is precisely what
  // forbids for availability and is no better here.
  const observed = row.amount_atomic;
  const samples = row.scan_count ?? 0;
  if (!observed || !amountAtomic || samples < 2) {
    checks.push({
      id: "amount_within_observed_range",
      status: "skip",
      offline: false,
      reason: "insufficient_data",
      detail:
        samples < 2
          ? "We have seen this endpoint fewer than twice, so there is no observed range yet — one observation is a data point, not a range."
          : "No comparable amount has been observed for this endpoint.",
    });
  } else {
    const within = observed === amountAtomic;
    checks.push({
      id: "amount_within_observed_range",
      status: within ? "pass" : "warn",
      offline: false,
      reason: within ? null : "outside_observed_range",
      detail: within
        ? "The amount matches what we last observed for this endpoint."
        : `We last observed ${observed} atomic units for this endpoint; this challenge asks for ${amountAtomic}. Prices change, and this is an observation rather than a finding.`,
    });
  }

  // SPEC §6.4: an observation, never a bare "the recipient changed".
  checks.push({
    id: "recipient_matches_observed",
    status: "skip",
    offline: false,
    reason: "not_yet_scored",
    detail:
      row.pay_to && payTo && row.pay_to !== payTo
        ? "The recipient differs from the one we last observed. x402 v2 lets a server choose a payout address per request, so on its own this distinguishes nothing and is reported without a verdict (SPEC §6.4)."
        : "Recipient stability needs more than one observation, and a per-request payout address is a legitimate x402 v2 pattern, so this is not scored (SPEC §6.4).",
  });

  return {
    enrichment: {
      endpoint_known: true,
      endpoint_id: id,
      amount_within_observed_range:
        observed && amountAtomic && samples >= 2 ? observed === amountAtomic : null,
      observed_amount_range:
        observed && samples >= 2
          ? { min_atomic: observed, max_atomic: observed, samples }
          : null,
      recipient_matches_observed: row.pay_to && payTo ? row.pay_to === payTo : null,
      last_observed_pay_to: row.pay_to,
    },
    checks,
    warnings: [],
  };
}

interface TermsRow {
  amount_atomic: string | null;
  pay_to: string | null;
  scan_count: number | null;
  first_seen: string | null;
}

async function readTerms(env: Pick<Env, "DB">, endpointId: string): Promise<TermsRow | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT t.amount_atomic, t.pay_to, e.scan_count, e.first_seen
         FROM endpoints e
         LEFT JOIN terms_current t ON t.endpoint_id = e.id
        WHERE e.id = ?1`,
    )
      .bind(endpointId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      amount_atomic: typeof row.amount_atomic === "string" ? row.amount_atomic : null,
      pay_to: typeof row.pay_to === "string" ? row.pay_to : null,
      scan_count: typeof row.scan_count === "number" ? row.scan_count : null,
      first_seen: typeof row.first_seen === "string" ? row.first_seen : null,
    };
  } catch {
    // An unreachable corpus is "no data", not an error. The offline half of
    // the answer is complete and correct without it, and failing the whole
    // request because an optional lookup did not work would be worse than
    // saying we do not know.
    return null;
  }
}

/** SPEC §1.5. The canonical form is the join key for every corpus table. */
async function endpointIdFor(rawUrl: string): Promise<string> {
  let canonical = rawUrl;
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.username = "";
    url.password = "";
    if (url.pathname === "") url.pathname = "/";
    url.searchParams.sort();
    canonical = url.toString();
  } catch {
    // Leave it as supplied; a URL we cannot parse simply hashes to itself and
    // will match nothing in the corpus, which is the right outcome.
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ── the handler ───────────────────────────────────────────────────────────

export interface VerifyOutcome {
  data: VerifyData;
  warnings: Warning[];
}

/**
 * Run both halves and merge them.
 *
 * The offline half always runs and always produces every check. The enriched
 * half only replaces the three corpus-dependent rows, and only when the caller
 * asked for it — so the merge can never let a hosted lookup weaken or override
 * a static finding.
 */
export async function runVerify(
  request: VerifyRequest,
  env: Pick<Env, "DB"> | null,
): Promise<VerifyOutcome> {
  const warnings: Warning[] = [];

  let facilitators = facilitatorOrigins();
  let listLabel = "the bundled list";
  if (env) {
    const loaded = await loadFacilitators(env);
    facilitators = facilitatorOrigins(loaded.rows);
    listLabel = loaded.source === "d1" ? "the published facilitator list" : "the bundled list";
    if (loaded.source === "bundled") {
      warnings.push({
        code: "BUNDLED_LIST",
        message: "The facilitator table was unavailable, so the bundled list was used.",
      });
    }
  }

  const offline = await verifyOffline(request.challenge, {
    context: request.context,
    knownFacilitators: facilitators,
    facilitatorListLabel: listLabel,
  });

  let checks = offline.checks;
  let enrichment: Enrichment | null = null;

  if (request.options.enrich && env) {
    const primary = offline.observed_terms[0] ?? null;
    const enriched = await enrich(
      env,
      request.context?.url ?? null,
      primary?.pay_to ?? null,
      primary?.amount_atomic ?? null,
    );
    const replacements = new Map(enriched.checks.map((c) => [c.id, c]));
    checks = checks.map((check) => replacements.get(check.id) ?? check);
    enrichment = enriched.enrichment;
    warnings.push(...enriched.warnings);
  } else if (request.options.enrich && !env) {
    warnings.push({
      code: "NO_DATA",
      message: "The corpus is not available in this environment, so enrichment was skipped.",
    });
  }

  if (!offline.challenge.valid && offline.challenge.wire_form !== "none") {
    warnings.push({
      code: "CHALLENGE_MALFORMED",
      message:
        offline.challenge.decode_error?.message ??
        "The challenge was refused by the strict x402 decoder.",
    });
  }

  return {
    data: {
      // Recomputed from the merged list rather than carried over, so the
      // frozen aggregation rule (SPEC §5.2) is applied to what we actually
      // report and cannot go stale behind an enrichment.
      verdict: aggregateVerdict(checks),
      challenge: offline.challenge,
      checks,
      signals: offline.signals,
      risk: offline.risk,
      enrichment,
    },
    warnings,
  };
}

export const verify: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const meta = ctx.route;
  const isApi = ctx.url.pathname.startsWith("/api/");

  // A submitted form becomes its own permalink: the result of verifying a
  // challenge is a function of the challenge, so the address bar is the share
  // link and nothing needs storing.
  if (ctx.request.method === "POST" && !isApi) {
    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (contentType.includes("form")) {
      const form = await ctx.request.formData();
      const params = new URLSearchParams();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string" && value.trim().length > 0) params.set(key, value);
      }
      return new Response(null, { status: 303, headers: { location: `/verify?${params.toString()}` } });
    }
  }

  let request: VerifyRequest | null;

  if (ctx.request.method === "POST") {
    const body = await readJsonBody(ctx.request);
    if ("error" in body) return body.error;
    const parsed = parseVerifyRequest(body.value);
    if (!parsed.ok) {
      return errorResponse("VALIDATION_FAILED", {
        message: parsed.message,
        detail: {
          fields: parsed.fields,
          schema: "https://tools.tx402.io/api/v1/schemas/verify-request",
        },
      });
    }
    request = parsed.value;
  } else {
    request = requestFromUrl(ctx.url);
  }

  // Nothing pasted yet. The page is the empty form; the JSON and markdown
  // mirrors describe what to send rather than pretending to a verdict.
  if (!request) {
    if (ctx.format === "html") {
      return html(verifyPage({ outcome: null, envelope: null, input: null, path: ctx.url.pathname }), {}, ctx);
    }
    const body = envelope(meta, emptyData(), {
      warnings: [
        {
          code: "NO_DATA",
          message: "Send a challenge to verify. POST /api/v1/verify with {\"challenge\":{\"header\":\"…\"}}.",
        },
      ],
      scoreVersion: CURRENT_SCORE_VERSION,
      tx402Version: TX402_VERSION,
    });
    return ctx.format === "markdown"
      ? markdown(verifyMarkdown({ outcome: null, envelope: body, input: null }), {}, ctx)
      : json(body, {}, ctx);
  }

  const outcome = await runVerify(request, ctx.env);

  const body = envelope(meta, outcome.data, {
    warnings: outcome.warnings,
    scoreVersion: outcome.data.risk?.score_version ?? CURRENT_SCORE_VERSION,
    tx402Version: TX402_VERSION,
  });

  if (ctx.format === "json") return json(body, {}, ctx);
  if (ctx.format === "markdown") {
    return markdown(verifyMarkdown({ outcome, envelope: body, input: request }), {}, ctx);
  }
  return html(
    verifyPage({ outcome, envelope: body, input: request, path: ctx.url.pathname }),
    {},
    ctx,
  );
};

function emptyData(): VerifyData {
  return {
    verdict: "pass",
    challenge: null,
    checks: [],
    signals: [],
    risk: null,
    enrichment: null,
  };
}

/** Re-exported so the page can label a pasted blob before it is verified. */
export { classifyRaw };
