/**
 * The Markdown mirror.
 *
 * an agent reading `Accept: text/markdown` is a first-class
 * reader, not a downgrade. It gets the same verdict from the same evaluation —
 * one handler produces the JSON, the Markdown and the HTML from one result, so
 * the three cannot disagree.
 *
 * The stage ladder is the centre of this representation too. An agent that is
 * about to be refused benefits from the order for exactly the reason a human
 * does: it says which rule to change.
 */

import { TOOLS } from "../../tool-meta.js";
import { curlSnippet, pythonSnippet, typescriptSnippet } from "./snippets.js";
import { STAGE_LABELS, STAGES } from "./types.js";
import type { PolicyData, PolicyRequest } from "./types.js";

const DOCS = "https://docs.tx402.io/guides/policy/";

export interface PolicyMarkdownOptions {
  input: PolicyRequest;
  outcome: {
    data: PolicyData;
    warnings: { code: string; message: string }[];
  };
  envelope: unknown;
  permalink: string;
}

const MARK: Record<string, string> = { pass: "PASS", fail: "FAIL", skip: "skip" };

export function policyMarkdown(opts: PolicyMarkdownOptions): string {
  const { data, warnings } = opts.outcome;
  const firing = data.evaluation.find((s) => s.result === "fail");

  const lines: string[] = [
    `# ${TOOLS.policy.h1}`,
    "",
    TOOLS.policy.description,
    "",
    `**${data.decision.toUpperCase()}** — evaluated by \`${data.engine}\` from tx402 \`${data.tx402_version ?? "unknown"}\`, running server-side.`,
    "",
  ];

  if (firing) {
    lines.push(
      `Refused at stage ${STAGES.indexOf(firing.stage) + 1} of ${STAGES.length} (\`${firing.stage}\`). Nothing after it was evaluated.`,
      "",
    );
  } else if (data.decision === "deny") {
    lines.push("Refused before the evaluation stages ran, so none of them were reached.", "");
  }

  lines.push(
    "## Evaluation order",
    "",
    "Frozen, and the same in both SDKs. Stages after the first failure are not evaluated.",
    "",
    "| # | Stage | Result | Detail |",
    "| --- | --- | --- | --- |",
  );

  data.evaluation.forEach((step, i) => {
    const detail = (step.detail ?? "—").replace(/\|/g, "\\|");
    lines.push(`| ${i + 1} | \`${step.stage}\` — ${STAGE_LABELS[step.stage].title} | ${MARK[step.result] ?? step.result} | ${detail} |`);
  });

  lines.push("");

  if (data.error) {
    lines.push(
      "## The error the SDK raises",
      "",
      `- **name** \`${data.error.name}\``,
      `- **code** \`${data.error.code}\``,
      `- **message** ${data.error.message}`,
      "",
      "```json",
      JSON.stringify(data.error.details ?? {}, null, 2),
      "```",
      "",
      "This is the exception object itself, not a description of one.",
      "",
    );
  }

  if (data.selected_requirement) {
    lines.push(
      data.decision === "allow"
        ? "## The requirement a client would pay"
        : "## The requirement this refusal is about",
      "",
      "```json",
      JSON.stringify(data.selected_requirement, null, 2),
      "```",
      "",
    );
  }

  if (warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of warnings) lines.push(`- \`${warning.code}\` — ${warning.message}`);
    lines.push("");
  }

  lines.push(
    "## This configuration, as code",
    "",
    "```ts",
    typescriptSnippet(opts.input).trimEnd(),
    "```",
    "",
    "```python",
    pythonSnippet(opts.input).trimEnd(),
    "```",
    "",
    "```bash",
    curlSnippet(opts.input).trimEnd(),
    "```",
    "",
    "## Links",
    "",
    `- Permalink: <https://tools.tx402.io${opts.permalink}>`,
    `- Policy guide: <${DOCS}>`,
    "- Response contract: `spec/schemas/policy.json`",
    "",
    "## The full response",
    "",
    "```json",
    JSON.stringify(opts.envelope, null, 2),
    "```",
    "",
  );

  return lines.join("\n");
}
