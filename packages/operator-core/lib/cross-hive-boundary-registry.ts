/**
 * cross-hive-boundary-registry — the process-local registry of LIVE, boot-wired
 * cross-Hive boundaries (hive-network-surface-2026-06-11 P-001/P-003, briefs
 * B-01 + B-04 seam).
 *
 * A Hive's boundary is wired ONCE at operator boot (`wireCrossHiveBoundary`,
 * B-01) — that single instance owns the only `papercusp/cross-hive` Protomux
 * channel on the shared swarm and the only inbound subscription. The front-door
 * SEND tools (`pot:ask` / `pot:request_work`, B-04) must reuse THAT instance's
 * `send()`; constructing a second transport for the same Hive would re-open the
 * same protocol on the shared connection and double-process inbound replies.
 *
 * So the boot wiring REGISTERS each boundary here keyed by (workspaceId,
 * potSlug); the send tools RESOLVE it. A Hive that is private / un-published /
 * not-yet-booted has no entry — `getCrossHiveBoundary` returns undefined and the
 * caller surfaces a clear "boundary not live" error rather than silently opening
 * a duplicate transport.
 *
 * Process-local + ephemeral by design (the wirings are live swarm objects, not
 * durable state — they don't belong in PG): repopulated on every boot.
 */
import type { CrossHiveBoundaryWiring } from './cross-hive-wiring';

const registry = new Map<string, CrossHiveBoundaryWiring>();

function key(workspaceId: string, potSlug: string): string {
  return `${workspaceId}::${potSlug}`;
}

/**
 * Register a live boundary for a Hive (called by the boot wiring after
 * `wireCrossHiveBoundary`). Replaces any prior entry — re-wiring on a republish /
 * visibility change is idempotent at the registry.
 */
export function registerCrossHiveBoundary(
  workspaceId: string,
  potSlug: string,
  wiring: CrossHiveBoundaryWiring,
): void {
  registry.set(key(workspaceId, potSlug), wiring);
}

/**
 * The live boundary for a Hive, or undefined when none is wired (private /
 * un-published / pre-boot). The send tools treat undefined as "boundary not
 * live" — they never construct a fallback transport.
 */
export function getCrossHiveBoundary(
  workspaceId: string,
  potSlug: string,
): CrossHiveBoundaryWiring | undefined {
  return registry.get(key(workspaceId, potSlug));
}

/** Drop a Hive's entry (called when a boundary is torn down / the Hive goes dark). */
export function unregisterCrossHiveBoundary(workspaceId: string, potSlug: string): void {
  registry.delete(key(workspaceId, potSlug));
}

/** Every (workspaceId, potSlug) with a live boundary right now (diagnostics). */
export function liveCrossHiveBoundaries(): Array<{ workspaceId: string; potSlug: string }> {
  return [...registry.keys()].map((k) => {
    const [workspaceId, potSlug] = k.split('::');
    return { workspaceId: workspaceId ?? '', potSlug: potSlug ?? '' };
  });
}

/** Clear the whole registry — TEST ONLY (isolates registry state between cases). */
export function __clearCrossHiveBoundaryRegistry(): void {
  registry.clear();
}
