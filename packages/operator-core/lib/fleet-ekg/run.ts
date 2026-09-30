/**
 * `runFleetEkgScan` — the SHARED Fleet EKG orchestration
 * (flag → learning-governor → tick), the single source of truth both the
 * `system:fleet-ekg-scan` routine action AND the `fleet-ekg:scan` deterministic
 * blueprint step (deterministic-blueprints-migration-2026-06-13 P-030 / P-120)
 * run. Extracting it is what makes the migration provably behavior-neutral
 * (D-004): the blueprint path and the routine path call the SAME gated tick,
 * same flag, same governor preflight.
 *
 * Gates (unchanged from fleet-ekg-action.ts):
 *   - the `papercusp-fleet-ekg` flag (default OFF — the frontier D-001 arming
 *     gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the tick runs (and may throw — the caller owns the durable
 * never-throw wrapper, matching the action's existing try/catch contract).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the action keeps its exported `setFleetEkg*`
 * setters, the op keeps its own, and there is still ONE orchestration. Mirrors
 * `lib/negative-space/mine.ts` exactly.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { fleetEkgGovernorGate } from './governor';
import {
  defaultFleetEkgDeps,
  ekgOptionsFromPayload,
  runFleetEkgTick,
  type FleetEkgTickDeps,
  type FleetEkgTickResult,
} from './scan';

export interface FleetEkgScanDeps {
  /** Flag check (default: the live `papercusp-fleet-ekg` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `fleetEkgGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: the live PG-backed `defaultFleetEkgDeps`). */
  tickDeps?: FleetEkgTickDeps | null;
}

export interface FleetEkgScanOutcome {
  /** True iff the tick actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The tick result (present iff `ran`). */
  result?: FleetEkgTickResult;
}

/**
 * Run one Fleet EKG scan cycle behind the flag + governor gates. Does NOT
 * swallow a tick error (the caller's durable-step wrapper does) — flag/governor
 * are non-throwing (the governor fail-CLOSES to a refuse verdict on IO error).
 */
export async function runFleetEkgScan(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: FleetEkgScanDeps = {},
): Promise<FleetEkgScanOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.FLEET_EKG, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? fleetEkgGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const opts = ekgOptionsFromPayload(input.payload);
  const tickDeps = deps.tickDeps ?? defaultFleetEkgDeps(getOrgPg().sql);
  const result = await runFleetEkgTick(input.workspaceId, tickDeps, opts);
  return { ran: true, result };
}
