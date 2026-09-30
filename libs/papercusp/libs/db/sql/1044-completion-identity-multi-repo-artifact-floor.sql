-- EI-21937921955988010 — the content-identity floor must understand a completion that
-- spans SEVERAL repositories and cites artifacts belonging to NONE.
--
-- Migration 972 introduced harness_shared.completion_content_identity_proven() as the
-- SQL mirror of completionTreeContentIdentityMatches()
-- (packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts). That
-- mirror enforces the floor BELOW the deploy boundary, so a frozen release gate serving
-- an older build cannot mint stronger authority than the source permits. The two must
-- stay in sync; this migration carries the source change of the same name.
--
-- WHAT CHANGED, AND WHY
-- A close may legitimately declare paths in more than one checkout (the suite apps —
-- portal/email/calendar/phone — each live in their own git repo, while infra lands in
-- the papercusp repo), and `verifiedHow: 'live-drove-ui'` REQUIRES citing screenshot
-- artifacts under ~/.papercusp/evidence/<id>/ that live in no repository at all. Blob
-- identity is not merely "unavailable" for such an artifact — it is UNDEFINED for it.
-- Counting those citations as unproven made every UI-verified suite-app completion
-- permanently ineligible for 'committed' no matter how clean its code side was
-- (measured on WI-1409555: 30 declared paths, identity_rows=0, authority='proposed').
--
-- Entries carrying `outOfRepoArtifact: true` are therefore EXCLUDED from the floor
-- rather than failed by it.
--
-- THE FLOOR IS NOT LOOSENED IN THE DIRECTION THAT MATTERS. Two properties are
-- preserved deliberately, and the integration test asserts both:
--   1. at least one REPO-BACKED entry must exist — a close citing only artifacts has no
--      provable code evidence and must never mint 'committed'; and
--   2. every repo-backed entry must still match exactly, or be an intentional
--      deletion with both blob identities absent, so an artifact citation can
--      never excuse a genuine content mismatch elsewhere in the same close.
--
-- Non-destructive: CREATE OR REPLACE of one IMMUTABLE sql function. The trigger
-- harness_shared.downgrade_unproven_committed_close() calls it by name and is unchanged,
-- so no FORWARD-COMPAT acknowledgment is required — the currently-deployed release keeps
-- working against this definition, which only ADMITS cases the previous one rejected.

CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_identity IS NOT NULL
     AND jsonb_typeof(p_identity) = 'array'
     AND jsonb_array_length(p_identity) > 0
     -- (1) at least one repo-backed entry: artifacts alone never prove a code close.
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_identity) AS e
            WHERE COALESCE((e->>'outOfRepoArtifact')::boolean, false) = false
         )
     -- (2) every repo-backed entry matches exactly, or is a deletion whose
     --     absence is proven on both sides; artifact entries are not judged.
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
  'SQL mirror of completionTreeContentIdentityMatches() — keep in sync with packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts (EI-21502635666260946; multi-repo + deletion + outOfRepoArtifact exclusion added by EI-21937921955988010).';
