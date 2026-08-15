/**
 * The shapes this server renders, transcribed from `spec/schemas/common.json`
 * and `inspect.json`.
 *
 * These are *not* the guarantee. A TypeScript interface on a parsed response
 * proves nothing about what came off the wire, which is why nothing here is
 * trusted until `validateAgainst` in `schemas.ts` has said so — and why every
 * field that the schema allows to be null is null here too. The types exist so
 * the renderer is total over the shapes the contract permits, not so it can
 * assume a friendly one.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type Band = "LOW" | "MEDIUM" | "HIGH";

export interface Asset {
  address: string | null;
  symbol: string | null;
  decimals: number | null;
  recognized: boolean | null;
}

export interface Requirement {
  scheme: string | null;
  network: string | null;
  network_recognized: boolean | null;
  asset: Asset | null;
  amount_atomic: string | null;
  /** The amount exactly as the challenge spelled it, canonical or not (SPEC §1.4). */
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

export interface Check {
  id: string;
  status: CheckStatus;
  offline: boolean;
  reason?: string | null;
  detail?: string | null;
}

export interface Signal {
  id: string;
  value: boolean | number | string | null;
  observed: boolean;
  detail?: string | null;
}

export interface RiskReason {
  signal_id: string;
  status: CheckStatus;
  weight: number;
  message: string;
}

export interface Risk {
  score: number;
  band: Band;
  score_version: string;
  confidence: "static_only" | "with_history";
  signals_evaluated: number;
  reasons: RiskReason[];
  methodology_url: string;
}

export interface Challenge {
  wire_form: string;
  x402_version: number | null;
  valid: boolean;
  decode_error: { code: string; message: string } | null;
  accepts: Requirement[];
  requirement_count: number;
  raw_bytes?: number | null;
  hash?: string | null;
  raw?: string | null;
}

export interface ProbeMeta {
  observed_at: string;
  http_status: number | null;
  latency_ms: number | null;
  redirect_count: number;
  tls?: { ok: boolean; protocol?: string | null } | null;
  bytes_read?: number | null;
  served_from_cache: boolean;
  cache_age_seconds?: number | null;
}

export interface Target {
  url: string | null;
  canonical_url: string | null;
  endpoint_id: string | null;
  origin: string | null;
  host: string | null;
}

export interface TermChange {
  id: string;
  changed_at: string;
  change_kind: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_by?: string;
  score_version?: string | null;
}

export interface Observed {
  has_history: boolean;
  first_seen: string | null;
  last_seen: string | null;
  scan_count: number;
  availability_30d: number | null;
  latency_p50_ms: number | null;
  recent_changes: TermChange[];
}

export interface InspectData {
  target: Target;
  probe: ProbeMeta | null;
  challenge: Challenge | null;
  terms: Requirement | null;
  checks: Check[];
  signals: Signal[];
  risk: Risk | null;
  observed: Observed;
  links: Record<string, string | null>;
}

export interface Warning {
  code: string;
  message: string;
}

export interface Meta {
  implemented: boolean;
  cached: boolean;
  cache_age_seconds?: number | null;
  score_version?: string | null;
  tx402_version?: string | null;
  schema?: string | null;
}

export interface Envelope<T> {
  api_version: string;
  tool: string;
  generated_at: string;
  meta: Meta;
  warnings: Warning[];
  data: T;
}

export interface ApiError {
  code: string;
  message: string;
  detail?: Record<string, unknown> | null;
  retryable: boolean;
  docs?: string | null;
}

export interface ErrorEnvelope {
  api_version: string;
  generated_at: string;
  error: ApiError;
}
