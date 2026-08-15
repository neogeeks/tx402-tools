# Crawler and abuse policy

**This is the contract our crawler implements.** It is written before the crawler exists so that 
builds against a stated policy rather than inventing one, and so that an endpoint operator reading this page
can hold us to something specific.

Rendered for humans at <https://tools.tx402.io/crawler>.

---

## What this service does

`tools.tx402.io` fetches x402 endpoints, reads the HTTP 402 payment challenge they serve, and stops. It
records what the endpoint charges, in which asset, on which network, and to whom — all of which is public
data the endpoint hands to anyone who asks for it.

## What it never does

- **It never pays.** No signer, no key, and no payment-signature header exists anywhere in this repository.
  This is enforced by a CI gate (`pnpm gate:no-signer`) that fails the build on the *shape* of key material
  or signature construction, not by a promise in a document.
- **It never sends credentials.** No cookies, no `Authorization`, no bearer tokens. A URL containing
  userinfo (`https://user:pass@host/`) is refused outright rather than having the credentials stripped.
- **It never follows a redirect into private address space,** and it never downgrades from `https` to
  `http` on a hop.
- **It never POSTs, PUTs, PATCHes or DELETEs.** The probe is a `GET`.
- **It never retries aggressively.** A failure is recorded as a failure.

## Identifying the crawler

```
User-Agent: tx402-tools-crawler/1.0 (+https://tools.tx402.io/crawler)
```

Every automated request carries it. Requests made because a human pasted a URL into the Inspector are not
crawler traffic and carry the ordinary Worker user agent, but they are subject to the same rate limits below.

## robots.txt

The crawler fetches and honours `robots.txt` for every origin before probing it, evaluated for the user agent
above and for `*`. A `Disallow` that covers the endpoint's path stops us probing it, and a `Crawl-delay` is
respected. `robots.txt` responses are cached with an expiry (see the `robots_cache` table) so that honouring
it does not itself become a second request per probe.

If `robots.txt` is unreachable, we treat the origin as **allowed** but subject to the same rate limits — the
usual convention. If it returns 401 or 403, we treat the origin as **disallowed**.

## Rate limits

- **One live probe per endpoint per politeness window,** regardless of how many people ask. Everyone else is
  served the cached result together with its age. This is the limit that matters: it is what stops a free
  URL-fetching service becoming a DDoS cannon aimed at somebody else's paid API.
- Per-caller limits on top of that, and Cloudflare Turnstile on the public paste box.
- The re-probe schedule for corpus endpoints is deliberately slow — a price does not change often enough to
  justify frequent polling.

## Opting out

Any of these works, and all of them are honoured **within one crawl cycle** — and immediately at read time,
so you do not have to wait for the next cycle to disappear from the site:

1. **`robots.txt`** — disallow `tx402-tools-crawler` or `*` for the paths in question.
2. **A well-known file** — serve `/.well-known/x402-tools-optout` with any content.
3. **The opt-out form** at <https://tools.tx402.io/crawler>, which asks you to prove control of the origin
   with a DNS TXT record or a well-known file.
4. **Email** <abuse@tx402.io> from an address at the domain.

Opting out removes the endpoint from the public corpus, stops all probing, and excludes it from History
and Compare. Records already written to the append-only change log are not deleted — that table is
append-only by database trigger, not by convention — but they stop being served.

## Claiming an endpoint, and appealing

Before a public risk score exists, you can already claim an endpoint and see exactly what has been observed
about it. If a recorded fact is wrong, you can appeal it. An upheld appeal appends a **correction** record
that points at the record it corrects; nothing is quietly rewritten, because a change log anyone can edit is
worth nothing to the operator it is being used against.

The language rules that follow from this are not stylistic. Every rendering of a verdict describes **what we
observed**, never what we believe about an operator: "the recipient address changed on 2026-07-21", not
"suspicious". The words *scam*, *fraud*, *fraudulent*, *unsafe*, *dangerous* and *malicious* do not appear in
any user-facing string in this product.

One specific case, because getting it wrong is how a tool like this earns a reputation for crying wolf:
**a per-request payout address is a legitimate x402 v2 feature.** An endpoint that declares a dynamic `payTo`
is a marketplace, not a rug, and a changing recipient can only ever count against a score when it is
*undeclared*.

## What we store, and what we do not

Stored: the endpoint URL, the challenge it served, when we saw it, and what changed since last time.

**Not stored, anywhere, in any form:** IP addresses (not even hashed), cookies, session identifiers, visitor
identifiers, or the user agent of anyone visiting this site. Rate-limit state lives in a Durable Object with
salted, coarse, short-lived keys and never reaches the database.

**Nobody is identified at all.** There is no account, no sign-in, no email address and no notification
destination anywhere in this product — and no table in which one could be stored. Accounts were designed for
one purpose, delivering alerts somebody had asked for, and were removed along with the alerting itself. That
makes this section a property of the schema rather than a policy anyone has to remember to follow.

## Contact

- Abuse and opt-out: <abuse@tx402.io>
- Security: <security@tx402.io> (see [SECURITY.md](./SECURITY.md))
