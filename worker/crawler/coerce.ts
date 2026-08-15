/**
 * Narrowing helpers for values that arrive from D1 as `unknown`.
 *
 * `String(value)` on an `unknown` is what the lint rule is right to object to:
 * if a column ever came back as an object, it would be stringified to
 * `[object Object]` and stored as though it were data. These helpers make the
 * fallback explicit instead, so a surprising column type produces the default
 * rather than a plausible-looking corruption.
 */

/** A string, or the fallback. Numbers and booleans are converted; nothing else. */
export function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return fallback;
}

/** A string, or null. Used where absence is meaningful rather than defaulted. */
export function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/** A finite number, or the fallback. */
export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
