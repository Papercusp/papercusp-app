/**
 * `memory-precision:bench` — the memory-precision monitoring bench as a
 * DETERMINISTIC blueprint step (relight-self-learning-edges-2026-06-14 P-033).
 *
 * Mirrors the calibration/iq-battery deterministic-step pattern: a registered
 * typed function (declared args/result I/O) the program-mode spine runs as a
 * checkpointed step. It WRAPS the shipped orchestration
 * (`runMemoryPrecisionMonitor` — flag gate → floored hybrid gold-set replay →
 * record row → invalidate), so the blueprint reshapes, it does not rewrite.
 *
 * Flag-only (NO governor — like change-ledger): the bench is cheap, read-only
 * bookkeeping (embeddings, no LLM, isolated bench schema). Always-on monitoring
 * (`singletonActive: true`); the gate is the `papercusp-memory-precision-bench`
 * flag (default ON).
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import {
  runMemoryPrecisionMonitor,
  type MemoryPrecisionBenchDeps,
} from '../../memory/bench/precision-monitor.js';

/** No cadence knobs — the gold set + floor are frozen; the routine carries no payload. */
const args = z.object({});

/** Declared output I/O — the run outcome (or the gate/failure that skipped the write). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'failed']).optional(),
  /** `failed` only: which step threw (WI-10004133). */
  stage: z.enum(['bench', 'record']).optional(),
  error: z.string().optional(),
  rowId: z.number().int().optional(),
  fpAt5: z.number().nullable().optional(),
  rAt10: z.number().nullable().optional(),
  pAt5: z.number().nullable().optional(),
});

/** Test seam — inject flag/bench/record/invalidate deps (mirrors calibration-resolve). */
let _deps: MemoryPrecisionBenchDeps | null = null;
export function setMemoryPrecisionBenchDeps(deps: MemoryPrecisionBenchDeps | null): void {
  _deps = deps;
}

export const memoryPrecisionBenchOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'memory-precision:bench',
  description:
    'Deterministic step: replay the frozen memory gold set against the production hybrid backend at the push floor and record FP@5 / R@10 / precision (the memory-precision monitoring bench).',
  argsSchema: args,
  resultSchema: result,
  async run(_a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('memory-precision:bench requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runMemoryPrecisionMonitor({ workspaceId, installSlug }, _deps ?? {});
    ctx.log?.(
      `memory-precision:bench ran=${outcome.ran}` +
        (outcome.ran === false ? ` skip=${outcome.skipReason}` : ` row=${outcome.rowId} fp@5=${outcome.metrics.fpAt5 ?? '—'}`),
    );
    if (outcome.ran) {
      return {
        ran: true,
        rowId: outcome.rowId,
        fpAt5: outcome.metrics.fpAt5,
        rAt10: outcome.metrics.rAt10,
        pAt5: outcome.metrics.pAt5,
      };
    }
    return {
      ran: false,
      skipReason: outcome.skipReason,
      stage: 'stage' in outcome ? outcome.stage : undefined,
      error: 'error' in outcome ? outcome.error : undefined,
    };
  },
};

registerCoordOp(memoryPrecisionBenchOp);
