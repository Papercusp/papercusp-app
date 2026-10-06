/** Per-clause spec-test-adequacy evaluator (P-006 / D-004..D-006, D-009). */
import { getBuildInfo } from '../../build-info';
import { repoFilesEvidenceMeasurementSchema } from './spec-evidence-store';
import { SPEC_PROOF_OBLIGATION_ID_RE, type SpecBehaviorClass, type SpecClauseRevision } from './spec-clauses-store';
import type {
  EvidenceCurrentInput,
  EvidenceCurrentness,
  ProvisionalScorecardProof,
  SpecEvidenceKind,
} from './spec-evidence-store';
import { evidenceCurrentInputKey } from './spec-evidence-store';
import type {
  SpecTestAdequacyCurrentFingerprint,
  SpecTestAdequacyRerunRecipe,
} from '../../harness/improvements/observation-types';
import { isRecordedTestLayer } from '@papercusp/test-config/execution-details';

export const SPEC_TEST_ADEQUACY_RUBRIC_REF = 'spec-test-adequacy';

/**
 * Keep persisted judge replays within the critical-pressure admission budget.
 * The evaluator's general default is intentionally larger, but generated
 * scorecard recipes must carry an explicit bounded page so the exact replay can
 * pass the MCP recovery allowlist when the operator is saturated.
 */
export const SPEC_TEST_ADEQUACY_REPLAY_LIMIT = 25;

export const PLAN_CLASS_RUBRIC_REFS = [
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
] as const;
export type PlanClassRubricRef = (typeof PLAN_CLASS_RUBRIC_REFS)[number];

export const ADEQUACY_CRITERIA = [
  'traceability',
  'fixture-calibration',
  'falsifiability',
  'correct-layer',
  'oracle-independence',
  'execution-integrity',
  'freshness',
  'plan-class-risk-floor',
  'disclosed-gap',
] as const;
export type AdequacyCriterion = (typeof ADEQUACY_CRITERIA)[number];
export type AdequacyRating = 'pass' | 'fail' | 'unknown' | 'waived' | 'not-applicable';

/**
 * The adequacy criteria that can only ever be satisfied by EXECUTABLE proof: a
 * ledger-backed test run, a mutation/counterexample row, or a repo-files
 * measurement. When `requiredProofFloor` exempts a clause (returns 'none'),
 * these are the criteria that exemption must ALSO reach — grading non-code work
 * against them demands an artifact that cannot exist for it, at any effort.
 *
 * Kept immediately beside ADEQUACY_CRITERIA so the two lists are read and
 * edited together: a new criterion that needs a ledger row or a repo file
 * belongs in both, and one that can be satisfied by an honest attestation
 * belongs only in the first.
 */
export const EXECUTABLE_PROOF_CRITERIA = [
  'falsifiability',
  'execution-integrity',
  'freshness',
] as const satisfies readonly AdequacyCriterion[];

export interface AdequacyRatingEntry {
  rating: AdequacyRating;
  evidence: string;
  suggestion?: string;
  /**
   * EI-23958122348412546: this verdict is a 'fail' that means ABSENCE of executable
   * proof, not evidence that positively reports something bad. The two are otherwise
   * indistinguishable once a branch has collapsed to the bare string 'fail', which is
   * what made the requiredProofFloor='none' exemption below unreachable for exactly
   * the non-code work it was written for: honest `manual` evidence produced zero
   * executable rows, rated 'fail', and was skipped by an exemption that only ever
   * downgraded 'unknown' — while a WEAKER binding (one executable-kind row with
   * author-attested booleans and no ledger anchor) rated 'unknown' and WAS exempted.
   *
   * Only absence-shaped verdicts carry this. A 'fail' from falsifiable=false, a
   * failed/skipped/unexecuted outcome, or a stale binding must never set it: that
   * fail is real information about real evidence and keeps blocking, exemption or not.
   */
  absenceOnly?: boolean;
}

export interface SpecEvidenceForAdequacy {
  id?: number;
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  fingerprints: {
    sourceFingerprint: string;
    testFingerprint: string | null;
    fixtureFingerprint: string | null;
    rubricFingerprint: string | null;
    environmentFingerprint: string | null;
  };
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  /** Canonical ledger attributes, independent of author-written evidenceRef prose. */
  testRunProvenance?: {
    filePath: string;
    commitSha: string | null;
    worktreeDirty: boolean | null;
  } | null;
  details: Record<string, unknown>;
  observedAt?: string;
  createdAt?: string;
  currentness: EvidenceCurrentness;
  /** True when evidenceRef resolves to a provisional scorecard working note. */
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
  /** Binding rows whose same-proof coverage metadata was preserved on this active row. */
  supportingBindingIds?: number[];
}

function logicalEvidenceReferenceKey(row: SpecEvidenceForAdequacy): string {
  return JSON.stringify([row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef]);
}

function proofIdentity(row: SpecEvidenceForAdequacy): string {
  return JSON.stringify([
    row.testRunId ?? null,
    row.coverageEvidenceRef ?? null,
    row.fingerprints.sourceFingerprint ?? null,
    row.fingerprints.testFingerprint ?? null,
    row.fingerprints.fixtureFingerprint ?? null,
    row.fingerprints.rubricFingerprint ?? null,
    row.fingerprints.environmentFingerprint ?? null,
  ]);
}

function hasTestAttemptReference(row: SpecEvidenceForAdequacy): boolean {
  const execution = row.details.testExecution as { schemaVersion?: unknown; originRunId?: unknown } | undefined;
  return (
    execution?.schemaVersion === 1 &&
    typeof execution.originRunId === 'string' &&
    row.evidenceRef.startsWith(`test-run-group:${execution.originRunId}:`)
  );
}

/**
 * Bindings are immutable history, but adequacy grades the active VERSION of a
 * logical evidence reference. A corrected re-bind must not remain poisoned by
 * an older incomplete row for the same plan/spec/revision/kind/ref.
 *
 * The binder is deliberately NOT part of that identity. `evidenceRef` names the
 * PROOF; `workItemId` names whoever happened to append the row. Keying on the
 * binder splits one logical reference into per-work-item lineages, so a later
 * ledger-backed re-bind filed under a different work item cannot supersede an
 * earlier incomplete row — it lands beside it, and the stale row keeps dragging
 * every criterion that reads it (execution-integrity to 'unknown' via the
 * any-drags rule, plus falsifiability/correct-layer/oracle-independence) with no
 * reachable repair, because the table is append-only by design. That is the exact
 * poisoning this function exists to prevent, so the binder must not key it.
 */
export function latestLogicalEvidence<T extends SpecEvidenceForAdequacy>(rows: readonly T[]): T[] {
  const selected = new Map<string, { row: T; index: number }>();
  // A logical correction is a newer APPEND, not a later claimed observation.
  // `observedAt` is caller-authored evidence metadata and may be skewed or even
  // future-dated; letting it order versions makes an old row permanently poison
  // every later correction. `createdAt` is server-authored, with the immutable DB
  // id and input order as deterministic fallbacks for legacy/test rows.
  const appendTimestamp = (row: SpecEvidenceForAdequacy): number => {
    const value = Date.parse(row.createdAt ?? '');
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  rows.forEach((row, index) => {
    const key = [row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef].join('\0');
    const prior = selected.get(key);
    if (!prior) {
      selected.set(key, { row, index });
      return;
    }
    const rowTs = appendTimestamp(row);
    const priorTs = appendTimestamp(prior.row);
    const rowId = row.id ?? Number.NEGATIVE_INFINITY;
    const priorId = prior.row.id ?? Number.NEGATIVE_INFINITY;
    if (rowTs > priorTs || (rowTs === priorTs && (rowId > priorId || (rowId === priorId && index > prior.index)))) {
      selected.set(key, { row, index });
    }
  });
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ row }) => row);
}

/**
 * Different run ids are attempts, not obligations that remain relied on forever.
 * Only the existing prepare/finish protocol can identify equivalent attempts:
 * require its original pending append, exact proof identity, and equal-or-wider
 * source scope. Order by that server-assigned registration id, NEVER outcome,
 * observedAt, ledger completion order, or a late adequacy annotation.
 *
 * This is a read projection: no historical binding is modified or deleted.
 * Legacy/unstructured proof and changed layer/scenario/causal/filter obligations
 * stay separate. A newer pending/unknown/failing attempt wins just like a pass.
 */
export function activeSpecEvidence<T extends SpecEvidenceForAdequacy>(rows: readonly T[]): T[] {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const identity = (row: T) => {
    const execution = object(row.details.testExecution);
    const binding = object(execution?.binding);
    const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
    if (
      !execution ||
      !hasTestAttemptReference(row) ||
      !binding ||
      !measurement.success ||
      binding.specId !== row.specId ||
      binding.specRevision !== row.specRevision ||
      measurement.data.testPaths?.length !== 1 ||
      binding.testPath !== measurement.data.testPaths[0] ||
      !isRecordedTestLayer(binding.testLayer)
    )
      return null;
    const strings = (value: unknown): string[] | null =>
      Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
        ? [...new Set(value as string[])].sort()
        : null;
    const sources = strings(binding.sourcePaths);
    if (!sources || JSON.stringify(sources) !== JSON.stringify([...new Set(measurement.data.sourcePaths)].sort()))
      return null;
    const details = detailsOf(row);
    if (details.contractMetadataIssues?.length || details.testLayer !== binding.testLayer) return null;
    const scenarios = binding.scenarioIds === undefined ? [] : strings(binding.scenarioIds);
    const pairs = binding.causalPairId === undefined ? [] : [binding.causalPairId];
    if (
      !scenarios ||
      JSON.stringify(scenarios) !== JSON.stringify(details.scenarioIds ?? []) ||
      JSON.stringify(pairs) !== JSON.stringify(details.causalPairIds ?? [])
    )
      return null;
    const counterexample = object(binding.counterexample);
    if (
      binding.counterexample !== undefined &&
      (!counterexample || typeof counterexample.test !== 'string' || typeof counterexample.messageIncludes !== 'string')
    )
      return null;
    const registrationKey = JSON.stringify([
      row.workItemId,
      row.planSlug,
      row.specId,
      row.specRevision,
      row.specFingerprint,
      row.evidenceKind,
      measurement.data.rootHarnessSlug ?? null,
      binding.testPath,
      binding.testLayer,
      scenarios,
      pairs,
      counterexample ? [counterexample.test, counterexample.messageIncludes] : null,
      row.fingerprints.fixtureFingerprint,
      row.fingerprints.rubricFingerprint,
      row.fingerprints.environmentFingerprint,
    ]);
    // Plane review and the executed filter are recorded at finish/review, not at
    // prepare. They distinguish attempts, but cannot change registration order.
    const plane = row.details.evidencePlane ?? row.details.evidence_plane ?? row.details.plane ?? null;
    const key = JSON.stringify([registrationKey, execution.testNamePattern ?? null]);
    return { key, registrationKey, plane, sources, execution };
  };
  const logicalKey = (row: T) =>
    JSON.stringify([row.workItemId, row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef]);
  const anchors = new Map<string, { id: number; scope: NonNullable<ReturnType<typeof identity>> }>();
  for (const row of rows) {
    const scope = identity(row);
    if (
      !scope ||
      scope.execution.phase !== 'pending' ||
      row.testRunId !== null ||
      !Number.isSafeInteger(row.id) ||
      row.id! <= 0
    )
      continue;
    const key = logicalKey(row);
    const previous = anchors.get(key);
    if (!previous || row.id! < previous.id) anchors.set(key, { id: row.id!, scope });
  }
  const latest = latestLogicalEvidence(rows);
  const byReference = new Map<string, T[]>();
  for (const row of rows) {
    const key = logicalEvidenceReferenceKey(row);
    const bucket = byReference.get(key) ?? [];
    bucket.push(row);
    byReference.set(key, bucket);
  }
  // Scenario and causal-pair ids are set-valued coverage metadata. When a re-bind
  // changes only that metadata, the newest immutable row must retain the union from
  // earlier rows for the same proof; otherwise latestLogicalEvidence silently hides
  // coverage the unchanged run already established. A new run or changed fingerprint
  // remains a new proof identity and starts a new metadata set.
  const reconciled = latest.map((row) => {
    const rawAdequacy = row.details.adequacy;
    if (
      rawAdequacy !== undefined &&
      (!rawAdequacy || typeof rawAdequacy !== 'object' || Array.isArray(rawAdequacy))
    ) return row;
    const adequacy = (rawAdequacy ?? {}) as Record<string, unknown>;
    const ownDetails = detailsOf(row);
    const sameProofRows = (byReference.get(logicalEvidenceReferenceKey(row)) ?? [row])
      .filter((candidate) => proofIdentity(candidate) === proofIdentity(row));
    const mergedAdequacy = { ...adequacy };
    let changed = false;
    for (const key of ['scenarioIds', 'causalPairIds'] as const) {
      if (ownDetails.contractMetadataIssues?.includes(`${key}:invalid`)) continue;
      const values = [...new Set(sameProofRows.flatMap((candidate) => {
        const details = detailsOf(candidate);
        return details.contractMetadataIssues?.includes(`${key}:invalid`) ? [] : details[key] ?? [];
      }))].sort((a, b) => a.localeCompare(b));
      const own = ownDetails[key] ?? [];
      if (JSON.stringify(values) === JSON.stringify(own)) continue;
      if (values.length === 0) continue;
      mergedAdequacy[key] = values;
      changed = true;
    }
    if (!changed) return row;
    const supportingBindingIds = [...new Set(sameProofRows
      .map((candidate) => candidate.id)
      .filter((id): id is number => Number.isSafeInteger(id) && id! > 0))].sort((a, b) => a - b);
    return {
      ...row,
      details: { ...row.details, adequacy: mergedAdequacy },
      ...(supportingBindingIds.length > 1 ? { supportingBindingIds } : {}),
    };
  });
  const candidates = reconciled.map((row) => {
    const scope = identity(row);
    const anchor = anchors.get(logicalKey(row));
    // An annotation cannot change the registered proof's identity or source scope.
    return scope &&
      anchor &&
      scope.registrationKey === anchor.scope.registrationKey &&
      JSON.stringify(scope.sources) === JSON.stringify(anchor.scope.sources)
      ? { row, scope, order: anchor.id }
      : null;
  });
  const superseded = new Set<T>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      candidates.some(
        (newer) =>
          newer &&
          newer.order > candidate.order &&
          newer.scope.key === candidate.scope.key &&
          (candidate.scope.plane === null || candidate.scope.plane === newer.scope.plane) &&
          candidate.scope.sources.every((path) => newer.scope.sources.includes(path)),
      )
    )
      superseded.add(candidate.row);
  }
  return reconciled.filter((row) => !superseded.has(row));
}

export type SpecEvidenceLineage = 'durable' | 'ephemeral' | 'unknown';

export interface SpecEvidenceLineageAssessment {
  lineage: SpecEvidenceLineage;
  reason: string;
}

interface AdequacyDetails {
  fixtureCalibrated?: boolean;
  falsifiable?: boolean;
  testLayer?: string;
  pathReachable?: boolean;
  oracleIndependent?: boolean;
  collected?: boolean;
  skipped?: boolean;
  executed?: boolean;
  outcome?: string;
  targeted?: boolean | string;
  coverageRungs?: Partial<Record<'l1' | 'l2' | 'l3' | 'l4', boolean>>;
  scenarioIds?: string[];
  causalPairIds?: string[];
  contractMetadataIssues?: string[];
  provisionalProofBase?: boolean;
  /**
   * Author-recorded holes in this proof. A disclosure is an admission that the
   * bound evidence does NOT fully establish the clause, so it must never be able
   * to coexist with a machine PASS: `disclosed-gap` fails whenever this is
   * non-empty, and the gap text is named in the would-block reason.
   */
  disclosedGap?: string[];
}

interface L4Waiver {
  justification: string;
  approvalRef: string;
  expiresAt?: string;
}

export interface SpecTestAdequacyResult {
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  planItemId: string;
  classRef: PlanClassRubricRef;
  behaviorClass: SpecBehaviorClass;
  evidenceRefs: string[];
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
  requiredProofFloor: 'none' | 'l3' | 'l4';
  verdict: 'pass' | 'fail' | 'unknown';
  wouldBlock: string[];
  /**
   * P-019 (review-system-rework-reduction-2026-09-23): for each blocking criterion, the
   * ids of the bound rows that DRAG it — the rows whose own content makes the criterion
   * fail or read unknown. The any-drags rules (freshness, execution-integrity,
   * traceability, disclosed-gap, the explicit-false boolean criteria) grade EVERY live
   * binding at the clause revision, so one old row fails a clause whose newer proof is
   * sufficient. Without the ids the fix was a hand hunt through plans:get-spec-evidence;
   * with them it is one `plans:bind-spec-evidence { supersedeAtRevision:true }` or a
   * targeted `retract`. A criterion blocked by ABSENCE (nothing bound) names no binding
   * and is omitted. Kept beside `ratings`, not inside each entry, so the scorecard rating
   * shape the completion gate matches on is unchanged.
   */
  draggingBindingIds: Partial<Record<AdequacyCriterion, number[]>>;
  scorecardDraft: {
    rubricRef: typeof SPEC_TEST_ADEQUACY_RUBRIC_REF;
    subject: { kind: 'plan'; ref: string };
    title: string;
    body: string;
    ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
    rerunRecipe: SpecTestAdequacyRerunRecipe;
    terminal: true;
  };
}

const HIGH_RISK_BEHAVIOR_CLASSES = new Set<SpecBehaviorClass>([
  'authorization',
  'concurrency',
  'lifecycle',
  'migration-data-integrity',
]);

// The mutation probe reports a detected mutant as `caught`; mutation-report
// storage may call the same result `killed`. Both are successful negative
// proof, while only the ordinary test outcomes below count as repaired proof.
const SUCCESS_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded', 'killed', 'caught']);
const REPAIRED_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded']);
const FAILURE_OUTCOMES = new Set(['fail', 'failed', 'error', 'timed-out', 'timeout', 'survived']);
const EXECUTABLE_EVIDENCE_KINDS = new Set<SpecEvidenceKind>([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);

/**
 * P-019: the repair for an any-drags criterion whose clause ALSO carries sufficient proof.
 * Bindings are append-only and every live row at the revision is graded, so an older
 * weak/stale/failing row keeps a criterion blocked beside newer proof until it is withdrawn.
 */
export const SUPERSEDE_DRAGGING_SUGGESTION =
  'The dragging binding ids are listed in draggingBindingIds. If newer bound proof already establishes this clause, ' +
  're-bind that proof with plans:bind-spec-evidence { supersedeAtRevision:true } (retracts the other live rows of the ' +
  'same kind at this revision) or retract the named ids with a reason; otherwise re-run the proof.';

/**
 * P-019: make the ledger requirement discoverable where the refusal lands. falsifiability,
 * execution-integrity and traceability cannot pass without a real ledger row, and a
 * mutation probe's row is recorded with source='mutation-probe', which testing:runs row
 * listings hide unless that source is passed explicitly.
 */
export const LEDGER_PROOF_HINT =
  'Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; ' +
  'scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows ' +
  "(listed only by testing:runs { source:'mutation-probe' }).";

/**
 * A work-item id anchors a binding only when it IS the reference: its first
 * token, optionally after a typed-prefix chain (`scorecard:EI-…`,
 * `testing:run :: WI-…`), a tool-call verb (`work_items:get WI-…`), or a
 * hyphen-joined kind (`work-item-thread-WI-…#post-…`). An id mentioned inside
 * prose (`LIVE PLANE RE-VERIFICATION … (su-…, WI-…)`) names who did the work,
 * not where the proof can be re-run, and must not make the row durable
 * (WI-10005325).
 */
const DURABLE_WORK_ITEM_REF_RE =
  /^(?:[a-z][\w-]*\s*:{1,2}\s*)*(?:[a-z][\w-]*:[a-z][\w-]*\s+)?(?:[a-z][a-z-]*-)?(?:WI|EI|F)-\d+\b/i;
/**
 * A repo file that LEADS the reference is a rerun anchor even when prose
 * follows it (`apps/…/x.test.ts — 21 passed @ b97d892c71`). DURABLE_FILE_REF_RE
 * already accepts a path followed by `#`/`:` and any text; this accepts the
 * same path followed by whitespace, `,` or `;`.
 */
const DURABLE_LEADING_FILE_REF_RE =
  /^(?:(?:file|path|repo-file):(?:\/\/)?)?(?:\.\.\/|\.\/)?(?:apps|packages|libs|scripts|src|lib|test|tests|bin|docs|rubrics)\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?=[\s,;#:]|$)/i;
const DURABLE_ARTIFACT_REF_RE =
  /\b(?:artifact|artifact[-_ ]?ref|artifact[-_ ]?id)\s*(?:[:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_TEST_RUN_REF_RE =
  /\b(?:test[-_ ]?run|testing[-_ ]?run)(?:[-_ ]?id)?\s*(?:[-:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_COVERAGE_REF_RE = /\bcoverage(?:[-_ ]?(?:evidence|run))(?:[-_ ]?id)?\s*[:/#=]\s*\d+\b/i;
const DURABLE_FILE_REF_RE =
  /(?:^|[\s:(])(?:(?:file|path|repo-file):(?:\/\/)?|(?:\.\.\/|\.\/)?)(?:apps|packages|libs|scripts|src|lib|test|tests|bin|docs|rubrics)\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?:[#:].*)?$/i;
const DURABLE_ABSOLUTE_FILE_REF_RE =
  /^(?!\/?(?:tmp|var\/tmp)(?:\/|$))\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?:[#:].*)?$/i;

function ephemeralEvidenceRefReason(evidenceRef: string): string | null {
  const normalized = evidenceRef.trim().replaceAll('\\', '/');
  if (/(^|\/)(?:tmp|var\/tmp)(?:\/|$)/i.test(normalized)) return 'temporary filesystem path';
  if (/(?:^|[\s:/#])bash(?:$|[\s:/#])/i.test(normalized)) return 'bash/session-local command reference';
  if (/\bsession[-_ ]local\b/i.test(normalized)) return 'session-local reference';
  if (/\bephemeral\b/i.test(normalized)) return 'ephemeral reference';
  return null;
}

/**
 * A binding row is durable only when its proof can be found again by another
 * evaluator. The work-item/spec edge itself is deliberately not an anchor:
 * every binding has one, and it does not identify a rerunnable proof.
 */
export function classifySpecEvidenceLineage(
  evidence: Pick<SpecEvidenceForAdequacy, 'evidenceRef' | 'coverageEvidenceRef' | 'testRunId'>,
): SpecEvidenceLineageAssessment {
  const evidenceRef = evidence.evidenceRef.trim();
  const ephemeralReason = ephemeralEvidenceRefReason(evidenceRef);
  const hasCoverageId = Number.isSafeInteger(evidence.coverageEvidenceRef) && evidence.coverageEvidenceRef! > 0;
  const hasTestRunId = Number.isSafeInteger(evidence.testRunId) && evidence.testRunId! > 0;
  if (hasTestRunId) return { lineage: 'durable', reason: 'durable testRunId' };
  if (hasCoverageId) return { lineage: 'durable', reason: 'durable coverageEvidenceRef' };
  if (
    DURABLE_WORK_ITEM_REF_RE.test(evidenceRef) ||
    DURABLE_ARTIFACT_REF_RE.test(evidenceRef) ||
    DURABLE_TEST_RUN_REF_RE.test(evidenceRef) ||
    DURABLE_COVERAGE_REF_RE.test(evidenceRef) ||
    DURABLE_FILE_REF_RE.test(evidenceRef) ||
    DURABLE_LEADING_FILE_REF_RE.test(evidenceRef) ||
    DURABLE_ABSOLUTE_FILE_REF_RE.test(evidenceRef)
  ) {
    return { lineage: 'durable', reason: 'explicit durable evidence reference' };
  }
  if (ephemeralReason) return { lineage: 'ephemeral', reason: ephemeralReason };
  return { lineage: 'unknown', reason: 'no durable rerun anchor' };
}

/**
 * Normalize an author-recorded disclosure into a list of non-empty gap strings.
 * Accepts a bare string or an array of strings; anything else is ignored.
 */
function disclosedGapList(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function detailsOf(evidence: SpecEvidenceForAdequacy): AdequacyDetails {
  const nested = evidence.details.adequacy;
  // A disclosure is read from BOTH the nested adequacy block and the top level.
  // `plans:bind-spec-evidence` accepts a free-form `details` object, so an author
  // who writes `details.disclosedGap` gets no error — reading only the nested
  // spelling would silently drop exactly the disclosure this criterion exists to
  // catch (EI-22953893504383574 is the same trap for the other adequacy keys).
  const topLevelGap = disclosedGapList((evidence.details as Record<string, unknown>).disclosedGap);
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return topLevelGap.length > 0 ? { disclosedGap: topLevelGap } : {};
  }
  const raw = nested as Record<string, unknown>;
  const disclosedGap = [...new Set([...topLevelGap, ...disclosedGapList(raw.disclosedGap)])];
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : undefined;
  const coverageRaw = raw.coverageRungs;
  const coverage =
    coverageRaw && typeof coverageRaw === 'object' && !Array.isArray(coverageRaw)
      ? (coverageRaw as Record<string, unknown>)
      : null;
  const contractMetadataIssues: string[] = [];
  const idList = (key: 'scenarioIds' | 'causalPairIds'): string[] | undefined => {
    if (!(key in raw)) return undefined;
    const value = raw[key];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((id) => typeof id !== 'string' || !SPEC_PROOF_OBLIGATION_ID_RE.test(id.trim())) ||
      new Set(value.map((id) => (typeof id === 'string' ? id.trim() : ''))).size !== value.length
    ) {
      contractMetadataIssues.push(`${key}:invalid`);
      return undefined;
    }
    return value.map((id) => id.trim()).sort();
  };
  const scenarioIds = idList('scenarioIds');
  const causalPairIds = idList('causalPairIds');
  const targeted =
    typeof raw.targeted === 'boolean'
      ? raw.targeted
      : typeof raw.targeted === 'string' && SPEC_PROOF_OBLIGATION_ID_RE.test(raw.targeted.trim())
        ? raw.targeted.trim()
        : undefined;
  if (raw.targeted !== undefined && targeted === undefined) contractMetadataIssues.push('targeted:invalid');
  return {
    ...(bool('fixtureCalibrated') !== undefined ? { fixtureCalibrated: bool('fixtureCalibrated') } : {}),
    ...(bool('falsifiable') !== undefined ? { falsifiable: bool('falsifiable') } : {}),
    ...(typeof raw.testLayer === 'string' ? { testLayer: raw.testLayer } : {}),
    ...(bool('pathReachable') !== undefined ? { pathReachable: bool('pathReachable') } : {}),
    ...(bool('oracleIndependent') !== undefined ? { oracleIndependent: bool('oracleIndependent') } : {}),
    ...(bool('collected') !== undefined ? { collected: bool('collected') } : {}),
    ...(bool('skipped') !== undefined ? { skipped: bool('skipped') } : {}),
    ...(bool('executed') !== undefined ? { executed: bool('executed') } : {}),
    ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
    ...(targeted !== undefined ? { targeted } : {}),
    ...(coverage
      ? {
          coverageRungs: Object.fromEntries(
            ['l1', 'l2', 'l3', 'l4']
              .filter((key) => typeof coverage[key] === 'boolean')
              .map((key) => [key, coverage[key]]),
          ) as AdequacyDetails['coverageRungs'],
        }
      : {}),
    ...(scenarioIds ? { scenarioIds } : {}),
    ...(causalPairIds ? { causalPairIds } : {}),
    ...(contractMetadataIssues.length > 0 ? { contractMetadataIssues } : {}),
    ...(evidence.provisionalProofBase === true || raw.provisionalProofBase === true
      ? { provisionalProofBase: true }
      : {}),
    ...(disclosedGap.length > 0 ? { disclosedGap } : {}),
  };
}

function normalizedLayer(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function clauseIdentity(clause: SpecClauseRevision): string {
  return `${clause.planSlug}/${clause.specId}@${clause.revision} (${clause.contentHash})`;
}

function clauseProbe(clause: SpecClauseRevision, harness?: string): string {
  const args = JSON.stringify({
    ...(harness !== undefined ? { harness } : {}),
    slug: clause.planSlug,
    specIds: [clause.specId],
  });
  return (
    `Probe plans:get-spec-evidence with args=${args}. ` +
    `This selects the canonical current revision for ${clause.specId}@${clause.revision} ` +
    `(fingerprint ${JSON.stringify(clause.contentHash)}); the read has no direct revision or fingerprint selector.`
  );
}

function clauseDeclarationProbe(clause: SpecClauseRevision, harness?: string): string {
  const args = JSON.stringify({
    ...(harness !== undefined ? { harness } : {}),
    slug: clause.planSlug,
    specIds: [clause.specId],
  });
  return (
    `Probe plans:get-specs with args=${args}; inspect specs[0].requiredTestLayers. ` +
    `This reads the canonical declared test-layer requirement for ${clauseIdentity(clause)} ` +
    `(expected ${JSON.stringify(clause.requiredTestLayers)}).`
  );
}

function bindingDescription(row: SpecEvidenceForAdequacy): string {
  const details = detailsOf(row);
  const lineage = classifySpecEvidenceLineage(row);
  // An authored reference can outlive the run it described. A dirty run cannot
  // substantiate a claim about the committed HEAD, so omit that stale clause.
  const evidenceRef = row.testRunProvenance?.worktreeDirty === true
    ? row.evidenceRef.replace(/\s*,?\s*at current HEAD\.?$/i, '')
    : row.evidenceRef;
  const fields = [
    // P-019: lead with the row id so a reader can act on THIS row (retract it, or re-bind
    // over it with supersedeAtRevision) without a separate plans:get-spec-evidence hunt.
    Number.isSafeInteger(row.id) ? `id=${row.id}` : null,
    row.supportingBindingIds && row.supportingBindingIds.length > 1
      ? `sameProofMetadataBindingIds=${JSON.stringify(row.supportingBindingIds)}`
      : null,
    `kind=${row.evidenceKind}`,
    `ref=${JSON.stringify(evidenceRef)}`,
    `lineage=${lineage.lineage}`,
    `lineageReason=${JSON.stringify(lineage.reason)}`,
    details.provisionalProofBase ? 'provisionalProofBase=true' : null,
    row.provisionalScorecard ? `provisionalScorecard=${JSON.stringify(row.provisionalScorecard)}` : null,
    `currentness=${row.currentness.overall}`,
    `currentnessProvenance=${row.currentness.provenance ?? 'legacy-implicit'}`,
    `sourceFingerprint=${JSON.stringify(row.fingerprints.sourceFingerprint)}`,
    row.fingerprints.testFingerprint ? `testFingerprint=${JSON.stringify(row.fingerprints.testFingerprint)}` : null,
    row.fingerprints.fixtureFingerprint
      ? `fixtureFingerprint=${JSON.stringify(row.fingerprints.fixtureFingerprint)}`
      : null,
    row.fingerprints.rubricFingerprint
      ? `rubricFingerprint=${JSON.stringify(row.fingerprints.rubricFingerprint)}`
      : null,
    row.fingerprints.environmentFingerprint
      ? `environmentFingerprint=${JSON.stringify(row.fingerprints.environmentFingerprint)}`
      : null,
    row.coverageEvidenceRef !== null ? `coverageEvidenceRef=${row.coverageEvidenceRef}` : null,
    row.testRunId !== null ? `testRunId=${row.testRunId}` : null,
    row.testRunProvenance
      ? `testRunLedgerFile=${JSON.stringify(row.testRunProvenance.filePath)}, ` +
        `testRunLedgerCommit=${JSON.stringify(row.testRunProvenance.commitSha)}, ` +
        `testRunLedgerWorktreeDirty=${row.testRunProvenance.worktreeDirty ?? 'unknown'}`
      : null,
    details.fixtureCalibrated !== undefined ? `fixtureCalibrated=${details.fixtureCalibrated}` : null,
    details.falsifiable !== undefined ? `falsifiable=${details.falsifiable}` : null,
    details.testLayer !== undefined ? `testLayer=${JSON.stringify(details.testLayer)}` : null,
    details.pathReachable !== undefined ? `pathReachable=${details.pathReachable}` : null,
    details.oracleIndependent !== undefined ? `oracleIndependent=${details.oracleIndependent}` : null,
    details.collected !== undefined ? `collected=${details.collected}` : null,
    details.skipped !== undefined ? `skipped=${details.skipped}` : null,
    details.executed !== undefined ? `executed=${details.executed}` : null,
    details.outcome !== undefined ? `outcome=${JSON.stringify(details.outcome)}` : null,
    details.targeted !== undefined ? `targeted=${details.targeted}` : null,
    details.coverageRungs
      ? `coverageRungs=${(['l1', 'l2', 'l3', 'l4'] as const)
          .filter((rung) => details.coverageRungs?.[rung] !== undefined)
          .map((rung) => `${rung}:${details.coverageRungs?.[rung]}`)
          .join('|')}`
      : null,
    details.scenarioIds ? `scenarioIds=${JSON.stringify(details.scenarioIds)}` : null,
    details.causalPairIds ? `causalPairIds=${JSON.stringify(details.causalPairIds)}` : null,
    details.contractMetadataIssues ? `contractMetadataIssues=${JSON.stringify(details.contractMetadataIssues)}` : null,
    row.currentness.staleReasons.length > 0 ? `staleReasons=${JSON.stringify(row.currentness.staleReasons)}` : null,
    row.currentness.unknownReasons.length > 0
      ? `unknownReasons=${JSON.stringify(row.currentness.unknownReasons)}`
      : null,
  ].filter((field): field is string => field !== null);
  return fields.join(', ');
}

function bindingSummary(rows: SpecEvidenceForAdequacy[]): string {
  const ordered = [...rows].sort((a, b) =>
    `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
  );
  if (ordered.length === 0) {
    return '(no bound evidence rows; probe plans:get-spec-evidence for the exact clause)';
  }
  const maxRows = 6;
  const shown = ordered.slice(0, maxRows).map(bindingDescription).join('; ');
  return ordered.length > maxRows ? `${shown}; +${ordered.length - maxRows} more binding(s)` : shown;
}

function bindingNotesSummary(rows: SpecEvidenceForAdequacy[]): string {
  const notes = rows
    .map((row) => {
      const note = typeof row.details.note === 'string' ? row.details.note.trim() : '';
      if (note.length === 0) return null;
      const excerpt = note.length > 500 ? note.slice(0, 500) + '…[truncated]' : note;
      const id = Number.isSafeInteger(row.id) ? 'id=' + row.id + ' ' : '';
      return id + 'note=' + JSON.stringify(excerpt);
    })
    .filter((note): note is string => note !== null);
  if (notes.length === 0) return '';
  const maxNotes = 6;
  const shown = notes.slice(0, maxNotes).join('; ');
  const omitted = notes.length > maxNotes ? '; +' + (notes.length - maxNotes) + ' more note(s)' : '';
  return (
    ' Free-form binding notes are visible for review but are not interpreted as disclosures: ' +
    shown +
    omitted +
    '.'
  );
}

function evidenceWithBindings(statement: string, rows: SpecEvidenceForAdequacy[]): string {
  return `${statement} Bound evidence: ${bindingSummary(rows)}.`;
}

/**
 * Presence-and-sign ONLY, deliberately — this is not where fakery is stopped.
 *
 * REFERENTIAL EXISTENCE IS ENFORCED IN POSTGRES, at bind time, by the
 * `spec_evidence_bindings_validate_refs` BEFORE INSERT trigger installed in
 * migration 855 (`harness_shared.validate_spec_evidence_binding_refs`). It
 * rejects a `test_run_id` / `coverage_evidence_ref` that does not resolve with
 * ERRCODE 23503, and matches on `workspace_id` AND `harness_slug`, so a
 * fabricated or cross-tenant id can never reach a row this function ever sees.
 *
 * Read this predicate on its own and `execution-integrity` looks trivially
 * fakeable (`testRunId: 1` would satisfy it). That reading is wrong, and it has
 * cost a bogus bug filing at least once — EI-22684973731417610, filed against
 * this exact function and retracted after the trigger was verified live via
 * pg_trigger + pg_get_functiondef. Audit the DB before concluding the ledger
 * reference is unchecked.
 *
 * Corollary worth knowing: because the trigger matches harness_slug exactly, a
 * test run recorded under a DIFFERENT harness than the binding (or with the
 * NULL scope that CI/dogfood-reporter rows carry by design) cannot be bound as
 * evidence at all.
 */
function hasExecutionLedgerReference(row: SpecEvidenceForAdequacy): boolean {
  return (
    (Number.isSafeInteger(row.testRunId) && row.testRunId! > 0) ||
    (Number.isSafeInteger(row.coverageEvidenceRef) && row.coverageEvidenceRef! > 0)
  );
}

function isSuccessfulExecutableEvidence(row: SpecEvidenceForAdequacy): boolean {
  const details = detailsOf(row);
  return (
    EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind) &&
    hasExecutionLedgerReference(row) &&
    details.collected === true &&
    details.skipped === false &&
    details.executed === true &&
    SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')
  );
}

// EI-23756870948948211: when a row FAILS isSuccessfulExecutableEvidence, callers need to know
// WHICH conjunct was unmet — otherwise a refusal names a cause it never tested and the reader
// goes hunting the wrong layer. A normally-authored binding sets evidenceKind + a ledger ref +
// outcome and omits details.collected/skipped/executed, so those three are the usual culprits,
// and `unset` is reported distinctly from an explicit `false` because the two are fixed by
// different edits.
function executableEvidenceGaps(row: SpecEvidenceForAdequacy): string[] {
  const details = detailsOf(row);
  const show = (value: boolean | undefined): string => (value === undefined ? 'unset' : String(value));
  const gaps: string[] = [];
  if (!EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind)) {
    gaps.push(`evidenceKind=${row.evidenceKind} is not executable`);
  }
  if (!hasExecutionLedgerReference(row)) {
    gaps.push('no testRunId/coverageEvidenceRef ledger reference');
  }
  if (details.collected !== true) {
    gaps.push(`collected=${show(details.collected)}`);
  }
  if (details.skipped !== false) {
    gaps.push(`skipped=${show(details.skipped)}`);
  }
  if (details.executed !== true) {
    gaps.push(`executed=${show(details.executed)}`);
  }
  if (!SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')) {
    gaps.push(`outcome=${details.outcome === undefined ? 'unset' : JSON.stringify(details.outcome)}`);
  }
  return gaps;
}

function summarizeExecutableEvidenceGaps(rows: SpecEvidenceForAdequacy[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const gap of executableEvidenceGaps(row)) {
      counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return 'no unmet conjunct identified';
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([gap, count]) => (rows.length > 1 ? `${gap} on ${count}` : gap))
    .join(', ');
}

/**
 * P-019: why a binding may NOT supersede its siblings at a clause revision (empty = it
 * may). `plans:bind-spec-evidence { supersedeAtRevision:true }` retracts the other live
 * rows of the same kind at that revision, so the superseding row must itself be proof the
 * evaluator would accept on its own: successful ledger-backed executable evidence, with no
 * explicit falsifiable=false and no author-disclosed gap. Anything weaker would let a
 * binder shed adverse evidence by binding a weaker row over it — the evidence-shedding
 * D-011 forbids. Reuses the evaluator's own conjuncts so the two cannot drift.
 */
export function supersedeEligibilityGaps(binding: {
  evidenceKind: SpecEvidenceKind;
  testRunId?: number | null;
  coverageEvidenceRef?: number | null;
  details?: Record<string, unknown>;
}): string[] {
  const row = {
    evidenceKind: binding.evidenceKind,
    testRunId: binding.testRunId ?? null,
    coverageEvidenceRef: binding.coverageEvidenceRef ?? null,
    details: binding.details ?? {},
  } as SpecEvidenceForAdequacy;
  const details = detailsOf(row);
  return [
    ...executableEvidenceGaps(row),
    ...(details.falsifiable === false ? ['falsifiable=false'] : []),
    ...(details.disclosedGap?.length ? ['an author-disclosed gap is recorded'] : []),
  ];
}

function isSuccessfulRepairedEvidence(row: SpecEvidenceForAdequacy): boolean {
  const details = detailsOf(row);
  return isSuccessfulExecutableEvidence(row) && REPAIRED_OUTCOMES.has(details.outcome?.toLowerCase() ?? '');
}

function booleanRating(
  evidence: SpecEvidenceForAdequacy[],
  pick: (details: AdequacyDetails) => boolean | undefined,
  labels: { pass: string; fail: string; unknown: string },
): AdequacyRatingEntry {
  const evaluated = evidence
    .map((row) => ({ row, value: pick(detailsOf(row)) }))
    .filter((entry): entry is { row: SpecEvidenceForAdequacy; value: boolean } => entry.value !== undefined);
  const inspected = evaluated.length > 0 ? evaluated.map(({ row }) => row) : evidence;
  const passing = evaluated.filter(({ value }) => value).map(({ row }) => row);
  const failing = evaluated.filter(({ value }) => !value).map(({ row }) => row);
  if (passing.length > 0) return { rating: 'pass', evidence: evidenceWithBindings(labels.pass, passing) };
  if (failing.length > 0) return { rating: 'fail', evidence: evidenceWithBindings(labels.fail, failing) };
  return { rating: 'unknown', evidence: evidenceWithBindings(labels.unknown, inspected) };
}

function l4WaiverOf(exemption: Record<string, unknown> | null, now: Date): L4Waiver | null {
  const root = exemption?.testAdequacyWaivers;
  const raw = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>).l4 : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const waiver = raw as Record<string, unknown>;
  if (typeof waiver.justification !== 'string' || waiver.justification.trim().length < 12) return null;
  if (typeof waiver.approvalRef !== 'string' || waiver.approvalRef.trim().length === 0) return null;
  if (waiver.expiresAt !== undefined) {
    if (typeof waiver.expiresAt !== 'string') return null;
    const expiry = new Date(waiver.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  }
  return {
    justification: waiver.justification.trim(),
    approvalRef: waiver.approvalRef.trim(),
    ...(typeof waiver.expiresAt === 'string' ? { expiresAt: waiver.expiresAt } : {}),
  };
}

/**
 * `task` is the canonical non-code work-item kind (research was folded into it), so
 * executable test-proof floors do not apply to a task even when a plan clause was
 * projected with a behavior class that would otherwise require L3/L4. Keep this
 * classification at the floor boundary so every caller gets the same exemption.
 */
export function isNonCodeWorkItemKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && kind.trim().toLowerCase() === 'task';
}

export function requiredProofFloor(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
  workItemKind?: string | null,
): 'none' | 'l3' | 'l4' {
  if (isNonCodeWorkItemKind(workItemKind)) return 'none';
  if (clause.behaviorClass === 'non-automated' && clause.requiredTestLayers.length === 0) return 'none';
  if (classRef === 'plan-class-migration' || classRef === 'plan-class-bugfix') return 'l4';
  if (clause.mutationRequired || HIGH_RISK_BEHAVIOR_CLASSES.has(clause.behaviorClass)) return 'l4';
  if (classRef === 'plan-class-investigation' && clause.requiredTestLayers.length === 0) return 'none';
  return 'l3';
}

function riskFloorRating(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
  evidence: SpecEvidenceForAdequacy[],
  now: Date,
  harness?: string,
  workItemKind?: string | null,
): { floor: 'none' | 'l3' | 'l4'; rating: AdequacyRatingEntry } {
  const floor = requiredProofFloor(clause, classRef, workItemKind);
  if (floor === 'none') {
    return {
      floor,
      rating: {
        rating: 'not-applicable',
        evidence: `Clause ${clauseIdentity(clause)} is non-automated and declares no required test layer. ${clauseProbe(clause, harness)}`,
      },
    };
  }
  const detailRows = evidence.map((row) => ({ row, details: detailsOf(row) }));
  const isMutation = (row: SpecEvidenceForAdequacy) =>
    row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample';
  const hasClauseBoundMutationProof = (row: SpecEvidenceForAdequacy) =>
    isClauseBoundMutationProof(clause, row, evidence);
  const isL4Proof = ({ row, details }: (typeof detailRows)[number]): boolean =>
    isMutation(row) ? hasClauseBoundMutationProof(row) : details.coverageRungs?.l4 === true;
  const meetsL4 = detailRows.some(isL4Proof);
  const isL3Proof = ({ row, details }: (typeof detailRows)[number]): boolean =>
    isL4Proof({ row, details }) ||
    (details.coverageRungs?.l3 === true && (!isMutation(row) || hasClauseBoundMutationProof(row)));
  const meetsL3 = detailRows.some(isL3Proof);
  const meetsL3Rows = detailRows.filter(isL3Proof);
  const proofBindings = (rows: typeof detailRows) =>
    [...new Set(rows.flatMap(({ row }) => {
      const pairedTest = isMutation(row) ? clauseBoundMutationTest(clause, row, evidence) : null;
      return pairedTest ? [row, pairedTest] : [row];
    }))];
  if (floor === 'l4') {
    if (meetsL4) {
      return {
        floor,
        rating: {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L4 proof meets the ${clauseIdentity(clause)} floor.`,
            proofBindings(detailRows.filter(isL4Proof)),
          ),
        },
      };
    }
    const waiver = l4WaiverOf(clause.exemption, now);
    if (waiver) {
      return {
        floor,
        rating: {
          rating: 'waived',
          evidence:
            `L4 for ${clauseIdentity(clause)} is explicitly waived by approvalRef=${waiver.approvalRef}: ` +
            `${waiver.justification}${waiver.expiresAt ? ` (expires ${waiver.expiresAt})` : ''}. ${clauseProbe(clause, harness)}`,
        },
      };
    }
    const hasExplicitL4Miss = detailRows.some(({ details }) => details.coverageRungs?.l4 === false);
    return {
      floor,
      rating: {
        rating: hasExplicitL4Miss ? 'fail' : 'unknown',
        evidence: hasExplicitL4Miss
          ? evidenceWithBindings(
              `Bound coverage explicitly reports L4=false for ${clauseIdentity(clause)} and no current approved waiver exists.`,
              detailRows.filter(({ details }) => details.coverageRungs?.l4 === false).map(({ row }) => row),
            )
          : `${evidenceWithBindings(
              `No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for ${clauseIdentity(clause)}.`,
              evidence,
            )} ${clauseProbe(clause, harness)}`,
        suggestion: 'Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision.',
      },
    };
  }
  const hasExplicitL3Miss = detailRows.some(({ details }) => details.coverageRungs?.l3 === false);
  return {
    floor,
    rating: meetsL3
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L3 or stronger proof meets the ${clauseIdentity(clause)} floor.`,
            proofBindings(meetsL3Rows),
          ),
        }
      : {
          rating: hasExplicitL3Miss ? 'fail' : 'unknown',
          evidence: hasExplicitL3Miss
            ? evidenceWithBindings(
                `Bound coverage explicitly reports L3=false for ${clauseIdentity(clause)}.`,
                detailRows.filter(({ details }) => details.coverageRungs?.l3 === false).map(({ row }) => row),
              )
            : `${evidenceWithBindings(
                `No explicit meets_l3 result is bound for ${clauseIdentity(clause)}; depth or a generic passing test is not a rung verdict.`,
                evidence,
              )} ${clauseProbe(clause, harness)}`,
          suggestion: 'Bind a coverage-census row whose independent meets_l3 flag is current.',
        },
  };
}

/**
 * Return the stable subject reference used by every spec-test-adequacy surface.
 * Keep the truncation deterministic so the write boundary and completion gate
 * cannot disagree about a long plan/spec identifier.
 */
export function specTestAdequacySubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

function rerunRecipeFor(
  clause: SpecClauseRevision,
  evidence: SpecEvidenceForAdequacy[],
  current: EvidenceCurrentInput[] | undefined,
  harness: string | undefined,
  classRef: PlanClassRubricRef,
  selection: { workItemIds?: string[]; evidenceRefs?: string[]; bindingIds?: number[]; planItemIds?: string[] } | undefined,
): SpecTestAdequacyRerunRecipe {
  const evaluatorBuild = getBuildInfo();
  const selectedEvidence = [
    ...new Map(
      evidence.map((row) => [
        evidenceCurrentInputKey(row),
        {
          evidenceKind: row.evidenceKind,
          evidenceRef: row.evidenceRef,
        },
      ]),
    ).values(),
  ].sort((a, b) => `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`));
  const selectedEvidenceRefs = [...new Set(selectedEvidence.map((row) => row.evidenceRef))].sort((a, b) =>
    a.localeCompare(b),
  );
  // Preserve an explicit caller selector even when the in-memory evidence rows
  // are empty for this clause (for example, an uncovered or legacy binding).
  // Omitting it would widen the persisted recipe into an unfiltered replay.
  const replayEvidenceRefs =
    selectedEvidenceRefs.length > 0
      ? selectedEvidenceRefs
      : [...new Set(selection?.evidenceRefs ?? [])].sort((a, b) => a.localeCompare(b));
  const replayBindingIds =
    evidence.length > 0 && evidence.every((row) => Number.isSafeInteger(row.id) && row.id! > 0)
      ? [...new Set(evidence.flatMap((row) => row.supportingBindingIds ?? [row.id!]))].sort((a, b) => a - b)
      : selection?.bindingIds !== undefined
        ? [...new Set(selection.bindingIds)].sort((a, b) => a - b)
        // An empty graded population is still an exact selection. Leaving the selector
        // omitted would let a later binding silently enter this scorecard's rerun.
        : evidence.length === 0
          ? []
          : undefined;
  const currentByKey = new Map((current ?? []).map((row) => [evidenceCurrentInputKey(row), row]));
  const currentForEvidence = (row: SpecEvidenceForAdequacy): EvidenceCurrentInput | undefined => {
    const scopedCurrentKey = evidenceCurrentInputKey({
      planSlug: row.planSlug,
      specId: row.specId,
      specRevision: row.specRevision,
      specFingerprint: row.specFingerprint,
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
    });
    const legacyCurrentKey = evidenceCurrentInputKey({
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
    });
    return currentByKey.get(scopedCurrentKey) ?? currentByKey.get(legacyCurrentKey);
  };
  const fingerprints: SpecTestAdequacyCurrentFingerprint[] = [
    ...new Map(
      evidence
        .map(currentForEvidence)
        .filter((row): row is EvidenceCurrentInput => row !== undefined)
        .map((row) => [evidenceCurrentInputKey(row), row] as const),
    ).values(),
  ]
    .map((row) => ({
      ...(row.planSlug !== undefined &&
      row.specId !== undefined &&
      row.specRevision !== undefined &&
      row.specFingerprint !== undefined
        ? {
            planSlug: row.planSlug,
            specId: row.specId,
            specRevision: row.specRevision,
            specFingerprint: row.specFingerprint,
          }
        : {}),
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
      sourceFingerprint: row.sourceFingerprint,
      testFingerprint: row.testFingerprint ?? null,
      fixtureFingerprint: row.fixtureFingerprint ?? null,
      rubricFingerprint: row.rubricFingerprint ?? null,
      environmentFingerprint: row.environmentFingerprint ?? null,
    }))
    .sort((a, b) => evidenceCurrentInputKey(a).localeCompare(evidenceCurrentInputKey(b)));
  return {
    schemaVersion: 1,
    evaluator: 'plans:evaluate-spec-test-adequacy',
    evaluatorBuild: {
      sha: evaluatorBuild.sha,
      version: evaluatorBuild.version,
    },
    evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
    classRef,
    // Submittable as-is. `selection` below spells planSlug/specId/specRevision/
    // specFingerprint, none of which the evaluator accepts — it takes slug/specIds and
    // REQUIRES classRef. Emitting only `selection` made every card's rerun recipe fail
    // its own evaluator with `invalid_args`, leaving a re-runner to guess classRef and
    // silently move plan-class-risk-floor.
    args: {
      ...(harness !== undefined ? { harness } : {}),
      slug: clause.planSlug,
      classRef,
      evaluatorBuild: {
        sha: evaluatorBuild.sha,
        version: evaluatorBuild.version,
      },
      specIds: [clause.specId],
      ...(selection?.workItemIds?.length ? { workItemIds: [...selection.workItemIds] } : {}),
      // The recipe must replay the exact evidence population the evaluator graded,
      // even when the caller selected it indirectly through a work item or plan
      // item. Reusing only the caller's optional evidenceRefs would let later
      // bindings silently widen a persisted scorecard's replay.
      ...(replayEvidenceRefs.length ? { evidenceRefs: replayEvidenceRefs } : {}),
      ...(replayBindingIds !== undefined ? { bindingIds: replayBindingIds } : {}),
      ...(selection?.planItemIds?.length ? { planItemIds: [...selection.planItemIds] } : {}),
      includeDraft: true,
      limit: SPEC_TEST_ADEQUACY_REPLAY_LIMIT,
      // Replay the exact immutable clause snapshot that produced this grade. The pin
      // fixes WHICH clause revision is graded; it does not freeze freshness — the
      // server re-measures each binding's persisted recipe, so this card replays
      // 'pass' only while the proven code is unchanged (WI-10002320).
      specRevision: clause.revision,
      specFingerprint: clause.contentHash,
      replaySnapshot: true,
      // Fingerprints classify the selected bindings; the selectors above define
      // the population. Keeping those roles separate prevents a partial current[]
      // input from silently excluding an unmeasured historical binding.
      ...(current !== undefined ? { current: fingerprints } : {}),
    },
    selection: {
      planSlug: clause.planSlug,
      specId: clause.specId,
      specRevision: clause.revision,
      specFingerprint: clause.contentHash,
      evidence: selectedEvidence,
      ...(replayBindingIds !== undefined ? { bindingIds: replayBindingIds } : {}),
    },
    current: {
      supplied: current !== undefined,
      fingerprints,
    },
    derivation: {
      kind: 'listSpecEvidence.currentness',
      classifier: 'classifySpecEvidenceCurrentness',
      unknownWhenMissing: true,
    },
  };
}

export function crossGenerationAuditProbeArgs(rerunRecipe: SpecTestAdequacyRerunRecipe) {
  // Keep this named export for persisted/test callers, but the criterion-local
  // probe must be the SAME immutable replay as the card-level recipe. A reduced
  // compatibility subset silently widens an exact evidenceRefs selection to
  // historical bindings; a non-author can then execute the stated probe and get
  // ratings that contradict the card even though the persisted recipe passes.
  // An older evaluator that cannot parse this contract is an explicit generation
  // mismatch, not permission to substitute a different evidence population.
  return { ...rerunRecipe.args };
}

function appendRatingRerunProbes(
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>,
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): void {
  const args = JSON.stringify(crossGenerationAuditProbeArgs(rerunRecipe));
  for (const criterion of ADEQUACY_CRITERIA) {
    const rating = ratings[criterion];
    ratings[criterion] = {
      ...rating,
      evidence:
        `${rating.evidence} Re-run ${rerunRecipe.evaluator} with args=${args}; ` +
        `inspect rows[0].ratings[${JSON.stringify(criterion)}].`,
    };
  }
}

/**
 * P-043 (review-system-rework-reduction-2026-09-23): the evaluator RULE revision stamped on
 * every adequacy card's rerun recipe. BUMP IT whenever a change here can alter a criterion
 * verdict for unchanged evidence (a new/tightened rule, a moved threshold) — not for prose,
 * refactors or new diagnostics. `evaluatorBuild` cannot serve: it moves on every deploy.
 *   1 — cards minted before the stamp existed (absent field reads as 1).
 *   2 — the a49fca9b96 scenario-scoped falsifiability target + the WI-10002724 own-specId
 *       fallback (D-009), which the stamp was introduced alongside.
 *   3 — correct-layer requires the declared live/deployed evidence plane on a current binding.
 *   4 — a mutation/counterexample target must be corroborated by successful current test evidence
 *       for its canonical test file on the same clause revision.
 */
export const SPEC_TEST_ADEQUACY_EVALUATOR_REVISION = 4;

type MutationTargetClause = Pick<SpecClauseRevision, 'specId' | 'falsifier'>;

/**
 * The falsifiability TARGETING rule, shared by the evaluator and plans:bind-spec-evidence so a
 * binding the evaluator will reject is refused at bind (P-043) rather than discovered after its
 * audit passed. A clause that declares falsifier.requiredScenarios accepts only those scenario
 * ids. WI-10002724 / D-009: a clause that declares NONE has no scenario id to name, so under the
 * scenario-only rule its falsifiability could never pass (4,026 of 4,136 active clauses on
 * 2026-09-23); the clause itself is the case, so a target naming its own specId qualifies.
 * Obligation ids are lower-case (SPEC_PROOF_OBLIGATION_ID_RE), so the specId is lower-cased. A
 * boolean target, or one naming a sibling spec or scenario, never qualifies.
 */
export function mutationTargetRequirement(clause: MutationTargetClause): {
  acceptedTargets: string[];
  selfTarget: string | null;
  requirement: string;
} {
  const scenarios = [...new Set(clause.falsifier?.requiredScenarios ?? [])];
  const selfTarget = scenarios.length === 0 ? clause.specId.toLowerCase() : null;
  return {
    acceptedTargets: selfTarget !== null ? [selfTarget] : scenarios,
    selfTarget,
    requirement:
      selfTarget !== null
        ? `this clause's own specId (adequacy.targeted = '${selfTarget}'; it declares no falsifier.requiredScenarios)`
        : "a scenario id in this clause's falsifier.requiredScenarios",
  };
}

export function isAcceptedMutationTarget(clause: MutationTargetClause, targeted: unknown): boolean {
  return typeof targeted === 'string' && mutationTargetRequirement(clause).acceptedTargets.includes(targeted);
}

/**
 * `adequacy.targeted` is caller-authored metadata. A mutation probe is clause-scoped only when
 * its canonical test file also has successful, current test evidence bound to the same immutable
 * clause revision. This prevents a killed mutant from a sibling clause's test suite from
 * satisfying falsifiability or the proof floor by naming this clause in its own binding.
 */
function clauseBoundMutationTest(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): SpecEvidenceForAdequacy | null {
  const filePath = mutation.testRunProvenance?.filePath;
  if (!filePath || filePath.trim().length === 0) return null;
  return evidence.find(
    (row) =>
      row.evidenceKind === 'test' &&
      row.planSlug === clause.planSlug &&
      row.specId === clause.specId &&
      row.specRevision === clause.revision &&
      row.specFingerprint === clause.contentHash &&
      row.testRunProvenance?.filePath === filePath &&
      row.currentness.overall === 'current' &&
      isSuccessfulRepairedEvidence(row),
  ) ?? null;
}

function isClauseBoundMutationTest(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): boolean {
  return clauseBoundMutationTest(clause, mutation, evidence) !== null;
}

function isClauseBoundMutationProof(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): boolean {
  return isSuccessfulExecutableEvidence(mutation) &&
    isAcceptedMutationTarget(clause, detailsOf(mutation).targeted) &&
    isClauseBoundMutationTest(clause, mutation, evidence);
}

export type AdequacyCardRevisionDisposition = {
  recordedRevision: number;
  currentRevision: number;
  /**
   * current  — graded under the current rule revision and every verdict still matches.
   * carried  — graded under an OLDER rule revision, re-evaluated from the stored runs, and
   *            every verdict is unchanged: the card and its settled audit stay valid.
   * verdict-changed — at least one criterion verdict differs; only this needs a new card
   *            and a new audit.
   */
  state: 'current' | 'carried' | 'verdict-changed';
  changed: Array<{ criterion: string; recorded: string | null; current: string | null }>;
};

/**
 * P-043: decide whether a stored adequacy card survives re-evaluation under the live rule.
 * Pure: the caller supplies the live ratings recomputed from the card's stored bindings. The
 * verdict comparison is per criterion and exact, so the rule is never lowered — a card only
 * carries when EVERY live verdict equals the recorded one.
 */
export function adequacyCardRevisionDisposition(input: {
  recordedRevision: number | undefined;
  recordedRatings: Record<string, unknown>;
  liveRatings: Record<string, { rating: string }>;
  currentRevision?: number;
}): AdequacyCardRevisionDisposition {
  const recordedRevision = input.recordedRevision ?? 1;
  const currentRevision = input.currentRevision ?? SPEC_TEST_ADEQUACY_EVALUATOR_REVISION;
  const ratingOf = (value: unknown): string | null =>
    value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { rating?: unknown }).rating === 'string'
      ? (value as { rating: string }).rating
      : null;
  const criteria = [...new Set([...Object.keys(input.recordedRatings), ...Object.keys(input.liveRatings)])].sort();
  const changed = criteria
    .map((criterion) => ({
      criterion,
      recorded: ratingOf(input.recordedRatings[criterion]),
      current: input.liveRatings[criterion]?.rating ?? null,
    }))
    .filter((entry) => entry.recorded !== entry.current);
  return {
    recordedRevision,
    currentRevision,
    changed,
    state: changed.length > 0 ? 'verdict-changed' : recordedRevision < currentRevision ? 'carried' : 'current',
  };
}

/** Grade one clause/evidence row into the exact ratings map accepted by scorecards:emit. */
export function evaluateSpecTestAdequacy(input: {
  clause: SpecClauseRevision;
  evidence: SpecEvidenceForAdequacy[];
  classRef: PlanClassRubricRef;
  /** Resolved harness scope to persist for operator-scope reruns. */
  harness?: string;
  /** The caller-attested current fingerprints used by listSpecEvidence. */
  current?: EvidenceCurrentInput[];
  /** Exact caller selectors that constrain the evidence population on replay. */
  rerunSelection?: { workItemIds?: string[]; evidenceRefs?: string[]; bindingIds?: number[]; planItemIds?: string[] };
  /** Work-item classification; `task` is the canonical non-code kind. */
  workItemKind?: string | null;
  now?: Date;
}): SpecTestAdequacyResult {
  const { clause, classRef } = input;
  // WI-10002082: keep the pre-projection selector match addressable. A binding can satisfy every
  // clause selector and still be dropped by `activeSpecEvidence` (it carries no test-execution
  // identity, or a later attempt superseded it). Without this population the falsifiability refusal
  // below reports a FALSE ABSENCE — "no binding is bound" — while a live, fingerprint-matching
  // binding sits in the table, which drives binders to stack redundant re-bindings on one clause.
  const exactSelectorMatches = input.evidence.filter(
    (row) =>
      row.planSlug === clause.planSlug &&
      row.specId === clause.specId &&
      row.specRevision === clause.revision &&
      row.specFingerprint === clause.contentHash,
  );
  const exactEvidence = activeSpecEvidence(exactSelectorMatches);
  const currentEvidence = exactEvidence.filter(
    (row) =>
      row.currentness.overall === 'current' ||
      (row.currentness.overall === 'unknown' && row.currentness.provenance === 'attested-current'),
  );
  // A caller-supplied `current[]` is a per-binding comparison input, not a population
  // selector. Keep every exact binding in that case so an omitted fingerprint remains
  // visible as unknown instead of silently disappearing from the graded population. The
  // historical current-cohort behavior is retained only for internally/server-classified
  // evidence when no caller comparison input was supplied.
  const evidence =
    input.current !== undefined
      ? exactEvidence
      : currentEvidence.length > 0
        ? exactEvidence.filter(
            (row) =>
              currentEvidence.includes(row) ||
              // An active registered attempt whose freshness is unknown/stale cannot disappear
              // merely because another test in this clause is current and passing.
              hasTestAttemptReference(row),
          )
        : exactEvidence;
  const ratings = {} as Record<AdequacyCriterion, AdequacyRatingEntry>;

  const lineageAssessments = evidence.map((row) => ({ row, assessment: classifySpecEvidenceLineage(row) }));
  const ephemeralEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'ephemeral')
    .map(({ row }) => row);
  const unknownLineageEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'unknown')
    .map(({ row }) => row);
  ratings.traceability = !evidence.length
    ? {
        rating: 'fail',
        evidence: `No immutable evidence binding resolves ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
        suggestion: 'Bind the work item and proof through plans:bind-spec-evidence.',
      }
    : ephemeralEvidence.length > 0
      ? {
          rating: 'fail',
          evidence: evidenceWithBindings(
            `Ephemeral-only evidence cannot establish independently rerunnable traceability for ${clauseIdentity(clause)}.`,
            ephemeralEvidence,
          ),
          suggestion:
            'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
        }
      : unknownLineageEvidence.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Evidence lineage is not anchored to a durable rerunnable record for ${clauseIdentity(clause)}.`,
              unknownLineageEvidence,
            ),
            suggestion:
              'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `${evidence.length} immutable binding(s) have durable rerunnable lineage for ${clauseIdentity(clause)}.`,
              evidence,
            ),
          };

  // `evidence` is the current grading cohort when a current row exists. It is
  // intentionally narrower than the exact clause population, so use the latter
  // for existence/applicability claims. Otherwise an unknown historical fixture
  // binding can be hidden by a current test binding and reported as absent.
  const fixtureBindings = exactEvidence.filter(
    (row) => row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null,
  );
  const fixtureOutsideCurrent = fixtureBindings.filter((row) => !evidence.includes(row));
  const fixtureApplicable =
    clause.requiredEvidence.some((entry) => /fixture/i.test(entry)) || fixtureBindings.length > 0;
  const fixtureRating: AdequacyRatingEntry = fixtureApplicable
    ? booleanRating(evidence, (d) => d.fixtureCalibrated, {
        pass: 'An applicable binding explicitly attests fixtureCalibrated=true.',
        fail: 'Applicable binding metadata explicitly attests fixtureCalibrated=false.',
        unknown: 'A fixture is required or used, but no binding attests fixtureCalibrated=true/false.',
      })
    : {
        rating: 'not-applicable',
        evidence: `No fixture binding or fixture fingerprint is present for ${clauseIdentity(clause)}; the exact bindings inspected were ${bindingSummary(exactEvidence)}.`,
      };
  ratings['fixture-calibration'] =
    fixtureOutsideCurrent.length > 0
      ? {
          ...fixtureRating,
          evidence: `${fixtureRating.evidence} ${fixtureOutsideCurrent.length} exact fixture binding(s) are outside the current grading cohort; this cohort narrowing does not establish spec-scoped fixture absence.`,
        }
      : fixtureRating;

  // EI-22128161413448729: a self-attested `adequacy.falsifiable=true` flag is a WEAKER claim
  // than an actually-bound mutation/counterexample row with a killed/survived outcome — the two
  // must never share one evidence sentence, or an auditor reads "bound negative control" when
  // only an attestation exists. Branch the template on which basis is actually present.
  const boundMutationOrCounterexample = evidence.filter((row) => {
    return (
      (row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') && isSuccessfulExecutableEvidence(row)
    );
  });
  // The targeting rule (scenario ids, or the WI-10002724 own-specId fallback) lives in
  // mutationTargetRequirement. A syntactically valid target remains a claim until the
  // mutation run's canonical test file has its own successful test binding to this clause.
  const { selfTarget: clauseSelfTarget, requirement: clauseTargetRequirement } = mutationTargetRequirement(clause);
  const clauseScopedMutationOrCounterexample = boundMutationOrCounterexample.filter((row) =>
    isClauseBoundMutationProof(clause, row, evidence),
  );
  const targetedMutationWithoutTestBinding = boundMutationOrCounterexample.filter(
    (row) =>
      isAcceptedMutationTarget(clause, detailsOf(row).targeted) &&
      !isClauseBoundMutationTest(clause, row, evidence),
  );
  const clauseScopedProofBindings = [
    ...new Set(
      clauseScopedMutationOrCounterexample.flatMap((row) => [
        row,
        clauseBoundMutationTest(clause, row, evidence)!,
      ]),
    ),
  ];
  const exactMutationOrCounterexample = exactEvidence.filter(
    (row) => row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample',
  );
  // EI-23756870948948211: `exactMutationOrCounterexample` is filtered by evidenceKind ALONE, so a
  // non-empty result says nothing about WHY the row failed to bind. The refusal below used it to
  // assert one untested cause — "outside the current grading cohort" — when the far more common
  // case is a row sitting INSIDE the cohort that fails isSuccessfulExecutableEvidence (usually
  // details.collected/skipped/executed left unset by a normally-authored binding). Worse, when the
  // caller supplies `current[]` then `evidence === exactEvidence`, so NOTHING can be outside the
  // cohort and the asserted cause is impossible while still being printed. Split the populations by
  // real membership — the same test the fixture branch already uses for `fixtureOutsideCurrent` —
  // and report the conjunct that actually failed.
  const mutationOutsideCohort = exactMutationOrCounterexample.filter((row) => !evidence.includes(row));
  const mutationInCohortNotExecutable = exactMutationOrCounterexample.filter(
    (row) => evidence.includes(row) && !isSuccessfulExecutableEvidence(row),
  );
  // WI-10002082, RETRACTED — recorded here so the "fix" below is not re-attempted. It LOOKS as
  // though a binding could match every clause selector, be removed by the `activeSpecEvidence` read
  // projection, reach NONE of the populations above, and fall through to "no binding is bound": a
  // false absence printed while a selector-matching binding sits in the table. It cannot happen, and
  // a branch reporting it is unreachable — one was added here and removed after a calibration
  // assertion proved it never fires.
  //
  // The projection drops a row by exactly two routes, and BOTH PRESERVE `evidenceKind`:
  // `latestLogicalEvidence` keys on [workItemId, planSlug, specId, specRevision, evidenceKind,
  // evidenceRef], and attempt-supersession requires `newer.scope.key === candidate.scope.key`, whose
  // `registrationKey` carries `row.evidenceKind`. So a dropped mutation/counterexample row ALWAYS
  // leaves a surviving same-kind superseder in `exactEvidence` — hence in
  // `exactMutationOrCounterexample` — so either `mutationInCohortNotExecutable` or
  // `mutationOutsideCohort` is non-empty and reports first, or the survivor grades and falsifiability
  // passes outright. The bare-absence fall-through below is therefore TRUE whenever it prints.
  // 'projection supersession cannot strand a mutation binding' in the sibling test pins that
  // invariant: make supersession kind-agnostic and it fails, and this branch must come back.
  const attestedFalsifiableOnly = evidence.filter((row) => detailsOf(row).falsifiable === true);
  const unboundMutationReason =
    mutationInCohortNotExecutable.length > 0
      ? `${mutationInCohortNotExecutable.length} mutation or counterexample binding(s) are in the current grading cohort for ${clauseIdentity(clause)} but do not qualify as successful executable evidence (${summarizeExecutableEvidenceGaps(mutationInCohortNotExecutable)}).`
      : mutationOutsideCohort.length > 0
        ? `${mutationOutsideCohort.length} mutation or counterexample binding(s) exist in the exact clause population but are outside the current grading cohort for ${clauseIdentity(clause)}.`
        : targetedMutationWithoutTestBinding.length > 0
          ? `${targetedMutationWithoutTestBinding.length} successful mutation or counterexample binding(s) name ${clauseIdentity(clause)} but their canonical test file is not also bound as a successful current test for this clause.`
        : boundMutationOrCounterexample.length > 0
          ? clauseSelfTarget !== null
            ? `Successful mutation or counterexample binding(s) for ${clauseIdentity(clause)} do not target this clause's own specId.`
            : `Successful mutation or counterexample binding(s) for ${clauseIdentity(clause)} do not name a scenario declared in falsifier.requiredScenarios.`
          : `no mutation or counterexample binding is bound for ${clauseIdentity(clause)}.`;
  ratings.falsifiability =
    clauseScopedMutationOrCounterexample.length > 0
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            clauseSelfTarget !== null
              ? `A bound mutation or counterexample targets ${clauseIdentity(clause)} itself, which declares no structured falsifier.requiredScenarios list; its canonical test file is separately bound as a successful current test for this clause.`
              : `A bound mutation or counterexample targets a declared falsifier scenario for ${clauseIdentity(clause)}; its canonical test file is separately bound as a successful current test for this clause.`,
            clauseScopedProofBindings,
          ),
        }
      : boundMutationOrCounterexample.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for ${clauseIdentity(clause)}; ${unboundMutationReason}`,
              boundMutationOrCounterexample,
            ),
            suggestion:
              targetedMutationWithoutTestBinding.length > 0
                ? `Bind a successful test result for the mutation run's canonical test file to ${clauseIdentity(clause)}; adequacy.targeted alone cannot establish that link.`
                : `Set adequacy.targeted to ${clauseTargetRequirement}; a boolean or sibling-case target is insufficient.`,
          }
      : attestedFalsifiableOnly.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Binder-attested falsifiable=true on ${attestedFalsifiableOnly.length} binding(s) is insufficient to demonstrate red capability for ${clauseIdentity(clause)}; ${unboundMutationReason}`,
              attestedFalsifiableOnly,
            ),
            suggestion:
              mutationInCohortNotExecutable.length > 0
                ? `Complete the existing mutation or counterexample binding so it qualifies as successful executable evidence (unmet: ${summarizeExecutableEvidenceGaps(mutationInCohortNotExecutable)}); falsifiable=true metadata alone is insufficient.`
                : 'Bind a successful ledger-backed mutation or counterexample result; falsifiable=true metadata alone is insufficient.',
          }
        : booleanRating(evidence, (d) => d.falsifiable, {
            pass: `A bound proof explicitly demonstrates falsifiability for ${clauseIdentity(clause)}.`,
            fail: `Bound metadata explicitly reports falsifiable=false for ${clauseIdentity(clause)}.`,
            unknown:
              exactMutationOrCounterexample.length > 0
                ? `A mutation or counterexample binding exists in the exact clause population, but no current-cohort binding demonstrates how ${clauseIdentity(clause)} fails when behavior is wrong.`
                : // A projection-dropped binding cannot reach here while this population is empty —
                  // see the retracted-WI-10002082 note above for why the two are inseparable.
                  `No bound evidence demonstrates how ${clauseIdentity(clause)} fails when behavior is wrong.`,
          });

  let layerRating: AdequacyRatingEntry;
  if (clause.requiredTestLayers.length === 0) {
    layerRating = {
      rating: 'not-applicable',
      evidence: `The clause ${clauseIdentity(clause)} declares no required test layer. ${clauseDeclarationProbe(clause, input.harness)}`,
    };
  } else {
    const required = [...new Set(clause.requiredTestLayers.map(normalizedLayer))];
    const present = new Map<string, boolean | undefined>();
    for (const row of evidence) {
      const details = detailsOf(row);
      if (typeof details.testLayer !== 'string') continue;
      const layer = normalizedLayer(details.testLayer);
      if (!required.includes(layer)) continue;
      const prior = present.get(layer);
      present.set(layer, prior === true || details.pathReachable === true ? true : details.pathReachable);
    }
    const missing = required.filter((layer) => !present.has(layer));
    const unreachable = required.filter((layer) => present.get(layer) === false);
    const unresolved = required.filter((layer) => present.get(layer) === undefined);
    layerRating =
      missing.length || unreachable.length
        ? {
            rating: 'fail',
            evidence: `${evidenceWithBindings(
              `Required layer/path gaps for ${clauseIdentity(clause)}: ${[
                ...missing.map((layer) => `${layer}:missing`),
                ...unreachable.map((layer) => `${layer}:unreachable`),
              ].join(', ')}.`,
              evidence,
            )} ${clauseDeclarationProbe(clause, input.harness)}`,
            suggestion: 'Bind proof for every requiredTestLayer and attest that it reaches the real path.',
          }
        : unresolved.length
          ? {
              rating: 'unknown',
              evidence: evidenceWithBindings(
                `Required layer(s) are represented but path reachability is unverified for ${clauseIdentity(clause)}: ${unresolved.join(', ')}.`,
                evidence.filter((row) => {
                  const details = detailsOf(row);
                  return (
                    typeof details.testLayer === 'string' && unresolved.includes(normalizedLayer(details.testLayer))
                  );
                }),
              ),
            }
          : {
              rating: 'pass',
              evidence: evidenceWithBindings(
                `Every required layer reaches the claimed path for ${clauseIdentity(clause)}: ${required.join(', ')}.`,
                evidence.filter((row) => {
                  const details = detailsOf(row);
                  return (
                    typeof details.testLayer === 'string' &&
                    required.includes(normalizedLayer(details.testLayer)) &&
                    details.pathReachable === true
                  );
                }),
              ),
            };
  }

  const requiredScenarios = [...new Set(clause.falsifier?.requiredScenarios ?? [])].sort();
  let scenarioRating: AdequacyRatingEntry | null = null;
  if (requiredScenarios.length > 0) {
    const malformedScenarioRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('scenarioIds:invalid'),
    );
    const successfulScenarioRows = evidence.filter(
      (row) => isSuccessfulExecutableEvidence(row) && detailsOf(row).pathReachable === true,
    );
    const covered = new Set(successfulScenarioRows.flatMap((row) => detailsOf(row).scenarioIds ?? []));
    const missing = requiredScenarios.filter((scenario) => !covered.has(scenario));
    scenarioRating =
      missing.length > 0
        ? {
            rating: 'fail',
            evidence: evidenceWithBindings(
              `Canonical acceptance scenario(s) are not covered by successful ledger-backed path proof for ${clauseIdentity(clause)}: ${missing.join(', ')}. Required scenarios: ${requiredScenarios.join(', ')}.`,
              successfulScenarioRows,
            ),
            suggestion:
              'Bind successful executed proof whose adequacy.scenarioIds cover every falsifier.requiredScenarios id.',
          }
        : malformedScenarioRows.length > 0
          ? {
              rating: 'unknown',
              evidence: evidenceWithBindings(
                `All named scenarios are represented, but malformed scenarioIds metadata prevents a complete scenario-cohort verdict for ${clauseIdentity(clause)}.`,
                malformedScenarioRows,
              ),
              suggestion: 'Supersede malformed bindings with schema-valid adequacy.scenarioIds.',
            }
          : {
              rating: 'pass',
              evidence: evidenceWithBindings(
                `Every canonical acceptance scenario has successful ledger-backed path proof for ${clauseIdentity(clause)}: ${requiredScenarios.join(', ')}.`,
                successfulScenarioRows.filter((row) =>
                  (detailsOf(row).scenarioIds ?? []).some((scenario) => requiredScenarios.includes(scenario)),
                ),
              ),
            };
  }
  // A standalone clause can require a live or deployed observation without a source BAR.
  // The BAR ship gate checks its own evidence plane, but cannot cover such a clause.
  // Inspect only current-cohort bindings and use the same explicit plane metadata as
  // the BAR snapshot; a tree test cannot satisfy a declared live observation.
  const requiredPlanes = [...new Set(clause.requiredEvidence
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === 'live' || entry === 'deployed'))];
  const presentPlanes = new Set(currentEvidence.flatMap((row) => {
    const plane = row.details.evidencePlane ?? row.details.evidence_plane ?? row.details.plane;
    return typeof plane === 'string' ? [plane.trim().toLowerCase()] : [];
  }));
  const missingPlanes = requiredPlanes.filter((plane) => !presentPlanes.has(plane));
  const planeRating: AdequacyRatingEntry | null = requiredPlanes.length === 0 ? null : missingPlanes.length > 0
    ? {
        rating: 'fail',
        evidence: `Required evidence plane(s) are absent for ${clauseIdentity(clause)}: ${missingPlanes.join(', ')}.`,
        suggestion: 'Bind current evidence with an explicit matching evidencePlane for each requiredEvidence plane.',
      }
    : {
        rating: 'pass',
        evidence: `Current bindings cover the required evidence plane(s) for ${clauseIdentity(clause)}: ${requiredPlanes.join(', ')}.`,
      };
  const parts = [layerRating, scenarioRating, planeRating].filter((part): part is AdequacyRatingEntry => part !== null);
  const combinedRating: AdequacyRating = parts.some((part) => part.rating === 'fail')
    ? 'fail'
    : parts.some((part) => part.rating === 'unknown')
      ? 'unknown'
      : parts.every((part) => part.rating === 'not-applicable')
        ? 'not-applicable'
        : 'pass';
  ratings['correct-layer'] = {
    rating: combinedRating,
    evidence: parts.map((part) => part.evidence).join(' '),
    ...((parts.map((part) => part.suggestion).filter(Boolean).length > 0)
      ? { suggestion: parts.map((part) => part.suggestion).filter(Boolean).join(' ') }
      : {}),
  };

  ratings['oracle-independence'] = booleanRating(evidence, (d) => d.oracleIndependent, {
    pass: `A bound proof explicitly uses an implementation-independent oracle for ${clauseIdentity(clause)}.`,
    fail: `Bound metadata explicitly reports oracleIndependent=false for ${clauseIdentity(clause)}.`,
    unknown: `No bound evidence establishes oracle independence for ${clauseIdentity(clause)}.`,
  });

  const executable = evidence.filter((row) => EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind));
  const unbackedExecution = executable.filter((row) => !hasExecutionLedgerReference(row));
  const explicitBadExecutionRows = executable.filter((row) => {
    const d = detailsOf(row);
    return (
      d.collected === false ||
      d.skipped === true ||
      d.executed === false ||
      FAILURE_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
    );
  });
  const explicitBadExecution = explicitBadExecutionRows.length > 0;
  const successfulExecution = executable.some((row) => {
    const d = detailsOf(row);
    return (
      hasExecutionLedgerReference(row) &&
      d.collected === true &&
      d.skipped === false &&
      d.executed === true &&
      SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
    );
  });
  const incompleteMeasuredExecution = executable.filter((row) => {
    if (!row.details.testExecution) return false;
    const d = detailsOf(row);
    return (
      d.collected !== true ||
      d.skipped !== false ||
      d.executed !== true ||
      !SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
    );
  });
  const executionRating: AdequacyRatingEntry = explicitBadExecution
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          `At least one relied-on binding reports an uncollected, skipped, unexecuted, or failing outcome for ${clauseIdentity(clause)}.`,
          explicitBadExecutionRows,
        ),
        // P-019: bindings are append-only, so an older failing attempt keeps failing this
        // criterion beside a newer passing one until it is withdrawn.
        ...(successfulExecution ? { suggestion: SUPERSEDE_DRAGGING_SUGGESTION } : {}),
      }
    : unbackedExecution.length > 0
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            `Executable binding(s) attest execution details but have no testRunId or coverageEvidenceRef in the execution ledger for ${clauseIdentity(clause)}; author-attested booleans cannot establish execution-integrity.`,
            unbackedExecution,
          ),
          suggestion:
            'Bind a recorded testRunId or coverageEvidenceRef; details.adequacy booleans alone are insufficient.',
        }
      : incompleteMeasuredExecution.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Active measured test attempts have incomplete execution proof for ${clauseIdentity(clause)}.`,
              incompleteMeasuredExecution,
            ),
          }
        : successfulExecution
          ? {
              rating: 'pass',
              evidence: evidenceWithBindings(
                `Bound proof was collected, not skipped, executed, and produced a successful outcome for ${clauseIdentity(clause)}.`,
                executable.filter((row) => {
                  const d = detailsOf(row);
                  return (
                    d.collected === true &&
                    d.skipped === false &&
                    d.executed === true &&
                    SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
                  );
                }),
              ),
            }
          : {
              rating: executable.length ? 'unknown' : 'fail',
              evidence: executable.length
                ? evidenceWithBindings(
                    `Executable bindings exist for ${clauseIdentity(clause)}, but collection/skip/execution/outcome metadata is incomplete.`,
                    executable,
                  )
                : `No executable test/check/mutation/counterexample/coverage/operational proof is bound for ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
              // EI-23958122348412546: with zero executable rows this 'fail' reports ABSENCE,
              // not bad evidence — the non-code exemption below must be able to reach it.
              ...(executable.length ? {} : { absenceOnly: true }),
            };

  let causalPairRating: AdequacyRatingEntry | null = null;
  if (clause.falsifier?.causalPairing === 'one-to-one') {
    const canonicalPairIds = [...new Set(clause.falsifier.requiredScenarios ?? [])].sort();
    const malformedPairRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('causalPairIds:invalid'),
    );
    const negativeRows = evidence.filter(
      (row) => row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample',
    );
    const recurrenceRows = evidence.filter(
      (row) =>
        row.evidenceKind !== 'mutation' &&
        row.evidenceKind !== 'counterexample' &&
        detailsOf(row).causalPairIds !== undefined,
    );
    const violations: string[] = [];
    const negativeByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const recurrenceByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const add = (target: Map<string, SpecEvidenceForAdequacy[]>, pairId: string, row: SpecEvidenceForAdequacy) =>
      target.set(pairId, [...(target.get(pairId) ?? []), row]);

    for (const row of malformedPairRows) violations.push(`${row.evidenceRef}:malformed causalPairIds`);
    if (negativeRows.length === 0) violations.push('no mutation/counterexample binding declares the original failure');
    for (const row of negativeRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the negative binding`);
        continue;
      }
      add(negativeByPair, details.causalPairIds[0]!, row);
    }
    for (const row of recurrenceRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the recurrence binding`);
        continue;
      }
      add(recurrenceByPair, details.causalPairIds[0]!, row);
    }
    const pairIds = [...new Set([...negativeByPair.keys(), ...recurrenceByPair.keys()])].sort();
    if (canonicalPairIds.length > 0) {
      const missingCanonicalPairs = canonicalPairIds.filter((pairId) => !pairIds.includes(pairId));
      const unexpectedPairs = pairIds.filter((pairId) => !canonicalPairIds.includes(pairId));
      if (missingCanonicalPairs.length > 0) {
        violations.push(`canonical causalPairId(s) missing: ${missingCanonicalPairs.join(', ')}`);
      }
      if (unexpectedPairs.length > 0) {
        violations.push(`causalPairId(s) not named by requiredScenarios: ${unexpectedPairs.join(', ')}`);
      }
    }
    for (const pairId of pairIds) {
      const negatives = negativeByPair.get(pairId) ?? [];
      const recurrences = recurrenceByPair.get(pairId) ?? [];
      if (negatives.length !== 1) violations.push(`${pairId}:expected 1 negative binding, found ${negatives.length}`);
      if (recurrences.length !== 1)
        violations.push(`${pairId}:expected 1 recurrence binding, found ${recurrences.length}`);
      if (negatives.length === 1 && !isSuccessfulExecutableEvidence(negatives[0]!)) {
        violations.push(`${pairId}:negative binding is not successful ledger-backed counterexample proof`);
      }
      if (recurrences.length === 1 && !isSuccessfulRepairedEvidence(recurrences[0]!)) {
        violations.push(`${pairId}:recurrence binding is not successful ledger-backed repaired proof`);
      }
    }
    causalPairRating =
      violations.length > 0
        ? {
            rating: 'fail',
            evidence: evidenceWithBindings(
              `The canonical one-to-one causal-pair contract is incomplete for ${clauseIdentity(clause)}: ${violations.join('; ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
            suggestion:
              'Bind exactly one successful ledger-backed mutation/counterexample row and one successful repaired row for each stable adequacy.causalPairIds id.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every original failure has exactly one successful ledger-backed negative and repaired recurrence binding for ${clauseIdentity(clause)}: ${pairIds.join(', ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
          };
  }
  if (causalPairRating === null) {
    ratings['execution-integrity'] = executionRating;
  } else {
    const combinedRating: AdequacyRating =
      executionRating.rating === 'fail' || causalPairRating.rating === 'fail'
        ? 'fail'
        : executionRating.rating === 'unknown' || causalPairRating.rating === 'unknown'
          ? 'unknown'
          : 'pass';
    ratings['execution-integrity'] = {
      rating: combinedRating,
      evidence: `${executionRating.evidence} Causal pairing: ${causalPairRating.evidence}`,
      ...([executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).length > 0
        ? { suggestion: [executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).join(' ') }
        : {}),
    };
  }

  const freshnessStates = evidence.map((row) => row.currentness.overall);
  ratings.freshness = freshnessStates.includes('stale')
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          `Stale binding(s) invalidate freshness for ${clauseIdentity(clause)}.`,
          evidence.filter((row) => row.currentness.overall === 'stale'),
        ),
        // P-019: a stale row drags this criterion even when a current sibling proves the clause.
        suggestion: evidence.some((row) => row.currentness.overall === 'current')
          ? SUPERSEDE_DRAGGING_SUGGESTION
          : 'Re-run the stale proof (testing:run with evidence) so the server re-measures it against current source.',
      }
    : freshnessStates.includes('unknown')
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            (() => {
              const unknownEvidence = evidence.filter((row) => row.currentness.overall === 'unknown');
              const refs = unknownEvidence.map((row) => row.evidenceRef).join(', ');
              const callerOmittedCurrent = unknownEvidence.some((row) => !row.currentness.comparisonSupplied);
              const callerAttestedCurrent = unknownEvidence.some(
                (row) => row.currentness.provenance === 'attested-current',
              );
              // A replayed tuple matched its stored values and is capped at `unknown`
              // BECAUSE it matched — nothing is missing and nothing is stale. Without
              // this arm the chain fell through to "Current fingerprints are missing",
              // which states the opposite of what happened and sends the reader hunting
              // for absent evidence (WI-10002320). The two arms above exist for exactly
              // this reason on their own provenances.
              const callerReplayedCurrent = unknownEvidence.some(
                (row) => row.currentness.provenance === 'replayed-snapshot',
              );
              const partiallyServerMeasured = unknownEvidence.filter(
                (row) => row.currentness.provenance === 'partially-server-measured',
              );
              return partiallyServerMeasured.length > 0
                ? `Repository fingerprints were server-measured, but applicable non-repository dimensions ` +
                    `were only caller-attested and cannot establish freshness for: ${partiallyServerMeasured
                      .map((row) => row.evidenceRef)
                      .join(', ')}.`
                : callerAttestedCurrent
                  ? `Current fingerprints were caller-supplied and are labeled attested-current; matching stored values cannot establish independently measured freshness, so freshness is unknown for this replay input. Missing comparison for: ${refs}.`
                  : callerReplayedCurrent
                    ? `Current fingerprints were supplied by a replayed snapshot and MATCHED the stored values; a replayed tuple is not an independent measurement, so freshness is unknown for this replay input—nothing is missing and nothing is stale. Re-run so the server measures each binding's own persisted measurement basis. Awaiting independent measurement for: ${refs}.`
                    : callerOmittedCurrent
                      ? `Current fingerprints were not supplied by this call (current[] was omitted), so freshness is unknown for this replay input—not evidence that stored bindings are stale. If replaying a rerunRecipe, pass rerunRecipe.current.fingerprints. Missing comparison for: ${refs}.`
                      : `Current fingerprints are missing for: ${refs}.`;
            })(),
            evidence.filter((row) => row.currentness.overall === 'unknown'),
          ),
        }
      : evidence.length
        ? {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every bound proof dimension is current for ${clauseIdentity(clause)}.`,
              evidence,
            ),
          }
        : {
            rating: 'fail',
            evidence: `No evidence exists whose freshness can be established for ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
            // EI-23958122348412546: absence of any measurable binding, not a stale one.
            absenceOnly: true,
          };

  const risk = riskFloorRating(clause, classRef, evidence, input.now ?? new Date(), input.harness, input.workItemKind);
  ratings['plan-class-risk-floor'] = risk.rating;

  // EI-23793489732627099: the non-code exemption reached ONLY plan-class-risk-floor.
  // requiredProofFloor's own doc comment promises that "executable test-proof floors
  // do not apply to a task", but the promise was kept at the floor and nowhere else,
  // so a clause describing non-code work (a triage-to-disposition item, a
  // measurement/investigation item) could never reach an all-pass verdict by ANY
  // route — binding, re-kind, re-class, or the l4 waiver, which is itself consumed
  // inside riskFloorRating and so cleared only the floor too. Each criterion below
  // structurally demands an artifact non-code work cannot produce: falsifiability
  // needs a ledger-backed mutation/counterexample row, execution-integrity needs a
  // ledger testRunId or coverage row, and freshness needs a details.currentMeasurement
  // whose kind is the literal 'repo-files'. The clause sat in wouldBlock forever and
  // blocked plan ship with no reachable repair.
  //
  // Only 'unknown' is downgraded, and that boundary is the whole safety argument:
  // 'unknown' means "this cannot be established", which for non-code work is
  // structural and expected. A 'fail' means the bound evidence positively reports
  // something bad — falsifiable=false, a failed outcome, a stale binding — which is
  // real information about real evidence and must keep blocking, exemption or not.
  // EI-23958122348412546: the exemption originally downgraded ONLY 'unknown', which left it
  // unreachable for the canonical non-code case. Evidence declared honestly as `manual` is not
  // an EXECUTABLE_EVIDENCE_KIND, so it produces ZERO executable rows, so execution-integrity
  // rated a bare 'fail' and was skipped here — the clause blocked ship with no reachable repair,
  // which is verbatim the failure the block above says it fixed. Worse, the incentive inverted:
  // binding one executable-kind row with author-attested booleans and NO ledger anchor rated
  // 'unknown' and WAS exempted, so weaker evidence passed where honest evidence failed.
  //
  // An absence-shaped 'fail' is now downgraded alongside 'unknown'. The safety boundary is
  // unchanged and is carried by `absenceOnly`, not by the rating: a 'fail' that reports
  // something POSITIVELY bad (falsifiable=false, a failed/skipped/unexecuted outcome, a stale
  // binding) never sets that flag and therefore still blocks, exemption or not.
  if (risk.floor === 'none') {
    for (const criterion of EXECUTABLE_PROOF_CRITERIA) {
      const current = ratings[criterion];
      const exemptible = current.rating === 'unknown' || (current.rating === 'fail' && current.absenceOnly === true);
      if (!exemptible) continue;
      ratings[criterion] = {
        rating: 'not-applicable',
        evidence:
          `${clauseIdentity(clause)} carries no executable proof floor (requiredProofFloor='none'), so ` +
          `${criterion} is not applicable to it: the criterion can only be satisfied by ledger- or ` +
          `repo-backed executable proof that non-code work cannot produce. Rated '${current.rating}'` +
          `${current.absenceOnly === true ? ' (absence of executable proof, not adverse evidence)' : ''} before the ` +
          `exemption was applied — ${current.evidence}`,
      };
    }
  }

  // A DISCLOSURE IS NOT A MITIGATION. Before this criterion existed, an author
  // could record a known hole in the proof on the binding and still collect a
  // machine PASS, because no evaluator field read the disclosure — so the gap
  // travelled with the evidence while the verdict said the clause was proven.
  // Re-binding the same immutable proof can also append a newer metadata row
  // without the disclosure. Keep that gap attached to the active logical
  // reference while its run/fingerprints are unchanged, and until changed proof
  // is server-current. A stale or unknown replacement has not closed the gap.
  const activeByLogicalReference = new Map(exactEvidence.map((row) => [logicalEvidenceReferenceKey(row), row]));
  const disclosedGapRows = exactSelectorMatches.filter((row) => {
    if ((detailsOf(row).disclosedGap ?? []).length === 0) return false;
    const active = activeByLogicalReference.get(logicalEvidenceReferenceKey(row));
    if (!active) return false;
    return proofIdentity(row) === proofIdentity(active) || active.currentness.overall !== 'current';
  });
  const freeFormNoteRows = exactSelectorMatches.filter((row) => {
    const note = row.details.note;
    if (typeof note !== 'string' || note.trim().length === 0) return false;
    const active = activeByLogicalReference.get(logicalEvidenceReferenceKey(row));
    if (!active) return false;
    return proofIdentity(row) === proofIdentity(active) || active.currentness.overall !== 'current';
  });
  const noDisclosureStatement =
    'No bound proof for ' +
    clauseIdentity(clause) +
    ' records a structured author-disclosed gap.' +
    bindingNotesSummary(freeFormNoteRows) +
    (freeFormNoteRows.length > 0
      ? ' Record any coverage limitation under details.adequacy.disclosedGap so machine grading blocks it.'
      : '');
  ratings['disclosed-gap'] =
    disclosedGapRows.length > 0
      ? {
          rating: 'fail',
          evidence: evidenceWithBindings(
            `Bound proof for ${clauseIdentity(clause)} records an author-disclosed gap, so it cannot be read as a machine PASS. Disclosed: ${[
              ...new Set(disclosedGapRows.flatMap((row) => detailsOf(row).disclosedGap ?? [])),
            ].join(' | ')}.`,
            disclosedGapRows,
          ),
          suggestion:
            'Close the disclosed gap and re-bind, or supersede the binding with proof carrying no disclosure. A disclosure cannot be graded away while it stands.',
        }
      : {
          rating: 'not-applicable',
          // Still routed through evidenceWithBindings when bindings exist: every
          // criterion's evidence string must surface the bound proof base (a
          // provisional one especially), including the criteria that found nothing.
          evidence:
            evidence.length > 0
              ? evidenceWithBindings(noDisclosureStatement, evidence)
              : noDisclosureStatement,
        };

  // P-019: surface the ledger requirement on every ledger-gated criterion that is still
  // short of proof, where the binder reads the refusal, not in a doc they must find first.
  for (const criterion of ['falsifiability', 'execution-integrity', 'traceability'] as const) {
    const current = ratings[criterion];
    if (current.rating !== 'fail' && current.rating !== 'unknown') continue;
    ratings[criterion] = {
      ...current,
      suggestion: current.suggestion ? `${current.suggestion} ${LEDGER_PROOF_HINT}` : LEDGER_PROOF_HINT,
    };
  }

  const rerunRecipe = rerunRecipeFor(clause, evidence, input.current, input.harness, classRef, input.rerunSelection);
  appendRatingRerunProbes(ratings, rerunRecipe);

  const wouldBlock = ADEQUACY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  // P-019: name the rows that DRAG each blocking criterion. Each list is the population
  // the criterion's own branch above judged adverse or incomplete; a criterion blocked by
  // absence has no such row and is omitted rather than reported with an empty list.
  const draggingRows: Partial<Record<AdequacyCriterion, SpecEvidenceForAdequacy[]>> = {
    traceability: ephemeralEvidence.length > 0 ? ephemeralEvidence : unknownLineageEvidence,
    'fixture-calibration': evidence.filter((row) => detailsOf(row).fixtureCalibrated === false),
    falsifiability: [
      ...evidence.filter((row) => detailsOf(row).falsifiable === false),
      ...mutationInCohortNotExecutable,
    ],
    'correct-layer': evidence.filter((row) => detailsOf(row).pathReachable === false),
    'oracle-independence': evidence.filter((row) => detailsOf(row).oracleIndependent === false),
    'execution-integrity': explicitBadExecution
      ? explicitBadExecutionRows
      : unbackedExecution.length > 0
        ? unbackedExecution
        : incompleteMeasuredExecution.length > 0
          ? incompleteMeasuredExecution
          : successfulExecution
            ? []
            : executable,
    freshness: evidence.some((row) => row.currentness.overall === 'stale')
      ? evidence.filter((row) => row.currentness.overall === 'stale')
      : evidence.filter((row) => row.currentness.overall === 'unknown'),
    'disclosed-gap': disclosedGapRows,
  };
  const draggingBindingIds: Partial<Record<AdequacyCriterion, number[]>> = {};
  for (const criterion of ADEQUACY_CRITERIA) {
    if (!wouldBlock.includes(criterion)) continue;
    const ids = [
      ...new Set(
        (draggingRows[criterion] ?? []).flatMap((row) => (Number.isSafeInteger(row.id) ? [row.id!] : [])),
      ),
    ].sort((a, b) => a - b);
    if (ids.length > 0) draggingBindingIds[criterion] = ids;
  }
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  const evidenceRefs = [...new Set(evidence.map((row) => row.evidenceRef))].sort();
  const subjectRef = specTestAdequacySubjectRef(
    rerunRecipe.selection.planSlug,
    rerunRecipe.selection.specId,
    rerunRecipe.selection.specRevision,
  );
  const rawRefs = evidenceRefs.join(', ') || '(none)';
  const bodyRefs =
    rawRefs.length <= 7_000 ? rawRefs : `${rawRefs.slice(0, 6_980)}… (see evidenceRefs for the full set)`;
  return {
    planSlug: clause.planSlug,
    specId: clause.specId,
    specRevision: clause.revision,
    specFingerprint: clause.contentHash,
    planItemId: clause.planItemId,
    classRef,
    behaviorClass: clause.behaviorClass,
    evidenceRefs,
    ratings,
    requiredProofFloor: risk.floor,
    verdict,
    wouldBlock,
    draggingBindingIds,
    scorecardDraft: {
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subject: { kind: 'plan', ref: subjectRef },
      title: `${clause.specId}@${clause.revision} test adequacy`,
      body: `Exact clause ${clause.planSlug}/${clause.specId}@${clause.revision}; fingerprint ${clause.contentHash}; work item evidence refs: ${bodyRefs}.`,
      ratings,
      rerunRecipe,
      terminal: true,
    },
  };
}
