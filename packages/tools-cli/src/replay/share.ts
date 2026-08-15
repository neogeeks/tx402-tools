/**
 * `--share` — the opt-in permalink.
 *
 * Three properties, all of them load-bearing:
 *
 *  1. **Opt-in per invocation.** There is no config key that turns this on
 *     permanently and no default that reaches the network. A replay with no
 *     `--share` flag makes zero network calls, which is the same property
 *     asserts for the offline verifier and the same reason: the trace is
 *     already on the developer's machine and uploading it is a privacy problem,
 *     not a convenience.
 *  2. **It prints what it is about to send, before sending it.** Not a summary
 *     of it — the actual bytes. A redactor you cannot inspect is a redactor you
 *     have to trust, and the whole point of doing this client-side is that you
 *     do not have to.
 *  3. **It can only be handed redacted data.** `buildSharePayload` takes a
 *     `ReplayResult`, whose `trace` is a `RedactedTrace`, and there is no
 *     overload that takes anything else.
 */

import type { ReplayResult } from "./types.js";
import type { ReplayAnalysis } from "./types.js";

export interface SharePayload {
  trace: unknown;
  analysis: ReplayAnalysis;
}

export interface ShareResult {
  id: string;
  url: string;
  expires_at: string | null;
}

export interface ShareOptions {
  /** Defaults to the public origin; overridable for `wrangler dev`. */
  origin?: string;
  /** Injected so the "prints before sending" property is testable. */
  fetchImpl?: typeof fetch;
  /** Injected for the same reason. */
  print?: (line: string) => void;
  /**
   * Must return true for the upload to happen. The caller wires this to a
   * prompt, or passes ` => true` when the user already said `--yes`.
   */
  confirm?: () => boolean | Promise<boolean>;
  /** Turnstile token, when the endpoint asks for one. Absent is fine (O12). */
  turnstileToken?: string;
}

export const DEFAULT_ORIGIN = "https://tools.tx402.io";

/** The exact bytes `--share` would upload. Redacted by construction. */
export function buildSharePayload(result: ReplayResult): SharePayload {
  return { trace: result.trace.payload, analysis: result.analysis };
}

/** The preview, printed in full before anything leaves the machine. */
export function sharePreview(payload: SharePayload, origin = DEFAULT_ORIGIN): string {
  const body = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(body).length;
  return [
    `--share will POST ${String(bytes)} bytes to ${origin}/api/v1/replay/share`,
    "",
    "This is exactly what will be sent. It was redacted on this machine before",
    "it was printed; the server never receives an unredacted trace and has no",
    "column in which to store one. Read it before you agree.",
    "",
    body,
    "",
    `Redaction removed ${String(payload.analysis.redaction.fields_redacted)} value(s).`,
    "The link that comes back is unguessable and expires.",
  ].join("\n");
}

export class ShareRefusedError extends Error {
  override readonly name = "ShareRefusedError";
}

/**
 * Upload, having first printed the payload and obtained a yes.
 *
 * The order in the body of this function is the contract: print, confirm, then
 * fetch. A test asserts it by recording the sequence of calls.
 */
export async function share(
  payload: SharePayload,
  options: ShareOptions = {},
): Promise<ShareResult> {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const print = options.print ?? ((line: string) => console.log(line));
  const doFetch = options.fetchImpl ?? fetch;

  print(sharePreview(payload, origin));

  const agreed = await (options.confirm ?? (() => false))();
  if (!agreed) {
    throw new ShareRefusedError("Share declined. Nothing was uploaded.");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  // Turnstile is not provisioned yet. Sending the header when we
  // have a token and omitting it otherwise is what lets the server no-op the
  // check until the widget exists, exactly as ui/components/paste-box.ts does.
  if (options.turnstileToken) headers["cf-turnstile-response"] = options.turnstileToken;

  const response = await doFetch(`${origin}/api/v1/replay/share`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const parsed: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? JSON.stringify((parsed).error)
        : `HTTP ${String(response.status)}`;
    throw new Error(`Share failed: ${message}`);
  }

  const data = (parsed as { data?: Partial<ShareResult> }).data ?? {};
  return {
    id: data.id ?? "",
    url: data.url ?? "",
    expires_at: data.expires_at ?? null,
  };
}
