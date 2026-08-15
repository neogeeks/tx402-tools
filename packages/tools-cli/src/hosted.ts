/**
 * The hosted API client.
 *
 * ──, the no-backend firewall, as it applies here ────────────────
 *
 * `tx402`'s README promises "No backend — no tx402-operated service, no
 * telemetry, no phone-home", and L4 requires that to stay *mathematically*
 * true rather than "true if you don't pass the flag". That is why this package
 * is separate and unscoped: installing `tx402` cannot install this, so it
 * cannot cause a call to `tools.tx402.io`.
 *
 * Inside this package the rule is narrower but just as strict: **every hosted
 * call is one the user asked for.** There is no silent fallback. Concretely,
 * and asserted in `test/cli.test.ts`:
 *
 *   - `verify` never calls this module unless `--enrich` is passed. A thin
 *     offline answer stays thin and says so; it does not quietly go and ask.
 *   - `inspect` never calls it unless `--hosted` is passed. The default is a
 *     local probe, because reaching endpoints the hosted probe cannot is the
 *     entire reason this CLI exists.
 *   - `history` and `compare` are hosted **verbs**. They need the corpus and
 *     cannot be computed locally, so running one IS the request to call out.
 *     They say which origin they asked, and refuse to invent a number when
 *     the answer comes back empty.
 *
 * There is no config file, no credential and no token. Nothing in this product
 * authenticates a caller — accounts were cut with Watch in wave 3 — so a CLI
 * that asked for an API key would be asking for something that does not exist.
 */

import { UsageError } from "./args.js";

export const DEFAULT_ORIGIN = "https://tools.tx402.io";

/**
 * Resolve the origin to call.
 *
 * `TX402_TOOLS_ORIGIN` exists so that a session can develop against
 * `wrangler dev` own advice, since the deployed site is not the
 * contract. It cannot introduce a hosted call that would not otherwise happen;
 * it only changes where an already-requested one goes.
 */
export function resolveOrigin(explicit: string | null, env: Record<string, string | undefined>): string {
  const raw = explicit ?? env.TX402_TOOLS_ORIGIN ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--origin is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`--origin must be http(s): ${raw}`);
  }
  return url.origin;
}

export interface HostedResponse {
  status: number;
  /** The parsed body, or null when it was not JSON at all. */
  body: unknown;
}

export class HostedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostedError";
    this.code = code;
  }
}

export interface HostedOptions {
  origin: string;
  timeoutMs?: number;
  /** Injected by the tests. The CLI never installs a global fetch patch. */
  fetchImpl?: typeof fetch;
}

/**
 * GET one JSON path from the hosted API.
 *
 * No credentials, no cookies, no redirect following into somewhere else — the
 * same discipline the probe applies to third-party endpoints, applied to our
 * own service, because "it is ours" is not a security property.
 */
export async function getJson(path: string, options: HostedOptions): Promise<HostedResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.origin}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": userAgent() },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && /abort|timeout/iu.test(error.name + error.message));
    throw new HostedError(
      aborted ? "PROBE_TIMEOUT" : "PROBE_FAILED",
      aborted
        ? `${options.origin} did not answer in time.`
        : `${options.origin} could not be reached.`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  return { status: response.status, body };
}

/** POST a JSON body. Used only by `verify --enrich` and `replay --share`. */
export async function postJson(
  path: string,
  payload: unknown,
  options: HostedOptions,
): Promise<HostedResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await doFetch(`${options.origin}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": userAgent(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && /abort|timeout/iu.test(error.name + error.message));
    throw new HostedError(
      aborted ? "PROBE_TIMEOUT" : "PROBE_FAILED",
      aborted
        ? `${options.origin} did not answer in time.`
        : `${options.origin} could not be reached.`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Identifies the CLI, and nothing about the person running it. */
export function userAgent(): string {
  return "tx402-tools-cli/0.1.0 (+https://tools.tx402.io)";
}

/** The error envelope shape, when the hosted API returns one (SPEC §3). */
export function readErrorEnvelope(
  body: unknown,
): { code: string; message: string; retryable: boolean } | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; message?: unknown; retryable?: unknown };
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  return {
    code: record.code,
    message: record.message,
    retryable: record.retryable === true,
  };
}
