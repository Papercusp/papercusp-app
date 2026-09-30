/**
 * work-item-fetch-hint — the ONE builder for `work_items:get` re-fetch hints on
 * carry surfaces (EI-20451119672468393).
 *
 * Why qualification matters: `WI-<n>` ids are NOT globally unique (D-008 mints
 * them from a per-database sequence that starts at 1 — see
 * work-items-harness-scope.ts), and the surfaces that emit these hints (orient's
 * post-compaction recovery fold, the cold carry-brief/carry-doc render, the
 * turn-start orientation block) hand them to successors whose SESSION harness
 * may differ from the item's canonical one. An unqualified hint made a cold
 * successor scoped to sb-devboard-hive believe platform-harness WI-3496 was
 * gone (EI-20451119672468393). Qualifying feature-family ids is therefore
 * useful, but EI-prefixed issue ids are already workspace-unique and their
 * `work_items:get` harness argument is rejected by the transport when it names
 * another hive (EI-22563909087298663). Keep that argument off EI hints so every
 * generated read is callable from a scoped successor.
 *
 * A LEAF module on purpose (same rationale as work-items-harness-scope.ts):
 * both IO surfaces (carry-brief) and pure shapers (orient-shape) import it, so
 * it must depend on nothing and stay real under wholesale `vi.mock`s of the
 * bigger modules.
 */
export function workItemFetchHint(id: string, harness?: string | null): string {
  // `getWorkItem`'s issue-family branch resolves EI ids workspace-wide and the
  // MCP transport may reject a canonical cross-hive harness before that branch
  // runs. A carry hint must be executable by its recipient, so never attach a
  // harness to an EI-prefixed id. Feature-family WI-/F- ids still need the
  // canonical harness because WI ids are only unique within a harness.
  return harness && !id.startsWith('EI-')
    ? `work_items:get { id: '${id}', harness: '${harness}' }`
    : `work_items:get { id: '${id}' }`;
}
