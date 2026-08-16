# The inbound cross-links: written, committed, not deployed

This repository links **out** to `tx402.io` and `docs.tx402.io` from every page. The inbound half —
the links back to these tools — turned out to be **already written and committed in both sibling
repositories**, and live on neither, because neither site has been deployed since the commits
landed.

That distinction matters. This file used to say the links did not exist, which was wrong about the
cause: a live grep returns zero because the sites are stale, not because nobody wrote them.

---

## Where each one lives

**`tx402-landing` — done, commit `f869461`** ("Link out to tools.tx402.io from the nav and the home
page"). Seven links in `public/index.html`:

- primary nav → `tools.tx402.io`
- mobile nav → `tools.tx402.io`
- a home-page paragraph with four deep links: `/inspect`, `/verify`, `/policy`, `/compare`

**The docs — done, commit `b49d0f3`** ("link out to the hosted x402 tools from the three pages that
earn it"), plus a `tools.tx402.io` entry in `docs/public/llms.txt`:

| Page | Links to |
| --- | --- |
| `guides/lifecycle` | `/inspect` |
| `guides/policy` | `/policy` |
| `reference/errors` | `/replay` |

Three more were added on top (`start/quickstart` → `/inspect`, `guides/cli` → `/policy`,
`operations/recipient-rotation` → `/history`), bringing it to six pages.

---

## The thing that is actually blocking

**Neither site has been deployed.** Verified 2026-08-16:

```
https://tx402.io/                                      0 links to tools.tx402.io
https://docs.tx402.io/guides/lifecycle/                0
https://docs.tx402.io/guides/policy/                   0
https://docs.tx402.io/reference/errors/                0
https://docs.tx402.io/llms.txt                         0
```

Two deploys close this. Nothing needs writing.

---

## A second finding, worth more than the links

**`docs.tx402.io` is built from the `tx402-dev` checkout, not from `neogeeks/tx402`.** Four pages
that exist only in `tx402-dev` answer 200 in production:

```
/guides/migration/                 200
/operations/kill-switch/           200
/operations/shared-store/          200
/operations/recipient-rotation/    200
```

`neogeeks/tx402`'s `docs/` was a strict subset — eight pages missing, twenty files behind, including
the sidebar config and an `llms.txt` still describing 0.1-era policy. A sync PR brings it level.
**Which of the two repositories is meant to be authoritative for the docs is an open question**, and
the sync assumes the live site is correct.

---

## Verifying the deploys landed

```bash
for u in https://tx402.io/ https://docs.tx402.io/guides/lifecycle/ \
         https://docs.tx402.io/guides/policy/ https://docs.tx402.io/reference/errors/ \
         https://docs.tx402.io/start/quickstart/ https://docs.tx402.io/guides/cli/ \
         https://docs.tx402.io/operations/recipient-rotation/ https://docs.tx402.io/llms.txt; do
  printf '%-52s %s\n' "$u" "$(curl -s "$u" | grep -c 'tools.tx402.io')"
done
```

Every line reading `0` is a page whose deploy has not landed.

---

## One constraint on any future edit to that copy

Nothing in it may describe an endpoint or its operator. The tools report observations — what a
challenge said, when terms changed, how much of what we check we could confirm — and a
`LOW` / `MEDIUM` / `HIGH` band is about the confidence of those observations, never about a
merchant's character. Copy saying "check whether an endpoint is safe" or "spot a scam endpoint"
would make a claim the product deliberately does not make, on properties with more authority than
the one making it.

Methodology, every weight, and the appeal route:
[`tools.tx402.io/methodology`](https://tools.tx402.io/methodology).
