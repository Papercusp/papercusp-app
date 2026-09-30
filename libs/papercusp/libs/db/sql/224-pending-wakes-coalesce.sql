-- 224-pending-wakes-coalesce.sql
-- EI-312 leg 2: the manual-mode STAGING path had no coalescing — every duplicate
-- wake (e.g. the hive-watchdog boot storm) inserted its own pending_wakes row,
-- inflating the ⏸MANUAL·N badge and spamming the W review overlay (22 rows where
-- ~4 distinct wakes existed). Mirror the live pump's per-subscriber coalescing at
-- the staging boundary: identical (owner, source, summary, workspace) re-fires
-- collapse into ONE row carrying a fire count + last_seen_at.
ALTER TABLE harness_shared.pending_wakes
    ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;
ALTER TABLE harness_shared.pending_wakes
    ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- Backfill: a never-coalesced row was last seen when it was staged. (Idempotent:
-- coalesced rows have count >= 2 and are never touched.)
UPDATE harness_shared.pending_wakes
SET last_seen_at = created_at
WHERE count = 1 AND last_seen_at <> created_at;

-- Collapse pre-existing duplicates so the dedupe index can build: keep the
-- OLDEST row per (owner, source, summary, workspace), fold the rest into its
-- count, carry the newest stage time into last_seen_at. Idempotent — a second
-- run finds no groups with count(*) > 1.
WITH groups AS (
    SELECT min(id) AS keep_id,
           owner_id,
           coalesce(source, '')       AS src,
           coalesce(summary, '')      AS smry,
           coalesce(workspace_id, '') AS ws,
           sum(count)::int            AS total,
           max(created_at)            AS latest
    FROM harness_shared.pending_wakes
    GROUP BY owner_id, coalesce(source, ''), coalesce(summary, ''), coalesce(workspace_id, '')
    HAVING count(*) > 1
),
pruned AS (
    DELETE FROM harness_shared.pending_wakes pw
    USING groups g
    WHERE pw.owner_id = g.owner_id
      AND coalesce(pw.source, '') = g.src
      AND coalesce(pw.summary, '') = g.smry
      AND coalesce(pw.workspace_id, '') = g.ws
      AND pw.id <> g.keep_id
    RETURNING pw.id
)
UPDATE harness_shared.pending_wakes pw
SET count = g.total,
    last_seen_at = g.latest
FROM groups g
WHERE pw.id = g.keep_id;

-- The dedupe key stagePendingWake upserts against (ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS pending_wakes_dedupe_idx
    ON harness_shared.pending_wakes (owner_id, coalesce(source, ''), coalesce(summary, ''), coalesce(workspace_id, ''));
