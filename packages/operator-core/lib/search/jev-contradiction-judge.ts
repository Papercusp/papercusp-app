/**
 * Jev-backed doc-contradiction judge (plan jev-decision-model-integration-2026-09-29,
 * P-010, decision D-017).
 *
 * The same `ContradictionJudgeFn` contract as the Anthropic judge in
 * doc-contradiction-scan.ts, answered by one Jev request per overlapping pair:
 * passage A travels in `state`, and one three-way choice question carries passage B
 * in its instructions (the `instructions` encoding D-013 found robust).
 *
 *   opposite-instructions  following A and following B lead to incompatible actions
 *                          in a situation both cover (the finding)
 *   compatible             same subject, both can be followed (redundant, more
 *                          specific, different emphasis, or different situations)
 *   unrelated              the overlap is only shared wording
 *
 * A pair is a contradiction when P(opposite-instructions) >= JEV_CONTRADICTION_MIN_P,
 * fixed in D-017 before any measurement.
 *
 * ⚠ The discipline inherited from doc-contradiction-judge.ts: every failure (an
 * inconclusive outcome, a malformed answer, a thrown error) returns `null`, which
 * `judgeContradictions` counts as a judge error. It is never `{ contradicts: false }`,
 * because a "no" from a judge that did not answer reads exactly like a clean pair.
 *
 * Jev emits no text, so a finding's `reason` is built deterministically from the
 * answering model id and the probability. It does not name the opposed instruction
 * the way the Anthropic judge's reason does; the resolution note shows both passages.
 */
import type { ChoiceQuestion, DecisionClient, DecisionOutcome, DecisionRequest, QuestionMap } from '@papercusp/decision-model';

import type { ContradictionJudgeFn, JudgeSection } from './doc-contradiction-judge';

/** Ledger consumer label for scan calls (the bench uses `doc-contradiction-bench`). */
export const JEV_CONTRADICTION_CONSUMER = 'doc-contradiction';

export const JEV_CONTRADICTION_LABELS = ['opposite-instructions', 'compatible', 'unrelated'] as const;
export type JevContradictionLabel = (typeof JEV_CONTRADICTION_LABELS)[number];

/** Flag threshold on P(opposite-instructions). Fixed in D-017; do not tune it on the sample. */
export const JEV_CONTRADICTION_MIN_P = 0.5;

/**
 * Per-call deadline. The scan is a background job, not a turn or a write, and doc
 * sections are longer than memories, so this is looser than the conflict judge's 3 s.
 */
export const JEV_CONTRADICTION_TIMEOUT_MS = 10_000;

export const CONTRADICTION_QUESTION_ID = 'relation';

export const CONTRADICTION_INSTRUCTIONS =
  'Two passages from an engineering documentation corpus overlap in wording. Passage A is ' +
  'state.passage_a; passage B is below. Would an agent following passage A and an agent ' +
  'following passage B do different, incompatible things in a situation both passages cover?';

export const CONTRADICTION_OPTIONS: Readonly<Record<JevContradictionLabel, string>> = {
  'opposite-instructions':
    'In a situation both passages cover, following A and following B lead to different, incompatible actions.',
  compatible:
    'Same subject, and an agent can follow both: they repeat each other, differ in emphasis or detail, one is more specific, or they address different situations.',
  unrelated:
    'Different subjects: the overlap is only shared wording, so neither passage bears on what the other tells an agent to do.',
};

/** ONE request per pair: A in state, B inside the question. */
export function buildContradictionRequest(a: JudgeSection, b: JudgeSection): DecisionRequest<QuestionMap> {
  const question: ChoiceQuestion<JevContradictionLabel> = {
    type: 'choice',
    instructions: `${CONTRADICTION_INSTRUCTIONS}\n\nPassage B (${b.title}):\n${b.content}`,
    options: CONTRADICTION_OPTIONS,
  };
  return {
    state: { passage_a: { title: a.title, content: a.content } },
    questions: { [CONTRADICTION_QUESTION_ID]: question },
  };
}

export interface ContradictionJudgement {
  /** The highest-probability label. */
  readonly label: JevContradictionLabel;
  /** P(label) for the chosen label. */
  readonly p: number;
  readonly pOpposite: number;
  readonly probabilities: Readonly<Record<JevContradictionLabel, number>>;
  readonly model: string;
}

function isLabel(v: unknown): v is JevContradictionLabel {
  return typeof v === 'string' && (JEV_CONTRADICTION_LABELS as readonly string[]).includes(v);
}

/**
 * Parse an outcome. An inconclusive outcome, or an answer that is missing, not a
 * choice, or lacks a finite probability for every label, yields `{ failure }`.
 */
export function contradictionJudgement(
  outcome: DecisionOutcome<QuestionMap>,
): ContradictionJudgement | { readonly failure: string } {
  if (outcome.kind === 'inconclusive') return { failure: outcome.reason };
  const answer = (outcome.answers as Readonly<Record<string, { type?: unknown; choice?: unknown; probabilities?: unknown }>>)[
    CONTRADICTION_QUESTION_ID
  ];
  if (!answer || answer.type !== 'choice' || !isLabel(answer.choice)) return { failure: 'malformed-response' };
  const raw = answer.probabilities as Readonly<Record<string, unknown>> | undefined;
  if (!raw || typeof raw !== 'object') return { failure: 'malformed-response' };
  const probabilities = {} as Record<JevContradictionLabel, number>;
  for (const label of JEV_CONTRADICTION_LABELS) {
    const p = raw[label];
    if (typeof p !== 'number' || !Number.isFinite(p)) return { failure: 'malformed-response' };
    probabilities[label] = p;
  }
  return {
    label: answer.choice,
    p: probabilities[answer.choice],
    pOpposite: probabilities['opposite-instructions'],
    probabilities,
    model: outcome.model,
  };
}

/** Whether a judgement is a contradiction finding (decision D-017). */
export function isContradictionJudgement(j: ContradictionJudgement): boolean {
  return j.pOpposite >= JEV_CONTRADICTION_MIN_P;
}

/** Deterministic finding text, so a filed finding can be traced to its ledger row. */
export function contradictionReason(pOpposite: number, model: string): string {
  return `${model} judged that these passages instruct opposite actions in a situation both cover (P=${pOpposite.toFixed(2)}).`;
}

export interface JevContradictionJudgeDeps {
  /** The process-wide decision client (ensureJevDecisionClient in production). */
  readonly client: () => DecisionClient;
  readonly consumer?: string;
  readonly timeoutMs?: number;
}

/** Thrown for an unusable Jev answer; the adapter turns it into `null`. */
export class JevContradictionInconclusiveError extends Error {
  constructor(readonly reason: string) {
    super(`Jev contradiction judge inconclusive: ${reason}`);
    this.name = 'JevContradictionInconclusiveError';
  }
}

/** The full judgement for one ordered pair (the bench reads every label). */
export async function judgeContradictionWithJev(
  input: { readonly a: JudgeSection; readonly b: JudgeSection },
  deps: JevContradictionJudgeDeps,
): Promise<ContradictionJudgement> {
  if (!input.a.content.trim() || !input.b.content.trim()) throw new JevContradictionInconclusiveError('empty-passage');
  const outcome = await deps.client().decide(buildContradictionRequest(input.a, input.b), {
    consumer: deps.consumer ?? JEV_CONTRADICTION_CONSUMER,
    timeoutMs: deps.timeoutMs ?? JEV_CONTRADICTION_TIMEOUT_MS,
    subjectIds: [input.a.id, input.b.id],
  });
  const parsed = contradictionJudgement(outcome);
  if ('failure' in parsed) throw new JevContradictionInconclusiveError(parsed.failure);
  return parsed;
}

/** The `ContradictionJudgeFn` adapter. Any failure is `null`, never a "no". */
export function createJevContradictionJudge(deps: JevContradictionJudgeDeps): ContradictionJudgeFn {
  return async ({ a, b }) => {
    try {
      const j = await judgeContradictionWithJev({ a, b }, deps);
      const contradicts = isContradictionJudgement(j);
      return { contradicts, reason: contradicts ? contradictionReason(j.pOpposite, j.model) : '' };
    } catch {
      return null;
    }
  };
}
