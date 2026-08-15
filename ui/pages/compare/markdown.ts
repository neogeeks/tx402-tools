/**
 * The plaintext comparison.
 *
 * `curl -H 'Accept: text/markdown' tools.tx402.io/compare/ai-inference` is a
 * first-class surface: the buyers in this economy are agents, and
 * a comparison table is exactly the thing an agent wants to read before it
 * spends. So the columns are padded to line up in a terminal as well as render
 * as markdown.
 *
 * **This is a RENDERING of `CompareView`, never a second computation** (SPEC
 * §1.2). It takes the view and nothing else — no database, no clock — so the
 * JSON, the markdown and the page cannot disagree about what was observed.
 *
 * Every absent value is a sentence, never a blank or a dash. A reader scanning
 * a column of prices must not be able to mistake "we have not looked yet" for
 * "it is free".
 */

import { TOOLS } from "../../tool-meta.js";
import { publishedCategories } from "./catalogue.js";
import {
  emptyReason,
  priceLabel,
  scoredDownForV1,
  type CategorySummary,
  type CompareRow,
  type CompareRowDetail,
  type CompareView,
} from "./types.js";

/** A pipe inside a cell would end the column; a newline would end the row. */
function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n+/gu, " ");
}

/** A markdown table with padded columns, so it lines up in a terminal too. */
function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const all = [headers, ...rows].map((r) => r.map(cell));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]): string =>
    `| ${r.map((v, i) => (v ?? "").padEnd(widths[i] ?? 0)).join(" | ")} |`;

  return [
    line(all[0] ?? headers),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...all.slice(1).map(line),
  ].join("\n");
}

function name(row: CompareRow, detail: CompareRowDetail): string {
  return row.title ?? detail.host ?? row.url;
}

/**
 * The value, or the reason there isn't one.
 *
 * Not a helper worth skipping: a comparison table's whole liability is the cell
 * that reads as a measurement when it is an absence.
 */
function value(present: string | number | null | undefined, detail: CompareRowDetail): string {
  if (present === null || present === undefined || present === "") {
    return `— ${emptyReason(detail.data_state)}`;
  }
  return String(present);
}

function windowLabel(detail: CompareRowDetail): string {
  if (detail.observation_days === null) return "— not in our index yet";
  // Zero probes is not a zero-day window; it is no window at all. An endpoint
  // sitting in the index unprobed has been *listed* for a while and *observed*
  // never, and only the second is what this column claims.
  if (detail.scan_count === 0) return `— ${emptyReason(detail.data_state)}`;
  const days = detail.observation_days;
  const probes = detail.scan_count;
  const dayLabel = days === 0 ? "under a day" : `${days} day${days === 1 ? "" : "s"}`;
  return `${dayLabel}, ${probes} probe${probes === 1 ? "" : "s"}`;
}

function scoreCell(row: CompareRow, detail: CompareRowDetail): string {
  if (!row.risk) return `— ${emptyReason(detail.data_state)}`;
  // "methodology v1" and "x402 v1" are two different v1s and they would sit in
  // the same cell. Both are spelled out.
  const marker = scoredDownForV1(row, detail) ? " · x402 v1, see notes" : "";
  return `${row.risk.score}/100 ${row.risk.band} (methodology ${row.risk.score_version})${marker}`;
}

function comparisonTable(view: CompareView): string {
  const rows = view.data.rows.map((row, i) => {
    const detail = view.details[i] as CompareRowDetail;
    return [
      name(row, detail),
      value(priceLabel(row.terms), detail),
      value(row.terms?.network, detail),
      value(row.terms?.asset?.symbol ?? row.terms?.asset?.address, detail),
      value(row.terms?.pay_to, detail),
      scoreCell(row, detail),
      windowLabel(detail),
      value(row.terms ? row.last_seen : null, detail),
    ];
  });

  return table(
    [
      "Endpoint",
      "Price per call",
      "Network",
      "Asset",
      "Pays to",
      "Observed signals",
      "Watched for",
      "Terms last observed",
    ],
    rows,
  );
}

function claimsSection(view: CompareView): string {
  const titles = new Map(view.data.rows.map((row, i) => [view.details[i], row.title] as const));
  const withClaims = view.details.filter((d) => d.quality || d.advertised);
  if (withClaims.length === 0) return "";

  const rows = withClaims.map((detail) => [
    titles.get(detail) ?? detail.host ?? detail.url,
    detail.quality?.facilitator_id ?? detail.advertised?.facilitator_id ?? "a facilitator",
    detail.quality?.calls_30d === null || detail.quality?.calls_30d === undefined
      ? "— not published"
      : `${detail.quality.calls_30d} calls in 30 days`,
    detail.quality?.unique_payers_30d === null || detail.quality?.unique_payers_30d === undefined
      ? "— not published"
      : `${detail.quality.unique_payers_30d} unique payers`,
    detail.advertised?.amount ? `${detail.advertised.amount} atomic` : "— not advertised",
  ]);

  return [
    "## What the facilitator claims",
    "",
    "These figures are published by the facilitator that lists the endpoint. They are not our",
    "observations, and they are shown separately from them for that reason. An advertised price and",
    "the price the endpoint actually served us are two different facts, and a disagreement between",
    "them is a finding rather than an error.",
    "",
    table(
      ["Endpoint", "Listed by", "Usage (30d)", "Unique payers (30d)", "Advertised price"],
      rows,
    ),
  ].join("\n");
}

function notesSection(notes: string[]): string {
  if (notes.length === 0) return "";
  return ["## What this table does and does not say", "", ...notes.map((n) => `- ${n}`)].join("\n");
}

function categoryIndex(categories: CategorySummary[]): string {
  const published = categories.filter((c) => c.published);
  if (published.length === 0) return "";

  return [
    "## Categories",
    "",
    table(
      ["Category", "Endpoints", "Page"],
      published.map((c) => [c.title, String(c.endpoint_count), `/compare/${c.slug}`]),
    ),
  ].join("\n");
}

const OBSERVATION_NOTE = [
  "> These are observations, not accusations. A band of LOW, MEDIUM or HIGH describes how much of",
  "> what we check we were able to confirm — it is not a judgement about the operator of an",
  "> endpoint. Every signal, its weight and its rationale are published at /methodology, and any",
  "> operator can claim an endpoint, correct a fact or opt out at /crawler.",
].join("\n");

export function compareMarkdown(view: CompareView): string {
  const category = view.data.category;
  const heading = category?.title ?? TOOLS.compare.h1;
  const lede = category?.summary ?? TOOLS.compare.description;

  const parts: string[] = [`# ${heading}`, "", lede, "", OBSERVATION_NOTE, ""];

  if (view.data.rows.length === 0) {
    parts.push(
      category
        ? "No endpoints are in this category yet. That is what we know, not a claim that none exists — the corpus fills from the facilitators' own listings on a 15-minute cycle."
        : "Give this page endpoints to compare: `/compare?urls=https://a.example/api,https://b.example/api`, or open one of the categories below.",
      "",
    );
    const index = categoryIndex(view.categories);
    if (index) parts.push(index, "");
    parts.push(footer(view));
    return `${parts.filter((p, i, all) => !(p === "" && all[i - 1] === "")).join("\n")}\n`;
  }

  parts.push(comparisonTable(view), "");

  if (view.ranking.refused) {
    parts.push(
      `**Not ranked by ${view.ranking.refused.key}.** ${view.ranking.refused.reason}`,
      "",
    );
  } else if (view.ranking.applied !== "given") {
    parts.push(`Sorted by ${view.ranking.applied}.`, "");
  }

  const claims = claimsSection(view);
  if (claims) parts.push(claims, "");

  const notes = notesSection(view.data.notes);
  if (notes) parts.push(notes, "");

  parts.push(footer(view));

  return `${parts.filter((p, i, all) => !(p === "" && all[i - 1] === "")).join("\n")}\n`;
}

function footer(view: CompareView): string {
  const json = view.data.category
    ? `/api/v1/compare?category=${view.data.category.slug}`
    : "/api/v1/compare?urls=…";

  return [
    "---",
    "",
    `JSON: \`${json}\` · full per-endpoint records: \`/api/v1/endpoints\` · categories: \`/api/v1/categories\``,
    "",
    "Every figure here is something we observed by asking the endpoint, except where it is labelled as",
    "a facilitator's claim. Nothing on this page is a statement about an operator.",
  ].join("\n");
}

/** The category index on its own, for the hub page's markdown mirror. */
export function categoriesMarkdown(categories: CategorySummary[]): string {
  return [
    `# ${TOOLS.compare.h1}`,
    "",
    TOOLS.compare.description,
    "",
    categoryIndex(categories),
    "",
    `${publishedCategories().length} published categories.`,
    "",
  ].join("\n");
}
