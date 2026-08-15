/**
 * The `text/markdown` mirror of `/history` (SPEC §1.2).
 *
 * A **rendering of the same `HistoryView`** the JSON carries, never a second
 * computation. It is handed the identical data and warnings the page gets, and
 * pulls its copy from the same constants in `./types.ts`, so the two cannot
 * describe the same number differently.
 *
 * ── The thing that must survive the trip into plain text ──────────────────
 *
 * There is no border, no hatching and no dashed stroke here, so the whole
 * weight of distinction falls on the words and the layout. Two
 * headed sections, never one table; every sampled figure carries `≈` and the
 * word "sampled"; every exact entry carries a date and no `≈`. An agent reading
 * only this must come away able to say which of two numbers it could quote to a
 * merchant.
 *
 * The buyers in this economy are agents, so this is a first-class
 * surface: `curl -H 'Accept: text/markdown' tools.tx402.io/history?url=…`
 * should be genuinely readable.
 */

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
} from "./types.js";

export interface HistoryMarkdownOptions {
  view: HistoryView;
  /** The envelope this is a rendering of; read for its stamps, never recomputed. */
  envelope: unknown;
}

const RULE = "─".repeat(72);

function generatedAt(envelope: unknown): string {
  const at = (envelope as { generated_at?: unknown } | null)?.generated_at;
  return typeof at === "string" ? at : new Date().toISOString().slice(0, 19) + "Z";
}

export function historyMarkdown(opts: HistoryMarkdownOptions): string {
  const { view } = opts;
  const now = generatedAt(opts.envelope);
  const { data } = view;
  const lines: string[] = ["# 402 History", ""];

  if (!data.target.url) {
    lines.push(
      "Pass a URL to see how an endpoint's terms have moved.",
      "",
      "```",
      "GET /history?url=https://api.example.com/v1/geocode&window=30d",
      "```",
      "",
      "`window` is one of `7d`, `30d`, `90d`. History reads what we have already observed;",
      "it never probes the endpoint.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    `**${data.target.canonical_url ?? data.target.url}**`,
    "",
    `Window: last ${data.window.replace("d", " days")} · generated ${formatDateTime(now)}`,
    "",
  );

  if (view.warnings.some((w) => w.code === WARN.NOT_IN_CORPUS)) {
    lines.push(
      `## ${NOT_IN_CORPUS_TITLE}`,
      "",
      NOT_IN_CORPUS_BODY,
      "",
      "Inspect it to see what it charges today:",
      "",
      "```",
      `GET /inspect?url=${data.target.url}`,
      "```",
      "",
    );
    return lines.join("\n");
  }

  // ── the two sources, stated before either is read ──────────────────────
  lines.push(
    "## Two kinds of number on this page",
    "",
    `- **${EXACT_HEADING}** (${EXACT_LABEL}) — ${EXACT_LEAD}`,
    `- **${SAMPLED_HEADING}** (${SAMPLED_LABEL}) — ${SAMPLED_LEAD}`,
    "",
    `Every sampled figure below is prefixed \`${APPROX}\`. No exact figure is.`,
    "",
    RULE,
    "",
  );

  // ── exact ───────────────────────────────────────────────────────────────
  lines.push(`## ${EXACT_HEADING} — ${EXACT_LABEL}`, "");

  const thin = warningMessage(view, WARN.THIN_HISTORY);
  if (thin) lines.push(`> **Short record.** ${thin}`, "");

  const anchor = warningMessage(view, WARN.PRICE_ANCHOR_BEFORE_WINDOW);
  if (anchor) lines.push(`> ${anchor}`, "");

  if (data.series.price.length > 0) {
    lines.push("### Price, as observed", "", "| Observed at | Price | Network |", "| --- | --- | --- |");
    for (const point of data.series.price) {
      lines.push(`| ${formatDateTime(point.t)} | ${formatPrice(point)} | ${point.network ?? "—"} |`);
    }
    lines.push("", "The price held at each value until the next row. No value here is interpolated.", "");
  } else {
    lines.push(
      "### Price, as observed",
      "",
      "No price on record for this window.",
      "",
    );
  }

  lines.push("### Changes", "");
  if (data.changes.length === 0) {
    lines.push(
      "No changes in this window. The log records changes, so an empty log means the terms held —",
      "that is a finding, not a gap.",
      "",
    );
  } else {
    for (const change of [...data.changes].reverse()) {
      lines.push(`- **${formatDate(change.changed_at)}** — ${describeChange(change)}`);
      lines.push(
        `  Observed ${formatDateTime(change.changed_at)}, recorded by ${change.detected_by ?? "crawler"}` +
          (change.score_version ? `, scoring in force then: ${change.score_version}` : "") +
          ".",
      );
    }
    lines.push("");
  }

  lines.push(
    "Written to an append-only log that a database trigger will not let anyone update or delete.",
    "A mistake is corrected by appending a correction row, never by editing one.",
    "",
    RULE,
    "",
  );

  // ── sampled ─────────────────────────────────────────────────────────────
  lines.push(`## ${SAMPLED_HEADING} — ${SAMPLED_LABEL}`, "");

  const state = samplingState(view);

  if (state === "unavailable") {
    lines.push(
      `### ${ANALYTICS_UNAVAILABLE_TITLE}`,
      "",
      ANALYTICS_UNAVAILABLE_BODY,
      "",
      `> ${warningMessage(view, WARN.ANALYTICS_UNAVAILABLE) ?? ""}`,
      "",
    );
  } else if (state === "no_samples") {
    lines.push(`### ${NO_SAMPLES_TITLE}`, "", NO_SAMPLES_BODY, "");
  } else {
    const availability = data.series.availability;
    const totalSamples = availability.reduce((sum, p) => sum + p.samples, 0);
    const weighted = availability.reduce((sum, p) => sum + p.ratio * p.samples, 0);
    const ratio = totalSamples > 0 ? weighted / totalSamples : null;

    const latency = data.series.latency;
    const latencySamples = latency.reduce((sum, p) => sum + p.samples, 0);
    const p50 =
      latencySamples > 0
        ? latency.reduce((sum, p) => sum + (p.p50_ms ?? 0) * p.samples, 0) / latencySamples
        : null;
    const p95Points = latency.filter((p) => p.p95_ms !== null);
    const p95 = p95Points.length > 0 ? Math.max(...p95Points.map((p) => p.p95_ms as number)) : null;

    lines.push(
      `- Availability over ${data.window}: **${ratio === null ? "not observed" : formatRatio(ratio)}** (sampled)`,
      `- Median response: **${formatMs(p50)}** (sampled)`,
      `- Slowest 5%: **${formatMs(p95)}** (sampled)`,
      `- Probe samples in window: ${APPROX}${totalSamples}`,
      "",
    );

    if (availability.length > 0) {
      lines.push("### Availability by bucket (sampled)", "", "| Bucket | Availability | Samples |", "| --- | --- | --- |");
      for (const point of availability) {
        lines.push(`| ${formatDateTime(point.t)} | ${formatRatio(point.ratio)} | ${APPROX}${point.samples} |`);
      }
      lines.push("");
    }

    if (latency.length > 0) {
      lines.push("### Latency by bucket (sampled)", "", "| Bucket | Median | 95th | Samples |", "| --- | --- | --- | --- |");
      for (const point of latency) {
        lines.push(
          `| ${formatDateTime(point.t)} | ${formatMs(point.p50_ms)} | ${formatMs(point.p95_ms ?? null)} | ${APPROX}${point.samples} |`,
        );
      }
      lines.push("");
    }

    lines.push(
      "Aggregated by total sample weight, not by counting stored rows: the dataset samples under load,",
      "so counting rows would under-report exactly when an endpoint is busiest.",
      "",
    );
  }

  const pending = warningMessage(view, WARN.RECENT_PROBE_PENDING);
  if (pending) lines.push(`> **Just probed.** ${pending}`, "");

  // ── coverage ────────────────────────────────────────────────────────────
  const age = daysBetween(data.coverage.first_seen, now);
  lines.push(
    RULE,
    "",
    "## What we have",
    "",
    `- First observed: ${data.coverage.first_seen ? formatDate(data.coverage.first_seen) : "never observed"}` +
      (age === null ? "" : age === 0 ? " (today — our record begins here)" : ` (${age} days of record)`),
    `- Last observed: ${data.coverage.last_seen ? formatDateTime(data.coverage.last_seen) : "never observed"}`,
    `- Probes recorded: ${data.coverage.scan_count}`,
    `- Contains sampled figures: ${data.coverage.sampled ? "yes — availability and latency are estimates" : "no — everything above is an exact record"}`,
    "",
  );

  return lines.join("\n");
}
