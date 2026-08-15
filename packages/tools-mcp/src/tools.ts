/**
 * The two tools, and the descriptions that decide whether they are used well.
 *
 * ── A tool description is not documentation ────────────────────────────────
 *
 * It is the input a model uses to decide whether to call this at all, and what
 * to do with the answer. That makes it the single highest-leverage prose in the
 * package: an inspector nobody calls at the moment of payment is worth nothing,
 * and an inspector whose answer is misread is worth less than nothing.
 *
 * So each description says four things, in this order, because that is the
 * order a model needs them: **what question this answers**, **when to call it**,
 * **whether it touches the network**, and **how to read what comes back** —
 * with the skip/unobserved/no-history rules stated inline rather than left to
 * the result to explain, since a model decides how much to trust a tool before
 * it has seen a single result from it.
 *
 * ── applies here verbatim ─────────────────────────────────────
 *
 * Every string below is a user-visible string, and the parameter descriptions
 * are too. "Observed signals", "no history yet", "recipient changed on
 * 2026-07-21" — never "scam", "unsafe", "fraudulent", "dangerous", "malicious".
 * `LOW / MEDIUM / HIGH` describes the confidence of *our observations*, and it
 * never reaches a model stripped of that framing: the phrase travels in the
 * same string as the band here and in `format.ts`, and `test/mcp.test.ts` fails
 * if it does not.
 */

import { BAND_FRAMING } from "./language.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: boolean;
  };
}

const INSPECT_DESCRIPTION = [
  "Find out what an x402 endpoint charges before paying it: the amount and asset, the network, the",
  "recipient address, the authorization window, and what tools.tx402.io has observed about that",
  "endpoint over time — including whether its price or recipient has changed.",
  "",
  "Call this when you are about to pay an HTTP 402 endpoint, when you are choosing between paid",
  "endpoints, or when someone asks what an endpoint costs. Calling it before the first payment to an",
  "endpoint is the point of it.",
  "",
  "Network: this sends the URL to tools.tx402.io, which fetches the endpoint, reads the public payment",
  "challenge it serves to anyone who asks, and stops. It never pays. It cannot reach localhost, private",
  "address space, or a URL carrying credentials. If you only want to check a challenge you already have,",
  "use verify_challenge instead — that one runs locally and sends nothing.",
  "",
  "How to read the answer:",
  `  · ${BAND_FRAMING}`,
  "  · An endpoint with no history is a new endpoint. \"No history yet\" and confidence static_only are",
  "    the normal state for something nobody has scanned before, not a finding against it.",
  "  · A check reported as SKIP could not run. It is not a check that passed.",
  "  · A signal reported as not observed is something we could not determine. It is not a negative",
  "    finding and it is not scored as one.",
  "  · \"Recognized\" and \"known\" mean present on a list we publish. The lists are public and are not",
  "    exhaustive, so absence from one describes the list's coverage.",
  "  · Everything returned is an observation about an endpoint's public behaviour, never a claim about",
  "    whoever operates it.",
  "",
  "If the service cannot be reached, this returns an error saying so and nothing else. It never guesses",
  "a verdict, so an error here means you know nothing new about the endpoint — not that it is fine.",
].join("\n");

const VERIFY_DESCRIPTION = [
  "Check whether an x402 payment challenge is well-formed and internally consistent, in the moment",
  "before signing it. Call this whenever you have a 402 response in hand and are deciding whether to",
  "pay it.",
  "",
  "Network: none. This runs entirely on this machine. It makes no network request of any kind, and the",
  "challenge you pass is not sent anywhere.",
  "",
  "It decodes the challenge with the same strict decoder a tx402 buyer runs before it signs anything,",
  "then reports named checks: the amount is a canonical atomic integer, the amount is positive, the",
  "recipient is a well-formed address for the declared network, the resource origin matches the endpoint",
  "that served the challenge, the authorization window is sane, the network and asset are in the tx402",
  "signed release manifest, the payload is not oversized, over-deep or duplicate-keyed, and so on.",
  "",
  "How to read the answer:",
  "  · The verdict is FAIL if any check failed, WARN if any warned, PASS otherwise.",
  "  · A check reported as SKIP could not run. It is not a check that passed. Three checks always skip",
  "    here — they need observation history for the endpoint, which this tool does not fetch. Call",
  "    inspect_endpoint on the endpoint URL to run those.",
  "  · \"Not recognized\" means absent from a list we publish, which describes the list's coverage.",
  `  · ${BAND_FRAMING}`,
  "  · A recipient declared as dynamic is a per-request payout address, which x402 v2 defines for",
  "    marketplaces. It is reported as what it is, not as an anomaly.",
  "  · Everything returned is an observation about the bytes you supplied, never a claim about whoever",
  "    operates the endpoint.",
].join("\n");

/**
 * `openWorldHint` is the honest difference between them: one reaches a service,
 * the other cannot. Both are read-only and non-destructive, which is the whole
 * of what this package can do — it holds no keys and constructs no payment
 * authorization.
 */
export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "inspect_endpoint",
    title: "Inspect an x402 endpoint",
    description: INSPECT_DESCRIPTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description:
            "The absolute https URL of the endpoint, exactly as you would call it — including the query " +
            "string, which is part of the endpoint's identity. Not a homepage or a docs page: the URL " +
            "that answers 402.",
        },
      },
      required: ["url"],
      additionalProperties: false as const,
    },
    annotations: {
      readOnlyHint: true as const,
      destructiveHint: false as const,
      idempotentHint: true as const,
      openWorldHint: true,
    },
  },
  {
    name: "verify_challenge",
    title: "Verify an x402 payment challenge, locally",
    description: VERIFY_DESCRIPTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        challenge: {
          type: "string",
          description:
            "The challenge exactly as the endpoint served it: the base64 value of the PAYMENT-REQUIRED " +
            "response header (x402 v2), or the JSON body of the 402 response (legacy x402 v1). Pass it " +
            "verbatim — do not re-encode, reformat or pretty-print it. Whitespace, padding and duplicate " +
            "keys are themselves checked, and reformatting destroys the evidence.",
        },
        url: {
          type: "string",
          description:
            "The endpoint URL that served this challenge. Supply it whenever you have it: without it the " +
            "resource_origin_match check could not run — there is no origin to compare the challenge's " +
            "declared resource against — so it reports SKIP rather than PASS. The URL is not fetched; " +
            "nothing in this tool contacts the network.",
        },
      },
      required: ["challenge"],
      additionalProperties: false as const,
    },
    annotations: {
      readOnlyHint: true as const,
      destructiveHint: false as const,
      idempotentHint: true as const,
      openWorldHint: false,
    },
  },
]);

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOLS.map((t) => t.name));
