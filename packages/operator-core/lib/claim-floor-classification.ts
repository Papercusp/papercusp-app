/**
 * STRUCTURAL vs TRANSIENT claim floors — the single source of truth for "will this
 * item EVER become claimable on its own?"
 *
 * WHY THIS FILE EXISTS. `explainIssueClaimFloors` answers *which* floor refuses a row.
 * Several callers need a different question: is that refusal SELF-CLEARING (wait and it
 * resolves) or STRUCTURAL (nothing changes until a human or agent writes to the row)?
 * That axis was being answered by hand, separately, in every caller — and the copies had
 * already diverged into three incompatible answers (WI-2141964, measured 2026-09-02):
 *
 *   - `ALL_ISSUE_CLAIM_FLOORS_PASS` (scheduler/get-next.ts) ANDs 17 floors — the claim bar.
 *     Correct, and PINNED against live result-column metadata so it cannot drift.
 *   - `STRUCTURALLY_UNCLAIMABLE_FLOORS` (agent-tools/work_items/set_priority.ts) listed 10,
 *     with NO guard — so the 6 floors it never classified produced no steering warning at
 *     all, silently reproducing the very symptom EI-19932455002723461 was filed for.
 *   - `unservable-critical-watchdog` hard-coded TWO (`lane='observation' OR
 *     state='needs-human'`) directly in its SQL, so it was blind to 26 aged `critical`
 *     items that were genuinely structurally stranded.
 *
 * Each copy was individually defensible and collectively wrong, and nothing failed when
 * they disagreed — the silent-wrong-answer shape. One classification, imported by every
 * caller, plus the totality guard in the sibling test, is what stops copy number four.
 *
 * THE GUARD IS THE POINT (claim-floor-classification.test.ts). The floor vocabulary is
 * DERIVED, not restated here: the test asserts every key of the oracle's own
 * `ISSUE_FLOOR_EXPLANATIONS` is classified in exactly one bucket below. Add a floor to the
 * claim path and the test fails until you decide which kind it is. That decision is
 * deliberately forced rather than defaulted, because BOTH defaults are harmful and in
 * opposite directions: defaulting to structural spams every consumer with alerts for a
 * floor that clears itself, and defaulting to transient hides a genuinely stranded
 * `critical` item — which is the 19-day hide the watchdog exists to prevent.
 */
import { claimFloorLabels } from './hold-registry';

/**
 * Refusals that will NOT clear on their own. The row stays invisible to
 * `scheduler:get_next` / `work_items:claim_next` / `work_items:claimable` until someone
 * WRITES to it, so raising severity or setting a `feature_order` changes nothing.
 *
 * DERIVED from the hold registry (plan unified-bug-pipeline-and-honest-queue-2026-10-05
 * D-026): each label's class, clearer, re-check time and provenance live on its
 * `claim-floor` entry in hold-registry.ts. Change a floor's class there, never here.
 */
export const STRUCTURAL_CLAIM_FLOORS: ReadonlySet<string> = claimFloorLabels('structural');

/**
 * Refusals that CLEAR ON THEIR OWN. Alerting or warning on these is noise: the wait is
 * bounded and something else already owns ending it — the registry entry names what.
 * Claimant-specific holds (D-023 verification conflict) are excluded: they are claim-door
 * filters, not floors the oracle reports.
 */
export const TRANSIENT_CLAIM_FLOORS: ReadonlySet<string> = claimFloorLabels('transient');

/**
 * Not a floor at all — the oracle reports it when the id does not resolve. Classified
 * explicitly (rather than omitted) so the totality guard stays a genuine partition and
 * cannot be satisfied by silently dropping a label.
 */
export const NON_FLOOR_LABELS: ReadonlySet<string> = new Set(['not-found']);

/**
 * Is this refusal one that nothing will clear on its own?
 *
 * `null`/`undefined` (the row is admissible) is NOT structural — a claimable row is not
 * stranded. An UNRECOGNISED label is also not structural: that is the fail-quiet
 * direction for consumers, and the totality guard is what makes an unrecognised label
 * impossible to ship rather than something callers must defend against at runtime.
 */
export function isStructurallyUnclaimable(refusedBy: string | null | undefined): boolean {
  return refusedBy != null && STRUCTURAL_CLAIM_FLOORS.has(refusedBy);
}
