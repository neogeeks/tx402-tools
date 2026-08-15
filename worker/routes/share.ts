/**
 * Share permalinks. ( will use it for replay shares).
 *
 * Contract: SPEC §8 (`/s/:id`, `/api/v1/share`, `/api/v1/share/:id`).
 * Storage: `share_links` in `migrations/0001_init.sql`.
 *
 * ── A share link can only say something we observed ────────────────────────
 *
 * The obvious design — POST a report, get a link — would let anyone store an
 * arbitrary JSON document and have it rendered, with our styling, at our
 * origin, under a heading that says what an endpoint charges. For a product
 * whose output is a trust verdict that is not a storage-abuse problem, it is a
 * forgery problem.
 *
 * So the caller POSTs a **URL**, and the server produces the payload itself by
 * running the same scan the live page runs (`scan` in `routes/inspect.ts`) —
 * through the same politeness cache, so a share is not a way around it. What
 * gets stored is our own output, and nothing else can be.
 *
 * ── It is a snapshot, and it says so ───────────────────────────────────────
 *
 * A stored report is a claim about a moment. Every rendering carries the
 * observed-at time, the time it was stored, and the date it expires — because
 * a permalink that quietly looks live is how a report about a price from six
 * months ago becomes a complaint.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 *
 * The id carries 128 bits of entropy from the platform CSPRNG. Nothing is
 * recorded about who created a link: `share_links` has no column for it, which
 * is the kind of guarantee that survives a refactor.
 */

import { ERROR_STATUS, envelope, errorBody, errorResponse, html, json, markdown, nowIso } from "../http.js";
import type { ErrorCode, RouteContext, RouteHandler, Warning } from "../types.js";

import { TX402_VERSION, scan } from "./inspect.js";
import { inspectErrorPage, inspectPage } from "../../ui/pages/inspect/page.js";
import { inspectMarkdown } from "../../ui/pages/inspect/markdown.js";
import type { InspectData, InspectView } from "../../ui/pages/inspect/types.js";

/** How long a snapshot stays readable. Stated on every rendering of it. */
const SHARE_TTL_DAYS = 90;

const MAX_BODY_BYTES = 16 * 1024;

/** Crockford-ish base32 over 16 random bytes: 26 chars, no vowels to misread. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function shareId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function plusDays(days: number): string {
  return `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19)}Z`;
}

// ── stored shape ──────────────────────────────────────────────────────────

interface StoredShare {
  kind: "inspect";
  data: InspectData;
  warnings: Warning[];
  tx402_version: string | null;
}

interface ShareRow {
  id: string;
  created_at: string;
  expires_at: string;
  stored: StoredShare;
}

function parseRow(row: Record<string, unknown> | null): ShareRow | null {
  if (!row) return null;
  const id = typeof row.id === "string" ? row.id : null;
  const payload = typeof row.payload_json === "string" ? row.payload_json : null;
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at : null;
  if (!id || !payload || !createdAt || !expiresAt) return null;
  if (typeof row.revoked_at === "string" && row.revoked_at.length > 0) return null;
  if (expiresAt <= nowIso()) return null;

  try {
    const stored = JSON.parse(payload) as StoredShare;
    if (stored?.kind !== "inspect" || typeof stored.data !== "object" || stored.data === null) return null;
    return { id, created_at: createdAt, expires_at: expiresAt, stored };
  } catch {
    return null;
  }
}

// ── input ─────────────────────────────────────────────────────────────────

interface CreateInput {
  url: string | null;
  /** A form post wants a redirect to the new permalink; JSON wants the JSON. */
  wantsRedirect: boolean;
  error: Response | null;
}

async function readCreateInput(ctx: RouteContext): Promise<CreateInput> {
  const contentType = ctx.request.headers.get("content-type") ?? "";

  if (contentType.includes("form")) {
    const form = await ctx.request.formData();
    const url = form.get("url");
    return {
      url: typeof url === "string" && url.trim().length > 0 ? url.trim() : null,
      wantsRedirect: true,
      error: null,
    };
  }

  const length = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return {
      url: null,
      wantsRedirect: false,
      error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }),
    };
  }

  const text = await ctx.request.text();
  if (text.length > MAX_BODY_BYTES) {
    return {
      url: null,
      wantsRedirect: false,
      error: errorResponse("BAD_REQUEST", { message: "That request body is too large." }),
    };
  }

  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        url: null,
        wantsRedirect: false,
        error: errorResponse("BAD_REQUEST", { message: "The request body is not valid JSON." }),
      };
    }
  }

  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const url = typeof body.url === "string" && body.url.trim().length > 0 ? body.url.trim() : null;
  return { url, wantsRedirect: false, error: null };
}

// ── rendering ─────────────────────────────────────────────────────────────

function viewOf(row: ShareRow, origin: string): InspectView {
  return {
    data: {
      ...row.stored.data,
      links: { ...row.stored.data.links, share: `${origin}/s/${row.id}` },
    },
    envelope: {
      meta: { cached: false, cache_age_seconds: null, tx402_version: row.stored.tx402_version },
      warnings: row.stored.warnings,
    },
    origin,
    snapshot: { id: row.id, created_at: row.created_at, expires_at: row.expires_at },
  };
}

function notFound(ctx: RouteContext, code: ErrorCode = "NOT_FOUND"): Response {
  if (ctx.format !== "html") return errorResponse(code);

  const body = errorBody(code);
  return html(
    inspectErrorPage({
      code: body.error.code,
      message: "That share link does not exist, has been revoked, or has expired.",
      docs: body.error.docs ?? null,
      url: null,
      path: ctx.url.pathname,
      turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY ?? "",
    }),
    { status: ERROR_STATUS[code] },
    ctx,
  );
}

// ── the route ─────────────────────────────────────────────────────────────

export const share: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const origin = ctx.env.PUBLIC_ORIGIN || "https://tools.tx402.io";
  const meta = ctx.route;

  /**
   * A stored snapshot answers with `tool: "inspect"`, not `tool: "share"`.
   *
   * The envelope's `tool` states which frozen contract `data` follows, and a
   * snapshot's `data` is an inspect report — the same object a live scan
   * returns, at an earlier time. Saying otherwise would force the CLI and the
   * MCP server to carry a second parser for a payload they already understand,
   * and would leave the stored report validated by no schema at all. Recorded
   * for review.; will want the same for
   * `tool: "replay"`.
   */
  const snapshotMeta = { ...meta, tool: "inspect" };

  // ── POST /api/v1/share — create a snapshot ─────────────────────────────
  if (ctx.request.method === "POST") {
    const input = await readCreateInput(ctx);
    if (input.error) return input.error;
    if (input.url === null) {
      return errorResponse("VALIDATION_FAILED", {
        message: "Send a body with a `url` string.",
        detail: { fields: ["url"] },
      });
    }

    // The payload is OUR scan of that URL, not a document the caller handed
    // us. It goes through the same politeness cache as everything else, so a
    // share request is not a way around the per-endpoint window.
    const scanned = await scan(ctx, input.url, "api");
    if (!scanned.ok) {
      const headers: Record<string, string> = {};
      if (scanned.failure.retryAfterSeconds !== null) {
        headers["retry-after"] = String(Math.max(1, scanned.failure.retryAfterSeconds));
      }
      return errorResponse(scanned.failure.code, { detail: scanned.failure.detail, headers });
    }

    const id = shareId();
    const createdAt = nowIso();
    const expiresAt = plusDays(SHARE_TTL_DAYS);
    const stored: StoredShare = {
      kind: "inspect",
      data: scanned.outcome.data,
      warnings: scanned.outcome.warnings,
      tx402_version: TX402_VERSION,
    };

    try {
      await ctx.env.DB.prepare(
        `INSERT INTO share_links (id, kind, endpoint_id, payload_json, redaction_summary,
                                  created_at, expires_at, revoked_at, view_count)
         VALUES (?, 'inspect', ?, ?, NULL, ?, ?, NULL, 0)`,
      )
        .bind(
          id,
          scanned.outcome.data.target.endpoint_id,
          JSON.stringify(stored),
          createdAt,
          expiresAt,
        )
        .run();
    } catch {
      return errorResponse("INTERNAL");
    }

    const permalink = `${origin}/s/${id}`;

    // A form post came from the page's share button, which has no JavaScript
    // behind it. Redirecting to the permalink means the browser lands on the
    // thing the user just made.
    if (input.wantsRedirect) {
      return new Response(null, { status: 303, headers: { location: `/s/${id}` } });
    }

    return json(
      envelope(
        meta,
        {
          id,
          url: permalink,
          kind: "inspect",
          endpoint_url: scanned.outcome.data.target.url,
          observed_at: scanned.outcome.data.probe?.observed_at ?? null,
          created_at: createdAt,
          expires_at: expiresAt,
        },
        {
          warnings: [
            {
              code: "SNAPSHOT",
              message: `This link records what we observed at ${scanned.outcome.data.probe?.observed_at ?? "scan time"}. It is a snapshot, not a live scan, and it expires on ${expiresAt}.`,
            },
          ],
          tx402Version: TX402_VERSION,
        },
      ),
      { status: 201 },
      ctx,
    );
  }

  // ── GET /s/:id and GET /api/v1/share/:id — read a snapshot ─────────────
  const id = ctx.params.id ?? "";
  if (id.length === 0) return notFound(ctx);

  let row: ShareRow | null = null;
  try {
    const found = await ctx.env.DB.prepare(
      `SELECT id, payload_json, created_at, expires_at, revoked_at
         FROM share_links
        WHERE id = ? AND kind = 'inspect'`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    row = parseRow(found);
  } catch {
    row = null;
  }

  if (row === null) return notFound(ctx);

  // A counter, not a visitor identifier: `share_links` has no column that
  // could become one. Best-effort — a failed count must never
  // cost the reader their report.
  ctx.ctx.waitUntil(
    ctx.env.DB.prepare(`UPDATE share_links SET view_count = view_count + 1 WHERE id = ?`)
      .bind(id)
      .run()
      .then(
        () => undefined,
        () => undefined,
      ),
  );

  const view = viewOf(row, origin);

  if (ctx.format === "json") {
    return json(
      envelope(snapshotMeta, view.data, {
        warnings: [
          {
            code: "SNAPSHOT",
            message: `A stored copy of a scan observed at ${view.data.probe?.observed_at ?? "an earlier time"}, not a live result. It expires on ${row.expires_at}.`,
          },
          ...row.stored.warnings,
        ],
        scoreVersion: view.data.risk?.score_version ?? null,
        tx402Version: row.stored.tx402_version,
      }),
      {},
      ctx,
    );
  }

  if (ctx.format === "markdown") return markdown(inspectMarkdown(view), {}, ctx);

  return html(
    inspectPage({
      view,
      path: ctx.url.pathname,
      turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY ?? "",
    }),
    {},
    ctx,
  );
};
