/**
 * `regret:mine` — the regret miner as a DETERMINISTIC blueprint step
 * (deterministic-blueprints-migration-2026-06-13 P-111).
 *
 * Regret = select bad historical sessions (SQL) → locate the divergence turn
 * (parse) → counterfactually price candidate rule changes (a GOVERNED `llmCall`
 * replay, NOT a fleet spawn — D-009) → file scored reports. All of that lives
 * inside the shipped tick; this op WRAPS the shared `runRegretMine` orchestration
 * (flag + governor + cap + tick) — same gates, same spend ledger (behavior-neutral,
 * D-004). Because the replay is an internal `llmCall`, regret is structurally a
 * DETERMINISTIC pipeline (a single step, like negative-space), NOT a `spawn-roles`
 * hybrid — see D-009 for why D-005's "route through the launch chokepoint" does
 * not literally apply here.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runRegretMine, type RegretMineDeps } from '../../replay/regret/run-mine.js';

/** Declared input I/O — the regret tunables (the routine's payload knobs). */
const args = z.object({
  /** Trailing selection window in days. Default 14. */
  windowDays: z.number().int().positive().optional(),
  /** Minimum badness to keep. Default 0.35. */
  minScore: z.number().nonnegative().optional(),
  /** Max bad-session candidates per tick. Default 10. */
  maxSessions: z.number().int().nonnegative().optional(),
  /** Pending findings priced (replayed) per tick. Default 3. */
  maxReplaysPerTick: z.number().int().nonnegative().optional(),
  /** Per-cycle replay spend cap (USD); the governor cap still bounds it. */
  replayBudgetUsd: z.number().nonnegative().optional(),
  /** Reports filed per tick; 0 = mine-only. Default 3. */
  maxFilePerTick: z.number().int().nonnegative().optional(),
  /** Best-candidate improvement score a report needs to file. Default 0.5. */
  minFileScore: z.number().nonnegative().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  scanned: z.number().int().optional(),
  candidates: z.number().int().optional(),
  mined: z.number().int().optional(),
  skippedKnown: z.number().int().optional(),
  replayed: z.number().int().optional(),
  replayCostUsd: z.number().optional(),
  filed: z.array(z.string()).optional(),
  declined: z.number().int().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the action's setters). */
let _deps: RegretMineDeps | null = null;
export function setRegretMineDeps(deps: RegretMineDeps | null): void {
  _deps = deps;
}

export const regretMineOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'regret:mine',
  description:
    'Deterministic step: select bad historical sessions, price candidate rule changes via a governed counterfactual replay, and file scored what-would-have-helped reports (the regret miner).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('regret:mine requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runRegretMine({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `regret:mine ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` scanned=${outcome.result.scanned} mined=${outcome.result.mined} replayed=${outcome.result.replayed} filed=${outcome.result.filed.length}`
          : ''),
    );
    const r = outcome.result;
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      scanned: r?.scanned,
      candidates: r?.candidates,
      mined: r?.mined,
      skippedKnown: r?.skippedKnown,
      replayed: r?.replayed,
      replayCostUsd: r?.replayCostUsd,
      filed: r?.filed,
      declined: r?.declined,
    };
  },
};

registerCoordOp(regretMineOp);
