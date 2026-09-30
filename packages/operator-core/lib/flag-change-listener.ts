/**
 * flag-change-listener.ts — the LISTEN side of cross-process runtime flag
 * propagation (WI-6793).
 *
 * THE BUG THIS CLOSES: `publishFlagChange` (flag-bus.ts) is an in-process
 * dispatch — the in-proc SSE channel plus the flags lib's handler set. A
 * runtime `flags:set` therefore invalidated ONLY the process that executed it.
 * Every other long-running host kept serving its cached view: plain `getFlag`
 * readers converged within the override cache TTL (~5s), but STICKY
 * `onFlagChange` subscribers — workspace-brain-scope's K1 keying latch, the
 * lexicon pack selector — held the pre-flip value until their process
 * restarted. Observed live (2026-08-02): bg-host wrote legacy '@singleton'
 * scout-tick keys for 17+ minutes after WORKSPACE_COORDINATION flipped ON,
 * because its latch never heard the flip.
 *
 * The write side is flag-override-store.ts: `set()` fires
 * `pg_notify(FLAG_CHANGE_CHANNEL, { workspaceId, key })` after the override
 * write commits. This module subscribes every long-running host to that
 * channel (via the shared pg-listen-hub connection) and, on each message:
 *   1. busts the flags lib's override read-cache (ALL scopes — a stale map
 *      served to a re-resolving latch would re-latch the OLD value), then
 *   2. re-emits `emitFlagChange(key)` locally, waking the same sticky
 *      subscribers a same-process `publishFlagChange` would.
 *
 * The originating process hears its own NOTIFY too — harmless: its direct
 * `publishFlagChange` already ran, and both steps are idempotent invalidation.
 *
 * Installed from: hono-host.ts (operator :3070/:3170 + bg-host — both the
 * cluster primary and each request worker) and the three standalone sidecars
 * (inference-gateway, spawner, substrate). The guard test in
 * flag-override-store.test.ts asserts each entrypoint wires it before serving.
 */
import { emitFlagChange, bustOverrideReadCache } from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import { hubListen } from './pg-listen-hub';
import { FLAG_CHANGE_CHANNEL } from './flag-override-store';

/** Handle one NOTIFY payload. Exported for the unit test; not a public API. */
export function handleFlagChangePayload(payload: string): void {
  let key: FlagKey | null = null;
  try {
    const parsed = JSON.parse(payload) as { key?: unknown };
    if (typeof parsed?.key === 'string') key = parsed.key as FlagKey;
  } catch {
    // Unparseable payload ⇒ treat as "something changed": null invalidates all.
  }
  // Order matters: bust the read-cache FIRST so subscribers re-resolving on the
  // change event read the store, not a ≤TTL-stale map (which would re-latch the
  // old value). All scopes, not just the active workspace's: the writer may be
  // serving a different workspace than this process's active one.
  bustOverrideReadCache();
  emitFlagChange(key);
}

let started: Promise<boolean> | null = null;

/**
 * Idempotently start this process's flag-change LISTEN. Bounded retry,
 * fail-soft (mirrors sync-sse's ensureInvalidationListener): PG may still be
 * coming up at boot; after exhaustion the host keeps serving — flag flips then
 * degrade to the pre-WI-6793 behavior (cache-TTL convergence; sticky latches
 * until restart) instead of failing anything. postgres-js re-issues LISTEN on
 * reconnect, so a dropped connection self-heals.
 */
export function ensureFlagChangeListener(
  opts: { attempts?: number; delayMs?: number; listen?: typeof hubListen } = {},
): Promise<boolean> {
  if (started) return started;
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = opts.delayMs ?? 5_000;
  const listen = opts.listen ?? hubListen;
  started = (async () => {
    for (let i = 1; i <= attempts; i++) {
      try {
        await listen(FLAG_CHANGE_CHANNEL, handleFlagChangePayload);
        return true;
      } catch (e) {
        console.error(
          `[flags] ${FLAG_CHANGE_CHANNEL} LISTEN start attempt ${i}/${attempts} failed` +
            (i < attempts
              ? ` (retrying in ${delayMs}ms):`
              : ' (giving up — runtime flag flips from OTHER processes reach this one only via cache TTL / restart):'),
          e,
        );
        if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    // Exhausted: clear the latch so a later caller can retry from scratch.
    started = null;
    return false;
  })();
  return started;
}

/** Test-only — reset the idempotency latch. */
export function _resetFlagChangeListenerForTests(): void {
  started = null;
}
