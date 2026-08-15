/**
 * The `/history` page.
 *
 * A **rendering of `HistoryView`, never a second computation** (SPEC §1.2): the
 * markdown mirror is handed the identical data and warnings, so the page and
 * the report cannot say different things about the same number.
 *
 * ── The layout is the argument ────────────────────────────────────────────
 *
 * The page is two cards, and the split between them is the point.
 * stores price changes and availability differently because they are different
 * kinds of fact; SPEC §5.4 forbids blending them into one array. A page that
 * honoured the letter of that and then stacked a "99.94%" next to a "price
 * changed on 21 Jul" in one uniform grid would have complied with the schema
 * and lost the distinction anyway.
 *
 * So:
 *
 *   **Exact record** — solid border, solid marks, dated events, no `≈` anywhere.
 *   Sourced from an append-only log that a database trigger will not let anyone
 *   edit. This is what an operator would be shown.
 *
 *   **Sampled telemetry** — dashed border, hatched bars, every figure prefixed
 *   `≈`, the word "sampled" on the card and in every caption. Sourced from a
 *   dataset that samples under load and ages out.
 *
 * The two never share a chart, a table or a row.
 *
 * ── Language ───────────────────────────────────────────────
 *
 * Every string states what changed and when. Nothing here characterises the
 * operator of an endpoint, and a recipient change is reported the same way a
 * timeout change is — as a dated fact. The words this repo may never print
 * appear nowhere, and `test/history.test.ts` asserts that against the rendered
 * page rather than trusting the review.
 */

import {
  emptyState,
  escapeHtml,
  html,
  join,
  kvTable,
  page,
  pageHead,
  raw,
  resultCard,
  statusPill,
  type KvRow,
} from "../../components/index.js";
import { TOOLS } from "../../tool-meta.js";
import { availabilityChart, domainFrom, latencyChart, priceChart } from "./chart.js";
import {
  ANALYTICS_UNAVAILABLE_BODY,
  ANALYTICS_UNAVAILABLE_TITLE,
  APPROX,
  EXACT_HEADING,
  EXACT_LABEL,
  EXACT_LEAD,
  NOT_IN_CORPUS_BODY,
  NOT_IN_CORPUS_TITLE,
  NO_SAMPLES_BODY,
  NO_SAMPLES_TITLE,
  SAMPLED_HEADING,
  SAMPLED_LABEL,
  SAMPLED_LEAD,
  WARN,
  WINDOWS,
  daysBetween,
  describeChange,
  formatDate,
  formatDateTime,
  formatMs,
  formatPrice,
  formatRatio,
  samplingState,
  warningMessage,
  type HistoryView,
  type HistoryWindow,
} from "./types.js";

// ── page-local styles ────────────────────────────────────────────────────
// Every colour is a token from ui/tokens.css. `pnpm gate:tokens` scans <style>
// blocks in.ts files, so a literal here fails the build — which is the point.

const STYLES = `
.hist-form { margin-bottom: var(--s5); }
.hist-form .row { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: flex-end; }
.hist-form .field-wrap { flex: 1 1 22rem; min-width: 0; }
.hist-form label { display: block; margin-bottom: var(--s2); font-size: .85rem; font-weight: 600; }
.hist-form select.field { height: var(--field-h); width: auto; }

.hist-sources {
  display: grid;
  gap: var(--s3);
  grid-template-columns: 1fr;
  margin-bottom: var(--s5);
  padding: var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface-2);
}
@media (min-width: 48rem) { .hist-sources { grid-template-columns: 1fr 1fr; } }
.hist-sources h2 { margin: 0 0 var(--s2); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); }
.hist-sources p { margin: 0; font-size: .85rem; color: var(--text-muted); }
.hist-sources .swatch { display: inline-block; width: 2.4rem; height: 0; margin-right: var(--s2); vertical-align: middle; }
.hist-sources .swatch-exact { border-top: 3px solid var(--accent-line); }
.hist-sources .swatch-sampled { border-top: 3px dashed var(--text-faint); }

.hist-target { margin: 0 0 var(--s5); font-family: var(--mono); font-size: .85rem; color: var(--text-muted); word-break: break-all; }

/* Keyed on the ids resultCard emits: it renders class="card" plus the id, and
   takes no class of its own — a .card.exact selector would silently match
   nothing, which is how a distinction that the copy claims quietly stops being
   drawn. Solid for the exact record, dashed for the sampled one. */
.card#exact { border-left: 3px solid var(--accent-line); }
.card#sampled { border-left: 3px dashed var(--border-strong); }
.card-lead { margin: 0 0 var(--s4); color: var(--text-muted); font-size: .9rem; max-width: 62ch; }

.chart { margin: 0 0 var(--s4); }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart figcaption { margin-top: var(--s2); font-size: .8rem; color: var(--text-faint); max-width: 68ch; }
.chart-frame line { stroke: var(--grid-line); stroke-width: 1; }
.chart-axis { font-family: var(--mono); font-size: 10px; fill: var(--text-faint); }
.chart-void { font-size: 11px; fill: var(--text-faint); letter-spacing: .04em; }
.chart-line-exact { stroke: var(--accent); stroke-width: 2; fill: none; }
.chart-dot-exact { fill: var(--accent); stroke: var(--surface); stroke-width: 1.5; }
.chart-bar-sampled { fill: url(#hatch-sampled); stroke: var(--accent); stroke-width: .5; }
.chart-line-sampled { stroke: var(--text-muted); stroke-width: 2; fill: none; stroke-dasharray: 5 4; }
.chart-line-sampled-faint { stroke: var(--text-faint); stroke-width: 1.5; fill: none; stroke-dasharray: 2 5; }
.chart-dot-sampled { fill: var(--text-muted); stroke: var(--surface); stroke-width: 1.2; }

.timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s4); }
.timeline li { display: grid; grid-template-columns: auto 1fr; gap: var(--s4); align-items: baseline; }
.timeline .when { font-family: var(--mono); font-size: .82rem; color: var(--text-muted); white-space: nowrap; }
.timeline .what { margin: 0; }
.timeline .values { display: block; margin-top: var(--s1); font-family: var(--mono); font-size: .8rem; word-break: break-all; }
.timeline .values .from { color: var(--text-faint); text-decoration: line-through; }
.timeline .values .to { color: var(--text); }
.timeline .stamp { display: block; margin-top: var(--s1); font-size: .74rem; color: var(--text-faint); }

.figures { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); margin-bottom: var(--s5); }
.figures div { border: 1px dashed var(--border-strong); border-radius: var(--r-sm); padding: var(--s3) var(--s4); background: var(--surface-2); }
.figures dt { margin: 0 0 var(--s1); font-size: .74rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); }
.figures dd { margin: 0; font-family: var(--mono); font-size: 1.15rem; font-weight: 600; }

.hist-note { border-left: 3px solid var(--accent-line); background: var(--accent-soft); border-radius: var(--r-sm); padding: var(--s3) var(--s4); color: var(--text-muted); font-size: .875rem; margin: 0 0 var(--s4); }
.hist-note:last-child { margin-bottom: 0; }
.hist-note strong { color: var(--text); }

details.numbers { margin-top: var(--s3); }
details.numbers summary { cursor: pointer; font-size: .82rem; color: var(--text-muted); }
details.numbers table { width: 100%; border-collapse: collapse; margin-top: var(--s3); font-family: var(--mono); font-size: .8rem; }
details.numbers th, details.numbers td { text-align: left; padding: var(--s1) var(--s3) var(--s1) 0; border-bottom: 1px solid var(--grid-line); }
details.numbers th { color: var(--text-faint); font-weight: 500; }
`;

export interface HistoryPageOptions {
  view: HistoryView;
  /** The envelope this is a rendering of; read for its stamps, never recomputed. */
  envelope: unknown;
  path: string;
  turnstileSiteKey?: string;
}

/** `generated_at` is the page's "now". Reading it keeps all three mirrors on one clock. */
function generatedAt(envelope: unknown): string {
  const at = (envelope as { generated_at?: unknown } | null)?.generated_at;
  return typeof at === "string" ? at : new Date().toISOString().slice(0, 19) + "Z";
}

// ── the form ──────────────────────────────────────────────────────────────
// Hand-rolled rather than `pasteBox` for one reason: the window has to survive
// the submit, and a control the shared component does not have would otherwise
// be a second form or a lost parameter. It reuses the component stylesheet's
// own classes, so it inherits the design rather than starting a dialect.
// There is no Turnstile widget here even when a key is configured: History
// never probes. It reads rows the crawler already wrote, so it is not a lever
// anyone can point at somebody else's API —.

function form(url: string | null, window: HistoryWindow): string {
  const options = WINDOWS.map(
    (w) =>
      html`<option value="${w}"${raw(w === window ? ' selected=""' : "")}>Last ${w.replace("d", " days")}</option>`,
  );

  return html`<form class="paste-box hist-form" action="/history" method="GET">
    <div class="row">
      <div class="field-wrap">
        <label for="field-url">Endpoint URL</label>
        <input
          class="field"
          id="field-url"
          name="url"
          type="text"
          value="${url ?? ""}"
          placeholder="https://api.example.com/v1/geocode"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
        />
      </div>
      <div>
        <label for="field-window">Window</label>
        <select class="field" id="field-window" name="window">
          ${join(options)}
        </select>
      </div>
      <button class="btn" type="submit">Show history</button>
    </div>
    <p class="hint">
      We look this endpoint up in what we have already observed. Nothing is fetched from the endpoint —
      History never probes.
    </p>
  </form>`;
}

/** The two-source legend, above the fold, in the marks the charts actually use. */
function sourceLegend(): string {
  return html`<div class="hist-sources">
    <div>
      <h2><span class="swatch swatch-exact"></span>${EXACT_HEADING}</h2>
      <p>${EXACT_LEAD}</p>
    </div>
    <div>
      <h2><span class="swatch swatch-sampled"></span>${SAMPLED_HEADING}</h2>
      <p>${SAMPLED_LEAD}</p>
    </div>
  </div>`;
}

function note(body: string): string {
  return html`<p class="hist-note">${raw(body)}</p>`;
}

// ── the exact card ────────────────────────────────────────────────────────

function timeline(view: HistoryView): string {
  const items = [...view.data.changes]
    .reverse()
    .map(
      (change) => html`<li>
        <span class="when">${formatDate(change.changed_at)}</span>
        <p class="what">
          ${describeChange(change)}
          ${raw(
            change.old_value !== null || change.new_value !== null
              ? html`<span class="values"
                  >${raw(change.old_value !== null ? html`<span class="from">${change.old_value}</span> → ` : "")}<span
                    class="to"
                    >${change.new_value ?? "—"}</span
                  ></span
                >`
              : "",
          )}
          <span class="stamp"
            >Observed ${formatDateTime(change.changed_at)} · recorded by ${change.detected_by ?? "crawler"}${raw(
              change.score_version
                ? html` · scoring in force then: ${change.score_version}`
                : "",
            )}</span
          >
        </p>
      </li>`,
    );

  if (items.length === 0) {
    return note(
      "<strong>No changes in this window.</strong> Nothing we track about this endpoint's terms moved. " +
        "That is a finding, not a gap — the log records changes, so an empty log means the terms held.",
    );
  }

  return html`<ul class="timeline">
    ${join(items)}
  </ul>`;
}

function priceTable(view: HistoryView): string {
  const rows = view.data.series.price.map(
    (point) => html`<tr>
      <td>${formatDateTime(point.t)}</td>
      <td>${formatPrice(point)}</td>
      <td>${point.network ?? "—"}</td>
    </tr>`,
  );
  if (rows.length === 0) return "";

  return html`<details class="numbers">
    <summary>Show the observed prices</summary>
    <table>
      <thead>
        <tr><th scope="col">Observed at</th><th scope="col">Price</th><th scope="col">Network</th></tr>
      </thead>
      <tbody>
        ${join(rows)}
      </tbody>
    </table>
  </details>`;
}

function exactCard(view: HistoryView, now: string): string {
  const { coverage, series, window } = view.data;
  const domain = domainFrom(
    new Date(Date.parse(now) - windowMs(window)).toISOString().slice(0, 19) + "Z",
    now,
    coverage.first_seen,
  );

  const thin = warningMessage(view, WARN.THIN_HISTORY);
  const anchor = warningMessage(view, WARN.PRICE_ANCHOR_BEFORE_WINDOW);

  const body =
    html`<p class="card-lead">${EXACT_LEAD}</p>` +
    (thin ? note(`<strong>Short record.</strong> ${escapeHtml(thin)}`) : "") +
    (anchor ? note(escapeHtml(anchor)) : "") +
    (series.price.length > 0
      ? priceChart(series.price, domain) + priceTable(view)
      : note(
          "<strong>No price on record for this window.</strong> We have observed this endpoint but have " +
            "not recorded a price we could chart.",
        )) +
    html`<h3>Changes</h3>` +
    timeline(view);

  return resultCard({
    id: "exact",
    title: EXACT_HEADING,
    badge: statusPill(EXACT_LABEL, "info", "Data source:"),
    body,
    footer:
      "Written to an append-only log that a database trigger will not let anyone update or delete. " +
      "A mistake is corrected by appending a correction, so nothing here can be quietly rewritten.",
  });
}

// ── the sampled card ──────────────────────────────────────────────────────

function windowMs(window: HistoryWindow): number {
  return Number(window.replace("d", "")) * 86_400_000;
}

/** Window-wide roll-ups, weighted by samples. Sampled, and labelled as such. */
function figures(view: HistoryView): string {
  const { availability, latency } = view.data.series;

  const totalSamples = availability.reduce((sum, p) => sum + p.samples, 0);
  const weighted = availability.reduce((sum, p) => sum + p.ratio * p.samples, 0);
  const ratio = totalSamples > 0 ? weighted / totalSamples : null;

  const latencySamples = latency.reduce((sum, p) => sum + p.samples, 0);
  const p50 =
    latencySamples > 0
      ? latency.reduce((sum, p) => sum + (p.p50_ms ?? 0) * p.samples, 0) / latencySamples
      : null;
  const p95Points = latency.filter((p) => p.p95_ms !== null);
  const p95 =
    p95Points.length > 0 ? Math.max(...p95Points.map((p) => p.p95_ms as number)) : null;

  return html`<dl class="figures">
    <div>
      <dt>Availability (${view.data.window}, sampled)</dt>
      <dd>${ratio === null ? "not observed" : formatRatio(ratio)}</dd>
    </div>
    <div>
      <dt>Median response (sampled)</dt>
      <dd>${formatMs(p50)}</dd>
    </div>
    <div>
      <dt>Slowest 5% (sampled)</dt>
      <dd>${formatMs(p95)}</dd>
    </div>
    <div>
      <dt>Probe samples</dt>
      <dd>${APPROX}${totalSamples}</dd>
    </div>
  </dl>`;
}

function sampledCard(view: HistoryView, now: string): string {
  const state = samplingState(view);
  const { coverage, series, window } = view.data;
  const domain = domainFrom(
    new Date(Date.parse(now) - windowMs(window)).toISOString().slice(0, 19) + "Z",
    now,
    coverage.first_seen,
  );

  const pending = warningMessage(view, WARN.RECENT_PROBE_PENDING);

  let body = html`<p class="card-lead">${SAMPLED_LEAD}</p>`;

  if (state === "unavailable") {
    // Deliberately NOT the same rendering as "no samples". We built
    // `queryAnalytics` to return `{rows: null, error}` so this page could tell
    // a missing credential from a quiet endpoint, and a page that showed both
    // as an empty chart would have thrown that distinction away.
    body += emptyState({
      title: ANALYTICS_UNAVAILABLE_TITLE,
      body: escapeHtml(ANALYTICS_UNAVAILABLE_BODY),
      detail: escapeHtml(warningMessage(view, WARN.ANALYTICS_UNAVAILABLE) ?? ""),
    });
  } else if (state === "no_samples") {
    body += emptyState({
      title: NO_SAMPLES_TITLE,
      body: escapeHtml(NO_SAMPLES_BODY),
      detail: escapeHtml(warningMessage(view, WARN.NO_SAMPLES) ?? ""),
    });
  } else {
    body +=
      figures(view) +
      availabilityChart(series.availability, domain) +
      latencyChart(series.latency, domain);
  }

  if (pending) body += note(`<strong>Just probed.</strong> ${escapeHtml(pending)}`);

  return resultCard({
    id: "sampled",
    title: SAMPLED_HEADING,
    badge: statusPill(SAMPLED_LABEL, "idle", "Data source:"),
    body,
    footer:
      "Aggregated from a sampled dataset by total sample weight, not by counting stored rows. Retention is " +
      "bounded, so an old window thins out. These figures describe a trend; they are not a record of any " +
      "particular request.",
  });
}

// ── coverage ──────────────────────────────────────────────────────────────

function coverageCard(view: HistoryView, now: string): string {
  const { coverage, window } = view.data;
  const age = daysBetween(coverage.first_seen, now);

  const rows: KvRow[] = [
    {
      label: "First observed",
      value: coverage.first_seen ? formatDate(coverage.first_seen) : null,
      note:
        age === null
          ? undefined
          : age === 0
            ? "today — our record begins here"
            : `${age} day${age === 1 ? "" : "s"} of record`,
      emptyText: "never observed",
    },
    {
      label: "Last observed",
      value: coverage.last_seen ? formatDateTime(coverage.last_seen) : null,
      emptyText: "never observed",
    },
    { label: "Probes recorded", value: coverage.scan_count },
    {
      label: "Window requested",
      value: `last ${window.replace("d", " days")}`,
    },
    {
      label: "Contains sampled figures",
      valueHtml: coverage.sampled
        ? statusPill("yes — availability and latency are estimates", "idle")
        : statusPill("no — everything shown is an exact record", "info"),
    },
  ];

  return resultCard({
    id: "coverage",
    title: "What we have",
    body: kvTable(rows, "Coverage of our record for this endpoint"),
  });
}

// ── the page ──────────────────────────────────────────────────────────────

export function historyPage(opts: HistoryPageOptions): string {
  const { view } = opts;
  const now = generatedAt(opts.envelope);
  const url = view.data.target.url;
  const notInCorpus = view.warnings.some((w) => w.code === WARN.NOT_IN_CORPUS);

  let body =
    pageHead(TOOLS.history.h1, TOOLS.history.description) +
    form(url, view.data.window) +
    sourceLegend();

  if (url && view.data.target.canonical_url) {
    body += html`<p class="hist-target">${view.data.target.canonical_url}</p>`;
  }

  if (!url) {
    body += emptyState({
      title: "Enter an endpoint URL",
      body:
        "History shows how an x402 endpoint's price, payout address, availability and latency have moved " +
        "over time — every terms change dated, and every sampled figure marked as an estimate.",
      detail:
        'Or <a href="/inspect">inspect an endpoint</a> to see what it charges right now.',
    });
  } else if (notInCorpus) {
    body +=
      emptyState({
        title: NOT_IN_CORPUS_TITLE,
        body: escapeHtml(NOT_IN_CORPUS_BODY),
        detail:
          '<a href="/inspect?url=' +
          encodeURIComponent(url) +
          '">Inspect it now</a> to see what it charges today, or read how the ' +
          '<a href="/crawler">corpus is built</a>.',
      }) + coverageCard(view, now);
  } else {
    body += exactCard(view, now) + sampledCard(view, now) + coverageCard(view, now);
  }

  body += html`<p class="small muted">
    <a href="/history.md${raw(escapeHtml(query(view)))}">Markdown</a> ·
    <a href="/api/v1/history${raw(escapeHtml(query(view)))}">JSON</a> · price and recipient changes are exact;
    availability and latency are sampled.
  </p>`;

  return page({
    title: TOOLS.history.title,
    description: TOOLS.history.description,
    body,
    path: opts.path,
    head: `<style>${STYLES}</style>`,
  });
}

function query(view: HistoryView): string {
  const url = view.data.target.url;
  const params = new URLSearchParams();
  if (url) params.set("url", url);
  params.set("window", view.data.window);
  return `?${params.toString()}`;
}
