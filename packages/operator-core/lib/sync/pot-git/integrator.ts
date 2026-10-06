/**
 * pot-git/integrator.ts — the staging integrator (Phase 7 G-5/G-5b/G-5d,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-029, P-034, P-038;
 * D-010/D-011).
 *
 * The lock-authority LEASE HOLDER (one machine at a time, per authority/
 * lock-authority.ts) computes the shared `staging` ref by INTEGRATING every
 * member device's work head into a single line, and publishes it in ITS OWN
 * namespace (`refs/namespaces/<integratorHex>/refs/heads/staging`). Receivers
 * mirror + FAST-FORWARD-ONLY accept it (G-7c) — staging never rewinds.
 *
 * INTEGRATION POLICY (the merge-queue model), deterministic by device-hex order:
 *   - a member head already contained in staging → skip (nothing new);
 *   - staging is an ancestor of the head → FAST-FORWARD staging to it;
 *   - the two diverged → a bare-repo 3-way merge via `git merge-tree
 *     --write-tree` (no worktree); clean → a real merge commit (2 parents),
 *     conflict → SKIP that head and report it (the member rebases onto the new
 *     staging and re-publishes). A conflict never blocks the other members.
 *
 * TWO-SPEED (G-5b): this computes the FAST, ungated `staging` — every admitted
 * member's work integrates immediately. The GREEN-GATED release ref (a distinct,
 * test-passing tag) is a separate, slower promotion (G-6 canonical-ref rules +
 * the distributed gate, Phase 8) and is NOT computed here.
 *
 * EPOCH FENCING (G-5d): `integrateMemberHeads` is pure over the repo; the
 * authority's monotonic (epoch, seq) is stamped by the ANNOUNCEMENT layer (G-3)
 * when it signs the staging-advance, so a stale ex-authority's late advance is
 * fenced by (epoch, seq) < the current one. This module returns the new staging
 * sha for that announcement to carry.
 *
 * Pure over storage.ts's RunGit seam, so it unit-tests against a real temp bare
 * repo with member namespaces and no network.
 */

import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  readNamespaceRefForDevices,
  writeNamespaceRef,
} from './storage';

/** The within-namespace ref that holds a member device's work line. */
export const WORK_REF = 'refs/heads/work';
/** The within-namespace ref the integrator publishes the computed staging at. */
export const STAGING_REF = 'refs/heads/staging';

import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import type { SignedProtocolScope } from './signed-context';
import { RETIRED_HOST_LOCAL_GIT_TABLES } from '../../harness-state/table-registry';
import { stateDirFor } from '../../harness-state/git-export/serialize';

export interface MemberHead {
  /** The member device's namespace key (hex). */
  deviceHex: string;
  /** That device's work head sha (already verified via sigrefs by the caller). */
  sha: string;
}

/** A member head the integrator could not take this pass. */
export interface SkippedConflict {
  deviceHex: string;
  sha: string;
  /** Conflicted paths as reported by merge-tree (empty on a merge ERROR). */
  paths: string[];
  /** Set when merge-tree failed outright rather than reporting a conflict. */
  error?: string;
}

/** A member head integrated by resolving host-local state paths to staging. */
export interface HostLocalStateResolution {
  deviceHex: string;
  sha: string;
  /** The conflicted paths that took staging's side. */
  paths: string[];
}

export interface IntegrationResult {
  /** The new staging sha (unchanged from base when nothing integrated). */
  staging: string | null;
  /** Did staging move? */
  advanced: boolean;
  /** Device hexes whose work is now contained in staging (ff or merge). */
  integrated: string[];
  /** Heads left out because a 3-way merge conflicted — the member rebases. */
  skippedConflicts: SkippedConflict[];
  /** Heads integrated after their ONLY conflicts were host-local state paths
   *  (resolved to staging's side — see {@link isHostLocalStatePath}). */
  resolvedHostLocalState: HostLocalStateResolution[];
  /** WI-10004249: the base had fallen off the accepted staging floor and this
   *  pass folded the floor back in (fast-forward or merge). Optional so
   *  hand-built results in other callers' fixtures stay valid. */
  floorRestored?: boolean;
}

/**
 * WI-10003731: repo directories that hold PER-HOST machine state some installs
 * committed into shared repos before the table was reclassified sync:'none'
 * (`RETIRED_HOST_LOCAL_GIT_TABLES`). Derived from the one place rows become
 * files, so a rename there cannot silently stop matching here.
 */
export const HOST_LOCAL_STATE_DIRS: readonly string[] = RETIRED_HOST_LOCAL_GIT_TABLES.map(
  (t) => `${stateDirFor(t)}/`,
);

/** True when `path` (repo-relative) is retired per-host state — each device
 *  writes its own verdict there, so no member's copy is shared truth and the
 *  integrated staging side may win a conflict on it. */
export function isHostLocalStatePath(path: string): boolean {
  return HOST_LOCAL_STATE_DIRS.some((d) => path.startsWith(d));
}

/**
 * One-line suffix naming what each parked head conflicted on, for the
 * integrator's status note. Bounded (≤3 heads × ≤3 paths) so a pathological
 * conflict cannot bloat routine metadata; '' when nothing was parked.
 */
export function formatParkedConflicts(parked: readonly SkippedConflict[]): string {
  if (parked.length === 0) return '';
  const head = parked.slice(0, 3).map((c) => {
    const who = `${c.deviceHex.slice(0, 12)}@${c.sha.slice(0, 8)}`;
    if (c.error) return `${who}: merge error (${c.error.slice(0, 120)})`;
    const shown = c.paths.slice(0, 3).join(', ');
    const more = c.paths.length > 3 ? ` +${c.paths.length - 3} more` : '';
    return `${who}: ${shown || '(no paths reported)'}${more}`;
  });
  const moreHeads = parked.length > 3 ? `; +${parked.length - 3} more head(s)` : '';
  return ` parked: ${head.join('; ')}${moreHeads}`;
}

/**
 * The git-sync integrator leg's `metadata.integrator_status` for ONE tick that
 * reached the integrator. It must be written on EVERY such tick, an advancing
 * one included: the routine metadata is a jsonb merge, so a leg that recorded
 * only its declines left the previous "no advance" note standing after staging
 * moved (WI-10003731, 2026-09-28: the 18:40Z tick advanced hello-world-3-pot to
 * 69c6ccc while the status still read the 18:30Z `conflicts=1` note, which is
 * exactly the signal an operator reads to decide whether a fix worked).
 * `skipped` is null on an advance, matching "nothing was skipped".
 */
export function formatIntegratorTickStatus(tick: {
  advanced: boolean;
  staging: string | null | undefined;
  gated: { integrated: number; queued: number; errors: number } | null;
  parked: readonly SkippedConflict[];
  hostLocalResolved: number;
  errorCount: number;
}): { skipped: 'ran_no_advance' | null; detail: string } {
  const gate = tick.gated
    ? `integrated=${tick.gated.integrated} queued=${tick.gated.queued} errors=${tick.gated.errors}`
    : 'none';
  const hostLocal = tick.hostLocalResolved > 0 ? `; host-local-resolved=${tick.hostLocalResolved}` : '';
  const counts = `(gate: ${gate}; conflicts=${tick.parked.length}${hostLocal}; errors=${tick.errorCount})`;
  const parked = formatParkedConflicts(tick.parked);
  if (tick.advanced) {
    const to = tick.staging ? tick.staging.slice(0, 12) : 'unknown';
    return { skipped: null, detail: `integrator ran; advanced staging to ${to} ${counts}${parked}` };
  }
  return { skipped: 'ran_no_advance', detail: `integrator ran; no advance ${counts}${parked}` };
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
  return r.code === 0;
}

/** Bare-repo 3-way merge of two commits → {tree} on success, {conflict, paths}
 *  on a content conflict. Uses merge-tree --write-tree (git ≥2.38; `-X` needs
 *  ≥2.40): exit 0 = clean, exit 1 = conflicts, else error. `-z --name-only
 *  --no-messages` makes stdout `<tree>\0<path>\0…` so the conflicted paths are
 *  parseable whatever characters they contain. Also run against a member
 *  WORKTREE by catchUpWorktreeToWatermark (D-055) to name the paths that keep
 *  a diverged member parked; it writes objects, never the index or files. */
export async function mergeTree(
  repoPath: string,
  a: string,
  b: string,
  runGit: RunGit,
  strategyArgs: string[] = [],
): Promise<{ tree: string } | { conflict: true; paths: string[] } | { error: string }> {
  const r = await runGit(
    ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', ...strategyArgs, a, b],
    repoPath,
  );
  const [first, ...rest] = r.stdout.split('\0');
  if (r.code === 0) {
    const tree = first?.trim();
    return tree ? { tree } : { error: 'merge-tree produced no tree' };
  }
  if (r.code === 1) return { conflict: true, paths: [...new Set(rest.filter((p) => p.length > 0))] };
  return { error: r.stderr.trim() || `merge-tree exited ${r.code}` };
}

/** commit-tree a merge (2 parents) with a fixed integrator identity. Re-running
 *  integration is idempotent (integrated heads become staging ancestors → the
 *  skip path), so a wall-clock commit date never causes churn. */
async function commitMerge(
  repoPath: string,
  tree: string,
  parents: string[],
  message: string,
  runGit: RunGit,
): Promise<string> {
  const args = ['-c', 'user.name=hive-integrator', '-c', 'user.email=integrator@hive', 'commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  const r = await runGit(args, repoPath);
  if (r.code !== 0) throw new Error(`pot-git: commit-tree (merge) failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Integrate every member head into staging for the integrator device, publishing
 * the result at `refs/namespaces/<integratorHex>/refs/heads/staging`. Returns the
 * new staging sha + which heads integrated / conflicted. Best-effort per head: a
 * merge ERROR (not a clean conflict) skips that head as a conflict rather than
 * aborting the whole pass, so one bad head can't wedge integration.
 */
export async function integrateMemberHeads(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  memberHeads: MemberHead[],
  opts: {
    runGit?: RunGit;
    scope?: SignedProtocolScope;
    authority?: HiveEffectAuthority | null;
    /**
     * WI-10004249 — the staging receivers last ACCEPTED (the canonical floor).
     * Staging never rewinds: receivers accept an advance only as a fast-forward
     * of what they accepted before. The integrator's base can nonetheless fall
     * off that line, because own-head-publish writes the SAME
     * `ns/<integrator>/refs/heads/staging` ref with the local worktree head, and
     * once the worktree has failed to fast-forward onto one accepted merge the
     * published head no longer contains it. Every later advance is then non-FF,
     * terminally rejected, and canonical + GitHub egress freeze (measured: 22h,
     * papercusp, 2026-09-29T18:03Z → 2026-09-30). Folding the floor into the
     * base first makes every integration a descendant of what was accepted.
     */
    floorSha?: string | null;
  } = {},
): Promise<IntegrationResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const base = await readNamespaceRef(repoPath, integratorDevicePubkeyBase64, STAGING_REF, runGit);
  let staging = base;
  const integrated: string[] = [];
  const skippedConflicts: SkippedConflict[] = [];
  const resolvedHostLocalState: HostLocalStateResolution[] = [];
  let floorRestored = false;

  const floor = opts.floorSha ?? null;
  if (floor && floor !== staging && (await runGit(['cat-file', '-e', `${floor}^{commit}`], repoPath)).code === 0) {
    if (staging === null || (await isAncestor(repoPath, staging, floor, runGit))) {
      staging = floor;
      floorRestored = true;
    } else if (!(await isAncestor(repoPath, floor, staging, runGit))) {
      const merged = await mergeTree(repoPath, staging, floor, runGit);
      if ('tree' in merged) {
        staging = await commitMerge(
          repoPath,
          merged.tree,
          [staging, floor],
          `integrate accepted staging ${floor.slice(0, 8)}`,
          runGit,
        );
        floorRestored = true;
      } else {
        skippedConflicts.push({
          deviceHex: 'accepted-staging-floor',
          sha: floor,
          paths: 'conflict' in merged ? merged.paths : [],
          ...('error' in merged ? { error: merged.error } : {}),
        });
      }
    }
  }

  // Deterministic order so every observer of the same head-set gets the same
  // staging lineage (device-hex is peer-stable).
  const heads = [...memberHeads].sort((a, b) => a.deviceHex.localeCompare(b.deviceHex));

  for (const mh of heads) {
    if (!mh.sha) continue;
    if (staging === null) {
      staging = mh.sha;
      integrated.push(mh.deviceHex);
      continue;
    }
    if (mh.sha === staging) continue; // identical head
    // Already contained → nothing to do.
    if (await isAncestor(repoPath, mh.sha, staging, runGit)) continue;
    // Fast-forward: staging is strictly behind this head.
    if (await isAncestor(repoPath, staging, mh.sha, runGit)) {
      staging = mh.sha;
      integrated.push(mh.deviceHex);
      continue;
    }
    // Diverged → 3-way merge in the ODB (no worktree).
    const merged = await mergeTree(repoPath, staging, mh.sha, runGit);
    if ('tree' in merged) {
      staging = await commitMerge(
        repoPath,
        merged.tree,
        [staging, mh.sha],
        `integrate ${mh.deviceHex.slice(0, 12)} @ ${mh.sha.slice(0, 8)}`,
        runGit,
      );
      integrated.push(mh.deviceHex);
      continue;
    }
    if ('error' in merged) {
      skippedConflicts.push({ deviceHex: mh.deviceHex, sha: mh.sha, paths: [], error: merged.error });
      continue;
    }
    // WI-10003731: when EVERY conflict is retired per-host state, no side is
    // shared truth — re-merge preferring staging ("ours" = the first commit) so
    // the member's real work integrates instead of being parked forever. Any
    // other conflicted path keeps the old contract: skip, the member rebases.
    if (merged.paths.length > 0 && merged.paths.every(isHostLocalStatePath)) {
      const preferStaging = await mergeTree(repoPath, staging, mh.sha, runGit, ['-X', 'ours']);
      if ('tree' in preferStaging) {
        staging = await commitMerge(
          repoPath,
          preferStaging.tree,
          [staging, mh.sha],
          `integrate ${mh.deviceHex.slice(0, 12)} @ ${mh.sha.slice(0, 8)}` +
            ` (host-local state kept from staging: ${merged.paths.join(', ')})`,
          runGit,
        );
        integrated.push(mh.deviceHex);
        resolvedHostLocalState.push({ deviceHex: mh.deviceHex, sha: mh.sha, paths: merged.paths });
        continue;
      }
      // e.g. a modify/delete, which `-X ours` does not resolve → park as before.
      skippedConflicts.push({
        deviceHex: mh.deviceHex,
        sha: mh.sha,
        paths: 'conflict' in preferStaging ? preferStaging.paths : merged.paths,
        ...('error' in preferStaging ? { error: preferStaging.error } : {}),
      });
      continue;
    }
    // A real content conflict → leave for the member to rebase.
    skippedConflicts.push({ deviceHex: mh.deviceHex, sha: mh.sha, paths: merged.paths });
  }

  const advanced = staging !== base && staging !== null;
  if (advanced) {
    await requireHiveEffectAuthority(opts.authority, opts.scope ?? { hive_id: '', repo_key: '' },
      ['integrate-staging', repoPath, integratorDevicePubkeyBase64, staging!]);
    await writeNamespaceRef(
      repoPath,
      integratorDevicePubkeyBase64,
      STAGING_REF,
      staging as string,
      runGit,
      base ?? '0'.repeat(40),
    );
  }
  return { staging, advanced, integrated, skippedConflicts, resolvedHostLocalState, floorRestored };
}

/** Read the integrator's currently-published staging sha (null if none). */
export function readStaging(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  return readNamespaceRef(repoPath, integratorDevicePubkeyBase64, STAGING_REF, runGit);
}

/** Collect member work heads from the local mirror for a set of member devices
 *  (skips devices with no work head). The caller passes the CURRENT verified
 *  member set; a device whose sigrefs did not verify must be excluded upstream. */
export async function collectMemberHeads(
  repoPath: string,
  memberDevicePubkeysBase64: string[],
  runGit: RunGit = defaultRunGit,
): Promise<MemberHead[]> {
  const out: MemberHead[] = [];
  // ONE `for-each-ref` for every member, not one `git` spawn per member —
  // see readNamespaceRefForDevices (EI-18808838427010743).
  const shas = await readNamespaceRefForDevices(repoPath, memberDevicePubkeysBase64, WORK_REF, runGit);
  for (const dev of memberDevicePubkeysBase64) {
    const sha = shas.get(dev);
    if (sha) out.push({ deviceHex: deviceNamespaceKey(dev), sha });
  }
  return out;
}
