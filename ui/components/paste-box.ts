import { html, raw } from "./html.js";

/**
 * Paste box: the primary input for Inspect, Verify and Replay.
 *
 * `turnstileSiteKey` renders the Turnstile widget on public paste boxes. It is passed in rather
 * than read here because the key comes from a Worker var, and because a box used in a local CLI
 * context has no Turnstile at all. When the key is empty the widget is omitted — correct for dev,
 * and NOT acceptable in production, which is why `/api/v1/health` reports whether it is configured.
 */

export interface PasteBoxOptions {
  /** Form target, e.g. "/inspect". */
  action: string;
  method?: "GET" | "POST";
  name: string;
  label: string;
  placeholder?: string;
  value?: string;
  submitLabel?: string;
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean;
  hint?: string;
  turnstileSiteKey?: string;
}

export function pasteBox(opts: PasteBoxOptions): string {
  const id = `field-${opts.name}`;
  const field = opts.multiline
    ? html`<textarea
        class="field"
        id="${id}"
        name="${opts.name}"
        placeholder="${opts.placeholder ?? ""}"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
      >
${opts.value ?? ""}</textarea
      >`
    : html`<input
        class="field"
        id="${id}"
        name="${opts.name}"
        type="text"
        value="${opts.value ?? ""}"
        placeholder="${opts.placeholder ?? ""}"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
      />`;

  const turnstile = opts.turnstileSiteKey
    ? html`<div class="cf-turnstile" data-sitekey="${opts.turnstileSiteKey}"></div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";

  return html`<form class="paste-box" action="${opts.action}" method="${opts.method ?? "GET"}">
    <label for="${id}">${opts.label}</label>
    <div class="row">
      <div class="field-wrap">${raw(field)}</div>
      <button class="btn" type="submit">${opts.submitLabel ?? "Run"}</button>
    </div>
    ${raw(turnstile)} ${raw(opts.hint ? html`<p class="hint">${opts.hint}</p>` : "")}
  </form>`;
}
