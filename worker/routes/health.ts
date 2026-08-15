/**
 * /api/v1/health and /api/v1/meta.
 *
 * Health probes each binding rather than asserting it exists, because a binding
 * that is declared in wrangler.jsonc and not actually enabled on the account is
 * exactly the failure mode O2a warns about for Analytics Engine. If it
 * is not writable, this endpoint says so instead of the crawler discovering it
 * three sessions later.
 */

import { envelope, json } from "../http.js";
import { peekOnDemandBudget } from "../lib/politeness.js";
import type { RouteContext, RouteHandler } from "../types.js";

const SCHEMA_VERSION = "1";

async function checkDb(env: RouteContext["env"]): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function checkAnalytics(env: RouteContext["env"]): boolean {
  try {
    env.PROBES.writeDataPoint({ blobs: ["health"], doubles: [1], indexes: ["health"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is bot protection actually on?
 *
 * Both halves are required: a site key with no secret renders a widget whose
 * token nothing verifies, which is worse than no widget because it looks like
 * protection. `checkTurnstile` in `worker/routes/inspect.ts` applies the same
 * two-part test, so this reports the condition that governs rather than a
 * separate opinion about it.
 *
 * The secret's VALUE is never read here, only its presence.
 */
function checkTurnstile(env: RouteContext["env"]): boolean {
  return (env.TURNSTILE_SITE_KEY ?? "").length > 0 && (env.TURNSTILE_SECRET_KEY ?? "").length > 0;
}

export const health: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const [db, budget] = await Promise.all([
    checkDb(ctx.env),
    peekOnDemandBudget(ctx.env),
  ]);

  const bindings = {
    db,
    analytics: checkAnalytics(ctx.env),
    queue: typeof ctx.env.CRAWL_QUEUE?.send === "function",
    limiter: typeof ctx.env.PROBE_LIMITER?.idFromName === "function",
    assets: typeof ctx.env.ASSETS?.fetch === "function",
  };

  const ok = Object.values(bindings).every(Boolean);

  return json(
    envelope(ctx.route, {
      ok,
      bindings,
      // Published because docs/cost-model.md and docs/privacy.md both make
      // claims about these two, and a claim a reader cannot check against the
      // running service is a promise rather than a commitment. Turnstile in
      // particular shipped as `false` for a while under a comment saying that
      // was unacceptable — a number on the health endpoint is harder to forget
      // than a comment in a config file.
      limits: {
        turnstile: checkTurnstile(ctx.env),
        on_demand_probes_remaining_today: budget?.remaining ?? null,
        on_demand_probes_per_day: budget?.limit ?? null,
      },
    }),
    { status: ok ? 200 : 503 },
    ctx,
  );
};

export const meta: RouteHandler = (ctx: RouteContext): Response =>
  json(
    envelope(ctx.route, {
      ok: true,
      versions: {
        api_version: "v1",
        // Populated when score lands. Null here is honest: nothing in
        // this deployment produces a score yet.
        score_version: null,
        tx402_version: null,
        schema_version: SCHEMA_VERSION,
        environment: ctx.env.ENVIRONMENT ?? null,
      },
    }),
    {},
    ctx,
  );
