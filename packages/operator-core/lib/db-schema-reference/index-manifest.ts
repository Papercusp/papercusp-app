/**
 * index-manifest.ts — GENERATED. Do not hand-edit.
 *
 * The index census of a database with every `libs/papercusp/libs/db/sql/*.sql`
 * migration applied to it — i.e. exactly the indexes a FRESH INSTALL gets. It is
 * the reference side of `../schema-object-drift.ts`, whose module header
 * explains why this is materialized from a real Postgres rather than parsed out
 * of the migration SQL.
 *
 * Regenerate (and re-pin) with:
 *   PAPERCUSP_UPDATE_INDEX_MANIFEST=1 \
 *     npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts
 *
 * That same test, run WITHOUT the env var, applies the current migrations to a
 * throwaway database and asserts this file still matches them — so the manifest
 * cannot silently drift away from the SQL it claims to describe.
 *
 * An EMPTY `indexes` array is the un-generated state: `checkSchemaObjectDrift()`
 * reports it as UNAVAILABLE rather than as a clean result, because a check that
 * could not run and a check that found nothing are the same zero if you only
 * look at the count.
 */
import type { IndexManifest } from '../schema-object-drift';

export const INDEX_MANIFEST: IndexManifest = {
  "generatedAt": "2026-10-06T07:13:48.742Z",
  "migrationCountAtGeneration": 1179,
  "indexes": [
    {
      "schema": "audit",
      "name": "action_executions_harness_idx",
      "table": "action_executions",
      "definition": "CREATE INDEX action_executions_harness_idx ON audit.action_executions USING btree (harness_slug, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "action_executions_idempotency_key_key",
      "table": "action_executions",
      "definition": "CREATE UNIQUE INDEX action_executions_idempotency_key_key ON audit.action_executions USING btree (idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "audit",
      "name": "action_executions_pending_webhook_idx",
      "table": "action_executions",
      "definition": "CREATE INDEX action_executions_pending_webhook_idx ON audit.action_executions USING btree (id) WHERE ((status = ANY (ARRAY['error'::text, 'timeout'::text])) AND (webhook_emitted_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "action_executions_pkey",
      "table": "action_executions",
      "definition": "CREATE UNIQUE INDEX action_executions_pkey ON audit.action_executions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "audit",
      "name": "action_executions_plugin_action_idx",
      "table": "action_executions",
      "definition": "CREATE INDEX action_executions_plugin_action_idx ON audit.action_executions USING btree (plugin_name, action_name, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "action_executions_status_idx",
      "table": "action_executions",
      "definition": "CREATE INDEX action_executions_status_idx ON audit.action_executions USING btree (status) WHERE (status <> 'ok'::text)",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "operator_actions_action_idx",
      "table": "operator_actions",
      "definition": "CREATE INDEX operator_actions_action_idx ON audit.operator_actions USING btree (action, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "operator_actions_pkey",
      "table": "operator_actions",
      "definition": "CREATE UNIQUE INDEX operator_actions_pkey ON audit.operator_actions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "audit",
      "name": "operator_actions_target_idx",
      "table": "operator_actions",
      "definition": "CREATE INDEX operator_actions_target_idx ON audit.operator_actions USING btree (target, ts DESC) WHERE (target IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "audit",
      "name": "operator_actions_ts_idx",
      "table": "operator_actions",
      "definition": "CREATE INDEX operator_actions_ts_idx ON audit.operator_actions USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_cycles_pkey",
      "table": "gym_cycles",
      "definition": "CREATE UNIQUE INDEX gym_cycles_pkey ON harness_gym_durable.gym_cycles USING btree (workspace_id, harness_slug, cycle_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_cycles_ws_harness_cycle_idx",
      "table": "gym_cycles",
      "definition": "CREATE INDEX gym_durable_cycles_ws_harness_cycle_idx ON harness_gym_durable.gym_cycles USING btree (workspace_id, harness_slug, cycle)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_runs_ws_harness_task_idx",
      "table": "gym_runs",
      "definition": "CREATE INDEX gym_durable_runs_ws_harness_task_idx ON harness_gym_durable.gym_runs USING btree (workspace_id, harness_slug, task_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_runs_ws_harness_variant_idx",
      "table": "gym_runs",
      "definition": "CREATE INDEX gym_durable_runs_ws_harness_variant_idx ON harness_gym_durable.gym_runs USING btree (workspace_id, harness_slug, variant_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_tasks_ws_harness_active_corpus_idx",
      "table": "gym_tasks",
      "definition": "CREATE INDEX gym_durable_tasks_ws_harness_active_corpus_idx ON harness_gym_durable.gym_tasks USING btree (workspace_id, harness_slug, active, corpus)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_tasks_ws_harness_corpus_idx",
      "table": "gym_tasks",
      "definition": "CREATE INDEX gym_durable_tasks_ws_harness_corpus_idx ON harness_gym_durable.gym_tasks USING btree (workspace_id, harness_slug, corpus)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_durable_tasks_ws_harness_pool_idx",
      "table": "gym_tasks",
      "definition": "CREATE INDEX gym_durable_tasks_ws_harness_pool_idx ON harness_gym_durable.gym_tasks USING btree (workspace_id, harness_slug, pool)",
      "constraintBacked": false
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_runs_pkey",
      "table": "gym_runs",
      "definition": "CREATE UNIQUE INDEX gym_runs_pkey ON harness_gym_durable.gym_runs USING btree (workspace_id, harness_slug, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_scores_pkey",
      "table": "gym_scores",
      "definition": "CREATE UNIQUE INDEX gym_scores_pkey ON harness_gym_durable.gym_scores USING btree (workspace_id, harness_slug, run_id, rubric_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_tasks_pkey",
      "table": "gym_tasks",
      "definition": "CREATE UNIQUE INDEX gym_tasks_pkey ON harness_gym_durable.gym_tasks USING btree (workspace_id, harness_slug, task_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_gym_durable",
      "name": "gym_variants_pkey",
      "table": "gym_variants",
      "definition": "CREATE UNIQUE INDEX gym_variants_pkey ON harness_gym_durable.gym_variants USING btree (workspace_id, harness_slug, variant_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "acceptance_adoption_runs_one_apply_per_report",
      "table": "acceptance_adoption_runs",
      "definition": "CREATE UNIQUE INDEX acceptance_adoption_runs_one_apply_per_report ON harness_shared.acceptance_adoption_runs USING btree (report_run_id) WHERE (kind = ANY (ARRAY['cohort-apply'::text, 'cohort-revert'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "acceptance_adoption_runs_pkey",
      "table": "acceptance_adoption_runs",
      "definition": "CREATE UNIQUE INDEX acceptance_adoption_runs_pkey ON harness_shared.acceptance_adoption_runs USING btree (run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "acceptance_adoption_runs_scope_kind_idx",
      "table": "acceptance_adoption_runs",
      "definition": "CREATE INDEX acceptance_adoption_runs_scope_kind_idx ON harness_shared.acceptance_adoption_runs USING btree (workspace_id, harness_slug, kind, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adaptive_telemetry_harness_idx",
      "table": "adaptive_telemetry",
      "definition": "CREATE INDEX adaptive_telemetry_harness_idx ON harness_shared.adaptive_telemetry USING btree (harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adaptive_telemetry_pending_idx",
      "table": "adaptive_telemetry",
      "definition": "CREATE INDEX adaptive_telemetry_pending_idx ON harness_shared.adaptive_telemetry USING btree (harness_slug, feature_id) WHERE (outcome IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adaptive_telemetry_pkey",
      "table": "adaptive_telemetry",
      "definition": "CREATE UNIQUE INDEX adaptive_telemetry_pkey ON harness_shared.adaptive_telemetry USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "adjacency_state_pkey",
      "table": "adjacency_state",
      "definition": "CREATE UNIQUE INDEX adjacency_state_pkey ON harness_shared.adjacency_state USING btree (session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "adjacency_state_updated_idx",
      "table": "adjacency_state",
      "definition": "CREATE INDEX adjacency_state_updated_idx ON harness_shared.adjacency_state USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "admission_rules_pkey",
      "table": "admission_rules",
      "definition": "CREATE UNIQUE INDEX admission_rules_pkey ON harness_shared.admission_rules USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "admission_rules_source_idx",
      "table": "admission_rules",
      "definition": "CREATE INDEX admission_rules_source_idx ON harness_shared.admission_rules USING btree (workspace_id, data_source_id, source_kind) WHERE enabled",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "admission_runs_pkey",
      "table": "admission_runs",
      "definition": "CREATE UNIQUE INDEX admission_runs_pkey ON harness_shared.admission_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "admission_runs_ws_kind_idx",
      "table": "admission_runs",
      "definition": "CREATE INDEX admission_runs_ws_kind_idx ON harness_shared.admission_runs USING btree (workspace_id, harness_slug, run_kind, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "admission_write_backs_lifecycle_idx",
      "table": "admission_write_backs",
      "definition": "CREATE UNIQUE INDEX admission_write_backs_lifecycle_idx ON harness_shared.admission_write_backs USING btree (workspace_id, admission_id, lifecycle_key) WHERE (lifecycle_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "admission_write_backs_pkey",
      "table": "admission_write_backs",
      "definition": "CREATE UNIQUE INDEX admission_write_backs_pkey ON harness_shared.admission_write_backs USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "admission_write_backs_update_idx",
      "table": "admission_write_backs",
      "definition": "CREATE UNIQUE INDEX admission_write_backs_update_idx ON harness_shared.admission_write_backs USING btree (workspace_id, data_source_id, update_id) WHERE (update_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "admission_write_backs_work_item_idx",
      "table": "admission_write_backs",
      "definition": "CREATE INDEX admission_write_backs_work_item_idx ON harness_shared.admission_write_backs USING btree (workspace_id, work_item_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_app_operation_caller_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_app_operation_caller_idx ON harness_shared.adv_sessions USING btree (workspace_id, split_part((((launch_spec -> 'acceptedOperation'::text) -> 'pin'::text) ->> 'callerId'::text), '/'::text, 1)) WHERE (launch_spec ? 'acceptedOperation'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_coord_owner_first_seen_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_coord_owner_first_seen_idx ON harness_shared.adv_sessions USING btree (coord_owner_id, first_seen_at) WHERE (coord_owner_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_coord_owner_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_coord_owner_idx ON harness_shared.adv_sessions USING btree (coord_owner_id) WHERE (coord_owner_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_ended_unarchived_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_ended_unarchived_idx ON harness_shared.adv_sessions USING btree (ended_at) WHERE ((ended_at IS NOT NULL) AND (archived_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_observer_ended_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_observer_ended_idx ON harness_shared.adv_sessions USING btree (ended_at) WHERE ((ended_at IS NOT NULL) AND ((ended_by IS NULL) OR (ended_by <> ALL (ARRAY['self'::text, 'signal'::text]))))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_pending_workbench_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_pending_workbench_idx ON harness_shared.adv_sessions USING btree (workspace_id, started_at DESC) WHERE ((display = 'workbench'::text) AND (launched_at IS NULL) AND (ended_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_pkey",
      "table": "adv_sessions",
      "definition": "CREATE UNIQUE INDEX adv_sessions_pkey ON harness_shared.adv_sessions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_plan_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_plan_idx ON harness_shared.adv_sessions USING btree (plan_slug, started_at DESC) WHERE (plan_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_port_source_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_port_source_idx ON harness_shared.adv_sessions USING btree (port_source_adv_session_id) WHERE (port_source_adv_session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_resume_reservation_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_resume_reservation_idx ON harness_shared.adv_sessions USING btree (resume_claimed_at) WHERE (resume_claim_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_session_id_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_session_id_idx ON harness_shared.adv_sessions USING btree (session_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_shutdown_accepted_owner_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_shutdown_accepted_owner_idx ON harness_shared.adv_sessions USING btree (coord_owner_id, started_at DESC) WHERE ((ended_at IS NULL) AND (shutdown_accepted_at IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_signal_ended_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_signal_ended_idx ON harness_shared.adv_sessions USING btree (ended_at) WHERE (ended_by = 'signal'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_su_active_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_su_active_idx ON harness_shared.adv_sessions USING btree (workspace_id, su_session_state, su_session_updated_at DESC) WHERE ((su_agent_chat_id IS NOT NULL) AND (ended_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_su_agent_chat_idx",
      "table": "adv_sessions",
      "definition": "CREATE UNIQUE INDEX adv_sessions_su_agent_chat_idx ON harness_shared.adv_sessions USING btree (workspace_id, su_agent_chat_id) WHERE (su_agent_chat_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_workspace_active_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_workspace_active_idx ON harness_shared.adv_sessions USING btree (workspace_id, started_at DESC) WHERE (ended_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_workspace_first_seen_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_workspace_first_seen_idx ON harness_shared.adv_sessions USING btree (workspace_id, first_seen_at DESC, id DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "adv_sessions_workspace_recent_idx",
      "table": "adv_sessions",
      "definition": "CREATE INDEX adv_sessions_workspace_recent_idx ON harness_shared.adv_sessions USING btree (workspace_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_actions_agent_ts_idx",
      "table": "agent_actions",
      "definition": "CREATE INDEX agent_actions_agent_ts_idx ON harness_shared.agent_actions USING btree (agent, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_actions_id_ts_idx",
      "table": "agent_actions",
      "definition": "CREATE INDEX agent_actions_id_ts_idx ON harness_shared.agent_actions USING btree (command_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_actions_pkey",
      "table": "agent_actions",
      "definition": "CREATE UNIQUE INDEX agent_actions_pkey ON harness_shared.agent_actions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_actions_ts_idx",
      "table": "agent_actions",
      "definition": "CREATE INDEX agent_actions_ts_idx ON harness_shared.agent_actions USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_created_at_idx",
      "table": "agent_activity",
      "definition": "CREATE INDEX agent_activity_created_at_idx ON harness_shared.agent_activity USING btree (created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_harness_idx",
      "table": "agent_activity",
      "definition": "CREATE INDEX agent_activity_harness_idx ON harness_shared.agent_activity USING btree (harness_slug, id) WHERE (harness_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_owner_id_idx",
      "table": "agent_activity",
      "definition": "CREATE INDEX agent_activity_owner_id_idx ON harness_shared.agent_activity USING btree (owner_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_pkey",
      "table": "agent_activity",
      "definition": "CREATE UNIQUE INDEX agent_activity_pkey ON harness_shared.agent_activity USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_session_id_idx",
      "table": "agent_activity",
      "definition": "CREATE INDEX agent_activity_session_id_idx ON harness_shared.agent_activity USING btree (session_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_activity_workspace_id_idx",
      "table": "agent_activity",
      "definition": "CREATE INDEX agent_activity_workspace_id_idx ON harness_shared.agent_activity USING btree (workspace_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_chat_locks_pkey",
      "table": "agent_chat_locks",
      "definition": "CREATE UNIQUE INDEX agent_chat_locks_pkey ON harness_shared.agent_chat_locks USING btree (chat_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_chats_consolidated_continued_from_idx",
      "table": "agent_chats_consolidated",
      "definition": "CREATE INDEX agent_chats_consolidated_continued_from_idx ON harness_shared.agent_chats_consolidated USING btree (workspace_id, harness_slug, continued_from_chat_id) WHERE (continued_from_chat_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_chats_consolidated_pkey",
      "table": "agent_chats_consolidated",
      "definition": "CREATE UNIQUE INDEX agent_chats_consolidated_pkey ON harness_shared.agent_chats_consolidated USING btree (workspace_id, harness_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_chats_consolidated_recent_idx",
      "table": "agent_chats_consolidated",
      "definition": "CREATE INDEX agent_chats_consolidated_recent_idx ON harness_shared.agent_chats_consolidated USING btree (workspace_id, harness_slug, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_couplings_by_a",
      "table": "agent_couplings",
      "definition": "CREATE INDEX agent_couplings_by_a ON harness_shared.agent_couplings USING btree (workspace_id, agent_a, expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_couplings_by_b",
      "table": "agent_couplings",
      "definition": "CREATE INDEX agent_couplings_by_b ON harness_shared.agent_couplings USING btree (workspace_id, agent_b, expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_couplings_pkey",
      "table": "agent_couplings",
      "definition": "CREATE UNIQUE INDEX agent_couplings_pkey ON harness_shared.agent_couplings USING btree (workspace_id, agent_a, agent_b)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_display_names_pkey",
      "table": "agent_display_names",
      "definition": "CREATE UNIQUE INDEX agent_display_names_pkey ON harness_shared.agent_display_names USING btree (workspace_id, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_fold",
      "table": "agent_facts",
      "definition": "CREATE INDEX agent_facts_fold ON harness_shared.agent_facts USING btree (workspace_id, scope, scope_ref, expires_at) WHERE ((retracted_at IS NULL) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_identity_current",
      "table": "agent_facts",
      "definition": "CREATE UNIQUE INDEX agent_facts_identity_current ON harness_shared.agent_facts USING btree (workspace_id, scope, COALESCE(scope_ref, ''::text), key, COALESCE(source_hive, ''::text)) WHERE (superseded_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_kind",
      "table": "agent_facts",
      "definition": "CREATE INDEX agent_facts_kind ON harness_shared.agent_facts USING btree (workspace_id, kind, scope, scope_ref) WHERE ((kind IS NOT NULL) AND (retracted_at IS NULL) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_pkey",
      "table": "agent_facts",
      "definition": "CREATE UNIQUE INDEX agent_facts_pkey ON harness_shared.agent_facts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_recheck_exec",
      "table": "agent_facts",
      "definition": "CREATE INDEX agent_facts_recheck_exec ON harness_shared.agent_facts USING btree (workspace_id) WHERE ((recheck ? 'exec'::text) AND (retracted_at IS NULL) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_shareable",
      "table": "agent_facts",
      "definition": "CREATE INDEX agent_facts_shareable ON harness_shared.agent_facts USING btree (workspace_id, scope, expires_at) WHERE ((shareable = true) AND (retracted_at IS NULL) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_facts_version_chain",
      "table": "agent_facts",
      "definition": "CREATE INDEX agent_facts_version_chain ON harness_shared.agent_facts USING btree (workspace_id, scope, COALESCE(scope_ref, ''::text), key, superseded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_fleets_pkey",
      "table": "agent_fleets",
      "definition": "CREATE UNIQUE INDEX agent_fleets_pkey ON harness_shared.agent_fleets USING btree (workspace_id, fleet_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_launch_idempotency_launched_at_idx",
      "table": "agent_launch_idempotency",
      "definition": "CREATE INDEX agent_launch_idempotency_launched_at_idx ON harness_shared.agent_launch_idempotency USING btree (launched_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_launch_idempotency_pkey",
      "table": "agent_launch_idempotency",
      "definition": "CREATE UNIQUE INDEX agent_launch_idempotency_pkey ON harness_shared.agent_launch_idempotency USING btree (workspace_id, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_loop_approvals_pkey",
      "table": "agent_loop_approvals",
      "definition": "CREATE UNIQUE INDEX agent_loop_approvals_pkey ON harness_shared.agent_loop_approvals USING btree (chat_id, call_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_loop_sessions_pkey",
      "table": "agent_loop_sessions",
      "definition": "CREATE UNIQUE INDEX agent_loop_sessions_pkey ON harness_shared.agent_loop_sessions USING btree (workspace_id, chat_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_mode_changes_goal_epoch_idx",
      "table": "agent_mode_changes",
      "definition": "CREATE INDEX agent_mode_changes_goal_epoch_idx ON harness_shared.agent_mode_changes USING btree (workspace_id, subject, goal_lease_epoch DESC) WHERE (goal_lease_epoch IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_mode_changes_owner_idx",
      "table": "agent_mode_changes",
      "definition": "CREATE INDEX agent_mode_changes_owner_idx ON harness_shared.agent_mode_changes USING btree (workspace_id, owner_id, changed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_mode_changes_pkey",
      "table": "agent_mode_changes",
      "definition": "CREATE UNIQUE INDEX agent_mode_changes_pkey ON harness_shared.agent_mode_changes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_modes_goal_election_idx",
      "table": "agent_modes",
      "definition": "CREATE INDEX agent_modes_goal_election_idx ON harness_shared.agent_modes USING btree (workspace_id, subject, goal_lease_epoch DESC) WHERE ((mode = 'goal'::text) AND (subject IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_modes_owner_idx",
      "table": "agent_modes",
      "definition": "CREATE INDEX agent_modes_owner_idx ON harness_shared.agent_modes USING btree (owner_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_modes_pkey",
      "table": "agent_modes",
      "definition": "CREATE UNIQUE INDEX agent_modes_pkey ON harness_shared.agent_modes USING btree (workspace_id, owner_id, axis_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_name_sessions_name_idx",
      "table": "agent_name_sessions",
      "definition": "CREATE INDEX agent_name_sessions_name_idx ON harness_shared.agent_name_sessions USING btree (workspace_id, agent_name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_name_sessions_pkey",
      "table": "agent_name_sessions",
      "definition": "CREATE UNIQUE INDEX agent_name_sessions_pkey ON harness_shared.agent_name_sessions USING btree (workspace_id, session_owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_names_owner_idx",
      "table": "agent_names",
      "definition": "CREATE INDEX agent_names_owner_idx ON harness_shared.agent_names USING btree (workspace_id, owner_user)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_names_pkey",
      "table": "agent_names",
      "definition": "CREATE UNIQUE INDEX agent_names_pkey ON harness_shared.agent_names USING btree (workspace_id, agent_name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_plane_measurements_pkey",
      "table": "agent_plane_measurements",
      "definition": "CREATE UNIQUE INDEX agent_plane_measurements_pkey ON harness_shared.agent_plane_measurements USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_plane_measurements_series_idx",
      "table": "agent_plane_measurements",
      "definition": "CREATE INDEX agent_plane_measurements_series_idx ON harness_shared.agent_plane_measurements USING btree (workspace_id, harness_slug, measured_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_queries_agent_id_ts",
      "table": "agent_queries",
      "definition": "CREATE INDEX agent_queries_agent_id_ts ON harness_shared.agent_queries USING btree (agent, query_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_queries_pkey",
      "table": "agent_queries",
      "definition": "CREATE UNIQUE INDEX agent_queries_pkey ON harness_shared.agent_queries USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_queries_ts_idx",
      "table": "agent_queries",
      "definition": "CREATE INDEX agent_queries_ts_idx ON harness_shared.agent_queries USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_rate_budget_pkey",
      "table": "agent_rate_budget",
      "definition": "CREATE UNIQUE INDEX agent_rate_budget_pkey ON harness_shared.agent_rate_budget USING btree (bucket_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_runs_consolidated_pkey",
      "table": "agent_runs_consolidated",
      "definition": "CREATE UNIQUE INDEX agent_runs_consolidated_pkey ON harness_shared.agent_runs_consolidated USING btree (harness_slug, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_seat_consumptions_fleet_idx",
      "table": "agent_seat_consumptions",
      "definition": "CREATE INDEX agent_seat_consumptions_fleet_idx ON harness_shared.agent_seat_consumptions USING btree (workspace_id, fleet_slug, seat_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_seat_consumptions_pkey",
      "table": "agent_seat_consumptions",
      "definition": "CREATE UNIQUE INDEX agent_seat_consumptions_pkey ON harness_shared.agent_seat_consumptions USING btree (owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_harness_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_harness_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, harness_slug, ts DESC) WHERE (harness_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_pkey",
      "table": "agent_usage_samples",
      "definition": "CREATE UNIQUE INDEX agent_usage_samples_pkey ON harness_shared.agent_usage_samples USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_price_version_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_price_version_idx ON harness_shared.agent_usage_samples USING btree (price_table_version, id) WHERE (cost_source IS DISTINCT FROM 'provider'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_account_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_account_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, account_id, ts DESC) WHERE (account_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_bucket_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_bucket_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, bucket_key, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_event_key_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE UNIQUE INDEX agent_usage_samples_ws_event_key_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, usage_event_key) WHERE (usage_event_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_goal_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_goal_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, goal_id, ts DESC) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_role_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_role_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, role, ts DESC) WHERE (role IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_session_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_session_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, session_id, ts DESC) WHERE (session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_trigger_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_trigger_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, turn_trigger, ts DESC) WHERE (turn_trigger IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "agent_usage_samples_ws_ts_idx",
      "table": "agent_usage_samples",
      "definition": "CREATE INDEX agent_usage_samples_ws_ts_idx ON harness_shared.agent_usage_samples USING btree (workspace_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "app_owner_mappings_owner_unique",
      "table": "app_owner_mappings",
      "definition": "CREATE UNIQUE INDEX app_owner_mappings_owner_unique ON harness_shared.app_owner_mappings USING btree (workspace_id, app, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "app_owner_mappings_pkey",
      "table": "app_owner_mappings",
      "definition": "CREATE UNIQUE INDEX app_owner_mappings_pkey ON harness_shared.app_owner_mappings USING btree (workspace_id, user_id, app)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "arc_feature_idx",
      "table": "agent_runs_consolidated",
      "definition": "CREATE INDEX arc_feature_idx ON harness_shared.agent_runs_consolidated USING btree (harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "arc_role_idx",
      "table": "agent_runs_consolidated",
      "definition": "CREATE INDEX arc_role_idx ON harness_shared.agent_runs_consolidated USING btree (harness_slug, role)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "arc_running_idx",
      "table": "agent_runs_consolidated",
      "definition": "CREATE INDEX arc_running_idx ON harness_shared.agent_runs_consolidated USING btree (harness_slug, running) WHERE (running = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "arc_ts_idx",
      "table": "agent_runs_consolidated",
      "definition": "CREATE INDEX arc_ts_idx ON harness_shared.agent_runs_consolidated USING btree (harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "arc_workspace_ts_idx",
      "table": "agent_runs_consolidated",
      "definition": "CREATE INDEX arc_workspace_ts_idx ON harness_shared.agent_runs_consolidated USING btree (workspace_id, harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_run_items_disposition_idx",
      "table": "attention_bulk_run_items",
      "definition": "CREATE INDEX attention_bulk_run_items_disposition_idx ON harness_shared.attention_bulk_run_items USING btree (workspace_id, run_id, disposition)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_run_items_item_idx",
      "table": "attention_bulk_run_items",
      "definition": "CREATE INDEX attention_bulk_run_items_item_idx ON harness_shared.attention_bulk_run_items USING btree (workspace_id, item_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_run_items_open_reversal_idx",
      "table": "attention_bulk_run_items",
      "definition": "CREATE INDEX attention_bulk_run_items_open_reversal_idx ON harness_shared.attention_bulk_run_items USING btree (workspace_id, reversal_window_until, run_id, \"position\") WHERE ((outcome = 'auto_resolved'::text) AND (reverted_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_run_items_pkey",
      "table": "attention_bulk_run_items",
      "definition": "CREATE UNIQUE INDEX attention_bulk_run_items_pkey ON harness_shared.attention_bulk_run_items USING btree (workspace_id, run_id, item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_run_items_run_idx",
      "table": "attention_bulk_run_items",
      "definition": "CREATE INDEX attention_bulk_run_items_run_idx ON harness_shared.attention_bulk_run_items USING btree (workspace_id, run_id, \"position\")",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_runs_active_idx",
      "table": "attention_bulk_runs",
      "definition": "CREATE INDEX attention_bulk_runs_active_idx ON harness_shared.attention_bulk_runs USING btree (workspace_id, phase) WHERE (phase = ANY (ARRAY['pending'::text, 'running'::text, 'review'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_runs_executing_heartbeat_idx",
      "table": "attention_bulk_runs",
      "definition": "CREATE INDEX attention_bulk_runs_executing_heartbeat_idx ON harness_shared.attention_bulk_runs USING btree (heartbeat_at) WHERE (phase = ANY (ARRAY['pending'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_runs_one_active_per_workspace_kind",
      "table": "attention_bulk_runs",
      "definition": "CREATE UNIQUE INDEX attention_bulk_runs_one_active_per_workspace_kind ON harness_shared.attention_bulk_runs USING btree (workspace_id, run_kind) WHERE (phase = ANY (ARRAY['pending'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_runs_pkey",
      "table": "attention_bulk_runs",
      "definition": "CREATE UNIQUE INDEX attention_bulk_runs_pkey ON harness_shared.attention_bulk_runs USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "attention_bulk_runs_recent_idx",
      "table": "attention_bulk_runs",
      "definition": "CREATE INDEX attention_bulk_runs_recent_idx ON harness_shared.attention_bulk_runs USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_notifications_kind_idx",
      "table": "attention_notifications",
      "definition": "CREATE INDEX attention_notifications_kind_idx ON harness_shared.attention_notifications USING btree (kind, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_notifications_pkey",
      "table": "attention_notifications",
      "definition": "CREATE UNIQUE INDEX attention_notifications_pkey ON harness_shared.attention_notifications USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "attention_notifications_workspace_created_idx",
      "table": "attention_notifications",
      "definition": "CREATE INDEX attention_notifications_workspace_created_idx ON harness_shared.attention_notifications USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "attention_triage_pkey",
      "table": "attention_triage",
      "definition": "CREATE UNIQUE INDEX attention_triage_pkey ON harness_shared.attention_triage USING btree (workspace_id, item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "audit_action_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_action_idx ON harness_shared.audit_log USING btree (action)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "audit_actor_action_ts_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_actor_action_ts_idx ON harness_shared.audit_log USING btree (actor, action, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "audit_log_pkey",
      "table": "audit_log",
      "definition": "CREATE UNIQUE INDEX audit_log_pkey ON harness_shared.audit_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "audit_search_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_search_idx ON harness_shared.audit_log USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "audit_subject_ts_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_subject_ts_idx ON harness_shared.audit_log USING btree (subject, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "audit_ts_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_ts_idx ON harness_shared.audit_log USING btree (ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "audit_workspace_idx",
      "table": "audit_log",
      "definition": "CREATE INDEX audit_workspace_idx ON harness_shared.audit_log USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "auth_audit_log_pkey",
      "table": "auth_audit_log",
      "definition": "CREATE UNIQUE INDEX auth_audit_log_pkey ON harness_shared.auth_audit_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "auth_audit_log_ts_idx",
      "table": "auth_audit_log",
      "definition": "CREATE INDEX auth_audit_log_ts_idx ON harness_shared.auth_audit_log USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "auth_audit_log_username_idx",
      "table": "auth_audit_log",
      "definition": "CREATE INDEX auth_audit_log_username_idx ON harness_shared.auth_audit_log USING btree (username, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "auth_rate_limit_pkey",
      "table": "auth_rate_limit",
      "definition": "CREATE UNIQUE INDEX auth_rate_limit_pkey ON harness_shared.auth_rate_limit USING btree (key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "auth_rate_limit_updated_at_idx",
      "table": "auth_rate_limit",
      "definition": "CREATE INDEX auth_rate_limit_updated_at_idx ON harness_shared.auth_rate_limit USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "auto_review_audit_pkey",
      "table": "auto_review_audit",
      "definition": "CREATE UNIQUE INDEX auto_review_audit_pkey ON harness_shared.auto_review_audit USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "auto_review_audit_pr_idx",
      "table": "auto_review_audit",
      "definition": "CREATE INDEX auto_review_audit_pr_idx ON harness_shared.auto_review_audit USING btree (workspace_id, harness_slug, pr_number, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "autoloop_state_owner_role_uidx",
      "table": "autoloop_state",
      "definition": "CREATE UNIQUE INDEX autoloop_state_owner_role_uidx ON harness_shared.autoloop_state USING btree (role) WHERE (role ~~ 'loop-su-%'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "autoloop_state_pkey",
      "table": "autoloop_state",
      "definition": "CREATE UNIQUE INDEX autoloop_state_pkey ON harness_shared.autoloop_state USING btree (workspace_id, harness_slug, role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "autonomy_policy_pkey",
      "table": "autonomy_policy",
      "definition": "CREATE UNIQUE INDEX autonomy_policy_pkey ON harness_shared.autonomy_policy USING btree (workspace_id, category)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "autonomy_tripwires_class_idx",
      "table": "autonomy_tripwires",
      "definition": "CREATE INDEX autonomy_tripwires_class_idx ON harness_shared.autonomy_tripwires USING btree (workspace_id, category, finding_class, armed_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "autonomy_tripwires_decision_id_idx",
      "table": "autonomy_tripwires",
      "definition": "CREATE INDEX autonomy_tripwires_decision_id_idx ON harness_shared.autonomy_tripwires USING btree (workspace_id, decision_id) WHERE (decision_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "autonomy_tripwires_pkey",
      "table": "autonomy_tripwires",
      "definition": "CREATE UNIQUE INDEX autonomy_tripwires_pkey ON harness_shared.autonomy_tripwires USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "autonomy_tripwires_sweep_idx",
      "table": "autonomy_tripwires",
      "definition": "CREATE INDEX autonomy_tripwires_sweep_idx ON harness_shared.autonomy_tripwires USING btree (workspace_id, status, window_until)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "backup_events_pkey",
      "table": "backup_events",
      "definition": "CREATE UNIQUE INDEX backup_events_pkey ON harness_shared.backup_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "backup_events_workspace_idx",
      "table": "backup_events",
      "definition": "CREATE INDEX backup_events_workspace_idx ON harness_shared.backup_events USING btree (workspace_id, at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "backup_snapshots_pkey",
      "table": "backup_snapshots",
      "definition": "CREATE UNIQUE INDEX backup_snapshots_pkey ON harness_shared.backup_snapshots USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "backup_snapshots_workspace_idx",
      "table": "backup_snapshots",
      "definition": "CREATE INDEX backup_snapshots_workspace_idx ON harness_shared.backup_snapshots USING btree (workspace_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260813_physical_twin_links_uq",
      "table": "bak_20260813_physical_twin_links",
      "definition": "CREATE UNIQUE INDEX bak_20260813_physical_twin_links_uq ON harness_shared.bak_20260813_physical_twin_links USING btree (id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260813_physical_twin_threads_uq",
      "table": "bak_20260813_physical_twin_threads",
      "definition": "CREATE UNIQUE INDEX bak_20260813_physical_twin_threads_uq ON harness_shared.bak_20260813_physical_twin_threads USING btree (workspace_id, thread_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260813_work_item_physical_twins_uq",
      "table": "bak_20260813_work_item_physical_twins",
      "definition": "CREATE UNIQUE INDEX bak_20260813_work_item_physical_twins_uq ON harness_shared.bak_20260813_work_item_physical_twins USING btree (harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260820_legacy_replay_twin_manifest_pkey",
      "table": "bak_20260820_legacy_replay_twin_manifest",
      "definition": "CREATE UNIQUE INDEX bak_20260820_legacy_replay_twin_manifest_pkey ON harness_shared.bak_20260820_legacy_replay_twin_manifest USING btree (workspace_id, source_harness, old_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260820_work_item_legacy_replay_twins_uq",
      "table": "bak_20260820_work_item_legacy_replay_twins",
      "definition": "CREATE UNIQUE INDEX bak_20260820_work_item_legacy_replay_twins_uq ON harness_shared.bak_20260820_work_item_legacy_replay_twins USING btree (harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_legacy_human_park_manifest_pkey",
      "table": "bak_20260821_legacy_human_park_manifest",
      "definition": "CREATE UNIQUE INDEX bak_20260821_legacy_human_park_manifest_pkey ON harness_shared.bak_20260821_legacy_human_park_manifest USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_legacy_human_park_status_repair_868_uq",
      "table": "bak_20260821_legacy_human_park_status_repair_868",
      "definition": "CREATE UNIQUE INDEX bak_20260821_legacy_human_park_status_repair_868_uq ON harness_shared.bak_20260821_legacy_human_park_status_repair_868 USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_legacy_human_parks_uq",
      "table": "bak_20260821_legacy_human_parks",
      "definition": "CREATE UNIQUE INDEX bak_20260821_legacy_human_parks_uq ON harness_shared.bak_20260821_legacy_human_parks USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_legacy_human_recurrence_867_uq",
      "table": "bak_20260821_legacy_human_recurrence_867",
      "definition": "CREATE UNIQUE INDEX bak_20260821_legacy_human_recurrence_867_uq ON harness_shared.bak_20260821_legacy_human_recurrence_867 USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_legacy_human_recurrence_870_uq",
      "table": "bak_20260821_legacy_human_recurrence_870",
      "definition": "CREATE UNIQUE INDEX bak_20260821_legacy_human_recurrence_870_uq ON harness_shared.bak_20260821_legacy_human_recurrence_870 USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_watchdog_identity_repairs_pkey",
      "table": "bak_20260821_watchdog_identity_repairs",
      "definition": "CREATE UNIQUE INDEX bak_20260821_watchdog_identity_repairs_pkey ON harness_shared.bak_20260821_watchdog_identity_repairs USING btree (workspace_id, harness_slug, watchdog_key, signal_origin, lane, loser_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260821_work_items_watchdog_identity_uq",
      "table": "bak_20260821_work_items_watchdog_identity",
      "definition": "CREATE UNIQUE INDEX bak_20260821_work_items_watchdog_identity_uq ON harness_shared.bak_20260821_work_items_watchdog_identity USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260825_legacy_needs_human_recurrence_950_uq",
      "table": "bak_20260825_legacy_needs_human_recurrence_950",
      "definition": "CREATE UNIQUE INDEX bak_20260825_legacy_needs_human_recurrence_950_uq ON harness_shared.bak_20260825_legacy_needs_human_recurrence_950 USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260828_legacy_needs_human_cross_harness_1020_uq",
      "table": "bak_20260828_legacy_needs_human_cross_harness_1020",
      "definition": "CREATE UNIQUE INDEX bak_20260828_legacy_needs_human_cross_harness_1020_uq ON harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020 USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260914_keyless_title_identity_repairs_pkey",
      "table": "bak_20260914_keyless_title_identity_repairs",
      "definition": "CREATE UNIQUE INDEX bak_20260914_keyless_title_identity_repairs_pkey ON harness_shared.bak_20260914_keyless_title_identity_repairs USING btree (workspace_id, harness_slug, title_key, loser_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bak_20260914_work_items_keyless_title_identity_uq",
      "table": "bak_20260914_work_items_keyless_title_identity",
      "definition": "CREATE UNIQUE INDEX bak_20260914_work_items_keyless_title_identity_uq ON harness_shared.bak_20260914_work_items_keyless_title_identity USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitution_fires_pkey",
      "table": "bash_tool_substitution_fires",
      "definition": "CREATE UNIQUE INDEX bash_tool_substitution_fires_pkey ON harness_shared.bash_tool_substitution_fires USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitution_fires_row_idx",
      "table": "bash_tool_substitution_fires",
      "definition": "CREATE INDEX bash_tool_substitution_fires_row_idx ON harness_shared.bash_tool_substitution_fires USING btree (workspace_id, row_id, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitution_fires_unresolved_idx",
      "table": "bash_tool_substitution_fires",
      "definition": "CREATE INDEX bash_tool_substitution_fires_unresolved_idx ON harness_shared.bash_tool_substitution_fires USING btree (workspace_id, fired_at) WHERE (resolved_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitutions_active_idx",
      "table": "bash_tool_substitutions",
      "definition": "CREATE INDEX bash_tool_substitutions_active_idx ON harness_shared.bash_tool_substitutions USING btree (workspace_id, enabled, tier) WHERE enabled",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitutions_pkey",
      "table": "bash_tool_substitutions",
      "definition": "CREATE UNIQUE INDEX bash_tool_substitutions_pkey ON harness_shared.bash_tool_substitutions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bash_tool_substitutions_ws_intent_idx",
      "table": "bash_tool_substitutions",
      "definition": "CREATE UNIQUE INDEX bash_tool_substitutions_ws_intent_idx ON harness_shared.bash_tool_substitutions USING btree (workspace_id, intent_label)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "beekeeper_instances_gen0_unique",
      "table": "cup_keeper_instances",
      "definition": "CREATE UNIQUE INDEX beekeeper_instances_gen0_unique ON harness_shared.cup_keeper_instances USING btree (workspace_id, code_sha) WHERE (genome_id IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "behavior_change_ledger_dedupe_idx",
      "table": "behavior_change_ledger",
      "definition": "CREATE UNIQUE INDEX behavior_change_ledger_dedupe_idx ON harness_shared.behavior_change_ledger USING btree (workspace_id, source, diff_ref, target)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "behavior_change_ledger_pkey",
      "table": "behavior_change_ledger",
      "definition": "CREATE UNIQUE INDEX behavior_change_ledger_pkey ON harness_shared.behavior_change_ledger USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "behavior_change_ledger_ws_class_idx",
      "table": "behavior_change_ledger",
      "definition": "CREATE INDEX behavior_change_ledger_ws_class_idx ON harness_shared.behavior_change_ledger USING btree (workspace_id, mutation_class, recorded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "behavior_change_ledger_ws_recorded_idx",
      "table": "behavior_change_ledger",
      "definition": "CREATE INDEX behavior_change_ledger_ws_recorded_idx ON harness_shared.behavior_change_ledger USING btree (workspace_id, recorded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bench_run_events_pkey",
      "table": "bench_run_events",
      "definition": "CREATE UNIQUE INDEX bench_run_events_pkey ON harness_shared.bench_run_events USING btree (event_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bench_run_events_ws_run_seq_idx",
      "table": "bench_run_events",
      "definition": "CREATE INDEX bench_run_events_ws_run_seq_idx ON harness_shared.bench_run_events USING btree (workspace_id, run_id, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bench_run_tasks_pkey",
      "table": "bench_run_tasks",
      "definition": "CREATE UNIQUE INDEX bench_run_tasks_pkey ON harness_shared.bench_run_tasks USING btree (run_id, instance_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bench_run_tasks_ws_run_idx",
      "table": "bench_run_tasks",
      "definition": "CREATE INDEX bench_run_tasks_ws_run_idx ON harness_shared.bench_run_tasks USING btree (workspace_id, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bench_runs_pkey",
      "table": "bench_runs",
      "definition": "CREATE UNIQUE INDEX bench_runs_pkey ON harness_shared.bench_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "bench_runs_ws_arm_taskset_idx",
      "table": "bench_runs",
      "definition": "CREATE INDEX bench_runs_ws_arm_taskset_idx ON harness_shared.bench_runs USING btree (workspace_id, arm, task_set_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bench_runs_ws_created_idx",
      "table": "bench_runs",
      "definition": "CREATE INDEX bench_runs_ws_created_idx ON harness_shared.bench_runs USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "bench_runs_ws_status_idx",
      "table": "bench_runs",
      "definition": "CREATE INDEX bench_runs_ws_status_idx ON harness_shared.bench_runs USING btree (workspace_id, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_coord_event_pkey",
      "table": "benchmark_coord_event",
      "definition": "CREATE UNIQUE INDEX benchmark_coord_event_pkey ON harness_shared.benchmark_coord_event USING btree (event_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_coord_event_run_seq_idx",
      "table": "benchmark_coord_event",
      "definition": "CREATE INDEX benchmark_coord_event_run_seq_idx ON harness_shared.benchmark_coord_event USING btree (workspace_id, fleet_run_id, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_fleet_run_pkey",
      "table": "benchmark_fleet_run",
      "definition": "CREATE UNIQUE INDEX benchmark_fleet_run_pkey ON harness_shared.benchmark_fleet_run USING btree (fleet_run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_fleet_run_workspace_id_run_id_backlog_id_arm_seed_key",
      "table": "benchmark_fleet_run",
      "definition": "CREATE UNIQUE INDEX benchmark_fleet_run_workspace_id_run_id_backlog_id_arm_seed_key ON harness_shared.benchmark_fleet_run USING btree (workspace_id, run_id, backlog_id, arm, seed)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_fleet_run_ws_run_idx",
      "table": "benchmark_fleet_run",
      "definition": "CREATE INDEX benchmark_fleet_run_ws_run_idx ON harness_shared.benchmark_fleet_run USING btree (workspace_id, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_prereg_pkey",
      "table": "benchmark_prereg",
      "definition": "CREATE UNIQUE INDEX benchmark_prereg_pkey ON harness_shared.benchmark_prereg USING btree (prereg_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_prereg_workspace_id_run_id_key",
      "table": "benchmark_prereg",
      "definition": "CREATE UNIQUE INDEX benchmark_prereg_workspace_id_run_id_key ON harness_shared.benchmark_prereg USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_prereg_ws_run_idx",
      "table": "benchmark_prereg",
      "definition": "CREATE INDEX benchmark_prereg_ws_run_idx ON harness_shared.benchmark_prereg USING btree (workspace_id, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_rollout_pkey",
      "table": "benchmark_rollout",
      "definition": "CREATE UNIQUE INDEX benchmark_rollout_pkey ON harness_shared.benchmark_rollout USING btree (rollout_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_rollout_ws_run_idx",
      "table": "benchmark_rollout",
      "definition": "CREATE INDEX benchmark_rollout_ws_run_idx ON harness_shared.benchmark_rollout USING btree (workspace_id, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_fleet_run_idx",
      "table": "benchmark_run_result",
      "definition": "CREATE INDEX benchmark_run_result_fleet_run_idx ON harness_shared.benchmark_run_result USING btree (workspace_id, fleet_run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_pkey",
      "table": "benchmark_run_result",
      "definition": "CREATE UNIQUE INDEX benchmark_run_result_pkey ON harness_shared.benchmark_run_result USING btree (rollout_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_prereg_idx",
      "table": "benchmark_run_result",
      "definition": "CREATE INDEX benchmark_run_result_prereg_idx ON harness_shared.benchmark_run_result USING btree (prereg_hash)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_workspace_id_run_id_suite_task_id_arm__key",
      "table": "benchmark_run_result",
      "definition": "CREATE UNIQUE INDEX benchmark_run_result_workspace_id_run_id_suite_task_id_arm__key ON harness_shared.benchmark_run_result USING btree (workspace_id, run_id, suite, task_id, arm, seed)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_ws_run_suite_idx",
      "table": "benchmark_run_result",
      "definition": "CREATE INDEX benchmark_run_result_ws_run_suite_idx ON harness_shared.benchmark_run_result USING btree (workspace_id, run_id, suite)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "benchmark_run_result_ws_suite_created_idx",
      "table": "benchmark_run_result",
      "definition": "CREATE INDEX benchmark_run_result_ws_suite_created_idx ON harness_shared.benchmark_run_result USING btree (workspace_id, suite, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_invocation_item_recovery_idx",
      "table": "work_items",
      "definition": "CREATE INDEX blueprint_invocation_item_recovery_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, (((payload -> 'blueprintOperation'::text) ->> 'operationId'::text)), (((payload -> 'blueprintOperation'::text) ->> 'callerId'::text)), (((payload -> 'blueprintOperation'::text) ->> 'requestKey'::text))) WHERE (payload ? 'blueprintOperation'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_operation_invocatio_workspace_id_harness_slug_cal_key",
      "table": "blueprint_operation_invocations",
      "definition": "CREATE UNIQUE INDEX blueprint_operation_invocatio_workspace_id_harness_slug_cal_key ON harness_shared.blueprint_operation_invocations USING btree (workspace_id, harness_slug, caller_id, operation_id, request_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_operation_invocations_pkey",
      "table": "blueprint_operation_invocations",
      "definition": "CREATE UNIQUE INDEX blueprint_operation_invocations_pkey ON harness_shared.blueprint_operation_invocations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_operation_invocations_unstarted_idx",
      "table": "blueprint_operation_invocations",
      "definition": "CREATE INDEX blueprint_operation_invocations_unstarted_idx ON harness_shared.blueprint_operation_invocations USING btree (id) WHERE ((target_kind = 'work-item'::text) AND (program_started_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_dependents_pkey",
      "table": "blueprint_package_dependents",
      "definition": "CREATE UNIQUE INDEX blueprint_package_dependents_pkey ON harness_shared.blueprint_package_dependents USING btree (workspace_id, dependent_id, resource_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_dependents_resource_idx",
      "table": "blueprint_package_dependents",
      "definition": "CREATE INDEX blueprint_package_dependents_resource_idx ON harness_shared.blueprint_package_dependents USING btree (workspace_id, resource_key) WHERE (phase <> 'released'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_installations_owner_idx",
      "table": "blueprint_package_installations",
      "definition": "CREATE INDEX blueprint_package_installations_owner_idx ON harness_shared.blueprint_package_installations USING btree (workspace_id, owner_id) WHERE (phase <> 'released'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_installations_pkey",
      "table": "blueprint_package_installations",
      "definition": "CREATE UNIQUE INDEX blueprint_package_installations_pkey ON harness_shared.blueprint_package_installations USING btree (workspace_id, dependent_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_resources_pkey",
      "table": "blueprint_package_resources",
      "definition": "CREATE UNIQUE INDEX blueprint_package_resources_pkey ON harness_shared.blueprint_package_resources USING btree (workspace_id, resource_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_package_resources_workspace_id_write_key_key",
      "table": "blueprint_package_resources",
      "definition": "CREATE UNIQUE INDEX blueprint_package_resources_workspace_id_write_key_key ON harness_shared.blueprint_package_resources USING btree (workspace_id, write_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprint_specifications_pkey",
      "table": "blueprint_specifications",
      "definition": "CREATE UNIQUE INDEX blueprint_specifications_pkey ON harness_shared.blueprint_specifications USING btree (workspace_id, harness_slug, specification_revision)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "blueprints_pkey",
      "table": "blueprints",
      "definition": "CREATE UNIQUE INDEX blueprints_pkey ON harness_shared.blueprints USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "boot_history_events_origin_scope_idx",
      "table": "boot_history_events",
      "definition": "CREATE INDEX boot_history_events_origin_scope_idx ON harness_shared.boot_history_events USING btree (origin, workspace_id, harness_slug, created_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "boot_history_events_pkey",
      "table": "boot_history_events",
      "definition": "CREATE UNIQUE INDEX boot_history_events_pkey ON harness_shared.boot_history_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "boot_history_events_scope_idx",
      "table": "boot_history_events",
      "definition": "CREATE INDEX boot_history_events_scope_idx ON harness_shared.boot_history_events USING btree (workspace_id, harness_slug, created_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cache_l2_expires_idx",
      "table": "cache_l2",
      "definition": "CREATE INDEX cache_l2_expires_idx ON harness_shared.cache_l2 USING btree (expires_at) WHERE (expires_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cache_l2_key_uniq",
      "table": "cache_l2",
      "definition": "CREATE UNIQUE INDEX cache_l2_key_uniq ON harness_shared.cache_l2 USING btree (workspace_id, cache_key)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cache_l2_tags_gin",
      "table": "cache_l2",
      "definition": "CREATE INDEX cache_l2_tags_gin ON harness_shared.cache_l2 USING gin (tags)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_matured_idx",
      "table": "calibration_predictions",
      "definition": "CREATE INDEX calibration_predictions_matured_idx ON harness_shared.calibration_predictions USING btree (workspace_id, horizon_ts) WHERE (resolved_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_open_bet_uq",
      "table": "calibration_predictions",
      "definition": "CREATE UNIQUE INDEX calibration_predictions_open_bet_uq ON harness_shared.calibration_predictions USING btree (workspace_id, predictor, domain, subject_kind, subject_id) WHERE (resolved_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_pkey",
      "table": "calibration_predictions",
      "definition": "CREATE UNIQUE INDEX calibration_predictions_pkey ON harness_shared.calibration_predictions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_scores_idx",
      "table": "calibration_predictions",
      "definition": "CREATE INDEX calibration_predictions_scores_idx ON harness_shared.calibration_predictions USING btree (workspace_id, predictor, domain)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_subject_idx",
      "table": "calibration_predictions",
      "definition": "CREATE INDEX calibration_predictions_subject_idx ON harness_shared.calibration_predictions USING btree (workspace_id, subject_kind, subject_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "calibration_predictions_ws_pot_idx",
      "table": "calibration_predictions",
      "definition": "CREATE INDEX calibration_predictions_ws_pot_idx ON harness_shared.calibration_predictions USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_conformance_binding_identity_uq",
      "table": "capability_class_conformance_runs",
      "definition": "CREATE UNIQUE INDEX capability_class_conformance_binding_identity_uq ON harness_shared.capability_class_conformance_runs USING btree (workspace_id, class_id, class_version, provider_package, provider_version, id, structural_passed)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_conformance_execution_uq",
      "table": "capability_class_conformance_runs",
      "definition": "CREATE UNIQUE INDEX capability_class_conformance_execution_uq ON harness_shared.capability_class_conformance_runs USING btree (workspace_id, class_id, class_version, provider_package, provider_version, id, structural_passed, provider_kind, latency_class)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_conformance_lookup_idx",
      "table": "capability_class_conformance_runs",
      "definition": "CREATE INDEX capability_class_conformance_lookup_idx ON harness_shared.capability_class_conformance_runs USING btree (workspace_id, class_id, class_version, provider_package, provider_version, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_conformance_runs_pkey",
      "table": "capability_class_conformance_runs",
      "definition": "CREATE UNIQUE INDEX capability_class_conformance_runs_pkey ON harness_shared.capability_class_conformance_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_provider_bindings_pkey",
      "table": "capability_class_provider_bindings",
      "definition": "CREATE UNIQUE INDEX capability_class_provider_bindings_pkey ON harness_shared.capability_class_provider_bindings USING btree (workspace_id, class_id, class_version, provider_package, provider_version)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_provider_discovery_idx",
      "table": "capability_class_provider_bindings",
      "definition": "CREATE INDEX capability_class_provider_discovery_idx ON harness_shared.capability_class_provider_bindings USING btree (workspace_id, class_id, class_version, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_provider_execution_uq",
      "table": "capability_class_provider_bindings",
      "definition": "CREATE UNIQUE INDEX capability_class_provider_execution_uq ON harness_shared.capability_class_provider_bindings USING btree (workspace_id, class_id, class_version, provider_package, provider_version, provider_kind, latency_class)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_embedding_hnsw_idx",
      "table": "capability_class_registry",
      "definition": "CREATE INDEX capability_class_registry_embedding_hnsw_idx ON harness_shared.capability_class_registry USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_namespace_provenance_idx",
      "table": "capability_class_registry",
      "definition": "CREATE INDEX capability_class_registry_namespace_provenance_idx ON harness_shared.capability_class_registry USING btree (workspace_id, split_part(id, '.'::text, 1), provenance_kind)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_pkey",
      "table": "capability_class_registry",
      "definition": "CREATE UNIQUE INDEX capability_class_registry_pkey ON harness_shared.capability_class_registry USING btree (workspace_id, id, version)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_review_pending_idx",
      "table": "capability_class_registry",
      "definition": "CREATE INDEX capability_class_registry_review_pending_idx ON harness_shared.capability_class_registry USING btree (review_status) WHERE (review_status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_tags_idx",
      "table": "capability_class_registry",
      "definition": "CREATE INDEX capability_class_registry_tags_idx ON harness_shared.capability_class_registry USING gin (tags)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "capability_class_registry_title_tsv_idx",
      "table": "capability_class_registry",
      "definition": "CREATE INDEX capability_class_registry_title_tsv_idx ON harness_shared.capability_class_registry USING gin (title_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "carry_notes_pkey",
      "table": "carry_notes",
      "definition": "CREATE UNIQUE INDEX carry_notes_pkey ON harness_shared.carry_notes USING btree (workspace_id, scope)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "carry_notes_tsv_idx",
      "table": "carry_notes",
      "definition": "CREATE INDEX carry_notes_tsv_idx ON harness_shared.carry_notes USING gin (note_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "census_provider_registrations_pkey",
      "table": "census_provider_registrations",
      "definition": "CREATE UNIQUE INDEX census_provider_registrations_pkey ON harness_shared.census_provider_registrations USING btree (workspace_id, harness_slug, provider)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chat_messages_channel_time_idx",
      "table": "chat_messages",
      "definition": "CREATE INDEX chat_messages_channel_time_idx ON harness_shared.chat_messages USING btree (workspace_id, data_source_id, channel_id, posted_at) WHERE (thread_key IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "chat_messages_pkey",
      "table": "chat_messages",
      "definition": "CREATE UNIQUE INDEX chat_messages_pkey ON harness_shared.chat_messages USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chat_messages_provider_key",
      "table": "chat_messages",
      "definition": "CREATE UNIQUE INDEX chat_messages_provider_key ON harness_shared.chat_messages USING btree (workspace_id, data_source_id, channel_id, provider_message_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chat_messages_retention_idx",
      "table": "chat_messages",
      "definition": "CREATE INDEX chat_messages_retention_idx ON harness_shared.chat_messages USING btree (workspace_id, data_source_id, posted_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "chat_messages_thread_idx",
      "table": "chat_messages",
      "definition": "CREATE INDEX chat_messages_thread_idx ON harness_shared.chat_messages USING btree (workspace_id, data_source_id, channel_id, thread_key, posted_at) WHERE (thread_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "chat_retrieval_units_bucket_idx",
      "table": "chat_retrieval_units",
      "definition": "CREATE INDEX chat_retrieval_units_bucket_idx ON harness_shared.chat_retrieval_units USING btree (workspace_id, data_source_id, channel_id, unit_kind, bucket_key)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "chat_retrieval_units_pkey",
      "table": "chat_retrieval_units",
      "definition": "CREATE UNIQUE INDEX chat_retrieval_units_pkey ON harness_shared.chat_retrieval_units USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chat_retrieval_units_unit_key",
      "table": "chat_retrieval_units",
      "definition": "CREATE UNIQUE INDEX chat_retrieval_units_unit_key ON harness_shared.chat_retrieval_units USING btree (workspace_id, data_source_id, channel_id, unit_kind, unit_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chat_rollup_queue_pkey",
      "table": "chat_rollup_queue",
      "definition": "CREATE UNIQUE INDEX chat_rollup_queue_pkey ON harness_shared.chat_rollup_queue USING btree (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "chunk_plans_by_spawned_by",
      "table": "harness_chunk_plans",
      "definition": "CREATE INDEX chunk_plans_by_spawned_by ON harness_shared.harness_chunk_plans USING btree (workspace_id, harness_slug, spawned_by_spawn_id) WHERE (spawned_by_spawn_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "claim_audit_feature_idx",
      "table": "claim_audit",
      "definition": "CREATE INDEX claim_audit_feature_idx ON harness_shared.claim_audit USING btree (workspace_id, harness_slug, feature_id, attempt_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "claim_audit_pkey",
      "table": "claim_audit",
      "definition": "CREATE UNIQUE INDEX claim_audit_pkey ON harness_shared.claim_audit USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "claim_retraction_events_claim_idx",
      "table": "claim_retraction_events",
      "definition": "CREATE INDEX claim_retraction_events_claim_idx ON harness_shared.claim_retraction_events USING btree (workspace_id, claim_id, event_seq DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "claim_retraction_events_pkey",
      "table": "claim_retraction_events",
      "definition": "CREATE UNIQUE INDEX claim_retraction_events_pkey ON harness_shared.claim_retraction_events USING btree (event_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cloud_resource_obligations_open_idx",
      "table": "cloud_resource_obligations",
      "definition": "CREATE INDEX cloud_resource_obligations_open_idx ON harness_shared.cloud_resource_obligations USING btree (workspace_id, created_at) WHERE ((closed_at IS NULL) AND teardown_owed)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cloud_resource_obligations_pkey",
      "table": "cloud_resource_obligations",
      "definition": "CREATE UNIQUE INDEX cloud_resource_obligations_pkey ON harness_shared.cloud_resource_obligations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cloud_resource_obligations_workspace_id_provider_resource_k_key",
      "table": "cloud_resource_obligations",
      "definition": "CREATE UNIQUE INDEX cloud_resource_obligations_workspace_id_provider_resource_k_key ON harness_shared.cloud_resource_obligations USING btree (workspace_id, provider, resource_kind, resource_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "code_recipe_runs_fingerprint_idx",
      "table": "code_recipe_runs",
      "definition": "CREATE INDEX code_recipe_runs_fingerprint_idx ON harness_shared.code_recipe_runs USING btree (structural_fingerprint, ts DESC) WHERE (structural_fingerprint IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipe_runs_pkey",
      "table": "code_recipe_runs",
      "definition": "CREATE UNIQUE INDEX code_recipe_runs_pkey ON harness_shared.code_recipe_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "code_recipe_runs_recipe_idx",
      "table": "code_recipe_runs",
      "definition": "CREATE INDEX code_recipe_runs_recipe_idx ON harness_shared.code_recipe_runs USING btree (recipe_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipe_runs_ws_idx",
      "table": "code_recipe_runs",
      "definition": "CREATE INDEX code_recipe_runs_ws_idx ON harness_shared.code_recipe_runs USING btree (workspace_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipes_embedding_hnsw_idx",
      "table": "code_recipes",
      "definition": "CREATE INDEX code_recipes_embedding_hnsw_idx ON harness_shared.code_recipes USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipes_pkey",
      "table": "code_recipes",
      "definition": "CREATE UNIQUE INDEX code_recipes_pkey ON harness_shared.code_recipes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "code_recipes_pot_idx",
      "table": "code_recipes",
      "definition": "CREATE INDEX code_recipes_pot_idx ON harness_shared.code_recipes USING btree (pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipes_runcount_idx",
      "table": "code_recipes",
      "definition": "CREATE INDEX code_recipes_runcount_idx ON harness_shared.code_recipes USING btree (last_run_at DESC NULLS LAST, run_count DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_recipes_title_tsv_idx",
      "table": "code_recipes",
      "definition": "CREATE INDEX code_recipes_title_tsv_idx ON harness_shared.code_recipes USING gin (title_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_run_nudge_fires_at",
      "table": "code_run_nudge_fires",
      "definition": "CREATE INDEX code_run_nudge_fires_at ON harness_shared.code_run_nudge_fires USING btree (fired_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "code_run_nudge_fires_pkey",
      "table": "code_run_nudge_fires",
      "definition": "CREATE UNIQUE INDEX code_run_nudge_fires_pkey ON harness_shared.code_run_nudge_fires USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "code_run_nudge_fires_session",
      "table": "code_run_nudge_fires",
      "definition": "CREATE INDEX code_run_nudge_fires_session ON harness_shared.code_run_nudge_fires USING btree (session_key, fired_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "collision_hysteresis_pkey",
      "table": "collision_hysteresis",
      "definition": "CREATE UNIQUE INDEX collision_hysteresis_pkey ON harness_shared.collision_hysteresis USING btree (session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "collision_hysteresis_updated_idx",
      "table": "collision_hysteresis",
      "definition": "CREATE INDEX collision_hysteresis_updated_idx ON harness_shared.collision_hysteresis USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "comms_trust_list_pkey",
      "table": "comms_trust_list",
      "definition": "CREATE UNIQUE INDEX comms_trust_list_pkey ON harness_shared.comms_trust_list USING btree (workspace_id, trusted_github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "completion_history_search_memo_pkey",
      "table": "completion_history_search_memo",
      "definition": "CREATE UNIQUE INDEX completion_history_search_memo_pkey ON harness_shared.completion_history_search_memo USING btree (workspace_id, repository_root, from_head_sha, path, blob_sha)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "completion_history_search_memo_recent_idx",
      "table": "completion_history_search_memo",
      "definition": "CREATE INDEX completion_history_search_memo_recent_idx ON harness_shared.completion_history_search_memo USING btree (workspace_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_access_settings_pkey",
      "table": "connected_app_access_settings",
      "definition": "CREATE UNIQUE INDEX connected_app_access_settings_pkey ON harness_shared.connected_app_access_settings USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_access_tokens_app_expiry_idx",
      "table": "connected_app_access_tokens",
      "definition": "CREATE INDEX connected_app_access_tokens_app_expiry_idx ON harness_shared.connected_app_access_tokens USING btree (app_id, expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_access_tokens_pkey",
      "table": "connected_app_access_tokens",
      "definition": "CREATE UNIQUE INDEX connected_app_access_tokens_pkey ON harness_shared.connected_app_access_tokens USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_access_tokens_token_hash_key",
      "table": "connected_app_access_tokens",
      "definition": "CREATE UNIQUE INDEX connected_app_access_tokens_token_hash_key ON harness_shared.connected_app_access_tokens USING btree (token_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_auth_failures_hour_idx",
      "table": "connected_app_auth_failures",
      "definition": "CREATE INDEX connected_app_auth_failures_hour_idx ON harness_shared.connected_app_auth_failures USING btree (hour DESC, workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_auth_failures_pkey",
      "table": "connected_app_auth_failures",
      "definition": "CREATE UNIQUE INDEX connected_app_auth_failures_pkey ON harness_shared.connected_app_auth_failures USING btree (app_id, hour)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_client_assertions_pkey",
      "table": "connected_app_client_assertions",
      "definition": "CREATE UNIQUE INDEX connected_app_client_assertions_pkey ON harness_shared.connected_app_client_assertions USING btree (app_id, jti)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_device_grants_auth_code_key",
      "table": "connected_app_device_grants",
      "definition": "CREATE UNIQUE INDEX connected_app_device_grants_auth_code_key ON harness_shared.connected_app_device_grants USING btree (auth_code_hash) WHERE (auth_code_hash IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_device_grants_expires_idx",
      "table": "connected_app_device_grants",
      "definition": "CREATE INDEX connected_app_device_grants_expires_idx ON harness_shared.connected_app_device_grants USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_device_grants_pending_user_code_key",
      "table": "connected_app_device_grants",
      "definition": "CREATE UNIQUE INDEX connected_app_device_grants_pending_user_code_key ON harness_shared.connected_app_device_grants USING btree (user_code) WHERE (state = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_device_grants_pkey",
      "table": "connected_app_device_grants",
      "definition": "CREATE UNIQUE INDEX connected_app_device_grants_pkey ON harness_shared.connected_app_device_grants USING btree (device_code_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_networks_pkey",
      "table": "connected_app_networks",
      "definition": "CREATE UNIQUE INDEX connected_app_networks_pkey ON harness_shared.connected_app_networks USING btree (app_id, network)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_networks_workspace_idx",
      "table": "connected_app_networks",
      "definition": "CREATE INDEX connected_app_networks_workspace_idx ON harness_shared.connected_app_networks USING btree (workspace_id, app_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_oauth_clients_pkey",
      "table": "connected_app_oauth_clients",
      "definition": "CREATE UNIQUE INDEX connected_app_oauth_clients_pkey ON harness_shared.connected_app_oauth_clients USING btree (client_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_removed_creators_email_idx",
      "table": "connected_app_removed_creators",
      "definition": "CREATE INDEX connected_app_removed_creators_email_idx ON harness_shared.connected_app_removed_creators USING btree (email)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_app_removed_creators_pkey",
      "table": "connected_app_removed_creators",
      "definition": "CREATE UNIQUE INDEX connected_app_removed_creators_pkey ON harness_shared.connected_app_removed_creators USING btree (organization_id, email)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_apps_pkey",
      "table": "connected_apps",
      "definition": "CREATE UNIQUE INDEX connected_apps_pkey ON harness_shared.connected_apps USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "connected_apps_token_hash_key",
      "table": "connected_apps",
      "definition": "CREATE UNIQUE INDEX connected_apps_token_hash_key ON harness_shared.connected_apps USING btree (token_hash) WHERE (token_hash IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_apps_user_idx",
      "table": "connected_apps",
      "definition": "CREATE INDEX connected_apps_user_idx ON harness_shared.connected_apps USING btree (user_email)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "connected_apps_workspace_idx",
      "table": "connected_apps",
      "definition": "CREATE INDEX connected_apps_workspace_idx ON harness_shared.connected_apps USING btree (workspace_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_post_meta_conversation_idx",
      "table": "consult_post_meta",
      "definition": "CREATE INDEX consult_post_meta_conversation_idx ON harness_shared.consult_post_meta USING btree (workspace_id, conversation_id, post_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_post_meta_pkey",
      "table": "consult_post_meta",
      "definition": "CREATE UNIQUE INDEX consult_post_meta_pkey ON harness_shared.consult_post_meta USING btree (workspace_id, post_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_expiry_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_expiry_idx ON harness_shared.consult_state USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (closed_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_origin_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_origin_idx ON harness_shared.consult_state USING btree (workspace_id, origin_task_ref) WHERE (origin_task_ref IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_parent_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_parent_idx ON harness_shared.consult_state USING btree (workspace_id, parent_consult_id) WHERE (parent_consult_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_pkey",
      "table": "consult_state",
      "definition": "CREATE UNIQUE INDEX consult_state_pkey ON harness_shared.consult_state USING btree (workspace_id, conversation_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_query_embedding_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_query_embedding_idx ON harness_shared.consult_state USING hnsw (query_embedding vector_cosine_ops) WHERE (query_embedding IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_responder_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_responder_idx ON harness_shared.consult_state USING btree (workspace_id, responder_id) WHERE (responder_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "consult_state_state_idx",
      "table": "consult_state",
      "definition": "CREATE INDEX consult_state_state_idx ON harness_shared.consult_state USING btree (workspace_id, state, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "context_injection_coverage_day_idx",
      "table": "context_injection_coverage",
      "definition": "CREATE INDEX context_injection_coverage_day_idx ON harness_shared.context_injection_coverage USING btree (day DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "context_injection_coverage_pkey",
      "table": "context_injection_coverage",
      "definition": "CREATE UNIQUE INDEX context_injection_coverage_pkey ON harness_shared.context_injection_coverage USING btree (day, workspace_id, client, port, outcome, tool)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "contributor_usage_events_pkey",
      "table": "contributor_usage_events",
      "definition": "CREATE UNIQUE INDEX contributor_usage_events_pkey ON harness_shared.contributor_usage_events USING btree (harness_slug, event_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "contributors_pkey",
      "table": "contributors",
      "definition": "CREATE UNIQUE INDEX contributors_pkey ON harness_shared.contributors USING btree (workspace_id, harness_slug, github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "contributors_username_idx",
      "table": "contributors",
      "definition": "CREATE INDEX contributors_username_idx ON harness_shared.contributors USING btree (workspace_id, harness_slug, github_username)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cooldown_marks_marked_at_idx",
      "table": "cooldown_marks",
      "definition": "CREATE INDEX cooldown_marks_marked_at_idx ON harness_shared.cooldown_marks USING btree (marked_at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cooldown_marks_pkey",
      "table": "cooldown_marks",
      "definition": "CREATE UNIQUE INDEX cooldown_marks_pkey ON harness_shared.cooldown_marks USING btree (key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_blueprint_operation_msg_uq",
      "table": "coord_event_log",
      "definition": "CREATE UNIQUE INDEX coord_blueprint_operation_msg_uq ON harness_shared.coord_event_log USING btree (workspace_id, surface, msg_id) WHERE (surface = 'blueprint-operation'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_blueprint_operation_receipt_events_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_blueprint_operation_receipt_events_idx ON harness_shared.coord_event_log USING btree (workspace_id, writer_key, id DESC) WHERE (surface = 'blueprint-operation'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_blueprint_plan_run_events_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_blueprint_plan_run_events_idx ON harness_shared.coord_event_log USING btree (workspace_id, ((body ->> 'runId'::text)), id) WHERE ((surface = 'blueprint-operation'::text) AND ((body ->> 'runId'::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_blueprint_work_item_events_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_blueprint_work_item_events_idx ON harness_shared.coord_event_log USING btree (workspace_id, ((body ->> 'workItemId'::text)), id) WHERE ((surface = 'blueprint-operation'::text) AND ((body ->> 'workItemId'::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_lane_provenance_idx",
      "table": "coord_conversations",
      "definition": "CREATE INDEX coord_conversations_lane_provenance_idx ON harness_shared.coord_conversations USING btree (workspace_id, plan_slug, work_item_id) WHERE ((plan_slug IS NOT NULL) AND (work_item_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_open_idx",
      "table": "coord_conversations",
      "definition": "CREATE INDEX coord_conversations_open_idx ON harness_shared.coord_conversations USING btree (workspace_id, kind, created_at DESC) WHERE (state = 'open'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_pkey",
      "table": "coord_conversations",
      "definition": "CREATE UNIQUE INDEX coord_conversations_pkey ON harness_shared.coord_conversations USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_producer_state_idx",
      "table": "coord_conversations",
      "definition": "CREATE INDEX coord_conversations_producer_state_idx ON harness_shared.coord_conversations USING btree (workspace_id, producer, state)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_scope_idx",
      "table": "coord_conversations",
      "definition": "CREATE INDEX coord_conversations_scope_idx ON harness_shared.coord_conversations USING btree (workspace_id, scope, harness_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_conversations_superseded_by_idx",
      "table": "coord_conversations",
      "definition": "CREATE INDEX coord_conversations_superseded_by_idx ON harness_shared.coord_conversations USING btree (workspace_id, superseded_by) WHERE (superseded_by IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_entity_subscriptions_active_uq",
      "table": "coord_entity_subscriptions",
      "definition": "CREATE UNIQUE INDEX coord_entity_subscriptions_active_uq ON harness_shared.coord_entity_subscriptions USING btree (workspace_id, subscriber_id, target_kind, target_ref) WHERE (cancelled_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_entity_subscriptions_derived_idx",
      "table": "coord_entity_subscriptions",
      "definition": "CREATE INDEX coord_entity_subscriptions_derived_idx ON harness_shared.coord_entity_subscriptions USING btree (workspace_id, derived_from_kind, derived_from_ref) WHERE ((cancelled_at IS NULL) AND (derived_from_kind IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_entity_subscriptions_pkey",
      "table": "coord_entity_subscriptions",
      "definition": "CREATE UNIQUE INDEX coord_entity_subscriptions_pkey ON harness_shared.coord_entity_subscriptions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_entity_subscriptions_target_idx",
      "table": "coord_entity_subscriptions",
      "definition": "CREATE INDEX coord_entity_subscriptions_target_idx ON harness_shared.coord_entity_subscriptions USING btree (workspace_id, target_kind, target_ref) WHERE (cancelled_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_allhive_broadcast",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_allhive_broadcast ON harness_shared.coord_event_log USING btree (ts) WHERE ((surface = 'messages'::text) AND ((body ->> 'kind'::text) = 'message'::text) AND ((body -> 'to'::text) @> '[\"*\"]'::jsonb))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_conditions_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_conditions_idx ON harness_shared.coord_event_log USING btree (workspace_id, id) WHERE ((surface = 'messages'::text) AND ((body ? 'condition_key'::text) OR (body ? 'resolves_condition'::text)))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_escalation_reroute_of_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_escalation_reroute_of_idx ON harness_shared.coord_event_log USING btree (((body ->> 'escalationRerouteOf'::text))) WHERE (body ? 'escalationRerouteOf'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_event_uq",
      "table": "coord_event_log",
      "definition": "CREATE UNIQUE INDEX coord_event_log_event_uq ON harness_shared.coord_event_log USING btree (workspace_id, surface, msg_id) WHERE (surface = ANY (ARRAY['handoffs'::text, 'escalations'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_fanout_uq",
      "table": "coord_event_log",
      "definition": "CREATE UNIQUE INDEX coord_event_log_fanout_uq ON harness_shared.coord_event_log USING btree (workspace_id, msg_id) WHERE ((surface = 'messages'::text) AND ((body ->> 'notify_kind'::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_fed_event_key_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_fed_event_key_idx ON harness_shared.coord_event_log USING btree (workspace_id, harness_slug, (((body -> 'fed_event'::text) ->> 'key'::text)), id, (((body -> 'fed_event'::text) ->> 'repo_key'::text))) WHERE ((surface = 'messages'::text) AND (((body -> 'fed_event'::text) ->> 'key'::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_fed_uq",
      "table": "coord_event_log",
      "definition": "CREATE UNIQUE INDEX coord_event_log_fed_uq ON harness_shared.coord_event_log USING btree (workspace_id, msg_id) WHERE ((harness_slug IS NOT NULL) AND ((body ->> 'notify_kind'::text) IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_hindsight_notify_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_hindsight_notify_idx ON harness_shared.coord_event_log USING btree (workspace_id, id DESC) WHERE ((surface = 'messages'::text) AND ((body ->> 'notify_kind'::text) = 'operator_hindsight'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_messages_ts_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_messages_ts_idx ON harness_shared.coord_event_log USING btree (workspace_id, ts, id) WHERE (surface = 'messages'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_msg_id_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_msg_id_idx ON harness_shared.coord_event_log USING btree (workspace_id, msg_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_msg_tsv_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_msg_tsv_idx ON harness_shared.coord_event_log USING gin (to_tsvector('english'::regconfig, \"left\"(((COALESCE((body ->> 'summary'::text), ''::text) || ' '::text) || COALESCE((body ->> 'body'::text), ''::text)), 20000))) WHERE (surface = 'messages'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_msgs_from_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_msgs_from_idx ON harness_shared.coord_event_log USING btree (workspace_id, ((body ->> 'from'::text))) WHERE (surface = 'messages'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_msgs_to_gin",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_msgs_to_gin ON harness_shared.coord_event_log USING gin (((body -> 'to'::text))) WHERE (surface = 'messages'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_pkey",
      "table": "coord_event_log",
      "definition": "CREATE UNIQUE INDEX coord_event_log_pkey ON harness_shared.coord_event_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_related_msg_id_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_related_msg_id_idx ON harness_shared.coord_event_log USING btree (((body ->> 'related_msg_id'::text))) WHERE (body ? 'related_msg_id'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_reply_deadline",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_reply_deadline ON harness_shared.coord_event_log USING btree ((((body ->> 'replyDeadlineAt'::text))::bigint)) WHERE ((surface = 'messages'::text) AND (body ? 'replyDeadlineAt'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_superseded_by_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_superseded_by_idx ON harness_shared.coord_event_log USING btree (workspace_id, superseded_by_msg_id) WHERE (superseded_by_msg_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_surface_id",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_surface_id ON harness_shared.coord_event_log USING btree (workspace_id, surface, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_event_log_surface_kind_id_idx",
      "table": "coord_event_log",
      "definition": "CREATE INDEX coord_event_log_surface_kind_id_idx ON harness_shared.coord_event_log USING btree (workspace_id, surface, ((body ->> 'kind'::text)), id DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_links_dst_idx",
      "table": "coord_links",
      "definition": "CREATE INDEX coord_links_dst_idx ON harness_shared.coord_links USING btree (workspace_id, dst_kind, dst_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_links_edge_uq",
      "table": "coord_links",
      "definition": "CREATE UNIQUE INDEX coord_links_edge_uq ON harness_shared.coord_links USING btree (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_links_pkey",
      "table": "coord_links",
      "definition": "CREATE UNIQUE INDEX coord_links_pkey ON harness_shared.coord_links USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_links_src_idx",
      "table": "coord_links",
      "definition": "CREATE INDEX coord_links_src_idx ON harness_shared.coord_links USING btree (workspace_id, src_kind, src_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_open_escalations_pkey",
      "table": "coord_open_escalations",
      "definition": "CREATE UNIQUE INDEX coord_open_escalations_pkey ON harness_shared.coord_open_escalations USING btree (workspace_id, msg_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_open_escalations_ws_dedup_subject",
      "table": "coord_open_escalations",
      "definition": "CREATE INDEX coord_open_escalations_ws_dedup_subject ON harness_shared.coord_open_escalations USING btree (workspace_id, ((body ->> 'dedupKind'::text)), ((body ->> 'subjectSignature'::text)))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_open_escalations_ws_ts",
      "table": "coord_open_escalations",
      "definition": "CREATE INDEX coord_open_escalations_ws_ts ON harness_shared.coord_open_escalations USING btree (workspace_id, ts, msg_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_presence_fleet_idx",
      "table": "coord_presence",
      "definition": "CREATE INDEX coord_presence_fleet_idx ON harness_shared.coord_presence USING btree (workspace_id, fleet_slug) WHERE (fleet_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_presence_pkey",
      "table": "coord_presence",
      "definition": "CREATE UNIQUE INDEX coord_presence_pkey ON harness_shared.coord_presence USING btree (owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_presence_pot_idx",
      "table": "coord_presence",
      "definition": "CREATE INDEX coord_presence_pot_idx ON harness_shared.coord_presence USING btree (workspace_id, pot_slug) WHERE (pot_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_presence_workspace_idx",
      "table": "coord_presence",
      "definition": "CREATE INDEX coord_presence_workspace_idx ON harness_shared.coord_presence USING btree (workspace_id, heartbeat_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_quarantine_author_idx",
      "table": "coord_quarantine",
      "definition": "CREATE INDEX coord_quarantine_author_idx ON harness_shared.coord_quarantine USING btree (workspace_id, author_device_pubkey, created_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_quarantine_pkey",
      "table": "coord_quarantine",
      "definition": "CREATE UNIQUE INDEX coord_quarantine_pkey ON harness_shared.coord_quarantine USING btree (workspace_id, msg_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_read_cursors_pkey",
      "table": "coord_read_cursors",
      "definition": "CREATE UNIQUE INDEX coord_read_cursors_pkey ON harness_shared.coord_read_cursors USING btree (workspace_id, owner_id, surface)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_thread_posts_fed_uq",
      "table": "coord_thread_posts",
      "definition": "CREATE UNIQUE INDEX coord_thread_posts_fed_uq ON harness_shared.coord_thread_posts USING btree (workspace_id, post_msg_id) WHERE ((harness_slug IS NOT NULL) AND (post_msg_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_thread_posts_pkey",
      "table": "coord_thread_posts",
      "definition": "CREATE UNIQUE INDEX coord_thread_posts_pkey ON harness_shared.coord_thread_posts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_thread_posts_thread_idx",
      "table": "coord_thread_posts",
      "definition": "CREATE INDEX coord_thread_posts_thread_idx ON harness_shared.coord_thread_posts USING btree (workspace_id, thread_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_thread_posts_tsv_idx",
      "table": "coord_thread_posts",
      "definition": "CREATE INDEX coord_thread_posts_tsv_idx ON harness_shared.coord_thread_posts USING gin (body_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_threads_fed_uq",
      "table": "coord_threads",
      "definition": "CREATE UNIQUE INDEX coord_threads_fed_uq ON harness_shared.coord_threads USING btree (workspace_id, thread_id) WHERE (harness_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_threads_parent_uq",
      "table": "coord_threads",
      "definition": "CREATE UNIQUE INDEX coord_threads_parent_uq ON harness_shared.coord_threads USING btree (workspace_id, parent_kind, parent_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_threads_pkey",
      "table": "coord_threads",
      "definition": "CREATE UNIQUE INDEX coord_threads_pkey ON harness_shared.coord_threads USING btree (workspace_id, thread_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_topics_live_idx",
      "table": "coord_topics",
      "definition": "CREATE INDEX coord_topics_live_idx ON harness_shared.coord_topics USING btree (workspace_id, created_at DESC) WHERE (merged_into IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coord_topics_pkey",
      "table": "coord_topics",
      "definition": "CREATE UNIQUE INDEX coord_topics_pkey ON harness_shared.coord_topics USING btree (workspace_id, slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coord_watermarks_pkey",
      "table": "coord_watermarks",
      "definition": "CREATE UNIQUE INDEX coord_watermarks_pkey ON harness_shared.coord_watermarks USING btree (workspace_id, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "corpus_session_surfaced_at_idx",
      "table": "corpus_session_surfaced",
      "definition": "CREATE INDEX corpus_session_surfaced_at_idx ON harness_shared.corpus_session_surfaced USING btree (surfaced_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "corpus_session_surfaced_pkey",
      "table": "corpus_session_surfaced",
      "definition": "CREATE UNIQUE INDEX corpus_session_surfaced_pkey ON harness_shared.corpus_session_surfaced USING btree (session_id, epoch, ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "corpus_term_df_pkey",
      "table": "corpus_term_df",
      "definition": "CREATE UNIQUE INDEX corpus_term_df_pkey ON harness_shared.corpus_term_df USING btree (workspace_id, term)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "corpus_term_df_workspace_refreshed_idx",
      "table": "corpus_term_df",
      "definition": "CREATE INDEX corpus_term_df_workspace_refreshed_idx ON harness_shared.corpus_term_df USING btree (workspace_id, refreshed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coverage_evidence_by_run",
      "table": "coverage_evidence",
      "definition": "CREATE INDEX coverage_evidence_by_run ON harness_shared.coverage_evidence USING btree (test_run_id) WHERE (test_run_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coverage_evidence_by_surface",
      "table": "coverage_evidence",
      "definition": "CREATE INDEX coverage_evidence_by_surface ON harness_shared.coverage_evidence USING btree (surface_ref, evidence_kind, observed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coverage_evidence_dedup",
      "table": "coverage_evidence",
      "definition": "CREATE UNIQUE INDEX coverage_evidence_dedup ON harness_shared.coverage_evidence USING btree (surface_ref, evidence_kind, COALESCE(test_file, ''::text), COALESCE(test_case, ''::text), COALESCE(test_run_id, ('-1'::integer)::bigint))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coverage_evidence_pkey",
      "table": "coverage_evidence",
      "definition": "CREATE UNIQUE INDEX coverage_evidence_pkey ON harness_shared.coverage_evidence USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "coverage_waivers_active",
      "table": "coverage_waivers",
      "definition": "CREATE INDEX coverage_waivers_active ON harness_shared.coverage_waivers USING btree (surface_ref, expires_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "coverage_waivers_pkey",
      "table": "coverage_waivers",
      "definition": "CREATE UNIQUE INDEX coverage_waivers_pkey ON harness_shared.coverage_waivers USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cross_hive_asks_correlation_pot_uniq",
      "table": "cross_pot_asks",
      "definition": "CREATE UNIQUE INDEX cross_hive_asks_correlation_pot_uniq ON harness_shared.cross_pot_asks USING btree (workspace_id, pot_slug, correlation_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cross_hive_asks_listing_pot_idx",
      "table": "cross_pot_asks",
      "definition": "CREATE INDEX cross_hive_asks_listing_pot_idx ON harness_shared.cross_pot_asks USING btree (workspace_id, pot_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cross_hive_beacon_history_hive_captured_idx",
      "table": "cross_pot_beacon_history",
      "definition": "CREATE INDEX cross_hive_beacon_history_hive_captured_idx ON harness_shared.cross_pot_beacon_history USING btree (hive_id, captured_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cross_hive_outbox_pending_pot_idx",
      "table": "cross_pot_outbox",
      "definition": "CREATE INDEX cross_hive_outbox_pending_pot_idx ON harness_shared.cross_pot_outbox USING btree (workspace_id, pot_slug, created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cross_pot_asks_pkey",
      "table": "cross_pot_asks",
      "definition": "CREATE UNIQUE INDEX cross_pot_asks_pkey ON harness_shared.cross_pot_asks USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cross_pot_beacon_history_pkey",
      "table": "cross_pot_beacon_history",
      "definition": "CREATE UNIQUE INDEX cross_pot_beacon_history_pkey ON harness_shared.cross_pot_beacon_history USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cross_pot_outbox_pkey",
      "table": "cross_pot_outbox",
      "definition": "CREATE UNIQUE INDEX cross_pot_outbox_pkey ON harness_shared.cross_pot_outbox USING btree (workspace_id, pot_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_claim_spec_revisions_lookup_idx",
      "table": "cup_claim_spec_revisions",
      "definition": "CREATE INDEX cup_claim_spec_revisions_lookup_idx ON harness_shared.cup_claim_spec_revisions USING btree (workspace_id, bee_id, superseded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cup_claim_spec_revisions_pkey",
      "table": "cup_claim_spec_revisions",
      "definition": "CREATE UNIQUE INDEX cup_claim_spec_revisions_pkey ON harness_shared.cup_claim_spec_revisions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_claim_specs_pkey",
      "table": "cup_claim_specs",
      "definition": "CREATE UNIQUE INDEX cup_claim_specs_pkey ON harness_shared.cup_claim_specs USING btree (workspace_id, bee_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_instances_pkey",
      "table": "cup_keeper_instances",
      "definition": "CREATE UNIQUE INDEX cup_keeper_instances_pkey ON harness_shared.cup_keeper_instances USING btree (instance_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_instances_workspace_id_code_sha_genome_id_key",
      "table": "cup_keeper_instances",
      "definition": "CREATE UNIQUE INDEX cup_keeper_instances_workspace_id_code_sha_genome_id_key ON harness_shared.cup_keeper_instances USING btree (workspace_id, code_sha, genome_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_runs_case_idx",
      "table": "cup_keeper_runs",
      "definition": "CREATE INDEX cup_keeper_runs_case_idx ON harness_shared.cup_keeper_runs USING btree (case_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_runs_instance_case_idx",
      "table": "cup_keeper_runs",
      "definition": "CREATE INDEX cup_keeper_runs_instance_case_idx ON harness_shared.cup_keeper_runs USING btree (instance_id, case_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_runs_instance_idx",
      "table": "cup_keeper_runs",
      "definition": "CREATE INDEX cup_keeper_runs_instance_idx ON harness_shared.cup_keeper_runs USING btree (instance_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_runs_pkey",
      "table": "cup_keeper_runs",
      "definition": "CREATE UNIQUE INDEX cup_keeper_runs_pkey ON harness_shared.cup_keeper_runs USING btree (run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_scores_pkey",
      "table": "cup_keeper_scores",
      "definition": "CREATE UNIQUE INDEX cup_keeper_scores_pkey ON harness_shared.cup_keeper_scores USING btree (run_id, rubric_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "cup_keeper_scores_run_idx",
      "table": "cup_keeper_scores",
      "definition": "CREATE INDEX cup_keeper_scores_run_idx ON harness_shared.cup_keeper_scores USING btree (run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_connector_binding_uq",
      "table": "customer_workspaces",
      "definition": "CREATE UNIQUE INDEX customer_workspaces_connector_binding_uq ON harness_shared.customer_workspaces USING btree (workspace_id, organization_id, id, workspace_host_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_host_identity_uq",
      "table": "customer_workspaces",
      "definition": "CREATE UNIQUE INDEX customer_workspaces_host_identity_uq ON harness_shared.customer_workspaces USING btree (workspace_id, workspace_host_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_idle_stop_idx",
      "table": "customer_workspaces",
      "definition": "CREATE INDEX customer_workspaces_idle_stop_idx ON harness_shared.customer_workspaces USING btree (workspace_id, last_activity_at, id) WHERE ((state = 'active'::text) AND (idle_stop_after_minutes IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_one_live_per_organization_uq",
      "table": "customer_workspaces",
      "definition": "CREATE UNIQUE INDEX customer_workspaces_one_live_per_organization_uq ON harness_shared.customer_workspaces USING btree (workspace_id, organization_id) WHERE ((state <> 'deleted'::text) AND (kind = 'hosted'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_org_identity_uq",
      "table": "customer_workspaces",
      "definition": "CREATE UNIQUE INDEX customer_workspaces_org_identity_uq ON harness_shared.customer_workspaces USING btree (workspace_id, organization_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_organization_idx",
      "table": "customer_workspaces",
      "definition": "CREATE INDEX customer_workspaces_organization_idx ON harness_shared.customer_workspaces USING btree (workspace_id, organization_id, updated_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "customer_workspaces_pkey",
      "table": "customer_workspaces",
      "definition": "CREATE UNIQUE INDEX customer_workspaces_pkey ON harness_shared.customer_workspaces USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "data_source_legal_holds_active_idx",
      "table": "data_source_legal_holds",
      "definition": "CREATE INDEX data_source_legal_holds_active_idx ON harness_shared.data_source_legal_holds USING btree (workspace_id, data_source_id, channel_id) WHERE (released_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "data_source_legal_holds_pkey",
      "table": "data_source_legal_holds",
      "definition": "CREATE UNIQUE INDEX data_source_legal_holds_pkey ON harness_shared.data_source_legal_holds USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "data_source_subscriptions_live_key",
      "table": "data_source_subscriptions",
      "definition": "CREATE UNIQUE INDEX data_source_subscriptions_live_key ON harness_shared.data_source_subscriptions USING btree (workspace_id, subject_kind, subject_ref, source) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "data_source_subscriptions_pkey",
      "table": "data_source_subscriptions",
      "definition": "CREATE UNIQUE INDEX data_source_subscriptions_pkey ON harness_shared.data_source_subscriptions USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "data_sources_owned_account_kind_uidx",
      "table": "data_sources",
      "definition": "CREATE UNIQUE INDEX data_sources_owned_account_kind_uidx ON harness_shared.data_sources USING btree (workspace_id, kind, owner_user_id, provider_account_id) WHERE ((owner_user_id IS NOT NULL) AND (provider_account_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "data_sources_pkey",
      "table": "data_sources",
      "definition": "CREATE UNIQUE INDEX data_sources_pkey ON harness_shared.data_sources USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "data_sources_workspace_owner_account_idx",
      "table": "data_sources",
      "definition": "CREATE INDEX data_sources_workspace_owner_account_idx ON harness_shared.data_sources USING btree (workspace_id, owner_user_id, provider_account_id) WHERE ((owner_user_id IS NOT NULL) AND (provider_account_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "data_sources_workspace_owner_idx",
      "table": "data_sources",
      "definition": "CREATE INDEX data_sources_workspace_owner_idx ON harness_shared.data_sources USING btree (workspace_id, owner_user_id) WHERE (owner_user_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "data_sources_ws_kind_status_idx",
      "table": "data_sources",
      "definition": "CREATE INDEX data_sources_ws_kind_status_idx ON harness_shared.data_sources USING btree (workspace_id, kind, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "datatype_registry_pkey",
      "table": "datatype_registry",
      "definition": "CREATE UNIQUE INDEX datatype_registry_pkey ON harness_shared.datatype_registry USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "datatype_registry_review_pending_idx",
      "table": "datatype_registry",
      "definition": "CREATE INDEX datatype_registry_review_pending_idx ON harness_shared.datatype_registry USING btree (review_status) WHERE (review_status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "datatype_registry_title_tsv_idx",
      "table": "datatype_registry",
      "definition": "CREATE INDEX datatype_registry_title_tsv_idx ON harness_shared.datatype_registry USING gin (title_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "datatype_registry_ws_kind_idx",
      "table": "datatype_registry",
      "definition": "CREATE UNIQUE INDEX datatype_registry_ws_kind_idx ON harness_shared.datatype_registry USING btree (workspace_id, work_item_kind) WHERE (work_item_kind IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "datatype_registry_ws_pot_idx",
      "table": "datatype_registry",
      "definition": "CREATE INDEX datatype_registry_ws_pot_idx ON harness_shared.datatype_registry USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_ledger_pkey",
      "table": "decision_ledger",
      "definition": "CREATE UNIQUE INDEX decision_ledger_pkey ON harness_shared.decision_ledger USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "decision_ledger_ws_category_idx",
      "table": "decision_ledger",
      "definition": "CREATE INDEX decision_ledger_ws_category_idx ON harness_shared.decision_ledger USING btree (workspace_id, category, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_ledger_ws_layer_ts_idx",
      "table": "decision_ledger",
      "definition": "CREATE INDEX decision_ledger_ws_layer_ts_idx ON harness_shared.decision_ledger USING btree (workspace_id, layer, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_ledger_ws_posture_idx",
      "table": "decision_ledger",
      "definition": "CREATE INDEX decision_ledger_ws_posture_idx ON harness_shared.decision_ledger USING btree (workspace_id, posture, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_ledger_ws_ts_idx",
      "table": "decision_ledger",
      "definition": "CREATE INDEX decision_ledger_ws_ts_idx ON harness_shared.decision_ledger USING btree (workspace_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_model_calls_pkey",
      "table": "decision_model_calls",
      "definition": "CREATE UNIQUE INDEX decision_model_calls_pkey ON harness_shared.decision_model_calls USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "decision_model_calls_state_sha256_idx",
      "table": "decision_model_calls",
      "definition": "CREATE INDEX decision_model_calls_state_sha256_idx ON harness_shared.decision_model_calls USING btree (state_sha256)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "decision_model_calls_ws_consumer_created_idx",
      "table": "decision_model_calls",
      "definition": "CREATE INDEX decision_model_calls_ws_consumer_created_idx ON harness_shared.decision_model_calls USING btree (workspace_id, consumer, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dedup_adjudications_pkey",
      "table": "dedup_adjudications",
      "definition": "CREATE UNIQUE INDEX dedup_adjudications_pkey ON harness_shared.dedup_adjudications USING btree (workspace_id, harness_slug, a, b)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "dedup_edges_b_idx",
      "table": "dedup_edges",
      "definition": "CREATE INDEX dedup_edges_b_idx ON harness_shared.dedup_edges USING btree (workspace_id, harness_slug, b)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dedup_edges_component_idx",
      "table": "dedup_edges",
      "definition": "CREATE INDEX dedup_edges_component_idx ON harness_shared.dedup_edges USING btree (workspace_id, harness_slug, cos) WHERE (cos >= (0.90)::double precision)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dedup_edges_pkey",
      "table": "dedup_edges",
      "definition": "CREATE UNIQUE INDEX dedup_edges_pkey ON harness_shared.dedup_edges USING btree (workspace_id, harness_slug, a, b)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "dedup_shard_map_one_member_uq",
      "table": "dedup_shard_map",
      "definition": "CREATE UNIQUE INDEX dedup_shard_map_one_member_uq ON harness_shared.dedup_shard_map USING btree (run_id, item_id) WHERE (role = 'member'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dedup_shard_map_pkey",
      "table": "dedup_shard_map",
      "definition": "CREATE UNIQUE INDEX dedup_shard_map_pkey ON harness_shared.dedup_shard_map USING btree (run_id, shard_id, item_id, role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "dedup_shard_map_run_shard_idx",
      "table": "dedup_shard_map",
      "definition": "CREATE INDEX dedup_shard_map_run_shard_idx ON harness_shared.dedup_shard_map USING btree (workspace_id, harness_slug, run_id, shard_id, role)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "deferral_pricing_model_latest_idx",
      "table": "deferral_pricing_model",
      "definition": "CREATE INDEX deferral_pricing_model_latest_idx ON harness_shared.deferral_pricing_model USING btree (workspace_id, trained_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "deferral_pricing_model_pkey",
      "table": "deferral_pricing_model",
      "definition": "CREATE UNIQUE INDEX deferral_pricing_model_pkey ON harness_shared.deferral_pricing_model USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "derived_read_snapshots_pkey",
      "table": "derived_read_snapshots",
      "definition": "CREATE UNIQUE INDEX derived_read_snapshots_pkey ON harness_shared.derived_read_snapshots USING btree (workspace_id, harness_slug, key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "derived_read_snapshots_staleness_idx",
      "table": "derived_read_snapshots",
      "definition": "CREATE INDEX derived_read_snapshots_staleness_idx ON harness_shared.derived_read_snapshots USING btree (workspace_id, computed_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_perf_runs_pkey",
      "table": "desktop_perf_runs",
      "definition": "CREATE UNIQUE INDEX desktop_perf_runs_pkey ON harness_shared.desktop_perf_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "desktop_perf_runs_ws_created_idx",
      "table": "desktop_perf_runs",
      "definition": "CREATE INDEX desktop_perf_runs_ws_created_idx ON harness_shared.desktop_perf_runs USING btree (workspace_id, created_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_idle_idx",
      "table": "desktop_sessions",
      "definition": "CREATE INDEX desktop_sessions_idle_idx ON harness_shared.desktop_sessions USING btree (COALESCE(host_ref, ''::text), last_active_at) WHERE (state <> ALL (ARRAY['released'::text, 'dead'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_live_display_uq",
      "table": "desktop_sessions",
      "definition": "CREATE UNIQUE INDEX desktop_sessions_live_display_uq ON harness_shared.desktop_sessions USING btree (COALESCE(host_ref, ''::text), display) WHERE (state <> ALL (ARRAY['released'::text, 'dead'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_live_idx",
      "table": "desktop_sessions",
      "definition": "CREATE INDEX desktop_sessions_live_idx ON harness_shared.desktop_sessions USING btree (workspace_id, harness_slug, state) WHERE (state <> ALL (ARRAY['released'::text, 'dead'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_live_scope_uq",
      "table": "desktop_sessions",
      "definition": "CREATE UNIQUE INDEX desktop_sessions_live_scope_uq ON harness_shared.desktop_sessions USING btree (workspace_id, scope, scope_ref, COALESCE(name, ''::text)) WHERE (state <> ALL (ARRAY['released'::text, 'dead'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_owner_idx",
      "table": "desktop_sessions",
      "definition": "CREATE INDEX desktop_sessions_owner_idx ON harness_shared.desktop_sessions USING btree (owner_boot_id, owner_pid) WHERE (state <> ALL (ARRAY['released'::text, 'dead'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "desktop_sessions_pkey",
      "table": "desktop_sessions",
      "definition": "CREATE UNIQUE INDEX desktop_sessions_pkey ON harness_shared.desktop_sessions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "directive_summaries_consolidated_pkey",
      "table": "directive_summaries_consolidated",
      "definition": "CREATE UNIQUE INDEX directive_summaries_consolidated_pkey ON harness_shared.directive_summaries_consolidated USING btree (harness_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "directive_summaries_consolidated_recent_idx",
      "table": "directive_summaries_consolidated",
      "definition": "CREATE INDEX directive_summaries_consolidated_recent_idx ON harness_shared.directive_summaries_consolidated USING btree (harness_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "doc_revisions_pkey",
      "table": "doc_revisions",
      "definition": "CREATE UNIQUE INDEX doc_revisions_pkey ON harness_shared.doc_revisions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "doc_revisions_ws_harness_doc_seq_key",
      "table": "doc_revisions",
      "definition": "CREATE UNIQUE INDEX doc_revisions_ws_harness_doc_seq_key ON harness_shared.doc_revisions USING btree (workspace_id, harness_slug, doc_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "doc_sections_embedding_hnsw_idx",
      "table": "doc_sections",
      "definition": "CREATE INDEX doc_sections_embedding_hnsw_idx ON harness_shared.doc_sections USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "doc_sections_embedding_mode_idx",
      "table": "doc_sections",
      "definition": "CREATE INDEX doc_sections_embedding_mode_idx ON harness_shared.doc_sections USING btree (embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "doc_sections_pkey",
      "table": "doc_sections",
      "definition": "CREATE UNIQUE INDEX doc_sections_pkey ON harness_shared.doc_sections USING btree (source_key, slug, anchor)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "document_permission_lists_pkey",
      "table": "document_permission_lists",
      "definition": "CREATE UNIQUE INDEX document_permission_lists_pkey ON harness_shared.document_permission_lists USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "document_permission_lists_source_ref_key",
      "table": "document_permission_lists",
      "definition": "CREATE UNIQUE INDEX document_permission_lists_source_ref_key ON harness_shared.document_permission_lists USING btree (workspace_id, source, source_ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "document_permission_members_identity_idx",
      "table": "document_permission_members",
      "definition": "CREATE INDEX document_permission_members_identity_idx ON harness_shared.document_permission_members USING btree (workspace_id, provider, provider_user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "document_permission_members_pkey",
      "table": "document_permission_members",
      "definition": "CREATE UNIQUE INDEX document_permission_members_pkey ON harness_shared.document_permission_members USING btree (workspace_id, list_id, provider, provider_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "documents_account_time_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_account_time_idx ON harness_shared.documents USING btree (workspace_id, user_id, source, provider_account_id, occurred_at DESC NULLS LAST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_embedding_mode_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_embedding_mode_idx ON harness_shared.documents USING btree (workspace_id, user_id, embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_organization_dedupe",
      "table": "documents",
      "definition": "CREATE UNIQUE INDEX documents_organization_dedupe ON harness_shared.documents USING btree (workspace_id, source, dedupe_key) WHERE (scope = 'organization'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_participant_ids_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_participant_ids_idx ON harness_shared.documents USING gin (participant_ids)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_participants_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_participants_idx ON harness_shared.documents USING gin (participants)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_permission_list_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_permission_list_idx ON harness_shared.documents USING btree (workspace_id, permission_list_id) WHERE (scope = 'organization'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_pkey",
      "table": "documents",
      "definition": "CREATE UNIQUE INDEX documents_pkey ON harness_shared.documents USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "documents_pot_dedupe",
      "table": "documents",
      "definition": "CREATE UNIQUE INDEX documents_pot_dedupe ON harness_shared.documents USING btree (workspace_id, pot_slug, source, dedupe_key) WHERE (scope = 'pot'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_scope_time_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_scope_time_idx ON harness_shared.documents USING btree (workspace_id, user_id, scope_key, occurred_at DESC NULLS LAST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_source_id_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_source_id_idx ON harness_shared.documents USING btree (workspace_id, user_id, source_id) WHERE (source_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_source_time_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_source_time_idx ON harness_shared.documents USING btree (workspace_id, user_id, source, occurred_at DESC NULLS LAST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_text_tsv_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_text_tsv_idx ON harness_shared.documents USING gin (text_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_user_datatype_cursor_idx",
      "table": "documents",
      "definition": "CREATE INDEX documents_user_datatype_cursor_idx ON harness_shared.documents USING btree (workspace_id, user_id, datatype_id, COALESCE(occurred_at, imported_at), id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "documents_workspace_id_user_id_source_dedupe_key_key",
      "table": "documents",
      "definition": "CREATE UNIQUE INDEX documents_workspace_id_user_id_source_dedupe_key_key ON harness_shared.documents USING btree (workspace_id, user_id, source, dedupe_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "dream_runs_pkey",
      "table": "dream_runs",
      "definition": "CREATE UNIQUE INDEX dream_runs_pkey ON harness_shared.dream_runs USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "dream_runs_ws_cycle_idx",
      "table": "dream_runs",
      "definition": "CREATE INDEX dream_runs_ws_cycle_idx ON harness_shared.dream_runs USING btree (workspace_id, cycle_id, started_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dream_runs_ws_pot_started_idx",
      "table": "dream_runs",
      "definition": "CREATE INDEX dream_runs_ws_pot_started_idx ON harness_shared.dream_runs USING btree (workspace_id, pot_slug, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "dream_runs_ws_status_started_idx",
      "table": "dream_runs",
      "definition": "CREATE INDEX dream_runs_ws_status_started_idx ON harness_shared.dream_runs USING btree (workspace_id, status, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "edit_attribution_dispatch_repo_file_uidx",
      "table": "edit_attribution_ledger",
      "definition": "CREATE UNIQUE INDEX edit_attribution_dispatch_repo_file_uidx ON harness_shared.edit_attribution_ledger USING btree (dispatch_call_id, repo_root, file) WHERE (dispatch_call_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "edit_attribution_ledger_agent_ts_idx",
      "table": "edit_attribution_ledger",
      "definition": "CREATE INDEX edit_attribution_ledger_agent_ts_idx ON harness_shared.edit_attribution_ledger USING btree (agent_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "edit_attribution_ledger_pkey",
      "table": "edit_attribution_ledger",
      "definition": "CREATE UNIQUE INDEX edit_attribution_ledger_pkey ON harness_shared.edit_attribution_ledger USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "edit_attribution_ledger_repo_file_idx",
      "table": "edit_attribution_ledger",
      "definition": "CREATE INDEX edit_attribution_ledger_repo_file_idx ON harness_shared.edit_attribution_ledger USING btree (repo_root, file, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "edit_attribution_ledger_work_item_idx",
      "table": "edit_attribution_ledger",
      "definition": "CREATE INDEX edit_attribution_ledger_work_item_idx ON harness_shared.edit_attribution_ledger USING btree (work_item_id, ts DESC) WHERE (work_item_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "el_conv_calls_conversation_id_key",
      "table": "el_conv_calls",
      "definition": "CREATE UNIQUE INDEX el_conv_calls_conversation_id_key ON harness_shared.el_conv_calls USING btree (conversation_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "el_conv_calls_pkey",
      "table": "el_conv_calls",
      "definition": "CREATE UNIQUE INDEX el_conv_calls_pkey ON harness_shared.el_conv_calls USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "el_conv_calls_ym_idx",
      "table": "el_conv_calls",
      "definition": "CREATE INDEX el_conv_calls_ym_idx ON harness_shared.el_conv_calls USING btree (ym)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "embed_coverage_samples_pkey",
      "table": "embed_coverage_samples",
      "definition": "CREATE UNIQUE INDEX embed_coverage_samples_pkey ON harness_shared.embed_coverage_samples USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "embed_coverage_samples_ws_surface_ts_idx",
      "table": "embed_coverage_samples",
      "definition": "CREATE INDEX embed_coverage_samples_ws_surface_ts_idx ON harness_shared.embed_coverage_samples USING btree (workspace_id, surface, observed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_await_nodes_parent_id_idx",
      "table": "event_await_nodes",
      "definition": "CREATE INDEX event_await_nodes_parent_id_idx ON harness_shared.event_await_nodes USING btree (parent_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_await_nodes_pkey",
      "table": "event_await_nodes",
      "definition": "CREATE UNIQUE INDEX event_await_nodes_pkey ON harness_shared.event_await_nodes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_await_nodes_root_id_idx",
      "table": "event_await_nodes",
      "definition": "CREATE INDEX event_await_nodes_root_id_idx ON harness_shared.event_await_nodes USING btree (root_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_await_nodes_sweeper_idx",
      "table": "event_await_nodes",
      "definition": "CREATE INDEX event_await_nodes_sweeper_idx ON harness_shared.event_await_nodes USING btree (expires_ts) WHERE ((expires_ts IS NOT NULL) AND (fired_at IS NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_announce_active",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_announce_active ON harness_shared.event_awaits USING btree (workspace_id, event_key) WHERE ((policy = 'announce'::text) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_announce_current",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_announce_current ON harness_shared.event_awaits USING btree (workspace_id, event_key, causal_generation DESC) WHERE ((policy = 'announce'::text) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_announce_generation_unique",
      "table": "event_awaits",
      "definition": "CREATE UNIQUE INDEX event_awaits_announce_generation_unique ON harness_shared.event_awaits USING btree (workspace_id, event_key, causal_generation) WHERE ((policy = 'announce'::text) AND (causal_generation IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_announce_logical_gate_active",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_announce_logical_gate_active ON harness_shared.event_awaits USING btree (workspace_id, logical_gate_key) WHERE ((policy = 'announce'::text) AND (logical_gate_key IS NOT NULL) AND (superseded_at IS NULL) AND (cancelled_at IS NULL) AND (fired_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_bound_to_active",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_bound_to_active ON harness_shared.event_awaits USING btree (((bound_to ->> 'kind'::text)), ((bound_to ->> 'ref'::text))) WHERE ((bound_to IS NOT NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_composed_node_idx",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_composed_node_idx ON harness_shared.event_awaits USING btree (node_id) WHERE (node_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_composed_root_idx",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_composed_root_idx ON harness_shared.event_awaits USING btree (root_id) WHERE (root_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_exact_one_shot_one_per_subscriber_key",
      "table": "event_awaits",
      "definition": "CREATE UNIQUE INDEX event_awaits_exact_one_shot_one_per_subscriber_key ON harness_shared.event_awaits USING btree (workspace_id, subscriber_id, event_key) WHERE ((policy <> 'announce'::text) AND (once = true) AND (root_id IS NULL) AND (payload_filter IS NULL) AND ((note IS NULL) OR (note !~~ '[fleet:bench] %'::text)) AND (event_key !~~ '%*%'::text) AND (event_key !~~ '@%'::text) AND (fired_at IS NULL) AND (cancelled_at IS NULL) AND (superseded_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_fired_wake_recovery",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_fired_wake_recovery ON harness_shared.event_awaits USING btree (workspace_id, fired_at, id) WHERE ((once = true) AND (policy = 'wake'::text) AND (fired_at IS NOT NULL) AND (node_id IS NULL) AND (root_id IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_inbox_wake_one_per_agent",
      "table": "event_awaits",
      "definition": "CREATE UNIQUE INDEX event_awaits_inbox_wake_one_per_agent ON harness_shared.event_awaits USING btree (workspace_id, subscriber_id, event_key) WHERE ((policy = 'wake'::text) AND (once = false) AND (cancelled_at IS NULL) AND (event_key ~~ 'coord:inbox-wake:%'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_operator_cancelled_key",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_operator_cancelled_key ON harness_shared.event_awaits USING btree (workspace_id, subscriber_id, event_key) WHERE ((cancelled_at IS NOT NULL) AND (cancel_reason = 'operator'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_pattern_active",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_pattern_active ON harness_shared.event_awaits USING btree (workspace_id) WHERE ((event_key ~~ '%*%'::text) AND (fired_at IS NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_pkey",
      "table": "event_awaits",
      "definition": "CREATE UNIQUE INDEX event_awaits_pkey ON harness_shared.event_awaits USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_standing_exact_key_active",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_standing_exact_key_active ON harness_shared.event_awaits USING btree (workspace_id, event_key) WHERE ((once = false) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_awaits_verified_timeout_due",
      "table": "event_awaits",
      "definition": "CREATE INDEX event_awaits_verified_timeout_due ON harness_shared.event_awaits USING btree (expires_ts) WHERE ((producer_health IS NOT NULL) AND (fired_at IS NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_key_fires_pkey",
      "table": "event_key_fires",
      "definition": "CREATE UNIQUE INDEX event_key_fires_pkey ON harness_shared.event_key_fires USING btree (workspace_id, event_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_embedding_hnsw_idx",
      "table": "event_key_registry",
      "definition": "CREATE INDEX event_key_registry_embedding_hnsw_idx ON harness_shared.event_key_registry USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_pkey",
      "table": "event_key_registry",
      "definition": "CREATE UNIQUE INDEX event_key_registry_pkey ON harness_shared.event_key_registry USING btree (workspace_id, event_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_review_pending_idx",
      "table": "event_key_registry",
      "definition": "CREATE INDEX event_key_registry_review_pending_idx ON harness_shared.event_key_registry USING btree (review_status) WHERE (review_status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_tags_idx",
      "table": "event_key_registry",
      "definition": "CREATE INDEX event_key_registry_tags_idx ON harness_shared.event_key_registry USING gin (tags)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_title_tsv_idx",
      "table": "event_key_registry",
      "definition": "CREATE INDEX event_key_registry_title_tsv_idx ON harness_shared.event_key_registry USING gin (title_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_key_registry_underived_idx",
      "table": "event_key_registry",
      "definition": "CREATE INDEX event_key_registry_underived_idx ON harness_shared.event_key_registry USING btree (workspace_id, status) WHERE ((derived_at IS NULL) OR (emitter_exists IS FALSE))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_reactions_contributor_idx",
      "table": "event_reactions",
      "definition": "CREATE INDEX event_reactions_contributor_idx ON harness_shared.event_reactions USING btree (workspace_id, contributor, fired_at DESC) WHERE (contributor IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_reactions_pkey",
      "table": "event_reactions",
      "definition": "CREATE UNIQUE INDEX event_reactions_pkey ON harness_shared.event_reactions USING btree (dedup_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_reactions_rule_idx",
      "table": "event_reactions",
      "definition": "CREATE INDEX event_reactions_rule_idx ON harness_shared.event_reactions USING btree (rule_id, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_reactions_ws_fired_idx",
      "table": "event_reactions",
      "definition": "CREATE INDEX event_reactions_ws_fired_idx ON harness_shared.event_reactions USING btree (workspace_id, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_wake_attempts_pkey",
      "table": "event_wake_attempts",
      "definition": "CREATE UNIQUE INDEX event_wake_attempts_pkey ON harness_shared.event_wake_attempts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "event_wake_deliveries_await_lookup",
      "table": "event_wake_deliveries",
      "definition": "CREATE INDEX event_wake_deliveries_await_lookup ON harness_shared.event_wake_deliveries USING btree (workspace_id, await_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "event_wake_deliveries_pkey",
      "table": "event_wake_deliveries",
      "definition": "CREATE UNIQUE INDEX event_wake_deliveries_pkey ON harness_shared.event_wake_deliveries USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "executed_actions_consolidated_pkey",
      "table": "executed_actions_consolidated",
      "definition": "CREATE UNIQUE INDEX executed_actions_consolidated_pkey ON harness_shared.executed_actions_consolidated USING btree (harness_slug, action_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "executed_actions_consolidated_recent_idx",
      "table": "executed_actions_consolidated",
      "definition": "CREATE INDEX executed_actions_consolidated_recent_idx ON harness_shared.executed_actions_consolidated USING btree (harness_slug, executed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "experiment_runs_pkey",
      "table": "experiment_runs",
      "definition": "CREATE UNIQUE INDEX experiment_runs_pkey ON harness_shared.experiment_runs USING btree (workspace_id, battery_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "experiment_runs_ws_created_idx",
      "table": "experiment_runs",
      "definition": "CREATE INDEX experiment_runs_ws_created_idx ON harness_shared.experiment_runs USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "experiment_runs_ws_test_idx",
      "table": "experiment_runs",
      "definition": "CREATE INDEX experiment_runs_ws_test_idx ON harness_shared.experiment_runs USING btree (workspace_id, test_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "external_prerequisite_attestations_expiring_key",
      "table": "external_prerequisite_attestations",
      "definition": "CREATE INDEX external_prerequisite_attestations_expiring_key ON harness_shared.external_prerequisite_attestations USING btree (expires_at) WHERE (present = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "external_prerequisite_attestations_pkey",
      "table": "external_prerequisite_attestations",
      "definition": "CREATE UNIQUE INDEX external_prerequisite_attestations_pkey ON harness_shared.external_prerequisite_attestations USING btree (workspace_id, harness_slug, prerequisite_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "external_prerequisite_attestations_scope_expiry_key",
      "table": "external_prerequisite_attestations",
      "definition": "CREATE INDEX external_prerequisite_attestations_scope_expiry_key ON harness_shared.external_prerequisite_attestations USING btree (workspace_id, harness_slug, expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_audit_consolidated_lookup_idx",
      "table": "feature_audit_consolidated",
      "definition": "CREATE INDEX feature_audit_consolidated_lookup_idx ON harness_shared.feature_audit_consolidated USING btree (workspace_id, harness_slug, feature_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_audit_consolidated_pkey",
      "table": "feature_audit_consolidated",
      "definition": "CREATE UNIQUE INDEX feature_audit_consolidated_pkey ON harness_shared.feature_audit_consolidated USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "feature_claims_outcome_idx",
      "table": "feature_claims",
      "definition": "CREATE INDEX feature_claims_outcome_idx ON harness_shared.feature_claims USING btree (workspace_id, harness_slug, feature_id, outcome)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_claims_pkey",
      "table": "feature_claims",
      "definition": "CREATE UNIQUE INDEX feature_claims_pkey ON harness_shared.feature_claims USING btree (workspace_id, harness_slug, feature_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "feature_queue_feature_idx",
      "table": "feature_queue",
      "definition": "CREATE INDEX feature_queue_feature_idx ON harness_shared.feature_queue USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_queue_pkey",
      "table": "feature_queue",
      "definition": "CREATE UNIQUE INDEX feature_queue_pkey ON harness_shared.feature_queue USING btree (workspace_id, harness_slug, github_user_id, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "feature_queue_user_idx",
      "table": "feature_queue",
      "definition": "CREATE INDEX feature_queue_user_idx ON harness_shared.feature_queue USING btree (workspace_id, harness_slug, github_user_id) WHERE (removed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_working_set_feature_idx",
      "table": "feature_working_set",
      "definition": "CREATE INDEX feature_working_set_feature_idx ON harness_shared.feature_working_set USING btree (workspace_id, harness_slug, feature_id) WHERE (cleared_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "feature_working_set_pkey",
      "table": "feature_working_set",
      "definition": "CREATE UNIQUE INDEX feature_working_set_pkey ON harness_shared.feature_working_set USING btree (workspace_id, harness_slug, github_user_id, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "feature_working_set_user_idx",
      "table": "feature_working_set",
      "definition": "CREATE INDEX feature_working_set_user_idx ON harness_shared.feature_working_set USING btree (workspace_id, harness_slug, github_user_id) WHERE (cleared_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "federation_probes_pkey",
      "table": "federation_probes",
      "definition": "CREATE UNIQUE INDEX federation_probes_pkey ON harness_shared.federation_probes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "federation_probes_probe_key",
      "table": "federation_probes",
      "definition": "CREATE UNIQUE INDEX federation_probes_probe_key ON harness_shared.federation_probes USING btree (probe_key)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "federation_probes_recent",
      "table": "federation_probes",
      "definition": "CREATE INDEX federation_probes_recent ON harness_shared.federation_probes USING btree (workspace_id, harness_slug, emitted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "federation_refused_op_counters_pkey",
      "table": "federation_refused_op_counters",
      "definition": "CREATE UNIQUE INDEX federation_refused_op_counters_pkey ON harness_shared.federation_refused_op_counters USING btree (workspace_id, harness_slug, source_hive, table_tag, reason)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_brief_snapshots_pkey",
      "table": "fleet_brief_snapshots",
      "definition": "CREATE UNIQUE INDEX fleet_brief_snapshots_pkey ON harness_shared.fleet_brief_snapshots USING btree (workspace_id, fleet_slug, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_ekg_sessions_ended_idx",
      "table": "fleet_ekg_sessions",
      "definition": "CREATE INDEX fleet_ekg_sessions_ended_idx ON harness_shared.fleet_ekg_sessions USING btree (workspace_id, ended_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_ekg_sessions_pkey",
      "table": "fleet_ekg_sessions",
      "definition": "CREATE UNIQUE INDEX fleet_ekg_sessions_pkey ON harness_shared.fleet_ekg_sessions USING btree (workspace_id, owner_id, session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_ekg_shifts_dedup",
      "table": "fleet_ekg_shifts",
      "definition": "CREATE UNIQUE INDEX fleet_ekg_shifts_dedup ON harness_shared.fleet_ekg_shifts USING btree (workspace_id, feature, window_date)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_ekg_shifts_pkey",
      "table": "fleet_ekg_shifts",
      "definition": "CREATE UNIQUE INDEX fleet_ekg_shifts_pkey ON harness_shared.fleet_ekg_shifts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_ekg_shifts_recent_idx",
      "table": "fleet_ekg_shifts",
      "definition": "CREATE INDEX fleet_ekg_shifts_recent_idx ON harness_shared.fleet_ekg_shifts USING btree (workspace_id, window_date DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_governor_pkey",
      "table": "fleet_governor",
      "definition": "CREATE UNIQUE INDEX fleet_governor_pkey ON harness_shared.fleet_governor USING btree (workspace_id, kind, scope_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_invariants_active_idx",
      "table": "fleet_invariants",
      "definition": "CREATE INDEX fleet_invariants_active_idx ON harness_shared.fleet_invariants USING btree (workspace_id, fleet_slug) WHERE active",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_invariants_pkey",
      "table": "fleet_invariants",
      "definition": "CREATE UNIQUE INDEX fleet_invariants_pkey ON harness_shared.fleet_invariants USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_invariants_scope_name_idx",
      "table": "fleet_invariants",
      "definition": "CREATE UNIQUE INDEX fleet_invariants_scope_name_idx ON harness_shared.fleet_invariants USING btree (workspace_id, fleet_slug, name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_membership_events_fleet_idx",
      "table": "fleet_membership_events",
      "definition": "CREATE INDEX fleet_membership_events_fleet_idx ON harness_shared.fleet_membership_events USING btree (workspace_id, fleet_slug, id DESC) WHERE (fleet_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_membership_events_owner_idx",
      "table": "fleet_membership_events",
      "definition": "CREATE INDEX fleet_membership_events_owner_idx ON harness_shared.fleet_membership_events USING btree (workspace_id, owner_id, id DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_membership_events_pkey",
      "table": "fleet_membership_events",
      "definition": "CREATE UNIQUE INDEX fleet_membership_events_pkey ON harness_shared.fleet_membership_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_sagas_open_idx",
      "table": "fleet_sagas",
      "definition": "CREATE INDEX fleet_sagas_open_idx ON harness_shared.fleet_sagas USING btree (workspace_id, updated_at) WHERE (status = 'running'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_sagas_pkey",
      "table": "fleet_sagas",
      "definition": "CREATE UNIQUE INDEX fleet_sagas_pkey ON harness_shared.fleet_sagas USING btree (workspace_id, saga_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "fleet_tombstones_gc_idx",
      "table": "fleet_tombstones",
      "definition": "CREATE INDEX fleet_tombstones_gc_idx ON harness_shared.fleet_tombstones USING btree (workspace_id, gc_after) WHERE (restored_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "fleet_tombstones_pkey",
      "table": "fleet_tombstones",
      "definition": "CREATE UNIQUE INDEX fleet_tombstones_pkey ON harness_shared.fleet_tombstones USING btree (workspace_id, ref_kind, ref_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "flush_gate_refusals_pkey",
      "table": "flush_gate_refusals",
      "definition": "CREATE UNIQUE INDEX flush_gate_refusals_pkey ON harness_shared.flush_gate_refusals USING btree (boundary, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "frozen_repair_edit_ledger_agent_idx",
      "table": "frozen_repair_edit_ledger",
      "definition": "CREATE INDEX frozen_repair_edit_ledger_agent_idx ON harness_shared.frozen_repair_edit_ledger USING btree (candidate, agent, at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "frozen_repair_edit_ledger_idempotent",
      "table": "frozen_repair_edit_ledger",
      "definition": "CREATE UNIQUE INDEX frozen_repair_edit_ledger_idempotent ON harness_shared.frozen_repair_edit_ledger USING btree (workspace_id, install_slug, candidate, agent, path, tool_use_id, edit_index)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "frozen_repair_edit_ledger_lineage_path_idx",
      "table": "frozen_repair_edit_ledger",
      "definition": "CREATE INDEX frozen_repair_edit_ledger_lineage_path_idx ON harness_shared.frozen_repair_edit_ledger USING btree (workspace_id, install_slug, candidate, path, at_ms, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "frozen_repair_edit_ledger_pkey",
      "table": "frozen_repair_edit_ledger",
      "definition": "CREATE UNIQUE INDEX frozen_repair_edit_ledger_pkey ON harness_shared.frozen_repair_edit_ledger USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gate_decisions_decided_at_idx",
      "table": "gate_decisions",
      "definition": "CREATE INDEX gate_decisions_decided_at_idx ON harness_shared.gate_decisions USING btree (decided_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gate_decisions_gate_decided_at_idx",
      "table": "gate_decisions",
      "definition": "CREATE INDEX gate_decisions_gate_decided_at_idx ON harness_shared.gate_decisions USING btree (gate, decided_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gate_decisions_pkey",
      "table": "gate_decisions",
      "definition": "CREATE UNIQUE INDEX gate_decisions_pkey ON harness_shared.gate_decisions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gate_verdicts_pkey",
      "table": "gate_verdicts",
      "definition": "CREATE UNIQUE INDEX gate_verdicts_pkey ON harness_shared.gate_verdicts USING btree (workspace_id, verdict_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gate_verdicts_shard_inputs_idx",
      "table": "gate_verdicts",
      "definition": "CREATE INDEX gate_verdicts_shard_inputs_idx ON harness_shared.gate_verdicts USING btree (workspace_id, harness_slug, repo_key, shard_id, inputs_hash)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gate_verdicts_staging_sha_idx",
      "table": "gate_verdicts",
      "definition": "CREATE INDEX gate_verdicts_staging_sha_idx ON harness_shared.gate_verdicts USING btree (workspace_id, harness_slug, repo_key, staging_sha)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gateway_payload_blobs_expiry_idx",
      "table": "gateway_payload_blobs",
      "definition": "CREATE INDEX gateway_payload_blobs_expiry_idx ON harness_shared.gateway_payload_blobs USING btree (expires_at) WHERE (expires_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gateway_payload_blobs_gc_idx",
      "table": "gateway_payload_blobs",
      "definition": "CREATE INDEX gateway_payload_blobs_gc_idx ON harness_shared.gateway_payload_blobs USING btree (workspace_id, last_accessed_at) WHERE (ref_count = 0)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gateway_payload_blobs_pkey",
      "table": "gateway_payload_blobs",
      "definition": "CREATE UNIQUE INDEX gateway_payload_blobs_pkey ON harness_shared.gateway_payload_blobs USING btree (workspace_id, blob_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gateway_payload_chunks_pkey",
      "table": "gateway_payload_chunks",
      "definition": "CREATE UNIQUE INDEX gateway_payload_chunks_pkey ON harness_shared.gateway_payload_chunks USING btree (workspace_id, chunk_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gateway_stall_events_pkey",
      "table": "gateway_stall_events",
      "definition": "CREATE UNIQUE INDEX gateway_stall_events_pkey ON harness_shared.gateway_stall_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gateway_stall_events_recorded_at_idx",
      "table": "gateway_stall_events",
      "definition": "CREATE INDEX gateway_stall_events_recorded_at_idx ON harness_shared.gateway_stall_events USING btree (recorded_at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "git_export_outbox_drain_idx",
      "table": "git_export_outbox",
      "definition": "CREATE INDEX git_export_outbox_drain_idx ON harness_shared.git_export_outbox USING btree (workspace_id, harness_slug, exported_at, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "git_export_outbox_pkey",
      "table": "git_export_outbox",
      "definition": "CREATE UNIQUE INDEX git_export_outbox_pkey ON harness_shared.git_export_outbox USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "git_sync_commit_attr_repo_file_idx",
      "table": "git_sync_commit_attribution",
      "definition": "CREATE INDEX git_sync_commit_attr_repo_file_idx ON harness_shared.git_sync_commit_attribution USING btree (workspace_id, harness_slug, repo, file, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "git_sync_commit_attr_sha_idx",
      "table": "git_sync_commit_attribution",
      "definition": "CREATE INDEX git_sync_commit_attr_sha_idx ON harness_shared.git_sync_commit_attribution USING btree (commit_sha)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "git_sync_commit_attr_work_item_idx",
      "table": "git_sync_commit_attribution",
      "definition": "CREATE INDEX git_sync_commit_attr_work_item_idx ON harness_shared.git_sync_commit_attribution USING btree (work_item_id, ts DESC) WHERE (work_item_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "git_sync_commit_attribution_pkey",
      "table": "git_sync_commit_attribution",
      "definition": "CREATE UNIQUE INDEX git_sync_commit_attribution_pkey ON harness_shared.git_sync_commit_attribution USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "goal_pots_by_goal_idx",
      "table": "goal_pots",
      "definition": "CREATE INDEX goal_pots_by_goal_idx ON harness_shared.goal_pots USING btree (workspace_id, goal_id) WHERE (removed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goal_pots_by_harness_idx",
      "table": "goal_pots",
      "definition": "CREATE INDEX goal_pots_by_harness_idx ON harness_shared.goal_pots USING btree (workspace_id, harness_slug) WHERE (removed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goal_pots_live_pair_key",
      "table": "goal_pots",
      "definition": "CREATE UNIQUE INDEX goal_pots_live_pair_key ON harness_shared.goal_pots USING btree (workspace_id, goal_id, harness_slug) WHERE (removed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goal_pots_one_owner_per_pot",
      "table": "goal_pots",
      "definition": "CREATE UNIQUE INDEX goal_pots_one_owner_per_pot ON harness_shared.goal_pots USING btree (workspace_id, harness_slug) WHERE ((role = 'owner'::text) AND (removed_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goal_pots_pkey",
      "table": "goal_pots",
      "definition": "CREATE UNIQUE INDEX goal_pots_pkey ON harness_shared.goal_pots USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "goals_install_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_install_idx ON harness_shared.goals USING btree (install_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goals_parent_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_parent_idx ON harness_shared.goals USING btree (parent_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goals_pkey",
      "table": "goals",
      "definition": "CREATE UNIQUE INDEX goals_pkey ON harness_shared.goals USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "goals_search_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_search_idx ON harness_shared.goals USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goals_standing_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_standing_idx ON harness_shared.goals USING btree (workspace_id, install_slug) WHERE standing",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goals_status_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_status_idx ON harness_shared.goals USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "goals_workspace_idx",
      "table": "goals",
      "definition": "CREATE INDEX goals_workspace_idx ON harness_shared.goals USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_autoloop_config_pkey",
      "table": "gym_autoloop_config",
      "definition": "CREATE UNIQUE INDEX gym_autoloop_config_pkey ON harness_shared.gym_autoloop_config USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gym_champion_outcomes_pending_due_idx",
      "table": "gym_champion_outcomes",
      "definition": "CREATE INDEX gym_champion_outcomes_pending_due_idx ON harness_shared.gym_champion_outcomes USING btree (post_window_ends_at) WHERE (verdict = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_champion_outcomes_pkey",
      "table": "gym_champion_outcomes",
      "definition": "CREATE UNIQUE INDEX gym_champion_outcomes_pkey ON harness_shared.gym_champion_outcomes USING btree (proposal_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gym_champion_outcomes_ws_harness_accepted_idx",
      "table": "gym_champion_outcomes",
      "definition": "CREATE INDEX gym_champion_outcomes_ws_harness_accepted_idx ON harness_shared.gym_champion_outcomes USING btree (workspace_id, harness_slug, accepted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_proposals_candidate_verdict_idx",
      "table": "gym_proposals",
      "definition": "CREATE INDEX gym_proposals_candidate_verdict_idx ON harness_shared.gym_proposals USING btree (workspace_id, harness_slug) WHERE (candidate_verdict IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_proposals_pkey",
      "table": "gym_proposals",
      "definition": "CREATE UNIQUE INDEX gym_proposals_pkey ON harness_shared.gym_proposals USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gym_proposals_ws_harness_cycle_idx",
      "table": "gym_proposals",
      "definition": "CREATE INDEX gym_proposals_ws_harness_cycle_idx ON harness_shared.gym_proposals USING btree (workspace_id, harness_slug, cycle)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_proposals_ws_harness_status_idx",
      "table": "gym_proposals",
      "definition": "CREATE INDEX gym_proposals_ws_harness_status_idx ON harness_shared.gym_proposals USING btree (workspace_id, harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_archive_candidate_idx",
      "table": "gym_qd_archive",
      "definition": "CREATE INDEX gym_qd_archive_candidate_idx ON harness_shared.gym_qd_archive USING btree (workspace_id, harness_slug, candidate_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_archive_pkey",
      "table": "gym_qd_archive",
      "definition": "CREATE UNIQUE INDEX gym_qd_archive_pkey ON harness_shared.gym_qd_archive USING btree (workspace_id, harness_slug, niche_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_archive_source_idx",
      "table": "gym_qd_archive",
      "definition": "CREATE INDEX gym_qd_archive_source_idx ON harness_shared.gym_qd_archive USING btree (workspace_id, harness_slug, source)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_archive_ws_harness_fitness_idx",
      "table": "gym_qd_archive",
      "definition": "CREATE INDEX gym_qd_archive_ws_harness_fitness_idx ON harness_shared.gym_qd_archive USING btree (workspace_id, harness_slug, fitness DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_foreign_elites_by_source",
      "table": "gym_qd_foreign_elites",
      "definition": "CREATE INDEX gym_qd_foreign_elites_by_source ON harness_shared.gym_qd_foreign_elites USING btree (source_hive)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_foreign_elites_fitness_idx",
      "table": "gym_qd_foreign_elites",
      "definition": "CREATE INDEX gym_qd_foreign_elites_fitness_idx ON harness_shared.gym_qd_foreign_elites USING btree (workspace_id, harness_slug, fitness DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "gym_qd_foreign_elites_pkey",
      "table": "gym_qd_foreign_elites",
      "definition": "CREATE UNIQUE INDEX gym_qd_foreign_elites_pkey ON harness_shared.gym_qd_foreign_elites USING btree (workspace_id, harness_slug, niche_key, source_hive)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_archives_pkey",
      "table": "harness_archives",
      "definition": "CREATE UNIQUE INDEX harness_archives_pkey ON harness_shared.harness_archives USING btree (harness_slug, phase, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_archives_slug_phase_ts_idx",
      "table": "harness_archives",
      "definition": "CREATE INDEX harness_archives_slug_phase_ts_idx ON harness_shared.harness_archives USING btree (harness_slug, phase, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_brainstorm_content_embedding_hnsw",
      "table": "harness_brainstorm",
      "definition": "CREATE INDEX harness_brainstorm_content_embedding_hnsw ON harness_shared.harness_brainstorm USING hnsw (content_embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_brainstorm_content_embedding_mode_idx",
      "table": "harness_brainstorm",
      "definition": "CREATE INDEX harness_brainstorm_content_embedding_mode_idx ON harness_shared.harness_brainstorm USING btree (content_embedding_mode) WHERE (content_embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_brainstorm_pkey",
      "table": "harness_brainstorm",
      "definition": "CREATE UNIQUE INDEX harness_brainstorm_pkey ON harness_shared.harness_brainstorm USING btree (harness_slug, phase)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_brainstorm_tsv_idx",
      "table": "harness_brainstorm",
      "definition": "CREATE INDEX harness_brainstorm_tsv_idx ON harness_shared.harness_brainstorm USING gin (content_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_brainstorm_workspace_idx",
      "table": "harness_brainstorm",
      "definition": "CREATE INDEX harness_brainstorm_workspace_idx ON harness_shared.harness_brainstorm USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_checkpoints_pkey",
      "table": "harness_checkpoints",
      "definition": "CREATE UNIQUE INDEX harness_checkpoints_pkey ON harness_shared.harness_checkpoints USING btree (harness_slug, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_checkpoints_slug_waiting_idx",
      "table": "harness_checkpoints",
      "definition": "CREATE INDEX harness_checkpoints_slug_waiting_idx ON harness_shared.harness_checkpoints USING btree (harness_slug, waiting_since_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_chunk_plans_pkey",
      "table": "harness_chunk_plans",
      "definition": "CREATE UNIQUE INDEX harness_chunk_plans_pkey ON harness_shared.harness_chunk_plans USING btree (workspace_id, harness_slug, feature_id, chunk_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_decisions_body_embedding_hnsw",
      "table": "harness_decisions",
      "definition": "CREATE INDEX harness_decisions_body_embedding_hnsw ON harness_shared.harness_decisions USING hnsw (body_embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_decisions_body_embedding_mode_idx",
      "table": "harness_decisions",
      "definition": "CREATE INDEX harness_decisions_body_embedding_mode_idx ON harness_shared.harness_decisions USING btree (body_embedding_mode) WHERE (body_embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_decisions_body_tsv_idx",
      "table": "harness_decisions",
      "definition": "CREATE INDEX harness_decisions_body_tsv_idx ON harness_shared.harness_decisions USING gin (body_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_decisions_pkey",
      "table": "harness_decisions",
      "definition": "CREATE UNIQUE INDEX harness_decisions_pkey ON harness_shared.harness_decisions USING btree (harness_slug, line_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_decisions_slug_ts_idx",
      "table": "harness_decisions",
      "definition": "CREATE INDEX harness_decisions_slug_ts_idx ON harness_shared.harness_decisions USING btree (harness_slug, ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_design_artifacts_pkey",
      "table": "harness_design_artifacts",
      "definition": "CREATE UNIQUE INDEX harness_design_artifacts_pkey ON harness_shared.harness_design_artifacts USING btree (harness_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_doc_parts_by_doc",
      "table": "harness_doc_parts",
      "definition": "CREATE INDEX harness_doc_parts_by_doc ON harness_shared.harness_doc_parts USING btree (workspace_id, harness_slug, doc_id, ordinal)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_doc_parts_pkey",
      "table": "harness_doc_parts",
      "definition": "CREATE UNIQUE INDEX harness_doc_parts_pkey ON harness_shared.harness_doc_parts USING btree (workspace_id, harness_slug, doc_id, part_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_doc_parts_projection_idx",
      "table": "harness_doc_parts",
      "definition": "CREATE INDEX harness_doc_parts_projection_idx ON harness_shared.harness_doc_parts USING gin (client_scope) WHERE ((tombstone = false) AND (cardinality(client_scope) > 0))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_doc_parts_stack_scope_idx",
      "table": "harness_doc_parts",
      "definition": "CREATE INDEX harness_doc_parts_stack_scope_idx ON harness_shared.harness_doc_parts USING gin (stack_scope) WHERE ((tombstone = false) AND (cardinality(stack_scope) > 0))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_dock_layouts_pkey",
      "table": "harness_dock_layouts",
      "definition": "CREATE UNIQUE INDEX harness_dock_layouts_pkey ON harness_shared.harness_dock_layouts USING btree (workspace_id, user_id, layout_name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_docs_anchor_paths_idx",
      "table": "harness_docs",
      "definition": "CREATE INDEX harness_docs_anchor_paths_idx ON harness_shared.harness_docs USING gin (anchor_paths)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_docs_live_authored_idx",
      "table": "harness_docs",
      "definition": "CREATE INDEX harness_docs_live_authored_idx ON harness_shared.harness_docs USING btree (workspace_id, harness_slug) WHERE ((retired_at IS NULL) AND (content_mode = 'authored'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_docs_pkey",
      "table": "harness_docs",
      "definition": "CREATE UNIQUE INDEX harness_docs_pkey ON harness_shared.harness_docs USING btree (workspace_id, harness_slug, doc_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_docs_search_idx",
      "table": "harness_docs",
      "definition": "CREATE INDEX harness_docs_search_idx ON harness_shared.harness_docs USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_docs_status_idx",
      "table": "harness_docs",
      "definition": "CREATE INDEX harness_docs_status_idx ON harness_shared.harness_docs USING btree (workspace_id, harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_escalations_body_embedding_hnsw",
      "table": "harness_escalations",
      "definition": "CREATE INDEX harness_escalations_body_embedding_hnsw ON harness_shared.harness_escalations USING hnsw (body_embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_escalations_body_embedding_mode_idx",
      "table": "harness_escalations",
      "definition": "CREATE INDEX harness_escalations_body_embedding_mode_idx ON harness_shared.harness_escalations USING btree (body_embedding_mode) WHERE (body_embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_escalations_pkey",
      "table": "harness_escalations",
      "definition": "CREATE UNIQUE INDEX harness_escalations_pkey ON harness_shared.harness_escalations USING btree (harness_slug, phase)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_escalations_tsv_idx",
      "table": "harness_escalations",
      "definition": "CREATE INDEX harness_escalations_tsv_idx ON harness_shared.harness_escalations USING gin (body_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_feature_debug_notes_pkey",
      "table": "harness_feature_debug_notes",
      "definition": "CREATE UNIQUE INDEX harness_feature_debug_notes_pkey ON harness_shared.harness_feature_debug_notes USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_feature_notes_harness_idx",
      "table": "harness_feature_notes",
      "definition": "CREATE INDEX harness_feature_notes_harness_idx ON harness_shared.harness_feature_notes USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_feature_notes_pkey",
      "table": "harness_feature_notes",
      "definition": "CREATE UNIQUE INDEX harness_feature_notes_pkey ON harness_shared.harness_feature_notes USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_feature_prs_pkey",
      "table": "harness_feature_prs",
      "definition": "CREATE UNIQUE INDEX harness_feature_prs_pkey ON harness_shared.harness_feature_prs USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_features_consolidated_claimed_progress_idx",
      "table": "work_items",
      "definition": "CREATE INDEX harness_features_consolidated_claimed_progress_idx ON harness_shared.work_items USING btree (harness_slug, last_progress_at) WHERE ((taken_by IS NOT NULL) AND (taken_by <> ''::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_generator_items_pkey",
      "table": "harness_generator_items",
      "definition": "CREATE UNIQUE INDEX harness_generator_items_pkey ON harness_shared.harness_generator_items USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_hook_logs_pkey",
      "table": "harness_hook_logs",
      "definition": "CREATE UNIQUE INDEX harness_hook_logs_pkey ON harness_shared.harness_hook_logs USING btree (harness_slug, log_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_hook_logs_slug_ts_idx",
      "table": "harness_hook_logs",
      "definition": "CREATE INDEX harness_hook_logs_slug_ts_idx ON harness_shared.harness_hook_logs USING btree (harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_issues_consolidated_pkey",
      "table": "harness_issues_consolidated",
      "definition": "CREATE UNIQUE INDEX harness_issues_consolidated_pkey ON harness_shared.harness_issues_consolidated USING btree (harness_slug, issue_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_lanes_pkey",
      "table": "harness_lanes",
      "definition": "CREATE UNIQUE INDEX harness_lanes_pkey ON harness_shared.harness_lanes USING btree (harness_slug, phase, role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_lanes_started_idx",
      "table": "harness_lanes",
      "definition": "CREATE INDEX harness_lanes_started_idx ON harness_shared.harness_lanes USING btree (started_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_lanes_workspace_idx",
      "table": "harness_lanes",
      "definition": "CREATE INDEX harness_lanes_workspace_idx ON harness_shared.harness_lanes USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_mission_state_pkey",
      "table": "harness_mission_state",
      "definition": "CREATE UNIQUE INDEX harness_mission_state_pkey ON harness_shared.harness_mission_state USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_pending_issues_pkey",
      "table": "harness_pending_issues",
      "definition": "CREATE UNIQUE INDEX harness_pending_issues_pkey ON harness_shared.harness_pending_issues USING btree (harness_slug, phase, issue_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_phase_last_used_pkey",
      "table": "harness_phase_last_used",
      "definition": "CREATE UNIQUE INDEX harness_phase_last_used_pkey ON harness_shared.harness_phase_last_used USING btree (workspace_id, harness_slug, user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_plan_assertions_pkey",
      "table": "harness_plan_assertions",
      "definition": "CREATE UNIQUE INDEX harness_plan_assertions_pkey ON harness_shared.harness_plan_assertions USING btree (workspace_id, harness_slug, val_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_plan_parts_by_plan",
      "table": "harness_plan_parts",
      "definition": "CREATE INDEX harness_plan_parts_by_plan ON harness_shared.harness_plan_parts USING btree (workspace_id, harness_slug, plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plan_parts_pkey",
      "table": "harness_plan_parts",
      "definition": "CREATE UNIQUE INDEX harness_plan_parts_pkey ON harness_shared.harness_plan_parts USING btree (workspace_id, harness_slug, plan_slug, part_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_plan_status_pkey",
      "table": "harness_plan_status",
      "definition": "CREATE UNIQUE INDEX harness_plan_status_pkey ON harness_shared.harness_plan_status USING btree (workspace_id, harness_slug, plan_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_acceptance_bar_unseeded",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_acceptance_bar_unseeded ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, plan_slug) WHERE ((acceptance_bar_epoch IS NOT NULL) AND (acceptance_bar_set_hash IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_embedding_hnsw_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_embedding_hnsw_idx ON harness_shared.harness_plans USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_embedding_mode_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_embedding_mode_idx ON harness_shared.harness_plans USING btree (embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_goal_id_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_goal_id_idx ON harness_shared.harness_plans USING btree (workspace_id, goal_id) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_one_active_acceptance_per_subject_plan",
      "table": "harness_plans",
      "definition": "CREATE UNIQUE INDEX harness_plans_one_active_acceptance_per_subject_plan ON harness_shared.harness_plans USING btree (workspace_id, ((template_data ->> 'subjectPlan'::text))) WHERE ((template = 'rubric'::text) AND (template_slug IS NULL) AND (archived = false) AND (status = ANY (ARRAY['active'::text, 'ready'::text])) AND ((template_data ->> 'kind'::text) = 'acceptance'::text) AND (NULLIF((template_data ->> 'subjectPlan'::text), ''::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_pkey",
      "table": "harness_plans",
      "definition": "CREATE UNIQUE INDEX harness_plans_pkey ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, plan_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_schedule_active_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_schedule_active_idx ON harness_shared.harness_plans USING btree (workspace_id, harness_slug) WHERE (schedule_active = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_search_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_search_idx ON harness_shared.harness_plans USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_started_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_started_idx ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, op_status) WHERE (op_status = 'started'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_template_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_template_idx ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, template_slug) WHERE (template_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_plans_ws_harness_status_updated_idx",
      "table": "harness_plans",
      "definition": "CREATE INDEX harness_plans_ws_harness_status_updated_idx ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, status, updated_at) WHERE (archived = false)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_project_files_pkey",
      "table": "harness_project_files",
      "definition": "CREATE UNIQUE INDEX harness_project_files_pkey ON harness_shared.harness_project_files USING btree (harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_project_files_workspace_idx",
      "table": "harness_project_files",
      "definition": "CREATE INDEX harness_project_files_workspace_idx ON harness_shared.harness_project_files USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_promotions_pkey",
      "table": "harness_promotions",
      "definition": "CREATE UNIQUE INDEX harness_promotions_pkey ON harness_shared.harness_promotions USING btree (workspace_id, harness_slug, promotion_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_promotions_ts_idx",
      "table": "harness_promotions",
      "definition": "CREATE INDEX harness_promotions_ts_idx ON harness_shared.harness_promotions USING btree (workspace_id, harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_prompt_overrides_pkey",
      "table": "harness_prompt_overrides",
      "definition": "CREATE UNIQUE INDEX harness_prompt_overrides_pkey ON harness_shared.harness_prompt_overrides USING btree (workspace_id, harness_slug, role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_proposals_shared_pkey",
      "table": "harness_proposals_shared",
      "definition": "CREATE UNIQUE INDEX harness_proposals_shared_pkey ON harness_shared.harness_proposals_shared USING btree (harness_slug, phase, proposal_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_proposals_shared_slug_ts_idx",
      "table": "harness_proposals_shared",
      "definition": "CREATE INDEX harness_proposals_shared_slug_ts_idx ON harness_shared.harness_proposals_shared USING btree (harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_proposals_shared_status_idx",
      "table": "harness_proposals_shared",
      "definition": "CREATE INDEX harness_proposals_shared_status_idx ON harness_shared.harness_proposals_shared USING btree (harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_proposals_shared_workspace_idx",
      "table": "harness_proposals_shared",
      "definition": "CREATE INDEX harness_proposals_shared_workspace_idx ON harness_shared.harness_proposals_shared USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_registry_pkey",
      "table": "harness_registry",
      "definition": "CREATE UNIQUE INDEX harness_registry_pkey ON harness_shared.harness_registry USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_run_chunks_pkey",
      "table": "harness_run_chunks",
      "definition": "CREATE UNIQUE INDEX harness_run_chunks_pkey ON harness_shared.harness_run_chunks USING btree (workspace_id, harness_slug, run_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_run_chunks_run_idx",
      "table": "harness_run_chunks",
      "definition": "CREATE INDEX harness_run_chunks_run_idx ON harness_shared.harness_run_chunks USING btree (workspace_id, harness_slug, run_id, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_run_output_pkey",
      "table": "harness_run_output",
      "definition": "CREATE UNIQUE INDEX harness_run_output_pkey ON harness_shared.harness_run_output USING btree (workspace_id, harness_slug, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_run_output_recent_idx",
      "table": "harness_run_output",
      "definition": "CREATE INDEX harness_run_output_recent_idx ON harness_shared.harness_run_output USING btree (workspace_id, harness_slug, ended_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_screenshots_pkey",
      "table": "harness_screenshots",
      "definition": "CREATE UNIQUE INDEX harness_screenshots_pkey ON harness_shared.harness_screenshots USING btree (harness_slug, phase, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_screenshots_slug_phase_ts_idx",
      "table": "harness_screenshots",
      "definition": "CREATE INDEX harness_screenshots_slug_phase_ts_idx ON harness_shared.harness_screenshots USING btree (harness_slug, phase, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_skills_lookup_idx",
      "table": "harness_skills",
      "definition": "CREATE INDEX harness_skills_lookup_idx ON harness_shared.harness_skills USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_skills_pkey",
      "table": "harness_skills",
      "definition": "CREATE UNIQUE INDEX harness_skills_pkey ON harness_shared.harness_skills USING btree (workspace_id, harness_slug, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_smoke_test_pkey",
      "table": "harness_smoke_test",
      "definition": "CREATE UNIQUE INDEX harness_smoke_test_pkey ON harness_shared.harness_smoke_test USING btree (harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_snapshots_consolidated_pkey",
      "table": "harness_snapshots_consolidated",
      "definition": "CREATE UNIQUE INDEX harness_snapshots_consolidated_pkey ON harness_shared.harness_snapshots_consolidated USING btree (harness_slug, snapshot_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_snapshots_pkey",
      "table": "harness_snapshots",
      "definition": "CREATE UNIQUE INDEX harness_snapshots_pkey ON harness_shared.harness_snapshots USING btree (workspace_id, harness_slug, snapshot_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_snapshots_recent_idx",
      "table": "harness_snapshots",
      "definition": "CREATE INDEX harness_snapshots_recent_idx ON harness_shared.harness_snapshots USING btree (workspace_id, harness_slug, taken_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_status_expires_idx",
      "table": "harness_status",
      "definition": "CREATE INDEX harness_status_expires_idx ON harness_shared.harness_status USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_status_pkey",
      "table": "harness_status",
      "definition": "CREATE UNIQUE INDEX harness_status_pkey ON harness_shared.harness_status USING btree (harness_slug, phase)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_status_updated_idx",
      "table": "harness_status",
      "definition": "CREATE INDEX harness_status_updated_idx ON harness_shared.harness_status USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_status_workspace_idx",
      "table": "harness_status",
      "definition": "CREATE INDEX harness_status_workspace_idx ON harness_shared.harness_status USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "harness_tests_pkey",
      "table": "harness_tests",
      "definition": "CREATE UNIQUE INDEX harness_tests_pkey ON harness_shared.harness_tests USING btree (harness_slug, phase, test_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "harness_text_artifacts_pkey",
      "table": "harness_text_artifacts",
      "definition": "CREATE UNIQUE INDEX harness_text_artifacts_pkey ON harness_shared.harness_text_artifacts USING btree (harness_slug, rel_path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "hda_created_idx",
      "table": "harness_design_artifacts",
      "definition": "CREATE INDEX hda_created_idx ON harness_shared.harness_design_artifacts USING btree (harness_slug, created_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hda_feature_idx",
      "table": "harness_design_artifacts",
      "definition": "CREATE INDEX hda_feature_idx ON harness_shared.harness_design_artifacts USING btree (harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hda_kind_idx",
      "table": "harness_design_artifacts",
      "definition": "CREATE INDEX hda_kind_idx ON harness_shared.harness_design_artifacts USING btree (harness_slug, feature_id, kind)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_audit_pending_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_audit_pending_idx ON harness_shared.work_items USING btree (harness_slug) WHERE ((origin = 'remote'::text) AND ((audit_verdict IS NULL) OR (audit_verdict = 'pending'::text)))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_design_status_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_design_status_idx ON harness_shared.work_items USING btree (harness_slug, design_status) WHERE (design_status IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_item_kind_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_item_kind_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, item_kind)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_needs_design_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_needs_design_idx ON harness_shared.work_items USING btree (harness_slug, needs_design) WHERE (needs_design = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_origin_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_origin_idx ON harness_shared.work_items USING btree (harness_slug, origin) WHERE (origin = 'remote'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_pending_done_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_pending_done_idx ON harness_shared.work_items USING btree (status) WHERE ((status = 'pending_done'::text) AND (completion_ref IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_plan_wave_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_plan_wave_idx ON harness_shared.work_items USING btree (source_plan_slug, wave) WHERE (source_plan_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_review_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_review_idx ON harness_shared.work_items USING btree (needs_human_review)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_search_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_search_idx ON harness_shared.work_items USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_slug_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_slug_idx ON harness_shared.work_items USING btree (harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_source_plan_run_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_source_plan_run_idx ON harness_shared.work_items USING btree ((((payload -> 'plan_run'::text) ->> 'runId'::text))) WHERE (((payload -> 'plan_run'::text) ->> 'runId'::text) IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_source_plan_slug_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_source_plan_slug_idx ON harness_shared.work_items USING btree (source_plan_slug) WHERE (source_plan_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_status_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_status_idx ON harness_shared.work_items USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_taken_by_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_taken_by_idx ON harness_shared.work_items USING btree (workspace_id, taken_by) WHERE (taken_by IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_updated_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_updated_idx ON harness_shared.work_items USING btree (updated_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfc_workspace_idx",
      "table": "work_items",
      "definition": "CREATE INDEX hfc_workspace_idx ON harness_shared.work_items USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfdn_harness_idx",
      "table": "harness_feature_debug_notes",
      "definition": "CREATE INDEX hfdn_harness_idx ON harness_shared.harness_feature_debug_notes USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hfp_harness_idx",
      "table": "harness_feature_prs",
      "definition": "CREATE INDEX hfp_harness_idx ON harness_shared.harness_feature_prs USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_found_during_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_found_during_idx ON harness_shared.harness_issues_consolidated USING btree (found_during)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_linked_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_linked_idx ON harness_shared.harness_issues_consolidated USING btree (linked_feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_origin_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_origin_idx ON harness_shared.harness_issues_consolidated USING btree (harness_slug, origin) WHERE (origin = 'remote'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_severity_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_severity_idx ON harness_shared.harness_issues_consolidated USING btree (harness_slug, severity)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_status_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_status_idx ON harness_shared.harness_issues_consolidated USING btree (harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hic_workspace_idx",
      "table": "harness_issues_consolidated",
      "definition": "CREATE INDEX hic_workspace_idx ON harness_shared.harness_issues_consolidated USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hidden_plugins_basename_idx",
      "table": "hidden_plugins",
      "definition": "CREATE INDEX hidden_plugins_basename_idx ON harness_shared.hidden_plugins USING btree (basename)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hidden_plugins_pkey",
      "table": "hidden_plugins",
      "definition": "CREATE UNIQUE INDEX hidden_plugins_pkey ON harness_shared.hidden_plugins USING btree (workspace_id, basename)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "hive_epoch_keys_by_member",
      "table": "pot_epoch_keys",
      "definition": "CREATE INDEX hive_epoch_keys_by_member ON harness_shared.pot_epoch_keys USING btree (workspace_id, harness_slug, member_device_pubkey, epoch)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hive_pending_joins_by_status",
      "table": "pot_pending_joins",
      "definition": "CREATE INDEX hive_pending_joins_by_status ON harness_shared.pot_pending_joins USING btree (workspace_id, harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hive_reports_by_status",
      "table": "pot_reports",
      "definition": "CREATE INDEX hive_reports_by_status ON harness_shared.pot_reports USING btree (workspace_id, harness_slug, status, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hlc_clock_pkey",
      "table": "hlc_clock",
      "definition": "CREATE UNIQUE INDEX hlc_clock_pkey ON harness_shared.hlc_clock USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "host_kernel_memory_samples_pkey",
      "table": "host_kernel_memory_samples",
      "definition": "CREATE UNIQUE INDEX host_kernel_memory_samples_pkey ON harness_shared.host_kernel_memory_samples USING btree (boot_id, bucket_at)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "host_kernel_memory_samples_sampled_at_idx",
      "table": "host_kernel_memory_samples",
      "definition": "CREATE INDEX host_kernel_memory_samples_sampled_at_idx ON harness_shared.host_kernel_memory_samples USING btree (sampled_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hpa_plan_item_idx",
      "table": "harness_plan_assertions",
      "definition": "CREATE INDEX hpa_plan_item_idx ON harness_shared.harness_plan_assertions USING btree (workspace_id, harness_slug, plan_slug, item_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hpa_requires_test_idx",
      "table": "harness_plan_assertions",
      "definition": "CREATE INDEX hpa_requires_test_idx ON harness_shared.harness_plan_assertions USING btree (workspace_id, harness_slug) WHERE (NOT requires_test)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hps_started_idx",
      "table": "harness_plan_status",
      "definition": "CREATE INDEX hps_started_idx ON harness_shared.harness_plan_status USING btree (workspace_id, harness_slug, status) WHERE (status = 'started'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hsc_iter_idx",
      "table": "harness_snapshots_consolidated",
      "definition": "CREATE INDEX hsc_iter_idx ON harness_shared.harness_snapshots_consolidated USING btree (harness_slug, iter_num DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hsc_ts_idx",
      "table": "harness_snapshots_consolidated",
      "definition": "CREATE INDEX hsc_ts_idx ON harness_shared.harness_snapshots_consolidated USING btree (harness_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hta_updated_idx",
      "table": "harness_text_artifacts",
      "definition": "CREATE INDEX hta_updated_idx ON harness_shared.harness_text_artifacts USING btree (harness_slug, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "hta_workspace_idx",
      "table": "harness_text_artifacts",
      "definition": "CREATE INDEX hta_workspace_idx ON harness_shared.harness_text_artifacts USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "identity_files_pkey",
      "table": "identity_files",
      "definition": "CREATE UNIQUE INDEX identity_files_pkey ON harness_shared.identity_files USING btree (role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "identity_files_workspace_idx",
      "table": "identity_files",
      "definition": "CREATE INDEX identity_files_workspace_idx ON harness_shared.identity_files USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "identity_hook_turns_pkey",
      "table": "identity_hook_turns",
      "definition": "CREATE UNIQUE INDEX identity_hook_turns_pkey ON harness_shared.identity_hook_turns USING btree (workspace_id, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "identity_release_funding_pkey",
      "table": "identity_release_funding",
      "definition": "CREATE UNIQUE INDEX identity_release_funding_pkey ON harness_shared.identity_release_funding USING btree (workspace_id, sku_ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "idx_agent_chat_locks_started_at",
      "table": "agent_chat_locks",
      "definition": "CREATE INDEX idx_agent_chat_locks_started_at ON harness_shared.agent_chat_locks USING btree (started_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_agent_loop_approvals_pending",
      "table": "agent_loop_approvals",
      "definition": "CREATE INDEX idx_agent_loop_approvals_pending ON harness_shared.agent_loop_approvals USING btree (chat_id, requested_at) WHERE (status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_agent_loop_sessions_updated",
      "table": "agent_loop_sessions",
      "definition": "CREATE INDEX idx_agent_loop_sessions_updated ON harness_shared.agent_loop_sessions USING btree (workspace_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_chunk_plans_by_feature",
      "table": "harness_chunk_plans",
      "definition": "CREATE INDEX idx_chunk_plans_by_feature ON harness_shared.harness_chunk_plans USING btree (workspace_id, harness_slug, feature_id, chunk_index)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_chunk_plans_by_status",
      "table": "harness_chunk_plans",
      "definition": "CREATE INDEX idx_chunk_plans_by_status ON harness_shared.harness_chunk_plans USING btree (workspace_id, harness_slug, status) WHERE (status = ANY (ARRAY['in_progress'::text, 'failing'::text, 'escalated'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_awaits_active_key",
      "table": "event_awaits",
      "definition": "CREATE INDEX idx_event_awaits_active_key ON harness_shared.event_awaits USING btree (workspace_id, event_key) WHERE ((fired_at IS NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_awaits_expiry",
      "table": "event_awaits",
      "definition": "CREATE INDEX idx_event_awaits_expiry ON harness_shared.event_awaits USING btree (expires_ts) WHERE ((fired_at IS NULL) AND (cancelled_at IS NULL) AND (expires_ts IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_awaits_subscriber",
      "table": "event_awaits",
      "definition": "CREATE INDEX idx_event_awaits_subscriber ON harness_shared.event_awaits USING btree (subscriber_id) WHERE ((fired_at IS NULL) AND (cancelled_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_wake_attempts_subscriber_key_time",
      "table": "event_wake_attempts",
      "definition": "CREATE INDEX idx_event_wake_attempts_subscriber_key_time ON harness_shared.event_wake_attempts USING btree (workspace_id, subscriber_id, event_key, attempted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_wake_deliveries_due",
      "table": "event_wake_deliveries",
      "definition": "CREATE INDEX idx_event_wake_deliveries_due ON harness_shared.event_wake_deliveries USING btree (workspace_id, next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_event_wake_deliveries_subscriber",
      "table": "event_wake_deliveries",
      "definition": "CREATE INDEX idx_event_wake_deliveries_subscriber ON harness_shared.event_wake_deliveries USING btree (subscriber_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_flush_gate_refusals_expires",
      "table": "flush_gate_refusals",
      "definition": "CREATE INDEX idx_flush_gate_refusals_expires ON harness_shared.flush_gate_refusals USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_plugin_kv_prefix",
      "table": "plugin_kv",
      "definition": "CREATE INDEX idx_plugin_kv_prefix ON harness_shared.plugin_kv USING btree (plugin_id, harness_slug, key text_pattern_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_plugin_kv_quota",
      "table": "plugin_kv",
      "definition": "CREATE INDEX idx_plugin_kv_quota ON harness_shared.plugin_kv USING btree (plugin_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_session_respawn_expected_expires",
      "table": "session_respawn_expected",
      "definition": "CREATE INDEX idx_session_respawn_expected_expires ON harness_shared.session_respawn_expected USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_shealth_ticks_at",
      "table": "system_health_ticks",
      "definition": "CREATE INDEX idx_shealth_ticks_at ON harness_shared.system_health_ticks USING btree (at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_shealth_transitions_ws_at",
      "table": "system_health_transitions",
      "definition": "CREATE INDEX idx_shealth_transitions_ws_at ON harness_shared.system_health_transitions USING btree (workspace_id, at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_shealth_transitions_ws_panel_at",
      "table": "system_health_transitions",
      "definition": "CREATE INDEX idx_shealth_transitions_ws_panel_at ON harness_shared.system_health_transitions USING btree (workspace_id, panel, at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_usage_events_kind",
      "table": "contributor_usage_events",
      "definition": "CREATE INDEX idx_usage_events_kind ON harness_shared.contributor_usage_events USING btree (harness_slug, kind, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "idx_usage_events_user",
      "table": "contributor_usage_events",
      "definition": "CREATE INDEX idx_usage_events_user ON harness_shared.contributor_usage_events USING btree (harness_slug, github_user_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "improvement_dispatches_open_item_idx",
      "table": "improvement_dispatches",
      "definition": "CREATE INDEX improvement_dispatches_open_item_idx ON harness_shared.improvement_dispatches USING btree (item_id) WHERE (outcome IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "improvement_dispatches_pkey",
      "table": "improvement_dispatches",
      "definition": "CREATE UNIQUE INDEX improvement_dispatches_pkey ON harness_shared.improvement_dispatches USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "improvement_dispatches_ws_fired_at_idx",
      "table": "improvement_dispatches",
      "definition": "CREATE INDEX improvement_dispatches_ws_fired_at_idx ON harness_shared.improvement_dispatches USING btree (workspace_id, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "improvement_dispatches_ws_pot_fired_at_idx",
      "table": "improvement_dispatches",
      "definition": "CREATE INDEX improvement_dispatches_ws_pot_fired_at_idx ON harness_shared.improvement_dispatches USING btree (workspace_id, pot_slug, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "insights_first_visit_pkey",
      "table": "insights_first_visit",
      "definition": "CREATE UNIQUE INDEX insights_first_visit_pkey ON harness_shared.insights_first_visit USING btree (workspace_id, harness_slug, user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "interactive_usage_files_pkey",
      "table": "interactive_usage_files",
      "definition": "CREATE UNIQUE INDEX interactive_usage_files_pkey ON harness_shared.interactive_usage_files USING btree (workspace_id, file_path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "interest_watches_due_idx",
      "table": "interest_watches",
      "definition": "CREATE INDEX interest_watches_due_idx ON harness_shared.interest_watches USING btree (last_swept_at NULLS FIRST) WHERE active",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "interest_watches_pkey",
      "table": "interest_watches",
      "definition": "CREATE UNIQUE INDEX interest_watches_pkey ON harness_shared.interest_watches USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "knowledge_pack_candidates_identity_listing_idx",
      "table": "knowledge_pack_candidates",
      "definition": "CREATE INDEX knowledge_pack_candidates_identity_listing_idx ON harness_shared.knowledge_pack_candidates USING btree (workspace_id, target_identity_id, target_pack_id, status, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "knowledge_pack_candidates_listing_idx",
      "table": "knowledge_pack_candidates",
      "definition": "CREATE INDEX knowledge_pack_candidates_listing_idx ON harness_shared.knowledge_pack_candidates USING btree (status, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "knowledge_pack_candidates_pkey",
      "table": "knowledge_pack_candidates",
      "definition": "CREATE UNIQUE INDEX knowledge_pack_candidates_pkey ON harness_shared.knowledge_pack_candidates USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "knowledge_pack_candidates_signature_uniq",
      "table": "knowledge_pack_candidates",
      "definition": "CREATE UNIQUE INDEX knowledge_pack_candidates_signature_uniq ON harness_shared.knowledge_pack_candidates USING btree (signature)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "knowledge_pack_config_pkey",
      "table": "knowledge_pack_config",
      "definition": "CREATE UNIQUE INDEX knowledge_pack_config_pkey ON harness_shared.knowledge_pack_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "known_schema_versions_pkey",
      "table": "known_schema_versions",
      "definition": "CREATE UNIQUE INDEX known_schema_versions_pkey ON harness_shared.known_schema_versions USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "known_timer_registrations_pkey",
      "table": "known_timer_registrations",
      "definition": "CREATE UNIQUE INDEX known_timer_registrations_pkey ON harness_shared.known_timer_registrations USING btree (name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "learning_governor_loops_pkey",
      "table": "learning_governor_loops",
      "definition": "CREATE UNIQUE INDEX learning_governor_loops_pkey ON harness_shared.learning_governor_loops USING btree (workspace_id, loop_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "learning_governor_loops_pot_idx",
      "table": "learning_governor_loops",
      "definition": "CREATE INDEX learning_governor_loops_pot_idx ON harness_shared.learning_governor_loops USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_pot_scope_disabled_idx",
      "table": "learning_pot_scope",
      "definition": "CREATE INDEX learning_pot_scope_disabled_idx ON harness_shared.learning_pot_scope USING btree (workspace_id) WHERE (enabled = false)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_pot_scope_pkey",
      "table": "learning_pot_scope",
      "definition": "CREATE UNIQUE INDEX learning_pot_scope_pkey ON harness_shared.learning_pot_scope USING btree (workspace_id, pot_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_events_pkey",
      "table": "learning_spend_events",
      "definition": "CREATE UNIQUE INDEX learning_spend_events_pkey ON harness_shared.learning_spend_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_events_pot_idx",
      "table": "learning_spend_events",
      "definition": "CREATE INDEX learning_spend_events_pot_idx ON harness_shared.learning_spend_events USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_events_reservation_idx",
      "table": "learning_spend_events",
      "definition": "CREATE INDEX learning_spend_events_reservation_idx ON harness_shared.learning_spend_events USING btree (reservation_id) WHERE (reservation_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_events_ws_created_idx",
      "table": "learning_spend_events",
      "definition": "CREATE INDEX learning_spend_events_ws_created_idx ON harness_shared.learning_spend_events USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_events_ws_loop_created_idx",
      "table": "learning_spend_events",
      "definition": "CREATE INDEX learning_spend_events_ws_loop_created_idx ON harness_shared.learning_spend_events USING btree (workspace_id, loop_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_reservations_open_idx",
      "table": "learning_spend_reservations",
      "definition": "CREATE INDEX learning_spend_reservations_open_idx ON harness_shared.learning_spend_reservations USING btree (workspace_id, loop_id) WHERE (status = 'open'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_reservations_pkey",
      "table": "learning_spend_reservations",
      "definition": "CREATE UNIQUE INDEX learning_spend_reservations_pkey ON harness_shared.learning_spend_reservations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_reservations_ws_created_idx",
      "table": "learning_spend_reservations",
      "definition": "CREATE INDEX learning_spend_reservations_ws_created_idx ON harness_shared.learning_spend_reservations USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "learning_spend_reservations_ws_loop_created_idx",
      "table": "learning_spend_reservations",
      "definition": "CREATE INDEX learning_spend_reservations_ws_loop_created_idx ON harness_shared.learning_spend_reservations USING btree (workspace_id, loop_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "ledger_anchor_leaves_pkey",
      "table": "ledger_anchor_leaves",
      "definition": "CREATE UNIQUE INDEX ledger_anchor_leaves_pkey ON harness_shared.ledger_anchor_leaves USING btree (workspace_id, leaf_index)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_anchor_leaves_workspace_id_stream_id_seq_key",
      "table": "ledger_anchor_leaves",
      "definition": "CREATE UNIQUE INDEX ledger_anchor_leaves_workspace_id_stream_id_seq_key ON harness_shared.ledger_anchor_leaves USING btree (workspace_id, stream_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_anchors_pkey",
      "table": "ledger_anchors",
      "definition": "CREATE UNIQUE INDEX ledger_anchors_pkey ON harness_shared.ledger_anchors USING btree (workspace_id, anchor_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_anchors_workspace_id_anchor_ref_key",
      "table": "ledger_anchors",
      "definition": "CREATE UNIQUE INDEX ledger_anchors_workspace_id_anchor_ref_key ON harness_shared.ledger_anchors USING btree (workspace_id, anchor_ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_anchors_workspace_id_window_end_key",
      "table": "ledger_anchors",
      "definition": "CREATE UNIQUE INDEX ledger_anchors_workspace_id_window_end_key ON harness_shared.ledger_anchors USING btree (workspace_id, window_end)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_chain_links_pkey",
      "table": "ledger_chain_links",
      "definition": "CREATE UNIQUE INDEX ledger_chain_links_pkey ON harness_shared.ledger_chain_links USING btree (workspace_id, stream_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ledger_chain_links_workspace_id_stream_id_source_id_key",
      "table": "ledger_chain_links",
      "definition": "CREATE UNIQUE INDEX ledger_chain_links_workspace_id_stream_id_source_id_key ON harness_shared.ledger_chain_links USING btree (workspace_id, stream_id, source_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_claims_expires_idx",
      "table": "llm_test_claims",
      "definition": "CREATE INDEX llm_test_claims_expires_idx ON harness_shared.llm_test_claims USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_claims_owner_idx",
      "table": "llm_test_claims",
      "definition": "CREATE INDEX llm_test_claims_owner_idx ON harness_shared.llm_test_claims USING btree (owner_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_claims_pkey",
      "table": "llm_test_claims",
      "definition": "CREATE UNIQUE INDEX llm_test_claims_pkey ON harness_shared.llm_test_claims USING btree (claim_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_findings_ack_severity_idx",
      "table": "llm_test_findings",
      "definition": "CREATE INDEX llm_test_findings_ack_severity_idx ON harness_shared.llm_test_findings USING btree (acknowledged, severity)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_findings_pkey",
      "table": "llm_test_findings",
      "definition": "CREATE UNIQUE INDEX llm_test_findings_pkey ON harness_shared.llm_test_findings USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_findings_run_severity_idx",
      "table": "llm_test_findings",
      "definition": "CREATE INDEX llm_test_findings_run_severity_idx ON harness_shared.llm_test_findings USING btree (run_id, severity)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_findings_shape_severity_idx",
      "table": "llm_test_findings",
      "definition": "CREATE INDEX llm_test_findings_shape_severity_idx ON harness_shared.llm_test_findings USING btree (shape, severity) WHERE (shape IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_fixtures_pkey",
      "table": "llm_test_fixtures",
      "definition": "CREATE UNIQUE INDEX llm_test_fixtures_pkey ON harness_shared.llm_test_fixtures USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_fixtures_scenario_id_label_key",
      "table": "llm_test_fixtures",
      "definition": "CREATE UNIQUE INDEX llm_test_fixtures_scenario_id_label_key ON harness_shared.llm_test_fixtures USING btree (scenario_id, label)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_fixtures_scenario_idx",
      "table": "llm_test_fixtures",
      "definition": "CREATE INDEX llm_test_fixtures_scenario_idx ON harness_shared.llm_test_fixtures USING btree (scenario_id, recorded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_runs_identity_started_idx",
      "table": "llm_test_runs",
      "definition": "CREATE INDEX llm_test_runs_identity_started_idx ON harness_shared.llm_test_runs USING btree (identity_hash, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_runs_matrix_group_idx",
      "table": "llm_test_runs",
      "definition": "CREATE INDEX llm_test_runs_matrix_group_idx ON harness_shared.llm_test_runs USING btree (matrix_group_id) WHERE (matrix_group_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_runs_pkey",
      "table": "llm_test_runs",
      "definition": "CREATE UNIQUE INDEX llm_test_runs_pkey ON harness_shared.llm_test_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_runs_status_idx",
      "table": "llm_test_runs",
      "definition": "CREATE INDEX llm_test_runs_status_idx ON harness_shared.llm_test_runs USING btree (status, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "llm_test_runs_target_scenario_started_idx",
      "table": "llm_test_runs",
      "definition": "CREATE INDEX llm_test_runs_target_scenario_started_idx ON harness_shared.llm_test_runs USING btree (scenario_target, scenario_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "local_backends_on_demand",
      "table": "local_backends",
      "definition": "CREATE INDEX local_backends_on_demand ON harness_shared.local_backends USING btree (workspace_id) WHERE (enabled AND (lifecycle = 'on-demand'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "local_backends_pkey",
      "table": "local_backends",
      "definition": "CREATE UNIQUE INDEX local_backends_pkey ON harness_shared.local_backends USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "local_backends_workspace",
      "table": "local_backends",
      "definition": "CREATE INDEX local_backends_workspace ON harness_shared.local_backends USING btree (workspace_id) WHERE enabled",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "lsp_capabilities_pkey",
      "table": "lsp_capabilities",
      "definition": "CREATE UNIQUE INDEX lsp_capabilities_pkey ON harness_shared.lsp_capabilities USING btree (language, intent, server_identity)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "mcp_tool_results_created_at_idx",
      "table": "mcp_tool_results",
      "definition": "CREATE INDEX mcp_tool_results_created_at_idx ON harness_shared.mcp_tool_results USING btree (created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "mcp_tool_results_pkey",
      "table": "mcp_tool_results",
      "definition": "CREATE UNIQUE INDEX mcp_tool_results_pkey ON harness_shared.mcp_tool_results USING btree (owner_key, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_anchors_lookup_idx",
      "table": "memory_anchors",
      "definition": "CREATE INDEX memory_anchors_lookup_idx ON harness_shared.memory_anchors USING btree (kind, value)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_anchors_pkey",
      "table": "memory_anchors",
      "definition": "CREATE UNIQUE INDEX memory_anchors_pkey ON harness_shared.memory_anchors USING btree (memory_id, kind, value)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_anchors_recheck_idx",
      "table": "memory_anchors",
      "definition": "CREATE INDEX memory_anchors_recheck_idx ON harness_shared.memory_anchors USING btree (last_checked_at NULLS FIRST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_fed_identity",
      "table": "memory_canonical",
      "definition": "CREATE UNIQUE INDEX memory_canonical_fed_identity ON harness_shared.memory_canonical USING btree (workspace_id, id, COALESCE(source_hive, ''::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_payload_data_trgm",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_payload_data_trgm ON harness_shared.memory_canonical USING gin (((payload ->> 'data'::text)) gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_payload_description_trgm",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_payload_description_trgm ON harness_shared.memory_canonical USING gin (((payload ->> 'description'::text)) gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_payload_name_trgm",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_payload_name_trgm ON harness_shared.memory_canonical USING gin (((payload ->> 'name'::text)) gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_pkey",
      "table": "memory_canonical",
      "definition": "CREATE UNIQUE INDEX memory_canonical_pkey ON harness_shared.memory_canonical USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_row_kind_memory_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_row_kind_memory_idx ON harness_shared.memory_canonical USING btree (id) WHERE (row_kind = 'memory'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_shareable_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_shareable_idx ON harness_shared.memory_canonical USING btree (shareable) WHERE (shareable = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_state_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_state_idx ON harness_shared.memory_canonical USING btree (state) WHERE (state <> 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_user_id_col_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_user_id_col_idx ON harness_shared.memory_canonical USING btree (user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_user_id_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_user_id_idx ON harness_shared.memory_canonical USING btree (((payload ->> 'user_id'::text)))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_workspace_id_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_workspace_id_idx ON harness_shared.memory_canonical USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_canonical_ws_user_idx",
      "table": "memory_canonical",
      "definition": "CREATE INDEX memory_canonical_ws_user_idx ON harness_shared.memory_canonical USING btree (workspace_id, user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_feedback_action_created_idx",
      "table": "memory_feedback",
      "definition": "CREATE INDEX memory_feedback_action_created_idx ON harness_shared.memory_feedback USING btree (action, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_feedback_mem_idx",
      "table": "memory_feedback",
      "definition": "CREATE INDEX memory_feedback_mem_idx ON harness_shared.memory_feedback USING btree (mem_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_feedback_pkey",
      "table": "memory_feedback",
      "definition": "CREATE UNIQUE INDEX memory_feedback_pkey ON harness_shared.memory_feedback USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_feedback_user_idx",
      "table": "memory_feedback",
      "definition": "CREATE INDEX memory_feedback_user_idx ON harness_shared.memory_feedback USING btree (user_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_feedback_ws_pot_created_idx",
      "table": "memory_feedback",
      "definition": "CREATE INDEX memory_feedback_ws_pot_created_idx ON harness_shared.memory_feedback USING btree (workspace_id, pot_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_live_recall_canary_run_pkey",
      "table": "memory_live_recall_canary_run",
      "definition": "CREATE UNIQUE INDEX memory_live_recall_canary_run_pkey ON harness_shared.memory_live_recall_canary_run USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_live_recall_canary_run_ws_ran_at_idx",
      "table": "memory_live_recall_canary_run",
      "definition": "CREATE INDEX memory_live_recall_canary_run_ws_ran_at_idx ON harness_shared.memory_live_recall_canary_run USING btree (workspace_id, ran_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_live_recall_canary_set_pkey",
      "table": "memory_live_recall_canary_set",
      "definition": "CREATE UNIQUE INDEX memory_live_recall_canary_set_pkey ON harness_shared.memory_live_recall_canary_set USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_live_recall_canary_set_ws_version",
      "table": "memory_live_recall_canary_set",
      "definition": "CREATE UNIQUE INDEX memory_live_recall_canary_set_ws_version ON harness_shared.memory_live_recall_canary_set USING btree (workspace_id, version)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_managed_writes_pkey",
      "table": "memory_managed_writes",
      "definition": "CREATE UNIQUE INDEX memory_managed_writes_pkey ON harness_shared.memory_managed_writes USING btree (write_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_precision_bench_attempts_pkey",
      "table": "memory_precision_bench_attempts",
      "definition": "CREATE UNIQUE INDEX memory_precision_bench_attempts_pkey ON harness_shared.memory_precision_bench_attempts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_precision_bench_attempts_ws_at_idx",
      "table": "memory_precision_bench_attempts",
      "definition": "CREATE INDEX memory_precision_bench_attempts_ws_at_idx ON harness_shared.memory_precision_bench_attempts USING btree (workspace_id, attempted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_precision_bench_pkey",
      "table": "memory_precision_bench",
      "definition": "CREATE UNIQUE INDEX memory_precision_bench_pkey ON harness_shared.memory_precision_bench USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_precision_bench_ws_ran_idx",
      "table": "memory_precision_bench",
      "definition": "CREATE INDEX memory_precision_bench_ws_ran_idx ON harness_shared.memory_precision_bench USING btree (workspace_id, ran_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_query_text_created_idx",
      "table": "memory_recall_query_text",
      "definition": "CREATE INDEX memory_recall_query_text_created_idx ON harness_shared.memory_recall_query_text USING btree (created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_query_text_pkey",
      "table": "memory_recall_query_text",
      "definition": "CREATE UNIQUE INDEX memory_recall_query_text_pkey ON harness_shared.memory_recall_query_text USING btree (stats_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_client_surface_idx",
      "table": "memory_recall_stats",
      "definition": "CREATE INDEX memory_recall_stats_client_surface_idx ON harness_shared.memory_recall_stats USING btree (created_at DESC, client, surface) WHERE (client IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_created_idx",
      "table": "memory_recall_stats",
      "definition": "CREATE INDEX memory_recall_stats_created_idx ON harness_shared.memory_recall_stats USING btree (created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_pkey",
      "table": "memory_recall_stats",
      "definition": "CREATE UNIQUE INDEX memory_recall_stats_pkey ON harness_shared.memory_recall_stats USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_scale_created_idx",
      "table": "memory_recall_stats",
      "definition": "CREATE INDEX memory_recall_stats_scale_created_idx ON harness_shared.memory_recall_stats USING btree (score_scale, created_at DESC) WHERE (score_scale IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_session_created_idx",
      "table": "memory_recall_stats",
      "definition": "CREATE INDEX memory_recall_stats_session_created_idx ON harness_shared.memory_recall_stats USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_recall_stats_ws_pot_created_idx",
      "table": "memory_recall_stats",
      "definition": "CREATE INDEX memory_recall_stats_ws_pot_created_idx ON harness_shared.memory_recall_stats USING btree (workspace_id, pot_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_session_epochs_pkey",
      "table": "memory_session_epochs",
      "definition": "CREATE UNIQUE INDEX memory_session_epochs_pkey ON harness_shared.memory_session_epochs USING btree (session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_session_surfaced_age_idx",
      "table": "memory_session_surfaced",
      "definition": "CREATE INDEX memory_session_surfaced_age_idx ON harness_shared.memory_session_surfaced USING btree (surfaced_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_session_surfaced_pkey",
      "table": "memory_session_surfaced",
      "definition": "CREATE UNIQUE INDEX memory_session_surfaced_pkey ON harness_shared.memory_session_surfaced USING btree (session_id, epoch, memory_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_gemma_hnsw_idx",
      "table": "memory_vec_gemma",
      "definition": "CREATE INDEX memory_vec_gemma_hnsw_idx ON harness_shared.memory_vec_gemma USING hnsw (vector vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_gemma_hnsw_memory_idx",
      "table": "memory_vec_gemma",
      "definition": "CREATE INDEX memory_vec_gemma_hnsw_memory_idx ON harness_shared.memory_vec_gemma USING hnsw (vector vector_cosine_ops) WHERE (row_kind = 'memory'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_gemma_pkey",
      "table": "memory_vec_gemma",
      "definition": "CREATE UNIQUE INDEX memory_vec_gemma_pkey ON harness_shared.memory_vec_gemma USING btree (memory_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_harrier_hnsw_idx",
      "table": "memory_vec_harrier",
      "definition": "CREATE INDEX memory_vec_harrier_hnsw_idx ON harness_shared.memory_vec_harrier USING hnsw (vector vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_harrier_hnsw_memory_idx",
      "table": "memory_vec_harrier",
      "definition": "CREATE INDEX memory_vec_harrier_hnsw_memory_idx ON harness_shared.memory_vec_harrier USING hnsw (vector vector_cosine_ops) WHERE (row_kind = 'memory'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_harrier_pkey",
      "table": "memory_vec_harrier",
      "definition": "CREATE UNIQUE INDEX memory_vec_harrier_pkey ON harness_shared.memory_vec_harrier USING btree (memory_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_local_hnsw_idx",
      "table": "memory_vec_local",
      "definition": "CREATE INDEX memory_vec_local_hnsw_idx ON harness_shared.memory_vec_local USING hnsw (vector vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_local_hnsw_memory_idx",
      "table": "memory_vec_local",
      "definition": "CREATE INDEX memory_vec_local_hnsw_memory_idx ON harness_shared.memory_vec_local USING hnsw (vector vector_cosine_ops) WHERE (row_kind = 'memory'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_local_pkey",
      "table": "memory_vec_local",
      "definition": "CREATE UNIQUE INDEX memory_vec_local_pkey ON harness_shared.memory_vec_local USING btree (memory_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_openai_hnsw_idx",
      "table": "memory_vec_openai",
      "definition": "CREATE INDEX memory_vec_openai_hnsw_idx ON harness_shared.memory_vec_openai USING hnsw (vector vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_openai_hnsw_memory_idx",
      "table": "memory_vec_openai",
      "definition": "CREATE INDEX memory_vec_openai_hnsw_memory_idx ON harness_shared.memory_vec_openai USING hnsw (vector vector_cosine_ops) WHERE (row_kind = 'memory'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_vec_openai_pkey",
      "table": "memory_vec_openai",
      "definition": "CREATE UNIQUE INDEX memory_vec_openai_pkey ON harness_shared.memory_vec_openai USING btree (memory_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "memory_write_journal_committed_at_idx",
      "table": "memory_write_journal",
      "definition": "CREATE INDEX memory_write_journal_committed_at_idx ON harness_shared.memory_write_journal USING btree (committed_at) WHERE (status = 'committed'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_write_journal_pending_idx",
      "table": "memory_write_journal",
      "definition": "CREATE INDEX memory_write_journal_pending_idx ON harness_shared.memory_write_journal USING btree (requested_at) WHERE (status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "memory_write_journal_pkey",
      "table": "memory_write_journal",
      "definition": "CREATE UNIQUE INDEX memory_write_journal_pkey ON harness_shared.memory_write_journal USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "messages_consolidated_pkey",
      "table": "messages_consolidated",
      "definition": "CREATE UNIQUE INDEX messages_consolidated_pkey ON harness_shared.messages_consolidated USING btree (harness_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "messages_consolidated_recent_idx",
      "table": "messages_consolidated",
      "definition": "CREATE INDEX messages_consolidated_recent_idx ON harness_shared.messages_consolidated USING btree (harness_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "migration_reservations_pkey",
      "table": "migration_reservations",
      "definition": "CREATE UNIQUE INDEX migration_reservations_pkey ON harness_shared.migration_reservations USING btree (num)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "mobile_pair_tokens_exp_idx",
      "table": "mobile_pair_tokens",
      "definition": "CREATE INDEX mobile_pair_tokens_exp_idx ON harness_shared.mobile_pair_tokens USING btree (expires_at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "mobile_pair_tokens_pkey",
      "table": "mobile_pair_tokens",
      "definition": "CREATE UNIQUE INDEX mobile_pair_tokens_pkey ON harness_shared.mobile_pair_tokens USING btree (pair_token)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "mobile_push_tokens_pkey",
      "table": "mobile_push_tokens",
      "definition": "CREATE UNIQUE INDEX mobile_push_tokens_pkey ON harness_shared.mobile_push_tokens USING btree (device_id, platform)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "mobile_push_tokens_workspace_idx",
      "table": "mobile_push_tokens",
      "definition": "CREATE INDEX mobile_push_tokens_workspace_idx ON harness_shared.mobile_push_tokens USING btree (device_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "model_pricing_pkey",
      "table": "model_pricing",
      "definition": "CREATE UNIQUE INDEX model_pricing_pkey ON harness_shared.model_pricing USING btree (model_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_entries_pkey",
      "table": "money_journal_entries",
      "definition": "CREATE UNIQUE INDEX money_journal_entries_pkey ON harness_shared.money_journal_entries USING btree (workspace_id, entry_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_entries_posting_seq_key",
      "table": "money_journal_entries",
      "definition": "CREATE UNIQUE INDEX money_journal_entries_posting_seq_key ON harness_shared.money_journal_entries USING btree (posting_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_entries_ref_idx",
      "table": "money_journal_entries",
      "definition": "CREATE INDEX money_journal_entries_ref_idx ON harness_shared.money_journal_entries USING btree (workspace_id, external_ref_kind, external_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_entries_rollup_idx",
      "table": "money_journal_entries",
      "definition": "CREATE INDEX money_journal_entries_rollup_idx ON harness_shared.money_journal_entries USING btree (workspace_id, rollup_id) WHERE (rollup_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_lines_pkey",
      "table": "money_journal_lines",
      "definition": "CREATE UNIQUE INDEX money_journal_lines_pkey ON harness_shared.money_journal_lines USING btree (workspace_id, entry_id, line_no)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_micro_accruals_pkey",
      "table": "money_journal_micro_accruals",
      "definition": "CREATE UNIQUE INDEX money_journal_micro_accruals_pkey ON harness_shared.money_journal_micro_accruals USING btree (workspace_id, rollup_id, accrual_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "money_journal_rollups_pkey",
      "table": "money_journal_rollups",
      "definition": "CREATE UNIQUE INDEX money_journal_rollups_pkey ON harness_shared.money_journal_rollups USING btree (workspace_id, rollup_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "negative_space_demand_pkey",
      "table": "negative_space_demand",
      "definition": "CREATE UNIQUE INDEX negative_space_demand_pkey ON harness_shared.negative_space_demand USING btree (workspace_id, surface, query_norm)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "notes_pkey",
      "table": "notes",
      "definition": "CREATE UNIQUE INDEX notes_pkey ON harness_shared.notes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "notes_ws_updated_at_idx",
      "table": "notes",
      "definition": "CREATE INDEX notes_ws_updated_at_idx ON harness_shared.notes USING btree (workspace_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "oauth_nonces_exp_idx",
      "table": "oauth_nonces",
      "definition": "CREATE INDEX oauth_nonces_exp_idx ON harness_shared.oauth_nonces USING btree (exp_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "oauth_nonces_pkey",
      "table": "oauth_nonces",
      "definition": "CREATE UNIQUE INDEX oauth_nonces_pkey ON harness_shared.oauth_nonces USING btree (nonce)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_account_override_pkey",
      "table": "operator_account_override",
      "definition": "CREATE UNIQUE INDEX operator_account_override_pkey ON harness_shared.operator_account_override USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_account_pool_audit_at_idx",
      "table": "operator_account_pool_audit",
      "definition": "CREATE INDEX operator_account_pool_audit_at_idx ON harness_shared.operator_account_pool_audit USING btree (at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_account_pool_audit_pkey",
      "table": "operator_account_pool_audit",
      "definition": "CREATE UNIQUE INDEX operator_account_pool_audit_pkey ON harness_shared.operator_account_pool_audit USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_account_pool_audit_removals_idx",
      "table": "operator_account_pool_audit",
      "definition": "CREATE INDEX operator_account_pool_audit_removals_idx ON harness_shared.operator_account_pool_audit USING btree (at DESC) WHERE (removed <> '{}'::text[])",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_account_pool_pkey",
      "table": "operator_account_pool",
      "definition": "CREATE UNIQUE INDEX operator_account_pool_pkey ON harness_shared.operator_account_pool USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_agent_config_pkey",
      "table": "operator_agent_config",
      "definition": "CREATE UNIQUE INDEX operator_agent_config_pkey ON harness_shared.operator_agent_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_announced_quiesce_state_pkey",
      "table": "operator_announced_quiesce_state",
      "definition": "CREATE UNIQUE INDEX operator_announced_quiesce_state_pkey ON harness_shared.operator_announced_quiesce_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_attention_automation_policy_pkey",
      "table": "operator_attention_automation_policy",
      "definition": "CREATE UNIQUE INDEX operator_attention_automation_policy_pkey ON harness_shared.operator_attention_automation_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_auth_config_pkey",
      "table": "operator_auth_config",
      "definition": "CREATE UNIQUE INDEX operator_auth_config_pkey ON harness_shared.operator_auth_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_auto_implement_policy_pkey",
      "table": "operator_auto_implement_policy",
      "definition": "CREATE UNIQUE INDEX operator_auto_implement_policy_pkey ON harness_shared.operator_auto_implement_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_budget_pkey",
      "table": "operator_budget",
      "definition": "CREATE UNIQUE INDEX operator_budget_pkey ON harness_shared.operator_budget USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_budget_tiers_pkey",
      "table": "operator_budget_tiers",
      "definition": "CREATE UNIQUE INDEX operator_budget_tiers_pkey ON harness_shared.operator_budget_tiers USING btree (ord)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_capability_envelopes_pkey",
      "table": "operator_capability_envelopes",
      "definition": "CREATE UNIQUE INDEX operator_capability_envelopes_pkey ON harness_shared.operator_capability_envelopes USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_capability_tiers_pkey",
      "table": "operator_capability_tiers",
      "definition": "CREATE UNIQUE INDEX operator_capability_tiers_pkey ON harness_shared.operator_capability_tiers USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_consult_expert_routing_pkey",
      "table": "operator_consult_expert_routing",
      "definition": "CREATE UNIQUE INDEX operator_consult_expert_routing_pkey ON harness_shared.operator_consult_expert_routing USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_context_doors_config_pkey",
      "table": "operator_context_doors_config",
      "definition": "CREATE UNIQUE INDEX operator_context_doors_config_pkey ON harness_shared.operator_context_doors_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_continue_chains_chain_turn_idx",
      "table": "operator_continue_chains",
      "definition": "CREATE INDEX operator_continue_chains_chain_turn_idx ON harness_shared.operator_continue_chains USING btree (chain_id, turn_idx)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_continue_chains_conversation_idx",
      "table": "operator_continue_chains",
      "definition": "CREATE INDEX operator_continue_chains_conversation_idx ON harness_shared.operator_continue_chains USING btree (conversation_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_continue_chains_pkey",
      "table": "operator_continue_chains",
      "definition": "CREATE UNIQUE INDEX operator_continue_chains_pkey ON harness_shared.operator_continue_chains USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_continue_chains_uic_started_idx",
      "table": "operator_continue_chains",
      "definition": "CREATE INDEX operator_continue_chains_uic_started_idx ON harness_shared.operator_continue_chains USING btree (ui_client_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_continue_chains_workspace_id_idx",
      "table": "operator_continue_chains",
      "definition": "CREATE INDEX operator_continue_chains_workspace_id_idx ON harness_shared.operator_continue_chains USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_conversations_active_idx",
      "table": "operator_conversations",
      "definition": "CREATE INDEX operator_conversations_active_idx ON harness_shared.operator_conversations USING btree (workspace_id, COALESCE(harness_slug, ''::text)) WHERE (status = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_conversations_pkey",
      "table": "operator_conversations",
      "definition": "CREATE UNIQUE INDEX operator_conversations_pkey ON harness_shared.operator_conversations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_conversations_started_idx",
      "table": "operator_conversations",
      "definition": "CREATE INDEX operator_conversations_started_idx ON harness_shared.operator_conversations USING btree (workspace_id, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_conversations_work_item_subject_uq",
      "table": "operator_conversations",
      "definition": "CREATE UNIQUE INDEX operator_conversations_work_item_subject_uq ON harness_shared.operator_conversations USING btree (workspace_id, harness_slug, subject_ref) WHERE (subject_kind = 'work-item'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_coord_liveness_config_pkey",
      "table": "operator_coord_liveness_config",
      "definition": "CREATE UNIQUE INDEX operator_coord_liveness_config_pkey ON harness_shared.operator_coord_liveness_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_credentials_pkey",
      "table": "operator_credentials",
      "definition": "CREATE UNIQUE INDEX operator_credentials_pkey ON harness_shared.operator_credentials USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_curation_log_pkey",
      "table": "operator_curation_log",
      "definition": "CREATE UNIQUE INDEX operator_curation_log_pkey ON harness_shared.operator_curation_log USING btree (workspace_id, signal_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_curation_log_surfaced_idx",
      "table": "operator_curation_log",
      "definition": "CREATE INDEX operator_curation_log_surfaced_idx ON harness_shared.operator_curation_log USING btree (workspace_id, surfaced_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_curation_state_pkey",
      "table": "operator_curation_state",
      "definition": "CREATE UNIQUE INDEX operator_curation_state_pkey ON harness_shared.operator_curation_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_embed_device_pkey",
      "table": "operator_embed_device",
      "definition": "CREATE UNIQUE INDEX operator_embed_device_pkey ON harness_shared.operator_embed_device USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_first_run_pkey",
      "table": "operator_first_run",
      "definition": "CREATE UNIQUE INDEX operator_first_run_pkey ON harness_shared.operator_first_run USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_flag_overrides_pkey",
      "table": "operator_flag_overrides",
      "definition": "CREATE UNIQUE INDEX operator_flag_overrides_pkey ON harness_shared.operator_flag_overrides USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_gym_gates_pkey",
      "table": "operator_gym_gates",
      "definition": "CREATE UNIQUE INDEX operator_gym_gates_pkey ON harness_shared.operator_gym_gates USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_integration_credentials_pkey",
      "table": "operator_integration_credentials",
      "definition": "CREATE UNIQUE INDEX operator_integration_credentials_pkey ON harness_shared.operator_integration_credentials USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_liveness_flap_state_pkey",
      "table": "operator_liveness_flap_state",
      "definition": "CREATE UNIQUE INDEX operator_liveness_flap_state_pkey ON harness_shared.operator_liveness_flap_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_marketplace_token_pkey",
      "table": "operator_marketplace_token",
      "definition": "CREATE UNIQUE INDEX operator_marketplace_token_pkey ON harness_shared.operator_marketplace_token USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_migrate_policy_pkey",
      "table": "operator_migrate_policy",
      "definition": "CREATE UNIQUE INDEX operator_migrate_policy_pkey ON harness_shared.operator_migrate_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_opus_budget_policy_pkey",
      "table": "operator_opus_budget_policy",
      "definition": "CREATE UNIQUE INDEX operator_opus_budget_policy_pkey ON harness_shared.operator_opus_budget_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_oracle_memory_pkey",
      "table": "operator_oracle_memory",
      "definition": "CREATE UNIQUE INDEX operator_oracle_memory_pkey ON harness_shared.operator_oracle_memory USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_oracle_prompt_pkey",
      "table": "operator_oracle_prompt",
      "definition": "CREATE UNIQUE INDEX operator_oracle_prompt_pkey ON harness_shared.operator_oracle_prompt USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_owner_pins_pkey",
      "table": "operator_owner_pins",
      "definition": "CREATE UNIQUE INDEX operator_owner_pins_pkey ON harness_shared.operator_owner_pins USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_paused_pkey",
      "table": "operator_paused",
      "definition": "CREATE UNIQUE INDEX operator_paused_pkey ON harness_shared.operator_paused USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_pot_control_policy_pkey",
      "table": "operator_pot_control_policy",
      "definition": "CREATE UNIQUE INDEX operator_pot_control_policy_pkey ON harness_shared.operator_pot_control_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_preferences_pkey",
      "table": "operator_preferences",
      "definition": "CREATE UNIQUE INDEX operator_preferences_pkey ON harness_shared.operator_preferences USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_prompt_user_pkey",
      "table": "operator_prompt_user",
      "definition": "CREATE UNIQUE INDEX operator_prompt_user_pkey ON harness_shared.operator_prompt_user USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_publish_credentials_pkey",
      "table": "operator_publish_credentials",
      "definition": "CREATE UNIQUE INDEX operator_publish_credentials_pkey ON harness_shared.operator_publish_credentials USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_quota_overrides_pkey",
      "table": "operator_quota_overrides",
      "definition": "CREATE UNIQUE INDEX operator_quota_overrides_pkey ON harness_shared.operator_quota_overrides USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_rate_limit_config_pkey",
      "table": "operator_rate_limit_config",
      "definition": "CREATE UNIQUE INDEX operator_rate_limit_config_pkey ON harness_shared.operator_rate_limit_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_rate_limit_pkey",
      "table": "operator_rate_limit",
      "definition": "CREATE UNIQUE INDEX operator_rate_limit_pkey ON harness_shared.operator_rate_limit USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_release_checkpoint_config_pkey",
      "table": "operator_release_checkpoint_config",
      "definition": "CREATE UNIQUE INDEX operator_release_checkpoint_config_pkey ON harness_shared.operator_release_checkpoint_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_scale_policy_pkey",
      "table": "operator_scale_policy",
      "definition": "CREATE UNIQUE INDEX operator_scale_policy_pkey ON harness_shared.operator_scale_policy USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_scout_budget_pkey",
      "table": "operator_scout_budget",
      "definition": "CREATE UNIQUE INDEX operator_scout_budget_pkey ON harness_shared.operator_scout_budget USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_search_provider_credentials_pkey",
      "table": "operator_search_provider_credentials",
      "definition": "CREATE UNIQUE INDEX operator_search_provider_credentials_pkey ON harness_shared.operator_search_provider_credentials USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_secrets_pkey",
      "table": "operator_secrets",
      "definition": "CREATE UNIQUE INDEX operator_secrets_pkey ON harness_shared.operator_secrets USING btree (name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_session_confinements_pkey",
      "table": "operator_session_confinements",
      "definition": "CREATE UNIQUE INDEX operator_session_confinements_pkey ON harness_shared.operator_session_confinements USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_settings_pkey",
      "table": "operator_settings",
      "definition": "CREATE UNIQUE INDEX operator_settings_pkey ON harness_shared.operator_settings USING btree (key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_settings_workspace_id_idx",
      "table": "operator_settings",
      "definition": "CREATE INDEX operator_settings_workspace_id_idx ON harness_shared.operator_settings USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_standing_candidates_pkey",
      "table": "operator_standing_candidates",
      "definition": "CREATE UNIQUE INDEX operator_standing_candidates_pkey ON harness_shared.operator_standing_candidates USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_stt_spend_pkey",
      "table": "operator_stt_spend",
      "definition": "CREATE UNIQUE INDEX operator_stt_spend_pkey ON harness_shared.operator_stt_spend USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_supervision_pause_state_pkey",
      "table": "operator_supervision_pause_state",
      "definition": "CREATE UNIQUE INDEX operator_supervision_pause_state_pkey ON harness_shared.operator_supervision_pause_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_telemetry_buffer_config_pkey",
      "table": "operator_telemetry_buffer_config",
      "definition": "CREATE UNIQUE INDEX operator_telemetry_buffer_config_pkey ON harness_shared.operator_telemetry_buffer_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_trust_store_pkey",
      "table": "operator_trust_store",
      "definition": "CREATE UNIQUE INDEX operator_trust_store_pkey ON harness_shared.operator_trust_store USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_tts_spend_pkey",
      "table": "operator_tts_spend",
      "definition": "CREATE UNIQUE INDEX operator_tts_spend_pkey ON harness_shared.operator_tts_spend USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_conv_seq_idx",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_conv_seq_idx ON harness_shared.operator_turns USING btree (conversation_id, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_conversation_id_seq_key",
      "table": "operator_turns",
      "definition": "CREATE UNIQUE INDEX operator_turns_conversation_id_seq_key ON harness_shared.operator_turns USING btree (conversation_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_pkey",
      "table": "operator_turns",
      "definition": "CREATE UNIQUE INDEX operator_turns_pkey ON harness_shared.operator_turns USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_report_recent_idx",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_report_recent_idx ON harness_shared.operator_turns USING btree (created_at) WHERE (report IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_text_embedding_hnsw",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_text_embedding_hnsw ON harness_shared.operator_turns USING hnsw (text_embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_text_embedding_mode_idx",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_text_embedding_mode_idx ON harness_shared.operator_turns USING btree (text_embedding_mode) WHERE (text_embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_tsv_idx",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_tsv_idx ON harness_shared.operator_turns USING gin (text_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_turns_workspace_id_idx",
      "table": "operator_turns",
      "definition": "CREATE INDEX operator_turns_workspace_id_idx ON harness_shared.operator_turns USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "operator_txn_timeouts_config_pkey",
      "table": "operator_txn_timeouts_config",
      "definition": "CREATE UNIQUE INDEX operator_txn_timeouts_config_pkey ON harness_shared.operator_txn_timeouts_config USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_user_profile_pkey",
      "table": "operator_user_profile",
      "definition": "CREATE UNIQUE INDEX operator_user_profile_pkey ON harness_shared.operator_user_profile USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_voice_channels_pkey",
      "table": "operator_voice_channels",
      "definition": "CREATE UNIQUE INDEX operator_voice_channels_pkey ON harness_shared.operator_voice_channels USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_voice_credentials_pkey",
      "table": "operator_voice_credentials",
      "definition": "CREATE UNIQUE INDEX operator_voice_credentials_pkey ON harness_shared.operator_voice_credentials USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "operator_voice_prefs_pkey",
      "table": "operator_voice_prefs",
      "definition": "CREATE UNIQUE INDEX operator_voice_prefs_pkey ON harness_shared.operator_voice_prefs USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "orchestrator_settings_pkey",
      "table": "orchestrator_settings",
      "definition": "CREATE UNIQUE INDEX orchestrator_settings_pkey ON harness_shared.orchestrator_settings USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "orchestrator_settings_workspace_id_idx",
      "table": "orchestrator_settings",
      "definition": "CREATE INDEX orchestrator_settings_workspace_id_idx ON harness_shared.orchestrator_settings USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "orientation_class_reach_by_class",
      "table": "orientation_class_reach",
      "definition": "CREATE INDEX orientation_class_reach_by_class ON harness_shared.orientation_class_reach USING btree (workspace_id, sink, class_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "orientation_class_reach_pkey",
      "table": "orientation_class_reach",
      "definition": "CREATE UNIQUE INDEX orientation_class_reach_pkey ON harness_shared.orientation_class_reach USING btree (workspace_id, owner_id, sink, class_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "orientation_obligation_action_dispositioned",
      "table": "orientation_obligation_action",
      "definition": "CREATE INDEX orientation_obligation_action_dispositioned ON harness_shared.orientation_obligation_action USING btree (workspace_id, class_id) WHERE (dispositioned_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "orientation_obligation_action_open",
      "table": "orientation_obligation_action",
      "definition": "CREATE INDEX orientation_obligation_action_open ON harness_shared.orientation_obligation_action USING btree (workspace_id, owner_id) WHERE (dispositioned_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "orientation_obligation_action_pkey",
      "table": "orientation_obligation_action",
      "definition": "CREATE UNIQUE INDEX orientation_obligation_action_pkey ON harness_shared.orientation_obligation_action USING btree (workspace_id, owner_id, class_id, row_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "owner_activity_pkey",
      "table": "owner_activity",
      "definition": "CREATE UNIQUE INDEX owner_activity_pkey ON harness_shared.owner_activity USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "owner_directive_agenda_owner_idx",
      "table": "owner_directive_agenda",
      "definition": "CREATE INDEX owner_directive_agenda_owner_idx ON harness_shared.owner_directive_agenda USING btree (workspace_id, owner_id, directive_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "owner_directive_agenda_pkey",
      "table": "owner_directive_agenda",
      "definition": "CREATE UNIQUE INDEX owner_directive_agenda_pkey ON harness_shared.owner_directive_agenda USING btree (workspace_id, directive_id, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "owner_directives_hook_captured_idx",
      "table": "owner_directives",
      "definition": "CREATE INDEX owner_directives_hook_captured_idx ON harness_shared.owner_directives USING btree (workspace_id, captured_by_hook, created_at) WHERE captured_by_hook",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "owner_directives_open_idx",
      "table": "owner_directives",
      "definition": "CREATE INDEX owner_directives_open_idx ON harness_shared.owner_directives USING btree (workspace_id, created_at) WHERE (dispositioned_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "owner_directives_pkey",
      "table": "owner_directives",
      "definition": "CREATE UNIQUE INDEX owner_directives_pkey ON harness_shared.owner_directives USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "owner_interactions_pkey",
      "table": "owner_interactions",
      "definition": "CREATE UNIQUE INDEX owner_interactions_pkey ON harness_shared.owner_interactions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "owner_interactions_ws_kind_ts_idx",
      "table": "owner_interactions",
      "definition": "CREATE INDEX owner_interactions_ws_kind_ts_idx ON harness_shared.owner_interactions USING btree (workspace_id, kind, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "owner_interactions_ws_ts_idx",
      "table": "owner_interactions",
      "definition": "CREATE INDEX owner_interactions_ws_ts_idx ON harness_shared.owner_interactions USING btree (workspace_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_fleet_directory_pkey",
      "table": "p2p_fleet_directory",
      "definition": "CREATE UNIQUE INDEX p2p_fleet_directory_pkey ON harness_shared.p2p_fleet_directory USING btree (workspace_id, harness_slug, owner_github_user_id, fleet_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_fleet_leader_leases_hive_idx",
      "table": "p2p_fleet_leader_leases",
      "definition": "CREATE INDEX p2p_fleet_leader_leases_hive_idx ON harness_shared.p2p_fleet_leader_leases USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_fleet_leader_leases_pkey",
      "table": "p2p_fleet_leader_leases",
      "definition": "CREATE UNIQUE INDEX p2p_fleet_leader_leases_pkey ON harness_shared.p2p_fleet_leader_leases USING btree (workspace_id, harness_slug, owner_github_user_id, fleet_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_foreign_workspaces_pkey",
      "table": "p2p_foreign_workspaces",
      "definition": "CREATE UNIQUE INDEX p2p_foreign_workspaces_pkey ON harness_shared.p2p_foreign_workspaces USING btree (workspace_id, offer_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_foreign_workspaces_root_path_key",
      "table": "p2p_foreign_workspaces",
      "definition": "CREATE UNIQUE INDEX p2p_foreign_workspaces_root_path_key ON harness_shared.p2p_foreign_workspaces USING btree (root_path)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_foreign_workspaces_session_idx",
      "table": "p2p_foreign_workspaces",
      "definition": "CREATE INDEX p2p_foreign_workspaces_session_idx ON harness_shared.p2p_foreign_workspaces USING btree (session_id) WHERE (session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_foreign_workspaces_state_idx",
      "table": "p2p_foreign_workspaces",
      "definition": "CREATE INDEX p2p_foreign_workspaces_state_idx ON harness_shared.p2p_foreign_workspaces USING btree (workspace_id, state)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_grantor_epochs_pkey",
      "table": "p2p_grantor_epochs",
      "definition": "CREATE UNIQUE INDEX p2p_grantor_epochs_pkey ON harness_shared.p2p_grantor_epochs USING btree (workspace_id, harness_slug, grantor_github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_metering_contribution_pkey",
      "table": "p2p_metering_contribution",
      "definition": "CREATE UNIQUE INDEX p2p_metering_contribution_pkey ON harness_shared.p2p_metering_contribution USING btree (workspace_id, attested_user_id, axis)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_metering_spend_fleet_idx",
      "table": "p2p_metering_spend",
      "definition": "CREATE INDEX p2p_metering_spend_fleet_idx ON harness_shared.p2p_metering_spend USING btree (workspace_id, fleet_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_metering_spend_pkey",
      "table": "p2p_metering_spend",
      "definition": "CREATE UNIQUE INDEX p2p_metering_spend_pkey ON harness_shared.p2p_metering_spend USING btree (workspace_id, host_ref, fleet_slug, axis)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_peer_grants_grantee_idx",
      "table": "p2p_peer_grants",
      "definition": "CREATE INDEX p2p_peer_grants_grantee_idx ON harness_shared.p2p_peer_grants USING btree (workspace_id, harness_slug, grantee_kind, grantee_ref) WHERE (status = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_peer_grants_pkey",
      "table": "p2p_peer_grants",
      "definition": "CREATE UNIQUE INDEX p2p_peer_grants_pkey ON harness_shared.p2p_peer_grants USING btree (workspace_id, harness_slug, grantor_github_user_id, grantee_kind, grantee_ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_receipts_offer_idx",
      "table": "p2p_receipts",
      "definition": "CREATE INDEX p2p_receipts_offer_idx ON harness_shared.p2p_receipts USING btree (workspace_id, harness_slug, offer_id, receipt_ts) WHERE (offer_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_receipts_pkey",
      "table": "p2p_receipts",
      "definition": "CREATE UNIQUE INDEX p2p_receipts_pkey ON harness_shared.p2p_receipts USING btree (workspace_id, harness_slug, receipt_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_receipts_ts_idx",
      "table": "p2p_receipts",
      "definition": "CREATE INDEX p2p_receipts_ts_idx ON harness_shared.p2p_receipts USING btree (workspace_id, harness_slug, receipt_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_refused_op_counters_pkey",
      "table": "p2p_refused_op_counters",
      "definition": "CREATE UNIQUE INDEX p2p_refused_op_counters_pkey ON harness_shared.p2p_refused_op_counters USING btree (workspace_id, harness_slug, reason)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_work_offers_fleet_idx",
      "table": "p2p_work_offers",
      "definition": "CREATE INDEX p2p_work_offers_fleet_idx ON harness_shared.p2p_work_offers USING btree (workspace_id, harness_slug, fleet_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "p2p_work_offers_pkey",
      "table": "p2p_work_offers",
      "definition": "CREATE UNIQUE INDEX p2p_work_offers_pkey ON harness_shared.p2p_work_offers USING btree (workspace_id, harness_slug, publisher_github_user_id, offer_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "p2p_work_offers_pot_idx",
      "table": "p2p_work_offers",
      "definition": "CREATE INDEX p2p_work_offers_pot_idx ON harness_shared.p2p_work_offers USING btree (workspace_id, harness_slug, pot_slug, status) WHERE (pot_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "payment_receipts_customer_idx",
      "table": "payment_receipts",
      "definition": "CREATE INDEX payment_receipts_customer_idx ON harness_shared.payment_receipts USING btree (workspace_id, source_customer) WHERE (source_customer IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "payment_receipts_pkey",
      "table": "payment_receipts",
      "definition": "CREATE UNIQUE INDEX payment_receipts_pkey ON harness_shared.payment_receipts USING btree (workspace_id, balance_transaction_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "payment_receipts_receipt_seq_key",
      "table": "payment_receipts",
      "definition": "CREATE UNIQUE INDEX payment_receipts_receipt_seq_key ON harness_shared.payment_receipts USING btree (receipt_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pending_events_pkey",
      "table": "pending_events",
      "definition": "CREATE UNIQUE INDEX pending_events_pkey ON harness_shared.pending_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pending_events_source_idx",
      "table": "pending_events",
      "definition": "CREATE INDEX pending_events_source_idx ON harness_shared.pending_events USING btree (source_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_events_unconsumed_idx",
      "table": "pending_events",
      "definition": "CREATE INDEX pending_events_unconsumed_idx ON harness_shared.pending_events USING btree (install_slug, due_at) WHERE (consumed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_events_workspace_idx",
      "table": "pending_events",
      "definition": "CREATE INDEX pending_events_workspace_idx ON harness_shared.pending_events USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_reviews_pkey",
      "table": "pending_reviews",
      "definition": "CREATE UNIQUE INDEX pending_reviews_pkey ON harness_shared.pending_reviews USING btree (harness_slug, phase, review_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pending_reviews_slug_resolved_ts_idx",
      "table": "pending_reviews",
      "definition": "CREATE INDEX pending_reviews_slug_resolved_ts_idx ON harness_shared.pending_reviews USING btree (harness_slug, resolved, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_reviews_workspace_idx",
      "table": "pending_reviews",
      "definition": "CREATE INDEX pending_reviews_workspace_idx ON harness_shared.pending_reviews USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_wakes_dedupe_idx",
      "table": "pending_wakes",
      "definition": "CREATE UNIQUE INDEX pending_wakes_dedupe_idx ON harness_shared.pending_wakes USING btree (owner_id, COALESCE(source, ''::text), COALESCE(summary, ''::text), COALESCE(workspace_id, ''::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_wakes_owner_idx",
      "table": "pending_wakes",
      "definition": "CREATE INDEX pending_wakes_owner_idx ON harness_shared.pending_wakes USING btree (owner_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pending_wakes_pkey",
      "table": "pending_wakes",
      "definition": "CREATE UNIQUE INDEX pending_wakes_pkey ON harness_shared.pending_wakes USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pending_wakes_workspace_idx",
      "table": "pending_wakes",
      "definition": "CREATE INDEX pending_wakes_workspace_idx ON harness_shared.pending_wakes USING btree (workspace_id, owner_id, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "perf_regression_snapshots_pkey",
      "table": "perf_regression_snapshots",
      "definition": "CREATE UNIQUE INDEX perf_regression_snapshots_pkey ON harness_shared.perf_regression_snapshots USING btree (workspace_id, captured_at)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "perf_regression_snapshots_ws_captured_idx",
      "table": "perf_regression_snapshots",
      "definition": "CREATE INDEX perf_regression_snapshots_ws_captured_idx ON harness_shared.perf_regression_snapshots USING btree (workspace_id, captured_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "periodic_sweep_runs_pkey",
      "table": "periodic_sweep_runs",
      "definition": "CREATE UNIQUE INDEX periodic_sweep_runs_pkey ON harness_shared.periodic_sweep_runs USING btree (sweep_name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "periodic_sweep_runs_workspace_id_idx",
      "table": "periodic_sweep_runs",
      "definition": "CREATE INDEX periodic_sweep_runs_workspace_id_idx ON harness_shared.periodic_sweep_runs USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_disclosures_active_uniq",
      "table": "personal_disclosures",
      "definition": "CREATE UNIQUE INDEX personal_disclosures_active_uniq ON harness_shared.personal_disclosures USING btree (workspace_id, user_id, agent_owner_id, document_id) WHERE (released_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_disclosures_agent_active_idx",
      "table": "personal_disclosures",
      "definition": "CREATE INDEX personal_disclosures_agent_active_idx ON harness_shared.personal_disclosures USING btree (workspace_id, agent_owner_id) WHERE (released_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_disclosures_owner_window_idx",
      "table": "personal_disclosures",
      "definition": "CREATE INDEX personal_disclosures_owner_window_idx ON harness_shared.personal_disclosures USING btree (agent_owner_id, delivered_at) INCLUDE (released_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_disclosures_pkey",
      "table": "personal_disclosures",
      "definition": "CREATE UNIQUE INDEX personal_disclosures_pkey ON harness_shared.personal_disclosures USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_grants_authorization_lookup",
      "table": "personal_grants",
      "definition": "CREATE INDEX personal_grants_authorization_lookup ON harness_shared.personal_grants USING btree (workspace_id, user_id, principal_type, principal_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_grants_live_identity",
      "table": "personal_grants",
      "definition": "CREATE UNIQUE INDEX personal_grants_live_identity ON harness_shared.personal_grants USING btree (workspace_id, user_id, principal_type, principal_id, scopes) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_grants_pkey",
      "table": "personal_grants",
      "definition": "CREATE UNIQUE INDEX personal_grants_pkey ON harness_shared.personal_grants USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_identities_pkey",
      "table": "personal_identities",
      "definition": "CREATE UNIQUE INDEX personal_identities_pkey ON harness_shared.personal_identities USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_identities_primary_email_idx",
      "table": "personal_identities",
      "definition": "CREATE INDEX personal_identities_primary_email_idx ON harness_shared.personal_identities USING btree (workspace_id, user_id, lower(primary_email)) WHERE (primary_email IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_identity_aliases_identity_idx",
      "table": "personal_identity_aliases",
      "definition": "CREATE INDEX personal_identity_aliases_identity_idx ON harness_shared.personal_identity_aliases USING btree (workspace_id, user_id, identity_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_identity_aliases_pkey",
      "table": "personal_identity_aliases",
      "definition": "CREATE UNIQUE INDEX personal_identity_aliases_pkey ON harness_shared.personal_identity_aliases USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_identity_aliases_workspace_id_user_id_source_alias_key",
      "table": "personal_identity_aliases",
      "definition": "CREATE UNIQUE INDEX personal_identity_aliases_workspace_id_user_id_source_alias_key ON harness_shared.personal_identity_aliases USING btree (workspace_id, user_id, source, alias_kind, normalized_value)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_privacy_rules_pkey",
      "table": "personal_privacy_rules",
      "definition": "CREATE UNIQUE INDEX personal_privacy_rules_pkey ON harness_shared.personal_privacy_rules USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_privacy_rules_workspace_id_user_id_match_kind_matc_key",
      "table": "personal_privacy_rules",
      "definition": "CREATE UNIQUE INDEX personal_privacy_rules_workspace_id_user_id_match_kind_matc_key ON harness_shared.personal_privacy_rules USING btree (workspace_id, user_id, match_kind, match_value)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_sealed_contents_pkey",
      "table": "personal_sealed_contents",
      "definition": "CREATE UNIQUE INDEX personal_sealed_contents_pkey ON harness_shared.personal_sealed_contents USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_sealed_contents_workspace_id_store_ref_key",
      "table": "personal_sealed_contents",
      "definition": "CREATE UNIQUE INDEX personal_sealed_contents_workspace_id_store_ref_key ON harness_shared.personal_sealed_contents USING btree (workspace_id, store, ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_sync_state_pkey",
      "table": "personal_sync_state",
      "definition": "CREATE UNIQUE INDEX personal_sync_state_pkey ON harness_shared.personal_sync_state USING btree (workspace_id, user_id, source)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_jobs_claim_idx",
      "table": "personal_vault_import_jobs",
      "definition": "CREATE INDEX personal_vault_import_jobs_claim_idx ON harness_shared.personal_vault_import_jobs USING btree (workspace_id, status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_jobs_owner_idx",
      "table": "personal_vault_import_jobs",
      "definition": "CREATE INDEX personal_vault_import_jobs_owner_idx ON harness_shared.personal_vault_import_jobs USING btree (workspace_id, user_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_jobs_pkey",
      "table": "personal_vault_import_jobs",
      "definition": "CREATE UNIQUE INDEX personal_vault_import_jobs_pkey ON harness_shared.personal_vault_import_jobs USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_jobs_retention_idx",
      "table": "personal_vault_import_jobs",
      "definition": "CREATE INDEX personal_vault_import_jobs_retention_idx ON harness_shared.personal_vault_import_jobs USING btree (workspace_id, retained_until) WHERE (storage_path IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_jobs_workspace_id_user_id_idempotency_key",
      "table": "personal_vault_import_jobs",
      "definition": "CREATE UNIQUE INDEX personal_vault_import_jobs_workspace_id_user_id_idempotency_key ON harness_shared.personal_vault_import_jobs USING btree (workspace_id, user_id, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_uploads_expiry_idx",
      "table": "personal_vault_import_uploads",
      "definition": "CREATE INDEX personal_vault_import_uploads_expiry_idx ON harness_shared.personal_vault_import_uploads USING btree (workspace_id, expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_uploads_owner_idx",
      "table": "personal_vault_import_uploads",
      "definition": "CREATE INDEX personal_vault_import_uploads_owner_idx ON harness_shared.personal_vault_import_uploads USING btree (workspace_id, user_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_uploads_pkey",
      "table": "personal_vault_import_uploads",
      "definition": "CREATE UNIQUE INDEX personal_vault_import_uploads_pkey ON harness_shared.personal_vault_import_uploads USING btree (workspace_id, user_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_import_uploads_workspace_id_storage_path_key",
      "table": "personal_vault_import_uploads",
      "definition": "CREATE UNIQUE INDEX personal_vault_import_uploads_workspace_id_storage_path_key ON harness_shared.personal_vault_import_uploads USING btree (workspace_id, storage_path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "personal_vault_settings_pkey",
      "table": "personal_vault_settings",
      "definition": "CREATE UNIQUE INDEX personal_vault_settings_pkey ON harness_shared.personal_vault_settings USING btree (workspace_id, user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pg_query_advisory_fires_label_window_idx",
      "table": "pg_query_advisory_fires",
      "definition": "CREATE INDEX pg_query_advisory_fires_label_window_idx ON harness_shared.pg_query_advisory_fires USING btree (workspace_id, advisory_label, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pg_query_advisory_fires_pkey",
      "table": "pg_query_advisory_fires",
      "definition": "CREATE UNIQUE INDEX pg_query_advisory_fires_pkey ON harness_shared.pg_query_advisory_fires USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pg_query_advisory_fires_window_idx",
      "table": "pg_query_advisory_fires",
      "definition": "CREATE INDEX pg_query_advisory_fires_window_idx ON harness_shared.pg_query_advisory_fires USING btree (fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pi_sessions_active_idx",
      "table": "pi_sessions",
      "definition": "CREATE INDEX pi_sessions_active_idx ON harness_shared.pi_sessions USING btree (workspace_id, session_id) WHERE (ended_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pi_sessions_live_expiry_idx",
      "table": "pi_sessions",
      "definition": "CREATE INDEX pi_sessions_live_expiry_idx ON harness_shared.pi_sessions USING btree (workspace_id, expires_at) WHERE (ended_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pi_sessions_pkey",
      "table": "pi_sessions",
      "definition": "CREATE UNIQUE INDEX pi_sessions_pkey ON harness_shared.pi_sessions USING btree (workspace_id, session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pi_sessions_workspace_idx",
      "table": "pi_sessions",
      "definition": "CREATE INDEX pi_sessions_workspace_idx ON harness_shared.pi_sessions USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pipeline_events_pkey",
      "table": "pipeline_events",
      "definition": "CREATE UNIQUE INDEX pipeline_events_pkey ON harness_shared.pipeline_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pipeline_events_slug_created_idx",
      "table": "pipeline_events",
      "definition": "CREATE INDEX pipeline_events_slug_created_idx ON harness_shared.pipeline_events USING btree (install_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pipeline_events_slug_kind_created_idx",
      "table": "pipeline_events",
      "definition": "CREATE INDEX pipeline_events_slug_kind_created_idx ON harness_shared.pipeline_events USING btree (install_slug, kind, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_audits_created_by_idx",
      "table": "plan_audits",
      "definition": "CREATE INDEX plan_audits_created_by_idx ON harness_shared.plan_audits USING btree (created_by, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_audits_harness_recent_idx",
      "table": "plan_audits",
      "definition": "CREATE INDEX plan_audits_harness_recent_idx ON harness_shared.plan_audits USING btree (workspace_id, harness_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_audits_kind_recent_idx",
      "table": "plan_audits",
      "definition": "CREATE INDEX plan_audits_kind_recent_idx ON harness_shared.plan_audits USING btree (workspace_id, plan_slug, audit_kind, audit_seq DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_audits_pkey",
      "table": "plan_audits",
      "definition": "CREATE UNIQUE INDEX plan_audits_pkey ON harness_shared.plan_audits USING btree (workspace_id, plan_slug, audit_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_cleanup_run_findings_disposition_idx",
      "table": "plan_cleanup_run_findings",
      "definition": "CREATE INDEX plan_cleanup_run_findings_disposition_idx ON harness_shared.plan_cleanup_run_findings USING btree (workspace_id, run_id, disposition)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_cleanup_run_findings_pkey",
      "table": "plan_cleanup_run_findings",
      "definition": "CREATE UNIQUE INDEX plan_cleanup_run_findings_pkey ON harness_shared.plan_cleanup_run_findings USING btree (workspace_id, run_id, finding_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_cleanup_run_findings_plan_idx",
      "table": "plan_cleanup_run_findings",
      "definition": "CREATE INDEX plan_cleanup_run_findings_plan_idx ON harness_shared.plan_cleanup_run_findings USING btree (workspace_id, plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_cleanup_run_findings_run_idx",
      "table": "plan_cleanup_run_findings",
      "definition": "CREATE INDEX plan_cleanup_run_findings_run_idx ON harness_shared.plan_cleanup_run_findings USING btree (workspace_id, run_id, \"position\")",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_closure_observations_pkey",
      "table": "plan_closure_observations",
      "definition": "CREATE UNIQUE INDEX plan_closure_observations_pkey ON harness_shared.plan_closure_observations USING btree (workspace_id, harness_slug, plan_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_decisions_affects_gin",
      "table": "plan_decisions",
      "definition": "CREATE INDEX plan_decisions_affects_gin ON harness_shared.plan_decisions USING gin (affects)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_decisions_execution_tokens_idx",
      "table": "plan_decisions",
      "definition": "CREATE INDEX plan_decisions_execution_tokens_idx ON harness_shared.plan_decisions USING gin (regexp_split_to_array(body, '[^A-Za-z0-9_-]+'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_decisions_item_refs_gin",
      "table": "plan_decisions",
      "definition": "CREATE INDEX plan_decisions_item_refs_gin ON harness_shared.plan_decisions USING gin (item_refs)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_decisions_pkey",
      "table": "plan_decisions",
      "definition": "CREATE UNIQUE INDEX plan_decisions_pkey ON harness_shared.plan_decisions USING btree (workspace_id, harness_slug, plan_slug, decision_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_decisions_plan_seq_idx",
      "table": "plan_decisions",
      "definition": "CREATE INDEX plan_decisions_plan_seq_idx ON harness_shared.plan_decisions USING btree (workspace_id, harness_slug, plan_slug, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_assignments_assignee_idx",
      "table": "plan_item_assignments",
      "definition": "CREATE INDEX plan_item_assignments_assignee_idx ON harness_shared.plan_item_assignments USING btree (workspace_id, assignee_name) WHERE ((assignee_name IS NOT NULL) AND (released_ts IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_assignments_pkey",
      "table": "plan_item_assignments",
      "definition": "CREATE UNIQUE INDEX plan_item_assignments_pkey ON harness_shared.plan_item_assignments USING btree (workspace_id, harness_slug, plan_slug, item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_assignments_plan_idx",
      "table": "plan_item_assignments",
      "definition": "CREATE INDEX plan_item_assignments_plan_idx ON harness_shared.plan_item_assignments USING btree (workspace_id, harness_slug, plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_claims_expires_idx",
      "table": "plan_item_claims",
      "definition": "CREATE INDEX plan_item_claims_expires_idx ON harness_shared.plan_item_claims USING btree (expires_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_claims_name_idx",
      "table": "plan_item_claims",
      "definition": "CREATE INDEX plan_item_claims_name_idx ON harness_shared.plan_item_claims USING btree (workspace_id, owner_name) WHERE (owner_name IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_claims_owner_idx",
      "table": "plan_item_claims",
      "definition": "CREATE INDEX plan_item_claims_owner_idx ON harness_shared.plan_item_claims USING btree (workspace_id, owner)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_item_claims_pkey",
      "table": "plan_item_claims",
      "definition": "CREATE UNIQUE INDEX plan_item_claims_pkey ON harness_shared.plan_item_claims USING btree (workspace_id, harness_slug, plan_slug, item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_items_blocked_by_gin",
      "table": "plan_items",
      "definition": "CREATE INDEX plan_items_blocked_by_gin ON harness_shared.plan_items USING gin (blocked_by)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_items_pkey",
      "table": "plan_items",
      "definition": "CREATE UNIQUE INDEX plan_items_pkey ON harness_shared.plan_items USING btree (workspace_id, harness_slug, plan_slug, item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_items_plan_seq_idx",
      "table": "plan_items",
      "definition": "CREATE INDEX plan_items_plan_seq_idx ON harness_shared.plan_items USING btree (workspace_id, harness_slug, plan_slug, seq)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_items_status_idx",
      "table": "plan_items",
      "definition": "CREATE INDEX plan_items_status_idx ON harness_shared.plan_items USING btree (workspace_id, harness_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_revisions_pkey",
      "table": "plan_revisions",
      "definition": "CREATE UNIQUE INDEX plan_revisions_pkey ON harness_shared.plan_revisions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_revisions_ws_harness_plan_seq_key",
      "table": "plan_revisions",
      "definition": "CREATE UNIQUE INDEX plan_revisions_ws_harness_plan_seq_key ON harness_shared.plan_revisions USING btree (workspace_id, harness_slug, plan_slug, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_run_turns_harness_slug_idx",
      "table": "plan_run_turns",
      "definition": "CREATE INDEX plan_run_turns_harness_slug_idx ON harness_shared.plan_run_turns USING btree (harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_run_turns_pkey",
      "table": "plan_run_turns",
      "definition": "CREATE UNIQUE INDEX plan_run_turns_pkey ON harness_shared.plan_run_turns USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_run_turns_plan_run_id_seq_key",
      "table": "plan_run_turns",
      "definition": "CREATE UNIQUE INDEX plan_run_turns_plan_run_id_seq_key ON harness_shared.plan_run_turns USING btree (plan_run_id, seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_run_turns_workspace_idx",
      "table": "plan_run_turns",
      "definition": "CREATE INDEX plan_run_turns_workspace_idx ON harness_shared.plan_run_turns USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_runs_harness_plan_slug_idx",
      "table": "plan_runs",
      "definition": "CREATE INDEX plan_runs_harness_plan_slug_idx ON harness_shared.plan_runs USING btree (harness_slug, plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_runs_pkey",
      "table": "plan_runs",
      "definition": "CREATE UNIQUE INDEX plan_runs_pkey ON harness_shared.plan_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_runs_plan_slug_idx",
      "table": "plan_runs",
      "definition": "CREATE INDEX plan_runs_plan_slug_idx ON harness_shared.plan_runs USING btree (plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_runs_template_seq_idx",
      "table": "plan_runs",
      "definition": "CREATE INDEX plan_runs_template_seq_idx ON harness_shared.plan_runs USING btree (harness_slug, plan_slug, run_seq DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_runs_workspace_idx",
      "table": "plan_runs",
      "definition": "CREATE INDEX plan_runs_workspace_idx ON harness_shared.plan_runs USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_by_bar",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE INDEX plan_spec_clause_revisions_by_bar ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, source_bar_key, plan_item_id, revision DESC) WHERE (source_bar_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_by_item",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE INDEX plan_spec_clause_revisions_by_item ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, plan_item_id, spec_id, revision DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_by_status",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE INDEX plan_spec_clause_revisions_by_status ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, lifecycle_status, spec_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_content_identity",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE UNIQUE INDEX plan_spec_clause_revisions_content_identity ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, spec_id, revision, content_hash)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_falsifier_declared",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE INDEX plan_spec_clause_revisions_falsifier_declared ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, spec_id, revision DESC) WHERE (falsifier IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clause_revisions_pkey",
      "table": "plan_spec_clause_revisions",
      "definition": "CREATE UNIQUE INDEX plan_spec_clause_revisions_pkey ON harness_shared.plan_spec_clause_revisions USING btree (workspace_id, harness_slug, plan_slug, spec_id, revision)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clauses_by_plan",
      "table": "plan_spec_clauses",
      "definition": "CREATE INDEX plan_spec_clauses_by_plan ON harness_shared.plan_spec_clauses USING btree (workspace_id, harness_slug, plan_slug, spec_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clauses_pkey",
      "table": "plan_spec_clauses",
      "definition": "CREATE UNIQUE INDEX plan_spec_clauses_pkey ON harness_shared.plan_spec_clauses USING btree (workspace_id, harness_slug, plan_slug, spec_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plan_spec_clauses_source_val_identity",
      "table": "plan_spec_clauses",
      "definition": "CREATE UNIQUE INDEX plan_spec_clauses_source_val_identity ON harness_shared.plan_spec_clauses USING btree (workspace_id, harness_slug, source_val_id) WHERE (source_val_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plan_work_group_members_pkey",
      "table": "plan_work_group_members",
      "definition": "CREATE UNIQUE INDEX plan_work_group_members_pkey ON harness_shared.plan_work_group_members USING btree (workspace_id, harness_slug, plan_slug, member_user)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_audit_by_harness",
      "table": "plugin_audit_log",
      "definition": "CREATE INDEX plugin_audit_by_harness ON harness_shared.plugin_audit_log USING btree (install_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_audit_by_plugin",
      "table": "plugin_audit_log",
      "definition": "CREATE INDEX plugin_audit_by_plugin ON harness_shared.plugin_audit_log USING btree (plugin_name, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_audit_log_pkey",
      "table": "plugin_audit_log",
      "definition": "CREATE UNIQUE INDEX plugin_audit_log_pkey ON harness_shared.plugin_audit_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_audit_outcome",
      "table": "plugin_audit_log",
      "definition": "CREATE INDEX plugin_audit_outcome ON harness_shared.plugin_audit_log USING btree (outcome) WHERE (outcome <> 'ok'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_capability_grants_pkey",
      "table": "plugin_capability_grants",
      "definition": "CREATE UNIQUE INDEX plugin_capability_grants_pkey ON harness_shared.plugin_capability_grants USING btree (plugin_name, plugin_version, harness_slug, capability)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_caps_by_harness",
      "table": "plugin_capability_grants",
      "definition": "CREATE INDEX plugin_caps_by_harness ON harness_shared.plugin_capability_grants USING btree (harness_slug, plugin_name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_caps_by_plugin",
      "table": "plugin_capability_grants",
      "definition": "CREATE INDEX plugin_caps_by_plugin ON harness_shared.plugin_capability_grants USING btree (plugin_name, plugin_version)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_configs_pkey",
      "table": "plugin_configs",
      "definition": "CREATE UNIQUE INDEX plugin_configs_pkey ON harness_shared.plugin_configs USING btree (harness_slug, plugin_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_configs_plugin_idx",
      "table": "plugin_configs",
      "definition": "CREATE INDEX plugin_configs_plugin_idx ON harness_shared.plugin_configs USING btree (plugin_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_configs_workspace_idx",
      "table": "plugin_configs",
      "definition": "CREATE INDEX plugin_configs_workspace_idx ON harness_shared.plugin_configs USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_enables_pkey",
      "table": "plugin_enables",
      "definition": "CREATE UNIQUE INDEX plugin_enables_pkey ON harness_shared.plugin_enables USING btree (harness_slug, plugin_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_enables_plugin_idx",
      "table": "plugin_enables",
      "definition": "CREATE INDEX plugin_enables_plugin_idx ON harness_shared.plugin_enables USING btree (plugin_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_enables_workspace_idx",
      "table": "plugin_enables",
      "definition": "CREATE INDEX plugin_enables_workspace_idx ON harness_shared.plugin_enables USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "plugin_kv_pkey",
      "table": "plugin_kv",
      "definition": "CREATE UNIQUE INDEX plugin_kv_pkey ON harness_shared.plugin_kv USING btree (plugin_id, harness_slug, key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "plugin_reload_state_pkey",
      "table": "plugin_reload_state",
      "definition": "CREATE UNIQUE INDEX plugin_reload_state_pkey ON harness_shared.plugin_reload_state USING btree (plugin_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_capability_class_bindings_pkey",
      "table": "pot_capability_class_bindings",
      "definition": "CREATE UNIQUE INDEX pot_capability_class_bindings_pkey ON harness_shared.pot_capability_class_bindings USING btree (workspace_id, pot_slug, class_id, class_version)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_capability_class_provider_reverse_idx",
      "table": "pot_capability_class_bindings",
      "definition": "CREATE INDEX pot_capability_class_provider_reverse_idx ON harness_shared.pot_capability_class_bindings USING btree (workspace_id, provider_package, provider_version)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_directory_cache_pkey",
      "table": "pot_directory_cache",
      "definition": "CREATE UNIQUE INDEX pot_directory_cache_pkey ON harness_shared.pot_directory_cache USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_directory_tombstones_pkey",
      "table": "pot_directory_tombstones",
      "definition": "CREATE UNIQUE INDEX pot_directory_tombstones_pkey ON harness_shared.pot_directory_tombstones USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_epoch_keys_pkey",
      "table": "pot_epoch_keys",
      "definition": "CREATE UNIQUE INDEX pot_epoch_keys_pkey ON harness_shared.pot_epoch_keys USING btree (workspace_id, harness_slug, epoch, member_device_pubkey)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_bakeoff_deltas_pkey",
      "table": "pot_eval_bakeoff_deltas",
      "definition": "CREATE UNIQUE INDEX pot_eval_bakeoff_deltas_pkey ON harness_shared.pot_eval_bakeoff_deltas USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_bakeoff_deltas_ws_run_idx",
      "table": "pot_eval_bakeoff_deltas",
      "definition": "CREATE INDEX pot_eval_bakeoff_deltas_ws_run_idx ON harness_shared.pot_eval_bakeoff_deltas USING btree (workspace_id, run_at_ms DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_instances_pkey",
      "table": "pot_eval_instances",
      "definition": "CREATE UNIQUE INDEX pot_eval_instances_pkey ON harness_shared.pot_eval_instances USING btree (instance_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_instances_workspace_id_code_sha_genome_id_key",
      "table": "pot_eval_instances",
      "definition": "CREATE UNIQUE INDEX pot_eval_instances_workspace_id_code_sha_genome_id_key ON harness_shared.pot_eval_instances USING btree (workspace_id, code_sha, genome_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_runs_instance_id_scenario_id_repeat_key",
      "table": "pot_eval_runs",
      "definition": "CREATE UNIQUE INDEX pot_eval_runs_instance_id_scenario_id_repeat_key ON harness_shared.pot_eval_runs USING btree (instance_id, scenario_id, repeat)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_runs_instance_idx",
      "table": "pot_eval_runs",
      "definition": "CREATE INDEX pot_eval_runs_instance_idx ON harness_shared.pot_eval_runs USING btree (instance_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_runs_pkey",
      "table": "pot_eval_runs",
      "definition": "CREATE UNIQUE INDEX pot_eval_runs_pkey ON harness_shared.pot_eval_runs USING btree (run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_runs_scenario_idx",
      "table": "pot_eval_runs",
      "definition": "CREATE INDEX pot_eval_runs_scenario_idx ON harness_shared.pot_eval_runs USING btree (scenario_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_scenarios_pkey",
      "table": "pot_eval_scenarios",
      "definition": "CREATE UNIQUE INDEX pot_eval_scenarios_pkey ON harness_shared.pot_eval_scenarios USING btree (scenario_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_scores_composite_idx",
      "table": "pot_eval_scores",
      "definition": "CREATE INDEX pot_eval_scores_composite_idx ON harness_shared.pot_eval_scores USING btree (composite)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_scores_pkey",
      "table": "pot_eval_scores",
      "definition": "CREATE UNIQUE INDEX pot_eval_scores_pkey ON harness_shared.pot_eval_scores USING btree (run_id, rubric_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_eval_scores_run_idx",
      "table": "pot_eval_scores",
      "definition": "CREATE INDEX pot_eval_scores_run_idx ON harness_shared.pot_eval_scores USING btree (run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_integration_requests_author_idx",
      "table": "pot_integration_requests",
      "definition": "CREATE INDEX pot_integration_requests_author_idx ON harness_shared.pot_integration_requests USING btree (workspace_id, device_pubkey, created_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_integration_requests_pkey",
      "table": "pot_integration_requests",
      "definition": "CREATE UNIQUE INDEX pot_integration_requests_pkey ON harness_shared.pot_integration_requests USING btree (workspace_id, pot_slug, repo_key, device_pubkey, head_sha)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_members_pkey",
      "table": "pot_members",
      "definition": "CREATE UNIQUE INDEX pot_members_pkey ON harness_shared.pot_members USING btree (workspace_id, pot_home_slug, github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_members_username_idx",
      "table": "pot_members",
      "definition": "CREATE INDEX pot_members_username_idx ON harness_shared.pot_members USING btree (workspace_id, pot_home_slug, github_username)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_pending_joins_pkey",
      "table": "pot_pending_joins",
      "definition": "CREATE UNIQUE INDEX pot_pending_joins_pkey ON harness_shared.pot_pending_joins USING btree (workspace_id, harness_slug, github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_placements_open_idx",
      "table": "pot_placements",
      "definition": "CREATE INDEX pot_placements_open_idx ON harness_shared.pot_placements USING btree (workspace_id, install_slug, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_placements_pkey",
      "table": "pot_placements",
      "definition": "CREATE UNIQUE INDEX pot_placements_pkey ON harness_shared.pot_placements USING btree (workspace_id, install_slug, work_item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_placements_recovering_age_idx",
      "table": "pot_placements",
      "definition": "CREATE INDEX pot_placements_recovering_age_idx ON harness_shared.pot_placements USING btree (workspace_id, install_slug, recovery_started_at) WHERE (status = 'recovering'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_policy_pkey",
      "table": "pot_policy",
      "definition": "CREATE UNIQUE INDEX pot_policy_pkey ON harness_shared.pot_policy USING btree (workspace_id, harness_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_reports_pkey",
      "table": "pot_reports",
      "definition": "CREATE UNIQUE INDEX pot_reports_pkey ON harness_shared.pot_reports USING btree (workspace_id, harness_slug, report_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_settings_pkey",
      "table": "pot_settings",
      "definition": "CREATE UNIQUE INDEX pot_settings_pkey ON harness_shared.pot_settings USING btree (workspace_id, harness_slug, setting_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_throughput_ticks_pkey",
      "table": "pot_throughput_ticks",
      "definition": "CREATE UNIQUE INDEX pot_throughput_ticks_pkey ON harness_shared.pot_throughput_ticks USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_throughput_ticks_ws_pot_tick_idx",
      "table": "pot_throughput_ticks",
      "definition": "CREATE INDEX pot_throughput_ticks_ws_pot_tick_idx ON harness_shared.pot_throughput_ticks USING btree (workspace_id, pot_slug, tick_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pot_wake_pkey",
      "table": "pot_wake",
      "definition": "CREATE UNIQUE INDEX pot_wake_pkey ON harness_shared.pot_wake USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_watchdog_fires_pkey",
      "table": "pot_watchdog_fires",
      "definition": "CREATE UNIQUE INDEX pot_watchdog_fires_pkey ON harness_shared.pot_watchdog_fires USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pot_watchdog_fires_ws_install_fired_idx",
      "table": "pot_watchdog_fires",
      "definition": "CREATE INDEX pot_watchdog_fires_ws_install_fired_idx ON harness_shared.pot_watchdog_fires USING btree (workspace_id, install_slug, fired_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pots_canonical_home_slug_key",
      "table": "pots",
      "definition": "CREATE UNIQUE INDEX pots_canonical_home_slug_key ON harness_shared.pots USING btree (workspace_id, canonical_pot_home_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pots_pkey",
      "table": "pots",
      "definition": "CREATE UNIQUE INDEX pots_pkey ON harness_shared.pots USING btree (workspace_id, pot_home_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pots_public_key_key",
      "table": "pots",
      "definition": "CREATE UNIQUE INDEX pots_public_key_key ON harness_shared.pots USING btree (public_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "power_user_sessions_pkey",
      "table": "power_user_sessions",
      "definition": "CREATE UNIQUE INDEX power_user_sessions_pkey ON harness_shared.power_user_sessions USING btree (auth_session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "power_user_sessions_workspace_idx",
      "table": "power_user_sessions",
      "definition": "CREATE INDEX power_user_sessions_workspace_idx ON harness_shared.power_user_sessions USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pr_check_status_cache_pkey",
      "table": "pr_check_status_cache",
      "definition": "CREATE UNIQUE INDEX pr_check_status_cache_pkey ON harness_shared.pr_check_status_cache USING btree (workspace_id, harness_slug, head_sha, check_name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pr_check_status_cache_sha_idx",
      "table": "pr_check_status_cache",
      "definition": "CREATE INDEX pr_check_status_cache_sha_idx ON harness_shared.pr_check_status_cache USING btree (workspace_id, harness_slug, head_sha)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pr_review_reports_pkey",
      "table": "pr_review_reports",
      "definition": "CREATE UNIQUE INDEX pr_review_reports_pkey ON harness_shared.pr_review_reports USING btree (workspace_id, harness_slug, pr_number, head_sha)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "pr_review_reports_pr_idx",
      "table": "pr_review_reports",
      "definition": "CREATE INDEX pr_review_reports_pr_idx ON harness_shared.pr_review_reports USING btree (workspace_id, harness_slug, pr_number, reviewed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pr_reviewer_settings_pkey",
      "table": "pr_reviewer_settings",
      "definition": "CREATE UNIQUE INDEX pr_reviewer_settings_pkey ON harness_shared.pr_reviewer_settings USING btree (workspace_id, harness_slug, github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "predicate_watches_bound_to_active",
      "table": "predicate_watches",
      "definition": "CREATE INDEX predicate_watches_bound_to_active ON harness_shared.predicate_watches USING btree (((bound_to ->> 'kind'::text)), ((bound_to ->> 'ref'::text))) WHERE ((bound_to IS NOT NULL) AND active)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "predicate_watches_due",
      "table": "predicate_watches",
      "definition": "CREATE INDEX predicate_watches_due ON harness_shared.predicate_watches USING btree (workspace_id, last_polled_at) WHERE active",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "predicate_watches_event_key",
      "table": "predicate_watches",
      "definition": "CREATE INDEX predicate_watches_event_key ON harness_shared.predicate_watches USING btree (event_key) WHERE active",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "predicate_watches_pkey",
      "table": "predicate_watches",
      "definition": "CREATE UNIQUE INDEX predicate_watches_pkey ON harness_shared.predicate_watches USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "project_spec_revisions_pkey",
      "table": "project_spec_revisions",
      "definition": "CREATE UNIQUE INDEX project_spec_revisions_pkey ON harness_shared.project_spec_revisions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "project_spec_revisions_workspace_idx",
      "table": "project_spec_revisions",
      "definition": "CREATE INDEX project_spec_revisions_workspace_idx ON harness_shared.project_spec_revisions USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_ephemeral_idx",
      "table": "projects",
      "definition": "CREATE INDEX projects_ephemeral_idx ON harness_shared.projects USING btree (slug) WHERE (ephemeral = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_parent_idx",
      "table": "projects",
      "definition": "CREATE INDEX projects_parent_idx ON harness_shared.projects USING btree (parent_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_pkey",
      "table": "projects",
      "definition": "CREATE UNIQUE INDEX projects_pkey ON harness_shared.projects USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "projects_search_idx",
      "table": "projects",
      "definition": "CREATE INDEX projects_search_idx ON harness_shared.projects USING gin (_search)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_status_idx",
      "table": "projects",
      "definition": "CREATE INDEX projects_status_idx ON harness_shared.projects USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_workspace_idx",
      "table": "projects",
      "definition": "CREATE INDEX projects_workspace_idx ON harness_shared.projects USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "projects_ws_slug_idx",
      "table": "projects",
      "definition": "CREATE UNIQUE INDEX projects_ws_slug_idx ON harness_shared.projects USING btree (workspace_id, slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "prompt_ablation_runs_pkey",
      "table": "prompt_ablation_runs",
      "definition": "CREATE UNIQUE INDEX prompt_ablation_runs_pkey ON harness_shared.prompt_ablation_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "prompt_ablation_runs_pot_idx",
      "table": "prompt_ablation_runs",
      "definition": "CREATE INDEX prompt_ablation_runs_pot_idx ON harness_shared.prompt_ablation_runs USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "prompt_ablation_runs_rule_idx",
      "table": "prompt_ablation_runs",
      "definition": "CREATE INDEX prompt_ablation_runs_rule_idx ON harness_shared.prompt_ablation_runs USING btree (workspace_id, rule_key, finished_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "prompt_compositions_by_feature",
      "table": "prompt_compositions",
      "definition": "CREATE INDEX prompt_compositions_by_feature ON harness_shared.prompt_compositions USING btree (workspace_id, harness_slug, feature_id, ts_ms DESC) WHERE (feature_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "prompt_compositions_by_harness",
      "table": "prompt_compositions",
      "definition": "CREATE INDEX prompt_compositions_by_harness ON harness_shared.prompt_compositions USING btree (workspace_id, harness_slug, ts_ms DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "prompt_compositions_pkey",
      "table": "prompt_compositions",
      "definition": "CREATE UNIQUE INDEX prompt_compositions_pkey ON harness_shared.prompt_compositions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "provider_identity_mappings_live_identity",
      "table": "provider_identity_mappings",
      "definition": "CREATE UNIQUE INDEX provider_identity_mappings_live_identity ON harness_shared.provider_identity_mappings USING btree (workspace_id, provider, provider_user_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "provider_identity_mappings_pkey",
      "table": "provider_identity_mappings",
      "definition": "CREATE UNIQUE INDEX provider_identity_mappings_pkey ON harness_shared.provider_identity_mappings USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "provider_identity_mappings_user_idx",
      "table": "provider_identity_mappings",
      "definition": "CREATE INDEX provider_identity_mappings_user_idx ON harness_shared.provider_identity_mappings USING btree (workspace_id, user_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "provision_audit_log_pkey",
      "table": "provision_audit_log",
      "definition": "CREATE UNIQUE INDEX provision_audit_log_pkey ON harness_shared.provision_audit_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "provision_audit_log_target_idx",
      "table": "provision_audit_log",
      "definition": "CREATE INDEX provision_audit_log_target_idx ON harness_shared.provision_audit_log USING btree (workspace_id, harness_slug, plugin_slug, ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "provision_state_pkey",
      "table": "provision_state",
      "definition": "CREATE UNIQUE INDEX provision_state_pkey ON harness_shared.provision_state USING btree (workspace_id, harness_slug, plugin_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "psr_author_role_idx",
      "table": "project_spec_revisions",
      "definition": "CREATE INDEX psr_author_role_idx ON harness_shared.project_spec_revisions USING btree (author_role)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psr_project_idx",
      "table": "project_spec_revisions",
      "definition": "CREATE INDEX psr_project_idx ON harness_shared.project_spec_revisions USING btree (project_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psr_ts_idx",
      "table": "project_spec_revisions",
      "definition": "CREATE INDEX psr_ts_idx ON harness_shared.project_spec_revisions USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psu_pty_host_events_digest_uk",
      "table": "psu_pty_host_events",
      "definition": "CREATE UNIQUE INDEX psu_pty_host_events_digest_uk ON harness_shared.psu_pty_host_events USING btree (row_digest)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psu_pty_host_events_kind_ts_idx",
      "table": "psu_pty_host_events",
      "definition": "CREATE INDEX psu_pty_host_events_kind_ts_idx ON harness_shared.psu_pty_host_events USING btree (kind, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psu_pty_host_events_owner_ts_idx",
      "table": "psu_pty_host_events",
      "definition": "CREATE INDEX psu_pty_host_events_owner_ts_idx ON harness_shared.psu_pty_host_events USING btree (owner_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "psu_pty_host_events_pkey",
      "table": "psu_pty_host_events",
      "definition": "CREATE UNIQUE INDEX psu_pty_host_events_pkey ON harness_shared.psu_pty_host_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "psu_pty_host_events_ts_idx",
      "table": "psu_pty_host_events",
      "definition": "CREATE INDEX psu_pty_host_events_ts_idx ON harness_shared.psu_pty_host_events USING btree (ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pty_viewer_heartbeats_fresh_idx",
      "table": "pty_viewer_heartbeats",
      "definition": "CREATE INDEX pty_viewer_heartbeats_fresh_idx ON harness_shared.pty_viewer_heartbeats USING btree (viewer_attached_at, owner_sid)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "pty_viewer_heartbeats_pkey",
      "table": "pty_viewer_heartbeats",
      "definition": "CREATE UNIQUE INDEX pty_viewer_heartbeats_pkey ON harness_shared.pty_viewer_heartbeats USING btree (pty_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "push_delivery_delivered_idx",
      "table": "push_delivery",
      "definition": "CREATE INDEX push_delivery_delivered_idx ON harness_shared.push_delivery USING btree (target_owner_id, delivered_at DESC) WHERE (status = 'delivered'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "push_delivery_pending_idx",
      "table": "push_delivery",
      "definition": "CREATE INDEX push_delivery_pending_idx ON harness_shared.push_delivery USING btree (target_owner_id, enqueued_at) WHERE (status = 'queued'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "push_delivery_pkey",
      "table": "push_delivery",
      "definition": "CREATE UNIQUE INDEX push_delivery_pkey ON harness_shared.push_delivery USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "push_delivery_ref_idx",
      "table": "push_delivery",
      "definition": "CREATE INDEX push_delivery_ref_idx ON harness_shared.push_delivery USING btree (handle_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "rationale_index_key_idx",
      "table": "rationale_index",
      "definition": "CREATE INDEX rationale_index_key_idx ON harness_shared.rationale_index USING btree (key, sort_key DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "rationale_index_pkey",
      "table": "rationale_index",
      "definition": "CREATE UNIQUE INDEX rationale_index_pkey ON harness_shared.rationale_index USING btree (source_id, key, entry_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "rationale_index_source_idx",
      "table": "rationale_index",
      "definition": "CREATE INDEX rationale_index_source_idx ON harness_shared.rationale_index USING btree (source_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "reconciliation_breaks_one_open_idx",
      "table": "reconciliation_breaks",
      "definition": "CREATE UNIQUE INDEX reconciliation_breaks_one_open_idx ON harness_shared.reconciliation_breaks USING btree (workspace_id, invariant) WHERE (resolved_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "reconciliation_breaks_pkey",
      "table": "reconciliation_breaks",
      "definition": "CREATE UNIQUE INDEX reconciliation_breaks_pkey ON harness_shared.reconciliation_breaks USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "reconciliation_breaks_workspace_opened_idx",
      "table": "reconciliation_breaks",
      "definition": "CREATE INDEX reconciliation_breaks_workspace_opened_idx ON harness_shared.reconciliation_breaks USING btree (workspace_id, opened_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "reconciliation_runs_pkey",
      "table": "reconciliation_runs",
      "definition": "CREATE UNIQUE INDEX reconciliation_runs_pkey ON harness_shared.reconciliation_runs USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "reconciliation_runs_workspace_finished_idx",
      "table": "reconciliation_runs",
      "definition": "CREATE INDEX reconciliation_runs_workspace_finished_idx ON harness_shared.reconciliation_runs USING btree (workspace_id, finished_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "red_queen_drills_class_idx",
      "table": "red_queen_drills",
      "definition": "CREATE INDEX red_queen_drills_class_idx ON harness_shared.red_queen_drills USING btree (workspace_id, drill_class, planted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "red_queen_drills_open_class_uq",
      "table": "red_queen_drills",
      "definition": "CREATE UNIQUE INDEX red_queen_drills_open_class_uq ON harness_shared.red_queen_drills USING btree (workspace_id, drill_class) WHERE (status = ANY (ARRAY['planted'::text, 'detected'::text, 'triaged'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "red_queen_drills_pkey",
      "table": "red_queen_drills",
      "definition": "CREATE UNIQUE INDEX red_queen_drills_pkey ON harness_shared.red_queen_drills USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "red_queen_drills_recent_idx",
      "table": "red_queen_drills",
      "definition": "CREATE INDEX red_queen_drills_recent_idx ON harness_shared.red_queen_drills USING btree (workspace_id, planted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "regret_findings_pending_idx",
      "table": "regret_findings",
      "definition": "CREATE INDEX regret_findings_pending_idx ON harness_shared.regret_findings USING btree (workspace_id, mined_at DESC) WHERE (replay_status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "regret_findings_pkey",
      "table": "regret_findings",
      "definition": "CREATE UNIQUE INDEX regret_findings_pkey ON harness_shared.regret_findings USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "releases_pkey",
      "table": "releases",
      "definition": "CREATE UNIQUE INDEX releases_pkey ON harness_shared.releases USING btree (workspace_id, channel, version)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "releases_ws_channel_cut_at_idx",
      "table": "releases",
      "definition": "CREATE INDEX releases_ws_channel_cut_at_idx ON harness_shared.releases USING btree (workspace_id, channel, cut_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "remote_access_own_tunnel_pkey",
      "table": "remote_access_own_tunnel",
      "definition": "CREATE UNIQUE INDEX remote_access_own_tunnel_pkey ON harness_shared.remote_access_own_tunnel USING btree (singleton)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "remote_access_portal_relay_pkey",
      "table": "remote_access_portal_relay",
      "definition": "CREATE UNIQUE INDEX remote_access_portal_relay_pkey ON harness_shared.remote_access_portal_relay USING btree (singleton)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "replay_runs_pkey",
      "table": "replay_runs",
      "definition": "CREATE UNIQUE INDEX replay_runs_pkey ON harness_shared.replay_runs USING btree (workspace_id, run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "replay_runs_ws_battery_idx",
      "table": "replay_runs",
      "definition": "CREATE INDEX replay_runs_ws_battery_idx ON harness_shared.replay_runs USING btree (workspace_id, battery_id, created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "replay_runs_ws_created_idx",
      "table": "replay_runs",
      "definition": "CREATE INDEX replay_runs_ws_created_idx ON harness_shared.replay_runs USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_chunks_embedding_hnsw",
      "table": "report_library_chunks",
      "definition": "CREATE INDEX report_library_chunks_embedding_hnsw ON harness_shared.report_library_chunks USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_chunks_pkey",
      "table": "report_library_chunks",
      "definition": "CREATE UNIQUE INDEX report_library_chunks_pkey ON harness_shared.report_library_chunks USING btree (workspace_id, report_id, chunk_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "report_library_chunks_unembedded_idx",
      "table": "report_library_chunks",
      "definition": "CREATE INDEX report_library_chunks_unembedded_idx ON harness_shared.report_library_chunks USING btree (workspace_id, report_id) WHERE (embedding IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_kind_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_kind_idx ON harness_shared.report_library USING btree (workspace_id, kind, published_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_lineage_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_lineage_idx ON harness_shared.report_library USING btree (workspace_id, lineage_id, published_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_origin_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_origin_idx ON harness_shared.report_library USING btree (workspace_id, origin_harness_slug, published_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_pkey",
      "table": "report_library",
      "definition": "CREATE UNIQUE INDEX report_library_pkey ON harness_shared.report_library USING btree (workspace_id, report_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "report_library_published_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_published_idx ON harness_shared.report_library USING btree (workspace_id, published_at DESC) WHERE (retired_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_subject_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_subject_idx ON harness_shared.report_library USING btree (workspace_id, subject_kind, subject_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_tags_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_tags_idx ON harness_shared.report_library USING gin (tags)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "report_library_tsv_idx",
      "table": "report_library",
      "definition": "CREATE INDEX report_library_tsv_idx ON harness_shared.report_library USING gin (search_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_fleet_idx",
      "table": "resource_allotments",
      "definition": "CREATE INDEX resource_allotments_fleet_idx ON harness_shared.resource_allotments USING btree (workspace_id, fleet_slug) WHERE (status = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_fleet_uniq",
      "table": "resource_allotments",
      "definition": "CREATE UNIQUE INDEX resource_allotments_fleet_uniq ON harness_shared.resource_allotments USING btree (workspace_id, fleet_slug, resource_kind, resource_ref) WHERE (fleet_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_pkey",
      "table": "resource_allotments",
      "definition": "CREATE UNIQUE INDEX resource_allotments_pkey ON harness_shared.resource_allotments USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_pot_idx",
      "table": "resource_allotments",
      "definition": "CREATE INDEX resource_allotments_pot_idx ON harness_shared.resource_allotments USING btree (workspace_id, pot_slug) WHERE ((status = 'active'::text) AND (pot_slug IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_pot_uniq",
      "table": "resource_allotments",
      "definition": "CREATE UNIQUE INDEX resource_allotments_pot_uniq ON harness_shared.resource_allotments USING btree (workspace_id, pot_slug, resource_kind, resource_ref) WHERE (pot_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_allotments_ws_idx",
      "table": "resource_allotments",
      "definition": "CREATE INDEX resource_allotments_ws_idx ON harness_shared.resource_allotments USING btree (workspace_id) WHERE (status = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_active_coalesce_idx",
      "table": "resource_governor_admissions",
      "definition": "CREATE INDEX resource_governor_admissions_active_coalesce_idx ON harness_shared.resource_governor_admissions USING btree (workspace_id, namespace, coalesce_key, enqueued_at_ms DESC, receipt_id) WHERE ((coalesce_key IS NOT NULL) AND (state = ANY (ARRAY['queued'::text, 'eligible'::text, 'leased'::text, 'running'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_active_lease_idx",
      "table": "resource_governor_admissions",
      "definition": "CREATE INDEX resource_governor_admissions_active_lease_idx ON harness_shared.resource_governor_admissions USING btree (workspace_id, namespace, lease_expires_at_ms, lease_owner, receipt_id) WHERE (state = ANY (ARRAY['leased'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_active_queue_idx",
      "table": "resource_governor_admissions",
      "definition": "CREATE INDEX resource_governor_admissions_active_queue_idx ON harness_shared.resource_governor_admissions USING btree (workspace_id, namespace, state, admission_class, priority DESC, enqueued_at_ms, receipt_id) WHERE (state = ANY (ARRAY['queued'::text, 'eligible'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_identity_uq",
      "table": "resource_governor_admissions",
      "definition": "CREATE UNIQUE INDEX resource_governor_admissions_identity_uq ON harness_shared.resource_governor_admissions USING btree (workspace_id, namespace, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_pending_expiry_idx",
      "table": "resource_governor_admissions",
      "definition": "CREATE INDEX resource_governor_admissions_pending_expiry_idx ON harness_shared.resource_governor_admissions USING btree (workspace_id, namespace, deadline_at_ms, updated_at_ms, receipt_id) WHERE (state = ANY (ARRAY['queued'::text, 'eligible'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_pkey",
      "table": "resource_governor_admissions",
      "definition": "CREATE UNIQUE INDEX resource_governor_admissions_pkey ON harness_shared.resource_governor_admissions USING btree (workspace_id, receipt_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "resource_governor_admissions_terminal_retention_idx",
      "table": "resource_governor_admissions",
      "definition": "CREATE INDEX resource_governor_admissions_terminal_retention_idx ON harness_shared.resource_governor_admissions USING btree (updated_at_ms, workspace_id, receipt_id) WHERE (state = ANY (ARRAY['completed'::text, 'cancelled'::text, 'superseded'::text, 'expired'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "role_capability_grants_pkey",
      "table": "role_capability_grants",
      "definition": "CREATE UNIQUE INDEX role_capability_grants_pkey ON harness_shared.role_capability_grants USING btree (workspace_id, role)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "route_invocations_pkey",
      "table": "route_invocations",
      "definition": "CREATE UNIQUE INDEX route_invocations_pkey ON harness_shared.route_invocations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "route_invocations_ws_time_idx",
      "table": "route_invocations",
      "definition": "CREATE INDEX route_invocations_ws_time_idx ON harness_shared.route_invocations USING btree (workspace_id, invoked_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routine_groups_pkey",
      "table": "routine_groups",
      "definition": "CREATE UNIQUE INDEX routine_groups_pkey ON harness_shared.routine_groups USING btree (workspace_id, slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "routine_loop_transitions_at_idx",
      "table": "routine_loop_transitions",
      "definition": "CREATE INDEX routine_loop_transitions_at_idx ON harness_shared.routine_loop_transitions USING btree (at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routine_loop_transitions_pkey",
      "table": "routine_loop_transitions",
      "definition": "CREATE UNIQUE INDEX routine_loop_transitions_pkey ON harness_shared.routine_loop_transitions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "routine_loop_transitions_routine_at_idx",
      "table": "routine_loop_transitions",
      "definition": "CREATE INDEX routine_loop_transitions_routine_at_idx ON harness_shared.routine_loop_transitions USING btree (workspace_id, routine_id, at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routine_pool_shed_events_pkey",
      "table": "routine_pool_shed_events",
      "definition": "CREATE UNIQUE INDEX routine_pool_shed_events_pkey ON harness_shared.routine_pool_shed_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "routine_pool_shed_events_workspace_at_idx",
      "table": "routine_pool_shed_events",
      "definition": "CREATE INDEX routine_pool_shed_events_workspace_at_idx ON harness_shared.routine_pool_shed_events USING btree (workspace_id, at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_active_due_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_active_due_idx ON harness_shared.routines USING btree (active, next_fire_at) WHERE (active = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_group_slug_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_group_slug_idx ON harness_shared.routines USING btree (workspace_id, group_slug) WHERE (group_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_in_process_tier_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_in_process_tier_idx ON harness_shared.routines USING btree (tier, name) WHERE (tier = 'in-process'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_install_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_install_idx ON harness_shared.routines USING btree (install_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_install_slug_name_key",
      "table": "routines",
      "definition": "CREATE UNIQUE INDEX routines_install_slug_name_key ON harness_shared.routines USING btree (install_slug, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "routines_loop_interval_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_loop_interval_idx ON harness_shared.routines USING btree (reschedule_interval_sec) WHERE (reschedule_interval_sec IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_pkey",
      "table": "routines",
      "definition": "CREATE UNIQUE INDEX routines_pkey ON harness_shared.routines USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "routines_tier_active_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_tier_active_idx ON harness_shared.routines USING btree (tier, active) WHERE (active = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_workspace_idx",
      "table": "routines",
      "definition": "CREATE INDEX routines_workspace_idx ON harness_shared.routines USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "routines_workspace_install_slug_name_key",
      "table": "routines",
      "definition": "CREATE UNIQUE INDEX routines_workspace_install_slug_name_key ON harness_shared.routines USING btree (workspace_id, install_slug, name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "rubric_amend_receipts_finished_idx",
      "table": "rubric_amend_receipts",
      "definition": "CREATE INDEX rubric_amend_receipts_finished_idx ON harness_shared.rubric_amend_receipts USING btree (finished_at) WHERE (state <> 'running'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "rubric_amend_receipts_pkey",
      "table": "rubric_amend_receipts",
      "definition": "CREATE UNIQUE INDEX rubric_amend_receipts_pkey ON harness_shared.rubric_amend_receipts USING btree (workspace_id, rubric_ref, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "runtime_vintage_pkey",
      "table": "runtime_vintage",
      "definition": "CREATE UNIQUE INDEX runtime_vintage_pkey ON harness_shared.runtime_vintage USING btree (workspace_id, unit, host)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "runtime_vintage_reported_at_idx",
      "table": "runtime_vintage",
      "definition": "CREATE INDEX runtime_vintage_reported_at_idx ON harness_shared.runtime_vintage USING btree (reported_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "saved_prompts_pkey",
      "table": "saved_prompts",
      "definition": "CREATE UNIQUE INDEX saved_prompts_pkey ON harness_shared.saved_prompts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "saved_prompts_scope_name",
      "table": "saved_prompts",
      "definition": "CREATE UNIQUE INDEX saved_prompts_scope_name ON harness_shared.saved_prompts USING btree (workspace_id, COALESCE(harness_slug, ''::text), name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "saved_prompts_scope_parent",
      "table": "saved_prompts",
      "definition": "CREATE INDEX saved_prompts_scope_parent ON harness_shared.saved_prompts USING btree (workspace_id, COALESCE(harness_slug, ''::text), parent_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "schema_migrations_pkey",
      "table": "schema_migrations",
      "definition": "CREATE UNIQUE INDEX schema_migrations_pkey ON harness_shared.schema_migrations USING btree (filename)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_cycle_stage_artifacts_pkey",
      "table": "scout_cycle_stage_artifacts",
      "definition": "CREATE UNIQUE INDEX scout_cycle_stage_artifacts_pkey ON harness_shared.scout_cycle_stage_artifacts USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_cycle_stage_artifacts_ws_created_idx",
      "table": "scout_cycle_stage_artifacts",
      "definition": "CREATE INDEX scout_cycle_stage_artifacts_ws_created_idx ON harness_shared.scout_cycle_stage_artifacts USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_cycle_stage_artifacts_ws_cycle_uniq",
      "table": "scout_cycle_stage_artifacts",
      "definition": "CREATE UNIQUE INDEX scout_cycle_stage_artifacts_ws_cycle_uniq ON harness_shared.scout_cycle_stage_artifacts USING btree (workspace_id, cycle_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_digest_snapshots_pkey",
      "table": "scout_digest_snapshots",
      "definition": "CREATE UNIQUE INDEX scout_digest_snapshots_pkey ON harness_shared.scout_digest_snapshots USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_digest_snapshots_ws_created_idx",
      "table": "scout_digest_snapshots",
      "definition": "CREATE INDEX scout_digest_snapshots_ws_created_idx ON harness_shared.scout_digest_snapshots USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_lens_weights_pkey",
      "table": "scout_lens_weights",
      "definition": "CREATE UNIQUE INDEX scout_lens_weights_pkey ON harness_shared.scout_lens_weights USING btree (workspace_id, lens, pot_slug)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_pkey",
      "table": "scout_routed_ideas",
      "definition": "CREATE UNIQUE INDEX scout_routed_ideas_pkey ON harness_shared.scout_routed_ideas USING btree (idea_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_routed_ref_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_routed_ref_idx ON harness_shared.scout_routed_ideas USING btree (routed_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_su_creator_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_su_creator_idx ON harness_shared.scout_routed_ideas USING btree (origin, created_by) WHERE (origin = 'su-ideate'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_ws_harness_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_ws_harness_idx ON harness_shared.scout_routed_ideas USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_ws_harness_lens_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_ws_harness_lens_idx ON harness_shared.scout_routed_ideas USING btree (workspace_id, harness_slug, lens)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_ws_model_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_ws_model_idx ON harness_shared.scout_routed_ideas USING btree (workspace_id, model_spec) WHERE (model_spec IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_ws_origin_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_ws_origin_idx ON harness_shared.scout_routed_ideas USING btree (workspace_id, origin)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_routed_ideas_ws_source_hive_idx",
      "table": "scout_routed_ideas",
      "definition": "CREATE INDEX scout_routed_ideas_ws_source_hive_idx ON harness_shared.scout_routed_ideas USING btree (workspace_id, source_hive)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_signal_accumulator_pkey",
      "table": "scout_signal_accumulator",
      "definition": "CREATE UNIQUE INDEX scout_signal_accumulator_pkey ON harness_shared.scout_signal_accumulator USING btree (workspace_id, install_slug, lane)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_ticks_pkey",
      "table": "scout_ticks",
      "definition": "CREATE UNIQUE INDEX scout_ticks_pkey ON harness_shared.scout_ticks USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "scout_ticks_ws_origin_idx",
      "table": "scout_ticks",
      "definition": "CREATE INDEX scout_ticks_ws_origin_idx ON harness_shared.scout_ticks USING btree (workspace_id, origin)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_ticks_ws_pot_tick_at_idx",
      "table": "scout_ticks",
      "definition": "CREATE INDEX scout_ticks_ws_pot_tick_at_idx ON harness_shared.scout_ticks USING btree (workspace_id, pot_slug, tick_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "scout_ticks_ws_tick_at_idx",
      "table": "scout_ticks",
      "definition": "CREATE INDEX scout_ticks_ws_tick_at_idx ON harness_shared.scout_ticks USING btree (workspace_id, tick_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "search_judge_grades_contract_idx",
      "table": "search_judge_grades",
      "definition": "CREATE INDEX search_judge_grades_contract_idx ON harness_shared.search_judge_grades USING btree (workspace_id, judge_model, rubric_version, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "search_judge_grades_pkey",
      "table": "search_judge_grades",
      "definition": "CREATE UNIQUE INDEX search_judge_grades_pkey ON harness_shared.search_judge_grades USING btree (workspace_id, judge_model, rubric_version, query_hash, doc_id, doc_text_hash)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "search_judge_grades_run_idx",
      "table": "search_judge_grades",
      "definition": "CREATE INDEX search_judge_grades_run_idx ON harness_shared.search_judge_grades USING btree (workspace_id, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "secrets_guard_path_exemptions_pkey",
      "table": "secrets_guard_path_exemptions",
      "definition": "CREATE UNIQUE INDEX secrets_guard_path_exemptions_pkey ON harness_shared.secrets_guard_path_exemptions USING btree (workspace_id, path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "sentinel_says_pkey",
      "table": "sentinel_says",
      "definition": "CREATE UNIQUE INDEX sentinel_says_pkey ON harness_shared.sentinel_says USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_archive_files_pkey",
      "table": "session_archive_files",
      "definition": "CREATE UNIQUE INDEX session_archive_files_pkey ON harness_shared.session_archive_files USING btree (workspace_id, source_kind, session_id, relpath)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_archives_adv_idx",
      "table": "session_archives",
      "definition": "CREATE INDEX session_archives_adv_idx ON harness_shared.session_archives USING btree (adv_session_id) WHERE (adv_session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_archives_owner_idx",
      "table": "session_archives",
      "definition": "CREATE INDEX session_archives_owner_idx ON harness_shared.session_archives USING btree (owner, archived_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_archives_pkey",
      "table": "session_archives",
      "definition": "CREATE UNIQUE INDEX session_archives_pkey ON harness_shared.session_archives USING btree (workspace_id, source_kind, session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_briefs_goal_id_idx",
      "table": "session_briefs",
      "definition": "CREATE INDEX session_briefs_goal_id_idx ON harness_shared.session_briefs USING btree (goal_id) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_briefs_native_session_id_idx",
      "table": "session_briefs",
      "definition": "CREATE INDEX session_briefs_native_session_id_idx ON harness_shared.session_briefs USING btree (native_session_id) WHERE (native_session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_briefs_pkey",
      "table": "session_briefs",
      "definition": "CREATE UNIQUE INDEX session_briefs_pkey ON harness_shared.session_briefs USING btree (owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_briefs_updated_at_idx",
      "table": "session_briefs",
      "definition": "CREATE INDEX session_briefs_updated_at_idx ON harness_shared.session_briefs USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_cursor_owner_idx",
      "table": "session_cursor",
      "definition": "CREATE INDEX session_cursor_owner_idx ON harness_shared.session_cursor USING btree (owner_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_cursor_pkey",
      "table": "session_cursor",
      "definition": "CREATE UNIQUE INDEX session_cursor_pkey ON harness_shared.session_cursor USING btree (session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_cursor_updated_idx",
      "table": "session_cursor",
      "definition": "CREATE INDEX session_cursor_updated_idx ON harness_shared.session_cursor USING btree (updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_gate_watcher_files_pkey",
      "table": "session_gate_watcher_files",
      "definition": "CREATE UNIQUE INDEX session_gate_watcher_files_pkey ON harness_shared.session_gate_watcher_files USING btree (workspace_id, file_path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_applied_adv_idx",
      "table": "session_identity_activation_events",
      "definition": "CREATE INDEX session_identity_activation_applied_adv_idx ON harness_shared.session_identity_activation_events USING btree (adv_session_id) WHERE ((phase = 'applied'::text) AND (adv_session_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_applied_time_idx",
      "table": "session_identity_activation_events",
      "definition": "CREATE INDEX session_identity_activation_applied_time_idx ON harness_shared.session_identity_activation_events USING btree (workspace_id, owner_id, recorded_at, id) WHERE (phase = 'applied'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_event_uniq",
      "table": "session_identity_activation_events",
      "definition": "CREATE UNIQUE INDEX session_identity_activation_event_uniq ON harness_shared.session_identity_activation_events USING btree (workspace_id, owner_id, transition_id, phase)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_events_pkey",
      "table": "session_identity_activation_events",
      "definition": "CREATE UNIQUE INDEX session_identity_activation_events_pkey ON harness_shared.session_identity_activation_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_native_time_idx",
      "table": "session_identity_activation_events",
      "definition": "CREATE INDEX session_identity_activation_native_time_idx ON harness_shared.session_identity_activation_events USING btree (workspace_id, native_session_id, recorded_at, id) WHERE (native_session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_owner_time_idx",
      "table": "session_identity_activation_events",
      "definition": "CREATE INDEX session_identity_activation_owner_time_idx ON harness_shared.session_identity_activation_events USING btree (workspace_id, owner_id, recorded_at, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_identity_activation_spec_rev_idx",
      "table": "session_identity_activation_events",
      "definition": "CREATE INDEX session_identity_activation_spec_rev_idx ON harness_shared.session_identity_activation_events USING btree (workspace_id, specification_revision) WHERE (specification_layer_refs IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ingest_state_pkey",
      "table": "session_ingest_state",
      "definition": "CREATE UNIQUE INDEX session_ingest_state_pkey ON harness_shared.session_ingest_state USING btree (source_kind, file_path)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_pending_gates_created_idx",
      "table": "session_pending_gates",
      "definition": "CREATE INDEX session_pending_gates_created_idx ON harness_shared.session_pending_gates USING btree (created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_pending_gates_decide_by_idx",
      "table": "session_pending_gates",
      "definition": "CREATE INDEX session_pending_gates_decide_by_idx ON harness_shared.session_pending_gates USING btree (workspace_id, decide_by) WHERE ((closed_at IS NULL) AND (decide_by IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_pending_gates_open_idx",
      "table": "session_pending_gates",
      "definition": "CREATE INDEX session_pending_gates_open_idx ON harness_shared.session_pending_gates USING btree (workspace_id, opened_at DESC) WHERE (closed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_pending_gates_pkey",
      "table": "session_pending_gates",
      "definition": "CREATE UNIQUE INDEX session_pending_gates_pkey ON harness_shared.session_pending_gates USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_pending_gates_ref_uq",
      "table": "session_pending_gates",
      "definition": "CREATE UNIQUE INDEX session_pending_gates_ref_uq ON harness_shared.session_pending_gates USING btree (workspace_id, session_id, ref_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_logical_request_idx",
      "table": "session_ports",
      "definition": "CREATE INDEX session_ports_logical_request_idx ON harness_shared.session_ports USING btree (workspace_id, logical_request_key, prepared_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_pending_idx",
      "table": "session_ports",
      "definition": "CREATE INDEX session_ports_pending_idx ON harness_shared.session_ports USING btree (expires_at) WHERE (status = ANY (ARRAY['prepared'::text, 'pending'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_pkey",
      "table": "session_ports",
      "definition": "CREATE UNIQUE INDEX session_ports_pkey ON harness_shared.session_ports USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_retry_idx",
      "table": "session_ports",
      "definition": "CREATE INDEX session_ports_retry_idx ON harness_shared.session_ports USING btree (retry_of_port_id) WHERE (retry_of_port_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_source_idx",
      "table": "session_ports",
      "definition": "CREATE INDEX session_ports_source_idx ON harness_shared.session_ports USING btree (workspace_id, source_adv_session_id, prepared_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_target_idx",
      "table": "session_ports",
      "definition": "CREATE INDEX session_ports_target_idx ON harness_shared.session_ports USING btree (target_adv_session_id) WHERE (target_adv_session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_ports_workspace_id_idempotency_key_key",
      "table": "session_ports",
      "definition": "CREATE UNIQUE INDEX session_ports_workspace_id_idempotency_key_key ON harness_shared.session_ports USING btree (workspace_id, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_prompt_origin_stamps_expiry_idx",
      "table": "session_prompt_origin_stamps",
      "definition": "CREATE INDEX session_prompt_origin_stamps_expiry_idx ON harness_shared.session_prompt_origin_stamps USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_prompt_origin_stamps_lookup_idx",
      "table": "session_prompt_origin_stamps",
      "definition": "CREATE INDEX session_prompt_origin_stamps_lookup_idx ON harness_shared.session_prompt_origin_stamps USING btree (workspace_id, source_kind, session_id, prompt_hash, submitted_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_prompt_origin_stamps_pkey",
      "table": "session_prompt_origin_stamps",
      "definition": "CREATE UNIQUE INDEX session_prompt_origin_stamps_pkey ON harness_shared.session_prompt_origin_stamps USING btree (workspace_id, source_kind, session_id, prompt_hash, submitted_at)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_respawn_expected_pkey",
      "table": "session_respawn_expected",
      "definition": "CREATE UNIQUE INDEX session_respawn_expected_pkey ON harness_shared.session_respawn_expected USING btree (owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_task_work_item_links_one_for_uq",
      "table": "session_task_work_item_links",
      "definition": "CREATE UNIQUE INDEX session_task_work_item_links_one_for_uq ON harness_shared.session_task_work_item_links USING btree (workspace_id, session_id, task_id) WHERE (relation = 'for'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_task_work_item_links_pkey",
      "table": "session_task_work_item_links",
      "definition": "CREATE UNIQUE INDEX session_task_work_item_links_pkey ON harness_shared.session_task_work_item_links USING btree (workspace_id, session_id, task_id, relation, work_item_harness, work_item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_task_work_item_links_reverse_idx",
      "table": "session_task_work_item_links",
      "definition": "CREATE INDEX session_task_work_item_links_reverse_idx ON harness_shared.session_task_work_item_links USING btree (workspace_id, work_item_harness, work_item_id, relation, session_id, task_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_tasks_one_in_progress_uq",
      "table": "session_tasks",
      "definition": "CREATE UNIQUE INDEX session_tasks_one_in_progress_uq ON harness_shared.session_tasks USING btree (workspace_id, session_id) WHERE (status = 'in_progress'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_tasks_pkey",
      "table": "session_tasks",
      "definition": "CREATE UNIQUE INDEX session_tasks_pkey ON harness_shared.session_tasks USING btree (workspace_id, session_id, task_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_tasks_position_uq",
      "table": "session_tasks",
      "definition": "CREATE UNIQUE INDEX session_tasks_position_uq ON harness_shared.session_tasks USING btree (workspace_id, session_id, \"position\")",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_tasks_updated_idx",
      "table": "session_tasks",
      "definition": "CREATE INDEX session_tasks_updated_idx ON harness_shared.session_tasks USING btree (workspace_id, session_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_chunks_embedding_hnsw_idx",
      "table": "session_turn_chunks",
      "definition": "CREATE INDEX session_turn_chunks_embedding_hnsw_idx ON harness_shared.session_turn_chunks USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_chunks_embedding_mode_idx",
      "table": "session_turn_chunks",
      "definition": "CREATE INDEX session_turn_chunks_embedding_mode_idx ON harness_shared.session_turn_chunks USING btree (embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_chunks_pkey",
      "table": "session_turn_chunks",
      "definition": "CREATE UNIQUE INDEX session_turn_chunks_pkey ON harness_shared.session_turn_chunks USING btree (workspace_id, source_kind, session_id, turn_idx, chunk_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_chunks_updated_idx",
      "table": "session_turn_chunks",
      "definition": "CREATE INDEX session_turn_chunks_updated_idx ON harness_shared.session_turn_chunks USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_journal_created_idx",
      "table": "session_turn_journal",
      "definition": "CREATE INDEX session_turn_journal_created_idx ON harness_shared.session_turn_journal USING btree (created_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_journal_owner_ts_idx",
      "table": "session_turn_journal",
      "definition": "CREATE INDEX session_turn_journal_owner_ts_idx ON harness_shared.session_turn_journal USING btree (owner_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_journal_pkey",
      "table": "session_turn_journal",
      "definition": "CREATE UNIQUE INDEX session_turn_journal_pkey ON harness_shared.session_turn_journal USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_journal_turn_uq",
      "table": "session_turn_journal",
      "definition": "CREATE UNIQUE INDEX session_turn_journal_turn_uq ON harness_shared.session_turn_journal USING btree (session_id, COALESCE(turn_ts, '1970-01-01 00:00:00+00'::timestamp with time zone))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_parts_ingested_idx",
      "table": "session_turn_parts",
      "definition": "CREATE INDEX session_turn_parts_ingested_idx ON harness_shared.session_turn_parts USING btree (ingested_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_parts_owner_ts_tool_use_idx",
      "table": "session_turn_parts",
      "definition": "CREATE INDEX session_turn_parts_owner_ts_tool_use_idx ON harness_shared.session_turn_parts USING btree (owner, ts DESC) WHERE (part_kind = 'tool_use'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_parts_pkey",
      "table": "session_turn_parts",
      "definition": "CREATE UNIQUE INDEX session_turn_parts_pkey ON harness_shared.session_turn_parts USING btree (workspace_id, source_kind, session_id, part_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_vocab_pkey",
      "table": "session_turn_vocab",
      "definition": "CREATE UNIQUE INDEX session_turn_vocab_pkey ON harness_shared.session_turn_vocab USING btree (workspace_id, word)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_vocab_state_pkey",
      "table": "session_turn_vocab_state",
      "definition": "CREATE UNIQUE INDEX session_turn_vocab_state_pkey ON harness_shared.session_turn_vocab_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_vocab_word_trgm_idx",
      "table": "session_turn_vocab",
      "definition": "CREATE INDEX session_turn_vocab_word_trgm_idx ON harness_shared.session_turn_vocab USING gin (word gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_windows_pkey",
      "table": "session_turn_windows",
      "definition": "CREATE UNIQUE INDEX session_turn_windows_pkey ON harness_shared.session_turn_windows USING btree (workspace_id, source_kind, session_id, turn_idx, win_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_windows_state_pkey",
      "table": "session_turn_windows_state",
      "definition": "CREATE UNIQUE INDEX session_turn_windows_state_pkey ON harness_shared.session_turn_windows_state USING btree (scope)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turn_windows_wtext_trgm_idx",
      "table": "session_turn_windows",
      "definition": "CREATE INDEX session_turn_windows_wtext_trgm_idx ON harness_shared.session_turn_windows USING gin (wtext gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_chunkable_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_chunkable_idx ON harness_shared.session_turns USING btree (ingested_at DESC) WHERE (length(text) > 2000)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_embedding_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_embedding_idx ON harness_shared.session_turns USING hnsw (text_embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_ingested_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_ingested_idx ON harness_shared.session_turns USING btree (ingested_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_owner_ts_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_owner_ts_idx ON harness_shared.session_turns USING btree (owner, ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_pkey",
      "table": "session_turns",
      "definition": "CREATE UNIQUE INDEX session_turns_pkey ON harness_shared.session_turns USING btree (workspace_id, source_kind, session_id, turn_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_provenance_version_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_provenance_version_idx ON harness_shared.session_turns USING btree (turn_origin_classifier_version)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_session_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_session_idx ON harness_shared.session_turns USING btree (session_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_text_embedding_mode_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_text_embedding_mode_idx ON harness_shared.session_turns USING btree (text_embedding_mode) WHERE (text_embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_text_trgm_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_text_trgm_idx ON harness_shared.session_turns USING gin (lower(text) gin_trgm_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_ts_desc_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_ts_desc_idx ON harness_shared.session_turns USING btree (ts DESC NULLS LAST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_tsv_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_tsv_idx ON harness_shared.session_turns USING gin (text_tsv)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "session_turns_unchunked_idx",
      "table": "session_turns",
      "definition": "CREATE INDEX session_turns_unchunked_idx ON harness_shared.session_turns USING btree (ingested_at DESC) WHERE ((length(text) > 2000) AND (chunked_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "setup_wizard_state_pkey",
      "table": "setup_wizard_state",
      "definition": "CREATE UNIQUE INDEX setup_wizard_state_pkey ON harness_shared.setup_wizard_state USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "sf_snapshot_idx",
      "table": "snapshot_features",
      "definition": "CREATE INDEX sf_snapshot_idx ON harness_shared.snapshot_features USING btree (harness_slug, snapshot_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_presence_fleet_recent_idx",
      "table": "shared_presence",
      "definition": "CREATE INDEX shared_presence_fleet_recent_idx ON harness_shared.shared_presence USING btree (workspace_id, fleet_slug, last_seen_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_presence_pkey",
      "table": "shared_presence",
      "definition": "CREATE UNIQUE INDEX shared_presence_pkey ON harness_shared.shared_presence USING btree (workspace_id, harness_slug, github_user_id, machine_label)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "shared_presence_pot_recent_idx",
      "table": "shared_presence",
      "definition": "CREATE INDEX shared_presence_pot_recent_idx ON harness_shared.shared_presence USING btree (workspace_id, pot_slug, last_seen_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_presence_recent_idx",
      "table": "shared_presence",
      "definition": "CREATE INDEX shared_presence_recent_idx ON harness_shared.shared_presence USING btree (workspace_id, harness_slug, last_seen_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_presence_user_idx",
      "table": "shared_presence",
      "definition": "CREATE INDEX shared_presence_user_idx ON harness_shared.shared_presence USING btree (workspace_id, harness_slug, github_user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_repo_binding_cache_pkey",
      "table": "shared_repo_binding_cache",
      "definition": "CREATE UNIQUE INDEX shared_repo_binding_cache_pkey ON harness_shared.shared_repo_binding_cache USING btree (workspace_id, provider, github_repository_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "shared_session_presence_device_idx",
      "table": "shared_session_presence",
      "definition": "CREATE INDEX shared_session_presence_device_idx ON harness_shared.shared_session_presence USING btree (workspace_id, device_pubkey)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_session_presence_fleet_idx",
      "table": "shared_session_presence",
      "definition": "CREATE INDEX shared_session_presence_fleet_idx ON harness_shared.shared_session_presence USING btree (workspace_id, fleet_slug, last_seen_at DESC) WHERE (fleet_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "shared_session_presence_pkey",
      "table": "shared_session_presence",
      "definition": "CREATE UNIQUE INDEX shared_session_presence_pkey ON harness_shared.shared_session_presence USING btree (workspace_id, owner_id, machine_label)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "shared_session_presence_pot_idx",
      "table": "shared_session_presence",
      "definition": "CREATE INDEX shared_session_presence_pot_idx ON harness_shared.shared_session_presence USING btree (workspace_id, pot_slug, last_seen_at DESC) WHERE (pot_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "slot_parked_messages_pending_idx",
      "table": "slot_parked_messages",
      "definition": "CREATE INDEX slot_parked_messages_pending_idx ON harness_shared.slot_parked_messages USING btree (workspace_id, harness_slug, slot_kind, slot_ref) WHERE ((delivered_ts IS NULL) AND (dropped_ts IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "slot_parked_messages_pkey",
      "table": "slot_parked_messages",
      "definition": "CREATE UNIQUE INDEX slot_parked_messages_pkey ON harness_shared.slot_parked_messages USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "snapshot_features_pkey",
      "table": "snapshot_features",
      "definition": "CREATE UNIQUE INDEX snapshot_features_pkey ON harness_shared.snapshot_features USING btree (harness_slug, snapshot_id, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "spawn_sig_failures_classification_idx",
      "table": "spawn_sig_verification_failures",
      "definition": "CREATE INDEX spawn_sig_failures_classification_idx ON harness_shared.spawn_sig_verification_failures USING btree (classification, ts DESC) WHERE (classification IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawn_sig_failures_reason_idx",
      "table": "spawn_sig_verification_failures",
      "definition": "CREATE INDEX spawn_sig_failures_reason_idx ON harness_shared.spawn_sig_verification_failures USING btree (reason, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawn_sig_failures_ts_idx",
      "table": "spawn_sig_verification_failures",
      "definition": "CREATE INDEX spawn_sig_failures_ts_idx ON harness_shared.spawn_sig_verification_failures USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawn_sig_verification_failures_pkey",
      "table": "spawn_sig_verification_failures",
      "definition": "CREATE UNIQUE INDEX spawn_sig_verification_failures_pkey ON harness_shared.spawn_sig_verification_failures USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_active_heartbeat_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_active_heartbeat_idx ON harness_shared.spawned_agents USING btree (heartbeat_at) WHERE (status = ANY (ARRAY['running'::text, 'restarting'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_fleet_slug_running_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_fleet_slug_running_idx ON harness_shared.spawned_agents USING btree (workspace_id, fleet_slug) WHERE ((fleet_slug IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'restarting'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_governor_observation_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_governor_observation_idx ON harness_shared.spawned_agents USING btree (workspace_id, started_at DESC) WHERE (governor_observation IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_idempotency_key_uq",
      "table": "spawned_agents",
      "definition": "CREATE UNIQUE INDEX spawned_agents_idempotency_key_uq ON harness_shared.spawned_agents USING btree (workspace_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_parent_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_parent_idx ON harness_shared.spawned_agents USING btree (workspace_id, parent_spawn_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_pkey",
      "table": "spawned_agents",
      "definition": "CREATE UNIQUE INDEX spawned_agents_pkey ON harness_shared.spawned_agents USING btree (spawn_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_recent_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_recent_idx ON harness_shared.spawned_agents USING btree (workspace_id, harness_slug, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_running_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_running_idx ON harness_shared.spawned_agents USING btree (workspace_id, status) WHERE (status = 'running'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_session_id_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_session_id_idx ON harness_shared.spawned_agents USING btree (session_id) WHERE (session_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spawned_agents_session_owner_idx",
      "table": "spawned_agents",
      "definition": "CREATE INDEX spawned_agents_session_owner_idx ON harness_shared.spawned_agents USING btree (workspace_id, session_owner) WHERE (session_owner IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spec_evidence_bindings_by_spec",
      "table": "spec_evidence_bindings",
      "definition": "CREATE INDEX spec_evidence_bindings_by_spec ON harness_shared.spec_evidence_bindings USING btree (workspace_id, harness_slug, plan_slug, spec_id, spec_revision, observed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spec_evidence_bindings_by_test_run",
      "table": "spec_evidence_bindings",
      "definition": "CREATE INDEX spec_evidence_bindings_by_test_run ON harness_shared.spec_evidence_bindings USING btree (test_run_id) WHERE (test_run_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spec_evidence_bindings_by_work_item",
      "table": "spec_evidence_bindings",
      "definition": "CREATE INDEX spec_evidence_bindings_by_work_item ON harness_shared.spec_evidence_bindings USING btree (workspace_id, harness_slug, work_item_id, observed_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spec_evidence_bindings_dedup_live",
      "table": "spec_evidence_bindings",
      "definition": "CREATE UNIQUE INDEX spec_evidence_bindings_dedup_live ON harness_shared.spec_evidence_bindings USING btree (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, binding_fingerprint) WHERE (retracted_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "spec_evidence_bindings_pkey",
      "table": "spec_evidence_bindings",
      "definition": "CREATE UNIQUE INDEX spec_evidence_bindings_pkey ON harness_shared.spec_evidence_bindings USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "sql_read_census_cluster_history_idx",
      "table": "sql_read_census",
      "definition": "CREATE INDEX sql_read_census_cluster_history_idx ON harness_shared.sql_read_census USING btree (workspace_id, relation, ran_on DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "sql_read_census_night_cluster_idx",
      "table": "sql_read_census",
      "definition": "CREATE UNIQUE INDEX sql_read_census_night_cluster_idx ON harness_shared.sql_read_census USING btree (workspace_id, ran_on, relation, COALESCE(intent_label, ''::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "sql_read_census_pkey",
      "table": "sql_read_census",
      "definition": "CREATE UNIQUE INDEX sql_read_census_pkey ON harness_shared.sql_read_census USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "srbc_by_full_name_idx",
      "table": "shared_repo_binding_cache",
      "definition": "CREATE INDEX srbc_by_full_name_idx ON harness_shared.shared_repo_binding_cache USING btree (workspace_id, github_full_name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "srbc_by_harness_topic_idx",
      "table": "shared_repo_binding_cache",
      "definition": "CREATE INDEX srbc_by_harness_topic_idx ON harness_shared.shared_repo_binding_cache USING btree (workspace_id, harness_topic)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "srbc_stale_cache_idx",
      "table": "shared_repo_binding_cache",
      "definition": "CREATE INDEX srbc_stale_cache_idx ON harness_shared.shared_repo_binding_cache USING btree (workspace_id, cached_at) WHERE (claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "statement_attestations_attestation_seq_key",
      "table": "statement_attestations",
      "definition": "CREATE UNIQUE INDEX statement_attestations_attestation_seq_key ON harness_shared.statement_attestations USING btree (attestation_seq)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "statement_attestations_pkey",
      "table": "statement_attestations",
      "definition": "CREATE UNIQUE INDEX statement_attestations_pkey ON harness_shared.statement_attestations USING btree (workspace_id, month, document_sha256)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "steering_churn_escalations_pkey",
      "table": "steering_churn_escalations",
      "definition": "CREATE UNIQUE INDEX steering_churn_escalations_pkey ON harness_shared.steering_churn_escalations USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "steering_churn_events_item_idx",
      "table": "steering_churn_events",
      "definition": "CREATE INDEX steering_churn_events_item_idx ON harness_shared.steering_churn_events USING btree (workspace_id, harness_slug, feature_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "steering_churn_events_pkey",
      "table": "steering_churn_events",
      "definition": "CREATE UNIQUE INDEX steering_churn_events_pkey ON harness_shared.steering_churn_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "steering_churn_events_ws_ts_idx",
      "table": "steering_churn_events",
      "definition": "CREATE INDEX steering_churn_events_ws_ts_idx ON harness_shared.steering_churn_events USING btree (workspace_id, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "substrate_booted_handles_status_pkey",
      "table": "substrate_booted_handles_status",
      "definition": "CREATE UNIQUE INDEX substrate_booted_handles_status_pkey ON harness_shared.substrate_booted_handles_status USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "substrate_merge_cursor_pkey",
      "table": "substrate_merge_cursor",
      "definition": "CREATE UNIQUE INDEX substrate_merge_cursor_pkey ON harness_shared.substrate_merge_cursor USING btree (workspace_id, harness_slug, log_keyhex)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "substrate_meta_pkey",
      "table": "substrate_meta",
      "definition": "CREATE UNIQUE INDEX substrate_meta_pkey ON harness_shared.substrate_meta USING btree (workspace_id, harness_slug, key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "substrate_outbox_drain_idx",
      "table": "substrate_outbox",
      "definition": "CREATE INDEX substrate_outbox_drain_idx ON harness_shared.substrate_outbox USING btree (workspace_id, harness_slug, drained_at, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "substrate_outbox_pkey",
      "table": "substrate_outbox",
      "definition": "CREATE UNIQUE INDEX substrate_outbox_pkey ON harness_shared.substrate_outbox USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "substrate_outbox_table_drain_idx",
      "table": "substrate_outbox",
      "definition": "CREATE INDEX substrate_outbox_table_drain_idx ON harness_shared.substrate_outbox USING btree (workspace_id, harness_slug, table_name, drained_at, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "supervisor_notes_consolidated_pkey",
      "table": "supervisor_notes_consolidated",
      "definition": "CREATE UNIQUE INDEX supervisor_notes_consolidated_pkey ON harness_shared.supervisor_notes_consolidated USING btree (harness_slug, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "supervisor_notes_consolidated_recent_idx",
      "table": "supervisor_notes_consolidated",
      "definition": "CREATE INDEX supervisor_notes_consolidated_recent_idx ON harness_shared.supervisor_notes_consolidated USING btree (harness_slug, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "system_health_acks_pkey",
      "table": "system_health_acks",
      "definition": "CREATE UNIQUE INDEX system_health_acks_pkey ON harness_shared.system_health_acks USING btree (workspace_id, panel)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "system_health_ticks_pkey",
      "table": "system_health_ticks",
      "definition": "CREATE UNIQUE INDEX system_health_ticks_pkey ON harness_shared.system_health_ticks USING btree (workspace_id, at)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "system_health_transitions_pkey",
      "table": "system_health_transitions",
      "definition": "CREATE UNIQUE INDEX system_health_transitions_pkey ON harness_shared.system_health_transitions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "system_principals_pkey",
      "table": "system_principals",
      "definition": "CREATE UNIQUE INDEX system_principals_pkey ON harness_shared.system_principals USING btree (workspace_id, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "system_principals_workspace_idx",
      "table": "system_principals",
      "definition": "CREATE INDEX system_principals_workspace_idx ON harness_shared.system_principals USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_bash_job_id_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_bash_job_id_idx ON harness_shared.task_ledger USING btree (((detail ->> 'bashJobId'::text))) WHERE ((class = 'bash-job'::text) AND (detail ? 'bashJobId'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_deadline_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_deadline_idx ON harness_shared.task_ledger USING btree (deadline_at) WHERE ((deadline_at IS NOT NULL) AND (ended_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_ended_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_ended_idx ON harness_shared.task_ledger USING btree (ended_at) WHERE (ended_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_launched_by_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_launched_by_idx ON harness_shared.task_ledger USING btree (launched_by, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_live_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_live_idx ON harness_shared.task_ledger USING btree (workspace_id, state, started_at DESC) WHERE (state = ANY (ARRAY['pending'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_parent_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_parent_idx ON harness_shared.task_ledger USING btree (parent_task_id) WHERE (parent_task_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_pkey",
      "table": "task_ledger",
      "definition": "CREATE UNIQUE INDEX task_ledger_pkey ON harness_shared.task_ledger USING btree (task_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_process_identity_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_process_identity_idx ON harness_shared.task_ledger USING btree (process_identity) WHERE (process_identity IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_root_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_root_idx ON harness_shared.task_ledger USING btree (root_task_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_scope_unit_key",
      "table": "task_ledger",
      "definition": "CREATE UNIQUE INDEX task_ledger_scope_unit_key ON harness_shared.task_ledger USING btree (scope_unit) WHERE (scope_unit IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "task_ledger_work_item_idx",
      "table": "task_ledger",
      "definition": "CREATE INDEX task_ledger_work_item_idx ON harness_shared.task_ledger USING btree (work_item_id) WHERE (work_item_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "telemetry_reports_archive_forwarded_at_idx",
      "table": "telemetry_reports_archive",
      "definition": "CREATE INDEX telemetry_reports_archive_forwarded_at_idx ON harness_shared.telemetry_reports_archive USING btree (forwarded_at) WHERE (forwarded_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "telemetry_reports_archive_pkey",
      "table": "telemetry_reports_archive",
      "definition": "CREATE UNIQUE INDEX telemetry_reports_archive_pkey ON harness_shared.telemetry_reports_archive USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "telemetry_reports_archive_received_at_idx",
      "table": "telemetry_reports_archive",
      "definition": "CREATE INDEX telemetry_reports_archive_received_at_idx ON harness_shared.telemetry_reports_archive USING btree (received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "telemetry_reports_archive_workspace_idx",
      "table": "telemetry_reports_archive",
      "definition": "CREATE INDEX telemetry_reports_archive_workspace_idx ON harness_shared.telemetry_reports_archive USING btree (workspace_id, received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "telemetry_reports_pkey",
      "table": "telemetry_reports",
      "definition": "CREATE UNIQUE INDEX telemetry_reports_pkey ON harness_shared.telemetry_reports USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "test_executed_sources_newest_idx",
      "table": "test_executed_sources",
      "definition": "CREATE INDEX test_executed_sources_newest_idx ON harness_shared.test_executed_sources USING btree (workspace_name, test_file, recorded_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "test_executed_sources_pkey",
      "table": "test_executed_sources",
      "definition": "CREATE UNIQUE INDEX test_executed_sources_pkey ON harness_shared.test_executed_sources USING btree (workspace_name, test_file, recorded_sha)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_branch_idx",
      "table": "test_runs",
      "definition": "CREATE INDEX test_runs_branch_idx ON harness_shared.test_runs USING btree (branch, finished_at DESC) WHERE (branch IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_file_path_idx",
      "table": "test_runs",
      "definition": "CREATE INDEX test_runs_file_path_idx ON harness_shared.test_runs USING btree (file_path, finished_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_harness_scope_idx",
      "table": "test_runs",
      "definition": "CREATE INDEX test_runs_harness_scope_idx ON harness_shared.test_runs USING btree (harness_slug, workspace_id, file_path, finished_at DESC) WHERE (harness_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_pkey",
      "table": "test_runs",
      "definition": "CREATE UNIQUE INDEX test_runs_pkey ON harness_shared.test_runs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_run_group_idx",
      "table": "test_runs",
      "definition": "CREATE INDEX test_runs_run_group_idx ON harness_shared.test_runs USING btree (run_group_id) WHERE (run_group_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "test_runs_source_idx",
      "table": "test_runs",
      "definition": "CREATE INDEX test_runs_source_idx ON harness_shared.test_runs USING btree (source, finished_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "testing_run_snapshots_finished_idx",
      "table": "testing_run_snapshots",
      "definition": "CREATE INDEX testing_run_snapshots_finished_idx ON harness_shared.testing_run_snapshots USING btree (finished_at DESC, run_id) WHERE (finished_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "testing_run_snapshots_pkey",
      "table": "testing_run_snapshots",
      "definition": "CREATE UNIQUE INDEX testing_run_snapshots_pkey ON harness_shared.testing_run_snapshots USING btree (run_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "testing_run_snapshots_updated_idx",
      "table": "testing_run_snapshots",
      "definition": "CREATE INDEX testing_run_snapshots_updated_idx ON harness_shared.testing_run_snapshots USING btree (updated_at DESC, run_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "testing_surfaces_identity",
      "table": "testing_surfaces",
      "definition": "CREATE UNIQUE INDEX testing_surfaces_identity ON harness_shared.testing_surfaces USING btree (workspace_id, harness_slug, kind, surface_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "testing_surfaces_live",
      "table": "testing_surfaces",
      "definition": "CREATE INDEX testing_surfaces_live ON harness_shared.testing_surfaces USING btree (workspace_id, harness_slug, kind) WHERE (retired_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "testing_surfaces_pkey",
      "table": "testing_surfaces",
      "definition": "CREATE UNIQUE INDEX testing_surfaces_pkey ON harness_shared.testing_surfaces USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "testing_surfaces_source_file",
      "table": "testing_surfaces",
      "definition": "CREATE INDEX testing_surfaces_source_file ON harness_shared.testing_surfaces USING btree (source_file) WHERE ((source_file IS NOT NULL) AND (retired_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "text_chunks_consult_questions_embedding_hnsw_idx",
      "table": "text_chunks",
      "definition": "CREATE INDEX text_chunks_consult_questions_embedding_hnsw_idx ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops) WHERE (surface = 'consult_questions'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "text_chunks_embedding_hnsw_idx",
      "table": "text_chunks",
      "definition": "CREATE INDEX text_chunks_embedding_hnsw_idx ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "text_chunks_embedding_mode_idx",
      "table": "text_chunks",
      "definition": "CREATE INDEX text_chunks_embedding_mode_idx ON harness_shared.text_chunks USING btree (embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "text_chunks_pkey",
      "table": "text_chunks",
      "definition": "CREATE UNIQUE INDEX text_chunks_pkey ON harness_shared.text_chunks USING btree (surface, parent_key, chunk_idx)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "text_chunks_updated_idx",
      "table": "text_chunks",
      "definition": "CREATE INDEX text_chunks_updated_idx ON harness_shared.text_chunks USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "toast_log_created_idx",
      "table": "toast_log",
      "definition": "CREATE INDEX toast_log_created_idx ON harness_shared.toast_log USING btree (created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "toast_log_pkey",
      "table": "toast_log",
      "definition": "CREATE UNIQUE INDEX toast_log_pkey ON harness_shared.toast_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "toast_log_slug_created_idx",
      "table": "toast_log",
      "definition": "CREATE INDEX toast_log_slug_created_idx ON harness_shared.toast_log USING btree (harness_slug, created_at DESC) WHERE (harness_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "token_index_kind_idx",
      "table": "token_index",
      "definition": "CREATE INDEX token_index_kind_idx ON harness_shared.token_index USING btree (kind)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "token_index_pkey",
      "table": "token_index",
      "definition": "CREATE UNIQUE INDEX token_index_pkey ON harness_shared.token_index USING btree (token)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "token_index_workspace_idx",
      "table": "token_index",
      "definition": "CREATE INDEX token_index_workspace_idx ON harness_shared.token_index USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "token_index_ws_harness_slug_idx",
      "table": "token_index",
      "definition": "CREATE UNIQUE INDEX token_index_ws_harness_slug_idx ON harness_shared.token_index USING btree (workspace_id, harness_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_authz_log_decision_idx",
      "table": "tool_authz_log",
      "definition": "CREATE INDEX tool_authz_log_decision_idx ON harness_shared.tool_authz_log USING btree (decision, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_authz_log_pkey",
      "table": "tool_authz_log",
      "definition": "CREATE UNIQUE INDEX tool_authz_log_pkey ON harness_shared.tool_authz_log USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tool_authz_log_principal_idx",
      "table": "tool_authz_log",
      "definition": "CREATE INDEX tool_authz_log_principal_idx ON harness_shared.tool_authz_log USING btree (principal_slug, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_authz_log_ts_idx",
      "table": "tool_authz_log",
      "definition": "CREATE INDEX tool_authz_log_ts_idx ON harness_shared.tool_authz_log USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_activity_adv_session_lookup_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_activity_adv_session_lookup_idx ON harness_shared.tool_invocations USING btree (workspace_id, ((args_json ->> 'adv_session_id'::text)), invoked_at DESC, id DESC) WHERE ((tool_name = ANY (ARRAY['activity:report'::text, 'activity_report'::text])) AND (args_json ? 'adv_session_id'::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_activity_session_lookup_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_activity_session_lookup_idx ON harness_shared.tool_invocations USING btree (workspace_id, COALESCE((args_json ->> 'session_id'::text), (args_json ->> 'sessionId'::text)), invoked_at DESC, id DESC) WHERE ((tool_name = ANY (ARRAY['activity:report'::text, 'activity_report'::text])) AND ((args_json ? 'session_id'::text) OR (args_json ? 'sessionId'::text)))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_app_principal_activity_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_app_principal_activity_idx ON harness_shared.tool_invocations USING btree (workspace_id, split_part(coord_owner_id, '/'::text, 1), invoked_at DESC, id DESC) WHERE (coord_owner_id ~~ 'app:%'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_coord_owner_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_coord_owner_idx ON harness_shared.tool_invocations USING btree (coord_owner_id, invoked_at DESC) WHERE (coord_owner_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_error_code_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_error_code_idx ON harness_shared.tool_invocations USING btree (error_code, invoked_at) WHERE (error_code IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_goal_id_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_goal_id_idx ON harness_shared.tool_invocations USING btree (workspace_id, goal_id, invoked_at DESC) INCLUDE (coord_owner_id, goal_actor_class) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_goal_ref_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_goal_ref_idx ON harness_shared.tool_invocations USING btree (goal_ref, invoked_at DESC) WHERE (goal_ref IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_intent_event_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_intent_event_idx ON harness_shared.tool_invocations USING btree (intent_event_id, invoked_at DESC) WHERE (intent_event_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_invoked_at_cov_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_invoked_at_cov_idx ON harness_shared.tool_invocations USING btree (invoked_at DESC) INCLUDE (tool_name, duration_ms, status)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_parent_spawn_partial_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_parent_spawn_partial_idx ON harness_shared.tool_invocations USING btree (parent_spawn_id) WHERE ((parent_spawn_id IS NOT NULL) AND (parent_spawn_id <> ''::text))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_pkey",
      "table": "tool_invocations",
      "definition": "CREATE UNIQUE INDEX tool_invocations_pkey ON harness_shared.tool_invocations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_quota_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_quota_idx ON harness_shared.tool_invocations USING btree (workspace_id, tool_name, role, window_key) INCLUDE (status) WHERE (status = ANY (ARRAY['ok'::text, 'refused'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_serving_host_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_serving_host_idx ON harness_shared.tool_invocations USING btree (serving_host, invoked_at DESC) WHERE (serving_host IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_spawn_id_ws_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_spawn_id_ws_idx ON harness_shared.tool_invocations USING btree (workspace_id, spawn_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_invocations_telemetry_idx",
      "table": "tool_invocations",
      "definition": "CREATE INDEX tool_invocations_telemetry_idx ON harness_shared.tool_invocations USING btree (workspace_id, harness_slug, invoked_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_usage_rollup_intent_idx",
      "table": "tool_usage_rollup",
      "definition": "CREATE INDEX tool_usage_rollup_intent_idx ON harness_shared.tool_usage_rollup USING btree (workspace_id, day DESC, intent_label) WHERE (intent_label <> ''::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tool_usage_rollup_pkey",
      "table": "tool_usage_rollup",
      "definition": "CREATE UNIQUE INDEX tool_usage_rollup_pkey ON harness_shared.tool_usage_rollup USING btree (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tool_usage_rollup_window_idx",
      "table": "tool_usage_rollup",
      "definition": "CREATE INDEX tool_usage_rollup_window_idx ON harness_shared.tool_usage_rollup USING btree (workspace_id, day DESC, tool_name)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "topic_hysteresis_pkey",
      "table": "topic_hysteresis",
      "definition": "CREATE UNIQUE INDEX topic_hysteresis_pkey ON harness_shared.topic_hysteresis USING btree (session_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "topic_hysteresis_updated_idx",
      "table": "topic_hysteresis",
      "definition": "CREATE INDEX topic_hysteresis_updated_idx ON harness_shared.topic_hysteresis USING btree (updated_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "transfer_lessons_pkey",
      "table": "transfer_lessons",
      "definition": "CREATE UNIQUE INDEX transfer_lessons_pkey ON harness_shared.transfer_lessons USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "transfer_lessons_pot_idx",
      "table": "transfer_lessons",
      "definition": "CREATE INDEX transfer_lessons_pot_idx ON harness_shared.transfer_lessons USING btree (workspace_id, pot_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "transfer_lessons_signature_uniq",
      "table": "transfer_lessons",
      "definition": "CREATE UNIQUE INDEX transfer_lessons_signature_uniq ON harness_shared.transfer_lessons USING btree (workspace_id, signature)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "transfer_lessons_ws_created_idx",
      "table": "transfer_lessons",
      "definition": "CREATE INDEX transfer_lessons_ws_created_idx ON harness_shared.transfer_lessons USING btree (workspace_id, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "transfer_lessons_ws_tier_tested_idx",
      "table": "transfer_lessons",
      "definition": "CREATE INDEX transfer_lessons_ws_tier_tested_idx ON harness_shared.transfer_lessons USING btree (workspace_id, tier, last_tested_at NULLS FIRST)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "triage_ledger_feature_idx",
      "table": "triage_ledger",
      "definition": "CREATE INDEX triage_ledger_feature_idx ON harness_shared.triage_ledger USING btree (feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "triage_ledger_pkey",
      "table": "triage_ledger",
      "definition": "CREATE UNIQUE INDEX triage_ledger_pkey ON harness_shared.triage_ledger USING btree (snapshot_id, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "triage_ledger_snapshot_cluster_idx",
      "table": "triage_ledger",
      "definition": "CREATE INDEX triage_ledger_snapshot_cluster_idx ON harness_shared.triage_ledger USING btree (snapshot_id, cluster_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "triage_ledger_snapshot_origin_idx",
      "table": "triage_ledger",
      "definition": "CREATE INDEX triage_ledger_snapshot_origin_idx ON harness_shared.triage_ledger USING btree (snapshot_id, origin)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "triage_ledger_snapshot_verdict_idx",
      "table": "triage_ledger",
      "definition": "CREATE INDEX triage_ledger_snapshot_verdict_idx ON harness_shared.triage_ledger USING btree (snapshot_id, merit, redundancy)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "triage_snapshots_pkey",
      "table": "triage_snapshots",
      "definition": "CREATE UNIQUE INDEX triage_snapshots_pkey ON harness_shared.triage_snapshots USING btree (snapshot_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_installed_plan_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_installed_plan_idx ON harness_shared.trigger_bindings USING btree (workspace_id, plan_harness_slug, plan_slug) WHERE (detached_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_pkey",
      "table": "trigger_bindings",
      "definition": "CREATE UNIQUE INDEX trigger_bindings_pkey ON harness_shared.trigger_bindings USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_ws_goal_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_ws_goal_idx ON harness_shared.trigger_bindings USING btree (workspace_id, goal_id) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_ws_pack_installation_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_ws_pack_installation_idx ON harness_shared.trigger_bindings USING btree (workspace_id, pack_installation_id) WHERE (pack_installation_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_ws_plan_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_ws_plan_idx ON harness_shared.trigger_bindings USING btree (workspace_id, plan_harness_slug, plan_slug)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_ws_source_armed_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_ws_source_armed_idx ON harness_shared.trigger_bindings USING btree (workspace_id, source_id, armed)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_bindings_ws_work_item_idx",
      "table": "trigger_bindings",
      "definition": "CREATE INDEX trigger_bindings_ws_work_item_idx ON harness_shared.trigger_bindings USING btree (workspace_id, work_item_harness_slug, work_item_kind) WHERE ((work_item_kind IS NOT NULL) AND (detached_at IS NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_payload_held_idx",
      "table": "trigger_deliveries",
      "definition": "CREATE INDEX trigger_deliveries_payload_held_idx ON harness_shared.trigger_deliveries USING btree (completed_at) WHERE (payload IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_pkey",
      "table": "trigger_deliveries",
      "definition": "CREATE UNIQUE INDEX trigger_deliveries_pkey ON harness_shared.trigger_deliveries USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_sink_dedupe_key",
      "table": "trigger_deliveries",
      "definition": "CREATE UNIQUE INDEX trigger_deliveries_sink_dedupe_key ON harness_shared.trigger_deliveries USING btree (workspace_id, source_id, dedupe_key, sink_kind, sink_ref)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_ws_event_key_idx",
      "table": "trigger_deliveries",
      "definition": "CREATE INDEX trigger_deliveries_ws_event_key_idx ON harness_shared.trigger_deliveries USING btree (workspace_id, event_key, received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_ws_outcome_received_idx",
      "table": "trigger_deliveries",
      "definition": "CREATE INDEX trigger_deliveries_ws_outcome_received_idx ON harness_shared.trigger_deliveries USING btree (workspace_id, outcome, received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_deliveries_ws_source_received_idx",
      "table": "trigger_deliveries",
      "definition": "CREATE INDEX trigger_deliveries_ws_source_received_idx ON harness_shared.trigger_deliveries USING btree (workspace_id, source_id, received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_pack_installations_identity",
      "table": "trigger_pack_installations",
      "definition": "CREATE UNIQUE INDEX trigger_pack_installations_identity ON harness_shared.trigger_pack_installations USING btree (workspace_id, harness_slug, plugin_name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_pack_installations_pkey",
      "table": "trigger_pack_installations",
      "definition": "CREATE UNIQUE INDEX trigger_pack_installations_pkey ON harness_shared.trigger_pack_installations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_runs_binding_dedupe_key",
      "table": "trigger_runs",
      "definition": "CREATE UNIQUE INDEX trigger_runs_binding_dedupe_key ON harness_shared.trigger_runs USING btree (workspace_id, binding_id, dedupe_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_runs_pkey",
      "table": "trigger_runs",
      "definition": "CREATE UNIQUE INDEX trigger_runs_pkey ON harness_shared.trigger_runs USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trigger_runs_ws_binding_triggered_idx",
      "table": "trigger_runs",
      "definition": "CREATE INDEX trigger_runs_ws_binding_triggered_idx ON harness_shared.trigger_runs USING btree (workspace_id, binding_id, triggered_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_runs_ws_due_idx",
      "table": "trigger_runs",
      "definition": "CREATE INDEX trigger_runs_ws_due_idx ON harness_shared.trigger_runs USING btree (workspace_id, next_attempt_at, triggered_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_runs_ws_status_triggered_idx",
      "table": "trigger_runs",
      "definition": "CREATE INDEX trigger_runs_ws_status_triggered_idx ON harness_shared.trigger_runs USING btree (workspace_id, status, triggered_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trigger_webhook_secrets_pkey",
      "table": "trigger_webhook_secrets",
      "definition": "CREATE UNIQUE INDEX trigger_webhook_secrets_pkey ON harness_shared.trigger_webhook_secrets USING btree (workspace_id, source_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "trusted_authors_by_idx",
      "table": "trusted_authors",
      "definition": "CREATE INDEX trusted_authors_by_idx ON harness_shared.trusted_authors USING btree (workspace_id, harness_slug, trusted_by_github_user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "trusted_authors_pkey",
      "table": "trusted_authors",
      "definition": "CREATE UNIQUE INDEX trusted_authors_pkey ON harness_shared.trusted_authors USING btree (workspace_id, harness_slug, trusted_github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tui_crews_owner_idx",
      "table": "tui_crews",
      "definition": "CREATE INDEX tui_crews_owner_idx ON harness_shared.tui_crews USING btree (workspace_id, owner_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tui_crews_pkey",
      "table": "tui_crews",
      "definition": "CREATE UNIQUE INDEX tui_crews_pkey ON harness_shared.tui_crews USING btree (workspace_id, owner_id, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tui_intents_client_pending_idx",
      "table": "tui_intents",
      "definition": "CREATE INDEX tui_intents_client_pending_idx ON harness_shared.tui_intents USING btree (client_id, status, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tui_intents_pkey",
      "table": "tui_intents",
      "definition": "CREATE UNIQUE INDEX tui_intents_pkey ON harness_shared.tui_intents USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tui_intents_workspace_id_idx",
      "table": "tui_intents",
      "definition": "CREATE INDEX tui_intents_workspace_id_idx ON harness_shared.tui_intents USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tui_layouts_owner_idx",
      "table": "tui_layouts",
      "definition": "CREATE INDEX tui_layouts_owner_idx ON harness_shared.tui_layouts USING btree (workspace_id, owner_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "tui_layouts_pkey",
      "table": "tui_layouts",
      "definition": "CREATE UNIQUE INDEX tui_layouts_pkey ON harness_shared.tui_layouts USING btree (workspace_id, owner_id, name)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "tui_view_state_pkey",
      "table": "tui_view_state",
      "definition": "CREATE UNIQUE INDEX tui_view_state_pkey ON harness_shared.tui_view_state USING btree (workspace_id, owner_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ui_clients_last_seen_idx",
      "table": "ui_clients",
      "definition": "CREATE INDEX ui_clients_last_seen_idx ON harness_shared.ui_clients USING btree (last_seen_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "ui_clients_pkey",
      "table": "ui_clients",
      "definition": "CREATE UNIQUE INDEX ui_clients_pkey ON harness_shared.ui_clients USING btree (client_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ui_intents_completed_idx",
      "table": "ui_intents",
      "definition": "CREATE INDEX ui_intents_completed_idx ON harness_shared.ui_intents USING btree (completed_at) WHERE (completed_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "ui_intents_pending_idx",
      "table": "ui_intents",
      "definition": "CREATE INDEX ui_intents_pending_idx ON harness_shared.ui_intents USING btree (client_id, id) WHERE (status = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "ui_intents_pkey",
      "table": "ui_intents",
      "definition": "CREATE UNIQUE INDEX ui_intents_pkey ON harness_shared.ui_intents USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "ui_intents_workspace_id_idx",
      "table": "ui_intents",
      "definition": "CREATE INDEX ui_intents_workspace_id_idx ON harness_shared.ui_intents USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_actions_pkey",
      "table": "user_actions",
      "definition": "CREATE UNIQUE INDEX user_actions_pkey ON harness_shared.user_actions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "user_actions_running_idx",
      "table": "user_actions",
      "definition": "CREATE INDEX user_actions_running_idx ON harness_shared.user_actions USING btree (harness_slug) WHERE (status = 'running'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_actions_slug_started_idx",
      "table": "user_actions",
      "definition": "CREATE INDEX user_actions_slug_started_idx ON harness_shared.user_actions USING btree (harness_slug, started_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_actions_workspace_idx",
      "table": "user_actions",
      "definition": "CREATE INDEX user_actions_workspace_idx ON harness_shared.user_actions USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_preferences_pkey",
      "table": "user_preferences",
      "definition": "CREATE UNIQUE INDEX user_preferences_pkey ON harness_shared.user_preferences USING btree (user_id, workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "user_sessions_pkey",
      "table": "user_sessions",
      "definition": "CREATE UNIQUE INDEX user_sessions_pkey ON harness_shared.user_sessions USING btree (token)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "user_sessions_user_idx",
      "table": "user_sessions",
      "definition": "CREATE INDEX user_sessions_user_idx ON harness_shared.user_sessions USING btree (user_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_sessions_workspace_user_idx",
      "table": "user_sessions",
      "definition": "CREATE INDEX user_sessions_workspace_user_idx ON harness_shared.user_sessions USING btree (workspace_id, user_id) WHERE (workspace_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "user_trust_list_pkey",
      "table": "user_trust_list",
      "definition": "CREATE UNIQUE INDEX user_trust_list_pkey ON harness_shared.user_trust_list USING btree (workspace_id, trusted_github_user_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "user_trust_list_ws_idx",
      "table": "user_trust_list",
      "definition": "CREATE INDEX user_trust_list_ws_idx ON harness_shared.user_trust_list USING btree (workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "users_pkey",
      "table": "users",
      "definition": "CREATE UNIQUE INDEX users_pkey ON harness_shared.users USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "users_username_idx",
      "table": "users",
      "definition": "CREATE INDEX users_username_idx ON harness_shared.users USING btree (username) WHERE (is_active = true)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "users_username_key",
      "table": "users",
      "definition": "CREATE UNIQUE INDEX users_username_key ON harness_shared.users USING btree (username)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "voice_lease_expires_idx",
      "table": "voice_lease",
      "definition": "CREATE INDEX voice_lease_expires_idx ON harness_shared.voice_lease USING btree (expires_at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "voice_lease_pkey",
      "table": "voice_lease",
      "definition": "CREATE UNIQUE INDEX voice_lease_pkey ON harness_shared.voice_lease USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "voice_relay_pkey",
      "table": "voice_relay",
      "definition": "CREATE UNIQUE INDEX voice_relay_pkey ON harness_shared.voice_relay USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "voice_utterances_mode_idx",
      "table": "voice_utterances",
      "definition": "CREATE INDEX voice_utterances_mode_idx ON harness_shared.voice_utterances USING btree (mode, ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "voice_utterances_pkey",
      "table": "voice_utterances",
      "definition": "CREATE UNIQUE INDEX voice_utterances_pkey ON harness_shared.voice_utterances USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "voice_utterances_ts_idx",
      "table": "voice_utterances",
      "definition": "CREATE INDEX voice_utterances_ts_idx ON harness_shared.voice_utterances USING btree (ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "watchdog_ticks_pkey",
      "table": "watchdog_ticks",
      "definition": "CREATE UNIQUE INDEX watchdog_ticks_pkey ON harness_shared.watchdog_ticks USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "watchdog_ticks_ws_tick_at_idx",
      "table": "watchdog_ticks",
      "definition": "CREATE INDEX watchdog_ticks_ws_tick_at_idx ON harness_shared.watchdog_ticks USING btree (workspace_id, tick_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "webhook_audit_pkey",
      "table": "webhook_audit",
      "definition": "CREATE UNIQUE INDEX webhook_audit_pkey ON harness_shared.webhook_audit USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "webhook_audit_recent_idx",
      "table": "webhook_audit",
      "definition": "CREATE INDEX webhook_audit_recent_idx ON harness_shared.webhook_audit USING btree (workspace_id, harness_slug, sent_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "wi_admission_first_claim_latency_idx",
      "table": "work_items",
      "definition": "CREATE INDEX wi_admission_first_claim_latency_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, admitted_at, first_claimed_at) WHERE (admitted_at IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "wi_admission_pending_idx",
      "table": "work_items",
      "definition": "CREATE INDEX wi_admission_pending_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, created_ts) WHERE (admission = 'pending'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_admissions_pkey",
      "table": "work_admissions",
      "definition": "CREATE UNIQUE INDEX work_admissions_pkey ON harness_shared.work_admissions USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_admissions_source_key",
      "table": "work_admissions",
      "definition": "CREATE UNIQUE INDEX work_admissions_source_key ON harness_shared.work_admissions USING btree (workspace_id, source_kind, source_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_admissions_work_item_idx",
      "table": "work_admissions",
      "definition": "CREATE INDEX work_admissions_work_item_idx ON harness_shared.work_admissions USING btree (workspace_id, work_item_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_blocked_pkey",
      "table": "work_item_blocked",
      "definition": "CREATE UNIQUE INDEX work_item_blocked_pkey ON harness_shared.work_item_blocked USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_claims_expires_idx",
      "table": "work_item_claims",
      "definition": "CREATE INDEX work_item_claims_expires_idx ON harness_shared.work_item_claims USING btree (expires_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_claims_owner_idx",
      "table": "work_item_claims",
      "definition": "CREATE INDEX work_item_claims_owner_idx ON harness_shared.work_item_claims USING btree (workspace_id, owner)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_claims_pkey",
      "table": "work_item_claims",
      "definition": "CREATE UNIQUE INDEX work_item_claims_pkey ON harness_shared.work_item_claims USING btree (workspace_id, harness_slug, work_item_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_claims_pot_idx",
      "table": "work_item_claims",
      "definition": "CREATE INDEX work_item_claims_pot_idx ON harness_shared.work_item_claims USING btree (workspace_id, pot_slug) WHERE (pot_slug IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_deps_blocked_idx",
      "table": "work_item_deps",
      "definition": "CREATE INDEX work_item_deps_blocked_idx ON harness_shared.work_item_deps USING btree (workspace_id, blocked_kind, blocked_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_deps_blocker_idx",
      "table": "work_item_deps",
      "definition": "CREATE INDEX work_item_deps_blocker_idx ON harness_shared.work_item_deps USING btree (workspace_id, blocker_kind, blocker_ref)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_deps_edge_uniq",
      "table": "work_item_deps",
      "definition": "CREATE UNIQUE INDEX work_item_deps_edge_uniq ON harness_shared.work_item_deps USING btree (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_deps_pkey",
      "table": "work_item_deps",
      "definition": "CREATE UNIQUE INDEX work_item_deps_pkey ON harness_shared.work_item_deps USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_occurrences_canonical_idx",
      "table": "work_item_occurrences",
      "definition": "CREATE INDEX work_item_occurrences_canonical_idx ON harness_shared.work_item_occurrences USING btree (workspace_id, canonical_harness_slug, canonical_work_item_id, occurred_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_occurrences_flow_idx",
      "table": "work_item_occurrences",
      "definition": "CREATE INDEX work_item_occurrences_flow_idx ON harness_shared.work_item_occurrences USING btree (workspace_id, occurred_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_occurrences_pkey",
      "table": "work_item_occurrences",
      "definition": "CREATE UNIQUE INDEX work_item_occurrences_pkey ON harness_shared.work_item_occurrences USING btree (occurrence_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_release_cooldowns_expiry_idx",
      "table": "work_item_release_cooldowns",
      "definition": "CREATE INDEX work_item_release_cooldowns_expiry_idx ON harness_shared.work_item_release_cooldowns USING btree (workspace_id, harness_slug, feature_id, released_at)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_release_cooldowns_pkey",
      "table": "work_item_release_cooldowns",
      "definition": "CREATE UNIQUE INDEX work_item_release_cooldowns_pkey ON harness_shared.work_item_release_cooldowns USING btree (workspace_id, harness_slug, feature_id, agent_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_replicas_expires_idx",
      "table": "work_item_replicas",
      "definition": "CREATE INDEX work_item_replicas_expires_idx ON harness_shared.work_item_replicas USING btree (expires_ts)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_replicas_item_idx",
      "table": "work_item_replicas",
      "definition": "CREATE INDEX work_item_replicas_item_idx ON harness_shared.work_item_replicas USING btree (workspace_id, harness_slug, work_item_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_replicas_owner_idx",
      "table": "work_item_replicas",
      "definition": "CREATE INDEX work_item_replicas_owner_idx ON harness_shared.work_item_replicas USING btree (workspace_id, owner)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_replicas_pkey",
      "table": "work_item_replicas",
      "definition": "CREATE UNIQUE INDEX work_item_replicas_pkey ON harness_shared.work_item_replicas USING btree (workspace_id, harness_slug, work_item_id, replica_index)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_spec_revision_edges_by_spec",
      "table": "work_item_spec_revision_edges",
      "definition": "CREATE INDEX work_item_spec_revision_edges_by_spec ON harness_shared.work_item_spec_revision_edges USING btree (workspace_id, harness_slug, plan_slug, spec_id, spec_revision, work_item_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_item_spec_revision_edges_pkey",
      "table": "work_item_spec_revision_edges",
      "definition": "CREATE UNIQUE INDEX work_item_spec_revision_edges_pkey ON harness_shared.work_item_spec_revision_edges USING btree (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_item_spec_revision_edges_workspace_id_harness_slug_wor_key",
      "table": "work_item_spec_revision_edges",
      "definition": "CREATE UNIQUE INDEX work_item_spec_revision_edges_workspace_id_harness_slug_wor_key ON harness_shared.work_item_spec_revision_edges USING btree (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_items_acceptance_drain_plan_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_acceptance_drain_plan_idx ON harness_shared.work_items USING btree (workspace_id, ((payload ->> 'acceptanceDrainPlan'::text))) WHERE ((payload ->> 'acceptanceDrainPlan'::text) IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_author_pubkey_local_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_author_pubkey_local_idx ON harness_shared.work_items USING btree (workspace_id, author_pubkey) WHERE ((author_pubkey IS NOT NULL) AND (author_pubkey <> ''::text) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_authority_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_authority_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, authority) WHERE (authority IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_authority_proposed_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_authority_proposed_idx ON harness_shared.work_items USING btree (terminal_owner, updated_ts) WHERE (authority = 'proposed'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_closed_ts_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_closed_ts_idx ON harness_shared.work_items USING btree (workspace_id, closed_ts) WHERE (closed_ts IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_completion_event_intent_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_completion_event_intent_idx ON harness_shared.work_items USING btree (workspace_id, closed_ts, feature_id) WHERE (payload ? '_completionEventIntentId'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_completion_verification_subject_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_completion_verification_subject_idx ON harness_shared.work_items USING btree ((((payload -> 'verification'::text) ->> 'subject'::text))) WHERE (payload ? 'completionVerification'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_condition_key_uq",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_condition_key_uq ON harness_shared.work_items USING btree (workspace_id, harness_slug, condition_key) WHERE (condition_key IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_design_created_keyset_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_design_created_keyset_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug, COALESCE(created_ts, (0)::bigint) DESC, feature_id DESC) WHERE ((needs_design = true) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_directive_ref_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_directive_ref_idx ON harness_shared.work_items USING btree (workspace_id, directive_ref) WHERE (directive_ref IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_embedding_hnsw_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_embedding_hnsw_idx ON harness_shared.work_items USING hnsw (embedding vector_cosine_ops)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_embedding_mode_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_embedding_mode_idx ON harness_shared.work_items USING btree (embedding_mode) WHERE (embedding_mode IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_escalated_open_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_escalated_open_idx ON harness_shared.work_items USING btree (workspace_id, COALESCE(((payload -> '_ei'::text) ->> 'severity'::text), 'minor'::text)) WHERE ((status = 'open'::text) AND (item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_frontier_open_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_frontier_open_idx ON harness_shared.work_items USING btree (workspace_id, harness_slug) WHERE ((status = 'open'::text) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_goal_id_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_goal_id_idx ON harness_shared.work_items USING btree (workspace_id, goal_id) WHERE (goal_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_intake_promotion_key_uniq",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_intake_promotion_key_uniq ON harness_shared.work_items USING btree ((((payload -> 'intakePromotion'::text) ->> 'key'::text))) WHERE (payload ? 'intakePromotion'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_keyless_title_identity_uq",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_keyless_title_identity_uq ON harness_shared.work_items USING btree (workspace_id, harness_slug, ((payload #>> '{admissionIdentity,titleKey}'::text[]))) WHERE ((item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])) AND ((status IS NULL) OR (status <> ALL (ARRAY['passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'done'::text, 'dropped'::text]))) AND (NULLIF(btrim((payload ->> 'watchdogKey'::text)), ''::text) IS NULL) AND (COALESCE((payload ->> 'lane'::text), 'improvement'::text) <> 'observation'::text) AND ((payload #>> '{admissionIdentity,schemaVersion}'::text[]) = 'admission-identity-v1'::text) AND (NULLIF(btrim((payload #>> '{admissionIdentity,titleKey}'::text[])), ''::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_obs_rubric_ref_v2_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_obs_rubric_ref_v2_idx ON harness_shared.work_items USING btree ((((payload -> 'observation'::text) ->> 'rubricRef'::text))) WHERE (((payload -> 'observation'::text) ->> 'rubricRef'::text) IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_obs_supersedes_v2_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_obs_supersedes_v2_idx ON harness_shared.work_items USING btree ((((payload -> 'observation'::text) ->> 'supersedes'::text))) WHERE (((payload -> 'observation'::text) ->> 'supersedes'::text) IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_pkey",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_pkey ON harness_shared.work_items USING btree (harness_slug, feature_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "work_items_plan_item_stamp_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_plan_item_stamp_idx ON harness_shared.work_items USING btree ((((payload -> 'plan_item'::text) ->> 'plan_slug'::text)), (((payload -> 'plan_item'::text) ->> 'item_id'::text))) WHERE ((payload -> 'plan_item'::text) IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_resource_governor_identity_uq",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_resource_governor_identity_uq ON harness_shared.work_items USING btree (workspace_id, (((payload -> 'resource_governor'::text) ->> 'namespace'::text)), (((payload -> 'resource_governor'::text) ->> 'idempotencyKey'::text))) WHERE (((payload -> 'resource_governor'::text) ->> 'schemaVersion'::text) = '1'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_resource_governor_queue_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_resource_governor_queue_idx ON harness_shared.work_items USING btree (workspace_id, (((payload -> 'resource_governor'::text) ->> 'namespace'::text)), (((payload -> 'resource_governor'::text) ->> 'state'::text)), created_ts, feature_id) WHERE (((payload -> 'resource_governor'::text) ->> 'schemaVersion'::text) = '1'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_scoped_identity",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_scoped_identity ON harness_shared.work_items USING btree (workspace_id, harness_slug, feature_id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_twin_rekey_marker_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_twin_rekey_marker_idx ON harness_shared.work_items USING btree (workspace_id, (((payload -> '_physicalTwinRekey'::text) ->> 'oldId'::text))) WHERE (((payload -> '_physicalTwinRekey'::text) ->> 'migration'::text) = '826'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_twin_repair_marker_idx",
      "table": "work_items",
      "definition": "CREATE INDEX work_items_twin_repair_marker_idx ON harness_shared.work_items USING btree (workspace_id, feature_id) WHERE (((payload -> '_physicalTwinRepair'::text) ->> 'migration'::text) = '826'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "work_items_watchdog_identity_uq",
      "table": "work_items",
      "definition": "CREATE UNIQUE INDEX work_items_watchdog_identity_uq ON harness_shared.work_items USING btree (workspace_id, harness_slug, ((payload ->> 'watchdogKey'::text)), COALESCE(((payload -> '_ei'::text) ->> 'signal_origin'::text), 'organic'::text), COALESCE((payload ->> 'lane'::text), 'improvement'::text)) WHERE ((item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])) AND ((status IS NULL) OR (status <> ALL (ARRAY['passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'done'::text, 'dropped'::text]))) AND ((payload ->> 'watchdogKey'::text) IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "worker_chunk_loop_outcomes_abort_reason_idx",
      "table": "worker_chunk_loop_outcomes",
      "definition": "CREATE INDEX worker_chunk_loop_outcomes_abort_reason_idx ON harness_shared.worker_chunk_loop_outcomes USING btree (workspace_id, execution_path, abort_reason) WHERE (abort_reason IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "worker_chunk_loop_outcomes_path_idx",
      "table": "worker_chunk_loop_outcomes",
      "definition": "CREATE INDEX worker_chunk_loop_outcomes_path_idx ON harness_shared.worker_chunk_loop_outcomes USING btree (workspace_id, execution_path, outcome_kind)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "worker_chunk_loop_outcomes_pkey",
      "table": "worker_chunk_loop_outcomes",
      "definition": "CREATE UNIQUE INDEX worker_chunk_loop_outcomes_pkey ON harness_shared.worker_chunk_loop_outcomes USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "worker_chunk_loop_outcomes_recent_idx",
      "table": "worker_chunk_loop_outcomes",
      "definition": "CREATE INDEX worker_chunk_loop_outcomes_recent_idx ON harness_shared.worker_chunk_loop_outcomes USING btree (workspace_id, harness_slug, created_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_backup_settings_pkey",
      "table": "workspace_backup_settings",
      "definition": "CREATE UNIQUE INDEX workspace_backup_settings_pkey ON harness_shared.workspace_backup_settings USING btree (workspace_id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_grants_active_uq",
      "table": "workspace_grants",
      "definition": "CREATE UNIQUE INDEX workspace_grants_active_uq ON harness_shared.workspace_grants USING btree (workspace_id, organization_id, customer_workspace_id, grantee_kind, grantee_id, permission) WHERE (state = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_grants_grantee_state_idx",
      "table": "workspace_grants",
      "definition": "CREATE INDEX workspace_grants_grantee_state_idx ON harness_shared.workspace_grants USING btree (workspace_id, organization_id, grantee_kind, grantee_id, state, updated_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_grants_pkey",
      "table": "workspace_grants",
      "definition": "CREATE UNIQUE INDEX workspace_grants_pkey ON harness_shared.workspace_grants USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_grants_workspace_state_idx",
      "table": "workspace_grants",
      "definition": "CREATE INDEX workspace_grants_workspace_state_idx ON harness_shared.workspace_grants USING btree (workspace_id, organization_id, customer_workspace_id, state, updated_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_connections_pkey",
      "table": "workspace_host_connections",
      "definition": "CREATE UNIQUE INDEX workspace_host_connections_pkey ON harness_shared.workspace_host_connections USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_events_operation_time_idx",
      "table": "workspace_host_events",
      "definition": "CREATE INDEX workspace_host_events_operation_time_idx ON harness_shared.workspace_host_events USING btree (workspace_id, operation_id, occurred_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_events_pkey",
      "table": "workspace_host_events",
      "definition": "CREATE UNIQUE INDEX workspace_host_events_pkey ON harness_shared.workspace_host_events USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_initialization_steps_host_idx",
      "table": "workspace_host_initialization_steps",
      "definition": "CREATE INDEX workspace_host_initialization_steps_host_idx ON harness_shared.workspace_host_initialization_steps USING btree (workspace_id, host_id, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_initialization_steps_pkey",
      "table": "workspace_host_initialization_steps",
      "definition": "CREATE UNIQUE INDEX workspace_host_initialization_steps_pkey ON harness_shared.workspace_host_initialization_steps USING btree (workspace_id, idempotency_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_initialization_steps_stale_lease_idx",
      "table": "workspace_host_initialization_steps",
      "definition": "CREATE INDEX workspace_host_initialization_steps_stale_lease_idx ON harness_shared.workspace_host_initialization_steps USING btree (lease_expires_at) WHERE (status = 'running'::text)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_logs_host_time_idx",
      "table": "workspace_host_logs",
      "definition": "CREATE INDEX workspace_host_logs_host_time_idx ON harness_shared.workspace_host_logs USING btree (workspace_id, host_id, observed_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_logs_pkey",
      "table": "workspace_host_logs",
      "definition": "CREATE UNIQUE INDEX workspace_host_logs_pkey ON harness_shared.workspace_host_logs USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_budget_idx",
      "table": "workspace_host_operations",
      "definition": "CREATE INDEX workspace_host_operations_budget_idx ON harness_shared.workspace_host_operations USING btree (workspace_id, customer_workspace_id, created_at, estimated_cost_cents) WHERE ((customer_workspace_id IS NOT NULL) AND (estimated_cost_cents IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_host_updated_idx",
      "table": "workspace_host_operations",
      "definition": "CREATE INDEX workspace_host_operations_host_updated_idx ON harness_shared.workspace_host_operations USING btree (workspace_id, host_id, updated_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_pkey",
      "table": "workspace_host_operations",
      "definition": "CREATE UNIQUE INDEX workspace_host_operations_pkey ON harness_shared.workspace_host_operations USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_provider_admission_idx",
      "table": "workspace_host_operations",
      "definition": "CREATE INDEX workspace_host_operations_provider_admission_idx ON harness_shared.workspace_host_operations USING btree (workspace_id, provider_target, status, updated_at, id) WHERE ((provider_target IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_recovery_idx",
      "table": "workspace_host_operations",
      "definition": "CREATE INDEX workspace_host_operations_recovery_idx ON harness_shared.workspace_host_operations USING btree (workspace_id, recovery_state, heartbeat_at, updated_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_operations_tenant_admission_idx",
      "table": "workspace_host_operations",
      "definition": "CREATE INDEX workspace_host_operations_tenant_admission_idx ON harness_shared.workspace_host_operations USING btree (workspace_id, customer_workspace_id, status, updated_at, id) WHERE ((customer_workspace_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_resources_host_idx",
      "table": "workspace_host_resources",
      "definition": "CREATE INDEX workspace_host_resources_host_idx ON harness_shared.workspace_host_resources USING btree (workspace_id, host_id, logical_key)",
      "constraintBacked": false
    },
    {
      "schema": "harness_shared",
      "name": "workspace_host_resources_pkey",
      "table": "workspace_host_resources",
      "definition": "CREATE UNIQUE INDEX workspace_host_resources_pkey ON harness_shared.workspace_host_resources USING btree (workspace_id, host_id, logical_key)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_hosts_pkey",
      "table": "workspace_hosts",
      "definition": "CREATE UNIQUE INDEX workspace_hosts_pkey ON harness_shared.workspace_hosts USING btree (workspace_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "harness_shared",
      "name": "workspace_hosts_workspace_updated_idx",
      "table": "workspace_hosts",
      "definition": "CREATE INDEX workspace_hosts_workspace_updated_idx ON harness_shared.workspace_hosts USING btree (workspace_id, updated_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "external_identities_active_user_idx",
      "table": "external_identities",
      "definition": "CREATE INDEX external_identities_active_user_idx ON papercusp_auth.external_identities USING btree (hosted_user_id, provider) WHERE (status = 'active'::text)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "external_identities_pkey",
      "table": "external_identities",
      "definition": "CREATE UNIQUE INDEX external_identities_pkey ON papercusp_auth.external_identities USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "external_identities_provider_subject_key",
      "table": "external_identities",
      "definition": "CREATE UNIQUE INDEX external_identities_provider_subject_key ON papercusp_auth.external_identities USING btree (provider, subject)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_app_relay_usage_pkey",
      "table": "hosted_app_relay_usage",
      "definition": "CREATE UNIQUE INDEX hosted_app_relay_usage_pkey ON papercusp_auth.hosted_app_relay_usage USING btree (control_workspace_id, organization_id, customer_workspace_id, month)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_billing_customers_customer_idx",
      "table": "hosted_billing_customers",
      "definition": "CREATE UNIQUE INDEX hosted_billing_customers_customer_idx ON papercusp_auth.hosted_billing_customers USING btree (stripe_customer_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_billing_customers_pkey",
      "table": "hosted_billing_customers",
      "definition": "CREATE UNIQUE INDEX hosted_billing_customers_pkey ON papercusp_auth.hosted_billing_customers USING btree (organization_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_billing_webhook_events_pkey",
      "table": "hosted_billing_webhook_events",
      "definition": "CREATE UNIQUE INDEX hosted_billing_webhook_events_pkey ON papercusp_auth.hosted_billing_webhook_events USING btree (provider_event_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_billing_webhook_events_received_idx",
      "table": "hosted_billing_webhook_events",
      "definition": "CREATE INDEX hosted_billing_webhook_events_received_idx ON papercusp_auth.hosted_billing_webhook_events USING btree (received_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_budget_receipts_control_workspace_id_organization_id_key",
      "table": "hosted_budget_receipts",
      "definition": "CREATE UNIQUE INDEX hosted_budget_receipts_control_workspace_id_organization_id_key ON papercusp_auth.hosted_budget_receipts USING btree (control_workspace_id, organization_id, event_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_budget_receipts_latest_idx",
      "table": "hosted_budget_receipts",
      "definition": "CREATE INDEX hosted_budget_receipts_latest_idx ON papercusp_auth.hosted_budget_receipts USING btree (control_workspace_id, organization_id, reservation_id, revision DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_budget_receipts_pkey",
      "table": "hosted_budget_receipts",
      "definition": "CREATE UNIQUE INDEX hosted_budget_receipts_pkey ON papercusp_auth.hosted_budget_receipts USING btree (control_workspace_id, organization_id, reservation_id, revision)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_device_grants_expiry_idx",
      "table": "hosted_cli_device_grants",
      "definition": "CREATE INDEX hosted_cli_device_grants_expiry_idx ON papercusp_auth.hosted_cli_device_grants USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_device_grants_pkey",
      "table": "hosted_cli_device_grants",
      "definition": "CREATE UNIQUE INDEX hosted_cli_device_grants_pkey ON papercusp_auth.hosted_cli_device_grants USING btree (device_code_hash)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_device_grants_user_code_key",
      "table": "hosted_cli_device_grants",
      "definition": "CREATE UNIQUE INDEX hosted_cli_device_grants_user_code_key ON papercusp_auth.hosted_cli_device_grants USING btree (user_code)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_tokens_pkey",
      "table": "hosted_cli_tokens",
      "definition": "CREATE UNIQUE INDEX hosted_cli_tokens_pkey ON papercusp_auth.hosted_cli_tokens USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_tokens_token_hash_key",
      "table": "hosted_cli_tokens",
      "definition": "CREATE UNIQUE INDEX hosted_cli_tokens_token_hash_key ON papercusp_auth.hosted_cli_tokens USING btree (token_hash)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_cli_tokens_user_idx",
      "table": "hosted_cli_tokens",
      "definition": "CREATE INDEX hosted_cli_tokens_user_idx ON papercusp_auth.hosted_cli_tokens USING btree (user_id, organization_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_entitlements_pkey",
      "table": "hosted_entitlements",
      "definition": "CREATE UNIQUE INDEX hosted_entitlements_pkey ON papercusp_auth.hosted_entitlements USING btree (organization_id, user_id, kind)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_entitlements_user_idx",
      "table": "hosted_entitlements",
      "definition": "CREATE INDEX hosted_entitlements_user_idx ON papercusp_auth.hosted_entitlements USING btree (user_id, organization_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_mcp_oauth_clients_pkey",
      "table": "hosted_mcp_oauth_clients",
      "definition": "CREATE UNIQUE INDEX hosted_mcp_oauth_clients_pkey ON papercusp_auth.hosted_mcp_oauth_clients USING btree (client_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_mcp_oauth_clients_workspace_idx",
      "table": "hosted_mcp_oauth_clients",
      "definition": "CREATE INDEX hosted_mcp_oauth_clients_workspace_idx ON papercusp_auth.hosted_mcp_oauth_clients USING btree (control_workspace_id, customer_workspace_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_mcp_oauth_requests_code_hash_key",
      "table": "hosted_mcp_oauth_requests",
      "definition": "CREATE UNIQUE INDEX hosted_mcp_oauth_requests_code_hash_key ON papercusp_auth.hosted_mcp_oauth_requests USING btree (code_hash)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_mcp_oauth_requests_expires_idx",
      "table": "hosted_mcp_oauth_requests",
      "definition": "CREATE INDEX hosted_mcp_oauth_requests_expires_idx ON papercusp_auth.hosted_mcp_oauth_requests USING btree (expires_at)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_mcp_oauth_requests_pkey",
      "table": "hosted_mcp_oauth_requests",
      "definition": "CREATE UNIQUE INDEX hosted_mcp_oauth_requests_pkey ON papercusp_auth.hosted_mcp_oauth_requests USING btree (handle_hash)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_prepaid_allocations_payment_idx",
      "table": "hosted_prepaid_allocations",
      "definition": "CREATE INDEX hosted_prepaid_allocations_payment_idx ON papercusp_auth.hosted_prepaid_allocations USING btree (stripe_account_id, payment_transaction_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_prepaid_allocations_pkey",
      "table": "hosted_prepaid_allocations",
      "definition": "CREATE UNIQUE INDEX hosted_prepaid_allocations_pkey ON papercusp_auth.hosted_prepaid_allocations USING btree (stripe_account_id, allocation_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_expiry_idx",
      "table": "hosted_sessions",
      "definition": "CREATE INDEX hosted_sessions_expiry_idx ON papercusp_auth.hosted_sessions USING btree (expires_at, id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_organization_active_idx",
      "table": "hosted_sessions",
      "definition": "CREATE INDEX hosted_sessions_organization_active_idx ON papercusp_auth.hosted_sessions USING btree (organization_id, expires_at, id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_pkey",
      "table": "hosted_sessions",
      "definition": "CREATE UNIQUE INDEX hosted_sessions_pkey ON papercusp_auth.hosted_sessions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_upstream_session_key",
      "table": "hosted_sessions",
      "definition": "CREATE UNIQUE INDEX hosted_sessions_upstream_session_key ON papercusp_auth.hosted_sessions USING btree (upstream_provider, upstream_session_id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_user_active_idx",
      "table": "hosted_sessions",
      "definition": "CREATE INDEX hosted_sessions_user_active_idx ON papercusp_auth.hosted_sessions USING btree (user_id, expires_at, id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_sessions_workspace_active_idx",
      "table": "hosted_sessions",
      "definition": "CREATE INDEX hosted_sessions_workspace_active_idx ON papercusp_auth.hosted_sessions USING btree (workspace_id, expires_at, id) WHERE ((revoked_at IS NULL) AND (workspace_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_signup_attempts_email_created_idx",
      "table": "hosted_signup_attempts",
      "definition": "CREATE INDEX hosted_signup_attempts_email_created_idx ON papercusp_auth.hosted_signup_attempts USING btree (email, created_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_signup_attempts_pkey",
      "table": "hosted_signup_attempts",
      "definition": "CREATE UNIQUE INDEX hosted_signup_attempts_pkey ON papercusp_auth.hosted_signup_attempts USING btree (attempt_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_signup_attempts_provider_subject_idx",
      "table": "hosted_signup_attempts",
      "definition": "CREATE UNIQUE INDEX hosted_signup_attempts_provider_subject_idx ON papercusp_auth.hosted_signup_attempts USING btree (provider, subject) WHERE (status = 'completed'::text)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_subscriptions_organization_idx",
      "table": "hosted_subscriptions",
      "definition": "CREATE INDEX hosted_subscriptions_organization_idx ON papercusp_auth.hosted_subscriptions USING btree (organization_id, sub_terminal, sub_event_created DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_subscriptions_pkey",
      "table": "hosted_subscriptions",
      "definition": "CREATE UNIQUE INDEX hosted_subscriptions_pkey ON papercusp_auth.hosted_subscriptions USING btree (stripe_subscription_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_usage_openrouter_generation_binding_uidx",
      "table": "hosted_usage_receipts",
      "definition": "CREATE UNIQUE INDEX hosted_usage_openrouter_generation_binding_uidx ON papercusp_auth.hosted_usage_receipts USING btree (provider, usage_id) WHERE (openrouter_credential_ref IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_usage_openrouter_generation_idx",
      "table": "hosted_usage_receipts",
      "definition": "CREATE INDEX hosted_usage_openrouter_generation_idx ON papercusp_auth.hosted_usage_receipts USING btree (provider, usage_id) WHERE (provider = 'openrouter'::text)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_usage_receipts_control_workspace_id_organization_id__key",
      "table": "hosted_usage_receipts",
      "definition": "CREATE UNIQUE INDEX hosted_usage_receipts_control_workspace_id_organization_id__key ON papercusp_auth.hosted_usage_receipts USING btree (control_workspace_id, organization_id, customer_workspace_id, provider, usage_id, revision)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_usage_receipts_month_idx",
      "table": "hosted_usage_receipts",
      "definition": "CREATE INDEX hosted_usage_receipts_month_idx ON papercusp_auth.hosted_usage_receipts USING btree (control_workspace_id, organization_id, occurred_at_ms)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_usage_receipts_pkey",
      "table": "hosted_usage_receipts",
      "definition": "CREATE UNIQUE INDEX hosted_usage_receipts_pkey ON papercusp_auth.hosted_usage_receipts USING btree (control_workspace_id, organization_id, customer_workspace_id, provider, record_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_user_preferences_pkey",
      "table": "hosted_user_preferences",
      "definition": "CREATE UNIQUE INDEX hosted_user_preferences_pkey ON papercusp_auth.hosted_user_preferences USING btree (organization_id, user_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_user_preferences_user_idx",
      "table": "hosted_user_preferences",
      "definition": "CREATE INDEX hosted_user_preferences_user_idx ON papercusp_auth.hosted_user_preferences USING btree (user_id, organization_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_users_active_email_idx",
      "table": "hosted_users",
      "definition": "CREATE INDEX hosted_users_active_email_idx ON papercusp_auth.hosted_users USING btree (lower(primary_email)) WHERE ((status = 'active'::text) AND (primary_email IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_users_pkey",
      "table": "hosted_users",
      "definition": "CREATE UNIQUE INDEX hosted_users_pkey ON papercusp_auth.hosted_users USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_workspace_connector_tickets_expiry_idx",
      "table": "hosted_workspace_connector_tickets",
      "definition": "CREATE INDEX hosted_workspace_connector_tickets_expiry_idx ON papercusp_auth.hosted_workspace_connector_tickets USING btree (expires_at) WHERE (consumed_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_workspace_connector_tickets_pkey",
      "table": "hosted_workspace_connector_tickets",
      "definition": "CREATE UNIQUE INDEX hosted_workspace_connector_tickets_pkey ON papercusp_auth.hosted_workspace_connector_tickets USING btree (ticket_hash)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_workspace_connectors_pkey",
      "table": "hosted_workspace_connectors",
      "definition": "CREATE UNIQUE INDEX hosted_workspace_connectors_pkey ON papercusp_auth.hosted_workspace_connectors USING btree (control_workspace_id, organization_id, customer_workspace_id, host_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "hosted_workspace_connectors_route_label_key",
      "table": "hosted_workspace_connectors",
      "definition": "CREATE UNIQUE INDEX hosted_workspace_connectors_route_label_key ON papercusp_auth.hosted_workspace_connectors USING btree (route_label)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "legal_acceptances_org_user_idx",
      "table": "legal_acceptances",
      "definition": "CREATE INDEX legal_acceptances_org_user_idx ON papercusp_auth.legal_acceptances USING btree (organization_id, user_id, accepted_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "legal_acceptances_pkey",
      "table": "legal_acceptances",
      "definition": "CREATE UNIQUE INDEX legal_acceptances_pkey ON papercusp_auth.legal_acceptances USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "legal_acceptances_version_uq",
      "table": "legal_acceptances",
      "definition": "CREATE UNIQUE INDEX legal_acceptances_version_uq ON papercusp_auth.legal_acceptances USING btree (organization_id, user_id, document_kind, document_version)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "magic_email_idx",
      "table": "magic_link_requests",
      "definition": "CREATE INDEX magic_email_idx ON papercusp_auth.magic_link_requests USING btree (email)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "magic_expires_idx",
      "table": "magic_link_requests",
      "definition": "CREATE INDEX magic_expires_idx ON papercusp_auth.magic_link_requests USING btree (expires_ts)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "magic_link_requests_pkey",
      "table": "magic_link_requests",
      "definition": "CREATE UNIQUE INDEX magic_link_requests_pkey ON papercusp_auth.magic_link_requests USING btree (token)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_audit_events_pkey",
      "table": "organization_audit_events",
      "definition": "CREATE UNIQUE INDEX organization_audit_events_pkey ON papercusp_auth.organization_audit_events USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_audit_events_tenant_time_idx",
      "table": "organization_audit_events",
      "definition": "CREATE INDEX organization_audit_events_tenant_time_idx ON papercusp_auth.organization_audit_events USING btree (organization_id, occurred_at DESC, id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_audit_events_workspace_time_idx",
      "table": "organization_audit_events",
      "definition": "CREATE INDEX organization_audit_events_workspace_time_idx ON papercusp_auth.organization_audit_events USING btree (organization_id, workspace_id, occurred_at DESC, id) WHERE (workspace_id IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_invitation_refs_external_identity_uq",
      "table": "organization_invitation_refs",
      "definition": "CREATE UNIQUE INDEX organization_invitation_refs_external_identity_uq ON papercusp_auth.organization_invitation_refs USING btree (identity_provider, external_invitation_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_invitation_refs_org_id_uq",
      "table": "organization_invitation_refs",
      "definition": "CREATE UNIQUE INDEX organization_invitation_refs_org_id_uq ON papercusp_auth.organization_invitation_refs USING btree (organization_id, id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_invitation_refs_org_status_idx",
      "table": "organization_invitation_refs",
      "definition": "CREATE INDEX organization_invitation_refs_org_status_idx ON papercusp_auth.organization_invitation_refs USING btree (organization_id, status, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_invitation_refs_pkey",
      "table": "organization_invitation_refs",
      "definition": "CREATE UNIQUE INDEX organization_invitation_refs_pkey ON papercusp_auth.organization_invitation_refs USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_memberships_org_role_status_idx",
      "table": "organization_memberships",
      "definition": "CREATE INDEX organization_memberships_org_role_status_idx ON papercusp_auth.organization_memberships USING btree (organization_id, role, status)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_memberships_org_user_uq",
      "table": "organization_memberships",
      "definition": "CREATE UNIQUE INDEX organization_memberships_org_user_uq ON papercusp_auth.organization_memberships USING btree (organization_id, user_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_memberships_pkey",
      "table": "organization_memberships",
      "definition": "CREATE UNIQUE INDEX organization_memberships_pkey ON papercusp_auth.organization_memberships USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organization_memberships_user_status_idx",
      "table": "organization_memberships",
      "definition": "CREATE INDEX organization_memberships_user_status_idx ON papercusp_auth.organization_memberships USING btree (user_id, status, organization_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "organizations_external_identity_uq",
      "table": "organizations",
      "definition": "CREATE UNIQUE INDEX organizations_external_identity_uq ON papercusp_auth.organizations USING btree (identity_provider, external_organization_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organizations_pkey",
      "table": "organizations",
      "definition": "CREATE UNIQUE INDEX organizations_pkey ON papercusp_auth.organizations USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "organizations_status_idx",
      "table": "organizations",
      "definition": "CREATE INDEX organizations_status_idx ON papercusp_auth.organizations USING btree (status, updated_at DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "sessions_expires_idx",
      "table": "sessions",
      "definition": "CREATE INDEX sessions_expires_idx ON papercusp_auth.sessions USING btree (expires_ts)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "sessions_pkey",
      "table": "sessions",
      "definition": "CREATE UNIQUE INDEX sessions_pkey ON papercusp_auth.sessions USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "sessions_user_idx",
      "table": "sessions",
      "definition": "CREATE INDEX sessions_user_idx ON papercusp_auth.sessions USING btree (user_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "support_access_grants_active_tenant_idx",
      "table": "support_access_grants",
      "definition": "CREATE INDEX support_access_grants_active_tenant_idx ON papercusp_auth.support_access_grants USING btree (organization_id, expires_at, id) WHERE (revoked_at IS NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "support_access_grants_active_workspace_idx",
      "table": "support_access_grants",
      "definition": "CREATE INDEX support_access_grants_active_workspace_idx ON papercusp_auth.support_access_grants USING btree (organization_id, workspace_id, expires_at, id) WHERE ((revoked_at IS NULL) AND (workspace_id IS NOT NULL))",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "support_access_grants_pkey",
      "table": "support_access_grants",
      "definition": "CREATE UNIQUE INDEX support_access_grants_pkey ON papercusp_auth.support_access_grants USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "users_email_idx",
      "table": "users",
      "definition": "CREATE INDEX users_email_idx ON papercusp_auth.users USING btree (email)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "users_email_key",
      "table": "users",
      "definition": "CREATE UNIQUE INDEX users_email_key ON papercusp_auth.users USING btree (email)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "users_github_login_key",
      "table": "users",
      "definition": "CREATE UNIQUE INDEX users_github_login_key ON papercusp_auth.users USING btree (github_login)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "users_pkey",
      "table": "users",
      "definition": "CREATE UNIQUE INDEX users_pkey ON papercusp_auth.users USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "webhook_event_receipts_pkey",
      "table": "webhook_event_receipts",
      "definition": "CREATE UNIQUE INDEX webhook_event_receipts_pkey ON papercusp_auth.webhook_event_receipts USING btree (provider, event_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "webhook_event_receipts_queue_idx",
      "table": "webhook_event_receipts",
      "definition": "CREATE INDEX webhook_event_receipts_queue_idx ON papercusp_auth.webhook_event_receipts USING btree (enqueued_at, provider, event_id) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "webhook_event_receipts_retention_idx",
      "table": "webhook_event_receipts",
      "definition": "CREATE INDEX webhook_event_receipts_retention_idx ON papercusp_auth.webhook_event_receipts USING btree (retention_until, provider, event_id) WHERE (status = ANY (ARRAY['applied'::text, 'ignored'::text, 'dead_letter'::text]))",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "webhook_event_receipts_subject_version_idx",
      "table": "webhook_event_receipts",
      "definition": "CREATE INDEX webhook_event_receipts_subject_version_idx ON papercusp_auth.webhook_event_receipts USING btree (provider, subject_ref, event_created_at DESC, event_id) WHERE (subject_ref IS NOT NULL)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "workos_lifecycle_entity_cursors_pkey",
      "table": "workos_lifecycle_entity_cursors",
      "definition": "CREATE UNIQUE INDEX workos_lifecycle_entity_cursors_pkey ON papercusp_auth.workos_lifecycle_entity_cursors USING btree (provider, entity_key)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_auth",
      "name": "workos_lifecycle_entity_cursors_updated_idx",
      "table": "workos_lifecycle_entity_cursors",
      "definition": "CREATE INDEX workos_lifecycle_entity_cursors_updated_idx ON papercusp_auth.workos_lifecycle_entity_cursors USING btree (updated_at, provider, entity_key)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "workos_sealed_sessions_expiry_idx",
      "table": "workos_sealed_sessions",
      "definition": "CREATE INDEX workos_sealed_sessions_expiry_idx ON papercusp_auth.workos_sealed_sessions USING btree (expires_at, external_session_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_auth",
      "name": "workos_sealed_sessions_pkey",
      "table": "workos_sealed_sessions",
      "definition": "CREATE UNIQUE INDEX workos_sealed_sessions_pkey ON papercusp_auth.workos_sealed_sessions USING btree (external_session_id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "briefings_pkey",
      "table": "briefings",
      "definition": "CREATE UNIQUE INDEX briefings_pkey ON papercusp_shared.briefings USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "briefings_quarter_idx",
      "table": "briefings",
      "definition": "CREATE INDEX briefings_quarter_idx ON papercusp_shared.briefings USING btree (quarter)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "briefings_status_idx",
      "table": "briefings",
      "definition": "CREATE INDEX briefings_status_idx ON papercusp_shared.briefings USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "comments_msg_idx",
      "table": "message_comments",
      "definition": "CREATE INDEX comments_msg_idx ON papercusp_shared.message_comments USING btree (message_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "comments_ts_idx",
      "table": "message_comments",
      "definition": "CREATE INDEX comments_ts_idx ON papercusp_shared.message_comments USING btree (ts)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "directive_summaries_pkey",
      "table": "directive_summaries",
      "definition": "CREATE UNIQUE INDEX directive_summaries_pkey ON papercusp_shared.directive_summaries USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "directives_created_idx",
      "table": "directives",
      "definition": "CREATE INDEX directives_created_idx ON papercusp_shared.directives USING btree (created_ts DESC)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "directives_pkey",
      "table": "directives",
      "definition": "CREATE UNIQUE INDEX directives_pkey ON papercusp_shared.directives USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "directives_status_idx",
      "table": "directives",
      "definition": "CREATE INDEX directives_status_idx ON papercusp_shared.directives USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "message_comments_pkey",
      "table": "message_comments",
      "definition": "CREATE UNIQUE INDEX message_comments_pkey ON papercusp_shared.message_comments USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "message_recipients_pkey",
      "table": "message_recipients",
      "definition": "CREATE UNIQUE INDEX message_recipients_pkey ON papercusp_shared.message_recipients USING btree (message_id, dept_slug)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_directive_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_directive_idx ON papercusp_shared.messages USING btree (directive_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_from_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_from_idx ON papercusp_shared.messages USING btree (from_dept)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_kind_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_kind_idx ON papercusp_shared.messages USING btree (kind)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_pkey",
      "table": "messages",
      "definition": "CREATE UNIQUE INDEX messages_pkey ON papercusp_shared.messages USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_project_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_project_idx ON papercusp_shared.messages USING btree (project_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_status_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_status_idx ON papercusp_shared.messages USING btree (status)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "messages_ts_idx",
      "table": "messages",
      "definition": "CREATE INDEX messages_ts_idx ON papercusp_shared.messages USING btree (ts)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "recipients_dept_idx",
      "table": "message_recipients",
      "definition": "CREATE INDEX recipients_dept_idx ON papercusp_shared.message_recipients USING btree (dept_slug)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "summaries_directive_idx",
      "table": "directive_summaries",
      "definition": "CREATE INDEX summaries_directive_idx ON papercusp_shared.directive_summaries USING btree (directive_id)",
      "constraintBacked": false
    },
    {
      "schema": "papercusp_shared",
      "name": "summaries_ts_idx",
      "table": "directive_summaries",
      "definition": "CREATE INDEX summaries_ts_idx ON papercusp_shared.directive_summaries USING btree (ts)",
      "constraintBacked": false
    },
    {
      "schema": "public",
      "name": "iq_battery_cases_pkey",
      "table": "iq_battery_cases",
      "definition": "CREATE UNIQUE INDEX iq_battery_cases_pkey ON public.iq_battery_cases USING btree (id)",
      "constraintBacked": true
    },
    {
      "schema": "public",
      "name": "iq_battery_cases_rotation",
      "table": "iq_battery_cases",
      "definition": "CREATE INDEX iq_battery_cases_rotation ON public.iq_battery_cases USING btree (variant, rotation_index)",
      "constraintBacked": false
    },
    {
      "schema": "public",
      "name": "iq_battery_cases_variant",
      "table": "iq_battery_cases",
      "definition": "CREATE INDEX iq_battery_cases_variant ON public.iq_battery_cases USING btree (variant)",
      "constraintBacked": false
    },
    {
      "schema": "public",
      "name": "iq_battery_metrics_case",
      "table": "iq_battery_metrics",
      "definition": "CREATE INDEX iq_battery_metrics_case ON public.iq_battery_metrics USING btree (case_id)",
      "constraintBacked": false
    },
    {
      "schema": "public",
      "name": "iq_battery_metrics_collected",
      "table": "iq_battery_metrics",
      "definition": "CREATE INDEX iq_battery_metrics_collected ON public.iq_battery_metrics USING btree (collected_at)",
      "constraintBacked": false
    },
    {
      "schema": "public",
      "name": "iq_battery_metrics_pkey",
      "table": "iq_battery_metrics",
      "definition": "CREATE UNIQUE INDEX iq_battery_metrics_pkey ON public.iq_battery_metrics USING btree (run_id, case_id)",
      "constraintBacked": true
    },
    {
      "schema": "public",
      "name": "iq_battery_metrics_variant",
      "table": "iq_battery_metrics",
      "definition": "CREATE INDEX iq_battery_metrics_variant ON public.iq_battery_metrics USING btree (variant)",
      "constraintBacked": false
    }
  ]
};
