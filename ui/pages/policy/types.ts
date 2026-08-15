/**
 * The 402 Policy Playground's shared vocabulary.
 *
 * These types are the TypeScript face of `spec/SPEC.md` §5.3 and
 * `spec/schemas/policy.json`. Where they can disagree, the schema wins: it is
 * what the tests validate against.
 *
 * Nothing here imports `tx402`. The route does that; this module is shared with
 * the renderer, and keeping it dependency-free means the page templates cannot
 * accidentally pull `node:crypto` into a context that has no business with it.
 */

/**
 * The evaluation stages, **frozen and ordered** by SPEC §5.3.
 *
 * The order is the teaching moment of the whole tool, so it is declared once,
 * here, and every renderer walks this array rather than its own list. Stages
 * after the first `fail` report `skip`.
 */
export const STAGES = [
  "domain",
  "network",
  "scheme_asset",
  "recipient",
  "per_request",
  "rolling_hour",
  "total",
  "routing",
] as const;

export type Stage = (typeof STAGES)[number];

export type StageResult = "pass" | "fail" | "skip";

/** What each stage checks, in one line, for the UI and the Markdown mirror. */
export const STAGE_LABELS: Record<Stage, { title: string; checks: string }> = {
  domain: {
    title: "Domain",
    checks: "the normalized host against allowedDomains",
  },
  network: {
    title: "Network",
    checks: "the CAIP-2 network against allowedNetworks and the signed release manifest",
  },
  scheme_asset: {
    title: "Scheme and asset",
    checks: "the payment scheme and token against what the manifest declares for that network",
  },
  recipient: {
    title: "Recipient",
    checks: "the merchant's payout address against your pins or allowlist",
  },
  per_request: {
    title: "Per-request cap",
    checks: "the amount against maxPerRequest",
  },
  rolling_hour: {
    title: "Rolling hourly cap",
    checks: "the amount against maxPerHour over committed spend plus active reservations",
  },
  total: {
    title: "Cumulative cap",
    checks: "the amount against maxTotal over lifetime spend",
  },
  routing: {
    title: "Routing",
    checks: "challenge freshness, then which offered network the SDK would try first",
  },
};

export interface EvaluationStep {
  stage: Stage;
  result: StageResult;
  detail: string | null;
}

/** The SDK's typed error, verbatim. `code` is its `TX402_ERROR_CODES` member. */
export interface PolicyError {
  name: string;
  code: string;
  message: string;
  details: Record<string, unknown> | null;
}

/** `data` for `spec/schemas/policy.json`. */
export interface PolicyData {
  decision: "allow" | "deny";
  selected_requirement: SelectedRequirement | null;
  evaluation: EvaluationStep[];
  error: PolicyError | null;
  tx402_version: string | null;
  engine: "PolicyEngine";
}

/** `common.json#/$defs/Requirement`. */
export interface SelectedRequirement {
  scheme: string | null;
  network: string | null;
  network_recognized: boolean | null;
  asset: {
    address: string | null;
    symbol: string | null;
    decimals: number | null;
    recognized: boolean | null;
  } | null;
  amount_atomic: string | null;
  amount_raw?: string | null;
  amount_decimal: string | null;
  pay_to: string | null;
  pay_to_dynamic: boolean | null;
  max_timeout_seconds: number | null;
  resource: string | null;
  mime_type?: string | null;
  description?: string | null;
  facilitator?: string | null;
  extra?: Record<string, unknown> | null;
}

// ── the request the playground evaluates ─────────────────────────────────

/**
 * A `tx402` `PolicyConfig`, plus the two sibling configs the SDK takes
 * alongside it.
 *
 * `recipientPolicy` and `routing` are **nested inside `policy`** rather than
 * being siblings at the top level of the request body, because
 * `spec/schemas/policy-request.json` freezes the body as
 * `{policy, challenge, request, state}` with `additionalProperties: false` and
 * leaves `policy` itself unconstrained. Nesting keeps every request the
 * playground sends schema-valid against the frozen contract; the copy-as-code
 * snippets still render them as the siblings the SDK actually takes, which is
 * the shape a reader has to end up with.
 */
export interface RecipientAllowEntry {
  host: string;
  network: string;
  recipients: string[];
}

export interface PlaygroundRecipientPolicy {
  mode?: "off" | "allowlist" | "tofu";
  allow?: RecipientAllowEntry[];
}

export interface PlaygroundRouting {
  maxQuoteAgeMs?: number;
  preferNetworks?: string[];
}

export interface PlaygroundPolicy {
  maxPerRequest?: string;
  maxPerHour?: string;
  maxTotal?: string;
  allowedNetworks?: string[];
  allowedDomains?: string[];
  maxPaidAttempts?: number;
  recipientPolicy?: PlaygroundRecipientPolicy;
  routing?: PlaygroundRouting;
}

export interface ChallengeInput {
  /** A base64 `PAYMENT-REQUIRED` header value. */
  header?: string | null;
  /** The decoded challenge, as an object or a JSON string. */
  body?: Record<string, unknown> | string | null;
  /** Anything else pasted verbatim; treated as a header, then as JSON. */
  raw?: string | null;
}

export interface PlaygroundState {
  spent_in_window_atomic?: string | null;
  spent_total_atomic?: string | null;
  window_started_at?: string | null;
}

export interface PolicyRequest {
  policy: PlaygroundPolicy;
  challenge: ChallengeInput;
  request?: { url?: string | null; method?: string | null } | null;
  state?: PlaygroundState | null;
}
