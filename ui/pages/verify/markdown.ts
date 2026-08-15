/**
 * The `text/markdown` mirror of `/verify` (SPEC §1.2).  owns
 * this file.
 *
 * It is a **rendering of the same JSON**, never a second computation — it is
 * handed the exact `VerifyData` the JSON representation carries and formats
 * it. If the two could disagree the design would be wrong.
 *
 * The buyers in this economy are agents, so this is a first-class surface
 * rather than a courtesy: `curl -H 'Accept: text/markdown' …/verify` should be
 * genuinely pleasant to read, and the offline/hosted boundary has to survive
 * the trip into plain text — it is the one distinction a reader most needs and
 * the easiest to flatten away.
 */

import { CHECK_LABELS, VERDICT_LABEL, VERDICT_SUMMARY, type Check, type VerifyData } from "./types.js";

export interface VerifyMarkdownOptions {
  outcome: { data: VerifyData; warnings: { code: string; message: string }[] } | null;
  /** The envelope this is a rendering of; read for its stamps, never recomputed. */
  envelope: unknown;
  input: { context?: { url?: string | null } | null } | null;
}

const RULE = "─".repeat(72);

export function verifyMarkdown(opts: VerifyMarkdownOptions): string {
  const lines: string[] = ["# 402 Verify", ""];

  if (!opts.outcome) {
    lines.push(
      "No challenge was supplied.",
      "",
      "```",
      "POST /api/v1/verify",
      'content-type: application/json',
      "",
      '{ "challenge": { "header": "eyJ4NDAyVmVyc2lvbiI6Mi…" },',
      '  "context":   { "url": "https://api.example.com/v1/geocode" },',
      '  "options":   { "enrich": false } }',
      "```",
      "",
      "Exactly one of `challenge.header`, `challenge.body` or `challenge.raw`.",
      "`options.enrich` defaults to false: the offline checks send nothing, and the",
      "corpus lookup is an explicit opt-in.",
      "",
    );
    return lines.join("\n");
  }

  const { data, warnings } = opts.outcome;
  const meta = opts.envelope as { generated_at?: string; meta?: { tx402_version?: string | null } };

  lines.push(
    `**${VERDICT_LABEL[data.verdict]}** — ${VERDICT_SUMMARY[data.verdict]}`,
    "",
    RULE,
    "",
    "## CHALLENGE",
    "",
  );

  if (!data.challenge) {
    lines.push("No challenge was read.", "");
  } else {
    const c = data.challenge;
    const r = c.accepts[0] ?? null;
    lines.push(
      `- Wire form        ${c.wire_form}`,
      `- x402 version     ${c.x402_version ?? "not declared"}`,
      `- Decodes (tx402)  ${c.valid ? "yes" : `no — ${c.decode_error?.message ?? "refused"}`}`,
      `- Requirements     ${c.requirement_count}`,
      `- Size             ${c.raw_bytes === null ? "not measured" : `${c.raw_bytes} bytes`}`,
    );
    if (r) {
      lines.push(
        `- Network          ${r.network ?? "not declared"}`,
        `- Amount           ${r.amount_decimal ?? r.amount_raw ?? "not declared"}${
          r.amount_atomic ? ` (${r.amount_atomic} atomic)` : ""
        }`,
        `- Recipient        ${r.pay_to ?? "not declared"}`,
        `- Resource         ${r.resource ?? "not declared"}`,
      );
    }
    if (!c.valid && c.wire_form !== "none") {
      lines.push(
        "",
        "  tx402 refused this challenge, so any terms above are what we could read,",
        "  not terms it accepted.",
      );
    }
    lines.push("");
  }

  const offline = data.checks.filter((c) => c.offline);
  const hosted = data.checks.filter((c) => !c.offline);

  lines.push(
    RULE,
    "",
    "## CHECKED OFFLINE",
    "",
    "These run on the challenge alone — no network, no lookup. The CLI runs the",
    "same function locally and sends nothing anywhere.",
    "",
    ...checkLines(offline),
    "",
    RULE,
    "",
    "## CHECKED AGAINST OUR DATA",
    "",
  );

  if (!data.enrichment) {
    lines.push(
      "Not requested. These checks read the endpoint's history, so they only run",
      "when you ask for them with `options.enrich: true`. The offline verdict above",
      "does not change either way.",
      "",
    );
  } else if (!data.enrichment.endpoint_known) {
    lines.push(
      "No history yet. We have no record of this endpoint — the normal state for one",
      "nobody has scanned. It is reported as no data, never as a pass.",
      "",
    );
  }
  lines.push(...checkLines(hosted), "");

  if (data.risk) {
    lines.push(
      RULE,
      "",
      "## SIGNALS",
      "",
      `Score ${data.risk.score} · band ${data.risk.band} · ${data.risk.score_version}`,
      "",
      "The band describes how much of what we check we were able to confirm about",
      "this challenge. It is not a judgement about whoever operates the endpoint.",
      "Weights below are the ones applied, so the score is reproducible from this",
      "table — that reproducibility is the appeal mechanism.",
      "",
    );
    for (const reason of data.risk.reasons) {
      const weight = reason.weight === 0 ? "  -" : String(reason.weight).padStart(3, " ");
      lines.push(
        `  ${reason.status.toUpperCase().padEnd(4)} ${weight}  ${reason.signal_id}`,
        `              ${reason.message}`,
      );
    }
    lines.push("", `Methodology: ${data.risk.methodology_url}`, "");
  }

  if (warnings.length > 0) {
    lines.push(RULE, "", "## NOTES ON THIS ANSWER", "");
    for (const w of warnings) lines.push(`- ${w.code} — ${w.message}`);
    lines.push("");
  }

  lines.push(
    RULE,
    "",
    `Observed at ${meta.generated_at ?? "an unrecorded time"} · tx402 ${
      meta.meta?.tx402_version ?? "unknown"
    }`,
    "JSON: POST https://tools.tx402.io/api/v1/verify",
    "",
  );

  return lines.join("\n");
}

function checkLines(checks: Check[]): string[] {
  if (checks.length === 0) return ["  (none)"];
  return checks.flatMap((check) => {
    const head = `  ${check.status.toUpperCase().padEnd(4)}  ${check.id}`;
    const label = CHECK_LABELS[check.id];
    const out = [label ? `${head}\n        ${label}` : head];
    if (check.detail) out.push(`        ${check.detail}`);
    return out;
  });
}
