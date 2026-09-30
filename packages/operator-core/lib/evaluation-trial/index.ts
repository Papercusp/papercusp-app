/**
 * The canonical evaluation-trial contract (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-004).
 *
 * One versioned identity + evidence envelope shared by every measurement family,
 * projected from the rows those families already write. P-001 (WI-41656) proved
 * extension viable and this module honours that verdict literally: no new table,
 * no new column, no competing authority.
 *
 * Typical use:
 *
 *     const trial = trialFromLlmTestRun(row);
 *     const id = computeTrialIdentity(trial);
 *     if (!areComparable(id, priorId)) {
 *       // refuse to reuse the prior verdict; explainIncomparability(id, priorId)
 *       // says whether the bindings differ or a binding was never recorded.
 *     }
 */
export type {
  EvaluationTrial,
  EvidenceEnvelope,
  GraderKind,
  PrivacyClass,
  TrialBudgets,
  TrialConfiguration,
  TrialFamily,
  TrialGrader,
  TrialLineage,
  TrialOutcome,
  TrialStatus,
  TrialSubject,
  TrialSystemIdentity,
  TrialUsage,
} from './schema';

export {
  EVALUATION_TRIAL_CONTRACT_LABEL,
  EVALUATION_TRIAL_CONTRACT_SHAPE,
  EVALUATION_TRIAL_CONTRACT_VERSION,
  EVALUATION_TRIAL_IDENTITY_DOMAIN,
  TRIAL_BINDING_FIELDS,
  areComparable,
  computeTrialIdentity,
  explainIncomparability,
  type TrialIdentity,
} from './identity';

export {
  fingerprint,
  trialFromHiveEvalRun,
  trialFromLlmTestRun,
  trialFromScorecard,
  trialFromTaskRunResult,
  type LlmTestRunRow,
} from './adapters';

export {
  EVIDENCE_SEAL_DOMAIN,
  sealEvidence,
  type EnvironmentSnapshot,
  type EvidenceManifest,
  type EvidencePart,
  type PreservedArtifact,
  type PreservedEvidence,
  type SealedEvidence,
  type TrajectoryStep,
  type TrajectoryStepKind,
} from './evidence';

export {
  DEFAULT_JUDGE_VIEW_POLICY,
  JUDGE_VIEW_DOMAIN,
  deriveJudgeView,
  hashJudgeView,
  verifyJudgeView,
  type CompactArtifact,
  type CompactJudgeView,
  type CompactStep,
  type JudgeViewFailureKind,
  type JudgeViewPolicy,
  type JudgeViewVerification,
} from './judge-view';

export {
  replayTrialEvidence,
  verifyEvidence,
  type IntegrityFailureKind,
  type IntegrityFinding,
  type IntegrityReport,
  type ReplayReport,
  type VerifyEvidenceInput,
} from './integrity';

export {
  toInspectCompatibleEvaluation,
  toOpenTelemetryOpenInferenceTrace,
  type CanonicalPortablePayload,
  type InspectCompatibleEvaluation,
  type OpenTelemetryOpenInferenceTrace,
  type PortableSpan,
} from './portable';
