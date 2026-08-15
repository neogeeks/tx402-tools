-- tx402 tools — the claim flow identifies nobody (wave 5).
-- This is the decision asked to make deliberately, made in the
-- only form that cannot later be forgotten: the columns are gone.
-- `endpoint_claims` was written early with two person-shaped columns:
--   contact_email optional, operator-supplied — nothing ever wrote it
--   account_id a reference into `accounts`, which 0003 dropped
-- says nobody is identified anywhere in this product, and after
-- 0003 that is a property of the schema rather than a policy: there is no table
-- in which a person could be stored. `contact_email` was the last place a
-- session could have quietly put one back, and §6.3 requires the argument for
-- doing so to be **re-made here rather than inherited**. its answer is no,
-- and the reasoning is. In short:
--   1. A claim is proved by CONTROL OF THE DOMAIN, not by an identity we hold.
--      An email address adds nothing to the proof — DNS TXT and the well-known
--      file are complete on their own — so it would be data collected for a
--      purpose the mechanism does not have.
--   2. The claim id is the return address. It is 128 random bits, it is what an
--      operator uses to read their dossier and file an appeal, and re-proving
--      control of the origin surfaces every appeal filed for it. So there is no
--      correspondence problem left for an email address to solve.
--   3. The deletion story for a column that does not exist is trivially
--      complete, and it is the only deletion story this product can honestly
--      offer: there is no sign-in, so there is nobody to authenticate a
--      deletion request from.
-- `account_id` goes in the same breath. It references a table 0003 dropped, so
-- it is a dangling foreign reference in a schema whose whole claim is that
-- there is nothing to reference. Leaving it would invite the next session to
-- read it as a seat reserved for accounts coming back.
-- Both columns are empty in every environment — nothing has ever written to
-- `endpoint_claims` at all, because the claim routes were stubs until now.
-- Confirm before applying to a remote database:
--   wrangler d1 execute tx402-tools --remote --command \
--     "SELECT COUNT(*) AS claims,
--             COUNT(contact_email) AS with_email,
--             COUNT(account_id) AS with_account FROM endpoint_claims"
-- Neither column is referenced by an index (`idx_claims_origin` is on
-- `(origin, state)`), so DROP COLUMN cannot fail on one. SQLite supports
-- ALTER TABLE.. DROP COLUMN from 3.35; D1 is well past that.
ALTER TABLE endpoint_claims DROP COLUMN contact_email;
ALTER TABLE endpoint_claims DROP COLUMN account_id;

-- ─────────────────────────────────────────────────────────────── appeals ──
-- Rebuilt rather than altered, because two of the three changes cannot be made
-- with ALTER TABLE in SQLite.
--   1. `endpoint_id` was NOT NULL. An appeal is about an ORIGIN — that is what
--      the claim proves control of — and a pre-emptive removal ("never list
--      me") is filed by an operator whose endpoints we have never crawled, so
--      there is no endpoint id to put in it. Forcing one would mean either
--      refusing a legitimate request or writing a value that is not true.
--   2. `origin` is new, and it is what makes losing a claim id survivable:
--      appeals are looked up by origin, so re-proving control of the domain
--      brings back every appeal ever filed for it. There is no account to
--      recover from, so this query is the whole recovery story.
--   3. `remedy` is new — `correction` (reviewed by a person, appended to the
--      change log if upheld) or `removal` (applied immediately, because proof
--      of control is the whole test for an opt-out and it has already passed).
-- The table is empty in every environment: nothing has ever written to it,
-- because `/api/v1/appeal` was a stub until this change. So this is a
-- reshape of capacity, not of data. Confirm before applying to a remote
-- database — if this returns anything but 0, STOP and migrate the rows instead:
--   wrangler d1 execute tx402-tools --remote --command \
--     "SELECT COUNT(*) AS appeals FROM appeals"
-- `argument` is the one field here that could carry a person's details, and
-- only if the operator types them: nothing asks for them, nothing requires
-- them, and the route caps the field and never publishes it.

DROP TABLE IF EXISTS appeals;

CREATE TABLE IF NOT EXISTS appeals (
  id           TEXT PRIMARY KEY,
  origin       TEXT NOT NULL,                  -- what the claim proved control of
  endpoint_id  TEXT,                           -- NULL for an origin-wide appeal
  claim_id     TEXT,                           -- the verified claim that filed it
  disputed     TEXT NOT NULL,                  -- signal id, term_changes id, or 'listing'
  remedy       TEXT NOT NULL DEFAULT 'correction'
               CHECK (remedy IN ('correction', 'removal')),
  argument     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open', 'upheld', 'corrected', 'declined')),
  resolution   TEXT,
  correction_change_id TEXT,                   -- the term_changes correction row, if any
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_appeals_origin ON appeals (origin, created_at);
CREATE INDEX IF NOT EXISTS idx_appeals_endpoint ON appeals (endpoint_id, state);
CREATE INDEX IF NOT EXISTS idx_appeals_claim ON appeals (claim_id);
