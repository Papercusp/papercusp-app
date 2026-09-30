/**
 * turn-end-observation-policy.ts — the shared "do a turn-end observation pass" clause for the
 * operator-launched-role prompt base (owner ask 2026-06-23: ALL agents should surface observations
 * at the END of every turn, not only file friction reactively when it hits).
 *
 * RELATION to the existing observation surfaces (deliberately complementary, not a duplicate):
 *   - FRICTION_TRIPWIRE (renderFrictionTripwire) = REACTIVE — file friction the MOMENT it hits;
 *     explicitly NOT a per-turn pass.
 *   - OBSERVATION_RUBRIC_NUDGE (renderObservationRubricNudge) = HOW to grade an observation you file.
 *   - THIS = the DELIBERATE end-of-turn reflection PASS (the bee.md / su-playbook step), generalized
 *     to every operator-launched role (operator / oracle / sentinel / … previously lacked it).
 * The bee base + su playbooks already carry their own turn-end pass, so this is injected ONLY via
 * `assembleRolePrompt` (operator-launched roles) to avoid double-injection there. Token-light by the
 * "routine turn ⇒ record nothing" guard, so a normal conversational turn pays ~nothing.
 */
export const TURN_END_OBSERVATION = [
  '## Turn-end observation pass',
  '',
  'Before you end or yield a turn, take ONE quick pass over what happened THIS turn. If it surfaced',
  'something a FUTURE agent would benefit from — recurring friction, a workaround, a tool/doc/process/',
  'capability gap, an infra weakness, a surprising failure, or a notably effective approach — capture',
  'it once. Branch on whether you can name a SPECIFIC, PLAUSIBLE fix (need not be certain):',
  '• Have such a fix AND it is SMALL + in scope → just FIX it inline and record it (the work-item rule).',
  '• Have such a fix but it is OUT of scope / a detour → file an EI: `improvements:capture { kind,',
  '  title, body:<the fix> }` (kind:bug when genuinely broken + you have the fix = auto-implement-',
  '  eligible; change|feature otherwise) — enters the work queue, claimable.',
  '• NO specific fix yet → `improvements:capture { lane:"observation", title, body, observation:{ kind,',
  '  scope, confidence, refs } }` — a cheap pre-idea Scout reads to generate ideas, so the signal is not',
  '  lost WITHOUT an expensive search now.',
  '**Routine turn ⇒ record NOTHING and move on.** One signal → one record. Name the concrete',
  'tool/file/WI/step; for an observation do NOT dedup or search history (handled downstream).',
].join('\n');

/** The shared turn-end observation clause, injected into every operator-launched role's prompt base
 *  by `assembleRolePrompt`. */
export function renderTurnEndObservation(): string {
  return TURN_END_OBSERVATION;
}
