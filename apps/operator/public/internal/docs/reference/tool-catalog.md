# Tool catalog (grouped)
URL: /internal/docs/reference/tool-catalog

A coarse, grouped map of the MCP tool surface — one row per tool group with its verbs + capabilities. Generated from the defineTool registry. Full per-tool schemas: agent_tools:list / tools/list at runtime.


> **Generated — do not edit by hand.** Run `npm run gen:doc-projections` (or `npm run gen:doc-tool-catalog`).
> Source: `scripts/gen-doc-tool-catalog.ts`. Part of `starlight-projection-generators-2026-06-05` (Brief 29).

# Tool catalog (grouped)

Every MCP tool is authored once via `defineTool` and projected onto HTTP/MCP/IPC. This is a **coarse** map of that surface — grouped by verb prefix, listing each group's verbs + capability tags. It is intentionally NOT the full per-tool schema dump (that churns on every guidance tweak across the fleet); for full schemas + guidance an agent calls `agent_tools:list { asRole }` or reads `tools/list` at runtime.

**835 MCP tools** across **155 groups**.

## Groups

| Group | Verbs | Names | Capabilities |
|---|---|---|---|
| `ablation` | 1 | `report` | `intel:read` |
| `accounts` | 16 | `get-session-override` `link-complete` `link-start` `link-status` `list` `pin` `probe-capacity` `register` `remove` `reset-rate` `scale_out` `scale_policy` `set-session-override` `status` `test-egress` `unpin` | `harness:read` `harness:write` `operator:write` |
| `actions` | 1 | `recent` | `actions:read` |
| `activity` | 5 | `bash-substitution-report` `mix` `recent` `report` `tool-log` | `activity:read` `activity:report` `intel:read` |
| `agent_chats` | 6 | `archive` `chat` `create` `get` `list` `send_message` | `agent_chats:read` `agent_chats:write` `harness:read` |
| `agent_tools` | 1 | `list` | `agent_tools:read` |
| `agents` | 1 | `list` | `agents:read` |
| `architect` | 1 | `chat` | `harness:write` |
| `artifacts` | 4 | `append` `delete` `load` `save` | `artifacts:read` `artifacts:write` |
| `audit` | 1 | `list` | `audit:read` |
| `auth` | 1 | `set_full_access_roles` | `operator:write` |
| `autoloop` | 2 | `control` `status` | `autoloop:read` `autoloop:write` |
| `autonomy` | 7 | `decide` `graduation_status` `policy_get` `policy_set` `record_disposition` `tripwire_list` `tripwire_revert` | `audit:write` `coord:write` `intel:read` |
| `backup` | 8 | `diff` `promote` `restore` `rollback` `settings_get` `settings_set` `snapshot_create` `snapshot_list` | `backup:read` `backup:write` |
| `behaviour` | 2 | `catalog` `run` | `harness:read` |
| `blender` | 8 | `attach-goal-evidence` `goal-drafts` `grade-idea` `ideate-pass-record` `ideation-feedback` `route-idea` `run-drill` `success-metrics` | `curation:read` `goals:write` `harness:write` |
| `blueprint` | 5 | `catalog` `create` `extend` `publish` `validate` | `harness:read` `harness:write` |
| `brainstorm` | 1 | `chat` | `harness:write` |
| `build` | 1 | `typecheck` | `operator:write` |
| `calendar` | 2 | `propose` `update` | `operator:write` |
| `calibration` | 1 | `summary` | `intel:read` |
| `capability` | 18 | `bash` `bash_kill` `bash_output` `computer` `edit` `fetch` `git` `grant_role` `inspect` `launch-agent` `pty_kill` `pty_open` `pty_read_screen` `pty_write_stdin` `read` `revoke_role` `terminal` `write` | `capability:bash` `capability:code-inspect` `capability:computer` `capability:fs-read` `capability:fs-write` `capability:git` `capability:net` `capability:terminal` `operator:write` |
| `capability_envelope` | 1 | `set_role` | `operator:write` |
| `capability_tier` | 1 | `set` | `operator:write` |
| `cert` | 2 | `catalog` `run` | `harness:read` |
| `change_ledger` | 2 | `calendar` `list` | `intel:read` |
| `chat` | 3 | `ask_choice` `post` `reply` | `chat:write` `operator:write` |
| `checkpoint` | 1 | `await` | `coord:write` |
| `clamp` | 1 | `set_safe_tools` | `operator:write` |
| `code` | 4 | `pack` `run` `structural` `tools` | `agent_tools:read` `capability:bash` `intel:read` |
| `computer` | 6 | `click_element` `list_desktops` `observe` `provision_desktop` `record` `release_desktop` | `capability:computer` `harness:read` `harness:write` |
| `config` | 9 | `doors-get` `doors-set` `doors-set-session` `list-overrides` `reset-overrides` `set-compaction-limit` `terminal-emulator` `tiers-get` `tiers-set` | `coord:read` `coord:write` `operator:read` `operator:write` |
| `consult` | 4 | `close` `decline` `get_feedback` `reply` | `coord:write` |
| `conventions` | 1 | `governing` | `coord:read` |
| `conversation` | 2 | `append` `recent` | `operator:converse` |
| `conversations` | 8 | `answer` `get` `join` `list` `post` `promote` `resolve` `supersede` | `coord:read` `coord:write` |
| `coord` | 43 | `ack` `ask` `ask-owner` `await-inbox` `catch-up` `conditions` `couple` `declare-intent` `decouple` `deliberate` `dispatch` `emit` `escalate` `escalations` `feed` `glance` `goal` `handoff` `handoff_config` `handoffs` `inbox` `mark-terminal` `message-agent` `orient` `plan-events` `presence` `read` `rebind-identity` `resolve` `retract` `roster` `send` `session_reaper_config` `supersede` `thread` `thread-post` `vote` `wake` `wake-mode` `wake-queue` `walls` `watermark` `whoami` | `audit:read` `coord:mark-terminal` `coord:read` `coord:write` `operator:write` |
| `cross_harness` | 8 | `docs_get` `docs_outline` `docs_search` `plans_get` `plans_list` `plans_search` `recent_activity` `supervisor_notes` | `cross_harness:read` `harness:read` `plans:read` |
| `cupboard` | 17 | `install-app` `install-blueprint` `install-goal` `install-plan` `install-plugin` `install-recipe` `install-rubric` `install-template` `publish-app` `publish-goal` `publish-plan` `publish-plugin` `publish-recipe` `publish-rubric` `publish-template` `search` `unpublish` | `harness:read` `harness:write` |
| `curation` | 3 | `change-feed` `feed` `state-of-pot` | `curation:read` |
| `datatypes` | 6 | `catalog` `get` `install` `list` `publish` `summary` | `intel:read` `intel:write` |
| `db` | 6 | `check_drift` `migrate` `migrate-policy` `migrations` `next-migration` `txn-timeouts` | `locks:read` `locks:write` `operator:read` `operator:write` |
| `decision_ledger` | 2 | `list` `summary` | `intel:read` |
| `deploy` | 6 | `await` `harness` `pot` `status` `teardown` `teardown_pot` | `coord:write` `harness:read` `harness:write` |
| `deploys` | 1 | `vintage` | `intel:read` |
| `dev` | 36 | `activity` `audit` `build_status` `cache_stats` `claude_session` `code_run_adoption` `coord_categorize` `dogfood_substrate_status` `embed_latency` `event_emitter` `harnesses` `ipc_echo` `limit_failure_rate` `listening_ports` `omp_session` `orient_dedup_rate` `pg_active_queries` `pg_health` `pg_hot_queries` `pg_mutate` `pg_query` `pg_table_sizes` `pipeline_position` `processes` `rate_governor_status` `resolve_owner` `restart` `service_health` `session_detail` `sessions` `stall_waker_status` `state_counter` `telemetry` `tool_cooccurrence` `why` `worker_chunk_loop_metrics` | `audit:read` `harness:read` `intel:read` `intel:write` `locks:write` `tasks:read` |
| `discovery` | 2 | `pots` `set_pot` | `discovery:read` `discovery:write` |
| `docs` | 4 | `author` `get` `outline` `search` | `docs:read` `docs:write` |
| `egress` | 4 | `health` `list` `provision` `release` | `harness:read` `harness:write` |
| `events` | 8 | `await` `cancel` `catalog` `emit` `graph` `lost-wake-check` `status` `unsubscribe` | `coord:read` `coord:write` `events:read` |
| `exec_sandbox` | 1 | `set_policy` | `operator:write` |
| `experiment` | 3 | `catalog` `results` `run` | `harness:read` `harness:write` |
| `facts` | 3 | `assert` `list` `retract` | `coord:read` `coord:write` |
| `features` | 5 | `get` `history` `list_related` `search` `tag_vocabulary` | `features:read` |
| `flags` | 3 | `get` `list` `set` | `audit:write` `intel:read` |
| `fleet` | 36 | `admit` `assignments` `audit` `await-drained` `bench` `cancel` `capacity` `create` `cup_mail` `delivery` `drain` `governor` `headcount-target` `invariant` `join` `kill` `launch-on-plan` `leader-brief` `leave` `list` `opus_budget` `pause` `place_batch` `recolor` `reconfigure-member` `request_remote_spawn` `require-checkpoint` `respawn-member` `resume` `sandbox_deps` `selected_cup` `status` `supervise` `take-leadership` `tree` `wind-down` | `capability:terminal` `coord:read` `coord:write` `fleet:create` `fleet:headcount-target` `fleet:join` `fleet:leave` `fleet:list` `fleet:pause` `fleet:recolor` `fleet:reconfigure-member` `fleet:request_remote_spawn` |
| `gates` | 2 | `canary-check` `degenerate-check` | `coord:read` |
| `gateway` | 7 | `egress_mode` `local_backend_list` `local_backend_register` `local_backend_remove` `owner_report` `reload` `status` | `harness:read` `harness:write` |
| `generators` | 1 | `publish` | `coord:write` |
| `git-sync` | 2 | `await` `run` | `coord:write` `operator:write` |
| `gmail` | 1 | `create-draft` | `operator:write` |
| `goals` | 16 | `apply-package-update` `arm-schedule` `attach-pot` `create` `detach-pot` `get` `list` `pots` `propose` `set-input-schema` `set-output-schema` `set-property` `set-schedule` `start` `start-from-package` `update` | `goals:read` `goals:write` |
| `governor` | 2 | `arm` `state_snapshot` | `intel:read` `operator:write` |
| `graph` | 1 | `query` | `intel:read` |
| `gym` | 4 | `arm` `judge` `set-gates` `signals` | `harness:read` `operator:write` |
| `harness` | 15 | `configure` `create` `escalation` `generate-from-repo` `get` `health` `list` `list_features` `markdown_index` `membership` `migrate-config-json` `overview` `pending_reviews` `phase_path` `status` | `coord:read` `harness:read` `harness:write` |
| `harness_docs` | 8 | `anchor` `ingest` `list` `record` `regenerate` `retire` `set_overlay` `verify` | `docs:read` `docs:write` |
| `health` | 2 | `ack` `unack` | `operator:write` |
| `hooks` | 1 | `known` | `roles:read` |
| `host` | 1 | `memory_pressure` | `intel:read` |
| `improvements` | 10 | `agent-review` `capture` `digest` `keyless-digest` `learning_loops` `resolve` `set-auto-policy` `set-watchdog-tunables` `triage` `watchdog-status` | `coord:read` `coord:write` `operator:write` `work_items:write` |
| `inbox` | 5 | `bulk-run-act` `bulk-run-manifest` `bulk-run-report` `bulk-run-settle` `triage` | `coord:read` `coord:write` |
| `instance` | 3 | `boot` `capture` `clone` | `harness:read` `harness:write` |
| `intel` | 2 | `artifacts` `spawn_tree` | `intel:read` |
| `issues` | 1 | `list` | `operator:read` |
| `journal` | 4 | `peer-brief` `push-utilization` `recent` `record-turn` | `activity:report` `coord:read` `intel:read` |
| `knowledge_packs` | 10 | `candidates` `decide_candidate` `export` `install` `list` `publish` `set_enabled` `sweep` `uninstall` `upgrade` | `harness:write` `memory:read` `memory:write` |
| `learning` | 1 | `set-scout-budget` | `operator:write` |
| `lexicon` | 1 | `active_pack` | `work_items:read` |
| `locks` | 13 | `acquire` `acquire_granular` `acquire_resource` `cancel_wait` `check_command` `heartbeat` `heartbeat_resource` `list` `queue` `register_resource` `release` `release_granular` `release_resource` | `locks:read` `locks:write` |
| `logs` | 1 | `read` | `intel:read` |
| `loop` | 7 | `arm` `checkpoint` `end` `session-audit` `soak-report` `status` `transfer` | `harness:read` `routines:write` |
| `lsp` | 2 | `apply` `query` | `intel:read` `intel:write` |
| `mail` | 2 | `reply` `send` | `operator:write` |
| `memory` | 7 | `forget` `list` `recover-from-transcripts` `remember` `search` `sweep` `update` | `memory:read` `memory:write` |
| `merge` | 1 | `approve` | `harness:write` |
| `meta` | 2 | `define-datatype` `define-tool` | `intel:write` |
| `mode` | 3 | `get` `list` `set` | `coord:read` `coord:write` |
| `network` | 1 | `board` | `harness:read` |
| `new_subagent` | 2 | `approve` `request` | `coord:write` |
| `notifications` | 2 | `recent` `send_owner` | `coord:write` `notifications:read` |
| `omp` | 2 | `config` `sessions` | `omp:read` `omp:write` |
| `operator` | 23 | `audit` `budget` `conv_voice` `converse` `credentials_status` `decisions` `dedup_check` `multi_workspace` `notes` `nudge` `paused` `preferences` `preview_prompt` `rate_limit_config` `standing_approval_mark_shown` `standing_approvals_decide` `standing_approvals_list` `stats` `trigger_state` `voice_debug` `voice_prefs` `voice_spend_summary` `voice_utterance_log` | `operator:converse` `operator:read` `operator:write` `secrets:operator-credentials:read` |
| `oracle` | 1 | `chat` | `harness:read` |
| `orchestrate` | 3 | `inspect` `run` `search` | `capability:bash` `recipes:read` |
| `orders` | 4 | `disposition` `get` `list` `record` | `coord:read` `coord:write` |
| `p2p` | 1 | `trace` | `coord:read` |
| `papercup` | 1 | `converse` | `operator:converse` |
| `papercusp` | 1 | `list_workspaces` | `workspaces:read` |
| `pending_events` | 1 | `list` | `pending_events:read` |
| `personal` | 2 | `purge` `search` | `memory:write` `search:read` |
| `pilot` | 2 | `assign` `collect` | `coord:read` `work_items:write` |
| `plan-item` | 1 | `await` | `coord:write` |
| `plan_items` | 11 | `adopt_name` `assign` `claim` `convert` `heartbeat` `join_group` `leave_group` `my_items` `release` `status` `unassign` | `coord:read` `coord:write` |
| `plans` | 70 | `add-decision` `add-item` `apply-plan-block` `arm-schedule` `attention` `audit` `audit-unshipped` `backfill-dependency-edges` `backfill-revisions` `bind-spec-evidence` `cleanup-act` `cleanup-manifest` `cleanup-report` `cleanup-settle` `disarm-schedule` `edit` `evaluate-spec-quality` `evaluate-spec-test-adequacy` `export` `get` `get-input-schema` `get-item` `get-output-schema` `get-properties` `get-spec-evidence` `get-specs` `get-template-data` `items` `launch` `lint` `list` `new` `pause` `promote` `publish-outputs` `ratify-decision` `resume` `revision-diff` `revision-transcript` `revisions` `run-now` `run-transcript` `runs` `search` `set-archived` `set-content` `set-content-chunk` `set-decision-body` `set-frontmatter` `set-frontmatter-field` `set-importance` `set-initiative` `set-input-schema` `set-item-blocked-by` `set-item-phase` `set-now` `set-output-schema` `set-plan-status` `set-priority` `set-property` `set-run-status` `set-schedule` `set-specs` `set-status` `set-template-data` `set-title` `spec-reconciliation` `start` `summarize-revision` `transfer-owner` | `coord:read` `coord:write` `operator:write` `plans:read` `plans:write` |
| `platform` | 4 | `contribute` `dogfood_verify` `enable` `fork_gc` | `harness:read` `harness:write` |
| `plugins` | 4 | `fire_event` `invoke_action` `runtime_status` `tui_panes` | `plugins:read` `plugins:write` |
| `pot` | 30 | `add-member` `ask` `asks` `ban_member` `beacon_consent` `control_policy` `create` `create_from_repo` `cross_grant` `declare-wake` `dissolve` `get` `get-steering` `leave` `list` `membership_decide` `membership_pending` `moderation_queue` `moderation_resolve` `mug_efficiency` `obliterate` `pause` `report` `request_work` `set-steering` `start` `status` `takedown` `update` `wake` | `harness:read` `harness:write` `intel:write` `operator:write` `routines:write` `work_items:read` `work_items:write` |
| `pot_git` | 2 | `integration_requests` `secrets_exemptions` | `audit:write` |
| `probe` | 2 | `emit` `get` | `coord:read` `coord:write` |
| `processes` | 4 | `freeze` `kill` `limit` `list` | `intel:read` `processes:control` `processes:kill` |
| `projects` | 4 | `get` `list` `spec_revision` `spec_revisions` | `projects:read` |
| `prompt` | 1 | `role_override` | `operator:write` |
| `provisioner` | 4 | `detect_hardware` `install` `plan_install` `recommend` | `harness:read` `harness:write` |
| `quota` | 1 | `set_tool` | `operator:write` |
| `rationale` | 2 | `feed` `reproject` | `coord:read` `coord:write` |
| `recipes` | 8 | `candidates` `get` `list` `merge` `revise` `run` `search` `sweep` | `capability:bash` `intel:write` `recipes:read` |
| `release` | 6 | `checkpoint-config` `checkpoint-run` `cut` `deploy` `repair-queue` `trace` | `intel:read` `operator:write` |
| `resource` | 2 | `delegate` `offers` | `harness:read` `operator:write` |
| `review` | 1 | `approve` | `harness:write` |
| `roles` | 4 | `firing_on` `get` `known` `list` | `roles:read` |
| `routines` | 4 | `group-set` `list` `revert` `set` | `operator:read` `operator:write` |
| `rubrics` | 8 | `amend` `get` `list` `propose` `ratify` `search` `set-history-reset` `trend` | `coord:read` `coord:write` |
| `saved_prompts` | 1 | `list` | `intel:read` |
| `schedule` | 1 | `inventory` | `operator:read` |
| `scheduler` | 5 | `get_claim_spec` `get_next` `preview_spec_delta` `running` `set_claim_spec` | `work_items:read` `work_items:write` |
| `scorecards` | 5 | `emit` `evaluate` `freshness` `list` `retract` | `coord:read` `coord:write` |
| `search` | 3 | `fulltext` `query` `semantic` | `search:read` |
| `service` | 1 | `await-up` | `coord:write` |
| `session` | 3 | `carry-drill` `end` `request-compaction` | `coord:write` |
| `sessions` | 7 | `digest` `ingest-gate-event` `list` `list-pending-gates` `read` `search` `timeline` | `activity:report` `search:read` |
| `setup` | 8 | `complete` `save_integration_key` `save_key` `set_git_identity` `set_telemetry` `set_tutorial_progress` `set_update_channel` `status` | `operator:read` `operator:write` |
| `slack` | 1 | `respond-in-thread` | `operator:write` |
| `slash` | 1 | `dispatch` | `coord:write` |
| `social` | 5 | `delete` `post` `read` `reply` `search` | `operator:write` `search:read` |
| `state` | 2 | `read` `subscribe` | `coord:read` `coord:write` |
| `storage` | 2 | `prune` `usage` | `storage:read` `storage:write` |
| `substrate` | 2 | `revoke_contributor` `revoke_self_device` | `intel:write` |
| `tasks` | 6 | `create` `get` `list` `ops` `todo_write` `update_plan` | `tasks:read` `tasks:write` |
| `telemetry` | 1 | `set_buffer` | `operator:write` |
| `templates` | 3 | `get-guide` `list` `new-app` | `harness:read` `harness:write` |
| `testing` | 6 | `coverage` `flakiness` `prune-orphan-runs` `run` `run-status` `runs` | `locks:write` `operator:read` `testing:run` `work_items:write` |
| `tools` | 3 | `find` `invoke` `scaffold` | `agent_tools:read` `intel:write` |
| `topics` | 6 | `create` `feed` `list` `merge` `tag` `unsubscribe` | `coord:read` `coord:write` |
| `triggers` | 7 | `arm` `bind` `create` `disarm` `list` `run-with-last-event` `status` | `intel:read` `operator:write` `plans:write` |
| `trust` | 4 | `add` `comms` `list` `remove` | `audit:write` `intel:read` |
| `tui` | 1 | `dispatch` | `tui:dispatch` |
| `turn` | 1 | `interrupt` | `turn:interrupt` |
| `ui` | 3 | `dispatch` `get_state` `list_clients` | `ui:dispatch` `ui:read` |
| `voice` | 8 | `agent` `channels` `delegate_deep` `join` `leave` `say` `status` `transcript` | `operator:read` `operator:write` |
| `watch` | 1 | `create` | `coord:write` |
| `watchdog` | 1 | `status` | `coord:read` |
| `wiki` | 1 | `backlinks` | `wiki:read` |
| `work-item` | 1 | `await` | `coord:write` |
| `work_items` | 43 | `amend` `bulk_dedup` `burn_down` `checkpoint` `claim` `claim_next` `claim_replica` `claimable` `co_locate` `comment` `complete` `completion_stats` `create` `decline_release_request` `expand` `export` `get` `hold_open` `judge_redundancy` `link` `links` `list` `observe` `park` `pickup` `promote` `reclaim_config` `record_replica_result` `redundancy_status` `release` `reorder` `request_release` `search` `set_blocker` `set_live_verified` `set_priority` `set_redundancy` `set_state` `stranded` `subscribe` `tag` `update` `withdraw_release_request` | `operator:write` `work_items:read` `work_items:write` |
