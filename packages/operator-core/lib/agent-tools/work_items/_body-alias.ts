/**
 * body ↔ summary: the SAME logical field on a work-item, under one column, accepted
 * under EITHER name by both write verbs (WI-4492).
 *
 * THE BUG THIS CLOSES (proven 2026-07-13, su-00a91): the item's primary text field had
 * THREE inconsistent names across the CRUD triad and the write verbs SILENTLY DISCARDED
 * the wrong one while returning ok:true —
 *
 *     work_items:create  took  `summary`   (a `body` arg was silently dropped)
 *     work_items:get     returns `summary`
 *     work_items:update  took  `body`      (a `summary` arg was silently dropped)
 *
 * create and update were INVERTED, so BOTH natural usages lost data with a cheerful ok:
 *   - read an item (get → `summary`), edit the text, write it back under `summary` via
 *     update  ⇒  body silently dropped; and
 *   - create passing `body` (the name update taught you)  ⇒  body silently dropped.
 * Zod's default `.object()` STRIPS any unknown key, so the wrong name never errored.
 *
 * THE FIX (this module is the shared half): both write verbs now (a) accept `summary` AND
 * `body` and map to the single column, and (b) are `.strict()` so any OTHER unknown key is
 * a LOUD error naming it, never a silent drop. The one remaining ambiguity — both names
 * passed with DIFFERENT values — is rejected here rather than silently picking a winner.
 *
 * CLASS: the silent-success family — an `ok` that did nothing, an empty result explaining
 * nothing, and now a WRITE that discarded its payload and said ok. A signal that does not
 * carry its own evidence forces every recipient to re-derive it, and they will not all
 * derive it correctly.
 */
import { z } from 'zod';

/**
 * Reject the one case aliasing can't silently resolve: both `body` and `summary` supplied
 * with DIFFERENT values (which one wins would be ambiguous). Equal values, or exactly one
 * of the two, resolve cleanly via {@link resolveBodyAlias}. Shared by create and update so
 * the message and the rule never drift. Pure; add via `.superRefine`.
 */
export function rejectBodySummaryConflict(
  a: { body?: unknown; summary?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (a.body !== undefined && a.summary !== undefined && a.body !== a.summary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['summary'],
      message:
        '`body` and `summary` are the SAME field (WI-4492) — pass only one. You passed both with different values, so which one wins would be ambiguous.',
    });
  }
}

/**
 * Resolve the single body value from either alias. Order is irrelevant once
 * {@link rejectBodySummaryConflict} has run at validation time: at most one differs, so
 * `??` selects whichever is present. Returns `undefined` when neither is given (no edit).
 */
export function resolveBodyAlias(a: { body?: string; summary?: string }): string | undefined {
  return a.body ?? a.summary;
}
