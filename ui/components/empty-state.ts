import { html, raw } from "./html.js";

/**
 * Empty state.
 *
 * "first seen: just now — no history yet" is the CORRECT display
 * for an endpoint we have not seen before, and it is what the Inspector will
 * show forever for new endpoints. So this is a designed state with a heading
 * and an explanation, not a greyed-out apology.
 *
 * `body` and `detail` are inserted as HTML so a caller can include a link.
 * Escape anything derived from a request before passing it in.
 */

export interface EmptyStateOptions {
  title: string;
  body: string;
  detail?: string;
}

export function emptyState(opts: EmptyStateOptions): string {
  return html`<div class="empty">
    <h2>${raw(opts.title)}</h2>
    <p>${raw(opts.body)}</p>
    ${raw(opts.detail ? html`<p class="empty-detail">${raw(opts.detail)}</p>` : "")}
  </div>`;
}

/** The specific empty state for an endpoint with no corpus history. */
export function noHistoryYet(what = "this endpoint"): string {
  return emptyState({
    title: "No history yet",
    body: `We have not observed ${what} before, so there is nothing to chart. That is the normal state for a new endpoint — history builds from the first observation onward.`,
    detail: 'Price and recipient changes are recorded permanently; availability and latency are sampled.',
  });
}
