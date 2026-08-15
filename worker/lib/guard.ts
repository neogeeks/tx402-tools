/**
 * The SSRF firewall.
 *
 * "Paste a URL and we fetch it" is an SSRF engine and a DDoS amplifier pointed
 * at other people's paid APIs. Everything here exists to make that statement
 * false. The guard is the only way anything in this repo reaches the network.
 *
 * Five properties, each of which has been an exploited bug in a real product:
 *
 *  1. **The resolved ADDRESSES are validated, never the hostname.** A name is
 *     attacker-controlled data; only the address it resolves to determines
 *     where the packet goes. `evil.example.com A 127.0.0.1` is not a string
 *     problem.
 *  2. **Every address in the RRset must pass**, not just the one we would have
 *     used. A resolver that returns `[203.0.113.7, 127.0.0.1]` is refused
 *     outright — otherwise the platform's own connect picks the other record
 *     and we validated nothing.
 *  3. **Resolution happens twice** — once to validate, once immediately before
 *     connecting — and the second RRset must agree with the first. That is the
 *     DNS-rebinding defence; see the honest limitation note below.
 *  4. **Every redirect hop is re-validated from scratch**, and never
 *     cross-scheme. Hop 0 being safe says nothing about hop 1.
 *  5. **Refusals are indistinguishable to the caller.** `worker/http.ts` maps
 *     every blocked-URL code to one generic sentence. A guard that explains
 *     precisely why it refused is a network scanner with extra steps, so the
 *     reason stays internal and `detail.stage` is deliberately coarse.
 *
 * ── The pinning limitation, stated plainly ──────────────────────────────────
 *
 * asks for the resolved address to be PINNED for the connection.
 * On Cloudflare Workers that is **not achievable today** and pretending
 * otherwise would be the most dangerous kind of security comment:
 *
 *   - Workers expose no DNS API, so resolution here is DNS-over-HTTPS.
 *   - `fetch` accepts a URL, not an address, and does its own resolution.
 *   - `connect` from `cloudflare:sockets` can dial an IP literal, but TLS
 *     then validates the certificate against that literal, which fails for
 *     every normal certificate. There is no separate-SNI option.
 *
 * So the pin is **enforced where the platform allows it and compensated for
 * where it does not**. `Connector` is a port: the hosted connector uses
 * `fetch` and carries the pin as an assertion it cannot enforce, while a
 * Node connector (its CLI, which also needs `http:` and localhost) can bind
 * the socket to the pinned address and genuinely enforce it. The compensating
 * controls on Workers are properties 2 and 3 above: a rebind has to return a
 * fully-public RRset at validation time AND flip within the window between our
 * second lookup and the platform's, on every hop. That is a real narrowing,
 * not an elimination, and its red-team owns re-testing it.
 *
 * **We built the Node connector.** `packages/tools-cli/src/net/connector.ts`
 * pins by overriding `net.connect`'s `lookup` while leaving `servername` as the
 * hostname, so the socket goes to the validated address and TLS still validates
 * the real certificate. There is no second resolution on that path, so the
 * TOCTOU window above does not exist for the CLI. It still exists here.
 */

import type { ErrorCode } from "../types.js";

// ── limits ────────────────────────────────────────────────────────────────
// Every one of these is a cost bound as much as a safety bound: this service
// fetches arbitrary URLs for free, so an unbounded read is an unbounded bill.

export interface GuardLimits {
  /** SPEC §1.5 / common.json caps a URL at 4096 characters. */
  maxUrlLength: number;
  /** max 3 redirects, never cross-scheme. */
  maxRedirects: number;
  /** Budget for the whole operation, redirects included. */
  totalTimeoutMs: number;
  /** Budget for a single hop, so one slow hop cannot eat the whole total. */
  hopTimeoutMs: number;
  /** Body bytes read before the read is ABORTED — not buffered then measured. */
  maxBodyBytes: number;
  /** Response header count cap. */
  maxHeaderCount: number;
  /** Total response header bytes cap. */
  maxHeaderBytes: number;
}

export const GUARD_LIMITS: GuardLimits = {
  maxUrlLength: 4096,
  maxRedirects: 3,
  totalTimeoutMs: 10_000,
  hopTimeoutMs: 5_000,
  maxBodyBytes: 256 * 1024,
  maxHeaderCount: 100,
  maxHeaderBytes: 32 * 1024,
};

/**
 * Request headers the probe sends. There is no Authorization, no Cookie and no
 * credential of any kind here, and `guardedFetch` builds this list from scratch
 * on every hop rather than copying anything from the caller's request — the
 * only way to be sure nothing is forwarded is to never have it.
 */
export const CRAWLER_USER_AGENT =
  "tx402-tools-crawler/1.0 (+https://tools.tx402.io/crawler)";

// ── failures ──────────────────────────────────────────────────────────────

/**
 * Coarse on purpose (SPEC §3). This is the ONLY thing that reaches the caller
 * beyond the generic message, so it must not distinguish "no such host" from
 * "host is 10.0.0.1" — that difference is exactly what a network scan wants.
 */
export type GuardStage = "url" | "dns" | "redirect" | "response" | "transport";

export interface GuardFailure {
  code: ErrorCode;
  stage: GuardStage;
  /**
   * Never sent to a caller. Logged internally and asserted on in tests, which
   * is why the hostile-URL table can be precise about *why* a row was refused
   * while the API stays uninformative.
   */
  reason: string;
}

export type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GuardFailure };

function fail<T>(code: ErrorCode, stage: GuardStage, reason: string): GuardResult<T> {
  return { ok: false, failure: { code, stage, reason } };
}

// ── address parsing ───────────────────────────────────────────────────────
// Deliberately independent of the URL parser. WHATWG normalizes `0x7f000001`,
// `0177.0.0.1`, `127.1` and `2130706433` to `127.0.0.1` — but that is the
// *host parser's* behaviour, it differs between engines (Node, workerd, Python,
// Go), and the fixture table warns against relying on it. Parsing the encodings
// ourselves means the guard's verdict does not depend on whose URL parser ran.

/** A parsed address, always in a canonical form we can classify. */
export interface ParsedAddress {
  family: 4 | 6;
  /** Canonical text: dotted-quad for v4, colon-hex for v6. */
  text: string;
  /** v4: four octets. v6: eight 16-bit groups. */
  parts: number[];
}

/**
 * Parse one IPv4 part in any base the historical inet_aton grammar allows:
 * `0x` prefix is hex, a leading `0` is octal, anything else is decimal. This is
 * how `0177.0.0.1` and `0x7f000001` reach 127.0.0.1.
 */
function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;

  let radix = 10;
  let digits = part;

  if (/^0[xX]/u.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (digits.length === 0) return null;
  } else if (part.length > 1 && part[0] === "0") {
    radix = 8;
    digits = part.slice(1);
  }

  const pattern =
    radix === 16 ? /^[0-9a-fA-F]+$/u : radix === 8 ? /^[0-7]+$/u : /^[0-9]+$/u;
  if (!pattern.test(digits)) return null;

  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Parse an IPv4 address in 1-, 2-, 3- or 4-part form. The short forms are not
 * obscure trivia: `127.1` is a working loopback address on every BSD-derived
 * stack, and a guard that only understands dotted-quad waves it straight
 * through.
 */
export function parseIpv4(host: string): ParsedAddress | null {
  if (host.length === 0) return null;

  const raw = host.endsWith(".") ? host.slice(0, -1) : host;
  if (raw.length === 0) return null;

  const parts = raw.split(".");
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === null) return null;
    values.push(value);
  }

  // Leading parts are single octets; the final part absorbs the remaining
  // width. `a.b` ⇒ b covers 24 bits, `a.b.c` ⇒ c covers 16.
  const leading = values.slice(0, -1);
  const last = values[values.length - 1];
  if (last === undefined) return null;
  if (leading.some((v) => v > 0xff)) return null;

  const remainingBytes = 4 - leading.length;
  const maxLast = remainingBytes === 4 ? 0xffffffff : 2 ** (8 * remainingBytes) - 1;
  if (last > maxLast) return null;

  let value = 0;
  for (const octet of leading) value = value * 256 + octet;
  value = value * 2 ** (8 * remainingBytes) + last;
  if (value > 0xffffffff) return null;

  const octets = [
    Math.floor(value / 2 ** 24) & 0xff,
    Math.floor(value / 2 ** 16) & 0xff,
    Math.floor(value / 2 ** 8) & 0xff,
    value & 0xff,
  ];
  return { family: 4, text: octets.join("."), parts: octets };
}

/** Parse an IPv6 literal, with `::` compression and a trailing embedded IPv4. */
export function parseIpv6(host: string): ParsedAddress | null {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // A zone id (`fe80::1%eth0`) never survives to a real connection here, and
  // keeping it would only complicate classification.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !text.includes(":")) return null;

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const groups: number[] = [];

  const pushGroups = (chunk: string, into: number[]): boolean => {
    if (chunk.length === 0) return true;
    for (const piece of chunk.split(":")) {
      if (piece.length === 0) return false;
      if (piece.includes(".")) {
        // Embedded IPv4 — only legal as the final 32 bits.
        const v4 = parseIpv4(piece);
        if (!v4 || piece.split(".").length !== 4) return false;
        into.push((v4.parts[0]! << 8) | v4.parts[1]!, (v4.parts[2]! << 8) | v4.parts[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/u.test(piece)) return false;
      into.push(Number.parseInt(piece, 16));
    }
    return true;
  };

  if (doubleColon === -1) {
    if (!pushGroups(text, groups)) return null;
    if (groups.length !== 8) return null;
  } else {
    const head: number[] = [];
    const tail: number[] = [];
    if (!pushGroups(text.slice(0, doubleColon), head)) return null;
    if (!pushGroups(text.slice(doubleColon + 2), tail)) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups.push(...head, ...new Array<number>(fill).fill(0), ...tail);
  }

  if (groups.length !== 8 || groups.some((g) => g < 0 || g > 0xffff)) return null;

  return {
    family: 6,
    text: groups.map((g) => g.toString(16)).join(":"),
    parts: groups,
  };
}

/** Parse a host as an IP literal in any form. Returns null for real hostnames. */
export function parseAddress(host: string): ParsedAddress | null {
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[") || trimmed.includes(":")) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

// ── address classification ────────────────────────────────────────────────

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "cgnat"
  | "link_local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "documentation";

function inV4(parts: number[], prefix: number[], bits: number): boolean {
  const value = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
  const net = (prefix[0]! << 24) | (prefix[1]! << 16) | (prefix[2]! << 8) | prefix[3]!;
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1);
  return (value & mask) === (net & mask);
}

/** Classify an IPv4 address. Everything not explicitly special is `public`. */
export function classifyIpv4(parts: number[]): AddressClass {
  // 169.254.169.254 first: it is the single most-exploited SSRF target there
  // is, and naming it separately makes the intent legible in a log.
  if (parts[0] === 169 && parts[1] === 254 && parts[2] === 169 && parts[3] === 254) {
    return "metadata";
  }
  if (inV4(parts, [0, 0, 0, 0], 8)) return "unspecified";
  if (inV4(parts, [127, 0, 0, 0], 8)) return "loopback";
  if (inV4(parts, [10, 0, 0, 0], 8)) return "private";
  if (inV4(parts, [172, 16, 0, 0], 12)) return "private";
  if (inV4(parts, [192, 168, 0, 0], 16)) return "private";
  if (inV4(parts, [100, 64, 0, 0], 10)) return "cgnat";
  if (inV4(parts, [169, 254, 0, 0], 16)) return "link_local";
  if (inV4(parts, [192, 0, 0, 0], 24)) return "reserved";
  if (inV4(parts, [198, 18, 0, 0], 15)) return "reserved";
  if (inV4(parts, [192, 0, 2, 0], 24)) return "documentation";
  if (inV4(parts, [198, 51, 100, 0], 24)) return "documentation";
  if (inV4(parts, [203, 0, 113, 0], 24)) return "documentation";
  if (inV4(parts, [224, 0, 0, 0], 4)) return "multicast";
  // 240.0.0.0/4 reserved, and 255.255.255.255 broadcast lives inside it.
  if (inV4(parts, [240, 0, 0, 0], 4)) return "reserved";
  return "public";
}

/**
 * Classify an IPv6 address, unwrapping every embedding of an IPv4 address
 * first. `::ffff:127.0.0.1`, `64:ff9b::7f00:1` and `2002:7f00:0001::` all reach
 * loopback while looking nothing like `127.0.0.1`; classifying the v6 form
 * alone is precisely how that check gets missed.
 */
export function classifyIpv6(parts: number[]): AddressClass {
  const isZero = (from: number, to: number): boolean =>
    parts.slice(from, to).every((g) => g === 0);

  const embeddedV4 = (hi: number, lo: number): AddressClass =>
    classifyIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);

  //::/128 unspecified,::1/128 loopback
  if (isZero(0, 7)) {
    if (parts[7] === 0) return "unspecified";
    if (parts[7] === 1) return "loopback";
  }
  //::ffff:0:0/96 — IPv4-mapped
  if (isZero(0, 5) && parts[5] === 0xffff) return embeddedV4(parts[6]!, parts[7]!);
  //::/96 — deprecated IPv4-compatible
  if (isZero(0, 6) && !(parts[6] === 0 && parts[7] === 0)) {
    return embeddedV4(parts[6]!, parts[7]!);
  }
  // 64:ff9b::/96 — the well-known NAT64 prefix
  if (parts[0] === 0x64 && parts[1] === 0xff9b && isZero(2, 6)) {
    return embeddedV4(parts[6]!, parts[7]!);
  }
  // 64:ff9b:1::/48 — local-use NAT64
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1) return "reserved";
  // 2002::/16 — 6to4, embedding a v4 address in the next 32 bits
  if (parts[0] === 0x2002) return embeddedV4(parts[1]!, parts[2]!);
  // 100::/64 — discard-only
  if (parts[0] === 0x100 && isZero(1, 4)) return "reserved";
  // 2001:db8::/32 — documentation
  if (parts[0] === 0x2001 && parts[1] === 0xdb8) return "documentation";
  // fc00::/7 — unique local
  if ((parts[0]! & 0xfe00) === 0xfc00) return "private";
  // fe80::/10 — link-local
  if ((parts[0]! & 0xffc0) === 0xfe80) return "link_local";
  // ff00::/8 — multicast
  if ((parts[0]! & 0xff00) === 0xff00) return "multicast";

  return "public";
}

export function classifyAddress(address: ParsedAddress): AddressClass {
  return address.family === 4 ? classifyIpv4(address.parts) : classifyIpv6(address.parts);
}

/** The one question the guard actually asks of an address. */
export function isPublicAddress(address: ParsedAddress): boolean {
  return classifyAddress(address) === "public";
}

// ── URL validation and canonicalization (SPEC §1.5) ───────────────────────

export interface ValidatedUrl {
  /** The URL as parsed, with userinfo already refused rather than stripped. */
  url: URL;
  /** SPEC §1.5 canonical form — the join key for D1 and every cache key. */
  canonical: string;
  host: string;
  /** Set when the host is an IP literal, so we can skip DNS and classify now. */
  literal: ParsedAddress | null;
}

export interface UrlPolicy {
  /**
   * `["https:"]` for the hosted probe. The CLI passes `http:` too, which is the whole reason it can
   * reach localhost and the hosted service cannot. It is a parameter rather than a constant so that
   * difference lives in one place and is visible in a diff.
   */
  allowedSchemes: string[];
  /**
   * Permit addresses in private/loopback/link-local/CGNAT space.
   *
   * **Always false for anything hosted, and `HOSTED_URL_POLICY` does not set
   * it** — on a service anyone can paste a URL into, this flag is the SSRF bug
   * itself. It exists because the local CLI is a different threat model:
   * the URL comes from the operator's own shell on the operator's own machine,
   * where they could already `curl` it, and "debug my 402 endpoint on
   * localhost:3000" is the reason says a CLI is not redundant with
   * the hosted Inspector.
   *
   * Added rather than because `allowedSchemes` alone does not reach
   * localhost: `validateUrl` refuses a private literal and `resolveAndValidate`
   * refuses a private RRset, and neither was a port. Additive, defaulting to
   * today's behaviour.
   */
  allowPrivateAddresses?: boolean;
  limits?: Partial<GuardLimits>;
}

export const HOSTED_URL_POLICY: UrlPolicy = { allowedSchemes: ["https:"] };

/**
 * SPEC §1.5, in the stated order. Canonicalization sorts the query and strips
 * the trailing dot; it does NOT normalize away anything the guard refuses. A
 * canonicalizer that quietly fixes a hostile URL hands the caller a bypass.
 */
export function canonicalizeUrl(url: URL): string {
  const scheme = url.protocol.toLowerCase();

  let host = url.hostname.toLowerCase();
  if (host.endsWith(".") && !host.endsWith("..")) host = host.slice(0, -1);

  const defaultPort = scheme === "https:" ? "443" : scheme === "http:" ? "80" : "";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";

  const path = url.pathname.length === 0 ? "/" : url.pathname;

  const params = [...new URLSearchParams(url.search).entries()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  const query =
    params.length === 0
      ? ""
      : `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;

  return `${scheme}//${host}${port}${path}${query}`;
}

/** SPEC §1.5: first 32 hex chars of SHA-256 over the canonical URL. */
export async function endpointId(canonicalUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalUrl),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Everything that can be decided about a URL without touching the network.
 * Ordered so that the cheapest and least informative refusals happen first.
 */
export function validateUrl(
  raw: string,
  policy: UrlPolicy = HOSTED_URL_POLICY,
): GuardResult<ValidatedUrl> {
  const limits = { ...GUARD_LIMITS, ...policy.limits };

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail("VALIDATION_FAILED", "url", "empty");
  }
  if (raw.length > limits.maxUrlLength) {
    return fail("VALIDATION_FAILED", "url", "url-too-long");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("VALIDATION_FAILED", "url", "unparseable");
  }

  // Before the scheme check: `https://api.example.com@127.0.0.1/` is refused as
  // credentials, which is the correct reading — everything before the `@` is
  // userinfo and the real host is the loopback address behind it.
  if (url.username.length > 0 || url.password.length > 0) {
    return fail("URL_USERINFO_PRESENT", "url", "userinfo-present");
  }

  if (!policy.allowedSchemes.includes(url.protocol.toLowerCase())) {
    return fail("URL_SCHEME_NOT_ALLOWED", "url", `scheme-${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    return fail("VALIDATION_FAILED", "url", "empty-host");
  }

  // An IP literal needs no resolver: it already says where it goes.
  const literal = parseAddress(host);
  if (literal && !isPublicAddress(literal) && policy.allowPrivateAddresses !== true) {
    return fail(
      "URL_PRIVATE_ADDRESS",
      "url",
      `literal-${classifyAddress(literal)}-${literal.text}`,
    );
  }

  return {
    ok: true,
    value: { url, canonical: canonicalizeUrl(url), host, literal },
  };
}

// ── resolution ────────────────────────────────────────────────────────────

/**
 * A port, for two reasons. Tests must be able to make a name resolve to
 * anything they like — including a different answer on the second lookup, which
 * is the only way to test the rebinding defence at all — and the CLI resolves
 * with `node:dns` while the Worker has to use DNS-over-HTTPS.
 */
export interface Resolver {
  resolve(hostname: string): Promise<string[]>;
}

/**
 * DNS-over-HTTPS against 1.1.1.1. Workers have no DNS API, so this is the only
 * way to see addresses before the platform connects to them.
 */
export function dohResolver(endpoint = "https://cloudflare-dns.com/dns-query"): Resolver {
  return {
    async resolve(hostname: string): Promise<string[]> {
      const query = async (type: "A" | "AAAA"): Promise<string[]> => {
        const response = await fetch(
          `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`,
          { headers: { accept: "application/dns-json" } },
        );
        if (!response.ok) return [];
        const body: { Answer?: { type: number; data: string }[] } =
          await response.json();
        // Type 1 = A, 28 = AAAA. CNAME rows in the chain are ignored; only the
        // terminal address records determine where the packet goes.
        return (body.Answer ?? [])
          .filter((a) => a.type === (type === "A" ? 1 : 28))
          .map((a) => a.data);
      };

      const [v4, v6] = await Promise.all([query("A"), query("AAAA")]);
      return [...v4, ...v6];
    },
  };
}

export interface ResolvedHost {
  hostname: string;
  /** Every address the resolver returned, all of them validated as public. */
  addresses: ParsedAddress[];
}

/**
 * Resolve and validate. **Every** address in the RRset must be public: if the
 * resolver hands back a public address and a private one, we refuse rather than
 * picking the good one, because we do not control which one the platform's own
 * connect will use.
 */
export async function resolveAndValidate(
  hostname: string,
  resolver: Resolver,
  /**
   * its carve-out, threaded from `UrlPolicy.allowPrivateAddresses`. Optional
   * and defaulting to false, so every existing caller keeps refusing private
   * space without knowing this parameter exists.
   */
  allowPrivateAddresses = false,
): Promise<GuardResult<ResolvedHost>> {
  let records: string[];
  try {
    records = await resolver.resolve(hostname);
  } catch {
    return fail("PROBE_FAILED", "dns", "resolver-error");
  }

  if (records.length === 0) {
    return fail("PROBE_FAILED", "dns", "no-address-records");
  }

  const addresses: ParsedAddress[] = [];
  for (const record of records) {
    const parsed = parseAddress(record);
    if (!parsed) {
      return fail("URL_BLOCKED", "dns", `unparseable-record-${record}`);
    }
    if (!isPublicAddress(parsed) && !allowPrivateAddresses) {
      return fail(
        "URL_PRIVATE_ADDRESS",
        "dns",
        `resolved-${classifyAddress(parsed)}-${parsed.text}`,
      );
    }
    addresses.push(parsed);
  }

  return { ok: true, value: { hostname, addresses } };
}

// ── the connector port ────────────────────────────────────────────────────

export interface PinnedTarget {
  hostname: string;
  port: number;
  /** The validated address the guard intends this hop to reach. */
  address: ParsedAddress;
}

export interface Connector {
  /**
   * Perform ONE hop. Redirects must not be followed by the connector — the
   * guard follows them itself so that every hop is re-validated.
   */
  fetch(
    url: URL,
    init: { headers: Record<string, string>; signal: AbortSignal },
    pin: PinnedTarget,
  ): Promise<Response>;
}

/**
 * The hosted connector. `pin` is accepted and deliberately unused: see the
 * limitation note at the top of this file. It is in the signature so the CLI's
 * connector, which CAN honour it, implements the same interface — and so that
 * this comment sits at the exact place someone would look for the enforcement.
 */
export const workerConnector: Connector = {
  fetch(url, init, _pin) {
    return fetch(url.toString(), {
      method: "GET",
      headers: init.headers,
      redirect: "manual",
      signal: init.signal,
    });
  },
};

// ── the guarded fetch ─────────────────────────────────────────────────────

export interface GuardedResponse {
  /** The final URL actually fetched, after any redirects. */
  finalUrl: URL;
  canonicalUrl: string;
  status: number;
  headers: Headers;
  /** Decoded body, truncated at the cap. */
  body: string;
  bytesRead: number;
  /** True when the endpoint's body hit the cap and the read was aborted. */
  truncated: boolean;
  redirectCount: number;
  latencyMs: number;
  addresses: ParsedAddress[];
}

export interface GuardOptions {
  policy?: UrlPolicy;
  resolver: Resolver;
  connector?: Connector;
  limits?: Partial<GuardLimits>;
  /** Injected so tests are deterministic and do not sleep. */
  now?: () => number;
}

/**
 * Read at most `maxBytes`, aborting the stream rather than buffering the whole
 * body and measuring afterwards. The fixture table says this explicitly: an
 * oversized body must never be fully read, because "read it all, then complain"
 * is the amplification bug rather than a fix for it.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", bytes: 0, truncated: false };

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    // Releases the connection immediately instead of draining the rest.
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder("utf-8").decode(joined),
    bytes,
    truncated,
  };
}

function checkResponseHeaders(
  headers: Headers,
  limits: GuardLimits,
): GuardFailure | null {
  let count = 0;
  let size = 0;
  for (const [key, value] of headers) {
    count += 1;
    size += key.length + value.length + 4;
    if (count > limits.maxHeaderCount) {
      return { code: "RESPONSE_TOO_LARGE", stage: "response", reason: "header-count" };
    }
    if (size > limits.maxHeaderBytes) {
      return { code: "RESPONSE_TOO_LARGE", stage: "response", reason: "header-bytes" };
    }
  }
  return null;
}

/**
 * Fetch a URL with every property at the top of this file enforced.
 *
 * The probe (`probe.ts`) never calls `fetch` itself; it calls this. That is the
 * whole point of having one function here rather than a set of helpers a caller
 * has to remember to use in the right order.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardOptions,
): Promise<GuardResult<GuardedResponse>> {
  const policy = options.policy ?? HOSTED_URL_POLICY;
  const limits = { ...GUARD_LIMITS, ...policy.limits, ...options.limits };
  const connector = options.connector ?? workerConnector;
  const now = options.now ?? (() => Date.now());

  const validated = validateUrl(rawUrl, policy);
  if (!validated.ok) return validated;

  const startedAt = now();
  let current = validated.value;
  let redirectCount = 0;
  let addresses: ParsedAddress[] = [];

  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= limits.totalTimeoutMs) {
      return fail("PROBE_TIMEOUT", "transport", "total-budget-exhausted");
    }

    // ── resolve and validate this hop ──
    // For a literal host there is nothing to resolve and nothing to rebind:
    // `validateUrl` already classified it.
    let hopAddresses: ParsedAddress[];
    if (current.literal) {
      hopAddresses = [current.literal];
    } else {
      const allowPrivate = policy.allowPrivateAddresses === true;
      const first = await resolveAndValidate(current.host, options.resolver, allowPrivate);
      if (!first.ok) return first;

      // The rebinding defence. Resolving a second time immediately before the
      // connect turns a one-shot flip into one the attacker must win against
      // every lookup — and the fixture's rebind row, whose resolver answers
      // public-then-loopback, is caught right here on the second answer.
      const second = await resolveAndValidate(current.host, options.resolver, allowPrivate);
      if (!second.ok) return second;

      const firstSet = new Set(first.value.addresses.map((a) => a.text));
      const agreed = second.value.addresses.filter((a) => firstSet.has(a.text));
      if (agreed.length === 0) {
        return fail("URL_BLOCKED", "dns", "rrset-unstable-between-lookups");
      }
      hopAddresses = agreed;
    }
    addresses = hopAddresses;

    const pin: PinnedTarget = {
      hostname: current.host,
      port: Number(current.url.port) || (current.url.protocol === "https:" ? 443 : 80),
      address: hopAddresses[0]!,
    };

    // ── the request ──
    // Built from scratch every hop. Nothing from the caller's request is copied
    // in, so there is no Authorization, Cookie or credential to forward even by
    // accident.
    const controller = new AbortController();
    const hopBudget = Math.min(
      limits.hopTimeoutMs,
      limits.totalTimeoutMs - (now() - startedAt),
    );
    const timer = setTimeout(() => controller.abort(), hopBudget);

    let response: Response;
    try {
      response = await connector.fetch(
        current.url,
        {
          headers: {
            accept: "application/json, text/plain;q=0.9, */*;q=0.5",
            "user-agent": CRAWLER_USER_AGENT,
            "accept-encoding": "identity",
          },
          signal: controller.signal,
        },
        pin,
      );
    } catch (error) {
      clearTimeout(timer);
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && /abort|timeout/iu.test(error.name + error.message));
      return aborted
        ? fail("PROBE_TIMEOUT", "transport", "hop-timeout")
        : fail("PROBE_FAILED", "transport", "connect-failed");
    }
    // NOTE: the timer is deliberately still running. It has to cover the body
    // read as well as the connect, or a response that trickles bytes forever
    // sails past a connect-only timeout — which is the `slow-response` row in
    // the hostile table, and the reason asks for a TOTAL budget.

    const headerFailure = checkResponseHeaders(response.headers, limits);
    if (headerFailure) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, failure: headerFailure };
    }

    // ── redirects ──
    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && location;

    if (isRedirect) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);

      if (redirectCount >= limits.maxRedirects) {
        return fail("TOO_MANY_REDIRECTS", "redirect", "hop-limit");
      }

      let next: URL;
      try {
        next = new URL(location, current.url);
      } catch {
        return fail("URL_BLOCKED", "redirect", "unparseable-location");
      }

      // Where the hop GOES is decided before how it travels. A redirect to
      // `http://10.0.0.5/` is both a downgrade and a jump into private space,
      // and the private address is the more specific and more serious of the
      // two — reporting it as a mere scheme problem would understate it, and
      // the hostile table pins the code for exactly this row.
      const nextLiteral = parseAddress(next.hostname.toLowerCase());
      if (
        nextLiteral &&
        !isPublicAddress(nextLiteral) &&
        policy.allowPrivateAddresses !== true
      ) {
        return fail(
          "URL_PRIVATE_ADDRESS",
          "redirect",
          `hop-literal-${classifyAddress(nextLiteral)}-${nextLiteral.text}`,
        );
      }

      // Never cross-scheme, even to a public address. An https→http hop is a
      // downgrade to a channel we cannot make any statement about.
      if (next.protocol.toLowerCase() !== current.url.protocol.toLowerCase()) {
        return fail("URL_BLOCKED", "redirect", "scheme-change");
      }

      // Re-validated from scratch: userinfo, scheme, literal address, and then
      // resolution at the top of the next iteration.
      const nextValidated = validateUrl(next.toString(), policy);
      if (!nextValidated.ok) {
        return {
          ok: false,
          failure: { ...nextValidated.failure, stage: "redirect" },
        };
      }

      current = nextValidated.value;
      redirectCount += 1;
      continue;
    }

    // ── terminal response ──
    let read: { text: string; bytes: number; truncated: boolean };
    try {
      read = await readCapped(response, limits.maxBodyBytes);
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && /abort|timeout/iu.test(error.name + error.message));
      return aborted
        ? fail("PROBE_TIMEOUT", "transport", "body-read-timeout")
        : fail("PROBE_FAILED", "response", "body-read-failed");
    } finally {
      clearTimeout(timer);
    }

    if (read.truncated) {
      return fail("RESPONSE_TOO_LARGE", "response", "body-cap");
    }

    return {
      ok: true,
      value: {
        finalUrl: current.url,
        canonicalUrl: current.canonical,
        status: response.status,
        headers: response.headers,
        body: read.text,
        bytesRead: read.bytes,
        truncated: read.truncated,
        redirectCount,
        latencyMs: Math.max(0, now() - startedAt),
        addresses,
      },
    };
  }
}
