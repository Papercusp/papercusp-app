/**
 * `runCalibrationResolve` — the SHARED calibration resolution orchestration
 * (flag → learning-governor → sweep tick), the single source of truth both the
 * `system:calibration-resolve` routine action AND the `calibration:resolve`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13
 * P-041 / bucket A) run. Extracting it is what makes the migration provably
 * behavior-neutral (D-004): the blueprint path and the routine path call the
 * SAME gated sweep, same flag, same governor preflight.
 *
 * Gates (unchanged from calibration-action.ts):
 *   - the `papercusp-calibration-markets` flag (default OFF — the frontier
 *     D-001 arming gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the sweep runs (and may throw — the caller owns the durable
 * never-throw wrapper, matching the action's existing try/catch contract).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the action keeps its exported `setCalibration*`
 * setters, the op keeps its own, and there is still ONE orchestration. Mirrors
 * `lib/negative-space/mine.ts`.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { calibrationGovernorGate } from './governor';
import {
  defaultOutcomeProbes,
  runCalibrationResolveTick,
  type CalibrationSweepDeps,
  type CalibrationSweepResult,
} from './resolve-sweep';

/** The sweep batch cap from the routine payload (default = the tick's 200). */
export function maxPerTickFromPayload(payload: unknown): number | undefined {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>).maxPerTick;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

export interface CalibrationResolveDeps {
  /** Flag check (default: the live `papercusp-calibration-markets` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `calibrationGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Sweep deps (default: live PG sql + `defaultOutcomeProbes`). */
  sweepDeps?: CalibrationSweepDeps | null;
}

export interface CalibrationResolveOutcome {
  /** True iff the sweep actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The sweep result (present iff `ran`). */
  result?: CalibrationSweepResult;
}

/**
 * Run one calibration resolution sweep behind the flag + governor gates. Does
 * NOT swallow a sweep error (the caller's durable-step wrapper does) —
 * flag/governor are non-throwing (the governor fail-CLOSES on IO error).
 */
export async function runCalibrationResolve(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: CalibrationResolveDeps = {},
): Promise<CalibrationResolveOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.CALIBRATION_MARKETS, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? calibrationGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const sweepDeps =
    deps.sweepDeps ??
    (() => {
      const { sql } = getOrgPg();
      return { sql, probes: defaultOutcomeProbes(sql) } satisfies CalibrationSweepDeps;
    })();
  const result = await runCalibrationResolveTick(input.workspaceId, sweepDeps, {
    limit: maxPerTickFromPayload(input.payload),
  });
  return { ran: true, result };
}
