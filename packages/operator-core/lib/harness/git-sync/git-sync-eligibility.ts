/**
 * git-sync-eligibility — the ONE answer to "does this registry entry get a
 * `system:git-sync` routine?" (git-sync-any-hive-2026-06-12 P-001, + the
 * seed-side half of P-008).
 *
 * We seed one routine per hive MEMBER checkout — never hive HOMES (a
 * `kind:'hive'` entry is a NON-repo state dir), never joiner-side
 * `remote_hive` VIEWS (non-repo dirs under ~/.papercusp/remote-hives —
 * EXCEPT a `self_repo` remote-hive entry, the release-install canonical
 * clone shape; see the reason table below), never
 * non-local deployments (a cloud-frame checkout is not on this box), and never
 * entries whose path is missing/vanished or carries no `.git`. The same
 * verdict gates both SEED time (B-01's three creator-side producers, B-03's
 * join path) and RUN time (git-sync-action's P-008 gate), so the vocabulary
 * below is pinned by git-sync-action.test.ts — change it only with a coord
 * broadcast to the plan's briefs.
 *
 * Pure + sync over a registry-snapshot `ProjectEntry`; the on-disk checks ride
 * an injected `pathExists` seam (default `existsSync`) so the fn unit-tests
 * without a filesystem — the house inject-the-IO-seam pattern
 * (cf. lib/hive-member-repos.ts).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectEntry } from '../../harness-registry';
import { isRepoLessHiveHome } from '../hive-groups';

export type IneligibleReason =
  | 'ephemeral_debris'
  | 'hive_home'
  | 'remote_hive_view'
  | 'no_path'
  | 'non_local_deployment'
  | 'not_a_git_repo';

/**
 * Ephemeral/benchmark INSTANCE slugs that must NEVER get a git-sync routine.
 *
 * INCIDENT 2026-06-18: a benchmark fleet (xbench / SWE-bench) left ~170 torn-down
 * per-task INSTANCE harnesses (`xbench-su-*-instance_*`, `xbq<hash>*instance*`) in
 * the registry. Each carried an ACTIVE `git-sync` routine that the routine engine
 * woke every tick → 143 no_path ticks/cycle saturated the single :3070 event loop →
 * it stopped draining PG result sockets → every MCP/HTTP call timed out (psu down).
 *
 * `no_path` alone did NOT save us: the routine still fires, stat()s, logs, and skips
 * every tick — the churn IS the per-tick wake ×170. Gating these at eligibility (the
 * one verdict both SEED and RUN consult) means they never get a routine seeded AND a
 * surviving routine fast-skips before any IO. Mirrors the watchdog's
 * EPHEMERAL_BENCHMARK_SLUG_RE (watchdog.ts P-006) — kept as a local copy so this pure,
 * import-light module gains no dependency on the heavy watchdog module. Real harnesses
 * (papercup, sb-devboard, sheets, restart, …) never match.
 */
const EPHEMERAL_INSTANCE_SLUG_RE =
  /(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|memcap|memrun)|-instance[_-]|_instance[_-]|instance[a-z0-9]{4,}|deleteme/i;

export interface GitSyncEligibility {
  eligible: boolean;
  reason?: IneligibleReason;
}

export interface GitSyncEligibilityDeps {
  /** On-disk existence check (default: fs.existsSync). `.git` may be a dir
   *  (normal clone) or a file (worktree/submodule) — existence is enough. */
  pathExists?: (p: string) => boolean;
}

/**
 * Verdict for one registry entry. Reasons, in precedence order:
 *   1. `ephemeral_debris` — an ephemeral/benchmark INSTANCE slug (xbench / xbq /
 *      *instance* / memcap / deleteme). Checked FIRST: it is a pure regex (no IO),
 *      and these must never get a git-sync routine (INCIDENT 2026-06-18 — the
 *      per-tick routine churn over torn-down instances saturated the event loop).
 *   2. `remote_hive_view` — joiner-side hive VIEW (`remote_hive` flag; these are
 *      also `kind:'hive'`, so the flag is checked first). EXCEPT `self_repo`:
 *      a release install self-admits the canonical hive with its `path` pointing
 *      at the REAL seeded clone (~/.papercusp-workspaces/clones/<hive>) and marks
 *      it `self_repo` (bootstrap-papercusp-hive defaultSelfAdmitCanonical) — that
 *      checkout is the self-improvement loop's working tree and MUST be synced
 *      joiner-side (push:false) or agent edits strand uncommitted forever
 *      (EI-8793). A dev-box joinHiveAsView VIEW carries no `self_repo` and still
 *      skips here. Flag-only (no IO — the 2026-06-18 invariant holds).
 *   3. `hive_home`        — `harness_kind === 'hive'` (non-repo state dir).
 *   4. `non_local_deployment` — `deployment.target` present and ≠ 'local'
 *      (seed-side half of P-008: the checkout lives on a cloud frame).
 *   5. `no_path`          — no registered path, or the path vanished from disk.
 *   6. `not_a_git_repo`   — the path exists but carries no `.git`.
 */
export function gitSyncEligibility(
  p: ProjectEntry,
  deps: GitSyncEligibilityDeps = {},
): GitSyncEligibility {
  const pathExists = deps.pathExists ?? existsSync;
  if (EPHEMERAL_INSTANCE_SLUG_RE.test(p.slug)) return { eligible: false, reason: 'ephemeral_debris' };
  if (p.remote_hive && !p.self_repo) return { eligible: false, reason: 'remote_hive_view' };
  // A kind:'hive' entry is normally a repo-LESS state dir → skip. EXCEPT a hive that IS its
  // OWN repo (Option-B merge, papercup→papercusp 2026-06-20): marked `self_repo` on the merged
  // registry entry, it owns a checkout and MUST be git-synced (else origin freezes). Flag-based
  // (no IO) so the early-return reasons stay IO-free (the 2026-06-18 instance-churn invariant).
  if (isRepoLessHiveHome(p)) return { eligible: false, reason: 'hive_home' };
  const target = p.deployment?.target;
  if (target && target !== 'local') return { eligible: false, reason: 'non_local_deployment' };
  if (!p.path || !pathExists(p.path)) return { eligible: false, reason: 'no_path' };
  if (!pathExists(join(p.path, '.git'))) return { eligible: false, reason: 'not_a_git_repo' };
  return { eligible: true };
}

// ── Seed-active default (P-005, RATIFIED 2026-06-13 — D-008: all-active) ───────
// The owner ratified "all members seed ACTIVE on create" (su-a72aa). Both sides
// seed active: creator-side members commit+fetch+merge+push; joiner-side clones
// are push:false (decideGitSyncPush), so "active" there means a local
// commit+fetch+merge mirror only — never a push. fork-PR stays the contribution
// path for joiners. Kept as constants so a future re-gate is still a one-liner.

export const GIT_SYNC_SEED_ACTIVE_CREATOR = true;
export const GIT_SYNC_SEED_ACTIVE_JOINER = true;

// ── Jittered per-key cron (D-004 multi-pusher) ─────────────────────────────────

/**
 * Deterministic jittered every-10-minutes 6-field cron for a key (the install
 * slug). The key hashes (FNV-1a) to a stable minute offset 0–9, producing
 * `'0 <o>,<o+10>,<o+20>,<o+30>,<o+40>,<o+50> * * * *'` — same shape
 * `computeNextFireAt` (harness/routines/cron.ts) already parses for papercup's
 * every-10-minutes DEFAULT_GIT_SYNC_CRON. The jitter cuts same-tick collisions between peers on a
 * shared hive (D-004 origin-serialized multi-pusher) and between many members
 * on one box, while keeping every member on a 10-minute cadence.
 */
export function gitSyncCronForKey(key: string): string {
  // FNV-1a 32-bit — tiny, dependency-free, stable across processes/platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const offset = h % 10;
  const minutes = [0, 10, 20, 30, 40, 50].map((m) => m + offset).join(',');
  return `0 ${minutes} * * * *`;
}
