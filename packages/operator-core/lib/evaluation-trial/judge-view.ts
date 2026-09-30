/**
 * The compact judge view — DERIVED from preserved evidence (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-005; D-003,
 * D-004, D-006).
 *
 * ## Derived, not authored
 *
 * D-003 says compact views are projections, never competing authorities. The
 * operative word is *derived*: a judge view that is assembled independently of the
 * evidence — hand-built at grading time from whatever the caller had handy — can
 * drift from the trajectory it claims to summarize, and nothing would detect it.
 *
 * So every view carries `derivedFrom`, the root hash of the exact evidence set it
 * was computed over, and `verifyJudgeView` refuses a view whose `derivedFrom` does
 * not match the evidence it is being checked against. A stored judge view is thus
 * falsifiable after the fact, which is the only thing that makes "the judge saw
 * this" a checkable claim rather than an assumption.
 *
 * ## Truncation is DECLARED, never silent
 *
 * A judge view exists because a full trajectory does not fit in a judging context.
 * That makes truncation normal — and makes SILENT truncation the dangerous case: a
 * judge shown the first twenty steps of a sixty-step run, with nothing saying so,
 * grades a partial run believing it complete, and its verdict is recorded as if it
 * had seen everything.
 *
 * Every drop is therefore counted (`stepsOmitted`, `charsOmitted`) and summarized
 * in one boolean (`complete`). The same discipline this repo applies to bounded
 * aggregates — a count computed over a capped fetch must say so ON the aggregate,
 * because a bounded measurement rendered as a confident number is indistinguishable
 * from a real one — applies to a bounded trajectory rendered as a confident
 * transcript.
 *
 * ## The view deliberately carries NO outcome
 *
 * `CompactJudgeView` has no `status`, no `resolved`, no `score`, and no grader
 * verdict of any kind. This is not an omission to be helpfully filled in later: a
 * judge input that carries the stored verdict leaks the answer to the judge being
 * asked to produce it, and any agreement measured afterwards is measuring the leak.
 * `judge-view.test.ts` asserts the absence structurally, against the outcome field
 * names the contract actually defines, so a future field cannot quietly appear here.
 *
 * @see evidence.ts  — the preserved evidence and its seal
 * @see integrity.ts — replay and the three refusal classes
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import type { EnvironmentSnapshot, EvidenceManifest, PreservedEvidence, TrajectoryStepKind } from './evidence';
import { EVALUATION_TRIAL_CONTRACT_VERSION, computeTrialIdentity } from './identity';
import type { EvaluationTrial, PrivacyClass } from './schema';

/** Domain-separation tag hashed into every judge-view hash. */
export const JUDGE_VIEW_DOMAIN = 'papercusp-evaluation-judge-view-v1';

/**
 * The budget a view was derived under.
 *
 * Hashed into `viewHash`, so two views over identical evidence but different
 * budgets are distinguishable — without this, a narrower re-derivation would
 * silently claim to be the same view.
 */
export interface JudgeViewPolicy {
  maxSteps: number;
  maxStepChars: number;
  maxSubmissionChars: number;
  maxGraderOutputChars: number;
}

/** The default judging budget. Explicit and exported so a caller can record which one it used. */
export const DEFAULT_JUDGE_VIEW_POLICY: JudgeViewPolicy = Object.freeze({
  maxSteps: 200,
  maxStepChars: 4_000,
  maxSubmissionChars: 20_000,
  maxGraderOutputChars: 20_000,
});

/** One step as the judge sees it. */
export interface CompactStep {
  index: number;
  kind: TrajectoryStepKind;
  role?: string | null;
  name?: string | null;
  content: string;
  /** Characters dropped from this step's content. 0 when nothing was dropped. */
  charsOmitted: number;
}

/** An artifact as the judge sees it: identity and size, never content. */
export interface CompactArtifact {
  id: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

/** The compact, judge-facing projection of one trial's evidence. */
export interface CompactJudgeView {
  contractVersion: string;
  /** Identity of the trial this view is FOR — so a view cannot be attached to another trial. */
  trialKey: string;
  subjectKey: string;
  /** Root hash of the evidence this view was derived from. */
  derivedFrom: string;
  /** sha256 over the domain tag, the policy, and this view's content. */
  viewHash: string;
  policy: JudgeViewPolicy;
  steps: CompactStep[];
  /** Steps dropped entirely by `maxSteps`. */
  stepsOmitted: number;
  /** Characters dropped across every retained step, plus submission and grader output. */
  charsOmitted: number;
  /** True only when NOTHING was dropped. Read this before trusting the view as a transcript. */
  complete: boolean;
  /**
   * The environment, verbatim. `undefined` = the source recorded none;
   * `null` = the source recorded that there was none (D-021).
   */
  environment?: EnvironmentSnapshot | null;
  submission?: string | null;
  graderOutput?: string | null;
  artifacts: CompactArtifact[];
  privacy: PrivacyClass;
}

/** Truncate to a character budget, reporting exactly how much was dropped. */
function clamp(value: string, max: number): { text: string; omitted: number } {
  if (value.length <= max) return { text: value, omitted: 0 };
  return { text: value.slice(0, max), omitted: value.length - max };
}

/**
 * Derive the compact judge view for a trial from its preserved evidence.
 *
 * Pure and deterministic: the same trial, evidence and policy always produce an
 * identical view including its `viewHash`. That determinism is what makes replay
 * meaningful — a stored view can be re-derived and compared byte for byte.
 */
export function deriveJudgeView(
  trial: EvaluationTrial,
  evidence: PreservedEvidence,
  manifest: EvidenceManifest,
  policy: JudgeViewPolicy = DEFAULT_JUDGE_VIEW_POLICY,
): CompactJudgeView {
  const identity = computeTrialIdentity(trial);

  const retained = evidence.trajectory.slice(0, policy.maxSteps);
  const stepsOmitted = evidence.trajectory.length - retained.length;

  let charsOmitted = 0;
  const steps: CompactStep[] = retained.map((step) => {
    const { text, omitted } = clamp(step.content, policy.maxStepChars);
    charsOmitted += omitted;
    const compact: CompactStep = {
      index: step.index,
      kind: step.kind,
      content: text,
      charsOmitted: omitted,
    };
    // Preserve the undefined/null distinction: only copy what the source carried.
    if ('role' in step) compact.role = step.role;
    if ('name' in step) compact.name = step.name;
    return compact;
  });

  const view: CompactJudgeView = {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    trialKey: identity.trialKey,
    subjectKey: identity.subjectKey,
    derivedFrom: manifest.rootHash,
    viewHash: '',
    policy,
    steps,
    stepsOmitted,
    charsOmitted: 0,
    complete: false,
    artifacts: evidence.artifacts
      .map((a) => ({ id: a.id, mediaType: a.mediaType, bytes: a.bytes, sha256: a.sha256 }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    privacy: evidence.privacy,
  };

  if ('environment' in evidence) view.environment = evidence.environment;

  if (evidence.submission === undefined) {
    // not recorded — leave the key absent
  } else if (evidence.submission === null) {
    view.submission = null;
  } else {
    const { text, omitted } = clamp(evidence.submission, policy.maxSubmissionChars);
    charsOmitted += omitted;
    view.submission = text;
  }

  if (evidence.rawGraderOutput === undefined) {
    // not recorded — leave the key absent
  } else if (evidence.rawGraderOutput === null) {
    view.graderOutput = null;
  } else {
    const { text, omitted } = clamp(evidence.rawGraderOutput, policy.maxGraderOutputChars);
    charsOmitted += omitted;
    view.graderOutput = text;
  }

  view.charsOmitted = charsOmitted;
  view.complete = stepsOmitted === 0 && charsOmitted === 0;
  view.viewHash = hashJudgeView(view);
  return view;
}

/**
 * Hash a view's content under the domain tag.
 *
 * `viewHash` itself is excluded from the input (it is the output), so the hash of
 * a re-derived view is directly comparable to a stored one.
 */
export function hashJudgeView(view: CompactJudgeView): string {
  const { viewHash: _ignored, ...content } = view;
  return createHash('sha256')
    .update(`${JUDGE_VIEW_DOMAIN}\n${canonicalJson(content)}`, 'utf8')
    .digest('hex');
}

/** Why a stored judge view was refused. */
export type JudgeViewFailureKind =
  | 'view-hash-mismatch'
  | 'evidence-mismatch'
  | 'trial-mismatch'
  | 'contract-version-mismatch';

/** The verdict on a stored judge view. */
export interface JudgeViewVerification {
  ok: boolean;
  failures: { kind: JudgeViewFailureKind; expected: string; actual: string }[];
  /** True when the view declares it dropped content — not a failure, but never silent. */
  truncated: boolean;
}

/**
 * Check a stored judge view against the evidence and trial it claims to describe.
 *
 * Catches the three ways a stored view can be wrong: its own content was altered
 * (`view-hash-mismatch`), it was derived from different evidence
 * (`evidence-mismatch`), or it belongs to a different trial (`trial-mismatch`).
 * A contract-version difference is reported too, because a view built under an
 * older field shape is not comparable to one built under the current shape.
 */
export function verifyJudgeView(
  view: CompactJudgeView,
  trial: EvaluationTrial,
  manifest: EvidenceManifest,
): JudgeViewVerification {
  const failures: JudgeViewVerification['failures'] = [];

  const recomputed = hashJudgeView(view);
  if (recomputed !== view.viewHash) {
    failures.push({ kind: 'view-hash-mismatch', expected: view.viewHash, actual: recomputed });
  }
  if (view.derivedFrom !== manifest.rootHash) {
    failures.push({ kind: 'evidence-mismatch', expected: view.derivedFrom, actual: manifest.rootHash });
  }
  const identity = computeTrialIdentity(trial);
  if (view.trialKey !== identity.trialKey) {
    failures.push({ kind: 'trial-mismatch', expected: view.trialKey, actual: identity.trialKey });
  }
  if (view.contractVersion !== EVALUATION_TRIAL_CONTRACT_VERSION) {
    failures.push({
      kind: 'contract-version-mismatch',
      expected: view.contractVersion,
      actual: EVALUATION_TRIAL_CONTRACT_VERSION,
    });
  }

  return { ok: failures.length === 0, failures, truncated: !view.complete };
}
