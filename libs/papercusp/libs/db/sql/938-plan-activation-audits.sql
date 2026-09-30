-- 938-plan-activation-audits.sql
--
-- Extend the existing plan-audit ledger with a second, explicitly typed pass:
-- conversation-completeness before draft -> ready activation. Existing rows are
-- completion/code-truth audits and retain that meaning through the default.

ALTER TABLE harness_shared.plan_audits
  ADD COLUMN IF NOT EXISTS audit_kind text NOT NULL DEFAULT 'completion',
  ADD COLUMN IF NOT EXISTS activation jsonb,
  ADD COLUMN IF NOT EXISTS audited_plan_revision_id bigint,
  ADD COLUMN IF NOT EXISTS audited_plan_revision_seq integer,
  ADD COLUMN IF NOT EXISTS audited_plan_content_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'plan_audits_kind_check'
       AND conrelid = 'harness_shared.plan_audits'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_audits
      ADD CONSTRAINT plan_audits_kind_check
      CHECK (audit_kind IN ('completion', 'activation'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'plan_audits_activation_shape_check'
       AND conrelid = 'harness_shared.plan_audits'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_audits
      ADD CONSTRAINT plan_audits_activation_shape_check
      CHECK (
        audit_kind = 'completion'
        OR (
          jsonb_typeof(activation) = 'object'
          AND audited_plan_revision_id IS NOT NULL
          AND audited_plan_revision_seq IS NOT NULL
          AND audited_plan_revision_seq > 0
          AND audited_plan_content_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.plan_audits.audit_kind IS
  'completion = post-implementation code-truth audit; activation = pre-ready conversation-completeness audit.';

COMMENT ON COLUMN harness_shared.plan_audits.activation IS
  'Activation audit payload: source ranges, resolvable session_turn refs, requirement-to-plan mappings, repaired omissions, rejected/superseded requirements, and unresolved blockers.';

COMMENT ON COLUMN harness_shared.plan_audits.audited_plan_revision_id IS
  'Exact plan_revisions.id observed by the server when an activation audit was recorded.';

COMMENT ON COLUMN harness_shared.plan_audits.audited_plan_revision_seq IS
  'Exact per-plan revision sequence observed by the server when an activation audit was recorded.';

COMMENT ON COLUMN harness_shared.plan_audits.audited_plan_content_hash IS
  'Exact content hash of the plan revision audited. Later plan edits do not invalidate the audit; this remains the comparison anchor.';

CREATE INDEX IF NOT EXISTS plan_audits_kind_recent_idx
  ON harness_shared.plan_audits (workspace_id, plan_slug, audit_kind, audit_seq DESC);
