/**
 * WI-10002855 — the snapshot-fold worker thread. A thin shell: every decision lives in
 * `createSnapshotFoldHandler` (snapshot-fold-protocol.ts), which is tested directly.
 *
 * Bundled to `snapshot-fold.worker.mjs` beside the host entry by BOTH bundlers
 * (apps/operator/bin/bundle-host.sh, papercusp-desktop/bin/build-desktop-sidecar.sh);
 * `worker-scripts-bundled.test.ts` fails if either stops doing so. Under tsx the `.ts`
 * form runs directly (see `snapshotFoldWorkerPath`).
 */
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';
import { createSnapshotFoldHandler, type SnapshotFoldRequest } from './snapshot-fold-protocol.ts';
import { loadSodium, openOpCiphertext } from './hive-epoch-aead.ts';

if (!parentPort) throw new Error('snapshot-fold.worker must run as a worker thread');
const port = parentPort;

/**
 * WI-10002836 — the SOFT heap cap the host enforces (see `snapshotFoldWorkerHeapMb`: a global
 * `--max-old-space-size` silently overrides this worker's `resourceLimits`). `used_heap_size`
 * includes garbage, so a reading over the cap is confirmed by a full GC before it is reported:
 * only a LIVE set over the cap fails the fold. The GC costs nothing below the cap.
 */
const heapCapBytes: number =
  typeof (workerData as { heapCapBytes?: unknown } | null)?.heapCapBytes === 'number'
    ? (workerData as { heapCapBytes: number }).heapCapBytes
    : Number.POSITIVE_INFINITY;
let fullGc: (() => void) | null | undefined;
function resolveFullGc(): (() => void) | null {
  const exposed = (globalThis as { gc?: unknown }).gc;
  if (typeof exposed === 'function') return exposed as () => void;
  try {
    // The same fallback jest's leak detector uses when the process lacks --expose-gc.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as unknown;
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null; // unconfirmed: the raw reading (garbage included) is reported — fails safe
  }
}
// `getHeapStatistics` is per-isolate, so this is the FOLD's heap, not the host's.
function heapUsedBytes(): number {
  const used = getHeapStatistics().used_heap_size;
  if (used <= heapCapBytes) return used;
  fullGc ??= resolveFullGc();
  if (!fullGc) return used;
  fullGc();
  return getHeapStatistics().used_heap_size;
}
// D-024: the P-530 receipt filter opens `{__rekey}` rows, and the fold is synchronous,
// so sodium is loaded once here. A load failure leaves the handler without an opener:
// encrypted rows are then kept and reported as `unopenedGovernorEnvelopes`.
const sodium = await loadSodium().catch((e: unknown) => {
  console.error(`[snapshot-fold.worker] sodium-native unavailable; encrypted rows stay unfiltered: ${String(e)}`);
  return null;
});
const handle = createSnapshotFoldHandler({
  heapUsedBytes,
  ...(sodium ? { openEnvelope: (ct, key, ad) => openOpCiphertext(sodium, ct, key, ad) } : {}),
});
port.on('message', (req: SnapshotFoldRequest) => {
  const { res, transfer } = handle(req);
  port.postMessage(res, transfer);
});
