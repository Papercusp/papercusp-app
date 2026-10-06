-- Migration 136 — work_items generalization (FIRST CUT, additive + safe).
-- (Renumbered 135→136 to resolve a same-prefix collision with
--  135-migration-reservations.sql; already applied live to :5432 — idempotent.)
--
-- Plan: harness-blueprint-orchestration-2026-06-03 (P-020 / D-013 / D-027 / D-028).
--
-- D-013 generalizes the canonical work-unit store into work_items(kind, payload).
-- Schema reality (audited live): harness_features_consolidated ALREADY exists as
-- the canonical base WITH a `kind` column — but that `kind` is the feature
-- SUB-CATEGORY ('' | infra | security | dogfood-followup), orthogonal to the
-- work-item discriminator D-013 wants (feature vs research-task vs …). So we add
-- a SEPARATE discriminator `item_kind` (every existing row is a feature →
-- DEFAULT 'feature') + a kind-specific `payload jsonb`, and expose the canonical
-- `work_items` name as a VIEW over the base. The base keeps its triggers (incl.
-- the capture_substrate_outbox federation CDC), so federation now spans every
-- work-item kind once non-feature rows appear.
--
-- DELIBERATELY DEFERRED to coordinated follow-ons (NOT in this cut), each with a
-- reason — see the plan's P-020 note + the coord thread with su-a5a32:
--   1. blocked_by → coord_links rel='blocks' edge + frontier-projection (D-027/
--      D-028). Dropping blocked_by here would BREAK live dispatch — the P-042
--      frontier reads the column and nothing writes coord_links blocking edges
--      yet (that write-path + the denormalized frontier-projection are su-a5a32's
--      coord_links domain). We keep the EXISTING blocked_by column unchanged (NOT
--      a new 4th fork — the same column, in place); the unification is the
--      explicit D-027 follow-on. Surfaced for avi: this defers D-028's literal
--      "drop in P-020" because a blind drop breaks the live frontier.
--   2. Making the base triggers (fill_needs_design / fill_ws_features) kind-aware
--      so non-feature rows are handled correctly — needed BEFORE non-feature
--      work-items are actually inserted (currently gated; no non-feature rows exist).
--   3. Inverting physical storage so work_items is the BASE and
--      harness_features_consolidated a kind='feature' view — a rename that risks
--      federation-trigger amplification (function bodies reference the base by
--      name); deferred to a rolled-back-tx-tested, coordinated pass.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE VIEW. ADD COLUMN with a
-- constant DEFAULT is metadata-only (no table rewrite) on PG11+. Composes onto
-- 000-baseline.sql for fresh/embedded-pg boots; safe additive on the native :5432 box.

\set ON_ERROR_STOP on
BEGIN;

-- The work-item discriminator (D-013). Every existing row is a feature.
ALTER TABLE harness_shared.harness_features_consolidated
    ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'feature';

-- Kind-specific payload (e.g. a research-task's question/findings). NULL for
-- features (their data lives in the existing typed columns).
ALTER TABLE harness_shared.harness_features_consolidated
    ADD COLUMN IF NOT EXISTS payload jsonb;

COMMENT ON COLUMN harness_shared.harness_features_consolidated.item_kind IS
    'Work-item discriminator (D-013): feature | research-task | … . Distinct from the legacy `kind` column (feature sub-category: infra/security/…). Default ''feature''.';
COMMENT ON COLUMN harness_shared.harness_features_consolidated.payload IS
    'Kind-specific work-item payload (jsonb). NULL for features (typed columns hold their data).';

-- Index the discriminator for kind-scoped scans (cheap; mostly 'feature').
CREATE INDEX IF NOT EXISTS hfc_item_kind_idx
    ON harness_shared.harness_features_consolidated (workspace_id, harness_slug, item_kind);

-- The canonical work_items READ surface. Writes still go to the base table via
-- the existing feature paths (and, for non-feature kinds, the gated work-item
-- inserter once trigger kind-awareness lands). `feature_id` is the work-item id.
CREATE OR REPLACE VIEW harness_shared.work_items AS
    SELECT * FROM harness_shared.harness_features_consolidated;

COMMENT ON VIEW harness_shared.work_items IS
    'Canonical work-item read surface (D-013) over harness_features_consolidated. Discriminator = item_kind; kind-specific data = payload. First cut: blocking still rides blocked_by (coord_links-edge unification is the D-027 follow-on).';

GRANT SELECT ON harness_shared.work_items TO harness_app;
GRANT SELECT ON harness_shared.work_items TO harness_zero;

COMMIT;
