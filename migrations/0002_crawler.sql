-- tx402 tools — crawler state.
-- 0001_init.sql landed the COMPLETE v1 schema, so this file adds only what the
-- crawler needs to *run*: scheduling state, honest provenance, per-cycle
-- accounting, and the recipient evidence table. It creates no table that
-- another tool reads as its primary source — endpoints, terms_current,
-- term_changes and scans are all already there and are not redefined here.
-- Same conventions as 0001: RFC 3339 UTC TEXT timestamps, atomic amounts as
-- TEXT, endpoint_id as the join key, and a landed migration is NEVER edited.

-- ─────────────────────────────────────────────── endpoints: crawl schedule ──
-- Tiered cadence. An endpoint someone watches or scanned
-- recently is probed more often than one seeded from Bazaar and never touched.
-- The tier is stored rather than recomputed on every sweep so that the sweep
-- query is a single indexed read: "the N most overdue endpoints".
-- SQLite has no ADD COLUMN IF NOT EXISTS. D1 tracks applied migrations, so
-- each of these runs exactly once.
ALTER TABLE endpoints ADD COLUMN probe_tier TEXT NOT NULL DEFAULT 'corpus';
ALTER TABLE endpoints ADD COLUMN next_probe_at TEXT;
ALTER TABLE endpoints ADD COLUMN last_probe_at TEXT;
ALTER TABLE endpoints ADD COLUMN last_change_at TEXT;
ALTER TABLE endpoints ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
-- Set when a human pastes this URL into the Inspector ( writes it). It is a
-- timestamp, not a counter: we do not keep a record of how many people looked.
ALTER TABLE endpoints ADD COLUMN last_human_interest_at TEXT;

CREATE INDEX IF NOT EXISTS idx_endpoints_due ON endpoints (next_probe_at, status);
CREATE INDEX IF NOT EXISTS idx_endpoints_tier ON endpoints (probe_tier, next_probe_at);

-- ──────────────────────────────────────────────────── endpoint_provenance ──
-- Why `first_seen` is honest.
-- A Bazaar `lastUpdated` is a claim BY the facilitator ABOUT the resource. It
-- is not a date we observed anything, and writing it into endpoints.first_seen
-- would put a number in the Inspector's "First seen" field that we made up.
-- So the claim is recorded HERE, with its source, and endpoints.first_seen
-- stays "the first time WE saw it".
-- One row per (endpoint, source): the same endpoint discovered via Bazaar and
-- via awesome-x402 keeps both claims, which is what makes dedupe auditable.
CREATE TABLE IF NOT EXISTS endpoint_provenance (
  id                TEXT PRIMARY KEY,
  endpoint_id       TEXT NOT NULL,
  source            TEXT NOT NULL
                    CHECK (source IN ('bazaar', 'awesome-x402', 'ecosystem', 'human', 'crawler', 'seed', 'claim')),
  source_url        TEXT,                      -- the exact document we read
  facilitator_id    TEXT,                      -- when source = 'bazaar'
  -- The source's OWN claim about when the resource last changed, verbatim and
  -- unparsed. Never copied into first_seen. Text because facilitators disagree
  -- about the type (.: the spec says integer, every live
  -- facilitator sends an ISO string).
  claimed_last_updated TEXT,
  -- What we actually did, and when.
  observed_at       TEXT NOT NULL,             -- when WE read this source
  first_observed_at TEXT NOT NULL,             -- when WE first saw this endpoint anywhere
  raw_json          TEXT,                      -- the source item, verbatim (public data)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (endpoint_id, source, facilitator_id)
);

CREATE INDEX IF NOT EXISTS idx_provenance_endpoint ON endpoint_provenance (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_provenance_source ON endpoint_provenance (source, observed_at);

-- ─────────────────────────────────────────────────────────── crawl_cycles ──
-- Probe volume per cycle, recorded rather than estimated.
-- lists unbounded Cloudflare cost as a medium-high risk and makes
-- "bounded probe volume per cycle (measured in )" the mitigation.  builds
-- the cost model on these rows, so the accounting is a table and not a log
-- line: a log line is gone in a week and cannot be summed.
CREATE TABLE IF NOT EXISTS crawl_cycles (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL
                     CHECK (kind IN ('tick', 'sweep', 'seed_refresh', 'manual')),
  cron               TEXT,                     -- the trigger expression that fired
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  -- The bound in force for this cycle, stored WITH the result so a later
  -- reader can tell "we probed 40" from "we were allowed 40 and wanted 900".
  budget             INTEGER NOT NULL DEFAULT 0,
  considered         INTEGER NOT NULL DEFAULT 0,  -- endpoints due
  enqueued           INTEGER NOT NULL DEFAULT 0,  -- messages put on the queue
  probes_attempted   INTEGER NOT NULL DEFAULT 0,
  probes_performed   INTEGER NOT NULL DEFAULT 0,  -- actual outbound requests
  probes_cached      INTEGER NOT NULL DEFAULT 0,  -- served by the politeness cache
  skipped_robots     INTEGER NOT NULL DEFAULT 0,
  skipped_optout     INTEGER NOT NULL DEFAULT 0,
  skipped_budget     INTEGER NOT NULL DEFAULT 0,
  changes_written    INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  endpoints_added    INTEGER NOT NULL DEFAULT 0,
  items_seen         INTEGER NOT NULL DEFAULT 0,  -- discovery items read this cycle
  note               TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cycles_started ON crawl_cycles (started_at);
CREATE INDEX IF NOT EXISTS idx_cycles_kind ON crawl_cycles (kind, started_at);

-- ────────────────────────────────────────────────── recipient_observations ──
-- Evidence for the recipient-instability question (SPEC §6.4,,. , and deliberately NOT a score input in v1.
-- x402 v2 has no on-the-wire declaration of a dynamic payTo, so a marketplace
-- rotating payout addresses is field-for-field indistinguishable from an
-- endpoint whose recipient is unstable. The one thing that CAN tell them apart
-- is shape over time: a marketplace rotates among a bounded, recurring set,
-- while an unstable recipient produces an ever-growing set of addresses seen
-- once each. Neither shape is visible in a single probe, and both need this
-- table to become visible at all.
-- So we collect the evidence and scores nothing from it.
-- Adding it to scoring is a score_version bump plus a spec/risk-score.md
-- change, which is its file — it goes through an addendum, not a quiet edit.
CREATE TABLE IF NOT EXISTS recipient_observations (
  endpoint_id  TEXT NOT NULL,
  pay_to       TEXT NOT NULL,
  network      TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  times_seen   INTEGER NOT NULL DEFAULT 1,
  -- True when the challenge that carried this recipient ALSO declared a
  -- dynamic payTo by one of the two observable surfaces we implemented
  -- (a role constant, or a recognized top-level extensions key).
  declared_dynamic INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, pay_to)
);

CREATE INDEX IF NOT EXISTS idx_recipients_endpoint ON recipient_observations (endpoint_id, last_seen);
