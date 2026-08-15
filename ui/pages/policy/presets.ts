/**
 * Playground presets.
 *
 * Each preset is a complete, runnable request: a policy, a challenge, and the
 * spend already on the ledger. They map onto `docs.tx402.io/guides/policy/` and
 * between them they trip **every stage that can fail**, so a reader can click
 * through the whole refusal vocabulary without composing anything by hand.
 *
 * The challenges are in the shape `decodePaymentRequired` actually accepts —
 * `{x402Version, resource:{url}, accepts:[{…, amount, …}]}`. That is not the
 * shape `spec/fixtures/challenges/` uses., which is
 * the thing needs to read before it wires the probe to the same decoder.
 */

import type { PolicyRequest } from "./types.js";

const BASE = "eip155:8453";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MERCHANT = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

interface RequirementSeed {
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  scheme?: string;
  extra?: Record<string, unknown>;
}

function challenge(
  url: string,
  requirements: RequirementSeed[],
): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url },
    accepts: requirements.map((r) => ({
      scheme: r.scheme ?? "exact",
      network: r.network ?? BASE,
      asset: r.asset ?? USDC_BASE,
      amount: r.amount ?? "1000",
      payTo: r.payTo ?? MERCHANT,
      maxTimeoutSeconds: 300,
      extra: r.extra ?? { name: "USD Coin", version: "2" },
    })),
  };
}

export interface Preset {
  id: string;
  /** Short label for the preset row. */
  name: string;
  /** One sentence: what this preset demonstrates. */
  blurb: string;
  /** The stage this preset is built to exercise, for the preset row's grouping. */
  stage: "allow" | "domain" | "network" | "scheme_asset" | "recipient" | "per_request" | "rolling_hour" | "total" | "routing" | "config";
  request: PolicyRequest;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "default",
    name: "Sane default",
    blurb: "The configuration from the policy guide, against a one-tenth-of-a-cent call. Everything passes.",
    stage: "allow",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com", "*.trusted.dev"],
        allowedNetworks: [BASE, SOLANA],
        maxPaidAttempts: 2,
      },
      challenge: { body: challenge("https://api.example.com/v1/geocode", [{ amount: "1000" }]) },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "fleet",
    name: "Agent fleet",
    blurb:
      "Tighter per-call cap, a lifetime ceiling, a pinned payout address and a network preference — with 1.90 USDC already spent this hour.",
    stage: "allow",
    request: {
      policy: {
        maxPerRequest: "0.05 USDC",
        maxPerHour: "2.00 USDC",
        maxTotal: "50.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE, SOLANA],
        maxPaidAttempts: 2,
        recipientPolicy: {
          mode: "allowlist",
          allow: [{ host: "api.example.com", network: BASE, recipients: [MERCHANT] }],
        },
        routing: { preferNetworks: [BASE] },
      },
      challenge: {
        body: challenge("https://api.example.com/v1/geocode", [
          { network: BASE, amount: "20000" },
          { network: SOLANA, asset: USDC_SOLANA, amount: "20000", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" },
        ]),
      },
      state: { spent_in_window_atomic: "1900000", spent_total_atomic: "12400000" },
    },
  },
  {
    id: "per-request",
    name: "Over the per-request cap",
    blurb: "A 0.05 USDC call against a 0.01 USDC cap. BudgetExceededError, capKind per-request.",
    stage: "per_request",
    request: {
      policy: {
        maxPerRequest: "0.01 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: { body: challenge("https://api.example.com/v1/geocode", [{ amount: "50000" }]) },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "hourly",
    name: "Over the rolling hourly cap",
    blurb:
      "Each call fits the per-request cap; 0.95 USDC of the 1.00 USDC hour is already gone. The window counts committed spend and live reservations.",
    stage: "rolling_hour",
    request: {
      policy: {
        maxPerRequest: "0.50 USDC",
        maxPerHour: "1.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: { body: challenge("https://api.example.com/v1/geocode", [{ amount: "100000" }]) },
      state: { spent_in_window_atomic: "950000", spent_total_atomic: "950000" },
    },
  },
  {
    id: "cumulative",
    name: "Over the lifetime ceiling",
    blurb:
      "Inside the per-request and hourly caps, but 9.95 of a 10.00 USDC maxTotal has been spent since the ledger started. BudgetExceededError, capKind cumulative.",
    stage: "total",
    request: {
      policy: {
        maxPerRequest: "0.50 USDC",
        maxPerHour: "5.00 USDC",
        maxTotal: "10.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: { body: challenge("https://api.example.com/v1/geocode", [{ amount: "100000" }]) },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "9950000" },
    },
  },
  {
    id: "domain",
    name: "Domain not allowed",
    blurb: "The first stage, and the cheapest refusal there is — no network call, no ledger read, no balance query.",
    stage: "domain",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: { body: challenge("https://api.elsewhere.example/v1/geocode", [{ amount: "1000" }]) },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "network",
    name: "Network not allowed",
    blurb: "The merchant only offers Solana; the policy only allows Base. UnsupportedSchemeError at the network stage.",
    stage: "network",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: {
        body: challenge("https://api.example.com/v1/geocode", [
          { network: SOLANA, asset: USDC_SOLANA, amount: "1000", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" },
        ]),
      },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "asset",
    name: "Token not in the manifest",
    blurb:
      "The network is allowed, but the token address is not one the signed release manifest declares for it. A merchant cannot introduce a token by naming it.",
    stage: "scheme_asset",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: {
        body: challenge("https://api.example.com/v1/geocode", [
          { asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "1000" },
        ]),
      },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "recipient",
    name: "Payout address not pinned",
    blurb:
      "A marketplace that rotates its payout address per order, against an allowlist that pins one. RecipientUnpinnedError — refused for being the wrong address, not for being over a limit.",
    stage: "recipient",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["marketplace.example.com"],
        allowedNetworks: [BASE],
        recipientPolicy: {
          mode: "allowlist",
          allow: [{ host: "marketplace.example.com", network: BASE, recipients: [MERCHANT] }],
        },
      },
      challenge: {
        body: challenge("https://marketplace.example.com/v1/order/8f21", [
          {
            amount: "2500",
            payTo: "0x9c8FF314C9Bc7F6e59A9d9225Fb22946427eDC03",
            extra: { name: "USD Coin", version: "2", payToMode: "dynamic" },
          },
        ]),
      },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "stale-quote",
    name: "Stale quote",
    blurb:
      "The challenge carries a quote timestamp older than routing.maxQuoteAgeMs. Every cap passed; the quote had gone off.",
    stage: "routing",
    request: {
      policy: {
        maxPerRequest: "0.10 USDC",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
        routing: { maxQuoteAgeMs: 5000 },
      },
      challenge: {
        body: challenge("https://api.example.com/v1/geocode", [
          {
            amount: "1000",
            extra: { name: "USD Coin", version: "2", timestamp: "2026-01-01T00:00:00.000Z" },
          },
        ]),
      },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
  {
    id: "bad-money",
    name: "A cap written as atomic units",
    blurb:
      "`\"100000\"` is refused with ConfigurationError before anything is evaluated. Do not repair it by appending the symbol — `\"100000 USDC\"` is valid and a million times larger.",
    stage: "config",
    request: {
      policy: {
        maxPerRequest: "100000",
        maxPerHour: "5.00 USDC",
        allowedDomains: ["api.example.com"],
        allowedNetworks: [BASE],
      },
      challenge: { body: challenge("https://api.example.com/v1/geocode", [{ amount: "1000" }]) },
      state: { spent_in_window_atomic: "0", spent_total_atomic: "0" },
    },
  },
];

export const DEFAULT_PRESET = "default";

export function findPreset(id: string | null | undefined): Preset | undefined {
  if (!id) return undefined;
  return PRESETS.find((p) => p.id === id);
}
