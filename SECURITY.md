# Security policy

## Reporting a vulnerability

Email **<security@tx402.io>**. Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. A proof of concept helps. We will acknowledge
within 3 business days and keep you updated until it is resolved. If you would like credit in the fix notes,
say so and tell us how to name you.

Please do not run automated scanners against `tools.tx402.io`, and please do not use it to probe third-party
endpoints as part of testing — the endpoints on the other side belong to other people.

## What this service is, in security terms

`tools.tx402.io` is a public service whose core function is **fetching URLs that strangers supply and telling
strangers about the result**. That is an SSRF engine and a DDoS amplifier unless it is built not to be. Two
properties carry most of the weight:

### It cannot pay

There is no signer, no private key, no wallet and no payment-signature construction anywhere in this
repository. The probe reads the 402 challenge and stops.

This is enforced by `pnpm gate:no-signer`, which runs on every CI job and fails the build on the *shape* of
key material or signature construction in any source directory. Documentation is allowed to name these things
in order to promise we do not do them; code is not allowed to contain them. If this service could pay, it
would be a custody and abuse liability, so it cannot.

### It will not fetch what it should not

The URL guard (`worker/lib/guard.ts`) is a whole session's worth of work on its own, and its properties are
non-negotiable:

- `https:` only for the hosted probe. `http:` exists only in the local CLI, where the target is the
  developer's own machine.
- **DNS is resolved and the resolved addresses are checked** — not the hostname. RFC1918, loopback,
  link-local, CGNAT, IPv6 ULA, IPv4-mapped IPv6 and `169.254.169.254` are all refused, and so are the
  alternate encodings people reach for (decimal, hex, octal, short-form dotted).
- The validated address is **pinned for the connection**, so a name that resolves publicly once and privately
  the second time cannot be used to rebind onto an internal host.
- Every redirect hop is re-validated. At most 3 hops, never into private space, never cross-scheme.
- A URL containing userinfo is refused, not sanitised.
- No cookies, no `Authorization`, no credential forwarding, ever.
- Hard caps on connect time, total time, response bytes, header count and header size.

The hostile-input table these are tested against is frozen at `spec/fixtures/hostile/urls.json`, and it is
extended — never trimmed — as new cases are found.

Every refusal returns the **same generic message** to the caller. The differentiation is coarse and internal.
A guard that explains precisely why it refused is a network scanner with extra steps.

## Data

- No IP addresses are stored, in any form, including hashed. No cookies. No visitor identifiers. No visitor
  user agents.
- Rate-limit state lives in a Durable Object with salted, coarse, short-lived keys, and never reaches the
  database.
- Replay traces may contain secrets, so **redaction runs client-side, before upload**. The server never
  receives an unredacted trace and there is no column in which one could be stored. Sharing is opt-in per
  trace, the link is unguessable, and it expires.
- Sign-in tokens are stored only as hashes, so a dump of that table cannot be used to sign in as anybody.
- Accounts exist for one reason — delivering the alerts a person asked for — and are the only place a person
  is identified.

## Scope

In scope: `tools.tx402.io`, this repository, and the `tx402-tools` / `tx402-tools-mcp` packages.

Out of scope: the `tx402` SDK (report those at <https://github.com/neogeeks/tx402>), third-party endpoints
listed in the corpus, and findings that require a compromised end-user device.

We are particularly interested in: SSRF or DNS-rebinding bypasses of the URL guard, any path that causes this
service to make a request it should have refused, amplification against a third-party endpoint, and anything
that would let a caller influence what is recorded about *someone else's* endpoint.
