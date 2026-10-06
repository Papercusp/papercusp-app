/** Small native ORT cleanup control for WI-10005599. This reuses upstream
 * ORT's MIT mul_1.onnx fixture, already used by the native worker trace test.
 * It loads no embedding weights and cannot qualify embedding acceptance.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData, threadId } from 'node:worker_threads';

const file = fileURLToPath(import.meta.url);
const graph = Buffer.from('CAMSBmNoZW50YTpwChUKAVgKAVcSAVkaBW11bF8xIgNNdWwSCG11bCB0ZXN0KiMIAwgCEAEiGAAAgD8AAABAAABAQAAAgEAAAKBAAADAQEIBV1oTCgFYEg4KDAgBEggKAggDCgIIAmITCgFZEg4KDAgBEggKAggDCgIIAkIECgAQBw==', 'base64');
const graphSha = '71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10';
if (createHash('sha256').update(graph).digest('hex') !== graphSha) throw new Error('teardown control graph drift');

function fingerprint(path) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function observedProcessEnvironment() {
  // Observation, not admission: the governed parent validates/owns the typed
  // context. Retain its exact serialization so the parent can check forwarding
  // all the way through the debugger and FILE worker without guessing lineage.
  const allocator = Object.fromEntries(['GLIBC_TUNABLES', 'MALLOC_CHECK_', 'MALLOC_PERTURB_', 'LD_PRELOAD']
    .map(key => [key, process.env[key] ?? null]));
  const libraries = process.platform === 'linux'
    ? [...new Set(readFileSync('/proc/self/maps', 'utf8').split('\n')
      .map(line => line.trim().split(/\s+/).at(-1))
      .filter(path => path && /\/(?:libc\.so\.6|libc_malloc_debug\.so(?:\.0)?|ld-linux-x86-64\.so\.2)$/.test(path)))]
      .sort().map(fingerprint)
    : [];
  return { serializedAdmissionContext: process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null, allocator, libraries };
}

let lifecycleSequence = 0;
function lifecycle(config, operation, boundary, detail = {}) {
  if (config.lifecycleTrace !== true) return;
  const emit = row => {
    const bytes = Buffer.from('PC_NATIVE_LIFECYCLE\t' + JSON.stringify({
      processId: process.pid, threadId, sequence: ++lifecycleSequence, ...row,
    }) + '\n');
    if (writeSync(2, bytes) !== bytes.length) throw new Error('short native lifecycle write');
  };
  if (lifecycleSequence === 0) emit({ event: 'start', formatVersion: 1, graphSha256: graphSha,
    source: fingerprint(file), node: fingerprint(process.execPath), ortEntry: fingerprint(config.ortEntry),
    configuration: { device: config.device, outcome: config.outcome, release: config.release,
      parentLogLevel: config.parentLogLevel ?? null, terminal: config.terminal ?? 'settled' },
    observation: observedProcessEnvironment(), embeddingModelInferencePerformed: false });
  emit({ event: 'boundary', operation, boundary, ...detail });
}

function lifecycleSync(config, operation, action) {
  lifecycle(config, operation, 'before');
  try {
    const result = action();
    lifecycle(config, operation, 'after', operation === 'worker-create' ? { workerThreadId: result.threadId } : {});
    return result;
  }
  catch (error) { lifecycle(config, operation, 'error'); throw error; }
}

async function lifecycleAsync(config, operation, action) {
  lifecycle(config, operation, 'before');
  try { const result = await action(); lifecycle(config, operation, 'after'); return result; }
  catch (error) { lifecycle(config, operation, 'error'); throw error; }
}

async function run(config) {
  const { ortEntry, device, outcome, release } = config;
  if (!isAbsolute(ortEntry) || !['cpu', 'cuda'].includes(device)
    || !['success', 'shape-error'].includes(outcome) || !['dispose', 'environment'].includes(release)
    || (config.lifecycleTrace !== undefined && typeof config.lifecycleTrace !== 'boolean')) {
    throw new Error('invalid native teardown control configuration');
  }
  const require = createRequire(ortEntry), ort = lifecycleSync(config, 'binding-load', () => require(ortEntry));
  ort.env.logLevel = 'info';
  const session = await lifecycleAsync(config, 'session-create', () => ort.InferenceSession.create(graph, {
    executionProviders: [device], intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 1,
  }));
  const receipt = { formatVersion: 1, workItem: 'WI-10005599', processId: process.pid,
    scope: '130-byte native Mul fixture; no embedding weights', graph: { bytes: graph.length, sha256: graphSha },
    source: fingerprint(file), node: fingerprint(process.execPath), ortEntry: fingerprint(ortEntry),
    observation: observedProcessEnvironment(),
    device, outcome, release, embeddingModelInferencePerformed: false, disposed: false };
  try {
    try {
      const result = await lifecycleAsync(config, 'session-run', () => session.run({
        X: new ort.Tensor('float32', Float32Array.from([1, 1, 1, 1, 1, 1]),
          outcome === 'shape-error' ? [2, 3] : [3, 2]) }));
      if (outcome !== 'success') throw new Error('shape-error control unexpectedly succeeded');
      if (Array.from(result.Y.data).join(',') !== '1,2,3,4,5,6') throw new Error('native Mul control output mismatch');
      receipt.output = Array.from(result.Y.data);
    } catch (error) {
      if (outcome !== 'shape-error' || !String(error).includes('Got invalid dimensions for input')) throw error;
      receipt.expectedError = String(error);
    }
  } finally {
    if (release === 'dispose') {
      await lifecycleAsync(config, 'session-release', () => session.release()); receipt.disposed = true;
    }
  }
  return receipt;
}

async function target(config) {
  // Match the shipped parent's native binding pin before the FILE worker loads.
  if (config.lifecycleTrace !== undefined && typeof config.lifecycleTrace !== 'boolean') {
    throw new Error('invalid native lifecycle trace configuration');
  }
  const ort = lifecycleSync(config, 'binding-load', () => createRequire(config.ortEntry)(config.ortEntry));
  if (config.parentLogLevel !== undefined) {
    if (!['warning', 'info'].includes(config.parentLogLevel)) throw new Error('invalid parent initializer log level');
    ort.env.logLevel = config.parentLogLevel;
    // A separate small CPU session exercises the process-global first
    // initializer; it changes no CUDA provider options in the worker.
    const initial = await lifecycleAsync(config, 'initializer-create', () => ort.InferenceSession.create(graph, {
      executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
    }));
    await lifecycleAsync(config, 'initializer-release', () => initial.release());
  }
  if (config.terminal !== undefined && !['settled', 'uncaught', 'exit-code', 'abort-control'].includes(config.terminal)) {
    throw new Error('invalid native teardown terminal mode');
  }
  const worker = lifecycleSync(config, 'worker-create', () =>
    new Worker(new URL(import.meta.url), { workerData: config, execArgv: [] }));
  let result;
  try {
    result = await lifecycleAsync(config, 'worker-result', () => new Promise((resolve, reject) => {
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message));
      worker.once('error', reject);
      worker.once('exit', code => { if (!result) reject(new Error('control worker exited before receipt: ' + code)); });
    }));
  } finally {
    // Keep the two original awaited branches explicit for the maintained
    // upstream resource-start disposition; tracing only surrounds that lifetime.
    lifecycle(config, 'worker-terminate', 'before');
    try {
      result = result ? { ...result, workerTerminationCode: await worker.terminate() } : undefined;
      if (!result) await worker.terminate();
      lifecycle(config, 'worker-terminate', 'after');
    } catch (error) { lifecycle(config, 'worker-terminate', 'error'); throw error; }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  lifecycle(config, 'process-settled', 'after');
  // Positive debugger-protocol control, confined to this 130-byte fixture.
  if (config.terminal === 'abort-control') process.abort();
  if (['uncaught', 'exit-code'].includes(config.terminal)) {
    if (!result.expectedError) throw new Error('uncaught control requires the retained shape error');
    if (config.terminal === 'uncaught') throw new Error(result.expectedError);
    process.stderr.write(result.expectedError + '\n');
    process.exitCode = 1;
  }
}

async function capture(root, config) {
  const stdout = openSync(join(root, 'target.stdout.log'), 'wx', 0o600);
  const stderr = openSync(join(root, 'target.stderr.log'), 'wx', 0o600);
  const hash = createHash('sha256'); let bytes = 0;
  const child = spawn(process.execPath, [file, config.allocatorControl ? 'allocator-target' : 'target', JSON.stringify(config)], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { if (writeSync(stdout, data) !== data.length) throw new Error('short control stdout write'); });
  child.stderr.on('data', data => {
    if (writeSync(stderr, data) !== data.length) throw new Error('short control stderr write');
    hash.update(data); bytes += data.length;
  });
  child.once('error', error => { throw error; });
  const terminal = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({
    processId: child.pid, source: 'spawn-pipe', captureStartedBeforeExec: true, eof: true,
    exitCode, signal, bytes, sha256: hash.digest('hex'),
  })));
  closeSync(stdout); closeSync(stderr);
  writeFileSync(join(root, 'target-terminal.json'), JSON.stringify(terminal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(terminal) + '\n');
  process.exitCode = terminal.exitCode ?? 1;
}

async function allocatorTarget(config) {
  const { binding, fault } = config.allocatorControl ?? {};
  if (process.platform !== 'linux' || !isAbsolute(binding ?? '') || !binding.endsWith('.node')
    || !['clean', 'tail-overwrite'].includes(fault)) throw new Error('invalid allocator detector control');
  const native = createRequire(file)(binding);
  if (typeof native.detect !== 'function') throw new Error('invalid allocator detector binding');
  writeSync(1, 'PC_NATIVE_ALLOCATOR\t' + JSON.stringify({ event: 'start', processId: process.pid,
    fault, requestedBytes: 64, mutationBytes: fault === 'clean' ? 0 : 1,
    binding: fingerprint(binding), source: fingerprint(file), node: fingerprint(process.execPath),
    observation: observedProcessEnvironment(), embeddingModelInferencePerformed: false }) + '\n');
  if (native.detect(fault) !== true) throw new Error('allocator detector control did not release');
  writeSync(1, 'PC_NATIVE_ALLOCATOR\t' + JSON.stringify({ event: 'released', processId: process.pid }) + '\n');
}

export function inspectAllocatorDetectorCapture(stdout, stderr, terminal, expected) {
  const records = stdout.split('\n').filter(line => line.startsWith('PC_NATIVE_ALLOCATOR\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_ALLOCATOR\t'.length)));
  const starts = records.filter(row => row.event === 'start');
  const releases = records.filter(row => row.event === 'released');
  const start = starts[0], observation = start?.observation;
  const samePin = (actual, desired) => actual && desired && actual.path === desired.path
    && actual.bytes === desired.bytes && actual.sha256 === desired.sha256;
  const once = marker => stdout.split('\n').filter(line => line === marker).length === 1;
  if (!['clean', 'tail-overwrite'].includes(expected.fault) || starts.length !== 1
    || records.length !== (expected.fault === 'clean' ? 2 : 1)
    || !Number.isSafeInteger(start.processId) || start.processId <= 0 || terminal.processId !== start.processId
    || terminal.eof !== true || terminal.captureStartedBeforeExec !== true
    || start.fault !== expected.fault || start.requestedBytes !== 64
    || start.mutationBytes !== (expected.fault === 'clean' ? 0 : 1)
    || start.embeddingModelInferencePerformed !== false || !samePin(start.binding, expected.binding)
    || observation?.serializedAdmissionContext !== expected.serializedAdmissionContext
    || observation?.allocator?.MALLOC_CHECK_ !== '3'
    || !observation.allocator.GLIBC_TUNABLES?.split(':').includes('glibc.malloc.check=3')
    || observation.allocator.LD_PRELOAD !== expected.debugAllocator.path
    || !observation.libraries?.some(row => samePin(row, expected.debugAllocator))
    || !once('PC_NATIVE_ALLOCATOR_CORE_LIMIT_ZERO') || !once('PC_NATIVE_ALLOCATOR_BEFORE_FREE')) {
    throw new Error('incomplete allocator detector process evidence');
  }
  const corruptionMessage = /free\(\): invalid pointer|double free or corruption|corrupted double-linked list|malloc\(\): memory corruption/.test(stderr);
  if (expected.fault === 'tail-overwrite') {
    if (releases.length !== 0 || terminal.exitCode !== null || terminal.signal !== 'SIGABRT'
      || !once('PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE') || !corruptionMessage) {
      throw new Error('unqualified allocator corruption positive control');
    }
  } else if (releases.length !== 1 || releases[0].processId !== start.processId
    || terminal.exitCode !== 0 || terminal.signal !== null || corruptionMessage
    || stdout.includes('PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE')) {
    throw new Error('invalid allocator clean control');
  }
  return { processId: start.processId, source: 'native-allocator-control', fault: expected.fault,
    exitCode: terminal.exitCode, signal: terminal.signal, pipeEof: true, debugAllocatorMapped: true,
    detectorTriggered: expected.fault === 'tail-overwrite', requestedBytes: 64,
    embeddingModelInferencePerformed: false, heapCorruptionRootCauseConfirmed: false };
}

export function inspectHostDebuggerCapture(stdout, debuggerTerminal) {
  const records = stdout.split('\n').filter(line => line.startsWith('PC_NATIVE_DEBUGGER\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_DEBUGGER\t'.length)));
  const starts = records.filter(row => row.event === 'start');
  const exits = records.filter(row => row.event === 'exit');
  const stops = records.filter(row => row.event === 'signal');
  if (debuggerTerminal.eof !== true || debuggerTerminal.exitCode !== 0 || debuggerTerminal.signal !== null
    || starts.length !== 1 || exits.length !== 1 || records.some(row => row.event === 'error')
    || !Number.isSafeInteger(starts[0].processId) || starts[0].processId <= 0
    || exits[0].processId !== starts[0].processId || exits[0].signalDelivered !== true) {
    throw new Error('incomplete native debugger process evidence');
  }
  const exit = exits[0];
  if (exit.exitCode === null) {
    const fatal = stops.at(-1);
    if (!fatal || fatal.processId !== starts[0].processId || fatal.signal !== 'SIGABRT'
      || exit.signal !== fatal.signal || !stdout.includes('PC_NATIVE_BACKTRACE_BEGIN\n')
      || !stdout.includes('PC_NATIVE_BACKTRACE_END\n')) throw new Error('unbound native debugger abort evidence');
  } else if (!Number.isInteger(exit.exitCode) || exit.signal !== null) {
    throw new Error('invalid native debugger exit evidence');
  }
  return { processId: starts[0].processId, source: 'gdb-events', exitCode: exit.exitCode,
    signal: exit.signal, signalDelivered: true, debuggerPipeEof: true,
    hostBacktraceCaptured: exit.signal === 'SIGABRT', embeddingModelInferencePerformed: false };
}

export function inspectNativeLifecycleCapture(stderr, terminal, expected) {
  const records = stderr.split('\n').filter(line => line.startsWith('PC_NATIVE_LIFECYCLE\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_LIFECYCLE\t'.length)));
  const samePin = (actual, desired) => actual && desired && actual.path === desired.path
    && actual.bytes === desired.bytes && actual.sha256 === desired.sha256;
  if (!Number.isSafeInteger(terminal.processId) || terminal.processId <= 0
    || terminal.eof !== true || terminal.captureStartedBeforeExec !== true || records.length === 0
    || !((terminal.signal === null && [0, 1].includes(terminal.exitCode))
      || (terminal.signal === 'SIGABRT' && terminal.exitCode === null))) {
    throw new Error('incomplete native lifecycle process evidence');
  }
  const threads = new Map();
  let createdWorker;
  for (const row of records) {
    if (row.processId !== terminal.processId || !Number.isSafeInteger(row.threadId) || row.threadId < 0) {
      throw new Error('foreign native lifecycle thread');
    }
    let thread = threads.get(row.threadId);
    if (row.event === 'start') {
      if (thread || row.sequence !== 1 || row.formatVersion !== 1 || row.graphSha256 !== graphSha
        || row.embeddingModelInferencePerformed !== false || !samePin(row.source, expected.source)
        || !samePin(row.node, expected.node) || !samePin(row.ortEntry, expected.ortEntry)
        || ['device', 'outcome', 'release', 'parentLogLevel', 'terminal']
          .some(key => row.configuration?.[key] !== expected.configuration[key])
        || row.observation?.serializedAdmissionContext !== expected.serializedAdmissionContext) {
        throw new Error('unbound native lifecycle start');
      }
      const operations = row.threadId === 0
        ? ['binding-load', ...(expected.configuration.parentLogLevel === null ? [] : ['initializer-create', 'initializer-release']),
          'worker-create', 'worker-result', 'worker-terminate', 'process-settled']
        : ['binding-load', 'session-create', 'session-run',
          ...(expected.configuration.release === 'dispose' ? ['session-release'] : []), 'worker-ready'];
      thread = { threadId: row.threadId, sequence: 1, operations, next: 0,
        pendingOperation: null, completedOperations: [], failedOperations: [], lastBoundary: null };
      threads.set(row.threadId, thread);
      continue;
    }
    if (!thread || row.event !== 'boundary' || row.sequence !== thread.sequence + 1
      || row.operation !== thread.operations[thread.next] || !['before', 'after', 'error'].includes(row.boundary)) {
      throw new Error('invalid native lifecycle operation order');
    }
    const milestone = ['process-settled', 'worker-ready', 'worker-failed'].includes(row.operation);
    if (milestone ? row.boundary !== 'after' || thread.pendingOperation !== null
      : row.boundary === 'before' ? thread.pendingOperation !== null : thread.pendingOperation !== row.operation) {
      throw new Error('unpaired native lifecycle boundary');
    }
    thread.sequence = row.sequence;
    thread.lastBoundary = { operation: row.operation, boundary: row.boundary };
    if (row.boundary === 'before') thread.pendingOperation = row.operation;
    else {
      thread.pendingOperation = null;
      thread.next++;
      (row.boundary === 'after' ? thread.completedOperations : thread.failedOperations).push(row.operation);
      if (row.operation === 'worker-create' && row.boundary === 'after') createdWorker = row.workerThreadId;
      if (row.boundary === 'error' && !(row.operation === 'session-run' && expected.configuration.outcome === 'shape-error')) {
        // A fatal exception skips the remaining native operations. The worker
        // reports its error; the parent still awaits termination in finally.
        thread.operations = row.threadId === 0
          ? [...thread.operations.slice(0, thread.next), ...(row.operation === 'worker-result' ? ['worker-terminate'] : [])]
          : [...thread.operations.slice(0, thread.next), 'worker-failed'];
      }
    }
  }
  const main = threads.get(0), workers = [...threads.values()].filter(row => row.threadId !== 0);
  if (!main || workers.length > 1 || (workers.length === 1 && workers[0].threadId !== createdWorker)
    || (createdWorker !== undefined && (!Number.isSafeInteger(createdWorker) || createdWorker <= 0))
    || (terminal.signal === null && createdWorker !== undefined && workers.length !== 1)
    || (terminal.signal === null && [...threads.values()].some(row => row.pendingOperation !== null
      || row.next !== row.operations.length))) {
    throw new Error('incomplete native lifecycle thread closure');
  }
  const complete = terminal.signal === null && workers.length === 1
    && main.completedOperations.includes('process-settled') && workers[0].completedOperations.includes('worker-ready');
  if (terminal.exitCode === 0 && !complete) throw new Error('missing native lifecycle settled process');
  return { processId: terminal.processId, source: 'native-lifecycle-boundaries', pipeEof: true,
    exitCode: terminal.exitCode, signal: terminal.signal, completeLifecycleObserved: complete,
    threads: [...threads.values()].map(({ threadId, completedOperations, failedOperations, pendingOperation, lastBoundary }) =>
      ({ threadId, completedOperations, failedOperations, pendingOperation, lastBoundary })),
    embeddingModelInferencePerformed: false, heapCorruptionRootCauseConfirmed: false,
    scope: 'Observed operation boundaries only; an open operation at SIGABRT does not identify the corrupting write or free.' };
}

export function inspectNativeOwnershipCapture(stdout, debuggerTerminal, expected) {
  const terminal = inspectHostDebuggerCapture(stdout, debuggerTerminal);
  const records = stdout.split('\n').filter(line => line.startsWith('PC_NATIVE_OWNERSHIP\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_OWNERSHIP\t'.length)));
  const operations = ['initializer', 'singleton-create', 'singleton-destroy',
    'session-dispose', 'session-finalize', 'instance-finalize'];
  const calls = new Map();
  if (records.length === 0 || records.length > 256 || operations.some(key => !expected.symbols[key]
    || !Number.isSafeInteger(expected.relativeAddresses?.[key]) || expected.relativeAddresses[key] < 0)) {
    throw new Error('missing native ownership observation');
  }
  for (const [index, row] of records.entries()) {
    if (row.sequence !== index + 1 || row.processId !== terminal.processId
      || !Number.isSafeInteger(row.nativeThreadId) || row.nativeThreadId <= 0
      || !Number.isSafeInteger(row.callId) || row.callId <= 0
      || !operations.includes(row.operation) || row.symbol !== expected.symbols[row.operation]
      || row.relativeAddress !== expected.relativeAddresses[row.operation]
      || row.binding?.path !== expected.binding.path || row.binding?.bytes !== expected.binding.bytes
      || row.binding?.sha256 !== expected.binding.sha256 || !/^0x[0-9a-f]+$/.test(row.programCounter)
      || !['enter', 'return', 'unwound'].includes(row.event)) {
      throw new Error('unbound native ownership observation');
    }
    if (row.event === 'enter') {
      if (row.callId !== calls.size + 1) throw new Error('duplicate native ownership call');
      calls.set(row.callId, { operation: row.operation, nativeThreadId: row.nativeThreadId,
        symbol: row.symbol, programCounter: row.programCounter, relativeAddress: row.relativeAddress, enteredAt: row.sequence,
        returnedAt: null, unwoundAt: null });
    } else {
      const call = calls.get(row.callId);
      if (!call || call.operation !== row.operation || call.nativeThreadId !== row.nativeThreadId
        || call.symbol !== row.symbol || call.programCounter !== row.programCounter
        || call.relativeAddress !== row.relativeAddress
        || call.returnedAt !== null || call.unwoundAt !== null) {
        throw new Error('unpaired native ownership return');
      }
      call[row.event === 'return' ? 'returnedAt' : 'unwoundAt'] = row.sequence;
    }
  }
  const observed = [...calls.values()];
  const creates = observed.filter(row => row.operation === 'singleton-create');
  const destroys = observed.filter(row => row.operation === 'singleton-destroy');
  if (creates.length !== 1 || destroys.length > 1
    || (destroys.length && (creates[0].returnedAt === null || destroys[0].enteredAt < creates[0].returnedAt))) {
    throw new Error('invalid native ownership singleton lifetime');
  }
  const missingOperations = operations.filter(operation => !observed.some(row => row.operation === operation));
  return { ...terminal, source: 'native-ownership-calls', calls: observed, missingOperations,
    completeOwnershipBoundariesObserved: missingOperations.length === 0
      && observed.every(row => row.returnedAt !== null) && terminal.signal === null,
    initializerNativeThreadId: creates[0].nativeThreadId,
    heapCorruptionRootCauseConfirmed: false,
    scope: 'Qualified native call and return boundaries; no attribution of a corrupting write or free.' };
}

async function debugCapture(root, config, debuggerConfig) {
  if (!isAbsolute(debuggerConfig.binary) || !isAbsolute(debuggerConfig.commands)) {
    throw new Error('native debugger requires absolute binary and command paths');
  }
  const invocation = { binary: fingerprint(debuggerConfig.binary), commands: fingerprint(debuggerConfig.commands),
    source: fingerprint(file), node: fingerprint(process.execPath), configuration: config,
    nativeOwnership: debuggerConfig.nativeOwnership === true,
    observation: observedProcessEnvironment(),
    scope: 'small native teardown control only; debugger changes observation', embeddingModelInferencePerformed: false };
  writeFileSync(join(root, 'debugger-invocation.json'), JSON.stringify(invocation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const stdoutFd = openSync(join(root, 'debugger.stdout.log'), 'wx', 0o600);
  const stderrFd = openSync(join(root, 'debugger.stderr.log'), 'wx', 0o600);
  if (debuggerConfig.nativeOwnership !== undefined && typeof debuggerConfig.nativeOwnership !== 'boolean') {
    throw new Error('invalid native ownership debugger option');
  }
  const child = spawn(debuggerConfig.binary, ['-q', '-nx', '-batch',
    ...(debuggerConfig.nativeOwnership === true ? ['-ex', 'set $pc_native_ownership = 1'] : []), '-x', debuggerConfig.commands,
    '--args', process.execPath, file, 'target', JSON.stringify(config)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => {
    if (writeSync(stdoutFd, data) !== data.length) throw new Error('short debugger stdout write');
  });
  child.stderr.on('data', data => {
    if (writeSync(stderrFd, data) !== data.length) throw new Error('short debugger stderr write');
  });
  child.once('error', error => { throw error; });
  const terminal = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({
    processId: child.pid, source: 'spawn-pipe-debugger', eof: true, exitCode, signal,
  })));
  closeSync(stdoutFd); closeSync(stderrFd);
  terminal.stdout = fingerprint(join(root, 'debugger.stdout.log'));
  terminal.stderr = fingerprint(join(root, 'debugger.stderr.log'));
  writeFileSync(join(root, 'debugger-terminal.json'), JSON.stringify(terminal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const receipt = inspectHostDebuggerCapture(readFileSync(join(root, 'debugger.stdout.log'), 'utf8'), terminal);
  writeFileSync(join(root, 'native-debugger-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exitCode = receipt.exitCode ?? 1;
}

if (!isMainThread) {
  try {
    const receipt = await run(workerData);
    lifecycle(workerData, 'worker-ready', 'after');
    parentPort.postMessage(receipt);
  } catch (error) {
    lifecycle(workerData, 'worker-failed', 'after');
    parentPort.postMessage({ error: String(error) });
  }
} else if (process.argv[1] === file) {
  if (process.argv[2] === 'target') await target(JSON.parse(process.argv[3]));
  else if (process.argv[2] === 'allocator-target') await allocatorTarget(JSON.parse(process.argv[3]));
  else if (process.argv[2] === 'capture') await capture(process.argv[3], JSON.parse(process.argv[4]));
  else if (process.argv[2] === 'debug-capture') await debugCapture(process.argv[3], JSON.parse(process.argv[4]), JSON.parse(process.argv[5]));
  else throw new Error('expected native teardown control target or capture mode');
}
