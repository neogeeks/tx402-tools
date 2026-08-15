/**
 * Worker entrypoint.
 *
 * Four handlers, three of them placeholders that exist so their bindings can be
 * declared now: adding a queue consumer or a cron trigger later would mean
 * editing wrangler.jsonc mid-wave, and L7 says parallel sessions do not deploy.
 */

import { errorResponse } from "./http.js";
import { handleRequest } from "./router.js";
import { runQueue, runScheduled } from "./crawler/index.js";
import type { CrawlMessage, Env } from "./types.js";

export { ProbeLimiter } from "./do/probe-limiter.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      // Never leak internals to a caller. The stack goes to the observability
      // stream, which is ours; the caller gets the envelope and nothing else.
      console.error("unhandled", err instanceof Error ? err.stack : String(err));
      return errorResponse("INTERNAL");
    }
  },

  /**
   * Crawler schedule.
   *
   * There is exactly ONE cron trigger, firing every 15 minutes, because cron
   * triggers are an account-level limited resource shared with every other
   * Worker on this account (see wrangler.jsonc). the handler branches on wall-clock time
   * here rather than declaring more triggers:
   *
   *   every tick pump the crawl queue
   *   every 6 hours sweep the corpus for re-probes
   *   once a day refresh the Bazaar / awesome-x402 seeds
   *
   * CRAWLER_ENABLED is the kill switch; the integrator flips it to "1" when
   * its ingestion merges, which is a var change rather than a code change.
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (env.CRAWLER_ENABLED !== "1") return;
    const stats = await runScheduled(env, { cron: event.cron });
    console.log(
      `cron ${event.cron}: considered=${stats.considered} enqueued=${stats.enqueued} ` +
        `probed=${stats.probes_performed} changes=${stats.changes_written} errors=${stats.errors}`,
    );
  },

  /** Crawl fan-out. */
  async queue(batch: MessageBatch<CrawlMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (env.CRAWLER_ENABLED !== "1") {
      // Acknowledge rather than retry: retrying a message no one can handle
      // yet just fills the dead-letter queue.
      batch.ackAll();
      return;
    }
    const stats = await runQueue(env, batch);
    console.log(
      `queue: ${batch.messages.length} message(s) — probed=${stats.probes_performed} ` +
        `changes=${stats.changes_written} errors=${stats.errors}`,
    );
  },
};
