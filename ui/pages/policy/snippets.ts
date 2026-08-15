/**
 * Copy the config as working code.
 *
 * The CTA is "take this away", so the snippets are the real client
 * constructors from `docs.tx402.io/guides/policy/`, not a pretty-printed dump
 * of the request body. Two consequences:
 *
 *  - `recipientPolicy` and `routing` come back out to the top level, where the
 *    SDK actually takes them. They are nested inside `policy` on the wire only
 *    because `spec/schemas/policy-request.json` freezes the body's top level
 *    (see `ui/pages/policy/types.ts`. A reader must
 *    end up with the shape the SDK takes, so that is the shape they are given.
 *  - a field the caller did not set is omitted rather than emitted as a
 *    default. Pasting a snippet that spells out defaults freezes them, and the
 *    defaults are the SDK's to change.
 */

import type { PolicyRequest } from "./types.js";

/** A JS/TS double-quoted string literal. */
function ts(value: string): string {
  return JSON.stringify(value);
}

/** A Python double-quoted string literal. JSON's escapes are a subset. */
function py(value: string): string {
  return JSON.stringify(value);
}

function tsList(values: readonly string[]): string {
  return `[${values.map(ts).join(", ")}]`;
}

function pyList(values: readonly string[]): string {
  return `[${values.map(py).join(", ")}]`;
}

function indent(lines: readonly string[], by: string): string[] {
  return lines.map((line) => `${by}${line}`);
}

export function typescriptSnippet(request: PolicyRequest): string {
  const p = request.policy;
  const policyLines: string[] = [];
  if (p.maxPerRequest !== undefined) policyLines.push(`maxPerRequest: ${ts(p.maxPerRequest)},`);
  if (p.maxPerHour !== undefined) policyLines.push(`maxPerHour: ${ts(p.maxPerHour)},`);
  if (p.maxTotal !== undefined) policyLines.push(`maxTotal: ${ts(p.maxTotal)},`);
  if (p.allowedDomains !== undefined) policyLines.push(`allowedDomains: ${tsList(p.allowedDomains)},`);
  if (p.allowedNetworks !== undefined) policyLines.push(`allowedNetworks: ${tsList(p.allowedNetworks)},`);
  if (p.maxPaidAttempts !== undefined) policyLines.push(`maxPaidAttempts: ${p.maxPaidAttempts},`);

  // `signers,` in shorthand rather than an inline object literal, because this
  // repository is not allowed to contain a signer configuration in any form —
  // `pnpm gate:no-signer` enforces and it is right to. It also
  // happens to be the better snippet: the reader's key stays in the reader's
  // process, which is the sentence above it.
  const body: string[] = ["signers,", "policy: {", ...indent(policyLines, "  "), "},"];

  const recipient = p.recipientPolicy;
  if (recipient?.mode !== undefined && recipient.mode !== "off") {
    const allow = (recipient.allow ?? []).map(
      (entry) =>
        `  { host: ${ts(entry.host)}, network: ${ts(entry.network)}, recipients: ${tsList(entry.recipients)} },`,
    );
    body.push("recipientPolicy: {", `  mode: ${ts(recipient.mode)},`);
    if (allow.length > 0) body.push("  allow: [", ...indent(allow, "  "), "  ],");
    body.push("},");
  }

  const routing = p.routing;
  const routingLines: string[] = [];
  if (routing?.preferNetworks?.length) routingLines.push(`preferNetworks: ${tsList(routing.preferNetworks)},`);
  if (routing?.maxQuoteAgeMs !== undefined) routingLines.push(`maxQuoteAgeMs: ${routing.maxQuoteAgeMs},`);
  if (routingLines.length > 0) body.push("routing: {", ...indent(routingLines, "  "), "},");

  const url = request.request?.url ?? "https://api.example.com/v1/geocode";

  return [
    `import { createTx402Client } from "tx402";`,
    "// Your signer stays in your process. tools.tx402.io never sees a key,",
    "// never asks for one, and cannot construct a payment.",
    `import { signers } from "./signers.js";`,
    "",
    "const tx402 = createTx402Client({",
    ...indent(body, "  "),
    "});",
    "",
    "// Policy is committed before the signer is reachable, so a refusal here is a",
    "// payment that was never authorized.",
    `const response = await tx402.fetch(${ts(url)});`,
    "",
  ].join("\n");
}

export function pythonSnippet(request: PolicyRequest): string {
  const p = request.policy;
  const imports = ["Tx402Client", "Policy"];

  const policyLines: string[] = [];
  if (p.maxPerRequest !== undefined) policyLines.push(`max_per_request=${py(p.maxPerRequest)},`);
  if (p.maxPerHour !== undefined) policyLines.push(`max_per_hour=${py(p.maxPerHour)},`);
  if (p.maxTotal !== undefined) policyLines.push(`max_total=${py(p.maxTotal)},`);
  if (p.allowedDomains !== undefined) policyLines.push(`allowed_domains=${pyList(p.allowedDomains)},`);
  if (p.allowedNetworks !== undefined) policyLines.push(`allowed_networks=${pyList(p.allowedNetworks)},`);
  if (p.maxPaidAttempts !== undefined) policyLines.push(`max_paid_attempts=${p.maxPaidAttempts},`);

  const args: string[] = ["evm_signer=evm,", "policy=Policy(", ...indent(policyLines, "    "), "),"];

  const recipient = p.recipientPolicy;
  if (recipient?.mode !== undefined && recipient.mode !== "off") {
    imports.push("RecipientPolicy");
    const allow = (recipient.allow ?? []).map(
      (entry) =>
        `        {"host": ${py(entry.host)}, "network": ${py(entry.network)}, "recipients": ${pyList(entry.recipients)}},`,
    );
    args.push("recipient_policy=RecipientPolicy(", `    mode=${py(recipient.mode)},`);
    if (allow.length > 0) args.push("    allow=[", ...allow, "    ],");
    args.push("),");
  }

  const routing = p.routing;
  const routingArgs: string[] = [];
  if (routing?.preferNetworks?.length) routingArgs.push(`prefer_networks=${pyList(routing.preferNetworks)}`);
  if (routing?.maxQuoteAgeMs !== undefined) routingArgs.push(`max_quote_age_ms=${routing.maxQuoteAgeMs}`);
  if (routingArgs.length > 0) {
    imports.push("RoutingPolicy");
    args.push(`routing=RoutingPolicy(${routingArgs.join(", ")}),`);
  }

  const url = request.request?.url ?? "https://api.example.com/v1/geocode";

  return [
    `from tx402 import ${imports.join(", ")}`,
    "",
    "# Your signer stays in your process. tools.tx402.io never sees a key,",
    "# never asks for one, and cannot construct a payment.",
    "tx402 = Tx402Client(",
    ...indent(args, "    "),
    ")",
    "",
    "# Policy is committed before the signer is reachable, so a refusal here is a",
    "# payment that was never authorized.",
    `response = tx402.fetch(${py(url)})`,
    "",
  ].join("\n");
}

/** The request body, for anyone driving the JSON API directly. */
export function curlSnippet(request: PolicyRequest, origin = "https://tools.tx402.io"): string {
  const body = JSON.stringify(
    {
      policy: request.policy,
      challenge: request.challenge,
      ...(request.request ? { request: request.request } : {}),
      ...(request.state ? { state: request.state } : {}),
    },
    null,
    2,
  );
  return [
    `curl -sS ${origin}/api/v1/policy/evaluate \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${body.replace(/'/g, "'\\''")}'`,
    "",
  ].join("\n");
}
