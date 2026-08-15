/**
 * 402 Inspector page.
 *
 * `worker/routes/inspect.ts` computes one `InspectData` and hands it here; the
 * renderers below turn it into the page and the plaintext report. Nothing in
 * this directory probes, scores, reads a database or looks at a clock, which is
 * what makes SPEC §1.2's "the markdown mirror is a rendering of the same JSON"
 * a structural property rather than a promise.
 */

export { inspectPage, inspectErrorPage } from "./page.js";
export type { InspectPageOptions, InspectErrorPageOptions } from "./page.js";
export { inspectMarkdown } from "./markdown.js";
export { cliSnippet, curlSnippet, pythonSnippet, typescriptSnippet } from "./snippets.js";
export {
  BAND_NOTE,
  NOT_X402_NOTE,
  NO_HISTORY_NOTE,
  V1_NOTE,
  ellipsize,
  isLegacyV1,
  latencyLabel,
  outcomeOf,
  priceLabel,
  sdkMoney,
  termsAccepted,
  wireFormLabel,
} from "./types.js";
export type {
  Check,
  InspectData,
  InspectLinks,
  InspectObserved,
  InspectTarget,
  InspectView,
  Outcome,
  TermChange,
} from "./types.js";
