/**
 * SU-S31b — ARM B (prose-equal): the same facts, unstructured.
 *
 * The peer's checkpoint carries EVERY fact arm C's information-asymmetry field
 * carries — the (harness, external_id) key, the 1,204-row count, and the
 * unresolved pre-2026-07-01 old-key question — written as ordinary narrative
 * prose with no labeled field.
 *
 * This is the load-bearing control for the BUILD decision. Information is held
 * constant against arm C, so a C-over-B difference is attributable to the
 * field's STRUCTURE, and a C ≈ B result says the structure buys nothing that
 * simply writing the asymmetry down does not already buy.
 *
 * See `_S31-asymmetry-world.ts` for the full experimental design and the
 * pre-registered decision rule.
 */

import { HANDOFF_PROSE, makeAsymmetryArm } from './_S31-asymmetry-world';

export const SU_S31B_ASYMMETRY_PROSE = makeAsymmetryArm(
  'su-S31b-asymmetry-prose',
  HANDOFF_PROSE,
);

export default SU_S31B_ASYMMETRY_PROSE;
