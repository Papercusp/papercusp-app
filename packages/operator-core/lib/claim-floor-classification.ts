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

/**
 * Refusals that will NOT clear on their own. The row stays invisible to
 * `scheduler:get_next` / `work_items:claim_next` / `work_items:claimable` until someone
 * WRITES to it, so raising severity or setting a `feature_order` changes nothing.
 */
export const STRUCTURAL_CLAIM_FLOORS: ReadonlySet<string> = new Set([
  // status is terminal or otherwise outside ISSUE_FAMILY_CLAIMABLE_STATES (=['open']).
  // `blocked` lands here: only a state write brings it back.
  'not-claimable-status',
  // a captured NOTE — by design never work-queue material (D-005).
  'observation-lane',
  // a typed capability that requires the owner; only work_items:update clears it.
  'needs-owner-action',
  // an active typed capability dependency recorded on the row itself.
  'external-blocker',
  // payload._claimHold — a durable PARK that outlives its parker's session (WI-2797).
  // A lease expires; a park does not, which is why this is structural.
  'claim-hold',
  // reserved to its own plan lane while that plan is active (WI-2118/WI-3667).
  'plan-lane-reserved',
  // an auto-filed replication-liveness detector, gated to the p2p fleet (WI-2633).
  'federation-detector',
  // an AUTO-loop-iteration bookkeeping marker, not work (EI-8802).
  'loop-noise',
  // EI-22685972259555805: a LIVE_GATE_OPS condition singleton is reserved to the
  // one registered gate fixer. It never becomes available to generic self-select
  // merely by waiting; the owner/fixer must claim it explicitly by id, or the
  // condition lifecycle must settle the row.
  'live-gate-ops',
  // already carries a terminal completion record (EI-8972).
  'already-completed',
  // needs a >=2-machine rig this caller does not have (WI-2796).
  'cross-machine-rig',
  // WI-2141964: a true-peer federated row is not self-selectable from THIS node, ever.
  // No amount of waiting makes it claimable here, so it belongs with the structural set
  // even though the previous hand-rolled copy in set_priority.ts omitted it.
  'origin',
]);

/**
 * Refusals that CLEAR ON THEIR OWN. Alerting or warning on these is noise: the wait is
 * bounded and something else already owns ending it. Each entry names what clears it.
 */
export const TRANSIENT_CLAIM_FLOORS: ReadonlySet<string> = new Set([
  // cleared when the holder releases. Steering IS effective the moment it is released,
  // which is why set_priority has always deliberately excluded it from its warning.
  'already-taken',
  // cleared by the admission promoter on its own cadence (EI-21973318733042066).
  'admission-pending',
  // cleared by the reviewer — reserved to the peer-review lifecycle "until approved".
  'agent-review',
  // cleared by elapsed ticks: "wait for six complete ran ticks".
  'watchdog-recovery-window',
  // cleared when the blocking work-item reaches a terminal state.
  'blocked-dep',
  // cleared by elapsed time; the oracle's own explanation says "Both clear on their own".
  'cooldown',
  // EI-22172757071586188: cleared when the gate greens (the condition bridge settles the
  // gate-red-streak item) — stopTheLineExplanation says so explicitly ("lifts on its own
  // when the gate greens"). Nothing about a stranded row here; it is a system-wide throttle.
  'stop-line',
]);

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
