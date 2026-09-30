-- 865-work-items-watchdog-key-identity-guard.sql
--
-- EI-18831413711020852 — watchdogKey coalescing races at catalog registration.
--
-- `improvements:capture` has always done a read-then-insert for keyed signals.
-- Two hot-reload registrations can therefore both miss the open row and both
-- insert it.  The durable identity is wider than the key alone: a synthetic
-- drill must not suppress an organic signal, an observation is not an
-- improvement, and one Pot must not suppress another Pot's signal.
--
-- The unified `harness_shared.work_items` table is the base write surface;
-- `engineer_issues` is only its compatibility view.  Repair the pre-existing
-- live duplicates on the base table, retain every pre-mutation row in a backup,
-- record the deterministic winner/loser decision in a manifest, then enforce
-- the identity with a partial unique index over non-terminal issue-family rows.
-- The capture writer catches this index's 23505 and coalesces the winner.

-- Migration 865 is a historical repair plus a write-path guard.  Keep the base
-- table quiescent while the duplicate census, repair, and index build share one
-- transaction; otherwise a concurrent insert could escape the census and make
-- the subsequent unique-index build fail nondeterministically.
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_work_items_watchdog_identity
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);

CREATE UNIQUE INDEX IF NOT EXISTS bak_20260821_work_items_watchdog_identity_uq
  ON harness_shared.bak_20260821_work_items_watchdog_identity (workspace_id, harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_watchdog_identity_repairs (
  workspace_id       text        NOT NULL,
  harness_slug       text        NOT NULL,
  watchdog_key       text        NOT NULL,
  signal_origin      text        NOT NULL,
  lane               text        NOT NULL,
  winner_id          text        NOT NULL,
  loser_id           text        NOT NULL,
  loser_status       text,
  loser_taken_by     text,
  repaired_at        timestamptz NOT NULL DEFAULT now(),
  repair_reason      text        NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, watchdog_key, signal_origin, lane, loser_id)
);

-- Keep the SQL identity expression byte-aligned with the unique index below.
-- `status IS NULL` is intentionally treated as non-terminal: an unknown
-- lifecycle value must not bypass a safety guard that is meant to prevent a
-- duplicate live signal.
CREATE TEMP TABLE repair_865_watchdog_identity ON COMMIT DROP AS
WITH keyed AS (
  SELECT
    wi.workspace_id,
    wi.harness_slug,
    wi.feature_id,
    wi.status,
    wi.taken_by,
    wi.payload,
    wi.created_ts,
    wi.updated_ts,
    wi.payload ->> 'watchdogKey' AS watchdog_key,
    COALESCE(wi.payload -> '_ei' ->> 'signal_origin', 'organic') AS signal_origin,
    COALESCE(wi.payload ->> 'lane', 'improvement') AS lane
  FROM harness_shared.work_items wi
  WHERE wi.item_kind IN ('bug', 'change', 'task')
    AND (wi.status IS NULL OR wi.status <> ALL (
      ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
    ))
    AND wi.payload ->> 'watchdogKey' IS NOT NULL
), ranked AS (
  SELECT
    keyed.*,
    row_number() OVER (
      PARTITION BY workspace_id, harness_slug, watchdog_key, signal_origin, lane
      ORDER BY
        (taken_by IS NOT NULL) DESC,
        COALESCE(updated_ts, 0) DESC,
        COALESCE(created_ts, 0) ASC,
        feature_id ASC
    ) AS identity_rank,
    first_value(feature_id) OVER (
      PARTITION BY workspace_id, harness_slug, watchdog_key, signal_origin, lane
      ORDER BY
        (taken_by IS NOT NULL) DESC,
        COALESCE(updated_ts, 0) DESC,
        COALESCE(created_ts, 0) ASC,
        feature_id ASC
    ) AS winner_id
  FROM keyed
)
SELECT
  workspace_id,
  harness_slug,
  watchdog_key,
  signal_origin,
  lane,
  winner_id,
  feature_id AS loser_id,
  status AS loser_status,
  taken_by AS loser_taken_by,
  payload AS loser_payload
FROM ranked
WHERE identity_rank > 1;

-- Snapshot every row that will be changed.  The backup table is deliberately
-- full-row, not a hand-picked evidence projection, so future repair tooling can
-- recover completion, claims, payload, federation clocks, and provenance.
INSERT INTO harness_shared.bak_20260821_work_items_watchdog_identity
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN repair_865_watchdog_identity r
    ON r.workspace_id = wi.workspace_id
   AND r.harness_slug = wi.harness_slug
   AND r.loser_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.bak_20260821_watchdog_identity_repairs
  (workspace_id, harness_slug, watchdog_key, signal_origin, lane,
   winner_id, loser_id, loser_status, loser_taken_by, repair_reason)
SELECT workspace_id, harness_slug, watchdog_key, signal_origin, lane,
       winner_id, loser_id, loser_status, loser_taken_by,
       '865: duplicate non-terminal watchdog identity; winner retained, loser terminalized'
  FROM repair_865_watchdog_identity
ON CONFLICT (workspace_id, harness_slug, watchdog_key, signal_origin, lane, loser_id)
DO NOTHING;

-- This is a historical repair, not a new agent-authored transition.  Disable
-- USER triggers so federation clocks, CDC, and notification fan-out preserve
-- their pre-migration provenance.  The full source row and the exact winner
-- decision remain in the two durable backup/manifest tables above; the loser
-- itself remains queryable as a terminal historical row rather than becoming a
-- dangling reference after DELETE.
ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;

UPDATE harness_shared.work_items loser
   SET status = 'dropped',
       terminal_owner = COALESCE(loser.terminal_owner, 'system:migration-865'),
       terminal_reason = COALESCE(loser.terminal_reason, 'duplicate-watchdog-identity-865'),
       terminal_completion_ref = COALESCE(
         loser.terminal_completion_ref,
         'migration-865:duplicate-of:' || r.winner_id
       ),
       closed_ts = COALESCE(
         loser.closed_ts,
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       ),
       payload = COALESCE(loser.payload, '{}'::jsonb) || jsonb_build_object(
         '_watchdogIdentityRepair', jsonb_build_object(
           'migration', 865,
           'winnerId', r.winner_id,
           'watchdogKey', r.watchdog_key,
           'signalOrigin', r.signal_origin,
           'lane', r.lane,
           'priorStatus', r.loser_status,
           'repairedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         )
       ),
       updated_ts = greatest(
         COALESCE(loser.updated_ts, 0),
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
  FROM repair_865_watchdog_identity r
 WHERE loser.workspace_id = r.workspace_id
   AND loser.harness_slug = r.harness_slug
   AND loser.feature_id = r.loser_id;

ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

DO $verify_repair865$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(loser_id, ', ' ORDER BY loser_id)
    INTO bad
    FROM repair_865_watchdog_identity r
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = r.workspace_id
     AND wi.harness_slug = r.harness_slug
     AND wi.feature_id = r.loser_id
   WHERE wi.status IS DISTINCT FROM 'dropped'
      OR wi.payload -> '_watchdogIdentityRepair' ->> 'migration' IS DISTINCT FROM '865'
      OR wi.payload -> '_watchdogIdentityRepair' ->> 'winnerId' IS DISTINCT FROM r.winner_id;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '865: duplicate watchdog repair post-condition failed for %', bad;
  END IF;

  SELECT string_agg(
           workspace_id || '/' || harness_slug || '/' || watchdog_key,
           ', ' ORDER BY workspace_id, harness_slug, watchdog_key
         )
    INTO bad
    FROM (
      SELECT workspace_id, harness_slug, watchdog_key, signal_origin, lane
        FROM (
          SELECT workspace_id,
                 harness_slug,
                 payload ->> 'watchdogKey' AS watchdog_key,
                 COALESCE(payload -> '_ei' ->> 'signal_origin', 'organic') AS signal_origin,
                 COALESCE(payload ->> 'lane', 'improvement') AS lane
            FROM harness_shared.work_items
           WHERE item_kind IN ('bug', 'change', 'task')
             AND (status IS NULL OR status <> ALL (
               ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
             ))
             AND payload ->> 'watchdogKey' IS NOT NULL
        ) keyed
       GROUP BY workspace_id, harness_slug, watchdog_key, signal_origin, lane
       HAVING count(*) > 1
    ) remaining;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '865: non-terminal watchdog identities remain duplicated: %', bad;
  END IF;
END
$verify_repair865$;

-- The partial predicate intentionally repeats the non-terminal issue-family
-- vocabulary used by the repair census.  Terminal history may retain the same
-- watchdogKey; only one live issue-family owner is structurally permitted.
-- FORWARD-COMPAT: this is a net-new partial unique index. No deployed release
-- names it as an ON CONFLICT arbiter or relies on an unpredicated uniqueness
-- contract for these columns; the deployed capture writer still uses its
-- existing SELECT-then-create path. Migration 865's companion code catches
-- this index's named 23505 after an INSERT race, so adding this guard does not
-- narrow or invalidate any arbiter used by an older release.
CREATE UNIQUE INDEX IF NOT EXISTS work_items_watchdog_identity_uq
  ON harness_shared.work_items (
    workspace_id,
    harness_slug,
    (payload ->> 'watchdogKey'),
    (COALESCE(payload -> '_ei' ->> 'signal_origin', 'organic')),
    (COALESCE(payload ->> 'lane', 'improvement'))
  )
  WHERE item_kind IN ('bug', 'change', 'task')
    AND (status IS NULL OR status <> ALL (
      ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
    ))
    AND payload ->> 'watchdogKey' IS NOT NULL;

COMMENT ON INDEX harness_shared.work_items_watchdog_identity_uq IS
  'EI-18831413711020852 / migration 865: one non-terminal issue-family watchdog identity per workspace, Pot, effective signal origin, and effective lane. Terminal rows retain historical keys; capture-core coalesces the winner after a 23505 race.';
