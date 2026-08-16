/**
 * The home page.
 *
 * This is the placeholder its exit criteria calls for, but it is a real page
 * rather than a "coming soon": it lists the tools, states what is live, and
 * carries the content negotiation every other route has.  does the SEO and
 * copy pass; the structure here is what it edits.
 *
 * Per the copy targets CATEGORY terms — what the tools do — not
 * the brand term.
 */

import { envelope, html as htmlResponse, json, markdown } from "../http.js";
import { page, pageHead } from "../../ui/components/page.js";
import { resultCard } from "../../ui/components/result-card.js";
import { statusPill } from "../../ui/components/status-pill.js";
import { kvTable } from "../../ui/components/kv-table.js";
import { html, join } from "../../ui/components/html.js";
import { SITE, TOOLS } from "../../ui/tool-meta.js";
import type { RouteContext, RouteHandler } from "../types.js";

// Copy and search metadata live in ui/tool-meta.ts so they survive the sessions
// that replace the stubs, and so every string targets a category term rather
// than the brand term. a test audits it page by page.
const TOOL_LIST = [
  TOOLS.inspect,
  TOOLS.verify,
  TOOLS.policy,
  TOOLS.history,
  TOOLS.compare,
  TOOLS.replay,
];

export const home: RouteHandler = (ctx: RouteContext): Response => {
  const data = {
    tools: TOOL_LIST.map((t) => ({ path: t.path, name: t.name, description: t.description, live: t.live })),
    api: { version: "v1", schemas: "/api/v1/schemas", spec: "/api/v1/meta" },
  };

  if (ctx.format === "json") return json(envelope(ctx.route, data), {}, ctx);

  if (ctx.format === "markdown") {
    return markdown(
      [
        `# ${SITE.h1}`,
        "",
        SITE.tagline,
        "",
        "## Tools",
        "",
        ...TOOL_LIST.map(
          (t) => `- **[${t.name}](${t.path})** — ${t.description}${t.live ? "" : " *(not live yet)*"}`,
        ),
        "",
        "## For agents",
        "",
        "Every page answers `Accept: application/json` and `Accept: text/markdown`. Append `.md` to any path",
        "for the same effect. JSON Schemas for every response live at `/api/v1/schemas`.",
        "",
        "This service never constructs a payment signature and holds no keys.",
      ].join("\n"),
      {},
      ctx,
    );
  }

  const cards = TOOL_LIST.map((t) =>
    resultCard({
      title: t.name,
      badge: t.live ? statusPill("live", "ok") : statusPill("not live yet", "unknown"),
      body: html`<h3 class="card-question">${t.h1}</h3>
        <p class="muted">${t.description}</p>
        <p><a href="${t.path}">Open ${t.name} →</a></p>`,
    }),
  );

  return htmlResponse(
    page({
      title: SITE.title,
      description: SITE.description,
      path: "/",
      body:
        pageHead(SITE.h1, `${SITE.description} ${SITE.tagline}`) +
        html`<div class="stack tool-grid">${join(cards)}</div>` +
        resultCard({
          title: "Built for agents too",
          body:
            html`<p class="muted">
              Every page serves three representations of the same result, so an agent never has to scrape HTML.
            </p>` +
            kvTable([
              { label: "JSON", value: "curl -H 'Accept: application/json' tools.tx402.io/inspect?url=…" },
              { label: "Markdown", value: "curl -H 'Accept: text/markdown' tools.tx402.io/inspect?url=…" },
              { label: "Or just", value: "curl tools.tx402.io/inspect.md?url=…" },
              { label: "Schemas", valueHtml: '<a href="/api/v1/schemas">/api/v1/schemas</a>' },
            ]),
          footer:
            'This service never constructs a payment signature and holds no keys — enforced by a CI gate, not a promise.',
        }),
    }),
    {},
    ctx,
  );
};
