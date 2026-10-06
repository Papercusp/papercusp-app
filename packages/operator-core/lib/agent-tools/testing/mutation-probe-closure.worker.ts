/** One closure check, one compiler isolate; staged by the shared host worker recipe. */
import { parentPort, workerData } from 'node:worker_threads';
import { stop } from 'esbuild';
import { computeImportClosures, type Closure } from './mutation-probe-closure.ts';

// The normal caller uses an owned process group so a hard deadline kills the
// native compiler too. The worker-thread door remains usable for bundle guards.
if (!parentPort && !process.send) throw new Error('mutation-probe-closure.worker requires an owned IPC caller');
const input = parentPort ? workerData : await new Promise<{ root: string; tests: string[] }>(resolve => process.once('message', resolve));
let result: Closure;
try {
  result = await computeImportClosures(input.root, input.tests);
} catch (error) {
  result = { status: 'incomplete', reason: String(error).slice(0, 200) };
} finally {
  // Only this isolate's service. The caller's service and concurrent workers
  // have independent esbuild module state and remain available.
  await stop();
}
if (parentPort) {
  parentPort.postMessage(result); parentPort.close();
} else {
  await new Promise<void>((resolve, reject) => process.send!(result, error => error ? reject(error) : resolve()));
  process.disconnect();
}
