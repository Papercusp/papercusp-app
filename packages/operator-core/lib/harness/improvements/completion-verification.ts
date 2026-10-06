/**
 * P-007 Phase C (unified-bug-pipeline-and-honest-queue-2026-10-05, D-028): a completion
 * that landed `proposed` on an item that still blocks live work spawns ONE completion
 * verification task. The task gates the dependents through ordinary `blocks` edges, so
 * every existing dependency reader holds them without any change to what "satisfied"
 * means. A verifier who is not the closer closes the task with a verdict: accept lets the
 * dependents proceed; reject reopens the subject to its closer, whose own edges then hold
 * the dependents again. Settlement that upgrades the subject's authority accepts an open
 * task on the verifier's behalf, so nobody spends a turn re-verifying qualifying evidence.
 *
 * Reuse: the task is a plain `task` row carrying the D-021 verification block
 * (`createVerificationTask`, check 'completion'), sealed by the allowlisted
 * `completion-verification` policy (agent-review-policy.ts); edges go through
 * `linkIssue` → `mutateWorkItemDependencies`. Nothing here is a new table or scheduler.
 */
import {
  COMPLETION_VERIFICATION_POLICY,
  createImplementationReadiness,
  createVerificationTask,
  readVerificationTask,
  sealImplementationAcceptance,
  type VerificationTask,
} from './agent-review-policy';

export const COMPLETION_VERIFICATION_SCHEMA_VERSION = 'completion-verification-v1' as const;
/** The system actor that files the task and seals its acceptance. */
export const COMPLETION_VERIFICATION_ACTOR = 'system:completion-verification' as const;
/** The system actor that accepts an open task when settlement upgrades the subject. */
export const COMPLETION_SETTLEMENT_ACTOR = 'system:completion-settlement' as const;
export const COMPLETION_VERIFICATION_VERDICTS = ['accept', 'reject'] as const;
export type CompletionVerificationVerdict = (typeof COMPLETION_VERIFICATION_VERDICTS)[number];

export interface CompletionVerificationRecord {
  readonly schemaVersion: typeof COMPLETION_VERIFICATION_SCHEMA_VERSION;
  readonly subject: string;
  readonly closer: string;
  readonly proposedAt: string;
}

/** A non-terminal row the subject blocks, as stored on the edge. */
export interface LiveDependent {
  readonly kind: string;
  readonly ref: string;
}

export interface CompletionSubject {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  /** The closer: `terminal_owner` after the proposed close. */
  readonly closer: string;
  readonly harness?: string;
}

export interface CompletionVerificationDeps {
  liveDependents(subjectId: string): Promise<LiveDependent[]>;
  /** The open completion task for the subject, if one already exists. */
  findOpenTask(subjectId: string): Promise<{ id: string } | null>;
  createTask(input: { title: string; body: string; payload: Record<string, unknown>; harness?: string }): Promise<{ id: string }>;
  /** Adds `taskId` as a 'success' blocker of the dependent. Throws when the graph refuses it. */
  addBlockingEdge(taskId: string, dependent: LiveDependent): Promise<void>;
  now(): Date;
}

export type SpawnCompletionVerificationResult =
  | { outcome: 'no-dependents' }
  | { outcome: 'refused'; reason: string }
  | {
      outcome: 'created' | 'reused';
      taskId: string;
      gated: string[];
      /** Dependents the graph refused (an already-active dependant cannot gain a new blocker). */
      notGated: Array<{ ref: string; reason: string }>;
    };

/** The verification block plus the completion record a completion task carries. */
export function completionVerificationPayload(subject: CompletionSubject, proposedAt: string) {
  const verification: VerificationTask = createVerificationTask({
    subject: subject.id,
    check: 'completion',
    reporters: [],
    implementers: [subject.closer],
  });
  const completionVerification: CompletionVerificationRecord = {
    schemaVersion: COMPLETION_VERIFICATION_SCHEMA_VERSION,
    subject: subject.id,
    closer: subject.closer,
    proposedAt,
  };
  return { verification, completionVerification };
}

function taskText(subject: CompletionSubject) {
  const title = `Verify completion of ${subject.id}: ${subject.title}`.slice(0, 240);
  const body =
    `${subject.id} was closed by ${subject.closer} with completion authority 'proposed', and it still blocks live work. ` +
    `Verify the recorded completion against the item, then close this task with ` +
    `completion.verificationVerdict { verdict: 'accept' } or { verdict: 'reject', reason }. ` +
    `Accept releases the dependents; reject reopens ${subject.id} to ${subject.closer}. ` +
    `The closer cannot verify their own completion.`;
  return { title, body };
}

/**
 * The full payload for a new completion task: verification block, completion record and
 * a ready readiness document whose acceptance is sealed by the completion policy. Refuses
 * (never defaults) when the seal refuses.
 */
export function buildCompletionTaskPayload(
  subject: CompletionSubject,
  now: Date,
): { ok: true; title: string; body: string; payload: Record<string, unknown> } | { ok: false; reason: string } {
  const at = now.toISOString();
  const { title, body } = taskText(subject);
  const blocks = completionVerificationPayload(subject, at);
  const sealed = sealImplementationAcceptance({
    proposal: {
      problem: `Completion of ${subject.id} landed 'proposed' while it blocks live work.`,
      evidence: [`${subject.id} completion record (closer ${subject.closer}, ${at})`],
      outcome: `${subject.id}'s completion is accepted or the item is reopened to its closer.`,
      scope: `Verify the recorded completion of ${subject.id} only.`,
      completionCheck: `This task is closed with completion.verificationVerdict accept, or reject with a reason.`,
    },
    authority: { kind: 'policy', policy: COMPLETION_VERIFICATION_POLICY, actor: COMPLETION_VERIFICATION_ACTOR },
    reason: 'completion-verification',
    source: { kind: 'task', title, summary: body },
    acceptedAt: at,
    rowPayload: { verification: blocks.verification },
  });
  if (!sealed.ok) return { ok: false, reason: `acceptance seal refused: ${sealed.refusal}` };
  const implementationReadiness = createImplementationReadiness({
    status: 'ready',
    source: 'capture-policy',
    reason: 'completion-verification',
    updatedAt: at,
    evidence: { acceptance: sealed.contract },
  });
  return { ok: true, title, body, payload: { ...blocks, implementationReadiness } };
}

/**
 * Spawn (or reuse) the completion task for a subject that just closed `proposed`. Without
 * live dependents nothing is gated, so no task is created. Idempotent per subject: an open
 * task is reused and only missing edges are added (edge inserts are DO NOTHING).
 */
export async function spawnCompletionVerification(
  subject: CompletionSubject,
  deps: CompletionVerificationDeps,
): Promise<SpawnCompletionVerificationResult> {
  if (!subject.closer.trim()) return { outcome: 'refused', reason: 'the close recorded no terminal owner, so no verifier can be excluded' };
  const dependents = (await deps.liveDependents(subject.id)).filter((d) => d.ref !== subject.id);
  if (dependents.length === 0) return { outcome: 'no-dependents' };
  let taskId: string;
  let outcome: 'created' | 'reused';
  const existing = await deps.findOpenTask(subject.id);
  if (existing) {
    taskId = existing.id;
    outcome = 'reused';
  } else {
    const built = buildCompletionTaskPayload(subject, deps.now());
    if (!built.ok) return { outcome: 'refused', reason: built.reason };
    taskId = (await deps.createTask({ title: built.title, body: built.body, payload: built.payload, harness: subject.harness })).id;
    outcome = 'created';
  }
  const gated: string[] = [];
  const notGated: Array<{ ref: string; reason: string }> = [];
  for (const dependent of dependents) {
    try {
      await deps.addBlockingEdge(taskId, dependent);
      gated.push(dependent.ref);
    } catch (error) {
      notGated.push({ ref: dependent.ref, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { outcome, taskId, gated, notGated };
}

/** The verdict a closer of a completion task must supply, read from the completion record. */
export function readCompletionVerdict(
  completion: unknown,
): { verdict: CompletionVerificationVerdict; reason?: string } | null {
  if (!completion || typeof completion !== 'object') return null;
  const raw = (completion as Record<string, unknown>).verificationVerdict;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const verdict = (raw as Record<string, unknown>).verdict;
  if (verdict !== 'accept' && verdict !== 'reject') return null;
  const reason = (raw as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? { verdict, reason: reason.trim() } : { verdict };
}

/**
 * The verdict door (D-028 §5). A terminal close of a completion task needs a verdict, and a
 * reject needs a reason. Returns the refusal text, or null when the close may proceed.
 * Rows that are not completion tasks are never affected.
 */
export function completionVerdictRefusal(input: {
  payload: unknown;
  completion: unknown;
  terminal: boolean;
}): string | null {
  if (!input.terminal) return null;
  const task = readVerificationTask(input.payload);
  if (task?.check !== 'completion') return null;
  const verdict = readCompletionVerdict(input.completion);
  if (!verdict) {
    return (
      `this is a completion verification task for ${task.subject}: a terminal close requires ` +
      `completion.verificationVerdict { verdict: 'accept' } or { verdict: 'reject', reason }`
    );
  }
  if (verdict.verdict === 'reject' && !verdict.reason) {
    return `a reject verdict on the completion of ${task.subject} requires completion.verificationVerdict.reason`;
  }
  return null;
}

export interface CompletionVerdictDeps {
  /** Reopen the subject: non-terminal, terminal stamps cleared, held by `closer`. */
  reopenSubject(subjectId: string, closer: string, by: string): Promise<void>;
  comment(subjectId: string, body: string, by: string): Promise<void>;
}

/**
 * Apply a recorded verdict after the task's terminal close landed. Accept needs no write:
 * the task's done state satisfies its edges. Reject reopens the subject to its closer.
 */
export async function applyCompletionVerdict(
  input: { taskPayload: unknown; completion: unknown; verifier: string },
  deps: CompletionVerdictDeps,
): Promise<{ applied: 'accept' | 'reject'; subject: string } | null> {
  const task = readVerificationTask(input.taskPayload);
  if (task?.check !== 'completion') return null;
  const verdict = readCompletionVerdict(input.completion);
  if (!verdict) return null;
  if (verdict.verdict === 'accept') return { applied: 'accept', subject: task.subject };
  const closer = readCompletionRecord(input.taskPayload)?.closer ?? task.implementers[0];
  if (!closer) throw new Error(`completion task for ${task.subject} records no closer to reopen it to`);
  await deps.reopenSubject(task.subject, closer, input.verifier);
  await deps.comment(
    task.subject,
    `Completion verification REJECTED by ${input.verifier}: ${verdict.reason ?? '(no reason)'}. Reopened to ${closer}.`,
    input.verifier,
  );
  return { applied: 'reject', subject: task.subject };
}

export function readCompletionRecord(payload: unknown): CompletionVerificationRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const stored = (payload as Record<string, unknown>).completionVerification;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const r = stored as Record<string, unknown>;
  if (r.schemaVersion !== COMPLETION_VERIFICATION_SCHEMA_VERSION) return null;
  if (typeof r.subject !== 'string' || typeof r.closer !== 'string' || typeof r.proposedAt !== 'string') return null;
  return { schemaVersion: COMPLETION_VERIFICATION_SCHEMA_VERSION, subject: r.subject, closer: r.closer, proposedAt: r.proposedAt };
}

export interface CompletionSettlementDeps {
  findOpenTask(subjectId: string): Promise<{ id: string } | null>;
  /** Close the task done as `COMPLETION_SETTLEMENT_ACTOR` with an accept verdict recorded. */
  closeAccepted(taskId: string, subjectId: string, authority: string): Promise<void>;
}

/** D-028 §6: settlement upgraded the subject to a qualifying authority — accept any open task. */
export async function acceptCompletionOnSettlement(
  input: { subjectId: string; authority: string },
  deps: CompletionSettlementDeps,
): Promise<{ accepted: string } | null> {
  if (input.authority === 'proposed') return null;
  const open = await deps.findOpenTask(input.subjectId);
  if (!open) return null;
  await deps.closeAccepted(open.id, input.subjectId, input.authority);
  return { accepted: open.id };
}
