/**
 * The curated category catalogue.
 *
 * ── Why this is the most valuable thing in the session ─────────────────────
 *
 * rank for the category, not the brand. Nobody searches for a
 * vendor when their payment just failed, and nobody searches "tx402 compare"
 * when they are shopping for an API. They search "cheapest x402 geocoding API".
 * These pages are the ones that can answer that query, so their titles, H1s and
 * summaries lead with the category term and never with the product name.
 * audits every one of them against §3.1.
 *
 * ── A category is CURATED, not inferred ────────────────────────────────────
 *
 * `migrations/0001_init.sql` gives `categories` an owner (`curated_by`), a
 * definition (`definition`) and a publication flag (`published`), and gives
 * `endpoint_categories` an `assigned_by` that distinguishes `curator` from
 * `bazaar-tag`. That distinction is the whole design:
 *
 *   * **membership** is auto-assigned from the facilitator's own `tags`, which
 *     is a fast, honest starting point and is recorded as `bazaar-tag`;
 *   * **the published set** is this file — a human decision, with a definition
 *     a reader can hold us to and a named owner.
 *
 * A curator can add or remove a single endpoint by writing an
 * `endpoint_categories` row with `assigned_by = 'curator'`, and that row wins
 * because it is never removed by the tag sweep.
 *
 * ── The tag vocabulary is real ─────────────────────────────────────────────
 *
 * Measured 2026-08-15 against the live Bazaar listings of `coinbase-cdp` and
 * `solvador` — 802 resources, of which 699 (87%) carry `tags` and 800 (99.8%)
 * carry Coinbase's `quality` object. 1,350 distinct tags appear, with a long
 * tail; the sets below are drawn from the head of that distribution, so every
 * published category has real members rather than an aspirational definition.
 * Counts at the time of measurement are.
 *
 * Tags are matched case-insensitively after trimming, and both `-` and ` `
 * spellings are listed where the ecosystem uses both (`market-data` and
 * `market data` both occur).
 */

export interface CategoryDefinition {
  slug: string;
  /** `<h1>` and the table caption. Leads with the category term. */
  title: string;
  /** `<title>`. Also §3.1 — the brand is the suffix `pageTitle` adds. */
  seoTitle: string;
  /** `<meta name="description">` and the Markdown lede. One sentence. */
  summary: string;
  /** What qualifies an endpoint. Published, so a reader can dispute it. */
  definition: string;
  /** Who owns this category. A category without an owner is an inference. */
  curatedBy: string;
  /** Live on the site. An unpublished category is still assignable and queryable. */
  published: boolean;
  /** Bazaar `tags` that place an endpoint here, lowercase. */
  tags: string[];
  /** Bazaar `serviceName` values that place an endpoint here, lowercase. */
  serviceNames?: string[];
}

/**
 * Ten categories. Eight have substantial membership in the live corpus today;
 * `geocoding` and `weather` are thin and are published anyway.
 *
 * That is deliberate. own worked example is "cheapest x402
 * geocoding API", and a category page that says "no endpoints in this category
 * yet — that is what we know, not a claim that none exists" is the correct
 * display for a category nobody has listed under yet, exactly as
 * says of a new endpoint. Suppressing the page until it fills would be hiding
 * the honest empty state rather than designing it.
 *
 * Order is the order they appear on the hub page: by breadth of the search
 * term, not by member count.
 */
export const CATEGORIES: readonly CategoryDefinition[] = Object.freeze([
  {
    slug: "ai-inference",
    title: "Compare x402 AI and inference APIs",
    seoTitle: "Cheapest x402 AI inference API — compare price per call",
    summary:
      "x402 endpoints that run a model for you — LLM inference, embeddings, generation and agent tooling — compared on price per call, network and asset.",
    definition:
      "The endpoint's payment buys model inference or agent tooling: a completion, an embedding, a generated image, or a tool an agent calls to reason. Listed by its facilitator under an inference or agent tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "ai",
      "llm",
      "inference",
      "ai-agents",
      "ai agents",
      "agentic",
      "agents",
      "openai",
      "gpt",
      "embeddings",
      "text-generation",
      "image-generation",
    ],
  },
  {
    slug: "market-data",
    title: "Compare x402 crypto market data APIs",
    seoTitle: "Cheapest x402 crypto market data API — price per call compared",
    summary:
      "x402 endpoints serving prices, candles, open interest, funding rates and perpetuals data, compared on what one call costs and how long we have been watching them.",
    definition:
      "The endpoint's payment buys a market observation — a price, a candle, an order-book or derivatives figure — for a traded instrument. Listed by its facilitator under a market-data or trading tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "market-data",
      "market data",
      "market-intelligence",
      "price",
      "prices",
      "candles",
      "ohlc",
      "open-interest",
      "open interest",
      "perps",
      "futures",
      "derivatives",
      "funding-rate",
      "funding rate",
      "liquidations",
      "hyperliquid",
      "trading",
    ],
  },
  {
    slug: "onchain-data",
    title: "Compare x402 blockchain data APIs",
    seoTitle: "Cheapest x402 blockchain data API — RPC and on-chain reads compared",
    summary:
      "x402 endpoints that read a chain for you — balances, transactions, gas, wallets and RPC — compared on price per call, network and observed terms.",
    definition:
      "The endpoint's payment buys a read of blockchain state: a balance, a transaction, a block, a gas figure or an RPC call. Listed by its facilitator under an on-chain, RPC or named-chain tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "on-chain",
      "onchain",
      "blockchain",
      "evm",
      "rpc",
      "gas",
      "wallet",
      "token",
      "erc20",
      "transactions",
      "base",
      "solana",
      "ethereum",
      "bitcoin",
    ],
  },
  {
    slug: "web-search",
    title: "Compare x402 web search and scraping APIs",
    seoTitle: "Cheapest x402 web search API — search and scraping compared",
    summary:
      "x402 endpoints that search, crawl or extract the web, compared on price per call — with an explicit gap wherever we have not observed an endpoint's terms yet.",
    definition:
      "The endpoint's payment buys a retrieval from the open web: a search result set, a crawl, a page rendered as text, or extracted structured data. Listed by its facilitator under a search, crawling or web-data tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "search",
      "web-search",
      "web search",
      "seo",
      "crawling",
      "crawl",
      "scraping",
      "web-data",
      "web data",
      "markdown",
      "browser",
      "web",
    ],
  },
  {
    slug: "social-data",
    title: "Compare x402 social media data APIs",
    seoTitle: "Cheapest x402 social media data API — X, Reddit and GitHub compared",
    summary:
      "x402 endpoints serving posts, profiles, repositories and sentiment from social platforms, compared on price per call and observed availability.",
    definition:
      "The endpoint's payment buys data originating on a social or developer platform — posts, profiles, repositories, threads or a sentiment measure derived from them. Listed by its facilitator under a social or named-platform tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "social",
      "twitter",
      "x",
      "reddit",
      "github",
      "sentiment",
      "discord",
      "telegram",
      "social-media",
      "social media",
    ],
  },
  {
    slug: "equities-finance",
    title: "Compare x402 stock market and equities APIs",
    seoTitle: "Cheapest x402 stock market API — equities and fundamentals compared",
    summary:
      "x402 endpoints covering equities, fundamentals, filings and macro data, compared on price per call and on how long each has been in our index.",
    definition:
      "The endpoint's payment buys data about a listed company or a macroeconomic series — a quote, a fundamental, a filing or an economic indicator. Listed by its facilitator under an equities, finance or SEC tag.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "equities",
      "stocks",
      "finance",
      "quantitative-finance",
      "quantitative finance",
      "macro",
      "fundamentals",
      "earnings",
      "sec",
      "edgar",
    ],
  },
  {
    slug: "identity-records",
    title: "Compare x402 identity and public records APIs",
    seoTitle: "Cheapest x402 public records API — identity and registry lookups compared",
    summary:
      "x402 endpoints resolving identifiers, domains, registries and public records, compared on price per call — with explicit gaps where we have not looked yet.",
    definition:
      "The endpoint's payment buys a lookup against a registry or a public record: a domain, a DNS or WHOIS record, a company filing, a government dataset or a person-level identifier.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "identifiers",
      "identity",
      "public-records",
      "public records",
      "us-gov-data",
      "whois",
      "dns",
      "domain",
      "kyc",
      "people-data",
      "enrichment",
    ],
  },
  {
    slug: "security-risk",
    title: "Compare x402 wallet risk and security APIs",
    seoTitle: "Cheapest x402 wallet risk API — address screening compared",
    summary:
      "x402 endpoints scoring addresses, contracts and counterparties, compared on price per call and on the observation window behind each figure.",
    definition:
      "The endpoint's payment buys an assessment of an address, a contract or a counterparty — a screening result, a reputation figure or a compliance check. What it returns is that provider's assessment, not ours.",
    curatedBy: "tx402",
    published: true,
    // The ecosystem also uses a tag naming the crime this category screens for.
    // It is deliberately absent: keeps that word out of every
    // user-facing string, and these tag lists are published verbatim on
    // `/api/v1/categories`. A category term nobody searches for is a smaller
    // loss than a word that reads as an accusation next to somebody's endpoint.
    tags: ["security", "risk", "trust", "compliance", "aml", "screening", "reputation"],
  },
  {
    slug: "geocoding",
    title: "Compare x402 geocoding and location APIs",
    seoTitle: "Cheapest x402 geocoding API — address and location lookups compared",
    summary:
      "x402 endpoints that turn an address into coordinates, coordinates into a place, or a point into a timezone — compared on price per call, with explicit gaps where we have not looked yet.",
    definition:
      "The endpoint's payment buys a location lookup: geocoding, reverse geocoding, a place or address record, a timezone for a point, or map data.",
    curatedBy: "tx402",
    published: true,
    tags: [
      "geocoding",
      "reverse-geocoding",
      "geo",
      "geospatial",
      "location",
      "maps",
      "places",
      "address",
      "timezone",
    ],
  },
  {
    slug: "weather",
    title: "Compare x402 weather APIs",
    seoTitle: "Cheapest x402 weather API — forecasts and observations compared",
    summary:
      "x402 endpoints serving forecasts and observations, compared on price per call and on how long each has been in our index.",
    definition:
      "The endpoint's payment buys a weather observation, a forecast, or a climate series for a place or a point.",
    curatedBy: "tx402",
    published: true,
    tags: ["weather", "forecast", "climate", "meteorology", "precipitation", "temperature"],
  },
]);

const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string): CategoryDefinition | null {
  return BY_SLUG.get(slug) ?? null;
}

export function publishedCategories(): CategoryDefinition[] {
  return CATEGORIES.filter((c) => c.published);
}

/** Normalize a tag or service name for matching: trimmed, lowercased. */
export function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Which categories a Bazaar listing's tags and service name place it in.
 *
 * Returns slugs, which is what `endpoint_categories` stores. An item can be in
 * several — an "ai" + "market-data" endpoint genuinely belongs on both pages,
 * and forcing a single category would mean picking one for somebody else.
 */
export function categoriesForTags(tags: string[], serviceName: string | null): string[] {
  const normalized = new Set(tags.map(normalizeTag).filter((t) => t.length > 0));
  const name = serviceName ? normalizeTag(serviceName) : null;
  const slugs: string[] = [];

  for (const category of CATEGORIES) {
    const tagHit = category.tags.some((t) => normalized.has(t));
    const nameHit = name !== null && (category.serviceNames ?? []).includes(name);
    if (tagHit || nameHit) slugs.push(category.slug);
  }

  return slugs;
}
