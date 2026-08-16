# Launch post

Announcement copy for `tools.tx402.io`. Every number below is traceable to
[`docs/cost-model.md`](./cost-model.md), and every risk-shaped sentence is written to the rule that
a band describes the confidence of our observations and never a merchant's character.

---

## Headline and one-liner

> **Tools for the x402 payment protocol — and the arithmetic that keeps them free**
>
> See what an x402 endpoint charges before you call it, verify a payment challenge before you sign
> it, and reconstruct a payment that failed. Free, no account, no API key — with the worst-case
> monthly bill published so "free" is a number you can check rather than a promise.

---

## The post

### See what an x402 endpoint charges before you call it

`tools.tx402.io` is live: six tools for the x402 payment protocol, free, no account, no API key.

- **[What does this endpoint charge?](https://tools.tx402.io/inspect)** — paste a URL, get price per
  request, token, network and payout address, decoded from the endpoint's own 402 challenge.
- **[Is this challenge well-formed, before I sign it?](https://tools.tx402.io/verify)** — strict
  decoding, canonical atomic amount, recognized network and asset, resource-origin match.
- **[What would my spend policy do with it?](https://tools.tx402.io/policy)** — run a policy against
  a real challenge and see which rule fires, in evaluation order.
- **[How has this endpoint's price moved?](https://tools.tx402.io/history)** — price, payout
  address, availability and latency over time, with every terms change dated.
- **[Which of these is cheapest?](https://tools.tx402.io/compare)** — endpoints side by side, in ten
  curated categories.
- **[This payment failed — what happened?](https://tools.tx402.io/replay)** — reconstruct the
  lifecycle, find the phase that broke, and learn whether retrying is safe or would pay twice.

### The verdict comes from the code that would refuse the payment

Challenge decoding and policy evaluation here are not a reimplementation. They import the published
[`tx402`](https://www.npmjs.com/package/tx402) buyer SDK and run `decodePaymentRequired` and
`PolicyEngine` — the exact functions the SDK runs before it signs anything.

So when the Inspector says a challenge is malformed, it is malformed *in the sense that matters*:
the decoder that would have refused the payment is the one that refused it here. A second parser
that agrees with the first one most of the time is a different and much weaker product, and the
difference only shows up on the challenges where it counts.

This is not a claim to be first. It is a claim about where the answer comes from.

### Free, and here is the arithmetic

"Free" from a service that fetches arbitrary URLs on demand is an unbounded-cost promise unless
something specific stops it. So the bound is published, per binding, with the multiplication shown:
**[docs/cost-model.md](https://github.com/neogeeks/tx402-tools/blob/main/docs/cost-model.md)**.

The short version:

| | worst case, per 31-day month |
| --- | --- |
| Outbound requests we make to other people's endpoints | **273,420** |
| Cost on Workers Paid | **$5.00** — the plan's base price, with no overage on any binding |

That worst case is not a forecast. It is the largest bill that is *reachable*: it assumes the
crawler spends its entire budget on every tick of every day, and that the public exhausts the daily
allowance every day, forever. Measured usage on 2026-08-15 was 334 crawler probes and 299 on-demand
scans — about **8% of the ceiling**.

The one number worth stating out loud rather than burying: **the daily ceiling is 5,000 on-demand
probes across the whole service.** Past it, cached results still serve, and a request for a fresh
probe returns `RATE_LIMITED`. That is the real limit on this service, it is global rather than
per-user, and it is checkable from outside:

```bash
curl -s https://tools.tx402.io/api/v1/health | jq .data.limits
```

The count comes from the same Durable Object that enforces it, so the number cannot drift from the
thing it describes.

The document is also honest about what is *not* bounded. Probes are bounded; **requests** are not,
because nothing inside a Cloudflare Worker can decline to be invoked — that needs a rule at the
edge, in front of the Worker. The cost model states that gap, and what it costs on each plan,
rather than leaving it for someone to find.

### One probe for two hundred people

The reason the ceiling can be that low without the tools feeling limited: probes are rate-limited
**per target**, not per caller. Two hundred people asking about the same endpoint at the same moment
produce one outbound request and 199 cached answers — measured, under real HTTP concurrency, not
asserted.

A cached answer says `cached: true` and gives its age rather than pretending to be live. This is
not only a cost control. A free tool that fetches whatever it is pointed at is a DDoS cannon aimed
at other people's paid APIs, and being one would end the project. The crawler publishes its budget,
identifies itself, honours `robots.txt`, and takes a one-click opt-out:
[tools.tx402.io/crawler](https://tools.tx402.io/crawler).

### What "bot protection" here does and does not mean

Turnstile is configured, and it covers the paste box's POST. It **deliberately does not cover
`GET /inspect?url=…`**, because that GET is what makes a result a shareable permalink, what makes
the Markdown mirror work, and what makes the page function with no JavaScript at all. Requiring a
token there would break all three to raise the cost of an attack the daily ceiling already bounds.

So Turnstile raises the cost of scripted browser abuse and does nothing about a script speaking HTTP
directly. The bound is the daily ceiling. Claiming more for it would be the kind of claim that stops
anyone looking for the real limit.

### It cannot pay, and it does not know who you are

**It cannot pay.** No signer, no key material, and no payment signature is constructed anywhere in
the repository. CI greps for the shape of all three and fails the build — the claim is enforced,
not asserted.

**Nobody is identified anywhere in this product.** No accounts, no sign-in, no cookies, no visitor
identifier, no IP address stored in any form. That is a property of the schema rather than a policy
someone has to remember: the migrations that dropped the person-shaped tables and columns are cited
by name on [tools.tx402.io/privacy](https://tools.tx402.io/privacy), and `migrations/` is the
complete list of tables that exist. There is no table in which a person could be stored.

### What a band means

Results carry a `LOW` / `MEDIUM` / `HIGH` band, and it means one specific thing: **how much of what
we check we were able to confirm.** It is a statement about the completeness of our observations,
not a judgement about the operator of an endpoint, and it must not be quoted as one.

Concretely:

- An endpoint nobody has probed before returns `NO_DATA`, not a low score. **Unknown is not bad.**
- Scores are only comparable within one `score_version`, which every response carries. Compare
  refuses to rank rows scored under different versions rather than ranking them wrongly.
- Every signal, every weight and every threshold is published at
  [tools.tx402.io/methodology](https://tools.tx402.io/methodology), and scoring is a versioned pure
  function in a public repository — not a model and not a judgement call.
- Operators can claim an endpoint, correct a fact we have observed, or opt out entirely.

The tools report what an endpoint's own challenge said and when its terms changed. They do not
characterize anyone's business.

### Agents are first-class readers

Every page serves three representations of one result — HTML, `Accept: application/json`, and
`Accept: text/markdown` — from the same path, with `Vary: Accept` and `Link: rel=alternate` for the
other two. The Markdown report is a rendering of the same JSON, so they cannot disagree.

```bash
curl -H 'Accept: text/markdown' 'https://tools.tx402.io/inspect?url=https://an.example/paid'
```

The index for agents is [tools.tx402.io/llms.txt](https://tools.tx402.io/llms.txt): the exact call
for each tool and what it returns. JSON Schemas for every response are at `/api/v1/schemas`, and
what this service charges is declared in the format a payment client already parses — an empty
`accepts` at `/.well-known/x402.json`, because it charges nothing.

### What is not shipped

- **The CLI and the MCP server are new.** `tx402-tools` and `tx402-tools-mcp` are published at
  0.1.0 — a first release, not a settled one.
- **The corpus is a few hundred endpoints**, not the whole ecosystem — the live count and the
  crawler's budget are both on [/crawler](https://tools.tx402.io/crawler). History and Compare are
  honest about gaps rather than filling them in.
- **The links from `tx402.io` and `docs.tx402.io` back to these tools do not exist yet.** The tools
  link out; the return path is not built.

Source, including the scoring function and every weight in it:
[github.com/neogeeks/tx402-tools](https://github.com/neogeeks/tx402-tools). Apache-2.0.

---

## Short forms

**One-sentence version:**

> `tools.tx402.io` — see what an x402 endpoint charges before you call it, verify a challenge before
> you sign it, and debug a payment that failed. Free, no account, and the worst-case monthly bill is
> published so you can check that "free" holds.

**For a developer audience that will check the claim:**

> We shipped free hosted tools for x402 and published the arithmetic instead of the adjective:
> worst case 273,420 outbound probes a month, $5.00 on Workers Paid with no overage on any binding,
> measured usage at 8% of the ceiling. The daily cap is 5,000 on-demand probes; past it you get
> cached results and `RATE_LIMITED`. The decoder is the published `tx402` SDK's own, so the verdict
> comes from the code that would refuse the payment.

---

## Copy that must not appear

An audit list, because an announcement is the most quotable surface the product has and a sentence
that escapes here is repeated by people who never read the methodology page.

| Never | Instead |
| --- | --- |
| "scam", "unsafe", "fraudulent", "risky endpoint" | "observed signals", "no history yet", "recipient changed on 2026-07-21" |
| "HIGH risk means avoid this endpoint" | "a band describes how much of what we check we could confirm" |
| "check whether an endpoint is safe" | "see what an endpoint charges, and what has changed" |
| "the site is bot-protected" | "Turnstile covers the paste box POST; the daily ceiling is the bound" |
| "the first x402 endpoint inspector", "the only one" | "the verdict comes from the code that would refuse the payment" |
| "free forever", "unlimited" | "free, with a 5,000/day on-demand ceiling and a published worst case" |
| "the CLI is battle-tested / stable" | "published at 0.1.0 — a first release, not a settled one" |
| "cross-linked with the docs and the SDK site" | "the tools link out; the return path is not built yet" |
