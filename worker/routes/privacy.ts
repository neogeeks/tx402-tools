/**
 * GET /privacy.
 *
 * `docs/abuse-policy.md` has always been the contract for endpoint OPERATORS —
 * what the crawler does to their servers and how to make it stop. This is the
 * other half, for the people who use the site, and it did not exist: there was
 * no privacy policy anywhere in this product while §6.3 already had real
 * content to state.
 *
 * ── One source, two renderings ─────────────────────────────────────────────
 *
 * The sections are a data structure, and the HTML and Markdown views are both
 * functions of it. That is the same discipline SPEC §1.2 imposes on every tool
 * page and it matters more here than anywhere: a privacy policy that says one
 * thing to a browser and another to `curl` is not a policy, it is two.
 *
 * `docs/privacy.md` is the long form, with the file and migration references
 * that make each claim checkable. This page is the same claims in the order a
 * person asks them, and links there rather than restating the detail — one
 * document to keep true, not two that can drift.
 *
 * ── Three representations, but no `/api/v1` mirror ────────────────────────
 *
 * SPEC §1.2 applies here as everywhere: ask for JSON and you get JSON. What
 * this page does NOT have is a mirror at `/api/v1/privacy`, because it is a
 * document rather than a view over data — so `worker/http.ts` advertises one
 * alternate rather than a fabricated second one that 404s. Those are different
 * claims and conflating them is how six routes ended up advertising a JSON
 * alternate that did not exist.
 */

import { envelope, json, markdown, html as htmlResponse } from "../http.js";
import { page, pageHead } from "../../ui/components/page.js";
import { kvTable } from "../../ui/components/kv-table.js";
import type { RouteContext, RouteHandler } from "../types.js";

const TITLE = "What this site knows about you, and why the answer is nothing";
const SUMMARY =
  "No accounts, no cookies, no visitor identifier, and no IP address stored anywhere in any form — " +
  "not because we promise to delete them, but because there is no table in this database in which a " +
  "person could be stored.";

const DOCS = "https://github.com/neogeeks/tx402-tools/blob/main/docs/privacy.md";

interface Section {
  heading: string;
  paragraphs: string[];
  /** Rendered as a list in HTML and Markdown alike. */
  points?: string[];
}

/**
 * The policy.
 *
 * Every claim here is a statement about a MECHANISM, not about an intention.
 * "We do not store your email address" is a promise somebody has to remember to
 * keep; "there is no column in which one could be stored" is a property of the
 * schema, and it is the second kind this page tries to make everywhere it can.
 */
const SECTIONS: Section[] = [
  {
    heading: "No accounts, and no table to hold one",
    paragraphs: [
      "There is no sign-in on this site. No email address, no password, no OAuth, no API key, no session, and no notification destination.",
      "This is not a feature we have not got to. Accounts were designed and then removed: they existed for exactly one purpose — delivering an alert somebody had asked for — and when that feature was cut, an account would have been a person's identity stored for nothing. Two migrations dropped the tables and then the last two person-shaped columns anywhere in the schema.",
      "The difference matters. “We do not store your email address” is a promise somebody has to remember to keep. There is no column in this database in which an email address could be stored, and the next person who wants one has to write the migration and make the argument in public.",
    ],
  },
  {
    heading: "No cookies, and no visitor identifier",
    paragraphs: [
      "This site sets no cookies. Not a session cookie, not a preference cookie, not an analytics cookie. There is no consent banner because there is nothing to consent to.",
      "There is no visitor identifier of any other kind either: no localStorage fingerprint, no device identifier, no tracking pixel, no third-party analytics script. Nothing on any page loads from another domain, except the Turnstile widget on the paste box.",
    ],
  },
  {
    heading: "No IP addresses",
    paragraphs: [
      "No IP address is stored anywhere in this product, in any form, including hashed. Not in the database, not in a log we keep, not in any response.",
      "Rate limiting genuinely needs to tell callers apart, and that is the only place an address is used at all. It is turned into a short-lived token and then discarded:",
    ],
    points: [
      "<strong>Salted</strong> with a secret generated in memory when a Worker starts — never written down, never logged, never transmitted, and gone when that Worker is. So the token cannot be reversed by hashing the whole address space and matching.",
      "<strong>Time-bucketed</strong>, so the same address produces a different token in the next window. Correlating one caller across windows is not possible for us either.",
      "<strong>Truncated</strong> to 12 characters — enough to separate callers within one window, too coarse to be an identifier.",
      "<strong>Expiring</strong>: the token lives in a Durable Object, is deleted by an alarm when its window closes, and never reaches the database.",
    ],
  },
  {
    heading: "What we do store",
    paragraphs: [
      "The endpoint, and what it served: a URL, the HTTP 402 payment challenge behind it, when we observed it, and what changed since last time. All of it is public data the endpoint hands to anyone who asks, and none of it describes the person who asked.",
      "A scan records whether it came from a person, an API caller or the crawler. That is which kind of surface it arrived through, not who arrived — and there is no table beside it that a person could be joined to.",
    ],
  },
  {
    heading: "Share links and replay traces",
    paragraphs: [
      "A share link stores a snapshot of a scan so a result can be sent to somebody without re-probing the endpoint. Its identifier is 128 random bits, it is excluded from the sitemap and from robots.txt, it expires after 90 days with the date shown on the page, and it can be revoked. It contains what the endpoint served and nothing about whoever made it.",
      "A replay trace can contain secrets, so redaction happens in your browser before anything is uploaded, using the same redactor the SDK uses on its own diagnostic stream. Sharing is opt-in per trace: if you do not share it, it never leaves your machine. The command-line tool and the MCP server go further — the offline verifier makes zero network calls, and a test asserts it.",
    ],
  },
  {
    heading: "Analytics, and Turnstile",
    paragraphs: [
      "Availability and latency go to Cloudflare Workers Analytics Engine, which is sampled and kept for three months. What is written is a probe outcome — an endpoint, a host, a status, a latency. There is no visitor in it because there is no visitor identifier to put in it, and we only ever read it as an aggregate.",
      "The paste box carries a Cloudflare Turnstile widget, which tells a person from a script without a CAPTCHA and without a cookie. We receive one thing from it: a yes or a no. We do not log or store the token, and there is nothing in the exchange we could tie to you afterwards. It appears only where somebody submits a URL for us to fetch — reading any page here involves no Turnstile at all.",
    ],
  },
  {
    heading: "The infrastructure layer, stated honestly",
    paragraphs: [
      "This site runs on Cloudflare, and Cloudflare's edge — like every CDN — processes request metadata including your IP address in order to route and serve the request. We do not enable Cloudflare Web Analytics or any other visitor-analytics product on this zone, and nothing from that layer is retained by, exposed to or queryable by this application.",
      "We say this rather than claiming an absolute, because “no IP address anywhere” would be untrue at the network layer for any website on any host, and a policy that overclaims is worth less than one that draws the line where it actually is. The line is that nothing about you crosses from the network layer into this application.",
    ],
  },
  {
    heading: "Your rights, and the honest limit on them",
    paragraphs: [
      "There is no data about you here to access, correct, export or delete, so there is no request to make and nobody to make it to. That is the intended outcome rather than an evasion: the deletion story for data that was never collected is the only one this product can offer completely. There is also no way to authenticate such a request, because there is no sign-in — and building one would mean collecting an identity in order to service requests about the identity we collected.",
      "If you operate an endpoint we have observed, that is a different and real thing with its own process: claim it by proving control of the origin with a DNS TXT record or a well-known file, see exactly what has been recorded, correct a wrong fact, or opt out entirely. The proof is control of the domain, never an identity we hold about you.",
    ],
  },
];

/** Every claim above, restated as something a reader can go and check. */
const CHECKS: { label: string; value: string }[] = [
  { label: "Cookies set", value: "none — open devtools and look" },
  { label: "Third-party requests", value: "Turnstile on the paste box, and nothing else" },
  { label: "IP addresses stored", value: "none, in any form, including hashed" },
  { label: "Accounts", value: "none, and no table that could hold one" },
  { label: "Share link lifetime", value: "90 days, revocable, unguessable" },
  { label: "Analytics retention", value: "3 months, sampled, no visitor in it" },
  { label: "The code", value: "public, with the full history" },
];

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, "");
}

export const privacy: RouteHandler = (ctx: RouteContext): Response => {
  if (ctx.format === "json") {
    return json(
      envelope(ctx.route, {
        // The negative claims first, because they are the policy and the prose
        // is the explanation. An agent that reads only this object should come
        // away with the same answer a person reading the page does.
        stores: {
          ip_addresses: false,
          hashed_ip_addresses: false,
          cookies: false,
          visitor_identifiers: false,
          user_agents: false,
          accounts: false,
          email_addresses: false,
        },
        accounts: {
          sign_in: false,
          // Not "we deleted them" — there is nowhere left to put one.
          schema_can_store_a_person: false,
          removed_by: ["migrations/0003_drop_accounts.sql", "migrations/0004_claims_no_people.sql"],
        },
        rate_limit_state: {
          keyed_by: "salted, time-bucketed, truncated digest of the caller address",
          salt: "generated in memory per Worker isolate; never stored, logged or transmitted",
          reaches_database: false,
          expires: "with its window, by Durable Object alarm",
        },
        share_links: { id_bits: 128, expires_days: 90, revocable: true, indexed: false },
        analytics: {
          product: "Cloudflare Workers Analytics Engine",
          sampled: true,
          retention_months: 3,
          contains_visitor_data: false,
        },
        turnstile: {
          where: "the paste box only",
          received_from_it: "a yes or a no",
          token_stored: false,
        },
        third_party_requests: ["Cloudflare Turnstile, on the paste box"],
        operator_rights: {
          claim: "prove control of the origin by DNS TXT or a well-known file",
          correct: "appeal a recorded fact; corrections append, nothing is rewritten",
          opt_out: "https://tools.tx402.io/crawler",
        },
        policy_url: DOCS,
        contact: { privacy: "security@tx402.io", abuse: "abuse@tx402.io" },
        last_updated: "2026-08-15",
      }),
      {},
      ctx,
    );
  }

  if (ctx.format === "markdown") {
    return markdown(
      [
        `# ${TITLE}`,
        "",
        SUMMARY,
        "",
        ...SECTIONS.flatMap((section) => [
          `## ${section.heading}`,
          "",
          ...section.paragraphs.flatMap((p) => [stripTags(p), ""]),
          ...(section.points ?? []).map((point) => `- ${stripTags(point)}`),
          ...(section.points ? [""] : []),
        ]),
        "## Checking any of this",
        "",
        ...CHECKS.map((check) => `- **${check.label}**: ${check.value}`),
        "",
        `The long form, with the file and migration references behind each claim, is at ${DOCS}.`,
        "",
        "## Contact",
        "",
        "- Privacy questions: security@tx402.io",
        "- Endpoint opt-out and abuse: abuse@tx402.io",
        "",
        "Last updated 2026-08-15.",
      ].join("\n"),
      {},
      ctx,
    );
  }

  const body = [
    pageHead(TITLE, SUMMARY),
    ...SECTIONS.flatMap((section) => [
      `<h2>${section.heading}</h2>`,
      ...section.paragraphs.map((p) => `<p>${p}</p>`),
      ...(section.points ? [`<ul>${section.points.map((p) => `<li>${p}</li>`).join("")}</ul>`] : []),
    ]),
    `<h2>Checking any of this</h2>`,
    `<p>None of the above is meant to be believed. The two biggest claims on this page take about ten seconds to check in your browser's devtools.</p>`,
    kvTable(CHECKS, "What to check"),
    `<p>The long form — with the source file and migration behind each claim — is in <a href="${DOCS}">docs/privacy.md</a>. If you operate an endpoint we have observed, <a href="/crawler">the crawler page</a> is where you claim it, correct it or opt out.</p>`,
    `<h2>Changes and contact</h2>`,
    `<p>This policy changes in the same commit as the change it describes, in a public repository with a full history. There is no mailing list to notify because there is no mailing list.</p>`,
    `<ul>`,
    `<li>Privacy questions: <a href="mailto:security@tx402.io">security@tx402.io</a></li>`,
    `<li>Endpoint opt-out and abuse: <a href="mailto:abuse@tx402.io">abuse@tx402.io</a></li>`,
    `</ul>`,
    `<p class="hint">Last updated 2026-08-15.</p>`,
  ].join("\n");

  return htmlResponse(
    page({ title: TITLE, description: SUMMARY, path: ctx.url.pathname, body }),
    {},
    ctx,
  );
};
