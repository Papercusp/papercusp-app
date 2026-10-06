/**
 * rubrics-criterion-checks — the STRUCTURED CRITERION CHECK enforcement
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-011, owner-ratified D-006).
 *
 * A rubric criterion may carry an optional structured `check`:
 *   - kind:'tests' { files } — a DETERMINISTIC must-pass binding. Two enforcement
 *     points, both here:
 *       PROPOSE time — every named file must RESOLVE against the live tree AND be
 *       RUNNABLE by the router grading will use (WI-369566: resolving is not runnable,
 *       and a resolving-but-unroutable path made rubrics permanently ungradeable), or
 *       the propose is REFUSED (unlike the advisory replicationSqlCheck, whose subject is
 *       external moving-target DB state, a file path is fully in-our-control: a check
 *       that can never run is a booby trap, not advice — the same posture as the
 *       plan-audit citation resolver and the acceptance-kind link guards).
 *       GRADING time — scorecards:emit actually RUNS the files via the testing:run
 *       core (never stale ledger rows), REFUSES a path that no longer resolves rather
 *       than silently passing, and REFUSES a rating the run contradicts (a 'healthy'
 *       rating over a failing must-pass suite is a wrong scorecard, not a note).
 *   - kind:'instrument' — the generalized instrument binding. THIS MODULE EXECUTES
 *     NOTHING FOR IT, and — unlike every arm above — nothing else does either. It is
 *     the one arm where the platform does not measure (EI-20270994401737114).
 *     The scorecard instrument contract does constrain it, but read what that
 *     constraint IS before relying on it: `instrumentSnapshots` is caller-supplied on
 *     both scorecard verbs, so the contract compares the grader's rating against the
 *     grader's OWN snapshot. That is internal consistency, not measurement — a grader
 *     who derives the wrong number rates 'fail' beside a 'fail' snapshot and passes
 *     cleanly (the retracted grade in EI-20266169712430445). `evaluateScorecardInstrumentContract`
 *     reports these keys as `selfReportedInstruments` so the gap is visible rather
 *     than inferred; closing it needs a computed instrument, which does not exist yet.
 *   - absent — a fuzzy judgment criterion; this module ignores it entirely.
 *
 * Fuzzy + deterministic criteria coexist in one rubric.
 */

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import {
  checkoutRootForPath,
  normalizeTestFilePaths,
  runTestFilesCore,
  type TestFilesCoreResult,
} from './agent-tools/testing/run';
import { findHarnessTestRunIds } from './testing-run-store';
import { selectUnambiguousEvidenceRoot } from './evidence-root-selection';
import { rubricCriterionCheckSchema, type RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import type { ActivationAuditMapping, EffectiveItemAudit, PlanItemStatus } from './plan-audits';
import {
  describeUnrealized,
  judgeRequirementRealization,
  REALIZING_DISPOSITIONS,
  type NonCodeItemProof,
} from './plan-requirement-realization';
import type {
  ScorecardCheckRun,
  ScorecardCoverageCheckRun,
  ScorecardProbeCheckRun,
  ScorecardSingleProbeCheckRun,
  ScorecardRequirementsCheckRun,
} from './harness/improvements/observation-types';
import { managedSpawn } from './task-manager/managed-spawn';
import { CONTINUITY_PROBE_MAX_PER_WAKE, continuityProbeSchema, runContinuityProbeBatch, type ContinuityProbe } from './continuity-probes';

/** The minimal criterion shape this module reads — key + the optional check. */
export interface CheckedCriterion {
  key: string;
  check?: RubricCriterionCheck;
}

/** Pin every ALL child before rubric hashing/persistence. Legacy single probes keep their existing writer contract. */
export function normalizeCriterionProbeChecks<T extends CheckedCriterion>(criteria: readonly T[]): T[] {
  return criteria.map(c => {
    if (c.check?.kind !== 'probe' || c.check.all === undefined) return c;
    rubricCriterionCheckSchema.parse(c.check);
    return { ...c, check: { kind: 'probe' as const, all: c.check.all.map(probe => continuityProbeSchema.parse(probe)) } };
  });
}

export interface CriterionCheckPathFailure {
  criterionKey: string;
  path: string;
  reason: string;
  /** Present for native checks so the refusal can name the affected runner. */
  checkKind?: 'cargo';
}

export interface NormalizedCargoCheckPaths {
  manifestPath: string;
  sourceFiles: string[];
}

export interface CriterionCheckPathValidation {
  ok: boolean;
  /** The tree the paths were resolved against — echoed so a wrong-tree validation is
   *  visible instead of silent (the WI-7189 lesson, inherited from testing:run). */
  root: string;
  /** tests-check files examined across all criteria (0 ⇒ no criterion carries one). */
  checked: number;
  failures: CriterionCheckPathFailure[];
  /**
   * STRUCTURAL faults in kind:'coverage' scopes, found without touching the database.
   *
   * ⚠ Deliberately NOT the coverage analog of the tests arm's existsSync: "does this
   * scope match any surface" is a census QUERY, and the census legitimately moves
   * between propose and grade (a surface censused today may be retired tomorrow), so a
   * propose-time DB answer would be stale precisely when it mattered and would make
   * this pure function async for every caller. The vacuity refusal that actually
   * protects the gate — a scope resolving to ZERO surfaces — is enforced at GRADING
   * time in {@link evaluateCriterionCoverageChecks}, where it is measured fresh. What
   * IS caught here is the fault no query can fix: a scope that contradicts itself.
   */
  scopeFailures: CriterionCheckPathFailure[];
  /** Criterion key → its files NORMALIZED to repo-root-relative form (workspace-relative
   *  spellings expanded). Present for every tests-check criterion that validated clean —
   *  callers should persist THESE so grading-time resolution is deterministic. */
  normalizedByKey: Record<string, string[]>;
  /** Criterion key → its Cargo manifest and explicit source attribution, normalized to
   *  repo-root-relative form. */
  normalizedCargoByKey: Record<string, NormalizedCargoCheckPaths>;
  /**
   * EI-24372605712471072: check paths accepted as PLANNED — not in the tree yet, admitted
   * only because the caller passed `allowPlannedPaths`. Always present (empty when the
   * allowance is off). Grading re-validates without the allowance, so a planned file that
   * never gets written still refuses the emit (`check_path_unresolved`).
   */
  planned: CriterionCheckPathFailure[];
}

/**
 * EI-24372605712471072 — the subject-plan statuses whose implementation has NOT begun.
 *
 * An acceptance BAR names its proof: the test file that will show the requirement holds.
 * Before the plan starts, that file does not exist yet — it is written by the plan's own
 * items. The activation seed never asserted check paths, but every amendment re-asserted
 * them over the full criterion set, so an honest pre-start BAR (one naming its real,
 * future test file) was refused and the author was pushed toward a weaker manual check.
 * The two gates disagreed about the same criteria.
 *
 * On these statuses a rubric amendment treats a missing path as planned. Once the plan
 * starts (active, awaiting-acceptance, shipped, …) every amendment is strict again, and
 * grading is always strict.
 */
export const PLANNED_PATH_SUBJECT_PLAN_STATUSES: ReadonlySet<string> = new Set(['draft', 'ready']);

/** True when a rubric write against a subject plan in `status` may accept planned paths. */
export function subjectPlanAllowsPlannedPaths(status: string | null | undefined): boolean {
  return typeof status === 'string' && PLANNED_PATH_SUBJECT_PLAN_STATUSES.has(status);
}

export interface CriterionCheckPathOptions {
  root?: string;
  /**
   * Accept a relative check path that does not exist yet as planned instead of refusing
   * it. Only a rubric write against an un-started subject plan may pass this (see
   * {@link subjectPlanAllowsPlannedPaths}); grading never does. Absolute paths, ambiguous
   * workspace-relative spellings, and non-test filenames are still refused.
   */
  allowPlannedPaths?: boolean;
}

/**
 * WI-369566 — RESOLVING IS NOT RUNNABLE. Path existence was the whole propose-time rule,
 * so a criterion could bind a file that resolves and that the test router will never
 * report on. Grading then refuses it (`check_file_not_run`, below) — and because emit's
 * completeness rule requires EVERY criterion to be rated, no rating value skips the
 * check, so the rubric is PERMANENTLY ungradeable and its plan can never reach
 * status:shipped. Measured instance: a criterion naming `scripts/verify-…-rail.sh`;
 * the router answered TEST_FILE_UNSUPPORTED_INPUT (⚠ NON_TEST … skipped) and then
 * TEST_FILE_ROUTE_ERROR requested=1 matched=0, and only the GRADER discovered it, at
 * ship time. This moves that cost to the author, at authoring time.
 *
 * WHAT IS CHECKED — the FILENAME SHAPE, which is the leg that catches the measured class.
 * MEASURED: `scripts/test-files.mjs` filters a non-test input out before route discovery
 * (`isTestFilePath`, and the NON_TEST refusal above). REASONED, not measured: the external
 * checkout path `runTestFilesCore` falls back to for a managed Hive runs Vitest against the
 * named files, whose include contract is `*.{test,spec}.?(c|m)[jt]s?(x)`, so a differently
 * named file is selected by neither path — if that ever stops holding, the pin below is
 * where the disagreement should surface first.
 *
 * WHAT IS NOT, and why — ROUTE OWNERSHIP ("does a Vitest config own this path"). The
 * router owns that answer (`discoverTestRoute`) and this module must not IMPORT it:
 * `scripts/test-files.mjs` is a test-runner CLI that the operator host deliberately
 * SPAWNS (see `runTestFilesCore`) and never bundles, and `test-executor-runnability.ts`
 * — the one module that does import it — is reached only from the `lint:tests` script,
 * never from the host. Importing it here would drag that CLI and its process/watchdog
 * dependencies into the server bundle to catch a strictly rarer fault that `lint:tests`
 * already owns from both sides (`findOrphanTests` for a test matching no registry glob,
 * `findUnrunnableRegistryTests` for a registry-visible test no runner executes).
 * Grading stays the authority for that last mile.
 *
 * DERIVED-TRUTH RUNG 2 (PIN, not copy): the pattern below is a second statement of the
 * router's `isTestFilePath`, so it is pinned by a divergence test that imports BOTH and
 * asserts they agree over a corpus (rubrics-criterion-checks.test.ts). A test may import
 * the .mjs freely — it costs the host bundle nothing — so the check lives there and this
 * regex cannot silently drift from the router's.
 */
const ROUTER_TEST_FILE_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** @returns a teaching reason when the path can never be RUN, else null. */
function describeUnroutableTestPath(file: string): string | null {
  if (ROUTER_TEST_FILE_SUFFIX_RE.test(file.replaceAll('\\', '/'))) return null;
  return (
    'resolves, but is not a test file — the router skips a non-test input as NON_TEST ' +
    '(TEST_FILE_UNSUPPORTED_INPUT) and reports on nothing, so scorecards:emit could never ' +
    'grade this criterion and the rubric would be permanently ungradeable. Name the ' +
    'importing *.test.* / *.spec.* file, or drop the check to leave the criterion fuzzy ' +
    '(the right answer when its method is a human-run procedure)'
  );
}

const PLAYWRIGHT_IMPORT_RE = /(?:from\s*|require\(\s*|import\(\s*)['"]@playwright\/test['"]/;

/**
 * WI-10004678 — a Playwright spec has the right FILENAME (`*.spec.ts`), so the shape rule
 * above admits it, but scorecards:emit runs check files through the Vitest router, and
 * Vitest cannot run a Playwright spec: its `test` comes from `@playwright/test`, which
 * throws outside the Playwright runner. The criterion would then be permanently
 * ungradeable, the same failure WI-369566 moved to authoring time. Detected by the import
 * itself, which is what makes it a Playwright spec wherever it lives.
 *
 * @returns a teaching reason when the file imports `@playwright/test`, else null.
 */
function describePlaywrightSpec(absPath: string): string | null {
  let head: string;
  try {
    head = readFileSync(absPath, 'utf8').slice(0, 64 * 1024);
  } catch {
    return null; // unreadable: the resolve check above owns that answer
  }
  if (!PLAYWRIGHT_IMPORT_RE.test(head)) return null;
  return (
    'is a Playwright spec (imports @playwright/test) — scorecards:emit runs kind:"tests" ' +
    'files through the Vitest router, which cannot run it, so this criterion could never be ' +
    'graded. Cite the Playwright run as recorded evidence in the criterion method (leave the ' +
    'check off), or name a Vitest *.test.ts file that covers the same behaviour'
  );
}

/**
 * PROPOSE-time validation: every kind:'tests' check file and every kind:'cargo' manifest
 * or source attribution must resolve against the live tree. Tests files must also be
 * runnable by the Vitest router grading will use (see {@link describeUnroutableTestPath}).
 * Absolute paths are refused outright — a stored absolute path is machine-specific and
 * escapes the tree the check claims to be about; repo-root-relative (or unambiguous
 * workspace-relative, which is normalized) is the portable contract.
 */
export function validateCriterionCheckPaths(
  criteria: ReadonlyArray<CheckedCriterion>,
  opts: CriterionCheckPathOptions = {},
): CriterionCheckPathValidation {
  const root = opts.root ?? resolveAgentWorkspaceRoot({});
  const failures: CriterionCheckPathFailure[] = [];
  const scopeFailures: CriterionCheckPathFailure[] = [];
  const planned: CriterionCheckPathFailure[] = [];
  const normalizedByKey: Record<string, string[]> = {};
  const normalizedCargoByKey: Record<string, NormalizedCargoCheckPaths> = {};
  let checked = 0;
  const probeCount = criteria.reduce((n, c) => n + (c.check?.kind === 'probe' ? (c.check.all?.length ?? 1) : 0), 0);
  if (probeCount > CONTINUITY_PROBE_MAX_PER_WAKE) {
    scopeFailures.push({ criterionKey: '(probe batch)', path: 'all', reason: `${probeCount} probes exceed the execution cap of ${CONTINUITY_PROBE_MAX_PER_WAKE}` });
  }
  for (const c of criteria) {
    if (c.check?.kind === 'probe' && c.check.all !== undefined) {
      const shape = rubricCriterionCheckSchema.safeParse(c.check);
      if (!shape.success) {
        scopeFailures.push({ criterionKey: c.key, path: 'probe', reason: shape.error.message });
        continue;
      }
      for (const [index, probe] of (c.check.all ?? [c.check.probe]).entries()) {
        const parsed = continuityProbeSchema.safeParse(probe);
        if (!parsed.success) scopeFailures.push({ criterionKey: c.key, path: `probe[${index}]`, reason: parsed.error.message });
      }
      continue;
    }
    if (c.check?.kind === 'coverage') {
      // A scope naming BOTH an explicit file list and planTouched is contradictory:
      // planTouched RESOLVES to a file list at grading time, so the two would silently
      // race and whichever won would be invisible in the record. Refuse rather than pick.
      if (c.check.scope.planTouched === true && (c.check.scope.sourceFiles?.length ?? 0) > 0) {
        scopeFailures.push({
          criterionKey: c.key,
          path: 'scope',
          reason:
            'scope names both planTouched and an explicit sourceFiles list — planTouched IS the ' +
            'file list, resolved from the subject plan at grading time. Pick one.',
        });
      }
      continue;
    }
    if (c.check?.kind === 'cargo') {
      const rawPaths = [c.check.manifestPath, ...c.check.sourceFiles];
      const absoluteIndexes = rawPaths.flatMap((path, index) => (isAbsolute(path) ? [index] : []));
      checked += rawPaths.length;
      for (const index of absoluteIndexes) {
        failures.push({
          criterionKey: c.key,
          path: rawPaths[index]!,
          reason: 'absolute paths are machine-specific — name the path repo-root-relative',
          checkKind: 'cargo',
        });
      }
      const relativePaths = rawPaths.filter((path) => !isAbsolute(path));
      if (relativePaths.length === 0) continue;
      const resolution = normalizeTestFilePaths([...relativePaths], root);
      if (!resolution.ok) {
        failures.push({
          criterionKey: c.key,
          path: resolution.path,
          reason: resolution.reason ?? `ambiguous workspace-relative path — exists in multiple workspaces (${resolution.matches.join(', ')}); use the repo-root-relative form`,
          checkKind: 'cargo',
        });
        continue;
      }
      const normalizedRelative = resolution.files;
      let relativeIndex = 0;
      const normalizedPaths = rawPaths.map((path) =>
        isAbsolute(path) ? path : normalizedRelative[relativeIndex++]!,
      );
      let valid = absoluteIndexes.length === 0;
      for (const path of normalizedPaths) {
        if (isAbsolute(path)) continue;
        const candidate = resolve(root, path);
        const isFile = isRegularFileInsideRoot(root, candidate);
        if (!isFile) {
          const miss: CriterionCheckPathFailure = {
            criterionKey: c.key,
            path,
            reason: 'does not resolve to a regular file in the live tree',
            checkKind: 'cargo',
          };
          // A path that exists but is not a regular file (a directory) is wrong now and
          // stays wrong; only a path that is absent entirely can be planned.
          if (opts.allowPlannedPaths && !existsSync(candidate) && isPlannedPathInsideRoot(root, candidate)) {
            planned.push(miss);
          } else {
            valid = false;
            failures.push(miss);
          }
        }
      }
      if (valid) {
        normalizedCargoByKey[c.key] = {
          manifestPath: normalizedPaths[0]!,
          sourceFiles: normalizedPaths.slice(1),
        };
      }
      continue;
    }
    if (c.check?.kind !== 'tests') continue;
    const absolutes = c.check.files.filter((f) => isAbsolute(f));
    for (const f of absolutes) {
      checked++;
      failures.push({
        criterionKey: c.key,
        path: f,
        reason: 'absolute paths are machine-specific — name the file repo-root-relative',
      });
    }
    const relative = c.check.files.filter((f) => !isAbsolute(f));
    if (relative.length === 0) continue;
    const resolution = normalizeTestFilePaths([...relative], root);
    if (!resolution.ok) {
      checked += relative.length;
      failures.push({
        criterionKey: c.key,
        path: resolution.path,
        reason: resolution.reason ?? `ambiguous workspace-relative path — exists in multiple workspaces (${resolution.matches.join(', ')}); use the repo-root-relative form`,
      });
      continue;
    }
    const normalized: string[] = [];
    for (const f of resolution.files) {
      checked++;
      // normalizeTestFilePaths may promote a workspace-relative sibling spelling
      // (`portal/tests/foo.test.ts`) to an absolute path in the admitted sibling
      // checkout.  That path is intentionally outside the ambient root; validate
      // it against its own workspace checkout so the check remains portable while
      // runTestFilesCore can select the sibling's router at grading time.
      const candidate = isAbsolute(f) ? resolve(f) : resolve(root, f);
      const externalCheckout = isAbsolute(f) ? checkoutRootForPath(candidate) : undefined;
      const resolves = externalCheckout
        ? existsSync(candidate) && statSync(candidate).isFile()
        : isRegularFileInsideRoot(root, candidate);
      // Planned: absent entirely (not a directory), inside the tree, and relative.
      const plannable =
        !resolves && opts.allowPlannedPaths === true && !isAbsolute(f) &&
        !existsSync(candidate) && isPlannedPathInsideRoot(root, candidate);
      if (!resolves && !plannable) {
        failures.push({ criterionKey: c.key, path: f, reason: 'does not resolve against the live tree' });
        continue;
      }
      // The filename-shape rule applies to a planned file too: a future file the router
      // would skip as NON_TEST is as ungradeable as an existing one.
      const unroutable = describeUnroutableTestPath(f);
      if (unroutable) {
        failures.push({ criterionKey: c.key, path: f, reason: unroutable });
        continue;
      }
      const playwright = resolves ? describePlaywrightSpec(candidate) : null;
      if (playwright) {
        failures.push({ criterionKey: c.key, path: f, reason: playwright });
        continue;
      }
      if (plannable) {
        planned.push({
          criterionKey: c.key,
          path: f,
          reason: 'not in the tree yet — accepted as planned; grading refuses it until the file exists',
        });
      }
      normalized.push(f);
    }
    if (normalized.length === relative.length && absolutes.length === 0) {
      normalizedByKey[c.key] = normalized;
    }
  }
  return {
    ok: failures.length === 0 && scopeFailures.length === 0,
    root,
    checked,
    failures,
    scopeFailures,
    normalizedByKey,
    normalizedCargoByKey,
    planned,
  };
}

/** Where a selected check-validation root came from — echoed on results so a
 *  canonical-repo validation is visible, never silent (the WI-7189 lesson). */
export type CriterionCheckRootSource = 'requested' | 'canonical-repo';

export interface SelectedCriterionCheckRoot {
  root: string;
  source: CriterionCheckRootSource;
  /** The validation computed against the SELECTED root — callers use this instead of
   *  re-running, so selection and enforcement can never disagree. */
  validation: CriterionCheckPathValidation;
}

/**
 * WI-41394 — the WI-41365 phantom-root class, this validator's own rung. A hive-scoped
 * session resolves its workspace root from a stale registry entry (e.g. /tmp/devboard),
 * a tree that does not exist — so every tests-check path was refused for a reason that
 * had nothing to do with the paths, and a hive-commissioned rubric whose evidence lives
 * in the canonical repo could not carry a structured check at all.
 *
 * Precedence mirrors selectHarnessCitationRepoRoot (plan-audits.ts): the REQUESTED root
 * stays authoritative whenever every tests-check path resolves there; the canonical repo
 * is accepted only when it resolves them ALL; otherwise the requested root is kept, so
 * failures report against the tree the agent claims to edit rather than a tree that
 * happens to be missing different files. Scope faults are root-independent and play no
 * part in selection.
 */
export function selectCriterionCheckRoot(
  criteria: ReadonlyArray<CheckedCriterion>,
  requested: string,
  canonicalRepoRoot: string = REPO_ROOT,
  opts: Pick<CriterionCheckPathOptions, 'allowPlannedPaths'> = {},
): SelectedCriterionCheckRoot {
  const validations = new Map<string, CriterionCheckPathValidation>();
  const validationFor = (root: string): CriterionCheckPathValidation => {
    const key = resolve(root);
    const cached = validations.get(key);
    if (cached) return cached;
    const validation = validateCriterionCheckPaths(criteria, { root });
    validations.set(key, validation);
    return validation;
  };
  const selected = selectUnambiguousEvidenceRoot<CriterionCheckRootSource>({
    preferred: { root: requested, source: 'requested' },
    fallback: { root: canonicalRepoRoot, source: 'canonical-repo' },
    // Scope faults are root-independent and deliberately do not choose a tree.
    resolvesEvery: (root) => validationFor(root).failures.length === 0,
  }) ?? { root: requested, source: 'requested' as const };
  // The tree is chosen by the STRICT validation, so the allowance can never pick a tree
  // where existing files look "planned". It only changes how the chosen tree is judged.
  const validation = opts.allowPlannedPaths
    ? validateCriterionCheckPaths(criteria, { root: selected.root, allowPlannedPaths: true })
    : validationFor(selected.root);
  return { ...selected, validation };
}

/**
 * The refusing form, called from the proposeRubric LIB write path (like the WI-4287
 * loss-guards, so every caller inherits it). `invalid_args:` prefix per EI-10148 —
 * this is a CALLER error, never a structural tool bug. Root selection runs first
 * (WI-41394): a requested root that cannot resolve the paths falls back to the
 * canonical repo when — and only when — every path resolves there.
 */
export function assertCriterionCheckPathsResolve(
  criteria: ReadonlyArray<CheckedCriterion>,
  opts: CriterionCheckPathOptions = {},
): CriterionCheckPathValidation {
  const requested = opts.root ?? resolveAgentWorkspaceRoot({});
  const v = selectCriterionCheckRoot(criteria, requested, REPO_ROOT, {
    allowPlannedPaths: opts.allowPlannedPaths === true,
  }).validation;
  if (v.ok) return v;
  const parts: string[] = [];
  if (v.failures.length > 0) {
    const testsFailures = v.failures.filter((f) => f.checkKind !== 'cargo');
    const cargoFailures = v.failures.filter((f) => f.checkKind === 'cargo');
    if (testsFailures.length > 0) {
      parts.push(
        `structured tests-check paths must resolve against the live tree AND be runnable by ` +
          `the test router that grading will use ` +
          `(P-011 / D-006 — a check that can never run is a booby trap, not advice). Against root '${v.root}':\n` +
          testsFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
          `\nFix the path(s) (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
      );
    }
    if (cargoFailures.length > 0) {
      parts.push(
        `structured cargo-check manifest/source paths must resolve against the live tree ` +
          `(P-011 / D-006 — a check that cannot run is a booby trap, not advice). Against root '${v.root}':\n` +
          cargoFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
          `\nFix the Cargo paths (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
      );
    }
  }
  if (v.scopeFailures.length > 0) {
    parts.push(
        `structured coverage scopes and probe checks must be executable:\n` +
        v.scopeFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.reason}`).join('\n'),
    );
  }
  throw new Error(`invalid_args: proposeRubric: ${parts.join('\n\n')}`);
}

/** One criterion's grading-time check run — the persisted shape is the ledger's
 *  {@link ScorecardCheckRun} (observation-types.ts), stamped onto the scorecard as
 *  `checkRuns[criterionKey]` so a rating the run contradicts is machine-detectable
 *  from the record itself (D-006). */
export type CriterionCheckRun = ScorecardCheckRun;
/** The probe-specific persisted run record, re-exported for evaluator callers. */
export type ProbeCheckRun = ScorecardProbeCheckRun;

/** Bounded testing-router evidence carried through an unjudgeable scorecard check. */
export interface CriterionCheckRunnerFailure {
  runId: string;
  root: string;
  error: NonNullable<TestFilesCoreResult['error']>;
  hint?: string;
  routerOutput?: string;
  detachedRunId?: string;
  detachedDurable?: boolean;
}

export type CriterionCheckRefusal =
  | {
      ok: false;
      error: 'probe_invalid';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'probe_run_failed';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'probe_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: ProbeCheckRun;
    }
  | {
      ok: false;
      error: 'check_path_unresolved';
      criterionKey: string;
      paths: string[];
      detail: string;
    }
  | {
      ok: false;
      error: 'check_run_failed';
      criterionKey: string;
      detail: string;
      runner?: CriterionCheckRunnerFailure;
    }
  | {
      ok: false;
      error: 'check_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: CriterionCheckRun;
    };

export type CriterionCoverageRefusal =
  | {
      ok: false;
      error: 'coverage_scope_empty';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'coverage_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: CoverageCheckRun;
    };

export type CriterionRequirementsRefusal =
  | {
      ok: false;
      error: 'requirements_no_plan_subject';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'requirements_scope_empty';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'requirements_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: RequirementsCheckRun;
    };

export type CriterionCheckEvaluation =
  | { ok: true; checkRuns: Record<string, CriterionCheckRun> }
  | CriterionCheckRefusal
  | CriterionCoverageRefusal
  | CriterionRequirementsRefusal;

/** The scorecard runner may add the exact scoped ledger rows produced by the run. */
export type CriterionCheckRunnerResult = TestFilesCoreResult & {
  testRunIds?: number[];
};

/** Injectable runner seam (tests stub this; production shells the real router). */
export type CriterionCheckRunner = (opts: {
  files: string[];
  root: string;
  timeoutMs?: number;
  workspaceId?: string;
  harnessSlug?: string;
  runId?: string;
}) => Promise<CriterionCheckRunnerResult>;

/** The normal scorecard test route, also used by restart recovery for a fresh attempt. */
export async function runCriterionCheckFiles(opts: Parameters<CriterionCheckRunner>[0]): Promise<CriterionCheckRunnerResult> {
  const result = await runTestFilesCore(opts);
  if (
    result.error !== undefined ||
    typeof opts.workspaceId !== 'string' ||
    opts.workspaceId.trim() === '' ||
    opts.workspaceId === '*' ||
    typeof opts.harnessSlug !== 'string' ||
    opts.harnessSlug.trim() === '' ||
    opts.harnessSlug === '*'
  ) {
    return result;
  }
  return {
    ...result,
    testRunIds: await findHarnessTestRunIds({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      runGroupId: result.runId,
    }),
  };
}

/** Injectable direct-dispatch seam for rubric ContinuityProbe checks. */
export type CriterionProbeDispatcher = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Per-probe budget for GRADING-time criterion probes. Grading is deliberate and
 * fail-closed, so the budget is sized to the slowest probe-able read's measured
 * tail rather than to the wake path's 2.5s critical-path budget. Measured over
 * 24h of tool_invocations (2026-10-01): dev:pipeline_position p95 28s / p99 58s,
 * state:read p99 22s. The 2.5s wake budget sat below dev:pipeline_position's
 * p50, so most emits on such a criterion were refused unjudgeable
 * (EI-24809550207915153). Still a small fraction of SCORECARD_TEST_CHECK_TIMEOUT_MS.
 */
export const CRITERION_PROBE_TIMEOUT_MS = 60_000;

/**
 * GRADING-time evaluation for kind:'probe' checks. Rubrics deliberately keep
 * `check.probe` dependency-light (`unknown`) so the template does not import
 * the continuity subsystem; this evaluator is the semantic boundary that
 * parses the typed probe, executes it through the existing batch runner, and
 * refuses any result that cannot be attributed to exactly one criterion.
 *
 * A probe status of `fresh` is a pass and `stale` is a fail. `error`,
 * `unknown`, missing, and truncated results are all unjudgeable and refuse
 * the emit. This is fail-closed: a criterion cannot silently fall back to
 * grader prose when its machine check was declared.
 */
export async function evaluateCriterionProbeChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  dispatchTool?: CriterionProbeDispatcher;
  nowIso?: () => string;
  /** Per-probe dispatch budget; defaults to CRITERION_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
}): Promise<CriterionCheckEvaluation> {
  const planned: Array<{ key: string; childIndex: number; grouped: boolean; probe: ContinuityProbe }> = [];
  for (const c of input.criteria) {
    if (c.check?.kind !== 'probe' || input.ratings[c.key] === undefined) continue;
    const shape = rubricCriterionCheckSchema.safeParse(c.check);
    if (!shape.success) return { ok: false, error: 'probe_invalid', criterionKey: c.key, detail: shape.error.message };
    for (const [childIndex, probe] of (c.check.all ?? [c.check.probe]).entries()) {
      const parsed = continuityProbeSchema.safeParse(probe);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || '(probe)'}: ${issue.message}`)
          .join('; ');
        return {
          ok: false,
          error: 'probe_invalid',
          criterionKey: c.key,
          detail:
            `criterion '${c.key}' carries a probe that is not executable against the current ` +
            `read-only platform contract${detail ? ` (${detail})` : ''}. Fix the probe binding or ` +
            'remove the check to leave the criterion fuzzy.',
        };
      }
      planned.push({ key: c.key, childIndex, grouped: c.check.all !== undefined, probe: parsed.data });
    }
  }
  if (planned.length === 0) return { ok: true, checkRuns: {} };
  if (planned.length > CONTINUITY_PROBE_MAX_PER_WAKE) return {
    ok: false, error: 'probe_invalid', criterionKey: planned[0]!.key,
    detail: `${planned.length} declared probes exceed execution cap ${CONTINUITY_PROBE_MAX_PER_WAKE}; no probe was dispatched`,
  };
  if (!input.dispatchTool) {
    return {
      ok: false,
      error: 'probe_run_failed',
      criterionKey: planned[0]!.key,
      detail:
        `criterion '${planned[0]!.key}' carries a probe check, but the internal read-only ` +
        'dispatcher is unavailable; refusing an unexecuted machine-check rather than grading it from prose.',
    };
  }

  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const sources = planned.map((item, checkIndex) => ({
    source: { kind: 'work-item' as const, id: `scorecard-probe:${item.key}` },
    checkIndex,
    check: {
      id: `${item.key}:${item.childIndex}`,
      claim: `scorecard criterion '${item.key}' probe ${item.childIndex}`,
      probe: item.probe,
    },
  }));
  const batch = await runContinuityProbeBatch(sources, {
    dispatchTool: input.dispatchTool,
    timeoutMs: input.probeTimeoutMs ?? CRITERION_PROBE_TIMEOUT_MS,
  });
  if (batch.truncated > 0 || batch.results.length !== planned.length) {
    return {
      ok: false,
      error: 'probe_run_failed',
      criterionKey:
        planned[Math.min(batch.results.length, planned.length - 1)]?.key ?? planned[0]!.key,
      detail:
        `the probe-check batch could not execute one result per declared criterion ` +
        `(${planned.length} declared, ${batch.results.length} returned, ${batch.truncated} truncated). ` +
        'A capped or partially executed probe set is unjudgeable, so scorecards:emit refuses rather ' +
        'than silently accepting a criterion without distinct platform evidence.',
    };
  }

  const checkRuns: Record<string, CriterionCheckRun> = {};
  const records = new Map<string, ScorecardSingleProbeCheckRun[]>();
  for (const [index, item] of planned.entries()) {
    const result = batch.results.find((candidate) => candidate.checkIndex === index);
    if (!result || !result.executed || (result.status !== 'fresh' && result.status !== 'stale')) {
      const diagnostic = result?.diagnostic;
      return {
        ok: false,
        error: 'probe_run_failed',
        criterionKey: item.key,
        detail:
          `criterion '${item.key}' probe was not judgeable ` +
          `(${diagnostic?.code ?? result?.status ?? 'missing result'}${diagnostic?.message ? `: ${diagnostic.message}` : ''}). ` +
          'Probe checks fail closed: repair the live typed probe/dispatcher and re-emit.',
      };
    }
    const record: ScorecardSingleProbeCheckRun = {
      kind: 'probe',
      probe: item.probe,
      verdict: result.status === 'fresh' ? 'pass' : 'fail',
      status: result.status,
      executed: true,
      ...(result.observed !== undefined ? { observed: result.observed as string | number | boolean | null } : {}),
      measuredAt: nowIso(),
    };
    records.set(item.key, [...(records.get(item.key) ?? []), record]);
  }
  for (const [key, children] of records) {
    const grouped = planned.find(item => item.key === key)!.grouped;
    const pass = children.every(child => child.verdict === 'pass');
    const record: ProbeCheckRun = grouped ? {
      kind: 'probe', all: children, verdict: pass ? 'pass' : 'fail', status: pass ? 'fresh' : 'stale',
      executed: true, measuredAt: nowIso(),
    } : children[0]!;
    const rating = input.ratings[key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'probe_contradicted',
        criterionKey: key,
        rating,
        run: record,
        detail:
          `criterion '${key}' is rated '${rating}' but at least one platform probe predicate was ` +
          'stale (the observed value did not match the declared expectation). A live probe outranks ' +
          'grader prose — fix the signal or rate the criterion honestly.',
      };
    }
    checkRuns[key] = record;
  }
  return { ok: true, checkRuns };
}

/** Distilled result of one native Cargo invocation. Cargo's stable runner reports
 * test names and counts at crate/binary scope, not the source file containing each
 * inline `#[test]`; source attribution is therefore supplied by the criterion and
 * preserved on the resulting scorecard check run. */
export interface CriterionCargoRunResult {
  passed: number;
  failed: number;
  ignored: number;
  runId: string | null;
  durationMs: number | null;
  failures?: string[];
  /** A typed refusal means no trustworthy crate verdict exists. */
  error?: string;
  output?: string;
}

/** Injectable native runner seam. Production invokes Cargo directly; tests can
 * model pass/fail/empty/timeout outcomes without compiling the whole crate. */
export type CriterionCargoCheckRunner = (opts: {
  manifestPath: string;
  sourceFiles: string[];
  root: string;
  test?: string;
  timeoutMs?: number;
}) => Promise<CriterionCargoRunResult>;

const CARGO_RESULT_RE = /^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm;
const CARGO_ANSI_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[ -/]*[@-~]/g;
const CARGO_RUN_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CARGO_DEFAULT_TIMEOUT_MS = 15 * 60_000;

function isInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  if (!(candidateAbs === rootAbs || candidateAbs.startsWith(`${rootAbs}${sep}`))) return false;
  try {
    const rootReal = realpathSync(rootAbs);
    const candidateReal = realpathSync(candidateAbs);
    return candidateReal === rootReal || candidateReal.startsWith(`${rootReal}${sep}`);
  } catch {
    return false;
  }
}

/**
 * Containment for a PLANNED path, which does not exist yet: {@link isInsideRoot} realpaths
 * the candidate and so always answers false for it. A lexical check is enough here, since
 * grading re-validates the file with the realpath form once it exists.
 */
function isPlannedPathInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  return candidateAbs.startsWith(`${rootAbs}${sep}`);
}

function isRegularFileInsideRoot(root: string, candidate: string): boolean {
  try {
    return isInsideRoot(root, candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function cargoBinary(): string {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => join(dir, 'cargo')),
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo') : null,
    join(homedir(), '.cargo', 'bin', 'cargo'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cargo';
}

function cargoResultNames(output: string): { name: string; outcome: 'ok' | 'FAILED' | 'ignored' }[] {
  const normalized = output.replace(CARGO_ANSI_RE, '');
  const results: { name: string; outcome: 'ok' | 'FAILED' | 'ignored' }[] = [];
  const resultRe = new RegExp(CARGO_RESULT_RE.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(normalized)) !== null) {
    results.push({ name: match[1]!, outcome: match[2] as 'ok' | 'FAILED' | 'ignored' });
  }
  return results;
}

function killCargoTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    try {
      child.kill(signal);
    } catch {
      /* the process already exited */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* the process already exited */
    }
  }
}

/**
 * Run one Cargo crate at manifest scope and distil its stable stdout into counts.
 *
 * This is intentionally separate from `runTestFilesCore`: that core is a Vitest
 * router and correctly refuses `.rs` inputs. Cargo's own manifest/test boundary
 * is the native equivalent, while the caller retains explicit sourceFiles
 * attribution because stable Cargo output has no source-location grain.
 */
export function runCargoCriterionCheck(opts: {
  manifestPath: string;
  sourceFiles: string[];
  root: string;
  test?: string;
  timeoutMs?: number;
  managedSpawnFn?: typeof managedSpawn;
}): Promise<CriterionCargoRunResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const manifestAbs = resolve(opts.root, opts.manifestPath);
  const args = [
    'test',
    '--manifest-path',
    manifestAbs,
    '--no-fail-fast',
    ...(opts.test ? [opts.test] : []),
  ];
  const timeoutMs = opts.timeoutMs ?? CARGO_DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TERM_COLOR: 'never',
    PAPERCUSP_TEST_RUN_GROUP: runId,
  };

  return new Promise((resolveResult) => {
    let output = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let closeObserved = false;
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const append = (chunk: string): void => {
      const next = output + chunk;
      if (next.length <= CARGO_RUN_OUTPUT_LIMIT) {
        output = next;
        return;
      }
      outputTruncated = true;
      output = next.slice(-CARGO_RUN_OUTPUT_LIMIT);
    };
    const finish = (result: CriterionCargoRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      resolveResult(result);
    };

    const kill = (signal: NodeJS.Signals): void => {
      if (child) killCargoTree(child, signal);
    };
    const scheduleEscalation = (): void => {
      // A timeout can settle the caller's promise before managedSpawn finishes
      // its admission/ledger handshake. A late child still needs the same
      // SIGKILL backstop even though the result is already settled.
      if (escalation || !child) return;
      escalation = setTimeout(() => kill('SIGKILL'), 15_000);
      escalation.unref();
    };
    const requestTermination = (): void => {
      timedOut = true;
      if (!child) {
        finishFromClose(null, null);
        return;
      }
      kill('SIGTERM');
      scheduleEscalation();
    };
    const finishFromClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        closeObserved = true;
        if (escalation) clearTimeout(escalation);
        return;
      }
      closeObserved = true;
      const results = cargoResultNames(output);
      const passed = results.filter((r) => r.outcome === 'ok').length;
      const failed = results.filter((r) => r.outcome === 'FAILED').length;
      const ignored = results.filter((r) => r.outcome === 'ignored').length;
      const failures = results
        .filter((r) => r.outcome === 'FAILED')
        .slice(0, 10)
        .map((r) => r.name);
      const common = {
        passed,
        failed,
        ignored,
        runId,
        durationMs: Date.now() - startedAt,
        ...(failures.length > 0 ? { failures } : {}),
        ...(outputTruncated ? { output: 'Cargo output exceeded the bounded parser buffer.' } : {}),
      };
      if (timedOut) {
        finish({ ...common, error: `timeout after ${timeoutMs}ms` });
      } else if (outputTruncated) {
        finish({ ...common, error: 'output_truncated: Cargo test result lines were not fully measurable' });
      } else if (results.length === 0) {
        finish({
          ...common,
          output: output.slice(-4000),
          error: code === 0 ? 'no_tests: Cargo reported no test result lines' : `cargo_failed: exit code ${code ?? 'null'}`,
        });
      } else if (code !== 0 && failed === 0) {
        finish({ ...common, output: output.slice(-4000), error: `cargo_failed: exit code ${code ?? 'null'}` });
      } else {
        finish(common);
      }
    };
    const handleStartError = (error: unknown): void => {
      finish({
        passed: 0,
        failed: 0,
        ignored: 0,
        runId,
        durationMs: Date.now() - startedAt,
        error: `spawn_error: ${error instanceof Error ? error.message : String(error)}`,
      });
    };

    timer = setTimeout(() => {
      // managedSpawn may still be settling its admission/ledger work when this
      // deadline expires. Remember the timeout and kill the payload immediately
      // once the child handle arrives; never leave a late child running because
      // the timeout callback raced the async spawn handshake.
      requestTermination();
    }, timeoutMs);

    const spawnTask = opts.managedSpawnFn ?? managedSpawn;
    let start: Promise<Awaited<ReturnType<typeof managedSpawn>>>;
    try {
      start = spawnTask(
        cargoBinary(),
        args,
        {
          class: 'build',
          title: `scorecards cargo check (${opts.manifestPath})`,
          argv: [cargoBinary(), ...args],
          cwd: opts.root,
          launchedBy: 'scorecards:emit',
          runtimeMaxSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
          detail: { rubricCheck: 'cargo', manifestPath: opts.manifestPath, sourceFiles: opts.sourceFiles },
        },
        {
          spawnOptions: {
            cwd: opts.root,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        },
      );
    } catch (error) {
      handleStartError(error);
      return;
    }

    void start.then((managed) => {
      child = managed.child;
      child.stdout?.on('data', (chunk: Buffer | string) => {
        append(chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        append(chunk.toString());
      });
      child.once('error', (error) => {
        finish({
          passed: 0,
          failed: 0,
          ignored: 0,
          runId,
          durationMs: Date.now() - startedAt,
          error: `spawn_error: ${error.message}`,
        });
      });
      child.once('close', finishFromClose);
      if (timedOut) requestTermination();

      // A very short-lived child may have emitted both `exit` and `close` before
      // managedSpawn finished its async ledger work. ChildProcess retains its
      // exitCode/signalCode, so schedule one fallback check rather than hanging
      // until the rubric timeout after the close event was legitimately missed.
      if (child.exitCode != null || child.signalCode != null) {
        setImmediate(() => {
          if (!settled && !closeObserved) {
            finishFromClose(child?.exitCode ?? null, child?.signalCode ?? null);
          }
        });
      }
    }, handleStartError);
  });
}

/**
 * GRADING-time evaluation for kind:'cargo' checks. Each unique manifest/filter
 * pair is run once, then its crate-level verdict is copied to each criterion
 * with that criterion's explicit sourceFiles attribution. This keeps native
 * checks cheap without claiming Cargo can identify which Rust file owned a test.
 */
export async function evaluateCriterionCargoChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  root?: string;
  timeoutMs?: number;
  runner?: CriterionCargoCheckRunner;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const ratedCargoChecks = input.criteria.filter(
    (c) => c.check?.kind === 'cargo' && input.ratings[c.key] !== undefined,
  );
  const root = selectCriterionCheckRoot(ratedCargoChecks, input.root ?? resolveAgentWorkspaceRoot({})).root;
  const runner = input.runner ?? runCargoCriterionCheck;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : null;
  const planned: {
    key: string;
    manifestPath: string;
    sourceFiles: string[];
    test?: string;
  }[] = [];

  for (const c of ratedCargoChecks) {
    const validation = validateCriterionCheckPaths([c], { root });
    const normalized = validation.normalizedCargoByKey[c.key];
    if (!validation.ok || !normalized) {
      return {
        ok: false,
        error: 'check_path_unresolved',
        criterionKey: c.key,
        paths: validation.failures.map((f) => f.path),
        detail:
          `criterion '${c.key}' carries a cargo-check whose manifest/source path(s) cannot be used against '${root}': ` +
          validation.failures.map((f) => `${f.path} (${f.reason})`).join('; ') +
          ` — grading a native deterministic criterion whose check cannot run would be a silent pass. ` +
          `Fix the rubric's check (rubrics:propose) or restore the path(s), then re-emit.`,
      };
    }
    planned.push({
      key: c.key,
      manifestPath: normalized.manifestPath,
      sourceFiles: normalized.sourceFiles,
      ...(c.check?.kind === 'cargo' && c.check.test ? { test: c.check.test } : {}),
    });
  }
  if (planned.length === 0) return { ok: true, checkRuns: {} };

  const groups = new Map<
    string,
    { manifestPath: string; sourceFiles: string[]; test?: string; keys: string[] }
  >();
  for (const item of planned) {
    const groupKey = `${item.manifestPath}\u0000${item.test ?? ''}`;
    const group = groups.get(groupKey) ?? {
      manifestPath: item.manifestPath,
      sourceFiles: [],
      ...(item.test ? { test: item.test } : {}),
      keys: [],
    };
    for (const sourceFile of item.sourceFiles) {
      if (!group.sourceFiles.includes(sourceFile)) group.sourceFiles.push(sourceFile);
    }
    group.keys.push(item.key);
    groups.set(groupKey, group);
  }

  const checkRuns: Record<string, CriterionCheckRun> = {};
  for (const group of groups.values()) {
    const budget = deadline === null ? undefined : Math.max(1000, deadline - Date.now());
    const run = await runner({
      manifestPath: group.manifestPath,
      sourceFiles: group.sourceFiles,
      root,
      ...(group.test ? { test: group.test } : {}),
      ...(budget !== undefined ? { timeoutMs: budget } : {}),
    });
    if (run.error) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: group.keys[0] ?? '(none)',
        detail:
          `the cargo tests-check run for ${group.keys.length} criterion/criteria ` +
          `(manifest ${group.manifestPath}${group.test ? `, filter ${JSON.stringify(group.test)}` : ''}) ` +
          `could not be judged (${run.error}). D-006 requires the named native tests to actually ` +
          `RUN at grading time — an unjudgeable check refuses the emit rather than passing silently.`,
      };
    }
    if (run.passed + run.failed === 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: group.keys[0] ?? '(none)',
        detail:
          `the cargo tests-check run for manifest '${group.manifestPath}' executed ZERO non-ignored ` +
          `tests${group.test ? ` for filter ${JSON.stringify(group.test)}` : ''}; ` +
          `an ignored/empty native suite is unjudged, not a deterministic pass.`,
      };
    }
    for (const item of planned.filter((candidate) => group.keys.includes(candidate.key))) {
      const record: CriterionCheckRun = {
        kind: 'cargo',
        manifestPath: group.manifestPath,
        sourceFiles: item.sourceFiles,
        ...(group.test ? { test: group.test } : {}),
        verdict: run.failed === 0 ? 'pass' : 'fail',
        passed: run.passed,
        failed: run.failed,
        ignored: run.ignored,
        runId: run.runId,
        measuredAt: nowIso(),
        ...(run.failed > 0 && run.failures?.length ? { failures: run.failures } : {}),
      };
      const rating = input.ratings[item.key]?.rating ?? '';
      if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
        return {
          ok: false,
          error: 'check_contradicted',
          criterionKey: item.key,
          rating,
          run: record,
          detail:
            `criterion '${item.key}' is rated '${rating}' but its deterministic cargo-check FAILED ` +
            `(${record.failed} failing of ${record.passed + record.failed} run): ` +
            `${record.failures?.join(' · ') ?? 'Cargo reported a failing test'}. ` +
            `A must-pass check outranks judgment — fix the code (or the tests), or rate the criterion honestly.`,
        };
      }
      checkRuns[item.key] = record;
    }
  }
  return { ok: true, checkRuns };
}

/** Ratings whose meaning a failing must-pass run CONTRADICTS — the same vocabulary map
 *  the scorecard instrument contract uses for verdict mismatches, applied to the binary
 *  tests-check. A rating outside the map (a bespoke scale word) is stamped but never
 *  refused: the map is deliberately conservative so an unfamiliar vocabulary degrades
 *  to machine-detectable rather than wrongly refused. */
function ratingClaimsPass(rating: string): boolean {
  return ['pass', 'healthy', 'green', 'good', 'yes', 'exemplary', 'exceptional'].includes(
    rating.trim().toLowerCase(),
  );
}

/** Preserve actionable detail when a deterministic check contradicts a rating. */
const CRITERION_FAILURE_MESSAGE_MAX_CHARS = 500;

function formatCriterionFailure(failure: { file?: unknown; test?: unknown; message?: unknown }): string {
  const file = typeof failure.file === 'string' && failure.file.length > 0 ? failure.file : '?';
  const test = typeof failure.test === 'string' && failure.test.length > 0 ? failure.test : '?';
  const rawMessage = typeof failure.message === 'string' ? failure.message.replace(/\s+/g, ' ').trim() : '';
  const message =
    rawMessage.length > CRITERION_FAILURE_MESSAGE_MAX_CHARS
      ? `${rawMessage.slice(0, CRITERION_FAILURE_MESSAGE_MAX_CHARS - 1)}…`
      : rawMessage;
  return `${file}: ${test}${message ? ` — ${message}` : ''}`;
}

type ReportedTestFileCounts = {
  passed: number;
  failed: number;
  skipped: number;
  collectionFailed: boolean;
};

/**
 * Reduce the two path vocabularies around an external checkout to one file identity.
 *
 * A criterion admitted from the Papercusp superproject stores an absolute path in the
 * sibling checkout. Direct Vitest runs, however, report the same file relative to the
 * runner root (and that spelling can cross a workspace symlink). Comparing those two
 * strings literally leaves a genuinely executed file "unreported". realpath is the
 * authority: it proves both spellings resolve to the same live file without weakening
 * the missing-file refusal to basename or suffix matching.
 */
function reportedTestFileIdentity(file: string, root: string): string {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
  try {
    return realpathSync(absolute);
  } catch {
    // Validation already requires planned files to exist. Keeping a normalized
    // identity for malformed reporter keys ensures they remain unmatched/refused.
    return absolute;
  }
}

function indexReportedTestFiles(
  byFile: Record<string, ReportedTestFileCounts>,
  root: string,
): Map<string, ReportedTestFileCounts> {
  const indexed = new Map<string, ReportedTestFileCounts>();
  for (const [file, counts] of Object.entries(byFile)) {
    const identity = reportedTestFileIdentity(file, root);
    const current = indexed.get(identity);
    if (!current) {
      indexed.set(identity, { ...counts });
      continue;
    }
    current.passed += counts.passed;
    current.failed += counts.failed;
    current.skipped += counts.skipped;
    if (counts.collectionFailed) current.collectionFailed = true;
  }
  return indexed;
}

/**
 * GRADING-time evaluation (called by scorecards:emit): for every RATED criterion whose
 * check is kind:'tests', re-resolve the files (refusing a stale path — D-006), RUN them
 * through the testing:run core, and refuse a rating the run contradicts.
 *
 * ONE BATCHED RUN for all files, attributed per criterion via the report's `byFile`
 * grain (WI-39848). This replaced one-run-per-criterion, which was chosen so that "a
 * truncated failure list can never mis-assign a verdict" — a real hazard, but it bought
 * that safety with N cold vitest starts against a SINGLE shared deadline, so each run ate
 * the budget the next one needed and the LAST criterion starved deterministically. A
 * 7-check rubric became ungradeable, which blocked its plan's ship gate outright.
 * `byFile` gives exact per-file counts that stay complete even when the failure LIST is
 * capped, so batching now keeps the original safety property AND removes the starvation:
 * the truncation hazard is answered by the data, not by paying for extra processes.
 * A file the report never mentions is refused as unjudged, never treated as a pass.
 */
export async function evaluateCriterionTestChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  /** Criterion key → the rating string being emitted (only RATED criteria are checked —
   *  emit's completeness validation separately guarantees every criterion is rated). */
  ratings: Record<string, { rating: string } | undefined>;
  root?: string;
  /** Concrete workspace scope for the test-run ledger. */
  workspaceId?: string;
  /** Concrete harness scope for the test-run ledger. */
  harnessSlug?: string;
  /** Total run budget across ALL checks (ms); each run gets what remains. */
  timeoutMs?: number;
  runner?: CriterionCheckRunner;
  /** Exact request-bound run group supplied by a composing durable scorecard emit. */
  runId?: string;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  // WI-41394: select the validation/run root over the rated tests-check subset — the
  // same subset validated below — so a phantom requested root (a stale hive registry
  // entry) falls back to the canonical repo exactly when every checked path resolves
  // there, and propose-time acceptance cannot diverge from grading-time refusal.
  const ratedTestsChecks = input.criteria.filter(
    (c) => c.check?.kind === 'tests' && input.ratings[c.key] !== undefined,
  );
  const root = selectCriterionCheckRoot(ratedTestsChecks, input.root ?? resolveAgentWorkspaceRoot({})).root;
  // The ordinary testing:run handler passes this scope into runTestFilesCore and
  // reads back its numeric ledger IDs. Scorecard checks bypass that handler, so
  // preserve the same contract here rather than creating unattributed rows that
  // cannot later bind spec evidence. Injected runners stay untouched except for
  // receiving the same scope fields.
  const runner: CriterionCheckRunner = input.runner ?? runCriterionCheckFiles;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : null;
  const checkRuns: Record<string, CriterionCheckRun> = {};

  // ── Pass 1: resolve every rated tests-check's paths BEFORE running anything ──
  // Path resolution is per-criterion and must keep its own refusal (D-006), so a stale
  // path still names the criterion that carries it. Doing all of it up front also means
  // a rubric with one bad path costs zero test runs instead of failing partway through.
  const planned: { key: string; files: string[] }[] = [];
  for (const c of input.criteria) {
    if (c.check?.kind !== 'tests') continue;
    if (input.ratings[c.key] === undefined) continue;
    // Re-resolve at grading time — the tree has moved since propose. A path that no
    // longer resolves REFUSES the emit rather than silently passing (D-006 verbatim).
    const validation = validateCriterionCheckPaths([c], { root });
    if (!validation.ok) {
      return {
        ok: false,
        error: 'check_path_unresolved',
        criterionKey: c.key,
        paths: validation.failures.map((f) => f.path),
        detail:
          `criterion '${c.key}' carries a tests-check whose file(s) no longer resolve against '${root}': ` +
          validation.failures.map((f) => `${f.path} (${f.reason})`).join('; ') +
          ` — grading a deterministic criterion whose check cannot run would be a silent pass. ` +
          `Fix the rubric's check (rubrics:propose) or restore the file(s), then re-emit.`,
      };
    }
    planned.push({ key: c.key, files: validation.normalizedByKey[c.key] ?? [...c.check.files] });
  }
  if (planned.length === 0) return { ok: true, checkRuns };

  // ── Pass 2: ONE batched run for every file, then attribute per criterion ──
  // WI-39848: this used to be one vitest process PER criterion against a SHARED deadline
  // (`Math.max(1000, deadline - Date.now())`), so each run ate budget the next one needed
  // and the LAST criterion was starved deterministically — a 7-check rubric could never be
  // graded, and the refusal blamed the starved criterion's file for being "too slow" when
  // the budget had been spent upstream. The cost driver was N cold starts, not any one
  // suite, so the fix is to pay for ONE. Attribution stays exact because it now reads
  // `byFile` — per-file counts that are complete even when the failure LIST is capped.
  const uniqueFiles = [...new Set(planned.flatMap((p) => p.files))];
  const budget = deadline === null ? undefined : Math.max(1000, deadline - Date.now());
  const run = await runner({
    files: uniqueFiles,
    root,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(budget !== undefined ? { timeoutMs: budget } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {}),
  });
  if (run.error !== undefined) {
    const runnerFailure: CriterionCheckRunnerFailure = {
      runId: run.runId,
      root: run.root,
      error: run.error,
      ...('hint' in run && typeof run.hint === 'string' ? { hint: run.hint } : {}),
      ...('routerOutput' in run && typeof run.routerOutput === 'string'
        ? { routerOutput: run.routerOutput.slice(-2000) }
        : {}),
      ...('detachedRunId' in run && typeof run.detachedRunId === 'string'
        ? { detachedRunId: run.detachedRunId }
        : {}),
      ...('detachedDurable' in run && typeof run.detachedDurable === 'boolean'
        ? { detachedDurable: run.detachedDurable }
        : {}),
    };
    return {
      ok: false,
      error: 'check_run_failed',
      criterionKey: planned[0]?.key ?? '(none)',
      runner: runnerFailure,
      detail:
        `the batched tests-check run for ${planned.length} criterion/criteria ` +
        `(${uniqueFiles.length} file(s): ${uniqueFiles.join(', ')}) could not be judged ` +
        `(${run.error}${'hint' in run && run.hint ? ` — ${run.hint}` : ''}; runId ${run.runId}). ` +
        `D-006 requires the named files to actually RUN at grading time — an unjudgeable check refuses ` +
        `the emit rather than passing silently. NOTE: this is the whole batch, so it does NOT single out ` +
        `any one criterion's suite as the slow one.`,
    };
  }

  // A runner that reports no per-file grain (a stub, or an older shape) cannot be
  // attributed from a batch. Refuse rather than spread the batch's aggregate across
  // criteria — that would let one criterion's failure condemn another's, or worse, let a
  // green aggregate vouch for a file that never reported.
  const byFile = (run as { byFile?: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }> }).byFile;
  if (byFile === undefined) {
    return {
      ok: false,
      error: 'check_run_failed',
      criterionKey: planned[0]?.key ?? '(none)',
      detail:
        `the batched tests-check run returned no per-file breakdown (byFile), so its result cannot be ` +
        `attributed to individual criteria. Refusing rather than judging every criterion on the batch ` +
        `aggregate, which would let one criterion's failure condemn another's.`,
    };
  }

  const reportRoot = typeof run.root === 'string' ? run.root : root;
  const byIdentity = indexReportedTestFiles(byFile, reportRoot);
  const countsFor = (file: string): ReportedTestFileCounts | undefined =>
    byFile[file] ?? byIdentity.get(reportedTestFileIdentity(file, reportRoot));

  for (const { key, files } of planned) {
    // A file the report never mentions is UNJUDGED, not passed. Without this the batch's
    // green aggregate would vouch for a file that silently failed to run at all.
    const missing = files.filter((f) => countsFor(f) === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: key,
        detail:
          `criterion '${key}' names test file(s) the batched run never reported on ` +
          `(${missing.join(', ')}), so the check is unjudged. Treating an unreported file as a pass ` +
          `would be exactly the silent pass D-006 forbids.`,
      };
    }
    // A reported file can still be UNJUDGED: Vitest exits zero when every test in a
    // collected file is skipped (for example, a portable suite guarded by
    // `describe.skipIf(!config)`). Checking only the batch aggregate is insufficient —
    // one genuinely-running sibling file would hide the vacuous file. Every named file
    // must execute at least one test before it may support a deterministic criterion.
    const unexecuted = files.filter((f) => {
      const counts = countsFor(f)!;
      return counts.passed + counts.failed === 0;
    });
    if (unexecuted.length > 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: key,
        detail:
          `criterion '${key}' names test file(s) that were reported but executed ZERO tests: ` +
          unexecuted
            .map((f) => {
              const counts = countsFor(f)!;
              return `${f} (${counts.skipped} skipped${counts.collectionFailed ? ', collection failed' : ''})`;
            })
            .join(', ') +
          `. An exit-zero skip-only suite is unjudged, not a deterministic pass. Supply the ` +
          `required test configuration or bind the criterion to a non-skipping authority test, then re-emit.`,
      };
    }
    const passed = files.reduce((n, f) => n + (countsFor(f)?.passed ?? 0), 0);
    const failed = files.reduce((n, f) => n + (countsFor(f)?.failed ?? 0), 0);
    const fileIdentities = new Set(files.map((f) => reportedTestFileIdentity(f, reportRoot)));
    const record: CriterionCheckRun = {
      kind: 'tests',
      files,
      verdict: failed === 0 ? 'pass' : 'fail',
      passed,
      failed,
      runId: run.runId ?? null,
      ...(run.testRunIds !== undefined ? { testRunIds: [...run.testRunIds] } : {}),
      measuredAt: nowIso(),
      ...(failed > 0 && Array.isArray(run.failures)
        ? {
            failures: run.failures
              .filter((f) => {
                const file = (f as { file?: string }).file;
                return file !== undefined && fileIdentities.has(reportedTestFileIdentity(file, reportRoot));
              })
              .slice(0, 10)
              .map((f) => formatCriterionFailure(f)),
          }
        : {}),
    };
    const rating = input.ratings[key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'check_contradicted',
        criterionKey: key,
        rating,
        run: record,
        detail:
          `criterion '${key}' is rated '${rating}' but its deterministic tests-check FAILED ` +
          `(${record.failed} failing of ${record.passed + record.failed} run${record.failures ? `: ${record.failures.join(' · ')}` : ''}). ` +
          `A must-pass check outranks judgment — fix the code (or the tests), or rate the criterion honestly.`,
      };
    }
    checkRuns[key] = record;
  }
  return { ok: true, checkRuns };
}

/** The coverage run record — {@link ScorecardCoverageCheckRun}, re-exported for callers. */
export type CoverageCheckRun = ScorecardCoverageCheckRun;

/**
 * The slice of `readCoverage`'s response this module judges on. Declared STRUCTURALLY
 * rather than importing the inferred return type so the seam is stubbable in tests —
 * and, more importantly, so what the gate actually depends on is written down: if
 * `readCoverage` ever stops returning one of these, this breaks HERE, loudly, instead
 * of the gate quietly judging on an `undefined` that coerces to a passing 0.
 */
export interface CoverageMeasurement {
  verdict: 'measured' | 'not-measured';
  censusUnknown: string[] | null;
  coverage: {
    surfaces: number;
    meets: number;
    belowUnwaived: number;
    pct: number | null;
    fidelity: { weakest: string | null; declaredPct: number | null };
  };
  rows: { surfaceId: string; kind: string; sourceFile: string | null }[];
}

/** Injectable census-read seam (tests stub this; production passes `readCoverage`). */
export type CoverageReader = (args: {
  kind?: string;
  sourceFiles?: string[];
  rung: 'l1' | 'l2' | 'l3' | 'l4';
  gapsOnly: boolean;
  limit: number;
}) => Promise<CoverageMeasurement>;

/**
 * Resolves `scope.planTouched` to the file list it stands for: the implementing files
 * the subject plan's completed work actually changed. Returns null when the caller has
 * no plan subject to resolve against — which REFUSES the check rather than silently
 * widening it to the whole census.
 */
export type PlanTouchedFilesResolver = () => Promise<string[] | null>;

/** How many failing surfaces to name in a refusal before summarising the rest. */
const MAX_NAMED_SURFACES = 12;

/**
 * GRADING-time evaluation for kind:'coverage' checks — the census counterpart of
 * {@link evaluateCriterionTestChecks}, holding the identical three-part contract:
 * measure NOW (never a stale row), refuse what cannot be judged, and refuse a
 * pass-claiming rating the measurement contradicts.
 *
 * The three failure modes it is built to NOT have — each of them this plan's own
 * subject matter, so shipping one here would be self-refuting:
 *
 *  1. **0-of-0 rendering as pass.** A scope matching ZERO censused surfaces REFUSES.
 *     An empty scope is the cheapest possible way to make a coverage gate vacuously
 *     green ("0 gaps! everything is covered"), and `readCoverage` already refuses to
 *     express it as a ratio — `pct` is null and `verdict` says `not-measured` in words.
 *     A gate that passed there would contradict the very surface it reads.
 *  2. **A truncated population flattering the ratio.** The census can be a real number
 *     about a partial world (WI-39812: 675 defineTool files censused as 49, because the
 *     catalog is module-split). Truncation ALWAYS flatters, since surfaces that were
 *     never enumerated cannot appear as gaps — so every verdict message carries the
 *     fidelity marker, and the record stores it.
 *  3. **Stale evidence.** The census is re-read here, at grading time.
 */
export async function evaluateCriterionCoverageChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  readCoverage: CoverageReader;
  resolvePlanTouchedFiles?: PlanTouchedFilesResolver;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const checkRuns: Record<string, CriterionCheckRun> = {};
  let planTouchedFiles: string[] | null | undefined;

  for (const c of input.criteria) {
    if (c.check?.kind !== 'coverage') continue;
    if (input.ratings[c.key] === undefined) continue;
    const { scope, floor } = c.check;

    // ── Resolve the scope. planTouched expands to a real file list HERE, so the record
    //    stores what was measured rather than the intention to measure something.
    let sourceFiles = scope.sourceFiles;
    if (scope.planTouched === true) {
      if (planTouchedFiles === undefined) {
        planTouchedFiles = input.resolvePlanTouchedFiles ? await input.resolvePlanTouchedFiles() : null;
      }
      if (planTouchedFiles === null || planTouchedFiles.length === 0) {
        return {
          ok: false,
          error: 'coverage_scope_empty',
          criterionKey: c.key,
          detail:
            `criterion '${c.key}' carries a coverage-check scoped to planTouched, but no changed files ` +
            `could be resolved for the subject plan${planTouchedFiles === null ? ' (no plan subject on this emit)' : ' (its completed work-items record no filesChanged)'}. ` +
            `An unresolved scope would measure the WHOLE census instead of this plan's surfaces — ` +
            `silently widening a gate is worse than refusing it. Give the criterion an explicit ` +
            `scope.sourceFiles, or grade a card whose subject plan has completion evidence.`,
        };
      }
      sourceFiles = planTouchedFiles;
    }

    // ── Measure. ONE read: the aggregates are computed over the whole in-scope
    //    population regardless of gapsOnly (which bounds only the returned rows), so
    //    this yields both an unbounded verdict and a bounded list of names for it.
    const measurement = await input.readCoverage({
      ...(scope.surfaceKind ? { kind: scope.surfaceKind } : {}),
      ...(sourceFiles && sourceFiles.length > 0 ? { sourceFiles } : {}),
      rung: floor,
      gapsOnly: true,
      limit: MAX_NAMED_SURFACES,
    });

    // ── FAILURE MODE 1. Zero denominator ⇒ refuse. Never a pass, never a 0%, never 100%.
    if (measurement.verdict === 'not-measured' || measurement.coverage.surfaces === 0) {
      return {
        ok: false,
        error: 'coverage_scope_empty',
        criterionKey: c.key,
        detail:
          `criterion '${c.key}' carries a coverage-check whose scope matches ZERO censused surfaces, ` +
          `so there is nothing to be covered and no denominator to form a ratio from ` +
          `(${describeScope(scope, sourceFiles)}, floor ${floor}). ` +
          (measurement.censusUnknown?.length
            ? `The census says why: ${measurement.censusUnknown.join(' | ')}. `
            : '') +
          `Passing here would be a vacuous truth — "0 gaps" because nothing was ever looked at. ` +
          `Fix the scope so it names real surfaces, or drop the check to leave the criterion fuzzy.`,
      };
    }

    const { surfaces, meets, belowUnwaived, pct, fidelity } = measurement.coverage;
    const belowSurfaces = measurement.rows.map((r) => r.surfaceId);
    const record: CoverageCheckRun = {
      kind: 'coverage',
      scope: {
        ...(scope.surfaceKind ? { surfaceKind: scope.surfaceKind } : {}),
        ...(sourceFiles && sourceFiles.length > 0 ? { sourceFiles } : {}),
        ...(scope.planTouched === true ? { planTouched: true as const } : {}),
      },
      floor,
      verdict: belowUnwaived === 0 ? 'pass' : 'fail',
      surfaces,
      meets,
      belowUnwaived,
      pct,
      fidelity,
      ...(belowSurfaces.length > 0 ? { belowSurfaces } : {}),
      measuredAt: nowIso(),
    };

    const rating = input.ratings[c.key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'coverage_contradicted',
        criterionKey: c.key,
        rating,
        run: record,
        detail:
          `criterion '${c.key}' is rated '${rating}' but ${belowUnwaived} of ${surfaces} censused ` +
          `surfaces in scope do NOT meet ${floor} (${describeScope(scope, sourceFiles)}): ` +
          `${namedSurfaces(belowSurfaces, belowUnwaived)}. ` +
          `${fidelityCaveat(fidelity)} ` +
          `A measured gap outranks judgment — prove the surfaces to ${floor}, waive them ` +
          `deliberately, or rate the criterion honestly.`,
      };
    }
    checkRuns[c.key] = record;
  }
  return { ok: true, checkRuns };
}

function describeScope(
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true },
  resolvedFiles: string[] | undefined,
): string {
  const parts: string[] = [];
  if (scope.surfaceKind) parts.push(`kind=${scope.surfaceKind}`);
  if (scope.planTouched === true) {
    parts.push(`planTouched=${resolvedFiles ? `${resolvedFiles.length} file(s)` : 'unresolved'}`);
  } else if (resolvedFiles && resolvedFiles.length > 0) {
    parts.push(`files=${resolvedFiles.length}`);
  }
  return parts.length > 0 ? `scope ${parts.join(' ')}` : 'scope = the whole harness census';
}

/** Names the surfaces, and says so when the named list stands for a larger population —
 *  a bounded sample presented as if it were the whole is the same lie as a bounded
 *  aggregate presented as a total. */
function namedSurfaces(named: string[], total: number): string {
  if (named.length === 0) return `${total} surface(s), none listed`;
  const shown = named.join(', ');
  return named.length < total ? `${shown} (+${total - named.length} more)` : shown;
}

function fidelityCaveat(fidelity: { weakest: string | null; declaredPct: number | null }): string {
  if (!fidelity.weakest) return '';
  return (
    `Population fidelity: weakest '${fidelity.weakest}'` +
    (fidelity.declaredPct !== null ? `, ${fidelity.declaredPct}% declared` : '') +
    ` — a partial census flatters, since surfaces it never enumerated cannot appear as gaps.`
  );
}

// ── kind:'requirements' — the activation↔completion join, as a criterion ──────────
// (design-to-code-coverage-seam-2026-09-02 P-026)

export type RequirementsCheckRun = ScorecardRequirementsCheckRun;

/** How many unrealized requirements to name in a refusal before summarising the rest. */
const MAX_NAMED_REQUIREMENTS = 8;

/**
 * Injectable seam supplying the three datasets the P-014 judge needs, for the rubric's
 * SUBJECT plan. Returns null when this emit has no plan subject to resolve against —
 * which REFUSES the check rather than silently judging nothing.
 */
export type RequirementRealizationReader = () => Promise<{
  planSlug: string;
  mappings: ReadonlyArray<ActivationAuditMapping>;
  itemAudits: ReadonlyArray<EffectiveItemAudit>;
  planItems: ReadonlyArray<PlanItemStatus>;
  nonCodeItemProofs?: ReadonlyArray<NonCodeItemProof>;
} | null>;

/**
 * GRADING-time evaluation for kind:'requirements' checks — the design→code counterpart
 * of {@link evaluateCriterionCoverageChecks}, holding the identical three-part contract:
 * measure NOW, refuse what cannot be judged, and refuse a pass-claiming rating the
 * measurement contradicts.
 *
 * WHY THIS EXISTS AS A CRITERION AT ALL, given the ship gate already runs the same join:
 * the two run for DIFFERENT readers. `plan-acceptance-gate` runs it to decide whether the
 * author may ship; this runs it so the INDEPENDENT GRADER — who cannot run Bash, and so
 * has no way to interrogate the tree — can see which of the plan's stated requirements
 * have no observable code. Without it the grader's only source for that is the
 * implementer's own summary, which is precisely the thing an independent grade exists to
 * not rely on.
 *
 * ⚠ DELIBERATE DIVERGENCE FROM THE GATE — read this before "fixing" the inconsistency.
 * `plan-acceptance-gate` fails OPEN on an absent or unreadable activation audit (its own
 * KNOWN LIMIT comment says so): plans predating the activation-audit regime have none,
 * and the gate must never make a plan LESS shippable than it was pre-P-014. That
 * reasoning is sound THERE and wrong HERE. A criterion whose entire claim is "the
 * requirements are realized" must never earn a pass from a population of zero — that is
 * the same vacuous truth the coverage arm refuses ("0 gaps!" because nothing was looked
 * at), and here it would be worse, because the grader would record a green criterion as
 * independent evidence. So: zero realizing mappings REFUSES.
 */
export async function evaluateCriterionRequirementChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  readRequirementRealization: RequirementRealizationReader;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const checkRuns: Record<string, CriterionCheckRun> = {};
  // Resolved at most once per emit: every requirements criterion on a card shares the
  // one subject plan, so re-reading per criterion would be N identical queries whose
  // answers could disagree if the audit moved between them.
  let resolved: Awaited<ReturnType<RequirementRealizationReader>> | undefined;

  for (const c of input.criteria) {
    if (c.check?.kind !== 'requirements') continue;
    if (input.ratings[c.key] === undefined) continue;

    if (resolved === undefined) resolved = await input.readRequirementRealization();

    // ── REFUSAL 1. No plan subject ⇒ there is nothing this criterion could be about.
    if (resolved === null) {
      return {
        ok: false,
        error: 'requirements_no_plan_subject',
        criterionKey: c.key,
        detail:
          `criterion '${c.key}' carries a requirements-check, which judges whether the SUBJECT PLAN's ` +
          `activation-audit requirements reached verified plan items — but this scorecard names no plan ` +
          `subject to resolve against. Grade a card whose rubric has subjectPlan set, or drop the check ` +
          `to leave the criterion fuzzy.`,
      };
    }

    const { planSlug, mappings, itemAudits, planItems, nonCodeItemProofs } = resolved;
    const realization = judgeRequirementRealization({
      mappings,
      itemAudits,
      nonCodeItemProofs,
      // Same input the ship gate passes (P-016 / D-040): without it a target is resolved
      // against the folded audit alone, so an item DELETED from the plan keeps vouching
      // for the requirement routed to it. The judge treats an empty list as "not
      // supplied", which is the correct degradation on a transient read failure.
      planItems,
    });

    // The denominator is counted from the INPUT, in MAPPINGS, using the judge's own
    // disposition set. Deriving it as `checkedTargets + exemptMappings.length` — the
    // obvious-looking arithmetic — silently adds a TARGET count to a MAPPING count, and
    // this plan already measured how far apart those units are: 4,090 of 9,912 realizing
    // targets are non-item (41.3%) but only 366 of 2,493 realizing MAPPINGS carry no
    // P-NNN (14.7%), an ~11x overstatement (D-035). Same class of error as reading a
    // bounded row list as a total.
    const realizingMappings = mappings.filter((m) => REALIZING_DISPOSITIONS.has(m.disposition)).length;

    // ── REFUSAL 2. Zero realizing mappings ⇒ refuse. Never a vacuous pass. See the
    //    DELIBERATE DIVERGENCE note above for why this differs from the ship gate.
    if (mappings.length === 0 || realizingMappings === 0) {
      return {
        ok: false,
        error: 'requirements_scope_empty',
        criterionKey: c.key,
        detail:
          `criterion '${c.key}' carries a requirements-check, but plan '${planSlug}' has ` +
          `${mappings.length === 0 ? 'NO activation-audit mappings at all' : 'no mappings dispositioned covered/repaired'} — ` +
          `so there is no requirement to realize and nothing to judge. Passing here would be a vacuous ` +
          `truth: "every promise is kept" because none was recorded. Note the ship gate deliberately ` +
          `fails OPEN on this same condition (a plan predating the activation-audit regime must stay ` +
          `shippable); a criterion asserting realization to an independent grader must not. Run ` +
          `plans:audit { phase:'activation' } so the plan's requirements are on record, or drop the ` +
          `check to leave the criterion fuzzy.`,
      };
    }

    const unrealizedLines = realization.unrealized.map(describeUnrealized);
    const droppedVouched = realization.droppedTargets.filter((d) => d.vouchedByStaleAudit).length;
    // `realization.unrealized` is one entry per (mapping, target) pair, so a requirement
    // routed to three unproven items appears three times. The headline count is DISTINCT
    // REQUIREMENTS — the same unit as the denominator — with the raw entry count kept
    // beside it rather than collapsed away.
    const unrealizedMappingIds = new Set(realization.unrealized.map((u) => u.mappingId));
    const record: RequirementsCheckRun = {
      kind: 'requirements',
      verdict: realization.ok ? 'pass' : 'fail',
      mappingsJudged: realizingMappings,
      checkedTargets: realization.checkedTargets,
      unrealized: unrealizedMappingIds.size,
      unrealizedEntries: realization.unrealized.length,
      exemptMappings: realization.exemptMappings.length,
      droppedTargets: realization.droppedTargets.length,
      droppedTargetsVouchedByStaleAudit: droppedVouched,
      ...(unrealizedLines.length > 0
        ? { unrealizedRequirements: unrealizedLines.slice(0, MAX_NAMED_REQUIREMENTS) }
        : {}),
      measuredAt: nowIso(),
    };

    const rating = input.ratings[c.key]?.rating ?? '';
    // ── REFUSAL 3. A measured gap outranks judgment, exactly as in the tests and
    //    coverage arms.
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'requirements_contradicted',
        criterionKey: c.key,
        rating,
        run: record,
        detail:
          `criterion '${c.key}' is rated '${rating}' but ${record.unrealized} of ${realizingMappings} ` +
          `realizing requirement(s) on plan '${planSlug}' never reached a VERIFIED plan item: ` +
          `${namedRequirements(record.unrealizedRequirements ?? [], record.unrealized)}. ` +
          `Only code/test citations count as verification (D-008), so a target audited with doc/none is ` +
          `unproven. ${exemptionCaveat(record)} ` +
          `Either audit the named item(s) against the real code with plans:audit, correct the ` +
          `disposition to 'rejected'/'open' if the requirement genuinely was not absorbed, or rate the ` +
          `criterion honestly.`,
      };
    }
    checkRuns[c.key] = record;
  }
  return { ok: true, checkRuns };
}

/** Names the requirements, and says so when the named list stands for a larger
 *  population — the same bounded-sample honesty {@link namedSurfaces} enforces. */
function namedRequirements(named: string[], total: number): string {
  if (named.length === 0) return `${total} requirement(s), none listed`;
  const shown = named.join('; ');
  return named.length < total ? `${shown} (+${total - named.length} more)` : shown;
}

/** States how much of the population was judged by nothing, so a reader never mistakes
 *  a narrow pass for a broad one. Silent when every mapping was genuinely judged. */
function exemptionCaveat(run: RequirementsCheckRun): string {
  const parts: string[] = [];
  if (run.exemptMappings > 0) {
    parts.push(
      `${run.exemptMappings} mapping(s) are judged by nothing (every target non-item — reported, never a violation, per D-035)`,
    );
  }
  if (run.droppedTargets > 0) {
    parts.push(
      `${run.droppedTargets} target(s) point at a DROPPED plan item` +
        (run.droppedTargetsVouchedByStaleAudit > 0
          ? `, ${run.droppedTargetsVouchedByStaleAudit} of them still vouched by a pre-drop audit entry`
          : ''),
    );
  }
  return parts.length > 0 ? `Population note: ${parts.join('; ')}.` : '';
}
