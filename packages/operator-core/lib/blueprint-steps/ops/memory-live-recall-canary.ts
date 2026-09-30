/**
 * `memory-live-recall:canary` — the live memory recall canary as a DETERMINISTIC
 * blueprint step (EI-10047).
 *
 * Mirrors memory-precision-bench.ts: a registered typed function the
 * program-mode spine runs as a checkpointed step, wrapping the shipped
 * orchestration (`runRecallCanary` — flag gate → known-item replay against
 * the LIVE stack, read-only → record row → alert on the ok→degraded edge).
 *
 * Flag-only (NO governor): ~25 live searches/tick, no LLM, no store writes.
 * Always-on monitoring (`singletonActive: true`); the gate is the
 * `papercusp-memory-live-recall-canary` flag (default ON).
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import {
  runRecallCanary,
  type RecallCanaryDeps,
} from '../../memory/bench/recall-canary.js';

/** No cadence knobs — the probe set is frozen in PG; the routine carries no payload. */
const args = z.object({});

/** Declared output I/O — the run outcome (or the gate/failure that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'failed']).optional(),
  error: z.string().optional(),
  rowId: z.number().int().optional(),
  status: z.enum(['ok', 'degraded', 'decayed', 'seeded']).optional(),
  rAt10: z.number().nullable().optional(),
  delta: z.number().nullable().optional(),
  zeroHitRate: z.number().nullable().optional(),
});

/** Test seam — inject flag/sql/backend/alert deps (mirrors memory-precision-bench). */
let _deps: RecallCanaryDeps | null = null;
export function setMemoryLiveRecallCanaryDeps(deps: RecallCanaryDeps | null): void {
  _deps = deps;
}

export const memoryLiveRecallCanaryOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'memory-live-recall:canary',
  description:
    'Deterministic step: replay the frozen known-item canary set against the LIVE memory stack (read-only), record recall@10 vs baseline, and alert on degradation (the memory recall canary).',
  argsSchema: args,
  resultSchema: result,
  async run(_a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('memory-live-recall:canary requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runRecallCanary({ workspaceId, installSlug }, _deps ?? {});
    ctx.log?.(
      `memory-live-recall:canary ran=${outcome.ran}` +
        (outcome.ran === false
          ? ` skip=${outcome.skipReason}`
          : ` row=${outcome.rowId} status=${outcome.status} r@10=${outcome.metrics.rAt10 ?? '—'}`),
    );
    if (outcome.ran) {
      return {
        ran: true,
        rowId: outcome.rowId,
        status: outcome.status,
        rAt10: outcome.metrics.rAt10,
        delta: outcome.metrics.delta,
        zeroHitRate: outcome.metrics.zeroHitRate,
      };
    }
    return {
      ran: false,
      skipReason: outcome.skipReason,
      error: 'error' in outcome ? outcome.error : undefined,
    };
  },
};

registerCoordOp(memoryLiveRecallCanaryOp);
