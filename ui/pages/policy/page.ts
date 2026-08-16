/**
 * The 402 Policy Playground page.
 *
 * Composed entirely from `ui/components/*` and `ui/tokens.css`:
 * no new colour, no framework, no build step. The page is a single
 * `method="GET"` form, so **submitting it produces the permalink** and the
 * whole tool works with JavaScript switched off.
 *
 * The layout has one job. SPEC §5.3 freezes the evaluation stages *and their
 * order*, and says showing that order is the teaching moment of the tool — so
 * the ladder is the middle column, at full height, with the policy on one side
 * and the challenge on the other. It is not a footnote under a verdict.
 */

import {
  codeBlock,
  html,
  join,
  jsonBlock,
  kvTable,
  page,
  pageHead,
  raw,
  statusPill,
  toneForCheck,
} from "../../components/index.js";
import { TOOLS } from "../../tool-meta.js";
import { PRESETS } from "./presets.js";
import { curlSnippet, pythonSnippet, typescriptSnippet } from "./snippets.js";
import { STAGE_LABELS, STAGES } from "./types.js";
import type { EvaluationStep, PolicyData, PolicyRequest, Stage } from "./types.js";

const DOCS = "https://docs.tx402.io/guides/policy/";

export interface PolicyPageOptions {
  input: PolicyRequest;
  outcome: {
    data: PolicyData;
    warnings: { code: string; message: string }[];
    decoded: { requirements: readonly RequirementLike[]; resource: { url: string; method: string } } | null;
    resolvedRequestUrl: string | null;
  };
  envelope: unknown;
  permalink: string;
  presetId: string | null;
  presetName: string | null;
  path: string;
  challengeText: string;
  generatedAt: string;
}

interface RequirementLike {
  index: number;
  scheme: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

// ── page-local styles ────────────────────────────────────────────────────
// Every colour is a token. `pnpm gate:tokens` scans <style> blocks in.ts
// files, so a raw hex here fails the build — which is the point.
const STYLES = `
.pg-strip {
  display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); align-items: baseline;
  padding: var(--s3) var(--s4); margin-bottom: var(--s5);
  border: 1px solid var(--border); border-radius: var(--r);
  background: var(--surface-2); font-size: .85rem; color: var(--text-muted);
}
.pg-strip code { font-family: var(--mono); color: var(--text); }

.pg-grid { display: grid; gap: var(--s5); grid-template-columns: minmax(0, 1fr); align-items: start; }

/* Stacked, the verdict goes FIRST: a verdict below a two-screen form is a
   verdict nobody reads. In DOM order it is the second child, so it takes a
   negative order to climb above the policy inputs.

   THIS RULE MUST STAY ABOVE THE MEDIA QUERY. A media query adds no
   specificity, so when this sat below the block it beat the "order: 0"
   inside it at every width — and the ladder, which SPEC §5.3 makes the point
   of the page, spent every desktop width in the 276px column while the form
   it explains had 487px. The two rules are the same specificity and only
   source order separates them. */
.pg-verdict-col { order: -1; }

/* Three columns: inputs, the ladder, the challenge they are evaluated
   against. The ladder is the output and gets the widest column; the two
   inputs flank it and are sized to their content — a column of short fields
   on the left, a decoded challenge on the right. Wide enough that none of
   the three has to break a hostname mid-word. */
@media (min-width: 64rem) {
  .pg-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); }
  .pg-verdict-col { order: 0; }
}
.pg-panel {
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface); padding: var(--s5);
}
.pg-panel > h2 { margin: 0 0 var(--s4); font-size: 1rem; letter-spacing: -.01em; }
.pg-panel > h3 {
  margin: var(--s5) 0 var(--s3); font-size: .8rem; text-transform: uppercase;
  letter-spacing: .06em; color: var(--text-faint);
}

.pg-field { margin-bottom: var(--s4); }
.pg-field label { display: block; font-size: .8rem; font-weight: 600; color: var(--text-muted); margin-bottom: var(--s2); }
.pg-field .pg-note { margin: var(--s2) 0 0; font-size: .76rem; color: var(--text-faint); }
.pg-field textarea.field { min-height: 16rem; font-size: .8rem; }
.pg-pair { display: grid; gap: var(--s3); grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }

.pg-verdict {
  border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface);
  overflow: hidden; box-shadow: var(--shadow-sm), inset 0 1px 0 var(--edge);
}
/* The decision is the answer, so it is set as one — the word on its own
   line at display size, the sentence under it. Side by side at 1.5rem the
   verdict and its explanation carried the same weight, and the eye had to
   pick. */
.pg-decision {
  display: grid; gap: var(--s2); padding: var(--s5);
  border-bottom: 1px solid var(--border);
}
.pg-decision strong {
  font-size: var(--fs-2xl); line-height: 1.1;
  letter-spacing: var(--tr-wide); font-weight: 700;
}
.pg-decision-allow { background: var(--ok-soft); }
.pg-decision-allow strong { color: var(--ok); }
.pg-decision-deny { background: var(--err-soft); }
.pg-decision-deny strong { color: var(--err); }
.pg-decision p { margin: 0; font-size: var(--fs-cap); line-height: var(--lh-snug); color: var(--text-muted); max-width: 52ch; }

/* The ladder.

   These are sequential stages, and each one runs only because the stage
   above it passed — the whole point of SPEC §5.3 is the ORDER, and where in
   that order a policy stopped. Drawn as a flat list with a coloured left
   edge it said "here are eight items, three of them are green". Drawn as a
   ladder — one node per stage on a connector, the node coloured by what the
   stage did — it says "these ran in this order and this is where it
   stopped", which is the question the page exists to answer. */
.stages { list-style: none; margin: 0; padding: var(--s5) var(--s5) var(--s5) var(--s4); }
.stg {
  position: relative;
  display: grid; grid-template-columns: 1.75rem minmax(0, 1fr) auto; gap: var(--s1) var(--s3);
  align-items: center; padding: 0 0 var(--s5) var(--s2);
}
.stg:last-child { padding-bottom: 0; }

/* The connector is drawn per stage rather than once down the whole list, so
   it ends at the last node instead of running past it into the padding. */
.stg:not(:last-child)::before {
  content: '';
  position: absolute;
  left: calc(var(--s2) + .875rem);
  top: 1.75rem;
  bottom: 0;
  width: 1px;
  margin-left: -.5px;
  background: var(--border-strong);
}

.stg-n {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.75rem; height: 1.75rem; border-radius: 50%;
  background: var(--surface-3); border: 1px solid var(--border-strong);
  font-family: var(--mono); font-size: var(--fs-micro); font-weight: 600;
  color: var(--text-faint);
}
.stg-name { font-weight: 600; font-size: var(--fs-base); letter-spacing: var(--tr-snug); }
.stg-detail { grid-column: 2 / -1; margin: 0; font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }
.stg-checks { grid-column: 2 / -1; margin: 0; font-size: var(--fs-xs); color: var(--text-faint); }

.stg-pass .stg-n { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.stg-fail .stg-n { background: var(--err-soft); border-color: transparent; color: var(--err); }
.stg-fail .stg-name { color: var(--err); }
/* The tint goes on the REASON, not on the whole row. On the row it was a
   tall block of colour whose bottom half was the gap before the next stage;
   on the detail it marks the one sentence that says why this was refused. */
.stg-fail .stg-detail {
  padding: var(--s2) var(--s3);
  border-radius: var(--r-sm);
  background: var(--err-soft);
  color: var(--text);
}
.stg-skip .stg-n { opacity: .5; }
.stg-skip .stg-name { color: var(--text-faint); }

.pg-error { margin: 0 var(--s4) var(--s4); border: 1px solid var(--err); border-radius: var(--r); overflow: hidden; }
.pg-error-head { padding: var(--s3) var(--s4); background: var(--err-soft); font-family: var(--mono); font-size: .82rem; color: var(--text); overflow-wrap: anywhere; }
.pg-error-body { padding: var(--s3) var(--s4); font-size: .85rem; color: var(--text-muted); }
.pg-error-body p { margin: 0 0 var(--s2); }

.pg-actions { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; margin-top: var(--s5); }
/* Eleven presets is a lot of pills to put above the fold, so they are set as
   a toolbar: one surface, hairline separated from the page, with the chips
   quiet until hovered and only the selected one carrying colour. */
.pg-presets {
  display: flex; flex-wrap: wrap; gap: var(--s2); margin: 0 0 var(--s3);
  padding: var(--s3); list-style: none;
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface-2);
}
.pg-preset {
  display: inline-block; padding:.35rem var(--s3);
  border: 1px solid transparent; border-radius: var(--r-pill);
  font-size: var(--fs-sm); font-weight: 500; color: var(--text-muted); text-decoration: none;
  transition: color var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}
.pg-preset:hover { background: var(--surface); border-color: var(--border-strong); color: var(--text); text-decoration: none; }
.pg-preset[aria-current="true"] { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.pg-preset-blurb { margin: 0 0 var(--s5); font-size: var(--fs-cap); color: var(--text-muted); max-width: var(--measure); }

.pg-offered { margin-top: var(--s5); }
.pg-offered h3 { margin: 0 0 var(--s3); font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); }
.pg-warnings { margin: var(--s4) 0 0; padding: 0; list-style: none; font-size: .84rem; color: var(--text-muted); }
.pg-warnings li + li { margin-top: var(--s2); }
.pg-warnings code { font-family: var(--mono); font-size: .78rem; color: var(--text-faint); }
`;

// ── pieces ───────────────────────────────────────────────────────────────

function field(opts: {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  note?: string;
  multiline?: boolean;
}): string {
  const id = `pg-${opts.name}`;
  const control = opts.multiline
    ? html`<textarea class="field" id="${id}" name="${opts.name}" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="${opts.placeholder ?? ""}">
${opts.value}</textarea
      >`
    : html`<input
        class="field"
        id="${id}"
        name="${opts.name}"
        type="text"
        value="${opts.value}"
        placeholder="${opts.placeholder ?? ""}"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
      />`;

  return html`<div class="pg-field">
    <label for="${id}">${opts.label}</label>
    ${raw(control)}
    ${raw(opts.note ? html`<p class="pg-note">${opts.note}</p>` : "")}
  </div>`;
}

function select(opts: { name: string; label: string; value: string; options: [string, string][]; note?: string }): string {
  const id = `pg-${opts.name}`;
  const items = opts.options.map(
    ([value, label]) =>
      html`<option value="${value}"${raw(value === opts.value ? " selected" : "")}>${label}</option>`,
  );
  return html`<div class="pg-field">
    <label for="${id}">${opts.label}</label>
    <select class="field" id="${id}" name="${opts.name}">
      ${join(items)}
    </select>
    ${raw(opts.note ? html`<p class="pg-note">${opts.note}</p>` : "")}
  </div>`;
}

function stageRow(step: EvaluationStep, position: number): string {
  const label = STAGE_LABELS[step.stage];
  return html`<li class="stg stg-${step.result}">
    <span class="stg-n" aria-hidden="true">${position}</span>
    <span class="stg-name">${label.title}</span>
    ${raw(statusPill(step.result, toneForCheck(step.result), `${label.title}:`))}
    <p class="stg-detail">${step.detail ?? "—"}</p>
    <p class="stg-checks">${label.checks}</p>
  </li>`;
}

function verdict(data: PolicyData): string {
  const allow = data.decision === "allow";
  const firing = data.evaluation.find((s) => s.result === "fail");
  const headline = allow
    ? "Every stage this policy runs passed. A client would go on to plan a route and reserve the spend."
    : firing
      ? `Refused at stage ${STAGES.indexOf(firing.stage) + 1} of ${STAGES.length}. Nothing after it was evaluated.`
      : "Refused before the stages ran, so none of them were reached.";

  const rows = data.evaluation.map((step, i) => stageRow(step, i + 1));

  const error = data.error;
  const errorBlock = error
    ? html`<div class="pg-error">
        <div class="pg-error-head">
          <strong>${error.name}</strong> · <code>${error.code}</code>
        </div>
        <div class="pg-error-body">
          <p>${error.message}</p>
          ${raw(
            error.details && Object.keys(error.details).length > 0
              ? jsonBlock(error.details, "error.details")
              : "",
          )}
          <p class="small faint">
            This is the exception object the SDK constructs, with its own class name, its own
            <code>TX402_ERROR_CODES</code> member and its own details — not a description of one.
          </p>
        </div>
      </div>`
    : "";

  return html`<section class="pg-verdict" id="verdict" aria-label="Verdict">
    <div class="pg-decision ${allow ? "pg-decision-allow" : "pg-decision-deny"}">
      <strong>${allow ? "ALLOW" : "DENY"}</strong>
      <p>${headline}</p>
    </div>
    <ol class="stages">
      ${join(rows)}
    </ol>
    ${raw(errorBlock)}
  </section>`;
}

function policyColumn(input: PolicyRequest): string {
  const p = input.policy;
  const recipient = p.recipientPolicy ?? {};
  const routing = p.routing ?? {};
  const pins = (recipient.allow ?? [])
    .map((entry) => `${entry.host}|${entry.network}|${entry.recipients.join(",")}`)
    .join(";");

  return html`<section class="pg-panel" aria-label="Policy">
    <h2>Policy</h2>
    ${raw(
      field({
        name: "max_per_request",
        label: "maxPerRequest",
        value: p.maxPerRequest ?? "",
        placeholder: "0.10 USDC",
        note: "Always “<decimal> <SYMBOL>”. Atomic units are refused — and appending the symbol to one is a cap a million times larger.",
      }),
    )}
    ${raw(field({ name: "max_per_hour", label: "maxPerHour", value: p.maxPerHour ?? "", placeholder: "5.00 USDC" }))}
    ${raw(
      field({
        name: "max_total",
        label: "maxTotal",
        value: p.maxTotal ?? "",
        placeholder: "empty — no lifetime ceiling",
        note: "Opt-in. maxTotal ≥ maxPerHour ≥ maxPerRequest, or the client refuses to construct.",
      }),
    )}
    ${raw(
      field({
        name: "domains",
        label: "allowedDomains",
        value: (p.allowedDomains ?? []).join(","),
        placeholder: "api.example.com,*.trusted.dev",
        note: "Comma separated. “*” allows every host.",
      }),
    )}
    ${raw(
      field({
        name: "networks",
        label: "allowedNetworks",
        value: (p.allowedNetworks ?? []).join(","),
        placeholder: "eip155:8453",
        note: "CAIP-2 ids, comma separated. Resolved through the signed release manifest, so an alias or a typo fails at construction.",
      }),
    )}
    ${raw(field({ name: "attempts", label: "maxPaidAttempts", value: p.maxPaidAttempts === undefined ? "" : String(p.maxPaidAttempts), placeholder: "2" }))}

    <h3>Recipient pinning</h3>
    ${raw(
      select({
        name: "recipient_mode",
        label: "recipientPolicy.mode",
        value: recipient.mode ?? "off",
        options: [
          ["off", "off — the stage does not run"],
          ["allowlist", "allowlist — only these payout addresses"],
          ["tofu", "tofu — first address seen wins (needs a shared store)"],
        ],
      }),
    )}
    ${raw(
      field({
        name: "pin",
        label: "recipientPolicy.allow",
        value: pins,
        placeholder: "api.example.com|eip155:8453|0x…",
        note: "host|network|recipient,recipient — separate entries with “;”.",
      }),
    )}

    <h3>Routing</h3>
    ${raw(
      field({
        name: "prefer",
        label: "routing.preferNetworks",
        value: (routing.preferNetworks ?? []).join(","),
        placeholder: "eip155:8453",
        note: "A tie-break only. Listing a network here cannot make it payable.",
      }),
    )}
    ${raw(field({ name: "quote_age_ms", label: "routing.maxQuoteAgeMs", value: routing.maxQuoteAgeMs === undefined ? "" : String(routing.maxQuoteAgeMs), placeholder: "5000" }))}
  </section>`;
}

function challengeColumn(opts: PolicyPageOptions): string {
  const { input, challengeText, outcome } = opts;
  const decoded = outcome.decoded;

  const offered = (decoded?.requirements ?? []).map((r, i) =>
    kvTable(
      [
        { label: "scheme", value: r.scheme },
        { label: "network", value: r.network },
        { label: "asset", value: r.asset },
        { label: "amount", value: `${r.amountAtomic} atomic` },
        { label: "payTo", value: r.payTo },
        { label: "maxTimeoutSeconds", value: r.maxTimeoutSeconds },
      ],
      `Offered requirement ${i + 1}`,
    ),
  );

  return html`<section class="pg-panel" aria-label="Challenge">
    <h2>Challenge</h2>
    ${raw(
      field({
        name: "challenge",
        label: "The 402 the merchant returned",
        value: challengeText,
        multiline: true,
        note: "Paste the decoded JSON, or a base64 PAYMENT-REQUIRED header. It is decoded by decodePaymentRequired from tx402 — the same strict decoder that would refuse the payment.",
      }),
    )}
    <div class="pg-pair">
      ${raw(field({ name: "url", label: "Request URL", value: input.request?.url ?? "", placeholder: "defaults to the challenge's resource" }))}
      ${raw(field({ name: "method", label: "Method", value: input.request?.method ?? "", placeholder: "GET" }))}
    </div>

    <h3>Spend already on the ledger</h3>
    <div class="pg-pair">
      ${raw(field({ name: "spent_window", label: "Last hour (atomic)", value: input.state?.spent_in_window_atomic ?? "0", placeholder: "0" }))}
      ${raw(field({ name: "spent_total", label: "Lifetime (atomic)", value: input.state?.spent_total_atomic ?? "0", placeholder: "0" }))}
    </div>
    <p class="pg-note">
      Atomic units — USDC has six decimals, so 1.90 USDC is 1900000. These are replayed through the SDK's own
      ledger, so the rolling hour and the lifetime total are computed by tx402, not by this page.
    </p>

    ${raw(
      offered.length > 0
        ? html`<div class="pg-offered">
            <h3>What the challenge offers</h3>
            ${join(offered)}
          </div>`
        : "",
    )}
  </section>`;
}

function presetRow(presetId: string | null): string {
  const items = PRESETS.map(
    (preset) =>
      html`<li>
        <a class="pg-preset" href="/policy?preset=${preset.id}"${raw(preset.id === presetId ? ' aria-current="true"' : "")}
          >${preset.name}</a
        >
      </li>`,
  );
  const current = PRESETS.find((p) => p.id === presetId);
  return html`<ul class="pg-presets">
      ${join(items)}
    </ul>
    ${raw(current ? html`<p class="pg-preset-blurb">${current.blurb}</p>` : "")}`;
}

function takeaway(opts: PolicyPageOptions): string {
  const { input, permalink } = opts;
  return html`<section class="card" id="take-it-away">
    <header><h2>Take it away</h2></header>
    <div class="card-body">
      <p class="muted small">
        This configuration, as the client constructor in each language. Both are the shapes in the
        <a href="${DOCS}">policy guide</a> — <code>recipientPolicy</code> and <code>routing</code> are siblings of
        <code>policy</code> there, which is where they belong in your code.
      </p>
      ${raw(codeBlock({ code: typescriptSnippet(input), label: "TypeScript", copy: true }))}
      ${raw(codeBlock({ code: pythonSnippet(input), label: "Python", copy: true }))}
      ${raw(codeBlock({ code: curlSnippet(input), label: "The same verdict from the API", copy: true }))}
      ${raw(codeBlock({ code: `https://tools.tx402.io${permalink}`, label: "Permalink — the whole config is in the URL", copy: true }))}
    </div>
  </section>`;
}

// ── the page ─────────────────────────────────────────────────────────────

export function policyPage(opts: PolicyPageOptions): string {
  const { outcome, envelope, presetId, path } = opts;
  const data = outcome.data;

  const warnings =
    outcome.warnings.length === 0
      ? ""
      : html`<ul class="pg-warnings">
          ${join(
            outcome.warnings.map(
              (w) => html`<li><code>${w.code}</code> — ${w.message}</li>`,
            ),
          )}
        </ul>`;

  const body = html`
    ${raw(pageHead(TOOLS.policy.h1, TOOLS.policy.description))}

    <div class="pg-strip">
      <span><strong>This is the real engine.</strong></span>
      <span>tx402 <code>${data.tx402_version ?? "unknown"}</code></span>
      <span><code>${data.engine}</code>, server-side</span>
      <span>signed release manifest</span>
      <span><a href="${DOCS}">Read the policy guide →</a></span>
    </div>

    ${raw(presetRow(presetId))}

    <form class="pg-grid" method="GET" action="/policy">
      ${raw(policyColumn(opts.input))}
      <div class="pg-verdict-col">
        ${raw(verdict(data))}
        <div class="pg-actions">
          <button class="btn" type="submit">Evaluate</button>
          <a class="btn btn-secondary" href="/policy?preset=default">Reset</a>
        </div>
        ${raw(warnings)}
      </div>
      ${raw(challengeColumn(opts))}
    </form>

    ${raw(takeaway(opts))}

    <section class="card" id="json">
      <header><h2>The same answer as JSON</h2></header>
      <div class="card-body">
        <p class="muted small">
          Every surface reads this one contract — <code>spec/schemas/policy.json</code>. Add
          <code>Accept: application/json</code> or <code>Accept: text/markdown</code> to this URL and you get the
          same verdict in the shape you asked for.
        </p>
        ${raw(jsonBlock(envelope, "GET /policy — Accept: application/json"))}
      </div>
    </section>
  `;

  return page({
    title: TOOLS.policy.title,
    description: TOOLS.policy.description,
    path,
    head: `<style>${STYLES}</style>`,
    body,
  });
}

export type { Stage };
