-- Migration 306 — Add schedule-related columns to harness_features_consolidated
--
-- Migration 299 (scheduled-recurring-plans-2026-06-16) added schedule columns to
-- harness_plans and plan_runs. For consistency and to avoid intermittent errors
-- when schema introspection or views expect these columns on all feature-family
-- tables, add them to harness_features_consolidated as well.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS schedule jsonb,
  ADD COLUMN IF NOT EXISTS schedule_active boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS tzid text,
  ADD COLUMN IF NOT EXISTS template_slug text,
  ADD COLUMN IF NOT EXISTS run_seq integer;

COMMIT;
