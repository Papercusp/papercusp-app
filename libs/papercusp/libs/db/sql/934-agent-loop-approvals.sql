-- 934-agent-loop-approvals.sql
-- PG-backed pending-approval rows for the owned agent loop's HITL round-trip
-- on the native session protocol (P-008, own-tui-full-divorce-2026-08-24).
--
-- WHY A TABLE (same rationale as 740-agent-chat-locks-pg-backed): :3070 is a
-- 16-worker node:cluster. The SSE stream holding a paused runAgentLoop (a
-- tool call awaiting approval) lives on ONE worker; the client's approval
-- POST can land on ANY worker. An in-process correlator (the card-correlator
-- shape) only works within a single worker, so the decision must round-trip
-- through PG: the ApprovalPort inserts a pending row and polls it; the
-- approval route UPDATEs it from whichever worker receives the POST.
--
-- Rows are short-lived (a decision or a timeout resolves them within
-- minutes); resolved rows are kept briefly for idempotent re-reads and are
-- reaped opportunistically by the store (delete-on-terminal + age sweep),
-- not by a scheduled job.

CREATE TABLE IF NOT EXISTS harness_shared.agent_loop_approvals (
  chat_id       TEXT        NOT NULL,
  call_id       TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL,
  tool_name     TEXT        NOT NULL,
  tool_input    JSONB       NOT NULL DEFAULT 'null'::jsonb,
  step_index    INTEGER     NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'denied')),
  reason        TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  PRIMARY KEY (chat_id, call_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_loop_approvals_pending
  ON harness_shared.agent_loop_approvals (chat_id, requested_at)
  WHERE status = 'pending';

COMMENT ON TABLE harness_shared.agent_loop_approvals IS
  'Pending/resolved HITL approval requests for the owned agent loop (P-008 native session protocol). One row per gated tool call; the loop-holding worker polls, any worker may resolve. See packages/operator-core/lib/agent-loop/approval-store.ts.';
