/**
 * Hive-grouping for the all-mode (`?scope=all`) workspace view of the Harnesses
 * tab (harnesses-tab-hive-model-2026-06-07 P-003 / D-003).
 *
 * The grouping logic was LIFTED to a shared operator-core module in Phase 3
 * (P-021) so the registry route can produce the same Hive → members structure
 * server-side (`GET /api/harness/projects/lite` now returns a `hives` field) and
 * every surface — this tab's cards, the member rail, `buildHarnessSelectOptions`
 * — consumes ONE grouping instead of each tree-inferring it. The shared module
 * also folds in the FORMAL `hive_slug` membership (shared-hive-federation) on top
 * of the Phase-1 `parent_slug` edge, so the client gains formal grouping for free
 * (D-002/D-008 "swap the grouping source without layout change").
 *
 * This file stays as the app-local import site (zero churn for existing
 * consumers + tests); it re-exports the canonical implementation.
 */
export {
  groupByHive,
  hiveRootOf,
  HIVE_KIND,
  type HiveGroup,
  type HiveGroupProject,
} from '@papercusp/operator-core/lib/harness/hive-groups';
