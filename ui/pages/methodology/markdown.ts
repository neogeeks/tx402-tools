/**
 * The Markdown mirror of `/methodology` (L11, SPEC §1.2).
 *
 * `curl -H 'Accept: text/markdown' tools.tx402.io/methodology` is the form an
 * agent reads, and this page is the one an agent most needs: its MCP renderer
 * attaches a framing sentence to every band it emits and points here for the
 * rest. So the framing has to come **before** the first band on this page too —
 * a mirror that buries it is a mirror that breaks the chain.
 */

import {
  ABOVE_THE_FOLD,
  APPEAL_CLAIM_ID_NOTE,
  APPEAL_CORRECTION_NOTE,
  APPEAL_HEADING,
  APPEAL_INTRO,
  APPEAL_REMOVAL_NOTE,
  ARITHMETIC_HEADING,
  BANDS_HEADING,
  COVERAGE_HEADING,
  EXAMPLES_HEADING,
  EXAMPLES_NOTE,
  GENERATED_NOTE,
  LEDE,
  MAGNITUDE_HEADING,
  META,
  NO_SCORE_NOTE,
  NOT_A_VERDICT_HEADING,
  REPRODUCE_NOTE,
  RULE_ONE,
  RULE_ONE_HEADING,
  RULE_TWO,
  RULE_TWO_HEADING,
  SIGNALS_HEADING,
  VERSION_HEADING,
  VERSION_NOTE,
} from "./copy.js";
import type { MethodologyData, WorkedExample } from "./model.js";
import type { ClaimDocs } from "./types.js";

function bandRange(from: number | null, to: number | null): string {
  if (from === null) return `<= ${to}`;
  if (to === null) return `>= ${from}`;
  return from === to ? `${from}` : `${from} – ${to}`;
}

function exampleBlock(example: WorkedExample): string[] {
  const scored = example.rows.filter((r) => r.status !== "skip");
  const skipped = example.rows.filter((r) => r.status === "skip");

  return [
    `### ${example.title}`,
    "",
    example.premise,
    "",
    "| Signal | Status | Weight |",
    "| --- | --- | ---: |",
    ...scored.map((r) => `| \`${r.signal_id}\` | ${r.status} | ${r.weight} |`),
    ...skipped.map((r) => `| \`${r.signal_id}\` | skip — not evaluable, so not scored | 0 |`),
    "",
    `\`earned = ${example.earned}\`, \`possible = ${example.possible}\` → **score ${example.score}, ` +
      `band ${example.band}**.`,
    "",
    `Recomputed from \`reasons[]\` alone: **${example.reproduced}**.`,
    "",
  ];
}

export function methodologyMarkdown(data: MethodologyData, docs: ClaimDocs): string {
  const lines: string[] = [
    `# ${META.h1}`,
    "",
    LEDE,
    "",
    // Above the fold, before the first band appears anywhere on the page.
    `> **These are observations, not accusations.** ${ABOVE_THE_FOLD}`,
    "",
    `Score version: \`${data.score_version}\`. Total available weight: **${data.total_available_weight}**.`,
    "",
    GENERATED_NOTE,
    "",
    `## ${NOT_A_VERDICT_HEADING}`,
    "",
    `### ${RULE_ONE_HEADING}`,
    "",
    RULE_ONE,
    "",
    `### ${RULE_TWO_HEADING}`,
    "",
    RULE_TWO,
    "",
    NO_SCORE_NOTE,
    "",
    `## ${SIGNALS_HEADING}`,
    "",
    "| Signal | Weight | Severity | Passes when | Why it is worth this much |",
    "| --- | ---: | --- | --- | --- |",
    ...data.signals.map(
      (s) =>
        `| \`${s.signal_id}\` | ${s.weight} | ${s.severity} | ${s.passes_when} | ${s.rationale} |`,
    ),
    "",
    "`severity` does not change the arithmetic — the weight already carries that. It tells a renderer how " +
      "to phrase the finding: `fail` for a concrete defect in the challenge, `warn` for “this may simply " +
      "be newer than our lists”.",
    "",
    "These are the exact sentences the API puts in `reasons[]`:",
    "",
    "| Signal | When it passes | When it does not |",
    "| --- | --- | --- |",
    ...data.signals.map((s) => `| \`${s.signal_id}\` | ${s.on_pass} | ${s.on_fail} |`),
    "",
    `## ${ARITHMETIC_HEADING}`,
    "",
    "```",
    data.formula,
    "```",
    "",
    `### ${BANDS_HEADING}`,
    "",
    "| Band | Score |",
    "| --- | ---: |",
    ...data.bands.map((b) => `| \`${b.band}\` | \`${bandRange(b.from, b.to)}\` |`),
    "",
    `### ${COVERAGE_HEADING}`,
    "",
    `If the observed signals account for less than **${data.coverage_floor_percent}%** of the ` +
      `${data.total_available_weight} available weight, the band is held at \`MEDIUM\` even when the score ` +
      "is high, and a `coverage` row is added to `reasons[]` saying so. The floor never lowers a score — it " +
      "constrains the band only, so “unknown is not bad” still holds.",
    "",
    `## ${MAGNITUDE_HEADING}`,
    "",
    "Computed in whole units of the asset. An unknown `decimals` means an unknown band, never a guessed one.",
    "",
    "| Whole units | Band |",
    "| ---: | --- |",
    ...data.magnitude_examples.map((m) => `| ${m.whole_units} | \`${m.band}\` |`),
    "",
    `## ${EXAMPLES_HEADING}`,
    "",
    EXAMPLES_NOTE,
    "",
    ...data.worked_examples.flatMap(exampleBlock),
    "### Doing it yourself",
    "",
    REPRODUCE_NOTE,
    "",
    "```",
    data.formula,
    "```",
    "",
    "So, on any response we serve:",
    "",
    "```",
    "curl -sH 'Accept: application/json' 'https://tools.tx402.io/api/v1/inspect?url=https://api.example.com/v1/geocode' \\",
    "  | jq '[.data.risk.reasons[] | select(.status != \"skip\")]",
    "        | (map(select(.status == \"pass\") | .weight) | add) / (map(.weight) | add) * 100 | round'",
    "```",
    "",
    `## ${APPEAL_HEADING}`,
    "",
    APPEAL_INTRO,
    "",
    `### 1. Claim the origin`,
    "",
    "```",
    `curl -sX POST ${docs.origin}/api/v1/claim \\`,
    "  -H 'content-type: application/json' \\",
    `  -d '{"url":"https://api.example.com/v1/geocode","method":"${docs.defaultMethod}"}'`,
    "```",
    "",
    APPEAL_CLAIM_ID_NOTE,
    "",
    `### 2. Publish the token`,
    "",
    `- **DNS TXT** — a \`TXT\` record at \`${docs.txtName}.<your host>\` whose value is the token.`,
    `- **A well-known file** — serve the token at \`https://<your host>${docs.wellKnown}\`.`,
    "",
    `Either is enough on its own. A token stops being verifiable ${docs.tokenTtlHours} hours after it is issued.`,
    "",
    `### 3. Verify, and read everything we hold`,
    "",
    "```",
    `curl -sX POST ${docs.origin}/api/v1/claim/<claim-id>/verify`,
    `curl -s ${docs.origin}/api/v1/claim/<claim-id>`,
    "```",
    "",
    "A verified claim returns, for every endpoint under the origin: the terms we hold, the raw signals we " +
      "scored, the score recomputed from those signals in front of you, the score exactly as it was served " +
      "at the time, and every recorded change.",
    "",
    `### 4. Correct a fact, or be removed`,
    "",
    "```",
    `curl -sX POST ${docs.origin}/api/v1/appeal \\`,
    "  -H 'content-type: application/json' \\",
    '  -d \'{"claim_id":"<claim-id>","disputed":"<signal id or change id>","argument":"..."}\'',
    "```",
    "",
    APPEAL_CORRECTION_NOTE,
    "",
    "```",
    `curl -sX POST ${docs.origin}/api/v1/appeal \\`,
    "  -H 'content-type: application/json' \\",
    '  -d \'{"claim_id":"<claim-id>","remedy":"removal","disputed":"listing","argument":"..."}\'',
    "```",
    "",
    APPEAL_REMOVAL_NOTE,
    "",
    `You can also stop us without talking to us at all — robots.txt or \`${docs.optoutWellKnown}\`. ` +
      `See ${docs.origin}/crawler.`,
    "",
    `## ${VERSION_HEADING}`,
    "",
    VERSION_NOTE,
    "",
    `Source of truth: ${data.source_url}`,
    "",
  ];

  return lines.join("\n");
}
