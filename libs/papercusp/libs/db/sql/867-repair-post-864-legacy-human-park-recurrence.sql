-- 867-repair-post-864-legacy-human-park-recurrence.sql
-- abolish-human-review-agent-review-only-2026-08-02 P-006
--
-- Two TypeScript writers survived migration 864 and recreated payload.needsHuman.
-- Preserve 864's durable classification; classify only new rows. Claimed ordinary
-- work keeps its state and claim, so this repair cannot destroy peer work.

CREATE TEMP TABLE migration_867_manifest ON COMMIT DROP AS
WITH cohort AS (
  SELECT wi.workspace_id, wi.harness_slug, wi.feature_id, wi.item_kind,
         wi.title, wi.status AS old_status, wi.origin, wi.taken_by,
         COALESCE(wi.payload, '{}'::jsonb) AS old_payload,
         m.destination AS prior_destination,
         m.owner_capability AS prior_owner_capability,
         m.submitted_by AS prior_submitted_by,
         m.ledger_idea_id AS prior_ledger_idea_id
    FROM harness_shared.work_items wi
    LEFT JOIN harness_shared.bak_20260821_legacy_human_park_manifest m
      ON m.workspace_id = wi.workspace_id AND m.harness_slug = wi.harness_slug
     AND m.feature_id = wi.feature_id
   WHERE wi.workspace_id = 'papercusp-workspace' AND wi.harness_slug = 'papercusp'
     AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
), classified AS (
  SELECT c.*,
         COALESCE(c.prior_destination, CASE
           WHEN c.origin = 'remote' THEN 'remote-reconciliation'
           WHEN c.old_payload ->> 'needsOwnerAction' = 'true'
             OR c.old_payload ->> 'humanCapability' IN
                  ('credential', 'physical-device', 'external-service-action')
             OR jsonb_path_exists(c.old_payload,
                  '$.externalBlockers[*] ? (@.status == "active" && (@.capability == "credential" || @.capability == "physical-device" || @.capability == "external-service-action"))'::jsonpath)
             THEN 'owner-action'
           WHEN c.old_payload -> 'ideaLifecycle' ->> 'triageDecision' = 'gate'
            AND NULLIF(BTRIM(c.taken_by), '') IS NULL THEN 'agent-review'
           ELSE 'operational'
         END)::text AS destination
    FROM cohort c
), provenance AS (
  SELECT c.*, NULLIF(BTRIM(ei.created_by), '') AS issue_creator,
         p.idea_id AS primary_idea_id, p.routed_ref AS primary_routed_ref,
         NULLIF(BTRIM(p.created_by), '') AS primary_created_by,
         f.idea_id AS fallback_idea_id, f.routed_ref AS fallback_routed_ref
    FROM classified c
    LEFT JOIN harness_shared.engineer_issues ei
      ON ei.workspace_id = c.workspace_id AND ei.scope = 'harness:' || c.harness_slug
     AND ei.issue_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas p ON p.idea_id = c.feature_id
    LEFT JOIN harness_shared.scout_routed_ideas f ON f.idea_id = 'agent-review:' || c.feature_id
)
SELECT p.workspace_id, p.harness_slug, p.feature_id, p.item_kind, p.title,
       p.old_status, p.origin, p.taken_by, p.old_payload, p.destination,
       CASE WHEN p.destination = 'owner-action' THEN COALESCE(
         p.prior_owner_capability, NULLIF(p.old_payload ->> 'humanCapability', ''), blocker.capability
       ) END::text AS owner_capability,
       CASE WHEN p.destination = 'agent-review' THEN COALESCE(
         p.prior_submitted_by, p.issue_creator,
         CASE WHEN p.primary_routed_ref = 'wi:' || p.feature_id THEN p.primary_created_by END,
         'system:legacy-agent-review'
       ) END::text AS submitted_by,
       CASE WHEN p.destination = 'agent-review' THEN COALESCE(
         p.prior_ledger_idea_id,
         CASE WHEN p.primary_idea_id IS NULL OR p.primary_routed_ref = 'wi:' || p.feature_id
                THEN p.feature_id
              WHEN p.fallback_idea_id IS NULL OR p.fallback_routed_ref = 'wi:' || p.feature_id
                THEN 'agent-review:' || p.feature_id END
       ) END::text AS ledger_idea_id
  FROM provenance p
  LEFT JOIN LATERAL (
    SELECT value ->> 'capability' AS capability
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(p.old_payload -> 'externalBlockers') = 'array'
          THEN p.old_payload -> 'externalBlockers' ELSE '[]'::jsonb END) item(value)
     WHERE value ->> 'status' = 'active'
       AND value ->> 'capability' IN ('credential', 'physical-device', 'external-service-action')
     LIMIT 1
  ) blocker ON true;

DO $guard867$
DECLARE total_rows int; remote_rows int; review_rows int; owner_rows int;
        operational_rows int; claimed_nonoperational int; collisions text;
        remote_hive_install boolean;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE destination = 'remote-reconciliation')::int,
         count(*) FILTER (WHERE destination = 'agent-review')::int,
         count(*) FILTER (WHERE destination = 'owner-action')::int,
         count(*) FILTER (WHERE destination = 'operational')::int
    INTO total_rows, remote_rows, review_rows, owner_rows, operational_rows
    FROM migration_867_manifest;

  -- The 84-row recurrence census was measured on the owner installation.
  -- Joined remote_hive peers have a different federated subset; they still run
  -- the classification, claim, collision, typed-capability and postcondition
  -- guards, but must not be compared to the owner's one-time count.
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

  IF NOT remote_hive_install
     AND EXISTS (SELECT 1 FROM harness_shared.bak_20260821_legacy_human_park_manifest)
     AND (total_rows, remote_rows, review_rows, owner_rows, operational_rows)
           IS DISTINCT FROM (84, 31, 37, 0, 16) THEN
    RAISE EXCEPTION
      '867: recurrence census drifted; expected 84=(31 remote,37 review,0 owner,16 operational), got %=(% remote,% review,% owner,% operational)',
      total_rows, remote_rows, review_rows, owner_rows, operational_rows;
  END IF;
  SELECT count(*)::int INTO claimed_nonoperational FROM migration_867_manifest
   WHERE NULLIF(BTRIM(taken_by), '') IS NOT NULL AND destination <> 'operational';
  IF claimed_nonoperational <> 0 THEN
    RAISE EXCEPTION '867: refusing to reroute % claimed non-operational row(s)', claimed_nonoperational;
  END IF;
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO collisions
    FROM migration_867_manifest WHERE destination = 'agent-review' AND ledger_idea_id IS NULL;
  IF collisions IS NOT NULL THEN RAISE EXCEPTION '867: both Blender ledger ids collide for %', collisions; END IF;
  IF EXISTS (SELECT 1 FROM migration_867_manifest WHERE destination = 'owner-action'
     AND owner_capability NOT IN ('credential', 'physical-device', 'external-service-action')) THEN
    RAISE EXCEPTION '867: owner-action row lacks a strict typed capability';
  END IF;
END $guard867$;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260821_legacy_human_recurrence_867
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20260821_legacy_human_recurrence_867_uq
  ON harness_shared.bak_20260821_legacy_human_recurrence_867
    (workspace_id, harness_slug, feature_id);
INSERT INTO harness_shared.bak_20260821_legacy_human_recurrence_867
SELECT wi.* FROM harness_shared.work_items wi JOIN migration_867_manifest m
  ON m.workspace_id = wi.workspace_id AND m.harness_slug = wi.harness_slug
 AND m.feature_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.scout_routed_ideas
  (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
   lens, rail, routed_ref, title, addresses_pattern_refs, routed_at, origin, created_by)
SELECT m.ledger_idea_id, m.workspace_id, m.harness_slug, 'papercusp', NULL, NULL,
       'agent-review', 'improvement', 'wi:' || m.feature_id, m.title, NULL,
       floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
       'agent-review', m.submitted_by
  FROM migration_867_manifest m WHERE m.destination = 'agent-review'
ON CONFLICT (idea_id) DO NOTHING;

ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;
WITH next_payload AS (
  SELECT m.*, jsonb_strip_nulls(
    (m.old_payload - 'needsHuman')
    || CASE m.destination
      WHEN 'agent-review' THEN jsonb_build_object('agentReview', COALESCE(
        m.old_payload -> 'agentReview', jsonb_build_object(
          'status', 'pending', 'submittedBy', m.submitted_by,
          'ledgerIdeaId', m.ledger_idea_id, 'round', 1)))
      WHEN 'owner-action' THEN jsonb_build_object(
        'needsOwnerAction', true, 'humanCapability', m.owner_capability)
      ELSE '{}'::jsonb END
    || jsonb_build_object('_legacyHumanParkRepair', jsonb_build_object(
      'migration', 867, 'destination', m.destination,
      'repairedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'priorStatus', m.old_status))) AS next_payload
    FROM migration_867_manifest m
)
UPDATE harness_shared.work_items wi SET
  payload = n.next_payload,
  status = CASE n.destination
    WHEN 'owner-action' THEN 'needs-human'
    WHEN 'remote-reconciliation' THEN 'open'
    WHEN 'agent-review' THEN 'open'
    WHEN 'operational' THEN CASE
      WHEN NULLIF(BTRIM(n.taken_by), '') IS NOT NULL THEN n.old_status
      WHEN jsonb_path_exists(n.next_payload,
             '$.externalBlockers[*] ? (@.status == "active")'::jsonpath) THEN 'blocked'
      ELSE 'open' END END,
  origin = CASE WHEN n.destination = 'remote-reconciliation' THEN 'remote' ELSE wi.origin END,
  updated_ts = greatest(COALESCE(wi.updated_ts, 0),
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
  last_progress_at = now()
FROM next_payload n
WHERE wi.workspace_id = n.workspace_id AND wi.harness_slug = n.harness_slug
  AND wi.feature_id = n.feature_id;
ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

DO $post867$
DECLARE bad text;
BEGIN
  SELECT string_agg(m.feature_id, ', ' ORDER BY m.feature_id) INTO bad
    FROM migration_867_manifest m JOIN harness_shared.work_items wi
      ON wi.workspace_id = m.workspace_id AND wi.harness_slug = m.harness_slug
     AND wi.feature_id = m.feature_id
   WHERE wi.payload ? 'needsHuman'
      OR wi.payload -> '_legacyHumanParkRepair' ->> 'migration' IS DISTINCT FROM '867'
      OR wi.payload -> '_legacyHumanParkRepair' ->> 'destination' IS DISTINCT FROM m.destination
      OR (m.destination = 'remote-reconciliation'
          AND (wi.origin IS DISTINCT FROM 'remote' OR wi.status IS DISTINCT FROM 'open'))
      OR (m.destination = 'agent-review' AND (wi.status IS DISTINCT FROM 'open'
          OR wi.payload -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'))
      OR (m.destination = 'owner-action' AND (wi.status IS DISTINCT FROM 'needs-human'
          OR wi.payload ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
          OR wi.payload ->> 'humanCapability' IS DISTINCT FROM m.owner_capability))
      OR (m.destination = 'operational' AND NULLIF(BTRIM(m.taken_by), '') IS NOT NULL
          AND (wi.status IS DISTINCT FROM m.old_status OR wi.taken_by IS DISTINCT FROM m.taken_by));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '867: repair postcondition failed for %', bad; END IF;
  IF EXISTS (SELECT 1 FROM harness_shared.work_items wi
     WHERE wi.workspace_id = 'papercusp-workspace' AND wi.harness_slug = 'papercusp'
       AND wi.status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
       AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
       AND COALESCE(wi.payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
       AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true') THEN
    RAISE EXCEPTION '867: non-terminal legacy needsHuman rows remain after repair';
  END IF;
END $post867$;

COMMENT ON TABLE harness_shared.bak_20260821_legacy_human_recurrence_867 IS
  'Pre-mutation evidence for migration 867, repairing post-864 payload.needsHuman recurrence.';
