-- 995-work-item-completion-settlement-manifest.sql
--
-- Backfill only terminal proposed rows whose persisted, server-stamped evidence
-- already contains an exact repository root and per-path blob identities. The
-- migration deliberately does not change authority and does not manufacture a
-- receipt for legacy/pathless evidence.

WITH eligible AS (
  SELECT
    workspace_id,
    feature_id,
    payload -> '_completionEvidence' AS evidence,
    payload -> '_completionEvidence' -> 'treeStamp' AS stamp
  FROM harness_shared.work_items
  WHERE status IN ('done', 'resolved', 'deprecated', 'needs_human', 'dropped')
    AND authority = 'proposed'
    AND payload -> '_completionEvidence' -> 'settlementManifest' IS NULL
    AND jsonb_typeof(payload -> '_completionEvidence' -> 'treeStamp' -> 'repositoryRoot') = 'string'
    AND jsonb_typeof(payload -> '_completionEvidence' -> 'treeStamp' -> 'headSha') = 'string'
    AND jsonb_typeof(payload -> '_completionEvidence' -> 'treeStamp' -> 'contentIdentity') = 'array'
    AND jsonb_array_length(payload -> '_completionEvidence' -> 'treeStamp' -> 'contentIdentity') > 0
), manifests AS (
  SELECT
    workspace_id,
    feature_id,
    jsonb_build_object(
      'version', 1,
      'generation', 1,
      'evidenceHash', encode(digest(evidence::text, 'sha256'), 'hex'),
      'repositoryRoot', stamp ->> 'repositoryRoot',
      'headSha', stamp ->> 'headSha',
      'normalizedPaths', (
        SELECT jsonb_agg(path ORDER BY path)
        FROM (
          SELECT DISTINCT identity ->> 'path' AS path
          FROM jsonb_array_elements(stamp -> 'contentIdentity') identity
          WHERE NULLIF(identity ->> 'path', '') IS NOT NULL
        ) paths
      ),
      'contentIdentity', (
        SELECT jsonb_agg(identity ORDER BY identity ->> 'path')
        FROM jsonb_array_elements(stamp -> 'contentIdentity') identity
        WHERE NULLIF(identity ->> 'path', '') IS NOT NULL
      )
    ) AS manifest
  FROM eligible
)
UPDATE harness_shared.work_items wi
SET payload = jsonb_set(
      wi.payload,
      '{_completionEvidence,settlementManifest}',
      manifests.manifest,
      true
    ),
    updated_ts = (extract(epoch FROM now()) * 1000)::bigint
FROM manifests
WHERE wi.workspace_id = manifests.workspace_id
  AND wi.feature_id = manifests.feature_id
  AND manifests.manifest -> 'normalizedPaths' IS NOT NULL;
