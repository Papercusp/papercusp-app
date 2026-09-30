-- 972-completion-authority-content-identity-floor.sql
--
-- EI-21502635666260946: enforce, BELOW the deploy boundary, the rule that a
-- `committed` completion authority must carry provable Git content identity.
--
-- WHY HERE: packages/operator-core/lib/agent-tools/work_items/complete.ts
-- (guard `committedContentIdentityMissing`, ~line 2263) downgrades a
-- `committed` close to `proposed` unless every entry of the persisted
-- treeStamp.contentIdentity proves workingTreeBlobSha === headBlobSha !== null.
-- But that guard only protects closes made by a build that CONTAINS it. While
-- the release gate is frozen/red, live :3070 keeps dispatching
-- work_items:complete from an older build and can mint `committed` closes the
-- current source would have downgraded (observed concretely on WI-41491,
-- closed 2026-08-26T01:43:40Z by build 6760f8ec31, which predates the guard
-- commit ab2adad4f4 by ~2.6h). The database sees every close regardless of
-- which build produced it, so the invariant belongs here too.
--
-- SEMANTICS: this trigger mirrors completionTreeContentIdentityMatches()
-- EXACTLY over the PERSISTED shape (payload->_completionEvidence) — presence,
-- array > 0, and every entry proving workingTreeBlobSha == headBlobSha (JSON
-- null or missing key counts as unproven). It deliberately does NOT recompute
-- Git truth (the DB cannot hash blobs cheaply); it enforces the same
-- persisted-evidence floor the TS guard enforces. Like the TS guard it
-- DOWNGRADES rather than rejects: the close still lands durably, it just stops
-- counting as verified-committed.
--
-- SCOPE GUARDS:
-- - Only rows whose NEW.authority = 'committed' are policed (fast path).
-- - Never retroactive: an UPDATE touching an ALREADY-committed row whose
--   payload did not change is left alone (pre-fix historical closes such as
--   WI-41491, which received an independent audit, keep their stored
--   authority; the read-side freshness detector already flags their staleness).
-- - Only the done-route evidence surface (payload->_completionEvidence);
--   dropped-route closes write terminal_completion_ref and carry no
--   completion authority claim of this kind.
-- - filesChanged + filesDeleted must be non-empty, mirroring the TS condition
--   exactly: with no declared paths there is nothing to prove.
--
-- FEDERATION NOTE: a remotely-projected close is held to the same floor as a
-- local one — every peer enforcing the identical invariant converges instead
-- of diverging; LWW (fed_ts/fed_hlc) settles any residual disagreement.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER. No destructive
-- DDL; the currently-deployed release neither reads nor writes these objects.

\set ON_ERROR_STOP on
BEGIN;

-- Exact SQL mirror of completionTreeContentIdentityMatches()
-- (packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts):
--   Boolean(identity?.length && identity.every(e =>
--     e.deletion === true
--       ? e.workingTreeBlobSha == null && e.headBlobSha == null
--       : e.workingTreeBlobSha != null && e.headBlobSha != null &&
--         e.workingTreeBlobSha === e.headBlobSha))
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
            WHERE (
                    e->'deletion' = 'true'::jsonb
                AND (
                      e->>'workingTreeBlobSha' IS NOT NULL
                   OR e->>'headBlobSha' IS NOT NULL
                )
              )
               OR (
                    e->'deletion' IS DISTINCT FROM 'true'::jsonb
                AND (
                      e->>'workingTreeBlobSha' IS NULL
                   OR e->>'headBlobSha' IS NULL
                   OR e->>'workingTreeBlobSha' <> e->>'headBlobSha'
                )
              )
         )
$fn$;

COMMENT ON FUNCTION harness_shared.completion_content_identity_proven(jsonb) IS
  'SQL mirror of completionTreeContentIdentityMatches() — keep in sync with packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts (EI-21502635666260946).';

CREATE OR REPLACE FUNCTION harness_shared.downgrade_unproven_committed_close()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_evidence      jsonb;
  v_declared_count integer;
BEGIN
  -- Fast path: only police closes claiming the strongest authority.
  IF NEW.authority IS DISTINCT FROM 'committed' THEN
    RETURN NEW;
  END IF;

  -- Never retroactive: an unrelated update of an already-committed row (a
  -- checkpoint write, a rank touch, a state no-op) must not rewrite history.
  IF TG_OP = 'UPDATE'
     AND OLD.authority = 'committed'
     AND OLD.payload IS NOT DISTINCT FROM NEW.payload THEN
    RETURN NEW;
  END IF;

  -- Done-route closes persist their evidence under payload->_completionEvidence.
  v_evidence := NEW.payload->'_completionEvidence';
  IF v_evidence IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mirror `Boolean(filesChanged?.length || filesDeleted?.length)`.
  -- Deletions are caller-owned evidence and therefore count as declared paths
  -- even though their identity entries intentionally carry null blob SHAs.
  v_declared_count :=
    CASE WHEN jsonb_typeof(v_evidence->'filesChanged') = 'array'
      THEN jsonb_array_length(v_evidence->'filesChanged') ELSE 0 END
    +
    CASE WHEN jsonb_typeof(v_evidence->'filesDeleted') = 'array'
      THEN jsonb_array_length(v_evidence->'filesDeleted') ELSE 0 END;
  IF v_declared_count = 0 THEN
    RETURN NEW;
  END IF;

  -- Proven content identity keeps `committed`; anything else downgrades,
  -- exactly like the TS guard.
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
  'EI-21502635666260946: below-deploy-boundary floor for completion authority — a committed close whose persisted _completionEvidence lacks provable treeStamp.contentIdentity over its declared filesChanged is downgraded to proposed, mirroring the complete.ts committedContentIdentityMissing guard while the release gate freezes older builds live.';

DROP TRIGGER IF EXISTS completion_authority_floor_trg ON harness_shared.work_items;
CREATE TRIGGER completion_authority_floor_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.downgrade_unproven_committed_close();

COMMIT;
