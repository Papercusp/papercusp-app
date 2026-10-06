/**
 * D-131 (p2p-public-release-endgame-2026-09-01, amends D-127): debounced auto-verify after a
 * PERSISTED repair admit.
 *
 * Before this, a frozen repair queue sat at `ready-to-verify` after an admit until someone fired
 * `release:checkpoint-run` by hand, which added leader latency on top of a 40-50 min verify.
 * Now every persisted admit schedules ONE durable verify for the head it published:
 *
 *  - DEBOUNCE: the verify waits a quiet window (5 min). Each admit moves `repairHead`, so a later
 *    admit makes the earlier head's waiter wake to a different head and stand down
 *    (`superseded`); only the newest head's waiter launches. D-127 batching is preserved.
 *  - GUARDS (re-read at fire time, never trusted from schedule time): the queue must still be
 *    `ready-to-verify` at the scheduled head; no run may hold the checkpoint run lock (the gate's
 *    admission self-refire owns admits that land mid-run); a head whose verification already
 *    started, or that already has a convergence round, is not launched again.
 *  - IDEMPOTENT per head: one workflow id per `repairHead` (the DBOS dedupe key) plus the
 *    `lastResumeRunStartedAtMs` / convergence-round check above.
 *
 * The launch is a bare `launchDetachedCheckpoint` — with a frozen queue present the gate applies
 * the queue policy itself and resumes `queue.repairHead` (the same call the green-stall watchdog
 * makes). Leader on-demand `release:checkpoint-run` (D-127) stays a valid override, e.g. to skip
 * the window.
 *
 * The waiter is a DBOS workflow (`dbos/repair-auto-verify-workflow.ts`) so an operator restart
 * cannot drop an accepted wait; this module holds the pure decision logic and the request seam.
 */
import {
  frozenRepairHeadAwaitsVerification,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

/** D-131 quiet window: no further admit to the same queue for this long ⇒ verify. */
export const REPAIR_AUTO_VERIFY_QUIET_MS = 5 * 60_000;

export interface RepairAutoVerifyRequest {
  /** The frozen candidate the admit landed on. */
  candidate: string;
  /** The repair head the persisted admit published — the head this waiter may verify. */
  repairHead: string;
  /** When the admit persisted (ms since epoch). */
  admittedAtMs: number;
  /** Quiet window override (tests / ops); defaults to {@link REPAIR_AUTO_VERIFY_QUIET_MS}. */
  quietMs?: number;
}

export interface RepairAutoVerifyReceipt {
  scheduled: true;
  workflowId: string;
  repairHead: string;
  quietMs: number;
  fireAfterMs: number;
}

export type RepairAutoVerifySkipReason =
  | 'no-queue'
  | 'queue-unreadable'
  | 'candidate-changed'
  | 'superseded'
  | 'not-ready-to-verify'
  | 'already-verifying'
  | 'run-lock-held';

export type RepairAutoVerifyOutcome =
  | { status: 'launched'; repairHead: string; unit: string | null }
  | { status: 'skipped'; repairHead: string; reason: RepairAutoVerifySkipReason; detail?: string }
  | { status: 'not-launched'; repairHead: string; reason: string };

export type RepairQueueReading =
  | { status: 'value'; queue: FrozenCandidateRepairQueue }
  | { status: 'absent' }
  | { status: 'unreadable'; detail?: string };

export interface RepairAutoVerifyDeps {
  sleep: (ms: number) => Promise<void>;
  readQueue: () => Promise<RepairQueueReading>;
  runLockHeld: () => boolean | Promise<boolean>;
  launch: () => Promise<{ launched: boolean; unit?: string | null; reason?: string | null }>;
}

/** Deterministic per-head workflow id: the DBOS dedupe key that makes scheduling idempotent. */
export function repairAutoVerifyWorkflowId(repairHead: string): string {
  return `repair-auto-verify:${repairHead}`;
}

/**
 * The fire-time decision, separated from I/O so every guard is unit-testable. Returns null when
 * the waiter should launch, else the skip reason.
 */
export function decideRepairAutoVerify(
  input: Pick<RepairAutoVerifyRequest, 'candidate' | 'repairHead'>,
  reading: RepairQueueReading,
  runLockHeld: boolean,
): { reason: RepairAutoVerifySkipReason; detail?: string } | null {
  if (reading.status === 'absent') return { reason: 'no-queue' };
  if (reading.status === 'unreadable') return { reason: 'queue-unreadable', detail: reading.detail };
  const queue = reading.queue;
  if (queue.candidate !== input.candidate) {
    return { reason: 'candidate-changed', detail: `queue now freezes ${queue.candidate.slice(0, 12)}` };
  }
  // Debounce: a later admit moved the head. That admit scheduled its own waiter with a fresh
  // quiet window, so this one stands down.
  if (queue.repairHead !== input.repairHead) {
    return { reason: 'superseded', detail: `repairHead moved to ${queue.repairHead.slice(0, 12)}` };
  }
  if (queue.phase !== 'ready-to-verify') return { reason: 'not-ready-to-verify', detail: `phase ${queue.phase}` };
  // Per-head idempotence: verification already began (or finished) at this exact head.
  if (queue.lastResumeRunStartedAtMs !== undefined || !frozenRepairHeadAwaitsVerification(queue)) {
    return { reason: 'already-verifying' };
  }
  // A live run owns any admit that landed during it (the admission self-refire, bounded).
  if (runLockHeld) return { reason: 'run-lock-held' };
  return null;
}

export async function runRepairAutoVerify(
  input: RepairAutoVerifyRequest,
  deps: RepairAutoVerifyDeps,
): Promise<RepairAutoVerifyOutcome> {
  await deps.sleep(Math.max(0, input.quietMs ?? REPAIR_AUTO_VERIFY_QUIET_MS));
  const reading = await deps.readQueue();
  // Evaluate the cheap queue guards before probing the lock, so a superseded waiter never
  // touches the run-lock at all.
  const preLock = decideRepairAutoVerify(input, reading, false);
  if (preLock) return { status: 'skipped', repairHead: input.repairHead, ...preLock };
  if (await deps.runLockHeld()) {
    return { status: 'skipped', repairHead: input.repairHead, reason: 'run-lock-held' };
  }
  const result = await deps.launch();
  return result.launched
    ? { status: 'launched', repairHead: input.repairHead, unit: result.unit ?? null }
    : { status: 'not-launched', repairHead: input.repairHead, reason: result.reason ?? 'not-launched' };
}

// ── request seam (wired to DBOS by host bootstrap) ──────────────────────────────────────────

export type RepairAutoVerifyRunner = (
  input: Required<Pick<RepairAutoVerifyRequest, 'quietMs'>> & RepairAutoVerifyRequest,
) => Promise<{ workflowId: string }>;

let runner: RepairAutoVerifyRunner | null = null;

export function setRepairAutoVerifyRunner(next: RepairAutoVerifyRunner | null): void {
  runner = next;
}

/**
 * Schedule the debounced verify for a persisted admit. Never throws: an admit has already
 * persisted, so a scheduling failure degrades to the D-127 manual path and is reported in the
 * returned value (the admit response carries it).
 */
export async function scheduleRepairAutoVerify(
  input: RepairAutoVerifyRequest,
): Promise<RepairAutoVerifyReceipt | { scheduled: false; reason: string }> {
  if (!runner) return { scheduled: false, reason: 'auto-verify runner not wired (DBOS not launched in this host)' };
  const quietMs = Math.max(0, input.quietMs ?? REPAIR_AUTO_VERIFY_QUIET_MS);
  try {
    const { workflowId } = await runner({ ...input, quietMs });
    return { scheduled: true, workflowId, repairHead: input.repairHead, quietMs, fireAfterMs: input.admittedAtMs + quietMs };
  } catch (err) {
    return { scheduled: false, reason: `auto-verify enqueue failed: ${(err as Error).message}` };
  }
}
