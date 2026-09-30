// Generic column-filter app layer (generic-column-filters-2026-06-14 Phase 2):
// the nuqs-backed STATE hook + the flag-gated visual FILTER BAR, composing the
// pure @papercusp/grid-core engine (Phase 1). Panels import from here.

export {
  useColumnFilters,
  useColumnFilterState,
  useColumnFiltersFromState,
  parseAsColumnFilters,
} from './useColumnFilters';
export type {
  UseColumnFiltersResult,
  UseColumnFiltersOptions,
  ColumnFilterController,
  ActiveChip,
  ColumnFilterStateBinding,
} from './useColumnFilters';

export { ColumnFilterBar } from './ColumnFilterBar';

export {
  countEvidenceScopeText,
  formatCountNumber,
} from './count-evidence';
export type { CountEvidence, UnknownCountReason } from './count-evidence';

// The third member of the contract: the hook owns filter STATE, the bar renders
// the CONTROLS, and this states the RESULT ("42 of 905 match" / "1821 items").
// Shared so every filterable pane counts the same way — see its header for the
// growing-fetch-window precondition that makes "of total" true.
export { filterCountLabel } from './filter-count-label';
export type { FilterCountLabel } from './filter-count-label';
