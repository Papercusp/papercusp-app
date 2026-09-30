/**
 * `runDeferralInterestRefitGated` — the SHARED deferral-interest refit
 * orchestration (flag → learning-governor → tick), the single source of truth
 * both the `system:deferral-interest-refit` routine action AND the
 * `deferral-interest:refit` deterministic blueprint step
 * (deterministic-blueprints-migration-2026-06-13 P-042 / bucket A) run.
 * Extracting it is what makes the migration provably behavior-neutral (D-004):
 * the blueprint path and the routine path call the SAME gated tick, same flag,
 * same governor preflight.
 *
 * Gates (unchanged from deferral-interest-action.ts):
 *   - the `papercusp-deferral-interest` flag (default OFF — the frontier D-001
 *     arming gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the tick runs (and may throw — the caller owns the durable
 * never-throw wrapper, matching the action's existing try/catch contract).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the action keeps its exported `setDeferral*`
 * setters, the op keeps its own, and there is still ONE orchestration. Mirrors
 * `lib/negative-space/mine.ts`.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { deferralInterestGovernorGate } from './governor';
import {
  defaultDeferralRefitDeps,
  runDeferralInterestRefit,
  type DeferralRefitDeps,
  type DeferralRefitResult,
} from './refit';

export interface DeferralRefitGateDeps {
  /** Flag check (default: the live `papercusp-deferral-interest` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `deferralInterestGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: the live PG-backed `defaultDeferralRefitDeps`). */
  tickDeps?: DeferralRefitDeps | null;
}

export interface DeferralRefitOutcome {
  /** True iff the tick actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The tick result (present iff `ran`). */
  result?: DeferralRefitResult;
}

/**
 * Run one deferral-interest refit behind the flag + governor gates. Does NOT
 * swallow a tick error (the caller's durable-step wrapper does) — flag/governor
 * are non-throwing (the governor fail-CLOSES to a refuse verdict on IO error).
 */
export async function runDeferralInterestRefitGated(
  input: { workspaceId: string; installSlug: string },
  deps: DeferralRefitGateDeps = {},
): Promise<DeferralRefitOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.DEFERRAL_INTEREST, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? deferralInterestGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const tickDeps = deps.tickDeps ?? defaultDeferralRefitDeps(getOrgPg().sql, input.workspaceId);
  const result = await runDeferralInterestRefit(tickDeps);
  return { ran: true, result };
}
