/**
 * 402 Replay.
 *
 * Contract: spec/SPEC.md §5.7 · Schema: spec/schemas/replay.json
 *
 * Analysis is LOCAL: the trace is already on the developer's machine, and
 * making them upload it is friction plus a privacy problem. The
 * reconstruction lives in `packages/tools-cli/src/replay/`. These routes are
 * ONLY the opt-in share permalink:
 *
 *   POST /api/v1/replay/share store a redacted analysis, return a link
 *   GET /api/v1/replay/:id read one back
 *   GET /replay the tool page
 *
 * Two properties this file preserves:
 *
 *  - **Redaction happened client-side, before upload**. The
 *    server cannot verify that, and pretending otherwise would be the worst
 *    kind of security theatre — so it does two honest things instead: it
 *    stores the client's redaction summary verbatim, and it refuses a payload
 *    in which it can *see* an unredacted secret. A backstop, explicitly not a
 *    guarantee. `share_links` has no column for an unredacted trace.
 *  - **`do_not_retry: true` on an ambiguous payment is a correctness
 *    requirement.** A permalink is what somebody pastes into an issue for
 *    other people to act on, so an analysis that reports an unknown outcome
 *    after transmission and then says retrying is fine is refused rather than
 *    hosted. The merchant may hold a valid authorization; a retry can pay
 *    twice.
 *
 * Links expire, and the expiry is enforced **lazily on read** plus a delete of the row it just
 * found stale. It is not a cron trigger: the account is on the Workers free plan and cron triggers
 * are capped at five per ACCOUNT, so a new one here would be taken from another product.
 */

import { envelope, errorResponse, html, json, markdown, nowIso } from "../http.js";
import { page, pageHead } from "../../ui/components/page.js";
import { emptyState } from "../../ui/components/empty-state.js";
import { TOOLS } from "../../ui/tool-meta.js";
import type { Env, RouteContext, RouteHandler } from "../types.js";

/** Thirty days, matching `spec/fixtures/responses/replay-ambiguous.json`. */
const TTL_DAYS = 30;

/** Body ceiling. A replay analysis is small; anything larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

// ── the stored shape ─────────────────────────────────────────────────────

interface StoredAnalysis {
  lifecycle: { phase: string; status: string; at?: string | null; detail?: string | null }[];
  diagnosis: {
    code: string;
    title: string;
    explanation: string;
    guidance: string;
    do_not_retry: boolean;
  };
  redaction: { applied: boolean; fields_redacted: number };
}

interface ShareRow {
  id: string;
  payload_json: string;
  expires_at: string;
  revoked_at: string | null;
}

// ── id generation ────────────────────────────────────────────────────────

/**
 * 128 bits from the CSPRNG, base64url, unpadded — 22 characters.
 *
 * "Unguessable" is the whole access-control model for a share link: there is no
 * account, so the id IS the capability (migrations/0001_init.sql).
 */
function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `r_${b64}`;
}

function expiryFrom(nowMs: number): string {
  return `${new Date(nowMs + TTL_DAYS * 86_400_000).toISOString().slice(0, 19)}Z`;
}

// ── validation ───────────────────────────────────────────────────────────

const PHASE_PATTERN = /^[a-z][a-z0-9_]*$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const STATUSES = new Set(["ok", "fail", "skip", "unknown"]);

/** Phases at or after which an unknown status means money may have moved. */
const POST_TRANSMISSION_PHASES = new Set(["submit", "settle", "deliver"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Invalid {
  fields: string[];
  message: string;
}

function validateAnalysis(value: unknown): Invalid | null {
  const fields: string[] = [];
  if (!isRecord(value)) return { fields: ["analysis"], message: "analysis must be an object." };

  const lifecycle = value["lifecycle"];
  if (!Array.isArray(lifecycle)) fields.push("analysis.lifecycle");
  else {
    for (const [index, raw] of lifecycle.entries()) {
      if (!isRecord(raw)) {
        fields.push(`analysis.lifecycle[${String(index)}]`);
        continue;
      }
      const phase = raw["phase"];
      const status = raw["status"];
      if (typeof phase !== "string" || !PHASE_PATTERN.test(phase) || phase.length > 32) {
        fields.push(`analysis.lifecycle[${String(index)}].phase`);
      }
      if (typeof status !== "string" || !STATUSES.has(status)) {
        fields.push(`analysis.lifecycle[${String(index)}].status`);
      }
    }
  }

  const diagnosis = value["diagnosis"];
  if (!isRecord(diagnosis)) fields.push("analysis.diagnosis");
  else {
    if (typeof diagnosis["code"] !== "string" || !CODE_PATTERN.test(diagnosis["code"])) {
      fields.push("analysis.diagnosis.code");
    }
    for (const key of ["title", "explanation", "guidance"]) {
      if (typeof diagnosis[key] !== "string") fields.push(`analysis.diagnosis.${key}`);
    }
    if (typeof diagnosis["do_not_retry"] !== "boolean") {
      fields.push("analysis.diagnosis.do_not_retry");
    }
  }

  const redaction = value["redaction"];
  if (!isRecord(redaction)) fields.push("analysis.redaction");
  else {
    if (typeof redaction["applied"] !== "boolean") fields.push("analysis.redaction.applied");
    const count = redaction["fields_redacted"];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      fields.push("analysis.redaction.fields_redacted");
    }
  }

  if (fields.length > 0) {
    return { fields, message: "The analysis does not match the replay contract." };
  }

  // ── the one semantic rule, and the reason this route exists at all ──────
  // An unknown status at or after `submit` means the authorization may have
  // been transmitted and its outcome is unconfirmed. Publishing that alongside
  // "retrying is fine" would hand a reader the exact instruction that causes a
  // double payment. SPEC §5.7 calls `do_not_retry` a correctness requirement;
  // this is the line that enforces it.
  const steps = value["lifecycle"] as { phase: string; status: string }[];
  const ambiguous = steps.some(
    (step) => step.status === "unknown" && POST_TRANSMISSION_PHASES.has(step.phase),
  );
  const diagnosisObject = value["diagnosis"] as { do_not_retry: boolean };
  if (ambiguous && !diagnosisObject.do_not_retry) {
    return {
      fields: ["analysis.diagnosis.do_not_retry"],
      message:
        "This analysis reports an unknown outcome after transmission but says retrying is safe. It is refused rather than published: the merchant may hold a valid authorization, and a retry can pay twice.",
    };
  }

  return null;
}

/**
 * Refuse a payload with an obvious secret still in it.
 *
 * This cannot prove the client redacted anything — redaction is client-side by
 * design and the server has no way to check what it never saw. What it can do
 * is catch the case where somebody POSTs straight at the API with a raw trace,
 * so the three shapes with no benign reading are refused on sight. A 40-byte
 * hex threshold keeps settlement hashes and addresses, which are public and are
 * exactly what a reader needs in order to reconcile.
 */
const OBVIOUS_SECRET: { re: RegExp; what: string }[] = [
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, what: "a token" },
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i, what: "an authorization credential" },
  { re: /\b(?:0x)?[0-9a-fA-F]{80,}\b/, what: "a signature or key material" },
  { re: /-----BEGIN [A-Z0-9 ]+-----/, what: "key material" },
];

function findObviousSecret(body: string): string | null {
  for (const { re, what } of OBVIOUS_SECRET) {
    if (re.test(body)) return what;
  }
  return null;
}

// ── Turnstile ────────────────────────────────────────────────────────────

/**
 * Verify a Turnstile token when — and only when — Turnstile is configured.
 *
 * It is not provisioned yet: there is no `turnstile` scope on the
 * account's token, so the widget has to be made in the dashboard. The token
 * path is built anyway and no-ops on an empty site key, which is the same shape
 * `ui/components/paste-box.ts` already uses, so switching it on is
 * configuration rather than a code change.
 */
async function turnstileFails(env: Env, request: Request): Promise<"missing" | "invalid" | null> {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return null;

  const token = request.headers.get("cf-turnstile-response");
  if (!token) return "missing";

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const outcome = await verify.json<{ success?: boolean }>();
  return outcome.success === true ? null : "invalid";
}

// ── handlers ─────────────────────────────────────────────────────────────

export const replay: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const { pathname } = ctx.url;

  if (ctx.request.method === "POST" && pathname === "/api/v1/replay/share") {
    return createShare(ctx);
  }
  if (ctx.request.method === "GET" && pathname.startsWith("/api/v1/replay/")) {
    return readShare(ctx);
  }
  return toolPage(ctx);
};

async function createShare(ctx: RouteContext): Promise<Response> {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return errorResponse("UNSUPPORTED_MEDIA_TYPE");
  }

  const gate = await turnstileFails(ctx.env, ctx.request);
  if (gate === "missing") return errorResponse("TURNSTILE_REQUIRED");
  if (gate === "invalid") return errorResponse("TURNSTILE_FAILED");

  const raw = await ctx.request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse("VALIDATION_FAILED", {
      message: "That payload is larger than a replay analysis has any reason to be.",
      detail: { fields: ["body"], max_bytes: MAX_BODY_BYTES },
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse("BAD_REQUEST", { message: "The body is not valid JSON." });
  }
  if (!isRecord(body)) return errorResponse("BAD_REQUEST");

  const invalid = validateAnalysis(body["analysis"]);
  if (invalid) {
    return errorResponse("VALIDATION_FAILED", {
      message: invalid.message,
      detail: { fields: invalid.fields },
    });
  }

  const leaked = findObviousSecret(raw);
  if (leaked) {
    return errorResponse("VALIDATION_FAILED", {
      message: `This payload still contains what looks like ${leaked}. Redaction runs on your machine before upload; nothing was stored.`,
      detail: { fields: ["trace"] },
    });
  }

  const analysis = body["analysis"] as StoredAnalysis;
  const id = newId();
  const now = Date.now();
  const createdAt = nowIso();
  const expiresAt = expiryFrom(now);
  const stored = { trace: body["trace"] ?? null, analysis };

  await ctx.env.DB.prepare(
    `INSERT INTO share_links (id, kind, endpoint_id, payload_json, redaction_summary, created_at, expires_at)
     VALUES (?, 'replay', NULL, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      JSON.stringify(stored),
      JSON.stringify(analysis.redaction),
      createdAt,
      expiresAt,
    )
    .run();

  return json(
    envelope(ctx.route, {
      id,
      url: shareUrl(ctx, id),
      expires_at: expiresAt,
      analysis,
    }),
    { status: 201 },
    ctx,
  );
}

async function readShare(ctx: RouteContext): Promise<Response> {
  const id = ctx.params["id"] ?? ctx.url.pathname.split("/").pop() ?? "";
  if (!id) return errorResponse("NOT_FOUND");

  const row = await ctx.env.DB.prepare(
    `SELECT id, payload_json, expires_at, revoked_at FROM share_links
     WHERE id = ? AND kind = 'replay'`,
  )
    .bind(id)
    .first<ShareRow>();

  if (!row) return errorResponse("NOT_FOUND");

  // Lazy expiry (O15 — no new cron trigger). A link past its date is gone as
  // far as a reader is concerned, and the row goes with it on the way out.
  if (row.revoked_at !== null || Date.parse(row.expires_at) <= Date.now()) {
    ctx.ctx.waitUntil(
      ctx.env.DB.prepare("DELETE FROM share_links WHERE id = ?").bind(id).run(),
    );
    return errorResponse("NOT_FOUND", { message: "That link has expired." });
  }

  let stored: { analysis?: StoredAnalysis } = {};
  try {
    stored = JSON.parse(row.payload_json) as { analysis?: StoredAnalysis };
  } catch {
    return errorResponse("INTERNAL");
  }

  ctx.ctx.waitUntil(
    ctx.env.DB.prepare("UPDATE share_links SET view_count = view_count + 1 WHERE id = ?")
      .bind(id)
      .run(),
  );

  return json(
    envelope(ctx.route, {
      id: row.id,
      url: shareUrl(ctx, row.id),
      expires_at: row.expires_at,
      analysis: stored.analysis ?? null,
    }),
    {},
    ctx,
  );
}

/**
 * The human-facing permalink, matching the frozen fixture's `/replay/{id}`.
 *
 * `worker/router.ts` declares `/replay` but no `/replay/:id`, and router.ts is
 * -owned, so the page route is noted for the integrator rather than added
 * here. The API pair works today.
 */
function shareUrl(ctx: RouteContext, id: string): string {
  const origin = ctx.env.PUBLIC_ORIGIN || "https://tools.tx402.io";
  return `${origin}/replay/${id}`;
}

function toolPage(ctx: RouteContext): Response {
  const meta = ctx.route;
  const data = {
    id: ctx.params["id"] ?? null,
    url: null,
    expires_at: null,
    analysis: null,
  };
  const body = envelope(meta, data, {
    warnings: [
      {
        code: "LOCAL_ONLY",
        message:
          "Replay analysis runs locally in tx402-tools. This route serves only the opt-in share permalink.",
      },
    ],
  });

  if (ctx.format === "json") return json(body, {}, ctx);

  const lede = TOOLS.replay.description;

  if (ctx.format === "markdown") {
    return markdown(
      [
        `# ${TOOLS.replay.h1}`,
        "",
        lede,
        "",
        "## Why this one is a CLI",
        "",
        "Your trace is already on your machine. Uploading it to find out what went wrong is friction, and it is a privacy problem: a replay trace is the one artifact in this suite that is *expected* to contain secrets.",
        "",
        "So the analysis is local:",
        "",
        "```bash",
        "npx tx402-tools replay ./failed-call.json",
        "```",
        "",
        // / O14: `tx402-tools` holds a reserved 0.0.0 placeholder on
        // npm and a real release is a human decision. The command above is what
        // works at release; today it fetches the placeholder. `/llms.txt`, the
        // footer and `packages/tools-cli/README.md` all say so, and this page —
        // the only one that prints the command — has to say it too.
        "> **Not released yet.** `tx402-tools` currently exists on npm as a reserved `0.0.0` placeholder, so the command above is what will work at release rather than today. Until then, build it from [the repository](https://github.com/neogeeks/tx402-tools/tree/main/packages/tools-cli).",
        "",
        "It reads `tx402 call --json` output, a serialized tx402 error, a raw HTTP request/response pair, or an event trace, and works out which one you gave it.",
        "",
        "## Sharing one",
        "",
        "`--share` uploads the **redacted** trace and returns an expiring permalink — the link you paste into an issue. It is opt-in per invocation and prints exactly what it is about to send, before it sends it. Redaction happens on your machine; this service never receives an unredacted trace and has no column in which to store one.",
        "",
        "## The case this tool exists for",
        "",
        "If an authorization went out and no settlement response came back, **do not retry the payment.** The merchant may hold a valid authorization, and the reservation stays exposed — holding budget, never expiring — until an operator reconciles it. See <https://docs.tx402.io/operations/exposed-reconciliation/>.",
        "",
        "```json",
        JSON.stringify(body, null, 2),
        "```",
      ].join("\n"),
      {},
      ctx,
    );
  }

  return html(
    page({
      title: TOOLS.replay.title,
      description: lede,
      path: ctx.url.pathname,
      // `TOOLS.replay.h1` is own worked example of a symptom
      // query and the highest-intent term in the suite. It used to render only
      // as the `<h2>` inside `emptyState`, which left this the one page of
      // ten with no `<h1>` at all. The
      // empty state keeps a heading of its own — a different one, because two
      // elements carrying the same string is what caused the confusion.
      body:
        pageHead(TOOLS.replay.h1, lede) +
        emptyState({
          title: "Replay runs on your machine",
          body: "Your trace never leaves it unless you ask: <code>--share</code> redacts locally, then uploads, and prints exactly what it is about to send first.",
          detail:
            "If an authorization went out and no settlement response came back, do not retry the payment: the merchant may hold it, and the reservation stays exposed until an operator reconciles it.",
        }),
    }),
    {},
    ctx,
  );
}
