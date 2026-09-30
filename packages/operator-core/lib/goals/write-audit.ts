/**
 * Shared audit seam for goal writes that bypass the dispatched GOAL session.
 *
 * `tool_invocations` records dispatched calls. System writers (for example the
 * unattended holder respawner) do not pass through that sink, so they append a
 * `goal:write` entry to the existing audit_log-backed goal history instead of
 * inventing a second provenance table.
 */
import { appendGoalHistory } from '@papercusp/agent-mcp';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';

export interface GoalWriteAuditInput {
  workspaceId: string;
  goalId: string;
  author: string;
  writeKind: string;
  actorClass: string;
  detail?: string;
  refs?: string[];
  atMs?: number;
}

export async function appendGoalWriteAudit(
  sql: GoalSqlTag,
  input: GoalWriteAuditInput,
): Promise<void> {
  try {
    await appendGoalHistory(sql, {
      workspaceId: input.workspaceId,
      goalId: input.goalId,
      author: input.author,
      atMs: input.atMs,
      detail: {
        kind: 'write',
        writeKind: input.writeKind,
        actorClass: input.actorClass,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.refs ? { refs: input.refs } : {}),
      },
    });
  } catch (error) {
    // Lightweight integration fixtures (and pre-history deployments) can lack
    // audit_log. Goal writes remain authoritative; provenance is best-effort
    // metadata and must not make the guarded mutation noisy or fail-closed.
    if ((error as { code?: string } | null)?.code === '42P01') return;
    throw error;
  }
}
