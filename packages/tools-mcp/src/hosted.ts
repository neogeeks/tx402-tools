/**
 * The client for `tools.tx402.io`, and the classification that decides what an
 * answer *is*.
 *
 * ── Three error codes are answers, not failures ────────────────────────────
 *
 * SPEC §3.1 gives `CHALLENGE_MALFORMED`, `NOT_X402` and `NO_DATA` **HTTP 200**,
 * with the reasoning written out in the same section: "an endpoint being broken
 * is the answer the user came for, not a failure of our service". Surfacing
 * those three to a model as a transport failure would be exactly backwards.
 * They are findings, and a findings-shaped result is what lets an agent decide
 * not to pay. So they come back with `isError: false` and a report, while a
 * refusal, an outage or an unvalidatable body come back as errors.
 *
 * ── An unreachable service degrades to "could not ask" ─────────────────────
 *
 * There is exactly one thing this module must never do, and it is invent a verdict. A DNS failure,
 * a timeout, a 500, a body that is not JSON and a body that does not match the frozen schema all
 * land in a state that says we did not get an answer — never in a state that says the endpoint
 * looked fine.. set that precedent for the crawler and for History; it is load-bearing here, where
 * the reader is about to spend money.
 *
 * ── No credentials, because there are none ─────────────────────────────────
 *
 * Watch and accounts were cut in wave 3. There is no API
 * key, no login and no token anywhere in this product; the hosted API is public
 * and rate-limited per target, not per caller. This client therefore sends no
 * `Authorization` header, reads no credential from the environment and has no
 * config file to hold one.
 */

import { validateAgainst } from "./schemas.js";
import type { Envelope, ErrorEnvelope, ApiError } from "./types.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://tools.tx402.io";

/** Overridable so a session can develop against `wrangler dev`. */
export const BASE_URL_ENV_VAR = "TX402_TOOLS_API";

/** SPEC §3.1's three rows marked "not an HTTP error". */
export const FINDING_CODES: readonly string[] = Object.freeze([
  "CHALLENGE_MALFORMED",
  "NOT_X402",
  "NO_DATA",
]);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedClientOptions {
  baseUrl?: string;
  /** The network seam. Tests pass a stub; nothing else ever sets it. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Everything a hosted call can turn into. The union is exhaustive on purpose:
 * a renderer that switches on it cannot silently fall through to "looked fine".
 */
export type HostedOutcome<T> =
  /** A validated success envelope. */
  | { kind: "ok"; envelope: Envelope<T> }
  /** HTTP 200 + one of `FINDING_CODES`. The answer the caller came for. */
  | { kind: "finding"; error: ApiError; status: number }
  /** A validated error envelope that is a genuine refusal or outage. */
  | { kind: "refused"; error: ApiError; status: number }
  /** We never got an answer: transport failure, timeout, or an unreadable body. */
  | { kind: "unreachable"; detail: string }
  /** We got a body and it did not match `spec/schemas/`. Discarded, not forwarded. */
  | { kind: "unvalidated"; schema: string; detail: string };

const DEFAULT_TIMEOUT_MS = 20_000;

export class HostedClient {
  readonly baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: HostedClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * `GET /api/v1/<tool>` with the given query, validated against `<schema>`.
   *
   * Generic in the data shape only. The validation, not the type parameter, is
   * what makes the cast at the end safe.
   */
  async get<T>(tool: string, schema: string, query: Record<string, string>): Promise<HostedOutcome<T>> {
    const url = `${this.baseUrl}/api/v1/${tool}?${new URLSearchParams(query).toString()}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      return { kind: "unreachable", detail: describeTransportFailure(error, this.#timeoutMs) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "unreachable",
        detail: `${this.baseUrl} answered HTTP ${response.status} with a body that is not JSON.`,
      };
    }

    // An error envelope is distinguishable by shape, and the shape is checked
    // before it is believed. Both branches validate: an unvalidatable error is
    // as unusable as an unvalidatable success.
    if (isErrorShaped(body)) {
      const check = validateAgainst("error", body);
      if (!check.ok) {
        return {
          kind: "unvalidated",
          schema: "error",
          detail: check.errors,
        };
      }
      const error = (body as ErrorEnvelope).error;
      return FINDING_CODES.includes(error.code) && response.status === 200
        ? { kind: "finding", error, status: response.status }
        : { kind: "refused", error, status: response.status };
    }

    const check = validateAgainst(schema, body);
    if (!check.ok) {
      return { kind: "unvalidated", schema, detail: check.errors };
    }

    return { kind: "ok", envelope: body as Envelope<T> };
  }
}

function isErrorShaped(body: unknown): boolean {
  return typeof body === "object" && body !== null && "error" in body;
}

/**
 * Say what failed without saying anything a caller could not already work out.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` `DOMException`; everything
 * else arrives as a `TypeError` from `fetch` with a cause that is usually a
 * system errno. Neither is shown verbatim — the message is ours, so it cannot
 * leak a path or a stack.
 */
function describeTransportFailure(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `The request did not complete within ${Math.round(timeoutMs / 1000)}s.`;
  }
  return "The request could not be completed. tools.tx402.io could not be reached from this machine.";
}

/**
 * The base URL to use, from the environment or the default.
 *
 * This is a base URL and not a credential — there are none in this product. It exists so a
 * developer can point the server at a local `wrangler dev` instead of production, which is the only
 * supported reason to change it.
 */
export function baseUrlFromEnv(env: Record<string, string | undefined>): string {
  const configured = env[BASE_URL_ENV_VAR];
  return configured && configured.trim().length > 0 ? configured.trim() : DEFAULT_BASE_URL;
}
