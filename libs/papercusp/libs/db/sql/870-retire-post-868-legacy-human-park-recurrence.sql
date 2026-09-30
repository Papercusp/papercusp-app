-- 870-retire-post-868-legacy-human-park-recurrence.sql
-- abolish-human-review-agent-review-only-2026-08-02 P-006 / D-001 / D-004
--
-- Migration 868 deliberately restored the ambiguous payload.needsHuman flag and
-- status='needs-human' for an operational subset. Additional legacy writers then
-- recreated the same shape after migration 867. Retire the entire live residue
-- through the typed destinations established by migration 864:
--    6 owning-peer reconciliation
--    8 Blender-backed agent review
--    0 strict owner capability
--   16 ordinary operational work
--
-- The live cohort was re-read from the exact migration-864 postcondition on
-- 2026-08-21. The guard is intentionally exact and refuses drift or any live
-- claim. A pristine/bootstrap database takes the zero-row path. Reapplication
-- after a successful 30-row repair is idempotent through the backup witness.

CREATE TEMP TABLE migration_870_manifest ON COMMIT DROP AS
WITH cohort AS (
  SELECT wi.workspace_id, wi.harness_slug, wi.feature_id, wi.item_kind,
         wi.title, wi.status AS old_status, wi.origin, wi.taken_by,
         COALESCE(wi.payload, '{}'::jsonb) AS old_payload,
         EXISTS (
           SELECT 1
             FROM harness_shared.work_item_claims c
            WHERE c.workspace_id = wi.workspace_id
              AND c.harness_slug = wi.harness_slug
              AND c.work_item_id = wi.feature_id
              AND c.expires_ts > now()
         ) AS active_claim,
         m.destination AS migration_864_destination,
         m.owner_capability AS migration_864_owner_capability,
         m.submitted_by AS migration_864_submitted_by,
         m.ledger_idea_id AS migration_864_ledger_idea_id
    FROM harness_shared.work_items wi
    LEFT JOIN harness_shared.bak_20260821_legacy_human_park_manifest m
      ON m.workspace_id = wi.workspace_id
     AND m.harness_slug = wi.harness_slug
     AND m.feature_id = wi.feature_id
   WHERE wi.workspace_id = 'papercusp-workspace'
     AND wi.harness_slug = 'papercusp'
     AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
     AND (
       COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
       OR (
         wi.status = 'needs-human'
         AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction'
               IS DISTINCT FROM 'true'
       )
     )
), classified AS (
  SELECT c.*,
         COALESCE(
           c.migration_864_destination,
           CASE
             WHEN c.old_payload -> '_legacyHumanParkRepair' ->> 'destination'
                    IN ('remote-reconciliation', 'agent-review', 'owner-action', 'operational')
             THEN c.old_payload -> '_legacyHumanParkRepair' ->> 'destination'
           END,
           CASE
             WHEN c.origin = 'remote' THEN 'remote-reconciliation'
             WHEN c.old_payload ->> 'needsOwnerAction' = 'true'
               OR c.old_payload ->> 'humanCapability' IN
                    ('credential', 'physical-device', 'external-service-action')
               OR jsonb_path_exists(
                    c.old_payload,
                    '$.externalBlockers[*] ? (@.status == "active" && (@.capability == "credential" || @.capability == "physical-device" || @.capability == "external-service-action"))'::jsonpath
                  )
             THEN 'owner-action'
             WHEN c.old_payload -> 'ideaLifecycle' ->> 'triageDecision' = 'gate'
             THEN 'agent-review'
             ELSE 'operational'
           END
         )::text AS destination
    FROM cohort c
), provenance AS (
  SELECT c.*,
         NULLIF(BTRIM(ei.created_by), '') AS issue_creator,
         p.idea_id AS primary_idea_id,
         p.routed_ref AS primary_routed_ref,
         NULLIF(BTRIM(p.created_by), '') AS primary_created_by,
         f.idea_id AS fallback_idea_id,
         f.routed_ref AS fallback_routed_ref
    FROM classified c
    LEFT JOIN harness_shared.engineer_issues ei
      ON ei.workspace_id = c.workspace_id
     AND ei.scope = 'harness:' || c.harness_slug
     AND ei.issue_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas p
      ON p.idea_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas f
      ON f.idea_id = 'agent-review:' || c.feature_id
)
SELECT p.workspace_id, p.harness_slug, p.feature_id, p.item_kind, p.title,
       p.old_status, p.origin, p.taken_by, p.active_claim, p.old_payload,
       p.destination,
       CASE WHEN p.destination = 'owner-action' THEN COALESCE(
         p.migration_864_owner_capability,
         NULLIF(p.old_payload ->> 'humanCapability', ''),
         blocker.capability
       ) END::text AS owner_capability,
       CASE WHEN p.destination = 'agent-review' THEN COALESCE(
         p.migration_864_submitted_by,
         NULLIF(p.old_payload -> 'agentReview' ->> 'submittedBy', ''),
         p.issue_creator,
         CASE WHEN p.primary_routed_ref = 'wi:' || p.feature_id
              THEN p.primary_created_by END,
         'system:legacy-agent-review'
       ) END::text AS submitted_by,
       CASE WHEN p.destination = 'agent-review' THEN COALESCE(
         p.migration_864_ledger_idea_id,
         CASE WHEN p.primary_idea_id IS NULL
                    OR p.primary_routed_ref = 'wi:' || p.feature_id
              THEN p.feature_id
              WHEN p.fallback_idea_id IS NULL
                    OR p.fallback_routed_ref = 'wi:' || p.feature_id
              THEN 'agent-review:' || p.feature_id END
       ) END::text AS ledger_idea_id
  FROM provenance p
  LEFT JOIN LATERAL (
    SELECT value ->> 'capability' AS capability
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(p.old_payload -> 'externalBlockers') = 'array'
          THEN p.old_payload -> 'externalBlockers'
        ELSE '[]'::jsonb
      END) item(value)
     WHERE value ->> 'status' = 'active'
       AND value ->> 'capability' IN
             ('credential', 'physical-device', 'external-service-action')
     LIMIT 1
  ) blocker ON true;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_legacy_human_recurrence_870
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260821_legacy_human_recurrence_870_uq
  ON harness_shared.bak_20260821_legacy_human_recurrence_870
    (workspace_id, harness_slug, feature_id);

DO $guard870$
DECLARE
  total_rows int;
  remote_rows int;
  review_rows int;
  owner_rows int;
  operational_rows int;
  backup_rows int;
  claimed_rows text;
  collisions text;
  remote_hive_install boolean;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE destination = 'remote-reconciliation')::int,
         count(*) FILTER (WHERE destination = 'agent-review')::int,
         count(*) FILTER (WHERE destination = 'owner-action')::int,
         count(*) FILTER (WHERE destination = 'operational')::int
    INTO total_rows, remote_rows, review_rows, owner_rows, operational_rows
    FROM migration_870_manifest;

  SELECT count(*)::int INTO backup_rows
    FROM harness_shared.bak_20260821_legacy_human_recurrence_870;

  -- The exact 30-row recurrence geometry belongs to the owner installation.
  -- A registry-proved remote_hive peer owns a different federated subset, so
  -- preserve every row-level safety guard while skipping only this census.
  SELECT EXISTS (
    SELECT 1
      FROM harness_shared.harness_registry r
      CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(r.payload -> 'projects') = 'array'
          THEN r.payload -> 'projects'
        ELSE '[]'::jsonb
      END) project
     WHERE r.workspace_id = 'papercusp-workspace'
       AND project ->> 'slug' = 'papercusp'
       AND COALESCE((project ->> 'remote_hive')::boolean, false)
  ) INTO remote_hive_install;

  IF NOT remote_hive_install AND EXISTS (
       SELECT 1 FROM harness_shared.bak_20260821_legacy_human_park_manifest
     ) AND NOT (total_rows = 0 AND backup_rows = 30)
     AND (total_rows, remote_rows, review_rows, owner_rows, operational_rows)
           IS DISTINCT FROM (30, 6, 8, 0, 16) THEN
    RAISE EXCEPTION
      '870: live cohort drifted; expected 30=(6 remote,8 review,0 owner,16 operational), got %=(% remote,% review,% owner,% operational)',
      total_rows, remote_rows, review_rows, owner_rows, operational_rows;
  END IF;

  SELECT string_agg(feature_id, ', ' ORDER BY feature_id)
    INTO claimed_rows
    FROM migration_870_manifest
   WHERE NULLIF(BTRIM(taken_by), '') IS NOT NULL OR active_claim;
  IF claimed_rows IS NOT NULL THEN
    RAISE EXCEPTION
      '870: refusing to rewrite claimed legacy human-park row(s): %', claimed_rows;
  END IF;

  SELECT string_agg(feature_id, ', ' ORDER BY feature_id)
    INTO collisions
    FROM migration_870_manifest
   WHERE destination = 'agent-review' AND ledger_idea_id IS NULL;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION '870: both Blender ledger ids collide for %', collisions;
  END IF;

  IF EXISTS (
    SELECT 1 FROM migration_870_manifest
     WHERE destination = 'owner-action'
       AND owner_capability NOT IN
             ('credential', 'physical-device', 'external-service-action')
  ) THEN
    RAISE EXCEPTION '870: owner-action row lacks a strict typed capability';
  END IF;
END
$guard870$;

INSERT INTO harness_shared.bak_20260821_legacy_human_recurrence_870
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN migration_870_manifest m
    ON m.workspace_id = wi.workspace_id
   AND m.harness_slug = wi.harness_slug
   AND m.feature_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

DO $backup_guard870$
DECLARE missing_rows int;
BEGIN
  SELECT count(*)::int INTO missing_rows
    FROM migration_870_manifest m
   WHERE NOT EXISTS (
     SELECT 1
       FROM harness_shared.bak_20260821_legacy_human_recurrence_870 b
      WHERE b.workspace_id = m.workspace_id
        AND b.harness_slug = m.harness_slug
        AND b.feature_id = m.feature_id
   );
  IF missing_rows <> 0 THEN
    RAISE EXCEPTION '870: backup missing % selected row(s)', missing_rows;
  END IF;
END
$backup_guard870$;

INSERT INTO harness_shared.scout_routed_ideas
  (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
   lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
   origin, created_by)
SELECT m.ledger_idea_id, m.workspace_id, m.harness_slug, 'papercusp', NULL, NULL,
       'agent-review', 'improvement', 'wi:' || m.feature_id, m.title, NULL,
       floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
       'agent-review', m.submitted_by
  FROM migration_870_manifest m
 WHERE m.destination = 'agent-review'
ON CONFLICT (idea_id) DO NOTHING;

-- This is a deterministic historical repair. Disabling USER triggers preserves
-- remote ownership and avoids restamping the six reconciliation rows as local.
-- The update never changes taken_by or the work_item_claims ledger, and the guard
-- refuses to run while any selected row is claimed.
ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;

WITH base AS (
  SELECT m.*,
         m.old_payload -> 'agentReview' AS old_agent_review,
         m.old_payload - 'needsHuman' - 'needsOwnerAction'
           - 'humanCapability' - 'agentReview' AS payload_without_destinations
    FROM migration_870_manifest m
), blocker_history AS (
  SELECT b.*,
         CASE
           WHEN jsonb_typeof(b.payload_without_destinations -> 'externalBlockers') = 'array'
           THEN jsonb_set(
             b.payload_without_destinations,
             '{externalBlockers}',
             COALESCE((
               SELECT jsonb_agg(
                 CASE
                   WHEN b.destination IN ('agent-review', 'operational')
                    AND blocker.value ->> 'status' = 'active'
                    AND blocker.value ->> 'capability' = 'product-decision'
                   THEN blocker.value || jsonb_build_object(
                     'status', 'cleared',
                     'updatedAt', to_char(
                       now() AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     ),
                     'clearedAt', to_char(
                       now() AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     ),
                     'clearedBy', 'system:migration-870',
                     'evidence', concat_ws(
                       E'\n',
                       NULLIF(blocker.value ->> 'evidence', ''),
                       'Migration 870: legacy product-decision park superseded by the typed agent destination.'
                     )
                   )
                   WHEN b.destination = 'owner-action'
                    AND blocker.value ->> 'status' = 'active'
                    AND b.owner_capability IS NOT NULL
                   THEN blocker.value || jsonb_build_object(
                     'capability', b.owner_capability,
                     'capabilitySource', 'explicit',
                     'updatedAt', to_char(
                       now() AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     )
                   )
                   ELSE blocker.value
                 END
                 ORDER BY blocker.ordinality
               )
               FROM jsonb_array_elements(
                 b.payload_without_destinations -> 'externalBlockers'
               ) WITH ORDINALITY AS blocker(value, ordinality)
             ), '[]'::jsonb),
             true
           )
           ELSE b.payload_without_destinations
         END AS payload_with_blocker_history
    FROM base b
), next_payload AS (
  SELECT b.*,
         jsonb_strip_nulls(
           b.payload_with_blocker_history
           || CASE b.destination
                WHEN 'agent-review' THEN jsonb_build_object(
                  'agentReview',
                  CASE WHEN jsonb_typeof(b.old_agent_review) = 'object'
                       THEN b.old_agent_review ELSE '{}'::jsonb END
                  || jsonb_build_object(
                    'status', 'pending',
                    'submittedBy', b.submitted_by,
                    'ledgerIdeaId', b.ledger_idea_id,
                    'round', COALESCE(
                      CASE WHEN jsonb_typeof(b.old_agent_review) = 'object'
                           THEN b.old_agent_review -> 'round' END,
                      '1'::jsonb
                    )
                  )
                )
                WHEN 'owner-action' THEN jsonb_build_object(
                  'needsOwnerAction', true,
                  'humanCapability', b.owner_capability
                )
                ELSE '{}'::jsonb
              END
           || jsonb_build_object(
                '_legacyHumanParkRetirement',
                jsonb_strip_nulls(jsonb_build_object(
                  'migration', 870,
                  'destination', b.destination,
                  'retiredAt', to_char(
                    now() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'priorStatus', b.old_status,
                  'priorRepairMigration', b.old_payload
                    -> '_legacyHumanParkRepair' -> 'migration',
                  'priorStatusRepairMigration', b.old_payload
                    -> '_legacyHumanParkStatusRepair' -> 'migration'
                ))
              )
         ) AS next_payload
    FROM blocker_history b
)
UPDATE harness_shared.work_items wi
   SET payload = n.next_payload,
       status = CASE n.destination
         WHEN 'owner-action' THEN 'needs-human'
         WHEN 'remote-reconciliation' THEN 'open'
         WHEN 'agent-review' THEN 'open'
         WHEN 'operational' THEN CASE
           WHEN jsonb_path_exists(
                  n.next_payload,
                  '$.externalBlockers[*] ? (@.status == "active")'::jsonpath
                ) THEN 'blocked'
           ELSE 'open'
         END
       END,
       origin = CASE
         WHEN n.destination = 'remote-reconciliation' THEN 'remote'
         ELSE wi.origin
       END,
       updated_ts = greatest(
         COALESCE(wi.updated_ts, 0),
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       ),
       last_progress_at = now()
  FROM next_payload n
 WHERE wi.workspace_id = n.workspace_id
   AND wi.harness_slug = n.harness_slug
   AND wi.feature_id = n.feature_id;

ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

DO $post870$
DECLARE
  bad text;
  legacy_rows int;
  ledger_rows int;
BEGIN
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id)
    INTO bad
    FROM migration_870_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE wi.payload ? 'needsHuman'
      OR wi.payload -> '_legacyHumanParkRetirement' ->> 'migration'
           IS DISTINCT FROM '870'
      OR wi.payload -> '_legacyHumanParkRetirement' ->> 'destination'
           IS DISTINCT FROM m.destination
      OR wi.taken_by IS DISTINCT FROM m.taken_by
      OR (m.destination = 'remote-reconciliation' AND (
            wi.origin IS DISTINCT FROM 'remote'
            OR wi.status IS DISTINCT FROM 'open'
            OR wi.payload ? 'agentReview'
            OR wi.payload ->> 'needsOwnerAction' = 'true'
          ))
      OR (m.destination = 'agent-review' AND (
            wi.status IS DISTINCT FROM 'open'
            OR wi.payload -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'
            OR wi.payload -> 'agentReview' ->> 'submittedBy'
                 IS DISTINCT FROM m.submitted_by
            OR wi.payload -> 'agentReview' ->> 'ledgerIdeaId'
                 IS DISTINCT FROM m.ledger_idea_id
            OR wi.payload ->> 'needsOwnerAction' = 'true'
            OR jsonb_path_exists(
                 COALESCE(wi.payload, '{}'::jsonb),
                 '$.externalBlockers[*] ? (@.status == "active" && @.capability == "product-decision")'::jsonpath
               )
          ))
      OR (m.destination = 'owner-action' AND (
            wi.status IS DISTINCT FROM 'needs-human'
            OR wi.payload ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
            OR wi.payload ->> 'humanCapability'
                 IS DISTINCT FROM m.owner_capability
            OR wi.payload ? 'agentReview'
          ))
      OR (m.destination = 'operational' AND (
            wi.status IS DISTINCT FROM CASE
              WHEN jsonb_path_exists(
                     COALESCE(wi.payload, '{}'::jsonb),
                     '$.externalBlockers[*] ? (@.status == "active")'::jsonpath
                   ) THEN 'blocked'
              ELSE 'open'
            END
            OR wi.payload ? 'agentReview'
            OR wi.payload ->> 'needsOwnerAction' = 'true'
            OR jsonb_path_exists(
                 COALESCE(wi.payload, '{}'::jsonb),
                 '$.externalBlockers[*] ? (@.status == "active" && @.capability == "product-decision")'::jsonpath
               )
          ));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '870: destination postcondition failed for %', bad;
  END IF;

  SELECT count(*)::int INTO ledger_rows
    FROM migration_870_manifest m
    JOIN harness_shared.scout_routed_ideas s
      ON s.idea_id = m.ledger_idea_id
     AND s.routed_ref = 'wi:' || m.feature_id
   WHERE m.destination = 'agent-review';
  IF ledger_rows <> (
       SELECT count(*) FROM migration_870_manifest
        WHERE destination = 'agent-review'
     ) THEN
    RAISE EXCEPTION '870: agent-review ledger coverage is %, expected %',
      ledger_rows,
      (SELECT count(*) FROM migration_870_manifest
        WHERE destination = 'agent-review');
  END IF;

  SELECT count(*)::int INTO legacy_rows
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = 'papercusp-workspace'
     AND wi.harness_slug = 'papercusp'
     AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
     AND (
       COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
       OR (
         wi.status = 'needs-human'
         AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction'
               IS DISTINCT FROM 'true'
       )
     );
  IF legacy_rows <> 0 THEN
    RAISE EXCEPTION '870: % active legacy parked row(s) remain after retirement',
      legacy_rows;
  END IF;
END
$post870$;

COMMENT ON TABLE harness_shared.bak_20260821_legacy_human_recurrence_870 IS
  'Pre-mutation evidence for migration 870, retiring post-867/868 legacy payload.needsHuman recurrence into typed destinations.';
