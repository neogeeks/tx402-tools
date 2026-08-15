-- tx402 tools — remove accounts, channels and watches (wave 3).
-- Watch was cut before any of it shipped, and accounts went with it. They
-- existed for exactly one purpose — delivering an alert somebody had asked for
-- — so with the alerting gone
-- they would have been a person's identity stored for nothing.
-- 0001 is a landed migration and is NEVER edited, so the tables it created are
-- dropped here instead. **Every one of them is empty**: nothing ever wrote to
-- them. The accounts implementation was never merged and never deployed, and
-- `/watch` only ever served a stub, so this drops capacity rather than
-- data. Verify before applying to a remote database:
--   wrangler d1 execute tx402-tools --remote --command \
--     "SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
--             (SELECT COUNT(*) FROM auth_tokens) AS tokens,
--             (SELECT COUNT(*) FROM channels) AS channels,
--             (SELECT COUNT(*) FROM watches) AS watches,
--             (SELECT COUNT(*) FROM alerts) AS alerts"
-- The point of dropping them rather than leaving them unused: `docs/abuse-policy.md`
-- now says nobody is identified anywhere in this product, and that claim should
-- be a property of the schema rather than a promise about restraint. There is no
-- table here in which a person could be stored.
-- These tables carry no FOREIGN KEY references — 0001 joins by plain TEXT id —
-- so dropping them cannot fail on a constraint and cannot cascade into anything
-- that stays. `term_changes` is untouched: it is append-only by trigger, it is
-- about endpoints rather than people, and History and Compare both read it.
-- `endpoint_claims.account_id` survives as a column that now references nothing.
-- It belongs to its claim flow, which has not been built, and deciding what a
-- claim links to is that session's call —.

DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS watches;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS accounts;
