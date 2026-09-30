/**
 * The claimable-state allowlist shared by the scheduler claim-spec schema and the
 * `scheduler:get_next` / `work_items:claim_next` tool args (D-002, WI-1912).
 *
 * Extracted to its own dependency-free LEAF module (drain-claim-spec-hardening-2026-07-13,
 * fixing a live circular-import crash reported at claim-spec.ts:236). `work-items.ts` sits
 * at the center of a long pre-existing transitive import cycle:
 *
 *   work-items.ts -> agent-tools/search/embedder.ts -> ... ->
 *   sync/hyperbee/projections/register-all.ts -> projections/bee-claim-spec.ts ->
 *   scheduler/claim-spec.ts
 *
 * `scheduler/claim-spec.ts` importing `CLAIM_STATES_ALLOWLIST` directly from `../work-items`
 * closed that loop into a genuine cycle. Since claim-spec.ts uses the value at MODULE-EVAL
 * time (inside a top-level `z.array(z.enum(...))` schema, not inside a function body), it is
 * evaluated during the circular require before `work-items.ts` has finished executing far
 * enough to have assigned its own `CLAIM_STATES_ALLOWLIST` export (the constant sits ~2600
 * lines into that file) — so the imported binding was `undefined` at claim-spec.ts's load
 * time, crashing the fleet member that first triggered the require order.
 *
 * The allowlist itself has zero dependencies, so it belongs in a leaf module both
 * `work-items.ts` (which re-exports it for backward compatibility) and `scheduler/claim-spec.ts`
 * (which imports it directly, with no path back into the cycle) can depend on safely.
 *
 * The FULL set of statuses a pull-tool caller may request via its `states` arg
 * (scheduler:get_next / work_items:claim_next). work-item-status-full-unify P-004/P-005:
 * `open` is the single unified claimable token across BOTH families (the feature `todo`
 * was retired — migration 638 backfilled the rows, migration 642 rewrote every stored
 * spec's `states` todo→open, and the writers now emit 'open'). `failing` stays as the
 * feature re-drive phase token (a build-failed feature the pipeline may re-offer; not yet
 * folded — that is P-006). Everything else is either a resolver FLOOR (`blocked` —
 * leader-triage-only; `cursed`) or terminal — and a caller-supplied `states` must NOT be
 * able to widen past a floor. The claim-spec validator already rejects a `blocked` filter
 * TERM for exactly this reason (D-002); this allowlist closes the identical hole on the
 * sibling `states` arg (WI-1912: a fleet member passed states:['todo','open','blocked']
 * and pulled a leader-triage-only item).
 */
export const CLAIM_STATES_ALLOWLIST = ['open', 'failing'] as const;
