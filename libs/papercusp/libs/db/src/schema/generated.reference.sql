-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE SCHEMA "harness_shared";
--> statement-breakpoint
CREATE SCHEMA "papercup_shared";
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_paused" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."identity_files" (
	"role" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."oauth_nonces" (
	"nonce" text NOT NULL,
	"exp_ms" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_skills" (
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."mobile_pair_tokens" (
	"pair_token" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_email" text,
	"desktop_host" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_rate_limit" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "papercup_shared"."messages" (
	"id" text NOT NULL,
	"ts" bigint NOT NULL,
	"from_dept" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"ref_id" text,
	"project_id" text,
	"directive_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."cooldown_marks" (
	"key" text NOT NULL,
	"marked_at_ms" bigint NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."voice_lease" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	CONSTRAINT "voice_lease_owner_kind_check" CHECK (owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text]))
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_budget_tiers" (
	"ord" integer PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"cap_usd" numeric(10, 2) NOT NULL,
	"blurb" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."orchestrator_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tiers" jsonb DEFAULT '[1,2,4]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '["trivial","normal","hard"]'::jsonb NOT NULL,
	"rubric" text DEFAULT '' NOT NULL,
	"updated_ts" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "orchestrator_settings_id_check" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_feature_debug_notes" (
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."plugin_enables" (
	"harness_slug" text NOT NULL,
	"plugin_slug" text NOT NULL,
	"version" text NOT NULL,
	"config_hash" text DEFAULT '' NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" text NOT NULL,
	CONSTRAINT "plugin_enables_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."plugin_enables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."adaptive_telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"harness_slug" text NOT NULL,
	"ts" bigint NOT NULL,
	"feature_id" text NOT NULL,
	"requested_n" integer NOT NULL,
	"actual_n" integer NOT NULL,
	"tier_label" text,
	"available_at_decision" integer,
	"max_slots" integer,
	"outcome" text,
	"outcome_ts" bigint,
	"duration_ms" bigint,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."prompt_compositions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text,
	"role" text NOT NULL,
	"run_id" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"total_chars" integer DEFAULT 0 NOT NULL,
	"substrate_chars" integer DEFAULT 0 NOT NULL,
	"history_chars" integer DEFAULT 0 NOT NULL,
	"role_prompt_chars" integer,
	"memory_chars" integer,
	"identity_chars" integer,
	"runtime_chars" integer
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."prompt_compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_feature_prs" (
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"pr_url" text NOT NULL,
	"pr_state" text DEFAULT 'unknown' NOT NULL,
	"opened_ts" bigint DEFAULT 0 NOT NULL,
	"updated_ts" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."feature_audit_consolidated" (
	"id" bigserial NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor" text
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."agent_chats_consolidated" (
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"id" text NOT NULL,
	"role" text NOT NULL,
	"feature_id" text,
	"title" text,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_experts" (
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text NOT NULL,
	"expert_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"budget_cents" bigint DEFAULT 0 NOT NULL,
	"feature_size" text,
	"high_level_spec" text DEFAULT '' NOT NULL,
	"agent_count" integer DEFAULT 0 NOT NULL,
	"round_count" integer DEFAULT 0 NOT NULL,
	"personas_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_engaged" boolean DEFAULT false NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"termination_reason" text,
	"spec_content" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."tool_invocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"plugin_name" text NOT NULL,
	"tool_name" text NOT NULL,
	"role" text NOT NULL,
	"feature_id" text,
	"chunk_id" text,
	"run_id" text,
	"spawn_id" text NOT NULL,
	"parent_spawn_id" text,
	"window_key" text NOT NULL,
	"invoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"status" text NOT NULL,
	"output_ref" text,
	"output_size" bigint,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."tool_invocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'text_typed' NOT NULL,
	"el_conv_id" text,
	"audio_url" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "operator_turns_conversation_id_seq_key" UNIQUE("conversation_id","seq"),
	CONSTRAINT "operator_turns_role_check" CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]))
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."spawned_agents" (
	"spawn_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"parent_spawn_id" text,
	"parent_role" text NOT NULL,
	"child_role" text NOT NULL,
	"feature_id" text,
	"chunk_id" text,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"exit_code" integer,
	"output_tail" text,
	"error_message" text,
	"cancel_requested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."spawned_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"harness_slug" text,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"el_conversation_ids" text[] DEFAULT '{""}' NOT NULL,
	"has_audio" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_search_provider_credentials" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_ct" "bytea",
	"updated_at" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."operator_search_provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"claude_session_id" text,
	"request_text" text,
	"summary" text,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_project_files" (
	"harness_slug" text PRIMARY KEY NOT NULL,
	"spec" text,
	"agents" text,
	"contract" text,
	"config" text,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."mobile_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"workspace_id" text NOT NULL,
	"device_kind" text DEFAULT 'mobile' NOT NULL,
	"device_label" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mobile_devices_device_kind_check" CHECK (device_kind = 'mobile'::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."mobile_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."delegate_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"kind" text DEFAULT 'delegate-complete' NOT NULL,
	"headline" text NOT NULL,
	"claude_session_id" text
);
--> statement-breakpoint
CREATE TABLE "papercup_shared"."briefings" (
	"id" text NOT NULL,
	"title" text NOT NULL,
	"quarter" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"script_path" text,
	"duration_seconds" integer,
	"youtube_url" text,
	"youtube_video_id" text,
	"thumbnail_url" text,
	"render_log" text,
	"error" text,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "papercup_shared"."directive_summaries" (
	"id" text NOT NULL,
	"directive_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"author" text DEFAULT 'ceo' NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "papercup_shared"."message_comments" (
	"id" text NOT NULL,
	"message_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."plugin_configs" (
	"harness_slug" text NOT NULL,
	"plugin_slug" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" text NOT NULL,
	"config_ct" "bytea",
	CONSTRAINT "plugin_configs_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."plugin_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "papercup_shared"."directives" (
	"id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_ts" bigint NOT NULL,
	"deadline_ts" bigint,
	"budget_cents" bigint,
	"priority" text,
	"assigned_departments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "papercup_shared"."message_recipients" (
	"message_id" text NOT NULL,
	"dept_slug" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."user_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"harness_slug" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"detail_url" text,
	"error_text" text,
	"invocation_id" text,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"actor" text,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."delegates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace" text NOT NULL,
	"claude_session_id" text NOT NULL,
	"title" text,
	"summary" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"initiator_msg" text,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "claude_sessions_claude_session_id_key" UNIQUE("claude_session_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."el_conv_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text,
	"workspace" text,
	"duration_secs" integer DEFAULT 0 NOT NULL,
	"ym" text DEFAULT to_char(now(), 'YYYY-MM'::text) NOT NULL,
	CONSTRAINT "el_conv_calls_conversation_id_key" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."agent_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" text NOT NULL,
	"command_id" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"duration_ms" integer,
	"workspace" text,
	"session_id" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."agent_queries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" text NOT NULL,
	"query_id" text NOT NULL,
	"args_compact" jsonb,
	"workspace" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."goals" (
	"id" text NOT NULL,
	"install_slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"parent_id" text,
	"budget_cents" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"workspace_id" text NOT NULL,
	"_search" "tsvector" GENERATED ALWAYS AS ((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))) STORED,
	CONSTRAINT "goals_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."pending_events" (
	"id" text NOT NULL,
	"install_slug" text NOT NULL,
	"kind" text NOT NULL,
	"target_role" text NOT NULL,
	"payload" jsonb,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by" text,
	"source_id" text,
	"workspace_id" text NOT NULL,
	CONSTRAINT "pending_events_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."pending_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."toast_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"description" text,
	"harness_slug" text,
	"created_at" bigint NOT NULL,
	"action_label" text,
	"action_href" text
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."routines" (
	"id" text NOT NULL,
	"install_slug" text NOT NULL,
	"name" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"target_role" text NOT NULL,
	"payload_template" jsonb,
	"concurrency" text DEFAULT 'queue' NOT NULL,
	"catchup" text DEFAULT 'skip-old' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"next_fire_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"workspace_id" text NOT NULL,
	CONSTRAINT "routines_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."token_index" (
	"token" text NOT NULL,
	"harness_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text DEFAULT 'harness' NOT NULL,
	CONSTRAINT "token_index_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."token_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."audit_log" (
	"id" text NOT NULL,
	"ts" bigint NOT NULL,
	"actor" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"details" jsonb,
	"workspace_id" text NOT NULL,
	"_search" "tsvector" GENERATED ALWAYS AS (((setweight(to_tsvector('simple'::regconfig, COALESCE(subject, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(action, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(actor, ''::text)), 'C'::"char"))) STORED,
	CONSTRAINT "audit_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."project_spec_revisions" (
	"id" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"spec" text NOT NULL,
	"summary" text,
	"author_role" text NOT NULL,
	"author" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"include_decisions" jsonb,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd_cents" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text NOT NULL,
	CONSTRAINT "psr_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."project_spec_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."projects" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"budget_cents" bigint,
	"spent_cents" bigint DEFAULT 0 NOT NULL,
	"owning_dept" text,
	"vertical" text,
	"created_ts" bigint NOT NULL,
	"updated_ts" bigint NOT NULL,
	"metadata" jsonb,
	"spec" text,
	"spec_updated_at" timestamp with time zone,
	"spec_manually_edited_at" timestamp with time zone,
	"slug" text,
	"cost_cap_cents" bigint,
	"earned_cents" bigint DEFAULT 0 NOT NULL,
	"parent_slug" text,
	"workspace_id" text NOT NULL,
	"_search" "tsvector" GENERATED ALWAYS AS ((setweight(to_tsvector('english'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(slug, ''::text)), 'B'::"char"))) STORED,
	CONSTRAINT "projects_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."voice_utterances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace" text,
	"source" text NOT NULL,
	"mode" text,
	"length_chars" integer,
	"name_used" boolean DEFAULT false NOT NULL,
	"had_backstory" boolean DEFAULT false NOT NULL,
	"modifications" jsonb
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_scan_locks" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."operator_scan_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."org_charter" (
	"org_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_notes" (
	"org_id" text NOT NULL,
	"dept_slug" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_credentials" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"payload_ct" "bytea"
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_decisions" (
	"org_id" text NOT NULL,
	"dept_slug" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_budget" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_publish_credentials" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"payload_ct" "bytea"
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_voice_credentials" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"payload_ct" "bytea"
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_marketplace_token" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"payload_ct" "bytea"
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_escalations" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"escalation" text,
	"supervisor_notes" text,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_pending_issues" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"issue_id" text NOT NULL,
	"feature_id" text,
	"title" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT 'normal' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_phases" (
	"harness_slug" text NOT NULL,
	"phase" text NOT NULL,
	"phase_path" text DEFAULT '' NOT NULL,
	"branch" text,
	"port" integer,
	"public_url" text,
	"exists_on_disk" boolean DEFAULT false NOT NULL,
	"alive" boolean DEFAULT false NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"promotion_in_flight" boolean DEFAULT false NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_tests" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"test_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"last_run_ts" bigint,
	"payload" jsonb NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_departments" (
	"org_id" text NOT NULL,
	"dept_slug" text NOT NULL,
	"harness_slug" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"mandate" text DEFAULT '' NOT NULL,
	"inbox_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outbox_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_projects" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"vertical" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_inbox" (
	"org_id" text NOT NULL,
	"dept_slug" text NOT NULL,
	"message_id" text NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"msg_from" text DEFAULT '' NOT NULL,
	"msg_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ref_id" text,
	"project_id" text,
	"directive_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."org_outbox" (
	"org_id" text NOT NULL,
	"dept_slug" text NOT NULL,
	"message_id" text NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"msg_from" text DEFAULT '' NOT NULL,
	"msg_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ref_id" text,
	"project_id" text,
	"directive_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_last_scan" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_standing_candidates" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_idle_snapshot" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_tts_spend" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_stt_spend" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_voice_prefs" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_agent_config" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_scanner_session" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_first_run" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_user_profile" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_prompt_user" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_preferences" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_oracle_prompt" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_oracle_memory" (
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_smoke_test" (
	"harness_slug" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"pass_content" text,
	"failure_content" text,
	"results" jsonb,
	"startup_log" text,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_plan_review" (
	"harness_slug" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_health" (
	"harness_slug" text PRIMARY KEY NOT NULL,
	"spec_present" boolean DEFAULT false NOT NULL,
	"contract_present" boolean DEFAULT false NOT NULL,
	"last_check_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."provision_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"plugin_slug" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_registry" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_trust_store" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"payload_ct" "bytea"
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_dismissed_cards" (
	"workspace_id" text NOT NULL,
	"card_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_dismissed_cards_pkey" PRIMARY KEY("workspace_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."operator_dismissed_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."mobile_push_tokens" (
	"device_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_push_tokens_pkey" PRIMARY KEY("device_id","platform"),
	CONSTRAINT "mobile_push_tokens_platform_check" CHECK (platform = ANY (ARRAY['apns'::text, 'fcm'::text]))
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."mobile_push_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."hidden_plugins" (
	"basename" text NOT NULL,
	"reason" text,
	"hidden_at" bigint DEFAULT 0 NOT NULL,
	"hidden_by" text,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "hidden_plugins_pkey" PRIMARY KEY("basename","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_text_artifacts" (
	"harness_slug" text NOT NULL,
	"rel_path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_text_artifacts_pkey" PRIMARY KEY("harness_slug","rel_path")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."system_principals" (
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"bearer_hash" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_principals_pkey" PRIMARY KEY("workspace_id","name"),
	CONSTRAINT "system_principals_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."system_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_branch_actions" (
	"harness_slug" text NOT NULL,
	"branch" text NOT NULL,
	"payload" jsonb NOT NULL,
	"last_check_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_branch_actions_pkey" PRIMARY KEY("harness_slug","branch")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_feature_notes" (
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"content" text NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "harness_feature_notes_pkey" PRIMARY KEY("workspace_id","harness_slug","feature_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."provision_state" (
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"plugin_slug" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "provision_state_pkey" PRIMARY KEY("workspace_id","harness_slug","plugin_slug")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_mission_state" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"cost_warn_fired" boolean DEFAULT false NOT NULL,
	"ready_for_prod_at" bigint,
	"lanes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "harness_mission_state_pkey" PRIMARY KEY("workspace_id","harness_slug")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_dispatches" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"parent_slug" text NOT NULL,
	"child_slug" text NOT NULL,
	"child_role" text,
	"dispatch_at" bigint NOT NULL,
	"result_body" jsonb,
	CONSTRAINT "harness_dispatches_pkey" PRIMARY KEY("workspace_id","parent_slug","child_slug","dispatch_at")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_run_chunks" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"chunk_data" text NOT NULL,
	"ts" bigint NOT NULL,
	CONSTRAINT "harness_run_chunks_pkey" PRIMARY KEY("workspace_id","harness_slug","run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."autoloop_state" (
	"harness_slug" text NOT NULL,
	"role" text DEFAULT 'director' NOT NULL,
	"last_fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "autoloop_state_pkey" PRIMARY KEY("harness_slug","role")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."pi_sessions" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"bearer_hash" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "pi_sessions_pkey" PRIMARY KEY("workspace_id","session_id"),
	CONSTRAINT "pi_sessions_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."pi_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_summaries" (
	"harness_slug" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	CONSTRAINT "harness_summaries_pkey" PRIMARY KEY("harness_slug","phase")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_archives" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"id" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_archives_pkey" PRIMARY KEY("harness_slug","phase","id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_screenshots" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"id" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_screenshots_pkey" PRIMARY KEY("harness_slug","phase","id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_promotions" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"promotion_id" text NOT NULL,
	"from_phase" text NOT NULL,
	"to_phase" text NOT NULL,
	"sha" text,
	"ts" bigint NOT NULL,
	CONSTRAINT "harness_promotions_pkey" PRIMARY KEY("workspace_id","harness_slug","promotion_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."plugin_capability_grants" (
	"plugin_name" text NOT NULL,
	"plugin_version" text NOT NULL,
	"harness_slug" text NOT NULL,
	"capability" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text,
	"reason" text,
	CONSTRAINT "plugin_capability_grants_pkey" PRIMARY KEY("plugin_name","plugin_version","harness_slug","capability")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_design_artifacts" (
	"id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"created_ts" bigint NOT NULL,
	CONSTRAINT "harness_design_artifacts_pkey" PRIMARY KEY("id","harness_slug"),
	CONSTRAINT "hda_kind_chk" CHECK (kind = ANY (ARRAY['spec'::text, 'sketch'::text, 'screenshot'::text, 'annotation'::text, 'rejected_candidate'::text, 'review'::text]))
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_brainstorm" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"canvas" jsonb,
	"mindmap" jsonb,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_brainstorm_pkey" PRIMARY KEY("harness_slug","phase")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_lanes" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"role" text NOT NULL,
	"feature_id" text,
	"pid" integer,
	"started_at" bigint NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_lanes_pkey" PRIMARY KEY("harness_slug","phase","role")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_hook_logs" (
	"harness_slug" text NOT NULL,
	"log_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_hook_logs_pkey" PRIMARY KEY("harness_slug","log_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_checkpoints" (
	"harness_slug" text NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"waiting_since_ms" bigint DEFAULT 0 NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "harness_checkpoints_pkey" PRIMARY KEY("harness_slug","name")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_expert_feedback" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"expert_id" text NOT NULL,
	"feedback_id" text NOT NULL,
	"persona" text NOT NULL,
	"verdict" jsonb,
	"created_at" bigint NOT NULL,
	"ended_at" bigint,
	CONSTRAINT "harness_expert_feedback_pkey" PRIMARY KEY("workspace_id","harness_slug","expert_id","feedback_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_expert_turns" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"expert_id" text NOT NULL,
	"feedback_id" text NOT NULL,
	"turn_idx" integer NOT NULL,
	"speaker" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "harness_expert_turns_pkey" PRIMARY KEY("workspace_id","harness_slug","expert_id","feedback_id","turn_idx"),
	CONSTRAINT "harness_expert_turns_speaker_check" CHECK (speaker = ANY (ARRAY['expert'::text, 'feedback'::text]))
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_snapshots_consolidated" (
	"harness_slug" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"iter_num" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feature_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_ts" bigint NOT NULL,
	"updated_ts" bigint NOT NULL,
	CONSTRAINT "harness_snapshots_consolidated_pkey" PRIMARY KEY("harness_slug","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_git_log" (
	"harness_slug" text NOT NULL,
	"sha" text NOT NULL,
	"parents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_git_log_pkey" PRIMARY KEY("harness_slug","sha")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_snapshots" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"iteration" integer NOT NULL,
	"features_json" text,
	"validation_md" text,
	"notes_md" text,
	"config_json" text,
	"taken_at" bigint NOT NULL,
	CONSTRAINT "harness_snapshots_pkey" PRIMARY KEY("workspace_id","harness_slug","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."operator_claims" (
	"harness_slug" text NOT NULL,
	"plugin_slug" text NOT NULL,
	"machine_id" text NOT NULL,
	"pid" integer NOT NULL,
	"run_id" text NOT NULL,
	"script_hash" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "operator_claims_pkey" PRIMARY KEY("harness_slug","plugin_slug")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_decisions" (
	"harness_slug" text NOT NULL,
	"line_hash" text NOT NULL,
	"ts" bigint DEFAULT 0 NOT NULL,
	"iso" text DEFAULT '' NOT NULL,
	"verb" text NOT NULL,
	"args" text DEFAULT '' NOT NULL,
	"iteration" integer,
	"is_ghost" boolean DEFAULT false NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "harness_decisions_pkey" PRIMARY KEY("harness_slug","line_hash")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."pending_reviews" (
	"harness_slug" text NOT NULL,
	"review_id" text NOT NULL,
	"feature_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" bigint NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	CONSTRAINT "pending_reviews_pkey" PRIMARY KEY("harness_slug","review_id","phase")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_run_output" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"harness_slug" text NOT NULL,
	"run_id" text NOT NULL,
	"role" text,
	"prompt_body" text DEFAULT '' NOT NULL,
	"jsonl_body" text DEFAULT '' NOT NULL,
	"out_body" text DEFAULT '' NOT NULL,
	"err_body" text DEFAULT '' NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	CONSTRAINT "harness_run_output_pkey" PRIMARY KEY("workspace_id","harness_slug","run_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_status" (
	"harness_slug" text NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"status" text NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"total_features" integer DEFAULT 0 NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"todo_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"last_active_ts" bigint,
	"cost_usd" numeric(10, 4),
	"workspace_id" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "harness_status_pkey" PRIMARY KEY("harness_slug","phase"),
	CONSTRAINT "harness_status_status_check" CHECK (status = ANY (ARRAY['idle'::text, 'running'::text, 'stalled'::text, 'paused'::text, 'error'::text]))
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_chunk_plans" (
	"workspace_id" text NOT NULL,
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"files" jsonb NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"strikes" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"commit_sha" text,
	"created_ts" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000) NOT NULL,
	"updated_ts" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000) NOT NULL,
	"spawned_by_spawn_id" text,
	CONSTRAINT "harness_chunk_plans_pkey" PRIMARY KEY("workspace_id","harness_slug","feature_id","chunk_id")
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."harness_chunk_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_proposals_shared" (
	"harness_slug" text NOT NULL,
	"proposal_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" bigint NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text DEFAULT '' NOT NULL,
	"phase" text DEFAULT 'staging' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_verdict" text,
	"review_summary" text,
	"reviewed_at" bigint,
	"applied_at" bigint,
	"rejected_at" bigint,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "harness_proposals_shared_pkey" PRIMARY KEY("harness_slug","proposal_id","phase")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."agent_runs_consolidated" (
	"harness_slug" text NOT NULL,
	"run_id" text NOT NULL,
	"role" text NOT NULL,
	"feature_id" text,
	"ts" bigint NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"running" boolean DEFAULT false NOT NULL,
	"last_event_ts" bigint,
	"created_ts" bigint NOT NULL,
	"updated_ts" bigint NOT NULL,
	CONSTRAINT "agent_runs_consolidated_pkey" PRIMARY KEY("harness_slug","run_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_issues_consolidated" (
	"harness_slug" text NOT NULL,
	"issue_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"found_at" timestamp with time zone NOT NULL,
	"found_during" text,
	"repro" text,
	"evidence" text,
	"suggested_fix" text,
	"code_pointer" text,
	"linked_feature_id" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_ts" bigint NOT NULL,
	"updated_ts" bigint NOT NULL,
	CONSTRAINT "harness_issues_consolidated_pkey" PRIMARY KEY("harness_slug","issue_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."snapshot_features" (
	"harness_slug" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text NOT NULL,
	"attempts" bigint NOT NULL,
	"claims" text,
	"notes" text,
	"metadata" jsonb,
	"kind" text,
	"project_id" text,
	"expected_cost_cents" bigint,
	"tags" jsonb,
	"needs_human_review" boolean DEFAULT false NOT NULL,
	"deprecation_reason" text,
	"parent_id" text,
	"goal_id" text,
	"ts" bigint,
	"created_ts" bigint NOT NULL,
	CONSTRAINT "snapshot_features_pkey" PRIMARY KEY("harness_slug","snapshot_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "harness_shared"."harness_features_consolidated" (
	"harness_slug" text NOT NULL,
	"feature_id" text NOT NULL,
	"title" text,
	"summary" text,
	"status" text,
	"attempts" bigint,
	"claims" text,
	"notes" text,
	"metadata" jsonb,
	"kind" text,
	"project_id" text,
	"expected_cost_cents" bigint,
	"tags" jsonb,
	"needs_human_review" boolean,
	"ts" bigint,
	"created_ts" bigint,
	"updated_ts" bigint,
	"parent_id" text,
	"goal_id" text,
	"taken_by" text,
	"taken_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"workspace_id" text NOT NULL,
	"_search" "tsvector" GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'C'::"char"))) STORED,
	"deprecation_reason" text,
	"see_also" text[] DEFAULT '{""}' NOT NULL,
	"needs_design" boolean DEFAULT false NOT NULL,
	"design_status" text,
	"design_spec_id" text,
	"discarded_design_work" boolean DEFAULT false NOT NULL,
	CONSTRAINT "harness_features_consolidated_pkey" PRIMARY KEY("harness_slug","feature_id"),
	CONSTRAINT "hfc_design_status_chk" CHECK ((design_status IS NULL) OR (design_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'ignored'::text]))),
	CONSTRAINT "hfc_workspace_nonempty" CHECK (workspace_id <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "harness_shared"."harness_features_consolidated" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "harness_shared"."operator_turns" ADD CONSTRAINT "operator_turns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "harness_shared"."operator_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercup_shared"."message_comments" ADD CONSTRAINT "message_comments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "papercup_shared"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercup_shared"."message_recipients" ADD CONSTRAINT "message_recipients_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "papercup_shared"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_shared"."goals" ADD CONSTRAINT "goals_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "harness_shared"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_shared"."project_spec_revisions" ADD CONSTRAINT "project_spec_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "harness_shared"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_shared"."mobile_push_tokens" ADD CONSTRAINT "mobile_push_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "harness_shared"."mobile_devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_files_workspace_idx" ON "harness_shared"."identity_files" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_nonces_exp_idx" ON "harness_shared"."oauth_nonces" USING btree ("exp_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_skills_lookup_idx" ON "harness_shared"."harness_skills" USING btree ("workspace_id" text_ops,"harness_slug" text_ops);--> statement-breakpoint
CREATE INDEX "mobile_pair_tokens_exp_idx" ON "harness_shared"."mobile_pair_tokens" USING btree ("expires_at_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "messages_directive_idx" ON "papercup_shared"."messages" USING btree ("directive_id" text_ops);--> statement-breakpoint
CREATE INDEX "messages_from_idx" ON "papercup_shared"."messages" USING btree ("from_dept" text_ops);--> statement-breakpoint
CREATE INDEX "messages_kind_idx" ON "papercup_shared"."messages" USING btree ("kind" text_ops);--> statement-breakpoint
CREATE INDEX "messages_project_idx" ON "papercup_shared"."messages" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "papercup_shared"."messages" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "messages_ts_idx" ON "papercup_shared"."messages" USING btree ("ts" int8_ops);--> statement-breakpoint
CREATE INDEX "cooldown_marks_marked_at_idx" ON "harness_shared"."cooldown_marks" USING btree ("marked_at_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "voice_lease_expires_idx" ON "harness_shared"."voice_lease" USING btree ("expires_at_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "hfdn_harness_idx" ON "harness_shared"."harness_feature_debug_notes" USING btree ("workspace_id" text_ops,"harness_slug" text_ops);--> statement-breakpoint
CREATE INDEX "plugin_enables_plugin_idx" ON "harness_shared"."plugin_enables" USING btree ("plugin_slug" text_ops);--> statement-breakpoint
CREATE INDEX "plugin_enables_workspace_idx" ON "harness_shared"."plugin_enables" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "adaptive_telemetry_harness_idx" ON "harness_shared"."adaptive_telemetry" USING btree ("harness_slug" text_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "adaptive_telemetry_pending_idx" ON "harness_shared"."adaptive_telemetry" USING btree ("harness_slug" text_ops,"feature_id" text_ops) WHERE (outcome IS NULL);--> statement-breakpoint
CREATE INDEX "prompt_compositions_by_feature" ON "harness_shared"."prompt_compositions" USING btree ("workspace_id" int8_ops,"harness_slug" text_ops,"feature_id" text_ops,"ts_ms" text_ops) WHERE (feature_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "prompt_compositions_by_harness" ON "harness_shared"."prompt_compositions" USING btree ("workspace_id" text_ops,"harness_slug" int8_ops,"ts_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "hfp_harness_idx" ON "harness_shared"."harness_feature_prs" USING btree ("workspace_id" text_ops,"harness_slug" text_ops);--> statement-breakpoint
CREATE INDEX "feature_audit_consolidated_lookup_idx" ON "harness_shared"."feature_audit_consolidated" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"feature_id" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "agent_chats_consolidated_recent_idx" ON "harness_shared"."agent_chats_consolidated" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"updated_at" int8_ops);--> statement-breakpoint
CREATE INDEX "he_recent_idx" ON "harness_shared"."harness_experts" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"updated_at" int8_ops);--> statement-breakpoint
CREATE INDEX "tool_invocations_quota_idx" ON "harness_shared"."tool_invocations" USING btree ("workspace_id" text_ops,"tool_name" text_ops,"role" text_ops,"window_key" text_ops) WHERE (status = 'ok'::text);--> statement-breakpoint
CREATE INDEX "tool_invocations_telemetry_idx" ON "harness_shared"."tool_invocations" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"invoked_at" text_ops);--> statement-breakpoint
CREATE INDEX "operator_turns_conv_seq_idx" ON "harness_shared"."operator_turns" USING btree ("conversation_id" uuid_ops,"seq" int4_ops);--> statement-breakpoint
CREATE INDEX "spawned_agents_parent_idx" ON "harness_shared"."spawned_agents" USING btree ("workspace_id" text_ops,"parent_spawn_id" text_ops);--> statement-breakpoint
CREATE INDEX "spawned_agents_recent_idx" ON "harness_shared"."spawned_agents" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"started_at" text_ops);--> statement-breakpoint
CREATE INDEX "spawned_agents_running_idx" ON "harness_shared"."spawned_agents" USING btree ("workspace_id" text_ops,"status" text_ops) WHERE (status = 'running'::text);--> statement-breakpoint
CREATE INDEX "operator_conversations_active_idx" ON "harness_shared"."operator_conversations" USING btree (workspace_id text_ops,COALESCE(harness_slug, ''::text) text_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "operator_conversations_started_idx" ON "harness_shared"."operator_conversations" USING btree ("workspace_id" int8_ops,"started_at" int8_ops);--> statement-breakpoint
CREATE INDEX "operator_scans_session_idx" ON "harness_shared"."operator_scans" USING btree ("claude_session_id" text_ops) WHERE (claude_session_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "operator_scans_ws_started_idx" ON "harness_shared"."operator_scans" USING btree ("workspace_id" text_ops,"started_at" text_ops);--> statement-breakpoint
CREATE INDEX "harness_project_files_workspace_idx" ON "harness_shared"."harness_project_files" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "mobile_devices_user_idx" ON "harness_shared"."mobile_devices" USING btree ("user_email" text_ops);--> statement-breakpoint
CREATE INDEX "mobile_devices_workspace_idx" ON "harness_shared"."mobile_devices" USING btree ("workspace_id" text_ops) WHERE (revoked_at IS NULL);--> statement-breakpoint
CREATE INDEX "delegate_inbox_ws_pending_idx" ON "harness_shared"."delegate_inbox" USING btree ("workspace_id" text_ops,"created_at" text_ops) WHERE (delivered_at IS NULL);--> statement-breakpoint
CREATE INDEX "summaries_directive_idx" ON "papercup_shared"."directive_summaries" USING btree ("directive_id" text_ops);--> statement-breakpoint
CREATE INDEX "summaries_ts_idx" ON "papercup_shared"."directive_summaries" USING btree ("ts" int8_ops);--> statement-breakpoint
CREATE INDEX "comments_msg_idx" ON "papercup_shared"."message_comments" USING btree ("message_id" text_ops);--> statement-breakpoint
CREATE INDEX "comments_ts_idx" ON "papercup_shared"."message_comments" USING btree ("ts" int8_ops);--> statement-breakpoint
CREATE INDEX "plugin_configs_plugin_idx" ON "harness_shared"."plugin_configs" USING btree ("plugin_slug" text_ops);--> statement-breakpoint
CREATE INDEX "plugin_configs_workspace_idx" ON "harness_shared"."plugin_configs" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "directives_created_idx" ON "papercup_shared"."directives" USING btree ("created_ts" int8_ops);--> statement-breakpoint
CREATE INDEX "directives_status_idx" ON "papercup_shared"."directives" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "recipients_dept_idx" ON "papercup_shared"."message_recipients" USING btree ("dept_slug" text_ops);--> statement-breakpoint
CREATE INDEX "user_actions_running_idx" ON "harness_shared"."user_actions" USING btree ("harness_slug" text_ops) WHERE (status = 'running'::text);--> statement-breakpoint
CREATE INDEX "user_actions_slug_started_idx" ON "harness_shared"."user_actions" USING btree ("harness_slug" int8_ops,"started_at" int8_ops);--> statement-breakpoint
CREATE INDEX "user_actions_workspace_idx" ON "harness_shared"."user_actions" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "delegates_open_ws_idx" ON "harness_shared"."delegates" USING btree ("workspace" text_ops,"last_active_at" timestamptz_ops) WHERE (status = 'open'::text);--> statement-breakpoint
CREATE INDEX "delegates_status_idx" ON "harness_shared"."delegates" USING btree ("status" text_ops,"last_active_at" text_ops);--> statement-breakpoint
CREATE INDEX "el_conv_calls_ym_idx" ON "harness_shared"."el_conv_calls" USING btree ("ym" text_ops);--> statement-breakpoint
CREATE INDEX "agent_actions_agent_ts_idx" ON "harness_shared"."agent_actions" USING btree ("agent" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "agent_actions_id_ts_idx" ON "harness_shared"."agent_actions" USING btree ("command_id" timestamptz_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "agent_actions_ts_idx" ON "harness_shared"."agent_actions" USING btree ("ts" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "agent_actions_ws_ts_idx" ON "harness_shared"."agent_actions" USING btree ("workspace" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "agent_queries_agent_id_ts" ON "harness_shared"."agent_queries" USING btree ("agent" text_ops,"query_id" text_ops,"ts" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "agent_queries_ts_idx" ON "harness_shared"."agent_queries" USING btree ("ts" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "goals_install_idx" ON "harness_shared"."goals" USING btree ("install_slug" text_ops);--> statement-breakpoint
CREATE INDEX "goals_parent_idx" ON "harness_shared"."goals" USING btree ("parent_id" text_ops);--> statement-breakpoint
CREATE INDEX "goals_search_idx" ON "harness_shared"."goals" USING gin ("_search" tsvector_ops);--> statement-breakpoint
CREATE INDEX "goals_status_idx" ON "harness_shared"."goals" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "goals_workspace_idx" ON "harness_shared"."goals" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "pending_events_source_idx" ON "harness_shared"."pending_events" USING btree ("source_id" text_ops);--> statement-breakpoint
CREATE INDEX "pending_events_unconsumed_idx" ON "harness_shared"."pending_events" USING btree ("install_slug" text_ops,"due_at" text_ops) WHERE (consumed_at IS NULL);--> statement-breakpoint
CREATE INDEX "pending_events_workspace_idx" ON "harness_shared"."pending_events" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "toast_log_created_idx" ON "harness_shared"."toast_log" USING btree ("created_at" int8_ops);--> statement-breakpoint
CREATE INDEX "toast_log_slug_created_idx" ON "harness_shared"."toast_log" USING btree ("harness_slug" int8_ops,"created_at" int8_ops) WHERE (harness_slug IS NOT NULL);--> statement-breakpoint
CREATE INDEX "routines_active_due_idx" ON "harness_shared"."routines" USING btree ("active" timestamptz_ops,"next_fire_at" timestamptz_ops) WHERE (active = true);--> statement-breakpoint
CREATE INDEX "routines_install_idx" ON "harness_shared"."routines" USING btree ("install_slug" text_ops);--> statement-breakpoint
CREATE INDEX "routines_workspace_idx" ON "harness_shared"."routines" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "token_index_kind_idx" ON "harness_shared"."token_index" USING btree ("kind" text_ops);--> statement-breakpoint
CREATE INDEX "token_index_workspace_idx" ON "harness_shared"."token_index" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "harness_shared"."audit_log" USING btree ("action" text_ops);--> statement-breakpoint
CREATE INDEX "audit_actor_action_ts_idx" ON "harness_shared"."audit_log" USING btree ("actor" int8_ops,"action" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "audit_search_idx" ON "harness_shared"."audit_log" USING gin ("_search" tsvector_ops);--> statement-breakpoint
CREATE INDEX "audit_subject_ts_idx" ON "harness_shared"."audit_log" USING btree ("subject" int8_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "harness_shared"."audit_log" USING btree ("ts" int8_ops);--> statement-breakpoint
CREATE INDEX "audit_workspace_idx" ON "harness_shared"."audit_log" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "project_spec_revisions_workspace_idx" ON "harness_shared"."project_spec_revisions" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "psr_author_role_idx" ON "harness_shared"."project_spec_revisions" USING btree ("author_role" text_ops);--> statement-breakpoint
CREATE INDEX "psr_project_idx" ON "harness_shared"."project_spec_revisions" USING btree ("project_id" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "psr_ts_idx" ON "harness_shared"."project_spec_revisions" USING btree ("ts" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "projects_parent_idx" ON "harness_shared"."projects" USING btree ("parent_slug" text_ops);--> statement-breakpoint
CREATE INDEX "projects_search_idx" ON "harness_shared"."projects" USING gin ("_search" tsvector_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "harness_shared"."projects" USING btree ("slug" text_ops);--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "harness_shared"."projects" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "harness_shared"."projects" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "voice_utterances_mode_idx" ON "harness_shared"."voice_utterances" USING btree ("mode" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "voice_utterances_ts_idx" ON "harness_shared"."voice_utterances" USING btree ("ts" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "operator_scan_locks_expires_idx" ON "harness_shared"."operator_scan_locks" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "provision_audit_log_target_idx" ON "harness_shared"."provision_audit_log" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"plugin_slug" text_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "operator_dismissed_cards_dismissed_at_idx" ON "harness_shared"."operator_dismissed_cards" USING btree ("dismissed_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "hidden_plugins_basename_idx" ON "harness_shared"."hidden_plugins" USING btree ("basename" text_ops);--> statement-breakpoint
CREATE INDEX "hta_updated_idx" ON "harness_shared"."harness_text_artifacts" USING btree ("harness_slug" int8_ops,"updated_at" text_ops);--> statement-breakpoint
CREATE INDEX "hta_workspace_idx" ON "harness_shared"."harness_text_artifacts" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "system_principals_workspace_idx" ON "harness_shared"."system_principals" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_feature_notes_harness_idx" ON "harness_shared"."harness_feature_notes" USING btree ("workspace_id" text_ops,"harness_slug" text_ops);--> statement-breakpoint
CREATE INDEX "harness_dispatches_parent_idx" ON "harness_shared"."harness_dispatches" USING btree ("workspace_id" text_ops,"parent_slug" text_ops,"dispatch_at" text_ops);--> statement-breakpoint
CREATE INDEX "harness_run_chunks_run_idx" ON "harness_shared"."harness_run_chunks" USING btree ("workspace_id" int4_ops,"harness_slug" int4_ops,"run_id" int4_ops,"seq" int4_ops);--> statement-breakpoint
CREATE INDEX "pi_sessions_active_idx" ON "harness_shared"."pi_sessions" USING btree ("workspace_id" text_ops,"session_id" text_ops) WHERE (ended_at IS NULL);--> statement-breakpoint
CREATE INDEX "pi_sessions_workspace_idx" ON "harness_shared"."pi_sessions" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_summaries_workspace_idx" ON "harness_shared"."harness_summaries" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_archives_slug_phase_ts_idx" ON "harness_shared"."harness_archives" USING btree ("harness_slug" int8_ops,"phase" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_screenshots_slug_phase_ts_idx" ON "harness_shared"."harness_screenshots" USING btree ("harness_slug" int8_ops,"phase" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_promotions_ts_idx" ON "harness_shared"."harness_promotions" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "plugin_caps_by_harness" ON "harness_shared"."plugin_capability_grants" USING btree ("harness_slug" text_ops,"plugin_name" text_ops);--> statement-breakpoint
CREATE INDEX "plugin_caps_by_plugin" ON "harness_shared"."plugin_capability_grants" USING btree ("plugin_name" text_ops,"plugin_version" text_ops);--> statement-breakpoint
CREATE INDEX "hda_created_idx" ON "harness_shared"."harness_design_artifacts" USING btree ("harness_slug" int8_ops,"created_ts" text_ops);--> statement-breakpoint
CREATE INDEX "hda_feature_idx" ON "harness_shared"."harness_design_artifacts" USING btree ("harness_slug" text_ops,"feature_id" text_ops);--> statement-breakpoint
CREATE INDEX "hda_kind_idx" ON "harness_shared"."harness_design_artifacts" USING btree ("harness_slug" text_ops,"feature_id" text_ops,"kind" text_ops);--> statement-breakpoint
CREATE INDEX "harness_brainstorm_workspace_idx" ON "harness_shared"."harness_brainstorm" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_lanes_started_idx" ON "harness_shared"."harness_lanes" USING btree ("started_at" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_lanes_workspace_idx" ON "harness_shared"."harness_lanes" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_hook_logs_slug_ts_idx" ON "harness_shared"."harness_hook_logs" USING btree ("harness_slug" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_checkpoints_slug_waiting_idx" ON "harness_shared"."harness_checkpoints" USING btree ("harness_slug" int8_ops,"waiting_since_ms" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_expert_feedback_expert_idx" ON "harness_shared"."harness_expert_feedback" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"expert_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_expert_turns_fb_idx" ON "harness_shared"."harness_expert_turns" USING btree ("workspace_id" int4_ops,"harness_slug" text_ops,"expert_id" text_ops,"feedback_id" int4_ops,"turn_idx" text_ops);--> statement-breakpoint
CREATE INDEX "hsc_iter_idx" ON "harness_shared"."harness_snapshots_consolidated" USING btree ("harness_slug" int4_ops,"iter_num" text_ops);--> statement-breakpoint
CREATE INDEX "hsc_ts_idx" ON "harness_shared"."harness_snapshots_consolidated" USING btree ("harness_slug" text_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_git_log_slug_ts_idx" ON "harness_shared"."harness_git_log" USING btree ("harness_slug" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_snapshots_recent_idx" ON "harness_shared"."harness_snapshots" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"taken_at" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_decisions_slug_ts_idx" ON "harness_shared"."harness_decisions" USING btree ("harness_slug" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "pending_reviews_slug_resolved_ts_idx" ON "harness_shared"."pending_reviews" USING btree ("harness_slug" int8_ops,"resolved" int8_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "pending_reviews_workspace_idx" ON "harness_shared"."pending_reviews" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "harness_run_output_recent_idx" ON "harness_shared"."harness_run_output" USING btree ("workspace_id" int8_ops,"harness_slug" int8_ops,"ended_at" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_status_expires_idx" ON "harness_shared"."harness_status" USING btree ("expires_at" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_status_updated_idx" ON "harness_shared"."harness_status" USING btree ("updated_at" int8_ops);--> statement-breakpoint
CREATE INDEX "harness_status_workspace_idx" ON "harness_shared"."harness_status" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "chunk_plans_by_spawned_by" ON "harness_shared"."harness_chunk_plans" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"spawned_by_spawn_id" text_ops) WHERE (spawned_by_spawn_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_chunk_plans_by_feature" ON "harness_shared"."harness_chunk_plans" USING btree ("workspace_id" int4_ops,"harness_slug" text_ops,"feature_id" text_ops,"chunk_index" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_chunk_plans_by_status" ON "harness_shared"."harness_chunk_plans" USING btree ("workspace_id" text_ops,"harness_slug" text_ops,"status" text_ops) WHERE (status = ANY (ARRAY['in_progress'::text, 'failing'::text, 'escalated'::text]));--> statement-breakpoint
CREATE INDEX "harness_proposals_shared_slug_ts_idx" ON "harness_shared"."harness_proposals_shared" USING btree ("harness_slug" int8_ops,"ts" text_ops);--> statement-breakpoint
CREATE INDEX "harness_proposals_shared_status_idx" ON "harness_shared"."harness_proposals_shared" USING btree ("harness_slug" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "harness_proposals_shared_workspace_idx" ON "harness_shared"."harness_proposals_shared" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE INDEX "arc_feature_idx" ON "harness_shared"."agent_runs_consolidated" USING btree ("harness_slug" text_ops,"feature_id" text_ops);--> statement-breakpoint
CREATE INDEX "arc_role_idx" ON "harness_shared"."agent_runs_consolidated" USING btree ("harness_slug" text_ops,"role" text_ops);--> statement-breakpoint
CREATE INDEX "arc_running_idx" ON "harness_shared"."agent_runs_consolidated" USING btree ("harness_slug" text_ops,"running" text_ops) WHERE (running = true);--> statement-breakpoint
CREATE INDEX "arc_ts_idx" ON "harness_shared"."agent_runs_consolidated" USING btree ("harness_slug" int8_ops,"ts" int8_ops);--> statement-breakpoint
CREATE INDEX "hic_found_during_idx" ON "harness_shared"."harness_issues_consolidated" USING btree ("found_during" text_ops);--> statement-breakpoint
CREATE INDEX "hic_linked_idx" ON "harness_shared"."harness_issues_consolidated" USING btree ("linked_feature_id" text_ops);--> statement-breakpoint
CREATE INDEX "hic_severity_idx" ON "harness_shared"."harness_issues_consolidated" USING btree ("harness_slug" text_ops,"severity" text_ops);--> statement-breakpoint
CREATE INDEX "hic_status_idx" ON "harness_shared"."harness_issues_consolidated" USING btree ("harness_slug" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "sf_snapshot_idx" ON "harness_shared"."snapshot_features" USING btree ("harness_slug" text_ops,"snapshot_id" text_ops);--> statement-breakpoint
CREATE INDEX "hfc_design_status_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("harness_slug" text_ops,"design_status" text_ops) WHERE (design_status IS NOT NULL);--> statement-breakpoint
CREATE INDEX "hfc_needs_design_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("harness_slug" bool_ops,"needs_design" bool_ops) WHERE (needs_design = true);--> statement-breakpoint
CREATE INDEX "hfc_review_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("needs_human_review" bool_ops);--> statement-breakpoint
CREATE INDEX "hfc_search_idx" ON "harness_shared"."harness_features_consolidated" USING gin ("_search" tsvector_ops);--> statement-breakpoint
CREATE INDEX "hfc_see_also_gin" ON "harness_shared"."harness_features_consolidated" USING gin ("see_also" array_ops);--> statement-breakpoint
CREATE INDEX "hfc_slug_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("harness_slug" text_ops);--> statement-breakpoint
CREATE INDEX "hfc_status_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "hfc_updated_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("updated_ts" int8_ops);--> statement-breakpoint
CREATE INDEX "hfc_workspace_idx" ON "harness_shared"."harness_features_consolidated" USING btree ("workspace_id" text_ops);--> statement-breakpoint
CREATE VIEW "harness_shared"."tool_invocations_spawn_tree" AS (WITH RECURSIVE chain AS ( SELECT tool_invocations.id, tool_invocations.workspace_id, tool_invocations.harness_slug, tool_invocations.plugin_name, tool_invocations.tool_name, tool_invocations.role, tool_invocations.feature_id, tool_invocations.chunk_id, tool_invocations.run_id, tool_invocations.spawn_id, tool_invocations.parent_spawn_id, tool_invocations.window_key, tool_invocations.invoked_at, tool_invocations.duration_ms, tool_invocations.status, tool_invocations.output_ref, tool_invocations.output_size, tool_invocations.error_message, 0 AS depth, tool_invocations.spawn_id AS root_spawn_id FROM harness_shared.tool_invocations WHERE tool_invocations.parent_spawn_id IS NULL OR tool_invocations.parent_spawn_id = ''::text UNION ALL SELECT t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role, t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id, t.window_key, t.invoked_at, t.duration_ms, t.status, t.output_ref, t.output_size, t.error_message, c.depth + 1, c.root_spawn_id FROM harness_shared.tool_invocations t JOIN chain c ON t.parent_spawn_id = c.spawn_id AND t.workspace_id = c.workspace_id AND c.depth < 16 ) SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, parent_spawn_id, window_key, invoked_at, duration_ms, status, output_ref, output_size, error_message, depth, root_spawn_id FROM chain);--> statement-breakpoint
CREATE VIEW "harness_shared"."tool_invocations_artifacts" AS (SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, invoked_at, duration_ms, status, output_ref, output_size FROM harness_shared.tool_invocations WHERE output_ref IS NOT NULL AND output_ref <> ''::text AND status = 'ok'::text);--> statement-breakpoint
CREATE VIEW "harness_shared"."operator_decisions" AS (SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor = 'system:operator'::text);--> statement-breakpoint
CREATE VIEW "harness_shared"."system_principal_activity" AS (SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor ~~ 'system:%'::text OR actor ~~ 'pi:%'::text);--> statement-breakpoint
CREATE POLICY "plugin_enables_workspace_isolation" ON "harness_shared"."plugin_enables" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "prompt_compositions_workspace_isolation" ON "harness_shared"."prompt_compositions" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "tool_invocations_workspace_isolation" ON "harness_shared"."tool_invocations" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "spawned_agents_workspace_isolation" ON "harness_shared"."spawned_agents" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "osc_workspace_isolation" ON "harness_shared"."operator_search_provider_credentials" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "mobile_devices_workspace_policy" ON "harness_shared"."mobile_devices" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "plugin_configs_workspace_isolation" ON "harness_shared"."plugin_configs" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "goals_workspace_isolation" ON "harness_shared"."goals" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "pending_events_workspace_isolation" ON "harness_shared"."pending_events" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "routines_workspace_isolation" ON "harness_shared"."routines" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "token_index_workspace_isolation" ON "harness_shared"."token_index" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "audit_log_workspace_isolation" ON "harness_shared"."audit_log" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "project_spec_revisions_workspace_isolation" ON "harness_shared"."project_spec_revisions" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "projects_workspace_isolation" ON "harness_shared"."projects" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "operator_scan_locks_workspace_iso" ON "harness_shared"."operator_scan_locks" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "operator_dismissed_cards_workspace_iso" ON "harness_shared"."operator_dismissed_cards" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "mobile_push_tokens_workspace_policy" ON "harness_shared"."mobile_push_tokens" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM harness_shared.mobile_devices d
  WHERE ((d.device_id = mobile_push_tokens.device_id) AND (d.workspace_id = current_setting('app.workspace_id'::text, true))))));--> statement-breakpoint
CREATE POLICY "system_principals_workspace_isolation" ON "harness_shared"."system_principals" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "pi_sessions_workspace_isolation" ON "harness_shared"."pi_sessions" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "chunk_plans_workspace_isolation" ON "harness_shared"."harness_chunk_plans" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));--> statement-breakpoint
CREATE POLICY "harness_features_consolidated_workspace_isolation" ON "harness_shared"."harness_features_consolidated" AS PERMISSIVE FOR ALL TO public USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
*/