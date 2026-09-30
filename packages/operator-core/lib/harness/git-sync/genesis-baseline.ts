/**
 * git-sync/genesis-baseline.ts — the G-10 genesis-publish baseline
 * (own-head-publish + ref-announce both consume it as `genesisBaselineSha`).
 *
 * Extracted from git-sync-action.ts by WI-6243 so it is testable over the
 * injected git seam like its pot-git siblings, instead of only behind the
 * action module's full mock harness.
 *
 * WHAT IT ANSWERS: on a FIRST publish there is no namespace ref to judge
 * against, so the G-10 guard would otherwise judge the repo's ENTIRE history.
 * Content a remote already serves is not NEW exposure, so genesis only needs to
 * guard the `(alreadyExposed, head]` delta. Without a baseline, a pre-existing
 * repo above the flood caps can never onboard onto the hive-git plane at all.
 *
 * ONLY LOCAL remote-tracking refs are consulted: no network, and a ref that
 * lags the real remote makes us judge MORE than needed, never less. Ancestry is
 * always verified so a diverged/rewound remote cannot smuggle a non-ancestor
 * baseline in, and every failure path falls back to `null` — the strict
 * full-history judge.
 *
 * WI-6243 (live-caught on the P-302 rig, 2026-07-27) — why this is no longer
 * `origin/<branch>`-or-nothing: the original form required BOTH a registry
 * `github_remote` AND a remote-tracking ref named exactly after the branch. A
 * pot created by the seed-snapshot clone path satisfies NEITHER — its registry
 * entry carries `github_remote: null`, and its only remote-tracking ref is
 * `refs/remotes/origin/papercusp-seed-snapshot-<uuid>` while the local branch
 * is `main`. So the mitigation was inert exactly where it was needed and
 * genesis judged the FULL history on EVERY tick: own-head-publish burned
 * 27.5 min per fire (vs ≤63s for every other git-sync step) holding the DBOS
 * dedup pin, the guard then refused, no namespace ref was ever written,
 * `priorSha` stayed null — and it repeated forever. Net effect: that device
 * never published its own head at all, i.e. a total non-participant in p2p
 * replication, with the whole git-sync cadence throttled 5min → ~30min behind
 * it.
 *
 * The registry field was only ever a PROXY for the real question. The git-level
 * facts are both stricter and more direct: a remote-tracking ref EXISTS (so a
 * fetch from that remote really happened) and the remote it tracks is NOT a
 * path on this machine. That is what is required now, and the baseline search
 * widens from one hard-coded ref name to the tightest already-exposed frontier
 * over ALL remote-tracking refs.
 *
 * ── WI-6251: the SAME disease one hop over (live-caught on the rig, 2026-07-27)
 *
 * `deriveGenesisBaselineSha` answers for ONE branch in the WORKTREE. ref-announce's
 * publish tick judges EVERY ref under this device's namespace in the BARE pot-git
 * store — a different repo AND a different question — yet it was fed that same
 * single worktree-derived sha. Two ways that is wrong, and the rig hit both:
 *
 *   1. WRONG REPO. The sha is resolved against the worktree clone; the guard runs
 *      in the bare store. They agree only by luck.
 *   2. WRONG REF. A mainline baseline says nothing about a namespace ref on a
 *      DIFFERENT line of history. The rig's own namespace carries a `refs/heads/
 *      staging` mirrored from a peer at a sha its `main` baseline cannot reach, so
 *      `(mainBaseline, staging]` spanned 7057 commits — the entire divergent
 *      history — and the guard cat-file'd every blob in it into a JS string. That
 *      is the 4GB heap OOM (EI-18759477854494594), every ~20-40 min, forever:
 *      DBOS faithfully restarts the fire at the same step after each crash.
 *
 * The fix lives one layer down, in `pot-git/namespace-genesis-baseline.ts`
 * (`deriveNamespaceGenesisBaseline`) — it reads the bare store, so it belongs in
 * the store's own layer, and this module now shares its `frontierBaseline` walk
 * rather than carrying a second copy that could drift.
 */
import { frontierBaseline } from '../../sync/pot-git/namespace-genesis-baseline';
import { type RunGit, defaultRunGit } from '../../sync/pot-git/storage';

/** The subset of a registry ProjectEntry this needs — kept structural so the
 *  helper does not drag the whole registry type into its test surface. */
export interface GenesisBaselineRepo {
  /** The worktree whose branch head is about to be published. */
  path: string;
  /** Normalized upstream clone URL from the registry, when known. A fast path
   *  for the external-remote gate — never required (WI-6243). */
  github_remote?: string;
}

/** A remote URL that is NOT a path on this machine. Matches http(s)://, ssh://,
 *  git://, and the scp-like `user@host:path` form; a bare/relative filesystem
 *  path (`/srv/mirror.git`, `../other`, `file://…`) deliberately does NOT count
 *  as exposure off this box. */
const EXTERNAL_REMOTE_URL_RE = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^\s/@]+@[^\s:/]+:)/;

/**
 * Resolve the genesis-publish baseline for `branch` in `repo`, or null to fall
 * back to the strict full-history judge.
 */
export async function deriveGenesisBaselineSha(
  repo: GenesisBaselineRepo,
  branch: string | undefined,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  try {
    // Resolve the branch EXACTLY as the publish ticks do (explicit cfg wins,
    // else the worktree's checked-out branch) so baseline and publish agree.
    let wtBranch = branch ?? null;
    if (!wtBranch) {
      const sym = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], repo.path);
      wtBranch = sym.code === 0 ? sym.stdout.trim() : null;
    }
    if (!wtBranch) return null;

    // "Already exposed off-box" gate. The registry's github_remote is a fast
    // path; absent it (every seed-snapshot pot), fall back to the git-level
    // truth — at least one configured remote with a non-local URL.
    if (!repo.github_remote && !(await hasExternalRemote(repo.path, runGit))) return null;

    const branchRef = `refs/heads/${wtBranch}`;
    // 1. The exact upstream for this branch — cheapest, and the intended case.
    const tip = await runGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${wtBranch}^{commit}`], repo.path);
    const tipSha = tip.code === 0 ? tip.stdout.trim() : '';
    if (tipSha) {
      const anc = await runGit(['merge-base', '--is-ancestor', tipSha, branchRef], repo.path);
      if (anc.code === 0) return tipSha;
    }
    // 2. WI-6243: no branch-named upstream (or it diverged) — use the tightest
    //    already-exposed frontier across every remote-tracking ref instead.
    return await deriveRemoteFrontierBaseline(repo.path, branchRef, runGit);
  } catch {
    return null; // strict fallback
  }
}

/** True when the repo has at least one configured remote whose URL is external
 *  (WI-6243) — proof that content fetched from it left this machine. */
async function hasExternalRemote(repoPath: string, runGit: RunGit): Promise<boolean> {
  const res = await runGit(['remote', '-v'], repoPath);
  if (res.code !== 0) return false;
  return res.stdout.split('\n').some((line) => {
    const url = line.trim().split(/\s+/)[1];
    return !!url && EXTERNAL_REMOTE_URL_RE.test(url);
  });
}

/**
 * WI-6243: the tightest baseline that is provably already exposed off-box.
 *
 * `git rev-list --boundary <branch> --not --remotes` walks the commits on
 * `<branch>` that NO remote-tracking ref reaches, and prints — prefixed with
 * '-' — exactly the commits it stopped at: remote-reachable parents of those
 * commits. That set IS the already-exposed frontier, found in one walk.
 *
 * Safety argument for picking a SINGLE boundary B: every commit U unreachable
 * from any remote ref is also unreachable from B (B is remote-reachable, so
 * everything reachable from B is too), and U is reachable from head. Hence
 * U ∈ (B, head] for ANY boundary B — the judged range is always a SUPERSET of
 * the genuinely-unexposed set. Picking one of several boundaries only ever
 * judges MORE, never less, so this can never under-guard.
 */
async function deriveRemoteFrontierBaseline(
  repoPath: string,
  branchRef: string,
  runGit: RunGit,
): Promise<string | null> {
  const anyRemoteRef = await runGit(['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/remotes/'], repoPath);
  if (anyRemoteRef.code !== 0 || !anyRemoteRef.stdout.trim()) return null;
  return await frontierBaseline(repoPath, branchRef, ['--not', '--remotes'], runGit);
}

