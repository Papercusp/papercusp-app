/**
 * Substrate sidecar JSON-RPC server (extracted from
 * apps/operator/bin/substrate-sidecar.ts, P-006).
 *
 * The Unix-socket JSON-RPC server + child-process IPC handle channel that fronts
 * the testable host (substrate-sidecar-host.ts). It lives in operator-core (NOT
 * the bin) so the SAME code can be started two ways without the esbuild trap that
 * an auto-running bin guard would spring — esbuild bundles every module into the
 * single serve.mjs, so a bin's `import.meta.url === argv[1]` guard would resolve
 * TRUE on every operator boot and start a stray sidecar in the main process:
 *   - DEV     : apps/operator/bin/substrate-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts diverts here under PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1
 *     (the spawner re-execs serve.mjs itself — the packaged operator ships no
 *     separate bin to tsx).
 *
 * No top-level side effects: importing this module never starts a server; only
 * runSubstrateSidecarServer() does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { Duplex } from 'node:stream';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from './substrate-sidecar-host';
import { installFlagOverrideStore } from '../../flag-override-store';
import { ensureFlagChangeListener } from '../../flag-change-listener';
import { resolveSubstrateSocketPath, reapOrphanedSubstrateSockets } from './substrate-socket-path';
import {
  startEventLoopLagMonitor,
  type LagMonitorHandle,
} from '../../event-loop-lag-monitor';

// JSON-RPC 2.0 response builders
function rpcResponse(result: unknown, id: number | string | null): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', result, id };
}
function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id };
}

async function handleRequest(
  host: SubstrateSidecarHost,
  data: string,
  callback: (response: string) => void,
): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(data);
  } catch {
    callback(JSON.stringify(rpcError(-32700, 'Parse error', null)));
    return;
  }
  const req = request as { jsonrpc?: string; method?: string; params?: unknown; id?: number | string | null };
  if (!req.method) {
    callback(JSON.stringify(rpcError(-32600, 'Invalid Request', req.id ?? null)));
    return;
  }
  const handler = host.methods[req.method];
  if (!handler) {
    callback(JSON.stringify(rpcError(-32601, 'Method not found', req.id ?? null)));
    return;
  }
  try {
    const result = await handler(req.params);
    callback(JSON.stringify(rpcResponse(result, req.id ?? null)));
  } catch (e) {
    const err = e as { code?: number; message?: string; data?: unknown };
    const code = typeof err.code === 'number' ? err.code : -32603;
    const msg = err.message ?? 'Internal error';
    callback(JSON.stringify(rpcError(code, msg, req.id ?? null, err.data)));
  }
}

/** Receive Duplex handles transferred from the main process over the child IPC
 *  channel. No-op when launched without an IPC channel (control methods still
 *  work). */
function registerHandleListener(host: SubstrateSidecarHost): void {
  if (typeof process.send !== 'function') return; // no IPC channel
  process.on('message', (message: unknown, handle: unknown) => {
    const m = message as { kind?: string; handoffToken?: string } | null;
    if (!m || m.kind !== 'substrate:socketHandle' || typeof m.handoffToken !== 'string') return;
    host.receiveHandle(m.handoffToken, handle as Duplex);
  });
}

/**
 * bg-host-freeze-eventloop-stall-2026-06-30 P-005 — start the substrate sidecar's
 * OWN event-loop-lag + leak instrumentation, and return its handle.
 *
 * ROOT-CAUSE DETECTOR FAILURE this closes. With the `papercusp-substrate-sidecar`
 * flag ON, the WHOLE harness substrate — every harness's corestore, merge loop,
 * Hyperswarm join + replication — runs in THIS sidecar process, not the main
 * bg-host. The freeze's +1GB/min RSS leak therefore lives in the SIDECAR. But
 * `startEventLoopLagMonitor` (the loop-lag gauge + cpu-profile-on-saturation +
 * heap-snapshot-on-high-RSS, P-002/WI-1085) was only ever started in the MAIN
 * process (host-bootstrap.ts) — so the sidecar ran completely BLIND: no heap
 * snapshot ever captured the leaking heap (the exact gap WI-1088 flagged —
 * "WI-1085's heap-snapshot keys on the MAIN process … a sidecar-side snapshot
 * would be needed"), no cpuprofile named its synchronous culprits, and
 * `loopPressure()` was permanently 'ok' in this process (so any shed-aware tick
 * here could never shed). Starting the SAME shipped monitor here makes the sidecar
 * leak SELF-PINPOINT a `.heapsnapshot` on the live host — load it with
 * `scripts/analyze-heap-snapshots.mjs` to name the top retainer, the missing
 * evidence every prior leak-hunt pass lacked.
 *
 * Process-isolated: `startEventLoopLagMonitor`'s one-per-process guard is a module
 * global, fresh in this child process — so this is the sidecar's own monitor, never
 * a duplicate of the main host's.
 *
 * Thresholds default LOWER than the main host's 8 GB. Recent sidecar instances peak
 * at ~6-10 GB and recycle (cgroup MemoryMax=18G, WI-1086) BEFORE 8 GB, so an 8 GB
 * trigger would routinely miss the capture; 4 GB sits above a healthy ~25-harness
 * baseline yet below the recycle, capturing a clearly-leaking heap. Each knob is
 * independently env-tunable (a `PAPERCUSP_SIDECAR_*` override that falls back to the
 * shared `PAPERCUSP_*` the main host uses, since the sidecar inherits the host env).
 * Best-effort + never throws — observability must never wedge the process it watches.
 */
export function startSidecarObservability(): LagMonitorHandle | null {
  try {
    return startEventLoopLagMonitor({
      // cpu-profile-on-saturation: names the synchronous frames eating the sidecar
      // loop. PAPERCUSP_SIDECAR_LOOP_PROFILER / PAPERCUSP_LOOP_PROFILER = '0' disables.
      profileOnSaturation:
        (process.env.PAPERCUSP_SIDECAR_LOOP_PROFILER ?? process.env.PAPERCUSP_LOOP_PROFILER) !==
        '0',
      // heap-snapshot-on-high-RSS: the authoritative leak-pinpoint, but it PAUSES the
      // loop for its whole serialization (WI-3255: ~30% loop-time on a large heap) — a
      // real cost that's only worth paying while actively hunting a genuine leak. The
      // 2026-07-01 leak this was enabled for is fixed; default OFF now (opt in per-site
      // with PAPERCUSP_SIDECAR_HEAP_SNAPSHOT=1 / PAPERCUSP_HEAP_SNAPSHOT=1 for a new hunt).
      heapSnapshotOnHighRss:
        (process.env.PAPERCUSP_SIDECAR_HEAP_SNAPSHOT ?? process.env.PAPERCUSP_HEAP_SNAPSHOT) ===
        '1',
      heapSnapshotRssMb:
        Number(
          process.env.PAPERCUSP_SIDECAR_HEAP_SNAPSHOT_RSS_MB ??
            process.env.PAPERCUSP_HEAP_SNAPSHOT_RSS_MB,
        ) || 4096,
      // The sampling profiler is the safe alternative (O(1), no loop pause, dumps a
      // few-KB .heapprofile instantly) — keep it on regardless of the full-snapshot
      // default above (it previously silently inherited heapSnapshotOnHighRss's value).
      heapSamplingOnHighRss: true,
    });
  } catch {
    // Observability must NEVER wedge the sidecar it observes.
    return null;
  }
}

/**
 * Start the substrate sidecar JSON-RPC server (control socket + IPC handle
 * channel) and own the process lifecycle (SIGTERM/SIGINT → host.closeAll). The
 * socket path is ABSOLUTE (resolveSubstrateSocketPath()) — never CWD-relative.
 */
export function runSubstrateSidecarServer(): void {
  // Runtime flag overrides (EI-8867 / WI-3628). `getFlag()` consults the PG override store ONLY
  // in a process that installed it. This is a STANDALONE process (dev: `tsx
  // bin/substrate-sidecar.ts`; packaged: serve.mjs re-exec'd with PAPERCUSP_SUBSTRATE_SIDECAR_MODE),
  // and it does not import flag-bus — so without this, every `flags:set` would report success and
  // be silently INVISIBLE here, with getFlag() falling through to FLAG_DEFAULTS. That is the exact
  // failure that made the inference gateway ignore a dark flag for hours.
  // substrate-sidecar-host reads SUBSTRATE_MERGE_CURSOR_PG on the seed/persist path.
  //
  // Installed in the SERVER MAIN, deliberately NOT in bootHarnessSubstrate(): that boot function
  // stays PG-free + hermetic for its many merge tests. This call only REGISTERS lazy callbacks —
  // no PG connection is opened until the first flag read — so the hermetic guarantee is preserved.
  // Idempotent + fail-soft: a store fault degrades to defaults exactly as before, never blocks boot.
  installFlagOverrideStore();
  // WI-6793: LISTEN for peer processes' flags:set writes (cross-process
  // invalidation — see flag-change-listener.ts). SERVER MAIN only, like the
  // store install above: bootHarnessSubstrate() stays PG-free + hermetic. This
  // one call does open a PG LISTEN connection eagerly (with bounded retry,
  // fail-soft) — acceptable here because the server main is the live process
  // entry, never a merge-test import.
  void ensureFlagChangeListener();
  const host = createSubstrateSidecarHost();
  // P-005: give the sidecar its OWN leak/saturation instrumentation. The substrate
  // (and thus the +1GB/min leak) runs in THIS process under the sidecar flag, so
  // this is the process whose RSS leak must self-capture a heap snapshot. Stopped
  // on shutdown below. See startSidecarObservability for the full rationale.
  const lagMonitor = startSidecarObservability();
  const socketPath = resolveSubstrateSocketPath();
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  // EI-7832: sweep OTHER sidecars' orphaned socket files (dead pids) before
  // claiming our own. Our own path is pid-keyed and brand-new every restart,
  // so the existsSync/unlinkSync above never catches a PRIOR process's
  // leftover file — only this reaper does. Best-effort: never blocks boot.
  try {
    const { removed, errors } = reapOrphanedSubstrateSockets();
    if (removed.length > 0) {
      console.log(`[substrate-sidecar] reaped ${removed.length} orphaned socket(s) from dead pids: ${removed.join(', ')}`);
    }
    if (errors.length > 0) {
      console.error(`[substrate-sidecar] socket reap had ${errors.length} error(s): ${JSON.stringify(errors)}`);
    }
  } catch (e) {
    console.error('[substrate-sidecar] socket reap threw (non-fatal)', e);
  }

  // EI-7832: unlink OUR OWN socket on any process exit — the graceful
  // SIGTERM/SIGINT shutdown() path already tears down the server, but a
  // hard `process.exit()` from installSidecarCrashGuards' uncaughtException
  // handler (or any other exit path) bypasses shutdown() entirely and would
  // otherwise leave this pid's socket file behind for the NEXT boot's
  // reaper to eventually clean up. `exit` fires synchronously on every exit
  // path (signals excepted only for SIGKILL, which no cleanup can survive
  // anyway), so this is the one place guaranteed to run first.
  process.on('exit', () => {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      /* best-effort — the process is exiting regardless */
    }
  });

  registerHandleListener(host);

  const server = net.createServer((socket: net.Socket) => {
    // Decode across socket-chunk boundaries. `chunk.toString()` on a chunk
    // ending mid-UTF-8-sequence yields replacement chars, which here corrupts
    // the substrate JSON-RPC REQUEST itself — and when the damage lands inside
    // a string value the request still parses, so a corrupted key or corrupted
    // replicated content is applied with no error raised anywhere. One decoder
    // per socket, so a partial sequence is held until its remaining bytes land.
    const requestDecoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += requestDecoder.write(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          void handleRequest(host, line, (response) => {
            socket.write(response + '\n');
          });
        }
      }
    });
    socket.on('error', (err) => console.error('[socket-error]', err.message));
    socket.on('end', () => {
      // Control socket closed.
    });
  });

  server.listen(socketPath, () => {
    console.log(`[substrate-sidecar] listening on ${socketPath}`);
    console.log(`PAPERCUSP_SUBSTRATE_READY socket=${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[server-error]', err.message);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[substrate-sidecar] ${signal} received, shutting down gracefully`);
    // P-005: stop the lag/leak monitor first so its timer + histogram don't keep
    // ticking against an about-to-exit loop (best-effort — never block shutdown).
    try {
      lagMonitor?.stop();
    } catch {
      /* best-effort */
    }
    void host.closeAll().finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  installSidecarCrashGuards();
}

/**
 * WI-895 fix (c) — last-resort crash guards for the sidecar process.
 *
 * The WHOLE federation engine (corestore + own-log + merge loop + swarm) runs in
 * this process under the sidecar flag; before these guards, Node's defaults meant
 * one unhandled rejection anywhere in the hyperbee/corestore/merge path KILLED the
 * process. Spawn-side auto-respawn (WI-1504) recovers a crash, but each cycle drops
 * every live replication stream and burns a respawn-window attempt — so:
 *
 *  - unhandledRejection → log loudly with the reason, KEEP RUNNING. An async fault
 *    in one harness's merge must not take down every other harness's federation.
 *  - uncaughtException  → log loudly, exit(1) so the spawn-side respawn brings up a
 *    CLEAN process (a sync throw mid-stack can leave state torn — restarting is the
 *    safe recovery, and now it is at least attributed in the journal).
 *
 * Idempotent + exported for tests.
 */
export function installSidecarCrashGuards(): void {
  if (installedRejectionGuard) return;
  installedRejectionGuard = (reason: unknown) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[substrate-sidecar] UNHANDLED REJECTION (kept alive, WI-895c): ${msg}`);
  };
  installedExceptionGuard = (err: Error) => {
    console.error(`[substrate-sidecar] UNCAUGHT EXCEPTION — exiting for a clean respawn (WI-895c): ${err.stack ?? err.message}`);
    process.exit(1);
  };
  process.on('unhandledRejection', installedRejectionGuard);
  process.on('uncaughtException', installedExceptionGuard);
}

let installedRejectionGuard: ((reason: unknown) => void) | null = null;
let installedExceptionGuard: ((err: Error) => void) | null = null;

/** Test seam — remove exactly OUR guards (never a test runner's own handlers). */
export function _resetSidecarCrashGuardsForTests(): void {
  if (installedRejectionGuard) process.removeListener('unhandledRejection', installedRejectionGuard);
  if (installedExceptionGuard) process.removeListener('uncaughtException', installedExceptionGuard);
  installedRejectionGuard = null;
  installedExceptionGuard = null;
}
