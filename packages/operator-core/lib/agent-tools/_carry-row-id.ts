/**
 * _carry-row-id — the ONE optional stable row-identity schema shared by every
 * carry surface's walls/checks rows (P-013).
 *
 * loop:checkpoint and work_items:checkpoint deliberately expose the SAME row
 * contract, and the storage/merge/render layer beneath them is already shared
 * (`carryRowKey` / `sanitizeCarryRowId` in ../carry-note). Only the two Zod
 * schemas were copies — and they drifted: work_items:checkpoint's rows rejected
 * `id` outright while loop:checkpoint's accepted it, so the SAME payload was
 * valid on one surface and `invalid_args` on the other. That drift was filed
 * five separate times (EI-20253834997694796, EI-20236147445680077,
 * EI-20228409648836355, EI-20254509551788706, EI-20212648190769643) before it
 * was fixed, which is the tell that a copied contract was the wrong shape.
 * Both tools now import this constant, so the contract cannot drift again.
 *
 * The 40-character bound is a real STORED identity limit: rendered/parser
 * anchors and `sanitizeCarryRowId` use the same bound. The INPUT backstop is
 * deliberately looser so a recovery payload can be repaired at the handler
 * boundary and told that its identity changed, rather than rejected whole.
 */
import { z } from 'zod';

import { CARRY_CAP_HARD_MULTIPLE, CARRY_ROW_ID_MAX } from '../carry-note';

const CARRY_ROW_ID_INPUT_HARD_MAX = CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE;

/**
 * Shared text schema for carried wall/check fields.
 *
 * The handler has a deliberate soft cap: values over it are accepted, truncated,
 * and reported so one slightly-too-long field cannot discard the whole checkpoint.
 * Keep the hard Zod backstop as a sanity limit, but publish the soft limit beside
 * it so generated tool schemas do not make the stored contract look 4x larger.
 */
export function carryRowTextSchema(
  softMax: number,
  description: string,
  options: { min?: number } = {},
) {
  let schema = z.string();
  if (options.min !== undefined) schema = schema.min(options.min);
  const hardMax = softMax * CARRY_CAP_HARD_MULTIPLE;
  return schema.max(hardMax).meta({ 'x-soft-maxLength': softMax }).describe(
    `${description} Soft cap: ${softMax} chars; longer values are accepted and truncated with a reported repair. ` +
      `Hard input backstop: ${hardMax} chars; larger values are rejected.`,
  );
}

export const CARRY_ROW_ID_SCHEMA = z
  .string()
  .max(CARRY_ROW_ID_INPUT_HARD_MAX)
  .optional()
  .describe(
    "Stable id for this row (e.g. 'gate-green'), independent of wording. Lets you RE-WORD the claim without " +
      'losing its evidence/age, and is what rowsMode:\'merge\' upserts on. Stored identities are limited to 40 characters; bounded longer inputs are repaired and reported, while inputs over the hard backstop are rejected. Omitted ⇒ identity is the claim text.',
  );

/**
 * P-025 (review-system-rework-reduction-2026-09-23): name the carried row this row
 * EDITS, so re-wording an id-less row at the row cap is a one-row write instead of a
 * net addition that evicts the carried tail. Resolved by `resolveCarryRowRefs`.
 */
export const CARRY_ROW_REPLACES_SCHEMA = z
  .string()
  .max(CARRY_ROW_ID_INPUT_HARD_MAX * 25)
  .optional()
  .describe(
    "Edit a carried row in place: its [#id] or exact claim. Keeps its evidence/age; the row gains a stable id. " +
      'Unmatched refs are reported.',
  );
