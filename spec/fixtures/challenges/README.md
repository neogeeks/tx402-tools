# Frozen challenge fixtures

Written, consumed (guard + probe + signals), (verify), (replay) and / (CLI + MCP).
`spec/fixtures/index.json` is the machine-readable manifest: every fixture, the schema it is checked against,
and whether it is expected to satisfy that schema.

Two things these fixtures are **not**:

- They are not a substitute for `decodePaymentRequired`. `challenge-input.json` describes the *loose* wire
  shape; the authoritative decoder is the one imported from `tx402`, and several fixtures here satisfy the
  loose shape while being correctly rejected by the strict decoder (that is the point of them).
- They are not exhaustive. its red-team session extends them; nothing here is deleted when it does.

## One deliberate uncertainty, flagged rather than guessed

`v2-dynamic-payto.decoded.json` declares dynamic `payTo` with `extra.payToMode = "dynamic"`.

** must confirm the real declaration key against the x402 v2 specification and record what it found**. It is
* marked `needs_confirmation: true` in `index.json`. The *carve-out* it exercises is
frozen and not up for debate (SPEC §6.4: a recipient may only count against a score when it is unstable
**and not declared dynamic**) — only the spelling of the declaration is open. Freezing a guessed key and
letting four sessions build on it is how a wrong field name becomes load-bearing.

## Files

| File | What it is |
| --- | --- |
| `v1-body-valid.json` | x402 **v1**: challenge in the JSON response body, legacy `network: "base"` naming |
| `v2-header-valid.decoded.json` | x402 **v2** challenge, decoded — CAIP-2 network id |
| `v2-header-valid.txt` | the same challenge as it appears on the wire: the `PAYMENT-REQUIRED` header value |
| `v2-dynamic-payto.decoded.json` / `.txt` | a marketplace declaring a per-request payout address |
| `malformed-not-json.txt` | a `PAYMENT-REQUIRED` header whose decoded body is not JSON |
| `malformed-missing-accepts.json` | well-formed JSON, no `accepts` — the most common real-world mistake |

Hostile inputs live in `./hostile/`.
