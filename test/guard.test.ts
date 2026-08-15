/**
 * The hostile URL table, run as tests.
 *
 * `spec/fixtures/hostile/urls.json` is its exit criteria made concrete: every
 * `reject` row must be refused with the stated code, and — just as important —
 * every `allow` row must go through. A guard that refuses everything passes no
 * test worth having.
 *
 * The table is read from the fixture rather than restated here, so a row added
 * 's red-team session becomes a test the moment it is added, and a row
 * cannot be quietly skipped by editing the test file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GUARD_LIMITS,
  canonicalizeUrl,
  classifyAddress,
  endpointId,
  guardedFetch,
  parseAddress,
  validateUrl,
} from "../worker/lib/guard.js";
import {
  ROUTABLE_V4,
  hostileConnector,
  hostileResolver,
  scriptedConnector,
  scriptedResolver,
} from "./net-stubs.js";

interface HostileCase {
  id: string;
  url: string;
  expect: "allow" | "reject";
  code: string | null;
  resolves: boolean;
  note: string | null;
}

const table = JSON.parse(
  readFileSync(join(__dirname, "../spec/fixtures/hostile/urls.json"), "utf8"),
) as { cases: HostileCase[] };

/**
 * The fixture leaves one row as a placeholder: `url-too-long` carries a marker
 * rather than an actual over-length URL, with the note " expands the query to
 * exceed the 4096-char cap". This is that expansion.
 */
function materialize(testCase: HostileCase): string {
  if (testCase.id === "url-too-long") {
    return `https://api.example.com/v1?q=${"A".repeat(GUARD_LIMITS.maxUrlLength)}`;
  }
  return testCase.url;
}

async function runCase(testCase: HostileCase) {
  return guardedFetch(materialize(testCase), {
    resolver: hostileResolver(),
    connector: hostileConnector(),
    // Short budgets so the timeout rows finish quickly without changing which
    // branch they exercise.
    limits: { totalTimeoutMs: 300, hopTimeoutMs: 200 },
  });
}

describe("hostile URL table", () => {
  it("covers every row in the frozen fixture", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(44);
  });

  for (const testCase of table.cases) {
    const label = `${testCase.id} — ${testCase.expect}${testCase.code ? ` ${testCase.code}` : ""}`;

    it(label, async () => {
      const result = await runCase(testCase);

      if (testCase.expect === "allow") {
        // The allow rows matter as much as the reject rows: over-blocking is a
        // broken product, it is just a broken product that looks safe.
        expect(result.ok, `${testCase.id} should be allowed`).toBe(true);
        return;
      }

      expect(result.ok, `${testCase.id} should be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.failure.code, `${testCase.id} refusal code`).toBe(testCase.code);
      }
    });
  }
});

describe("refusals do not leak internal detail", () => {
  it("every blocked-URL refusal carries only a coarse stage", async () => {
    const blocked = table.cases.filter(
      (c) =>
        c.expect === "reject" &&
        ["URL_BLOCKED", "URL_PRIVATE_ADDRESS", "URL_SCHEME_NOT_ALLOWED"].includes(
          c.code ?? "",
        ),
    );
    expect(blocked.length).toBeGreaterThan(0);

    for (const testCase of blocked) {
      const result = await runCase(testCase);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // `stage` is the ONLY thing that reaches a caller beyond the generic
        // sentence in worker/http.ts, so it must stay a member of the coarse
        // vocabulary and never become "10.0.0.5 is private".
        expect(["url", "dns", "redirect", "response", "transport"]).toContain(
          result.failure.stage,
        );
      }
    }
  });
});

describe("address parsing", () => {
  // The fixture warns that WHATWG normalizes some alternate encodings and not
  // others, and that it differs between engines. These assert the parser's own
  // behaviour, so the verdict does not depend on whose URL implementation ran.
  const alternates: [string, string][] = [
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["127.0.1", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["010.0.0.5", "8.0.0.5"],
  ];

  for (const [input, expected] of alternates) {
    it(`decodes ${input} as ${expected}`, () => {
      expect(parseAddress(input)?.text).toBe(expected);
    });
  }

  it("unwraps every IPv4 embedding in IPv6", () => {
    for (const literal of [
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[64:ff9b::7f00:1]",
      "[2002:7f00:1::]",
    ]) {
      const parsed = parseAddress(literal);
      expect(parsed, literal).not.toBeNull();
      expect(classifyAddress(parsed!), literal).toBe("loopback");
    }
  });

  it("leaves genuinely public addresses public", () => {
    for (const literal of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "[2606:4700::1]"]) {
      const parsed = parseAddress(literal);
      expect(parsed, literal).not.toBeNull();
      expect(classifyAddress(parsed!), literal).toBe("public");
    }
  });

  it("does not mistake a hostname for an address", () => {
    for (const host of ["api.example.com", "example", "1.2.3.4.5", "999.1.1.1"]) {
      expect(parseAddress(host), host).toBeNull();
    }
  });

  it("rejects 172.16/12 but allows 172.32", () => {
    expect(classifyAddress(parseAddress("172.16.0.1")!)).toBe("private");
    expect(classifyAddress(parseAddress("172.31.255.255")!)).toBe("private");
    expect(classifyAddress(parseAddress("172.32.0.0")!)).toBe("public");
    expect(classifyAddress(parseAddress("172.15.255.255")!)).toBe("public");
  });
});

describe("DNS rebinding", () => {
  /**
   * The property asks for, tested the only way it can be: a
   * resolver that answers a public address first and a private one afterwards.
   * A guard that resolves once, validates, and then lets the platform resolve
   * again would connect to 127.0.0.1 here.
   */
  it("refuses when the second lookup answers with a private address", async () => {
    const resolver = scriptedResolver({
      "rebind.example.net": (call) => (call === 1 ? [ROUTABLE_V4] : ["127.0.0.1"]),
    });
    const connector = scriptedConnector({ "rebind.example.net/v1": { status: 200 } });

    const result = await guardedFetch("https://rebind.example.net/v1", {
      resolver,
      connector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("URL_PRIVATE_ADDRESS");

    // The real assertion: no request was ever made. Refusing after connecting
    // to the metadata service would be a detection, not a defence.
    expect(connector.requests).toEqual([]);
    expect(resolver.lookups.get("rebind.example.net")).toBeGreaterThanOrEqual(2);
  });

  it("refuses an RRset that mixes public and private answers", async () => {
    const connector = scriptedConnector({ "split.example.net/v1": { status: 200 } });
    const result = await guardedFetch("https://split.example.net/v1", {
      resolver: hostileResolver(),
      connector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("URL_PRIVATE_ADDRESS");
    expect(connector.requests).toEqual([]);
  });
});

describe("redirects", () => {
  it("re-validates every hop and never connects to the private target", async () => {
    const connector = hostileConnector();
    const result = await guardedFetch(
      "https://redirector.example.net/to-internal",
      { resolver: hostileResolver(), connector },
    );

    expect(result.ok).toBe(false);
    // One request — the redirector. The 10.0.0.5 hop was refused before it was
    // ever attempted.
    expect(connector.requests).toHaveLength(1);
    expect(connector.requests[0]).toContain("redirector.example.net");
  });

  it("follows a legitimate redirect and reports the hop count", async () => {
    const result = await guardedFetch("https://redirector.example.net/once", {
      resolver: hostileResolver(),
      connector: hostileConnector(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redirectCount).toBe(1);
      expect(result.value.status).toBe(402);
      expect(result.value.finalUrl.hostname).toBe("api.example.com");
    }
  });

  it("stops at the documented hop limit", async () => {
    const connector = hostileConnector();
    const result = await guardedFetch("https://redirector.example.net/loop", {
      resolver: hostileResolver(),
      connector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("TOO_MANY_REDIRECTS");
    expect(connector.requests).toHaveLength(GUARD_LIMITS.maxRedirects + 1);
  });
});

describe("credentials are never forwarded", () => {
  it("sends no authorization, cookie or caller-supplied header", async () => {
    const seen: Record<string, string>[] = [];
    const connector = scriptedConnector({ "api.example.com/v1/geocode": { status: 402 } });
    const recording = {
      ...connector,
      fetch: (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }, pin: Parameters<typeof connector.fetch>[2]) => {
        seen.push(init.headers);
        return connector.fetch(url, init, pin);
      },
    };

    await guardedFetch("https://api.example.com/v1/geocode", {
      resolver: hostileResolver(),
      connector: recording,
    });

    expect(seen).toHaveLength(1);
    const keys = Object.keys(seen[0]!).map((k) => k.toLowerCase());
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("cookie");
    expect(keys).not.toContain("proxy-authorization");
    // The documented crawler UA.
    expect(seen[0]!["user-agent"]).toContain("tx402-tools-crawler");
  });
});

describe("canonicalization (SPEC §1.5)", () => {
  it("sorts the query, strips the default port, and drops a trailing dot", () => {
    const cases: [string, string][] = [
      ["https://API.Example.com/v1?b=2&a=1", "https://api.example.com/v1?a=1&b=2"],
      ["https://api.example.com./v1", "https://api.example.com/v1"],
      ["https://api.example.com:443/v1", "https://api.example.com/v1"],
      ["https://api.example.com:8443/v1", "https://api.example.com:8443/v1"],
      ["https://api.example.com", "https://api.example.com/"],
      ["https://api.example.com/v1#frag", "https://api.example.com/v1"],
    ];
    for (const [input, expected] of cases) {
      expect(canonicalizeUrl(new URL(input)), input).toBe(expected);
    }
  });

  it("preserves path case and trailing slash", () => {
    expect(canonicalizeUrl(new URL("https://api.example.com/V1/Geo/"))).toBe(
      "https://api.example.com/V1/Geo/",
    );
  });

  it("gives the trailing-dot form the same endpoint id as the bare form", async () => {
    // The fixture is explicit that this must not become a cache-key bypass:
    // two spellings of one endpoint must not get two politeness windows.
    const withDot = validateUrl("https://api.example.com./v1");
    const without = validateUrl("https://api.example.com/v1");
    expect(withDot.ok && without.ok).toBe(true);
    if (withDot.ok && without.ok) {
      expect(await endpointId(withDot.value.canonical)).toBe(
        await endpointId(without.value.canonical),
      );
    }
  });

  it("produces a 32-character lowercase hex id", async () => {
    expect(await endpointId("https://api.example.com/v1")).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("response caps", () => {
  it("aborts an oversized body instead of buffering it", async () => {
    const result = await guardedFetch("https://slowloris.example.net/huge", {
      resolver: hostileResolver(),
      connector: hostileConnector(),
      limits: { maxBodyBytes: 1024 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("bounds a response that trickles forever with the TOTAL budget", async () => {
    const started = Date.now();
    const result = await guardedFetch("https://slowloris.example.net/slow", {
      resolver: hostileResolver(),
      connector: hostileConnector(),
      limits: { totalTimeoutMs: 300, hopTimeoutMs: 200 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("PROBE_TIMEOUT");
    // A connect-only timeout would never fire here, because the connect
    // succeeded instantly and it is the body that never ends.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("caps header count and total header size", async () => {
    const result = await guardedFetch("https://slowloris.example.net/headers", {
      resolver: hostileResolver(),
      connector: hostileConnector(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("RESPONSE_TOO_LARGE");
  });
});
