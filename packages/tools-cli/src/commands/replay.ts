/**
 * `tx402-tools replay <trace>`.
 *
 * ── Mounted, not rewritten ─────────────────────────────────────────────────
 *
 * We built the whole reconstruction and shaped `runReplay` to take its
 * input and its output sinks as parameters *precisely* so that this change
 * could mount it without touching those files. So this is the argv, the file
 * or stdin, and nothing else. Every judgement — the stop point, the phase
 * fold, the disposition, `do_not_retry` — stays in `src/replay/`.
 *
 * ── Two things this wrapper is careful about ───────────────────────────────
 *
 * 1. **`--json` emits the envelope, not the bare analysis.** `runReplay`
 *    prints `ReplayAnalysis` on its own, which is the right thing for the
 *    function's own contract; but `spec/schemas/replay.json` validates the
 *    **envelope**, exactly like every other tool, so `--json` here wraps the
 *    analysis in one. The wrapper suppresses `runReplay`'s printing in that
 *    mode rather than changing it, which is why its files are untouched and
 *    its tests still pass.
 *
 * 2. **Exit 8 survives.** `runReplay` returns the SDK's exit code, and this
 *    returns it unchanged. `if [ $? -eq 8 ]` means the same thing after a
 *    replay as after the call that produced the trace — money may have moved,
 *    do not retry. Nothing in this file can raise or lower it.
 */

import { runReplay } from "../replay/index.js";
import type { ShareOptions } from "../replay/share.js";

import { UsageError, flagBool, flagString, formatFrom } from "../args.js";
import { envelope } from "../envelope.js";
import type { CommandContext, CommandResult } from "../context.js";

export async function runReplayCommand(ctx: CommandContext): Promise<CommandResult> {
  const format = formatFrom(ctx.args);
  const source = ctx.args.positionals[1] ?? flagString(ctx.args, "file") ?? null;

  if (source === null) {
    throw new UsageError(
      [
        "replay needs a trace.",
        "",
        "  tx402-tools replay trace.json",
        "  tx402 call --json https://api.example.com/x | tx402-tools replay -",
        "",
        "Analysis is local. --share uploads a REDACTED trace and returns a link.",
      ].join("\n"),
    );
  }

  const input = source === "-" ? await ctx.readStdin() : await readFileText(source);

  const shareOptions = flagBool(ctx.args, "share") ? buildShareOptions(ctx) : null;

  const json = format === "json";
  const outcome = await runReplay(input, {
    format: json ? "text" : format,
    // In JSON mode the envelope below is the only thing on stdout, so
    // `runReplay`'s own rendering is discarded rather than interleaved.
    print: json ? () => undefined : (line: string) => ctx.print(line),
    printErr: (line: string) => ctx.printErr(line),
    shareOptions,
  });

  if (json) {
    ctx.print(
      JSON.stringify(
        envelope("replay", {
          id: null,
          url: outcome.shareUrl,
          expires_at: null,
          analysis: outcome.result?.analysis ?? null,
        }),
        null,
        2,
      ),
    );
  }

  return { exitCode: outcome.exitCode };
}

/**
 * `--share` is opt-in per invocation and never read from config.
 *
 * The confirmation is `--yes`, and without it the share client's own
 * `confirm` gate refuses — which is deliberate: a permalink is a public
 * artifact, and the redactor running first is a property of the payload, not
 * a reason to skip asking.
 */
function buildShareOptions(ctx: CommandContext): ShareOptions {
  const yes = flagBool(ctx.args, "yes");
  const origin = flagString(ctx.args, "origin");
  return {
    ...(origin ? { origin } : {}),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    print: (line: string) => ctx.print(line),
    confirm: () => yes,
  };
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new UsageError(`Could not read ${path}.`);
  }
}
