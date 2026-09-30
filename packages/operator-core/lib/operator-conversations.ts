/**
 * Server-side helpers for the operator conversation log.
 *
 * **Workspace-scoped**: one logical thread per workspace_id. The
 * `operator_conversations` table still has a `harness_slug` column for
 * back-compat with the original (workspace_id, harness_slug)-keyed
 * design, but new code MUST NOT vary by harness — switching harnesses
 * should never spawn or surface a different conversation. Both the
 * text sidebar and the ElevenLabs voice session append turns into the
 * same thread; the `source` column distinguishes them.
 *
 * See SPEC.md and the B+C-lite architecture sketch (operator chat
 * unification, 2026-05-10).
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, lt as dlt, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import type { ParsedReport } from './operator-converse-tags';
import { canonicalToolName } from './operator-mcp-tools';
import type {
  ChatTurn,
  ChatTurnRole,
  ChatTurnSource,
  ChatTurnToolCall,
  ChatTurnsPage,
} from '@papercusp/chat-protocol';

const oc = generated.operatorConversationsInHarnessShared;
const ot = generated.operatorTurnsInHarnessShared;

const conversationCols = {
  id: oc.id,
  workspace_id: oc.workspaceId,
  harness_slug: oc.harnessSlug,
  // Migration 901. Keep these as raw aliases until pull-schema has run after
  // the migration is armed; this lets the expand-phase implementation and its
  // ephemeral-PG tests land before generated.ts learns the columns.
  subject_kind: dsql<string>`subject_kind`.as('subject_kind'),
  subject_ref: dsql<string | null>`subject_ref`.as('subject_ref'),
  title: oc.title,
  status: oc.status,
  started_at: oc.startedAt,
  ended_at: oc.endedAt,
  el_conversation_ids: oc.elConversationIds,
  has_audio: oc.hasAudio,
} as const;

const turnCols = {
  id: ot.id,
  conversation_id: ot.conversationId,
  seq: ot.seq,
  role: ot.role,
  text: ot.text,
  source: ot.source,
  el_conv_id: ot.elConvId,
  audio_url: ot.audioUrl,
  created_at: ot.createdAt,
  tools: ot.tools,
  // `report` (the <report> structured-status payload, migration 160) is
  // selected as a raw column rather than a drizzle ref so this change is
  // self-contained — no generated-schema regen needed in the shared tree.
  // structured-report-protocol-2026-06-05 D-003.
  report: dsql<ParsedReport | null>`report`.as('report'),
} as const;

// The row types below are the converse STORE's projection of the one wire
// history shape, `@papercusp/chat-protocol` `ChatTurn` (papercup-chat-one-
// component-one-contract D-008 §3): a `TurnRow` IS a `ChatTurn` plus the
// converse-only columns, so a history read serves both hosts unchanged.
export type TurnRole = ChatTurnRole;
export type TurnSource = ChatTurnSource;

export interface ConversationRow {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  subjectKind: 'global' | 'work-item';
  subjectRef: string | null;
  title: string | null;
  status: 'active' | 'done' | 'abandoned' | 'scoped';
  startedAt: number;
  endedAt: number | null;
  elConversationIds: string[];
  hasAudio: boolean;
}

/**
 * A tool-call entry stored alongside a turn's text. Used for
 * chat:ask_choice (and future generative-UI tools) so the card +
 * its answered state survives page reload. Persisted to
 * operator_turns.tools jsonb (migration 015).
 */
export type TurnToolCall = ChatTurnToolCall;

export interface TurnRow extends ChatTurn {
  conversationId: string;
  seq: number;
  role: TurnRole;
  source: TurnSource;
  elConvId: string | null;
  audioUrl: string | null;
  tools: TurnToolCall[] | null;
  /**
   * Structured `<report>` payload (operator_turns.report jsonb, migration
   * 160) — per-plan/per-item status the operator emitted this turn, or null.
   * Rendered as a card (desktop) / two-tier list (TUI).
   */
  report: ParsedReport | null;
}

/**
 * Returns the workspace's active operator conversation, creating it if
 * none exists. Workspace-scoped: NEVER varies by harness slug. The
 * `harness_slug` column is always written as NULL on new rows.
 *
 * `workspaceId` — the EXPLICIT workspace to resolve, threaded from the
 * caller (the sync read passes the window's `window.__PAPERCUSP_WS__`).
 * A blank / '*' / undefined value falls back to `activeWorkspaceId()`
 * (the ambient request/process workspace), preserving the behavior of
 * every caller that doesn't pass one. This closes the read/write split
 * behind the "chat empty after reload" bug (WI-4801): the WRITE path
 * (operator-converse) resolves the window's workspace via the request
 * header→ALS, but the sync READ (batch fetch) carries no workspace, so
 * it fell back to the process-global `reg.current`. When that global
 * lagged the window's workspace (multi-window shared operator, or a
 * transient on boot / right after a workspace switch), the read returned
 * a DIFFERENT (empty) conversation than writes landed in — the thread
 * looked wiped on reload while the turns were safe in PG. Honoring the
 * caller's explicit workspace makes the read scope match the write.
 */
export async function getOrCreateActiveConversation(
  workspaceId?: string,
): Promise<ConversationRow> {
  const { db } = getOrgPg();
  const ws = resolveConcreteWorkspaceId(workspaceId);

  const existing = await db
    .select(conversationCols)
    .from(oc)
    .where(
      and(
        eq(oc.workspaceId, ws),
        eq(oc.status, 'active'),
        // Migration 901 makes global identity explicit. `status='scoped'`
        // already protects old releases during the expand window; this
        // discriminator protects every new reader even if future statuses
        // become shared across subject kinds.
        dsql`subject_kind = 'global'`,
        dsql`subject_ref IS NULL`,
      ),
    )
    .orderBy(desc(oc.startedAt))
    .limit(1);

  if (existing.length > 0) return rowToConversation(existing[0] as Record<string, unknown>);

  const created = await db
    .insert(oc)
    .values({ workspaceId: ws, harnessSlug: null, startedAt: Date.now() })
    .returning(conversationCols);

  return rowToConversation(created[0] as Record<string, unknown>);
}

export interface WorkItemConversationKey {
  workspaceId?: string;
  harnessSlug: string;
  workItemId: string;
}

function normalizedWorkItemConversationKey(input: WorkItemConversationKey): {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
} {
  const workspaceId = resolveConcreteWorkspaceId(input.workspaceId);
  const harnessSlug = input.harnessSlug?.trim();
  const workItemId = input.workItemId?.trim();
  if (!harnessSlug) {
    throw new Error('work-item conversation: harnessSlug is required');
  }
  if (!workItemId) {
    throw new Error('work-item conversation: workItemId is required');
  }
  return { workspaceId, harnessSlug, workItemId };
}

/**
 * Read one conversation by id inside the caller's concrete workspace.
 *
 * This is the fail-closed identity seam used by explicit conversation routes
 * and prompt assembly: knowing a UUID is not enough to cross a workspace.
 */
export async function getConversationById(
  conversationId: string,
  workspaceId?: string,
): Promise<ConversationRow | null> {
  const id = conversationId?.trim();
  if (!id) return null;
  const ws = resolveConcreteWorkspaceId(workspaceId);
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT id, workspace_id, harness_slug, subject_kind, subject_ref,
            title, status, started_at, ended_at, el_conversation_ids,
            has_audio
       FROM harness_shared.operator_conversations
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [id, ws],
  )) as Array<Record<string, unknown>>;
  return rows[0] ? rowToConversation(rows[0]) : null;
}

/** Read the persisted rich Papercup thread bound to one canonical work item. */
export async function getWorkItemConversation(
  input: WorkItemConversationKey,
): Promise<ConversationRow | null> {
  const key = normalizedWorkItemConversationKey(input);
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT id, workspace_id, harness_slug, subject_kind, subject_ref,
            title, status, started_at, ended_at, el_conversation_ids,
            has_audio
       FROM harness_shared.operator_conversations
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND subject_kind = 'work-item'
        AND subject_ref = $3
        AND status = 'scoped'
      LIMIT 1`,
    [key.workspaceId, key.harnessSlug, key.workItemId],
  )) as Array<Record<string, unknown>>;
  return rows[0] ? rowToConversation(rows[0]) : null;
}

/**
 * Idempotently materialize the rich Papercup thread for one work item.
 *
 * The partial unique index from migration 901 is the concurrency authority.
 * `DO NOTHING` avoids emitting a spurious row-update invalidation on every
 * reopen; the losing creator then reads the winner.
 */
export async function getOrCreateWorkItemConversation(
  input: WorkItemConversationKey,
): Promise<ConversationRow> {
  const key = normalizedWorkItemConversationKey(input);
  const { sql } = getOrgPg();
  const created = (await sql.unsafe(
    `INSERT INTO harness_shared.operator_conversations
       (workspace_id, harness_slug, subject_kind, subject_ref, status, started_at)
     VALUES ($1, $2, 'work-item', $3, 'scoped', $4)
     ON CONFLICT (workspace_id, harness_slug, subject_ref)
       WHERE subject_kind = 'work-item'
     DO NOTHING
     RETURNING id, workspace_id, harness_slug, subject_kind, subject_ref,
               title, status, started_at, ended_at, el_conversation_ids,
               has_audio`,
    [key.workspaceId, key.harnessSlug, key.workItemId, Date.now()],
  )) as Array<Record<string, unknown>>;
  if (created[0]) return rowToConversation(created[0]);

  const existing = await getWorkItemConversation(key);
  if (existing) return existing;
  throw new Error(
    `work-item conversation conflict did not resolve for ${key.harnessSlug}/${key.workItemId}`,
  );
}

export async function listTurns(conversationId: string): Promise<TurnRow[]> {
  const { db } = getOrgPg();
  const rows = await db
    .select(turnCols)
    .from(ot)
    .where(eq(ot.conversationId, conversationId))
    .orderBy(ot.seq);
  return (rows as Array<Record<string, unknown>>).map(rowToTurn);
}

export interface TurnsPage extends ChatTurnsPage {
  /** Turns in this page, in seq ASC order (oldest first within the page). */
  turns: TurnRow[];
  /** True when at least one turn exists earlier than the lowest seq in `turns`. */
  hasMoreEarlier: boolean;
}

/**
 * Cursor-paginated read for chat infinite scroll. Returns the newest
 * `limit` turns whose `seq < beforeSeq` (or the newest `limit` overall
 * when `beforeSeq` is null).
 *
 * The list is returned in ASC order so the UI can simply prepend it.
 * `hasMoreEarlier` enables the chat client to suppress its load-earlier
 * sentinel once the tail is reached.
 */
export async function listTurnsRecent(args: {
  conversationId: string;
  beforeSeq?: number | null;
  limit?: number;
}): Promise<TurnsPage> {
  const { db } = getOrgPg();
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  const beforeSeq = args.beforeSeq ?? null;

  // Fetch newest N below the cursor, then sort ASC for the UI.
  const where = beforeSeq === null
    ? eq(ot.conversationId, args.conversationId)
    : and(eq(ot.conversationId, args.conversationId), dlt(ot.seq, beforeSeq));
  const rows = await db
    .select(turnCols)
    .from(ot)
    .where(where)
    .orderBy(desc(ot.seq))
    .limit(limit);
  const turns = (rows as Array<Record<string, unknown>>).map(rowToTurn).reverse();

  // hasMoreEarlier: is there at least one row with seq < min(turns.seq)?
  let hasMoreEarlier = false;
  if (turns.length > 0) {
    const minSeq = turns[0].seq;
    const probe = await db
      .select({ id: ot.id })
      .from(ot)
      .where(and(eq(ot.conversationId, args.conversationId), dlt(ot.seq, minSeq)))
      .limit(1);
    hasMoreEarlier = probe.length > 0;
  }
  return { turns, hasMoreEarlier };
}

export async function appendTurn(input: {
  conversationId: string;
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
  audioUrl?: string | null;
  /**
   * Tool calls that fired during this turn (e.g. chat:ask_choice).
   * Persisted to operator_turns.tools jsonb. Pass null/omit when the
   * turn had no tool calls.
   */
  tools?: TurnToolCall[] | null;
  /**
   * Structured `<report>` payload (migration 160). Pass null/omit when
   * the turn had no `<report>` tag. structured-report-protocol-2026-06-05.
   */
  report?: ParsedReport | null;
}): Promise<TurnRow> {
  // Fail FAST + CLEAR on a missing conversation id (EI-2905). Without this, an undefined
  // conversationId flowed straight into the INSERT's `$1` and surfaced as postgres-js's
  // cryptic `UNDEFINED_VALUE: Undefined values are not allowed` — naming neither the tool
  // nor the field. A named guard turns the next such caller bug into an obvious error.
  if (!input.conversationId) {
    throw new Error(
      `appendTurn: conversationId is required (got ${JSON.stringify(input.conversationId)})`,
    );
  }
  const { sql: rawSql } = getOrgPg();

  // Drizzle has a known jsonb auto-conversion bug (commit 98cfffb7 — three
  // ui:* routes reverted from drizzle to raw sql for the same reason). The
  // established workaround is to write jsonb via raw `${JSON.stringify(x)}::jsonb`
  // instead of letting drizzle's encoder touch the value. Pre-stringify once.
  const toolsJson =
    input.tools && input.tools.length > 0 ? JSON.stringify(input.tools) : null;
  const reportJson = input.report ? JSON.stringify(input.report) : null;

  // Compute the next seq ATOMICALLY inside the INSERT (the COALESCE(MAX)+1
  // subquery) so there is no read-then-write gap, and collide-tolerate via the
  // UNIQUE (conversation_id, seq) constraint with a bounded, jittered retry.
  // The original read MAX(seq) in a SEPARATE SELECT and retried only 3× on the
  // assumption that concurrent inserters were rare ("one user, two transports
  // max"). That assumption no longer holds: server-side writers (the curation
  // tick, the urgent-wake runner, and the live transport) contend on a single
  // conversation, and the 3 retries were being exhausted in the wild
  // (`appendTurn: failed after 3 retries`, hundreds of occurrences — curation
  // turns silently dropped). Folding the seq into the INSERT closes the gap, and
  // the extra jittered attempts absorb realistic server-side contention.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const inserted = (await rawSql.unsafe(
        `INSERT INTO harness_shared.operator_turns
           (conversation_id, seq, role, text, source, el_conv_id,
            audio_url, created_at, tools, report, workspace_id)
         SELECT $1,
                COALESCE((SELECT MAX(seq) FROM harness_shared.operator_turns
                           WHERE conversation_id = $1), -1) + 1,
                $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10
         RETURNING id, conversation_id, seq, role, text, source,
                   el_conv_id, audio_url, created_at, tools, report`,
        [
          input.conversationId,
          input.role,
          input.text,
          input.source ?? 'text_typed',
          input.elConvId ?? null,
          input.audioUrl ?? null,
          Date.now(),
          toolsJson,
          reportJson,
          activeWorkspaceId(),
        ],
      )) as Array<Record<string, unknown>>;
      return rowToTurn(inserted[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err; // not a unique violation
      // Someone else took our seq — back off briefly (jitter breaks lockstep)
      // and retry; the next attempt re-reads the now-higher committed MAX.
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 25)));
    }
  }
  throw new Error('appendTurn: failed after 10 retries');
}

// ---------------------------------------------------------------------------
// Rolling conversation summary (operator context compaction)
// operator-context-compaction-2026-06-05 D-002/D-003 — the compacted gist of
// every turn with seq <= summary_through_seq lives WITH the conversation
// (migration 168). Raw-column SQL on purpose: no drizzle generated-schema
// regen in the shared tree (same precedent as operator_turns.report).
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  /** Compacted summary text, or null before the first compaction. */
  summaryText: string | null;
  /** Highest operator_turns.seq covered by summaryText (CAS baseline). */
  summaryThroughSeq: number | null;
  summaryUpdatedAt: number | null;
  summaryModel: string | null;
  summaryTurnsCovered: number;
}

/** Read the conversation's rolling summary state. Null = conversation not found. */
export async function readConversationSummary(
  conversationId: string,
): Promise<ConversationSummary | null> {
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT summary_text, summary_through_seq, summary_updated_at,
            summary_model, summary_turns_covered
       FROM harness_shared.operator_conversations
      WHERE id = $1`,
    [conversationId],
  )) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    summaryText: r.summary_text == null ? null : String(r.summary_text),
    summaryThroughSeq: r.summary_through_seq == null ? null : Number(r.summary_through_seq),
    summaryUpdatedAt: r.summary_updated_at == null ? null : Number(r.summary_updated_at),
    summaryModel: r.summary_model == null ? null : String(r.summary_model),
    summaryTurnsCovered: r.summary_turns_covered == null ? 0 : Number(r.summary_turns_covered),
  };
}

/**
 * CAS write of an incrementally-regenerated summary. Succeeds only when the
 * row's `summary_through_seq` still equals `expectedThroughSeq` (NULL-safe) —
 * a concurrent compactor that landed first wins and this call returns false;
 * the loser discards its result (D-003).
 */
export async function writeConversationSummary(input: {
  conversationId: string;
  /** The summaryThroughSeq read before summarizing — the CAS baseline. */
  expectedThroughSeq: number | null;
  summaryText: string;
  summaryThroughSeq: number;
  summaryModel: string;
  /** How many turns this compaction folded in (adds to the running total). */
  turnsAdded: number;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.operator_conversations
        SET summary_text = $2,
            summary_through_seq = $3,
            summary_updated_at = $4,
            summary_model = $5,
            summary_turns_covered = COALESCE(summary_turns_covered, 0) + $6
      WHERE id = $1
        AND summary_through_seq IS NOT DISTINCT FROM $7
      RETURNING id`,
    [
      input.conversationId,
      input.summaryText,
      input.summaryThroughSeq,
      Date.now(),
      input.summaryModel,
      input.turnsAdded,
      input.expectedThroughSeq,
    ],
  )) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/** Highest turn seq in the conversation, or null when it has no turns. */
export async function maxTurnSeq(conversationId: string): Promise<number | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ s: dsql<number | null>`MAX(${ot.seq})` })
    .from(ot)
    .where(eq(ot.conversationId, conversationId));
  const v = rows[0]?.s;
  return v == null ? null : Number(v);
}

/**
 * Turns with `afterSeq < seq <= throughSeq`, ASC — the aged-out uncovered
 * range the compactor folds into the summary.
 */
export async function listTurnsBetween(
  conversationId: string,
  afterSeq: number | null,
  throughSeq: number,
): Promise<TurnRow[]> {
  const { db } = getOrgPg();
  const lower = afterSeq ?? -1;
  const rows = await db
    .select(turnCols)
    .from(ot)
    .where(
      and(
        eq(ot.conversationId, conversationId),
        dsql`${ot.seq} > ${lower}`,
        dsql`${ot.seq} <= ${throughSeq}`,
      ),
    )
    .orderBy(ot.seq);
  return (rows as Array<Record<string, unknown>>).map(rowToTurn);
}

/** Replace the last assistant turn in place — used for EL barge-in correction. */
export async function correctLastAssistantTurn(
  conversationId: string,
  newText: string,
): Promise<TurnRow | null> {
  const { db } = getOrgPg();
  // UPDATE ... WHERE id = (SELECT id ... ORDER BY ... LIMIT 1) — drizzle
  // doesn't have a direct subquery-in-WHERE primitive that's cleaner than
  // composing it via dsql. Build the subquery as a Drizzle qb then pass it.
  const subq = db
    .select({ id: ot.id })
    .from(ot)
    .where(and(eq(ot.conversationId, conversationId), eq(ot.role, 'assistant')))
    .orderBy(desc(ot.seq))
    .limit(1);
  const rows = await db
    .update(ot)
    .set({ text: newText })
    .where(dsql`${ot.id} = (${subq})`)
    .returning(turnCols);
  return rows.length > 0 ? rowToTurn(rows[0] as Record<string, unknown>) : null;
}

function rowToConversation(r: Record<string, unknown>): ConversationRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    harnessSlug: r.harness_slug == null ? null : String(r.harness_slug),
    subjectKind: r.subject_kind === 'work-item' ? 'work-item' : 'global',
    subjectRef: r.subject_ref == null ? null : String(r.subject_ref),
    title: r.title == null ? null : String(r.title),
    status: (r.status as ConversationRow['status']) ?? 'active',
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    elConversationIds: Array.isArray(r.el_conversation_ids)
      ? (r.el_conversation_ids as string[])
      : [],
    hasAudio: r.has_audio === true,
  };
}

/**
 * WI-4949: normalize a persisted turn's tool-call names at the READ boundary
 * rather than mass-UPDATE-ing historical operator_turns rows. Some already-
 * persisted rows carry the Claude-sanitized form (`chat_ask_choice`) because
 * ingest didn't always restore the canonical `chat:ask_choice` colon name —
 * every consumer (the card registry, the ask_choice gates, turn-answer) is
 * keyed on the canonical name, so an unnormalized row's card silently never
 * rendered. Applying `canonicalToolName` here, at the single choke point
 * every reader of operator_turns rows goes through, fixes BOTH already-dead
 * historical rows (no risky backfill migration needed — this makes the
 * owner's old "Pick one." message clickable again on next read) AND any
 * future write-path regression that forgets to canonicalize at ingest.
 * Idempotent: already-canonical names pass through unchanged.
 */
export function normalizeTurnTools(tools: unknown): TurnToolCall[] | null {
  if (!Array.isArray(tools)) return null;
  return tools.map((t) =>
    t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'
      ? { ...(t as TurnToolCall), name: canonicalToolName((t as TurnToolCall).name) }
      : (t as TurnToolCall),
  );
}

function rowToTurn(r: Record<string, unknown>): TurnRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    seq: Number(r.seq),
    role: r.role as TurnRole,
    text: String(r.text),
    source: (r.source as TurnSource) ?? 'text_typed',
    elConvId: r.el_conv_id == null ? null : String(r.el_conv_id),
    audioUrl: r.audio_url == null ? null : String(r.audio_url),
    createdAt: Number(r.created_at),
    tools: normalizeTurnTools(r.tools),
    report:
      r.report && typeof r.report === 'object' && !Array.isArray(r.report)
        ? (r.report as ParsedReport)
        : null,
  };
}
