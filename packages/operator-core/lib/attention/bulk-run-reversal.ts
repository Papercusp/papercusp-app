/**
 * Compensation adapter for migration 1063's `attention-bulk-item` handles.
 *
 * The handle points at the immutable per-item receipt. This module resolves the
 * receipt under the store's row lock and restores the source condition through
 * the existing persistence surfaces. Reversal never deletes or rewrites the
 * original action audit; the store appends reverted_at/revert_note only after
 * the source compensation succeeds.
 */
import type { RevertHandle } from '../autonomy/tripwire/core';
import type { RevertOutcome } from '../autonomy/tripwire/scan';
import type { TransactionSql } from 'postgres';
import {
  ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND,
  executeBulkRunItemReversal,
  type BulkRunItemRow,
} from './bulk-run-store';
import { terminalPolicyFor } from './terminal-coverage';
import { clearTriage } from './triage-store';
import { reopenEscalation } from '../agent-tools/coordination/escalations';
import { appendUnack } from '../agent-tools/coordination/messages';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { reopenGate } from './gate-store';
import { PgConversationStore } from '../agent-tools/coordination/conversations-store';
import { restorePlanItemStatusForCompensation } from '../agent-tools/plans/set-status';
import { reopenRejectedTriageForCompensation } from '../harness/improvements/triage-core';
import { getWorkItem, mergeWorkItemPayload, setWorkItemState } from '../work-items';
import { INTAKE_APPLY_ACTION_ID } from './bulk-dispositions';
import { compensateIntakeDecision, sqlIntakeCompensationStore } from './intake-compensation';

function field(handle: RevertHandle, key: string): string | null {
  const value = handle[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface AttentionBulkReversalDependencies {
  reopenEscalation: typeof reopenEscalation;
  appendUnack: typeof appendUnack;
  clearTriage: typeof clearTriage;
  reopenSessionGate: typeof reopenGate;
  reopenConversation(
    input: { workspaceId: string; conversationId: string; expectedAnswer: string },
    sql: TransactionSql,
  ): Promise<'reopened' | 'not_found' | 'already_open' | 'source_changed'>;
  restorePlanItemStatus: typeof restorePlanItemStatusForCompensation;
  reopenImprovement: typeof reopenRejectedTriageForCompensation;
  restoreWorkItemOwnerGate: typeof restoreWorkItemOwnerGateForCompensation;
  /** P-009 — the inverse of an applied intake decision (attention/intake-compensation.ts). */
  compensateIntake: typeof compensateIntakeDecision;
}

const DEFAULT_DEPS: AttentionBulkReversalDependencies = {
  reopenEscalation,
  appendUnack,
  clearTriage,
  reopenSessionGate: reopenGate,
  async reopenConversation(input, sql) {
    const store = new PgConversationStore({
      getSql: () => sql,
      ensureSchema: async () => {},
      workspaceId: input.workspaceId,
    });
    return await store.reopenResolved(input.conversationId, {
      expected_answer: input.expectedAnswer,
      now_ts: new Date().toISOString(),
    });
  },
  restorePlanItemStatus: restorePlanItemStatusForCompensation,
  reopenImprovement: reopenRejectedTriageForCompensation,
  restoreWorkItemOwnerGate: restoreWorkItemOwnerGateForCompensation,
  compensateIntake: compensateIntakeDecision,
};

const OWNER_GATE_KEYS = ['needsHuman', 'needsOwnerAction'] as const;

interface WorkItemOwnerGateRestoreDependencies {
  getWorkItem: typeof getWorkItem;
  setWorkItemState: typeof setWorkItemState;
  mergeWorkItemPayload: typeof mergeWorkItemPayload;
}

const DEFAULT_WORK_ITEM_RESTORE_DEPS: WorkItemOwnerGateRestoreDependencies = {
  getWorkItem,
  setWorkItemState,
  mergeWorkItemPayload,
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

/** Restore a work-item's exact owner-gate dialect without overwriting newer work. */
export async function restoreWorkItemOwnerGateForCompensation(
  input: {
    workItemId: string;
    harnessSlug?: string | null;
    ownerGate: 'status' | 'payload';
    priorStatus: string;
    ownerGateKeys: string[];
  },
  deps: WorkItemOwnerGateRestoreDependencies = DEFAULT_WORK_ITEM_RESTORE_DEPS,
): Promise<'restored' | 'already_restored' | 'not_found' | 'source_changed'> {
  const current = await deps.getWorkItem(input.workItemId, input.harnessSlug ?? undefined);
  if (!current) return 'not_found';
  const priorKeys = new Set(
    input.ownerGateKeys.filter((key): key is (typeof OWNER_GATE_KEYS)[number] =>
      OWNER_GATE_KEYS.includes(key as (typeof OWNER_GATE_KEYS)[number]),
    ),
  );
  if (input.ownerGate === 'payload' && priorKeys.size === 0) return 'source_changed';
  const payload =
    current.payload && typeof current.payload === 'object' ? (current.payload as Record<string, unknown>) : {};
  const exactKeys = OWNER_GATE_KEYS.every((key) => (payload[key] === true) === priorKeys.has(key));
  if (current.state === input.priorStatus && exactKeys) return 'already_restored';

  const expectedPostStatus = input.ownerGate === 'status' ? 'open' : input.priorStatus;
  const hasUnexpectedGate = OWNER_GATE_KEYS.some((key) => payload[key] === true);
  if (current.state !== expectedPostStatus || hasUnexpectedGate) return 'source_changed';

  if (input.ownerGate === 'status') {
    const restoredState = await deps.setWorkItemState(input.workItemId, input.priorStatus, {
      ...(input.harnessSlug ? { harness: input.harnessSlug } : {}),
      by: 'autonomy-revert',
      allowNonCanonical: true,
      skipCompletionGate: true,
    });
    if (!restoredState || restoredState.state !== input.priorStatus) return 'source_changed';
  }

  const patch = Object.fromEntries([...priorKeys].map((key) => [key, true]));
  const unset = OWNER_GATE_KEYS.filter((key) => !priorKeys.has(key));
  const restored = await deps.mergeWorkItemPayload(input.workItemId, patch, {
    ...(input.harnessSlug ? { harness: input.harnessSlug } : {}),
    unset,
  });
  return restored ? 'restored' : 'source_changed';
}

async function triagedBy(sql: TransactionSql, workspaceId: string, itemId: string): Promise<string | null> {
  const rows = await sql<Array<{ triaged_by: string | null }>>`
    SELECT triaged_by
      FROM harness_shared.attention_triage
     WHERE workspace_id = ${workspaceId}
       AND item_id = ${itemId}
     FOR UPDATE
  `;
  const value = rows[0]?.triaged_by;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Execute the source-specific inverse while the immutable bulk receipt is locked. */
export async function compensateAttentionBulkRunItem(
  item: BulkRunItemRow,
  workspaceId: string,
  sql: TransactionSql,
  deps: AttentionBulkReversalDependencies = DEFAULT_DEPS,
): Promise<string> {
  const sourceKind = item.kind ?? field({ kind: '', ...item.ref }, 'kind');
  const policy = sourceKind ? terminalPolicyFor(sourceKind) : null;
  if (!policy) throw new Error(`unknown attention source '${sourceKind ?? '(unknown)'}'`);

  let note: string;
  if (policy.class === 'acknowledgement') {
    note = `cleared acknowledgement triage for ${item.itemId}`;
  } else if (sourceKind === 'coord-escalation') {
    const msgId = field({ kind: '', ...item.ref }, 'msgId');
    if (!msgId) throw new Error('coord-escalation compensation missing msgId');
    const actor = (await triagedBy(sql, workspaceId, item.itemId)) ?? 'autonomy-revert';
    const reopened = await deps.reopenEscalation({
      msg_id: msgId,
      by: actor,
      note: `Undo bulk run ${item.runId}/${item.itemId}`,
    });
    if (reopened === 'not_found') throw new Error(`coord escalation ${msgId} no longer exists`);
    note = `appended reopen compensation for escalation ${msgId}`;
  } else if (sourceKind === 'coord-message') {
    const msgId = field({ kind: '', ...item.ref }, 'msgId');
    if (!msgId) throw new Error('coord-message compensation missing msgId');
    const actor = (await triagedBy(sql, workspaceId, item.itemId)) ?? 'autonomy-revert';
    const identity = {
      ownerId: actor,
      ownerLabel: actor,
      source: 'static-client',
      workspaceId,
      userId: null,
    } as AgentIdentity;
    await deps.appendUnack(
      identity,
      msgId,
      item.ownerAgentId ?? 'human',
      undefined,
      `unack-${item.runId}-${item.itemId}`,
    );
    note = `appended unack compensation for message ${msgId}`;
  } else if (sourceKind === 'blocked-session') {
    const sessionId = field({ kind: '', ...item.ref }, 'sessionId');
    const refId = field({ kind: '', ...item.ref }, 'refId');
    if (!sessionId || !refId) {
      throw new Error('blocked-session compensation missing sessionId/refId');
    }
    const reopened = await deps.reopenSessionGate(
      {
        workspaceId,
        sessionId,
        refId,
        expectedClosedReason: 'hook_cleared',
      },
      sql,
    );
    if (reopened !== 'reopened' && reopened !== 'already_open') {
      throw new Error(`blocked session gate ${sessionId}/${refId} could not reopen: ${reopened}`);
    }
    note = `reopened blocked session gate ${sessionId}/${refId}`;
  } else if (sourceKind === 'conversation') {
    const conversationId = field({ kind: '', ...item.ref }, 'conversationId');
    if (!conversationId) throw new Error('conversation compensation missing conversationId');
    const expectedAnswer = item.draftAnswer?.trim() || item.rationale?.trim();
    if (!expectedAnswer) {
      throw new Error('conversation compensation missing recorded answer/rationale');
    }
    const reopened = await deps.reopenConversation({ workspaceId, conversationId, expectedAnswer }, sql);
    if (reopened !== 'reopened' && reopened !== 'already_open') {
      throw new Error(`conversation ${conversationId} could not reopen: ${reopened}`);
    }
    note = `reopened conversation ${conversationId}`;
  } else if (sourceKind === 'plan-item') {
    const slug = field({ kind: '', ...item.ref }, 'slug');
    const planItemId = field({ kind: '', ...item.ref }, 'itemId');
    const priorStatus = field({ kind: '', ...item.ref }, 'priorStatus') ?? 'needs-human';
    const harnessSlug = field({ kind: '', ...item.ref }, 'harnessSlug');
    if (!slug || !planItemId) throw new Error('plan-item compensation missing slug/itemId');
    const expectedStatus =
      item.actionId === 'drop'
        ? 'dropped'
        : item.actionId === 'mark-done' || item.actionId === 'resolve'
          ? 'done'
          : null;
    if (!expectedStatus) {
      throw new Error(`plan-item compensation cannot invert action '${item.actionId ?? '(none)'}'`);
    }
    const restored = await deps.restorePlanItemStatus({
      workspaceId,
      harnessSlug,
      slug,
      itemId: planItemId,
      expectedStatus,
      priorStatus,
    });
    if (restored !== 'restored' && restored !== 'already_restored') {
      throw new Error(`plan item ${slug}#${planItemId} could not restore: ${restored}`);
    }
    note = `restored plan item ${slug}#${planItemId} to ${priorStatus}`;
  } else if (sourceKind === 'improvement' && item.actionId === INTAKE_APPLY_ACTION_ID) {
    // P-009 (D-019): an applied intake decision is inverted by its own module,
    // inside this transaction, so a thrown step rolls the whole undo back.
    const issueId = field({ kind: '', ...item.ref }, 'issueId');
    if (!issueId) throw new Error('intake compensation missing issueId');
    const result = await deps.compensateIntake(
      {
        sourceId: issueId,
        harnessSlug: field({ kind: '', ...item.ref }, 'harnessSlug'),
        runId: item.runId,
        itemId: item.itemId,
        decision: item.intakeDecision ?? null,
      },
      sqlIntakeCompensationStore(sql, workspaceId),
    );
    note = result.note;
  } else if (sourceKind === 'improvement') {
    const issueId = field({ kind: '', ...item.ref }, 'issueId');
    if (!issueId) throw new Error('improvement compensation missing issueId');
    const restored = await deps.reopenImprovement({
      id: issueId,
      expectedReason: item.rationale?.trim() || 'Dismissed from the Queue by the owner',
      priorIdeaLifecycle: item.ref.priorIdeaLifecycle ?? null,
      priorDecidedReason: typeof item.ref.priorDecidedReason === 'string' ? item.ref.priorDecidedReason : null,
    });
    if (restored !== 'reopened' && restored !== 'already_open') {
      throw new Error(`improvement ${issueId} could not reopen: ${restored}`);
    }
    note = `reopened improvement ${issueId}`;
  } else if (sourceKind === 'work-item-needs-human') {
    const workItemId = field({ kind: '', ...item.ref }, 'workItemId');
    const ownerGate = field({ kind: '', ...item.ref }, 'ownerGate');
    const priorStatus = field({ kind: '', ...item.ref }, 'priorStatus');
    const harnessSlug = field({ kind: '', ...item.ref }, 'harnessSlug');
    if (!workItemId || (ownerGate !== 'status' && ownerGate !== 'payload') || !priorStatus) {
      throw new Error('work-item-needs-human compensation missing workItemId/ownerGate/priorStatus');
    }
    const restored = await deps.restoreWorkItemOwnerGate({
      workItemId,
      harnessSlug,
      ownerGate,
      priorStatus,
      ownerGateKeys: stringArray(item.ref.ownerGateKeys),
    });
    if (restored !== 'restored' && restored !== 'already_restored') {
      throw new Error(`work-item owner gate ${workItemId} could not restore: ${restored}`);
    }
    note = `restored owner gate on work item ${workItemId}`;
  } else {
    throw new Error(`source-mutating compensation for '${sourceKind}' is not registered`);
  }

  await deps.clearTriage(item.itemId, workspaceId, sql);
  return note;
}

/** Shared registry target used by autonomy/tripwire/revert-executor. */
export async function revertAttentionBulkItemHandle(
  handle: RevertHandle,
  deps: AttentionBulkReversalDependencies = DEFAULT_DEPS,
): Promise<RevertOutcome> {
  const workspaceId = field(handle, 'workspaceId');
  const runId = field(handle, 'runId');
  const itemId = field(handle, 'itemId');
  if (handle.kind !== ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND || !workspaceId || !runId || !itemId) {
    return { reverted: false, note: 'invalid attention-bulk-item pointer' };
  }

  try {
    const outcome = await executeBulkRunItemReversal({
      workspaceId,
      runId,
      itemId,
      async execute(item, sql) {
        return {
          result: null,
          note: await compensateAttentionBulkRunItem(item, workspaceId, sql, deps),
        };
      },
    });
    if (outcome.refused) {
      return { reverted: false, note: `attention bulk reversal refused: ${outcome.refused}` };
    }
    return {
      reverted: true,
      note: outcome.item?.revertNote ?? `reverted attention bulk item ${itemId}`,
    };
  } catch (error) {
    return {
      reverted: false,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}
