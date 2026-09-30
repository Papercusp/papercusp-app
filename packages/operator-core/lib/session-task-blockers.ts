/** Live resolution for the canonical task engine's typed blocker references. */
import type { Sql, TransactionSql } from 'postgres';
import { TERMINAL_WORK_ITEM_STATES } from './agent-tools/work_items/mirror-guard';
import { isTerminalItemStatus } from './fleet-drained-events';
import {
  validateSessionTaskBlockerRef,
  type ParsedSessionTaskBlockerRef,
} from './session-task-blocker-ref';
import { applySessionTaskOp, type SessionTask, type SessionTaskResult } from './session-tasks';

export {
  parseSessionTaskBlockerRef,
  validateSessionTaskBlockerRef,
  type ParsedSessionTaskBlockerRef,
  type SessionTaskBlockerKind,
} from './session-task-blocker-ref';

type SqlLike = Sql | TransactionSql;

export type SessionTaskBlockerStatus = 'waiting' | 'cleared' | 'manual' | 'missing' | 'ambiguous' | 'unknown';

export interface SessionTaskBlockerState extends ParsedSessionTaskBlockerRef {
  ref: string;
  status: SessionTaskBlockerStatus;
  autoUnblocks: boolean;
  detail?: string;
  updatedAt?: string;
}

export interface SessionTaskBlockerScope {
  workspaceId: string;
  harness: string;
  planSlug?: string | null;
  /** Physical checkout domain used by agent_file_locks; null fails closed across domains. */
  coordinationDomain?: string | null;
}

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export async function resolveSessionTaskBlocker(
  sql: SqlLike,
  scope: SessionTaskBlockerScope,
  ref: string,
): Promise<SessionTaskBlockerState> {
  const parsed = validateSessionTaskBlockerRef(ref);
  const base = { ref, ...parsed };
  if (!parsed.typed) {
    return { ...base, status: 'manual', autoUnblocks: false, detail: 'Free-text blocker; clear manually.' };
  }

  try {
    if (parsed.kind === 'lock') {
      const rows = await sql<{ owner: string; expires_ts: Date | string }[]>`
        SELECT owner, expires_ts
          FROM agent_file_locks
         WHERE (${scope.coordinationDomain ?? null}::text IS NULL
                OR coordination_domain = ${scope.coordinationDomain ?? null})
           AND expires_ts > clock_timestamp()
           AND lock_path_overlaps(path, ${parsed.target})
         ORDER BY expires_ts DESC
         LIMIT 1`;
      const row = rows[0];
      return row
        ? { ...base, status: 'waiting', autoUnblocks: true, detail: `Held by ${row.owner}.`, updatedAt: iso(row.expires_ts) }
        : { ...base, status: 'cleared', autoUnblocks: true, detail: 'No live overlapping file lock.' };
    }

    if (parsed.kind === 'event') {
      const rows = await sql<{ last_fired_at: Date | string; fire_count: number | string }[]>`
        SELECT last_fired_at, fire_count
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${scope.workspaceId} AND event_key = ${parsed.target}
         LIMIT 1`;
      const row = rows[0];
      return row
        ? { ...base, status: 'cleared', autoUnblocks: true, detail: `Event fired ${Number(row.fire_count) || 1} time(s).`, updatedAt: iso(row.last_fired_at) }
        : { ...base, status: 'waiting', autoUnblocks: true, detail: 'Event has not fired.' };
    }

    if (parsed.kind === 'wi') {
      const rows = await sql<{ status: string; updated_ts: Date | string | null }[]>`
        SELECT status, updated_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId}
           AND feature_id = ${parsed.target}
           AND (harness_slug = ${scope.harness} OR item_kind IN ('bug', 'change', 'task'))
         ORDER BY updated_ts DESC NULLS LAST
         LIMIT 1`;
      const row = rows[0];
      if (!row) return { ...base, status: 'missing', autoUnblocks: true, detail: 'Work item not found; missing is not terminal.' };
      const cleared = TERMINAL_WORK_ITEM_STATES.has(row.status.toLowerCase());
      return {
        ...base,
        status: cleared ? 'cleared' : 'waiting',
        autoUnblocks: true,
        detail: `Work item is ${row.status}.`,
        updatedAt: iso(row.updated_ts),
      };
    }

    const rows = await sql<{ plan_slug: string; status: string; updated_at: Date | string }[]>`
      SELECT plan_slug, status, updated_at
        FROM harness_shared.plan_items
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harness}
         AND item_id = ${parsed.target}
         AND (${scope.planSlug ?? null}::text IS NULL OR plan_slug = ${scope.planSlug ?? null})
       ORDER BY updated_at DESC`;
    if (rows.length === 0) return { ...base, status: 'missing', autoUnblocks: true, detail: 'Plan item not found; missing is not terminal.' };
    if (rows.length > 1) return { ...base, status: 'ambiguous', autoUnblocks: true, detail: 'Plan item id matches more than one plan; no auto-unblock.' };
    const row = rows[0]!;
    const cleared = isTerminalItemStatus(row.status);
    return {
      ...base,
      status: cleared ? 'cleared' : 'waiting',
      autoUnblocks: true,
      detail: `${row.plan_slug}#${parsed.target} is ${row.status}.`,
      updatedAt: iso(row.updated_at),
    };
  } catch (error) {
    return {
      ...base,
      status: 'unknown',
      autoUnblocks: true,
      detail: error instanceof Error ? `Referent lookup failed: ${error.message}` : 'Referent lookup failed.',
    };
  }
}

export async function reconcileSessionTaskBlockers(
  sql: SqlLike,
  args: SessionTaskBlockerScope & { sessionId: string; tasks: readonly SessionTask[]; idFactory: () => string },
): Promise<{ tasks: SessionTask[]; states: Map<string, SessionTaskBlockerState>; mutations: SessionTaskResult[] }> {
  const states = new Map<string, SessionTaskBlockerState>();
  for (const task of args.tasks) {
    if (task.status !== 'blocked' || !task.blockerRef) continue;
    states.set(task.id, await resolveSessionTaskBlocker(sql, args, task.blockerRef));
  }

  let tasks = [...args.tasks];
  const mutations: SessionTaskResult[] = [];
  for (const task of args.tasks) {
    const state = states.get(task.id);
    if (!state || !state.autoUnblocks || state.status !== 'cleared') continue;
    const mutation = await applySessionTaskOp(sql, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      op: 'unblock',
      taskId: task.id,
      explanation: `Auto-unblocked after ${task.blockerRef} cleared.`,
      idFactory: args.idFactory,
    });
    mutations.push(mutation);
    tasks = mutation.tasks;
  }
  return { tasks, states, mutations };
}
