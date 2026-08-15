/**
 * `tx402-tools compare`.
 *
 * A hosted verb, for the same reason as `history`: Compare is inherently a
 * corpus query.
 *
 * ── Why this renders the table itself ──────────────────────────────────────
 *
 * Every other verb reuses the hosted markdown mirror, so the terminal output
 * is byte-for-byte what `Accept: text/markdown` serves. Compare cannot:
 * `compareMarkdown` takes a `CompareView`, and a view carries `details`,
 * `ranking`, `categories` and `path` — none of which are on the wire, because
 * SPEC §5.5 puts only `data` in the envelope. So this file renders `data`.
 *
 * That is still one computation rendered twice, not two computations: nothing
 * here derives a fact. The one rule it must not break is the honest-empty one
 * — `insufficient_data: true` renders as a stated reason, never as a blank or
 * a zero, because a comparison table that fills gaps with plausible-looking
 * numbers is a liability rather than a feature.
 */

import { priceLabel } from "../../../../ui/pages/compare/types.js";
import type { CompareData, CompareRow } from "../../../../ui/pages/compare/types.js";

import { UsageError, flagString, formatFrom } from "../args.js";
import type { Envelope, Warning } from "../envelope.js";
import { EXIT, exitForErrorCode } from "../exit.js";
import { HostedError, getJson, readErrorEnvelope, resolveOrigin } from "../hosted.js";
import type { CommandContext, CommandResult } from "../context.js";

export async function runCompare(ctx: CommandContext): Promise<CommandResult> {
  const format = formatFrom(ctx.args);
  const category = flagString(ctx.args, "category");
  const urlsFlag = flagString(ctx.args, "urls");
  const positional = ctx.args.positionals.slice(1);

  const urls = urlsFlag
    ? urlsFlag.split(",").map((u) => u.trim()).filter((u) => u.length > 0)
    : positional;

  if (!category && urls.length === 0) {
    throw new UsageError(
      [
        "compare needs endpoints or a category.",
        "",
        "  tx402-tools compare https://a.example/x https://b.example/y",
        "  tx402-tools compare --category geocoding",
      ].join("\n"),
    );
  }

  const query = category
    ? `category=${encodeURIComponent(category)}`
    : `urls=${encodeURIComponent(urls.join(","))}`;

  const origin = resolveOrigin(flagString(ctx.args, "origin"), ctx.env);

  let response;
  try {
    response = await getJson(`/api/v1/compare?${query}`, {
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

  const body = response.body as Envelope<CompareData>;
  if (!body || typeof body !== "object" || !("data" in body)) {
    ctx.printErr(`${origin} did not return a compare envelope.`);
    return { exitCode: EXIT.transport };
  }

  if (format === "json") ctx.print(JSON.stringify(body, null, 2));
  else ctx.print(renderCompare(body.data, body.warnings));

  return { exitCode: EXIT.success };
}

const RULE = "─".repeat(72);

export function renderCompare(data: CompareData, warnings: Warning[]): string {
  const lines: string[] = ["# 402 Compare", ""];

  if (data.category) {
    lines.push(`**${data.category.title}**`, "");
    if (data.category.summary) lines.push(data.category.summary, "");
  }

  if (data.rows.length === 0) {
    lines.push(
      "No endpoints matched.",
      "",
      "That is an answer about our index, not about the endpoints: the corpus",
      "may not have reached them yet.",
      "",
    );
    return withWarnings(lines, warnings);
  }

  lines.push(RULE, "");
  for (const row of data.rows) {
    lines.push(...renderRow(row));
  }

  if (data.notes.length > 0) {
    lines.push("## NOTES", "");
    for (const note of data.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return withWarnings(lines, warnings);
}

function renderRow(row: CompareRow): string[] {
  const lines: string[] = [`## ${row.title ?? row.url}`, ""];
  if (row.title) lines.push(`  ${row.url}`, "");

  // Every empty cell states why it is empty. `insufficient_data` is the
  // frozen field that says "we do not have enough to say", and it is rendered
  // as that sentence rather than as a gap the reader fills in themselves.
  if (row.insufficient_data) {
    lines.push(
      "  Not enough data yet — we have not observed this endpoint often enough",
      "  to describe how its terms have moved.",
      "",
    );
  }

  const price = priceLabel(row.terms);
  lines.push(`- Price           ${price ?? "not observed"}`);
  lines.push(
    `- Network         ${row.terms?.network ?? "not observed"}`,
    `- Availability    ${
      row.availability_30d === null
        ? "we could not ask"
        : `${(row.availability_30d * 100).toFixed(2)}%`
    }`,
    `- Latency p50     ${row.latency_p50_ms === null ? "we could not ask" : `${row.latency_p50_ms} ms`}`,
    `- Last seen       ${row.last_seen ?? "never"}`,
  );

  // The band describes the confidence of our observations, never the operator, so it is printed with its own
  // version and its reasons
  // rather than as a bare adjective.
  if (row.risk) {
    lines.push(
      `- Observed signals ${row.risk.band} (score ${row.risk.score}, ${row.risk.score_version})`,
    );
  } else {
    lines.push("- Observed signals no score — no x402 challenge was observed");
  }

  lines.push("");
  return lines;
}

function withWarnings(lines: string[], warnings: Warning[]): string {
  if (warnings.length > 0) {
    lines.push(RULE, "", "## NOTES ON THIS ANSWER", "");
    for (const warning of warnings) lines.push(`- ${warning.message}`);
    lines.push("");
  }
  return lines.join("\n");
}
