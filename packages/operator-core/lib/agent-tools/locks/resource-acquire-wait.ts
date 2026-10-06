/**
 * resource-acquire-wait — the exclusive drain wait loop (Phase 4, P-006).
 *
 * Acquires a named resource in `exclusive` mode and, while live shared
 * holders remain (status 'draining'), blocks until the drain completes
 * (resource_grant_cascade flips it to 'held' and NOTIFYs) or max_drain_sec
 * elapses. Mirrors locks:acquire's wait protocol:
 *
 *   1. subscribeWorkspace (LISTEN ch_coord_<domain>) BEFORE the acquire,
 *      so a drain-completion NOTIFY for our exclusive can't be lost.
 *   2. tryAcquireResource(exclusive). held → return; draining → wait.
 *   3. await NOTIFY with a WAIT_CEILING_MS ceiling per iteration; on each
 *      wake, pokeResource (sweep expired shared + cascade) so a TTL-lapsed
 *      holder still completes the drain, then re-read status.
 *   4. status held → granted; deadline passed → drain_timeout (the
 *      exclusive row is LEFT in place — the writer still wants in; it
 *      TTL-expires or the caller releases — so the caller can force-
 *      proceed or escalate, per P-006/D-005).
 *
 * The drain-START broadcast that tells shared holders to release is Phase 3
 * (P-009, fireNotifications); this loop is correct without it (drain
 * completes whenever holders release or expire), the broadcast just
 * accelerates it.
 */

import {
  getTxPool,
  pokeResource,
  readResourceLockStatus,
  readResourceQueue,
  releaseAllResourcesForOwner,
  tryAcquireResource,
  tryReleaseResource,
  type ResourceHolder,
} from './su-lock-store';
import { inWorkspaceTxn, type WorkspaceTxnOptions } from './in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from './contention-retry';
import { subscribeWorkspace } from './workspace-listener';

/** Per-iteration ceiling: re-poll status at least this often even if the
 *  LISTEN connection silently dropped a wake. */
const WAIT_CEILING_MS = 5_000;

/**
 * WI-2140648: a caller that opted into a bounded drain wait must keep its
 * PostgreSQL advisory-lock FIFO position for that same budget. The generic
 * workspace transaction defaults to 5s; retrying after that timeout requeues
 * the caller behind every new git-sync fire and can starve forever under a
 * steady fan-out. These are floors, so a wider live db:txn-timeouts setting is
 * never narrowed. The no-wait path keeps the ordinary short transaction.
 */
export function workspaceTxnOptionsForExclusiveWait(maxWaitSec: number): WorkspaceTxnOptions {
  const waitMs = Math.max(0, Math.trunc(maxWaitSec * 1_000));
  return waitMs > 0
    ? { minLockTimeoutMs: waitMs, minStatementTimeoutMs: waitMs }
    : {};
}

/**
 * EI-18674647773291145: is `pid` DEFINITIVELY dead on THIS host? `process.kill(pid,
 * 0)` sends no signal, just probes existence/permission. ESRCH = no such process —
 * the only outcome we treat as dead. EPERM (exists, different user) or anything
 * else is treated as ALIVE — we must never force-reclaim a lock we can't prove is
 * abandoned; a false "dead" verdict would let two live holders race the resource.
 */
export function isPidDefinitivelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

/**
 * How a reclaimed holder was proven dead. Two instruments, two orphan classes:
 *  - `pid-dead`: the owner string embedded a host-local pid and `kill(pid, 0)`
 *    returned ESRCH (EI-18674647773291145) — a crashed deploy-cli / killed
 *    bg-host.
 *  - `session-ended`: the owner is an agent session the shared liveness oracle
 *    calls `ended` (EI-22078335832051825) — a lock left behind by a session that
 *    exited (or is warm-dead) without releasing. Its pid, if any, may be ALIVE.
 */
export type StaleHolderVerdict = 'pid-dead' | 'session-ended';

export interface StaleHolderReclaimedInfo {
  holder: ResourceHolder;
  /** The dead pid for `pid-dead`; null for `session-ended` (no pid was judged). */
  pid: number | null;
  verdict: StaleHolderVerdict;
}

/** The parenthetical every reclaim log line carries — one wording source, so a
 *  reader can tell WHICH instrument condemned the holder. */
export function describeStaleHolderVerdict(info: Pick<StaleHolderReclaimedInfo, 'pid' | 'verdict'>): string {
  return info.verdict === 'pid-dead'
    ? `pid ${info.pid} not running on this host`
    : 'session ended per the shared liveness oracle';
}

/**
 * EI-18674647773291145: reclaim (force-release) any EXCLUSIVE holder among
 * `holders` whose owner string resolves, via `hostLocalOwnerPid`, to a PID that is
 * verifiably dead on this host. Scoped by the holder's own `lock_id` (never a bare
 * owner-match delete), so this can never race-delete a FRESH lease the same owner
 * string re-acquired between the read and this delete. Returns true iff at least
 * one stale holder was actually reclaimed (the caller's cue to retry the acquire).
 *
 * EI-22078335832051825: the PID test is structurally blind to a holder whose
 * owner string names no pid, or whose pid is alive while its SESSION is gone —
 * an agent's `su-…` lease left behind by an ended (or warm-dead) session. Those
 * sat until TTL while coord:presence already reported the holder `ended`. When
 * a `deadOwnerOracle` is supplied (see ended-session-owners.ts — presence-gated,
 * `ended`-only, fail-safe), every exclusive holder the PID test did NOT condemn
 * is put to the oracle in ONE batched call, and an owner it returns is reclaimed
 * exactly like a dead pid — by its own `lock_id`, logged through the same hook.
 * The oracle is consulted only for the residue, so the cheap syscall verdict
 * still short-circuits the common crashed-process case.
 */
export async function reclaimDeadExclusiveHolders(
  coordinationDomain: string,
  owner: string,
  holders: ResourceHolder[],
  hostLocalOwnerPid: (owner: string) => number | null,
  onStaleHolderReclaimed?: (info: StaleHolderReclaimedInfo) => void | Promise<void>,
  deadOwnerOracle?: (owners: readonly string[]) => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  let reclaimedAny = false;
  const reclaimOne = async (holder: ResourceHolder, info: Omit<StaleHolderReclaimedInfo, 'holder'>) => {
    const released = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
      tryReleaseResource(tx, { coordinationDomain, owner: holder.owner, lockId: holder.lock_id }),
    ).catch(() => null);
    if (released && released.released > 0) {
      reclaimedAny = true;
      if (onStaleHolderReclaimed) {
        try {
          await onStaleHolderReclaimed({ holder, ...info });
        } catch {
          /* best-effort — a logging failure must never break the reclaim */
        }
      }
    }
  };

  // Instrument 1: a host-local pid the owner string embeds, verifiably gone.
  const notPidDead: ResourceHolder[] = [];
  for (const holder of holders) {
    if (holder.mode !== 'exclusive') continue;
    const pid = hostLocalOwnerPid(holder.owner);
    if (pid != null && isPidDefinitivelyDead(pid)) {
      await reclaimOne(holder, { pid, verdict: 'pid-dead' });
    } else {
      notPidDead.push(holder);
    }
  }

  // Instrument 2: the shared session-liveness oracle, for the residue only.
  if (deadOwnerOracle && notPidDead.length > 0) {
    let ended: ReadonlySet<string>;
    try {
      ended = await deadOwnerOracle(notPidDead.map((h) => h.owner));
    } catch {
      ended = new Set<string>(); // an oracle failure condemns nobody
    }
    for (const holder of notPidDead) {
      if (!ended.has(holder.owner)) continue;
      await reclaimOne(holder, { pid: null, verdict: 'session-ended' });
    }
  }
  return reclaimedAny;
}

type ConflictReason =
  | 'unknown_resource'
  | 'exclusive_pending'
  | 'holds_shared'
  | 'held_exclusive'
  | 'at_capacity'; // D-008: only on the shared path, but the store's reason union includes it.

export interface ExclusiveWaitParams {
  coordinationDomain: string;
  owner: string;
  ownerLabel: string | null;
  resource: string;
  reason: string;
  ttlSec: number;
  /** 0 = don't wait (return draining immediately); >0 = drain up to N sec. */
  maxWaitSec: number;
  /** Optional progress callback fired each iteration while still draining. */
  onTick?: (info: { waited_sec: number; holders: ResourceHolder[] }) => void;
  /** Fired once when the exclusive enters 'draining' (shared holders present),
   *  with those holders — the hook the tool uses to broadcast drain-start. */
  onDrainStart?: (holders: ResourceHolder[]) => void | Promise<void>;
  /**
   * EI-18674647773291145: when the no-wait acquire (`maxWaitSec: 0`) is blocked by
   * another owner's exclusive, this optionally extracts a HOST-LOCAL pid embedded in
   * that holder's owner string (e.g. deploy-cli's `release-deploy:<pid>:<uuid>`,
   * EI-13729). A holder whose pid resolves and is verifiably DEAD on this host is
   * reclaimed (force-released) and the acquire retried ONCE — turning a crashed
   * holder's full TTL block into a sub-second self-heal instead of a silent outage
   * for the resource's entire TTL. Return null for an owner string this convention
   * doesn't apply to (e.g. a different caller's identity shape) — no-op for those,
   * same behaviour as omitting this field entirely.
   *
   * Consulted on EVERY acquire path, waiting or not. It previously ran only on the
   * no-wait (`maxWaitSec <= 0`) path, on the reasoning that "a waiting caller
   * already has its own TTL/drain recovery" — that was FALSE (EI-18833814302562374):
   * `maxWaitSec` drains SHARED holders only, and an exclusive conflict returns
   * `held_exclusive` immediately, so a waiting caller had strictly LESS recovery
   * than a no-wait one, not more.
   */
  hostLocalOwnerPid?: (owner: string) => number | null;
  /**
   * EI-22078335832051825: the SESSION half of the dead-holder test — given the
   * blocking exclusive owners the pid test did not condemn, return those that
   * are definitively dead sessions (`endedSessionOwners` in
   * ended-session-owners.ts is the production adapter: presence-gated,
   * `ended`-only, fail-safe). Same reclaim + single retry as `hostLocalOwnerPid`;
   * either field alone enables the reclaim pass.
   */
  deadOwnerOracle?: (owners: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Fired once per stale holder actually reclaimed via `hostLocalOwnerPid` or
   *  `deadOwnerOracle` — the caller's hook to log/record it LOUDLY. A leaked lock
   *  silently self-healing is still a defect worth surfacing, never just a quiet
   *  internal retry. `info.verdict` names the instrument that condemned it. */
  onStaleHolderReclaimed?: (info: StaleHolderReclaimedInfo) => void | Promise<void>;
}

export type ExclusiveWaitResult =
  | {
      ok: true;
      status: 'held';
      lock_id: string;
      waited_sec: number;
      shared_holders_at_start: ResourceHolder[];
      /** Monotonic fencing token of the granted exclusive (D-001). */
      fence_seq: number;
    }
  | { ok: true; status: 'draining'; lock_id: string; holders: ResourceHolder[] } // maxWaitSec === 0
  | { ok: false; reason: ConflictReason; holders: ResourceHolder[] }
  | { ok: false; reason: 'drain_timeout'; lock_id: string; holders: ResourceHolder[]; waited_sec: number };

const elapsedSec = (since: number) => Math.floor((Date.now() - since) / 1000);

export async function acquireResourceExclusiveWithWait(
  params: ExclusiveWaitParams,
): Promise<ExclusiveWaitResult> {
  const {
    coordinationDomain: cd,
    owner,
    ownerLabel,
    resource,
    reason,
    ttlSec,
    maxWaitSec,
    onTick,
    onDrainStart,
    hostLocalOwnerPid,
    deadOwnerOracle,
    onStaleHolderReclaimed,
  } = params;
  const startedAt = Date.now();
  const workspaceTxnOptions = workspaceTxnOptionsForExclusiveWait(maxWaitSec);

  // EI-22466898351484526: the first exclusive transaction is itself exposed to
  // same-workspace advisory-lock contention. Retry the whole transaction after
  // a transient 55P03/57014 so guardResource does not fail before it can drain
  // or mutate anything. The transaction wrapper rolls back on timeout, so each
  // retry gets a fresh transaction while preserving the caller's wait budget.
  const doAcquire = () =>
    acquireWithContentionRetry(() =>
      inWorkspaceTxn(
        cd,
        owner,
        (tx) =>
          tryAcquireResource(tx, {
            coordinationDomain: cd,
            resource,
            mode: 'exclusive',
            owner,
            ownerLabel,
            reason,
            ttlSec,
          }),
        workspaceTxnOptions,
      ),
    );

  /**
   * `doAcquire`, plus ONE dead-holder reclaim + retry when the conflict is
   * another owner's exclusive.
   *
   * EI-18674647773291145: a coalesce blocked by another owner's exclusive is
   * ALSO the shape a crashed holder's leaked lock takes — before accepting it,
   * give the caller one chance to identify + reclaim a definitively-dead holder
   * and retry, rather than returning `held_exclusive` for the resource's full
   * TTL (the 20-minute deploy outage that closed).
   *
   * EI-18833814302562374: this MUST run on every acquire path, not just the
   * no-wait one. `maxWaitSec > 0` buys a drain wait for SHARED holders only —
   * an exclusive conflict returns `held_exclusive` immediately (see the waiting
   * path below), so a waiting caller has NO recovery of its own and fails
   * instantly against a dead holder. That asymmetry is what left `dev-server`
   * (deploy's `withDrain`, maxDrainSec 120) blocked for the holder's full TTL
   * while `release-deploy` (maxDrainSec 0) self-healed in the same process.
   */
  const acquireReclaimingDeadHolders = async () => {
    let r = await doAcquire();
    if (!r.ok && r.reason === 'held_exclusive' && (hostLocalOwnerPid || deadOwnerOracle)) {
      const reclaimed = await reclaimDeadExclusiveHolders(
        cd,
        owner,
        r.holders,
        hostLocalOwnerPid ?? (() => null),
        onStaleHolderReclaimed,
        deadOwnerOracle,
      );
      if (reclaimed) r = await doAcquire();
    }
    return r;
  };

  // No-wait path: acquire once and report whatever we get.
  if (maxWaitSec <= 0) {
    const r = await acquireReclaimingDeadHolders();
    if (!r.ok) return { ok: false, reason: r.reason, holders: r.holders };
    if (r.status === 'held') {
      return { ok: true, status: 'held', lock_id: r.lock_id, waited_sec: 0, shared_holders_at_start: r.shared_holders, fence_seq: r.fence_seq };
    }
    return { ok: true, status: 'draining', lock_id: r.lock_id, holders: r.shared_holders };
  }

  let lockId: string | null = null;
  let wakeResolve: (() => void) | null = null;
  let pendingWake = false;
  let unsubscribe: (() => Promise<void>) | null = null;

  // Step 1: subscribe BEFORE the acquire. We don't know lock_id yet — the
  // callback matches it once it's assigned below.
  try {
    unsubscribe = await subscribeWorkspace(cd, (tid) => {
      if (lockId && tid === lockId) {
        pendingWake = true;
        if (wakeResolve) {
          const r = wakeResolve;
          wakeResolve = null;
          r();
        }
      }
    });
  } catch {
    // LISTEN-pool saturated (too many active workspaces). Fall back to a
    // single no-wait acquire so the caller still gets a structured result.
    const r = await acquireReclaimingDeadHolders();
    if (!r.ok) return { ok: false, reason: r.reason, holders: r.holders };
    if (r.status === 'held') {
      return { ok: true, status: 'held', lock_id: r.lock_id, waited_sec: 0, shared_holders_at_start: r.shared_holders, fence_seq: r.fence_seq };
    }
    return { ok: true, status: 'draining', lock_id: r.lock_id, holders: r.shared_holders };
  }

  try {
    const acquired = await acquireReclaimingDeadHolders();
    if (!acquired.ok) {
      // NB (EI-18833814302562374): this returns IMMEDIATELY — the drain loop
      // below waits out SHARED holders only, never an exclusive one. So the
      // reclaim above is a waiting caller's only defence against a dead holder,
      // not a redundant belt-and-braces on top of `maxWaitSec`.
      return { ok: false, reason: acquired.reason, holders: acquired.holders };
    }
    if (acquired.status === 'held') {
      return {
        ok: true,
        status: 'held',
        lock_id: acquired.lock_id,
        waited_sec: 0,
        shared_holders_at_start: acquired.shared_holders,
        fence_seq: acquired.fence_seq,
      };
    }

    // Draining — arm the callback match + wait.
    lockId = acquired.lock_id;
    const sharedAtStart = acquired.shared_holders;
    const deadline = startedAt + maxWaitSec * 1000;

    // Drain-start hook (P-009) — let the caller broadcast "release please".
    if (onDrainStart) {
      try {
        await onDrainStart(sharedAtStart);
      } catch {
        // best-effort — a broadcast failure must never break the drain wait.
      }
    }

    // Re-check once: drain may have completed between our acquire commit
    // and arming the wake (a shared release racing our INSERT).
    const recheck = await readResourceLockStatus(getTxPool(), lockId);
    if (recheck.status === 'held') {
      return { ok: true, status: 'held', lock_id: lockId, waited_sec: elapsedSec(startedAt), shared_holders_at_start: sharedAtStart, fence_seq: recheck.fence_seq ?? 0 };
    }

    while (Date.now() < deadline) {
      if (pendingWake) {
        pendingWake = false;
      } else {
        const ceiling = Math.min(deadline - Date.now(), WAIT_CEILING_MS);
        let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
        await new Promise<void>((resolve) => {
          wakeResolve = resolve;
          ceilingTimer = setTimeout(() => {
            if (wakeResolve) {
              const r = wakeResolve;
              wakeResolve = null;
              r();
            }
          }, ceiling);
        });
        if (ceilingTimer !== null) clearTimeout(ceilingTimer);
        wakeResolve = null;
      }

      // Nudge: a TTL-lapsed shared holder fires no cascade on its own.
      // WI-10004638: a transient contention timeout here (the sweep runs under a 500ms
      // statement_timeout and loses to an autovacuum truncate or a busy advisory lock)
      // only skips one nudge — the next tick repeats it. Letting it escape aborted the
      // whole drain on 2026-10-01 and orphaned the queued exclusive (see the catch below).
      try {
        await inWorkspaceTxn(cd, owner, (tx) => pokeResource(tx, cd));
      } catch (e) {
        if (!isWorkspaceContended(e)) throw e;
      }

      const st = await readResourceLockStatus(getTxPool(), lockId);
      if (st.status === 'held') {
        return { ok: true, status: 'held', lock_id: lockId, waited_sec: elapsedSec(startedAt), shared_holders_at_start: sharedAtStart, fence_seq: st.fence_seq ?? 0 };
      }
      if (st.status === 'missing') break; // our exclusive vanished (expired / released)

      if (onTick) {
        const q = await readResourceQueue(getTxPool(), { coordinationDomain: cd, resource });
        onTick({ waited_sec: elapsedSec(startedAt), holders: q.holders });
      }
    }

    const q = await readResourceQueue(getTxPool(), { coordinationDomain: cd, resource });
    return { ok: false, reason: 'drain_timeout', lock_id: lockId, holders: q.holders, waited_sec: elapsedSec(startedAt) };
  } catch (error) {
    // WI-10004638: once queued, our exclusive is a live row the caller never learns the
    // lock_id of when we throw — so nobody else can release it. A draining exclusive
    // refuses every new shared acquire (writer preference), so an orphan stalls the
    // resource for its whole TTL; worse, callers wrap this in acquireWithContentionRetry
    // and re-queue under a FRESH owner, leaving the orphan ahead of their own row.
    // Measured 2026-10-01: two dev:restart git-sync barriers orphaned this way blocked
    // every pot's git-sync for ~3 min each. Release it before rethrowing.
    if (lockId) {
      const queued = lockId;
      await acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, owner, (tx) => tryReleaseResource(tx, { coordinationDomain: cd, owner, lockId: queued })),
      ).catch((releaseError: unknown) => {
        // The TTL is the backstop; say so rather than swallow it, so the next stall is attributable.
        console.warn(
          `[resource-acquire-wait] could not release queued exclusive ${queued} on ${resource} ` +
            `after the drain wait threw; it now lives until its TTL`,
          releaseError,
        );
      });
    }
    throw error;
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => undefined);
  }
}

type WorkspaceTx = Parameters<Parameters<typeof inWorkspaceTxn>[2]>[0];

export interface ExclusiveQueuedParams {
  coordinationDomain: string;
  /** Must be unique to this attempt: failure cleanup releases EVERYTHING this owner holds. */
  owner: string;
  ownerLabel: string | null;
  resource: string;
  reason: string;
  ttlSec: number;
  /** How long to keep a FIFO ticket behind another owner's exclusive; 0 = one attempt. */
  maxQueueSec: number;
  /** Re-poll cadence while queued. */
  pollMs?: number;
  /** Runs in each acquire transaction first, e.g. to auto-register the resource. */
  beforeAcquire?: (tx: WorkspaceTx) => Promise<void>;
}

export type ExclusiveQueuedResult =
  | { ok: true; lock_id: string; status: 'held' | 'draining'; waited_sec: number; fence_seq: number }
  | {
      ok: false;
      reason: ConflictReason | 'queue_timeout';
      holders: ResourceHolder[];
      waited_sec: number;
      queue_position?: number;
    };

/**
 * Wait in the durable exclusive FIFO (`agent_resource_exclusive_queue`) for ANOTHER
 * owner's exclusive to end — the case `acquireResourceExclusiveWithWait` returns
 * immediately on, because its wait covers shared holders only.
 *
 * A one-shot caller racing a periodic exclusive holder loses whenever the holder is
 * mid-run, and a fixed-schedule caller can lose every time. Measured: the P-008
 * staging-lineage bridge made one `git-sync:<slug>` attempt per hourly gate tick and
 * lost it at 16:23Z and 17:24Z on 2026-09-29, 14:23Z on 2026-09-30 and 07:22Z on
 * 2026-10-01, while git-sync (every 3 min) held the lease for minutes per fire.
 * With `queueOnConflict`, the store keeps this owner's ticket at a stable FIFO
 * position across retries, `resource_grant_cascade` grants it when the holder
 * releases, and a later one-shot acquirer is refused rather than jumping the ticket.
 *
 * Every non-granted exit releases this owner's ticket AND any lease the cascade
 * granted after the last poll, so an abandoned wait cannot strand the resource.
 */
export async function acquireResourceExclusiveQueued(
  params: ExclusiveQueuedParams,
): Promise<ExclusiveQueuedResult> {
  const { coordinationDomain: cd, owner, ownerLabel, resource, reason, ttlSec, maxQueueSec, beforeAcquire } = params;
  const pollMs = Math.max(1, params.pollMs ?? WAIT_CEILING_MS);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, maxQueueSec) * 1000;
  const releaseOwner = () =>
    acquireWithContentionRetry(() =>
      inWorkspaceTxn(cd, owner, (tx) => releaseAllResourcesForOwner(tx, cd, owner)),
    ).catch((releaseError: unknown) => {
      console.warn(
        `[resource-acquire-wait] could not clear queued exclusive for ${owner} on ${resource}; ` +
          'its ticket and any granted lease now live until their TTLs',
        releaseError,
      );
    });

  let granted = false;
  try {
    for (;;) {
      const r = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, owner, async (tx) => {
          if (beforeAcquire) await beforeAcquire(tx);
          return tryAcquireResource(tx, {
            coordinationDomain: cd,
            resource,
            mode: 'exclusive',
            owner,
            ownerLabel,
            reason,
            ttlSec,
            queueOnConflict: true,
          });
        }),
      );
      if (r.ok) {
        granted = true;
        return { ok: true, lock_id: r.lock_id, status: r.status, waited_sec: elapsedSec(startedAt), fence_seq: r.fence_seq };
      }
      const remainingMs = deadline - Date.now();
      if (r.reason !== 'held_exclusive' || remainingMs <= 0) {
        return {
          ok: false,
          reason: r.reason === 'held_exclusive' ? 'queue_timeout' : r.reason,
          holders: r.holders,
          waited_sec: elapsedSec(startedAt),
          ...(r.queue_position !== undefined ? { queue_position: r.queue_position } : {}),
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
    }
  } finally {
    if (!granted) await releaseOwner();
  }
}
