/**
 * flag-override-store.ts — the ONE PG-backed runtime flag-override store, installable
 * from any operator-core process.
 *
 * WHY THIS MODULE EXISTS (codex-gateway-chatgpt-live-2026-07-09, root cause of a silent
 * class of bugs):
 * `getFlag()` consults the override store ONLY when a process has called
 * `initFlagOverrideStore()`. That call lived exclusively inside `flag-bus.ts`, which the
 * inference-gateway process does NOT import (flag-bus drags in SSE + lexicon config, which a
 * standalone gateway sidecar has no business booting). So in the gateway process
 * `overrideStore` stayed null → `loadStoredOverrides()` returned `{}` → every
 * `flags:set` / `POST /api/flags/set` runtime override was INVISIBLE, and `getFlag()` silently
 * fell through to `FLAG_DEFAULTS`. A dark flag could therefore never be turned on for the
 * gateway by the documented mechanism — the flip reported success and changed nothing.
 * (Found while activating CODEX_GATEWAY_OAUTH_PROXY: `flags:set` → ok, gateway still OFF.)
 *
 * The store definition is extracted HERE so the two installers share one implementation
 * instead of forking a second copy:
 *   • `flag-bus.ts`      — the operator/web process (also wires the SSE change bus)
 *   • `inference-gateway/sidecar-main.ts` — the standalone gateway process
 *
 * Both already depend on `operator-state-pg` (the gateway reads its account pool through the
 * same idiom), so this adds no new dependency to either.
 *
 * Idempotent: installing twice is harmless (the flags lib just replaces the store + clears its
 * cache), so a process that imports both flag-bus and this module is fine.
 */
import { initFlagOverrideStore, isOverrideStoreConfigured } from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';
import { getOrgPg } from '@papercusp/db-org';

/** The operator-state key holding the `{ [flagKey]: boolean }` override map. */
export const FLAG_OVERRIDES_STATE_KEY = 'operator_flag_overrides';

/**
 * Reserved row in the existing operator_flag_overrides table for app-wide
 * runtime overrides. Workspace ids are user slugs (lowercase alphanumeric +
 * dashes), so the `@` prefix cannot collide with a real workspace.
 *
 * EI-1831: flags:set and POST /api/flags/set are global meta-controls, but the
 * store previously wrote activeWorkspaceId(). A sidecar or hive boot pinned to
 * another workspace therefore never saw a successful flip. Reusing the table's
 * existing workspace_id partition avoids a parallel store or schema migration.
 */
export const GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID = '@global';

/**
 * PG NOTIFY channel announcing an override write to EVERY listening process
 * (WI-6793). `publishFlagChange` (flag-bus.ts) is an in-process dispatch, so
 * before this channel existed a runtime `flags:set` was invisible to every
 * OTHER long-running host: sticky `onFlagChange` subscribers (e.g.
 * workspace-brain-scope's keying latch) held the pre-flip value until their
 * process restarted — observed live as bg-host writing legacy '@singleton'
 * scout-tick keys 17+ min after WORKSPACE_COORDINATION flipped ON. The
 * listener side is flag-change-listener.ts (ensureFlagChangeListener).
 */
export const FLAG_CHANGE_CHANNEL = 'flag_override_changed';

let warnedNotifyFailed = false;

/**
 * Best-effort cross-process announce, AFTER the write committed. Never fails
 * the write: a NOTIFY miss degrades to the pre-WI-6793 behavior (peers converge
 * via the override cache TTL; sticky latches wait for a restart), which is
 * strictly no worse than not announcing at all. Loud once per process so a
 * standing failure is one greppable line, not silence.
 */
async function notifyFlagChange(key: FlagKey): Promise<void> {
  try {
    const payload = JSON.stringify({ workspaceId: GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID, key });
    await getOrgPg().sql`SELECT pg_notify(${FLAG_CHANGE_CHANNEL}, ${payload})`;
  } catch (err) {
    if (warnedNotifyFailed || process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    warnedNotifyFailed = true;
    console.warn(
      `[flags] pg_notify(${FLAG_CHANGE_CHANNEL}) failed — other processes will not see this ` +
        'override until their cache TTL expires (or restart, for sticky subscribers):',
      err,
    );
  }
}

/**
 * Install the PG-backed runtime override store into the flags lib for THIS process.
 *
 * Registered unconditionally — independent of the PostHog opt-in — so a dev box with no
 * PostHog can flip flags at runtime via `flags:set` / `/api/flags/set` instead of a
 * `PAPERCUSP_FLAG_*` env var + process restart. The flags lib layers these between test
 * overrides and PostHog, behind a short read cache.
 */
export function installFlagOverrideStore(): void {
  initFlagOverrideStore({
    // Before the first global write, the resolved map still depends on the
    // active workspace because its legacy row is the compatibility fallback.
    // Partitioning the read cache keeps those rows isolated during the cutover.
    cacheKey: () => activeWorkspaceId(),
    async load() {
      const [workspaceOverrides, globalOverrides] = await Promise.all([
        readOperatorState<Partial<Record<FlagKey, boolean>>>(FLAG_OVERRIDES_STATE_KEY),
        readOperatorState<Partial<Record<FlagKey, boolean>>>(
          FLAG_OVERRIDES_STATE_KEY,
          GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
        ),
      ]);
      // The EXISTENCE of the global row is the cutover marker. Even an empty
      // `{}` row supersedes every legacy workspace row, so clearing the last
      // global override cannot resurrect a stale local value. Until the first
      // global write creates that row, current installs keep their legacy
      // workspace behavior without an eager migration.
      return globalOverrides ?? workspaceOverrides ?? {};
    },
    async set(key, enabled) {
      const globalRow = await readOperatorState<Partial<Record<FlagKey, boolean>>>(
        FLAG_OVERRIDES_STATE_KEY,
        GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
      );
      // WI-10005101: the FIRST global write IS the cutover — creating the '@global' row
      // makes load() ignore every legacy workspace row from then on. Seed it from the
      // active workspace's legacy row so the cutover carries those overrides forward
      // instead of silently reverting them to code defaults. Measured 2026-10-01: a single
      // flags:set at 2026-09-30 00:15Z dropped 12 owner-set overrides; 4 flipped ON→OFF
      // (WATCHDOG_AUTO_CLOSE among them, so no watchdog item auto-closed for ~2 days).
      // Only the absent-row case seeds — once '@global' exists, legacy rows stay unread.
      const current =
        globalRow ??
        { ...((await readOperatorState<Partial<Record<FlagKey, boolean>>>(FLAG_OVERRIDES_STATE_KEY)) ?? {}) };
      if (enabled === null) delete current[key];
      else current[key] = enabled;
      await writeOperatorState(
        FLAG_OVERRIDES_STATE_KEY,
        current,
        GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
      );
      // WI-6793: announce cross-process AFTER the write lands. Fire-and-forget —
      // the write's success must never hinge on the announce.
      void notifyFlagChange(key);
    },
  });
}

/** Re-exported so a process (or a guard test) can assert the store actually got installed. */
export { isOverrideStoreConfigured };
