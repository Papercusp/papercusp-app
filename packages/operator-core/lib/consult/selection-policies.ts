/**
 * selection-policies.ts — the ONE place responder-selection bounds are written.
 *
 * unified-responder-selection-critique-and-grading-2026-08-30 D-001 [owner]:
 * the critique consult and acceptance grading must consume a shared setting
 * rather than each carrying its own copy. Before this module they did not
 * share one and neither actually had one: the grading side hard-coded a single
 * pick, and the rubric-vetting maximum lived only as PROSE in root CLAUDE.md
 * and the acceptance-rubric-vetting runbook, instructing an agent to pass
 * `max_agents:3` by hand. A number that describes system behaviour, maintained
 * by hand in two documents and enforced by nothing, is the derived-truth-ladder
 * failure the repo names explicitly.
 *
 * These constants are the source; everything else DERIVES from them. Do not
 * restate a bound in a doc, a prompt, or a second constant — reference the
 * policy key instead, so the documented number cannot drift from the enforced
 * one.
 */
import { configureSelectionPolicies, selectionPolicy, type SelectionBounds } from '@papercusp/ranked-selection';

/**
 * The rubric-vetting critique consult (the meta-rubric vetting step).
 * D-004 [owner 2026-08-30]: max 3 → 2.
 */
export const RUBRIC_VETTING_POLICY = 'rubric-vetting';

/**
 * Acceptance grading — the independent grader menu.
 * D-001/D-003 [owner 2026-08-30]: was exactly 1, now min 1 / max 2, delivered
 * as a cascade so grader 2 is woken holding grader 1's card.
 */
export const ACCEPTANCE_GRADING_POLICY = 'acceptance-grading';

/**
 * Grading-integrity audits settle one source card on the first accepted audit.
 * Keep each reservation epoch to one auditor; a new attempt requires a new
 * reservation rather than cascading another auditor under the same lease.
 */
export const GRADING_INTEGRITY_AUDIT_POLICY = 'grading-integrity-audit';

/**
 * Outside-lineage review of a started acceptance-BAR amendment
 * (review-routing-through-relevance-router-2026-09-26 D-001/D-002 [owner]).
 * One approval settles an amendment, so one reviewer per attempt; a decline or
 * expiry moves to the next eligible candidate rather than seating two at once.
 */
export const ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY = 'acceptance-bar-amendment-review';

/**
 * Every other get_feedback consult (plan-start, goal kickoff, ad-hoc peer
 * consults). D-004 [owner 2026-08-30] deliberately LEAVES this at max 3: the
 * owner's 3→2 change is scoped to vetting and grading, and this constant is
 * read by every consult in the system.
 */
export const CONSULT_DEFAULT_POLICY = 'consult-default';

/**
 * The bounds themselves. This object is the single source — the generic
 * registry below is populated from it, and the legacy DEFAULT_* constants in
 * get-feedback-core re-export from it rather than declaring their own copy.
 */
export const SELECTION_POLICIES: Readonly<Record<string, SelectionBounds>> = Object.freeze({
  [CONSULT_DEFAULT_POLICY]: { min: 1, max: 3 },
  [RUBRIC_VETTING_POLICY]: { min: 1, max: 2 },
  [ACCEPTANCE_GRADING_POLICY]: { min: 1, max: 2 },
  [GRADING_INTEGRITY_AUDIT_POLICY]: { min: 1, max: 1 },
  [ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY]: { min: 1, max: 1 },
});

/**
 * Registered on import. Import order is not something a caller should have to
 * reason about: any module that reaches a selection site has necessarily
 * imported this one (directly or through get-feedback-core), so registration
 * cannot be missed by forgetting a startup call. `configureSelectionPolicies`
 * merges, so a test that overrides one key is not undone by a re-import.
 */
configureSelectionPolicies(SELECTION_POLICIES);

/**
 * Explicit re-registration, for a host that wants a startup assertion or a test
 * that cleared the registry. Idempotent.
 */
export function ensureSelectionPolicies(): void {
  configureSelectionPolicies(SELECTION_POLICIES);
}

/**
 * The global consult default, derived rather than restated.
 * consult-min-max-and-rubric-vetting-2026-08-17 D-003 [owner]: every consult
 * selects at least the best-available live candidate even below the relevance
 * floor (labelled via:'minimum'), so the minimum is 1 system-wide.
 */
export const DEFAULT_MIN_RESPONDERS = SELECTION_POLICIES[CONSULT_DEFAULT_POLICY]!.min;
/** The global consult cap — unchanged at 3 per D-004; see CONSULT_DEFAULT_POLICY. */
export const DEFAULT_MAX_RESPONDERS = SELECTION_POLICIES[CONSULT_DEFAULT_POLICY]!.max;

/**
 * The ONE rendering of the rubric-vetting consult's call shape for agent-facing
 * prose — the ship-gate refusal, the goal-disposition refusal, and (pinned by
 * `doc-claims/selection-policy-prose`) CLAUDE.md and the vetting runbook.
 *
 * P-006: this bound was typed by hand at four sites, and had already drifted —
 * every one of them still read "max 3" after D-004 lowered the vetting cap to 2,
 * so the system was instructing agents to request a menu wider than it enforces.
 * A number that describes code, maintained by hand in prose, is the exact
 * derived-truth-ladder failure; rung 1 is to stop keeping the second copy.
 *
 * Two properties are deliberate. It reads through `selectionPolicy()` rather
 * than off `SELECTION_POLICIES` directly, so it reports what is ENFORCED at the
 * selection site (a test override included) instead of what this file declares.
 * And it leads with the policy KEY: a caller who passes `policy` types no number
 * at all, so the next bound change needs no prose edit anywhere.
 */
export function rubricVettingConsultHint(): string {
  const { min, max } = selectionPolicy(RUBRIC_VETTING_POLICY);
  return (
    `pass policy:'${RUBRIC_VETTING_POLICY}' and no hand-typed count ` +
    `(selection is automatic; that key currently carries min ${min} / max ${max} responders)`
  );
}
