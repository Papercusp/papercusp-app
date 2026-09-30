/**
 * Detect completion claims whose named artifacts are absent from the sender's
 * session-derived `basedOn` trace.
 *
 * This is deliberately an additive send-time stamp, not a refusal. The trace
 * already records what the sender read; this helper only compares that fact
 * with the explicit artifact names in a completion-shaped message. A reader
 * can then see the contradiction without having to rediscover it from the
 * sender's session.
 */

import type { BasedOnEntry, MessageSection } from './message-fields';

export const COMPLETION_CLAIM_MISMATCH_FIELD = 'completionClaimMismatch';

export interface CompletionClaimMismatchStamp {
  kind: 'unread-artifact';
  /** Artifact refs named by the sender, in first-seen order. */
  declaredRefs: string[];
  /** Declared refs with no equivalent entry in `basedOn`. */
  missingFromBasedOn: string[];
  note: 'claims completion on artifacts this session never read';
}

export interface CompletionClaimInput {
  summary?: string;
  body?: string | readonly Pick<MessageSection, 'text' | 'premises'>[];
  planSlug?: string;
  basedOn?: readonly Pick<BasedOnEntry, 'ref'>[];
}

const WORK_ITEM_REF = /\b((?:WI|EI)-\d+)\b/gi;
const PLAN_TOKEN = /\bplan:([a-z0-9][a-z0-9-]*)/gi;
const PLAN_LABEL = /\bplan(?:_slug)?\s*[:=]\s*[`'\"]?([a-z0-9][a-z0-9-]*)/gi;
const PLAN_QUOTED = /\bplan\b[^`'\"\n]{0,24}[`'\"]([a-z0-9][a-z0-9-]*)[`'\"]/gi;
const RUBRIC_REF = /\brubricRef\s*[:=]\s*[`'\"]?([a-z0-9][a-z0-9-]*)/gi;
const RUBRIC_QUOTED = /\brubric\b[^`'\"\n]{0,24}[`'\"]([a-z0-9][a-z0-9-]*)[`'\"]/gi;
const COMPLETION_WORD =
  /\b(?:completed?|finished|shipped|verified?|accepted?|graded?|passed|resolved|closed|delivered)\b/gi;
const NEGATION_TAIL = /\b(?:not|never|no|without|didn['’]t|doesn['’]t|isn['’t|wasn['’t|weren['’t|cannot|can['’]t)\s*$/i;
const FUTURE_MARKER =
  /\b(?:will|shall|would|could|should|may|might|can|going\s+to|planning\s+to|plan(?:s|ned|ning)?\s+to|intend(?:s|ed|ing)?\s+to|next|up\s+next|later|after\s+this|then\s+(?:i\s+)?(?:will|shall|read|reconcile|inspect|review|checkpoint|investigate|verify|check|examine|validate|run|fix|update|write|record))\b/i;
const PROSPECTIVE_INTENT = /\b(?:read-only|this\s+unit|this\s+pass|upcoming|follow-up|future|reconciliation|checkpointing)\b/i;

function slug(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.,;:)\]}]+$/, '');
  return /^[a-z0-9][a-z0-9-]*-[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

function addRef(out: string[], seen: Set<string>, ref: string): void {
  if (seen.has(ref)) return;
  seen.add(ref);
  out.push(ref);
}

function collectMatches(
  text: string,
  re: RegExp,
  map: (match: RegExpExecArray) => string | null,
  out: string[],
  seen: Set<string>,
  skip?: (match: RegExpExecArray) => boolean,
): void {
  re.lastIndex = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (skip?.(match)) continue;
    const ref = map(match);
    if (ref) addRef(out, seen, ref);
  }
}

function textOf(input: CompletionClaimInput): string {
  const body = Array.isArray(input.body)
    ? input.body
        .map((section) => [section.text, ...(section.premises ?? [])]
          .filter((value): value is string => typeof value === 'string')
          .join(' '))
        .join('\n')
    : (input.body ?? '');
  return [input.summary ?? '', body].filter(Boolean).join('\n');
}

function hasPositiveCompletionClaim(text: string): boolean {
  COMPLETION_WORD.lastIndex = 0;
  for (let match = COMPLETION_WORD.exec(text); match; match = COMPLETION_WORD.exec(text)) {
    // A completion verb can itself be a plan/rubric slug component
    // (`plan:shipped-feature`, `verified-change`). Treat those identifier
    // fragments as artifact names, not as a second positive claim that can
    // defeat negation on the surrounding sentence.
    const beforeChar = text[match.index - 1];
    const afterChar = text[match.index + match[0].length];
    if (beforeChar === '-' || afterChar === '-') continue;
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!NEGATION_TAIL.test(before)) return true;
  }
  return false;
}

function collectExplicitPremises(input: CompletionClaimInput, out: string[], seen: Set<string>): void {
  if (!Array.isArray(input.body)) return;
  for (const section of input.body) {
    for (const premise of section.premises ?? []) {
      const workItem = /^(?:work-item:)?((?:WI|EI)-\d+)(?:#.*)?$/i.exec(premise.trim());
      if (workItem) {
        addRef(out, seen, `work-item:${workItem[1]!.toUpperCase()}`);
        continue;
      }
      const plan = /^plan:([a-z0-9][a-z0-9-]*)(?:#.*)?$/i.exec(premise.trim());
      if (plan) {
        addRef(out, seen, `plan:${plan[1]!.toLowerCase()}`);
        continue;
      }
      const planDecision = /^([a-z0-9][a-z0-9-]+)#(?:P|D)-\d+$/i.exec(premise.trim());
      if (planDecision) addRef(out, seen, `plan:${planDecision[1]!.toLowerCase()}`);
    }
  }
}

function isFutureIntentReference(text: string, index: number): boolean {
  let clauseStart = index;
  while (clauseStart > 0 && !/[.!?;\n]/.test(text[clauseStart - 1]!)) clauseStart -= 1;

  const beforeReference = text.slice(clauseStart, index);
  if (FUTURE_MARKER.test(beforeReference)) return true;

  // A present-tense hand-off such as "I am limiting this unit to fresh
  // read-only reconciliation of WI-…" is prospective even without a modal
  // verb. Keep an explicit completion verb as the stronger, past-tense signal
  // so "completed read-only reconciliation of WI-…" remains a claim.
  return PROSPECTIVE_INTENT.test(beforeReference) && !hasPositiveCompletionClaim(beforeReference);
}

function comparisonRef(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  // Rubrics are stored as rubric-template plans. `rubrics:get` therefore
  // contributes plan:<slug> to basedOn while the message keeps rubric:<slug>
  // as the more useful human-facing declaration.
  return trimmed.startsWith('rubric:') ? `plan:${trimmed.slice('rubric:'.length)}` : trimmed;
}

/**
 * Return the additive mismatch stamp, or undefined when the message is not a
 * positive completion claim or every named artifact is represented in basedOn.
 */
export function completionClaimMismatch(input: CompletionClaimInput): CompletionClaimMismatchStamp | undefined {
  const text = textOf(input);
  if (!hasPositiveCompletionClaim(text)) return undefined;

  const declaredRefs: string[] = [];
  const seen = new Set<string>();
  const skipFutureIntent = (match: RegExpExecArray): boolean => isFutureIntentReference(text, match.index);
  if (input.planSlug) {
    const plan = slug(input.planSlug);
    if (plan) addRef(declaredRefs, seen, `plan:${plan}`);
  }
  collectMatches(text, WORK_ITEM_REF, (match) => `work-item:${match[1]!.toUpperCase()}`, declaredRefs, seen, skipFutureIntent);
  collectMatches(text, PLAN_TOKEN, (match) => `plan:${match[1]!.toLowerCase()}`, declaredRefs, seen, skipFutureIntent);
  collectMatches(
    text,
    PLAN_LABEL,
    (match) => {
      const value = slug(match[1]!);
      return value ? `plan:${value}` : null;
    },
    declaredRefs,
    seen,
    skipFutureIntent,
  );
  collectMatches(
    text,
    PLAN_QUOTED,
    (match) => {
      const value = slug(match[1]!);
      return value ? `plan:${value}` : null;
    },
    declaredRefs,
    seen,
    skipFutureIntent,
  );
  collectMatches(
    text,
    RUBRIC_REF,
    (match) => {
      const value = slug(match[1]!);
      return value ? `rubric:${value}` : null;
    },
    declaredRefs,
    seen,
    skipFutureIntent,
  );
  collectMatches(
    text,
    RUBRIC_QUOTED,
    (match) => {
      const value = slug(match[1]!);
      return value ? `rubric:${value}` : null;
    },
    declaredRefs,
    seen,
    skipFutureIntent,
  );
  collectExplicitPremises(input, declaredRefs, seen);

  if (!declaredRefs.length) return undefined;
  const readRefs = new Set((input.basedOn ?? []).map((entry) => comparisonRef(entry.ref)));
  const missingFromBasedOn = declaredRefs.filter((ref) => !readRefs.has(comparisonRef(ref)));
  if (!missingFromBasedOn.length) return undefined;

  return {
    kind: 'unread-artifact',
    declaredRefs,
    missingFromBasedOn,
    note: 'claims completion on artifacts this session never read',
  };
}
