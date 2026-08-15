/**
 * The published facilitator list.
 *
 * **"✓ known facilitator" means exactly one thing: it is on this list, and this list is
 * published.** It is not an endorsement, an audit, or a safety claim. That is why every row carries
 * a `source_url` and a `source_dated` — the claim is checkable by the person it is being made at,
 * which is the only form a third-party trust claim may take here.
 *
 * ── `listed` vs `unverified` is a real distinction, not a formality ────────
 *
 * - **`listed`** — publicly named as a facilitator AND its facilitator API
 *   answered `GET {base_url}/supported` with a valid x402 kinds document when
 *   this list was compiled. The `networks` column is that endpoint's own
 *   answer, not a claim from a README.
 * - **`unverified`** — publicly named as a facilitator, but we do not have a
 *   confirmed facilitator base URL for it. Being named by somebody is weaker
 *   evidence than answering the protocol, and collapsing the two would make
 *   the checkmark mean less than it says.
 * - **`retired`** — was listed, no longer operating. Rows are retired, never
 *   deleted, so a historical score's "known facilitator" remains explicable.
 *
 * ── Maintenance (O4) ──────────────────────────────────────────────────────
 *
 * New facilitators appear constantly, so this is seed data for a D1 table, not
 * the runtime source of truth. `seedFacilitators` upserts it; the route reads
 * the table.  owns keeping it current from Bazaar and awesome-x402, and
 * publishes it at `/methodology`. Adding a row here is not a code change to
 * anything else.
 */

import type { Env } from "../types.js";

export interface FacilitatorRow {
  id: string;
  name: string;
  base_url: string;
  discovery_url: string | null;
  operator: string | null;
  networks: string[];
  status: "listed" | "unverified" | "retired";
  source_url: string;
  /** The date on the source, not the date we happened to read it. */
  source_dated: string;
  notes: string | null;
}

/**
 * Bumped whenever a row changes. It is stamped into responses so a score that
 * said "known facilitator" can be explained later against the list that was
 * actually in force, the same way `score_version` works (SPEC §7).
 */
export const FACILITATOR_LIST_VERSION = "2026-08-14";

const AWESOME =
  "https://github.com/xpaysh/awesome-x402/blob/main/README.md";
/** Last commit touching that README when this list was compiled. */
const AWESOME_DATED = "2026-07-28";

export const FACILITATORS: readonly FacilitatorRow[] = Object.freeze([
  {
    id: "x402-org",
    name: "x402.org reference facilitator",
    base_url: "https://x402.org/facilitator",
    discovery_url: null,
    operator: "x402 project",
    networks: [
      "eip155:84532",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
      "aptos:2",
      "hedera:testnet",
      "stellar:testnet",
      "xrpl:1",
    ],
    status: "listed",
    source_url: "https://docs.x402.org/",
    source_dated: "2026-08-14",
    notes:
      "Reference facilitator. Its /supported document advertises test networks only, so an endpoint routing production payments through it is worth a second look.",
  },
  {
    id: "coinbase-cdp",
    name: "Coinbase CDP",
    base_url: "https://api.cdp.coinbase.com/platform/v2/x402",
    discovery_url: null,
    operator: "Coinbase",
    networks: ["eip155:8453", "eip155:84532"],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes:
      "The most widely used hosted facilitator. Its /supported endpoint requires authentication, so networks here come from the published source rather than from the endpoint itself.",
  },
  {
    id: "solvador",
    name: "Solvador",
    base_url: "https://api.solvador.com",
    discovery_url: null,
    operator: "Solvador",
    networks: [
      "eip155:8453",
      "eip155:10",
      "eip155:137",
      "eip155:42161",
      "eip155:42220",
      "eip155:43114",
      "eip155:59144",
      "eip155:480",
      "eip155:130",
      "eip155:143",
      "near:mainnet",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "starknet:SN_MAIN",
      "xrpl:0",
    ],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Multi-network, multi-scheme. Advertises the bazaar extension.",
  },
  {
    id: "primer",
    name: "Primer",
    base_url: "https://x402.primer.systems",
    discovery_url: null,
    operator: "Primer Systems",
    networks: [
      "eip155:8453",
      "eip155:84532",
      "eip155:4663",
      "eip155:46630",
      "base",
      "base-sepolia",
    ],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Accepts both x402 v1 and v2. Batch settlement enabled.",
  },
  {
    id: "primev-fastrpc",
    name: "Primev FastRPC",
    base_url: "https://facilitator.primev.xyz",
    discovery_url: null,
    operator: "Primev",
    networks: ["eip155:1"],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Ethereum mainnet only. Advertises the bazaar extension.",
  },
  {
    id: "merx-tron",
    name: "MERX x402 for TRON",
    base_url: "https://x402.merx.exchange",
    discovery_url: null,
    operator: "MERX",
    networks: ["tron:mainnet", "tron:0x2b6653dc", "eip155:8453"],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: null,
  },
  {
    id: "near-x402",
    name: "NEAR x402 facilitator",
    base_url: "https://x402.mikedotexe.com",
    discovery_url: null,
    operator: "mikedotexe",
    networks: ["near:mainnet"],
    status: "listed",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Open source, API-key gated.",
  },

  // ── named publicly, base URL not confirmed ──
  // These are deliberately NOT "listed". A checkmark that means "someone wrote
  // this name in a README" is not the same claim as "it answered the protocol",
  // and the difference is exactly what makes the list worth publishing.
  {
    id: "cloudflare-x402",
    name: "Cloudflare x402",
    base_url: "https://blog.cloudflare.com/x402/",
    discovery_url: null,
    operator: "Cloudflare",
    networks: [],
    status: "unverified",
    source_url: "https://blog.cloudflare.com/x402/",
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; no confirmed facilitator base URL.",
  },
  {
    id: "asterpay",
    name: "AsterPay",
    base_url: "https://asterpay.io",
    discovery_url: null,
    operator: "AsterPay",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; no confirmed facilitator base URL.",
  },
  {
    id: "satoshi-facilitator",
    name: "Satoshi Facilitator",
    base_url: "https://facilitator.bitcoinsapi.com",
    discovery_url: null,
    operator: "bitcoinsapi.com",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; its /supported endpoint did not answer.",
  },
  {
    id: "fluxa",
    name: "FluxA",
    base_url: "https://fluxapay.xyz",
    discovery_url: null,
    operator: "FluxA",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; no confirmed facilitator base URL.",
  },
  {
    id: "voidly-pay",
    name: "Voidly Pay",
    base_url: "https://api.voidly.ai/v1/pay",
    discovery_url: null,
    operator: "Voidly",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; no confirmed facilitator base URL.",
  },
  {
    id: "algovoi",
    name: "AlgoVoi",
    base_url: "https://api1.ilovechicken.co.uk",
    discovery_url: null,
    operator: "chopmob.cloud",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a multi-chain facilitator; base URL not confirmed.",
  },
  {
    id: "bnb-pieverse",
    name: "BNB Chain Pieverse",
    base_url: "https://pieverse.io",
    discovery_url: null,
    operator: "BNB Chain",
    networks: [],
    status: "unverified",
    source_url: AWESOME,
    source_dated: AWESOME_DATED,
    notes: "Named publicly as a facilitator; no confirmed facilitator base URL.",
  },
]);

/**
 * Origins, for `signals.ts`. Compared by origin so a trailing slash or a path
 * cannot change whether a challenge's facilitator is recognized.
 */
export function facilitatorOrigins(
  rows: readonly FacilitatorRow[] = FACILITATORS,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const row of rows) {
    // Only `listed` rows satisfy the claim. An `unverified` row is on the list
    // as a record, not as a recognition.
    if (row.status !== "listed") continue;
    try {
      origins.add(new URL(row.base_url).origin.toLowerCase());
    } catch {
      // A malformed base_url is a data bug, not a runtime failure. It simply
      // recognizes nothing.
    }
  }
  return origins;
}

// ── D1 ────────────────────────────────────────────────────────────────────

/**
 * Upsert the seed list into the `facilitators` table created by
 * `migrations/0001_init.sql`.
 *
 * Deliberately not a migration: `migrations/0002_*.sql` belongs to, and two
 * wave-2 sessions writing the same numbered file is precisely the collision
 * exists to prevent. Idempotent, so calling it twice is safe.
 */
export async function seedFacilitators(
  db: D1Database,
  rows: readonly FacilitatorRow[] = FACILITATORS,
  now: string = new Date().toISOString().slice(0, 19) + "Z",
): Promise<number> {
  const statements = rows.map((row) =>
    db
      .prepare(
        `INSERT INTO facilitators
           (id, name, base_url, discovery_url, operator, source_url, source_dated,
            networks, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           discovery_url = excluded.discovery_url,
           operator = excluded.operator,
           source_url = excluded.source_url,
           source_dated = excluded.source_dated,
           networks = excluded.networks,
           status = excluded.status,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .bind(
        row.id,
        row.name,
        row.base_url,
        row.discovery_url,
        row.operator,
        row.source_url,
        row.source_dated,
        JSON.stringify(row.networks),
        row.status,
        row.notes,
        now,
        now,
      ),
  );

  await db.batch(statements);
  return statements.length;
}

/**
 * Read the published list.
 *
 * Falls back to the bundled seed when the table is empty or unreachable, and
 * says which it used. A facilitator check that silently recognizes nothing
 * because a table was not seeded would quietly mark every endpoint in the
 * corpus as having an unknown facilitator — a wrong answer that looks like a
 * finding.
 */
export async function loadFacilitators(
  env: Pick<Env, "DB">,
): Promise<{ rows: FacilitatorRow[]; source: "d1" | "bundled" }> {
  try {
    const result = await env.DB.prepare(
      `SELECT id, name, base_url, discovery_url, operator, networks, status,
              source_url, source_dated, notes
         FROM facilitators
        WHERE status != 'retired'
        ORDER BY status, name`,
    ).all<Record<string, unknown>>();

    const rows = (result.results ?? []).map(
      (r): FacilitatorRow => ({
        id: text(r.id) ?? "",
        name: text(r.name) ?? "",
        base_url: text(r.base_url) ?? "",
        discovery_url: text(r.discovery_url),
        operator: text(r.operator),
        networks: parseNetworks(r.networks),
        status: (text(r.status) ?? "unverified") as FacilitatorRow["status"],
        source_url: text(r.source_url) ?? "",
        source_dated: text(r.source_dated) ?? "",
        notes: text(r.notes),
      }),
    );

    if (rows.length > 0) return { rows, source: "d1" };
  } catch {
    // Fall through to the bundled list.
  }

  return { rows: [...FACILITATORS], source: "bundled" };
}

/** D1 columns arrive as `unknown`; only a real string is a value. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseNetworks(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
