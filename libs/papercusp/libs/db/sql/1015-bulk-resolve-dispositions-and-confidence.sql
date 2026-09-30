-- 1015-bulk-resolve-dispositions-and-confidence.sql
--
-- Add the shared, owner-readable disposition layer for Inbox bulk-resolve and
-- Plans cleanup runs.  The old `outcome='skipped'` value remains intact for
-- forward/backward compatibility, but new writers can persist a typed
-- disposition and a recommendation even when no terminal action exists.
--
-- This is an EXPAND-ONLY migration: all columns are nullable/defaulted, legacy
-- rows are backfilled to `legacy_skipped`, and no existing terminal outcome is
-- reset or widened.  The draft suffix keeps it out of boot auto-apply until the
-- focused integration checks have passed and the allocator's arm command runs.

-- ── run-level policy snapshot ───────────────────────────────────────────────
ALTER TABLE harness_shared.attention_bulk_runs
  ADD COLUMN IF NOT EXISTS automation_policy JSONB NOT NULL
    DEFAULT '{"mode":"safe-high","minConfidence":"high"}'::jsonb;

COMMENT ON COLUMN harness_shared.attention_bulk_runs.automation_policy IS
  'Click-time owner policy for bulk automation: mode review-all|safe-high|safe-medium-plus '
  'and minConfidence high|medium|low|insufficient. The server applies this as an '
  'additional floor after autonomy/authority gates; absent/legacy rows use safe-high.';

-- ── Inbox item metadata ─────────────────────────────────────────────────────
ALTER TABLE harness_shared.attention_bulk_run_items
  ADD COLUMN IF NOT EXISTS disposition TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_kind TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_label TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_rationale TEXT,
  ADD COLUMN IF NOT EXISTS evidence_basis JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS responsibility TEXT,
  ADD COLUMN IF NOT EXISTS confidence_level TEXT,
  ADD COLUMN IF NOT EXISTS retry_condition TEXT;

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD CONSTRAINT attention_bulk_run_items_disposition_check
    CHECK (disposition IS NULL OR disposition IN (
      'pending', 'auto_resolved', 'recommended', 'owner_action',
      'cleanup_candidate', 'retry_needed', 'routed', 'investigate',
      'failed', 'dismissed', 'legacy_skipped')),
  ADD CONSTRAINT attention_bulk_run_items_recommendation_kind_check
    CHECK (recommendation_kind IS NULL OR recommendation_kind IN (
      'owner_action', 'cleanup_candidate', 'retry_needed', 'routed', 'investigate')),
  ADD CONSTRAINT attention_bulk_run_items_responsibility_check
    CHECK (responsibility IS NULL OR responsibility IN (
      'owner', 'agent', 'system', 'engineering', 'unknown')),
  ADD CONSTRAINT attention_bulk_run_items_confidence_level_check
    CHECK (confidence_level IS NULL OR confidence_level IN (
      'high', 'medium', 'low', 'insufficient'));

-- Existing rows retain their original outcome while gaining an explicit
-- compatibility disposition.  `skipped` is deliberately not reinterpreted in
-- SQL; the deterministic classifier supplies the owner-facing recommendation
-- at read time until a later audited reclassification writes it explicitly.
UPDATE harness_shared.attention_bulk_run_items
   SET disposition = CASE outcome
       WHEN 'pending' THEN 'pending'
       WHEN 'auto_resolved' THEN 'auto_resolved'
       WHEN 'recommended' THEN 'recommended'
       WHEN 'failed' THEN 'failed'
       WHEN 'dismissed' THEN 'dismissed'
       WHEN 'skipped' THEN 'legacy_skipped'
       ELSE 'investigate'
     END
 WHERE disposition IS NULL;

CREATE INDEX IF NOT EXISTS attention_bulk_run_items_disposition_idx
  ON harness_shared.attention_bulk_run_items (workspace_id, run_id, disposition);

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.disposition IS
  'Canonical owner-facing disposition. legacy_skipped is compatibility-only; '
  'new resolver reports must use a typed recommendation or terminal disposition.';

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.confidence_level IS
  'Canonical recommendation confidence: high|medium|low|insufficient. The '
  'legacy confidence column remains for wire compatibility and is not an authority gate.';

-- ── Plans cleanup finding metadata ─────────────────────────────────────────
ALTER TABLE harness_shared.plan_cleanup_run_findings
  ADD COLUMN IF NOT EXISTS disposition TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_kind TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_label TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_rationale TEXT,
  ADD COLUMN IF NOT EXISTS evidence_basis JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS responsibility TEXT,
  ADD COLUMN IF NOT EXISTS confidence_level TEXT,
  ADD COLUMN IF NOT EXISTS retry_condition TEXT;

ALTER TABLE harness_shared.plan_cleanup_run_findings
  ADD CONSTRAINT plan_cleanup_run_findings_disposition_check
    CHECK (disposition IS NULL OR disposition IN (
      'pending', 'auto_resolved', 'recommended', 'owner_action',
      'cleanup_candidate', 'retry_needed', 'routed', 'investigate',
      'failed', 'dismissed', 'legacy_skipped')),
  ADD CONSTRAINT plan_cleanup_run_findings_recommendation_kind_check
    CHECK (recommendation_kind IS NULL OR recommendation_kind IN (
      'owner_action', 'cleanup_candidate', 'retry_needed', 'routed', 'investigate')),
  ADD CONSTRAINT plan_cleanup_run_findings_responsibility_check
    CHECK (responsibility IS NULL OR responsibility IN (
      'owner', 'agent', 'system', 'engineering', 'unknown')),
  ADD CONSTRAINT plan_cleanup_run_findings_confidence_level_check
    CHECK (confidence_level IS NULL OR confidence_level IN (
      'high', 'medium', 'low', 'insufficient'));

UPDATE harness_shared.plan_cleanup_run_findings
   SET disposition = CASE outcome
       WHEN 'pending' THEN 'pending'
       WHEN 'auto_applied' THEN 'auto_resolved'
       WHEN 'accepted' THEN 'auto_resolved'
       WHEN 'recommended' THEN 'recommended'
       WHEN 'failed' THEN 'failed'
       WHEN 'dismissed' THEN 'dismissed'
       WHEN 'skipped' THEN 'legacy_skipped'
       ELSE 'investigate'
     END
 WHERE disposition IS NULL;

CREATE INDEX IF NOT EXISTS plan_cleanup_run_findings_disposition_idx
  ON harness_shared.plan_cleanup_run_findings (workspace_id, run_id, disposition);

COMMENT ON COLUMN harness_shared.plan_cleanup_run_findings.disposition IS
  'Canonical owner-facing disposition shared with Inbox runs. legacy_skipped is '
  'compatibility-only; scanner/resolver writers should use typed dispositions.';

COMMENT ON COLUMN harness_shared.plan_cleanup_run_findings.confidence_level IS
  'Canonical recommendation confidence shared with Inbox runs. Existing scanner '
  'confidence (provable|recommended) remains unchanged for cleanup mechanics.';
