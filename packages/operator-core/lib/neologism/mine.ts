/**
 * `runNeologismMine` — the SHARED neologism miner orchestration
 * (flag → learning-governor → tick), the single source of truth both the
 * `system:neologism-mine` routine action AND the `neologism:mine` deterministic
 * blueprint step (deterministic-blueprints-migration-2026-06-13 P-011 / P-120)
 * run. Extracting it is what makes the migration provably behavior-neutral
 * (D-004): the blueprint path and the routine path call the SAME gated tick,
 * same flag, same governor preflight.
 *
 * Gates (unchanged from neologism-action.ts):
 *   - the `papercusp-neologism-miner` flag (default OFF — the frontier D-001
 *     arming gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the tick runs (and may throw — the caller owns the durable
 * never-throw wrapper, matching the action's existing try/catch contract).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the action keeps its exported `setNeologism*`
 * setters, the op keeps its own, and there is still ONE orchestration. Mirrors
 * `lib/negative-space/mine.ts` exactly.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { neologismGovernorGate } from './governor';
import { neologismOptionsFromPayload } from './miner-core';
import {
  defaultNeologismDeps,
  runNeologismTick,
  type NeologismTickDeps,
  type NeologismTickResult,
} from './scan';

export interface NeologismMineDeps {
  /** Flag check (default: the live `papercusp-neologism-miner` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `neologismGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: the live PG/fs-backed `defaultNeologismDeps`). */
  tickDeps?: NeologismTickDeps | null;
}

export interface NeologismMineOutcome {
  /** True iff the tick actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The tick result (present iff `ran`). */
  result?: NeologismTickResult;
}

/**
 * Run one neologism mining cycle behind the flag + governor gates. Does NOT
 * swallow a tick error (the caller's durable-step wrapper does) — flag/governor
 * are non-throwing (the governor fail-CLOSES to a refuse verdict on IO error).
 */
export async function runNeologismMine(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: NeologismMineDeps = {},
): Promise<NeologismMineOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.NEOLOGISM_MINER, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? neologismGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const opts = neologismOptionsFromPayload(input.payload);
  const tickDeps = deps.tickDeps ?? defaultNeologismDeps(getOrgPg().sql);
  const result = await runNeologismTick(input.workspaceId, tickDeps, opts);
  return { ran: true, result };
}
