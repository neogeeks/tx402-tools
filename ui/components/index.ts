/**
 * The component primitives every tool page composes.
 *
 * Sessions compose these; they do not invent new ones and they do not add a
 * colour — `pnpm gate:tokens` rejects a raw colour anywhere but
 * `ui/tokens.css`. If a tool genuinely needs a primitive that is not here,
 * that is an addendum and an open item, not a one-off in `ui/pages/`.
 */

export { escapeHtml, html, join, raw, when, Raw } from "./html.js";
export { page, pageHead, observationNote } from "./page.js";
export { header, NAV } from "./header.js";
export type { NavItem } from "./header.js";
export { footer } from "./footer.js";
export { pasteBox } from "./paste-box.js";
export type { PasteBoxOptions } from "./paste-box.js";
export { resultCard } from "./result-card.js";
export type { ResultCardOptions } from "./result-card.js";
export { kvTable } from "./kv-table.js";
export type { KvRow } from "./kv-table.js";
export { statusPill, toneForBand, toneForCheck } from "./status-pill.js";
export type { Tone } from "./status-pill.js";
export { codeBlock, jsonBlock } from "./code-block.js";
export type { CodeBlockOptions } from "./code-block.js";
export { emptyState, noHistoryYet } from "./empty-state.js";
export type { EmptyStateOptions } from "./empty-state.js";
