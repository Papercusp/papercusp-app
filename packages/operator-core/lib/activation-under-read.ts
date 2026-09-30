/**
 * P-017 (design-to-code-coverage-seam-2026-09-02): the UNDER-READ detector.
 *
 * ## The hole this closes
 *
 * An activation audit declares `sourceRanges` ("I read turns 1-120 of session X") and
 * submits `mappings` (each citing the specific turns it distilled). Nothing checks the
 * relationship between the two. An auditor can declare a wide range, map four turns from
 * it, and every existing gate passes: the mappings are well-formed, their `sourceRefs`
 * fall inside the declared ranges, and the plan targets resolve. The denominator is
 * chosen by the same party that chooses the numerator.
 *
 * This performs an INDEPENDENT second extraction over the declared ranges - independent
 * in the sense that matters, which is that its rules do not consult the mappings - and
 * reports which turns inside those ranges carry requirement-shaped language yet were
 * never cited. Those are CANDIDATE gaps.
 *
 * ## Advisory, deliberately, and not as a soft-launch
 *
 * P-017 says advisory first, not a refusal, and that is a property of the instrument
 * rather than a rollout stage. This is a LEXICAL detector: it can only see that a turn
 * sounds like a requirement, never that its content went unabsorbed. A turn saying "it
 * must never double-write" is a true positive when unmapped and a false positive when
 * the auditor folded it into a neighbouring mapping citing a different turn. Refusing an
 * audit on that basis would block correct work on a guess. Reporting it costs a read.
 *
 * The companion asymmetry: a turn with NO signal is not evidence of nothing - plenty of
 * requirements arrive as plain declaratives. So a candidate list is a floor on what was
 * missed, never a measure of it, and {@link UnderReadVerdict} says so in its own shape
 * rather than leaving a reader to infer it.
 *
 * ## Why the detector reports its OWN coverage
 *
 * The most important field here is {@link UnderReadVerdict.unsuppliedTurns}. If the
 * caller supplies 12 turns for a declared range spanning 120, a candidate list of zero
 * means "none of the 12 I could read looked unmapped" - NOT "the audit read everything".
 * Reporting that as a clean verdict would reproduce the exact self-chosen-denominator
 * failure this item exists to close, one level up and harder to see, because it would
 * now be the DETECTOR choosing the denominator. So supply is measured and reported
 * beside every count, and {@link isUnderReadVerdictConclusive} is the single predicate a
 * caller should gate any "no gaps" claim on.
 */
import { formatSessionTurnRef, parseTurnRef } from './agent-tools/sessions/_shared';
import type { ActivationAuditMapping, ActivationAuditSourceRange } from './plan-audits';

/** One transcript turn, reduced to what the detector actually reads. */
export interface AuditSourceTurn {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
  /** Transcript speaker as recorded (`user`, `assistant`, ...). Reported, never filtered on. */
  speaker: string;
  text: string;
}

/**
 * Why a turn was flagged. Each names a distinct way a plan-authoring conversation
 * carries an obligation, so a reader can tell "you skipped a constraint" from "you
 * skipped an open question" without re-reading the turn.
 */
export type UnderReadSignal =
  /** Obligation language - must / should / needs to / make sure / required. */
  | 'requirement'
  /** Prohibition - never / must not / don't / avoid. The costliest to miss silently. */
  | 'constraint'
  /** A reversal of something already said - actually / instead / rather than. */
  | 'correction'
  /** A choice being made - let's / we'll / going with / decided. */
  | 'decision'
  /** An unresolved question posed in the authoring conversation. */
  | 'open-question';

/**
 * The extraction rules, exported so they are pinned by tests rather than restated in
 * prose, and so a caller can see exactly what the detector can and cannot notice.
 *
 * Word boundaries are `\b` - this is JavaScript. (Postgres ARE would read `\b` as
 * BACKSPACE and match nothing; that trap is recorded on this plan as D-047, and it is
 * why the tests assert a positive control rather than only asserting non-matches.)
 */
export const UNDER_READ_SIGNAL_PATTERNS: ReadonlyArray<{
  signal: UnderReadSignal;
  pattern: RegExp;
}> = [
  { signal: 'constraint', pattern: /\b(never|must not|mustn't|don't|do not|avoid|no longer)\b/i },
  { signal: 'requirement', pattern: /\b(must|should|needs? to|make sure|ensure|required?|has to)\b/i },
  { signal: 'correction', pattern: /\b(actually|instead|rather than|correction|scratch that|i meant)\b/i },
  { signal: 'decision', pattern: /\b(let's|lets|we'll|we will|going with|decided|chose|pick)\b/i },
  { signal: 'open-question', pattern: /\?\s*$/ },
];

/** The shortest turn worth reading for signals - below this it is an ack, not a requirement. */
export const UNDER_READ_MIN_TURN_CHARS = 24;

export interface UnderReadCandidate {
  /** Canonical `session_turn:` ref, so a reader can go straight to the turn. */
  ref: string;
  speaker: string;
  signals: UnderReadSignal[];
  /** Enough of the turn to judge the flag without opening the transcript. */
  excerpt: string;
}

/** A mapping cited a turn outside every declared range - the audit's own bookkeeping is off. */
export interface CitedOutsideRange {
  mappingId: string;
  ref: string;
}

export interface UnderReadVerdict {
  /** Turn positions covered by the declared ranges. The audit's own claimed denominator. */
  declaredTurns: number;
  /**
   * Declared turns the caller actually supplied text for. THE honesty field: every count
   * below is over this population, not over `declaredTurns`.
   */
  suppliedTurns: number;
  /**
   * Declared turns whose text was NOT supplied. While this is non-zero the detector has
   * not read the audit's full claimed range and cannot support a "no gaps" conclusion.
   */
  unsuppliedTurns: number;
  /** Supplied turns cited by at least one mapping. */
  citedTurns: number;
  /** Supplied turns cited by nothing - the pool candidates are drawn from. */
  uncitedTurns: number;
  /** Uncited turns carrying at least one signal, longest-signal-list first. */
  candidates: UnderReadCandidate[];
  /** Refs the mappings cite that no declared range contains. */
  citedOutsideRanges: CitedOutsideRange[];
  /** Always true. This verdict never refuses; see the header. */
  advisory: true;
}

/**
 * Composite key for one turn position. `::` cannot occur in a source kind or a session
 * id, and the numeric index terminates the string, so the encoding is unambiguous
 * without needing a separator that would be a control byte.
 */
function turnKey(sourceKind: string, sessionId: string, turnIdx: number): string {
  return `${sourceKind}::${sessionId}::${turnIdx}`;
}

/** Signals present in a turn, in the declared order so output is stable. */
export function underReadSignalsOf(text: string): UnderReadSignal[] {
  const trimmed = text.trim();
  if (trimmed.length < UNDER_READ_MIN_TURN_CHARS) return [];
  return UNDER_READ_SIGNAL_PATTERNS.filter(({ pattern }) => pattern.test(trimmed)).map(
    ({ signal }) => signal,
  );
}

function excerptOf(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

export interface DetectUnderReadInput {
  sourceRanges: ReadonlyArray<ActivationAuditSourceRange>;
  mappings: ReadonlyArray<ActivationAuditMapping>;
  /**
   * Turn text for as much of the declared ranges as the caller could read. A PARTIAL
   * supply is expected and handled - it is reported, never silently treated as the whole
   * range (see `unsuppliedTurns`).
   */
  turns: ReadonlyArray<AuditSourceTurn>;
}

/**
 * Diff the declared ranges against what the mappings actually cite. Pure: no reads, no
 * writes, no clock.
 */
export function detectUnderRead(input: DetectUnderReadInput): UnderReadVerdict {
  // Every (kind, session, turn) position the audit CLAIMS to have read. A range is
  // inclusive at both ends, matching the containment check the audit tool already applies
  // to `sourceRefs`; an inverted range (toTurn < fromTurn) contributes nothing rather
  // than throwing, because a malformed range is the audit's problem to report, not a
  // reason for this advisory read to fail.
  const declared = new Set<string>();
  for (const range of input.sourceRanges) {
    for (let turn = range.fromTurn; turn <= range.toTurn; turn += 1) {
      declared.add(turnKey(range.sourceKind, range.sessionId, turn));
    }
  }

  const cited = new Set<string>();
  const citedOutsideRanges: CitedOutsideRange[] = [];
  for (const mapping of input.mappings) {
    for (const ref of mapping.sourceRefs) {
      const parsed = parseTurnRef(ref);
      if (!parsed) continue; // Ref VALIDITY is the audit tool's gate, not this one's.
      const key = turnKey(parsed.sourceKind, parsed.sessionId, parsed.turnIdx);
      cited.add(key);
      if (!declared.has(key)) citedOutsideRanges.push({ mappingId: mapping.id, ref });
    }
  }

  // Only turns the audit DECLARED are in scope. A supplied turn outside every declared
  // range is not an under-read - the audit never claimed to have read it - so counting it
  // would inflate the denominator with turns nobody promised to cover.
  const suppliedInScope = input.turns.filter((turn) =>
    declared.has(turnKey(turn.sourceKind, turn.sessionId, turn.turnIdx)),
  );
  const suppliedKeys = new Set(
    suppliedInScope.map((turn) => turnKey(turn.sourceKind, turn.sessionId, turn.turnIdx)),
  );

  const candidates: UnderReadCandidate[] = [];
  let citedTurns = 0;
  for (const turn of suppliedInScope) {
    const key = turnKey(turn.sourceKind, turn.sessionId, turn.turnIdx);
    if (cited.has(key)) {
      citedTurns += 1;
      continue;
    }
    const signals = underReadSignalsOf(turn.text);
    if (signals.length === 0) continue;
    candidates.push({
      ref: formatSessionTurnRef(turn.sourceKind, turn.sessionId, turn.turnIdx),
      speaker: turn.speaker,
      signals,
      excerpt: excerptOf(turn.text),
    });
  }

  // Most-signalled first, then by ref so the order is total and output is diffable.
  candidates.sort((a, b) => b.signals.length - a.signals.length || a.ref.localeCompare(b.ref));

  return {
    declaredTurns: declared.size,
    suppliedTurns: suppliedKeys.size,
    unsuppliedTurns: declared.size - suppliedKeys.size,
    citedTurns,
    uncitedTurns: suppliedKeys.size - citedTurns,
    candidates,
    citedOutsideRanges,
    advisory: true,
  };
}

/**
 * How many turns one advisory pass will read. An activation audit can declare hundreds of
 * turns and this runs on every one, so the read is bounded rather than unbounded — and
 * because the verdict reports `unsuppliedTurns`, hitting the cap DEGRADES the verdict to
 * inconclusive instead of silently narrowing the denominator. That is the whole reason
 * the cap is safe to have.
 */
export const UNDER_READ_TURN_FETCH_CAP = 500;

/** Reads turn text for the declared ranges, up to `cap` rows. Injected, so this is testable. */
export type AuditTurnReader = (
  ranges: ReadonlyArray<ActivationAuditSourceRange>,
  cap: number,
) => Promise<ReadonlyArray<AuditSourceTurn>>;

/**
 * Fetch-then-detect. Separated from {@link detectUnderRead} so the judgement stays pure
 * and the read stays injectable.
 */
export async function detectUnderReadFromSource(
  input: Omit<DetectUnderReadInput, 'turns'>,
  read: AuditTurnReader,
  cap: number = UNDER_READ_TURN_FETCH_CAP,
): Promise<UnderReadVerdict> {
  const turns = await read(input.sourceRanges, cap);
  return detectUnderRead({ ...input, turns });
}

/**
 * Whether this verdict can support a "nothing was under-read" claim.
 *
 * FALSE whenever any declared turn went unsupplied: the detector read less than the audit
 * claimed to, so an empty candidate list is a statement about the sample, not the range.
 * Gate every no-gaps assertion on this rather than on `candidates.length === 0` - the
 * latter is exactly the self-chosen-denominator reading P-017 exists to close.
 */
export function isUnderReadVerdictConclusive(verdict: UnderReadVerdict): boolean {
  return verdict.unsuppliedTurns === 0;
}

/** One-line rendering for an advisory report. */
export function describeUnderReadCandidate(candidate: UnderReadCandidate): string {
  return `${candidate.ref} [${candidate.speaker}] ${candidate.signals.join('+')}: "${candidate.excerpt}"`;
}

/** Human summary that states the denominator it is speaking over, never a bare count. */
export function describeUnderReadVerdict(verdict: UnderReadVerdict): string {
  const scope = isUnderReadVerdictConclusive(verdict)
    ? `all ${verdict.declaredTurns} declared turn(s)`
    : `${verdict.suppliedTurns} of ${verdict.declaredTurns} declared turn(s) - ` +
      `${verdict.unsuppliedTurns} unread, so this is a FLOOR, not a total`;
  const outside =
    verdict.citedOutsideRanges.length > 0
      ? `; ${verdict.citedOutsideRanges.length} citation(s) fall outside every declared range`
      : '';
  return (
    `${verdict.candidates.length} candidate gap(s) across ${scope}: ` +
    `${verdict.citedTurns} cited, ${verdict.uncitedTurns} uncited${outside}. Advisory only.`
  );
}
