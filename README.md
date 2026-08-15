# tx402 tools

Hosted tools for the [x402](https://www.x402.org) payment protocol, at **[tools.tx402.io](https://tools.tx402.io)**.

Inspect what an endpoint charges. Verify a payment challenge before you sign it. Run a spend policy against
one and see which rule fires. Apache-2.0.

## The thing that makes these different

Challenge decoding and policy evaluation here are not a reimplementation. They import
[`tx402`](https://github.com/neogeeks/tx402) and run **the same strict decoder and the same policy engine the
SDK runs before it pays**. So the Inspector's verdict is produced by the code that would actually refuse the
payment — not by a second parser that agrees with it most of the time.

## The tools

| | | |
| --- | --- | --- |
| **402 Inspector** | What does this endpoint charge, on which network, to whom? | `/inspect` |
| **402 Verify** | Is this challenge well-formed and consistent, before I sign it? | `/verify` |
| **402 Policy Playground** | What would my spend policy do with this challenge? | `/policy` |
| **402 History** | How have this endpoint's price and recipient moved? | `/history` |
| **402 Compare** | Which of these endpoints is cheapest and most available? | `/compare` |
| **402 Replay** | This payment failed. What actually happened, and is it safe to retry? | `/replay` |

## Agents are first-class readers

Every tool page serves three representations of the same result:

```bash
curl -H 'Accept: application/json' 'https://tools.tx402.io/inspect?url=https://api.example.com/v1/thing'
```

```bash
curl -H 'Accept: text/markdown' 'https://tools.tx402.io/inspect?url=https://api.example.com/v1/thing'
```

Or append `.md` to any path. JSON Schemas for every response are served at
[`/api/v1/schemas`](https://tools.tx402.io/api/v1/schemas) and frozen in [`spec/`](spec/SPEC.md).

## Two properties worth stating plainly

**This service cannot pay.** There is no signer, no key, and no payment-signature construction anywhere in
this repository. A CI gate fails the build on the shape of either. The probe reads the 402 challenge and
stops. See [SECURITY.md](SECURITY.md).

**A risk band describes our observations, not an operator.** LOW, MEDIUM and HIGH say how much of what we
check we were able to confirm. The scoring function is a versioned, deterministic, published pure function —
never a model — and any operator can claim an endpoint, correct a fact or opt out. See
[docs/abuse-policy.md](docs/abuse-policy.md).

The `tx402` SDK itself operates **no backend** and makes no telemetry calls. That claim stays true because
these hosted tools are a separate origin, a separate repository, and separate npm packages
(`tx402-tools`, `tx402-tools-mcp`). The SDK never contacts this service.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm check
```

`pnpm check` runs lint, typecheck, tests, and the three gates that have to stay green forever:

| Gate | What it enforces |
| --- | --- |
| `pnpm gate:no-signer` | No signer, key material or payment-signature construction, anywhere |
| `pnpm gate:tokens` | No colour outside `ui/tokens.css` |
| `pnpm schema:check` | Every frozen fixture validates against `spec/schemas/` |

Database:

```bash
pnpm db:migrate:local
```

## Layout

```
spec/          Frozen API contracts, JSON Schemas and challenge fixtures
worker/        The Worker: router (one owner), route handlers, probe core
ui/            Design tokens and the component primitives every page composes
packages/      tx402-tools (CLI) and tx402-tools-mcp
migrations/    D1 schema; numbered, never edited once landed
```

`spec/SPEC.md` is the contract and it is frozen — changes go through
