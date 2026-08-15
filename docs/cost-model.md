# What this service can cost, at worst

A free tool that fetches arbitrary URLs on demand has an unbounded cost tail unless something
specific stops it. This document is that arithmetic, done out loud, so that "bounded" is a number
anyone can check rather than an adjective.

Every input is a constant in this repository, and every one is cited. Re-derive it yourself:

```bash
node scripts/load-test.mjs --base http://127.0.0.1:8787
```

**Last computed 2026-08-15**, against the live corpus of 333 endpoints.

---

## The number

| | worst case, per 31-day month |
| --- | --- |
| Outbound requests we make to other people's endpoints | **273,420** |
| Cost on Workers Paid | **$5.00** — the plan's base price, and no overage on any binding |
| Cost on Workers Free (the plan this account is on today) | **$0**, but one daily allowance is exceeded — see below |

The worst case is not a forecast. It is the largest bill that is *reachable*: it assumes the
crawler spends its entire budget every tick of every day, and that the public exhausts the daily
on-demand allowance every day, forever. Actual usage on 2026-08-15 was **334 crawler probes and
299 on-demand scans in a day**, roughly 8% of the ceiling.

Two things about that table are worth saying plainly.

**The free plan breaks before the money does.** At the crawler's full budget the service needs
11,460 Queues operations a day against a free allowance of 10,000. It is not close to breaking on
anything else. See [The free plan](#the-free-plan).

**One line comes close to its allowance and it is not an obvious one.** Durable Object *duration*
reaches 87% of the Workers Paid inclusion, while requests, storage, D1 and Analytics Engine are all
two or three orders of magnitude below theirs. Duration is billed as wall-clock time at a flat
128 MB, and this service parks callers inside a Durable Object on purpose — that is the politeness
collapse, and it is the most expensive thing we do. See
[Durable Objects](#durable-objects-the-load-bearing-line).

---

## Which plan, and why the question changes

This account is on **Workers Free**. That was established the hard way: a deploy failed with error
`10072`, *"This account has reached the Workers Free limit of 5 cron triggers per account"*, which
also contradicted an earlier inference that the account was paid. Everything else works regardless
— D1, Analytics Engine, Queues (producer, consumer and dead-letter), Durable Objects and the custom
domain all deploy — because those are available on the free plan too.

On Free the question is not "what does this cost" but "what stops working". Allowances are **daily**
and there is no overage: exceed one and that binding returns errors until the day rolls. On Paid
the allowances are **monthly** with per-unit overage, so the same event is a line on an invoice.
Both are computed below, because the migration between them is a decision someone has to make with
a number in hand.

---

## The inputs

Nothing here is estimated. Each row is a constant in the repository, with the file it lives in.

| Input | Value | Where |
| --- | --- | --- |
| Cron trigger | `*/15 * * * *` → 96 ticks/day | `wrangler.jsonc` |
| Probes per ordinary tick | 40 | `MAX_PROBES_PER_CYCLE`, `worker/crawler/types.ts` |
| Probes on the daily seed-refresh tick | 20 (half) | `budgetFor`, `worker/crawler/schedule.ts` |
| On-demand probes per UTC day | 5,000 | `MAX_ON_DEMAND_PROBES_PER_DAY`, `worker/do/probe-limiter.ts` |
| Per-endpoint politeness window | 600 s | `DEFAULT_WINDOW_SECONDS`, same file |
| Per-caller budget | 30 per 60 s | `DEFAULT_CALLER_LIMIT`, same file |
| Follower wait before giving up | 15 s | `MAX_WAIT_MS`, same file |
| Total probe timeout | 10 s | `GUARD_LIMITS.totalTimeoutMs`, `worker/lib/guard.ts` |
| Response body cap | 256 KiB | `GUARD_LIMITS.maxBodyBytes`, same file |
| Queue batch size / retries | 10 / 3 | `wrangler.jsonc` |
| Corpus size | 333 endpoints | measured, production D1 |
| Re-probe cadence | 1,440 min (corpus tier) | `TIER_INTERVAL_MINUTES`, `worker/crawler/types.ts` |

### Outbound probes per day

```
crawler    = 40 probes × 95 ordinary ticks  +  20 probes × 1 seed-refresh tick
           = 3,800 + 20
           = 3,820 / day

on-demand  = 5,000 / day                    (the whole-service ceiling)

total      = 8,820 / day  =  273,420 / 31-day month
```

The two **add** rather than compete. The crawler does not draw on the public allowance, because if
it did, a busy crawl day would deny the Inspector to people; and if they shared, the published
worst case would be the larger of the two rather than their sum, which is the wrong arithmetic in
the direction nobody checks.

`3,820` and not `3,840`: exactly one tick a day is the seed refresh and gets half the budget.
`/crawler` used to publish the wrong figure, computed as `40 × 96`. It now calls `maxProbesPerDay()`
so the page and the code cannot disagree.

### What one probe costs us

| | crawler probe | on-demand probe |
| --- | --- | --- |
| Worker invocations | 0.1 (batched 10 to a queue message) | 1 |
| Queue operations | 3 (write + read + delete) | 0 |
| Durable Object requests | 2 (`reserve`, `record`) | 3 (`reserve`, `admit`, `record`) |
| Durable Object row writes | 2 | 3 (+ caller bucket, + budget) |
| D1 rows written | ≤ 6 | 3 |
| D1 rows read | ~10 | ~6 |
| Analytics Engine data points | 1 | 0 |
| Outbound subrequests | 4 (2 DNS-over-HTTPS, 1 probe, robots when cold) | 3 |

The DNS-over-HTTPS pair is not an accident and not free: Workers expose no DNS API, so the guard
resolves over HTTPS, and it resolves **twice** per hop because that is the DNS-rebinding defence.
Every probe therefore costs three network round trips minimum, which turns out to be what actually
limits throughput.

---

## Per binding, with the load-bearing limit named

Monthly figures are 31 × the daily worst case. "Load-bearing" means: this is the limit that would
be reached first if this binding were the only one that mattered.

### Durable Objects (the load-bearing line)

**Requests.** `(3,820 × 2) + (5,000 × 3) = 22,640/day = 701,840/month.` Against 1,000,000 included
on Paid and 100,000/day on Free. Comfortable both ways.

**Duration — the one that matters.** Duration is wall-clock time during which an object is executing
or is ineligible for hibernation, billed as if it had a full 128 MB whatever it actually uses. This
service deliberately parks callers inside an object: `reserve` is single-flight, so followers await
the leader's probe rather than starting their own. That collapse is the whole point, and it is
also the expensive part.

```
worst case: every probe has at least one follower parked for the leader's
            entire probe, and every probe runs to the 10-second total timeout

  10 s × 128 MB ÷ 1024 MB   = 1.28 GB-s per probe
  273,420 probes × 1.28     = 349,978 GB-s / month
```

Against **400,000 GB-s included** on Workers Paid: **87.5%**. On Free, 11,290 GB-s/day against
13,000/day: **87%**. Every other binding sits below 3% of its allowance; this one sits at 87.

It was worse. `reserve` raced the leader's promise against a 15-second timeout and **never cleared
the timer when the leader won**, so the object stayed non-hibernatable for the remainder of the wait
after the work had finished:

```
before:  (10 s probe + 15 s leaked timer) × 0.128  = 3.2 GB-s per probe
         273,420 × 3.2                             = 874,944 GB-s / month
                                                     = 219% of the inclusion
                                                     = $5.94/month of overage
after:                                               349,978 GB-s = 87.5%
```

Six dollars is not the point. The point is that a cost bug of this shape passes every test in the
suite, is invisible in every code review that is looking for correctness, and only shows up when
somebody multiplies the constants out. That is the reason this document exists.

**Storage.** Row writes track requests: 701,840/month against 50,000,000 included. Stored data is a
cache entry and some caller buckets per object, all of which expire on an alarm — kilobytes.

### D1

**Rows written.** `(3,820 × 6) + (5,000 × 3) = 37,920/day = 1,175,520/month`, against 50,000,000
included on Paid (2.4%) and 100,000/day on Free (38%). The free-plan figure is the one to watch: it
is not close today and it scales linearly with the corpus.

**Rows read.** ~68,200/day = 2,114,200/month, against 25 billion included. Not a consideration at
any plausible size.

**Storage.** Production is **9.95 MB** across 333 endpoints, 630 scans and 328 term changes — about
30 KB per endpoint. 5 GB is included on both plans, so the free storage allowance holds roughly
**165,000 endpoints**. Storage is not the constraint on corpus size; the probe budget is, by four
orders of magnitude.

The append-only `term_changes` table is the only thing here that grows without bound, and it grows
with *observed changes*, not with traffic — 328 rows in the corpus's first day, and a price changes
a handful of times a year.

### Queues

`3,820 messages × 3 operations = 11,460/day = 355,260/month.`

Against 1,000,000 included on Paid: 36%, no overage. Against **10,000/day on Workers Free: 115%.**

This is the first thing the free plan runs out of, and it is worth being precise about when. The
crawler only enqueues endpoints that are *due*, so today's real usage is ~1,000 operations a day —
333 endpoints on a 24-hour cadence, nowhere near the budget's capacity. The allowance binds at
**3,333 messages a day, which is a corpus of about 3,333 endpoints** on the corpus tier, or sooner
if a tier gets faster. Coinbase's Bazaar alone advertises more than 15,000 resources.

The failure is graceful rather than silent: `pump` catches a `sendBatch` failure and probes inline
within the cron invocation instead, so a Queues quota error makes the crawl slower and does not
stop it. It also stops the retry and dead-letter behaviour that the queue provides, which is a
real loss, not a shrug.

### Analytics Engine

`3,820 data points/day = 118,420/month`, against 10,000,000 included on Paid and 100,000/day on
Free — under 4% either way. Only the crawler writes probe points; `/inspect` writes none.

Retention is **three months**, fixed, and the data is sampled. That is fine for the number we
actually render from it (`availability 30d`, `p50 latency`) and would be unacceptable for "the
recipient changed on Jul 21" — which is precisely why that lives in D1 instead. The storage split
in the architecture is load-bearing for this reason and not an aesthetic preference.

One thing here is *not* bounded by anything above: `/api/v1/health` writes a data point on every
call, to prove the binding is writable rather than assert it. That is one Analytics Engine write per
unauthenticated request, and the free allowance is 100,000/day. It is covered by the same request
tail as everything else below, and it is the cheapest line in it.

### Workers

Invocations: ~170,000/month against 10,000,000 included. CPU: probes are I/O-bound, so even at a
generous 15 ms each the total is ~4.1M CPU-ms against 30M included.

Neither is a constraint **for the bounded work**. Both are the entire story for the unbounded part.

---

## The unbounded tail

Everything above bounds **probes**. Nothing above bounds **requests**, and they are not the same
number: a request that is refused still arrives, still runs the router, and still costs an
invocation. There is no ceiling on how many times somebody can ask.

This is the honest gap, and it is stated rather than buried:

```
sustained 100 req/s  = 8.64M/day = 268M/month  → $77/month in Workers requests
sustained 1,000 req/s                          → $803/month
```

Two things narrow it.

**The refusal is now free of everything except the request itself.** Before this session, a request
arriving after the daily allowance was spent still paid for a `reserve` — a Durable Object call and
a caller-bucket row write — on a limiter whose answer was already known. So each flood request cost
a Worker request *and* a DO request *and* a DO row write:

```
1,000 req/s for a month, before:  $803 (requests)
                                + $402 (DO requests, 2.68B at $0.15/M)
                                + $2,680 (DO row writes, 2.68B at $1.00/M)
                                = $3,885/month

1,000 req/s for a month, after:   $803/month
```

`withPoliteness` now memoizes exhaustion per isolate and refuses before touching any Durable Object
at all. The memo can only ever say "no" on stale information, never "yes" — a cache that can
wrongly admit would be a hole, and one that can wrongly refuse for up to a second is a shrug.

**The remaining $803 is a Cloudflare zone problem, not an application one.** Nothing inside a
Worker can decline to be invoked. The fix is a rate-limiting rule at the edge, which is configured
in the dashboard against the `tools.tx402.io` zone rather than in this repository, and which stops
the request before it reaches us. **This is the one mitigation in this document that is not yet in
place.** Until it is, the honest statement is: probes are bounded, spend on probes is bounded, and
request spend under a determined flood is bounded only by Cloudflare's per-request price.

---

## What breaks first

Measured with `scripts/load-test.mjs` against `wrangler dev` on an Apple-silicon laptop, 2026-08-15.
Absolute throughput on production hardware will be higher; the *ordering* is the finding, and the
ordering is what the design depends on.

| Depth | Throughput | What it exercises |
| --- | --- | --- |
| Guard refusal | **450 rps** | router + guard. No DNS, no Durable Object, no probe |
| `/api/v1/health` | **518 rps** | D1 + Analytics Engine + the one global ceiling object |
| Full probe, distinct targets | **126 rps** (plateau at 200 concurrent) | everything, including 3 network round trips |

**The Durable Object is not the bottleneck.** That was the thing most worth checking, because this
session added a *single* global object that every on-demand probe must pass through, and a single
serialization point is the classic way to make a system slower than its parts. It sustains 518 rps
— four times the rate at which the full path saturates — so it is not what gives.

**What gives first is the probe's own network cost**: two DNS-over-HTTPS lookups plus the outbound
request, three round trips that no amount of local concurrency shortens. Throughput plateaus around
126 rps while latency grows linearly past 100 concurrent, which is queueing at a fixed-capacity
resource rather than a CPU or lock problem.

Put next to the ceiling, that is a comfortable margin: 5,000 probes a day is **0.058 probes/second**,
about 2,000× below the measured saturation point. The daily ceiling binds long before throughput
does, which is the correct order — a limit you reach by policy is a decision, and a limit you reach
by saturation is an outage.

### 100× current traffic

The busiest hour the live service has actually had is **145 scans** (2026-08-15, 14:00 UTC). 100× is
14,500/hour = 4.03 rps sustained:

```
30 s at 4.03 rps · 120 requests · all HTTP 200 · p50 197 ms · p95 265 ms · p99 367 ms
```

No errors, no refusals, nothing near a limit. "It served 100×" was never the interesting answer,
which is why the ramp above exists.

### Does the collapse actually hold?

Under real HTTP concurrency against workerd — not microtasks in one isolate, which is all a unit
test can offer:

```
200 concurrent DISTINCT callers, one target  →  1 outbound probe, 199 cache hits, 200× HTTP 200
200 concurrent from ONE caller, one target   →  1 outbound probe, 30 served, 170× HTTP 429
```

Yes. One outbound request for two hundred people, which is the property the whole per-target design
exists to deliver.

The second row is a finding in its own right, and it is the answer to "what breaks first" for a
single abusive caller: **the per-caller budget, at 30 requests per 60 seconds**, long before the
target window or the daily ceiling is consulted. It also means the first version of this load test
measured nothing but the per-caller budget, because every request came from one machine and
therefore one caller key. The scenarios that care about the collapse now send distinct
`cf-connecting-ip` values; on the real edge that header is set by Cloudflare and cannot be spoofed
by a client, which is what makes the budget meaningful in production and forgeable in the harness.

---

## The free plan

Daily worst case against the Workers Free allowances:

| Binding | Worst case/day | Free allowance | |
| --- | --- | --- | --- |
| Queues operations | 11,460 | 10,000 | **115% — exceeded** |
| Durable Object duration | 11,290 GB-s | 13,000 GB-s | 87% |
| D1 rows written | 37,920 | 100,000 | 38% |
| Durable Object requests | 22,640 | 100,000 | 23% |
| Durable Object rows written | 22,640 | 100,000 | 23% |
| Analytics Engine data points | 3,820 | 100,000 | 4% |
| D1 rows read | 68,200 | 5,000,000 | 1% |
| Workers requests | ~14,000 | 100,000 (account-wide) | 14% |

The Workers request allowance is **shared with every other Worker on the account**, including
`tx402-landing`. It is the only line here that another project can spend on our behalf, and it is
the one that would be consumed first by the request tail described above.

**The recommendation is to move to Workers Paid before the corpus passes about 3,300 endpoints**, and
the argument is not the money. The worst-case marginal cost above the $5 base is zero on every
binding; what $5 buys is monthly allowances with overage instead of daily allowances with a wall,
and the removal of the cron-trigger ceiling that currently forces three schedules into one
wall-clock-branching handler.

---

## Turnstile: what it buys, and what it does not

Turnstile is now configured — `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, `TURNSTILE_SECRET_KEY` as a
Worker secret, and `/api/v1/health` reports `limits.turnstile` so the claim is checkable from
outside. It shipped empty under a comment in its own config file saying that empty was "correct for
dev and NOT acceptable in production", which is a state worth ending.

Being precise about what changed:

- It protects the **POST** path — the paste box, which becomes a POST form once a site key is
  configured, because a token does not belong in a URL.
- It does **not** protect `GET /inspect?url=…`, and that is deliberate rather than an oversight. A
  GET is what makes a result a shareable permalink, what makes the Markdown mirror work, and what
  makes the page function with no JavaScript at all. Requiring a token there would break all three
  to raise the cost of an attack that the daily ceiling already bounds.
- It therefore raises the cost of **scripted browser abuse** and does nothing about a script that
  speaks HTTP directly, which is the easier attack.

So Turnstile is not the bound and was never going to be. The bound is the daily ceiling, and the
per-target window is what protects other people's endpoints. Turnstile is worth having because it
removes the laziest abuse and costs a page weight; claiming more for it would be dishonest, and
would be the kind of claim that stops anyone looking for the real limit.

### Verifying Turnstile locally

The production widget is scoped to `tools.tx402.io` only. Adding `localhost` to its domain list
would let anyone farm tokens for it from a page they control, so local development uses
[Cloudflare's published test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
in a gitignored `.dev.vars`:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

All three paths were verified against `wrangler dev` before deploy: a POST with no token returns
`TURNSTILE_REQUIRED` (401), a POST with a token against the always-pass secret returns 200, and the
same token against the always-fail secret (`2x0000000000000000000000000000000AA`) returns
`TURNSTILE_FAILED` (403). Note that `wrangler dev` does not reload on a `.dev.vars` change; it has
to be restarted.

---

## How to check this number

Nothing above requires trusting the document.

**The limits the service is actually running:**

```bash
curl -s https://tools.tx402.io/api/v1/health | jq .data.limits
```

reports whether Turnstile is configured, the daily on-demand ceiling, and how much of today's
allowance is left. The remaining count comes from the same Durable Object that enforces it, so it
cannot drift from the thing it describes.

**The crawler's side of the arithmetic:**

```bash
curl -s https://tools.tx402.io/api/v1/crawler | jq .data.limits
```

**What actually happened, rather than what could:**

```sql
SELECT kind, count(*) AS cycles, sum(probes_performed) AS probes,
       sum(skipped_budget) AS deferred
  FROM crawl_cycles
 WHERE started_at >= date('now', '-1 day')
 GROUP BY kind;
```

Every cycle is recorded whether it succeeded or not, precisely so that the bound has a measured
counterpart and is not only a multiplication.

**The load figures:**

```bash
node scripts/load-test.mjs --base http://127.0.0.1:8787
```

The harness never points load at anyone else's endpoint — every scenario names one target,
defaulting to a URL on this project's own origin. Committing a load generator aimed at third-party
APIs, in a repository whose entire argument is that it refuses to be one, would be absurd.

---

## When this document is wrong

It is wrong the moment any of these changes, and each of them is a constant somebody could edit
without thinking about this page:

- `MAX_PROBES_PER_CYCLE`, or the cron expression.
- `MAX_ON_DEMAND_PROBES_PER_DAY`.
- `DEFAULT_WINDOW_SECONDS`, `DEFAULT_CALLER_LIMIT` or `MAX_WAIT_MS`.
- `GUARD_LIMITS.totalTimeoutMs` — it is the multiplier on the Durable Object duration line, which is
  the one at 87%.
- Any new probe caller that does not pass `onDemand: true` and is not the crawler. Such a caller
  would be outside both ceilings, and the sum at the top of this page would silently stop being the
  total.
- A faster probe tier, which multiplies the crawler's queue operations against the free allowance
  that is already exceeded.

Anyone changing one of those should re-run the multiplication. It takes ten minutes, and the last
time nobody did it, a fifteen-second timer that nobody cleared was quietly costing 219% of a
monthly allowance.
