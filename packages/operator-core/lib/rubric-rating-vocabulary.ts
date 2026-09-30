/**
 * Pure authoring-time validation for rubric rating instructions.
 *
 * A rubric's `ratingScale` is the vocabulary that scorecards:emit accepts. The
 * criterion procedure prose is authored separately, so it can accidentally tell a
 * grader to emit a different value (`Grade \`partial\`` on a
 * `healthy/degraded/broken/unknown` rubric). This module finds only explicit
 * grade/rating directives; ordinary prose that merely mentions a possible state
 * remains valid.
 */

export type RubricRatingInstructionField = 'method' | 'replication';

export interface RubricRatingVocabularyCriterion {
  key: string;
  method?: string;
  replication?: string;
  ratingScale?: readonly string[];
}

export interface RubricRatingInstruction {
  criterionKey: string;
  field: RubricRatingInstructionField;
  rating: string;
  /** The short authored-prose fragment containing the directive. */
  excerpt: string;
}

export interface RubricRatingVocabularyViolation extends RubricRatingInstruction {
  /** The effective scale for this criterion (criterion override or rubric default). */
  allowedRatings: string[];
}

export interface RubricRatingVocabularyValidation {
  ok: boolean;
  instructions: RubricRatingInstruction[];
  violations: RubricRatingVocabularyViolation[];
}

type ParsedDirective = {
  rating: string;
  end: number;
};

const DIRECTIVE_RE = /\b(grade|rate|rating)\b/gi;
const UNQUOTED_RATING_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*/;
const EXPLICIT_FOLLOWING_WORD_RE = /^(?:if|when|unless|because|for|where|on)\b/i;
const NON_RATING_DIRECTIVE_WORDS = new Set([
  'according',
  'around',
  'based',
  'by',
  'from',
  'instead',
  'limit',
  'of',
  'on',
  'relative',
  'scale',
  'the',
  'using',
  'value',
  'via',
  'with',
]);

// These are contextual objects, not score labels.  In particular, phrases such
// as "grade it on observed evidence" are instructions about the basis for a
// judgement, not requests to emit the literal rating "it".  Keeping this list
// narrow preserves the fail-closed behavior for real, unquoted labels.
const NON_RATING_TARGET_WORDS = new Set(['it', 'this', 'that', 'them', 'one', 'ones']);

// In an inspection procedure, "read the scorecard and grade lineage" names
// two things to read. The second noun phrase is not a command to emit a rating.
// Restrict this exception to metadata objects in the same inspection clause;
// a standalone "Grade lineage" (or a quoted rating) remains a directive.
const GRADE_METADATA_OBJECT_RE = /^(?:lineage|provenance|history|record|records|metadata)\b/i;
const INSPECTION_CONJUNCTION_RE = /\b(?:read|inspect|review|trace|verify|check|audit)\b[^.!?;:\n]*\band\s+$/i;

function isInspectedGradeMetadata(text: string, directiveStart: number, input: string): boolean {
  if (!GRADE_METADATA_OBJECT_RE.test(input.trimStart())) return false;
  const clause = text.slice(Math.max(0, directiveStart - 180), directiveStart);
  return INSPECTION_CONJUNCTION_RE.test(clause);
}

function normalizeRating(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The short label a scale entry of the form `label — definition` (or
 * `label: definition`) leads with.
 *
 * A rating scale routinely carries its definition inline, so `unknown` and
 * `unknown — the evidence did not establish a verdict` are the SAME rating.
 * `canonicalScorecardRating` resolves the short form at emit time; this is the
 * one implementation both sides read, so the accepting half and the validating
 * half cannot drift apart.
 */
export function leadingScaleLabel(value: string): string {
  return value.split(/[—:]/, 1)[0].trim().toLowerCase();
}

/**
 * Whether a rating named in procedure prose would be ACCEPTED by scorecards:emit
 * against this scale: an exact case-insensitive match, or the unambiguous leading
 * label of exactly one `label — definition` entry. Ambiguity stays a violation —
 * two entries sharing a leading label cannot resolve to one rating at emit time
 * either, so the prose really is off-scale.
 */
export function ratingResolvesOnScale(rating: string, scale: readonly string[]): boolean {
  const normalized = normalizeRating(rating);
  if (scale.some((entry) => normalizeRating(entry) === normalized)) return true;
  return scale.filter((entry) => leadingScaleLabel(entry) === normalized).length === 1;
}

function isQuote(value: string): boolean {
  return value === '`' || value === "'" || value === '"' || value === '“' || value === '‘';
}

function closingQuote(opening: string): string {
  if (opening === '“') return '”';
  if (opening === '‘') return '’';
  return opening;
}

/** Only balanced literals hide directives; contractions and unmatched quotes do not. */
function quotedLiteralRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = -1;
  let close = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (start >= 0) {
      if (character === close) {
        ranges.push({ start, end: index });
        start = -1;
      }
      continue;
    }
    if (!isQuote(character)) continue;
    // A possessive/contraction apostrophe cannot open a quoted source literal.
    if (character === "'" && /\w/.test(text[index - 1] ?? '')) continue;
    start = index;
    close = closingQuote(character);
  }
  return ranges;
}

function skipDirectiveConnector(input: string): string {
  let rest = input.trimStart();
  for (;;) {
    if (rest.startsWith(':') || rest.startsWith('=')) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    const connector = /^(?:as|is)\b/i.exec(rest);
    if (!connector) return rest;
    rest = rest.slice(connector[0].length).trimStart();
  }
}

/**
 * Numbered drill procedures use `(<n>) GRADE:` as a section label.  The word
 * after that label describes the assessment method (`JUDGED`, `SELECT`, ...),
 * not the scorecard value to emit.  Keep this structural instead of adding
 * today's descriptor to a stop-word list: a rubric may legitimately define a
 * rating named `judged`, while the numbered heading remains a heading for every
 * vocabulary.
 */
function isNumberedProcedureHeading(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end);
  return /^\s*(?:\(\d+\)|\d+[.)])\s*$/.test(prefix) && /^\s*:/.test(suffix);
}

/**
 * Parse the target of one `grade`/`rate`/`rating` directive.
 *
 * Unquoted prose is intentionally conservative: a single word is accepted only
 * at the end of the directive or before a condition/punctuation boundary. This
 * avoids treating "rate limit" or "grade based on evidence" as rating values.
 */
function parseDirectiveTarget(input: string, directive: string): ParsedDirective | null {
  const trimmed = input.trimStart();
  // `grade/rate/rating of X` is a noun phrase ("rate of change", "grade of
  // service"), not an instruction to emit X. Explicit directives already have
  // unambiguous spellings: `Grade fail`, `rate as fail`, or a quoted value.
  if (/^of\b/i.test(trimmed)) return null;

  const rest = skipDirectiveConnector(input);
  if (!rest) return null;

  const opening = rest[0];
  if (isQuote(opening)) {
    const close = closingQuote(opening);
    const end = rest.indexOf(close, 1);
    if (end <= 1) return null;
    const rating = rest.slice(1, end).trim();
    return rating ? { rating, end: input.indexOf(rest) + end + 1 } : null;
  }

  // `rating` is a noun in most prose. Require an explicit connector or quoted
  // value before interpreting its unquoted next word as a rating.
  if (directive.toLowerCase() === 'rating' && rest === input.trimStart()) {
    return null;
  }

  const matched = UNQUOTED_RATING_RE.exec(rest)?.[0];
  // A trailing full stop is sentence punctuation, not part of the rating. The
  // continuation class admits `.` so a dotted label stays matchable, which means
  // a directive that ENDS a sentence ("the correct rating is undetermined.")
  // otherwise captures the stop too and reports `undetermined.` — a rating the
  // author never wrote and no scale can contain. Strip it before matching, but
  // keep the boundary test on the full match: the stop is what proves the
  // directive ended there.
  const token = matched?.replace(/\.+$/, '');
  if (
    !matched ||
    !token ||
    NON_RATING_DIRECTIVE_WORDS.has(token.toLowerCase()) ||
    NON_RATING_TARGET_WORDS.has(token.toLowerCase())
  ) {
    return null;
  }

  const afterToken = rest.slice(matched.length).trimStart();
  const explicitBoundary =
    afterToken.length === 0 || /^[,;:.!?)]/.test(afterToken) || EXPLICIT_FOLLOWING_WORD_RE.test(afterToken);
  if (!explicitBoundary) return null;

  return {
    rating: token,
    end: input.indexOf(rest) + matched.length,
  };
}

function excerpt(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 24);
  const to = Math.min(text.length, end + 72);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

/** Extract explicit rating instructions from one criterion procedure field. */
export function extractRubricRatingInstructions(
  criterionKey: string,
  field: RubricRatingInstructionField,
  text: string | undefined,
): RubricRatingInstruction[] {
  if (!text?.trim()) return [];

  const instructions: RubricRatingInstruction[] = [];
  const literalRanges = quotedLiteralRanges(text);
  let literalIndex = 0;
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const directive = match[1];
    const directiveStart = match.index ?? 0;
    while (literalRanges[literalIndex]?.end < directiveStart) literalIndex++;
    const literal = literalRanges[literalIndex];
    // Test titles and code strings can contain whole phrases ending in "rate".
    // Their closing quote is not the start of a requested rating. A real
    // directive such as Grade 'partial' stays visible outside the literal.
    if (literal && literal.start < directiveStart && directiveStart < literal.end) continue;
    // A directive embedded in a compound label (for example `GOAL+GRADE
    // mode`) is a noun/heading, not an instruction to emit `mode`.
    const preceding = text[directiveStart - 1];
    if (preceding === '+' || preceding === '-' || preceding === '/') continue;
    const directiveEnd = directiveStart + match[0].length;
    if (isNumberedProcedureHeading(text, directiveStart, directiveEnd)) continue;
    const input = text.slice(directiveEnd);
    if (directive.toLowerCase() === 'grade' && isInspectedGradeMetadata(text, directiveStart, input)) continue;
    const target = parseDirectiveTarget(input, directive);
    if (!target) continue;
    const end = directiveStart + match[0].length + target.end;
    instructions.push({
      criterionKey,
      field,
      rating: target.rating,
      excerpt: excerpt(text, directiveStart, end),
    });
  }
  return instructions;
}

function effectiveScale(criterion: RubricRatingVocabularyCriterion, rubricRatingScale: readonly string[]): string[] {
  const scale = criterion.ratingScale ?? rubricRatingScale;
  return scale
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Validate explicit rating instructions against each criterion's effective scale.
 *
 * The comparison matches scorecard validation, through the shared
 * `ratingResolvesOnScale`: labels are case-insensitive, and a scale entry
 * written as `label — definition` is satisfied by its unambiguous leading
 * label, exactly as `canonicalScorecardRating` resolves it at emit time. A
 * criterion override wins over the rubric-level scale.
 */
export function validateRubricRatingVocabulary(
  criteria: ReadonlyArray<RubricRatingVocabularyCriterion>,
  rubricRatingScale: readonly string[],
): RubricRatingVocabularyValidation {
  const instructions: RubricRatingInstruction[] = [];
  const violations: RubricRatingVocabularyViolation[] = [];

  for (const criterion of criteria) {
    const criterionInstructions = [
      ...extractRubricRatingInstructions(criterion.key, 'method', criterion.method),
      ...extractRubricRatingInstructions(criterion.key, 'replication', criterion.replication),
    ];
    instructions.push(...criterionInstructions);

    const allowedRatings = effectiveScale(criterion, rubricRatingScale);
    for (const instruction of criterionInstructions) {
      if (!ratingResolvesOnScale(instruction.rating, allowedRatings)) {
        violations.push({ ...instruction, allowedRatings });
      }
    }
  }

  return { ok: violations.length === 0, instructions, violations };
}

/**
 * Throw the authoring-time teaching error used by rubrics:propose/amend.
 *
 * This is a thin assertion over the pure result above; callers that need a
 * non-throwing report should use validateRubricRatingVocabulary directly.
 */
export function assertRubricRatingVocabulary(
  criteria: ReadonlyArray<RubricRatingVocabularyCriterion>,
  rubricRatingScale: readonly string[],
  opts: { rubricId?: string } = {},
): void {
  const validation = validateRubricRatingVocabulary(criteria, rubricRatingScale);
  if (validation.ok) return;

  const details = validation.violations
    .map(
      (violation) =>
        `criterion '${violation.criterionKey}' ${violation.field} explicitly instructs rating ` +
        `'${violation.rating}', but its effective ratingScale is ` +
        `[${violation.allowedRatings.join(' | ')}] (excerpt: ${violation.excerpt})`,
    )
    .join('; ');
  const rubricLabel = opts.rubricId ? ` '${opts.rubricId}'` : '';
  throw new Error(
    `invalid_args: proposeRubric: rubric${rubricLabel} contains off-scale rating instructions — ${details}. ` +
      'Use a value from the effective ratingScale or revise the procedure prose.',
  );
}
