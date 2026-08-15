# Privacy

**We do not know who you are, and we have not built anywhere to put the answer.**

That is the whole policy. Everything below is the detail behind it, written so that each claim
points at the mechanism that makes it true rather than at a promise to behave.

Rendered for humans at <https://tools.tx402.io/privacy>.

---

## No accounts, and no table to hold one

There is no sign-in on this site. There is no email address, no password, no OAuth, no API key, no
session and no notification destination.

This is not a feature we have not got to. Accounts were designed, and then removed: they existed
for exactly one purpose — delivering an alert somebody had asked for — and when that feature was
cut, an account would have been a person's identity stored for nothing. So
`migrations/0003_drop_accounts.sql` dropped `accounts`, `auth_tokens`, `channels`, `watches` and
`alerts`, and `migrations/0004_claims_no_people.sql` removed the last two person-shaped columns
anywhere in the schema — a `contact_email` on the claim flow and a dangling `account_id` beside it.

The difference matters. "We do not store your email address" is a promise somebody has to remember
to keep. **There is no column in this database in which an email address could be stored** is a
property of the schema, and the next person to want one has to write the migration and make the
argument in public.

## No cookies, and no visitor identifier

This site sets no cookies. Not a session cookie, not a preference cookie, not an analytics cookie.
There is no consent banner because there is nothing to consent to.

There is also no visitor identifier of any other kind: no `localStorage` fingerprint, no device
identifier, no tracking pixel, and no third-party analytics script. Nothing on any page loads from
a domain other than this one, except the Cloudflare Turnstile widget described below — which
appears only on the paste box.

## No IP addresses

**No IP address is stored anywhere in this product, in any form, including hashed.** Not in the
database, not in a log we keep, not in any response.

Rate limiting genuinely needs to tell callers apart, and that is the one place an address is used
at all. It is turned into a short-lived token and then discarded:

- **Salted.** The digest is taken over a secret salt, so it cannot be reversed by hashing the whole
  IPv4 space and matching. The salt is generated in memory when a Worker isolate starts, is never
  written down, never logged, never transmitted, and dies with the isolate.
- **Time-bucketed.** The bucket is part of the input, so the same address produces a different token
  in the next window. Correlating one caller across windows is not possible *for us*, which is what
  makes "short-lived" a property of the construction rather than a retention promise.
- **Truncated** to 12 hexadecimal characters — enough to separate callers within one window, too
  coarse to be an identifier.

The token lives in a Durable Object, expires with its window on an alarm, and never reaches D1. The
address itself exists only as an input to that digest and is never assigned to a variable that
outlives the request. See `callerKey` in `worker/lib/politeness.ts` and the alarm in
`worker/do/probe-limiter.ts`.

One consequence, stated because it is the sort of thing that reads as a bug: the salt being
per-isolate means the per-caller budget is per-isolate too, and resets when a request lands on a
cold isolate. That is a deliberate trade — a stored salt would be a stored key to everyone's
address — and the limit that actually bounds abuse is the per-target politeness window and the
whole-service daily ceiling, both of which are global by construction. The arithmetic is in
[docs/cost-model.md](./cost-model.md).

## What we do store

**The endpoint, and what it served.** A URL, the HTTP 402 payment challenge behind it, when we
observed it, and what changed since last time. All of that is public data the endpoint hands to
anyone who asks for it, and none of it describes the person who asked.

Scans record a `source` of `human`, `api` or `crawler` — which kind of surface a scan came through,
not who came through it. There is no column beside it that could be joined to a person, because
there is no table of people.

## What we deliberately do not record

`docs/abuse-policy.md` is the crawler-facing version of this list; this is the visitor-facing one.

- The IP address of anybody who visits this site, or of anybody whose endpoint we probe.
- The user agent of anybody who visits this site.
- Any header from your request. The probe builds its outbound request from scratch on every hop
  precisely so that nothing of yours can be forwarded by accident — there is no `Authorization`, no
  `Cookie` and no credential to leak because none was ever copied in.
- Referrer, screen size, language, timezone, or anything else a page could ask a browser for.

## Share links

A share link stores a **snapshot of a scan** — the same report the tool computed, frozen — so that a
result can be sent to someone else without re-probing the endpoint.

- The identifier is **128 random bits** rendered as 26 characters. It is not guessable and not
  enumerable, and it is the only way to reach the snapshot: share links are not listed anywhere, not
  in the sitemap, and `robots.txt` excludes them.
- They **expire after 90 days**, and the page says the expiry date on it.
- They can be revoked.
- The snapshot is produced by the same code path as a live scan rather than accepted from a caller,
  so a share link cannot be made to claim something we never observed.
- It contains what the endpoint served. It does not contain anything about whoever created it,
  because nothing about them was collected.

## Replay traces

The Replay tool reconstructs a payment lifecycle from a trace, and **a trace can contain secrets** —
that is the nature of the thing.

So redaction happens **client-side, before anything is uploaded**, using the same redactor the SDK
uses to keep secrets out of its own diagnostic stream. Sharing a trace is opt-in per trace. If you
do not share it, it does not leave your machine.

The local CLI (`tx402-tools`) and the MCP server (`tx402-tools-mcp`) go further: the offline
verifier makes **zero network calls**, and there is a test that asserts it.

## Analytics

Availability and latency go to Cloudflare Workers Analytics Engine, which is **sampled** and
retained for **three months**. What is written is a probe outcome: an endpoint identifier, a host, a
status, a latency. There is no visitor in it, because there is no visitor identifier to put in it.

We only ever read it as an aggregate — "availability 30d", "p50 latency". That is exactly what
sampled, retention-bounded storage is good for, and it is why anything that has to be *exact and
permanent* — a price change, a recipient change — goes to D1 instead and is never derived from
analytics.

## Cloudflare Turnstile

The paste box carries a Cloudflare Turnstile widget, which distinguishes a person from a script
without a CAPTCHA and without a cookie. It is the one third-party resource on this site.

Turnstile is processed by Cloudflare under
[their privacy policy](https://www.cloudflare.com/privacypolicy/); Cloudflare states that it does
not use it to collect personally identifiable information about visitors and does not use the data
for behavioural advertising. We receive one thing from it: a yes or a no. We do not receive, log or
store the token, and there is nothing in the exchange we could tie to you afterwards even if we
wanted to.

It appears only where a person submits a URL for us to fetch. Reading any page of this site involves
no Turnstile at all.

## The infrastructure layer

This site runs on Cloudflare, and Cloudflare's edge — like every CDN — processes request metadata
including your IP address in order to route and serve the request, under
[their privacy policy](https://www.cloudflare.com/privacypolicy/). We do not enable Cloudflare Web
Analytics or any other visitor-analytics product on this zone, and nothing from that layer is
retained by, exposed to, or queryable by this application.

We say this rather than claiming an absolute, because "no IP address anywhere" would be untrue at
the network layer for any website on any host, and a privacy policy that overclaims is worth less
than one that draws the line where it actually is. **The line is: nothing about you crosses from
the network layer into this application.**

## Your rights, and the honest limit on them

There is no data about you here to access, correct, export or delete, so there is no request to
make and nobody to make it to. That is the intended outcome rather than an evasion — the deletion
story for data that was never collected is the only one this product can offer completely.

There is also no way for us to authenticate such a request even if there were something to act on,
because there is no sign-in. Building one would mean collecting an identity in order to service
requests about the identity we collected.

**If you operate an endpoint we have observed**, that is a different and real thing, and it has its
own process: you can claim it by proving control of the origin with a DNS TXT record or a
well-known file, see exactly what has been recorded, correct a wrong fact, and opt out entirely.
The proof is control of the domain, not an identity we hold about you. See
[docs/abuse-policy.md](./abuse-policy.md) and <https://tools.tx402.io/crawler>.

## Checking any of this

The claims here are meant to be verifiable rather than believed:

- **The code is public.** `worker/lib/politeness.ts` is the caller-key derivation,
  `worker/do/probe-limiter.ts` is where rate-limit state lives and expires, and
  `migrations/0003_drop_accounts.sql` and `0004_claims_no_people.sql` are where the tables that
  could have held a person were removed.
- **The schema has no person in it.** `migrations/` is the complete list of tables that exist.
- **`/api/v1/health`** reports the limits actually in force, including whether Turnstile is
  configured.
- **Open your browser's devtools** on any page here and look at the cookie jar and the network
  panel. That is the fastest check of the two biggest claims on this page.

## Changes and contact

This policy changes when the product does, in the same commit as the change it describes, in a
public repository with a full history. There is no mailing list to notify because there is no
mailing list.

- Privacy questions: <security@tx402.io>
- Endpoint opt-out and abuse: <abuse@tx402.io>
- Security disclosure: [SECURITY.md](../SECURITY.md)

*Last updated 2026-08-15.*
