#!/usr/bin/env node
/**
 * Spawner process-isolation sidecar — source and packaged entrypoint (WI-344 ③, plan
 * spawner-sidecar-offload-2026-06-30).
 *
 * Thin shim. The JSON-RPC server + RPC dispatch live in operator-core
 * (`spawner-sidecar-server.ts` → runSpawnerSidecarServer), which calls the REAL
 * `spawnInvokeOnce` (the agent-spawn chokepoint) inside the sidecar process. This
 * file exists so a dev tree can run the sidecar directly via
 * `tsx apps/operator/bin/spawner-sidecar.ts`.
 *
 * Maintained builders emit spawner-sidecar.mjs beside the host. Older installs
 * still re-exec the full host with PAPERCUSP_SPAWNER_SIDECAR_MODE=1. Both entries
 * call the same server; this entry avoids evaluating the HTTP/bootstrap graph.
 *
 * Reached ONLY when the OFF-by-default `papercusp-spawner-sidecar` flag is ON.
 *
 * Environment:
 *   PAPERCUSP_SPAWNER_IPC_SOCKET — absolute Unix socket path (resolveSpawnerSocketPath()).
 */

import './boot-malloc-arena';
import './boot-integrity-first';
import './boot-flag-store';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { installStdioPeerGuard } from '@papercusp/operator-core/lib/process-supervision/stdio-peer-guard';
import { installFatalDiagnostics } from '@papercusp/operator-core/lib/process-supervision/fatal-diagnostics';
import { startSidecarParentDeathWatch } from '@papercusp/operator-core/lib/process-supervision/parent-death-watch';
import { installTimestampedConsole } from '@papercusp/operator-core/lib/timestamped-console';
import { isBenignHostError } from '@papercusp/operator-core/lib/host-benign-errors';

// Auto-run only when invoked directly (dev: tsx apps/operator/bin/spawner-sidecar.ts).
// isCliEntry is disabled in bundles; the spawn plan supplies the mode divert.
// Symlink-robust (WI-1443): also compare argv[1]'s realpath (papercup -> papercusp).
// A dedicated plain-node build needs an explicit divert: isCliEntry deliberately
// returns false in bundles. The normal packaged host still calls the server
// directly and does not import this bin. This also preserves symlinked dev CLIs.
if (process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === '1' || isCliEntry(import.meta.url)) {
  installTimestampedConsole();
  const stdio = installStdioPeerGuard();
  installFatalDiagnostics();
  const onFault = (reason: unknown): void => {
    const continuing = process.env.PAPERCUSP_DESKTOP === '1' || isBenignHostError(reason);
    if (!stdio.peerGone()) console.error('[spawner-sidecar] process fault:', reason);
    if (!continuing) process.exit(1);
  };
  process.on('unhandledRejection', onFault);
  process.on('uncaughtException', onFault);
  // Arm before importing the server graph, as serve.ts does for packaged children.
  startSidecarParentDeathWatch();
  void import('@papercusp/operator-core/lib/fleet/spawner-sidecar-server').then(
    ({ runSpawnerSidecarServer }) => runSpawnerSidecarServer(),
    (error) => {
      if (!stdio.peerGone()) console.error('[spawner-sidecar] fatal boot:', error);
      process.exit(1);
    },
  );
}
