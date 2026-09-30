/**
 * pot-git/namespace-genesis-baseline.ts — the G-10 genesis baseline for a ref
 * under THIS device's own namespace, resolved in the BARE pot-git store.
 *
 * WI-6251 (live-caught on the P-302 rig, 2026-07-27) — the sibling bug to
 * WI-6243, and the one that actually took the box down.
 *
 * `harness/git-sync/genesis-baseline.ts` answers for ONE branch in the WORKTREE.
 * ref-announce's publish tick judges EVERY ref under this device's namespace in
 * the BARE store — a different repo AND a different question — yet it was fed
 * that same single worktree-derived sha. Two ways that is wrong, and the rig hit
 * both at once:
 *
 *   1. WRONG REPO. The sha is resolved against the worktree clone; the guard
 *      runs in the bare store. They agree only by luck.
 *   2. WRONG REF. A mainline baseline says nothing about a namespace ref on a
 *      DIFFERENT line of history. The rig's own namespace carries a
 *      `refs/heads/staging` mirrored from a peer, at a sha its `main` baseline
 *      cannot reach — so `(mainBaseline, staging]` spanned 7057 commits, the
 *      whole divergent history, and the guard cat-file'd every blob in it into a
 *      JS string. That is the 4GB heap OOM (EI-18759477854494594) that killed
 *      the sidecar every ~20-40 min: DBOS faithfully restarts the fire at the
 *      same step after each crash, so it recurred forever.
 *
 * This module asks the question in the store the guard actually reads, per ref.
 * On the rig that is 0 unexposed commits for the mirrored `staging` (a peer's
 * namespace already serves that exact sha) and 2 for `main`.
 */
import { type RunGit, defaultRunGit } from './storage';

/** Cost bound on the frontier walk. A ref with more unexposed commits than this
 *  still yields a SAFE (merely less tight) baseline: a truncated walk can only
 *  surface FEWER boundary commits, never a non-exposed one. */
export const MAX_FRONTIER_WALK_COMMITS = 50_000;

/** How many boundary commits to price before choosing. A merge can produce
 *  several and any ONE of them is safe (see `frontierBaseline`), so this only
 *  bounds how hard we try for the tightest. */
export const MAX_FRONTIER_CANDIDATES = 16;

/**
 * Ref classes that are PROOF content already left a machine. Deliberately a
 * closed allow-list rather than "everything but mine" — see the function doc.
 * Each entry is a bare prefix, which `--glob` expands to a `<prefix>/*` match.
 * The FIRST entry must stay the namespaces prefix: the self-exclude is placed
 * immediately before it, and `--exclude` binds only to the next glob.
 *
 * ⚠ Verified against git 2.43 rather than assumed — the near-miss formulations:
 *   `--exclude=refs/namespaces/<self>` (bare)  → does NOT exclude. The
 *      prefix-append rule that `--glob` applies does NOT apply to `--exclude`.
 *   `--exclude=refs/namespaces/<self>/* --all` → excludes, but `--all` then
 *      contributes any LOCAL `refs/heads/*`, which is not exposed content. In a
 *      store that has one, the target's own history reads as already-exposed and
 *      the guard judges NOTHING. That is the under-guard direction; the closed
 *      allow-list is what rules it out.
 */
export const EXPOSED_REF_GLOBS = ['refs/namespaces', 'refs/bootstrap-quarantine', 'refs/remotes'] as const;

/**
 * WI-10003528: the rev-list NEGATIVES naming the already-exposed set for the
 * device whose own namespace is `selfNamespaceHex`: `--not`, the self-exclude,
 * then every EXPOSED_REF_GLOBS glob. Append them after a walk's positive (and any
 * `^prior`) arguments.
 *
 * ONE definition, shared by the genesis frontier walk below AND the publish
 * guard's range on EVERY later publish (publish-guard.ts). Before this, the
 * exposed set applied only at genesis. Once a first publish landed, the guard
 * judged the whole (prior, head] again, so a device draining from an old
 * baseline re-scanned months of history other devices had already published.
 * Every synthetic test fixture in it became a HARD secrets wall needing a manual
 * per-path waiver (P-203 Mac VM, 2026-09-27: blocked at 3bc494237aac, a commit
 * five other device namespaces in that store already reached).
 *
 * Throws on a non-hex key rather than splicing arbitrary text into a ref glob:
 * callers run it inside their fail-closed paths.
 */
export function exposedRefNegatives(selfNamespaceHex: string): string[] {
  if (!/^[0-9a-f]+$/.test(selfNamespaceHex)) {
    throw new Error(`exposedRefNegatives: namespace key is not lowercase hex: ${JSON.stringify(selfNamespaceHex.slice(0, 80))}`);
  }
  // `--exclude=<glob>` filters only the refs the NEXT ref-glob contributes, hence
  // its placement immediately before the namespaces glob (EXPOSED_REF_GLOBS[0]).
  return ['--not', `--exclude=refs/namespaces/${selfNamespaceHex}/*`, ...EXPOSED_REF_GLOBS.map((g) => `--glob=${g}`)];
}

/**
 * The genesis baseline for ONE ref under this device's own namespace.
 *
 * The already-exposed set is named EXPLICITLY (see EXPOSED_REF_GLOBS), not as
 * "every ref except mine". That distinction is the whole safety margin: an
 * exclude-everything-else formulation would count any stray local ref in the
 * store as proof of exposure and judge NOTHING — an UNDER-guard, the one
 * direction that actually leaks. Each glob below is a class of ref that
 * provably left a machine:
 *   • another device's namespace  — that device published it to the hive
 *   • bootstrap-quarantine        — a peer served it to us
 *   • remote-tracking             — we fetched it from a remote
 * Our own namespace is held out of the first glob: it is exactly the content in
 * question. Anything not on this list is treated as unexposed and therefore
 * judged, which is the safe direction to be wrong in.
 *
 * Returns the ref's OWN tip when nothing under it is unexposed; the caller's
 * `fromOid === sha` check then skips the ref outright (an empty range), which is
 * strictly better than handing the guard a walk that finds nothing. Returns null
 * to mean "no baseline — fall back", never to mean "empty".
 */
export async function deriveNamespaceGenesisBaseline(
  repoPath: string,
  namespaceRefFullName: string,
  selfNamespaceHex: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  try {
    // A namespace ref need not be a commit (`refs/rad/handoff` is a blob).
    // `rev-list --objects <blob>` already judges such a ref correctly as the one
    // object it is, so leave it to the caller's fallback rather than walking it.
    const type = await runGit(['cat-file', '-t', namespaceRefFullName], repoPath);
    if (type.code !== 0 || type.stdout.trim() !== 'commit') return null;

    return await frontierBaseline(repoPath, namespaceRefFullName, exposedRefNegatives(selfNamespaceHex), runGit);
  } catch {
    return null; // strict fallback
  }
}

/**
 * Shared frontier walk: `rev-list --boundary <target> <negatives…>` walks the
 * commits under `<target>` that the already-exposed set does not reach, and
 * prints — prefixed with '-' — exactly the commits it stopped at. That set IS
 * the already-exposed frontier, found in one walk.
 *
 * `negatives` names the already-exposed set (`--not --remotes` for the worktree
 * form, `--not --exclude=… --all` for the namespace form).
 *
 * Safety argument for picking a SINGLE boundary B: every commit U unreachable
 * from the exposed set is also unreachable from B (B is exposed, so everything
 * reachable from B is too), and U is reachable from the target. Hence
 * U ∈ (B, target] for ANY boundary B — the judged range is always a SUPERSET of
 * the genuinely-unexposed set. Picking one of several boundaries only ever
 * judges MORE, never less, so this can never under-guard.
 */
export async function frontierBaseline(
  repoPath: string,
  targetRev: string,
  negatives: readonly string[],
  runGit: RunGit,
): Promise<string | null> {
  const walk = await runGit(
    ['rev-list', '--boundary', `--max-count=${MAX_FRONTIER_WALK_COMMITS}`, targetRev, ...negatives],
    repoPath,
  );
  if (walk.code !== 0) return null;
  const lines = walk.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    // Nothing under this ref is unexposed — the already-exposed set covers it
    // whole. The tip itself is the baseline: an empty range to judge.
    const head = await runGit(['rev-parse', '--verify', '-q', `${targetRev}^{commit}`], repoPath);
    return head.code === 0 ? head.stdout.trim() || null : null;
  }

  const boundary = lines
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1))
    .filter(Boolean);
  // No boundary at all ⇒ the unexposed history reaches a root: there is no
  // already-exposed content to lean on. Fall back to the strict full judge.
  if (boundary.length === 0) return null;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of boundary.slice(0, MAX_FRONTIER_CANDIDATES)) {
    // Belt-and-braces: never accept a non-ancestor.
    const anc = await runGit(['merge-base', '--is-ancestor', candidate, targetRev], repoPath);
    if (anc.code !== 0) continue;
    if (boundary.length === 1) return candidate;
    const count = await runGit(['rev-list', '--count', `${candidate}..${targetRev}`], repoPath);
    const distance = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
    if (!Number.isFinite(distance)) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
