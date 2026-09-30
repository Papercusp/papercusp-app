-- Migration 142 — work_items unification (plan unify-work-items-2026-06-04).
--
-- Collapses the work-unit family into one `work_item` TYPE discriminated by `kind`
-- (D-001). This migration lands the SAFE, ADDITIVE foundation on the (a)-substrate
-- the codebase already chose (migration 136: harness_features_consolidated carries
-- the `item_kind` discriminator + `payload`, exposed as the `work_items` VIEW):
--
--   • features (harness_features_consolidated)  = work_items[kind ∈ feature|research-task|chunk]
--                                                 (the existing `item_kind` column)
--   • issues   (engineer_issues)                = work_items[kind ∈ bug|change]   ← NEW here
--
-- The two shipped tables stay their own per-kind tables (D-010=(b): a 'table' is a
-- schema-group; the rename to work_items_feature/work_items_issue is cosmetic and
-- HIGH-risk — federation trigger/function bodies reference the base by NAME, so a
-- bare RENAME leaves them dangling (the DROP-CASCADE≠function-body hazard) — and is
-- deliberately sequenced to a supervised, rolled-back-tx-tested follow-on). The
-- unifying surface is delivered in CODE (the work_items:* tool surface + the
-- work-items.ts engine over both per-kind tables), which is the canonical
-- agent-facing API per D-007 ("the type is the API, the table is an implementation
-- detail you can change behind it").
--
-- This migration is additive + idempotent: it does NOT re-id existing rows, rename
-- tables, drop blocked_by, or touch the live pipeline's id space. The bulk in-place
-- F-NNN/EI-NNN → WI-NNN re-id is the genuinely-destructive follow-on (it collides
-- with live DBOS workflow ids `pipeline:<slug>:<F-id>:e<epoch>`, the 5 feature
-- satellite tables, and the coord_links/threads/subs refs) and must run under a
-- pipeline drain — see the plan's Risks + the §"deferred (supervision-required)"
-- handoff.
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg boots; safe additive on the
-- native :5432 box. ADD COLUMN with a constant DEFAULT is metadata-only on PG11+.

\set ON_ERROR_STOP on
BEGIN;

-- ── D-002: the bug|change discriminator within the issue kind-table. ────────────
-- engineer_issues becomes work_items[kind ∈ bug|change]. Default 'bug' (a filed
-- issue is "something broken" / carries severity, unless reclassified to a
-- 'change' = a desired one-off, the "make it bigger"/DX case). `kind` is mutable
-- (D-002) — a change can be reclassified to a feature once understood (which is
-- why the WI id below is kind-independent).
ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bug';

ALTER TABLE harness_shared.engineer_issues
    DROP CONSTRAINT IF EXISTS engineer_issues_kind_chk;
ALTER TABLE harness_shared.engineer_issues
    ADD CONSTRAINT engineer_issues_kind_chk CHECK (kind IN ('bug', 'change'));

COMMENT ON COLUMN harness_shared.engineer_issues.kind IS
    'Work-item kind discriminator (unify-work-items D-002): bug (something broken; carries severity) | change (a desired one-off). engineer_issues = work_items[kind ∈ bug|change]. Mutable — reclassifiable.';

CREATE INDEX IF NOT EXISTS engineer_issues_kind_idx
    ON harness_shared.engineer_issues (workspace_id, kind);

-- ── D-008: kind-INDEPENDENT WI-NNN id space for the unified surface. ────────────
-- ONE global sequence so a WI id is unique across EVERY kind-table (feature-base +
-- issue-base) — which makes reclassification (kind is mutable) a stable-handle move
-- (a kind-prefixed id would lie after a cross-kind move). This is the GO-FORWARD
-- allocator for newly-created work_items via work_items:create. Existing F-NNN /
-- EI-NNN rows are NOT re-id'd here (deferred, supervision-required — see header).
CREATE SEQUENCE IF NOT EXISTS harness_shared.work_item_seq AS bigint START 1;

CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id() RETURNS text
    LANGUAGE sql VOLATILE AS $body$
    SELECT 'WI-' || nextval('harness_shared.work_item_seq')::text
$body$;

COMMENT ON FUNCTION harness_shared.next_work_item_id() IS
    'Allocate the next kind-independent WI-NNN work-item id (unify-work-items D-008). One global sequence across all kind-tables; the stable opaque handle that survives a kind reclassification.';

-- Grants (mirror the existing engineer_issues / harness_features_consolidated
-- pattern: harness_app is the operator runtime role).
GRANT USAGE, SELECT ON SEQUENCE harness_shared.work_item_seq TO harness_app;
GRANT EXECUTE ON FUNCTION harness_shared.next_work_item_id() TO harness_app;

COMMIT;
