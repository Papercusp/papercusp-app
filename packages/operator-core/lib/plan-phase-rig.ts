/**
 * Whether a plan item's phase explicitly describes the live two-machine rig lane.
 *
 * Plan phases are author-controlled headings rather than a closed enum. Keep this
 * classifier deliberately narrow: only a Phase 3 marker that names a 2-machine
 * lane requires the rig floor. Callers pass the result through as a boolean so a
 * phase move also clears a stale tag on the next promotion.
 */
export function phaseRequiresTwoMachineRig(phase: string | null | undefined): boolean {
  if (!phase) return false;
  return /\bphase\s*3\b/i.test(phase) && /\b2[-\s]?machine\b/i.test(phase);
}
