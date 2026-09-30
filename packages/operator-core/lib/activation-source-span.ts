/**
 * P-018 (design-to-code-coverage-seam-2026-09-02): the SOURCE-SPAN assertion.
 *
 * ## The two halves, and why this is the other one
 *
 * P-017's under-read detector asks: *within the ranges you declared, which turns did you
 * never cite?* It takes the declared ranges as given. That leaves the prior question
 * untouched, and the prior question is the one that decides the denominator:
 *
 *   **Were the ranges you declared the whole conversation?**
 *
 * An auditor who declares turns 60-120 of a 200-turn authoring session has already
 * excluded 140 turns before any mapping is written, and every downstream check — source
 * ref containment, the under-read diff, the realization judge — operates inside that
 * choice and therefore cannot see past it. This closes the hole at its source by
 * comparing the declared ranges against the transcript's ACTUAL extent.
 *
 * ## Where the missing turns actually are, and why the TAIL matters most
 *
 * Gaps are classified by position because they mean different things:
 *
 *   • `head` — reading started late. Usually the framing: the original ask, the problem
 *     statement, the constraints stated before anyone proposed a design.
 *   • `interior` — a stretch between two declared ranges. Often benign (a tool-output
 *     run, a tangent), which is exactly why this is advisory.
 *   • `tail` — reading stopped early. THE expensive one. Late turns are where
 *     corrections, reversals and "actually, do it this way instead" live, and a
 *     requirement that was REVISED at turn 190 and audited only to turn 150 is not
 *     merely missed — the audit records the SUPERSEDED version as current, which is
 *     worse than recording nothing.
 *
 * ## Advisory, and honest about what it could not measure
 *
 * Same contract as its P-017 sibling, for the same reason: a gap is evidence that turns
 * went undeclared, never proof they carried anything. A long tool-output run is a
 * legitimate gap. Refusing an audit on a gap alone would block correct work.
 *
 * And the failure this must not have: if the transcript extent for a declared session
 * cannot be read, the detector CANNOT conclude "fully spanned" — it would be inferring
 * complete coverage from a failed measurement, which is the self-chosen-denominator bug
 * wearing the detector's clothes. Unmeasurable sessions are reported in
 * {@link SourceSpanVerdict.unmeasuredSessions} and make
 * {@link isSourceSpanVerdictConclusive} false. Gate every "fully spanned" claim on that
 * predicate, never on `gaps.length === 0`.
 */
import type { ActivationAuditSourceRange } from './plan-audits';

/** The transcript's real extent for one session, as measured from the turn store. */
export interface SessionTurnExtent {
  sourceKind: string;
  sessionId: string;
  /** Lowest turn index present in the transcript. */
  minTurn: number;
  /** Highest turn index present. */
  maxTurn: number;
}

/** A contiguous run of transcript turns no declared range covers. */
export interface SourceSpanGap {
  sourceKind: string;
  sessionId: string;
  fromTurn: number;
  toTurn: number;
  turnCount: number;
  /** See the header — `tail` is the costly one, because late turns carry corrections. */
  position: 'head' | 'interior' | 'tail';
}

/** Per-session accounting, so a multi-session audit does not average its gaps away. */
export interface SessionSpanCoverage {
  sourceKind: string;
  sessionId: string;
  transcriptTurns: number;
  declaredTurns: number;
  gapTurns: number;
}

export interface SourceSpanVerdict {
  /** Turn positions the transcripts actually hold, across every MEASURED session. */
  transcriptTurns: number;
  /** Of those, how many fall inside some declared range. */
  declaredTurns: number;
  /** Transcript turns no declared range covers. */
  gapTurns: number;
  gaps: SourceSpanGap[];
  perSession: SessionSpanCoverage[];
  /**
   * Sessions the audit DECLARED but whose transcript extent could not be measured. While
   * this is non-empty the verdict cannot support a "fully spanned" conclusion — see the
   * header.
   */
  unmeasuredSessions: string[];
  /**
   * Sessions present in the supplied extents that the audit declared NOTHING for — a
   * whole conversation excluded rather than a range within one. Reported separately
   * because it is a different mistake, and a louder one.
   */
  undeclaredSessions: string[];
  /** Always true. This verdict never refuses. */
  advisory: true;
}

function sessionLabel(sourceKind: string, sessionId: string): string {
  return `${sourceKind}::${sessionId}`;
}

export interface AssertSourceSpanInput {
  sourceRanges: ReadonlyArray<ActivationAuditSourceRange>;
  /** Measured transcript extents. A session omitted here is reported as unmeasured. */
  extents: ReadonlyArray<SessionTurnExtent>;
}

/**
 * Compare the declared ranges against the transcripts' real extent. Pure: no reads, no
 * writes, no clock.
 */
export function assertSourceSpan(input: AssertSourceSpanInput): SourceSpanVerdict {
  const extentByLabel = new Map(
    input.extents.map((extent) => [sessionLabel(extent.sourceKind, extent.sessionId), extent]),
  );

  // Declared turn positions, per session. A session may carry several ranges, and they
  // may overlap or arrive unsorted; a Set makes both harmless.
  const declaredByLabel = new Map<string, Set<number>>();
  for (const range of input.sourceRanges) {
    const label = sessionLabel(range.sourceKind, range.sessionId);
    let turns = declaredByLabel.get(label);
    if (!turns) {
      turns = new Set<number>();
      declaredByLabel.set(label, turns);
    }
    // An inverted range contributes nothing rather than throwing — a malformed range is
    // the audit tool's problem to report, not a reason for this advisory read to fail.
    for (let turn = range.fromTurn; turn <= range.toTurn; turn += 1) turns.add(turn);
  }

  const gaps: SourceSpanGap[] = [];
  const perSession: SessionSpanCoverage[] = [];
  const unmeasuredSessions: string[] = [];
  let transcriptTurns = 0;
  let declaredTurns = 0;
  let gapTurns = 0;

  for (const [label, declared] of declaredByLabel) {
    const extent = extentByLabel.get(label);
    if (!extent) {
      // Declared but unmeasurable. Counting it as fully covered would infer coverage from
      // a failed measurement; counting it as a total gap would invent findings. Neither —
      // it is reported, and it makes the verdict inconclusive.
      unmeasuredSessions.push(label);
      continue;
    }

    let sessionTranscript = 0;
    let sessionDeclared = 0;
    let sessionGap = 0;
    let runStart: number | null = null;

    const flush = (endTurn: number) => {
      if (runStart === null) return;
      const position: SourceSpanGap['position'] =
        runStart === extent.minTurn ? 'head' : endTurn === extent.maxTurn ? 'tail' : 'interior';
      gaps.push({
        sourceKind: extent.sourceKind,
        sessionId: extent.sessionId,
        fromTurn: runStart,
        toTurn: endTurn,
        turnCount: endTurn - runStart + 1,
        position,
      });
      runStart = null;
    };

    for (let turn = extent.minTurn; turn <= extent.maxTurn; turn += 1) {
      sessionTranscript += 1;
      if (declared.has(turn)) {
        sessionDeclared += 1;
        flush(turn - 1);
        continue;
      }
      sessionGap += 1;
      if (runStart === null) runStart = turn;
    }
    flush(extent.maxTurn);

    transcriptTurns += sessionTranscript;
    declaredTurns += sessionDeclared;
    gapTurns += sessionGap;
    perSession.push({
      sourceKind: extent.sourceKind,
      sessionId: extent.sessionId,
      transcriptTurns: sessionTranscript,
      declaredTurns: sessionDeclared,
      gapTurns: sessionGap,
    });
  }

  const undeclaredSessions = [...extentByLabel.keys()].filter(
    (label) => !declaredByLabel.has(label),
  );

  // Tail first (the costly position), then largest, then by session for a total order.
  const positionRank: Record<SourceSpanGap['position'], number> = { tail: 0, head: 1, interior: 2 };
  gaps.sort(
    (a, b) =>
      positionRank[a.position] - positionRank[b.position] ||
      b.turnCount - a.turnCount ||
      sessionLabel(a.sourceKind, a.sessionId).localeCompare(sessionLabel(b.sourceKind, b.sessionId)) ||
      a.fromTurn - b.fromTurn,
  );

  return {
    transcriptTurns,
    declaredTurns,
    gapTurns,
    gaps,
    perSession,
    unmeasuredSessions: unmeasuredSessions.sort(),
    undeclaredSessions: undeclaredSessions.sort(),
    advisory: true,
  };
}

/**
 * Whether this verdict can support a "the declared ranges span the whole conversation"
 * claim.
 *
 * FALSE while any declared session went unmeasured: the detector could not see that
 * session's extent, so an empty gap list is a statement about the sessions it COULD read.
 * Gate every fully-spanned assertion on this rather than on `gaps.length === 0`.
 */
export function isSourceSpanVerdictConclusive(verdict: SourceSpanVerdict): boolean {
  return verdict.unmeasuredSessions.length === 0;
}

/** One-line rendering, leading with the position because that is what changes the reading. */
export function describeSourceSpanGap(gap: SourceSpanGap): string {
  const turns = gap.fromTurn === gap.toTurn ? `turn ${gap.fromTurn}` : `turns ${gap.fromTurn}-${gap.toTurn}`;
  return `${gap.position.toUpperCase()} gap: ${gap.sourceKind}:${gap.sessionId} ${turns} (${gap.turnCount} undeclared)`;
}

/** Human summary that never reports coverage without saying what it could not measure. */
export function describeSourceSpanVerdict(verdict: SourceSpanVerdict): string {
  if (verdict.transcriptTurns === 0 && verdict.unmeasuredSessions.length > 0) {
    return (
      `source span UNMEASURED: ${verdict.unmeasuredSessions.length} declared session(s) had no ` +
      `readable transcript extent, so no span claim is supported. Advisory only.`
    );
  }
  const pct = verdict.transcriptTurns === 0
    ? 0
    : Math.round((verdict.declaredTurns / verdict.transcriptTurns) * 100);
  const caveat = isSourceSpanVerdictConclusive(verdict)
    ? ''
    : ` — ${verdict.unmeasuredSessions.length} declared session(s) UNMEASURED, so this is a` +
      ` partial view, not a span verdict`;
  const undeclared =
    verdict.undeclaredSessions.length > 0
      ? `; ${verdict.undeclaredSessions.length} session(s) were declared NOTHING at all`
      : '';
  const tail = verdict.gaps.filter((gap) => gap.position === 'tail').length;
  const tailNote = tail > 0 ? `, ${tail} at the TAIL (where corrections live)` : '';
  return (
    `declared ranges cover ${verdict.declaredTurns}/${verdict.transcriptTurns} transcript turn(s) ` +
    `(${pct}%) across ${verdict.gaps.length} gap(s)${tailNote}${undeclared}${caveat}. Advisory only.`
  );
}
