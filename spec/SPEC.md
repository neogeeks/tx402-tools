# tx402 tools — API contract

> **Status: frozen.** Everything in this file is a contract. The UI, the JSON API, the CLI and the MCP
> server are four renderers of one set of shapes, tested against these schemas rather than against each
> other — which is what keeps them from drifting. A change here is a schema version bump, not an edit in
> passing.

Machine-readable counterpart: `spec/schemas/*.json` (JSON Schema 2020-12). Where this document and a schema
disagree, **the schema wins** and the disagreement is a bug to file. Fixtures in `spec/fixtures/` are the
frozen inputs; `pnpm schema:check` validates them.

---

## 0. Contents

1. [Conventions](#1-conventions) · 2. [The envelope](#2-the-envelope) · 3. [Errors](#3-errors) ·
4. [Shared types](#4-shared-types) · 5. [Tool contracts](#5-tool-contracts) ·
6. [Signals](#6-signals-the-scoring-input) · 7. [`score_version`](#7-score_version) ·
8. [Route table](#8-route-table) · 9. [Schema index](#9-schema-index)

---

## 1. Conventions

### 1.1 Origin and versioning

One origin: `https://tools.tx402.io`. The API is under `/api/v1/`. The version is in the path
**and** echoed in every response as `api_version`. A breaking change is a new path prefix, never a silent
change to `v1`.

### 1.2 Content negotiation (L11)

Every **tool route** — the page routes and their API mirrors — serves three representations of the same
result. This is not decoration: `curl -H 'Accept: text/markdown' tools.tx402.io/inspect?url=…` is a
first-class surface, because the buyers in this economy are agents.

| Request | Response |
| --- | --- |
| `Accept: application/json` (or `/api/v1/*`, or `?format=json`) | the envelope in §2, `application/json; charset=utf-8` |
| `Accept: text/markdown` (or a `.md` path, or `?format=md`) | the plaintext report, `text/markdown; charset=utf-8` |
| anything else (browsers) | the HTML page, `text/html; charset=utf-8` |

Rules, frozen:

- **`Vary: Accept` on every negotiated response.** No exceptions — a cache that ignores this serves HTML to
  an agent.
- Markdown mirrors are reachable two ways, matching the landing/docs convention: `/inspect.md` and
  `/inspect/.md`.
- `?format=` beats `Accept:`. It exists so a link can pin a representation.
- Every negotiated response carries `Link:` headers advertising the other two representations:
  `Link: </inspect.md>; rel="alternate"; type="text/markdown", </api/v1/inspect>; rel="alternate"; type="application/json"`
- The markdown mirror is a **rendering of the same JSON**, never a separate computation. If they can
  disagree, the design is wrong.
- Quality values are parsed (`Accept: text/html;q=0.9, application/json`), highest q wins, ties break in the
  order json > markdown > html.

### 1.3 Timestamps

RFC 3339, UTC, `Z` suffix, second precision: `2026-08-14T09:41:07Z`. Never a local time, never an epoch
integer, never a timezone offset other than `Z`.

### 1.4 Money

- **`amount_atomic` is a decimal string of digits.** No sign, no decimal point, no exponent, no leading zeros
  (except the single digit `"0"`). It is a string because a uint256 does not fit in a JSON number or in a
  SQLite INTEGER, and silently rounding a price is precisely the failure this product exists to catch.
- `amount_decimal` is a **display-only** string derived from `amount_atomic` and the asset's `decimals`.
  Never do arithmetic on it. It is absent (`null`) when `decimals` is unknown.
- A challenge whose amount is not a canonical atomic integer fails the `amount_atomic_canonical` check. It is
  one of the most common real-world x402 mistakes, so it is a named check, not a parse error.

### 1.5 Endpoint id and canonical URL

`endpoint_id` = the first 32 characters of the lowercase hex SHA-256 of the **canonical URL**.

Canonicalization, in order:

1. Reject the URL outright if it contains userinfo (`https://user:pass@host/…`). This is not normalized away
   — it is refused.
2. Lowercase the scheme. The hosted service accepts `https:` only; `http:` exists only in the local CLI.
3. Lowercase the host, strip a trailing dot, convert to punycode (IDNA 2008).
4. Drop the port if it is the scheme default.
5. Empty path becomes `/`. The path is otherwise preserved byte-for-byte, including case and trailing slash.
6. Sort query parameters by name, then by value; preserve duplicates; drop the `?` entirely if empty.
7. Drop the fragment.

Two URLs with the same canonical form are the same endpoint. This is frozen because it is the join key for
every table in `migrations/0001_init.sql` and every cache key in the probe.

### 1.6 Caching and freshness

Probe results are shared. A response that came from the politeness cache **says so**:
`meta.cached: true` and `meta.cache_age_seconds`. A client that needs a fresh number must ask for one and may
be refused with `TARGET_RATE_LIMITED` — it is never given a stale number that claims to be live.

### 1.7 What the API never contains

No IP addresses, no cookies, no visitor identifiers, no request signatures, no keys, and no
`PAYMENT-SIGNATURE` header — this repo cannot construct one.

---

## 2. The envelope

Every successful response, from every tool, in JSON:

```json
{
  "api_version": "v1",
  "tool": "inspect",
  "generated_at": "2026-08-14T09:41:07Z",
  "meta": {
    "implemented": true,
    "owner_session": "",
    "cached": false,
    "cache_age_seconds": null,
    "score_version": "v1",
    "tx402_version": "0.2.0",
    "schema": "https://tools.tx402.io/api/v1/schemas/inspect"
  },
  "warnings": [
    { "code": "NO_HISTORY", "message": "First time we have seen this endpoint." }
  ],
  "data": { }
}
```

- `warnings` is **always present and always an array** — empty, not absent. A warning is a fact about the
  answer's completeness, never an error.
- `meta.implemented: false` marks a route that stubbed and whose owning session has not landed yet. The
  stub returns a schema-valid, empty-but-honest `data`, so the CLI and MCP can be written against
  a live server before the implementations exist. `meta.owner_session` names who is going to fill it in.
- `meta.score_version` is present on every response that contains a score, and `null` otherwise.
- `data` is the only tool-specific part. Its shape is §5.

---

## 3. Errors

One envelope for every failure, at every route:

```json
{
  "api_version": "v1",
  "generated_at": "2026-08-14T09:41:07Z",
  "error": {
    "code": "URL_PRIVATE_ADDRESS",
    "message": "The URL resolves to an address in private space.",
    "detail": { "stage": "dns" },
    "retryable": false,
    "docs": "https://tools.tx402.io/errors#url_private_address"
  }
}
```

- `code` is from the **closed vocabulary below**. Adding one is an addendum + a schema bump.
- `message` is human-readable, one sentence, and **safe to display**: never an internal path, never a stack,
  never anything a caller supplied verbatim beyond what they already know.
- `detail` is optional and structured; its keys are closed per code.
- `retryable` tells an agent whether trying again can plausibly work. `RATE_LIMITED` is retryable,
  `URL_SCHEME_NOT_ALLOWED` is not.
- **The guard never explains itself in a way that helps someone map an internal network.** Every blocked-URL
  code returns the same generic `message`; `detail.stage` is the only differentiation, and it is coarse.

### 3.1 Error codes

| Code | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | no | Malformed request; not a validation failure of a known field. |
| `VALIDATION_FAILED` | 422 | no | A field was present but invalid. `detail.fields[]` names them. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no | Body was not `application/json`. |
| `NOT_ACCEPTABLE` | 406 | no | No representation matches `Accept`. |
| `METHOD_NOT_ALLOWED` | 405 | no | Route exists, method does not. `Allow` header is set. |
| `NOT_FOUND` | 404 | no | No such route, share link, or record. |
| `URL_SCHEME_NOT_ALLOWED` | 422 | no | Hosted probe accepts `https:` only. |
| `URL_USERINFO_PRESENT` | 422 | no | The URL carried credentials. Refused, never stripped. |
| `URL_BLOCKED` | 422 | no | The URL is refused by the guard. Generic on purpose. |
| `URL_PRIVATE_ADDRESS` | 422 | no | Resolves into private/loopback/link-local/CGNAT space. |
| `TOO_MANY_REDIRECTS` | 502 | no | More than the documented hop limit. |
| `PROBE_TIMEOUT` | 504 | yes | Connect or total budget exceeded. |
| `PROBE_FAILED` | 502 | yes | Transport failure reaching the endpoint. |
| `RESPONSE_TOO_LARGE` | 502 | no | Endpoint exceeded the documented byte cap. |
| `CHALLENGE_MALFORMED` | 200 | no | **Not an HTTP error.** A malformed challenge is a *result* — it is reported inside `data`, and this code appears only when a caller POSTs a challenge directly to `/api/v1/verify` and nothing at all could be parsed. |
| `NOT_X402` | 200 | no | Same: the endpoint answered, but not with an x402 challenge. Reported in `data`, never as an HTTP error. |
| `RATE_LIMITED` | 429 | yes | Caller is over their limit. `Retry-After` is set. |
| `TARGET_RATE_LIMITED` | 429 | yes | The *endpoint* is over its politeness budget. A cached result may be available. |
| `TURNSTILE_REQUIRED` | 401 | no | Public paste box needs a Turnstile token. |
| `TURNSTILE_FAILED` | 403 | no | Token did not verify. |
| `ENDPOINT_OPTED_OUT` | 403 | no | The operator opted this endpoint out (docs/abuse-policy.md). |
| `NO_DATA` | 200 | no | **Not an HTTP error.** Empty corpus is a valid answer with `has_data: false`. |
| `NOT_IMPLEMENTED` | 501 | no | Reserved. Stubs return **200 with `meta.implemented: false`**, not this. This code is for a route that exists and is deliberately unavailable. |
| `INTERNAL` | 500 | yes | Our fault. Never leaks detail. |

Note the three rows marked "not an HTTP error". They encode a product decision: **an endpoint being broken is
the answer the user came for, not a failure of our service.** A malformed challenge renders as a report with
failing checks, HTTP 200. Returning 4xx there would make every honest negative result look like our bug.

---

## 4. Shared types

Defined once, referenced by several tools. Schemas: `spec/schemas/common.json`.

### 4.1 `Requirement`

One accepted way to pay, normalized from either wire form.

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "network_recognized": true,
  "asset": { "address": "0x833589…", "symbol": "USDC", "decimals": 6, "recognized": true },
  "amount_atomic": "1000",
  "amount_decimal": "0.001000",
  "pay_to": "0xabc…",
  "pay_to_dynamic": false,
  "max_timeout_seconds": 300,
  "resource": "https://api.example.com/v1/geocode",
  "mime_type": "application/json",
  "description": "Geocode one address",
  "facilitator": "https://facilitator.example.com",
  "extra": { }
}
```

`network_recognized` / `asset.recognized` mean **"present in the tx402 signed release manifest"**
(`BUNDLED_MANIFEST`), and nothing more. `pay_to_dynamic` is true only when the challenge *declares* a dynamic
`payTo` scheme — see §6.2 of, and §6.4 below. Unknown fields are preserved verbatim under `extra`.

### 4.2 `Challenge`

```json
{
  "wire_form": "v2-header",
  "x402_version": 2,
  "valid": true,
  "decode_error": null,
  "accepts": [ /* Requirement */ ],
  "requirement_count": 1,
  "raw_bytes": 412,
  "hash": "9f2c…",
  "raw": "eyJ4NDAy…"
}
```

- `wire_form` ∈ `v2-header` (the `PAYMENT-REQUIRED` response header) | `v1-body` (the legacy JSON body) |
  `both` (served both; itself a signal) | `none`.
- `valid` is the verdict of **`decodePaymentRequired` imported from `tx402`** — the strict decoder the SDK
  would use before paying. Nothing in this repo implements a second decoder. When `valid` is
  false, `decode_error` is `{ code, message }` and `accepts` is `[]`.
- `hash` is SHA-256 over the canonicalized challenge (JCS-style: keys sorted, no insignificant whitespace),
  lowercase hex. It is the change-detection key in `term_changes`.
- `raw` is the challenge exactly as served, truncated to the documented cap. It is public data — the endpoint
  serves it to anyone who asks.

### 4.3 `Check`

Used by `/verify` and echoed in `/inspect`.

```json
{ "id": "amount_atomic_canonical", "status": "pass", "offline": true, "reason": null, "detail": null }
```

`status` ∈ `pass` | `warn` | `fail` | `skip`. `skip` means the check could not run (e.g. it needs the corpus
and the corpus is empty) — it is never silently counted as a pass. `offline: true` means the check runs with
zero network access, which is what makes the CLI's offline verifier provable.

### 4.4 `Signal`

The raw scoring input. See §6.

```json
{ "id": "resource_origin_match", "value": true, "observed": true, "detail": null }
```

`observed: false` means we could not determine it; `value` is then `null`. **A signal that was not observed
is never scored as if it failed.** That distinction is the difference between "we saw a problem" and "we did
not see", and conflating them is how a trust tool starts crying wolf.

### 4.5 `Risk`

```json
{
  "score": 86,
  "band": "LOW",
  "score_version": "v1",
  "confidence": "static_only",
  "signals_evaluated": 14,
  "reasons": [
    { "signal_id": "facilitator_known", "status": "pass", "weight": 8, "message": "Facilitator is on the published list." }
  ],
  "methodology_url": "https://tools.tx402.io/methodology?v=v1"
}
```

- `score` is an integer 0–100. Higher means **more of what we check checked out**.
- `band` ∈ `LOW` | `MEDIUM` | `HIGH` and is derived from `score` by thresholds published with the version.
- **`band` is a statement about our observations, not about the operator.** It is the level of caution the
  signals we could observe support. Every surface rendering a band must say so above the fold.
  The words `scam`, `fraud`, `fraudulent`, `unsafe`, `dangerous` and `malicious` do not appear in any
  rendering of a risk result, in any language, ever.
- `confidence` ∈ `static_only` (no corpus history yet — the correct state for a new endpoint, not a degraded
  one) | `with_history`.
- `reasons[]` carries the applied `weight` per signal, so the score is **reproducible from the raw signals in
  the same response**. That reproducibility is the appeal mechanism.
- Weights and thresholds live in `spec/risk-score.md`, written and published at `/methodology`.
  They are versioned with `score_version`, never with the deploy.

### 4.6 `TermChange`

```json
{
  "id": "01J…",
  "changed_at": "2026-07-21T14:02:11Z",
  "change_kind": "recipient",
  "field": "pay_to",
  "old_value": "0xabc…",
  "new_value": "0xdef…",
  "detected_by": "crawler",
  "score_version": "v1"
}
```

`change_kind` vocabulary is the CHECK constraint in `migrations/0001_init.sql`. The table is append-only and
enforced by triggers; a mistake is corrected by appending a `correction` row, never by an UPDATE.

### 4.7 `ProbeMeta`

```json
{
  "observed_at": "2026-08-14T09:41:05Z",
  "http_status": 402,
  "latency_ms": 184,
  "redirect_count": 0,
  "tls": { "ok": true, "protocol": "TLSv1.3" },
  "bytes_read": 412,
  "served_from_cache": false,
  "cache_age_seconds": null
}
```

---

## 5. Tool contracts

### 5.1 Inspect —

```
GET /inspect?url=… (HTML |.md | JSON by negotiation)
GET /api/v1/inspect?url=…
POST /api/v1/inspect { "url": "…", "turnstile_token": "…" }
```

`data` — schema `spec/schemas/inspect.json`:

```json
{
  "target": { "url": "…", "canonical_url": "…", "endpoint_id": "…", "origin": "…", "host": "…" },
  "probe": { /* ProbeMeta */ },
  "challenge": { /* Challenge | null */ },
  "terms": { /* Requirement | null — the selected/primary requirement */ },
  "checks": [ /* Check */ ],
  "signals": [ /* Signal */ ],
  "risk": { /* Risk | null */ },
  "observed": {
    "has_history": false,
    "first_seen": null,
    "last_seen": null,
    "scan_count": 0,
    "availability_30d": null,
    "latency_p50_ms": null,
    "recent_changes": []
  },
  "links": {
    "html": "https://tools.tx402.io/inspect?url=…",
    "markdown": "https://tools.tx402.io/inspect.md?url=…",
    "json": "https://tools.tx402.io/api/v1/inspect?url=…",
    "history": "https://tools.tx402.io/history?url=…",
    "methodology": "https://tools.tx402.io/methodology?v=v1",
    "share": null
  }
}
```

`GET` is safe and cacheable and is what agents and links use; `POST` exists because the public paste box
carries a Turnstile token and a token does not belong in a URL. Both return the identical `data`.

**`observed` with `has_history: false` is a correct answer, not an error**. The Inspector
ships before the corpus exists and must render "first seen: just now — no history yet" as a normal state.
`probe` is null only when the probe itself was refused; that path returns an error envelope instead.

### 5.2 Verify —

```
POST /api/v1/verify
```

Request — schema `spec/schemas/verify-request.json`:

```json
{
  "challenge": {
    "header": "eyJ4NDAy…",
    "body": null,
    "raw": null
  },
  "context": { "url": "https://api.example.com/v1/geocode", "expected_origin": "https://api.example.com" },
  "options": { "enrich": false }
}
```

Exactly one of `header` / `body` / `raw` is provided. `context.url` is optional; without it the
`resource_origin_match` check reports `skip`, never `pass`.

`data` — schema `spec/schemas/verify.json`:

```json
{
  "verdict": "pass",
  "challenge": { /* Challenge */ },
  "checks": [ /* Check */ ],
  "signals": [ /* Signal */ ],
  "risk": null,
  "enrichment": null
}
```

- `verdict` = `fail` if any check failed, else `warn` if any warned, else `pass`. Frozen aggregation rule;
  the CLI and the API must agree bit for bit.
- **`options.enrich` defaults to `false` and is the entire product split**. Offline checks run
  locally in the CLI and send nothing — ships a test asserting zero network calls. Enrichment
  (`amount_within_observed_range`, `recipient_matches_observed`, `endpoint_known`) needs the corpus and is an
  explicit opt-in on a separate call. When `enrich` is false, `enrichment` is `null` and the corpus-dependent
  checks report `skip`.
- The frozen check ids are §5.2.1. ** and implement the same ids with the same semantics** — that is
  what makes the CLI's offline verdict comparable to the hosted one.

#### 5.2.1 Frozen check ids

| id | offline | Fails when |
| --- | --- | --- |
| `wire_form_detected` | ✅ | Neither wire form is present. |
| `base64_strict` | ✅ | v2 header is not strict base64 (whitespace, wrong padding, URL-safe mix). |
| `size_within_limit` | ✅ | Challenge exceeds the decoder's byte cap. |
| `depth_within_limit` | ✅ | Nesting exceeds the decoder's depth cap. |
| `no_duplicate_keys` | ✅ | The JSON contains a duplicate key at any level. |
| `json_wellformed` | ✅ | The payload is not well-formed JSON. |
| `x402_version_known` | ✅ | `x402Version` is absent or not a version we understand. |
| `accepts_present` | ✅ | `accepts` is missing or empty. |
| `accepts_within_limit` | ✅ | More requirements than the decoder's cap. |
| `scheme_known` | ✅ | The payment scheme is not one we recognize. (warn) |
| `network_caip2_wellformed` | ✅ | `network` is not a well-formed CAIP-2 id. |
| `network_recognized` | ✅ | Network is absent from the tx402 signed manifest. (warn) |
| `asset_recognized` | ✅ | Asset is absent from the manifest for that network. (warn) |
| `amount_atomic_canonical` | ✅ | Amount is not a canonical atomic integer string (§1.4). |
| `amount_positive` | ✅ | Amount is zero or negative. |
| `pay_to_wellformed` | ✅ | Recipient is not a valid address for the chain family. |
| `max_timeout_sane` | ✅ | Authorization window is absent, non-positive, or beyond the SDK's maximum. |
| `resource_origin_match` | ✅ | The challenge's `resource` origin differs from the endpoint's. |
| `mime_type_wellformed` | ✅ | `mimeType` is present and not a valid media type. (warn) |
| `extra_wellformed` | ✅ | `extra` is present and not a JSON object. (warn) |
| `facilitator_known` | ✅¹ | Facilitator is absent from the published list. (warn) |
| `amount_within_observed_range` | ❌ | Amount is far outside what we have observed for this endpoint. (warn) |
| `recipient_matches_observed` | ❌ | Recipient differs from the last observed one **and** the challenge does not declare dynamic `payTo`. (warn) |
| `endpoint_known` | ❌ | Informational: whether the endpoint is in the corpus. Never fails. |

¹ Offline against the **bundled** facilitator list shipped with the CLI, which carries its own dated version;
the hosted API uses the live `facilitators` table. The check reports which list it used in `detail`.

### 5.3 Policy evaluate —

```
POST /api/v1/policy/evaluate
```

Request — schema `spec/schemas/policy-request.json`:

```json
{
  "policy": { /* tx402 PolicyConfig, verbatim */ },
  "challenge": { "header": "…", "body": null, "raw": null },
  "request": { "url": "https://api.example.com/v1/geocode", "method": "GET" },
  "state": { "spent_in_window_atomic": "0", "spent_total_atomic": "0", "window_started_at": null }
}
```

`data` — schema `spec/schemas/policy.json`:

```json
{
  "decision": "deny",
  "selected_requirement": { /* Requirement | null */ },
  "evaluation": [
    { "stage": "domain", "result": "pass", "detail": "api.example.com is in allowedDomains" },
    { "stage": "network", "result": "pass", "detail": null },
    { "stage": "scheme_asset", "result": "pass", "detail": null },
    { "stage": "per_request", "result": "fail", "detail": "0.05 USDC exceeds maxPerRequest 0.01" },
    { "stage": "rolling_hour", "result": "skip", "detail": "not reached" }
  ],
  "error": {
    "name": "BudgetExceededError",
    "code": "BUDGET_EXCEEDED",
    "message": "…",
    "details": { }
  },
  "tx402_version": "0.2.0",
  "engine": "PolicyEngine"
}
```

- **The engine is the real `PolicyEngine` imported from `tx402`, run server-side**. The browser
  never bundles `tx402`; `node:crypto` makes that impossible, and running the real engine means the
  playground can never drift from the SDK.
- `evaluation[].stage` vocabulary, frozen and **ordered**: `domain`, `network`, `scheme_asset`, `recipient`,
  `per_request`, `rolling_hour`, `total`, `routing`. Stages after the first `fail` report `skip`. Showing the
  order is the teaching moment of the whole tool.
- `error.name` is the SDK's exact exception class name and `error.code` its `TX402_ERROR_CODES` member. A
  playground that shows a *different* error than the SDK would raise is worse than no playground.
- No storage, no account: the permalink encodes the config in the URL.

### 5.4 History —

```
GET /history?url=…&window=30d
GET /api/v1/history?url=…&window=7d|30d|90d
```

`data` — schema `spec/schemas/history.json`:

```json
{
  "target": { "url": "…", "canonical_url": "…", "endpoint_id": "…" },
  "window": "30d",
  "has_data": false,
  "coverage": { "first_seen": null, "last_seen": null, "scan_count": 0, "sampled": true },
  "series": {
    "price": [ { "t": "2026-07-21T00:00:00Z", "amount_atomic": "1000", "asset_symbol": "USDC", "network": "eip155:8453" } ],
    "availability": [ { "t": "2026-07-21T00:00:00Z", "ratio": 0.9994, "samples": 96 } ],
    "latency": [ { "t": "2026-07-21T00:00:00Z", "p50_ms": 180, "p95_ms": 410, "samples": 96 } ]
  },
  "changes": [ /* TermChange */ ]
}
```

`coverage.sampled: true` is mandatory whenever a series comes from Analytics Engine, because those numbers
are sampled and retention-bounded. Price and recipient series come from `term_changes` in
D1 and are exact. **The two must never be blended into one array** — one is evidence, the other is telemetry.

### 5.5 Compare —

```
GET /compare?urls=a,b,c
GET /compare/<category-slug>
GET /api/v1/compare?urls=…|category=…
```

`data` — schema `spec/schemas/compare.json`:

```json
{
  "category": { "slug": "geocoding", "title": "x402 geocoding APIs", "summary": "…" },
  "generated_at": "2026-08-14T09:41:07Z",
  "rows": [
    {
      "endpoint_id": "…",
      "url": "…",
      "title": "…",
      "terms": { /* Requirement | null */ },
      "availability_30d": null,
      "latency_p50_ms": null,
      "risk": { /* Risk | null */ },
      "insufficient_data": true,
      "last_seen": null
    }
  ],
  "notes": []
}
```

`insufficient_data: true` renders as an explicit "not enough data yet" cell. A comparison table that fills
gaps with plausible-looking numbers is a liability, not a feature.

### 5.6 Watch — **removed**

Watch is not part of this product. It was cut in wave 3, before any of it shipped, and **accounts and
notification channels were cut with it**: they existed solely so that Watch could deliver an alert somebody
asked for, so with Watch gone they would have identified a person for nothing.

The consequences are contract-level and deliberate:

- `/watch`, `/api/v1/watch`, `/api/v1/auth/*` and `/api/v1/channels*` are **gone from §8's route table**, and
  `watch.json` is gone from §9's schema index.
- `UNAUTHENTICATED` and `FORBIDDEN` have **left the closed error vocabulary in §3.1**. Nothing in this
  product authenticates a caller, so no route can emit either.
- **Nothing here identifies a person.** §1.7's list — no IP addresses, no cookies, no visitor identifiers —
  now has nothing standing beside it: there is no account, no email address, no notification destination and
  no table in which one could be stored (`migrations/0003_drop_accounts.sql`).

Reinstating any of this is a plan decision plus an addendum, not an edit to a route table.

### 5.7 Replay — (CLI-first)

Analysis is **local**. The hosted routes exist only for the opt-in share permalink.

```
POST /api/v1/replay/share { "trace": { /* redacted */ }, "analysis": { /* ReplayAnalysis */ } }
GET /api/v1/replay/:id
```

`ReplayAnalysis` — schema `spec/schemas/replay.json`:

```json
{
  "lifecycle": [
    { "phase": "discover", "status": "ok", "at": "…", "detail": "402 with a v2 challenge" },
    { "phase": "decode", "status": "ok", "at": "…", "detail": null },
    { "phase": "policy", "status": "ok", "at": "…", "detail": null },
    { "phase": "route", "status": "ok", "at": "…", "detail": "base → eip155:8453" },
    { "phase": "authorize", "status": "ok", "at": "…", "detail": null },
    { "phase": "submit", "status": "unknown", "at": "…", "detail": "no settlement response observed" },
    { "phase": "settle", "status": "unknown", "at": null, "detail": null },
    { "phase": "deliver", "status": "fail", "at": "…", "detail": "resource not delivered" }
  ],
  "diagnosis": {
    "code": "AMBIGUOUS_PAYMENT",
    "title": "The payment may have been authorized without the resource arriving",
    "explanation": "…",
    "guidance": "…",
    "do_not_retry": true
  },
  "redaction": { "applied": true, "fields_redacted": 3 }
}
```

- `phase` is a lowercase snake string. The canonical vocabulary is
  `discover · decode · policy · route · authorize · submit · settle · deliver`; the schema constrains the
  *shape* (`^[a-z][a-z0-9_]*$`) rather than the *membership*, so that can map the SDK's own phase
  taxonomy on without an addendum round-trip. Renderers switch on the canonical set and fall back to
  title-casing anything else.
- `status` ∈ `ok` | `fail` | `skip` | `unknown`. **`unknown` is load-bearing**: an ambiguous payment is
  precisely the case where we do not know whether the submit landed, and rendering that as `fail` would tell
  the user the opposite of the truth.
- **`do_not_retry: true` on an ambiguous payment is a correctness requirement, not a suggestion.** The
  merchant may hold a valid authorization; retrying can pay twice. The requirement is this.
- `redaction.applied` refers to redaction performed **client-side, before upload**. The server
  never receives an unredacted trace and has no column to store one.

### 5.8 Service routes

```
GET /api/v1/health → { "ok": true, "bindings": { "db": true, "analytics": true, "queue": true, "limiter": true } }
GET /api/v1/meta → versions: api_version, score_version, tx402_version, schema_version, commit
GET /api/v1/facilitators → the published "known facilitator" list, with each row's dated source (O3)
GET /api/v1/categories → curated Compare categories
GET /api/v1/endpoints → corpus listing, paginated
GET /api/v1/schemas → index of frozen schemas
GET /api/v1/schemas/:name → one schema, as served to the CLI and MCP for validation
```

`/api/v1/facilitators` is a **trust claim rendered as data**: every row carries `source_url` and
`source_dated`, so "✓ known facilitator" is checkable by the person it is being claimed at.

---

## 6. Signals (the scoring input)

Signals are the raw observations. `score` is a pure function of them. Extraction is
`worker/lib/signals.ts`; scoring is `worker/lib/score.ts`; weights are `spec/risk-score.md`.

### 6.1 v1 signals — static only, available on the first probe

| id | type | Notes |
| --- | --- | --- |
| `probe_ok` | boolean | The endpoint answered within the caps. |
| `challenge_served` | boolean | A 402 carrying an x402 challenge was served. |
| `challenge_decodes` | boolean | `decodePaymentRequired` accepted it. |
| `wire_form` | enum | `v2-header` \| `v1-body` \| `both` \| `none`. |
| `x402_version` | integer\|null | As declared. |
| `tls_ok` | boolean | Valid https connection. |
| `tls_protocol` | string\|null | e.g. `TLSv1.3`. |
| `redirect_count` | integer | 0–3. |
| `redirect_scheme_downgrade` | boolean | Any hop downgraded https→http. |
| `resource_origin_match` | boolean\|null | Challenge `resource` origin == probed origin. |
| `network_recognized` | boolean\|null | In the tx402 signed manifest. |
| `asset_recognized` | boolean\|null | In the manifest for that network. |
| `facilitator_known` | boolean\|null | On the published list (O3). |
| `amount_canonical` | boolean\|null | Canonical atomic integer string. |
| `amount_magnitude_band` | enum | `micro` \| `small` \| `medium` \| `large` \| `extreme` \| `unknown`. Bands are published; the raw amount is in `terms`. |
| `pay_to_wellformed` | boolean\|null | Valid address for the chain family. |
| `pay_to_declared_dynamic` | boolean\|null | The challenge **declares** dynamic `payTo`. |
| `timeout_sane` | boolean\|null | Within the SDK's maximum authorization window. |
| `scheme_known` | boolean\|null | Recognized payment scheme. |
| `requirement_count` | integer | Number of `accepts` entries. |
| `challenge_size_bytes` | integer\|null | Raw size. |

### 6.2 v2 signals — historical, land with the corpus

`first_seen_age_days` · `scan_count` · `availability_30d` · `latency_p50_ms` · `price_changes_90d` ·
`recipient_changes_90d` · `recipient_unstable_undeclared` · `terms_changed_within_24h`

They are listed here so designs `signals.ts` to accept them without a rewrite. **Adding any of them to
scoring bumps `score_version`** (§7).

### 6.3 The rule that keeps signals honest

`observed: false` and `value: null` are not a failing signal. A signal we could not observe contributes
nothing — it does not push the score down. The alternative (treating unknown as bad) means every brand-new
endpoint looks suspicious, which is both wrong and the fastest way to make the tool useless.

### 6.4 The dynamic-`payTo` carve-out — required in v1

Dynamic `payTo` is a **first-class x402 v2 feature** for marketplaces. A recipient that
changes per request under a *declared* dynamic scheme is a marketplace, not a rug.

Therefore the only recipient-instability signal that may ever reduce a score is:

```
recipient_unstable_undeclared = (recipient changed across scans) AND NOT pay_to_declared_dynamic
```

A bare "recipient changed" signal is **forbidden** in every version of the scoring function. This is frozen
here rather than left to its judgement because getting it wrong is how the tool earns a reputation for
crying wolf, and because it must be true in v1 even though the historical half of the input only arrives
in.

---

## 7. `score_version`

- The value is `"v"` + a monotonically increasing integer: `v1`, `v2`, … It is **not** the deploy version,
  the package version, or a date.
- Bump it when **any** of these change: the signal set that feeds scoring, a weight, a band threshold, or the
  aggregation rule. A bug fix that changes any output score is a bump.
- **Scores are only comparable within one `score_version`.** Every surface that renders a score renders its
  version, and Compare refuses to rank rows scored under different versions without saying so.
- **Historical scores are never recomputed.** `terms_current`, `scans` and `term_changes` all store the
  version that was in force when the row was written. A merchant appealing a verdict is shown the score they
  actually received, produced by the rules that actually applied.
- Every version's methodology stays published at `/methodology?v=<version>` forever. Removing an old
  methodology page would strand every score ever rendered under it.
- `spec/risk-score.md` is the source of truth for weights and thresholds, and `/methodology` renders it.
  The requirement is a test that the page and `score` agree.

---

## 8. Route table

Declared in full in `worker/router.ts`. **That file has one owner; no
contributor edits it.** A session fills in its handler in `worker/routes/<tool>.ts` and nothing else.

| Route | Methods | Neg. | Handler |
| --- | --- | --- | --- |
| `/` | GET | ✅ | | `routes/index.ts` |
| `/inspect` | GET | ✅ | | `routes/inspect.ts` |
| `/verify` | GET, POST | ✅ | | `routes/verify.ts` |
| `/policy` | GET | ✅ | | `routes/policy.ts` |
| `/history` | GET | ✅ | | `routes/history.ts` |
| `/compare`, `/compare/:category` | GET | ✅ | | `routes/compare.ts` |
| `/replay` | GET | ✅ | | `routes/replay.ts` |
| `/methodology` | GET | ✅ | | `routes/methodology.ts` |
| `/crawler` | GET | ✅ | | `routes/crawler-info.ts` |
| `/errors` | GET | ✅ | | `routes/errors-page.ts` |
| `/s/:id` | GET | ✅ | | `routes/share.ts` |
| `/robots.txt` | GET | — | | `routes/well-known.ts` |
| `/llms.txt` | GET | — | | `routes/well-known.ts` |
| `/sitemap.xml` | GET | — | | `routes/well-known.ts` |
| `/.well-known/security.txt` | GET | — | | `routes/well-known.ts` |
| `/assets/*` | GET | — | | `routes/assets.ts` |
| `/api/v1/health` | GET | — | | `routes/health.ts` |
| `/api/v1/meta` | GET | — | | `routes/meta.ts` |
| `/api/v1/schemas`, `/api/v1/schemas/:name` | GET | — | | `routes/schemas.ts` |
| `/api/v1/inspect` | GET, POST | — | | `routes/inspect.ts` |
| `/api/v1/verify` | POST | — | | `routes/verify.ts` |
| `/api/v1/policy/evaluate` | POST | — | | `routes/policy.ts` |
| `/api/v1/history` | GET | — | | `routes/history.ts` |
| `/api/v1/compare` | GET | — | | `routes/compare.ts` |
| `/api/v1/endpoints` | GET | — | | `routes/endpoints.ts` |
| `/api/v1/categories` | GET | — | | `routes/compare.ts` |
| `/api/v1/facilitators` | GET | — | | `routes/facilitators.ts` |
| `/api/v1/replay/share` | POST | — | | `routes/replay.ts` |
| `/api/v1/replay/:id` | GET | — | | `routes/replay.ts` |
| `/api/v1/share` | POST | — | | `routes/share.ts` |
| `/api/v1/share/:id` | GET | — | | `routes/share.ts` |
| `/api/v1/claim`, `/api/v1/claim/:id`, `/:id/verify` | GET, POST | — | | `routes/claim.ts` |
| `/api/v1/appeal` | POST | — | | `routes/claim.ts` |
| `/api/v1/optout` | POST | — | | `routes/optout.ts` |

"Neg." = full three-way content negotiation (§1.2). API routes under `/api/v1/` are JSON only by
construction; their page counterparts carry the markdown and HTML mirrors.

---

## 9. Schema index

`spec/schemas/`, JSON Schema 2020-12, `$id` = `https://tools.tx402.io/api/v1/schemas/<name>`.

| File | Validates |
| --- | --- |
| `common.json` | `Requirement`, `Challenge`, `Check`, `Signal`, `Risk`, `TermChange`, `ProbeMeta`, `Meta`, `Warning` |
| `envelope.json` | The success envelope (§2), with `data` unconstrained |
| `error.json` | The error envelope (§3) |
| `inspect.json` | `/inspect` response |
| `verify.json` | `/verify` response |
| `verify-request.json` | `/verify` request body |
| `policy.json` | `/policy/evaluate` response |
| `policy-request.json` | `/policy/evaluate` request body |
| `history.json` | `/history` response |
| `compare.json` | `/compare` response |
| `replay.json` | `/replay/:id` response, incl. `ReplayAnalysis` |
| `health.json` | `/health` and `/meta` responses |
| `facilitators.json` | `/facilitators` response |
| `challenge-input.json` | The shape of an x402 challenge as served (used to classify fixtures) |

Every response schema composes `envelope.json` with a constrained `data`, so the envelope can never drift
per-tool. `pnpm schema:check` compiles every schema, then validates every fixture listed in
`spec/fixtures/index.json` against its declared schema with its declared expectation.
