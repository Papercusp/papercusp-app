/**
 * text-drift.ts — the DERIVED staleness channel between a plan item and the
 * work_item(s) minted from it (EI-21218726167520963 / WI-40825).
 *
 * THE GAP THIS CLOSES. `plan_items:convert` snapshots the plan item's text into
 * the minted work_item at MINT TIME — as the title, as `summary`, and (via
 * compile-brief) into `payload.brief`. Nothing refreshes that snapshot
 * afterwards: `plans:edit` / `plans:set-content` write the plan body and touch
 * no work_item, and no reconciliation sweep exists anywhere. So rewriting a
 * converted item's text leaves every minted work_item — and whoever is holding
 * one — executing the frozen copy, with nothing in the system saying so. The
 * other three plan→work-item channels were already graceful when this was
 * audited: status reflects back (reflect-rules.ts), set membership converges
 * (destructive-replan.ts), and post-mint DECISIONS are delivered live at claim
 * time (scheduler/get_next.ts). Only the item TEXT had no channel at all.
 *
 * WHY A HASH AND NOT A `stale: true` FLAG (derived-truth ladder, rung 1 DERIVE
 * over rung 4 CURATED). A stored boolean is a second copy of a truth the plan
 * already owns: someone has to remember to SET it, and — the half that actually
 * rots — someone has to remember to CLEAR it when the text is edited back or the
 * holder re-reads. That is the same shape as the hand-authored EVENT_CATALOG
 * `exists` fields that drifted until the system's most-fired key sat
 * unregistered. A mint-time hash instead lets any reader DERIVE the verdict by
 * comparison against the live plan, so the answer is recomputed on every read and
 * cannot be wrong in the stale direction.
 *
 * WHAT COUNTS AS "THE TEXT". `PlanItem.text` is the parser's SEMANTIC prose — the
 * status token, `blocked-by:`, `importance:`, `risk:` and `authority:` keywords
 * have already been stripped out of it (plan-parser parser.ts). That is exactly
 * the right subject, and picking it is load-bearing rather than incidental: the
 * surgical verbs (`plans:set-status`, `plans:set-item-blocked-by`,
 * `plans:set-item-phase`) each rewrite an item's RAW LINE while deliberately
 * leaving its meaning alone, so hashing `text` reports every one of them as NO
 * drift, while a genuine re-specification is caught. Hashing `rawLine` would make
 * routine status flips — by far the most common plan write there is — look like
 * spec changes, and a warning that fires constantly is one nobody reads.
 *
 * WHITESPACE IS NORMALIZED, CASE IS NOT. Whole-document writers rewrap plan
 * bodies, and a reflow is not a re-specification, so internal whitespace runs
 * collapse before hashing. Case and punctuation stay significant: preserving them
 * is free, and a case change can carry meaning.
 *
 * ABSENT IS `unknown`, NEVER `match`. A work_item minted before this stamp
 * existed carries no hash. Reporting that as "no drift" would be precisely the
 * false-absence class this repo keeps paying for — an empty result from an
 * instrument that never ran, read as a clean verdict. So the verdict is
 * three-state and callers MUST render `unknown` as unknown. The stamp is written
 * at MINT only: a resume deliberately does not heal it, because that would add a
 * payload write to a hot path (`findConvertedWorkItemByStamp` was once the single
 * largest consumer of DB time in the system) to buy an answer that `unknown`
 * already states honestly.
 */

import { createHash } from 'node:crypto';

/** How much of the sha256 hex to keep. Collision risk is irrelevant here — the
 *  comparison is between two hashes of the SAME item, not a lookup key. */
export const PLAN_ITEM_TEXT_HASH_LENGTH = 16;

/**
 * The three-state drift verdict.
 *
 * `unknown` is a first-class answer, not an error: it means the work_item
 * predates the stamp, so the comparison could not be made. It must never be
 * collapsed into `match` at a render site.
 */
export type PlanItemTextDriftStatus = 'match' | 'drifted' | 'unknown';

/** One plan item whose semantic text changed (or vanished) in a plan write. */
export interface PlanItemTextChange {
  id: string;
  /** `removed` = the write deletes the item entirely, so any open work_item
   *  minted from it now implements nothing. Strictly worse than `changed`. */
  kind: 'changed' | 'removed';
  before: string;
  /** Absent for `removed`. */
  after?: string;
}

/** The derived verdict for one work_item against its plan item's live text. */
export interface PlanItemTextDrift {
  status: PlanItemTextDriftStatus;
  /** One line, safe to render straight to an agent. */
  reason: string;
  /** The plan item's live text — present whenever the item still exists. */
  currentText?: string;
  /** The hash stamped at mint. Absent ⇒ a pre-stamp record ⇒ `unknown`. */
  mintedFromHash?: string;
  /** The live text's hash. Absent when the item is gone from the plan. */
  currentHash?: string;
  /** True when the plan no longer carries this item at all. */
  itemMissing?: boolean;
}

/**
 * Collapse whitespace runs and trim — see "WHITESPACE IS NORMALIZED" above.
 * Exported so tests can assert the normalization directly rather than inferring
 * it from hash equality (a test that only compares hashes cannot tell a correct
 * normalization from a broken hash that happens to collide with itself).
 */
export function normalizePlanItemText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Hash a plan item's semantic text, or `undefined` when there is no text to
 * hash. An item with empty text carries no identity to compare against, so it
 * gets no stamp rather than a hash-of-empty-string that would later read as a
 * real fingerprint.
 */
export function planItemTextHash(text: string | null | undefined): string | undefined {
  if (text == null) return undefined;
  const normalized = normalizePlanItemText(text);
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex').slice(0, PLAN_ITEM_TEXT_HASH_LENGTH);
}

/** The minimum item shape these pure helpers need (a `ParsedPlan['items']` row
 *  satisfies it) — kept structural so tests need no parser fixture. */
export interface TextDriftItemLike {
  id: string;
  text?: string | null;
}

/**
 * Items whose SEMANTIC text changed between two parses of the same plan, plus
 * items the write removes outright.
 *
 * Pure, and deliberately shaped like its sibling `detectStatusRegressions` in
 * agent-tools/plans/set-content.ts — both answer "what did this write do to the
 * items?" from the same (currentParsed, proposed) pair inside the same shared
 * evaluator, so they belong to the same family even though they live in
 * different modules (this one is also read by the work_items side).
 *
 * Items ADDED by the write are not reported: nothing has been minted from them
 * yet, so they cannot have stranded anybody.
 */
export function detectItemTextChanges(
  currentParsed: { items: ReadonlyArray<TextDriftItemLike> },
  proposed: { items: ReadonlyArray<TextDriftItemLike> },
): PlanItemTextChange[] {
  const proposedById = new Map(proposed.items.map((it) => [it.id, it]));
  const out: PlanItemTextChange[] = [];
  for (const cur of currentParsed.items) {
    const before = normalizePlanItemText(cur.text ?? '');
    const next = proposedById.get(cur.id);
    if (!next) {
      // Only worth reporting when there WAS something to strand a holder on.
      if (before) out.push({ id: cur.id, kind: 'removed', before });
      continue;
    }
    const after = normalizePlanItemText(next.text ?? '');
    if (before !== after) out.push({ id: cur.id, kind: 'changed', before, after });
  }
  return out;
}

/**
 * The derived verdict for one work_item: compare the hash stamped at mint
 * against the plan item's text right now.
 *
 * `itemExists: false` is reported as `drifted` even without a stamped hash,
 * because the item's ABSENCE is a fact established independently of the stamp —
 * unlike a text comparison, which genuinely cannot be made without one.
 */
export function derivePlanItemTextDrift(opts: {
  mintedFromHash?: string | null;
  currentText?: string | null;
  itemExists: boolean;
}): PlanItemTextDrift {
  const mintedFromHash = opts.mintedFromHash ?? undefined;
  if (!opts.itemExists) {
    return {
      status: 'drifted',
      itemMissing: true,
      reason:
        'the plan no longer contains this item — the work-item was minted from an item that has since been removed or renumbered',
      ...(mintedFromHash ? { mintedFromHash } : {}),
    };
  }
  const currentText = opts.currentText ?? undefined;
  const currentHash = planItemTextHash(currentText);
  if (!mintedFromHash) {
    return {
      status: 'unknown',
      reason:
        'minted before the plan-item text stamp existed, so drift cannot be determined — re-read the plan item before trusting this work-item\'s copy of it',
      ...(currentText !== undefined ? { currentText } : {}),
      ...(currentHash ? { currentHash } : {}),
    };
  }
  if (currentHash === mintedFromHash) {
    return {
      status: 'match',
      reason: 'the plan item still reads as it did when this work-item was minted',
      mintedFromHash,
      ...(currentHash ? { currentHash } : {}),
      ...(currentText !== undefined ? { currentText } : {}),
    };
  }
  return {
    status: 'drifted',
    reason:
      'the plan item has been REWRITTEN since this work-item was minted — the title/summary here is the old wording; read currentText before acting',
    mintedFromHash,
    ...(currentHash ? { currentHash } : {}),
    ...(currentText !== undefined ? { currentText } : {}),
  };
}
