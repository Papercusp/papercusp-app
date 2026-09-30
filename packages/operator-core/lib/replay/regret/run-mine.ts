/**
 * `runRegretMine` — the SHARED regret-mining orchestration (flag → governor →
 * governor-cap-bounds-replay → tick), the single source of truth both the
 * `system:regret-mine` routine action AND the `regret:mine` deterministic
 * blueprint step run (deterministic-blueprints-migration-2026-06-13 P-111 /
 * D-004 — provably behavior-neutral: one gated tick, two callers).
 *
 * A leaf module (imports mine/store/governor/replay-adapter) so it can wire the
 * live tick deps (`defaultRegretDeps` + the `governedRegretRunner` replay leg)
 * WITHOUT a `mine ↔ store` import cycle (store imports RegretTickDeps from mine).
 *
 * IMPORTANT (D-009): regret's counterfactual replay leg is a governed `llmCall`
 * (runGovernedReplay preflights the replay-harness flag + `frontier:replay-harness`
 * loop and ledgers spend), NOT a fleet agent spawn via spawnInvokeOnce. So regret
 * as a blueprint is a DETERMINISTIC pipeline (the llmCall lives inside the tick),
 * not a `spawn-roles` hybrid — and this migration is behavior-neutral, NOT a
 * re-route of the replay onto the fleet launch chokepoint (that would be a
 * behavior change; it is an open owner decision — see D-009).
 *
 * Gates (unchanged from regret-action.ts): the `papercusp-regret-mining` flag
 * (default OFF — frontier D-001 arming gate) then the learning-governor preflight
 * (enforcement 'governor'). Past both, the governor's per-cycle cap bounds replay
 * spend (the payload may LOWER it, never raise it). The tick may throw — the
 * caller owns the durable never-throw wrapper.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../../learning-governor/core';
import { regretGovernorGate } from './governor';
import { regretOptionsFromPayload, runRegretTick, type RegretTickDeps, type RegretTickResult } from './mine';
import { governedRegretRunner } from './replay-adapter';
import { defaultRegretDeps } from './store';

export interface RegretMineDeps {
  /** Flag check (default: the live `papercusp-regret-mining` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `regretGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: live PG deps + the governed `llmCall` replay runner). */
  tickDeps?: RegretTickDeps | null;
}

export interface RegretMineOutcome {
  ran: boolean;
  skipReason?: 'flag-off' | 'governor-refused';
  governorReason?: string;
  result?: RegretTickResult;
}

export async function runRegretMine(
  input: { workspaceId: string; installSlug: string; payload?: unknown },
  deps: RegretMineDeps = {},
): Promise<RegretMineOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.REGRET_MINING, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? regretGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const opts = regretOptionsFromPayload(input.payload);
  // The governor's per-cycle cap bounds replay spend; the payload may lower it.
  const governorCapUsd = verdict.remainingUsd ?? 0;
  opts.replayBudgetUsd = Math.min(opts.replayBudgetUsd ?? governorCapUsd, governorCapUsd);

  // Boot-path composition (the hermetic-glue insight): the live replay runner is
  // wired HERE, not in the PG deps factory. Spend is ledgered ONCE by the replay
  // substrate itself (runGovernedReplay, loop frontier:replay-harness) — never twice.
  const tickDeps = deps.tickDeps ?? { ...defaultRegretDeps(getOrgPg().sql), replayRunner: governedRegretRunner() };
  const result = await runRegretTick(input.workspaceId, tickDeps, opts);
  return { ran: true, result };
}
