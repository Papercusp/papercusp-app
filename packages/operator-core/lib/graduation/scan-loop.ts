/**
 * `runGraduationScan` — the SHARED graduation-tracker orchestration
 * (flag → learning-governor → tick), the single source of truth both the
 * `system:graduation-scan` routine action AND the `graduation:scan`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13
 * P-046 / bucket A) run. Extracting it is what makes the migration provably
 * behavior-neutral (D-004): the blueprint path and the routine path call the
 * SAME gated tick, same flag, same governor preflight.
 *
 * Gates (unchanged from graduation-action.ts):
 *   - the `papercusp-graduation-tracker` flag (default OFF — the frontier D-001
 *     arming gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the tick runs (and may throw — the caller owns the durable
 * never-throw wrapper, matching the action's existing try/catch contract).
 *
 * The tick FILES AN OWNER REPORT and NEVER auto-edits autoKinds (the widening
 * stays a reviewed policy.ts edit, P-046 / D-008) — preserved exactly: the op
 * runs the same `runGraduationTick`, which files kind=change reports on the
 * normal rails behind protected paths.
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the action keeps its exported `setGraduation*`
 * setters, the op keeps its own, and there is still ONE orchestration. Mirrors
 * `lib/negative-space/mine.ts`.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { GovernorVerdict } from '../learning-governor/core';
import { graduationGovernorGate } from './governor';
import {
  defaultGraduationTickDeps,
  graduationOptionsFromPayload,
  runGraduationTick,
  type GraduationTickDeps,
  type GraduationTickResult,
} from './scan';

export interface GraduationScanDeps {
  /** Flag check (default: the live `papercusp-graduation-tracker` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `graduationGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: the live PG-backed `defaultGraduationTickDeps`). */
  tickDeps?: GraduationTickDeps | null;
}

export interface GraduationScanOutcome {
  /** True iff the tick actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The tick result (present iff `ran`). */
  result?: GraduationTickResult;
}

/**
 * Run one graduation-tracker tick behind the flag + governor gates. Does NOT
 * swallow a tick error (the caller's durable-step wrapper does) — flag/governor
 * are non-throwing (the governor fail-CLOSES to a refuse verdict on IO error).
 */
export async function runGraduationScan(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: GraduationScanDeps = {},
): Promise<GraduationScanOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.GRADUATION_TRACKER, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? graduationGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const opts = graduationOptionsFromPayload(input.payload);
  const tickDeps =
    deps.tickDeps ??
    defaultGraduationTickDeps((await import('@papercusp/db-org')).getOrgPg().sql, input.workspaceId);
  const result = await runGraduationTick(tickDeps, opts);
  return { ran: true, result };
}
