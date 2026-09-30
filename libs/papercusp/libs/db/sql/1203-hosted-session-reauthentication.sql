-- 1203-hosted-session-reauthentication.sql — P-319 / WI-10002240.
--
-- One identity-provider session may back many local hosted sessions over time,
-- but only one at a time.
--
-- WorkOS keeps its own browser session alive far longer than the 5-minute access
-- token a local hosted session is bound to. Signing in again from the same
-- browser therefore returns the SAME upstream session id, and migration 902's
-- table-wide UNIQUE (upstream_provider, upstream_session_id) refused the new row
-- with a duplicate-key error. Measured 2026-09-23 14:40Z: the owner's sign-in
-- failed twice with `session_create_failed` for exactly this reason.
--
-- The key now holds only among unrevoked rows. HostedSessionStore.create revokes
-- the same user's earlier rows for that upstream session (reason
-- `superseded_by_reauthentication`) before inserting, so revoked rows stay as
-- history and a live row owned by a DIFFERENT user still refuses the insert.
--
-- lint-migrations: allow-index-swap no statement anywhere (operator-core, apps, portal) writes papercusp_auth.hosted_sessions with ON CONFLICT, so no conflict target can stop matching; and a two-phase swap cannot fix this bug, because the table-wide constraint IS the defect and keeping it keeps sign-in broken.
-- FORWARD-COMPAT: the currently deployed release only ever INSERTs into this table without ON CONFLICT, so a narrower unique index refuses a subset of what the old constraint refused and no deployed statement depends on the wider one.

ALTER TABLE papercusp_auth.hosted_sessions
  DROP CONSTRAINT IF EXISTS hosted_sessions_upstream_session_key;

CREATE UNIQUE INDEX IF NOT EXISTS hosted_sessions_upstream_session_key
  ON papercusp_auth.hosted_sessions (upstream_provider, upstream_session_id)
  WHERE revoked_at IS NULL;
