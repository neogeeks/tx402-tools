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

export const health: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const bindings = {
    db: await checkDb(ctx.env),
    analytics: checkAnalytics(ctx.env),
    queue: typeof ctx.env.CRAWL_QUEUE?.send === "function",
    limiter: typeof ctx.env.PROBE_LIMITER?.idFromName === "function",
    assets: typeof ctx.env.ASSETS?.fetch === "function",
  };

  const ok = Object.values(bindings).every(Boolean);

  return json(
    envelope(ctx.route, { ok, bindings }),
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
