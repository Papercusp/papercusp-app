/**
 * tool-schema-staleness — "is the tool schema this process is serving OLDER than
 * the tree?" (EI-21351815194031529)
 *
 * ## The confusion this exists to kill
 *
 * An agent's tool DEFINITIONS are rendered by the operator it is talking to. On
 * the dev box that is `:3070`, which serves GREEN `main` — and the tree runs ahead
 * of `main` routinely by hours, and with a red gate by days. So a schema constraint
 * an agent hits at runtime may already have been REMOVED on staging.
 *
 * From inside the failing session those two situations are indistinguishable. Both
 * present identically: a refused call, a schema that says the constraint is real,
 * and a clean repro. Nothing in the refusal names the build that served it.
 *
 * Worse, the natural verification move resolves the ambiguity in the WRONG
 * direction. The agent opens the source file, sees the constraint is gone, and
 * concludes "already fixed — close it". That close is half right in the way that
 * costs the most: the reporter is still hitting the constraint, every peer will
 * keep hitting it, and the item that would have tracked the deploy is now closed.
 *
 * Measured instance: `work_items:complete` refused `verification.coverage.residue: []`
 * because the LIVE schema carried `minItems: 1`. The tree schema had already dropped
 * it, with tests. The fix sat committed-on-staging, not in `main`, not deployed.
 * Establishing that took a full investigation (read the source, diff it against the
 * served schema, run the tests, query the pipeline) to reach a one-line conclusion.
 * Two sibling filings against the same tool's completion schema already existed, so
 * the shape recurs.
 *
 * ## Why a per-FILE answer, and not "the operator is behind"
 *
 * The cheap version of this check — compare the running build to staging and warn
 * whenever it is behind — fires on essentially every capture, because the operator
 * is almost always behind staging by something. A warning that is always on is a
 * warning nobody reads, and it would bury the rare case where the stamp is the whole
 * answer. Scoping the question to the ONE file that defines the failing tool is what
 * makes a positive verdict rare enough to be worth acting on.
 *
 * ## The verdict is three-valued, and an UNKNOWN never renders as "current"
 *
 * Every leg here can legitimately fail: a desktop build has no repo to read, a tool
 * may have been registered without a readable call stack, git may be mid-rebase. The
 * naive shape (`false` for all of those) would silently convert "I could not tell"
 * into "your schema is current" — a false reassurance, and precisely the failure
 * class `candidate-contains.ts` was written to avoid. So `state` is
 * `'stale' | 'current' | 'unknown'` with an ENUMERATED `unknownReason`, and only
 * `'stale'` ever produces a hint line.
 *
 * Comparison is BLOB IDENTITY via `blobAtCommit`, reusing that module's primitives
 * rather than re-deriving them: `git rev-parse --verify <sha>:<path>` prints a sha on
 * success and fails loudly otherwise, so an absence cannot masquerade as a match.
 */

import { getBuildInfo } from './build-info';
import {
  blobAtCommit,
  containingSubmodulePath,
  gitReadForRepo,
  gitReadInSubdir,
  submoduleGitlinkAt,
  submodulePrefixes,
  type GitRead,
} from './candidate-contains';
import { realGit } from './git-pipeline-position';
import { integrationRoot } from './release-deploy-launch';
import { resolveToolSourceFile } from './tool-source-file';

/** Why a verdict could not be reached. Enumerated, not prose — a caller branches on it. */
export type StalenessUnknownReason =
  /** The tool name did not resolve to a registered tool, or it registered without a source file. */
  | 'tool-source-unknown'
  /** The running process could not report its own build sha. */
  | 'build-sha-unknown'
  /** The tool's defining file is not inside the repo root (a node_modules copy, a bundle). */
  | 'source-outside-repo'
  /** A git read failed — no repo on disk, an unreachable sha, a busy index. */
  | 'git-unreadable'
  /**
   * The path lives inside a submodule, but the gitlink pinning that submodule could
   * not be resolved at one of the two superproject refs, so there is no commit range
   * to measure. Distinct from `git-unreadable`: the reads SUCCEEDED and returned a
   * definitive "no such submodule at that commit". Either way it stays UNKNOWN —
   * absence is never a positive verdict.
   */
  | 'submodule-pin-unresolved'
  /**
   * The path does not exist in the tree ref at all, so its empty `git log` range is not
   * a measured "no newer commit" — there is nothing there to be current OR stale. The
   * reads SUCCEEDED (this is distinct from `git-unreadable`); the subject is simply not
   * a tracked path, and reporting `current` for it would be a confident verdict about
   * nothing (WI-10002100).
   */
  | 'path-absent-from-tree';

export type ToolSchemaStaleness =
  | {
      state: 'stale';
      /** Repo-relative path of the file defining the tool. */
      relPath: string;
      /** The build sha the running process is serving. */
      deployedSha: string;
      /** The branch the tree's current content was read from. */
      treeRef: string;
    }
  | { state: 'current'; relPath: string; deployedSha: string; treeRef: string }
  | { state: 'unknown'; reason: StalenessUnknownReason };

/**
 * Whether a caller-supplied repository path has commits newer than the build
 * serving the current request.  This is intentionally a separate type from
 * ToolSchemaStaleness: a capture's `paths` identify the subject of the report,
 * while the latter resolves the defining file for a failed tool.
 */
export type PathStaleness =
  | {
      state: 'stale';
      relPath: string;
      deployedSha: string;
      treeRef: string;
      /** Commits in the serving-build→tree range that touch this path. */
      newerCommits: string[];
    }
  | { state: 'current'; relPath: string; deployedSha: string; treeRef: string }
  | { state: 'unknown'; relPath: string; reason: StalenessUnknownReason };

export interface ToolSchemaStalenessDeps {
  /**
   * Resolve a tool name to the absolute file that defined it. Production uses
   * {@link resolveToolSourceFile}, which also answers inside a bundle (P-002); it is
   * async because the bundled case reads the bundle once.
   */
  sourceFileFor: (toolName: string) => string | null | Promise<string | null>;
  /** The build sha the running process was started from, or null. */
  deployedSha: () => string | null;
  /** Absolute repo root the relative path is computed against, and git runs in. */
  repoRoot: string;
  /** Git reader bound to `repoRoot`. */
  git: GitRead;
  /**
   * Ref holding the tree's current content. Defaults to the LOCAL `staging` branch,
   * deliberately: the pipeline's own candidate is cut from local `staging` and never
   * fetches, so comparing against `origin/staging` would answer about a different
   * object and make an un-pushed (but committed) fix read as absent.
   */
  treeRef?: string;
}

/**
 * Read the commit range for one caller-supplied path.  An empty `git log`
 * result is a measured "no newer commit"; null is an unreadable git result and
 * must stay UNKNOWN (absence is never a positive verdict).
 *
 * `notBefore` (EI-23762020538736279) additionally bounds the range by COMMIT TIME.
 * It exists because this primitive serves two questions that are NOT the same:
 *
 *   1. "Is the running build behind the tree?" — `pathsStalenessHint`. The whole
 *      range `deployedSha..treeRef` is the answer; leave `notBefore` unset.
 *   2. "Did this path move SINCE A GIVEN MOMENT?" — the claim-freshness port. The
 *      sha range alone CANNOT answer this: the deployed build lags `staging` by
 *      hours, so `deployedSha..treeRef` is dominated by commits that landed
 *      BEFORE that moment (deploy lag) rather than after it (real movement).
 *      Pass the moment as `notBefore` and only genuinely newer commits count.
 *
 * Supply an ISO-8601 instant with an explicit offset or `Z`. A bare local-looking
 * stamp is ambiguous to git and would silently shift the boundary by the host's
 * UTC offset, which on this box is -04:00.
 */
export async function pathStaleness(
  relPath: string,
  deps: Pick<ToolSchemaStalenessDeps, 'deployedSha' | 'repoRoot' | 'git'> & {
    treeRef?: string;
    notBefore?: string | null;
  },
): Promise<PathStaleness> {
  const treeRef = deps.treeRef ?? 'staging';
  if (!relPath || relPath.startsWith('/') || relPath.split('/').some((segment) => segment === '..')) {
    return { state: 'unknown', relPath, reason: 'source-outside-repo' };
  }
  const deployedSha = deps.deployedSha();
  if (!deployedSha) return { state: 'unknown', relPath, reason: 'build-sha-unknown' };
  // Keep the repoRoot in the dependency contract even though GitRead is already
  // bound to it; callers cannot accidentally compare against another checkout.
  void deps.repoRoot;
  // `--since` filters by COMMIT date, which on this tree is when git-sync's sweep
  // actually landed the change — the right boundary for "did this move since then".
  // Omitted entirely when unset, so the unbounded consumers are byte-identical.
  const sinceArgs = deps.notBefore ? [`--since=${deps.notBefore}`] : [];

  // The range read, shared by both the superproject and the in-submodule call below.
  // `from`/`to` are whichever pair of commits actually bounds the range for that repo;
  // the VERDICT always reports the superproject refs, because those name the comparison
  // the caller asked for — the submodule pins are an implementation detail.
  const readRange = async (
    git: GitRead,
    from: string,
    to: string,
    pathArg: string,
  ): Promise<PathStaleness> => {
    const commits = await git(['log', '--format=%H', ...sinceArgs, `${from}..${to}`, '--', pathArg]);
    if (commits === null) return { state: 'unknown', relPath, reason: 'git-unreadable' };
    const newerCommits = commits.split('\n').map((sha) => sha.trim()).filter(Boolean);
    if (newerCommits.length > 0) return { state: 'stale', relPath, deployedSha, treeRef, newerCommits };
    // An empty range is only a MEASURED "no newer commit" when the path actually exists
    // in the tree being compared (WI-10002100). `git log -- <path>` answers '' for a
    // path that is absent from the tree entirely — a typo, a rename, an untracked file,
    // a path from another checkout — and that empty string is indistinguishable from
    // "nothing changed". Probe the path at the tree ref: a deleted-in-range path already
    // surfaced above as a stale deletion commit, so an absent path with an empty range
    // was never tracked here at all. `ls-tree` exits 0 with EMPTY output for a missing
    // path (null only when git itself failed), and lists a directory as one entry, so
    // this answers for files and directories alike.
    const present = await git(['ls-tree', to, '--', pathArg]);
    if (present === null) return { state: 'unknown', relPath, reason: 'git-unreadable' };
    if (present.trim() === '') return { state: 'unknown', relPath, reason: 'path-absent-from-tree' };
    return { state: 'current', relPath, deployedSha, treeRef };
  };

  // A path INSIDE a submodule is not tracked by the superproject — which holds only a
  // gitlink for the whole subtree — so a superproject `git log` on it is ALWAYS empty,
  // however many commits the submodule really has. Reporting that empty result as a
  // measured "no newer commit" is a silent false-negative for every submodule-backed
  // subject (EI-23812772755803731), and it fails in the dangerous direction: it never
  // over-warns, it silently under-warns. That is not a corner case here — it covers the
  // whole `libs/generic/*` borrowable tier and EVERY db migration under
  // `libs/papercusp/libs/db/sql`. Measure the real range INSIDE the submodule instead,
  // between the commits its gitlink pins at the two superproject refs.
  //
  // Equal pins are a genuine `current`: the serving build and the tree reference the
  // same submodule commit, so nothing the build runs is behind — a later commit in the
  // submodule that the superproject has not pinned yet is outside `deployedSha..treeRef`
  // by construction, and belongs to the gitlink-bump question, not this one.
  //
  // `submodulePrefixes` returns [] for a repo without `.gitmodules`, so a non-submodule
  // tree keeps exactly the previous behaviour.
  const submodule = containingSubmodulePath(await submodulePrefixes(deps.git), relPath);
  if (!submodule) return readRange(deps.git, deployedSha, treeRef, relPath);

  const [from, to] = await Promise.all([
    submoduleGitlinkAt(deps.git, deployedSha, submodule),
    submoduleGitlinkAt(deps.git, treeRef, submodule),
  ]);
  if (from.state === 'unreadable' || to.state === 'unreadable') {
    return { state: 'unknown', relPath, reason: 'git-unreadable' };
  }
  if (from.state === 'absent' || to.state === 'absent') {
    return { state: 'unknown', relPath, reason: 'submodule-pin-unresolved' };
  }
  return readRange(
    gitReadInSubdir(deps.git, submodule),
    from.pin,
    to.pin,
    relPath.slice(submodule.length + 1),
  );
}

/**
 * Resolve a bounded set of capture paths and render one compact advisory for
 * paths that moved after the running build.  Unknown/current paths are silent;
 * a positive hint therefore never claims more than the git read established.
 */
export async function pathsStalenessHint(
  paths: readonly string[],
  overrides?: Partial<Pick<ToolSchemaStalenessDeps, 'deployedSha' | 'repoRoot' | 'git'>> & { treeRef?: string },
): Promise<string | null> {
  if (!paths.length) return null;
  try {
    const repoRoot = overrides?.repoRoot ?? integrationRoot();
    const deps = {
      repoRoot,
      deployedSha: overrides?.deployedSha ?? (() => getBuildInfo().sha),
      git: overrides?.git ?? gitReadForRepo(realGit, repoRoot),
      treeRef: overrides?.treeRef,
    };
    const verdicts = await Promise.all([...new Set(paths)].slice(0, 20).map((p) => pathStaleness(p, deps)));
    const stale = verdicts.filter((v): v is Extract<PathStaleness, { state: 'stale' }> => v.state === 'stale');
    if (!stale.length) return null;
    const shown = stale
      .slice(0, 4)
      .map((v) => `\`${v.relPath}\` (${v.newerCommits.length} newer commit${v.newerCommits.length === 1 ? '' : 's'}, tip \`${v.newerCommits[0]}\`)`)
      .join(', ');
    const remainder = stale.length > 4 ? ` (+${stale.length - 4} more)` : '';
    const { deployedSha, treeRef } = stale[0];
    return (
      `ⓘ Possible STALE RUNTIME, not an open defect: ${shown}${remainder} have commits newer than ` +
      `the running build (\`${deployedSha}\`) in \`${treeRef}\`. If this was observed live, ` +
      'verify the deployed generation before triaging; the behavior may already be fixed in the tree.'
    );
  } catch {
    return null;
  }
}

/**
 * Make `absolute` repo-relative, or return null when it does not live under `root`.
 *
 * Path-prefix comparison is done on segment boundaries (`root` + '/') so a sibling
 * directory that merely shares a name prefix — `papercup-release` next to
 * `papercusp` — can never be mistaken for a path inside the root. That sibling pair
 * genuinely exists on this box, and it is exactly the checkout a deployed operator
 * runs from, so the naive `startsWith(root)` would misfire on the common case.
 */
export function relativizeToRepo(absolute: string, root: string): string | null {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (absolute === normalizedRoot) return null;
  const prefix = `${normalizedRoot}/`;
  if (!absolute.startsWith(prefix)) return null;
  const rel = absolute.slice(prefix.length);
  return rel.length > 0 ? rel : null;
}

/**
 * Does the file defining `toolName` differ between the build this process is serving
 * and the current tree? See the module doc for why every failure is `'unknown'`.
 */
export async function toolSchemaStaleness(
  toolName: string,
  deps: ToolSchemaStalenessDeps,
): Promise<ToolSchemaStaleness> {
  const treeRef = deps.treeRef ?? 'staging';

  const sourceFile = await deps.sourceFileFor(toolName);
  if (!sourceFile) return { state: 'unknown', reason: 'tool-source-unknown' };

  const deployedSha = deps.deployedSha();
  if (!deployedSha) return { state: 'unknown', reason: 'build-sha-unknown' };

  const relPath = relativizeToRepo(sourceFile, deps.repoRoot);
  if (!relPath) return { state: 'unknown', reason: 'source-outside-repo' };

  // Both reads print a sha on success and fail loudly otherwise, so neither a
  // missing ref nor an unreadable repo can come back looking like a match.
  const [deployedBlob, treeBlob] = await Promise.all([
    blobAtCommit(deps.git, deployedSha, relPath),
    blobAtCommit(deps.git, treeRef, relPath),
  ]);
  if (!deployedBlob || !treeBlob) return { state: 'unknown', reason: 'git-unreadable' };

  return deployedBlob === treeBlob
    ? { state: 'current', relPath, deployedSha, treeRef }
    : { state: 'stale', relPath, deployedSha, treeRef };
}

/**
 * The one line stamped onto a filed tool-failure row, or `null` when there is nothing
 * worth saying (`'current'` and `'unknown'` both render nothing — an unknown is not a
 * finding, and saying so on every capture would be the noise this check avoids).
 *
 * Hedged on purpose ("may already be fixed"): a differing blob proves the file moved,
 * not that it moved for THIS constraint. The triager still verifies — the stamp exists
 * to make them suspect skew at all, which is the ingredient that was missing.
 */
export function renderStalenessHint(verdict: ToolSchemaStaleness, toolName: string): string | null {
  if (verdict.state !== 'stale') return null;
  return (
    `ⓘ Possible STALE SCHEMA, not an open defect: \`${verdict.relPath}\` (defines \`${toolName}\`) ` +
    `differs between the build serving this call (\`${verdict.deployedSha}\`) and \`${verdict.treeRef}\`. ` +
    `The constraint reported here may already be fixed in the tree but not yet deployed. ` +
    `Confirm with \`dev:pipeline_position { path: '${verdict.relPath}' }\` before triaging this as open — ` +
    `and if it is skew, the useful artifact is a standing fact naming the interim workaround, not a code change.`
  );
}

/**
 * The wired, never-throwing entry point used by `improvements:capture`.
 *
 * Returns the hint line for a tool whose defining file has moved since the running
 * build, or `null` for every other outcome — current, unknown, or a fault in this
 * check itself. A capture is a friction-moment write on someone else's critical
 * path: an annotation that cannot answer must cost them nothing, and must never be
 * the reason their report fails to file.
 *
 * Cost when it runs: two `git rev-parse` reads, each bounded by `realGit`'s 5s
 * subprocess timeout, and only on captures that carry a `toolFailure`.
 */
export async function toolFailureStalenessHint(
  toolName: string,
  overrides?: Partial<ToolSchemaStalenessDeps>,
): Promise<string | null> {
  try {
    const repoRoot = overrides?.repoRoot ?? integrationRoot();
    const verdict = await toolSchemaStaleness(toolName, {
      sourceFileFor: overrides?.sourceFileFor ?? resolveToolSourceFile,
      deployedSha: overrides?.deployedSha ?? (() => getBuildInfo().sha),
      repoRoot,
      git: overrides?.git ?? gitReadForRepo(realGit, repoRoot),
      treeRef: overrides?.treeRef,
    });
    return renderStalenessHint(verdict, toolName);
  } catch {
    return null;
  }
}
