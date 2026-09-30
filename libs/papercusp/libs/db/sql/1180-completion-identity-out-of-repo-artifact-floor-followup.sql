-- 1180-completion-identity-out-of-repo-artifact-floor-followup.sql
--
-- EI-23577999135289807: migration 1144 correctly excluded explicit
-- outOfRepoArtifact entries from the content-identity floor but retained an
-- at-least-one-repo-backed-row guard. That guard makes a legitimate completion
-- whose entire deliverable is an explicitly classified external artifact
-- impossible to close as `committed`, even though there is no repository commit
-- for settlement to inspect.
--
-- Keep the conservative mixed-case rule: every repo-backed entry must still
-- prove equal blob identities (or an intentional deletion absent on both sides).
-- Explicit artifacts are ignored by that per-entry check, and an all-artifact
-- identity is valid because the server has already classified every entry.
-- The trigger and its filesChanged + filesDeleted scope remain unchanged from
-- migration 1144.

CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_identity IS NOT NULL
     AND jsonb_typeof(p_identity) = 'array'
     AND jsonb_array_length(p_identity) > 0
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
  'SQL mirror of completionTreeContentIdentityMatches(): every repo-backed entry must prove equality or intentional deletion; explicit outOfRepoArtifact entries are excluded, including artifact-only identities (forward-repaired by migration 1180 / EI-23577999135289807).';
