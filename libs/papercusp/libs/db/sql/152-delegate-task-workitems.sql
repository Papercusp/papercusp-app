-- Migration 152 — collapse operator:delegate into work_items
-- (plan collapse-delegate-into-workitems-2026-06-04, D-001/D-002/D-003).
--
-- A "delegated task" stops being a bespoke harness_shared.delegates session row +
-- a harness_shared.delegate_inbox poll, and BECOMES a work_item: an operator-scoped
-- issue-family item of the NEW kind `task` (D-001). Issue-family is the home because
-- engineer_issues natively supports operator-scope (workspace-wide, no harness — the
-- delegate's cross-harness nature) and gives synchronous subscribe→inject via
-- issues-engineer.deliver() on every mutation (D-003) — the push that retires the
-- delegate_inbox poll.
--
-- This migration is ADDITIVE + idempotent (ADD COLUMN with a constant/absent default
-- is metadata-only on PG11+). The destructive DROP of the two delegate tables lands
-- at the bottom (Part C), gated on the code no longer referencing them (P3). No
-- function/trigger body references either table (verified pg_proc.prosrc), so the
-- DROP cannot dangle a body (the DROP-CASCADE≠fn-body hazard does not apply here).
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg boots; safe additive on the
-- native :5432 box.

\set ON_ERROR_STOP on
BEGIN;

-- ── Part A — `task` joins the issue-family kind discriminator (D-001). ───────────
-- engineer_issues = work_items[kind ∈ bug|change|task]. `task` is a work_item kind
-- ONLY (the issues:* bug|change surface excludes it in code) — a unit of delegated
-- work the operator hands to an agent, distinct from a filed bug/change.
ALTER TABLE harness_shared.engineer_issues
    DROP CONSTRAINT IF EXISTS engineer_issues_kind_chk;
ALTER TABLE harness_shared.engineer_issues
    ADD CONSTRAINT engineer_issues_kind_chk CHECK (kind IN ('bug', 'change', 'task'));

COMMENT ON COLUMN harness_shared.engineer_issues.kind IS
    'Work-item kind discriminator (unify-work-items D-002 + collapse-delegate D-001): bug (something broken; carries severity) | change (a desired one-off) | task (a delegated unit of work — operator:delegate''s durable record; excluded from the issues:* surface). Mutable — reclassifiable.';

-- ── Part B — issue-family gains a kind-specific payload + durable assignment. ────
-- payload: mirrors harness_features_consolidated.payload (mig 136). For a `task` it
--   carries the conversational resume metadata {agentSessionId, origin, backend}.
-- assigned_by / assigned_at: the durable "who delegated this" (D-002) — distinct
--   from `assignee` (the agent doing it) and `created_by` (who filed it). Survives
--   reassignment; powers work_items:list { assignedBy } ("my background agents").
ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS assigned_by text;
ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

COMMENT ON COLUMN harness_shared.engineer_issues.payload IS
    'Kind-specific work-item payload (jsonb). NULL for bug/change (typed columns + body hold their data); for kind=task it holds the delegate resume metadata {agentSessionId, origin, backend}.';
COMMENT ON COLUMN harness_shared.engineer_issues.assigned_by IS
    'Durable delegator (collapse-delegate D-002): the coord owner that created+assigned this work-item (e.g. the operator). Distinct from assignee (the doer) and created_by. Powers work_items:list { assignedBy }.';

-- "My background agents" = work_items the operator assigned. Index the hot filter.
CREATE INDEX IF NOT EXISTS engineer_issues_assigned_by_idx
    ON harness_shared.engineer_issues (workspace_id, assigned_by, kind);

-- ── Part C — drop the retired delegate primitives (D-001/D-003). ────────────────
-- The delegate session registry + the hindsight inbox poll dissolve into the
-- work_item (Part A/B) + subscribe→inject (coord). Both are workspace-local,
-- referenced by NO function/trigger body, so a plain DROP is safe. Sequences are
-- owned by the tables (BIGSERIAL) and drop with them.
DROP TABLE IF EXISTS harness_shared.delegate_inbox;
DROP TABLE IF EXISTS harness_shared.delegates;

COMMIT;
