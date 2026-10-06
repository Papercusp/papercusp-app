/**
 * Async completion tree stamps and the read-side freshness detector.
 *
 * Completion evidence is only useful when a later reader can tell whether the
 * verification still describes the checkout it is looking at.  Keep HEAD
 * resolution here as a small leaf so both the close path and read path share
 * the same exact observation, without importing the complete tool into reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { detectPapercupRoot } from '../../harness/register-papercusp';
import { hasValidGitEntry } from '../locks/valid-git-entry';
import { pinModuleState } from '@papercusp/module-singleton';
import { gitRefContains, type GitStdoutRead } from '../../git-ref-contains';
import { streamGitFields, type GitSpawnOptions } from './untouched-paths';
import type {
  CompletionSettlementManifest,
  CompletionTreeStamp,
  CompletionTreeContentIdentity,
  CompletionGitIgnoreStatus,
  CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_PATHS_PROBED = 60;
const OBJECT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const DOCUMENTED_GITIGNORED_SCRATCH_PREFIX = '.papercusp/scratch/';
const DOCUMENTED_GITIGNORED_TMP_PREFIX = '.papercusp/tmp/';
const DOCUMENTED_GITIGNORED_TMP_ROOT_PREFIX = '.papercusp/tmp-';

/**
 * EI-22344624691081449: a deletion is caller-owned evidence, but the server
 * still stamps the observed absence on the identity entry. Keep this local
 * intersection until the shared record schema carries the same optional marker.
 */
type CompletionTreeContentIdentityWithDeletion = CompletionTreeContentIdentity & {
  deletion?: true;
};

type CompletionEvidenceWithDeletedPaths = CompletionVerificationEvidence & {
  filesDeleted?: readonly string[];
};

export type { CompletionTreeContentIdentity } from '../../coord-lifecycle/records';

function canonicalEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'settlementManifest')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvidence(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Build the immutable generation-1 receipt for a newly closed code item. */
export function completionSettlementManifest(
  evidence: CompletionVerificationEvidence,
  generation = 1,
): CompletionSettlementManifest | undefined {
  const stamp = evidence.treeStamp;
  if (!stamp?.repositoryRoot || !stamp.contentIdentity?.length) return undefined;
  // Out-of-repo artifacts are already explicitly classified by the server. They
  // cannot be settled against a repository commit, so keep them in the tree stamp
  // but omit them from the settlement receipt and its normalized path set.
  const repoBackedIdentity = stamp.contentIdentity.filter((identity) => identity.outOfRepoArtifact !== true);
  if (repoBackedIdentity.length === 0) return undefined;
  const defaultRoot = nodePath.resolve(stamp.repositoryRoot);
  const contentIdentity = [...repoBackedIdentity]
    .map((identity) => ({
      ...identity,
      path: identity.path.replaceAll('\\', '/'),
      ...(identity.repositoryRoot ? { repositoryRoot: nodePath.resolve(identity.repositoryRoot) } : {}),
    }))
    .sort((a, b) => {
      const rootOrder = (a.repositoryRoot ?? defaultRoot).localeCompare(b.repositoryRoot ?? defaultRoot);
      if (rootOrder !== 0) return rootOrder;
      const pathOrder = a.path.localeCompare(b.path);
      if (pathOrder !== 0) return pathOrder;
      return (a.headSha ?? stamp.headSha).localeCompare(b.headSha ?? stamp.headSha);
    });
  // Keep one normalized path for each content-identity entry. A plain Set used to
  // collapse equal relative names from sibling checkouts, making the receipt unable
  // to represent both path identities even though the tree stamp already had them.
  const normalizedPaths = contentIdentity.map(({ path }) => path);
  if (normalizedPaths.length === 0) return undefined;
  return {
    version: 1,
    generation,
    evidenceHash: createHash('sha256').update(canonicalEvidence(evidence)).digest('hex'),
    repositoryRoot: defaultRoot,
    headSha: stamp.headSha,
    normalizedPaths,
    contentIdentity,
  };
}

/** Injected reads for {@link completionTreeStamp}, so it is unit-testable. */
export interface CompletionTreeStampProbe {
  repoRoot?: string | null;
  /** Returns file contents, or undefined when the path does not exist / cannot be read. */
  readFile?: (absPath: string) => string | undefined;
  /** Returns raw file bytes, preserving Git's blob hash semantics for binary files. */
  readBytes?: (absPath: string) => Uint8Array | undefined;
  /** Declared paths whose working-tree and HEAD blob identities should be recorded. */
  filesChanged?: readonly string[];
  /** Declared paths that must be absent from both the working tree and HEAD. */
  filesDeleted?: readonly string[];
  /** Injectable HEAD tree lookup; production uses one bounded `git ls-tree` read. */
  headBlobs?: (
    repoRoot: string,
    headSha: string,
    paths: readonly string[],
  ) =>
    | ReadonlyMap<string, HeadBlobResolution>
    | undefined
    | Promise<ReadonlyMap<string, HeadBlobResolution> | undefined>;
  /** Injectable best-effort ignore probe; production uses one bounded Git status read. */
  gitIgnoreStatusProbe?: (
    repoRoot: string,
    paths: readonly string[],
  ) =>
    | ReadonlyMap<string, CompletionGitIgnoreStatus>
    | undefined
    | Promise<ReadonlyMap<string, CompletionGitIgnoreStatus> | undefined>;
}

/**
 * WI-42441 — the HEAD side of one declared path, THREE-valued on purpose.
 *
 * The predecessor returned `ReadonlyMap<string, string | null>` and signalled
 * "not in the commit" by leaving the path OUT of the map. That overloads absence:
 * a submodule whose descent failed (not initialized — routine in a `git worktree`
 * checkout, WI-40231) dropped out of the map exactly like a path the commit really
 * does not carry. Downstream that became `missing-from-commit`, which reads as
 * "the closer declared a path that is not in the commit" and sends them to re-verify
 * a tree that was already correct.
 *
 * So every requested path now gets an entry, and the two failures are separate
 * constructors. This is the same discipline `candidate-contains.ts` already applies
 * to the gate's blob-containment read ("an ABSENCE must never read as a POSITIVE");
 * the two modules answer the same question about the same trees, and this one was
 * the half still conflating them.
 */
export type HeadBlobResolution =
  /** The commit carries this path, at this blob. */
  | { status: 'resolved'; sha: string }
  /** Definitively NOT in the commit — the tree was read, and the path is not in it. */
  | { status: 'absent' }
  /** The lookup could not answer. NEVER a verdict about the commit's contents. */
  | { status: 'unresolvable'; reason: string };

/** The blob sha when resolved, else null — for readers that only need the match test. */
export function headBlobShaOf(resolution: HeadBlobResolution | undefined): string | null {
  return resolution?.status === 'resolved' ? resolution.sha : null;
}

function normalizedRepoPath(repoRoot: string, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('*') || trimmed.includes('?')) return undefined;
  const abs = nodePath.resolve(repoRoot, trimmed);
  if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) return undefined;
  return nodePath.relative(repoRoot, abs).split(nodePath.sep).join('/');
}

function gitBlobSha(bytes: Uint8Array, shaLength: number): string {
  const algorithm = shaLength === 64 ? 'sha256' : 'sha1';
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return createHash(algorithm).update(header).update(bytes).digest('hex');
}

/**
 * WI-10004711: the CURRENT working-tree blob of one declared path, hashed exactly the
 * way the close-time identity was (`contentIdentity` above: raw bytes, no clean filter),
 * so a settlement reader compares like with like.
 *
 * `null` = the path is not in the working tree. `undefined` = this reader could not
 * answer (path escapes the root, not a regular readable file) — never a verdict.
 */
export function completionWorkingTreeBlobSha(
  repoRoot: string,
  rawPath: string,
  shaLength: number,
): string | null | undefined {
  const path = normalizedRepoPath(repoRoot, rawPath);
  if (!path || path !== rawPath) return undefined;
  const abs = nodePath.join(repoRoot, path);
  if (!existsSync(abs)) return null;
  try {
    return gitBlobSha(readFileSync(abs), shaLength);
  } catch {
    return undefined;
  }
}

/** Read exact commit blob identities through the shared nonblocking Git stream. */
export async function completionHeadBlobMap(
  repoRoot: string,
  headSha: string,
  paths: readonly string[],
  opts: GitSpawnOptions = {},
): Promise<ReadonlyMap<string, HeadBlobResolution> | undefined> {
  if (opts.signal?.aborted) return Promise.resolve(undefined);
  try {
    const runLsTree = async (
      root: string,
      sha: string,
      selected?: readonly string[],
      recursive = true,
    ): Promise<string[] | undefined> => {
      const fields: string[] = [];
      const outcome = await streamGitFields(
        [
          '-C',
          root,
          'ls-tree',
          ...(recursive ? ['-r'] : []),
          '-z',
          sha,
          ...(selected?.length ? ['--', ...selected] : []),
        ],
        (field) => {
          if (field) fields.push(field);
        },
        // WI-10005340: this is the settlement reconciler's main per-row lookup, issued
        // once or twice for every candidate on every git-sync pass. Forked locally it
        // blocked bg-host's main thread ~86 ms per call (178 of ~236 forks in a 300 s
        // trace). The read never stops early and already keeps every field, so the
        // sidecar's buffered stdout changes nothing about what is returned.
        { ...opts, timeoutMs: opts.timeoutMs ?? 5000, preferSidecar: true },
      );
      return outcome === 'complete' ? fields : undefined;
    };
    const parseTree = (records: readonly string[]) => {
      const blobs = new Map<string, string>();
      const gitlinks = new Map<string, string>();
      for (const record of records) {
        const tab = record.indexOf('\t');
        if (tab < 0) continue;
        const [mode, type, sha] = record.slice(0, tab).split(/\s+/);
        const path = record.slice(tab + 1);
        if (!sha || !OBJECT_SHA_RE.test(sha)) continue;
        if (type === 'blob' && mode) blobs.set(path, sha);
        if (type === 'commit' && mode === '160000') gitlinks.set(path, sha);
      }
      return { blobs, gitlinks };
    };

    if (paths.length === 0) return new Map();
    const directTree = await runLsTree(repoRoot, headSha, paths);
    if (!directTree || opts.signal?.aborted) return undefined;
    const direct = parseTree(directTree);
    const result = new Map<string, HeadBlobResolution>();
    for (const [path, sha] of direct.blobs) result.set(path, { status: 'resolved', sha });

    const missing = paths.filter((path) => !result.has(path));
    if (missing.length > 0) {
      // A path below a submodule is absent from the superproject's recursive
      // tree: Git stores only the 160000 gitlink. Read the committed gitlinks,
      // then resolve each descendant against the exact submodule commit pinned
      // by this HEAD. Grouping keeps the lookup bounded to one recursive call
      // per referenced submodule, and recursion covers nested submodules too.
      // A full recursive tree would retain unrelated records for the whole superproject.
      // Query only the ancestor prefixes of the missing paths; a non-recursive ls-tree
      // returns the exact gitlink records while keeping the lookup bounded by the declared
      // path set.
      const gitlinkPrefixes = [
        ...new Set(
          missing.flatMap((path) => {
            const segments = path.split('/');
            return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
          }),
        ),
      ];
      const gitlinkTree = await runLsTree(repoRoot, headSha, gitlinkPrefixes, false);
      if (!gitlinkTree || opts.signal?.aborted) return undefined;
      const allGitlinks = parseTree(gitlinkTree).gitlinks;
      const grouped = new Map<string, { sha: string; paths: string[] }>();
      for (const path of missing) {
        const prefix = [...allGitlinks.keys()]
          .filter((candidate) => path.startsWith(candidate + '/'))
          .sort((a, b) => b.length - a.length)[0];
        if (!prefix) continue;
        const group = grouped.get(prefix) ?? { sha: allGitlinks.get(prefix)!, paths: [] };
        group.paths.push(path.slice(prefix.length + 1));
        grouped.set(prefix, group);
      }
      for (const [prefix, group] of grouped) {
        const nested = await completionHeadBlobMap(nodePath.join(repoRoot, prefix), group.sha, group.paths, opts);
        if (opts.signal?.aborted) return undefined;
        for (const path of group.paths) {
          // A submodule we could not read answers NOTHING about the commit's contents.
          // Reporting it as absent is the WI-42441 conflation: it blames the closer for
          // a path the server merely failed to resolve.
          result.set(
            `${prefix}/${path}`,
            nested
              ? (nested.get(path) ?? { status: 'absent' })
              : {
                  status: 'unresolvable',
                  reason:
                    `submodule '${prefix}' could not be read at ${group.sha.slice(0, 12)} ` +
                    `(not initialized in this checkout, or its object store is unreadable)`,
                },
          );
        }
      }
      // Anything still unaccounted for was read out of a tree that simply does not
      // carry it — the one case that IS a definitive negative.
      for (const path of missing) if (!result.has(path)) result.set(path, { status: 'absent' });
    }
    return result;
  } catch {
    return undefined;
  }
}

type CompletionHistoryLocation = {
  repositoryRoot: string;
  commitSha: string;
  path: string;
};

/**
 * EI-24821039535031884: the answer of {@link completionBlobHistoryContains}.
 * - `true` / `false`: git MEASURED the range (found / definitively not found).
 * - `undefined`: the proof is impossible for a reason that will not change on
 *   retry (malformed input, a path that does not normalize, from/to resolving to
 *   different repositories, git refusing the read). Callers persist it as residue.
 * - `'unmeasured'`: a git read hit its deadline, or the pass was aborted. Nothing
 *   was learned about the path, so callers must retry instead of persisting a
 *   verdict. Recording a timeout as `identity-unavailable` is the defect class
 *   EI-24807349327024992 removed for the exact-tree lookup.
 */
export type CompletionBlobHistoryVerdict = boolean | 'unmeasured' | undefined;

/** Ancestor directories of a repo-relative path, outermost first: 'a/b/c.ts' gives ['a', 'a/b']. */
function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Which of `prefixes` are gitlinks at one commit: prefix to the pinned submodule commit,
 * or null when the prefix is a tree, a blob, or absent there. `'unmeasured'` means the read
 * timed out (or the pass aborted); undefined is a deterministic refusal.
 */
type GitlinkPrefixRead = ReadonlyMap<string, string | null> | 'unmeasured' | undefined;
type GitlinkPrefixReader = (
  root: string,
  commitSha: string,
  prefixes: readonly string[],
  opts: GitSpawnOptions,
) => Promise<GitlinkPrefixRead>;

/** One non-recursive ls-tree answers every requested prefix at once. */
async function readGitlinkPrefixes(
  root: string,
  commitSha: string,
  prefixes: readonly string[],
  opts: GitSpawnOptions,
): Promise<GitlinkPrefixRead> {
  const entries: string[] = [];
  const outcome = await streamGitFields(
    ['-C', root, 'ls-tree', '-z', commitSha, '--', ...prefixes.map((prefix) => ':(literal)' + prefix)],
    (entry) => {
      if (entry) entries.push(entry);
    },
    // One entry per requested prefix: bounded output, so the sidecar can run it.
    // The settlement reconciler issues these on every git-sync pass from bg-host
    // (~8/s traced 2026-10-01, ~54 ms of frozen loop per local fork).
    { ...opts, timeoutMs: opts.timeoutMs ?? 5000, preferSidecar: true },
  );
  if (opts.signal?.aborted || outcome === 'timeout') return 'unmeasured';
  if (outcome !== 'complete') return undefined;
  const gitlinks = new Map<string, string | null>(prefixes.map((prefix) => [prefix, null]));
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(/\s+/);
    const name = entry.slice(tab + 1);
    if (mode !== '160000' || type !== 'commit' || !sha || !OBJECT_SHA_RE.test(sha)) continue;
    // A gitlink that is an ancestor of a requested path is itself one of the requested
    // prefixes, so entries outside the request can be ignored.
    if (gitlinks.has(name)) gitlinks.set(name, sha);
  }
  return gitlinks;
}

/**
 * Resolve a declared path to the repository and commit that own it at one
 * superproject commit. Gitlinks are read from that commit's tree, not from the
 * checkout's possibly stale .gitmodules or working tree. `'unmeasured'` means an
 * ls-tree read timed out (or the pass aborted); undefined is a deterministic refusal.
 */
async function completionHistoryLocation(
  repoRoot: string,
  commitSha: string,
  path: string,
  opts: GitSpawnOptions,
  readGitlinks: GitlinkPrefixReader = readGitlinkPrefixes,
): Promise<CompletionHistoryLocation | 'unmeasured' | undefined> {
  if (opts.signal?.aborted) return 'unmeasured';
  const root = nodePath.resolve(repoRoot);
  const prefixes = ancestorPrefixes(path);
  if (prefixes.length === 0) return { repositoryRoot: root, commitSha, path };

  const gitlinks = await readGitlinks(root, commitSha, prefixes, opts);
  if (opts.signal?.aborted || gitlinks === 'unmeasured') return 'unmeasured';
  if (!gitlinks) return undefined;

  // Prefixes run outermost first, so the last gitlink seen is the deepest one.
  let bestPrefix: string | undefined;
  let bestSha: string | undefined;
  for (const prefix of prefixes) {
    const sha = gitlinks.get(prefix);
    if (!sha) continue;
    bestPrefix = prefix;
    bestSha = sha;
  }
  if (!bestPrefix || !bestSha) return { repositoryRoot: root, commitSha, path };

  const nestedRoot = nodePath.resolve(root, bestPrefix);
  if (!nestedRoot.startsWith(root + nodePath.sep)) return undefined;
  const nestedPath = path.slice(bestPrefix.length + 1);
  if (!nestedPath) return undefined;
  return completionHistoryLocation(nestedRoot, bestSha, nestedPath, opts, readGitlinks);
}

/**
 * Prove that a blob was committed at this exact path between the completion's
 * observed HEAD and the emitted commit. The location is resolved at both ends
 * so a superproject file can never prove a submodule blob (or vice versa).
 *
 * Returns undefined when the proof is impossible (callers preserve residue) and
 * `'unmeasured'` when a git read timed out (callers retry; see
 * {@link CompletionBlobHistoryVerdict}). Successful empty history is a
 * definitive false, which keeps ODB only and same-blob-at-another-path content
 * from becoming settlement proof.
 */
export async function completionBlobHistoryContains(
  repoRoot: string,
  fromHeadSha: string,
  toCommitSha: string,
  rawPath: string,
  blobSha: string,
  opts: GitSpawnOptions = {},
): Promise<CompletionBlobHistoryVerdict> {
  return blobHistoryContains(readGitlinkPrefixes, repoRoot, fromHeadSha, toCommitSha, rawPath, blobSha, opts);
}

/**
 * WI-10005357: a {@link completionBlobHistoryContains} whose gitlink reads are shared.
 *
 * Every settlement row in one git-sync pass is checked against the SAME emitted commit,
 * and a row's declared paths share directories. Resolving each path on its own cost one
 * `ls-tree` per path per side (plus one per submodule level): ~655 of ~843 git execs in a
 * traced 90 s pass (2026-10-02), each a governed sidecar read, so no pass ever finished.
 *
 * The answer for a prefix depends only on (repository, commit, prefix), and a commit is
 * immutable, so one reader per pass memoizes it. Concurrent rows share an in-flight read.
 * A `'unmeasured'` answer (timeout or abort) is never kept, so a later ask retries it.
 */
export interface CompletionBlobHistoryReader {
  /** Same contract as {@link completionBlobHistoryContains}. */
  readonly contains: typeof completionBlobHistoryContains;
  /**
   * Announce paths that a later `contains` may resolve at this commit. Nothing is read
   * here: the first read at the commit folds in every announced path's prefixes, so a
   * row's paths (or a whole pass's paths at the emitted commit) cost one ls-tree, not one
   * each. Announced paths that resolve into a submodule are announced there too.
   */
  hint(repoRoot: string, commitSha: string, paths: readonly string[]): void;
  /**
   * WI-10005380: announce (path, close-time blob) pairs that a later `contains` from
   * `fromHeadSha` may ask about. Nothing is read here: the first history search over a
   * range folds in every announced pair whose next search is that same range, so a pass
   * costs about one `git log` per distinct range instead of one per (row, path).
   */
  hintBlobs(repoRoot: string, fromHeadSha: string, entries: ReadonlyArray<{ path: string; blobSha: string }>): void;
  /** How many gitlink ls-tree reads this reader has issued. */
  gitlinkReads(): number;
  /** How many history `git log` reads this reader has issued. */
  historyReads(): number;
  /** WI-10005524: how many `merge-base` reads re-proved a kept match at a later commit. */
  ancestryReads(): number;
}

/**
 * WI-10005380: how far history has already been searched for a (path, close-time blob),
 * kept ACROSS settlement passes.
 *
 * A row that cannot settle is re-checked on every rotation (527 of 555 candidates,
 * measured 2026-09-30), and each check used to search its whole `closeHead..emitted`
 * range again in its own exec: 4,632 `git log --find-object` execs in 10 min
 * (2026-10-02, after WI-10005357).
 *
 * A NO-MATCH (`searchedThrough`) says "no commit reachable from W and not from the
 * close-time commit has this blob at this path". It stays exact for any later commit T,
 * ancestor or not, because from..T = (from..W) ∪ (T ^W ^from); the next search covers
 * only the second part.
 *
 * WI-10005524: a MATCH (`foundThrough`) is kept too. It says "the exact per-pair search
 * over from..W found the blob". A row with one matched path and another residual path
 * stays unsettled, so without this its match was re-proved by a per-pair `git log` on
 * every rotation (~1,198 execs / 10 min, measured 2026-10-02). It is exact for a later T
 * only when W is an ancestor of T (the matching commit stays reachable from T, and it is
 * still not reachable from `from`), so the reader proves that with one `merge-base` per
 * (repository, W, T) shared by the whole pass, and searches again when it cannot (a
 * submodule gitlink can move to a non-descendant commit).
 */
type CompletionHistoryAt = {
  /** Where the pair resolved at its close-time HEAD (fixed for that commit). */
  readonly repositoryRoot: string;
  readonly fromCommitSha: string;
  readonly path: string;
};
export type CompletionHistorySearched =
  | (CompletionHistoryAt & {
      /** The commit, in that repository, through which a full-history search found no match. */
      readonly searchedThrough: string;
      readonly foundThrough?: undefined;
    })
  | (CompletionHistoryAt & {
      /** The commit, in that repository, through which the exact per-pair search found a match. */
      readonly foundThrough: string;
      readonly searchedThrough?: undefined;
    });

export interface CompletionHistorySearchMemo {
  get(key: string): CompletionHistorySearched | undefined;
  set(key: string, value: CompletionHistorySearched): void;
}

/** Least-recently-used, bounded: the working set is the ~1k unsettled (path, blob) pairs. */
export function createCompletionHistorySearchMemo(capacity = 20_000): CompletionHistorySearchMemo {
  const entries = new Map<string, CompletionHistorySearched>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      for (const oldest of entries.keys()) {
        if (entries.size <= capacity) break;
        entries.delete(oldest);
      }
    },
  };
}

/** A pair's memo key, as the reader builds it. Roots, paths and shas never contain NUL. */
export function completionHistoryPairKey(root: string, fromHeadSha: string, path: string, blobSha: string): string {
  return [root, fromHeadSha, path, blobSha].join('\0');
}

/** WI-10005560: one kept verdict with its pair spelled out, as a store holds it. */
export type CompletionHistoryMemoRecord = {
  readonly repositoryRoot: string;
  readonly fromHeadSha: string;
  readonly path: string;
  readonly blobSha: string;
  readonly value: CompletionHistorySearched;
};

export interface CompletionHistoryMemoStore {
  /** The most recently written records, newest first, at most `limit`. */
  load(limit: number): Promise<ReadonlyArray<CompletionHistoryMemoRecord>>;
  /** Upserts each record by its pair; the last write wins. */
  save(records: ReadonlyArray<CompletionHistoryMemoRecord>): Promise<void>;
}

export interface PersistedCompletionHistorySearchMemo extends CompletionHistorySearchMemo {
  /** Loads the stored verdicts once per process. A failed load rejects and is retried by the next call. */
  hydrate(): Promise<number>;
  /** Writes every verdict set since the last flush and returns how many. A failed write keeps them pending. */
  flush(): Promise<number>;
}

/**
 * WI-10005560: the memo above, kept across restarts. bg-host restarts about every 33 min,
 * and an in-process memo made the first rotation after each boot re-search every pair over
 * its whole range (6,440 per-pair `git log` execs in the first 10 min vs 1,024 warm,
 * measured 2026-10-02). Every kept verdict is exact over its own commit range, so an older
 * stored verdict is still true, just less advanced, and last-writer-wins needs no locking.
 */
export function createPersistedCompletionHistorySearchMemo(
  store: CompletionHistoryMemoStore,
  base: CompletionHistorySearchMemo = createCompletionHistorySearchMemo(),
  limit = 20_000,
): PersistedCompletionHistorySearchMemo {
  const pending = new Map<string, CompletionHistoryMemoRecord>();
  let hydration: Promise<number> | null = null;
  return {
    get: (key) => base.get(key),
    set(key, value) {
      base.set(key, value);
      const parts = key.split('\0');
      if (parts.length !== 4) return;
      const [repositoryRoot = '', fromHeadSha = '', path = '', blobSha = ''] = parts;
      pending.delete(key);
      pending.set(key, { repositoryRoot, fromHeadSha, path, blobSha, value });
      // A store that keeps failing must not grow this without bound: drop the oldest.
      for (const oldest of pending.keys()) {
        if (pending.size <= limit) break;
        pending.delete(oldest);
      }
    },
    hydrate() {
      hydration ??= store.load(limit).then(
        (records) => {
          let loaded = 0;
          // Oldest first, so the newest records end up most recently used.
          for (let index = records.length - 1; index >= 0; index -= 1) {
            const record = records[index];
            if (!record) continue;
            const key = completionHistoryPairKey(record.repositoryRoot, record.fromHeadSha, record.path, record.blobSha);
            // A verdict this process already holds is at least as recent as the stored one.
            if (pending.has(key) || base.get(key) !== undefined) continue;
            base.set(key, record.value);
            loaded += 1;
          }
          return loaded;
        },
        (error: unknown) => {
          hydration = null;
          throw error;
        },
      );
      return hydration;
    },
    async flush() {
      if (pending.size === 0) return 0;
      const batch = [...pending.entries()];
      pending.clear();
      try {
        await store.save(batch.map(([, record]) => record));
        return batch.length;
      } catch (error) {
        // Re-queue what no later set() replaced, so the next flush retries it.
        for (const [key, record] of batch) if (!pending.has(key)) pending.set(key, record);
        throw error;
      }
    },
  };
}

/** The process-wide memo every pass's reader shares by default. */
const historySearchState = pinModuleState('@papercusp/operator-core.completion-history-search', () => ({
  memo: createCompletionHistorySearchMemo(),
  /** WI-10005560: per-scope persistence over the same process memo. */
  persisted: new Map<string, PersistedCompletionHistorySearchMemo>(),
}));

/**
 * WI-10005560: the process memo, persisted through `store` for `scope` (a workspace). One
 * per scope per process, so hydration runs once and every pass flushes what it learned.
 */
export function persistedCompletionHistorySearchMemo(
  scope: string,
  store: () => CompletionHistoryMemoStore,
): PersistedCompletionHistorySearchMemo {
  let memo = historySearchState.persisted.get(scope);
  if (!memo) {
    memo = createPersistedCompletionHistorySearchMemo(store(), historySearchState.memo);
    historySearchState.persisted.set(scope, memo);
  }
  return memo;
}

/** Pairs per batched history search: bounds argv and the per-field matching loop. */
const HISTORY_SEARCH_BATCH = 256;

export function createCompletionBlobHistoryReader(
  readGitlinks: GitlinkPrefixReader = readGitlinkPrefixes,
  memo: CompletionHistorySearchMemo = historySearchState.memo,
): CompletionBlobHistoryReader {
  type Answer = string | null | 'unmeasured' | undefined;
  const keyOf = (root: string, commitSha: string) => root + '\0' + commitSha;
  /** (root, commit) → prefix → its answer, settled or in flight. */
  const answers = new Map<string, Map<string, Promise<Answer>>>();
  /** (root, commit) → paths announced through hint(). */
  const announced = new Map<string, Set<string>>();
  let reads = 0;

  const announce = (root: string, commitSha: string, paths: Iterable<string>) => {
    const key = keyOf(root, commitSha);
    const set = announced.get(key) ?? new Set<string>();
    for (const path of paths) set.add(path);
    announced.set(key, set);
  };

  /** Announce, one level down, every announced path that lives under a gitlink just read. */
  const propagate = (root: string, commitSha: string, gitlinks: ReadonlyMap<string, string | null>) => {
    const paths = announced.get(keyOf(root, commitSha));
    if (!paths) return;
    const nested = new Map<string, { root: string; sha: string; paths: string[] }>();
    for (const path of paths) {
      let prefix: string | undefined;
      for (const candidate of ancestorPrefixes(path)) if (gitlinks.get(candidate)) prefix = candidate;
      if (!prefix) continue;
      const sha = gitlinks.get(prefix)!;
      const nestedRoot = nodePath.resolve(root, prefix);
      if (!nestedRoot.startsWith(root + nodePath.sep)) continue;
      const group = nested.get(keyOf(nestedRoot, sha)) ?? { root: nestedRoot, sha, paths: [] };
      group.paths.push(path.slice(prefix.length + 1));
      nested.set(keyOf(nestedRoot, sha), group);
    }
    for (const group of nested.values()) announce(group.root, group.sha, group.paths);
  };

  const sharedRead: GitlinkPrefixReader = async (root, commitSha, prefixes, opts) => {
    const key = keyOf(root, commitSha);
    let table = answers.get(key);
    if (!table) {
      table = new Map();
      answers.set(key, table);
    }
    const known = table;
    if (prefixes.some((prefix) => !known.has(prefix))) {
      const own = prefixes.filter((prefix) => !known.has(prefix));
      const ownSet = new Set(own);
      const wanted = new Set(own);
      for (const path of announced.get(key) ?? []) {
        for (const prefix of ancestorPrefixes(path)) if (!known.has(prefix)) wanted.add(prefix);
      }
      const batch = [...wanted];
      const readOnce = (list: readonly string[]): Promise<GitlinkPrefixRead> => {
        reads += 1;
        return readGitlinks(root, commitSha, list, opts).then(
          (result) => {
            if (result && result !== 'unmeasured') propagate(root, commitSha, result);
            return result;
          },
          // A reader that throws measured nothing; retry rather than persist residue.
          (): GitlinkPrefixRead => 'unmeasured',
        );
      };
      const batchRead = readOnce(batch);
      // git refuses the WHOLE ls-tree when any one pathspec is bad (e.g. a declared path
      // outside the repository exits 128), so a failed batch that carried announced extras
      // says nothing about the caller's own prefixes: re-read those alone. Another row's
      // bad path must never change this path's answer.
      const ownRead =
        batch.length > own.length
          ? batchRead.then((result) => (result === undefined ? readOnce(own) : result))
          : batchRead;
      for (const prefix of batch) {
        const extra = !ownSet.has(prefix);
        const answer = (extra ? batchRead : ownRead).then((result): Answer =>
          result === 'unmeasured' || result === undefined ? result : (result.get(prefix) ?? null),
        );
        known.set(prefix, answer);
        void answer.then((value) => {
          // Keep only measured answers. An announced extra from a failed batch was never
          // asked for on its own, so its refusal is not kept either.
          const keep = value !== 'unmeasured' && !(extra && value === undefined);
          if (!keep && known.get(prefix) === answer) known.delete(prefix);
        });
      }
    }
    const settled = await Promise.all(prefixes.map((prefix) => known.get(prefix)!));
    if (settled.includes('unmeasured')) return 'unmeasured';
    if (settled.includes(undefined)) return undefined;
    return new Map(prefixes.map((prefix, index) => [prefix, settled[index] as string | null]));
  };

  type Pair = { root: string; fromHeadSha: string; path: string; blobSha: string; id: string };
  /** A pair's next search: the range `to ^lower` in one repository. */
  type Span = { pair: Pair; from: CompletionHistoryLocation; to: CompletionHistoryLocation; lower: string };
  /** A pair the batched search did not see is `false`; one it saw still needs the exact check. */
  type Search = {
    members: ReadonlyMap<string, Span>;
    answers: ReadonlyMap<string, false | 'seen'> | 'timeout' | 'failed';
  };
  const pairOf = (root: string, fromHeadSha: string, path: string, blobSha: string): Pair => ({
    root,
    fromHeadSha,
    path,
    blobSha,
    id: completionHistoryPairKey(root, fromHeadSha, path, blobSha),
  });
  const announcedPairs = new Map<string, Pair>();
  /** Range → its batched search, kept for the pass so a member asked later reuses it. */
  const searches = new Map<string, Promise<Search>>();
  let historyReadCount = 0;
  /**
   * WI-10005524: (repository, W, T) → whether W is an ancestor-or-equal of T, for the pass.
   * Every kept match moves its `foundThrough` to the commit it was last proven at, so a
   * pass needs about one read per repository, shared by every matched pair. A failed read
   * (null) is not kept: it measured nothing, and the pair is searched instead.
   */
  const descents = new Map<string, Promise<boolean | null>>();
  let ancestryReadCount = 0;
  const descends = (root: string, ancestor: string, descendant: string, opts: GitSpawnOptions) => {
    const key = [root, ancestor, descendant].join('\0');
    let pending = descents.get(key);
    if (!pending) {
      ancestryReadCount += 1;
      const read = commitContains(root, descendant, ancestor, opts);
      pending = read;
      descents.set(key, read);
      void read.then((answer) => {
        if (answer === null && descents.get(key) === read) descents.delete(key);
      });
    }
    return pending;
  };
  /** Keep an exact per-pair verdict across passes: a match through T, or a no-match through T. */
  const remember = (pair: Pair, span: Span, found: boolean) => {
    const at = { repositoryRoot: span.from.repositoryRoot, fromCommitSha: span.from.commitSha, path: span.from.path };
    memo.set(pair.id, found ? { ...at, foundThrough: span.to.commitSha } : { ...at, searchedThrough: span.to.commitSha });
  };

  const spanOf = async (
    pair: Pair,
    toCommitSha: string,
    opts: GitSpawnOptions,
  ): Promise<Span | 'unmeasured' | undefined> => {
    const searched = memo.get(pair.id);
    const from = searched
      ? { repositoryRoot: searched.repositoryRoot, commitSha: searched.fromCommitSha, path: searched.path }
      : await completionHistoryLocation(pair.root, pair.fromHeadSha, pair.path, opts, sharedRead);
    if (from === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
    const to = await completionHistoryLocation(pair.root, toCommitSha, pair.path, opts, sharedRead);
    if (to === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
    if (!from || !to) return undefined;
    if (from.repositoryRoot !== to.repositoryRoot || from.path !== to.path) return undefined;
    return { pair, from, to, lower: searched?.searchedThrough ?? from.commitSha };
  };
  const rangeKey = (span: Span) => [span.to.repositoryRoot, span.to.commitSha, span.lower].join('\0');

  /** `self` plus every announced pair whose next search is the same range. */
  const membersFor = async (self: Span, toCommitSha: string, opts: GitSpawnOptions) => {
    const key = rangeKey(self);
    const members = new Map<string, Span>([[self.pair.id, self]]);
    const candidates = [...announcedPairs.values()].filter((pair) => {
      if (pair.id === self.pair.id || pair.root !== self.pair.root) return false;
      // A cheap pre-filter; spanOf decides. A fresh pair's range starts at its own
      // close-time commit, so only pairs closed at the same HEAD can share it.
      const searched = memo.get(pair.id)?.searchedThrough;
      return searched !== undefined ? searched === self.lower : pair.fromHeadSha === self.pair.fromHeadSha;
    });
    for (const span of await Promise.all(candidates.map((pair) => spanOf(pair, toCommitSha, opts)))) {
      if (span && span !== 'unmeasured' && rangeKey(span) === key) members.set(span.pair.id, span);
    }
    return members;
  };

  const search = async (members: ReadonlyMap<string, Span>, opts: GitSpawnOptions): Promise<Search> => {
    const spans = [...members.values()];
    const answers = new Map<string, false | 'seen'>();
    for (let start = 0; start < spans.length; start += HISTORY_SEARCH_BATCH) {
      const chunk = spans.slice(start, start + HISTORY_SEARCH_BATCH);
      const first = chunk[0];
      if (!first) break;
      historyReadCount += 1;
      const seen = await historyLogSees(
        first.to.repositoryRoot,
        first.to.commitSha,
        first.lower,
        chunk.map((span) => ({ path: span.to.path, blobSha: span.pair.blobSha })),
        opts,
      );
      if (seen === 'timeout' || seen === 'failed') return { members, answers: seen };
      chunk.forEach((span, index) => {
        if (seen.has(index)) {
          answers.set(span.pair.id, 'seen');
          return;
        }
        answers.set(span.pair.id, false);
        memo.set(span.pair.id, {
          repositoryRoot: span.from.repositoryRoot,
          fromCommitSha: span.from.commitSha,
          path: span.from.path,
          searchedThrough: span.to.commitSha,
        });
      });
    }
    return { members, answers };
  };

  const contains: CompletionBlobHistoryReader['contains'] = async (
    repoRoot,
    fromHeadSha,
    toCommitSha,
    rawPath,
    blobSha,
    opts = {},
  ) => {
    if (opts.signal?.aborted) return 'unmeasured';
    if (!SHA_RE.test(fromHeadSha) || !SHA_RE.test(toCommitSha) || !OBJECT_SHA_RE.test(blobSha)) return undefined;
    const path = normalizedRepoPath(repoRoot, rawPath);
    if (!path || path !== rawPath) return undefined;
    const pair = pairOf(nodePath.resolve(repoRoot), fromHeadSha, path, blobSha);
    const kept = memo.get(pair.id);
    if (kept?.foundThrough !== undefined) {
      // WI-10005524: a match found through W still holds at T when W is an ancestor of T.
      const to = await completionHistoryLocation(pair.root, toCommitSha, path, opts, sharedRead);
      if (to === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
      if (to && to.repositoryRoot === kept.repositoryRoot && to.path === kept.path) {
        const still =
          to.commitSha === kept.foundThrough || (await descends(to.repositoryRoot, kept.foundThrough, to.commitSha, opts));
        if (opts.signal?.aborted) return 'unmeasured';
        if (still === true) {
          if (to.commitSha !== kept.foundThrough) memo.set(pair.id, { ...kept, foundThrough: to.commitSha });
          return true;
        }
      }
      // Not provably reachable from T (or not measured): search the whole range below.
    }
    const span = await spanOf(pair, toCommitSha, opts);
    if (span === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
    if (!span) return undefined;
    // from === to, or nothing landed since the last no-match: there is nothing to search.
    if (span.lower === span.to.commitSha) return false;
    const key = rangeKey(span);
    const shared = searches.get(key);
    let done = shared ? await shared : undefined;
    if (!done?.members.has(span.pair.id)) {
      const own = membersFor(span, toCommitSha, opts).then((members) => search(members, opts));
      searches.set(key, own);
      done = await own;
    }
    if (opts.signal?.aborted) return 'unmeasured';
    if (done.answers === 'timeout' && done.members.size === 1) return 'unmeasured';
    if (done.answers !== 'timeout' && done.answers !== 'failed' && done.answers.get(span.pair.id) === false) {
      return false;
    }
    // Seen in the range, or the shared search measured nothing: the per-pair check decides.
    historyReadCount += 1;
    const verdict = await historyLogFinds(span.from, span.to, blobSha, opts);
    // Both answers are exact over from..to, so keep them: a match is re-proved by one shared
    // ancestry read next pass instead of a per-pair search, and a "seen" candidate that the
    // exact check rejects is not searched over the same range again.
    if (verdict === true || verdict === false) remember(span.pair, span, verdict);
    return verdict;
  };

  return {
    contains,
    hintBlobs: (repoRoot, fromHeadSha, entries) => {
      if (!SHA_RE.test(fromHeadSha)) return;
      const root = nodePath.resolve(repoRoot);
      for (const { path, blobSha } of entries) {
        if (!OBJECT_SHA_RE.test(blobSha) || normalizedRepoPath(root, path) !== path) continue;
        const pair = pairOf(root, fromHeadSha, path, blobSha);
        announcedPairs.set(pair.id, pair);
      }
    },
    historyReads: () => historyReadCount,
    ancestryReads: () => ancestryReadCount,
    hint: (repoRoot, commitSha, paths) => {
      if (!SHA_RE.test(commitSha)) return;
      // Only paths contains() itself would accept: a declared non-file ref ('/reports/…',
      // an absolute path) would otherwise make git refuse the batch for every row.
      const root = nodePath.resolve(repoRoot);
      announce(root, commitSha, paths.filter((path) => normalizedRepoPath(root, path) === path));
    },
    gitlinkReads: () => reads,
  };
}

async function blobHistoryContains(
  readGitlinks: GitlinkPrefixReader,
  repoRoot: string,
  fromHeadSha: string,
  toCommitSha: string,
  rawPath: string,
  blobSha: string,
  opts: GitSpawnOptions,
): Promise<CompletionBlobHistoryVerdict> {
  if (opts.signal?.aborted) return 'unmeasured';
  if (!SHA_RE.test(fromHeadSha) || !SHA_RE.test(toCommitSha) || !OBJECT_SHA_RE.test(blobSha)) {
    return undefined;
  }
  const path = normalizedRepoPath(repoRoot, rawPath);
  if (!path || path !== rawPath) return undefined;

  const from = await completionHistoryLocation(repoRoot, fromHeadSha, path, opts, readGitlinks);
  if (from === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
  const to = await completionHistoryLocation(repoRoot, toCommitSha, path, opts, readGitlinks);
  if (to === 'unmeasured' || opts.signal?.aborted) return 'unmeasured';
  if (!from || !to) return undefined;
  if (from.repositoryRoot !== to.repositoryRoot || from.path !== to.path) return undefined;
  if (from.commitSha === to.commitSha) return false;
  return historyLogFinds(from, to, blobSha, opts);
}

/**
 * WI-10005524: is `ancestor` an ancestor-or-equal of `descendant` in one repository?
 * {@link gitRefContains} reads it from `git merge-base` stdout (a stdout-only read cannot
 * tell `--is-ancestor`'s exit 1 from a failure). null = the read measured nothing.
 */
function commitContains(
  repositoryRoot: string,
  descendant: string,
  ancestor: string,
  opts: GitSpawnOptions,
): Promise<boolean | null> {
  const read: GitStdoutRead = async (args) => {
    let out = '';
    const outcome = await streamGitFields(
      ['-C', repositoryRoot, ...args],
      (field) => {
        out += field;
      },
      // Bounded one-line output, so the sidecar can run it (see the ls-tree read above).
      { ...opts, timeoutMs: opts.timeoutMs ?? 5000, preferSidecar: true },
    );
    return outcome === 'complete' && !opts.signal?.aborted ? out.trim() : null;
  };
  return gitRefContains(read, descendant, ancestor);
}

/** The exact history check for one (path, blob) over `from..to`, in one location. */
async function historyLogFinds(
  from: CompletionHistoryLocation,
  to: CompletionHistoryLocation,
  blobSha: string,
  opts: GitSpawnOptions,
): Promise<CompletionBlobHistoryVerdict> {
  let found = false;
  const outcome = await streamGitFields(
    [
      '-C',
      from.repositoryRoot,
      'log',
      '--format=%H%x00',
      '--no-renames',
      '--find-object=' + blobSha,
      from.commitSha + '..' + to.commitSha,
      '--',
      ':(literal)' + from.path,
    ],
    (entry) => {
      if (!entry.trim()) return;
      found = true;
      return true;
    },
    // One path over a closed commit range: bounded output, so the early stop is
    // not load-bearing and the sidecar can run it (see the ls-tree read above).
    { ...opts, timeoutMs: opts.timeoutMs ?? 5000, preferSidecar: true },
  );
  if (opts.signal?.aborted || outcome === 'timeout') return 'unmeasured';
  if (outcome !== 'complete') return undefined;
  return found;
}

/**
 * One batched history search for many (path, blob) pairs over the same range
 * `to ^lower` in one repository: which pairs it saw, or the stream outcome when
 * it did not complete.
 *
 * It visits every commit in the range: `--find-object` already turns history
 * simplification off (a merge side the path-limited walk would prune is still walked,
 * as in the per-pair check), and `--full-history` states that, because the cross-pass
 * memo is exact only if no commit in a searched range was skipped. A pair it does not
 * see is not in the range. A pair it does see is only a candidate (its range may reach
 * behind the pair's own close-time commit); the caller confirms it with
 * {@link historyLogFinds}, the per-pair check itself.
 *
 * A filepair is credited to a pair when its path is the pair's path (or under it, as
 * a `:(literal)` pathspec matches) and either side is the pair's blob: the rule
 * `--find-object` itself applies, so several objects can share one search.
 */
async function historyLogSees(
  repositoryRoot: string,
  toCommitSha: string,
  lowerSha: string,
  pairs: ReadonlyArray<{ path: string; blobSha: string }>,
  opts: GitSpawnOptions,
): Promise<ReadonlySet<number> | 'timeout' | 'failed'> {
  const seen = new Set<number>();
  let filepair: { old: string; new: string } | undefined;
  const outcome = await streamGitFields(
    [
      '-C',
      repositoryRoot,
      'log',
      '--full-history',
      '--format=%x01%H',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '-z',
      ...[...new Set(pairs.map((pair) => pair.blobSha))].map((sha) => '--find-object=' + sha),
      toCommitSha,
      '^' + lowerSha,
      '--',
      ...[...new Set(pairs.map((pair) => pair.path))].map((path) => ':(literal)' + path),
    ],
    // -z raw: a commit header field ('\x01<sha>'), then per filepair a meta field
    // (':<mode> <mode> <old> <new> <status>', after a newline) and a path field.
    (field) => {
      if (filepair) {
        const { old, new: next } = filepair;
        filepair = undefined;
        pairs.forEach((pair, index) => {
          const underPath = field === pair.path || field.startsWith(pair.path + '/');
          if (underPath && (pair.blobSha === old || pair.blobSha === next)) seen.add(index);
        });
        return;
      }
      const meta = field.replace(/^\n+/, '');
      if (!meta.startsWith(':')) return;
      const [, , old = '', next = ''] = meta.slice(1).split(' ');
      filepair = { old, new: next };
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? 5000, preferSidecar: true },
  );
  if (outcome === 'timeout') return 'timeout';
  if (outcome !== 'complete') return 'failed';
  return seen;
}

async function contentIdentity(
  repositoryRoot: string,
  headSha: string,
  filesChanged: readonly string[],
  filesDeleted: readonly string[],
  probe: CompletionTreeStampProbe,
): Promise<CompletionTreeContentIdentityWithDeletion[] | undefined> {
  const normalizedChanged = filesChanged
    .slice(0, MAX_PATHS_PROBED)
    .map((path) => normalizedRepoPath(repositoryRoot, path));
  const normalizedDeleted = filesDeleted
    .slice(0, MAX_PATHS_PROBED)
    .map((path) => normalizedRepoPath(repositoryRoot, path));
  if (normalizedChanged.some((path) => !path) || normalizedDeleted.some((path) => !path)) return undefined;
  const changedSet = new Set(normalizedChanged as string[]);
  const deletedSet = new Set(normalizedDeleted as string[]);
  // A path cannot truthfully be both modified and deleted in one completion.
  if ([...deletedSet].some((path) => changedSet.has(path))) return undefined;
  const paths = [...new Set([...changedSet, ...deletedSet])];
  if (paths.length === 0 || paths.some((path) => !path)) return undefined;
  const head = await (probe.headBlobs ?? completionHeadBlobMap)(repositoryRoot, headSha, paths);
  if (!head) return undefined;
  const readBytes =
    probe.readBytes ??
    ((abs: string) => {
      try {
        return readFileSync(abs);
      } catch {
        return undefined;
      }
    });
  const identity = paths.map((path) => {
    const bytes = readBytes(nodePath.join(repositoryRoot, path));
    const resolution = head.get(path);
    const deletion = deletedSet.has(path);
    return {
      path,
      workingTreeBlobSha: bytes === undefined ? null : gitBlobSha(bytes, headSha.length),
      headBlobSha: headBlobShaOf(resolution),
      ...(deletion ? { deletion: true as const } : {}),
      // Carried so the closer is told WHY, not just that it failed (WI-42441).
      ...(resolution?.status === 'unresolvable' ? { headBlobUnresolvable: resolution.reason } : {}),
    };
  });
  const ignoreCandidates = identity
    .filter(
      (entry) =>
        entry.workingTreeBlobSha !== null &&
        entry.headBlobSha === null &&
        !entry.headBlobUnresolvable &&
        (entry as CompletionTreeContentIdentityWithDeletion).deletion !== true,
    )
    .map((entry) => entry.path);
  if (ignoreCandidates.length === 0) return identity;

  // One bounded read for all present paths absent from HEAD. Any timeout, failure,
  // omitted status, or path beyond the cap stays explicitly unknown.
  const statuses = await (probe.gitIgnoreStatusProbe ?? completionGitIgnoreStatusMap)(
    repositoryRoot,
    ignoreCandidates.slice(0, MAX_PATHS_PROBED),
  );
  const candidateSet = new Set(ignoreCandidates);
  return identity.map((entry) =>
    candidateSet.has(entry.path)
      ? { ...entry, gitIgnoreStatus: statuses?.get(entry.path) ?? 'unknown' }
      : entry,
  );
}

/**
 * Resolve ignore state for a bounded set of working-tree files absent from HEAD.
 * --ignored=matching reports ignored (!!) and ordinary untracked paths for
 * explicit literal pathspecs. Missing output is not evidence of being unignored.
 */
async function completionGitIgnoreStatusMap(
  repoRoot: string,
  paths: readonly string[],
): Promise<ReadonlyMap<string, CompletionGitIgnoreStatus> | undefined> {
  const boundedPaths = paths.slice(0, MAX_PATHS_PROBED);
  if (boundedPaths.length === 0) return new Map();
  const requested = new Set(boundedPaths);
  const statuses = new Map<string, CompletionGitIgnoreStatus>();
  const outcome = await streamGitFields(
    [
      '-C',
      repoRoot,
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '--untracked-files=all',
      '--',
      ...boundedPaths.map((path) => ':(literal)' + path),
    ],
    (field) => {
      if (field.length < 4 || field[2] !== ' ') return;
      const path = field.slice(3);
      if (!requested.has(path)) return;
      const status: CompletionGitIgnoreStatus = field.slice(0, 2) === '!!' ? 'ignored' : 'not-ignored';
      const previous = statuses.get(path);
      statuses.set(path, previous && previous !== status ? 'unknown' : status);
    },
    { timeoutMs: 5000, preferSidecar: true },
  );
  return outcome === 'complete' ? statuses : undefined;
}

/**
 * WI-42441: the declared paths whose HEAD side could not be READ, with the reason.
 *
 * Non-empty means the downgrade is the SERVER's resolution failure, not the closer's
 * tree hygiene — which is the difference between advice that can be followed and
 * advice that cannot. Deliberately narrow: a path that resolved and simply does not
 * match is NOT listed, because that one really is the closer's to fix.
 */
export function unresolvableContentIdentityPaths(
  stamp: { contentIdentity?: readonly CompletionTreeContentIdentity[] } | undefined | null,
): { path: string; headBlobUnresolvable: string }[] {
  return (stamp?.contentIdentity ?? []).flatMap((entry) =>
    entry.headBlobUnresolvable ? [{ path: entry.path, headBlobUnresolvable: entry.headBlobUnresolvable }] : [],
  );
}

/**
 * EI-21970667079827352 — WHICH declared paths failed content identity, and whether
 * WAITING can ever settle them.
 *
 * The `proposed` warning named the RULE ("could not prove that every declared path
 * has the same blob...") but never the FACT, and three situations produce that one
 * sentence: git-sync has not swept yet; ONE path of several missed the last tick (a
 * single logical change landing across two sweeps, routine on this tree); or a
 * declared path is misspelled / reverted / never existed. The first two settle
 * themselves; the third NEVER does. Indistinguishable from the text, the natural
 * move is to wait — which in the third case is an unbounded wait, on an item that
 * has already left the claimable pool, for something that cannot happen.
 *
 * `settles` is the field that matters, and it is derivable from identities the
 * server already computed:
 *  - a path present in the working tree but not yet in HEAD is mid-sweep      -> 'sweep'
 *  - a path whose two blobs merely DIFFER moved after the commit              -> 'sweep'
 *  - a path in NEITHER tree cannot become committed by any amount of waiting  -> 'never'
 *  - a path in HEAD but gone from the working tree is likewise unprovable     -> 'never'
 *
 * Entries carrying `headBlobUnresolvable` are deliberately EXCLUDED: that is the
 * server's own resolution failure (WI-42441), it already has its own reason-specific
 * remedy, and folding it in here would re-conflate the two opposite remedies that
 * type was split apart to keep separate.
 */
export type UnprovenContentIdentityReason =
  | 'missing-from-commit'
  | 'content-mismatch'
  | 'absent-from-both'
  | 'absent-from-working-tree'
  | 'gitignored-path'
  | 'gitignore-status-unknown'
  | 'gitignored-scratch-path'
  | 'gitignored-tmp-path'
  | 'deletion-present-in-working-tree'
  | 'deletion-present-in-commit';

export type UnprovenContentIdentityRow = {
  path: string;
  reason: UnprovenContentIdentityReason;
  settles: 'sweep' | 'never' | 'unknown';
};

/**
 * EI-21970667079827352 — render the per-path facts as the remedy the caller should follow.
 *
 * Pure and exported so the SENTENCE is testable. It previously lived inline in a ~3,000-line
 * function with no seam, which is why the one thing the caller actually reads was the one
 * thing no test covered.
 *
 * The lead is always whether WAITING works, because that is the only branch where the
 * caller's next action differs: `sweep` means re-send the identical completion later,
 * `never` means the evidence itself is wrong and no amount of waiting fixes it.
 */
export function describeUnprovenContentIdentity(
  rows: readonly UnprovenContentIdentityRow[],
  declaredPathCount: number,
): string | undefined {
  if (rows.length === 0) return undefined;
  const render = (subset: readonly UnprovenContentIdentityRow[]) =>
    subset.map((row) => `\`${row.path}\` (${row.reason})`).join('; ');
  const willSettle = rows.filter((row) => row.settles === 'sweep');
  const neverSettles = rows.filter((row) => row.settles === 'never');
  const unknown = rows.filter((row) => row.settles === 'unknown');
  const total = declaredPathCount > 0 ? declaredPathCount : rows.length;
  const head = `Content identity was not proven for ${rows.length} of ${total} declared \`filesChanged\` path(s): ${render(rows)}. `;
  const neverRemedy = neverSettles
    .map((row) => {
      if (row.reason === 'gitignored-path') {
        return (
          "'" + row.path + "' is ignored by Git, so the ordinary git add -A sweep will omit it. " +
          "Remove it from filesChanged or cite durable storage instead."
        );
      }
      const rendered = `\`${row.path}\` (${row.reason})`;
      if (row.reason === 'gitignored-scratch-path' || row.reason === 'gitignored-tmp-path') {
        const prefix = row.reason === 'gitignored-scratch-path' ? '.papercusp/scratch/' : '.papercusp/tmp/ or .papercusp/tmp-*';
        return (
          `${rendered} is under the documented gitignored \`${prefix}\` prefix, so NO sweep can ` +
          `ever commit it. Remove it from \`filesChanged\` or cite durable storage instead.`
        );
      }
      return (
        `${rendered} is absent from the working tree, so NO sweep can ever commit it — that is a misspelled, ` +
        `renamed, reverted, or never-created path in your completion evidence. Re-call work_items:complete for ` +
        `this id with the REAL path(s), never a plausible-looking guess.`
      );
    })
    .join(' ');
  if (unknown.length > 0) {
    const unknownRemedy = unknown
      .map(
        (row) =>
          "'" +
          row.path +
          "' has unknown Git ignore status because the bounded git status probe did not produce a complete result. " +
          "If Git ignores it, ordinary git add -A will omit it; otherwise a later sweep may settle it. " +
          "Verify the ignore rules before relying on automatic settlement.",
      )
      .join(' ');
    const knownSweep =
      willSettle.length > 0
        ? render(willSettle) +
          ' will be checked automatically by the git-sync completion-settlement reconciler on the next sweep.'
        : '';
    return (
      head +
      'WAITING IS UNVERIFIED — ' +
      unknownRemedy +
      (knownSweep ? ' ' + knownSweep : '') +
      (neverRemedy ? ' ' + neverRemedy : '')
    );
  }
  if (neverSettles.length === 0) {
    return (
      head +
      `WAITING SETTLES THIS — your evidence was accepted and nothing is wrong with your tree. Those path(s) are ` +
      `present in the working tree but not yet in the commit, and git-sync sweeps this tree on a schedule, so ONE ` +
      `logical change routinely lands across TWO ticks. The git-sync completion-settlement reconciler checks the ` +
      `recorded settlement manifest automatically after each emitted commit and upgrades this close to ` +
      `\`committed\` when those exact blobs land. Do not re-call \`work_items:complete\`, re-verify work that is ` +
      `already correct, or re-word the evidence.` +
      SUPERSEDED_BEFORE_COMMIT_EXCEPTION
    );
  }
  if (willSettle.length === 0) {
    return head + `WAITING WILL NOT SETTLE THIS — do not sit on it. ${neverRemedy}`;
  }
  return (
    head +
    `MIXED — only one half is worth waiting on. ${render(willSettle)} will be checked automatically by the ` +
    `git-sync completion-settlement reconciler on the next sweep, ` +
    `but ${neverRemedy} Waiting alone leaves this close \`proposed\` indefinitely.` +
    SUPERSEDED_BEFORE_COMMIT_EXCEPTION
  );
}

/**
 * WI-10004711: the one way "waiting settles this" turns false AFTER the close. The verdict
 * is right when issued; it is falsified only if a path is edited again before git-sync
 * captures the closed blob. The reconciler detects that and messages the closer, so the
 * advice names that message as the signal instead of an unconditional "never re-send".
 */
const SUPERSEDED_BEFORE_COMMIT_EXCEPTION =
  ` One exception: if one of those path(s) is edited again before git-sync commits it, the content you ` +
  `closed with never lands. The settlement reconciler then records \`superseded-before-commit\` and sends ` +
  `you a coord message; only then, re-check the path and re-send \`work_items:complete\` for this id.`;

type GitignoredContentIdentityReason = Extract<
  UnprovenContentIdentityReason,
  'gitignored-path' | 'gitignored-scratch-path' | 'gitignored-tmp-path'
>;

function legacyGitignoredContentIdentityReason(
  path: string,
): Exclude<GitignoredContentIdentityReason, 'gitignored-path'> | undefined {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (normalizedPath.startsWith(DOCUMENTED_GITIGNORED_SCRATCH_PREFIX)) return 'gitignored-scratch-path';
  if (
    normalizedPath.startsWith(DOCUMENTED_GITIGNORED_TMP_PREFIX) ||
    normalizedPath.startsWith(DOCUMENTED_GITIGNORED_TMP_ROOT_PREFIX)
  ) {
    return 'gitignored-tmp-path';
  }
  return undefined;
}

function gitignoredContentIdentityReason(path: string): GitignoredContentIdentityReason {
  return legacyGitignoredContentIdentityReason(path) ?? 'gitignored-path';
}

export function unprovenContentIdentityPaths(
  stamp: { contentIdentity?: readonly CompletionTreeContentIdentity[] } | undefined | null,
): UnprovenContentIdentityRow[] {
  return (stamp?.contentIdentity ?? []).flatMap((entry): UnprovenContentIdentityRow[] => {
    // An explicit out-of-repo artifact is not a missing repository path. It has no
    // blob identity by design and must not surface as an unfollowable absent-from-both
    // warning. Mixed stamps still report every unproven repo-backed entry below.
    if (entry.outOfRepoArtifact === true) return [];
    // The server could not READ the HEAD side — a different failure with a different
    // remedy, reported by unresolvableContentIdentityPaths. Not ours.
    if (entry.headBlobUnresolvable) return [];
    const deletion = (entry as CompletionTreeContentIdentityWithDeletion).deletion === true;
    const inTree = entry.workingTreeBlobSha !== null;
    const inHead = entry.headBlobSha !== null;
    if (deletion) {
      if (!inTree && !inHead) return [];
      if (inTree) {
        return [{ path: entry.path, reason: 'deletion-present-in-working-tree', settles: 'never' as const }];
      }
      return [{ path: entry.path, reason: 'deletion-present-in-commit', settles: 'never' as const }];
    }
    if (inTree && inHead) {
      return entry.workingTreeBlobSha === entry.headBlobSha
        ? [] // proven — this path is fine
        : [{ path: entry.path, reason: 'content-mismatch' as const, settles: 'sweep' as const }];
    }
    if (inTree && !inHead) {
      if (entry.gitIgnoreStatus === 'ignored') {
        return [{ path: entry.path, reason: gitignoredContentIdentityReason(entry.path), settles: 'never' as const }];
      }
      if (entry.gitIgnoreStatus === 'unknown') {
        return [{ path: entry.path, reason: 'gitignore-status-unknown', settles: 'unknown' as const }];
      }
      if (entry.gitIgnoreStatus === 'not-ignored') {
        return [{ path: entry.path, reason: 'missing-from-commit' as const, settles: 'sweep' as const }];
      }
      const legacyIgnoredReason = legacyGitignoredContentIdentityReason(entry.path);
      if (legacyIgnoredReason) {
        return [{ path: entry.path, reason: legacyIgnoredReason, settles: 'never' as const }];
      }
      return [{ path: entry.path, reason: 'missing-from-commit' as const, settles: 'sweep' as const }];
    }
    if (!inTree && inHead) {
      return [{ path: entry.path, reason: 'absent-from-working-tree' as const, settles: 'never' as const }];
    }
    if (entry.gitIgnoreStatus === undefined) {
      const legacyIgnoredReason = legacyGitignoredContentIdentityReason(entry.path);
      if (legacyIgnoredReason) {
        return [{ path: entry.path, reason: legacyIgnoredReason, settles: 'never' as const }];
      }
    }
    return [{ path: entry.path, reason: 'absent-from-both' as const, settles: 'never' as const }];
  });
}

export function completionTreeContentIdentityMatches(
  identity: readonly CompletionTreeContentIdentityWithDeletion[] | undefined,
): boolean {
  // WI-1409142: `!= null`, deliberately loose, so it rejects an ABSENT key as well as
  // an explicit null. Stored evidence really can arrive with these keys missing — a
  // recursive jsonb_strip_nulls used to delete them on write — and under strict `!==`
  // an entry missing BOTH keys read as PROVEN: `undefined !== null` is true twice, then
  // `undefined === undefined` matches. That is the one direction this floor must never
  // fail in, since it would mint `committed` authority from evidence the server never
  // actually observed.
  //
  // EI-21937921955988010: an `outOfRepoArtifact` entry is EXCLUDED from the floor
  // rather than failed by it. Such a path (an evidence screenshot under
  // ~/.papercusp/evidence/) belongs to no checkout, so blob identity is undefined for
  // it — not "unavailable". `verifiedHow: 'live-drove-ui'` requires citing exactly
  // those artifacts, so counting them unproven made UI-verified completions
  // permanently ineligible for `committed` no matter how clean the code side was.
  //
  // Every REPO-BACKED entry must match. An all-artifact identity is valid because each
  // entry is an explicit server classification, not an unresolved repository path;
  // there is no commit-backed settlement work for such a completion.
  const repoBacked = (identity ?? []).filter((entry) => entry.outOfRepoArtifact !== true);
  return Boolean(
    identity?.length &&
    repoBacked.every(
      (entry) =>
        entry.deletion === true
          ? entry.workingTreeBlobSha == null && entry.headBlobSha == null
          : entry.workingTreeBlobSha != null &&
            entry.headBlobSha != null &&
            entry.workingTreeBlobSha === entry.headBlobSha,
    ),
  );
}
/**
 * EI-21502635666260946: the WRITE-TIME half of the content-identity floor. A
 * close may claim `committed` only when the server could PROVE every declared
 * `filesChanged` path carries identical blob content in the working tree and
 * committed HEAD. Missing, mismatched, or unavailable identity never qualifies
 * — the close downgrades to `proposed` (record-and-warn, never rejected).
 *
 * This is also the contract mirrored in SQL by
 * harness_shared.downgrade_unproven_committed_close() (migration 972), which
 * enforces the same floor below the deploy boundary so a frozen release gate
 * serving an older build cannot mint stronger authority than this source
 * permits. Keep the two in sync: any change here must update
 * completion_content_identity_proven() and its migration test.
 */
export function committedCloseDowngradedForUnprovenContentIdentity(
  authorityByEvidence: string,
  filesChanged: readonly string[] | undefined,
  treeStamp: CompletionTreeStamp | undefined,
  filesDeleted: readonly string[] | undefined = undefined,
): boolean {
  return (
    authorityByEvidence === 'committed' &&
    Boolean(filesChanged?.length || filesDeleted?.length) &&
    !completionTreeContentIdentityMatches(treeStamp?.contentIdentity)
  );
}

/**
 * Read the current checkout HEAD ref from the filesystem. When declared paths are present,
 * their exact blob identities are resolved by the nonblocking Git stream above.
 *
 * This is deliberately fail-open: an absent or unreadable stamp means "not
 * observed", never "fresh".  The completion hot path must not turn a local
 * filesystem problem into a failed close or a false verification verdict.
 */
export async function completionTreeStamp(
  probe: CompletionTreeStampProbe = {},
): Promise<CompletionTreeStamp | undefined> {
  const repoRoot = 'repoRoot' in probe ? probe.repoRoot : detectPapercupRoot();
  if (!repoRoot) return undefined;

  const readFile =
    probe.readFile ??
    ((abs: string) => {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    });

  const hasDeclaredPaths = probe.filesChanged !== undefined || probe.filesDeleted !== undefined;
  const stampIdentity = async (repositoryRoot: string, headSha: string) =>
    hasDeclaredPaths
      ? await contentIdentity(repositoryRoot, headSha, probe.filesChanged ?? [], probe.filesDeleted ?? [], probe)
      : undefined;
  const createStamp = async (repositoryRoot: string, headSha: string): Promise<CompletionTreeStamp> => {
    const stamp: CompletionTreeStamp = { repositoryRoot, headSha };
    const identity = await stampIdentity(repositoryRoot, headSha);
    return identity ? { ...stamp, contentIdentity: identity } : stamp;
  };

  try {
    const repositoryRoot = nodePath.resolve(repoRoot);
    let gitDir = nodePath.join(repositoryRoot, '.git');
    const dotGit = readFile(gitDir);
    if (dotGit !== undefined) {
      const pointed = /^gitdir:\s*(.+)$/m.exec(dotGit.trim())?.[1]?.trim();
      if (!pointed) return undefined;
      gitDir = nodePath.isAbsolute(pointed) ? pointed : nodePath.resolve(repositoryRoot, pointed);
    }

    const head = readFile(nodePath.join(gitDir, 'HEAD'))?.trim();
    if (!head) return undefined;
    if (SHA_RE.test(head)) {
      return await createStamp(repositoryRoot, head);
    }

    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return undefined;

    const loose = readFile(nodePath.join(gitDir, ref))?.trim();
    if (loose && SHA_RE.test(loose)) {
      return await createStamp(repositoryRoot, loose);
    }

    const packed = readFile(nodePath.join(gitDir, 'packed-refs'));
    if (!packed) return undefined;
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/, 2);
      if (name === ref && sha && SHA_RE.test(sha)) {
        return await createStamp(repositoryRoot, sha);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface CompletionTreeStampForEvidenceProbe {
  /** Injectable path probe so repository selection stays pure in unit tests. */
  exists?: (abs: string) => boolean;
  /** Injectable checkout-root probe; production accepts real `.git` entries only. */
  isCheckoutRoot?: (abs: string) => boolean;
  /** Forwarded to completionTreeStamp after the owning repository is selected. */
  readFile?: (abs: string) => string | undefined;
  readBytes?: (abs: string) => Uint8Array | undefined;
  headBlobs?: (
    repoRoot: string,
    headSha: string,
    paths: readonly string[],
  ) =>
    | ReadonlyMap<string, HeadBlobResolution>
    | undefined
    | Promise<ReadonlyMap<string, HeadBlobResolution> | undefined>;
}

/**
 * Select the registered checkout that owns the completion's declared files,
 * then stamp that checkout's HEAD.  Stable ties preserve the first/root
 * checkout for backwards compatibility.
 */
export async function completionTreeStampForEvidence(
  evidence: CompletionVerificationEvidence,
  repoRoots: string[],
  probe: CompletionTreeStampForEvidenceProbe = {},
): Promise<CompletionTreeStamp | undefined> {
  const roots = [
    ...new Set(
      repoRoots
        .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
        .map((root) => nodePath.resolve(root)),
    ),
  ];
  if (roots.length === 0) return undefined;

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const isCheckoutRoot = probe.isCheckoutRoot ?? hasValidGitEntry;
  const evidenceWithDeleted = evidence as CompletionEvidenceWithDeletedPaths;
  const changedDeclared = evidence.filesChanged ?? [];
  const deletedDeclared = evidenceWithDeleted.filesDeleted ?? [];
  const changedRaw = new Set(changedDeclared.map((path) => path.trim()));
  if (deletedDeclared.some((path) => changedRaw.has(path.trim()))) return undefined;
  const deletedRaw = new Set(deletedDeclared.map((path) => path.trim()));
  const declared = [...changedDeclared, ...deletedDeclared].slice(0, MAX_PATHS_PROBED);
  const primaryRoot = roots[0]!;

  // A relative path such as `papercusp-desktop/bin/check.sh` is resolved against the
  // primary checkout by callers. If that directory is itself an independent nested
  // repository, scoring the primary root would make the writer compare the file against
  // the parent tree (where the path is untracked) and record a false stale completion.
  // Discover those nested roots before scoring so the path can be re-rooted to the checkout
  // that actually owns its HEAD. This is deliberately bounded by the declared paths and
  // their ancestor chains; it never walks the repository tree.
  const nestedOwners = new Map<string, { absolutePath: string; root: string }>();
  for (const raw of declared) {
    const declaredPath = raw.trim();
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
    const absolutePath = nodePath.resolve(primaryRoot, declaredPath);
    const underPrimary = absolutePath === primaryRoot || absolutePath.startsWith(primaryRoot + nodePath.sep);

    // EI-21937921955988010: an ABSOLUTE path outside the primary checkout used to be
    // skipped here, which is precisely why a suite-app completion never acquired an
    // owning root: the apps live in independent checkouts under
    // ~/.papercusp-workspaces/<ws>/.papercusp/apps/*, so every one of their paths fell
    // through this `continue` and the stamp collapsed to the papercusp repo alone.
    // Walk up to the checkout that actually owns it, bounded by the path's own ancestor
    // chain exactly as the nested case is — this never walks a repository tree.
    if (!underPrimary && !nodePath.isAbsolute(declaredPath)) continue;

    let dir = nodePath.dirname(absolutePath);
    const stopAt = underPrimary ? primaryRoot : undefined;
    for (let depth = 0; depth < 64 && dir !== stopAt; depth += 1) {
      if (isCheckoutRoot(dir)) {
        nestedOwners.set(declaredPath, { absolutePath, root: dir });
        break;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const candidateRoots = [...new Set([...roots, ...[...nestedOwners.values()].map(({ root }) => root)])];

  interface PathResolution {
    absolutePath: string;
    relativePath: string;
    /**
     * EI-21850619651553189: the SAME declared path re-resolved with a leading
     * `<repoName>/` segment stripped, when that segment names `root` by its own
     * directory basename — the conventional cross-repo form (`email/packages/...`,
     * matching how the file is named in prose, plan titles, and everywhere else)
     * rather than a path already relative to that repo's own root. Offered
     * ALONGSIDE `absolutePath`/`relativePath` above, never instead of them: a
     * plain relative path always resolves "inside" any root by construction
     * (`resolve(root, 'a/b')` can never escape `root`), so the plain form alone
     * cannot distinguish a real hit from a declared path that merely happens to
     * share this root's name as its first segment — only EXISTENCE can, which is
     * why this is a candidate for the caller to check, not a decision made here.
     */
    strippedAbsolutePath?: string;
    strippedRelativePath?: string;
  }

  const pathForRoot = (root: string, raw: string): PathResolution | undefined => {
    const declaredPath = raw.trim();
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) return undefined;
    const nested = nestedOwners.get(declaredPath);
    if (nested) {
      // Once the primary-root anchor identifies an owning nested checkout, do not let the
      // parent score the physical file as its own. A mixed-root completion therefore remains
      // unproven instead of combining half-matching repositories into one identity.
      if (root !== nested.root) return undefined;
      return {
        absolutePath: nested.absolutePath,
        relativePath: nodePath.relative(root, nested.absolutePath).split(nodePath.sep).join('/'),
      };
    }

    const absolutePath = nodePath.resolve(root, declaredPath);
    if (absolutePath !== root && !absolutePath.startsWith(root + nodePath.sep)) return undefined;
    const relativePath = nodePath.relative(root, absolutePath).split(nodePath.sep).join('/');

    let strippedAbsolutePath: string | undefined;
    let strippedRelativePath: string | undefined;
    const prefix = `${nodePath.basename(root)}/`;
    if (declaredPath.startsWith(prefix)) {
      const stripped = declaredPath.slice(prefix.length);
      if (stripped) {
        const strippedAbs = nodePath.resolve(root, stripped);
        if (strippedAbs === root || strippedAbs.startsWith(root + nodePath.sep)) {
          strippedAbsolutePath = strippedAbs;
          strippedRelativePath = nodePath.relative(root, strippedAbs).split(nodePath.sep).join('/');
        }
      }
    }

    return { absolutePath, relativePath, strippedAbsolutePath, strippedRelativePath };
  };

  let selectedRoot = primaryRoot;
  let selectedMatches = -1;
  let selectedAbsoluteSpecificity = -1;

  for (const repoRoot of candidateRoots) {
    let matches = 0;
    let absoluteSpecificity = -1;
    for (const raw of declared) {
      const declaredPath = raw.trim();
      if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
      const resolved = pathForRoot(repoRoot, declaredPath);
      if (!resolved) continue;
      try {
        const plainExists = exists(resolved.absolutePath);
        const strippedExists = !plainExists && resolved.strippedAbsolutePath && exists(resolved.strippedAbsolutePath);
        if (plainExists || strippedExists) {
          matches += 1;
          // An absolute path can be physically contained by both a superproject and its
          // submodule. Prefer the deepest containing checkout so its HEAD/blob identity is
          // stamped, while relative-path ties retain the primary-root compatibility rule.
          if (nodePath.isAbsolute(declaredPath)) absoluteSpecificity = Math.max(absoluteSpecificity, repoRoot.length);
        }
      } catch {
        // An unreadable candidate is not evidence that another checkout owns the file.
      }
    }
    // EI-21937921955988010: on a TIE, a REGISTERED checkout outranks one that was merely
    // discovered by walking a declared path's ancestors. Now that a multi-repo completion
    // stamps every owning checkout, the top-level pair is only the PRIMARY identity — and
    // letting an unregistered suite-app checkout capture it (its absolute paths score
    // specificity while the registered root's relative ones score -1) would silently
    // re-point `completionSettlementManifest` and every freshness re-check at a repository
    // the system does not track. A discovered root still wins outright when it owns MORE
    // declared paths, which is what the nested-checkout case depends on.
    const registered = roots.includes(repoRoot);
    const selectedRegistered = roots.includes(selectedRoot);
    if (
      matches > selectedMatches ||
      (matches === selectedMatches &&
        registered === selectedRegistered &&
        absoluteSpecificity > selectedAbsoluteSpecificity) ||
      (matches === selectedMatches && registered && !selectedRegistered)
    ) {
      selectedRoot = repoRoot;
      selectedMatches = matches;
      selectedAbsoluteSpecificity = absoluteSpecificity;
    }
  }

  // Mirror the scoring loop's own preference: the stripped candidate wins only when
  // it is the one that actually exists and the plain form does not.
  const fileForRoot = (root: string, raw: string): string | undefined => {
    const resolved = pathForRoot(root, raw);
    if (!resolved) return normalizedRepoPath(root, raw);
    if (resolved.strippedRelativePath) {
      try {
        if (!exists(resolved.absolutePath) && exists(resolved.strippedAbsolutePath!)) {
          return resolved.strippedRelativePath;
        }
      } catch {
        /* fall through to the plain relativePath below */
      }
    }
    return resolved.relativePath;
  };

  /**
   * EI-21937921955988010: the checkout that OWNS a declared path, which is NOT always
   * `selectedRoot`. Previously every path was forced through `selectedRoot` and a
   * single unresolvable one discarded the ENTIRE stamp (the `validSelectedFiles`
   * all-or-nothing bail) — so a completion spanning the papercusp repo, two suite-app
   * checkouts and a handful of screenshot artifacts stored no stamp at all and closed
   * as `proposed` with no diagnostic naming which paths were the problem.
   */
  const ownerForPath = (raw: string, deletion = false): string | undefined => {
    const declaredPath = raw.trim();
    const nested = nestedOwners.get(declaredPath);
    if (nested) return nested.root;
    if (deletion) {
      // A deleted path is intentionally absent, so existence-based ownership
      // scoring cannot find it. Absolute paths still carry a physical checkout
      // boundary; relative paths retain the selected-root compatibility rule.
      if (nodePath.isAbsolute(declaredPath)) {
        const containingRoots = candidateRoots
          .filter((repoRoot) => Boolean(pathForRoot(repoRoot, declaredPath)))
          .sort((a, b) => b.length - a.length);
        return containingRoots[0];
      }
      return pathForRoot(selectedRoot, declaredPath) ? selectedRoot : undefined;
    }
    // Mirror the scoring loop's tie rule EXACTLY: deepest-containing-checkout wins only
    // for an ABSOLUTE declared path (where containment is a real fact and a submodule
    // should stamp its own HEAD). A RELATIVE path resolves "inside" every root by
    // construction, so it retains the primary-root compatibility rule instead —
    // EI-20460682854560939, "legacy completions do not change repositories".
    const declaredIsAbsolute = nodePath.isAbsolute(declaredPath);
    let best: string | undefined;
    let bestSpecificity = -1;
    for (const repoRoot of candidateRoots) {
      const resolved = pathForRoot(repoRoot, raw);
      if (!resolved) continue;
      try {
        const plainExists = exists(resolved.absolutePath);
        const strippedExists = !plainExists && resolved.strippedAbsolutePath && exists(resolved.strippedAbsolutePath);
        if (!(plainExists || strippedExists)) continue;
      } catch {
        continue;
      }
      if (!declaredIsAbsolute) {
        // First match wins, and `selectedRoot` (scored primary) outranks any other.
        if (repoRoot === selectedRoot) return repoRoot;
        best ??= repoRoot;
        continue;
      }
      if (repoRoot.length > bestSpecificity) {
        best = repoRoot;
        bestSpecificity = repoRoot.length;
      }
    }
    if (best) return best;
    // A path that resolves INSIDE the primary checkout but does not exist is still that
    // checkout's to prove: recording it with a null identity is what keeps a missing
    // file reading as UNPROVEN rather than being excused as an out-of-repo artifact.
    return pathForRoot(selectedRoot, raw) ? selectedRoot : undefined;
  };

  const groups = new Map<string, string[]>();
  const deletedGroups = new Map<string, string[]>();
  const artifactPaths: { path: string; deletion: boolean }[] = [];
  for (const raw of declared) {
    const declaredPath = raw.trim();
    // A glob or empty citation is INVALID, not an artifact. WI-312624 made the
    // fail-closed bail explicit for exactly this case; keep it.
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) return undefined;
    const deletion = deletedRaw.has(declaredPath);
    const owner = ownerForPath(raw, deletion);
    const file = owner ? fileForRoot(owner, raw) : undefined;
    if (!owner || !file) {
      artifactPaths.push({ path: declaredPath, deletion });
      continue;
    }
    const targetGroups = deletion ? deletedGroups : groups;
    const group = targetGroups.get(owner) ?? [];
    group.push(file);
    targetGroups.set(owner, group);
  }

  const primaryStamp = await completionTreeStamp({
    repoRoot: selectedRoot,
    readFile: probe.readFile,
    readBytes: probe.readBytes,
    headBlobs: probe.headBlobs,
    filesChanged: groups.get(selectedRoot) ?? [],
    filesDeleted: deletedGroups.get(selectedRoot) ?? [],
  });
  if (!primaryStamp) return undefined;

  const identity: CompletionTreeContentIdentity[] = [...(primaryStamp.contentIdentity ?? [])];
  for (const repoRoot of new Set([...groups.keys(), ...deletedGroups.keys()])) {
    if (repoRoot === selectedRoot) continue;
    const files = groups.get(repoRoot) ?? [];
    const deletedFiles = deletedGroups.get(repoRoot) ?? [];
    const stamp = await completionTreeStamp({
      repoRoot,
      readFile: probe.readFile,
      readBytes: probe.readBytes,
      headBlobs: probe.headBlobs,
      filesChanged: files,
      filesDeleted: deletedFiles,
    });
    if (!stamp?.contentIdentity) {
      // That checkout's HEAD could not be read. Record ITS paths as unproven — with the
      // reason, per WI-42441 — instead of discarding every other repository's proof.
      for (const path of [...files, ...deletedFiles]) {
        identity.push({
          path,
          workingTreeBlobSha: null,
          headBlobSha: null,
          ...(deletedFiles.includes(path) ? { deletion: true as const } : {}),
          repositoryRoot: repoRoot,
          headBlobUnresolvable: `checkout '${repoRoot}' HEAD could not be read`,
        });
      }
      continue;
    }
    for (const entry of stamp.contentIdentity) {
      identity.push({ ...entry, repositoryRoot: repoRoot, headSha: stamp.headSha });
    }
  }
  for (const { path, deletion } of artifactPaths) {
    identity.push({
      path,
      workingTreeBlobSha: null,
      headBlobSha: null,
      ...(deletion ? { deletion: true as const } : {}),
      outOfRepoArtifact: true,
    });
  }

  return identity.length ? { ...primaryStamp, contentIdentity: identity.slice(0, MAX_PATHS_PROBED) } : primaryStamp;
}

export type CompletionFreshnessVerdict = 'fresh' | 'stale' | 'unavailable' | 'not-applicable';

export interface CompletionFreshness {
  verdict: CompletionFreshnessVerdict;
  storedTreeStamp: CompletionTreeStamp;
  currentTreeStamp?: CompletionTreeStamp;
  reason: string;
}

export interface CompletionFreshnessProbe {
  currentStamp?: (
    stored: CompletionTreeStamp,
  ) => CompletionTreeStamp | undefined | Promise<CompletionTreeStamp | undefined>;
}

function storedTreeStamp(value: unknown): CompletionTreeStamp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const repositoryRoot = typeof record.repositoryRoot === 'string' ? record.repositoryRoot.trim() : '';
  const headSha = typeof record.headSha === 'string' ? record.headSha.trim() : '';
  if (!repositoryRoot || !SHA_RE.test(headSha)) return undefined;
  const rawIdentity = record.contentIdentity;
  let contentIdentity: CompletionTreeContentIdentityWithDeletion[] | undefined;
  if (rawIdentity !== undefined) {
    if (!Array.isArray(rawIdentity) || rawIdentity.length === 0 || rawIdentity.length > MAX_PATHS_PROBED)
      return undefined;
    contentIdentity = [];
    for (const candidate of rawIdentity) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const entry = candidate as Record<string, unknown>;
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      const workingTreeBlobSha = entry.workingTreeBlobSha;
      const headBlobSha = entry.headBlobSha;
      if (
        !path ||
        (workingTreeBlobSha !== null &&
          (typeof workingTreeBlobSha !== 'string' || !OBJECT_SHA_RE.test(workingTreeBlobSha))) ||
        (headBlobSha !== null && (typeof headBlobSha !== 'string' || !OBJECT_SHA_RE.test(headBlobSha)))
      )
        return undefined;
      const deletion = entry.deletion;
      if (deletion !== undefined && deletion !== true) return undefined;
      const headBlobUnresolvable = entry.headBlobUnresolvable;
      if (headBlobUnresolvable !== undefined && (typeof headBlobUnresolvable !== 'string' || !headBlobUnresolvable.trim()))
        return undefined;
      const repositoryRootEntry = entry.repositoryRoot;
      if (repositoryRootEntry !== undefined && (typeof repositoryRootEntry !== 'string' || !repositoryRootEntry.trim()))
        return undefined;
      const headShaEntry = entry.headSha;
      if (headShaEntry !== undefined && (typeof headShaEntry !== 'string' || !SHA_RE.test(headShaEntry)))
        return undefined;
      const outOfRepoArtifact = entry.outOfRepoArtifact;
      if (outOfRepoArtifact !== undefined && outOfRepoArtifact !== true) return undefined;
      contentIdentity.push({
        path,
        workingTreeBlobSha,
        headBlobSha,
        ...(deletion ? { deletion } : {}),
        ...(headBlobUnresolvable ? { headBlobUnresolvable } : {}),
        ...(repositoryRootEntry ? { repositoryRoot: nodePath.resolve(repositoryRootEntry) } : {}),
        ...(headShaEntry ? { headSha: headShaEntry } : {}),
        ...(outOfRepoArtifact ? { outOfRepoArtifact } : {}),
      });
    }
  }
  return { repositoryRoot: nodePath.resolve(repositoryRoot), headSha, ...(contentIdentity ? { contentIdentity } : {}) };
}

function identityByPath(
  identity: readonly CompletionTreeContentIdentity[],
): Map<string, CompletionTreeContentIdentity> | undefined {
  const byPath = new Map<string, CompletionTreeContentIdentity>();
  for (const entry of identity) {
    if (byPath.has(entry.path)) return undefined;
    byPath.set(entry.path, entry);
  }
  return byPath;
}

/**
 * Compare terminal evidence's stored tree stamp with the current stamp from
 * that same repository.  No tree stamp means no signal; an unobservable current
 * stamp is explicit `unavailable`, never a false `fresh` result.
 */
export async function completionFreshnessForEvidence(
  evidence: unknown,
  probe: CompletionFreshnessProbe = {},
): Promise<CompletionFreshness | undefined> {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const record = evidence as Record<string, unknown>;
  const stored = storedTreeStamp(record.treeStamp);
  if (!stored) return undefined;

  if (!stored.contentIdentity?.length) {
    // Pathless verification is a valid, measured completion shape (`already-passing`,
    // investigation, duplicate, or other no-file work). There is no content identity
    // to compare, so calling it "unavailable" falsely blames the observer for a signal
    // that is not applicable. Older writers dropped an explicit `filesChanged: []`, so
    // an omitted path list is included here; a non-empty list remains unavailable below.
    const filesChanged = record.filesChanged;
    const filesDeleted = record.filesDeleted;
    const hasChangedPaths = Array.isArray(filesChanged) && filesChanged.length > 0;
    const hasDeletedPaths = Array.isArray(filesDeleted) && filesDeleted.length > 0;
    if (!hasChangedPaths && !hasDeletedPaths) {
      return {
        verdict: 'not-applicable',
        storedTreeStamp: stored,
        reason: `No changed files were declared for ${stored.repositoryRoot}; completion freshness is not applicable.`,
      };
    }
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      reason: `Committed content identity was not recorded for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  let current: CompletionTreeStamp | undefined;
  try {
    current = await (
      probe.currentStamp ??
      ((stamp) =>
        completionTreeStamp({
          repoRoot: stamp.repositoryRoot,
          filesChanged: stamp.contentIdentity
            ?.filter((entry) => (entry as CompletionTreeContentIdentityWithDeletion).deletion !== true)
            .map((entry) => entry.path),
          filesDeleted: stamp.contentIdentity
            ?.filter((entry) => (entry as CompletionTreeContentIdentityWithDeletion).deletion === true)
            .map((entry) => entry.path),
        }))
    )(stored);
  } catch {
    current = undefined;
  }

  if (!current) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      reason: `Current HEAD could not be observed for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  if (!current.contentIdentity?.length) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: `Current committed content identity could not be observed for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  /**
   * WI-42441: a path whose HEAD side could not be READ makes the identity fail to match,
   * but `stale` is a claim ABOUT THE EVIDENCE ("it no longer describes this tree"), and we
   * have not established that. Saying stale here sends the reader to re-verify work that
   * may be perfectly current, which is the same misattribution this item fixed at the
   * close path. `unavailable` is the honest verdict for "could not check".
   */
  const unresolvable = [...unresolvableContentIdentityPaths(current), ...unresolvableContentIdentityPaths(stored)];
  if (unresolvable.length > 0) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: `Committed content could not be resolved for ${unresolvable
        .map((entry) => `${entry.path} (${entry.headBlobUnresolvable})`)
        .join(
          '; ',
        )}; completion freshness is not established. This is a resolution failure, not evidence of staleness.`,
    };
  }

  if (!completionTreeContentIdentityMatches(stored.contentIdentity)) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: 'Stored completion content identity does not match its declared HEAD; re-verify before trusting it.',
    };
  }
  if (!completionTreeContentIdentityMatches(current.contentIdentity)) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason:
        'Current working-tree content does not match committed HEAD for every declared path; re-verify before trusting it.',
    };
  }

  if (current.repositoryRoot !== stored.repositoryRoot) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason:
        `Completion verification was observed in ${stored.repositoryRoot}, but current evidence resolved in ${current.repositoryRoot}; ` +
        're-verify before treating the terminal result as current.',
    };
  }

  const storedByPath = identityByPath(stored.contentIdentity);
  const currentByPath = identityByPath(current.contentIdentity);
  const samePaths =
    storedByPath &&
    currentByPath &&
    storedByPath.size === currentByPath.size &&
    [...storedByPath.keys()].every((path) => currentByPath.has(path));
  if (!samePaths || !storedByPath || !currentByPath) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: 'Current committed content identity covers a different declared path set; re-verify before trusting it.',
    };
  }

  for (const [path, storedEntry] of storedByPath) {
    const currentEntry = currentByPath.get(path)!;
    if (storedEntry.headBlobSha !== currentEntry.headBlobSha) {
      return {
        verdict: 'stale',
        storedTreeStamp: stored,
        currentTreeStamp: current,
        reason:
          `Committed content for ${path} changed between verification HEAD ${stored.headSha} and current HEAD ${current.headSha}; ` +
          're-verify before treating the terminal result as current.',
      };
    }
  }

  return {
    verdict: 'fresh',
    storedTreeStamp: stored,
    currentTreeStamp: current,
    reason:
      current.headSha === stored.headSha
        ? `Completion verification and current HEAD both resolve to ${current.headSha}.`
        : `Completion verification remains fresh across HEAD movement from ${stored.headSha} to ${current.headSha}; declared path content is unchanged.`,
  };
}
