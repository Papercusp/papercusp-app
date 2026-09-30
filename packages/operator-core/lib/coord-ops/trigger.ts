/**
 * Coord-op program trigger resolution (`coordination-ops-as-blueprint-primitives-
 * 2026-06-04` D-007 — "triggered by the event system; the four-layer stack
 * closes"). A program-mode blueprint declares `triggers.event: <key>` (e.g.
 * `coordination-op:vote`). This module maps an event key → the blueprint id that
 * declares it, so the [[event-reaction-system-2026-06-04]] matcher (a separate
 * plan) can fire a deliberation by key without knowing the blueprint set.
 *
 * The actual firing is `startCoordProgramForEvent` (coord-program-workflow.ts) —
 * an event rule's `fire` resolves the key here and starts the durable program.
 * The same blueprints are ALSO directly invocable as tools (`coord:vote`, D-009),
 * so this seam is additive: present for the WHEN layer, not required for use.
 *
 * Pure (no DBOS) so the resolution is unit-testable. The built-in program
 * blueprints are enumerated here; a Cupboard-installed / forked program blueprint
 * would extend this via the composed resolver (distribution P-004).
 */
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';

/** The built-in program-mode (coord-op) blueprints. */
export const BUILTIN_PROGRAM_BLUEPRINTS = ['vote', 'deliberate'] as const;

let _map: Record<string, string> | null = null;

/** event key → blueprint id, built once from the built-in program blueprints. */
export function coordOpTriggerMap(): Record<string, string> {
  if (_map) return _map;
  const map: Record<string, string> = {};
  for (const id of BUILTIN_PROGRAM_BLUEPRINTS) {
    try {
      const { blueprint } = loadBuiltinBlueprint(id);
      const key = blueprint.triggers?.event;
      if (key) map[key] = id;
    } catch {
      /* a missing/invalid built-in blueprint just isn't a trigger target */
    }
  }
  _map = map;
  return map;
}

/** Resolve an event key to the blueprint id that declares it, or null. */
export function resolveCoordOpTrigger(eventKey: string): string | null {
  return coordOpTriggerMap()[eventKey] ?? null;
}

/** Clear the memoised map (tests / dev prompt reload). */
export function resetCoordOpTriggerMap(): void {
  _map = null;
}
