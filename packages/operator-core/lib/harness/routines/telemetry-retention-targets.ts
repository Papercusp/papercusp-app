/**
 * Canonical retention defaults shared by the runtime action and its seed
 * script. A non-empty stored `targets` array overrides the runtime defaults,
 * so the seed must be generated from this same list to prevent configuration
 * drift on existing installs.
 */
export interface RetentionTarget {
  category: string;
  retention_days: number;
}

/** The default unbounded diagnostic targets, including short-lived
 * agent-authored recall query text. */
export const DEFAULT_RETENTION_TARGETS: readonly RetentionTarget[] = [
  { category: 'route-invocations', retention_days: 7 },
  { category: 'tool-invocations', retention_days: 14 },
  { category: 'harness-run-output', retention_days: 14 },
  { category: 'agent-activity', retention_days: 7 },
  { category: 'memory-recall-query-text', retention_days: 3 },
];
