-- 864-migrate-legacy-human-parks-to-agent-review.sql
-- abolish-human-review-agent-review-only-2026-08-02 P-006 / D-002 / D-004
--
-- Retire the historical payload.needsHuman / status='needs-human' parking lot
-- by moving every verified live row to one of four typed destinations:
--   357 remote rows       -> owning-peer reconciliation
--   371 judgment rows     -> the existing Blender-backed agent-review lifecycle
--     8 strict capability -> payload.needsOwnerAction + typed capability
--    23 operational rows  -> ordinary agent work (or a surviving live dependency)
--
-- The execution-time census is deliberately fail-closed. D-002's original
-- 750-row snapshot grew to 759 before authoring; the migration was re-classified
-- immediately before this draft and must refuse any further drift rather than
-- silently applying a stale title-based taxonomy.
--
-- This file is rerunnable: the data leg stamps migration 864 and therefore
-- selects no rows on a retry, while the claim-floor wrapper is installed only
-- once. A pristine/bootstrap database with no Papercusp rows also takes the
-- zero-row path so fresh-schema integration tests can apply the full chain.

CREATE TEMP TABLE migration_864_manifest ON COMMIT DROP AS
WITH cohort AS (
  SELECT wi.workspace_id, wi.harness_slug, wi.feature_id, wi.item_kind,
         wi.title, wi.status AS old_status, wi.origin,
         COALESCE(wi.payload, '{}'::jsonb) AS old_payload
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = 'papercusp-workspace'
     AND wi.harness_slug = 'papercusp'
     AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'  IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
     AND (
       COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
       OR wi.status = 'needs-human'
     )
     AND COALESCE(wi.payload, '{}'::jsonb)
           -> '_legacyHumanParkMigration' ->> 'migration' IS DISTINCT FROM '864'
), classified AS (
  SELECT c.*,
         CASE
           -- D-001: a remote-owned row is not locally reviewable. This wins
           -- even when the row also carries a local-looking review marker.
           WHEN c.origin = 'remote' THEN 'remote-reconciliation'
           WHEN c.feature_id IN (
             'EI-20192345878553998', 'EI-20360519880305472',
             'EI-20395113508971679', 'EI-20578449222009534',
             'WI-38516', 'WI-38664', 'WI-39114', 'WI-39622'
           ) THEN 'owner-action'
           WHEN c.old_payload -> 'ideaLifecycle' ->> 'triageDecision' = 'gate'
             OR c.old_payload ->> 'humanCapability' = 'product-decision'
             OR c.feature_id IN (
               'EI-1831', 'EI-1835', 'EI-20565859968567853', 'EI-240',
               'EI-419', 'EI-420', 'EI-515', 'WI-199', 'WI-37424',
               'WI-37911', 'WI-3796', 'WI-3915', 'WI-4271', 'WI-5457'
             ) THEN 'agent-review'
           ELSE 'operational'
         END::text AS destination,
         CASE
           WHEN c.feature_id IN (
             'EI-20192345878553998', 'EI-20360519880305472',
             'EI-20395113508971679', 'EI-20578449222009534',
             'WI-38664', 'WI-39114'
           ) THEN 'credential'
           WHEN c.feature_id = 'WI-38516' THEN 'external-service-action'
           WHEN c.feature_id = 'WI-39622' THEN 'physical-device'
         END::text AS owner_capability
    FROM cohort c
), provenance AS (
  SELECT c.*,
         NULLIF(BTRIM(ei.created_by), '') AS issue_creator,
         primary_ledger.idea_id AS primary_idea_id,
         primary_ledger.routed_ref AS primary_routed_ref,
         NULLIF(BTRIM(primary_ledger.created_by), '') AS primary_created_by,
         fallback_ledger.idea_id AS fallback_idea_id,
         fallback_ledger.routed_ref AS fallback_routed_ref
    FROM classified c
    LEFT JOIN harness_shared.engineer_issues ei
      ON ei.workspace_id = c.workspace_id
     AND ei.scope = 'harness:' || c.harness_slug
     AND ei.issue_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas primary_ledger
      ON primary_ledger.idea_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas fallback_ledger
      ON fallback_ledger.idea_id = 'agent-review:' || c.feature_id
)
SELECT p.workspace_id, p.harness_slug, p.feature_id, p.item_kind, p.title,
       p.old_status, p.origin, p.old_payload, p.destination, p.owner_capability,
       CASE WHEN p.destination = 'agent-review' THEN
         COALESCE(
           p.issue_creator,
           CASE WHEN p.primary_routed_ref = 'wi:' || p.feature_id
                THEN p.primary_created_by END,
           'system:legacy-agent-review'
         )
       END::text AS submitted_by,
       CASE WHEN p.destination = 'agent-review' THEN
         CASE
           WHEN p.primary_idea_id IS NULL
             OR p.primary_routed_ref = 'wi:' || p.feature_id
             THEN p.feature_id
           WHEN p.fallback_idea_id IS NULL
             OR p.fallback_routed_ref = 'wi:' || p.feature_id
             THEN 'agent-review:' || p.feature_id
           ELSE NULL
         END
       END::text AS ledger_idea_id
  FROM provenance p;

DO $guard864$
DECLARE
  total_rows int;
  remote_rows int;
  review_rows int;
  owner_rows int;
  operational_rows int;
  claimed_rows int;
  collision_rows text;
  remote_hive_install boolean;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE destination = 'remote-reconciliation')::int,
         count(*) FILTER (WHERE destination = 'agent-review')::int,
         count(*) FILTER (WHERE destination = 'owner-action')::int,
         count(*) FILTER (WHERE destination = 'operational')::int
    INTO total_rows, remote_rows, review_rows, owner_rows, operational_rows
    FROM migration_864_manifest;

  -- The exact 759-row census is an OWNER-INSTALL snapshot, not a portable
  -- invariant of the federated table. A joined remote_hive carries only the
  -- subset it has received plus its own local rows (the mac VM legitimately
  -- had 727 = 720 remote + 7 local). Enforce the historical census on the
  -- owner exactly as before; on a proved remote_hive peer, retain every
  -- per-row/claim/backup/postcondition guard below but do not compare its
  -- independently-evolving replica to the owner's one-time count.
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

  IF NOT remote_hive_install AND total_rows <> 0 AND
     (total_rows, remote_rows, review_rows, owner_rows, operational_rows)
       IS DISTINCT FROM (759, 357, 371, 8, 23) THEN
    RAISE EXCEPTION
      '864: live cohort drifted; expected 759=(357 remote,371 review,8 owner,23 operational), got %=(% remote,% review,% owner,% operational)',
      total_rows, remote_rows, review_rows, owner_rows, operational_rows;
  END IF;

  -- A zero-row first execution is valid only for a pristine/bootstrap DB. A
  -- populated live DB must either present the exact census above or already
  -- carry the installed v16 wrapper from a successful earlier execution.
  IF NOT remote_hive_install
     AND total_rows = 0
     AND to_regprocedure(
       'harness_shared.work_item_claim_floors_v16(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL
     AND EXISTS (
       SELECT 1 FROM harness_shared.work_items
        WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
     ) THEN
    RAISE EXCEPTION '864: populated Papercusp DB has zero classifiable legacy rows before first execution';
  END IF;

  SELECT string_agg(feature_id, ', ' ORDER BY feature_id)
    INTO collision_rows
    FROM migration_864_manifest
   WHERE destination = 'agent-review' AND ledger_idea_id IS NULL;
  IF collision_rows IS NOT NULL THEN
    RAISE EXCEPTION '864: both primary and fallback Blender ledger ids collide for %', collision_rows;
  END IF;

  SELECT count(*)::int INTO claimed_rows
    FROM migration_864_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE NULLIF(BTRIM(wi.taken_by), '') IS NOT NULL
      OR EXISTS (
           SELECT 1 FROM harness_shared.work_item_claims c
            WHERE c.workspace_id = m.workspace_id
              AND c.harness_slug = m.harness_slug
              AND c.work_item_id = m.feature_id
              AND c.expires_ts > now()
         );
  IF claimed_rows <> 0 THEN
    RAISE EXCEPTION '864: refusing to migrate % claimed legacy row(s)', claimed_rows;
  END IF;
END
$guard864$;

-- Evidence-preserving rollback substrate and an addressable execution manifest.
CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_legacy_human_parks
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260821_legacy_human_parks_uq
  ON harness_shared.bak_20260821_legacy_human_parks
    (workspace_id, harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_legacy_human_park_manifest (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  feature_id text NOT NULL,
  item_kind text NOT NULL,
  old_status text,
  destination text NOT NULL CHECK (destination IN (
    'remote-reconciliation', 'agent-review', 'owner-action', 'operational'
  )),
  owner_capability text,
  submitted_by text,
  ledger_idea_id text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, feature_id)
);

INSERT INTO harness_shared.bak_20260821_legacy_human_parks
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN migration_864_manifest m
    ON m.workspace_id = wi.workspace_id
   AND m.harness_slug = wi.harness_slug
   AND m.feature_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.bak_20260821_legacy_human_park_manifest
  (workspace_id, harness_slug, feature_id, item_kind, old_status,
   destination, owner_capability, submitted_by, ledger_idea_id)
SELECT workspace_id, harness_slug, feature_id, item_kind, old_status,
       destination, owner_capability, submitted_by, ledger_idea_id
  FROM migration_864_manifest
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

DO $backup_guard864$
DECLARE missing_rows int;
BEGIN
  SELECT count(*)::int INTO missing_rows
    FROM migration_864_manifest m
   WHERE NOT EXISTS (
           SELECT 1 FROM harness_shared.bak_20260821_legacy_human_parks b
            WHERE b.workspace_id = m.workspace_id
              AND b.harness_slug = m.harness_slug
              AND b.feature_id = m.feature_id
         )
      OR NOT EXISTS (
           SELECT 1 FROM harness_shared.bak_20260821_legacy_human_park_manifest b
            WHERE b.workspace_id = m.workspace_id
              AND b.harness_slug = m.harness_slug
              AND b.feature_id = m.feature_id
         );
  IF missing_rows <> 0 THEN
    RAISE EXCEPTION '864: backup/manifest missing % selected row(s)', missing_rows;
  END IF;
END
$backup_guard864$;

-- Insert-only enrollment exactly mirrors recordRoutedIdea(...,
-- preserveExisting:true). Same-id rows that already belong to another artifact
-- remain untouched; the manifest selected the deterministic agent-review:<id>
-- fallback in those four live cases.
INSERT INTO harness_shared.scout_routed_ideas
  (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
   lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
   origin, created_by)
SELECT m.ledger_idea_id, m.workspace_id, m.harness_slug, 'papercusp', NULL, NULL,
       'agent-review', 'improvement', 'wi:' || m.feature_id, m.title, NULL,
       floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
       'agent-review', m.submitted_by
  FROM migration_864_manifest m
 WHERE m.destination = 'agent-review'
ON CONFLICT (idea_id) DO NOTHING;

-- This is a deterministic per-database historical backfill, not a new local
-- authorship event. In particular, changing payload/status through the normal
-- work_items trigger path would make stamp_local_federated_write() restamp all
-- 357 remote-owned rows as origin='local', destroying the ownership boundary
-- this migration is specifically preserving. Quiet every USER trigger for the
-- one bulk UPDATE so remote origin + LWW clocks survive verbatim and the 759-row
-- rewrite does not create a CDC/notify storm. DISABLE/ENABLE are transactional:
-- any later guard failure rolls both the data and trigger state back together.
ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;

WITH base AS (
  SELECT m.*,
         -- Every destination leaves the ambiguous legacy flags. Strict owner
         -- capability is added back below under the new typed keys.
         m.old_payload - 'needsHuman' - 'needsOwnerAction' - 'humanCapability' AS payload_without_legacy
    FROM migration_864_manifest m
), blocker_history AS (
  SELECT b.*,
         CASE
           WHEN jsonb_typeof(b.payload_without_legacy -> 'externalBlockers') = 'array'
           THEN jsonb_set(
             b.payload_without_legacy,
             '{externalBlockers}',
             COALESCE((
               SELECT jsonb_agg(
                 CASE
                   -- A product-direction park is superseded by peer review or
                   -- ordinary agent operation. Preserve the blocker as cleared
                   -- history; never delete it.
                   WHEN b.destination IN ('agent-review', 'operational')
                    AND blocker.value ->> 'status' = 'active'
                    AND blocker.value ->> 'capability' = 'product-decision'
                   THEN blocker.value || jsonb_build_object(
                     'status', 'cleared',
                     'updatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'clearedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'clearedBy', 'system:migration-864',
                     'evidence', concat_ws(E'\n', NULLIF(blocker.value ->> 'evidence', ''),
                       'Migration 864: legacy product-decision park superseded by the classified agent destination.')
                   )
                   -- Strict owner rows keep their active blocker, but repair a
                   -- legacy product-decision label to the classified capability.
                   WHEN b.destination = 'owner-action'
                    AND blocker.value ->> 'status' = 'active'
                    AND b.owner_capability IS NOT NULL
                   THEN blocker.value || jsonb_build_object(
                     'capability', b.owner_capability,
                     'capabilitySource', 'explicit',
                     'updatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                   )
                   ELSE blocker.value
                 END
                 ORDER BY blocker.ordinality
               )
               FROM jsonb_array_elements(b.payload_without_legacy -> 'externalBlockers')
                      WITH ORDINALITY AS blocker(value, ordinality)
             ), '[]'::jsonb),
             true
           )
           ELSE b.payload_without_legacy
         END AS payload_with_blocker_history
    FROM base b
), next_payload AS (
  SELECT b.*,
         jsonb_strip_nulls(
           b.payload_with_blocker_history
           || CASE b.destination
                WHEN 'agent-review' THEN jsonb_build_object(
                  'agentReview', jsonb_build_object(
                    'status', 'pending',
                    'submittedBy', b.submitted_by,
                    'ledgerIdeaId', b.ledger_idea_id,
                    'round', 1
                  )
                )
                WHEN 'owner-action' THEN jsonb_build_object(
                  'needsOwnerAction', true,
                  'humanCapability', b.owner_capability
                )
                ELSE '{}'::jsonb
              END
           || jsonb_build_object(
                '_legacyHumanParkMigration',
                jsonb_strip_nulls(jsonb_build_object(
                  'migration', 864,
                  'destination', b.destination,
                  'migratedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'priorStatus', b.old_status,
                  'priorHumanCapability', b.old_payload -> 'humanCapability'
                ))
              )
         ) AS next_payload
    FROM blocker_history b
)
UPDATE harness_shared.work_items wi
   SET payload = n.next_payload,
       status = CASE n.destination
         WHEN 'owner-action' THEN 'needs-human'
         WHEN 'operational' THEN
           CASE WHEN jsonb_path_exists(
                       n.next_payload,
                       '$.externalBlockers[*] ? (@.status == "active")'::jsonpath
                     )
                THEN 'blocked' ELSE 'open' END
         ELSE 'open'
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

DO $data_post864$
DECLARE
  bad text;
  legacy_rows int;
  ledger_rows int;
BEGIN
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id)
    INTO bad
    FROM migration_864_manifest m
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id
     AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE wi.payload ->> 'needsHuman' IS NOT NULL
      OR wi.payload -> '_legacyHumanParkMigration' ->> 'migration' IS DISTINCT FROM '864'
      OR wi.payload -> '_legacyHumanParkMigration' ->> 'destination' IS DISTINCT FROM m.destination
      OR (m.destination = 'remote-reconciliation' AND (
            wi.origin IS DISTINCT FROM 'remote'
            OR wi.status IS DISTINCT FROM 'open'
            OR wi.payload ? 'agentReview'
            OR wi.payload ->> 'needsOwnerAction' = 'true'
          ))
      OR (m.destination = 'agent-review' AND (
            wi.status IS DISTINCT FROM 'open'
            OR wi.payload -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'
            OR wi.payload -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM m.submitted_by
            OR wi.payload -> 'agentReview' ->> 'ledgerIdeaId' IS DISTINCT FROM m.ledger_idea_id
            OR wi.payload -> 'agentReview' ->> 'round' IS DISTINCT FROM '1'
            OR wi.payload ->> 'needsOwnerAction' = 'true'
            OR jsonb_path_exists(
                 COALESCE(wi.payload, '{}'::jsonb),
                 '$.externalBlockers[*] ? (@.status == "active" && @.capability == "product-decision")'::jsonpath
               )
          ))
      OR (m.destination = 'owner-action' AND (
            wi.status IS DISTINCT FROM 'needs-human'
            OR wi.payload ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
            OR wi.payload ->> 'humanCapability' IS DISTINCT FROM m.owner_capability
            OR wi.payload ? 'agentReview'
          ))
      OR (m.destination = 'operational' AND (
            wi.status IS DISTINCT FROM CASE
              WHEN jsonb_path_exists(
                     COALESCE(wi.payload, '{}'::jsonb),
                     '$.externalBlockers[*] ? (@.status == "active")'::jsonpath
                   ) THEN 'blocked' ELSE 'open' END
            OR wi.payload ? 'agentReview'
            OR wi.payload ->> 'needsOwnerAction' = 'true'
            OR jsonb_path_exists(
                 COALESCE(wi.payload, '{}'::jsonb),
                 '$.externalBlockers[*] ? (@.status == "active" && @.capability == "product-decision")'::jsonpath
               )
          ));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '864: destination postcondition failed for %', bad;
  END IF;

  SELECT count(*)::int INTO ledger_rows
    FROM migration_864_manifest m
    JOIN harness_shared.scout_routed_ideas s
      ON s.idea_id = m.ledger_idea_id
     AND s.routed_ref = 'wi:' || m.feature_id
   WHERE m.destination = 'agent-review';
  IF ledger_rows <> (SELECT count(*) FROM migration_864_manifest WHERE destination = 'agent-review') THEN
    RAISE EXCEPTION '864: agent-review ledger coverage is %, expected %',
      ledger_rows, (SELECT count(*) FROM migration_864_manifest WHERE destination = 'agent-review');
  END IF;

  SELECT count(*)::int INTO legacy_rows
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = 'papercusp-workspace'
     AND wi.harness_slug = 'papercusp'
     AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'  IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
     AND (
       COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
       OR (
         wi.status = 'needs-human'
         AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
       )
     );
  IF legacy_rows <> 0 THEN
    RAISE EXCEPTION '864: % legacy parked row(s) remain after migration', legacy_rows;
  END IF;
END
$data_post864$;

-- Remove the obsolete floor #6 without copying the remaining sixteen floors.
-- Migration 863's public function is the v16 implementation; freeze it once,
-- then recreate the public signature as a subtractive compatibility wrapper.
DROP VIEW IF EXISTS harness_shared.work_items_claimable;

-- FORWARD-COMPAT: the deployed release calls only the stable public function signature; renaming its current implementation and recreating that signature in the same transaction leaves the old release callable throughout commit visibility.
DO $function_guard864$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_v16(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    IF to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       ) IS NULL THEN
      RAISE EXCEPTION '864: public work_item_claim_floors function is missing';
    END IF;
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_v16;
  END IF;
END
$function_guard864$;

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id            text,
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_feature_id              text
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_remove(
    harness_shared.work_item_claim_floors_v16(
      p_workspace_id,
      p_status,
      p_taken_by,
      p_origin,
      p_title,
      p_terminal_owner,
      p_terminal_completion_ref,
      p_payload,
      p_feature_id
    ),
    'needs-human'::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(
  text, text, text, text, text, text, text, jsonb, text
) IS
  'P-006 claim-floor SSOT after migration 864. The ambiguous legacy needsHuman floor is retired; pending agent review and strict payload.needsOwnerAction remain independently reserved.';

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-006 issue-family rows passing every unconditional claim floor after legacy needsHuman retirement. Active agent review and strict owner actions stay excluded; approved/re-admitted work is visible.';

DO $floor_post864$
DECLARE
  floors text[];
BEGIN
  floors := harness_shared.work_item_claim_floors(
    'papercusp-workspace', 'open', NULL, 'local', 'migration-864-probe',
    NULL, NULL, '{"needsHuman":true}'::jsonb, NULL
  );
  IF 'needs-human' = ANY(floors) THEN
    RAISE EXCEPTION '864: legacy needs-human floor survived public wrapper: %', floors;
  END IF;

  floors := harness_shared.work_item_claim_floors(
    'papercusp-workspace', 'open', NULL, 'local', 'migration-864-probe',
    NULL, NULL, '{"needsOwnerAction":true}'::jsonb, NULL
  );
  IF NOT ('needs-owner-action' = ANY(floors)) THEN
    RAISE EXCEPTION '864: strict needs-owner-action floor disappeared: %', floors;
  END IF;

  IF position(
       'needsHuman' IN pg_get_viewdef('harness_shared.work_items_claimable'::regclass, true)
     ) <> 0 THEN
    RAISE EXCEPTION '864: claimable view still contains a legacy needsHuman prefilter';
  END IF;
END
$floor_post864$;
