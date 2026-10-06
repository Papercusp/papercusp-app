/**
 * drift — "has the code under this doc moved since the doc's baseline?"
 *
 * Plan: harness-docs-integration-2026-06-05 (P-001 / D-001). Staleness reduces to
 * plain git: `git log <baseline_sha>..HEAD -- <resolved paths>` non-empty. The
 * baseline is `generated_from_sha` (generated docs) or `last_verified_sha`
 * (manual docs); the resolved paths come from the doc's subject_ref.
 *
 * Honest edges (D-001), all covered by drift.test.ts:
 *   - renames: a single concrete `path` / `symbol` file uses `--follow`.
 *   - whitespace/comment-only commits cause a false "stale" nudge — ACCEPTED:
 *     a false nudge beats silent rot. (Refine later with --ignore-all-space /
 *     a per-symbol content hash.)
 *   - `symbol` precision: `git log -L :name:file` traces just the function's
 *     lines, so an unrelated edit elsewhere in the file does NOT flag the doc;
 *     a file-level `--follow` fallback runs when `-L` can't (renamed/removed).
 */

import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import type { GitRunner, SubjectRef, FeatureCommitLookup } from './subject-ref';
import { resolveAnchorPaths } from './subject-ref';

export interface DriftResult {
  /** True when code under the subject_ref changed since the baseline. */
  stale: boolean;
  /** Repo-relative files that changed in the baseline..HEAD range (best-effort). */
  changedPaths: string[];
  /** Which strategy actually ran. */
  method: 'path' | 'symbol' | 'symbol-fallback' | 'feature' | 'none';
  /**
   * Set when the check could NOT be performed (no baseline, unresolved feature,
   * unknown/invalid baseline SHA, git error). The caller maps this to a
   * "can't tell" status rather than a confident fresh/stale.
   */
  error?: string;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Collect unique non-blank file paths from `git log --name-only` stdout. */
function collectNameOnly(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split('\n')) {
    const f = line.trim();
    // --name-only with --format=%H emits SHA lines too; skip 40/64-hex-only lines.
    if (!f) continue;
    if (/^[0-9a-f]{40}$/i.test(f) || /^[0-9a-f]{64}$/i.test(f)) continue;
    files.add(f);
  }
  return [...files];
}

// ── Sticky-drift memo (WI-10006256) ──────────────────────────────────────────────
// Drift against a FIXED baseline is monotone along history: if `B..H1` holds a
// matching commit, `B..H2` holds it too for every descendant H2 of H1. The git-sync
// sweep re-confirms every doc whose anchors the tick touched, and on a busy shared
// tree that is mostly docs ALREADY drifted from a months-old baseline — each re-walk
// cost 5-11 s of git CPU (measured ~0.8 core of the bg-host spawner sidecar). So a
// POSITIVE (drifted) range result is remembered with the exact head it was evaluated
// at, and reused only while that head is still an ancestor of the current HEAD (a
// rewind or branch switch recomputes). Negative and error results are never cached:
// they can change as HEAD advances. A baseline change is a different key. Trade-off:
// a reused result keeps the changed-path list from when it was first computed.
const DRIFT_MEMO_MAX = 4096;
const driftMemo = pinModuleState('@papercusp/operator-core.harness-docs-drift-memo', () => ({
  entries: new Map<string, { head: string; stdout: string }>(),
}));

/** Clear the sticky-drift memo — for tests only. */
export function __clearDriftMemoForTests(): void {
  driftMemo.entries.clear();
}

/**
 * Run a drift `git log <base>..HEAD ...` (args[1] is the range), memoizing a result
 * for which `isDrifted(stdout)` holds. The range is evaluated against the resolved
 * HEAD sha, so the recorded head is exactly the tip the walk covered.
 */
async function runDriftRangeLog(
  runGit: GitRunner,
  args: string[],
  cwd: string,
  isDrifted: (stdout: string) => boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const key = `${cwd}\0${args.join('\0')}`;
  const hit = driftMemo.entries.get(key);
  if (hit) {
    const anc = await runGit(['merge-base', '--is-ancestor', hit.head, 'HEAD'], cwd);
    if (anc.code === 0) {
      driftMemo.entries.delete(key);
      driftMemo.entries.set(key, hit); // LRU touch
      return { code: 0, stdout: hit.stdout, stderr: '' };
    }
    driftMemo.entries.delete(key);
  }
  const range = args[1] ?? '';
  const headRes = range.endsWith('..HEAD') ? await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd) : null;
  const head = headRes && headRes.code === 0 ? headRes.stdout.trim() : '';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head)) return runGit(args, cwd); // cannot pin: uncached
  const pinned = [args[0], `${range.slice(0, -'HEAD'.length)}${head}`, ...args.slice(2)];
  const res = await runGit(pinned, cwd);
  if (res.code === 0 && isDrifted(res.stdout)) {
    driftMemo.entries.set(key, { head, stdout: res.stdout });
    if (driftMemo.entries.size > DRIFT_MEMO_MAX) {
      const oldest = driftMemo.entries.keys().next().value;
      if (oldest !== undefined) driftMemo.entries.delete(oldest);
    }
  }
  return res;
}

/**
 * Multi-path drift (WI-10006256). A `git log <base>..HEAD -- p1 p2 …` walk cannot use
 * the commit-graph's changed-path Bloom filters (git 2.43 applies them to a SINGLE
 * pathspec only), so on a ~34k-commit range it cost 6-14 s of CPU per doc, measured
 * as the bulk of the spawner sidecar's drift CPU. Two cheaper steps give the same
 * stale verdict:
 *  1. Endpoint `git diff --name-only <base> HEAD -- paths` (milliseconds). Any path
 *     that differs at the endpoints was touched by some commit in the range: stale.
 *  2. Only when nothing differs (no change, or every change reverted) fall back to
 *     one single-pathspec `git log` per path — Bloom-accelerated (~0.7 s vs 8.5 s for
 *     two paths, measured) — so a touched-then-reverted path still counts as drift,
 *     exactly as the old walk did.
 * The changed-path list in step 1 can omit paths that were touched and reverted
 * while another path really differs; it only feeds the human-readable reason.
 */
async function multiPathDrift(
  runGit: GitRunner,
  base: string,
  rels: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const diff = await runGit(['diff', '--name-only', base, 'HEAD', '--', ...rels], cwd);
  if (diff.code !== 0) return diff;
  if (collectNameOnly(diff.stdout).length > 0) return diff;
  const range = `${base}..HEAD`;
  const out: string[] = [];
  for (const rel of rels) {
    const res = await runDriftRangeLog(runGit, ['log', range, '--name-only', '--format=%H', '--', rel], cwd, hasChangedName);
    if (res.code !== 0) return res;
    out.push(res.stdout);
  }
  return { code: 0, stdout: out.join('\n'), stderr: '' };
}

const hasCommitLine = (stdout: string): boolean => stdout.split('\n').some((l) => l.trim() !== '');
const hasChangedName = (stdout: string): boolean => collectNameOnly(stdout).length > 0;

/** Is `sha` a single concrete (non-glob) path? Then `--follow` is valid. */
function isConcretePath(p: string): boolean {
  return !/[*?[\]{}]/.test(p);
}

/**
 * Submodule routing (docs-audit 2026-06-23, #3). An anchor under a git submodule
 * (e.g. `libs/papercusp/...`) is INVISIBLE to a `git log` run in the superproject:
 * the superproject's object DB has no tree for paths inside the submodule, only the
 * gitlink. So `git log <baseline>..HEAD -- libs/papercusp/foo` returns empty and the
 * doc NEVER drift-flags (silent rot). The fix: run the drift query INSIDE the
 * submodule, against the submodule's own baseline — which we recover from the
 * superproject baseline commit (the gitlink SHA at that commit) via `ls-tree`, so no
 * extra state needs storing.
 *
 * Longest submodule prefix containing `p` → {sub, rel}; null if not under any submodule.
 */
export function submoduleForPath(p: string, submodulePaths: string[]): { sub: string; rel: string } | null {
  let best: { sub: string; rel: string } | null = null;
  for (const raw of submodulePaths) {
    const sub = raw.replace(/\/+$/, '');
    if (!sub) continue;
    if (p === sub || p.startsWith(`${sub}/`)) {
      const rel = p === sub ? '' : p.slice(sub.length + 1);
      if (!best || sub.length > best.sub.length) best = { sub, rel };
    }
  }
  return best;
}

// WI-5282: (repoRoot, superBaseline, submodulePath) → gitlink SHA is CONTENT-ADDRESSED —
// a commit's tree entries never change, so this mapping is immutable and safe to cache
// with no TTL/invalidation. Without this, a freshness-sweep candidate loop
// (freshness-sweep.ts) re-resolves the SAME (baseline, submodule) pair with its own
// `git ls-tree` child_process.spawn once per DOC sharing that baseline — with many docs
// anchored under the same submodule and sharing a recent baseline, that is one redundant
// spawn per doc instead of one per distinct (baseline, submodule) pair. `spawn` self-time
// was ~11% of a live bg-host CPU sample (~32% of non-idle workload), the top real hog after
// WI-5218's keychain fix — same "uncached expensive subprocess on a hot read path" shape as
// the round-4 dev-deploy-state.ts fix (see agent-insights/attributing-loop-saturation-via-cpuprofiles).
// Capped FIFO eviction bounds memory on a long-lived bg-host process; entries are tiny
// (a repo path + two SHAs), so the cap is generous.
const SUBMODULE_BASELINE_SHA_CACHE_MAX = 5000;
const submoduleBaselineShaCache = new Map<string, string | null>();

/** Clear the submodule-baseline-sha cache — for tests only. */
export function __clearSubmoduleBaselineShaCacheForTests(): void {
  submoduleBaselineShaCache.clear();
}

/** The submodule's commit (gitlink SHA) AT the superproject baseline, or null. */
async function submoduleBaselineSha(
  runGit: GitRunner,
  repoRoot: string,
  superBaseline: string,
  submodulePath: string,
): Promise<string | null> {
  const cacheKey = `${repoRoot}\0${superBaseline}\0${submodulePath}`;
  const cached = submoduleBaselineShaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const r = await runGit(['ls-tree', superBaseline, '--', submodulePath], repoRoot);
  if (r.code !== 0) return null; // git failure — not cached, so a transient error can retry.
  // "160000 commit <sha>\t<path>"
  const m = /\bcommit\s+([0-9a-f]{7,64})\b/.exec(r.stdout);
  const sha = m ? m[1] : null;

  if (submoduleBaselineShaCache.size >= SUBMODULE_BASELINE_SHA_CACHE_MAX) {
    // FIFO eviction: Map preserves insertion order, so the first key is the oldest.
    const oldest = submoduleBaselineShaCache.keys().next().value;
    if (oldest !== undefined) submoduleBaselineShaCache.delete(oldest);
  }
  submoduleBaselineShaCache.set(cacheKey, sha);
  return sha;
}

/** Group resolved paths by the (cwd, baseline) the drift `git log` must run against:
 *  the superproject (key '') or a submodule (keyed by its root). Returns null only on
 *  a submodule whose baseline can't be recovered (surfaced as a can't-tell error). */
async function planDriftGroups(
  paths: string[],
  baseline: string,
  opts: { runGit: GitRunner; repoRoot: string; submodulePaths?: string[] },
): Promise<{ groups: { cwd: string; baseline: string; rels: string[]; prefix: string }[]; error?: string }> {
  const subs = opts.submodulePaths ?? [];
  const byKey = new Map<string, { sub: string; rels: string[] }>();
  for (const p of paths) {
    const m = subs.length ? submoduleForPath(p, subs) : null;
    const key = m ? m.sub : '';
    if (!byKey.has(key)) byKey.set(key, { sub: key, rels: [] });
    byKey.get(key)!.rels.push(m ? m.rel : p);
  }
  const groups: { cwd: string; baseline: string; rels: string[]; prefix: string }[] = [];
  let error: string | undefined;
  for (const { sub, rels } of byKey.values()) {
    if (!sub) {
      groups.push({ cwd: opts.repoRoot, baseline, rels, prefix: '' });
      continue;
    }
    const subBase = await submoduleBaselineSha(opts.runGit, opts.repoRoot, baseline, sub);
    if (!subBase) {
      error ??= `submodule-baseline-unresolved: ${sub}`;
      continue;
    }
    groups.push({ cwd: join(opts.repoRoot, sub), baseline: subBase, rels, prefix: `${sub}/` });
  }
  return { groups, error };
}

/**
 * Compute drift for one subject ref against a baseline SHA.
 *
 * Returns `stale:false, error:'no-baseline'` when baselineSha is blank — an
 * un-baselined doc is "not drift-tracked", not fresh-or-stale (the caller renders
 * that distinctly). Returns `error` (stale:false) on any git failure so a bad
 * baseline never spams false stales; the caller surfaces it as needs-attention.
 */
export async function checkSubjectRefDrift(
  ref: SubjectRef,
  baselineSha: string,
  opts: {
    runGit: GitRunner;
    repoRoot: string;
    resolveFeatureCommits?: FeatureCommitLookup;
    /** Submodule roots (repo-relative, from .gitmodules). When set, anchors under a
     *  submodule are drift-checked INSIDE it against its own baseline (#3); omitted →
     *  superproject-only, byte-identical to the pre-fix behavior. */
    submodulePaths?: string[];
  },
): Promise<DriftResult> {
  const { runGit, repoRoot } = opts;
  const baseline = baselineSha.trim();
  if (!baseline) return { stale: false, changedPaths: [], method: 'none', error: 'no-baseline' };
  if (!SHA_RE.test(baseline)) {
    return { stale: false, changedPaths: [], method: 'none', error: 'invalid-baseline' };
  }

  if (ref.kind === 'symbol') {
    // Route a submodule symbol to its own repo + baseline (#3); else superproject.
    const m = opts.submodulePaths?.length ? submoduleForPath(ref.file, opts.submodulePaths) : null;
    const cwd = m ? join(repoRoot, m.sub) : repoRoot;
    const file = m ? m.rel : ref.file;
    let base = baseline;
    if (m) {
      const sb = await submoduleBaselineSha(runGit, repoRoot, baseline, m.sub);
      if (!sb) return { stale: false, changedPaths: [], method: 'symbol', error: `submodule-baseline-unresolved: ${m.sub}` };
      base = sb;
    }
    const range = `${base}..HEAD`;
    // Precise: trace just the function's line range across history.
    const lRes = await runDriftRangeLog(runGit, ['log', range, '-L', `:${ref.name}:${file}`, '-s', '--format=%H'], cwd, hasCommitLine);
    if (lRes.code === 0) {
      const commits = lRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      return { stale: commits.length > 0, changedPaths: commits.length ? [ref.file] : [], method: 'symbol' };
    }
    // `-L` failed (file renamed/removed, or the symbol regex didn't match a
    // function in the current tree). Fall back to file-level drift with --follow.
    const fRes = await runDriftRangeLog(runGit, ['log', range, '--follow', '--name-only', '--format=%H', '--', file], cwd, hasChangedName);
    if (fRes.code !== 0) {
      return { stale: false, changedPaths: [], method: 'symbol-fallback', error: gitErr(fRes) };
    }
    const changed = collectNameOnly(fRes.stdout).map((c) => (m ? `${m.sub}/${c}` : c));
    return { stale: changed.length > 0, changedPaths: changed, method: 'symbol-fallback' };
  }

  // path / feature both resolve to a path set. Group by repo (superproject vs each
  // submodule), then one `git log` per group against that repo's own baseline (#3).
  const paths = await resolveAnchorPaths(ref, opts);
  if (ref.kind === 'feature' && paths.length === 0) {
    return { stale: false, changedPaths: [], method: 'feature', error: 'unresolved-feature' };
  }
  if (paths.length === 0) {
    return { stale: false, changedPaths: [], method: 'none', error: 'no-paths' };
  }

  const method = ref.kind === 'feature' ? 'feature' : 'path';
  const { groups, error: planErr } = await planDriftGroups(paths, baseline, opts);
  const changedAll: string[] = [];
  let ranClean = false;
  let firstErr = planErr;
  for (const g of groups) {
    const range = `${g.baseline}..HEAD`;
    // --follow is only valid for a single concrete file pathspec.
    const single = g.rels.length === 1 && isConcretePath(g.rels[0]);
    const res = single
      ? await runDriftRangeLog(runGit, ['log', range, '--follow', '--name-only', '--format=%H', '--', g.rels[0]], g.cwd, hasChangedName)
      : await multiPathDrift(runGit, g.baseline, g.rels, g.cwd);
    if (res.code !== 0) {
      firstErr ??= gitErr(res);
      continue;
    }
    const c = collectNameOnly(res.stdout);
    if (c.length) changedAll.push(...c.map((x) => `${g.prefix}${x}`));
    else ranClean = true;
  }
  if (changedAll.length) return { stale: true, changedPaths: changedAll, method };
  if (ranClean) return { stale: false, changedPaths: [], method };
  return { stale: false, changedPaths: [], method, error: firstErr ?? 'no-paths' };
}

/**
 * Drift for a doc with possibly-many subject refs: stale if ANY ref is stale.
 * `error` only when EVERY ref errored (i.e. nothing could be checked) — a mix of
 * one clean + one errored ref still yields a confident stale:false.
 */
export async function checkDocDrift(
  refs: SubjectRef[],
  baselineSha: string,
  opts: {
    runGit: GitRunner;
    repoRoot: string;
    resolveFeatureCommits?: FeatureCommitLookup;
    submodulePaths?: string[];
  },
): Promise<DriftResult> {
  if (refs.length === 0) {
    return { stale: false, changedPaths: [], method: 'none', error: 'unanchored' };
  }
  const results = await Promise.all(refs.map((r) => checkSubjectRefDrift(r, baselineSha, opts)));
  const stale = results.find((r) => r.stale);
  if (stale) return stale;
  const clean = results.find((r) => !r.error);
  if (clean) return clean;
  // All errored — propagate the first error (e.g. no-baseline / unresolved).
  return results[0];
}

function gitErr(r: { code: number; stderr: string }): string {
  const msg = r.stderr.trim().split('\n')[0] || `git exited ${r.code}`;
  return `git-error: ${msg}`;
}
