/**
 * Rendering the report.
 *
 * Two representations, the same facts: a terminal report and a markdown one for
 * the issue you are about to paste it into. Both are produced from a
 * `RedactedTrace`, so neither can print something the redactor did not see.
 *
 * The one visual rule that is a correctness rule: **`unknown` must never render
 * like `fail`.** They are different answers — one says the phase did not work,
 * the other says we cannot tell — and the whole ambiguous-payment case turns on
 * a reader seeing the difference at a glance. So `unknown` gets its own glyph
 * and its own word, and the do-not-retry banner is printed before the timeline
 * rather than after it, because that is the line the reader must not scroll
 * past.
 */

import { PHASE_LABELS } from "./lifecycle.js";
import type { LifecycleStep, PhaseStatus, ReplayResult } from "./types.js";

const GLYPH: Record<PhaseStatus, string> = {
  ok: "✓",
  fail: "✗",
  skip: "·",
  unknown: "?",
};

const WORD: Record<PhaseStatus, string> = {
  ok: "ok",
  fail: "failed",
  skip: "skipped",
  unknown: "unknown",
};

const FORMAT_LABEL: Record<string, string> = {
  cli_json: "tx402 call --json output",
  tx402_error: "a serialized tx402 error",
  http_pair: "a raw HTTP request/response pair",
  cli_trace: "a tx402 event trace",
};

const rule = (width = 72): string => "─".repeat(width);

function label(step: LifecycleStep): string {
  return PHASE_LABELS[step.phase as keyof typeof PHASE_LABELS] ?? titleCase(step.phase);
}

/** SPEC §5.7: renderers switch on the canonical set and title-case anything else. */
function titleCase(phase: string): string {
  return phase.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The terminal report. */
export function renderText(result: ReplayResult): string {
  const { analysis, trace } = result;
  const out: string[] = [];

  out.push(`402 Replay — reconstructed from ${FORMAT_LABEL[result.format] ?? result.format}`);
  out.push(rule());
  out.push("");

  if (analysis.diagnosis.do_not_retry) {
    out.push("  ⚠  DO NOT RETRY THIS PAYMENT");
    out.push("");
    out.push("     Money may have moved. Retrying can pay twice.");
    out.push("");
    out.push(rule());
    out.push("");
  }

  out.push("Lifecycle");
  out.push("");
  for (const step of analysis.lifecycle) {
    const glyph = GLYPH[step.status];
    const head = `  ${glyph}  ${step.phase.padEnd(10)} ${WORD[step.status].padEnd(8)} ${label(step)}`;
    out.push(head);
    if (step.detail) out.push(`        ${step.detail}`);
    if (step.at) out.push(`        at ${step.at}`);
  }
  out.push("");
  out.push(rule());
  out.push("");

  out.push(`Diagnosis: ${analysis.diagnosis.code}`);
  out.push(analysis.diagnosis.title);
  out.push("");
  out.push(wrap(analysis.diagnosis.explanation));
  out.push("");
  out.push("What to do");
  out.push("");
  out.push(indent(analysis.diagnosis.guidance));
  out.push("");
  out.push(rule());
  out.push("");
  out.push(`Money:      ${dispositionSentence(result)}`);
  out.push(`Exit code:  ${String(result.exitCode)}${exitNote(result.exitCode)}`);
  out.push(`Docs:       ${result.docs}`);
  out.push(
    `Redaction:  ${
      trace.redaction.applied
        ? `${String(trace.redaction.fields_redacted)} value(s) removed before anything was printed`
        : "nothing sensitive found — but the sweep ran first regardless"
    }`,
  );

  return out.join("\n");
}

/** The markdown report — what `--share` uploads and what you paste into an issue. */
export function renderMarkdown(result: ReplayResult): string {
  const { analysis, trace } = result;
  const out: string[] = [];

  out.push("## 402 Replay");
  out.push("");
  out.push(`Reconstructed from ${FORMAT_LABEL[result.format] ?? result.format}.`);
  out.push("");

  if (analysis.diagnosis.do_not_retry) {
    out.push("> ⚠️ **DO NOT RETRY THIS PAYMENT.**");
    out.push("> Money may have moved, and retrying can pay twice.");
    out.push("");
  }

  out.push("| Phase | Status | What it is |");
  out.push("| --- | --- | --- |");
  for (const step of analysis.lifecycle) {
    out.push(`| \`${step.phase}\` | ${GLYPH[step.status]} ${WORD[step.status]} | ${label(step)} |`);
  }
  out.push("");

  out.push(`### ${analysis.diagnosis.title}`);
  out.push("");
  out.push(`\`${analysis.diagnosis.code}\``);
  out.push("");
  out.push(analysis.diagnosis.explanation);
  out.push("");
  out.push("**What to do**");
  out.push("");
  out.push(analysis.diagnosis.guidance);
  out.push("");
  out.push(`- Money: ${dispositionSentence(result)}`);
  out.push(`- Exit code: \`${String(result.exitCode)}\``);
  out.push(`- Docs: ${result.docs}`);
  out.push(
    `- Redaction: ${String(trace.redaction.fields_redacted)} value(s) removed client-side before this was written.`,
  );

  return out.join("\n");
}

function dispositionSentence(result: ReplayResult): string {
  switch (result.disposition) {
    case "none":
      return "no reservation was taken — nothing moved";
    case "released":
      return "the reservation was released — nothing moved";
    case "exposed":
      return "the reservation is EXPOSED — it does not expire and holds budget until an operator reconciles it";
    case "committed":
      return "the payment COMMITTED — the money moved";
  }
}

function exitNote(code: number): string {
  const notes: Record<number, string> = {
    0: "  (success)",
    2: "  (usage/config — fix the command)",
    3: "  (policy — tx402's own guardrail refused)",
    4: "  (liquidity — fund the wallet)",
    5: "  (protocol — this client and this merchant cannot agree)",
    6: "  (signer — the key or the signing device failed)",
    7: "  (transport — safe to retry)",
    8: "  (ambiguous payment — never retry blindly on this one)",
    9: "  (resource failure — branch on whether it was paid, not on this code)",
  };
  return notes[code] ?? "";
}

function wrap(text: string, width = 72): string {
  return text
    .split("\n")
    .map((para) => {
      const words = para.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        if (line.length + word.length + 1 > width) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}
