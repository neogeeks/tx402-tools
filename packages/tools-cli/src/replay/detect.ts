/**
 * Format auto-detection.
 *
 * The user does not declare what they pasted. They have a failed payment and a
 * blob of something, and being asked "is this a CLI trace or an error?" is the
 * kind of question a debugger should answer for itself.
 *
 * Four shapes, tried in the priority order gives them:
 *
 *   1. `cli_json`     — `tx402 call --json`. The richest input: it carries the
 *                       exit code, the inspection, the route, the settlement
 *                       and a serialized error all at once.
 *   2. `tx402_error`  — one serialized `Tx402Error` (its `toJSON`).
 *   3. `http_pair`    — a raw request/response pair, pasted from a proxy or a
 *                       `curl -v`.
 *   4. `cli_trace`    — the structured event stream, as NDJSON, a JSON array,
 *                       or log lines with the event names in them.
 *
 * Detection is structural and reads only keys, never values, so it is safe to
 * run before redaction — which it must be, because the caller redacts
 * immediately afterwards and nothing downstream ever sees the original.
 */

import { EVENT_NAMES, TX402_ERROR_CODES } from "tx402";
import type { Phase, TraceFormat } from "./types.js";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(TX402_ERROR_CODES));
const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(EVENT_NAMES);

export interface Detected {
  format: TraceFormat;
  /** Parsed JSON where the input was JSON; the raw text otherwise. */
  parsed: unknown;
  /** Always present — `--share` uploads text for `http_pair`. */
  raw: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An HTTP request line (`GET /x HTTP/1.1`) or a status line (`HTTP/1.1 402 …`). */
const HTTP_START =
  /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d(?:\.\d)?|HTTP\/\d(?:\.\d)?\s+\d{3})/m;

export class UnrecognizedTraceError extends Error {
  override readonly name = "UnrecognizedTraceError";
}

export function detect(input: string): Detected {
  const raw = input;
  const text = input.trim();
  if (text === "") throw new UnrecognizedTraceError("The input is empty.");

  const json = tryJson(text);

  if (json !== undefined) {
    if (looksLikeCliJson(json)) return { format: "cli_json", parsed: json, raw };
    if (looksLikeTx402Error(json)) return { format: "tx402_error", parsed: json, raw };
    if (looksLikeEventArray(json)) return { format: "cli_trace", parsed: json, raw };
    // Valid JSON that is none of the three. An object carrying an `error` that
    // is a typed error is still a CLI-shaped document worth reading.
    if (isRecord(json) && looksLikeTx402Error(json["error"])) {
      return { format: "cli_json", parsed: json, raw };
    }
    throw new UnrecognizedTraceError(
      "That JSON is not a tx402 --json document, a serialized tx402 error, or an event stream.",
    );
  }

  // NDJSON: one JSON object per line, which `JSON.parse` above rejects.
  const ndjson = tryNdjson(text);
  if (ndjson && looksLikeEventArray(ndjson)) {
    return { format: "cli_trace", parsed: ndjson, raw };
  }

  if (HTTP_START.test(text)) return { format: "http_pair", parsed: text, raw };

  // Log lines with event names in them — the loosest shape, tried last so it
  // never shadows a structured input.
  if ([...EVENT_NAME_SET].some((name) => text.includes(name))) {
    return { format: "cli_trace", parsed: text, raw };
  }

  throw new UnrecognizedTraceError(
    "Could not tell what this is. Expected `tx402 call --json` output, a serialized tx402 error, a raw HTTP request/response pair, or a tx402 event trace.",
  );
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tryNdjson(text: string): unknown[] | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) return null;
    const value = tryJson(line);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

/**
 * The `--json` document is identified by `schemaVersion` plus the two fields no
 * other tx402 artifact carries together: `ok` and `exitCode`.
 */
function looksLikeCliJson(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasVersion = typeof value["schemaVersion"] === "number";
  const hasOk = typeof value["ok"] === "boolean";
  const hasExit = typeof value["exitCode"] === "number";
  const hasTimings = isRecord(value["timings"]);
  return (hasOk && hasExit) || (hasVersion && (hasOk || hasTimings));
}

/**
 * Mirrors the SDK's own `isTx402Error`: check the shape, not the class, because
 * this one has been through `JSON.stringify` and is a plain object by the time
 * it reaches us.
 */
function looksLikeTx402Error(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value["code"] === "string" && ERROR_CODE_SET.has(value["code"]);
}

function looksLikeEventArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => isRecord(item) && typeof item["event"] === "string" && EVENT_NAME_SET.has(item["event"]));
}

// ── extraction ───────────────────────────────────────────────────────────
// Everything below reads a REDACTED structure. The facts a reconstruction
// needs — the error code, the SDK phase, `paid`, the status, the event names —
// are identifiers and categories, none of which the redactor touches. That is
// what makes "redact first, then analyse" possible rather than merely
// desirable.

/** RFC 3339, UTC, second precision — the shape `spec/schemas/common.json` wants. */
export function toTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 19) + "Z";
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 19) + "Z";
}

/** The event name → phase map, for reconstructing timings from a trace. */
export const EVENT_TO_PHASE: Record<string, Phase> = {
  "request.started": "discover",
  "payment.required": "decode",
  "policy.checked": "policy",
  "route.planned": "route",
  "budget.reserved": "authorize",
  "recipient.pinned": "authorize",
  "recipient.rejected": "authorize",
  "spend.frozen": "authorize",
  "sign.started": "authorize",
  "sign.completed": "authorize",
  "payment.exposed": "authorize",
  "request.retried": "submit",
  "payment.completed": "settle",
  "request.failed": "deliver",
};

export { isRecord };
