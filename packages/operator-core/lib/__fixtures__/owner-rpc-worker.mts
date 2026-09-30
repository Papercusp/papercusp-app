/**
 * Worker-process fixture for cluster-owner-rpc.integration.test.ts (WI-10003626).
 *
 * Runs the PRODUCTION worker side (`startWorkerOwnerRpc()` bound to this
 * process's real IPC channel) and holds a genuinely process-local object: a live
 * `cat` child whose stdin pipe exists only in this process. A sibling can drive it
 * only by reaching THIS pid through the primary relay — which is exactly the
 * capability-PTY situation under node:cluster.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createTextCollector, type TextCollector } from '../child-output.ts';
import {
  callOwnerProcess,
  registerOwnerRpcHandler,
  startWorkerOwnerRpc,
} from '../cluster-owner-rpc.ts';

const held = new Map<string, { child: ChildProcess; output: TextCollector }>();
let seq = 0;

registerOwnerRpcHandler('fixture-echo', async (payload) => {
  const p = payload as { op: string; id?: string; data?: string; delayMs?: number };
  if (p.op === 'open') {
    const id = `obj-${process.pid}-${++seq}`;
    const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    // Boundary-safe capture (WI-6728 child-output guard): peek() is the
    // non-flushing read, safe to poll while the stream is still open.
    held.set(id, { child, output: createTextCollector(child.stdout) });
    return { id, ownerPid: process.pid };
  }
  if (p.op === 'write') {
    const entry = held.get(p.id ?? '');
    if (!entry) return { found: false, servedBy: process.pid };
    entry.child.stdin!.write(p.data ?? '');
    const deadline = Date.now() + 5_000;
    while (!entry.output.peek().includes(p.data ?? '') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { found: true, servedBy: process.pid, output: entry.output.peek() };
  }
  if (p.op === 'slow') {
    await new Promise((r) => setTimeout(r, p.delayMs ?? 1_000));
    return { servedBy: process.pid };
  }
  if (p.op === 'throw') throw new Error('fixture handler failure');
  return { unknownOp: p.op };
});

startWorkerOwnerRpc();

process.on('message', async (message: any) => {
  if (message?.type !== 'fixture:call') return;
  const out = await callOwnerProcess({
    targetPid: message.targetPid,
    kind: message.kind,
    payload: message.payload,
    timeoutMs: message.timeoutMs,
  });
  process.send!({ type: 'fixture:result', seq: message.seq, out });
});

process.on('disconnect', () => {
  for (const { child } of held.values()) child.kill();
  process.exit(0);
});

process.send!({ type: 'fixture:ready', pid: process.pid });
