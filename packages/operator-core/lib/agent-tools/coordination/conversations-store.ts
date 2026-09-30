/**
 * conversations-store.ts — the PG store for `coord_conversations` (migration
 * 132), the conversation/question domain object's OWN scalars. Mirrors the
 * @papercusp/coordination capability-store shape (getSql / ensureSchema /
 * workspaceId) so it composes with PgThreadStore / PgTaggableStore /
 * PgEntitySubscriptionStore over the same handle + workspace.
 *
 * The conversation rides the substrate for everything shared (thread, tags,
 * subscriptions); this store is ONLY the conversation row (kind, asker, seed
 * text, Lifecycle state, the accepted answer). Lifecycle is interface-only in
 * the substrate — the `state` column here is that scalar.
 *
 * `ensureConversationsTable` mirrors migration 132 so the package's own vitest
 * rig can stand the schema up standalone; the operator passes a no-op
 * ensureSchema (schema is migrations-only — repo storage policy).
 */

import type { Sql, TransactionSql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { LifecycleState } from '@papercusp/coordination/capabilities';

export type ConversationKind = 'question' | 'discussion' | 'consult';
export type ConversationScope = 'operator' | 'harness';
// Canonical lifecycle vocabulary (P-007) plus the conversation-specific terminal
// state used when an ask is retracted in favor of a replacement. The substrate's
// generic LifecycleState intentionally stays unchanged; only conversations have
// these extra states because a retracted question or an expired consult must be
// visible as such rather than looking like an unresolved gate.
export type ConversationState = LifecycleState | 'superseded' | 'expired';

type QuerySql = Sql | TransactionSql;

export const CONVERSATION_KINDS: readonly ConversationKind[] = ['question', 'discussion', 'consult'];

/**
 * The tool that opened a conversation (EI-21462599108204160).
 *
 * This is DECLARED by each caller, never inferred. It has to be: the only
 * previous record of which tool asked was the Decision-tier escalation twin
 * `coord:ask-owner` writes, and `resolveConversation` closes that twin when the
 * question is answered — so attribution was destroyed by the act of answering,
 * and the answer rate per tool was the one number this table could not produce.
 *
 * A UNION rather than free text so a typo is a compile error and the values
 * stay enumerable for the group-by this exists to serve. Names are the
 * USER-FACING tool names: note the coord-op internally registered as
 * `coord:ask` is exposed as the agent tool `coord:ask-owner`, and is distinct
 * from the owner-UI-only `coord:ask` backend in tools/ask.ts.
 */
export type ConversationProducer =
  | 'coord:ask-owner'
  | 'coord:ask'
  | 'coord:message-agent'
  | 'coord:thread-open'
  | 'conversations:post'
  | 'conversations:supersede'
  | 'consult:get_feedback'
  | 'scout:goal-consult'
  | 'cross-hive-boundary'
  /** The acceptance gate's grading cascade — a real consult thread whose
   * responders are graders (unified-responder-selection-critique-and-grading-
   * 2026-08-30 D-003/D-005). Distinct from 'consult:get_feedback' so a grading
   * thread is attributable at a glance; the ROW is deliberately the same shape,
   * because that is what lets the shared cascade advance it. */
  | 'acceptance-gate:grading-cascade'
  | 'test';

const CONVERSATION_PRODUCERS: ReadonlySet<string> = new Set<ConversationProducer>([
  'coord:ask-owner',
  'coord:ask',
  'coord:message-agent',
  'coord:thread-open',
  'conversations:post',
  'conversations:supersede',
  'consult:get_feedback',
  'scout:goal-consult',
  'acceptance-gate:grading-cascade',
  'cross-hive-boundary',
  'test',
]);

/** Narrow a stored/federated `producer` back to the union. A row written by an
 *  older peer (or before this column existed) carries NULL or a name this build
 *  does not know — both are legitimately "unattributed", never a crash. */
export function isConversationProducer(v: unknown): v is ConversationProducer {
  return typeof v === 'string' && CONVERSATION_PRODUCERS.has(v);
}

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug: string | null;
  asker_id: string;
  title: string | null;
  body: string;
  state: ConversationState;
  accepted_answer: string | null;
  accepted_post_id: number | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  /** The tool that opened this conversation. NULL for rows written before
   *  attribution existed, or federated from a peer running older code — the
   *  open path requires it, so a live writer cannot leave it unset. */
  producer: string | null;
  /** Validated lane provenance; NULL is intentional for legacy/unscoped rows. */
  plan_slug?: string | null;
  work_item_id?: string | null;
  /** The replacement conversation when this ask was retracted. */
  superseded_by: string | null;
  /** ISO-8601. */
  created_ts: string;
  updated_ts: string;
  resolved_ts: string | null;
  superseded_ts: string | null;
}

export interface CreateConversationInput {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug?: string | null;
  asker_id: string;
  title?: string | null;
  body: string;
  /** REQUIRED, and deliberately not defaulted: every caller already knows which
   *  tool it is, and a default here is what would silently re-open the
   *  attribution gap this column closes (EI-21462599108204160). */
  producer: ConversationProducer;
  /** Internal, validated lane provenance; never a public tool argument. */
  plan_slug?: string | null;
  work_item_id?: string | null;
  /** ISO-8601 create time (host clock). */
  created_ts: string;
}

export interface ListConversationsOpts {
  kind?: ConversationKind;
  scope?: ConversationScope;
  harness_slug?: string;
  state?: ConversationState;
  limit?: number;
  /** WI-5807 (P-007): only conversations with ZERO replies — the "nobody has
   *  answered this yet" set. Derived from the Threadable timeline, NOT a
   *  denormalized column on the conversation: a LEFT JOIN on coord_threads
   *  (parent_kind='conversation', parent_ref = the BARE conversation id) with
   *  COALESCE(post_count,0)=0, so a conversation that never grew a thread row
   *  counts as unanswered rather than dropping out of the result. The opening
   *  body is a conversation column (not a post), so post_count 0 really does
   *  mean "no reply", not "no content". */
  unansweredOnly?: boolean;
  /** WI-5807 (P-007): widen `harness_slug` from `= X` to `(= X OR IS NULL)`.
   *  MEASURED reason (2026-07-25): of the 39 open+unanswered questions in this
   *  workspace, 32 are scope='operator' with harness_slug NULL and only 6 carry
   *  a harness — so a strict harness filter hides ~85% of the very set a
   *  harness-scoped agent should be able to answer. Ignored when no
   *  `harness_slug` is given (nothing to widen). */
  includeUnscoped?: boolean;
}

export interface ConversationStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => QuerySql;
  /** Ensure coord_conversations exists before first use (no-op in the operator;
   *  ensureConversationsTable on the package test rig). */
  ensureSchema: () => Promise<void>;
  /** Coordination scope (parity with the capability stores). Default 'default'. */
  workspaceId?: string;
  /** Per-CALL workspace resolution (EI-1534). When provided AND non-empty,
   *  OVERRIDES `workspaceId` on every query; the singleton operator store passes
   *  this so each read/write scopes to the request's workspace instead of being
   *  pinned to 'default' for the process life. Falls back to `workspaceId` /
   *  'default'. Mirrors PgCapabilityStoreOptions.getWorkspaceId. */
  getWorkspaceId?: () => string;
}

function tsToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v as string).toISOString();
}
function tsToIsoOrNull(v: unknown): string | null {
  return v == null ? null : tsToIso(v);
}

interface ConversationRowDb {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug: string | null;
  asker_id: string;
  title: string | null;
  body: string;
  state: ConversationState;
  accepted_answer: string | null;
  accepted_post_id: string | number | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  producer: string | null;
  plan_slug: string | null;
  work_item_id: string | null;
  superseded_by: string | null;
  created_at: unknown;
  updated_at: unknown;
  resolved_at: unknown;
  superseded_at: unknown;
}

function toRow(r: ConversationRowDb): ConversationRow {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    harness_slug: r.harness_slug,
    asker_id: r.asker_id,
    title: r.title,
    body: r.body,
    state: r.state,
    accepted_answer: r.accepted_answer,
    accepted_post_id: r.accepted_post_id == null ? null : Number(r.accepted_post_id),
    capture_target: r.capture_target,
    promoted_issue_id: r.promoted_issue_id,
    producer: r.producer,
    plan_slug: r.plan_slug,
    work_item_id: r.work_item_id,
    superseded_by: r.superseded_by,
    created_ts: tsToIso(r.created_at),
    updated_ts: tsToIso(r.updated_at),
    resolved_ts: tsToIsoOrNull(r.resolved_at),
    superseded_ts: tsToIsoOrNull(r.superseded_at),
  };
}

const SELECT_COLS = `id, kind, scope, harness_slug, asker_id, title, body, state,
  accepted_answer, accepted_post_id, capture_target, promoted_issue_id, producer, plan_slug, work_item_id, superseded_by,
  created_at, updated_at, resolved_at, superseded_at`;

export interface SupersedeStoreResult {
  conversation: ConversationRow;
  replacement: ConversationRow;
}

export type ReopenResolvedConversationResult = 'reopened' | 'not_found' | 'already_open' | 'source_changed';

export type SupersedeStoreError = { error: 'not_found' } | { error: 'not_open'; conversation: ConversationRow };

/** The same column list QUALIFIED to the `c` alias, for the list query's LEFT JOIN
 *  against coord_threads. Required, not cosmetic: coord_threads also has `title`,
 *  `created_at` and `workspace_id`, so an unqualified list would be an ambiguous
 *  -column error the moment the join is present. Derived from SELECT_COLS (split on
 *  the comma, then trim — the constant is multi-line, so splitting on ', ' would
 *  silently leave the post-newline columns unqualified). */
const SELECT_COLS_C = SELECT_COLS.split(',')
  .map((c) => `c.${c.trim()}`)
  .join(', ');

export class PgConversationStore {
  constructor(private readonly opts: ConversationStoreOptions) {}
  /** Dynamic scope: the per-call getWorkspaceId thunk wins, else the
   *  construction-time workspaceId, else 'default'. A GETTER (not a field) so
   *  `${this.ws}` re-resolves on every query — the EI-1534 fix: the singleton
   *  operator store must not pin to 'default' for life. Mirrors the capability
   *  stores' seam (pg-stores.ts). */
  private get ws(): string {
    return this.opts.getWorkspaceId?.()?.trim() || (this.opts.workspaceId ?? DEFAULT_COORD_WORKSPACE);
  }

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, producer, plan_slug, work_item_id, created_at, updated_at)
      VALUES (${this.ws}, ${input.id}, ${input.kind}, ${input.scope}, ${input.harness_slug ?? null},
              ${input.asker_id}, ${input.title ?? null}, ${input.body}, ${input.producer},
              ${input.plan_slug ?? null}, ${input.work_item_id ?? null}, ${input.created_ts}, ${input.created_ts})
      ON CONFLICT (workspace_id, id) DO NOTHING`;
    const row = await this.get(input.id);
    if (!row) throw new Error(`coord_conversations: failed to read back conversation ${input.id}`);
    return row;
  }

  async get(id: string): Promise<ConversationRow | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<ConversationRowDb[]>`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * EI-21914051456641891: ids are minted as `<prefix>-<newMsgId()>`, and
   * `newMsgId()` itself has 3 hyphen-delimited segments (ms-timestamp / seq /
   * uuid-hex) — so a *published* conversation id (in a plan `## Now`, a
   * rubric methodRef, a coord message) commonly gets HAND-TRUNCATED to just
   * the leading `<prefix>-<ms>` segment, which LOOKS like a complete opaque
   * token on its own (8 alnum chars reads exactly like a short id). `get()`
   * above does an exact match, so that truncated form returns a clean,
   * confident `null` — indistinguishable from genuine absence.
   *
   * This is the fallback ONLY: callers try `get(id)` first, and reach for
   * this on an exact-match MISS. Bounded (LIMIT) and workspace-scoped (the
   * PK's leading column), so a rare miss-path prefix scan stays cheap even
   * without a pattern-ops index. Ambiguity (>1 match) is the caller's to
   * handle explicitly — this never guesses.
   */
  async getByPrefix(prefix: string, limit = 5): Promise<ConversationRow[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Ids never legitimately contain LIKE metacharacters (base36 + hex +
    // hyphens only) — escape defensively so a stray `%`/`_`/`\` in a
    // hand-typed/garbage input can't widen the match beyond a true prefix.
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await sql<ConversationRowDb[]>`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${this.ws} AND id LIKE ${escaped + '%'} ESCAPE '\\'
       LIMIT ${limit}`;
    return rows.map(toRow);
  }

  async list(opts: ListConversationsOpts = {}): Promise<ConversationRow[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await sql<ConversationRowDb[]>`
      SELECT ${sql.unsafe(SELECT_COLS_C)}
        FROM harness_shared.coord_conversations c
        LEFT JOIN harness_shared.coord_threads t
               ON t.workspace_id = c.workspace_id
              AND t.parent_kind = 'conversation'
              AND t.parent_ref = c.id
       WHERE c.workspace_id = ${this.ws}
         AND ${opts.kind ? sql`c.kind = ${opts.kind}` : sql`TRUE`}
         AND ${opts.scope ? sql`c.scope = ${opts.scope}` : sql`TRUE`}
         AND ${
           opts.harness_slug
             ? opts.includeUnscoped
               ? sql`(c.harness_slug = ${opts.harness_slug} OR c.harness_slug IS NULL)`
               : sql`c.harness_slug = ${opts.harness_slug}`
             : sql`TRUE`
         }
         AND ${opts.state ? sql`c.state = ${opts.state}` : sql`TRUE`}
         AND ${opts.unansweredOnly ? sql`COALESCE(t.post_count, 0) = 0` : sql`TRUE`}
       ORDER BY c.created_at DESC
       LIMIT ${limit}`;
    return rows.map(toRow);
  }

  /** Update the Lifecycle state (and resolved_at when resolving). */
  async setState(
    id: string,
    state: ConversationState,
    opts: { now_ts: string } = { now_ts: new Date().toISOString() },
  ): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET state = ${state},
             updated_at = ${opts.now_ts},
             resolved_at = ${state === 'resolved' ? opts.now_ts : null},
             superseded_by = CASE WHEN ${state} = 'superseded' THEN superseded_by ELSE NULL END,
             superseded_at = CASE WHEN ${state} = 'superseded' THEN superseded_at ELSE NULL END
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /**
   * Atomically retire an open conversation and insert its replacement. The
   * replacement row is the durable gate; thread/tags/subscriptions are
   * materialized by the workflow immediately after this row transaction.
   * Locking the old row prevents two agents from superseding the same gate and
   * leaving multiple live replacements.
   */
  async supersede(
    id: string,
    replacement: CreateConversationInput,
    opts: { now_ts: string },
  ): Promise<SupersedeStoreResult | SupersedeStoreError> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const supersedeInTransaction = async (tx: TransactionSql): Promise<SupersedeStoreResult | SupersedeStoreError> => {
      const oldRows = await tx<ConversationRowDb[]>`
        SELECT ${tx.unsafe(SELECT_COLS)}
          FROM harness_shared.coord_conversations
         WHERE workspace_id = ${this.ws} AND id = ${id}
         FOR UPDATE`;
      const old = oldRows[0];
      if (!old) return { error: 'not_found' as const };
      if (old.state !== 'open') return { error: 'not_open' as const, conversation: toRow(old) };

      await tx`
        INSERT INTO harness_shared.coord_conversations
          (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, producer, plan_slug, work_item_id, created_at, updated_at)
        VALUES (${this.ws}, ${replacement.id}, ${replacement.kind}, ${replacement.scope},
                ${replacement.harness_slug ?? null}, ${replacement.asker_id},
                ${replacement.title ?? null}, ${replacement.body}, ${replacement.producer},
                ${replacement.plan_slug ?? null}, ${replacement.work_item_id ?? null},
                ${replacement.created_ts}, ${replacement.created_ts})`;
      await tx`
        UPDATE harness_shared.coord_conversations
           SET state = 'superseded',
               superseded_by = ${replacement.id},
               superseded_at = ${opts.now_ts},
               updated_at = ${opts.now_ts},
               resolved_at = NULL
         WHERE workspace_id = ${this.ws} AND id = ${id}`;

      const updatedOldRows = await tx<ConversationRowDb[]>`
        SELECT ${tx.unsafe(SELECT_COLS)}
          FROM harness_shared.coord_conversations
         WHERE workspace_id = ${this.ws} AND id = ${id}`;
      const replacementRows = await tx<ConversationRowDb[]>`
        SELECT ${tx.unsafe(SELECT_COLS)}
          FROM harness_shared.coord_conversations
         WHERE workspace_id = ${this.ws} AND id = ${replacement.id}`;
      return {
        conversation: toRow(updatedOldRows[0] ?? old),
        replacement: toRow(replacementRows[0]!),
      };
    };
    // A workflow may already supply a TransactionSql-backed store. Reuse that
    // transaction instead of attempting a nested `.begin()` the handle does
    // not expose; root Sql callers still get the row-locking transaction above.
    return 'begin' in sql ? sql.begin(supersedeInTransaction) : supersedeInTransaction(sql);
  }

  /** Record the accepted answer + where it was captured (D-004). */
  async setAcceptedAnswer(
    id: string,
    input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string },
  ): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET accepted_answer = ${input.answer},
             accepted_post_id = ${input.post_id ?? null},
             capture_target = ${input.capture_target ?? null},
             updated_at = ${input.now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /**
   * Explicit inverse of `resolveConversationCore` for a bounded compensation.
   *
   * Generic `setState('open')` is deliberately insufficient: resolution also
   * writes accepted-answer/capture scalars, and leaving any of them behind
   * would make an "open" question carry a stale accepted answer. The expected
   * answer is a compare-and-set guard over the exact bulk effect; a later or
   * unrelated terminal write is never overwritten. A TransactionSql-backed
   * store keeps this restore atomic with its caller's compensation receipt.
   */
  async reopenResolved(
    id: string,
    input: { expected_answer: string; now_ts: string },
  ): Promise<ReopenResolvedConversationResult> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const updated = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.coord_conversations
         SET state = 'open',
             accepted_answer = NULL,
             accepted_post_id = NULL,
             capture_target = NULL,
             resolved_at = NULL,
             updated_at = ${input.now_ts}
       WHERE workspace_id = ${this.ws}
         AND id = ${id}
         AND state = 'resolved'
         AND accepted_answer = ${input.expected_answer}
       RETURNING id
    `;
    if (updated.length > 0) return 'reopened';

    const rows = await sql<Array<{ state: ConversationState; accepted_answer: string | null }>>`
      SELECT state, accepted_answer
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${this.ws} AND id = ${id}
    `;
    if (rows.length === 0) return 'not_found';
    if (rows[0]?.state === 'open') return 'already_open';
    return 'source_changed';
  }

  /** Mark the conversation promoted to an engineer issue (D-005): record the
   *  issue id + close the conversation (the discussion continues on the issue). */
  async setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET promoted_issue_id = ${input.issue_id},
             state = 'closed',
             updated_at = ${input.now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /** Bump updated_at on activity (a new reply/answer). */
  async touch(id: string, now_ts: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET updated_at = ${now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }
}

/**
 * Re-parent a Threadable thread from one object to another (D-005 promote) and
 * RE-KEY it (thread + its posts) to the destination's thread_id, in one tx so
 * the posts follow. Re-keying (not just moving the parent) is required because
 * the destination domain's lazy getOrCreateThread does INSERT … ON CONFLICT
 * (thread_id) DO NOTHING then read-by-parent — if we moved the parent but kept
 * the old thread_id, that lazy create would INSERT a 2nd thread for the same
 * parent and trip the (parent_kind,parent_ref) UNIQUE index. Re-keying to the
 * destination's own thread_id makes that lazy create a clean no-op. No-op if
 * `from` has no thread.
 *
 * `newThreadId` MUST equal the destination domain's thread_id convention
 * (engineer_issues: `issue-thread-<EI-id>`). This is a localized substrate
 * operation pending a first-class ThreadableStore.reparent() capability +
 * parent-first getOrCreateThread (flagged to the substrate owner) — which would
 * remove the thread_id coupling entirely.
 */
export async function reparentThread(
  sql: Sql,
  ws: string,
  from: { kind: string; ref: string },
  to: { kind: string; ref: string },
  newThreadId: string,
): Promise<{ reparented: boolean; thread_id?: string }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ thread_id: string }[]>`
      SELECT thread_id FROM harness_shared.coord_threads
       WHERE workspace_id = ${ws} AND parent_kind = ${from.kind} AND parent_ref = ${from.ref}`;
    const old = rows[0]?.thread_id;
    if (!old) return { reparented: false };
    await tx`
      UPDATE harness_shared.coord_thread_posts
         SET thread_id = ${newThreadId}
       WHERE workspace_id = ${ws} AND thread_id = ${old}`;
    await tx`
      UPDATE harness_shared.coord_threads
         SET thread_id = ${newThreadId}, parent_kind = ${to.kind}, parent_ref = ${to.ref}
       WHERE workspace_id = ${ws} AND thread_id = ${old}`;
    return { reparented: true, thread_id: newThreadId };
  }) as Promise<{ reparented: boolean; thread_id?: string }>;
}

/** Create coord_conversations + its indexes if absent. Idempotent. Mirrors
 *  libs/papercusp/libs/db/sql/132-coordination-conversations.sql (for the
 *  package/integration test rig — the operator uses the migration). */
export async function ensureConversationsTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_conversations (
      workspace_id     text NOT NULL,
      id               text NOT NULL,
      kind             text NOT NULL,
      scope            text NOT NULL DEFAULT 'operator',
      harness_slug     text,
      asker_id         text NOT NULL,
      title            text,
      body             text NOT NULL DEFAULT '',
      state            text NOT NULL DEFAULT 'open',
      accepted_answer  text,
      accepted_post_id bigint,
      capture_target   text,
      promoted_issue_id text,
      producer         text,
      plan_slug        text,
      work_item_id     text,
      superseded_by text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      resolved_at      timestamptz,
      superseded_at    timestamptz,
      PRIMARY KEY (workspace_id, id),
      CONSTRAINT coord_conversations_kind_check  CHECK (kind  = ANY (ARRAY['question','discussion','consult'])),
      CONSTRAINT coord_conversations_scope_check CHECK (scope = ANY (ARRAY['operator','harness'])),
      CONSTRAINT coord_conversations_state_check CHECK (state = ANY (ARRAY['open','resolved','closed','superseded','expired'])),
      CONSTRAINT coord_conversations_scope_slug_check CHECK (
          (scope = 'harness'  AND harness_slug IS NOT NULL AND harness_slug <> '')
       OR (scope = 'operator' AND harness_slug IS NULL)
      )
    )`;
  await sql`
    ALTER TABLE harness_shared.coord_conversations
      ADD COLUMN IF NOT EXISTS superseded_by text,
      ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
      ADD COLUMN IF NOT EXISTS producer text,
      ADD COLUMN IF NOT EXISTS plan_slug text,
      ADD COLUMN IF NOT EXISTS work_item_id text`;
  await sql`ALTER TABLE harness_shared.coord_conversations DROP CONSTRAINT IF EXISTS coord_conversations_state_check`;
  await sql`
    ALTER TABLE harness_shared.coord_conversations
      ADD CONSTRAINT coord_conversations_state_check
      CHECK (state = ANY (ARRAY['open','resolved','closed','superseded','expired']))`;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_conversations_open_idx
      ON harness_shared.coord_conversations (workspace_id, kind, created_at DESC)
      WHERE state = 'open'`;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_conversations_scope_idx
      ON harness_shared.coord_conversations (workspace_id, scope, harness_slug, created_at DESC)`;
}
