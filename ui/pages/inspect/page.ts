/**
 * The Inspector page.
 *
 * This is the suite's front door: the shareable artifact, the SEO surface and
 * the funnel. It is composed entirely from `ui/components/`
 * primitives and every colour resolves through a token, so `pnpm gate:tokens`
 * stays green and seven tools do not become seven visual dialects.
 *
 * **A rendering of `InspectData`, never a second computation** (SPEC §1.2) —
 * the same view the markdown mirror takes, so the page and the report cannot
 * say different things.
 *
 * Three rules this file follows without exception:
 *
 *  - **Every string a merchant controls is escaped.** A challenge is
 *    attacker-controlled text by definition, and this page displays it.
 *  - **Copy comes from `ui/tool-meta.ts`**, not from here.
 *  - **Risk bands and reasons are printed verbatim from `score.ts`.** Nothing
 *    here restates, softens or embellishes a finding, and the words a trust
 *    tool must never use appear nowhere.
 */

import {
  codeBlock,
  emptyState,
  html,
  join,
  jsonBlock,
  kvTable,
  page,
  pageHead,
  pasteBox,
  raw,
  resultCard,
  statusPill,
  toneForBand,
  toneForCheck,
  when,
} from "../../components/index.js";
import type { KvRow } from "../../components/index.js";
import { TOOLS } from "../../tool-meta.js";
import {
  BAND_NOTE,
  NOT_X402_NOTE,
  V1_NOTE,
  isLegacyV1,
  latencyLabel,
  outcomeOf,
  priceLabel,
  termsAccepted,
  wireFormLabel,
} from "./types.js";
import type { Check, InspectView, Requirement } from "./types.js";
import { cliSnippet, curlSnippet, pythonSnippet, typescriptSnippet } from "./snippets.js";

// ── page-local styles ────────────────────────────────────────────────────
// Every colour is a token from ui/tokens.css. `pnpm gate:tokens` scans <style>
// blocks in.ts files, so a literal here fails the build — which is the point.

const STYLES = `
.verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--s4) var(--s5);
  padding: var(--s5);
  margin-bottom: var(--s5);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.verdict-main { flex: 1 1 22rem; min-width: 0; }
.verdict-price {
  margin: 0;
  font-size: clamp(1.5rem, 3.2vw, 2.1rem);
  font-weight: 650;
  letter-spacing: -.02em;
  line-height: 1.15;
  word-break: break-word;
}
.verdict-price .per { color: var(--text-faint); font-size: .5em; font-weight: 500; letter-spacing: 0; }
.verdict-url {
  display: block;
  margin-top: var(--s2);
  font-family: var(--mono);
  font-size: .85rem;
  color: var(--text-muted);
  word-break: break-all;
}
.verdict-side { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: var(--s2); }
.verdict-band { display: flex; align-items: baseline; gap: var(--s3); }
.verdict-score { font-family: var(--mono); font-size: 1.1rem; font-weight: 650; }
.verdict-meta { margin: 0; font-size: .8rem; color: var(--text-faint); }
.verdict-meta a { color: var(--text-muted); }

.ins-cols { display: grid; gap: var(--s5); grid-template-columns: 1fr; align-items: start; }
@media (min-width: 60rem) { .ins-cols { grid-template-columns: 1fr 1fr; } }
.ins-cols > .card { margin-bottom: 0; }
.ins-stack { margin-top: var(--s5); }

.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s3); }
.checks li { display: grid; grid-template-columns: auto 1fr; gap: var(--s3); align-items: baseline; }
.checks .check-id { font-family: var(--mono); font-size: .84rem; }
.checks .check-detail { display: block; color: var(--text-muted); font-size: .84rem; }
.checks .check-net { color: var(--text-faint); font-size: .74rem; text-transform: uppercase; letter-spacing: .04em; }

.reasons { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s3); }
.reasons li { display: grid; grid-template-columns: auto 3rem 1fr; gap: var(--s3); align-items: baseline; }
.reasons .weight { font-family: var(--mono); font-size: .82rem; color: var(--text-faint); text-align: right; }
.reasons .signal { display: block; font-family: var(--mono); font-size: .74rem; color: var(--text-faint); }

.note {
  border-left: 3px solid var(--accent-line);
  background: var(--accent-soft);
  border-radius: var(--r-sm);
  padding: var(--s3) var(--s4);
  color: var(--text-muted);
  font-size: .875rem;
  margin: 0 0 var(--s4);
}
.note.note-warn { border-left-color: var(--warn); background: var(--warn-soft); }

.snippets { display: grid; gap: var(--s4); }
.snippet-lede { margin: 0 0 var(--s4); color: var(--text-muted); font-size: .9rem; }

.share-form { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; }
.share-form p { margin: 0; flex: 1 1 20rem; color: var(--text-muted); font-size: .875rem; }

.example-list { margin: var(--s4) 0 0; padding-left: var(--s5); color: var(--text-muted); font-size: .9rem; }
.example-list code { font-size: .85rem; }
.mirror-list { display: flex; flex-wrap: wrap; gap: var(--s4); font-size: .82rem; }

.warnings { list-style: none; margin: 0 0 var(--s5); padding: 0; display: grid; gap: var(--s2); }
.warnings li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--s3);
  align-items: baseline;
  padding: var(--s2) var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: .84rem;
}
.warnings code { font-size: .78rem; color: var(--text-faint); }
`;

// ── small pieces ──────────────────────────────────────────────────────────

function cachedBadge(view: InspectView): string {
  if (!view.envelope.meta.cached) return "";
  const age = view.envelope.meta.cache_age_seconds ?? 0;
  return statusPill(`cached ${age}s ago`, "info", "Served from the politeness cache,");
}

function bandPill(view: InspectView): string {
  const risk = view.data.risk;
  if (risk === null) return statusPill("not an x402 endpoint", "unknown", "Risk band:");
  return statusPill(risk.band, toneForBand(risk.band), "Risk band:");
}

function verdict(view: InspectView): string {
  const { data } = view;
  const outcome = outcomeOf(data);
  const price = priceLabel(data.terms);

  const headline =
    outcome === "not_x402"
      ? html`<h2 class="verdict-price">No x402 challenge</h2>`
      : outcome === "malformed" && !termsAccepted(data)
        ? html`<h2 class="verdict-price">
            ${price ?? "Terms not parsed"} <span class="per">as served — decoder refused</span>
          </h2>`
        : html`<h2 class="verdict-price">
            ${price ?? "Price not parsed"} <span class="per">per request</span>
          </h2>`;

  const observedAt = data.probe?.observed_at ?? null;

  return html`<section class="verdict">
    <div class="verdict-main">
      ${raw(headline)}
      <span class="verdict-url">${data.target.url ?? ""}</span>
    </div>
    <div class="verdict-side">
      <div class="verdict-band">
        ${raw(bandPill(view))}
        ${raw(
          data.risk
            ? html`<span class="verdict-score">${data.risk.score}<span class="per">/100</span></span>`
            : "",
        )}
      </div>
      ${raw(cachedBadge(view))}
      <p class="verdict-meta">
        ${raw(observedAt ? html`Observed ${observedAt}` : "")}
        ${raw(data.probe?.latency_ms === null || data.probe === null ? "" : html` · ${latencyLabel(data.probe)}`)}
        ${raw(data.probe ? html` · HTTP ${data.probe.http_status ?? "—"}` : "")}
        ${raw(
          data.risk
            ? html` ·
                <a href="${data.links.methodology ?? "/methodology"}"
                  >${data.risk.score_version} methodology</a
                >`
            : "",
        )}
      </p>
    </div>
  </section>`;
}

function endpointCard(view: InspectView): string {
  const { data } = view;
  const { probe, challenge, target } = data;

  const rows: KvRow[] = [
    { label: "URL", value: target.url },
    { label: "Canonical", value: target.canonical_url },
    { label: "Endpoint id", value: target.endpoint_id },
    { label: "HTTP status", value: probe?.http_status ?? null },
    { label: "Latency", value: latencyLabel(probe) },
    { label: "Redirects", value: probe?.redirect_count ?? null },
    {
      label: "TLS",
      value: probe?.tls ? (probe.tls.ok ? "handshake ok" : "not verified") : null,
      note: probe?.tls?.protocol ? undefined : "The negotiated TLS version is not exposed to a Worker.",
    },
    { label: "Wire form", value: wireFormLabel(challenge), prose: true },
    { label: "Bytes read", value: probe?.bytes_read ?? null },
  ];

  // Only when a challenge was actually served — see the note in markdown.ts.
  if (challenge && challenge.wire_form !== "none") {
    rows.push({
      label: "Strict decoder",
      valueHtml: challenge.valid
        ? statusPill("accepted", "ok")
        : statusPill("refused", "err"),
      note: challenge.valid
        ? "decodePaymentRequired, imported from tx402 — the same code the SDK runs before it pays."
        : (challenge.decode_error?.message ?? undefined),
    });
  }

  return resultCard({
    title: "Endpoint",
    body: kvTable(rows, "What we observed about the endpoint"),
    id: "endpoint",
  });
}

function requirementRows(terms: Requirement): KvRow[] {
  const manifestNote = "Recognized means present in the tx402 signed release manifest. Nothing more is claimed.";
  return [
    { label: "Price", value: priceLabel(terms) },
    { label: "Amount (atomic)", value: terms.amount_atomic ?? terms.amount_raw },
    { label: "Scheme", value: terms.scheme },
    {
      label: "Network",
      value: terms.network,
      note: terms.network_recognized === null ? undefined : manifestNote,
      ...(terms.network === null
        ? {}
        : {
            valueHtml: html`${terms.network}
              ${raw(
                terms.network_recognized === null
                  ? ""
                  : statusPill(terms.network_recognized ? "in manifest" : "not in manifest", terms.network_recognized ? "ok" : "warn"),
              )}`,
          }),
    },
    {
      label: "Asset",
      value: terms.asset?.address ?? null,
      ...(terms.asset === null
        ? {}
        : {
            valueHtml: html`${terms.asset.symbol ?? "unknown symbol"} ${terms.asset.address ?? ""}
              ${raw(
                terms.asset.recognized === null
                  ? ""
                  : statusPill(terms.asset.recognized ? "in manifest" : "not in manifest", terms.asset.recognized ? "ok" : "warn"),
              )}`,
            note: manifestNote,
          }),
    },
    { label: "Pay to", value: terms.pay_to },
    {
      label: "Pay to declared dynamic",
      value: terms.pay_to_dynamic === null ? null : terms.pay_to_dynamic ? "yes" : "no",
      prose: true,
      note:
        terms.pay_to_dynamic === true
          ? "The recipient is a role constant rather than a fixed address."
          : "x402 v2 has no on-the-wire declaration of a dynamic payTo, so this is usually unobservable.",
    },
    {
      label: "Authorization window",
      value: terms.max_timeout_seconds === null ? null : `${terms.max_timeout_seconds}s`,
    },
    { label: "Resource", value: terms.resource },
    { label: "MIME type", value: terms.mime_type },
    { label: "Description", value: terms.description, prose: true },
    { label: "Facilitator", value: terms.facilitator },
  ];
}

function paymentCard(view: InspectView): string {
  const { data } = view;
  const outcome = outcomeOf(data);

  if (outcome === "not_x402") {
    return resultCard({
      title: "Payment",
      badge: statusPill("no challenge", "unknown"),
      body: emptyState({
        title: "This endpoint served no x402 challenge",
        body: "There are no payment terms to report. That is a description of the response we received, not a finding about the endpoint.",
      }),
      id: "payment",
    });
  }

  if (!data.terms) {
    return resultCard({
      title: "Payment",
      badge: statusPill("not parsed", "warn"),
      body: emptyState({
        title: "No payment requirement could be parsed",
        body: "An x402 challenge was served, but nothing in it could be read as a payment requirement.",
      }),
      id: "payment",
    });
  }

  const accepted = termsAccepted(data);

  // SPEC §4.2 and `observed_terms` is not `challenge.accepts`,
  // and a refused challenge must never look accepted. The banner is not
  // decoration — it is the difference between a report and a false claim.
  const lede = accepted
    ? html`<p class="note">
        These terms were accepted by the strict decoder tx402 uses before it pays.
      </p>`
    : html`<p class="note note-warn">
        <strong>The decoder refused this challenge.</strong> The terms below were parsed out of what the
        endpoint served, so that whoever maintains it can see what we saw. They are
        <strong>not</strong> terms tx402 would pay.
      </p>`;

  const others = data.challenge?.accepts ?? [];
  const alternatives =
    others.length > 1
      ? html`<p class="small muted">
          This endpoint offers ${others.length} ways to pay. The card above describes the first, which is the
          order the server stated its own preference in.
        </p>
        ${raw(
          kvTable(
            others.slice(1).map((r, i) => ({
              label: `Alternative ${i + 2}`,
              value: `${priceLabel(r) ?? "amount not parsed"} · ${r.network ?? "no network"} · ${r.scheme ?? "no scheme"}`,
            })),
            "Other accepted ways to pay",
          ),
        )}`
      : "";

  return resultCard({
    title: "Payment",
    badge: accepted ? statusPill("accepted by the decoder", "ok") : statusPill("as served", "warn"),
    body: `${lede}${kvTable(requirementRows(data.terms), "The payment terms this endpoint asks for")}${alternatives}`,
    id: "payment",
  });
}

function observedCard(view: InspectView): string {
  const { observed } = view.data;

  if (!observed.has_history) {
    return resultCard({
      title: "Observed",
      badge: statusPill("first scan", "info"),
      body: emptyState({
        title: "First seen: just now · no history yet",
        body: "Availability, latency and price stability need repeated observations over time. One probe is not a measurement of any of them, so none is shown.",
        detail:
          "This endpoint is now in the corpus, so the crawler will keep watching it. Price and recipient changes are recorded permanently; availability and latency are sampled.",
      }),
      id: "observed",
      footer: html`<a href="${view.data.links.history ?? "/history"}">Price and availability history →</a>`,
    });
  }

  const rows: KvRow[] = [
    { label: "First seen", value: observed.first_seen },
    { label: "Last seen", value: observed.last_seen },
    { label: "Scans recorded", value: observed.scan_count },
    { label: "Availability (30d)", value: observed.availability_30d, emptyText: "not measured yet" },
    { label: "Latency p50", value: observed.latency_p50_ms, emptyText: "not measured yet" },
  ];

  const changes =
    observed.recent_changes.length > 0
      ? kvTable(
          observed.recent_changes.map((c) => ({
            label: c.changed_at,
            value: `${c.change_kind}: ${c.field} ${c.old_value ?? "—"} → ${c.new_value ?? "—"}`,
          })),
          "Recorded changes to this endpoint's terms",
        )
      : html`<p class="small muted">No recorded changes to this endpoint's terms.</p>`;

  return resultCard({
    title: "Observed",
    body: `${kvTable(rows, "What the corpus knows about this endpoint")}${changes}`,
    id: "observed",
    footer: html`<a href="${view.data.links.history ?? "/history"}">Price and availability history →</a>`,
  });
}

function checkItem(check: Check): string {
  return html`<li>
    ${raw(statusPill(check.status, toneForCheck(check.status), "Result:"))}
    <span>
      <span class="check-id">${check.id}</span>
      ${raw(check.offline ? "" : html` <span class="check-net">needs our data</span>`)}
      ${raw(check.detail ? html`<span class="check-detail">${check.detail}</span>` : "")}
    </span>
  </li>`;
}

function securityCard(view: InspectView): string {
  const { checks } = view.data;
  if (checks.length === 0) {
    return resultCard({
      title: "Security",
      body: emptyState({
        title: "No checks ran",
        body: "There was nothing to check, because the endpoint served no challenge.",
      }),
      id: "security",
    });
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  const outcome = outcomeOf(view.data);

  // The decode verdict is not one of the frozen check ids, so the card states
  // it directly. A refused challenge must never sit under a green
  // "nothing failing" badge — see the note in markdown.ts.
  const badge =
    outcome === "not_x402"
      ? statusPill("no challenge to check", "unknown")
      : outcome === "malformed"
        ? statusPill("challenge refused", "err")
        : failed > 0
          ? statusPill(`${failed} failing`, "err")
          : warned > 0
            ? statusPill(`${warned} to look at`, "warn")
            : statusPill("nothing failing", "ok");

  const lede =
    outcome === "not_x402"
      ? html`<p class="note">
          This URL served no x402 challenge, so the only check that could run is the one that looks for one.
        </p>`
      : outcome === "malformed"
        ? html`<p class="note note-warn">
            <strong>The strict decoder refused this challenge</strong>
            (<code>${view.data.challenge?.decode_error?.code ?? "unknown"}</code>), which is the finding that
            matters most here. The checks below describe what could still be determined from what the endpoint
            served.
          </p>`
        : "";

  return resultCard({
    title: "Security",
    badge,
    body: html`${raw(lede)}
      <p class="note">
        A check that could not run reports <code>skip</code>, and a skip is never counted as a pass.
      </p>
      <ul class="checks">
        ${join(checks.map(checkItem))}
      </ul>`,
    id: "security",
    footer: "Checks marked “needs our data” compare this scan against the corpus, which is still filling up.",
  });
}

function riskCard(view: InspectView): string {
  const { risk } = view.data;

  if (risk === null) {
    return resultCard({
      title: "Risk",
      badge: statusPill("not an x402 endpoint", "unknown"),
      body: emptyState({
        title: "Nothing to score",
        body: NOT_X402_NOTE,
      }),
      id: "risk",
    });
  }

  // Rendered VERBATIM from worker/lib/score.ts. Reproducibility from the same
  // response is the appeal mechanism, so the weights are shown
  // and they add up to the number in the header.
  const reasons = risk.reasons.map(
    (r) => html`<li>
      ${raw(statusPill(r.status, toneForCheck(r.status), "Result:"))}
      <span class="weight">${r.weight === 0 ? "—" : r.weight}</span>
      <span>
        ${r.message}
        <span class="signal">${r.signal_id}</span>
      </span>
    </li>`,
  );

  return resultCard({
    title: "Risk",
    badge: statusPill(risk.band, toneForBand(risk.band), "Band:"),
    aside: `${risk.score}/100 · ${risk.score_version} · ${risk.confidence}`,
    body: html`<p class="note">${BAND_NOTE}</p>
      ${raw(isLegacyV1(view.data) ? html`<p class="note note-warn">${V1_NOTE}</p>` : "")}
      <ul class="reasons">
        ${join(reasons)}
      </ul>`,
    id: "risk",
    footer: html`Weights, thresholds and the rationale for each signal are published at
      <a href="${view.data.links.methodology ?? "/methodology"}">the methodology page</a>. Adding up the
      weights above reproduces the score — that reproducibility is how a verdict can be argued with.`,
  });
}

function ctaCard(view: InspectView): string {
  const { data } = view;
  if (!data.target.url || outcomeOf(data) === "not_x402") return "";

  return resultCard({
    title: "Test with tx402 →",
    body: html`<p class="snippet-lede">
        Pre-filled with this endpoint's real terms. Your signer stays in your process — this service never sees
        a key, never asks for one, and cannot build a payment.
      </p>
      <div class="snippets">
        ${raw(codeBlock({ code: cliSnippet(data), label: "CLI — dry run, nothing is signed", copy: true }))}
        ${raw(codeBlock({ code: typescriptSnippet(data), label: "TypeScript", copy: true }))}
        ${raw(codeBlock({ code: pythonSnippet(data), label: "Python", copy: true }))}
        ${raw(codeBlock({ code: curlSnippet(data, view.origin), label: "This report, as JSON or Markdown", copy: true }))}
      </div>`,
    id: "test-with-tx402",
    footer: html`<a href="https://docs.tx402.io/guides/policy/">How spend policy works →</a>`,
  });
}

function shareCard(view: InspectView): string {
  const { data, snapshot } = view;
  if (!data.target.url) return "";

  if (snapshot) {
    return resultCard({
      title: "Snapshot",
      badge: statusPill("stored copy", "info"),
      body: html`<p class="note">
        <strong>This is a snapshot, not a live scan.</strong> It records what we observed at
        ${data.probe?.observed_at ?? "an earlier time"} and was stored on ${snapshot.created_at}. The endpoint
        may have changed since. This link expires on ${snapshot.expires_at}.
      </p>
      <p class="small">
        <a href="${data.links.html ?? "/inspect"}">Run a fresh scan of this endpoint →</a>
      </p>`,
      id: "snapshot",
    });
  }

  return resultCard({
    title: "Share this report",
    body: html`<form class="share-form" method="POST" action="/api/v1/share">
      <input type="hidden" name="kind" value="inspect" />
      <input type="hidden" name="url" value="${data.target.url}" />
      <p>
        Creates an unguessable permalink to a stored copy of this scan, stamped with the time it was observed.
        It is a snapshot and it says so; the endpoint can change afterwards.
      </p>
      <button class="btn btn-secondary" type="submit">Create a share link</button>
    </form>`,
    id: "share",
    footer: "Share links expire. Nothing is recorded about who created one.",
  });
}

function rawCard(view: InspectView): string {
  const { data } = view;
  if (!data.challenge?.raw) return "";
  return resultCard({
    title: "The challenge, as served",
    body: html`<p class="small muted">
        Public data: the endpoint serves this to anyone who asks. It is shown exactly as it arrived, truncated
        to the documented cap.
      </p>
      ${raw(codeBlock({ code: data.challenge.raw, label: "raw challenge", copy: true }))}
      ${raw(
        data.challenge.hash
          ? html`<p class="small faint">SHA-256 of the canonicalized challenge: ${data.challenge.hash}</p>`
          : "",
      )}`,
    id: "raw",
  });
}

function signalsCard(view: InspectView): string {
  const { signals } = view.data;
  if (signals.length === 0) return "";
  return resultCard({
    title: "Raw signals",
    body: html`<p class="small muted">
        The exact input the scoring function was given. A signal we could not determine has
        <code>observed: false</code> and contributes nothing to the score — it is never counted as a failure.
      </p>
      ${raw(jsonBlock(signals, "signals"))}`,
    id: "signals",
  });
}

/**
 * The envelope's warnings, rendered rather than dropped.
 *
 * `NO_HISTORY` and `NO_URL` are omitted because the page already answers both
 * of them with a designed state — repeating them as a caveat would make the
 * normal case look like a problem. Everything else is a fact about the
 * answer's completeness and the reader is entitled to it, including the dull
 * operational ones like which facilitator list we used.
 */
function warningsList(view: InspectView): string {
  const shown = view.envelope.warnings.filter((w) => w.code !== "NO_HISTORY" && w.code !== "NO_URL");
  if (shown.length === 0) return "";
  return html`<ul class="warnings">
    ${join(
      shown.map(
        (w) => html`<li><code>${w.code}</code><span>${w.message}</span></li>`,
      ),
    )}
  </ul>`;
}

function mirrors(view: InspectView): string {
  const { links } = view.data;
  return html`<p class="mirror-list">
    ${raw(links.json ? html`<a href="${links.json}">JSON</a>` : "")}
    ${raw(links.markdown ? html`<a href="${links.markdown}">Markdown</a>` : "")}
    ${raw(links.methodology ? html`<a href="${links.methodology}">Methodology</a>` : "")}
    <a href="/errors">Error reference</a>
  </p>`;
}

// ── the landing state ─────────────────────────────────────────────────────

function landing(view: InspectView): string {
  return html`${raw(
    emptyState({
      title: "Paste an endpoint URL to see what it charges",
      body: `We fetch the URL once, read the x402 challenge it serves, and stop. The challenge is decoded by
        <strong>decodePaymentRequired imported from the tx402 SDK</strong> — the same strict decoder that would
        refuse the payment — so what this page says is what the SDK would do.`,
      detail: "The probe never pays. It holds no key and cannot build a payment.",
    }),
  )}
  ${raw(
    resultCard({
      title: "For agents and terminals",
      body: html`<p class="small muted">
          Every result is available as JSON and as a plaintext report. Content negotiation, a
          <code>.md</code> mirror and <code>?format=</code> all work.
        </p>
        ${raw(
          codeBlock({
            code: `curl -H 'Accept: text/markdown' '${view.origin}/inspect?url=https://api.example.com/v1/geocode'\ncurl -H 'Accept: application/json' '${view.origin}/api/v1/inspect?url=https://api.example.com/v1/geocode'`,
            label: "the same report, three ways",
            copy: true,
          }),
        )}
        <ul class="example-list">
          <li>One live probe per endpoint per politeness window, however many people ask.</li>
          <li>Cached answers say so, with their age, in <code>meta.cache_age_seconds</code>.</li>
          <li>Every response validates against the frozen schema at <code>/api/v1/schemas/inspect</code>.</li>
        </ul>`,
      id: "agents",
    }),
  )}`;
}

// ── the page ──────────────────────────────────────────────────────────────

export interface InspectPageOptions {
  view: InspectView;
  path: string;
  turnstileSiteKey: string;
}

export function inspectPage(opts: InspectPageOptions): string {
  const { view } = opts;
  const outcome = outcomeOf(view.data);
  const hasReport = outcome !== "no_input";

  // Turnstile rides on a POST, because a token does not belong in a URL. With
  // no site key configured the form stays a GET, which is what
  // makes the result a shareable permalink and keeps the page working with no
  // JavaScript at all.
  const usePost = opts.turnstileSiteKey.length > 0;

  const box = pasteBox({
    action: "/inspect",
    method: usePost ? "POST" : "GET",
    name: "url",
    label: "Endpoint URL",
    placeholder: "https://api.example.com/v1/geocode",
    value: view.data.target.url ?? "",
    submitLabel: "Inspect",
    hint: "https only. We fetch it once, read the 402, and stop.",
    turnstileSiteKey: opts.turnstileSiteKey,
  });

  // Order is the argument: what it costs, then what we checked, then what we
  // know about it over time, then how to try it, and only then the plumbing.
  // A snapshot banner is the exception — it goes first, because everything
  // below it is a claim about a moment that has passed.
  const body = hasReport
    ? html`${raw(pageHead(TOOLS.inspect.h1))} ${raw(box)}
        ${raw(view.snapshot ? shareCard(view) : "")} ${raw(verdict(view))} ${raw(warningsList(view))}
        <div class="ins-cols">${raw(endpointCard(view))} ${raw(paymentCard(view))}</div>
        <div class="stack ins-stack">
          ${raw(riskCard(view))} ${raw(securityCard(view))} ${raw(observedCard(view))} ${raw(ctaCard(view))}
          ${raw(view.snapshot ? "" : shareCard(view))} ${raw(rawCard(view))} ${raw(signalsCard(view))}
        </div>
        ${raw(mirrors(view))}`
    : html`${raw(pageHead(TOOLS.inspect.h1, TOOLS.inspect.description))} ${raw(box)}
        <div class="stack ins-stack">${raw(landing(view))}</div>
        ${raw(mirrors(view))}`;

  return page({
    title: TOOLS.inspect.title,
    description: TOOLS.inspect.description,
    path: opts.path,
    // Any page that renders a band carries the note that says what a band is. It sits above the fold because
    // that is where the claim
    // it qualifies sits.
    observationNote: view.data.risk !== null,
    body,
    head: `<style>${STYLES}</style>`,
  });
}

// ── the refusal page ──────────────────────────────────────────────────────

export interface InspectErrorPageOptions {
  code: string;
  /** From `errorBody` — never rewritten here. */
  message: string;
  docs: string | null;
  url: string | null;
  path: string;
  turnstileSiteKey: string;
}

/**
 * A guard refusal, rendered for a person.
 *
 * The message is `errorBody`'s, unchanged: every blocked-URL code returns the same generic sentence
 * so that a refusal cannot double as a network scanner. Writing a friendlier, more specific
 * sentence here would undo that on the one surface where it matters most.
 */
export function inspectErrorPage(opts: InspectErrorPageOptions): string {
  const box = pasteBox({
    action: "/inspect",
    method: opts.turnstileSiteKey.length > 0 ? "POST" : "GET",
    name: "url",
    label: "Endpoint URL",
    placeholder: "https://api.example.com/v1/geocode",
    value: opts.url ?? "",
    submitLabel: "Inspect",
    hint: "https only. We fetch it once, read the 402, and stop.",
    turnstileSiteKey: opts.turnstileSiteKey,
  });

  const body = html`${raw(pageHead(TOOLS.inspect.h1))} ${raw(box)}
    ${raw(
      resultCard({
        title: "That URL was not probed",
        badge: statusPill(opts.code, "warn"),
        body: html`<p>${opts.message}</p>
          ${when(opts.url !== null, html`<p class="small faint">Requested: ${opts.url ?? ""}</p>`)}
          <p class="small muted">
            The hosted probe accepts <code>https:</code> only, refuses URLs carrying credentials, and will not
            follow a redirect into a private address. The reasons are deliberately not itemised: a refusal that
            explains itself precisely is a network scanner with extra steps.
          </p>`,
        footer: opts.docs
          ? html`<a href="${opts.docs}">What ${opts.code} means →</a>`
          : html`<a href="/errors">Error reference →</a>`,
        id: "refused",
      }),
    )}`;

  return page({
    title: TOOLS.inspect.title,
    description: TOOLS.inspect.description,
    path: opts.path,
    body,
    head: `<style>${STYLES}</style>`,
  });
}
