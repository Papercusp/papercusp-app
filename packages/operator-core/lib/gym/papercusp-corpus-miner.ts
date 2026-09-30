/**
 * THE CORPUS MINER — derive real gym tasks from this repo's own history.
 *
 * Plan gym-real-fitness-signal-2026-07-27, P-001; design D-006. Pairs with
 * `papercusp-substrate.ts`, which owns the substrate plan and the validity gate.
 *
 * The corpus is MINED, not hand-written. D-003's extraction required a human to
 * pick a fix, retype its oracle and hand-stub its implementation — which is why
 * it produced three tasks in a day and why each one silently drifts from the
 * code it claims to represent. Here a candidate is whatever git already knows:
 * a commit that changed an implementation file AND its sibling test in the same
 * breath is, by construction, a real change that shipped with a real oracle.
 *
 * ── WHY A COMMIT'S FILE LIST IS USABLE HERE, DESPITE THE SQUASH ──────────────
 * git-sync commits the whole shared tree, so a commit is NOT one person's change
 * (D-006: the last ten ranged from 1 to 1060 files). That kills "replay at the
 * parent commit", but it does NOT kill co-change: if `x.ts` and `x.test.ts` both
 * moved in one sweep, someone was editing them together — the squash bundles
 * unrelated work alongside, it does not fabricate a spurious pairing between a
 * file and its own sibling test. So co-change stays a sound signal for
 * "this file changed and its oracle changed with it", which is all we need.
 *
 * ── THE FAILURE MODE THIS MODULE EXISTS TO BOUND ─────────────────────────────
 * A task rewinds ONE file inside a world pinned at a much later commit. If the
 * rewind reaches too far back, the old implementation may not even cohere with
 * the world around it — a since-renamed import, a changed signature at a call
 * site it doesn't know about. The test then fails at COLLECTION rather than on
 * an assertion, and `judgeDiscrimination` sees the shape it admits
 * (reverted=failed, restored=passed) while the actual task handed to the agent
 * is "repair a broken import", not "implement the real behaviour".
 *
 * That is a false positive the validity gate cannot catch by itself, because
 * from outside a failing test the two are indistinguishable. It is bounded here
 * instead, by construction:
 *
 *   • RECENCY — only mine commits within `maxRewindCommits` of the pin, so the
 *     rewind is a short, coherent step rather than an archaeological one.
 *   • ONE HOP — the rewind target is the joint commit's immediate parent: the
 *     state right before that change, never an arbitrary older version.
 *
 * The residual risk is real and is NOT claimed to be eliminated. `probeReason`
 * on the observed result is where a caller records WHY a reverted run failed
 * once it can tell (a collection error vs. an assertion); until that is wired,
 * a conservative recency bound is the honest mitigation, not a fix.
 */
import type { PapercuspTaskDescriptor } from './papercusp-substrate';
import type { GymTaskPool } from './task-generator';

/** One commit as git reports it: its sha, its parent, and the paths it touched. */
export interface CommitFileChange {
  sha: string;
  parentSha: string | null;
  /** Repo-relative paths changed by this commit. */
  paths: readonly string[];
}

/** A mined (implementation, oracle) pair before it has been probed. */
export interface CandidatePair {
  implPath: string;
  testPath: string;
  /** The commit that changed both — where the oracle arrived. */
  jointCommit: string;
  /** Its immediate parent: the state right before the change. The rewind target. */
  parentCommit: string;
  /** How many commits back from the pin the joint commit sits. Lower is safer. */
  rewindDistance: number;
}

export interface MineOptions {
  /**
   * Reject a candidate whose joint commit is further than this from the pin.
   * The bound on the incoherent-rewind failure mode above — a long rewind is
   * likelier to break the file's own imports than to pose a real task.
   */
  maxRewindCommits?: number;
  /** Only mine paths under these prefixes (default: the workspace source roots). */
  includePrefixes?: readonly string[];
}

const DEFAULT_MAX_REWIND_COMMITS = 60;

/**
 * Source roots worth mining. `_retired/**` is excluded deliberately: it is
 * preserved-not-active code (repo convention), so a task there would ask an
 * agent to restore behaviour nobody wants restored.
 */
export const DEFAULT_INCLUDE_PREFIXES: readonly string[] = Object.freeze([
  'packages/',
  'libs/',
  'apps/',
]);

const TEST_SUFFIX_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The sibling oracle for an implementation path, or null if it is itself a test. */
export function siblingTestPath(implPath: string): string | null {
  if (TEST_SUFFIX_RE.test(implPath)) return null;
  const m = /^(.*)\.([cm]?[jt]sx?)$/.exec(implPath);
  if (!m) return null;
  return `${m[1]}.test.${m[2]}`;
}

function isMinablePath(p: string, prefixes: readonly string[]): boolean {
  if (p.includes('/_retired/') || p.startsWith('_retired/')) return false;
  if (p.endsWith('.d.ts')) return false;
  return prefixes.some((prefix) => p.startsWith(prefix));
}

/**
 * Mine candidate (impl, oracle) pairs from a pin-ordered commit walk.
 *
 * `commits` must be newest-first, starting AT the pin — the index is the rewind
 * distance. Each impl file yields at most ONE candidate: its most recent joint
 * commit, i.e. the shortest, safest rewind available for that file.
 */
export function mineCandidatePairs(
  commits: readonly CommitFileChange[],
  opts: MineOptions = {},
): CandidatePair[] {
  const maxRewind = opts.maxRewindCommits ?? DEFAULT_MAX_REWIND_COMMITS;
  const prefixes = opts.includePrefixes ?? DEFAULT_INCLUDE_PREFIXES;
  const seen = new Set<string>();
  const out: CandidatePair[] = [];

  commits.forEach((commit, distance) => {
    if (distance > maxRewind) return;
    // No parent ⇒ nothing to rewind to. A root commit is not a task.
    if (!commit.parentSha) return;
    const paths = new Set(commit.paths);
    for (const implPath of commit.paths) {
      if (seen.has(implPath)) continue;
      if (!isMinablePath(implPath, prefixes)) continue;
      const testPath = siblingTestPath(implPath);
      if (!testPath) continue;
      // The oracle must have moved in the SAME commit — that co-change is the
      // whole signal that this change shipped with a test that judges it.
      if (!paths.has(testPath)) continue;
      seen.add(implPath);
      out.push({
        implPath,
        testPath,
        jointCommit: commit.sha,
        parentCommit: commit.parentSha,
        rewindDistance: distance,
      });
    }
  });

  // Shortest rewind first: the safest, most coherent tasks lead.
  return out.sort((a, b) => a.rewindDistance - b.rewindDistance || a.implPath.localeCompare(b.implPath));
}

/**
 * Assign pools round-robin over the ranked candidates.
 *
 * Round-robin rather than "best N to train" on purpose: `real-anchor` is the
 * falsifiability check (scored, NEVER optimized), so if it were systematically
 * given the leftovers it would answer a different question than train does, and
 * a divergence between them would no longer be evidence about the gym.
 */
export function assignPools(
  candidates: readonly CandidatePair[],
  pools: readonly GymTaskPool[] = ['train', 'dev-anchor', 'real-anchor'],
): Array<{ candidate: CandidatePair; pool: GymTaskPool }> {
  if (pools.length === 0) throw new Error('assignPools requires at least one pool');
  return candidates.map((candidate, i) => ({ candidate, pool: pools[i % pools.length] }));
}

/** A stable, readable task id from an implementation path. */
export function taskIdForCandidate(c: CandidatePair): string {
  const stem = c.implPath
    .replace(/^(packages|libs|apps)\//, '')
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `real-${stem}-${c.jointCommit.slice(0, 8)}`;
}

/**
 * Turn a ranked, pooled candidate into a task descriptor.
 *
 * The spec deliberately does NOT describe the implementation — it names the
 * oracle and points at it. The real test IS the specification, in the precise
 * sense that matters: it is what a human actually wrote down to pin the
 * behaviour, and unlike a restatement it cannot drift from the code.
 */
export function candidateToDescriptor(
  candidate: CandidatePair,
  pool: GymTaskPool,
  pinCommit: string,
): PapercuspTaskDescriptor {
  return {
    taskId: taskIdForCandidate(candidate),
    pool,
    pinCommit,
    implPath: candidate.implPath,
    testPath: candidate.testPath,
    revertToCommit: candidate.parentCommit,
    spec:
      `\`${candidate.implPath}\` has been rewound to an earlier version and no longer satisfies its tests. ` +
      `Restore the behaviour required by \`${candidate.testPath}\`, which is the real test file for this module ` +
      `and must not be modified. Run it with \`npm run test:file -- ${candidate.testPath}\`.`,
    intent:
      `A real change shipped to this module together with the test that judges it. The task is to re-derive that ` +
      `behaviour from the oracle alone, inside the real codebase it lives in.`,
    sourceRef: `papercusp commit ${candidate.jointCommit.slice(0, 12)} (co-changed ${candidate.implPath} + ${candidate.testPath})`,
  };
}

/** Full mine: history → ranked, pooled, ready-to-probe descriptors. */
export function mineDescriptors(
  commits: readonly CommitFileChange[],
  pinCommit: string,
  opts: MineOptions & { pools?: readonly GymTaskPool[]; limit?: number } = {},
): PapercuspTaskDescriptor[] {
  const ranked = mineCandidatePairs(commits, opts);
  const limited = opts.limit == null ? ranked : ranked.slice(0, opts.limit);
  return assignPools(limited, opts.pools).map(({ candidate, pool }) =>
    candidateToDescriptor(candidate, pool, pinCommit),
  );
}
