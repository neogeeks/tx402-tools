import { html, raw } from "./html.js";
import { header } from "./header.js";
import { footer } from "./footer.js";
import { ORIGIN, headMetadata } from "./jsonld.js";
import { pageTitle } from "../tool-meta.js";
import { assetUrl } from "../../worker/routes/assets.js";

/**
 * The page shell. Every tool page composes this; nobody writes their own
 * `<head>`.
 *
 * Three things are baked in rather than left to each page:
 *
 *  - the theme script, which is inline and runs before first paint so a
 *    light-theme visitor never sees a dark flash. It reads localStorage only —
 *    no cookie, no visitor identifier.
 *  - `observationNote`, the sentence that says a band describes the confidence
 *    of our observations rather than the operator. Any page
 *    rendering a risk verdict passes `observationNote: true`, and because it
 *    lives here it cannot be forgotten on one page out of seven.
 *  - **the whole of `<head>`'s search and social metadata**: canonical,
 *    `og:`, `twitter:`, `<link rel=alternate>` for the Markdown and JSON
 *    representations, theme colour and the JSON-LD `@graph`. It is derived from
 *    `path`, `title` and `description` — the three things every caller already
 *    passes — so a page gets correct structured data by being a page. That
 *    matters because `ui/pages/*` has six different owners: metadata that each
 *    session had to remember would exist on the pages whose session thought of
 *    it, and would be dropped by the next session to rewrite one.
 *
 * `ui/components/jsonld.ts` builds it; this file only decides where it goes.
 */

export interface PageOptions {
  title: string;
  description: string;
  body: string;
  /** Path used to mark the current nav item, and to derive metadata. */
  path?: string;
  /** Render the "these are observations, not accusations" note above the fold. */
  observationNote?: boolean;
  /**
   * Canonical URL for this page, when it is not the origin + `path`.
   *
   * Pass this whenever `path` is not the canonical location — a Compare
   * category page marks `/compare` as current in the nav but is canonically
   * `/compare/<slug>`, and a share permalink is canonically the tool page.
   */
  canonical?: string;
  /**
   * Extra `<head>` markup: a page's own `<style>` block, and nothing that this
   * shell already emits. Canonical, JSON-LD, `og:`, `twitter:` and the
   * representation alternates are its and are added for every page below.
   */
  head?: string;
}

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('tx402-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

/**
 * The canonical URL for a page.
 *
 * A query string is dropped unless the caller pinned one via `canonical`.
 * `/inspect?url=https://an.example/paid` and `/inspect` are the same document
 * for indexing purposes, and every distinct `url=` would otherwise be a
 * separate indexable page whose content is a report about somebody else's
 * endpoint. That is both an index-bloat problem and, given, a
 * thing this product should not be doing by accident.
 */
function canonicalFor(opts: PageOptions): string {
  if (opts.canonical) return opts.canonical;
  const path = (opts.path ?? "/").split("?")[0] ?? "/";
  return `${ORIGIN}${path === "/" ? "/" : path}`;
}

export function page(opts: PageOptions): string {
  // The brand goes in the suffix, never the lead: the category term is what
  // earns the click.
  const title = pageTitle(opts.title);
  const canonical = canonicalFor(opts);
  const path = new URL(canonical).pathname;

  return `<!doctype html>
${html`<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${opts.description}" />
    ${headMetadata({
      canonical,
      path,
      title: opts.title,
      socialTitle: title,
      description: opts.description,
    })}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="alternate icon" href="/favicon.ico" sizes="32x32" />
    <link rel="apple-touch-icon" href="/icon-180.png" />
    <link rel="stylesheet" href="${assetUrl("tokens.css")}" />
    <link rel="stylesheet" href="${assetUrl("components.css")}" />
    <script>${raw(THEME_SCRIPT)}</script>
    <script src="${assetUrl("app.js")}" defer></script>
    ${raw(opts.head ?? "")}
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell">
      ${raw(header(opts.path ?? "/"))}
      <main id="main">
        <div class="wrap">
          ${raw(opts.observationNote ? observationNote() : "")}
          ${raw(opts.body)}
        </div>
      </main>
      ${raw(footer())}
    </div>
  </body>
</html>`}
`;
}

/**
 *, verbatim in spirit: LOW/MEDIUM/HIGH describes the confidence of
 * our observations, not the merchant's character — and the page must say so,
 * above the fold. The words "scam", "unsafe" and "fraudulent" appear nowhere in
 * this repo's user-facing strings.
 */
export function observationNote(): string {
  return html`
    <p class="observation-note">
      <strong>These are observations, not accusations.</strong> A band of LOW, MEDIUM or HIGH describes how
      much of what we check we were able to confirm — it is not a judgement about the operator of an
      endpoint. Every signal, its weight and its rationale are published on the
      <a href="/methodology">methodology page</a>, and any operator can
      <a href="/crawler">claim an endpoint, correct a fact or opt out</a>.
    </p>
  `;
}

/** Standard page heading. */
export function pageHead(title: string, summary?: string): string {
  return html`
    <div class="page-head">
      <h1>${title}</h1>
      ${raw(summary ? html`<p>${summary}</p>` : "")}
    </div>
  `;
}
