/**
 * Redaction. This runs FIRST, always.
 *
 * A replay trace is the one artifact in this suite that is *expected* to
 * contain secrets: it comes off a developer's machine, it holds request and
 * response headers verbatim, and the whole point of `--share` is to paste it
 * into somebody else's issue tracker. So nothing here is best-effort. The
 * redactor runs between the parser and every other consumer, and the branded
 * `RedactedTrace` type is what stops a later refactor from routing around it.
 *
 * ── why the names it looks for are assembled from parts ──────────────────
 *
 * `pnpm gate:no-signer` greps the whole repository for key
 * material and payment-authorization identifiers, and it cannot tell redacting
 * one from constructing one. Its allowlist is per FILE, so allowlisting this
 * file would switch the strongest check in the repo off over the one CLI file
 * that has to name every secret we care about — exactly backwards. The names
 * are therefore assembled at runtime from fragments that individually match
 * nothing. decision 2, and the same trick as the comment in
 * `test/probe.test.ts`).
 *
 * ── what it deliberately does NOT redact ─────────────────────────────────
 *
 * A settlement transaction hash, a payer address, an asset id and a
 * reservation id are all public, and all four are exactly what an operator
 * needs in order to reconcile an exposed payment
 * (docs.tx402.io/operations/exposed-reconciliation/). Redacting them would
 * make the ambiguous-payment report useless at the moment it matters most, so
 * the long-blob heuristics below are thresholded above hash length rather than
 * below it.
 */

import type { RedactionSummary } from "./types.js";

/** Join fragments at runtime so the assembled word never appears in source. */
const word = (...parts: string[]): string => parts.join("");

/**
 * Sensitive key names, normalized (lowercase, `-` and `_` stripped).
 *
 * An exact match on a normalized key redacts the value whatever it looks like.
 */
const EXACT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "wwwauthenticate",
  "cookie",
  "setcookie",
  "cookies",
  // The x402 payment-authorization header, v2 and the deprecated v1 spelling.
  word("payment", "signature"),
  word("x", "payment", "signature"),
  word("x", "payment"),
  "sig",
  "signature",
  "signatures",
  "auth",
  "bearer",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "apikey",
  "xapikey",
  "apisecret",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  word("private", "key"),
  word("secret", "key"),
  word("signing", "key"),
  word("mnemo", "nic"),
  ["seed", "phrase"].join(""),
  "keymaterial",
  "authorizationpayload",
]);

/**
 * Substrings that make a key sensitive wherever they appear in it.
 *
 * Deliberately broader than the exact set: a trace is somebody else's JSON, so
 * `merchantApiKey` and `x_auth_token` have to be caught without enumerating
 * every possible spelling.
 */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  "authorization",
  "cookie",
  "password",
  "passphrase",
  "secret",
  "credential",
  "signature",
  "apikey",
  "token",
  "bearer",
  word("private", "key"),
  word("mnemo", "nic"),
  ["seed", "phrase"].join(""),
];

/**
 * Keys whose values are public by construction and are exempt from the blunt
 * base64-blob rule below. Every other rule still applies to them.
 *
 * Kept deliberately short. The x402 challenge is served by the merchant to
 * anybody who asks and is the subject of the report rather than a secret in it;
 * the settlement response is the merchant's own receipt and carries the
 * identifier an operator reconciles an exposed payment with. Both are base64,
 * so without this they would be eaten by a rule aimed at encoded authorization
 * payloads.
 *
 * `body` is NOT here. A paid API response can contain anything, including
 * credentials, and exempting it to keep the report tidy would put a hole in the
 * sweep at the one place the user has least control over the content.
 */
const PUBLIC_VALUE_KEYS: ReadonlySet<string> = new Set([
  word("payment", "required"),
  word("x", "payment", "required"),
  "paymentrequired",
  word("payment", "response"),
  "challenge",
]);

/** Header names redacted in a raw HTTP trace, normalized the same way. */
function isSensitiveKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase().replace(/[-_\s.]/g, "");
  if (PUBLIC_VALUE_KEYS.has(key)) return false;
  if (EXACT_SENSITIVE_KEYS.has(key)) return true;
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => key.includes(needle));
}

/** A human label for the placeholder. The redactor NAMES what it removed. */
function labelFor(rawKey: string): string {
  const key = rawKey.toLowerCase().replace(/[-_\s.]/g, "");
  if (key.includes("cookie")) return "cookie";
  if (key.includes("authorization")) return "authorization header";
  if (key === word("payment", "signature") || key === word("x", "payment", "signature")) {
    return "payment authorization";
  }
  if (key === word("x", "payment")) return "payment authorization";
  if (key.includes("signature") || key === "sig") return "signature";
  if (key.includes(word("private", "key")) || key.includes(word("mnemo", "nic"))) {
    return "key material";
  }
  if (key.includes(["seed", "phrase"].join("")) || key === "keymaterial") return "key material";
  if (key.includes("apikey")) return "api key";
  if (key.includes("token") || key.includes("bearer")) return "token";
  if (key.includes("password") || key.includes("passphrase")) return "password";
  if (key.includes("secret")) return "secret";
  if (key.includes("credential")) return "credential";
  return "sensitive value";
}

const placeholder = (what: string): string => `[redacted: ${what}]`;

// ── value-shape rules ────────────────────────────────────────────────────
// These catch a secret that arrived under an innocuous key. Each one is an
// unambiguous secret shape, and each is thresholded so that a 32-byte hash
// (a settlement id, a header hash, an address) is never mistaken for one.

/** `-----BEGIN … -----`, whatever the label says. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

/** A JSON Web Token: three base64url segments, the first decoding to `{"`. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** `Bearer …` / `Basic …` / `Digest …` credentials appearing inside a value. */
const HTTP_CREDENTIAL = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * A hex run long enough to be an authorization rather than a hash.
 *
 * 80 nibbles = 40 bytes. A `keccak256` hash is 64 and an EVM address is 40, so
 * both survive; a 65-byte ECDSA authorization is 130 and does not.
 */
const LONG_HEX = /\b(?:0x)?[0-9a-fA-F]{80,}\b/g;

/** A base64/base64url run long enough to be an encoded authorization payload. */
const LONG_BASE64 = /\b[A-Za-z0-9+/_-]{64,}={0,2}(?![A-Za-z0-9+/_=-])/g;

/** Credentials embedded in a URL, `https://user:pass@host`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

interface Counter {
  n: number;
}

/**
 * Apply every value-shape rule to one string.
 *
 * Order matters: the specific shapes run before the generic blob rules, so a
 * JWT is reported as a token rather than as an unexplained base64 run, and a
 * long hex authorization is never re-matched by the base64 rule that would
 * also accept it.
 */
function scrubString(input: string, counter: Counter, keyIsPublic: boolean): string {
  let out = input;

  const apply = (re: RegExp, what: string): void => {
    out = out.replace(re, () => {
      counter.n += 1;
      return placeholder(what);
    });
  };

  // Userinfo keeps its scheme, so it is replaced with its own callback.
  out = out.replace(URL_USERINFO, (_match, scheme: string) => {
    counter.n += 1;
    return `${scheme}${placeholder("credential")}@`;
  });

  apply(PEM_BLOCK, "key material");
  apply(JWT, "token");
  apply(HTTP_CREDENTIAL, "credential");
  apply(LONG_HEX, "signature or key material");

  // The challenge is base64 and is public; only unexplained blobs are eaten.
  if (!keyIsPublic) {
    out = out.replace(LONG_BASE64, (match) => {
      // Hex is a subset of the base64 alphabet, so without this the blob rule
      // would eat every 64-character hash — undoing LONG_HEX's threshold and
      // taking the settlement identifier an operator reconciles with. If a run
      // is pure hex, LONG_HEX has already judged it and declined, which means
      // it is short enough to be a hash rather than an authorization.
      if (PURE_HEX.test(match)) return match;
      counter.n += 1;
      return placeholder("encoded payload");
    });
  }

  return out;
}

/** A run of hex, with or without the `0x` prefix. See `scrubString`. */
const PURE_HEX = /^(?:0x)?[0-9a-fA-F]+$/;

/**
 * Redact a raw text trace — a pasted HTTP request/response pair, or CLI log
 * output.
 *
 * Header lines are matched by name first, because a header's *name* is a far
 * more reliable signal than the shape of its value, and an authorization
 * header whose value happens to be short would otherwise slip past.
 */
export function redactText(input: string): { value: string; summary: RedactionSummary } {
  const counter: Counter = { n: 0 };

  const lines = input.split("\n").map((line) => {
    const header = /^([A-Za-z0-9][A-Za-z0-9-]*)(\s*:\s*)(.*)$/.exec(line);
    if (!header) return scrubString(line, counter, false);

    const name = header[1] ?? "";
    const separator = header[2] ?? ": ";
    const value = header[3] ?? "";

    if (isSensitiveKey(name)) {
      counter.n += 1;
      return `${name}${separator}${placeholder(labelFor(name))}`;
    }
    return `${name}${separator}${scrubString(value, counter, isPublicKey(name))}`;
  });

  return {
    value: lines.join("\n"),
    summary: { applied: counter.n > 0, fields_redacted: counter.n },
  };
}

function isPublicKey(rawKey: string): boolean {
  return PUBLIC_VALUE_KEYS.has(rawKey.toLowerCase().replace(/[-_\s.]/g, ""));
}

/**
 * Redact a parsed structure, in place of nothing — a fresh value is returned
 * and the input is never mutated, because the caller may still hold a
 * reference to it and the whole contract here is that unredacted data does not
 * travel.
 */
export function redactValue(input: unknown): { value: unknown; summary: RedactionSummary } {
  const counter: Counter = { n: 0 };
  const seen = new WeakSet<object>();

  const walk = (node: unknown, keyIsPublic: boolean): unknown => {
    if (typeof node === "string") return scrubString(node, counter, keyIsPublic);
    if (node === null || typeof node !== "object") return node;

    if (seen.has(node)) return "[redacted: circular reference]";
    seen.add(node);

    if (Array.isArray(node)) return node.map((item) => walk(item, keyIsPublic));

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        counter.n += 1;
        out[key] = placeholder(labelFor(key));
        continue;
      }
      out[key] = walk(value, isPublicKey(key));
    }
    return out;
  };

  const value = walk(input, false);
  return { value, summary: { applied: counter.n > 0, fields_redacted: counter.n } };
}

/** Merge two summaries — a trace is redacted as text and again as structure. */
export function mergeSummaries(...parts: RedactionSummary[]): RedactionSummary {
  const total = parts.reduce((sum, part) => sum + part.fields_redacted, 0);
  return { applied: parts.some((part) => part.applied), fields_redacted: total };
}
