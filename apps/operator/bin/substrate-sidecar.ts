#!/usr/bin/env node
/**
 * Substrate process-isolation sidecar — DEV entrypoint.
 *
 * Thin shim. The JSON-RPC server + RPC dispatch live in operator-core
 * (`substrate-sidecar-server.ts` → runSubstrateSidecarServer), which fronts the
 * testable host (`substrate-sidecar-host.ts`). This file exists so a dev tree can
 * run the sidecar directly via `tsx apps/operator/bin/substrate-sidecar.ts`.
 *
 * The PACKAGED operator ships only the bundled `serve.mjs` (no separate bin to
 * `npx tsx`), so there the spawner re-execs serve.mjs with
 * PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1 and serve.ts calls the SAME
 * runSubstrateSidecarServer() (see substrate-sidecar-spawn.ts + serve.ts). The
 * server logic deliberately does NOT live here — esbuild bundles every module
 * into serve.mjs, so an auto-running guard in a bundled bin would resolve
 * `import.meta.url === argv[1]` TRUE on every boot and start a stray sidecar.
 *
 * Reached ONLY when the OFF-by-default `papercusp-substrate-sidecar` flag is ON.
 *
 * Environment:
 *   PAPERCUSP_SUBSTRATE_IPC_SOCKET — absolute Unix socket path (resolveSubstrateSocketPath()).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runSubstrateSidecarServer } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-server';

// Auto-run only when invoked directly (dev: tsx apps/operator/bin/substrate-sidecar.ts).
// The packaged path calls runSubstrateSidecarServer() from serve.ts instead.
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
if (invokedDirectly) runSubstrateSidecarServer();
