/** Shared scoping, identity, response, and event helpers for task tools. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionSql } from 'postgres';
import {
  SESSION_TASK_LINK_RELATIONS,
  SESSION_TASK_OPS,
  SESSION_TASK_STATUSES,
  SessionTaskValidationError,
  taskSessionIdForOwner,
  type SessionTask,
  type SessionTaskBridge,
  type SessionTaskOp,
  type SessionTaskResult,
  type SessionTaskWorkItemLink,
} from '../../session-tasks';
import { getActiveClaimForOwner } from '../../work-item-claims';
import { setWorkItemCheckpointWithPrior } from '../../work-item-checkpoint';
import { isWorkItemKind } from '../../work-items';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { createOneWorkItem } from '../work_items/_create-core';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export const sessionTaskStatusSchema = z.enum(SESSION_TASK_STATUSES);
export const sessionTaskOpSchema = z.enum(SESSION_TASK_OPS);
export const sessionTaskLinkRelationSchema = z.enum(SESSION_TASK_LINK_RELATIONS);

type SqlLike = Sql | TransactionSql;

export interface SessionTaskLedgerBridgeArgs {
  workspaceId: string;
  sessionId: string;
  /** The caller performing this mutation; promotion creation is attributed here. */
  actorId: string;
  /**
   * Whose active claim seeds `for` links. Defaults to `sessionId`; differs only
   * when an SU owner operates its attached PUI conversation's list (D-019).
   */
  claimOwnerId?: string;
  defaultHarness?: string;
  /** Carried by both MCP and endpoint adapters so the factory stays transport-neutral. */
  sql?: SqlLike;
}

const TASK_PROGRESS_HEADING = '## Session task progress (automatic)';
const TASK_PROGRESS_MAX_ENTRIES = 20;
const TASK_PROGRESS_MAX_CHARS = 4_000;

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Keep automatic task progress bounded without truncating the human-authored
 * checkpoint above it. Only this owned section is rotated.
 */
export function appendSessionTaskProgress(
  prior: string | null,
  task: SessionTask,
  op: SessionTaskOp,
): string {
  const source = prior?.trimEnd() ?? '';
  const marker = `\n${TASK_PROGRESS_HEADING}\n`;
  const markerAt = source.lastIndexOf(marker);
  const prefix = markerAt >= 0 ? source.slice(0, markerAt).trimEnd() : source;
  const existing = markerAt >= 0
    ? source.slice(markerAt + marker.length).split('\n').filter((line) => line.trim())
    : [];
  const explanation = task.explanation ? ` — ${oneLine(task.explanation, 240)}` : '';
  const entry = `- ${task.updatedAt} task:${task.id} ${op} → ${task.status}: ${oneLine(task.content, 320)}${explanation}`;
  const entries = [...existing, entry];
  while (
    entries.length > TASK_PROGRESS_MAX_ENTRIES
    || entries.join('\n').length > TASK_PROGRESS_MAX_CHARS
  ) {
    entries.shift();
  }
  return `${prefix ? `${prefix}\n\n` : ''}${TASK_PROGRESS_HEADING}\n${entries.join('\n')}`;
}

/**
 * D-002/D-012 ledger bridge shared by MCP tools and the GUI endpoint. The
 * factory reads the SESSION owner's claim for seed linkage, while promotion is
 * attributed to the invoking actor. No completion state propagates either way.
 */
export async function createSessionTaskLedgerBridge(
  args: SessionTaskLedgerBridgeArgs,
): Promise<SessionTaskBridge> {
  const workspaceId = args.workspaceId.trim();
  const sessionId = args.sessionId.trim();
  const actorId = args.actorId.trim();
  const defaultHarness = args.defaultHarness?.trim() || undefined;
  if (!workspaceId || !sessionId || !actorId) {
    throw new SessionTaskValidationError(
      'ledger_bridge_scope_required',
      'tasks:ops — workspaceId, sessionId, and actorId are required for the ledger bridge.',
    );
  }

  // Keep `sql` in the public factory contract: endpoint and MCP adapters pass
  // their transaction handle even though the existing claim/work-item/checkpoint
  // substrates own their own workspace-safe transactions today.
  void args.sql;
  const claim = await getActiveClaimForOwner(workspaceId, args.claimOwnerId?.trim() || sessionId);
  const seedWorkItem: SessionTaskWorkItemLink | null = claim
    ? {
        workItemId: claim.workItemId,
        workItemHarness: claim.harnessSlug || null,
        relation: 'for',
      }
    : null;

  return {
    seedWorkItem,
    async promoteTask(task, request) {
      const kind = request.kind?.trim() || 'task';
      if (!isWorkItemKind(kind)) {
        throw new SessionTaskValidationError(
          'work_item_kind_invalid',
          `tasks:ops — work_item_kind '${kind}' is not a supported work-item kind.`,
        );
      }
      const harness = request.harness?.trim() || defaultHarness;
      const created = await createOneWorkItem({
        kind,
        title: request.title?.trim() || task.content,
        summary: request.summary?.trim()
          || `Promoted from session task ${task.id} in ${sessionId}.${task.explanation ? ` Latest explanation: ${task.explanation}` : ''}`,
        ...(harness ? { harness } : {}),
      }, {
        ownerId: actorId,
        workspaceId,
        harnessSlug: defaultHarness,
      });
      if (!created.ok) {
        throw new SessionTaskValidationError(
          'work_item_promotion_failed',
          `tasks:ops — work-item promotion failed: ${created.message ?? created.error}`,
        );
      }
      return {
        workItemId: created.workItem.id,
        workItemHarness: created.workItem.harness,
        relation: 'for',
      };
    },
    async syncProgress(link, task, op) {
      await setWorkItemCheckpointWithPrior({
        workspaceId,
        harness: link.workItemHarness ?? defaultHarness ?? null,
        workItemId: link.workItemId,
      }, null, {
        transform: (prior) => appendSessionTaskProgress(prior, task, op),
      });
    },
  };
}

export function taskToolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function resolveSessionTaskRuntime(ctx: PapercuspUnifiedToolContext) {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId = (ctx.workspaceId ?? identity.workspaceId ?? '').trim();
  if (!workspaceId || workspaceId === '*' || !ctx.tx) return null;

  const runId = typeof ctx.runId === 'string' ? ctx.runId.trim() : '';
  const spawnId = typeof ctx.spawnId === 'string' ? ctx.spawnId.trim() : '';
  const ownedLoopChatId = runId && spawnId === `agent-loop-${runId}` ? runId : null;
  const sessionId = ownedLoopChatId
    ?? await taskSessionIdForOwner(ctx.tx, workspaceId, identity.ownerId);
  return {
    workspaceId,
    sessionId,
    actorId: identity.ownerId,
    claimOwnerId: ownedLoopChatId ?? identity.ownerId,
    // NOT `ctx.harnessSlug?.trim() || undefined`: the all-harnesses sentinel is a
    // TRUTHY string, so that form handed '*'/'all' downstream as if it were a
    // concrete harness slug. The canonical resolver returns null for the sentinel.
    defaultHarness: resolveConcreteHarnessSlug(null, ctx) ?? undefined,
    tx: ctx.tx,
    idFactory: () => `task-${randomUUID()}`,
  };
}

export function workspaceRequiredResponse(toolName: string) {
  return taskToolText({
    ok: false,
    error: {
      code: 'workspace_required',
      message: `${toolName} requires a concrete workspace-scoped session.`,
    },
  }, true);
}

export function validationErrorResponse(error: unknown) {
  if (!(error instanceof SessionTaskValidationError)) return null;
  return taskToolText({
    ok: false,
    error: { code: error.code, message: error.message },
  }, true);
}

export function emitSessionTaskChanges(
  ctx: PapercuspUnifiedToolContext,
  sessionId: string,
  mutations: readonly SessionTaskResult[],
): void {
  for (const mutation of mutations) {
    ctx.emit('tasks_changed', {
      sessionId,
      op: mutation.op,
      changedTaskId: mutation.changedTaskId,
    });
  }
}
