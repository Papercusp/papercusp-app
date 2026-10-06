/**
 * plans:bind-spec-evidence `{ fromTestRun }` — derive a proof binding from a RECORDED test run
 * (P-044, review-system-rework-reduction-2026-09-23, R-10 / D-015).
 *
 * WHY. A finished `testing:run` already knows almost everything a binding needs: the test
 * file, its commit and dirty flag, the harness it ran under, its status. Binding it anyway
 * meant hand-carrying each of those into `evidenceRef`, `testRunId`, a `repo-files`
 * measurement and the mechanical adequacy fields. Measured 2026-09-23 by su-e3d58938: about
 * ten calls from three finished runs to one filed card, including recovering the emit recipe
 * from its own transcript. And a run recorded WITHOUT a harness could not be bound at all:
 * `harness_slug` is env-stamped, so it lands NULL and never matches the store's scoped lookup
 * (EI-24038789681540438).
 *
 * WHAT IS DERIVED (the caller supplies only the clause and the adequacy judgment):
 *  - `evidenceKind`   — `mutation` for a mutation-probe MUTANT row, else `test`.
 *  - `evidenceRef`    — the test path for `test` (what a hand-built binding uses), a
 *                       self-describing run reference for `mutation`.
 *  - `testRunId`      — the run id.
 *  - `measurement`    — `repo-files` with `testPaths:[file_path]` and `sourcePaths` = the
 *                       test file's FIRST RING of relative runtime imports (static, side-effect,
 *                       and literal dynamic `import('…')`), minus test infrastructure. Pass
 *                       `sourcePaths` to override. The first ring, not the transitive graph:
 *                       the measurement is a FRESHNESS hash, and a transitive set both
 *                       overflows the 32-path cap and stales the proof on every unrelated edit
 *                       anywhere below the subject.
 *  - `details.testRun`— id, file, status, source, mutation phase, commit, dirty flag, finish
 *                       time, and how the harness attribution was obtained.
 *  - `details.adequacy.{collected,skipped,executed,outcome}` — observable facts of the run.
 *                       Filled when absent; a declared value the run CONTRADICTS is refused,
 *                       because a "passed" claim on a failed run is exactly the fabrication
 *                       the ledger link exists to prevent.
 *
 * HARNESS ATTRIBUTION. A run with `harness_slug` NULL is ADOPTED into the caller's harness
 * (a guarded conditional UPDATE: still-NULL, same or NULL workspace). Adoption is required,
 * not cosmetic: the store re-checks `test_run_present` against the binding's harness on EVERY
 * read, so a binding pointing at a still-unattributed row would read `testRun: stale` forever.
 * CI and admin-ui rows are never adopted — they are harness-NULL by design and gate triage
 * scopes them by source/commit, so stamping one would move it between populations. A run
 * attributed to ANOTHER harness is refused, never re-stamped.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { recordedTestLayer, type RecordedTestLayer } from '@papercusp/test-config/execution-details';
import { withWorkspace } from '@papercusp/db-org';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { resolveRelative, runtimeSpecifiers, stripComments } from '../../search/import-graph';
import { expandRepoFilesEvidenceSourcePathsAtRoot, repoFilesEvidenceMeasurementSchema } from './spec-evidence-store';
import { pinModuleState } from '@papercusp/module-singleton';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';

/**
 * WI-10005436: how long a repository-IDENTITY answer (git common dir, worktree top level,
 * superproject) is reused. Those answers depend on the directory layout, not on HEAD, the index or
 * any object, so a binding loop that binds run after run from the same checkout need not re-fork
 * them per row. On the ~1.7 GB operator each fork costs ~160 ms of synchronous main-thread time
 * (EI-24852529885337741); an execve census of :3170 counted ~44 of these per 10 min during a peer's
 * binding loop. Only successful answers are kept, so a path that is not (yet) a repository is
 * re-asked every time. A layout change inside this window (a checkout deleted and a DIFFERENT
 * repository re-created at the same path) is the only staleness, and disposable clones use unique
 * mkdtemp paths, so it does not arise in practice.
 */
export const REPO_IDENTITY_TTL_MS = 60_000;

const REPO_IDENTITY_ARGS: ReadonlySet<string> = new Set([
  'rev-parse --path-format=absolute --git-common-dir',
  'rev-parse --show-toplevel',
  'rev-parse --show-superproject-working-tree',
]);

/** Above this many entries per runner, a miss first drops every expired one. */
const REPO_IDENTITY_PRUNE_AT = 64;

interface IdentityEntry {
  promise: Promise<string>;
  settledAt: number | null;
}

/** Keyed by the UNDERLYING runner, so an injected test runner never shares answers with production. */
const repoIdentityMemos = pinModuleState(
  '@papercusp/operator-core.bind-from-test-run.repo-identity-memo',
  () => new WeakMap<GitRunner, Map<string, IdentityEntry>>(),
);

/**
 * `git` with repository-identity reads (see REPO_IDENTITY_TTL_MS) shared per underlying runner:
 * single-flight while in flight, reused for `ttlMs` after success, never reused after a failure.
 * Every other call passes straight through.
 */
export function withRepoIdentityMemo(
  git: GitRunner,
  opts: { ttlMs?: number; now?: () => number } = {},
): GitRunner {
  const ttlMs = opts.ttlMs ?? REPO_IDENTITY_TTL_MS;
  const now = opts.now ?? Date.now;
  let entries = repoIdentityMemos.get(git);
  if (!entries) {
    entries = new Map();
    repoIdentityMemos.set(git, entries);
  }
  const memo = entries;
  const fresh = (e: IdentityEntry, t: number) => e.settledAt === null || t - e.settledAt < ttlMs;
  return (cwd, args) => {
    const joined = args.join(' ');
    if (!REPO_IDENTITY_ARGS.has(joined)) return git(cwd, args);
    const key = `${resolve(cwd)}\0${joined}`;
    const t = now();
    const hit = memo.get(key);
    if (hit && fresh(hit, t)) return hit.promise;
    if (memo.size >= REPO_IDENTITY_PRUNE_AT) {
      for (const [k, e] of memo) if (!fresh(e, t)) memo.delete(k);
    }
    const entry: IdentityEntry = { promise: Promise.resolve(''), settledAt: null };
    entry.promise = git(cwd, args).then(
      (out) => {
        entry.settledAt = now();
        return out;
      },
      (err: unknown) => {
        if (memo.get(key) === entry) memo.delete(key);
        throw err;
      },
    );
    memo.set(key, entry);
    return entry.promise;
  };
}

/** Same bound as a hand-built `repo-files` measurement. */
export const FROM_TEST_RUN_MAX_SOURCE_PATHS = 32;

/** Run sources that are harness-NULL BY DESIGN and must never be re-attributed. */
const NEVER_ADOPTED_SOURCES: ReadonlySet<string> = new Set(['ci', 'admin-ui']);

export const testRunBindingSchema = z
  .object({
    workItemId: z.string().trim().min(1).max(200),
    specId: z.string().trim().min(1).max(200).optional(),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .optional(),
    specRevision: z.number().int().positive().optional(),
    fromTestRun: z
      .number()
      .int()
      .positive()
      .describe('test_runs id. Derives evidenceKind, evidenceRef, testRunId, the repo-files measurement and run facts.'),
    evidenceKind: z.enum(['test', 'mutation', 'counterexample']).optional(),
    sourcePaths: repoFilesEvidenceMeasurementSchema.shape.sourcePaths
      .optional()
      .describe("Override the derived subject files (default: the test file's relative imports)."),
    sourceGlobs: repoFilesEvidenceMeasurementSchema.shape.sourceGlobs,
    canonicalTestPath: repoFilesEvidenceMeasurementSchema.shape.testPaths.unwrap().element
      .optional()
      .describe('Canonical repo-relative test path for a mutation-probe copy-out run whose temporary mirror is no longer a checkout.'),
    details: z.record(z.string(), z.unknown()).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId',
  });

export type TestRunBindingInput = z.infer<typeof testRunBindingSchema>;

export interface TestRunEvidenceRow {
  id: number | string;
  root?: string | null;
  file_path: string | null;
  status: string | null;
  source: string | null;
  harness_slug: string | null;
  workspace_id: string | null;
  commit_sha: string | null;
  worktree_dirty: boolean | null;
  execution_details: unknown;
  /**
   * When the run started (NOT NULL DEFAULT now() in test_runs). Optional only so hand-built
   * fixtures that predate it still type; the loader always selects it. Absent means the
   * after-run modification guard cannot judge, so it does not refuse.
   */
  started_at?: Date | string | null;
  finished_at: Date | string | null;
}

export type HarnessAttribution = 'run' | 'adopted-caller-harness';

/** The binding the derivation hands to the ordinary `bindingSchema` path (re-validated there). */
export interface DerivedTestRunBinding {
  workItemId: string;
  specId?: string;
  sourceValId?: string;
  specRevision?: number;
  evidenceKind: 'test' | 'mutation' | 'counterexample';
  evidenceRef: string;
  testRunId: number;
  measurement: {
    schemaVersion: 1;
    kind: 'repo-files';
    sourcePaths: string[];
    sourceGlobs?: string[];
    testPaths: string[];
  };
  details: Record<string, unknown>;
  observedAt?: string;
}

export type TestRunExpansion =
  | { ok: true; binding: DerivedTestRunBinding; attribution: HarnessAttribution }
  | { ok: false; error: TestRunBindingError; testRunId: number; message: string };

export type TestRunBindingError =
  | 'test_run_not_found'
  | 'test_run_out_of_scope'
  | 'test_run_unfinished'
  | 'test_run_not_adoptable'
  | 'test_run_file_outside_root'
  | 'test_run_canonical_path_source_unsupported'
  | 'test_run_canonical_path_mismatch'
  | 'source_paths_underivable'
  | 'run_contradicts_declared_adequacy'
  | 'test_run_as_committed_content_mismatch'
  | 'test_run_source_modified_after_run';

function executionDetails(raw: unknown): Record<string, unknown> {
  // The column is jsonb, but the reporter has written it both as an object and as a
  // JSON-encoded STRING scalar; accept either rather than reading a string as "no details".
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_INFRA_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  '__fixtures__',
  'fixtures',
  '__mocks__',
]);

/** Test infrastructure is not the proof's SUBJECT: another test, a fixture, a mock, a helper dir. */
export function isTestInfrastructurePath(repoRelative: string): boolean {
  if (TEST_FILE_RE.test(repoRelative)) return true;
  const segments = repoRelative.split('/');
  return segments.slice(0, -1).some((segment) => TEST_INFRA_SEGMENTS.has(segment));
}

/** Literal dynamic imports — `await import('./x')` is how a vitest suite loads its subject after vi.mock. */
function dynamicImportSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  return [...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

/**
 * The test file's first ring of relative runtime imports, repo-relative, minus test
 * infrastructure and anything outside `root`. Sorted and de-duplicated so the same run
 * always derives the same measurement recipe.
 */
export function deriveSubjectSourcePaths(root: string, testPath: string): string[] {
  const abs = resolve(root, testPath);
  const out = new Set<string>();
  for (const specifier of [...runtimeSpecifiers(abs), ...dynamicImportSpecifiers(abs)]) {
    if (!specifier.startsWith('.')) continue;
    const target = resolveRelative(abs, specifier);
    if (!target) continue;
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    const posix = rel.split(sep).join('/');
    if (posix === testPath || isTestInfrastructurePath(posix)) continue;
    out.add(posix);
  }
  return [...out].sort();
}

/** Repo-relative POSIX path of the run's file, or null when it lies outside the checkout. */
export function repoRelativeTestPath(root: string, filePath: string): string | null {
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath.replace(/^\.\//, '');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Rebase recorded nested-workspace paths only across proven views of the same repository. */
export async function recordedTestPath(
  root: string,
  row: Pick<TestRunEvidenceRow, 'root' | 'file_path'>,
  git: GitRunner = defaultGitRunner,
): Promise<string | null> {
  if (!row.file_path) return null;
  if (!row.root) return repoRelativeTestPath(root, row.file_path);
  if (!isAbsolute(row.root)) return null;
  const file = resolve(row.root, row.file_path);
  // A recorded workspace cannot lend evidence for a sibling via ../ or an absolute escape.
  if (!repoRelativeTestPath(row.root, file)) return null;
  const local = repoRelativeTestPath(root, file);
  if (local) return local;
  git = withRepoIdentityMemo(git);
  try {
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (!isAbsolute(common)) return null;
    let recordedRoot = row.root;
    const visited = new Set<string>();
    for (let depth = 0; depth < 16 && !visited.has(recordedRoot); depth += 1) {
      visited.add(recordedRoot);
      const recordedCommon = (await git(recordedRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      if (isAbsolute(recordedCommon) && resolve(recordedCommon) === resolve(common)) {
        const top = (await git(recordedRoot, ['rev-parse', '--show-toplevel'])).trim();
        return isAbsolute(top) ? repoRelativeTestPath(top, file) : null;
      }
      const parent = (await git(recordedRoot, ['rev-parse', '--show-superproject-working-tree'])).trim();
      if (!isAbsolute(parent) || !repoRelativeTestPath(parent, file)) return null;
      recordedRoot = parent;
    }
  } catch {
    // Missing historical checkout or unverifiable repository identity is unknown, never a filename match.
  }
  return null;
}

/** WI-10004898: where a clean disposable-clone run maps back to in the harness checkout. */
export interface AsCommittedMapping {
  /** Harness-root-relative test path. */
  testPath: string;
  /** '' = the harness repository itself; otherwise the submodule checkout the run's commit belongs to. */
  repoPrefix: string;
  commitSha: string;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_SUBMODULE_PREFIX_SEGMENTS = 8;
const MAX_GITLINK_DEPTH = 4;

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * WI-10004898: map a CLEAN run recorded in a disposable clone (`lint:as-committed`) back to
 * this checkout by CONTENT, not location. A clean run at commit X executed exactly X's tree
 * wherever the clone lived, so it is this repository's run at X when X is an object of the
 * harness repository — or of the submodule checkout that a trailing segment run of the
 * recorded root names (`<clone>/libs/generic/search` → `libs/generic/search`) — and X contains
 * the recorded file. Nothing is read from the clone: it is normally deleted by bind time.
 * Dirty or commit-less runs never qualify, because what they executed is unknowable.
 */
export async function asCommittedTestPath(
  root: string,
  row: Pick<TestRunEvidenceRow, 'root' | 'file_path' | 'commit_sha' | 'worktree_dirty'>,
  git: GitRunner = defaultGitRunner,
): Promise<AsCommittedMapping | null> {
  const commitSha = row.commit_sha;
  if (row.worktree_dirty !== false || !commitSha || !FULL_SHA_RE.test(commitSha)) return null;
  if (!row.root || !isAbsolute(row.root) || !row.file_path) return null;
  const inClone = repoRelativeTestPath(row.root, resolve(row.root, row.file_path));
  if (!inClone) return null;
  git = withRepoIdentityMemo(git);
  const segments = resolve(row.root).split(sep).filter(Boolean);
  const prefixes = [''];
  for (let k = 1; k <= Math.min(segments.length, MAX_SUBMODULE_PREFIX_SEGMENTS); k += 1) {
    prefixes.push(segments.slice(-k).join('/'));
  }
  for (const repoPrefix of prefixes) {
    const repo = repoPrefix ? resolve(root, repoPrefix) : resolve(root);
    try {
      // A prefix must name a repository ROOT (a submodule checkout), never a plain directory
      // of the superproject — that would re-anchor the file under the wrong path.
      const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
      if (!(await sameDirectory(top, repo))) continue;
      await git(repo, ['cat-file', '-e', `${commitSha}:${inClone}`]);
      return { testPath: repoPrefix ? `${repoPrefix}/${inClone}` : inClone, repoPrefix, commitSha };
    } catch {
      // Not a repository here, or X / the file is not in it: try the next candidate.
    }
  }
  return null;
}

/**
 * WI-10004978: which repository a clean copy-out row's commit belongs to. The copy-out mirror is
 * gone and names no repository, so the explicit `canonicalTestPath` is the only anchor: a probe
 * of a SUBMODULE file records that submodule's commit, which the superproject's object store
 * does not hold. The harness repository wins whenever it holds the commit (its gitlinks are
 * descended by `blobAtCommit`); otherwise the deepest leading directory of the path that is a
 * repository ROOT containing `<commit>:<rest>` does. '' when nothing matches, so the content
 * check still refuses — naming the repository it looked in.
 */
export async function canonicalAsCommittedPrefix(
  root: string,
  canonicalTestPath: string,
  commitSha: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  try {
    await git(resolve(root), ['cat-file', '-e', `${commitSha}^{commit}`]);
    return '';
  } catch {
    // Not a superproject commit: look for the submodule checkout that holds it.
  }
  const dirs = canonicalTestPath.split('/').slice(0, -1);
  git = withRepoIdentityMemo(git);
  for (let k = dirs.length; k >= 1; k -= 1) {
    const repoPrefix = dirs.slice(0, k).join('/');
    const repo = resolve(root, repoPrefix);
    try {
      const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
      if (!(await sameDirectory(top, repo))) continue;
      await git(repo, ['cat-file', '-e', `${commitSha}:${canonicalTestPath.slice(repoPrefix.length + 1)}`]);
      return repoPrefix;
    } catch {
      // Not a repository root here, or the commit / file is not in it.
    }
  }
  return '';
}

/** Resolve `rel` at `commit` in `repo`, descending through any submodule gitlink the commit pins. */
async function blobAtCommit(
  repo: string,
  commit: string,
  rel: string,
  git: GitRunner,
  depth = 0,
): Promise<{ blob: string; repo: string; rel: string } | null> {
  try {
    const blob = (await git(repo, ['rev-parse', '--verify', '--quiet', `${commit}:${rel}`])).trim();
    if (blob) return { blob, repo, rel };
  } catch {
    // Absent at this commit, or inside a submodule the commit pins: look for the gitlink.
  }
  if (depth >= MAX_GITLINK_DEPTH) return null;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const dir = parts.slice(0, i).join('/');
    let entry = '';
    try {
      entry = (await git(repo, ['ls-tree', commit, '--', dir])).trim();
    } catch {
      return null;
    }
    const gitlink = /^160000 commit ([0-9a-f]{40})\t/.exec(entry);
    if (gitlink) return blobAtCommit(resolve(repo, dir), gitlink[1]!, parts.slice(i).join('/'), git, depth + 1);
    if (entry) return null; // the directory is a real tree at this commit, and `rel` is not in it
  }
  return null;
}

/**
 * The binding fingerprints THIS checkout's files, so a disposable-clone run may lend its
 * outcome only when every measured path here is byte-identical to the commit it ran at —
 * otherwise the stored fingerprint would describe code the run never executed.
 */
async function verifyAsCommittedContent(
  root: string,
  mapping: AsCommittedMapping,
  paths: readonly string[],
  git: GitRunner,
): Promise<{ ok: true } | { ok: false; path: string; reason: string }> {
  const repo = mapping.repoPrefix ? resolve(root, mapping.repoPrefix) : resolve(root);
  const at = mapping.commitSha.slice(0, 12);
  for (const path of paths) {
    if (mapping.repoPrefix && !path.startsWith(`${mapping.repoPrefix}/`)) {
      return { ok: false, path, reason: `lies outside the run's repository ${mapping.repoPrefix}` };
    }
    const rel = mapping.repoPrefix ? path.slice(mapping.repoPrefix.length + 1) : path;
    const committed = await blobAtCommit(repo, mapping.commitSha, rel, git);
    if (!committed) {
      const where = mapping.repoPrefix ? `the ${mapping.repoPrefix} repository` : 'the harness repository';
      return { ok: false, path, reason: `is absent at ${at} (looked up in ${where})` };
    }
    let current = '';
    try {
      current = (await git(committed.repo, ['hash-object', '--', committed.rel])).trim();
    } catch {
      return { ok: false, path, reason: 'is unreadable in this checkout' };
    }
    if (current !== committed.blob) return { ok: false, path, reason: `differs from its content at ${at}` };
  }
  return { ok: true };
}

interface RunFacts {
  collected: boolean;
  skipped: boolean;
  executed: boolean;
  outcome: string;
  testLayer?: RecordedTestLayer;
}

function runFacts(row: TestRunEvidenceRow, kind: DerivedTestRunBinding['evidenceKind']): RunFacts {
  const testLayer = recordedTestLayer(row.execution_details);
  const status = String(row.status ?? '');
  const collectionFailed = executionDetails(row.execution_details).collectionFailed === true;
  const executed = status === 'pass' || status === 'fail';
  const outcome =
    kind === 'test'
      ? ({ pass: 'passed', fail: 'failed', skip: 'skipped' } as Record<string, string>)[status] ?? status
      : kind === 'mutation' && deriveKind(row) !== 'mutation'
        ? // A caller-declared mutation binding over a row that is NOT a raw mutant run (e.g. a
          // testing:record-run operational record of a whole mutation-probe invocation) carries
          // the probe's own VERDICT: it passes exactly when the mutant was caught. Inverting it
          // like a mutant row fabricated `survived` for a caught mutant (WI-10004591). A failed
          // verdict stays the raw status — the row cannot say whether it survived or misfired.
          ({ pass: 'caught' } as Record<string, string>)[status] ?? status
        : // A mutant run that FAILED is a caught mutant; one that PASSED survived.
          ({ fail: 'caught', pass: 'survived' } as Record<string, string>)[status] ?? status;
  return {
    ...(testLayer ? { testLayer } : {}),
    collected: !collectionFailed && status !== 'error',
    skipped: status === 'skip',
    executed,
    outcome,
  };
}

function deriveKind(row: TestRunEvidenceRow): DerivedTestRunBinding['evidenceKind'] {
  return row.source === 'mutation-probe' && executionDetails(row.execution_details).mutationPhase === 'mutant'
    ? 'mutation'
    : 'test';
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Pure derivation: one input + one loaded run row + the checkout root → the binding, or a
 * refusal naming what to supply instead. No I/O beyond reading the test file's imports.
 */
export function deriveBindingFromTestRun(
  input: TestRunBindingInput,
  row: TestRunEvidenceRow,
  root: string,
  attribution: HarnessAttribution,
): TestRunExpansion {
  const testRunId = Number(row.id);
  if (row.status === 'running' || row.status == null) {
    return {
      ok: false,
      error: 'test_run_unfinished',
      testRunId,
      message: `test-run ${testRunId} has status ${row.status ?? 'null'}; bind it once it has finished.`,
    };
  }
  const testPath = row.file_path ? repoRelativeTestPath(root, row.file_path) : null;
  if (!testPath) {
    return {
      ok: false,
      error: 'test_run_file_outside_root',
      testRunId,
      message: `test-run ${testRunId} file ${JSON.stringify(row.file_path)} is not inside this harness checkout (${root}).`,
    };
  }
  let sourcePaths: string[];
  if (input.sourcePaths) {
    sourcePaths = [...new Set(input.sourcePaths)].sort();
  } else {
    try {
      sourcePaths = deriveSubjectSourcePaths(root, testPath);
    } catch (error) {
      return {
        ok: false,
        error: 'source_paths_underivable',
        testRunId,
        message: `could not read ${testPath} to derive its subject files (${String(error)}); pass sourcePaths.`,
      };
    }
    if (sourcePaths.length === 0 || sourcePaths.length > FROM_TEST_RUN_MAX_SOURCE_PATHS) {
      return {
        ok: false,
        error: 'source_paths_underivable',
        testRunId,
        message:
          sourcePaths.length === 0
            ? `${testPath} imports no repo source through a relative specifier, so there is no subject to measure; pass sourcePaths.`
            : `${testPath} directly imports ${sourcePaths.length} repo files, over the ${FROM_TEST_RUN_MAX_SOURCE_PATHS}-path measurement cap; pass the subject files as sourcePaths.`,
      };
    }
  }

  const evidenceKind = input.evidenceKind ?? deriveKind(row);
  const facts = runFacts(row, evidenceKind);
  const declaredAdequacy =
    input.details?.adequacy && typeof input.details.adequacy === 'object'
      ? (input.details.adequacy as Record<string, unknown>)
      : {};
  const contradictions = (Object.keys(facts) as Array<keyof RunFacts>).filter(
    (key) =>
      declaredAdequacy[key] !== undefined &&
      (key === 'outcome'
        ? String(declaredAdequacy[key]).toLowerCase() !== facts.outcome
        : declaredAdequacy[key] !== facts[key]),
  );
  if (contradictions.length > 0) {
    return {
      ok: false,
      error: 'run_contradicts_declared_adequacy',
      testRunId,
      message:
        `test-run ${testRunId} recorded ${contradictions.map((k) => `${k}=${JSON.stringify(facts[k])}`).join(', ')}, ` +
        `but details.adequacy declares ${contradictions.map((k) => `${k}=${JSON.stringify(declaredAdequacy[k])}`).join(', ')}. ` +
        'Omit those fields and they are taken from the run.',
    };
  }

  const exec = executionDetails(row.execution_details);
  const commitSha = row.commit_sha ?? (typeof exec.commitSha === 'string' ? exec.commitSha : null);
  const worktreeDirty = row.worktree_dirty ?? (typeof exec.worktreeDirty === 'boolean' ? exec.worktreeDirty : null);
  const mutationPhase = typeof exec.mutationPhase === 'string' ? exec.mutationPhase : null;
  const evidenceRef =
    evidenceKind === 'test'
      ? testPath
      : `test-run ${testRunId} ${row.source ?? 'unknown-source'}${mutationPhase ? ` ${mutationPhase}` : ''} ` +
        `${row.status} ${testPath} @${commitSha ? commitSha.slice(0, 12) : 'unknown-commit'}${worktreeDirty ? '+dirty' : ''}`;

  const { adequacy: _declared, ...otherDetails } = input.details ?? {};
  const binding: DerivedTestRunBinding = {
    workItemId: input.workItemId,
    ...(input.specId ? { specId: input.specId } : {}),
    ...(input.sourceValId ? { sourceValId: input.sourceValId } : {}),
    ...(input.specRevision ? { specRevision: input.specRevision } : {}),
    evidenceKind,
    evidenceRef,
    testRunId,
    measurement: {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths,
      ...(input.sourceGlobs ? { sourceGlobs: input.sourceGlobs } : {}),
      testPaths: [testPath],
    },
    details: {
      ...otherDetails,
      adequacy: { ...declaredAdequacy, ...facts },
      testRun: {
        id: testRunId,
        filePath: testPath,
        status: row.status,
        source: row.source,
        mutationPhase,
        commitSha,
        worktreeDirty,
        finishedAt: isoOrNull(row.finished_at),
        harnessAttribution: attribution,
      },
    },
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  };
  return { ok: true, binding, attribution };
}

/**
 * EI-24826121815486916: the spec-evidence store pins a binding's measurement from this
 * checkout's bytes at BIND time. An as-committed run is content-verified against its commit;
 * every other run only executed what the checkout held when it ran. A measured file modified
 * after the run started may not be what ran, so its pin would describe code the run never saw.
 * Measured: two mutation-probe mutant runs bound `current` against a source a peer edited four
 * minutes after they ran, while an earlier plain test binding of the same file read stale.
 *
 * test_runs keeps no per-file content, so mtime is the only signal. That makes this
 * conservative: a rewrite with identical bytes also refuses, and the remedy is to re-run.
 * Pass the bound from `measurementLowerBound`, not bare started_at: the reporter derives
 * started_at as finished_at - duration, which postdates collection, so an edit after vitest
 * read a file but before its tests started is only seen against the run-wide start
 * (EI-24827834166866368). A missing file is left to the store's own measurement checks.
 */
export async function measuredFileModifiedAfterRun(
  root: string,
  paths: readonly string[],
  startedAt: Date | string | null | undefined,
): Promise<{ path: string; modifiedAt: string; startedAt: string } | null> {
  if (startedAt == null) return null;
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(started.getTime())) return null;
  for (const repoRelative of paths) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(resolve(root, repoRelative))).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > started.getTime()) {
      return { path: repoRelative, modifiedAt: new Date(mtimeMs).toISOString(), startedAt: started.toISOString() };
    }
  }
  return null;
}

/**
 * The earliest instant this run could have read a measured file: the run-wide start the
 * reporter stamps in execution_details.runStartedAt when present (taken in onInit, before
 * vitest collects any module), else the row's started_at. Whichever readable value is earlier
 * wins, so a row that carries both is never judged against the later, post-collection one.
 * Null when neither is readable, which measuredFileModifiedAfterRun treats as "cannot judge".
 */
export function measurementLowerBound(
  startedAt: Date | string | null | undefined,
  executionDetailsRaw: unknown,
): Date | null {
  const candidates: Date[] = [];
  for (const value of [startedAt, executionDetails(executionDetailsRaw).runStartedAt]) {
    if (value == null) continue;
    if (!(value instanceof Date) && typeof value !== 'string') continue;
    const at = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(at.getTime())) candidates.push(at);
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, at) => (at.getTime() < earliest.getTime() ? at : earliest));
}

export interface TestRunBindingScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface TestRunBindingDeps {
  loadRun(scope: TestRunBindingScope, testRunId: number): Promise<TestRunEvidenceRow | null>;
  /** Conditionally stamp a still-unattributed run with the caller's scope; true when this call (or a racer) did. */
  adoptRun(scope: TestRunBindingScope, testRunId: number): Promise<boolean>;
  resolveRoot(scope: TestRunBindingScope): Promise<string>;
  git?: GitRunner;
}

export const defaultTestRunBindingDeps: TestRunBindingDeps = {
  async loadRun(scope, testRunId) {
    return withWorkspace(scope.workspaceId, async (tx) => {
      const rows = await tx<TestRunEvidenceRow[]>`
        SELECT id, file_path, status, source, harness_slug, workspace_id, commit_sha,
               worktree_dirty, execution_details, started_at, finished_at
          FROM harness_shared.test_runs
         WHERE id = ${testRunId}`;
      const row = rows[0];
      if (!row) return null;
      const recordedRoot = executionDetails(row.execution_details).root;
      return { ...row, root: typeof recordedRoot === 'string' ? recordedRoot : null };
    });
  },
  async adoptRun(scope, testRunId) {
    return withWorkspace(scope.workspaceId, async (tx) => {
      await tx`
        UPDATE harness_shared.test_runs
           SET harness_slug = ${scope.harnessSlug},
               workspace_id = ${scope.workspaceId}
         WHERE id = ${testRunId}
           AND harness_slug IS NULL
           AND (workspace_id IS NULL OR workspace_id = ${scope.workspaceId})
           AND source NOT IN ('ci', 'admin-ui')`;
      // Re-read rather than trust the row count: a racer that adopted the same row
      // into the SAME scope is a success, one that adopted it elsewhere is not.
      const rows = await tx<{ harness_slug: string | null; workspace_id: string | null }[]>`
        SELECT harness_slug, workspace_id FROM harness_shared.test_runs WHERE id = ${testRunId}`;
      return rows[0]?.harness_slug === scope.harnessSlug && rows[0]?.workspace_id === scope.workspaceId;
    });
  },
  async resolveRoot(scope) {
    const registry = await loadHarnessRegistry(scope.workspaceId);
    const root = resolveHarnessContentPath(registry, scope.harnessSlug);
    if (!root) throw new Error(`repo_measurement_harness_root_unavailable:${scope.harnessSlug}`);
    return root;
  },
};

/** Load, scope-check, adopt if unattributed, then derive. */
export async function expandTestRunBinding(
  input: TestRunBindingInput,
  scope: TestRunBindingScope,
  deps: TestRunBindingDeps = defaultTestRunBindingDeps,
): Promise<TestRunExpansion> {
  const testRunId = input.fromTestRun;
  const row = await deps.loadRun(scope, testRunId);
  if (!row) {
    return { ok: false, error: 'test_run_not_found', testRunId, message: `no test_runs row has id ${testRunId}.` };
  }
  if (row.workspace_id != null && row.workspace_id !== scope.workspaceId) {
    return {
      ok: false,
      error: 'test_run_out_of_scope',
      testRunId,
      message: `test-run ${testRunId} belongs to workspace '${row.workspace_id}', not '${scope.workspaceId}'.`,
    };
  }
  let attribution: HarnessAttribution = 'run';
  if (row.harness_slug == null) {
    if (NEVER_ADOPTED_SOURCES.has(String(row.source))) {
      return {
        ok: false,
        error: 'test_run_not_adoptable',
        testRunId,
        message:
          `test-run ${testRunId} is a ${row.source} row, harness-NULL by design; it is not re-attributed. ` +
          `Re-run the file with testing:run { harness: '${scope.harnessSlug}', files: ['${row.file_path}'] } and bind that run.`,
      };
    }
    if (!(await deps.adoptRun(scope, testRunId))) {
      return {
        ok: false,
        error: 'test_run_not_adoptable',
        testRunId,
        message: `test-run ${testRunId} was attributed elsewhere while this call tried to adopt it into '${scope.harnessSlug}'.`,
      };
    }
    attribution = 'adopted-caller-harness';
  } else if (row.harness_slug !== scope.harnessSlug) {
    return {
      ok: false,
      error: 'test_run_out_of_scope',
      testRunId,
      message: `test-run ${testRunId} ran under harness '${row.harness_slug}'; bind it with harness '${row.harness_slug}'.`,
    };
  }
  const root = await deps.resolveRoot(scope);
  let testPath = await recordedTestPath(root, row, deps.git);
  // WI-10004898: a clean run in a disposable clone (lint:as-committed) maps by commit content.
  let asCommitted: AsCommittedMapping | null = null;
  if (input.canonicalTestPath) {
    const recordedRelative = row.root && isAbsolute(row.root) && row.file_path
      ? repoRelativeTestPath(row.root, row.file_path)
      : null;
    const matchingSuffix = recordedRelative && (
      input.canonicalTestPath === recordedRelative || input.canonicalTestPath.endsWith(`/${recordedRelative}`)
    );
    // Copy-out mirrors are temporary and are intentionally not Git worktrees.
    // Only an explicitly named canonical test in the same harness can replace
    // their path; never use a caller-supplied path for another run source.
    if (row.source !== 'mutation-probe') {
      return {
        ok: false,
        error: 'test_run_canonical_path_source_unsupported',
        testRunId,
        message:
          `canonicalTestPath is only supported for mutation-probe copy-out runs; test-run ${testRunId} has source ${JSON.stringify(row.source)}. ` +
          'Omit canonicalTestPath to bind the recorded test file.',
      };
    }
    if (!matchingSuffix) {
      return {
        ok: false,
        error: 'test_run_canonical_path_mismatch',
        testRunId,
        message: recordedRelative
          ? `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} does not preserve mutation-probe run ${testRunId}'s recorded relative test path ${JSON.stringify(recordedRelative)}.`
          : `canonicalTestPath cannot be checked because mutation-probe run ${testRunId}'s file cannot be resolved relative to its recorded root.`,
      };
    }
    if (testPath && testPath !== input.canonicalTestPath) {
      return {
        ok: false,
        error: 'test_run_canonical_path_mismatch',
        testRunId,
        message:
          `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} differs from the recorded test path ${JSON.stringify(testPath)} in this harness checkout.`,
      };
    }
    try {
      readFileSync(resolve(root, input.canonicalTestPath));
      testPath = input.canonicalTestPath;
    } catch {
      return {
        ok: false,
        error: 'test_run_file_outside_root',
        testRunId,
        message: `canonicalTestPath ${JSON.stringify(input.canonicalTestPath)} is not a readable test in this harness checkout.`,
      };
    }
    // A CLEAN, commit-stamped copy-out row (its probe's origin root was an as-committed clone)
    // executed that commit's files, not this checkout's. Verify the measured files against the
    // commit exactly like a clone run, or the pin would fingerprint whatever the shared tree
    // holds at bind time (measured: a peer's later bulk-run-store.ts edit pinned onto a mutant
    // that mutated the committed blob). Dirty or commit-less rows keep the checkout pin.
    if (row.worktree_dirty === false && row.commit_sha && FULL_SHA_RE.test(row.commit_sha)) {
      asCommitted = {
        testPath: input.canonicalTestPath,
        repoPrefix: await canonicalAsCommittedPrefix(root, input.canonicalTestPath, row.commit_sha, deps.git),
        commitSha: row.commit_sha,
      };
    }
  }
  if (!testPath && !input.canonicalTestPath) {
    asCommitted = await asCommittedTestPath(root, row, deps.git);
    testPath = asCommitted?.testPath ?? null;
  }
  if (!testPath) {
    const cleanCommit = row.worktree_dirty === false && row.commit_sha ? row.commit_sha.slice(0, 12) : null;
    return {
      ok: false,
      error: 'test_run_file_outside_root',
      testRunId,
      message:
        `test-run ${testRunId} file ${JSON.stringify(row.file_path)} at recorded root ${JSON.stringify(row.root)} cannot be mapped to this harness checkout (${root}).` +
        (cleanCommit
          ? ` Its clean commit ${cleanCommit} does not contain that file in this repository or in a submodule named by the recorded root.`
          : ''),
    };
  }
  const result = deriveBindingFromTestRun(input, { ...row, file_path: testPath }, root, attribution);
  if (result.ok && asCommitted) {
    const { testPaths } = result.binding.measurement;
    const sourcePaths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, result.binding.measurement);
    const measured = [...new Set([...testPaths, ...sourcePaths])].sort();
    const content = await verifyAsCommittedContent(root, asCommitted, measured, deps.git ?? defaultGitRunner);
    if (!content.ok) {
      return {
        ok: false,
        error: 'test_run_as_committed_content_mismatch',
        testRunId,
        message:
          `test-run ${testRunId} ran clean at ${asCommitted.commitSha.slice(0, 12)} in a disposable clone, but ${content.path} ` +
          `${content.reason} in this checkout, so the binding's fingerprint would not describe the code that ran. ` +
          'Re-run the test as-committed at a commit this checkout matches and bind that run.',
      };
    }
  }
  if (result.ok && !asCommitted) {
    const { testPaths } = result.binding.measurement;
    const sourcePaths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, result.binding.measurement);
    const measured = [...new Set([...testPaths, ...sourcePaths])].sort();
    const changed = await measuredFileModifiedAfterRun(
      root,
      measured,
      measurementLowerBound(row.started_at, row.execution_details),
    );
    if (changed) {
      return {
        ok: false,
        error: 'test_run_source_modified_after_run',
        testRunId,
        message:
          `test-run ${testRunId} started at ${changed.startedAt}, but ${changed.path} was modified at ${changed.modifiedAt}, ` +
          'so the binding would fingerprint bytes this run may never have executed. Re-run the test and bind the new run.',
      };
    }
  }
  if (result.ok) {
    Object.assign(result.binding.details.testRun as Record<string, unknown>, {
      recordedRoot: row.root ?? null,
      recordedFilePath: row.file_path,
      ...(input.canonicalTestPath ? { canonicalTestPathOverride: input.canonicalTestPath } : {}),
      ...(asCommitted
        ? { asCommitted: { commitSha: asCommitted.commitSha, repoPrefix: asCommitted.repoPrefix, contentVerified: true } }
        : {}),
    });
  }
  return result;
}
