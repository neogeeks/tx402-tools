/**
 * Argument parsing.
 *
 * Deliberately hand-rolled and small: a dependency-free CLI is one fewer
 * supply-chain surface in a package whose entire pitch is that it cannot pay
 * and does not phone home. The grammar it accepts is the
 * one the README documents and nothing more.
 *
 *   --flag boolean
 *   --flag=value value
 *   --flag value value, when the flag is declared as taking one
 *   --no-flag boolean, false
 *   -                 the conventional "read stdin" positional
 *   --                everything after is a positional
 */

export interface ParsedArgs {
  /** Positional arguments, in order. `argv[0]` is the verb when present. */
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Flags that consume the next argv entry when written without `=`.
 *
 * Declared rather than guessed: `--json --url x` must not swallow `--url` as
 * the value of `--json`, and guessing from the next token's shape gets that
 * wrong for any value that starts with a dash.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "url",
  "urls",
  "window",
  "category",
  "origin",
  "expect-origin",
  "header",
  "body",
  "file",
  "timeout",
  "sort",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (onlyPositionals || arg === "-" || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");

    if (eq !== -1) {
      const name = body.slice(0, eq);
      if (name.length === 0) throw new UsageError(`Not a flag: ${arg}`);
      flags.set(name, body.slice(eq + 1));
      continue;
    }

    if (body.length === 0) throw new UsageError(`Not a flag: ${arg}`);

    if (body.startsWith("no-")) {
      flags.set(body.slice(3), false);
      continue;
    }

    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`--${body} needs a value.`);
      flags.set(body, next);
      i += 1;
      continue;
    }

    flags.set(body, true);
  }

  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  if (value === undefined || typeof value === "boolean") return null;
  return value;
}

export function flagBool(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  // `--json=false` is a thing people type. Treat it as they meant it rather
  // than as a truthy non-empty string.
  return value !== "false" && value !== "0" && value !== "no";
}

export function flagInt(args: ParsedArgs, name: string): number | null {
  const value = flagString(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive integer.`);
  }
  return parsed;
}

/**
 * `--json` and `--md` pick a representation, exactly as `?format=` does on the
 * hosted side (SPEC §1.2). They are mutually exclusive, and saying so beats
 * silently preferring one.
 */
export type Format = "text" | "json" | "md";

export function formatFrom(args: ParsedArgs): Format {
  const json = flagBool(args, "json");
  const md = flagBool(args, "md") || flagBool(args, "markdown");
  if (json && md) throw new UsageError("Pass --json or --md, not both.");
  if (json) return "json";
  if (md) return "md";
  return "text";
}
