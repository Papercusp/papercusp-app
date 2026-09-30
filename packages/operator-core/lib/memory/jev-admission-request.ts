/**
 * The Jev memory-admission question (plan jev-decision-model-integration-2026-09-29).
 *
 * ONE definition, used by both the offline bench (bench/jev-admission.ts, P-004/P-005)
 * and the production push path (jev-memory-gate.ts, P-007/P-008). Production must
 * ask exactly the question the evaluation measured: a reworded instruction is a
 * different model input, and the D-012 numbers would no longer describe it. The
 * bench's grade-cache rubric version hashes RELEVANCE_INSTRUCTIONS and
 * RELEVANCE_CRITERIA, so a wording change here also invalidates cached grades.
 */
import type { DecisionOutcome, DecisionRequest, QuestionMap, YesNoQuestion } from '@papercusp/decision-model';

/**
 * Where the memory text travels. `state` puts every candidate in the shared
 * state and asks one question per id; `instructions` keeps only the message in
 * state and carries each memory inside its own question. P-005 compares the
 * two; P-004 runs `state` by default. P-015 re-runs both CLIs with
 * `--encoding instructions` as the primary encoding (decision D-012).
 */
export type AdmissionEncoding = 'state' | 'instructions';

/** Parses a CLI `--encoding` value; an absent flag means `state`, anything else unknown throws. */
export function parseAdmissionEncoding(raw: string | undefined): AdmissionEncoding {
  const v = raw ?? 'state';
  if (v !== 'state' && v !== 'instructions') throw new Error(`--encoding must be state|instructions, got ${v}`);
  return v;
}

/** The encoding a robustness run compares its primary encoding against. */
export function alternateEncoding(e: AdmissionEncoding): AdmissionEncoding {
  return e === 'state' ? 'instructions' : 'state';
}

export const RELEVANCE_INSTRUCTIONS =
  'Would this memory help respond to the message? Answer yes only when it is directly relevant to what the ' +
  'message asks about or is about to do. A memory that merely shares a word or a broad topic with the message ' +
  'is not relevant.';

export const RELEVANCE_CRITERIA = {
  yes: 'The memory is directly relevant to the message.',
  no: 'The memory is unrelated to the message, or related only by a shared word or a broad topic.',
} as const;

/** Stable question id for the i-th candidate (retrieval order). */
export function admissionQuestionId(index: number): string {
  return `m${index + 1}`;
}

export interface AdmissionRequest {
  readonly request: DecisionRequest<QuestionMap>;
  /** Index-aligned with the candidates. */
  readonly questionIds: readonly string[];
}

/** ONE request per query, one yes/no question per candidate (plan P-004). */
export function buildAdmissionRequest(
  message: string,
  candidates: readonly { readonly text: string }[],
  encoding: AdmissionEncoding = 'state',
): AdmissionRequest {
  if (candidates.length === 0) throw new Error('buildAdmissionRequest: no candidates to judge');
  const questionIds = candidates.map((_, i) => admissionQuestionId(i));
  const questions: Record<string, YesNoQuestion> = {};
  if (encoding === 'state') {
    const memories: Record<string, string> = {};
    candidates.forEach((c, i) => {
      memories[questionIds[i]] = c.text;
    });
    for (const id of questionIds) {
      questions[id] = {
        type: 'yesNo',
        instructions: `Consider only memories.${id}. ${RELEVANCE_INSTRUCTIONS}`,
        criteria: RELEVANCE_CRITERIA,
      };
    }
    return { request: { state: { message, memories }, questions }, questionIds };
  }
  candidates.forEach((c, i) => {
    questions[questionIds[i]] = {
      type: 'yesNo',
      instructions: `${RELEVANCE_INSTRUCTIONS}\n\nMemory:\n${c.text}`,
      criteria: RELEVANCE_CRITERIA,
    };
  });
  return { request: { state: { message }, questions }, questionIds };
}

/**
 * P(yes) per question, index-aligned with `questionIds`. An inconclusive outcome, or
 * an answer that is missing or not a yes/no probability, yields `{ failure }` and
 * never a partial score list: the caller must fail open on the whole query.
 */
export function admissionPYes(
  outcome: DecisionOutcome<QuestionMap>,
  questionIds: readonly string[],
): { readonly scores: readonly number[] } | { readonly failure: string } {
  if (outcome.kind === 'inconclusive') return { failure: outcome.reason };
  const scores: number[] = [];
  for (const id of questionIds) {
    const answer = (outcome.answers as Readonly<Record<string, { type: string; pYes?: number }>>)[id];
    if (!answer || answer.type !== 'yesNo' || typeof answer.pYes !== 'number') return { failure: 'malformed-response' };
    scores.push(answer.pYes);
  }
  return { scores };
}
