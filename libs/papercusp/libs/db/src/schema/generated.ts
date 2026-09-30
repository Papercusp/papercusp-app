import { type AnyPgColumn, type PgTableExtraConfigValue, bigint, bigserial, boolean, check, customType, date, doublePrecision, foreignKey, index, integer, jsonb, numeric, pgPolicy, pgSchema, pgTable, primaryKey, real, smallint, text, timestamp, unique, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// Custom column types for PG types drizzle-kit can't introspect
// (pull-schema.mjs Fix 4, audit P-075):
const byteaCustom = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tsvectorCustom = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' });

export const harnessShared = pgSchema("harness_shared");

export const papercuspShared = pgSchema("papercusp_shared");

export const hlcPackedSeqInHarnessShared = harnessShared.sequence("hlc_packed_seq", {  startWith: "0", increment: "1", minValue: "0", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const planRunsIdSeqInHarnessShared = harnessShared.sequence("plan_runs_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const workItemSeqInHarnessShared = harnessShared.sequence("work_item_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const adaptiveTelemetryInHarnessShared = harnessShared.table("adaptive_telemetry", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	requestedN: integer("requested_n").notNull(),
	actualN: integer("actual_n").notNull(),
	tierLabel: text("tier_label"),
	availableAtDecision: integer("available_at_decision"),
	maxSlots: integer("max_slots"),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outcomeTs: bigint("outcome_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	workspaceId: text("workspace_id").default('').notNull(),
	synthesized: boolean(),
	synthesisError: text("synthesis_error"),
}, (table) => [
	index("adaptive_telemetry_harness_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("adaptive_telemetry_pending_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(outcome IS NULL)`),
	pgPolicy("adaptive_telemetry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const adjacencyStateInHarnessShared = harnessShared.table("adjacency_state", {
	sessionId: text("session_id").primaryKey().notNull(),
	ownerId: text("owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tick: bigint({ mode: "number" }).default(0).notNull(),
	states: jsonb().default([]).notNull(),
	topics: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("adjacency_state_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId], name: "adjacency_state_pkey"}),

]);

export const admissionRunsInHarnessShared = harnessShared.table("admission_runs", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	runKind: text("run_kind").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	batchSize: integer("batch_size"),
	promoted: integer(),
	merged: integer(),
	held: integer(),
	autoPromotedUnreviewed: integer("auto_promoted_unreviewed"),
	censusBefore: integer("census_before"),
	censusAfter: integer("census_after"),
	modelId: text("model_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }),
	latencyMs: integer("latency_ms"),
	detail: jsonb(),
}, (table) => [
	index("admission_runs_ws_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.runKind.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("admission_runs_run_kind_check", sql`run_kind = ANY (ARRAY['census'::text, 'promoter-tick'::text, 'bulk-stage'::text, 'delta-sweep'::text, 'daily-digest'::text, 'durable-park-audit'::text, 'resolver-whole-corpus'::text])`),
]);

export const advSessionsInHarnessShared = harnessShared.table("adv_sessions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	planSlug: text("plan_slug"),
	mode: text().notNull(),
	terminalBin: text("terminal_bin"),
	pid: integer(),
	windowId: text("window_id"),
	ompThreadId: text("omp_thread_id"),
	label: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	exitCode: integer("exit_code"),
	cwd: text(),
	agent: text(),
	role: text(),
	feature: text(),
	coordOwnerId: text("coord_owner_id"),
	sessionId: text("session_id"),
	display: text(),
	launchArgv: jsonb("launch_argv"),
	launchedAt: timestamp("launched_at", { withTimezone: true, mode: 'string' }),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	portId: uuid("port_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	portSourceAdvSessionId: bigint("port_source_adv_session_id", { mode: "number" }),
	portStatus: text("port_status"),
	portMetadata: jsonb("port_metadata"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedBy: text("ended_by"),
	launchSpec: jsonb("launch_spec"),
	endedSignal: text("ended_signal"),
	shutdownAcceptedAt: timestamp("shutdown_accepted_at", { withTimezone: true, mode: 'string' }),
	resumeClaimKey: text("resume_claim_key"),
	resumeClaimedAt: timestamp("resume_claimed_at", { withTimezone: true, mode: 'string' }),
	suAgentChatId: text("su_agent_chat_id"),
	suSessionDescriptor: jsonb("su_session_descriptor"),
	suSessionState: text("su_session_state"),
	suRuntimeGeneration: integer("su_runtime_generation").default(0).notNull(),
	suSessionUpdatedAt: timestamp("su_session_updated_at", { withTimezone: true, mode: 'string' }),
	launchParentOwner: text("launch_parent_owner").generatedAlwaysAs(sql`NULLIF((launch_spec ->> 'launchedBy'::text), ''::text)`),
	suClientLeaseUntil: timestamp("su_client_lease_until", { withTimezone: true, mode: 'string' }),
	suClientDetachedAt: timestamp("su_client_detached_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("adv_sessions_coord_owner_first_seen_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops"), table.firstSeenAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(coord_owner_id IS NOT NULL)`),
	index("adv_sessions_coord_owner_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops")).where(sql`(coord_owner_id IS NOT NULL)`),
	index("adv_sessions_ended_unarchived_idx").using("btree", table.endedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((ended_at IS NOT NULL) AND (archived_at IS NULL))`),
	index("adv_sessions_observer_ended_idx").using("btree", table.endedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((ended_at IS NOT NULL) AND ((ended_by IS NULL) OR (ended_by <> ALL (ARRAY['self'::text, 'signal'::text]))))`),
	index("adv_sessions_pending_workbench_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((display = 'workbench'::text) AND (launched_at IS NULL) AND (ended_at IS NULL))`),
	index("adv_sessions_plan_idx").using("btree", table.planSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(plan_slug IS NOT NULL)`),
	index("adv_sessions_port_source_idx").using("btree", table.portSourceAdvSessionId.asc().nullsLast().op("int8_ops")).where(sql`(port_source_adv_session_id IS NOT NULL)`),
	index("adv_sessions_resume_reservation_idx").using("btree", table.resumeClaimedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(resume_claim_key IS NOT NULL)`),
	index("adv_sessions_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("adv_sessions_shutdown_accepted_owner_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((ended_at IS NULL) AND (shutdown_accepted_at IS NOT NULL))`),
	index("adv_sessions_signal_ended_idx").using("btree", table.endedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(ended_by = 'signal'::text)`),
	index("adv_sessions_su_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.suSessionState.asc().nullsLast().op("text_ops"), table.suSessionUpdatedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((su_agent_chat_id IS NOT NULL) AND (ended_at IS NULL))`),
	uniqueIndex("adv_sessions_su_agent_chat_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.suAgentChatId.asc().nullsLast().op("text_ops")).where(sql`(su_agent_chat_id IS NOT NULL)`),
	index("adv_sessions_workspace_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(ended_at IS NULL)`),
	index("adv_sessions_workspace_first_seen_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firstSeenAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("int8_ops")),
	index("adv_sessions_workspace_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("adv_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("adv_sessions_ended_by_check", sql`(ended_by IS NULL) OR (ended_by = ANY (ARRAY['self'::text, 'signal'::text, 'reaper'::text, 'reconciler'::text, 'cleanup'::text]))`),
	check("adv_sessions_ended_signal_check", sql`(ended_signal IS NULL) OR (ended_by = 'signal'::text)`),
	check("adv_sessions_mode_check", sql`mode = ANY (ARRAY['omp'::text, 'console'::text])`),
	check("adv_sessions_su_session_state_check", sql`(su_session_state IS NULL) OR (su_session_state = ANY (ARRAY['starting'::text, 'ready'::text, 'running'::text, 'waiting-for-owner'::text, 'resuming'::text, 'compacting'::text, 'interrupted'::text, 'ended'::text, 'failed'::text]))`),
]);

export const agentActionsInHarnessShared = harnessShared.table("agent_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	agent: text().notNull(),
	commandId: text("command_id").notNull(),
	args: jsonb().default({}).notNull(),
	status: text().notNull(),
	errorCode: text("error_code"),
	durationMs: integer("duration_ms"),
	sessionId: text("session_id"),
	requestId: text("request_id"),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("agent_actions_agent_ts_idx").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_actions_id_ts_idx").using("btree", table.commandId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_actions_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const agentActivityInHarnessShared = harnessShared.table("agent_activity", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").default('*').notNull(),
	ownerId: text("owner_id").notNull(),
	agent: text(),
	sessionId: text("session_id"),
	harnessSlug: text("harness_slug"),
	kind: text().notNull(),
	toolName: text("tool_name"),
	phase: text(),
	toolUseId: text("tool_use_id"),
	summary: text(),
	status: text(),
	detail: jsonb(),
	cwd: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_activity_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("agent_activity_harness_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("agent_activity_owner_id_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("agent_activity_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("agent_activity_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
]);

export const agentChatLocksInHarnessShared = harnessShared.table("agent_chat_locks", {
	chatId: text("chat_id").primaryKey().notNull(),
	workspaceId: text("workspace_id"),
	token: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_agent_chat_locks_started_at").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.chatId], name: "agent_chat_locks_pkey"}),

]);

export const agentChatsConsolidatedInHarnessShared = harnessShared.table("agent_chats_consolidated", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	id: text().notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	title: text(),
	transcript: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalInputTokens: bigint("total_input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCostUsdCents: bigint("total_cost_usd_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	archivedAt: bigint("archived_at", { mode: "number" }),
	suRuntimeClass: text("su_runtime_class"),
	continuedFromChatId: text("continued_from_chat_id"),
	continuedFromTurnCount: integer("continued_from_turn_count"),
}, (table) => [
	index("agent_chats_consolidated_continued_from_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.continuedFromChatId.asc().nullsLast().op("text_ops")).where(sql`(continued_from_chat_id IS NOT NULL)`),
	index("agent_chats_consolidated_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id, table.workspaceId], name: "agent_chats_consolidated_pkey"}),
	pgPolicy("agent_chats_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("agent_chats_consolidated_su_runtime_class_chk", sql`(su_runtime_class IS NULL) OR (su_runtime_class = ANY (ARRAY['su-session'::text, 'legacy-owned-loop'::text]))`),
]);

export const agentCouplingsInHarnessShared = harnessShared.table("agent_couplings", {
	workspaceId: text("workspace_id").notNull(),
	agentA: text("agent_a").notNull(),
	agentB: text("agent_b").notNull(),
	state: text().default('coupled').notNull(),
	declaredBy: text("declared_by").notNull(),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	relation: text(),
}, (table) => [
	index("agent_couplings_by_a").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.agentA.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("agent_couplings_by_b").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.agentB.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.agentA, table.agentB, table.workspaceId], name: "agent_couplings_pkey"}),
	check("agent_couplings_pair_normalized", sql`agent_a < agent_b`),
	check("agent_couplings_reason_len", sql`(reason IS NULL) OR (char_length(reason) <= 500)`),
	check("agent_couplings_state_check", sql`state = ANY (ARRAY['coupled'::text, 'suppressed'::text])`),
]);

export const agentDisplayNamesInHarnessShared = harnessShared.table("agent_display_names", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	displayName: text("display_name").notNull(),
	setBy: text("set_by"),
	setAt: timestamp("set_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.ownerId, table.workspaceId], name: "agent_display_names_pkey"}),
	check("agent_display_names_display_name_nonempty", sql`length(btrim(display_name)) > 0`),
]);

export const agentFactsInHarnessShared = harnessShared.table("agent_facts", {
	workspaceId: text("workspace_id").notNull(),
	scope: text().notNull(),
	scopeRef: text("scope_ref"),
	key: text().notNull(),
	body: text().notNull(),
	sourceRef: text("source_ref"),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	retractedAt: timestamp("retracted_at", { withTimezone: true, mode: 'string' }),
	shareable: boolean().default(false).notNull(),
	harnessSlug: text("harness_slug"),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	sourceHive: text("source_hive"),
	fedKey: text("fed_key").generatedAlwaysAs(sql`((((scope || '/'::text) || COALESCE(scope_ref, ''::text)) || '/'::text) || key)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_facts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	audienceScope: text("audience_scope"),
	sourceProvenance: jsonb("source_provenance"),
	confidence: text(),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	supersedesId: bigint("supersedes_id", { mode: "number" }),
	dependsOn: jsonb("depends_on"),
	kind: text(),
	claim: jsonb(),
	enforcement: jsonb(),
	fedHlc: text("fed_hlc"),
	evictedAt: timestamp("evicted_at", { withTimezone: true, mode: 'string' }),
	settledBy: text("settled_by"),
	measurement: jsonb(),
	retractedBy: text("retracted_by"),
	retractionReason: text("retraction_reason"),
	recheck: jsonb(),
}, (table) => [
	index("agent_facts_fold").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.scopeRef.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((retracted_at IS NULL) AND (superseded_at IS NULL))`),
	uniqueIndex("agent_facts_identity_current").using("btree", sql`workspace_id`, sql`scope`, sql`COALESCE(scope_ref, ''::text)`, sql`key`, sql`COALESCE(source_hive, ''::text)`).where(sql`(superseded_at IS NULL)`),
	index("agent_facts_kind").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.scopeRef.asc().nullsLast().op("text_ops")).where(sql`((kind IS NOT NULL) AND (retracted_at IS NULL) AND (superseded_at IS NULL))`),
	index("agent_facts_recheck_exec").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`((recheck ? 'exec'::text) AND (retracted_at IS NULL) AND (superseded_at IS NULL))`),
	index("agent_facts_shareable").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((shareable = true) AND (retracted_at IS NULL) AND (superseded_at IS NULL))`),
	index("agent_facts_version_chain").using("btree", sql`workspace_id`, sql`scope`, sql`COALESCE(scope_ref, ''::text)`, sql`key`, sql`superseded_at`),
	pgPolicy("agent_facts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("agent_facts_body_check", sql`char_length(body) <= 1200`),
	check("agent_facts_check", sql`(scope = 'workspace'::text) OR (scope_ref IS NOT NULL)`),
	check("agent_facts_confidence_check", sql`(confidence IS NULL) OR (confidence = ANY (ARRAY['verified'::text, 'provisional'::text, 'suspected'::text]))`),
	check("agent_facts_enforcement_tier_check", sql`(enforcement IS NULL) OR ((enforcement ->> 'tier'::text) = ANY (ARRAY['structural'::text, 'gate'::text, 'detector'::text]))`),
	check("agent_facts_kind_check", sql`(kind IS NULL) OR (kind = ANY (ARRAY['conclusion'::text, 'assumption'::text, 'convention'::text, 'undecidable'::text]))`),
	check("agent_facts_recheck_contract_check", sql`(recheck IS NULL) OR (((jsonb_typeof(recheck) = 'object'::text) AND (recheck ?& ARRAY['probe'::text, 'falsifier'::text]) AND (jsonb_typeof((recheck -> 'probe'::text)) = 'string'::text) AND ((char_length(btrim((recheck ->> 'probe'::text))) >= 1) AND (char_length(btrim((recheck ->> 'probe'::text))) <= 500)) AND (jsonb_typeof((recheck -> 'falsifier'::text)) = 'string'::text) AND ((char_length(btrim((recheck ->> 'falsifier'::text))) >= 1) AND (char_length(btrim((recheck ->> 'falsifier'::text))) <= 500)) AND ((((recheck - 'probe'::text) - 'falsifier'::text) - 'exec'::text) = '{}'::jsonb) AND ((NOT (recheck ? 'exec'::text)) OR ((jsonb_typeof((recheck -> 'exec'::text)) = 'object'::text) AND (jsonb_typeof(((recheck -> 'exec'::text) -> 'command'::text)) = 'string'::text) AND ((char_length(btrim(((recheck -> 'exec'::text) ->> 'command'::text))) >= 1) AND (char_length(btrim(((recheck -> 'exec'::text) ->> 'command'::text))) <= 500)) AND (jsonb_typeof(((recheck -> 'exec'::text) -> 'expectExitCode'::text)) = 'number'::text) AND (jsonb_typeof(((recheck -> 'exec'::text) -> 'scope'::text)) = 'array'::text) AND ((jsonb_array_length(((recheck -> 'exec'::text) -> 'scope'::text)) >= 1) AND (jsonb_array_length(((recheck -> 'exec'::text) -> 'scope'::text)) <= 8))))) IS TRUE)`),
	check("agent_facts_scope_check", sql`scope = ANY (ARRAY['workspace'::text, 'role'::text, 'owner'::text, 'harness'::text, 'work_item'::text])`),
]);

export const agentFleetsInHarnessShared = harnessShared.table("agent_fleets", {
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	title: text(),
	description: text(),
	owner: text(),
	leaderOwnerId: text("leader_owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	colorScheme: text("color_scheme"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastLaunchAt: bigint("last_launch_at", { mode: "number" }),
	lastLaunchCount: integer("last_launch_count"),
	controlState: text("control_state").default('active').notNull(),
	controlReason: text("control_reason"),
	controlBy: text("control_by"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlAt: bigint("control_at", { mode: "number" }),
	headcountTarget: integer("headcount_target"),
	headcountConfig: jsonb("headcount_config"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	headcountNextAttemptAt: bigint("headcount_next_attempt_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	headcountBackoffMs: bigint("headcount_backoff_ms", { mode: "number" }).default(0).notNull(),
	headcountLastError: text("headcount_last_error"),
	lastLaunchTransaction: jsonb("last_launch_transaction"),
	fleetType: text("fleet_type").default('single').notNull(),
	controlResumeGate: text("control_resume_gate"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlExpiresAt: bigint("control_expires_at", { mode: "number" }),
	controlNoResumePath: boolean("control_no_resume_path").default(false).notNull(),
}, (table) => [
	primaryKey({ columns: [table.fleetSlug, table.workspaceId], name: "agent_fleets_pkey"}),
	pgPolicy("agent_fleets_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("agent_fleets_headcount_target_positive", sql`(headcount_target IS NULL) OR ((headcount_target >= 1) AND (headcount_target <= 64))`),
]);

export const agentLaunchIdempotencyInHarnessShared = harnessShared.table("agent_launch_idempotency", {
	workspaceId: text("workspace_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	launchedAt: bigint("launched_at", { mode: "number" }).notNull(),
	launchedBy: text("launched_by"),
	summary: jsonb().default({}).notNull(),
}, (table) => [
	index("agent_launch_idempotency_launched_at_idx").using("btree", table.launchedAt.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.idempotencyKey, table.workspaceId], name: "agent_launch_idempotency_pkey"}),
]);

export const agentLoopApprovalsInHarnessShared = harnessShared.table("agent_loop_approvals", {
	chatId: text("chat_id").notNull(),
	callId: text("call_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	toolName: text("tool_name").notNull(),
	toolInput: jsonb("tool_input").default(null).notNull(),
	stepIndex: integer("step_index").default(0).notNull(),
	status: text().default('pending').notNull(),
	reason: text(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: text("resolved_by"),
}, (table) => [
	index("idx_agent_loop_approvals_pending").using("btree", table.chatId.asc().nullsLast().op("text_ops"), table.requestedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	primaryKey({ columns: [table.callId, table.chatId], name: "agent_loop_approvals_pkey"}),
	check("agent_loop_approvals_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])`),
]);

export const agentLoopSessionsInHarnessShared = harnessShared.table("agent_loop_sessions", {
	workspaceId: text("workspace_id").notNull(),
	chatId: text("chat_id").notNull(),
	messages: jsonb().default([]).notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	summary: text(),
	compactedCount: integer("compacted_count").default(0).notNull(),
	transcriptTurns: integer("transcript_turns").default(0).notNull(),
	model: text(),
	turnCount: integer("turn_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalInputTokens: bigint("total_input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCacheReadTokens: bigint("total_cache_read_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCacheCreationTokens: bigint("total_cache_creation_tokens", { mode: "number" }).default(0).notNull(),
	totalCostUsd: numeric("total_cost_usd", { precision: 14, scale:  6 }).default('0').notNull(),
	unpricedTurnCount: integer("unpriced_turn_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_agent_loop_sessions_updated").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.chatId, table.workspaceId], name: "agent_loop_sessions_pkey"}),
]);

export const agentModeChangesInHarnessShared = harnessShared.table("agent_mode_changes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_mode_changes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	axisKey: text("axis_key").notNull(),
	oldMode: text("old_mode"),
	newMode: text("new_mode"),
	reason: text().default('').notNull(),
	setBy: text("set_by").notNull(),
	ownerDirected: boolean("owner_directed").default(false).notNull(),
	changedAt: timestamp("changed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_mode_changes_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.changedAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const agentModesInHarnessShared = harnessShared.table("agent_modes", {
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	axisKey: text("axis_key").notNull(),
	mode: text().notNull(),
	reason: text().default('').notNull(),
	setBy: text("set_by").notNull(),
	ownerDirected: boolean("owner_directed").default(false).notNull(),
	setAt: timestamp("set_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	subject: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	goalLeaseEpoch: bigint("goal_lease_epoch", { mode: "number" }),
	goalHandoffFromOwnerId: text("goal_handoff_from_owner_id"),
	goalHandoffExpiresAt: timestamp("goal_handoff_expires_at", { withTimezone: true, mode: 'string' }),
	impliedBy: jsonb("implied_by"),
}, (table) => [
	index("agent_modes_goal_election_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subject.asc().nullsLast().op("text_ops"), table.goalLeaseEpoch.desc().nullsFirst().op("int8_ops")).where(sql`((mode = 'goal'::text) AND (subject IS NOT NULL))`),
	index("agent_modes_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.axisKey, table.ownerId, table.workspaceId], name: "agent_modes_pkey"}),
]);

export const agentNameSessionsInHarnessShared = harnessShared.table("agent_name_sessions", {
	workspaceId: text("workspace_id").notNull(),
	sessionOwnerId: text("session_owner_id").notNull(),
	agentName: text("agent_name").notNull(),
	ownerUser: text("owner_user").notNull(),
	adoptedAt: timestamp("adopted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_name_sessions_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.agentName.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.sessionOwnerId, table.workspaceId], name: "agent_name_sessions_pkey"}),
	check("agent_name_sessions_name_nonempty", sql`agent_name <> ''::text`),
]);

export const agentNamesInHarnessShared = harnessShared.table("agent_names", {
	workspaceId: text("workspace_id").notNull(),
	agentName: text("agent_name").notNull(),
	ownerUser: text("owner_user").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_names_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerUser.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.agentName, table.workspaceId], name: "agent_names_pkey"}),
	check("agent_names_name_nonempty", sql`agent_name <> ''::text`),
	check("agent_names_owner_nonempty", sql`owner_user <> ''::text`),
]);

export const agentPlaneMeasurementsInHarnessShared = harnessShared.table("agent_plane_measurements", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").default('').notNull(),
	measuredAt: timestamp("measured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	windowEnd: timestamp("window_end", { withTimezone: true, mode: 'string' }).notNull(),
	metrics: jsonb().notNull(),
	interpretableCount: integer("interpretable_count").default(0).notNull(),
	metricCount: integer("metric_count").default(0).notNull(),
	summary: text().default('').notNull(),
	producerVersion: integer("producer_version").default(1).notNull(),
}, (table) => [
	index("agent_plane_measurements_series_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.measuredAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const agentQueriesInHarnessShared = harnessShared.table("agent_queries", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	agent: text().notNull(),
	queryId: text("query_id").notNull(),
	argsCompact: jsonb("args_compact"),
	requestId: text("request_id"),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("agent_queries_agent_id_ts").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.queryId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_queries_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const agentRateBudgetInHarnessShared = harnessShared.table("agent_rate_budget", {
	bucketKey: text("bucket_key").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	windowStart: bigint("window_start", { mode: "number" }).default(0).notNull(),
	reqInWindow: integer("req_in_window").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inTokInWindow: bigint("in_tok_in_window", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outTokInWindow: bigint("out_tok_in_window", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	pausedUntil: bigint("paused_until", { mode: "number" }).default(0).notNull(),
	paceDelayMs: integer("pace_delay_ms").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastAcquireAt: bigint("last_acquire_at", { mode: "number" }).default(0).notNull(),
	limits: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	rpmFactor: doublePrecision("rpm_factor"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rpmFactorAt: bigint("rpm_factor_at", { mode: "number" }),
}, (table) => [
	primaryKey({ columns: [table.bucketKey], name: "agent_rate_budget_pkey"}),
]);

export const agentRunsConsolidatedInHarnessShared = harnessShared.table("agent_runs_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }).default(0).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).default(0).notNull(),
	running: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEventTs: bigint("last_event_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").notNull(),
	backend: text(),
	model: text(),
	costIsEstimate: boolean("cost_is_estimate").default(false).notNull(),
}, (table) => [
	index("arc_feature_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("arc_role_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops")),
	index("arc_running_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.running.asc().nullsLast().op("bool_ops")).where(sql`(running = true)`),
	index("arc_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("arc_workspace_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.runId], name: "agent_runs_consolidated_pkey"}),
]);

export const agentSeatConsumptionsInHarnessShared = harnessShared.table("agent_seat_consumptions", {
	ownerId: text("owner_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	seatRef: text("seat_ref").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_seat_consumptions_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.seatRef.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.ownerId], name: "agent_seat_consumptions_pkey"}),

]);

export const agentUsageSamplesInHarnessShared = harnessShared.table("agent_usage_samples", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_usage_samples_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	bucketKey: text("bucket_key").notNull(),
	provider: text().notNull(),
	modelClass: text("model_class").notNull(),
	source: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
	costUsd: doublePrecision("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsLimit: bigint("rl_requests_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsRemaining: bigint("rl_requests_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensLimit: bigint("rl_tokens_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensRemaining: bigint("rl_tokens_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlResetAt: bigint("rl_reset_at", { mode: "number" }),
	model: text(),
	costSource: text("cost_source"),
	harnessSlug: text("harness_slug"),
	runId: text("run_id"),
	role: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }),
	turnCount: integer("turn_count"),
	sessionId: text("session_id"),
	toolName: text("tool_name"),
	turnTrigger: text("turn_trigger"),
	accountId: text("account_id"),
	goalId: text("goal_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreation5MTokens: bigint("cache_creation_5m_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreation1HTokens: bigint("cache_creation_1h_tokens", { mode: "number" }),
	usageEventKey: text("usage_event_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventTs: bigint("event_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ingestedAt: bigint("ingested_at", { mode: "number" }),
	usageProvenance: jsonb("usage_provenance"),
}, (table) => [
	index("agent_usage_samples_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("agent_usage_samples_ws_account_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(account_id IS NOT NULL)`),
	index("agent_usage_samples_ws_bucket_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.bucketKey.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	uniqueIndex("agent_usage_samples_ws_event_key_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.usageEventKey.asc().nullsLast().op("text_ops")).where(sql`(usage_event_key IS NOT NULL)`),
	index("agent_usage_samples_ws_goal_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(goal_id IS NOT NULL)`),
	index("agent_usage_samples_ws_role_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(role IS NOT NULL)`),
	index("agent_usage_samples_ws_session_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(session_id IS NOT NULL)`),
	index("agent_usage_samples_ws_trigger_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.turnTrigger.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(turn_trigger IS NOT NULL)`),
	index("agent_usage_samples_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	pgPolicy("agent_usage_samples_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const appOwnerMappingsInHarnessShared = harnessShared.table("app_owner_mappings", {
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	app: text().notNull(),
	ownerId: text("owner_id").notNull(),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "app_owner_mappings_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.app, table.userId, table.workspaceId], name: "app_owner_mappings_pkey"}),
	unique("app_owner_mappings_owner_unique").on(table.app, table.ownerId, table.workspaceId),
	check("app_owner_mappings_app_check", sql`app ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text`),
	check("app_owner_mappings_owner_id_check", sql`length(btrim(owner_id)) > 0`),
]);

export const attentionBulkRunItemsInHarnessShared = harnessShared.table("attention_bulk_run_items", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	itemId: text("item_id").notNull(),
	position: integer().default(0).notNull(),
	itemKind: text("item_kind"),
	itemTitle: text("item_title"),
	itemRef: jsonb("item_ref").default({}).notNull(),
	ownerAgentId: text("owner_agent_id"),
	outcome: text().default('pending').notNull(),
	actionId: text("action_id"),
	rationale: text(),
	draftAnswer: text("draft_answer"),
	confidence: text(),
	consulted: boolean().default(false).notNull(),
	consultReply: text("consult_reply"),
	error: text(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	disposition: text(),
	recommendationKind: text("recommendation_kind"),
	recommendationLabel: text("recommendation_label"),
	recommendationRationale: text("recommendation_rationale"),
	evidenceBasis: jsonb("evidence_basis").default([]).notNull(),
	responsibility: text(),
	confidenceLevel: text("confidence_level"),
	retryCondition: text("retry_condition"),
	revertHandle: jsonb("revert_handle"),
	reversalWindowUntil: timestamp("reversal_window_until", { withTimezone: true, mode: 'string' }),
	revertedAt: timestamp("reverted_at", { withTimezone: true, mode: 'string' }),
	revertNote: text("revert_note"),
}, (table) => [
	index("attention_bulk_run_items_disposition_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.disposition.asc().nullsLast().op("text_ops")),
	index("attention_bulk_run_items_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.itemId.asc().nullsLast().op("text_ops")),
	index("attention_bulk_run_items_open_reversal_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.reversalWindowUntil.asc().nullsLast().op("timestamptz_ops"), table.runId.asc().nullsLast().op("text_ops"), table.position.asc().nullsLast().op("int4_ops")).where(sql`((outcome = 'auto_resolved'::text) AND (reverted_at IS NULL))`),
	index("attention_bulk_run_items_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.position.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.itemId, table.runId, table.workspaceId], name: "attention_bulk_run_items_pkey"}),
	pgPolicy("attention_bulk_run_items_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("attention_bulk_run_items_confidence_check", sql`(confidence IS NULL) OR (confidence = ANY (ARRAY['low'::text, 'high'::text]))`),
	check("attention_bulk_run_items_confidence_level_check", sql`(confidence_level IS NULL) OR (confidence_level = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'insufficient'::text]))`),
	check("attention_bulk_run_items_disposition_check", sql`(disposition IS NULL) OR (disposition = ANY (ARRAY['pending'::text, 'auto_resolved'::text, 'recommended'::text, 'owner_action'::text, 'cleanup_candidate'::text, 'retry_needed'::text, 'routed'::text, 'investigate'::text, 'failed'::text, 'dismissed'::text, 'legacy_skipped'::text]))`),
	check("attention_bulk_run_items_outcome_check", sql`outcome = ANY (ARRAY['pending'::text, 'auto_resolved'::text, 'recommended'::text, 'skipped'::text, 'failed'::text, 'dismissed'::text])`),
	check("attention_bulk_run_items_recommendation_kind_check", sql`(recommendation_kind IS NULL) OR (recommendation_kind = ANY (ARRAY['owner_action'::text, 'cleanup_candidate'::text, 'retry_needed'::text, 'routed'::text, 'investigate'::text]))`),
	check("attention_bulk_run_items_responsibility_check", sql`(responsibility IS NULL) OR (responsibility = ANY (ARRAY['owner'::text, 'agent'::text, 'system'::text, 'engineering'::text, 'unknown'::text]))`),
]);

export const attentionBulkRunsInHarnessShared = harnessShared.table("attention_bulk_runs", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	harnessSlug: text("harness_slug"),
	requestedBy: text("requested_by"),
	resolverOwner: text("resolver_owner"),
	phase: text().default('pending').notNull(),
	filterSnapshot: jsonb("filter_snapshot").default({}).notNull(),
	totalItems: integer("total_items").default(0).notNull(),
	autoResolved: integer("auto_resolved").default(0).notNull(),
	recommended: integer().default(0).notNull(),
	skipped: integer().default(0).notNull(),
	failed: integer().default(0).notNull(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	runKind: text("run_kind").default('inbox-resolve').notNull(),
	seedRefs: jsonb("seed_refs").default([]).notNull(),
	launchSnapshot: jsonb("launch_snapshot").default({}).notNull(),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }),
	automationPolicy: jsonb("automation_policy").default({"mode":"safe-high","minConfidence":"high"}).notNull(),
}, (table) => [
	index("attention_bulk_runs_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.phase.asc().nullsLast().op("text_ops")).where(sql`(phase = ANY (ARRAY['pending'::text, 'running'::text, 'review'::text]))`),
	index("attention_bulk_runs_executing_heartbeat_idx").using("btree", table.heartbeatAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(phase = ANY (ARRAY['pending'::text, 'running'::text]))`),
	uniqueIndex("attention_bulk_runs_one_active_per_workspace_kind").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runKind.asc().nullsLast().op("text_ops")).where(sql`(phase = ANY (ARRAY['pending'::text, 'running'::text]))`),
	index("attention_bulk_runs_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.runId, table.workspaceId], name: "attention_bulk_runs_pkey"}),
	pgPolicy("attention_bulk_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("attention_bulk_runs_phase_check", sql`phase = ANY (ARRAY['pending'::text, 'running'::text, 'review'::text, 'complete'::text, 'failed'::text])`),
	check("attention_bulk_runs_run_kind_check", sql`run_kind = ANY (ARRAY['inbox-resolve'::text, 'plan-cleanup'::text])`),
]);

export const attentionNotificationsInHarnessShared = harnessShared.table("attention_notifications", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.attention_notifications_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug"),
	kind: text().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	importance: text(),
	data: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	mobileAttempted: boolean("mobile_attempted").default(false).notNull(),
	mobileSucceeded: boolean("mobile_succeeded"),
	mobileError: text("mobile_error"),
	mobileCompletedAt: timestamp("mobile_completed_at", { withTimezone: true, mode: 'string' }),
	desktopAttempted: boolean("desktop_attempted").default(false).notNull(),
	desktopSucceeded: boolean("desktop_succeeded"),
	desktopError: text("desktop_error"),
	desktopCompletedAt: timestamp("desktop_completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("attention_notifications_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("attention_notifications_workspace_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("attention_notifications_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const attentionTriageInHarnessShared = harnessShared.table("attention_triage", {
	workspaceId: text("workspace_id").notNull(),
	itemId: text("item_id").notNull(),
	action: text().notNull(),
	note: text(),
	triagedBy: text("triaged_by"),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.itemId, table.workspaceId], name: "attention_triage_pkey"}),
	pgPolicy("attention_triage_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("attention_triage_action_check", sql`action = ANY (ARRAY['confirm'::text, 'escalate'::text, 'downgrade'::text, 'resolve'::text])`),
]);

export const auditLogInHarnessShared = harnessShared.table("audit_log", {
	id: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	actor: text().default('user').notNull(),
	action: text().notNull(),
	subject: text().notNull(),
	details: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('simple'::regconfig, COALESCE(subject, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(action, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(actor, ''::text)), 'C'::"char"))`),
}, (table) => [
	index("audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("audit_actor_action_ts_idx").using("btree", table.actor.asc().nullsLast().op("text_ops"), table.action.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("audit_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("audit_subject_ts_idx").using("btree", table.subject.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("audit_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	index("audit_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("audit_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const authAuditLogInHarnessShared = harnessShared.table("auth_audit_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	username: text(),
	ip: text(),
	userAgent: text("user_agent"),
	ok: boolean().notNull(),
	errorCode: text("error_code"),
	sessionHmac: text("session_hmac"),
	metadata: jsonb(),
}, (table) => [
	index("auth_audit_log_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("auth_audit_log_username_idx").using("btree", table.username.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id], name: "auth_audit_log_pkey"}),

]);

export const authRateLimitInHarnessShared = harnessShared.table("auth_rate_limit", {
	key: text().primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("auth_rate_limit_updated_at_idx").using("btree", table.updatedAt.asc().nullsLast().op("int8_ops")),
]);

export const autoReviewAuditInHarnessShared = harnessShared.table("auto_review_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	prNumber: integer("pr_number").notNull(),
	prUrl: text("pr_url"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubId: bigint("author_github_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reviewerGithubId: bigint("reviewer_github_id", { mode: "number" }).notNull(),
	action: text().notNull(),
	detail: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("auto_review_audit_pr_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.prNumber.asc().nullsLast().op("int4_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "auto_review_audit_pkey"}),
	pgPolicy("auto_review_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("auto_review_audit_action_check", sql`action = ANY (ARRAY['auto_approve'::text, 'auto_merge'::text, 'manual_approve'::text, 'manual_merge'::text, 'skipped_untrusted'::text, 'skipped_checks_failing'::text, 'error'::text, 'agent_review'::text, 'agent_review_error'::text])`),
]);

export const autoloopStateInHarnessShared = harnessShared.table("autoloop_state", {
	harnessSlug: text("harness_slug").notNull(),
	role: text().default('director').notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastStatus: text("last_status"),
	consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	lastWithheldAt: timestamp("last_withheld_at", { withTimezone: true, mode: 'string' }),
	lastWithheldReason: text("last_withheld_reason"),
	lastWithheldDetail: text("last_withheld_detail"),
}, (table) => [
	uniqueIndex("autoloop_state_owner_role_uidx").using("btree", table.role.asc().nullsLast().op("text_ops")).where(sql`(role ~~ 'loop-su-%'::text)`),
	primaryKey({ columns: [table.harnessSlug, table.role, table.workspaceId], name: "autoloop_state_pkey"}),
	pgPolicy("autoloop_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const autonomyPolicyInHarnessShared = harnessShared.table("autonomy_policy", {
	workspaceId: text("workspace_id").default('default').notNull(),
	category: text().notNull(),
	ceiling: text().default('never-auto').notNull(),
	locked: boolean().default(false).notNull(),
	graduatedLevel: text("graduated_level").default('never-auto').notNull(),
	thresholdOverrides: jsonb("threshold_overrides").default({}).notNull(),
	ownerOverride: jsonb("owner_override"),
	updatedBy: text("updated_by").default('system').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.category, table.workspaceId], name: "autonomy_policy_pkey"}),
	check("autonomy_policy_ceiling_check", sql`ceiling = ANY (ARRAY['never-auto'::text, 'trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
	check("autonomy_policy_graduated_level_check", sql`graduated_level = ANY (ARRAY['never-auto'::text, 'trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
]);

export const autonomyTripwiresInHarnessShared = harnessShared.table("autonomy_tripwires", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	category: text().notNull(),
	findingClass: text("finding_class").default('unclassified').notNull(),
	action: text(),
	riskTier: text("risk_tier").default('critical').notNull(),
	reversibility: text().default('reversible').notNull(),
	revertHandle: jsonb("revert_handle").notNull(),
	decision: jsonb(),
	status: text().default('armed').notNull(),
	tripReason: text("trip_reason"),
	armedAt: timestamp("armed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	windowUntil: timestamp("window_until", { withTimezone: true, mode: 'string' }).notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	revertedAt: timestamp("reverted_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: text("resolved_by"),
	decisionId: text("decision_id"),
}, (table) => [
	index("autonomy_tripwires_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.findingClass.asc().nullsLast().op("text_ops"), table.armedAt.asc().nullsLast().op("timestamptz_ops")),
	index("autonomy_tripwires_decision_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.decisionId.asc().nullsLast().op("text_ops")).where(sql`(decision_id IS NOT NULL)`),
	index("autonomy_tripwires_sweep_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.windowUntil.asc().nullsLast().op("timestamptz_ops")),
	check("autonomy_tripwires_reversibility_check", sql`reversibility = 'reversible'::text`),
	check("autonomy_tripwires_risk_tier_check", sql`risk_tier = ANY (ARRAY['trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
	check("autonomy_tripwires_status_check", sql`status = ANY (ARRAY['armed'::text, 'cleared'::text, 'tripped'::text, 'reverted'::text])`),
	check("autonomy_tripwires_trip_reason_check", sql`(trip_reason IS NULL) OR (trip_reason = ANY (ARRAY['ekg-drift'::text, 'validator-bounce'::text, 'gym-regression'::text, 'owner-thumbs-down'::text]))`),
]);

export const backupEventsInHarnessShared = harnessShared.table("backup_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotId: bigint("snapshot_id", { mode: "number" }),
	kind: text().notNull(),
	payloadJson: jsonb("payload_json"),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("backup_events_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.snapshotId],
			foreignColumns: [backupSnapshotsInHarnessShared.id],
			name: "backup_events_snapshot_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("backup_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const backupSnapshotsInHarnessShared = harnessShared.table("backup_snapshots", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kopiaSnapshotId: text("kopia_snapshot_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	status: text().default('running').notNull(),
	triggerReason: text("trigger_reason").notNull(),
	triggerContext: jsonb("trigger_context"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesAdded: bigint("bytes_added", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesTotal: bigint("bytes_total", { mode: "number" }),
	sourcesJson: jsonb("sources_json").default([]).notNull(),
	errorText: text("error_text"),
	dbDumpOk: boolean("db_dump_ok"),
}, (table) => [
	index("backup_snapshots_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("backup_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const bashToolSubstitutionFiresInHarnessShared = harnessShared.table("bash_tool_substitution_fires", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rowId: bigint("row_id", { mode: "number" }).notNull(),
	intentLabel: text("intent_label").notNull(),
	toolName: text("tool_name").notNull(),
	sessionId: text("session_id"),
	command: text().notNull(),
	tier: text().notNull(),
	complied: boolean(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bash_tool_substitution_fires_row_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.rowId.asc().nullsLast().op("int8_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("bash_tool_substitution_fires_unresolved_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(resolved_at IS NULL)`),
]);

export const bashToolSubstitutionsInHarnessShared = harnessShared.table("bash_tool_substitutions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	intentLabel: text("intent_label").notNull(),
	bashPattern: text("bash_pattern").notNull(),
	toolName: text("tool_name").notNull(),
	equivalenceVerdict: text("equivalence_verdict").default('unaudited').notNull(),
	sampleSize: integer("sample_size"),
	failingCases: jsonb("failing_cases").default([]).notNull(),
	evidenceRef: text("evidence_ref"),
	tier: text().default('observe').notNull(),
	advisoryText: text("advisory_text"),
	enabled: boolean().default(true).notNull(),
	baselineCalls: integer("baseline_calls"),
	baselineSessions: integer("baseline_sessions"),
	baselineToolCalls: integer("baseline_tool_calls"),
	observedSince: timestamp("observed_since", { withTimezone: true, mode: 'string' }),
	promotedAt: timestamp("promoted_at", { withTimezone: true, mode: 'string' }),
	falsePositiveCount: integer("false_positive_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	bashPatternFlags: text("bash_pattern_flags").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	matchCount: bigint("match_count", { mode: "number" }).default(0).notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("bash_tool_substitutions_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.enabled.asc().nullsLast().op("bool_ops"), table.tier.asc().nullsLast().op("text_ops")).where(sql`enabled`),
	uniqueIndex("bash_tool_substitutions_ws_intent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.intentLabel.asc().nullsLast().op("text_ops")),
	check("bash_tool_substitutions_advisory_required", sql`(tier = 'observe'::text) OR ((advisory_text IS NOT NULL) AND (length(btrim(advisory_text)) >= 20))`),
	check("bash_tool_substitutions_pattern_flags_chk", sql`bash_pattern_flags ~ '^i?m?s?u?$'::text`),
	check("bash_tool_substitutions_tier_chk", sql`tier = ANY (ARRAY['observe'::text, 'advise'::text, 'deny'::text])`),
	check("bash_tool_substitutions_tier_requires_equivalence", sql`(tier = 'observe'::text) OR (equivalence_verdict = 'equivalent'::text) OR (intent_label ~~ 'policy-violation:%'::text)`),
	check("bash_tool_substitutions_verdict_chk", sql`equivalence_verdict = ANY (ARRAY['unaudited'::text, 'equivalent'::text, 'needs-widening'::text, 'not-a-substitute'::text])`),
	check("bash_tool_substitutions_verdict_evidence", sql`(equivalence_verdict = ANY (ARRAY['unaudited'::text, 'equivalent'::text])) OR (jsonb_array_length(failing_cases) > 0)`),
]);

export const behaviorChangeLedgerInHarnessShared = harnessShared.table("behavior_change_ledger", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	source: text().notNull(),
	mutationClass: text("mutation_class").notNull(),
	action: text().notNull(),
	targetKind: text("target_kind").notNull(),
	target: text().notNull(),
	harnessSlug: text("harness_slug"),
	role: text(),
	diffRef: text("diff_ref"),
	actor: text(),
	summary: text(),
	payload: jsonb(),
}, (table) => [
	uniqueIndex("behavior_change_ledger_dedupe_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.source.asc().nullsLast().op("text_ops"), table.diffRef.asc().nullsLast().op("text_ops"), table.target.asc().nullsLast().op("text_ops")),
	index("behavior_change_ledger_ws_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.mutationClass.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("behavior_change_ledger_ws_recorded_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("behavior_change_ledger_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "behavior_change_ledger_pkey"}),

]);

export const benchRunEventsInHarnessShared = harnessShared.table("bench_run_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventId: bigint("event_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.bench_run_events_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	kind: text().notNull(),
	agent: text(),
	taskId: text("task_id"),
	payload: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bench_run_events_ws_run_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.seq.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [benchRunsInHarnessShared.id],
			name: "bench_run_events_run_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("bench_run_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.eventId], name: "bench_run_events_pkey"}),

]);

export const benchRunTasksInHarnessShared = harnessShared.table("bench_run_tasks", {
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	instanceId: text("instance_id").notNull(),
	taskStatus: text("task_status").default('todo').notNull(),
	resolved: boolean(),
	beeId: text("bee_id"),
	disposition: text(),
	stopReason: text("stop_reason"),
	generationError: text("generation_error"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }),
	costUsd: doublePrecision("cost_usd"),
	turns: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }),
	diffBytes: integer("diff_bytes"),
	armMeta: jsonb("arm_meta"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bench_run_tasks_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [benchRunsInHarnessShared.id],
			name: "bench_run_tasks_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.instanceId, table.runId], name: "bench_run_tasks_pkey"}),
	pgPolicy("bench_run_tasks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("bench_run_tasks_task_status_check", sql`task_status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'collected'::text, 'graded'::text, 'error'::text])`),
]);

export const benchRunsInHarnessShared = harnessShared.table("bench_runs", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	arm: text().notNull(),
	taskSetId: text("task_set_id").notNull(),
	suite: text().default('swe-bench-pro').notNull(),
	model: text().notNull(),
	status: text().default('pending').notNull(),
	source: text().default('ui').notNull(),
	summary: jsonb(),
	taskCount: integer("task_count"),
	gradedCount: integer("graded_count"),
	resolvedCount: integer("resolved_count"),
	nonEmptyDiffs: integer("non_empty_diffs"),
	costUsd: doublePrecision("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallMs: bigint("wall_ms", { mode: "number" }),
	peakConcurrentBees: integer("peak_concurrent_bees"),
	recovered: boolean().default(false).notNull(),
	runError: text("run_error"),
	config: jsonb(),
	fleetRunId: text("fleet_run_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	infraExcluded: integer("infra_excluded"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("bench_runs_ws_arm_taskset_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.arm.asc().nullsLast().op("text_ops"), table.taskSetId.asc().nullsLast().op("text_ops")),
	index("bench_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("bench_runs_ws_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	pgPolicy("bench_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("bench_runs_source_check", sql`source = ANY (ARRAY['ui'::text, 'cli'::text, 'import'::text])`),
	check("bench_runs_status_check", sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'grading'::text, 'done'::text, 'error'::text, 'cancelled'::text])`),
]);

export const benchmarkCoordEventInHarnessShared = harnessShared.table("benchmark_coord_event", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventId: bigint("event_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.benchmark_coord_event_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	fleetRunId: text("fleet_run_id").notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	kind: text().notNull(),
	agent: text(),
	taskId: text("task_id"),
	detail: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_coord_event_run_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetRunId.asc().nullsLast().op("text_ops"), table.seq.asc().nullsLast().op("int8_ops")),
	pgPolicy("benchmark_coord_event_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.eventId], name: "benchmark_coord_event_pkey"}),

]);

export const benchmarkFleetRunInHarnessShared = harnessShared.table("benchmark_fleet_run", {
	fleetRunId: text("fleet_run_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	preregHash: text("prereg_hash").notNull(),
	suite: text().notNull(),
	arm: text().notNull(),
	backlogId: text("backlog_id").notNull(),
	seed: integer().notNull(),
	tasks: integer().notNull(),
	resolved: integer().notNull(),
	tasksZeroHumanGate: integer("tasks_zero_human_gate").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensTotal: bigint("tokens_total", { mode: "number" }).notNull(),
	costUsd: doublePrecision("cost_usd").notNull(),
	priceTableVersion: text("price_table_version").notNull(),
	peakConcurrency: integer("peak_concurrency"),
	valueCapturedUsd: doublePrecision("value_captured_usd"),
	valueAvailableUsd: doublePrecision("value_available_usd"),
	budgetUsd: doublePrecision("budget_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetTokens: bigint("budget_tokens", { mode: "number" }),
	modelId: text("model_id").notNull(),
	harnessVersion: text("harness_version").notNull(),
	configSnapshot: jsonb("config_snapshot"),
	envFingerprint: jsonb("env_fingerprint"),
	armMeta: jsonb("arm_meta"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_fleet_run_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	unique("benchmark_fleet_run_workspace_id_run_id_backlog_id_arm_seed_key").on(table.arm, table.backlogId, table.runId, table.seed, table.workspaceId),
	pgPolicy("benchmark_fleet_run_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.fleetRunId], name: "benchmark_fleet_run_pkey"}),

]);

export const benchmarkPreregInHarnessShared = harnessShared.table("benchmark_prereg", {
	preregHash: text("prereg_hash").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	label: text(),
	suites: jsonb().default([]).notNull(),
	config: jsonb().notNull(),
	filePath: text("file_path").notNull(),
	gitCommitted: boolean("git_committed").default(false).notNull(),
	gitCommitSha: text("git_commit_sha"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_prereg_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	unique("benchmark_prereg_workspace_id_run_id_key").on(table.runId, table.workspaceId),
	pgPolicy("benchmark_prereg_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.preregHash], name: "benchmark_prereg_pkey"}),

]);

export const benchmarkRolloutInHarnessShared = harnessShared.table("benchmark_rollout", {
	rolloutId: text("rollout_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	preregHash: text("prereg_hash").notNull(),
	suite: text().notNull(),
	taskId: text("task_id").notNull(),
	arm: text().notNull(),
	seed: integer().notNull(),
	configSnapshot: jsonb("config_snapshot"),
	modelId: text("model_id").notNull(),
	modelVersion: text("model_version"),
	harnessVersion: text("harness_version").notNull(),
	harnessGitSha: text("harness_git_sha"),
	envFingerprint: jsonb("env_fingerprint"),
	graderFamily: text("grader_family").notNull(),
	graderVersion: text("grader_version").notNull(),
	graderOutput: jsonb("grader_output"),
	rawGraderOutput: text("raw_grader_output"),
	submission: text(),
	trajectoryRef: text("trajectory_ref"),
	trajectoryKind: text("trajectory_kind"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_rollout_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	pgPolicy("benchmark_rollout_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.rolloutId], name: "benchmark_rollout_pkey"}),

]);

export const benchmarkRunResultInHarnessShared = harnessShared.table("benchmark_run_result", {
	rolloutId: text("rollout_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	suite: text().notNull(),
	modality: text().notNull(),
	taskId: text("task_id").notNull(),
	arm: text().notNull(),
	seed: integer().notNull(),
	resolved: boolean(),
	graderStatus: text("grader_status").notNull(),
	graderFamily: text("grader_family").notNull(),
	graderVersion: text("grader_version").notNull(),
	failToPass: jsonb("fail_to_pass"),
	passToPass: jsonb("pass_to_pass"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensTotal: bigint("tokens_total", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensCacheWrite: bigint("tokens_cache_write", { mode: "number" }),
	costUsd: doublePrecision("cost_usd").notNull(),
	priceTableVersion: text("price_table_version").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }).notNull(),
	turns: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetTokens: bigint("budget_tokens", { mode: "number" }),
	capped: boolean().default(false).notNull(),
	generationStatus: text("generation_status").notNull(),
	generationError: text("generation_error"),
	armMeta: jsonb("arm_meta"),
	modelId: text("model_id").notNull(),
	harnessVersion: text("harness_version").notNull(),
	preregHash: text("prereg_hash").notNull(),
	rawGraderOutputRef: text("raw_grader_output_ref"),
	submissionRef: text("submission_ref"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fleetRunId: text("fleet_run_id"),
	score: doublePrecision(),
}, (table) => [
	index("benchmark_run_result_fleet_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetRunId.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_prereg_idx").using("btree", table.preregHash.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_ws_run_suite_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.suite.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_ws_suite_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.suite.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.rolloutId],
			foreignColumns: [benchmarkRolloutInHarnessShared.rolloutId],
			name: "benchmark_run_result_rollout_id_fkey"
		}).onDelete("cascade"),
	unique("benchmark_run_result_workspace_id_run_id_suite_task_id_arm__key").on(table.arm, table.runId, table.seed, table.suite, table.taskId, table.workspaceId),
	pgPolicy("benchmark_run_result_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("benchmark_run_result_arm_check", sql`arm = ANY (ARRAY['papercusp'::text, 'baseline-a-ablation'::text, 'baseline-b-native'::text, 'baseline-c-bestofn'::text])`),
	check("benchmark_run_result_generation_status_check", sql`generation_status = ANY (ARRAY['completed'::text, 'error'::text, 'timeout'::text])`),
	check("benchmark_run_result_grader_status_check", sql`grader_status = ANY (ARRAY['passed'::text, 'failed'::text, 'error'::text, 'timeout'::text])`),
	check("benchmark_run_result_modality_check", sql`modality = ANY (ARRAY['diff'::text, 'in-container'::text])`),
	primaryKey({ columns: [table.rolloutId], name: "benchmark_run_result_pkey"}),

]);

export const blueprintOperationInvocationsInHarnessShared = harnessShared.table("blueprint_operation_invocations", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.blueprint_operation_invocations_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	callerId: text("caller_id").notNull(),
	operationId: text("operation_id").notNull(),
	requestKey: text("request_key").notNull(),
	requestFingerprint: text("request_fingerprint").notNull(),
	specificationRevision: text("specification_revision").notNull(),
	targetKind: text("target_kind").notNull(),
	targetRef: text("target_ref"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	requestPayload: jsonb("request_payload"),
	programStartedAt: timestamp("program_started_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("blueprint_operation_invocations_unstarted_idx").using("btree", table.id.asc().nullsLast().op("int8_ops")).where(sql`((target_kind = 'work-item'::text) AND (program_started_at IS NULL))`),
	unique("blueprint_operation_invocatio_workspace_id_harness_slug_cal_key").on(table.callerId, table.harnessSlug, table.operationId, table.requestKey, table.workspaceId),
	pgPolicy("blueprint_operation_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("blueprint_operation_invocations_payload_object", sql`(request_payload IS NULL) OR (jsonb_typeof(request_payload) = 'object'::text)`),
	check("blueprint_operation_invocations_request_fingerprint_check", sql`request_fingerprint ~ '^[0-9a-f]{64}$'::text`),
	check("blueprint_operation_invocations_specification_revision_check", sql`specification_revision ~ '^[0-9a-f]{64}$'::text`),
	check("blueprint_operation_invocations_target_kind_check", sql`target_kind = ANY (ARRAY['work-item'::text, 'plan'::text])`),
]);

export const blueprintPackageDependentsInHarnessShared = harnessShared.table("blueprint_package_dependents", {
	workspaceId: text("workspace_id").notNull(),
	dependentId: text("dependent_id").notNull(),
	resourceKey: text("resource_key").notNull(),
	phase: text().default('prepared').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("blueprint_package_dependents_resource_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.resourceKey.asc().nullsLast().op("text_ops")).where(sql`(phase <> 'released'::text)`),
	foreignKey({
			columns: [table.workspaceId, table.resourceKey],
			foreignColumns: [blueprintPackageResourcesInHarnessShared.workspaceId, blueprintPackageResourcesInHarnessShared.resourceKey],
			name: "blueprint_package_dependents_workspace_id_resource_key_fkey"
		}),
	primaryKey({ columns: [table.dependentId, table.resourceKey, table.workspaceId], name: "blueprint_package_dependents_pkey"}),
	pgPolicy("blueprint_package_dependents_workspace", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("blueprint_package_dependents_phase_check", sql`phase = ANY (ARRAY['prepared'::text, 'applied'::text, 'released'::text])`),
]);

export const blueprintPackageInstallationsInHarnessShared = harnessShared.table("blueprint_package_installations", {
	workspaceId: text("workspace_id").notNull(),
	dependentId: text("dependent_id").notNull(),
	ownerId: text("owner_id").notNull(),
	specificationRevision: text("specification_revision").notNull(),
	stateRevision: text("state_revision").notNull(),
	expectedResources: jsonb("expected_resources").notNull(),
	phase: text().default('preparing').notNull(),
	error: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("blueprint_package_installations_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops")).where(sql`(phase <> 'released'::text)`),
	primaryKey({ columns: [table.dependentId, table.workspaceId], name: "blueprint_package_installations_pkey"}),
	pgPolicy("blueprint_package_installations_workspace", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("blueprint_package_installations_expected_resources_check", sql`jsonb_typeof(expected_resources) = 'object'::text`),
	check("blueprint_package_installations_phase_check", sql`phase = ANY (ARRAY['preparing'::text, 'applied'::text, 'releasing'::text, 'released'::text, 'cleanup_failed'::text])`),
]);

export const blueprintPackageResourcesInHarnessShared = harnessShared.table("blueprint_package_resources", {
	workspaceId: text("workspace_id").notNull(),
	resourceKey: text("resource_key").notNull(),
	memoryScope: text("memory_scope").notNull(),
	packageKind: text("package_kind").notNull(),
	packageRef: text("package_ref").notNull(),
	packageVersion: text("package_version").notNull(),
	packageHash: text("package_hash").notNull(),
	resourceKind: text("resource_kind").notNull(),
	itemKey: text("item_key").notNull(),
	installedHash: text("installed_hash").notNull(),
	writeKey: uuid("write_key").defaultRandom().notNull(),
	phase: text().default('intent').notNull(),
	externalRefs: jsonb("external_refs").default([]).notNull(),
	error: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.resourceKey, table.workspaceId], name: "blueprint_package_resources_pkey"}),
	unique("blueprint_package_resources_workspace_id_write_key_key").on(table.workspaceId, table.writeKey),
	pgPolicy("blueprint_package_resources_workspace", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("blueprint_package_resources_external_refs_check", sql`jsonb_typeof(external_refs) = 'array'::text`),
	check("blueprint_package_resources_phase_check", sql`phase = ANY (ARRAY['intent'::text, 'ready'::text, 'cleanup_failed'::text, 'deleted'::text, 'detached'::text])`),
]);

export const blueprintSpecificationsInHarnessShared = harnessShared.table("blueprint_specifications", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	specificationRevision: text("specification_revision").notNull(),
	artifact: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.specificationRevision, table.workspaceId], name: "blueprint_specifications_pkey"}),
	pgPolicy("blueprint_specifications_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("blueprint_specifications_check", sql`(artifact ->> 'specificationRevision'::text) = specification_revision`),
	check("blueprint_specifications_specification_revision_check", sql`specification_revision ~ '^[0-9a-f]{64}$'::text`),
]);

export const blueprintsInHarnessShared = harnessShared.table("blueprints", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	blueprintId: text("blueprint_id").notNull(),
	version: text().default('0.1.0').notNull(),
	resolved: jsonb().notNull(),
	contentHash: text("content_hash").notNull(),
	sourcePath: text("source_path"),
	sourceCommit: text("source_commit"),
	projectedAt: timestamp("projected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "blueprints_pkey"}),
	pgPolicy("blueprints_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const bootHistoryEventsInHarnessShared = harnessShared.table("boot_history_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	kind: text().notNull(),
	message: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	origin: text().default('real').notNull(),
}, (table) => [
	index("boot_history_events_origin_scope_idx").using("btree", table.origin.asc().nullsLast().op("text_ops"), table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.asc().nullsLast().op("int8_ops")),
	index("boot_history_events_scope_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.asc().nullsLast().op("int8_ops")),
	check("boot_history_events_origin_check", sql`origin = ANY (ARRAY['real'::text, 'test'::text])`),
]);

export const cacheL2InHarnessShared = harnessShared.table("cache_l2", {
	workspaceId: text("workspace_id").notNull(),
	cacheKey: text("cache_key").notNull(),
	value: jsonb(),
	tags: text().array().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	generation: bigint({ mode: "number" }).default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cache_l2_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(expires_at IS NOT NULL)`),
	uniqueIndex("cache_l2_key_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.cacheKey.asc().nullsLast().op("text_ops")),
	index("cache_l2_tags_gin").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	check("cache_l2_key_nonempty", sql`cache_key <> ''::text`),
	check("cache_l2_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const calibrationPredictionsInHarnessShared = harnessShared.table("calibration_predictions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.calibration_predictions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	predictor: text().notNull(),
	domain: text().notNull(),
	subjectKind: text("subject_kind").notNull(),
	subjectId: text("subject_id").notNull(),
	claim: text().notNull(),
	probability: doublePrecision().notNull(),
	stated: boolean().default(false).notNull(),
	signalOrigin: text("signal_origin").default('organic').notNull(),
	watchdogKey: text("watchdog_key"),
	horizonTs: timestamp("horizon_ts", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	outcome: boolean(),
	resolutionNote: text("resolution_note"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("calibration_predictions_matured_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.horizonTs.asc().nullsLast().op("timestamptz_ops")).where(sql`(resolved_at IS NULL)`),
	uniqueIndex("calibration_predictions_open_bet_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.predictor.asc().nullsLast().op("text_ops"), table.domain.asc().nullsLast().op("text_ops"), table.subjectKind.asc().nullsLast().op("text_ops"), table.subjectId.asc().nullsLast().op("text_ops")).where(sql`(resolved_at IS NULL)`),
	index("calibration_predictions_scores_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.predictor.asc().nullsLast().op("text_ops"), table.domain.asc().nullsLast().op("text_ops")),
	index("calibration_predictions_subject_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subjectKind.asc().nullsLast().op("text_ops"), table.subjectId.asc().nullsLast().op("text_ops")),
	index("calibration_predictions_ws_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	check("calibration_predictions_origin_vocab", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("calibration_predictions_outcome_resolved", sql`(outcome IS NULL) OR (resolved_at IS NOT NULL)`),
	check("calibration_predictions_predictor_nonempty", sql`predictor <> ''::text`),
	check("calibration_predictions_probability_range", sql`(probability >= (0)::double precision) AND (probability <= (1)::double precision)`),
	check("calibration_predictions_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const capabilityClassConformanceRunsInHarnessShared = harnessShared.table("capability_class_conformance_runs", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	classId: text("class_id").notNull(),
	classVersion: text("class_version").notNull(),
	providerPackage: text("provider_package").notNull(),
	providerVersion: text("provider_version").notNull(),
	registryRevision: text("registry_revision").notNull(),
	verbBindings: jsonb("verb_bindings").notNull(),
	structuralPassed: boolean("structural_passed").notNull(),
	behavioralStatus: text("behavioral_status").default('not-required').notNull(),
	behavioralRunRef: text("behavioral_run_ref"),
	report: jsonb().notNull(),
	performedBy: text("performed_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	providerKind: text("provider_kind").default('tool').notNull(),
	latencyClass: text("latency_class").default('sync').notNull(),
}, (table) => [
	index("capability_class_conformance_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.classId.asc().nullsLast().op("text_ops"), table.classVersion.asc().nullsLast().op("text_ops"), table.providerPackage.asc().nullsLast().op("text_ops"), table.providerVersion.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.workspaceId, table.classId, table.classVersion],
			foreignColumns: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version],
			name: "capability_class_conformance_class_fk"
		}),
	unique("capability_class_conformance_binding_identity_uq").on(table.classId, table.classVersion, table.id, table.providerPackage, table.providerVersion, table.structuralPassed, table.workspaceId),
	unique("capability_class_conformance_execution_uq").on(table.classId, table.classVersion, table.id, table.latencyClass, table.providerKind, table.providerPackage, table.providerVersion, table.structuralPassed, table.workspaceId),
	pgPolicy("capability_class_conformance_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("capability_class_conformance_behavior_ck", sql`behavioral_status = ANY (ARRAY['not-required'::text, 'not-run'::text, 'passed'::text, 'failed'::text])`),
	check("capability_class_conformance_execution_ck", sql`((provider_kind = ANY (ARRAY['tool'::text, 'recipe'::text])) AND (latency_class = 'sync'::text)) OR ((provider_kind = 'operation'::text) AND (latency_class = 'async'::text))`),
	check("capability_class_conformance_report_ck", sql`jsonb_typeof(report) = 'object'::text`),
	check("capability_class_conformance_verbs_ck", sql`jsonb_typeof(verb_bindings) = 'object'::text`),
]);

export const capabilityClassProviderBindingsInHarnessShared = harnessShared.table("capability_class_provider_bindings", {
	workspaceId: text("workspace_id").notNull(),
	classId: text("class_id").notNull(),
	classVersion: text("class_version").notNull(),
	providerPackage: text("provider_package").notNull(),
	providerVersion: text("provider_version").notNull(),
	conformanceRunId: text("conformance_run_id").notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	bindingEligible: boolean("binding_eligible").generatedAlwaysAs(sql`true`),
	providerKind: text("provider_kind").default('tool').notNull(),
	latencyClass: text("latency_class").default('sync').notNull(),
}, (table) => [
	index("capability_class_provider_discovery_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.classId.asc().nullsLast().op("text_ops"), table.classVersion.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.classId, table.classVersion],
			foreignColumns: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version],
			name: "capability_class_provider_class_fk"
		}),
	foreignKey({
			columns: [table.workspaceId, table.classId, table.classVersion, table.providerPackage, table.providerVersion, table.conformanceRunId, table.bindingEligible, table.providerKind, table.latencyClass],
			foreignColumns: [capabilityClassConformanceRunsInHarnessShared.workspaceId, capabilityClassConformanceRunsInHarnessShared.classId, capabilityClassConformanceRunsInHarnessShared.classVersion, capabilityClassConformanceRunsInHarnessShared.providerPackage, capabilityClassConformanceRunsInHarnessShared.providerVersion, capabilityClassConformanceRunsInHarnessShared.id, capabilityClassConformanceRunsInHarnessShared.structuralPassed, capabilityClassConformanceRunsInHarnessShared.providerKind, capabilityClassConformanceRunsInHarnessShared.latencyClass],
			name: "capability_class_provider_run_fk"
		}),
	primaryKey({ columns: [table.classId, table.classVersion, table.providerPackage, table.providerVersion, table.workspaceId], name: "capability_class_provider_bindings_pkey"}),
	unique("capability_class_provider_execution_uq").on(table.classId, table.classVersion, table.latencyClass, table.providerKind, table.providerPackage, table.providerVersion, table.workspaceId),
	pgPolicy("capability_class_provider_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("capability_class_provider_status_ck", sql`status = ANY (ARRAY['active'::text, 'retired'::text])`),
]);

export const capabilityClassRegistryInHarnessShared = harnessShared.table("capability_class_registry", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	version: text().notNull(),
	title: text().notNull(),
	description: text().notNull(),
	interfaceVerbs: jsonb("interface_verbs").notNull(),
	behavioralSuiteRef: text("behavioral_suite_ref"),
	status: text().default('active').notNull(),
	published: boolean().default(false).notNull(),
	reviewStatus: text("review_status").default('none').notNull(),
	tags: text().array().default([]).notNull(),
	embedding: vector({ dimensions: 768 }),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	embeddingProfile: text("embedding_profile"),
	provenanceKind: text("provenance_kind").default('platform').notNull(),
	publisherNamespace: text("publisher_namespace"),
	contractHash: text("contract_hash"),
	sourceArtifactHash: text("source_artifact_hash"),
	sourceProvenance: jsonb("source_provenance").default({}).notNull(),
}, (table) => [
	index("capability_class_registry_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("capability_class_registry_namespace_provenance_idx").using("btree", sql`workspace_id`, sql`split_part(id, '.'::text, 1)`, sql`provenance_kind`),
	index("capability_class_registry_review_pending_idx").using("btree", table.reviewStatus.asc().nullsLast().op("text_ops")).where(sql`(review_status = 'pending'::text)`),
	index("capability_class_registry_tags_idx").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("capability_class_registry_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.id, table.version, table.workspaceId], name: "capability_class_registry_pkey"}),
	pgPolicy("capability_class_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	pgPolicy("capability_class_registry_approved_global_read", { as: "permissive", for: "select", to: ["public"], using: sql`(review_status = 'approved'::text)` }),
	check("capability_class_registry_import_provenance_ck", sql`(provenance_kind <> 'cupboard-import'::text) OR ((publisher_namespace IS NOT NULL) AND (contract_hash IS NOT NULL) AND (source_artifact_hash IS NOT NULL))`),
	check("capability_class_registry_provenance_kind_ck", sql`provenance_kind = ANY (ARRAY['platform'::text, 'cupboard-import'::text])`),
	check("capability_class_registry_review_ck", sql`review_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text])`),
	check("capability_class_registry_status_ck", sql`status = ANY (ARRAY['active'::text, 'retired'::text, 'superseded'::text])`),
	check("capability_class_registry_verbs_ck", sql`(jsonb_typeof(interface_verbs) = 'object'::text) AND (interface_verbs <> '{}'::jsonb)`),
]);

export const carryNotesInHarnessShared = harnessShared.table("carry_notes", {
	workspaceId: text("workspace_id").notNull(),
	scope: text().notNull(),
	note: text(),
	journal: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	deps: jsonb(),
	noteTsv: tsvectorCustom("note_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, COALESCE(note, ''::text))`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bodyTs: bigint("body_ts", { mode: "number" }),
	attestedCount: integer("attested_count").default(0).notNull(),
}, (table) => [
	index("carry_notes_tsv_idx").using("gin", table.noteTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.scope, table.workspaceId], name: "carry_notes_pkey"}),
	pgPolicy("carry_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const censusProviderRegistrationsInHarnessShared = harnessShared.table("census_provider_registrations", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	provider: text().notNull(),
	config: jsonb().default({}).notNull(),
	enabled: boolean().default(true).notNull(),
	source: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.provider, table.workspaceId], name: "census_provider_registrations_pkey"}),
	check("census_provider_registrations_source_check", sql`source = ANY (ARRAY['template'::text, 'detected'::text, 'manual'::text])`),
]);

export const claimAuditInHarnessShared = harnessShared.table("claim_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	claimerPubkey: text("claimer_pubkey").notNull(),
	attemptTs: timestamp("attempt_ts", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	outcome: text().notNull(),
	detail: text(),
}, (table) => [
	index("claim_audit_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.attemptTs.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "claim_audit_pkey"}),
	pgPolicy("claim_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("claim_audit_outcome_check", sql`outcome = ANY (ARRAY['won'::text, 'lost'::text, 'timeout'::text, 'error'::text])`),
]);

export const cloudResourceObligationsInHarnessShared = harnessShared.table("cloud_resource_obligations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	provider: text().notNull(),
	resourceKind: text("resource_kind").notNull(),
	resourceId: text("resource_id").notNull(),
	projectId: text("project_id").default('').notNull(),
	purpose: text().default('').notNull(),
	createdByOwnerId: text("created_by_owner_id").default('').notNull(),
	sourceWorkItemId: text("source_work_item_id").default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	graceMs: bigint("grace_ms", { mode: "number" }).default(21600000).notNull(),
	teardownOwed: boolean("teardown_owed").default(true).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closedReason: text("closed_reason").default('').notNull(),
	lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true, mode: 'string' }),
	escalationWorkItemId: text("escalation_work_item_id").default('').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	zone: text().default('').notNull(),
	region: text().default('').notNull(),
	parentResourceId: text("parent_resource_id").default('').notNull(),
	hostId: text("host_id").default('').notNull(),
	incarnationId: text("incarnation_id").default('').notNull(),
}, (table) => [
	index("cloud_resource_obligations_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((closed_at IS NULL) AND teardown_owed)`),
	unique("cloud_resource_obligations_workspace_id_provider_resource_k_key").on(table.provider, table.resourceId, table.resourceKind, table.workspaceId),
	pgPolicy("cloud_resource_obligations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("cloud_resource_obligations_grace_ms_check", sql`grace_ms >= 0`),
	check("cloud_resource_obligations_provider_check", sql`provider = 'gcp'::text`),
	check("cloud_resource_obligations_resource_id_check", sql`(length(btrim(resource_id)) >= 1) AND (length(btrim(resource_id)) <= 300)`),
	check("cloud_resource_obligations_resource_kind_check", sql`(length(btrim(resource_kind)) >= 1) AND (length(btrim(resource_kind)) <= 80)`),
]);

export const codeRecipeRunsInHarnessShared = harnessShared.table("code_recipe_runs", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.code_recipe_runs_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	recipeId: text("recipe_id"),
	workspaceId: text("workspace_id").notNull(),
	agentOwner: text("agent_owner"),
	agentRole: text("agent_role"),
	success: boolean().default(true).notNull(),
	reused: boolean().default(false).notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
	executionTrace: jsonb("execution_trace"),
	structuralFingerprint: text("structural_fingerprint"),
}, (table) => [
	index("code_recipe_runs_fingerprint_idx").using("btree", table.structuralFingerprint.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(structural_fingerprint IS NOT NULL)`),
	index("code_recipe_runs_recipe_idx").using("btree", table.recipeId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("code_recipe_runs_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("code_recipe_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("code_recipe_runs_recipe_or_trace_ck", sql`(recipe_id IS NOT NULL) OR (execution_trace IS NOT NULL)`),
	check("code_recipe_runs_trace_fingerprint_ck", sql`((execution_trace IS NULL) AND (structural_fingerprint IS NULL)) OR ((jsonb_typeof(execution_trace) = 'object'::text) AND (structural_fingerprint ~ '^[0-9a-f]{64}$'::text))`),
]);

export const codeRecipesInHarnessShared = harnessShared.table("code_recipes", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	description: text().notNull(),
	script: text().notNull(),
	authorRole: text("author_role"),
	toolsUsed: text("tools_used").array().default([]).notNull(),
	runCount: integer("run_count").default(0).notNull(),
	successCount: integer("success_count").default(0).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	status: text().default('active').notNull(),
	promotedTool: text("promoted_tool"),
	mergedInto: text("merged_into"),
	tags: text().array().default([]).notNull(),
	embedding: vector({ dimensions: 768 }),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
	bindingSchema: jsonb("binding_schema"),
	capabilityManifest: jsonb("capability_manifest"),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("code_recipes_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("code_recipes_pot_idx").using("btree", table.potSlug.asc().nullsLast().op("text_ops")),
	index("code_recipes_runcount_idx").using("btree", table.lastRunAt.desc().nullsLast().op("timestamptz_ops"), table.runCount.desc().nullsFirst().op("int4_ops")),
	index("code_recipes_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
	check("code_recipes_binding_schema_requires_manifest_ck", sql`(binding_schema IS NULL) OR (capability_manifest IS NOT NULL)`),
	check("code_recipes_binding_schema_v1_ck", sql`(binding_schema IS NULL) OR ((jsonb_typeof(binding_schema) = 'object'::text) AND (binding_schema @> '{"version": 1, "additionalProperties": false}'::jsonb) AND (jsonb_typeof((binding_schema -> 'properties'::text)) = 'object'::text))`),
	check("code_recipes_capability_manifest_v1_ck", sql`(capability_manifest IS NULL) OR ((jsonb_typeof(capability_manifest) = 'object'::text) AND (capability_manifest @> '{"version": 1, "representation": "recipe-script"}'::jsonb) AND ((capability_manifest #> '{topology,premises}'::text[]) = '["host:same"]'::jsonb) AND (jsonb_typeof((capability_manifest -> 'requirements'::text)) = 'array'::text))`),
]);

export const codeRunNudgeFiresInHarnessShared = harnessShared.table("code_run_nudge_fires", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.code_run_nudge_fires_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	sessionKey: text("session_key").notNull(),
	role: text().notNull(),
	kind: text().notNull(),
	toolName: text("tool_name").notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("code_run_nudge_fires_at").using("btree", table.firedAt.asc().nullsLast().op("timestamptz_ops")),
	index("code_run_nudge_fires_session").using("btree", table.sessionKey.asc().nullsLast().op("text_ops"), table.firedAt.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("code_run_nudge_fires_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))` }),
]);

export const collisionHysteresisInHarnessShared = harnessShared.table("collision_hysteresis", {
	sessionId: text("session_id").primaryKey().notNull(),
	ownerId: text("owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tick: bigint({ mode: "number" }).default(0).notNull(),
	states: jsonb().default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("collision_hysteresis_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId], name: "collision_hysteresis_pkey"}),

]);

export const commsTrustListInHarnessShared = harnessShared.table("comms_trust_list", {
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	tier: text(),
	note: text(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	gate: boolean().default(false).notNull(),
}, (table) => [
	primaryKey({ columns: [table.trustedGithubUserId, table.workspaceId], name: "comms_trust_list_pkey"}),
	check("comms_trust_list_tier_check", sql`tier = ANY (ARRAY['observe'::text, 'message'::text, 'wake'::text, 'steer'::text])`),
]);

export const connectedAppDeviceGrantsInHarnessShared = harnessShared.table("connected_app_device_grants", {
	deviceCodeHash: text("device_code_hash").primaryKey().notNull(),
	userCode: text("user_code").notNull(),
	clientLabel: text("client_label").notNull(),
	requestedScopes: jsonb("requested_scopes").default({}).notNull(),
	state: text().default('pending').notNull(),
	workspaceId: text("workspace_id"),
	approvedBy: text("approved_by"),
	appId: text("app_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("connected_app_device_grants_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("connected_app_device_grants_pending_user_code_key").using("btree", table.userCode.asc().nullsLast().op("text_ops")).where(sql`(state = 'pending'::text)`),
	pgPolicy("connected_app_device_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("connected_app_device_grants_approved_has_workspace", sql`(state = ANY (ARRAY['pending'::text, 'denied'::text])) OR (workspace_id IS NOT NULL)`),
	check("connected_app_device_grants_consumed_has_app", sql`(state <> 'consumed'::text) OR (app_id IS NOT NULL)`),
	check("connected_app_device_grants_hash_shape", sql`device_code_hash ~ '^[0-9a-f]{64}$'::text`),
	check("connected_app_device_grants_scopes_is_object", sql`jsonb_typeof(requested_scopes) = 'object'::text`),
	check("connected_app_device_grants_state_check", sql`state = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'consumed'::text])`),
	check("connected_app_device_grants_user_code_shape", sql`user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'::text`),
	primaryKey({ columns: [table.deviceCodeHash], name: "connected_app_device_grants_pkey"}),

]);

export const connectedAppsInHarnessShared = harnessShared.table("connected_apps", {
	id: text().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().default('mobile').notNull(),
	label: text(),
	pairedAt: timestamp("paired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	scopes: jsonb().default({}).notNull(),
	tokenHash: text("token_hash"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	pausedAt: timestamp("paused_at", { withTimezone: true, mode: 'string' }),
	lastIp: text("last_ip"),
	limits: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	spendCapCents: bigint("spend_cap_cents", { mode: "number" }),
	spendCapWindowSec: integer("spend_cap_window_sec"),
	previousTokenHash: text("previous_token_hash"),
	previousTokenValidUntil: timestamp("previous_token_valid_until", { withTimezone: true, mode: 'string' }),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("connected_apps_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")).where(sql`(token_hash IS NOT NULL)`),
	index("connected_apps_user_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	index("connected_apps_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	pgPolicy("connected_apps_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("connected_apps_app_has_token_hash", sql`(kind <> ALL (ARRAY['app'::text, 'service'::text])) OR (token_hash IS NOT NULL)`),
	check("connected_apps_kind_check", sql`kind = ANY (ARRAY['mobile'::text, 'app'::text, 'service'::text])`),
	check("connected_apps_limits_is_object", sql`jsonb_typeof(limits) = 'object'::text`),
	check("connected_apps_previous_token_hash_shape", sql`(previous_token_hash IS NULL) OR (previous_token_hash ~ '^[0-9a-f]{64}$'::text)`),
	check("connected_apps_previous_token_kind", sql`(previous_token_hash IS NULL) OR (kind = ANY (ARRAY['app'::text, 'service'::text]))`),
	check("connected_apps_previous_token_pair", sql`(previous_token_hash IS NULL) = (previous_token_valid_until IS NULL)`),
	check("connected_apps_scopes_is_object", sql`jsonb_typeof(scopes) = 'object'::text`),
	check("connected_apps_service_has_spend_cap", sql`(kind <> 'service'::text) OR (spend_cap_cents IS NOT NULL)`),
	check("connected_apps_spend_cap_positive", sql`(spend_cap_cents IS NULL) OR (spend_cap_cents > 0)`),
	check("connected_apps_spend_cap_window_positive", sql`(spend_cap_window_sec IS NULL) OR (spend_cap_window_sec > 0)`),
	check("connected_apps_token_hash_shape", sql`(token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text)`),
]);

export const consultPostMetaInHarnessShared = harnessShared.table("consult_post_meta", {
	workspaceId: text("workspace_id").default('default').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	postId: bigint("post_id", { mode: "number" }).notNull(),
	conversationId: text("conversation_id").notNull(),
	authorId: text("author_id"),
	kind: text().notNull(),
	evidence: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("consult_post_meta_conversation_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.conversationId.asc().nullsLast().op("text_ops"), table.postId.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.postId, table.workspaceId], name: "consult_post_meta_pkey"}),
	check("consult_post_meta_kind_check", sql`kind = ANY (ARRAY['question'::text, 'answer'::text, 'clarifying_question'::text, 'new_fact'::text, 'decline'::text, 'close'::text])`),
]);

export const consultStateInHarnessShared = harnessShared.table("consult_state", {
	workspaceId: text("workspace_id").default('default').notNull(),
	conversationId: text("conversation_id").notNull(),
	requesterId: text("requester_id").notNull(),
	responderId: text("responder_id"),
	state: text().default('routing').notNull(),
	question: text().default('').notNull(),
	latencyContract: text("latency_contract").default('proceed').notNull(),
	maxExchanges: integer("max_exchanges").default(4).notNull(),
	exchangesUsed: integer("exchanges_used").default(0).notNull(),
	wakeBudget: integer("wake_budget").default(4).notNull(),
	wakesUsed: integer("wakes_used").default(0).notNull(),
	depth: integer().default(0).notNull(),
	parentConsultId: text("parent_consult_id"),
	originTaskRef: text("origin_task_ref"),
	routing: jsonb().default({}).notNull(),
	outcome: jsonb(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	queryEmbedding: vector("query_embedding", { dimensions: 768 }),
	cascadeCursor: integer("cascade_cursor").default(0).notNull(),
	cascadeDigest: jsonb("cascade_digest").default([]).notNull(),
	queryEmbeddingMode: text("query_embedding_mode"),
	queryEmbeddingProfile: text("query_embedding_profile"),
	dispatchAttempts: jsonb("dispatch_attempts").default([]).notNull(),
}, (table) => [
	index("consult_state_expiry_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((expires_at IS NOT NULL) AND (closed_at IS NULL))`),
	index("consult_state_origin_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.originTaskRef.asc().nullsLast().op("text_ops")).where(sql`(origin_task_ref IS NOT NULL)`),
	index("consult_state_parent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentConsultId.asc().nullsLast().op("text_ops")).where(sql`(parent_consult_id IS NOT NULL)`),
	index("consult_state_query_embedding_idx").using("hnsw", table.queryEmbedding.asc().nullsLast().op("vector_cosine_ops")).where(sql`(query_embedding IS NOT NULL)`),
	index("consult_state_responder_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.responderId.asc().nullsLast().op("text_ops")).where(sql`(responder_id IS NOT NULL)`),
	index("consult_state_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.conversationId, table.workspaceId], name: "consult_state_pkey"}),
	check("consult_state_cascade_cursor_check", sql`cascade_cursor >= 0`),
	check("consult_state_depth_check", sql`(depth >= 0) AND (depth <= 2)`),
	check("consult_state_latency_check", sql`latency_contract = ANY (ARRAY['proceed'::text, 'hard-blocked'::text])`),
	check("consult_state_state_check", sql`state = ANY (ARRAY['routing'::text, 'no_qualified_responder'::text, 'awaiting_responder'::text, 'active'::text, 'closed_answered'::text, 'closed_cant_help'::text, 'declined'::text, 'graduated'::text, 'expired'::text])`),
]);

export const contextInjectionCoverageInHarnessShared = harnessShared.table("context_injection_coverage", {
	day: date().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	client: text().default('').notNull(),
	port: text().notNull(),
	outcome: text().notNull(),
	tool: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	n: bigint({ mode: "number" }).default(0).notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("context_injection_coverage_day_idx").using("btree", table.day.desc().nullsFirst().op("date_ops")),
	primaryKey({ columns: [table.client, table.day, table.outcome, table.port, table.tool, table.workspaceId], name: "context_injection_coverage_pkey"}),
]);

export const contributorUsageEventsInHarnessShared = harnessShared.table("contributor_usage_events", {
	harnessSlug: text("harness_slug").notNull(),
	eventId: text("event_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	kind: text().notNull(),
	refId: text("ref_id"),
	payload: jsonb(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	origin: text().default('local').notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("idx_usage_events_kind").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_usage_events_user").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUserId.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.eventId, table.harnessSlug], name: "contributor_usage_events_pkey"}),
]);

export const contributorsInHarnessShared = harnessShared.table("contributors", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	revokedPubkeys: text("revoked_pubkeys").array().default([]).notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	bindingStatus: text("binding_status").default('unverified').notNull(),
	channel1VerifiedAt: timestamp("channel1_verified_at", { withTimezone: true, mode: 'string' }),
	channel2VerifiedAt: timestamp("channel2_verified_at", { withTimezone: true, mode: 'string' }),
	channel2BranchRef: text("channel2_branch_ref"),
	bindingLastCheckedAt: timestamp("binding_last_checked_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("contributors_username_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUsername.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.githubUserId, table.harnessSlug, table.workspaceId], name: "contributors_pkey"}),
	pgPolicy("contributors_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const cooldownMarksInHarnessShared = harnessShared.table("cooldown_marks", {
	key: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	markedAtMs: bigint("marked_at_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("cooldown_marks_marked_at_idx").using("btree", table.markedAtMs.asc().nullsLast().op("int8_ops")),
]);

export const coordConversationsInHarnessShared = harnessShared.table("coord_conversations", {
	workspaceId: text("workspace_id").default('default').notNull(),
	id: text().notNull(),
	kind: text().notNull(),
	scope: text().default('operator').notNull(),
	harnessSlug: text("harness_slug"),
	askerId: text("asker_id").notNull(),
	title: text(),
	body: text().default('').notNull(),
	state: text().default('open').notNull(),
	acceptedAnswer: text("accepted_answer"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptedPostId: bigint("accepted_post_id", { mode: "number" }),
	captureTarget: text("capture_target"),
	promotedIssueId: text("promoted_issue_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	supersededBy: text("superseded_by"),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
	producer: text(),
	planSlug: text("plan_slug"),
	workItemId: text("work_item_id"),
}, (table) => [
	index("coord_conversations_lane_provenance_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops")).where(sql`((plan_slug IS NOT NULL) AND (work_item_id IS NOT NULL))`),
	index("coord_conversations_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(state = 'open'::text)`),
	index("coord_conversations_producer_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.producer.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops")),
	index("coord_conversations_scope_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("coord_conversations_superseded_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.supersededBy.asc().nullsLast().op("text_ops")).where(sql`(superseded_by IS NOT NULL)`),
	primaryKey({ columns: [table.id, table.workspaceId], name: "coord_conversations_pkey"}),
	check("coord_conversations_id_nonempty", sql`id <> ''::text`),
	check("coord_conversations_kind_check", sql`kind = ANY (ARRAY['question'::text, 'discussion'::text, 'consult'::text])`),
	check("coord_conversations_scope_check", sql`scope = ANY (ARRAY['operator'::text, 'harness'::text])`),
	check("coord_conversations_scope_slug_check", sql`((scope = 'harness'::text) AND (harness_slug IS NOT NULL) AND (harness_slug <> ''::text)) OR ((scope = 'operator'::text) AND (harness_slug IS NULL))`),
	check("coord_conversations_state_check", sql`state = ANY (ARRAY['open'::text, 'resolved'::text, 'closed'::text, 'superseded'::text, 'expired'::text])`),
	check("coord_conversations_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordEntitySubscriptionsInHarnessShared = harnessShared.table("coord_entity_subscriptions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_entity_subscriptions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	subscriberId: text("subscriber_id").notNull(),
	targetKind: text("target_kind").notNull(),
	targetRef: text("target_ref").notNull(),
	deliveryMode: text("delivery_mode").default('full').notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	followBlockers: boolean("follow_blockers").default(false).notNull(),
	derivedFromKind: text("derived_from_kind"),
	derivedFromRef: text("derived_from_ref"),
}, (table) => [
	uniqueIndex("coord_entity_subscriptions_active_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.targetKind.asc().nullsLast().op("text_ops"), table.targetRef.asc().nullsLast().op("text_ops")).where(sql`(cancelled_at IS NULL)`),
	index("coord_entity_subscriptions_derived_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.derivedFromKind.asc().nullsLast().op("text_ops"), table.derivedFromRef.asc().nullsLast().op("text_ops")).where(sql`((cancelled_at IS NULL) AND (derived_from_kind IS NOT NULL))`),
	index("coord_entity_subscriptions_target_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.targetKind.asc().nullsLast().op("text_ops"), table.targetRef.asc().nullsLast().op("text_ops")).where(sql`(cancelled_at IS NULL)`),
	check("coord_entity_subscriptions_kind_check", sql`target_kind = ANY (ARRAY['topic'::text, 'object'::text, 'fleet'::text, 'event'::text])`),
	check("coord_entity_subscriptions_mode_check", sql`delivery_mode = ANY (ARRAY['full'::text, 'digest'::text, 'mention'::text])`),
	check("coord_entity_subscriptions_ref_nonempty", sql`target_ref <> ''::text`),
	check("coord_entity_subscriptions_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordEventLogInHarnessShared = harnessShared.table("coord_event_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	surface: text().notNull(),
	writerKey: text("writer_key"),
	msgId: text("msg_id").notNull(),
	body: jsonb().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	supersededByMsgId: text("superseded_by_msg_id"),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("coord_blueprint_operation_msg_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`(surface = 'blueprint-operation'::text)`),
	index("coord_blueprint_operation_receipt_events_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.writerKey.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("int8_ops")).where(sql`(surface = 'blueprint-operation'::text)`),
	index("coord_blueprint_plan_run_events_idx").using("btree", sql`workspace_id`, sql`((body ->> 'runId'::text))`, sql`id`).where(sql`((surface = 'blueprint-operation'::text) AND ((body ->> 'runId'::text) IS NOT NULL))`),
	index("coord_blueprint_work_item_events_idx").using("btree", sql`workspace_id`, sql`((body ->> 'workItemId'::text))`, sql`id`).where(sql`((surface = 'blueprint-operation'::text) AND ((body ->> 'workItemId'::text) IS NOT NULL))`),
	index("coord_event_log_allhive_broadcast").using("btree", table.ts.asc().nullsLast().op("timestamptz_ops")).where(sql`((surface = 'messages'::text) AND ((body ->> 'kind'::text) = 'message'::text) AND ((body -> 'to'::text) @> '["*"]'::jsonb))`),
	index("coord_event_log_conditions_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`((surface = 'messages'::text) AND ((body ? 'condition_key'::text) OR (body ? 'resolves_condition'::text)))`),
	index("coord_event_log_escalation_reroute_of_idx").using("btree", sql`((body ->> 'escalationRerouteOf'::text))`).where(sql`(body ? 'escalationRerouteOf'::text)`),
	uniqueIndex("coord_event_log_event_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`(surface = ANY (ARRAY['handoffs'::text, 'escalations'::text]))`),
	uniqueIndex("coord_event_log_fanout_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`((surface = 'messages'::text) AND ((body ->> 'notify_kind'::text) IS NOT NULL))`),
	index("coord_event_log_fed_event_key_idx").using("btree", sql`workspace_id`, sql`harness_slug`, sql`(((body -> 'fed_event'::text) ->> 'key'::text))`, sql`id`, sql`(((body -> 'fed_event'::text) ->> 'repo_key'::text))`).where(sql`((surface = 'messages'::text) AND (((body -> 'fed_event'::text) ->> 'key'::text) IS NOT NULL))`),
	uniqueIndex("coord_event_log_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`((harness_slug IS NOT NULL) AND ((body ->> 'notify_kind'::text) IS NULL))`),
	index("coord_event_log_hindsight_notify_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("int8_ops")).where(sql`((surface = 'messages'::text) AND ((body ->> 'notify_kind'::text) = 'operator_hindsight'::text))`),
	index("coord_event_log_messages_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(surface = 'messages'::text)`),
	index("coord_event_log_msg_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")),
	index("coord_event_log_msg_tsv_idx").using("gin", sql`to_tsvector('english'::regconfig, "left"(((COALESCE((body ->> '`).where(sql`(surface = 'messages'::text)`),
	index("coord_event_log_msgs_from_idx").using("btree", sql`workspace_id`, sql`((body ->> 'from'::text))`).where(sql`(surface = 'messages'::text)`),
	index("coord_event_log_msgs_to_gin").using("gin", sql`((body -> 'to'::text))`).where(sql`(surface = 'messages'::text)`),
	index("coord_event_log_related_msg_id_idx").using("btree", sql`((body ->> 'related_msg_id'::text))`).where(sql`(body ? 'related_msg_id'::text)`),
	index("coord_event_log_reply_deadline").using("btree", sql`(((body ->> 'replyDeadlineAt'::text))::bigint)`).where(sql`((surface = 'messages'::text) AND (body ? 'replyDeadlineAt'::text))`),
	index("coord_event_log_superseded_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.supersededByMsgId.asc().nullsLast().op("text_ops")).where(sql`(superseded_by_msg_id IS NOT NULL)`),
	index("coord_event_log_surface_id").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("coord_event_log_surface_kind_id_idx").using("btree", sql`workspace_id`, sql`surface`, sql`((body ->> 'kind'::text))`, sql`id`),
	pgPolicy("coord_event_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const coordLinksInHarnessShared = harnessShared.table("coord_links", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_links_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	srcKind: text("src_kind").notNull(),
	srcRef: text("src_ref").notNull(),
	dstKind: text("dst_kind").notNull(),
	dstRef: text("dst_ref").notNull(),
	rel: text().notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coord_links_dst_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.dstKind.asc().nullsLast().op("text_ops"), table.dstRef.asc().nullsLast().op("text_ops")),
	uniqueIndex("coord_links_edge_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.srcKind.asc().nullsLast().op("text_ops"), table.srcRef.asc().nullsLast().op("text_ops"), table.dstKind.asc().nullsLast().op("text_ops"), table.dstRef.asc().nullsLast().op("text_ops"), table.rel.asc().nullsLast().op("text_ops")),
	index("coord_links_src_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.srcKind.asc().nullsLast().op("text_ops"), table.srcRef.asc().nullsLast().op("text_ops")),
	check("coord_links_endpoints_nonempty", sql`(src_kind <> ''::text) AND (src_ref <> ''::text) AND (dst_kind <> ''::text) AND (dst_ref <> ''::text)`),
	check("coord_links_rel_nonempty", sql`rel <> ''::text`),
	check("coord_links_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordOpenEscalationsInHarnessShared = harnessShared.table("coord_open_escalations", {
	workspaceId: text("workspace_id").notNull(),
	msgId: text("msg_id").notNull(),
	ts: timestamp({ withTimezone: true }).notNull(),
	body: jsonb().notNull(),
}, (table) => [
	index("coord_open_escalations_ws_dedup_subject").using("btree", sql`workspace_id`, sql`((body ->> 'dedupKind'::text))`, sql`((body ->> 'subjectSignature'::text))`),
	index("coord_open_escalations_ws_ts").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("timestamptz_ops"), table.msgId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.msgId, table.workspaceId], name: "coord_open_escalations_pkey"}),
]);

export const coordPresenceInHarnessShared = harnessShared.table("coord_presence", {
	ownerId: text("owner_id").primaryKey().notNull(),
	ownerLabel: text("owner_label").default('').notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	source: text().default('').notNull(),
	intent: text().default('').notNull(),
	currentPlanSlug: text("current_plan_slug"),
	currentFiles: jsonb("current_files").default([]).notNull(),
	host: text().default('').notNull(),
	pid: integer(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }),
	agentRole: text("agent_role"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	compactionLimit: integer("compaction_limit"),
	contextTokens: integer("context_tokens"),
	contextEstimatedAt: timestamp("context_estimated_at", { withTimezone: true, mode: 'string' }),
	potSlug: text("pot_slug"),
	intentDeclaredAt: timestamp("intent_declared_at", { withTimezone: true, mode: 'string' }),
	capabilityTags: jsonb("capability_tags").default([]).notNull(),
	tty: text(),
	compactionLimitExplicit: boolean("compaction_limit_explicit").default(false).notNull(),
}, (table) => [
	index("coord_presence_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("coord_presence_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	index("coord_presence_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.heartbeatAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("coord_presence_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.ownerId], name: "coord_presence_pkey"}),

]);

export const coordQuarantineInHarnessShared = harnessShared.table("coord_quarantine", {
	workspaceId: text("workspace_id").default('').notNull(),
	msgId: text("msg_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	surface: text().notNull(),
	body: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
	authorDevicePubkey: text("author_device_pubkey").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	msgTs: bigint("msg_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("coord_quarantine_author_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.authorDevicePubkey.asc().nullsLast().op("text_ops"), table.createdTs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.msgId, table.workspaceId], name: "coord_quarantine_pkey"}),
	check("coord_quarantine_reason_check", sql`reason = ANY (ARRAY['below-message-tier'::text, 'handoff-below-steer'::text, 'rate-exceeded'::text])`),
]);

export const coordReadCursorsInHarnessShared = harnessShared.table("coord_read_cursors", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	surface: text().notNull(),
	committed: jsonb(),
	pending: jsonb(),
	pendingAt: timestamp("pending_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.ownerId, table.surface, table.workspaceId], name: "coord_read_cursors_pkey"}),
]);

export const coordThreadPostsInHarnessShared = harnessShared.table("coord_thread_posts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_thread_posts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	threadId: text("thread_id").notNull(),
	authorId: text("author_id"),
	body: text().default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	postMsgId: text("post_msg_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	bodyTsv: tsvectorCustom("body_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, COALESCE(body, ''::text))`),
}, (table) => [
	uniqueIndex("coord_thread_posts_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.postMsgId.asc().nullsLast().op("text_ops")).where(sql`((harness_slug IS NOT NULL) AND (post_msg_id IS NOT NULL))`),
	index("coord_thread_posts_thread_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.threadId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("coord_thread_posts_tsv_idx").using("gin", table.bodyTsv.asc().nullsLast().op("tsvector_ops")),
	check("coord_thread_posts_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordThreadsInHarnessShared = harnessShared.table("coord_threads", {
	workspaceId: text("workspace_id").default('default').notNull(),
	threadId: text("thread_id").notNull(),
	parentKind: text("parent_kind").notNull(),
	parentRef: text("parent_ref").notNull(),
	title: text(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastPostAt: timestamp("last_post_at", { withTimezone: true, mode: 'string' }),
	postCount: integer("post_count").default(0).notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	uniqueIndex("coord_threads_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.threadId.asc().nullsLast().op("text_ops")).where(sql`(harness_slug IS NOT NULL)`),
	uniqueIndex("coord_threads_parent_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentKind.asc().nullsLast().op("text_ops"), table.parentRef.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.threadId, table.workspaceId], name: "coord_threads_pkey"}),
	check("coord_threads_parent_nonempty", sql`(parent_ref <> ''::text) AND (parent_kind <> ''::text)`),
	check("coord_threads_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordTopicsInHarnessShared = harnessShared.table("coord_topics", {
	workspaceId: text("workspace_id").default('default').notNull(),
	slug: text().notNull(),
	title: text(),
	description: text().default('').notNull(),
	createdBy: text("created_by"),
	mergedInto: text("merged_into"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coord_topics_live_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(merged_into IS NULL)`),
	primaryKey({ columns: [table.slug, table.workspaceId], name: "coord_topics_pkey"}),
	check("coord_topics_slug_nonempty", sql`slug <> ''::text`),
	check("coord_topics_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordWatermarksInHarnessShared = harnessShared.table("coord_watermarks", {
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	surfaces: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.ownerId, table.workspaceId], name: "coord_watermarks_pkey"}),
	pgPolicy("coord_watermarks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const corpusSessionSurfacedInHarnessShared = harnessShared.table("corpus_session_surfaced", {
	sessionId: text("session_id").notNull(),
	epoch: integer().default(0).notNull(),
	ref: text().notNull(),
	port: text(),
	surfacedAt: timestamp("surfaced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("corpus_session_surfaced_at_idx").using("btree", table.surfacedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.epoch, table.ref, table.sessionId], name: "corpus_session_surfaced_pkey"}),
]);

export const corpusTermDfInHarnessShared = harnessShared.table("corpus_term_df", {
	workspaceId: text("workspace_id").notNull(),
	term: text().notNull(),
	df: integer().notNull(),
	ndocs: integer().notNull(),
	refreshedAt: timestamp("refreshed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("corpus_term_df_workspace_refreshed_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.refreshedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.term, table.workspaceId], name: "corpus_term_df_pkey"}),
	check("corpus_term_df_df_positive", sql`df > 0`),
	check("corpus_term_df_ndocs_positive", sql`ndocs > 0`),
]);

export const coverageEvidenceInHarnessShared = harnessShared.table("coverage_evidence", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coverage_evidence_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	surfaceRef: bigint("surface_ref", { mode: "number" }).notNull(),
	evidenceKind: text("evidence_kind").notNull(),
	verdict: text().notNull(),
	generated: boolean().default(false).notNull(),
	testFile: text("test_file"),
	testCase: text("test_case"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	testRunId: bigint("test_run_id", { mode: "number" }),
	score: real(),
	details: jsonb().default({}).notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coverage_evidence_by_run").using("btree", table.testRunId.asc().nullsLast().op("int8_ops")).where(sql`(test_run_id IS NOT NULL)`),
	index("coverage_evidence_by_surface").using("btree", table.surfaceRef.asc().nullsLast().op("int8_ops"), table.evidenceKind.asc().nullsLast().op("text_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("coverage_evidence_dedup").using("btree", sql`surface_ref`, sql`evidence_kind`, sql`COALESCE(test_file, ''::text)`, sql`COALESCE(test_case, ''::text)`, sql`COALESCE(test_run_id, ('-1'::integer)::bigint)`),
	foreignKey({
			columns: [table.surfaceRef],
			foreignColumns: [testingSurfacesInHarnessShared.id],
			name: "coverage_evidence_surface_ref_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.testRunId],
			foreignColumns: [testRunsInHarnessShared.id],
			name: "coverage_evidence_test_run_id_fkey"
		}).onDelete("set null"),
	check("coverage_evidence_kind_check", sql`evidence_kind = ANY (ARRAY['traffic'::text, 'file-coverage'::text, 'fuzz'::text, 'crawl'::text, 'mutation'::text])`),
	check("coverage_evidence_score_check", sql`((evidence_kind <> 'mutation'::text) AND ((score IS NULL) OR ((score >= (0)::double precision) AND (score <= (1)::double precision)))) OR ((evidence_kind = 'mutation'::text) AND (score IS NOT NULL) AND (score >= (0)::double precision) AND (score <= (1)::double precision))`),
	check("coverage_evidence_verdict_check", sql`verdict = ANY (ARRAY['pass'::text, 'fail'::text, 'error'::text, 'skip'::text])`),
]);

export const coverageWaiversInHarnessShared = harnessShared.table("coverage_waivers", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coverage_waivers_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	surfaceRef: bigint("surface_ref", { mode: "number" }).notNull(),
	reason: text().notNull(),
	addedBy: text("added_by").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coverage_waivers_active").using("btree", table.surfaceRef.asc().nullsLast().op("int8_ops"), table.expiresAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.surfaceRef],
			foreignColumns: [testingSurfacesInHarnessShared.id],
			name: "coverage_waivers_surface_ref_fkey"
		}).onDelete("cascade"),
	check("coverage_waivers_reason_check", sql`length(btrim(reason)) >= 12`),
]);

export const crossPotAsksInHarnessShared = harnessShared.table("cross_pot_asks", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	peerPubkey: text("peer_pubkey").notNull(),
	direction: text().default('out').notNull(),
	kind: text().notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	correlationId: text("correlation_id").notNull(),
	state: text().default('queued').notNull(),
	replyBody: text("reply_body"),
	replyTs: timestamp("reply_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	askedBy: text("asked_by"),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("cross_hive_asks_listing_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	unique("cross_hive_asks_correlation_pot_uniq").on(table.correlationId, table.potSlug, table.workspaceId),
	check("cross_hive_asks_direction_check", sql`direction = ANY (ARRAY['out'::text, 'in'::text])`),
	check("cross_hive_asks_kind_check", sql`kind = ANY (ARRAY['ask'::text, 'work-request'::text])`),
	check("cross_hive_asks_state_check", sql`state = ANY (ARRAY['queued'::text, 'sent'::text, 'answered'::text, 'declined'::text, 'expired'::text])`),
	check("cross_hive_asks_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "cross_pot_asks_pkey"}),

]);

export const crossPotBeaconHistoryInHarnessShared = harnessShared.table("cross_pot_beacon_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	hiveId: text("hive_id").notNull(),
	hivePubkey: text("hive_pubkey"),
	beacon: jsonb().notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cross_hive_beacon_history_hive_captured_idx").using("btree", table.hiveId.asc().nullsLast().op("text_ops"), table.capturedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("cross_hive_beacon_history_hive_id_nonempty", sql`hive_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "cross_pot_beacon_history_pkey"}),

]);

export const crossPotOutboxInHarnessShared = harnessShared.table("cross_pot_outbox", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	fromHivePubkey: text("from_hive_pubkey").notNull(),
	toHivePubkey: text("to_hive_pubkey").notNull(),
	kind: text().notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	correlationId: text("correlation_id"),
	sig: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastAttemptAt: bigint("last_attempt_at", { mode: "number" }).default(0).notNull(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("cross_hive_outbox_pending_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.id, table.potSlug, table.workspaceId], name: "cross_pot_outbox_pkey"}),
	check("cross_hive_outbox_kind_check", sql`kind = ANY (ARRAY['ask'::text, 'work-request'::text, 'answer'::text, 'decline'::text])`),
	check("cross_hive_outbox_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const cupClaimSpecRevisionsInHarnessShared = harnessShared.table("cup_claim_spec_revisions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.cup_claim_spec_revisions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	beeId: text("bee_id").notNull(),
	revision: integer().notNull(),
	spec: jsonb().notNull(),
	harnessSlug: text("harness_slug"),
	idOnly: boolean("id_only"),
	updatedBy: text("updated_by"),
	cause: text().notNull(),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cup_claim_spec_revisions_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.beeId.asc().nullsLast().op("text_ops"), table.supersededAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("cup_claim_spec_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("cup_claim_spec_revisions_bee_nonempty", sql`bee_id <> ''::text`),
	check("cup_claim_spec_revisions_cause_known", sql`cause = ANY (ARRAY['update'::text, 'delete'::text])`),
	check("cup_claim_spec_revisions_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const cupClaimSpecsInHarnessShared = harnessShared.table("cup_claim_specs", {
	workspaceId: text("workspace_id").default('default').notNull(),
	beeId: text("bee_id").notNull(),
	spec: jsonb().notNull(),
	revision: integer().default(0).notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	idOnly: boolean("id_only").default(false).notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	primaryKey({ columns: [table.beeId, table.workspaceId], name: "cup_claim_specs_pkey"}),
	pgPolicy("bee_claim_specs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("cup_claim_specs_bee_nonempty", sql`bee_id <> ''::text`),
	check("cup_claim_specs_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const cupKeeperInstancesInHarnessShared = harnessShared.table("cup_keeper_instances", {
	instanceId: text("instance_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	codeSha: text("code_sha").notNull(),
	genomeId: text("genome_id"),
	memorySnapshotId: text("memory_snapshot_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("beekeeper_instances_gen0_unique").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.codeSha.asc().nullsLast().op("text_ops")).where(sql`(genome_id IS NULL)`),
	unique("cup_keeper_instances_workspace_id_code_sha_genome_id_key").on(table.codeSha, table.genomeId, table.workspaceId),
	primaryKey({ columns: [table.instanceId], name: "cup_keeper_instances_pkey"}),

]);

export const cupKeeperRunsInHarnessShared = harnessShared.table("cup_keeper_runs", {
	runId: text("run_id").primaryKey().notNull(),
	instanceId: text("instance_id").notNull(),
	caseId: text("case_id").notNull(),
	caseVariant: text("case_variant").notNull(),
	caseTitle: text("case_title"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
	terminalState: text("terminal_state"),
	deterministicSignals: jsonb("deterministic_signals"),
	traceRef: text("trace_ref"),
}, (table) => [
	index("cup_keeper_runs_case_idx").using("btree", table.caseId.asc().nullsLast().op("text_ops")),
	index("cup_keeper_runs_instance_case_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops"), table.caseId.asc().nullsLast().op("text_ops")),
	index("cup_keeper_runs_instance_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [cupKeeperInstancesInHarnessShared.instanceId],
			name: "cup_keeper_runs_instance_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.runId], name: "cup_keeper_runs_pkey"}),

]);

export const cupKeeperScoresInHarnessShared = harnessShared.table("cup_keeper_scores", {
	runId: text("run_id").notNull(),
	judgeModel: text("judge_model").notNull(),
	rubricHash: text("rubric_hash").notNull(),
	judgeTemp: real("judge_temp"),
	weights: jsonb().notNull(),
	success: boolean(),
	tokensPerTask: numeric("tokens_per_task"),
	timeToGreenSecs: numeric("time_to_green_secs"),
	firstAttemptPass: boolean("first_attempt_pass"),
	recurrence: integer(),
	escalation: boolean(),
	recallHit: numeric("recall_hit"),
	d1: real().notNull(),
	d2: real().notNull(),
	d3: real().notNull(),
	composite: real().notNull(),
	rationale: text(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cup_keeper_scores_run_idx").using("btree", table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [cupKeeperRunsInHarnessShared.runId],
			name: "cup_keeper_scores_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.rubricHash, table.runId], name: "cup_keeper_scores_pkey"}),
]);

export const customerWorkspacesInHarnessShared = harnessShared.table("customer_workspaces", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	organizationId: text("organization_id").notNull(),
	workspaceHostId: text("workspace_host_id").notNull(),
	displayName: text("display_name").notNull(),
	state: text().default('provisioning').notNull(),
	createdByPrincipalKind: text("created_by_principal_kind").notNull(),
	createdByPrincipalId: text("created_by_principal_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	tenantConcurrencyLimit: integer("tenant_concurrency_limit").default(2).notNull(),
	providerConcurrencyLimit: integer("provider_concurrency_limit").default(8).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	monthlyLifecycleBudgetCents: bigint("monthly_lifecycle_budget_cents", { mode: "number" }),
	lifecycleBudgetPeriodStartedAt: timestamp("lifecycle_budget_period_started_at", { withTimezone: true, mode: 'string' }).default(sql`date_trunc('month'::text, now())`).notNull(),
	billingOwnerKind: text("billing_owner_kind"),
	billingOwnerId: text("billing_owner_id"),
	idleStopAfterMinutes: integer("idle_stop_after_minutes"),
	lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: 'string' }),
	lifecyclePolicyUpdatedAt: timestamp("lifecycle_policy_updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("customer_workspaces_idle_stop_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.lastActivityAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`((state = 'active'::text) AND (idle_stop_after_minutes IS NOT NULL))`),
	uniqueIndex("customer_workspaces_one_live_per_organization_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.organizationId.asc().nullsLast().op("text_ops")).where(sql`(state <> 'deleted'::text)`),
	index("customer_workspaces_organization_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.organizationId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.workspaceHostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "customer_workspaces_host_fk"
		}),
	primaryKey({ columns: [table.id, table.workspaceId], name: "customer_workspaces_pkey"}),
	unique("customer_workspaces_host_identity_uq").on(table.workspaceHostId, table.workspaceId),
	unique("customer_workspaces_org_identity_uq").on(table.id, table.organizationId, table.workspaceId),
	unique("customer_workspaces_connector_binding_uq").on(table.id, table.organizationId, table.workspaceHostId, table.workspaceId),
	pgPolicy("customer_workspaces_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("customer_workspaces_app_scope", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`((organization_id = NULLIF(current_setting('app.organization_id'::text, true), ''::text)) AND (id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)))`, withCheck: sql`((organization_id = NULLIF(current_setting('app.organization_id'::text, true), ''::text)) AND (id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)))` }),
	check("customer_workspaces_billing_owner_ck", sql`((billing_owner_kind IS NULL) AND (billing_owner_id IS NULL)) OR ((billing_owner_kind = ANY (ARRAY['organization'::text, 'customer'::text, 'platform'::text])) AND (btrim(billing_owner_id) <> ''::text))`),
	check("customer_workspaces_creator_ck", sql`(btrim(created_by_principal_kind) <> ''::text) AND (btrim(created_by_principal_id) <> ''::text)`),
	check("customer_workspaces_deleted_at_ck", sql`(state = 'deleted'::text) = (deleted_at IS NOT NULL)`),
	check("customer_workspaces_display_name_ck", sql`btrim(display_name) <> ''::text`),
	check("customer_workspaces_idle_stop_ck", sql`(idle_stop_after_minutes IS NULL) OR (idle_stop_after_minutes > 0)`),
	check("customer_workspaces_lifecycle_budget_ck", sql`(monthly_lifecycle_budget_cents IS NULL) OR (monthly_lifecycle_budget_cents >= 0)`),
	check("customer_workspaces_organization_id_ck", sql`btrim(organization_id) <> ''::text`),
	check("customer_workspaces_provider_concurrency_ck", sql`provider_concurrency_limit > 0`),
	check("customer_workspaces_state_ck", sql`state = ANY (ARRAY['provisioning'::text, 'active'::text, 'suspended'::text, 'offboarding'::text, 'deleted'::text])`),
	check("customer_workspaces_tenant_concurrency_ck", sql`tenant_concurrency_limit > 0`),
]);

export const datatypeRegistryInHarnessShared = harnessShared.table("datatype_registry", {
	id: text().notNull(),
	workspaceId: text("workspace_id").notNull(),
	title: text().notNull(),
	description: text().notNull(),
	tier: text().default('generic-kind').notNull(),
	workItemKind: text("work_item_kind"),
	payloadSchema: jsonb("payload_schema"),
	authoritativeWriter: text("authoritative_writer").default('papercusp').notNull(),
	selfImprovement: jsonb("self_improvement"),
	status: text().default('active').notNull(),
	published: boolean().default(false).notNull(),
	tags: text().array().default([]).notNull(),
	embedding: vector({ dimensions: 768 }),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reviewStatus: text("review_status").default('none').notNull(),
	potSlug: text("pot_slug"),
	display: jsonb(),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("datatype_registry_review_pending_idx").using("btree", table.reviewStatus.asc().nullsLast().op("text_ops")).where(sql`(review_status = 'pending'::text)`),
	index("datatype_registry_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
	uniqueIndex("datatype_registry_ws_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.workItemKind.asc().nullsLast().op("text_ops")).where(sql`(work_item_kind IS NOT NULL)`),
	index("datatype_registry_ws_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "datatype_registry_pkey"}),
	pgPolicy("datatype_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	pgPolicy("datatype_registry_approved_global_read", { as: "permissive", for: "select", to: ["public"], using: sql`(review_status = 'approved'::text)` }),
]);

export const decisionLedgerInHarnessShared = harnessShared.table("decision_ledger", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.decision_ledger_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	layer: text().default('action').notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	action: text().notNull(),
	capability: text(),
	tier: text(),
	category: text(),
	riskTier: text("risk_tier"),
	reversibility: text(),
	authority: text(),
	posture: text().notNull(),
	outcome: text().notNull(),
	outcomeCode: text("outcome_code"),
	revertHandle: text("revert_handle"),
	why: text(),
	links: jsonb(),
	actorRole: text("actor_role"),
	actorSpawnId: text("actor_spawn_id"),
	actorPrincipal: text("actor_principal"),
	transport: text(),
	durationMs: integer("duration_ms"),
	argsDigest: text("args_digest"),
	metadata: jsonb(),
	disposition: text(),
	revisitAt: timestamp("revisit_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("decision_ledger_ws_category_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_layer_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.layer.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_posture_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.posture.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	check("decision_ledger_disposition_check", sql`(disposition IS NULL) OR (disposition = ANY (ARRAY['act'::text, 'defer'::text, 'reject'::text, 'route-to-research'::text, 'no-op'::text]))`),
	check("decision_ledger_layer_check", sql`layer = ANY (ARRAY['action'::text, 'disposition'::text])`),
	check("decision_ledger_outcome_check", sql`outcome = ANY (ARRAY['ok'::text, 'error'::text])`),
	check("decision_ledger_posture_check", sql`posture = ANY (ARRAY['auto'::text, 'proposed'::text, 'gated'::text, 'rejected'::text])`),
]);

export const decisionModelCallsInHarnessShared = harnessShared.table("decision_model_calls", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.decision_model_calls_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	consumer: text(),
	provider: text().notNull(),
	requestedModel: text("requested_model").notNull(),
	returnedModel: text("returned_model"),
	questionIds: text("question_ids").array().default([]).notNull(),
	questionsSchemaSha256: text("questions_schema_sha256").notNull(),
	optionOrder: jsonb("option_order").default({}).notNull(),
	answers: jsonb(),
	outcome: text().notNull(),
	inconclusiveReason: text("inconclusive_reason"),
	inconclusiveDetail: text("inconclusive_detail"),
	httpStatus: integer("http_status"),
	attempts: integer().default(0).notNull(),
	latencyMs: integer("latency_ms").notNull(),
	inputTokens: integer("input_tokens"),
	outputTokens: integer("output_tokens"),
	costUsd: numeric("cost_usd", { precision: 14, scale:  8 }),
	subjectIds: text("subject_ids").array().default([]).notNull(),
	stateSha256: text("state_sha256").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("decision_model_calls_state_sha256_idx").using("btree", table.stateSha256.asc().nullsLast().op("text_ops")),
	index("decision_model_calls_ws_consumer_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.consumer.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	check("decision_model_calls_nonnegative", sql`(latency_ms >= 0) AND (attempts >= 0) AND ((input_tokens IS NULL) OR (input_tokens >= 0)) AND ((output_tokens IS NULL) OR (output_tokens >= 0)) AND ((cost_usd IS NULL) OR (cost_usd >= (0)::numeric))`),
	check("decision_model_calls_outcome_check", sql`outcome = ANY (ARRAY['answered'::text, 'inconclusive'::text])`),
	check("decision_model_calls_outcome_shape", sql`((outcome = 'answered'::text) AND (returned_model IS NOT NULL) AND (answers IS NOT NULL) AND (inconclusive_reason IS NULL)) OR ((outcome = 'inconclusive'::text) AND (inconclusive_reason IS NOT NULL) AND (answers IS NULL))`),
	check("decision_model_calls_sha256_shape", sql`(state_sha256 ~ '^[0-9a-f]{64}$'::text) AND (questions_schema_sha256 ~ '^[0-9a-f]{64}$'::text)`),
]);

export const dedupAdjudicationsInHarnessShared = harnessShared.table("dedup_adjudications", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	a: text().notNull(),
	b: text().notNull(),
	verdict: text().notNull(),
	canonical: text(),
	judgedBy: text("judged_by").notNull(),
	runId: text("run_id").notNull(),
	judgedAt: timestamp("judged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	evidence: jsonb(),
}, (table) => [
	primaryKey({ columns: [table.a, table.b, table.harnessSlug, table.workspaceId], name: "dedup_adjudications_pkey"}),
	check("dedup_adjudications_check", sql`a < b`),
	check("dedup_adjudications_check1", sql`(verdict <> 'r-finding-merge'::text) OR (canonical IS NOT NULL)`),
	check("dedup_adjudications_verdict_check", sql`verdict = ANY (ARRAY['r-finding-merge'::text, 'r-remedy-keep'::text, 'r-related'::text, 'distinct'::text])`),
]);

export const dedupEdgesInHarnessShared = harnessShared.table("dedup_edges", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	a: text().notNull(),
	b: text().notNull(),
	cos: real().notNull(),
	trgm: real(),
	runId: text("run_id").notNull(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dedup_edges_b_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.b.asc().nullsLast().op("text_ops")),
	index("dedup_edges_component_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.cos.asc().nullsLast().op("float4_ops")).where(sql`(cos >= (0.90)::double precision)`),
	primaryKey({ columns: [table.a, table.b, table.harnessSlug, table.workspaceId], name: "dedup_edges_pkey"}),
	check("dedup_edges_check", sql`a < b`),
	check("dedup_edges_cos_check", sql`(cos >= (0.0)::double precision) AND (cos <= (1.0)::double precision)`),
]);

export const dedupShardMapInHarnessShared = harnessShared.table("dedup_shard_map", {
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	shardId: integer("shard_id").notNull(),
	itemId: text("item_id").notNull(),
	role: text().notNull(),
}, (table) => [
	uniqueIndex("dedup_shard_map_one_member_uq").using("btree", table.runId.asc().nullsLast().op("text_ops"), table.itemId.asc().nullsLast().op("text_ops")).where(sql`(role = 'member'::text)`),
	index("dedup_shard_map_run_shard_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.shardId.asc().nullsLast().op("int4_ops"), table.role.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.itemId, table.role, table.runId, table.shardId], name: "dedup_shard_map_pkey"}),
	check("dedup_shard_map_role_check", sql`role = ANY (ARRAY['member'::text, 'ghost'::text])`),
]);

export const deferralPricingModelInHarnessShared = harnessShared.table("deferral_pricing_model", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.deferral_pricing_model_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	trainedAt: timestamp("trained_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	model: jsonb().notNull(),
	sampleItems: integer("sample_items").notNull(),
	sampleWeeks: numeric("sample_weeks").notNull(),
	createdBy: text("created_by"),
}, (table) => [
	index("deferral_pricing_model_latest_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.trainedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("deferral_pricing_model_items_nonneg", sql`sample_items >= 0`),
	check("deferral_pricing_model_weeks_nonneg", sql`sample_weeks >= (0)::numeric`),
	check("deferral_pricing_model_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const derivedReadSnapshotsInHarnessShared = harnessShared.table("derived_read_snapshots", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").default('').notNull(),
	key: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	computedAt: bigint("computed_at", { mode: "number" }).default(0).notNull(),
	computeMs: integer("compute_ms"),
	producerVersion: integer("producer_version").default(1).notNull(),
	error: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	errorAt: bigint("error_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("derived_read_snapshots_staleness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.computedAt.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.key, table.workspaceId], name: "derived_read_snapshots_pkey"}),
]);

export const desktopPerfRunsInHarnessShared = harnessShared.table("desktop_perf_runs", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	source: text().notNull(),
	status: text().notNull(),
	gitSha: text("git_sha"),
	runId: text("run_id"),
	measures: jsonb().default([]).notNull(),
	buildSha: text("build_sha"),
}, (table) => [
	index("desktop_perf_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdTs.desc().nullsFirst().op("int8_ops")),
]);

export const desktopSessionsInHarnessShared = harnessShared.table("desktop_sessions", {
	id: uuid().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	kind: text().notNull(),
	scope: text().notNull(),
	scopeRef: text("scope_ref").notNull(),
	hostRef: text("host_ref"),
	ownerPid: integer("owner_pid"),
	ownerBootId: text("owner_boot_id"),
	display: text().notNull(),
	displayWidth: integer("display_width").notNull(),
	displayHeight: integer("display_height").notNull(),
	displayDepth: integer("display_depth").default(24).notNull(),
	captureWidth: integer("capture_width").notNull(),
	captureHeight: integer("capture_height").notNull(),
	state: text().default('provisioning').notNull(),
	leaseHolder: text("lease_holder"),
	viewerMode: text("viewer_mode").default('none').notNull(),
	viewerActor: text("viewer_actor"),
	capabilities: jsonb().default({}).notNull(),
	ttlSec: integer("ttl_sec"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	releasedAt: timestamp("released_at", { withTimezone: true, mode: 'string' }),
	taskId: text("task_id"),
	idleAfterSec: integer("idle_after_sec"),
	frozenAt: timestamp("frozen_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("desktop_sessions_idle_idx").using("btree", sql`COALESCE(host_ref, ''::text)`, sql`last_active_at`).where(sql`(state <> ALL (ARRAY['released'::text, 'dead'::text]))`),
	uniqueIndex("desktop_sessions_live_display_uq").using("btree", sql`COALESCE(host_ref, ''::text)`, sql`display`).where(sql`(state <> ALL (ARRAY['released'::text, 'dead'::text]))`),
	index("desktop_sessions_live_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops")).where(sql`(state <> ALL (ARRAY['released'::text, 'dead'::text]))`),
	uniqueIndex("desktop_sessions_live_scope_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.scopeRef.asc().nullsLast().op("text_ops")).where(sql`(state <> ALL (ARRAY['released'::text, 'dead'::text]))`),
	index("desktop_sessions_owner_idx").using("btree", table.ownerBootId.asc().nullsLast().op("text_ops"), table.ownerPid.asc().nullsLast().op("int4_ops")).where(sql`(state <> ALL (ARRAY['released'::text, 'dead'::text]))`),
	check("desktop_sessions_frozen_at_ck", sql`(state <> 'frozen'::text) OR (frozen_at IS NOT NULL)`),
	check("desktop_sessions_geometry_ck", sql`(display_width > 0) AND (display_height > 0) AND (capture_width > 0) AND (capture_height > 0) AND (display_depth > 0)`),
	check("desktop_sessions_kind_ck", sql`kind = ANY (ARRAY['xvfb-local'::text, 'frame-slot'::text, 'vm-guest'::text, 'bwrap'::text, 'microvm'::text, 'kasmvnc'::text])`),
	check("desktop_sessions_released_at_ck", sql`((state = ANY (ARRAY['released'::text, 'dead'::text])) AND (released_at IS NOT NULL)) OR ((state <> ALL (ARRAY['released'::text, 'dead'::text])) AND (released_at IS NULL))`),
	check("desktop_sessions_scope_ck", sql`scope = ANY (ARRAY['pot'::text, 'agent'::text, 'workspace'::text])`),
	check("desktop_sessions_state_ck", sql`state = ANY (ARRAY['provisioning'::text, 'ready'::text, 'idle'::text, 'frozen'::text, 'released'::text, 'dead'::text])`),
	check("desktop_sessions_viewer_mode_ck", sql`viewer_mode = ANY (ARRAY['none'::text, 'watch'::text, 'takeover'::text])`),
]);

export const directiveSummariesConsolidatedInHarnessShared = harnessShared.table("directive_summaries_consolidated", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.directive_summaries_consolidated_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	directiveId: text("directive_id").notNull(),
	source: text().default('ceo').notNull(),
	summary: text().default('').notNull(),
	callerSlug: text("caller_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
	index("directive_summaries_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "directive_summaries_consolidated_pkey"}),
]);

export const docRevisionsInHarnessShared = harnessShared.table("doc_revisions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").default('papercup').notNull(),
	docId: text("doc_id").notNull(),
	seq: integer().notNull(),
	contentHash: text("content_hash").notNull(),
	contentSnapshot: text("content_snapshot").notNull(),
	rationale: text(),
	authorKind: text("author_kind").notNull(),
	authorId: text("author_id").notNull(),
	sessionId: text("session_id"),
	sessionKind: text("session_kind"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	unique("doc_revisions_ws_harness_doc_seq_key").on(table.docId, table.harnessSlug, table.seq, table.workspaceId),
]);

export const docSectionsInHarnessShared = harnessShared.table("doc_sections", {
	sourceKey: text("source_key").notNull(),
	slug: text().notNull(),
	anchor: text().default('').notNull(),
	title: text().default('').notNull(),
	url: text().default('').notNull(),
	content: text().default('').notNull(),
	pageSha: text("page_sha").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("doc_sections_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("doc_sections_embedding_mode_idx").using("btree", table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	primaryKey({ columns: [table.anchor, table.slug, table.sourceKey], name: "doc_sections_pkey"}),
]);

export const dreamRunsInHarnessShared = harnessShared.table("dream_runs", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	cycleId: text("cycle_id").notNull(),
	potSlug: text("pot_slug").notNull(),
	mode: text().notNull(),
	status: text().default('running').notNull(),
	fragmentRefs: jsonb("fragment_refs").default([]).notNull(),
	fragmentKinds: jsonb("fragment_kinds").default([]).notNull(),
	pairing: text(),
	similarity: doublePrecision(),
	dreamerModel: text("dreamer_model"),
	reviewerModel: text("reviewer_model"),
	dreamUsage: jsonb("dream_usage"),
	reviewUsage: jsonb("review_usage"),
	outcome: jsonb(),
	review: jsonb(),
	routedRef: text("routed_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	error: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	spendRecordedAt: timestamp("spend_recorded_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dream_runs_ws_cycle_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.cycleId.asc().nullsLast().op("text_ops"), table.startedAt.asc().nullsLast().op("timestamptz_ops")),
	index("dream_runs_ws_pot_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("dream_runs_ws_status_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.runId, table.workspaceId], name: "dream_runs_pkey"}),
	pgPolicy("dream_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("dream_runs_fragment_kinds_array_check", sql`jsonb_typeof(fragment_kinds) = 'array'::text`),
	check("dream_runs_fragment_refs_array_check", sql`jsonb_typeof(fragment_refs) = 'array'::text`),
	check("dream_runs_mode_check", sql`mode = ANY (ARRAY['manual'::text, 'auto'::text])`),
	check("dream_runs_pairing_check", sql`(pairing IS NULL) OR (pairing = ANY (ARRAY['banded'::text, 'random'::text]))`),
	check("dream_runs_status_check", sql`status = ANY (ARRAY['running'::text, 'no-pair'::text, 'abstained'::text, 'malformed'::text, 'duplicate'::text, 'rejected'::text, 'accepted'::text, 'error'::text])`),
	check("dream_runs_usage_nonnegative_check", sql`(input_tokens >= 0) AND (output_tokens >= 0) AND (cost_usd >= (0)::double precision)`),
]);

export const editAttributionLedgerInHarnessShared = harnessShared.table("edit_attribution_ledger", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.edit_attribution_ledger_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	repo: text(),
	file: text().notNull(),
	agentId: text("agent_id").notNull(),
	sessionId: text("session_id"),
	contributor: text(),
	workItemId: text("work_item_id"),
	planSlug: text("plan_slug"),
	intent: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	repoRoot: text("repo_root"),
	acquiredVia: text("acquired_via"),
}, (table) => [
	index("edit_attribution_ledger_repo_file_idx").using("btree", table.repoRoot.asc().nullsLast().op("text_ops"), table.file.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("edit_attribution_ledger_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(work_item_id IS NOT NULL)`),
]);

export const elConvCallsInHarnessShared = harnessShared.table("el_conv_calls", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	conversationId: text("conversation_id").notNull(),
	agentId: text("agent_id"),
	workspace: text(),
	durationSecs: integer("duration_secs").default(0).notNull(),
	ym: text().default(sql`to_char(now(), 'YYYY-MM'::text)`).notNull(),
}, (table) => [
	index("el_conv_calls_ym_idx").using("btree", table.ym.asc().nullsLast().op("text_ops")),
	unique("el_conv_calls_conversation_id_key").on(table.conversationId),
]);

export const embedCoverageSamplesInHarnessShared = harnessShared.table("embed_coverage_samples", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	surface: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalRows: bigint("total_rows", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eligibleRows: bigint("eligible_rows", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	embeddedRows: bigint("embedded_rows", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recentEligible: bigint("recent_eligible", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recentEmbedded: bigint("recent_embedded", { mode: "number" }),
	recentWindowHours: integer("recent_window_hours"),
}, (table) => [
	index("embed_coverage_samples_ws_surface_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const eventAwaitNodesInHarnessShared = harnessShared.table("event_await_nodes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_await_nodes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rootId: bigint("root_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	parentId: bigint("parent_id", { mode: "number" }),
	subscriberId: text("subscriber_id").notNull(),
	requiredCount: integer("required_count").notNull(),
	firedCount: integer("fired_count").default(0).notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	spec: jsonb(),
	wakeHandle: jsonb("wake_handle"),
	note: text(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	timeoutBehavior: text("timeout_behavior").default('expire').notNull(),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("event_await_nodes_parent_id_idx").using("btree", table.parentId.asc().nullsLast().op("int8_ops")),
	index("event_await_nodes_root_id_idx").using("btree", table.rootId.asc().nullsLast().op("int8_ops")),
	index("event_await_nodes_sweeper_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")).where(sql`((expires_ts IS NOT NULL) AND (fired_at IS NULL) AND (cancelled_at IS NULL))`),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "event_await_nodes_parent_id_fkey"
		}).onDelete("cascade"),
	check("event_await_nodes_required_count_check", sql`required_count >= 1`),
	check("event_await_nodes_timeout_behavior_check", sql`timeout_behavior = ANY (ARRAY['expire'::text, 'wake'::text])`),
]);

export const eventAwaitsInHarnessShared = harnessShared.table("event_awaits", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_awaits_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	subscriberId: text("subscriber_id").notNull(),
	eventKey: text("event_key").notNull(),
	policy: text().default('wake').notNull(),
	note: text(),
	wakeHandle: jsonb("wake_handle"),
	timeoutBehavior: text("timeout_behavior").default('expire').notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	firedReason: text("fired_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	once: boolean().default(true).notNull(),
	minSleepSec: integer("min_sleep_sec"),
	urgency: boolean().default(false).notNull(),
	payloadFilter: jsonb("payload_filter"),
	scopeKind: text("scope_kind"),
	scopeRef: text("scope_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	nodeId: bigint("node_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rootId: bigint("root_id", { mode: "number" }),
	memberFiredAt: timestamp("member_fired_at", { withTimezone: true, mode: 'string' }),
	memberPayload: jsonb("member_payload"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	causalGeneration: bigint("causal_generation", { mode: "number" }),
	expectedCondition: jsonb("expected_condition"),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
	firedBy: text("fired_by"),
	firedPayload: jsonb("fired_payload"),
	producerHealth: jsonb("producer_health"),
	timeoutVerification: jsonb("timeout_verification"),
	verificationClaimedAt: timestamp("verification_claimed_at", { withTimezone: true, mode: 'string' }),
	boundTo: jsonb("bound_to"),
	cancelReason: text("cancel_reason"),
	logicalGateKey: text("logical_gate_key"),
	firedDeliveryIntentAt: timestamp("fired_delivery_intent_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("event_awaits_announce_active").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((policy = 'announce'::text) AND (cancelled_at IS NULL))`),
	index("event_awaits_announce_current").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops"), table.causalGeneration.desc().nullsFirst().op("int8_ops")).where(sql`((policy = 'announce'::text) AND (superseded_at IS NULL))`),
	uniqueIndex("event_awaits_announce_generation_unique").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops"), table.causalGeneration.asc().nullsLast().op("int8_ops")).where(sql`((policy = 'announce'::text) AND (causal_generation IS NOT NULL))`),
	index("event_awaits_announce_logical_gate_active").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.logicalGateKey.asc().nullsLast().op("text_ops")).where(sql`((policy = 'announce'::text) AND (logical_gate_key IS NOT NULL) AND (superseded_at IS NULL) AND (cancelled_at IS NULL) AND (fired_at IS NULL))`),
	index("event_awaits_bound_to_active").using("btree", sql`((bound_to ->> 'kind'::text))`, sql`((bound_to ->> 'ref'::text))`).where(sql`((bound_to IS NOT NULL) AND (cancelled_at IS NULL))`),
	index("event_awaits_composed_node_idx").using("btree", table.nodeId.asc().nullsLast().op("int8_ops")).where(sql`(node_id IS NOT NULL)`),
	index("event_awaits_composed_root_idx").using("btree", table.rootId.asc().nullsLast().op("int8_ops")).where(sql`(root_id IS NOT NULL)`),
	uniqueIndex("event_awaits_exact_one_shot_one_per_subscriber_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((policy <> 'announce'::text) AND (once = true) AND (root_id IS NULL) AND (payload_filter IS NULL) AND ((note IS NULL) OR (note !~~ '[fleet:bench] %'::text)) AND (event_key !~~ '%*%'::text) AND (event_key !~~ '@%'::text) AND (fired_at IS NULL) AND (cancelled_at IS NULL) AND (superseded_at IS NULL))`),
	index("event_awaits_fired_wake_recovery").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`((once = true) AND (policy = 'wake'::text) AND (fired_at IS NOT NULL) AND (node_id IS NULL) AND (root_id IS NULL))`),
	uniqueIndex("event_awaits_inbox_wake_one_per_agent").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((policy = 'wake'::text) AND (once = false) AND (cancelled_at IS NULL) AND (event_key ~~ 'coord:inbox-wake:%'::text))`),
	index("event_awaits_operator_cancelled_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((cancelled_at IS NOT NULL) AND (cancel_reason = 'operator'::text))`),
	index("event_awaits_pattern_active").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`((event_key ~~ '%*%'::text) AND (fired_at IS NULL) AND (cancelled_at IS NULL))`),
	index("event_awaits_verified_timeout_due").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")).where(sql`((producer_health IS NOT NULL) AND (fired_at IS NULL) AND (cancelled_at IS NULL))`),
	index("idx_event_awaits_active_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL))`),
	index("idx_event_awaits_expiry").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL) AND (expires_ts IS NOT NULL))`),
	index("idx_event_awaits_subscriber").using("btree", table.subscriberId.asc().nullsLast().op("text_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL))`),
	pgPolicy("event_awaits_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("event_awaits_bound_to_shape", sql`(bound_to IS NULL) OR ((jsonb_typeof(bound_to) = 'object'::text) AND (bound_to ?& ARRAY['kind'::text, 'ref'::text]) AND ((bound_to - ARRAY['kind'::text, 'ref'::text]) = '{}'::jsonb) AND (jsonb_typeof((bound_to -> 'kind'::text)) = 'string'::text) AND (jsonb_typeof((bound_to -> 'ref'::text)) = 'string'::text) AND (length(btrim((bound_to ->> 'kind'::text))) > 0) AND (length(btrim((bound_to ->> 'ref'::text))) > 0))`),
	check("event_awaits_policy_check", sql`policy = ANY (ARRAY['wake'::text, 'notify'::text, 'announce'::text])`),
	check("event_awaits_timeout_behavior_check", sql`timeout_behavior = ANY (ARRAY['expire'::text, 'wake'::text])`),
]);

export const eventKeyFiresInHarnessShared = harnessShared.table("event_key_fires", {
	workspaceId: text("workspace_id").default('default').notNull(),
	eventKey: text("event_key").notNull(),
	firstFiredAt: timestamp("first_fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastFiredBy: text("last_fired_by"),
	lastPayload: jsonb("last_payload"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fireCount: bigint("fire_count", { mode: "number" }).default(1).notNull(),
}, (table) => [
	primaryKey({ columns: [table.eventKey, table.workspaceId], name: "event_key_fires_pkey"}),
]);

export const eventKeyRegistryInHarnessShared = harnessShared.table("event_key_registry", {
	workspaceId: text("workspace_id").notNull(),
	eventKey: text("event_key").notNull(),
	title: text().notNull(),
	description: text().notNull(),
	keyPattern: text("key_pattern"),
	contributor: text(),
	status: text().default('active').notNull(),
	published: boolean().default(false).notNull(),
	reviewStatus: text("review_status").default('none').notNull(),
	tags: text().array().default([]).notNull(),
	emitter: text(),
	emitterExists: boolean("emitter_exists"),
	emitSiteCount: integer("emit_site_count"),
	derivedAt: timestamp("derived_at", { withTimezone: true, mode: 'string' }),
	derivedFrom: text("derived_from"),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	embedding: vector({ dimensions: 768 }),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	payloadSchema: jsonb("payload_schema"),
}, (table) => [
	index("event_key_registry_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("event_key_registry_review_pending_idx").using("btree", table.reviewStatus.asc().nullsLast().op("text_ops")).where(sql`(review_status = 'pending'::text)`),
	index("event_key_registry_tags_idx").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("event_key_registry_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
	index("event_key_registry_underived_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`((derived_at IS NULL) OR (emitter_exists IS FALSE))`),
	primaryKey({ columns: [table.eventKey, table.workspaceId], name: "event_key_registry_pkey"}),
	pgPolicy("event_key_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	pgPolicy("event_key_registry_approved_global_read", { as: "permissive", for: "select", to: ["public"], using: sql`(review_status = 'approved'::text)` }),
	check("event_key_registry_derived_dated_ck", sql`(derived_at IS NOT NULL) OR ((emitter IS NULL) AND (emitter_exists IS NULL) AND (emit_site_count IS NULL))`),
	check("event_key_registry_emit_count_ck", sql`(emit_site_count IS NULL) OR (emit_site_count >= 0)`),
	check("event_key_registry_key_ck", sql`length(btrim(event_key)) > 0`),
	check("event_key_registry_payload_schema_ck", sql`(payload_schema IS NULL) OR (jsonb_typeof(payload_schema) = 'object'::text)`),
	check("event_key_registry_review_ck", sql`review_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text])`),
	check("event_key_registry_status_ck", sql`status = ANY (ARRAY['active'::text, 'retired'::text, 'superseded'::text])`),
]);

export const eventReactionsInHarnessShared = harnessShared.table("event_reactions", {
	dedupId: text("dedup_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ruleId: text("rule_id").notNull(),
	fire: text().notNull(),
	triggerTool: text("trigger_tool"),
	causeRootRunId: text("cause_root_run_id"),
	depth: integer().default(0).notNull(),
	status: text().default('fired').notNull(),
	errorMessage: text("error_message"),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	contributor: text(),
}, (table) => [
	index("event_reactions_contributor_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.contributor.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(contributor IS NOT NULL)`),
	index("event_reactions_rule_idx").using("btree", table.ruleId.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("event_reactions_ws_fired_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.dedupId], name: "event_reactions_pkey"}),

]);

export const eventWakeAttemptsInHarnessShared = harnessShared.table("event_wake_attempts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_wake_attempts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	subscriberId: text("subscriber_id").notNull(),
	eventKey: text("event_key").notNull(),
	outcome: text().notNull(),
	attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_event_wake_attempts_subscriber_key_time").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops"), table.attemptedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("event_wake_attempts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("event_wake_attempts_outcome_check", sql`outcome = ANY (ARRAY['queued'::text, 'missed'::text])`),
]);

export const eventWakeDeliveriesInHarnessShared = harnessShared.table("event_wake_deliveries", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_wake_deliveries_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	awaitId: bigint("await_id", { mode: "number" }).notNull(),
	subscriberId: text("subscriber_id").notNull(),
	eventKey: text("event_key").notNull(),
	payload: jsonb(),
	summary: text(),
	status: text().default('pending').notNull(),
	channel: text(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	urgent: boolean().default(false).notNull(),
	minSleepSec: integer("min_sleep_sec"),
	coalescedCount: integer("coalesced_count").default(1).notNull(),
	source: text(),
}, (table) => [
	index("event_wake_deliveries_await_lookup").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.awaitId.asc().nullsLast().op("int8_ops")),
	index("idx_event_wake_deliveries_due").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.nextAttemptAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text]))`),
	index("idx_event_wake_deliveries_subscriber").using("btree", table.subscriberId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("event_wake_deliveries_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("event_wake_deliveries_status_check", sql`status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text, 'delivered'::text, 'dropped'::text, 'dead'::text])`),
]);

export const executedActionsConsolidatedInHarnessShared = harnessShared.table("executed_actions_consolidated", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	actionId: uuid("action_id").notNull(),
	op: text(),
	callerSlug: text("caller_slug"),
	targetSlug: text("target_slug"),
	reason: text(),
	request: jsonb(),
	response: jsonb(),
	executedAt: timestamp("executed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("executed_actions_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.executedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.actionId, table.harnessSlug], name: "executed_actions_consolidated_pkey"}),
]);

export const experimentRunsInHarnessShared = harnessShared.table("experiment_runs", {
	workspaceId: text("workspace_id").notNull(),
	batteryId: text("battery_id").notNull(),
	testId: text("test_id").notNull(),
	tier: text().notNull(),
	arms: jsonb().default([]).notNull(),
	baselineId: text("baseline_id").notNull(),
	winner: text(),
	comparison: jsonb(),
	totalCostUsd: numeric("total_cost_usd").default('0').notNull(),
	budgetExhausted: boolean("budget_exhausted").default(false).notNull(),
	decision: text().default('proposed').notNull(),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("experiment_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("experiment_runs_ws_test_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.testId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.batteryId, table.workspaceId], name: "experiment_runs_pkey"}),
	pgPolicy("experiment_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("experiment_runs_decision_check", sql`decision = ANY (ARRAY['proposed'::text, 'applied'::text, 'rejected'::text])`),
	check("experiment_runs_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("experiment_runs_tier_check", sql`tier = ANY (ARRAY['offline'::text, 'shadow'::text, 'live'::text])`),
]);

export const externalPrerequisiteAttestationsInHarnessShared = harnessShared.table("external_prerequisite_attestations", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	prerequisiteKey: text("prerequisite_key").notNull(),
	capabilityKind: text("capability_kind").notNull(),
	present: boolean().notNull(),
	binding: jsonb().default({}).notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	provenance: text().notNull(),
	probeRef: text("probe_ref").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("external_prerequisite_attestations_expiring_key").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(present = true)`),
	index("external_prerequisite_attestations_scope_expiry_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.harnessSlug, table.prerequisiteKey, table.workspaceId], name: "external_prerequisite_attestations_pkey"}),
	check("external_prerequisite_attestations_binding_is_object_chk", sql`jsonb_typeof(binding) = 'object'::text`),
	check("external_prerequisite_attestations_expiry_chk", sql`expires_at > observed_at`),
	check("external_prerequisite_attestations_provenance_chk", sql`provenance = ANY (ARRAY['probe'::text, 'operator'::text, 'imported'::text])`),
]);

export const featureAuditConsolidatedInHarnessShared = harnessShared.table("feature_audit_consolidated", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	field: text().notNull(),
	oldValue: text("old_value"),
	newValue: text("new_value"),
	actor: text(),
}, (table) => [
	index("feature_audit_consolidated_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	pgPolicy("feature_audit_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const featureClaimsInHarnessShared = harnessShared.table("feature_claims", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	claimerPubkey: text("claimer_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	claimerGithubUserId: bigint("claimer_github_user_id", { mode: "number" }).notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }).notNull(),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
}, (table) => [
	index("feature_claims_outcome_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.outcome.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.seq, table.workspaceId], name: "feature_claims_pkey"}),
	pgPolicy("feature_claims_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const featureQueueInHarnessShared = harnessShared.table("feature_queue", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("feature_queue_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("feature_queue_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUserId.asc().nullsLast().op("int8_ops")).where(sql`(removed_at IS NULL)`),
	primaryKey({ columns: [table.featureId, table.githubUserId, table.harnessSlug, table.workspaceId], name: "feature_queue_pkey"}),
	pgPolicy("feature_queue_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const featureWorkingSetInHarnessShared = harnessShared.table("feature_working_set", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	clearedAt: timestamp("cleared_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("feature_working_set_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(cleared_at IS NULL)`),
	index("feature_working_set_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUserId.asc().nullsLast().op("int8_ops")).where(sql`(cleared_at IS NULL)`),
	primaryKey({ columns: [table.featureId, table.githubUserId, table.harnessSlug, table.workspaceId], name: "feature_working_set_pkey"}),
	pgPolicy("feature_working_set_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const federationProbesInHarnessShared = harnessShared.table("federation_probes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.federation_probes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	probeKey: text("probe_key").notNull(),
	emittedBy: text("emitted_by").notNull(),
	emittedAt: timestamp("emitted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }),
	drainedAt: timestamp("drained_at", { withTimezone: true, mode: 'string' }),
	replicatedAt: timestamp("replicated_at", { withTimezone: true, mode: 'string' }),
	mergedAt: timestamp("merged_at", { withTimezone: true, mode: 'string' }),
	memberGuardAt: timestamp("member_guard_at", { withTimezone: true, mode: 'string' }),
	projectedAt: timestamp("projected_at", { withTimezone: true, mode: 'string' }),
	status: text().default('pending').notNull(),
	refusalReason: text("refusal_reason"),
	detail: text(),
}, (table) => [
	uniqueIndex("federation_probes_probe_key").using("btree", table.probeKey.asc().nullsLast().op("text_ops")),
	index("federation_probes_recent").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.emittedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("federation_probes_status_check", sql`status = ANY (ARRAY['pending'::text, 'acked'::text, 'refused'::text, 'timed_out'::text])`),
]);

export const federationRefusedOpCountersInHarnessShared = harnessShared.table("federation_refused_op_counters", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	sourceHive: text("source_hive").notNull(),
	tableTag: text("table_tag").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.reason, table.sourceHive, table.tableTag, table.workspaceId], name: "federation_refused_op_counters_pkey"}),
	check("federation_refused_op_counters_nonneg", sql`count >= 0`),
	check("federation_refused_op_counters_reason_nonempty", sql`reason <> ''::text`),
	check("federation_refused_op_counters_slug_nonempty", sql`harness_slug <> ''::text`),
	check("federation_refused_op_counters_source_nonempty", sql`source_hive <> ''::text`),
	check("federation_refused_op_counters_tag_nonempty", sql`table_tag <> ''::text`),
	check("federation_refused_op_counters_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const fleetBriefSnapshotsInHarnessShared = harnessShared.table("fleet_brief_snapshots", {
	workspaceId: text("workspace_id").default('default').notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	ownerId: text("owner_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fireCount: bigint("fire_count", { mode: "number" }),
	baseline: jsonb(),
	observation: jsonb().notNull(),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.fleetSlug, table.ownerId, table.workspaceId], name: "fleet_brief_snapshots_pkey"}),
	check("fleet_brief_snapshots_fleet_nonempty", sql`fleet_slug <> ''::text`),
	check("fleet_brief_snapshots_owner_nonempty", sql`owner_id <> ''::text`),
	check("fleet_brief_snapshots_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const fleetEkgSessionsInHarnessShared = harnessShared.table("fleet_ekg_sessions", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	sessionId: text("session_id").notNull(),
	agent: text(),
	harnessSlug: text("harness_slug"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }).notNull(),
	eventCount: integer("event_count").notNull(),
	features: jsonb().notNull(),
	toolMix: jsonb("tool_mix").notNull(),
	bigrams: jsonb().notNull(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_ekg_sessions_ended_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.endedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.ownerId, table.sessionId, table.workspaceId], name: "fleet_ekg_sessions_pkey"}),
	check("fleet_ekg_sessions_event_count_check", sql`event_count > 0`),
]);

export const fleetEkgShiftsInHarnessShared = harnessShared.table("fleet_ekg_shifts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.fleet_ekg_shifts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	windowDate: date("window_date").notNull(),
	feature: text().notNull(),
	kind: text().notNull(),
	score: doublePrecision().notNull(),
	severity: text().notNull(),
	direction: text(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	windowEnd: timestamp("window_end", { withTimezone: true, mode: 'string' }).notNull(),
	baselineSessions: integer("baseline_sessions").notNull(),
	windowSessions: integer("window_sessions").notNull(),
	baselineSummary: doublePrecision("baseline_summary"),
	windowSummary: doublePrecision("window_summary"),
	attributed: boolean().default(false).notNull(),
	ledgerCandidates: jsonb("ledger_candidates"),
	notifiedAt: timestamp("notified_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_ekg_shifts_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.windowDate.desc().nullsFirst().op("date_ops")),
	unique("fleet_ekg_shifts_dedup").on(table.feature, table.windowDate, table.workspaceId),
	check("fleet_ekg_shifts_kind_check", sql`kind = ANY (ARRAY['numeric'::text, 'mix'::text, 'bigram'::text])`),
	check("fleet_ekg_shifts_severity_check", sql`severity = ANY (ARRAY['moderate'::text, 'major'::text])`),
]);

export const fleetGovernorInHarnessShared = harnessShared.table("fleet_governor", {
	workspaceId: text("workspace_id").notNull(),
	kind: text().notNull(),
	scopeKey: text("scope_key").notNull(),
	capacity: numeric(),
	refillPerSec: numeric("refill_per_sec"),
	tokens: numeric(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	cbState: text("cb_state"),
	cbFailures: integer("cb_failures").default(0).notNull(),
	cbThreshold: integer("cb_threshold"),
	cbCooldownSec: integer("cb_cooldown_sec"),
	cbOpenedAt: timestamp("cb_opened_at", { withTimezone: true, mode: 'string' }),
	credits: integer(),
	creditMax: integer("credit_max"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.kind, table.scopeKey, table.workspaceId], name: "fleet_governor_pkey"}),
	check("fleet_governor_kind_chk", sql`kind = ANY (ARRAY['bucket'::text, 'circuit'::text, 'credit'::text])`),
]);

export const fleetInvariantsInHarnessShared = harnessShared.table("fleet_invariants", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	fleetSlug: text("fleet_slug").notNull(),
	name: text().notNull(),
	description: text(),
	querySql: text("query_sql").notNull(),
	severity: text().default('warn').notNull(),
	active: boolean().default(true).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_invariants_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`active`),
	uniqueIndex("fleet_invariants_scope_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	check("fleet_invariants_severity_valid", sql`severity = ANY (ARRAY['warn'::text, 'critical'::text])`),
]);

export const fleetMembershipEventsInHarnessShared = harnessShared.table("fleet_membership_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.fleet_membership_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	ownerLabel: text("owner_label"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	event: text().default('join').notNull(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("fleet_membership_events_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("int8_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("fleet_membership_events_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("int8_ops")),
]);

export const fleetSagasInHarnessShared = harnessShared.table("fleet_sagas", {
	workspaceId: text("workspace_id").notNull(),
	sagaId: text("saga_id").notNull(),
	name: text().notNull(),
	status: text().default('running').notNull(),
	steps: jsonb().default([]).notNull(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_sagas_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'running'::text)`),
	primaryKey({ columns: [table.sagaId, table.workspaceId], name: "fleet_sagas_pkey"}),
]);

export const fleetTombstonesInHarnessShared = harnessShared.table("fleet_tombstones", {
	workspaceId: text("workspace_id").notNull(),
	refKind: text("ref_kind").notNull(),
	refId: text("ref_id").notNull(),
	reason: text().default('').notNull(),
	deletedBy: text("deleted_by"),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	gcAfter: timestamp("gc_after", { withTimezone: true, mode: 'string' }).notNull(),
	restoredAt: timestamp("restored_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("fleet_tombstones_gc_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.gcAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(restored_at IS NULL)`),
	primaryKey({ columns: [table.refId, table.refKind, table.workspaceId], name: "fleet_tombstones_pkey"}),
]);

export const flushGateRefusalsInHarnessShared = harnessShared.table("flush_gate_refusals", {
	boundary: text().notNull(),
	ownerId: text("owner_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flush_gate_refusals_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.boundary, table.ownerId], name: "flush_gate_refusals_pkey"}),
]);

export const frozenRepairEditLedgerInHarnessShared = harnessShared.table("frozen_repair_edit_ledger", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	candidate: text().notNull(),
	agent: text().notNull(),
	path: text().notNull(),
	hunk: jsonb().notNull(),
	hunkKind: text("hunk_kind").notNull(),
	hunkSha256: text("hunk_sha256").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	atMs: bigint("at_ms", { mode: "number" }).notNull(),
	toolUseId: text("tool_use_id").notNull(),
	editIndex: integer("edit_index").default(0).notNull(),
	workItem: text("work_item"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("frozen_repair_edit_ledger_agent_idx").using("btree", table.candidate.asc().nullsLast().op("text_ops"), table.agent.asc().nullsLast().op("text_ops"), table.atMs.asc().nullsLast().op("int8_ops")),
	index("frozen_repair_edit_ledger_lineage_path_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.candidate.asc().nullsLast().op("text_ops"), table.path.asc().nullsLast().op("text_ops"), table.atMs.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	unique("frozen_repair_edit_ledger_idempotent").on(table.agent, table.candidate, table.editIndex, table.installSlug, table.path, table.toolUseId, table.workspaceId),
	check("frozen_repair_edit_ledger_agent_check", sql`(length(btrim(agent)) >= 1) AND (length(btrim(agent)) <= 200)`),
	check("frozen_repair_edit_ledger_at_ms_check", sql`at_ms > 0`),
	check("frozen_repair_edit_ledger_candidate_check", sql`candidate ~ '^[0-9a-f]{40,64}$'::text`),
	check("frozen_repair_edit_ledger_edit_index_check", sql`edit_index >= 0`),
	check("frozen_repair_edit_ledger_hunk_kind_check", sql`hunk_kind = ANY (ARRAY['edit'::text, 'write'::text, 'oversize'::text])`),
	check("frozen_repair_edit_ledger_hunk_sha256_check", sql`hunk_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("frozen_repair_edit_ledger_path_check", sql`(length(path) >= 1) AND (length(path) <= 1024)`),
	check("frozen_repair_edit_ledger_tool_use_id_check", sql`(length(tool_use_id) >= 1) AND (length(tool_use_id) <= 200)`),
]);

export const gateDecisionsInHarnessShared = harnessShared.table("gate_decisions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.gate_decisions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	gate: text().notNull(),
	expect: text().notNull(),
	verdict: text().notNull(),
	value: doublePrecision(),
	threshold: doublePrecision(),
	subject: text(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("gate_decisions_decided_at_idx").using("btree", table.decidedAt.asc().nullsLast().op("timestamptz_ops")),
	index("gate_decisions_gate_decided_at_idx").using("btree", table.gate.asc().nullsLast().op("text_ops"), table.decidedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("gate_decisions_expect_check", sql`expect = ANY (ARRAY['discriminates'::text, 'guards'::text])`),
	check("gate_decisions_verdict_check", sql`verdict = ANY (ARRAY['pass'::text, 'reject'::text])`),
]);

export const gateVerdictsInHarnessShared = harnessShared.table("gate_verdicts", {
	workspaceId: text("workspace_id").notNull(),
	verdictId: text("verdict_id").notNull(),
	harnessSlug: text("harness_slug"),
	schemaV: integer("schema_v").default(1).notNull(),
	repoKey: text("repo_key").notNull(),
	stagingSha: text("staging_sha").notNull(),
	shardId: text("shard_id").notNull(),
	inputsHash: text("inputs_hash").notNull(),
	verdict: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }).default(0).notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verdictTs: bigint("verdict_ts", { mode: "number" }).notNull(),
	sig: text().notNull(),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("gate_verdicts_shard_inputs_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repoKey.asc().nullsLast().op("text_ops"), table.shardId.asc().nullsLast().op("text_ops"), table.inputsHash.asc().nullsLast().op("text_ops")),
	index("gate_verdicts_staging_sha_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repoKey.asc().nullsLast().op("text_ops"), table.stagingSha.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.verdictId, table.workspaceId], name: "gate_verdicts_pkey"}),
	pgPolicy("gate_verdicts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("gate_verdicts_verdict_check", sql`verdict = ANY (ARRAY['pass'::text, 'fail'::text])`),
]);

export const gatewayPayloadBlobsInHarnessShared = harnessShared.table("gateway_payload_blobs", {
	blobKey: text("blob_key").notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	bytes: byteaCustom("bytes").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteLength: bigint("byte_length", { mode: "number" }).notNull(),
	contentType: text("content_type"),
	refCount: integer("ref_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("gateway_payload_blobs_expiry_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(expires_at IS NOT NULL)`),
	index("gateway_payload_blobs_gc_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.lastAccessedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(ref_count = 0)`),
	primaryKey({ columns: [table.blobKey, table.workspaceId], name: "gateway_payload_blobs_pkey"}),
	check("gateway_payload_blobs_key_is_sha256", sql`blob_key ~ '^[0-9a-f]{64}$'::text`),
	check("gateway_payload_blobs_len_nonneg", sql`byte_length >= 0`),
	check("gateway_payload_blobs_refcount_nonneg", sql`ref_count >= 0`),
]);

export const gatewayStallEventsInHarnessShared = harnessShared.table("gateway_stall_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.gateway_stall_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	accountId: text("account_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	soonestResetAt: bigint("soonest_reset_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recordedAtMs: bigint("recorded_at_ms", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("gateway_stall_events_recorded_at_idx").using("btree", table.recordedAtMs.asc().nullsLast().op("int8_ops")),
	pgPolicy("gateway_stall_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const gitExportOutboxInHarnessShared = harnessShared.table("git_export_outbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	tableName: text("table_name").notNull(),
	op: text().notNull(),
	key: text().notNull(),
	row: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	exportedAt: bigint("exported_at", { mode: "number" }),
}, (table) => [
	index("git_export_outbox_drain_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.exportedAt.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	check("git_export_outbox_op_check", sql`op = ANY (ARRAY['put'::text, 'del'::text])`),
]);

export const gitSyncCommitAttributionInHarnessShared = harnessShared.table("git_sync_commit_attribution", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.git_sync_commit_attribution_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	repo: text().notNull(),
	commitSha: text("commit_sha").notNull(),
	file: text().notNull(),
	agentId: text("agent_id"),
	sessionId: text("session_id"),
	contributor: text(),
	workItemId: text("work_item_id"),
	planSlug: text("plan_slug"),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("git_sync_commit_attr_repo_file_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repo.asc().nullsLast().op("text_ops"), table.file.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("git_sync_commit_attr_sha_idx").using("btree", table.commitSha.asc().nullsLast().op("text_ops")),
	index("git_sync_commit_attr_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(work_item_id IS NOT NULL)`),
]);

export const goalPotsInHarnessShared = harnessShared.table("goal_pots", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.goal_pots_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	goalId: text("goal_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text().default('contributing').notNull(),
	addedAt: timestamp("added_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	addedBy: text("added_by"),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	removedBy: text("removed_by"),
	note: text(),
	killCriterion: text("kill_criterion"),
}, (table) => [
	index("goal_pots_by_goal_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops")).where(sql`(removed_at IS NULL)`),
	index("goal_pots_by_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(removed_at IS NULL)`),
	uniqueIndex("goal_pots_live_pair_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(removed_at IS NULL)`),
	uniqueIndex("goal_pots_one_owner_per_pot").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`((role = 'owner'::text) AND (removed_at IS NULL))`),
	foreignKey({
			columns: [table.goalId],
			foreignColumns: [goalsInHarnessShared.id],
			name: "goal_pots_goal_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("goal_pots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("goal_pots_harness_nonempty", sql`harness_slug <> ''::text`),
	check("goal_pots_role_check", sql`role = ANY (ARRAY['owner'::text, 'contributing'::text])`),
	check("goal_pots_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const goalsInHarnessShared = harnessShared.table("goals", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	title: text().notNull(),
	body: text(),
	parentId: text("parent_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))`),
	killCriterion: text("kill_criterion"),
	tripwires: jsonb(),
	launchSettings: jsonb("launch_settings"),
	standing: boolean().default(false).notNull(),
	budgetWindowSec: integer("budget_window_sec"),
	propertySchema: jsonb("property_schema").default({}).notNull(),
	properties: jsonb().default({}).notNull(),
	inputSchema: jsonb("input_schema"),
	inputs: jsonb(),
	outputSchema: jsonb("output_schema"),
	outputs: jsonb(),
}, (table) => [
	index("goals_install_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops")),
	index("goals_parent_idx").using("btree", table.parentId.asc().nullsLast().op("text_ops")),
	index("goals_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("goals_standing_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops")).where(sql`standing`),
	index("goals_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("goals_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "goals_parent_id_fkey"
		}).onDelete("set null"),
	pgPolicy("goals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("goals_budget_window_sec_positive", sql`(budget_window_sec IS NULL) OR (budget_window_sec > 0)`),
	check("goals_properties_object", sql`jsonb_typeof(properties) = 'object'::text`),
	check("goals_property_schema_object", sql`jsonb_typeof(property_schema) = 'object'::text`),
	check("goals_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const gymAutoloopConfigInHarnessShared = harnessShared.table("gym_autoloop_config", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	enabled: boolean().default(false).notNull(),
	budgetUsd: doublePrecision("budget_usd"),
	spentUsd: doublePrecision("spent_usd").default(0).notNull(),
	status: text().default('idle').notNull(),
	lastCycle: integer("last_cycle"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastCycleAt: bigint("last_cycle_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "gym_autoloop_config_pkey"}),
	pgPolicy("gym_autoloop_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const gymChampionOutcomesInHarnessShared = harnessShared.table("gym_champion_outcomes", {
	proposalId: text("proposal_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text().notNull(),
	variantId: text("variant_id"),
	cycle: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptedAt: bigint("accepted_at", { mode: "number" }).notNull(),
	baselineDevAnchorDelta: doublePrecision("baseline_dev_anchor_delta"),
	baselineCostDelta: doublePrecision("baseline_cost_delta"),
	baselineProbeStatus: text("baseline_probe_status"),
	baselineRuns: integer("baseline_runs").default(0).notNull(),
	baselineSucceeded: integer("baseline_succeeded").default(0).notNull(),
	baselineFailed: integer("baseline_failed").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	postWindowEndsAt: bigint("post_window_ends_at", { mode: "number" }).notNull(),
	postRuns: integer("post_runs"),
	postSucceeded: integer("post_succeeded"),
	postFailed: integer("post_failed"),
	successRateDelta: doublePrecision("success_rate_delta"),
	verdict: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	evaluatedAt: bigint("evaluated_at", { mode: "number" }),
}, (table) => [
	index("gym_champion_outcomes_pending_due_idx").using("btree", table.postWindowEndsAt.asc().nullsLast().op("int8_ops")).where(sql`(verdict = 'pending'::text)`),
	index("gym_champion_outcomes_ws_harness_accepted_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.acceptedAt.desc().nullsFirst().op("int8_ops")),
	pgPolicy("gym_champion_outcomes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.proposalId], name: "gym_champion_outcomes_pkey"}),

]);

export const gymProposalsInHarnessShared = harnessShared.table("gym_proposals", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	cycle: integer().default(0).notNull(),
	variantId: text("variant_id"),
	role: text().notNull(),
	originalMd: text("original_md"),
	proposedMd: text("proposed_md").notNull(),
	rationale: text(),
	devAnchorDelta: doublePrecision("dev_anchor_delta"),
	costDelta: doublePrecision("cost_delta"),
	probeStatus: text("probe_status"),
	status: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedAt: bigint("decided_at", { mode: "number" }),
	taskCorpus: text("task_corpus").default('synthetic').notNull(),
	candidateVerdict: jsonb("candidate_verdict"),
}, (table) => [
	index("gym_proposals_candidate_verdict_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(candidate_verdict IS NOT NULL)`),
	index("gym_proposals_ws_harness_cycle_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.cycle.asc().nullsLast().op("int4_ops")),
	index("gym_proposals_ws_harness_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	pgPolicy("gym_proposals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("gym_proposals_task_corpus_check", sql`task_corpus = ANY (ARRAY['synthetic'::text, 'real'::text, 'mixed'::text])`),
]);

export const gymQdArchiveInHarnessShared = harnessShared.table("gym_qd_archive", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	nicheKey: text("niche_key").notNull(),
	candidateId: text("candidate_id").notNull(),
	scope: text().notNull(),
	domain: text().notNull(),
	risk: text().notNull(),
	fitness: doublePrecision().notNull(),
	descriptor: jsonb().notNull(),
	source: text().default('gym').notNull(),
	rationale: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	federatable: boolean().default(false).notNull(),
	outcomeRecord: jsonb("outcome_record"),
}, (table) => [
	index("gym_qd_archive_candidate_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.candidateId.asc().nullsLast().op("text_ops")),
	index("gym_qd_archive_source_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.source.asc().nullsLast().op("text_ops")),
	index("gym_qd_archive_ws_harness_fitness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fitness.desc().nullsFirst().op("float8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.nicheKey, table.workspaceId], name: "gym_qd_archive_pkey"}),
	pgPolicy("gym_qd_archive_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const gymQdForeignElitesInHarnessShared = harnessShared.table("gym_qd_foreign_elites", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	nicheKey: text("niche_key").notNull(),
	sourceHive: text("source_hive").notNull(),
	candidateId: text("candidate_id").notNull(),
	scope: text().notNull(),
	domain: text().notNull(),
	risk: text().notNull(),
	fitness: doublePrecision().notNull(),
	descriptor: jsonb().notNull(),
	rationale: text(),
	noveltyGift: boolean("novelty_gift").default(false).notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	outcomeRecord: jsonb("outcome_record"),
	outcomeVerified: boolean("outcome_verified").default(false).notNull(),
}, (table) => [
	index("gym_qd_foreign_elites_by_source").using("btree", table.sourceHive.asc().nullsLast().op("text_ops")),
	index("gym_qd_foreign_elites_fitness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fitness.desc().nullsFirst().op("float8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.nicheKey, table.sourceHive, table.workspaceId], name: "gym_qd_foreign_elites_pkey"}),
	pgPolicy("gym_qd_foreign_elites_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessArchivesInHarnessShared = harnessShared.table("harness_archives", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_archives_slug_phase_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.phase.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id, table.phase], name: "harness_archives_pkey"}),
	pgPolicy("harness_archives_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessBrainstormInHarnessShared = harnessShared.table("harness_brainstorm", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	content: text().default('').notNull(),
	canvas: jsonb(),
	mindmap: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	contentTsv: tsvectorCustom("content_tsv"),
	contentEmbedding: vector("content_embedding", { dimensions: 768 }),
	contentEmbeddingMode: text("content_embedding_mode"),
	contentEmbeddingProfile: text("content_embedding_profile"),
}, (table) => [
	index("harness_brainstorm_content_embedding_hnsw").using("hnsw", table.contentEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_brainstorm_content_embedding_mode_idx").using("btree", table.contentEmbeddingMode.asc().nullsLast().op("text_ops")).where(sql`(content_embedding_mode IS NOT NULL)`),
	index("harness_brainstorm_tsv_idx").using("gin", table.contentTsv.asc().nullsLast().op("tsvector_ops")),
	index("harness_brainstorm_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_brainstorm_pkey"}),
	pgPolicy("harness_brainstorm_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessCheckpointsInHarnessShared = harnessShared.table("harness_checkpoints", {
	harnessSlug: text("harness_slug").notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	waitingSinceMs: bigint("waiting_since_ms", { mode: "number" }).default(0).notNull(),
	granted: boolean().default(false).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	consumed: boolean().default(false).notNull(),
}, (table) => [
	index("harness_checkpoints_slug_waiting_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.waitingSinceMs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.name], name: "harness_checkpoints_pkey"}),
	pgPolicy("harness_checkpoints_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessChunkPlansInHarnessShared = harnessShared.table("harness_chunk_plans", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	chunkId: text("chunk_id").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	files: jsonb().notNull(),
	description: text().notNull(),
	status: text().default('pending').notNull(),
	strikes: integer().default(0).notNull(),
	lastError: text("last_error"),
	commitSha: text("commit_sha"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	spawnedBySpawnId: text("spawned_by_spawn_id"),
}, (table) => [
	index("chunk_plans_by_spawned_by").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.spawnedBySpawnId.asc().nullsLast().op("text_ops")).where(sql`(spawned_by_spawn_id IS NOT NULL)`),
	index("idx_chunk_plans_by_feature").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.chunkIndex.asc().nullsLast().op("int4_ops")),
	index("idx_chunk_plans_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['in_progress'::text, 'failing'::text, 'escalated'::text]))`),
	primaryKey({ columns: [table.chunkId, table.featureId, table.harnessSlug, table.workspaceId], name: "harness_chunk_plans_pkey"}),
	pgPolicy("chunk_plans_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessDecisionsInHarnessShared = harnessShared.table("harness_decisions", {
	harnessSlug: text("harness_slug").notNull(),
	lineHash: text("line_hash").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	iso: text().default('').notNull(),
	verb: text().notNull(),
	args: text().default('').notNull(),
	iteration: integer(),
	isGhost: boolean("is_ghost").default(false).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	bodyTsv: tsvectorCustom("body_tsv"),
	bodyEmbedding: vector("body_embedding", { dimensions: 768 }),
	bodyEmbeddingMode: text("body_embedding_mode"),
	bodyEmbeddingProfile: text("body_embedding_profile"),
}, (table) => [
	index("harness_decisions_body_embedding_hnsw").using("hnsw", table.bodyEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_decisions_body_embedding_mode_idx").using("btree", table.bodyEmbeddingMode.asc().nullsLast().op("text_ops")).where(sql`(body_embedding_mode IS NOT NULL)`),
	index("harness_decisions_body_tsv_idx").using("gin", table.bodyTsv.asc().nullsLast().op("tsvector_ops")),
	index("harness_decisions_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.lineHash], name: "harness_decisions_pkey"}),
	pgPolicy("harness_decisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessDesignArtifactsInHarnessShared = harnessShared.table("harness_design_artifacts", {
	id: text().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	metadata: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("hda_created_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.desc().nullsFirst().op("int8_ops")),
	index("hda_feature_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("hda_kind_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "harness_design_artifacts_pkey"}),
	check("hda_kind_chk", sql`kind = ANY (ARRAY['spec'::text, 'sketch'::text, 'screenshot'::text, 'annotation'::text, 'rejected_candidate'::text, 'review'::text, 'ratified_reference'::text, 'compare_result'::text])`),
]);

export const harnessDocPartsInHarnessShared = harnessShared.table("harness_doc_parts", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	docId: text("doc_id").notNull(),
	partKey: text("part_key").notNull(),
	kind: text().notNull(),
	body: text().default('').notNull(),
	ordinal: integer().default(0).notNull(),
	tombstone: boolean().default(false).notNull(),
	origin: text().default('local').notNull(),
	author: text(),
	partFedKey: text("part_fed_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	clientScope: text("client_scope").array().default([]).notNull(),
	projectRank: integer("project_rank").default(1000).notNull(),
	targetSection: text("target_section"),
	rationalePartKey: text("rationale_part_key"),
	stackScope: text("stack_scope").array().default([]).notNull(),
}, (table) => [
	index("harness_doc_parts_by_doc").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.docId.asc().nullsLast().op("text_ops"), table.ordinal.asc().nullsLast().op("int4_ops")),
	index("harness_doc_parts_projection_idx").using("gin", table.clientScope.asc().nullsLast().op("array_ops")).where(sql`((tombstone = false) AND (cardinality(client_scope) > 0))`),
	index("harness_doc_parts_stack_scope_idx").using("gin", table.stackScope.asc().nullsLast().op("array_ops")).where(sql`((tombstone = false) AND (cardinality(stack_scope) > 0))`),
	primaryKey({ columns: [table.docId, table.harnessSlug, table.partKey, table.workspaceId], name: "harness_doc_parts_pkey"}),
	check("harness_doc_parts_addressed_must_project", sql`(cardinality(stack_scope) = 0) OR (cardinality(client_scope) > 0)`),
	check("harness_doc_parts_kind_check", sql`kind = ANY (ARRAY['invariant'::text, 'pointer'::text, 'recipe'::text, 'prose'::text])`),
	check("harness_doc_parts_projected_needs_section", sql`(cardinality(client_scope) = 0) OR (target_section IS NOT NULL)`),
	check("harness_doc_parts_prose_never_projects", sql`(kind <> 'prose'::text) OR (cardinality(client_scope) = 0)`),
	check("harness_doc_parts_rationale_only_on_recipe", sql`(rationale_part_key IS NULL) OR (kind = 'recipe'::text)`),
	check("harness_doc_parts_stack_scope_shape", sql`(cardinality(stack_scope) = 0) OR (array_to_string(stack_scope, ' '::text) ~ '^((blueprint|slot|role):[^[:space:]:]+|package:[0-9a-f]{64})( ((blueprint|slot|role):[^[:space:]:]+|package:[0-9a-f]{64}))*$'::text)`),
]);

export const harnessDockLayoutsInHarnessShared = harnessShared.table("harness_dock_layouts", {
	workspaceId: text("workspace_id").notNull(),
	userId: text("user_id").notNull(),
	layoutName: text("layout_name").default('default').notNull(),
	schemaVersion: integer("schema_version").default(1).notNull(),
	layoutJson: jsonb("layout_json").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.layoutName, table.userId, table.workspaceId], name: "harness_dock_layouts_pkey"}),
	pgPolicy("harness_dock_layouts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessDocsInHarnessShared = harnessShared.table("harness_docs", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	docId: text("doc_id").notNull(),
	source: text().default('manual').notNull(),
	subjectRef: jsonb("subject_ref").default([]).notNull(),
	anchorPaths: text("anchor_paths").array().default([]).notNull(),
	generatedFromSha: text("generated_from_sha"),
	lastVerifiedSha: text("last_verified_sha"),
	lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: 'string' }),
	overlay: text(),
	status: text().default('untracked').notNull(),
	statusDetail: text("status_detail"),
	statusCheckedAt: timestamp("status_checked_at", { withTimezone: true, mode: 'string' }),
	regenEnqueuedAt: timestamp("regen_enqueued_at", { withTimezone: true, mode: 'string' }),
	reverifyFlaggedAt: timestamp("reverify_flagged_at", { withTimezone: true, mode: 'string' }),
	title: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	regenAttempts: integer("regen_attempts").default(0).notNull(),
	reverifyAttempts: integer("reverify_attempts").default(0).notNull(),
	content: text().default('').notNull(),
	contentHash: text("content_hash").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	version: bigint({ mode: "number" }).default(0).notNull(),
	frontmatter: jsonb(),
	contentMode: text("content_mode").default('authored').notNull(),
	search: tsvectorCustom("_search"),
	projectedClients: jsonb("projected_clients").default({}).notNull(),
	retiredAt: timestamp("retired_at", { withTimezone: true, mode: 'string' }),
	retiredReason: text("retired_reason"),
}, (table) => [
	index("harness_docs_anchor_paths_idx").using("gin", table.anchorPaths.asc().nullsLast().op("array_ops")),
	index("harness_docs_live_authored_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`((retired_at IS NULL) AND (content_mode = 'authored'::text))`),
	index("harness_docs_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("harness_docs_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.docId, table.harnessSlug, table.workspaceId], name: "harness_docs_pkey"}),
	pgPolicy("harness_docs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_docs_content_mode_check", sql`content_mode = ANY (ARRAY['authored'::text, 'composed'::text])`),
	check("harness_docs_doc_id_nonempty", sql`doc_id <> ''::text`),
	check("harness_docs_source_check", sql`source = ANY (ARRAY['generated'::text, 'manual'::text, 'augmented'::text])`),
	check("harness_docs_status_check", sql`status = ANY (ARRAY['fresh'::text, 'stale'::text, 'review'::text, 'untracked'::text, 'unknown'::text])`),
	check("harness_docs_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harnessEscalationsInHarnessShared = harnessShared.table("harness_escalations", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	escalation: text(),
	supervisorNotes: text("supervisor_notes"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	bodyTsv: tsvectorCustom("body_tsv"),
	bodyEmbedding: vector("body_embedding", { dimensions: 768 }),
	riskTier: text("risk_tier"),
	authority: text(),
	bodyEmbeddingMode: text("body_embedding_mode"),
	bodyEmbeddingProfile: text("body_embedding_profile"),
}, (table) => [
	index("harness_escalations_body_embedding_hnsw").using("hnsw", table.bodyEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_escalations_body_embedding_mode_idx").using("btree", table.bodyEmbeddingMode.asc().nullsLast().op("text_ops")).where(sql`(body_embedding_mode IS NOT NULL)`),
	index("harness_escalations_tsv_idx").using("gin", table.bodyTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_escalations_pkey"}),
	pgPolicy("harness_escalations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_escalations_authority_check", sql`(authority IS NULL) OR (authority = ANY (ARRAY['system'::text, 'owner'::text]))`),
	check("harness_escalations_risk_tier_check", sql`(risk_tier IS NULL) OR (risk_tier = ANY (ARRAY['trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text]))`),
]);

export const harnessFeatureDebugNotesInHarnessShared = harnessShared.table("harness_feature_debug_notes", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("hfdn_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "harness_feature_debug_notes_pkey"}),
	pgPolicy("harness_feature_debug_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessFeatureNotesInHarnessShared = harnessShared.table("harness_feature_notes", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	content: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_feature_notes_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "harness_feature_notes_pkey"}),
	pgPolicy("harness_feature_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessFeaturePrsInHarnessShared = harnessShared.table("harness_feature_prs", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	prUrl: text("pr_url").notNull(),
	prState: text("pr_state").default('unknown').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	openedTs: bigint("opened_ts", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
}, (table) => [
	index("hfp_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "harness_feature_prs_pkey"}),
	pgPolicy("harness_feature_prs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessGeneratorItemsInHarnessShared = harnessShared.table("harness_generator_items", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	items: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "harness_generator_items_pkey"}),
	pgPolicy("harness_generator_items_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessHookLogsInHarnessShared = harnessShared.table("harness_hook_logs", {
	harnessSlug: text("harness_slug").notNull(),
	logId: text("log_id").notNull(),
	name: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	content: text().default('').notNull(),
}, (table) => [
	index("harness_hook_logs_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.logId], name: "harness_hook_logs_pkey"}),
	pgPolicy("harness_hook_logs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessIssuesConsolidatedInHarnessShared = harnessShared.table("harness_issues_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	issueId: text("issue_id").notNull(),
	title: text().notNull(),
	severity: text().notNull(),
	source: text().notNull(),
	status: text().notNull(),
	foundAt: timestamp("found_at", { withTimezone: true, mode: 'string' }).notNull(),
	foundDuring: text("found_during"),
	repro: text(),
	evidence: text(),
	suggestedFix: text("suggested_fix"),
	codePointer: text("code_pointer"),
	linkedFeatureId: text("linked_feature_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).default(0).notNull(),
	notes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("hic_found_during_idx").using("btree", table.foundDuring.asc().nullsLast().op("text_ops")),
	index("hic_linked_idx").using("btree", table.linkedFeatureId.asc().nullsLast().op("text_ops")),
	index("hic_origin_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")).where(sql`(origin = 'remote'::text)`),
	index("hic_severity_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("hic_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("hic_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.issueId], name: "harness_issues_consolidated_pkey"}),
	check("harness_issues_consolidated_severity_check", sql`severity = ANY (ARRAY['critical'::text, 'major'::text, 'minor'::text, 'nit'::text])`),
	check("harness_issues_consolidated_source_check", sql`source = ANY (ARRAY['validator'::text, 'worker'::text, 'human'::text, 'system'::text])`),
	check("harness_issues_consolidated_status_check", sql`status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'fixing'::text, 'closed'::text, 'wontfix'::text])`),
]);

export const harnessLanesInHarnessShared = harnessShared.table("harness_lanes", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	pid: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_lanes_started_idx").using("btree", table.startedAt.asc().nullsLast().op("int8_ops")),
	index("harness_lanes_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.role], name: "harness_lanes_pkey"}),
	pgPolicy("harness_lanes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessMissionStateInHarnessShared = harnessShared.table("harness_mission_state", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	costWarnFired: boolean("cost_warn_fired").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	readyForProdAt: bigint("ready_for_prod_at", { mode: "number" }),
	lanes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "harness_mission_state_pkey"}),
	pgPolicy("harness_mission_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPendingIssuesInHarnessShared = harnessShared.table("harness_pending_issues", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	issueId: text("issue_id").notNull(),
	featureId: text("feature_id"),
	title: text().default('').notNull(),
	severity: text().default('normal').notNull(),
	source: text().default('').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.issueId, table.phase], name: "harness_pending_issues_pkey"}),
	pgPolicy("harness_pending_issues_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPhaseLastUsedInHarnessShared = harnessShared.table("harness_phase_last_used", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	userId: text("user_id").notNull(),
	phase: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.userId, table.workspaceId], name: "harness_phase_last_used_pkey"}),
	pgPolicy("harness_phase_last_used_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPlanAssertionsInHarnessShared = harnessShared.table("harness_plan_assertions", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	valId: text("val_id").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	verifyText: text("verify_text").notNull(),
	evidenceText: text("evidence_text").default('').notNull(),
	status: text().default('todo').notNull(),
	requiresTest: boolean("requires_test").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("hpa_plan_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.itemId.asc().nullsLast().op("text_ops")),
	index("hpa_requires_test_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(NOT requires_test)`),
	primaryKey({ columns: [table.harnessSlug, table.valId, table.workspaceId], name: "harness_plan_assertions_pkey"}),
	pgPolicy("harness_plan_assertions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plan_assertions_status_check", sql`status = ANY (ARRAY['todo'::text, 'validating'::text, 'passed'::text, 'failed'::text])`),
]);

export const harnessPlanPartsInHarnessShared = harnessShared.table("harness_plan_parts", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	partKey: text("part_key").notNull(),
	kind: text().notNull(),
	body: text().default('').notNull(),
	ordinal: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }).notNull(),
	author: text(),
	tombstone: boolean().default(false).notNull(),
	origin: text().default('local').notNull(),
	partFedKey: text("part_fed_key").generatedAlwaysAs(sql`((plan_slug || '/'::text) || part_key)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("harness_plan_parts_by_plan").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.partKey, table.planSlug, table.workspaceId], name: "harness_plan_parts_pkey"}),
	pgPolicy("harness_plan_parts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPlanStatusInHarnessShared = harnessShared.table("harness_plan_status", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	currentWave: text("current_wave"),
	priority: integer(),
}, (table) => [
	index("hps_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'started'::text)`),
	primaryKey({ columns: [table.harnessSlug, table.planSlug, table.workspaceId], name: "harness_plan_status_pkey"}),
	pgPolicy("harness_plan_status_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plan_status_status_check", sql`status = ANY (ARRAY['started'::text, 'paused'::text, 'done'::text])`),
]);

export const harnessPlansInHarnessShared = harnessShared.table("harness_plans", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	title: text(),
	status: text(),
	created: text(),
	updated: text(),
	owner: text(),
	supersedes: text().array().default([]).notNull(),
	supersededBy: text("superseded_by"),
	content: text().default('').notNull(),
	contentHash: text("content_hash").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	version: bigint({ mode: "number" }).default(0).notNull(),
	opStatus: text("op_status"),
	opStartedAt: timestamp("op_started_at", { withTimezone: true, mode: 'string' }),
	opUpdatedAt: timestamp("op_updated_at", { withTimezone: true, mode: 'string' }),
	currentWave: text("current_wave"),
	opPriority: integer("op_priority"),
	archived: boolean().default(false).notNull(),
	isLegacy: boolean("is_legacy").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(content, ''::text)), 'B'::"char"))`),
	items: jsonb(),
	decisions: jsonb(),
	nowState: text("now_state"),
	nowNext: text("now_next"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	initiative: text(),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active").default(false).notNull(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	fedHlc: text("fed_hlc"),
	promotePolicy: jsonb("promote_policy"),
	template: text(),
	templateData: jsonb("template_data"),
	ownerAuthorPubkey: text("owner_author_pubkey"),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	inputSchema: jsonb("input_schema"),
	goalId: text("goal_id"),
	forcedPast: jsonb("forced_past"),
	outputSchema: jsonb("output_schema"),
	propertySchema: jsonb("property_schema").default({}).notNull(),
	properties: jsonb().default({}).notNull(),
	isBlenderOrigin: boolean("is_blender_origin").generatedAlwaysAs(sql`(content ~~ '%
origin: scout
%'::text)`),
	acceptanceBarEpoch: integer("acceptance_bar_epoch"),
	acceptanceBarCohort: text("acceptance_bar_cohort"),
	acceptanceBarSetHash: text("acceptance_bar_set_hash"),
	acceptanceBarRubricSlug: text("acceptance_bar_rubric_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptanceBarRubricRevision: bigint("acceptance_bar_rubric_revision", { mode: "number" }),
	acceptanceBarSeededAt: timestamp("acceptance_bar_seeded_at", { withTimezone: true, mode: 'string' }),
	acceptanceBarSeededBy: text("acceptance_bar_seeded_by"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("harness_plans_acceptance_bar_unseeded").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")).where(sql`((acceptance_bar_epoch IS NOT NULL) AND (acceptance_bar_set_hash IS NULL))`),
	index("harness_plans_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_plans_embedding_mode_idx").using("btree", table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	index("harness_plans_goal_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops")).where(sql`(goal_id IS NOT NULL)`),
	uniqueIndex("harness_plans_one_active_acceptance_per_subject_plan").using("btree", sql`workspace_id`, sql`((template_data ->> 'subjectPlan'::text))`).where(sql`((template = 'rubric'::text) AND (template_slug IS NULL) AND (archived = false) AND (status = ANY (ARRAY['active'::text, 'ready'::text])) AND ((template_data ->> 'kind'::text) = 'acceptance'::text) AND (NULLIF((template_data ->> 'subjectPlan'::text), ''::text) IS NOT NULL))`),
	index("harness_plans_schedule_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(schedule_active = true)`),
	index("harness_plans_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("harness_plans_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.opStatus.asc().nullsLast().op("text_ops")).where(sql`(op_status = 'started'::text)`),
	index("harness_plans_template_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.templateSlug.asc().nullsLast().op("text_ops")).where(sql`(template_slug IS NOT NULL)`),
	index("harness_plans_ws_harness_status_updated_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(archived = false)`),
	primaryKey({ columns: [table.harnessSlug, table.planSlug, table.workspaceId], name: "harness_plans_pkey"}),
	pgPolicy("harness_plans_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plans_acceptance_bar_cohort_valid", sql`(acceptance_bar_cohort IS NULL) OR (acceptance_bar_cohort = ANY (ARRAY['post-epoch'::text, 'legacy-backfilled'::text]))`),
	check("harness_plans_acceptance_bar_epoch_positive", sql`(acceptance_bar_epoch IS NULL) OR (acceptance_bar_epoch > 0)`),
	check("harness_plans_acceptance_bar_marker_complete", sql`(acceptance_bar_epoch IS NULL) = (acceptance_bar_cohort IS NULL)`),
	check("harness_plans_acceptance_bar_seed_pin_complete", sql`((acceptance_bar_set_hash IS NULL) AND (acceptance_bar_rubric_slug IS NULL) AND (acceptance_bar_rubric_revision IS NULL) AND (acceptance_bar_seeded_at IS NULL) AND (acceptance_bar_seeded_by IS NULL)) OR ((acceptance_bar_set_hash ~ '^[0-9a-f]{64}$'::text) AND (length(btrim(acceptance_bar_rubric_slug)) > 0) AND (acceptance_bar_rubric_revision > 0) AND (acceptance_bar_seeded_at IS NOT NULL) AND (length(btrim(acceptance_bar_seeded_by)) > 0))`),
	check("harness_plans_op_status_check", sql`(op_status IS NULL) OR (op_status = ANY (ARRAY['started'::text, 'paused'::text, 'done'::text]))`),
	check("harness_plans_properties_object", sql`jsonb_typeof(properties) = 'object'::text`),
	check("harness_plans_property_schema_object", sql`jsonb_typeof(property_schema) = 'object'::text`),
	check("harness_plans_status_check", sql`(status IS NULL) OR (status = ANY (ARRAY['draft'::text, 'ready'::text, 'active'::text, 'awaiting-acceptance'::text, 'shipped'::text, 'superseded'::text]))`),
	check("harness_plans_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harnessProjectFilesInHarnessShared = harnessShared.table("harness_project_files", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	spec: text(),
	agents: text(),
	contract: text(),
	config: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	version: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_project_files_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("harness_project_files_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.harnessSlug], name: "harness_project_files_pkey"}),

]);

export const harnessPromotionsInHarnessShared = harnessShared.table("harness_promotions", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	promotionId: text("promotion_id").notNull(),
	fromPhase: text("from_phase").notNull(),
	toPhase: text("to_phase").notNull(),
	sha: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_promotions_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.promotionId, table.workspaceId], name: "harness_promotions_pkey"}),
	pgPolicy("harness_promotions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPromptOverridesInHarnessShared = harnessShared.table("harness_prompt_overrides", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text().notNull(),
	promptMd: text("prompt_md").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.role, table.workspaceId], name: "harness_prompt_overrides_pkey"}),
	pgPolicy("harness_prompt_overrides_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessProposalsSharedInHarnessShared = harnessShared.table("harness_proposals_shared", {
	harnessSlug: text("harness_slug").notNull(),
	proposalId: text("proposal_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	phase: text().default('staging').notNull(),
	status: text().default('pending').notNull(),
	reviewVerdict: text("review_verdict"),
	reviewSummary: text("review_summary"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reviewedAt: bigint("reviewed_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	appliedAt: bigint("applied_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rejectedAt: bigint("rejected_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_proposals_shared_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("harness_proposals_shared_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("harness_proposals_shared_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.proposalId], name: "harness_proposals_shared_pkey"}),
	pgPolicy("harness_proposals_shared_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessRegistryInHarnessShared = harnessShared.table("harness_registry", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("harness_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "harness_registry_pkey"}),

]);

export const harnessRunChunksInHarnessShared = harnessShared.table("harness_run_chunks", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	seq: integer().notNull(),
	chunkData: text("chunk_data").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_chunks_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.harnessSlug, table.runId, table.seq, table.workspaceId], name: "harness_run_chunks_pkey"}),
	pgPolicy("harness_run_chunks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessRunOutputInHarnessShared = harnessShared.table("harness_run_output", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	role: text(),
	promptBody: text("prompt_body").default('').notNull(),
	jsonlBody: text("jsonl_body").default('').notNull(),
	outBody: text("out_body").default('').notNull(),
	errBody: text("err_body").default('').notNull(),
	exitCode: integer("exit_code"),
	durationMs: integer("duration_ms"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	endedAt: bigint("ended_at", { mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_output_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.endedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.runId, table.workspaceId], name: "harness_run_output_pkey"}),
	pgPolicy("harness_run_output_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessScreenshotsInHarnessShared = harnessShared.table("harness_screenshots", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_screenshots_slug_phase_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.phase.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id, table.phase], name: "harness_screenshots_pkey"}),
	pgPolicy("harness_screenshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessSkillsInHarnessShared = harnessShared.table("harness_skills", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_skills_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.name, table.workspaceId], name: "harness_skills_pkey"}),
	pgPolicy("harness_skills_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessSmokeTestInHarnessShared = harnessShared.table("harness_smoke_test", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	status: text().default('unknown').notNull(),
	passContent: text("pass_content"),
	failureContent: text("failure_content"),
	results: jsonb(),
	startupLog: text("startup_log"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	pgPolicy("harness_smoke_test_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.harnessSlug], name: "harness_smoke_test_pkey"}),

]);

export const harnessSnapshotsInHarnessShared = harnessShared.table("harness_snapshots", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	iteration: integer().notNull(),
	featuresJson: text("features_json"),
	validationMd: text("validation_md"),
	notesMd: text("notes_md"),
	configJson: text("config_json"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	takenAt: bigint("taken_at", { mode: "number" }).notNull(),
}, (table) => [
	index("harness_snapshots_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.takenAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.snapshotId, table.workspaceId], name: "harness_snapshots_pkey"}),
	pgPolicy("harness_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessSnapshotsConsolidatedInHarnessShared = harnessShared.table("harness_snapshots_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	iterNum: integer("iter_num").default(0).notNull(),
	files: jsonb().default([]).notNull(),
	featureCounts: jsonb("feature_counts").default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("hsc_iter_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.iterNum.desc().nullsFirst().op("int4_ops")),
	index("hsc_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.snapshotId], name: "harness_snapshots_consolidated_pkey"}),
]);

export const harnessStatusInHarnessShared = harnessShared.table("harness_status", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	status: text().notNull(),
	iteration: integer().default(0).notNull(),
	totalFeatures: integer("total_features").default(0).notNull(),
	passedCount: integer("passed_count").default(0).notNull(),
	todoCount: integer("todo_count").default(0).notNull(),
	blockedCount: integer("blocked_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastActiveTs: bigint("last_active_ts", { mode: "number" }),
	costUsd: numeric("cost_usd", { precision: 10, scale:  4 }),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAt: bigint("expires_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_status_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("int8_ops")),
	index("harness_status_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("int8_ops")),
	index("harness_status_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_status_pkey"}),
	pgPolicy("harness_status_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_status_status_check", sql`status = ANY (ARRAY['idle'::text, 'running'::text, 'stalled'::text, 'paused'::text, 'error'::text])`),
]);

export const harnessTestsInHarnessShared = harnessShared.table("harness_tests", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	testId: text("test_id").notNull(),
	name: text().default('').notNull(),
	status: text().default('pending').notNull(),
	durationMs: integer("duration_ms").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRunTs: bigint("last_run_ts", { mode: "number" }),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.phase, table.testId], name: "harness_tests_pkey"}),
	pgPolicy("harness_tests_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessTextArtifactsInHarnessShared = harnessShared.table("harness_text_artifacts", {
	harnessSlug: text("harness_slug").notNull(),
	relPath: text("rel_path").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("hta_updated_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("int8_ops")),
	index("hta_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.relPath], name: "harness_text_artifacts_pkey"}),
	pgPolicy("harness_text_artifacts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiddenPluginsInHarnessShared = harnessShared.table("hidden_plugins", {
	basename: text().notNull(),
	reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hiddenAt: bigint("hidden_at", { mode: "number" }).default(0).notNull(),
	hiddenBy: text("hidden_by"),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("hidden_plugins_basename_idx").using("btree", table.basename.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.basename, table.workspaceId], name: "hidden_plugins_pkey"}),
	pgPolicy("hidden_plugins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hlcClockInHarnessShared = harnessShared.table("hlc_clock", {
	id: smallint().default(1).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastMs: bigint("last_ms", { mode: "number" }).default(0).notNull(),
	lastCount: integer("last_count").default(0).notNull(),
	nodeId: text("node_id"),
}, (table) => [
	check("hlc_clock_singleton", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "hlc_clock_pkey"}),

]);

export const hostKernelMemorySamplesInHarnessShared = harnessShared.table("host_kernel_memory_samples", {
	bootId: text("boot_id").notNull(),
	bucketAt: timestamp("bucket_at", { withTimezone: true, mode: 'string' }).notNull(),
	sampledAt: timestamp("sampled_at", { withTimezone: true, mode: 'string' }).notNull(),
	host: text().notNull(),
	bootedAt: timestamp("booted_at", { withTimezone: true, mode: 'string' }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memTotalBytes: bigint("mem_total_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sunreclaimBytes: bigint("sunreclaim_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	slabBytes: bigint("slab_bytes", { mode: "number" }).notNull(),
	dyingDescendants: integer("dying_descendants"),
}, (table) => [
	index("host_kernel_memory_samples_sampled_at_idx").using("btree", table.sampledAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.bootId, table.bucketAt], name: "host_kernel_memory_samples_pkey"}),
]);

export const identityFilesInHarnessShared = harnessShared.table("identity_files", {
	role: text().primaryKey().notNull(),
	content: text().default('').notNull(),
	bytes: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("identity_files_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("identity_files_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const identityHookTurnsInHarnessShared = harnessShared.table("identity_hook_turns", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	turnId: text("turn_id").notNull(),
	tokensSpent: integer("tokens_spent").default(0).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	msSpent: integer("ms_spent").default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.ownerId, table.workspaceId], name: "identity_hook_turns_pkey"}),
	pgPolicy("identity_hook_turns_workspace", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("identity_hook_turns_ms_nonnegative", sql`ms_spent >= 0`),
	check("identity_hook_turns_tokens_nonnegative", sql`tokens_spent >= 0`),
]);

export const improvementDispatchesInHarnessShared = harnessShared.table("improvement_dispatches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	itemId: text("item_id").notNull(),
	attempt: integer().default(1).notNull(),
	runnerHarness: text("runner_harness"),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fireResult: text("fire_result").default('pending').notNull(),
	fireError: text("fire_error"),
	spawnedRunId: text("spawned_run_id"),
	outcome: text(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: text("resolved_by"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("improvement_dispatches_open_item_idx").using("btree", table.itemId.asc().nullsLast().op("text_ops")).where(sql`(outcome IS NULL)`),
	index("improvement_dispatches_ws_fired_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("improvement_dispatches_ws_pot_fired_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("improvement_dispatches_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "improvement_dispatches_pkey"}),

]);

export const insightsFirstVisitInHarnessShared = harnessShared.table("insights_first_visit", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	userId: text("user_id").notNull(),
	seenAtTs: timestamp("seen_at_ts", { withTimezone: true, mode: 'string' }),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.userId, table.workspaceId], name: "insights_first_visit_pkey"}),
	pgPolicy("insights_first_visit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const interactiveUsageFilesInHarnessShared = harnessShared.table("interactive_usage_files", {
	workspaceId: text("workspace_id").notNull(),
	filePath: text("file_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	parserState: jsonb("parser_state").default({}).notNull(),
}, (table) => [
	primaryKey({ columns: [table.filePath, table.workspaceId], name: "interactive_usage_files_pkey"}),
]);

export const interestWatchesInHarnessShared = harnessShared.table("interest_watches", {
	id: uuid().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	harnessSlug: text("harness_slug"),
	eventKey: text("event_key").notNull(),
	interest: text().notNull(),
	simFloor: doublePrecision("sim_floor").notNull(),
	intervalSec: integer("interval_sec").default(120).notNull(),
	once: boolean().default(false).notNull(),
	watermark: timestamp({ withTimezone: true }).defaultNow().notNull(),
	lastSweptAt: timestamp("last_swept_at", { withTimezone: true, mode: 'string' }),
	lastMatchCount: integer("last_match_count"),
	fireCount: integer("fire_count").default(0).notNull(),
	lastError: text("last_error"),
	consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("interest_watches_due_idx").using("btree", table.lastSweptAt.asc().nullsFirst().op("timestamptz_ops")).where(sql`active`),
]);

export const knowledgePackCandidatesInHarnessShared = harnessShared.table("knowledge_pack_candidates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	signature: text().notNull(),
	title: text().notNull(),
	draftText: text("draft_text").notNull(),
	kind: text().default('feedback').notNull(),
	appliesTo: jsonb("applies_to").default(["any"]).notNull(),
	scopes: jsonb().default([]).notNull(),
	recurrenceCount: integer("recurrence_count").default(0).notNull(),
	sourceItemIds: jsonb("source_item_ids").default([]).notNull(),
	status: text().default('pending').notNull(),
	createdBy: text("created_by").default('recurrence-escalation').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	decidedBy: text("decided_by"),
	decisionNote: text("decision_note"),
	packId: text("pack_id"),
	packItemId: text("pack_item_id"),
	reviewErrorCount: integer("review_error_count").default(0).notNull(),
	lastReviewError: text("last_review_error"),
	lastReviewErrorAt: timestamp("last_review_error_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("knowledge_pack_candidates_listing_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	unique("knowledge_pack_candidates_signature_uniq").on(table.signature),
	check("knowledge_pack_candidates_kind_check", sql`kind = ANY (ARRAY['user'::text, 'feedback'::text, 'project'::text, 'reference'::text])`),
	check("knowledge_pack_candidates_status_check", sql`status = ANY (ARRAY['pending'::text, 'adopted'::text, 'dismissed'::text])`),
	primaryKey({ columns: [table.id], name: "knowledge_pack_candidates_pkey"}),

]);

export const knowledgePackConfigInHarnessShared = harnessShared.table("knowledge_pack_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("knowledge_pack_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "knowledge_pack_config_pkey"}),

]);

export const knownSchemaVersionsInHarnessShared = harnessShared.table("known_schema_versions", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxKnownVersion: bigint("max_known_version", { mode: "number" }).default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "known_schema_versions_pkey"}),
	pgPolicy("known_schema_versions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const knownTimerRegistrationsInHarnessShared = harnessShared.table("known_timer_registrations", {
	name: text().primaryKey().notNull(),
	source: text().notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const learningGovernorLoopsInHarnessShared = harnessShared.table("learning_governor_loops", {
	workspaceId: text("workspace_id").notNull(),
	loopId: text("loop_id").notNull(),
	displayName: text("display_name").notNull(),
	budgetKind: text("budget_kind").default('lifetime').notNull(),
	budgetUsd: numeric("budget_usd"),
	spentUsd: numeric("spent_usd").default('0').notNull(),
	priority: integer().default(100).notNull(),
	enabled: boolean().default(true).notNull(),
	enforcement: text().default('governor').notNull(),
	meta: jsonb(),
	registeredAt: timestamp("registered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("learning_governor_loops_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.loopId, table.workspaceId], name: "learning_governor_loops_pkey"}),
	pgPolicy("learning_governor_loops_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const learningPotScopeInHarnessShared = harnessShared.table("learning_pot_scope", {
	workspaceId: text("workspace_id").notNull(),
	potSlug: text("pot_slug").notNull(),
	enabled: boolean().default(true).notNull(),
	setBy: text("set_by"),
	setAt: timestamp("set_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("learning_pot_scope_disabled_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(enabled = false)`),
	primaryKey({ columns: [table.potSlug, table.workspaceId], name: "learning_pot_scope_pkey"}),
	pgPolicy("learning_pot_scope_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const learningSpendEventsInHarnessShared = harnessShared.table("learning_spend_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	loopId: text("loop_id").notNull(),
	costUsd: numeric("cost_usd").notNull(),
	signalOrigin: text("signal_origin").default('organic').notNull(),
	runRef: text("run_ref"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
	reservationId: uuid("reservation_id"),
}, (table) => [
	index("learning_spend_events_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	index("learning_spend_events_reservation_idx").using("btree", table.reservationId.asc().nullsLast().op("uuid_ops")).where(sql`(reservation_id IS NOT NULL)`),
	index("learning_spend_events_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("learning_spend_events_ws_loop_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.loopId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("learning_spend_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("learning_spend_events_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	primaryKey({ columns: [table.id], name: "learning_spend_events_pkey"}),

]);

export const learningSpendReservationsInHarnessShared = harnessShared.table("learning_spend_reservations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	loopId: text("loop_id").notNull(),
	potSlug: text("pot_slug"),
	attemptKind: text("attempt_kind").default('cycle').notNull(),
	requestedUsd: numeric("requested_usd").notNull(),
	reservedUsd: numeric("reserved_usd").notNull(),
	usedUsd: numeric("used_usd").default('0').notNull(),
	status: text().default('open').notNull(),
	signalOrigin: text("signal_origin").default('organic').notNull(),
	runRef: text("run_ref"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	settledAt: timestamp("settled_at", { withTimezone: true, mode: 'string' }),
	armId: text("arm_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }),
}, (table) => [
	index("learning_spend_reservations_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.loopId.asc().nullsLast().op("text_ops")).where(sql`(status = 'open'::text)`),
	index("learning_spend_reservations_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("learning_spend_reservations_ws_loop_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.loopId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("learning_spend_reservations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("learning_reservation_resources_valid", sql`((arm_id IS NULL) AND (reserved_input_tokens IS NULL) AND (reserved_output_tokens IS NULL)) OR ((arm_id IS NOT NULL) AND ((length(btrim(arm_id)) >= 1) AND (length(btrim(arm_id)) <= 256)) AND (reserved_input_tokens IS NOT NULL) AND ((reserved_input_tokens >= 0) AND (reserved_input_tokens <= '9007199254740991'::bigint)) AND (reserved_output_tokens IS NOT NULL) AND ((reserved_output_tokens >= 1) AND (reserved_output_tokens <= '9007199254740991'::bigint)))`),
	check("learning_spend_reservations_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("learning_spend_reservations_status_check", sql`status = ANY (ARRAY['open'::text, 'settled'::text, 'cancelled'::text, 'failed'::text])`),
	primaryKey({ columns: [table.id], name: "learning_spend_reservations_pkey"}),

]);

export const llmTestClaimsInHarnessShared = harnessShared.table("llm_test_claims", {
	claimKey: text("claim_key").primaryKey().notNull(),
	ownerId: text("owner_id").notNull(),
	scenarioId: text("scenario_id").notNull(),
	identityHash: text("identity_hash").notNull(),
	matrixIndex: integer("matrix_index"),
	acquiredAt: timestamp("acquired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
}, (table) => [
	index("llm_test_claims_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("llm_test_claims_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.claimKey], name: "llm_test_claims_pkey"}),

]);

export const llmTestFindingsInHarnessShared = harnessShared.table("llm_test_findings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid("run_id").notNull(),
	source: text().notNull(),
	severity: text().notNull(),
	axis: text(),
	assertKind: text("assert_kind"),
	shape: text(),
	evidenceTurnIdx: integer("evidence_turn_idx"),
	claim: text().notNull(),
	suggestion: text(),
	copyPrompt: text("copy_prompt"),
	promotedToAssertId: text("promoted_to_assert_id"),
	promotedFrom: text("promoted_from").array().default([]).notNull(),
	acknowledged: boolean().default(false).notNull(),
	acknowledgedBy: text("acknowledged_by"),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("llm_test_findings_ack_severity_idx").using("btree", table.acknowledged.asc().nullsLast().op("bool_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("llm_test_findings_run_severity_idx").using("btree", table.runId.asc().nullsLast().op("uuid_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("llm_test_findings_shape_severity_idx").using("btree", table.shape.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")).where(sql`(shape IS NOT NULL)`),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [llmTestRunsInHarnessShared.id],
			name: "llm_test_findings_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id], name: "llm_test_findings_pkey"}),

]);

export const llmTestFixturesInHarnessShared = harnessShared.table("llm_test_fixtures", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scenarioId: text("scenario_id").notNull(),
	label: text().notNull(),
	sseTapeJson: jsonb("sse_tape_json").notNull(),
	userInputsJson: jsonb("user_inputs_json").notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	recordedFromRunId: uuid("recorded_from_run_id"),
}, (table) => [
	index("llm_test_fixtures_scenario_idx").using("btree", table.scenarioId.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.recordedFromRunId],
			foreignColumns: [llmTestRunsInHarnessShared.id],
			name: "llm_test_fixtures_recorded_from_run_id_fkey"
		}).onDelete("set null"),
	unique("llm_test_fixtures_scenario_id_label_key").on(table.label, table.scenarioId),
	primaryKey({ columns: [table.id], name: "llm_test_fixtures_pkey"}),

]);

export const llmTestRunsInHarnessShared = harnessShared.table("llm_test_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scenarioId: text("scenario_id").notNull(),
	scenarioVersion: integer("scenario_version").notNull(),
	scenarioTarget: text("scenario_target").notNull(),
	scenarioHash: text("scenario_hash").notNull(),
	identityHash: text("identity_hash").notNull(),
	matrixGroupId: uuid("matrix_group_id"),
	matrixIndex: integer("matrix_index"),
	rubricVersion: text("rubric_version").notNull(),
	sutModel: text("sut_model").notNull(),
	judgeModel: text("judge_model").notNull(),
	personaId: text("persona_id").notNull(),
	personaTraitsJson: jsonb("persona_traits_json").notNull(),
	workspaceMode: text("workspace_mode").notNull(),
	transportMode: text("transport_mode").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	costUsd: numeric("cost_usd", { precision: 10, scale:  6 }).default('0').notNull(),
	capBreaches: text("cap_breaches").array().default([]).notNull(),
	scoresJson: jsonb("scores_json"),
	findingsCount: jsonb("findings_count").default({}).notNull(),
	transcriptRawZstd: byteaCustom("transcript_raw_zstd"),
	transcriptNormJson: jsonb("transcript_norm_json").default({}).notNull(),
	telemetryJson: jsonb("telemetry_json").default({}).notNull(),
	assertsJson: jsonb("asserts_json").default({}).notNull(),
	judgeJson: jsonb("judge_json"),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
}, (table) => [
	index("llm_test_runs_identity_started_idx").using("btree", table.identityHash.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("llm_test_runs_matrix_group_idx").using("btree", table.matrixGroupId.asc().nullsLast().op("uuid_ops")).where(sql`(matrix_group_id IS NOT NULL)`),
	index("llm_test_runs_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("llm_test_runs_target_scenario_started_idx").using("btree", table.scenarioTarget.asc().nullsLast().op("text_ops"), table.scenarioId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id], name: "llm_test_runs_pkey"}),

]);

export const localBackendsInHarnessShared = harnessShared.table("local_backends", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().notNull(),
	baseUrl: text("base_url").notNull(),
	models: jsonb().default([]).notNull(),
	maxConcurrent: integer("max_concurrent").default(4).notNull(),
	enabled: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lifecycle: text().default('always-on').notNull(),
	idleTtlSec: integer("idle_ttl_sec"),
	unitName: text("unit_name"),
	lastBusyAt: timestamp("last_busy_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("local_backends_on_demand").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(enabled AND (lifecycle = 'on-demand'::text))`),
	index("local_backends_workspace").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`enabled`),
	check("local_backends_idle_ttl_sec_check", sql`(idle_ttl_sec IS NULL) OR (idle_ttl_sec > 0)`),
	check("local_backends_kind_check", sql`kind = ANY (ARRAY['llama-server'::text, 'vllm'::text, 'ollama'::text])`),
	check("local_backends_lifecycle_check", sql`lifecycle = ANY (ARRAY['always-on'::text, 'on-demand'::text])`),
	check("local_backends_max_concurrent_check", sql`max_concurrent > 0`),
	check("local_backends_on_demand_needs_unit_check", sql`(lifecycle <> 'on-demand'::text) OR (unit_name IS NOT NULL)`),
]);

export const mcpToolResultsInHarnessShared = harnessShared.table("mcp_tool_results", {
	ownerKey: text("owner_key").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	toolName: text("tool_name").notNull(),
	workspaceId: text("workspace_id").default('*').notNull(),
	result: jsonb().notNull(),
	isError: boolean("is_error").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mcp_tool_results_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.idempotencyKey, table.ownerKey], name: "mcp_tool_results_pkey"}),
]);

export const memoryAnchorsInHarnessShared = harnessShared.table("memory_anchors", {
	memoryId: uuid("memory_id").notNull(),
	kind: text().notNull(),
	value: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: 'string' }),
	lastCheckOk: boolean("last_check_ok"),
}, (table) => [
	index("memory_anchors_lookup_idx").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.value.asc().nullsLast().op("text_ops")),
	index("memory_anchors_recheck_idx").using("btree", table.lastCheckedAt.asc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_anchors_memory_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.kind, table.memoryId, table.value], name: "memory_anchors_pkey"}),
	check("memory_anchors_kind_check", sql`kind = ANY (ARRAY['file'::text, 'feature'::text, 'plan'::text, 'migration'::text, 'symbol'::text])`),
]);

export const memoryCanonicalInHarnessShared = harnessShared.table("memory_canonical", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: 'string' }),
	lastSurfacedAt: timestamp("last_surfaced_at", { withTimezone: true, mode: 'string' }),
	state: text().default('active').notNull(),
	userId: text("user_id").generatedAlwaysAs(sql`(payload ->> 'user_id'::text)`),
	workspaceId: text("workspace_id").generatedAlwaysAs(sql`(payload ->> 'workspace_id'::text)`),
	shareable: boolean().generatedAlwaysAs(sql`COALESCE(((payload ->> 'shareable'::text))::boolean, false)`),
	harnessSlug: text("harness_slug"),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	sourceHive: text("source_hive"),
	validAt: timestamp("valid_at", { withTimezone: true, mode: 'string' }),
	invalidAt: timestamp("invalid_at", { withTimezone: true, mode: 'string' }),
	supersededBy: uuid("superseded_by"),
	rowKind: text("row_kind").generatedAlwaysAs(sql`
CASE
    WHEN (payload ? 'entityType'::text) THEN 'entity'::text
    ELSE 'memory'::text
END`),
}, (table) => [
	uniqueIndex("memory_canonical_fed_identity").using("btree", sql`workspace_id`, sql`id`, sql`COALESCE(source_hive, ''::text)`),
	index("memory_canonical_payload_data_trgm").using("gin", sql`((payload ->> 'data'::text))`),
	index("memory_canonical_payload_description_trgm").using("gin", sql`((payload ->> 'description'::text))`),
	index("memory_canonical_payload_name_trgm").using("gin", sql`((payload ->> 'name'::text))`),
	index("memory_canonical_recently_surfaced_idx").using("btree", table.lastSurfacedAt.desc().nullsLast().op("timestamptz_ops")).where(sql`(last_surfaced_at IS NOT NULL)`),
	index("memory_canonical_row_kind_memory_idx").using("btree", table.id.asc().nullsLast().op("uuid_ops")).where(sql`(row_kind = 'memory'::text)`),
	index("memory_canonical_shareable_idx").using("btree", table.shareable.asc().nullsLast().op("bool_ops")).where(sql`(shareable = true)`),
	index("memory_canonical_state_idx").using("btree", table.state.asc().nullsLast().op("text_ops")).where(sql`(state <> 'active'::text)`),
	index("memory_canonical_user_id_col_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("memory_canonical_user_id_idx").using("btree", sql`((payload ->> 'user_id'::text))`),
	index("memory_canonical_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	index("memory_canonical_ws_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("text_ops")),
	pgPolicy("memory_canonical_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("memory_canonical_state_check", sql`state = ANY (ARRAY['active'::text, 'broken_anchor'::text, 'superseded'::text, 'contradicted'::text, 'forgotten'::text, 'archived'::text])`),
	primaryKey({ columns: [table.id], name: "memory_canonical_pkey"}),

]);

export const memoryFeedbackInHarnessShared = harnessShared.table("memory_feedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	memId: text("mem_id").notNull(),
	userId: uuid("user_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	action: text().notNull(),
	kind: text(),
	priorText: text("prior_text"),
	newText: text("new_text"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("memory_feedback_action_created_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_feedback_mem_idx").using("btree", table.memId.asc().nullsLast().op("text_ops")),
	index("memory_feedback_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_feedback_ws_pot_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("memory_feedback_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("memory_feedback_action_check", sql`action = ANY (ARRAY['edit'::text, 'delete'::text, 'forget_all'::text])`),
	primaryKey({ columns: [table.id], name: "memory_feedback_pkey"}),

]);

export const memoryLiveRecallCanaryRunInHarnessShared = harnessShared.table("memory_live_recall_canary_run", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.memory_live_recall_canary_run_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	ranAt: timestamp("ran_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	setVersion: integer("set_version").notNull(),
	backend: text().notNull(),
	pairsTotal: integer("pairs_total").notNull(),
	pairsScored: integer("pairs_scored").notNull(),
	pairsMissing: integer("pairs_missing").notNull(),
	hits: integer().notNull(),
	rAt10: doublePrecision("r_at_10"),
	baselineRAt10: doublePrecision("baseline_r_at_10"),
	delta: doublePrecision(),
	zeroHitRate: doublePrecision("zero_hit_rate"),
	latencyP50Ms: doublePrecision("latency_p50_ms"),
	status: text().notNull(),
	notes: text(),
	retrievalZeroHitRate: doublePrecision("retrieval_zero_hit_rate"),
	retrievalRAt10: doublePrecision("retrieval_r_at_10"),
}, (table) => [
	index("memory_live_recall_canary_run_ws_ran_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ranAt.desc().nullsFirst().op("timestamptz_ops")),
	check("memory_live_recall_canary_run_status_check", sql`status = ANY (ARRAY['ok'::text, 'degraded'::text, 'decayed'::text, 'seeded'::text])`),
]);

export const memoryLiveRecallCanarySetInHarnessShared = harnessShared.table("memory_live_recall_canary_set", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.memory_live_recall_canary_set_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	version: integer().notNull(),
	backend: text().notNull(),
	pairs: jsonb().notNull(),
	pairsN: integer("pairs_n").notNull(),
	baselineRAt10: doublePrecision("baseline_r_at_10").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("memory_live_recall_canary_set_ws_version").on(table.version, table.workspaceId),
]);

export const memoryManagedWritesInHarnessShared = harnessShared.table("memory_managed_writes", {
	writeKey: uuid("write_key").primaryKey().notNull(),
	scope: text().notNull(),
	requestHash: text("request_hash"),
	fingerprint: text(),
	canceled: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("memory_managed_writes_fingerprint_check", sql`(fingerprint IS NULL) OR (fingerprint ~ '^[a-f0-9]{64}$'::text)`),
	check("memory_managed_writes_request_hash_check", sql`(request_hash IS NULL) OR (request_hash ~ '^[a-f0-9]{64}$'::text)`),
	primaryKey({ columns: [table.writeKey], name: "memory_managed_writes_pkey"}),

]);

export const memoryPrecisionBenchInHarnessShared = harnessShared.table("memory_precision_bench", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ranAt: timestamp("ran_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	backend: text().default('hybrid').notNull(),
	corpusVersion: text("corpus_version").notNull(),
	goldVersion: text("gold_version").notNull(),
	corpusN: integer("corpus_n").default(0).notNull(),
	goldN: integer("gold_n").default(0).notNull(),
	floorCosine: doublePrecision("floor_cosine").notNull(),
	floorLex: doublePrecision("floor_lex").notNull(),
	fpAt5: doublePrecision("fp_at_5"),
	rAt10: doublePrecision("r_at_10"),
	pAt5: doublePrecision("p_at_5"),
	mrr: doublePrecision(),
	medianTopScore: doublePrecision("median_top_score"),
	latencyP50Ms: doublePrecision("latency_p50_ms"),
	byClass: jsonb("by_class"),
	costUsd: doublePrecision("cost_usd"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_precision_bench_ws_ran_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ranAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("memory_precision_bench_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const memoryRecallQueryTextInHarnessShared = harnessShared.table("memory_recall_query_text", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	statsId: bigint("stats_id", { mode: "number" }).primaryKey().notNull(),
	queryText: text("query_text").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_recall_query_text_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.statsId],
			foreignColumns: [memoryRecallStatsInHarnessShared.id],
			name: "memory_recall_query_text_stats_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.statsId], name: "memory_recall_query_text_pkey"}),

]);

export const memoryRecallStatsInHarnessShared = harnessShared.table("memory_recall_stats", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.memory_recall_stats_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	surface: text().notNull(),
	hitCount: integer("hit_count").notNull(),
	topScore: doublePrecision("top_score"),
	scores: jsonb().default([]).notNull(),
	fragmentCount: integer("fragment_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id"),
	potSlug: text("pot_slug"),
	pools: jsonb(),
	scoreScale: text("score_scale"),
	queryChars: integer("query_chars"),
	querySha256: text("query_sha256"),
	queryOrigin: text("query_origin"),
	sessionId: text("session_id"),
	legs: jsonb(),
	admission: jsonb(),
	client: text(),
	topCosineScore: doublePrecision("top_cosine_score"),
	cosineScores: jsonb("cosine_scores"),
}, (table) => [
	index("memory_recall_stats_client_surface_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops"), table.client.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops")).where(sql`(client IS NOT NULL)`),
	index("memory_recall_stats_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_recall_stats_scale_created_idx").using("btree", table.scoreScale.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(score_scale IS NOT NULL)`),
	index("memory_recall_stats_session_created_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(session_id IS NOT NULL)`),
	index("memory_recall_stats_ws_pot_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	check("memory_recall_stats_hit_count_check", sql`hit_count >= 0`),
]);

export const memorySessionEpochsInHarnessShared = harnessShared.table("memory_session_epochs", {
	sessionId: text("session_id").primaryKey().notNull(),
	epoch: integer().default(0).notNull(),
	bumpedAt: timestamp("bumped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.sessionId], name: "memory_session_epochs_pkey"}),
]);

export const memorySessionSurfacedInHarnessShared = harnessShared.table("memory_session_surfaced", {
	sessionId: text("session_id").notNull(),
	epoch: integer().default(0).notNull(),
	memoryId: uuid("memory_id").notNull(),
	port: text().default('injection').notNull(),
	surfacedAt: timestamp("surfaced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_session_surfaced_age_idx").using("btree", table.surfacedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.epoch, table.memoryId, table.sessionId], name: "memory_session_surfaced_pkey"}),
]);

export const memoryVecGemmaInHarnessShared = harnessShared.table("memory_vec_gemma", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 768 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowKind: text("row_kind").notNull(),
}, (table) => [
	index("memory_vec_gemma_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	index("memory_vec_gemma_hnsw_memory_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")).where(sql`(row_kind = 'memory'::text)`),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_gemma_memory_id_fkey"
		}).onDelete("cascade"),
	check("memory_vec_gemma_row_kind_check", sql`row_kind = ANY (ARRAY['memory'::text, 'entity'::text])`),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_gemma_pkey"}),

]);

export const memoryVecHarrierInHarnessShared = harnessShared.table("memory_vec_harrier", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 1024 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowKind: text("row_kind").notNull(),
}, (table) => [
	index("memory_vec_harrier_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	index("memory_vec_harrier_hnsw_memory_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")).where(sql`(row_kind = 'memory'::text)`),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_harrier_memory_id_fkey"
		}).onDelete("cascade"),
	check("memory_vec_harrier_row_kind_check", sql`row_kind = ANY (ARRAY['memory'::text, 'entity'::text])`),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_harrier_pkey"}),

]);

export const memoryVecLocalInHarnessShared = harnessShared.table("memory_vec_local", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 384 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowKind: text("row_kind").notNull(),
}, (table) => [
	index("memory_vec_local_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	index("memory_vec_local_hnsw_memory_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")).where(sql`(row_kind = 'memory'::text)`),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_local_memory_id_fkey"
		}).onDelete("cascade"),
	check("memory_vec_local_row_kind_check", sql`row_kind = ANY (ARRAY['memory'::text, 'entity'::text])`),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_local_pkey"}),

]);

export const memoryVecOpenaiInHarnessShared = harnessShared.table("memory_vec_openai", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 768 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowKind: text("row_kind").notNull(),
}, (table) => [
	index("memory_vec_openai_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	index("memory_vec_openai_hnsw_memory_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")).where(sql`(row_kind = 'memory'::text)`),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_openai_memory_id_fkey"
		}).onDelete("cascade"),
	check("memory_vec_openai_row_kind_check", sql`row_kind = ANY (ARRAY['memory'::text, 'entity'::text])`),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_openai_pkey"}),

]);

export const memoryWriteJournalInHarnessShared = harnessShared.table("memory_write_journal", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	scope: text().notNull(),
	kind: text(),
	content: text().notNull(),
	metadata: jsonb(),
	verbatim: boolean().default(true).notNull(),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	committedMemoryId: uuid("committed_memory_id"),
	committedAt: timestamp("committed_at", { withTimezone: true, mode: 'string' }),
	source: text().default('live-write').notNull(),
	shareable: boolean(),
}, (table) => [
	index("memory_write_journal_committed_at_idx").using("btree", table.committedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'committed'::text)`),
	index("memory_write_journal_pending_idx").using("btree", table.requestedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	check("memory_write_journal_status_check", sql`status = ANY (ARRAY['pending'::text, 'committed'::text, 'failed_permanent'::text])`),
	primaryKey({ columns: [table.id], name: "memory_write_journal_pkey"}),

]);

export const messagesConsolidatedInHarnessShared = harnessShared.table("messages_consolidated", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	id: uuid().defaultRandom().notNull(),
	fromSlug: text("from_slug"),
	toSlug: text("to_slug"),
	kind: text(),
	subject: text(),
	body: text(),
	parentMessageId: uuid("parent_message_id"),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
	toRole: text("to_role"),
	fromFeatureId: text("from_feature_id"),
	toFeatureId: text("to_feature_id"),
}, (table) => [
	index("messages_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "messages_consolidated_pkey"}),
]);

export const migrationReservationsInHarnessShared = harnessShared.table("migration_reservations", {
	num: integer().primaryKey().notNull(),
	filename: text(),
	reservedBy: text("reserved_by"),
	intent: text(),
	reservedAt: timestamp("reserved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const mobilePairTokensInHarnessShared = harnessShared.table("mobile_pair_tokens", {
	pairToken: text("pair_token").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userEmail: text("user_email"),
	desktopHost: text("desktop_host").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAtMs: bigint("created_at_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("mobile_pair_tokens_exp_idx").using("btree", table.expiresAtMs.asc().nullsLast().op("int8_ops")),
	pgPolicy("mobile_pair_tokens_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.pairToken], name: "mobile_pair_tokens_pkey"}),

]);

export const mobilePushTokensInHarnessShared = harnessShared.table("mobile_push_tokens", {
	deviceId: text("device_id").notNull(),
	platform: text().notNull(),
	token: text().notNull(),
	registeredAt: timestamp("registered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mobile_push_tokens_workspace_idx").using("btree", table.deviceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.deviceId],
			foreignColumns: [connectedAppsInHarnessShared.id],
			name: "mobile_push_tokens_device_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.deviceId, table.platform], name: "mobile_push_tokens_pkey"}),
	pgPolicy("mobile_push_tokens_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM harness_shared.connected_apps d
  WHERE ((d.id = mobile_push_tokens.device_id) AND (d.workspace_id = current_setting('app.workspace_id'::text, true)))))` }),
	check("mobile_push_tokens_platform_check", sql`platform = ANY (ARRAY['apns'::text, 'fcm'::text])`),
]);

export const modelPricingInHarnessShared = harnessShared.table("model_pricing", {
	modelId: text("model_id").primaryKey().notNull(),
	inputPerMtok: numeric("input_per_mtok").notNull(),
	outputPerMtok: numeric("output_per_mtok").notNull(),
	cacheReadPerMtok: numeric("cache_read_per_mtok").notNull(),
	cacheCreationPerMtok: numeric("cache_creation_per_mtok").notNull(),
	effectiveDate: date("effective_date").default(sql`CURRENT_DATE`).notNull(),
	source: text().default('code-table').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.modelId], name: "model_pricing_pkey"}),
]);

export const negativeSpaceDemandInHarnessShared = harnessShared.table("negative_space_demand", {
	workspaceId: text("workspace_id").notNull(),
	surface: text().notNull(),
	queryNorm: text("query_norm").notNull(),
	exampleQuery: text("example_query").notNull(),
	missCount: integer("miss_count").notNull(),
	distinctAgents: integer("distinct_agents").default(1).notNull(),
	firstMissedAt: timestamp("first_missed_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastMissedAt: timestamp("last_missed_at", { withTimezone: true, mode: 'string' }).notNull(),
	candidateImprovementId: text("candidate_improvement_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.queryNorm, table.surface, table.workspaceId], name: "negative_space_demand_pkey"}),
	check("negative_space_demand_miss_count_check", sql`miss_count > 0`),
	check("negative_space_demand_surface_check", sql`surface = ANY (ARRAY['docs'::text, 'memory'::text, 'plans'::text])`),
]);

export const notesInHarnessShared = harnessShared.table("notes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	title: text().default('').notNull(),
	body: text().default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notes_ws_updated_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "notes_pkey"}),

]);

export const oauthNoncesInHarnessShared = harnessShared.table("oauth_nonces", {
	nonce: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expMs: bigint("exp_ms", { mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
	privateContext: jsonb("private_context").default({}).notNull(),
}, (table) => [
	index("oauth_nonces_exp_idx").using("btree", table.expMs.asc().nullsLast().op("int8_ops")),
]);

export const operatorAccountOverrideInHarnessShared = harnessShared.table("operator_account_override", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_account_override_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_account_override_pkey"}),

]);

export const operatorAccountPoolInHarnessShared = harnessShared.table("operator_account_pool", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_account_pool_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_account_pool_pkey"}),

]);

export const operatorAccountPoolAuditInHarnessShared = harnessShared.table("operator_account_pool_audit", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	beforeIds: text("before_ids").array().default([]).notNull(),
	afterIds: text("after_ids").array().default([]).notNull(),
	added: text().array().default([]).notNull(),
	removed: text().array().default([]).notNull(),
	backendPid: integer("backend_pid"),
	applicationName: text("application_name"),
	xactAgeMs: integer("xact_age_ms"),
	query: text(),
}, (table) => [
	index("operator_account_pool_audit_at_idx").using("btree", table.at.desc().nullsFirst().op("timestamptz_ops")),
	index("operator_account_pool_audit_removals_idx").using("btree", table.at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(removed <> '{}'::text[])`),
]);

export const operatorAgentConfigInHarnessShared = harnessShared.table("operator_agent_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_agent_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_agent_config_pkey"}),

]);

export const operatorAnnouncedQuiesceStateInHarnessShared = harnessShared.table("operator_announced_quiesce_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_announced_quiesce_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_announced_quiesce_state_pkey"}),

]);

export const operatorAttentionAutomationPolicyInHarnessShared = harnessShared.table("operator_attention_automation_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({"level":"L0","minConfidence":"high"}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_attention_automation_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_attention_automation_policy_pkey"}),

]);

export const operatorAuthConfigInHarnessShared = harnessShared.table("operator_auth_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_auth_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_auth_config_pkey"}),

]);

export const operatorAutoImplementPolicyInHarnessShared = harnessShared.table("operator_auto_implement_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_auto_implement_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_auto_implement_policy_pkey"}),

]);

export const operatorBudgetInHarnessShared = harnessShared.table("operator_budget", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_budget_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_budget_pkey"}),

]);

export const operatorBudgetTiersInHarnessShared = harnessShared.table("operator_budget_tiers", {
	ord: integer().primaryKey().notNull(),
	label: text().notNull(),
	capUsd: numeric("cap_usd", { precision: 10, scale:  2 }).notNull(),
	blurb: text().notNull(),
});

export const operatorCapabilityEnvelopesInHarnessShared = harnessShared.table("operator_capability_envelopes", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_capability_envelopes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_capability_envelopes_pkey"}),

]);

export const operatorCapabilityTiersInHarnessShared = harnessShared.table("operator_capability_tiers", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_capability_tiers_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_capability_tiers_pkey"}),

]);

export const operatorConsultExpertRoutingInHarnessShared = harnessShared.table("operator_consult_expert_routing", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_consult_expert_routing_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_consult_expert_routing_pkey"}),

]);

export const operatorContextDoorsConfigInHarnessShared = harnessShared.table("operator_context_doors_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_context_doors_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_context_doors_config_pkey"}),

]);

export const operatorContinueChainsInHarnessShared = harnessShared.table("operator_continue_chains", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	uiClientId: text("ui_client_id").notNull(),
	chainId: uuid("chain_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	trigger: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	elapsedSecsInChain: numeric("elapsed_secs_in_chain", { precision: 10, scale:  3 }).notNull(),
	wasCapped: boolean("was_capped").default(false).notNull(),
	capReason: text("cap_reason"),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("operator_continue_chains_chain_turn_idx").using("btree", table.chainId.asc().nullsLast().op("uuid_ops"), table.turnIdx.asc().nullsLast().op("int4_ops")),
	index("operator_continue_chains_conversation_idx").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("operator_continue_chains_uic_started_idx").using("btree", table.uiClientId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("operator_continue_chains_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const operatorConversationsInHarnessShared = harnessShared.table("operator_conversations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug"),
	title: text(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	endedAt: bigint("ended_at", { mode: "number" }),
	elConversationIds: text("el_conversation_ids").array().default([]).notNull(),
	hasAudio: boolean("has_audio").default(false).notNull(),
	summaryText: text("summary_text"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	summaryThroughSeq: bigint("summary_through_seq", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	summaryUpdatedAt: bigint("summary_updated_at", { mode: "number" }),
	summaryModel: text("summary_model"),
	summaryTurnsCovered: integer("summary_turns_covered"),
	subjectKind: text("subject_kind").default('global').notNull(),
	subjectRef: text("subject_ref"),
}, (table) => [
	index("operator_conversations_active_idx").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`).where(sql`(status = 'active'::text)`),
	index("operator_conversations_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("int8_ops")),
	uniqueIndex("operator_conversations_work_item_subject_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.subjectRef.asc().nullsLast().op("text_ops")).where(sql`(subject_kind = 'work-item'::text)`),
	pgPolicy("operator_conversations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("operator_conversations_subject_shape_check", sql`((subject_kind = 'global'::text) AND (subject_ref IS NULL) AND (status <> 'scoped'::text)) OR ((subject_kind = 'work-item'::text) AND (subject_ref IS NOT NULL) AND (subject_ref <> ''::text) AND (harness_slug IS NOT NULL) AND (harness_slug <> ''::text) AND (status = 'scoped'::text))`),
	primaryKey({ columns: [table.id], name: "operator_conversations_pkey"}),

]);

export const operatorCoordLivenessConfigInHarnessShared = harnessShared.table("operator_coord_liveness_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_coord_liveness_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_coord_liveness_config_pkey"}),

]);

export const operatorCredentialsInHarnessShared = harnessShared.table("operator_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_credentials_pkey"}),

]);

export const operatorCurationLogInHarnessShared = harnessShared.table("operator_curation_log", {
	workspaceId: text("workspace_id").notNull(),
	signalId: text("signal_id").notNull(),
	kind: text().notNull(),
	policyVersion: text("policy_version").default('').notNull(),
	surfacedAt: timestamp("surfaced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	title: text(),
}, (table) => [
	index("operator_curation_log_surfaced_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surfacedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.signalId, table.workspaceId], name: "operator_curation_log_pkey"}),
]);

export const operatorCurationStateInHarnessShared = harnessShared.table("operator_curation_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	lastDigestAt: timestamp("last_digest_at", { withTimezone: true, mode: 'string' }),
	currentIntervalSeconds: integer("current_interval_seconds").default(120).notNull(),
	consecutiveQuiet: integer("consecutive_quiet").default(0).notNull(),
	lastSurfacedCount: integer("last_surfaced_count").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_curation_state_pkey"}),
]);

export const operatorEmbedDeviceInHarnessShared = harnessShared.table("operator_embed_device", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_embed_device_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_embed_device_pkey"}),

]);

export const operatorFirstRunInHarnessShared = harnessShared.table("operator_first_run", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_first_run_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_first_run_pkey"}),

]);

export const operatorFlagOverridesInHarnessShared = harnessShared.table("operator_flag_overrides", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_flag_overrides_pkey"}),
]);

export const operatorGymGatesInHarnessShared = harnessShared.table("operator_gym_gates", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "operator_gym_gates_pkey"}),
	pgPolicy("operator_gym_gates_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operatorIntegrationCredentialsInHarnessShared = harnessShared.table("operator_integration_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	payloadCt: byteaCustom("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("oic_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_integration_credentials_pkey"}),

]);

export const operatorLivenessFlapStateInHarnessShared = harnessShared.table("operator_liveness_flap_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_liveness_flap_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_liveness_flap_state_pkey"}),

]);

export const operatorMarketplaceTokenInHarnessShared = harnessShared.table("operator_marketplace_token", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_marketplace_token_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_marketplace_token_pkey"}),

]);

export const operatorMigratePolicyInHarnessShared = harnessShared.table("operator_migrate_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_migrate_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_migrate_policy_pkey"}),

]);

export const operatorOpusBudgetPolicyInHarnessShared = harnessShared.table("operator_opus_budget_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_opus_budget_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_opus_budget_policy_pkey"}),

]);

export const operatorOracleMemoryInHarnessShared = harnessShared.table("operator_oracle_memory", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_oracle_memory_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_memory_pkey"}),

]);

export const operatorOraclePromptInHarnessShared = harnessShared.table("operator_oracle_prompt", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_oracle_prompt_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_prompt_pkey"}),

]);

export const operatorOwnerPinsInHarnessShared = harnessShared.table("operator_owner_pins", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_owner_pins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_owner_pins_pkey"}),

]);

export const operatorPausedInHarnessShared = harnessShared.table("operator_paused", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_paused_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_paused_pkey"}),

]);

export const operatorPotControlPolicyInHarnessShared = harnessShared.table("operator_pot_control_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_hive_control_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_pot_control_policy_pkey"}),

]);

export const operatorPreferencesInHarnessShared = harnessShared.table("operator_preferences", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_preferences_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_preferences_pkey"}),

]);

export const operatorPromptUserInHarnessShared = harnessShared.table("operator_prompt_user", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_prompt_user_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_prompt_user_pkey"}),

]);

export const operatorPublishCredentialsInHarnessShared = harnessShared.table("operator_publish_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_publish_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_publish_credentials_pkey"}),

]);

export const operatorQuotaOverridesInHarnessShared = harnessShared.table("operator_quota_overrides", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_quota_overrides_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_quota_overrides_pkey"}),

]);

export const operatorRateLimitInHarnessShared = harnessShared.table("operator_rate_limit", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_rate_limit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_rate_limit_pkey"}),

]);

export const operatorRateLimitConfigInHarnessShared = harnessShared.table("operator_rate_limit_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_rate_limit_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_rate_limit_config_pkey"}),

]);

export const operatorReleaseCheckpointConfigInHarnessShared = harnessShared.table("operator_release_checkpoint_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_release_checkpoint_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_release_checkpoint_config_pkey"}),

]);

export const operatorScalePolicyInHarnessShared = harnessShared.table("operator_scale_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_scale_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_scale_policy_pkey"}),

]);

export const operatorScoutBudgetInHarnessShared = harnessShared.table("operator_scout_budget", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_scout_budget_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_scout_budget_pkey"}),

]);

export const operatorSearchProviderCredentialsInHarnessShared = harnessShared.table("operator_search_provider_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	payloadCt: byteaCustom("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("osc_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_search_provider_credentials_pkey"}),

]);

export const operatorSecretsInHarnessShared = harnessShared.table("operator_secrets", {
	name: text().primaryKey().notNull(),
	valueB64: text("value_b64").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }),
});

export const operatorSessionConfinementsInHarnessShared = harnessShared.table("operator_session_confinements", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_session_confinements_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_session_confinements_pkey"}),

]);

export const operatorSettingsInHarnessShared = harnessShared.table("operator_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("operator_settings_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const operatorStandingCandidatesInHarnessShared = harnessShared.table("operator_standing_candidates", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_standing_candidates_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_standing_candidates_pkey"}),

]);

export const operatorSttSpendInHarnessShared = harnessShared.table("operator_stt_spend", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_stt_spend_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_stt_spend_pkey"}),

]);

export const operatorSupervisionPauseStateInHarnessShared = harnessShared.table("operator_supervision_pause_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_supervision_pause_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_supervision_pause_state_pkey"}),

]);

export const operatorTelemetryBufferConfigInHarnessShared = harnessShared.table("operator_telemetry_buffer_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_telemetry_buffer_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_telemetry_buffer_config_pkey"}),

]);

export const operatorTrustStoreInHarnessShared = harnessShared.table("operator_trust_store", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_trust_store_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_trust_store_pkey"}),

]);

export const operatorTtsSpendInHarnessShared = harnessShared.table("operator_tts_spend", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_tts_spend_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_tts_spend_pkey"}),

]);

export const operatorTurnsInHarnessShared = harnessShared.table("operator_turns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	seq: integer().notNull(),
	role: text().notNull(),
	text: text().notNull(),
	source: text().default('text_typed').notNull(),
	elConvId: text("el_conv_id"),
	audioUrl: text("audio_url"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	tools: jsonb(),
	textTsv: tsvectorCustom("text_tsv"),
	textEmbedding: vector("text_embedding", { dimensions: 768 }),
	report: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	textEmbeddingMode: text("text_embedding_mode"),
	textEmbeddingProfile: text("text_embedding_profile"),
}, (table) => [
	index("operator_turns_conv_seq_idx").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	index("operator_turns_report_recent_idx").using("btree", table.createdAt.asc().nullsLast().op("int8_ops")).where(sql`(report IS NOT NULL)`),
	index("operator_turns_text_embedding_hnsw").using("hnsw", table.textEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("operator_turns_text_embedding_mode_idx").using("btree", table.textEmbeddingMode.asc().nullsLast().op("text_ops")).where(sql`(text_embedding_mode IS NOT NULL)`),
	index("operator_turns_tsv_idx").using("gin", table.textTsv.asc().nullsLast().op("tsvector_ops")),
	index("operator_turns_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [operatorConversationsInHarnessShared.id],
			name: "operator_turns_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("operator_turns_conversation_id_seq_key").on(table.conversationId, table.seq),
	check("operator_turns_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])`),
	primaryKey({ columns: [table.id], name: "operator_turns_pkey"}),

]);

export const operatorTxnTimeoutsConfigInHarnessShared = harnessShared.table("operator_txn_timeouts_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_txn_timeouts_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_txn_timeouts_config_pkey"}),

]);

export const operatorUserProfileInHarnessShared = harnessShared.table("operator_user_profile", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_user_profile_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_user_profile_pkey"}),

]);

export const operatorVoiceChannelsInHarnessShared = harnessShared.table("operator_voice_channels", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_voice_channels_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_channels_pkey"}),

]);

export const operatorVoiceCredentialsInHarnessShared = harnessShared.table("operator_voice_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_voice_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_credentials_pkey"}),

]);

export const operatorVoicePrefsInHarnessShared = harnessShared.table("operator_voice_prefs", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_voice_prefs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_prefs_pkey"}),

]);

export const orchestratorSettingsInHarnessShared = harnessShared.table("orchestrator_settings", {
	id: integer().default(1).primaryKey().notNull(),
	tiers: jsonb().default([1,2,4]).notNull(),
	labels: jsonb().default(["trivial","normal","hard"]).notNull(),
	rubric: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("orchestrator_settings_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	check("orchestrator_settings_id_check", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "orchestrator_settings_pkey"}),

]);

export const orientationClassReachInHarnessShared = harnessShared.table("orientation_class_reach", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	sink: text().notNull(),
	classId: text("class_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	turnsRendered: bigint("turns_rendered", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rowsRendered: bigint("rows_rendered", { mode: "number" }).default(0).notNull(),
	firstRenderedAt: timestamp("first_rendered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastRenderedAt: timestamp("last_rendered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("orientation_class_reach_by_class").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sink.asc().nullsLast().op("text_ops"), table.classId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.classId, table.ownerId, table.sink, table.workspaceId], name: "orientation_class_reach_pkey"}),
]);

export const orientationObligationActionInHarnessShared = harnessShared.table("orientation_obligation_action", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	classId: text("class_id").notNull(),
	rowKey: text("row_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	turnsOutstanding: bigint("turns_outstanding", { mode: "number" }).default(0).notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dispositionedAt: timestamp("dispositioned_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	turnsToDisposition: bigint("turns_to_disposition", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dispositions: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("orientation_obligation_action_dispositioned").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.classId.asc().nullsLast().op("text_ops")).where(sql`(dispositioned_at IS NOT NULL)`),
	index("orientation_obligation_action_open").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops")).where(sql`(dispositioned_at IS NULL)`),
	primaryKey({ columns: [table.classId, table.ownerId, table.rowKey, table.workspaceId], name: "orientation_obligation_action_pkey"}),
]);

export const ownerActivityInHarnessShared = harnessShared.table("owner_activity", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	lastHumanTurnAt: timestamp("last_human_turn_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "owner_activity_pkey"}),
]);

export const ownerDirectiveAgendaInHarnessShared = harnessShared.table("owner_directive_agenda", {
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	directiveId: bigint("directive_id", { mode: "number" }).notNull(),
	ownerId: text("owner_id").notNull(),
	state: text().notNull(),
	reason: text(),
	actedAt: timestamp("acted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("owner_directive_agenda_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.directiveId.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.directiveId, table.ownerId, table.workspaceId], name: "owner_directive_agenda_pkey"}),
	check("owner_directive_agenda_dismissal_reason_required", sql`(state <> 'dismissed'::text) OR ((reason IS NOT NULL) AND (length(btrim(reason)) > 0))`),
	check("owner_directive_agenda_state_check", sql`state = ANY (ARRAY['open'::text, 'dismissed'::text])`),
]);

export const ownerDirectivesInHarnessShared = harnessShared.table("owner_directives", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	sessionRef: text("session_ref"),
	sourceTurnRef: text("source_turn_ref"),
	verbatimText: text("verbatim_text").notNull(),
	recordedBy: text("recorded_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dispositionedAt: timestamp("dispositioned_at", { withTimezone: true, mode: 'string' }),
	dispositionStatus: text("disposition_status"),
	dispositionNote: text("disposition_note"),
	dispositionedBy: text("dispositioned_by"),
	captureStatus: text("capture_status").default('open').notNull(),
	captureDismissalReason: text("capture_dismissal_reason"),
	captureDismissedAt: timestamp("capture_dismissed_at", { withTimezone: true, mode: 'string' }),
	captureDismissedBy: text("capture_dismissed_by"),
	capturePromotedAt: timestamp("capture_promoted_at", { withTimezone: true, mode: 'string' }),
	capturePromotedBy: text("capture_promoted_by"),
	capturedByHook: boolean("captured_by_hook").default(false).notNull(),
	capturePromotedNote: text("capture_promoted_note"),
	summaryText: text("summary_text"),
	summaryBy: text("summary_by"),
	summaryAt: timestamp("summary_at", { withTimezone: true, mode: 'string' }),
	reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: 'string' }),
	reopenedBy: text("reopened_by"),
	reopenReason: text("reopen_reason"),
	reopenedFrom: text("reopened_from"),
}, (table) => [
	index("owner_directives_hook_captured_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.capturedByHook.asc().nullsLast().op("bool_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`captured_by_hook`),
	index("owner_directives_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(dispositioned_at IS NULL)`),
	check("owner_directives_capture_status_check", sql`capture_status = 'open'::text`),
	check("owner_directives_disposition_consistent", sql`((dispositioned_at IS NULL) AND (disposition_status IS NULL)) OR ((dispositioned_at IS NOT NULL) AND (disposition_status IS NOT NULL))`),
	check("owner_directives_disposition_status_check", sql`disposition_status = ANY (ARRAY['done'::text, 'declined'::text])`),
	check("owner_directives_summary_consistent", sql`((summary_text IS NULL) AND (summary_by IS NULL) AND (summary_at IS NULL)) OR ((summary_text IS NOT NULL) AND (summary_by IS NOT NULL) AND (summary_at IS NOT NULL))`),
	check("owner_directives_summary_length_check", sql`(summary_text IS NULL) OR ((length(btrim(summary_text)) > 0) AND (length(summary_text) <= 200))`),
]);

export const ownerInteractionsInHarnessShared = harnessShared.table("owner_interactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	subjectKind: text("subject_kind").notNull(),
	subjectId: text("subject_id").default('').notNull(),
	payload: jsonb().default({}).notNull(),
}, (table) => [
	index("owner_interactions_ws_kind_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("owner_interactions_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id], name: "owner_interactions_pkey"}),

]);

export const p2PFleetDirectoryInHarnessShared = harnessShared.table("p2p_fleet_directory", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" }).notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	recordJson: text("record_json").notNull(),
	signerDevicePubkey: text("signer_device_pubkey").notNull(),
	signature: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recordVersion: bigint("record_version", { mode: "number" }).default(1).notNull(),
	archived: boolean().default(false).notNull(),
	fleetDirFedKey: text("fleet_dir_fed_key").generatedAlwaysAs(sql`(((owner_github_user_id)::text || '/'::text) || fleet_slug)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.fleetSlug, table.harnessSlug, table.ownerGithubUserId, table.workspaceId], name: "p2p_fleet_directory_pkey"}),
	pgPolicy("p2p_fleet_directory_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const p2PFleetLeaderLeasesInHarnessShared = harnessShared.table("p2p_fleet_leader_leases", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" }).notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	leaderGithubUserId: bigint("leader_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sinceMs: bigint("since_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rosterEpoch: bigint("roster_epoch", { mode: "number" }).default(0).notNull(),
	leaderLeaseFedKey: text("leader_lease_fed_key").generatedAlwaysAs(sql`(((owner_github_user_id)::text || '/'::text) || fleet_slug)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("p2p_fleet_leader_leases_hive_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.fleetSlug, table.harnessSlug, table.ownerGithubUserId, table.workspaceId], name: "p2p_fleet_leader_leases_pkey"}),
	pgPolicy("p2p_fleet_leader_leases_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_fleet_leader_leases_epoch_nonnegative", sql`(since_ms >= 0) AND (roster_epoch >= 0)`),
	check("p2p_fleet_leader_leases_owner_positive", sql`(owner_github_user_id > 0) AND (leader_github_user_id > 0)`),
]);

export const p2PForeignWorkspacesInHarnessShared = harnessShared.table("p2p_foreign_workspaces", {
	workspaceId: text("workspace_id").notNull(),
	offerId: text("offer_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	originGithubUserId: bigint("origin_github_user_id", { mode: "number" }).notNull(),
	executorDevice: text("executor_device").notNull(),
	rootPath: text("root_path").notNull(),
	clonePath: text("clone_path").notNull(),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	executionEpoch: bigint("execution_epoch", { mode: "number" }).default(0).notNull(),
	state: text().default('provisioning').notNull(),
	parkReason: text("park_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	baseSha: text("base_sha"),
}, (table) => [
	uniqueIndex("p2p_foreign_workspaces_root_path_key").using("btree", table.rootPath.asc().nullsLast().op("text_ops")),
	index("p2p_foreign_workspaces_session_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(session_id IS NOT NULL)`),
	index("p2p_foreign_workspaces_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.offerId, table.workspaceId], name: "p2p_foreign_workspaces_pkey"}),
	check("p2p_foreign_workspaces_state_check", sql`state = ANY (ARRAY['provisioning'::text, 'active'::text, 'winding-down'::text, 'parked'::text, 'reaped'::text])`),
]);

export const p2PGrantorEpochsInHarnessShared = harnessShared.table("p2p_grantor_epochs", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorGithubUserId: bigint("grantor_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	highWaterEpoch: bigint("high_water_epoch", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.grantorGithubUserId, table.harnessSlug, table.workspaceId], name: "p2p_grantor_epochs_pkey"}),
	check("p2p_grantor_epochs_nonneg", sql`high_water_epoch >= 0`),
]);

export const p2PMeteringContributionInHarnessShared = harnessShared.table("p2p_metering_contribution", {
	workspaceId: text("workspace_id").notNull(),
	attestedUserId: text("attested_user_id").notNull(),
	axis: text().notNull(),
	amount: doublePrecision().default(0).notNull(),
	unit: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.attestedUserId, table.axis, table.workspaceId], name: "p2p_metering_contribution_pkey"}),
	check("p2p_metering_contribution_axis", sql`axis = ANY (ARRAY['remote'::text, 'local'::text])`),
	check("p2p_metering_contribution_nonneg", sql`amount >= (0)::double precision`),
	check("p2p_metering_contribution_unit_nonempty", sql`unit <> ''::text`),
	check("p2p_metering_contribution_user_nonempty", sql`attested_user_id <> ''::text`),
	check("p2p_metering_contribution_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const p2PMeteringSpendInHarnessShared = harnessShared.table("p2p_metering_spend", {
	workspaceId: text("workspace_id").notNull(),
	hostRef: text("host_ref").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	axis: text().notNull(),
	amount: doublePrecision().default(0).notNull(),
	unit: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_metering_spend_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.axis, table.fleetSlug, table.hostRef, table.workspaceId], name: "p2p_metering_spend_pkey"}),
	check("p2p_metering_spend_axis", sql`axis = ANY (ARRAY['remote'::text, 'local'::text])`),
	check("p2p_metering_spend_fleet_nonempty", sql`fleet_slug <> ''::text`),
	check("p2p_metering_spend_host_nonempty", sql`host_ref <> ''::text`),
	check("p2p_metering_spend_nonneg", sql`amount >= (0)::double precision`),
	check("p2p_metering_spend_unit_nonempty", sql`unit <> ''::text`),
	check("p2p_metering_spend_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const p2PPeerGrantsInHarnessShared = harnessShared.table("p2p_peer_grants", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorGithubUserId: bigint("grantor_github_user_id", { mode: "number" }).notNull(),
	grantorLogin: text("grantor_login"),
	granteeKind: text("grantee_kind").notNull(),
	granteeRef: text("grantee_ref").notNull(),
	capabilities: text().array().default([]).notNull(),
	preset: text(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorEpoch: bigint("grantor_epoch", { mode: "number" }).default(0).notNull(),
	wakeRateCapPerHour: integer("wake_rate_cap_per_hour"),
	excludedDevicePubkeys: text("excluded_device_pubkeys").array().default([]).notNull(),
	note: text(),
	grantFedKey: text("grant_fed_key").generatedAlwaysAs(sql`(((((grantor_github_user_id)::text || ':'::text) || grantee_kind) || ':'::text) || grantee_ref)`),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_peer_grants_grantee_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.granteeKind.asc().nullsLast().op("text_ops"), table.granteeRef.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	primaryKey({ columns: [table.granteeKind, table.granteeRef, table.grantorGithubUserId, table.harnessSlug, table.workspaceId], name: "p2p_peer_grants_pkey"}),
	pgPolicy("p2p_peer_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_peer_grants_epoch_nonneg", sql`grantor_epoch >= 0`),
	check("p2p_peer_grants_grantee_kind", sql`grantee_kind = ANY (ARRAY['fleet'::text, 'pool'::text])`),
	check("p2p_peer_grants_grantee_nonempty", sql`grantee_ref <> ''::text`),
	check("p2p_peer_grants_grantor_pos", sql`grantor_github_user_id > 0`),
	check("p2p_peer_grants_slug_nonempty", sql`harness_slug <> ''::text`),
	check("p2p_peer_grants_status", sql`status = ANY (ARRAY['active'::text, 'revoked'::text])`),
	check("p2p_peer_grants_wake_cap_pos", sql`(wake_rate_cap_per_hour IS NULL) OR (wake_rate_cap_per_hour > 0)`),
	check("p2p_peer_grants_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const p2PReceiptsInHarnessShared = harnessShared.table("p2p_receipts", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	receiptId: text("receipt_id").notNull(),
	kind: text().notNull(),
	offerId: text("offer_id"),
	action: text().notNull(),
	refusalCode: text("refusal_code"),
	missingCapability: text("missing_capability"),
	budgetAxis: text("budget_axis"),
	detail: text().notNull(),
	requesterKind: text("requester_kind"),
	requesterRef: text("requester_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requesterGithubUserId: bigint("requester_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	responderGithubUserId: bigint("responder_github_user_id", { mode: "number" }).notNull(),
	responderDevicePubkey: text("responder_device_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	receiptTs: bigint("receipt_ts", { mode: "number" }).notNull(),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_receipts_offer_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.offerId.asc().nullsLast().op("text_ops"), table.receiptTs.asc().nullsLast().op("int8_ops")).where(sql`(offer_id IS NOT NULL)`),
	index("p2p_receipts_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.receiptTs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.receiptId, table.workspaceId], name: "p2p_receipts_pkey"}),
	pgPolicy("p2p_receipts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_receipts_action_nonempty", sql`action <> ''::text`),
	check("p2p_receipts_id_nonempty", sql`receipt_id <> ''::text`),
	check("p2p_receipts_kind", sql`kind = ANY (ARRAY['refusal'::text, 'excused-breach'::text, 'honored'::text])`),
	check("p2p_receipts_responder_pos", sql`responder_github_user_id > 0`),
	check("p2p_receipts_slug_nonempty", sql`harness_slug <> ''::text`),
	check("p2p_receipts_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const p2PRefusedOpCountersInHarnessShared = harnessShared.table("p2p_refused_op_counters", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.reason, table.workspaceId], name: "p2p_refused_op_counters_pkey"}),
	check("p2p_refused_op_counters_nonneg", sql`count >= 0`),
]);

export const p2PWorkOffersInHarnessShared = harnessShared.table("p2p_work_offers", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	publisherGithubUserId: bigint("publisher_github_user_id", { mode: "number" }).notNull(),
	offerId: text("offer_id").notNull(),
	recordJson: text("record_json").notNull(),
	signerDevicePubkey: text("signer_device_pubkey").notNull(),
	signature: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recordVersion: bigint("record_version", { mode: "number" }).default(1).notNull(),
	fleetSlug: text("fleet_slug"),
	offerKind: text("offer_kind").notNull(),
	status: text().default('open').notNull(),
	localDisposition: text("local_disposition"),
	offerFedKey: text("offer_fed_key").generatedAlwaysAs(sql`(((publisher_github_user_id)::text || '/'::text) || offer_id)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("p2p_work_offers_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("p2p_work_offers_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	primaryKey({ columns: [table.harnessSlug, table.offerId, table.publisherGithubUserId, table.workspaceId], name: "p2p_work_offers_pkey"}),
	pgPolicy("p2p_work_offers_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_work_offers_grantee", sql`((offer_kind <> 'seat'::text) AND (fleet_slug IS NOT NULL) AND (pot_slug IS NULL)) OR ((offer_kind = 'seat'::text) AND ((fleet_slug IS NOT NULL) <> (pot_slug IS NOT NULL)))`),
	check("p2p_work_offers_pot_nonempty", sql`(pot_slug IS NULL) OR (pot_slug <> ''::text)`),
]);

export const pendingEventsInHarnessShared = harnessShared.table("pending_events", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	kind: text().notNull(),
	targetRole: text("target_role").notNull(),
	payload: jsonb(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
	consumedBy: text("consumed_by"),
	sourceId: text("source_id"),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("pending_events_source_idx").using("btree", table.sourceId.asc().nullsLast().op("text_ops")),
	index("pending_events_unconsumed_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.dueAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(consumed_at IS NULL)`),
	index("pending_events_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("pending_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pending_events_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const pendingReviewsInHarnessShared = harnessShared.table("pending_reviews", {
	harnessSlug: text("harness_slug").notNull(),
	reviewId: text("review_id").notNull(),
	featureId: text("feature_id"),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	resolved: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	phase: text().default('staging').notNull(),
}, (table) => [
	index("pending_reviews_slug_resolved_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.resolved.asc().nullsLast().op("bool_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("pending_reviews_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.reviewId], name: "pending_reviews_pkey"}),
	pgPolicy("pending_reviews_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const pendingWakesInHarnessShared = harnessShared.table("pending_wakes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.pending_wakes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	ownerId: text("owner_id").notNull(),
	summary: text(),
	payload: jsonb(),
	source: text(),
	workspaceId: text("workspace_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	count: integer().default(1).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("pending_wakes_dedupe_idx").using("btree", sql`owner_id`, sql`COALESCE(source, ''::text)`, sql`COALESCE(summary, ''::text)`, sql`COALESCE(workspace_id, ''::text)`),
	index("pending_wakes_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("pending_wakes_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
]);

export const perfRegressionSnapshotsInHarnessShared = harnessShared.table("perf_regression_snapshots", {
	workspaceId: text("workspace_id").notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	loopLagP95Ms: doublePrecision("loop_lag_p95_ms"),
	connSaturationPct: doublePrecision("conn_saturation_pct"),
	dispatchOrphanRate: doublePrecision("dispatch_orphan_rate"),
	dispatchSample: integer("dispatch_sample"),
	coordOpenEscalations: integer("coord_open_escalations"),
	breached: jsonb(),
	advTabSwitchMedianMs: doublePrecision("adv_tab_switch_median_ms"),
	advFcpMs: doublePrecision("adv_fcp_ms"),
}, (table) => [
	index("perf_regression_snapshots_ws_captured_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.capturedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.capturedAt, table.workspaceId], name: "perf_regression_snapshots_pkey"}),
	pgPolicy("perf_regression_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const periodicSweepRunsInHarnessShared = harnessShared.table("periodic_sweep_runs", {
	sweepName: text("sweep_name").primaryKey().notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastReleased: integer("last_released").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("periodic_sweep_runs_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.sweepName], name: "periodic_sweep_runs_pkey"}),

]);

export const personalDocumentsInHarnessShared = harnessShared.table("personal_documents", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	source: text().notNull(),
	scopeKey: text("scope_key").generatedAlwaysAs(sql`('personal:'::text || source)`),
	kind: text().notNull(),
	externalId: text("external_id"),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }),
	participants: text().array().default(["RAY"]).notNull(),
	participantIds: uuid("participant_ids").array().default(["RAY"]).notNull(),
	title: text().default('').notNull(),
	text: text().default('').notNull(),
	metadata: jsonb().default({}).notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	embeddingMode: text("embedding_mode"),
	textTsv: tsvectorCustom("text_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(text, ''::text)))`),
	importedAt: timestamp("imported_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	embedding: vector({ dimensions: 768 }),
	sourceId: uuid("source_id"),
	providerAccountId: text("provider_account_id"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("personal_documents_account_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.source.asc().nullsLast().op("text_ops"), table.providerAccountId.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsLast().op("timestamptz_ops")),
	index("personal_documents_embedding_mode_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	index("personal_documents_participant_ids_idx").using("gin", table.participantIds.asc().nullsLast().op("array_ops")),
	index("personal_documents_participants_idx").using("gin", table.participants.asc().nullsLast().op("array_ops")),
	index("personal_documents_scope_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.scopeKey.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsLast().op("timestamptz_ops")),
	index("personal_documents_source_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.sourceId.asc().nullsLast().op("uuid_ops")).where(sql`(source_id IS NOT NULL)`),
	index("personal_documents_source_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.source.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsLast().op("timestamptz_ops")),
	index("personal_documents_text_tsv_idx").using("gin", table.textTsv.asc().nullsLast().op("tsvector_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_documents_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_documents_pkey"}),
	unique("personal_documents_workspace_id_user_id_source_dedupe_key_key").on(table.dedupeKey, table.source, table.userId, table.workspaceId),
	pgPolicy("personal_documents_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_documents_dedupe_key_check", sql`length(btrim(dedupe_key)) > 0`),
	check("personal_documents_embedding_mode_check", sql`(embedding_mode IS NULL) OR (embedding_mode = 'gemma'::text)`),
	check("personal_documents_kind_check", sql`length(btrim(kind)) > 0`),
	check("personal_documents_provider_account_nonempty", sql`(provider_account_id IS NULL) OR (length(btrim(provider_account_id)) > 0)`),
	check("personal_documents_source_check", sql`source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text`),
]);

export const personalGrantsInHarnessShared = harnessShared.table("personal_grants", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	principalType: text("principal_type").notNull(),
	principalId: text("principal_id").notNull(),
	scopes: text().array().notNull(),
	grantedBy: text("granted_by").notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
}, (table) => [
	index("personal_grants_authorization_lookup").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.principalType.asc().nullsLast().op("text_ops"), table.principalId.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	uniqueIndex("personal_grants_live_identity").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.principalType.asc().nullsLast().op("text_ops"), table.principalId.asc().nullsLast().op("text_ops"), table.scopes.asc().nullsLast().op("array_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_grants_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_grants_pkey"}),
	pgPolicy("personal_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_grants_check", sql`(expires_at IS NULL) OR (expires_at > granted_at)`),
	check("personal_grants_granted_by_check", sql`length(btrim(granted_by)) > 0`),
	check("personal_grants_principal_id_check", sql`length(btrim(principal_id)) > 0`),
	check("personal_grants_principal_type_check", sql`principal_type = ANY (ARRAY['plan-template'::text, 'binding'::text, 'agent-role'::text])`),
	check("personal_grants_scopes_check", sql`cardinality(scopes) > 0`),
]);

export const personalIdentitiesInHarnessShared = harnessShared.table("personal_identities", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	displayName: text("display_name").default('').notNull(),
	primaryEmail: text("primary_email"),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("personal_identities_primary_email_idx").using("btree", sql`workspace_id`, sql`user_id`, sql`lower(primary_email)`).where(sql`(primary_email IS NOT NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_identities_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_identities_pkey"}),
	pgPolicy("personal_identities_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const personalIdentityAliasesInHarnessShared = harnessShared.table("personal_identity_aliases", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	identityId: uuid("identity_id").notNull(),
	source: text().notNull(),
	aliasKind: text("alias_kind").notNull(),
	normalizedValue: text("normalized_value").notNull(),
	displayValue: text("display_value").default('').notNull(),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("personal_identity_aliases_identity_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.identityId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId, table.userId, table.identityId],
			foreignColumns: [personalIdentitiesInHarnessShared.workspaceId, personalIdentitiesInHarnessShared.userId, personalIdentitiesInHarnessShared.id],
			name: "personal_identity_aliases_workspace_id_user_id_identity_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_identity_aliases_pkey"}),
	unique("personal_identity_aliases_workspace_id_user_id_source_alias_key").on(table.aliasKind, table.normalizedValue, table.source, table.userId, table.workspaceId),
	pgPolicy("personal_identity_aliases_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_identity_aliases_alias_kind_check", sql`alias_kind = ANY (ARRAY['email'::text, 'contact'::text, 'social-handle'::text, 'name'::text])`),
	check("personal_identity_aliases_normalized_value_check", sql`length(btrim(normalized_value)) > 0`),
	check("personal_identity_aliases_source_check", sql`source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text`),
]);

export const personalSyncStateInHarnessShared = harnessShared.table("personal_sync_state", {
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	source: text().notNull(),
	cursor: jsonb().default({}).notNull(),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_sync_state_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.source, table.userId, table.workspaceId], name: "personal_sync_state_pkey"}),
	pgPolicy("personal_sync_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_sync_state_source_check", sql`source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text`),
]);

export const personalVaultImportJobsInHarnessShared = harnessShared.table("personal_vault_import_jobs", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	sourceId: uuid("source_id"),
	providerAccountId: text("provider_account_id"),
	filename: text().notNull(),
	storagePath: text("storage_path"),
	contentType: text("content_type"),
	contentSha256: text("content_sha256").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	status: text().default('queued').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesProcessed: bigint("bytes_processed", { mode: "number" }).default(0).notNull(),
	entriesProcessed: integer("entries_processed").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	documentsSeen: bigint("documents_seen", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	documentsImported: bigint("documents_imported", { mode: "number" }).default(0).notNull(),
	checkpoint: jsonb().default({"entryIndex":0,"recordIndex":0}).notNull(),
	warnings: jsonb().default([]).notNull(),
	cancelRequested: boolean("cancel_requested").default(false).notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	maxAttempts: integer("max_attempts").default(5).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	leaseOwner: text("lease_owner"),
	leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: 'string' }),
	retainedUntil: timestamp("retained_until", { withTimezone: true, mode: 'string' }).default(sql`(now() + '7 days'::interval)`).notNull(),
	lastError: text("last_error"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	entriesFailed: bigint("entries_failed", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("personal_vault_import_jobs_claim_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.nextAttemptAt.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['queued'::text, 'running'::text]))`),
	index("personal_vault_import_jobs_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("personal_vault_import_jobs_retention_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.retainedUntil.asc().nullsLast().op("timestamptz_ops")).where(sql`(storage_path IS NOT NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_vault_import_jobs_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_vault_import_jobs_pkey"}),
	unique("personal_vault_import_jobs_workspace_id_user_id_idempotency_key").on(table.idempotencyKey, table.userId, table.workspaceId),
	pgPolicy("personal_vault_import_jobs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_vault_import_entries_failed_nonnegative", sql`entries_failed >= 0`),
	check("personal_vault_import_jobs_attempt_count_check", sql`attempt_count >= 0`),
	check("personal_vault_import_jobs_bytes_processed_check", sql`bytes_processed >= 0`),
	check("personal_vault_import_jobs_content_sha256_check", sql`content_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("personal_vault_import_jobs_documents_imported_check", sql`documents_imported >= 0`),
	check("personal_vault_import_jobs_documents_seen_check", sql`documents_seen >= 0`),
	check("personal_vault_import_jobs_entries_processed_check", sql`entries_processed >= 0`),
	check("personal_vault_import_jobs_filename_check", sql`(length(btrim(filename)) >= 1) AND (length(btrim(filename)) <= 1024)`),
	check("personal_vault_import_jobs_idempotency_key_check", sql`idempotency_key ~ '^[0-9a-f]{64}$'::text`),
	check("personal_vault_import_jobs_max_attempts_check", sql`(max_attempts >= 1) AND (max_attempts <= 20)`),
	check("personal_vault_import_jobs_size_bytes_check", sql`size_bytes >= 0`),
	check("personal_vault_import_jobs_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])`),
	check("personal_vault_import_lease_shape", sql`((status = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL))`),
	check("personal_vault_import_source_account_pair", sql`(source_id IS NULL) OR (provider_account_id IS NOT NULL)`),
	check("personal_vault_import_storage_lifecycle", sql`(storage_path IS NOT NULL) OR (status = ANY (ARRAY['completed'::text, 'cancelled'::text]))`),
]);

export const personalVaultImportUploadsInHarnessShared = harnessShared.table("personal_vault_import_uploads", {
	id: uuid().defaultRandom().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	filename: text().notNull(),
	storagePath: text("storage_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	receivedBytes: bigint("received_bytes", { mode: "number" }).default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("personal_vault_import_uploads_expiry_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("personal_vault_import_uploads_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_vault_import_uploads_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.userId, table.workspaceId], name: "personal_vault_import_uploads_pkey"}),
	unique("personal_vault_import_uploads_workspace_id_storage_path_key").on(table.storagePath, table.workspaceId),
	pgPolicy("personal_vault_import_uploads_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("personal_vault_import_upload_declared_reservation", sql`(declared_size_bytes IS NULL) OR (declared_size_bytes <= reserved_bytes)`),
	check("personal_vault_import_upload_received_reservation", sql`received_bytes <= reserved_bytes`),
	check("personal_vault_import_uploads_declared_size_bytes_check", sql`declared_size_bytes > 0`),
	check("personal_vault_import_uploads_filename_check", sql`(length(btrim(filename)) >= 1) AND (length(btrim(filename)) <= 1024)`),
	check("personal_vault_import_uploads_received_bytes_check", sql`received_bytes >= 0`),
	check("personal_vault_import_uploads_reserved_bytes_check", sql`reserved_bytes > 0`),
]);

export const personalVaultSettingsInHarnessShared = harnessShared.table("personal_vault_settings", {
	workspaceId: text("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	enabled: boolean().default(true).notNull(),
	updatedBy: text("updated_by").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "personal_vault_settings_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.workspaceId], name: "personal_vault_settings_pkey"}),
	pgPolicy("personal_vault_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const pgQueryAdvisoryFiresInHarnessShared = harnessShared.table("pg_query_advisory_fires", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	advisoryLabel: text("advisory_label").notNull(),
	sessionId: text("session_id"),
	outcome: text().notNull(),
	deliveredWith: integer("delivered_with").default(1).notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pg_query_advisory_fires_label_window_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.advisoryLabel.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("pg_query_advisory_fires_window_idx").using("btree", table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("pg_query_advisory_fires_outcome_check", sql`outcome = ANY (ARRAY['success'::text, 'error'::text, 'refused'::text])`),
]);

export const piSessionsInHarnessShared = harnessShared.table("pi_sessions", {
	workspaceId: text("workspace_id").notNull(),
	sessionId: text("session_id").notNull(),
	bearerHash: text("bearer_hash").notNull(),
	capabilities: jsonb().default([]).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("pi_sessions_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(ended_at IS NULL)`),
	index("pi_sessions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.sessionId, table.workspaceId], name: "pi_sessions_pkey"}),
	pgPolicy("pi_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pi_sessions_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const pipelineEventsInHarnessShared = harnessShared.table("pipeline_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	detail: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pipeline_events_slug_created_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("pipeline_events_slug_kind_created_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("pipeline_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pipeline_events_kind_check", sql`kind = ANY (ARRAY['git_sync'::text, 'merge_resolver'::text, 'content_fixer'::text, 'green_checkpoint'::text, 'green_checkpoint_fire'::text, 'gate_fire_drill'::text, 'deploy'::text, 'release_fixer'::text, 'green_checkpoint_repair_latency'::text])`),
	check("pipeline_events_slug_nonempty", sql`install_slug <> ''::text`),
	check("pipeline_events_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const planAuditsInHarnessShared = harnessShared.table("plan_audits", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	auditSeq: integer("audit_seq").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	auditedSha: text("audited_sha"),
	items: jsonb().default([]).notNull(),
	findings: jsonb().default([]).notNull(),
	summary: text(),
	auditKind: text("audit_kind").default('completion').notNull(),
	activation: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	auditedPlanRevisionId: bigint("audited_plan_revision_id", { mode: "number" }),
	auditedPlanRevisionSeq: integer("audited_plan_revision_seq"),
	auditedPlanContentHash: text("audited_plan_content_hash"),
}, (table) => [
	index("plan_audits_created_by_idx").using("btree", table.createdBy.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("plan_audits_harness_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("plan_audits_kind_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.auditKind.asc().nullsLast().op("text_ops"), table.auditSeq.desc().nullsFirst().op("int4_ops")),
	primaryKey({ columns: [table.auditSeq, table.planSlug, table.workspaceId], name: "plan_audits_pkey"}),
	check("plan_audits_activation_shape_check", sql`(audit_kind = 'completion'::text) OR ((jsonb_typeof(activation) = 'object'::text) AND (audited_plan_revision_id IS NOT NULL) AND (audited_plan_revision_seq IS NOT NULL) AND (audited_plan_revision_seq > 0) AND (audited_plan_content_hash ~ '^[0-9a-f]{64}$'::text))`),
	check("plan_audits_kind_check", sql`audit_kind = ANY (ARRAY['completion'::text, 'activation'::text])`),
]);

export const planCleanupRunFindingsInHarnessShared = harnessShared.table("plan_cleanup_run_findings", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	findingId: text("finding_id").notNull(),
	findingKind: text("finding_kind").notNull(),
	planSlug: text("plan_slug").notNull(),
	harnessSlug: text("harness_slug"),
	itemId: text("item_id"),
	target: text().default('').notNull(),
	fromState: text("from_state").default('').notNull(),
	toState: text("to_state").default('').notNull(),
	confidence: text().default('recommended').notNull(),
	evidence: jsonb().default([]).notNull(),
	position: integer().default(0).notNull(),
	outcome: text().default('pending').notNull(),
	error: text(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	disposition: text(),
	recommendationKind: text("recommendation_kind"),
	recommendationLabel: text("recommendation_label"),
	recommendationRationale: text("recommendation_rationale"),
	evidenceBasis: jsonb("evidence_basis").default([]).notNull(),
	responsibility: text(),
	confidenceLevel: text("confidence_level"),
	retryCondition: text("retry_condition"),
}, (table) => [
	index("plan_cleanup_run_findings_disposition_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.disposition.asc().nullsLast().op("text_ops")),
	index("plan_cleanup_run_findings_plan_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	index("plan_cleanup_run_findings_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.position.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.findingId, table.runId, table.workspaceId], name: "plan_cleanup_run_findings_pkey"}),
	pgPolicy("plan_cleanup_run_findings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plan_cleanup_run_findings_confidence_check", sql`confidence = ANY (ARRAY['provable'::text, 'recommended'::text])`),
	check("plan_cleanup_run_findings_confidence_level_check", sql`(confidence_level IS NULL) OR (confidence_level = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'insufficient'::text]))`),
	check("plan_cleanup_run_findings_disposition_check", sql`(disposition IS NULL) OR (disposition = ANY (ARRAY['pending'::text, 'auto_resolved'::text, 'recommended'::text, 'owner_action'::text, 'cleanup_candidate'::text, 'retry_needed'::text, 'routed'::text, 'investigate'::text, 'failed'::text, 'dismissed'::text, 'legacy_skipped'::text]))`),
	check("plan_cleanup_run_findings_finding_kind_check", sql`finding_kind = ANY (ARRAY['enlist-plan'::text, 'flip-to-done'::text, 'cleared-blocker'::text, 'finish-plan'::text, 'orphaned-claim'::text, 'stale-now'::text, 'archive-candidate'::text, 'semantic'::text])`),
	check("plan_cleanup_run_findings_outcome_check", sql`outcome = ANY (ARRAY['pending'::text, 'auto_applied'::text, 'recommended'::text, 'accepted'::text, 'dismissed'::text, 'skipped'::text, 'failed'::text])`),
	check("plan_cleanup_run_findings_recommendation_kind_check", sql`(recommendation_kind IS NULL) OR (recommendation_kind = ANY (ARRAY['owner_action'::text, 'cleanup_candidate'::text, 'retry_needed'::text, 'routed'::text, 'investigate'::text]))`),
	check("plan_cleanup_run_findings_responsibility_check", sql`(responsibility IS NULL) OR (responsibility = ANY (ARRAY['owner'::text, 'agent'::text, 'system'::text, 'engineering'::text, 'unknown'::text]))`),
]);

export const planDecisionsInHarnessShared = harnessShared.table("plan_decisions", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	decisionId: text("decision_id").notNull(),
	seq: integer().notNull(),
	title: text().default('').notNull(),
	body: text().default('').notNull(),
	decisionDate: text("decision_date"),
	itemRefs: text("item_refs").array().default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	affects: text().array().default([]).notNull(),
}, (table) => [
	index("plan_decisions_affects_gin").using("gin", table.affects.asc().nullsLast().op("array_ops")),
	index("plan_decisions_item_refs_gin").using("gin", table.itemRefs.asc().nullsLast().op("array_ops")),
	index("plan_decisions_plan_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug],
			foreignColumns: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug],
			name: "plan_decisions_plan_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.decisionId, table.harnessSlug, table.planSlug, table.workspaceId], name: "plan_decisions_pkey"}),
]);

export const planItemAssignmentsInHarnessShared = harnessShared.table("plan_item_assignments", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	assigneeName: text("assignee_name"),
	assignedByUser: text("assigned_by_user"),
	assignedTs: timestamp("assigned_ts", { withTimezone: true, mode: 'string' }),
	releasedTs: timestamp("released_ts", { withTimezone: true, mode: 'string' }),
	strategy: text(),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	fedKey: text("fed_key").generatedAlwaysAs(sql`((plan_slug || ':'::text) || item_id)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("plan_item_assignments_assignee_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.assigneeName.asc().nullsLast().op("text_ops")).where(sql`((assignee_name IS NOT NULL) AND (released_ts IS NULL))`),
	index("plan_item_assignments_plan_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.itemId, table.planSlug, table.workspaceId], name: "plan_item_assignments_pkey"}),
	check("plan_item_assignments_item_nonempty", sql`item_id <> ''::text`),
	check("plan_item_assignments_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const planItemClaimsInHarnessShared = harnessShared.table("plan_item_claims", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	ownerName: text("owner_name"),
	intent: text().default('').notNull(),
	livenessMode: text("liveness_mode").default('availability').notNull(),
	ttlSec: integer("ttl_sec").default(1200).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
}, (table) => [
	index("plan_item_claims_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("plan_item_claims_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerName.asc().nullsLast().op("text_ops")).where(sql`(owner_name IS NOT NULL)`),
	index("plan_item_claims_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.itemId, table.planSlug, table.workspaceId], name: "plan_item_claims_pkey"}),
	check("plan_item_claims_mode_check", sql`liveness_mode = ANY (ARRAY['availability'::text, 'activity'::text])`),
	check("plan_item_claims_owner_nonempty", sql`owner <> ''::text`),
	check("plan_item_claims_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const planItemsInHarnessShared = harnessShared.table("plan_items", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	seq: integer().notNull(),
	itemText: text("item_text").default('').notNull(),
	status: text().default('todo').notNull(),
	importance: text(),
	phase: text(),
	blockedBy: text("blocked_by").array().default([]).notNull(),
	decisionRefs: text("decision_refs").array().default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ownerGateMarker: text("owner_gate_marker"),
}, (table) => [
	index("plan_items_blocked_by_gin").using("gin", table.blockedBy.asc().nullsLast().op("array_ops")),
	index("plan_items_plan_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	index("plan_items_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug],
			foreignColumns: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug],
			name: "plan_items_plan_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.harnessSlug, table.itemId, table.planSlug, table.workspaceId], name: "plan_items_pkey"}),
]);

export const planRevisionsInHarnessShared = harnessShared.table("plan_revisions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	planSlug: text("plan_slug").notNull(),
	seq: integer().notNull(),
	contentHash: text("content_hash").notNull(),
	contentSnapshot: text("content_snapshot").notNull(),
	rationale: text(),
	authorKind: text("author_kind").notNull(),
	authorId: text("author_id").notNull(),
	sessionId: text("session_id"),
	sessionKind: text("session_kind"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	harnessSlug: text("harness_slug").default('papercup').notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	contentSnapshotHash: text("content_snapshot_hash").generatedAlwaysAs(sql`encode(digest(content_snapshot, 'sha256'::text), 'hex'::text)`),
}, (table) => [
	unique("plan_revisions_ws_harness_plan_seq_key").on(table.harnessSlug, table.planSlug, table.seq, table.workspaceId),
	pgPolicy("plan_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const planRunTurnsInHarnessShared = harnessShared.table("plan_run_turns", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	planRunId: bigint("plan_run_id", { mode: "number" }).notNull(),
	seq: integer().notNull(),
	role: text().notNull(),
	content: text().notNull(),
	tokensIn: integer("tokens_in"),
	tokensOut: integer("tokens_out"),
	costUsd: numeric("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug"),
}, (table) => [
	index("plan_run_turns_harness_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("plan_run_turns_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.planRunId],
			foreignColumns: [planRunsInHarnessShared.id],
			name: "plan_run_turns_plan_run_id_fkey"
		}),
	unique("plan_run_turns_plan_run_id_seq_key").on(table.planRunId, table.seq),
	pgPolicy("plan_run_turns_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const planRunsInHarnessShared = harnessShared.table("plan_runs", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).default(sql`nextval('harness_shared.plan_runs_id_seq'::regclass)`).primaryKey().notNull(),
	planSlug: text("plan_slug").notNull(),
	planContentHash: text("plan_content_hash").notNull(),
	sessionId: text("session_id").notNull(),
	note: text(),
	launchedBy: text("launched_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	launchedAt: bigint("launched_at", { mode: "number" }).notNull(),
	status: text().notNull(),
	title: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	harnessSlug: text("harness_slug").default('papercup').notNull(),
	instancePlanSlug: text("instance_plan_slug"),
	runSeq: integer("run_seq"),
	trigger: text(),
	runType: text("run_type").default('interactive').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	finishedAt: bigint("finished_at", { mode: "number" }),
	outcome: text(),
	resultSummary: jsonb("result_summary"),
	workspaceId: text("workspace_id").default('').notNull(),
	inputs: jsonb(),
	outputs: jsonb(),
	replayItemKind: text("replay_item_kind"),
}, (table) => [
	index("plan_runs_harness_plan_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	index("plan_runs_plan_slug_idx").using("btree", table.planSlug.asc().nullsLast().op("text_ops")),
	index("plan_runs_template_seq_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.runSeq.desc().nullsFirst().op("int4_ops")),
	index("plan_runs_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("plan_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "plan_runs_pkey"}),

]);

export const planSpecClauseRevisionsInHarnessShared = harnessShared.table("plan_spec_clause_revisions", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	specId: text("spec_id").notNull(),
	revision: integer().notNull(),
	planItemId: text("plan_item_id").notNull(),
	behavior: text().notNull(),
	behaviorClass: text("behavior_class").notNull(),
	requiredEvidence: text("required_evidence").array().default(["RAY"]).notNull(),
	requiredTestLayers: text("required_test_layers").array().default(["RAY"]).notNull(),
	mutationRequired: boolean("mutation_required").default(false).notNull(),
	lifecycleStatus: text("lifecycle_status").notNull(),
	supersedesSpecId: text("supersedes_spec_id"),
	supersedesRevision: integer("supersedes_revision"),
	exemption: jsonb(),
	contentHash: text("content_hash").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acceptedBy: text("accepted_by"),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	acceptanceRef: text("acceptance_ref"),
	falsifier: jsonb(),
	sourceBarKey: text("source_bar_key"),
	sourceBarHash: text("source_bar_hash"),
	sourceBarSetHash: text("source_bar_set_hash"),
	sourceRubricSlug: text("source_rubric_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sourceRubricRevision: bigint("source_rubric_revision", { mode: "number" }),
	evidencePlane: text("evidence_plane"),
}, (table): PgTableExtraConfigValue[] => [
	index("plan_spec_clause_revisions_by_bar").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.sourceBarKey.asc().nullsLast().op("text_ops"), table.planItemId.asc().nullsLast().op("text_ops"), table.revision.desc().nullsFirst().op("int4_ops")).where(sql`(source_bar_key IS NOT NULL)`),
	index("plan_spec_clause_revisions_by_item").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.planItemId.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops"), table.revision.desc().nullsFirst().op("int4_ops")),
	index("plan_spec_clause_revisions_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.lifecycleStatus.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops")),
	index("plan_spec_clause_revisions_falsifier_declared").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops"), table.revision.desc().nullsFirst().op("int4_ops")).where(sql`(falsifier IS NOT NULL)`),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.supersedesSpecId, table.supersedesRevision],
			foreignColumns: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
			name: "plan_spec_clause_revisions_supersedes_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.specId],
			foreignColumns: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId],
			name: "plan_spec_clause_revisions_workspace_id_harness_slug_plan__fkey"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.harnessSlug, table.planSlug, table.revision, table.specId, table.workspaceId], name: "plan_spec_clause_revisions_pkey"}),
	pgPolicy("plan_spec_clause_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plan_spec_clause_revisions_acceptance_exact", sql`(lifecycle_status = ANY (ARRAY['accepted'::text, 'active'::text])) = (accepted_by IS NOT NULL)`),
	check("plan_spec_clause_revisions_bar_pin_complete", sql`((source_bar_key IS NULL) AND (source_bar_hash IS NULL) AND (source_bar_set_hash IS NULL) AND (source_rubric_slug IS NULL) AND (source_rubric_revision IS NULL) AND (evidence_plane IS NULL)) OR ((length(btrim(source_bar_key)) > 0) AND (source_bar_hash ~ '^[0-9a-f]{64}$'::text) AND (source_bar_set_hash ~ '^[0-9a-f]{64}$'::text) AND (length(btrim(source_rubric_slug)) > 0) AND (source_rubric_revision > 0) AND (evidence_plane = ANY (ARRAY['tree'::text, 'deployed'::text, 'live'::text])))`),
	check("plan_spec_clause_revisions_behavior_check", sql`length(btrim(behavior)) > 0`),
	check("plan_spec_clause_revisions_behavior_class_check", sql`behavior_class = ANY (ARRAY['happy-path'::text, 'boundary'::text, 'failure'::text, 'authorization'::text, 'concurrency'::text, 'lifecycle'::text, 'observability'::text, 'migration-data-integrity'::text, 'non-automated'::text])`),
	check("plan_spec_clause_revisions_check", sql`(supersedes_spec_id IS NULL) = (supersedes_revision IS NULL)`),
	check("plan_spec_clause_revisions_check1", sql`(accepted_by IS NULL) = (accepted_at IS NULL)`),
	check("plan_spec_clause_revisions_check2", sql`(lifecycle_status <> ALL (ARRAY['accepted'::text, 'active'::text])) OR (accepted_by IS NOT NULL)`),
	check("plan_spec_clause_revisions_check3", sql`(lifecycle_status <> 'exempt'::text) OR (exemption IS NOT NULL)`),
	check("plan_spec_clause_revisions_content_hash_check", sql`content_hash ~ '^[0-9a-f]{64}$'::text`),
	check("plan_spec_clause_revisions_exemption_exact", sql`(lifecycle_status = 'exempt'::text) = (exemption IS NOT NULL)`),
	check("plan_spec_clause_revisions_falsifier_shape", sql`(falsifier IS NULL) OR ((jsonb_typeof(falsifier) = 'object'::text) AND (falsifier ? 'observation'::text) AND (jsonb_typeof((falsifier -> 'observation'::text)) = 'string'::text) AND (length(btrim((falsifier ->> 'observation'::text))) > 0) AND ((NOT (falsifier ? 'probeMethod'::text)) OR ((jsonb_typeof((falsifier -> 'probeMethod'::text)) = 'string'::text) AND (length(btrim((falsifier ->> 'probeMethod'::text))) > 0))))`),
	check("plan_spec_clause_revisions_lifecycle_status_check", sql`lifecycle_status = ANY (ARRAY['draft'::text, 'accepted'::text, 'active'::text, 'superseded'::text, 'exempt'::text, 'retired'::text])`),
	check("plan_spec_clause_revisions_plan_item_id_check", sql`plan_item_id ~ '^P-[0-9]{3,}$'::text`),
	check("plan_spec_clause_revisions_revision_check", sql`revision > 0`),
	check("plan_spec_clause_revisions_supersedes_revision_check", sql`(supersedes_revision IS NULL) OR (supersedes_revision > 0)`),
]);

export const planSpecClausesInHarnessShared = harnessShared.table("plan_spec_clauses", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	specId: text("spec_id").notNull(),
	sourceValId: text("source_val_id"),
	currentRevision: integer("current_revision").default(0).notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("plan_spec_clauses_by_plan").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops")),
	uniqueIndex("plan_spec_clauses_source_val_identity").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.sourceValId.asc().nullsLast().op("text_ops")).where(sql`(source_val_id IS NOT NULL)`),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.specId, table.currentRevision],
			foreignColumns: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
			name: "plan_spec_clauses_current_revision_fk"
		}),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug],
			foreignColumns: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug],
			name: "plan_spec_clauses_plan_fk"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.harnessSlug, table.planSlug, table.specId, table.workspaceId], name: "plan_spec_clauses_pkey"}),
	pgPolicy("plan_spec_clauses_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plan_spec_clauses_current_revision_check", sql`current_revision >= 0`),
	check("plan_spec_clauses_source_val_id_check", sql`(source_val_id IS NULL) OR (source_val_id ~~ 'VAL-%'::text)`),
	check("plan_spec_clauses_spec_id_check", sql`length(btrim(spec_id)) > 0`),
]);

export const planWorkGroupMembersInHarnessShared = harnessShared.table("plan_work_group_members", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	memberUser: text("member_user").notNull(),
	memberName: text("member_name"),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.memberUser, table.planSlug, table.workspaceId], name: "plan_work_group_members_pkey"}),
	check("plan_work_group_members_user_nonempty", sql`member_user <> ''::text`),
]);

export const pluginAuditLogInHarnessShared = harnessShared.table("plugin_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).notNull(),
	pluginName: text("plugin_name").notNull(),
	installSlug: text("install_slug").notNull(),
	actionName: text("action_name").notNull(),
	triggerSource: text("trigger_source").notNull(),
	triggerId: text("trigger_id"),
	paramsJson: jsonb("params_json"),
	outcome: text().notNull(),
	durationMs: integer("duration_ms").notNull(),
	errorMessage: text("error_message"),
	capabilitiesUsed: text("capabilities_used").array(),
	killedByTimeout: boolean("killed_by_timeout"),
	stdoutBytes: integer("stdout_bytes"),
	stderrBytes: integer("stderr_bytes"),
	truncated: boolean(),
}, (table) => [
	index("plugin_audit_by_harness").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("plugin_audit_by_plugin").using("btree", table.pluginName.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("plugin_audit_outcome").using("btree", table.outcome.asc().nullsLast().op("text_ops")).where(sql`(outcome <> 'ok'::text)`),
]);

export const pluginCapabilityGrantsInHarnessShared = harnessShared.table("plugin_capability_grants", {
	pluginName: text("plugin_name").notNull(),
	pluginVersion: text("plugin_version").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	capability: text().notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	grantedBy: text("granted_by"),
	reason: text(),
}, (table) => [
	index("plugin_caps_by_harness").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.pluginName.asc().nullsLast().op("text_ops")),
	index("plugin_caps_by_plugin").using("btree", table.pluginName.asc().nullsLast().op("text_ops"), table.pluginVersion.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.capability, table.harnessSlug, table.pluginName, table.pluginVersion], name: "plugin_capability_grants_pkey"}),
]);

export const pluginConfigsInHarnessShared = harnessShared.table("plugin_configs", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	config: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	configCt: byteaCustom("config_ct"),
}, (table) => [
	index("plugin_configs_plugin_idx").using("btree", table.pluginSlug.asc().nullsLast().op("text_ops")),
	index("plugin_configs_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_configs_pkey"}),
	pgPolicy("plugin_configs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_configs_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const pluginEnablesInHarnessShared = harnessShared.table("plugin_enables", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	version: text().notNull(),
	configHash: text("config_hash").default('').notNull(),
	enabledAt: timestamp("enabled_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("plugin_enables_plugin_idx").using("btree", table.pluginSlug.asc().nullsLast().op("text_ops")),
	index("plugin_enables_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_enables_pkey"}),
	pgPolicy("plugin_enables_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_enables_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const pluginKvInHarnessShared = harnessShared.table("plugin_kv", {
	pluginId: text("plugin_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	key: text().notNull(),
	value: jsonb().notNull(),
	byteSize: integer("byte_size").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_plugin_kv_prefix").using("btree", table.pluginId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.key.asc().nullsLast().op("text_pattern_ops")),
	index("idx_plugin_kv_quota").using("btree", table.pluginId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.key, table.pluginId], name: "plugin_kv_pkey"}),
]);

export const pluginReloadStateInHarnessShared = harnessShared.table("plugin_reload_state", {
	pluginId: text("plugin_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	state: jsonb().notNull(),
	byteSize: integer("byte_size").notNull(),
	savedAt: timestamp("saved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.pluginId], name: "plugin_reload_state_pkey"}),
]);

export const potCapabilityClassBindingsInHarnessShared = harnessShared.table("pot_capability_class_bindings", {
	workspaceId: text("workspace_id").notNull(),
	potSlug: text("pot_slug").notNull(),
	classId: text("class_id").notNull(),
	classVersion: text("class_version").notNull(),
	providerPackage: text("provider_package").notNull(),
	providerVersion: text("provider_version").notNull(),
	boundBy: text("bound_by"),
	boundAt: timestamp("bound_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	providerKind: text("provider_kind").default('tool').notNull(),
	latencyClass: text("latency_class").default('sync').notNull(),
}, (table) => [
	index("pot_capability_class_provider_reverse_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.providerPackage.asc().nullsLast().op("text_ops"), table.providerVersion.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.classId, table.classVersion, table.providerPackage, table.providerVersion, table.providerKind, table.latencyClass],
			foreignColumns: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion, capabilityClassProviderBindingsInHarnessShared.providerPackage, capabilityClassProviderBindingsInHarnessShared.providerVersion, capabilityClassProviderBindingsInHarnessShared.providerKind, capabilityClassProviderBindingsInHarnessShared.latencyClass],
			name: "pot_capability_class_provider_fk"
		}),
	primaryKey({ columns: [table.classId, table.classVersion, table.potSlug, table.workspaceId], name: "pot_capability_class_bindings_pkey"}),
	pgPolicy("pot_capability_class_bindings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potDirectoryCacheInHarnessShared = harnessShared.table("pot_directory_cache", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_directory_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "pot_directory_cache_pkey"}),

]);

export const potDirectoryTombstonesInHarnessShared = harnessShared.table("pot_directory_tombstones", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_directory_tombstones_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "pot_directory_tombstones_pkey"}),

]);

export const potEpochKeysInHarnessShared = harnessShared.table("pot_epoch_keys", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	epoch: integer().notNull(),
	memberDevicePubkey: text("member_device_pubkey").notNull(),
	wrappedKey: text("wrapped_key").notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	epochKeyFedKey: text("epoch_key_fed_key").generatedAlwaysAs(sql`(((epoch)::text || ':'::text) || member_device_pubkey)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_epoch_keys_by_member").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.memberDevicePubkey.asc().nullsLast().op("text_ops"), table.epoch.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.epoch, table.harnessSlug, table.memberDevicePubkey, table.workspaceId], name: "pot_epoch_keys_pkey"}),
	pgPolicy("hive_epoch_keys_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potEvalBakeoffDeltasInHarnessShared = harnessShared.table("pot_eval_bakeoff_deltas", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	flagKey: text("flag_key").notNull(),
	deltaMeanComposite: doublePrecision("delta_mean_composite").notNull(),
	deltaGatePassRate: doublePrecision("delta_gate_pass_rate").notNull(),
	verdict: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	runAtMs: bigint("run_at_ms", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pot_eval_bakeoff_deltas_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runAtMs.desc().nullsFirst().op("int8_ops")),
]);

export const potEvalInstancesInHarnessShared = harnessShared.table("pot_eval_instances", {
	instanceId: text("instance_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	codeSha: text("code_sha").notNull(),
	genomeId: text("genome_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("pot_eval_instances_workspace_id_code_sha_genome_id_key").on(table.codeSha, table.genomeId, table.workspaceId),
	primaryKey({ columns: [table.instanceId], name: "pot_eval_instances_pkey"}),

]);

export const potEvalRunsInHarnessShared = harnessShared.table("pot_eval_runs", {
	runId: text("run_id").primaryKey().notNull(),
	instanceId: text("instance_id").notNull(),
	scenarioId: text("scenario_id").notNull(),
	shape: text().notNull(),
	repeat: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seed: bigint({ mode: "number" }).notNull(),
	budgetUsdCap: numeric("budget_usd_cap"),
	cupCap: integer("cup_cap"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	terminalState: text("terminal_state"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }),
	frontierDrained: boolean("frontier_drained"),
	workItemsTotal: integer("work_items_total"),
	workItemsCompleted: integer("work_items_completed"),
	costUsd: numeric("cost_usd"),
	observations: jsonb(),
	traceRef: text("trace_ref"),
}, (table) => [
	index("pot_eval_runs_instance_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	index("pot_eval_runs_scenario_idx").using("btree", table.scenarioId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [potEvalInstancesInHarnessShared.instanceId],
			name: "pot_eval_runs_instance_id_fkey"
		}).onDelete("cascade"),
	unique("pot_eval_runs_instance_id_scenario_id_repeat_key").on(table.instanceId, table.repeat, table.scenarioId),
	primaryKey({ columns: [table.runId], name: "pot_eval_runs_pkey"}),

]);

export const potEvalScenariosInHarnessShared = harnessShared.table("pot_eval_scenarios", {
	scenarioId: text("scenario_id").primaryKey().notNull(),
	title: text().notNull(),
	shape: text().notNull(),
	idealWallClockUnits: numeric("ideal_wall_clock_units").notNull(),
	idealCupCount: integer("ideal_cup_count").notNull(),
	totalUnits: numeric("total_units").notNull(),
	criticalPath: jsonb("critical_path").notNull(),
	workItemCount: integer("work_item_count").notNull(),
	plantedBugLocation: text("planted_bug_location"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.scenarioId], name: "pot_eval_scenarios_pkey"}),
]);

export const potEvalScoresInHarnessShared = harnessShared.table("pot_eval_scores", {
	runId: text("run_id").notNull(),
	rubricHash: text("rubric_hash").notNull(),
	rubricVersion: text("rubric_version").notNull(),
	outcomeGatePassed: boolean("outcome_gate_passed").notNull(),
	efficiencyScore: numeric("efficiency_score").notNull(),
	speedScore: numeric("speed_score").notNull(),
	composite: numeric().notNull(),
	judgeComposite: numeric("judge_composite"),
	regressions: boolean().notNull(),
	plantedBugCaught: boolean("planted_bug_caught").notNull(),
	fabricationDetected: boolean("fabrication_detected").notNull(),
	criticalPathRatio: numeric("critical_path_ratio").notNull(),
	floorCeiling: numeric("floor_ceiling").notNull(),
	detail: jsonb().notNull(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pot_eval_scores_composite_idx").using("btree", table.composite.asc().nullsLast().op("numeric_ops")),
	index("pot_eval_scores_run_idx").using("btree", table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [potEvalRunsInHarnessShared.runId],
			name: "pot_eval_scores_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.rubricHash, table.runId], name: "pot_eval_scores_pkey"}),
]);

export const potIntegrationRequestsInHarnessShared = harnessShared.table("pot_integration_requests", {
	workspaceId: text("workspace_id").default('').notNull(),
	repoKey: text("repo_key").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	headSha: text("head_sha").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
	reason: text().notNull(),
	state: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratifiedTs: bigint("ratified_ts", { mode: "number" }),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("pot_integration_requests_author_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.devicePubkey.asc().nullsLast().op("text_ops"), table.createdTs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.devicePubkey, table.headSha, table.potSlug, table.repoKey, table.workspaceId], name: "pot_integration_requests_pkey"}),
	check("pot_integration_requests_reason_check", sql`reason = 'below-steer-tier'::text`),
	check("pot_integration_requests_state_check", sql`state = ANY (ARRAY['pending'::text, 'ratified'::text])`),
]);

export const potMembersInHarnessShared = harnessShared.table("pot_members", {
	workspaceId: text("workspace_id").notNull(),
	potHomeSlug: text("pot_home_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	revokedPubkeys: text("revoked_pubkeys").array().default([]).notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	bindingStatus: text("binding_status").default('unverified').notNull(),
	channel1VerifiedAt: timestamp("channel1_verified_at", { withTimezone: true, mode: 'string' }),
	channel2VerifiedAt: timestamp("channel2_verified_at", { withTimezone: true, mode: 'string' }),
	channel2BranchRef: text("channel2_branch_ref"),
	bindingLastCheckedAt: timestamp("binding_last_checked_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	repoPermission: text("repo_permission"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	permissionCheckedAt: bigint("permission_checked_at", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("pot_members_username_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potHomeSlug.asc().nullsLast().op("text_ops"), table.githubUsername.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.potHomeSlug],
			foreignColumns: [potsInHarnessShared.workspaceId, potsInHarnessShared.canonicalPotHomeSlug],
			name: "pot_members_pot_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.githubUserId, table.potHomeSlug, table.workspaceId], name: "pot_members_pkey"}),
	pgPolicy("pot_members_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hive_members_workspace_id_concrete", sql`(workspace_id <> '*'::text) AND (workspace_id <> ''::text)`),
]);

export const potPendingJoinsInHarnessShared = harnessShared.table("pot_pending_joins", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	status: text().default('pending').notNull(),
	reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedAt: bigint("requested_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedAt: bigint("decided_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedByGithubUserId: bigint("decided_by_github_user_id", { mode: "number" }),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	pendingJoinFedKey: text("pending_join_fed_key").generatedAlwaysAs(sql`(github_user_id)::text`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_pending_joins_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.githubUserId, table.harnessSlug, table.workspaceId], name: "pot_pending_joins_pkey"}),
	pgPolicy("pot_pending_joins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potPlacementsInHarnessShared = harnessShared.table("pot_placements", {
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	harnessSlug: text("harness_slug"),
	mugOwnerId: text("mug_owner_id"),
	cupSpawnId: text("cup_spawn_id"),
	cupOwnerId: text("cup_owner_id"),
	status: text().default('working').notNull(),
	failCount: integer("fail_count").default(0).notNull(),
	lastDisposition: text("last_disposition"),
	escalationMsgId: text("escalation_msg_id"),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true, mode: 'string' }),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	infraLossCount: integer("infra_loss_count").default(0).notNull(),
	lastLossSpawnId: text("last_loss_spawn_id"),
	recoveryStartedAt: timestamp("recovery_started_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("pot_placements_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("pot_placements_recovering_age_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.recoveryStartedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'recovering'::text)`),
	primaryKey({ columns: [table.installSlug, table.workItemId, table.workspaceId], name: "pot_placements_pkey"}),
	check("pot_placements_status_check", sql`status = ANY (ARRAY['working'::text, 'recovering'::text, 'cursed'::text, 'stranded'::text, 'completed'::text, 'abandoned'::text, 'blocked'::text])`),
]);

export const potPolicyInHarnessShared = harnessShared.table("pot_policy", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	policyJson: text("policy_json").notNull(),
	ownerPubkey: text("owner_pubkey").notNull(),
	signature: text().notNull(),
	policyVersion: integer("policy_version").default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.workspaceId], name: "pot_policy_pkey"}),
	pgPolicy("pot_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potReportsInHarnessShared = harnessShared.table("pot_reports", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	reportId: text("report_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reporterGithubUserId: bigint("reporter_github_user_id", { mode: "number" }).notNull(),
	reporterGithubUsername: text("reporter_github_username"),
	targetKind: text("target_kind").notNull(),
	targetRef: text("target_ref").notNull(),
	reportReason: text("report_reason"),
	status: text().default('open').notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_reports_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.reportId, table.workspaceId], name: "pot_reports_pkey"}),
	pgPolicy("pot_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potSettingsInHarnessShared = harnessShared.table("pot_settings", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	settingKey: text("setting_key").notNull(),
	value: text(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	fedHlc: text("fed_hlc"),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.settingKey, table.workspaceId], name: "pot_settings_pkey"}),
	pgPolicy("pot_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potThroughputTicksInHarnessShared = harnessShared.table("pot_throughput_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.hive_throughput_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	frontierDepth: integer("frontier_depth").default(0).notNull(),
	placements: integer().default(0).notNull(),
	cupsBusy: integer("cups_busy").default(0).notNull(),
	cupsCap: integer("cups_cap").default(0).notNull(),
	stuckCount: integer("stuck_count").default(0).notNull(),
	completed: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttcMs: bigint("mttc_ms", { mode: "number" }),
	questionRungs: jsonb("question_rungs").default({}).notNull(),
	detail: jsonb(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("pot_throughput_ticks_ws_pot_tick_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("hive_throughput_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potWakeInHarnessShared = harnessShared.table("pot_wake", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_wake_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "pot_wake_pkey"}),

]);

export const potWatchdogFiresInHarnessShared = harnessShared.table("pot_watchdog_fires", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.hive_watchdog_fires_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	source: text().notNull(),
	reason: text().default('').notNull(),
	wakeAt: timestamp("wake_at", { withTimezone: true, mode: 'string' }),
	demand: jsonb().default({}).notNull(),
	repeatCount: integer("repeat_count").default(1).notNull(),
}, (table) => [
	index("pot_watchdog_fires_ws_install_fired_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("hive_watchdog_fires_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const potsInHarnessShared = harnessShared.table("pots", {
	workspaceId: text("workspace_id").notNull(),
	potHomeSlug: text("pot_home_slug").notNull(),
	publicKey: byteaCustom("public_key").notNull(),
	keychainId: text("keychain_id").notNull(),
	title: text(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	canonicalPotHomeSlug: text("canonical_pot_home_slug").notNull(),
}, (table) => [
	primaryKey({ columns: [table.potHomeSlug, table.workspaceId], name: "pots_pkey"}),
	unique("pots_public_key_key").on(table.publicKey),
	pgPolicy("pots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const powerUserSessionsInHarnessShared = harnessShared.table("power_user_sessions", {
	authSessionId: text("auth_session_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: text("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("power_user_sessions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("power_user_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.authSessionId], name: "power_user_sessions_pkey"}),

]);

export const prCheckStatusCacheInHarnessShared = harnessShared.table("pr_check_status_cache", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	headSha: text("head_sha").notNull(),
	checkName: text("check_name").notNull(),
	status: text().notNull(),
	conclusion: text(),
	detailsUrl: text("details_url"),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	raw: jsonb(),
}, (table) => [
	index("pr_check_status_cache_sha_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.headSha.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.checkName, table.harnessSlug, table.headSha, table.workspaceId], name: "pr_check_status_cache_pkey"}),
	pgPolicy("pr_check_status_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const prReviewReportsInHarnessShared = harnessShared.table("pr_review_reports", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	prNumber: integer("pr_number").notNull(),
	prUrl: text("pr_url").notNull(),
	headSha: text("head_sha").default('').notNull(),
	featureId: text("feature_id"),
	recommendation: text().notNull(),
	summary: text().notNull(),
	rationale: text().notNull(),
	risks: jsonb().default([]).notNull(),
	checksObserved: jsonb("checks_observed").default({}).notNull(),
	model: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costUsdCents: bigint("cost_usd_cents", { mode: "number" }).default(0).notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pr_review_reports_pr_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.prNumber.asc().nullsLast().op("int4_ops"), table.reviewedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.harnessSlug, table.headSha, table.prNumber, table.workspaceId], name: "pr_review_reports_pkey"}),
	pgPolicy("pr_review_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pr_review_reports_recommendation_check", sql`recommendation = ANY (ARRAY['approve'::text, 'request_changes'::text, 'reject'::text])`),
]);

export const prReviewerSettingsInHarnessShared = harnessShared.table("pr_reviewer_settings", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	prReviewerRoleEnabled: boolean("pr_reviewer_role_enabled").default(false).notNull(),
	autoReview: boolean("auto_review").default(false).notNull(),
	autoMerge: boolean("auto_merge").default(false).notNull(),
	mergeMethod: text("merge_method").default('squash').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.githubUserId, table.harnessSlug, table.workspaceId], name: "pr_reviewer_settings_pkey"}),
	pgPolicy("pr_reviewer_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pr_reviewer_settings_merge_method_check", sql`merge_method = ANY (ARRAY['squash'::text, 'merge'::text, 'rebase'::text])`),
]);

export const predicateWatchesInHarnessShared = harnessShared.table("predicate_watches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	role: text().default('su').notNull(),
	harnessSlug: text("harness_slug"),
	eventKey: text("event_key").notNull(),
	tool: text().notNull(),
	args: jsonb().default({}).notNull(),
	path: text().notNull(),
	op: text().notNull(),
	value: jsonb(),
	intervalSec: integer("interval_sec").default(60).notNull(),
	once: boolean().default(true).notNull(),
	lastEval: boolean("last_eval"),
	lastValue: jsonb("last_value"),
	lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	boundTo: jsonb("bound_to"),
	evaluatorBaselines: jsonb("evaluator_baselines").default({}).notNull(),
}, (table) => [
	index("predicate_watches_bound_to_active").using("btree", sql`((bound_to ->> 'kind'::text))`, sql`((bound_to ->> 'ref'::text))`).where(sql`((bound_to IS NOT NULL) AND active)`),
	index("predicate_watches_due").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.lastPolledAt.asc().nullsLast().op("timestamptz_ops")).where(sql`active`),
	index("predicate_watches_event_key").using("btree", table.eventKey.asc().nullsLast().op("text_ops")).where(sql`active`),
	check("predicate_watches_bound_to_shape", sql`(bound_to IS NULL) OR ((jsonb_typeof(bound_to) = 'object'::text) AND (bound_to ?& ARRAY['kind'::text, 'ref'::text]) AND ((bound_to - ARRAY['kind'::text, 'ref'::text]) = '{}'::jsonb) AND (jsonb_typeof((bound_to -> 'kind'::text)) = 'string'::text) AND (jsonb_typeof((bound_to -> 'ref'::text)) = 'string'::text) AND (length(btrim((bound_to ->> 'kind'::text))) > 0) AND (length(btrim((bound_to ->> 'ref'::text))) > 0))`),
	check("predicate_watches_interval_sec_check", sql`interval_sec >= 5`),
	check("predicate_watches_op_check", sql`op = ANY (ARRAY['eq'::text, 'ne'::text, 'gt'::text, 'gte'::text, 'lt'::text, 'lte'::text, 'exists'::text, 'contains'::text, 'changed'::text])`),
	primaryKey({ columns: [table.id], name: "predicate_watches_pkey"}),

]);

export const projectSpecRevisionsInHarnessShared = harnessShared.table("project_spec_revisions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	projectId: text("project_id").notNull(),
	spec: text().notNull(),
	summary: text(),
	authorRole: text("author_role").notNull(),
	author: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	includeDecisions: jsonb("include_decisions"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costUsdCents: bigint("cost_usd_cents", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("project_spec_revisions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	index("psr_author_role_idx").using("btree", table.authorRole.asc().nullsLast().op("text_ops")),
	index("psr_project_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("psr_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projectsInHarnessShared.id],
			name: "project_spec_revisions_project_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("project_spec_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("psr_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const projectsInHarnessShared = harnessShared.table("projects", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	spentCents: bigint("spent_cents", { mode: "number" }).default(0).notNull(),
	owningDept: text("owning_dept"),
	vertical: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	metadata: jsonb(),
	spec: text(),
	specUpdatedAt: timestamp("spec_updated_at", { withTimezone: true, mode: 'string' }),
	specManuallyEditedAt: timestamp("spec_manually_edited_at", { withTimezone: true, mode: 'string' }),
	slug: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costCapCents: bigint("cost_cap_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	earnedCents: bigint("earned_cents", { mode: "number" }).default(0).notNull(),
	parentSlug: text("parent_slug"),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(slug, ''::text)), 'B'::"char"))`),
	ephemeral: boolean().default(false).notNull(),
}, (table) => [
	index("projects_ephemeral_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")).where(sql`(ephemeral = true)`),
	index("projects_parent_idx").using("btree", table.parentSlug.asc().nullsLast().op("text_ops")),
	index("projects_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("projects_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("projects_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("projects_ws_slug_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.slug.asc().nullsLast().op("text_ops")),
	pgPolicy("projects_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("projects_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const promptAblationRunsInHarnessShared = harnessShared.table("prompt_ablation_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	playbookPath: text("playbook_path").notNull(),
	playbookHash: text("playbook_hash").notNull(),
	ruleKey: text("rule_key").notNull(),
	ruleHash: text("rule_hash").notNull(),
	ruleExcerpt: text("rule_excerpt").notNull(),
	origin: text().default('shadow').notNull(),
	scenarioCount: integer("scenario_count").default(0).notNull(),
	baselinePassRate: doublePrecision("baseline_pass_rate"),
	ablatedPassRate: doublePrecision("ablated_pass_rate"),
	passRateDelta: doublePrecision("pass_rate_delta"),
	verdict: text().notNull(),
	capped: boolean().default(false).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	ledgerContext: jsonb("ledger_context"),
	detail: jsonb().notNull(),
	replayLeg: jsonb("replay_leg"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("prompt_ablation_runs_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	index("prompt_ablation_runs_rule_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ruleKey.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("prompt_ablation_runs_origin_check", sql`origin = 'shadow'::text`),
	check("prompt_ablation_runs_verdict_check", sql`verdict = ANY (ARRAY['load-bearing'::text, 'no-delta'::text, 'improved'::text, 'inconclusive'::text])`),
	primaryKey({ columns: [table.id], name: "prompt_ablation_runs_pkey"}),

]);

export const promptCompositionsInHarnessShared = harnessShared.table("prompt_compositions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id"),
	role: text().notNull(),
	runId: text("run_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
	totalChars: integer("total_chars").default(0).notNull(),
	substrateChars: integer("substrate_chars").default(0).notNull(),
	historyChars: integer("history_chars").default(0).notNull(),
	rolePromptChars: integer("role_prompt_chars"),
	memoryChars: integer("memory_chars"),
	identityChars: integer("identity_chars"),
	runtimeChars: integer("runtime_chars"),
}, (table) => [
	index("prompt_compositions_by_feature").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.tsMs.desc().nullsFirst().op("int8_ops")).where(sql`(feature_id IS NOT NULL)`),
	index("prompt_compositions_by_harness").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.tsMs.desc().nullsFirst().op("int8_ops")),
	pgPolicy("prompt_compositions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const provisionAuditLogInHarnessShared = harnessShared.table("provision_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	runId: text("run_id"),
	data: jsonb(),
}, (table) => [
	index("provision_audit_log_target_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.pluginSlug.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("provision_audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const provisionStateInHarnessShared = harnessShared.table("provision_state", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug, table.workspaceId], name: "provision_state_pkey"}),
	pgPolicy("provision_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const psuPtyHostEventsInHarnessShared = harnessShared.table("psu_pty_host_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	ts: timestamp({ withTimezone: true }).notNull(),
	kind: text().notNull(),
	payload: jsonb().default({}).notNull(),
	ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowDigest: text("row_digest").notNull(),
}, (table) => [
	uniqueIndex("psu_pty_host_events_digest_uk").using("btree", table.rowDigest.asc().nullsLast().op("text_ops")),
	index("psu_pty_host_events_kind_ts_idx").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("psu_pty_host_events_owner_ts_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("psu_pty_host_events_ts_idx").using("btree", table.ts.asc().nullsLast().op("timestamptz_ops")),
]);

export const ptyViewerHeartbeatsInHarnessShared = harnessShared.table("pty_viewer_heartbeats", {
	ptyId: text("pty_id").primaryKey().notNull(),
	ownerSid: text("owner_sid").notNull(),
	viewerAttachedAt: timestamp("viewer_attached_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pty_viewer_heartbeats_fresh_idx").using("btree", table.viewerAttachedAt.asc().nullsLast().op("timestamptz_ops"), table.ownerSid.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.ptyId], name: "pty_viewer_heartbeats_pkey"}),

]);

export const pushDeliveryInHarnessShared = harnessShared.table("push_delivery", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.push_delivery_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	targetOwnerId: text("target_owner_id").notNull(),
	targetSessionId: text("target_session_id"),
	workspaceId: text("workspace_id").default('default').notNull(),
	matcherKind: text("matcher_kind").notNull(),
	severity: text().notNull(),
	handleKind: text("handle_kind").notNull(),
	handleRef: text("handle_ref").notNull(),
	handleQuery: jsonb("handle_query").default([]).notNull(),
	teaser: text().default('').notNull(),
	score: doublePrecision().default(0).notNull(),
	sourceSessionId: text("source_session_id"),
	status: text().default('queued').notNull(),
	dropReason: text("drop_reason"),
	enqueuedAt: timestamp("enqueued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	pulledAt: timestamp("pulled_at", { withTimezone: true, mode: 'string' }),
	actedAt: timestamp("acted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("push_delivery_delivered_idx").using("btree", table.targetOwnerId.asc().nullsLast().op("text_ops"), table.deliveredAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(status = 'delivered'::text)`),
	index("push_delivery_pending_idx").using("btree", table.targetOwnerId.asc().nullsLast().op("text_ops"), table.enqueuedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'queued'::text)`),
	index("push_delivery_ref_idx").using("btree", table.handleRef.asc().nullsLast().op("text_ops")),
]);

export const rationaleIndexInHarnessShared = harnessShared.table("rationale_index", {
	sourceId: text("source_id").notNull(),
	key: text().notNull(),
	entryId: text("entry_id").notNull(),
	kind: text(),
	entry: jsonb().notNull(),
	sortKey: text("sort_key"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("rationale_index_key_idx").using("btree", table.key.asc().nullsLast().op("text_ops"), table.sortKey.desc().nullsFirst().op("text_ops")),
	index("rationale_index_source_idx").using("btree", table.sourceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.entryId, table.key, table.sourceId], name: "rationale_index_pkey"}),
]);

export const redQueenDrillsInHarnessShared = harnessShared.table("red_queen_drills", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	drillClass: text("drill_class").notNull(),
	collectorFamily: text("collector_family").notNull(),
	status: text().default('planted').notNull(),
	plantedAt: timestamp("planted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	detectedAt: timestamp("detected_at", { withTimezone: true, mode: 'string' }),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	expectedWatchdogKey: text("expected_watchdog_key").notNull(),
	expectedKind: text("expected_kind").notNull(),
	expectedSeverity: text("expected_severity").notNull(),
	expectedDecision: text("expected_decision"),
	detectedWatchdogKey: text("detected_watchdog_key"),
	detectedKind: text("detected_kind"),
	triagedDecision: text("triaged_decision"),
	triagedIdeaType: text("triaged_idea_type"),
	resolvedWithEvidence: boolean("resolved_with_evidence").default(false).notNull(),
	issueId: text("issue_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshDetectMs: bigint("mttsh_detect_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshTriageMs: bigint("mttsh_triage_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshFixMs: bigint("mttsh_fix_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshTotalMs: bigint("mttsh_total_ms", { mode: "number" }),
	leakCheckPassed: boolean("leak_check_passed"),
	leakCheck: jsonb("leak_check"),
	plantedArtifacts: jsonb("planted_artifacts"),
	payload: jsonb(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("red_queen_drills_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.drillClass.asc().nullsLast().op("text_ops"), table.plantedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("red_queen_drills_open_class_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.drillClass.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['planted'::text, 'detected'::text, 'triaged'::text]))`),
	index("red_queen_drills_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.plantedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("red_queen_drills_expected_kind_check", sql`expected_kind = ANY (ARRAY['bug'::text, 'change'::text])`),
	check("red_queen_drills_status_check", sql`status = ANY (ARRAY['planted'::text, 'detected'::text, 'triaged'::text, 'resolved'::text, 'failed'::text, 'expired'::text])`),
	primaryKey({ columns: [table.id], name: "red_queen_drills_pkey"}),

]);

export const regretFindingsInHarnessShared = harnessShared.table("regret_findings", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text(),
	badnessScore: doublePrecision("badness_score").notNull(),
	badnessReasons: jsonb("badness_reasons").default([]).notNull(),
	divergenceTurn: integer("divergence_turn"),
	divergenceKind: text("divergence_kind"),
	divergenceEvidence: jsonb("divergence_evidence"),
	candidateChanges: jsonb("candidate_changes").default([]).notNull(),
	replayStatus: text("replay_status").default('pending').notNull(),
	replayScores: jsonb("replay_scores"),
	reportImprovementId: text("report_improvement_id"),
	minedAt: timestamp("mined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("regret_findings_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.minedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(replay_status = 'pending'::text)`),
	primaryKey({ columns: [table.runId, table.workspaceId], name: "regret_findings_pkey"}),
	check("regret_findings_divergence_kind_check", sql`(divergence_kind IS NULL) OR (divergence_kind = ANY (ARRAY['error-loop'::text, 'repeat-loop'::text, 'burn-inflection'::text, 'rescue-marker'::text]))`),
	check("regret_findings_replay_status_check", sql`replay_status = ANY (ARRAY['pending'::text, 'replayed'::text, 'skipped'::text])`),
]);

export const releasesInHarnessShared = harnessShared.table("releases", {
	workspaceId: text("workspace_id").notNull(),
	version: text().notNull(),
	channel: text().default('alpha').notNull(),
	cutAt: timestamp("cut_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	changelogMd: text("changelog_md"),
	workItemIds: text("work_item_ids").array().default([]).notNull(),
	planSlugs: text("plan_slugs").array().default([]).notNull(),
	artifacts: jsonb().default([]).notNull(),
	gitSha: text("git_sha"),
	cutBy: text("cut_by"),
	notes: text(),
}, (table) => [
	index("releases_ws_channel_cut_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.channel.asc().nullsLast().op("text_ops"), table.cutAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.channel, table.version, table.workspaceId], name: "releases_pkey"}),
]);

export const replayRunsInHarnessShared = harnessShared.table("replay_runs", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	batteryId: text("battery_id").notNull(),
	variantId: text("variant_id").notNull(),
	variantLabel: text("variant_label"),
	caseRef: text("case_ref").notNull(),
	turnIndex: integer("turn_index"),
	repeat: integer().default(0).notNull(),
	status: text().default('started').notNull(),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	d1: numeric(),
	d2: numeric(),
	d3: numeric(),
	composite: numeric(),
	judgeRationale: text("judge_rationale"),
	rubricHash: text("rubric_hash"),
	divergence: jsonb(),
	costUsd: numeric("cost_usd").default('0').notNull(),
	error: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("replay_runs_ws_battery_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.batteryId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("replay_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.runId, table.workspaceId], name: "replay_runs_pkey"}),
	pgPolicy("replay_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("replay_runs_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("replay_runs_status_check", sql`status = ANY (ARRAY['started'::text, 'scored'::text, 'rate_limited'::text, 'errored'::text])`),
]);

export const reportLibraryInHarnessShared = harnessShared.table("report_library", {
	workspaceId: text("workspace_id").notNull(),
	reportId: text("report_id").notNull(),
	title: text().notNull(),
	summary: text().default('').notNull(),
	bodyMd: text("body_md").default('').notNull(),
	kind: text().default('audit').notNull(),
	subjectKind: text("subject_kind").default('none').notNull(),
	subjectRef: text("subject_ref"),
	subjectLabel: text("subject_label"),
	originHarnessSlug: text("origin_harness_slug"),
	authorOwnerId: text("author_owner_id"),
	authorSessionRef: text("author_session_ref"),
	visibility: text().default('owner').notNull(),
	supersedesReportId: text("supersedes_report_id"),
	lineageId: text("lineage_id").notNull(),
	source: text().default('agent').notNull(),
	tags: text().array().default([]).notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	retiredAt: timestamp("retired_at", { withTimezone: true, mode: 'string' }),
	searchTsv: tsvectorCustom("search_tsv").generatedAlwaysAs(sql`(((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(subject_label, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, "left"(COALESCE(body_md, ''::text), 200000)), 'C'::"char"))`),
}, (table) => [
	index("report_library_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.publishedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("report_library_lineage_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.lineageId.asc().nullsLast().op("text_ops"), table.publishedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("report_library_origin_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.originHarnessSlug.asc().nullsLast().op("text_ops"), table.publishedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("report_library_published_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.publishedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(retired_at IS NULL)`),
	index("report_library_subject_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subjectKind.asc().nullsLast().op("text_ops"), table.subjectRef.asc().nullsLast().op("text_ops")),
	index("report_library_tags_idx").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("report_library_tsv_idx").using("gin", table.searchTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.reportId, table.workspaceId], name: "report_library_pkey"}),
	check("report_library_kind_allowed", sql`kind = ANY (ARRAY['audit'::text, 'review'::text, 'analysis'::text, 'postmortem'::text, 'status-digest'::text, 'proposal'::text, 'other'::text])`),
	check("report_library_subject_kind_allowed", sql`subject_kind = ANY (ARRAY['pot'::text, 'plan'::text, 'work_item'::text, 'fleet'::text, 'goal'::text, 'repo'::text, 'external'::text, 'none'::text])`),
	check("report_library_subject_ref_present", sql`(subject_kind = 'none'::text) OR (COALESCE(btrim(subject_ref), ''::text) <> ''::text)`),
	check("report_library_title_present", sql`btrim(title) <> ''::text`),
	check("report_library_visibility_allowed", sql`visibility = ANY (ARRAY['owner'::text, 'pot'::text, 'workspace'::text])`),
]);

export const reportLibraryChunksInHarnessShared = harnessShared.table("report_library_chunks", {
	workspaceId: text("workspace_id").notNull(),
	reportId: text("report_id").notNull(),
	chunkIdx: integer("chunk_idx").notNull(),
	text: text().notNull(),
	embedding: vector({ dimensions: 768 }),
	textEmbeddingMode: text("text_embedding_mode"),
	textEmbeddingProfile: text("text_embedding_profile"),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("report_library_chunks_embedding_hnsw").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("report_library_chunks_unembedded_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.reportId.asc().nullsLast().op("text_ops")).where(sql`(embedding IS NULL)`),
	foreignKey({
			columns: [table.workspaceId, table.reportId],
			foreignColumns: [reportLibraryInHarnessShared.workspaceId, reportLibraryInHarnessShared.reportId],
			name: "report_library_chunks_report_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.chunkIdx, table.reportId, table.workspaceId], name: "report_library_chunks_pkey"}),
]);

export const resourceAllotmentsInHarnessShared = harnessShared.table("resource_allotments", {
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug"),
	resourceKind: text("resource_kind").notNull(),
	resourceRef: text("resource_ref").notNull(),
	sharePct: integer("share_pct").default(0).notNull(),
	axis: jsonb().default({}).notNull(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	quantity: integer(),
	potSlug: text("pot_slug"),
	audience: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.resource_allotments_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
}, (table) => [
	index("resource_allotments_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	uniqueIndex("resource_allotments_fleet_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.resourceKind.asc().nullsLast().op("text_ops"), table.resourceRef.asc().nullsLast().op("text_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("resource_allotments_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")).where(sql`((status = 'active'::text) AND (pot_slug IS NOT NULL))`),
	uniqueIndex("resource_allotments_pot_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.resourceKind.asc().nullsLast().op("text_ops"), table.resourceRef.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	index("resource_allotments_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	check("resource_allotments_audience", sql`(audience IS NULL) OR (audience = ANY (ARRAY['trusted-members'::text, 'whole-pot'::text]))`),
	check("resource_allotments_audience_pot_only", sql`(pot_slug IS NOT NULL) = (audience IS NOT NULL)`),
	check("resource_allotments_fleet_nonempty", sql`fleet_slug <> ''::text`),
	check("resource_allotments_grantee_xor", sql`(fleet_slug IS NOT NULL) <> (pot_slug IS NOT NULL)`),
	check("resource_allotments_kind", sql`resource_kind = ANY (ARRAY['account'::text, 'gpu'::text, 'agent_slot'::text])`),
	check("resource_allotments_pct", sql`(share_pct >= 0) AND (share_pct <= 100)`),
	check("resource_allotments_pot_nonempty", sql`(pot_slug IS NULL) OR (pot_slug <> ''::text)`),
	check("resource_allotments_quantity", sql`((resource_kind = 'agent_slot'::text) AND (quantity IS NOT NULL) AND (quantity >= 1) AND (quantity <= 1000)) OR ((resource_kind <> 'agent_slot'::text) AND (quantity IS NULL))`),
	check("resource_allotments_ref_nonempty", sql`resource_ref <> ''::text`),
	check("resource_allotments_status", sql`status = ANY (ARRAY['active'::text, 'paused'::text])`),
	check("resource_allotments_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const resourceGovernorAdmissionsInHarnessShared = harnessShared.table("resource_governor_admissions", {
	workspaceId: text("workspace_id").notNull(),
	receiptId: text("receipt_id").default(sql`(\'RG-\'::text || (gen_random_uuid())::text)`).notNull(),
	record: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	schemaVersion: integer("schema_version").generatedAlwaysAs(sql`((record ->> 'schemaVersion'::text))::integer`),
	namespace: text().generatedAlwaysAs(sql`(record ->> 'namespace'::text)`),
	idempotencyKey: text("idempotency_key").generatedAlwaysAs(sql`(record ->> 'idempotencyKey'::text)`),
	requestFingerprint: text("request_fingerprint").generatedAlwaysAs(sql`(record ->> 'requestFingerprint'::text)`),
	admissionClass: text("admission_class").generatedAlwaysAs(sql`(record ->> 'admissionClass'::text)`),
	state: text().generatedAlwaysAs(sql`(record ->> 'state'::text)`),
	priority: doublePrecision().generatedAlwaysAs(sql`((record ->> 'priority'::text))::double precision`),
	coalesceKey: text("coalesce_key").generatedAlwaysAs(sql`NULLIF((record ->> 'coalesceKey'::text), ''::text)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	enqueuedAtMs: bigint("enqueued_at_ms", { mode: "number" }).generatedAlwaysAs(sql`((record ->> 'enqueuedAtMs'::text))::bigint`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAtMs: bigint("updated_at_ms", { mode: "number" }).generatedAlwaysAs(sql`((record ->> 'updatedAtMs'::text))::bigint`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deadlineAtMs: bigint("deadline_at_ms", { mode: "number" }).generatedAlwaysAs(sql`((record ->> 'deadlineAtMs'::text))::bigint`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decisionGeneration: bigint("decision_generation", { mode: "number" }).generatedAlwaysAs(sql`(((record -> 'decision'::text) ->> 'generation'::text))::bigint`),
	leaseOwner: text("lease_owner").generatedAlwaysAs(sql`NULLIF(btrim(((record -> 'lease'::text) ->> 'owner'::text)), ''::text)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	leaseExpiresAtMs: bigint("lease_expires_at_ms", { mode: "number" }).generatedAlwaysAs(sql`(((record -> 'lease'::text) ->> 'expiresAtMs'::text))::bigint`),
}, (table) => [
	index("resource_governor_admissions_active_coalesce_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.namespace.asc().nullsLast().op("text_ops"), table.coalesceKey.asc().nullsLast().op("text_ops"), table.enqueuedAtMs.desc().nullsFirst().op("int8_ops"), table.receiptId.asc().nullsLast().op("text_ops")).where(sql`((coalesce_key IS NOT NULL) AND (state = ANY (ARRAY['queued'::text, 'eligible'::text, 'leased'::text, 'running'::text])))`),
	index("resource_governor_admissions_active_lease_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.namespace.asc().nullsLast().op("text_ops"), table.leaseExpiresAtMs.asc().nullsLast().op("int8_ops"), table.leaseOwner.asc().nullsLast().op("text_ops"), table.receiptId.asc().nullsLast().op("text_ops")).where(sql`(state = ANY (ARRAY['leased'::text, 'running'::text]))`),
	index("resource_governor_admissions_active_queue_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.namespace.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.admissionClass.asc().nullsLast().op("text_ops"), table.priority.desc().nullsFirst().op("float8_ops"), table.enqueuedAtMs.asc().nullsLast().op("int8_ops"), table.receiptId.asc().nullsLast().op("text_ops")).where(sql`(state = ANY (ARRAY['queued'::text, 'eligible'::text]))`),
	index("resource_governor_admissions_pending_expiry_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.namespace.asc().nullsLast().op("text_ops"), table.deadlineAtMs.asc().nullsLast().op("int8_ops"), table.updatedAtMs.asc().nullsLast().op("int8_ops"), table.receiptId.asc().nullsLast().op("text_ops")).where(sql`(state = ANY (ARRAY['queued'::text, 'eligible'::text]))`),
	index("resource_governor_admissions_terminal_retention_idx").using("btree", table.updatedAtMs.asc().nullsLast().op("int8_ops"), table.workspaceId.asc().nullsLast().op("text_ops"), table.receiptId.asc().nullsLast().op("text_ops")).where(sql`(state = ANY (ARRAY['completed'::text, 'cancelled'::text, 'superseded'::text, 'expired'::text]))`),
	primaryKey({ columns: [table.receiptId, table.workspaceId], name: "resource_governor_admissions_pkey"}),
	unique("resource_governor_admissions_identity_uq").on(table.idempotencyKey, table.namespace, table.workspaceId),
	check("resource_governor_admissions_class_chk", sql`(admission_class IS NOT NULL) AND (btrim(admission_class) <> ''::text)`),
	check("resource_governor_admissions_decision_chk", sql`(decision_generation IS NOT NULL) AND (decision_generation >= 0)`),
	check("resource_governor_admissions_fingerprint_chk", sql`(request_fingerprint IS NOT NULL) AND (btrim(request_fingerprint) <> ''::text)`),
	check("resource_governor_admissions_idempotency_chk", sql`(idempotency_key IS NOT NULL) AND (btrim(idempotency_key) <> ''::text) AND (char_length(idempotency_key) <= 200)`),
	check("resource_governor_admissions_lease_chk", sql`((state = ANY (ARRAY['leased'::text, 'running'::text])) AND (lease_owner IS NOT NULL) AND (lease_expires_at_ms IS NOT NULL) AND (lease_expires_at_ms >= updated_at_ms)) OR ((state <> ALL (ARRAY['leased'::text, 'running'::text])) AND (lease_owner IS NULL) AND (lease_expires_at_ms IS NULL))`),
	check("resource_governor_admissions_namespace_chk", sql`(namespace IS NOT NULL) AND (btrim(namespace) <> ''::text)`),
	check("resource_governor_admissions_receipt_id_chk", sql`receipt_id ~ '^RG-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text`),
	check("resource_governor_admissions_record_object_chk", sql`jsonb_typeof(record) = 'object'::text`),
	check("resource_governor_admissions_schema_chk", sql`schema_version = 1`),
	check("resource_governor_admissions_state_chk", sql`state = ANY (ARRAY['queued'::text, 'eligible'::text, 'leased'::text, 'running'::text, 'completed'::text, 'cancelled'::text, 'superseded'::text, 'expired'::text])`),
	check("resource_governor_admissions_time_chk", sql`(enqueued_at_ms IS NOT NULL) AND (enqueued_at_ms >= 0) AND (updated_at_ms IS NOT NULL) AND (updated_at_ms >= enqueued_at_ms) AND ((deadline_at_ms IS NULL) OR (deadline_at_ms >= 0))`),
]);

export const roleCapabilityGrantsInHarnessShared = harnessShared.table("role_capability_grants", {
	workspaceId: text("workspace_id").notNull(),
	role: text().notNull(),
	capabilities: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.role, table.workspaceId], name: "role_capability_grants_pkey"}),
	pgPolicy("role_capability_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const routeInvocationsInHarnessShared = harnessShared.table("route_invocations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	method: text().notNull(),
	path: text().notNull(),
	status: text().notNull(),
	durationMs: integer("duration_ms"),
	principalKind: text("principal_kind"),
	principalAuthMethod: text("principal_auth_method"),
	principalTrust: text("principal_trust"),
	errorMessage: text("error_message"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedPath: text("resolved_path"),
	responseBytes: integer("response_bytes"),
}, (table) => [
	index("route_invocations_ws_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("route_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const routineGroupsInHarnessShared = harnessShared.table("routine_groups", {
	workspaceId: text("workspace_id").notNull(),
	slug: text().notNull(),
	description: text(),
	steward: text(),
	reviewCadence: text("review_cadence"),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.slug, table.workspaceId], name: "routine_groups_pkey"}),
	check("routine_groups_slug_nonempty", sql`slug <> ''::text`),
	check("routine_groups_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const routineLoopTransitionsInHarnessShared = harnessShared.table("routine_loop_transitions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.routine_loop_transitions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	routineId: text("routine_id").notNull(),
	routineName: text("routine_name"),
	targetRole: text("target_role"),
	targetOwnerId: text("target_owner_id"),
	event: text().notNull(),
	actor: text().notNull(),
	newNextFireAt: timestamp("new_next_fire_at", { withTimezone: true, mode: 'string' }),
	intervalSec: integer("interval_sec"),
	detail: jsonb(),
	host: text(),
}, (table) => [
	index("routine_loop_transitions_at_idx").using("btree", table.at.desc().nullsFirst().op("timestamptz_ops")),
	index("routine_loop_transitions_routine_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.routineId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const routinePoolShedEventsInHarnessShared = harnessShared.table("routine_pool_shed_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.routine_pool_shed_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	shedCount: integer("shed_count").notNull(),
	probeMs: integer("probe_ms"),
	host: text(),
}, (table) => [
	index("routine_pool_shed_events_workspace_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const routinesInHarnessShared = harnessShared.table("routines", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	name: text().notNull(),
	triggerKind: text("trigger_kind").notNull(),
	triggerConfig: jsonb("trigger_config").notNull(),
	targetRole: text("target_role").notNull(),
	payloadTemplate: jsonb("payload_template"),
	concurrency: text().default('queue').notNull(),
	catchup: text().default('skip-old').notNull(),
	active: boolean().default(true).notNull(),
	lastFiredAt: timestamp("last_fired_at", { precision: 3, withTimezone: true, mode: 'string' }),
	nextFireAt: timestamp("next_fire_at", { precision: 3, withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	rescheduleIntervalSec: integer("reschedule_interval_sec"),
	targetOwnerId: text("target_owner_id"),
	tier: text().default('durable').notNull(),
	groupSlug: text("group_slug"),
	activeChangedAt: timestamp("active_changed_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("routines_active_due_idx").using("btree", table.active.asc().nullsLast().op("bool_ops"), table.nextFireAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(active = true)`),
	index("routines_group_slug_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.groupSlug.asc().nullsLast().op("text_ops")).where(sql`(group_slug IS NOT NULL)`),
	index("routines_in_process_tier_idx").using("btree", table.tier.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")).where(sql`(tier = 'in-process'::text)`),
	index("routines_install_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops")),
	index("routines_loop_interval_idx").using("btree", table.rescheduleIntervalSec.asc().nullsLast().op("int4_ops")).where(sql`(reschedule_interval_sec IS NOT NULL)`),
	index("routines_tier_active_idx").using("btree", table.tier.asc().nullsLast().op("text_ops"), table.active.asc().nullsLast().op("bool_ops")).where(sql`(active = true)`),
	index("routines_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("routines_workspace_install_slug_name_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.groupSlug],
			foreignColumns: [routineGroupsInHarnessShared.workspaceId, routineGroupsInHarnessShared.slug],
			name: "routines_group_slug_fkey"
		}).onDelete("set null"),
	unique("routines_install_slug_name_key").on(table.installSlug, table.name),
	pgPolicy("routines_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("routines_reschedule_interval_positive", sql`(reschedule_interval_sec IS NULL) OR (reschedule_interval_sec > 0)`),
	check("routines_tier_check", sql`tier = ANY (ARRAY['durable'::text, 'ephemeral'::text, 'in-process'::text])`),
	check("routines_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const rubricAmendReceiptsInHarnessShared = harnessShared.table("rubric_amend_receipts", {
	workspaceId: text("workspace_id").notNull(),
	rubricRef: text("rubric_ref").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	state: text().notNull(),
	resultJson: jsonb("result_json"),
	error: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("rubric_amend_receipts_finished_idx").using("btree", table.finishedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(state <> 'running'::text)`),
	primaryKey({ columns: [table.idempotencyKey, table.rubricRef, table.workspaceId], name: "rubric_amend_receipts_pkey"}),
	pgPolicy("rubric_amend_receipts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("rubric_amend_receipts_state_check", sql`state = ANY (ARRAY['running'::text, 'committed'::text, 'previewed'::text, 'failed'::text])`),
]);

export const runtimeVintageInHarnessShared = harnessShared.table("runtime_vintage", {
	workspaceId: text("workspace_id").default('default').notNull(),
	unit: text().notNull(),
	host: text().notNull(),
	treeSha: text("tree_sha"),
	buildTime: timestamp("build_time", { withTimezone: true, mode: 'string' }),
	bundleVersion: text("bundle_version"),
	pid: integer(),
	extra: jsonb().default({}).notNull(),
	reportedAt: timestamp("reported_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("runtime_vintage_reported_at_idx").using("btree", table.reportedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.host, table.unit, table.workspaceId], name: "runtime_vintage_pkey"}),
]);

export const savedPromptsInHarnessShared = harnessShared.table("saved_prompts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	name: text().notNull(),
	body: text().notNull(),
	description: text(),
	argHint: text("arg_hint"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	parentId: uuid("parent_id"),
	position: text(),
	title: text(),
	collapsed: boolean().default(false).notNull(),
	pinned: boolean().default(false).notNull(),
	usageCount: integer("usage_count").default(0).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("saved_prompts_scope_name").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`, sql`name`),
	index("saved_prompts_scope_parent").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`, sql`parent_id`),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "saved_prompts_parent_fk"
		}).onDelete("cascade"),
	pgPolicy("saved_prompts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "saved_prompts_pkey"}),

]);

export const schemaMigrationsInHarnessShared = harnessShared.table("schema_migrations", {
	filename: text().primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sha256: text().notNull(),
});

export const scoutCycleStageArtifactsInHarnessShared = harnessShared.table("scout_cycle_stage_artifacts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.scout_cycle_stage_artifacts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	cycleId: text("cycle_id").notNull(),
	ideas: jsonb(),
	scored: jsonb(),
	proposals: jsonb(),
	ideatorSlots: jsonb("ideator_slots"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	routingDecisions: jsonb("routing_decisions"),
}, (table) => [
	index("scout_cycle_stage_artifacts_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	unique("scout_cycle_stage_artifacts_ws_cycle_uniq").on(table.cycleId, table.workspaceId),
	pgPolicy("scout_cycle_stage_artifacts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const scoutDigestSnapshotsInHarnessShared = harnessShared.table("scout_digest_snapshots", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.scout_digest_snapshots_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	cycleId: text("cycle_id"),
	watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: 'string' }),
	digest: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("scout_digest_snapshots_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("scout_digest_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const scoutLensWeightsInHarnessShared = harnessShared.table("scout_lens_weights", {
	workspaceId: text("workspace_id").notNull(),
	lens: text().notNull(),
	wins: integer().default(0).notNull(),
	decided: integer().default(0).notNull(),
	weight: numeric().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	primaryKey({ columns: [table.lens, table.potSlug, table.workspaceId], name: "scout_lens_weights_pkey"}),
	pgPolicy("scout_lens_weights_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const scoutRoutedIdeasInHarnessShared = harnessShared.table("scout_routed_ideas", {
	ideaId: text("idea_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	cycleId: text("cycle_id"),
	lens: text().notNull(),
	rail: text().notNull(),
	routedRef: text("routed_ref").notNull(),
	title: text(),
	addressesPatternRefs: jsonb("addresses_pattern_refs"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	routedAt: bigint("routed_at", { mode: "number" }).notNull(),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outcomeCheckedAt: bigint("outcome_checked_at", { mode: "number" }),
	humanGrade: smallint("human_grade"),
	humanFeedback: text("human_feedback"),
	gradedBy: text("graded_by"),
	gradedAt: timestamp("graded_at", { withTimezone: true, mode: 'string' }),
	sourceHive: text("source_hive"),
	targetHive: text("target_hive"),
	origin: text().default('scout').notNull(),
	createdBy: text("created_by"),
	modelSpec: text("model_spec"),
	modelConfig: jsonb("model_config"),
}, (table) => [
	index("scout_routed_ideas_routed_ref_idx").using("btree", table.routedRef.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_su_creator_idx").using("btree", table.origin.asc().nullsLast().op("text_ops"), table.createdBy.asc().nullsLast().op("text_ops")).where(sql`(origin = 'su-ideate'::text)`),
	index("scout_routed_ideas_ws_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_harness_lens_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.lens.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_model_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.modelSpec.asc().nullsLast().op("text_ops")).where(sql`(model_spec IS NOT NULL)`),
	index("scout_routed_ideas_ws_origin_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_source_hive_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceHive.asc().nullsLast().op("text_ops")),
	pgPolicy("scout_routed_ideas_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("scout_routed_ideas_human_grade_check", sql`(human_grade >= 1) AND (human_grade <= 5)`),
	primaryKey({ columns: [table.ideaId], name: "scout_routed_ideas_pkey"}),

]);

export const scoutSignalAccumulatorInHarnessShared = harnessShared.table("scout_signal_accumulator", {
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	lane: text().notNull(),
	newCount: integer("new_count").default(0).notNull(),
	highWaterAt: timestamp("high_water_at", { withTimezone: true, mode: 'string' }),
	watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.installSlug, table.lane, table.workspaceId], name: "scout_signal_accumulator_pkey"}),
	pgPolicy("scout_signal_accumulator_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const scoutTicksInHarnessShared = harnessShared.table("scout_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.scout_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text().default('ran').notNull(),
	gate: text(),
	ideasGenerated: integer("ideas_generated").default(0).notNull(),
	ideasRouted: integer("ideas_routed").default(0).notNull(),
	ideasDeduped: integer("ideas_deduped").default(0).notNull(),
	budgetUsedUsd: numeric("budget_used_usd"),
	detail: jsonb(),
	potSlug: text("pot_slug"),
	origin: text().default('scout').notNull(),
}, (table) => [
	index("scout_ticks_ws_origin_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")),
	index("scout_ticks_ws_pot_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("timestamptz_ops")),
	index("scout_ticks_ws_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("scout_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const searchJudgeGradesInHarnessShared = harnessShared.table("search_judge_grades", {
	workspaceId: text("workspace_id").notNull(),
	judgeModel: text("judge_model").notNull(),
	rubricVersion: text("rubric_version").notNull(),
	queryHash: text("query_hash").notNull(),
	docId: text("doc_id").notNull(),
	docTextHash: text("doc_text_hash").notNull(),
	relevance: real().notNull(),
	judgedRelevant: boolean("judged_relevant").notNull(),
	judgeNotes: text("judge_notes"),
	judgeCostUsd: numeric("judge_cost_usd", { precision: 12, scale:  6 }).default('0').notNull(),
	queryText: text("query_text").notNull(),
	pairId: text("pair_id"),
	runId: text("run_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("search_judge_grades_contract_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.judgeModel.asc().nullsLast().op("text_ops"), table.rubricVersion.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("search_judge_grades_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.docId, table.docTextHash, table.judgeModel, table.queryHash, table.rubricVersion, table.workspaceId], name: "search_judge_grades_pkey"}),
]);

export const secretsGuardPathExemptionsInHarnessShared = harnessShared.table("secrets_guard_path_exemptions", {
	workspaceId: text("workspace_id").notNull(),
	path: text().notNull(),
	reason: text().default('').notNull(),
	createdBy: text("created_by").default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.path, table.workspaceId], name: "secrets_guard_path_exemptions_pkey"}),
	pgPolicy("secrets_guard_path_exemptions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const sentinelSaysInHarnessShared = harnessShared.table("sentinel_says", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	line: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sessionArchiveFilesInHarnessShared = harnessShared.table("session_archive_files", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	relpath: text().notNull(),
	codec: text().default('zstd').notNull(),
	blob: byteaCustom("blob").notNull(),
	sha256: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesRaw: bigint("bytes_raw", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesStored: bigint("bytes_stored", { mode: "number" }).notNull(),
	mtime: timestamp({ withTimezone: true }),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.relpath, table.sessionId, table.sourceKind, table.workspaceId], name: "session_archive_files_pkey"}),
]);

export const sessionArchivesInHarnessShared = harnessShared.table("session_archives", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	owner: text(),
	harnessSlug: text("harness_slug"),
	cwd: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	advSessionId: bigint("adv_session_id", { mode: "number" }),
	sessionRoot: text("session_root").notNull(),
	fileCount: integer("file_count").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesRaw: bigint("bytes_raw", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesStored: bigint("bytes_stored", { mode: "number" }).notNull(),
	manifest: jsonb().notNull(),
	archivedBy: text("archived_by"),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_archives_adv_idx").using("btree", table.advSessionId.asc().nullsLast().op("int8_ops")).where(sql`(adv_session_id IS NOT NULL)`),
	index("session_archives_owner_idx").using("btree", table.owner.asc().nullsLast().op("text_ops"), table.archivedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId, table.sourceKind, table.workspaceId], name: "session_archives_pkey"}),
]);

export const sessionBriefsInHarnessShared = harnessShared.table("session_briefs", {
	ownerId: text("owner_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerLabel: text("owner_label").default('').notNull(),
	source: text().default('').notNull(),
	intent: text().default('').notNull(),
	currentPlanSlug: text("current_plan_slug"),
	currentFiles: jsonb("current_files").default([]).notNull(),
	harnessSlug: text("harness_slug"),
	nativeSessionId: text("native_session_id"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlGeneration: bigint("control_generation", { mode: "number" }).default(0).notNull(),
	controlState: jsonb("control_state"),
	controlUpdatedAt: timestamp("control_updated_at", { withTimezone: true, mode: 'string' }),
	controlTransition: jsonb("control_transition"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlDeliveredGeneration: bigint("control_delivered_generation", { mode: "number" }).default(0).notNull(),
	goalId: text("goal_id"),
	lastOrientDisclosures: jsonb("last_orient_disclosures"),
	lastOrientDisclosuresAt: timestamp("last_orient_disclosures_at", { withTimezone: true, mode: 'string' }),
	ambientExcludedRefs: jsonb("ambient_excluded_refs"),
}, (table) => [
	index("session_briefs_goal_id_idx").using("btree", table.goalId.asc().nullsLast().op("text_ops")).where(sql`(goal_id IS NOT NULL)`),
	index("session_briefs_native_session_id_idx").using("btree", table.nativeSessionId.asc().nullsLast().op("text_ops")).where(sql`(native_session_id IS NOT NULL)`),
	index("session_briefs_updated_at_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.ownerId], name: "session_briefs_pkey"}),

]);

export const sessionCursorInHarnessShared = harnessShared.table("session_cursor", {
	sessionId: text("session_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id"),
	harnessSlug: text("harness_slug"),
	turnTs: timestamp("turn_ts", { withTimezone: true, mode: 'string' }),
	noteCount: integer("note_count").default(0).notNull(),
	termCount: integer("term_count").default(0).notNull(),
	terms: jsonb().default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_cursor_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("session_cursor_updated_idx").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId], name: "session_cursor_pkey"}),

]);

export const sessionGateWatcherFilesInHarnessShared = harnessShared.table("session_gate_watcher_files", {
	workspaceId: text("workspace_id").notNull(),
	filePath: text("file_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.filePath, table.workspaceId], name: "session_gate_watcher_files_pkey"}),
]);

export const sessionIdentityActivationEventsInHarnessShared = harnessShared.table("session_identity_activation_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.session_identity_activation_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	actorId: text("actor_id").notNull(),
	principalId: text("principal_id").notNull(),
	sessionId: text("session_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	advSessionId: bigint("adv_session_id", { mode: "number" }),
	nativeSessionId: text("native_session_id"),
	transitionId: text("transition_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlGeneration: bigint("control_generation", { mode: "number" }).notNull(),
	phase: text().notNull(),
	source: text().notNull(),
	specificationRevision: text("specification_revision").notNull(),
	stateRevision: text("state_revision").notNull(),
	stackRefs: jsonb("stack_refs").default([]).notNull(),
	failure: text(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_identity_activation_applied_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.recordedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(phase = 'applied'::text)`),
	index("session_identity_activation_native_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.nativeSessionId.asc().nullsLast().op("text_ops"), table.recordedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(native_session_id IS NOT NULL)`),
	index("session_identity_activation_owner_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.recordedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")),
	unique("session_identity_activation_event_uniq").on(table.ownerId, table.phase, table.transitionId, table.workspaceId),
	pgPolicy("session_identity_activation_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("session_identity_activation_failure_ck", sql`((phase = 'failed'::text) AND (btrim(COALESCE(failure, ''::text)) <> ''::text)) OR ((phase <> 'failed'::text) AND (failure IS NULL))`),
	check("session_identity_activation_nonempty_ck", sql`(btrim(owner_id) <> ''::text) AND (btrim(actor_id) <> ''::text) AND (btrim(principal_id) <> ''::text) AND (btrim(session_id) <> ''::text) AND (btrim(transition_id) <> ''::text) AND (btrim(source) <> ''::text) AND (btrim(state_revision) <> ''::text)`),
	check("session_identity_activation_phase_ck", sql`phase = ANY (ARRAY['desired'::text, 'prepared'::text, 'applied'::text, 'failed'::text])`),
	check("session_identity_activation_spec_revision_ck", sql`specification_revision ~ '^[0-9a-f]{64}$'::text`),
	check("session_identity_activation_stack_ck", sql`jsonb_typeof(stack_refs) = 'array'::text`),
]);

export const sessionIngestStateInHarnessShared = harnessShared.table("session_ingest_state", {
	sourceKind: text("source_kind").notNull(),
	filePath: text("file_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
	turnCount: integer("turn_count").default(0).notNull(),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }),
	lastError: text("last_error"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	promptCount: integer("prompt_count").default(0).notNull(),
	responseCount: integer("response_count").default(0).notNull(),
	toolCallCount: integer("tool_call_count").default(0).notNull(),
	lastInferenceId: text("last_inference_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	countsBackfillOffset: bigint("counts_backfill_offset", { mode: "number" }).default(0).notNull(),
	countsBackfillLastInferenceId: text("counts_backfill_last_inference_id"),
	countsBackfilledAt: timestamp("counts_backfilled_at", { withTimezone: true, mode: 'string' }),
	partCount: integer("part_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	partsBackfillOffset: bigint("parts_backfill_offset", { mode: "number" }).default(0).notNull(),
	partsBackfilledAt: timestamp("parts_backfilled_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	primaryKey({ columns: [table.filePath, table.sourceKind], name: "session_ingest_state_pkey"}),
]);

export const sessionPendingGatesInHarnessShared = harnessShared.table("session_pending_gates", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.session_pending_gates_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	sessionId: text("session_id").notNull(),
	client: text().default('claude').notNull(),
	kind: text().notNull(),
	refId: text("ref_id").notNull(),
	ownerId: text("owner_id"),
	question: text(),
	options: jsonb(),
	source: text().default('watcher').notNull(),
	rawRef: text("raw_ref"),
	harnessSlug: text("harness_slug"),
	openedAt: timestamp("opened_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closedReason: text("closed_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decideBy: timestamp("decide_by", { withTimezone: true, mode: 'string' }),
	defaultIfUnanswered: jsonb("default_if_unanswered"),
}, (table) => [
	index("session_pending_gates_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_pending_gates_decide_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.decideBy.asc().nullsLast().op("timestamptz_ops")).where(sql`((closed_at IS NULL) AND (decide_by IS NOT NULL))`),
	index("session_pending_gates_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.openedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(closed_at IS NULL)`),
	uniqueIndex("session_pending_gates_ref_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.refId.asc().nullsLast().op("text_ops")),
	check("session_pending_gates_client_check", sql`client = ANY (ARRAY['claude'::text, 'omp'::text, 'codex'::text])`),
	check("session_pending_gates_closed_reason_check", sql`(closed_reason IS NULL) OR (closed_reason = ANY (ARRAY['tool_result_observed'::text, 'hook_cleared'::text, 'asker_gone'::text, 'default_applied'::text]))`),
	check("session_pending_gates_kind_check", sql`kind = ANY (ARRAY['ask'::text, 'permission_wait'::text])`),
	check("session_pending_gates_source_check", sql`source = ANY (ARRAY['watcher'::text, 'hook'::text])`),
]);

export const sessionPortsInHarnessShared = harnessShared.table("session_ports", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	protocolVersion: integer("protocol_version").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sourceAdvSessionId: bigint("source_adv_session_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	targetAdvSessionId: bigint("target_adv_session_id", { mode: "number" }),
	sourceBackend: text("source_backend").notNull(),
	targetBackend: text("target_backend").notNull(),
	targetModel: text("target_model"),
	status: text().default('prepared').notNull(),
	sourceHash: text("source_hash").notNull(),
	normalizedHash: text("normalized_hash").notNull(),
	renderedHash: text("rendered_hash").notNull(),
	tokenHash: text("token_hash").notNull(),
	artifactPath: text("artifact_path").notNull(),
	metadata: jsonb().default({}).notNull(),
	error: text(),
	preparedAt: timestamp("prepared_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	pendingAt: timestamp("pending_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	failedAt: timestamp("failed_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	retryOfPortId: uuid("retry_of_port_id"),
	logicalRequestKey: text("logical_request_key"),
}, (table) => [
	index("session_ports_logical_request_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.logicalRequestKey.asc().nullsLast().op("text_ops"), table.preparedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("session_ports_pending_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['prepared'::text, 'pending'::text]))`),
	index("session_ports_retry_idx").using("btree", table.retryOfPortId.asc().nullsLast().op("uuid_ops")).where(sql`(retry_of_port_id IS NOT NULL)`),
	index("session_ports_source_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceAdvSessionId.asc().nullsLast().op("int8_ops"), table.preparedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("session_ports_target_idx").using("btree", table.targetAdvSessionId.asc().nullsLast().op("int8_ops")).where(sql`(target_adv_session_id IS NOT NULL)`),
	unique("session_ports_workspace_id_idempotency_key_key").on(table.idempotencyKey, table.workspaceId),
	pgPolicy("session_ports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("session_ports_backend_check", sql`(source_backend = ANY (ARRAY['claude'::text, 'codex'::text, 'omp'::text])) AND (target_backend = ANY (ARRAY['claude'::text, 'codex'::text, 'omp'::text]))`),
	check("session_ports_status_check", sql`status = ANY (ARRAY['prepared'::text, 'pending'::text, 'delivered'::text, 'failed'::text, 'expired'::text])`),
	primaryKey({ columns: [table.id], name: "session_ports_pkey"}),

]);

export const sessionPromptOriginStampsInHarnessShared = harnessShared.table("session_prompt_origin_stamps", {
	workspaceId: text("workspace_id").notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	promptHash: text("prompt_hash").notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_prompt_origin_stamps_expiry_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_prompt_origin_stamps_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceKind.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.promptHash.asc().nullsLast().op("text_ops"), table.submittedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.promptHash, table.sessionId, table.sourceKind, table.submittedAt, table.workspaceId], name: "session_prompt_origin_stamps_pkey"}),
]);

export const sessionRespawnExpectedInHarnessShared = harnessShared.table("session_respawn_expected", {
	ownerId: text("owner_id").primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	reason: text().default('carry-respawn').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_session_respawn_expected_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.ownerId], name: "session_respawn_expected_pkey"}),

]);

export const sessionTaskWorkItemLinksInHarnessShared = harnessShared.table("session_task_work_item_links", {
	workspaceId: text("workspace_id").notNull(),
	sessionId: text("session_id").notNull(),
	taskId: text("task_id").notNull(),
	relation: text().notNull(),
	workItemHarness: text("work_item_harness").default('').notNull(),
	workItemId: text("work_item_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("session_task_work_item_links_one_for_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.taskId.asc().nullsLast().op("text_ops")).where(sql`(relation = 'for'::text)`),
	index("session_task_work_item_links_reverse_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.workItemHarness.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops"), table.relation.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.taskId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.sessionId, table.taskId],
			foreignColumns: [sessionTasksInHarnessShared.workspaceId, sessionTasksInHarnessShared.sessionId, sessionTasksInHarnessShared.taskId],
			name: "session_task_work_item_links_task_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.relation, table.sessionId, table.taskId, table.workItemHarness, table.workItemId, table.workspaceId], name: "session_task_work_item_links_pkey"}),
	pgPolicy("session_task_work_item_links_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("session_task_work_item_links_relation_check", sql`relation = ANY (ARRAY['for'::text, 'relates'::text])`),
	check("session_task_work_item_links_work_item_id_check", sql`(length(btrim(work_item_id)) >= 1) AND (length(btrim(work_item_id)) <= 240)`),
]);

export const sessionTasksInHarnessShared = harnessShared.table("session_tasks", {
	workspaceId: text("workspace_id").notNull(),
	sessionId: text("session_id").notNull(),
	taskId: text("task_id").notNull(),
	position: integer().notNull(),
	content: text().notNull(),
	activeForm: text("active_form").notNull(),
	status: text().notNull(),
	blockerRef: text("blocker_ref"),
	lastExplanation: text("last_explanation"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("session_tasks_one_in_progress_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(status = 'in_progress'::text)`),
	uniqueIndex("session_tasks_position_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.position.asc().nullsLast().op("int4_ops")),
	index("session_tasks_updated_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId, table.taskId, table.workspaceId], name: "session_tasks_pkey"}),
	pgPolicy("session_tasks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("session_tasks_active_form_check", sql`(length(btrim(active_form)) >= 1) AND (length(btrim(active_form)) <= 500)`),
	check("session_tasks_blocker_shape", sql`((status = 'blocked'::text) AND (blocker_ref IS NOT NULL) AND ((length(btrim(blocker_ref)) >= 1) AND (length(btrim(blocker_ref)) <= 2000))) OR ((status <> 'blocked'::text) AND (blocker_ref IS NULL))`),
	check("session_tasks_content_check", sql`(length(btrim(content)) >= 1) AND (length(btrim(content)) <= 4000)`),
	check("session_tasks_explanation_size", sql`(last_explanation IS NULL) OR ((length(btrim(last_explanation)) >= 1) AND (length(btrim(last_explanation)) <= 2000))`),
	check("session_tasks_position_check", sql`"position" >= 0`),
	check("session_tasks_status_check", sql`status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'blocked'::text, 'completed'::text, 'dropped'::text])`),
]);

export const sessionTurnChunksInHarnessShared = harnessShared.table("session_turn_chunks", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	chunkIdx: integer("chunk_idx").notNull(),
	content: text().notNull(),
	turnSha: text("turn_sha").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
}, (table) => [
	index("session_turn_chunks_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("session_turn_chunks_embedding_mode_idx").using("btree", table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	index("session_turn_chunks_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.workspaceId, table.sourceKind, table.sessionId, table.turnIdx],
			foreignColumns: [sessionTurnsInHarnessShared.workspaceId, sessionTurnsInHarnessShared.sourceKind, sessionTurnsInHarnessShared.sessionId, sessionTurnsInHarnessShared.turnIdx],
			name: "session_turn_chunks_parent_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.chunkIdx, table.sessionId, table.sourceKind, table.turnIdx, table.workspaceId], name: "session_turn_chunks_pkey"}),
]);

export const sessionTurnJournalInHarnessShared = harnessShared.table("session_turn_journal", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.session_turn_journal_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id"),
	agent: text(),
	sourceKind: text("source_kind").default('claude').notNull(),
	sessionId: text("session_id").notNull(),
	turnTs: timestamp("turn_ts", { withTimezone: true, mode: 'string' }),
	note: text().notNull(),
	source: text().notNull(),
	flagged: boolean().default(false).notNull(),
	tripwire: jsonb(),
	harnessSlug: text("harness_slug"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_turn_journal_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_turn_journal_owner_ts_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("session_turn_journal_turn_uq").using("btree", sql`session_id`, sql`COALESCE(turn_ts, '1969-12-31 19:00:00-05'::timestamp with time`),
	check("session_turn_journal_source_check", sql`source = ANY (ARRAY['agent'::text, 'mechanical'::text])`),
]);

export const sessionTurnPartsInHarnessShared = harnessShared.table("session_turn_parts", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	partIdx: integer("part_idx").notNull(),
	ts: timestamp({ withTimezone: true }),
	owner: text(),
	speaker: text().notNull(),
	partKind: text("part_kind").notNull(),
	toolName: text("tool_name"),
	text: text().notNull(),
	ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("session_turn_parts_ingested_idx").using("btree", table.ingestedAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_turn_parts_owner_ts_tool_use_idx").using("btree", table.owner.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(part_kind = 'tool_use'::text)`),
	primaryKey({ columns: [table.partIdx, table.sessionId, table.sourceKind, table.workspaceId], name: "session_turn_parts_pkey"}),
]);

export const sessionTurnsInHarnessShared = harnessShared.table("session_turns", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	ts: timestamp({ withTimezone: true }),
	owner: text(),
	harnessSlug: text("harness_slug"),
	cwd: text(),
	speaker: text().notNull(),
	text: text().notNull(),
	textTsv: tsvectorCustom("text_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, "left"(text, 20000))`),
	ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	textEmbedding: vector("text_embedding", { dimensions: 768 }),
	textEmbeddingMode: text("text_embedding_mode"),
	turnOrigin: text("turn_origin"),
	turnOriginVerdict: text("turn_origin_verdict"),
	turnOriginClassifierVersion: integer("turn_origin_classifier_version"),
	chunkedAt: timestamp("chunked_at", { withTimezone: true, mode: 'string' }),
	textEmbeddingProfile: text("text_embedding_profile"),
}, (table) => [
	index("session_turns_chunkable_idx").using("btree", table.ingestedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(length(text) > 2000)`),
	index("session_turns_embedding_idx").using("hnsw", table.textEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("session_turns_ingested_idx").using("btree", table.ingestedAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_turns_owner_ts_idx").using("btree", table.owner.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("timestamptz_ops")),
	index("session_turns_provenance_version_idx").using("btree", table.turnOriginClassifierVersion.asc().nullsLast().op("int4_ops")),
	index("session_turns_session_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("session_turns_text_embedding_mode_idx").using("btree", table.textEmbeddingMode.asc().nullsLast().op("text_ops")).where(sql`(text_embedding_mode IS NOT NULL)`),
	index("session_turns_tsv_idx").using("gin", table.textTsv.asc().nullsLast().op("tsvector_ops")),
	index("session_turns_unchunked_idx").using("btree", table.ingestedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((length(text) > 2000) AND (chunked_at IS NULL))`),
	primaryKey({ columns: [table.sessionId, table.sourceKind, table.turnIdx, table.workspaceId], name: "session_turns_pkey"}),
]);

export const setupWizardStateInHarnessShared = harnessShared.table("setup_wizard_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("setup_wizard_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "setup_wizard_state_pkey"}),

]);

export const sharedPresenceInHarnessShared = harnessShared.table("shared_presence", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	machineLabel: text("machine_label").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	intent: text(),
	currentView: text("current_view"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	authorPubkey: text("author_pubkey"),
	potSlug: text("pot_slug"),
	runsRoutines: boolean("runs_routines"),
	activeRoutines: text("active_routines").array(),
}, (table) => [
	index("shared_presence_fleet_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	index("shared_presence_pot_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	index("shared_presence_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	index("shared_presence_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUserId.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.githubUserId, table.harnessSlug, table.machineLabel, table.workspaceId], name: "shared_presence_pkey"}),
	pgPolicy("shared_presence_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const sharedRepoBindingCacheInHarnessShared = harnessShared.table("shared_repo_binding_cache", {
	workspaceId: text("workspace_id").default('').notNull(),
	provider: text().default('github').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
	githubFullName: text("github_full_name").notNull(),
	harnessTopic: text("harness_topic").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	harnessLink: text("harness_link").notNull(),
	privacy: text().notNull(),
	claimStatus: text("claim_status").default('unclaimed').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	provisionalOwnerGithubUserId: bigint("provisional_owner_github_user_id", { mode: "number" }).notNull(),
	provisionalOwnerGithubLogin: text("provisional_owner_github_login").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	claimedByGithubUserIds: bigint("claimed_by_github_user_ids", { mode: "number" }).array().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	lastPermissionVerifiedAt: timestamp("last_permission_verified_at", { withTimezone: true, mode: 'string' }),
	supersededByHarnessTopic: text("superseded_by_harness_topic"),
	cachedAt: timestamp("cached_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("srbc_by_full_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.githubFullName.asc().nullsLast().op("text_ops")),
	index("srbc_by_harness_topic_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessTopic.asc().nullsLast().op("text_ops")),
	index("srbc_stale_cache_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.cachedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text]))`),
	primaryKey({ columns: [table.githubRepositoryId, table.provider, table.workspaceId], name: "shared_repo_binding_cache_pkey"}),
	pgPolicy("shared_repo_binding_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("shared_repo_binding_cache_claim_status_check", sql`claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text, 'stale'::text, 'superseded'::text])`),
	check("shared_repo_binding_cache_privacy_check", sql`privacy = ANY (ARRAY['shared-private'::text, 'shared-public'::text])`),
	check("shared_repo_binding_cache_provider_check", sql`provider = 'github'::text`),
]);

export const sharedSessionPresenceInHarnessShared = harnessShared.table("shared_session_presence", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	ownerId: text("owner_id").notNull(),
	kind: text().default('su').notNull(),
	intent: text(),
	planSlug: text("plan_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	machineLabel: text("machine_label").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("shared_session_presence_device_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.devicePubkey.asc().nullsLast().op("text_ops")),
	index("shared_session_presence_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("shared_session_presence_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(pot_slug IS NOT NULL)`),
	primaryKey({ columns: [table.machineLabel, table.ownerId, table.workspaceId], name: "shared_session_presence_pkey"}),
]);

export const slotParkedMessagesInHarnessShared = harnessShared.table("slot_parked_messages", {
	id: text().notNull(),
	workspaceId: text("workspace_id").notNull(),
	slotKind: text("slot_kind").notNull(),
	slotRef: text("slot_ref").notNull(),
	harnessSlug: text("harness_slug"),
	fromOwner: text("from_owner").notNull(),
	envelope: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ttlMs: bigint("ttl_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deliveredTs: bigint("delivered_ts", { mode: "number" }),
	deliveredTo: text("delivered_to"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	droppedTs: bigint("dropped_ts", { mode: "number" }),
	droppedReason: text("dropped_reason"),
}, (table) => [
	index("slot_parked_messages_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.slotKind.asc().nullsLast().op("text_ops"), table.slotRef.asc().nullsLast().op("text_ops")).where(sql`((delivered_ts IS NULL) AND (dropped_ts IS NULL))`),
	primaryKey({ columns: [table.id, table.workspaceId], name: "slot_parked_messages_pkey"}),
	pgPolicy("slot_parked_messages_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const snapshotFeaturesInHarnessShared = harnessShared.table("snapshot_features", {
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	featureId: text("feature_id").notNull(),
	title: text().notNull(),
	summary: text(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).notNull(),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review").default(false).notNull(),
	deprecationReason: text("deprecation_reason"),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("sf_snapshot_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.snapshotId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.snapshotId], name: "snapshot_features_pkey"}),
]);

export const spawnSigVerificationFailuresInHarnessShared = harnessShared.table("spawn_sig_verification_failures", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	reason: text().notNull(),
	claimedRole: text("claimed_role"),
	claimedHarness: text("claimed_harness"),
	claimedWorkspace: text("claimed_workspace"),
	claimedSpawn: text("claimed_spawn"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expClaim: bigint("exp_claim", { mode: "number" }),
	remoteAddr: text("remote_addr"),
	userAgent: text("user_agent"),
	classification: text(),
}, (table) => [
	index("spawn_sig_failures_classification_idx").using("btree", table.classification.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(classification IS NOT NULL)`),
	index("spawn_sig_failures_reason_idx").using("btree", table.reason.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("spawn_sig_failures_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const spawnedAgentsInHarnessShared = harnessShared.table("spawned_agents", {
	spawnId: text("spawn_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	parentSpawnId: text("parent_spawn_id"),
	parentRole: text("parent_role").notNull(),
	childRole: text("child_role").notNull(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	exitCode: integer("exit_code"),
	outputTail: text("output_tail"),
	errorMessage: text("error_message"),
	cancelRequested: boolean("cancel_requested").default(false).notNull(),
	sessionOwner: text("session_owner"),
	coordinationDomain: text("coordination_domain").default('default').notNull(),
	planSlug: text("plan_slug"),
	itemId: text("item_id"),
	restartStrategy: text("restart_strategy").default('one_for_one').notNull(),
	restartCount: integer("restart_count").default(0).notNull(),
	restartWindowStart: timestamp("restart_window_start", { withTimezone: true, mode: 'string' }),
	cancelReason: text("cancel_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sessionId: text("session_id"),
	idempotencyKey: text("idempotency_key"),
	pid: integer(),
	launcherHost: text("launcher_host"),
	modelSpec: text("model_spec"),
	modelTier: text("model_tier"),
	brief: text(),
	lastOutputAt: timestamp("last_output_at", { withTimezone: true, mode: 'string' }),
	launcherBootId: text("launcher_boot_id"),
	fleetSlug: text("fleet_slug"),
	resultPath: text("result_path"),
	governorObservation: jsonb("governor_observation"),
}, (table) => [
	index("spawned_agents_active_heartbeat_idx").using("btree", table.heartbeatAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['running'::text, 'restarting'::text]))`),
	index("spawned_agents_fleet_slug_running_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`((fleet_slug IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'restarting'::text])))`),
	index("spawned_agents_governor_observation_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(governor_observation IS NOT NULL)`),
	uniqueIndex("spawned_agents_idempotency_key_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.idempotencyKey.asc().nullsLast().op("text_ops")).where(sql`(idempotency_key IS NOT NULL)`),
	index("spawned_agents_parent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentSpawnId.asc().nullsLast().op("text_ops")),
	index("spawned_agents_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("spawned_agents_running_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	index("spawned_agents_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(session_id IS NOT NULL)`),
	index("spawned_agents_session_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionOwner.asc().nullsLast().op("text_ops")).where(sql`(session_owner IS NOT NULL)`),
	pgPolicy("spawned_agents_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("spawned_agents_restart_strategy_chk", sql`restart_strategy = ANY (ARRAY['one_for_one'::text, 'one_for_all'::text, 'rest_for_one'::text])`),
	primaryKey({ columns: [table.spawnId], name: "spawned_agents_pkey"}),

]);

export const specEvidenceBindingsInHarnessShared = harnessShared.table("spec_evidence_bindings", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.spec_evidence_bindings_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	planSlug: text("plan_slug").notNull(),
	specId: text("spec_id").notNull(),
	specRevision: integer("spec_revision").notNull(),
	specFingerprint: text("spec_fingerprint").notNull(),
	evidenceKind: text("evidence_kind").notNull(),
	evidenceRef: text("evidence_ref").notNull(),
	sourceFingerprint: text("source_fingerprint").notNull(),
	testFingerprint: text("test_fingerprint"),
	fixtureFingerprint: text("fixture_fingerprint"),
	rubricFingerprint: text("rubric_fingerprint"),
	environmentFingerprint: text("environment_fingerprint"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	coverageEvidenceRef: bigint("coverage_evidence_ref", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	testRunId: bigint("test_run_id", { mode: "number" }),
	details: jsonb().default({}).notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	bindingFingerprint: text("binding_fingerprint").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	retractedAt: timestamp("retracted_at", { withTimezone: true, mode: 'string' }),
	retractedBy: text("retracted_by"),
	retractionReason: text("retraction_reason"),
}, (table) => [
	index("spec_evidence_bindings_by_spec").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops"), table.specRevision.asc().nullsLast().op("int4_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("spec_evidence_bindings_by_work_item").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("spec_evidence_bindings_dedup_live").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops"), table.specRevision.asc().nullsLast().op("int4_ops"), table.bindingFingerprint.asc().nullsLast().op("text_ops")).where(sql`(retracted_at IS NULL)`),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.workItemId, table.planSlug, table.specId, table.specRevision, table.specFingerprint],
			foreignColumns: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint],
			name: "spec_evidence_bindings_workspace_id_harness_slug_work_item_fkey"
		}).onDelete("restrict"),
	pgPolicy("spec_evidence_bindings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("spec_evidence_bindings_binding_fingerprint_check", sql`binding_fingerprint ~ '^[0-9a-f]{64}$'::text`),
	check("spec_evidence_bindings_details_check", sql`jsonb_typeof(details) = 'object'::text`),
	check("spec_evidence_bindings_environment_fingerprint_check", sql`(environment_fingerprint IS NULL) OR (length(btrim(environment_fingerprint)) > 0)`),
	check("spec_evidence_bindings_evidence_kind_check", sql`evidence_kind = ANY (ARRAY['test'::text, 'fixture'::text, 'coverage-census'::text, 'mutation'::text, 'counterexample'::text, 'check'::text, 'manual'::text, 'operational'::text])`),
	check("spec_evidence_bindings_evidence_ref_check", sql`length(btrim(evidence_ref)) > 0`),
	check("spec_evidence_bindings_fixture_fingerprint_check", sql`(fixture_fingerprint IS NULL) OR (length(btrim(fixture_fingerprint)) > 0)`),
	check("spec_evidence_bindings_retraction_complete", sql`((retracted_at IS NULL) AND (retracted_by IS NULL) AND (retraction_reason IS NULL)) OR ((retracted_at IS NOT NULL) AND (retracted_by IS NOT NULL) AND (length(btrim(retracted_by)) > 0) AND (retraction_reason IS NOT NULL) AND (length(btrim(retraction_reason)) > 0))`),
	check("spec_evidence_bindings_rubric_fingerprint_check", sql`(rubric_fingerprint IS NULL) OR (length(btrim(rubric_fingerprint)) > 0)`),
	check("spec_evidence_bindings_source_fingerprint_check", sql`length(btrim(source_fingerprint)) > 0`),
	check("spec_evidence_bindings_spec_fingerprint_check", sql`spec_fingerprint ~ '^[0-9a-f]{64}$'::text`),
	check("spec_evidence_bindings_spec_revision_check", sql`spec_revision > 0`),
	check("spec_evidence_bindings_test_fingerprint_check", sql`(test_fingerprint IS NULL) OR (length(btrim(test_fingerprint)) > 0)`),
]);

export const sqlReadCensusInHarnessShared = harnessShared.table("sql_read_census", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ranOn: date("ran_on").notNull(),
	windowDays: integer("window_days").notNull(),
	relation: text().notNull(),
	intentLabel: text("intent_label"),
	relationHasPairs: boolean("relation_has_pairs").default(false).notNull(),
	coveringTool: text("covering_tool"),
	equivalenceVerdict: text("equivalence_verdict"),
	distinctAgents: integer("distinct_agents").notNull(),
	calls: integer().notNull(),
	relationDistinctAgents: integer("relation_distinct_agents").notNull(),
	relationCalls: integer("relation_calls").notNull(),
	sampleAtom: text("sample_atom"),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliberatelyUnpaired: boolean("deliberately_unpaired").default(false).notNull(),
	deliberateDecisionRef: text("deliberate_decision_ref"),
	deliberateBaselineWindowDays: integer("deliberate_baseline_window_days"),
	deliberateBaselineCalls: integer("deliberate_baseline_calls"),
	deliberateBaselineAtoms: integer("deliberate_baseline_atoms"),
	deliberateBaselineDistinctAgents: integer("deliberate_baseline_distinct_agents"),
}, (table) => [
	index("sql_read_census_cluster_history_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.relation.asc().nullsLast().op("text_ops"), table.ranOn.desc().nullsFirst().op("date_ops")),
	uniqueIndex("sql_read_census_night_cluster_idx").using("btree", sql`workspace_id`, sql`ran_on`, sql`relation`, sql`COALESCE(intent_label, ''::text)`),
	check("sql_read_census_deliberate_no_pair_fields_check", sql`((deliberately_unpaired = false) AND (deliberate_decision_ref IS NULL)) OR ((deliberately_unpaired = true) AND (intent_label IS NULL) AND (relation_has_pairs = false) AND (deliberate_decision_ref IS NOT NULL) AND (deliberate_baseline_window_days IS NOT NULL) AND (deliberate_baseline_calls IS NOT NULL) AND (deliberate_baseline_atoms IS NOT NULL) AND (deliberate_baseline_distinct_agents IS NOT NULL))`),
]);

export const steeringChurnEscalationsInHarnessShared = harnessShared.table("steering_churn_escalations", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEscalatedTs: bigint("last_escalated_ts", { mode: "number" }).notNull(),
	churnCount: integer("churn_count").default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "steering_churn_escalations_pkey"}),
	pgPolicy("steering_churn_escalations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const steeringChurnEventsInHarnessShared = harnessShared.table("steering_churn_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.steering_churn_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	writer: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	featureOrder: bigint("feature_order", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("steering_churn_events_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("steering_churn_events_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	pgPolicy("steering_churn_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const substrateBootedHandlesStatusInHarnessShared = harnessShared.table("substrate_booted_handles_status", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "substrate_booted_handles_status_pkey"}),
]);

export const substrateMergeCursorInHarnessShared = harnessShared.table("substrate_merge_cursor", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	logKeyhex: text("log_keyhex").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	position: bigint({ mode: "number" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	applyBinding: text("apply_binding"),
	peerDevicePubkey: text("peer_device_pubkey"),
	peerLifecycleState: text("peer_lifecycle_state").default('unknown').notNull(),
	peerLifecycleUpdatedAt: timestamp("peer_lifecycle_updated_at", { withTimezone: true, mode: 'string' }),
	applyFailure: jsonb("apply_failure"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotApplyThrough: bigint("snapshot_apply_through", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotHole: bigint("snapshot_hole", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotMarkPosition: bigint("snapshot_mark_position", { mode: "number" }),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.logKeyhex, table.workspaceId], name: "substrate_merge_cursor_pkey"}),
	check("substrate_merge_cursor_apply_failure_check", sql`(apply_failure IS NULL) OR (((jsonb_typeof(apply_failure) = 'object'::text) AND (apply_failure ?& ARRAY['position'::text, 'kind'::text, 'groupKey'::text, 'reason'::text, 'attempts'::text, 'firstSeenAt'::text, 'lastSeenAt'::text]) AND (((apply_failure ->> 'position'::text))::bigint >= "position") AND (((apply_failure ->> 'attempts'::text))::bigint > 0) AND ((apply_failure ->> 'kind'::text) = ANY (ARRAY['rejected'::text, 'dependency-waiting'::text, 'retryable'::text]))) IS TRUE)`),
	check("substrate_merge_cursor_peer_lifecycle_identity_check", sql`(peer_lifecycle_state = 'unknown'::text) OR (peer_device_pubkey IS NOT NULL)`),
	check("substrate_merge_cursor_peer_lifecycle_state_check", sql`peer_lifecycle_state = ANY (ARRAY['unknown'::text, 'active'::text, 'retired'::text])`),
]);

export const substrateMetaInHarnessShared = harnessShared.table("substrate_meta", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	key: text().notNull(),
	value: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.key, table.workspaceId], name: "substrate_meta_pkey"}),
]);

export const substrateOutboxInHarnessShared = harnessShared.table("substrate_outbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	tableName: text("table_name").notNull(),
	op: text().notNull(),
	key: text().notNull(),
	row: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	drainedAt: bigint("drained_at", { mode: "number" }),
	opHlc: text("op_hlc"),
	drainedLogKey: text("drained_log_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	quarantinedAt: bigint("quarantined_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	enqueuedAtMs: bigint("enqueued_at_ms", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("substrate_outbox_drain_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.drainedAt.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("substrate_outbox_table_drain_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.tableName.asc().nullsLast().op("text_ops"), table.drainedAt.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	check("substrate_outbox_op_check", sql`op = ANY (ARRAY['put'::text, 'del'::text])`),
]);

export const supervisorNotesConsolidatedInHarnessShared = harnessShared.table("supervisor_notes_consolidated", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.supervisor_notes_consolidated_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	body: text().default('').notNull(),
	source: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
	index("supervisor_notes_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "supervisor_notes_consolidated_pkey"}),
]);

export const systemHealthAcksInHarnessShared = harnessShared.table("system_health_acks", {
	workspaceId: text("workspace_id").notNull(),
	panel: text().notNull(),
	status: text().notNull(),
	reason: text().notNull(),
	ackedBy: text("acked_by").notNull(),
	ackedAt: timestamp("acked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	snoozeUntil: timestamp("snooze_until", { withTimezone: true, mode: 'string' }),
}, (table) => [
	primaryKey({ columns: [table.panel, table.workspaceId], name: "system_health_acks_pkey"}),
	check("system_health_acks_status_check", sql`status = ANY (ARRAY['warn'::text, 'crit'::text])`),
]);

export const systemHealthTicksInHarnessShared = harnessShared.table("system_health_ticks", {
	workspaceId: text("workspace_id").notNull(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	overall: text().notNull(),
	statuses: jsonb().notNull(),
}, (table) => [
	index("idx_shealth_ticks_at").using("btree", table.at.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.at, table.workspaceId], name: "system_health_ticks_pkey"}),
]);

export const systemHealthTransitionsInHarnessShared = harnessShared.table("system_health_transitions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.system_health_transitions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	panel: text().notNull(),
	fromStatus: text("from_status").notNull(),
	toStatus: text("to_status").notNull(),
	summary: text(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("idx_shealth_transitions_ws_at").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_shealth_transitions_ws_panel_at").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.panel.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const systemPrincipalsInHarnessShared = harnessShared.table("system_principals", {
	workspaceId: text("workspace_id").notNull(),
	name: text().notNull(),
	bearerHash: text("bearer_hash").notNull(),
	capabilities: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("system_principals_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.name, table.workspaceId], name: "system_principals_pkey"}),
	pgPolicy("system_principals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("system_principals_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const taskLedgerInHarnessShared = harnessShared.table("task_ledger", {
	taskId: text("task_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	parentTaskId: text("parent_task_id"),
	rootTaskId: text("root_task_id").notNull(),
	class: text().notNull(),
	title: text().notNull(),
	argv: jsonb().default([]).notNull(),
	cwd: text(),
	launchedBy: text("launched_by").notNull(),
	workItemId: text("work_item_id"),
	planSlug: text("plan_slug"),
	fleetSlug: text("fleet_slug"),
	sessionId: text("session_id"),
	scopeUnit: text("scope_unit"),
	cgroupPath: text("cgroup_path"),
	pid: integer(),
	processIdentity: text("process_identity"),
	confined: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryMaxBytes: bigint("memory_max_bytes", { mode: "number" }),
	cpuWeight: integer("cpu_weight"),
	tasksMax: integer("tasks_max"),
	deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: 'string' }),
	state: text().default('pending').notNull(),
	exitCode: integer("exit_code"),
	exitReason: text("exit_reason"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastMemoryBytes: bigint("last_memory_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	peakMemoryBytes: bigint("peak_memory_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cpuUsec: bigint("cpu_usec", { mode: "number" }),
	pidsCurrent: integer("pids_current"),
	logPath: text("log_path"),
	detail: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("task_ledger_bash_job_id_idx").using("btree", sql`((detail ->> 'bashJobId'::text))`).where(sql`((class = 'bash-job'::text) AND (detail ? 'bashJobId'::text))`),
	index("task_ledger_deadline_idx").using("btree", table.deadlineAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((deadline_at IS NOT NULL) AND (ended_at IS NULL))`),
	index("task_ledger_ended_idx").using("btree", table.endedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(ended_at IS NOT NULL)`),
	index("task_ledger_launched_by_idx").using("btree", table.launchedBy.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("task_ledger_live_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(state = ANY (ARRAY['pending'::text, 'running'::text]))`),
	index("task_ledger_parent_idx").using("btree", table.parentTaskId.asc().nullsLast().op("text_ops")).where(sql`(parent_task_id IS NOT NULL)`),
	index("task_ledger_process_identity_idx").using("btree", table.processIdentity.asc().nullsLast().op("text_ops")).where(sql`(process_identity IS NOT NULL)`),
	index("task_ledger_root_idx").using("btree", table.rootTaskId.asc().nullsLast().op("text_ops")),
	uniqueIndex("task_ledger_scope_unit_key").using("btree", table.scopeUnit.asc().nullsLast().op("text_ops")).where(sql`(scope_unit IS NOT NULL)`),
	index("task_ledger_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("text_ops")).where(sql`(work_item_id IS NOT NULL)`),
	check("task_ledger_state_check", sql`state = ANY (ARRAY['pending'::text, 'running'::text, 'exited'::text, 'killed'::text, 'timed_out'::text, 'stranded'::text, 'unaccounted'::text, 'foreign'::text, 'ended_unobserved'::text])`),
	check("task_ledger_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.taskId], name: "task_ledger_pkey"}),

]);

export const telemetryReportsInHarnessShared = harnessShared.table("telemetry_reports", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("telemetry_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "telemetry_reports_pkey"}),

]);

export const telemetryReportsArchiveInHarnessShared = harnessShared.table("telemetry_reports_archive", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
	kind: text().notNull(),
	appVersion: text("app_version"),
	os: text(),
	payload: jsonb(),
	forwardedAt: timestamp("forwarded_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("telemetry_reports_archive_forwarded_at_idx").using("btree", table.forwardedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(forwarded_at IS NULL)`),
	index("telemetry_reports_archive_received_at_idx").using("btree", table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("telemetry_reports_archive_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("telemetry_reports_archive_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const testExecutedSourcesInHarnessShared = harnessShared.table("test_executed_sources", {
	workspaceName: text("workspace_name").notNull(),
	testFile: text("test_file").notNull(),
	recordedSha: text("recorded_sha").notNull(),
	executedModules: text("executed_modules").array().notNull(),
	moduleCount: integer("module_count").notNull(),
	runGroupId: text("run_group_id"),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	readPaths: text("read_paths").array().default([]).notNull(),
	inputsCaptured: boolean("inputs_captured").default(false).notNull(),
	opaqueReasons: text("opaque_reasons").array().default([]).notNull(),
	runContext: text("run_context"),
	runnerIdentity: text("runner_identity"),
}, (table) => [
	index("test_executed_sources_newest_idx").using("btree", table.workspaceName.asc().nullsLast().op("text_ops"), table.testFile.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.recordedSha, table.testFile, table.workspaceName], name: "test_executed_sources_pkey"}),
	check("test_executed_sources_count_matches", sql`module_count = cardinality(executed_modules)`),
	check("test_executed_sources_sha_shape", sql`recorded_sha ~ '^[0-9a-f]{7,64}$'::text`),
]);

export const testRunsInHarnessShared = harnessShared.table("test_runs", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	filePath: text("file_path").notNull(),
	framework: text().notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	outputTail: text("output_tail"),
	suiteId: text("suite_id"),
	runGroupId: text("run_group_id"),
	source: text().default('local').notNull(),
	branch: text(),
	commitSha: text("commit_sha"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	harnessSlug: text("harness_slug"),
	workspaceId: text("workspace_id"),
	loopLagP95Ms: real("loop_lag_p95_ms"),
	rssMb: real("rss_mb"),
	isScratchConfig: boolean("is_scratch_config").default(false).notNull(),
	worktreeDirty: boolean("worktree_dirty").default(false).notNull(),
	executionDetails: jsonb("execution_details"),
}, (table) => [
	index("test_runs_branch_idx").using("btree", table.branch.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(branch IS NOT NULL)`),
	index("test_runs_file_path_idx").using("btree", table.filePath.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("test_runs_harness_scope_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.workspaceId.asc().nullsLast().op("text_ops"), table.filePath.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("test_runs_run_group_idx").using("btree", table.runGroupId.asc().nullsLast().op("text_ops")).where(sql`(run_group_id IS NOT NULL)`),
	index("test_runs_source_idx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("test_runs_source_valid", sql`source = ANY (ARRAY['ci'::text, 'local'::text, 'admin-ui'::text, 'mutation-probe'::text])`),
	check("test_runs_status_valid", sql`status = ANY (ARRAY['pass'::text, 'fail'::text, 'skip'::text, 'cancelled'::text, 'error'::text, 'running'::text])`),
]);

export const testingRunSnapshotsInHarnessShared = harnessShared.table("testing_run_snapshots", {
	runId: text("run_id").primaryKey().notNull(),
	kind: text().notNull(),
	label: text().notNull(),
	filePath: text("file_path"),
	command: jsonb().notNull(),
	status: text().notNull(),
	exitCode: integer("exit_code"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	output: text().default('').notNull(),
	truncated: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	taskId: text("task_id"),
}, (table) => [
	index("testing_run_snapshots_finished_idx").using("btree", table.finishedAt.desc().nullsFirst().op("timestamptz_ops"), table.runId.asc().nullsLast().op("text_ops")).where(sql`(finished_at IS NOT NULL)`),
	index("testing_run_snapshots_updated_idx").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.runId.asc().nullsLast().op("text_ops")),
	check("testing_run_snapshots_kind_ck", sql`kind = ANY (ARRAY['vitest'::text, 'playwright'::text, 'cargo'::text, 'node'::text, 'shell'::text, 'admin-suite'::text])`),
	check("testing_run_snapshots_status_ck", sql`status = ANY (ARRAY['running'::text, 'pass'::text, 'fail'::text, 'cancelled'::text, 'error'::text])`),
	primaryKey({ columns: [table.runId], name: "testing_run_snapshots_pkey"}),

]);

export const testingSurfacesInHarnessShared = harnessShared.table("testing_surfaces", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.testing_surfaces_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	kind: text().notNull(),
	surfaceId: text("surface_id").notNull(),
	sourceFile: text("source_file"),
	schemaRef: jsonb("schema_ref"),
	attrs: jsonb().default({}).notNull(),
	provider: text().notNull(),
	fidelity: text().notNull(),
	firstSeen: timestamp("first_seen", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	retiredAt: timestamp("retired_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("testing_surfaces_identity").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.surfaceId.asc().nullsLast().op("text_ops")),
	index("testing_surfaces_live").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")).where(sql`(retired_at IS NULL)`),
	index("testing_surfaces_source_file").using("btree", table.sourceFile.asc().nullsLast().op("text_ops")).where(sql`((source_file IS NOT NULL) AND (retired_at IS NULL))`),
	check("testing_surfaces_fidelity_check", sql`fidelity = ANY (ARRAY['declared'::text, 'spec'::text, 'convention'::text, 'observed'::text, 'file-only'::text])`),
]);

export const textChunksInHarnessShared = harnessShared.table("text_chunks", {
	surface: text().notNull(),
	parentKey: text("parent_key").array().notNull(),
	chunkIdx: integer("chunk_idx").notNull(),
	anchor: text(),
	header: text(),
	content: text().notNull(),
	parentSha: text("parent_sha").notNull(),
	chunkSha: text("chunk_sha").notNull(),
	splitterVersion: text("splitter_version").notNull(),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	embeddingProfile: text("embedding_profile"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("text_chunks_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("text_chunks_embedding_mode_idx").using("btree", table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	index("text_chunks_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.chunkIdx, table.parentKey, table.surface], name: "text_chunks_pkey"}),
	check("text_chunks_chunk_idx_nonnegative", sql`chunk_idx >= 0`),
	check("text_chunks_parent_key_nonempty", sql`cardinality(parent_key) > 0`),
	check("text_chunks_surface_nonempty", sql`surface <> ''::text`),
]);

export const toastLogInHarnessShared = harnessShared.table("toast_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	level: text().notNull(),
	message: text().notNull(),
	description: text(),
	harnessSlug: text("harness_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	actionLabel: text("action_label"),
	actionHref: text("action_href"),
}, (table) => [
	index("toast_log_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("int8_ops")),
	index("toast_log_slug_created_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
]);

export const tokenIndexInHarnessShared = harnessShared.table("token_index", {
	token: text().primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().default('harness').notNull(),
}, (table) => [
	index("token_index_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("token_index_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("token_index_ws_harness_slug_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	pgPolicy("token_index_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("token_index_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const toolAuthzLogInHarnessShared = harnessShared.table("tool_authz_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	workspaceId: text("workspace_id"),
	principalSlug: text("principal_slug"),
	tool: text().notNull(),
	action: text().notNull(),
	resourceType: text("resource_type"),
	resourceId: text("resource_id"),
	decision: text().notNull(),
	gate: text().notNull(),
	reason: text(),
}, (table) => [
	index("tool_authz_log_decision_idx").using("btree", table.decision.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("tool_authz_log_principal_idx").using("btree", table.principalSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("tool_authz_log_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("tool_authz_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "tool_authz_log_pkey"}),

]);

export const toolInvocationsInHarnessShared = harnessShared.table("tool_invocations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginName: text("plugin_name").notNull(),
	toolName: text("tool_name").notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id").notNull(),
	parentSpawnId: text("parent_spawn_id"),
	windowKey: text("window_key").notNull(),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	durationMs: integer("duration_ms"),
	status: text().notNull(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
	errorMessage: text("error_message"),
	argsJson: jsonb("args_json"),
	eventCount: integer("event_count"),
	metadataJson: jsonb("metadata_json"),
	transport: text(),
	principalKind: text("principal_kind"),
	principalAuthMethod: text("principal_auth_method"),
	principalTrust: text("principal_trust"),
	errorCode: text("error_code"),
	coordOwnerId: text("coord_owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	intentEventId: bigint("intent_event_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	assumptionSetId: bigint("assumption_set_id", { mode: "number" }),
	goalRef: text("goal_ref"),
	callOrigin: text("call_origin"),
	callOriginSource: text("call_origin_source"),
	servingHost: text("serving_host"),
	servingProcessId: text("serving_process_id"),
	servingBuildSha: text("serving_build_sha"),
	goalId: text("goal_id"),
	goalActorClass: text("goal_actor_class"),
}, (table) => [
	index("tool_invocations_activity_adv_session_lookup_idx").using("btree", sql`workspace_id`, sql`((args_json ->> 'adv_session_id'::text))`, sql`invoked_at`, sql`id`).where(sql`((tool_name = ANY (ARRAY['activity:report'::text, 'activity_report'::text])) AND (args_json ? 'adv_session_id'::text))`),
	index("tool_invocations_activity_session_lookup_idx").using("btree", sql`workspace_id`, sql`COALESCE((args_json ->> 'session_id'::text), (args_json ->> 'se`, sql`invoked_at`, sql`id`).where(sql`((tool_name = ANY (ARRAY['activity:report'::text, 'activity_report'::text])) AND ((args_json ? 'session_id'::text) OR (args_json ? 'sessionId'::text)))`),
	index("tool_invocations_coord_owner_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(coord_owner_id IS NOT NULL)`),
	index("tool_invocations_error_code_idx").using("btree", table.errorCode.asc().nullsLast().op("text_ops"), table.invokedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(error_code IS NOT NULL)`),
	index("tool_invocations_goal_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops"), table.coordOwnerId.asc().nullsLast(), table.goalActorClass.asc().nullsLast()).where(sql`(goal_id IS NOT NULL)`),
	index("tool_invocations_goal_ref_idx").using("btree", table.goalRef.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(goal_ref IS NOT NULL)`),
	index("tool_invocations_intent_event_idx").using("btree", table.intentEventId.asc().nullsLast().op("int8_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(intent_event_id IS NOT NULL)`),
	index("tool_invocations_invoked_at_cov_idx").using("btree", table.invokedAt.desc().nullsFirst().op("timestamptz_ops"), table.toolName.asc().nullsLast(), table.durationMs.asc().nullsLast(), table.status.asc().nullsLast()),
	index("tool_invocations_parent_spawn_partial_idx").using("btree", table.parentSpawnId.asc().nullsLast().op("text_ops")).where(sql`((parent_spawn_id IS NOT NULL) AND (parent_spawn_id <> ''::text))`),
	index("tool_invocations_quota_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.toolName.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops"), table.windowKey.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast()).where(sql`(status = ANY (ARRAY['ok'::text, 'refused'::text]))`),
	index("tool_invocations_serving_host_idx").using("btree", table.servingHost.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(serving_host IS NOT NULL)`),
	index("tool_invocations_spawn_id_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.spawnId.asc().nullsLast().op("text_ops")),
	index("tool_invocations_telemetry_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("tool_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const toolUsageRollupInHarnessShared = harnessShared.table("tool_usage_rollup", {
	workspaceId: text("workspace_id").notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	day: date().notNull(),
	toolName: text("tool_name").notNull(),
	verb: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	calls: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	atoms: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	resultBytes: bigint("result_bytes", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	intentLabel: text("intent_label").default('').notNull(),
}, (table) => [
	index("tool_usage_rollup_intent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.day.desc().nullsFirst().op("date_ops"), table.intentLabel.asc().nullsLast().op("text_ops")).where(sql`(intent_label <> ''::text)`),
	index("tool_usage_rollup_window_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.day.desc().nullsFirst().op("date_ops"), table.toolName.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.day, table.intentLabel, table.sessionId, table.sourceKind, table.toolName, table.verb, table.workspaceId], name: "tool_usage_rollup_pkey"}),
]);

export const topicHysteresisInHarnessShared = harnessShared.table("topic_hysteresis", {
	sessionId: text("session_id").primaryKey().notNull(),
	ownerId: text("owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tick: bigint({ mode: "number" }).default(0).notNull(),
	subscriptions: jsonb().default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("topic_hysteresis_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.sessionId], name: "topic_hysteresis_pkey"}),

]);

export const transferLessonsInHarnessShared = harnessShared.table("transfer_lessons", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	signature: text().notNull(),
	title: text(),
	lessonText: text("lesson_text").notNull(),
	sourceKind: text("source_kind").default('transcript').notNull(),
	sourceRef: text("source_ref"),
	tier: text().default('probationary').notNull(),
	status: text().default('candidate').notNull(),
	testCount: integer("test_count").default(0).notNull(),
	passCount: integer("pass_count").default(0).notNull(),
	failCount: integer("fail_count").default(0).notNull(),
	lastTestedAt: timestamp("last_tested_at", { withTimezone: true, mode: 'string' }),
	lastBatteryId: text("last_battery_id"),
	lastDelta: numeric("last_delta"),
	memoryId: uuid("memory_id"),
	packCandidateId: uuid("pack_candidate_id"),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("transfer_lessons_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	index("transfer_lessons_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("transfer_lessons_ws_tier_tested_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.tier.asc().nullsLast().op("text_ops"), table.lastTestedAt.asc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "transfer_lessons_pkey"}),
	unique("transfer_lessons_signature_uniq").on(table.signature, table.workspaceId),
	pgPolicy("transfer_lessons_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("transfer_lessons_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("transfer_lessons_source_kind_check", sql`source_kind = ANY (ARRAY['transcript'::text, 'memory'::text, 'pack-candidate'::text])`),
	check("transfer_lessons_status_check", sql`status = ANY (ARRAY['candidate'::text, 'passed'::text, 'failed'::text, 'error'::text])`),
	check("transfer_lessons_tier_check", sql`tier = ANY (ARRAY['probationary'::text, 'validated'::text, 'retired'::text])`),
]);

export const triageLedgerInHarnessShared = harnessShared.table("triage_ledger", {
	snapshotId: text("snapshot_id").notNull(),
	featureId: text("feature_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	origin: text().notNull(),
	actionable: boolean().generatedAlwaysAs(sql`(origin = 'local'::text)`),
	lens: text(),
	routedMonth: date("routed_month"),
	clusterId: text("cluster_id"),
	clusterTier: text("cluster_tier"),
	clusterSize: integer("cluster_size"),
	redundancy: text().default('untriaged').notNull(),
	merit: text().default('untriaged').notNull(),
	provenance: text(),
	falsifier: text(),
	judge: text(),
	judgedAt: timestamp("judged_at", { withTimezone: true, mode: 'string' }),
	notes: text(),
	clusterIdStrict: text("cluster_id_strict"),
	clusterSizeStrict: integer("cluster_size_strict"),
}, (table) => [
	index("triage_ledger_feature_idx").using("btree", table.featureId.asc().nullsLast().op("text_ops")),
	index("triage_ledger_snapshot_cluster_idx").using("btree", table.snapshotId.asc().nullsLast().op("text_ops"), table.clusterId.asc().nullsLast().op("text_ops")),
	index("triage_ledger_snapshot_origin_idx").using("btree", table.snapshotId.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")),
	index("triage_ledger_snapshot_verdict_idx").using("btree", table.snapshotId.asc().nullsLast().op("text_ops"), table.merit.asc().nullsLast().op("text_ops"), table.redundancy.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.snapshotId],
			foreignColumns: [triageSnapshotsInHarnessShared.snapshotId],
			name: "triage_ledger_snapshot_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.featureId, table.snapshotId], name: "triage_ledger_pkey"}),
	check("triage_ledger_discard_needs_verified_falsifier", sql`(merit !~~ 'M1-%'::text) OR ((falsifier IS NOT NULL) AND (length(btrim(falsifier)) > 0) AND (provenance = 'verified'::text))`),
	check("triage_ledger_merit_shape", sql`(merit = 'untriaged'::text) OR (merit ~ '^M[0-9](-[a-z]+)?$'::text)`),
	check("triage_ledger_origin_check", sql`origin = ANY (ARRAY['local'::text, 'remote'::text])`),
	check("triage_ledger_provenance_check", sql`(provenance IS NULL) OR (provenance = ANY (ARRAY['verified'::text, 'argued'::text, 'unverifiable'::text]))`),
	check("triage_ledger_redundancy_shape", sql`(redundancy = 'untriaged'::text) OR (redundancy ~ '^R([0-9]|-[a-z]+)$'::text)`),
	check("triage_ledger_tier_check", sql`(cluster_tier IS NULL) OR (cluster_tier = ANY (ARRAY['A'::text, 'B'::text, 'C'::text]))`),
]);

export const triageSnapshotsInHarnessShared = harnessShared.table("triage_snapshots", {
	snapshotId: text("snapshot_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	corpus: smallint().notNull(),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	takenBy: text("taken_by"),
	censusTotal: integer("census_total").notNull(),
	censusLocal: integer("census_local").notNull(),
	censusRemote: integer("census_remote").notNull(),
	ledgerRows: integer("ledger_rows").default(0).notNull(),
	reconciled: boolean().generatedAlwaysAs(sql`(ledger_rows = census_total)`),
	predicateNote: text("predicate_note"),
	notes: text(),
}, (table) => [
	check("triage_snapshots_corpus_check", sql`corpus = ANY (ARRAY[1, 2, 3])`),
	check("triage_snapshots_counts_nonneg", sql`(census_total >= 0) AND (census_local >= 0) AND (census_remote >= 0) AND (ledger_rows >= 0)`),
	check("triage_snapshots_partition_exhausts", sql`(census_local + census_remote) = census_total`),
	primaryKey({ columns: [table.snapshotId], name: "triage_snapshots_pkey"}),

]);

export const triggerBindingsInHarnessShared = harnessShared.table("trigger_bindings", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	sourceId: uuid("source_id").notNull(),
	planHarnessSlug: text("plan_harness_slug"),
	planSlug: text("plan_slug"),
	eventPattern: text("event_pattern").notNull(),
	eventFilter: jsonb("event_filter").default({}).notNull(),
	action: jsonb().default({}).notNull(),
	armed: boolean().default(false).notNull(),
	stormPolicy: jsonb("storm_policy").default({}).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	detachedAt: timestamp("detached_at", { withTimezone: true, mode: 'string' }),
	goalId: text("goal_id"),
	workItemHarnessSlug: text("work_item_harness_slug"),
	workItemKind: text("work_item_kind"),
}, (table) => [
	index("trigger_bindings_installed_plan_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.planHarnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")).where(sql`(detached_at IS NULL)`),
	index("trigger_bindings_ws_goal_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops")).where(sql`(goal_id IS NOT NULL)`),
	index("trigger_bindings_ws_plan_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.planHarnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	index("trigger_bindings_ws_source_armed_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceId.asc().nullsLast().op("uuid_ops"), table.armed.asc().nullsLast().op("bool_ops")),
	index("trigger_bindings_ws_work_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.workItemHarnessSlug.asc().nullsLast().op("text_ops"), table.workItemKind.asc().nullsLast().op("text_ops")).where(sql`((work_item_kind IS NOT NULL) AND (detached_at IS NULL))`),
	foreignKey({
			columns: [table.goalId],
			foreignColumns: [goalsInHarnessShared.id],
			name: "trigger_bindings_goal_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.planHarnessSlug, table.planSlug],
			foreignColumns: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug],
			name: "trigger_bindings_plan_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.sourceId],
			foreignColumns: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id],
			name: "trigger_bindings_source_fk"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "trigger_bindings_pkey"}),
	pgPolicy("trigger_bindings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("trigger_bindings_action_object_check", sql`jsonb_typeof(action) = 'object'::text`),
	check("trigger_bindings_blueprint_operation_action_check", sql`((action ->> 'type'::text) IS DISTINCT FROM 'blueprint-operation'::text) OR (((jsonb_typeof((action -> 'operationHarnessSlug'::text)) = 'string'::text) AND (btrim((action ->> 'operationHarnessSlug'::text)) <> ''::text) AND (jsonb_typeof((action -> 'operationId'::text)) = 'string'::text) AND (btrim((action ->> 'operationId'::text)) <> ''::text) AND ((NOT (action ? 'input'::text)) OR (jsonb_typeof((action -> 'input'::text)) = 'object'::text))) IS TRUE)`),
	check("trigger_bindings_direct_work_item_cols_paired", sql`(work_item_kind IS NULL) = (work_item_harness_slug IS NULL)`),
	check("trigger_bindings_direct_work_item_nonempty", sql`((work_item_kind IS NULL) OR (btrim(work_item_kind) <> ''::text)) AND ((work_item_harness_slug IS NULL) OR (btrim(work_item_harness_slug) <> ''::text))`),
	check("trigger_bindings_event_filter_object_check", sql`jsonb_typeof(event_filter) = 'object'::text`),
	check("trigger_bindings_event_pattern_nonempty", sql`btrim(event_pattern) <> ''::text`),
	check("trigger_bindings_exactly_one_target", sql`(((((plan_slug IS NOT NULL))::integer + ((goal_id IS NOT NULL))::integer) + ((work_item_kind IS NOT NULL))::integer) + COALESCE((((action ->> 'type'::text) = 'blueprint-operation'::text))::integer, 0)) = 1`),
	check("trigger_bindings_plan_cols_paired", sql`(plan_slug IS NULL) = (plan_harness_slug IS NULL)`),
	check("trigger_bindings_storm_policy_object_check", sql`jsonb_typeof(storm_policy) = 'object'::text`),
]);

export const triggerDeliveriesInHarnessShared = harnessShared.table("trigger_deliveries", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	sourceId: uuid("source_id").notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	datatypeId: text("datatype_id").notNull(),
	eventKey: text("event_key").notNull(),
	payload: jsonb().notNull(),
	sinkKind: text("sink_kind").notNull(),
	sinkRef: text("sink_ref").default('default').notNull(),
	outcome: text().default('pending').notNull(),
	emittedEventKey: text("emitted_event_key"),
	attempts: integer().default(0).notNull(),
	error: text(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trigger_deliveries_ws_event_key_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("trigger_deliveries_ws_outcome_received_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.outcome.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("trigger_deliveries_ws_source_received_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceId.asc().nullsLast().op("uuid_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.workspaceId, table.datatypeId],
			foreignColumns: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id],
			name: "trigger_deliveries_datatype_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.sourceId],
			foreignColumns: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id],
			name: "trigger_deliveries_source_fk"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "trigger_deliveries_pkey"}),
	unique("trigger_deliveries_sink_dedupe_key").on(table.dedupeKey, table.sinkKind, table.sinkRef, table.sourceId, table.workspaceId),
	pgPolicy("trigger_deliveries_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("trigger_deliveries_attempts_nonnegative_check", sql`attempts >= 0`),
	check("trigger_deliveries_dedupe_key_nonempty", sql`btrim(dedupe_key) <> ''::text`),
	check("trigger_deliveries_event_key_nonempty", sql`btrim(event_key) <> ''::text`),
	check("trigger_deliveries_outcome_check", sql`outcome = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'skipped'::text])`),
	check("trigger_deliveries_payload_object_check", sql`jsonb_typeof(payload) = 'object'::text`),
	check("trigger_deliveries_sink_kind_nonempty", sql`btrim(sink_kind) <> ''::text`),
	check("trigger_deliveries_sink_ref_nonempty", sql`btrim(sink_ref) <> ''::text`),
]);

export const triggerRunsInHarnessShared = harnessShared.table("trigger_runs", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	bindingId: uuid("binding_id").notNull(),
	deliveryId: uuid("delivery_id"),
	dedupeKey: text("dedupe_key").notNull(),
	status: text().default('pending').notNull(),
	args: jsonb().default({}).notNull(),
	planRunRef: text("plan_run_ref"),
	outcome: jsonb().default({}).notNull(),
	error: text(),
	triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	attempts: integer().default(0).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trigger_runs_ws_binding_triggered_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.bindingId.asc().nullsLast().op("uuid_ops"), table.triggeredAt.desc().nullsFirst().op("timestamptz_ops")),
	index("trigger_runs_ws_due_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.nextAttemptAt.asc().nullsLast().op("timestamptz_ops"), table.triggeredAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'failed'::text, 'running'::text]))`),
	index("trigger_runs_ws_status_triggered_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.triggeredAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.workspaceId, table.bindingId],
			foreignColumns: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.id],
			name: "trigger_runs_binding_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.deliveryId],
			foreignColumns: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.id],
			name: "trigger_runs_delivery_fk"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "trigger_runs_pkey"}),
	unique("trigger_runs_binding_dedupe_key").on(table.bindingId, table.dedupeKey, table.workspaceId),
	pgPolicy("trigger_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("trigger_runs_args_object_check", sql`jsonb_typeof(args) = 'object'::text`),
	check("trigger_runs_attempts_nonnegative_check", sql`attempts >= 0`),
	check("trigger_runs_dedupe_key_nonempty", sql`btrim(dedupe_key) <> ''::text`),
	check("trigger_runs_outcome_object_check", sql`jsonb_typeof(outcome) = 'object'::text`),
	check("trigger_runs_status_check", sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text])`),
]);

export const triggerSourcesInHarnessShared = harnessShared.table("trigger_sources", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	kind: text().notNull(),
	config: jsonb().default({}).notNull(),
	credentialRef: text("credential_ref"),
	status: text().default('unconfigured').notNull(),
	cursor: jsonb().default({}).notNull(),
	lastConnectedAt: timestamp("last_connected_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ownerUserId: uuid("owner_user_id"),
	providerAccountId: text("provider_account_id"),
}, (table) => [
	uniqueIndex("trigger_sources_owned_account_kind_uidx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.ownerUserId.asc().nullsLast().op("uuid_ops"), table.providerAccountId.asc().nullsLast().op("text_ops")).where(sql`((owner_user_id IS NOT NULL) AND (provider_account_id IS NOT NULL))`),
	index("trigger_sources_workspace_owner_account_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerUserId.asc().nullsLast().op("uuid_ops"), table.providerAccountId.asc().nullsLast().op("text_ops")).where(sql`((owner_user_id IS NOT NULL) AND (provider_account_id IS NOT NULL))`),
	index("trigger_sources_workspace_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerUserId.asc().nullsLast().op("uuid_ops")).where(sql`(owner_user_id IS NOT NULL)`),
	index("trigger_sources_ws_kind_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [usersInHarnessShared.id],
			name: "trigger_sources_owner_user_id_fkey"
		}).onDelete("set null"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "trigger_sources_pkey"}),
	pgPolicy("trigger_sources_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("trigger_sources_config_object_check", sql`jsonb_typeof(config) = 'object'::text`),
	check("trigger_sources_credential_ref_nonempty", sql`(credential_ref IS NULL) OR (btrim(credential_ref) <> ''::text)`),
	check("trigger_sources_cursor_object_check", sql`jsonb_typeof(cursor) = 'object'::text`),
	check("trigger_sources_kind_nonempty", sql`btrim(kind) <> ''::text`),
	check("trigger_sources_provider_account_nonempty", sql`(owner_user_id IS NULL) OR ((provider_account_id IS NOT NULL) AND (btrim(provider_account_id) <> ''::text))`),
	check("trigger_sources_status_check", sql`status = ANY (ARRAY['unconfigured'::text, 'ready'::text, 'connecting'::text, 'connected'::text, 'degraded'::text, 'error'::text, 'disabled'::text])`),
]);

export const trustedAuthorsInHarnessShared = harnessShared.table("trusted_authors", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedByGithubUserId: bigint("trusted_by_github_user_id", { mode: "number" }).notNull(),
	trustedAt: timestamp("trusted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trusted_authors_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.trustedByGithubUserId.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.trustedGithubUserId, table.workspaceId], name: "trusted_authors_pkey"}),
	pgPolicy("trusted_authors_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const tuiCrewsInHarnessShared = harnessShared.table("tui_crews", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	name: text().notNull(),
	members: jsonb().default([]).notNull(),
	layoutName: text("layout_name"),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tui_crews_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.name, table.ownerId, table.workspaceId], name: "tui_crews_pkey"}),
	pgPolicy("tui_crews_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const tuiIntentsInHarnessShared = harnessShared.table("tui_intents", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	intent: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	result: jsonb(),
	errorMessage: text("error_message"),
	requestedBy: text("requested_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("tui_intents_client_pending_idx").using("btree", table.clientId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("tui_intents_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const tuiLayoutsInHarnessShared = harnessShared.table("tui_layouts", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	name: text().notNull(),
	kdl: text().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tui_layouts_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.name, table.ownerId, table.workspaceId], name: "tui_layouts_pkey"}),
	pgPolicy("tui_layouts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const tuiViewStateInHarnessShared = harnessShared.table("tui_view_state", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	state: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.ownerId, table.workspaceId], name: "tui_view_state_pkey"}),
	pgPolicy("tui_view_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const uiClientsInHarnessShared = harnessShared.table("ui_clients", {
	clientId: text("client_id").primaryKey().notNull(),
	workspaceId: text("workspace_id"),
	url: text().notNull(),
	title: text(),
	viewport: jsonb(),
	openedAt: timestamp("opened_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ui_clients_last_seen_idx").using("btree", table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("ui_clients_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.clientId], name: "ui_clients_pkey"}),

]);

export const uiIntentsInHarnessShared = harnessShared.table("ui_intents", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	intent: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	result: jsonb(),
	errorMessage: text("error_message"),
	requestedBy: text("requested_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("ui_intents_completed_idx").using("btree", table.completedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(completed_at IS NOT NULL)`),
	index("ui_intents_pending_idx").using("btree", table.clientId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending'::text)`),
	index("ui_intents_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const userActionsInHarnessShared = harnessShared.table("user_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	summary: text(),
	detailUrl: text("detail_url"),
	errorText: text("error_text"),
	invocationId: text("invocation_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	finishedAt: bigint("finished_at", { mode: "number" }),
	actor: text(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("user_actions_running_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	index("user_actions_slug_started_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("int8_ops")),
	index("user_actions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("user_actions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const userPreferencesInHarnessShared = harnessShared.table("user_preferences", {
	userId: uuid("user_id").notNull(),
	payload: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "user_preferences_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.workspaceId], name: "user_preferences_pkey"}),
]);

export const userSessionsInHarnessShared = harnessShared.table("user_sessions", {
	token: text().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userAgent: text("user_agent"),
	remoteAddr: text("remote_addr"),
	workspaceId: text("workspace_id"),
	capabilities: text().array().default(["RAY['*'::tex"]).notNull(),
}, (table) => [
	index("user_sessions_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("user_sessions_workspace_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(workspace_id IS NOT NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "user_sessions_user_id_fkey"
		}).onDelete("cascade"),
]);

export const userTrustListInHarnessShared = harnessShared.table("user_trust_list", {
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	note: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("user_trust_list_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.trustedGithubUserId, table.workspaceId], name: "user_trust_list_pkey"}),
	pgPolicy("user_trust_list_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const usersInHarnessShared = harnessShared.table("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	displayName: text("display_name").notNull(),
	passwordHash: text("password_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	index("users_username_idx").using("btree", table.username.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	unique("users_username_key").on(table.username),
	primaryKey({ columns: [table.id], name: "users_pkey"}),

]);

export const voiceLeaseInHarnessShared = harnessShared.table("voice_lease", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	ownerId: text("owner_id").notNull(),
	ownerKind: text("owner_kind").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
}, (table) => [
	index("voice_lease_expires_idx").using("btree", table.expiresAtMs.asc().nullsLast().op("int8_ops")),
	pgPolicy("voice_lease_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("voice_lease_owner_kind_check", sql`owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text, 'tui'::text])`),
	primaryKey({ columns: [table.workspaceId], name: "voice_lease_pkey"}),

]);

export const voiceRelayInHarnessShared = harnessShared.table("voice_relay", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("voice_relay_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "voice_relay_pkey"}),

]);

export const voiceUtterancesInHarnessShared = harnessShared.table("voice_utterances", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	source: text().notNull(),
	mode: text(),
	lengthChars: integer("length_chars"),
	nameUsed: boolean("name_used").default(false).notNull(),
	hadBackstory: boolean("had_backstory").default(false).notNull(),
	modifications: jsonb(),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("voice_utterances_mode_idx").using("btree", table.mode.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("voice_utterances_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const watchdogTicksInHarnessShared = harnessShared.table("watchdog_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.watchdog_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text().default('ran').notNull(),
	signals: integer().default(0).notNull(),
	captured: text().array().default([]).notNull(),
	declinedDuplicates: integer("declined_duplicates").default(0).notNull(),
	deferred: integer().default(0).notNull(),
	collectors: jsonb().default([]).notNull(),
	selfEscalations: text("self_escalations").array().default([]).notNull(),
	deferredKeys: text("deferred_keys").array().default([]).notNull(),
	knownOpenKeys: text("known_open_keys").array().default([]).notNull(),
	staleResolvedKeys: text("stale_resolved_keys").array().default([]).notNull(),
	seenKeys: text("seen_keys").array().default([]).notNull(),
	standingKeys: text("standing_keys").array().default([]).notNull(),
}, (table) => [
	index("watchdog_ticks_ws_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("watchdog_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const webhookAuditInHarnessShared = harnessShared.table("webhook_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	targetUrl: text("target_url").notNull(),
	eventKind: text("event_kind").notNull(),
	payload: jsonb(),
	statusCode: integer("status_code"),
	attemptCount: integer("attempt_count").default(1).notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	error: text(),
}, (table) => [
	index("webhook_audit_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.sentAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "webhook_audit_pkey"}),
	pgPolicy("webhook_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const workItemBlockedInHarnessShared = harnessShared.table("work_item_blocked", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.featureId, table.harnessSlug, table.workspaceId], name: "work_item_blocked_pkey"}),
]);

export const workItemClaimsInHarnessShared = harnessShared.table("work_item_claims", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	holderPubkey: text("holder_pubkey"),
	intent: text().default('').notNull(),
	ttlSec: integer("ttl_sec").default(1800).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("work_item_claims_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("work_item_claims_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	index("work_item_claims_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	primaryKey({ columns: [table.harnessSlug, table.workItemId, table.workspaceId], name: "work_item_claims_pkey"}),
	check("work_item_claims_owner_nonempty", sql`owner <> ''::text`),
	check("work_item_claims_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const workItemDepsInHarnessShared = harnessShared.table("work_item_deps", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.work_item_deps_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	blockedKind: text("blocked_kind").notNull(),
	blockedRef: text("blocked_ref").notNull(),
	blockerKind: text("blocker_kind").notNull(),
	blockerRef: text("blocker_ref").notNull(),
	depType: text("dep_type").default('blocks').notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	satisfaction: text().default('settled').notNull(),
}, (table) => [
	index("work_item_deps_blocked_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockedKind.asc().nullsLast().op("text_ops"), table.blockedRef.asc().nullsLast().op("text_ops")),
	index("work_item_deps_blocker_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockerKind.asc().nullsLast().op("text_ops"), table.blockerRef.asc().nullsLast().op("text_ops")),
	uniqueIndex("work_item_deps_edge_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockedKind.asc().nullsLast().op("text_ops"), table.blockedRef.asc().nullsLast().op("text_ops"), table.blockerKind.asc().nullsLast().op("text_ops"), table.blockerRef.asc().nullsLast().op("text_ops"), table.depType.asc().nullsLast().op("text_ops")),
	check("work_item_deps_endpoints_nonempty", sql`(blocked_kind <> ''::text) AND (blocked_ref <> ''::text) AND (blocker_kind <> ''::text) AND (blocker_ref <> ''::text)`),
	check("work_item_deps_no_self", sql`NOT ((blocked_kind = blocker_kind) AND (blocked_ref = blocker_ref))`),
	check("work_item_deps_satisfaction_check", sql`satisfaction = ANY (ARRAY['settled'::text, 'success'::text])`),
	check("work_item_deps_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const workItemOccurrencesInHarnessShared = harnessShared.table("work_item_occurrences", {
	occurrenceId: bigserial("occurrence_id", { mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	canonicalHarnessSlug: text("canonical_harness_slug").notNull(),
	canonicalWorkItemId: text("canonical_work_item_id").notNull(),
	reporter: text(),
	sourceTool: text("source_tool").notNull(),
	reportKind: text("report_kind").notNull(),
	reportedTitle: text("reported_title").notNull(),
	evidence: jsonb().default({}).notNull(),
	admissionIdentity: jsonb("admission_identity"),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("work_item_occurrences_canonical_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.canonicalHarnessSlug.asc().nullsLast().op("text_ops"), table.canonicalWorkItemId.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops")),
	index("work_item_occurrences_flow_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops")),
	check("work_item_occurrences_report_kind_check", sql`report_kind = ANY (ARRAY['canonical-created'::text, 'duplicate'::text, 'coalesced'::text, 'promoted'::text, 'regression'::text])`),
	primaryKey({ columns: [table.occurrenceId], name: "work_item_occurrences_pkey"}),

]);

export const workItemReleaseCooldownsInHarnessShared = harnessShared.table("work_item_release_cooldowns", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	agentId: text("agent_id").notNull(),
	releasedAt: timestamp("released_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("work_item_release_cooldowns_expiry_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.releasedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.agentId, table.featureId, table.harnessSlug, table.workspaceId], name: "work_item_release_cooldowns_pkey"}),
	pgPolicy("work_item_release_cooldowns_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const workItemReplicasInHarnessShared = harnessShared.table("work_item_replicas", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	replicaIndex: integer("replica_index").notNull(),
	redundancy: integer().notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	holderPubkey: text("holder_pubkey"),
	ttlSec: integer("ttl_sec").default(1800).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	status: text().default('claimed').notNull(),
	result: jsonb(),
	judgeComposite: doublePrecision("judge_composite"),
	judgeRationale: text("judge_rationale"),
	judgeModel: text("judge_model"),
	rubricHash: text("rubric_hash"),
	judgeCostUsd: doublePrecision("judge_cost_usd"),
	judgedTs: timestamp("judged_ts", { withTimezone: true, mode: 'string' }),
	createdTs: timestamp("created_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	updatedTs: timestamp("updated_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
}, (table) => [
	index("work_item_replicas_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("work_item_replicas_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops")),
	index("work_item_replicas_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.replicaIndex, table.workItemId, table.workspaceId], name: "work_item_replicas_pkey"}),
	check("work_item_replicas_index_nonneg", sql`replica_index >= 0`),
	check("work_item_replicas_owner_nonempty", sql`owner <> ''::text`),
	check("work_item_replicas_redundancy_positive", sql`redundancy >= 1`),
	check("work_item_replicas_status_check", sql`status = ANY (ARRAY['claimed'::text, 'complete'::text, 'winner'::text, 'loser'::text])`),
	check("work_item_replicas_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const workItemSpecRevisionEdgesInHarnessShared = harnessShared.table("work_item_spec_revision_edges", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	planSlug: text("plan_slug").notNull(),
	specId: text("spec_id").notNull(),
	specRevision: integer("spec_revision").notNull(),
	specFingerprint: text("spec_fingerprint").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("work_item_spec_revision_edges_by_spec").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.specId.asc().nullsLast().op("text_ops"), table.specRevision.asc().nullsLast().op("int4_ops"), table.workItemId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.specId, table.specRevision, table.specFingerprint],
			foreignColumns: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision, planSpecClauseRevisionsInHarnessShared.contentHash],
			name: "work_item_spec_revision_edges_workspace_id_harness_slug_pl_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.workspaceId, table.harnessSlug, table.workItemId],
			foreignColumns: [workItemsInHarnessShared.workspaceId, workItemsInHarnessShared.harnessSlug, workItemsInHarnessShared.featureId],
			name: "work_item_spec_revision_edges_workspace_id_harness_slug_wo_fkey"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.harnessSlug, table.planSlug, table.specId, table.specRevision, table.workItemId, table.workspaceId], name: "work_item_spec_revision_edges_pkey"}),
	unique("work_item_spec_revision_edges_workspace_id_harness_slug_wor_key").on(table.harnessSlug, table.planSlug, table.specFingerprint, table.specId, table.specRevision, table.workItemId, table.workspaceId),
	pgPolicy("work_item_spec_revision_edges_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("work_item_spec_revision_edges_spec_fingerprint_check", sql`spec_fingerprint ~ '^[0-9a-f]{64}$'::text`),
	check("work_item_spec_revision_edges_spec_revision_check", sql`spec_revision > 0`),
]);

export const workItemsInHarnessShared = harnessShared.table("work_items", {
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'C'::"char"))`),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also").array().default([]).notNull(),
	needsDesign: boolean("needs_design").default(false).notNull(),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work").default(false).notNull(),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }).array().default([]).notNull(),
	workedByHistory: jsonb("worked_by_history").default([]).notNull(),
	wave: text(),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids").array(),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind").default('feature').notNull(),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	redundancy: integer(),
	swarmAffinity: text("swarm_affinity"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active").default(false),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count").default(0).notNull(),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	terminalReason: text("terminal_reason"),
	authority: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closedTs: bigint("closed_ts", { mode: "number" }),
	lane: text().generatedAlwaysAs(sql`(payload ->> 'lane'::text)`),
	conditionKey: text("condition_key"),
	embeddingRecipe: smallint("embedding_recipe"),
	stateChangedAt: timestamp("state_changed_at", { withTimezone: true, mode: 'string' }),
	admission: text(),
	admittedAt: timestamp("admitted_at", { withTimezone: true, mode: 'string' }),
	admittedBy: text("admitted_by"),
	firstClaimedAt: timestamp("first_claimed_at", { withTimezone: true, mode: 'string' }),
	claimHold: boolean("claim_hold").generatedAlwaysAs(sql`((payload ->> '_claimHold'::text) = 'true'::text)`),
	needsOwnerAction: boolean("needs_owner_action").generatedAlwaysAs(sql`((payload ->> 'needsOwnerAction'::text) = 'true'::text)`),
	embeddingProfile: text("embedding_profile"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	directiveRef: bigint("directive_ref", { mode: "number" }),
}, (table) => [
	index("blueprint_invocation_item_recovery_idx").using("btree", sql`workspace_id`, sql`harness_slug`, sql`(((payload -> 'blueprintOperation'::text) ->> 'operationId'::te`, sql`(((payload -> 'blueprintOperation'::text) ->> 'callerId'::text)`, sql`(((payload -> 'blueprintOperation'::text) ->> 'requestKey'::tex`).where(sql`(payload ? 'blueprintOperation'::text)`),
	index("harness_features_consolidated_claimed_progress_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.lastProgressAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((taken_by IS NOT NULL) AND (taken_by <> ''::text))`),
	index("hfc_audit_pending_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`((origin = 'remote'::text) AND ((audit_verdict IS NULL) OR (audit_verdict = 'pending'::text)))`),
	index("hfc_design_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.designStatus.asc().nullsLast().op("text_ops")).where(sql`(design_status IS NOT NULL)`),
	index("hfc_item_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.itemKind.asc().nullsLast().op("text_ops")),
	index("hfc_needs_design_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.needsDesign.asc().nullsLast().op("bool_ops")).where(sql`(needs_design = true)`),
	index("hfc_origin_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")).where(sql`(origin = 'remote'::text)`),
	index("hfc_pending_done_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`((status = 'pending_done'::text) AND (completion_ref IS NOT NULL))`),
	index("hfc_plan_wave_idx").using("btree", table.sourcePlanSlug.asc().nullsLast().op("text_ops"), table.wave.asc().nullsLast().op("text_ops")).where(sql`(source_plan_slug IS NOT NULL)`),
	index("hfc_review_idx").using("btree", table.needsHumanReview.asc().nullsLast().op("bool_ops")),
	index("hfc_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("hfc_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("hfc_source_plan_run_idx").using("btree", sql`(((payload -> 'plan_run'::text) ->> 'runId'::text))`).where(sql`(((payload -> 'plan_run'::text) ->> 'runId'::text) IS NOT NULL)`),
	index("hfc_source_plan_slug_idx").using("btree", table.sourcePlanSlug.asc().nullsLast().op("text_ops")).where(sql`(source_plan_slug IS NOT NULL)`),
	index("hfc_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("hfc_taken_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.takenBy.asc().nullsLast().op("text_ops")).where(sql`(taken_by IS NOT NULL)`),
	index("hfc_updated_idx").using("btree", table.updatedTs.desc().nullsFirst().op("int8_ops")),
	index("hfc_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	index("wi_admission_first_claim_latency_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.admittedAt.asc().nullsLast().op("timestamptz_ops"), table.firstClaimedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(admitted_at IS NOT NULL)`),
	index("wi_admission_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.asc().nullsLast().op("int8_ops")).where(sql`(admission = 'pending'::text)`),
	index("work_items_acceptance_drain_plan_idx").using("btree", sql`workspace_id`, sql`((payload ->> 'acceptanceDrainPlan'::text))`).where(sql`((payload ->> 'acceptanceDrainPlan'::text) IS NOT NULL)`),
	index("work_items_author_pubkey_local_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.authorPubkey.asc().nullsLast().op("text_ops")).where(sql`((author_pubkey IS NOT NULL) AND (author_pubkey <> ''::text) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))`),
	index("work_items_authority_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.authority.asc().nullsLast().op("text_ops")).where(sql`(authority IS NOT NULL)`),
	index("work_items_authority_proposed_idx").using("btree", table.terminalOwner.asc().nullsLast().op("text_ops"), table.updatedTs.asc().nullsLast().op("int8_ops")).where(sql`(authority = 'proposed'::text)`),
	index("work_items_closed_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.closedTs.asc().nullsLast().op("int8_ops")).where(sql`(closed_ts IS NOT NULL)`),
	index("work_items_completion_event_intent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.closedTs.asc().nullsLast().op("int8_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(payload ? '_completionEventIntentId'::text)`),
	uniqueIndex("work_items_condition_key_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.conditionKey.asc().nullsLast().op("text_ops")).where(sql`(condition_key IS NOT NULL)`),
	index("work_items_design_created_keyset_idx").using("btree", sql`workspace_id`, sql`harness_slug`, sql`COALESCE(created_ts, (0)::bigint)`, sql`feature_id`).where(sql`((needs_design = true) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))`),
	index("work_items_directive_ref_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.directiveRef.asc().nullsLast().op("int8_ops")).where(sql`(directive_ref IS NOT NULL)`),
	index("work_items_embedding_hnsw_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("work_items_embedding_mode_idx").using("btree", table.embeddingMode.asc().nullsLast().op("text_ops")).where(sql`(embedding_mode IS NOT NULL)`),
	index("work_items_escalated_open_idx").using("btree", sql`workspace_id`, sql`COALESCE(((payload -> '_ei'::text) ->> 'severity'::text), 'mino`).where(sql`((status = 'open'::text) AND (item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])))`),
	index("work_items_frontier_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`((status = 'open'::text) AND (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])))`),
	index("work_items_goal_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.goalId.asc().nullsLast().op("text_ops")).where(sql`(goal_id IS NOT NULL)`),
	uniqueIndex("work_items_keyless_title_identity_uq").using("btree", sql`workspace_id`, sql`harness_slug`, sql`((payload #>> '{admissionIdentity,titleKey}'::text[]))`).where(sql`((item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])) AND ((status IS NULL) OR (status <> ALL (ARRAY['passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'done'::text, 'dropped'::text]))) AND (NULLIF(btrim((payload ->> 'watchdogKey'::text)), ''::text) IS NULL) AND (COALESCE((payload ->> 'lane'::text), 'improvement'::text) <> 'observation'::text) AND ((payload #>> '{admissionIdentity,schemaVersion}'::text[]) = 'admission-identity-v1'::text) AND (NULLIF(btrim((payload #>> '{admissionIdentity,titleKey}'::text[])), ''::text) IS NOT NULL))`),
	index("work_items_obs_rubric_ref_v2_idx").using("btree", sql`(((payload -> 'observation'::text) ->> 'rubricRef'::text))`).where(sql`(((payload -> 'observation'::text) ->> 'rubricRef'::text) IS NOT NULL)`),
	index("work_items_obs_supersedes_v2_idx").using("btree", sql`(((payload -> 'observation'::text) ->> 'supersedes'::text))`).where(sql`(((payload -> 'observation'::text) ->> 'supersedes'::text) IS NOT NULL)`),
	index("work_items_plan_item_stamp_idx").using("btree", sql`(((payload -> 'plan_item'::text) ->> 'plan_slug'::text))`, sql`(((payload -> 'plan_item'::text) ->> 'item_id'::text))`).where(sql`((payload -> 'plan_item'::text) IS NOT NULL)`),
	uniqueIndex("work_items_resource_governor_identity_uq").using("btree", sql`workspace_id`, sql`(((payload -> 'resource_governor'::text) ->> 'namespace'::text)`, sql`(((payload -> 'resource_governor'::text) ->> 'idempotencyKey'::`).where(sql`(((payload -> 'resource_governor'::text) ->> 'schemaVersion'::text) = '1'::text)`),
	index("work_items_resource_governor_queue_idx").using("btree", sql`workspace_id`, sql`(((payload -> 'resource_governor'::text) ->> 'namespace'::text)`, sql`(((payload -> 'resource_governor'::text) ->> 'state'::text))`, sql`created_ts`, sql`feature_id`).where(sql`(((payload -> 'resource_governor'::text) ->> 'schemaVersion'::text) = '1'::text)`),
	index("work_items_twin_rekey_marker_idx").using("btree", sql`workspace_id`, sql`(((payload -> '_physicalTwinRekey'::text) ->> 'oldId'::text))`).where(sql`(((payload -> '_physicalTwinRekey'::text) ->> 'migration'::text) = '826'::text)`),
	index("work_items_twin_repair_marker_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(((payload -> '_physicalTwinRepair'::text) ->> 'migration'::text) = '826'::text)`),
	uniqueIndex("work_items_watchdog_identity_uq").using("btree", sql`workspace_id`, sql`harness_slug`, sql`((payload ->> 'watchdogKey'::text))`, sql`COALESCE(((payload -> '_ei'::text) ->> 'signal_origin'::text), `, sql`COALESCE((payload ->> 'lane'::text), 'improvement'::text)`).where(sql`((item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])) AND ((status IS NULL) OR (status <> ALL (ARRAY['passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'done'::text, 'dropped'::text]))) AND ((payload ->> 'watchdogKey'::text) IS NOT NULL))`),
	primaryKey({ columns: [table.featureId, table.harnessSlug], name: "work_items_pkey"}),
	pgPolicy("work_items_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hfc_design_status_chk", sql`(design_status IS NULL) OR (design_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'ignored'::text]))`),
	check("hfc_rank_writer_chk", sql`(rank_writer IS NULL) OR (rank_writer = ANY (ARRAY['cup'::text, 'mug'::text]))`),
	check("hfc_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("work_items_admission_chk", sql`(admission IS NULL) OR (admission = ANY (ARRAY['pending'::text, 'admitted'::text, 'auto'::text, 'unreviewed'::text]))`),
	check("work_items_authority_check", sql`(authority IS NULL) OR (authority = ANY (ARRAY['proposed'::text, 'validated'::text, 'committed'::text, 'pending_human'::text, 'invalid'::text]))`),
	check("work_items_epoch_ms_timestamp_units_chk", sql`((created_ts IS NULL) OR (created_ts < (1000000000)::bigint) OR (created_ts >= '10000000000'::bigint)) AND ((updated_ts IS NULL) OR (updated_ts < (1000000000)::bigint) OR (updated_ts >= '10000000000'::bigint))`),
	check("work_items_payload_is_object_ck", sql`(payload IS NULL) OR (jsonb_typeof(payload) = 'object'::text)`),
	check("work_items_signal_origin_chk", sql`(((payload -> '_ei'::text) ->> 'signal_origin'::text) IS NULL) OR (((payload -> '_ei'::text) ->> 'signal_origin'::text) = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text]))`),
]);

export const workerChunkLoopOutcomesInHarnessShared = harnessShared.table("worker_chunk_loop_outcomes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.worker_chunk_loop_outcomes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	executionPath: text("execution_path").notNull(),
	outcomeKind: text("outcome_kind").notNull(),
	chunksCommitted: integer("chunks_committed"),
	replanStrikes: integer("replan_strikes"),
	escalatedChunkId: text("escalated_chunk_id"),
	detail: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	resumed: boolean(),
	abortReason: text("abort_reason"),
	totalReplans: integer("total_replans"),
	chunksCommittedSoFar: integer("chunks_committed_so_far"),
	totalChunksPlanned: integer("total_chunks_planned"),
}, (table) => [
	index("worker_chunk_loop_outcomes_abort_reason_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.executionPath.asc().nullsLast().op("text_ops"), table.abortReason.asc().nullsLast().op("text_ops")).where(sql`(abort_reason IS NOT NULL)`),
	index("worker_chunk_loop_outcomes_path_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.executionPath.asc().nullsLast().op("text_ops"), table.outcomeKind.asc().nullsLast().op("text_ops")),
	index("worker_chunk_loop_outcomes_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "worker_chunk_loop_outcomes_pkey"}),
	pgPolicy("worker_chunk_loop_outcomes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const workspaceBackupSettingsInHarnessShared = harnessShared.table("workspace_backup_settings", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	enabled: boolean().default(true).notNull(),
	cadenceMode: text("cadence_mode").default('event').notNull(),
	cadenceMinutes: integer("cadence_minutes").default(60).notNull(),
	retentionPreset: text("retention_preset").default('default').notNull(),
	retentionCustomJson: jsonb("retention_custom_json"),
	eventTriggersJson: jsonb("event_triggers_json").default(["pre_destructive","post_run","plugin_install","secret_change"]).notNull(),
	excludedPathsJson: jsonb("excluded_paths_json").default([]).notNull(),
	destinationType: text("destination_type").default('local').notNull(),
	destinationConfigEncrypted: text("destination_config_encrypted"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	pgPolicy("workspace_backup_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "workspace_backup_settings_pkey"}),

]);

export const workspaceGrantsInHarnessShared = harnessShared.table("workspace_grants", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	organizationId: text("organization_id").notNull(),
	customerWorkspaceId: text("customer_workspace_id").notNull(),
	granteeKind: text("grantee_kind").notNull(),
	granteeId: text("grantee_id").notNull(),
	permission: text().notNull(),
	state: text().default('active').notNull(),
	grantedByPrincipalKind: text("granted_by_principal_kind").notNull(),
	grantedByPrincipalId: text("granted_by_principal_id").notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedByPrincipalKind: text("revoked_by_principal_kind"),
	revokedByPrincipalId: text("revoked_by_principal_id"),
	revocationReason: text("revocation_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("workspace_grants_active_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.organizationId.asc().nullsLast().op("text_ops"), table.customerWorkspaceId.asc().nullsLast().op("text_ops"), table.granteeKind.asc().nullsLast().op("text_ops"), table.granteeId.asc().nullsLast().op("text_ops"), table.permission.asc().nullsLast().op("text_ops")).where(sql`(state = 'active'::text)`),
	index("workspace_grants_grantee_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.organizationId.asc().nullsLast().op("text_ops"), table.granteeKind.asc().nullsLast().op("text_ops"), table.granteeId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	index("workspace_grants_workspace_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.organizationId.asc().nullsLast().op("text_ops"), table.customerWorkspaceId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.organizationId, table.customerWorkspaceId],
			foreignColumns: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id],
			name: "workspace_grants_workspace_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_grants_pkey"}),
	pgPolicy("workspace_grants_app_scope", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`((organization_id = NULLIF(current_setting('app.organization_id'::text, true), ''::text)) AND (customer_workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)))`, withCheck: sql`((organization_id = NULLIF(current_setting('app.organization_id'::text, true), ''::text)) AND (customer_workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)))`  }),
	check("workspace_grants_expiry_ck", sql`((expires_at IS NULL) OR (expires_at > granted_at)) AND ((expired_at IS NULL) OR ((expires_at IS NOT NULL) AND (expired_at >= granted_at)))`),
	check("workspace_grants_grantee_ck", sql`(btrim(grantee_kind) <> ''::text) AND (btrim(grantee_id) <> ''::text)`),
	check("workspace_grants_grantor_ck", sql`(btrim(granted_by_principal_kind) <> ''::text) AND (btrim(granted_by_principal_id) <> ''::text)`),
	check("workspace_grants_lifecycle_ck", sql`((state = 'active'::text) AND (expired_at IS NULL) AND (revoked_at IS NULL) AND (revoked_by_principal_kind IS NULL) AND (revoked_by_principal_id IS NULL) AND (revocation_reason IS NULL)) OR ((state = 'revoked'::text) AND (expired_at IS NULL) AND (revoked_at IS NOT NULL) AND (revoked_by_principal_kind IS NOT NULL) AND (revoked_by_principal_id IS NOT NULL) AND (btrim(revoked_by_principal_kind) <> ''::text) AND (btrim(revoked_by_principal_id) <> ''::text)) OR ((state = 'expired'::text) AND (expired_at IS NOT NULL) AND (revoked_at IS NULL) AND (revoked_by_principal_kind IS NULL) AND (revoked_by_principal_id IS NULL) AND (revocation_reason IS NULL))`),
	check("workspace_grants_organization_id_ck", sql`btrim(organization_id) <> ''::text`),
	check("workspace_grants_permission_ck", sql`(btrim(permission) <> ''::text) AND (POSITION(('*'::text) IN (permission)) = 0)`),
	check("workspace_grants_state_ck", sql`state = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])`),
]);

export const workspaceHostConnectionsInHarnessShared = harnessShared.table("workspace_host_connections", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	target: text().notNull(),
	label: text().notNull(),
	credentialRef: text("credential_ref").notNull(),
	status: text().default('invalid').notNull(),
	statusDetail: text("status_detail"),
	lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: 'string' }),
	scopes: jsonb().default([]).notNull(),
	regions: jsonb().default([]).notNull(),
	sizes: jsonb().default([]).notNull(),
	images: jsonb().default([]).notNull(),
	networks: jsonb().default([]).notNull(),
	diskPricePerGibMonth: numeric("disk_price_per_gib_month", { precision: 12, scale:  6 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	providerConfig: jsonb("provider_config").default({}).notNull(),
	authenticatedIdentity: text("authenticated_identity"),
}, (table) => [
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_host_connections_pkey"}),
	pgPolicy("workspace_host_connections_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_host_connections_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_host_connections_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_connection_scope_allows(workspace_id, id)`, withCheck: sql`harness_shared.workspace_host_connection_scope_allows(workspace_id, id)` }),
	check("workspace_host_connections_authenticated_identity_ck", sql`(authenticated_identity IS NULL) OR (btrim(authenticated_identity) <> ''::text)`),
	check("workspace_host_connections_images_check", sql`jsonb_typeof(images) = 'array'::text`),
	check("workspace_host_connections_networks_check", sql`jsonb_typeof(networks) = 'array'::text`),
	check("workspace_host_connections_provider_config_check", sql`jsonb_typeof(provider_config) = 'object'::text`),
	check("workspace_host_connections_regions_check", sql`jsonb_typeof(regions) = 'array'::text`),
	check("workspace_host_connections_scopes_check", sql`jsonb_typeof(scopes) = 'array'::text`),
	check("workspace_host_connections_sizes_check", sql`jsonb_typeof(sizes) = 'array'::text`),
	check("workspace_host_connections_status_check", sql`status = ANY (ARRAY['connected'::text, 'degraded'::text, 'invalid'::text])`),
]);

export const workspaceHostEventsInHarnessShared = harnessShared.table("workspace_host_events", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	hostId: text("host_id").notNull(),
	operationId: text("operation_id").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	phase: text().notNull(),
	status: text().notNull(),
	level: text().default('info').notNull(),
	source: text().default('controller').notNull(),
	message: text().notNull(),
	details: jsonb(),
}, (table) => [
	index("workspace_host_events_operation_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.operationId.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.hostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "workspace_host_events_host_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceId, table.operationId],
			foreignColumns: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id],
			name: "workspace_host_events_operation_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_host_events_pkey"}),
	pgPolicy("workspace_host_events_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_host_events_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_host_events_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)`, withCheck: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)` }),
	check("workspace_host_events_level_check", sql`level = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text])`),
	check("workspace_host_events_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])`),
]);

export const workspaceHostInitializationStepsInHarnessShared = harnessShared.table("workspace_host_initialization_steps", {
	workspaceId: text("workspace_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	hostId: text("host_id").notNull(),
	stepId: text("step_id"),
	stepFingerprint: text("step_fingerprint").notNull(),
	status: text().notNull(),
	leaseOwner: text("lease_owner"),
	leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: 'string' }),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }),
	publicEvidence: jsonb("public_evidence"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("workspace_host_initialization_steps_host_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.hostId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("workspace_host_initialization_steps_stale_lease_idx").using("btree", table.leaseExpiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'running'::text)`),
	foreignKey({
			columns: [table.workspaceId, table.hostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "workspace_host_initialization_steps_host_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.idempotencyKey, table.workspaceId], name: "workspace_host_initialization_steps_pkey"}),
	pgPolicy("workspace_host_initialization_steps_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("workspace_host_initialization_steps_public_evidence_check", sql`(public_evidence IS NULL) OR (jsonb_typeof(public_evidence) = 'object'::text)`),
	check("workspace_host_initialization_steps_running_leased", sql`(status <> 'running'::text) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL))`),
	check("workspace_host_initialization_steps_status_check", sql`status = ANY (ARRAY['running'::text, 'succeeded'::text])`),
	check("workspace_host_initialization_steps_step_fingerprint_check", sql`step_fingerprint ~ '^[0-9a-f]{64}$'::text`),
	check("workspace_host_initialization_steps_succeeded_complete", sql`(status <> 'succeeded'::text) OR ((observed_at IS NOT NULL) AND (step_id IS NOT NULL))`),
]);

export const workspaceHostLogsInHarnessShared = harnessShared.table("workspace_host_logs", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	hostId: text("host_id").notNull(),
	operationId: text("operation_id"),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	stream: text().notNull(),
	unit: text(),
	level: text().default('info').notNull(),
	message: text().notNull(),
	metadata: jsonb(),
}, (table) => [
	index("workspace_host_logs_host_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.hostId.asc().nullsLast().op("text_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.hostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "workspace_host_logs_host_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceId, table.operationId],
			foreignColumns: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id],
			name: "workspace_host_logs_operation_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_host_logs_pkey"}),
	pgPolicy("workspace_host_logs_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_host_logs_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_host_logs_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)`, withCheck: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)` }),
	check("workspace_host_logs_level_check", sql`level = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text])`),
	check("workspace_host_logs_stream_check", sql`stream = ANY (ARRAY['cloud-init'::text, 'systemd'::text, 'controller'::text])`),
]);

export const workspaceHostOperationsInHarnessShared = harnessShared.table("workspace_host_operations", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	hostId: text("host_id").notNull(),
	action: text().notNull(),
	status: text().notNull(),
	percent: integer().default(0).notNull(),
	message: text().default('').notNull(),
	request: jsonb(),
	error: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: text("organization_id"),
	customerWorkspaceId: text("customer_workspace_id"),
	providerTarget: text("provider_target"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	estimatedCostCents: bigint("estimated_cost_cents", { mode: "number" }),
	costCurrency: text("cost_currency"),
	costEstimateSource: text("cost_estimate_source"),
	costEstimateRef: text("cost_estimate_ref"),
	costEstimatedAt: timestamp("cost_estimated_at", { withTimezone: true, mode: 'string' }),
	billingOwnerKind: text("billing_owner_kind"),
	billingOwnerId: text("billing_owner_id"),
	riskTier: text("risk_tier"),
	approvalStatus: text("approval_status"),
	approvedByPrincipalId: text("approved_by_principal_id"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }),
	recoveryState: text("recovery_state").default('none').notNull(),
	recoveryAttempts: integer("recovery_attempts").default(0).notNull(),
	orphanedAt: timestamp("orphaned_at", { withTimezone: true, mode: 'string' }),
	emergencyTeardown: boolean("emergency_teardown").default(false).notNull(),
	teardownReason: text("teardown_reason"),
	ownerNotificationDedupeKey: text("owner_notification_dedupe_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	desiredRevision: bigint("desired_revision", { mode: "number" }),
	controllerId: text("controller_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controllerFence: bigint("controller_fence", { mode: "number" }),
}, (table) => [
	index("workspace_host_operations_budget_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.customerWorkspaceId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops"), table.estimatedCostCents.asc().nullsLast().op("int8_ops")).where(sql`((customer_workspace_id IS NOT NULL) AND (estimated_cost_cents IS NOT NULL))`),
	index("workspace_host_operations_host_updated_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.hostId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	index("workspace_host_operations_provider_admission_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.providerTarget.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`((provider_target IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))`),
	index("workspace_host_operations_recovery_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.recoveryState.asc().nullsLast().op("text_ops"), table.heartbeatAt.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['queued'::text, 'running'::text]))`),
	index("workspace_host_operations_tenant_admission_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.customerWorkspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`((customer_workspace_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))`),
	foreignKey({
			columns: [table.workspaceId, table.organizationId, table.customerWorkspaceId],
			foreignColumns: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id],
			name: "workspace_host_operations_customer_workspace_fk"
		}),
	foreignKey({
			columns: [table.workspaceId, table.hostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "workspace_host_operations_host_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_host_operations_pkey"}),
	pgPolicy("workspace_host_operations_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_host_operations_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_host_operations_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)`, withCheck: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)` }),
	check("workspace_host_operations_action_check", sql`action = ANY (ARRAY['provision'::text, 'start'::text, 'stop'::text, 'restart'::text, 'snapshot'::text, 'restore'::text, 'upgrade'::text, 'repair'::text, 'destroy'::text, 'initialize'::text])`),
	check("workspace_host_operations_approval_ck", sql`(approval_status IS NULL) OR ((approval_status = ANY (ARRAY['not-required'::text, 'pending'::text, 'approved'::text, 'rejected'::text])) AND (((approval_status = 'approved'::text) AND (approved_by_principal_id IS NOT NULL) AND (approved_at IS NOT NULL)) OR ((approval_status <> 'approved'::text) AND (approved_by_principal_id IS NULL) AND (approved_at IS NULL))))`),
	check("workspace_host_operations_billing_owner_ck", sql`((billing_owner_kind IS NULL) AND (billing_owner_id IS NULL)) OR ((billing_owner_kind = ANY (ARRAY['organization'::text, 'customer'::text, 'platform'::text])) AND (btrim(billing_owner_id) <> ''::text))`),
	check("workspace_host_operations_controller_authority_ck", sql`((controller_id IS NULL) AND (controller_fence IS NULL)) OR ((controller_id IS NOT NULL) AND (controller_fence IS NOT NULL) AND (btrim(controller_id) <> ''::text) AND (controller_fence > 0) AND (desired_revision IS NOT NULL) AND (desired_revision > 0))`),
	check("workspace_host_operations_cost_provenance_ck", sql`((estimated_cost_cents IS NULL) AND (cost_currency IS NULL) AND (cost_estimate_source IS NULL) AND (cost_estimate_ref IS NULL) AND (cost_estimated_at IS NULL)) OR ((estimated_cost_cents >= 0) AND (cost_currency ~ '^[A-Z]{3}$'::text) AND (btrim(cost_estimate_source) <> ''::text) AND (btrim(cost_estimate_ref) <> ''::text) AND (cost_estimated_at IS NOT NULL))`),
	check("workspace_host_operations_domain_revision_ck", sql`(desired_revision IS NULL) OR (desired_revision > 0)`),
	check("workspace_host_operations_emergency_teardown_ck", sql`(NOT emergency_teardown) OR ((action = 'destroy'::text) AND (btrim(teardown_reason) <> ''::text) AND (organization_id IS NOT NULL) AND (customer_workspace_id IS NOT NULL) AND (billing_owner_kind IS NOT NULL) AND (billing_owner_id IS NOT NULL))`),
	check("workspace_host_operations_percent_check", sql`(percent >= 0) AND (percent <= 100)`),
	check("workspace_host_operations_recovery_ck", sql`(recovery_state = ANY (ARRAY['none'::text, 'stuck'::text, 'recovery-pending'::text, 'recovering'::text, 'orphaned'::text, 'exhausted'::text])) AND (recovery_attempts >= 0) AND ((recovery_state = 'orphaned'::text) = (orphaned_at IS NOT NULL))`),
	check("workspace_host_operations_risk_ck", sql`(risk_tier IS NULL) OR (risk_tier = ANY (ARRAY['low'::text, 'moderate'::text, 'high'::text, 'critical'::text]))`),
	check("workspace_host_operations_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])`),
	check("workspace_host_operations_tenant_identity_ck", sql`((organization_id IS NULL) AND (customer_workspace_id IS NULL) AND (provider_target IS NULL)) OR ((btrim(organization_id) <> ''::text) AND (btrim(customer_workspace_id) <> ''::text) AND (btrim(provider_target) <> ''::text))`),
]);

export const workspaceHostResourcesInHarnessShared = harnessShared.table("workspace_host_resources", {
	workspaceId: text("workspace_id").notNull(),
	hostId: text("host_id").notNull(),
	logicalKey: text("logical_key").notNull(),
	operationId: text("operation_id").notNull(),
	state: text().notNull(),
	attempts: integer().default(0).notNull(),
	retryClass: text("retry_class"),
	retryAfterMs: integer("retry_after_ms"),
	target: text(),
	kind: text(),
	providerId: text("provider_id"),
	parentProviderId: text("parent_provider_id"),
	region: text(),
	zone: text(),
	providerRequestId: text("provider_request_id"),
	deletionConfirmation: jsonb("deletion_confirmation"),
	error: jsonb(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("workspace_host_resources_host_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.hostId.asc().nullsLast().op("text_ops"), table.logicalKey.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.hostId],
			foreignColumns: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id],
			name: "workspace_host_resources_host_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceId, table.operationId],
			foreignColumns: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id],
			name: "workspace_host_resources_operation_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.hostId, table.logicalKey, table.workspaceId], name: "workspace_host_resources_pkey"}),
	pgPolicy("workspace_host_resources_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_host_resources_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_host_resources_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)`, withCheck: sql`harness_shared.workspace_host_scope_allows(workspace_id, host_id)` }),
	check("workspace_host_resources_attempts_check", sql`attempts >= 0`),
	check("workspace_host_resources_retry_after_ms_check", sql`(retry_after_ms IS NULL) OR (retry_after_ms >= 0)`),
	check("workspace_host_resources_retry_class_check", sql`(retry_class IS NULL) OR (retry_class = ANY (ARRAY['transient'::text, 'throttled'::text, 'ambiguous'::text, 'terminal'::text]))`),
	check("workspace_host_resources_state_check", sql`state = ANY (ARRAY['planned'::text, 'applying'::text, 'reconciling'::text, 'retry-wait'::text, 'applied'::text, 'unchanged'::text, 'compensating'::text, 'compensated'::text, 'absent'::text, 'failed'::text])`),
]);

export const workspaceHostsInHarnessShared = harnessShared.table("workspace_hosts", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	name: text().notNull(),
	connectionId: text("connection_id").notNull(),
	target: text().notNull(),
	scopeLabel: text("scope_label").notNull(),
	region: text().notNull(),
	size: text().notNull(),
	image: text().notNull(),
	diskGib: integer("disk_gib").notNull(),
	network: text().notNull(),
	estimatedMonthlyUsd: numeric("estimated_monthly_usd", { precision: 12, scale:  4 }),
	desiredState: text("desired_state").notNull(),
	observedState: text("observed_state").notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }),
	endpoint: text(),
	recoverabilityKind: text("recoverability_kind").default('none').notNull(),
	recoverabilityLabel: text("recoverability_label").default('No recovery point recorded').notNull(),
	recoverabilityUpdatedAt: timestamp("recoverability_updated_at", { withTimezone: true, mode: 'string' }),
	healthStatus: text("health_status"),
	healthAttestedAt: timestamp("health_attested_at", { withTimezone: true, mode: 'string' }),
	healthChecks: jsonb("health_checks").default([]).notNull(),
	bootstrapVersion: text("bootstrap_version"),
	versionDrift: jsonb("version_drift").default([]).notNull(),
	tunnelStatus: jsonb("tunnel_status").default({}).notNull(),
	costSignals: jsonb("cost_signals").default([]).notNull(),
	quotaSignals: jsonb("quota_signals").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	desiredSpec: jsonb("desired_spec"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hostGeneration: bigint("host_generation", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	desiredRevision: bigint("desired_revision", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	observedRevision: bigint("observed_revision", { mode: "number" }).default(0).notNull(),
	runtimeRelease: jsonb("runtime_release"),
	controllerId: text("controller_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controllerFence: bigint("controller_fence", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("workspace_hosts_workspace_updated_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.connectionId],
			foreignColumns: [workspaceHostConnectionsInHarnessShared.workspaceId, workspaceHostConnectionsInHarnessShared.id],
			name: "workspace_hosts_connection_fk"
		}),
	primaryKey({ columns: [table.id, table.workspaceId], name: "workspace_hosts_pkey"}),
	pgPolicy("workspace_hosts_local_workspace_isolation", { as: "permissive", for: "all", to: ["harness_app"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`, withCheck: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))`  }),
	pgPolicy("workspace_hosts_local_read_isolation", { as: "permissive", for: "select", to: ["harness_zero"], using: sql`(workspace_id = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))` }),
	pgPolicy("workspace_hosts_hosted_tenant_isolation", { as: "permissive", for: "all", to: ["hosted_app"], using: sql`harness_shared.workspace_host_scope_allows(workspace_id, id)`, withCheck: sql`harness_shared.workspace_host_scope_allows(workspace_id, id)` }),
	check("workspace_hosts_controller_authority_ck", sql`((controller_id IS NULL) AND (controller_fence = 0)) OR ((controller_id IS NOT NULL) AND (btrim(controller_id) <> ''::text) AND (controller_fence > 0))`),
	check("workspace_hosts_cost_signals_check", sql`jsonb_typeof(cost_signals) = 'array'::text`),
	check("workspace_hosts_desired_spec_object", sql`(desired_spec IS NULL) OR (jsonb_typeof(desired_spec) = 'object'::text)`),
	check("workspace_hosts_desired_state_check", sql`desired_state = ANY (ARRAY['provisioning'::text, 'running'::text, 'stopped'::text, 'degraded'::text, 'repairing'::text, 'destroying'::text, 'absent'::text])`),
	check("workspace_hosts_disk_gib_check", sql`disk_gib > 0`),
	check("workspace_hosts_health_checks_check", sql`jsonb_typeof(health_checks) = 'array'::text`),
	check("workspace_hosts_health_status_check", sql`(health_status IS NULL) OR (health_status = ANY (ARRAY['healthy'::text, 'degraded'::text, 'unreachable'::text, 'unknown'::text]))`),
	check("workspace_hosts_host_generation_ck", sql`host_generation > 0`),
	check("workspace_hosts_observed_state_check", sql`observed_state = ANY (ARRAY['provisioning'::text, 'running'::text, 'stopped'::text, 'degraded'::text, 'repairing'::text, 'destroying'::text, 'absent'::text])`),
	check("workspace_hosts_quota_signals_check", sql`jsonb_typeof(quota_signals) = 'array'::text`),
	check("workspace_hosts_recoverability_kind_check", sql`recoverability_kind = ANY (ARRAY['snapshot'::text, 'backup'::text, 'none'::text])`),
	check("workspace_hosts_revision_ck", sql`(desired_revision > 0) AND (observed_revision >= 0) AND (observed_revision <= desired_revision)`),
	check("workspace_hosts_runtime_release_ck", sql`(runtime_release IS NULL) OR ((jsonb_typeof(runtime_release) = 'object'::text) AND (runtime_release ?& ARRAY['version'::text, 'bundleSha256'::text, 'signingKeySha256'::text, 'protocolVersion'::text, 'schemaVersion'::text]) AND ((runtime_release - ARRAY['version'::text, 'bundleSha256'::text, 'signingKeySha256'::text, 'protocolVersion'::text, 'schemaVersion'::text]) = '{}'::jsonb) AND (jsonb_typeof((runtime_release -> 'version'::text)) = 'string'::text) AND (btrim((runtime_release ->> 'version'::text)) <> ''::text) AND (jsonb_typeof((runtime_release -> 'bundleSha256'::text)) = 'string'::text) AND ((runtime_release ->> 'bundleSha256'::text) ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof((runtime_release -> 'signingKeySha256'::text)) = 'string'::text) AND ((runtime_release ->> 'signingKeySha256'::text) ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof((runtime_release -> 'protocolVersion'::text)) = 'string'::text) AND (btrim((runtime_release ->> 'protocolVersion'::text)) <> ''::text) AND (jsonb_typeof((runtime_release -> 'schemaVersion'::text)) = 'string'::text) AND (btrim((runtime_release ->> 'schemaVersion'::text)) <> ''::text))`),
	check("workspace_hosts_tunnel_status_check", sql`jsonb_typeof(tunnel_status) = 'object'::text`),
	check("workspace_hosts_version_drift_check", sql`jsonb_typeof(version_drift) = 'array'::text`),
]);

export const briefingsInPapercuspShared = papercuspShared.table("briefings", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	quarter: text().default('').notNull(),
	status: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	scriptPath: text("script_path"),
	durationSeconds: integer("duration_seconds"),
	youtubeUrl: text("youtube_url"),
	youtubeVideoId: text("youtube_video_id"),
	thumbnailUrl: text("thumbnail_url"),
	renderLog: text("render_log"),
	error: text(),
	summary: text(),
}, (table) => [
	index("briefings_quarter_idx").using("btree", table.quarter.asc().nullsLast().op("text_ops")),
	index("briefings_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const directiveSummariesInPapercuspShared = papercuspShared.table("directive_summaries", {
	id: text().primaryKey().notNull(),
	directiveId: text("directive_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().default('ceo').notNull(),
	body: text().notNull(),
}, (table) => [
	index("summaries_directive_idx").using("btree", table.directiveId.asc().nullsLast().op("text_ops")),
	index("summaries_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
]);

export const directivesInPapercuspShared = papercuspShared.table("directives", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	status: text().notNull(),
	createdBy: text("created_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deadlineTs: bigint("deadline_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	priority: text(),
	assignedDepartments: jsonb("assigned_departments").default([]).notNull(),
	linkedProjectIds: jsonb("linked_project_ids").default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("directives_created_idx").using("btree", table.createdTs.desc().nullsFirst().op("int8_ops")),
	index("directives_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const messageCommentsInPapercuspShared = papercuspShared.table("message_comments", {
	id: text().primaryKey().notNull(),
	messageId: text("message_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().notNull(),
	body: text().notNull(),
}, (table) => [
	index("comments_msg_idx").using("btree", table.messageId.asc().nullsLast().op("text_ops")),
	index("comments_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInPapercuspShared.id],
			name: "message_comments_message_id_fkey"
		}).onDelete("cascade"),
]);

export const messageRecipientsInPapercuspShared = papercuspShared.table("message_recipients", {
	messageId: text("message_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
}, (table) => [
	index("recipients_dept_idx").using("btree", table.deptSlug.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInPapercuspShared.id],
			name: "message_recipients_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.deptSlug, table.messageId], name: "message_recipients_pkey"}),
]);

export const messagesInPapercuspShared = papercuspShared.table("messages", {
	id: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	fromDept: text("from_dept").notNull(),
	kind: text().notNull(),
	subject: text().notNull(),
	body: text().notNull(),
	refId: text("ref_id"),
	projectId: text("project_id"),
	directiveId: text("directive_id"),
	status: text().default('pending').notNull(),
	metadata: jsonb(),
}, (table) => [
	index("messages_directive_idx").using("btree", table.directiveId.asc().nullsLast().op("text_ops")),
	index("messages_from_idx").using("btree", table.fromDept.asc().nullsLast().op("text_ops")),
	index("messages_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("messages_project_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("messages_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("messages_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
]);

export const agentUsageSamplesIdentityAttributionInHarnessShared = harnessShared.view("agent_usage_samples_identity_attribution", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	bucketKey: text("bucket_key"),
	provider: text(),
	modelClass: text("model_class"),
	source: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
	costUsd: doublePrecision("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsLimit: bigint("rl_requests_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsRemaining: bigint("rl_requests_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensLimit: bigint("rl_tokens_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensRemaining: bigint("rl_tokens_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlResetAt: bigint("rl_reset_at", { mode: "number" }),
	model: text(),
	costSource: text("cost_source"),
	harnessSlug: text("harness_slug"),
	runId: text("run_id"),
	role: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }),
	turnCount: integer("turn_count"),
	sessionId: text("session_id"),
	toolName: text("tool_name"),
	turnTrigger: text("turn_trigger"),
	accountId: text("account_id"),
	goalId: text("goal_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	identityActivationEventId: bigint("identity_activation_event_id", { mode: "number" }),
	identityOwnerId: text("identity_owner_id"),
	identityActorId: text("identity_actor_id"),
	identityPrincipalId: text("identity_principal_id"),
	identitySessionId: text("identity_session_id"),
	identityTransitionId: text("identity_transition_id"),
	identitySpecificationRevision: text("identity_specification_revision"),
	identityStateRevision: text("identity_state_revision"),
	identityStackRefs: jsonb("identity_stack_refs"),
}).as(sql`SELECT u.id, u.workspace_id, u.ts, u.bucket_key, u.provider, u.model_class, u.source, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cost_usd, u.rl_requests_limit, u.rl_requests_remaining, u.rl_tokens_limit, u.rl_tokens_remaining, u.rl_reset_at, u.model, u.cost_source, u.harness_slug, u.run_id, u.role, u.cache_creation_tokens, u.turn_count, u.session_id, u.tool_name, u.turn_trigger, u.account_id, u.goal_id, a.activation_event_id AS identity_activation_event_id, a.owner_id AS identity_owner_id, a.actor_id AS identity_actor_id, a.principal_id AS identity_principal_id, a.session_id AS identity_session_id, a.transition_id AS identity_transition_id, a.specification_revision AS identity_specification_revision, a.state_revision AS identity_state_revision, a.stack_refs AS identity_stack_refs FROM harness_shared.agent_usage_samples u LEFT JOIN LATERAL ( SELECT s.activation_event_id, s.workspace_id, s.owner_id, s.actor_id, s.principal_id, s.session_id, s.adv_session_id, s.native_session_id, s.transition_id, s.control_generation, s.source, s.specification_revision, s.state_revision, s.stack_refs, s.active_from, s.active_until FROM harness_shared.session_identity_activation_spans s WHERE s.workspace_id = u.workspace_id AND to_timestamp((u.ts::numeric / 1000.0)::double precision) >= s.active_from AND (s.active_until IS NULL OR to_timestamp((u.ts::numeric / 1000.0)::double precision) < s.active_until) AND u.session_id IS NOT NULL AND (u.session_id = s.native_session_id OR (EXISTS ( SELECT 1 FROM harness_shared.adv_sessions av WHERE av.id = s.adv_session_id AND av.session_id = u.session_id)) OR (EXISTS ( SELECT 1 FROM harness_shared.session_archives ar WHERE ar.adv_session_id = s.adv_session_id AND ar.session_id = u.session_id)) OR (EXISTS ( SELECT 1 FROM harness_shared.session_turns t WHERE (t.workspace_id = u.workspace_id OR t.workspace_id = 'default'::text) AND (t.source_kind = ANY (ARRAY['claude'::text, 'omp'::text, 'codex'::text])) AND t.session_id = u.session_id AND t.owner = s.owner_id)) AND NOT (EXISTS ( SELECT 1 FROM harness_shared.session_turns t WHERE (t.workspace_id = u.workspace_id OR t.workspace_id = 'default'::text) AND (t.source_kind = ANY (ARRAY['claude'::text, 'omp'::text, 'codex'::text])) AND t.session_id = u.session_id AND t.owner IS NOT NULL AND t.owner <> s.owner_id))) ORDER BY s.active_from DESC, s.activation_event_id DESC LIMIT 1) a ON true`);

export const beeClaimSpecsInHarnessShared = harnessShared.view("bee_claim_specs", {	workspaceId: text("workspace_id"),
	beeId: text("bee_id"),
	spec: jsonb(),
	revision: integer(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	idOnly: boolean("id_only"),
	harnessSlug: text("harness_slug"),
	origin: text(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}).as(sql`SELECT workspace_id, bee_id, spec, revision, updated_by, updated_at, id_only, harness_slug, origin, author_pubkey, fed_ts, fed_hlc FROM harness_shared.cup_claim_specs`);

export const beekeeperInstancesInHarnessShared = harnessShared.view("beekeeper_instances", {	instanceId: text("instance_id"),
	workspaceId: text("workspace_id"),
	codeSha: text("code_sha"),
	genomeId: text("genome_id"),
	memorySnapshotId: text("memory_snapshot_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT instance_id, workspace_id, code_sha, genome_id, memory_snapshot_id, battery_slice_id, created_at FROM harness_shared.cup_keeper_instances`);

export const beekeeperRunsInHarnessShared = harnessShared.view("beekeeper_runs", {	runId: text("run_id"),
	instanceId: text("instance_id"),
	caseId: text("case_id"),
	caseVariant: text("case_variant"),
	caseTitle: text("case_title"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
	terminalState: text("terminal_state"),
	deterministicSignals: jsonb("deterministic_signals"),
	traceRef: text("trace_ref"),
}).as(sql`SELECT run_id, instance_id, case_id, case_variant, case_title, started_at, finished_at, elapsed_ms, terminal_state, deterministic_signals, trace_ref FROM harness_shared.cup_keeper_runs`);

export const beekeeperScoresInHarnessShared = harnessShared.view("beekeeper_scores", {	runId: text("run_id"),
	judgeModel: text("judge_model"),
	rubricHash: text("rubric_hash"),
	judgeTemp: real("judge_temp"),
	weights: jsonb(),
	success: boolean(),
	tokensPerTask: numeric("tokens_per_task"),
	timeToGreenSecs: numeric("time_to_green_secs"),
	firstAttemptPass: boolean("first_attempt_pass"),
	recurrence: integer(),
	escalation: boolean(),
	recallHit: numeric("recall_hit"),
	d1: real(),
	d2: real(),
	d3: real(),
	composite: real(),
	rationale: text(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT run_id, judge_model, rubric_hash, judge_temp, weights, success, tokens_per_task, time_to_green_secs, first_attempt_pass, recurrence, escalation, recall_hit, d1, d2, d3, composite, rationale, scored_at FROM harness_shared.cup_keeper_scores`);

export const engineerIssuesInHarnessShared = harnessShared.view("engineer_issues", {	workspaceId: text("workspace_id"),
	issueId: text("issue_id"),
	scope: text(),
	title: text(),
	body: text(),
	severity: text(),
	source: text(),
	state: text(),
	assignee: text(),
	foundDuring: text("found_during"),
	linkedFeatureId: text("linked_feature_id"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	search: tsvectorCustom("_search"),
	kind: text(),
	payload: jsonb(),
	assignedBy: text("assigned_by"),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	signalOrigin: text("signal_origin"),
	fedHlc: text("fed_hlc"),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	baseHarnessSlug: text("base_harness_slug"),
	baseOrigin: text("base_origin"),
	featureOrder: integer("feature_order"),
	terminalReason: text("terminal_reason"),
	authority: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closedTs: bigint("closed_ts", { mode: "number" }),
	lane: text(),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	goalId: text("goal_id"),
	parentId: text("parent_id"),
	tags: jsonb(),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	redundancy: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	stateChangedAt: timestamp("state_changed_at", { withTimezone: true, mode: 'string' }),
	admission: text(),
	admittedAt: timestamp("admitted_at", { withTimezone: true, mode: 'string' }),
	admittedBy: text("admitted_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
	lastReleasedBy: text("last_released_by"),
	claimHold: boolean("claim_hold"),
	needsOwnerAction: boolean("needs_owner_action"),
	embeddingProfile: text("embedding_profile"),
}).as(sql`SELECT workspace_id, feature_id AS issue_id, CASE WHEN harness_slug ~~ 'operator:%'::text OR harness_slug = ''::text THEN 'operator'::text ELSE 'harness:'::text || harness_slug END AS scope, title, COALESCE(summary, ''::text) AS body, COALESCE((payload -> '_ei'::text) ->> 'severity'::text, 'minor'::text) AS severity, COALESCE((payload -> '_ei'::text) ->> 'source'::text, 'engineer'::text) AS source, status AS state, taken_by AS assignee, (payload -> '_ei'::text) ->> 'found_during'::text AS found_during, (payload -> '_ei'::text) ->> 'linked_feature_id'::text AS linked_feature_id, (payload -> '_ei'::text) ->> 'created_by'::text AS created_by, to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at, to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at, author_pubkey, origin, _search, item_kind AS kind, payload, (payload -> '_ei'::text) ->> 'assigned_by'::text AS assigned_by, taken_at AS assigned_at, assignee_rank, rank_writer, rank_updated_at, fed_ts, COALESCE((payload -> '_ei'::text) ->> 'signal_origin'::text, 'organic'::text) AS signal_origin, fed_hlc, terminal_owner, terminal_completion_ref, last_progress_at, harness_slug AS base_harness_slug, origin AS base_origin, feature_order, terminal_reason, authority, closed_ts, lane, embedding, embedding_mode, goal_id, parent_id, tags, source_plan_slug, source_plan_item_ids, redundancy, expected_cost_cents, state_changed_at, admission, admitted_at, admitted_by, last_released_at, last_released_by, claim_hold, needs_owner_action, embedding_profile FROM harness_shared.work_items WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])`);

export const eventAwaitsEffectiveInHarnessShared = harnessShared.view("event_awaits_effective", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	subscriberId: text("subscriber_id"),
	eventKey: text("event_key"),
	policy: text(),
	note: text(),
	wakeHandle: jsonb("wake_handle"),
	timeoutBehavior: text("timeout_behavior"),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	firedReason: text("fired_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	once: boolean(),
	minSleepSec: integer("min_sleep_sec"),
	urgency: boolean(),
	payloadFilter: jsonb("payload_filter"),
	scopeKind: text("scope_kind"),
	scopeRef: text("scope_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	nodeId: bigint("node_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rootId: bigint("root_id", { mode: "number" }),
	memberFiredAt: timestamp("member_fired_at", { withTimezone: true, mode: 'string' }),
	memberPayload: jsonb("member_payload"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	causalGeneration: bigint("causal_generation", { mode: "number" }),
	expectedCondition: jsonb("expected_condition"),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
	firedBy: text("fired_by"),
	firedPayload: jsonb("fired_payload"),
	effectiveExpiresTs: timestamp("effective_expires_ts", { withTimezone: true, mode: 'string' }),
	effectiveTimeoutBehavior: text("effective_timeout_behavior"),
	composedRole: text("composed_role"),
	rootExpiresTs: timestamp("root_expires_ts", { withTimezone: true, mode: 'string' }),
	rootRequiredCount: integer("root_required_count"),
	rootFiredCount: integer("root_fired_count"),
	rootCancelledAt: timestamp("root_cancelled_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT a.id, a.workspace_id, a.subscriber_id, a.event_key, a.policy, a.note, a.wake_handle, a.timeout_behavior, a.expires_ts, a.created_at, a.fired_at, a.fired_reason, a.cancelled_at, a.once, a.min_sleep_sec, a.urgency, a.payload_filter, a.scope_kind, a.scope_ref, a.node_id, a.root_id, a.member_fired_at, a.member_payload, a.causal_generation, a.expected_condition, a.superseded_at, a.fired_by, a.fired_payload, COALESCE(a.expires_ts, rn.expires_ts) AS effective_expires_ts, CASE WHEN a.expires_ts IS NOT NULL THEN a.timeout_behavior ELSE COALESCE(rn.timeout_behavior, a.timeout_behavior) END AS effective_timeout_behavior, CASE WHEN a.root_id IS NULL THEN NULL::text WHEN a.node_id IS NOT NULL THEN 'leaf'::text ELSE 'root-anchor'::text END AS composed_role, rn.expires_ts AS root_expires_ts, rn.required_count AS root_required_count, rn.fired_count AS root_fired_count, rn.cancelled_at AS root_cancelled_at FROM harness_shared.event_awaits a LEFT JOIN harness_shared.event_await_nodes rn ON rn.id = a.root_id AND rn.workspace_id = a.workspace_id`);

export const eventKeyRegistryAttestedInHarnessShared = harnessShared.view("event_key_registry_attested", {	workspaceId: text("workspace_id"),
	eventKey: text("event_key"),
	title: text(),
	description: text(),
	keyPattern: text("key_pattern"),
	contributor: text(),
	status: text(),
	published: boolean(),
	reviewStatus: text("review_status"),
	tags: text(),
	emitter: text(),
	emitterExists: boolean("emitter_exists"),
	emitSiteCount: integer("emit_site_count"),
	derivedAt: timestamp("derived_at", { withTimezone: true, mode: 'string' }),
	derivedFrom: text("derived_from"),
	firstFiredAt: timestamp("first_fired_at", { withTimezone: true, mode: 'string' }),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }),
	lastFiredBy: text("last_fired_by"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fireCount: bigint("fire_count", { mode: "number" }),
	contradictsScan: boolean("contradicts_scan"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	payloadSchema: jsonb("payload_schema"),
}).as(sql`SELECT r.workspace_id, r.event_key, r.title, r.description, r.key_pattern, r.contributor, r.status, r.published, r.review_status, r.tags, r.emitter, r.emitter_exists, r.emit_site_count, r.derived_at, r.derived_from, f.first_fired_at, f.last_fired_at, f.last_fired_by, f.fire_count, r.emitter_exists IS FALSE AND f.fire_count > 0 AS contradicts_scan, r.created_by, r.created_at, r.updated_at, r.payload_schema FROM harness_shared.event_key_registry r LEFT JOIN harness_shared.event_key_fires f ON f.workspace_id = r.workspace_id AND f.event_key = r.event_key`);

export const fleetAssignmentInHarnessShared = harnessShared.view("fleet_assignment", {	source: text(),
	workspaceId: text("workspace_id"),
	agentId: text("agent_id"),
	agentLabel: text("agent_label"),
	agentName: text("agent_name"),
	harnessSlug: text("harness_slug"),
	planSlug: text("plan_slug"),
	itemId: text("item_id"),
	workItemId: text("work_item_id"),
	itemKind: text("item_kind"),
	detail: text(),
	status: text(),
	claimAcquiredTs: timestamp("claim_acquired_ts", { withTimezone: true, mode: 'string' }),
	claimExpiresTs: timestamp("claim_expires_ts", { withTimezone: true, mode: 'string' }),
	claimActive: boolean("claim_active"),
	livenessMode: text("liveness_mode"),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }),
	holderPresent: boolean("holder_present"),
	holderAlive: boolean("holder_alive"),
	holderHeartbeatAt: timestamp("holder_heartbeat_at", { withTimezone: true, mode: 'string' }),
	holderIntent: text("holder_intent"),
	holderPlanSlug: text("holder_plan_slug"),
	orphaned: boolean(),
	declaredPlanMatches: boolean("declared_plan_matches"),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	stalled: boolean(),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
}).as(sql`WITH presence AS ( SELECT coord_presence.owner_id, coord_presence.owner_label, coord_presence.workspace_id, coord_presence.source, coord_presence.intent, coord_presence.current_plan_slug, coord_presence.heartbeat_at, (now() - coord_presence.heartbeat_at) < '00:10:00'::interval AS alive FROM harness_shared.coord_presence ), holder AS ( SELECT presence.owner_id AS alias, presence.owner_label, presence.workspace_id, presence.intent, presence.current_plan_slug, presence.heartbeat_at, presence.alive FROM presence UNION ALL SELECT DISTINCT ON (a.alias) a.alias, 'bee · '::text || "left"(n.spawn_id, 10) AS owner_label, n.workspace_id, NULL::text AS intent, NULL::text AS current_plan_slug, n.heartbeat_at, n.heartbeat_at IS NOT NULL AND (now() - n.heartbeat_at) < '00:10:00'::interval AS alive FROM harness_shared.spawned_agents n CROSS JOIN LATERAL ( VALUES (n.spawn_id), (n.session_owner), (n.run_id)) a(alias) WHERE n.status = 'running'::text AND a.alias IS NOT NULL AND a.alias <> ''::text AND NOT (EXISTS ( SELECT 1 FROM presence p WHERE p.owner_id = a.alias)) ), membership AS ( SELECT DISTINCT ON (fleet_membership_events.workspace_id, fleet_membership_events.owner_id) fleet_membership_events.workspace_id, fleet_membership_events.owner_id, fleet_membership_events.fleet_slug, fleet_membership_events.fleet_role FROM harness_shared.fleet_membership_events ORDER BY fleet_membership_events.workspace_id, fleet_membership_events.owner_id, fleet_membership_events.id DESC ) SELECT 'plan_item_claim'::text AS source, c.workspace_id, c.owner AS agent_id, COALESCE(NULLIF(c.owner_label, ''::text), p.owner_label) AS agent_label, c.owner_name AS agent_name, c.harness_slug, c.plan_slug, c.item_id, NULL::text AS work_item_id, NULL::text AS item_kind, c.intent AS detail, NULL::text AS status, c.acquired_ts AS claim_acquired_ts, c.expires_ts AS claim_expires_ts, c.expires_ts > now() AS claim_active, c.liveness_mode, c.last_activity_ts, p.alias IS NOT NULL AS holder_present, COALESCE(p.alive, false) AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner <> 'improvement-runner'::text AS orphaned, NOT p.current_plan_slug IS DISTINCT FROM c.plan_slug AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.plan_item_claims c LEFT JOIN holder p ON p.alias = c.owner LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, c.workspace_id) AND m.owner_id = c.owner UNION ALL SELECT 'plan_item_assignment'::text AS source, a.workspace_id, a.assignee_name AS agent_id, NULL::text AS agent_label, a.assignee_name AS agent_name, a.harness_slug, a.plan_slug, a.item_id, NULL::text AS work_item_id, NULL::text AS item_kind, COALESCE(a.note, ''::text) AS detail, NULL::text AS status, a.assigned_ts AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, true AS claim_active, NULL::text AS liveness_mode, a.updated_at AS last_activity_ts, false AS holder_present, false AS holder_alive, NULL::timestamp with time zone AS holder_heartbeat_at, NULL::text AS holder_intent, NULL::text AS holder_plan_slug, false AS orphaned, NULL::boolean AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.plan_item_assignments a LEFT JOIN holder p ON p.alias = a.assignee_name LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, a.workspace_id) AND m.owner_id = a.assignee_name WHERE a.assignee_name IS NOT NULL AND a.released_ts IS NULL UNION ALL SELECT 'work_item_claim'::text AS source, w.workspace_id, w.taken_by AS agent_id, p.owner_label AS agent_label, NULL::text AS agent_name, w.harness_slug, w.source_plan_slug AS plan_slug, NULL::text AS item_id, w.feature_id AS work_item_id, w.item_kind, COALESCE(w.title, ''::text) AS detail, w.status, w.taken_at AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, true AS claim_active, NULL::text AS liveness_mode, w.taken_at AS last_activity_ts, p.alias IS NOT NULL AS holder_present, COALESCE(p.alive, false) AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, NOT COALESCE(p.alive, false) AND w.taken_by <> 'improvement-runner'::text AS orphaned, CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean ELSE NOT p.current_plan_slug IS DISTINCT FROM w.source_plan_slug END AS declared_plan_matches, w.assignee_rank, w.rank_writer, w.last_progress_at, COALESCE(p.alive, false) AND w.taken_by <> 'improvement-runner'::text AND (now() - GREATEST(w.last_progress_at, w.taken_at)) > '00:10:00'::interval AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.work_items w LEFT JOIN holder p ON p.alias = w.taken_by LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, w.workspace_id) AND m.owner_id = w.taken_by WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''::text AND (COALESCE(w.status, ''::text) <> ALL (ARRAY['done'::text, 'passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'dropped'::text, 'needs-human'::text, 'blocked'::text])) AND NOT jsonb_exists(COALESCE(w.payload, '{}'::jsonb), 'resource_governor'::text) UNION ALL SELECT 'presence'::text AS source, p.workspace_id, p.owner_id AS agent_id, p.owner_label AS agent_label, NULL::text AS agent_name, NULL::text AS harness_slug, p.current_plan_slug AS plan_slug, NULL::text AS item_id, NULL::text AS work_item_id, NULL::text AS item_kind, p.intent AS detail, NULL::text AS status, NULL::timestamp with time zone AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, NULL::boolean AS claim_active, NULL::text AS liveness_mode, p.heartbeat_at AS last_activity_ts, true AS holder_present, p.alive AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, false AS orphaned, NULL::boolean AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM presence p LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.owner_id = p.owner_id`);

export const harnessFeaturesInHarnessShared = harnessShared.view("harness_features", {	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id"),
	search: tsvectorCustom("_search"),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also"),
	needsDesign: boolean("needs_design"),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work"),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }),
	workedByHistory: jsonb("worked_by_history"),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	wave: text(),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind"),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	swarmAffinity: text("swarm_affinity"),
	redundancy: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count"),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	terminalReason: text("terminal_reason"),
	embeddingProfile: text("embedding_profile"),
}).as(sql`SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason, see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref, created_by_github_user_id, working_users, worked_by_history, verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, wave, feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind, payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, swarm_affinity, redundancy, verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref, last_released_by, last_released_at, embedding, embedding_mode, terminal_reason, embedding_profile FROM harness_shared.harness_features_consolidated`);

export const harnessFeaturesConsolidatedInHarnessShared = harnessShared.view("harness_features_consolidated", {	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id"),
	search: tsvectorCustom("_search"),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also"),
	needsDesign: boolean("needs_design"),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work"),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }),
	workedByHistory: jsonb("worked_by_history"),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	wave: text(),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind"),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	swarmAffinity: text("swarm_affinity"),
	redundancy: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count"),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	terminalReason: text("terminal_reason"),
	authority: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closedTs: bigint("closed_ts", { mode: "number" }),
	admission: text(),
	admittedAt: timestamp("admitted_at", { withTimezone: true, mode: 'string' }),
	admittedBy: text("admitted_by"),
	embeddingProfile: text("embedding_profile"),
}).as(sql`SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason, see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref, created_by_github_user_id, working_users, worked_by_history, verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, wave, feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind, payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, swarm_affinity, redundancy, verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref, last_released_by, last_released_at, embedding, embedding_mode, terminal_reason, authority, closed_ts, admission, admitted_at, admitted_by, embedding_profile FROM harness_shared.work_items WHERE item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])`);

export const hiveEvalBakeoffDeltasInHarnessShared = harnessShared.view("hive_eval_bakeoff_deltas", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	flagKey: text("flag_key"),
	deltaMeanComposite: doublePrecision("delta_mean_composite"),
	deltaGatePassRate: doublePrecision("delta_gate_pass_rate"),
	verdict: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	runAtMs: bigint("run_at_ms", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT id, workspace_id, flag_key, delta_mean_composite, delta_gate_pass_rate, verdict, run_at_ms, created_at FROM harness_shared.pot_eval_bakeoff_deltas`);

export const hiveEvalInstancesInHarnessShared = harnessShared.view("hive_eval_instances", {	instanceId: text("instance_id"),
	workspaceId: text("workspace_id"),
	codeSha: text("code_sha"),
	genomeId: text("genome_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT instance_id, workspace_id, code_sha, genome_id, battery_slice_id, created_at FROM harness_shared.pot_eval_instances`);

export const hiveEvalRunsInHarnessShared = harnessShared.view("hive_eval_runs", {	runId: text("run_id"),
	instanceId: text("instance_id"),
	scenarioId: text("scenario_id"),
	shape: text(),
	repeat: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seed: bigint({ mode: "number" }),
	budgetUsdCap: numeric("budget_usd_cap"),
	beeCap: integer("bee_cap"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	terminalState: text("terminal_state"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }),
	frontierDrained: boolean("frontier_drained"),
	workItemsTotal: integer("work_items_total"),
	workItemsCompleted: integer("work_items_completed"),
	costUsd: numeric("cost_usd"),
	observations: jsonb(),
	traceRef: text("trace_ref"),
}).as(sql`SELECT run_id, instance_id, scenario_id, shape, repeat, seed, budget_usd_cap, cup_cap AS bee_cap, started_at, finished_at, terminal_state, wall_clock_ms, frontier_drained, work_items_total, work_items_completed, cost_usd, observations, trace_ref FROM harness_shared.pot_eval_runs`);

export const hiveEvalScenariosInHarnessShared = harnessShared.view("hive_eval_scenarios", {	scenarioId: text("scenario_id"),
	title: text(),
	shape: text(),
	idealWallClockUnits: numeric("ideal_wall_clock_units"),
	idealBeeCount: integer("ideal_bee_count"),
	totalUnits: numeric("total_units"),
	criticalPath: jsonb("critical_path"),
	workItemCount: integer("work_item_count"),
	plantedBugLocation: text("planted_bug_location"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT scenario_id, title, shape, ideal_wall_clock_units, ideal_cup_count AS ideal_bee_count, total_units, critical_path, work_item_count, planted_bug_location, created_at FROM harness_shared.pot_eval_scenarios`);

export const hiveEvalScoresInHarnessShared = harnessShared.view("hive_eval_scores", {	runId: text("run_id"),
	rubricHash: text("rubric_hash"),
	rubricVersion: text("rubric_version"),
	outcomeGatePassed: boolean("outcome_gate_passed"),
	efficiencyScore: numeric("efficiency_score"),
	speedScore: numeric("speed_score"),
	composite: numeric(),
	judgeComposite: numeric("judge_composite"),
	regressions: boolean(),
	plantedBugCaught: boolean("planted_bug_caught"),
	fabricationDetected: boolean("fabrication_detected"),
	criticalPathRatio: numeric("critical_path_ratio"),
	floorCeiling: numeric("floor_ceiling"),
	detail: jsonb(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT run_id, rubric_hash, rubric_version, outcome_gate_passed, efficiency_score, speed_score, composite, judge_composite, regressions, planted_bug_caught, fabrication_detected, critical_path_ratio, floor_ceiling, detail, scored_at FROM harness_shared.pot_eval_scores`);

export const hiveIntegrationRequestsInHarnessShared = harnessShared.view("hive_integration_requests", {	workspaceId: text("workspace_id"),
	repoKey: text("repo_key"),
	devicePubkey: text("device_pubkey"),
	headSha: text("head_sha"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
	reason: text(),
	state: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratifiedTs: bigint("ratified_ts", { mode: "number" }),
	potSlug: text("pot_slug"),
}).as(sql`SELECT workspace_id, repo_key, device_pubkey, head_sha, author_github_user_id, reason, state, created_ts, ratified_ts, pot_slug FROM harness_shared.pot_integration_requests`);

export const hivePlacementsInHarnessShared = harnessShared.view("hive_placements", {	workspaceId: text("workspace_id"),
	installSlug: text("install_slug"),
	workItemId: text("work_item_id"),
	harnessSlug: text("harness_slug"),
	queenOwnerId: text("queen_owner_id"),
	beeSpawnId: text("bee_spawn_id"),
	beeOwnerId: text("bee_owner_id"),
	status: text(),
	failCount: integer("fail_count"),
	lastDisposition: text("last_disposition"),
	escalationMsgId: text("escalation_msg_id"),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'string' }),
	lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true, mode: 'string' }),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	infraLossCount: integer("infra_loss_count"),
	lastLossSpawnId: text("last_loss_spawn_id"),
}).as(sql`SELECT workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id AS queen_owner_id, cup_spawn_id AS bee_spawn_id, cup_owner_id AS bee_owner_id, status, fail_count, last_disposition, escalation_msg_id, placed_at, last_recovery_at, last_seen_at, updated_at, infra_loss_count, last_loss_spawn_id FROM harness_shared.pot_placements`);

export const hiveThroughputTicksInHarnessShared = harnessShared.view("hive_throughput_ticks", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }),
	frontierDepth: integer("frontier_depth"),
	placements: integer(),
	beesBusy: integer("bees_busy"),
	beesCap: integer("bees_cap"),
	stuckCount: integer("stuck_count"),
	completed: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttcMs: bigint("mttc_ms", { mode: "number" }),
	questionRungs: jsonb("question_rungs"),
	detail: jsonb(),
	potSlug: text("pot_slug"),
}).as(sql`SELECT id, workspace_id, tick_at, frontier_depth, placements, cups_busy AS bees_busy, cups_cap AS bees_cap, stuck_count, completed, mttc_ms, question_rungs, detail, pot_slug FROM harness_shared.pot_throughput_ticks`);

export const hiveWakeInHarnessShared = harnessShared.view("hive_wake", {	workspaceId: text("workspace_id"),
	payload: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }),
}).as(sql`SELECT workspace_id, payload, updated_at FROM harness_shared.pot_wake`);

export const hiveWatchdogFiresInHarnessShared = harnessShared.view("hive_watchdog_fires", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	installSlug: text("install_slug"),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	source: text(),
	reason: text(),
	wakeAt: timestamp("wake_at", { withTimezone: true, mode: 'string' }),
	demand: jsonb(),
}).as(sql`SELECT id, workspace_id, install_slug, fired_at, source, reason, wake_at, demand FROM harness_shared.pot_watchdog_fires`);

export const llmTestMatrixResultsInHarnessShared = harnessShared.view("llm_test_matrix_results", {	matrixGroupId: uuid("matrix_group_id"),
	scenarioId: text("scenario_id"),
	scenarioVersion: integer("scenario_version"),
	identityHash: text("identity_hash"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	nRuns: bigint("n_runs", { mode: "number" }),
	majorityStatus: text("majority_status"),
	stddevByAxis: jsonb("stddev_by_axis"),
}).as(sql`SELECT matrix_group_id, scenario_id, scenario_version, identity_hash, count(*) AS n_runs, mode() WITHIN GROUP (ORDER BY status) AS majority_status, jsonb_object_agg(axis, stddev_score) AS stddev_by_axis FROM ( SELECT r.matrix_group_id, r.scenario_id, r.scenario_version, r.identity_hash, r.status, k.key AS axis, stddev_pop(k.value::numeric) OVER (PARTITION BY r.matrix_group_id, k.key) AS stddev_score FROM harness_shared.llm_test_runs r, LATERAL jsonb_each_text(r.scores_json) k(key, value) WHERE r.matrix_group_id IS NOT NULL AND r.scores_json IS NOT NULL) s GROUP BY matrix_group_id, scenario_id, scenario_version, identity_hash`);

export const mobileDevicesInHarnessShared = harnessShared.view("mobile_devices", {	deviceId: text("device_id"),
	userEmail: text("user_email"),
	workspaceId: text("workspace_id"),
	deviceKind: text("device_kind"),
	deviceLabel: text("device_label"),
	pairedAt: timestamp("paired_at", { withTimezone: true, mode: 'string' }),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}).with({"securityInvoker":true}).as(sql`SELECT id AS device_id, user_email, workspace_id, kind AS device_kind, label AS device_label, paired_at, last_seen, revoked_at FROM harness_shared.connected_apps WHERE kind = 'mobile'::text`);

export const operatorDecisionsInHarnessShared = harnessShared.view("operator_decisions", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspaceId: text("workspace_id"),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor = 'system:operator'::text`);

export const operatorHiveControlPolicyInHarnessShared = harnessShared.view("operator_hive_control_policy", {	workspaceId: text("workspace_id"),
	payload: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }),
}).as(sql`SELECT workspace_id, payload, updated_at FROM harness_shared.operator_pot_control_policy`);

export const sessionIdentityActivationSpansInHarnessShared = harnessShared.view("session_identity_activation_spans", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	activationEventId: bigint("activation_event_id", { mode: "number" }),
	workspaceId: text("workspace_id"),
	ownerId: text("owner_id"),
	actorId: text("actor_id"),
	principalId: text("principal_id"),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	advSessionId: bigint("adv_session_id", { mode: "number" }),
	nativeSessionId: text("native_session_id"),
	transitionId: text("transition_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlGeneration: bigint("control_generation", { mode: "number" }),
	source: text(),
	specificationRevision: text("specification_revision"),
	stateRevision: text("state_revision"),
	stackRefs: jsonb("stack_refs"),
	activeFrom: timestamp("active_from", { withTimezone: true, mode: 'string' }),
	activeUntil: timestamp("active_until", { withTimezone: true, mode: 'string' }),
}).as(sql`WITH applied AS ( SELECT e.id, e.workspace_id, e.owner_id, e.actor_id, e.principal_id, e.session_id, e.adv_session_id, e.native_session_id, e.transition_id, e.control_generation, e.phase, e.source, e.specification_revision, e.state_revision, e.stack_refs, e.failure, e.recorded_at, lead(e.recorded_at) OVER (PARTITION BY e.workspace_id, e.owner_id, e.session_id ORDER BY e.recorded_at, e.id) AS next_applied_at FROM harness_shared.session_identity_activation_events e WHERE e.phase = 'applied'::text ) SELECT a.id AS activation_event_id, a.workspace_id, a.owner_id, a.actor_id, a.principal_id, a.session_id, a.adv_session_id, a.native_session_id, a.transition_id, a.control_generation, a.source, a.specification_revision, a.state_revision, a.stack_refs, a.recorded_at AS active_from, CASE WHEN a.next_applied_at IS NULL THEN s.ended_at WHEN s.ended_at IS NULL THEN a.next_applied_at ELSE LEAST(a.next_applied_at, s.ended_at) END AS active_until FROM applied a LEFT JOIN harness_shared.adv_sessions s ON s.id = a.adv_session_id`);

export const sessionIdentityLayerSpansInHarnessShared = harnessShared.view("session_identity_layer_spans", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	activationEventId: bigint("activation_event_id", { mode: "number" }),
	workspaceId: text("workspace_id"),
	ownerId: text("owner_id"),
	actorId: text("actor_id"),
	principalId: text("principal_id"),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	advSessionId: bigint("adv_session_id", { mode: "number" }),
	nativeSessionId: text("native_session_id"),
	transitionId: text("transition_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	controlGeneration: bigint("control_generation", { mode: "number" }),
	source: text(),
	specificationRevision: text("specification_revision"),
	stateRevision: text("state_revision"),
	layerRef: text("layer_ref"),
	layerSlot: text("layer_slot"),
	layerId: text("layer_id"),
	activeFrom: timestamp("active_from", { withTimezone: true, mode: 'string' }),
	activeUntil: timestamp("active_until", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT s.activation_event_id, s.workspace_id, s.owner_id, s.actor_id, s.principal_id, s.session_id, s.adv_session_id, s.native_session_id, s.transition_id, s.control_generation, s.source, s.specification_revision, s.state_revision, layer.ref AS layer_ref, split_part(layer.ref, ':'::text, 1) AS layer_slot, SUBSTRING(layer.ref FROM POSITION((':'::text) IN (layer.ref)) + 1) AS layer_id, s.active_from, s.active_until FROM harness_shared.session_identity_activation_spans s CROSS JOIN LATERAL jsonb_array_elements_text(s.stack_refs) layer(ref)`);

export const systemPrincipalActivityInHarnessShared = harnessShared.view("system_principal_activity", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspaceId: text("workspace_id"),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor ~~ 'system:%'::text OR actor ~~ 'pi:%'::text`);

export const testingSurfaceDepthInHarnessShared = harnessShared.view("testing_surface_depth", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	kind: text(),
	surfaceId: text("surface_id"),
	sourceFile: text("source_file"),
	provider: text(),
	fidelity: text(),
	firstSeen: timestamp("first_seen", { withTimezone: true, mode: 'string' }),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }),
	retiredAt: timestamp("retired_at", { withTimezone: true, mode: 'string' }),
	meetsL1: boolean("meets_l1"),
	meetsL2: boolean("meets_l2"),
	meetsL3: boolean("meets_l3"),
	meetsL4: boolean("meets_l4"),
	mutationScore: real("mutation_score"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authoredEvidence: bigint("authored_evidence", { mode: "number" }),
	lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true, mode: 'string' }),
	depth: integer(),
	waived: boolean(),
}).as(sql`WITH fresh AS ( SELECT e.id, e.surface_ref, e.evidence_kind, e.verdict, e.generated, e.test_file, e.test_case, e.test_run_id, e.score, e.details, e.observed_at FROM harness_shared.coverage_evidence e WHERE e.observed_at > (now() - '30 days'::interval) ), graded AS ( SELECT s_1.id AS surface_ref, bool_or(f.verdict = 'pass'::text AND (f.evidence_kind = ANY (ARRAY['traffic'::text, 'file-coverage'::text]))) AS meets_l1, bool_or(f.verdict = 'pass'::text AND (f.evidence_kind = ANY (ARRAY['fuzz'::text, 'crawl'::text]))) AS meets_l2, bool_or(f.verdict = 'pass'::text AND f.generated = false AND (f.evidence_kind = ANY (ARRAY['traffic'::text, 'file-coverage'::text]))) AS meets_l3, max(f.score) FILTER (WHERE f.evidence_kind = 'mutation'::text) AS mutation_score, count(*) FILTER (WHERE f.generated = false AND f.verdict = 'pass'::text) AS authored_evidence, max(f.observed_at) AS last_evidence_at FROM harness_shared.testing_surfaces s_1 LEFT JOIN fresh f ON f.surface_ref = s_1.id GROUP BY s_1.id ) SELECT s.id, s.workspace_id, s.harness_slug, s.kind, s.surface_id, s.source_file, s.provider, s.fidelity, s.first_seen, s.last_seen, s.retired_at, COALESCE(g.meets_l1, false) AS meets_l1, COALESCE(g.meets_l2, false) AS meets_l2, COALESCE(g.meets_l3, false) AS meets_l3, g.mutation_score IS NOT NULL AND g.mutation_score >= 0.6::double precision AS meets_l4, g.mutation_score, COALESCE(g.authored_evidence, 0::bigint) AS authored_evidence, g.last_evidence_at, CASE WHEN g.mutation_score IS NOT NULL AND g.mutation_score >= 0.6::double precision THEN 4 WHEN COALESCE(g.meets_l3, false) THEN 3 WHEN COALESCE(g.meets_l2, false) THEN 2 WHEN COALESCE(g.meets_l1, false) THEN 1 ELSE 0 END AS depth, (EXISTS ( SELECT 1 FROM harness_shared.coverage_waivers w WHERE w.surface_ref = s.id AND w.expires_at > now())) AS waived FROM harness_shared.testing_surfaces s LEFT JOIN graded g ON g.surface_ref = s.id`);

export const toolInvocationsArtifactsInHarnessShared = harnessShared.view("tool_invocations_artifacts", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	pluginName: text("plugin_name"),
	toolName: text("tool_name"),
	role: text(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	status: text(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
}).as(sql`SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, invoked_at, duration_ms, status, output_ref, output_size FROM harness_shared.tool_invocations WHERE output_ref IS NOT NULL AND output_ref <> ''::text AND status = 'ok'::text`);

export const toolInvocationsIdentityAttributionInHarnessShared = harnessShared.view("tool_invocations_identity_attribution", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	pluginName: text("plugin_name"),
	toolName: text("tool_name"),
	role: text(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id"),
	parentSpawnId: text("parent_spawn_id"),
	windowKey: text("window_key"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	status: text(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
	errorMessage: text("error_message"),
	argsJson: jsonb("args_json"),
	eventCount: integer("event_count"),
	metadataJson: jsonb("metadata_json"),
	transport: text(),
	principalKind: text("principal_kind"),
	principalAuthMethod: text("principal_auth_method"),
	principalTrust: text("principal_trust"),
	errorCode: text("error_code"),
	coordOwnerId: text("coord_owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	intentEventId: bigint("intent_event_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	assumptionSetId: bigint("assumption_set_id", { mode: "number" }),
	goalRef: text("goal_ref"),
	callOrigin: text("call_origin"),
	callOriginSource: text("call_origin_source"),
	servingHost: text("serving_host"),
	servingProcessId: text("serving_process_id"),
	servingBuildSha: text("serving_build_sha"),
	goalId: text("goal_id"),
	goalActorClass: text("goal_actor_class"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	identityActivationEventId: bigint("identity_activation_event_id", { mode: "number" }),
	identityActorId: text("identity_actor_id"),
	identityPrincipalId: text("identity_principal_id"),
	identitySessionId: text("identity_session_id"),
	identityTransitionId: text("identity_transition_id"),
	identitySpecificationRevision: text("identity_specification_revision"),
	identityStateRevision: text("identity_state_revision"),
	identityStackRefs: jsonb("identity_stack_refs"),
}).as(sql`SELECT t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role, t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id, t.window_key, t.invoked_at, t.duration_ms, t.status, t.output_ref, t.output_size, t.error_message, t.args_json, t.event_count, t.metadata_json, t.transport, t.principal_kind, t.principal_auth_method, t.principal_trust, t.error_code, t.coord_owner_id, t.intent_event_id, t.assumption_set_id, t.goal_ref, t.call_origin, t.call_origin_source, t.serving_host, t.serving_process_id, t.serving_build_sha, t.goal_id, t.goal_actor_class, a.activation_event_id AS identity_activation_event_id, a.actor_id AS identity_actor_id, a.principal_id AS identity_principal_id, a.session_id AS identity_session_id, a.transition_id AS identity_transition_id, a.specification_revision AS identity_specification_revision, a.state_revision AS identity_state_revision, a.stack_refs AS identity_stack_refs FROM harness_shared.tool_invocations t LEFT JOIN LATERAL ( SELECT s.activation_event_id, s.workspace_id, s.owner_id, s.actor_id, s.principal_id, s.session_id, s.adv_session_id, s.native_session_id, s.transition_id, s.control_generation, s.source, s.specification_revision, s.state_revision, s.stack_refs, s.active_from, s.active_until FROM harness_shared.session_identity_activation_spans s WHERE s.workspace_id = t.workspace_id AND s.owner_id = t.coord_owner_id AND t.invoked_at >= s.active_from AND (s.active_until IS NULL OR t.invoked_at < s.active_until) ORDER BY s.active_from DESC, s.activation_event_id DESC LIMIT 1) a ON true`);

export const toolInvocationsSpawnTreeInHarnessShared = harnessShared.view("tool_invocations_spawn_tree", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	pluginName: text("plugin_name"),
	toolName: text("tool_name"),
	role: text(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id"),
	parentSpawnId: text("parent_spawn_id"),
	windowKey: text("window_key"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	status: text(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
	errorMessage: text("error_message"),
	depth: integer(),
	rootSpawnId: text("root_spawn_id"),
}).as(sql`WITH RECURSIVE chain AS ( SELECT tool_invocations.id, tool_invocations.workspace_id, tool_invocations.harness_slug, tool_invocations.plugin_name, tool_invocations.tool_name, tool_invocations.role, tool_invocations.feature_id, tool_invocations.chunk_id, tool_invocations.run_id, tool_invocations.spawn_id, tool_invocations.parent_spawn_id, tool_invocations.window_key, tool_invocations.invoked_at, tool_invocations.duration_ms, tool_invocations.status, tool_invocations.output_ref, tool_invocations.output_size, tool_invocations.error_message, 0 AS depth, tool_invocations.spawn_id AS root_spawn_id FROM harness_shared.tool_invocations WHERE tool_invocations.parent_spawn_id IS NULL OR tool_invocations.parent_spawn_id = ''::text UNION ALL SELECT t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role, t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id, t.window_key, t.invoked_at, t.duration_ms, t.status, t.output_ref, t.output_size, t.error_message, c.depth + 1, c.root_spawn_id FROM harness_shared.tool_invocations t JOIN chain c ON t.parent_spawn_id = c.spawn_id AND t.workspace_id = c.workspace_id AND c.depth < 16 ) SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, parent_spawn_id, window_key, invoked_at, duration_ms, status, output_ref, output_size, error_message, depth, root_spawn_id FROM chain`);

export const triageBurndownInHarnessShared = harnessShared.view("triage_burndown", {	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	cause: text(),
	origin: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	items: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	withEvidence: bigint("with_evidence", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	withoutEvidence: bigint("without_evidence", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closed24H: bigint("closed_24h", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closed7D: bigint("closed_7d", { mode: "number" }),
}).as(sql`SELECT workspace_id, harness_slug, CASE WHEN closed_by_triage THEN 'triage'::text ELSE 'background'::text END AS cause, origin, count(*) AS items, count(*) FILTER (WHERE has_completion_evidence) AS with_evidence, count(*) FILTER (WHERE NOT has_completion_evidence) AS without_evidence, count(*) FILTER (WHERE closed_at > (now() - '24:00:00'::interval)) AS closed_24h, count(*) FILTER (WHERE closed_at > (now() - '7 days'::interval)) AS closed_7d FROM harness_shared.triage_routed_items WHERE NOT non_terminal AND non_observation GROUP BY workspace_id, harness_slug, ( CASE WHEN closed_by_triage THEN 'triage'::text ELSE 'background'::text END), origin`);

export const triageRoutedItemsInHarnessShared = harnessShared.view("triage_routed_items", {	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	origin: text(),
	actionable: boolean(),
	status: text(),
	nonTerminal: boolean("non_terminal"),
	nonObservation: boolean("non_observation"),
	lens: text(),
	routedMonth: date("routed_month"),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	terminalCompletionRef: text("terminal_completion_ref"),
	hasCompletionEvidence: boolean("has_completion_evidence"),
	closedByTriage: boolean("closed_by_triage"),
}).as(sql`WITH first_routing AS ( SELECT DISTINCT ON (scout_routed_ideas.workspace_id, (split_part(scout_routed_ideas.routed_ref, ':'::text, 2))) scout_routed_ideas.workspace_id AS routed_workspace_id, split_part(scout_routed_ideas.routed_ref, ':'::text, 2) AS fid, scout_routed_ideas.lens, to_timestamp((scout_routed_ideas.routed_at::numeric / 1000.0)::double precision) AS routed_at FROM harness_shared.scout_routed_ideas WHERE scout_routed_ideas.routed_ref ~~ 'wi:%'::text ORDER BY scout_routed_ideas.workspace_id, (split_part(scout_routed_ideas.routed_ref, ':'::text, 2)), (to_timestamp((scout_routed_ideas.routed_at::numeric / 1000.0)::double precision)) ) SELECT w.workspace_id, w.harness_slug, w.feature_id, w.origin, w.origin = 'local'::text AS actionable, w.status, w.status <> ALL (ARRAY['done'::text, 'resolved'::text, 'passed'::text, 'closed'::text, 'deprecated'::text, 'dropped'::text]) AS non_terminal, w.lane IS NULL OR w.lane <> 'observation'::text AS non_observation, fr.lens, date_trunc('month'::text, fr.routed_at)::date AS routed_month, to_timestamp((w.closed_ts::numeric / 1000.0)::double precision) AS closed_at, w.terminal_completion_ref, w.terminal_completion_ref IS NOT NULL OR w.payload ? '_completionEvidence'::text AS has_completion_evidence, w.terminal_completion_ref ~~ 'P-008-MERGE%'::text AS closed_by_triage FROM harness_shared.work_items w JOIN first_routing fr ON fr.fid = w.feature_id AND fr.routed_workspace_id = w.workspace_id`);

export const workItemsClaimableInHarnessShared = harnessShared.view("work_items_claimable", {	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id"),
	search: tsvectorCustom("_search"),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also"),
	needsDesign: boolean("needs_design"),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work"),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }),
	workedByHistory: jsonb("worked_by_history"),
	wave: text(),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind"),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	redundancy: integer(),
	swarmAffinity: text("swarm_affinity"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count"),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
	embedding: vector({ dimensions: 768 }),
	embeddingMode: text("embedding_mode"),
	terminalReason: text("terminal_reason"),
	authority: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	closedTs: bigint("closed_ts", { mode: "number" }),
	lane: text(),
	conditionKey: text("condition_key"),
	embeddingRecipe: smallint("embedding_recipe"),
	stateChangedAt: timestamp("state_changed_at", { withTimezone: true, mode: 'string' }),
	admission: text(),
	admittedAt: timestamp("admitted_at", { withTimezone: true, mode: 'string' }),
	admittedBy: text("admitted_by"),
	firstClaimedAt: timestamp("first_claimed_at", { withTimezone: true, mode: 'string' }),
	embeddingProfile: text("embedding_profile"),
}).as(sql`SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason, see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref, created_by_github_user_id, working_users, worked_by_history, wave, verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind, payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, redundancy, swarm_affinity, verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref, last_released_by, last_released_at, embedding, embedding_mode, terminal_reason, authority, closed_ts, lane, condition_key, embedding_recipe, state_changed_at, admission, admitted_at, admitted_by, first_claimed_at, embedding_profile FROM harness_shared.work_items wi WHERE (item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])) AND status = 'open'::text AND (COALESCE(payload, '{}'::jsonb) ->> 'lane'::text) IS DISTINCT FROM 'observation'::text AND (COALESCE(payload, '{}'::jsonb) ->> 'needsOwnerAction'::text) IS DISTINCT FROM 'true'::text AND cardinality(harness_shared.work_item_claim_floors(workspace_id, status, taken_by, origin, title, terminal_owner, terminal_completion_ref, payload, feature_id)) = 0`);
