/**
 * The `/verify` page.
 *
 * A **secondary** surface, and deliberately so: SPEC §5.2 and both
 * put the API and the CLI first, because you verify a challenge at the moment
 * you are about to sign it and that moment is in code, not in a browser tab.
 * The page exists so a human can paste something once and read a straight
 * answer, and so the tool is linkable.
 *
 * Everything is composed from `ui/components/`; no colour is defined here and
 * `pnpm gate:tokens` enforces that. All copy comes from `ui/tool-meta.ts`.
 *
 * ── The one thing this page must get right ────────────────────────────────
 *
 * **Which checks ran offline and which needed our data has to be visible**,
 * not buried. It is the product boundary, it is the SDK's
 * no-backend promise made legible (L4), and it is what tells a reader whether
 * a `skip` means "your challenge did not say" or "we have never seen this
 * endpoint". So the report is split into two labelled sections rather than one
 * list with a column, and the section that needs our data says plainly that it
 * is empty and why.
 */

import {
  codeBlock,
  emptyState,
  html,
  join,
  kvTable,
  page,
  pageHead,
  raw,
  resultCard,
  statusPill,
  toneForBand,
  toneForCheck,
  when,
  type KvRow,
} from "../../components/index.js";
import { TOOLS } from "../../tool-meta.js";
import { CHECK_LABELS, VERDICT_LABEL, VERDICT_SUMMARY, type Check, type VerifyData } from "./types.js";

export interface VerifyPageInput {
  challenge: { header?: string | null; body?: unknown; raw?: string | null };
  context: { url?: string | null; expected_origin?: string | null } | null;
  options: { enrich: boolean };
}

export interface VerifyPageOptions {
  outcome: { data: VerifyData; warnings: { code: string; message: string }[] } | null;
  envelope: unknown;
  input: VerifyPageInput | null;
  path: string;
}

const OFFLINE_HEADING = "Checked offline";
const HOSTED_HEADING = "Checked against our data";

export function verifyPage(opts: VerifyPageOptions): string {
  const pasted =
    opts.input?.challenge.raw ??
    opts.input?.challenge.header ??
    (typeof opts.input?.challenge.body === "string" ? opts.input.challenge.body : "") ??
    "";

  const body = html`
    ${raw(pageHead(TOOLS.verify.h1, TOOLS.verify.description))}
    ${raw(form(pasted, opts.input?.context?.url ?? ""))}
    ${raw(opts.outcome ? report(opts.outcome, opts.envelope) : intro())}
  `;

  return page({
    title: TOOLS.verify.title,
    description: TOOLS.verify.description,
    body,
    path: opts.path,
    // the "these are observations, not accusations" note is
    // above the fold on every surface that renders a band.
    observationNote: true,
  });
}

function form(challenge: string, url: string): string {
  return html`
    <form class="paste-box" action="/verify" method="GET">
      <label for="field-challenge">Paste an x402 challenge</label>
      <div class="field-wrap">
        <textarea
          class="field"
          id="field-challenge"
          name="challenge"
          rows="6"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="eyJ4NDAyVmVyc2lvbiI6Miwi…  — or the v1 JSON body, starting with {"
        >
${challenge}</textarea
        >
      </div>
      <label for="field-url">Endpoint URL (optional)</label>
      <div class="row">
        <div class="field-wrap">
          <input
            class="field"
            id="field-url"
            name="url"
            type="text"
            value="${url}"
            placeholder="https://api.example.com/v1/geocode"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            autocomplete="off"
          />
        </div>
        <button class="btn" type="submit">Verify</button>
      </div>
      <p class="hint">
        Either wire form works: the base64 <code>PAYMENT-REQUIRED</code> header value, or the legacy v1
        JSON body. Without the endpoint URL we cannot compare the challenge's resource origin against
        it, and that check reports <em>skipped</em> rather than passed.
      </p>
    </form>
  `;
}

function intro(): string {
  return html`
    ${raw(
      resultCard({
        title: "Two kinds of check, and the difference matters",
        body: html`
          <p>
            <strong>${OFFLINE_HEADING}</strong> runs entirely on the challenge you paste: the strict x402
            decoder from <code>tx402</code>, the signed release manifest, and the published facilitator
            list. It needs nothing from us and nothing from the endpoint.
            <a href="https://www.npmjs.com/package/tx402-tools">The CLI runs the same function locally</a>
            and sends nothing anywhere — the <code>tx402</code> SDK has no backend, and that stays true.
          </p>
          <p>
            <strong>${HOSTED_HEADING}</strong> compares the challenge against what we have observed for
            this endpoint before. It needs our corpus, so it is a separate, explicit request
            (<code>options.enrich</code>). When we have no history, those checks report
            <em>no data</em> — never a pass. A missing history is unknown, not clean.
          </p>
        `,
      }),
    )}
    ${raw(
      resultCard({
        title: "The API is the primary surface",
        body: html`<p>
          You verify a challenge at the moment you are about to sign it, which is in code.
        </p>`,
        footer: codeBlock({
          label: "curl",
          code: `curl -s https://tools.tx402.io/api/v1/verify \\
  -H 'content-type: application/json' \\
  -d '{"challenge":{"header":"eyJ4NDAyVmVyc2lvbiI6Mi…"},
       "context":{"url":"https://api.example.com/v1/geocode"}}'`,
        }),
      }),
    )}
  `;
}

function report(
  outcome: { data: VerifyData; warnings: { code: string; message: string }[] },
  envelopeBody: unknown,
): string {
  const { data } = outcome;
  const offline = data.checks.filter((c) => c.offline);
  const hosted = data.checks.filter((c) => !c.offline);

  return html`
    ${raw(verdictCard(data))}
    ${raw(challengeCard(data))}
    ${raw(
      resultCard({
        title: OFFLINE_HEADING,
        badge: `${offline.filter((c) => c.status === "pass").length}/${offline.length} passed`,
        aside: "No network. These run identically in the CLI, on your machine.",
        body: checkTable(offline),
      }),
    )}
    ${raw(
      resultCard({
        title: HOSTED_HEADING,
        badge: data.enrichment ? "requested" : "not requested",
        aside: "These need the endpoint's history, so they are a separate, explicit request.",
        body: hostedBody(data, hosted),
      }),
    )}
    ${raw(riskCard(data))}
    ${raw(
      resultCard({
        title: "The full response",
        aside: "The same object the API returns. Every verdict on this page is reproducible from it.",
        // Collapsed by default. Rendering the whole envelope inline made the
        // page an order of magnitude taller than the report it exists to show,
        // and the report is what a reader came for — the JSON is here so they
        // can check our work, not so they have to scroll past it.
        body: html`<details class="response-json">
          <summary>Show the JSON</summary>
          ${raw(codeBlock({ code: JSON.stringify(envelopeBody, null, 2), label: "JSON" }))}
        </details>`,
      }),
    )}
    ${raw(warningsBlock(outcome.warnings))}
  `;
}

function verdictCard(data: VerifyData): string {
  const counts = {
    pass: data.checks.filter((c) => c.status === "pass").length,
    warn: data.checks.filter((c) => c.status === "warn").length,
    fail: data.checks.filter((c) => c.status === "fail").length,
    skip: data.checks.filter((c) => c.status === "skip").length,
  };

  return resultCard({
    title: "Verdict",
    badge: VERDICT_LABEL[data.verdict],
    body: html`
      <p>${VERDICT_SUMMARY[data.verdict]}</p>
      <p class="hint">
        ${String(counts.pass)} passed · ${String(counts.warn)} warned · ${String(counts.fail)} failed ·
        ${String(counts.skip)} could not be run. A check that could not run is never counted as a pass.
      </p>
    `,
  });
}

function challengeCard(data: VerifyData): string {
  const challenge = data.challenge;
  if (!challenge) {
    return resultCard({
      title: "The challenge",
      body: emptyState({
        title: "Nothing to read",
        body: "No challenge was supplied, so there was nothing to decode.",
      }),
    });
  }

  const requirement = challenge.accepts[0] ?? null;
  const rows: KvRow[] = [
    { label: "Wire form", value: challenge.wire_form },
    { label: "x402 version", value: challenge.x402_version },
    {
      label: "Decodes with tx402",
      value: challenge.valid ? "yes" : "no",
      note: challenge.valid
        ? "Decoded by the same strict decoder the SDK runs before it pays."
        : challenge.decode_error?.message,
    },
    { label: "Requirements offered", value: challenge.requirement_count },
    { label: "Size", value: challenge.raw_bytes === null ? null : `${challenge.raw_bytes} bytes` },
  ];

  if (requirement) {
    rows.push(
      { label: "Network", value: requirement.network },
      { label: "Amount", value: requirement.amount_decimal ?? requirement.amount_raw },
      { label: "Amount (atomic)", value: requirement.amount_atomic },
      { label: "Recipient", value: requirement.pay_to },
      { label: "Resource", value: requirement.resource },
    );
  }

  return resultCard({
    title: "The challenge",
    badge: challenge.valid ? "decodes" : "refused by the decoder",
    //. decision 6: a refused challenge exposes no accepted
    // requirements, so the terms shown for one are explicitly the parsed view.
    aside: challenge.valid
      ? undefined
      : "tx402 refused this challenge, so the terms below are what we could read, not terms it accepted.",
    body: kvTable(rows),
  });
}

function checkTable(checks: Check[]): string {
  if (checks.length === 0) {
    return emptyState({ title: "Nothing ran", body: "No checks were run." });
  }

  const rows = checks.map(
    (check) => html`
      <tr>
        <td>${raw(statusPill(check.status, toneForCheck(check.status)))}</td>
        <td>
          <code>${check.id}</code>
          <div class="hint">${CHECK_LABELS[check.id] ?? ""}</div>
        </td>
        <td>${raw(check.detail ? html`<span class="hint">${check.detail}</span>` : "")}</td>
      </tr>
    `,
  );

  return html`
    <table class="kv check-table">
      <thead>
        <tr>
          <th scope="col">Result</th>
          <th scope="col">Check</th>
          <th scope="col">What we saw</th>
        </tr>
      </thead>
      <tbody>
        ${raw(join(rows).toString())}
      </tbody>
    </table>
  `;
}

function hostedBody(data: VerifyData, hosted: Check[]): string {
  if (!data.enrichment) {
    return html`
      ${raw(
        emptyState({
          title: "Not requested",
          body: "These checks read our corpus, so they only run when you ask for them.",
          detail:
            "Send options.enrich: true to POST /api/v1/verify. The offline verdict above does not change either way.",
        }),
      )}
      ${raw(checkTable(hosted))}
    `;
  }

  const known = data.enrichment.endpoint_known;
  return html`
    ${raw(
      known
        ? ""
        : emptyState({
            title: "No history yet",
            body: "We have no record of this endpoint.",
            detail:
              "That is the normal state for an endpoint nobody has scanned, and it is not a finding either way. It is reported as no data, never as a pass.",
          }),
    )}
    ${raw(checkTable(hosted))}
  `;
}

function riskCard(data: VerifyData): string {
  const risk = data.risk;
  if (!risk) {
    return resultCard({
      title: "Signals",
      body: emptyState({
        title: "Nothing to score",
        body: "No x402 challenge was supplied, so there was nothing to assess.",
      }),
    });
  }

  const reasons = risk.reasons.map(
    (reason) => html`
      <tr>
        <td>${raw(statusPill(reason.status, toneForCheck(reason.status)))}</td>
        <td><code>${reason.signal_id}</code></td>
        <td>${reason.weight === 0 ? "—" : String(reason.weight)}</td>
        <td><span class="hint">${reason.message}</span></td>
      </tr>
    `,
  );

  return resultCard({
    title: "Signals and score",
    badge: `${String(risk.score)} · ${risk.band}`,
    aside: `Scored under ${risk.score_version}. Scores are only comparable within one version.`,
    body: html`
      <p>
        ${raw(statusPill(risk.band, toneForBand(risk.band)))} describes how much of what we check we
        were able to confirm about this challenge. It is not a judgement about whoever operates the
        endpoint. Every weight below is the one applied, so the score is reproducible from this table —
        that reproducibility is the appeal mechanism.
      </p>
      <table class="kv check-table">
        <thead>
          <tr>
            <th scope="col">Result</th>
            <th scope="col">Signal</th>
            <th scope="col">Weight</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          ${raw(join(reasons).toString())}
        </tbody>
      </table>
      <p class="hint">
        <a href="${risk.methodology_url}">How this is calculated</a> · every signal, its weight and its
        rationale are published.
      </p>
    `,
  });
}

function warningsBlock(warnings: { code: string; message: string }[]): string {
  return when(
    warnings.length > 0,
    html`
      <div class="warnings">
        <h2>Notes on this answer</h2>
        <ul>
          ${raw(
            join(
              warnings.map((w) => html`<li><code>${w.code}</code> — ${w.message}</li>`),
            ).toString(),
          )}
        </ul>
      </div>
    `,
  ).toString();
}

/** Exported for the markdown mirror, so the two cannot label things differently. */
export { OFFLINE_HEADING, HOSTED_HEADING };
