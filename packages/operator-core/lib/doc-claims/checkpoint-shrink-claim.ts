/**
 * Doc-claim: `work_items:checkpoint`'s caller-visible DESCRIPTION must agree with
 * what the tool actually does to a big plain-replace shrink.
 *
 * EI-20218215840085630. Since EI-20232176364474286 the tool RETRIES a refused
 * plain shrink as a safe append: the write SUCCEEDS (`autoAppended:true`) and the
 * prior history is preserved beneath the caller's note. The description still said
 * the opposite ("block suspicious shrink"), and the accurate statement lived only
 * in `guidance.returns` — which is NOT delivered in the schema a caller loads.
 *
 * That asymmetry is what made this worth pinning rather than just fixing. The one
 * surface every caller does receive asserted the opposite of the behavior, exactly
 * at the context boundary where a concise checkpoint gets written; and "blocked",
 * sitting beside the full-replacement recipe in the same description, invites a
 * pre-emptive `confirmShrink:true` — which DISCARDS the history the retry would
 * have preserved. A stale doc that merely under-informs is cheap; this one steered
 * callers into the destructive path.
 *
 * Per the derived-truth ladder this is code-describing prose (a second copy of a
 * truth `checkpoint.ts` owns), so it gets a build-time divergence check — rung 2,
 * PIN — instead of being hand-maintained.
 *
 * DELIBERATELY NOT ASSERTED: that the description mention shrink at all. The tool
 * sits at 1498/1500 of its prompt-weight budget, so a "must say something" rule
 * would pit this pin against a real competing constraint and produce gate reds
 * that are not defects. Silence is not the failure mode this exists to catch; a
 * confident contradiction is.
 */
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

/**
 * The auto-append retry (EI-20232176364474286): a refused plain shrink is retried
 * with `preservePriorOnShrink`, which stores the caller's note and keeps the prior
 * beneath it. Both halves are required — the trigger alone could be a log line,
 * and the effect alone could be an unrelated flag assignment.
 *
 * Matched against COMMENT-STRIPPED source: `checkpoint.ts` discusses this retry at
 * length in prose (including the comment that cites this very claim), so a scan of
 * raw text would report the retry present no matter what the code did.
 */
const RETRY_TRIGGER = /blockedReason[\s\S]{0,160}?plain replace would shrink/;
const RETRY_EFFECT = /preservePriorOnShrink\s*=\s*true/;

/** Does the tool still retry a refused plain shrink instead of failing the call? */
export function hasShrinkRetry(source: string): boolean {
  const code = stripCommentsOnly(source);
  return RETRY_TRIGGER.test(code) && RETRY_EFFECT.test(code);
}

/** A shrink claim is judged per clause, so an unrelated "refused" cannot taint it. */
const SHRINK = /\bshrink\w*\b/i;
const BLOCK_WORD = /\b(blocks?|blocked|blocking|refus\w*|reject\w*|fails?|failed)\b/i;
const PRESERVE_WORD = /\b(keeps?|kept|preserv\w*|append\w*|retri\w*|auto-\w+|beneath|under)\b/i;

/**
 * Split on clause boundaries rather than sentences: the description packs several
 * independent claims into one sentence separated by `;`, and "peer-held writes are
 * refused" must not be read as a statement about shrink.
 */
function clauses(text: string): string[] {
  return text
    .split(/[.;]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

export interface ShrinkClaimVerdict {
  readonly ok: boolean;
  /** Whether the code currently retries a refused plain shrink. */
  readonly retryPresent: boolean;
  /** Description clauses that talk about shrink at all. */
  readonly shrinkClauses: readonly string[];
  /** Shrink clauses asserting the write is stopped. */
  readonly blockedClaims: readonly string[];
  /** Shrink clauses asserting the prior survives. */
  readonly preserveClaims: readonly string[];
  readonly violations: readonly string[];
}

/**
 * Falsifiable in BOTH directions: it catches prose that claims a block the code no
 * longer performs, AND prose that promises preservation the code no longer
 * provides. A one-directional check would go quietly vacuous the moment someone
 * removed the retry.
 */
export function judgeCheckpointShrinkClaim(description: string, source: string): ShrinkClaimVerdict {
  const retryPresent = hasShrinkRetry(source);
  const shrinkClauses = clauses(description).filter((c) => SHRINK.test(c));
  const blockedClaims = shrinkClauses.filter((c) => BLOCK_WORD.test(c));
  const preserveClaims = shrinkClauses.filter((c) => PRESERVE_WORD.test(c) && !BLOCK_WORD.test(c));

  const violations: string[] = [];
  if (retryPresent && blockedClaims.length > 0) {
    violations.push(
      `checkpoint.ts retries a refused plain shrink as a safe append (the write SUCCEEDS with ` +
        `autoAppended:true), but the tool description tells callers it is stopped: ` +
        `${blockedClaims.map((c) => JSON.stringify(c)).join(', ')}. ` +
        `Callers who believe it reach for confirmShrink:true, which DISCARDS the prior history ` +
        `the retry would have preserved. Fix the description, not this test — and note that ` +
        `guidance.returns is NOT delivered in the schema a caller loads, so correcting it there ` +
        `alone leaves the delivered surface wrong (EI-20218215840085630).`,
    );
  }
  if (!retryPresent && preserveClaims.length > 0) {
    violations.push(
      `the tool description promises a big shrink preserves prior content ` +
        `(${preserveClaims.map((c) => JSON.stringify(c)).join(', ')}), but the auto-append retry ` +
        `is no longer detectable in checkpoint.ts. If the retry was deliberately removed, the ` +
        `description must stop promising preservation.`,
    );
  }
  return { ok: violations.length === 0, retryPresent, shrinkClauses, blockedClaims, preserveClaims, violations };
}
