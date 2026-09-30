/**
 * `transfer:distill` — the transfer harness as a DETERMINISTIC blueprint step
 * (deterministic-blueprints-migration-2026-06-13 P-121).
 *
 * Transfer = distill candidate lessons from the day's transcripts (an `llmCall`
 * distiller) → admit them FREE at memory tier 'probationary' → run student-transfer
 * tests (a GOVERNED replay battery — an `llmCall` via lib/replay, ledgered on
 * `frontier:replay-harness`, NOT a fleet spawn — D-009) → promote/demote/retire via
 * the pure gate. All of that lives inside the shipped tick; this op WRAPS the shared
 * `runTransferDistill` orchestration (flag + governor + tick) — same gates, same
 * spend ledger (behavior-neutral, D-004). Because the agent work is internal
 * `llmCall`s (there is NO spawnInvokeOnce path in lib/transfer), transfer is
 * structurally a DETERMINISTIC pipeline (a single step, like negative-space), NOT a
 * `spawn-roles` hybrid — see D-009 for why D-005's "route through the launch
 * chokepoint" does not literally apply here.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runTransferDistill, type TransferDistillDeps } from '../../transfer/run.js';

/** Declared input I/O — the transfer tick tunables (the routine's payload knobs). */
const args = z.object({
  /** Trailing transcript window in hours. Default 24. */
  windowHours: z.number().positive().optional(),
  /** Max transcripts scanned per tick. Default 12. */
  maxTranscriptsPerTick: z.number().int().nonnegative().optional(),
  /** Max lessons distilled per transcript. Default 3. */
  maxLessonsPerTranscript: z.number().int().nonnegative().optional(),
  /** Max student-transfer tests run per tick (each is a replay battery). Default 5. */
  maxTestsPerTick: z.number().int().nonnegative().optional(),
  /** Promotion delta bar. Default DEFAULT_TRANSFER_GATE.minDelta. */
  minDelta: z.number().optional(),
  /** Failures before a lesson retires. Default DEFAULT_TRANSFER_GATE.maxFailsBeforeRetire. */
  maxFailsBeforeRetire: z.number().int().nonnegative().optional(),
  /** Memory scope probationary lessons are admitted into. */
  memoryScope: z.string().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  transcriptsScanned: z.number().int().optional(),
  lessonsDistilled: z.number().int().optional(),
  lessonsAdmitted: z.number().int().optional(),
  tested: z.number().int().optional(),
  passed: z.number().int().optional(),
  failed: z.number().int().optional(),
  retired: z.number().int().optional(),
  errors: z.number().int().optional(),
  testingSkippedNoReplay: z.boolean().optional(),
  costUsd: z.number().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the action's setters). */
let _deps: TransferDistillDeps | null = null;
export function setTransferDistillDeps(deps: TransferDistillDeps | null): void {
  _deps = deps;
}

export const transferDistillOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'transfer:distill',
  description:
    'Deterministic step: distill transferable lessons from the day’s transcripts (admitted probationary), then student-transfer-test them via a governed replay battery to promote/demote/retire (the transfer harness).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('transfer:distill requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runTransferDistill({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `transfer:distill ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` transcripts=${outcome.result.transcriptsScanned} distilled=${outcome.result.lessonsDistilled} ` +
            `tested=${outcome.result.tested} (${outcome.result.passed} promoted, ${outcome.result.retired} retired)`
          : ''),
    );
    const r = outcome.result;
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      transcriptsScanned: r?.transcriptsScanned,
      lessonsDistilled: r?.lessonsDistilled,
      lessonsAdmitted: r?.lessonsAdmitted,
      tested: r?.tested,
      passed: r?.passed,
      failed: r?.failed,
      retired: r?.retired,
      errors: r?.errors,
      testingSkippedNoReplay: r?.testingSkippedNoReplay,
      costUsd: r?.costUsd,
    };
  },
};

registerCoordOp(transferDistillOp);
