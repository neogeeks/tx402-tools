/**
 * Rendering, for a reader that is a model rather than a browser.
 *
 * Two constraints shape everything here, and neither is stylistic.
 *
 * **A tool result has no page around it.** Every caveat a web page puts in a
 * footer, a tooltip or a muted italic has to be in the text, next to the thing
 * it qualifies, because there is nowhere else for it to go. That is why a band
 * is never emitted without `BAND_FRAMING`, and why the skip/unobserved rules are
 * printed in the result rather than assumed.
 *
 * **The reader will count rows.** So `skip` gets its own labelled section instead of a fourth
 * status mixed into a list of checks — a model summarising "21 checks, 20 passed" from a mixed list
 * is exactly the failure. decision 5 warns about, and section headings are the cheapest way to make
 * the difference impossible to miss.
 */

import {
  BAND_FRAMING,
  LIST_FRAMING,
  NO_HISTORY_FRAMING,
  SKIP_FRAMING,
  UNOBSERVED_FRAMING,
} from "./language.js";
import type {
  Check,
  CheckStatus,
  Observed,
  ProbeMeta,
  Requirement,
  Risk,
  Signal,
  TermChange,
} from "./types.js";

const LABEL: Record<CheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
};

export interface CheckTally {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export function tally(checks: readonly Check[]): CheckTally {
  const counts: CheckTally = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/**
 * "20 passed, 1 warned, 3 could not run" — never "23 checks".
 *
 * A skipped check is counted separately and named "could not run" in the same
 * breath, so the total can never be read as a total of checks that ran.
 */
export function tallySentence(counts: CheckTally): string {
  const parts: string[] = [];
  if (counts.fail > 0) parts.push(`${counts.fail} failed`);
  if (counts.warn > 0) parts.push(`${counts.warn} warned`);
  if (counts.pass > 0) parts.push(`${counts.pass} passed`);
  if (counts.skip > 0) parts.push(`${counts.skip} could not run`);
  return parts.length > 0 ? parts.join(", ") : "no checks ran";
}

/** One check, as one line, with its reason and detail folded in. */
function checkLine(check: Check): string {
  const head = `  ${LABEL[check.status]}  ${check.id}`;
  const said = check.detail ?? reasonSentence(check.reason);
  return said ? `${head}\n        ${said}` : head;
}

function reasonSentence(reason: string | null | undefined): string {
  if (!reason) return "";
  return reason.replace(/[_-]/gu, " ");
}

/**
 * Checks, in two labelled groups.
 *
 * The order within a group is the order the caller supplied, which for
 * `verifyOffline` is SPEC §5.2.1's frozen order — a report that reads the same
 * way every time is worth more to a model than one sorted by severity, because
 * a stable order is what makes two reports comparable.
 */
export function renderChecks(checks: readonly Check[]): string {
  const ran = checks.filter((c) => c.status !== "skip");
  const skipped = checks.filter((c) => c.status === "skip");

  const sections: string[] = [];

  sections.push(
    ran.length > 0
      ? `Checks that ran (${ran.length})\n${ran.map(checkLine).join("\n")}`
      : "Checks that ran (0)\n  None. Nothing in what was supplied could be checked.",
  );

  if (skipped.length > 0) {
    sections.push(
      `Checks that could not run (${skipped.length})\n` +
        `  ${SKIP_FRAMING}\n` +
        skipped.map(checkLine).join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * The terms as the challenge declares them.
 *
 * `amount_atomic` leads and `amount_decimal` follows in parentheses, in that
 * order, because SPEC §1.4 makes the atomic string the value and the decimal a
 * display-only derivation — putting the human-readable number first invites
 * arithmetic on the one field that must never carry any.
 */
export function renderTerms(terms: Requirement | null): string {
  if (!terms) {
    return "Terms as declared\n  None. The challenge declares no readable payment requirement.";
  }

  const rows: [string, string][] = [];

  rows.push(["amount", renderAmount(terms)]);
  rows.push(["network", renderNetwork(terms)]);
  rows.push(["recipient", renderRecipient(terms)]);
  rows.push(["scheme", terms.scheme ?? "not declared"]);
  rows.push([
    "window",
    terms.max_timeout_seconds === null
      ? "not declared"
      : `${terms.max_timeout_seconds}s authorization window`,
  ]);
  rows.push(["resource", terms.resource ?? "not declared"]);
  if (terms.description) rows.push(["description", terms.description]);
  if (terms.mime_type) rows.push(["media type", terms.mime_type]);
  if (terms.facilitator) rows.push(["facilitator", terms.facilitator]);

  const width = Math.max(...rows.map(([k]) => k.length));
  const body = rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join("\n");
  return `Terms as declared\n${body}`;
}

function renderAmount(terms: Requirement): string {
  const { amount_atomic: atomic, amount_decimal: decimal, asset } = terms;
  if (atomic === null) {
    return "not a canonical atomic integer — see the amount checks below";
  }
  const symbol = asset?.symbol ?? "units";
  const human = decimal === null ? "" : ` = ${decimal} ${symbol}`;
  const assetNote =
    asset === null
      ? " · no asset declared"
      : asset.recognized === true
        ? " · asset is in the tx402 signed release manifest"
        : " · asset is not in the tx402 signed release manifest";
  return `${atomic} atomic${human}${assetNote}`;
}

function renderNetwork(terms: Requirement): string {
  if (terms.network === null) return "not declared";
  const note =
    terms.network_recognized === true
      ? " · in the tx402 signed release manifest"
      : terms.network_recognized === false
        ? " · not in the tx402 signed release manifest"
        : "";
  return `${terms.network}${note}`;
}

function renderRecipient(terms: Requirement): string {
  if (terms.pay_to === null) return "not declared";
  // SPEC §6.4 and the dynamic-payTo carve-out: a per-request payout address is
  // a marketplace pattern that x402 v2 defines, so it is reported as what it is
  // rather than as an anomaly.
  return terms.pay_to_dynamic === true
    ? `${terms.pay_to} (declared dynamic — x402 v2 permits a per-request payout address)`
    : terms.pay_to;
}

/**
 * The risk block. **The band never leaves this function without its framing.**
 */
export function renderRisk(risk: Risk | null): string {
  if (!risk) {
    return "Observed signals\n  Not scored. There were not enough observations to produce a score.";
  }

  const confidence =
    risk.confidence === "static_only"
      ? "static_only — scored from the challenge alone, with no observation history"
      : "with_history — scored with observation history for this endpoint";

  const reasons = risk.reasons
    .map((r) => `  ${LABEL[r.status]}  ${r.signal_id} (weight ${r.weight})\n        ${r.message}`)
    .join("\n");

  return [
    `Observed signals: ${risk.score}/100, band ${risk.band} (${risk.score_version})`,
    `  ${BAND_FRAMING}`,
    `  Higher means more of what we check checked out. Confidence: ${confidence}.`,
    `  ${risk.signals_evaluated} signals evaluated. Methodology: ${risk.methodology_url}`,
    reasons ? `\n${reasons}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Signals, with the unobserved ones grouped by the reason they were not
 * observed.
 *
 * Same reasoning as the skip section — `observed: false` printed as a value in a
 * list is one careless summary away from becoming a negative finding — with one
 * addition that is about the reader rather than the rule. Thirteen unobserved
 * signals repeating five distinct sentences is thirteen lines a model has to
 * hold, and the repetition itself carries no information. Grouping by reason
 * says the same thing in five, which leaves more of the reader's attention for
 * the checks that did run.
 *
 * The full per-signal detail is in `structuredContent`, so nothing is lost:
 * SPEC §4.5's reproducibility is a property of the data, not of the prose.
 */
export function renderSignals(signals: readonly Signal[]): string {
  if (signals.length === 0) return "";

  const observed = signals.filter((s) => s.observed);
  const unobserved = signals.filter((s) => !s.observed);

  const sections: string[] = [];

  if (observed.length > 0) {
    sections.push(
      `Signals observed (${observed.length})\n` +
        wrap(observed.map((s) => `${s.id}=${formatValue(s.value)}`).join(", "), "  "),
    );
  }

  if (unobserved.length > 0) {
    const groups = new Map<string, string[]>();
    for (const signal of unobserved) {
      const reason = signal.detail ?? "Not observed.";
      const ids = groups.get(reason) ?? [];
      ids.push(signal.id);
      groups.set(reason, ids);
    }
    const body = [...groups]
      .map(([reason, ids]) => `  ${reason}\n${wrap(ids.join(", "), "      ")}`)
      .join("\n");
    sections.push(
      `Signals we could not determine (${unobserved.length})\n  ${UNOBSERVED_FRAMING}\n${body}`,
    );
  }

  return sections.join("\n\n");
}

function formatValue(value: boolean | number | string | null): string {
  return value === null ? "null" : typeof value === "string" ? value : String(value);
}

/** Soft-wrap a comma-joined list at a readable width, one indent per line. */
function wrap(text: string, indent: string, width = 96): string {
  const lines: string[] = [];
  let current = indent;
  for (const piece of text.split(", ")) {
    const candidate = current === indent ? `${indent}${piece}` : `${current}, ${piece}`;
    if (candidate.length > width && current !== indent) {
      lines.push(`${current},`);
      current = `${indent}${piece}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines.join("\n");
}

/**
 * The observation history, including its honest empty state.
 *
 * SPEC §5.1: `has_history: false` is a correct answer, not an error. The Inspector
 * ships before the corpus is complete and an endpoint nobody has scanned has to
 * render as a normal state — so the empty case gets a full sentence saying so,
 * not a blank.
 */
export function renderObserved(observed: Observed): string {
  if (!observed.has_history) {
    return `Observation history\n  ${NO_HISTORY_FRAMING}`;
  }

  const rows: [string, string][] = [
    ["first seen", observed.first_seen ?? "not recorded"],
    ["last seen", observed.last_seen ?? "not recorded"],
    ["scans", String(observed.scan_count)],
    [
      "availability 30d",
      observed.availability_30d === null
        ? "not observed"
        : `${(observed.availability_30d * 100).toFixed(2)}%`,
    ],
    [
      "latency p50",
      observed.latency_p50_ms === null ? "not observed" : `${observed.latency_p50_ms}ms`,
    ],
  ];

  const width = Math.max(...rows.map(([k]) => k.length));
  const body = rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join("\n");

  const changes =
    observed.recent_changes.length > 0
      ? `\n  Recorded changes\n${observed.recent_changes.map(changeLine).join("\n")}`
      : "\n  No recorded changes to the terms since we first saw this endpoint.";

  // `has_history` can be true on an endpoint's very first scan — the hosted
  // route writes the corpus row before it reads it back — while every other
  // field in the same object says otherwise: one scan, no availability, and the
  // corpus-dependent checks reporting `skip / no_history`. A model reading
  // "has history" off one field and stopping would draw the wrong conclusion,
  // so the disagreement is stated rather than smoothed over. Recorded for the
  // wave-4 integrator.
  const firstOnly =
    observed.scan_count <= 1
      ? "\n  This is the first recorded observation of this endpoint, so there is nothing yet to compare\n" +
        "  it against. The checks that need observation history report SKIP."
      : "";

  return `Observation history\n${body}${firstOnly}${changes}`;
}

/** "recipient changed on 2026-07-21" — the phrasing names. */
function changeLine(change: TermChange): string {
  const day = change.changed_at.slice(0, 10);
  const from = change.old_value === null ? "not previously recorded" : change.old_value;
  const to = change.new_value === null ? "no longer declared" : change.new_value;
  return `    ${change.change_kind} changed on ${day}: ${change.field} ${from} → ${to}`;
}

export function renderProbe(probe: ProbeMeta | null): string {
  if (!probe) {
    return "Probe\n  The endpoint was not contacted on this call.";
  }
  const cache = probe.served_from_cache
    ? `served from the politeness cache${
        probe.cache_age_seconds === null ? "" : `, ${probe.cache_age_seconds}s old`
      }`
    : "fetched live";
  const status = probe.http_status === null ? "no status" : `HTTP ${probe.http_status}`;
  const latency = probe.latency_ms === null ? "" : `, ${probe.latency_ms}ms`;
  const tls = probe.tls ? `, TLS ${probe.tls.protocol ?? (probe.tls.ok ? "ok" : "not ok")}` : "";
  return `Probe\n  ${status}${latency}${tls}, ${probe.redirect_count} redirects, observed at ${probe.observed_at} (${cache})`;
}

/** Always the last block, so the caveats are the last thing read. */
export function footer(): string {
  return [
    "How to read this",
    `  ${SKIP_FRAMING}`,
    `  ${UNOBSERVED_FRAMING}`,
    `  ${LIST_FRAMING}`,
    "  Everything above is an observation about a challenge or about an endpoint's public behaviour.",
    "  None of it is a claim about whoever operates the endpoint.",
  ].join("\n");
}

export function section(...blocks: (string | null | undefined | false)[]): string {
  return blocks.filter((b): b is string => typeof b === "string" && b.length > 0).join("\n\n");
}
