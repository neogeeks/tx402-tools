/**
 * `tx402-tools` — the command entry point.
 *
 * ── Five verbs, and there is no sixth ──────────────────────────────────────
 *
 *   inspect · verify · history · compare · replay
 *
 * There is no `watch`. Watch was cut in wave 3 along with accounts, there is no `/api/v1/watch` to
 * call, and the consequence that shapes this whole package is that **nothing in this product
 * authenticates a caller**: no API key, no login, no token, no config file holding a credential. If
 * a future verb seems to need one, the argument in has to be re-made first.
 *
 * ── And it cannot pay ──────────────────────────────────────────────────────
 *
 *. There is no signer here, no key material and no
 * payment-authorization header — `pnpm gate:no-signer` greps `packages/` as
 * source and this package must stay clean under it. What the CLI *is* allowed
 * to do is read a trace describing a payment somebody else made, which is safe
 * only because `src/replay/redact.ts` runs first and is enforced by a type
 * rather than by a convention.
 *
 * ── run takes argv, not process.argv ─────────────────────────────────────
 *
 * The tests drive this function with an array and captured sinks, so what they
 * exercise is the real dispatch — the parsing, the flag precedence, the exit
 * codes — and not a mock of it.
 */

import { UsageError, parseArgs } from "./args.js";
import { EXIT, EXIT_LABELS } from "./exit.js";
import { runInspect } from "./commands/inspect.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runHistory } from "./commands/history.js";
import { runCompare } from "./commands/compare.js";
import { runReplayCommand } from "./commands/replay.js";
import type { CommandContext, CommandResult } from "./context.js";

export const VERBS = ["inspect", "verify", "history", "compare", "replay"] as const;
export type Verb = (typeof VERBS)[number];

export const VERSION = "0.1.0";

export interface RunOptions {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  readStdin?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  probeOverrides?: CommandContext["probeOverrides"];
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const printErr = options.printErr ?? ((line: string) => console.error(line));

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    printErr(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }

  const verb = args.positionals[0] ?? null;

  if (verb === null || verb === "help") {
    // No verb is not an error when the user asked for help, and is a usage
    // error when they asked for nothing. Both print the same text; only the
    // code differs, because a shell script piping into this deserves to know.
    print(helpText());
    return verb === "help" ? EXIT.success : EXIT.usage;
  }

  if (args.flags.has("version")) {
    print(VERSION);
    return EXIT.success;
  }

  if (args.flags.has("help")) {
    print(helpText());
    return EXIT.success;
  }

  if (!(VERBS as readonly string[]).includes(verb)) {
    printErr(`Unknown command: ${verb}\n\n${helpText()}`);
    return EXIT.usage;
  }

  const ctx: CommandContext = {
    args,
    print,
    printErr,
    readStdin: options.readStdin ?? readStdinFromProcess,
    env: options.env ?? processEnv(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.probeOverrides ? { probeOverrides: options.probeOverrides } : {}),
  };

  try {
    const result = await dispatch(verb as Verb, ctx);
    return result.exitCode;
  } catch (error) {
    if (error instanceof UsageError) {
      printErr(error.message);
      return EXIT.usage;
    }
    // Anything else is our bug. The message reaches the user because they are
    // the operator here — there is no third party to leak it to — but nothing
    // pretends it was their input's fault.
    printErr(error instanceof Error ? error.message : String(error));
    return EXIT.transport;
  }
}

function dispatch(verb: Verb, ctx: CommandContext): Promise<CommandResult> {
  switch (verb) {
    case "inspect":
      return runInspect(ctx);
    case "verify":
      return runVerifyCommand(ctx);
    case "history":
      return runHistory(ctx);
    case "compare":
      return runCompare(ctx);
    case "replay":
      return runReplayCommand(ctx);
  }
}

function processEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

async function readStdinFromProcess(): Promise<string> {
  const chunks: Uint8Array[] = [];
  // `process.stdin` is typed as an `any`-yielding async iterable; naming the
  // element type here is what keeps the concat below checked.
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function helpText(): string {
  return [
    `tx402-tools ${VERSION} — the x402 utilities, on your machine.`,
    "",
    "  tx402-tools inspect <url>     what does this endpoint charge, and to whom",
    "  tx402-tools verify [input]    check a challenge before you sign it (offline)",
    "  tx402-tools history <url>     how the terms have moved (hosted)",
    "  tx402-tools compare <urls…>   endpoints side by side (hosted)",
    "  tx402-tools replay <trace>    reconstruct a failed payment lifecycle",
    "",
    "Representations (SPEC §1.2 — the same value, rendered three ways):",
    "  --json                        the envelope, validating against spec/schemas/",
    "  --md                          the markdown report",
    "  (default)                     the same report, for a terminal",
    "",
    "inspect:",
    "  --allow-private               probe loopback and private space. The hosted",
    "                                probe never can, and that is why this exists.",
    "  --no-http                     https: only, as the hosted probe is",
    "  --insecure                    skip certificate validation (your own dev server)",
    "  --timeout <ms>                total budget for the probe",
    "  --hosted                      ask tools.tx402.io instead, for the observed history",
    "",
    "verify:",
    "  --header <b64> | --body <json> | <file> | -",
    "  --url <url>                   the endpoint it came from, for resource_origin_match",
    "  --enrich                      ALSO ask the corpus. The only thing that calls out.",
    "",
    "replay:",
    "  --share --yes                 upload the REDACTED trace, get a permalink",
    "",
    "Everywhere:",
    "  --origin <url>                point at a different deployment (or wrangler dev)",
    "  --help  --version",
    "",
    "Exit codes:",
    ...Object.entries(EXIT_LABELS).map(([code, label]) => `  ${code}  ${label}`),
    "",
    "This package cannot pay. It holds no keys and constructs no payment",
    "authorization. For the buyer SDK itself: npm i tx402",
  ].join("\n");
}
