/**
 * `tx402-tools verify`.
 *
 * ── The offline half provably sends nothing ────────────────────────────────
 *
 * is a test, not a promise. `test/verify-offline.test.ts` already
 * asserts that `verifyOffline` makes zero network calls, with a banner
 * saying why; `test/cli.test.ts` extends the same traps over **this command
 * path**, so `tx402-tools verify` provably sends nothing. That is the property
 * that makes the split in real rather than a policy: you verify a
 * challenge at the moment you are about to sign it, and at that moment a tool
 * that phones home is a tool that leaks what you are about to buy.
 *
 * `--enrich` is the explicit opt-in. It is a separate call to a separate
 * surface, it is never a fallback when the offline answer is thin, and the
 * three corpus-dependent checks report `skip` without it rather than being
 * omitted — "we did not look" must not read as "there was nothing to find".
 *
 * ── Why this calls `runVerify` and does not reimplement it ─────────────────
 *
 * `worker/routes/verify.ts` imports the verifier from **this package**
 *: the offline verifier is the shared library and
 * the hosted route is its client. `runVerify(request, null)` is the merge step
 * on top of it, and calling it with a null env is exactly the offline path. So
 * the CLI's verdict is not merely equal to the API's — it is the same code,
 * which is the only way SPEC §5.2's "bit for bit" can hold.
 */

import { runVerify } from "../../../../worker/routes/verify.js";
import type { VerifyRequest } from "../../../../worker/routes/verify.js";
import { CURRENT_SCORE_VERSION } from "../../../../worker/lib/score.js";
import { verifyMarkdown } from "../../../../ui/pages/verify/markdown.js";
import type { VerifyData } from "../../../../ui/pages/verify/types.js";

import { classifyRaw } from "../verify-offline.js";
import { UsageError, flagBool, flagString, formatFrom } from "../args.js";
import { envelope } from "../envelope.js";
import type { Envelope } from "../envelope.js";
import { EXIT, exitForErrorCode } from "../exit.js";
import { HostedError, postJson, readErrorEnvelope, resolveOrigin } from "../hosted.js";
import type { CommandContext, CommandResult } from "../context.js";

export async function runVerifyCommand(ctx: CommandContext): Promise<CommandResult> {
  const format = formatFrom(ctx.args);
  const origin = resolveOrigin(flagString(ctx.args, "origin"), ctx.env);
  const enrich = flagBool(ctx.args, "enrich");

  const challenge = await readChallenge(ctx);
  const contextUrl = flagString(ctx.args, "url");
  const expectedOrigin = flagString(ctx.args, "expect-origin");

  const request: VerifyRequest = {
    challenge,
    context:
      contextUrl || expectedOrigin
        ? { url: contextUrl, expected_origin: expectedOrigin }
        : null,
    options: { enrich },
  };

  if (enrich) return hostedVerify(ctx, request, origin, format);

  // `null` env: the offline path, with no corpus and nothing to reach for.
  const outcome = await runVerify(request, null);

  const body = envelope("verify", outcome.data, outcome.warnings, {
    scoreVersion: outcome.data.risk === null ? null : CURRENT_SCORE_VERSION,
    origin,
  });

  emit(ctx, body, format, request);
  return { exitCode: exitForVerdict(body.data.verdict) };
}

/**
 * Where the challenge comes from.
 *
 * Four inputs, matching `spec/schemas/common.json#/$defs/ChallengeInput` plus
 * the shell conventions a developer will reach for first. Exactly one wins;
 * passing two is a usage error rather than a silent precedence rule, because
 * "which one did it actually check?" is not a question a verifier should
 * leave open.
 */
async function readChallenge(ctx: CommandContext): Promise<VerifyRequest["challenge"]> {
  const header = flagString(ctx.args, "header");
  const bodyFlag = flagString(ctx.args, "body");
  const file = flagString(ctx.args, "file");
  const positional = ctx.args.positionals[1] ?? null;

  const given = [header, bodyFlag, file, positional].filter((v) => v !== null);
  if (given.length > 1) {
    throw new UsageError(
      "Pass exactly one of --header, --body, --file or a positional argument.",
    );
  }

  if (header !== null) return { header };
  if (bodyFlag !== null) return { body: bodyFlag };

  const source = file ?? positional;
  if (source === null) {
    throw new UsageError(
      [
        "verify needs a challenge.",
        "",
        "  tx402-tools verify --header eyJ4NDAyVmVyc2lvbiI6Mi…",
        "  tx402-tools verify challenge.json --url https://api.example.com/v1/geocode",
        "  curl -sI https://api.example.com/v1/geocode | grep -i payment-required | tx402-tools verify -",
        "",
        "The offline checks send nothing. --enrich asks tools.tx402.io, and is the only thing that does.",
      ].join("\n"),
    );
  }

  const text = source === "-" ? await ctx.readStdin() : await readFileText(source);
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new UsageError("The challenge was empty.");

  // `classifyRaw` is the verifier's own classifier, so a pasted blob is read
  // the same way here as it is on the /verify page. Deliberately not "try
  // base64 and fall back": a fallback would reclassify a malformed header as a
  // body and hide the `base64_strict` finding.
  return classifyRaw(trimmed) === "body" ? { body: trimmed } : { header: trimmed };
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new UsageError(`Could not read ${path}.`);
  }
}

async function hostedVerify(
  ctx: CommandContext,
  request: VerifyRequest,
  origin: string,
  format: "text" | "json" | "md",
): Promise<CommandResult> {
  let response;
  try {
    response = await postJson("/api/v1/verify", request, {
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

  const body = response.body as Envelope<VerifyData>;
  if (!body || typeof body !== "object" || !("data" in body)) {
    ctx.printErr(`${origin} did not return a verify envelope.`);
    return { exitCode: EXIT.transport };
  }

  emit(ctx, body, format, request);
  return { exitCode: exitForVerdict(body.data.verdict) };
}

/**
 * `fail` means tx402 would refuse this challenge, which is what exit 5 means
 * everywhere else in this table. `warn` exits 0 on purpose: a warning is a
 * fact about our confidence, and failing a build on "the facilitator is not on
 * our list" would make the list a gate it was never claimed to be.
 */
function exitForVerdict(verdict: string): number {
  return verdict === "fail" ? EXIT.protocol : EXIT.success;
}

function emit(
  ctx: CommandContext,
  body: Envelope<VerifyData>,
  format: "text" | "json" | "md",
  request: VerifyRequest,
): void {
  if (format === "json") {
    ctx.print(JSON.stringify(body, null, 2));
    return;
  }
  ctx.print(
    verifyMarkdown({
      outcome: { data: body.data, warnings: body.warnings },
      envelope: body,
      input: { context: request.context },
    }),
  );
}
