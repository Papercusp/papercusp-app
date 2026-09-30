/**
 * Real `node:cluster` PRIMARY fixture for cluster-owner-rpc.integration.test.ts
 * (WI-10003626).
 *
 * The sibling test drives the relay through a hand-built cluster-shaped view.
 * This fixture removes that stand-in: it is a genuine cluster primary that wires
 * `startPrimaryOwnerRpcRelay({ cluster })` exactly as apps/operator/bin/hono-host.ts
 * does, forks two genuine cluster workers running owner-rpc-worker.mts, and runs
 * the capability-PTY scenario end to end:
 *
 *   1. worker A opens a process-local object (a live `cat` pipe);
 *   2. worker B writes to it twice by pid, through the real cluster IPC;
 *   3. worker B's own registry does NOT hold it (the control);
 *   4. worker A is SIGKILLed; B's next call is answered `owner_gone` by the primary.
 *
 * It reports every outcome to its parent (the test) over IPC and exits. It runs
 * as a separate process so the vitest worker never becomes a cluster primary.
 */
import cluster, { type Worker } from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPrimaryOwnerRpcRelay, type OwnerRpcClusterLike } from '../cluster-owner-rpc.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (message: unknown): void => {
  process.send?.(message);
};

cluster.setupPrimary({
  exec: path.join(here, 'owner-rpc-worker.mts'),
  execArgv: ['--import', 'tsx'],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

const relay = startPrimaryOwnerRpcRelay({ cluster: cluster as unknown as OwnerRpcClusterLike });

function forkReady(): Promise<{ worker: Worker; pid: number }> {
  const worker = cluster.fork();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cluster worker did not become ready')), 60_000);
    worker.on('message', (m: any) => {
      if (m?.type === 'fixture:ready') {
        clearTimeout(timer);
        resolve({ worker, pid: m.pid });
      }
    });
    worker.once('exit', (code) => reject(new Error(`cluster worker exited early (${code})`)));
  });
}

let seq = 0;
function callFrom(from: Worker, targetPid: number, payload: unknown, timeoutMs = 10_000): Promise<any> {
  const id = ++seq;
  return new Promise((resolve) => {
    const onMessage = (m: any) => {
      if (m?.type === 'fixture:result' && m.seq === id) {
        from.off('message', onMessage);
        resolve(m.out);
      }
    };
    from.on('message', onMessage);
    from.send({ type: 'fixture:call', seq: id, targetPid, kind: 'fixture-echo', payload, timeoutMs });
  });
}

async function main(): Promise<void> {
  const [a, b] = await Promise.all([forkReady(), forkReady()]);
  const opened = await callFrom(a.worker, a.pid, { op: 'open' });
  const objectId = opened?.result?.id as string;
  const writes = [];
  for (const line of ['first-line\n', 'second-line\n']) {
    writes.push(await callFrom(b.worker, a.pid, { op: 'write', id: objectId, data: line }));
  }
  const localControl = await callFrom(b.worker, b.pid, { op: 'write', id: objectId, data: 'x' });

  const exited = new Promise<void>((resolve) => a.worker.once('exit', () => resolve()));
  a.worker.process.kill('SIGKILL');
  await exited;
  const afterOwnerDeath = await callFrom(b.worker, a.pid, { op: 'write', id: objectId, data: 'x' });

  report({
    type: 'cluster-scenario:done',
    pids: { a: a.pid, b: b.pid, primary: process.pid },
    opened,
    writes,
    localControl,
    afterOwnerDeath,
  });
  relay.stop();
  b.worker.disconnect();
}

main().catch((error) => {
  report({ type: 'cluster-scenario:error', message: error instanceof Error ? error.stack : String(error) });
  for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGKILL');
  process.exitCode = 1;
});
