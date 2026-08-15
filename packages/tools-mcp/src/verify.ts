/**
 * `verify_challenge` — and it runs here, on this machine, sending nothing.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  This module must never acquire a network call, and `test/mcp.test.ts`   │
 * │  → "verify_challenge makes zero network calls" is what keeps it that │
 * │  way. DO NOT DELETE that test.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * calls the offline/hosted split "the product", not an optimisation,
 * and the reason is the moment this tool is called in: an agent has a challenge
 * in hand and is about to sign it. Sending that challenge to a third party in
 * order to be told whether it is well-formed would be a strange thing to ask of
 * anyone, and it would make a hosted outage into a payment outage.
 *
 * ── One verifier, imported, never reimplemented ────────────────────────────
 *
 * `verifyOffline` comes from `packages/tools-cli/src/verify-offline.ts`.
 * built it as the shared library precisely so every surface runs the same code:
 * `worker/routes/verify.ts` imports it, the CLI imports it, and so does this.
 * SPEC §5.2 requires the CLI and the API to agree bit for bit, and importing is
 * the only way that can actually hold — four implementations of §5.2.1 would be
 * four subtly different verdicts about the same bytes, all of them schema-valid.
 * ** owns that file this wave. This session imports it and does not touch it.**
 *
 * ── The three hosted checks report `skip`, and say why ─────────────────────
 *
 * `amount_within_observed_range`, `recipient_matches_observed` and
 * `endpoint_known` need the corpus. They are reported as `skip` with a reason,
 * never omitted and never passed:. decision 5, and the difference
 * an agent will act on. The result points at `inspect_endpoint` for them, which
 * is the explicit, separate call asks for rather than a silent
 * fallback to the network.
 */

import {
  verifyOffline,
  type OfflineVerification,
} from "../../tools-cli/src/verify-offline.js";

import {
  footer,
  renderChecks,
  renderRisk,
  renderSignals,
  renderTerms,
  section,
  tally,
  tallySentence,
} from "./format.js";
import { validateAgainst, VERIFY_DATA_SCHEMA_ID } from "./schemas.js";
import type { ToolResult } from "./tool-result.js";
import { errorResult, textResult } from "./tool-result.js";
import type { Challenge, Check, Requirement, Risk, Signal } from "./types.js";

export interface VerifyArgs {
  challenge?: unknown;
  url?: unknown;
}

/** The `data` shape SPEC §5.2 freezes, minus the envelope this has no route for. */
interface VerifyData {
  verdict: string;
  challenge: Challenge | null;
  checks: Check[];
  signals: Signal[];
  risk: Risk | null;
  enrichment: null;
}

export async function runVerifyChallenge(args: VerifyArgs): Promise<ToolResult> {
  const challenge = typeof args.challenge === "string" ? args.challenge.trim() : "";
  if (challenge.length === 0) {
    return errorResult(
      "No challenge was supplied, so there was nothing to check. Pass the `challenge` argument: " +
        "the base64 value of the PAYMENT-REQUIRED response header, or the JSON body of a legacy " +
        "x402 v1 402 response, exactly as the endpoint served it.",
    );
  }

  const url = typeof args.url === "string" && args.url.trim().length > 0 ? args.url.trim() : null;

  let verification: OfflineVerification;
  try {
    // `raw` rather than `header` or `body`: the caller pasted something, and
    // `classifyRaw` decides which wire form it is by the one rule that cannot
    // misfire — a JSON challenge starts with `{` and a base64 header never does.
    verification = await verifyOffline({ raw: challenge }, { context: url ? { url } : null });
  } catch (error) {
    // Nothing in `verifyOffline` is documented to throw, so if it does, the
    // honest answer is that we do not have a verdict — not a verdict of our own.
    return errorResult(
      "The challenge could not be checked: the verifier stopped with an unexpected error " +
        `(${error instanceof Error ? error.name : "unknown"}). No verdict was produced, and none ` +
        "should be inferred from this message.",
    );
  }

  const data: VerifyData = {
    verdict: verification.verdict,
    challenge: verification.challenge,
    checks: verification.checks,
    signals: verification.signals,
    risk: verification.risk,
    enrichment: null,
  };

  // Held to the same frozen contract as the hosted route's answer, for the same
  // reason: a result an agent may act on is not something to hand over unchecked.
  const valid = validateAgainst(VERIFY_DATA_SCHEMA_ID, data);
  if (!valid.ok) {
    return errorResult(
      "The verifier produced a result that does not match the frozen verify contract " +
        `(spec/schemas/verify.json): ${valid.errors}. The result was discarded rather than reported, ` +
        "because an answer we cannot validate is not one to act on.",
    );
  }

  return textResult(render(verification, url), data as unknown as Record<string, unknown>);
}

function render(v: OfflineVerification, url: string | null): string {
  const counts = tally(v.checks);
  const terms = (v.observed_terms[0] ?? null) as Requirement | null;

  const heading = [
    `Verdict: ${v.verdict.toUpperCase()} — ${tallySentence(counts)}.`,
    "",
    "Checked entirely on this machine. No network request was made and the challenge was not sent",
    "anywhere. This describes the bytes you supplied; it is not a statement about whoever operates",
    "the endpoint.",
  ].join("\n");

  const decode = renderDecode(v.challenge, url);

  const more =
    v.observed_terms.length > 1
      ? `\n  This challenge offers ${v.observed_terms.length} payment requirements; the first is shown.`
      : "";

  const hosted = [
    "Not checked here",
    "  Three checks need observation history for this endpoint, and this tool does not contact the",
    "  hosted service to get it. To run them — is this amount in the range we have seen, is this the",
    "  recipient we saw last time, do we know this endpoint at all — call inspect_endpoint on the",
    "  endpoint URL. That is a separate, explicit call that does reach the network.",
  ].join("\n");

  return section(
    heading,
    decode,
    renderTerms(terms) + more,
    renderChecks(v.checks),
    hosted,
    renderRisk(v.risk),
    renderSignals(v.signals),
    footer(),
  );
}

function renderDecode(challenge: Challenge, url: string | null): string {
  const lines = ["Challenge"];

  lines.push(`  wire form         ${wireFormLabel(challenge.wire_form)}`);
  lines.push(
    `  x402 version      ${challenge.x402_version === null ? "not declared" : String(challenge.x402_version)}`,
  );
  lines.push(
    `  requirements      ${challenge.requirement_count}` +
      (challenge.raw_bytes === null || challenge.raw_bytes === undefined
        ? ""
        : ` · ${challenge.raw_bytes} bytes`),
  );
  lines.push(
    challenge.valid
      ? "  decodes           yes, under the same strict decoder a tx402 buyer runs before it signs"
      : "  decodes           no — a tx402 buyer would refuse this challenge as served",
  );
  if (challenge.decode_error) {
    lines.push(`                    ${challenge.decode_error.code}: ${challenge.decode_error.message}`);
  }
  lines.push(
    url === null
      ? "  endpoint URL      not supplied, so resource_origin_match could not run — pass `url` to check it"
      : `  endpoint URL      ${url}`,
  );

  return lines.join("\n");
}

function wireFormLabel(wireForm: string): string {
  switch (wireForm) {
    case "v2-header":
      return "x402 v2, read as a PAYMENT-REQUIRED header value";
    case "v1-body":
      return "x402 v1, read as a JSON response body";
    default:
      return "none — neither wire form was recognized in what was supplied";
  }
}
