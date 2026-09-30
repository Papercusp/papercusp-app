-- 1207-completion-identity-history-attestation-floor.sql
--
-- WI-10002350 / P-009: history-only exact-path ancestry is separate evidence
-- from emitted-tree identity. The reconciler records a server-authored,
-- manifest-bound historyAttestation when a close-time blob was overtaken before
-- git-sync emitted it. Keep treeStamp truthful and let the SQL floor accept
-- either exact emitted-tree identity or a complete matching attestation.
--
-- A nonempty manifest residual is never a settled close, even if another path
-- has an exact-tree or history proof. Keep the existing intentional-deletion
-- and out-of-repo-artifact semantics from migration 1180.

CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  v_evidence             jsonb;
  v_identity             jsonb;
  v_manifest             jsonb;
  v_attestation          jsonb;
  v_entry                jsonb;
  v_history_valid        boolean := false;
  v_attestation_count    integer;
  v_unique_path_count   integer;
BEGIN
  IF p_identity IS NULL THEN
    RETURN false;
  END IF;

  -- Keep accepting the original array argument for callers that only need the
  -- exact-tree predicate. The trigger passes the whole evidence object so the
  -- history proof can be bound to its manifest.
  IF jsonb_typeof(p_identity) = 'array' THEN
    v_identity := p_identity;
  ELSIF jsonb_typeof(p_identity) = 'object' THEN
    v_evidence := p_identity;
    v_identity := v_evidence->'treeStamp'->'contentIdentity';
    v_manifest := v_evidence->'settlementManifest';
    v_attestation := v_evidence->'historyAttestation';
  ELSE
    RETURN false;
  END IF;

  IF v_identity IS NULL
     OR jsonb_typeof(v_identity) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_identity) = 0 THEN
    RETURN false;
  END IF;

  -- A residual is an explicit statement that at least one declared path is
  -- still unresolved. Do not let any other proof erase that state.
  IF v_manifest IS NOT NULL AND v_manifest <> 'null'::jsonb THEN
    IF jsonb_typeof(v_manifest) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF v_manifest ? 'residualPaths' THEN
      IF jsonb_typeof(v_manifest->'residualPaths') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_manifest->'residualPaths') <> 0 THEN
        RETURN false;
      END IF;
    END IF;
  END IF;

  -- Validate the complete attestation envelope before using any of its paths.
  -- The ancestry lookup itself runs in the trusted reconciler; this floor
  -- proves that its result is bound to the exact manifest and emitted commit.
  IF v_attestation IS NOT NULL AND v_attestation <> 'null'::jsonb THEN
    IF jsonb_typeof(v_attestation) = 'object'
       AND jsonb_typeof(v_manifest) = 'object'
       AND jsonb_typeof(v_manifest->'normalizedPaths') = 'array'
       AND jsonb_typeof(v_manifest->'contentIdentity') = 'array'
       AND jsonb_typeof(v_manifest->'residualPaths') = 'array'
       AND jsonb_typeof(v_attestation->'paths') = 'array' THEN
      IF jsonb_array_length(v_manifest->'residualPaths') = 0
         AND jsonb_array_length(v_attestation->'paths') > 0
         AND v_manifest->'version' = '1'::jsonb
         AND v_attestation->'version' = '1'::jsonb
         AND (v_manifest->>'generation') ~ '^[1-9][0-9]*$'
         AND v_attestation->>'generation' = v_manifest->>'generation'
         AND (v_manifest->>'evidenceHash') ~ '^[0-9a-f]{64}$'
         AND v_attestation->>'evidenceHash' = v_manifest->>'evidenceHash'
         AND NULLIF(btrim(v_manifest->>'repositoryRoot'), '') IS NOT NULL
         AND v_attestation->>'repositoryRoot' = v_manifest->>'repositoryRoot'
         AND (v_manifest->>'headSha') ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
         AND v_attestation->>'closeHeadSha' = v_manifest->>'headSha'
         AND (v_attestation->>'emittedCommitSha') ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' THEN
        v_history_valid := true;

        SELECT count(*), count(DISTINCT path_item.value->>'path')
          INTO v_attestation_count, v_unique_path_count
          FROM jsonb_array_elements(v_attestation->'paths') AS path_item(value);
        IF v_attestation_count <> v_unique_path_count THEN
          v_history_valid := false;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM jsonb_array_elements(v_attestation->'paths') AS path_item(value)
           WHERE jsonb_typeof(path_item.value) IS DISTINCT FROM 'object'
              OR NULLIF(btrim(path_item.value->>'path'), '') IS NULL
              OR COALESCE(path_item.value->>'workingTreeBlobSha' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false
              OR path_item.value->>'fromHeadSha' IS DISTINCT FROM v_manifest->>'headSha'
              OR path_item.value->>'toCommitSha' IS DISTINCT FROM v_attestation->>'emittedCommitSha'
              OR path_item.value->>'proof' IS DISTINCT FROM 'exact-path-blob-history'
              OR (
                SELECT count(*)
                  FROM jsonb_array_elements(v_manifest->'contentIdentity') AS manifest_item(value)
                 WHERE manifest_item.value->>'path' = path_item.value->>'path'
              ) <> 1
              OR (
                SELECT count(*)
                  FROM jsonb_array_elements(v_manifest->'normalizedPaths') AS normalized_path(value)
                 WHERE normalized_path.value = to_jsonb(path_item.value->>'path')
              ) <> 1
              OR NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(v_manifest->'contentIdentity') AS manifest_item(value)
                 WHERE manifest_item.value->>'path' = path_item.value->>'path'
                   AND manifest_item.value->>'workingTreeBlobSha' = path_item.value->>'workingTreeBlobSha'
                   AND manifest_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb
              )
              OR (
                SELECT count(*)
                  FROM jsonb_array_elements(v_identity) AS current_item(value)
                 WHERE current_item.value->>'path' = path_item.value->>'path'
                   AND current_item.value->>'workingTreeBlobSha' = path_item.value->>'workingTreeBlobSha'
                   AND current_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb
                   AND current_item.value->'outOfRepoArtifact' IS DISTINCT FROM 'true'::jsonb
                   AND (
                     current_item.value->>'repositoryRoot' IS NULL
                     OR current_item.value->>'repositoryRoot' = v_manifest->>'repositoryRoot'
                   )
              ) <> 1
        ) THEN
          v_history_valid := false;
        END IF;
      END IF;
    END IF;

    -- A present but malformed attestation is not an alternate path around the
    -- exact-tree floor.
    IF NOT v_history_valid THEN
      RETURN false;
    END IF;
  END IF;

  FOR v_entry IN
    SELECT identity_item.value
      FROM jsonb_array_elements(v_identity) AS identity_item(value)
  LOOP
    -- Preserve migration 1180's explicit external-artifact exclusion,
    -- including artifact-only completions.
    IF COALESCE((v_entry->>'outOfRepoArtifact')::boolean, false) THEN
      CONTINUE;
    END IF;

    IF v_entry->'deletion' = 'true'::jsonb THEN
      IF v_entry->>'workingTreeBlobSha' IS NOT NULL
         OR v_entry->>'headBlobSha' IS NOT NULL THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;

    -- Exact emitted-tree identity remains the primary proof.
    IF v_entry->>'workingTreeBlobSha' IS NOT NULL
       AND v_entry->>'headBlobSha' IS NOT NULL
       AND v_entry->>'workingTreeBlobSha' = v_entry->>'headBlobSha' THEN
      CONTINUE;
    END IF;

    -- A history proof must match this exact normalized path and blob, and the
    -- identity may not identify a different repository from the attestation.
    IF NOT v_history_valid
       OR v_manifest IS NULL
       OR v_attestation IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_attestation->'paths') AS attested_path(value)
          WHERE attested_path.value->>'path' = v_entry->>'path'
            AND attested_path.value->>'workingTreeBlobSha' = v_entry->>'workingTreeBlobSha'
            AND (
              v_entry->>'repositoryRoot' IS NULL
              OR v_entry->>'repositoryRoot' = v_manifest->>'repositoryRoot'
            )
       ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.completion_content_identity_proven(jsonb) IS
  'SQL completion floor: exact emitted-tree identity, intentional deletion absence, explicit out-of-repo artifact exclusion, or a complete manifest-bound exact-path history attestation; any nonempty settlement residual remains unproven.';

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

  IF harness_shared.completion_content_identity_proven(v_evidence) THEN
    RETURN NEW;
  END IF;

  NEW.authority := 'proposed';
  RAISE WARNING 'work_items %: completion authority downgraded committed->proposed (content identity unproven over % declared path(s))',
    COALESCE(NEW.feature_id, '?'), v_declared_count;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.downgrade_unproven_committed_close() IS
  'Below-deploy completion authority floor over filesChanged + filesDeleted, accepting exact-tree identity or a complete manifest-bound history attestation and retaining every residual (forward-repaired by migration 1207 / WI-10002350).';
