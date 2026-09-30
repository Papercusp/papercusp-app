/**
 * Drizzle Postgres schema for the Papercusp framework's storage system.
 *
 * Layout (database = `papercusp`, will rename to `papercusp` in a later stage):
 *   harness_shared           ← framework cross-cutting tables
 *     ├── audit_log
 *     ├── projects
 *     ├── all_features         (view: UNION ALL of every harness_<slug>.harness_features)
 *     └── all_feature_audit    (view: UNION ALL of every harness_<slug>.feature_audit)
 *   harness_<slug>           ← one schema per harness (`-` → `_` in slug)
 *     ├── harness_features
 *     └── feature_audit
 *   papercusp_shared          ← Papercup-demo-specific (cross-dept message bus)
 *     ├── messages
 *     ├── message_recipients
 *     ├── message_comments
 *     └── directive_summaries
 *
 * The Papercup-specific tables moved out of harness_shared in Stage 2 of the
 * Papercusp/Papercup split. Drizzle definitions for them live in
 * @papercusp/papercusp-db. Connection clients in ./connection.ts include
 * papercusp_shared in their search_path for compatibility.
 *
 * See libs/db-org/sql/001-shared.sql, 002-per-harness-template.sql, and
 * 003-papercusp-shared.sql for DDL.
 *
 * For per-harness tables, use the schema factory `harnessTables(slug)` —
 * Drizzle's pgSchema only accepts a literal-known schema name, so we call
 * pgSchema(...) at runtime with the harness's bound name.
 */
import { pgSchema, text, bigint, boolean, jsonb, primaryKey, index, timestamp, integer } from 'drizzle-orm/pg-core';

export const harnessShared = pgSchema('harness_shared');

export const auditLog = harnessShared.table('audit_log', {
  id: text('id').primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  actor: text('actor').notNull().default('user'),
  action: text('action').notNull(),
  subject: text('subject').notNull(),
  details: jsonb('details'),
}, (t) => ({
  tsIdx: index('audit_ts_idx').on(t.ts),
  actionIdx: index('audit_action_idx').on(t.action),
  subjectIdx: index('audit_subject_idx').on(t.subject),
}));

// ─── Re-exports from @papercusp/papercusp-db (back-compat) ──────────────
// Existing code that imports `messages`, `messageRecipients`, etc. from
// @papercusp/db-org continues to work. New code should import directly from
// @papercusp/papercusp-db. This shim removes when we cut the v2 release.
export {
  messages,
  messageRecipients,
  messageComments,
  directiveSummaries,
} from '@papercusp/papercusp-db';
export type {
  MessageRow,
  MessageInsert,
  MessageRecipientRow,
  MessageCommentRow,
  DirectiveSummaryRow,
} from '@papercusp/papercusp-db';

export const projects = harnessShared.table('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  budgetCents: bigint('budget_cents', { mode: 'number' }),
  spentCents: bigint('spent_cents', { mode: 'number' }).notNull().default(0),
  owningDept: text('owning_dept'),
  vertical: text('vertical'),
  createdTs: bigint('created_ts', { mode: 'number' }).notNull(),
  updatedTs: bigint('updated_ts', { mode: 'number' }).notNull(),
  metadata: jsonb('metadata'),
}, (t) => ({
  statusIdx: index('projects_status_idx').on(t.status),
}));

// ─── Goals ────────────────────────────────────────────────────────────
// Top-level missions. Tasks (harness_features) trace back to a goal via
// the goal_id column. Goals can themselves nest (parent_id is a tree).
export const goals = harnessShared.table('goals', {
  id: text('id').primaryKey(),
  installSlug: text('install_slug').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  parentId: text('parent_id'),
  budgetCents: bigint('budget_cents', { mode: 'number' }),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (t) => ({
  installIdx: index('goals_install_idx').on(t.installSlug),
  parentIdx: index('goals_parent_idx').on(t.parentId),
  statusIdx: index('goals_status_idx').on(t.status),
}));

// ─── Pending events queue ─────────────────────────────────────────────
// The orchestrator reads this on every tick, alongside features/issues.
// Entries arrive from: cron routines, webhook handlers, API triggers,
// completion-delta hooks. The orchestrator decides whether to dispatch
// each event's target_role on the current tick or defer.
export const pendingEvents = harnessShared.table('pending_events', {
  id: text('id').primaryKey(),
  installSlug: text('install_slug').notNull(),
  kind: text('kind').notNull(),                 // 'routine' | 'webhook' | 'api' | 'completion'
  targetRole: text('target_role').notNull(),
  payload: jsonb('payload'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedBy: text('consumed_by'),
  sourceId: text('source_id'),                  // e.g. routine.id when kind='routine'
}, (t) => ({
  unconsumedIdx: index('pending_events_unconsumed_idx').on(t.installSlug, t.dueAt),
  sourceIdx: index('pending_events_source_idx').on(t.sourceId),
}));

// ─── Routines ─────────────────────────────────────────────────────────
// Scheduled or triggered event sources. The substrate's "routine ticker"
// evaluates active cron routines every ~30s and inserts pending_events;
// webhook/api routines insert on receipt.
export const routines = harnessShared.table('routines', {
  id: text('id').primaryKey(),
  installSlug: text('install_slug').notNull(),
  name: text('name').notNull(),
  triggerKind: text('trigger_kind').notNull(),  // 'cron' | 'webhook' | 'api'
  triggerConfig: jsonb('trigger_config').notNull(),
  targetRole: text('target_role').notNull(),
  payloadTemplate: jsonb('payload_template'),
  concurrency: text('concurrency').notNull().default('queue'),    // 'queue' | 'skip' | 'cancel-prev'
  catchup: text('catchup').notNull().default('skip-old'),          // 'skip-old' | 'run-all-backlog'
  active: boolean('active').notNull().default(true),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
  // loop-routines-interval-recurrence-2026-06-20 P-001 (migration 323): the LOOP
  // recurrence kind — re-fire N sec after the turn completes, waking a pinned coord owner.
  rescheduleIntervalSec: integer('reschedule_interval_sec'),
  targetOwnerId: text('target_owner_id'),
}, (t) => ({
  activeDueIdx: index('routines_active_due_idx').on(t.active, t.nextFireAt),
  installIdx: index('routines_install_idx').on(t.installSlug),
  loopIntervalIdx: index('routines_loop_interval_idx').on(t.rescheduleIntervalSec),
}));

/**
 * Per-harness table factory. Call with `harnessTables('org')` to get
 * `{ harnessFeatures, featureAudit }` bound to schema `harness_org`.
 *
 * Slug normalisation: lowercase + dashes → underscores.
 */
export function slugToSchemaName(slug: string): string {
  return `harness_${slug.toLowerCase().replace(/-/g, '_')}`;
}

export function harnessTables(slug: string) {
  const schemaName = slugToSchemaName(slug);
  const ns = pgSchema(schemaName);

  const harnessFeatures = ns.table('harness_features', {
    harnessSlug: text('harness_slug').notNull(),
    featureId: text('feature_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    status: text('status').notNull(),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    claims: text('claims'),
    notes: text('notes'),
    metadata: jsonb('metadata'),
    kind: text('kind'),
    projectId: text('project_id'),
    expectedCostCents: bigint('expected_cost_cents', { mode: 'number' }),
    tags: jsonb('tags'),
    needsHumanReview: boolean('needs_human_review').notNull().default(false),
    ts: bigint('ts', { mode: 'number' }),
    createdTs: bigint('created_ts', { mode: 'number' }).notNull(),
    updatedTs: bigint('updated_ts', { mode: 'number' }).notNull(),
    // Goal-ancestry: parent feature + top-level goal.
    parentId: text('parent_id'),
    goalId: text('goal_id'),
    // Atomic checkout (FOR UPDATE SKIP LOCKED).
    takenBy: text('taken_by'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  }, (t) => ({
    pk: primaryKey({ columns: [t.harnessSlug, t.featureId] }),
    statusIdx: index('hf_status_idx').on(t.harnessSlug, t.status),
    projectIdx: index('hf_project_idx').on(t.projectId),
    needsReviewIdx: index('hf_review_idx').on(t.needsHumanReview),
    goalIdx: index('hf_goal_idx').on(t.goalId),
    parentIdx: index('hf_parent_idx').on(t.harnessSlug, t.parentId),
  }));

  const featureAudit = ns.table('feature_audit', {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    harnessSlug: text('harness_slug').notNull(),
    featureId: text('feature_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    actor: text('actor'),
  }, (t) => ({
    tsIdx: index('fa_ts_idx').on(t.ts),
    featureIdx: index('fa_feature_idx').on(t.harnessSlug, t.featureId),
  }));

  return { schemaName, harnessFeatures, featureAudit };
}

// Inferred types use `org` as a representative shape — all per-harness
// schemas share the same column set, so a single type alias is correct.
const _shape = harnessTables('org');
export type HarnessFeatureRow = typeof _shape.harnessFeatures.$inferSelect;
export type HarnessFeatureInsert = typeof _shape.harnessFeatures.$inferInsert;
export type FeatureAuditRow = typeof _shape.featureAudit.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type GoalInsert = typeof goals.$inferInsert;
export type PendingEventRow = typeof pendingEvents.$inferSelect;
export type PendingEventInsert = typeof pendingEvents.$inferInsert;
export type RoutineRow = typeof routines.$inferSelect;
export type RoutineInsert = typeof routines.$inferInsert;

// ─── Introspected schema (Phase 0/1 of Drizzle migration) ───────────
// `generated` is the canonical Drizzle definition of all 125 tables
// in `harness_shared` + `papercusp_shared`, derived from the live DB
// via `drizzle-kit pull`. Re-run via `scripts/pull-schema.mjs` after
// any new `.sql` migration. The hand-written tables above (auditLog,
// projects, goals, pendingEvents, routines) duplicate 5 of these for
// back-compat with the type aliases — new code should import from
// `generated` directly:
//   import { generated } from '@papercusp/db-org';
//   await db.select().from(generated.projectsInHarness_shared);
//
// `generatedRelations` exposes the FK graph for drizzle's `db.query.*`
// relational API.
//
// See libs/db/PHASE0-AUDIT.md for naming convention + drizzle-kit
// v0.31.10 quirks (timestamptz mode, tsvector handling).
export * as generated from './generated';
export * as generatedRelations from './generated-relations';
