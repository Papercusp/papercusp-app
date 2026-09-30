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
import { z } from 'zod';
import { recordedTestLayer, type RecordedTestLayer } from '@papercusp/test-config/execution-details';
import { withWorkspace } from '@papercusp/db-org';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { resolveRelative, runtimeSpecifiers, stripComments } from '../../search/import-graph';
import { repoFilesEvidenceMeasurementSchema } from './spec-evidence-store';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';

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
  | 'source_paths_underivable'
  | 'run_contradicts_declared_adequacy';

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
    measurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths, testPaths: [testPath] },
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
               worktree_dirty, execution_details, finished_at
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
    if (row.source !== 'mutation-probe' || !matchingSuffix || (testPath && testPath !== input.canonicalTestPath)) {
      return {
        ok: false,
        error: 'test_run_file_outside_root',
        testRunId,
        message: `canonicalTestPath does not match mutation-probe run ${testRunId}'s recorded test path.`,
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
  }
  if (!testPath) {
    return {
      ok: false,
      error: 'test_run_file_outside_root',
      testRunId,
      message: `test-run ${testRunId} file ${JSON.stringify(row.file_path)} at recorded root ${JSON.stringify(row.root)} cannot be mapped to this harness checkout (${root}).`,
    };
  }
  const result = deriveBindingFromTestRun(input, { ...row, file_path: testPath }, root, attribution);
  if (result.ok) {
    Object.assign(result.binding.details.testRun as Record<string, unknown>, {
      recordedRoot: row.root ?? null,
      recordedFilePath: row.file_path,
      ...(input.canonicalTestPath ? { canonicalTestPathOverride: input.canonicalTestPath } : {}),
    });
  }
  return result;
}
