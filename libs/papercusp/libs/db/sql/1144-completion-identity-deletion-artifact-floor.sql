-- 1144-completion-identity-deletion-artifact-floor.sql
--
-- EI-22381221975733348: forward-repair the completion authority floor after
-- already-applied migrations 972 and 1044 were edited in place. Production
-- still ran 1044's historical artifact-aware predicate and 972's historical
-- filesChanged-only trigger, so an intentional deletion with null blob SHAs
-- was rejected even though current source and TypeScript accepted it. The
-- settlement reconciler then refreshed treeStamp successfully, attempted the
-- proposed -> committed upgrade, and the stale trigger downgraded it again.
--
-- This migration deliberately replaces BOTH live functions. The predicate
-- combines the two valid non-blob cases without weakening repo-backed proof:
-- out-of-repo artifacts are ignored, intentional deletions must be absent on
-- both sides, at least one repo-backed entry is required, and every remaining
-- repo-backed entry must carry equal non-null blob identities. The trigger now
-- scopes the floor over filesChanged + filesDeleted, so deletion-only closes
-- cannot bypass proof.
--
-- Non-destructive: CREATE OR REPLACE only. The existing trigger calls the
-- replaced function by name and therefore picks up this definition atomically.

CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_identity IS NOT NULL
     AND jsonb_typeof(p_identity) = 'array'
     AND jsonb_array_length(p_identity) > 0
     -- Artifacts alone never prove a code close: require one repo-backed row.
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_identity) AS e
            WHERE COALESCE((e->>'outOfRepoArtifact')::boolean, false) = false
         )
     -- Ignore artifacts; every repo-backed row must either match exactly or
     -- prove an intentional deletion by being absent on both sides.
     AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_identity) AS e
            WHERE e->'outOfRepoArtifact' IS DISTINCT FROM 'true'::jsonb
              AND (
                (
                  e->'deletion' = 'true'::jsonb
                  AND (
                        e->>'workingTreeBlobSha' IS NOT NULL
                     OR e->>'headBlobSha' IS NOT NULL
                  )
                )
                OR
                (
                  e->'deletion' IS DISTINCT FROM 'true'::jsonb
                  AND (
                        e->>'workingTreeBlobSha' IS NULL
                     OR e->>'headBlobSha' IS NULL
                     OR e->>'workingTreeBlobSha' <> e->>'headBlobSha'
                  )
                )
              )
         )
$fn$;

COMMENT ON FUNCTION harness_shared.completion_content_identity_proven(jsonb) IS
  'SQL mirror of completionTreeContentIdentityMatches(): repo-backed equality, intentional deletion absence, outOfRepoArtifact exclusion, and at least one repo-backed row (forward-repaired by migration 1144 / EI-22381221975733348).';

CREATE OR REPLACE FUNCTION harness_shared.downgrade_unproven_committed_close()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_evidence       jsonb;
  v_declared_count integer;
BEGIN
  IF NEW.authority IS DISTINCT FROM 'committed' THEN
    RETURN NEW;
  END IF;

  -- Never retroactively rewrite an unrelated update of a committed row.
  IF TG_OP = 'UPDATE'
     AND OLD.authority = 'committed'
     AND OLD.payload IS NOT DISTINCT FROM NEW.payload THEN
    RETURN NEW;
  END IF;

  v_evidence := NEW.payload->'_completionEvidence';
  IF v_evidence IS NULL THEN
    RETURN NEW;
  END IF;

  v_declared_count :=
    CASE WHEN jsonb_typeof(v_evidence->'filesChanged') = 'array'
      THEN jsonb_array_length(v_evidence->'filesChanged') ELSE 0 END
    +
    CASE WHEN jsonb_typeof(v_evidence->'filesDeleted') = 'array'
      THEN jsonb_array_length(v_evidence->'filesDeleted') ELSE 0 END;
  IF v_declared_count = 0 THEN
    RETURN NEW;
  END IF;

  IF harness_shared.completion_content_identity_proven(
       v_evidence->'treeStamp'->'contentIdentity') THEN
    RETURN NEW;
  END IF;

  NEW.authority := 'proposed';
  RAISE WARNING 'work_items %: completion authority downgraded committed->proposed (content identity unproven over % declared path(s))',
    COALESCE(NEW.feature_id, '?'), v_declared_count;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.downgrade_unproven_committed_close() IS
  'Below-deploy completion authority floor over filesChanged + filesDeleted, using the combined repo/deletion/artifact predicate (forward-repaired by migration 1144 / EI-22381221975733348).';
