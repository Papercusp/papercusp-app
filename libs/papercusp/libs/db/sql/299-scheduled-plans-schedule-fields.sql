-- Migration 299 — Scheduled & recurring plans: schedule fields on harness_plans
-- + run-tracking deltas on plan_runs.
--
-- Plan: scheduled-recurring-plans-2026-06-16 (Phase 1 — P-002 / P-003 / P-004).
--
-- A plan optionally carries a SCHEDULE (D-001 unify — no separate "routines"
-- entity). A schedule mints a RUN per fire (D-002, Option C); the run is realized
-- as an ephemeral INSTANCE plan (slug '<template>@run-<plan_run_id>') that points
-- back to its template via template_slug. The authored recurrence lives on the
-- plan (the source of truth, D-003); the routines engine later materializes a row
-- from it that computes next_fire_at and fires system:plan-run — mirroring how a
-- blueprint's triggers.schedule materializes bp-schedule-* routine rows.
--
-- All columns are additive + nullable (schedule_active defaults false — D-010: a
-- schedule is inactive until armed through the autonomy policy; run_type defaults
-- 'interactive' so existing plan_runs rows classify correctly). Safe to apply
-- before the code that reads them. Idempotent: ADD COLUMN IF NOT EXISTS.

\set ON_ERROR_STOP on
BEGIN;

-- ── harness_plans: the authored schedule (D-003 / D-004 / D-013) ─────────────
ALTER TABLE harness_shared.harness_plans
  -- The authored recurrence SET + scheduling policy (D-004): { kind:'rrule'|'cron',
  -- rrule, dtstart, tzid, rdate[], exdate[], cron, concurrency, catchup,
  -- carry_state, cost_cap_cents }. NULL ⇒ this plan is not scheduled.
  ADD COLUMN IF NOT EXISTS schedule jsonb,
  -- Armed/active. False until armed via the autonomy-governed arming flow (D-010).
  ADD COLUMN IF NOT EXISTS schedule_active boolean NOT NULL DEFAULT false,
  -- One-shot fire time (drag-onto-a-day-cell; D-004). NULL for pure recurrence / unscheduled.
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  -- Recurrence end / deadline (D-004): on expiry the schedule deactivates; the plan is NOT deleted.
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  -- Per-plan timezone for calendar-time recurrence (D-013); NULL ⇒ workspace/user default.
  ADD COLUMN IF NOT EXISTS tzid text,
  -- Instance→template back-pointer (Option C, D-003). NULL for templates + ordinary
  -- plans; set on a per-run instance plan. Instances are hidden from plans:list by default.
  ADD COLUMN IF NOT EXISTS template_slug text,
  -- The run ordinal for an instance plan (D-003).
  ADD COLUMN IF NOT EXISTS run_seq integer;

COMMENT ON COLUMN harness_shared.harness_plans.schedule IS
  'Authored recurrence set + scheduling policy (scheduled-recurring-plans-2026-06-16 D-004): {kind, rrule, dtstart, tzid, rdate, exdate, cron, concurrency, catchup, carry_state, cost_cap_cents}. NULL = not scheduled. Source of truth; the routines engine materializes a row that computes next_fire_at.';
COMMENT ON COLUMN harness_shared.harness_plans.template_slug IS
  'Instance→template back-pointer (Option C, D-003). NULL for templates/ordinary plans; set on per-run instance plans (slug <template>@run-<id>). plans:list filters template_slug IS NOT NULL out by default.';

-- Instance grouping + the "hide instances from the main list" filter (D-003).
CREATE INDEX IF NOT EXISTS harness_plans_template_idx
  ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, template_slug)
  WHERE (template_slug IS NOT NULL);

-- Active-schedule scan (the materializer / "armed schedules" reads).
CREATE INDEX IF NOT EXISTS harness_plans_schedule_active_idx
  ON harness_shared.harness_plans USING btree (workspace_id, harness_slug)
  WHERE (schedule_active = true);

-- ── plan_runs: the occurrence ledger (D-003 / D-009) ─────────────────────────
-- plan_runs.plan_slug is the TEMPLATE slug (so "all runs of X" = WHERE plan_slug=X);
-- the per-run ephemeral instance plan is named in instance_plan_slug.
ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS instance_plan_slug text,                       -- the <template>@run-<id> instance plan (NULL for interactive launches)
  ADD COLUMN IF NOT EXISTS run_seq integer,                              -- monotonic run ordinal for this template
  ADD COLUMN IF NOT EXISTS trigger text,                                 -- 'scheduled' | 'manual' | 'event' (NULL for legacy interactive)
  ADD COLUMN IF NOT EXISTS run_type text NOT NULL DEFAULT 'interactive', -- 'interactive' | 'scheduled' (D-009)
  ADD COLUMN IF NOT EXISTS finished_at bigint,                           -- epoch ms; with launched_at gives duration
  ADD COLUMN IF NOT EXISTS outcome text,                                 -- scheduled-run result: success|failed|partial|timed-out|skipped (D-004)
  ADD COLUMN IF NOT EXISTS result_summary jsonb;                         -- routine-defined domain metrics, charted over runs (D-009, P-025)

COMMENT ON COLUMN harness_shared.plan_runs.run_type IS
  'interactive = a plan launched as a chat session (legacy default); scheduled = a fire of a scheduled plan (scheduled-recurring-plans-2026-06-16 D-009).';
COMMENT ON COLUMN harness_shared.plan_runs.outcome IS
  'Scheduled-run result enum (success|failed|partial|timed-out|skipped). Distinct from the operational `status` lifecycle. NULL for interactive runs.';

-- "All runs of a template, newest first" (the Runs tab + Queen pane read).
CREATE INDEX IF NOT EXISTS plan_runs_template_seq_idx
  ON harness_shared.plan_runs USING btree (harness_slug, plan_slug, run_seq DESC);

COMMIT;
