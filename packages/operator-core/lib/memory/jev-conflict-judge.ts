/**
 * Jev-backed memory conflict judge (plan jev-decision-model-integration-2026-09-29, P-009).
 *
 * The same `LlmJudge` contract as the Anthropic judge (conflict-check.ts), answered
 * by one Jev request per write: the new memory travels in `state`, and each
 * neighbour gets its own four-way choice question (contradicts / duplicates /
 * refines / unrelated) carrying that neighbour's text. Keeping each neighbour inside
 * its own question is the `instructions` encoding P-015 measured as the robust one
 * for the admission question (decision D-013).
 *
 * Jev emits no text, so the report's `summary` is built deterministically from the
 * label, its probability and the answering model id.
 *
 * Only `contradicts` becomes a conflict, and only at P(contradicts) >= JEV_CONFLICT_MIN_P.
 * A conflict refuses the memory:remember write (the caller must supersede or force),
 * so this threshold is a precision choice, fixed before measuring (decision D-015).
 * The other labels are measured and recorded but drive nothing yet.
 *
 * Decision D-001: this is advisory hygiene. A wrong verdict costs a refused write
 * that the agent can resolve with supersede/force; nothing here grants authority.
 */
import type { ChoiceQuestion, DecisionClient, DecisionOutcome, DecisionRequest, QuestionMap } from '@papercusp/decision-model';
import type { ConflictReport, LlmJudge, NeighborMemory } from './conflict-check';

/** Ledger consumer label for write-path calls (the bench uses `memory-conflict-bench`). */
export const JEV_CONFLICT_CONSUMER = 'memory-conflict';

export const JEV_CONFLICT_LABELS = ['contradicts', 'duplicates', 'refines', 'unrelated'] as const;
export type JevConflictLabel = (typeof JEV_CONFLICT_LABELS)[number];

/**
 * A neighbour is a conflict when P(contradicts) reaches this. Fixed before the
 * P-009 measurement (D-015); do not tune it on the labelled sample.
 */
export const JEV_CONFLICT_MIN_P = 0.5;

/**
 * Write-path deadline. The Anthropic judge allowed 5 s; the push path allows Jev
 * 400 ms because it blocks a turn. A write is not a turn, so this sits between.
 */
export const JEV_CONFLICT_TIMEOUT_MS = 3000;

export const CONFLICT_INSTRUCTIONS =
  'How does the new memory (state.new_memory) relate to the existing memory below? ' +
  'Judge only what the two statements claim about the same subject.';

export const CONFLICT_OPTIONS: Readonly<Record<JevConflictLabel, string>> = {
  contradicts: 'Both cannot be true at the same time about the same subject.',
  duplicates: 'They state the same fact; the new memory adds nothing.',
  refines:
    'Same subject and compatible: the new memory adds detail to, narrows, or extends the existing one without contradicting it.',
  unrelated: 'Different subjects, or the same broad topic without either statement bearing on the other.',
};

/** Stable question id for the i-th neighbour (retrieval order). */
export function conflictQuestionId(index: number): string {
  return `n${index + 1}`;
}

export interface ConflictRequest {
  readonly request: DecisionRequest<QuestionMap>;
  /** Index-aligned with the neighbours. */
  readonly questionIds: readonly string[];
}

/** ONE request per write, one choice question per neighbour. */
export function buildConflictRequest(newText: string, neighbors: readonly { readonly text: string }[]): ConflictRequest {
  if (neighbors.length === 0) throw new Error('buildConflictRequest: no neighbours to judge');
  const questionIds = neighbors.map((_, i) => conflictQuestionId(i));
  const questions: Record<string, ChoiceQuestion<JevConflictLabel>> = {};
  neighbors.forEach((n, i) => {
    questions[questionIds[i]] = {
      type: 'choice',
      instructions: `${CONFLICT_INSTRUCTIONS}\n\nExisting memory:\n${n.text}`,
      options: CONFLICT_OPTIONS,
    };
  });
  return { request: { state: { new_memory: newText }, questions }, questionIds };
}

export interface ConflictVerdict {
  /** The highest-probability label. */
  readonly label: JevConflictLabel;
  /** P(label) for the chosen label. */
  readonly p: number;
  readonly pContradicts: number;
  readonly probabilities: Readonly<Record<JevConflictLabel, number>>;
}

function isLabel(v: unknown): v is JevConflictLabel {
  return typeof v === 'string' && (JEV_CONFLICT_LABELS as readonly string[]).includes(v);
}

/**
 * One verdict per question, index-aligned with `questionIds`. An inconclusive
 * outcome, or any answer that is missing, not a choice, or lacks a probability for
 * every label, yields `{ failure }` and never a partial list: the caller fails open
 * on the whole write.
 */
export function conflictVerdicts(
  outcome: DecisionOutcome<QuestionMap>,
  questionIds: readonly string[],
): { readonly verdicts: readonly ConflictVerdict[]; readonly model: string } | { readonly failure: string } {
  if (outcome.kind === 'inconclusive') return { failure: outcome.reason };
  const verdicts: ConflictVerdict[] = [];
  for (const id of questionIds) {
    const answer = (outcome.answers as Readonly<Record<string, { type?: unknown; choice?: unknown; probabilities?: unknown }>>)[id];
    if (!answer || answer.type !== 'choice' || !isLabel(answer.choice)) return { failure: 'malformed-response' };
    const raw = answer.probabilities as Readonly<Record<string, unknown>> | undefined;
    if (!raw || typeof raw !== 'object') return { failure: 'malformed-response' };
    const probabilities = {} as Record<JevConflictLabel, number>;
    for (const label of JEV_CONFLICT_LABELS) {
      const p = raw[label];
      if (typeof p !== 'number' || !Number.isFinite(p)) return { failure: 'malformed-response' };
      probabilities[label] = p;
    }
    verdicts.push({ label: answer.choice, p: probabilities[answer.choice], pContradicts: probabilities.contradicts, probabilities });
  }
  return { verdicts, model: outcome.model };
}

/** Whether a verdict becomes a conflict (decision D-015). */
export function isConflictVerdict(v: ConflictVerdict): boolean {
  return v.pContradicts >= JEV_CONFLICT_MIN_P;
}

const LABEL_PHRASE: Readonly<Record<JevConflictLabel, string>> = {
  contradicts: 'contradicts',
  duplicates: 'duplicates',
  refines: 'refines',
  unrelated: 'is unrelated to',
};

/**
 * Deterministic report text, since Jev emits none. Same inputs, same string, so a
 * refusal quoted in a transcript can be traced to its ledger row.
 */
export function conflictSummary(label: JevConflictLabel, p: number, model: string): string {
  return `${model} judged that the new memory ${LABEL_PHRASE[label]} this memory (P=${p.toFixed(2)}).`;
}

export interface JevConflictJudgeDeps {
  /** The process-wide decision client (ensureJevDecisionClient in production). */
  readonly client: () => DecisionClient;
  readonly consumer?: string;
  readonly timeoutMs?: number;
}

export interface JevConflictJudgement {
  readonly model: string;
  /** Index-aligned with the neighbours passed in; empty-text neighbours are `null`. */
  readonly verdicts: readonly (ConflictVerdict | null)[];
}

/** Thrown for an inconclusive Jev call; `checkConflicts` catches it and fails open. */
export class JevConflictInconclusiveError extends Error {
  constructor(readonly reason: string) {
    super(`Jev conflict judge inconclusive: ${reason}`);
    this.name = 'JevConflictInconclusiveError';
  }
}

/**
 * The full per-neighbour judgement (the bench reads every label). Throws
 * {@link JevConflictInconclusiveError} when Jev gives no usable answer.
 */
export async function judgeConflictsWithJev(
  input: { readonly newText: string; readonly neighbors: readonly NeighborMemory[] },
  deps: JevConflictJudgeDeps,
): Promise<JevConflictJudgement> {
  const asked = input.neighbors.map((n, i) => ({ n, i })).filter(({ n }) => n.text.trim().length > 0);
  if (asked.length === 0 || !input.newText.trim()) return { model: 'none', verdicts: input.neighbors.map(() => null) };
  const { request, questionIds } = buildConflictRequest(
    input.newText,
    asked.map(({ n }) => n),
  );
  const outcome = await deps.client().decide(request, {
    consumer: deps.consumer ?? JEV_CONFLICT_CONSUMER,
    timeoutMs: deps.timeoutMs ?? JEV_CONFLICT_TIMEOUT_MS,
    subjectIds: asked.map(({ n }) => n.id),
  });
  const parsed = conflictVerdicts(outcome, questionIds);
  if ('failure' in parsed) throw new JevConflictInconclusiveError(parsed.failure);
  const verdicts: (ConflictVerdict | null)[] = input.neighbors.map(() => null);
  asked.forEach(({ i }, k) => {
    verdicts[i] = parsed.verdicts[k];
  });
  return { model: parsed.model, verdicts };
}

/** The `LlmJudge` adapter: conflicts are the neighbours whose verdict passes {@link isConflictVerdict}. */
export function createJevConflictJudge(deps: JevConflictJudgeDeps): LlmJudge {
  return async ({ newText, neighbors }): Promise<ConflictReport> => {
    const { model, verdicts } = await judgeConflictsWithJev({ newText, neighbors }, deps);
    const conflicts: ConflictReport['conflicts'] = [];
    verdicts.forEach((v, i) => {
      if (v && isConflictVerdict(v)) {
        conflicts.push({ memory_id: neighbors[i].id, summary: conflictSummary('contradicts', v.pContradicts, model) });
      }
    });
    return { conflicts };
  };
}
