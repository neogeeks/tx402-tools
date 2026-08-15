/**
 * `tx402-tools inspect <url>`.
 *
 * ── Local by default, hosted only when asked ───────────────────────────────
 *
 * The default is a probe from this machine. That is the whole product argument
 * in the input is a URL, so the *website* is the primary surface —
 * except that a developer debugging their own 402 endpoint on `localhost:3000`
 * cannot use a website, by design, because the hosted probe must never reach
 * private space. `--hosted` asks `tools.tx402.io` instead, which is the only
 * way to get the `observed` block filled in, and it is an explicit flag rather
 * than a silent fallback when the local answer is thin.
 *
 * ── One computation, two renderings ────────────────────────────────────────
 *
 * The report is built by `buildData` from `worker/routes/inspect.ts` — the
 * same function the hosted route calls — and rendered by `inspectMarkdown`,
 * the same renderer that serves `Accept: text/markdown`. So the terminal
 * output is byte-for-byte the hosted markdown mirror of the same envelope, and
 * `--json` is that envelope. Neither is a second computation (SPEC §1.2).
 */

import { buildData } from "../../../../worker/routes/inspect.js";
import { facilitatorOrigins } from "../../../../worker/lib/facilitators.js";
import { extractSignals } from "../../../../worker/lib/signals.js";
import { CURRENT_SCORE_VERSION } from "../../../../worker/lib/score.js";
import { inspectMarkdown } from "../../../../ui/pages/inspect/markdown.js";
import { outcomeOf } from "../../../../ui/pages/inspect/types.js";
import type { InspectData } from "../../../../ui/pages/inspect/types.js";

import { UsageError, flagBool, flagInt, flagString, formatFrom } from "../args.js";
import { envelope } from "../envelope.js";
import type { Envelope, Warning } from "../envelope.js";
import { EXIT, exitForErrorCode } from "../exit.js";
import { HostedError, getJson, readErrorEnvelope, resolveOrigin } from "../hosted.js";
import { cliProbe } from "../net/policy.js";
import type { CliProbeOptions } from "../net/policy.js";
import type { CommandContext, CommandResult } from "../context.js";

/**
 * The corpus is not readable from a laptop, and the report says so rather than
 * leaving the reader to assume the endpoint is new. `has_history: false` is a
 * correct answer, not a degraded one.
 */
const NO_CORPUS = {
  first_seen: null,
  last_seen: null,
  scan_count: 0,
  challenge_hash: null,
  recent_changes: [],
};

export async function runInspect(ctx: CommandContext): Promise<CommandResult> {
  const format = formatFrom(ctx.args);
  const url = ctx.args.positionals[1] ?? flagString(ctx.args, "url");

  if (!url) {
    throw new UsageError(
      "inspect needs a URL.\n\n  tx402-tools inspect https://api.example.com/v1/geocode\n  tx402-tools inspect http://localhost:3000/paid --allow-private",
    );
  }

  const origin = resolveOrigin(flagString(ctx.args, "origin"), ctx.env);

  if (flagBool(ctx.args, "hosted")) {
    return hostedInspect(ctx, url, origin, format);
  }

  const probeOptions: CliProbeOptions = {
    allowPrivate: flagBool(ctx.args, "allow-private"),
    allowHttp: flagBool(ctx.args, "http", true),
    insecure: flagBool(ctx.args, "insecure"),
  };
  const timeout = flagInt(ctx.args, "timeout");
  if (timeout !== null) probeOptions.totalTimeoutMs = timeout;
  if (ctx.probeOverrides?.connector) probeOptions.connector = ctx.probeOverrides.connector;
  if (ctx.probeOverrides?.resolver) probeOptions.resolver = ctx.probeOverrides.resolver;

  const { result } = await cliProbe(url, probeOptions);

  if (!result.ok) {
    return refusal(ctx, result.failure.code, result.failure.stage, format);
  }

  const signals = extractSignals(result.value, {
    // The bundled list, with its own date. The CLI cannot read the live
    // `facilitators` table, and the check reports which list answered rather
    // than implying it consulted the published one (SPEC §5.2.1 ¹).
    knownFacilitators: facilitatorOrigins(),
  });

  const built = buildData(result.value, signals, NO_CORPUS, origin, false);
  const warnings: Warning[] = [
    ...built.warnings,
    {
      code: "NO_CORPUS",
      message:
        "This report is a local probe, so the observed history is empty. Pass --hosted to ask tools.tx402.io.",
    },
  ];

  const body = envelope("inspect", built.data, warnings, {
    scoreVersion: built.data.risk === null ? null : CURRENT_SCORE_VERSION,
    origin,
  });

  emit(ctx, body, format, origin);
  return { exitCode: exitForOutcome(built.data) };
}

async function hostedInspect(
  ctx: CommandContext,
  url: string,
  origin: string,
  format: "text" | "json" | "md",
): Promise<CommandResult> {
  let response;
  try {
    response = await getJson(`/api/v1/inspect?url=${encodeURIComponent(url)}`, {
      origin,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
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

  const body = response.body as Envelope<InspectData>;
  if (!body || typeof body !== "object" || !("data" in body)) {
    ctx.printErr(`${origin} did not return an inspect envelope.`);
    return { exitCode: EXIT.transport };
  }

  emit(ctx, body, format, origin);
  return { exitCode: exitForOutcome(body.data) };
}

/**
 * `outcomeOf` is the hosted renderers' own classifier, so the CLI's exit code
 * and the page's headline can never disagree about which of SPEC §3.1's four
 * result states this is.
 *
 * `malformed` and `not_x402` exit 5 — you ran `inspect` because you expected an
 * x402 endpoint, and not finding one is a negative result a CI job wants to
 * see. Neither is an error envelope, and neither is a statement about whoever
 * operates the endpoint. **The risk band is deliberately not consulted.**
 */
function exitForOutcome(data: InspectData): number {
  switch (outcomeOf(data)) {
    case "valid":
      return EXIT.success;
    case "malformed":
    case "not_x402":
      return EXIT.protocol;
    case "no_input":
      return EXIT.usage;
  }
}

function emit(
  ctx: CommandContext,
  body: Envelope<InspectData>,
  format: "text" | "json" | "md",
  origin: string,
): void {
  if (format === "json") {
    ctx.print(JSON.stringify(body, null, 2));
    return;
  }
  ctx.print(
    inspectMarkdown({
      data: body.data,
      envelope: {
        meta: {
          cached: body.meta.cached,
          cache_age_seconds: body.meta.cache_age_seconds,
          tx402_version: body.meta.tx402_version,
        },
        warnings: body.warnings,
      },
      origin,
      snapshot: null,
    }),
  );
}

/**
 * A refusal, rendered as a refusal.
 *
 * The guard's `reason` never reaches the user — it is precise about internal
 * network shape and that precision is a scanner with extra steps (SPEC §3).
 * What does reach them is the code, the coarse stage, and, for the one code a
 * flag can fix, the flag.
 */
function refusal(
  ctx: CommandContext,
  code: string,
  stage: string,
  format: "text" | "json" | "md",
): CommandResult {
  const message = messageFor(code);
  if (format === "json") {
    ctx.print(
      JSON.stringify(
        {
          api_version: "v1",
          generated_at: new Date().toISOString().slice(0, 19) + "Z",
          error: {
            code,
            message,
            detail: { stage },
            retryable: code === "PROBE_TIMEOUT" || code === "PROBE_FAILED",
            docs: `https://tools.tx402.io/errors#${code.toLowerCase()}`,
          },
        },
        null,
        2,
      ),
    );
  } else {
    ctx.printErr(`${code}: ${message}`);
  }
  return { exitCode: exitForErrorCode(code) };
}

function messageFor(code: string): string {
  switch (code) {
    case "URL_PRIVATE_ADDRESS":
      return "That URL resolves into private, loopback or link-local space. Pass --allow-private to probe it from this machine.";
    case "URL_SCHEME_NOT_ALLOWED":
      return "This CLI probes http: and https: only.";
    case "URL_USERINFO_PRESENT":
      return "The URL carries credentials. It is refused rather than stripped.";
    case "URL_BLOCKED":
      return "The URL is refused by the guard.";
    case "TOO_MANY_REDIRECTS":
      return "The endpoint redirected more times than the hop limit allows.";
    case "RESPONSE_TOO_LARGE":
      return "The endpoint's response exceeded the byte cap.";
    case "PROBE_TIMEOUT":
      return "The endpoint did not answer within the time budget.";
    case "PROBE_FAILED":
      return "The endpoint could not be reached.";
    case "VALIDATION_FAILED":
      return "That is not a URL this CLI can probe.";
    default:
      return "The probe was refused.";
  }
}
