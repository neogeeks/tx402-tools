/**
 * `tx402-tools history <url>`.
 *
 * ── A hosted verb, and it says so ──────────────────────────────────────────
 *
 * History is the corpus. It cannot be computed on a laptop, so running this
 * verb *is* the request to call `tools.tx402.io` — which is what keeps
 * honest without a flag: there is nothing here that could have been
 * answered locally and quietly went to the network instead.
 *
 * ── "We could not ask" is not zero ─────────────────────────────────────────
 *
 * `/api/v1/history`'s availability and latency series are empty until
 * `CF_ANALYTICS_TOKEN` is set, and deliberately renders "we
 * could not ask" rather than a fabricated number. The renderer this command
 * uses is its own markdown mirror, which reads the `ANALYTICS_UNAVAILABLE`
 * and `NO_SAMPLES` warnings out of the envelope and keeps the two apart. The
 * CLI must not flatten that into an empty chart, and because it does not
 * re-render the series itself, it cannot.
 */

import { historyMarkdown } from "../../../../ui/pages/history/markdown.js";
import { WINDOWS } from "../../../../ui/pages/history/types.js";
import type { HistoryData, HistoryWindow } from "../../../../ui/pages/history/types.js";

import { UsageError, flagString, formatFrom } from "../args.js";
import type { Envelope } from "../envelope.js";
import { EXIT, exitForErrorCode } from "../exit.js";
import { HostedError, getJson, readErrorEnvelope, resolveOrigin } from "../hosted.js";
import type { CommandContext, CommandResult } from "../context.js";

export async function runHistory(ctx: CommandContext): Promise<CommandResult> {
  const format = formatFrom(ctx.args);
  const url = ctx.args.positionals[1] ?? flagString(ctx.args, "url");
  if (!url) {
    throw new UsageError(
      "history needs a URL.\n\n  tx402-tools history https://api.example.com/v1/geocode --window 30d",
    );
  }

  const window = (flagString(ctx.args, "window") ?? "30d") as HistoryWindow;
  if (!(WINDOWS as readonly string[]).includes(window)) {
    throw new UsageError(`--window must be one of ${WINDOWS.join(", ")}.`);
  }

  const origin = resolveOrigin(flagString(ctx.args, "origin"), ctx.env);

  let response;
  try {
    response = await getJson(
      `/api/v1/history?url=${encodeURIComponent(url)}&window=${window}`,
      { origin, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) },
    );
  } catch (error) {
    if (error instanceof HostedError) {
      ctx.printErr(error.message);
      return { exitCode: exitForErrorCode(error.code) };
    }
    throw error;
  }

  const failure = readErrorEnvelope(response.body);
  if (failure) {
    ctx.printErr(`${failure.code}: ${failure.message}`);
    return { exitCode: exitForErrorCode(failure.code) };
  }

  const body = response.body as Envelope<HistoryData>;
  if (!body || typeof body !== "object" || !("data" in body)) {
    ctx.printErr(`${origin} did not return a history envelope.`);
    return { exitCode: EXIT.transport };
  }

  if (format === "json") {
    ctx.print(JSON.stringify(body, null, 2));
  } else {
    ctx.print(
      historyMarkdown({
        view: { data: body.data, warnings: body.warnings },
        envelope: body,
      }),
    );
  }

  // `has_data: false` exits 0. An endpoint we have not observed yet is a real
  // answer — "no history yet" — and turning it into a failure would make the
  // corpus's own coverage look like the caller's mistake.
  return { exitCode: EXIT.success };
}
