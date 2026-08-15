/**
 * The Compare page and the curated category pages.
 *
 * **This is a RENDERING of `CompareView`, never a second computation** (SPEC
 * §1.2). It takes the view and nothing else.
 *
 * ── The one component decision worth explaining ────────────────────────────
 *
 * Every other tool page is a stack of `kvTable`s: one label column, one value column. A comparison
 * is the one shape that primitive cannot express, because the whole point is N value columns beside
 * each other. So the grid below is a hand-built table that reuses `kv-table`'s exact markup
 * contract — the same `table-scroll` wrapper, the same `.kv` table, the same `<th scope="row">`
 * labels, and above all the same `<td class="unobserved">` cell for a value we do not have, which
 * renders as muted italic prose rather than as a blank. `kvTable` itself renders the per- endpoint
 * detail cards below the grid, where its shape is the right one.
 *
 * No new CSS class is introduced and no colour appears here: `ui/components.css`
 * and `ui/tokens.css` belong to, and a seventh visual dialect is exactly what
 * `pnpm gate:tokens` exists to prevent. The two inline `style` attributes are
 * layout only — a column header is prose and has to wrap, which `.kv th` (sized
 * for a 34% row-label column) does not allow.
 */

import {
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
  type KvRow,
} from "../../components/index.js";
import { TOOLS } from "../../tool-meta.js";
import { CATEGORIES } from "./catalogue.js";
import {
  emptyReason,
  priceLabel,
  scoredDownForV1,
  type CategorySummary,
  type CompareRow,
  type CompareRowDetail,
  type CompareView,
} from "./types.js";

const CATEGORY_SEO_TITLES = new Map(CATEGORIES.map((c) => [c.slug, c.seoTitle]));

/**
 * A grid cell.
 *
 * The absent branch is why this is a function rather than an interpolation:
 * "not probed yet" must be visibly a sentence about us, in the same muted
 * italic as everywhere else in the suite, and it must be impossible to render
 * it as an empty string by forgetting a branch.
 */
function cell(value: string | number | null | undefined, detail: CompareRowDetail): string {
  if (value === null || value === undefined || value === "") {
    return html`<td class="unobserved">${emptyReason(detail.data_state)}</td>`;
  }
  return html`<td>${value}</td>`;
}

function headerCell(row: CompareRow, detail: CompareRowDetail): string {
  return html`<th scope="col" style="width:auto;white-space:normal">
    ${row.title ?? detail.host ?? row.url}
    <span class="kv-note">${detail.host ?? ""}</span>
  </th>`;
}

function scoreCell(row: CompareRow, detail: CompareRowDetail): string {
  if (!row.risk) return html`<td class="unobserved">${emptyReason(detail.data_state)}</td>`;

  const pill = statusPill(
    `${row.risk.score}/100 ${row.risk.band}`,
    toneForBand(row.risk.band),
    "observed signals:",
  );
  // "methodology v1" and "x402 v1" are two different v1s and they sit in the
  // same cell. Both are spelled out rather than abbreviated to one of them.
  const version = html`<span class="kv-note"
    >methodology ${row.risk.score_version} ·
    ${row.risk.confidence === "with_history" ? "with history" : "first probe only"}</span
  >`;
  const v1 = scoredDownForV1(row, detail)
    ? html`<span class="kv-note"
        >Serves an x402 v1 challenge, which this v2-only decoder cannot read. That lowers the score
        and is a fact about the decoder — see the notes below.</span
      >`
    : "";

  return html`<td>${raw(pill)}${raw(version)}${raw(v1)}</td>`;
}

function windowCell(detail: CompareRowDetail): string {
  if (detail.observation_days === null) {
    return html`<td class="unobserved">not in our index yet</td>`;
  }
  // Zero probes is not a zero-day window; it is no window at all. An endpoint
  // sitting in the index unprobed has been *listed* for a while and *observed*
  // never, and only the second is what this column claims.
  if (detail.scan_count === 0) {
    return html`<td class="unobserved">${emptyReason(detail.data_state)}</td>`;
  }
  const days = detail.observation_days;
  const probes = detail.scan_count;
  return html`<td
    >${days === 0 ? "under a day" : `${days} day${days === 1 ? "" : "s"}`}<span class="kv-note"
      >${probes} probe${probes === 1 ? "" : "s"}</span
    ></td
  >`;
}

/**
 * Availability and latency are empty for a different reason from the rest.
 *
 * The other empty cells mean "we have not observed this endpoint". These mean
 * "this page does not ask" — the figures exist, are read one endpoint at a time
 * from the sampled dataset, and are rendered on the history page. That is a
 * fact about this page, not about the endpoint, so it gets its own sentence and
 * a link to where the number actually is.
 */
function unmeasuredCell(row: CompareRow): string {
  return html`<td class="unobserved"
    >not compared here —
    <a href="/history?url=${encodeURIComponent(row.url)}">see history</a></td
  >`;
}

/**
 * The side-by-side grid.
 *
 * Rows are attributes and columns are endpoints, which is the orientation that
 * survives a narrow screen: the reader scrolls one axis and the attribute label
 * stays in the leftmost cell.
 */
function grid(view: CompareView): string {
  const pairs = view.data.rows.map((row, i) => ({
    row,
    detail: view.details[i] as CompareRowDetail,
  }));

  const attribute = (
    label: string,
    render: (row: CompareRow, detail: CompareRowDetail) => string,
  ): string =>
    html`<tr>
      <th scope="row">${label}</th>
      ${join(pairs.map((p) => render(p.row, p.detail)))}
    </tr>`;

  const rows = [
    attribute("Price per call", (row, detail) => cell(priceLabel(row.terms), detail)),
    attribute("Network", (row, detail) => cell(row.terms?.network, detail)),
    attribute("Asset", (row, detail) =>
      cell(row.terms?.asset?.symbol ?? row.terms?.asset?.address, detail),
    ),
    attribute("Pays to", (row, detail) => cell(row.terms?.pay_to, detail)),
    attribute("Authorization window", (row, detail) =>
      cell(
        row.terms?.max_timeout_seconds === null || row.terms?.max_timeout_seconds === undefined
          ? null
          : `${row.terms.max_timeout_seconds}s`,
        detail,
      ),
    ),
    attribute("Observed signals", (row, detail) => scoreCell(row, detail)),
    attribute("Watched for", (_row, detail) => windowCell(detail)),
    attribute("Terms last observed", (row, detail) => cell(row.terms ? row.last_seen : null, detail)),
    attribute("Availability (30d)", (row, detail) =>
      row.availability_30d === null
        ? unmeasuredCell(row)
        : cell(`${Math.round(row.availability_30d * 100)}%`, detail),
    ),
    attribute("Latency p50", (row, detail) =>
      row.latency_p50_ms === null ? unmeasuredCell(row) : cell(`${row.latency_p50_ms} ms`, detail),
    ),
  ];

  return html`<div class="table-scroll">
    <table class="kv">
      <caption class="visually-hidden">
        ${view.data.category?.title ?? "x402 endpoints compared side by side"}
      </caption>
      <thead>
        <tr>
          <th scope="col" style="width:auto">Endpoint</th>
          ${join(pairs.map((p) => headerCell(p.row, p.detail)))}
        </tr>
      </thead>
      <tbody>
        ${join(rows)}
      </tbody>
    </table>
  </div>`;
}

/** The per-endpoint card: everything the grid has no column for. */
function detailCard(row: CompareRow, detail: CompareRowDetail): string {
  const rows: KvRow[] = [
    {
      label: "URL",
      valueHtml: html`<a href="/inspect?url=${encodeURIComponent(row.url)}">${row.url}</a>`,
    },
    {
      label: "First seen by us",
      value: detail.first_seen,
      emptyText: "never — not in our index",
      note: "The first time we observed it ourselves. Never a date a facilitator claimed.",
    },
    {
      label: "Probes so far",
      value: detail.scan_count === 0 ? null : detail.scan_count,
      emptyText: "none yet",
    },
    { label: "Discovered via", value: detail.discovery_source, prose: true },
    { label: "Wire form", value: detail.wire_form },
    { label: "x402 version", value: detail.x402_version },
  ];

  if (detail.quality) {
    const facilitator = detail.quality.facilitator_id ?? "the listing facilitator";
    rows.push(
      {
        label: "Usage, per the facilitator",
        value:
          detail.quality.calls_30d === null
            ? null
            : `${detail.quality.calls_30d} calls in 30 days from ${
                detail.quality.unique_payers_30d ?? "an unstated number of"
              } unique payers`,
        prose: true,
        emptyText: "not published",
        note: `Published by ${facilitator}. Their measurement, not ours.`,
      },
      {
        label: "Last called, per the facilitator",
        value: detail.quality.last_called_at,
        emptyText: "not published",
      },
    );
  }

  if (detail.advertised) {
    rows.push({
      label: "Advertised price",
      value: detail.advertised.amount ? `${detail.advertised.amount} atomic units` : null,
      emptyText: "not advertised",
      note: detail.price_disagreement
        ? `The listing advertises ${detail.price_disagreement.advertised} and the endpoint served us ${detail.price_disagreement.observed}. Both are recorded; the second is what it asked us for.`
        : "What the facilitator's listing says. Kept apart from what we observed.",
    });
  }

  if (detail.categories.length > 0) {
    rows.push({
      label: "Categories",
      valueHtml: join(
        detail.categories.map((slug) => html`<a href="/compare/${slug}">${slug}</a>`),
        ", ",
      ).value,
      prose: true,
    });
  }

  return resultCard({
    title: row.title ?? detail.host ?? row.url,
    badge: row.insufficient_data
      ? statusPill(emptyReason(detail.data_state), "unknown", "data:")
      : statusPill("terms observed", "ok", "data:"),
    body: kvTable(rows, `Details for ${detail.host ?? row.url}`),
  });
}

function notesCard(notes: string[]): string {
  if (notes.length === 0) return "";
  return resultCard({
    title: "What this table does and does not say",
    body: html`<ul class="stack">
      ${join(notes.map((note) => html`<li class="muted">${note}</li>`))}
    </ul>`,
  });
}

function rankingLine(view: CompareView): string {
  if (view.ranking.refused) {
    return html`<p class="hint">
      <strong>Not ranked by ${view.ranking.refused.key}.</strong> ${view.ranking.refused.reason}
    </p>`;
  }
  if (view.ranking.applied === "given") return "";
  return html`<p class="hint">Sorted by ${view.ranking.applied}.</p>`;
}

function compareForm(view: CompareView): string {
  return html`<form class="paste-box" action="/compare" method="GET">
    <label for="field-urls">Compare x402 endpoints by URL</label>
    <div class="row">
      <div class="field-wrap">
        <input
          class="field"
          id="field-urls"
          name="urls"
          type="text"
          value="${view.requestedUrls.join(",")}"
          placeholder="https://a.example/api, https://b.example/api"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
        />
      </div>
      <button class="btn" type="submit">Compare</button>
    </div>
    <p class="hint">
      Up to 8 https URLs, comma separated. Compare reads what has already been observed — it does not
      fetch on demand. To have a new endpoint looked at, use the <a href="/inspect">inspector</a>.
    </p>
  </form>`;
}

function categoryList(categories: CategorySummary[]): string {
  const published = categories.filter((c) => c.published);
  if (published.length === 0) return "";

  return resultCard({
    title: "Browse by category",
    body: html`<div class="stack">
      ${join(
        published.map(
          (category) => html`<div>
            <a href="/compare/${category.slug}"><strong>${category.title}</strong></a>
            <p class="muted small">${category.summary}</p>
            <p class="faint small">
              ${category.endpoint_count} endpoint${category.endpoint_count === 1 ? "" : "s"} ·
              curated by ${category.curated_by ?? "us"}
            </p>
          </div>`,
        ),
      )}
    </div>`,
    footer: `Categories are curated: each has an owner and a published definition. Membership is assigned from the facilitator's own listing tags, and a curator can add or remove an endpoint by hand.`,
  });
}

export function comparePage(view: CompareView): string {
  const category = view.data.category;
  const heading = category?.title ?? TOOLS.compare.h1;
  const summary = category?.summary ?? TOOLS.compare.description;
  const seoTitle = category
    ? (CATEGORY_SEO_TITLES.get(category.slug) ?? TOOLS.compare.title)
    : TOOLS.compare.title;

  const head = html`${raw(pageHead(heading, summary))}${raw(compareForm(view))}`;

  const body =
    view.data.rows.length === 0
      ? html`${raw(head)}
          ${raw(
            emptyState({
              title: category ? "No endpoints in this category yet" : "Nothing to compare yet",
              body: category
                ? "That is what we know, not a claim that none exists. The index fills from the facilitators&rsquo; own published listings on a 15-minute cycle, and a category only lists endpoints we have actually observed."
                : "Give this page two or more endpoint URLs, or open one of the categories below.",
              detail: category
                ? 'Know one that belongs here? Run it through the <a href="/inspect">inspector</a> and it enters the index.'
                : undefined,
            }),
          )}
          ${raw(categoryList(view.categories))}`
      : html`${raw(head)}
          ${raw(
            resultCard({
              title: "Side by side",
              aside: `${view.data.rows.length} endpoint${view.data.rows.length === 1 ? "" : "s"}`,
              body: html`${raw(grid(view))}${raw(rankingLine(view))}`,
              footer: `Empty cells are not zeros. Each one says which state it is in — not in our index, not probed yet, no x402 challenge served, or did not answer.`,
            }),
          )}
          ${raw(notesCard(view.data.notes))}
          ${join(
            view.data.rows.map((row, i) => detailCard(row, view.details[i] as CompareRowDetail)),
          )}
          ${raw(categoryList(view.categories))}`;

  return page({
    title: seoTitle,
    description: summary,
    path: "/compare",
    // Every band on this page is a statement about our observations, and
    // requires the page to say so above the fold.
    observationNote: true,
    canonical: `https://tools.tx402.io${view.path}`,
    body: html`<div class="stack">${raw(body)}</div>`,
  });
}
