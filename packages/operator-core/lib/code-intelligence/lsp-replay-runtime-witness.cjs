/* Replay-only Node bootstrap. Its exact bytes run through --eval, so /proc
 * cmdline witnesses the recorder itself. Use the maintained plain-Node bundle
 * route: preloads, tsx and additional loaders are refused, never blessed. */
function startReplayRuntime(options) {
  const fs = require('node:fs');
  const Module = require('node:module');
  const { createHash } = require('node:crypto');
  const { resolve, join } = require('node:path');
  const { basename, delimiter } = require('node:path');
  const children = require('node:child_process');
  const { fileURLToPath, pathToFileURL } = require('node:url');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const originalReadFile = fs.readFileSync.bind(fs);
  let completeReadDepth = 0;
  const readFile = (...args) => {
    completeReadDepth++;
    try { return originalReadFile(...args); }
    finally { completeReadDepth--; }
  };
  const append = fs.appendFileSync.bind(fs);
  const identity = (pid = 'self') => {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    return `linux:${readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  };
  const processIdentity = identity();
  const evalIndex = process.execArgv.indexOf('--eval');
  const evalSha256 = hash(process.execArgv[evalIndex + 1] || '');
  // Capture the recorder before importing subject code. Descendants are linked
  // to this exact argv-anchored function through a parent launch receipt.
  const recorder = startReplayRuntime.toString();
  const runtimeFlags = process.execArgv.slice(0, evalIndex);
  const supportedFlag = flag => /^--max-old-space-size=\d+$/.test(flag) || flag === '--no-warnings';
  const target = join(options.directory, `${process.pid}.jsonl`);
  const emit = row => append(target, `${JSON.stringify({ schemaVersion: 'lsp-replay-runtime-receipt-v1',
    pid: process.pid, identity: processIdentity, runId: options.runId, ...row })}\n`);
  const startup = { kind: 'bootstrap', evalSha256,
    node: process.version, entry: resolve(options.entry), entryCanonical: fs.realpathSync(options.entry),
    nodeOptions: process.env.NODE_OPTIONS || '',
    execArgv: process.execArgv, parent: options.parent || null,
    ppid: process.ppid, parentIdentity: identity(process.ppid), controlPurpose: options.controlPurpose || null };
  fs.writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
  emit(startup);
  if (startup.nodeOptions || evalIndex < 0 || process.execArgv.length !== evalIndex + 2 ||
      runtimeFlags.some(flag => !supportedFlag(flag)) ||
      typeof Module.registerHooks !== 'function') {
    emit({ kind: 'unknown', reason: 'unsupported-loader-or-preload' });
    throw new Error('replay-runtime requires plain Node with no preloads or other loaders');
  }
  if (options.controlPurpose) {
    if (options.controlPurpose !== 'systemd-scope-availability' || !options.parent)
      throw new Error('unsupported replay control purpose');
    // Replace only the maintained `true` availability payload. No subject
    // source is imported, and terminal control evidence stays separate from
    // the running service's load/native census.
    const ancestry = [];
    let current = process.pid;
    while (ancestry.length < 16 && current !== options.parent.pid) {
      const stat = readFile(`/proc/${current}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      ancestry.push({ pid: current, identity: identity(current), ppid });
      if (!Number.isSafeInteger(ppid) || ppid < 1 || ppid === current) throw Error('unanchored control ancestry');
      current = ppid;
    }
    if (current !== options.parent.pid || identity(current) !== options.parent.identity)
      throw new Error('unanchored control parent');
    emit({ kind: 'control-complete', purpose: options.controlPurpose,
      executableSha256: hash(readFile('/proc/self/exe')), ancestry });
    return;
  }
  const receipt = (kind, file, bytes, extra = {}) => {
    if (typeof file !== 'string' && !(file instanceof URL)) {
      emit({ kind: 'unknown', reason: 'unidentified-file-read' }); return;
    }
    const path = file instanceof URL ? fileURLToPath(file) : resolve(file);
    // These exact kernel control inputs are volatile, not frozen source files.
    // Preserve consumed bytes and process epochs; the evaluator rechecks them.
    const metadata = /^\/proc\/(self|[1-9]\d*)\/(?:(stat|cgroup)|task\/([1-9]\d*)\/(children))$/.exec(path);
    if (kind === 'file-read' && (metadata || path === '/proc/sys/kernel/random/boot_id')) {
      const subjectPid = metadata ? (metadata[1] === 'self' ? process.pid : Number(metadata[1])) : process.pid;
      try {
        if (metadata?.[3] && Number(metadata[3]) !== subjectPid) throw Error('unsupported metadata task');
        const before = identity(subjectPid);
        const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
        if (typeof text !== 'string' || identity(subjectPid) !== before) throw Error('unstable metadata identity');
        emit({ kind: 'kernel-metadata', path, text, sha256: hash(bytes), subjectPid, subjectIdentity: before });
      } catch {
        emit({ kind: 'unknown', reason: `unwitnessed-kernel-metadata:${path}` });
      }
      return;
    }
    emit({ kind, path, sha256: hash(bytes), byteLength: Buffer.byteLength(bytes), ...extra });
  };
  const originalSpawn = children.spawn;
  const originalExecFile = children.execFile;
  let launchSequence = 0;
  const executable = (command, env, cwd) => {
    const candidates = command.includes('/') ? [resolve(cwd, command)] :
      (env.PATH || '').split(delimiter).map(path => resolve(cwd, path, command));
    return candidates.find(path => {
      try { fs.accessSync(path, fs.constants.X_OK); return true; } catch { return false; }
    });
  };
  const prepareLaunch = (command, args, spawnOptions = {}, route = 'spawn', forkFlags) => {
    if (spawnOptions.shell) { emit({ kind: 'unknown', reason: 'unsupported-child-shell' }); return null; }
    const env = spawnOptions.env || process.env;
    const cwd = resolve(String(spawnOptions.cwd || process.cwd()));
    // The launcher freezes the maintained availability argv into its witnessed
    // evaluator. Descendants inherit it rather than maintaining a second list.
    const scopeProbe = basename(command) === 'systemd-run' && Array.isArray(options.scopeProbeArgv) &&
      JSON.stringify(args) === JSON.stringify(options.scopeProbeArgv);
    if (scopeProbe) {
      const launchId = `${process.pid}:${++launchSequence}`;
      const controlOptions = { entry: options.entry, directory: options.directory, runId: options.runId,
        controlPurpose: 'systemd-scope-availability', scopeProbeArgv: options.scopeProbeArgv,
        parent: { pid: process.pid, identity: processIdentity, evalSha256, launchId } };
      const code = `(${recorder})(${JSON.stringify(controlOptions)});`;
      const nodeArgv = ['--eval', code];
      const argv = [...args.slice(0, -1), process.execPath, ...nodeArgv];
      emit({ kind: 'child-launch', launchId, route: 'systemd-scope', controlPurpose: controlOptions.controlPurpose,
        entry: options.entry, evalSha256: hash(code), command, originalArgv: args, argv, node: process.execPath, nodeArgv });
      return { command, args: argv, launchId, controlPurpose: controlOptions.controlPurpose };
    }
    let prefix = [];
    let payload = command;
    let payloadArgs = [...args];
    // Scope payloads remain children of the systemd-run client. Services are
    // manager-parented and cannot establish this process ancestry contract.
    if (basename(command) === 'systemd-run') {
      const separator = args.indexOf('--');
      const firstOperand = args.findIndex(arg => !arg.startsWith('-'));
      const delimited = separator >= 0 && (firstOperand < 0 || separator < firstOperand);
      const payloadIndex = delimited ? separator + 1 : firstOperand;
      // The maintained scope builder emits self-contained --option=value
      // switches and appends its payload without an optional -- separator.
      const switches = args.slice(0, delimited ? separator : payloadIndex);
      if (!args.includes('--scope') || payloadIndex < 0 || !args[payloadIndex] ||
          switches.some(arg => !/^(?:--user|--scope|--quiet|--collect|--unit=.+|--slice=.+|--property=.+)$/.test(arg))) {
        emit({ kind: 'unknown', reason: 'unsupported-systemd-child-route' }); return null;
      }
      prefix = args.slice(0, payloadIndex);
      payload = args[payloadIndex]; payloadArgs = args.slice(payloadIndex + 1);
      route = 'systemd-scope';
    }
    const path = executable(payload, env, cwd);
    let node = path;
    let entry;
    let flags = forkFlags ? [...forkFlags] : [];
    let entryArgs;
    if (forkFlags || ['node', 'nodejs'].includes(basename(payload))) {
      while (!forkFlags && payloadArgs[0]?.startsWith('-') && payloadArgs[0] !== '--') flags.push(payloadArgs.shift());
      if (payloadArgs[0] === '--') payloadArgs.shift();
      entry = payloadArgs.shift(); entryArgs = payloadArgs;
    } else if (path) {
      // Witness the interpreter directive used for classification. The file's
      // actual JS source is witnessed again at its load/compile boundary.
      let source;
      try { source = readFile(path); } catch { /* normal spawn error owns this */ }
      const first = source?.subarray(0, 256).toString('utf8').split('\n')[0];
      const shebang = first && /^#!\s*(\S+)(?:\s+(\S+))?\s*$/.exec(first);
      if (shebang && (basename(shebang[1]) === 'node' ||
          (shebang[1] === '/usr/bin/env' && shebang[2] === 'node'))) {
        receipt('file-read', path, source);
        node = shebang[1] === '/usr/bin/env' ? executable('node', env, cwd) : shebang[1];
        entry = path; entryArgs = payloadArgs;
      }
    }
    if (!node || !entry || flags.some(flag => !supportedFlag(flag))) {
      emit({ kind: 'unknown', reason: `unsupported-child-launch:${payload}` }); return null;
    }
    const launchId = `${process.pid}:${++launchSequence}`;
    const childOptions = { entry: resolve(cwd, entry), args: entryArgs, directory: options.directory,
      runId: options.runId, scopeProbeArgv: options.scopeProbeArgv,
      parent: { pid: process.pid, identity: processIdentity, evalSha256, launchId } };
    const code = `(${recorder})(${JSON.stringify(childOptions)});`;
    const childArgv = [...flags, '--eval', code];
    const launchedCommand = prefix.length ? command : node;
    const launchedArgs = prefix.length ? [...prefix, node, ...childArgv] : childArgv;
    emit({ kind: 'child-launch', launchId, route, entry: childOptions.entry, evalSha256: hash(code),
      command: launchedCommand, argv: launchedArgs, node, nodeArgv: childArgv });
    return { command: launchedCommand, args: launchedArgs, launchId };
  };
  const recordChild = (child, launch) => {
    if (!launch) return child;
    let childIdentity = null;
    if (child.pid) { try { childIdentity = identity(child.pid); } catch { /* refusal below */ } }
    const childSubject = { launchId: launch.launchId, childPid: child.pid || null, childIdentity };
    emit({ kind: 'child-started', ...childSubject, atMs: Date.now() });
    if (!child.pid || !childIdentity) emit({ kind: 'unknown', reason: 'child-process-identity-unavailable' });
    if (launch.controlPurpose) {
      child.once('error', error => emit({ kind: 'control-exit', launchId: launch.launchId, code: null,
        signal: null, error: String(error) }));
      child.once('exit', (code, signal) => emit({ kind: 'control-exit', launchId: launch.launchId, code, signal }));
    } else {
      const stderr = child.stderr;
      let totalBytes = 0;
      let tail = Buffer.alloc(0);
      if (stderr) {
        const originalPush = stderr.push;
        // Observe raw input before Readable decodes it. Adding a data listener
        // would switch the stream to flowing mode and could steal consumer data.
        stderr.push = function (chunk, encoding) {
          if (chunk !== null) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            totalBytes += bytes.length;
            // Copy the retained suffix so a small tail cannot pin a large chunk.
            tail = bytes.length >= 8192 ? Buffer.from(bytes.subarray(-8192)) :
              Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - 8192)), bytes]);
          }
          return originalPush.apply(this, arguments);
        };
      }
      // close follows terminal events and stdio drain. Exit alone may precede
      // the last diagnostic bytes; inherited/ignored stderr is explicit.
      child.once('close', () => emit({ kind: 'child-stderr', ...childSubject, atMs: Date.now(),
        piped: Boolean(stderr), totalBytes, tailBase64: tail.toString('base64'), sha256: hash(tail) }));
      // Capture the original child's terminal event, not a later /proc lookup
      // whose PID may already have disappeared or been reused. These receipts
      // diagnose termination; they do not certify a successful query.
      child.once('error', error => {
        emit({ kind: 'child-error', ...childSubject, atMs: Date.now(), error: String(error) });
        // A diagnostic listener must not swallow an otherwise unhandled error.
        // once() removes this listener before invoking it, leaving only the
        // consumer's handlers in the count.
        if (child.listenerCount('error') === 0) throw error;
      });
      child.once('exit', (code, signal) => emit({ kind: 'child-exit', ...childSubject, atMs: Date.now(), code, signal }));
    }
    return child;
  };
  children.spawn = function (command, args, spawnOptions) {
    if (!Array.isArray(args)) { spawnOptions = args || {}; args = []; }
    const launch = prepareLaunch(command, args, spawnOptions);
    return recordChild(originalSpawn.call(this, launch?.command || command, launch?.args || args, spawnOptions), launch);
  };
  children.fork = function (entry, args, forkOptions) {
    if (!Array.isArray(args)) { forkOptions = args || {}; args = []; }
    const opts = { ...forkOptions, shell: false };
    const flags = opts.execArgv || runtimeFlags;
    const command = opts.execPath || process.execPath;
    const launch = prepareLaunch(command, [entry, ...args], opts, 'fork', flags);
    if (!launch) throw new Error('replay-runtime refuses unsupported fork launch');
    opts.stdio = opts.stdio || (opts.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc']);
    if (typeof opts.stdio === 'string') opts.stdio = [opts.stdio, opts.stdio, opts.stdio, 'ipc'];
    if (opts.stdio.filter(value => value === 'ipc').length !== 1) throw new Error('fork requires exactly one IPC channel');
    return recordChild(originalSpawn(launch.command, launch.args, opts), launch);
  };
  children.execFile = function (command, args, execOptions, callback) {
    if (!Array.isArray(args)) { callback = execOptions; execOptions = args; args = []; }
    if (typeof execOptions === 'function') { callback = execOptions; execOptions = {}; }
    const launch = prepareLaunch(command, args, execOptions);
    return recordChild(originalExecFile.call(this, launch?.command || command, launch?.args || args, execOptions, callback), launch);
  };
  for (const name of ['spawnSync', 'execFileSync', 'exec', 'execSync']) {
    const original = children[name];
    children[name] = function (...args) {
      emit({ kind: 'unknown', reason: `unsupported-child-launch:${name}` });
      return original.apply(this, args);
    };
  }
  Module.registerHooks({ load(url, context, nextLoad) {
    // The default ESM loader retained its original readFileSync before this
    // recorder patched fs. Its internal readSync is still a complete read:
    // nextLoad's returned source is witnessed below. No additional loader may
    // register, so this scope contains only Node's default loading boundary.
    let result;
    completeReadDepth++;
    try { result = nextLoad(url, context); }
    finally { completeReadDepth--; }
    if (url.startsWith('node:')) return result;
    if (!url.startsWith('file:') || result.source == null) {
      // CommonJS is witnessed at the actual compile boundary below.
      if (url.startsWith('file:') && ['commonjs', 'commonjs-typescript'].includes(result.format)) {
        emit({ kind: 'commonjs-load-pending', path: fileURLToPath(url), sha256: null, format: result.format });
        return result;
      }
      emit({ kind: 'unknown', reason: `unsupported-load:${url}:${result.format}` });
      return result;
    }
    if (result.format == null) {
      receipt('commonjs-load-pending', new URL(url), typeof result.source === 'string' ? result.source : Buffer.from(result.source),
        { format: null });
      return result;
    }
    if (!['module', 'commonjs', 'json'].includes(result.format))
      emit({ kind: 'unknown', reason: `unsupported-format:${result.format}` });
    receipt('esm-load-return', new URL(url), typeof result.source === 'string' ? result.source : Buffer.from(result.source),
      { format: result.format });
    return result;
  } });
  const compile = Module.prototype._compile;
  const witnessedCompile = function (source, file) {
    receipt('commonjs-compile', file, source);
    return compile.call(this, source, file);
  };
  Module.prototype._compile = witnessedCompile;
  // JSON's CommonJS handler otherwise reads bytes outside the compile hook.
  Module._extensions['.json'] = (module, filename) => {
    const bytes = readFile(filename);
    receipt('json-load', filename, bytes);
    module.exports = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  const dlopen = process.dlopen;
  process.dlopen = function (module, filename, ...args) {
    emit({ kind: 'native-load', path: resolve(filename) });
    return dlopen.call(this, module, filename, ...args);
  };
  // Capture bytes returned to configuration/source consumers, rather than a
  // later disk hash. The receipt writer retains original fs functions.
  fs.readFileSync = function (file, ...args) {
    const bytes = readFile(file, ...args);
    receipt('file-read', file, bytes);
    return bytes;
  };
  const readAsync = fs.readFile;
  fs.readFile = function (file, ...args) {
    const callback = args.pop();
    return readAsync.call(this, file, ...args, (error, bytes) => {
      if (!error) receipt('file-read', file, bytes);
      callback(error, bytes);
    });
  };
  const readPromise = fs.promises.readFile;
  fs.promises.readFile = async function (file, ...args) {
    const bytes = await readPromise.call(this, file, ...args);
    receipt('file-read', file, bytes);
    return bytes;
  };
  // These readers do not expose a complete filename+byte population at this
  // boundary. Keep the run usable, but never qualify a closure that used them.
  for (const name of ['read', 'readSync', 'readv', 'readvSync', 'createReadStream']) {
    const original = fs[name];
    fs[name] = function (...args) {
      // Complete reads and the default ESM loader call exported readSync
      // internally; their returned bytes have a filename-bound receipt.
      if (!completeReadDepth) emit({ kind: 'unknown', reason: `unsupported-file-reader:${name}` });
      return original.apply(this, args);
    };
  }
  const openPromise = fs.promises.open;
  fs.promises.open = function (...args) {
    emit({ kind: 'unknown', reason: 'unsupported-file-reader:FileHandle' });
    return openPromise.apply(this, args);
  };
  // A later transform would invalidate this hook's final-return claim. Refuse
  // registration and publish an unknown receipt, including ESM named imports.
  const refuseLoader = () => {
    emit({ kind: 'unknown', reason: 'later-loader-registration' });
    throw new Error('replay-runtime refuses later loader registration');
  };
  Module.register = refuseLoader;
  Module.registerHooks = refuseLoader;
  Module.syncBuiltinESMExports();
  emit({ kind: 'ready', coverage: ['esm-load-return', 'commonjs-compile', 'json-load', 'file-read', 'native-load', 'child-launch'] });
  process.argv = [process.execPath, resolve(options.entry), ...(options.args || [])];
  return import(pathToFileURL(resolve(options.entry)).href).catch(error => {
    emit({ kind: 'unknown', reason: `entry-failed:${String(error)}` });
    console.error(error);
    process.exitCode = 1;
  });
}
