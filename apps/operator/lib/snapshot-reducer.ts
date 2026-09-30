/**
 * reduceSnapshotEvent — pure per-run snapshot map reducer for useStateSnapshots
 * (agent-tool-delta-protocol-2026-06-22, Lane D / P-009).
 *
 * Applies a wire event — a full `snapshot` or a data-carrying `delta` — to the
 * run→envelope map. Full snapshots win by version (monotonic, later wins). A delta
 * applies on top of the run's current envelope; if it can't (no base yet, or a
 * version gap → `applySnapshotDelta` returns null) the stale entry is KEPT untouched
 * — the next full snapshot / reconnect heals it. Never throws, never corrupts, and
 * returns the SAME map reference on a no-op so the React consumer skips a re-render.
 */
// Import from the ISOMORPHIC lib directly, NOT the @papercusp/agent-mcp barrel: agent-mcp is a
// server package (its barrel exports auth.ts → node:crypto, PG, …), and this reducer runs in the
// BROWSER (OperatorConversationProvider → use-state-snapshots). A VALUE import of the agent-mcp
// barrel drags the whole server surface into the SPA module graph and blanks the app at
// module-eval time (fleet incident 2026-07-04). agent-mcp itself re-exports these from tooldef,
// so this is the same symbols one hop earlier. (Type-only agent-mcp imports are fine — erased.)
//
// WI-4518: even the tooldef BARREL is a value-import hazard here — its `export * from
// './code-orchestration'` drags the vm-sandbox/orchestrate/run-script runtime into the SPA's
// EAGER graph (this reducer is on the __root path, loaded on every page). Import the one value
// we need (`applySnapshotDelta`) from the narrow `./state-delta` subpath, which pulls only the
// browser-safe delta-protocol math; the two types stay barrel type-imports (erased at build).
import { applySnapshotDelta, type SnapshotDelta } from '@papercusp/tooldef/state-delta';
import type { VersionedSnapshot } from '@papercusp/tooldef';
import type { SnapshotEnvelope } from './use-state-snapshots';

export type SnapshotWireEvent =
  | { kind: 'snapshot'; env: SnapshotEnvelope }
  | { kind: 'delta'; delta: SnapshotDelta };

export function reduceSnapshotEvent(
  byRun: Map<string, SnapshotEnvelope>,
  event: SnapshotWireEvent,
): Map<string, SnapshotEnvelope> {
  if (event.kind === 'snapshot') {
    const { env } = event;
    const existing = byRun.get(env.runId);
    if (existing && existing.version >= env.version) return byRun; // stale / duplicate
    const next = new Map(byRun);
    next.set(env.runId, env);
    return next;
  }

  const { delta } = event;
  const base = byRun.get(delta.runId);
  if (!base) return byRun; // no base yet — wait for a full snapshot
  const applied = applySnapshotDelta(base as VersionedSnapshot, delta);
  if (!applied) return byRun; // version gap → keep stale; the next full / reconnect heals
  const next = new Map(byRun);
  next.set(delta.runId, { runId: applied.runId, version: applied.version, snapshot: applied.snapshot });
  return next;
}
