-- 1020-retire-cross-harness-legacy-needs-human-residue.sql
-- EI-21677320048374444
--
-- Every wave that retired the payload.needsHuman dialect was scoped to a single
-- harness -- 864, 867, 868, 870 and 950 all carry
-- `workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'`.
-- Within that scope the chase succeeded (papercusp measures zero). Outside it,
-- three harnesses were never in ANY cohort and still carry the retired key:
--   sidestage                  3 open + 3 needs-human
--   oddsmith-hive              2 needs-human
--   papercusp-public-site-pot  1 open
-- The 4 non-needs-human rows are additionally mis-admitted to the human inbox by
-- the attention source's payload leg, which is how the residue was noticed.
--
-- DETERMINATION (2026-08-28, EI-21677320048374444): this is un-migrated legacy,
-- NOT a live dialect. No writer sets payload.needsHuman anywhere in the tree --
-- work-items.ts:4059 is the surviving needs-human transition and it writes
-- payload.needsOwnerAction while UNSETTING needsHuman; every other write-side
-- site is likewise an unset. The writers live in packages/operator-core, one
-- operator serving every harness, so the dialect cannot be live in one harness
-- and dead in another; nothing has carried the key anywhere since 2026-08-23.
-- The correct repair is therefore a key normalization, not a re-classification:
-- each row is brought to exactly the shape today's live writer would produce.
--
-- DELIBERATELY NOT A TENANT-SCOPED COHORT. This migration takes no workspace_id
-- and no harness_slug predicate, because a hardcoded tenant filter is the defect
-- being repaired. A future harness inherits the fix instead of a sixth wave.
--
-- PAYLOAD-ONLY AND CLAIM-NEUTRAL. Unlike 868, this migration never writes
-- status, taken_by or last_progress_at, so it is safe against a row another pot
-- is actively holding; the postcondition asserts that neutrality rather than
-- refusing claimed rows, so a live claim in another pot can never wedge boot.
--
-- KNOWN, DELIBERATE RESIDUE: 3 papercusp rows on the observation lane
-- (EI-11718, EI-6512, EI-7149) also carry the retired key. Every wave excluded
-- lane='observation' and this migration keeps that exclusion, so the cohort
-- stays exactly the 9 rows scoped for this repair. Those 3 are already excluded
-- at the source layer by the sibling fix on EI-21675115869134466, so they are
-- inert; they are named here so the exclusion is a recorded decision and not a
-- second silent carve-out.

CREATE TEMP TABLE migration_1020_manifest ON COMMIT DROP AS
SELECT wi.workspace_id,
       wi.harness_slug,
       wi.feature_id,
       wi.status  AS old_status,
       wi.taken_by AS old_taken_by,
       COALESCE(wi.payload, '{}'::jsonb) AS old_payload
  FROM harness_shared.work_items wi
 WHERE wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
   AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'  IS DISTINCT FROM 'observation'
   AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
   AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true';

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS
  bak_20260828_legacy_needs_human_cross_harness_1020_uq
  ON harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020
    (workspace_id, harness_slug, feature_id);

INSERT INTO harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN migration_1020_manifest m
    ON m.workspace_id = wi.workspace_id
   AND m.harness_slug = wi.harness_slug
   AND m.feature_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

DO $backup_guard1020$
DECLARE missing_rows int;
BEGIN
  SELECT count(*)::int
    INTO missing_rows
    FROM migration_1020_manifest m
   WHERE NOT EXISTS (
           SELECT 1
             FROM harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020 b
            WHERE b.workspace_id = m.workspace_id
              AND b.harness_slug = m.harness_slug
              AND b.feature_id = m.feature_id
         );
  IF missing_rows <> 0 THEN
    RAISE EXCEPTION '1020: backup missing % selected row(s)', missing_rows;
  END IF;
END $backup_guard1020$;

-- NOTE: deliberately NO `ALTER TABLE ... DISABLE TRIGGER USER`, unlike 868.
-- That statement needs ACCESS EXCLUSIVE on harness_shared.work_items -- the
-- hottest table in the system -- and a pending exclusive request queues every
-- reader behind it. Attempted once here under live fleet load and it exhausted
-- all 5 lock_timeout retries; left armed, it could fail the migration at boot.
-- 868 needed the silence because it rewrote status. This migration is
-- payload-only, so the triggers are not merely tolerable but WANTED:
-- emit_change_notify_trg is the sync invalidation that makes the attention feed
-- reflect the repair, and the outbox triggers federate it. Row locks on 9 rows
-- are all this needs.

-- Drop the retired key. A row already parked at status='needs-human' additionally
-- gains the strict typed gate, which is precisely what the live needs-human
-- transition writes today -- so the human gate is preserved, never re-admitted.
UPDATE harness_shared.work_items wi
   SET payload = (
         (COALESCE(wi.payload, '{}'::jsonb) - 'needsHuman')
         || CASE
              WHEN wi.status = 'needs-human'
                THEN jsonb_build_object('needsOwnerAction', true)
              ELSE '{}'::jsonb
            END
         || jsonb_build_object(
              '_legacyNeedsHumanCrossHarness', jsonb_build_object(
                'migration', 1020,
                'priorStatus', wi.status,
                'setNeedsOwnerAction', (wi.status = 'needs-human'),
                'normalizedAt', to_char(
                  now() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'reason', 'waves 864/867/868/870/950 were scoped to harness_slug=papercusp'
              )
            )
       ),
       updated_ts = greatest(
         COALESCE(wi.updated_ts, 0),
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
  FROM migration_1020_manifest m
 WHERE wi.workspace_id = m.workspace_id
   AND wi.harness_slug = m.harness_slug
   AND wi.feature_id = m.feature_id;

DO $post1020$
DECLARE
  bad text;
  moved text;
BEGIN
  -- Cohort postcondition: the retired key is gone, and every row that was parked
  -- at needs-human now carries the strict typed gate in its place.
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id)
    INTO bad
    FROM migration_1020_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE COALESCE(wi.payload, '{}'::jsonb) ? 'needsHuman'
      OR (m.old_status = 'needs-human'
          AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1020: normalization postcondition failed for %', bad;
  END IF;

  -- Neutrality postcondition: this migration touches payload only. If it ever
  -- moves another pot's status or ownership, that is a defect, not a repair.
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id)
    INTO moved
    FROM migration_1020_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE wi.status IS DISTINCT FROM m.old_status
      OR wi.taken_by IS DISTINCT FROM m.old_taken_by;
  IF moved IS NOT NULL THEN
    RAISE EXCEPTION '1020: refusing a non-neutral rewrite -- status/ownership moved for %', moved;
  END IF;
END $post1020$;

COMMENT ON TABLE harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020 IS
  'Pre-mutation evidence for migration 1020, retiring the payload.needsHuman residue in the harnesses that migrations 864/867/868/870/950 never covered.';
