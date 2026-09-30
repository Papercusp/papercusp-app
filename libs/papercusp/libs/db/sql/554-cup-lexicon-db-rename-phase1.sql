-- 554-cup-lexicon-db-rename-phase1.sql
--
-- P-009 Phase 1 (cup-lexicon-full-rename-2026-07-09, Slice H): rename the SAFE subset of
-- hive/bee-lexicon SQL identifiers -- tables, columns, constraints, indexes, one sequence --
-- to their pot/cup/mug equivalents. Scope is DELIBERATELY NARROWER than the full 27-table
-- audit: hives, hive_members, hive_policy, hive_settings, hive_pending_joins, hive_reports,
-- cross_hive_asks, cross_hive_outbox, cross_hive_beacon_history, hive_epoch_keys,
-- hive_directory_cache, hive_directory_tombstones, bee_claim_specs, and beekeeper_* are ALL
-- deliberately DEFERRED (see WI-3465 checkpoint): they are exclusively accessed via raw SQL
-- literals inside the still-unrenamed "federation-CRUD family" (hive-store.ts,
-- hive-membership-store.ts, etc.) or carry live-traffic risk (bee_claim_specs backs
-- scheduler:get_next fleet-wide; beekeeper_* has active eval batteries running) --
-- Postgres cannot target INSERT...ON CONFLICT at a view (no clean compat-view escape), so
-- those tables must wait for their accessor files to be migrated in the same change.
--
-- IDEMPOTENT: each table's rename block is individually guarded (skips if already renamed),
-- so a partial prior apply or a re-run converges safely.

\set ON_ERROR_STOP on

-- ── hive_placements -> pot_placements ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_placements') IS NOT NULL AND to_regclass('harness_shared.pot_placements') IS NULL THEN
    ALTER TABLE harness_shared.hive_placements RENAME TO pot_placements;
    ALTER TABLE harness_shared.pot_placements RENAME COLUMN queen_owner_id TO mug_owner_id;
    ALTER TABLE harness_shared.pot_placements RENAME COLUMN bee_spawn_id TO cup_spawn_id;
    ALTER TABLE harness_shared.pot_placements RENAME COLUMN bee_owner_id TO cup_owner_id;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_fail_count_not_null TO pot_placements_fail_count_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_infra_loss_count_not_null TO pot_placements_infra_loss_count_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_install_slug_not_null TO pot_placements_install_slug_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_last_seen_at_not_null TO pot_placements_last_seen_at_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_pkey TO pot_placements_pkey;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_placed_at_not_null TO pot_placements_placed_at_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_status_check TO pot_placements_status_check;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_status_not_null TO pot_placements_status_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_updated_at_not_null TO pot_placements_updated_at_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_work_item_id_not_null TO pot_placements_work_item_id_not_null;
    ALTER TABLE harness_shared.pot_placements RENAME CONSTRAINT hive_placements_workspace_id_not_null TO pot_placements_workspace_id_not_null;
    ALTER INDEX harness_shared.hive_placements_open_idx RENAME TO pot_placements_open_idx;
  END IF;
END $$;

-- ── hive_eval_bakeoff_deltas -> pot_eval_bakeoff_deltas ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_eval_bakeoff_deltas') IS NOT NULL AND to_regclass('harness_shared.pot_eval_bakeoff_deltas') IS NULL THEN
    ALTER TABLE harness_shared.hive_eval_bakeoff_deltas RENAME TO pot_eval_bakeoff_deltas;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_created_at_not_null TO pot_eval_bakeoff_deltas_created_at_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_delta_gate_pass_rate_not_null TO pot_eval_bakeoff_deltas_delta_gate_pass_rate_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_delta_mean_composite_not_null TO pot_eval_bakeoff_deltas_delta_mean_composite_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_flag_key_not_null TO pot_eval_bakeoff_deltas_flag_key_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_id_not_null TO pot_eval_bakeoff_deltas_id_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_pkey TO pot_eval_bakeoff_deltas_pkey;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_run_at_ms_not_null TO pot_eval_bakeoff_deltas_run_at_ms_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_verdict_not_null TO pot_eval_bakeoff_deltas_verdict_not_null;
    ALTER TABLE harness_shared.pot_eval_bakeoff_deltas RENAME CONSTRAINT hive_eval_bakeoff_deltas_workspace_id_not_null TO pot_eval_bakeoff_deltas_workspace_id_not_null;
    ALTER INDEX harness_shared.hive_eval_bakeoff_deltas_ws_run_idx RENAME TO pot_eval_bakeoff_deltas_ws_run_idx;
    IF to_regclass('harness_shared.hive_eval_bakeoff_deltas_id_seq') IS NOT NULL THEN
      ALTER SEQUENCE harness_shared.hive_eval_bakeoff_deltas_id_seq RENAME TO pot_eval_bakeoff_deltas_id_seq;
    END IF;
  END IF;
END $$;

-- ── hive_eval_instances -> pot_eval_instances ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_eval_instances') IS NOT NULL AND to_regclass('harness_shared.pot_eval_instances') IS NULL THEN
    ALTER TABLE harness_shared.hive_eval_instances RENAME TO pot_eval_instances;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_code_sha_not_null TO pot_eval_instances_code_sha_not_null;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_created_at_not_null TO pot_eval_instances_created_at_not_null;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_instance_id_not_null TO pot_eval_instances_instance_id_not_null;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_pkey TO pot_eval_instances_pkey;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_workspace_id_code_sha_genome_id_key TO pot_eval_instances_workspace_id_code_sha_genome_id_key;
    ALTER TABLE harness_shared.pot_eval_instances RENAME CONSTRAINT hive_eval_instances_workspace_id_not_null TO pot_eval_instances_workspace_id_not_null;
  END IF;
END $$;

-- ── hive_eval_runs -> pot_eval_runs ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_eval_runs') IS NOT NULL AND to_regclass('harness_shared.pot_eval_runs') IS NULL THEN
    ALTER TABLE harness_shared.hive_eval_runs RENAME TO pot_eval_runs;
    ALTER TABLE harness_shared.pot_eval_runs RENAME COLUMN bee_cap TO cup_cap;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_instance_id_fkey TO pot_eval_runs_instance_id_fkey;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_instance_id_not_null TO pot_eval_runs_instance_id_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_instance_id_scenario_id_repeat_key TO pot_eval_runs_instance_id_scenario_id_repeat_key;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_pkey TO pot_eval_runs_pkey;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_repeat_not_null TO pot_eval_runs_repeat_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_run_id_not_null TO pot_eval_runs_run_id_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_scenario_id_not_null TO pot_eval_runs_scenario_id_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_seed_not_null TO pot_eval_runs_seed_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_shape_not_null TO pot_eval_runs_shape_not_null;
    ALTER TABLE harness_shared.pot_eval_runs RENAME CONSTRAINT hive_eval_runs_started_at_not_null TO pot_eval_runs_started_at_not_null;
    ALTER INDEX harness_shared.hive_eval_runs_instance_idx RENAME TO pot_eval_runs_instance_idx;
    ALTER INDEX harness_shared.hive_eval_runs_scenario_idx RENAME TO pot_eval_runs_scenario_idx;
  END IF;
END $$;

-- ── hive_eval_scenarios -> pot_eval_scenarios ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_eval_scenarios') IS NOT NULL AND to_regclass('harness_shared.pot_eval_scenarios') IS NULL THEN
    ALTER TABLE harness_shared.hive_eval_scenarios RENAME TO pot_eval_scenarios;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME COLUMN ideal_bee_count TO ideal_cup_count;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_created_at_not_null TO pot_eval_scenarios_created_at_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_critical_path_not_null TO pot_eval_scenarios_critical_path_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_ideal_bee_count_not_null TO pot_eval_scenarios_ideal_cup_count_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_ideal_wall_clock_units_not_null TO pot_eval_scenarios_ideal_wall_clock_units_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_pkey TO pot_eval_scenarios_pkey;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_scenario_id_not_null TO pot_eval_scenarios_scenario_id_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_shape_not_null TO pot_eval_scenarios_shape_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_title_not_null TO pot_eval_scenarios_title_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_total_units_not_null TO pot_eval_scenarios_total_units_not_null;
    ALTER TABLE harness_shared.pot_eval_scenarios RENAME CONSTRAINT hive_eval_scenarios_work_item_count_not_null TO pot_eval_scenarios_work_item_count_not_null;
  END IF;
END $$;

-- ── hive_eval_scores -> pot_eval_scores ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_eval_scores') IS NOT NULL AND to_regclass('harness_shared.pot_eval_scores') IS NULL THEN
    ALTER TABLE harness_shared.hive_eval_scores RENAME TO pot_eval_scores;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_composite_not_null TO pot_eval_scores_composite_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_critical_path_ratio_not_null TO pot_eval_scores_critical_path_ratio_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_detail_not_null TO pot_eval_scores_detail_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_efficiency_score_not_null TO pot_eval_scores_efficiency_score_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_fabrication_detected_not_null TO pot_eval_scores_fabrication_detected_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_floor_ceiling_not_null TO pot_eval_scores_floor_ceiling_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_outcome_gate_passed_not_null TO pot_eval_scores_outcome_gate_passed_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_pkey TO pot_eval_scores_pkey;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_planted_bug_caught_not_null TO pot_eval_scores_planted_bug_caught_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_regressions_not_null TO pot_eval_scores_regressions_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_rubric_hash_not_null TO pot_eval_scores_rubric_hash_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_rubric_version_not_null TO pot_eval_scores_rubric_version_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_run_id_fkey TO pot_eval_scores_run_id_fkey;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_run_id_not_null TO pot_eval_scores_run_id_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_scored_at_not_null TO pot_eval_scores_scored_at_not_null;
    ALTER TABLE harness_shared.pot_eval_scores RENAME CONSTRAINT hive_eval_scores_speed_score_not_null TO pot_eval_scores_speed_score_not_null;
    ALTER INDEX harness_shared.hive_eval_scores_composite_idx RENAME TO pot_eval_scores_composite_idx;
    ALTER INDEX harness_shared.hive_eval_scores_run_idx RENAME TO pot_eval_scores_run_idx;
  END IF;
END $$;

-- ── hive_wake -> pot_wake ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_wake') IS NOT NULL AND to_regclass('harness_shared.pot_wake') IS NULL THEN
    ALTER TABLE harness_shared.hive_wake RENAME TO pot_wake;
  END IF;
END $$;

-- ── hive_watchdog_fires -> pot_watchdog_fires ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_watchdog_fires') IS NOT NULL AND to_regclass('harness_shared.pot_watchdog_fires') IS NULL THEN
    ALTER TABLE harness_shared.hive_watchdog_fires RENAME TO pot_watchdog_fires;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_demand_not_null TO pot_watchdog_fires_demand_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_fired_at_not_null TO pot_watchdog_fires_fired_at_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_id_not_null TO pot_watchdog_fires_id_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_install_slug_not_null TO pot_watchdog_fires_install_slug_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_pkey TO pot_watchdog_fires_pkey;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_reason_not_null TO pot_watchdog_fires_reason_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_source_not_null TO pot_watchdog_fires_source_not_null;
    ALTER TABLE harness_shared.pot_watchdog_fires RENAME CONSTRAINT hive_watchdog_fires_workspace_id_not_null TO pot_watchdog_fires_workspace_id_not_null;
    ALTER INDEX harness_shared.hive_watchdog_fires_ws_install_fired_idx RENAME TO pot_watchdog_fires_ws_install_fired_idx;
  END IF;
END $$;

-- ── hive_throughput_ticks -> pot_throughput_ticks ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_throughput_ticks') IS NOT NULL AND to_regclass('harness_shared.pot_throughput_ticks') IS NULL THEN
    ALTER TABLE harness_shared.hive_throughput_ticks RENAME TO pot_throughput_ticks;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME COLUMN bees_busy TO cups_busy;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME COLUMN bees_cap TO cups_cap;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_bees_busy_not_null TO pot_throughput_ticks_cups_busy_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_bees_cap_not_null TO pot_throughput_ticks_cups_cap_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_completed_not_null TO pot_throughput_ticks_completed_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_frontier_depth_not_null TO pot_throughput_ticks_frontier_depth_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_id_not_null TO pot_throughput_ticks_id_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_pkey TO pot_throughput_ticks_pkey;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_placements_not_null TO pot_throughput_ticks_placements_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_pot_slug_not_null TO pot_throughput_ticks_pot_slug_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_question_rungs_not_null TO pot_throughput_ticks_question_rungs_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_stuck_count_not_null TO pot_throughput_ticks_stuck_count_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_tick_at_not_null TO pot_throughput_ticks_tick_at_not_null;
    ALTER TABLE harness_shared.pot_throughput_ticks RENAME CONSTRAINT hive_throughput_ticks_workspace_id_not_null TO pot_throughput_ticks_workspace_id_not_null;
    ALTER INDEX harness_shared.hive_throughput_ticks_ws_pot_tick_idx RENAME TO pot_throughput_ticks_ws_pot_tick_idx;
  END IF;
END $$;

-- ── operator_hive_control_policy -> operator_pot_control_policy ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.operator_hive_control_policy') IS NOT NULL AND to_regclass('harness_shared.operator_pot_control_policy') IS NULL THEN
    ALTER TABLE harness_shared.operator_hive_control_policy RENAME TO operator_pot_control_policy;
    ALTER TABLE harness_shared.operator_pot_control_policy RENAME CONSTRAINT operator_hive_control_policy_payload_not_null TO operator_pot_control_policy_payload_not_null;
    ALTER TABLE harness_shared.operator_pot_control_policy RENAME CONSTRAINT operator_hive_control_policy_pkey TO operator_pot_control_policy_pkey;
    ALTER TABLE harness_shared.operator_pot_control_policy RENAME CONSTRAINT operator_hive_control_policy_updated_at_not_null TO operator_pot_control_policy_updated_at_not_null;
    ALTER TABLE harness_shared.operator_pot_control_policy RENAME CONSTRAINT operator_hive_control_policy_workspace_id_not_null TO operator_pot_control_policy_workspace_id_not_null;
  END IF;
END $$;

-- ── hive_integration_requests -> pot_integration_requests ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_integration_requests') IS NOT NULL AND to_regclass('harness_shared.pot_integration_requests') IS NULL THEN
    ALTER TABLE harness_shared.hive_integration_requests RENAME TO pot_integration_requests;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_created_ts_not_null TO pot_integration_requests_created_ts_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_device_pubkey_not_null TO pot_integration_requests_device_pubkey_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_head_sha_not_null TO pot_integration_requests_head_sha_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_pkey TO pot_integration_requests_pkey;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_pot_slug_not_null TO pot_integration_requests_pot_slug_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_reason_check TO pot_integration_requests_reason_check;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_reason_not_null TO pot_integration_requests_reason_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_repo_key_not_null TO pot_integration_requests_repo_key_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_state_check TO pot_integration_requests_state_check;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_state_not_null TO pot_integration_requests_state_not_null;
    ALTER TABLE harness_shared.pot_integration_requests RENAME CONSTRAINT hive_integration_requests_workspace_id_not_null TO pot_integration_requests_workspace_id_not_null;
    ALTER INDEX harness_shared.hive_integration_requests_author_idx RENAME TO pot_integration_requests_author_idx;
  END IF;
END $$;

-- ── Read-compat views under the OLD names (defense-in-depth for any straggler read path;
--    NOTE: these do NOT support INSERT...ON CONFLICT -- Postgres cannot target a view with
--    ON CONFLICT under any circumstance. Every known write path was updated in this same
--    change; these views are a safety net for reads/plain writes only.)
--    EACH is individually guarded on its NEW base table existing (not just "did the rename
--    block above just run") so this stays safe against a partial-lineage apply -- e.g. a test
--    fixture that applies 554 without first creating the pre-rename table via migration 263
--    etc: the rename DO block above no-ops (guard fails), and an UNGUARDED `CREATE VIEW ... AS
--    SELECT FROM harness_shared.pot_X` would then fail with "relation does not exist" (found
--    live via WI-3465's integration-test verification 2026-07-10 -- leg-d-integration-chain
--    .integration.test.ts applies 554 standalone against a DB that never had hive_placements).
--    Guarding on to_regclass('...pot_X') IS NOT NULL keeps this correct + idempotent in BOTH
--    the full-chain case (view created) and the narrow-fixture case (cleanly skipped). ────

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_placements') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_placements AS SELECT workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id AS queen_owner_id, cup_spawn_id AS bee_spawn_id, cup_owner_id AS bee_owner_id, status, fail_count, last_disposition, escalation_msg_id, placed_at, last_recovery_at, last_seen_at, updated_at, infra_loss_count, last_loss_spawn_id FROM harness_shared.pot_placements;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_placements TO harness_app;
    GRANT SELECT ON harness_shared.hive_placements TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_eval_bakeoff_deltas') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_eval_bakeoff_deltas AS SELECT id, workspace_id, flag_key, delta_mean_composite, delta_gate_pass_rate, verdict, run_at_ms, created_at FROM harness_shared.pot_eval_bakeoff_deltas;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_eval_bakeoff_deltas TO harness_app;
    GRANT SELECT ON harness_shared.hive_eval_bakeoff_deltas TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_eval_instances') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_eval_instances AS SELECT instance_id, workspace_id, code_sha, genome_id, battery_slice_id, created_at FROM harness_shared.pot_eval_instances;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_eval_instances TO harness_app;
    GRANT SELECT ON harness_shared.hive_eval_instances TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_eval_runs') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_eval_runs AS SELECT run_id, instance_id, scenario_id, shape, repeat, seed, budget_usd_cap, cup_cap AS bee_cap, started_at, finished_at, terminal_state, wall_clock_ms, frontier_drained, work_items_total, work_items_completed, cost_usd, observations, trace_ref FROM harness_shared.pot_eval_runs;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_eval_runs TO harness_app;
    GRANT SELECT ON harness_shared.hive_eval_runs TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_eval_scenarios') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_eval_scenarios AS SELECT scenario_id, title, shape, ideal_wall_clock_units, ideal_cup_count AS ideal_bee_count, total_units, critical_path, work_item_count, planted_bug_location, created_at FROM harness_shared.pot_eval_scenarios;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_eval_scenarios TO harness_app;
    GRANT SELECT ON harness_shared.hive_eval_scenarios TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_eval_scores') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_eval_scores AS SELECT run_id, rubric_hash, rubric_version, outcome_gate_passed, efficiency_score, speed_score, composite, judge_composite, regressions, planted_bug_caught, fabrication_detected, critical_path_ratio, floor_ceiling, detail, scored_at FROM harness_shared.pot_eval_scores;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_eval_scores TO harness_app;
    GRANT SELECT ON harness_shared.hive_eval_scores TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_wake') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_wake AS SELECT workspace_id, payload, updated_at FROM harness_shared.pot_wake;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_wake TO harness_app;
    GRANT SELECT ON harness_shared.hive_wake TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_watchdog_fires') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_watchdog_fires AS SELECT id, workspace_id, install_slug, fired_at, source, reason, wake_at, demand FROM harness_shared.pot_watchdog_fires;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_watchdog_fires TO harness_app;
    GRANT SELECT ON harness_shared.hive_watchdog_fires TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_throughput_ticks') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_throughput_ticks AS SELECT id, workspace_id, tick_at, frontier_depth, placements, cups_busy AS bees_busy, cups_cap AS bees_cap, stuck_count, completed, mttc_ms, question_rungs, detail, pot_slug FROM harness_shared.pot_throughput_ticks;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_throughput_ticks TO harness_app;
    GRANT SELECT ON harness_shared.hive_throughput_ticks TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.operator_pot_control_policy') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.operator_hive_control_policy AS SELECT workspace_id, payload, updated_at FROM harness_shared.operator_pot_control_policy;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_hive_control_policy TO harness_app;
    GRANT SELECT ON harness_shared.operator_hive_control_policy TO harness_zero;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('harness_shared.pot_integration_requests') IS NOT NULL THEN
    CREATE OR REPLACE VIEW harness_shared.hive_integration_requests AS SELECT workspace_id, repo_key, device_pubkey, head_sha, author_github_user_id, reason, state, created_ts, ratified_ts, pot_slug FROM harness_shared.pot_integration_requests;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_integration_requests TO harness_app;
    GRANT SELECT ON harness_shared.hive_integration_requests TO harness_zero;
  END IF;
END $$;
