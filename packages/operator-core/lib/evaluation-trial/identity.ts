/**
 * Derived contract version + content-addressed trial identity (P-004).
 *
 * ## Why the identity is content-addressed
 *
 * P-001 (WI-41656) measured three different ways this tree binds a stored verdict
 * to its subject, and only one of them is sound: the P2P gate's
 * `(shard_id, inputs_hash)` pair, where `inputsHash` hashes the exact tree content
 * a shard depends on. Two shas with identical inputs share a hash (correct reuse);
 * any input change moves it (correct invalidation). The delta gate, by contrast,
 * is time-windowed — a seven-day-old green clears any candidate, because freshness
 * is not relevance.
 *
 * LLM evaluation cannot re-derive its verdict on demand (that means re-running a
 * model), so a *binding* is the only thing that can keep a stored LLM-eval verdict
 * honest. This module supplies exactly that binding, in the same shape and with
 * the same domain-separated, line-oriented canonical encoding `shardInputsHash`
 * uses, so the two mechanisms read alike.
 *
 * ## Why the canonical form is lines rather than `JSON.stringify`
 *
 * `deriveRubricVersion` (`@papercusp/testing-shell/llm`) deliberately hashes plain
 * `JSON.stringify` output, accepting that a key reorder moves the version. That is
 * the right trade for a rubric: its content is a literal in source, so key order is
 * stable in practice, and a spurious move only splits a trend line.
 *
 * A trial is different in kind: it is projected from PG rows and driver payloads
 * whose key order is NOT stable, so `JSON.stringify` would move the identity for
 * reasons that have nothing to do with the measurement. The line-oriented form
 * below fixes the order by construction — the field list is a frozen constant, not
 * whatever order an object literal happened to be built in.
 *
 * ## Unknown bindings fail toward SPLIT, never toward MERGE
 *
 * A binding field the source does not record (`undefined`) hashes as `?` and is
 * named in `missingBindings`, and the identity is marked `bindingComplete: false`.
 * `areComparable` refuses any incomplete identity outright, so two trials that
 * differ in an unrecorded field can never be pooled as if they matched. A field
 * the source records as genuinely absent (`null`) hashes as the distinct token
 * `~` and keeps the identity complete.
 *
 * That asymmetry is deliberate and matches the rubric-version rationale one layer
 * up: a spurious split is visible and recoverable, a spurious merge is invisible
 * and makes a broken comparison look sound.
 */

import { createHash } from 'node:crypto';

import type { EvaluationTrial } from './schema';

/** Domain-separation tag hashed into every trial binding (shardInputsHash idiom). */
export const EVALUATION_TRIAL_IDENTITY_DOMAIN = 'papercusp-evaluation-trial-identity-v1';

/** Label prefixed to the derived contract version, keeping stored values scannable. */
export const EVALUATION_TRIAL_CONTRACT_LABEL = 'evaluation-trial';

/** Hex digest characters kept in the derived contract version. */
const CONTRACT_VERSION_HASH_CHARS = 12;

/**
 * Token for a value the source does not record at all (`undefined`).
 *
 * Exported because P-005's evidence sealing must encode the same distinction over
 * the same tokens: two copies of this convention that drifted apart would let an
 * evidence hash and a binding hash disagree about what "empty" means, which is the
 * one disagreement neither mechanism could detect.
 */
export const NOT_RECORDED = '?';

/** Token for a value the source records as genuinely absent / not applicable (`null`). */
export const RECORDED_ABSENT = '~';

/**
 * The contract's field surface, as `path:kind` entries in sorted order.
 *
 * This is what the contract version is DERIVED from (D-014: a version that gates
 * comparability must be computed from the thing it identifies, never a literal
 * someone is expected to remember to bump). Adding, removing, renaming or
 * re-typing a field here moves `EVALUATION_TRIAL_CONTRACT_VERSION` by
 * construction.
 *
 * `evaluation-trial-contract-shape.test.ts` asserts this list matches the paths a
 * fully-populated trial actually carries, so the descriptor cannot silently drift
 * from the TypeScript types it claims to describe — which is the one failure this
 * whole derivation could not survive quietly.
 */
export const EVALUATION_TRIAL_CONTRACT_SHAPE: readonly string[] = Object.freeze([
  'configuration.arm:string',
  'configuration.budgets.agents:number',
  'configuration.budgets.breaches:string[]',
  'configuration.budgets.capped:boolean',
  'configuration.budgets.tokens:number',
  'configuration.budgets.usd:number',
  'configuration.budgets.wallClockMs:number',
  'configuration.configHash:string',
  'configuration.matrixIndex:number',
  'configuration.seed:number',
  'contractVersion:string',
  'evidence.artifactRefs:string[]',
  'evidence.contentHash:string',
  'evidence.privacy:PrivacyClass',
  'evidence.rawGraderOutputRef:string',
  'evidence.submissionRef:string',
  'evidence.trajectoryKind:string',
  'evidence.trajectoryRef:string',
  'finishedAt:string',
  'grader.family:string',
  'grader.judgeModel:string',
  'grader.kind:GraderKind',
  'grader.version:string',
  'lineage.groupId:string',
  'lineage.parentTrialKey:string',
  'lineage.repeat:number',
  'lineage.runId:string',
  'lineage.sourceRef:string',
  'outcome.errors:string[]',
  'outcome.infraFailure:boolean',
  'outcome.resolved:boolean',
  'outcome.score:number',
  'outcome.status:TrialStatus',
  'startedAt:string',
  'subject.corpus:string',
  'subject.family:TrialFamily',
  'subject.taskId:string',
  'subject.taskRevision:string',
  'system.environmentFingerprint:string',
  'system.harnessGitSha:string',
  'system.harnessVersion:string',
  'system.modelId:string',
  'system.modelVersion:string',
  'usage.costUsd:number',
  'usage.priceTableVersion:string',
  'usage.tokensCacheRead:number',
  'usage.tokensCacheWrite:number',
  'usage.tokensIn:number',
  'usage.tokensOut:number',
  'usage.tokensTotal:number',
  'usage.turns:number',
  'usage.wallClockMs:number',
]);

/**
 * The contract version, derived from the field shape above.
 *
 * Format `evaluation-trial.<sha12>`, mirroring `deriveRubricVersion`'s
 * `<label>.<sha12>` so a stored version is recognizable at a glance and two
 * contracts that happened to share a shape would still be distinguishable by
 * label.
 */
export const EVALUATION_TRIAL_CONTRACT_VERSION: string = `${EVALUATION_TRIAL_CONTRACT_LABEL}.${createHash(
  'sha256',
)
  .update(`${EVALUATION_TRIAL_IDENTITY_DOMAIN}\n${EVALUATION_TRIAL_CONTRACT_SHAPE.join('\n')}`, 'utf8')
  .digest('hex')
  .slice(0, CONTRACT_VERSION_HASH_CHARS)}`;

/**
 * The fields that decide whether two trials measured the SAME THING under the
 * SAME CONDITIONS. Frozen and sorted: the order here is the canonical order, so
 * the hash cannot move because an object was built differently.
 *
 * Outcome, usage, evidence, lineage and timestamps are deliberately excluded —
 * they are the measurement, not its subject. Including any of them would make
 * every trial its own identity and the mechanism inert.
 */
export const TRIAL_BINDING_FIELDS: readonly string[] = Object.freeze([
  'configuration.arm',
  'configuration.configHash',
  'configuration.matrixIndex',
  'configuration.seed',
  'grader.family',
  'grader.judgeModel',
  'grader.kind',
  'grader.version',
  'subject.corpus',
  'subject.family',
  'subject.taskId',
  'subject.taskRevision',
  'system.environmentFingerprint',
  'system.harnessGitSha',
  'system.harnessVersion',
  'system.modelId',
  'system.modelVersion',
]);

/** The identity of one trial: what it measured, under what conditions, and how sure we are. */
export interface TrialIdentity {
  /**
   * Identifies this trial EXECUTION — `<bindingHash12>:<runId>`. Two repeats of
   * the same binding share a binding hash and differ here.
   */
  trialKey: string;
  /** Human-scannable subject: `<family>/<corpus>/<taskId>@<taskRevision>`. */
  subjectKey: string;
  /** sha256 over the domain tag, the subject key, and every binding field. */
  bindingHash: string;
  /**
   * True only when every binding field was RECORDED by the source (a recorded
   * `null` counts; an unrecorded `undefined` does not). False means this trial's
   * comparability cannot be established, and `areComparable` will refuse it.
   */
  bindingComplete: boolean;
  /**
   * Binding fields the source surface does not record, in canonical order. This
   * is the actionable half of an incomplete identity: it names exactly what a
   * family must start recording before its verdicts can be compared.
   */
  missingBindings: string[];
}

/** Read a dotted path off a trial without widening anything to `any`. */
function readPath(trial: EvaluationTrial, path: string): unknown {
  let cursor: unknown = trial;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Encode one scalar as its canonical token, preserving the `undefined` vs `null`
 * distinction the whole contract rests on.
 *
 * Exported for P-005: evidence sealing hashes the same two empty values and must
 * encode them identically, so there is exactly one implementation of the rule.
 */
export function canonicalToken(value: unknown): string {
  if (value === undefined) return NOT_RECORDED;
  if (value === null) return RECORDED_ABSENT;
  // Binding values are scalars by construction (see TRIAL_BINDING_FIELDS); a
  // non-scalar would be a projection bug, so encode it visibly rather than
  // silently stringifying to `[object Object]`.
  if (typeof value === 'object') return `!nonscalar:${JSON.stringify(value)}`;
  return String(value);
}

/**
 * Compute a trial's content-addressed identity.
 *
 * Pure and deterministic: identical binding values always produce an identical
 * hash, regardless of how either trial object was constructed.
 */
export function computeTrialIdentity(trial: EvaluationTrial): TrialIdentity {
  const missingBindings: string[] = [];
  const lines: string[] = [];

  for (const field of TRIAL_BINDING_FIELDS) {
    const value = readPath(trial, field);
    if (value === undefined) missingBindings.push(field);
    lines.push(`${field}=${canonicalToken(value)}`);
  }

  const subjectKey =
    `${canonicalToken(trial.subject?.family)}/${canonicalToken(trial.subject?.corpus)}` +
    `/${canonicalToken(trial.subject?.taskId)}@${canonicalToken(trial.subject?.taskRevision)}`;

  const canonical = `${EVALUATION_TRIAL_IDENTITY_DOMAIN}\n${subjectKey}\n${lines.join('\n')}`;
  const bindingHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return {
    trialKey: `${bindingHash.slice(0, 12)}:${trial.lineage?.runId ?? NOT_RECORDED}`,
    subjectKey,
    bindingHash,
    bindingComplete: missingBindings.length === 0,
    missingBindings,
  };
}

/**
 * May these two trials be pooled, compared, or have one's verdict reused for the
 * other?
 *
 * Requires BOTH identities to be complete and their binding hashes to match. An
 * incomplete identity is refused even against an identical incomplete identity:
 * two trials that both fail to record their harness version are not thereby known
 * to share one, and treating them as comparable is the exact silent merge this
 * contract exists to prevent.
 */
export function areComparable(a: TrialIdentity, b: TrialIdentity): boolean {
  if (!a.bindingComplete || !b.bindingComplete) return false;
  return a.bindingHash === b.bindingHash;
}

/**
 * Why `areComparable` said no — for callers that must explain a refusal rather
 * than merely obey it.
 */
export function explainIncomparability(a: TrialIdentity, b: TrialIdentity): string | null {
  if (a.bindingComplete && b.bindingComplete && a.bindingHash === b.bindingHash) return null;
  const reasons: string[] = [];
  if (!a.bindingComplete) reasons.push(`left identity incomplete (missing: ${a.missingBindings.join(', ')})`);
  if (!b.bindingComplete) reasons.push(`right identity incomplete (missing: ${b.missingBindings.join(', ')})`);
  if (a.bindingComplete && b.bindingComplete && a.bindingHash !== b.bindingHash) {
    reasons.push(`binding hashes differ (${a.subjectKey} vs ${b.subjectKey})`);
  }
  return reasons.join('; ');
}
