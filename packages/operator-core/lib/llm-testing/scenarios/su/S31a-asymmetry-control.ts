/**
 * SU-S31a — ARM A (control): status-quo handoff, bare Did / Left / Next.
 *
 * The peer's checkpoint says what it DID and nothing about what it knows or
 * what it could not settle. The engineer is not told the dedupe key, not told
 * the duplicate count, and not told that the pre-2026-07-01 old-key question is
 * open.
 *
 * This arm is EXPECTED to hit `no-duplicate-rederivation` — it has to re-derive
 * what it was never told. That warning rate is the point: it is the magnitude
 * ceiling on what an asymmetry marker could ever save. It is not a defect of
 * the agent, and it must not make the canonical SU regression suite red.
 *
 * See `_S31-asymmetry-world.ts` for the full experimental design and the
 * pre-registered decision rule.
 */

import { HANDOFF_CONTROL, makeAsymmetryArm } from './_S31-asymmetry-world';

export const SU_S31A_ASYMMETRY_CONTROL = makeAsymmetryArm(
  'su-S31a-asymmetry-control',
  HANDOFF_CONTROL,
);

export default SU_S31A_ASYMMETRY_CONTROL;
