/**
 * decide-git-sync-push — the ONE place that answers "should this seeded
 * git-sync routine push?" for every member shape (git-sync-any-hive-2026-06-12
 * P-002/P-011). Pure + sync; the GitHub permissions probe that feeds
 * `permissionsPush` lives separately in `../github-repo-permissions.ts`
 * (B-01 calls probe + decider at seed time).
 *
 * Why a wrong default is asymmetrically expensive — the `run-git-sync.ts`
 * `syncOneRepo` fetch-fail branch is NOT symmetric in `doPush`:
 *
 *   - `doPush: false` → a failed/absent fetch is BENIGN: the branch returns
 *     `{ status: 'synced' }` when it committed (else `'nothing'`), so a
 *     local-only / fetch-less repo gets quiet commit-only sync every tick.
 *   - `doPush: true`  → the same failed fetch returns `{ status: 'error',
 *     message: 'fetch failed; HEAD has unpushed commits …' }` whenever HEAD
 *     committed or is ahead of the last-known remote tip (GAP-4 guard) —
 *     which then ERROR-ESCALATES on every 10-minute tick (EI-18-class
 *     escalation noise) without ever self-healing.
 *
 * So `push: true` on a repo that can't push is loud, repeating noise — while
 * `push: false` on a repo that COULD push silently strands work locally.
 * This asymmetry is the whole reason the decider exists: pick the loud
 * failure only when push plausibly works, and the quiet local-only mode
 * whenever it provably can't.
 *
 * Rules, in precedence order:
 *   1. no upstream remote        → push: false  (P-011 — fetch-less repo)
 *   2. hive mode bridged/p2p-only → push: false (github-bridge-hive-egress
 *      P-003 / S-5: on a BRIDGED hive the bridge writer — the integrator
 *      lease holder — is the SOLE origin pusher, so member git-sync must be
 *      commit-only or it double-pushes/races the canonical refs; on a
 *      P2P-ONLY hive nobody pushes GitHub at all. `legacy`/absent leaves
 *      rules 1+3..6 byte-for-byte unchanged.)
 *   3. joiner-side clone         → push: false  (read-only; fork-PR is the
 *      contribution path — hive-from-github-url-2026-06-11 P-013)
 *   4. permissions.push === false → push: false (GitHub says no)
 *   5. permissions.push === true  → push: true  (GitHub says yes)
 *   6. unknown (null/undefined)   → push: true  (best-effort optimism — a
 *      wrong guess surfaces via the existing `git-sync-error` escalation,
 *      D-002 of the plan)
 */
import type { PotGitMode } from './hive-git-mode';

export interface PushDecisionInput {
  /** True for a joiner-side member clone (read-only by design). */
  joinerSide: boolean;
  /** False ⇒ push MUST be false — a fetch-less/local-only repo has no origin. */
  hasUpstreamRemote: boolean;
  /** GitHub `permissions.push` from the probe; null/undefined = unknown. */
  permissionsPush?: boolean | null;
  /**
   * The member's hive git mode (github-bridge-hive-egress P-003; resolved via
   * `getPotGitMode` from the federated hive_settings). `bridged`/`p2p-only`
   * force commit-only; `legacy`/null/undefined (incl. every non-hive member)
   * preserves the pre-bridge decision table exactly.
   */
  hiveGitMode?: PotGitMode | null;
}

export interface PushDecision {
  push: boolean;
  /** Stable leading token (snake_case, before the " — ") + human explanation. */
  reason: string;
}

/**
 * Decide the seeded routine's `push` flag. Pure + sync — callers run the
 * (best-effort, I/O-bearing) `fetchRepoPushPermission` probe separately and
 * pass its result in as `permissionsPush`.
 */
export function decideGitSyncPush(i: PushDecisionInput): PushDecision {
  if (i.hasUpstreamRemote === false) {
    return {
      push: false,
      reason:
        'no_upstream_remote — local-only repo with no origin; with push on, the failed fetch ' +
        'would error-escalate every tick (run-git-sync syncOneRepo); with push off, commit-only sync is quiet',
    };
  }
  if (i.hiveGitMode === 'bridged') {
    return {
      push: false,
      reason:
        'bridged_hive — the GitHub bridge egresses canonical refs (github-bridge-hive-egress S-1/S-5); ' +
        'member git-sync is commit-only so the bridge writer stays the sole origin pusher',
    };
  }
  if (i.hiveGitMode === 'p2p-only') {
    return {
      push: false,
      reason:
        'p2p_only_hive — code syncs on the hive P2P plane (lib/sync/hive-git); ' +
        'no GitHub remote is pushed by member git-sync',
    };
  }
  if (i.joinerSide === true) {
    return {
      push: false,
      reason: 'joiner_side — read-only member clone; fork-PR is the contribution path',
    };
  }
  if (i.permissionsPush === false) {
    return {
      push: false,
      reason: 'github_permissions_push_false — the GitHub token lacks push on the upstream repo',
    };
  }
  if (i.permissionsPush === true) {
    return {
      push: true,
      reason: 'github_permissions_push_true — the GitHub token has push on the upstream repo',
    };
  }
  return {
    push: true,
    reason:
      'permissions_unknown_optimistic — no permission signal; defaulting push on ' +
      '(a wrong guess surfaces via the git-sync-error escalation, D-002)',
  };
}
