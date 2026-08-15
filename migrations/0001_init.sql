-- tx402 tools — D1 schema v1.
-- This is the COMPLETE v1 schema. It deliberately includes tables that wave-2
-- and wave-3 sessions will use (crawler, accounts, watches, claims) so that no
-- session in those waves has to land a migration and race another one. 0002_*.sql is reserved for and
-- 0003_*.sql for in case
-- they genuinely need more; a landed migration is NEVER edited.
-- Privacy discipline, inherited from tx402-landing/schema.sql:
--   * no IP addresses, anywhere, in any form — not even hashed
--   * no cookies, no session ids, no visitor identifier
--   * no user agents of visitors (the crawler's OWN UA is a constant in code)
--   * no wallet keys, no payment authorizations, no signatures
--   * accounts are the ONLY place a person is identified, and only so
--     that Watch can send them an alert they asked for
-- Rate limiting keys live in a Durable Object, never in D1, and are salted
-- hashes with a short TTL — see docs/abuse-policy.md.
-- Conventions:
--   * every statement is IF NOT EXISTS; the file is safe to re-run
--   * timestamps are RFC 3339 UTC strings ('2026-08-14T09:41:07Z'), TEXT
--   * atomic token amounts are TEXT, never INTEGER — a uint256 does not fit
--     in SQLite's signed 64-bit INTEGER and silently losing precision on a
--     price is exactly the failure this product exists to catch
--   * endpoint_id is the canonical endpoint id defined in spec/SPEC.md
--     (lowercase hex, first 32 chars of SHA-256 over the canonical URL)

-- ───────────────────────────────────────────────────────────── endpoints ──
-- One row per canonical endpoint URL we have ever seen. Public data only:
-- the URL and what the endpoint itself serves in its 402 challenge.
CREATE TABLE IF NOT EXISTS endpoints (
  id               TEXT PRIMARY KEY,           -- SPEC.md §"Endpoint id"
  canonical_url    TEXT NOT NULL UNIQUE,       -- normalized: https, no fragment, sorted query
  url              TEXT NOT NULL,              -- as first observed
  origin           TEXT NOT NULL,              -- https://host[:port]
  host             TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT,                       -- from Bazaar extensions.serviceName, if any
  description      TEXT,
  resource_type    TEXT NOT NULL DEFAULT 'http'   -- http | mcp   (Bazaar `type`)
                   CHECK (resource_type IN ('http', 'mcp')),
  discovery_source TEXT NOT NULL                  -- how it entered the corpus
                   CHECK (discovery_source IN ('bazaar', 'awesome-x402', 'human', 'crawler', 'seed', 'claim')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'unreachable', 'not_x402', 'gone', 'opted_out')),
  robots_allowed   INTEGER NOT NULL DEFAULT 1,    -- 0 once robots.txt disallows us
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  last_scan_id     TEXT,
  scan_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints (host);
CREATE INDEX IF NOT EXISTS idx_endpoints_status ON endpoints (status);
CREATE INDEX IF NOT EXISTS idx_endpoints_last_seen ON endpoints (last_seen);
CREATE INDEX IF NOT EXISTS idx_endpoints_source ON endpoints (discovery_source);
CREATE INDEX IF NOT EXISTS idx_endpoints_type ON endpoints (resource_type);

-- ─────────────────────────────────────────────────────────── terms_current ──
-- The materialized "what does it cost right now" row every tool reads. Exactly one row per endpoint;
-- overwritten on change.
-- The history of what it USED to cost lives in term_changes, never here.
CREATE TABLE IF NOT EXISTS terms_current (
  endpoint_id        TEXT PRIMARY KEY,
  x402_version       INTEGER,                  -- 1 | 2
  wire_form          TEXT                      -- where the challenge was carried
                     CHECK (wire_form IN ('v2-header', 'v1-body', 'both', 'none')),
  scheme             TEXT,                     -- 'exact', …
  network            TEXT,                     -- CAIP-2, e.g. 'eip155:8453'
  asset_address      TEXT,
  asset_symbol       TEXT,
  asset_decimals     INTEGER,
  amount_atomic      TEXT,                     -- TEXT: uint256 (see header note)
  amount_decimal     TEXT,                     -- rendering convenience, derived
  pay_to             TEXT,
  pay_to_dynamic     INTEGER NOT NULL DEFAULT 0,  -- challenge DECLARES dynamic payTo (§6.2)
  max_timeout_seconds INTEGER,
  facilitator        TEXT,
  resource           TEXT,                     -- the challenge's own `resource` URL
  mime_type          TEXT,
  description        TEXT,
  requirement_count  INTEGER NOT NULL DEFAULT 0,
  extra_json         TEXT,                     -- challenge `extra`, verbatim JSON
  challenge_hash     TEXT,                     -- SHA-256 of the canonicalized challenge
  challenge_json     TEXT,                     -- normalized challenge, verbatim JSON
  score              INTEGER,                  -- score(signals, score_version)
  band               TEXT CHECK (band IN ('LOW', 'MEDIUM', 'HIGH')),
  score_version      TEXT,                     -- 'v1' — never compare across versions
  signals_json       TEXT,                     -- raw signals; the score is reproducible from these
  observed_at        TEXT NOT NULL,
  scan_id            TEXT,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terms_network ON terms_current (network);
CREATE INDEX IF NOT EXISTS idx_terms_asset ON terms_current (asset_symbol);
CREATE INDEX IF NOT EXISTS idx_terms_payto ON terms_current (pay_to);
CREATE INDEX IF NOT EXISTS idx_terms_band ON terms_current (band, score_version);
CREATE INDEX IF NOT EXISTS idx_terms_observed ON terms_current (observed_at);

-- ──────────────────────────────────────────────────────────── term_changes ──
-- APPEND-ONLY. One row only when something actually changed.
-- A price or recipient change is a business event: exact, permanent,
-- queryable, joinable. Volume is tiny. Availability does NOT belong here —
-- it goes to Analytics Engine.
-- Append-only is enforced by triggers below, not by convention. If a row is
-- wrong, append a correcting row; never UPDATE and never DELETE. The whole
-- point of this table is that a merchant appealing a verdict (§6.2) can be
-- shown a record nobody could have quietly edited.
CREATE TABLE IF NOT EXISTS term_changes (
  id                 TEXT PRIMARY KEY,
  endpoint_id        TEXT NOT NULL,
  changed_at         TEXT NOT NULL,            -- when we OBSERVED the change
  detected_by        TEXT NOT NULL DEFAULT 'crawler'
                     CHECK (detected_by IN ('crawler', 'human', 'api', 'backfill')),
  change_kind        TEXT NOT NULL
                     CHECK (change_kind IN (
                       'first_seen', 'price', 'recipient', 'network', 'asset',
                       'scheme', 'timeout', 'facilitator', 'resource',
                       'challenge_shape', 'wire_version', 'availability_state',
                       'status', 'correction'
                     )),
  field              TEXT NOT NULL,            -- terms_current column name
  old_value          TEXT,                     -- NULL on first_seen
  new_value          TEXT,
  old_challenge_hash TEXT,
  new_challenge_hash TEXT,
  scan_id            TEXT,
  score_version      TEXT,                     -- scoring in force when observed
  note               TEXT,                     -- e.g. 'corrects change 01J…' for a correction
  corrects_id        TEXT,                     -- the row this one corrects, if any
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_endpoint ON term_changes (endpoint_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_changes_kind ON term_changes (change_kind, changed_at);
CREATE INDEX IF NOT EXISTS idx_changes_at ON term_changes (changed_at);

CREATE TRIGGER IF NOT EXISTS trg_term_changes_no_update
BEFORE UPDATE ON term_changes
BEGIN
  SELECT RAISE(ABORT, 'term_changes is append-only: append a correction row instead of updating');
END;

CREATE TRIGGER IF NOT EXISTS trg_term_changes_no_delete
BEFORE DELETE ON term_changes
BEGIN
  SELECT RAISE(ABORT, 'term_changes is append-only: rows are never deleted');
END;

-- ───────────────────────────────────────────────────────────────── scans ──
-- Probe results retained in D1 because they are EVIDENCE, not telemetry.
-- Routine unchanged crawler probes do NOT land here — they go to Analytics
-- Engine as availability/latency points. Retaining every probe
-- would put tens of millions of rows in D1 to answer questions Analytics
-- Engine answers better. `retained_reason` is the policy, in the schema:
-- keep a scan when it is the first one, when it produced a change, when it
-- failed, when a human asked for it, when it backs a claim/appeal, or when
-- it is a periodic sample kept for spot-checking the aggregates.
CREATE TABLE IF NOT EXISTS scans (
  id              TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  completed_at    TEXT,
  source          TEXT NOT NULL DEFAULT 'crawler'
                  CHECK (source IN ('crawler', 'human', 'api', 'claim')),
  retained_reason TEXT NOT NULL
                  CHECK (retained_reason IN ('first_seen', 'changed', 'error', 'human', 'sampled', 'claim_evidence')),
  ok              INTEGER NOT NULL DEFAULT 0,
  http_status     INTEGER,
  error_code      TEXT,                        -- spec/SPEC.md error code vocabulary
  error_detail    TEXT,
  wire_form       TEXT CHECK (wire_form IN ('v2-header', 'v1-body', 'both', 'none')),
  x402_version    INTEGER,
  challenge_valid INTEGER,
  challenge_hash  TEXT,
  challenge_json  TEXT,                        -- normalized challenge, verbatim (public data)
  signals_json    TEXT,                        -- raw signals as scored
  score           INTEGER,
  band            TEXT CHECK (band IN ('LOW', 'MEDIUM', 'HIGH')),
  score_version   TEXT,
  latency_ms      INTEGER,
  redirect_count  INTEGER NOT NULL DEFAULT 0,
  tls_protocol    TEXT,
  bytes_read      INTEGER,
  served_from_cache INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_endpoint ON scans (endpoint_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_scans_requested ON scans (requested_at);
CREATE INDEX IF NOT EXISTS idx_scans_reason ON scans (retained_reason, requested_at);

-- ────────────────────────────────────────────────────────── facilitators ──
-- The "known facilitator" list. It is a TRUST CLAIM, so it is a
-- table with a dated, public source per row — never a hardcoded array (O4).
-- "✓ known facilitator" means exactly "it is on this list, and this list is
-- published at /methodology".
CREATE TABLE IF NOT EXISTS facilitators (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL UNIQUE,
  discovery_url   TEXT,                        -- {base}/discovery/resources
  operator        TEXT,
  source_url      TEXT NOT NULL,               -- where we got this, publicly
  source_dated    TEXT NOT NULL,               -- the date on that source
  networks        TEXT,                        -- JSON array of CAIP-2 ids
  status          TEXT NOT NULL DEFAULT 'listed'
                  CHECK (status IN ('listed', 'unverified', 'retired')),
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facilitators_status ON facilitators (status);

-- ───────────────────────────────────────────────────────────────── seeds ──
-- Discovery sources for the corpus bootstrap.
CREATE TABLE IF NOT EXISTS seeds (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('bazaar', 'awesome-x402', 'ecosystem', 'manual')),
  url           TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fetched  TEXT,
  last_status   TEXT,
  items_seen    INTEGER NOT NULL DEFAULT 0,
  items_added   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────── robots_cache ──
-- robots.txt per origin, cached with an expiry so the crawler can honour it
-- without refetching on every probe (docs/abuse-policy.md).
CREATE TABLE IF NOT EXISTS robots_cache (
  origin        TEXT PRIMARY KEY,
  body          TEXT,                          -- truncated to the documented cap
  fetched_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  fetch_status  INTEGER,
  allows_us     INTEGER NOT NULL DEFAULT 1,    -- evaluated for our documented UA
  crawl_delay_s INTEGER
);

CREATE INDEX IF NOT EXISTS idx_robots_expires ON robots_cache (expires_at);

-- ──────────────────────────────────────────────────────────── categories ──
-- Curated category pages are its SEO asset ("cheapest x402 geocoding API").
-- Curated, not inferred: a category has an owner and a definition.
CREATE TABLE IF NOT EXISTS categories (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT,
  definition  TEXT,                            -- what qualifies an endpoint
  curated_by  TEXT,
  published   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoint_categories (
  endpoint_id   TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  assigned_by   TEXT NOT NULL DEFAULT 'curator'
                CHECK (assigned_by IN ('curator', 'bazaar-tag', 'claim')),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, category_slug)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_categories_cat ON endpoint_categories (category_slug);

-- ───────────────────────────────────────────────────────────── opt-outs ──
-- The one-click opt-out promised in docs/abuse-policy.md, honoured within one
-- crawl cycle. Scoped by origin OR by exact endpoint. An opt-out is honoured
-- immediately at read time as well as at crawl time — a merchant should not
-- have to wait for the next cycle to disappear from the site.
CREATE TABLE IF NOT EXISTS optouts (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('origin', 'endpoint')),
  target       TEXT NOT NULL,                  -- origin or canonical_url
  method       TEXT NOT NULL                   -- how it was proven
               CHECK (method IN ('well-known', 'dns-txt', 'robots', 'email', 'manual')),
  evidence     TEXT,                           -- e.g. the TXT record value seen
  requested_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  revoked_at   TEXT,
  note         TEXT,
  UNIQUE (scope, target)
);

CREATE INDEX IF NOT EXISTS idx_optouts_effective ON optouts (effective_at);

-- ─────────────────────────────────────────────────────── endpoint_claims ──
-- Claim-your-endpoint + appeal. Ships WITH the first
-- public risk score, not after the first angry email.
CREATE TABLE IF NOT EXISTS endpoint_claims (
  id            TEXT PRIMARY KEY,
  endpoint_id   TEXT,
  origin        TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('dns-txt', 'well-known')),
  challenge_token TEXT NOT NULL,               -- what the operator must publish
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'verified', 'failed', 'revoked')),
  verified_at   TEXT,
  contact_email TEXT,                          -- optional, operator-supplied
  account_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_origin ON endpoint_claims (origin, state);

CREATE TABLE IF NOT EXISTS appeals (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL,
  claim_id     TEXT,
  disputed     TEXT NOT NULL,                  -- signal id or term_changes id
  argument     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open', 'upheld', 'corrected', 'declined')),
  resolution   TEXT,
  correction_change_id TEXT,                   -- the term_changes correction row, if any
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_appeals_endpoint ON appeals (endpoint_id, state);

-- ────────────────────────────────────────────────────────────── accounts ──. The ONLY place a person is identified, and only so Watch can deliver
-- an alert they asked for. Email sign-in, no passwords ever.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  state         TEXT NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'suspended', 'deleted')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  deleted_at    TEXT
);

-- Single-use, short-lived sign-in tokens. Only the hash is stored, so a dump
-- of this table cannot be used to sign in as anybody.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('signin', 'channel_verify')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry ON auth_tokens (expires_at);

-- Notification channels. Verified before use — an unverified channel is never
-- sent to, which is what stops Watch being an email/webhook cannon.
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('email', 'webhook', 'slack')),
  target        TEXT NOT NULL,                 -- address or URL
  label         TEXT,
  verified_at   TEXT,
  verify_token_hash TEXT,
  state         TEXT NOT NULL DEFAULT 'unverified'
                CHECK (state IN ('unverified', 'active', 'failing', 'disabled')),
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (account_id, kind, target)
);

CREATE INDEX IF NOT EXISTS idx_channels_account ON channels (account_id, state);

-- ─────────────────────────────────────────────────────────────── watches ──
CREATE TABLE IF NOT EXISTS watches (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  endpoint_id    TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  watch_kinds    TEXT NOT NULL,                -- JSON array of term_changes.change_kind
  threshold_json TEXT,                         -- e.g. {"price_pct": 5}
  quiet_hours    TEXT,                         -- JSON {tz, from, to}
  state          TEXT NOT NULL DEFAULT 'active'
                 CHECK (state IN ('active', 'paused', 'deleted')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (account_id, endpoint_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_watches_endpoint ON watches (endpoint_id, state);
CREATE INDEX IF NOT EXISTS idx_watches_account ON watches (account_id, state);

-- A fired alert must be reproducible from term_changes: change_id is the
-- evidence, dedupe_key is why we did not send it five times.
CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  watch_id    TEXT NOT NULL,
  change_id   TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending'
              CHECK (state IN ('pending', 'sent', 'failed', 'suppressed')),
  suppressed_reason TEXT
              CHECK (suppressed_reason IS NULL OR suppressed_reason IN ('quiet_hours', 'duplicate', 'threshold', 'channel_disabled')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  UNIQUE (watch_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts (state, created_at);

-- ─────────────────────────────────────────────────────────── share_links ──
-- Unguessable, expiring permalinks for shared Inspector reports and
-- shared Replay traces. Replay traces are REDACTED CLIENT-SIDE before
-- upload; this table never receives an unredacted trace, and
-- there is no column in which one could be stored "temporarily".
CREATE TABLE IF NOT EXISTS share_links (
  id           TEXT PRIMARY KEY,               -- unguessable, >=128 bits of entropy
  kind         TEXT NOT NULL CHECK (kind IN ('inspect', 'replay', 'compare', 'policy')),
  endpoint_id  TEXT,
  payload_json TEXT NOT NULL,                  -- the redacted, schema-valid artifact
  redaction_summary TEXT,                      -- JSON {applied, fields_redacted}
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  view_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_share_expires ON share_links (expires_at);

-- ──────────────────────────────────────────────────────────────── events ──
-- Aggregate counters only, bucketed by UTC day, closed vocabulary, no visitor
-- identifier — the same discipline as tx402-landing/schema.sql. meta is NOT
-- NULL (empty string when absent) because SQLite treats NULLs as distinct in
-- a primary key, which would defeat the upsert.
CREATE TABLE IF NOT EXISTS events (
  name  TEXT NOT NULL,
  meta  TEXT NOT NULL DEFAULT '',
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, meta, day)
);

CREATE INDEX IF NOT EXISTS idx_events_day ON events (day);
