import { captureWakeHandleForOwner } from './events/await/handle';
import {
  cancelAwait,
  listActiveAwaits,
  registerAwait,
  retireLifecycleBoundWatches,
} from './events/await/store';
import type { LifecycleBinding } from './events/await/types';

export interface InterestAutoArmHandle {
  event_keys: string[];
  await_ids: number[];
  cancel: { tool: 'events:cancel'; args: { await_ids: number[] } } | null;
  handle_note: string;
}

export interface InterestAutoArmDeps {
  captureHandle: typeof captureWakeHandleForOwner;
  listActive: typeof listActiveAwaits;
  register: typeof registerAwait;
  cancel: typeof cancelAwait;
}

const defaultDeps: InterestAutoArmDeps = {
  captureHandle: captureWakeHandleForOwner,
  listActive: listActiveAwaits,
  register: registerAwait,
  cancel: cancelAwait,
};

/**
 * The event interests a CLAIM HOLDER may safely await for its own item.
 *
 * `claim:released:<id>` is a delegator/leader signal: it wakes someone waiting
 * for another holder to put an item back into the pool. A holder awaiting the
 * release of its own claim can never make progress, because only that sleeping
 * holder can release it. Keep this helper pure so the self-deadlock exclusion is
 * independently pinned from the database-backed arm path.
 */
export function holderBlockerInterestEventKeys(
  workItemId: string,
  blockerIds: readonly string[],
): string[] {
  const ids = [...new Set(blockerIds.map((id) => id.trim()).filter(Boolean))];
  return ids.length > 0
    ? [...ids.map((id) => `work-item:done:${id}`), `work-item:unblocked:${workItemId}`]
    : [];
}

/** Reconcile one lifecycle's exact, one-shot event interests for one owner. */
export async function reconcileInterestEventAwaits(
  input: {
    ownerId: string;
    eventKeys: readonly string[];
    boundTo: LifecycleBinding;
    note: string;
  },
  deps: InterestAutoArmDeps = defaultDeps,
): Promise<InterestAutoArmHandle> {
  const eventKeys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (eventKeys.length === 0) {
    await retireLifecycleBoundWatches(input.boundTo, { ownerIds: [input.ownerId] });
    return { event_keys: [], await_ids: [], cancel: null, handle_note: 'no live lifecycle edges remain' };
  }

  const [{ handle, note }, active] = await Promise.all([
    deps.captureHandle(input.ownerId),
    deps.listActive(input.ownerId),
  ]);
  const desired = new Set(eventKeys);
  const bound = active.filter(
    (row) => row.boundTo?.kind === input.boundTo.kind && row.boundTo.ref === input.boundTo.ref,
  );
  const awaitIds: number[] = [];

  for (const key of eventKeys) {
    const candidates = bound.filter((row) => row.eventKey === key);
    const keep = candidates.find(
      (row) => row.policy === 'wake' && row.once === true && (handle == null || row.wakeHandle != null),
    );
    for (const row of candidates) {
      if (row !== keep) await deps.cancel({ awaitId: row.id, subscriberId: input.ownerId });
    }
    if (keep) {
      awaitIds.push(keep.id);
      continue;
    }
    const row = await deps.register({
      subscriberId: input.ownerId,
      eventKey: key,
      policy: 'wake',
      note: `${input.note}: ${key}`,
      wakeHandle: handle,
      timeoutBehavior: 'wake',
      timeoutSec: null,
      once: true,
      boundTo: input.boundTo,
    });
    awaitIds.push(row.id);
  }

  for (const row of bound) {
    if (!desired.has(row.eventKey)) await deps.cancel({ awaitId: row.id, subscriberId: input.ownerId });
  }

  return {
    event_keys: eventKeys,
    await_ids: awaitIds,
    cancel: awaitIds.length > 0 ? { tool: 'events:cancel', args: { await_ids: awaitIds } } : null,
    handle_note: note,
  };
}

export async function retireInterestEventAwaits(
  boundTo: LifecycleBinding,
  ownerId?: string | null,
): Promise<void> {
  await retireLifecycleBoundWatches(boundTo, ownerId ? { ownerIds: [ownerId] } : {});
}
