/**
 * lock-grant bridge — file-lock grants → targeted await-event wakes
 * (await-event-primitive-2026-06-05 P-007/P-008, D-005/D-009).
 *
 * The waiters queue, FIFO `grant_cascade`, and `ch_coord_*` NOTIFY all
 * pre-exist (@papercusp/locks). This bridge is the missing half: turn a grant
 * for a ticket SOMEONE REGISTERED A WAKE ON into a `lock:grant:<ticket>` emit
 * through the delivery primitive, so a blocked agent can queue + SLEEP instead
 * of holding a 300s server-side wait or pivot-polling.
 *
 * Two complementary paths (D-009):
 *   - NOTIFY fast path: while any lock-grant await is outstanding, one
 *     persistent listener per coordination domain turns each grant NOTIFY
 *     into an immediate reconcile of that ticket. Best-effort — the listener
 *     pool may be full, the host may restart; never load-bearing.
 *   - Reconciliation backstop (load-bearing, D-004): every await-sweep tick,
 *     outstanding `lock:grant:%` awaits are checked against waiter-table
 *     TRUTH (readWaiterStatus) — granted/terminal tickets fire even when the
 *     NOTIFY was missed. Worst-case added latency = one sweep interval.
 *
 * Locks stay single-grant control-plane (coordination-substrate D-007): the
 * cascade still grants to exactly ONE waiter; the emit is targeted at that
 * waiter's ticket key. No path-glob fan-out — the retired fireNotifications
 * stays retired.
 */

import { emitAwaitedEvent, registerAwaitReconciler } from '../../events/await/engine';
import { listActiveAwaitsByKeyPrefix } from '../../events/await/store';
import { getTxPool, readWaiterStatus } from './su-lock-store';
import { subscribeWorkspace } from './workspace-listener';
import { applyPendingEditOnGrant } from './apply-on-grant';

// Key helpers live in ./lock-grant-key (broken out to avoid a module cycle with
// apply-on-grant). Imported for local use AND re-exported so existing
// `from './lock-grant-bridge'` importers keep resolving.
import { LOCK_GRANT_KEY_PREFIX, lockGrantKey, ticketFromLockGrantKey } from './lock-grant-key';
export { LOCK_GRANT_KEY_PREFIX, lockGrantKey, ticketFromLockGrantKey };

/** Injectable seams for tests. */
export interface BridgeDeps {
  /** Ticket → waiter truth. Default reads the locks side-DB via getTxPool(). */
  readStatus?: (ticketId: string) => ReturnType<typeof readWaiterStatus>;
  emit?: typeof emitAwaitedEvent;
  listAwaits?: typeof listActiveAwaitsByKeyPrefix;
  /** Apply-on-grant (EI-9033). Default applies a ticket's attached pending edit
   *  in place of a wake. Returns whether the caller should still fire the grant
   *  wake ('fallback'/'none') or suppress it ('applied'/'in-flight'). */
  applyOnGrant?: typeof applyPendingEditOnGrant;
}

/**
 * Check ONE ticket against waiter truth and fire its await on a terminal
 * state. 'waiting' → no-op (the await stays armed). Returns what it did.
 */
export async function reconcileLockTicket(
  ticketId: string,
  workspaceId?: string,
  deps: BridgeDeps = {},
): Promise<'fired-granted' | 'fired-terminal' | 'waiting' | 'no-op' | 'applied'> {
  const readStatus = deps.readStatus ?? ((tid: string) => readWaiterStatus(getTxPool(), tid));
  const emit = deps.emit ?? emitAwaitedEvent;
  const applyOnGrant = deps.applyOnGrant ?? applyPendingEditOnGrant;

  const status = await readStatus(ticketId);
  if (status.status === 'waiting') return 'waiting';

  if (status.status === 'granted' && status.granted_lock_id) {
    // Apply-on-grant (EI-9033): if the ticket carries a pending edit and it
    // still applies cleanly, land it mechanically + notify passively INSTEAD of
    // waking the agent to retry. Only 'fallback'/'none' fall through to the wake
    // (region changed under the holder, or no pending edit was attached).
    const disposition = await applyOnGrant(ticketId, workspaceId, {});
    if (disposition === 'applied') return 'applied';
    if (disposition === 'in-flight') return 'no-op';

    await emit({
      key: lockGrantKey(ticketId),
      summary: `file lock GRANTED — you now hold ${ (status.paths ?? []).join(', ') || 'your requested paths' } (lock ${status.granted_lock_id}). The TTL is already running: do the edit, then locks:release.`,
      payload: {
        granted: true,
        lock_id: status.granted_lock_id,
        expires_ts: status.granted_expires_ts?.toISOString?.() ?? status.granted_expires_ts ?? null,
        paths: status.paths ?? [],
        ticket_id: ticketId,
      },
      source: 'lock-grant-bridge',
      workspaceId,
    });
    return 'fired-granted';
  }

  // A waiter row keeps its historical 'granted' status after the owner releases
  // the lock. The status reader derives 'released'/'expired' when the full lock
  // set is no longer live, so never turn that stale history into an edit claim.
  if (status.status === 'released' || (status.status === 'expired' && status.granted_lock_id)) {
    await emit({
      key: lockGrantKey(ticketId),
      summary: `file-lock grant is no longer held (ticket ${status.status}). Do not edit; re-queue or pivot.`,
      payload: { granted: false, ticket_status: status.status, ticket_id: ticketId },
      source: 'lock-grant-bridge',
      workspaceId,
    });
    return 'fired-terminal';
  }

  // expired / cancelled / missing — the queue wait lapsed without a grant.
  // The waiter should know (re-queue or pivot is THEIR call), so this fires too.
  await emit({
    key: lockGrantKey(ticketId),
    summary: `file-lock queue wait ended WITHOUT a grant (ticket ${status.status}). Re-queue with locks:acquire { wake_on_grant: true } or pivot.`,
    payload: { granted: false, ticket_status: status.status, ticket_id: ticketId },
    source: 'lock-grant-bridge',
    workspaceId,
  });
  return 'fired-terminal';
}

/**
 * The sweep-tick reconciler (registered below): every outstanding lock-grant
 * await is re-derived from waiter truth. Cheap — bounded by the handful of
 * agents asleep on locks.
 */
export async function reconcileLockGrantAwaits(workspaceId: string, deps: BridgeDeps = {}): Promise<void> {
  const listAwaits = deps.listAwaits ?? listActiveAwaitsByKeyPrefix;
  const awaits = await listAwaits(LOCK_GRANT_KEY_PREFIX);
  for (const a of awaits) {
    const ticket = ticketFromLockGrantKey(a.eventKey);
    if (!ticket) continue;
    try {
      await reconcileLockTicket(ticket, workspaceId, deps);
    } catch (e) {
      console.warn(
        `[lock-grant-bridge] reconcile ${ticket} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

// ── NOTIFY fast path ──────────────────────────────────────────────────────────

const liveListeners = new Map<string, () => Promise<void>>();

/**
 * Ensure a persistent grant listener on a coordination domain while lock-grant
 * awaits may be outstanding. Best-effort: a pool-full error just means the
 * sweep backstop carries the latency. Idempotent per domain.
 */
export async function ensureGrantListener(coordinationDomain: string, workspaceId?: string): Promise<void> {
  if (liveListeners.has(coordinationDomain)) return;
  try {
    const unsubscribe = await subscribeWorkspace(coordinationDomain, (ticketId) => {
      // Payload = the granted ticket. Only reconcile if someone awaits it —
      // blocking waiters (locks:acquire{wait}) handle their own NOTIFYs.
      void (async () => {
        const awaits = await listActiveAwaitsByKeyPrefix(lockGrantKey(ticketId));
        if (awaits.length > 0) await reconcileLockTicket(ticketId, workspaceId);
      })().catch(() => {
        /* the sweep backstop covers it */
      });
    });
    liveListeners.set(coordinationDomain, unsubscribe);
  } catch {
    /* pool full / PG hiccup — the sweep backstop covers it */
  }
}

// The load-bearing half registers at import (agent-tools/locks/acquire imports
// this module): every await-sweep tick re-derives outstanding lock awaits from
// waiter truth (no-op when none are outstanding — one bounded indexed read).
registerAwaitReconciler((ws) => reconcileLockGrantAwaits(ws));
