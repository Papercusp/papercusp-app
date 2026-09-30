/**
 * saga — orchestrated sagas + tombstones for compensable destructive ops.
 *
 * A destructive cross-machine action is a SAGA (intent → execute → compensations), not
 * last-write-wins (silently drops the safety-check loser) and not 2PC (blocking is acute
 * with flaky autonomous coordinators). runSaga executes steps forward; on any step's
 * failure it runs the COMPENSATIONS of the completed steps in REVERSE and records the
 * whole thing in a durable journal so a crashed coordinator's saga can be reasoned about
 * on recovery.
 *
 * Tombstones make destructive effects LOGICALLY REVERSIBLE: softDelete writes a tombstone
 * (cheap to compensate via restore), and only physicalGc — after a grace window — is
 * irreversible. So most "deletes" become compensable saga steps.
 */
import { randomUUID } from 'node:crypto';
import type { SagaJournal, SagaStepLog, TombstoneRef, TombstoneStore } from './ports';

export interface SagaStep {
  name: string;
  /** Forward action; its return value is passed to compensate(). */
  run: () => Promise<unknown>;
  /** Undo of `run`, executed in reverse if a LATER step fails. */
  compensate?: (result: unknown) => Promise<void>;
}

export interface SagaResult {
  sagaId: string;
  status: 'completed' | 'compensated' | 'failed';
  steps: SagaStepLog[];
  /** Results of the forward steps that ran (in order). */
  results: unknown[];
  failedStep?: string;
  error?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run a saga to completion, or compensate on failure. Returns 'completed' (all steps ran)
 * or 'compensated' (a step failed; completed steps were undone in reverse). Persistence
 * flows through the injected journal.
 */
export async function runSaga(
  journal: SagaJournal,
  opts: { workspaceId: string; name: string; steps: SagaStep[]; sagaId?: string },
): Promise<SagaResult> {
  const sagaId = opts.sagaId ?? `saga-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const log: SagaStepLog[] = opts.steps.map((s) => ({ name: s.name, status: 'pending' as const }));
  await journal.create({ workspaceId: opts.workspaceId, sagaId, name: opts.name, steps: log });

  const results: unknown[] = [];
  const done: { idx: number; step: SagaStep; result: unknown }[] = [];

  for (let i = 0; i < opts.steps.length; i++) {
    const step = opts.steps[i];
    try {
      const r = await step.run();
      results.push(r);
      done.push({ idx: i, step, result: r });
      log[i].status = 'done';
      await journal.update({ workspaceId: opts.workspaceId, sagaId, steps: log, status: 'running' });
    } catch (err) {
      log[i].status = 'failed';
      log[i].error = errMsg(err);
      // Compensate completed steps in REVERSE.
      for (let j = done.length - 1; j >= 0; j--) {
        const d = done[j];
        if (!d.step.compensate) {
          log[d.idx].status = 'compensated'; // nothing to undo
          continue;
        }
        try {
          await d.step.compensate(d.result);
          log[d.idx].status = 'compensated';
        } catch (cerr) {
          log[d.idx].status = 'compensate_failed';
          log[d.idx].error = errMsg(cerr);
        }
      }
      await journal.update({ workspaceId: opts.workspaceId, sagaId, steps: log, status: 'compensated', error: errMsg(err) });
      return { sagaId, status: 'compensated', steps: log, results, failedStep: step.name, error: errMsg(err) };
    }
  }

  await journal.update({ workspaceId: opts.workspaceId, sagaId, steps: log, status: 'completed' });
  return { sagaId, status: 'completed', steps: log, results };
}

// ── Tombstones — soft-delete + deferred physical GC ──────────────────────────────────

export interface Tombstones {
  softDelete(opts: TombstoneRef & { reason?: string; deletedBy?: string; graceSec?: number; now?: number }): Promise<void>;
  restoreTombstone(ref: TombstoneRef): Promise<boolean>;
  isTombstoned(ref: TombstoneRef): Promise<boolean>;
  physicalGc(opts: { workspaceId: string; refKind?: string; now?: number }): Promise<string[]>;
}

export function createTombstones(store: TombstoneStore): Tombstones {
  return {
    /** Soft-delete: tombstone the ref (cheap to compensate). Physical GC waits `graceSec` (default 24h). */
    async softDelete(opts) {
      const nowMs = opts.now ?? Date.now();
      const graceSec = opts.graceSec ?? 86_400;
      await store.upsert(
        { workspaceId: opts.workspaceId, refKind: opts.refKind, refId: opts.refId },
        { reason: opts.reason ?? '', deletedBy: opts.deletedBy ?? null, deletedAtMs: nowMs, gcAfterMs: nowMs + graceSec * 1000 },
      );
    },
    /** Compensation for softDelete: un-tombstone (the object lives again). */
    restoreTombstone(ref) {
      return store.restore(ref);
    },
    /** Whether a ref is currently tombstoned (soft-deleted, not restored). */
    isTombstoned(ref) {
      return store.isTombstoned(ref);
    },
    /** Deferred physical GC: drop tombstones past their grace window; return refs to destroy. */
    physicalGc(opts) {
      return store.gcExpired({ workspaceId: opts.workspaceId, refKind: opts.refKind, nowMs: opts.now });
    },
  };
}
