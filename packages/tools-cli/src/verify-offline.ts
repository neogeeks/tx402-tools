/**
 * Offline x402 challenge verification.
 *
 * Contract: `spec/SPEC.md` §5.2, with the frozen check ids in §5.2.1.
 * Deviations discovered while implementing them:.
 *
 * ── This function makes no network request, and that is the product ────────
 *
 * is the "no-backend firewall": the `tx402` SDK and its CLI never
 * contact `tools.tx402.io`, because `README.md` promises "no tx402-operated
 * service, no telemetry, no phone-home" and that claim has to stay
 * *mathematically* true rather than "true if you don't pass the flag".
 *
 * `verifyOffline` is where that promise is kept. It takes a challenge and
 * returns a verdict using only the bytes it was handed, the `tx402` decoder,
 * the tx402 signed release manifest and a bundled facilitator list — all of
 * which are already in the process. It opens no socket, resolves no name and
 * reads no file. `test/verify-offline.test.ts` asserts that with a `fetch` stub
 * and a guard `Connector` stub that both throw on invocation; **that test is
 * the enforcement of at the library level and must never be
 * deleted.**
 *
 * The corpus-dependent half of `/verify` — "is this amount within the range we
 * have observed", "is this the recipient we saw last time", "do we know this
 * endpoint at all" — is deliberately *not* here. It needs the hosted database,
 * so it is a separate, explicit opt-in on the hosted route
 * (`options.enrich`, SPEC §5.2). The three ids exist here only so that this
 * module reports them as `skip`: a check that could not run is never silently
 * counted as a pass (SPEC §4.3,. decision 5).
 *
 * ── One decoder, and it is the one that would refuse the payment ───────────
 *
 * `decodePaymentRequired` is imported from `tx402`. It is the same strict
 * decoder a buyer's client runs before it signs anything, which is the whole
 * differentiating claim of this product. Nothing here
 * re-implements it, and nothing here overrides its verdict:
 * `challenge.valid` is exactly what it returned.
 *
 * What this module adds is **attribution**. The decoder collapses every
 * structural problem into one throw carrying a `reason` and a `schemaPath`,
 * whereas SPEC §5.2.1 freezes a list of individually reportable check ids. So
 * the decoder's own reason is mapped onto exactly one of those ids, and the
 * checks it never reached report `skip` rather than a hollow pass. The mapping
 * is the table `DECODER_REASON_TO_CHECK`, and two tests in
 * `test/verify-offline.test.ts` keep it total: one asserts every reason the SDK
 * defines is in the table, the other asserts that a refused challenge always
 * produces at least one failing check.
 *
 * ── Two layers, because a broken challenge still has to be readable ────────
 *
 * Layer A — **structural**, from the decoder: base64 framing, byte cap, JSON
 * grammar, depth, duplicate keys, protocol version, `accepts` presence and
 * count, and the resource declaration.
 *
 * Layer B — **semantic**, from the normalized requirement: scheme, network,
 * asset, amount, recipient, timeout, mime type, extra, facilitator.
 *
 * Layer B runs whenever the payload could be parsed at all, *independently of
 * whether Layer A accepted it*. That is deliberate and it is the same reason
 * `worker/lib/probe.ts` keeps `observed_terms` next to `challenge.accepts`
 *: a report that says only "this does not decode"
 * is useless to the person trying to fix it. It also happens to be the only
 * way the frozen fixtures produce their documented verdicts — the whole point
 * of `spec/fixtures/hostile/non-atomic-amount.json` is the amount, and it is
 * shaped so that the decoder stops long before it reaches one.
 *
 * ── The language rules are not decoration ───────────────────
 *
 * Every string this module can emit describes an observation about a
 * challenge. The words *scam*, *fraud*, *fraudulent*, *unsafe*, *dangerous*
 * and *malicious* appear in none of them, in any code path. A check that could
 * not run says so; it never guesses, and "we have no history" is reported as
 * `skip`, never as a pass and never as a warning.
 */

import {
  BUNDLED_MANIFEST,
  MAX_AUTHORIZATION_SECONDS,
  MAX_PAYMENT_REQUIRED_BYTES,
  MAX_PAYMENT_REQUIRED_DEPTH,
  MAX_PAYMENT_REQUIREMENTS,
  decodePaymentRequired,
  resolveNetwork,
} from "tx402";

import {
  challengeHash,
  isCanonicalAtomic,
  isWellFormedRecipient,
  normalizeRequirement,
  type Challenge,
  type ProbeResult,
  type Requirement,
  type WireForm,
} from "../../../worker/lib/probe.js";
import {
  FACILITATOR_LIST_VERSION,
  facilitatorOrigins,
} from "../../../worker/lib/facilitators.js";
import { extractSignals, type Signal } from "../../../worker/lib/signals.js";
import { score, type Risk } from "../../../worker/lib/score.js";

// ── the frozen vocabulary (SPEC §5.2.1) ───────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type Verdict = "pass" | "warn" | "fail";

/** SPEC §4.3. */
export interface Check {
  id: string;
  status: CheckStatus;
  offline: boolean;
  reason: string | null;
  detail: string | null;
}

/**
 * The checks that run with zero network access, in the order SPEC §5.2.1 lists
 * them. Renderers walk this order, so a report reads the same way every time.
 */
export const OFFLINE_CHECK_IDS = [
  "wire_form_detected",
  "base64_strict",
  "size_within_limit",
  "depth_within_limit",
  "no_duplicate_keys",
  "json_wellformed",
  "x402_version_known",
  "accepts_present",
  "accepts_within_limit",
  "scheme_known",
  "network_caip2_wellformed",
  "network_recognized",
  "asset_recognized",
  "amount_atomic_canonical",
  "amount_positive",
  "pay_to_wellformed",
  "max_timeout_sane",
  "resource_origin_match",
  "mime_type_wellformed",
  "extra_wellformed",
  "facilitator_known",
] as const;

/**
 * The checks that need the hosted corpus. They are named here so this module
 * can report them as `skip` — an offline verifier that simply omitted them
 * would let a reader mistake "we did not look" for "there was nothing to
 * find".
 */
export const ENRICHED_CHECK_IDS = [
  "amount_within_observed_range",
  "recipient_matches_observed",
  "endpoint_known",
] as const;

export const CHECK_IDS = [...OFFLINE_CHECK_IDS, ...ENRICHED_CHECK_IDS] as const;

export type OfflineCheckId = (typeof OFFLINE_CHECK_IDS)[number];
export type EnrichedCheckId = (typeof ENRICHED_CHECK_IDS)[number];
export type CheckId = (typeof CHECK_IDS)[number];

const ENRICHED: ReadonlySet<string> = new Set(ENRICHED_CHECK_IDS);

// ── input ─────────────────────────────────────────────────────────────────

/**
 * The challenge as the caller has it. SPEC §5.2 requires exactly one of the
 * three, and `spec/schemas/common.json#/$defs/ChallengeInput` enforces it.
 *
 * - `header` — the `PAYMENT-REQUIRED` value, base64, exactly as served. Its
 *   bytes are what the decoder judges, so base64 strictness is a real check.
 * - `body`   — the legacy v1 JSON body, as an object or as text. Text keeps
 *   duplicate keys observable; an object has already lost them.
 * - `raw`    — "I pasted something." Classified by `classifyRaw`.
 */
export interface ChallengeInput {
  header?: string | null;
  body?: Record<string, unknown> | string | null;
  raw?: string | null;
}

export interface VerifyContext {
  /**
   * The endpoint the challenge came from. Without it `resource_origin_match`
   * reports `skip` and never `pass` (SPEC §5.2) — we cannot compare an origin
   * to one we were not given.
   */
  url?: string | null;
  /** An origin to compare against instead of `url`'s. */
  expected_origin?: string | null;
}

export interface VerifyOfflineOptions {
  context?: VerifyContext | null;
  /**
   * Facilitator origins that satisfy `facilitator_known`. Defaults to the
   * bundled list, which carries its own date — the hosted API passes the live
   * table instead, and the check reports which list answered (SPEC §5.2.1 ¹).
   */
  knownFacilitators?: ReadonlySet<string>;
  /** How the list above is described in `detail`. */
  facilitatorListLabel?: string;
  /** Payment schemes tx402 can route. */
  knownSchemes?: ReadonlySet<string>;
  /** Byte cap on the echoed `challenge.raw`. */
  maxRawChars?: number;
}

export interface OfflineVerification {
  verdict: Verdict;
  challenge: Challenge;
  checks: Check[];
  signals: Signal[];
  risk: Risk | null;
  /** Present when the challenge parsed at all; display-only, never a verdict. */
  observed_terms: Requirement[];
}

const DEFAULT_SCHEMES: ReadonlySet<string> = new Set(["exact"]);
const DEFAULT_MAX_RAW_CHARS = 128 * 1024;

/** Versions this tool recognizes as x402 at all, whether or not tx402 pays them. */
const KNOWN_X402_VERSIONS: ReadonlySet<number> = new Set([1, 2]);
/** The one version `decodePaymentRequired` accepts. Its own `supportedVersions`. */
const DECODER_VERSION = 2;

/**
 * CAIP-2, spelled exactly as `tx402`'s decoder spells it. Duplicated
 * deliberately and knowingly: the decoder does not export its grammar, and
 * `network_caip2_wellformed` has to be able to report on a network the decoder
 * never reached. `test/verify-offline.test.ts` pins the two together by
 * feeding the same values to both, so a divergence in a future SDK release is
 * a failing test rather than a silently wrong check.
 */
const CAIP2 = /^[a-z0-9-]{3,8}:[A-Za-z0-9-]{1,48}$/u;

/** RFC 6838 shape, loose about parameters and strict about the type/subtype. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;.*)?$/iu;

// ── check construction ────────────────────────────────────────────────────

class CheckSet {
  readonly #byId = new Map<string, Check>();

  set(id: CheckId, status: CheckStatus, reason: string | null, detail: string | null): void {
    // First write wins. Layer A (the decoder) runs first and is authoritative
    // about the structure it refused; Layer B must not overwrite a concrete
    // refusal with a softer opinion derived from the same bytes.
    if (this.#byId.has(id)) return;
    this.#byId.set(id, { id, status, offline: !ENRICHED.has(id), reason, detail });
  }

  pass(id: CheckId, detail: string | null = null): void {
    this.set(id, "pass", null, detail);
  }

  fail(id: CheckId, reason: string, detail: string | null = null): void {
    this.set(id, "fail", reason, detail);
  }

  warn(id: CheckId, reason: string, detail: string | null = null): void {
    this.set(id, "warn", reason, detail);
  }

  skip(id: CheckId, reason: string, detail: string | null = null): void {
    this.set(id, "skip", reason, detail);
  }

  has(id: CheckId): boolean {
    return this.#byId.has(id);
  }

  /**
   * Emit in the frozen order, filling anything still unset with an explicit
   * `skip`. A check that never got a verdict is a check that did not run, and
   * the response says so rather than dropping the row.
   */
  toArray(fallbackReason: string, fallbackDetail: string | null): Check[] {
    return CHECK_IDS.map(
      (id) =>
        this.#byId.get(id) ?? {
          id,
          status: "skip" as const,
          offline: !ENRICHED.has(id),
          reason: fallbackReason,
          detail: fallbackDetail,
        },
    );
  }
}

/**
 * SPEC §5.2, frozen: fail if any check failed, else warn if any warned, else
 * pass. The CLI and the API must agree bit for bit, so both call this.
 */
export function aggregateVerdict(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

// ── raw input classification ──────────────────────────────────────────────

export type RawKind = "header" | "body";

/**
 * Decide what a caller pasted.
 *
 * A JSON challenge always starts with `{`; a base64 header never does. That is
 * the whole rule, and it is deliberately not "try base64 and fall back",
 * because `spec/fixtures/hostile/bad-base64.txt` exists precisely to fail
 * `base64_strict` — a fallback would reclassify it as a body and report a JSON
 * error instead, hiding the finding the fixture was written to produce.
 */
export function classifyRaw(raw: string): RawKind {
  return raw.trimStart().startsWith("{") ? "body" : "header";
}

// ── base64 (the decoder's own strictness, reported separately) ────────────

/** Exactly the decoder's test: standard alphabet, correct padding, length %4. */
function isStrictBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 === 0;
}

function base64ToText(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

// ── the decoder's failure, mapped onto the frozen ids ─────────────────────

interface DecodeFailure {
  reason: string;
  schemaPath: string | null;
  code: string;
  message: string;
  observedVersion: unknown;
}

interface DecodeOutcome {
  valid: boolean;
  failure: DecodeFailure | null;
}

function runDecoder(header: string, requestUrl: string): DecodeOutcome {
  try {
    decodePaymentRequired(header, {
      requestUrl,
      requestMethod: "GET",
      requestId: "verify",
    });
    return { valid: true, failure: null };
  } catch (error) {
    const err = error as {
      code?: string;
      name?: string;
      message?: string;
      details?: { reason?: string; schemaPath?: string; observedVersion?: unknown };
    };
    return {
      valid: false,
      failure: {
        reason: err.details?.reason ?? "decode-failed",
        schemaPath: err.details?.schemaPath ?? null,
        code: err.code ?? err.name ?? "DECODE_FAILED",
        message: err.message ?? "The challenge could not be decoded.",
        observedVersion: err.details?.observedVersion,
      },
    };
  }
}

/**
 * Every reason `decodePaymentRequired` can throw, and the frozen check id that
 * carries it.
 *
 * Two entries are `null` because the reason is not specific enough on its own
 * and is resolved by `attributeDecodeFailure`: `upstream-schema-invalid`
 * depends on its `schemaPath`, and `requirements-count-out-of-range` covers
 * both "no requirements" and "too many".
 */
const DECODER_REASON_TO_CHECK: Readonly<Record<string, OfflineCheckId | null>> = Object.freeze({
  "missing-header": "wire_form_detected",
  "invalid-base64": "base64_strict",
  "header-too-large": "size_within_limit",
  "json-depth-exceeded": "depth_within_limit",
  "duplicate-json-key": "no_duplicate_keys",
  "invalid-json": "json_wellformed",
  "unsupported-protocol-version": "x402_version_known",
  "resource-url-invalid": "resource_origin_match",
  "resource-origin-mismatch": "resource_origin_match",
  "amount-not-atomic-integer": "amount_atomic_canonical",
  "requirements-count-out-of-range": null,
  "upstream-schema-invalid": null,
});

/**
 * The order `decodePaymentRequired` performs its structural checks in, read
 * off its implementation rather than guessed.
 *
 * It short-circuits on the first problem, so every stage *before* the failure
 * point genuinely passed and every stage at or after it was never examined.
 * The un-examined ones are left unset rather than stamped `skip`, so Layer B
 * can still determine them from the payload — that matters: an 80 KB challenge
 * offering 200 requirements trips the byte cap long before the decoder counts
 * anything, and reporting only "too large" would silently drop the second,
 * equally real finding. Whatever neither layer can determine falls through to
 * an explicit `skip`, because SPEC §4.3 is emphatic that a check which did not
 * run is never counted as a pass.
 *
 * Three stages have no check id of their own: the top-level `resource` declaration and the
 * requirement-field validation are reported through `resource_origin_match` and the per-field ids
 * respectively (see. , but they still occupy their real position here, because what the decoder
 * reached is a fact about the decoder and not about which ids we happen to have.
 *
 * One presentation choice, stated because it is a choice: the decoder's JSON
 * preflight is a single pass that can raise grammar, depth or duplicate-key
 * errors at any point, so those three are ordered here rather than genuinely
 * sequential. The stage that failed is always exact; the ones before it are
 * true of the document up to the point the parser stopped.
 */
const RESOURCE_DECLARATION = "\0resource-declaration";
const RESOURCE_URL = "\0resource-url";
const REQUIREMENT_FIELDS = "\0requirement-fields";

const DECODER_STAGES: readonly string[] = [
  "wire_form_detected",
  "base64_strict",
  "size_within_limit",
  "json_wellformed",
  "depth_within_limit",
  "no_duplicate_keys",
  "x402_version_known",
  RESOURCE_DECLARATION,
  "accepts_present",
  "accepts_within_limit",
  RESOURCE_URL,
  REQUIREMENT_FIELDS,
];

/** The check ids among the stages, in order — everything the decoder can pass. */
const DECODER_STAGE_CHECKS = DECODER_STAGES.filter(
  (stage) => !stage.startsWith("\0"),
) as readonly OfflineCheckId[];

/**
 * SPEC §5.2.1 gives no id for "the payload does not match the x402 v2
 * envelope", so an `upstream-schema-invalid` at `/resource` is carried by
 * `resource_origin_match` and one at `/accepts/N` is disambiguated per field.
 * Both are.; inventing an id is forbidden and
 * letting the refusal go unreported would leave a challenge tx402 will not pay
 * looking like a warning.
 */
interface Attribution {
  id: OfflineCheckId;
  reason: string;
  detail: string;
  /** Where in `DECODER_STAGES` the decoder actually stopped. */
  stage: string;
}

function attributeDecodeFailure(
  failure: DecodeFailure,
  requirement: Requirement | null,
  rawRequirement: Record<string, unknown> | null,
  acceptsLength: number | null,
): Attribution | null {
  const mapped = DECODER_REASON_TO_CHECK[failure.reason];
  if (mapped) {
    return {
      id: mapped,
      reason: failure.reason,
      detail: failure.message,
      stage:
        failure.reason === "resource-url-invalid" || failure.reason === "resource-origin-mismatch"
          ? RESOURCE_URL
          : mapped,
    };
  }

  if (failure.reason === "requirements-count-out-of-range") {
    if (acceptsLength !== null && acceptsLength > MAX_PAYMENT_REQUIREMENTS) {
      return {
        id: "accepts_within_limit",
        reason: "too-many-requirements",
        detail: `The challenge offers ${acceptsLength} payment requirements; the decoder accepts at most ${MAX_PAYMENT_REQUIREMENTS}.`,
        stage: "accepts_within_limit",
      };
    }
    return {
      id: "accepts_present",
      reason: "accepts-missing-or-empty",
      detail: "The challenge offers no payment requirements, so there is nothing to pay.",
      stage: "accepts_present",
    };
  }

  if (failure.reason === "upstream-schema-invalid") {
    if (failure.schemaPath === "/resource" || failure.schemaPath === "/resource/url") {
      // Reported by `applyResourceOriginCheck`, which can say something more
      // useful than "the envelope is wrong" when it also has a context URL.
      return {
        id: "resource_origin_match",
        reason: "resource-declaration-missing",
        detail: v1LayoutDetail(requirement),
        stage: RESOURCE_DECLARATION,
      };
    }
    if (failure.schemaPath?.startsWith("/accepts/")) {
      return attributeRequirementFailure(failure, requirement, rawRequirement);
    }
    return {
      id: "json_wellformed",
      reason: "not-a-challenge-object",
      detail: "The payload is not an x402 challenge object.",
      stage: "json_wellformed",
    };
  }

  return null;
}

/**
 * The single most common shape of this failure, named precisely.
 *
 * x402 v2 moved the resource out of each requirement and into a top-level
 * `resource: { url }` object. A payload that
 * declares version 2 and then puts a `resource` string on each requirement is
 * a real interoperability bug that real endpoints have, and telling an
 * operator exactly which field moved is the difference between a report they
 * can act on and one they cannot.
 */
function v1LayoutDetail(requirement: Requirement | null): string {
  return requirement?.resource
    ? "The challenge carries a per-requirement `resource` string — the x402 v1 layout — but no top-level `resource.url`. x402 v2 moved the resource into a top-level object, so tx402's decoder refuses this payload."
    : "The challenge carries no top-level `resource.url`. x402 v2 requires one, so there is no declared resource to compare against the endpoint.";
}

/**
 * Which mandatory requirement field the decoder refused.
 *
 * The decoder validates them together and throws one error, so the field is
 * recovered here by asking the same questions in the same order. This is not a
 * second decoder — it changes no verdict, it only decides which frozen id
 * reports the one the decoder already gave.
 */
function attributeRequirementFailure(
  failure: DecodeFailure,
  requirement: Requirement | null,
  raw: Record<string, unknown> | null,
): Attribution {
  const stage = REQUIREMENT_FIELDS;
  const generic = {
    id: "json_wellformed" as const,
    reason: "requirement-schema-invalid",
    detail: failure.message,
    stage,
  };
  if (!raw) return generic;

  const network = raw.network;
  if (typeof network !== "string" || !CAIP2.test(network)) {
    return {
      id: "network_caip2_wellformed",
      reason: typeof network === "string" ? "not-caip2" : "network-absent",
      detail:
        typeof network === "string"
          ? `"${network}" is not a well-formed CAIP-2 network id.`
          : "The requirement declares no network.",
      stage,
    };
  }

  const payTo = raw.payTo;
  if (typeof payTo !== "string" || payTo.length === 0 || payTo.length > 128) {
    return {
      id: "pay_to_wellformed",
      reason: "pay-to-absent",
      detail: "The requirement declares no recipient.",
      stage,
    };
  }

  const timeout = raw.maxTimeoutSeconds;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 86_400) {
    return {
      id: "max_timeout_sane",
      reason: timeout === undefined ? "timeout-absent" : "timeout-out-of-range",
      detail:
        timeout === undefined
          ? "The requirement declares no authorization window."
          : `The authorization window ${JSON.stringify(timeout)} is outside the range the decoder accepts (1–86400 seconds).`,
      stage,
    };
  }

  const scheme = raw.scheme;
  if (typeof scheme !== "string" || scheme.length === 0 || scheme.length > 64) {
    return {
      id: "scheme_known",
      reason: "scheme-absent",
      detail: "The requirement declares no payment scheme.",
      stage,
    };
  }

  const asset = raw.asset;
  if (typeof asset !== "string" || asset.length === 0 || asset.length > 128) {
    return {
      id: "asset_recognized",
      reason: "asset-absent",
      detail: "The requirement declares no asset, so there is nothing to pay with.",
      stage,
    };
  }

  if (asRecord(raw.extra) === null) {
    return {
      id: "extra_wellformed",
      reason: raw.extra === undefined ? "extra-absent" : "extra-not-object",
      detail:
        raw.extra === undefined
          ? "The requirement declares no `extra` object, which x402 v2 requires."
          : "`extra` is present and is not a JSON object.",
      stage,
    };
  }

  void requirement;
  return generic;
}

// ── the verifier ──────────────────────────────────────────────────────────

/**
 * Verify one x402 challenge without touching the network.
 *
 * Async only because the challenge hash is a Web Crypto digest. Nothing here
 * awaits I/O, and there is none to await.
 */
export async function verifyOffline(
  input: ChallengeInput,
  options: VerifyOfflineOptions = {},
): Promise<OfflineVerification> {
  const checks = new CheckSet();
  const context = options.context ?? null;
  const schemes = options.knownSchemes ?? DEFAULT_SCHEMES;
  const facilitators = options.knownFacilitators ?? facilitatorOrigins();
  const listLabel =
    options.facilitatorListLabel ?? `the bundled list dated ${FACILITATOR_LIST_VERSION}`;
  const maxRawChars = options.maxRawChars ?? DEFAULT_MAX_RAW_CHARS;

  // ── what were we given, and in which wire form ──────────────────────────
  const shape = readInput(input);

  if (shape.kind === "none") {
    checks.fail(
      "wire_form_detected",
      "no-challenge",
      "No challenge was supplied. Provide the PAYMENT-REQUIRED header value, or the v1 JSON body.",
    );
    return finish(
      checks,
      emptyChallenge(),
      [],
      "no-challenge",
      "No challenge was supplied, so there was nothing to check.",
      context,
    );
  }

  checks.pass(
    "wire_form_detected",
    shape.wireForm === "v2-header"
      ? "Read as an x402 v2 PAYMENT-REQUIRED header value."
      : "Read as a legacy x402 v1 JSON body.",
  );

  // ── base64 framing ─────────────────────────────────────────────────────
  // Only a header has any. A v1 body is JSON on the wire, so there is no
  // base64 to be strict about and reporting a pass would be reporting on a
  // framing the endpoint never used. `worker/lib/probe.ts` documents the same
  // reasoning where it encodes a body to satisfy the decoder's input type.
  if (shape.wireForm === "v2-header") {
    if (!isStrictBase64(shape.headerValue)) {
      checks.fail(
        "base64_strict",
        "not-strict-base64",
        "The header value is not strict base64: it contains whitespace, a URL-safe alphabet character, or incorrect padding.",
      );
    } else if (shape.jsonText === null) {
      checks.fail(
        "base64_strict",
        "not-utf8",
        "The header value is base64 but does not decode to valid UTF-8 text.",
      );
    } else {
      checks.pass("base64_strict");
    }
  } else {
    checks.skip(
      "base64_strict",
      "no_base64_framing",
      "A v1 challenge is carried as a JSON body, so there is no base64 framing to check.",
    );
  }

  // ── size, measured on the bytes the decoder would measure ──────────────
  const byteLength =
    shape.jsonText === null ? null : new TextEncoder().encode(shape.jsonText).length;
  if (byteLength === null) {
    checks.skip(
      "size_within_limit",
      "not_decodable",
      "The challenge could not be decoded to text, so its size was not measured.",
    );
  } else if (byteLength > MAX_PAYMENT_REQUIRED_BYTES) {
    checks.fail(
      "size_within_limit",
      "too-large",
      `The challenge is ${byteLength} bytes; the decoder accepts at most ${MAX_PAYMENT_REQUIRED_BYTES}.`,
    );
  } else {
    checks.pass("size_within_limit");
  }

  // ── duplicate keys are only observable in text ─────────────────────────
  if (shape.duplicateKeysObservable) {
    // Left for the decoder's preflight, below.
  } else {
    checks.skip(
      "no_duplicate_keys",
      "body_pre_parsed",
      "The body was supplied already parsed, so any duplicate key was resolved before we saw it. Send the body as text to check this.",
    );
  }

  // ── run the decoder ────────────────────────────────────────────────────
  const payload = shape.jsonText === null ? null : safeJson(shape.jsonText);
  const acceptsRaw = Array.isArray(payload?.accepts) ? (payload.accepts as unknown[]) : null;
  const rawRequirement = acceptsRaw ? asRecord(acceptsRaw[0] ?? null) : null;

  const observedTerms = (acceptsRaw ?? [])
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => normalizeRequirement(r, payload ?? {}));
  const requirement = observedTerms[0] ?? null;

  // The decoder enforces `resource.url`'s origin against the request URL, so
  // it cannot run without one. When the caller supplied no context we hand it
  // the challenge's own declared resource — which makes its origin check
  // vacuous, and is exactly why `resource_origin_match` then reports `skip`
  // rather than `pass` (SPEC §5.2). When the caller DID supply a URL, that URL
  // is used and a mismatch is a real refusal from the real decoder.
  const contextUrl = normalizeContextUrl(context);
  const declaredResource = declaredResourceUrl(payload, requirement);
  const decoderRequestUrl = contextUrl ?? declaredResource ?? "https://challenge.invalid/";

  const decoded = runDecoder(shape.headerForDecoder, decoderRequestUrl);

  const resourceRefusal = applyDecoderVerdict(checks, decoded, {
    requirement,
    rawRequirement,
    acceptsLength: acceptsRaw?.length ?? null,
    declaredVersion: typeof payload?.x402Version === "number" ? payload.x402Version : null,
  });

  // ── Layer B: the semantic checks, run whatever the decoder decided ──────
  applySemanticChecks(
    checks,
    {
      payload,
      requirement,
      rawRequirement,
      acceptsLength: acceptsRaw?.length ?? null,
      contextUrl,
      schemes,
      facilitators,
      listLabel,
    },
    resourceRefusal,
  );

  // ── the corpus-dependent trio: not here, and honest about it ────────────
  for (const id of ENRICHED_CHECK_IDS) {
    checks.skip(
      id,
      "offline_only",
      "This check needs the hosted corpus. The offline verifier does not contact it.",
    );
  }

  const challenge: Challenge = {
    wire_form: shape.wireForm,
    x402_version: typeof payload?.x402Version === "number" ? payload.x402Version : null,
    valid: decoded.valid,
    decode_error: decoded.failure
      ? { code: decoded.failure.code, message: decoded.failure.message }
      : null,
    // SPEC §4.2: a refused challenge exposes no accepted requirements, so it
    // can never be read as accepted. The parsed view stays in `observed_terms`.
    accepts: decoded.valid ? observedTerms : [],
    requirement_count: acceptsRaw?.length ?? 0,
    raw_bytes: byteLength,
    hash: payload ? await challengeHash(payload) : null,
    raw: shape.rawEcho.slice(0, maxRawChars),
  };

  return finish(
    checks,
    challenge,
    observedTerms,
    "not_reached",
    "The decoder stopped before this check and the payload did not supply enough to determine it independently.",
    context,
  );
}

function finish(
  checks: CheckSet,
  challenge: Challenge,
  observedTerms: Requirement[],
  fallbackReason: string,
  fallbackDetail: string | null,
  context: VerifyContext | null,
): OfflineVerification {
  const list = checks.toArray(fallbackReason, fallbackDetail);
  const signals = signalsFor(challenge, observedTerms, context);
  return {
    verdict: aggregateVerdict(list),
    challenge,
    checks: list,
    signals,
    risk: score(signals),
    observed_terms: observedTerms,
  };
}

// ── input reading ─────────────────────────────────────────────────────────

interface InputShape {
  kind: "header" | "body" | "none";
  wireForm: WireForm;
  /** The header exactly as supplied, or "" for a body. */
  headerValue: string;
  /** What the decoder is fed. A body is base64-encoded to satisfy its type. */
  headerForDecoder: string;
  /** The challenge as text, or null when it could not be recovered. */
  jsonText: string | null;
  /** Echoed back as `challenge.raw`. */
  rawEcho: string;
  /** False when the caller handed us an already-parsed object. */
  duplicateKeysObservable: boolean;
}

function readInput(input: ChallengeInput): InputShape {
  const header = typeof input.header === "string" && input.header.length > 0 ? input.header : null;
  const raw = typeof input.raw === "string" && input.raw.trim().length > 0 ? input.raw : null;
  const body = input.body ?? null;

  if (header !== null) return headerShape(header.trim());

  if (body !== null) {
    if (typeof body === "string") {
      return body.trim().length === 0 ? noneShape() : bodyShape(body, true);
    }
    return bodyShape(JSON.stringify(body), false);
  }

  if (raw !== null) {
    return classifyRaw(raw) === "body" ? bodyShape(raw, true) : headerShape(raw.trim());
  }

  return noneShape();
}

function headerShape(header: string): InputShape {
  const text = isStrictBase64(header) ? base64ToText(header) : null;
  return {
    kind: "header",
    wireForm: "v2-header",
    headerValue: header,
    headerForDecoder: header,
    jsonText: text,
    rawEcho: header,
    duplicateKeysObservable: true,
  };
}

function bodyShape(text: string, fromText: boolean): InputShape {
  return {
    kind: "body",
    wireForm: "v1-body",
    headerValue: "",
    headerForDecoder: textToBase64(text),
    jsonText: text,
    rawEcho: text,
    duplicateKeysObservable: fromText,
  };
}

function noneShape(): InputShape {
  return {
    kind: "none",
    wireForm: "none",
    headerValue: "",
    headerForDecoder: "",
    jsonText: null,
    rawEcho: "",
    duplicateKeysObservable: false,
  };
}

function emptyChallenge(): Challenge {
  return {
    wire_form: "none",
    x402_version: null,
    valid: false,
    decode_error: { code: "NOT_X402", message: "No x402 challenge was supplied." },
    accepts: [],
    requirement_count: 0,
    raw_bytes: null,
    hash: null,
    raw: null,
  };
}

function normalizeContextUrl(context: VerifyContext | null): string | null {
  const candidate = context?.expected_origin ?? context?.url ?? null;
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function declaredResourceUrl(
  payload: Record<string, unknown> | null,
  requirement: Requirement | null,
): string | null {
  const resourceObject = asRecord(payload?.resource);
  const candidate =
    (typeof resourceObject?.url === "string" ? resourceObject.url : null) ??
    requirement?.resource ??
    null;
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

// ── Layer A ───────────────────────────────────────────────────────────────

interface DecoderApplyInput {
  requirement: Requirement | null;
  rawRequirement: Record<string, unknown> | null;
  acceptsLength: number | null;
  declaredVersion: number | null;
}

/** What Layer A concluded about the resource declaration, for Layer B to use. */
interface ResourceRefusal {
  reason: string;
  detail: string;
  /** True when the decoder itself compared origins and refused. */
  fromOriginComparison: boolean;
}

function applyDecoderVerdict(
  checks: CheckSet,
  decoded: DecodeOutcome,
  input: DecoderApplyInput,
): ResourceRefusal | null {
  if (decoded.valid) {
    for (const id of DECODER_STAGE_CHECKS) checks.pass(id);
    return null;
  }

  const failure = decoded.failure;
  /* c8 ignore next */
  if (!failure) return null;

  // A refusal that lands on no frozen id would let a challenge tx402 will not
  // pay come back as `warn`. `DECODER_REASON_TO_CHECK` is total for every
  // reason the SDK defines and a test asserts it; this is the belt to that
  // braces.
  const target: Attribution = attributeDecodeFailure(
    failure,
    input.requirement,
    input.rawRequirement,
    input.acceptsLength,
  ) ?? {
    id: "json_wellformed",
    reason: failure.reason,
    detail: failure.message,
    stage: "json_wellformed",
  };

  // Only the stages strictly before the one that failed were examined.
  const failedAt = DECODER_STAGES.indexOf(target.stage);
  const reached = failedAt < 0 ? DECODER_STAGES : DECODER_STAGES.slice(0, failedAt);
  for (const stage of reached) {
    if (!stage.startsWith("\0")) checks.pass(stage as OfflineCheckId);
  }

  // The resource stages are reported by `applyResourceOriginCheck`, which can
  // say something more specific once it also has the caller's context URL.
  if (target.id === "resource_origin_match") {
    return {
      reason: target.reason,
      detail: target.detail,
      fromOriginComparison: failure.reason === "resource-origin-mismatch",
    };
  }

  checks.fail(target.id, target.reason, decoderDetail(target, input));
  return null;
}

function decoderDetail(target: Attribution, input: DecoderApplyInput): string {
  if (target.id !== "x402_version_known") return target.detail;

  //. decision 5: a v1 endpoint scoring lower is a statement
  // about what tx402 can pay, not a judgement about the operator. Say which.
  const declared = input.declaredVersion;
  if (declared !== null && KNOWN_X402_VERSIONS.has(declared) && declared !== DECODER_VERSION) {
    return `The challenge declares x402 version ${declared}. tx402 decodes version ${DECODER_VERSION} only, so a tx402 buyer cannot pay this challenge as served. This describes what the SDK accepts, not the endpoint.`;
  }
  return declared === null
    ? "The challenge declares no x402 version."
    : `The challenge declares x402 version ${declared}, which this tool does not recognize.`;
}

// ── Layer B ───────────────────────────────────────────────────────────────

interface SemanticInput {
  payload: Record<string, unknown> | null;
  requirement: Requirement | null;
  rawRequirement: Record<string, unknown> | null;
  acceptsLength: number | null;
  contextUrl: string | null;
  schemes: ReadonlySet<string>;
  facilitators: ReadonlySet<string>;
  listLabel: string;
}

/**
 * The per-requirement checks.
 *
 * The rule that decides `fail` from `warn` here is worth stating once, because
 * it is applied consistently and has to match it:
 *
 *   **"not in the challenge" is a `fail`. "not on our list" is a `warn`.**
 *
 * A field x402 makes mandatory — network, asset, recipient, amount,
 * authorization window — being absent is a defect in the challenge, and a
 * buyer cannot pay it. That is a `fail`, and SPEC §6.3's "unknown is not bad"
 * rule does not apply: §6.3 is about *our* inability to observe something,
 * not about a merchant omitting something required. Whereas a network, asset
 * or facilitator that is present but absent from a list *we* publish is a
 * statement about the coverage of our list, so it warns.
 */
function applySemanticChecks(
  checks: CheckSet,
  input: SemanticInput,
  resourceRefusal: ResourceRefusal | null,
): void {
  const { payload, requirement, rawRequirement } = input;

  if (payload === null) {
    const reason = "no_payload";
    const detail = "The challenge could not be parsed, so its terms were not examined.";
    for (const id of [
      "x402_version_known",
      "accepts_present",
      "accepts_within_limit",
      "scheme_known",
      "network_caip2_wellformed",
      "network_recognized",
      "asset_recognized",
      "amount_atomic_canonical",
      "amount_positive",
      "pay_to_wellformed",
      "max_timeout_sane",
      "resource_origin_match",
      "mime_type_wellformed",
      "extra_wellformed",
      "facilitator_known",
    ] as const) {
      checks.skip(id, reason, detail);
    }
    return;
  }

  // ── envelope ──
  const version = payload.x402Version;
  if (typeof version !== "number" || !KNOWN_X402_VERSIONS.has(version)) {
    checks.fail(
      "x402_version_known",
      version === undefined ? "version-absent" : "version-unknown",
      version === undefined
        ? "The challenge declares no `x402Version`."
        : `The challenge declares x402 version ${JSON.stringify(version)}, which this tool does not recognize.`,
    );
  } else if (version !== DECODER_VERSION) {
    checks.fail(
      "x402_version_known",
      "unsupported-protocol-version",
      `The challenge declares x402 version ${version}. tx402 decodes version ${DECODER_VERSION} only, so a tx402 buyer cannot pay this challenge as served. This describes what the SDK accepts, not the endpoint.`,
    );
  } else {
    checks.pass("x402_version_known");
  }

  const acceptsLength = input.acceptsLength;
  if (acceptsLength === null) {
    checks.fail(
      "accepts_present",
      "accepts-missing",
      "The challenge has no `accepts` array, so it offers no way to pay.",
    );
  } else if (acceptsLength === 0) {
    checks.fail(
      "accepts_present",
      "accepts-empty",
      "The challenge's `accepts` array is empty, so it offers no way to pay.",
    );
  } else {
    checks.pass("accepts_present");
  }

  if (acceptsLength === null) {
    checks.skip("accepts_within_limit", "accepts-missing", "There is no `accepts` array to count.");
  } else if (acceptsLength > MAX_PAYMENT_REQUIREMENTS) {
    checks.fail(
      "accepts_within_limit",
      "too-many-requirements",
      `The challenge offers ${acceptsLength} payment requirements; the decoder accepts at most ${MAX_PAYMENT_REQUIREMENTS}.`,
    );
  } else {
    checks.pass("accepts_within_limit");
  }

  // ── resource origin ──
  applyResourceOriginCheck(checks, input, resourceRefusal);

  if (requirement === null) {
    const reason = "no_requirement";
    const detail =
      "The challenge offers no readable payment requirement, so its terms were not examined.";
    for (const id of [
      "scheme_known",
      "network_caip2_wellformed",
      "network_recognized",
      "asset_recognized",
      "amount_atomic_canonical",
      "amount_positive",
      "pay_to_wellformed",
      "max_timeout_sane",
      "mime_type_wellformed",
      "extra_wellformed",
      "facilitator_known",
    ] as const) {
      checks.skip(id, reason, detail);
    }
    return;
  }

  // ── scheme ──
  if (requirement.scheme === null) {
    checks.fail(
      "scheme_known",
      "scheme-absent",
      "The requirement declares no payment scheme.",
    );
  } else if (input.schemes.has(requirement.scheme)) {
    checks.pass("scheme_known");
  } else {
    checks.warn(
      "scheme_known",
      "scheme-unrecognized",
      `"${requirement.scheme}" is not a payment scheme tx402 can route. That is a statement about tx402's coverage.`,
    );
  }

  // ── network ──
  if (requirement.network === null) {
    checks.fail(
      "network_caip2_wellformed",
      "network-absent",
      "The requirement declares no network.",
    );
  } else if (CAIP2.test(requirement.network)) {
    checks.pass("network_caip2_wellformed");
  } else {
    checks.fail(
      "network_caip2_wellformed",
      "not-caip2",
      `"${requirement.network}" is not a well-formed CAIP-2 network id. x402 v2 uses CAIP-2, so a legacy name such as "base" no longer identifies a chain unambiguously.`,
    );
  }

  if (requirement.network === null) {
    checks.skip(
      "network_recognized",
      "network-absent",
      "There is no network to look up in the manifest.",
    );
  } else if (requirement.network_recognized === true) {
    checks.pass(
      "network_recognized",
      "Recognized means present in the tx402 signed release manifest, and nothing more.",
    );
  } else {
    checks.warn(
      "network_recognized",
      "not-in-manifest",
      `"${requirement.network}" is not in the tx402 signed release manifest. That is a statement about the manifest's coverage.`,
    );
  }

  // ── asset ──
  if (requirement.asset === null) {
    checks.fail(
      "asset_recognized",
      "asset-absent",
      "The requirement declares no asset, so there is nothing to pay with.",
    );
  } else if (requirement.asset.recognized === true) {
    checks.pass(
      "asset_recognized",
      "Recognized means present in the tx402 signed release manifest for this network.",
    );
  } else {
    checks.warn(
      "asset_recognized",
      "not-in-manifest",
      "This asset is not in the tx402 signed release manifest for this network. That is a statement about the manifest's coverage.",
    );
  }

  // ── amount ──
  applyAmountChecks(checks, requirement);

  // ── recipient ──
  if (requirement.pay_to === null) {
    checks.fail("pay_to_wellformed", "pay-to-absent", "The requirement declares no recipient.");
  } else if (requirement.pay_to_dynamic === true) {
    // SPEC §6.4 /.: v2 defines `payTo` as "recipient
    // wallet address or role constant". A role constant is a declaration of
    // per-request routing, not a malformed address, and treating it as one is
    // the crying-wolf failure names.
    checks.pass(
      "pay_to_wellformed",
      "The recipient is a declared role constant rather than a fixed address, which x402 v2 permits.",
    );
  } else if (isWellFormedRecipient(requirement.pay_to, requirement.network)) {
    checks.pass("pay_to_wellformed");
  } else {
    checks.fail(
      "pay_to_wellformed",
      "not-an-address",
      "The recipient is not a well-formed address for the declared network.",
    );
  }

  // ── authorization window ──
  applyTimeoutCheck(checks, requirement, rawRequirement);

  // ── mime type ──
  if (requirement.mime_type === null) {
    checks.skip("mime_type_wellformed", "absent", "The challenge declares no media type.");
  } else if (MEDIA_TYPE.test(requirement.mime_type)) {
    checks.pass("mime_type_wellformed");
  } else {
    checks.warn(
      "mime_type_wellformed",
      "not-a-media-type",
      `"${requirement.mime_type}" is not a well-formed media type.`,
    );
  }

  // ── extra ──
  const rawExtra = rawRequirement?.extra;
  if (rawExtra === undefined) {
    checks.skip("extra_wellformed", "absent", "The requirement declares no `extra` object.");
  } else if (asRecord(rawExtra) === null) {
    checks.warn(
      "extra_wellformed",
      "extra-not-object",
      "`extra` is present and is not a JSON object.",
    );
  } else {
    checks.pass("extra_wellformed");
  }

  // ── facilitator ──
  applyFacilitatorCheck(checks, requirement, input);
}

function applyAmountChecks(checks: CheckSet, requirement: Requirement): void {
  const rawAmount = requirement.amount_raw;

  if (rawAmount === null) {
    checks.fail("amount_atomic_canonical", "amount-absent", "The requirement declares no amount.");
    checks.skip("amount_positive", "amount-absent", "There is no amount to compare against zero.");
    return;
  }

  // Bound to a local rather than tested inline: `isCanonicalAtomic` is a type
  // predicate, and negating it over an already-narrowed string would leave
  // `never` behind for the message below.
  const canonical: boolean = isCanonicalAtomic(rawAmount);
  if (!canonical) {
    checks.fail(
      "amount_atomic_canonical",
      "not-atomic",
      `The amount "${rawAmount}" is not a canonical atomic integer (SPEC §1.4: digits only, no sign, no decimal point, no leading zeros). Its value is open to interpretation, which is exactly the mistake that overpays by a factor of the asset's decimals.`,
    );
  } else {
    checks.pass("amount_atomic_canonical");
  }

  // A non-canonical amount can still be read for sign — "-1000" and "0.00"
  // are both unambiguously not a positive charge — so this check runs anyway
  // rather than skipping and losing the finding.
  const numeric = Number(rawAmount);
  if (!Number.isFinite(numeric)) {
    checks.skip(
      "amount_positive",
      "amount-unreadable",
      `The amount "${rawAmount}" could not be read as a number.`,
    );
  } else if (numeric > 0) {
    checks.pass("amount_positive");
  } else {
    checks.fail(
      "amount_positive",
      numeric === 0 ? "amount-zero" : "amount-negative",
      `The amount "${rawAmount}" is not a positive charge.`,
    );
  }
}

/**
 * `max_timeout_sane`, split where SPEC §5.2.1 does not split it.
 *
 * The frozen row reads "absent, non-positive, or beyond the SDK's maximum",
 * and the first two stay a `fail` — a challenge with no authorization window
 * is one the decoder itself refuses. The third is downgraded to `warn`:
 * `MAX_AUTHORIZATION_SECONDS` is 60, every frozen fixture declares 300, and
 * 300 is common and legitimate in the wild. A
 * hard fail there would make almost every real endpoint fail verification,
 * which is the crying-wolf failure exists to prevent. Recorded in. so implements the same split.
 */
function applyTimeoutCheck(
  checks: CheckSet,
  requirement: Requirement,
  raw: Record<string, unknown> | null,
): void {
  const declared = raw?.maxTimeoutSeconds;
  const seconds = requirement.max_timeout_seconds;

  if (seconds === null) {
    checks.fail(
      "max_timeout_sane",
      declared === undefined ? "timeout-absent" : "timeout-not-an-integer",
      declared === undefined
        ? "The requirement declares no authorization window."
        : `The authorization window ${JSON.stringify(declared)} is not a whole number of seconds.`,
    );
    return;
  }

  if (seconds < 1) {
    checks.fail(
      "max_timeout_sane",
      "timeout-not-positive",
      `The authorization window ${seconds}s is not a positive duration.`,
    );
    return;
  }

  if (seconds > MAX_AUTHORIZATION_SECONDS) {
    checks.warn(
      "max_timeout_sane",
      "beyond-sdk-maximum",
      `The authorization window is ${seconds}s; tx402 signs for at most ${MAX_AUTHORIZATION_SECONDS}s. Longer windows are common and legitimate, but tx402 will not sign this one as it stands.`,
    );
    return;
  }

  checks.pass("max_timeout_sane");
}

/**
 * `resource_origin_match`, decided in one place from both layers.
 *
 * The precedence is deliberate. A concrete origin mismatch is by far the most
 * actionable thing this check can report — it is the shape of a challenge
 * pointing its payment at somebody else's origin — so it outranks the more
 * generic "this payload is not v2-shaped". Both are failures, so the verdict
 * is identical either way; only the sentence the reader gets differs, and the
 * specific one is worth more than the general one.
 *
 * The frozen fixtures make this concrete: `hostile/origin-mismatch.json` is
 * written in the v1 layout, so the decoder stops at the missing top-level
 * `resource` and never performs its own origin comparison. Attributing the
 * refusal and stopping there would report "not v2-shaped" about a fixture
 * whose entire purpose is that it points at another origin.
 */
function applyResourceOriginCheck(
  checks: CheckSet,
  input: SemanticInput,
  refusal: ResourceRefusal | null,
): void {
  const declared = declaredResourceUrl(input.payload, input.requirement);
  const mismatch = originMismatch(declared, input.contextUrl);

  if (mismatch) {
    checks.fail(
      "resource_origin_match",
      "origin-mismatch",
      `The challenge's resource points at ${mismatch.declared}, but it was served by ${mismatch.context}. A challenge describing a resource on a different origin is the shape of a payment redirected away from the endpoint you are calling.`,
    );
    return;
  }

  if (refusal) {
    checks.fail("resource_origin_match", refusal.reason, refusal.detail);
    return;
  }

  if (input.contextUrl === null) {
    checks.skip(
      "resource_origin_match",
      "no_context_url",
      "No endpoint URL was supplied, so the challenge's resource origin could not be compared with the endpoint that served it. Supply `context.url` to run this check.",
    );
    return;
  }

  if (declared === null) {
    checks.fail(
      "resource_origin_match",
      "resource-absent",
      "The challenge declares no resource URL, so there is nothing to compare with the endpoint that served it.",
    );
    return;
  }

  checks.pass("resource_origin_match");
}

function originMismatch(
  declared: string | null,
  contextUrl: string | null,
): { declared: string; context: string } | null {
  if (declared === null || contextUrl === null) return null;
  try {
    const a = new URL(declared).origin;
    const b = new URL(contextUrl).origin;
    return a === b ? null : { declared: a, context: b };
  } catch {
    return null;
  }
}

function applyFacilitatorCheck(
  checks: CheckSet,
  requirement: Requirement,
  input: SemanticInput,
): void {
  const declared = requirement.facilitator;

  if (!declared) {
    // x402 does not require a challenge to name its facilitator, and most do
    // not. So absence is neither a defect nor a pass — the check simply did
    // not run, which is exactly what `skip` means (SPEC §4.3). Warning here
    // would push every otherwise-clean challenge to a `warn` verdict on the
    // strength of a field the protocol never asked for, which is the
    // crying-wolf failure exists to prevent.
    checks.skip(
      "facilitator_known",
      "not_declared",
      `The challenge names no facilitator, so there was nothing to check against ${input.listLabel}.`,
    );
    return;
  }

  if (input.facilitators.size === 0) {
    checks.skip(
      "facilitator_known",
      "list_unavailable",
      "The published facilitator list was not available, so the facilitator was not checked.",
    );
    return;
  }

  let origin: string;
  try {
    origin = new URL(declared).origin.toLowerCase();
  } catch {
    checks.warn(
      "facilitator_known",
      "facilitator-url-invalid",
      `The declared facilitator "${declared}" is not a URL.`,
    );
    return;
  }

  if (input.facilitators.has(origin)) {
    checks.pass(
      "facilitator_known",
      `${origin} is on ${input.listLabel}. That is the whole claim: the list is published and it is not exhaustive.`,
    );
  } else {
    checks.warn(
      "facilitator_known",
      "not_on_list",
      `${origin} is not on ${input.listLabel}. The list is published and it is not exhaustive, so this means we do not recognize it — nothing more.`,
    );
  }
}

// ── signals ───────────────────────────────────────────────────────────────

/**
 * Reuse its extractor rather than growing a second one.
 *
 * `extractSignals` reads a `ProbeResult`, so a directly supplied challenge is
 * presented as one with no transport observations at all. The three signals
 * that describe a connection are then rewritten as explicitly unobserved,
 * because nothing here connected to anything: reporting `probe_ok: false`
 * would claim we tried and failed, and reporting
 * `redirect_scheme_downgrade: false` would hand the score three points of
 * credit for a hop that never happened. SPEC §6.3 says an unobserved signal
 * contributes nothing, which is precisely the right treatment.
 */
const TRANSPORT_ONLY_SIGNALS: ReadonlySet<string> = new Set([
  "probe_ok",
  "redirect_count",
  "redirect_scheme_downgrade",
  // Already null by construction, but rewritten so the report says *why*
  // rather than falling back to a generic "not observed".
  "tls_ok",
  "tls_protocol",
]);

const NO_CONNECTION =
  "The challenge was supplied directly, so no connection was made and this was not observed.";

function signalsFor(
  challenge: Challenge,
  observedTerms: Requirement[],
  context: VerifyContext | null,
): Signal[] {
  const origin = originOf(context);
  const result: ProbeResult = {
    target: {
      url: context?.url ?? "",
      canonical_url: context?.url ?? "",
      endpoint_id: "",
      origin,
      host: "",
    },
    probe: {
      observed_at: "",
      http_status: null,
      latency_ms: null,
      redirect_count: 0,
      tls: null,
      bytes_read: challenge.raw_bytes,
      served_from_cache: false,
      cache_age_seconds: null,
    },
    challenge,
    observed_terms: observedTerms,
    wire_forms_agree: null,
  };

  return extractSignals(result, { knownFacilitators: facilitatorOrigins() }).map((signal) =>
    TRANSPORT_ONLY_SIGNALS.has(signal.id)
      ? { id: signal.id, value: null, observed: false, detail: NO_CONNECTION }
      : signal,
  );
}

function originOf(context: VerifyContext | null): string {
  const candidate = context?.expected_origin ?? context?.url ?? null;
  if (!candidate) return "";
  try {
    return new URL(candidate).origin;
  } catch {
    return "";
  }
}

// ── invariants, asserted rather than asserted-to ──────────────────────────

/**
 * Every reason `decodePaymentRequired` can throw maps to a frozen check id.
 *
 * If the SDK adds a reason and nothing maps it, a refused challenge could come
 * back as `warn` — a challenge tx402 would not pay, reported as "probably
 * fine". That is the one failure mode of this module that would actually cost
 * someone money, so it is a test rather than a comment.
 */
export const DECODER_REASONS: readonly string[] = Object.freeze(
  Object.keys(DECODER_REASON_TO_CHECK),
);

export function isMappedDecoderReason(reason: string): boolean {
  return reason in DECODER_REASON_TO_CHECK;
}

/** Exported for the CAIP-2 agreement test described at `CAIP2`. */
export function isWellFormedCaip2(network: string): boolean {
  return CAIP2.test(network);
}

/** Exported so a renderer can say which manifest answered. */
export { BUNDLED_MANIFEST, MAX_PAYMENT_REQUIRED_DEPTH, resolveNetwork };
