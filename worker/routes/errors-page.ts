/**
 * Error reference.
 *
 * Every error envelope carries `docs: https://tools.tx402.io/errors#<code>`
 * (SPEC §3), so this page has to exist from day one or every error message
 * links into a 404.
 *
 * It renders `ERROR_CODES` and `ERROR_STATUS` directly, which means the
 * documentation cannot drift from the code that produces the errors — the
 * usual failure mode for a hand-maintained error table.
 *
 * ── Why the title is a sentence ────────────────────────────────────────────
 *
 * It used to be "Error reference", which is brand-free and therefore passed
 * every check, but which nobody types into a search box. The rule for every
 * other page here is that the title says what the page *does* rather than what
 * it is called, and this page already contained its own better title in the
 * `/llms.txt` entry pointing at it: every error code, its HTTP status, and
 * whether retrying helps. That is the whole page in one line, and it is the
 * line someone arriving from a `docs:` link in an error envelope is trying to
 * confirm they have reached.
 *
 * It deliberately does **not** say "x402 error code". These codes are this
 * service's, not the protocol's — `TURNSTILE_REQUIRED` and `NO_DATA` are ours —
 * and dressing them as protocol vocabulary would buy a search term with a false
 * claim.
 */

const PAGE_TITLE = "Every error code, its HTTP status, and whether retrying helps";

import { ERROR_STATUS, envelope, errorBody, html as htmlResponse, json, markdown } from "../http.js";
import { page, pageHead } from "../../ui/components/page.js";
import { resultCard } from "../../ui/components/result-card.js";
import { kvTable } from "../../ui/components/kv-table.js";
import { ERROR_CODES } from "../types.js";
import type { RouteContext, RouteHandler } from "../types.js";

const ROWS = ERROR_CODES.map((code) => {
  const { error } = errorBody(code);
  return { code, status: ERROR_STATUS[code], retryable: error.retryable, message: error.message };
});

const TWO_HUNDRED_NOTE =
  "CHALLENGE_MALFORMED, NOT_X402 and NO_DATA return HTTP 200 on purpose — an endpoint being broken is the answer you came for, not a failure on our side.";

export const errorsPage: RouteHandler = (ctx: RouteContext): Response => {
  const data = { errors: ROWS };

  if (ctx.format === "json") return json(envelope(ctx.route, data), {}, ctx);

  if (ctx.format === "markdown") {
    return markdown(
      [
        `# ${PAGE_TITLE}`,
        "",
        "Every failure from every route uses one envelope. `code` comes from a closed vocabulary: adding one",
        "is a spec amendment, so a client can switch on it safely.",
        "",
        "| Code | HTTP | Retryable | Message |",
        "| --- | --- | --- | --- |",
        ...ROWS.map((r) => `| \`${r.code}\` | ${r.status} | ${r.retryable ? "yes" : "no"} | ${r.message} |`),
        "",
        TWO_HUNDRED_NOTE,
      ].join("\n"),
      {},
      ctx,
    );
  }

  return htmlResponse(
    page({
      title: PAGE_TITLE,
      description: "Every error code this API can return, its HTTP status, and whether retrying can help.",
      path: "/errors",
      body:
        pageHead(
          PAGE_TITLE,
          "One envelope for every failure, from every route. The code vocabulary is closed, so a client can switch on it safely.",
        ) +
        resultCard({
          title: "Codes",
          body: kvTable(
            ROWS.map((r) => ({
              label: r.code,
              value: `${r.status}${r.retryable ? " · retryable" : ""}`,
              note: r.message,
            })),
            "Error codes",
          ),
          footer: TWO_HUNDRED_NOTE,
        }),
    }),
    {},
    ctx,
  );
};
