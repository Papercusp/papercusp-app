/**
 * @papercusp/activity-bridge — normalize cross-CLI coding-agent hook events into a
 * uniform activity record and persist them through an injected telemetry store.
 *
 * Two pieces:
 *   - normalize.ts — pure: a raw native tool call / lifecycle / todo snapshot from
 *     any CLI (Claude Code, Codex, OMP-style) → `{ kind, summary, detail }`. One
 *     summary impl shared by every CLI's hook, instead of one per hook.
 *   - store.ts — the `TelemetryStore` ingest seam + `recordActivity()` flow. The
 *     host implements `append` over its own store (PG / SQLite / memory); reading
 *     records back is host-shaped and out of scope for the port.
 *
 * Zero host coupling — the consumer supplies the store; the lib names no app. First
 * consumer is the Papercusp cross-CLI fleet view, but the lib is consumer-agnostic.
 */

export {
  summariseActivity,
  summariseTodos,
  clip,
  basename,
  firstPath,
  commandText,
  capDetail,
} from './normalize';
export type { ActivitySummary, ToolInput, TodoItem } from './normalize';

export {
  normalizeReport,
  recordActivity,
  SUMMARY_CAP,
} from './store';
export type {
  ActivityKind,
  ActivityPhase,
  RawActivityReport,
  ActivityRecord,
  TelemetryStore,
} from './store';
