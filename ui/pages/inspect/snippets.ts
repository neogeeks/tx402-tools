/**
 * "Test with tx402 →".
 *
 * The CTA is *take this away and run it*, so the snippets are pre-filled with
 * this endpoint's real terms: its URL, its network, its asset and its price, in
 * the exact `<decimal> <SYMBOL>` money syntax `parseMoneyAtomic` accepts.
 *
 * Three rules, each of which exists because breaking it produces a snippet that
 * looks helpful and is wrong:
 *
 *  1. **A value we could not determine is omitted, with a comment saying so.**
 *     A guessed cap is worse than no cap, and a money string the SDK rejects
 *     turns "copy this" into "debug this".
 *  2. **The signer is imported, never constructed.** `pnpm gate:no-signer`
 *     rejects an inline signer-configuration object literal anywhere in this
 *     repository — correctly, since the pattern cannot tell "configures a
 *     signer" from "prints a string" (we hit this too). The property shorthand
 *     the snippet emits instead is also the better snippet: the reader's key
 *     stays in the reader's process, which is the sentence above it.
 *  3. **Nothing here can pay.** These are strings. The service that renders
 *     them holds no key and builds no authorization.
 */

import type { InspectData, Requirement } from "./types.js";
import { sdkMoney } from "./types.js";

function q(value: string): string {
  return JSON.stringify(value);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Solana signers are configured under a different key than EVM ones. */
function isSolana(terms: Requirement | null): boolean {
  return (terms?.network ?? "").startsWith("solana:");
}

/** The one-liner. `--dry-run` stops before anything is signed. */
export function cliSnippet(data: InspectData): string {
  const url = data.target.url ?? "https://api.example.com/v1/geocode";
  const money = sdkMoney(data.terms);
  const network = data.terms?.network ?? null;

  const parts = [`npx tx402 call ${q(url)}`];
  if (money) parts.push(`--max-spend ${q(money)}`);
  if (network) parts.push(`--network ${q(network)}`);
  parts.push("--dry-run");

  const lines = [parts.join(" \\\n  ")];
  if (!money) {
    lines.unshift(
      "# This endpoint's amount or asset could not be read, so --max-spend is left for you to set.",
    );
  }
  lines.push("", "# --dry-run stops after the policy decision. Nothing is signed and nothing is spent.");
  return `${lines.join("\n")}\n`;
}

export function typescriptSnippet(data: InspectData): string {
  const url = data.target.url ?? "https://api.example.com/v1/geocode";
  const money = sdkMoney(data.terms);
  const host = hostOf(data.target.url);
  const network = data.terms?.network ?? null;

  const policy: string[] = [];
  if (money) policy.push(`    maxPerRequest: ${q(money)},`);
  else policy.push("    // The observed amount could not be read as canonical money — set your own cap.");
  if (host) policy.push(`    allowedDomains: [${q(host)}],`);
  if (network) policy.push(`    allowedNetworks: [${q(network)}],`);

  return [
    `import { createTx402Client } from "tx402";`,
    "// Your signer stays in your process. tools.tx402.io never sees a key,",
    "// never asks for one, and cannot build a payment.",
    `import { signers } from "./signers.js";`,
    "",
    "const tx402 = createTx402Client({",
    "  signers,",
    "  policy: {",
    ...policy,
    "  },",
    "});",
    "",
    "// Policy and budget are committed before the signer is reachable, so a",
    "// refusal here is a payment that was never authorized.",
    `const response = await tx402.fetch(${q(url)});`,
    "",
  ].join("\n");
}

export function pythonSnippet(data: InspectData): string {
  const url = data.target.url ?? "https://api.example.com/v1/geocode";
  const money = sdkMoney(data.terms);
  const host = hostOf(data.target.url);
  const network = data.terms?.network ?? null;

  const policy: string[] = [];
  if (money) policy.push(`        max_per_request=${q(money)},`);
  else policy.push("        # The observed amount could not be read as canonical money — set your own cap.");
  if (host) policy.push(`        allowed_domains=[${q(host)}],`);
  if (network) policy.push(`        allowed_networks=[${q(network)}],`);

  const signerArg = isSolana(data.terms) ? "solana_signer=solana," : "evm_signer=evm,";

  return [
    "from tx402 import Tx402Client, Policy",
    "",
    "# Your signer stays in your process. tools.tx402.io never sees a key,",
    "# never asks for one, and cannot build a payment.",
    "tx402 = Tx402Client(",
    `    ${signerArg}`,
    "    policy=Policy(",
    ...policy,
    "    ),",
    ")",
    "",
    "# Policy and budget are committed before the signer is reachable, so a",
    "# refusal here is a payment that was never authorized.",
    `response = tx402.fetch(${q(url)})`,
    "",
  ].join("\n");
}

/** For anyone driving the JSON API directly. */
export function curlSnippet(data: InspectData, origin: string): string {
  const url = data.target.url ?? "https://api.example.com/v1/geocode";
  return [
    `curl -sS '${origin}/api/v1/inspect?url=${encodeURIComponent(url)}'`,
    "",
    "# The same result as Markdown, for a terminal or an agent:",
    `curl -sS -H 'Accept: text/markdown' '${origin}/inspect?url=${encodeURIComponent(url)}'`,
    "",
  ].join("\n");
}
