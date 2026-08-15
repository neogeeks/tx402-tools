/** Scoring methodology page module —. */

export { methodologyPage } from "./page.js";
export type { MethodologyPageOptions } from "./page.js";
export { methodologyMarkdown } from "./markdown.js";
export {
  buildMethodology,
  FORMULA,
  TOTAL_AVAILABLE_WEIGHT,
  WORKED_EXAMPLES,
} from "./model.js";
export type {
  MethodologyBand,
  MethodologyData,
  MethodologySignal,
  WorkedExample,
  WorkedExampleRow,
} from "./model.js";
export { PUBLISHED_PROSE } from "./published.js";
export type { PublishedProse } from "./published.js";
export { inlineMarkdown } from "./inline.js";
export * as COPY from "./copy.js";
export type { ClaimDocs } from "./types.js";
