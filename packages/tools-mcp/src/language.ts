/**
 * The words this server never says, and the sentences it always says.
 *
 * is a legal and reputational rule, not a style preference: a
 * public statement about somebody else's business has to describe **what we
 * observed**, never what we think of them. Three existing test files assert
 * this against their own surfaces (`test/verify-offline.test.ts`,
 * `test/inspect.test.ts`, `test/score.test.ts`). `test/mcp.test.ts` asserts it
 * against this one.
 *
 * It matters more here than anywhere else in the suite, for a reason that has
 * nothing to do with lawyers. Every other surface renders to a human who can
 * see the framing around the number. **A tool result is read by a model that
 * is about to spend money, and it arrives as text with no page around it.** If
 * a band reaches that model as the bare token `HIGH`, the framing that makes
 * the band meaningful — that it is the confidence of *our observations* and not
 * a judgement about the operator — has been stripped off in transit. So the
 * framing is not a footer on a page here; it is carried in the same string as
 * the band, and `test/mcp.test.ts` fails if a band is ever emitted without it.
 */

/**
 * Terms that describe a party rather than an observation. None of these appears
 * in any string this package can emit, on any code path, including error paths.
 */
export const FORBIDDEN_TERMS: readonly string[] = Object.freeze([
  "scam",
  "fraud",
  "fraudulent",
  "unsafe",
  "dangerous",
  "malicious",
]);

/**
 * Travels with every band, in the same string. See the note above.
 */
export const BAND_FRAMING =
  "LOW / MEDIUM / HIGH is the level of caution the signals we could observe support. " +
  "It describes the confidence of our observations, never the character or intent of " +
  "whoever operates this endpoint.";

/**
 * `skip` is not `pass`. Stated in the result rather
 * than left to the reader, because the reader is a model that will otherwise
 * count rows.
 */
export const SKIP_FRAMING =
  "A check reported as SKIP could not run. It is not a check that passed, and it is not a finding.";

/**
 * `observed: false` is not `false`.
 */
export const UNOBSERVED_FRAMING =
  "A signal reported as not observed is something we could not determine. It is not a negative finding " +
  "and it is not scored as one.";

/**
 * The correct state for an endpoint nobody has scanned — not a degraded one
 * (SPEC §5.1).
 */
export const NO_HISTORY_FRAMING =
  "No history yet. This is the first time tools.tx402.io has been asked about this endpoint, which is " +
  "the normal state for a new endpoint rather than a finding against it.";

/**
 * What "recognized" and "known" mean in every check this server renders: present
 * on a list we publish, and nothing more.
 */
export const LIST_FRAMING =
  "\"Recognized\" and \"known\" mean present on a list we publish. The lists are public and they are not " +
  "exhaustive, so absence from one is a statement about the list's coverage.";

/**
 * Returns every forbidden term found in `text`, case-insensitively.
 *
 * Exported so the audit test and the code under test share one list — a second
 * copy of the vocabulary in the test file would drift the first time somebody
 * added a word to one of them.
 */
export function forbiddenTermsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_TERMS.filter((term) => new RegExp(`\\b${term}\\b`, "u").test(lower));
}
