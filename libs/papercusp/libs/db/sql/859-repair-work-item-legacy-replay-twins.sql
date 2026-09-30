-- 859-repair-work-item-legacy-replay-twins.sql
--
-- WI-40113 / drain-admission-integrity-remediation-2026-08-13 P-006.
-- Migration 826 repaired a frozen set of same-ID physical twins, but legacy
-- pre-829 Hyperbee PUTs have bare keys and can replay the retired source row.
-- Repair only recurrences proven by the durable migration-826 snapshot.  The
-- projection change paired with this migration suppresses subsequent bare PUTs.
--
-- This is evidence-preserving and fail-closed: classify against the original
-- snapshot plus the live survivor/rekey marker, reject content or reference
-- drift, snapshot every current source row, persist the exact action manifest,
-- merge lifecycle/completion evidence, then delete only manifested sources.

DO $pre859$
BEGIN
  IF to_regclass('harness_shared.bak_20260813_work_item_physical_twins') IS NULL THEN
    RAISE EXCEPTION '859: migration-826 physical-twin backup is missing';
  END IF;
END
$pre859$;

CREATE TEMP TABLE repair_859_manifest ON COMMIT DROP AS
WITH replay AS (
  SELECT live.workspace_id, live.harness_slug AS source_harness,
         live.feature_id AS old_id, live.title, live.summary
    FROM harness_shared.bak_20260813_work_item_physical_twins original
    JOIN harness_shared.work_items live
      ON live.workspace_id = original.workspace_id
     AND live.harness_slug = original.harness_slug
     AND live.feature_id = original.feature_id
   WHERE live.workspace_id = 'papercusp-workspace'
     AND live.harness_slug <> 'papercusp'
), classified AS (
  SELECT replay.*,
         EXISTS (
           SELECT 1
             FROM harness_shared.bak_20260813_work_item_physical_twins original_source
             JOIN harness_shared.bak_20260813_work_item_physical_twins original_target
               ON original_target.workspace_id = original_source.workspace_id
              AND original_target.harness_slug = 'papercusp'
              AND original_target.feature_id = original_source.feature_id
             JOIN harness_shared.work_items target
               ON target.workspace_id = original_target.workspace_id
              AND target.harness_slug = 'papercusp'
              AND target.feature_id = original_target.feature_id
            WHERE original_source.workspace_id = replay.workspace_id
              AND original_source.harness_slug = replay.source_harness
              AND original_source.feature_id = replay.old_id
              AND coalesce(original_source.title, '') = coalesce(original_target.title, '')
              AND coalesce(original_source.summary, '') = coalesce(original_target.summary, '')
              AND coalesce(target.title, '') = coalesce(replay.title, '')
              AND coalesce(target.summary, '') = coalesce(replay.summary, '')
         ) AS merged_match,
         (SELECT count(*)::int
            FROM harness_shared.work_items target
           WHERE target.workspace_id = replay.workspace_id
             AND target.payload->'_physicalTwinRekey'->>'migration' = '826'
             AND target.payload->'_physicalTwinRekey'->>'oldId' = replay.old_id
             AND target.payload->'_physicalTwinRekey'->>'sourceHarness' = replay.source_harness
             AND coalesce(target.title, '') = coalesce(replay.title, '')
             AND coalesce(target.summary, '') = coalesce(replay.summary, '')) AS rekeyed_matches,
         (SELECT min(target.feature_id)
            FROM harness_shared.work_items target
           WHERE target.workspace_id = replay.workspace_id
             AND target.payload->'_physicalTwinRekey'->>'migration' = '826'
             AND target.payload->'_physicalTwinRekey'->>'oldId' = replay.old_id
             AND target.payload->'_physicalTwinRekey'->>'sourceHarness' = replay.source_harness
             AND coalesce(target.title, '') = coalesce(replay.title, '')
             AND coalesce(target.summary, '') = coalesce(replay.summary, '')) AS rekeyed_target_id
    FROM replay
)
SELECT workspace_id, source_harness, old_id,
       CASE
         WHEN merged_match AND rekeyed_matches = 0 THEN 'merged'
         WHEN NOT merged_match AND rekeyed_matches = 1 THEN 'rekeyed'
         ELSE NULL
       END::text AS repair_class,
       CASE WHEN merged_match THEN 'papercusp' ELSE source_harness END::text AS target_harness,
       CASE WHEN merged_match THEN old_id ELSE rekeyed_target_id END::text AS target_id,
       merged_match, rekeyed_matches
  FROM classified;

DO $guard859$
DECLARE bad text;
BEGIN
  SELECT string_agg(source_harness || '/' || old_id, ', ' ORDER BY source_harness, old_id)
    INTO bad
    FROM repair_859_manifest
   WHERE repair_class IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '859: replay classification drifted or is ambiguous for %', bad;
  END IF;

  SELECT string_agg(source_harness || '/' || old_id, ', ' ORDER BY source_harness, old_id)
    INTO bad
    FROM repair_859_manifest m
   WHERE EXISTS (
           SELECT 1 FROM harness_shared.work_item_claims x
            WHERE x.workspace_id = m.workspace_id
              AND x.harness_slug = m.source_harness AND x.work_item_id = m.old_id)
      OR EXISTS (
           SELECT 1 FROM harness_shared.feature_claims x
            WHERE x.workspace_id = m.workspace_id
              AND x.harness_slug = m.source_harness AND x.feature_id = m.old_id)
      OR EXISTS (
           SELECT 1 FROM harness_shared.claim_audit x
            WHERE x.workspace_id = m.workspace_id
              AND x.harness_slug = m.source_harness AND x.feature_id = m.old_id);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '859: exact source-harness references require audit before repair for %', bad;
  END IF;
END
$guard859$;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260820_work_item_legacy_replay_twins
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260820_work_item_legacy_replay_twins_uq
  ON harness_shared.bak_20260820_work_item_legacy_replay_twins (harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260820_legacy_replay_twin_manifest (
  workspace_id text NOT NULL,
  source_harness text NOT NULL,
  old_id text NOT NULL,
  repair_class text NOT NULL CHECK (repair_class IN ('merged', 'rekeyed')),
  target_harness text NOT NULL,
  target_id text NOT NULL,
  coord_link_refs bigint NOT NULL,
  coord_thread_refs bigint NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_harness, old_id)
);

INSERT INTO harness_shared.bak_20260820_work_item_legacy_replay_twins
SELECT source.*
  FROM harness_shared.work_items source
  JOIN repair_859_manifest m
    ON m.workspace_id = source.workspace_id
   AND m.source_harness = source.harness_slug
   AND m.old_id = source.feature_id
ON CONFLICT (harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.bak_20260820_legacy_replay_twin_manifest
  (workspace_id, source_harness, old_id, repair_class, target_harness, target_id,
   coord_link_refs, coord_thread_refs)
SELECT m.workspace_id, m.source_harness, m.old_id, m.repair_class, m.target_harness, m.target_id,
       (SELECT count(*) FROM harness_shared.coord_links l
         WHERE l.workspace_id = m.workspace_id AND (l.src_ref = m.old_id OR l.dst_ref = m.old_id)),
       (SELECT count(*) FROM harness_shared.coord_threads t
         WHERE t.workspace_id = m.workspace_id AND t.parent_ref = m.old_id)
  FROM repair_859_manifest m
ON CONFLICT (workspace_id, source_harness, old_id) DO NOTHING;

-- Same-content recurrences merge into the Papercusp survivor.  Reassert the
-- migration-826 identity marker even if a later survivor replay overwrote it.
WITH source AS (
  SELECT m.*, b.status AS source_status, b.payload AS source_payload,
         b.completion_ref AS source_completion_ref,
         b.terminal_completion_ref AS source_terminal_completion_ref,
         b.terminal_owner AS source_terminal_owner, b.authority AS source_authority,
         b.closed_ts AS source_closed_ts, b.updated_ts AS source_updated_ts,
         b.fed_hlc AS source_fed_hlc
    FROM repair_859_manifest m
    JOIN harness_shared.bak_20260820_work_item_legacy_replay_twins b
      ON b.workspace_id = m.workspace_id AND b.harness_slug = m.source_harness
     AND b.feature_id = m.old_id
   WHERE m.repair_class = 'merged'
)
UPDATE harness_shared.work_items target
   SET status = CASE
         WHEN target.status IN ('passed','deprecated','resolved','closed','done','dropped') THEN target.status
         WHEN source.source_status IN ('passed','deprecated','resolved','closed','done','dropped') THEN source.source_status
         ELSE target.status END,
       completion_ref = coalesce(target.completion_ref, source.source_completion_ref),
       terminal_completion_ref = coalesce(target.terminal_completion_ref, source.source_terminal_completion_ref),
       terminal_owner = coalesce(target.terminal_owner, source.source_terminal_owner),
       authority = coalesce(target.authority, source.source_authority),
       closed_ts = coalesce(target.closed_ts, source.source_closed_ts),
       updated_ts = greatest(target.updated_ts, source.source_updated_ts),
       payload = jsonb_strip_nulls(
         coalesce(target.payload, '{}'::jsonb)
         || CASE
              WHEN coalesce(target.payload, '{}'::jsonb)->'_completionEvidence' IS NULL
               AND coalesce(source.source_payload, '{}'::jsonb)->'_completionEvidence' IS NOT NULL
              THEN jsonb_build_object('_completionEvidence', source.source_payload->'_completionEvidence')
              ELSE '{}'::jsonb
            END
         || jsonb_build_object(
              '_physicalTwinRepair',
              coalesce(target.payload->'_physicalTwinRepair', '{}'::jsonb)
                || jsonb_build_object('migration', 826, 'sourceHarness', source.source_harness,
                                      'reassertedByMigration', 859),
              '_physicalTwinReplayRepair', jsonb_strip_nulls(jsonb_build_object(
                'migration', 859, 'sourceHarness', source.source_harness,
                'sourceStatus', source.source_status,
                'sourcePayload', coalesce(source.source_payload, '{}'::jsonb),
                'sourceCompletionRef', source.source_completion_ref,
                'sourceTerminalCompletionRef', source.source_terminal_completion_ref,
                'sourceTerminalOwner', source.source_terminal_owner,
                'sourceAuthority', source.source_authority,
                'sourceClosedTs', source.source_closed_ts,
                'sourceUpdatedTs', source.source_updated_ts,
                'sourceFedHlc', source.source_fed_hlc))))
  FROM source
 WHERE target.workspace_id = source.workspace_id
   AND target.harness_slug = source.target_harness
   AND target.feature_id = source.target_id;

-- Divergent recurrences merge lifecycle/completion evidence into the already
-- rekeyed entity; title/summary equality was required by the guard above.
WITH source AS (
  SELECT m.*, b.status AS source_status, b.payload AS source_payload,
         b.completion_ref AS source_completion_ref,
         b.terminal_completion_ref AS source_terminal_completion_ref,
         b.terminal_owner AS source_terminal_owner, b.authority AS source_authority,
         b.closed_ts AS source_closed_ts, b.updated_ts AS source_updated_ts,
         b.fed_hlc AS source_fed_hlc
    FROM repair_859_manifest m
    JOIN harness_shared.bak_20260820_work_item_legacy_replay_twins b
      ON b.workspace_id = m.workspace_id AND b.harness_slug = m.source_harness
     AND b.feature_id = m.old_id
   WHERE m.repair_class = 'rekeyed'
)
UPDATE harness_shared.work_items target
   SET status = CASE
         WHEN target.status IN ('passed','deprecated','resolved','closed','done','dropped') THEN target.status
         WHEN source.source_status IN ('passed','deprecated','resolved','closed','done','dropped') THEN source.source_status
         ELSE target.status END,
       completion_ref = coalesce(target.completion_ref, source.source_completion_ref),
       terminal_completion_ref = coalesce(target.terminal_completion_ref, source.source_terminal_completion_ref),
       terminal_owner = coalesce(target.terminal_owner, source.source_terminal_owner),
       authority = coalesce(target.authority, source.source_authority),
       closed_ts = coalesce(target.closed_ts, source.source_closed_ts),
       updated_ts = greatest(target.updated_ts, source.source_updated_ts),
       payload = jsonb_strip_nulls(
         coalesce(target.payload, '{}'::jsonb)
         || CASE
              WHEN coalesce(target.payload, '{}'::jsonb)->'_completionEvidence' IS NULL
               AND coalesce(source.source_payload, '{}'::jsonb)->'_completionEvidence' IS NOT NULL
              THEN jsonb_build_object('_completionEvidence', source.source_payload->'_completionEvidence')
              ELSE '{}'::jsonb
            END
         || jsonb_build_object(
              '_physicalTwinReplayRepair', jsonb_strip_nulls(jsonb_build_object(
                'migration', 859, 'sourceHarness', source.source_harness,
                'oldId', source.old_id, 'sourceStatus', source.source_status,
                'sourcePayload', coalesce(source.source_payload, '{}'::jsonb),
                'sourceCompletionRef', source.source_completion_ref,
                'sourceTerminalCompletionRef', source.source_terminal_completion_ref,
                'sourceTerminalOwner', source.source_terminal_owner,
                'sourceAuthority', source.source_authority,
                'sourceClosedTs', source.source_closed_ts,
                'sourceUpdatedTs', source.source_updated_ts,
                'sourceFedHlc', source.source_fed_hlc))))
  FROM source
 WHERE target.workspace_id = source.workspace_id
   AND target.harness_slug = source.target_harness
   AND target.feature_id = source.target_id;

DELETE FROM harness_shared.work_items source
USING repair_859_manifest m
WHERE source.workspace_id = m.workspace_id
  AND source.harness_slug = m.source_harness
  AND source.feature_id = m.old_id;

DO $post859$
DECLARE bad text;
BEGIN
  SELECT string_agg(m.source_harness || '/' || m.old_id, ', ' ORDER BY m.source_harness, m.old_id)
    INTO bad
    FROM repair_859_manifest m
   WHERE EXISTS (
           SELECT 1 FROM harness_shared.work_items source
            WHERE source.workspace_id = m.workspace_id
              AND source.harness_slug = m.source_harness
              AND source.feature_id = m.old_id)
      OR NOT EXISTS (
           SELECT 1 FROM harness_shared.work_items target
            WHERE target.workspace_id = m.workspace_id
              AND target.harness_slug = m.target_harness
              AND target.feature_id = m.target_id);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '859: replay repair postcondition failed for %', bad;
  END IF;
END
$post859$;
