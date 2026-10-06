-- 1390-completion-history-attestation-v2-settlement-floor.sql
-- WI-10006322 forward repair, reusing EI-24932469749678544's per-checkout validator.
-- and close-time HEAD. Keep version-1 single-checkout attestations readable.

CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  v_evidence          jsonb;
  v_identity          jsonb;
  v_manifest          jsonb;
  v_attestation       jsonb;
  v_entry             jsonb;
  v_checkout          jsonb;
  v_path              jsonb;
  v_root              text;
  v_head              text;
  v_emitted           text;
  v_history_valid     boolean := false;
  v_count             integer;
  v_distinct_count    integer;
BEGIN
  IF p_identity IS NULL THEN
    RETURN false;
  END IF;

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

  IF v_identity IS NULL OR jsonb_typeof(v_identity) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_identity) = 0 THEN
    RETURN false;
  END IF;

  IF v_manifest IS NOT NULL AND v_manifest <> 'null'::jsonb THEN
    IF jsonb_typeof(v_manifest) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF v_manifest ? 'residualPaths' AND
       (jsonb_typeof(v_manifest->'residualPaths') IS DISTINCT FROM 'array'
        OR jsonb_array_length(v_manifest->'residualPaths') <> 0) THEN
      RETURN false;
    END IF;

    IF v_manifest ? 'normalizedPaths' THEN
      IF jsonb_typeof(v_manifest->'normalizedPaths') IS DISTINCT FROM 'array'
         OR jsonb_typeof(v_manifest->'contentIdentity') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_manifest->'normalizedPaths') <> jsonb_array_length(v_manifest->'contentIdentity') THEN
        RETURN false;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_manifest->'contentIdentity') AS identity_item(value)
         WHERE (SELECT count(*)
                  FROM jsonb_array_elements(v_manifest->'normalizedPaths') AS normalized_item(value)
                 WHERE normalized_item.value = to_jsonb(identity_item.value->>'path'))
               <> (SELECT count(*)
                     FROM jsonb_array_elements(v_manifest->'contentIdentity') AS same_path(value)
                    WHERE same_path.value->>'path' = identity_item.value->>'path')
      ) THEN
        RETURN false;
      END IF;
    END IF;

    IF jsonb_typeof(v_manifest->'contentIdentity') = 'array' AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_manifest->'contentIdentity') AS identity_item(value)
       WHERE (identity_item.value ? 'repositoryRoot'
              AND NULLIF(btrim(identity_item.value->>'repositoryRoot'), '') IS NULL)
          OR (identity_item.value ? 'headSha'
              AND COALESCE(identity_item.value->>'headSha' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false)
    ) THEN
      RETURN false;
    END IF;
  END IF;

  IF v_attestation IS NOT NULL AND v_attestation <> 'null'::jsonb THEN
    IF jsonb_typeof(v_attestation) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_manifest) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_manifest->'contentIdentity') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_manifest->'normalizedPaths') IS DISTINCT FROM 'array'
       OR v_manifest->'version' IS DISTINCT FROM '1'::jsonb
       OR (v_manifest->>'generation') !~ '^[1-9][0-9]*$'
       OR (v_manifest->>'evidenceHash') !~ '^[0-9a-f]{64}$'
       OR NULLIF(btrim(v_manifest->>'repositoryRoot'), '') IS NULL
       OR (v_manifest->>'headSha') !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
       OR v_attestation->>'generation' IS DISTINCT FROM v_manifest->>'generation'
       OR v_attestation->>'evidenceHash' IS DISTINCT FROM v_manifest->>'evidenceHash' THEN
      RETURN false;
    END IF;

    IF v_attestation->'version' = '1'::jsonb THEN
      IF v_attestation->>'repositoryRoot' = v_manifest->>'repositoryRoot'
         AND v_attestation->>'closeHeadSha' = v_manifest->>'headSha'
         AND (v_attestation->>'emittedCommitSha') ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
         AND jsonb_typeof(v_attestation->'paths') = 'array'
         AND jsonb_array_length(v_attestation->'paths') > 0 THEN
        v_history_valid := true;
        SELECT count(*), count(DISTINCT value->>'path')
          INTO v_count, v_distinct_count
          FROM jsonb_array_elements(v_attestation->'paths') AS attested(value);
        IF v_count <> v_distinct_count THEN v_history_valid := false; END IF;

        IF EXISTS (
          SELECT 1
            FROM jsonb_array_elements(v_attestation->'paths') AS attested(value)
           WHERE jsonb_typeof(attested.value) IS DISTINCT FROM 'object'
              OR NULLIF(btrim(attested.value->>'path'), '') IS NULL
              OR COALESCE(attested.value->>'workingTreeBlobSha' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false
              OR attested.value->>'fromHeadSha' IS DISTINCT FROM v_manifest->>'headSha'
              OR attested.value->>'toCommitSha' IS DISTINCT FROM v_attestation->>'emittedCommitSha'
              OR attested.value->>'proof' IS DISTINCT FROM 'exact-path-blob-history'
              OR (SELECT count(*) FROM jsonb_array_elements(v_manifest->'contentIdentity') AS manifest_item(value)
                   WHERE manifest_item.value->>'path' = attested.value->>'path'
                     AND COALESCE(NULLIF(manifest_item.value->>'repositoryRoot', ''), v_manifest->>'repositoryRoot') = v_manifest->>'repositoryRoot'
                     AND COALESCE(NULLIF(manifest_item.value->>'headSha', ''), v_manifest->>'headSha') = v_manifest->>'headSha'
                     AND manifest_item.value->>'workingTreeBlobSha' = attested.value->>'workingTreeBlobSha'
                     AND manifest_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb) <> 1
              OR (SELECT count(*) FROM jsonb_array_elements(v_manifest->'normalizedPaths') AS normalized(value)
                   WHERE normalized.value = to_jsonb(attested.value->>'path')) <> 1
              OR (SELECT count(*) FROM jsonb_array_elements(v_identity) AS current_item(value)
                   WHERE current_item.value->>'path' = attested.value->>'path'
                     AND COALESCE(NULLIF(current_item.value->>'repositoryRoot', ''), v_manifest->>'repositoryRoot') = v_manifest->>'repositoryRoot'
                     AND COALESCE(NULLIF(current_item.value->>'headSha', ''), v_manifest->>'headSha') = v_manifest->>'headSha'
                     AND current_item.value->>'workingTreeBlobSha' = attested.value->>'workingTreeBlobSha'
                     AND current_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb
                     AND current_item.value->'outOfRepoArtifact' IS DISTINCT FROM 'true'::jsonb) <> 1
        ) THEN
          v_history_valid := false;
        END IF;
      END IF;
    ELSIF v_attestation->'version' = '2'::jsonb
       AND jsonb_typeof(v_attestation->'checkouts') = 'array'
       AND jsonb_array_length(v_attestation->'checkouts') > 0 THEN
      v_history_valid := true;
      SELECT count(*), count(DISTINCT (value->>'repositoryRoot', value->>'closeHeadSha'))
        INTO v_count, v_distinct_count
        FROM jsonb_array_elements(v_attestation->'checkouts') AS checkout(value);
      IF v_count <> v_distinct_count THEN v_history_valid := false; END IF;

      FOR v_checkout IN SELECT value FROM jsonb_array_elements(v_attestation->'checkouts') AS checkout(value)
      LOOP
        v_root := v_checkout->>'repositoryRoot';
        v_head := v_checkout->>'closeHeadSha';
        v_emitted := v_checkout->>'emittedCommitSha';
        IF jsonb_typeof(v_checkout) IS DISTINCT FROM 'object'
           OR NULLIF(btrim(v_root), '') IS NULL
           OR COALESCE(v_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false
           OR COALESCE(v_emitted ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false
           OR jsonb_typeof(v_checkout->'paths') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_checkout->'paths') = 0 THEN
          v_history_valid := false;
          EXIT;
        END IF;
        SELECT count(*), count(DISTINCT value->>'path')
          INTO v_count, v_distinct_count
          FROM jsonb_array_elements(v_checkout->'paths') AS attested(value);
        IF v_count <> v_distinct_count THEN
          v_history_valid := false;
          EXIT;
        END IF;

        FOR v_path IN SELECT value FROM jsonb_array_elements(v_checkout->'paths') AS attested(value)
        LOOP
          IF jsonb_typeof(v_path) IS DISTINCT FROM 'object'
             OR NULLIF(btrim(v_path->>'path'), '') IS NULL
             OR COALESCE(v_path->>'workingTreeBlobSha' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$', false) = false
             OR v_path->>'fromHeadSha' IS DISTINCT FROM v_head
             OR v_path->>'toCommitSha' IS DISTINCT FROM v_emitted
             OR v_path->>'proof' IS DISTINCT FROM 'exact-path-blob-history'
             OR (SELECT count(*) FROM jsonb_array_elements(v_manifest->'contentIdentity') AS manifest_item(value)
                  WHERE manifest_item.value->>'path' = v_path->>'path'
                    AND COALESCE(NULLIF(manifest_item.value->>'repositoryRoot', ''), v_manifest->>'repositoryRoot') = v_root
                    AND COALESCE(NULLIF(manifest_item.value->>'headSha', ''), v_manifest->>'headSha') = v_head
                    AND manifest_item.value->>'workingTreeBlobSha' = v_path->>'workingTreeBlobSha'
                    AND manifest_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb) <> 1
             OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest->'normalizedPaths') AS normalized(value)
                              WHERE normalized.value = to_jsonb(v_path->>'path'))
             OR (SELECT count(*) FROM jsonb_array_elements(v_identity) AS current_item(value)
                  WHERE current_item.value->>'path' = v_path->>'path'
                    AND COALESCE(NULLIF(current_item.value->>'repositoryRoot', ''), v_manifest->>'repositoryRoot') = v_root
                    AND COALESCE(NULLIF(current_item.value->>'headSha', ''), v_manifest->>'headSha') = v_head
                    AND current_item.value->>'workingTreeBlobSha' = v_path->>'workingTreeBlobSha'
                    AND current_item.value->'deletion' IS DISTINCT FROM 'true'::jsonb
                    AND current_item.value->'outOfRepoArtifact' IS DISTINCT FROM 'true'::jsonb) <> 1 THEN
            v_history_valid := false;
            EXIT;
          END IF;
        END LOOP;
        IF NOT v_history_valid THEN EXIT; END IF;
      END LOOP;
    END IF;

    -- Any supplied but malformed proof is a rejection, never a way around the floor.
    IF NOT v_history_valid THEN RETURN false; END IF;
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_identity) AS identity_item(value)
  LOOP
    IF COALESCE((v_entry->>'outOfRepoArtifact')::boolean, false) THEN CONTINUE; END IF;
    IF v_entry->'deletion' = 'true'::jsonb THEN
      IF v_entry->>'workingTreeBlobSha' IS NOT NULL OR v_entry->>'headBlobSha' IS NOT NULL THEN RETURN false; END IF;
      CONTINUE;
    END IF;
    IF v_entry->>'workingTreeBlobSha' IS NOT NULL
       AND v_entry->>'headBlobSha' IS NOT NULL
       AND v_entry->>'workingTreeBlobSha' = v_entry->>'headBlobSha' THEN
      CONTINUE;
    END IF;
    IF NOT v_history_valid OR v_manifest IS NULL OR v_attestation IS NULL THEN RETURN false; END IF;

    v_root := COALESCE(NULLIF(v_entry->>'repositoryRoot', ''), v_manifest->>'repositoryRoot');
    v_head := COALESCE(NULLIF(v_entry->>'headSha', ''), v_manifest->>'headSha');
    IF v_attestation->'version' = '1'::jsonb THEN
      IF v_root IS DISTINCT FROM v_manifest->>'repositoryRoot'
         OR v_head IS DISTINCT FROM v_manifest->>'headSha'
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_attestation->'paths') AS attested(value)
                          WHERE attested.value->>'path' = v_entry->>'path'
                            AND attested.value->>'workingTreeBlobSha' = v_entry->>'workingTreeBlobSha') THEN
        RETURN false;
      END IF;
    ELSIF v_attestation->'version' = '2'::jsonb THEN
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_attestation->'checkouts') AS checkout(value)
          CROSS JOIN LATERAL jsonb_array_elements(checkout.value->'paths') AS attested(value)
         WHERE checkout.value->>'repositoryRoot' = v_root
           AND checkout.value->>'closeHeadSha' = v_head
           AND attested.value->>'path' = v_entry->>'path'
           AND attested.value->>'workingTreeBlobSha' = v_entry->>'workingTreeBlobSha'
      ) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$fn$;
