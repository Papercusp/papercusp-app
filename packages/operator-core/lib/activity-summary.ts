/**
 * activity-summary.ts — operator-core adapter path for the cross-CLI activity
 * normalizer.
 *
 * The normalizer (summariseActivity + helpers) moved to the generic
 * `@papercusp/activity-bridge` lib (generalize-libs-to-generic-2026-06-05, D-003 #10).
 * This file re-exports its surface so operator-core-relative imports resolve
 * unchanged. New code should import from `@papercusp/activity-bridge` directly.
 */
export {
  summariseActivity,
  summariseTodos,
  clip,
  basename,
  firstPath,
  commandText,
  capDetail,
} from '@papercusp/activity-bridge';
export type { ActivitySummary, TodoItem, ToolInput } from '@papercusp/activity-bridge';
