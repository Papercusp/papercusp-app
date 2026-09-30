/**
 * Pre-launch CAPACITY check for a goal holder (WI-2140573 finding 5).
 *
 * Measured 2026-09-02 on the everything-goal: the holder's codex account
 * (`chatgpt-sub-cli`) had exhausted its weekly usage window (`usageWalled`,
 * reset ~5 days out). Every replacement the goal-holder respawner launched —
 * nine in ~3.5 hours, one every ~23 minutes — booted, sent its kickoff, and
 * died at the model layer ("You've hit your usage limit") before a single
 * assistant turn or tool call: an 11-line rollout with `token_count` info
 * null. Each one paid a full launch, an hourly rate-cap slot, a re-kick budget,
 * and a flap-damping restart, and produced nothing. The respawner had no way
 * to know, because nothing between "the holder is lost" and "launch" asked
 * whether the account the launch would land on could serve at all.
 *
 * This module is that question, asked the same way `accounts:status` answers
 * it (same rows, same `poolVerdictByProvider` rollup, same freshness rules), so
 * the respawner's deferral and the operator's Accounts tab can never disagree:
 *
 *  - a PINNED account (`launch profile account = '<pool id>'`) is judged alone;
 *  - an UNPINNED one (`'auto'` / `'default'` / absent) is judged as the whole
 *    provider pool, because that is what launch-time selection draws from;
 *  - a STALE / never-observed reading is UNKNOWN and never defers — a wall is
 *    only ever asserted from a fresh measurement, exactly like the rollup.
 *
 * Pure over `AccountStatusRow[]`; the one I/O door (`assessGoalHolderLaunch
 * CapacityForGoal`) folds the goal's launch settings and reads the live rows.
 */
import type { AccountProvider } from '../deployment/account-pool';
import {
  accountStatus,
  poolVerdictByProvider,
  type AccountStatusRow,
  type ProviderPoolVerdict,
} from '../deployment/account-pool-store';
import { foldLaunchProfile, type GoalLaunchSettings, type LaunchProfile } from '../goal-launch-settings';

/** Launch-profile `account` values that mean "resolve from the pool at launch time". */
export const HOLDER_LAUNCH_UNPINNED_ACCOUNTS: ReadonlySet<string> = new Set(['auto', 'default']);

export interface GoalHolderLaunchTarget {
  /**
   * The account provider the holder's agent draws credentials from, or null
   * when the agent has no pool mapping this module knows (an `omp` holder) —
   * a null provider is UNKNOWN, never a deferral.
   */
  provider: AccountProvider | null;
  /** The pool account id the profile PINS, or null for launch-time selection. */
  accountId: string | null;
  /** The launch-profile agent the target was derived from (for messages). */
  agent: string | null;
}

export type GoalHolderLaunchCapacityBinding = 'usage-wall' | 'rate-pause';

export type GoalHolderLaunchCapacityVerdict =
  | { kind: 'clear'; target: GoalHolderLaunchTarget; reason: string }
  /** Not enough MEASURED evidence to defer — the launch door decides, as before. */
  | { kind: 'unknown'; target: GoalHolderLaunchTarget; reason: string }
  | {
      kind: 'deferred';
      target: GoalHolderLaunchTarget;
      binding: GoalHolderLaunchCapacityBinding;
      /** Epoch ms the binding wall/pause is known to lift, or null when the provider gave none. */
      untilMs: number | null;
      /** Pool account ids measured unable to serve (the ones a launch would land on). */
      accountIds: string[];
      reason: string;
      pool: ProviderPoolVerdict;
    };

/**
 * Which account(s) a holder launched from this profile would draw on. Mirrors
 * how the launch door reads the same two keys: `agent` picks the provider pool
 * and `account` either pins one row or leaves selection to launch time.
 */
export function holderLaunchTarget(
  profile: Pick<LaunchProfile, 'agent' | 'account'> | null | undefined,
): GoalHolderLaunchTarget {
  const agent = profile?.agent ?? null;
  const provider: AccountProvider | null =
    agent === 'codex' ? 'codex' : agent === 'claude' || agent == null ? 'claude' : null;
  const account = typeof profile?.account === 'string' ? profile.account.trim() : '';
  const accountId = account && !HOLDER_LAUNCH_UNPINNED_ACCOUNTS.has(account) ? account : null;
  return { provider, accountId, agent };
}

/** The holder-role target for a goal's stored launch settings (pure; no DB). */
export function holderLaunchTargetForSettings(
  settings: GoalLaunchSettings | null | undefined,
): GoalHolderLaunchTarget {
  return holderLaunchTarget(foldLaunchProfile(settings ?? null, 'goal', null));
}

/**
 * Judge whether launching a holder onto `target` right now could reach the
 * model at all. Deferral requires a MEASURED verdict: every candidate row fresh
 * and unable to serve. Any stale row, unregistered pin, or unmapped provider is
 * `unknown` and lets the launch proceed — this guard exists to stop launches
 * that are CERTAIN to die, never to withhold recovery on a guess.
 */
export function assessGoalHolderLaunchCapacity(
  rows: readonly AccountStatusRow[],
  target: GoalHolderLaunchTarget,
  now: number = Date.now(),
): GoalHolderLaunchCapacityVerdict {
  if (!target.provider) {
    return {
      kind: 'unknown',
      target,
      reason: `agent '${target.agent ?? 'unset'}' has no account-pool provider mapping — capacity unjudged`,
    };
  }
  const provider = target.provider;
  let candidates = rows.filter((r) => r.provider === provider);
  if (target.accountId) {
    candidates = candidates.filter((r) => r.id === target.accountId);
    if (candidates.length === 0) {
      return {
        kind: 'unknown',
        target,
        reason:
          `pinned account '${target.accountId}' is not registered in the '${provider}' pool — ` +
          'the launch door decides',
      };
    }
  }
  if (candidates.length === 0) {
    return { kind: 'unknown', target, reason: `no '${provider}' accounts registered — the launch door decides` };
  }
  const pool = poolVerdictByProvider(candidates, now).find((p) => p.provider === provider);
  if (!pool) {
    return { kind: 'unknown', target, reason: `no '${provider}' rollup produced — the launch door decides` };
  }
  // `clear` needs a MEASURED row that can serve. No serviceable row plus any
  // unmeasured one is a partial answer — unknown, never clear and never a wall.
  if (pool.serviceable > 0) return { kind: 'clear', target, reason: pool.reason };
  if (!pool.atCapacity) return { kind: 'unknown', target, reason: pool.reason };
  // atCapacity ⇒ every candidate is FRESH and cannot serve: walled or paused.
  const walled = candidates.filter((r) => r.usageWalled);
  if (walled.length > 0) {
    const resets = walled.map((r) => r.usageResetAt).filter((t): t is number => typeof t === 'number' && t > now);
    return {
      kind: 'deferred',
      target,
      binding: 'usage-wall',
      untilMs: resets.length > 0 ? Math.max(...resets) : null,
      accountIds: walled.map((r) => r.id),
      reason: pool.reason,
      pool,
    };
  }
  const paused = candidates.filter((r) => r.rate.pausedUntil > now);
  if (paused.length > 0) {
    return {
      kind: 'deferred',
      target,
      binding: 'rate-pause',
      untilMs: Math.max(...paused.map((r) => r.rate.pausedUntil)),
      accountIds: paused.map((r) => r.id),
      reason: pool.reason,
      pool,
    };
  }
  // Defensive: an at-capacity rollup we cannot name a binding for is not a
  // deferral — never withhold recovery on a verdict this module cannot explain.
  return { kind: 'clear', target, reason: `${pool.reason} (no nameable binding — not deferring)` };
}

export interface GoalHolderLaunchCapacityDeps {
  /** Live `accounts:status` rows for the workspace (test seam). */
  readAccountStatus: (workspaceId: string) => Promise<readonly AccountStatusRow[]>;
  now: () => number;
}

const DEFAULT_CAPACITY_DEPS: GoalHolderLaunchCapacityDeps = {
  readAccountStatus: async (workspaceId) => await accountStatus(workspaceId),
  now: Date.now,
};

/**
 * The I/O door: fold the goal's holder-role launch profile (the same fold the
 * launch itself applies) and judge it against the workspace's live account rows.
 */
export async function assessGoalHolderLaunchCapacityForGoal(
  goal: { workspaceId: string; launchSettings?: GoalLaunchSettings | null },
  deps: GoalHolderLaunchCapacityDeps = DEFAULT_CAPACITY_DEPS,
): Promise<GoalHolderLaunchCapacityVerdict> {
  const target = holderLaunchTargetForSettings(goal.launchSettings);
  const rows = await deps.readAccountStatus(goal.workspaceId);
  return assessGoalHolderLaunchCapacity(rows, target, deps.now());
}

/** Human-readable "until" for logs and escalations. */
export function formatCapacityUntil(untilMs: number | null, now: number): string {
  if (untilMs == null) return 'no reset time supplied by the provider';
  const mins = Math.max(0, Math.round((untilMs - now) / 60_000));
  const iso = new Date(untilMs).toISOString();
  return mins >= 120 ? `${iso} (~${Math.round(mins / 60)}h)` : `${iso} (~${mins}m)`;
}
