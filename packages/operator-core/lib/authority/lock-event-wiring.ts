/**
 * lock-event-wiring — boot binding for the P-015 lock-event stream
 * (shared-hive-hardening-2026-06-13).
 *
 * Installs the peer-log-backed lock-event sink + reader (./lock-event-stream)
 * against the booted harness substrate. The sink appends each authority grant /
 * release to the peer's OWN single-writer log; the reader scans the admitted set
 * for a NEW authority's instant reconstruction on takeover.
 *
 * The booted-handle accessor (`getBootedHarness`) is resolved by a LAZY dynamic
 * import at record/read time, NOT at module load — so this wiring has zero static
 * dependency on the heavy `sync/hyperbee/boot-all` module and there is no
 * import-order/cycle coupling. On a single box (or any non-federating scope) the
 * resolver finds no booted handle and the sink/reader degrade to no-op / empty —
 * the documented fail-open fallback (the reconstructor uses the heartbeat path).
 */

import { activeWorkspaceId } from '../workspace-registry';
import {
  PeerLogLockEventSink,
  PeerLogLockEventReader,
  setLockEventSink,
  setLockEventReader,
  type OwnLogAppender,
  type ReadableLog,
} from './lock-event-stream';

/** Lazily-resolved `getBootedHarness` (cached after first import). */
let _getBootedHarness:
  | ((workspaceId: string, harnessSlug: string) => {
      ownLog: OwnLogAppender;
      admitted: Map<string, ReadableLog>;
    } | null)
  | null = null;

async function resolveGetBootedHarness(): Promise<typeof _getBootedHarness> {
  if (_getBootedHarness) return _getBootedHarness;
  try {
    const mod = await import('../sync/hyperbee/boot-all');
    _getBootedHarness = mod.getBootedHarness as unknown as typeof _getBootedHarness;
  } catch {
    _getBootedHarness = null;
  }
  return _getBootedHarness;
}

/** The booted handle for a scope (harness or Hive home slug), or null. */
async function bootedHandleFor(scope: string) {
  const fn = await resolveGetBootedHarness();
  if (!fn) return null;
  try {
    return fn(activeWorkspaceId(), scope);
  } catch {
    return null;
  }
}

let _wired = false;

/**
 * Wire the peer-log lock-event sink + reader. Idempotent. Safe to call before any
 * harness is booted — the resolvers find no handle and degrade to the fallback,
 * and the next grant/takeover re-resolves.
 */
export function wireLockEventStream(): void {
  if (_wired) return;
  _wired = true;

  setLockEventSink(
    new PeerLogLockEventSink({
      resolveOwnLog: async (scope) => (await bootedHandleFor(scope))?.ownLog ?? null,
    }),
  );
  setLockEventReader(
    new PeerLogLockEventReader({
      resolveLogs: async (scope) => {
        const handle = await bootedHandleFor(scope);
        return handle ? [...handle.admitted.values()] : [];
      },
    }),
  );
}

/** Test seam: reset the wiring guard. */
export const _testing = {
  reset(): void {
    _wired = false;
    _getBootedHarness = null;
  },
};
