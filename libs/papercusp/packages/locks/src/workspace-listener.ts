/**
 * Refcounted shared LISTEN connection per workspace.
 *
 * One LISTEN subscription per workspace channel `ch_coord_<wsId>`,
 * shared across every waiter on that workspace. Each subscriber gets
 * every payload and filters by its own ticket_id — the listener is a
 * bare wake-bus, not a router.
 *
 * postgres-js's `sql.listen()` handles reconnects automatically; on
 * resume it re-sends LISTEN. Audit 4 #3 wanted explicit re-issue; the
 * library does it for us. The 30s ceiling on each await iteration in
 * acquire.ts is the second-layer safety net for any silent drop the
 * library misses.
 *
 * Listener-pool cap (reviewer #3): MAX_ACTIVE_WORKSPACES = 20.
 * 21st workspace's subscribeWorkspace throws TooManyActiveWorkspacesError
 * so the caller can return a clean `too_many_active_workspaces` rather
 * than hanging on a full connection pool.
 *
 * This module also owns the BACKGROUND EXPIRY JANITOR (file-locking #4):
 * the 30s timer that periodically calls runBackgroundJanitorOnce(). It
 * lives here — alongside the listener subscriptions — because this is
 * the locks subsystem's home for long-lived background state; the sweep
 * WORK itself stays in su-lock-store.ts (storage layer). inWorkspaceTxn
 * arms the timer on the first mutating op.
 */

import { createHash } from 'node:crypto';
import { getListenerPool, resetListenerPoolAfterTimeout, runBackgroundJanitorOnce } from './su-lock-store';
import { managedSetInterval } from '@papercusp/scheduled-registry';

const MAX_ACTIVE_WORKSPACES = 20;

/**
 * EI-19404227117727730: postgres-js provides no query-level timeout of its
 * own — `sql.listen()`/`unlisten()` (like any `sql\`...\`` call) just awaits
 * a response that, if the underlying connection died silently, never comes.
 * This bounds each LISTEN/UNLISTEN op so a dead connection surfaces as a
 * fast, clear failure instead of hanging the caller (and everything
 * downstream of it — e.g. db:migrate's exclusive(db-schema) hold) forever.
 * 20s is generous for a command that normally completes in milliseconds, and
 * tiny next to the resource TTLs (minutes) a stuck caller would otherwise
 * block. Overridable for tests / an unusually loaded box.
 */
const LISTEN_OP_TIMEOUT_MS = Math.max(1000, Number(process.env.PAPERCUSP_LISTEN_OP_TIMEOUT_MS) || 20_000);

/** Thrown by {@link withListenTimeout} when the raced promise never settles
 *  in time. Exported for tests; callers should treat it as "the LISTEN
 *  connection is presumed dead" and call {@link recoverFromDeadListenConnection}. */
export class ListenOpTimeoutError extends Error {
  constructor(op: string) {
    super(`listen_op_timeout: ${op} exceeded ${LISTEN_OP_TIMEOUT_MS}ms — the LISTEN connection is presumed dead`);
    this.name = 'ListenOpTimeoutError';
  }
}

/** Race `p` against {@link LISTEN_OP_TIMEOUT_MS}; rejects with
 *  {@link ListenOpTimeoutError} on timeout, otherwise settles exactly as `p`
 *  does. Never leaves a dangling timer (cleared on either outcome). Exported
 *  + pure(ish) for unit testing. */
export function withListenTimeout<T>(op: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ListenOpTimeoutError(op)), LISTEN_OP_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * A timed-out listen/unlisten means the pool's single dedicated LISTEN
 * connection is presumed dead for EVERY channel it serves, not just the one
 * that timed out — so self-heal by discarding the whole pool (the next
 * `getListenerPool()` call rebuilds a clean connection + clean
 * postgres-js-internal listen state) and dropping every subscription this
 * module was tracking on it.
 *
 * A subscriber that loses its LISTEN this way is not left blind:
 * `acquireResourceExclusiveWithWait`'s own `WAIT_CEILING_MS` poll loop
 * re-checks lock status every 5s independent of any NOTIFY — correctness
 * never depended on LISTEN succeeding, only latency does. Exported for
 * tests.
 */
export function recoverFromDeadListenConnection(): void {
  STATE.clear();
  resetListenerPoolAfterTimeout();
}

/**
 * The per-domain NOTIFY/LISTEN channel: `ch_coord_` + md5(domain) = 41
 * bytes, always under PG's 63-byte channel-name cap.
 *
 * Why hashed: the coordination domain is a repo-root realpath, and PG's
 * limit behaves asymmetrically — LISTEN (identifier syntax) silently
 * TRUNCATES a >63-byte name while pg_notify() (text arg) RAISES
 * "channel name too long". With a long checkout path (the live release
 * checkout produced a 65-byte raw name) every grant cascade's NOTIFY
 * aborted the surrounding release/poke transaction, so a held lock could
 * not be released while a waiter was queued. The hash is applied
 * UNCONDITIONALLY so this side and the SQL side (`coord_notify_channel()`
 * in sql/013-bounded-notify-channel.sql) can never disagree.
 */
export function coordNotifyChannel(coordinationDomain: string): string {
  return `ch_coord_${createHash('md5').update(coordinationDomain).digest('hex')}`;
}

type Listener = (ticketId: string, kind: string) => void;

interface WorkspaceState {
  unlisten: () => Promise<void>;
  listeners: Set<Listener>;
}

const STATE = new Map<string, WorkspaceState>();

export class TooManyActiveWorkspacesError extends Error {
  constructor() {
    super('too_many_active_workspaces');
    this.name = 'TooManyActiveWorkspacesError';
  }
}

/**
 * Subscribe to grant notifications on a workspace. The callback fires
 * for EVERY payload on the channel — the caller filters by its own
 * ticket_id. Returns an unsubscribe fn the caller MUST invoke when the
 * wait completes.
 */
export async function subscribeWorkspace(
  coordinationDomain: string,
  listener: Listener,
): Promise<() => Promise<void>> {
  let state = STATE.get(coordinationDomain);

  if (!state) {
    if (STATE.size >= MAX_ACTIVE_WORKSPACES) {
      throw new TooManyActiveWorkspacesError();
    }
    const sql = getListenerPool();
    const channel = coordNotifyChannel(coordinationDomain);
    const listeners = new Set<Listener>();

    const req = sql.listen(channel, (payload) => {
      // Payload format: "<ticket_id>" or "<ticket_id>:<kind>".
      // grant_cascade.sql sends just ticket_id; ":kind" is reserved.
      const colon = payload.indexOf(':');
      const tid = colon >= 0 ? payload.slice(0, colon) : payload;
      const kind = colon >= 0 ? payload.slice(colon + 1) : 'granted';
      // Iterate defensively: one subscriber's callback throwing must
      // not prevent siblings from waking. Subscribers should never
      // throw (the wake-resolver is trivial code) but defense-in-depth
      // is cheap.
      for (const cb of listeners) {
        try {
          cb(tid, kind);
        } catch {
          /* swallow — listener bus must stay alive */
        }
      }
    });
    // EI-19404227117727730: bounded — an unbounded `await req` here is what
    // let a dead LISTEN connection hang every future subscribeWorkspace
    // caller (across every domain, not just this one) forever.
    let result: Awaited<typeof req>;
    try {
      result = await withListenTimeout('listen', req);
    } catch (e) {
      if (e instanceof ListenOpTimeoutError) recoverFromDeadListenConnection();
      throw e;
    }

    state = { unlisten: result.unlisten, listeners };
    STATE.set(coordinationDomain, state);
  }

  state.listeners.add(listener);

  return async () => {
    const cur = STATE.get(coordinationDomain);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      STATE.delete(coordinationDomain);
      try {
        // EI-19404227117727730: bounded for the same reason as the listen()
        // await above — this is the exact call that left db:migrate hung
        // for 300s+ with the exclusive(db-schema) resource already granted
        // but guardResource's run() never invoked (psql never spawned).
        await withListenTimeout('unlisten', cur.unlisten());
      } catch (e) {
        // Best-effort — pool may already be torn down, or (now) reset.
        if (e instanceof ListenOpTimeoutError) recoverFromDeadListenConnection();
      }
    }
  };
}

// ───────── Background expiry janitor (file-locking #4) ─────────

/** Period of the background expiry sweep. */
const BACKGROUND_JANITOR_INTERVAL_MS = 30_000;

let janitorTimer: ReturnType<typeof managedSetInterval> | null = null;
let janitorPassInFlight = false;

/**
 * Arm the 30s background janitor. Idempotent — a second call while the
 * timer is already armed is a no-op. Armed by inWorkspaceTxn on the
 * first mutating locks:* op in a non-test process; tests skip the timer
 * and call runBackgroundJanitorOnce() directly so no wall-clock tick
 * races their fixtures.
 *
 * The interval is unref'd — it never keeps the process alive on its
 * own — and a pass never overlaps itself (janitorPassInFlight guard:
 * if a sweep is still running when the next tick fires, that tick is
 * skipped rather than stacked).
 */
export function startBackgroundJanitor(): void {
  if (janitorTimer) return;
  janitorTimer = managedSetInterval(
    'su-locks:background-janitor',
    BACKGROUND_JANITOR_INTERVAL_MS,
    () => {
    if (janitorPassInFlight) return;
    janitorPassInFlight = true;
    void runBackgroundJanitorOnce()
      .catch((err) =>
        console.error('[su-locks] background janitor pass failed', err),
      )
      .finally(() => {
        janitorPassInFlight = false;
      });
    },
    { category: 'global-sweep', classification: 'timeout-reaper' },
  );
}

/** Stop the background janitor. Idempotent. */
export function stopBackgroundJanitor(): void {
  if (janitorTimer) {
    janitorTimer.stop();
    janitorTimer = null;
  }
}

/** Test-only — drop all subscriptions and stop the background janitor. */
export async function _resetListenersForTests(): Promise<void> {
  stopBackgroundJanitor();
  const states = Array.from(STATE.values());
  STATE.clear();
  await Promise.allSettled(states.map((s) => s.unlisten()));
}

export function _activeWorkspaceCount(): number {
  return STATE.size;
}
