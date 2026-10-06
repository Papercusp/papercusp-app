/** Benchmark-only Node preload. Reuse Transformers/ORT's supported INFO
 * logging to retain the arena limit and successful extension sizes. This
 * changes diagnostics only; it constructs no session and changes no EP options.
 * The launch receipt must separately bind the configuration and dependency tree.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { threadId, workerData } from 'node:worker_threads';
import { readFileSync, statSync, writeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Install after the ordinary FILE-worker boot check. The shipped worker
 * deliberately clears execArgv; this benchmark process adds only this preload
 * to its exact named CUDA worker. Restore before leaving the diagnostic. */
export function installNativeAllocatorLogging(workerScript) {
  if (!isAbsolute(workerScript)) throw new Error('allocator logging requires the exact worker path');
  const script = realpathSync(workerScript), preload = fileURLToPath(import.meta.url);
  const threads = createRequire(import.meta.url)('node:worker_threads');
  const Original = threads.Worker;
  class LoggingWorker extends Original {
    constructor(file, options) {
      const selected = typeof file === 'string' && realpathSync(file) === script && options?.workerData?.device === 'cuda';
      if (selected && (!Array.isArray(options.execArgv) || options.execArgv.length !== 0)) {
        throw new Error('allocator logging requires the shipped empty worker execArgv');
      }
      super(file, selected ? { ...options, execArgv: ['--import', preload] } : options);
    }
  }
  threads.Worker = LoggingWorker;
  syncBuiltinESMExports();
  return () => { threads.Worker = Original; syncBuiltinESMExports(); };
}

// Node propagates --import to its loader workers too. Keep the parent and
// loader threads untouched; only the shipped CUDA embed worker logs arenas.
if (threadId > 0 && workerData?.device === 'cuda') {
const config = process.env.TSX_TSCONFIG_PATH;
if (!config || !isAbsolute(config) || !statSync(config).isFile()) {
  throw new Error('allocator logging requires the bound runtime configuration path');
}
const require = createRequire(config);
const entry = require.resolve('@huggingface/transformers');
const transformers = await import(pathToFileURL(entry).href);
if (transformers.LogLevel?.INFO !== 20 || !transformers.env?.backends?.onnx?.setLogLevel) {
  throw new Error('allocator logging requires the supported Transformers ONNX logging hook');
}
transformers.env.logLevel = transformers.LogLevel.INFO;
// Transformers exposes a spread snapshot under env.backends.onnx. The
// native binding's initOrt() reads onnxruntime-common's CJS environment;
// set the maintained Node environment too instead of trusting that snapshot.
const nativeRequire = createRequire(entry);
const ort = nativeRequire('onnxruntime-node');
ort.env.logLevel = 'info';
const bindingFile = nativeRequire.resolve('onnxruntime-node').replace(/index\.js$/, 'binding.js');
const bindingEnv = createRequire(bindingFile)('onnxruntime-common').env;
if (transformers.env.logLevel !== 20 || bindingEnv.logLevel !== 'info') {
  throw new Error('allocator logging was not applied to ONNX Runtime');
}
const entryBytes = readFileSync(entry);
const record = Buffer.from('PC_ORT_ALLOCATOR_LOGGING\t' + JSON.stringify({
  processId: process.pid, workerThreadId: threadId, transformersLogLevel: 20,
  onnxLogLevel: 'info', entry, bytes: entryBytes.length,
  sha256: createHash('sha256').update(entryBytes).digest('hex'),
  modelInferencePerformed: false, providerOptionsChanged: false,
}) + '\n');
if (writeSync(2, record) !== record.length) throw new Error('allocator logging receipt was not completely written');
}
