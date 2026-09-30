/**
 * system-health — the single whole-system health aggregation
 * (system-health-tab-2026-06-15, D-001). ONE model, TWO consumers: the read-only
 * Health tab (full human view) + the overwatch role's brief (actionable subset).
 */
export * from './types';
export * from './thresholds';
export {
  computeSystemHealth,
  runSystemHealthTick,
  preWarmSystemHealth,
  getSystemHealth,
  resolveSystemHealth,
  lastSystemHealth,
  _resetSystemHealthCache,
} from './compute';
