/**
 * @papercusp/papercusp-db — Papercup-specific Drizzle schemas.
 *
 * The Papercup demo (5-department fictional org with cross-dept message bus)
 * extends the Papercusp framework with its own Postgres tables. These tables
 * live in the `papercusp_shared` Postgres schema, separate from the framework's
 * `harness_shared` schema (which holds projects, audit_log, and the per-harness
 * UNION views).
 *
 * Connection happens via the framework's clients in @papercusp/db-org —
 * those clients have `papercusp_shared` in their search_path so unqualified
 * references resolve correctly. Code that wants Drizzle ORM access to the
 * Papercup tables imports them from this module.
 *
 * DDL: see ../db-org/sql/003-papercusp-shared.sql for the canonical CREATE TABLEs.
 */
import { pgSchema, text, bigint, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';

export const papercupShared = pgSchema('papercusp_shared');

export const messages = papercupShared.table('messages', {
  id: text('id').primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  fromDept: text('from_dept').notNull(),
  kind: text('kind').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  refId: text('ref_id'),
  projectId: text('project_id'),
  directiveId: text('directive_id'),
  status: text('status').notNull().default('pending'),
  metadata: jsonb('metadata'),
}, (t) => ({
  tsIdx: index('messages_ts_idx').on(t.ts),
  kindIdx: index('messages_kind_idx').on(t.kind),
  fromIdx: index('messages_from_idx').on(t.fromDept),
  statusIdx: index('messages_status_idx').on(t.status),
  projectIdx: index('messages_project_idx').on(t.projectId),
  directiveIdx: index('messages_directive_idx').on(t.directiveId),
}));

export const messageRecipients = papercupShared.table('message_recipients', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  deptSlug: text('dept_slug').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.deptSlug] }),
  deptIdx: index('recipients_dept_idx').on(t.deptSlug),
}));

export const messageComments = papercupShared.table('message_comments', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  author: text('author').notNull(),
  body: text('body').notNull(),
}, (t) => ({
  msgIdx: index('comments_msg_idx').on(t.messageId),
  tsIdx: index('comments_ts_idx').on(t.ts),
}));

export const directiveSummaries = papercupShared.table('directive_summaries', {
  id: text('id').primaryKey(),
  directiveId: text('directive_id').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  author: text('author').notNull().default('ceo'),
  body: text('body').notNull(),
}, (t) => ({
  directiveIdx: index('summaries_directive_idx').on(t.directiveId),
  tsIdx: index('summaries_ts_idx').on(t.ts),
}));

export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
export type MessageRecipientRow = typeof messageRecipients.$inferSelect;
export type MessageCommentRow = typeof messageComments.$inferSelect;
export type DirectiveSummaryRow = typeof directiveSummaries.$inferSelect;
