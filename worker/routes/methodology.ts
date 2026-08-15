/**
 * `/methodology`.
 *
 * /§6.2: the methodology is PUBLISHED, versioned with the score, and
 * lists every signal, its weight and its rationale. This route is the page that
 * makes a public risk verdict appealable, and every other surface's caveat
 * points at it — its MCP renderer refuses to emit a band without a framing
 * sentence that names this page, so if it did not exist every one of those
 * caveats would be a dangling reference.
 *
 * ── Generated, not transcribed ───────────────────────────────────────────
 *
 * `buildMethodology` reads the weights, severities, thresholds, coverage
 * floor and score version out of `worker/lib/score.ts`, and obtains the
 * per-signal wording by **running `score`** and reading `reasons[].message`.
 * The two prose columns come from `spec/risk-score.md` via a generated module
 * pinned to it by `test/methodology-page.test.ts`. A page that could drift from
 * the function it documents would be a published claim about how we judge
 * somebody that is quietly false, which is worse than no page at all.
 *
 * ── `?v=` ────────────────────────────────────────────────────────────────
 *
 * SPEC §7: every version's methodology stays published at
 * `/methodology?v=<version>` forever, because removing one would strand every
 * score ever rendered under it. There is exactly one version today, so an
 * unknown `v` is answered with 404 rather than silently served as v1 — being
 * handed the wrong version's methodology is worse than being told we do not
 * have it.
 *
 * `implemented: true` is stamped here rather than in `worker/router.ts`, which
 * has one owner.
 */

import { envelope, errorResponse, json, markdown, html as htmlResponse } from "../http.js";
import { CURRENT_SCORE_VERSION } from "../lib/score.js";
import { OPTOUT_WELL_KNOWN } from "../crawler/optout.js";
import { CLAIM_TOKEN_TTL_HOURS, CLAIM_TXT_NAME, CLAIM_WELL_KNOWN } from "./claim-proof.js";
import {
  buildMethodology,
  methodologyMarkdown,
  methodologyPage,
  type ClaimDocs,
  type MethodologyData,
} from "../../ui/pages/methodology/index.js";
import type { RouteContext, RouteHandler } from "../types.js";

/** Pure and version-stable, so it is built once per isolate rather than per request. */
const DATA: MethodologyData = buildMethodology();

/** Every score version whose methodology is published. Append, never remove. */
export const PUBLISHED_VERSIONS: readonly string[] = [CURRENT_SCORE_VERSION];

function docsFor(ctx: RouteContext): ClaimDocs {
  return {
    origin: ctx.env.PUBLIC_ORIGIN || "https://tools.tx402.io",
    txtName: CLAIM_TXT_NAME,
    wellKnown: CLAIM_WELL_KNOWN,
    optoutWellKnown: OPTOUT_WELL_KNOWN,
    tokenTtlHours: CLAIM_TOKEN_TTL_HOURS,
    defaultMethod: "dns-txt",
  };
}

export const methodology: RouteHandler = (ctx: RouteContext): Response => {
  const requested = ctx.url.searchParams.get("v");
  if (requested !== null && !PUBLISHED_VERSIONS.includes(requested)) {
    return errorResponse("NOT_FOUND", {
      message: `No methodology is published for score version "${requested}".`,
      detail: { published_versions: [...PUBLISHED_VERSIONS] },
    });
  }

  const meta = ctx.route;
  const docs = docsFor(ctx);

  if (ctx.format === "json") {
    return json(envelope(meta, DATA, { scoreVersion: CURRENT_SCORE_VERSION }), {}, ctx);
  }

  if (ctx.format === "markdown") {
    return markdown(methodologyMarkdown(DATA, docs), {}, ctx);
  }

  return htmlResponse(
    methodologyPage({ data: DATA, docs, path: "/methodology" }),
    {},
    ctx,
  );
};
