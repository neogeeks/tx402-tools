/**
 * 402 Inspector.
 *
 * Contract: spec/SPEC.md §5.1 · Schema: spec/schemas/inspect.json
 * Golden responses: spec/fixtures/responses/inspect-empty.json, inspect-full.json
 *
 * ── One computation, three renderings ──────────────────────────────────────
 *
 * SPEC §1.2: "The markdown mirror is a rendering of the same JSON, never a
 * separate computation. If they can disagree, the design is wrong." So this
 * file computes exactly one `InspectData`, and `ui/pages/inspect/` renders it
 * as the report or the page. Neither renderer can reach a probe result, a
 * database row or a clock; they take the data and nothing else.
 *
 * ── Everything this route does not do ──────────────────────────────────────
 *
 * It does not decode a challenge — `decodePaymentRequired` from `tx402` does,
 * inside `worker/lib/probe.ts`, and there is no second decoder in this repo. It does not score —
 * `worker/lib/score.ts` does, and its band
 * and reasons are rendered VERBATIM. It does not fetch — `worker/lib/guard.ts`
 * does. And it cannot pay: no signer, no key, no payment-authorization header
 * anywhere on this path.
 *
 * ── The politeness cache is not optional ───────────────────────────────────
 *
 * Every probe goes through `withPoliteness`, never `probe` directly. That is
 * what stops a free "paste a URL and we fetch it" service being a DDoS cannon
 * aimed at other people's paid APIs: one live probe per endpoint
 * per window no matter how many people ask, everyone else served the cached
 * result with its age.
 *
 * ── The four result states, none of which is an HTTP error ─────────────────
 *
 *   a valid challenge → the full report
 *   a malformed challenge → a report with failing checks, HTTP 200
 *   not an x402 endpoint → said plainly; `score` returns null and the risk
 *                            section says "not an x402 endpoint" — not an error,
 *                            and emphatically not HIGH risk
 *   the guard refused → the error envelope, with the SAME generic message
 *                            for every blocked-URL code (`worker/http.ts`)
 */

import { PACKAGE_VERSION } from "tx402";

import { HOSTED_URL_POLICY, dohResolver, endpointId, validateUrl } from "../lib/guard.js";
import type { Connector, GuardFailure, Resolver } from "../lib/guard.js";
import { facilitatorOrigins, loadFacilitators } from "../lib/facilitators.js";
import { callerKey, withPoliteness } from "../lib/politeness.js";
import { MAX_AUTHORIZATION_SECONDS, probe } from "../lib/probe.js";
import type { ProbeResult, Requirement } from "../lib/probe.js";
import { extractSignals, primaryRequirement, signalMap } from "../lib/signals.js";
import type { Signal } from "../lib/signals.js";
import { CURRENT_SCORE_VERSION, score } from "../lib/score.js";

import { ERROR_STATUS, envelope, errorBody, errorResponse, html, json, markdown, nowIso } from "../http.js";
import type { ErrorCode, RouteContext, RouteHandler, Warning } from "../types.js";

import { inspectErrorPage, inspectPage } from "../../ui/pages/inspect/page.js";
import { inspectMarkdown } from "../../ui/pages/inspect/markdown.js";
import type { Check, InspectData, InspectView } from "../../ui/pages/inspect/types.js";

/** The `tx402` release whose decoder produced every verdict below. */
export const TX402_VERSION = PACKAGE_VERSION;

/**
 * Cap on the echoed `challenge.raw`. The decoder still sees the full bytes —
 * `probe` truncates only the stored copy — so this bounds the response size
 * without changing a single verdict.
 */
const RAW_CHALLENGE_CHARS = 8192;

const MAX_BODY_BYTES = 64 * 1024;

/** Payment schemes tx402 can actually route today. */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set(["exact"]);

// ── caller attribution, without ever holding an address ───────────────────

/**
 * Per-isolate salt for `callerKey`.
 *
 * `callerKey` needs a salt that is not public, or the digest could be reversed
 * by hashing the whole IPv4 space. There is no `CALLER_SALT` secret bound yet
 * (`wrangler.jsonc` is its file), so this generates one lazily and keeps it in
 * memory: never stored, never logged, never sent anywhere, and it dies with the
 * isolate. The cost is that the coarse per-caller budget is per-isolate rather
 * than global — acceptable, because the real protection against amplification
 * is the per-TARGET politeness window, which is global by construction (the
 * Durable Object is keyed by endpoint). for the one-line
 * upgrade when a secret exists.
 *
 * Generated lazily because Workers refuse randomness at module scope.
 */
let isolateSalt: string | null = null;
function salt(): string {
  isolateSalt ??= crypto.randomUUID();
  return isolateSalt;
}

// ── the network seam ──────────────────────────────────────────────────────

/**
 * The guard's `Resolver` and `Connector` ports, overridable for tests.
 *
 * We made both of them ports precisely so the decision logic can be driven
 * against fabricated DNS answers and fabricated hostile responses without
 * touching the network — `test/net-stubs.ts` is the reusable set ( decision
 * 10). Production never calls the setter, so the default path is the one that
 * ships: DNS-over-HTTPS plus the platform `fetch`.
 *
 * This is a module-level seam rather than an `Env` binding because
 * `worker/types.ts` is its file and a test double does not belong in the
 * production binding surface.
 */
export interface ProbeTransport {
  resolver: Resolver;
  connector?: Connector;
}

let transport: ProbeTransport | null = null;

/** Test-only. Pass `null` to restore the real DoH resolver and `fetch`. */
export function setProbeTransportForTests(next: ProbeTransport | null): void {
  transport = next;
}

// ── input ─────────────────────────────────────────────────────────────────

interface Input {
  url: string | null;
  turnstileToken: string | null;
  /** `scans.source` — a person at the paste box, or a program at the API. */
  source: "human" | "api";
  /** Set when the body could not be read at all. */
  error: Response | null;
}

async function readInput(ctx: RouteContext): Promise<Input> {
  const isApi = ctx.url.pathname.startsWith("/api/");
  const base: Input = { url: null, turnstileToken: null, source: isApi ? "api" : "human", error: null };

  if (ctx.request.method !== "POST") {
    return { ...base, url: ctx.url.searchParams.get("url") };
  }

  const contentType = ctx.request.headers.get("content-type") ?? "";

  if (contentType.includes("form")) {
    const form = await ctx.request.formData();
    const url = form.get("url");
    const token = form.get("cf-turnstile-response") ?? form.get("turnstile_token");
    return {
      ...base,
      source: "human",
      url: typeof url === "string" && url.trim().length > 0 ? url.trim() : null,
      turnstileToken: typeof token === "string" && token.length > 0 ? token : null,
    };
  }

  const length = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return { ...base, error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }) };
  }

  const text = await ctx.request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ...base, error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }) };
  }
  if (text.trim().length === 0) return base;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...base, error: errorResponse("BAD_REQUEST", { message: "The request body is not valid JSON." }) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...base, error: errorResponse("VALIDATION_FAILED", { message: "Send a body with a `url` string." }) };
  }

  const body = parsed as Record<string, unknown>;
  const url = typeof body.url === "string" && body.url.trim().length > 0 ? body.url.trim() : null;
  const token = typeof body.turnstile_token === "string" && body.turnstile_token.length > 0
    ? body.turnstile_token
    : null;
  return { ...base, url, turnstileToken: token };
}

// ── Turnstile ─────────────────────────────────────────────────────────────

/**
 * Verify a Turnstile token, or no-op.
 *
 * ⚠️ **Turnstile is not provisioned**: the OAuth token carries no
 * `turnstile` scope, so the widget has to be created in the dashboard. Until
 * then `TURNSTILE_SITE_KEY` is empty, `ui/components/paste-box.ts` omits the
 * widget, and this returns "ok" without checking anything — which is correct
 * for dev and NOT acceptable in production, because the public paste box is
 * exactly the surface wants protected. The code path is built and
 * tested so that closing O12 is a configuration change, not a code change.
 *
 * The per-target politeness window and the per-caller budget are in force
 * regardless, so an unprotected paste box is a cost and nuisance problem, not
 * an amplification one.
 */
async function checkTurnstile(
  ctx: RouteContext,
  token: string | null,
): Promise<Response | null> {
  const siteKey = ctx.env.TURNSTILE_SITE_KEY ?? "";
  const secret = ctx.env.TURNSTILE_SECRET_KEY ?? "";
  if (siteKey.length === 0 || secret.length === 0) return null;

  if (!token) return errorResponse("TURNSTILE_REQUIRED");

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
    });
    const outcome = await response.json<{ success?: boolean }>();
    return outcome.success === true ? null : errorResponse("TURNSTILE_FAILED");
  } catch {
    // A verification service we cannot reach must not become an open door.
    return errorResponse("TURNSTILE_FAILED");
  }
}

// ── checks (SPEC §4.3, ids frozen in SPEC §5.2.1) ─────────────────────────

/**
 * The checks a *probe* can determine, derived from the signals already
 * extracted.
 *
 * Two rules, both load-bearing:
 *
 *  1. **Every id comes from the frozen list in SPEC §5.2.1.** A check id
 *     invented here would be an id the CLI and the MCP server have never seen,
 *     and comparing the hosted verdict to the offline one is the whole point of
 *     freezing them.
 *  2. **The source of truth is `signals.ts`, not a second reading of the
 *     challenge.** This function maps observations onto check ids; it never
 *     re-examines the payload. That is what stops `/inspect` and `/verify`
 *     drifting into two different opinions about the same endpoint.
 *
 * `/verify` owns the full list, including the ones only the decoder can
 * see from the inside (`depth_within_limit`, `no_duplicate_keys`, …). Those are
 * not emitted here at all rather than emitted as hollow passes: SPEC §4.3 is
 * explicit that `skip` means "could not run", and a check we never attempted is
 * not a check we ran and skipped.
 */
export function deriveChecks(result: ProbeResult, signals: Signal[]): Check[] {
  const byId = signalMap(signals);
  const { challenge } = result;
  const terms = primaryRequirement(result);
  const checks: Check[] = [];

  const add = (
    id: string,
    status: Check["status"],
    opts: { offline?: boolean; reason?: string | null; detail?: string | null } = {},
  ): void => {
    checks.push({
      id,
      status,
      offline: opts.offline ?? true,
      reason: opts.reason ?? null,
      detail: opts.detail ?? null,
    });
  };

  /** A boolean signal → a check, with `skip` when it was not observed. */
  const fromSignal = (
    checkId: string,
    signalId: string,
    onFail: Check["status"],
    detailOnFail?: string,
  ): void => {
    const signal = byId.get(signalId);
    if (!signal || !signal.observed || typeof signal.value !== "boolean") {
      add(checkId, "skip", { reason: "not_observed", detail: signal?.detail ?? null });
      return;
    }
    if (signal.value) {
      add(checkId, "pass", { detail: signal.detail });
      return;
    }
    add(checkId, onFail, { reason: signalId, detail: signal.detail ?? detailOnFail ?? null });
  };

  // ── the challenge itself ──
  const served = challenge.wire_form !== "none";
  add(
    "wire_form_detected",
    served ? "pass" : "fail",
    {
      reason: served ? null : "no_challenge",
      detail: served
        ? `Served as ${challenge.wire_form}.`
        : "The endpoint answered without an x402 challenge in either wire form.",
    },
  );

  if (served) {
    // The strict decoder validates base64 framing, size, depth, duplicate keys
    // and the schema together and reports one verdict. We can honestly claim a
    // pass for the framing only when the whole decode passed; when it failed we
    // cannot attribute the failure to the framing, so this is `skip` and the
    // decode verdict itself is what the report shows.
    if (challenge.wire_form === "v1-body") {
      add("base64_strict", "skip", {
        reason: "not_applicable",
        detail: "The v1 body form carries no base64 framing.",
      });
    } else {
      add("base64_strict", challenge.valid ? "pass" : "skip", {
        reason: challenge.valid ? null : "decoder_refused_earlier",
        detail: challenge.valid
          ? "The strict decoder accepted the header's base64 framing."
          : "The decoder refused the challenge; the framing cannot be reported separately.",
      });
    }

    add(
      "json_wellformed",
      challenge.hash !== null ? "pass" : "fail",
      {
        reason: challenge.hash !== null ? null : "unparseable",
        detail: challenge.hash !== null ? null : "The challenge payload is not well-formed JSON.",
      },
    );

    const version = challenge.x402_version;
    add(
      "x402_version_known",
      version === 1 || version === 2 ? "pass" : "fail",
      {
        reason: version === null ? "absent" : version === 1 || version === 2 ? null : "unknown_version",
        detail:
          version === null
            ? "The challenge declared no x402Version."
            : `Declared x402Version ${version}.`,
      },
    );

    add(
      "accepts_present",
      challenge.requirement_count > 0 ? "pass" : "fail",
      {
        reason: challenge.requirement_count > 0 ? null : "empty",
        detail:
          challenge.requirement_count === 1
            ? "The challenge offers one way to pay."
            : `The challenge offers ${challenge.requirement_count} ways to pay.`,
      },
    );

    if (result.probe.bytes_read !== null) {
      add("size_within_limit", "pass", {
        detail: `Read ${result.probe.bytes_read} bytes, within the probe's cap.`,
      });
    }
  }

  // ── the terms ──
  if (terms) {
    const caip2 = terms.network === null ? null : /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u.test(terms.network);
    add(
      "network_caip2_wellformed",
      caip2 === null ? "skip" : caip2 ? "pass" : "fail",
      {
        reason: caip2 === null ? "not_observed" : caip2 ? null : "malformed",
        detail: terms.network === null ? "The challenge declared no network." : `network: ${terms.network}`,
      },
    );

    fromSignal("network_recognized", "network_recognized", "warn");
    fromSignal("asset_recognized", "asset_recognized", "warn");
    fromSignal("amount_atomic_canonical", "amount_canonical", "fail");

    if (terms.amount_atomic === null) {
      add("amount_positive", "skip", {
        reason: "not_observed",
        detail: "The amount is not a canonical atomic integer, so it cannot be compared to zero.",
      });
    } else {
      const positive = terms.amount_atomic !== "0";
      add("amount_positive", positive ? "pass" : "fail", {
        reason: positive ? null : "zero",
        detail: positive ? null : "The challenge asks for zero.",
      });
    }

    fromSignal("pay_to_wellformed", "pay_to_wellformed", "fail");
    fromSignal("max_timeout_sane", "timeout_sane", "warn");
    fromSignal("resource_origin_match", "resource_origin_match", "fail");
    fromSignal("scheme_known", "scheme_known", "warn");
    fromSignal("facilitator_known", "facilitator_known", "warn");

    if (terms.mime_type === null) {
      add("mime_type_wellformed", "skip", { reason: "not_observed", detail: "No mimeType was declared." });
    } else {
      const ok = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;.*)?$/iu.test(terms.mime_type);
      add("mime_type_wellformed", ok ? "pass" : "warn", {
        reason: ok ? null : "malformed",
        detail: `mimeType: ${terms.mime_type}`,
      });
    }

    add("extra_wellformed", "pass", {
      detail:
        Object.keys(terms.extra).length === 0
          ? "No unknown fields were carried in `extra`."
          : `\`extra\` carries ${Object.keys(terms.extra).length} field(s), preserved verbatim.`,
    });
  }

  // ── the corpus-dependent checks (SPEC §5.2.1, `offline: false`) ──
  // They report `skip` rather than `pass` until the corpus lands. "We have no data" is
  // never a pass; that is the difference between a trust tool and a rubber
  // stamp (SPEC §4.3).
  add("amount_within_observed_range", "skip", {
    offline: false,
    reason: "no_history",
    detail: "No prior observations of this endpoint.",
  });
  add("recipient_matches_observed", "skip", {
    offline: false,
    reason: "no_history",
    detail: "No prior observations of this endpoint.",
  });

  return checks;
}

// ── the corpus ──────────────────────────────

interface CorpusHistory {
  first_seen: string | null;
  last_seen: string | null;
  scan_count: number;
  challenge_hash: string | null;
  recent_changes: InspectData["observed"]["recent_changes"];
}

const EMPTY_HISTORY: CorpusHistory = {
  first_seen: null,
  last_seen: null,
  scan_count: 0,
  challenge_hash: null,
  recent_changes: [],
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * What the corpus knew BEFORE this scan.
 *
 * Read first, written afterwards, so "first seen: just now" is a fact rather
 * than a rounding of one.
 */
async function readHistory(ctx: RouteContext, id: string): Promise<CorpusHistory> {
  try {
    const row = await ctx.env.DB.prepare(
      `SELECT e.first_seen AS first_seen, e.last_seen AS last_seen, e.scan_count AS scan_count,
              t.challenge_hash AS challenge_hash
         FROM endpoints e
         LEFT JOIN terms_current t ON t.endpoint_id = e.id
        WHERE e.id = ?`,
    )
      .bind(id)
      .first<Record<string, unknown>>();

    const firstSeen = str(row?.first_seen);
    if (!firstSeen) return EMPTY_HISTORY;

    const changes = await ctx.env.DB.prepare(
      `SELECT id, changed_at, change_kind, field, old_value, new_value, detected_by, score_version
         FROM term_changes
        WHERE endpoint_id = ?
        ORDER BY changed_at DESC
        LIMIT 5`,
    )
      .bind(id)
      .all<Record<string, unknown>>();

    return {
      first_seen: firstSeen,
      last_seen: str(row?.last_seen),
      scan_count: typeof row?.scan_count === "number" ? row.scan_count : 0,
      challenge_hash: str(row?.challenge_hash),
      recent_changes: (changes.results ?? [])
        .filter((r) => str(r.id) !== null && str(r.changed_at) !== null)
        .map((r) => ({
          id: String(r.id),
          changed_at: String(r.changed_at),
          change_kind: String(r.change_kind),
          field: String(r.field),
          old_value: str(r.old_value),
          new_value: str(r.new_value),
          ...(str(r.detected_by) === null ? {} : { detected_by: String(r.detected_by) }),
          ...(str(r.score_version) === null ? {} : { score_version: String(r.score_version) }),
        })),
    };
  } catch {
    // A corpus we cannot read is an empty corpus, which is a state this tool
    // renders correctly anyway. It is never a reason to fail a scan.
    return EMPTY_HISTORY;
  }
}

function randomId(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write the scan into the corpus.
 *
 * **This is the flywheel**: the Inspector ships before the
 * crawler precisely so that every URL a human pastes seeds the graph that
 * History, Compare and Watch will read.
 *
 * Three deliberate limits:
 *
 *  - **Only a successful probe is written.** A URL that never resolved is
 *    indistinguishable from a typo, and seeding the corpus with typos gives the
 *    crawler a list of things to fail at forever.
 *  - **Nothing is written on a cache hit**, because nothing was observed.
 *    `last_seen` means "last observed", not "last asked about".
 *  - **`term_changes` is not written here.**  owns change detection, and its
 *    single most important test is that a change produces exactly ONE row. Two
 *    independent diff implementations racing on an append-only table is how
 *    that stops being true. `retained_reason` still records that this scan saw
 *    a different challenge, so loses nothing.
 *
 * A failure here is a warning on the response, never an error: the report is
 * about the endpoint, and our bookkeeping is not the user's problem.
 */
async function writeCorpus(
  ctx: RouteContext,
  result: ProbeResult,
  signals: Signal[],
  risk: InspectData["risk"],
  history: CorpusHistory,
  source: "human" | "api",
): Promise<Warning | null> {
  const now = nowIso();
  const scanId = randomId();
  const { target, challenge, probe: meta } = result;
  const terms = primaryRequirement(result);

  const retained: string =
    history.first_seen === null
      ? "first_seen"
      : history.challenge_hash !== null && challenge.hash !== null && history.challenge_hash !== challenge.hash
        ? "changed"
        : "human";

  const status =
    challenge.wire_form === "none" ? "not_x402" : "active";

  let path = "/";
  try {
    path = new URL(target.canonical_url).pathname;
  } catch {
    path = "/";
  }

  const signalsJson = JSON.stringify(signals);
  const challengeJson = JSON.stringify(challenge);

  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO endpoints (
           id, canonical_url, url, origin, host, path, resource_type, discovery_source,
           status, robots_allowed, first_seen, last_seen, last_scan_id, scan_count,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'http', 'human', ?, 1, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen = excluded.last_seen,
           last_scan_id = excluded.last_scan_id,
           scan_count = endpoints.scan_count + 1,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      ).bind(
        target.endpoint_id,
        target.canonical_url,
        target.url,
        target.origin,
        target.host,
        path,
        status,
        meta.observed_at,
        meta.observed_at,
        scanId,
        now,
        now,
      ),

      ctx.env.DB.prepare(
        `INSERT INTO terms_current (
           endpoint_id, x402_version, wire_form, scheme, network, asset_address, asset_symbol,
           asset_decimals, amount_atomic, amount_decimal, pay_to, pay_to_dynamic,
           max_timeout_seconds, facilitator, resource, mime_type, description,
           requirement_count, extra_json, challenge_hash, challenge_json,
           score, band, score_version, signals_json, observed_at, scan_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_id) DO UPDATE SET
           x402_version = excluded.x402_version,
           wire_form = excluded.wire_form,
           scheme = excluded.scheme,
           network = excluded.network,
           asset_address = excluded.asset_address,
           asset_symbol = excluded.asset_symbol,
           asset_decimals = excluded.asset_decimals,
           amount_atomic = excluded.amount_atomic,
           amount_decimal = excluded.amount_decimal,
           pay_to = excluded.pay_to,
           pay_to_dynamic = excluded.pay_to_dynamic,
           max_timeout_seconds = excluded.max_timeout_seconds,
           facilitator = excluded.facilitator,
           resource = excluded.resource,
           mime_type = excluded.mime_type,
           description = excluded.description,
           requirement_count = excluded.requirement_count,
           extra_json = excluded.extra_json,
           challenge_hash = excluded.challenge_hash,
           challenge_json = excluded.challenge_json,
           score = excluded.score,
           band = excluded.band,
           score_version = excluded.score_version,
           signals_json = excluded.signals_json,
           observed_at = excluded.observed_at,
           scan_id = excluded.scan_id,
           updated_at = excluded.updated_at`,
      ).bind(
        target.endpoint_id,
        challenge.x402_version,
        challenge.wire_form,
        terms?.scheme ?? null,
        terms?.network ?? null,
        terms?.asset?.address ?? null,
        terms?.asset?.symbol ?? null,
        terms?.asset?.decimals ?? null,
        terms?.amount_atomic ?? null,
        terms?.amount_decimal ?? null,
        terms?.pay_to ?? null,
        terms?.pay_to_dynamic === true ? 1 : 0,
        terms?.max_timeout_seconds ?? null,
        terms?.facilitator ?? null,
        terms?.resource ?? null,
        terms?.mime_type ?? null,
        terms?.description ?? null,
        challenge.requirement_count,
        terms ? JSON.stringify(terms.extra) : null,
        challenge.hash,
        challengeJson,
        risk?.score ?? null,
        risk?.band ?? null,
        risk?.score_version ?? null,
        signalsJson,
        meta.observed_at,
        scanId,
        now,
      ),

      ctx.env.DB.prepare(
        `INSERT INTO scans (
           id, endpoint_id, requested_at, completed_at, source, retained_reason, ok,
           http_status, error_code, error_detail, wire_form, x402_version, challenge_valid,
           challenge_hash, challenge_json, signals_json, score, band, score_version,
           latency_ms, redirect_count, tls_protocol, bytes_read, served_from_cache, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).bind(
        scanId,
        target.endpoint_id,
        meta.observed_at,
        now,
        source,
        retained,
        meta.http_status,
        challenge.wire_form,
        challenge.x402_version,
        challenge.valid ? 1 : 0,
        challenge.hash,
        challengeJson,
        signalsJson,
        risk?.score ?? null,
        risk?.band ?? null,
        risk?.score_version ?? null,
        meta.latency_ms,
        meta.redirect_count,
        meta.tls?.protocol ?? null,
        meta.bytes_read,
        now,
      ),
    ]);
    return null;
  } catch {
    return {
      code: "CORPUS_WRITE_FAILED",
      message: "This scan could not be recorded in the corpus. The report itself is unaffected.",
    };
  }
}

// ── assembling the answer ─────────────────────────────────────────────────

function linksFor(origin: string, url: string | null): InspectData["links"] {
  const query = url === null ? "" : `?url=${encodeURIComponent(url)}`;
  return {
    html: `${origin}/inspect${query}`,
    markdown: `${origin}/inspect.md${query}`,
    json: `${origin}/api/v1/inspect${query}`,
    history: url === null ? null : `${origin}/history${query}`,
    methodology: `${origin}/methodology?v=${CURRENT_SCORE_VERSION}`,
    share: null,
  };
}

/** The schema-valid answer for "no URL was supplied" (SPEC §5.1). */
export function emptyInspectData(origin: string): InspectData {
  return {
    target: { url: null, canonical_url: null, endpoint_id: null, origin: null, host: null },
    probe: null,
    challenge: null,
    terms: null,
    checks: [],
    signals: [],
    risk: null,
    observed: {
      has_history: false,
      first_seen: null,
      last_seen: null,
      scan_count: 0,
      availability_30d: null,
      latency_p50_ms: null,
      recent_changes: [],
    },
    links: linksFor(origin, null),
  };
}

export interface InspectOutcome {
  data: InspectData;
  warnings: Warning[];
  cached: boolean;
  cacheAgeSeconds: number | null;
}

/**
 * Turn a probe result into the frozen `data` shape.
 *
 * Deterministic and I/O-free apart from the corpus read it is handed, so the
 * same probe result always produces the same report — which is what makes a
 * score reproducible and therefore appealable.
 */
export function buildData(
  result: ProbeResult,
  signals: Signal[],
  history: CorpusHistory,
  origin: string,
  /**
   * Whether this request produced an observation that will be recorded.
   * False on a cache hit, where nothing was probed and nothing is written —
   * counting it would inflate `scan_count` by the number of people who looked.
   */
  recorded: boolean,
): { data: InspectData; warnings: Warning[] } {
  const risk = score(signals, CURRENT_SCORE_VERSION, {
    confidence: "static_only",
    methodologyBaseUrl: `${origin}/methodology`,
  });

  const terms: Requirement | null = primaryRequirement(result);
  const warnings: Warning[] = [];

  const hasHistory = history.first_seen !== null && history.scan_count > 0;
  if (!hasHistory) {
    warnings.push({
      code: "NO_HISTORY",
      message: "First time we have seen this endpoint.",
    });
  }

  if (result.challenge.wire_form === "none") {
    warnings.push({
      code: "NOT_X402",
      message: "The endpoint answered, but not with an x402 payment challenge.",
    });
  } else if (!result.challenge.valid) {
    warnings.push({
      code: "CHALLENGE_MALFORMED",
      message: "An x402 challenge was served, but the strict decoder refused it.",
    });
  }

  if (result.wire_forms_agree === false) {
    warnings.push({
      code: "WIRE_FORMS_DISAGREE",
      message: "Both wire forms were served and they describe different terms.",
    });
  }

  // There is deliberately no "response truncated" warning: the guard treats a
  // body that hits the cap as `RESPONSE_TOO_LARGE` and never returns a partial
  // read, so a truncated response is a refusal rather than a report.

  return {
    data: {
      target: result.target,
      probe: result.probe,
      challenge: {
        ...result.challenge,
        raw: result.challenge.raw === null ? null : result.challenge.raw.slice(0, RAW_CHALLENGE_CHARS),
      },
      terms,
      checks: deriveChecks(result, signals),
      signals,
      risk,
      observed: {
        has_history: hasHistory,
        first_seen: history.first_seen ?? result.probe.observed_at,
        last_seen: result.probe.observed_at,
        scan_count: history.scan_count + (recorded ? 1 : 0),
        // Never fabricated from one probe.  builds these from Analytics
        // Engine aggregates, whose read path is still unproven.
        availability_30d: null,
        latency_p50_ms: null,
        recent_changes: history.recent_changes,
      },
      links: linksFor(origin, result.target.url),
    },
    warnings,
  };
}

// ── the scan ──────────────────────────────────────────────────────────────

export interface ScanFailure {
  code: ErrorCode;
  detail: Record<string, unknown> | null;
  retryAfterSeconds: number | null;
}

/**
 * Probe one URL, through the politeness cache, and assemble the report.
 *
 * Exported because `worker/routes/share.ts` produces a snapshot the same way:
 * a share link must never be able to say something we did not observe, so the
 * payload it stores is produced by this function rather than accepted from a
 * caller.
 */
export async function scan(
  ctx: RouteContext,
  rawUrl: string,
  source: "human" | "api",
): Promise<{ ok: true; outcome: InspectOutcome } | { ok: false; failure: ScanFailure }> {
  const origin = ctx.env.PUBLIC_ORIGIN || "https://tools.tx402.io";

  // Validate before touching the network or the Durable Object: the canonical
  // URL is also the endpoint id, which is the politeness key.
  const validated = validateUrl(rawUrl, HOSTED_URL_POLICY);
  if (!validated.ok) return { ok: false, failure: fromGuard(validated.failure) };

  const id = await endpointId(validated.value.canonical);
  const caller = await callerKey(
    ctx.request.headers.get("cf-connecting-ip"),
    salt(),
  );

  const polite = await withPoliteness(
    ctx.env,
    {
      endpointId: id,
      ...(caller === undefined ? {} : { callerKey: caller }),
      // Every probe on this path was caused by somebody outside the service, so
      // it draws on the whole-service daily ceiling. The per-endpoint window
      // above bounds volume per TARGET; this is the only thing that bounds the
      // total, and without it "a thousand different URLs" was unpriced.
      onDemand: true,
    },
    () =>
      probe(rawUrl, {
        policy: HOSTED_URL_POLICY,
        resolver: transport?.resolver ?? dohResolver(),
        ...(transport?.connector === undefined ? {} : { connector: transport.connector }),
        maxRawChars: RAW_CHALLENGE_CHARS,
      }),
  );

  if (polite.result === null) {
    const refusal = polite.refusal;
    // `daily_budget` is the service's own ceiling rather than anything about
    // this endpoint, so it reports as RATE_LIMITED alongside the per-caller
    // budget. Saying TARGET_RATE_LIMITED would tell the caller something untrue
    // about the endpoint they asked about.
    const serviceLimited =
      refusal?.reason === "caller_limit" || refusal?.reason === "daily_budget";
    return {
      ok: false,
      failure: {
        code: serviceLimited ? "RATE_LIMITED" : "TARGET_RATE_LIMITED",
        detail: null,
        retryAfterSeconds: refusal?.retryAfterSeconds ?? null,
      },
    };
  }

  const probed = polite.result;
  if (!probed.ok) return { ok: false, failure: fromGuard(probed.failure) };

  const result: ProbeResult = {
    ...probed.value,
    probe: {
      ...probed.value.probe,
      served_from_cache: polite.cached,
      cache_age_seconds: polite.cacheAgeSeconds,
    },
  };

  const facilitators = await loadFacilitators(ctx.env);
  const signals = extractSignals(result, {
    knownFacilitators: facilitatorOrigins(facilitators.rows),
    knownSchemes: KNOWN_SCHEMES,
  });

  const history = await readHistory(ctx, result.target.endpoint_id);
  const built = buildData(result, signals, history, origin, !polite.cached);
  const warnings = [...built.warnings];

  if (facilitators.source === "bundled") {
    warnings.push({
      code: "BUNDLED_LIST",
      message: "The facilitator list came from the bundled copy, not the live table.",
    });
  }

  // Nothing new was observed on a cache hit, so nothing is recorded.
  if (!polite.cached) {
    const failure = await writeCorpus(ctx, result, signals, built.data.risk, history, source);
    if (failure) warnings.push(failure);
  }

  return {
    ok: true,
    outcome: {
      data: built.data,
      warnings,
      cached: polite.cached,
      cacheAgeSeconds: polite.cacheAgeSeconds,
    },
  };
}

/**
 * Map a guard failure onto an error code.
 *
 * The `stage` is carried through because `worker/http.ts` already collapses
 * every blocked-URL code to one generic sentence — the differentiation is
 * internal on purpose, so that a refusal cannot double as a network scan. Nothing here undoes that.
 */
function fromGuard(failure: GuardFailure): ScanFailure {
  return { code: failure.code, detail: { stage: failure.stage }, retryAfterSeconds: null };
}

// ── the route ─────────────────────────────────────────────────────────────

function view(
  data: InspectData,
  origin: string,
  meta: { cached: boolean; cacheAgeSeconds: number | null },
  warnings: Warning[],
): InspectView {
  return {
    data,
    envelope: {
      meta: {
        cached: meta.cached,
        cache_age_seconds: meta.cacheAgeSeconds,
        tx402_version: TX402_VERSION,
      },
      warnings,
    },
    origin,
    snapshot: null,
  };
}

/**
 * Render a refusal.
 *
 * JSON and Markdown callers get the error envelope from `worker/http.ts`
 * unchanged. A browser gets the same code and the same generic sentence
 * rendered as a page, because handing a person raw JSON on the suite's front
 * door is a bad answer to "I pasted a URL you will not fetch" — and because
 * reading `error.message` from `errorBody` rather than writing a second
 * sentence here is what keeps every blocked-URL code indistinguishable.
 */
function refusal(ctx: RouteContext, failure: ScanFailure, siteKey: string): Response {
  const headers: Record<string, string> = {};
  if (failure.retryAfterSeconds !== null) {
    headers["retry-after"] = String(Math.max(1, failure.retryAfterSeconds));
  }

  if (ctx.format !== "html") {
    return errorResponse(failure.code, { detail: failure.detail, headers });
  }

  const body = errorBody(failure.code, { detail: failure.detail });
  return html(
    inspectErrorPage({
      code: body.error.code,
      message: body.error.message,
      docs: body.error.docs ?? null,
      url: ctx.url.searchParams.get("url"),
      path: ctx.url.pathname,
      turnstileSiteKey: siteKey,
    }),
    { status: ERROR_STATUS[failure.code], headers },
    ctx,
  );
}

export const inspect: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const meta = ctx.route;
  const origin = ctx.env.PUBLIC_ORIGIN || "https://tools.tx402.io";
  const siteKey = ctx.env.TURNSTILE_SITE_KEY ?? "";

  const input = await readInput(ctx);
  if (input.error) return input.error;

  // ── no URL: the paste box, the usage note, or the empty envelope ────────
  if (input.url === null) {
    const data = emptyInspectData(origin);
    const warnings: Warning[] = [
      { code: "NO_URL", message: "Pass ?url= the https URL of the endpoint you want inspected." },
    ];
    const body = envelope(meta, data, { warnings, tx402Version: TX402_VERSION });

    if (ctx.format === "json") return json(body, {}, ctx);
    if (ctx.format === "markdown") {
      return markdown(inspectMarkdown(view(data, origin, { cached: false, cacheAgeSeconds: null }, warnings)), {}, ctx);
    }
    return html(
      inspectPage({
        view: view(data, origin, { cached: false, cacheAgeSeconds: null }, warnings),
        path: ctx.url.pathname,
        turnstileSiteKey: siteKey,
      }),
      {},
      ctx,
    );
  }

  // ── Turnstile, when it is configured ──────────────────────
  if (ctx.request.method === "POST") {
    const blocked = await checkTurnstile(ctx, input.turnstileToken);
    if (blocked) return blocked;
  }

  const scanned = await scan(ctx, input.url, input.source);
  if (!scanned.ok) return refusal(ctx, scanned.failure, siteKey);

  const { data, warnings, cached, cacheAgeSeconds } = scanned.outcome;
  const body = envelope(meta, data, {
    warnings,
    cached,
    cacheAgeSeconds,
    scoreVersion: data.risk?.score_version ?? CURRENT_SCORE_VERSION,
    tx402Version: TX402_VERSION,
  });

  if (ctx.format === "json") return json(body, {}, ctx);

  const rendered = view(data, origin, { cached, cacheAgeSeconds }, warnings);
  if (ctx.format === "markdown") return markdown(inspectMarkdown(rendered), {}, ctx);

  return html(
    inspectPage({ view: rendered, path: ctx.url.pathname, turnstileSiteKey: siteKey }),
    {},
    ctx,
  );
};

/** Re-exported so a renderer needs one import for the SDK bound it cites. */
export { MAX_AUTHORIZATION_SECONDS };
