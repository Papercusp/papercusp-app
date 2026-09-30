import { useSyncExternalStore } from 'react';
import { getGridThemeVersion, subscribeGridTheme } from './grid-theme';

/**
 * Re-render a grid component when the host re-injects colours via
 * `configureGridColors` (e.g. on a runtime theme switch). The canvas can't read
 * CSS vars, so this is how a live grid picks up a new palette without a reload.
 * Call it at the top of any component that reads GRID_COLORS / glideTheme / the
 * derived style bindings.
 */
export function useGridTheme(): number {
  return useSyncExternalStore(subscribeGridTheme, getGridThemeVersion, getGridThemeVersion);
}
