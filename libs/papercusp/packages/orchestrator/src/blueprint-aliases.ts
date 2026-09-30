/**
 * Blueprint-id transition aliases (domain-generic-hive-architecture-2026-06-18,
 * Brief 6 / D-001 / D-011).
 *
 * The 2026-06-18 rename moved three blueprint ids:
 *   hive          → coding   (the standard coding Hive: Queen + coding bees)
 *   generic-hive  → work     (the non-coding work Hive)
 *   coding        → coding-factory  (the strict scoper→…→curator spine)
 *
 * Every IN-TREE reference was updated to the new ids. This map is the
 * TRANSITION SAFETY NET for OLD DATA the code may still encounter at runtime:
 *   - existing harness instances' `.papercusp/blueprint.yaml` `extends: hive` /
 *     `extends: generic-hive`,
 *   - the `harness_shared.blueprints` PG cache projected from those files,
 *   - any federated/remote reference still naming the old id.
 *
 * Applied at every point an id is resolved to a `blueprints/<id>/…` path (the
 * loader's `builtinBlueprintPath` + prompt-resolve's dir/prompt/overlay lookups),
 * so `extends: hive` resolves to the `coding` blueprint and a stale
 * `blueprintId: 'hive'` resolves the `coding` persona.
 *
 * NOTE: there is deliberately NO `coding → coding-factory` alias. The `coding`
 * id is REUSED (it now names the hive blueprint), so a bare `coding` reference
 * must resolve to the NEW coding (hive), not the strict spine. Instances that
 * extended the OLD strict-spine `coding` (benchmark/xbench clones) must be
 * MIGRATED to `extends: coding-factory` (step 5) — they cannot be aliased.
 *
 * Remove this map once every live instance + the PG cache are migrated to the
 * new ids (the migration's final cleanup).
 */
export const BLUEPRINT_ID_ALIASES: Readonly<Record<string, string>> = {
  hive: 'coding',
  'generic-hive': 'work',
  // cup-lexicon-full-rename-2026-07-09 P-005 (Slice D): the launch blueprints moved
  // to the cup lexicon. Same transition-safety-net contract as above — stale stored
  // references (instances' blueprint.yaml extends, the PG blueprint cache, routine
  // payloads seeded with the old ids, federated refs) resolve to the new dirs.
  bee: 'cup',
  'hive-eval': 'pot-eval',
  sentinel: 'papercup',
};

/** Map a legacy blueprint id to its current canonical id (identity if not aliased). */
export function canonicalBlueprintId(id: string): string {
  return BLUEPRINT_ID_ALIASES[id] ?? id;
}
