/**
 * The smallest inline-markdown renderer that will do.
 *
 * `published.ts` carries the two prose columns of `spec/risk-score.md`
 * **verbatim**, which is what makes the divergence test an exact string
 * comparison. Verbatim means those cells still contain the document's inline
 * markup — `` `code` ``, `*emphasis*` and `[link](#anchor)` — so the HTML
 * mirror needs to render exactly those three and nothing else.
 *
 * It is deliberately not a markdown library. The input is a repository file
 * that a reviewer reads in a diff, never a request or a probed endpoint, and
 * every segment is escaped before any tag is emitted — so the worst a malformed
 * cell can do is render as literal text.
 */

import { escapeHtml } from "../../components/html.js";

const PATTERN = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*/gu;

export function inlineMarkdown(source: string): string {
  let out = "";
  let last = 0;

  for (const match of source.matchAll(PATTERN)) {
    const at = match.index ?? 0;
    out += escapeHtml(source.slice(last, at));

    const [, code, linkText, href, emphasis] = match;
    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (linkText !== undefined && href !== undefined) {
      // Anchors and https only. A cell is repository content, but a renderer
      // that will emit any scheme is a javascript: URL waiting to be pasted in.
      const safe = href.startsWith("#") || href.startsWith("https://") || href.startsWith("/");
      out += safe
        ? `<a href="${escapeHtml(href)}">${escapeHtml(linkText)}</a>`
        : escapeHtml(match[0]);
    } else if (emphasis !== undefined) {
      out += `<em>${escapeHtml(emphasis)}</em>`;
    }

    last = at + match[0].length;
  }

  return out + escapeHtml(source.slice(last));
}
