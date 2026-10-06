-- 1295 — WI-10004494 gap 3: make each identity activation event self-describing for metering.
--
-- The shadow-metering reader prices a span by the slotted blueprint layers of the specification
-- artifact for EXACTLY the revision the span applied, and it can only find that artifact on the
-- span's launch record (adv_sessions.launch_spec: current artifact + identityHistory). That lookup
-- is lossy by construction (measured 2026-10-01, probes in .papercusp/scratch/wi10004494/):
--   * the specification revision churns on every relaunch, because the artifact hashes volatile
--     prompt text (prompt-file inline:su#0, rendered:effective, setting launch-state-v1), while the
--     blueprint-layer inputs that drive pricing stay byte-identical (13 artifacts on one record);
--   * before 2026-09-27 (b26a92231c) a relaunch REPLACED launch_spec and dropped every earlier
--     revision; since then history is kept but capped at IDENTITY_HISTORY_LIMIT = 12, so a busy
--     session evicts its own receipts (2,304 of 2,572 post-09-28 misses sit on hist_len = 12);
--   * none of the missing revisions is in blueprint_specifications (0 of 4,354 for September).
-- So the layer set is stamped on the event when it is recorded (session-identity-attribution.ts),
-- and the reader prefers the stamp. NULL = unknown (no artifact for that revision was reachable);
-- '[]' = artifact known and it carries no slotted layers (e.g. launch-adapter-compatibility
-- launches, WI-10004747). The two must stay distinct: only the first is an attribution gap.
--
-- Expand-only: a nullable column, a pure function and an index. The deployed release neither
-- reads nor writes the column, so applying this ahead of the code is safe.

-- 1. The ONE derivation of "slotted layer refs" from a compiled specification artifact. Same rule
--    the reader used inline (shadow-metering-reader.ts): distinct '<slot>:<ref>' over
--    blueprint-layer inputs whose document declares slots. jsonb_agg(DISTINCT …) sorts, so equal
--    layer sets always compare equal.
CREATE OR REPLACE FUNCTION harness_shared.identity_specification_layer_refs(artifact jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(artifact) = 'object' THEN (
    SELECT COALESCE(jsonb_agg(DISTINCT (slot->>'slot') || ':' || (i->>'ref')), '[]'::jsonb)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(artifact->'inputs') = 'array'
                  THEN artifact->'inputs' ELSE '[]'::jsonb END) i
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(i->'document'->'slots') = 'array'
                  THEN i->'document'->'slots' ELSE '[]'::jsonb END) slot
     WHERE i->>'kind' = 'blueprint-layer'
       AND i->>'ref' IS NOT NULL
       AND slot->>'slot' IS NOT NULL)
  END
$$;

-- 2. The stamp.
ALTER TABLE harness_shared.session_identity_activation_events
  ADD COLUMN IF NOT EXISTS specification_layer_refs jsonb;

COMMENT ON COLUMN harness_shared.session_identity_activation_events.specification_layer_refs IS
  'Slotted blueprint layer refs (<slot>:<ref>, sorted) of the specification artifact for specification_revision, '
  'stamped at record time (WI-10004494). NULL = no artifact for that revision was reachable; [] = none slotted.';

-- 3. The writer reuses a stamp already taken for the same revision before it touches the launch
--    record. The revision is a content hash, so the lookup is owner-independent.
CREATE INDEX IF NOT EXISTS session_identity_activation_spec_rev_idx
  ON harness_shared.session_identity_activation_events (workspace_id, specification_revision)
  WHERE specification_layer_refs IS NOT NULL;

-- 4. One-shot backfill of everything still recoverable: every artifact still carried by a launch
--    record (current + identityHistory), keyed by the revision it hashes to. Running this freezes
--    artifacts that further relaunches would evict. blueprint_specifications is not a source: it
--    held none of the missing revisions, and leaving it out keeps this file free of 1212.
--    Timed read-only on the live DB 2026-10-01: ~30s, 2,558 recoverable revisions (1,462 with an
--    empty slotted set), 17,010 of 30,547 events stamped; the rest stay NULL (artifact gone).
--    The runner applies each chunk with SET LOCAL statement_timeout = 0, and the breakpoint below
--    commits the DDL first, so the ALTER's ACCESS EXCLUSIVE lock is not held across the backfill
--    (which only takes row locks on rows that are not being inserted).
--> statement-breakpoint
WITH arts AS (
  SELECT a.workspace_id, a.launch_spec->>'specificationRevision' AS revision,
         a.launch_spec->'specificationArtifact' AS artifact
    FROM harness_shared.adv_sessions a
   WHERE jsonb_typeof(a.launch_spec->'specificationArtifact') = 'object'
  UNION ALL
  SELECT a.workspace_id, h->>'specificationRevision', h->'specificationArtifact'
    FROM harness_shared.adv_sessions a
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(a.launch_spec->'identityHistory') = 'array'
                THEN a.launch_spec->'identityHistory' ELSE '[]'::jsonb END) h
   WHERE jsonb_typeof(h->'specificationArtifact') = 'object'
), refs AS (
  SELECT DISTINCT ON (workspace_id, revision)
         workspace_id, revision, harness_shared.identity_specification_layer_refs(artifact) AS layer_refs
    FROM arts
   WHERE revision IS NOT NULL
     -- only an artifact that actually hashes to the revision it is filed under
     AND artifact->>'specificationRevision' = revision
)
UPDATE harness_shared.session_identity_activation_events e
   SET specification_layer_refs = r.layer_refs
  FROM refs r
 WHERE e.workspace_id = r.workspace_id
   AND e.specification_revision = r.revision
   AND e.specification_layer_refs IS NULL;
