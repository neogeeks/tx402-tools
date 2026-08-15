# tx402-tools

The x402 utilities from [tools.tx402.io](https://tools.tx402.io), on your machine.

```
tx402-tools inspect <url>     what does this endpoint charge, and to whom
tx402-tools verify [input]    check a challenge before you sign it (offline)
tx402-tools history <url>     how the terms have moved
tx402-tools compare <urls…>   endpoints side by side
tx402-tools replay <trace>    reconstruct a failed payment lifecycle
```

```bash
npm i -g tx402-tools
```

Three things worth knowing before anything else.

**It can reach `localhost`, and the website cannot.** The hosted probe refuses `http:` and refuses private
address space entirely, because "paste a URL and we fetch it" on a public service is an SSRF engine pointed at
other people's paid APIs. On your own machine the URL comes from your own shell, so the CLI takes `http:` by
default and takes private space behind `--allow-private`. Debugging your own 402 endpoint on `localhost:3000`
is the reason this package exists.

**`verify` runs offline and sends nothing.** Not "sends nothing unless you pass a flag" — the offline path
makes zero network calls, and there is a test that installs traps on `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource` and the guard's own connector and fails if any of them is touched. You verify a challenge at the
moment you are about to sign it, and at that moment a tool that phones home is a tool that leaks what you are
about to buy. `--enrich` is the explicit opt-in that asks the corpus.

**It cannot pay.** No signer, no key material, no payment authorization is constructed anywhere in this
package, and CI greps for it. What it *can* do is read a trace describing a payment you already made — and
`replay` redacts that trace before anything leaves your machine, whether or not you ask it to.

For the buyer SDK that actually pays — policy and budget committed before any signer is touched — see
[`tx402`](https://www.npmjs.com/package/tx402). It operates no backend and never contacts this service. That
separation is why this is a different package rather than a flag on that one.

---

## Exit codes

The table is the SDK's, deliberately: `if [ $? -eq 8 ]` means the same thing in a script that replays a trace
as in the script that produced it.

| code | name | when |
| --- | --- | --- |
| `0` | success | the command answered and nothing it checked failed |
| `2` | usage | bad arguments, unreadable input, or a URL this CLI refuses |
| `3` | policy | `replay`: a policy stage stopped the call |
| `4` | liquidity | `replay`: insufficient balance |
| `5` | protocol | a challenge `tx402` would refuse — `verify` verdict `fail`, or `inspect` on an endpoint that serves no decodable challenge |
| `6` | signer | `replay`: the signer failed |
| `7` | transport | the endpoint, or the hosted API, could not be reached |
| **`8`** | **ambiguous payment** | **money may have moved. Do not retry — the merchant may hold a valid authorization, and a retry can pay twice.** |
| `9` | resource failure | `replay`: paid, and the resource still did not arrive |

Two rules that keep the table honest:

- **`8` is only ever a real ambiguity.** Only `replay` can emit it, and only when the reconstruction puts the
  money in an `exposed` or `committed` state. A tool that cried wolf would bury the one case that matters.
- **The exit code never encodes a risk band.** `LOW` / `MEDIUM` / `HIGH` describes the confidence of our
  observations, not a merchant's character. A `HIGH` band on a challenge that decodes exits `0`.

---

## inspect

```bash
tx402-tools inspect https://api.example.com/v1/geocode
```

Probes from your machine and prints the same report `tools.tx402.io/inspect` renders — same probe, same
decoder, same scoring function, same renderer. The `observed` section is empty because the corpus lives on the
server; `--hosted` asks for that instead.

| flag | |
| --- | --- |
| `--allow-private` | probe loopback, RFC1918, link-local and CGNAT space |
| `--no-http` | narrow to `https:`, as the hosted probe is |
| `--insecure` | skip certificate validation — your own dev server, nothing else |
| `--timeout <ms>` | total budget for the probe, redirects included |
| `--hosted` | ask `tools.tx402.io` instead, for the observed history |

```bash
tx402-tools inspect http://localhost:3000/paid --allow-private
```

Everything the hosted guard enforces still applies with `--allow-private` on: a URL carrying credentials is
refused rather than stripped, redirects are capped and never cross-scheme, the body cap aborts the read
instead of buffering, and no header from your environment is ever forwarded.

**Real address pinning.** The CLI resolves with `node:dns`, validates every record in the answer, and then
connects to the address it validated — by overriding the socket's `lookup`, so TLS still performs SNI and
still validates the real certificate. There is no second resolution to lose a race with. A Cloudflare Worker
cannot do this, which is why the hosted probe compensates with double resolution instead.

## verify

```bash
tx402-tools verify --header eyJ4NDAyVmVyc2lvbiI6Mi…
tx402-tools verify challenge.json --url https://api.example.com/v1/geocode
curl -sI https://api.example.com/v1/geocode | grep -i payment-required | tx402-tools verify -
```

Runs the 21 offline checks from the frozen contract and aggregates them with the frozen rule: `fail` if any
check failed, else `warn` if any warned, else `pass`. The three corpus-dependent checks report `skip` rather
than being omitted — "we did not look" must not read as "there was nothing to find".

`--url` matters: without it, `resource_origin_match` reports `skip` and never `pass`, because we cannot
compare an origin to one we were not given.

## history · compare

```bash
tx402-tools history https://api.example.com/v1/geocode --window 30d
tx402-tools compare --category geocoding
```

These need the corpus, so running one *is* the request to call `tools.tx402.io`. Empty is a real answer and is
rendered as one: an availability series we could not ask for says so, and never shows a zero.

## replay

```bash
tx402 call --json https://api.example.com/v1/geocode | tx402-tools replay -
tx402-tools replay trace.json --share --yes
```

Reads `tx402 call --json`, a serialized `Tx402Error`, a raw HTTP request/response pair or an event trace —
auto-detected — and reconstructs the eight-phase lifecycle. `--share` uploads a **redacted** trace and returns
a permalink; redaction runs on your machine before anything is sent, and the server has no field in which to
store an unredacted one.

---

## Everywhere

| flag | |
| --- | --- |
| `--json` | the response envelope, validating against the frozen schemas |
| `--md` | the markdown report |
| `--origin <url>` | point at a different deployment, or a local `wrangler dev` |
| `--help` `--version` | |

`--json` emits a whole envelope, not a bare payload, so its output validates against the same
`spec/schemas/<tool>.json` the hosted API is tested against and can be diffed against a `curl` of the API.

There is **no config file, no API key and no login.** Nothing in this product authenticates a caller: there is
no account, no email address and no table in which a person could be stored. `TX402_TOOLS_ORIGIN` is the only
environment variable, and it only changes where an already-requested call goes.

## Building from source

```bash
pnpm install
pnpm --filter tx402-tools build
```

One bundled ESM file at `dist/cli.mjs`, with `tx402` left external — so a global install pulls exactly one
dependency, and the replay taxonomy keeps type-checking against the SDK's own error codes rather than a copy.
The package targets Node ≥ 20 even though the repo's own tooling needs 22.

Apache-2.0.
