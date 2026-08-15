/**
 * `inspect_endpoint` — what does this endpoint charge, on which network, to
 * whom, and what have we observed about it.
 *
 * This one does contact `tools.tx402.io`, and it is the only thing in this package that contacts
 * anything. It has to: "what has been observed about this endpoint over time" is a question about a
 * corpus, and the corpus is hosted. The endpoint itself is never contacted from here — the hosted
 * probe does that, behind the SSRF guard and the per-target politeness limit that exists to
 * enforce, which is also why this tool cannot be pointed at `localhost` or at private address
 * space.
 *
 * Everything that comes back is validated against `spec/schemas/inspect.json`
 * before a single character of it reaches a model. See `schemas.ts` for why that
 * is production behaviour here and test-only everywhere else.
 */

import {
  footer,
  renderChecks,
  renderObserved,
  renderProbe,
  renderRisk,
  renderSignals,
  renderTerms,
  section,
  tally,
  tallySentence,
} from "./format.js";
import { HostedClient, type HostedOutcome } from "./hosted.js";
import type { ToolResult } from "./tool-result.js";
import { errorResult, textResult } from "./tool-result.js";
import type { Envelope, InspectData, Warning } from "./types.js";

export interface InspectArgs {
  url?: unknown;
}

export async function runInspectEndpoint(
  args: InspectArgs,
  client: HostedClient,
): Promise<ToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url.length === 0) {
    return errorResult(
      "No URL was supplied, so there was nothing to inspect. Pass the `url` argument: the https URL " +
        "of the endpoint you are considering paying, including its query string.",
    );
  }

  // Refused here rather than round-tripped, because the answer is the same and
  // the caller gets it immediately. The hosted guard refuses these too — this is
  // not the enforcement, it is the fast path.
  const shape = urlObjection(url);
  if (shape) return errorResult(shape);

  const outcome = await client.get<InspectData>("inspect", "inspect", { url });
  return renderOutcome(url, outcome, client.baseUrl);
}

function urlObjection(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a URL. Pass the absolute https URL of the endpoint, for example https://api.example.com/v1/geocode.`;
  }
  if (parsed.protocol !== "https:") {
    return (
      `The hosted inspector accepts https URLs only, and this one is ${parsed.protocol.replace(":", "")}. ` +
      "This is a property of the hosted probe, not a finding about the endpoint."
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return (
      "The URL carries credentials in its userinfo component. It is refused rather than having them " +
      "stripped, so that no credential is ever sent anywhere by this tool. Pass the URL without them."
    );
  }
  return null;
}

function renderOutcome(
  url: string,
  outcome: HostedOutcome<InspectData>,
  baseUrl: string,
): ToolResult {
  switch (outcome.kind) {
    case "ok":
      return renderEnvelope(outcome.envelope);

    // SPEC §3.1: HTTP 200 and a finding. The endpoint being broken, absent from
    // the corpus, or not x402 at all is the answer the caller came for.
    case "finding":
      return textResult(
        section(
          `${findingHeadline(outcome.error.code)} — ${outcome.error.message}`,
          "",
          `This is an answer about ${url}, not a failure of the lookup. Nothing here is a claim about`,
          "whoever operates the endpoint.",
        ),
        { code: outcome.error.code, message: outcome.error.message },
      );

    // Named by `baseUrl` rather than hardcoded: a developer running against a
    // local `wrangler dev` needs the message to say which service refused.
    case "refused":
      return errorResult(
        `${baseUrl} did not answer for ${url}: ${outcome.error.message} ` +
          `(${outcome.error.code}, HTTP ${outcome.status}, ` +
          `${outcome.error.retryable ? "retrying may work" : "retrying will not help"}). ` +
          "No observation was made, so nothing is known about this endpoint from this call.",
      );

    case "unreachable":
      return errorResult(
        `Could not ask ${baseUrl} about ${url}. ${outcome.detail} ` +
          "No answer was received, so nothing is known about this endpoint from this call — this is a " +
          "failure to reach our service, not a finding about the endpoint. If you have the 402 " +
          "challenge itself, verify_challenge checks it locally and needs no network.",
      );

    case "unvalidated":
      return errorResult(
        `${baseUrl} answered for ${url} with a response that does not match the frozen ` +
          `${outcome.schema} contract (spec/schemas/${outcome.schema}.json): ${outcome.detail}. ` +
          "The response was discarded rather than reported, because an answer we cannot validate is " +
          "not one to act on.",
      );
  }
}

function findingHeadline(code: string): string {
  switch (code) {
    case "NOT_X402":
      return "The endpoint answered, but not with an x402 payment challenge";
    case "CHALLENGE_MALFORMED":
      return "The endpoint served a payment challenge that could not be parsed";
    case "NO_DATA":
      return "We have no observations of this endpoint";
    /* c8 ignore next 2 */
    default:
      return code;
  }
}

function renderEnvelope(envelope: Envelope<InspectData>): ToolResult {
  const data = envelope.data;
  const counts = tally(data.checks);

  const heading = [
    `Endpoint: ${data.target.canonical_url ?? data.target.url ?? "not resolved"}`,
    data.challenge === null
      ? "  No x402 payment challenge was read from this endpoint."
      : `  Payment challenge read${
          data.challenge.valid
            ? " and it decodes under the same strict decoder a tx402 buyer runs before it signs."
            : " and a tx402 buyer would refuse it as served."
        }`,
    data.checks.length > 0 ? `  Checks: ${tallySentence(counts)}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // SPEC §2: a stub route answers with schema-valid, empty-but-honest data so
  // that this server could be written against a live API before the routes
  // existed. Forwarding that emptiness as an observation would be the one thing
  // it must not become.
  const stub = envelope.meta.implemented
    ? ""
    : [
        "Not yet implemented",
        "  This route reports meta.implemented: false, so the empty result below is a placeholder",
        "  rather than an observation. Do not read it as a finding about this endpoint.",
      ].join("\n");

  return textResult(
    section(
      heading,
      stub,
      renderWarnings(envelope.warnings),
      renderTerms(data.terms),
      renderProbe(data.probe),
      data.checks.length > 0 ? renderChecks(data.checks) : "",
      renderObserved(data.observed),
      renderRisk(data.risk),
      renderSignals(data.signals),
      renderLinks(data.links),
      footer(),
    ),
    data as unknown as Record<string, unknown>,
  );
}

/**
 * SPEC §2: a warning is a fact about the answer's completeness, never an error.
 * Rendered as such, so a model does not read `NO_HISTORY` as a finding.
 */
function renderWarnings(warnings: readonly Warning[]): string {
  if (warnings.length === 0) return "";
  return (
    "Notes on this answer's completeness (these are not findings)\n" +
    warnings.map((w) => `  ${w.code}: ${w.message}`).join("\n")
  );
}

function renderLinks(links: Record<string, string | null>): string {
  const rows: string[] = [];
  for (const key of ["html", "markdown", "json", "history", "methodology"] as const) {
    const value = links[key];
    if (typeof value === "string" && value.length > 0) rows.push(`  ${key.padEnd(11)} ${value}`);
  }
  if (rows.length === 0) return "";
  return `The same answer, for a person\n${rows.join("\n")}`;
}
