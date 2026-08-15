/**
 * POST /api/v1/optout.
 *
 * The one-click opt-out promised in `docs/abuse-policy.md`, honoured within one
 * crawl cycle and **immediately at read time**: `recordOptOut` flips
 * `endpoints.status` in the same batch that writes the `optouts` row, so an
 * operator disappears from the corpus listing at once rather than at the next
 * sweep.
 *
 * Control of the origin must be proven, and only two proofs are accepted from
 * this route:
 *
 *   `well-known`  we fetch `/.well-known/x402-tools-optout` and see it exist
 *   `robots`      we re-read robots.txt and see it disallow us
 *
 * DNS-TXT and email are in the policy too, but neither is completed by an HTTP
 * request: TXT verification belongs with its claim flow, which already builds
 * exactly that machinery, and email is a human writing the row. Accepting an
 * unproven opt-out here would make this endpoint a way to remove **somebody
 * else's** endpoint from a public listing — a denial-of-listing vector against
 * the very operators the policy is written for.
 *
 * Note the asymmetry, which is deliberate: proving control is required to opt
 * an origin OUT, and nothing here can opt anything back IN.
 */

import { envelope, errorResponse, json, markdown, nowIso } from "../http.js";
import { canonicalizeUrl, validateUrl } from "../lib/guard.js";
import { checkWellKnownOptOut, recordOptOut } from "../crawler/optout.js";
import { fetchRobots, verdictFor } from "../crawler/robots.js";
import { newId } from "../crawler/store.js";
import type { RouteContext, RouteHandler } from "../types.js";

interface OptOutRequest {
  url?: unknown;
  scope?: unknown;
  method?: unknown;
}

export const optout: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  let body: OptOutRequest;
  try {
    body = await ctx.request.json<OptOutRequest>();
  } catch {
    return errorResponse("BAD_REQUEST", { message: "The request body must be JSON." });
  }

  if (typeof body.url !== "string" || body.url.length === 0) {
    return errorResponse("VALIDATION_FAILED", { message: "A `url` is required." });
  }

  // The same guard every probe goes through. An opt-out request naming a
  // private address is refused for the same reason a probe of one is.
  const validated = validateUrl(body.url);
  if (!validated.ok) {
    return errorResponse("VALIDATION_FAILED", { message: "That URL cannot be accepted." });
  }

  const url = validated.value.url;
  const origin = url.origin;
  const canonical = canonicalizeUrl(url);
  const scope = body.scope === "endpoint" ? "endpoint" : "origin";
  const requested = body.method === "robots" ? "robots" : "well-known";
  const now = nowIso();

  // Prove control, live, right now.
  let proven = false;
  let evidence: string | null = null;

  if (requested === "well-known") {
    const check = await checkWellKnownOptOut(origin);
    proven = check.optedOut;
    evidence = check.evidence;
  } else {
    const robots = await fetchRobots(origin);
    const verdict = verdictFor(robots.body, robots.status, url.pathname);
    proven = !verdict.allowed;
    evidence = verdict.reason;
  }

  if (!proven) {
    return json(
      envelope(ctx.route, {
        ok: false,
        opted_out: false,
        scope,
        target: scope === "origin" ? origin : canonical,
        method: requested,
        // Told plainly, because the operator's next action depends on it.
        detail:
          requested === "well-known"
            ? `Serve a file at ${origin}/.well-known/x402-tools-optout (any content) and call this again.`
            : `Add a Disallow for tx402-tools-crawler covering ${url.pathname} in ${origin}/robots.txt and call this again.`,
      }),
      { status: 200 },
      ctx,
    );
  }

  const { endpointsAffected } = await recordOptOut(ctx.env.DB, {
    id: newId(),
    scope,
    target: scope === "origin" ? origin : canonical,
    method: requested,
    evidence,
    requested_at: now,
    // Effective immediately. The policy says "within one crawl cycle"; there is
    // no reason to make somebody wait for the ceiling we promised.
    effective_at: now,
    note: null,
  });

  const data = {
    ok: true,
    opted_out: true,
    scope,
    target: scope === "origin" ? origin : canonical,
    method: requested,
    effective_at: now,
    endpoints_affected: endpointsAffected,
    detail:
      "Probing has stopped and these endpoints are no longer served. Records already written " +
      "to the append-only change log are retained but not served — that table is append-only " +
      "by database trigger, so nothing about it is quietly rewritten.",
  };

  if (ctx.format === "markdown") {
    return markdown(
      [
        "# Opted out",
        "",
        `**${data.target}** (${scope}) — effective ${now}.`,
        "",
        `Endpoints affected: ${endpointsAffected}`,
        "",
        data.detail,
      ].join("\n"),
      {},
      ctx,
    );
  }

  return json(envelope(ctx.route, data), {}, ctx);
};
