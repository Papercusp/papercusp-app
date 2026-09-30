-- 162-attention-triage.sql — inbox-tiering-and-message-agent-2026-06-05 (D-006).
--
-- The operator's per-item inbox-triage record. At each user-driven wake the
-- operator triages the attention feed (downgrade false positives, escalate
-- under-flagged ones, confirm/resolve the rest); the result is persisted here,
-- keyed by the AttentionItem id (`<kind>:<…>`, e.g. `coord-escalation:<msgId>`
-- or `plan-item:<slug>:<P-NNN>`). plans:attention LEFT-JOINs this table and
-- `applyTriage`s it to produce the final tier — so a downgrade moves the item to
-- the auditable "Handled by operator" tier (note = what + why), never a silent
-- vanish. Latest triage wins (the operator may re-triage), so it is an UPSERT on
-- the (workspace_id, item_id) primary key.
CREATE TABLE IF NOT EXISTS harness_shared.attention_triage (
  workspace_id TEXT        NOT NULL,
  item_id      TEXT        NOT NULL,
  action       TEXT        NOT NULL CHECK (action IN ('confirm', 'escalate', 'downgrade', 'resolve')),
  note         TEXT,
  triaged_by   TEXT,
  triaged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, item_id)
);

-- The runtime app role does CRUD (curator-operator D-009 lesson: owner-only
-- grants pass every test but fail the live harness_app connection).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.attention_triage TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.attention_triage TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- Workspace isolation, matching the operator-state table idiom (baseline / mig 158).
ALTER TABLE harness_shared.attention_triage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attention_triage_workspace_isolation ON harness_shared.attention_triage;
CREATE POLICY attention_triage_workspace_isolation ON harness_shared.attention_triage
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
