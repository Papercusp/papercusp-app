/**
 * cross-hive-outbox-drain — the backoff-aware drain for the durable cross-Hive
 * outbox (hive-network-surface-2026-06-11 P-001, brief B-01).
 *
 * `PgCrossHiveOutbox` (mig 196) durably queues a directed Hive→Hive envelope
 * when the peer is offline; until this module nothing ever re-delivered the
 * queue in production (`flushCrossHiveOutbox` exists but retries EVERY pending
 * envelope unconditionally — a hot-loop against an offline peer). This drain
 * runs on three triggers (composed in cross-hive-boundary-boot.ts +
 * harness/routines/cross-hive-drain-action.ts):
 *
 *   boot      — once per hive when its boundary is wired
 *   periodic  — the `system:cross-hive-outbox-drain` routine tick
 *   reconnect — a peer's HELLO on the swarm transport force-drains that peer
 *
 * Per-PEER exponential backoff, respecting the outbox's `attempt_count`: a
 * peer's eligibility is computed from the max attempt_count + most recent
 * last_attempt_at across its pending envelopes, so an offline peer is probed at
 * a decaying cadence (base 30s doubling to a 30min cap) instead of every tick.
 * Within an eligible peer the drain delivers oldest-first and STOPS that peer on
 * the first failure (one `noteAttempt`, never one per envelope) — ordering is
 * preserved and an offline peer costs exactly one dial per drain.
 *
 * The planning half (`planOutboxDrain`) is pure for unit tests; the executor
 * (`drainCrossHiveOutboxOnce`) takes the outbox + transport ports.
 */
import type { CrossHiveTransport, CrossHiveWireEnvelope } from './cross-hive-transport';
import type { DetailedPendingEnvelope } from './cross-hive-outbox-pg';

/** Default backoff base: first retry no sooner than 30s after a failure. */
export const DRAIN_BACKOFF_BASE_MS = 30_000;
/** Default backoff cap: probe an enduringly-offline peer at most every 30min. */
export const DRAIN_BACKOFF_CAP_MS = 30 * 60_000;

/** What the drain needs from the outbox — PgCrossHiveOutbox satisfies it. */
export interface DrainableOutbox {
  pendingDetailed(): Promise<DetailedPendingEnvelope[]>;
  markDelivered(id: string): Promise<void>;
  noteAttempt(id: string): Promise<void>;
}

export interface DrainPlanOpts {
  nowMs: number;
  /** Backoff base (ms). Default DRAIN_BACKOFF_BASE_MS. */
  baseMs?: number;
  /** Backoff cap (ms). Default DRAIN_BACKOFF_CAP_MS. */
  capMs?: number;
  /** Peers drained regardless of backoff (the reconnect trigger). */
  forcePeers?: ReadonlySet<string>;
}

export interface DrainPlan {
  /** Peer pubkey → its pending envelopes oldest-first — the peers to attempt. */
  attempts: Map<string, CrossHiveWireEnvelope[]>;
  /** Peers skipped because they are inside their backoff window. */
  backedOff: string[];
}

/** The backoff delay after `attemptCount` failed attempts (exponential, capped). */
export function drainBackoffMs(
  attemptCount: number,
  baseMs: number = DRAIN_BACKOFF_BASE_MS,
  capMs: number = DRAIN_BACKOFF_CAP_MS,
): number {
  if (attemptCount <= 0) return 0;
  return Math.min(baseMs * 2 ** (attemptCount - 1), capMs);
}

/**
 * Pure drain planning: group pending envelopes by destination peer, oldest-first
 * (the rows arrive oldest-first from `pendingDetailed`), and split peers into
 * eligible-now vs backed-off. A peer's window derives from the MAX attempt_count
 * and most recent last_attempt_at across its envelopes — one offline peer, one
 * window, regardless of how many envelopes are queued behind it.
 */
export function planOutboxDrain(rows: readonly DetailedPendingEnvelope[], opts: DrainPlanOpts): DrainPlan {
  const baseMs = opts.baseMs ?? DRAIN_BACKOFF_BASE_MS;
  const capMs = opts.capMs ?? DRAIN_BACKOFF_CAP_MS;
  const byPeer = new Map<string, { envs: CrossHiveWireEnvelope[]; attempts: number; lastAttemptAt: number }>();
  for (const r of rows) {
    const peer = r.env.toHivePubkey;
    const e = byPeer.get(peer) ?? { envs: [], attempts: 0, lastAttemptAt: 0 };
    e.envs.push(r.env);
    e.attempts = Math.max(e.attempts, r.attemptCount);
    e.lastAttemptAt = Math.max(e.lastAttemptAt, r.lastAttemptAt);
    byPeer.set(peer, e);
  }
  const attempts = new Map<string, CrossHiveWireEnvelope[]>();
  const backedOff: string[] = [];
  for (const [peer, e] of byPeer) {
    const eligibleAt = e.lastAttemptAt === 0 ? 0 : e.lastAttemptAt + drainBackoffMs(e.attempts, baseMs, capMs);
    if (opts.forcePeers?.has(peer) || opts.nowMs >= eligibleAt) attempts.set(peer, e.envs);
    else backedOff.push(peer);
  }
  return { attempts, backedOff };
}

export interface DrainOutcome {
  /** Envelopes delivered + removed from the outbox this drain. */
  delivered: number;
  /** Peers attempted that failed on their first envelope (offline). */
  failedPeers: string[];
  /** Peers skipped inside their backoff window. */
  backedOffPeers: string[];
  /** Envelopes still pending after the drain. */
  pending: number;
}

export interface DrainDeps {
  outbox: DrainableOutbox;
  transport: Pick<CrossHiveTransport, 'send'>;
  /** Injected clock for tests. Default Date.now(). */
  nowMs?: number;
  baseMs?: number;
  capMs?: number;
  /** Peers drained regardless of backoff (the reconnect trigger). */
  forcePeers?: Iterable<string>;
}

/**
 * One drain pass: plan per-peer eligibility, then deliver each eligible peer's
 * queue oldest-first. First failure for a peer notes ONE attempt (on the failed
 * envelope — the queue head, so the peer's window restarts) and abandons that
 * peer until its next window; later peers still drain.
 */
export async function drainCrossHiveOutboxOnce(deps: DrainDeps): Promise<DrainOutcome> {
  const rows = await deps.outbox.pendingDetailed();
  const plan = planOutboxDrain(rows, {
    nowMs: deps.nowMs ?? Date.now(),
    baseMs: deps.baseMs,
    capMs: deps.capMs,
    forcePeers: deps.forcePeers ? new Set(deps.forcePeers) : undefined,
  });
  let delivered = 0;
  const failedPeers: string[] = [];
  for (const [peer, envs] of plan.attempts) {
    for (const env of envs) {
      try {
        await deps.transport.send(peer, env);
      } catch {
        failedPeers.push(peer);
        await deps.outbox.noteAttempt(env.id).catch(() => {});
        break; // peer is unreachable — stop its queue, keep ordering, no hot-loop
      }
      await deps.outbox.markDelivered(env.id);
      delivered += 1;
    }
  }
  const pendingAfter = rows.length - delivered;
  return { delivered, failedPeers, backedOffPeers: plan.backedOff, pending: pendingAfter };
}
