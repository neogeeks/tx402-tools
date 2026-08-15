/**
 * The HTML `/methodology` page —.
 *
 * asks for one thing above every other: that the framing sentence
 * be **above the fold**. `page({ observationNote: true })` puts its shared note
 * at the very top of the shell, and this page repeats the longer form as its
 * lede — because every other surface in the suite points here, and its MCP
 * renderer attaches its framing to every band it emits precisely so that a
 * reader who follows the link lands on the full argument rather than a table of
 * weights.
 *
 * Nothing here invents a colour or a component: `pnpm gate:tokens` rejects a raw
 * colour outside `ui/tokens.css`, and the primitives are its to design.
 */

import { escapeHtml, html, join, raw } from "../../components/html.js";
import { codeBlock } from "../../components/code-block.js";
import { kvTable } from "../../components/kv-table.js";
import { page, pageHead } from "../../components/page.js";
import { resultCard } from "../../components/result-card.js";
import { statusPill, toneForBand, toneForCheck } from "../../components/status-pill.js";
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
import { inlineMarkdown } from "./inline.js";
import type { MethodologyData, WorkedExample } from "./model.js";
import type { ClaimDocs } from "./types.js";

export interface MethodologyPageOptions {
  data: MethodologyData;
  docs: ClaimDocs;
  path?: string;
}

function bandRange(from: number | null, to: number | null): string {
  if (from === null) return `≤ ${to}`;
  if (to === null) return `≥ ${from}`;
  return from === to ? String(from) : `${from} – ${to}`;
}

function signalsTable(data: MethodologyData): string {
  const rows = data.signals.map(
    (s) => html`<tr>
      <th scope="row"><code>${s.signal_id}</code></th>
      <td>${s.weight}</td>
      <td>${raw(statusPill(s.severity, s.severity === "fail" ? "err" : "warn", "Severity:"))}</td>
      <td class="prose">${raw(inlineMarkdown(s.passes_when))}</td>
      <td class="prose">${raw(inlineMarkdown(s.rationale))}</td>
    </tr>`,
  );

  return html`<div class="table-scroll">
    <table class="kv">
      <caption class="visually-hidden">Scored signals, their weights and their rationale</caption>
      <thead>
        <tr>
          <th scope="col">Signal</th>
          <th scope="col">Weight</th>
          <th scope="col">Severity</th>
          <th scope="col">Passes when</th>
          <th scope="col">Why it is worth this much</th>
        </tr>
      </thead>
      <tbody>
        ${join(rows)}
      </tbody>
    </table>
  </div>`;
}

function messagesTable(data: MethodologyData): string {
  const rows = data.signals.map(
    (s) => html`<tr>
      <th scope="row"><code>${s.signal_id}</code></th>
      <td class="prose">${s.on_pass}</td>
      <td class="prose">${s.on_fail}</td>
    </tr>`,
  );

  return html`<details>
    <summary>The exact sentences the API puts in <code>reasons[]</code></summary>
    <div class="table-scroll">
      <table class="kv">
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">When it passes</th>
            <th scope="col">When it does not</th>
          </tr>
        </thead>
        <tbody>
          ${join(rows)}
        </tbody>
      </table>
    </div>
  </details>`;
}

function exampleCard(example: WorkedExample): string {
  const rows = example.rows.map(
    (r) => html`<tr>
      <th scope="row"><code>${r.signal_id}</code></th>
      <td>${raw(statusPill(r.status, toneForCheck(r.status), "Result:"))}</td>
      <td>${r.status === "skip" ? "—" : r.weight}</td>
      <td class="prose">${r.message}</td>
    </tr>`,
  );

  const arithmetic = kvTable([
    { label: "Weight earned", value: String(example.earned) },
    { label: "Weight in play", value: String(example.possible), note: "Skipped signals are in neither sum." },
    { label: "Score", value: String(example.score) },
    {
      label: "Recomputed from reasons[]",
      value: String(example.reproduced),
      note:
        example.reproduced === example.score
          ? "Same number, worked out a second time from the response alone."
          : "These disagree, which is a release-blocking bug in this service.",
    },
  ]);

  return resultCard({
    id: example.key,
    title: example.title,
    badge: statusPill(`band ${example.band}`, toneForBand(example.band), "Band:"),
    body:
      html`<p class="card-lead">${example.premise}</p>` +
      html`<div class="table-scroll">
        <table class="kv">
          <thead>
            <tr>
              <th scope="col">Signal</th>
              <th scope="col">Result</th>
              <th scope="col">Weight</th>
              <th scope="col">What the response says</th>
            </tr>
          </thead>
          <tbody>
            ${join(rows)}
          </tbody>
        </table>
      </div>` +
      arithmetic +
      codeBlock({ code: example.reasons_json, label: "What a caller would hold", copy: true }),
  });
}

function claimCard(docs: ClaimDocs): string {
  const steps = [
    {
      heading: "1. Claim the origin",
      body: APPEAL_CLAIM_ID_NOTE,
      code:
        `curl -sX POST ${docs.origin}/api/v1/claim \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -d '{"url":"https://api.example.com/v1/geocode","method":"${docs.defaultMethod}"}'`,
    },
    {
      heading: "2. Publish the token",
      body:
        `Either proof is enough on its own: a DNS TXT record at ${docs.txtName}.<your host>, or the token ` +
        `served at https://<your host>${docs.wellKnown}. A token stops being verifiable ` +
        `${docs.tokenTtlHours} hours after it is issued.`,
      code: null,
    },
    {
      heading: "3. Verify, and read everything we hold",
      body:
        "A verified claim returns, for every endpoint under the origin: the terms we hold, the raw signals " +
        "we scored, the score recomputed from those signals in front of you, the score exactly as it was " +
        "served at the time, and every recorded change.",
      code:
        `curl -sX POST ${docs.origin}/api/v1/claim/<claim-id>/verify\n` +
        `curl -s ${docs.origin}/api/v1/claim/<claim-id>`,
    },
    {
      heading: "4. Correct a fact",
      body: APPEAL_CORRECTION_NOTE,
      code:
        `curl -sX POST ${docs.origin}/api/v1/appeal \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -d '{"claim_id":"<claim-id>","disputed":"<signal id or change id>","argument":"..."}'`,
    },
    {
      heading: "5. Or be removed entirely",
      body: APPEAL_REMOVAL_NOTE,
      code:
        `curl -sX POST ${docs.origin}/api/v1/appeal \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -d '{"claim_id":"<claim-id>","remedy":"removal","disputed":"listing","argument":"..."}'`,
    },
  ];

  const body =
    html`<p class="card-lead">${APPEAL_INTRO}</p>` +
    steps
      .map(
        (step) =>
          html`<h3>${step.heading}</h3>
            <p>${step.body}</p>` + (step.code ? codeBlock({ code: step.code, copy: true }) : ""),
      )
      .join("\n");

  return resultCard({
    id: "claim",
    title: APPEAL_HEADING,
    body,
    footer:
      `You can also stop us without talking to us at all — robots.txt, or a file at ` +
      `${escapeHtml(docs.optoutWellKnown)}. <a href="/crawler">What the crawler does, and how to stop it</a>.`,
  });
}

export function methodologyPage(opts: MethodologyPageOptions): string {
  const { data, docs } = opts;

  const overview = resultCard({
    id: "what-it-is",
    title: NOT_A_VERDICT_HEADING,
    badge: statusPill(`score version ${data.score_version}`, "info"),
    body:
      html`<p class="card-lead">${ABOVE_THE_FOLD}</p>` +
      html`<h3>${RULE_ONE_HEADING}</h3>
        <p>${RULE_ONE}</p>
        <h3>${RULE_TWO_HEADING}</h3>
        <p>${RULE_TWO}</p>
        <p>${NO_SCORE_NOTE}</p>`,
    footer: GENERATED_NOTE,
  });

  const signals = resultCard({
    id: "signals",
    title: SIGNALS_HEADING,
    aside: `${data.signals.length} signals · ${data.total_available_weight} total weight`,
    body: signalsTable(data) + messagesTable(data),
    footer:
      "Severity does not change the arithmetic — the weight already carries that. It tells a renderer how " +
      "to phrase the finding.",
  });

  const arithmetic = resultCard({
    id: "arithmetic",
    title: ARITHMETIC_HEADING,
    body:
      codeBlock({ code: data.formula, label: "score" }) +
      html`<h3>${BANDS_HEADING}</h3>` +
      kvTable(
        data.bands.map((b) => ({
          label: b.band,
          valueHtml: escapeHtml(bandRange(b.from, b.to)),
          note: undefined,
        })),
        "Band thresholds",
      ) +
      html`<h3>${COVERAGE_HEADING}</h3>
        <p>
          If the observed signals account for less than ${data.coverage_floor_percent}% of the
          ${data.total_available_weight} available weight, the band is held at MEDIUM even when the score is
          high, and a <code>coverage</code> row is added to <code>reasons[]</code> saying so. The floor never
          lowers a score — it constrains the band only, so “unknown is not bad” still holds.
        </p>
        <h3>${MAGNITUDE_HEADING}</h3>
        <p>
          Computed in whole units of the asset. An unknown <code>decimals</code> means an unknown band, never
          a guessed one.
        </p>` +
      kvTable(
        data.magnitude_examples.map((m) => ({
          label: `${m.whole_units} whole units`,
          value: m.band,
        })),
        "Amount magnitude bands",
      ),
  });

  const reproduce = resultCard({
    id: "reproduce",
    title: "Reproducing a score yourself",
    body:
      html`<p class="card-lead">${REPRODUCE_NOTE}</p>` +
      codeBlock({
        code:
          `curl -sH 'Accept: application/json' \\\n` +
          `  '${docs.origin}/api/v1/inspect?url=https://api.example.com/v1/geocode' \\\n` +
          `  | jq '[.data.risk.reasons[] | select(.status != "skip")]\n` +
          `        | (map(select(.status == "pass") | .weight) | add) / (map(.weight) | add) * 100 | round'`,
        label: "Redo our arithmetic",
        copy: true,
      }),
  });

  const examples = resultCard({
    id: "examples",
    title: EXAMPLES_HEADING,
    body: html`<p class="card-lead">${EXAMPLES_NOTE}</p>`,
  });

  const versioning = resultCard({
    id: "versioning",
    title: VERSION_HEADING,
    body:
      html`<p class="card-lead">${VERSION_NOTE}</p>` +
      kvTable([
        { label: "This version", value: data.score_version },
        { label: "Total available weight", value: String(data.total_available_weight) },
        { label: "Signals scored", value: String(data.signals.length) },
        {
          label: "Source of truth",
          valueHtml: html`<a href="${data.source_url}">spec/risk-score.md</a>`,
        },
      ]),
  });

  return page({
    title: META.title,
    description: META.description,
    path: opts.path ?? META.path,
    observationNote: true,
    body: [
      pageHead(META.h1, LEDE),
      overview,
      signals,
      arithmetic,
      examples,
      ...data.worked_examples.map(exampleCard),
      reproduce,
      claimCard(docs),
      versioning,
    ].join("\n"),
  });
}
