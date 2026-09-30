/**
 * SU-S31c — ARM C (treatment): the information-asymmetry field.
 *
 * The peer's checkpoint carries the same facts as arm B, in the labeled
 * structure P-011 proposes:
 *
 *   knownToMe         — what the writer established that the reader would
 *                       otherwise have to re-derive.
 *   couldNotDetermine — what the writer could not settle, and that bears on
 *                       the reader's work.
 *
 * Compared against arm B this isolates the field's structure; compared against
 * arm A it shows the total effect of marking the asymmetry at all.
 *
 * See `_S31-asymmetry-world.ts` for the full experimental design and the
 * pre-registered decision rule.
 */

import { HANDOFF_FIELD, makeAsymmetryArm } from './_S31-asymmetry-world';

export const SU_S31C_ASYMMETRY_FIELD = makeAsymmetryArm(
  'su-S31c-asymmetry-field',
  HANDOFF_FIELD,
);

export default SU_S31C_ASYMMETRY_FIELD;
