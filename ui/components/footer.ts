import { html, raw } from "./html.js";
import { BRAND_MARK } from "./header.js";

/**
 * Site footer.
 *
 * ── The site links are not decoration ──────────────────────────────────────
 *
 * `/methodology` is where a published, versioned scoring methodology lives
 * and `/crawler` is where an operator finds the opt-out
 * (docs/abuse-policy.md). A trust product that makes either of those hard to
 * find is not a trust product.
 *
 * ── The ecosystem links are the conversion path ───────────────
 *
 * closed the option of a second domain and spent the saved effort on
 * one move instead: "reverse-link hard. Every tool page links into docs;
 * `docs.tx402.io` and `tx402.io` link out to the relevant tool from the
 * relevant page." Same-registrable-domain internal linking is the cheapest
 * authority transfer available and it is how a developer who arrived on a
 * symptom query ("why did my x402 payment fail") reaches the SDK that fixes it.
 *
 * **This is the outbound half only.** The inbound half — the links FROM
 * `tx402.io` and `docs.tx402.io` back to these tools — lives in two other
 * repositories that forbids this change from touching. The exact copy
 * and target URLs for it are written out. for whoever owns
 * those repositories to paste. Until that lands, **the cross-linking is done in
 * one direction and it should not be described as done.**
 *
 * ── Deep links, not a home page ────────────────────────────────────────────
 *
 * Each tool has a docs page that is the natural next step, so the footer points
 * at those pages rather than at `docs.tx402.io`: lifecycle for Inspect,
 * policy for the Playground, the typed error taxonomy for Replay. A link to a
 * documentation home page transfers authority to the home page and makes the
 * reader do the search again.
 *
 * ── The two packages are named, not sold ───────────────────────────────────
 *
 * `tx402-tools` and `tx402-tools-mcp` both hold a reserved `0.0.0` placeholder
 * on npm and a real release is Jayanth's call. So the footer
 * links to the source, never to `npm i`, and `packages/tools-mcp/README.md`'s
 * "not published yet" callout is the thing the site must stay consistent with.
 */

const REPO = "https://github.com/neogeeks/tx402-tools";

/** Where each tool's reader goes next. Deep pages, verified live 2026-08-15. */
const DOCS = {
  lifecycle: "https://docs.tx402.io/guides/lifecycle/",
  policy: "https://docs.tx402.io/guides/policy/",
  errors: "https://docs.tx402.io/reference/errors/",
} as const;

export function footer(): string {
  return html`
    <footer class="site-footer">
      <div class="wrap">
        <span class="footer-brand">
          <a class="brand" href="/" aria-label="tx402 tools — home"
            >${raw(BRAND_MARK)} tx402 <span class="brand-sub">tools</span></a
          >
          — hosted utilities for the x402 payment protocol.
        </span>
        <nav class="footer-links" aria-label="This site">
          <a href="/methodology">Methodology</a>
          <a href="/crawler">Crawler &amp; opt-out</a>
          <a href="/errors">Error reference</a>
          <a href="/llms.txt">For agents</a>
          <a href="${REPO}">Source</a>
        </nav>
        <nav class="footer-links" aria-label="tx402">
          <a href="https://tx402.io">The tx402 SDK</a>
          <a href="${DOCS.lifecycle}">Payment lifecycle</a>
          <a href="${DOCS.policy}">Spend policy</a>
          <a href="${DOCS.errors}">Typed errors</a>
          <a href="${REPO}/tree/main/packages/tools-cli">CLI</a>
          <a href="${REPO}/tree/main/packages/tools-mcp">MCP server</a>
        </nav>
      </div>
    </footer>
  `;
}
