/**
 * approval-store — PG-backed HITL approval round-trip for the owned agent
 * loop (P-008, own-tui-full-divorce-2026-08-24; table: migration 934).
 *
 * WHY PG (not an in-process correlator like the card system's): :3070 is a
 * 16-worker `node:cluster`. The SSE response holding a paused `runAgentLoop`
 * (a gated tool call awaiting its ApprovalDecision) lives on ONE worker; the
 * client's approval POST round-robins onto ANY worker. Same bug class the
 * chat streaming lock already crossed (WI-7139 → agent_chat_locks, migration
 * 740), so the decision takes the same route: the loop-holding worker INSERTs
 * a pending row and polls it; the approval route UPDATEs it from whichever
 * worker receives the POST.
 *
 * Lifecycle: a row is born 'pending', resolved to 'approved'/'denied' by the
 * route (or by the waiter itself on timeout/abort, so the pending list never
 * shows a request nobody is waiting on), and DELETED by the waiter once the
 * decision is consumed. An age sweep on insert clears any rows a crashed
 * waiter stranded — no scheduled job.
 *
 * FAILS CLOSED: any PG error on the wait path resolves to a DENY with a
 * reason, never a silent approve — the loop feeds the deny back to the model
 * as an isError tool_result (loop.ts), which is the safe degraded behavior.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

/** A waiter this old is assumed crashed; its row is swept on the next insert. */
export const LOOP_APPROVAL_MAX_AGE_MS = 60 * 60_000;

/** Default decision-wait budget — generous for a human round-trip, bounded
 *  well under the chat streaming lock's own 10-min staleness TTL so a turn
 *  parked on an ignored approval releases the chat before the lock is stolen. */
export const LOOP_APPROVAL_TIMEOUT_MS = 8 * 60_000;

export const LOOP_APPROVAL_POLL_MS = 400;

export interface LoopApprovalRequestRow {
  chatId: string;
  callId: string;
  workspaceId: string;
  toolName: string;
  toolInput: unknown;
  stepIndex: number;
  requestedAt: string;
}

export interface LoopApprovalDecision {
  approved: boolean;
  reason?: string;
}

function db(opts: { sql?: Sql }): Sql {
  return opts.sql ?? getOrgPg().sql;
}

/** Insert the pending row (idempotent per chat+call). Also sweeps stranded
 *  rows past LOOP_APPROVAL_MAX_AGE_MS — piggybacked here so the table stays
 *  tiny without a scheduled job. */
export async function createLoopApproval(
  req: {
    chatId: string;
    callId: string;
    workspaceId: string;
    toolName: string;
    toolInput: unknown;
    stepIndex: number;
  },
  opts: { sql?: Sql } = {},
): Promise<void> {
  const sql = db(opts);
  const ageSec = Math.round(LOOP_APPROVAL_MAX_AGE_MS / 1000);
  await sql`
    DELETE FROM harness_shared.agent_loop_approvals
     WHERE requested_at < now() - make_interval(secs => ${ageSec})`;
  let inputJson = 'null';
  try {
    inputJson = JSON.stringify(req.toolInput ?? null);
  } catch {
    inputJson = JSON.stringify(String(req.toolInput));
  }
  await sql`
    INSERT INTO harness_shared.agent_loop_approvals
      (chat_id, call_id, workspace_id, tool_name, tool_input, step_index)
    VALUES (${req.chatId}, ${req.callId}, ${req.workspaceId}, ${req.toolName},
            ${inputJson}::jsonb, ${req.stepIndex})
    ON CONFLICT (chat_id, call_id) DO NOTHING`;
}

/**
 * Resolve a pending approval — the route-side half, callable from ANY worker.
 * Returns false when there is no live pending row for chat+call (already
 * resolved, timed out, or never existed) so the route can 404/409 honestly.
 */
export async function resolveLoopApproval(
  args: {
    chatId: string;
    callId: string;
    workspaceId: string;
    approved: boolean;
    reason?: string;
    resolvedBy?: string;
  },
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const sql = db(opts);
  const rows = await sql<Array<{ call_id: string }>>`
    UPDATE harness_shared.agent_loop_approvals
       SET status = ${args.approved ? 'approved' : 'denied'},
           reason = ${args.reason ?? null},
           resolved_at = now(),
           resolved_by = ${args.resolvedBy ?? null}
     WHERE chat_id = ${args.chatId}
       AND call_id = ${args.callId}
       AND workspace_id = ${args.workspaceId}
       AND status = 'pending'
    RETURNING call_id`;
  return rows.length > 0;
}

/** Pending requests for a chat — a reconnecting client re-hydrates from this. */
export async function listPendingLoopApprovals(
  args: { chatId: string; workspaceId: string },
  opts: { sql?: Sql } = {},
): Promise<LoopApprovalRequestRow[]> {
  const sql = db(opts);
  const rows = await sql<
    Array<{
      chat_id: string;
      call_id: string;
      workspace_id: string;
      tool_name: string;
      tool_input: unknown;
      step_index: number;
      requested_at: string | Date;
    }>
  >`
    SELECT chat_id, call_id, workspace_id, tool_name, tool_input, step_index, requested_at
      FROM harness_shared.agent_loop_approvals
     WHERE chat_id = ${args.chatId}
       AND workspace_id = ${args.workspaceId}
       AND status = 'pending'
     ORDER BY requested_at ASC`;
  return rows.map((r) => ({
    chatId: r.chat_id,
    callId: r.call_id,
    workspaceId: r.workspace_id,
    toolName: r.tool_name,
    toolInput: r.tool_input,
    stepIndex: r.step_index,
    requestedAt: r.requested_at instanceof Date ? r.requested_at.toISOString() : String(r.requested_at),
  }));
}

/**
 * Wait for the decision on chat+call — the loop-side half. Polls until the
 * row leaves 'pending', then DELETEs it (consumed) and returns the decision.
 * Timeout/abort resolve the row to a DENY first (so the pending list clears
 * and a late route POST gets an honest false), then return the deny.
 */
export async function awaitLoopApprovalDecision(
  args: {
    chatId: string;
    callId: string;
    workspaceId: string;
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
  },
  opts: { sql?: Sql } = {},
): Promise<LoopApprovalDecision> {
  const sql = db(opts);
  const timeoutMs = args.timeoutMs ?? LOOP_APPROVAL_TIMEOUT_MS;
  const pollMs = Math.max(50, args.pollMs ?? LOOP_APPROVAL_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  const selfDeny = async (reason: string): Promise<LoopApprovalDecision> => {
    try {
      await sql`
        UPDATE harness_shared.agent_loop_approvals
           SET status = 'denied', reason = ${reason}, resolved_at = now(),
               resolved_by = 'loop:self'
         WHERE chat_id = ${args.chatId} AND call_id = ${args.callId}
           AND status = 'pending'`;
      await consume(sql, args.chatId, args.callId);
    } catch {
      /* best-effort — the deny is returned regardless */
    }
    return { approved: false, reason };
  };

  for (;;) {
    if (args.signal?.aborted) return selfDeny('approval aborted (run cancelled)');
    let rows: Array<{ status: string; reason: string | null }>;
    try {
      rows = await sql<Array<{ status: string; reason: string | null }>>`
        SELECT status, reason FROM harness_shared.agent_loop_approvals
         WHERE chat_id = ${args.chatId} AND call_id = ${args.callId}`;
    } catch (e) {
      // FAIL CLOSED: an unreadable decision is a deny, never an approve.
      return {
        approved: false,
        reason: `approval store unavailable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const row = rows[0];
    if (!row) {
      // Row vanished (age sweep / manual cleanup) — treat as denied.
      return { approved: false, reason: 'approval request expired' };
    }
    if (row.status !== 'pending') {
      await consume(sql, args.chatId, args.callId);
      return {
        approved: row.status === 'approved',
        ...(row.reason ? { reason: row.reason } : {}),
      };
    }
    if (Date.now() >= deadline) return selfDeny('approval timed out');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      (t as { unref?: () => void }).unref?.();
    });
  }
}

async function consume(sql: Sql, chatId: string, callId: string): Promise<void> {
  try {
    await sql`
      DELETE FROM harness_shared.agent_loop_approvals
       WHERE chat_id = ${chatId} AND call_id = ${callId}`;
  } catch {
    /* best-effort — the age sweep clears it eventually */
  }
}

/** Test-only — drop every approval row (isolate suites sharing this table). */
export async function __resetLoopApprovals(opts: { sql?: Sql } = {}): Promise<void> {
  try {
    await db(opts)`DELETE FROM harness_shared.agent_loop_approvals`;
  } catch {
    /* best-effort test helper */
  }
}
