/**
 * Proof of control, and the D1 access behind `/api/v1/claim*` and
 * `/api/v1/appeal`.
 *
 * ── There are no accounts, and this does not reinvent them ────────────────
 *
 * Watch and accounts were cut in wave 3 and `migrations/0003_drop_accounts.sql`
 * removed every table in which a person could be stored, so a
 * claim here is **proved by control of the domain and by nothing else**. There
 * is no sign-in, no password, no email, no session, and no row anywhere that
 * says who anybody is. `migrations/0004_claims_no_people.sql` drops the two
 * columns that would have let this change quietly re-introduce one.
 *
 * The consequence worth stating, because it is the design and not a gap: **the
 * claim id is the return address.** It is 128 random bits, it is what an
 * operator uses to read their dossier and file an appeal, and if they lose it
 * they get it back the only way this product can offer — by proving control of
 * the domain again, which surfaces every appeal ever filed for that origin.
 *
 * ── Two proofs, and why both ─────────────────────────────────────────────
 *
 *   `dns-txt`      a TXT record at `_x402-tools.<host>` carrying the token.
 *                  Proves control of the DNS zone. Survives a compromised or
 *                  CDN-fronted web tier, and is the one an operator can publish
 *                  without deploying anything.
 *   `well-known`   a file at `/.well-known/x402-tools-claim` carrying the token.
 *                  Proves control of what the origin actually serves — which is
 *                  the thing we probed — and needs no registrar access.
 *
 * `docs/abuse-policy.md` promises both, and `worker/routes/optout.ts`
 * explicitly deferred DNS-TXT verification to "its claim flow, which already
 * builds exactly that machinery". This is that machinery.
 *
 * ── The fetch goes through the guard ─────────────────────────────────────
 *
 * `checkWellKnown` uses `guardedFetch`, not bare `fetch`: an origin an
 * anonymous caller chose is exactly the SSRF surface exists for,
 * and a claim request is no less attacker-controlled than a probe request. The
 * adjacent live opt-out route uses a bare `fetch` for its own well-known check;
 * that is its file and is recorded as an open item rather than edited here.
 */

import { asString, asStringOrNull } from "../crawler/coerce.js";
import {
  guardedFetch,
  validateUrl,
  type Connector,
  type Resolver,
  type UrlPolicy,
} from "../lib/guard.js";

// ── the published contract ────────────────────────────────────────────────

/** Same TXT name the crawler publishes for opt-out, so an operator learns one record. */
export const CLAIM_TXT_NAME = "_x402-tools";
export const CLAIM_WELL_KNOWN = "/.well-known/x402-tools-claim";
export const CLAIM_TOKEN_PREFIX = "x402-tools-claim=";

/**
 * How long a pending claim's token stays verifiable.
 *
 * Long enough for a DNS change to propagate and for somebody to get to it on a
 * Monday; short enough that an abandoned token is not a permanent standing
 * invitation. Expiry is computed from `created_at` rather than stored, so it
 * needs no column and cannot drift from this constant.
 */
export const CLAIM_TOKEN_TTL_HOURS = 72;

export type ClaimMethod = "dns-txt" | "well-known";
export type ClaimState = "pending" | "verified" | "failed" | "revoked";

// ── ids and tokens ────────────────────────────────────────────────────────

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const byte of buf) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

/**
 * 128 bits, not `newId`.
 *
 * `worker/crawler/store.ts`'s ULID-shaped id is 50 bits of randomness behind a
 * timestamp, which is right for an append-only log read in order and wrong for
 * a handle that is the only thing standing between a stranger and an operator's
 * correspondence. This one is unguessable and says nothing about when it was
 * made.
 */
export function newClaimId(): string {
  return randomHex(16);
}

/** The value the operator publishes. Also 128 bits: it is a challenge nonce. */
export function newChallengeToken(): string {
  return `${CLAIM_TOKEN_PREFIX}${randomHex(16)}`;
}

// ── instructions ──────────────────────────────────────────────────────────

export interface ClaimInstructions {
  method: ClaimMethod;
  /** Human sentence, rendered on every surface. */
  summary: string;
  /** DNS: the record name. Well-known: null. */
  record_name: string | null;
  /** DNS: the record value. Well-known: the file contents. */
  publish: string;
  /** Well-known: the URL to serve it at. DNS: null. */
  url: string | null;
}

export function claimInstructions(
  origin: string,
  host: string,
  method: ClaimMethod,
  token: string,
): ClaimInstructions {
  if (method === "dns-txt") {
    return {
      method,
      summary: `Publish a TXT record at ${CLAIM_TXT_NAME}.${host} whose value is the token below, then call the verify route.`,
      record_name: `${CLAIM_TXT_NAME}.${host}`,
      publish: token,
      url: null,
    };
  }
  return {
    method,
    summary: `Serve the token below at ${origin}${CLAIM_WELL_KNOWN}, then call the verify route.`,
    record_name: null,
    publish: token,
    url: `${origin}${CLAIM_WELL_KNOWN}`,
  };
}

// ── DNS TXT ───────────────────────────────────────────────────────────────

/**
 * A port, for the same two reasons `guard.ts` gives for its address resolver:
 * a test must be able to make a name answer anything it likes, and a Worker has
 * no DNS API so production has to go over DNS-over-HTTPS.
 */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[]>;
}

/** DNS-over-HTTPS TXT lookup against 1.1.1.1. */
export function dohTxtResolver(endpoint = "https://cloudflare-dns.com/dns-query"): TxtResolver {
  return {
    async resolveTxt(name: string): Promise<string[]> {
      const response = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) return [];
      const body: { Answer?: { type: number; data: string }[] } = await response.json();
      // Type 16 = TXT. A record longer than 255 bytes arrives as several quoted
      // strings that concatenate; the token is short, but joining is what the
      // wire format means, so join.
      return (body.Answer ?? [])
        .filter((a) => a.type === 16)
        .map((a) => (a.data.match(/"([^"]*)"/gu) ?? [a.data]).map((s) => s.replace(/"/gu, "")).join(""));
    },
  };
}

export interface ProofResult {
  proven: boolean;
  /** What we actually saw, quoted back. The operator is entitled to it either way. */
  evidence: string | null;
  /** Why it did not prove, in the operator's terms. Null when it did. */
  detail: string | null;
}

export async function checkDnsTxt(
  host: string,
  token: string,
  resolver: TxtResolver,
): Promise<ProofResult> {
  const name = `${CLAIM_TXT_NAME}.${host}`;
  return matchToken(token, name, () => resolver.resolveTxt(name));
}

/**
 * Compare the token against whatever the lookup returned.
 *
 * Split out from `checkDnsTxt` so the *observation* can be cached by the
 * politeness layer while the *comparison* stays per-claim. Caching a verdict
 * would be an authentication bug: one claim's "proven" is not another's, even
 * for the same origin.
 */
export async function matchToken(
  token: string,
  name: string,
  lookup: () => Promise<string[]>,
): Promise<ProofResult> {
  let records: string[];
  try {
    records = await lookup();
  } catch {
    // NXDOMAIN and SERVFAIL land here, and so does "published a minute ago".
    // They are indistinguishable from outside, and the operator's next action
    // is the same in all three, so say the useful thing rather than the exact
    // one — an unexplained failure reads as our bug.
    return {
      proven: false,
      evidence: null,
      detail: `No answer for TXT ${name} yet. DNS changes can take a while to propagate.`,
    };
  }

  const seen = records.map((r) => r.trim());
  if (seen.includes(token)) {
    return { proven: true, evidence: token, detail: null };
  }

  return {
    proven: false,
    // Cap what we echo: this is third-party DNS content on a page we render.
    evidence: seen.length > 0 ? seen.slice(0, 5).join(" · ").slice(0, 512) : null,
    detail:
      seen.length === 0
        ? `TXT ${name} has no records yet. DNS changes can take a while to propagate.`
        : `TXT ${name} exists but none of its values is the token for this claim.`,
  };
}

// ── the well-known file ───────────────────────────────────────────────────

export interface WellKnownOptions {
  resolver: Resolver;
  connector?: Connector;
  policy?: UrlPolicy;
}

/** What one read of the well-known file saw. Plain JSON, so it survives the politeness cache. */
export interface WellKnownObservation {
  reached: boolean;
  status: number;
  /** Capped at read time; the file only ever needs to carry a token. */
  body: string;
}

export function wellKnownUrl(origin: string): string {
  return `${origin}${CLAIM_WELL_KNOWN}`;
}

/**
 * Read the file, once. Separated from the comparison for the same reason
 * `matchToken` is: this result is shared between callers by the politeness
 * layer, and a shared *verdict* would be an authentication bug.
 */
export async function fetchWellKnown(
  origin: string,
  options: WellKnownOptions,
): Promise<WellKnownObservation> {
  const result = await guardedFetch(wellKnownUrl(origin), {
    resolver: options.resolver,
    connector: options.connector,
    policy: options.policy,
  });

  if (!result.ok) return { reached: false, status: 0, body: "" };
  return {
    reached: true,
    status: result.value.status,
    body: result.value.body.slice(0, 2048),
  };
}

export function matchWellKnown(
  token: string,
  url: string,
  observation: WellKnownObservation,
): ProofResult {
  if (!observation.reached) {
    return { proven: false, evidence: null, detail: `${url} could not be fetched.` };
  }
  if (observation.status < 200 || observation.status >= 300) {
    return { proven: false, evidence: null, detail: `${url} answered ${observation.status}.` };
  }
  if (observation.body.includes(token)) {
    return { proven: true, evidence: token, detail: null };
  }
  return {
    proven: false,
    evidence: observation.body.trim().slice(0, 512) || "(empty file)",
    detail: `${url} exists but does not contain the token for this claim.`,
  };
}

export async function checkWellKnown(
  origin: string,
  token: string,
  options: WellKnownOptions,
): Promise<ProofResult> {
  return matchWellKnown(token, wellKnownUrl(origin), await fetchWellKnown(origin, options));
}

// ── the claim row ─────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  endpoint_id: string | null;
  origin: string;
  method: ClaimMethod;
  challenge_token: string;
  state: ClaimState;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const CLAIM_COLUMNS =
  "id, endpoint_id, origin, method, challenge_token, state, verified_at, created_at, updated_at";

function toClaim(row: Record<string, unknown>): Claim {
  return {
    id: asString(row.id, ""),
    endpoint_id: asStringOrNull(row.endpoint_id),
    origin: asString(row.origin, ""),
    method: row.method === "dns-txt" ? "dns-txt" : "well-known",
    challenge_token: asString(row.challenge_token, ""),
    state: (row.state as ClaimState) ?? "pending",
    verified_at: asStringOrNull(row.verified_at),
    created_at: asString(row.created_at, ""),
    updated_at: asString(row.updated_at, ""),
  };
}

export async function insertClaim(db: D1Database, claim: Claim): Promise<void> {
  await db
    .prepare(
      `INSERT INTO endpoint_claims
         (id, endpoint_id, origin, method, challenge_token, state, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      claim.id,
      claim.endpoint_id,
      claim.origin,
      claim.method,
      claim.challenge_token,
      claim.state,
      claim.verified_at,
      claim.created_at,
      claim.updated_at,
    )
    .run();
}

export async function claimById(db: D1Database, id: string): Promise<Claim | null> {
  const row = await db
    .prepare(`SELECT ${CLAIM_COLUMNS} FROM endpoint_claims WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;

  const claim = toClaim(row);
  // A row missing either of these is not a claim, whatever the driver handed
  // back. Returning it would push an unparseable origin downstream, where
  // `new URL("")` throws and a lookup for a claim that does not exist becomes a
  // 500 instead of the 404 it is.
  if (claim.id.length === 0 || !originOf(claim.origin)) return null;
  return claim;
}

/** The claim's origin as a URL, or null if the column does not hold one. */
export function originOf(origin: string): URL | null {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

export async function setClaimState(
  db: D1Database,
  id: string,
  state: ClaimState,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE endpoint_claims
          SET state = ?, verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END, updated_at = ?
        WHERE id = ?`,
    )
    .bind(state, state, now, now, id)
    .run();
}

/** A pending token is only good for `CLAIM_TOKEN_TTL_HOURS` after it was issued. */
export function claimExpired(claim: Claim, now: string): boolean {
  const created = Date.parse(claim.created_at);
  const at = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(at)) return false;
  return at - created > CLAIM_TOKEN_TTL_HOURS * 3_600_000;
}

// ── origins ───────────────────────────────────────────────────────────────

export interface ClaimTarget {
  origin: string;
  host: string;
  canonical: string;
}

/**
 * Accept either a full endpoint URL or a bare origin, and reduce both to the
 * origin. A claim is over a **domain**, because that is what the proof proves —
 * claiming one path while somebody else claims another on the same host would
 * be a distinction the evidence cannot support.
 */
export function claimTarget(raw: string): ClaimTarget | null {
  const validated = validateUrl(raw);
  if (!validated.ok) return null;
  const { url, canonical, host } = validated.value;
  return { origin: url.origin, host, canonical };
}
