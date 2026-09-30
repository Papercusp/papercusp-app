/**
 * Substrate replication-offload (Option B, WI-604).
 *
 * THE NARROW EI-79 WIN, WITHOUT THE FULL RE-ARCHITECTURE.
 *
 * The substrate engine + every `handle.append()` caller stay IN-PROCESS (zero
 * producer churn). The only thing offloaded to the sidecar child is the raw
 * Hyperswarm peer SOCKET, so `corestore.replicate()` — the merkle-verify CPU +
 * the per-peer replication RSS, the actual EI-79 cost — runs in the sidecar
 * instead of on the operator's main event loop.
 *
 * This module is the wiring of the EXISTING, tested socket-handoff machinery
 * (`prepareSocketHandoff` / `attachSocket` / `replicateOverTransport` /
 * `registerHandleListener` in apps/operator/bin/substrate-sidecar.ts +
 * substrate-ipc-client.ts) into the LIVE swarm connection path. The 3-phase
 * handoff per accepted peer connection:
 *
 *   1. `substrate:openStore`           — idempotently open the harness's
 *                                        corestore IN THE SIDECAR (keyed by
 *                                        workspaceId::harnessSlug → storeId).
 *   2. `substrate:prepareSocketHandoff`— allocate a single-use token bound to
 *                                        that storeId.
 *   3. `proc.send({kind, handoffToken}, socket)` — transfer the raw socket
 *                                        handle out-of-band over the child IPC
 *                                        channel; then `substrate:attachSocket`
 *                                        (JSON-RPC) tells the sidecar to bind the
 *                                        arrived handle to the store and run
 *                                        `corestore.replicate(transport)`.
 *
 * ── SAFETY (OFF is byte-identical) ──
 * This whole path is reached ONLY when the OFF-by-default SUBSTRATE_SIDECAR flag
 * is ON. The swarm connection handler calls `offloadReplication()` (which returns
 * false synchronously and never schedules anything when the offload is not wired)
 * and falls back to the in-process `store.replicate(socket)` exactly as today.
 *
 * ── KNOWN LIMITATION (why the flag stays dark) ──
 * Corestore 7.x holds a PROCESS-LEVEL RocksDB file lock per storage path
 * (empirically: a second `new Corestore(samePath)` in another process throws
 * "File descriptor could not be locked"). So when the sidecar opens the harness
 * store to replicate, the MAIN process must NOT also hold that store open — but
 * the in-process merge engine + own-log + append path DO hold it. Reconciling
 * the two (relocate the merge/own-log into the sidecar, or serve merge reads
 * back over IPC) is the remaining sub-task tracked in
 * `agent-insights/lazy-substrate-boot-and-sidecar.mdx`. Until then this wiring +
 * its handoff convergence proof exist and are tested, but the flag stays OFF.
 */

import {
  getSubstrateSidecarProcess,
} from './substrate-sidecar-spawn';
import { getSubstrateIpcClient, type SubstrateIpcClient } from './substrate-ipc-client';

/** The IPC message kind the sidecar's `registerHandleListener` matches on. MUST
 *  stay in sync with apps/operator/bin/substrate-sidecar.ts. */
export const SOCKET_HANDLE_MESSAGE_KIND = 'substrate:socketHandle';

export interface OffloadReplicationOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Override the workspace root used by the sidecar to derive the storage path.
   *  Production threads the booted harness's `workspaceRoot`. */
  workspaceRoot?: string;
  /** Explicit storage dir (wins over workspaceRoot) — the per-harness hyperbee
   *  path the boot already resolved. */
  storagePath?: string;
  /** The sidecar's replication role for this connection. The CONNECTING peer
   *  drives the protocol as initiator, so the sidecar defaults to RESPONDER
   *  (false) — same default as the spike's attachSocket. */
  initiator?: boolean;
  /** Best-effort diagnostics: invoked when the handoff completes / fails. */
  onResult?: (r: { ok: boolean; connectionId?: string; error?: string }) => void;
  /** Test seams — inject a fake sidecar child + IPC client so the 3-phase
   *  handoff can be unit-tested without spawning `npx tsx`. Production leaves
   *  both undefined (the real spawn + global client are used). */
  sidecarProcessOverride?: { send: NodeSendWithHandle } | null;
  ipcClientOverride?: Pick<SubstrateIpcClient, 'call'>;
}

/** The shape of `ChildProcess.send` we use — message + an out-of-band handle. */
export type NodeSendWithHandle = (
  message: unknown,
  sendHandle?: unknown,
  callback?: (error: Error | null) => void,
) => boolean;

interface OpenStoreResult {
  storeId: string;
  isNew: boolean;
}
interface PrepareHandoffResult {
  handoffToken: string;
}
interface AttachSocketResult {
  ok: boolean;
  connectionId: string;
}

/**
 * Hand a single accepted peer socket to the sidecar for `corestore.replicate()`.
 *
 * Returns `true` when the handoff was ACCEPTED (the socket is being driven by the
 * sidecar — the caller MUST NOT also `store.replicate(socket)` in-process) or
 * `false` when the offload is not available (no sidecar / no IPC channel) so the
 * caller falls back to in-process replication. The actual JSON-RPC + handle
 * transfer runs asynchronously in the background; a failure mid-flight closes
 * the socket (Hyperswarm reconnects) rather than silently double-replicating.
 *
 * Synchronous fast-path: when no sidecar process / IPC channel is available it
 * returns false IMMEDIATELY and schedules nothing — this keeps the OFF / not-yet-
 * spawned path free of any work.
 */
export function offloadReplicationToSidecar(
  socket: unknown,
  opts: OffloadReplicationOpts,
): boolean {
  const proc =
    opts.sidecarProcessOverride !== undefined
      ? opts.sidecarProcessOverride
      : getSubstrateSidecarProcess();
  // No live child or no IPC channel → cannot transfer a handle. Fall back.
  if (!proc || typeof (proc as { send?: unknown }).send !== 'function') {
    return false;
  }
  const client = opts.ipcClientOverride ?? getSubstrateIpcClient();

  // Drive the 3-phase handoff in the background. We claim the socket NOW
  // (return true) so the connection handler skips in-process replication; if
  // any phase fails we destroy the socket so the peer reconnects (and the next
  // connection retries) — never a silent no-replication.
  void (async () => {
    try {
      // Phase 1: open (idempotent) the harness store in the sidecar.
      const open = (await client.call('substrate:openStore', {
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        workspaceRoot: opts.workspaceRoot,
        storagePath: opts.storagePath,
      })) as OpenStoreResult;

      // Phase 2: allocate a single-use handoff token bound to that store.
      const prepared = (await client.call('substrate:prepareSocketHandoff', {
        storeId: open.storeId,
      })) as PrepareHandoffResult;

      // Phase 3a: transfer the raw socket handle out-of-band over the child IPC
      // channel, correlated by token. The sidecar's registerHandleListener
      // stashes it against the prepared entry.
      await sendHandle(proc.send.bind(proc) as NodeSendWithHandle, {
        kind: SOCKET_HANDLE_MESSAGE_KIND,
        handoffToken: prepared.handoffToken,
      }, socket);

      // Phase 3b: tell the sidecar to bind the arrived handle to the store and
      // run corestore.replicate(transport, initiator). attachSocket is robust to
      // either arrival order (it waits, bounded, for the handle).
      const attached = (await client.call('substrate:attachSocket', {
        storeId: open.storeId,
        handoffToken: prepared.handoffToken,
        initiator: Boolean(opts.initiator),
      })) as AttachSocketResult;

      opts.onResult?.({ ok: true, connectionId: attached.connectionId });
    } catch (e) {
      // The socket is ours (we returned true) but the handoff failed — destroy
      // it so the peer reconnects rather than hanging un-replicated. NEVER fall
      // back to in-process here: the FD may have already crossed to the child.
      try {
        (socket as { destroy?: () => void } | null)?.destroy?.();
      } catch {
        // best-effort
      }
      opts.onResult?.({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();

  return true;
}

/** Promisified `subprocess.send(message, handle, cb)`. Rejects on a send error
 *  (a dead channel) so the caller's handoff fails cleanly + closes the socket. */
function sendHandle(
  send: NodeSendWithHandle,
  message: unknown,
  handle: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const ok = send(message, handle, (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    });
    // Some send() implementations return false (backpressure / no channel)
    // without ever invoking the callback — guard against a hung promise.
    if (ok === false && !settled) {
      settled = true;
      reject(new Error('subprocess.send returned false (no IPC channel / backpressure)'));
    }
  });
}
