#!/usr/bin/env node
/**
 * Spawner process-isolation sidecar — DEV entrypoint (WI-344 ③, plan
 * spawner-sidecar-offload-2026-06-30).
 *
 * Thin shim. The JSON-RPC server + RPC dispatch live in operator-core
 * (`spawner-sidecar-server.ts` → runSpawnerSidecarServer), which calls the REAL
 * `spawnInvokeOnce` (the agent-spawn chokepoint) inside the sidecar process. This
 * file exists so a dev tree can run the sidecar directly via
 * `tsx apps/operator/bin/spawner-sidecar.ts`.
 *
 * The PACKAGED operator ships only the bundled `serve.mjs` (no separate bin to
 * `npx tsx`), so there the spawner re-execs serve.mjs with
 * PAPERCUSP_SPAWNER_SIDECAR_MODE=1 and serve.ts calls the SAME
 * runSpawnerSidecarServer() (see spawner-sidecar-spawn.ts + serve.ts). The server
 * logic deliberately does NOT live here — esbuild bundles every module into
 * serve.mjs, so an auto-running guard in a bundled bin would resolve
 * `import.meta.url === argv[1]` TRUE on every boot and start a stray sidecar.
 *
 * Reached ONLY when the OFF-by-default `papercusp-spawner-sidecar` flag is ON.
 *
 * Environment:
 *   PAPERCUSP_SPAWNER_IPC_SOCKET — absolute Unix socket path (resolveSpawnerSocketPath()).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runSpawnerSidecarServer } from '@papercusp/operator-core/lib/fleet/spawner-sidecar-server';

// Auto-run only when invoked directly (dev: tsx apps/operator/bin/spawner-sidecar.ts).
// The packaged path calls runSpawnerSidecarServer() from serve.ts instead.
// Symlink-robust (WI-1443): also compare argv[1]'s realpath (papercup -> papercusp).
const invokedDirectly = ((): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) runSpawnerSidecarServer();
