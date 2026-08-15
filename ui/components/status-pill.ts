import { html, raw } from "./html.js";

/**
 * Status pill.
 *
 * `unknown` is a first-class tone, not a fallback. SPEC §6.3: a signal we could
 * not observe is not a failing signal, and a UI that renders "not observed" in
 * the same red as "failed" tells the user something we did not measure.
 */

export type Tone = "ok" | "warn" | "err" | "info" | "idle" | "unknown";

const CLASS: Record<Tone, string> = {
  ok: "pill-ok",
  warn: "pill-warn",
  err: "pill-err",
  info: "pill-info",
  idle: "pill-idle",
  unknown: "pill-idle",
};

export function statusPill(label: string, tone: Tone = "idle", srPrefix?: string): string {
  return html`<span class="pill ${CLASS[tone]}"
    >${raw(srPrefix ? html`<span class="visually-hidden">${srPrefix} </span>` : "")}${label}</span
  >`;
}

/** Map a spec Check/Signal status onto a tone. */
export function toneForCheck(status: "pass" | "warn" | "fail" | "skip"): Tone {
  switch (status) {
    case "pass":
      return "ok";
    case "warn":
      return "warn";
    case "fail":
      return "err";
    case "skip":
      return "unknown";
  }
}

/**
 * Map a risk band onto a tone.
 *
 * LOW is the reassuring end (little that we check looked unusual), so it is the
 * green one. The label is always rendered as text alongside the colour.
 */
export function toneForBand(band: "LOW" | "MEDIUM" | "HIGH"): Tone {
  switch (band) {
    case "LOW":
      return "ok";
    case "MEDIUM":
      return "warn";
    case "HIGH":
      return "err";
  }
}
