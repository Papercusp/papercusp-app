/** Test-time provenance uses existing immutable spec bindings, including pending executions. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import {
  bindSpecEvidence, listSpecEvidence, measureRepoFilesEvidenceAtRoot, measureAndPinRepoFilesEvidenceAtRoot, retractSpecEvidence,
  ADHOC_WORK_ITEM_SPEC_SCOPE, MEASUREMENT_PIN_DETAILS_KEY, repoFilesEvidenceMeasurementSchema,
  type BindSpecEvidenceInput, type MeasurementPin, type RepoFilesEvidenceMeasurement,
} from '../plans/spec-evidence-store';
import { getRunAsync, readHarnessTestRunEvidence, countUnattributedTestRunRows,
  type HarnessTestRunEvidence, type RunSnapshot } from '../../testing-run-store';
import { resolveScenarioRerunScope } from './scenario-rerun-scope';
import type { TestFilesCoreResult } from './run';
import { SPEC_PROOF_OBLIGATION_ID_RE } from '../plans/spec-clauses-store';
import { RECORDED_TEST_LAYERS, parseTestRunExecutionDetails, recordedTestLayer } from '@papercusp/test-config/execution-details';

const proofId = z.string().regex(SPEC_PROOF_OBLIGATION_ID_RE).max(200);
const bindingSchema = z.object({
  specId: z.string().min(1).max(200), specRevision: z.number().int().positive(),
  testPath: z.string().min(1).max(500),
  sourcePaths: repoFilesEvidenceMeasurementSchema.shape.sourcePaths,
  // The ONE recorder taxonomy (EI-24434635346407728); a label the ledger row contradicts
  // is still refused as a layer mismatch below, so widening the vocabulary grants nothing.
  testLayer: z.enum(RECORDED_TEST_LAYERS),
  scenarioIds: z.array(proofId).min(1).max(100).optional(),
  causalPairId: proofId.optional(),
  counterexample: z.object({ test: z.string().min(1).max(500), messageIncludes: z.string().min(1).max(500) }).optional(),
}).strict();
export const testEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  bindings: z.array(bindingSchema).min(1).max(20),
}).strict();
/**
 * EI-24207525450988644 — how long a recovery call waits in-process for the detached run to
 * reach a terminal snapshot before reconciling. Without it, every foreground timeout cost
 * the caller a separate testing:run-status polling loop before recovery (measured in the
 * review-rework R-8 canary: 6 and 8 polls on the two groups that hit the cap). The ceiling
 * stays below the testing:run foreground cap so the reconcile work after the wait still
 * fits inside the ~55s MCP transport limit.
 */
export const RECOVERY_WAIT_DEFAULT_MS = 30_000;
export const RECOVERY_WAIT_CEILING_MS = 40_000;
export const RECOVERY_WAIT_POLL_MS = 2_000;
/**
 * A pending evidence row is registered before a test process starts. Give the process
 * admission/snapshot write a bounded window before treating a missing run as abandoned.
 */
export const PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS = 60_000;
export const recoverTestEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  originRunId: z.string().uuid(), runId: z.string().uuid(),
  waitMs: z.number().int().min(0).max(RECOVERY_WAIT_CEILING_MS).optional()
    .describe(`Wait up to this long (default ${RECOVERY_WAIT_DEFAULT_MS}ms) for a detached run to finish and its file-level ledger result to arrive before reconciling; 0 reconciles immediately.`),
}).strict();
type Request = z.infer<typeof testEvidenceSchema>;
type Recovery = z.infer<typeof recoverTestEvidenceSchema>;
/**
 * `rootHarnessSlug` names the registered checkout `root` belongs to when it is NOT the
 * session harness's own tree (a hive app such as phone-app). It is stamped into every
 * measurement so the evaluator and a later re-measure resolve the SAME checkout instead
 * of the plan harness root, where the paths do not exist (EI-25203154942838341).
 */
type Scope = { workspaceId: string; harnessSlug: string; actorId: string; root: string; rootHarnessSlug?: string };
type Prepared = { input: BindSpecEvidenceInput; binding: Request['bindings'][number]; measurement: RepoFilesEvidenceMeasurement;
  observedAt?: string };
type Deps = {
  bind: typeof bindSpecEvidence; measure: typeof measureRepoFilesEvidenceAtRoot;
  ledger: typeof readHarnessTestRunEvidence; list: typeof listSpecEvidence;
  unattributed: typeof countUnattributedTestRunRows;
  /** Read the detached process snapshot before treating an absent file row as recoverable. */
  runStatus?: typeof getRunAsync;
  /**
   * P-018 commit pin. Optional so a caller with a fake `measure` never silently gets a
   * real filesystem/git probe mixed into its fixture; the production defaults supply it.
   */
  pin?: typeof measureAndPinRepoFilesEvidenceAtRoot;
  /** Used only by the re-measure path to withdraw a replaced stale predecessor. */
  retract?: typeof retractSpecEvidence;
  /** Recovery wait seam (EI-24207525450988644); fixtures inject a fake clock instead of real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};
const defaults: Deps = { bind: bindSpecEvidence, measure: measureRepoFilesEvidenceAtRoot,
  ledger: readHarnessTestRunEvidence, list: listSpecEvidence,
  unattributed: countUnattributedTestRunRows, pin: measureAndPinRepoFilesEvidenceAtRoot,
  retract: retractSpecEvidence, runStatus: getRunAsync,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now() };

/**
 * The commit pin for a measurement, or null. The pin re-reads the files, so it is kept
 * ONLY when its own fingerprints equal the ones being bound: a file that moved between
 * the two reads would otherwise pin bytes the proof was never measured against.
 */
async function pinFor(root: string, measurement: RepoFilesEvidenceMeasurement,
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null }, deps: Deps): Promise<MeasurementPin | null> {
  if (!deps.pin) return null;
  const pinned = await deps.pin(root, measurement).catch(() => null);
  if (!pinned) return null;
  return pinned.sourceFingerprint === fingerprints.sourceFingerprint && pinned.testFingerprint === fingerprints.testFingerprint
    ? pinned.pin : null;
}

/**
 * Why a scoped ledger read found no row. An absent run and an unattributed one
 * are opposite diagnoses — the first says re-run the test, the second says the
 * test already ran and the ledger write lost its tenant columns — so they must
 * never collapse into the same bare `pending`. 'unknown' is in-band: the probe
 * itself failed, which is not evidence that nothing ran.
 */
type LedgerAttribution = 'attributed' | 'unattributed' | 'absent' | 'ambiguous' | 'unknown';
// The ref names the original evidence attempt. Timeout recovery may run under a
// detached group, so callers must use ledgerRunGroupId (or testRunId) to join the ledger.
const refFor = (runId: string, index: number) => `test-run-group:${runId}:${index}`;
const succeeded = (status: string) => status === 'created' || status === 'unchanged';

function isTerminalRunSnapshot(run: RunSnapshot | null | undefined): run is RunSnapshot {
  return run != null && run.finishedAt !== null && run.status !== 'running';
}

function pendingEvidenceAgeMs(observedAt: string | undefined, now: number): number | null {
  if (typeof observedAt !== 'string') return null;
  const observedAtMs = Date.parse(observedAt);
  return Number.isFinite(observedAtMs) && observedAtMs <= now ? now - observedAtMs : null;
}

type PendingRetirement = {
  bindingIds: number[];
  failures: Array<{ bindingId: number | null; error: string }>;
};

/** Retract only pending rows from the same immutable run attempt and evidence reference. */
async function retirePendingAttemptBindings(
  prepared: Prepared,
  originRunId: string,
  runId: string,
  scope: Scope,
  reason: string,
  deps: Deps,
): Promise<PendingRetirement> {
  if (!deps.retract) return { bindingIds: [], failures: [{ bindingId: null, error: 'retraction_unavailable' }] };
  let rows: Awaited<ReturnType<typeof listSpecEvidence>>;
  try {
    rows = await deps.list({ harnessSlug: scope.harnessSlug,
      planSlugs: [prepared.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE],
      workItemIds: [prepared.input.workItemId], evidenceRefs: [prepared.input.evidenceRef], limit: 500 });
  } catch (error) {
    return { bindingIds: [], failures: [{ bindingId: null, error: String(error).slice(0, 300) }] };
  }
  const pending = rows.filter(row => {
    const execution = (row.details as { testExecution?: unknown } | null)?.testExecution as
      { schemaVersion?: number; phase?: string; runId?: string; originRunId?: string } | undefined;
    return row.id > 0 && !row.withdrawal && row.evidenceKind === prepared.input.evidenceKind
      && row.specId === prepared.input.specId && row.specRevision === prepared.input.specRevision
      && row.evidenceRef === prepared.input.evidenceRef && row.testRunId == null
      && execution?.schemaVersion === 1 && execution.phase === 'pending'
      && execution.originRunId === originRunId
      && (execution.runId === originRunId || execution.runId === runId);
  });
  const bindingIds: number[] = [];
  const failures: PendingRetirement['failures'] = [];
  for (const row of pending) {
    try {
      const result = await deps.retract({ harnessSlug: scope.harnessSlug, bindingId: row.id, reason, actorId: scope.actorId });
      if (result.status === 'retracted' || result.status === 'already_retracted' || result.status === 'not_found')
        bindingIds.push(row.id);
    } catch (error) {
      failures.push({ bindingId: row.id, error: String(error).slice(0, 300) });
    }
  }
  return { bindingIds, failures };
}

/** Only a complete, exact reporter measurement can replace a lost foreground result. */
function recoveredFileResult(run: HarnessTestRunEvidence | undefined, binding: Request['bindings'][number],
  runId: string, scope: Scope): TestFilesCoreResult | undefined {
  const detail = parseTestRunExecutionDetails(run?.execution_details);
  if (!detail || !run || binding.counterexample) return undefined;
  if (detail.runGroupId !== runId || detail.workspaceId !== scope.workspaceId
    || detail.harnessSlug !== scope.harnessSlug || detail.root !== scope.root
    || detail.filePath !== binding.testPath || run.file_path !== binding.testPath) return undefined;
  // A pass row contradicting its measured failure must not manufacture proof.
  if (run.status === 'pass' && (detail.failed > 0 || detail.collectionFailed)) return undefined;
  return { ok: true, runId, root: scope.root, files: 1,
    passed: detail.passed, failed: detail.failed, skipped: detail.skipped,
    byFile: { [binding.testPath]: { passed: detail.passed, failed: detail.failed,
      skipped: detail.skipped, collectionFailed: detail.collectionFailed } },
    failures: [], failuresTruncated: false, durationMs: null,
    ...(detail.testNamePattern ? { testNamePattern: detail.testNamePattern } : {}),
  };
}

export async function prepareTestEvidence(request: Request, runId: string, files: string[], scope: Scope, deps: Deps = defaults) {
  const prepared: Prepared[] = [];
  // Validate every path and measure before any registration or process launch.
  const selected = new Set(files.map(file => resolve(scope.root, file)));
  for (const [index, binding] of request.bindings.entries()) {
    const absolute = resolve(scope.root, binding.testPath);
    if (!selected.has(absolute)) throw new Error(`evidence_test_not_selected:${binding.testPath}`);
    const testPath = relative(scope.root, absolute).replaceAll('\\', '/');
    const measurement = repoFilesEvidenceMeasurementSchema.parse({ schemaVersion: 1, kind: 'repo-files',
      ...(scope.rootHarnessSlug ? { rootHarnessSlug: scope.rootHarnessSlug } : {}),
      sourcePaths: binding.sourcePaths, testPaths: [testPath] });
    const fingerprints = await deps.measure(scope.root, measurement);
    const pin = await pinFor(scope.root, measurement, fingerprints, deps);
    const normalized = { ...binding, testPath };
    const input: BindSpecEvidenceInput = {
      workItemId: request.workItemId, planSlug: request.planSlug,
      harnessSlug: scope.harnessSlug, actorId: scope.actorId,
      specId: binding.specId, specRevision: binding.specRevision,
      evidenceKind: binding.counterexample ? 'counterexample' : 'test', evidenceRef: refFor(runId, index),
      ...fingerprints,
      details: { currentMeasurement: measurement,
        ...(pin ? { [MEASUREMENT_PIN_DETAILS_KEY]: pin } : {}),
        testExecution: { schemaVersion: 1, phase: 'pending', runId, originRunId: runId, binding: normalized },
        adequacy: { testLayer: binding.testLayer, outcome: 'pending', collected: false, executed: false,
          ...(binding.scenarioIds ? { scenarioIds: binding.scenarioIds } : {}),
          ...(binding.causalPairId ? { causalPairIds: [binding.causalPairId] } : {}) },
      },
    };
    prepared.push({ input, binding: normalized, measurement });
  }
  for (const row of prepared) {
    const receipt = await deps.bind(row.input);
    if (!succeeded(receipt.status)) throw new Error(`evidence_registration_failed:${receipt.status}`);
  }
  return prepared;
}

/**
 * EI-24100872054224181 — withdraw the pending rows `prepareTestEvidence` registered when the
 * run was then refused before any test process started. Finishing them instead would bind a
 * second pending row per binding, and remeasure skips a pending row as `run-in-flight`, so the
 * clause would stay stuck until someone retracted both by hand.
 */
export async function retractRefusedTestEvidence(prepared: Prepared[], runId: string, scope: Scope,
  refusal: string, deps: Deps = defaults) {
  const retiredIds = new Set<number>();
  const failures: PendingRetirement['failures'] = [];
  for (const row of prepared) {
    const retirement = await retirePendingAttemptBindings(row, runId, runId, scope,
      `testing:run ${runId} was refused (${refusal}) before any test process started; this attempt registered no proof.`, deps);
    retirement.bindingIds.forEach(id => retiredIds.add(id));
    failures.push(...retirement.failures);
  }
  const bindingIds = [...retiredIds].sort((a, b) => a - b);
  return { status: failures.length === 0 ? 'not-recorded' as const : 'retirement-incomplete' as const,
    reason: refusal, retiredCount: bindingIds.length, bindingIds: bindingIds.slice(0, 20),
    omitted: Math.max(0, bindingIds.length - 20), failures: failures.slice(0, 20) };
}

export function testEvidenceOutcome(
  binding: Request['bindings'][number],
  result?: TestFilesCoreResult,
): { outcome: string; collected: boolean; executed: boolean; skipped?: boolean; filteredSkipped?: number } {
  if (!result || result.error) return { outcome: result?.error ?? 'unknown', collected: false, executed: false };
  const counts = result.byFile[binding.testPath];
  if (!counts) return { outcome: 'unknown', collected: false, executed: false };
  const executed = !counts.collectionFailed && counts.passed + counts.failed > 0;
  // Vitest reports every non-matching assertion as `skipped` when an explicit
  // --testNamePattern is active. Those exclusions are not skipped evidence for
  // the selected proof. Preserve the old partial-skip behavior for unfiltered
  // runs, and still let any executed failure win over the selector.
  const nameFilterActive = typeof result.testNamePattern === 'string' && result.testNamePattern.trim().length > 0;
  let outcome = counts.collectionFailed
    ? 'error'
    : counts.failed > 0
      ? 'fail'
      : executed
        ? 'pass'
        : counts.skipped > 0
          ? 'skip'
          : 'unknown';
  if (!nameFilterActive && !counts.collectionFailed && counts.skipped > 0 && counts.failed === 0) outcome = 'skip';
  if (binding.counterexample && executed && counts.skipped === 0) {
    const negative = binding.counterexample;
    const exactFailure = result.failures.some(f => f.file === binding.testPath && f.test === negative.test && f.message.includes(negative.messageIncludes));
    outcome = executed && counts.failed === 1 && counts.skipped === 0 && exactFailure ? 'killed' : 'fail';
  }
  return {
    outcome,
    collected: !counts.collectionFailed,
    executed,
    // `skipped` is an adequacy claim about the selected proof, not the raw
    // reporter total. A name-filtered run reports non-matching cases as
    // skipped, but those cases were excluded rather than skipped evidence.
    skipped: !nameFilterActive && counts.skipped > 0,
    ...(nameFilterActive ? { filteredSkipped: counts.skipped } : {}),
  };
}

/**
 * The evidence a PREVIOUS run left for this binding's scenario matrix, or null. Read only on
 * the name-filtered path — an unfiltered run re-measures the matrix and carries nothing, so
 * the happy path pays no extra query (same miss-path-only shape as the attribution probe).
 *
 * A failed probe returns null, which resolves to `no-sibling-evidence`: evidence you could
 * not read is not evidence you may carry. Pinned to the same spec REVISION on purpose — a
 * row proving an older contract is not proof of this one.
 */
async function readSiblingEvidence(row: Prepared, scope: Scope, deps: Deps) {
  const rows = await deps.list({
    harnessSlug: scope.harnessSlug,
    planSlugs: [row.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE],
    // `binding.specId` rather than `input.specId`: the store's input type makes `specId`
    // optional (a binding may instead be keyed by `sourceValId`), but this path is only ever
    // reached for a schema-validated binding, where it is required — and line-for-line the
    // same value the input was built from. Reading the required field keeps the query total.
    workItemIds: [row.input.workItemId], specIds: [row.binding.specId],
    evidenceKinds: ['test'], limit: 50,
  }).catch(() => null);
  if (!rows) return null;
  const settled = rows.filter(candidate => {
    if (candidate.evidenceRef === row.input.evidenceRef) return false; // never itself
    if (candidate.specRevision !== row.input.specRevision) return false;
    const execution = candidate.details?.testExecution as { phase?: string; binding?: { testPath?: string } } | undefined;
    return execution?.phase === 'settled' && execution.binding?.testPath === row.binding.testPath;
  });
  const latest = [...settled].sort((a, b) => b.id - a.id)[0];
  return latest ? { evidenceRef: latest.evidenceRef, ...latest.fingerprints } : null;
}

export async function finishTestEvidence(prepared: Prepared[], originRunId: string, runId: string, scope: Scope,
  result?: TestFilesCoreResult, deps: Deps = defaults, terminalRun?: RunSnapshot) {
  const primaryLedger = await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: runId });
  // A foreground timeout can hand back a detached handle AFTER the reporter was
  // already launched with the original run-group id. Recovery must try that
  // persisted origin when the detached group has no rows; the exact reporter
  // scope/file/details checks below still decide whether it proves anything.
  const originLedger = originRunId !== runId && (primaryLedger?.length ?? 0) === 0
    ? await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: originRunId })
    : null;
  const ledger = (primaryLedger?.length ?? 0) > 0 ? primaryLedger : originLedger ?? primaryLedger;
  const ledgerRunGroupId = (originLedger?.length ?? 0) > 0 ? originRunId : runId;
  const rows = [];
  const retiredPendingBindingIds = new Set<number>();
  const pendingRetirementFailures: PendingRetirement['failures'] = [];
  const collectRetirement = (retirement: PendingRetirement) => {
    retirement.bindingIds.forEach(id => retiredPendingBindingIds.add(id));
    pendingRetirementFailures.push(...retirement.failures);
  };
  for (const row of prepared) {
    const matches = (ledger ?? []).filter(r => r.file_path === row.binding.testPath && r.finished_at !== null);
    const run = matches.length === 1 ? matches[0] : undefined;
    const testLayer = recordedTestLayer(run?.execution_details);
    const layerMismatch = testLayer !== undefined && testLayer !== row.binding.testLayer;
    const measured = await deps.measure(scope.root, row.measurement).catch(() => null);
    const sourceStable = measured !== null && measured.sourceFingerprint === row.input.sourceFingerprint && measured.testFingerprint === row.input.testFingerprint;
    const priorExecution = row.input.details?.testExecution as { phase?: string; runId?: string; ledgerStatus?: string } | undefined;
    const priorProof = row.input.details?.adequacy as { outcome?: string } | undefined;
    if (!result && run && !layerMismatch && priorExecution?.phase === 'settled' && priorExecution.runId === runId
      && row.input.testRunId === run.id && priorExecution.ledgerStatus === run.status) {
      rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
        evidenceRef: row.input.evidenceRef, testRunId: run.id, ledgerRunGroupId,
        phase: sourceStable ? 'settled' : 'source-changed', outcome: priorProof?.outcome ?? 'unknown', bindingStatus: 'unchanged' });
      continue;
    }
    const measuredResult = result ?? recoveredFileResult(run, row.binding, ledgerRunGroupId, scope);
    const outcome = testEvidenceOutcome(row.binding, measuredResult);
    const testNamePattern = measuredResult && !measuredResult.error ? measuredResult.testNamePattern : undefined;
    // A scoped read that found nothing cannot say WHY on its own. Probe the run
    // group WITHOUT the tenant predicate to tell a genuinely absent run apart
    // from one whose ledger write lost workspace_id/harness_slug — an
    // infrastructure fault, not a product one (R-8). Miss path only: the happy
    // path pays no extra query.
    let attribution: LedgerAttribution = 'attributed';
    let unattributedRows: number | null = null;
    if (matches.length > 1) attribution = 'ambiguous';
    else if (matches.length === 0) {
      unattributedRows = await deps
        .unattributed({ runGroupId: ledgerRunGroupId, filePath: row.binding.testPath })
        .catch(() => null);
      attribution = unattributedRows === null ? 'unknown'
        : unattributedRows > 0 ? 'unattributed' : 'absent';
    }
    // Legacy status-only rows remain unknown. Measured details are usable only
    // after exact scope/file attribution and the existing before/after hash check.
    // `ledger-unattributed` is a DIAGNOSTIC phase, never a proof phase: it is not
    // `settled`, so it cannot contribute a verificationFingerprint, and the
    // adequacy clamp below still forces outcome:'unknown'/executed:false.
    // SPEC-P006-FAILED-SCENARIO-RERUN: a name-filtered rerun executes ONE scenario but
    // settles a binding that claims the whole `scenarioIds` matrix, carrying the rest from
    // whatever a previous run recorded. Sound only while that record still matches disk.
    // The cheap pre-gate below mirrors the resolver's own null cases purely to avoid the
    // ledger read on the unfiltered path; `resolveScenarioRerunScope` stays the authority.
    const scenarioIds = (row.input.details?.adequacy as { scenarioIds?: string[] } | undefined)?.scenarioIds;
    const carriesSiblings = typeof testNamePattern === 'string' && testNamePattern.trim().length > 0
      && (scenarioIds?.length ?? 0) >= 2;
    const siblingEvidence = carriesSiblings ? await readSiblingEvidence(row, scope, deps) : null;
    const rerunScope = resolveScenarioRerunScope({ scenarioIds, testNamePattern,
      priorEvidence: siblingEvidence,
      current: { sourceFingerprint: row.input.sourceFingerprint, testFingerprint: row.input.testFingerprint } });
    // The carry was refused: this run measured strictly less than the binding claims, so it
    // is not proof — and, not being `settled`, it cannot contribute a verificationFingerprint.
    const carryRefused = rerunScope?.scope === 'full-matrix';
    const terminalNoResult = !run && attribution === 'absent' && isTerminalRunSnapshot(terminalRun);
    const phase = terminalNoResult ? 'terminal-no-result' : !run
      ? attribution === 'unattributed' ? 'ledger-unattributed' : 'pending'
      : !sourceStable ? 'source-changed'
        : layerMismatch ? 'layer-mismatch'
        : carryRefused ? 'stale-sibling-evidence'
          : !measuredResult || measuredResult.error ? 'review-required' : 'settled';
    const details = {
      ...row.input.details,
        testExecution: { schemaVersion: 1, phase, runId, originRunId, ledgerRunGroupId, binding: row.binding,
          ...(testNamePattern ? { testNamePattern } : {}),
          ...(outcome.filteredSkipped !== undefined ? { filteredSkipped: outcome.filteredSkipped } : {}),
          sourceStable, ledgerStatus: run?.status ?? 'unknown', ledgerMatches: matches.length,
          ledgerAttribution: attribution,
          ...(unattributedRows !== null ? { ledgerUnattributedRows: unattributedRows } : {}),
          measuredOutcome: outcome.outcome,
          ...(testLayer ? { observedTestLayer: testLayer } : {}),
          ...(rerunScope ? { rerunScope } : {}),
          ...(siblingEvidence?.evidenceRef ? { siblingEvidenceRef: siblingEvidence.evidenceRef } : {}),
        ...(result?.error ? { resultError: result.error } : {}),
      },
      adequacy: { ...(row.input.details?.adequacy as object), ...outcome,
        ...(testLayer ? { testLayer } : {}),
        // Missing/ambiguous or contradictory ledger attribution cannot establish execution.
        ...(!run || (outcome.outcome === 'pass' && run.status !== 'pass') || (outcome.outcome === 'killed' && run.status !== 'fail')
          ? { outcome: 'unknown', executed: false } : {}),
        // A refused carry is the same clamp for a different reason: the remaining matrix
        // was neither measured here nor currently proven elsewhere.
        ...(carryRefused ? { outcome: 'unknown', executed: false } : {}),
        ...(layerMismatch ? { outcome: 'unknown', executed: false } : {}),
      },
    };
    if (terminalNoResult) {
      const retirement = await retirePendingAttemptBindings(row, originRunId, runId, scope,
        `Detached test run ${runId} terminated (${terminalRun.status}, exit ${terminalRun.exitCode ?? 'unknown'}) ` +
          `without an attributed result for ${row.binding.testPath}; this attempt cannot settle and must be rerun.`, deps);
      collectRetirement(retirement);
      rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
        evidenceRef: row.input.evidenceRef, testRunId: null, ledgerRunGroupId: null, phase, outcome: 'unknown',
        bindingStatus: retirement.failures.length > 0 ? 'retirement-incomplete' : 'not-bound' });
      continue;
    }
    // Recovery or a caller-aborted run can have no attributed file row yet. The original
    // prepare step already wrote the pending marker; appending another pending binding here
    // only creates twins that every later remeasure also has to skip. Keep the original row
    // until a reporter result arrives or the bounded abandonment check retires it.
    if (phase === 'pending') {
      rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
        evidenceRef: row.input.evidenceRef, testRunId: null, ledgerRunGroupId: null,
        phase, outcome: 'unknown', bindingStatus: 'pending-retained' });
      continue;
    }
    const receipt = await deps.bind({ ...row.input, testRunId: run?.id ?? null, details });
    let bindingStatus: string = receipt.status;
    if (succeeded(receipt.status) && (phase === 'settled' || phase === 'source-changed')) {
      const retirement = await retirePendingAttemptBindings(row, originRunId, runId, scope,
        `Terminal test evidence for ${row.input.evidenceRef} supersedes older pending rows from this run attempt.`, deps);
      collectRetirement(retirement);
      if (retirement.failures.length > 0) bindingStatus = 'retirement-incomplete';
    }
    rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
      evidenceRef: row.input.evidenceRef, testRunId: run?.id ?? null,
      ledgerRunGroupId: run ? ledgerRunGroupId : null, phase,
      outcome: (details.adequacy as { outcome: string }).outcome, bindingStatus });
  }
  const retiredIds = [...retiredPendingBindingIds].sort((a, b) => a - b);
  return { status: rows.every(r => succeeded(r.bindingStatus)) && pendingRetirementFailures.length === 0 ? 'recorded' : 'incomplete',
    verificationFingerprint: rows.every(r => r.phase === 'settled')
      ? createHash('sha256').update(JSON.stringify(prepared.map(row => ({
        source: row.input.sourceFingerprint, test: row.input.testFingerprint, measurement: row.measurement,
      })))).digest('hex') : null,
    acceptance: 'requires-review', rows: rows.slice(0, 6), total: rows.length, omitted: Math.max(0, rows.length - 6),
    readRef: { tool: 'plans:get-spec-evidence', args: { harness: scope.harnessSlug,
      slug: prepared[0]!.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
      workItemIds: [prepared[0]!.input.workItemId], evidenceRefs: prepared.map(row => row.input.evidenceRef) } },
    ...(retiredIds.length > 0 || pendingRetirementFailures.length > 0 ? { pendingRetirement: {
      status: pendingRetirementFailures.length === 0 ? 'complete' : 'partial',
      retiredCount: retiredIds.length, bindingIds: retiredIds.slice(0, 20),
      omitted: Math.max(0, retiredIds.length - 20), failures: pendingRetirementFailures.slice(0, 20),
      failuresOmitted: Math.max(0, pendingRetirementFailures.length - 20),
    } } : {}),
    ...(terminalRun ? { detachedRunStatus: {
      runId: terminalRun.runId, status: terminalRun.status, exitCode: terminalRun.exitCode,
      finishedAt: terminalRun.finishedAt,
    } } : {}),
    recovery: { tool: 'testing:run', args: { harness: scope.harnessSlug, recoverEvidence: {
      workItemId: prepared[0]!.input.workItemId, planSlug: prepared[0]!.input.planSlug, originRunId, runId,
    } } },
  };
}

/** Return a bounded pending bundle; defer ledger reconciliation until the detached run can settle. */
export function deferredTestEvidenceRecoveryBundle(
  request: Pick<Request, 'workItemId' | 'planSlug' | 'bindings'>,
  originRunId: string,
  runId: string,
  harnessSlug: string,
) {
  const evidenceRefs = request.bindings.map((_, index) => refFor(originRunId, index));
  return {
    status: 'incomplete' as const,
    verificationFingerprint: null,
    acceptance: 'requires-review' as const,
    message: 'The foreground test run timed out. Evidence remains pending until recovery reconciles the detached run with the test ledger.',
    rows: request.bindings.slice(0, 6).map((binding, index) => ({
      specId: binding.specId,
      specRevision: binding.specRevision,
      evidenceRef: evidenceRefs[index],
      testRunId: null,
      ledgerRunGroupId: null,
      phase: 'pending' as const,
      outcome: 'unknown' as const,
    })),
    total: request.bindings.length,
    omitted: Math.max(0, request.bindings.length - 6),
    readRef: { tool: 'plans:get-spec-evidence', args: { harness: harnessSlug,
      slug: request.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
      workItemIds: [request.workItemId], evidenceRefs } },
    recovery: { tool: 'testing:run', args: { harness: harnessSlug, recoverEvidence: {
      workItemId: request.workItemId, planSlug: request.planSlug, originRunId, runId,
    } } },
  };
}

/**
 * P-018 / P-011: re-measure ONLY the test proofs whose measured source or test files
 * moved, in one call, from the recipes the bindings already persisted.
 *
 * The expensive part of a stale BAR was never the test run; it was the agent
 * re-deriving every binding's specId / testPath / sourcePaths / testLayer by hand
 * (~20 tool calls per BAR on turn-start-memory-two-class-2026-09-21). Every settled
 * test binding already stores that exact recipe in `details.testExecution.binding`, so
 * the re-measure is mechanical and needs no retyped fingerprints.
 *
 * NOTHING IS WEAKENED. A re-measured proof goes through the normal prepare → run →
 * finish path: it is only `settled` if the test actually passes against the moved
 * code, and a clause whose MEANING moved (spec-stale) is never re-measured here —
 * that is a new contract, not drift.
 */
export const remeasureTestEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  specIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
}).strict();
type Remeasure = z.infer<typeof remeasureTestEvidenceSchema>;
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

/** Stale reasons a fresh run of the SAME recipe can cure. Anything else needs a human. */
const REMEASURABLE_STALE_REASONS = new Set(['source-stale', 'test-stale', 'testRun-stale']);
/** One evidence request is capped at 20 bindings by `testEvidenceSchema`. */
const MAX_REMEASURE_BINDINGS = 20;

export type RemeasureSkip = { specId: string; testPath: string; bindingId: number;
  reason: 'current' | 'clause-moved' | 'run-in-flight' | 'unmeasurable' | 'not-remeasurable' | 'cap'
    /** A test proof bound by hand (plans:bind-spec-evidence): no stored recipe to re-run. */
    | 'no-recipe'
    /** A mutation proof: curing it means re-running the mutation probe, not a test file. */
    | 'probe-required';
  detail?: string };
export type RemeasureSelection = { specId: string; testPath: string; bindingId: number;
  staleReasons: string[]; movedPaths?: unknown; binding: Request['bindings'][number];
  /** The latest pending attempt was checked and has no live run or scoped file ledger row. */
  abandonedPending?: true;
  /** Every live row of this recipe at this revision — withdrawn only once a fresh run PASSES. */
  supersedes: number[];
  /** Reviewer judgment those rows carried (WI-10004452): the fresh run will not reproduce it. */
  judgment?: { fields: string[]; bindingIds: number[] };
  /** Those rows whose ledger run was a CLEAN tree (worktree_dirty=false, e.g. a lint:as-committed
   * clone). Only a fresh run that is itself known-clean may retire them (WI-10005451). */
  cleanBindingIds?: number[] };

/** Evidence kinds a re-measure must ACCOUNT for, even when it cannot re-run them itself. */
export const REMEASURE_EVIDENCE_KINDS = ['test', 'mutation'] as const;

/**
 * WI-10004452 — binder-attested reviewer JUDGMENT that a fresh run cannot re-derive. The
 * adequacy evaluator reads these (correct-layer, oracle-independence, falsifiability, …),
 * but a re-measure reproduces only outcome/collected/executed/testLayer, and it deliberately
 * does not replay them: re-running a stale proof re-verifies its OUTCOME, not a reviewer's
 * judgment about it. So retiring a predecessor that carried them silently moves those
 * criteria from pass to unknown. The retirement must name what it dropped.
 */
const REVIEWER_JUDGMENT_ADEQUACY_KEYS = [
  'falsifiable', 'fixtureCalibrated', 'pathReachable', 'oracleIndependent', 'targeted', 'coverageRungs', 'disclosedGap',
] as const;
const REVIEWER_JUDGMENT_DETAIL_KEYS = ['pathReachability', 'observations'] as const;

/** The reviewer-judgment fields one binding's details carry, as `adequacy.<key>` / `<key>` paths. */
export function reviewerJudgmentFields(details: unknown): string[] {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return [];
  const record = details as Record<string, unknown>;
  const fields: string[] = [];
  const adequacy = record.adequacy;
  if (adequacy !== null && typeof adequacy === 'object' && !Array.isArray(adequacy)) {
    for (const key of REVIEWER_JUDGMENT_ADEQUACY_KEYS) {
      if ((adequacy as Record<string, unknown>)[key] !== undefined) fields.push(`adequacy.${key}`);
    }
  }
  for (const key of REVIEWER_JUDGMENT_DETAIL_KEYS) if (record[key] !== undefined) fields.push(key);
  return fields;
}

/**
 * One line for the top of a re-measure report when any retirement dropped reviewer judgment,
 * so a caller who reads only the summary does not take "re-measured, passed" as "BAR intact".
 */
export function remeasureJudgmentLossWarning(outcomes: readonly unknown[]): string | null {
  const lost = outcomes.flatMap((outcome) => {
    const entry = outcome as { specId?: string; judgmentNotCarried?: { fields: string[]; fromBindingIds: number[] } };
    return entry.judgmentNotCarried ? [`${entry.specId} (${entry.judgmentNotCarried.fields.join(', ')} from binding ${entry.judgmentNotCarried.fromBindingIds.join('/')})`] : [];
  });
  if (lost.length === 0) return null;
  return `Reviewer judgment NOT carried to the re-measured proof for ${lost.join('; ')}. The adequacy criteria that read it ` +
    `(correct-layer, oracle-independence, falsifiability) now read unknown for those clauses: re-verify it against the current ` +
    `test source and re-bind by hand with plans:bind-spec-evidence (see retired[].judgmentNotCarried).`;
}

/**
 * A legacy hand-bound test can be re-run only when its immutable row still gives one exact
 * test file, its source set, and the recorded test layer. Do not infer a recipe from a title,
 * a test-run id, or free-form attestation text; and do not carry stale adequacy assertions into
 * the new run. Mutation rows deliberately never enter this path.
 */
function handBoundTestBinding(
  row: EvidenceRow,
  measurement: z.infer<typeof repoFilesEvidenceMeasurementSchema>,
): Request['bindings'][number] | null {
  const testPaths = measurement.testPaths ?? [];
  if (testPaths.length !== 1) return null;
  const testPath = testPaths[0]!;
  if (row.evidenceRef !== testPath) return null;

  const adequacy = row.details?.adequacy;
  if (adequacy === null || typeof adequacy !== 'object' || Array.isArray(adequacy)) return null;
  const values = adequacy as Record<string, unknown>;
  const scenarioIds = values.scenarioIds;
  if (scenarioIds !== undefined && (!Array.isArray(scenarioIds) || !scenarioIds.every((id) => typeof id === 'string'))) return null;
  const causalPairIds = values.causalPairIds;
  if (
    causalPairIds !== undefined &&
    (!Array.isArray(causalPairIds) || causalPairIds.length > 1 || !causalPairIds.every((id) => typeof id === 'string'))
  ) return null;

  const parsed = bindingSchema.safeParse({
    specId: row.specId,
    specRevision: row.specRevision,
    testPath,
    sourcePaths: measurement.sourcePaths,
    testLayer: values.testLayer,
    ...(scenarioIds && scenarioIds.length > 0 ? { scenarioIds } : {}),
    ...(causalPairIds && causalPairIds.length === 1 ? { causalPairId: causalPairIds[0] } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Pure selection over one work-item's evidence rows: the latest binding per (clause, kind,
 * test file). A stale test proof may be re-run from a stored binding or from an exact,
 * unambiguous repo-files measurement plus its recorded test layer. Other stale proofs are
 * still REPORTED (`no-recipe` / `probe-required`), never silently dropped — a silent drop
 * let the completion gate fail freshness on bindings this pass said nothing about.
 */
export function planTestEvidenceRemeasure(rows: readonly EvidenceRow[],
  abandonedPendingBindingIds: ReadonlySet<number> = new Set()): { selected: RemeasureSelection[]; skipped: RemeasureSkip[] } {
  const latest = new Map<string, { row: EvidenceRow; binding: Request['bindings'][number] | null; testPath: string; phase?: string }>();
  const members = new Map<string, number[]>();
  const judgments = new Map<string, { fields: Set<string>; bindingIds: number[] }>();
  const clean = new Map<string, number[]>();
  for (const row of [...rows].sort((a, b) => b.id - a.id)) {
    // Counterexample proofs assert a SPECIFIC failure against a deliberately broken
    // subject; re-running them against moved code is not the same claim.
    if (!(REMEASURE_EVIDENCE_KINDS as readonly string[]).includes(row.evidenceKind)) continue;
    const execution = row.details?.testExecution as { phase?: string; binding?: unknown } | undefined;
    const parsed = row.evidenceKind === 'test' ? bindingSchema.safeParse(execution?.binding) : null;
    const structuredBinding = parsed?.success ? parsed.data : null;
    const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details?.currentMeasurement);
    const recordedPaths = measurement.success ? measurement.data.testPaths ?? [] : [];
    const handBoundBinding =
      row.evidenceKind === 'test' && execution?.binding === undefined && measurement.success
        ? handBoundTestBinding(row, measurement.data)
        : null;
    const binding = structuredBinding ?? handBoundBinding;
    const testPath = binding?.testPath ?? recordedPaths[0] ?? '(unrecorded)';
    const identityPaths = binding ? [binding.testPath] : recordedPaths;
    const pathIdentity = identityPaths.length > 0
      ? JSON.stringify([...new Set(identityPaths)].sort())
      : `unrecorded:${row.evidenceRef}`;
    const key = `${row.specId}\0${row.evidenceKind}\0${pathIdentity}`;
    const phase = abandonedPendingBindingIds.has(row.id) ? 'abandoned' : execution?.phase;
    if (!latest.has(key)) latest.set(key, { row, binding, testPath, phase });
    if (row.specRevision === latest.get(key)!.row.specRevision) {
      members.set(key, [...(members.get(key) ?? []), row.id]);
      if (row.testRunProvenance?.worktreeDirty === false) clean.set(key, [...(clean.get(key) ?? []), row.id]);
      const fields = reviewerJudgmentFields(row.details);
      if (fields.length > 0) {
        const judgment = judgments.get(key) ?? { fields: new Set<string>(), bindingIds: [] };
        fields.forEach((field) => judgment.fields.add(field));
        judgment.bindingIds.push(row.id);
        judgments.set(key, judgment);
      }
    }
  }
  const selected: RemeasureSelection[] = [];
  const skipped: RemeasureSkip[] = [];
  for (const [key, { row, binding, testPath, phase }] of latest) {
    const base = { specId: row.specId, testPath, bindingId: row.id };
    const { overall, dimensions, staleReasons } = row.currentness;
    const outcome = (row.details?.adequacy as { outcome?: string } | undefined)?.outcome;
    const abandonedPending = phase === 'abandoned';
    // Freshness alone does not make a failed measurement a reusable proof (WI-10004097).
    const settledFailure = phase === 'settled' && (outcome === 'error' || outcome === 'fail');
    const moved = (row as { serverMeasurement?: { movedPaths?: unknown } }).serverMeasurement?.movedPaths;
    const hasNoStoredTestBinding =
      row.evidenceKind === 'test' &&
      (row.details?.testExecution as { binding?: unknown } | undefined)?.binding === undefined;
    if (dimensions.spec === 'stale') skipped.push({ ...base, reason: 'clause-moved' });
    else if (phase === 'pending') skipped.push({ ...base, reason: 'run-in-flight' });
    else if (overall === 'current' && !settledFailure && !abandonedPending
      && (phase === 'settled' || !binding || hasNoStoredTestBinding))
      skipped.push({ ...base, reason: 'current' });
    else if (!binding) {
      const why = (overall === 'unknown' ? row.currentness.unknownReasons : staleReasons).join(',') || overall;
      skipped.push(row.evidenceKind === 'mutation'
        ? {
            ...base,
            reason: 'probe-required',
            detail:
              `${why}: re-run the same copy-out/historical scripts/mutation-probe.sh recipe, then re-bind its source='mutation-probe' ledger result; this test-only route cannot reproduce a mutant.`
                .slice(0, 240),
          }
        : { ...base, reason: 'no-recipe', detail: `${why}: bound by hand, so re-prove via testing:run { evidence } (which stores the recipe)`.slice(0, 240) });
    } else if (
      (abandonedPending && overall === 'current') ||
      (overall === 'current' && settledFailure) ||
      (overall === 'stale' && staleReasons.every((reason) => REMEASURABLE_STALE_REASONS.has(reason))) ||
      // A completed run whose sources moved WHILE it ran is the same drift, observed early.
      (overall !== 'unknown' && phase === 'source-changed' && staleReasons.every((reason) => REMEASURABLE_STALE_REASONS.has(reason)))
    ) {
      const judgment = judgments.get(key);
      const cleanIds = clean.get(key);
      selected.push({ ...base, staleReasons, ...(moved !== undefined ? { movedPaths: moved } : {}),
        binding: { ...binding, specRevision: row.specRevision }, supersedes: (members.get(key) ?? []).sort((a, b) => a - b),
        ...(abandonedPending ? { abandonedPending: true as const } : {}),
        ...(judgment ? { judgment: { fields: [...judgment.fields].sort(), bindingIds: [...judgment.bindingIds].sort((a, b) => a - b) } } : {}),
        ...(cleanIds ? { cleanBindingIds: [...cleanIds].sort((a, b) => a - b) } : {}) });
    } else if (overall === 'unknown') skipped.push({ ...base, reason: 'unmeasurable', detail: row.currentness.unknownReasons.join(',').slice(0, 240) });
    else skipped.push({ ...base, reason: 'not-remeasurable', detail: [...staleReasons, phase ?? 'no-phase'].join(',') });
  }
  const bySpec = (a: { specId: string; testPath: string }, b: { specId: string; testPath: string }) =>
    a.specId.localeCompare(b.specId) || a.testPath.localeCompare(b.testPath);
  selected.sort(bySpec);
  for (const over of selected.splice(MAX_REMEASURE_BINDINGS)) skipped.push({ specId: over.specId, testPath: over.testPath, bindingId: over.bindingId, reason: 'cap' });
  return { selected, skipped: skipped.sort(bySpec) };
}

/**
 * Read one work-item's live test evidence and turn the stale-but-curable proofs into an
 * ordinary `evidence` request plus the exact test files to run. `request` is null when
 * nothing needs re-measuring, and the caller then starts no process at all.
 */
async function abandonedPendingBindingIds(rows: readonly EvidenceRow[],
  scope: Pick<Scope, 'harnessSlug'> & Partial<Pick<Scope, 'workspaceId' | 'root'>>,
  deps: Pick<Deps, 'list'> & Partial<Pick<Deps, 'ledger' | 'runStatus' | 'now'>>): Promise<Set<number>> {
  if (!scope.workspaceId || !scope.root || !deps.ledger || !deps.runStatus) return new Set();
  const now = deps.now?.() ?? Date.now();
  const candidates = rows.flatMap((row) => {
    const execution = row.details?.testExecution as { phase?: string; runId?: string; originRunId?: string; binding?: unknown } | undefined;
    const parsed = row.evidenceKind === 'test' ? bindingSchema.safeParse(execution?.binding) : null;
    const ageMs = pendingEvidenceAgeMs(row.observedAt, now);
    if (execution?.phase !== 'pending' || row.testRunId != null || !parsed?.success
      || typeof execution.runId !== 'string' || ageMs === null
      || ageMs < PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS) return [];
    return [{ row, runId: execution.runId,
      originRunId: typeof execution.originRunId === 'string' ? execution.originRunId : execution.runId,
      binding: parsed.data }];
  });
  const checks = new Map<string, Promise<boolean>>();
  const abandoned = new Set<number>();
  await Promise.all(candidates.map(async ({ row, runId, originRunId, binding }) => {
    const key = JSON.stringify([runId, originRunId, binding.testPath]);
    let check = checks.get(key);
    if (!check) {
      check = (async () => {
        let snapshot: RunSnapshot | null;
        try {
          snapshot = await deps.runStatus!(runId, undefined, {
            workspaceId: scope.workspaceId!, harnessSlug: scope.harnessSlug, root: scope.root!,
          });
        } catch {
          return false;
        }
        // Missing and terminal snapshots mean no live process. An unreadable or malformed
        // snapshot must fail closed; it is not evidence that the process stopped.
        if (snapshot !== null && !isTerminalRunSnapshot(snapshot)) return false;
        const runGroups = [...new Set([runId, originRunId])];
        for (const runGroupId of runGroups) {
          let ledgerRows: HarnessTestRunEvidence[] | null;
          try {
            ledgerRows = await deps.ledger!({ workspaceId: scope.workspaceId!, harnessSlug: scope.harnessSlug,
              runGroupId, filePaths: [binding.testPath] });
          } catch {
            return false;
          }
          if (ledgerRows === null || ledgerRows.length > 0) return false;
        }
        return true;
      })();
      checks.set(key, check);
    }
    if (await check) abandoned.add(row.id);
  }));
  return abandoned;
}

export async function buildTestEvidenceRemeasure(remeasure: Remeasure,
  scope: Pick<Scope, 'harnessSlug'> & Partial<Pick<Scope, 'workspaceId' | 'root'>>,
  deps: Pick<Deps, 'list'> & Partial<Pick<Deps, 'ledger' | 'runStatus' | 'now'>> = defaults) {
  const rows = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [remeasure.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [remeasure.workItemId],
    ...(remeasure.specIds ? { specIds: remeasure.specIds } : {}), evidenceKinds: [...REMEASURE_EVIDENCE_KINDS], limit: 500 });
  const abandoned = await abandonedPendingBindingIds(rows, scope, deps);
  const plan = planTestEvidenceRemeasure(rows, abandoned);
  const request = plan.selected.length === 0 ? null : testEvidenceSchema.parse({
    workItemId: remeasure.workItemId, ...(remeasure.planSlug ? { planSlug: remeasure.planSlug } : {}),
    bindings: plan.selected.map((entry) => entry.binding) });
  // The checkout each selected proof was measured in: `null` = the session harness root.
  // The caller must re-run in THAT checkout; more than one distinct value cannot share a
  // run (EI-25203154942838341).
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const rootHarnessSlugs = [...new Set(plan.selected.map((entry) => {
    const measured = repoFilesEvidenceMeasurementSchema.safeParse(rowById.get(entry.bindingId)?.details?.currentMeasurement);
    return measured.success ? measured.data.rootHarnessSlug ?? null : null;
  }))];
  return { request, files: [...new Set(plan.selected.map((entry) => entry.testPath))], plan, rootHarnessSlugs,
    abandonedPendingBindingIds: [...abandoned].sort((a, b) => a - b),
    summary: { examined: rows.length, selected: plan.selected.length, skipped: plan.skipped.length,
      abandonedPending: abandoned.size } };
}

/**
 * After a re-measure run, withdraw the stale predecessors of each recipe whose FRESH
 * proof settled as a current pass — and nothing else. The evaluator grades every live
 * row at a revision, so a replaced stale row left live would keep failing freshness
 * beside the new passing one. A recipe whose fresh run failed, errored or is still
 * pending keeps its predecessors: the clause is then honestly red for a reason the
 * caller can read, not quietly emptied. Retraction is D-011's stamp (never a delete),
 * with a reason naming the replacement.
 */
export async function retireRemeasuredPredecessors(selected: readonly RemeasureSelection[], prepared: readonly Prepared[],
  runId: string, scope: Scope, deps: Pick<Deps, 'list'> & { retract?: typeof retractSpecEvidence } = defaults) {
  if (!deps.retract || prepared.length === 0) return [];
  const fresh = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [prepared[0]!.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [prepared[0]!.input.workItemId],
    evidenceRefs: prepared.map((row) => row.input.evidenceRef), limit: 200 });
  const outcomes = [];
  for (const [index, entry] of selected.entries()) {
    const ref = prepared[index]?.input.evidenceRef;
    const replacement = fresh.filter((row) => row.evidenceRef === ref).sort((a, b) => b.id - a.id)[0];
    const execution = replacement?.details?.testExecution as { phase?: string } | undefined;
    const outcome = (replacement?.details?.adequacy as { outcome?: string } | undefined)?.outcome;
    const passed = replacement !== undefined && execution?.phase === 'settled' && outcome === 'pass'
      && replacement.currentness.overall === 'current';
    if (!passed) {
      outcomes.push({ specId: entry.specId, testPath: entry.testPath, retired: [], kept: entry.supersedes,
        reason: `fresh run not a current pass (${execution?.phase ?? 'absent'}/${outcome ?? 'unknown'})` });
      continue;
    }
    // WI-10005451: a remeasure runs in the SHARED tree, so its run is usually dirty. Retiring a
    // clean (as-committed) proof for it downgrades the proof the acceptance BAR accepts into one
    // it rejects. Only a fresh run that is itself known-clean may retire a clean predecessor.
    const replacementClean = replacement.testRunProvenance?.worktreeDirty === false;
    const cleanKept = replacementClean ? [] : (entry.cleanBindingIds ?? []).filter((id) => entry.supersedes.includes(id));
    const retired: number[] = [];
    for (const bindingId of entry.supersedes) {
      if (cleanKept.includes(bindingId)) continue;
      const result = await deps.retract({ harnessSlug: scope.harnessSlug, bindingId, actorId: scope.actorId,
        reason: `superseded by re-measured binding ${replacement.id} (testing:run remeasureEvidence run ${runId}): measured paths moved since this proof` })
        .catch(() => null);
      if (result && result.status !== 'not_found') retired.push(bindingId);
    }
    // WI-10004452: name any reviewer judgment a retired predecessor carried that the fresh
    // proof does not, instead of letting a passing criterion quietly turn unknown.
    const carried = new Set(reviewerJudgmentFields(replacement.details));
    const notCarried = (entry.judgment?.fields ?? []).filter((field) => !carried.has(field));
    const lostFrom = (entry.judgment?.bindingIds ?? []).filter((id) => retired.includes(id));
    outcomes.push({ specId: entry.specId, testPath: entry.testPath, replacementId: replacement.id, retired,
      ...(cleanKept.length > 0
        ? { cleanProofKept: { bindingIds: cleanKept,
            reason: `fresh run ${replacement.testRunProvenance?.worktreeDirty === true ? 'ran on a dirty worktree' : 'has unknown worktree cleanliness'}; it may not retire a clean-tree proof`,
            repair: `re-prove from a clean tree (npm run lint:as-committed -- <script> --keep, then testing:run the clone's test path), bind it, then retract ${cleanKept.join(', ')}` } }
        : {}),
      ...(notCarried.length > 0 && lostFrom.length > 0
        ? { judgmentNotCarried: { fields: notCarried, fromBindingIds: lostFrom,
            repair: `re-verify against the current test source, then plans:bind-spec-evidence the run behind binding ${replacement.id} with this judgment` } }
        : {}) });
  }
  return outcomes;
}

/**
 * EI-24207525450988644 — poll the detached run's snapshot until it is terminal or the
 * bounded wait expires, so one recovery call replaces the caller's run-status loop. A
 * missing snapshot or a failed read stops at once: waiting cannot make an unknown or
 * evicted run appear, and a read error is reported in-band rather than retried blind.
 */
async function awaitTerminalRunSnapshot(runId: string, limitMs: number, deps: Deps, scope: Scope): Promise<{
  snapshot: RunSnapshot | null; error?: string; waitedMs: number;
}> {
  const sleep = deps.sleep ?? defaults.sleep!;
  const now = deps.now ?? defaults.now!;
  const started = now();
  for (;;) {
    let snapshot: RunSnapshot | null;
    try {
      snapshot = await deps.runStatus?.(runId, undefined, scope) ?? null;
    } catch (error) {
      return { snapshot: null, error: String(error).slice(0, 300), waitedMs: now() - started };
    }
    const waitedMs = now() - started;
    const remainingMs = limitMs - waitedMs;
    if (snapshot === null || isTerminalRunSnapshot(snapshot) || remainingMs <= 0) return { snapshot, waitedMs };
    await sleep(Math.min(RECOVERY_WAIT_POLL_MS, remainingMs));
  }
}

/** A passing run can become terminal before its reporter's file-level ledger row is visible.
 * Spend only the recovery budget left after the terminal snapshot before treating that row as absent. */
async function awaitRecoveryLedgerRows(prepared: Prepared[], originRunId: string, runId: string,
  scope: Scope, limitMs: number, deps: Deps): Promise<number> {
  if (limitMs <= 0 || prepared.length === 0) return 0;
  const sleep = deps.sleep ?? defaults.sleep!;
  const now = deps.now ?? defaults.now!;
  const started = now();
  for (;;) {
    const primary = await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: runId });
    const origin = originRunId !== runId && (primary?.length ?? 0) === 0
      ? await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: originRunId })
      : null;
    const ledger = (primary?.length ?? 0) > 0 ? primary : origin ?? primary;
    const allRowsVisible = prepared.every(row => ledger?.some(entry =>
      entry.file_path === row.binding.testPath && entry.finished_at !== null));
    const waitedMs = now() - started;
    const remainingMs = limitMs - waitedMs;
    if (allRowsVisible || remainingMs <= 0) return waitedMs;
    await sleep(Math.min(RECOVERY_WAIT_POLL_MS, remainingMs));
  }
}

/** `null` means at least one exact scoped read was unavailable; unreadable is not empty. */
async function recoveryLedgerPresence(prepared: readonly Prepared[], originRunId: string, runId: string,
  scope: Scope, deps: Deps): Promise<boolean | null> {
  const runGroups = [...new Set([runId, originRunId])];
  let unavailable = false;
  for (const row of prepared) {
    for (const runGroupId of runGroups) {
      let ledger: HarnessTestRunEvidence[] | null;
      try {
        ledger = await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
          runGroupId, filePaths: [row.binding.testPath] });
      } catch {
        unavailable = true;
        continue;
      }
      if (ledger === null) unavailable = true;
      else if (ledger.length > 0) return true;
    }
  }
  return unavailable ? null : false;
}

/** Rehydrate exact persisted mappings; no transcript or user-retyped fingerprints. */
export async function recoverTestEvidence(recovery: Recovery, scope: Scope, deps: Deps = defaults) {
  // Audit withdrawn mappings to recover a reporter result that arrived after a
  // terminal-no-result retirement. They supply the immutable recipe only: the
  // exact scoped ledger and source checks below still decide whether it is proof.
  const evidence = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [recovery.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [recovery.workItemId],
    evidenceRefs: Array.from({ length: 20 }, (_, index) => refFor(recovery.originRunId, index)),
    includeRetracted: true, limit: 200 });
  const latest = new Map<string, (typeof evidence)[number]>();
  for (const row of [...evidence].sort((a, b) => b.id - a.id)) if (!latest.has(row.evidenceRef)) latest.set(row.evidenceRef, row);
  const prepared: Prepared[] = [];
  const recoveredRunIds = new Set<string>();
  // When the outer MCP request itself expires, its response may hide the
  // detachedRunId. In that case the caller only has the origin run-group id;
  // use the persisted, origin-matched execution record to recover the detached
  // handle rather than requiring the caller to reconstruct it from memory.
  const originOnlyRecovery = recovery.runId === recovery.originRunId;
  for (const row of latest.values()) {
    const execution = row.details.testExecution as { schemaVersion?: number; phase?: string; runId?: string; originRunId?: string; binding?: unknown } | undefined;
    if (execution?.schemaVersion !== 1 || execution.originRunId !== recovery.originRunId
      || typeof execution.runId !== 'string'
      || (!originOnlyRecovery && execution.runId !== recovery.runId && execution.runId !== recovery.originRunId)) continue;
    // An origin-only retry can discover a prior detached handle in the row. If
    // the caller already has that detached handle but the row still contains
    // its pre-timeout origin id, trust the caller's handle and let exact ledger
    // scope/file/run checks decide whether it has a measured result.
    let recoveredRunId = originOnlyRecovery || execution.runId === recovery.runId
      ? execution.runId
      : recovery.runId;
    const binding = bindingSchema.parse(execution.binding);
    if (row.withdrawal) {
      // Never revive deliberate withdrawals, settled proof, pre-launch refusals,
      // or an older mapping hidden by a later withdrawal for the same reference.
      const retired = row.withdrawal.reason?.match(/^Detached test run ([0-9a-f-]+) terminated \((?:pass|fail|error|cancelled), exit (?:-?\d+|unknown)\) without an attributed result for (.+); this attempt cannot settle and must be rerun\.$/);
      if (execution.phase !== 'pending' || row.testRunId != null || !retired
        || retired[2] !== binding.testPath
        || (execution.runId !== recovery.originRunId && execution.runId !== retired[1])
        || (!originOnlyRecovery && retired[1] !== recovery.runId)) continue;
      recoveredRunId = retired[1]!;
    }
    recoveredRunIds.add(recoveredRunId);
    const measurement = repoFilesEvidenceMeasurementSchema.parse(row.details.currentMeasurement);
    prepared.push({ binding, measurement, input: {
      harnessSlug: scope.harnessSlug, actorId: scope.actorId,
      planSlug: recovery.planSlug, workItemId: recovery.workItemId,
      specId: row.specId, specRevision: row.specRevision,
      evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
      testRunId: row.testRunId, coverageEvidenceRef: row.coverageEvidenceRef, details: row.details,
      sourceFingerprint: row.fingerprints.sourceFingerprint, testFingerprint: row.fingerprints.testFingerprint,
    }, observedAt: row.observedAt });
  }
  if (prepared.length === 0) throw new Error('evidence_recovery_not_found');
  if (recoveredRunIds.size !== 1) throw new Error('evidence_recovery_ambiguous_run_id');
  const recoveredRunId = [...recoveredRunIds][0]!;
  const waitLimitMs = Math.min(recovery.waitMs ?? RECOVERY_WAIT_DEFAULT_MS, RECOVERY_WAIT_CEILING_MS);
  const { snapshot: runSnapshot, error: runStatusError, waitedMs } =
    await awaitTerminalRunSnapshot(recoveredRunId, waitLimitMs, deps, scope);
  const terminalRun = isTerminalRunSnapshot(runSnapshot) ? runSnapshot : undefined;
  // A successful detached process may publish its per-file reporter rows just after the
  // terminal snapshot. Use only the portion of waitMs the process wait did not consume;
  // otherwise an early empty ledger read can retire a result that is about to be visible.
  const ledgerWaitedMs = terminalRun?.status === 'pass' && terminalRun.exitCode === 0
    ? await awaitRecoveryLedgerRows(prepared, recovery.originRunId, recoveredRunId, scope,
      Math.max(0, waitLimitMs - waitedMs), deps)
    : 0;
  const totalWaitedMs = waitedMs + ledgerWaitedMs;
  const now = deps.now ?? defaults.now!;
  const allPastAbandonmentGrace = prepared.every(row => {
    const ageMs = pendingEvidenceAgeMs(row.observedAt, now());
    return ageMs !== null && ageMs >= PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS;
  });
  const allPreparedAttemptsPending = prepared.every(row => {
    const execution = row.input.details?.testExecution as { phase?: string } | undefined;
    return execution?.phase === 'pending' && row.input.testRunId == null;
  });
  if (runSnapshot === null && !runStatusError && allPreparedAttemptsPending && allPastAbandonmentGrace
    && await recoveryLedgerPresence(prepared, recovery.originRunId, recoveredRunId, scope, deps) === false) {
    const retirements = await Promise.all(prepared.map(row => retirePendingAttemptBindings(row,
      recovery.originRunId, recoveredRunId, scope,
      `Detached test run ${recoveredRunId} has no live snapshot or scoped file ledger after the ` +
        `${Math.round(PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS / 1000)}s pending grace; this attempt is abandoned and must be rerun.`, deps)));
    const retiredIds = [...new Set(retirements.flatMap(retirement => retirement.bindingIds))].sort((a, b) => a - b);
    const failures = retirements.flatMap(retirement => retirement.failures);
    return {
      status: failures.length === 0 ? 'abandoned' as const : 'incomplete' as const,
      acceptance: 'requires-review' as const,
      rows: prepared.slice(0, 6).map(row => ({ specId: row.input.specId,
        specRevision: row.input.specRevision, evidenceRef: row.input.evidenceRef,
        testRunId: null, ledgerRunGroupId: null, phase: 'abandoned' as const, outcome: 'unknown' as const,
        bindingStatus: failures.length === 0 ? 'abandoned' as const : 'retirement-incomplete' as const })),
      total: prepared.length, omitted: Math.max(0, prepared.length - 6),
      readRef: { tool: 'plans:get-spec-evidence', args: { harness: scope.harnessSlug,
        slug: recovery.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE, workItemIds: [recovery.workItemId],
        evidenceRefs: prepared.map(row => row.input.evidenceRef) } },
      pendingRetirement: { status: failures.length === 0 ? 'complete' as const : 'partial' as const,
        retiredCount: retiredIds.length, bindingIds: retiredIds.slice(0, 20),
        omitted: Math.max(0, retiredIds.length - 20), failures: failures.slice(0, 20),
        failuresOmitted: Math.max(0, failures.length - 20) },
      recovery: { tool: 'testing:run', args: { harness: scope.harnessSlug, recoverEvidence: {
        workItemId: recovery.workItemId, planSlug: recovery.planSlug,
        originRunId: recovery.originRunId, runId: recovery.runId,
      } } },
      recoveryWait: { limitMs: waitLimitMs, waitedMs: totalWaitedMs, ledgerWaitedMs: 0,
        outcome: 'abandoned' as const,
        nextStep: 'The pending attempt was retired. Re-run testing:run { remeasureEvidence } to create fresh evidence.' },
      detachedRunStatus: { status: 'not-found' as const },
    };
  }
  const bundle = await finishTestEvidence(prepared, recovery.originRunId, recoveredRunId, scope, undefined, deps, terminalRun);
  const stillRunning = runSnapshot !== null && !terminalRun;
  return { ...bundle,
    recoveryWait: { limitMs: waitLimitMs, waitedMs: totalWaitedMs, ledgerWaitedMs,
      outcome: terminalRun ? 'terminal' as const : stillRunning ? 'still-running' as const
        : runStatusError ? 'unavailable' as const : 'not-found' as const,
      ...(stillRunning ? { nextStep: `The detached run was still in flight after waiting ${Math.round(waitedMs / 1000)}s. `
        + 'Call this same testing:run { recoverEvidence } again (it waits again); do not poll testing:run-status first.' } : {}) },
    detachedRunStatus: runSnapshot
    ? { runId: runSnapshot.runId, status: runSnapshot.status, exitCode: runSnapshot.exitCode,
        finishedAt: runSnapshot.finishedAt }
    : { status: runStatusError ? 'unavailable' : 'not-found', ...(runStatusError ? { message: runStatusError } : {}) } };
}
