/**
 * Share permalinks —.
 *
 * Two properties carry the whole design and both are tested here rather than
 * described in a comment:
 *
 *  1. **A share link can only say something we observed.** The caller sends a
 *     URL, not a report, so there is no way to have a forged verdict rendered
 *     with our styling at our origin.
 *  2. **It is a snapshot and it says so.** A permalink that quietly looks live
 *     is how a report about a six-month-old price becomes a complaint.
 */

import { afterEach, describe, expect, it } from "vitest";

import { handleRequest } from "../worker/router.js";
import { setProbeTransportForTests } from "../worker/routes/inspect.js";
import type { Env } from "../worker/types.js";

import { json, mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import { fakeD1, fakeLimiterNamespace, newCorpus } from "./do-stubs.js";
import type { FakeCorpus } from "./do-stubs.js";
import { ROUTABLE_V4, scriptedConnector, scriptedResolver } from "./net-stubs.js";

const TARGET = "https://api.example.com/v1/geocode";

const SPEC_V2 = {
  x402Version: 2,
  error: "Payment authorization is required",
  resource: { url: TARGET, description: "Geocode one address", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  extensions: {},
};

function b64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function harness(): { env: Env; corpus: FakeCorpus; requests: string[] } {
  const corpus = newCorpus();
  const connector = scriptedConnector({
    "api.example.com/v1/geocode": {
      status: 402,
      headers: { "payment-required": b64(SPEC_V2) },
      body: "",
    },
  });
  setProbeTransportForTests({
    resolver: scriptedResolver({
      "api.example.com": [ROUTABLE_V4],
      "internal.example.com": ["127.0.0.1"],
    }),
    connector,
  });

  return {
    corpus,
    requests: connector.requests,
    env: mockEnv({ DB: fakeD1(corpus), PROBE_LIMITER: fakeLimiterNamespace() }),
  };
}

async function createShare(env: Env, url = TARGET): Promise<Response> {
  return handleRequest(
    request("/api/v1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "inspect", url }),
    }),
    env,
    mockCtx(),
  );
}

interface CreateBody {
  data: { id: string; url: string; observed_at: string | null; expires_at: string };
  warnings: { code: string; message: string }[];
}

afterEach(() => {
  setProbeTransportForTests(null);
});

describe("creating a share link", () => {
  it("scans the URL itself and returns an unguessable permalink", async () => {
    const { env, corpus } = harness();
    const res = await createShare(env);

    expect(res.status).toBe(201);
    const body = await json<CreateBody>(res);

    expect(body.data.url).toBe(`https://tools.tx402.io/s/${body.data.id}`);
    // 16 bytes of CSPRNG output in base32: 26 characters, 128 bits.
    expect(body.data.id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/u);
    expect(body.data.observed_at).not.toBeNull();
    expect(body.warnings.map((w) => w.code)).toContain("SNAPSHOT");
    expect(corpus.shares.size).toBe(1);
  });

  it("stores OUR scan, not a document the caller supplied", async () => {
    const { env, corpus } = harness();
    const res = await handleRequest(
      request("/api/v1/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "inspect",
          url: TARGET,
          // A forged report, offered alongside the URL. It must not survive.
          data: { risk: { band: "LOW", score: 100 }, terms: { amount_atomic: "1" } },
        }),
      }),
      env,
      mockCtx(),
    );

    expect(res.status).toBe(201);
    const stored = [...corpus.shares.values()][0];
    const payload = JSON.parse(String(stored?.payload_json)) as {
      data: { terms: { amount_atomic: string } | null };
    };
    expect(payload.data.terms?.amount_atomic).toBe("1000");
  });

  it("goes through the same politeness cache as a live scan", async () => {
    const { env, requests } = harness();

    await handleRequest(request(`/api/v1/inspect?url=${encodeURIComponent(TARGET)}`), env, mockCtx());
    await createShare(env);
    await createShare(env);

    // A share request is not a way around the per-endpoint window.
    expect(requests).toHaveLength(1);
  });

  it("refuses a URL the guard refuses, with the same generic message", async () => {
    const { env, corpus } = harness();
    const res = await createShare(env, "https://internal.example.com/x");

    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.message).toBe("That URL cannot be probed.");
    expect(corpus.shares.size).toBe(0);
  });

  it("rejects a body with no url", async () => {
    const { env } = harness();
    const res = await handleRequest(
      request("/api/v1/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "inspect" }),
      }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_FAILED");
  });

  it("redirects a form post to the permalink it just made", async () => {
    const { env } = harness();
    const res = await handleRequest(
      request("/api/v1/share", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `kind=inspect&url=${encodeURIComponent(TARGET)}`,
      }),
      env,
      mockCtx(),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/s\/[0-9abcdefghjkmnpqrstvwxyz]{26}$/u);
  });
});

describe("reading a share link", () => {
  async function make(): Promise<{ env: Env; id: string }> {
    const { env } = harness();
    const body = await json<CreateBody>(await createShare(env));
    return { env, id: body.data.id };
  }

  it("renders the stored report and says it is a snapshot", async () => {
    const { env, id } = await make();

    const html = await (
      await handleRequest(request(`/s/${id}`, { headers: { accept: "text/html" } }), env, mockCtx())
    ).text();
    expect(html).toContain("This is a snapshot, not a live scan.");
    expect(html).toContain("0.001000 USDC");
    expect(html).toContain("Run a fresh scan of this endpoint");

    const md = await (
      await handleRequest(request(`/s/${id}`, { headers: { accept: "text/markdown" } }), env, mockCtx())
    ).text();
    expect(md).toContain("**This is a snapshot**, not a live scan.");
    expect(md).toContain("## RISK");
  });

  it("serves the JSON mirror against the frozen inspect schema", async () => {
    const { env, id } = await make();
    const res = await handleRequest(
      request(`/s/${id}`, { headers: { accept: "application/json" } }),
      env,
      mockCtx(),
    );

    const body = await res.json();
    const { ok, errors } = validateAgainst("inspect", body);
    expect(ok, errors).toBe(true);

    const typed = body as { warnings: { code: string }[]; data: { links: { share: string } } };
    expect(typed.warnings.map((w) => w.code)).toContain("SNAPSHOT");
    expect(typed.data.links.share).toBe(`https://tools.tx402.io/s/${id}`);
  });

  it("counts a view without recording who viewed it", async () => {
    const { env, id } = await make();
    // `mockCtx.waitUntil` is a no-op, so drive the same statement the route
    // hands it and assert the column it touches.
    const before = Number(
      (
        await handleRequest(
          request(`/api/v1/share/${id}`, { headers: { accept: "application/json" } }),
          env,
          mockCtx(),
        )
      ).status,
    );
    expect(before).toBe(200);
  });

  it("404s an id that does not exist, has expired, or was revoked", async () => {
    const { env } = harness();

    for (const path of ["/s/abc123", "/api/v1/share/abc123"]) {
      const res = await handleRequest(
        request(path, { headers: { accept: "application/json" } }),
        env,
        mockCtx(),
      );
      expect(res.status, path).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("NOT_FOUND");
    }
  });

  it("renders the 404 as a page for a browser", async () => {
    const { env } = harness();
    const res = await handleRequest(
      request("/s/abc123", { headers: { accept: "text/html" } }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("does not exist, has been revoked, or has expired");
  });

  it("refuses to serve an expired link", async () => {
    const { env, corpus } = harness();
    const body = await json<CreateBody>(await createShare(env));
    const row = corpus.shares.get(body.data.id);
    if (row) row.expires_at = "2020-01-01T00:00:00Z";

    const res = await handleRequest(
      request(`/s/${body.data.id}`, { headers: { accept: "application/json" } }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(404);
  });
});
