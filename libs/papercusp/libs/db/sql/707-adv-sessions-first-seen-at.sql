-- 707 — adv_sessions.first_seen_at: a NEVER-BUMPED birth timestamp (WI-6589).
--
-- `started_at` is not a birth. Four paths deliberately bump it in place on the
-- SAME row so a resumed/re-anchored session reads as freshly-live for the
-- roster's recency window (adv-sessions.ts reactivateAdvSession,
-- reactivateAdvSessionByOwner, reanchorAdvSessionNativeId,
-- reanchorAdvSessionNativeIdByOwner). A coord owner id outlives any one of those
-- legs, and `recordAdvSession` only ever INSERTs for a genuinely new session
-- (which mints a new owner id) — so the table holds exactly ONE row per coord
-- owner (13,797 of 13,797 measured 2026-07-28) and MIN(started_at) is
-- arithmetically identical to MAX(started_at): the LATEST LAUNCH.
--
-- That made the unread badge's "birth floor" (unread-count-truthfulness D-012)
-- a latest-launch floor, which is precisely the failure
-- firstAdvSessionStartByCoordOwner's own doc comment says the MIN was chosen to
-- prevent. This column is written once at INSERT and never updated, so the floor
-- becomes a true birth for every session recorded from here on.
--
-- Backfill: existing rows have already lost their original start. `archived_at`
-- is the only surviving evidence of an earlier leg (81 rows carry an
-- archived_at that PREDATES started_at); everywhere else started_at is the best
-- available lower bound. Both are lower bounds, which is the safe direction — a
-- floor that is too EARLY only widens the candidate set, while one that is too
-- LATE hides mail.

-- FORWARD-COMPAT: the SET NOT NULL below is preceded by SET DEFAULT now() (three
-- statements down), so any INSERT that omits the column — which is every deployed
-- INSERT, since the column postdates the release — gets the default automatically;
-- Postgres never requires an omitted DEFAULT-bearing column to be listed explicitly.
-- Checked against deployed sha 1e0ddc5864 directly (adv-sessions.ts recordAdvSession,
-- both the ported and non-ported INSERT column lists): neither mentions `first_seen_at`.
-- (WI-6842)
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;

UPDATE harness_shared.adv_sessions
   SET first_seen_at = LEAST(started_at, COALESCE(archived_at, started_at))
 WHERE first_seen_at IS NULL;

ALTER TABLE harness_shared.adv_sessions
  ALTER COLUMN first_seen_at SET DEFAULT now();

ALTER TABLE harness_shared.adv_sessions
  ALTER COLUMN first_seen_at SET NOT NULL;

-- The unread birth floor reads MIN(first_seen_at) per coord owner.
CREATE INDEX IF NOT EXISTS adv_sessions_coord_owner_first_seen_idx
  ON harness_shared.adv_sessions (coord_owner_id, first_seen_at)
  WHERE coord_owner_id IS NOT NULL;
