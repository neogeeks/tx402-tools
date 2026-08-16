# The inbound cross-links, ready to paste

This repository links **out** to `tx402.io` and `docs.tx402.io` from every page. Nothing links
**in**. This file is the other half, written out so that whoever owns those two repositories can
paste it rather than re-derive it.

**Status, verified 2026-08-15:**

```
https://docs.tx402.io/                                 0 links to tools.tx402.io
https://docs.tx402.io/guides/lifecycle/                0
https://docs.tx402.io/guides/policy/                   0
https://docs.tx402.io/reference/errors/                0
https://docs.tx402.io/guides/cli/                      0
https://docs.tx402.io/operations/recipient-rotation/   0
https://docs.tx402.io/llms.txt                         0
https://tx402.io/                                      0
https://tx402.io/llms.txt                              0
```

Zero, everywhere. **Until these land, the cross-linking is done in one direction and must not be
described as done** — including in launch copy, where it is the easiest sentence in the world to
write in the past tense.

---

## The rule these links follow

Two constraints, and they are the reason this is a table of specific pages rather than "add a link
to the tools":

**Deep page to deep page.** A link to `tools.tx402.io` from the docs home page transfers authority
to a home page and makes the reader run their search a second time. Every row below points at the
one tool that answers the question the source page just raised.

**The reader arrived on a symptom, not on a brand.** Somebody reading the error taxonomy has a
failed payment in front of them. The anchor text is therefore what they would have typed, not the
product's name — the brand converts at the destination, which is where it belongs.

---

## The links

| Source page | Where it goes | Anchor text | Target |
| --- | --- | --- | --- |
| `docs.tx402.io/guides/lifecycle/` | After the decode step, where the challenge has just been parsed | See what an endpoint charges before you call it | `https://tools.tx402.io/inspect` |
| `docs.tx402.io/guides/policy/` | After the first worked policy example | Try a policy against a real challenge and see which rule fires | `https://tools.tx402.io/policy` |
| `docs.tx402.io/reference/errors/` | Intro paragraph, above the taxonomy table | Work out which phase a failed payment stopped in, and whether retrying is safe | `https://tools.tx402.io/replay` |
| `docs.tx402.io/operations/recipient-rotation/` | Where pinning a payout address is introduced | Check when an endpoint's payout address last changed | `https://tools.tx402.io/history` |
| `docs.tx402.io/start/quickstart/` | Just before the first paid call | Check what an endpoint charges before you point the SDK at it | `https://tools.tx402.io/inspect` |
| `docs.tx402.io/guides/cli/` | Near `tx402 call --dry-run` | The same evaluation in a browser, with the rules shown in order | `https://tools.tx402.io/policy` |
| `tx402.io` | Primary nav, and the footer | Tools | `https://tools.tx402.io` |

Seven links. If only one lands, make it the error-taxonomy row: it is the page with a reader who is
already stuck, which is the highest-intent moment in the whole funnel.

---

## Paste-ready — docs.tx402.io

Markdown, matching the callout style already used in those pages. Adjust the syntax if the site
uses a component for asides; the copy is the part that matters.

**`guides/lifecycle.md`** — after the decode step:

```markdown
> Working with a specific endpoint? [See what it charges before you call it](https://tools.tx402.io/inspect)
> — the Inspector decodes the challenge with `decodePaymentRequired`, the same function this step
> just described, so what it reports is what the SDK would do with it.
```

**`guides/policy.md`** — after the first policy example:

```markdown
> [Try a policy against a real challenge](https://tools.tx402.io/policy) in the browser. It runs the
> `PolicyEngine` from this package server-side and shows which rule fires, in evaluation order, with
> the typed error your own code would raise.
```

**`reference/errors.md`** — in the intro, above the table:

```markdown
> Holding a trace of a payment that failed?
> [Work out which phase it stopped in, and whether retrying is safe](https://tools.tx402.io/replay).
> The trace stays on your machine; sharing a redacted one is a separate, explicit step.
```

**`operations/recipient-rotation.md`** — where pinning is introduced:

```markdown
> [Check when an endpoint's payout address last changed](https://tools.tx402.io/history) — every
> observed terms change is dated, so a rotation you did not expect is visible before you pin to it.
```

**`start/quickstart.md`** — before the first paid call:

```markdown
> Before you point the SDK at an endpoint,
> [check what it charges](https://tools.tx402.io/inspect): price per request, token, network and
> payout address.
```

**`guides/cli.md`** — near `tx402 call --dry-run`:

```markdown
> The same evaluation in a browser, with the rules shown in order:
> [the policy playground](https://tools.tx402.io/policy).
```

**`docs.tx402.io/llms.txt`** — a new section, in the file's existing `- [Name](url): what it is`
shape. It belongs after **Source and packages**:

```markdown
## Hosted tools
- [tools.tx402.io](https://tools.tx402.io): hosted utilities for x402 endpoints — inspect what one charges, verify a challenge before signing, run a spend policy against it, and reconstruct a failed payment. Free, no account, and every page answers `Accept: application/json` and `Accept: text/markdown`. Operates independently of this SDK: the SDK never contacts it.
- [Agent index for those tools](https://tools.tx402.io/llms.txt): the exact call for each one, and what it returns.
```

That last pair matters more than it looks. An agent reading `docs.tx402.io/llms.txt` today has no
way to discover the tools at all, and an agent is the reader most likely to be about to pay
something.

---

## Paste-ready — tx402.io

Nav and footer, wherever the existing links live:

```html
<a href="https://tools.tx402.io">Tools</a>
```

**`tx402.io/llms.txt`** — same shape as above:

```markdown
## Hosted tools
- [tools.tx402.io](https://tools.tx402.io): hosted utilities for x402 endpoints — inspect what one charges, verify a challenge before signing, run a spend policy against it, and reconstruct a failed payment. Free, no account. The SDK never contacts it.
```

---

## One sentence that has to survive editing

Every row above may be reworded freely except for this constraint: **nothing in that copy may
describe an endpoint or its operator.** The tools report observations — what a challenge said, when
terms changed, how much of what we check we could confirm — and a `LOW` / `MEDIUM` / `HIGH` band is
about the confidence of those observations, never about a merchant's character. Copy that says
"check whether an endpoint is safe" or "spot a scam endpoint" would make a claim the product
deliberately does not make, on a property with more authority than the one making it.

The methodology, every weight in it, and the appeal route are at
[`tools.tx402.io/methodology`](https://tools.tx402.io/methodology).

---

## Verifying it landed

```bash
for u in https://docs.tx402.io/ https://docs.tx402.io/guides/lifecycle/ \
         https://docs.tx402.io/guides/policy/ https://docs.tx402.io/reference/errors/ \
         https://docs.tx402.io/llms.txt https://tx402.io/ https://tx402.io/llms.txt; do
  printf '%-50s %s\n' "$u" "$(curl -s "$u" | grep -c 'tools.tx402.io')"
done
```

Every line reading `0` is a link that has not landed yet.
