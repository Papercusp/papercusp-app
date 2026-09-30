/**
 * `red-queen:drill` — the red-queen vaccination cadence as a DETERMINISTIC
 * blueprint step (deterministic-blueprints-migration-2026-06-13 P-122).
 *
 * Per tick: expire stale drills + run ONE drill cycle for the least-recently
 * drilled class — plant a known synthetic friction in the SANDBOX workspace,
 * detect it with a real watchdog, heal it with the known remedy, record MTTSH +
 * the zero-leak assertion. All of that (incl. the origin=drill provenance + the
 * SANDBOX isolation + the P-001 arming gate) lives inside the shipped tick; this
 * op WRAPS the shared `runRedQueenDrill` orchestration — same flag + governor
 * gates, behavior-neutral (D-004). SQL-only, zero spend.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runRedQueenDrill, type RedQueenDrillDeps } from '../../red-queen/run.js';

/** Declared input I/O — the drill tunables (the routine's payload knobs). */
const args = z.object({
  /** Pin the rotation to one drill class (default: least-recently drilled). */
  classId: z.string().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  status: z.string().optional(),
  drillClass: z.string().optional(),
  cycleStatus: z.string().optional(),
  expired: z.number().int().optional(),
});

/** Test seam — inject flag/governor/cycle deps (mirrors the action's setters). */
let _deps: RedQueenDrillDeps | null = null;
export function setRedQueenDrillDeps(deps: RedQueenDrillDeps | null): void {
  _deps = deps;
}

export const redQueenDrillOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'red-queen:drill',
  description:
    'Deterministic step: run one red-queen vaccination drill cycle (plant a synthetic friction in the SANDBOX, detect+heal, record MTTSH + zero-leak) and expire stale drills.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('red-queen:drill requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runRedQueenDrill({ workspaceId, installSlug, payload: a }, _deps ?? {});
    const r = outcome.result;
    ctx.log?.(
      `red-queen:drill ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (r ? ` status=${r.status} class=${r.drillClass ?? '(none)'} expired=${r.expired}` : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      status: r?.status,
      drillClass: r?.drillClass ?? undefined,
      cycleStatus: r?.cycle?.status,
      expired: r?.expired,
    };
  },
};

registerCoordOp(redQueenDrillOp);
