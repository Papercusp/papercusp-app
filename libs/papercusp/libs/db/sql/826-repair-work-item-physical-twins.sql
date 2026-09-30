-- 826-repair-work-item-physical-twins.sql
--
-- WI-38468 / drain-admission-integrity-remediation-2026-08-13 P-005.
-- Repair only the 69 physical-ID collisions frozen in the P-004 manifest and
-- snapshot 74209 (Kopia ee8d1d2dacd7b4522d3155fba6a1019d).  This is not a
-- fuzzy dedup sweep: 58 groups are content-identical physical twins and 11 are
-- divergent records that must both survive under globally unique IDs.
--
-- Evidence is preserved three ways: full pre-mutation rows in a durable backup
-- table, source payload/status/completion data embedded on identical survivors,
-- and explicit reference rewrites for divergent rows.  Bare references that
-- were authored with the non-papercusp record follow that record; Papercusp
-- release arrays deliberately retain the old ID, which remains on the
-- Papercusp survivor.
--
-- FORWARD-COMPAT: the currently deployed release treats work-item IDs and
-- thread parent refs as opaque text and does not depend on duplicate physical
-- rows, so rekeying divergent records and deleting backed-up twins is safe
-- while the older release remains live.

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260813_work_item_physical_twins
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260813_work_item_physical_twins_uq
  ON harness_shared.bak_20260813_work_item_physical_twins (harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260813_physical_twin_links
  (LIKE harness_shared.coord_links INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260813_physical_twin_links_uq
  ON harness_shared.bak_20260813_physical_twin_links (id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260813_physical_twin_threads
  (LIKE harness_shared.coord_threads INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260813_physical_twin_threads_uq
  ON harness_shared.bak_20260813_physical_twin_threads (workspace_id, thread_id);

CREATE TEMP TABLE repair_826_divergent_map (
  old_id text PRIMARY KEY,
  source_harness text NOT NULL,
  new_id text NOT NULL UNIQUE,
  reference_creator text
) ON COMMIT DROP;

INSERT INTO repair_826_divergent_map VALUES
  ('EI-11513', 'quartermaster-hive',         'EI-82600000000000001', 'system:improvement-watchdog'),
  ('EI-13306', 'operator:papercusp-workspace','EI-82600000000000002', 'system:replication-liveness'),
  ('EI-14603', 'operator:papercusp-workspace','EI-82600000000000003', 'system:replication-liveness'),
  ('EI-16821', 'papercusp-public-site-pot',  'EI-82600000000000004', 'su-795888e1-d7ef-4a15-aef1-be0e8d84d593'),
  ('EI-16843', 'papercusp-public-site-pot',  'EI-82600000000000005', 'su-f6038f9a-e6e9-4f17-9a4c-48af385a4d09'),
  ('EI-16844', 'papercusp-public-site-pot',  'EI-82600000000000006', 'su-15b57bd8-6e1c-4082-a825-f23d0f01e97f'),
  ('EI-16855', 'papercusp-public-site-pot',  'EI-82600000000000007', 'su-15b57bd8-6e1c-4082-a825-f23d0f01e97f'),
  ('EI-17122', 'papercusp-public-site-pot',  'EI-82600000000000008', 'su-6f7850f2-2112-4e72-bb09-e8983af3f851'),
  ('EI-17123', 'papercusp-public-site-pot',  'EI-82600000000000009', 'su-6f7850f2-2112-4e72-bb09-e8983af3f851'),
  ('EI-4644',  'oddsmith-hive',              'EI-82600000000000010', 'system:improvement-watchdog'),
  -- The two system:replication-liveness links on EI-8869 were stamped at the
  -- Papercusp survivor's exact creation time, 21 minutes before the operator
  -- collision existed.  NULL deliberately keeps those references on old_id.
  ('EI-8869',  'operator:papercusp-workspace','EI-82600000000000011', NULL);

CREATE TEMP TABLE repair_826_identical_ids (feature_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO repair_826_identical_ids VALUES
  ('EI-1'), ('EI-13196'), ('EI-13197'), ('EI-13205'), ('EI-13236'), ('EI-13237'),
  ('EI-13238'), ('EI-13305'), ('EI-1435'), ('EI-1629'), ('EI-1700'),
  ('EI-18184197281781732'), ('EI-2205'), ('EI-6706'), ('EI-6707'), ('EI-6708'),
  ('EI-6765'), ('EI-7019'), ('EI-7532'), ('EI-7690'), ('EI-8867'), ('EI-8868'),
  ('EI-8870'), ('EI-8871'), ('EI-8920'), ('EI-9023'), ('EI-9024'), ('EI-9025'),
  ('EI-9036'), ('EI-9037'), ('EI-9038'), ('EI-9039'), ('EI-9198'), ('EI-9199'),
  ('EI-9242'), ('EI-9243'), ('EI-9244'), ('EI-9245'), ('EI-9246'), ('EI-9262'),
  ('EI-9263'), ('EI-9264'), ('EI-9265'), ('EI-9266'), ('EI-9267'), ('EI-9268'),
  ('EI-9269'), ('EI-9270'), ('EI-9411'), ('EI-9412'), ('EI-9413'), ('EI-9414'),
  ('EI-9415'), ('EI-9416'), ('WI-1993'), ('WI-2017'), ('WI-2063'), ('WI-2124');

-- Fail before mutation if a still-colliding named identical group has drifted
-- away from the P-004 classification or lacks its Papercusp survivor.
DO $guard826$
DECLARE bad text;
BEGIN
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO bad
  FROM (
    SELECT w.feature_id
    FROM harness_shared.work_items w
    JOIN repair_826_identical_ids i USING (feature_id)
    WHERE w.workspace_id = 'papercusp-workspace'
    GROUP BY w.feature_id
    HAVING count(*) > 1 AND (
      count(*) <> 2
      OR count(*) FILTER (WHERE harness_slug = 'papercusp') <> 1
      OR count(DISTINCT coalesce(title, '')) <> 1
      OR count(DISTINCT coalesce(summary, '')) <> 1
    )
  ) drift;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '826: P-004 identical-twin classification drifted for %', bad;
  END IF;

  IF EXISTS (
    SELECT 1 FROM repair_826_divergent_map m
    JOIN harness_shared.work_items source
      ON source.workspace_id = 'papercusp-workspace'
     AND source.harness_slug = m.source_harness AND source.feature_id = m.old_id
    JOIN harness_shared.work_items target
      ON target.workspace_id = 'papercusp-workspace' AND target.feature_id = m.new_id
  ) THEN
    RAISE EXCEPTION '826: divergent target ID already exists while its old source still exists';
  END IF;
END
$guard826$;

INSERT INTO harness_shared.bak_20260813_work_item_physical_twins
SELECT w.*
FROM harness_shared.work_items w
WHERE w.workspace_id = 'papercusp-workspace'
  AND (w.feature_id IN (SELECT feature_id FROM repair_826_identical_ids)
       OR w.feature_id IN (SELECT old_id FROM repair_826_divergent_map))
ON CONFLICT (harness_slug, feature_id) DO NOTHING;

-- Keep a full copy of every coordination object whose identity will change.
INSERT INTO harness_shared.bak_20260813_physical_twin_links
SELECT l.* FROM harness_shared.coord_links l
JOIN repair_826_divergent_map m
  ON (l.src_ref = m.old_id OR l.dst_ref = m.old_id)
 AND l.created_by = m.reference_creator
WHERE l.workspace_id = 'papercusp-workspace'
ON CONFLICT (id) DO NOTHING;

INSERT INTO harness_shared.bak_20260813_physical_twin_threads
SELECT t.* FROM harness_shared.coord_threads t
JOIN repair_826_divergent_map m
  ON t.parent_ref = m.old_id AND t.created_by = m.reference_creator
WHERE t.workspace_id = 'papercusp-workspace'
ON CONFLICT (workspace_id, thread_id) DO NOTHING;

-- A bare ref is ambiguous only until provenance is consulted.  Rows authored
-- by the divergent source's reference creator move with that source; all
-- remaining bare refs continue to name the Papercusp row, which deliberately
-- keeps old_id.  A NULL reference_creator means the audit attributed no bare
-- references to that source row.
UPDATE harness_shared.coord_links l
SET src_ref = m.new_id
FROM repair_826_divergent_map m
WHERE l.workspace_id = 'papercusp-workspace'
  AND l.src_ref = m.old_id AND l.created_by = m.reference_creator;

UPDATE harness_shared.coord_links l
SET dst_ref = m.new_id
FROM repair_826_divergent_map m
WHERE l.workspace_id = 'papercusp-workspace'
  AND l.dst_ref = m.old_id AND l.created_by = m.reference_creator;

UPDATE harness_shared.coord_threads t
SET parent_ref = m.new_id
FROM repair_826_divergent_map m
WHERE t.workspace_id = 'papercusp-workspace'
  AND t.parent_ref = m.old_id AND t.created_by = m.reference_creator;

-- The P-004 reference census found zero rows on these harness-qualified
-- surfaces, but update them correctly if a late historical row arrived.
UPDATE harness_shared.work_item_claims x SET work_item_id = m.new_id
FROM repair_826_divergent_map m
WHERE x.workspace_id = 'papercusp-workspace' AND x.harness_slug = m.source_harness
  AND x.work_item_id = m.old_id;
UPDATE harness_shared.feature_claims x SET feature_id = m.new_id
FROM repair_826_divergent_map m
WHERE x.workspace_id = 'papercusp-workspace' AND x.harness_slug = m.source_harness
  AND x.feature_id = m.old_id;
UPDATE harness_shared.claim_audit x SET feature_id = m.new_id
FROM repair_826_divergent_map m
WHERE x.workspace_id = 'papercusp-workspace' AND x.harness_slug = m.source_harness
  AND x.feature_id = m.old_id;

-- Divergent records both survive.  The Papercusp row keeps the historical ID
-- (and therefore release-array attribution); the other physical row receives a
-- deterministic, migration-owned EI ID.
UPDATE harness_shared.work_items w
SET feature_id = m.new_id,
    payload = coalesce(w.payload, '{}'::jsonb) || jsonb_build_object(
      '_physicalTwinRekey', jsonb_build_object(
        'migration', 826, 'oldId', m.old_id, 'sourceHarness', m.source_harness,
        'restoreSnapshot', 'ee8d1d2dacd7b4522d3155fba6a1019d'))
FROM repair_826_divergent_map m
WHERE w.workspace_id = 'papercusp-workspace'
  AND w.harness_slug = m.source_harness AND w.feature_id = m.old_id;

-- Merge every content-identical source into the Papercusp survivor before the
-- redundant physical row is removed.  Completion evidence and terminal state
-- are promoted only when absent on the survivor; the entire source payload and
-- lifecycle metadata remain embedded for audit/recovery.
WITH pairs AS (
  SELECT p.harness_slug AS source_harness, p.feature_id, p.status AS source_status,
         p.payload AS source_payload, p.completion_ref AS source_completion_ref,
         p.terminal_completion_ref AS source_terminal_completion_ref,
         p.terminal_owner AS source_terminal_owner, p.authority AS source_authority,
         p.closed_ts AS source_closed_ts, p.updated_ts AS source_updated_ts,
         p.fed_hlc AS source_fed_hlc
  FROM harness_shared.work_items p
  JOIN repair_826_identical_ids i USING (feature_id)
  WHERE p.workspace_id = 'papercusp-workspace' AND p.harness_slug <> 'papercusp'
    AND EXISTS (
      SELECT 1 FROM harness_shared.work_items s
      WHERE s.workspace_id = p.workspace_id AND s.harness_slug = 'papercusp'
        AND s.feature_id = p.feature_id AND coalesce(s.title, '') = coalesce(p.title, '')
        AND coalesce(s.summary, '') = coalesce(p.summary, '')
    )
)
UPDATE harness_shared.work_items s
SET status = CASE
      WHEN s.status IN ('passed','deprecated','resolved','closed','done','dropped') THEN s.status
      WHEN p.source_status IN ('passed','deprecated','resolved','closed','done','dropped') THEN p.source_status
      ELSE s.status END,
    completion_ref = coalesce(s.completion_ref, p.source_completion_ref),
    terminal_completion_ref = coalesce(s.terminal_completion_ref, p.source_terminal_completion_ref),
    terminal_owner = coalesce(s.terminal_owner, p.source_terminal_owner),
    authority = coalesce(s.authority, p.source_authority),
    closed_ts = coalesce(s.closed_ts, p.source_closed_ts),
    updated_ts = greatest(s.updated_ts, p.source_updated_ts),
    payload = jsonb_strip_nulls(
      coalesce(s.payload, '{}'::jsonb)
      || CASE WHEN (coalesce(s.payload, '{}'::jsonb)->'_completionEvidence') IS NULL
                   AND (coalesce(p.source_payload, '{}'::jsonb)->'_completionEvidence') IS NOT NULL
              THEN jsonb_build_object('_completionEvidence', p.source_payload->'_completionEvidence')
              ELSE '{}'::jsonb END)
      || jsonb_build_object('_physicalTwinRepair', jsonb_strip_nulls(jsonb_build_object(
           'migration', 826, 'sourceHarness', p.source_harness,
           'sourceStatus', p.source_status, 'sourcePayload', coalesce(p.source_payload, '{}'::jsonb),
           'sourceCompletionRef', p.source_completion_ref,
           'sourceTerminalCompletionRef', p.source_terminal_completion_ref,
           'sourceTerminalOwner', p.source_terminal_owner,
           'sourceAuthority', p.source_authority, 'sourceClosedTs', p.source_closed_ts,
           'sourceUpdatedTs', p.source_updated_ts, 'sourceFedHlc', p.source_fed_hlc,
           'restoreSnapshot', 'ee8d1d2dacd7b4522d3155fba6a1019d')
           || jsonb_build_object('sourcePayload', coalesce(p.source_payload, '{}'::jsonb))))
FROM pairs p
WHERE s.workspace_id = 'papercusp-workspace' AND s.harness_slug = 'papercusp'
  AND s.feature_id = p.feature_id;

DELETE FROM harness_shared.work_items p
USING repair_826_identical_ids i
WHERE p.workspace_id = 'papercusp-workspace' AND p.feature_id = i.feature_id
  AND p.harness_slug <> 'papercusp'
  AND EXISTS (SELECT 1 FROM harness_shared.work_items s
              WHERE s.workspace_id = p.workspace_id AND s.harness_slug = 'papercusp'
                AND s.feature_id = p.feature_id);

DO $post826$
DECLARE bad text;
BEGIN
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO bad
  FROM (SELECT w.feature_id FROM harness_shared.work_items w
        WHERE w.workspace_id = 'papercusp-workspace'
          AND w.feature_id IN (SELECT feature_id FROM repair_826_identical_ids)
        GROUP BY w.feature_id HAVING count(*) > 1) q;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '826: identical physical twins remain for %', bad;
  END IF;

  SELECT string_agg(m.old_id, ', ' ORDER BY m.old_id) INTO bad
  FROM repair_826_divergent_map m
  WHERE EXISTS (SELECT 1 FROM harness_shared.work_items w
                WHERE w.workspace_id = 'papercusp-workspace'
                  AND w.harness_slug = m.source_harness AND w.feature_id = m.old_id)
     OR (EXISTS (SELECT 1 FROM harness_shared.bak_20260813_work_item_physical_twins b
                 WHERE b.harness_slug = m.source_harness AND b.feature_id = m.old_id)
         AND NOT EXISTS (SELECT 1 FROM harness_shared.work_items w
                         WHERE w.workspace_id = 'papercusp-workspace'
                           AND w.harness_slug = m.source_harness AND w.feature_id = m.new_id));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '826: divergent rekey postcondition failed for %', bad;
  END IF;
END
$post826$;
