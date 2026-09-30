import { getWorkItemThreadWindow, isSettledWorkItemState } from '../../work-items';

/**
 * A conservative matcher for thread posts that retract an item's premise.
 *
 * This is deliberately advisory-only. A prose predicate is too form-blind to
 * become a claim exclusion; the terminal state remains the queue's authority.
 */
export const RETRACTION_LIKE_RE =
  /\b(retracting\s+this|i\s+retract\b|retraction\s+by\s+the\s+filer|(?:central|core)\s+premise\s+is\s+(?:wrong|false|invalid)|premise\s+(?:is|was)\s+(?:wrong|false|invalid|disproven)|do\s+not\s+act\s+on\s+(?:it|this)\s+as\s+written|(?:finding|analysis|diagnosis|conclusion|claim)\s+(?:is|was)\s+(?:wrong|false|incorrect|disproven|disproved)|superseding\s+this\s+(?:item|finding))/i;

/** Soft reminder shared by the filer-side and claimant-side advisory paths. */
export const RETRACTION_STATE_HINT =
  'This reads like a retraction, but the item is still non-terminal — a retraction in a comment does ' +
  'NOT retract anything the queue can see, so scheduler:get_next keeps serving this item AT ITS ORIGINAL ' +
  'SEVERITY and the next claimer sees the badge, not your correction. If this retracts the item\'s premise, ' +
  'call work_items:set_state { state:\'dropped\', completionRef:\'retracted: premise disproven\', ' +
  'assumptions:\'none\' } (terminal — removes it from work_items:claimable AND scheduler:get_next). ' +
  'Use completionRef for the caller-facing evidence and assumptions:\'none\' when no recorded fact supports ' +
  'the close.';

export interface ClaimTimeRetractionWorkItem {
  id?: string | null;
  state?: string | null;
  harness?: string | null;
}

export interface ClaimTimeRetractionAdvisory {
  retractionWarning: string;
}

/**
 * Read the bounded recent thread at claim time and return only the advisory
 * field. Every read is fail-open: the claim is already the important action,
 * and a degraded thread read must never turn a successful claim into a failure.
 */
export async function getClaimTimeRetractionAdvisory(
  workItem: ClaimTimeRetractionWorkItem | null | undefined,
  harness?: string | null,
): Promise<ClaimTimeRetractionAdvisory | null> {
  const id = workItem?.id;
  if (!id || isSettledWorkItemState(workItem?.state)) return null;

  try {
    const thread = await getWorkItemThreadWindow(id, 10, harness ?? workItem?.harness ?? undefined);
    if (!thread) return null;
    const hasRetraction = thread.posts.some((post) => RETRACTION_LIKE_RE.test(String(post.body ?? '')));
    return hasRetraction ? { retractionWarning: RETRACTION_STATE_HINT } : null;
  } catch {
    return null;
  }
}

/** String-only convenience for callers that already assemble warning fields. */
export async function getClaimTimeRetractionWarning(
  workItem: ClaimTimeRetractionWorkItem | null | undefined,
  harness?: string | null,
): Promise<string | null> {
  return (await getClaimTimeRetractionAdvisory(workItem, harness))?.retractionWarning ?? null;
}

/**
 * EI-19454477695046958 — a retraction living in a CHECKPOINT is invisible to the
 * reader who most needs it.
 *
 * `RETRACTION_LIKE_RE` above is deliberately NOT reused here. It matches prose
 * confessions ("the central premise is wrong") in THREAD POSTS at claim time.
 * Measured against the checkpoint corpus it fires on 1 of 7 real cases: it misses
 * WI-6980's actual retraction ("the original attribution was wrong") AND all four
 * self-labelling markers the filing item names (RETRACT / PREMISE CORRECTED /
 * WRONG and is disproved / SUPERSEDED). Widening it would change claim-time
 * semantics on a different surface, so this is a second, checkpoint-scoped matcher.
 *
 * A checkpoint retraction is written as a STRUCTURAL SELF-LABEL — a heading or
 * bullet opening a block — not as prose. So the marker is anchored to LINE START
 * (after arbitrary markdown/emoji decoration). That anchor is the whole precision
 * story, and it is the same refinement that took a sibling detector from 92.5%
 * false-positive to 0: it separates "## ⚠ CORRECTION — the wall above is FALSE"
 * (a self-label) from "I quoted its first retraction" (prose ABOUT one).
 *
 * Measured over 14,620 carry notes: an unanchored match flags 2,182; this anchored
 * one flags 203 (10.7x fewer), and 0 false positives in the inspected sample.
 */
export const CHECKPOINT_RETRACTION_RE =
  /^[^A-Za-z0-9\n]*(RETRACT(?:ED|ION)?|SUPERSEDED|REFUTED|DISPROV(?:ED|EN)|CORRECTION|PREMISE\s+(?:CORRECTED|WRONG|INVALID)|CONTESTED|WITHDRAWN|WRONG)\b/i;

/** Bounded so a pathological checkpoint can never dominate the read. */
const MAX_RETRACTION_EXCERPTS = 3;
const RETRACTION_EXCERPT_CHARS = 140;

export interface CheckpointRetractionScan {
  /**
   * How many INDEPENDENT retraction blocks the checkpoint carries.
   *
   * This is a count and not a boolean because the measured failure is missing the
   * SECOND one: of 159 checkpoints carrying a retraction, 35 carry two or more
   * (11 carry 3+, max 5). A boolean is wrong for those 35 — the reader finds one,
   * treats it as THE correction, and acts on a claim a later block withdraws.
   */
  count: number;
  /** First line of each retraction block, oldest-first, bounded. */
  excerpts: string[];
  /** Present only when `count` exceeds the excerpts shown. */
  more?: number;
}

/**
 * Scan a checkpoint body for self-labelled retraction blocks.
 *
 * Returns null (not a zero-count object) when there is nothing to say, so the
 * caller can omit the field entirely and keep a clean read lean.
 */
export function scanCheckpointRetractions(
  checkpoint: string | null | undefined,
): CheckpointRetractionScan | null {
  if (typeof checkpoint !== 'string' || checkpoint.length === 0) return null;

  const excerpts: string[] = [];
  let count = 0;

  for (const rawLine of checkpoint.split('\n')) {
    if (!CHECKPOINT_RETRACTION_RE.test(rawLine)) continue;
    count += 1;
    if (excerpts.length < MAX_RETRACTION_EXCERPTS) {
      const line = rawLine.trim();
      excerpts.push(
        line.length > RETRACTION_EXCERPT_CHARS
          ? `${line.slice(0, RETRACTION_EXCERPT_CHARS)}…`
          : line,
      );
    }
  }

  if (count === 0) return null;
  const more = count - excerpts.length;
  return more > 0 ? { count, excerpts, more } : { count, excerpts };
}
