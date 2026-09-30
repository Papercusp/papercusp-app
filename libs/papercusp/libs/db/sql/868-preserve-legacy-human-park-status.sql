-- 868-preserve-legacy-human-park-status.sql
-- EI-21064986835882415
--
-- Migration 867 preserved the typed destination from migration 864, but its
-- operational branch rewrote unclaimed rows whose recorded priorStatus was
-- `needs-human` to `open` (or `blocked` when an active blocker existed).
-- That silently re-admitted owner-authority work. Restore the explicit human
-- gate for that exact, evidence-backed residue without touching live claims.

CREATE TEMP TABLE migration_868_manifest ON COMMIT DROP AS
SELECT wi.workspace_id,
       wi.harness_slug,
       wi.feature_id,
       wi.item_kind,
       wi.title,
       wi.status AS old_status,
       wi.taken_by,
       COALESCE(wi.payload, '{}'::jsonb) AS old_payload,
       EXISTS (
         SELECT 1
           FROM harness_shared.work_item_claims c
          WHERE c.workspace_id = wi.workspace_id
            AND c.harness_slug = wi.harness_slug
            AND c.work_item_id = wi.feature_id
            AND c.expires_ts > now()
       ) AS active_claim
  FROM harness_shared.work_items wi
 WHERE wi.workspace_id = 'papercusp-workspace'
   AND wi.harness_slug = 'papercusp'
   AND wi.status IN ('open', 'blocked')
   AND COALESCE(wi.payload, '{}'::jsonb)
         -> '_legacyHumanParkRepair' ->> 'migration' = '867'
   AND COALESCE(wi.payload, '{}'::jsonb)
         -> '_legacyHumanParkRepair' ->> 'destination' = 'operational'
   AND COALESCE(wi.payload, '{}'::jsonb)
         -> '_legacyHumanParkRepair' ->> 'priorStatus' = 'needs-human';

DO $guard868$
DECLARE
  claimed text;
BEGIN
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id)
    INTO claimed
    FROM migration_868_manifest
   WHERE NULLIF(BTRIM(taken_by), '') IS NOT NULL OR active_claim;
  IF claimed IS NOT NULL THEN
    RAISE EXCEPTION
      '868: refusing to rewrite claimed legacy human-park row(s): %', claimed;
  END IF;
END $guard868$;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_legacy_human_park_status_repair_868
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS
  bak_20260821_legacy_human_park_status_repair_868_uq
  ON harness_shared.bak_20260821_legacy_human_park_status_repair_868
    (workspace_id, harness_slug, feature_id);

INSERT INTO harness_shared.bak_20260821_legacy_human_park_status_repair_868
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN migration_868_manifest m
    ON m.workspace_id = wi.workspace_id
   AND m.harness_slug = wi.harness_slug
   AND m.feature_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

DO $backup_guard868$
DECLARE missing_rows int;
BEGIN
  SELECT count(*)::int
    INTO missing_rows
    FROM migration_868_manifest m
   WHERE NOT EXISTS (
           SELECT 1
             FROM harness_shared.bak_20260821_legacy_human_park_status_repair_868 b
            WHERE b.workspace_id = m.workspace_id
              AND b.harness_slug = m.harness_slug
              AND b.feature_id = m.feature_id
         );
  IF missing_rows <> 0 THEN
    RAISE EXCEPTION '868: backup missing % selected row(s)', missing_rows;
  END IF;
END $backup_guard868$;

ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;

UPDATE harness_shared.work_items wi
   SET payload = jsonb_strip_nulls(
         COALESCE(wi.payload, '{}'::jsonb)
         || jsonb_build_object(
              'needsHuman', true,
              '_legacyHumanParkStatusRepair', jsonb_build_object(
                'migration', 868,
                'priorStatus', wi.status,
                'repairedAt', to_char(
                  now() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'reason', 'preserve migration-864 needs-human status'
              )
            )
       ),
       status = 'needs-human',
       updated_ts = greatest(
         COALESCE(wi.updated_ts, 0),
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       ),
       last_progress_at = now()
  FROM migration_868_manifest m
 WHERE wi.workspace_id = m.workspace_id
   AND wi.harness_slug = m.harness_slug
   AND wi.feature_id = m.feature_id
   AND NULLIF(BTRIM(wi.taken_by), '') IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.work_item_claims c
          WHERE c.workspace_id = wi.workspace_id
            AND c.harness_slug = wi.harness_slug
            AND c.work_item_id = wi.feature_id
            AND c.expires_ts > now()
       );

ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

DO $post868$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id)
    INTO bad
    FROM migration_868_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE wi.status IS DISTINCT FROM 'needs-human'
      OR wi.payload ->> 'needsHuman' IS DISTINCT FROM 'true'
      OR wi.payload -> '_legacyHumanParkStatusRepair' ->> 'migration'
           IS DISTINCT FROM '868';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '868: status repair postcondition failed for %', bad;
  END IF;
END $post868$;

COMMENT ON TABLE harness_shared.bak_20260821_legacy_human_park_status_repair_868 IS
  'Pre-mutation evidence for migration 868, restoring needs-human status lost by migration 867.';
