/** scorecards:emit — the typed write facade over the canonical observation ledger. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { defineTool } from '@papercusp/agent-mcp';
import { decode } from '@papercusp/result-encoding';
import {
  parseJsonWithTrailer,
  type AbortCompletionReceipt,
  type ToolResult,
} from '@papercusp/tooldef';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getOrgPg } from '@papercusp/db-org';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { deriveAgentRunEvidenceRecordSafe, type EvidenceRecordSql } from './agent-run-evidence-record';
import {
  classifyRubricEvidenceCurrentness,
  getRubric,
  getRubricCriteriaHash,
  getRubricEvidenceIdentity,
  getRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
  readRubricPlanRevision,
} from '../../rubrics';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { getIssue } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { activeWorkspaceId } from '../../workspace-registry';
import { readVettingConsultCritique } from '../../consult/get-feedback-core';
import { readVettingWorkItemCritique } from '../../work-items';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  validateScorecardPoorRatingDisposition,
  ObservationEvidenceError,
  type ObservationRatings,
  type ScorecardVetting,
  type ScorecardAcceptance,
  type AcceptanceSeatSuccession,
  type SpecTestAdequacyRerunRecipe,
  asStructuredObservation,
} from '../../harness/improvements/observation-types';
import { readRunningGeneration } from '../../scout/generation-watermark';
import {
  auditVerdictFromRatings,
  listScorecards,
  evaluateScorecardInstrumentContract,
  resolveScorecardReleaseGateBinding,
  scorecardRatingsClaimPass,
  ratingVerdict,
  recordGradingAudit,
  markGradingAuditAwaitingReemit,
  isCurrentSourceAuditResponder,
  scorecardEvidenceFingerprint,
  parseGradedGeneration,
  computeWorkOnEverythingRollup,
  resolveScorecardInstrumentSnapshots,
  validateRubricRatingContracts,
  type ScorecardInstrumentSnapshot,
  type ScorecardReleaseGateSnapshot,
} from '../../scorecards';
import { realGitProbe } from '../../release/judged-sha-containment';
import { scorecardInstrumentSnapshotSchema, scorecardRatingEntrySchema } from './evaluate';
import {
  CLIPPED_SCORECARD_TEXT_CODE,
  clippedScorecardTextMessage,
  findClippedScorecardText,
} from './emit-clipped-text';
import {
  adequacyCardRevisionDisposition,
  PLAN_CLASS_RUBRIC_REFS,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
  specTestAdequacySubjectRef,
} from '../plans/spec-test-adequacy';
import {
  argsSchema as evaluatorArgsSchema,
  replaySpecTestAdequacyForHistoricalAudit,
} from '../plans/evaluate-spec-test-adequacy';
import {
  collapseCriticsToSoleParty,
  resolveAcceptanceGraderEligibility,
  resolveAggregatedVettingCritics,
  retiredAcceptanceRubricRefusal,
} from './grader-eligibility';
import { acceptanceGraderLabelPrefix, advanceGradingCascadeOnCard } from '../../acceptance-grader';
import { gradingCardDigestExcerpt } from '../../consult/grading-cascade';
import { closeSourceAuditConsults } from '../../grading-audit-routing';
import {
  assessGenerationAncestry,
  dispatchPendingGradingAudits,
  GRADING_INTEGRITY_RUBRIC_REF,
  gradingAuditGateEnabled,
  needsGradingAudit,
  readGradingAuditDispatchSuppression,
  type GenerationAncestryProbe,
  type GradingAuditLaunchContext,
} from '../../grading-integrity';
import type { ScorecardGradingAudit } from '../../harness/improvements/observation-types';
import { killTask } from '../../task-manager/control';
import { listTasks } from '../../task-manager/store';
import { isTerminalState, type TaskRow } from '../../task-manager/types';
import {
  readHarnessTestRunEvidence,
  type HarnessTestRunEvidence,
} from '../../testing-run-store';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { emitScorecardEmitted } from '../../scorecard-emitted-events';
import {
  evaluateCriterionCargoChecks,
  evaluateCriterionProbeChecks,
  evaluateCriterionTestChecks,
  evaluateCriterionCoverageChecks,
  evaluateCriterionRequirementChecks,
  runCriterionCheckFiles,
  type CriterionCheckRunner,
  type CriterionCheckRunnerResult,
} from '../../rubrics-criterion-checks';
import { getEffectiveItemAudits, getLatestActivationAudit, getPlanItemStatuses } from '../../plan-audits';
import { resolveHarnessPaths } from '../../resolve-harness-paths';
import { resolvePlanHarnessSlug } from '../plans/source';

/**
 * The `planTouched` reverse map: every implementing file the subject plan's work-items
 * recorded as changed, deduped. Returns [] when the plan exists but nothing recorded a
 * `filesChanged` — the CALLER distinguishes that from null (no plan subject at all), and
 * both refuse the check rather than widening its scope to the whole census.
 */
async function planTouchedFiles(workspaceId: string, planSlug: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows: { f: string }[] = await sql`
    SELECT DISTINCT jsonb_array_elements_text(
             COALESCE(payload->${TERMINAL_COMPLETION_EVIDENCE_KEY}->'filesChanged', '[]'::jsonb)
           ) AS f
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND source_plan_slug = ${planSlug}
  `;
  return rows.map((r) => r.f).filter((f) => typeof f === 'string' && f.trim() !== '');
}
import { readCoverage } from '../testing/coverage';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { trackDetached } from '../../detached-imports';
import { areAcceptanceLineageRelated, isAcceptanceAuthorIdentity } from '../../acceptance-author-identity';
import { acceptanceSeatRefusalHint, resolveAcceptanceSeatSuccession } from '../../acceptance-seat-succession';
import { readAndEvaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
import { evidenceCurrentInputSchema } from '../plans/spec-evidence-store';
import { runtimeCitationRefusal } from '../../acceptance-runtime-citation';
// TYPE-ONLY (erased at runtime) — see defaultResolveAuthorSessionState below,
// which mirrors rebind-identity.ts's own dynamic-import discipline for the
// same oracle so this write-path module never carries it on its static graph.
import type { SessionState } from '../coordination/presence-wakeability';

/**
 * A tests-backed scorecard is intentionally a long-running write: it shells one
 * batched Vitest run before filing.  Keep the inner run comfortably inside the
 * tool's declared timeout so process-group settlement, the ledger write, and MCP
 * serialization cannot lose a race to the transport deadline.
 */
/**
 * scorecards:emit accepts deterministic checks spanning up to 50 files. A real
 * 16-file Papercusp acceptance batch takes roughly four minutes, so the old
 * two-minute inner budget rejected a fully green run before it could be filed.
 * Scale that observed batch to the schema cap (12.5 minutes), round up to 13,
 * and keep two more minutes outside the runner for process-group settlement,
 * the ledger write, and MCP serialization.
 */
export const SCORECARD_EMIT_TIMEOUT_SEC = 15 * 60;
export const SCORECARD_TEST_CHECK_TIMEOUT_MS = 13 * 60_000;

/**
 * A scorecard check process can survive an API restart while its caller cannot.
 * The exact request identity gives that process a predictable test-run group;
 * its task row is the pre-result receipt, and test_runs supplies per-file proof.
 * Failed or unjudgeable attempts advance to a new group instead of mixing rows.
 */
export function scorecardCheckRunPrefix(input: {
  rubricRef: string;
  rubricRevision: number | null;
  criteriaHash: string | null;
  evidenceFingerprint: string;
  createdBy: string;
  subjectRef: string | null;
  operationRef?: string;
  workspaceId: string;
  harnessSlug: string;
  root: string;
  sourceSha: string;
  files: readonly string[];
}): string {
  const identity = [
    input.rubricRef,
    input.rubricRevision,
    input.criteriaHash,
    input.evidenceFingerprint,
    input.createdBy,
    input.subjectRef,
    input.operationRef ?? null,
    input.workspaceId,
    input.harnessSlug,
    input.root,
    input.sourceSha,
    [...input.files].sort(),
  ];
  return `scorecard-check-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 40)}`;
}

/** The only row shape that can stand in for an interrupted check-run response. */
export function recoverScorecardCheckRun(input: {
  rows: readonly HarnessTestRunEvidence[];
  task: Pick<TaskRow, 'state' | 'exitCode'> | undefined;
  runId: string;
  files: readonly string[];
  root: string;
  sourceSha: string;
  workspaceId: string;
  harnessSlug: string;
}): CriterionCheckRunnerResult | null {
  if (!input.task || !isTerminalState(input.task.state) || input.rows.length !== input.files.length) return null;
  const ids = input.rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length || new Set(input.files).size !== input.files.length) return null;
  const expectedFiles = new Set(input.files);
  const seenFiles = new Set<string>();
  const byFile: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }> = {};
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of input.rows) {
    const details = parseTestRunExecutionDetails(row.execution_details);
    if (
      !Number.isSafeInteger(row.id) || row.id <= 0 || !expectedFiles.has(row.file_path) || seenFiles.has(row.file_path) ||
      row.finished_at === null || row.workspace_id !== input.workspaceId || row.harness_slug !== input.harnessSlug ||
      row.run_group_id !== input.runId || row.commit_sha !== input.sourceSha || !details ||
      details.root !== input.root || details.filePath !== row.file_path || details.runGroupId !== input.runId ||
      details.workspaceId !== input.workspaceId || details.harnessSlug !== input.harnessSlug ||
      details.commitSha !== input.sourceSha || details.worktreeDirty !== row.worktree_dirty ||
      details.testNamePattern !== null || details.mutationPhase !== null || details.collectionFailed
    ) return null;
    // A dirty shared checkout is still an actual grading-time run. The ordinary
    // scorecard path accepts it; spec-evidence's clean-tree provenance validator
    // is intentionally stricter and cannot be reused here. Preserve the exact
    // run IDs so readers can inspect its dirty flag instead of claiming clean.
    if (row.status === 'pass' && (details.passed === 0 || details.failed !== 0)) return null;
    if (row.status === 'fail' && details.failed === 0) return null;
    if (row.status === 'skip' && details.passed + details.failed !== 0) return null;
    if (row.status !== 'pass' && row.status !== 'fail' && row.status !== 'skip') return null;
    byFile[row.file_path] = {
      passed: details.passed,
      failed: details.failed,
      skipped: details.skipped,
      collectionFailed: false,
    };
    passed += details.passed;
    failed += details.failed;
    skipped += details.skipped;
    seenFiles.add(row.file_path);
  }
  if (seenFiles.size !== expectedFiles.size) return null;
  // A known nonzero router exit contradicts a green reporter result. An
  // ended_unobserved scope has no exit code, so its complete ledger is the
  // same conservative fallback used by testing:run-status.
  if (failed === 0 && input.task.exitCode != null && input.task.exitCode !== 0) return null;
  return {
    ok: failed === 0,
    runId: input.runId,
    root: input.root,
    files: input.rows.length,
    passed,
    failed,
    skipped,
    byFile,
    failures: [],
    failuresTruncated: failed > 0,
    durationMs: null,
    testRunIds: ids,
  };
}

export async function runRecoverableScorecardChecks(
  opts: Parameters<CriterionCheckRunner>[0],
  binding: {
    rubricRef: string;
    rubricRevision: number | null;
    criteriaHash: string | null;
    evidenceFingerprint: string;
    createdBy: string;
    subjectRef: string | null;
    operationRef?: string;
  },
  deps: {
    readRows?: typeof readHarnessTestRunEvidence;
    listTaskRows?: (launchedBy: string, workspaceId: string) => Promise<Array<Pick<TaskRow, 'state' | 'exitCode'>>>;
    runFiles?: CriterionCheckRunner;
    sourceSha?: (root: string) => string | null;
  } = {},
): Promise<CriterionCheckRunnerResult> {
  const runFiles = deps.runFiles ?? runCriterionCheckFiles;
  const workspaceId = opts.workspaceId;
  const harnessSlug = opts.harnessSlug;
  const sourceSha = (deps.sourceSha ?? ((root) => realGitProbe.revParse(root, 'HEAD')))(opts.root);
  // Non-repository or unattributed rubrics retain the ordinary route. They
  // cannot make a durable replay claim because its source/scope is unknown.
  if (!sourceSha || !workspaceId || !harnessSlug) return runFiles(opts);
  const prefix = scorecardCheckRunPrefix({
    ...binding,
    workspaceId,
    harnessSlug,
    root: opts.root,
    sourceSha,
    files: opts.files,
  });
  const readRows = deps.readRows ?? readHarnessTestRunEvidence;
  const listTaskRows = deps.listTaskRows ?? ((launchedBy: string, ws: string) =>
    listTasks({ launchedBy, workspaceId: ws, includeEnded: true, limit: 2 }));
  // Three bounded attempts allow a terminal invalid run to be replaced while
  // every same-payload replay still starts by reconciling the earlier groups.
  for (let attempt = 0; attempt < 3; attempt++) {
    const runId = `${prefix}-${attempt}`;
    let rows: Awaited<ReturnType<typeof readRows>>;
    let tasks: Awaited<ReturnType<typeof listTaskRows>>;
    try {
      [rows, tasks] = await Promise.all([
        readRows({ workspaceId, harnessSlug, runGroupId: runId }),
        listTaskRows(`testing:run:${runId}`, workspaceId),
      ]);
    } catch {
      return {
        ok: false, runId, root: opts.root, error: 'route_error',
        hint: 'scorecard task or test ledger could not be read; replay outcome remains unknown',
      };
    }
    if (rows === null) {
      return {
        ok: false, runId, root: opts.root, error: 'route_error',
        hint: 'scorecard check ledger is unavailable; cannot determine whether this request already ran',
      };
    }
    if (tasks.some((task) => !isTerminalState(task.state) && task.state !== 'pending' && task.state !== 'running')) {
      return {
        ok: false, runId, root: opts.root, error: 'route_error',
        hint: `scorecard check task ${runId} has an indeterminate state; verify the task before retrying`,
      };
    }
    const pending = tasks.some((task) => !isTerminalState(task.state));
    if (pending) {
      return {
        ok: false, runId, root: opts.root, error: 'timeout',
        hint: `scorecard check run ${runId} is not terminal after a caller interruption; verify its task state and retry this exact emit later`,
      };
    }
    if (tasks.length === 1 && rows.length > 0) {
      const recovered = recoverScorecardCheckRun({
        rows, task: tasks[0], runId, files: opts.files, root: opts.root,
        sourceSha, workspaceId, harnessSlug,
      });
      if (recovered) return recovered;
    }
    if (tasks.length === 0 && rows.length === 0) return runFiles({ ...opts, runId });
  }
  return {
    ok: false, runId: `${prefix}-2`, root: opts.root, error: 'route_error',
    hint: 'three request-bound scorecard check attempts ended without complete trustworthy evidence',
  };
}

/**
 * scorecards:emit's final read and ledger write form one deduplication critical
 * section. The observation ledger's capture helper has its own atomic INSERT,
 * but the scorecard fingerprint is computed by this caller before that INSERT;
 * two emitters can therefore both observe an empty history and append the same
 * card unless the read-to-write gap is serialized.
 *
 * This is a SESSION-level advisory lock, so it must use a dedicated direct
 * connection. The org client may be routed through PgBouncer transaction
 * pooling, which can move consecutive lock/read/unlock statements across
 * backends and leak the session lock. `reserve()` pins the whole critical
 * section to one backend and `idle_timeout: 0` keeps it alive while the capture
 * helper is doing its work.
 */
const SCORECARD_EMIT_MUTEX_NAMESPACE = 'scorecards:emit:dedup';
let _scorecardEmitMutexSql: postgres.Sql | null = null;

export function scorecardEmitMutexUrl(): string {
  return getHarnessAdminUrl();
}

function scorecardEmitMutexSql(): postgres.Sql {
  if (!_scorecardEmitMutexSql) {
    _scorecardEmitMutexSql = postgres(scorecardEmitMutexUrl(), {
      onnotice: () => {},
      max: 1,
      idle_timeout: 0,
      connection: {
        application_name: `pcusp:scorecard-emit-mutex:p${process.pid}`.slice(0, 63),
      },
    });
  }
  return _scorecardEmitMutexSql;
}

/** Test-only — close + drop the dedicated scorecard emit mutex connection. */
export async function _closeScorecardEmitMutexForTests(): Promise<void> {
  if (_scorecardEmitMutexSql) {
    await _scorecardEmitMutexSql.end({ timeout: 1 }).catch(() => {});
    _scorecardEmitMutexSql = null;
  }
}

export function scorecardEmitMutexKey(input: {
  workspaceId: string;
  rubricRef: string;
  sourceHive?: string;
}): string {
  // The final scorecard history read is partitioned by workspace, rubric and
  // sourceHive. Keep the same scope here; subject is intentionally omitted
  // because the final read also omits subjectRef, and a narrower lock would not
  // protect that actual read/write predicate.
  return [
    SCORECARD_EMIT_MUTEX_NAMESPACE,
    input.workspaceId,
    input.rubricRef,
    input.sourceHive ?? '<unscoped>',
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}

type ScorecardEmitMutexReservation = Awaited<ReturnType<ReturnType<typeof scorecardEmitMutexSql>['reserve']>>;

async function acquireScorecardEmitMutex(key: string): Promise<() => Promise<void>> {
  const reserved: ScorecardEmitMutexReservation = await scorecardEmitMutexSql().reserve();
  let acquired = false;
  try {
    // The harness_admin role carries a finite lock_timeout (currently 15s), and
    // may also acquire a statement_timeout in a future policy revision. This
    // rendezvous is deliberately allowed to wait for an in-flight emitter: the
    // tool itself has a 15-minute budget, while either inherited setting would
    // abort a valid second emit long before that budget. Clear both session
    // limits before the blocking lock, matching the backup/boot rendezvous
    // contract. The client is dedicated to this mutex and never runs ordinary
    // application queries.
    await reserved`SET lock_timeout = 0`;
    await reserved`SET statement_timeout = 0`;
    await reserved`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    acquired = true;
    return async () => {
      if (!acquired) return;
      acquired = false;
      try {
        // If the backend has died, PostgreSQL already released the session lock;
        // still drop the reserved client so a future emit can reconnect cleanly.
        await reserved`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => {});
      } finally {
        reserved.release();
      }
    };
  } catch (error) {
    reserved.release();
    throw error;
  }
}

const specTestAdequacyFingerprintSchema = z.string().trim().min(1).max(256);
const specTestAdequacyEvaluatorBuildSchema = z
  .object({
    // `sha:null` is an honest identity for a bundled evaluator that cannot prove
    // its source revision; the version remains useful for distinguishing builds.
    sha: z.string().trim().min(1).max(256).nullable(),
    version: z.string().trim().min(1).max(120),
  })
  .strict();
const specTestAdequacyCurrentFingerprintSchema = z
  .object({
    // Exact clause identity prevents one shared artifact reference from
    // overwriting another clause's currentness tuple. Omit all four only for
    // historical legacy recipes.
    planSlug: z.string().trim().min(1).max(2000).optional(),
    specId: z.string().trim().min(1).max(2000).optional(),
    specRevision: z.number().int().positive().optional(),
    specFingerprint: specTestAdequacyFingerprintSchema.optional(),
    evidenceKind: z.string().trim().min(1).max(120),
    evidenceRef: z.string().trim().min(1).max(2000),
    sourceFingerprint: specTestAdequacyFingerprintSchema,
    // A producer may omit dimensions it did not measure; explicit null keeps
    // the same meaning for callers that already spell those keys.
    testFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
    fixtureFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
    rubricFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
    environmentFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const identity = [input.planSlug, input.specId, input.specRevision, input.specFingerprint];
    if (identity.some((value) => value !== undefined) && !identity.every((value) => value !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planSlug'],
        message: 'planSlug, specId, specRevision, and specFingerprint must be supplied together',
      });
    }
  });
const specTestAdequacyRerunRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: z.literal('plans:evaluate-spec-test-adequacy'),
    // Optional for historical cards; current evaluator output always stamps it.
    evaluatorBuild: specTestAdequacyEvaluatorBuildSchema.optional(),
    // P-043: the evaluator RULE revision the verdicts were graded under. Optional for
    // cards minted before the stamp; current evaluator output always stamps it.
    evaluatorRevision: z.number().int().positive().optional(),
    // The plan class the recorded verdicts were produced under. REQUIRED by the
    // evaluator and it materially moves `plan-class-risk-floor`, so a card that did
    // not record it forced a re-runner to GUESS one of four values — a wrong guess
    // silently changes the verdict it is supposed to reproduce.
    classRef: z.enum(PLAN_CLASS_RUBRIC_REFS),
    // The exact argument object to submit to the evaluator. Validated against the
    // evaluator's OWN exported schema rather than a hand-copied list of field names:
    // a restated copy here would pass through exactly the drift it exists to catch.
    // `selection` below is the human-readable identity of what was graded and is NOT
    // submittable (it spells planSlug/specId/specRevision/specFingerprint, which the
    // evaluator refuses); this field is what makes a card independently re-runnable.
    args: evaluatorArgsSchema,
    selection: z
      .object({
        planSlug: z.string().trim().min(1).max(120),
        specId: z.string().trim().min(1).max(200),
        specRevision: z.number().int().positive(),
        specFingerprint: specTestAdequacyFingerprintSchema,
        evidence: z
          .array(
            z
              .object({
                evidenceKind: z.string().trim().min(1).max(120),
                evidenceRef: z.string().trim().min(1).max(2000),
              })
              .strict(),
          )
          .max(500),
        // The evaluator pins immutable binding rows as well as their references.
        // Reuse its selector schema so a generated replay keeps the same cohort.
        bindingIds: evaluatorArgsSchema.shape.bindingIds,
      })
      .strict(),
    current: z
      .object({
        supplied: z.boolean(),
        fingerprints: z
          .array(specTestAdequacyCurrentFingerprintSchema)
          .max(500),
      })
      .strict(),
    derivation: z
      .object({
        kind: z.literal('listSpecEvidence.currentness'),
        classifier: z.literal('classifySpecEvidenceCurrentness'),
        unknownWhenMissing: z.literal(true),
      })
      .strict(),
  })
  .strict();

const scorecardEmitBaseShape = {
    rubricRef: z.string().min(1).max(120),
    sourceHive: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Producing/grader hive; defaults to caller hive. For cross-hive grading put the subject plan's hive in targetHive.",
      ),
    targetHive: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Subject plan/repository hive; directs deterministic checks to that tree. Independent of sourceHive.",
      ),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(8000).optional(),
    ratings: z
      .record(z.string().min(1), scorecardRatingEntrySchema)
      .optional()
      .describe(
        "Complete per-criterion ratings. Required on every emit EXCEPT an acceptance author's verdict that supplies `acceptanceOf` — there the server adopts the referenced independent card's ratings verbatim, so the persisted card is still schema-complete without the author re-transcribing a grading they did not perform.",
      ),
    testedSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional()
      .describe(
        'Commit SHA the supplied ratings actually tested. Required when a releaseGating rubric contains any pass-like rating; emit proves it is both the fresh green pin and current staging HEAD before filing.',
      ),
    acceptance: z
      .object({
        verdict: z.enum(['accept', 'reject', 'accept-pending-delivery']),
        reasoning: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional()
      .describe(
        "The acceptance-rubric AUTHOR's post-grading call. Valid only for kind:'acceptance', required when that author emits, and refused until a complete independent grading exists. The persisted card always carries complete ratings: either supply them in `ratings`, or name the exact independent card in `acceptanceOf` and the server adopts that card's ratings verbatim (no re-transcription). Independent graders omit it. Use 'accept-pending-delivery' when the graded work is accepted and the ONLY outstanding obligation is evidence on a delivery plane you cannot reach (a deployed/live BAR behind a gate or a deploy another agent owns): 'accept' would overclaim delivery and 'reject' would be false, so this records the acceptance judgment durably while leaving the delivery fact separately open. It does NOT waive the delivery-plane evidence, which keeps blocking on its own code.",
      ),
    acceptanceOf: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "The EXACT independent scorecard this acceptance verdict responds to (its issue id, e.g. 'EI-123…'). Valid only alongside `acceptance`. Naming it lets you omit `ratings`: the server re-reads that card, re-checks it against the same independence, completeness and current-revision rails the scan applies, and adopts its ratings verbatim into your card, stamping ratingsProvenance so the adoption stays auditable. Prefer it over omitting the reference — without it the server accepts whatever independent card it finds first, which may not be the one you read.",
      ),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    current: z
      .array(evidenceCurrentInputSchema)
      .max(2000)
      .optional()
      .describe(
        'Fresh evidence fingerprints for requirements checks, identical to plans:get current. Required to establish non-code operational outcomes; omitted comparisons remain unknown.',
      ),
    rerunRecipe: specTestAdequacyRerunRecipeSchema.optional(),
    subject: z
      .object({
        kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
        ref: z.string().min(1).max(200),
        windowStart: z.string().min(1).max(64).optional(),
        windowEnd: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional()
      .describe(
        "WHAT this scorecard grades (stored as observation.subject) — e.g. { kind:'rubric', ref:'<rubricId>' } on a vetting card.",
      ),
    gradingAuditReservation: z
      .object({
        key: z.string().min(1).max(240),
        reservedAt: z.string().min(1).max(64),
      })
      .strict()
      .optional()
      .describe(
        'For a grading-integrity audit of a pending scorecard with dispatchReservation, copy the exact key and reservedAt from your dispatch brief. The server refuses a missing, stale, or mismatched lease before filing the audit card. Omit only for legacy pending cards with no reservation or explicit corrections to an already-settled audit.',
      ),
    vettingUnanswered: z
      .boolean()
      .optional()
      .describe(
        'Attest that the cited vetting consult received NO critique (every routed reviewer was dead/parked or it expired unanswered) and you are proceeding anyway. Requires BOTH `vettingConsult` and `vettingUnansweredReason`, and is REFUSED when the consult did receive critique — this is the recorded-waiver path, not a way to skip reading replies. Stamped visibly as observation.vetting.unanswered so a later reader can tell a vetted rubric from an un-critiqued one.',
      ),
    vettingUnansweredReason: z
      .string()
      .min(24)
      .max(500)
      .optional()
      .describe(
        'Why no critique was available (required with `vettingUnanswered`). Name what you actually observed — e.g. "all 3 routed reviewers ended; consult expired 19:54Z with 0 posts" — not "no reply yet".',
      ),
    supersedes: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Issue id of the earlier scorecard this corrected filing replaces.'),
    terminal: z
      .boolean()
      .optional()
      .describe(
        "Affirm the graded SUBJECT has terminated (P-008). Without it, rating any 'violatable'-class criterion stamps the card PROVISIONAL — a working note excluded from rubrics:trend until a terminal re-emit (terminal:true, supersedes the interim) makes the grading final.",
      ),
    force: z
      .boolean()
      .optional()
      .describe('File even when the canonical evidence fingerprint matches the latest scorecard.'),
    acknowledgeExisting: z
      .literal(true)
      .optional()
      .describe(
        'Acknowledge that complete independent scorecards already exist for this rubric revision. Required to append another; force:true only bypasses unchanged-evidence deduplication and never substitutes for this acknowledgement.',
      ),
};

const vettingConsultField = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Vetting consult for a meta-rubric scorecard about subject:{ kind:'rubric', ref }. The rubric must exist; the consult's opening question must identify it or its subject plan and include a third-party reply. Pass exactly one of vettingConsult or vettingWorkItem.",
  );

const vettingWorkItemField = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Vetting work-item for a meta-rubric scorecard about subject:{ kind:'rubric', ref }. Requires a third-party comment by someone other than the emitter and rubric author. Pass exactly one of vettingConsult or vettingWorkItem; vettingUnanswered is consult-only.",
  );

/**
 * Keep the alternate vetting channels visible in the published argument schema.
 * The runtime handler has always refused both links together; a root XOR makes
 * the same rule discoverable to clients before dispatch while retaining the
 * valid neither-channel shape for ordinary scorecards.
 */
export const scorecardEmitArgs = z.xor([
  z
    .object({
      ...scorecardEmitBaseShape,
      vettingConsult: vettingConsultField,
      vettingWorkItem: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...scorecardEmitBaseShape,
      vettingConsult: z.never().optional(),
      vettingWorkItem: vettingWorkItemField,
    })
    .strict(),
  z
    .object({
      ...scorecardEmitBaseShape,
      vettingConsult: z.never().optional(),
      vettingWorkItem: z.never().optional(),
    })
    .strict(),
]);

type SpecTestAdequacyBindingError = {
  code: 'invalid_spec_test_adequacy_binding';
  error: string;
};

type SpecTestAdequacyReplayRow = {
  specId?: unknown;
  specRevision?: unknown;
  specFingerprint?: unknown;
  verdict?: unknown;
  wouldBlock?: unknown;
  ratings?: unknown;
};

type SpecTestAdequacyEvaluatorBuild = z.infer<typeof specTestAdequacyEvaluatorBuildSchema>;

function isSameEvaluatorBuild(a: SpecTestAdequacyEvaluatorBuild, b: SpecTestAdequacyEvaluatorBuild): boolean {
  return a.sha === b.sha && a.version === b.version;
}

/**
 * `ctx.dispatchTool` returns a ToolResult, while in-process test seams commonly
 * return the already-unwrapped evaluator payload. Accept both forms and decode
 * the lossless TOON form used by the MCP serializer. A replay guard that reads
 * compact text as if it were JSON would silently skip the very check it exists
 * to enforce.
 */
function unwrapSpecTestAdequacyReplay(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const candidate = result as {
    structuredContent?: unknown;
    content?: ReadonlyArray<unknown>;
    data?: unknown;
  };
  if (candidate.structuredContent !== undefined) return unwrapSpecTestAdequacyReplay(candidate.structuredContent);
  if (candidate.data !== undefined && !Array.isArray(candidate.content)) {
    return unwrapSpecTestAdequacyReplay(candidate.data);
  }
  const textItem = candidate.content?.find(
    (item): item is { text: string } =>
      !!item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string',
  );
  if (!textItem) return result;
  const text = textItem.text;
  const toonMarker = /^format:\s*toon\n/.exec(text);
  if (toonMarker) {
    try {
      return unwrapSpecTestAdequacyReplay(decode(text.slice(toonMarker[0].length), 'toon'));
    } catch {
      return undefined;
    }
  }
  try {
    return unwrapSpecTestAdequacyReplay(JSON.parse(text));
  } catch {
    return unwrapSpecTestAdequacyReplay(parseJsonWithTrailer(text)?.value);
  }
}

/**
 * The replay guard compares only clause identity, criterion ratings, and
 * wouldBlock. Replaying an evaluator-authored `detail:"full"` recipe needlessly
 * materializes every evidence narrative and another scorecard draft; real plans
 * can exceed the result door and return a spill envelope instead of the payload
 * the guard must inspect. Force the evaluator's contract-equivalent summary
 * shape while retaining full-tier materialization so those compact fields are
 * never tier-trimmed.
 */
function compactSpecTestAdequacyReplayArgs(
  replayArgs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...replayArgs,
    detail: 'summary',
    includeDraft: false,
    payloadTier: 'full',
  };
}

/**
 * Re-run the evaluator before persisting a spec-test-adequacy card. The card's
 * ratings are caller input; the evaluator is the policy writer for
 * plan-class-risk-floor. Without this read-back, a caller can submit `pass`
 * for a criterion whose exact replay is `unknown`/blocked and the ledger will
 * preserve the over-claim as if it were measured evidence.
 */
async function validateSpecTestAdequacyReplay(
  args: z.infer<typeof scorecardEmitArgs>,
  dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined,
): Promise<SpecTestAdequacyBindingError | undefined> {
  if (args.rubricRef !== SPEC_TEST_ADEQUACY_RUBRIC_REF || !args.rerunRecipe || !dispatchTool) return undefined;

  const parsedRecipe = specTestAdequacyRerunRecipeSchema.safeParse(args.rerunRecipe);
  if (!parsedRecipe.success) return undefined;
  const submittedPasses = Object.entries(args.ratings ?? {}).filter(
    ([, entry]) => ratingVerdict(entry.rating) === 'pass',
  );
  if (submittedPasses.length === 0) return undefined;

  // New recipes carry the pin in both the human-readable recipe and the exact
  // evaluator args. Historical cards may only have the former, so thread that
  // pin into the replay call when the args predate the pin. Without this fallback
  // a repaired evaluator cannot tell that it is replaying an older card.
  const recordedEvaluatorBuild = parsedRecipe.data.evaluatorBuild ?? parsedRecipe.data.args.evaluatorBuild;
  const replayArgs = {
    ...parsedRecipe.data.args,
    ...(recordedEvaluatorBuild && !parsedRecipe.data.args.evaluatorBuild
      ? { evaluatorBuild: recordedEvaluatorBuild }
      : {}),
  };

  let replay: unknown;
  try {
    replay = unwrapSpecTestAdequacyReplay(
      await dispatchTool('plans:evaluate-spec-test-adequacy', compactSpecTestAdequacyReplayArgs(replayArgs)),
    );
  } catch (error) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' could not replay its evaluator before filing: ` +
        `${error instanceof Error ? error.message : String(error)}; no pass-like rating was persisted`,
    };
  }

  const payload =
    replay && typeof replay === 'object' && !Array.isArray(replay)
      ? (replay as {
          ok?: unknown;
          rows?: unknown;
          error?: unknown;
          evaluatorBuild?: unknown;
          evaluatorBuildDrift?: unknown;
        })
      : null;
  if (payload?.ok === false) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' evaluator replay refused: ` +
        `${typeof payload.error === 'string' ? payload.error : 'unknown evaluator error'}; no pass-like rating was persisted`,
    };
  }
  if (recordedEvaluatorBuild) {
    const drift = payload?.evaluatorBuildDrift;
    if (drift && typeof drift === 'object' && !Array.isArray(drift)) {
      return {
        code: 'invalid_spec_test_adequacy_binding',
        error:
          `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' cannot certify replay across evaluator-build drift: ` +
          `${JSON.stringify(drift)}; re-run the card with the recorded evaluator build or explicitly re-grade it; ` +
          'no pass-like rating was persisted',
      };
    }
    const liveEvaluatorBuild = payload?.evaluatorBuild;
    if (!liveEvaluatorBuild || typeof liveEvaluatorBuild !== 'object' || Array.isArray(liveEvaluatorBuild)) {
      return {
        code: 'invalid_spec_test_adequacy_binding',
        error:
          `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' evaluator replay did not return its live evaluatorBuild; ` +
          'build identity is required to certify a pinned replay; no pass-like rating was persisted',
      };
    }
    const parsedLiveBuild = specTestAdequacyEvaluatorBuildSchema.safeParse(liveEvaluatorBuild);
    if (!parsedLiveBuild.success || !isSameEvaluatorBuild(recordedEvaluatorBuild, parsedLiveBuild.data)) {
      return {
        code: 'invalid_spec_test_adequacy_binding',
        error:
          `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' evaluator replay changed build identity ` +
          `(recorded=${JSON.stringify(recordedEvaluatorBuild)}, live=${JSON.stringify(liveEvaluatorBuild)}); ` +
          'no pass-like rating was persisted',
      };
    }
  }
  const rows = Array.isArray(payload?.rows) ? (payload.rows as SpecTestAdequacyReplayRow[]) : [];
  const selection = parsedRecipe.data.selection;
  const row = rows.find(
    (candidate) =>
      candidate &&
      candidate.specId === selection.specId &&
      candidate.specRevision === selection.specRevision &&
      (candidate.specFingerprint === undefined || candidate.specFingerprint === selection.specFingerprint),
  );
  if (!row) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' evaluator replay returned no row for ` +
        `${selection.planSlug}/${selection.specId}@${selection.specRevision}; no pass-like rating was persisted`,
    };
  }

  const replayRatings =
    row.ratings && typeof row.ratings === 'object' && !Array.isArray(row.ratings)
      ? (row.ratings as Record<string, { rating?: unknown }>)
      : {};
  const wouldBlock = Array.isArray(row.wouldBlock)
    ? row.wouldBlock.filter((key): key is string => typeof key === 'string')
    : [];
  for (const [criterion, submitted] of submittedPasses) {
    const replayRating = replayRatings[criterion];
    const replayVerdict =
      replayRating && typeof replayRating.rating === 'string' ? ratingVerdict(replayRating.rating) : null;
    if (replayVerdict !== 'pass' || wouldBlock.includes(criterion)) {
      return {
        code: 'invalid_spec_test_adequacy_binding',
        error:
          `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' cannot claim ${criterion}='${submitted.rating}' ` +
          `when the exact evaluator replay returns '${typeof replayRating?.rating === 'string' ? replayRating.rating : 'unknown'}' ` +
          `${wouldBlock.includes(criterion) ? `and wouldBlock includes '${criterion}'` : ''}; ` +
          'use the evaluator ratings returned by plans:evaluate-spec-test-adequacy',
      };
    }
  }
  return undefined;
}

type GradingAuditReplayConsistencyError = {
  code: 'grading_audit_replay_uncorroborated' | 'grading_audit_replay_consistent' | 'grading_audit_evaluator_changed';
  error: string;
};

/**
 * A grading-integrity audit can call the target card's exact evaluator recipe
 * "re-runnable" while separately claiming its uniform distribution is false.
 * For spec-test-adequacy cards the evaluator owns those ratings, so corroborate
 * that claimed contradiction before the audit is allowed to settle the card.
 *
 * Exported so the evaluate-and-emit round trip (plans/certify-spec-clauses.test.ts,
 * clause RSR-P-005-A) can run THIS auditor replay on a card as it was persisted — a
 * copy of the comparison in a test would prove nothing about the auditor.
 */
export async function validateGradingAuditReplayConsistency(
  gradedObservation: NonNullable<ReturnType<typeof asStructuredObservation>>,
  auditRatings: z.infer<typeof scorecardEmitArgs>['ratings'],
  dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined,
  historicalContext?: { gradedCardCreatedAt?: string; workspaceId?: string },
): Promise<GradingAuditReplayConsistencyError | undefined> {
  if (
    gradedObservation.rubricRef !== SPEC_TEST_ADEQUACY_RUBRIC_REF ||
    !gradedObservation.rerunRecipe ||
    ratingVerdict(auditRatings?.['re-runnable-evidence']?.rating ?? '') !== 'pass' ||
    ratingVerdict(auditRatings?.['degenerate-distribution']?.rating ?? '') !== 'fail'
  ) {
    return undefined;
  }

  const parsedRecipe = specTestAdequacyRerunRecipeSchema.safeParse(gradedObservation.rerunRecipe);
  if (!parsedRecipe.success || !dispatchTool) {
    return {
      code: 'grading_audit_replay_uncorroborated',
      error:
        `grading-integrity cannot accept degenerate-distribution='fail' alongside ` +
        `re-runnable-evidence='pass': the graded spec-test-adequacy card's exact evaluator recipe ` +
        'could not be replayed server-side; no audit card was persisted',
    };
  }

  const recordedEvaluatorBuild = parsedRecipe.data.evaluatorBuild ?? parsedRecipe.data.args.evaluatorBuild;
  const replayArgs = {
    ...parsedRecipe.data.args,
    ...(recordedEvaluatorBuild && !parsedRecipe.data.args.evaluatorBuild
      ? { evaluatorBuild: recordedEvaluatorBuild }
      : {}),
  };

  let replay: unknown;
  try {
    replay = unwrapSpecTestAdequacyReplay(
      await dispatchTool('plans:evaluate-spec-test-adequacy', compactSpecTestAdequacyReplayArgs(replayArgs)),
    );
  } catch (error) {
    return {
      code: 'grading_audit_replay_uncorroborated',
      error:
        `grading-integrity cannot accept degenerate-distribution='fail' alongside ` +
        `re-runnable-evidence='pass': the server-side evaluator replay failed ` +
        `(${error instanceof Error ? error.message : String(error)}); no audit card was persisted`,
    };
  }

  let payload =
    replay && typeof replay === 'object' && !Array.isArray(replay)
      ? (replay as {
          ok?: unknown;
          rows?: unknown;
          error?: unknown;
          evaluatorBuild?: unknown;
          evaluatorBuildDrift?: unknown;
          historicalAuditOnly?: unknown;
        })
      : null;
  if (
    payload?.ok === false &&
    payload.error === 'selection_empty' &&
    parsedRecipe.data.args.bindingIds === undefined &&
    parsedRecipe.data.selection.bindingIds === undefined &&
    (parsedRecipe.data.args.evidenceRefs?.length ?? 0) > 0
  ) {
    const createdAt = historicalContext?.gradedCardCreatedAt;
    const auditAsOf = createdAt ? new Date(createdAt) : null;
    if (!auditAsOf || !Number.isFinite(auditAsOf.getTime()) || !historicalContext?.workspaceId) {
      return {
        code: 'grading_audit_replay_uncorroborated',
        error:
          'grading-integrity cannot use the legacy historical replay because the graded card creation time or workspace scope is unavailable; no audit card was persisted',
      };
    }
    try {
      replay = await replaySpecTestAdequacyForHistoricalAudit({
        args: {
          ...parsedRecipe.data.args,
          ...(recordedEvaluatorBuild && !parsedRecipe.data.args.evaluatorBuild
            ? { evaluatorBuild: recordedEvaluatorBuild }
            : {}),
        },
        selection: parsedRecipe.data.selection,
        workspaceId: historicalContext.workspaceId,
        auditAsOf,
      });
    } catch (error) {
      return {
        code: 'grading_audit_replay_uncorroborated',
        error:
          `grading-integrity cannot replay the legacy card's historical evidence (${error instanceof Error ? error.message : String(error)}); no audit card was persisted`,
      };
    }
    payload =
      replay && typeof replay === 'object' && !Array.isArray(replay)
        ? (replay as {
            ok?: unknown;
            rows?: unknown;
            error?: unknown;
            evaluatorBuild?: unknown;
            evaluatorBuildDrift?: unknown;
            historicalAuditOnly?: unknown;
          })
        : null;
    const historicalMarker = payload?.historicalAuditOnly;
    if (
      payload?.ok === true &&
      (!historicalMarker ||
        typeof historicalMarker !== 'object' ||
        Array.isArray(historicalMarker) ||
        (historicalMarker as { provenance?: unknown }).provenance !== 'historical-audit-only' ||
        (historicalMarker as { asOf?: unknown }).asOf !== auditAsOf.toISOString() ||
        (historicalMarker as { freshness?: unknown }).freshness !== 'audit-only')
    ) {
      return {
        code: 'grading_audit_replay_uncorroborated',
        error:
          'grading-integrity refused a legacy replay without matching historical audit-only provenance; no audit card was persisted',
      };
    }
  }
  if (payload?.ok === false) {
    return {
      code: 'grading_audit_replay_uncorroborated',
      error:
        `grading-integrity cannot accept degenerate-distribution='fail' alongside ` +
        `re-runnable-evidence='pass': the server-side evaluator replay refused ` +
        `(${typeof payload.error === 'string' ? payload.error : 'unknown evaluator error'}); ` +
        'no audit card was persisted',
    };
  }

  if (recordedEvaluatorBuild) {
    const drift = payload?.evaluatorBuildDrift;
    if (drift && typeof drift === 'object' && !Array.isArray(drift)) {
      return {
        code: 'grading_audit_evaluator_changed',
        error:
          'grading-integrity cannot settle re-runnable evidence from an evaluator-build-drift replay (' +
          JSON.stringify(drift) +
          '); re-emit the target card under the current evaluator build; no audit card was persisted',
      };
    }
    const liveEvaluatorBuild = payload?.evaluatorBuild;
    if (!liveEvaluatorBuild || typeof liveEvaluatorBuild !== 'object' || Array.isArray(liveEvaluatorBuild)) {
      return {
        code: 'grading_audit_evaluator_changed',
        error:
          'grading-integrity cannot settle re-runnable evidence because the evaluator replay omitted its live build identity; ' +
          're-emit the target card under a pinned evaluator build; no audit card was persisted',
      };
    }
    const parsedLiveBuild = specTestAdequacyEvaluatorBuildSchema.safeParse(liveEvaluatorBuild);
    if (!parsedLiveBuild.success || !isSameEvaluatorBuild(recordedEvaluatorBuild, parsedLiveBuild.data)) {
      return {
        code: 'grading_audit_evaluator_changed',
        error:
          'grading-integrity cannot settle re-runnable evidence because the exact evaluator replay changed build identity ' +
          '(recorded=' +
          JSON.stringify(recordedEvaluatorBuild) +
          ', live=' +
          JSON.stringify(liveEvaluatorBuild) +
          '); re-emit the target card under the current evaluator build; no audit card was persisted',
      };
    }
  }

  const selection = parsedRecipe.data.selection;
  const rows = Array.isArray(payload?.rows) ? (payload.rows as SpecTestAdequacyReplayRow[]) : [];
  const row = rows.find(
    (candidate) =>
      candidate &&
      candidate.specId === selection.specId &&
      candidate.specRevision === selection.specRevision &&
      (candidate.specFingerprint === undefined || candidate.specFingerprint === selection.specFingerprint),
  );
  if (!row) {
    return {
      code: 'grading_audit_replay_uncorroborated',
      error:
        `grading-integrity cannot accept degenerate-distribution='fail' alongside ` +
        `re-runnable-evidence='pass': the server-side evaluator replay returned no row for ` +
        `${selection.planSlug}/${selection.specId}@${selection.specRevision}; no audit card was persisted`,
    };
  }

  const replayRatings =
    row.ratings && typeof row.ratings === 'object' && !Array.isArray(row.ratings)
      ? (row.ratings as Record<string, { rating?: unknown }>)
      : {};
  const wouldBlock = new Set(
    Array.isArray(row.wouldBlock) ? row.wouldBlock.filter((key): key is string => typeof key === 'string') : [],
  );
  const gradedRatings: ObservationRatings = gradedObservation.ratings ?? {};
  const liveRatingsForRevision: Record<string, { rating: string }> = {};
  for (const [criterion, replayRating] of Object.entries(replayRatings)) {
    if (typeof replayRating?.rating !== 'string') continue;
    liveRatingsForRevision[criterion] = {
      rating:
        wouldBlock.has(criterion) && ratingVerdict(replayRating.rating) === 'pass'
          ? 'blocked'
          : replayRating.rating,
    };
  }
  for (const criterion of wouldBlock) {
    liveRatingsForRevision[criterion] ??= { rating: 'blocked' };
  }
  const revisionDisposition = adequacyCardRevisionDisposition({
    recordedRevision: parsedRecipe.data.evaluatorRevision,
    recordedRatings: gradedRatings,
    liveRatings: liveRatingsForRevision,
  });
  if (
    revisionDisposition.recordedRevision < revisionDisposition.currentRevision &&
    revisionDisposition.state === 'verdict-changed'
  ) {
    const changedRatings = revisionDisposition.changed
      .map(({ criterion, recorded, current }) => `${criterion} ${recorded ?? 'unrecorded'} -> ${current ?? 'unavailable'}`)
      .join(', ');
    return {
      code: 'grading_audit_evaluator_changed',
      error:
        `grading-integrity cannot classify degenerate-distribution='fail': the spec-test-adequacy evaluator revision ` +
        `changed from ${revisionDisposition.recordedRevision} to ${revisionDisposition.currentRevision} and changed ` +
        `recorded ratings (${changedRatings}); re-emit the target card under the current evaluator revision, then audit it; ` +
        'no audit card was persisted',
    };
  }
  const mismatches = Object.entries(gradedRatings).flatMap(([criterion, graded]) => {
    const gradedVerdict = ratingVerdict(graded.rating);
    if (gradedVerdict === null) return [];
    const replayRating = replayRatings[criterion];
    const replayVerdict =
      replayRating && typeof replayRating.rating === 'string' ? ratingVerdict(replayRating.rating) : null;
    return replayVerdict !== gradedVerdict || wouldBlock.has(criterion) ? [criterion] : [];
  });
  if (mismatches.length > 0) return undefined;

  return {
    code: 'grading_audit_replay_consistent',
    error:
      `grading-integrity cannot accept degenerate-distribution='fail' alongside ` +
      `re-runnable-evidence='pass': the graded card's exact server-side evaluator replay reproduced ` +
      `every applicable rating with no wouldBlock contradiction; no audit card was persisted`,
  };
}

/**
 * The completion gate can only match a spec-test-adequacy card to the exact
 * clause revision selected by the evaluator. Refuse malformed or mismatched
 * bindings at the write boundary so an unmatchable card never enters history.
 */
function validateSpecTestAdequacyBinding(
  args: z.infer<typeof scorecardEmitArgs>,
): SpecTestAdequacyBindingError | undefined {
  if (args.rubricRef !== SPEC_TEST_ADEQUACY_RUBRIC_REF) return undefined;

  if (!args.rerunRecipe) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires the evaluator's rerunRecipe from ` +
        'plans:evaluate-spec-test-adequacy, including its exact selection; do not emit a hand-built adequacy card',
    };
  }

  const parsedRecipe = specTestAdequacyRerunRecipeSchema.safeParse(args.rerunRecipe);
  if (!parsedRecipe.success) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires a valid evaluator rerunRecipe from ` +
        'plans:evaluate-spec-test-adequacy',
    };
  }

  const selection = parsedRecipe.data.selection;
  const expectedRef = specTestAdequacySubjectRef(selection.planSlug, selection.specId, selection.specRevision);
  if (args.subject?.kind !== 'plan' || args.subject.ref !== expectedRef) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires subject:{ kind:'plan', ref:'${expectedRef}' } ` +
        'matching rerunRecipe.selection (the evaluator-owned clause revision)',
    };
  }

  // EI-22657636576670266: the evaluator deliberately returns freshness=unknown
  // when current[] is omitted. A hand-edited or stale caller could nevertheless
  // pair that recipe with a pass-like freshness rating, making an unmeasured
  // proof look current in the persisted card. Refuse the contradiction before
  // any rubric revision read, deduplication, checks, or ledger write. Use the
  // shared rating vocabulary so aliases such as "healthy" cannot bypass it.
  if (parsedRecipe.data.current.supplied === false && ratingVerdict(args.ratings?.freshness?.rating ?? '') === 'pass') {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' cannot claim freshness='pass' when ` +
        'rerunRecipe.current.supplied is false and derivation.unknownWhenMissing is true; ' +
        "use freshness='unknown' or supply the evaluator's current fingerprints",
    };
  }

  return undefined;
}

export async function cleanupAcceptanceGraderTasks(
  rubricRef: string,
  input: { workspaceId?: string } = {},
  deps: {
    list?: typeof listTasks;
    kill?: typeof killTask;
  } = {},
) {
  const prefix = acceptanceGraderLabelPrefix(rubricRef);
  const tasks = await (deps.list ?? listTasks)({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 2_000,
  });
  const matched = tasks.filter(
    (task) =>
      task.detail.headless === true && typeof task.detail.label === 'string' && task.detail.label.startsWith(prefix),
  );
  // EI-21390074563933948: these are THIS rubric's own throwaway headless graders
  // (matched by label prefix), not peer work — so a bare SIGTERM that the grader
  // tree shrugs off must ESCALATE on a bounded grace instead of returning
  // incomplete and leaving 20+ live processes behind. Same janitorial shape as
  // gc-desktop-sessions; killTask still verifies emptiness itself and never
  // reports success on a scope that would not die.
  const results = await Promise.all(
    matched.map(async (task) => ({
      taskId: task.taskId,
      outcome: await (deps.kill ?? killTask)(task.taskId, {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      }),
    })),
  );
  return { prefix, matched: matched.length, results };
}

/**
 * Resolve the tree for deterministic acceptance checks. A grader may run from a
 * different Hive than the subject it is grading; in that case repo-relative test
 * paths belong to targetHive, not the grader's checkout. Same-Hive and legacy
 * callers retain the handler's caller-root behavior.
 */
async function resolveDeterministicCheckScope(
  args: Pick<z.infer<typeof scorecardEmitArgs>, 'targetHive'>,
  input: {
    ctxHarness?: string;
    workspaceId?: string;
    checkRoot?: string;
    rubricWorkspaceId?: string | null;
    rubricSubjectPlan?: string | null;
  },
): Promise<{ root: string; workspaceId?: string; harnessSlug?: string }> {
  const callerRoot = input.checkRoot ?? resolveAgentWorkspaceRoot({});
  // EI-21384279769470409: a workspace-scoped superuser dispatch may omit
  // ctx.workspaceId even though the rubric itself is workspace-bound.
  const workspaceId = input.workspaceId ?? input.rubricWorkspaceId ?? undefined;
  // Acceptance graders often omit targetHive because the rubric already names its
  // subject plan. Recover that plan's owning harness so repo-relative checks run in
  // the subject tree rather than the grader's checkout. An explicit targetHive is
  // authoritative and short-circuits this fallback, preserving cross-hive callers'
  // existing precedence.
  const targetHive =
    args.targetHive ??
    (input.rubricSubjectPlan && workspaceId
      ? await resolvePlanHarnessSlug(workspaceId, input.rubricSubjectPlan)
      : undefined);
  const harnessSlug = targetHive ?? input.ctxHarness;
  // Scope is useful only as a complete pair: the ledger query requires both
  // tenant dimensions, and passing one half would recreate the same ambiguous
  // rows this path is meant to prevent.
  const scope =
    workspaceId && workspaceId !== '*' && harnessSlug && harnessSlug !== '*'
      ? { workspaceId, harnessSlug }
      : {};
  if (!targetHive || targetHive === input.ctxHarness || !workspaceId) return { root: callerRoot, ...scope };

  const targetPaths = await resolveHarnessPaths(targetHive, workspaceId);
  return { root: resolveAgentWorkspaceRoot({ projectDir: targetPaths.projectDir }), ...scope };
}

/**
 * EI-21917534129987791: resolve the recorded author's live/parked/ended
 * verdict for the acceptance-author refusal's recovery hint (see
 * {@link authorRebindHint}). Dynamic-imported, mirroring rebind-identity.ts's
 * own liveness probe: the oracle statically pulls presence.ts / adv-sessions /
 * psu-pty-discovery, which this write-path module has no reason to carry on
 * its static graph for a best-effort error-message hint. Never throws — a
 * probe fault degrades to "no hint", never to a blocked or altered refusal.
 */
async function defaultResolveAuthorSessionState(
  ownerId: string,
  _opts: { workspaceId?: string } = {},
): Promise<SessionState | null> {
  try {
    const { resolveSessionStates } = await import('../coordination/liveness-oracle');
    const verdicts = await resolveSessionStates([{ ownerId }], { nowMs: Date.now(), hydratePerId: true });
    return verdicts.get(ownerId)?.sessionState ?? null;
  } catch {
    return null;
  }
}

/*
 * WI-2141007: `authorRebindHint` used to live here, appending "a legitimate
 * successor may run coord:rebind-identity { from: <author> }" to the not-the-
 * author refusal. It was removed, not moved: for the case that most often
 * produced it — an unrelated live PEER holding the plan, not the same agent
 * under a new sid — that advice was a footgun (EI-22135313244682666). Rebinding
 * migrates the dead author's ENTIRE owner-keyed surface set (armed loops,
 * claims, file locks, owner-scoped facts, fleet membership) merely to record one
 * verdict, and using it to pass an independence control defeats the control.
 * `acceptanceSeatRefusalHint` in acceptance-seat-succession.ts replaces it: it
 * names the narrow seat-succession route, and still points a genuine
 * same-agent-new-sid successor at rebind, which remains correct for them.
 */

export async function emitScorecard(
  args: z.infer<typeof scorecardEmitArgs>,
  input: {
    createdBy: string;
    ctxHarness?: string;
    role?: string;
    workspaceId?: string;
    /** Full request context used by the bounded post-write audit-dispatch repair. */
    launchContext?: GradingAuditLaunchContext;
    /** P-011 (D-006): the tree tests-check files resolve + run against — the handler
     *  passes its ctx-resolved root; omitted ⇒ the resolver's ctx-less fallback. */
    checkRoot?: string;
  },
  deps: {
    /** Injectable seam for tests — production runs the real router via the testing:run core. */
    evaluateChecks?: typeof evaluateCriterionTestChecks;
    /** Injectable restart-recovery seam; production reconciles task + test ledgers. */
    runRecoverableChecks?: typeof runRecoverableScorecardChecks;
    /** Injectable seam for tests — production replays typed ContinuityProbes. */
    evaluateProbeChecks?: typeof evaluateCriterionProbeChecks;
    /** Host-bound direct dispatcher used by ContinuityProbe checks. */
    dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Injectable seam for tests — production runs the native Cargo crate runner. */
    evaluateCargoChecks?: typeof evaluateCriterionCargoChecks;
    evaluateCoverageChecks?: typeof evaluateCriterionCoverageChecks;
    /** Injectable seam for tests — production runs the real P-014 activation↔completion join. */
    evaluateRequirementChecks?: typeof evaluateCriterionRequirementChecks;
    /** Injectable live release-gate read; production uses gitPipelineSnapshot. */
    releaseGateSnapshot?: () => Promise<ScorecardReleaseGateSnapshot>;
    /** Audited coord-identity continuity resolver. */
    sameAcceptanceAuthor?: typeof isAcceptanceAuthorIdentity;
    /** Spawn/rebind ancestry resolver for independent-grader enforcement. */
    lineageRelated?: typeof areAcceptanceLineageRelated;
    /** EI-21917534129987791: liveness probe backing the author-rebind recovery
     *  hint on the "acceptance must be recorded by the author" refusal. */
    resolveAuthorSessionState?: (ownerId: string, opts: { workspaceId?: string }) => Promise<SessionState | null>;
    /** Injectable seam for vetting-seat authorization; production uses the
     * fail-closed shared acceptance-seat resolver. */
    resolveAcceptanceSeatSuccession?: typeof resolveAcceptanceSeatSuccession;
    /** Test seam for the bounded post-write pending-audit dispatcher. */
    dispatchPendingGradingAudits?: typeof dispatchPendingGradingAudits;
    /** Verify a routed grading-audit fork is still the consult's current answerer. */
    isCurrentSourceAuditResponder?: typeof isCurrentSourceAuditResponder;
    closeSourceAuditConsults?: typeof closeSourceAuditConsults;
    /** Tri-state git ancestry seam for replay-based grading-integrity audits. */
    generationAncestry?: GenerationAncestryProbe;
  } = {},
) {
  // WI-10005715: a field that ENDS in the MCP result door's clip marker is a clipped
  // tool response re-typed as evidence. Refuse before ANY store read, so a clipped
  // draft costs nothing and persists nothing. Covers every route into the write
  // facade (scorecards:emit and plans:certify-spec-clauses share this function).
  const clippedPath = findClippedScorecardText(args);
  if (clippedPath) {
    // An inline literal on purpose: see clippedScorecardTextMessage for why a helper-built
    // object here strands readers of the result's optional fields.
    return {
      ok: false as const,
      code: CLIPPED_SCORECARD_TEXT_CODE,
      error: clippedScorecardTextMessage(clippedPath),
    };
  }
  const rubric = await getRubric(args.rubricRef);
  if (!rubric) return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  // P-004: the meta-rubric is an attestation surface, not a free-standing
  // observation. Without a subject the scorecard cannot say WHICH acceptance
  // rubric it vetted, so it can never satisfy the ship gate and only creates a
  // misleading "successful" history row. Enforce this at the write boundary,
  // before revision reads, deduplication, checks, or the ledger write.
  if (args.rubricRef === META_ACCEPTANCE_RUBRIC_ID && !args.subject) {
    return {
      ok: false as const,
      code: 'meta_acceptance_subject_required' as const,
      error:
        `scorecard for meta-rubric '${META_ACCEPTANCE_RUBRIC_ID}' requires subject:{ kind:'rubric', ref:'<acceptance-rubric-id>' } ` +
        'naming the specific acceptance rubric being vetted; a subject-less meta-scorecard cannot attest a rubric or satisfy the acceptance ship gate',
    };
  }
  // EI-21542997259558722: an acceptance rubric retires with its shipped or
  // superseded subject plan. A queued/carry-resumed grader can wake much later
  // with a valid rubric id and otherwise append a redundant verdict after the
  // plan is already terminal. Refuse at the write facade's entry, before
  // revision reads, deduplication, deterministic checks, or the ledger write.
  // Historical cards remain readable through scorecards:list.
  if (rubric.kind === 'acceptance' && rubric.status === 'retired') {
    return { ok: false as const, ...retiredAcceptanceRubricRefusal(rubric) };
  }
  // acceptance-runtime-plane P-004: an unknown/mismatch/not-deployed rating on a live or
  // deployed BAR must name the runtime AND build sha it measured — refused before any
  // ledger work, so the grader re-measures on the right runtime instead of "wait for main".
  if (rubric.kind === 'acceptance') {
    const citationRefusal = runtimeCitationRefusal(rubric.criteria, args.ratings);
    if (citationRefusal) return { ok: false as const, ...citationRefusal };
  }
  const specTestAdequacyBindingError = validateSpecTestAdequacyBinding(args);
  if (specTestAdequacyBindingError) return { ok: false as const, ...specTestAdequacyBindingError };
  let releaseScorecardEmitMutex: (() => Promise<void>) | undefined;
  try {
    let runningGenerationRead = false;
    let runningGeneration: Awaited<ReturnType<typeof readRunningGeneration>> | null = null;
    const readCurrentGeneration = async () => {
      if (!runningGenerationRead) {
        runningGenerationRead = true;
        runningGeneration = await readRunningGeneration().catch(() => null);
      }
      return runningGeneration;
    };
    const specTestAdequacyReplayError = await validateSpecTestAdequacyReplay(args, deps.dispatchTool);
    if (specTestAdequacyReplayError) return { ok: false as const, ...specTestAdequacyReplayError };
    // EI-21765534049482705: a meta-rubric card whose subject is an active
    // acceptance rubric is the vetting attestation consumed by the completion
    // gates. Without a linked critique channel it looks like a successful
    // scorecard, but the plan/goal gates must (correctly) ignore it forever.
    // Resolve the subject here so the writer rejects the inert card at the
    // point where the missing evidence is still actionable. Plain meta-rubric
    // scorecards without an acceptance-rubric subject remain valid.
    const missingAcceptanceRubricVetting =
      args.rubricRef === META_ACCEPTANCE_RUBRIC_ID &&
      args.subject?.kind === 'rubric' &&
      !args.vettingConsult &&
      !args.vettingWorkItem &&
      args.vettingUnanswered !== true;
    if (missingAcceptanceRubricVetting) {
      // `missingAcceptanceRubricVetting` already established subject?.kind === 'rubric',
      // but that narrowing does not flow through the aliased conjunction — bind the ref
      // once so the guard and the message cannot disagree about its nullability.
      const vettedRubricRef = args.subject!.ref;
      const subjectRubric = await getRubric(vettedRubricRef);
      if (subjectRubric?.kind === 'acceptance' && subjectRubric.status === 'active') {
        return {
          ok: false as const,
          code: 'acceptance_rubric_vetting_required' as const,
          error:
            `meta-rubric scorecard for active acceptance rubric '${vettedRubricRef}' requires vetting linkage — ` +
            `pass vettingConsult:'<consult conversation_id>' or vettingWorkItem:'<review WI-/EI- id>'. ` +
            `If no critique is available, use vettingConsult with vettingUnanswered:true and ` +
            `vettingUnansweredReason:'<what you observed>' so the waiver is recorded visibly.`,
        };
      }
    }
    // Bind every scorecard to the exact rubric plan-row revision used for grading.
    // A failed read remains unrecorded; historical cards must not be back-filled
    // from whatever the rubric says today.
    const rubricEvidenceIdentity = await getRubricEvidenceIdentity(args.rubricRef);
    const rubricRevision = rubricEvidenceIdentity.revision;
    // WI-1393208: also pin the rubric's criteriaHash (the field designed exactly
    // for this — see its doc comment) so a later criterion/method/description
    // edit is machine-detectable against this card, not just a plan-row revision
    // bump (which fires on ANY propose, typo included, and says nothing about
    // WHAT changed). Same fail-open/unrecorded-on-failure contract as rubricRevision.
    const criteriaHash = rubricEvidenceIdentity.criteriaHash;
    const rubricMeaningRevision = rubricEvidenceIdentity.meaningRevision;
    // A rubric named as the SUBJECT is distinct from the meta-rubric used to
    // score it. Pin both identities so later subject edits can invalidate this
    // attestation without mistaking the meta-rubric revision for the subject's.
    const subjectRubricIdentity = args.subject?.kind === 'rubric'
      ? { rubricRef: args.subject.ref, ...await getRubricEvidenceIdentity(args.subject.ref) }
      : undefined;
    const acceptance = args.acceptance as ScorecardAcceptance | undefined;
    const acceptanceOf = typeof args.acceptanceOf === 'string' ? args.acceptanceOf.trim() : undefined;
    // WI-2141007: set when this verdict is recorded by a SUCCESSOR to a dead
    // rubric author rather than by the author themselves. Declared out here
    // because it is stamped onto the persisted card below, outside the
    // acceptance-kind guard block that resolves it.
    let seatSuccession: AcceptanceSeatSuccession | undefined;
    // P-003: the independent card this verdict responds to, once validated.
    // Declared out here for the same reason as `seatSuccession` — the ratings
    // adoption and the persisted provenance stamp both happen below, outside
    // the acceptance-kind guard block that resolves and validates it.
    let acceptedIndependent: Awaited<ReturnType<typeof listScorecards>>[number] | undefined;
    // Acceptance authority belongs to the rubric author of record. A later
    // repair/re-propose records its actor in proposedBy, but must not transfer
    // the right to issue the plan verdict away from createdBy. Keep proposedBy
    // only as a legacy fallback for rows whose original creator is unavailable.
    const implementer = rubric.createdBy ?? rubric.proposedBy ?? null;
    if (acceptance && rubric.kind !== 'acceptance') {
      return {
        ok: false as const,
        error:
          "acceptance is valid only for kind:'acceptance' rubrics — a standard scorecard records ratings, not a plan ship verdict",
      };
    }
    // P-003: `acceptanceOf` exists to let a VERDICT cite the grading it answers.
    // Alone it would silently do nothing — the caller would believe they had
    // recorded an acceptance and filed an ordinary scorecard instead.
    if (acceptanceOf && !acceptance) {
      return {
        ok: false as const,
        error:
          'acceptanceOf names the independent card an acceptance verdict responds to — pass acceptance:{ verdict, reasoning } with it, or omit both (an independent grader emits ratings and neither field)',
      };
    }
    if (rubric.kind === 'acceptance') {
      // P-003: the grading door consumes the same bounded BAR snapshot as the
      // start/ship doors. This is intentionally before deterministic checks and
      // task cleanup, so a BAR-only or divergent contract is refused before a
      // costly grading pass is spent.
      if (rubric.barContract?.adoptionEpoch != null && rubric.subjectPlan) {
        // Scope to the subject plan's own harness: a plan slug is unique per harness, not per
        // workspace, so an unscoped read can span two copies and refuse
        // `bar_snapshot_plan_ambiguous` (WI-10005160).
        const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(rubric.subjectPlan, 'pre-grading', {
          expectedApplicable: true,
          harnessSlug: rubric.subjectHarnessSlug,
        });
        if (!lifecycle.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_bar_contract_not_ready' as const,
            error: lifecycle.message ?? 'acceptance BAR contract is not ready for grading',
            lifecycle,
          };
        }
      }
      const sameAcceptanceAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
      const lineageRelated = deps.lineageRelated ?? areAcceptanceLineageRelated;
      const identityWorkspace = rubric.workspaceId || input.workspaceId || activeWorkspaceId();
      // EI-21974075442192005: every rail resolved here is a pure IDENTITY fact,
      // settled before a single criterion is rated — yet all of them used to be
      // reachable ONLY through this terminal call, so a launched reviewer could
      // complete an entire grading pass and only then learn it could never file
      // the result. The rails now live in `grader-eligibility.ts`, which
      // `scorecards:evaluate` pre-flights against, so the disqualification is
      // discoverable before the work. Codes, messages and evaluation order are
      // unchanged; do not re-implement any of them here or in the pre-flight.
      const eligibility = await resolveAcceptanceGraderEligibility({
        rubric,
        callerId: input.createdBy,
        workspaceId: identityWorkspace,
        // WI-2141007: say WHICH question we are asking. Supplying `acceptance`
        // is an author-side verdict, not an offer of independent grading, so the
        // grading-independence rails must not answer it — they used to, which
        // both printed remedy advice for a problem the caller did not have AND
        // returned before seat succession could be considered at all.
        intent: acceptance ? 'acceptance' : 'grading',
        deps: { sameAcceptanceAuthor, lineageRelated },
      });
      if (eligibility.refusal) return { ok: false as const, ...eligibility.refusal };
      // WI-2141007: the acceptance seat is INHERITABLE when its author is dead.
      // Attempt succession before refusing — otherwise a plan whose implementer
      // was reaped (the normal case on a fleet that reaps members) can never
      // ship through any supported path. `callerIsImplementer` below therefore
      // means "holds author authority", by identity OR by audited succession.
      if (!eligibility.callerIsImplementer && acceptance) {
        const resolveAuthorSessionState = deps.resolveAuthorSessionState ?? defaultResolveAuthorSessionState;
        const seat = await resolveAcceptanceSeatSuccession({
          authorId: implementer,
          callerId: input.createdBy,
          subjectPlan: rubric.subjectPlan ?? null,
          workspaceId: identityWorkspace,
          // WI-10002535: a harness-less caller (operator/su session) has no
          // ctxHarness, and a null harness turns the acceptance-drain leg of
          // the succession query into FALSE — so the drain item the refusal
          // tells the caller to claim could never match. The rubric pins its
          // subject plan's tenant, which is exactly the disambiguation needed.
          harness: input.ctxHarness ?? rubric.subjectHarnessSlug ?? null,
          resolveAuthorSessionState,
        });
        if (seat.eligible) {
          seatSuccession = seat.succession;
        } else {
          return {
            ok: false as const,
            error:
              `acceptance must be recorded by the acceptance-rubric author ('${implementer ?? 'unknown'}'), ` +
              `not grader '${input.createdBy}' — independent graders emit ratings without acceptance` +
              acceptanceSeatRefusalHint(seat, implementer, rubric.subjectPlan ?? null, {
                workspaceId: identityWorkspace,
                harness: input.ctxHarness ?? null,
              }),
          };
        }
      }
      const callerIsImplementer = eligibility.callerIsImplementer || seatSuccession != null;
      if (callerIsImplementer && !acceptance) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author must record acceptance:{ verdict:'accept'|'accept-pending-delivery'|'reject', reasoning } after reading the independent grading; independent graders omit acceptance",
        };
      }
      if (callerIsImplementer && acceptance && args.supersedes) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author's verdict is a separate newer scorecard and must not use supersedes; omit supersedes so the independent grading remains visible to the plan-acceptance gate",
        };
      }
      if (callerIsImplementer) {
        const prior = await listScorecards({ rubricRef: args.rubricRef, limit: 50 });
        // P-003: ONE predicate, two callers. The scan below and the exact
        // `acceptanceOf` reference must agree on what "a complete independent
        // grading" is, or naming a card would become a way to accept evidence
        // the scan would have refused — an authorization bypass wearing the
        // costume of a convenience argument.
        // WRONG-SUBJECT RAIL (SPEC-P003-SCORECARD-REFERENCE@1 names it as required
        // evidence). `prior` is scoped by rubricRef ALONE, and one acceptance rubric
        // legitimately carries cards for different subjects — the duplicate path below
        // proves it, passing `subjectRef` and filtering `sameSubject`. Without this rail
        // BOTH selection paths could pick a grading of someone else's subject, and the
        // ratings the ship gate reads would describe other work entirely. Comparison
        // mirrors the duplicate path exactly, so the two cannot drift: an emit that
        // declares no subject constrains nothing, exactly as before.
        const sameAcceptanceSubject = (card: (typeof prior)[number]): boolean =>
          !args.subject ||
          (card.subject?.ref === args.subject.ref && (card.subject?.kind ?? null) === (args.subject.kind ?? null));
        const isEligibleIndependent = async (card: (typeof prior)[number]): Promise<boolean> => {
          if (!card.rubricResolved || card.missingKeys.length !== 0 || card.synthesized || card.createdBy == null)
            return false;
          // Applied HERE, inside the shared predicate, so the SCAN is rail-ed too —
          // the acceptanceOf branch below only re-checks it to return a precise code.
          if (!sameAcceptanceSubject(card)) return false;
          // Independence against the ORIGINAL author is unchanged — a seat
          // succession must never launder a related grader into an independent one.
          if (await lineageRelated(implementer, card.createdBy, { workspaceId: identityWorkspace })) return false;
          // WI-2141007: a SUCCESSOR now holds author authority, so they may not
          // accept a grading from their OWN lineage either. Without this the
          // three-party chain (author -> critic -> grader) collapses into one
          // session grading its own work and then accepting it — which is the
          // hole the lineage rule exists to close, re-opened one level along.
          if (
            seatSuccession &&
            (await lineageRelated(input.createdBy, card.createdBy, { workspaceId: identityWorkspace }))
          )
            return false;
          return true;
        };
        if (acceptanceOf) {
          const named = prior.find((card) => card.issueId === acceptanceOf);
          if (!named) {
            return {
              ok: false as const,
              code: 'acceptance_of_not_found' as const,
              error:
                `acceptanceOf '${acceptanceOf}' is not a scorecard for rubric '${args.rubricRef}' — pass the issue ` +
                `id of the independent card you actually read (scorecards:list { rubricRef:'${args.rubricRef}' } ` +
                'lists them with their issueIds)',
            };
          }
          if (named.retracted) {
            return {
              ok: false as const,
              code: 'acceptance_of_retracted' as const,
              error:
                `acceptanceOf '${acceptanceOf}' was RETRACTED — a verdict must accept a live independent grading, ` +
                'not a withdrawn one. Accept a current card, or have the grading re-emitted first',
            };
          }
          if (!sameAcceptanceSubject(named)) {
            return {
              ok: false as const,
              code: 'acceptance_of_wrong_subject' as const,
              error:
                `acceptanceOf '${acceptanceOf}' graded subject ` +
                `'${named.subject?.ref ?? '(none)'}', not '${args.subject?.ref}' — its ratings describe other ` +
                'work, so adopting them would file a verdict whose evidence is not about this subject. Accept ' +
                'the independent card that graded THIS subject',
            };
          }
          if (!(await isEligibleIndependent(named))) {
            return {
              ok: false as const,
              code: 'acceptance_of_not_independent' as const,
              error:
                `acceptanceOf '${acceptanceOf}' is not a complete independent grading: it must be schema-complete, ` +
                `non-synthesized, and authored outside '${implementer}'s lineage` +
                (seatSuccession ? ', and outside YOUR lineage because you inherited this seat' : '') +
                ' — so it cannot supply the ratings your verdict would adopt',
            };
          }
          // The scan never needed this rail (it only gated, it never ADOPTED).
          // Adoption does: copying ratings from a card that graded a different
          // revision would persist a grading of criteria no longer in force,
          // under the current revision's identity.
          const acceptedRubricCurrentness = classifyRubricEvidenceCurrentness(
            {
              revision: named.rubricRevision,
              criteriaHash: named.criteriaHash,
              meaningRevision: named.rubricMeaningRevision,
            },
            { revision: rubricRevision, criteriaHash, meaningRevision: rubricMeaningRevision },
          );
          if (acceptedRubricCurrentness.state !== 'current') {
            return {
              ok: false as const,
              code:
                ['criteria-hash-mismatch', 'meaning-revision-mismatch'].includes(acceptedRubricCurrentness.reason)
                  ? ('acceptance_of_stale_criteria' as const)
                  : ('acceptance_of_stale_revision' as const),
              error:
                `acceptanceOf '${acceptanceOf}' graded rubric identity ` +
                `(revision ${named.rubricRevision ?? 'unversioned'}, criteriaHash ${named.criteriaHash ?? 'unrecorded'}, ` +
                `meaningRevision ${named.rubricMeaningRevision ?? 'unrecorded'}), ` +
                `but '${args.rubricRef}' is now (revision ${rubricRevision ?? 'unversioned'}, ` +
                `criteriaHash ${criteriaHash ?? 'unavailable'}, meaningRevision ${rubricMeaningRevision ?? 'unavailable'}) — ` +
                `${acceptedRubricCurrentness.reason}. ` +
                'Have it re-graded against the current criteria, then accept that card',
            };
          }
          acceptedIndependent = named;
        } else {
          for (const card of prior) {
            if (await isEligibleIndependent(card)) {
              acceptedIndependent = card;
              break;
            }
          }
        }
        if (!acceptedIndependent) {
          return {
            ok: false as const,
            error:
              `acceptance must follow a complete independent grading by someone other than '${implementer}'` +
              (seatSuccession
                ? ` (and, because you inherited this seat from that dead author, by someone outside YOUR lineage too)`
                : '') +
              ` — have a non-implementer emit ratings first, then record the implementer's verdict`,
          };
        }
      }
      // EI-22177729599840121: vet-before-grade ordering was previously enforced ONLY at
      // ship time (plan-acceptance-gate.ts's acceptance_rubric_vetted_after_grading /
      // acceptance_rubric_unvetted), discovered only AFTER the independent grading pass
      // — often unrepeatable, since the independent-grader pool deliberately excludes
      // the rubric author's whole lineage — had already been spent. The violation is
      // fully determinable right here: any valid vetting attestation already on record
      // for the rubric's CURRENT revision necessarily predates the card being emitted
      // now, so "does a valid attestation exist yet" IS the order check at this moment.
      // Scoped to the plain independent-grading path (`!callerIsImplementer`, which by
      // construction above also means `!acceptance` here) — the author's own later
      // acceptance-verdict re-emit is unaffected, and the ship-time gate remains the
      // authoritative backstop for whatever this earlier check cannot see.
      if (!callerIsImplementer) {
        const suppressionWorkspace = rubric.workspaceId || input.workspaceId || activeWorkspaceId();
        const vettingStatus = await getAcceptanceRubricVettingStatus(rubric, {
          listScorecards,
          getRubric,
          getRubricPlanRevision,
          // EI-24121421744054354: name an owner stand-down when it is what strands a pending audit.
          ...(suppressionWorkspace
            ? { readGradingAuditDispatchSuppression: () => readGradingAuditDispatchSuppression(suppressionWorkspace) }
            : {}),
        });
        if (vettingStatus.required && !vettingStatus.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_rubric_unvetted' as const,
            error:
              vettingStatus.reason === 'stale-attestation'
                ? `acceptance rubric '${rubric.rubricId}' was vetted at revision ` +
                  `${vettingStatus.attestedRevisions.join('/') || '(unrecorded)'}, but the rubric is now at ` +
                  `revision ${vettingStatus.currentRevision} — the content changed after vetting, so the ` +
                  `attestation no longer covers what you are about to grade. Re-vet the CURRENT revision first: ` +
                  `scorecards:emit { rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', ` +
                  `subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, vettingConsult:'<consult conversation_id>' ` +
                  `(or vettingWorkItem:'<review WI-/EI- id>'), ratings:{ <every meta criterion> } } — THEN grade. ` +
                  `Grading now would be discovered invalid only at ship, after this pass is spent.` +
                  (vettingStatus.diagnosis ? ` Other cards were rejected: ${vettingStatus.diagnosis}.` : '')
                : vettingStatus.reason === 'rejected-attestation'
                  ? // The rubric HAS attestation cards — telling the author to "vet it"
                    // would send them to redo work they already did. Name the check that
                    // actually failed, on the card it failed for, so the repair is the
                    // cheap one (settle the audit, add the linkage) not a re-vet.
                    `acceptance rubric '${rubric.rubricId}' has attestation card(s) on record, but NOT ONE of them ` +
                    `counts as a settled attestation — each failed a specific vetting check. ` +
                    `WHICH card failed WHICH check: ${vettingStatus.diagnosis}. ` +
                    `Repair the named cause on the named card where you can (a pending grade-the-grader audit or a ` +
                    `missing critique linkage is fixable in place); otherwise emit a fresh attestation: ` +
                    `scorecards:emit { rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', ` +
                    `subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, vettingConsult:'<consult conversation_id>' ` +
                    `(or vettingWorkItem:'<review WI-/EI- id>'), ratings:{ <every meta criterion> } } — THEN grade.`
                  : `acceptance rubric '${rubric.rubricId}' has not been VETTED against the meta-rubric yet ` +
                  `(consult-min-max-and-rubric-vetting-2026-08-17). Grading it now would be discovered invalid ` +
                  `only at ship — AFTER your independent grading pass is spent, which the independent-grader pool's ` +
                  `own constraints can make expensive to redo. Have the rubric AUTHOR vet it first: ` +
                  `consult:get_feedback for external critique of the rubric, then scorecards:emit ` +
                  `{ rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, ` +
                  `vettingConsult:'<the consult conversation_id>', ratings:{ <every meta criterion, with evidence> } } ` +
                  `— THEN grade.`,
          };
        }
      }
    }
    // P-003: an acceptance author who named the exact card they read adopts its
    // ratings instead of re-typing a grading they did not perform. What is
    // removed is the TRANSCRIPTION, never the PERSISTENCE: the card filed below
    // still carries complete ratings, which is precisely what keeps it inside
    // plan-acceptance-gate's `complete` filter — an incomplete card is dropped
    // there and its verdict then reads as `acceptance_not_recorded`.
    //
    // Adoption requires the EXACT reference (`acceptanceOf`), never the scan's
    // pick. The two paths are not interchangeable here even though both set
    // `acceptedIndependent`: the scan is a pure GATE ("does a complete
    // independent grading exist?") and deliberately carries no revision rail,
    // because gating on a card is safe at any revision. ADOPTION is not — it
    // copies that card's ratings out under the CURRENT revision's identity, so
    // a stale-revision card would persist a grading of criteria no longer in
    // force. Letting the scan adopt would route around the
    // `acceptance_of_stale_revision` check by simply omitting the argument that
    // triggers it. So: no exact reference, no adoption — the refusal below then
    // names `acceptanceOf` as the way to get it.
    const adoptedRatings =
      args.ratings === undefined && acceptanceOf && acceptedIndependent ? acceptedIndependent.ratings : undefined;
    const suppliedRatings = (args.ratings ?? adoptedRatings) as ObservationRatings | undefined;
    if (suppliedRatings === undefined) {
      return {
        ok: false as const,
        error:
          'ratings is required: supply the complete per-criterion ratings, or — when recording an acceptance ' +
          "verdict — pass acceptanceOf:'<the independent card's issue id>' to adopt that card's ratings verbatim",
      };
    }
    const ratings = normalizeScorecardRatings(suppliedRatings, rubric);
    const observationForValidation = { rubricRef: args.rubricRef, ratings };
    // `validateScorecardCompleteness` intentionally permits an empty ratings map
    // for generic/free-text observations. scorecards:emit is different: it has
    // already resolved a rubric, so an empty map is an incomplete scorecard and
    // must fail before any deduplication or ledger write can occur.
    if (Object.keys(ratings).length === 0 && rubric.criteria.length > 0) {
      throw new ObservationEvidenceError(
        `scorecard for rubric '${args.rubricRef}' is INVALID/INCOMPLETE — missing required criterion key(s): ` +
          `${rubric.criteria.map((criterion) => criterion.key).join(', ')}. ` +
          `A rubric scorecard must rate exactly the declared criteria (rate a not-assessable one 'unknown' ` +
          'WITH evidence, never omit every criterion).',
      );
    }
    validateObservationRatings(observationForValidation);
    validateScorecardCompleteness(
      observationForValidation,
      rubric.criteria.map((criterion) => criterion.key),
    );
    validateScorecardRatingValues(observationForValidation, rubric);
    // scorecard-poor-rating-disposition (owner-directed 2026-08-31): a poor rating
    // on a standard rubric must carry `remediation` (WI-/EI-/F- ref) or an explicit
    // `disregard` — the agent-facing emit door enforces what the schema teaches.
    validateScorecardPoorRatingDisposition(observationForValidation, rubric);
    try {
      validateRubricRatingContracts(args.rubricRef, ratings);
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        canonicalRatings: ratings,
      };
    }
    const rollup =
      computeWorkOnEverythingRollup(
        args.rubricRef,
        ratings,
        rubric.criteria.map((criterion) => criterion.key),
      );
    // WI-2141007: the acceptance record as PERSISTED — the caller's verdict plus,
    // when the seat was inherited from a dead author, the server-stamped audited
    // succession. Computed once so the two persistence sites below cannot drift
    // apart. Deliberately NOT used for `evidenceFingerprint` above: the seat
    // carries a `succeededAt` timestamp, and folding a clock into the dedup
    // fingerprint would make every re-emit look like new content.
    const acceptanceRecord: ScorecardAcceptance | undefined = acceptance
      ? {
          ...acceptance,
          ...(seatSuccession ? { seat: seatSuccession } : {}),
          // P-003: stamp the adoption, and ONLY a real adoption — an author who
          // transcribed the ratings made their own record of them, and marking
          // that as adopted would misreport whose judgment the card carries.
          ...(adoptedRatings && acceptedIndependent?.createdBy
            ? {
                adoptedRatingsFrom: {
                  scorecardId: acceptedIndependent.issueId,
                  gradedBy: acceptedIndependent.createdBy,
                  ...(acceptedIndependent.rubricRevision != null
                    ? { rubricRevision: acceptedIndependent.rubricRevision }
                    : {}),
                },
              }
            : {}),
          // WI-10003534: cite the grading this verdict was ADMITTED against on EVERY
          // author verdict, not only on adoption. The rail above refuses the verdict
          // unless `acceptedIndependent` exists, so on this path it is always set —
          // the verdict simply used to discard which card satisfied it.
          ...(acceptedIndependent?.createdBy
            ? {
                independentGrading: {
                  scorecardId: acceptedIndependent.issueId,
                  gradedBy: acceptedIndependent.createdBy,
                  ...(acceptedIndependent.rubricRevision != null
                    ? { rubricRevision: acceptedIndependent.rubricRevision }
                    : {}),
                  selectedBy: acceptanceOf ? ('acceptanceOf' as const) : ('scan' as const),
                },
              }
            : {}),
        }
      : undefined;
    const instrumentSnapshots = await resolveScorecardInstrumentSnapshots({
      rubric,
      subject: args.subject,
      supplied: args.instrumentSnapshots as Record<string, ScorecardInstrumentSnapshot> | undefined,
    });
    const instrumentContract = evaluateScorecardInstrumentContract({
      rubric,
      ratings,
      instrumentSnapshots,
    });
    if (args.rubricRef === 'work-on-everything-stewardship-health' && instrumentContract.verdictMismatches.length) {
      return {
        ok: false as const,
        error: 'A registered platform measurement contradicts the claimed rating.',
        instrumentContract,
        instrumentSnapshots,
      };
    }
    if (rubric.releaseGating && !instrumentContract.valid) {
      return {
        ok: false as const,
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        instrumentContract,
      };
    }
    const releaseGateBinding =
      rubric.releaseGating && scorecardRatingsClaimPass(ratings)
        ? await resolveScorecardReleaseGateBinding(args.testedSha, {
            ...(deps.releaseGateSnapshot ? { snapshot: deps.releaseGateSnapshot } : {}),
          })
        : undefined;
    if (releaseGateBinding?.status === 'stale-pass-blocked') {
      return {
        ok: false as const,
        code: 'stale_pass_blocked' as const,
        error:
          `release-gating pass blocked for '${args.rubricRef}' — ${releaseGateBinding.reason}. ` +
          'Re-run the drill at the current staging commit after that same commit has a fresh green gate verdict, then pass testedSha.',
        releaseGateBinding,
        canonicalRatings: ratings,
      };
    }
    const boundTestedSha =
      releaseGateBinding?.status === 'bound' ? (releaseGateBinding.testedSha ?? undefined) : undefined;
    const evidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: args.rubricRef,
      ratings,
      instrumentSnapshots,
      ...(acceptance ? { acceptance } : {}),
      ...(args.rerunRecipe ? { rerunRecipe: args.rerunRecipe as SpecTestAdequacyRerunRecipe } : {}),
      ...(boundTestedSha ? { testedSha: boundTestedSha } : {}),
    });
    // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
    // A vetting scorecard (meta-rubric grading of an acceptance rubric) links the
    // get_feedback consult that critiqued the rubric and pins the rubric's plan-row
    // version, so the acceptance gate can tell whether the attestation still covers
    // the CURRENT revision. Both halves are validated to EXIST before anything is
    // stamped — the gate trusts the stamp rather than re-querying, so a dangling
    // link here would be a booby trap (same posture as the acceptance-kind link
    // guards in proposeRubric).
    let vetting: ScorecardVetting | undefined;
    let vettingSeatSuccession: AcceptanceSeatSuccession | undefined;
    let vettedSubjectPlan: string | null = null;
    // WI-41477: two alternate recording channels, one predicate. The consult channel
    // is the router-assigned get_feedback flow; the work-item channel is where a
    // LAUNCHED independent reviewer's critique actually lands (D-049 — consult
    // participants are router-assigned, so a reviewer launched to certify a specific
    // artifact can never post into a consult thread). Exactly one may be passed.
    if (args.vettingConsult && args.vettingWorkItem) {
      return {
        ok: false as const,
        error:
          'pass EXACTLY ONE of vettingConsult / vettingWorkItem — they are alternate recording channels for the ' +
          'same attestation, and a card stamped from both would be unreadable as evidence',
      };
    }
    if (args.vettingWorkItem && args.vettingUnanswered) {
      return {
        ok: false as const,
        error:
          'vettingUnanswered is consult-only — it waives a consult nobody answered. A work-item with no ' +
          'third-party comment is not attestable evidence; route a consult (vettingConsult) and waive THAT if no ' +
          'reviewer can be had',
      };
    }
    if (args.vettingUnanswered && !args.vettingConsult) {
      return {
        ok: false as const,
        error:
          'vettingUnanswered requires vettingConsult — the waiver attests that a SPECIFIC consult received no critique, ' +
          'and the acceptance gate can recognize it only when observation.vetting carries that consultId. Keep ' +
          'vettingConsult in the call alongside vettingUnanswered + vettingUnansweredReason.',
      };
    }
    if (args.vettingConsult || args.vettingWorkItem) {
      const subjectRef = args.subject?.ref;
      if (!subjectRef) {
        return {
          ok: false as const,
          error:
            "vetting linkage requires `subject` naming the vetted rubric — pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }",
        };
      }
      if (args.subject?.kind !== 'rubric') {
        return {
          ok: false as const,
          error:
            `vetting linkage is only valid on the META-RUBRIC scorecard that grades a rubric — ` +
            `pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }. ` +
            `For the later ${args.subject?.kind ?? 'untyped'}-subject acceptance card, omit ` +
            `vettingConsult/vettingWorkItem and cite the separately emitted meta-rubric scorecard instead`,
        };
      }
      const vettedRubric = await getRubric(subjectRef);
      if (!vettedRubric) {
        return {
          ok: false as const,
          error: `vetting subject '${subjectRef}' does not resolve to a rubric — the vetting stamp would be a dangling link`,
        };
      }
      if (
        vettedRubric.kind === 'acceptance' &&
        vettedRubric.subjectPlan &&
        vettedRubric.barContract?.adoptionEpoch != null
      ) {
        // P-003: vetting is the first phase that requires the as-built METHOD
        // and its runnable/manual check. Reuse the same snapshot rather than
        // inspecting the submitted meta-scorecard in isolation.
        const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(vettedRubric.subjectPlan, 'pre-vetting', {
          harnessSlug: vettedRubric.subjectHarnessSlug,
        });
        if (!lifecycle.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_bar_contract_not_ready' as const,
            error: lifecycle.message ?? 'acceptance BAR contract is not ready for vetting',
            lifecycle,
          };
        }
      }
      vettedSubjectPlan = vettedRubric.subjectPlan ?? null;
      // WI-10001614: vetting is author-owned evidence too. A caller may emit
      // it as the vetted rubric's author, or inherit that seat only after the
      // author is confirmed non-live and the caller is accountable for the
      // subject plan. Stamp a successor so readers can distinguish the narrow
      // seat transfer from an author-authored attestation.
      const vettedRubricAuthor = vettedRubric.createdBy ?? vettedRubric.proposedBy ?? null;
      const sameVettedRubricAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
      const vettingWorkspace = vettedRubric.workspaceId || input.workspaceId || activeWorkspaceId();
      const vettingAuthorIdentity = await sameVettedRubricAuthor(vettedRubricAuthor, input.createdBy, {
        workspaceId: vettingWorkspace,
      });
      if (!vettingAuthorIdentity) {
        const resolveAuthorSessionState = deps.resolveAuthorSessionState ?? defaultResolveAuthorSessionState;
        const resolveSeat = deps.resolveAcceptanceSeatSuccession ?? resolveAcceptanceSeatSuccession;
        const seat = await resolveSeat({
          authorId: vettedRubricAuthor,
          callerId: input.createdBy,
          subjectPlan: vettedRubric.subjectPlan ?? null,
          workspaceId: vettingWorkspace,
          harness: input.ctxHarness ?? vettedRubric.subjectHarnessSlug ?? null, // WI-10002535
          resolveAuthorSessionState,
        });
        if (!seat.eligible) {
          return {
            ok: false as const,
            error:
              `vetting must be emitted by the vetted rubric's author ('${vettedRubricAuthor ?? 'unknown'}'), ` +
              `not '${input.createdBy}'` +
              acceptanceSeatRefusalHint(seat, vettedRubricAuthor, vettedRubric.subjectPlan ?? null, {
                workspaceId: vettingWorkspace,
                harness: input.ctxHarness ?? null,
              }),
          };
        }
        vettingSeatSuccession = seat.succession;
      }
      if (args.vettingWorkItem) {
        // Mirror of the consult predicate below, clause for clause: the consult path
        // excludes the emitter and the consult REQUESTER; here the analogous
        // self-review parties are the emitter and the vetted rubric's author (the
        // vetting requester in the launched-reviewer flow).
        const critique = await readVettingWorkItemCritique(args.vettingWorkItem, [
          input.createdBy,
          vettedRubric.createdBy,
          vettedRubric.proposedBy,
        ]);
        if (!critique.exists) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' not found — the vetting stamp would be a dangling link. ` +
              `Pass the WI-/EI- id of the review work-item whose comments carry the critique of rubric '${subjectRef}'`,
          };
        }
        if (critique.critiquePosts === 0) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' carries NO third-party critique: comments by the emitter ` +
              `or the vetted rubric's author do not count — independent review means someone ELSE engaged with ` +
              `rubric '${subjectRef}'. A vetting attestation over an un-critiqued work-item would make the ` +
              `acceptance gate vacuously green. If no reviewer can be had at all, use the consult channel ` +
              `(vettingConsult + vettingUnanswered) so the waiver is recorded visibly`,
          };
        }
        const subjectIdentity = await getRubricEvidenceIdentity(subjectRef);
        const rubricRevision = subjectIdentity.revision;
        const criteriaHash = subjectIdentity.criteriaHash;
        const rubricMeaningRevision = subjectIdentity.meaningRevision;
        vetting = {
          workItemId: args.vettingWorkItem,
          ...(vettingSeatSuccession ? { seat: vettingSeatSuccession } : {}),
          ...(rubricRevision != null ? { rubricRevision } : {}),
          ...(criteriaHash != null ? { criteriaHash } : {}),
          ...(rubricMeaningRevision != null ? { rubricMeaningRevision } : {}),
          critiquePosts: critique.critiquePosts,
          ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        };
      }
    }
    if (args.vettingConsult) {
      const subjectRef = args.subject!.ref;
      const critique = await readVettingConsultCritique(
        getOrgPg().sql,
        activeWorkspaceId(),
        args.vettingConsult,
        input.createdBy,
        [subjectRef, vettedSubjectPlan].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
      );
      if (!critique.exists) {
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' not found in consult_state — open the critique consult first ` +
            `(consult:get_feedback about rubric '${subjectRef}') and pass its conversation_id`,
        };
      }
      // EI-20821478338037350: the gate's purpose is EXTERNAL CRITIQUE, so the
      // predicate has to be "someone critiqued it", not "a consult row exists".
      // The two failure modes are reported apart because their remedies differ:
      // silence means wait or re-route; a decline means the reviewer already
      // told you they cannot help, so waiting is pointless.
      const waived = args.vettingUnanswered === true;
      if (critique.critiquePosts === 0 && !waived) {
        const because =
          critique.declinePosts > 0
            ? `every routed reviewer DECLINED (${critique.declinePosts} decline post(s)) — waiting will not produce critique, so re-route the consult`
            : `nobody has replied yet (consult state '${critique.state ?? 'unknown'}') — wait for critique or re-route the consult`;
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' exists but carries NO critique: ${because}. ` +
            `A vetting attestation over an un-critiqued consult would make the acceptance gate vacuously green. ` +
            `If no reviewer can be had at all, say so explicitly: vettingUnanswered:true + vettingUnansweredReason:'<what you observed>'.`,
        };
      }
      if (waived && critique.critiquePosts > 0) {
        return {
          ok: false as const,
          error:
            `vettingUnanswered was passed, but consult '${args.vettingConsult}' DID receive critique ` +
            `(${critique.critiquePosts} post(s) from ${critique.critics.join(', ')}) — read the critique, improve the ` +
            `rubric from it, and re-emit without the waiver`,
        };
      }
      if (waived && !args.vettingUnansweredReason) {
        return {
          ok: false as const,
          error:
            'vettingUnanswered requires vettingUnansweredReason — an unexplained no-critique waiver is exactly the ' +
            'silent pass this gate exists to prevent',
        };
      }
      if (!waived && critique.critiquePosts > 0 && critique.relevance?.matched !== true) {
        return {
          ok: false as const,
          error:
            `vetting_consult_unrelated: consult '${args.vettingConsult}' carries third-party posts, but its durable ` +
            `opening question does not mention vetted rubric '${subjectRef}'` +
            (vettedSubjectPlan ? ` or subject plan '${vettedSubjectPlan}'` : '') +
            `. Open a rubric-specific consult and cite that conversation_id; an arbitrary answered consult cannot ` +
            `evidence this rubric's vetting.`,
        };
      }
      const subjectIdentity = await getRubricEvidenceIdentity(subjectRef);
      const rubricRevision = subjectIdentity.revision;
      const criteriaHash = subjectIdentity.criteriaHash;
      const rubricMeaningRevision = subjectIdentity.meaningRevision;
      vetting = {
        consultId: args.vettingConsult,
        ...(vettingSeatSuccession ? { seat: vettingSeatSuccession } : {}),
        ...(rubricRevision != null ? { rubricRevision } : {}),
        ...(criteriaHash != null ? { criteriaHash } : {}),
        ...(rubricMeaningRevision != null ? { rubricMeaningRevision } : {}),
        critiquePosts: critique.critiquePosts,
        ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        ...(waived ? { unanswered: true as const, unansweredReason: args.vettingUnansweredReason } : {}),
      };
    }
    // D-031 fallback advisory: when the vetting channel's recorded critics all
    // resolve to ONE party, that party cannot later supply the independent
    // acceptance grade because grader_is_sole_vetting_critic must refuse the
    // two-party chain. Surface the sequencing consequence now, without weakening
    // the later refusal or changing the durable vetting stamp.
    //
    // EI-21974075442192005: this advisory now derives from the SAME predicate as
    // the refusal it predicts (`collapseCriticsToSoleParty`). It previously read
    // `critics.length === 1` — the exact test WI-905074 had already widened on
    // the REFUSAL side — so a vetting record naming two critics of one lineage
    // was refused at grading time having never been warned at attestation time.
    // An advisory narrower than the rail it speaks for is worse than none: its
    // silence reads as clearance.
    const advisoryCritics = vetting?.critics ?? [];
    // EI-22182364716054326: this attestation is ONE channel's critique — a second
    // independent critic may already be recorded on the OTHER channel (a prior
    // vettingWorkItem card when this one is vettingConsult, or vice versa).
    // resolveAggregatedVettingCritics reads only PERSISTED cards, so it cannot
    // see the one this very call is about to write; union it in here so the
    // advisory predicts what resolveAcceptanceGraderEligibility will compute
    // once this card lands, instead of judging this channel in isolation.
    let unionedAdvisoryCritics = advisoryCritics;
    if (advisoryCritics.length > 0 && args.subject?.ref) {
      const { critics: otherChannelCritics } = await resolveAggregatedVettingCritics(
        args.subject.ref,
        vetting?.rubricRevision ?? null,
        vetting?.criteriaHash ?? null,
        vetting?.rubricMeaningRevision ?? null,
      );
      const seen = new Set(advisoryCritics);
      unionedAdvisoryCritics = [...advisoryCritics, ...otherChannelCritics.filter((c) => !seen.has(c))];
    }
    const soleVettingParty =
      unionedAdvisoryCritics.length > 0
        ? await collapseCriticsToSoleParty(unionedAdvisoryCritics, {
            workspaceId: input.workspaceId || activeWorkspaceId(),
            lineageRelated: deps.lineageRelated ?? areAcceptanceLineageRelated,
          })
        : null;
    const vettingWarning =
      soleVettingParty != null
        ? `vetting for acceptance rubric '${args.subject?.ref ?? 'unknown'}' records ` +
          (unionedAdvisoryCritics.length === 1
            ? `a sole critic '${soleVettingParty}'`
            : `${unionedAdvisoryCritics.length} vetting critics who all resolve to one party ('${soleVettingParty}')`) +
          `. That party cannot later emit the independent acceptance grade; the sole-vetting-critic rail will refuse it. ` +
          `Use another lineage-independent grader or obtain a second independent critic before grading.`
        : undefined;
    // P-008 (EI-20581177540737568): a 'violatable' criterion is monotonic-downward — one
    // violation falsifies it permanently — so a mid-run rating of one cannot be final.
    // DEFAULT IS PROVISIONAL: the emitter must AFFIRM subject termination (terminal:true)
    // to file a final card. Forgetting the flag yields a card that doesn't count toward
    // the trend, never a false final (WI-39348's exemplary went stale 28 minutes after
    // an honest interim grade; the burden now sits on the safe side by construction).
    const violatableRatedKeys = rubric.criteria
      .filter((c) => c.criterionClass === 'violatable' && ratings[c.key] !== undefined)
      .map((c) => c.key);
    const provisional =
      !args.terminal && violatableRatedKeys.length > 0
        ? { violatableKeys: violatableRatedKeys, stampedAt: new Date().toISOString() }
        : undefined;
    // ── P-013 (D-004): grade-the-grader ──
    // AUDIT PATH — this emit IS a grading audit (rubricRef = the meta-rubric).
    // Validated BEFORE filing: an audit card filed and then unable to settle its
    // subject would strand both halves. Mirrors the acceptance grader ≠ author rule.
    let auditContext: {
      subjectIssueId: string;
      auditor: string;
      verdict: 'passed' | 'failed';
      rubricRevision?: number;
      criteriaHash?: string;
      dispatchReservation?: { key: string; reservedAt: string };
    } | null = null;
    if (args.rubricRef === GRADING_INTEGRITY_RUBRIC_REF) {
      const auditVerdict = auditVerdictFromRatings(ratings);
      if (auditVerdict === null) {
        return {
          ok: false as const,
          code: 'grading_audit_verdict_unknown' as const,
          error: 'grading-integrity ratings cannot establish a passed or failed verdict; resolve unknown ratings before emitting an audit card',
        };
      }
      if (args.subject?.kind !== 'scorecard' || !args.subject.ref) {
        return {
          ok: false as const,
          error:
            "grading-integrity audits a SCORECARD — pass subject:{ kind:'scorecard', ref:'<the graded card's issue id>' } (D-004: terminal cards only, one level deep)",
        };
      }
      const graded = await getIssue(args.subject.ref);
      const gradedRawObservation =
        graded?.payload && typeof graded.payload === 'object' && !Array.isArray(graded.payload)
          ? (graded.payload as { observation?: unknown }).observation
          : undefined;
      const gradedObservation = asStructuredObservation(gradedRawObservation);
      if (!gradedObservation?.rubricRef || !gradedObservation.ratings) {
        return { ok: false as const, error: `audit subject '${args.subject.ref}' is not a scorecard` };
      }
      if (gradedObservation.retracted) {
        return { ok: false as const, error: `audit subject '${args.subject.ref}' is retracted and cannot be audited` };
      }
      if (!gradedObservation.gradingAudit) {
        return {
          ok: false as const,
          error: `audit subject '${args.subject.ref}' carries no gradingAudit stamp — only terminal standard-rubric cards emitted under the audit gate are auditable`,
        };
      }
      const activeDispatchReservation = gradedObservation.gradingAudit.dispatchReservation;
      const suppliedDispatchReservation = args.gradingAuditReservation;
      if (gradedObservation.gradingAudit.state === 'pending' && activeDispatchReservation && !suppliedDispatchReservation) {
        return {
          ok: false as const,
          code: 'grading_audit_reservation_missing' as const,
          error:
            `audit subject '${args.subject.ref}' has an active dispatch reservation, but gradingAuditReservation is missing; ` +
            `re-read the target and pass the exact lease key '${activeDispatchReservation.key}' and reservedAt '${activeDispatchReservation.reservedAt}'`,
        };
      }
      if (
        gradedObservation.gradingAudit.state === 'pending' &&
        activeDispatchReservation &&
        suppliedDispatchReservation &&
        (suppliedDispatchReservation.key !== activeDispatchReservation.key ||
          suppliedDispatchReservation.reservedAt !== activeDispatchReservation.reservedAt)
      ) {
        return {
          ok: false as const,
          code: 'grading_audit_reservation_mismatch' as const,
          error:
            `audit subject '${args.subject.ref}' gradingAuditReservation does not match its current active dispatch reservation; ` +
            're-read the target and use the exact current lease key and reservedAt, or stop if the lease changed',
        };
      }
      if (gradedObservation.gradingAudit.state === 'pending' && !activeDispatchReservation && suppliedDispatchReservation) {
        return {
          ok: false as const,
          code: 'grading_audit_reservation_unavailable' as const,
          error:
            `audit subject '${args.subject.ref}' has no active dispatch reservation to match the supplied gradingAuditReservation; ` +
            're-read the target and emit only if its current pending lease is present',
        };
      }
      if (
        gradedObservation.gradingAudit.state === 'pending' &&
        activeDispatchReservation &&
        suppliedDispatchReservation &&
        !(await (deps.isCurrentSourceAuditResponder ?? isCurrentSourceAuditResponder)(
          args.subject.ref,
          activeDispatchReservation,
          input.createdBy,
        ))
      ) {
        return {
          ok: false as const,
          error:
            `audit subject '${args.subject.ref}' is assigned to a different active consult answerer; ` +
            'only the current answering session may emit under this dispatch reservation',
        };
      }
      if (gradedObservation.gradingAudit.state === 'awaiting-reemit') {
        return {
          ok: false as const,
          error:
            `audit subject '${args.subject.ref}' is awaiting a source-card re-emit because its evaluator changed; ` +
            're-emit the target under the current evaluator before auditing it again',
        };
      }
      if (gradedObservation.gradingAudit.state !== 'pending') {
        // A settled graded subject may still need a factual/body correction to
        // its AUDIT card. Allow that narrow same-subject correction through;
        // the generic supersedes validation below still enforces that the
        // referenced card is an actual same-rubric scorecard.
        const supersededAudit = args.supersedes ? await getIssue(args.supersedes) : null;
        const supersededAuditRaw =
          supersededAudit?.payload &&
          typeof supersededAudit.payload === 'object' &&
          !Array.isArray(supersededAudit.payload)
            ? (supersededAudit.payload as { observation?: unknown }).observation
            : undefined;
        const supersededAuditObservation = asStructuredObservation(supersededAuditRaw);
        const isAuditCorrection =
          supersededAuditObservation?.rubricRef === GRADING_INTEGRITY_RUBRIC_REF &&
          supersededAuditObservation.subject?.kind === 'scorecard' &&
          supersededAuditObservation.subject.ref === args.subject.ref;
        if (!isAuditCorrection) {
          return {
            ok: false as const,
            error: `audit subject '${args.subject.ref}' is already audited (${gradedObservation.gradingAudit.state}) — supersede the AUDIT card instead of re-auditing (D-004: one level, no regress)`,
          };
        }
      }
      const gradedAuthor = graded?.createdBy ?? null;
      const identityWorkspace = input.workspaceId || activeWorkspaceId();
      const authorLineageRelated =
        gradedAuthor && input.createdBy
          ? await (deps.lineageRelated ?? areAcceptanceLineageRelated)(gradedAuthor, input.createdBy, {
              workspaceId: identityWorkspace,
            })
          : false;
      // Unattributable identity on EITHER side refuses — strict toward auditing again.
      if (!gradedAuthor || !input.createdBy || gradedAuthor === input.createdBy || authorLineageRelated) {
        const refusalReason = !gradedAuthor || !input.createdBy
          ? 'the graded card author or auditor identity is missing'
          : gradedAuthor === input.createdBy
            ? `the auditor is the exact graded card author '${gradedAuthor}'`
            : `auditor '${input.createdBy}' is in the graded card author's identity lineage ('${gradedAuthor}')`;
        return {
          ok: false as const,
          error: `self_audit_refused: ${refusalReason}; a grading audit must come from an independent party outside the author's identity lineage — mirror of the acceptance grader ≠ author rule`,
        };
      }
      // EI-22643332515600282: a grading audit must be independent from the
      // graded card's evidence source, not merely from its author. Vetting
      // critics are the durable identity of the external critique recorded as
      // evidence on a vetting card; allowing one of them to audit that card
      // lets the critic certify quotations of their own review. Treat a
      // rebind successor as the same party too, preserving the author guard's
      // lineage semantics without changing the ordinary non-author path.
      const gradingEvidenceSources = gradedObservation.vetting?.critics ?? [];
      const evidenceSourceMatch = (
        await Promise.all(
          gradingEvidenceSources.map(async (source) => ({
            source,
            related: await (deps.lineageRelated ?? areAcceptanceLineageRelated)(source, input.createdBy, {
              workspaceId: identityWorkspace,
            }),
          })),
        )
      ).find(({ related }) => related)?.source;
      if (evidenceSourceMatch) {
        return {
          ok: false as const,
          code: 'auditor_is_graded_card_evidence_source' as const,
          error:
            `self_audit_refused: grading auditor '${input.createdBy}' is the graded card's recorded evidence source ` +
            `('${evidenceSourceMatch}') — a grading audit must come from an independent party, not the critic whose ` +
            'quotes form the graded evidence; use another auditor',
        };
      }
      const replayConsistencyError = await validateGradingAuditReplayConsistency(
        gradedObservation,
        args.ratings,
        deps.dispatchTool,
        { gradedCardCreatedAt: graded?.createdAt, workspaceId: identityWorkspace },
      );
      if (replayConsistencyError) {
        if (
          replayConsistencyError.code === 'grading_audit_evaluator_changed' &&
          gradedObservation.gradingAudit.state === 'pending'
        ) {
          await markGradingAuditAwaitingReemit(args.subject.ref, gradedObservation.gradingAudit, {
            reason: replayConsistencyError.error,
          });
        }
        return { ok: false as const, ...replayConsistencyError };
      }
      // Every grading-integrity rating on re-runnable-evidence depends on the
      // target card's evaluator. An older/diverged auditor can return pass,
      // fail, or unknown using different evaluator semantics; none can settle
      // a card graded by a newer build. Keep the target pending until the
      // auditor runs on the same or a descendant generation.
      if (
        gradedObservation.rerunRecipe &&
        ratingVerdict(args.ratings?.['re-runnable-evidence']?.rating ?? '') !== null
      ) {
        const rawGeneration =
          gradedRawObservation && typeof gradedRawObservation === 'object' && !Array.isArray(gradedRawObservation)
            ? (gradedRawObservation as { gradedGeneration?: unknown }).gradedGeneration
            : undefined;
        const gradedGeneration = parseGradedGeneration(rawGeneration);
        const auditorGeneration = await readCurrentGeneration();
        const generationCheck = assessGenerationAncestry(
          gradedGeneration?.deployedSha,
          auditorGeneration?.deployedSha,
          input.checkRoot ?? resolveAgentWorkspaceRoot({}),
          deps.generationAncestry ??
            ((root, ancestor, descendant) => realGitProbe.isAncestor(root, ancestor, descendant)),
        );
        if (!generationCheck.ok) {
          return {
            ok: false as const,
            code: 'grading_audit_generation_incompatible' as const,
            error:
              `grading-integrity audit for '${args.subject.ref}' cannot accept its ` +
              `re-runnable-evidence rating from an incompatible build: ${generationCheck.reason}; ` +
              'the auditor must run on the same or a descendant build of the graded card; no audit card was persisted',
          };
        }
      }
      auditContext = {
        subjectIssueId: args.subject.ref,
        auditor: input.createdBy,
        verdict: auditVerdict,
        ...(rubric.revision != null ? { rubricRevision: rubric.revision } : {}),
        ...(rubric.criteriaHash ? { criteriaHash: rubric.criteriaHash } : {}),
        ...(args.gradingAuditReservation ? { dispatchReservation: args.gradingAuditReservation } : {}),
      };
    }
    // PENDING STAMP — a terminal standard-rubric card is final but UNAUDITED until a
    // non-author audit settles it (never the audit card itself: one level).
    let gradingAudit: ScorecardGradingAudit | undefined;
    if (
      needsGradingAudit({
        rubricKind: rubric.kind,
        rubricRef: args.rubricRef,
        provisional: provisional !== undefined,
      }) &&
      (await gradingAuditGateEnabled())
    ) {
      // Pin the audit contract itself, not only the graded rubric. A settled
      // audit must be re-opened when the grading-integrity rubric changes.
      const [auditRubricRevision, auditCriteriaHash] = await Promise.all([
        getRubricPlanRevision(GRADING_INTEGRITY_RUBRIC_REF),
        getRubricCriteriaHash(GRADING_INTEGRITY_RUBRIC_REF),
      ]);
      gradingAudit = {
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        stampedAt: new Date().toISOString(),
        ...(auditRubricRevision != null ? { rubricRevision: auditRubricRevision } : {}),
        ...(auditCriteriaHash != null ? { criteriaHash: auditCriteriaHash } : {}),
      };
    }
    let sourceHive = args.sourceHive ?? input.ctxHarness;
    // P-013: a pending subject card is waiting for a GRADING-INTEGRITY audit,
    // not another ordinary scorecard against the same rubric. Without this
    // boundary a non-author auditor can accidentally file a second peer card
    // that looks successful while leaving the original card pending until the
    // far-end completion gate notices. Refuse the ambiguous form before any
    // scorecard write and teach the only form that settles the pending stamp.
    if (args.subject) {
      const pendingSameSubject = (
        await listScorecards({
          rubricRef: args.rubricRef,
          subjectRef: args.subject.ref,
          limit: 100,
        })
      ).filter(
        (card) =>
          card.gradingAudit?.state === 'pending' &&
          card.subject?.ref === args.subject?.ref &&
          (card.subject?.kind ?? null) === (args.subject?.kind ?? null) &&
          card.supersededBy == null &&
          card.issueId !== args.supersedes,
      );
      // WI-10005211: a grading-integrity revision re-opens every settled audit
      // (reservePendingGradingAudit), so a windowed grader's whole back-catalogue
      // turns pending at once and each old card blocked the author's next card
      // until it was re-audited, one at a time. A RE-OPENED audit is not the
      // P-013 case: the card already carries an independent verdict, and its
      // own author can never be the auditor. So the author's new card is not
      // blocked by its own re-opened cards. A never-audited pending card still
      // blocks everyone, and a non-author is still taught the audit shape.
      const ownPending = pendingSameSubject.filter((card) => card.createdBy === input.createdBy);
      const previouslyAudited = new Set<string>();
      if (ownPending.length > 0) {
        for (const audit of await listScorecards({
          rubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          subjectRefs: ownPending.map((card) => card.issueId),
          limit: 500,
        })) {
          if (audit.subject?.kind === 'scorecard' && audit.subject.ref && !audit.retracted) {
            previouslyAudited.add(audit.subject.ref);
          }
        }
      }
      const pendingSubject = pendingSameSubject.find(
        (card) => !(card.createdBy === input.createdBy && previouslyAudited.has(card.issueId)),
      );
      if (pendingSubject) {
        return {
          ok: false as const,
          code: 'grading_audit_required' as const,
          error:
            `scorecard '${pendingSubject.issueId}' for rubric '${args.rubricRef}' has a pending grading audit — ` +
            `either supersede it by passing supersedes:'${pendingSubject.issueId}' on a corrected ` +
            'same-rubric scorecard, or emit the audit as { rubricRef:\'grading-integrity\', ratings, terminal:true, ' +
            `subject:{ kind:'scorecard', ref:'${pendingSubject.issueId}' } } instead of filing another ` +
            'same-rubric peer scorecard',
        };
      }
    }
    if (args.supersedes) {
      const superseded = await getIssue(args.supersedes);
      const raw =
        superseded?.payload && typeof superseded.payload === 'object' && !Array.isArray(superseded.payload)
          ? (superseded.payload as { observation?: unknown }).observation
          : undefined;
      const prior = asStructuredObservation(raw);
      if (!prior?.rubricRef || !prior.ratings) {
        return { ok: false as const, error: `superseded scorecard '${args.supersedes}' not found` };
      }
      if (prior.rubricRef !== args.rubricRef) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' grades '${prior.rubricRef}', not '${args.rubricRef}'`,
        };
      }
      // EI-21574072776977281: a correction belongs to the scorecard lineage it
      // replaces, not whichever Hive happens to host the correcting session.
      // When the caller omits sourceHive, inherit the prior card's canonical
      // value — including undefined for pre-sourceHive legacy rows. This keeps a
      // workspace-scoped caller able to correct a Hive-bound card and a
      // Hive-scoped caller able to finalize a legacy unscoped card without
      // opening an unscoped transport just to reproduce the old partition.
      if (args.sourceHive === undefined) sourceHive = prior.sourceHive;
      if ((prior.sourceHive ?? undefined) !== (sourceHive ?? undefined)) {
        // WI-2141737: say which of the two facts this is, and name the form that
        // settles it. An ABSENT stored sourceHive (a card filed before the stamp
        // existed) is not the same fact as an empty one, but rendering it as ''
        // made it read as a value the caller could pass — and `sourceHive` is
        // declared min(1), so no caller can pass ''. Read together, those two
        // signals say "this card can never be superseded", which is false: the
        // inherit-on-omit branch directly above finalizes exactly these cards.
        // The reporter of WI-2141737 lost an investigation to that reading and
        // shipped a card whose supersede edge is still unwritten, so the refusal
        // owes the caller the satisfiable form rather than only the mismatch.
        const priorLabel =
          prior.sourceHive === undefined
            ? 'no sourceHive at all (filed before the sourceHive stamp existed)'
            : `sourceHive '${prior.sourceHive}'`;
        return {
          ok: false as const,
          error:
            `superseded scorecard '${args.supersedes}' belongs to ${priorLabel}, not '${sourceHive ?? ''}' — ` +
            "omit sourceHive to inherit the superseded card's own value instead of this session's hive",
        };
      }
    }
    // EI-22001573837456548: scorecard history is append-only and independent
    // graders cannot retract a redundant card. Read a bounded, complete-enough
    if (!args.acceptance && !args.acknowledgeExisting) {
      // Unscoped scorecards use (rubricRef, rubricRevision); a structured
      // subject adds (subject.kind, subject.ref). Narrow the read by ref when
      // possible, then keep kind in the in-memory tuple because scorecards:list
      // exposes only the scalar subject-ref filter. `force` intentionally does
      // not bypass this guard; it only means "the evidence changed despite the
      // latest fingerprint".
      const subject = args.subject;
      const priorScorecards = await listScorecards({
        rubricRef: args.rubricRef,
        ...(subject ? { subjectRef: subject.ref } : {}),
        limit: 500,
      });
      const existingIndependentScorecardIds = priorScorecards
        .filter((card) => {
          const sameSubject =
            !subject || (card.subject?.ref === subject.ref && (card.subject?.kind ?? null) === (subject.kind ?? null));
          return (
            sameSubject &&
            card.rubricRef === args.rubricRef &&
            classifyRubricEvidenceCurrentness(
              {
                revision: card.rubricRevision,
                criteriaHash: card.criteriaHash,
                meaningRevision: card.rubricMeaningRevision,
              },
              { revision: rubricRevision, criteriaHash, meaningRevision: rubricMeaningRevision },
            ).state === 'current' &&
            card.rubricResolved &&
            card.missingKeys.length === 0 &&
            (card.extraKeys?.length ?? 0) === 0 &&
            !card.synthesized &&
            card.createdBy != null &&
            card.createdBy !== input.createdBy &&
            !card.acceptance
          );
        })
        .map((card) => card.issueId);
      if (existingIndependentScorecardIds.length > 0) {
        const revisionLabel = rubricRevision == null ? 'unversioned' : String(rubricRevision);
        return {
          ok: false as const,
          code: 'existing_independent_scorecards' as const,
          error:
            `complete independent scorecard(s) already exist for rubric '${args.rubricRef}' revision ${revisionLabel}: ` +
            `${existingIndependentScorecardIds.join(', ')} — re-run with acknowledgeExisting:true to append another; ` +
            'force:true only bypasses unchanged-evidence deduplication and does not acknowledge existing cards',
          existingIndependentScorecardIds,
          acknowledgementRequired: 'acknowledgeExisting:true' as const,
        };
      }
    }
    // Preserve the existing source-hive partition for unchanged-evidence dedup.
    // The broad population read above is only for the cross-hive redundancy guard.
    // Unit suites mock the ledger and do not boot Postgres; their ordinary Vitest
    // calls intentionally remain PG-free. Integration tests opt into this same
    // production path with PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST=1.
    if (!process.env.VITEST || process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST === '1') {
      releaseScorecardEmitMutex = await acquireScorecardEmitMutex(
        scorecardEmitMutexKey({
          workspaceId: input.workspaceId ?? activeWorkspaceId(),
          rubricRef: args.rubricRef,
          sourceHive,
        }),
      );
    }
    const latest = (await listScorecards({ rubricRef: args.rubricRef, sourceHive, limit: 1 }))[0];
    const latestFingerprint = latest
      ? (latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({
          rubricRef: latest.rubricRef,
          ratings: latest.ratings,
          ...(latest.acceptance ? { acceptance: latest.acceptance } : {}),
          ...(latest.rerunRecipe ? { rerunRecipe: latest.rerunRecipe } : {}),
          ...(latest.testedSha ? { testedSha: latest.testedSha } : {}),
        }))
      : null;
    const sameCorrectionAlreadyExists = args.supersedes && latest?.supersedes === args.supersedes;
    // P-008: a terminal re-emit of IDENTICAL ratings is the finalization step, not a
    // duplicate — the fingerprint (rubricRef+ratings+snapshots, unchanged for
    // compatibility with stored rows) cannot see finality, so compare it separately.
    const finalityChanged = latest !== undefined && (latest.provisional !== undefined) !== (provisional !== undefined);
    // P-004: a re-emit that only moves the vetting stamp — a new consult, or the same
    // consult re-attested against a NEW rubric revision after the author improved the
    // rubric — is the re-vetting step, not a duplicate. The fingerprint cannot see it
    // (rubricRef + ratings + snapshots only, unchanged for stored-row compatibility),
    // so compare the stamps separately, like finality above.
    // EI-20821478338037350: the waiver→critiqued upgrade is the same kind of move.
    // An author who honestly attested `unanswered` and LATER receives critique must be
    // able to re-emit the real stamp over the waived one; without this the fingerprint
    // (identical rubricRef + ratings + consult + revision) declines it as unchanged and
    // the recorded waiver is stuck on the card forever.
    const vettingChanged =
      (latest?.vetting?.consultId ?? null) !== (vetting?.consultId ?? null) ||
      // WI-41477: the work-item channel is the same kind of move — a re-emit that
      // switches channel or cites a different review work-item is a re-vetting step.
      (latest?.vetting?.workItemId ?? null) !== (vetting?.workItemId ?? null) ||
      (latest?.vetting != null || vetting != null) &&
        classifyRubricEvidenceCurrentness(
          {
            revision: latest?.vetting?.rubricRevision,
            criteriaHash: latest?.vetting?.criteriaHash,
            meaningRevision: latest?.vetting?.rubricMeaningRevision,
          },
          {
            revision: vetting?.rubricRevision,
            criteriaHash: vetting?.criteriaHash,
            meaningRevision: vetting?.rubricMeaningRevision,
          },
        ).state !== 'current' ||
      (latest?.vetting?.unanswered ?? false) !== (vetting?.unanswered ?? false);
    // The rubric identity is part of the grading binding but deliberately remains
    // outside the historical evidence fingerprint. Relevant criterion/method/dependency
    // changes must escape deduplication; a revision-only bookkeeping edit must not.
    const rubricIdentityChanged =
      latest != null &&
      classifyRubricEvidenceCurrentness(
        {
          revision: latest.rubricRevision,
          criteriaHash: latest.criteriaHash,
          meaningRevision: latest.rubricMeaningRevision,
        },
        { revision: rubricRevision, criteriaHash, meaningRevision: rubricMeaningRevision },
      ).state !== 'current';
    const subjectRubricIdentityChanged = subjectRubricIdentity != null && latest != null && (
      latest.subjectRubricIdentity?.rubricRef !== subjectRubricIdentity.rubricRef ||
      classifyRubricEvidenceCurrentness(
        latest.subjectRubricIdentity ?? {},
        subjectRubricIdentity,
      ).state !== 'current'
    );
    if (
      !args.force &&
      !finalityChanged &&
      !vettingChanged &&
      !rubricIdentityChanged &&
      !subjectRubricIdentityChanged &&
      latestFingerprint === evidenceFingerprint &&
      (!args.supersedes || sameCorrectionAlreadyExists)
    ) {
      const acceptanceGraderCleanup =
        rubric.kind === 'acceptance' && input.role === 'judge'
          ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
          : undefined;
      return {
        ok: true as const,
        created: false,
        reason: 'unchanged-evidence' as const,
        evidenceFingerprint,
        previousIssueId: latest?.issueId ?? null,
        canonicalRatings: ratings,
        ...(vettingWarning ? { warning: vettingWarning } : {}),
        ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
      };
    }

    // ── P-011 (owner-ratified D-006): deterministic criterion checks ──
    // Every RATED criterion whose rubric check is kind:'tests' has its files actually
    // RUN here, at grading time (never a stale ledger read): a path that no longer
    // resolves refuses the emit, an unjudgeable run refuses the emit, and a
    // pass-claiming rating the run contradicts refuses the emit. Placed AFTER the
    // unchanged-evidence decline above so a deduped re-emit never burns a test run,
    // and BEFORE the write so a card is only ever filed with its live check verdicts
    // stamped (observation.checkRuns). Criteria without a tests-check are untouched.
    let checkRuns: Record<string, import('../../rubrics-criterion-checks').CriterionCheckRun> | undefined;
    const testCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'tests');
    if (testCheckedCriteria.length > 0) {
      const evaluateChecks = deps.evaluateChecks ?? evaluateCriterionTestChecks;
      const checkScope = await resolveDeterministicCheckScope(args, {
        ...input,
        rubricWorkspaceId: rubric.workspaceId,
        rubricSubjectPlan: rubric.subjectPlan,
      });
      const checkEvaluation = await evaluateChecks({
        criteria: rubric.criteria,
        ratings,
        root: checkScope.root,
        ...(checkScope.workspaceId ? { workspaceId: checkScope.workspaceId } : {}),
        ...(checkScope.harnessSlug ? { harnessSlug: checkScope.harnessSlug } : {}),
        ...(deps.evaluateChecks ? {} : {
          // force:true expressly asks for a fresh sample even when the evidence
          // fingerprint is unchanged; never satisfy it from an older check run.
          runner: args.force
            ? runCriterionCheckFiles
            : (opts: Parameters<CriterionCheckRunner>[0]) => (deps.runRecoverableChecks ?? runRecoverableScorecardChecks)(opts, {
                rubricRef: args.rubricRef,
                rubricRevision: rubricRevision ?? null,
                criteriaHash: criteriaHash ?? null,
                evidenceFingerprint,
                createdBy: input.createdBy,
                subjectRef: args.subject?.ref ?? null,
                operationRef: JSON.stringify({
                  terminal: args.terminal ?? null,
                  supersedes: args.supersedes ?? null,
                  acceptanceOf: args.acceptanceOf ?? null,
                  acknowledgeExisting: args.acknowledgeExisting ?? null,
                }),
            }),
        }),
        // One shared budget for the batched run. scorecards:emit declares a longer
        // tool timeout below, so the transport gives this mutation enough time to
        // return a typed verdict (and still leaves a full minute for process-group
        // settlement, the ledger write, and response serialization).
        timeoutMs: SCORECARD_TEST_CHECK_TIMEOUT_MS,
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      checkRuns = Object.keys(checkEvaluation.checkRuns).length > 0 ? checkEvaluation.checkRuns : undefined;
    }

    // Typed ContinuityProbe criterion checks use the same read-only dispatcher
    // and bounded batch executor as carried checks. They run after unchanged
    // evidence deduplication and before persistence, so every filed card keeps
    // the live predicate result that justified its rating.
    const probeCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'probe');
    if (probeCheckedCriteria.length > 0) {
      const evaluateProbe = deps.evaluateProbeChecks ?? evaluateCriterionProbeChecks;
      const probeEvaluation = await evaluateProbe({
        criteria: rubric.criteria,
        ratings,
        dispatchTool: deps.dispatchTool,
      });
      if (!probeEvaluation.ok) {
        return {
          ok: false as const,
          error: probeEvaluation.detail,
          checkRefusal: probeEvaluation,
        };
      }
      if (Object.keys(probeEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...probeEvaluation.checkRuns };
      }
    }

    // ── P-011 (owner-ratified D-006): native Cargo criterion checks ──
    // Vitest's file router intentionally refuses Rust source paths. Cargo checks
    // use their own manifest boundary and preserve explicit source attribution in
    // the stamped native run instead of routing `.rs` files through Vitest.
    const cargoCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'cargo');
    if (cargoCheckedCriteria.length > 0) {
      const evaluateCargo = deps.evaluateCargoChecks ?? evaluateCriterionCargoChecks;
      const checkScope = await resolveDeterministicCheckScope(args, {
        ...input,
        rubricWorkspaceId: rubric.workspaceId,
        rubricSubjectPlan: rubric.subjectPlan,
      });
      const checkEvaluation = await evaluateCargo({
        criteria: rubric.criteria,
        ratings,
        root: checkScope.root,
        ...(checkScope.workspaceId ? { workspaceId: checkScope.workspaceId } : {}),
        ...(checkScope.harnessSlug ? { harnessSlug: checkScope.harnessSlug } : {}),
        timeoutMs: SCORECARD_TEST_CHECK_TIMEOUT_MS,
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      if (Object.keys(checkEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...checkEvaluation.checkRuns };
      }
    }

    // ── P-006 (deterministic-coverage-census): kind:'coverage' criterion checks ──
    // The census counterpart of the block above, and it reads THE shared derivation
    // (`readCoverage`) rather than querying testing_surface_depth itself — the panel,
    // both state cells, the tool and now this gate all resolve through one function, so
    // the gate cannot disagree with the panel a human just read. A scope matching zero
    // surfaces REFUSES (a coverage gate over an empty scope is vacuously green, which is
    // precisely the defect this plan exists to make unrepresentable).
    const coverageCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'coverage');
    if (coverageCheckedCriteria.length > 0) {
      const evaluateCoverage = deps.evaluateCoverageChecks ?? evaluateCriterionCoverageChecks;
      // Hoisted to local consts so the narrowing survives into the closure below —
      // narrowing a property access does not carry across a function boundary.
      const subjectPlan = rubric.subjectPlan;
      const workspaceId = input.workspaceId;
      const coverageEvaluation = await evaluateCoverage({
        criteria: rubric.criteria,
        ratings,
        readCoverage: (a) => readCoverage(a),
        // planTouched resolves to the files the subject plan's COMPLETED work actually
        // changed. Only an acceptance rubric has a subject plan; anywhere else this
        // returns null and the check refuses rather than silently widening its scope.
        // The workspace is required for the SAME reason: planTouchedFiles filters on
        // `workspace_id`, so resolving it without one would widen the scope to every
        // workspace's rows — the silent-widening this check exists to refuse.
        resolvePlanTouchedFiles: () =>
          subjectPlan && workspaceId ? planTouchedFiles(workspaceId, subjectPlan) : Promise.resolve(null),
      });
      if (!coverageEvaluation.ok) {
        return {
          ok: false as const,
          error: coverageEvaluation.detail,
          checkRefusal: coverageEvaluation,
        };
      }
      if (Object.keys(coverageEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...coverageEvaluation.checkRuns };
      }
    }

    // ── P-026 (design-to-code-coverage-seam): kind:'requirements' criterion checks ──
    // The design→code counterpart of the two blocks above. It runs the SAME P-014
    // activation↔completion join that `plan-acceptance-gate` enforces as
    // `requirement_unrealized`, for a different reader: the gate answers "may the author
    // ship", this answers "which of the plan's stated promises have no observable code"
    // for the INDEPENDENT GRADER — who cannot run Bash, and therefore has no other way to
    // ask. Reusing the judge rather than re-deriving it is the point: two implementations
    // of this join could disagree, and the one the grader sees must be the one the gate
    // enforces.
    const requirementsCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'requirements');
    if (requirementsCheckedCriteria.length > 0) {
      const evaluateRequirements = deps.evaluateRequirementChecks ?? evaluateCriterionRequirementChecks;
      // Hoisted for the same narrowing reason as the coverage block above.
      const requirementsPlan = rubric.subjectPlan;
      const requirementsEvaluation = await evaluateRequirements({
        criteria: rubric.criteria,
        ratings,
        readRequirementRealization: async () => {
          if (!requirementsPlan) return null;
          // Read all three together. They are independent queries over the same plan, and
          // the judge's own contract treats an empty planItems list as "not supplied"
          // (never as "the plan has no items"), so a transient read failure degrades to
          // the pre-P-016 behaviour instead of convicting every target.
          // Item rows are owned per (harness, slug), so scope them to the subject plan's
          // harness (WI-10005167). The two audit reads stay (workspace, slug): plan_audits
          // is keyed that way and its harness_slug is only a citation context.
          const [activationAudit, itemAudits, planItems] = await Promise.all([
            getLatestActivationAudit(requirementsPlan),
            getEffectiveItemAudits(requirementsPlan),
            getPlanItemStatuses(requirementsPlan, { harnessSlug: rubric.subjectHarnessSlug }),
          ]);
          const proof = itemAudits.some(({ entry }) => entry.verdict === 'not-code')
            ? await readAndEvaluateAcceptanceBarLifecycle(requirementsPlan, 'pre-grading', {
                current: args.current,
                harnessSlug: rubric.subjectHarnessSlug,
              })
            : null;
          return {
            planSlug: requirementsPlan,
            mappings: activationAudit?.activation?.mappings ?? [],
            itemAudits,
            planItems,
            nonCodeItemProofs: proof?.nonCodeItemProofs,
          };
        },
      });
      if (!requirementsEvaluation.ok) {
        return {
          ok: false as const,
          error: requirementsEvaluation.detail,
          checkRefusal: requirementsEvaluation,
        };
      }
      if (Object.keys(requirementsEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...requirementsEvaluation.checkRuns };
      }
    }

    const gradedGeneration = await readCurrentGeneration();
    // WI-10003539 / goal-agent-behavior-feedback-2026-09-06 R-1: a graded AGENT RUN
    // carries a server-derived evidence record (goal, holder, window, launch
    // generation, instruction exposure). Derived from durable records only, never
    // from grader input, and written AFTER `subject` so nothing can override it.
    const evidenceRecord =
      args.subject?.kind === 'agent-run'
        ? await deriveAgentRunEvidenceRecordSafe({
            getSql: () => getOrgPg().sql as unknown as EvidenceRecordSql,
            workspaceId: input.workspaceId || activeWorkspaceId(),
            holder: args.subject.ref,
            windowStart: args.subject.windowStart ?? null,
            windowEnd: args.subject.windowEnd ?? null,
          })
        : null;
    // EI-23074025929199961: this stamp measures the SEPARATE Scout bg-host.
    // Its boot HEAD differing from the querying build says nothing about this
    // evaluator's freshness. Preserve and surface that telemetry, but never use
    // it to refuse an otherwise valid scorecard. Exact evaluator build/selection
    // and pass-claim checks remain in validateSpecTestAdequacyReplay above.
    const result = await captureImprovement({
      title: args.title ?? `Scorecard: ${rubric.title}${sourceHive ? ` — ${sourceHive}` : ''}`,
      kind: 'change',
      body: args.body,
      lane: 'observation',
      // D-002 (observation-lane-scorecard-classification-2026-08-16): an emitted
      // scorecard is a COMPLETED verdict — file it terminal so it never renders as
      // an untriaged open observation. Reads are state-agnostic (scorecards:list
      // selects on payload.observation.rubricRef only), so history/trends/gates
      // are unaffected.
      initialState: 'done',
      createdBy: input.createdBy,
      filedByRole: 'su',
      payloadExtra: {
        observation: {
          rubricRef: args.rubricRef,
          ...(rubricRevision != null ? { rubricRevision } : {}),
          ...(criteriaHash != null ? { criteriaHash } : {}),
          ...(rubricMeaningRevision != null ? { rubricMeaningRevision } : {}),
          ratings,
          ...(boundTestedSha ? { testedSha: boundTestedSha } : {}),
          ...(releaseGateBinding ? { releaseGateBinding } : {}),
          ...(acceptanceRecord ? { acceptance: acceptanceRecord } : {}),
          ...(args.rerunRecipe ? { rerunRecipe: args.rerunRecipe } : {}),
          ...(sourceHive ? { sourceHive } : {}),
          ...(args.targetHive ? { targetHive: args.targetHive } : {}),
          ...(instrumentSnapshots ? { instrumentSnapshots } : {}),
          evidenceFingerprint,
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(gradedGeneration ? { gradedGeneration } : {}),
          ...(provisional ? { provisional } : {}),
          ...(gradingAudit ? { gradingAudit } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(evidenceRecord ? { evidenceRecord } : {}),
          ...(subjectRubricIdentity ? { subjectRubricIdentity } : {}),
          ...(rollup ? { rollup } : {}),
          ...(vetting ? { vetting } : {}),
          ...(checkRuns ? { checkRuns } : {}),
        },
      },
    });
    // The advisory lock covers the final dedup read through the complete ledger
    // capture. Post-write notifications/audit settlement are deliberately outside
    // the critical section so a slow subscriber cannot serialize future emits.
    if (releaseScorecardEmitMutex) {
      await releaseScorecardEmitMutex();
      releaseScorecardEmitMutex = undefined;
    }
    if (result.created) {
      // Push-on-write (push-audit 2026-07-26): the Verify stage's scorecard
      // list + rubric trend + release-readiness strip all fold this filing in.
      void trackDetached(import('../../sync-sse'))
        .then((m) => {
          m.notifySyncInvalidate('scorecards.list');
          m.notifySyncInvalidate('rubrics.trend');
          m.notifySyncInvalidate('learning.releaseReadiness');
        })
        .catch(() => {});
    }
    // P-013: settle the audited card's stamp now that the audit card is filed. A
    // settlement failure is surfaced loudly, never swallowed — the auditor must know
    // the subject is still pending.
    let auditSettlement: Awaited<ReturnType<typeof recordGradingAudit>> | undefined;
    let auditCleanupError: string | undefined;
    if (auditContext && result.created && result.issue?.id) {
      auditSettlement = await recordGradingAudit(auditContext.subjectIssueId, {
        auditIssueId: result.issue.id,
        auditor: auditContext.auditor,
        verdict: auditContext.verdict,
        requireCurrentIdentity: true,
        ...(auditContext.dispatchReservation ? { dispatchReservation: auditContext.dispatchReservation } : {}),
        ...(auditContext.rubricRevision != null ? { rubricRevision: auditContext.rubricRevision } : {}),
        ...(auditContext.criteriaHash ? { criteriaHash: auditContext.criteriaHash } : {}),
        ...(args.supersedes ? { supersedesAuditIssueId: args.supersedes } : {}),
      });
      if (auditSettlement.ok) {
        try {
          await (deps.closeSourceAuditConsults ?? closeSourceAuditConsults)(
            input.workspaceId || activeWorkspaceId(),
            auditContext.subjectIssueId,
          );
        } catch (error) {
          auditCleanupError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    const acceptanceGraderCleanup =
      rubric.kind === 'acceptance' && input.role === 'judge'
        ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
        : undefined;
    // EI-21434202765745827: fire the awaitable "this rubric was just graded" key. The
    // plan-completion contract REQUIRES a non-implementer to grade an implementer's plan,
    // so "wait for someone else's scorecard" is the designed happy path of every ship —
    // but until this emit there was no key for it, and the implementer could only re-poll
    // scorecards:list. Gated on `result.created` so only a genuinely FILED card wakes
    // anyone (a refused or re-read emit fires nothing), and fail-soft inside, so a failed
    // emit can never fail the scorecard write that already succeeded.
    if (result.created && result.issue?.id) {
      // EI-24852356444105284: a settled grading audit also fires
      // `scorecard:grading-audit:<audited id>` — the audited card is already terminal,
      // so no work-item status event can tell its author the verdict landed.
      const settledStamp = auditContext && auditSettlement?.ok ? auditSettlement.gradingAudit : undefined;
      const settledAudit =
        auditContext && settledStamp && (settledStamp.state === 'passed' || settledStamp.state === 'failed')
          ? {
              issueId: auditContext.subjectIssueId,
              state: settledStamp.state,
              auditIssueId: settledStamp.auditIssueId ?? result.issue.id,
              auditor: settledStamp.auditor ?? null,
              auditedAt: settledStamp.auditedAt ?? null,
              rubricRevision: settledStamp.rubricRevision ?? null,
            }
          : undefined;
      await emitScorecardEmitted(
        {
          issueId: result.issue.id,
          rubricRef: args.rubricRef,
          rubricKind: rubric.kind ?? null,
          subjectKind: args.subject?.kind ?? null,
          subjectRef: args.subject?.ref ?? null,
          createdBy: input.createdBy ?? null,
          hasAcceptance: Boolean(args.acceptance),
        },
        {
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(settledAudit ? { settledAudit } : {}),
        },
      );
    }
    // P-013 backlog repair: every newly filed non-audit scorecard is a cheap,
    // durable trigger for the bounded oldest-first pending-audit dispatcher.
    // Do not trigger from the audit card itself: its own emit would recursively
    // fan out the same backlog while the original dispatch is still in flight.
    // The dispatcher is detached so a historical backlog cannot stretch the
    // scorecards:emit latency or fail a card that was already written.
    if (result.created && result.issue?.id && input.launchContext && args.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF) {
      const dispatchAudits = deps.dispatchPendingGradingAudits ?? dispatchPendingGradingAudits;
      void trackDetached(
        dispatchAudits({
          targetIds: [],
          ctx: input.launchContext,
          harness: input.ctxHarness,
        }).then(() => undefined),
      ).catch(() => {});
    }
    // unified-responder-selection-critique-and-grading-2026-08-30 D-003 [owner]:
    // grading is a CASCADE of up to two graders, and grader 2 is woken holding
    // grader 1's card. Filing the card is the act that discharges a grading, so
    // it is what advances the chain — see advanceGradingCascadeOnCard for why a
    // consult reply alone is not enough, and for the two independent reasons a
    // duplicate or out-of-turn card cannot double-advance it. Same `created`
    // gate as the emit above, and the same fail-soft contract: it swallows its
    // own faults rather than failing a card that is already written.
    if (result.created && rubric.kind === 'acceptance' && input.workspaceId && input.createdBy && !args.acceptance) {
      await advanceGradingCascadeOnCard({
        workspaceId: input.workspaceId,
        rubricRef: args.rubricRef,
        graderOwnerId: input.createdBy,
        cardSummary: gradingCardDigestExcerpt(ratings),
      });
    }
    return {
      ok: true as const,
      created: result.created,
      issueId: result.issue?.id ?? null,
      evidenceFingerprint,
      ...(gradedGeneration
        ? {
            gradedGeneration,
            staleHost: gradedGeneration.staleHost,
            deployedSha: gradedGeneration.deployedSha,
          }
        : {}),
      ...(evidenceRecord ? { evidenceRecord } : {}),
      // P-013: surfaced loudly — this card does not enter the trend until audited.
      // A bare boolean was NOT loud enough: it says THAT the card is pending but not what
      // settles it, so callers rediscovered the mechanism a gate-refusal later
      // (EI-22068670622018218: emitted the exact terminal cards, read `gradingAuditPending`
      // as incidental, then read plans:start's refusal as the cards being missing) or by
      // hand-tracing the audit contract. The next step ships WITH the stamp that creates it.
      ...(gradingAudit
        ? {
            gradingAuditPending: true,
            gradingAuditNextStep:
              'The existing router automatically selects an independent auditor; declines and expiry advance its cascade, with a bounded fresh-judge fallback when no candidate is available. ' +
              'This card does not satisfy a gate until a NON-AUTHOR audits it. A DIFFERENT agent must emit ' +
              `{ rubricRef:'${GRADING_INTEGRITY_RUBRIC_REF}', terminal:true, subject:{ kind:'scorecard', ` +
              `ref:'${result.issue?.id ?? '<this card id>'}' }, ratings:{...} }. Self-audits are refused, and ` +
              're-emitting this card yourself files a duplicate pending card instead of settling this one.',
          }
        : {}),
      ...(auditSettlement
        ? {
            gradingAuditRecorded: auditSettlement.ok,
            ...(auditCleanupError ? { gradingAuditCleanupError: auditCleanupError } : {}),
            ...(auditSettlement.gradingAudit ? { gradingAudit: auditSettlement.gradingAudit } : {}),
            ...(auditSettlement.error ? { gradingAuditError: auditSettlement.error } : {}),
          }
        : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      canonicalRatings: ratings,
      ...(releaseGateBinding ? { releaseGateBinding } : {}),
      ...(acceptanceRecord ? { acceptance: acceptanceRecord } : {}),
      // P-008: surfaced loudly so the emitter knows this card is a working note — a
      // terminal re-emit (terminal:true, supersedes this issueId) finalizes it.
      ...(provisional ? { provisional } : {}),
      // P-011: the live deterministic check verdicts this card was filed with.
      ...(checkRuns ? { checkRuns } : {}),
      ...(vettingWarning ? { warning: vettingWarning } : {}),
      ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) return { ok: false as const, error: error.message };
    throw error;
  } finally {
    // Covers every refusal/exception between the final dedup read and capture,
    // including a failed deterministic check or a capture that throws.
    if (releaseScorecardEmitMutex) {
      await releaseScorecardEmitMutex().catch(() => {});
      releaseScorecardEmitMutex = undefined;
    }
  }
}

export default defineTool({
  name: 'scorecards:emit',
  profile: 'engineer',
  // P-011 prompt-weight: `description` + when/notWhen/chaining are counted; `returns` and
  // `seeAlso` are FREE. This tool had no `returns` at all, so its response and refusal
  // semantics (the acknowledgeExisting/force dedup rules, the generation + instrument
  // stamping, the existing_independent_scorecards retry) were being paid for in counted
  // prose. Moved verbatim below — nothing deleted (EI-22083648545226771).
  description:
    "Validate, canonicalize, and file one COMPLETE rubric scorecard through the existing observation ledger. Requires evidence for every declared criterion. For kind:'acceptance', a non-implementer emits ratings first; the rubric author then emits a separate newer card with acceptance:{verdict,reasoning} and no supersedes, so the independent grading remains visible to the plan-acceptance gate. Every emit persists complete ratings; the author's acceptance adopts them from the card it cites in acceptanceOf.",
  guidance: {
    when: 'Filing a GRADE-mode or release-readiness scorecard. Prefer this typed surface over hand-assembling improvements:capture observation payloads.',
    notWhen:
      'Building the grading skeleton or previewing a delta — scorecards:evaluate. Free-text observations — improvements:capture.',
    returns:
      'Returns { ok, created, issueId, evidenceFingerprint, canonicalRatings }. A positive releaseGating card also returns and stores `releaseGateBinding`; a failed binding returns code `stale_pass_blocked` with status `stale-pass-blocked`, the gate reason/failing tests, tested vs green/head SHAs, and `commitsBehindHead`, and writes no card. Successful emits surface `gradedGeneration`, `staleHost` and `deployedSha`: these describe the separate Scout bg-host relative to the querying build, not evaluator freshness. Exact spec-test-adequacy replay independently refuses changed evaluator builds, missing identities or contradicted pass claims. A terminal standard-rubric card also carries `gradingAuditPending: true` alongside `gradingAuditNextStep`, which names the NON-AUTHOR grading-integrity emit that settles it — self-audits are refused, and re-emitting the card yourself files a duplicate pending card instead of settling this one. `provisional` marks a working note that a terminal re-emit (terminal:true, supersedes this issueId) finalizes. REFUSALS: when complete independent scorecards already exist for the same rubric revision, emit returns existing_independent_scorecards — inspect its ids and retry with acknowledgeExisting:true when another independent sample is intentional; force:true only bypasses unchanged-evidence deduplication. Stamps the running generation and stores deterministic instrument snapshots.',
    chaining:
      'scorecards:evaluate { rubricRef } → grade every returned criterion → scorecards:evaluate { rubricRef, ratings, instrumentSnapshots, testedSha } → scorecards:emit with that same canonical payload → scorecards:list / rubrics:trend. `testedSha` is required when a releaseGating rubric has a pass-like rating. For acceptance rubrics, the non-implementer grading and the author acceptance are separate cards; the author acceptance adopts ratings via acceptanceOf; do not pass supersedes on the author acceptance.',
    seeAlso: ['scorecards:evaluate', 'scorecards:list', 'rubrics:trend'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // P-011 (D-006): grading a rubric with tests-checks shells a real Vitest run and can
  // block for tens of seconds without ever reading `ctx.tx` — holding the ambient
  // workspace transaction across that wait would trip idle_in_transaction_session_timeout
  // (60s), surfacing as a bare `write CONNECTION_CLOSED`. Same declaration as
  // testing:run, for the same reason; every DB access here manages its own connection.
  skipWorkspaceTx: true,
  // EI-20965113106044588: the deterministic gate can legitimately exceed the flat
  // 55s MCP deadline. Declaring the real tool budget makes effectiveMcpDeadlineMs
  // extend the transport race instead of returning request_timeout while the
  // mutation is still running server-side.
  timeoutSec: SCORECARD_EMIT_TIMEOUT_SEC,
  // EI-24054635524770728: force:true deliberately permits two distinct cards, so
  // this tool is NOT globally idempotent. A completed handler can still prove
  // what this exact attempt did through its durable issue id. The dispatcher's
  // abort-race branch surfaces only that receipt-bearing result and fails closed
  // when the receipt is absent or incomplete.
  abortCompletionReceipt: (_args, result) => scorecardAbortCompletionReceipt(result),
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEmitArgs,
  // The `returns` prose above INTERPRETS this result; the structural shape comes from
  // here (guidance-output-schema-live-guard). `ok` is a BOOLEAN, not a literal true:
  // the ObservationEvidenceError path returns `{ ok:false, error }`. Everything past
  // the five promised fields is conditional — gradingAudit*, acceptance, provisional,
  // supersedes, checkRuns, warning, acceptanceGraderCleanup are all spread in only when
  // they apply — so the object stays OPEN rather than enumerating a shape the handler
  // does not always produce.
  result: z
    .object({
      ok: z.boolean(),
      created: z.boolean().optional(),
      issueId: z.string().nullable().optional(),
      evidenceFingerprint: z.string().optional(),
      gradedGeneration: z
        .object({
          deployedSha: z.string().nullable(),
          hostStartedAt: z.string().nullable(),
          bootHeadSha: z.string().nullable(),
          scoutCodeHash: z.string().nullable(),
          staleHost: z.boolean(),
        })
        .optional(),
      staleHost: z.boolean().optional(),
      deployedSha: z.string().nullable().optional(),
      code: z.string().optional(),
      canonicalRatings: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const data = await emitScorecardForToolContext(args, ctx);
    return { data: attachScorecardCompletionReceipt(data) };
  },
});

type ScorecardCompletionData = {
  ok: boolean;
  created?: boolean;
  issueId?: string | null;
  previousIssueId?: string | null;
  reason?: string;
  code?: string;
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function scorecardCompletionReceipt(data: ScorecardCompletionData): AbortCompletionReceipt {
  if (!data.ok) {
    return {
      status: 'not-recorded',
      reason: data.code ?? data.error ?? data.reason ?? 'scorecard emit refused before recording a card',
    };
  }
  const effectRef = data.issueId ?? data.previousIssueId ?? null;
  if (effectRef) {
    return {
      status: 'recorded',
      effectRef,
      ...(data.created === false ? { reason: data.reason ?? 'existing-card' } : {}),
    };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'scorecard emit reported success without a durable issue identity',
    failures: ['missing-issue-id'],
  };
}

export function attachScorecardCompletionReceipt<T extends ScorecardCompletionData>(
  data: T,
): T & { completionReceipt: AbortCompletionReceipt } {
  return { ...data, completionReceipt: scorecardCompletionReceipt(data) };
}

function scorecardResultPayload(result: ToolResult): Record<string, unknown> | null {
  const structured = asRecord(result.structuredContent);
  if (structured) return structured;
  const firstText = result.content.find(
    (item): item is Extract<ToolResult['content'][number], { type: 'text' }> => item.type === 'text',
  );
  if (!firstText) return null;
  try {
    return asRecord(JSON.parse(firstText.text));
  } catch {
    return asRecord(parseJsonWithTrailer(firstText.text)?.value);
  }
}

export function scorecardAbortCompletionReceipt(result: ToolResult): AbortCompletionReceipt {
  const receipt = asRecord(scorecardResultPayload(result)?.completionReceipt);
  const status = receipt?.status;
  if (!receipt || (status !== 'recorded' && status !== 'not-recorded' && status !== 'recovery-incomplete')) {
    return {
      status: 'recovery-incomplete',
      reason: 'scorecards:emit result omitted a valid completionReceipt',
      failures: ['missing-completion-receipt'],
    };
  }
  return {
    status,
    ...(typeof receipt.effectRef === 'string' ? { effectRef: receipt.effectRef } : {}),
    ...(typeof receipt.reason === 'string' ? { reason: receipt.reason } : {}),
    ...(Array.isArray(receipt.failures) && receipt.failures.every((value) => typeof value === 'string')
      ? { failures: receipt.failures as string[] }
      : {}),
  };
}

/**
 * The scorecards:emit handler body, exported so a composing verb
 * (plans:certify-spec-clauses) files cards through the IDENTICAL identity, harness,
 * check-root and replay-dispatch wiring instead of a hand-copied second path. A fork
 * here is how an evaluator-built card could pass one emit route and fail the other.
 */
export async function emitScorecardForToolContext(
  args: z.infer<typeof scorecardEmitArgs>,
  // The full tool-handler context: GradingAuditLaunchContext IS that type (it is derived
  // from a defineTool handler's ctx parameter), and the handler above passes its own ctx.
  ctx: GradingAuditLaunchContext,
) {
  const identity = resolveAgentIdentity(ctx);
  const ctxHarness =
    typeof ctx.harnessSlug === 'string' && ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : undefined;
  return emitScorecard(
    args,
    {
      createdBy: identity.ownerId,
      ctxHarness,
      role: ctx.role,
      workspaceId: identity.workspaceId ?? undefined,
      launchContext: ctx,
      // P-011: tests-checks resolve + run against the tree the AGENT edits.
      checkRoot: resolveAgentWorkspaceRoot(ctx),
    },
    { dispatchTool: ctx.dispatchTool },
  );
}
