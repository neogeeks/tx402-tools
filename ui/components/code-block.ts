import { html, raw } from "./html.js";

/**
 * Code block.
 *
 * The content is always escaped. Much of what this renders is a challenge
 * served by a third-party endpoint — attacker-controlled text by definition —
 * so it goes through the same escaping as everything else, with no
 * "trusted JSON" shortcut.
 */

export interface CodeBlockOptions {
  code: string;
  /** Label shown in the block header, e.g. "PAYMENT-REQUIRED" or "JSON". */
  label?: string;
  /** Render a copy button (progressively enhanced by /assets/app.js). */
  copy?: boolean;
}

export function codeBlock(opts: CodeBlockOptions): string {
  const head =
    opts.label || opts.copy
      ? html`<div class="code-head">
          <span>${opts.label ?? ""}</span>
          ${raw(
            opts.copy
              ? html`<button type="button" class="btn btn-secondary code-copy" data-copy>Copy</button>`
              : "",
          )}
        </div>`
      : "";

  return html`<div class="code">
    ${raw(head)}
    <pre><code>${opts.code}</code></pre>
  </div>`;
}

/** Convenience for rendering a JSON value. */
export function jsonBlock(value: unknown, label = "JSON"): string {
  return codeBlock({ code: JSON.stringify(value, null, 2), label, copy: true });
}
