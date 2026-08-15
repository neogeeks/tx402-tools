# How the risk score works

> **This is the source of truth for `score_version: "v1"`.** `worker/lib/score.ts` implements it and
> `/methodology` renders it. The requirement is a test that this page and `score` agree exactly, so
> if they ever disagree, **this document is right and the code is the bug**.
>
> Written, 2026-08-14. Every weight and threshold below is published *before* any endpoint is scored
> against it.

---

## What the score is, in one sentence

**The share of the things we could check that checked out.**

Higher is better. `100` means every check we were able to run passed. It is arithmetic over a fixed table of
signals, not a model, not a heuristic and not an opinion.

## What the score is not

**A band is a statement about our observations. It is never a statement about an operator.**

`LOW`, `MEDIUM` and `HIGH` describe the level of caution *our observations* support — nothing about the
honesty, intent or competence of whoever runs the endpoint. A `HIGH` band most often means we could not
verify much, or that an endpoint has an interoperability bug. It does not mean anyone is doing anything
wrong, and we do not have the evidence to say that even if we wanted to.

Concretely, and enforced by a test:

- The words **scam**, **fraud**, **fraudulent**, **unsafe**, **dangerous** and **malicious** appear in no
  score output, in any language, ever.
- Every surface that renders a band carries this note above the fold.
- Every score is reproducible from the signals in the same response — see [Appeals](#appeals).

---

## The two rules that keep it from crying wolf

### 1. Unknown is not bad

A signal we could not observe is recorded as `observed: false, value: null` and is **excluded from both sides
of the ratio**. It does not reduce the score; it reduces the *coverage*.

This matters because the alternative — treating unknown as a failure — makes every brand-new endpoint look
suspicious. Most endpoints anyone pastes into the Inspector will be ones we have never seen. If newness read
as risk, the tool would be wrong about the majority of its inputs.

### 2. A marketplace is not a rug

Dynamic `payTo` — a different payout address per request — is a **first-class x402 v2 feature** built for
marketplaces and multi-tenant APIs. A naive "the recipient changed, therefore danger" rule would flag every
legitimate marketplace in the ecosystem.

So the only recipient-instability signal that may **ever** count against a score is:

```
recipient_unstable_undeclared = (recipient changed across scans) AND NOT pay_to_declared_dynamic
```

A bare "recipient changed" signal is **forbidden in every version** of the scoring function. This is enforced
in code (`assertNoBareRecipientSignal`), not just written down, so a future version cannot reintroduce it by
accident.

**In v1 no recipient-instability signal is scored at all.** It needs history, and history arrives with the
corpus. See [Known limitations](#known-limitations) — there is a real problem waiting there, and it is
better stated than buried.

---

## The signals and their weights

Thirteen signals are scored in v1. All are **static**: every one comes from a single probe, which is why a
score is available on an endpoint's first-ever scan.

| Signal | Weight | Severity | Passes when | Why it is worth this much |
| --- | ---: | --- | --- | --- |
| `challenge_decodes` | **25** | fail | The strict x402 decoder accepts the challenge | The single most load-bearing fact available. This is the same `decodePaymentRequired` the tx402 SDK runs *before it will pay*, so a failure here means a tx402 buyer cannot transact with this endpoint at all. Nothing else we check outranks "it does not work". |
| `resource_origin_match` | **15** | fail | The challenge's `resource` origin equals the probed origin | A 402 describing somebody else's resource is the shape of a payment-redirection bug: you ask A for a price and are handed B's invoice. Highest-severity thing we can see in a single observation. |
| `amount_canonical` | **12** | fail | The amount is a canonical atomic integer (SPEC §1.4) | `"0.01"` where atomic units are required is the most common real x402 mistake, and its failure mode is paying the wrong amount by orders of magnitude. |
| `pay_to_wellformed` | **12** | fail | The recipient is a valid address for the chain family | Money sent to a malformed address. Weighted equal to the amount because the consequence is the same size. |
| `network_recognized` | **8** | warn | The network is in the tx402 signed release manifest | `warn`, not `fail`: an unrecognized network may simply be newer than our manifest. Real information, weaker claim. |
| `asset_recognized` | **8** | warn | The asset is in the manifest for that network | Same reasoning. An unrecognized token contract is worth knowing and is not an accusation. |
| `facilitator_known` | **6** | warn | The facilitator is on the [published list](#the-facilitator-list) | Being absent from our list says something about *our list* as much as about the facilitator. Deliberately low. |
| `scheme_known` | **6** | warn | The payment scheme is one tx402 can route | An unroutable scheme means tx402 cannot pay it, but the ecosystem is adding schemes. |
| `tls_ok` | **5** | fail | The endpoint was reached over valid TLS | The hosted probe is https-only, so in practice this is always true when a result exists. It is scored so the CLI — which may use `http:` against localhost — produces comparable numbers. |
| `timeout_sane` | **4** | warn | `0 < maxTimeoutSeconds <= 60` | 60s is tx402's `MAX_AUTHORIZATION_SECONDS`, the longest window it will sign for. Many endpoints use 300s and are perfectly legitimate, so this is a low-weight `warn` — it tells a tx402 buyer they will hit a limit, not that the endpoint is bad. |
| `redirect_scheme_downgrade` | **3** | fail | No hop downgraded the scheme | The guard refuses cross-scheme redirects outright, so a scored result never downgraded. Kept in the table because "we checked and it did not happen" is a fact worth publishing. |
| `wire_form` | **3** | warn | The endpoint serves `v2-header` or `both` | A v1-only endpoint is legacy, not broken. Low weight, because plenty of working endpoints are still v1. |
| `amount_magnitude_band` | **2** | warn | The band is not `extreme` | Weakest signal in the table by design. A large price is a business decision, not a defect. |

**Total available weight: 109.**

`severity` does not change the arithmetic — the weight already carries that. It tells a renderer how to phrase
the finding: `fail` for a concrete defect in the challenge, `warn` for "this may simply be newer than our
lists".

### Amount magnitude bands

Computed in whole units of the asset. Unknown `decimals` means an unknown band, never a guessed one.

| Band | Range (whole units) |
| --- | --- |
| `micro` | `< 0.01` |
| `small` | `0.01 – 1` |
| `medium` | `1 – 10` |
| `large` | `10 – 100` |
| `extreme` | `>= 100` |

---

## The arithmetic

```
score = round(100 × earned / possible)
```

where `possible` is the total weight of the signals that **could be observed and evaluated**, and `earned` is
the total weight of those that passed. Unobserved signals appear in neither sum.

### Bands

| Band | Score |
| --- | ---: |
| `LOW` | `>= 80` |
| `MEDIUM` | `55 – 79` |
| `HIGH` | `< 55` |

### The coverage floor

If the observed signals account for less than **50%** of the 109 available weight, the band is held at
`MEDIUM` even when the score is high, and a `coverage` row is added to `reasons[]` saying so.

Without this, two passing signals out of thirteen would render as `100 / LOW`, which is arithmetically
correct and deeply misleading. The floor **never lowers a score** — it constrains the band only, so rule 1
above still holds: unknown is treated as unknown, not as bad.

### When there is no score at all

`score` returns `null` — and the response carries `risk: null` — when the endpoint **served no x402
challenge**. A URL that is not an x402 endpoint is not a risky endpoint, and rendering a band for one would be
a verdict about something we never assessed.

---

## A worked example

A well-formed x402 v2 endpoint on Base, paying USDC through a listed facilitator:

| Signal | Status | Weight |
| --- | --- | ---: |
| `challenge_decodes` | pass | 25 |
| `resource_origin_match` | pass | 15 |
| `amount_canonical` | pass | 12 |
| `pay_to_wellformed` | pass | 12 |
| `network_recognized` | pass | 8 |
| `asset_recognized` | pass | 8 |
| `facilitator_known` | pass | 6 |
| `scheme_known` | pass | 6 |
| `tls_ok` | pass | 5 |
| `timeout_sane` | pass | 4 |
| `redirect_scheme_downgrade` | pass | 3 |
| `wire_form` | pass | 3 |
| `amount_magnitude_band` | pass | 2 |

`earned = 109`, `possible = 109`, `coverage = 100%` → **`score = 100`, band `LOW`**.

Change one thing — the amount becomes `"0.01"` instead of atomic `"1000"` — and the strict decoder refuses the
challenge:

| Signal | Status | Weight |
| --- | --- | ---: |
| `challenge_decodes` | **fail** | 25 |
| `amount_canonical` | **fail** | 12 |
| `amount_magnitude_band` | skip | 0 |
| *the other ten* | pass | 70 |

`amount_magnitude_band` **skips** rather than fails: the band is computed from an atomic amount, and there
isn't one, so it was not evaluable. It leaves the ratio entirely — this is rule 1 doing its job on a signal
that could easily have been double-counted as a second penalty for the same defect.

`earned = 70`, `possible = 107` (109 minus the skipped 2) → **`score = 65`, band `MEDIUM`**.

Both examples are pinned by a test, so this page cannot drift from the code without the suite failing.

---

## Appeals

**Every score is reproducible from the response that contains it.** `reasons[]` carries the applied weight for
every signal evaluated, including passes and skips, so the arithmetic can be redone by anyone holding the
JSON:

```
score = round(100 × Σ weight[status = "pass"] / Σ weight[status ≠ "skip"])
```

`reproduceScore` in `worker/lib/score.ts` is exactly this function, and the test suite asserts it returns
`risk.score` for every fixture. If it ever does not, the reproducibility claim on this page is false and that
is a release-blocking bug.

If you operate an endpoint and believe a signal is wrong:

1. The response tells you which signal, what we observed, and what it was worth.
2. Claim the endpoint and appeal — DNS TXT or `/.well-known/x402-tools-claim`.
3. A corrected fact is appended, never overwritten. `term_changes` is append-only.

**Historical scores are never recomputed.** A score you received is the score you received, produced by the
rules that applied at the time. Every version's methodology stays published at `/methodology?v=<version>`
forever, because removing one would strand every score ever rendered under it.

---

## The facilitator list

`facilitator_known` means **exactly** this: the challenge's facilitator origin is on a list we publish, and
that list cites a public, dated source for every row.

It is not an endorsement, an audit, or a safety claim. The list is served at `/api/v1/facilitators` with each
row's `source_url` and `source_dated`, so the claim is checkable by the person it is being made at.

Rows are `listed` only when the facilitator's API answered `GET {base_url}/supported` with a valid x402 kinds
document when the list was compiled. Rows that are merely *named* publicly are `unverified` and **do not**
satisfy `facilitator_known` — being written about is weaker evidence than answering the protocol.

---

## Versioning

`score_version` is `"v"` + a monotonically increasing integer. It is not the deploy version, the package
version, or a date.

**Bump it when any of these change:** the signal set that feeds scoring, a weight, a band threshold, the
coverage floor, or the aggregation rule. **A bug fix that changes any output score is a bump** — from the
outside, a corrected score and a changed score are the same event.

Scores are comparable **only within one `score_version`**. Compare refuses to rank rows scored under different
versions without saying so.

---

## Known limitations

Stated here rather than discovered later.

### v1 has no history, and says so

`confidence` is `"static_only"` for every v1 score. Availability, price stability, recipient stability and
endpoint age are all unavailable until the corpus exists. They are emitted as unobserved signals rather
than omitted, so a reader can see what we did not know.

### A v1 endpoint scores lower, and that is a claim about tx402, not about the endpoint

`decodePaymentRequired` is a **v2-only** decoder — it rejects `x402Version: 1` outright. So a perfectly
healthy v1 endpoint fails `challenge_decodes` (−25) and `wire_form` (−3).

This is deliberate and it is the honest answer *for this audience*: the score answers "will a tx402 buyer be
able to pay this?", and for a v1 endpoint the answer is no. It is **not** a claim that the endpoint is badly
run. Renderers must say which of the two they mean, and the reason string does: *"The challenge does not
decode under the strict x402 decoder tx402 uses before paying."*

### `pay_to_declared_dynamic` cannot always be observed — and this gets worse in 

The x402 v2 specification provides **no on-the-wire declaration** that a `payTo` is dynamic. In the reference
implementation, dynamic routing is a server-side function resolved *before* the challenge is serialized, so
what reaches a client is an ordinary address string. (Full record:.)

Two declaration surfaces do exist and are implemented:

1. `payTo` carrying a **role constant** rather than an address — the v2 spec defines the field as "Recipient
   wallet address or role constant (e.g. `merchant`)".
2. A recognized entry in the top-level `extensions` object.

Neither fires for a marketplace using the function-based approach, which is the common case.

**In v1 this is harmless**, because no recipient-instability signal is scored at all. **In v2 it is the
central design problem**: `recipient_unstable_undeclared` would fire on exactly the legitimate marketplaces
the carve-out exists to protect.  must not ship a scored recipient-instability signal until it has a
defensible way to tell a marketplace from an unstable recipient — and if it cannot, the correct outcome is to
leave the signal unscored, not to ship one that is wrong about marketplaces.

### The weights are judgement, and they are published so they can be argued with

Nothing here is derived from data — there is no data yet. The weights encode one ordering: *does it work* >
*does it point at the right resource* > *is the money field sane* > *do we recognize the parties* > *cosmetics*.
That ordering is defensible and it is written down. When the corpus exists, and will have grounds to
revise it, and revising it is a `score_version` bump.
