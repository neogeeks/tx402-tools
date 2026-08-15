/**
 * The plaintext report.
 *
 * `curl -H 'Accept: text/markdown' tools.tx402.io/inspect?url=…` is a
 * first-class surface, not a fallback: the buyers in this economy
 * are agents, and this is what they read. So the tables are padded to align in
 * a terminal as well as render as markdown, and the report says the same things
 * in the same order as the page.
 *
 * **This is a RENDERING of `InspectData`, never a second computation** (SPEC
 * §1.2). It takes the view and nothing else — no probe result, no database, no
 * clock — so the JSON and the markdown cannot disagree. Every risk band and
 * every reason string below comes verbatim from `worker/lib/score.ts`; nothing
 * here restates, softens or embellishes one.
 */

import { TOOLS } from "../../tool-meta.js";
import {
  BAND_NOTE,
  NOT_X402_NOTE,
  NO_HISTORY_NOTE,
  V1_NOTE,
  isLegacyV1,
  latencyLabel,
  outcomeOf,
  priceLabel,
  termsAccepted,
  wireFormLabel,
} from "./types.js";
import type { Check, InspectView, Requirement } from "./types.js";
import { cliSnippet, pythonSnippet, typescriptSnippet } from "./snippets.js";

// ── table rendering ───────────────────────────────────────────────────────

type Row = [string, string];

/** A pipe inside a cell would end the column. */
function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n+/gu, " ");
}

/**
 * A markdown table with padded columns.
 *
 * The padding is the point: this renders correctly in a markdown viewer AND
 * lines up in a terminal, which is where most of its readers are.
 */
function table(headers: Row, rows: Row[]): string {
  if (rows.length === 0) return "";
  const all: Row[] = [headers, ...rows.map((r): Row => [cell(r[0]), cell(r[1])])];
  const left = Math.max(...all.map((r) => r[0].length));
  const right = Math.max(...all.map((r) => r[1].length));

  const line = (r: Row): string => `| ${r[0].padEnd(left)} | ${r[1].padEnd(right)} |`;

  return [
    line(headers),
    `| ${"-".repeat(left)} | ${"-".repeat(right)} |`,
    ...all.slice(1).map((r) => line(r)),
  ].join("\n");
}

/** Rows whose value is absent say so, rather than being dropped or blanked. */
function row(label: string, value: string | number | null | undefined, absent = "not observed"): Row {
  return [label, value === null || value === undefined || value === "" ? absent : String(value)];
}

// ── sections ──────────────────────────────────────────────────────────────

function endpointSection(view: InspectView): string {
  const { data } = view;
  const { probe, challenge, target } = data;

  const rows: Row[] = [
    row("URL", target.url),
    row("Canonical", target.canonical_url),
    row("Endpoint id", target.endpoint_id),
    row("HTTP status", probe?.http_status),
    row("Latency", latencyLabel(probe)),
    row("Redirects", probe?.redirect_count),
    row("TLS", probe?.tls === null || probe?.tls === undefined ? null : probe.tls.ok ? "handshake ok" : "not verified"),
    row("Wire form", wireFormLabel(challenge)),
    row("Bytes read", probe?.bytes_read),
    row("Observed at", probe?.observed_at),
  ];

  if (view.envelope.meta.cached) {
    rows.push([
      "Served from",
      `the per-endpoint politeness cache, ${view.envelope.meta.cache_age_seconds ?? 0}s old`,
    ]);
  }

  // Only reported when a challenge was actually served. "The decoder refused
  // it" is a finding about a challenge; saying it about a plain web page would
  // describe a verdict on something that was never submitted for one.
  if (challenge && challenge.wire_form !== "none") {
    rows.push(
      challenge.valid
        ? ["Decoder", "accepted — decodePaymentRequired from tx402"]
        : ["Decoder", `refused — ${challenge.decode_error?.code ?? "unknown"}`],
    );
    if (!challenge.valid && challenge.decode_error) {
      rows.push(["Decoder detail", challenge.decode_error.message]);
    }
  }

  return `## ENDPOINT\n\n${table(["Field", "Value"], rows)}`;
}

function requirementRows(terms: Requirement): Row[] {
  return [
    row("Price", priceLabel(terms)),
    row("Amount (atomic)", terms.amount_atomic ?? terms.amount_raw),
    row("Scheme", terms.scheme),
    row(
      "Network",
      terms.network === null
        ? null
        : `${terms.network}${terms.network_recognized === true ? " · in the tx402 signed manifest" : terms.network_recognized === false ? " · not in the tx402 signed manifest" : ""}`,
    ),
    row(
      "Asset",
      terms.asset === null
        ? null
        : `${terms.asset.symbol ?? "unknown symbol"} ${terms.asset.address ?? ""}`.trim() +
          (terms.asset.recognized === true
            ? " · in the manifest"
            : terms.asset.recognized === false
              ? " · not in the manifest"
              : ""),
    ),
    row("Pay to", terms.pay_to),
    row(
      "Pay to declared dynamic",
      terms.pay_to_dynamic === null ? null : terms.pay_to_dynamic ? "yes — a role constant, not a fixed address" : "no",
    ),
    row(
      "Authorization window",
      terms.max_timeout_seconds === null ? null : `${terms.max_timeout_seconds}s`,
    ),
    row("Resource", terms.resource),
    row("MIME type", terms.mime_type),
    row("Description", terms.description),
    row("Facilitator", terms.facilitator),
  ];
}

function paymentSection(view: InspectView): string {
  const { data } = view;
  const outcome = outcomeOf(data);

  if (outcome === "not_x402") {
    return "## PAYMENT\n\nThis endpoint served no x402 payment challenge, so there are no terms to report.";
  }

  if (!data.terms) {
    return "## PAYMENT\n\nAn x402 challenge was served, but no payment requirement could be parsed out of it.";
  }

  const accepted = termsAccepted(data);
  const lede = accepted
    ? "These terms were accepted by the strict decoder tx402 uses before it pays."
    : // SPEC §4.2: a refused challenge exposes no accepted
      // requirements, and what is shown here was parsed for diagnosis only. It
      // must never read as if the challenge validated.
      "⚠️ The decoder REFUSED this challenge. The terms below were parsed from what the endpoint served so that " +
      "whoever maintains it can see what we saw — they are **not** terms tx402 would pay.";

  const parts = [`## PAYMENT\n\n${lede}\n\n${table(["Field", "Value"], requirementRows(data.terms))}`];

  const others = data.challenge?.accepts ?? [];
  if (others.length > 1) {
    parts.push(
      `This endpoint offers ${others.length} ways to pay. The report describes the first, which is the ` +
        "order the server stated its own preference in.\n\n" +
        table(
          ["#", "Requirement"],
          others.map((r, i): Row => [
            String(i + 1),
            `${priceLabel(r) ?? "amount not parsed"} · ${r.network ?? "no network"} · ${r.scheme ?? "no scheme"}`,
          ]),
        ),
    );
  }

  return parts.join("\n\n");
}

function observedSection(view: InspectView): string {
  const { observed } = view.data;

  if (!observed.has_history) {
    return `## OBSERVED\n\n${NO_HISTORY_NOTE}\n\nThat is the normal state for an endpoint we have not seen before, and it is what this section will say for any endpoint until the corpus has watched it for a while.`;
  }

  const rows: Row[] = [
    row("First seen", observed.first_seen),
    row("Last seen", observed.last_seen),
    row("Scans recorded", observed.scan_count),
    row("Availability (30d)", observed.availability_30d, "not measured yet"),
    row("Latency p50", observed.latency_p50_ms, "not measured yet"),
  ];

  const parts = [`## OBSERVED\n\n${table(["Field", "Value"], rows)}`];

  if (observed.recent_changes.length > 0) {
    parts.push(
      table(
        ["Changed at", "What changed"],
        observed.recent_changes.map((c): Row => [
          c.changed_at,
          `${c.change_kind}: ${c.field} ${c.old_value ?? "—"} → ${c.new_value ?? "—"}`,
        ]),
      ),
    );
  } else {
    parts.push("No recorded changes to this endpoint's terms.");
  }

  return parts.join("\n\n");
}

const CHECK_MARK: Record<Check["status"], string> = {
  pass: "pass",
  warn: "warn",
  fail: "FAIL",
  skip: "skip",
};

function securitySection(view: InspectView): string {
  const { checks } = view.data;
  if (checks.length === 0) {
    return "## SECURITY\n\nNo checks ran, because there was nothing to check.";
  }

  const rows = checks.map((c): Row => [
    `${CHECK_MARK[c.status]}  ${c.id}`,
    c.detail ?? c.reason ?? "—",
  ]);

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const skipped = checks.filter((c) => c.status === "skip").length;

  // The decode verdict is not one of the frozen check ids, so it has to be
  // stated here explicitly. Without it, a refused challenge could produce
  // "16 checks ran and none failed" directly beneath a headline saying the
  // decoder rejected it — which is how a report stops being trusted.
  const outcome = outcomeOf(view.data);
  const counts =
    failed === 0 && warned === 0
      ? `${checks.length - skipped} checks ran and none failed.`
      : `${failed} failed, ${warned} warned, ${checks.length - skipped - failed - warned} passed.`;

  const summary =
    outcome === "not_x402"
      ? "This URL served no x402 challenge, so the only check that could run is the one that looks for one."
      : outcome === "malformed"
        ? `**The strict decoder refused this challenge** (\`${view.data.challenge?.decode_error?.code ?? "unknown"}\`), which is the finding that matters most here. ${counts} Those checks describe what could still be determined from what the endpoint served.`
        : counts;

  return [
    "## SECURITY",
    "",
    `${summary} A check that could not run reports \`skip\` and is never counted as a pass.`,
    "",
    table(["Check", "Detail"], rows),
  ].join("\n");
}

function riskSection(view: InspectView): string {
  const { risk } = view.data;

  if (risk === null) {
    return `## RISK — not an x402 endpoint\n\n${NOT_X402_NOTE}`;
  }

  const header = `## RISK — ${risk.band}  (${risk.score}/100)`;
  const meta = `score_version \`${risk.score_version}\` · confidence \`${risk.confidence}\` · ${risk.signals_evaluated} signals scored`;

  // Reasons are printed VERBATIM from score.ts. Weights are included because
  // reproducibility from the same response IS the appeal mechanism
  // — adding these up reproduces the number above.
  const reasons = table(
    ["Signal", "Weight  Finding"],
    risk.reasons.map((r): Row => [
      `${r.status.padEnd(4)}  ${r.signal_id}`,
      `${String(r.weight).padStart(3)}     ${r.message}`,
    ]),
  );

  const parts = [header, "", meta, "", BAND_NOTE, ""];
  if (isLegacyV1(view.data)) parts.push(V1_NOTE, "");
  parts.push(reasons, "", `Methodology: ${view.data.links.methodology ?? "/methodology"}`);
  return parts.join("\n");
}

function ctaSection(view: InspectView): string {
  const { data } = view;
  if (!data.target.url || outcomeOf(data) === "not_x402") return "";

  return [
    "## TEST WITH TX402",
    "",
    "Nothing below sends a key anywhere. tx402 commits policy and budget before the signer is reachable,",
    "so a refusal is a payment that was never authorized.",
    "",
    "```bash",
    cliSnippet(data).trimEnd(),
    "```",
    "",
    "```ts",
    typescriptSnippet(data).trimEnd(),
    "```",
    "",
    "```python",
    pythonSnippet(data).trimEnd(),
    "```",
  ].join("\n");
}

function footer(view: InspectView): string {
  const { links } = view.data;
  const lines = [
    "---",
    "",
    "| Representation | URL |",
    "| -------------- | --- |",
    `| HTML     | ${links.html ?? "—"} |`,
    `| Markdown | ${links.markdown ?? "—"} |`,
    `| JSON     | ${links.json ?? "—"} |`,
  ];
  if (links.history) lines.push(`| History  | ${links.history} |`);
  if (links.share) lines.push(`| Snapshot | ${links.share} |`);

  lines.push(
    "",
    `Decoded by \`tx402@${view.envelope.meta.tx402_version ?? "unknown"}\` — the same strict decoder the SDK runs before it pays.`,
  );
  return lines.join("\n");
}

// ── the report ────────────────────────────────────────────────────────────

/** The one-line answer, for a reader who stops after the first paragraph. */
function headline(view: InspectView): string {
  const { data } = view;
  switch (outcomeOf(data)) {
    case "no_input":
      return "";
    case "not_x402":
      return `**Not an x402 endpoint.** \`${data.target.url}\` answered with HTTP ${data.probe?.http_status ?? "?"} and no payment challenge.`;
    case "malformed":
      return `**Challenge served, decoder refused it.** \`${data.target.url}\` — ${data.challenge?.decode_error?.message ?? "the challenge did not decode"}`;
    case "valid": {
      const price = priceLabel(data.terms);
      const band = data.risk ? ` · risk ${data.risk.band} (${data.risk.score}/100, ${data.risk.score_version})` : "";
      return `**${price ?? "Price not parsed"} per request** on \`${data.terms?.network ?? "an undeclared network"}\`${band}`;
    }
  }
}

/** The usage note a reader gets when they asked for the report with no URL. */
function usage(view: InspectView): string {
  const { origin } = view;
  return [
    `# ${TOOLS.inspect.h1}`,
    "",
    TOOLS.inspect.description,
    "",
    "## USAGE",
    "",
    "```bash",
    `curl -H 'Accept: text/markdown' '${origin}/inspect?url=https://api.example.com/v1/geocode'`,
    `curl -H 'Accept: application/json' '${origin}/api/v1/inspect?url=https://api.example.com/v1/geocode'`,
    "```",
    "",
    table(
      ["Parameter", "Meaning"],
      [
        ["url", "Required. The https URL of the endpoint to inspect. http: is not probed by the hosted service."],
        ["format", "Optional. `json`, `md` or `html`. Beats the Accept header, so a link can pin a representation."],
      ],
    ),
    "",
    "The report is ENDPOINT / PAYMENT / OBSERVED / SECURITY / RISK. Every risk band is produced by a published,",
    `versioned pure function — the weights are at ${origin}/methodology.`,
    "",
    "One live probe is made per endpoint per politeness window no matter how many people ask; everyone else is",
    "served the cached result with its age in `meta.cache_age_seconds`. This service never pays and never",
    "constructs a payment.",
    "",
  ].join("\n");
}

export function inspectMarkdown(view: InspectView): string {
  if (outcomeOf(view.data) === "no_input") return usage(view);

  const snapshot = view.snapshot
    ? [
        `> **This is a snapshot**, not a live scan. It was observed at ${view.data.probe?.observed_at ?? "an earlier time"}`,
        `> and stored on ${view.snapshot.created_at}. The endpoint may have changed since. It expires ${view.snapshot.expires_at}.`,
        "",
      ]
    : [];

  return [
    `# ${TOOLS.inspect.h1}`,
    "",
    ...snapshot,
    headline(view),
    "",
    endpointSection(view),
    "",
    paymentSection(view),
    "",
    observedSection(view),
    "",
    securitySection(view),
    "",
    riskSection(view),
    "",
    ctaSection(view),
    "",
    footer(view),
    "",
  ]
    .filter((part, i, all) => !(part === "" && all[i - 1] === ""))
    .join("\n");
}
