/**
 * `tx402-tools replay` — the command surface.
 *
 *  owns the CLI's `package.json`, its `bin` entry and its argument parsing,
 * so this file exports a mountable command rather than reaching for
 * `process.argv` itself. `runReplay` takes its argv slice, its input and its
 * output sink as parameters:  wires it up, and the test suite drives the
 * same function with no process involved.
 *
 * Usage, once mounts it:
 *
 *   tx402-tools replay <file>          reconstruct from a file
 *   tx402-tools replay -               reconstruct from stdin
 *   tx402-tools replay <file> --json the ReplayAnalysis, for a machine
 *   tx402-tools replay <file> --md the markdown report
 *   tx402-tools replay <file> --share upload the REDACTED trace, get a link
 *
 * The exit code is the SDK's, not a new one: a replay of an ambiguous payment
 * exits 8, so `if [ $? -eq 8 ]` means the same thing in a script that replays a
 * trace as it does in the script that produced it.
 */

import { analyze } from "./analyze.js";
import { UnrecognizedTraceError } from "./detect.js";
import { renderMarkdown, renderText } from "./render.js";
import { ShareRefusedError, buildSharePayload, share } from "./share.js";
import { EXIT } from "./taxonomy.js";
import type { ShareOptions } from "./share.js";
import type { ReplayResult } from "./types.js";

export interface ReplayOptions {
  /** `json` emits the ReplayAnalysis; `md` the markdown report; `text` the terminal one. */
  format?: "text" | "json" | "md";
  /** Opt-in per invocation. Never read from config, never defaulted to true. */
  shareOptions?: ShareOptions | null;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

export interface ReplayOutcome {
  exitCode: number;
  result: ReplayResult | null;
  shareUrl: string | null;
}

export async function runReplay(input: string, options: ReplayOptions = {}): Promise<ReplayOutcome> {
  const print = options.print ?? ((line: string) => console.log(line));
  const printErr = options.printErr ?? ((line: string) => console.error(line));

  let result: ReplayResult;
  try {
    result = analyze(input);
  } catch (error) {
    if (error instanceof UnrecognizedTraceError) {
      printErr(error.message);
      return { exitCode: EXIT.usage, result: null, shareUrl: null };
    }
    throw error;
  }

  switch (options.format ?? "text") {
    case "json":
      print(JSON.stringify(result.analysis, null, 2));
      break;
    case "md":
      print(renderMarkdown(result));
      break;
    default:
      print(renderText(result));
  }

  let shareUrl: string | null = null;
  if (options.shareOptions) {
    try {
      const uploaded = await share(buildSharePayload(result), options.shareOptions);
      shareUrl = uploaded.url;
      print("");
      print(`Shared: ${uploaded.url}`);
      if (uploaded.expires_at) print(`Expires: ${uploaded.expires_at}`);
    } catch (error) {
      if (error instanceof ShareRefusedError) printErr(error.message);
      else throw error;
    }
  }

  return { exitCode: result.exitCode, result, shareUrl };
}

export { analyze } from "./analyze.js";
export { detect, UnrecognizedTraceError } from "./detect.js";
export { redactText, redactValue } from "./redact.js";
export { renderMarkdown, renderText } from "./render.js";
export { buildSharePayload, share, sharePreview, ShareRefusedError } from "./share.js";
export { EXIT, STOP_POINTS, SDK_PHASE_TO_PHASE, resolveStopPoint } from "./taxonomy.js";
export { PHASES } from "./types.js";
export type {
  Diagnosis,
  Disposition,
  LifecycleStep,
  Phase,
  PhaseStatus,
  RedactedTrace,
  RedactionSummary,
  ReplayAnalysis,
  ReplayResult,
  TraceFormat,
} from "./types.js";
