/**
 * Replay-safe DBOS consumer bridge for the canonical work-item completion event.
 *
 * This is called INSIDE a DBOS workflow. It reads the existing work-item row and
 * event_key_fires latch; the DBOS workflow recovers and rechecks after a crash.
 * Reads are deliberately not checkpointed as DBOS steps: after a workflow
 * replay, the current business state (including reopen) must be re-read.
 * The event is an executor signal; the work item remains the outcome authority.
 * The conditional delay is not recorded as a DBOS operation, because replay
 * may see a different current state and must not skip a recorded sleep.
 */
import { runWithWorkspace } from '../workspace-als';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { getWorkItem, isSettledWorkItemState, type WorkItem } from '../work-items';
import { ALL_SUCCESSFUL_STATUSES } from '../work-item-blocking';
import { completionEventIntentIdOf } from '../work-items-events';
import { getKeyFireLatch } from '../events/await/store';
import type { KeyFireRow } from '../events/await/types';
import { getBlueprintOperationResult, type BlueprintOperationHandle } from '../blueprint/operation-service';

export interface WorkItemEventWaitInput {
  itemId: string;
  harnessSlug: string;
  workspaceId: string;
  /** Absolute deadline persists across a DBOS replay; a relative timeout would reset. */
  deadlineAt: string;
  pollMs?: number;
}

export type WorkItemEventWaitResult =
  | {
      kind: 'settled';
      itemId: string;
      state: string;
      successful: boolean;
      source: 'completion-event' | 'current-state';
      completionIntentId: string | null;
    }
  | { kind: 'pending'; itemId: string; lastState: string | null; reason: 'deadline' };

export interface WorkItemEventWaitDeps {
  readItem?: (input: WorkItemEventWaitInput) => Promise<WorkItem | null>;
  readLatch?: (eventKey: string) => Promise<KeyFireRow | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function latchedIntent(latch: KeyFireRow | null): string | null {
  const payload = latch?.lastPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const token = (payload as Record<string, unknown>).completionIntentId;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

async function hasValidatedSuccess(item: WorkItem, input: WorkItemEventWaitInput): Promise<boolean> {
  if (!ALL_SUCCESSFUL_STATUSES.has(item.state) ||
      (item.completionAuthority !== 'committed' && item.completionAuthority !== 'validated')) return false;
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : null;
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'blueprintOperation')) return true;
  const pin = payload.blueprintOperation;
  const result = payload.blueprintResult;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
      !result || typeof result !== 'object' || Array.isArray(result)) return false;
  const accepted = pin as Record<string, unknown>;
  const completed = result as Record<string, unknown>;
  if (accepted.kind !== 'blueprint-operation' || typeof accepted.callerId !== 'string' ||
      typeof accepted.operationId !== 'string' || typeof accepted.specificationRevision !== 'string' ||
      typeof accepted.requestKey !== 'string' ||
      completed.operationId !== accepted.operationId ||
      completed.specificationRevision !== accepted.specificationRevision ||
      typeof completed.evidenceRef !== 'string' || !completed.evidenceRef.trim() ||
      !Object.prototype.hasOwnProperty.call(completed, 'output')) return false;

  // A shaped stored result can still violate its retained output schema or
  // model policy. Consume the same pinned result as the public operation API.
  const sql = getOrgPg().sql;
  const receipts = await runWithWorkspace(input.workspaceId, () => sql<Array<{ id: string | number }>>`
    SELECT id FROM harness_shared.blueprint_operation_invocations
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
       AND caller_id = ${accepted.callerId as string} AND operation_id = ${accepted.operationId as string}
       AND request_key = ${accepted.requestKey as string}
       AND specification_revision = ${accepted.specificationRevision as string}
       AND target_kind = 'work-item' AND target_ref = ${item.id}
  `);
  const receiptId = Number(receipts[0]?.id);
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return false;
  const handle: BlueprintOperationHandle = {
    workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, receiptId,
    operationId: accepted.operationId, specificationRevision: accepted.specificationRevision,
    target: { kind: 'work-item', id: item.id },
  };
  return (await getBlueprintOperationResult(sql, handle, accepted.callerId)).state === 'ready';
}

async function defaultReadItem(input: WorkItemEventWaitInput): Promise<WorkItem | null> {
  return runWithWorkspace(input.workspaceId, () => getWorkItem(input.itemId, input.harnessSlug));
}

async function defaultSleep(ms: number): Promise<void> {
  await delay(ms);
}

/** Await a published completion or an already-settled current item.
 * A pending completion intent requires its matching latched event before
 * success; a late consumer of an acknowledged/legacy item reads terminal
 * state immediately. A reopen invalidates the earlier result before return. */
export async function awaitWorkItemCompletionEvent(
  input: WorkItemEventWaitInput,
  deps: WorkItemEventWaitDeps = {},
): Promise<WorkItemEventWaitResult> {
  if (!input.itemId || !input.harnessSlug || !input.workspaceId) throw new Error('work-item event wait needs exact scope');
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('work-item event wait needs an absolute deadlineAt');
  const pollMs = input.pollMs ?? 10_000;
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('pollMs must be 100..60000');

  const readItem = deps.readItem ?? defaultReadItem;
  const readLatch = deps.readLatch ?? getKeyFireLatch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let lastState: string | null = null;
  for (;;) {
    const item = await readItem(input);
    if (item && item.harness !== input.harnessSlug) throw new Error('work-item event wait read outside harness');
    lastState = item?.state ?? null;
    if (item && isSettledWorkItemState(item.state)) {
      const pendingIntent = completionEventIntentIdOf(item);
      const latch = pendingIntent ? await readLatch(`work-item:done:${input.itemId}`) : null;
      if (!pendingIntent || latchedIntent(latch) === pendingIntent) {
        // A reopen can win between the state and latch reads. The final live
        // read fences that old completion before the consumer resumes.
        const current = await readItem(input);
        const currentIntent = current ? completionEventIntentIdOf(current) : null;
        if (current && current.harness === input.harnessSlug && isSettledWorkItemState(current.state) &&
            (!currentIntent || currentIntent === pendingIntent)) {
          const successful = await hasValidatedSuccess(current, input);
          // Pinned result validation reads the specification and current item
          // asynchronously. Recheck after it: a reopen during that read must
          // not return the old cycle's settlement to this waiter.
          const confirmed = await readItem(input);
          if (confirmed && confirmed.harness !== input.harnessSlug) {
            throw new Error('work-item event wait read outside harness');
          }
          if (confirmed && confirmed.state === current.state &&
              confirmed.completionAuthority === current.completionAuthority &&
              isSettledWorkItemState(confirmed.state) &&
              completionEventIntentIdOf(confirmed) === currentIntent &&
              isDeepStrictEqual(
                (confirmed.payload as Record<string, unknown> | null)?.blueprintResult,
                (current.payload as Record<string, unknown> | null)?.blueprintResult,
              )) {
            return {
              kind: 'settled', itemId: input.itemId, state: confirmed.state,
              successful, source: pendingIntent ? 'completion-event' : 'current-state',
              completionIntentId: pendingIntent,
            };
          }
          lastState = confirmed?.state ?? null;
        } else {
          lastState = current?.state ?? null;
        }
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: 'pending', itemId: input.itemId, lastState, reason: 'deadline' };
    await sleep(Math.min(pollMs, remaining));
  }
}
