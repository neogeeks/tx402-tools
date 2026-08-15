/**
 * The probe: fetch the endpoint, read the 402, and stop.  owns
 * this file.
 *
 * **This code cannot pay.** It builds no signer, holds no key, and constructs
 * no payment-authorization header. `pnpm gate:no-signer` greps the whole repo
 * for the spelling of that header and fails the build if it appears anywhere
 * outside prose — which is why this comment describes it rather than naming it.
 * The allowlist the gate offers is per FILE, and exempting this file, of all
 * files, would switch the check off over the code nearest the payment path. The
 * probe reads a challenge the endpoint serves to anyone who asks and forms an
 * opinion about it. That is the entire scope.
 *
 * ── Two wire forms, one decoder ────────────────────────────────────────────
 *
 * x402 v2 moved the challenge into the `PAYMENT-REQUIRED` response header; v1
 * put it in the JSON body. Reference servers still answer v1, so the probe
 * reads both and reports which it saw. Seeing **both** is itself a signal: it
 * usually means a compatibility shim, and it is worth knowing that the two
 * copies agree.
 *
 * The decoding is done by `decodePaymentRequired` **imported from `tx402`** —
 * the same strict decoder that would refuse the payment. There is no second
 * decoder in this repo, and that is the differentiating claim of the whole
 * product: the Inspector's verdict is produced by the code that
 * actually gates the money.
 *
 * ── What the decoder turned out to require, and why it matters ─────────────
 *
 * `decodePaymentRequired` validates against the **x402 v2 specification** envelope: a top-level
 * `resource: { url }` object and `accepts[].amount`. Several fixtures frozen early use the v1-era
 * layout instead — `accepts[].maxAmountRequired` with a per-requirement `resource` string — so the
 * strict decoder rejects them. That is not a bug in either place; it is the v1→v2 restructuring,
 * and detecting it is useful output. See. , which records the finding rather than quietly reshaping
 * a frozen fixture.
 *
 * Consequence, stated plainly because it drives the score: an endpoint that
 * serves v1 does not decode under a v2-only decoder, so `challenge_decodes` is
 * false for it. For this product's audience that is the true and useful answer
 * — a tx402 buyer cannot pay a v1 endpoint — and `spec/risk-score.md` says so
 * where a reader can check it.
 */

import {
  BUNDLED_MANIFEST,
  MAX_AUTHORIZATION_SECONDS,
  chainFamily,
  decodePaymentRequired,
  resolveNetwork,
  type NormalizedPaymentRequired,
} from "tx402";

import {
  GUARD_LIMITS,
  endpointId,
  guardedFetch,
  type GuardOptions,
  type GuardResult,
} from "./guard.js";
import { nowIso } from "../http.js";

// ── the shapes SPEC §4.1, §4.2 and §4.7 freeze ────────────────────────────

export type WireForm = "v2-header" | "v1-body" | "both" | "none";

export interface NormalizedAsset {
  address: string | null;
  symbol: string | null;
  decimals: number | null;
  recognized: boolean | null;
}

/** SPEC §4.1. */
export interface Requirement {
  scheme: string | null;
  network: string | null;
  network_recognized: boolean | null;
  asset: NormalizedAsset | null;
  amount_atomic: string | null;
  amount_raw: string | null;
  amount_decimal: string | null;
  pay_to: string | null;
  pay_to_dynamic: boolean | null;
  max_timeout_seconds: number | null;
  resource: string | null;
  mime_type: string | null;
  description: string | null;
  facilitator: string | null;
  extra: Record<string, unknown>;
}

/** SPEC §4.2. */
export interface Challenge {
  wire_form: WireForm;
  x402_version: number | null;
  valid: boolean;
  decode_error: { code: string; message: string } | null;
  accepts: Requirement[];
  requirement_count: number;
  raw_bytes: number | null;
  hash: string | null;
  raw: string | null;
}

/** SPEC §4.7. */
export interface ProbeMeta {
  observed_at: string;
  http_status: number | null;
  latency_ms: number | null;
  redirect_count: number;
  tls: { ok: boolean; protocol: string | null } | null;
  bytes_read: number | null;
  served_from_cache: boolean;
  cache_age_seconds: number | null;
}

export interface ProbeResult {
  target: {
    url: string;
    canonical_url: string;
    endpoint_id: string;
    origin: string;
    host: string;
  };
  probe: ProbeMeta;
  challenge: Challenge;
  /**
   * Display-only view of the terms, extracted from the raw payload even when
   * the strict decoder refused it. SPEC §4.2 requires `challenge.accepts` to be
   * empty when `valid` is false — a refused challenge must never look accepted
   * — but a report that shows nothing at all for a broken endpoint is useless
   * to the person trying to fix it, so the parsed-but-unaccepted view lives
   * here under a name that cannot be mistaken for a verdict.
   */
  observed_terms: Requirement[];
  /** True when both wire forms were served AND they described the same terms. */
  wire_forms_agree: boolean | null;
}

// ── header names ──────────────────────────────────────────────────────────

/** v2 (x402.org v2 launch). The `X-` spellings are the deprecated v1 forms. */
const V2_HEADER = "payment-required";
const V2_HEADER_LEGACY = "x-payment-required";

// ── manifest lookups ──────────────────────────────────────────────────────
// `recognized` means exactly "present in the tx402 signed release manifest",
// and nothing more (SPEC §4.1). It is not a safety claim about the asset.

interface ManifestAssetRow {
  symbol?: string;
  address?: string;
  decimals?: number;
}

function manifestNetwork(network: string | null): { assets?: ManifestAssetRow[] } | null {
  if (!network) return null;
  try {
    const resolution = resolveNetwork(BUNDLED_MANIFEST, network);
    // `resolveNetwork` returns either a resolution or a typed "unknown-network"
    // reason. An unknown network is simply not in the manifest.
    if (!("resolved" in resolution)) return null;
    const networks = BUNDLED_MANIFEST.networks as unknown as Record<
      string,
      { assets?: ManifestAssetRow[] }
    >;
    return networks[resolution.resolved] ?? null;
  } catch {
    return null;
  }
}

function manifestAsset(
  network: string | null,
  address: string | null,
): ManifestAssetRow | null {
  const entry = manifestNetwork(network);
  if (!entry?.assets || !address) return null;
  const wanted = address.toLowerCase();
  return entry.assets.find((a) => (a.address ?? "").toLowerCase() === wanted) ?? null;
}

// ── money ─────────────────────────────────────────────────────────────────

/** SPEC §1.4: digits only, no sign, no point, no exponent, no leading zeros. */
export function isCanonicalAtomic(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
}

/**
 * Display only, and derived rather than parsed — the atomic string stays the
 * source of truth everywhere else. Absent when `decimals` is unknown, because a
 * price rendered against a guessed exponent is worse than no price.
 */
export function toDecimalString(atomic: string, decimals: number | null): string | null {
  if (decimals === null || decimals < 0) return null;
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return `${whole}.${fraction}`;
}

// ── dynamic payTo (SPEC §6.4) ────────────────────────────────

/**
 * Extension identifiers that declare per-request payout routing. Empty on
 * purpose, and that emptiness is the finding.
 *
 * O13 asked to confirm the declaration key. The answer, from the normative
 * spec and the reference implementation, is that **there is no declaration on
 * the wire at all**:
 *
 *   - `@x402/core` types dynamic routing as
 *     `DynamicPayTo = (context) => string | Promise<string>` — a *server-side
 *     function*, resolved before the challenge is serialized. The client
 *     receives a plain resolved address.
 *   - The other route is an extension filling a **vacant** (`""`) `payTo`
 *     during `enrichPaymentRequiredResponse`; again, what ships is a concrete
 *     string.
 *
 * The fixture's guess of `extra.payToMode` therefore names a key that does not
 * exist and would never fire. Two declaration surfaces DO exist and are
 * observable, so those are what this implements:
 *
 *   1. `payTo` carrying a **role constant** rather than an address — the v2
 *      spec defines the field as "Recipient wallet address or role constant
 *      (e.g. 'merchant')".
 *   2. A recognized entry in the top-level `extensions` object, which is v2's
 *      modular extension mechanism and the only place a server can *tell* a
 *      client this is happening.
 *
 * This list is empty because no such extension identifier is published yet. When one is, adding it
 * here is the whole change. Full record in. ; the consequence for is spelled out there too, because
 * that is where it becomes load-bearing.
 */
export const DYNAMIC_PAYTO_EXTENSIONS: readonly string[] = [];

/** Address shapes we can recognize, so a non-address `payTo` is detectable. */
export function isWellFormedRecipient(payTo: string, network: string | null): boolean {
  let family: string | null = null;
  try {
    family = network ? chainFamily(network) : null;
  } catch {
    family = null;
  }
  if (family === "eip155") return /^0x[0-9a-fA-F]{40}$/u.test(payTo);
  if (family === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(payTo);
  // Unknown family: accept either shape rather than inventing a rule for a
  // chain we do not model.
  return (
    /^0x[0-9a-fA-F]{40}$/u.test(payTo) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(payTo)
  );
}

function declaresDynamicPayTo(
  payload: Record<string, unknown>,
  requirement: Record<string, unknown>,
): boolean | null {
  const extensions = payload.extensions;
  if (extensions && typeof extensions === "object" && !Array.isArray(extensions)) {
    for (const key of Object.keys(extensions)) {
      if (DYNAMIC_PAYTO_EXTENSIONS.includes(key)) return true;
    }
  }

  const payTo = requirement.payTo;
  if (typeof payTo !== "string" || payTo.length === 0) return null;

  const network = typeof requirement.network === "string" ? requirement.network : null;
  // A role constant is a declaration; a concrete address is the absence of one.
  return !isWellFormedRecipient(payTo, network);
}

// ── normalization ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize one requirement from either wire layout into SPEC §4.1.
 *
 * Both spellings are read: v2's `amount` and v1's `maxAmountRequired`, and
 * v2's top-level `resource.url` with v1's per-requirement `resource` string.
 * Reading both is normalization, not decoding — the verdict on the payload
 * still belongs to `decodePaymentRequired` alone.
 */
export function normalizeRequirement(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): Requirement {
  const network = str(raw.network);
  const assetAddress = str(raw.asset);

  const amountRaw =
    typeof raw.amount === "string"
      ? raw.amount
      : typeof raw.maxAmountRequired === "string"
        ? raw.maxAmountRequired
        : typeof raw.amount === "number" || typeof raw.maxAmountRequired === "number"
          ? String(raw.amount ?? raw.maxAmountRequired)
          : null;

  const amountAtomic = isCanonicalAtomic(amountRaw) ? amountRaw : null;

  const manifestRow = manifestAsset(network, assetAddress);
  const networkEntry = manifestNetwork(network);
  const extra = asRecord(raw.extra) ?? {};

  const resourceObject = asRecord(payload.resource);
  const resource =
    str(raw.resource) ?? (resourceObject ? str(resourceObject.url) : null) ?? null;

  const decimals = manifestRow?.decimals ?? null;

  return {
    scheme: str(raw.scheme),
    network,
    network_recognized: network ? networkEntry !== null : null,
    asset: assetAddress
      ? {
          address: assetAddress,
          symbol: manifestRow?.symbol ?? str(extra.name) ?? null,
          decimals,
          recognized: manifestRow !== null,
        }
      : null,
    amount_atomic: amountAtomic,
    amount_raw: amountRaw,
    amount_decimal: amountAtomic ? toDecimalString(amountAtomic, decimals) : null,
    pay_to: str(raw.payTo),
    pay_to_dynamic: declaresDynamicPayTo(payload, raw),
    max_timeout_seconds:
      typeof raw.maxTimeoutSeconds === "number" && Number.isInteger(raw.maxTimeoutSeconds)
        ? raw.maxTimeoutSeconds
        : null,
    resource,
    mime_type:
      str(raw.mimeType) ?? (resourceObject ? str(resourceObject.mimeType) : null) ?? null,
    description:
      str(raw.description) ??
      (resourceObject ? str(resourceObject.description) : null) ??
      null,
    facilitator: str(extra.facilitator) ?? str(payload.facilitator) ?? null,
    extra,
  };
}

// ── hashing ───────────────────────────────────────────────────────────────

/** Stable key ordering so the hash tracks meaning, not serialization order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function challengeHash(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(payload)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── decoding ──────────────────────────────────────────────────────────────

function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface DecodeOutcome {
  valid: boolean;
  error: { code: string; message: string } | null;
  normalized: NormalizedPaymentRequired | null;
}

/**
 * Run the strict decoder and capture its verdict.
 *
 * `header` must be the challenge exactly as it appeared on the wire when the
 * wire form was a header, so that base64 strictness, the byte cap and the
 * duplicate-key preflight all judge the endpoint's own bytes. For a v1 body
 * there is no base64 framing, so the body is encoded here purely to satisfy the
 * decoder's input type; every substantive check still runs against the real
 * payload, and `base64_strict` reports `skip` rather than a hollow pass.
 */
export function decodeChallenge(header: string, requestUrl: string): DecodeOutcome {
  try {
    const normalized = decodePaymentRequired(header, {
      requestUrl,
      requestMethod: "GET",
      requestId: "probe",
    });
    return { valid: true, error: null, normalized };
  } catch (error) {
    const err = error as { code?: string; name?: string; message?: string };
    return {
      valid: false,
      error: {
        code: err.code ?? err.name ?? "DECODE_FAILED",
        message: err.message ?? "The challenge could not be decoded.",
      },
      normalized: null,
    };
  }
}

// ── wire-form extraction ──────────────────────────────────────────────────

interface ExtractedForm {
  header: string | null;
  headerPayload: Record<string, unknown> | null;
  bodyPayload: Record<string, unknown> | null;
  bodyText: string | null;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function decodeBase64ToText(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A payload looks like an x402 challenge when it declares a version or carries
 * `accepts`. Deliberately loose: deciding whether it is *valid* is the
 * decoder's job, and being strict here would hide broken endpoints from the
 * report instead of describing them.
 */
function looksLikeChallenge(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  return "x402Version" in payload || "accepts" in payload;
}

function extractForms(headers: Headers, bodyText: string): ExtractedForm {
  const header =
    headers.get(V2_HEADER) ?? headers.get(V2_HEADER_LEGACY) ?? null;

  const headerText = header ? decodeBase64ToText(header.trim()) : null;
  const headerPayload = headerText ? safeJson(headerText) : null;

  const bodyPayload = safeJson(bodyText);

  return {
    header: header?.trim() ?? null,
    headerPayload: looksLikeChallenge(headerPayload) ? headerPayload : null,
    bodyPayload: looksLikeChallenge(bodyPayload) ? bodyPayload : null,
    bodyText,
  };
}

function classifyWireForm(form: ExtractedForm): WireForm {
  const hasHeader = form.header !== null;
  const hasBody = form.bodyPayload !== null;
  if (hasHeader && hasBody) return "both";
  if (hasHeader) return "v2-header";
  if (hasBody) return "v1-body";
  return "none";
}

// ── the probe ─────────────────────────────────────────────────────────────

export interface ProbeOptions extends GuardOptions {
  /** Byte cap on the stored `raw` challenge. It is public data, but not free. */
  maxRawChars?: number;
}

/**
 * Fetch, read the 402, stop.
 *
 * Every network access goes through `guardedFetch`, so nothing here can reach a
 * private address, follow a redirect into one, or forward a credential. This
 * function makes exactly one outbound operation and never retries: a retry loop
 * in a service anyone can point at any URL is an amplification bug.
 */
export async function probe(
  rawUrl: string,
  options: ProbeOptions,
): Promise<GuardResult<ProbeResult>> {
  const fetched = await guardedFetch(rawUrl, options);
  if (!fetched.ok) return fetched;

  const response = fetched.value;
  const maxRawChars = options.maxRawChars ?? GUARD_LIMITS.maxBodyBytes;

  const form = extractForms(response.headers, response.body);
  const wireForm = classifyWireForm(form);

  // The header form is authoritative when present: it is what a v2 client
  // reads, and it is the copy whose exact bytes the strict decoder judges.
  const primaryPayload = form.headerPayload ?? form.bodyPayload;

  const rawForDecoder =
    form.header ?? (form.bodyPayload ? base64Encode(response.body) : null);

  const decoded: DecodeOutcome = rawForDecoder
    ? decodeChallenge(rawForDecoder, response.finalUrl.toString())
    : {
        valid: false,
        error:
          wireForm === "none"
            ? { code: "NOT_X402", message: "No x402 challenge was served." }
            : { code: "DECODE_FAILED", message: "The challenge could not be decoded." },
        normalized: null,
      };

  const acceptsRaw = Array.isArray(primaryPayload?.accepts)
    ? (primaryPayload.accepts as unknown[])
    : [];

  const observedTerms = acceptsRaw
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => normalizeRequirement(r, primaryPayload ?? {}));

  const xVersion =
    typeof primaryPayload?.x402Version === "number" ? primaryPayload.x402Version : null;

  const challenge: Challenge = {
    wire_form: wireForm,
    x402_version: xVersion,
    valid: decoded.valid,
    decode_error: decoded.error,
    // SPEC §4.2: a refused challenge exposes no accepted requirements. The
    // parsed view lives in `observed_terms`, where it cannot be read as a pass.
    accepts: decoded.valid ? observedTerms : [],
    requirement_count: acceptsRaw.length,
    raw_bytes: response.bytesRead,
    hash: primaryPayload ? await challengeHash(primaryPayload) : null,
    raw: rawForDecoder ? rawForDecoder.slice(0, maxRawChars) : null,
  };

  // Serving both copies is only reassuring if they say the same thing.
  const wireFormsAgree =
    wireForm === "both" && form.headerPayload && form.bodyPayload
      ? canonicalJson(form.headerPayload) === canonicalJson(form.bodyPayload)
      : null;

  const url = response.finalUrl;

  return {
    ok: true,
    value: {
      target: {
        url: rawUrl,
        canonical_url: response.canonicalUrl,
        endpoint_id: await endpointId(response.canonicalUrl),
        origin: url.origin,
        host: url.hostname,
      },
      probe: {
        observed_at: nowIso(),
        http_status: response.status,
        latency_ms: response.latencyMs,
        redirect_count: response.redirectCount,
        // Reaching an `https:` URL at all means the TLS handshake succeeded.
        // The negotiated protocol version is not exposed to a Worker, so it is
        // reported as null rather than guessed.
        tls: url.protocol === "https:" ? { ok: true, protocol: null } : null,
        bytes_read: response.bytesRead,
        served_from_cache: false,
        cache_age_seconds: null,
      },
      challenge,
      observed_terms: observedTerms,
      wire_forms_agree: wireFormsAgree,
    },
  };
}

/** Re-exported so callers need one import for the SDK bound they are checking. */
export { MAX_AUTHORIZATION_SECONDS };
