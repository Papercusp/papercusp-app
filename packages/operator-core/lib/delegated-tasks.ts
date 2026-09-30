/**
 * delegated-tasks — the operator's "delegate background work" domain over work_items
 * (plan collapse-delegate-into-workitems-2026-06-04, D-001).
 *
 * A delegated task IS a work_item: an operator-scoped issue-family item of kind
 * `task`. This module preserves historical delegate task records —
 * it replaces the bespoke `delegates` session registry. The durable, fleet-visible,
 * subscribe-able record is the work_item; the conversational resume key + origin/
 * backend live in its payload; the transcript lives in its coord thread (comments).
 *
 * subscribe→inject (D-003): createWorkItem auto-subscribes createdBy
 * (OPERATOR_COORD_OWNER), so every lifecycle change (claim/comment/resolve) fans out
 * to the operator's coord inbox via issues-engineer.deliver() — no poll. The voice
 * surface drains the operator's coord inbox ("while you were away").
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { createWorkItem, getWorkItem, setWorkItemState, commentWorkItem, type WorkItem } from './work-items';
import { findTaskBySessionId } from './issues-engineer';
import { pgTimestampToIso } from './pg-timestamp';

/**
 * The operator's stable coordination owner id. It is the creator + delegator
 * (assigned_by) of every delegated task, the auto-subscriber that receives their
 * completion fan-out, and the owner whose coord inbox the voice "while you were
 * away" drain reads. A single curator identity (curator-operator D-001).
 */
export const OPERATOR_COORD_OWNER = 'operator';

/** The work_item kind for a delegated unit of work (collapse-delegate D-001). */
export const DELEGATE_TASK_KIND = 'task';

export type DelegateOrigin = 'voice' | 'panel' | 'oracle';
export type DelegateBackend = 'claude-code' | 'omp';

/** The kind-specific payload a delegated-task work_item carries (resume metadata). */
export interface DelegatePayload {
  /** The claude `--session-id` / omp resume id — the conversational continuity key. */
  agentSessionId: string;
  origin: DelegateOrigin;
  backend: DelegateBackend;
}

export interface CreateDelegatedTaskArgs {
  title: string;
  summary?: string;
  /** Omit → operator-scope (workspace-wide, the delegate's cross-harness default). */
  harness?: string;
  agentSessionId: string;
  origin: DelegateOrigin;
  backend: DelegateBackend;
}

/**
 * Create the work_item that records a delegated task: kind=task, assigned BY the
 * operator TO the spawned delegate session, with the resume metadata in payload.
 * Auto-subscribes the operator (createdBy) so completions push back (D-003).
 */
export async function createDelegatedTask(args: CreateDelegatedTaskArgs): Promise<WorkItem> {
  const payload: DelegatePayload = {
    agentSessionId: args.agentSessionId,
    origin: args.origin,
    backend: args.backend,
  };
  return createWorkItem({
    kind: DELEGATE_TASK_KIND,
    title: args.title,
    summary: args.summary,
    harness: args.harness,
    createdBy: OPERATOR_COORD_OWNER,
    assignedBy: OPERATOR_COORD_OWNER,
    assignee: `delegate:${args.agentSessionId}`,
    payload,
  });
}

/** Resolve the open delegated-task work_item for a delegate session, if any. */
export async function findOpenDelegatedTask(agentSessionId: string): Promise<WorkItem | null> {
  const issue = await findTaskBySessionId(agentSessionId);
  return issue ? getWorkItem(issue.id) : null;
}

/** The coord author id for a delegate session — the "doer" that reports up.
 *  Authored AS the delegate (not the operator) so the operator subscriber is NOT
 *  excluded from the fan-out by the actor-exclusion in issues-engineer.deliver(). */
export function delegateAuthorId(agentSessionId: string): string {
  return `delegate:${agentSessionId}`;
}

/**
 * Record one delegate turn on its work_item: append the exchange as a thread comment
 * (the transcript, replacing the old delegates.transcript JSONB), authored AS the
 * delegate so it fans out to the work_item's subscribers — the operator (D-003).
 * Best-effort.
 */
export async function recordDelegateTurn(
  workItemId: string,
  agentSessionId: string,
  turn: { request: string; response: string },
): Promise<void> {
  const body = `**Request:** ${turn.request}\n\n**Response:** ${turn.response}`;
  await commentWorkItem(workItemId, body, delegateAuthorId(agentSessionId)).catch(() => {});
}

/** Mark a delegated task done (open→resolved) — fans out the completion to the
 *  operator (D-003). Authored AS the delegate so the operator subscriber is notified. */
export async function resolveDelegatedTask(workItemId: string, agentSessionId: string): Promise<void> {
  await setWorkItemState(workItemId, 'resolved', {
    by: delegateAuthorId(agentSessionId),
    completionRef: `Delegated task resolved by session ${agentSessionId}`,
  }).catch(() => {});
}

// ── Session-shaped views over delegated-task work_items ─────────────────────────────
// The operator panel + the voice session-picker queries consume delegated tasks as
// "sessions" (the shape the retired `delegates` table exposed). These project the
// task work_item + its coord thread (transcript) back into that shape over the
// unified store, so DelegatesSection / delegates.list keep working off work_items.

export type DelegatedSessionStatus = 'open' | 'archived';

export interface DelegatedSessionTurn {
  ts: string;
  request: string;
  response: string;
}

export interface DelegatedSession {
  /** work_item id (WI-NNN). */
  id: string;
  /** The conversational resume key (claude --session-id). */
  agentSessionId: string;
  title: string | null;
  summary: string | null;
  status: DelegatedSessionStatus;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  origin: string | null;
  /** Present only on the single-session read (getDelegatedSession). */
  transcript: DelegatedSessionTurn[];
}

interface SessionRowDb {
  id: string;
  agent_session_id: string | null;
  title: string | null;
  summary: string | null;
  state: string;
  origin: string | null;
  created_at: unknown;
  last_active_at: unknown;
  turn_count: string | number | null;
}

// EI-18691099450966094: delegates to the shared pg-timestamp helper — see
// pg-timestamp.ts for why a bare `String(v)` fallback is a staleness-trap bug.
const tsIso = pgTimestampToIso;

function rowToSession(r: SessionRowDb, transcript: DelegatedSessionTurn[] = []): DelegatedSession {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id ?? '',
    title: r.title,
    summary: r.summary,
    status: r.state === 'open' ? 'open' : 'archived',
    createdAt: tsIso(r.created_at),
    lastActiveAt: tsIso(r.last_active_at),
    turnCount: Number(r.turn_count ?? 0),
    origin: r.origin,
    transcript,
  };
}

const SESSION_SELECT = `
  SELECT e.issue_id AS id,
         e.payload ->> 'agentSessionId' AS agent_session_id,
         e.title,
         e.body AS summary,
         e.state,
         e.payload ->> 'origin' AS origin,
         e.created_at,
         COALESCE(t.last_post_at, e.updated_at) AS last_active_at,
         COALESCE(t.post_count, 0) AS turn_count
    FROM harness_shared.engineer_issues e
    LEFT JOIN harness_shared.coord_threads t
      ON t.workspace_id = e.workspace_id AND t.parent_kind = 'issue' AND t.parent_ref = e.issue_id`;

/** List the operator's delegated-task sessions (open | archived | all). */
export async function listDelegatedSessions(opts: { status?: 'open' | 'archived' | 'all'; limit?: number } = {}): Promise<DelegatedSession[]> {
  const { sql } = getOrgPg();
  const status = opts.status ?? 'open';
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);
  const stateClause =
    status === 'open' ? sql`e.state = 'open'` : status === 'archived' ? sql`e.state <> 'open'` : sql`TRUE`;
  const rows = await sql<SessionRowDb[]>`
    ${sql.unsafe(SESSION_SELECT)}
     WHERE e.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND e.kind = 'task'
       AND e.assigned_by = ${OPERATOR_COORD_OWNER}
       AND ${stateClause}
     ORDER BY last_active_at DESC NULLS LAST
     LIMIT ${limit}`;
  return rows.map((r) => rowToSession(r));
}

/** Search delegated-task sessions by title/summary (ILIKE). */
export async function searchDelegatedSessions(query: string, limit = 10): Promise<DelegatedSession[]> {
  const { sql } = getOrgPg();
  const needle = `%${query.replace(/[%_]/g, (c) => '\\' + c)}%`;
  const rows = await sql<SessionRowDb[]>`
    ${sql.unsafe(SESSION_SELECT)}
     WHERE e.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND e.kind = 'task'
       AND e.assigned_by = ${OPERATOR_COORD_OWNER}
       AND (COALESCE(e.title, '') ILIKE ${needle} OR COALESCE(e.body, '') ILIKE ${needle})
     ORDER BY last_active_at DESC NULLS LAST
     LIMIT ${Math.min(Math.max(1, limit), 50)}`;
  return rows.map((r) => rowToSession(r));
}

const TURN_RE = /^\*\*Request:\*\*\s([\s\S]*?)\n\n\*\*Response:\*\*\s([\s\S]*)$/;

/** Get one delegated-task session by work_item id or agentSessionId, with transcript. */
export async function getDelegatedSession(ref: string): Promise<DelegatedSession | null> {
  const { sql } = getOrgPg();
  const rows = await sql<SessionRowDb[]>`
    ${sql.unsafe(SESSION_SELECT)}
     WHERE e.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND e.kind = 'task'
       AND (e.issue_id = ${ref} OR e.payload ->> 'agentSessionId' = ${ref})
     ORDER BY e.created_at DESC
     LIMIT 1`;
  if (!rows[0]) return null;
  // Transcript = the work_item's thread posts (the delegate's turns), parsed back
  // into {request, response} from the "**Request:** … **Response:** …" body format.
  const posts = await sql<{ body: string; created_at: unknown }[]>`
    SELECT body, created_at FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND thread_id = ${`issue-thread-${rows[0].id}`}
     ORDER BY created_at ASC`;
  const transcript: DelegatedSessionTurn[] = posts.map((p) => {
    const m = TURN_RE.exec(p.body ?? '');
    return {
      ts: tsIso(p.created_at),
      request: m?.[1] ?? '',
      response: m?.[2] ?? (p.body ?? ''),
    };
  });
  return rowToSession(rows[0], transcript);
}

/** Archive a delegated-task session (state → closed). Accepts WI id or agentSessionId. */
export async function archiveDelegatedSession(ref: string): Promise<void> {
  const session = await getDelegatedSession(ref);
  if (!session) return;
  await setWorkItemState(session.id, 'closed', {
    by: OPERATOR_COORD_OWNER,
    completionRef: `Delegated session ${session.id} archived by operator`,
  }).catch(() => {});
}
