/**
 * 402 Compare's renderers and view model.
 *
 * One computation (`worker/routes/compare.ts`), three renderings. Nothing here
 * reaches a database, a probe or a clock: a renderer that could would let the
 * JSON and the page disagree about what was observed, which SPEC §1.2 forbids.
 */

export { comparePage } from "./page.js";
export { compareMarkdown, categoriesMarkdown } from "./markdown.js";
export {
  CATEGORIES,
  categoriesForTags,
  categoryBySlug,
  normalizeTag,
  publishedCategories,
} from "./catalogue.js";
export type { CategoryDefinition } from "./catalogue.js";
export {
  daysBetween,
  emptyReason,
  priceComparable,
  priceLabel,
  scoreVersions,
  scoredDownForV1,
} from "./types.js";
export type {
  AdvertisedTerms,
  CategorySummary,
  CompareCategory,
  CompareData,
  CompareRow,
  CompareRowDetail,
  CompareView,
  DataState,
  FacilitatorClaim,
  Ranking,
  SortKey,
} from "./types.js";
