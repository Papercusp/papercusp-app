/**
 * SU-S31d — ARM D: auto-derived provenance (`basedOn`).
 *
 * Added 2026-07-27, after the A/B/C result came back showing no advantage for
 * the authored field (C) over equivalent prose (B). Proposed by su-8d9a671c's
 * `unified-agent-state-plane-2026-07-27` P-014, which frames provenance
 * "auto-derived from recent reads" as "the honest replacement for guessing what
 * the receiver knows".
 *
 * Why this is a genuinely different question, and not a fourth variant:
 * arms B and C both require the SENDER to predict what the receiver will need
 * and then curate it. That authoring cost is paid on every handoff, and it is
 * wasted whenever the sender predicts wrong. Arm D pays no authoring cost — the
 * peer's `basedOn` block is a mechanical trace of what it read and ran, with the
 * values those calls returned, and it interprets nothing. Every planted fact is
 * RECOVERABLE from it (the key from the guard read plus the passing key test,
 * the count from the COUNT result, the undetermined question from an audit query
 * that returned zero rows) but none is STATED.
 *
 * So arm D asks: will the receiver do the inference the sender would otherwise
 * have done for it?
 *
 * ⚠ D IS NOT PART OF THE PRE-REGISTERED A/B/C DECISION RULE. It was added after
 * seeing that result and must never be used to rescue the authored-field
 * hypothesis that B-vs-C tested and did not support. Its own prediction was
 * fixed before it was run; both live in `_S31-asymmetry-world.ts`.
 */

import { HANDOFF_PROVENANCE, makeAsymmetryArm } from './_S31-asymmetry-world';

export const SU_S31D_ASYMMETRY_PROVENANCE = makeAsymmetryArm(
  'su-S31d-asymmetry-provenance',
  HANDOFF_PROVENANCE,
);

export default SU_S31D_ASYMMETRY_PROVENANCE;
