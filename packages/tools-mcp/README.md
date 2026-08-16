# tx402-tools-mcp

An MCP server for agents that are about to pay something.

| Tool | Answers | Network |
| --- | --- | --- |
| `inspect_endpoint` | What does this x402 endpoint charge, on which network, to whom — and what has been observed about it before? | Asks [tools.tx402.io](https://tools.tx402.io) |
| `verify_challenge` | Is this payment challenge well-formed and internally consistent? | **None.** Runs locally, sends nothing |

The buyers in this economy are agents, and the x402 Bazaar already indexes MCP tools alongside HTTP
endpoints. The point of this package is placement: an agent about to pay something should be able to ask
what it is about to pay, inside the client it is already running in.

---

## It cannot pay

This server **holds no keys, constructs no payment authorization, and has no signer.** That is not a promise
in a document: the repository it is built from is scanned in CI (`pnpm gate:no-signer`) for the *shape* of
key material and of signature construction, and the build fails if either appears. What it does is read the
public payment challenge an endpoint serves to anyone who asks, and stop.

There is also nothing to sign in to. No account, no API key, no token, no config file holding a secret — the
hosted API is public and rate-limited per endpoint, not per caller.

---

## Install it in a client

### Claude Code

```bash
claude mcp add-json tx402-tools --scope user '{"command":"npx","args":["-y","tx402-tools-mcp"]}'
```

Or add it to `.mcp.json` in a project, which shares it with everyone working in that repo:

```json
{
  "mcpServers": {
    "tx402-tools": {
      "command": "npx",
      "args": ["-y", "tx402-tools-mcp"]
    }
  }
}
```

Check it connected with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "tx402-tools": {
      "command": "npx",
      "args": ["-y", "tx402-tools-mcp"]
    }
  }
}
```

### Any other stdio MCP client

Command `npx -y tx402-tools-mcp`, transport stdio. No arguments, no environment, no credentials.

> **Running it from a checkout instead.** The `npx` blocks above use the published package. To run your own
> build — which is what you want if you are changing this server — build it and point the client at the bin:
>
> ```bash
> pnpm install && pnpm --filter tx402-tools-mcp build
> ```
>
> ```json
> {
>   "mcpServers": {
>     "tx402-tools": {
>       "command": "node",
>       "args": ["/absolute/path/to/tx402-tools/packages/tools-mcp/bin/tx402-tools-mcp.mjs"]
>     }
>   }
> }
> ```

---

## The tools

### `inspect_endpoint(url)`

Sends the URL to `tools.tx402.io`, which fetches the endpoint, reads its 402 challenge and stops. Returns the
declared terms — amount, asset, network, recipient, authorization window — the named checks that ran against
them, and what has been observed about the endpoint over time, including recorded changes to its price or
recipient.

The hosted probe cannot reach `localhost` or private address space, and refuses a URL carrying credentials
rather than stripping them.

### `verify_challenge(challenge, url?)`

Runs **entirely on the machine the server is running on.** It makes no network request of any kind and the
challenge is not sent anywhere. That is the product, not an optimisation: you verify a challenge at the
moment you are about to sign it, and shipping it to a third party to find out whether it parses would make a
hosted outage into a payment outage.

It decodes the challenge with `decodePaymentRequired` imported from [`tx402`](https://www.npmjs.com/package/tx402)
— the same strict decoder a tx402 buyer runs before it signs anything — and reports the frozen check ids from
the specification: canonical atomic amount, positive amount, well-formed recipient for the declared network,
resource origin matching the endpoint that served the challenge, sane authorization window, network and asset
against the tx402 signed release manifest, base64 strictness, size, depth, duplicate keys, and the rest.

Pass `url` whenever you have it. Without it `resource_origin_match` has no origin to compare against and
reports `SKIP` rather than `PASS`. The URL is not fetched.

Three checks — `amount_within_observed_range`, `recipient_matches_observed`, `endpoint_known` — need
observation history and always report `SKIP` here. To run them, call `inspect_endpoint`. That is a separate,
explicit call, never a silent fallback to the network.

---

## How to read what comes back

- **`SKIP` is not `PASS`.** A skipped check could not run. It is not a check that passed and it is not a
  finding.
- **"Not observed" is not `false`.** A signal we could not determine contributes nothing to the score.
- **No history is the normal state for a new endpoint,** not a degraded one.
- **`LOW` / `MEDIUM` / `HIGH` is the level of caution the signals we could observe support.** It describes the
  confidence of our observations, never the character or intent of whoever operates an endpoint. The
  weights and thresholds are published at [tools.tx402.io/methodology](https://tools.tx402.io/methodology) and
  every result carries the `score_version` that produced it, so a score is reproducible from the raw signals
  in the same result.
- **"Recognized" and "known" mean present on a list we publish.** The lists are public and are not
  exhaustive.
- **An unreachable service is reported as an unreachable service.** If `tools.tx402.io` cannot be reached, or
  answers with something that does not match its own published JSON Schema, the tool returns an error saying
  so and nothing else. It never invents a verdict, so an error means you know nothing new — not that the
  endpoint is fine.

---

## Configuration

One optional environment variable, and it is not a credential:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TX402_TOOLS_API` | `https://tools.tx402.io` | Point `inspect_endpoint` at a local `wrangler dev` instead of production. |

---

Not to be confused with `tx402-mcp`, which is an unrelated project by a different author.

Apache-2.0. Source: [neogeeks/tx402-tools](https://github.com/neogeeks/tx402-tools).
