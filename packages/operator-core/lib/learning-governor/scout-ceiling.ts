/**
 * Workspace-wide Scout spend ceiling — the P-051 aggregate gate
 * (per-hive-learning-loops-2026-06-14 / D-005).
 *
 * Scout is the one learning engine that MULTIPLIES: every hive carries its own
 * `scout:<hive>` per-cycle registrant, and a per-cycle cap bounds ONE cycle —
 * it cannot see the fleet. N armed hives, each individually under its small
 * per-cycle cap, can still sum to a spend that saturates the shared Anthropic
 * rate limit / the operator daily budget. This module is the missing aggregate
 * gate, consulted by the scout cycle's governor gate (runScoutCycleTick) BEFORE
 * a tick: it sums the workspace's `blender:*` spend EVENTS within the rolling
 * accounting window (SCOUT_WORKSPACE_CEILING_WINDOW_MS, 24h) and REFUSES a new
 * cycle once the windowed total crosses the ceiling.
 *
 * WINDOWED, not lifetime (2026-07-26): the gate originally summed the
 * registrations' lifetime `spent_usd`, which only ever grows — so a workspace
 * that had EVER spent the ceiling froze scout permanently (live incident:
 * blender:papercusp's $456 accumulated over a month vs the $10 default gated
 * every tick after a host restart dropped the env override). The ceiling's own
 * sizing comment always said "per accounting window"; now the implementation
 * agrees, reading the learning_spend_events ledger (sumScoutSpendSince).
 *
 * Layering (mirrors registrants.ts):
 *   - the pure rule (compare) is scoutWorkspaceCeilingVerdict in core.ts;
 *   - the IO (listLearningLoops over the live admin pool) lives in store.ts;
 *   - THIS module is the flag-aware glue: governor flag OFF ⇒ the gate is a
 *     no-op (the kill-switch — scout's structural self-gates still bound it),
 *     and an IO error FAILS OPEN (allow) — the workspace ceiling is a SAFETY
 *     CAP on top of every per-hive per-cycle cap + the cadence/budget self-gates,
 *     so a broken ledger read must not silently freeze the whole fleet's scout;
 *     it logs and lets the already-bounded per-hive cycle proceed.
 *
 * The ceiling is OWNER-TUNABLE: DEFAULT_SCOUT_WORKSPACE_CEILING_USD (core.ts),
 * overridable per host via the PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD env.
 *
 * Deps are injectable so scout-ceiling.test.ts covers flag-off, under/over cap,
 * the cross-hive sum, and fail-open with zero PG.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  SCOUT_WORKSPACE_CEILING_WINDOW_MS,
  scoutWorkspaceCeilingVerdict,
  type ScoutWorkspaceCeilingVerdict,
} from './core';
import { sumScoutSpendSince } from './store';
// P-022: the env-only ceiling reader now lives in scout-budget-overrides (alongside the runtime PG
// override). Re-exported here for back-compat (its original home + the existing test import).
import {
  resolveScoutWorkspaceCeilingUsd,
  resolveScoutWorkspaceCeilingUsdLive,
} from './scout-budget-overrides';
export { resolveScoutWorkspaceCeilingUsd } from './scout-budget-overrides';

/** Injectable IO seam (tests). Defaults = the real flag + store + pool + env+override. */
export interface ScoutCeilingDeps {
  enabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  /** Windowed `blender:*` spend at/after sinceMs (the learning_spend_events read). */
  sumSpendSince?: (sql: Sql, q: { workspaceId: string; sinceMs: number }) => Promise<{ totalUsd: number; loopCount: number }>;
  /** Resolve the workspace ceiling. Async so the runtime PG override (P-022) can be consulted. */
  ceilingUsd?: () => number | Promise<number>;
  /** Clock seam (tests) — the window floor is nowMs() − SCOUT_WORKSPACE_CEILING_WINDOW_MS. */
  nowMs?: () => number;
  log?: (msg: string) => void;
}

const defaultDeps: Required<ScoutCeilingDeps> = {
  enabled: () => getFlag(FLAGS.LEARNING_GOVERNOR, 'learning-governor'),
  // Lazy import (registrants.ts pattern): a PG-free process must not load the
  // pool module before the flag check has a chance to short-circuit.
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  sumSpendSince: sumScoutSpendSince,
  // P-022: runtime PG override (learning:set-scout-budget) in front of the env, then the default.
  ceilingUsd: () => resolveScoutWorkspaceCeilingUsdLive(),
  nowMs: () => Date.now(),
  log: (m) => console.log(`[scout-workspace-ceiling] ${m}`),
};

function resolve(deps?: ScoutCeilingDeps): Required<ScoutCeilingDeps> {
  return { ...defaultDeps, ...deps };
}

/**
 * The verdict a no-op (flag-off) / fail-open gate returns: allow, with a zeroed
 * sum and the resolved ceiling for observability.
 */
function allowVerdict(ceilingUsd: number): ScoutWorkspaceCeilingVerdict {
  return { allow: true, totalScoutSpentUsd: 0, ceilingUsd, remainingUsd: ceilingUsd, scoutLoopCount: 0 };
}

/**
 * THE workspace-ceiling preflight the scout cycle's gate consults before a tick.
 *
 *   - governor flag OFF ⇒ ALLOW (no-op): the kill-switch — scout's per-cycle cap
 *     + cadence/budget self-gates still bound every cycle. (Symmetric with the
 *     scout MIRROR, which also no-ops flag-off.)
 *   - ON ⇒ sum every `scout:<hive>` registrant's ledgered spend and apply the
 *     pure rule (scoutWorkspaceCeilingVerdict): refuse once the aggregate reaches
 *     the ceiling.
 *   - IO error ⇒ FAIL OPEN (allow), logged: a workspace SAFETY cap layered over
 *     already-bounded per-hive cycles must not freeze the whole fleet's scout on
 *     a transient ledger-read failure. (This is the deliberate inverse of the
 *     FRONTIER preflight's fail-CLOSED: those loops have NO other gate, so a
 *     broken ledger must refuse them; scout always has its structural gates.)
 */
export async function scoutWorkspaceCeilingGate(
  q: { workspaceId: string },
  deps?: ScoutCeilingDeps,
): Promise<ScoutWorkspaceCeilingVerdict> {
  const d = resolve(deps);
  const ceilingUsd = await d.ceilingUsd();
  try {
    if (!(await d.enabled())) return allowVerdict(ceilingUsd);
    const sql = await d.getSql();
    const sinceMs = d.nowMs() - SCOUT_WORKSPACE_CEILING_WINDOW_MS;
    const spend = await d.sumSpendSince(sql, { workspaceId: q.workspaceId, sinceMs });
    const verdict = scoutWorkspaceCeilingVerdict(spend.totalUsd, spend.loopCount, ceilingUsd);
    if (!verdict.allow) {
      const windowH = Math.round(SCOUT_WORKSPACE_CEILING_WINDOW_MS / 3_600_000);
      d.log(
        `REFUSING new scout cycle for workspace ${q.workspaceId}: aggregate scout spend ` +
          `$${verdict.totalScoutSpentUsd.toFixed(2)} across ${verdict.scoutLoopCount} hive(s) ` +
          `in the last ${windowH}h ≥ ceiling $${ceilingUsd.toFixed(2)} (D-005 / P-051 workspace cap; ` +
          'override learning:set-scout-budget or PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD)',
      );
    }
    return verdict;
  } catch (e) {
    // Fail OPEN — the per-hive per-cycle cap + cadence/budget gates still bound
    // this cycle; a transient ledger-read failure must not freeze the fleet.
    d.log(`ceiling read failed for ${q.workspaceId} — allowing (fail-open): ${e instanceof Error ? e.message : e}`);
    return allowVerdict(ceilingUsd);
  }
}
