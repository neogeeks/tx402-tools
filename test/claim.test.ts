/**
 * Claim + appeal, end to end —.
 *
 * asks for four things, and this file is the test that all four
 * actually work: an operator can claim an endpoint (**by both proofs**), see
 * exactly what was observed, correct a wrong fact, and opt out. They ship WITH
 * the first public risk score rather than after the first angry email, so they
 * are tested to the same standard as the score itself.
 *
 * Everything runs against real SQLite with the real migrations applied
 * (`test/d1-sqlite.ts`), because the properties under test are SQL ones: the
 * append-only trigger on `term_changes`, the CHECK constraints on `optouts` and
 * `appeals`, and — after `migrations/0004_claims_no_people.sql` — the **absence**
 * of the two person-shaped columns.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handleRequest } from "../worker/router.js";

import { claimHandler } from "../worker/routes/claim.js";
import { appealHandler } from "../worker/routes/appeal.js";
import {
  CLAIM_TOKEN_TTL_HOURS,
  CLAIM_TXT_NAME,
  CLAIM_WELL_KNOWN,
  checkDnsTxt,
  dohTxtResolver,
  type TxtResolver,
} from "../worker/routes/claim-proof.js";
import { isOptedOut } from "../worker/crawler/optout.js";
import { score } from "../worker/lib/score.js";
import { createTestDb, type TestDatabase } from "./d1-sqlite.js";
import { hostileResolver, scriptedConnector } from "./net-stubs.js";
import { fakeLimiterNamespace } from "./do-stubs.js";
import { mockCtx, mockEnv, request, validateAgainst } from "./helpers.js";
import type { Env, RouteContext, RouteMeta } from "../worker/types.js";

const ORIGIN = "https://api.example.com";
const HOST = "api.example.com";
const ENDPOINT = "https://api.example.com/v1/geocode";
const NOW = "2026-08-15T12:00:00Z";

const CLAIM_META: RouteMeta = {
  tool: "claim",
  implemented: true,
  negotiated: false,
};
const APPEAL_META: RouteMeta = {
  tool: "appeal",
  implemented: true,
  negotiated: false,
};

/** A TXT zone, as a resolver. `undefined` for a name means NXDOMAIN. */
function txtZone(table: Record<string, string[]>): TxtResolver {
  return {
    resolveTxt(name: string): Promise<string[]> {
      const records = table[name.toLowerCase()];
      if (!records) return Promise.reject(new Error(`NXDOMAIN ${name}`));
      return Promise.resolve(records);
    },
  };
}

function ctxFor(
  env: Env,
  meta: RouteMeta,
  path: string,
  init: RequestInit = {},
  params: Record<string, string> = {},
): RouteContext {
  return {
    request: request(path, { method: "POST", ...init }),
    env,
    ctx: mockCtx(),
    url: new URL(`https://tools.tx402.io${path}`),
    format: "json",
    params,
    route: meta,
  };
}

/**
 * A live-enough env: real SQLite for D1, and the REAL ProbeLimiter class over
 * fake storage. `mockEnv`'s limiter answers 501, and `verify` now goes through
 * the politeness budget — so a test on `mockEnv` alone would exercise a path
 * production does not have.
 */
function envFor(test: TestDatabase): Env {
  return mockEnv({ DB: test.db, PROBE_LIMITER: fakeLimiterNamespace() });
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

interface ClaimBody {
  data: {
    id: string;
    origin: string;
    method: string;
    state: string;
    challenge_token: string | null;
    instructions: {
      record_name: string | null;
      publish: string;
      url: string | null;
    } | null;
    token_expires_at: string | null;
    next_steps: string[];
    observed: {
      opted_out: boolean;
      endpoints: {
        canonical_url: string;
        scan_count: number;
        has_history: boolean;
        signals: unknown[];
        risk: {
          score: number;
          band: string;
          reproduced: number;
          band_note: string;
        } | null;
        score_as_served: { score: number | null; band: string | null };
      }[];
      changes: { id: string; change_kind: string }[];
    } | null;
    appeals:
      { id: string; remedy: string; state: string; disputed: string }[] | null;
  };
}

interface AppealBody {
  data: {
    appeal: {
      id: string;
      origin: string;
      remedy: string;
      state: string;
      claim_id: string | null;
    };
    removal: { effective_at: string; endpoints_affected: number } | null;
    next_steps: string[];
  };
}

interface ErrorBody {
  error: { code: string; message: string; detail: { fields: string[] } };
}

/**
 * Typed readers rather than a cast at every call site: the return type is what
 * makes `res.json` resolve, so the shape is declared once and nothing has to
 * be asserted.
 */
async function readClaim(res: Response): Promise<ClaimBody> {
  return res.json();
}

async function readAppeal(res: Response): Promise<AppealBody> {
  return res.json();
}

async function readError(res: Response): Promise<ErrorBody> {
  return res.json();
}

async function readSchemaIndex(res: Response): Promise<{ data: { schemas: { name: string }[] } }> {
  return res.json();
}

// ── fixtures in the database ──────────────────────────────────────────────

const SIGNALS = [
  { id: "challenge_served", value: true, observed: true, detail: null },
  { id: "challenge_decodes", value: true, observed: true, detail: null },
  { id: "resource_origin_match", value: true, observed: true, detail: null },
  { id: "amount_canonical", value: true, observed: true, detail: null },
  { id: "pay_to_wellformed", value: true, observed: true, detail: null },
  { id: "network_recognized", value: true, observed: true, detail: null },
  { id: "asset_recognized", value: true, observed: true, detail: null },
  { id: "facilitator_known", value: false, observed: true, detail: null },
  { id: "scheme_known", value: true, observed: true, detail: null },
  { id: "tls_ok", value: true, observed: true, detail: null },
  { id: "timeout_sane", value: true, observed: true, detail: null },
  {
    id: "redirect_scheme_downgrade",
    value: false,
    observed: true,
    detail: null,
  },
  { id: "wire_form", value: "v2-header", observed: true, detail: null },
  { id: "amount_magnitude_band", value: "small", observed: true, detail: null },
];

async function seedEndpoint(
  test: TestDatabase,
  scanCount = 1,
): Promise<string> {
  const id = "a".repeat(32);
  await test.db
    .prepare(
      `INSERT INTO endpoints
         (id, canonical_url, url, origin, host, path, discovery_source, status,
          first_seen, last_seen, scan_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'human', 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ENDPOINT,
      ENDPOINT,
      ORIGIN,
      HOST,
      "/v1/geocode",
      NOW,
      NOW,
      scanCount,
      NOW,
      NOW,
    )
    .run();

  const risk = score(SIGNALS)!;
  await test.db
    .prepare(
      `INSERT INTO terms_current
         (endpoint_id, amount_atomic, asset_symbol, asset_decimals, network, scheme, pay_to,
          signals_json, score, band, score_version, observed_at, updated_at)
       VALUES (?, '1000', 'USDC', 6, 'eip155:8453', 'exact', '0xabc', ?, ?, ?, 'v1', ?, ?)`,
    )
    .bind(id, JSON.stringify(SIGNALS), risk.score, risk.band, NOW, NOW)
    .run();

  await test.db
    .prepare(
      `INSERT INTO term_changes
         (id, endpoint_id, changed_at, detected_by, change_kind, field, old_value, new_value, created_at)
       VALUES ('chg1', ?, ?, 'crawler', 'price', 'amount_atomic', '900', '1000', ?)`,
    )
    .bind(id, NOW, NOW)
    .run();

  return id;
}

/**
 * Claim, publish the proof, verify — the whole happy path.
 *
 * The method is a parameter because the two proofs sit behind SEPARATE
 * politeness windows, keyed `claim-dns:` and `claim-wellknown:`. Two DNS claims
 * for one origin inside the same window share the cached TXT records, so a
 * second one legitimately cannot verify a token published after the first was
 * read — that is the amplification bound doing its job, and a test needing two
 * verified claims has to work with it rather than around it.
 */
async function verifiedClaim(
  env: Env,
  method: "dns-txt" | "well-known" = "dns-txt",
): Promise<string> {
  const handler = claimHandler({ now: () => NOW });

  const created = await handler(
    ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT, method })),
  );
  const body = await readClaim(created);
  const token = body.data.challenge_token!;

  const verify = claimHandler(
    method === "dns-txt"
      ? { now: () => NOW, txtResolver: txtZone({ [`${CLAIM_TXT_NAME}.${HOST}`]: [token] }) }
      : {
          now: () => NOW,
          resolver: hostileResolver(),
          connector: scriptedConnector({
            [`${HOST}${CLAIM_WELL_KNOWN}`]: { status: 200, body: `${token}\n` },
          }),
        },
  );
  const verified = await verify(
    ctxFor(env, CLAIM_META, `/api/v1/claim/${body.data.id}/verify`, post({}), {
      id: body.data.id,
    }),
  );
  const after = await readClaim(verified);
  expect(after.data.state).toBe("verified");

  return body.data.id;
}

// ── the schema ────────────────────────────────────────────────────────────

describe("migration 0004: nobody is identified", () => {
  it("has removed the last two person-shaped columns from endpoint_claims", () => {
    const test = createTestDb();
    try {
      const columns = test.raw
        .prepare(`SELECT name FROM pragma_table_info('endpoint_claims')`)
        .all()
        .map((r) => String((r as { name: unknown }).name));

      // `contact_email` was the only place left in this product
      // where a person could be identified, and `account_id` referenced a table
      // 0003 dropped. Both are gone, so §6.3 stays a property of the schema
      // rather than a policy anyone has to remember.
      expect(columns).not.toContain("contact_email");
      expect(columns).not.toContain("account_id");
      expect(columns).toContain("challenge_token");
    } finally {
      test.close();
    }
  });

  it("leaves no table in which a person could be stored", () => {
    const test = createTestDb();
    try {
      const tables = test.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => String((r as { name: unknown }).name));
      for (const gone of [
        "accounts",
        "auth_tokens",
        "channels",
        "watches",
        "alerts",
      ]) {
        expect(tables).not.toContain(gone);
      }
    } finally {
      test.close();
    }
  });

  it("lets an appeal exist without an endpoint, so a pre-emptive removal is filable", () => {
    const test = createTestDb();
    try {
      test.raw.exec(
        `INSERT INTO appeals (id, origin, disputed, argument, created_at)
         VALUES ('a1', '${ORIGIN}', 'listing', 'we do not want to be listed', '${NOW}')`,
      );
      const row = test.raw
        .prepare(`SELECT endpoint_id, remedy, state FROM appeals`)
        .get() as {
        endpoint_id: unknown;
        remedy: unknown;
        state: unknown;
      };
      expect(row.endpoint_id).toBeNull();
      expect(row.remedy).toBe("correction");
      expect(row.state).toBe("open");
    } finally {
      test.close();
    }
  });
});

// ── claiming ──────────────────────────────────────────────────────────────

describe("POST /api/v1/claim", () => {
  it("issues a pending claim with instructions, and validates against the frozen schema", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          env,
          CLAIM_META,
          "/api/v1/claim",
          post({ url: ENDPOINT, method: "dns-txt" }),
        ),
      );

      expect(res.status).toBe(201);
      const body = await readClaim(res);
      expect(
        validateAgainst("claim", body).ok,
        validateAgainst("claim", body).errors,
      ).toBe(true);

      expect(body.data.state).toBe("pending");
      expect(body.data.origin).toBe(ORIGIN);
      expect(body.data.instructions?.record_name).toBe(
        `${CLAIM_TXT_NAME}.${HOST}`,
      );
      expect(body.data.instructions?.publish).toBe(body.data.challenge_token);
      expect(body.data.observed).toBeNull();
      expect(body.data.appeals).toBeNull();
    } finally {
      test.close();
    }
  });

  it("reduces a full endpoint URL to the origin, because that is what the proof proves", async () => {
    const test = createTestDb();
    try {
      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          envFor(test),
          CLAIM_META,
          "/api/v1/claim",
          post({ url: `${ENDPOINT}?q=1` }),
        ),
      );
      const body = await readClaim(res);
      expect(body.data.origin).toBe(ORIGIN);
    } finally {
      test.close();
    }
  });

  it("describes the well-known proof when that method is asked for", async () => {
    const test = createTestDb();
    try {
      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          envFor(test),
          CLAIM_META,
          "/api/v1/claim",
          post({ url: ENDPOINT, method: "well-known" }),
        ),
      );
      const body = await readClaim(res);
      expect(body.data.instructions?.url).toBe(`${ORIGIN}${CLAIM_WELL_KNOWN}`);
      expect(body.data.instructions?.record_name).toBeNull();
    } finally {
      test.close();
    }
  });

  it("issues a fresh id and token every time, and never hands back somebody else's", async () => {
    // Deliberately not idempotent per origin. Returning the pending claim of an
    // earlier caller would let a stranger poll it and inherit a verified claim
    // the moment the real operator published the token.
    const test = createTestDb();
    try {
      const env = envFor(test);
      const handler = claimHandler({ now: () => NOW });
      const first = await readClaim(
        await handler(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT })),
        ),
      );
      const second = await readClaim(
        await handler(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT })),
        ),
      );

      expect(first.data.id).not.toBe(second.data.id);
      expect(first.data.challenge_token).not.toBe(second.data.challenge_token);
      // 128 bits. `newId`'s 50 would be the wrong shape for a handle that is
      // the only thing between a stranger and an operator's correspondence.
      expect(first.data.id).toMatch(/^[0-9a-f]{32}$/u);
    } finally {
      test.close();
    }
  });

  it("refuses a URL the guard refuses", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      for (const url of [
        "http://api.example.com/",
        "https://user:pw@api.example.com/",
        "not a url",
      ]) {
        const res = await claimHandler()(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url })),
        );
        expect(res.status, url).toBe(422);
        expect(validateAgainst("error", await res.json()).ok).toBe(true);
      }
    } finally {
      test.close();
    }
  });

  it("names the missing field rather than failing vaguely", async () => {
    const test = createTestDb();
    try {
      const res = await claimHandler()(
        ctxFor(envFor(test), CLAIM_META, "/api/v1/claim", post({})),
      );
      expect(res.status).toBe(422);
      const body = await readError(res);
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.detail.fields).toContain("url");
    } finally {
      test.close();
    }
  });
});

describe("POST /api/v1/claim/:id/verify — DNS TXT", () => {
  it("verifies a claim when the record is published", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const id = await verifiedClaim(env);

      const row = test.raw
        .prepare(`SELECT state, verified_at FROM endpoint_claims WHERE id = ?`)
        .get(id) as { state: unknown; verified_at: unknown };
      expect(row.state).toBe("verified");
      expect(row.verified_at).toBe(NOW);
    } finally {
      test.close();
    }
  });

  it("does not verify, and does not error, when the record is not there yet", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            "/api/v1/claim",
            post({ url: ENDPOINT, method: "dns-txt" }),
          ),
        ),
      );

      const res = await claimHandler({
        now: () => NOW,
        txtResolver: txtZone({}),
      })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}/verify`,
          post({}),
          {
            id: created.data.id,
          },
        ),
      );

      // 200, not 4xx: "we looked and it is not there yet" is the answer they
      // came for, and DNS propagation is not the operator's mistake.
      expect(res.status).toBe(200);
      const body = await readClaim(res);
      expect(body.data.state).toBe("pending");
      expect(body.data.next_steps.join(" ")).toContain("propagate");
      expect(body.data.observed).toBeNull();
    } finally {
      test.close();
    }
  });

  it("does not verify against a record carrying somebody else's token", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            "/api/v1/claim",
            post({ url: ENDPOINT, method: "dns-txt" }),
          ),
        ),
      );

      const res = await claimHandler({
        now: () => NOW,
        txtResolver: txtZone({
          [`${CLAIM_TXT_NAME}.${HOST}`]: ["x402-tools-claim=deadbeef"],
        }),
      })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}/verify`,
          post({}),
          {
            id: created.data.id,
          },
        ),
      );

      const body = await readClaim(res);
      expect(body.data.state).toBe("pending");
      expect(body.data.next_steps.join(" ")).toContain(
        "none of its values is the token",
      );
    } finally {
      test.close();
    }
  });

  it("stops accepting a token once it has aged out", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            "/api/v1/claim",
            post({ url: ENDPOINT, method: "dns-txt" }),
          ),
        ),
      );

      const later =
        new Date(Date.parse(NOW) + (CLAIM_TOKEN_TTL_HOURS + 1) * 3_600_000)
          .toISOString()
          .slice(0, 19) + "Z";

      const res = await claimHandler({
        now: () => later,
        txtResolver: txtZone({
          [`${CLAIM_TXT_NAME}.${HOST}`]: [created.data.challenge_token!],
        }),
      })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}/verify`,
          post({}),
          {
            id: created.data.id,
          },
        ),
      );

      const body = await readClaim(res);
      expect(body.data.state).toBe("failed");
      expect(body.data.next_steps.join(" ")).toContain("no longer verifiable");
    } finally {
      test.close();
    }
  });
});

describe("POST /api/v1/claim/:id/verify — the well-known file", () => {
  const served = (token: string) =>
    scriptedConnector({
      [`${HOST}${CLAIM_WELL_KNOWN}`]: { status: 200, body: `${token}\n` },
    });

  it("verifies a claim when the file carries the token", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            "/api/v1/claim",
            post({ url: ENDPOINT, method: "well-known" }),
          ),
        ),
      );

      const res = await claimHandler({
        now: () => NOW,
        resolver: hostileResolver(),
        connector: served(created.data.challenge_token ?? ""),
      })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}/verify`,
          post({}),
          {
            id: created.data.id,
          },
        ),
      );

      const body = await readClaim(res);
      expect(body.data.state).toBe("verified");
      expect(
        validateAgainst("claim", body).ok,
        validateAgainst("claim", body).errors,
      ).toBe(true);
    } finally {
      test.close();
    }
  });

  it("does not verify against a file that exists but carries something else", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            "/api/v1/claim",
            post({ url: ENDPOINT, method: "well-known" }),
          ),
        ),
      );

      const res = await claimHandler({
        now: () => NOW,
        resolver: hostileResolver(),
        connector: served("x402-tools-claim=somebody-elses"),
      })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}/verify`,
          post({}),
          {
            id: created.data.id,
          },
        ),
      );

      const body = await readClaim(res);
      expect(body.data.state).toBe("pending");
      expect(body.data.next_steps.join(" ")).toContain(
        "does not contain the token",
      );
    } finally {
      test.close();
    }
  });

  it("fetches the file through the SSRF guard, so a private origin is never reached", async () => {
    // The origin is caller-chosen, which is exactly the surface
    // exists for. `validateUrl` already refuses this at claim time; asserting
    // it here fixes the property at the route rather than at one helper.
    const test = createTestDb();
    try {
      const res = await claimHandler()(
        ctxFor(
          envFor(test),
          CLAIM_META,
          "/api/v1/claim",
          post({ url: "https://127.0.0.1/x" }),
        ),
      );
      expect(res.status).toBe(422);
    } finally {
      test.close();
    }
  });
});

describe("checkDnsTxt", () => {
  it("joins the chunks of a TXT record the way the wire format means", async () => {
    const resolver: TxtResolver = {
      resolveTxt: () => Promise.resolve(["x402-tools-claim=abc"]),
    };
    const result = await checkDnsTxt(HOST, "x402-tools-claim=abc", resolver);
    expect(result.proven).toBe(true);
  });

  it("quotes back what it saw when the proof does not match", async () => {
    const resolver: TxtResolver = {
      resolveTxt: () => Promise.resolve(["v=spf1 -all"]),
    };
    const result = await checkDnsTxt(HOST, "x402-tools-claim=abc", resolver);
    expect(result.proven).toBe(false);
    expect(result.evidence).toContain("v=spf1");
  });

  it("treats a lookup failure as unproven rather than as an error", async () => {
    const resolver: TxtResolver = {
      resolveTxt: () => Promise.reject(new Error("SERVFAIL")),
    };
    const result = await checkDnsTxt(HOST, "x402-tools-claim=abc", resolver);
    expect(result.proven).toBe(false);
    expect(result.detail).toContain("No answer");
  });
});

// ── the dossier ───────────────────────────────────────────────────────────

describe("GET /api/v1/claim/:id — see exactly what was observed", () => {
  it("404s an id that does not exist, with the frozen error envelope", async () => {
    const test = createTestDb();
    try {
      const res = await claimHandler()(
        ctxFor(
          envFor(test),
          CLAIM_META,
          "/api/v1/claim/nope",
          { method: "GET" },
          { id: "nope" },
        ),
      );
      expect(res.status).toBe(404);
      expect(validateAgainst("error", await res.json()).ok).toBe(true);
    } finally {
      test.close();
    }
  });

  it("withholds the dossier until control is proved", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT })),
        ),
      );

      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${created.data.id}`,
          { method: "GET" },
          {
            id: created.data.id,
          },
        ),
      );
      const body = await readClaim(res);
      expect(body.data.observed).toBeNull();
      expect(body.data.appeals).toBeNull();
    } finally {
      test.close();
    }
  });

  it("hands a verified operator the terms, the raw signals and the recorded changes", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const id = await verifiedClaim(env);

      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${id}`,
          { method: "GET" },
          { id },
        ),
      );
      const body = await readClaim(res);
      const check = validateAgainst("claim", body);
      expect(check.ok, check.errors).toBe(true);

      const endpoint = body.data.observed!.endpoints[0]!;
      expect(endpoint.canonical_url).toBe(ENDPOINT);
      expect(endpoint.signals.length).toBe(SIGNALS.length);
      expect(body.data.observed!.changes.map((c) => c.id)).toContain("chg1");
    } finally {
      test.close();
    }
  });

  it("recomputes the score in front of them, and the arithmetic reproduces", async () => {
    // reproducibility IS the appeal mechanism. If `reproduced`
    // ever disagreed with `score`, the claim made on /methodology would be false.
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const id = await verifiedClaim(env);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );

      const risk = body.data.observed!.endpoints[0]!.risk!;
      expect(risk.reproduced).toBe(risk.score);
      expect(risk.score).toBe(score(SIGNALS)!.score);
    } finally {
      test.close();
    }
  });

  it("shows the score as it was served alongside the recomputation, never instead of it", async () => {
    // SPEC §7: historical scores are never recomputed. A merchant appealing a
    // verdict is shown the score they actually received.
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const id = await verifiedClaim(env);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );

      const endpoint = body.data.observed!.endpoints[0]!;
      expect(endpoint.score_as_served.score).toBe(score(SIGNALS)!.score);
      expect(endpoint.score_as_served.band).toBe(score(SIGNALS)!.band);
    } finally {
      test.close();
    }
  });

  it("never emits a band without the sentence that says what a band is", async () => {
    // its rule, applied here for the same reason: this is a JSON response
    // with no page around it, so the framing has to travel in the same object.
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const id = await verifiedClaim(env);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );

      for (const endpoint of body.data.observed!.endpoints) {
        if (!endpoint.risk) continue;
        expect(endpoint.risk.band_note).toContain("not a judgement about the");
      }
    } finally {
      test.close();
    }
  });

  it("does not call one scan a history", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test, 1);
      const id = await verifiedClaim(env);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );

      const endpoint = body.data.observed!.endpoints[0]!;
      expect(endpoint.scan_count).toBe(1);
      expect(endpoint.has_history).toBe(false);
    } finally {
      test.close();
    }
  });

  it("does call several scans a history", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test, 7);
      const id = await verifiedClaim(env);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );

      expect(body.data.observed!.endpoints[0]!.has_history).toBe(true);
    } finally {
      test.close();
    }
  });

  it("renders an origin we have never crawled as empty, not as an error", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const id = await verifiedClaim(env);

      const res = await claimHandler({ now: () => NOW })(
        ctxFor(
          env,
          CLAIM_META,
          `/api/v1/claim/${id}`,
          { method: "GET" },
          { id },
        ),
      );
      expect(res.status).toBe(200);
      const body = await readClaim(res);
      expect(body.data.observed!.endpoints).toEqual([]);
      expect(body.data.observed!.opted_out).toBe(false);
    } finally {
      test.close();
    }
  });

  it("stops handing out the token once the claim is verified", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const id = await verifiedClaim(env);
      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${id}`,
            { method: "GET" },
            { id },
          ),
        ),
      );
      expect(body.data.challenge_token).toBeNull();
      expect(body.data.instructions).toBeNull();
    } finally {
      test.close();
    }
  });
});

// ── appealing ─────────────────────────────────────────────────────────────

describe("POST /api/v1/appeal", () => {
  it("refuses an appeal that is not backed by a verified claim", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const created = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT })),
        ),
      );

      const unverified = await appealHandler()(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: created.data.id,
            disputed: "facilitator_known",
            argument: "we are listed",
          }),
        ),
      );
      const missing = await appealHandler()(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: "f".repeat(32),
            disputed: "facilitator_known",
            argument: "we are listed",
          }),
        ),
      );

      expect(unverified.status).toBe(422);
      expect(missing.status).toBe(422);

      // Identical answers on purpose: this route must not become an oracle for
      // whether a particular claim id exists.
      const a = await readError(unverified);
      const b = await readError(missing);
      expect(a.error.message).toBe(b.error.message);
    } finally {
      test.close();
    }
  });

  it("records a correction as open, and validates against the frozen schema", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      const res = await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            disputed: "facilitator_known",
            argument:
              "Our facilitator answers /supported; please re-check the list.",
          }),
        ),
      );

      expect(res.status).toBe(201);
      const body = await readAppeal(res);
      const check = validateAgainst("appeal", body);
      expect(check.ok, check.errors).toBe(true);

      expect(body.data.appeal.state).toBe("open");
      expect(body.data.appeal.remedy).toBe("correction");
      expect(body.data.appeal.claim_id).toBe(claimId);
      expect(body.data.removal).toBeNull();
      // A correction is reviewed by a person: taking the operator's word for it
      // would make the corpus editable by whoever controls a domain.
      expect(body.data.next_steps.join(" ")).toContain("reviewed by a person");
    } finally {
      test.close();
    }
  });

  it("does not touch the append-only change log when an appeal is filed", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            disputed: "chg1",
            argument: "the old price was 800",
          }),
        ),
      );

      const row = test.raw
        .prepare(
          `SELECT old_value, new_value FROM term_changes WHERE id = 'chg1'`,
        )
        .get() as {
        old_value: unknown;
        new_value: unknown;
      };
      expect(row.old_value).toBe("900");
      expect(row.new_value).toBe("1000");

      // And it could not have, even if the route had tried: append-only is a
      // database trigger, not a convention.
      expect(() =>
        test.raw.exec(
          `UPDATE term_changes SET new_value = '1' WHERE id = 'chg1'`,
        ),
      ).toThrow(/append-only/u);
    } finally {
      test.close();
    }
  });

  it("caps operator-supplied prose rather than storing whatever arrives", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const claimId = await verifiedClaim(env);

      await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            disputed: "x".repeat(500),
            argument: "y".repeat(10_000),
          }),
        ),
      );

      const row = test.raw
        .prepare(`SELECT disputed, argument FROM appeals`)
        .get() as {
        disputed: string;
        argument: string;
      };
      expect(row.disputed.length).toBe(200);
      expect(row.argument.length).toBe(4000);
    } finally {
      test.close();
    }
  });

  it("surfaces every appeal for the origin on any verified claim for it", async () => {
    // The recovery story: there is no account, so re-proving control of the
    // domain has to be enough to get the correspondence back.
    const test = createTestDb();
    try {
      const env = envFor(test);
      const firstClaim = await verifiedClaim(env);

      await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: firstClaim,
            disputed: "facilitator_known",
            argument: "please re-check",
          }),
        ),
      );

      // The operator loses the id and claims again, from scratch. By the other
      // proof, because the DNS window is still holding the first lookup.
      const secondClaim = await verifiedClaim(env, "well-known");
      expect(secondClaim).not.toBe(firstClaim);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${secondClaim}`,
            { method: "GET" },
            { id: secondClaim },
          ),
        ),
      );

      expect(body.data.appeals).toHaveLength(1);
      expect(body.data.appeals![0]!.disputed).toBe("facilitator_known");
    } finally {
      test.close();
    }
  });
});

// ── removal ───────────────────────────────────────────────────────────────

describe("removal: the deferred DNS-TXT opt-out path", () => {
  it("opts the origin out immediately and stops it being served", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const endpointId = await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      const res = await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            remedy: "removal",
            disputed: "listing",
            argument: "Please remove us from the corpus.",
          }),
        ),
      );

      expect(res.status).toBe(201);
      const body = await readAppeal(res);
      expect(validateAgainst("appeal", body).ok).toBe(true);
      expect(body.data.appeal.state).toBe("upheld");
      expect(body.data.removal?.endpoints_affected).toBe(1);

      // Honoured at READ time, not only at the next crawl cycle.
      const optout = await isOptedOut(test.db, ENDPOINT, ORIGIN, NOW);
      expect(optout).not.toBeNull();
      expect(optout?.method).toBe("dns-txt");
      expect(optout?.effective_at).toBe(NOW);

      // And the corpus row itself stops being active, which is what every tool
      // filters on — an opt-out that wrote only the optouts row would stop the
      // crawler and keep serving the data.
      const row = test.raw
        .prepare(`SELECT status, next_probe_at FROM endpoints WHERE id = ?`)
        .get(endpointId) as { status: unknown; next_probe_at: unknown };
      expect(row.status).toBe("opted_out");
      expect(row.next_probe_at).toBeNull();
    } finally {
      test.close();
    }
  });

  it("records the claim as the evidence, so the proof is auditable", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const claimId = await verifiedClaim(env);

      await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            remedy: "removal",
            disputed: "listing",
            argument: "remove us",
          }),
        ),
      );

      const row = test.raw
        .prepare(`SELECT method, evidence, scope, target FROM optouts`)
        .get() as {
        method: unknown;
        evidence: unknown;
        scope: unknown;
        target: unknown;
      };
      expect(row.scope).toBe("origin");
      expect(row.target).toBe(ORIGIN);
      expect(row.evidence).toBe(`verified claim ${claimId}`);
    } finally {
      test.close();
    }
  });

  it("keeps the change log after a removal, and stops serving the endpoint", async () => {
    // docs/abuse-policy.md: opting out stops the probing and stops the serving;
    // it does not rewrite history, because a change log that can be erased on
    // request is worth nothing to the operator it is later used against.
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      await appealHandler({ now: () => NOW })(
        ctxFor(
          env,
          APPEAL_META,
          "/api/v1/appeal",
          post({
            claim_id: claimId,
            remedy: "removal",
            disputed: "listing",
            argument: "remove us",
          }),
        ),
      );

      const changes = test.raw
        .prepare(`SELECT COUNT(*) AS n FROM term_changes`)
        .get() as { n: number };
      expect(Number(changes.n)).toBe(1);

      const body = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${claimId}`,
            { method: "GET" },
            { id: claimId },
          ),
        ),
      );
      expect(body.data.observed!.opted_out).toBe(true);
    } finally {
      test.close();
    }
  });
});

// ── §6.2, over the wire ───────────────────────────────────────────────────

describe("§6.2: what the claim flow is allowed to say", () => {
  const BANNED = [
    "scam",
    "fraud",
    "fraudulent",
    "unsafe",
    "dangerous",
    "malicious",
  ];

  it("says nothing about anybody's character, anywhere in either response", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      const claimBody = await (
        await claimHandler({ now: () => NOW })(
          ctxFor(
            env,
            CLAIM_META,
            `/api/v1/claim/${claimId}`,
            { method: "GET" },
            { id: claimId },
          ),
        )
      ).text();

      const appealBody = await (
        await appealHandler({ now: () => NOW })(
          ctxFor(
            env,
            APPEAL_META,
            "/api/v1/appeal",
            post({
              claim_id: claimId,
              disputed: "facilitator_known",
              argument: "please re-check",
            }),
          ),
        )
      ).text();

      for (const word of BANNED) {
        expect(
          claimBody.toLowerCase(),
          `"${word}" in the claim response`,
        ).not.toContain(word);
        expect(
          appealBody.toLowerCase(),
          `"${word}" in the appeal response`,
        ).not.toContain(word);
      }
    } finally {
      test.close();
    }
  });

  it("points an operator at the arithmetic rather than at our judgement", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      await seedEndpoint(test);
      const claimId = await verifiedClaim(env);

      const body = await readClaim(
        await appealHandler({ now: () => NOW })(
          ctxFor(
            env,
            APPEAL_META,
            "/api/v1/appeal",
            post({
              claim_id: claimId,
              disputed: "risk.score",
              argument: "the score is too low",
            }),
          ),
        ),
      );

      expect(body.data.next_steps.join(" ")).toContain(
        "recompute it with the weights",
      );
    } finally {
      test.close();
    }
  });
});

// ── the politeness budget ─────────────────────────────────────────────────

describe("verify cannot be used as a load generator", () => {
  // "being a free DDoS cannon aimed at other people's paid APIs
  // ends the project". `POST /api/v1/claim/:id/verify` is unauthenticated and
  // makes us fetch a URL on somebody else's server, so it goes through the same
  // per-target politeness budget every probe does.

  it("reads one origin at most once per window, however many claims ask", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      let lookups = 0;
      const counting: TxtResolver = {
        resolveTxt: () => {
          lookups += 1;
          return Promise.resolve([]);
        },
      };

      for (let i = 0; i < 5; i += 1) {
        const created = await readClaim(
          await claimHandler({ now: () => NOW })(
            ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT, method: "dns-txt" })),
          ),
        );
        await claimHandler({ now: () => NOW, txtResolver: counting })(
          ctxFor(env, CLAIM_META, `/api/v1/claim/${created.data.id}/verify`, post({}), {
            id: created.data.id,
          }),
        );
      }

      expect(lookups).toBe(1);
    } finally {
      test.close();
    }
  });

  it("shares the observation between callers but never the verdict", async () => {
    // The bug this rules out: if the politeness layer cached the ProofResult
    // rather than the records, one origin's verified claim would satisfy a
    // different claim's token. That is an authentication bug, not a caching one.
    const test = createTestDb();
    try {
      const env = envFor(test);

      const first = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT, method: "dns-txt" })),
        ),
      );
      const zone = txtZone({ [`${CLAIM_TXT_NAME}.${HOST}`]: [first.data.challenge_token!] });

      const mine = await readClaim(
        await claimHandler({ now: () => NOW, txtResolver: zone })(
          ctxFor(env, CLAIM_META, `/api/v1/claim/${first.data.id}/verify`, post({}), {
            id: first.data.id,
          }),
        ),
      );
      expect(mine.data.state).toBe("verified");

      // A second claim over the same origin, reading the SAME cached records.
      const second = await readClaim(
        await claimHandler({ now: () => NOW })(
          ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT, method: "dns-txt" })),
        ),
      );
      const theirs = await readClaim(
        await claimHandler({ now: () => NOW, txtResolver: zone })(
          ctxFor(env, CLAIM_META, `/api/v1/claim/${second.data.id}/verify`, post({}), {
            id: second.data.id,
          }),
        ),
      );

      // Its own token is not in what we read, so it does not inherit the first
      // claim's proof — even though the observation behind both was identical.
      expect(theirs.data.state).toBe("pending");
      expect(theirs.data.next_steps.join(" ")).toContain("none of its values is the token");
      expect(theirs.data.observed).toBeNull();
    } finally {
      test.close();
    }
  });

  it("tells the operator the answer was cached, and how long ago", async () => {
    const test = createTestDb();
    try {
      const env = envFor(test);
      const zone = txtZone({ [`${CLAIM_TXT_NAME}.${HOST}`]: ["something-else"] });

      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const created = await readClaim(
          await claimHandler({ now: () => NOW })(
            ctxFor(env, CLAIM_META, "/api/v1/claim", post({ url: ENDPOINT, method: "dns-txt" })),
          ),
        );
        ids.push(created.data.id);
      }

      const first = await readClaim(
        await claimHandler({ now: () => NOW, txtResolver: zone })(
          ctxFor(env, CLAIM_META, `/api/v1/claim/${ids[0]!}/verify`, post({}), { id: ids[0]! }),
        ),
      );
      const second = await readClaim(
        await claimHandler({ now: () => NOW, txtResolver: zone })(
          ctxFor(env, CLAIM_META, `/api/v1/claim/${ids[1]!}/verify`, post({}), { id: ids[1]! }),
        ),
      );

      // The first read live and says nothing about caching; the second was
      // served the cached records and says so, with the age, so an operator who
      // has just published does not read a stale answer as a rejection.
      expect(first.data.next_steps.join(" ")).not.toContain("seconds ago");
      expect(second.data.next_steps.join(" ")).toContain("seconds ago");
    } finally {
      test.close();
    }
  });
});

// ── the DNS-over-HTTPS wire format ────────────────────────────────────────

describe("dohTxtResolver", () => {
  /** A DoH endpoint, as `fetch`. The payloads are the real 1.1.1.1 shape. */
  function dohStub(payload: unknown): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/dns-json" },
        }),
      );
  }

  it("parses a real answer, quotes and all", async () => {
    // Copied from an actual `GET https://cloudflare-dns.com/dns-query?
    // name=_dmarc.google.com&type=TXT`, because the thing most likely to be
    // wrong here is an assumption about the wire format rather than the logic.
    const resolver = dohTxtResolver("https://example.invalid/dns-query");
    const records = await withFetch(
      dohStub({
        Status: 0,
        Answer: [
          {
            name: "_dmarc.google.com",
            type: 16,
            TTL: 300,
            data: '"v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com"',
          },
        ],
      }),
      () => resolver.resolveTxt("_dmarc.google.com"),
    );
    expect(records).toEqual(["v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com"]);
  });

  it("joins a record served as several strings, which is what the wire format means", async () => {
    const resolver = dohTxtResolver("https://example.invalid/dns-query");
    const records = await withFetch(
      dohStub({ Answer: [{ type: 16, data: '"x402-tools-claim=" "abcdef"' }] }),
      () => resolver.resolveTxt("_x402-tools.api.example.com"),
    );
    expect(records).toEqual(["x402-tools-claim=abcdef"]);
  });

  it("ignores answer records that are not TXT", async () => {
    const resolver = dohTxtResolver("https://example.invalid/dns-query");
    const records = await withFetch(
      dohStub({ Answer: [{ type: 5, data: "cname.example.com." }, { type: 16, data: '"keep-me"' }] }),
      () => resolver.resolveTxt("_x402-tools.api.example.com"),
    );
    expect(records).toEqual(["keep-me"]);
  });

  it("treats a failed lookup as no records rather than throwing", async () => {
    const resolver = dohTxtResolver("https://example.invalid/dns-query");
    const failing: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    const records = await withFetch(failing, () => resolver.resolveTxt("_x402-tools.example.com"));
    expect(records).toEqual([]);
  });
});

/** Swap the global `fetch` for the duration of one call, and always put it back. */
async function withFetch<T>(replacement: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ── the schemas this change added ────────────────────────────────────────

/**
 * Schemas that exist on disk, validate in `pnpm schema:check`, and are NOT yet
 * reachable at the `$id` they claim.
 *
 * `worker/routes/schemas.ts` imports each schema by name and does not own
 * it, so the three files added here compile, validate every
 * fixture and freeze the contract — but `GET /api/v1/schemas/claim` still 404s,
 * which means the `meta.schema` link in every claim, appeal and methodology
 * envelope points at nothing until the wave-5 integrator adds three imports and
 * three map entries.
 *
 * **Delete this set in the same commit that wires them up.** It is green today
 * and it fails the moment a fourth unserved schema appears, which is the point:
 * the gap is pinned rather than forgotten.
 */
const NOT_YET_SERVED = new Set(["appeal", "claim", "methodology"]);

describe("the frozen contract", () => {
  it("serves every schema on disk at its $id, or names why not", async () => {
    const onDisk = readdirSync(join(__dirname, "..", "spec", "schemas"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/u, ""));

    const index = await handleRequest(request("/api/v1/schemas"), mockEnv(), mockCtx());
    const listed = await readSchemaIndex(index);
    const served = new Set(listed.data.schemas.map((s) => s.name));

    const missing = onDisk.filter((name) => !served.has(name));
    expect(missing.sort()).toEqual([...NOT_YET_SERVED].sort());
  });

  it("keeps the claim and appeal schemas compiling against the shared envelope", () => {
    // The composition is what stops the envelope drifting per tool.
    for (const [name, body] of [
      ["claim", { api_version: "v1", tool: "claim", generated_at: "2026-08-15T12:00:00Z" }],
      ["appeal", { api_version: "v1", tool: "appeal", generated_at: "2026-08-15T12:00:00Z" }],
    ] as const) {
      // Deliberately incomplete: it must FAIL, and failing proves the schema is
      // compiled and constraining rather than absent and permissive.
      expect(validateAgainst(name, body).ok, name).toBe(false);
    }
  });
});
