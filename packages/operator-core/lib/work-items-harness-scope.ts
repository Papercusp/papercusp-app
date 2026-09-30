/**
 * Cross-harness retarget detection for work-item lookups (EI-19393623437103599).
 *
 * A LEAF module on purpose. This is a pure predicate with no database dependency, and
 * its callers are the write verbs — which mock `./work-items` wholesale in their unit
 * tests (a `vi.mock` factory there replaces every export, so a guard living in that
 * module silently becomes `undefined` at exactly the call sites that most need it).
 * Keeping it standalone means the guard is real in tests too, not just in production.
 * `work-items.ts` re-exports it so `harnessScopeMismatch` is still discoverable next to
 * `getWorkItem`.
 */

/**
 * A resolved work-item whose harness CONTRADICTS the one the caller asked for.
 *
 * `requested` is what the caller named; `resolved` is the harness of the row they
 * actually got back.
 */
export interface HarnessScopeMismatch {
  requested: string;
  resolved: string;
}

/**
 * Did the resolver answer a DIFFERENT question than it was asked?
 *
 * `getWorkItem(id, harness?)` does not apply `harness` to the issue-family branch, so a
 * caller can name one pot and be handed another pot's item with no signal at all.
 * Reproduced live 2026-08-03: `work_items:get { ids:['WI-1'], harness:'hello-world-hive' }`
 * returns the `papercusp` row and echoes `harness:'papercusp'` back in its own response.
 *
 * This is reachable in practice rather than theoretically because `WI-<n>` ids are NOT
 * globally unique: D-008 (migration `142-work-items-unify.sql`) mints them from
 * `harness_shared.work_item_seq`, a PER-DATABASE sequence that STARTs at 1. So
 * `WI-1`/`WI-2`/`WI-3` exist in every long-lived store, and a fresh or recovered store
 * mints exactly those first — which is how an id minted against one store came to
 * resolve onto an unrelated two-week-old plan item in another.
 *
 * The fix is deliberately NOT to filter the lookup by harness. 56 of `getWorkItem`'s 77
 * non-test call sites pass one, and many pass it loosely (a session default, an ambient
 * slug) while relying on it being ignored — hard-filtering would convert a rare silent
 * WRONG-row into a broad silent `null`, which is strictly worse: `null` flows into
 * `if (!item)` and reads as "does not exist" rather than "I declined to answer". Every
 * currently-correct answer must keep returning the same row.
 *
 * So detect the CONTRADICTION instead, which is exactly and only the broken case: the
 * caller named a harness AND the row that came back belongs to a different one. Callers
 * decide what it is worth — reads can surface it, destructive writes warn loudly on it.
 *
 * Returns `null` when there is nothing to report: no harness was requested, the row
 * carries no harness to contradict (a workspace-global/unhomed row), or they agree.
 */
export function harnessScopeMismatch(
  item: { harness?: string | null },
  requestedHarness?: string | null,
): HarnessScopeMismatch | null {
  if (!requestedHarness) return null;
  const resolved = item.harness;
  // An unscoped row has no harness to contradict — absence is not disagreement.
  if (!resolved) return null;
  if (resolved === requestedHarness) return null;
  return { requested: requestedHarness, resolved };
}
