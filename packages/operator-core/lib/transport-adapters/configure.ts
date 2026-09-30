/**
 * Operator wiring for @papercusp/desktop-ipc's host seam.
 *
 * @papercusp/desktop-ipc is project-agnostic: it doesn't know the
 * operator's env-var names. Map our branded rollback flag
 * (`PAPERCUSP_FORCE_HTTP_TRANSPORT=1`) onto the generic `forceHttp` seam here.
 *
 * ⚠ THIS RESOLVER MUST NOT READ `process.env` ALONE. Configuring the seam at
 * all makes `cfg.forceHttp` defined, which means the generic lib's own fallback
 * is never consulted — so if this resolver cannot see a value, the rollback
 * lever is dead app-wide no matter what the lib does. It read only
 * `process.env.NEXT_PUBLIC_*`, and the operator-vite SPA bundles under Vite,
 * which substitutes the text `process.env` with the literal `{}` at build time.
 * Measured in the shipped bundle 2026-08-03 (EI-19420043903144442):
 *
 *   if(typeof process<"u"){const t={}.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT;…}
 *
 * The `typeof process` guard passes, the read yields `undefined`, and the hatch
 * silently reports "off" — so the instruction our own error text gives users
 * ("set DESKTOP_IPC_FORCE_HTTP=1 to roll back") had no effect inside the app.
 *
 * Sources below are ordered by who can actually reach them:
 *   1. `localStorage` — the ONLY one an operator can set on an ALREADY-SHIPPED
 *      desktop build (devtools, no rebuild, survives reload). The real lever.
 *   2. `globalThis.__DESKTOP_IPC_ENV__` — the generic runtime bag; also what a
 *      host bootstrap seeds from build-time config.
 *   3. `process.env` — Node-side consumers; this module graph runs server-side
 *      too, where `process.env` is real rather than a build-time literal.
 *
 * Imported for side effect at the top of both transport-adapter barrels
 * (`index.ts` and `desktop-bootstrap.ts`) so the configure call runs
 * before the transport picker or the polyfill installer is first used.
 */
import { configureDesktopIpc, type DesktopIpcEnvOverrides } from '@papercusp/desktop-ipc';

/** localStorage key for the rollback lever — matches the app's `papercusp:*` convention. */
export const FORCE_HTTP_STORAGE_KEY = 'papercusp:forceHttpTransport';

/** Env name for the rollback lever, accepted bare and `NEXT_PUBLIC_`-prefixed. */
export const FORCE_HTTP_ENV_NAME = 'PAPERCUSP_FORCE_HTTP_TRANSPORT';

/**
 * Read the branded rollback lever from every source that can actually carry a
 * value in the surface doing the reading. Never throws: a lever whose own read
 * can break boot is worse than no lever, and this runs at module-eval time.
 */
export function readForceHttpLever(): string | undefined {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(FORCE_HTTP_STORAGE_KEY);
      if (v !== null) return v;
    }
  } catch {
    // A partitioned/sandboxed webview can throw on storage access.
  }
  const bag = (globalThis as { __DESKTOP_IPC_ENV__?: DesktopIpcEnvOverrides }).__DESKTOP_IPC_ENV__;
  const fromBag = bag?.[FORCE_HTTP_ENV_NAME] ?? bag?.[`NEXT_PUBLIC_${FORCE_HTTP_ENV_NAME}`];
  if (fromBag !== undefined) return fromBag;
  if (typeof process !== 'undefined') {
    const env = process.env as Record<string, string | undefined> | undefined;
    const fromEnv = env?.[FORCE_HTTP_ENV_NAME] ?? env?.[`NEXT_PUBLIC_${FORCE_HTTP_ENV_NAME}`];
    if (fromEnv !== undefined) return fromEnv;
  }
  return undefined;
}

configureDesktopIpc({
  forceHttp: () => {
    const v = readForceHttpLever();
    return v === '1' || v === 'true';
  },

  /**
   * D-008 (`no-http-anywhere-2026-07-28`): ask the shell whether the IPC bridge's
   * owner is the operator that served this document.
   *
   * This retires an undeclared HTTP carve-out. `/api/desktop/*` was excluded from
   * the IPC reroute unconditionally because those endpoints describe the SERVING
   * operator and the bridge may target a different build on a dev box. Measured in
   * a live shell, that one exclusion was the entire source of webview HTTP egress —
   * escapes recurring on the 30 s poll tick long after the polyfill installed, so
   * it was never the startup race P-011 blamed. The Rust resolver already knows the
   * answer structurally (a per-port advertisement is published BY the operator on
   * that port; only the legacy singleton fallback can name a foreign one), so we
   * read that STRUCTURED flag rather than parsing `resolution_detail` prose — which
   * would be the infer-from-a-string class D-005 exists to retire.
   *
   * Resolved once per session and cached by the seam. Any failure — no Tauri, an
   * older shell whose `IpcStatus` predates the field, a rejected invoke — yields
   * `false`, i.e. exactly the pre-D-008 behaviour.
   */
  ipcOwnerIsContentOrigin: async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<{ ownerIsContentOrigin?: boolean; owner_is_content_origin?: boolean }>(
        'endpoint_ipc_status',
      );
      // Tauri's specta bindings emit camelCase, but a hand-rolled/older shell may
      // pass the Rust field name through verbatim. Accept either; anything else
      // (including the field being absent) is not a proof, so it stays false.
      return status?.ownerIsContentOrigin === true || status?.owner_is_content_origin === true;
    } catch {
      return false;
    }
  },
});
