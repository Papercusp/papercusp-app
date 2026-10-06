/** Daemon execution and qualification for the existing saturation CLI, P-012. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { classifyReplayAnswer, evaluateReplayLadder, runReplay, scoreReplay, REPLAY_CLASSES,
  type ReplayClass, type ReplayMode, type ReplayOracle, type ReplayReport, type ReplayTriplet } from './lsp-fleet-replay';
import type { LspFacadeArgs } from './lsp-facade';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { lspEvidenceNow } from './lsp-query-evidence';
import { taskIdFromScopeUnit } from '../task-manager/types';
import { absCgroupDir, parseProcCgroup, walkCgroupTree, type CgroupFs } from '../task-manager/cgroup-read';
import { linuxPpidFromProcStat, linuxProcessIdentityFromStat, readProcessIdentity } from '../process-identity';
import { SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';
import ts from 'typescript';

const replayScopeProbeArgv = ['--user', '--scope', '--quiet', ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS, '--', 'true'];

export interface ReplayCorpus {
  readonly cursor: Required<Pick<LspFacadeArgs, 'file' | 'line1' | 'character'>>;
  readonly oracle: ReplayOracle;
}
/** Authored independently from subject answers, frozen before any measurement. */
export interface DaemonReplayConfig {
  readonly schemaVersion: 'lsp-daemon-replay-config-v1';
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly oracleProvenance: { readonly method: string; readonly evidenceRef: string };
  /** Complete declared source/config/binary population, SHA256 keyed by absolute path. */
  readonly files: Readonly<Record<string, string>>;
  readonly corpus: Readonly<Record<ReplayClass, ReplayCorpus>>;
  readonly sourceSnapshot?: ReplayOracleInput['sourceSnapshot'];
  /** Predeclared runtime population and command-line-anchored recorder launches.
   * Kept separate from the independently authored source oracle. */
  readonly runtimeWitness?: ReplayRuntimeWitness;
}
export interface ReplayRuntimeWitness {
  readonly directory: string;
  readonly runId: string;
  readonly bootstraps: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
}
/** Reuse Node's load/compile boundaries with the maintained plain-Node bundle
 * route. The recorder runs from literal argv bytes, never a later self-disk read. */
export function replayRuntimeLaunch(entry: string, directory: string, runId: string, args: readonly string[] = []) {
  const recorder = readFileSync(fileURLToPath(new URL('./lsp-replay-runtime-witness.cjs', import.meta.url)), 'utf8');
  const code = `${recorder}\n;startReplayRuntime(${JSON.stringify({ entry: resolve(entry), directory: resolve(directory), runId, args,
    scopeProbeArgv: replayScopeProbeArgv })});`;
  return { args: ['--eval', code], evalSha256: replayHash(code), entry: resolve(entry) };
}
export const replayHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Runtime binaries can be large; hash their original bytes without a whole-file allocation. */
function replayFileHash(file: string, buffer: Buffer): string {
  const descriptor = openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
export const replaySourceFingerprint = (files: DaemonReplayConfig['files']) => replayHash(JSON.stringify(Object.entries(files).sort()));
export const replayOracleFingerprint = (oracle: Pick<ReplayOracle, 'sites' | 'staleSites'>) => replayHash(JSON.stringify(oracle));
/** Freeze the declared dependency trees before launch, including canonical
 * symlink targets and the native libraries the selected executables require.
 * Loaded-byte verification still refuses anything outside this population. */
export function freezeReplayRuntimeFiles(paths: readonly string[], options: {
  nativeDependencies?: (file: string) => readonly string[];
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
} = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const directories = new Set<string>();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const dependencies = options.nativeDependencies ?? ((file: string) => {
    if (!/(?:\.node|\.so(?:\.\d+)*|\/node)$/.test(file)) return [];
    const fd = openSync(file, 'r');
    const header = Buffer.alloc(20);
    try { if (readSync(fd, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return []; }
    finally { closeSync(fd); }
    // Packages can include foreign-architecture addons. Their bytes are frozen,
    // but only host ELF binaries have a dependency graph this loader can use.
    const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    const hostMachines: Partial<Record<typeof process.arch, number>> = { x64: 62, arm64: 183, ia32: 3, arm: 40 };
    const hostMachine = hostMachines[process.arch];
    if (machine !== hostMachine) return [];
    const output = execFileSync('ldd', [file], { encoding: 'utf8', timeout: 10_000 });
    if (/=>\s+not found/.test(output)) throw new Error(`missing-replay-native-dependency:${file}`);
    return [...output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match => match[1]);
  });
  const pending = paths.map(path => ({ path: resolve(path), root: realpathSync(path), ancestors: [] as string[] }));
  let completed = 0;
  while (pending.length) {
    const { path, root, ancestors } = pending.pop()!;
    const actual = realpathSync(path);
    if (!insideReplayRoot(root, actual)) throw new Error(`escaping-replay-runtime-link:${path}`);
    const before = statSync(actual, { bigint: true });
    if (before.isDirectory()) {
      // Keep every lexical package alias: consumers can read package.json
      // through a symlink even when Node loads JS from its canonical target.
      // A per-branch canonical ancestry rejects loops without erasing aliases.
      if (ancestors.includes(actual)) throw new Error(`cyclic-replay-runtime-link:${path}`);
      if (directories.has(path)) continue;
      directories.add(path);
      for (const entry of readdirSync(actual)) pending.push({ path: join(path, entry), root, ancestors: [...ancestors, actual] });
      continue;
    }
    if (!before.isFile()) throw new Error(`unsupported-replay-runtime-file:${path}`);
    if (files[actual]) { files[path] = files[actual]; continue; }
    const hash = replayFileHash(actual, buffer);
    const native = dependencies(actual);
    const after = statSync(actual, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error(`changed-during-replay-runtime-freeze:${actual}`);
    files[path] = hash; files[actual] = hash;
    for (const dependency of native) pending.push({ path: resolve(dependency), root: realpathSync(dependency), ancestors: [] });
    completed++;
    if (completed % 4096 === 0 || !pending.length)
      options.onProgress?.({ phase: 'runtime-files-frozen', completed, total: completed + pending.length });
  }
  return files;
}
export interface ReplayOracleInput {
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly tsconfigPath: string;
  readonly definition: ReplayCorpus['cursor'];
  readonly references: ReplayCorpus['cursor'];
  /** Additional runtime binaries and loaded daemon/config source whose drift invalidates qualification. */
  readonly runtimeFiles: readonly string[];
  readonly evidenceRef: string;
  /** Independent source/dependency copy; this does not establish loaded-runtime identity. */
  readonly sourceSnapshot?: { readonly manifestPath: string; readonly sha256: string };
}

function insideReplayRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}

/** Read the existing Git populations, including initialized nested submodules and
 * nonignored new source. No checkout/index/branch mutation is involved. */
export function replayRepositorySources(root: string): string[] {
  const files = new Set<string>();
  const visit = (directory: string) => {
    const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(directory))
      throw new Error(`uninitialized-replay-submodule:${directory}`);
    for (const entry of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('invalid-replay-git-population');
      const path = resolve(directory, entry.slice(tab + 1));
      if (!insideReplayRoot(root, path)) throw new Error(`escaping-replay-source:${path}`);
      if (entry.startsWith('160000 ')) visit(path);
      else files.add(relative(root, path));
    }
    for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))
      files.add(relative(root, resolve(directory, path)));
  };
  visit(root);
  return [...files].sort();
}

/** Workspace launchers/exports can name ignored build output. The verifier's
 * broad source mirror preserves those inputs; a Git-only census must add them
 * from the existing package declarations rather than silently drop them. */
function replayPackageRuntimeSources(root: string, sources: string[]): string[] {
  const files = new Set(sources);
  const visit = (path: string) => {
    if (!insideReplayRoot(root, path)) throw new Error(`escaping-replay-package-input:${path}`);
    const info = lstatSync(path);
    if (!info.isDirectory()) { files.add(relative(root, path)); return; }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['.git', '.papercusp', 'node_modules'].includes(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
      visit(join(path, entry.name));
    }
  };
  const targets = (value: unknown): string[] => typeof value === 'string' ? [value] :
    value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  for (const source of sources.filter(path => basename(path) === 'package.json')) {
    const file = resolve(root, source);
    if (!insideReplayRoot(root, file)) throw new Error(`escaping-replay-source:${source}`);
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const target of [pkg.main, pkg.module, pkg.exports, pkg.bin].flatMap(targets)) {
      // Node package targets are relative to their package; dependency names and
      // condition labels are not filesystem inputs.
      if (isAbsolute(target) || target.startsWith('#')) continue;
      const first = target.replace(/^\.\//, '').split('/')[0];
      const path = first.includes('*') ? dirname(file) : resolve(dirname(file), first);
      if (!insideReplayRoot(dirname(file), path)) throw new Error(`escaping-replay-package-input:${target}`);
      if (existsSync(path)) visit(path);
    }
  }
  return [...files].sort();
}

/** Extend the verifier's source-copy + locked pinned-dependency mechanism.
 * Copies have independent inodes, never a live symlink floor or Git worktree.
 * The manifest describes captured inputs, not an atomic commit or loaded JS. */
export function materializeReplaySource(input: ReplayOracleInput, destination: string, options: {
  enumerateSources?: (root: string) => string[];
  snapshotDependencies?: (root: string, destination: string) => void;
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
} = {}): ReplayOracleInput {
  const donor = realpathSync(input.rootPath);
  const target = join(realpathSync(dirname(resolve(destination))), basename(destination));
  if (input.sourceSnapshot) throw new Error('replay-source-already-materialized');
  if (insideReplayRoot(donor, target) || insideReplayRoot(target, donor))
    throw new Error('replay-snapshot-must-be-disjoint');
  const relocate = (file: string) => {
    const source = resolve(donor, file);
    if (!insideReplayRoot(donor, source)) throw new Error(`escaping-replay-cursor:${file}`);
    return relative(donor, source);
  };
  const tsconfigPath = relocate(input.tsconfigPath);
  const definition = { ...input.definition, file: relocate(input.definition.file) };
  const references = { ...input.references, file: relocate(input.references.file) };
  // Exclusive creation refuses a previous run; failures leave forensic inputs.
  mkdirSync(target, { mode: 0o700 });
  const hashes: Record<string, string> = {};
  const absent: string[] = [];
  const copy = (source: string, out: string) => {
    const before = lstatSync(source, { bigint: true });
    mkdirSync(dirname(out), { recursive: true });
    if (before.isSymbolicLink()) {
      const link = readlinkSync(source);
      const resolved = realpathSync(source);
      if (!insideReplayRoot(donor, resolved)) throw new Error(`escaping-replay-symlink:${source}`);
      symlinkSync(isAbsolute(link) ? resolve(target, relative(donor, resolved)) : link, out);
      hashes[relative(target, out)] = replayHash(`symlink:${readlinkSync(out)}`);
    } else if (before.isFile()) {
      const bytes = readFileSync(source);
      writeFileSync(out, bytes, { flag: 'wx', mode: Number(before.mode & 0o777n) });
      hashes[relative(target, out)] = replayHash(bytes);
    } else throw new Error(`unsupported-replay-source:${source}`);
    const after = lstatSync(source, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error(`changed-during-replay-copy:${source}`);
  };
  const paths = replayPackageRuntimeSources(donor, (options.enumerateSources ?? replayRepositorySources)(donor));
  for (const [index, path] of paths.entries()) {
    const source = resolve(donor, path);
    if (isAbsolute(path) || !insideReplayRoot(donor, source) || path.split('/').includes('.git'))
      throw new Error(`escaping-replay-source:${path}`);
    try { lstatSync(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent.push(path); continue; // tracked deletions are part of the captured population
    }
    if (!insideReplayRoot(donor, realpathSync(dirname(source)))) throw new Error(`escaping-replay-source:${path}`);
    copy(source, resolve(target, path));
    if ((index + 1) % 256 === 0 || index + 1 === paths.length)
      options.onProgress?.({ phase: 'source-copied', completed: index + 1, total: paths.length });
  }
  // Keep the completed phase even if a later dependency/containment phase fails.
  writeFileSync(join(target, '.replay-source-capture.json'), JSON.stringify({ runId: input.runId,
    donor, rootPath: target, sourceFiles: hashes, absent, loadedRuntime: 'unmeasured' }, null, 2), { flag: 'wx' });
  options.onProgress?.({ phase: 'dependencies-copy-started', completed: 0, total: 1 });
  (options.snapshotDependencies ?? ((root, out) => {
    execFileSync('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'snapshot-locked', root, out, 'copy'],
      { stdio: 'inherit', timeout: 600_000 });
  }))(donor, target);
  const dependencyStamp = join(target, '.papercusp-pinned-deps');
  if (!/^mode=copy$/m.test(readFileSync(dependencyStamp, 'utf8')))
    throw new Error('replay-dependencies-not-independent-copies');
  hashes[relative(target, dependencyStamp)] = replayHash(readFileSync(dependencyStamp));
  options.onProgress?.({ phase: 'dependencies-copied', completed: 1, total: 1 });
  const runtimeFiles = input.runtimeFiles.map(file => {
    const source = resolve(donor, file);
    const out = insideReplayRoot(donor, source) ? resolve(target, relative(donor, source)) :
      join(target, '.replay-runtime', replayHash(source), basename(source));
    if (!existsSync(out)) copy(source, out);
    return out;
  });
  // Preserved workspace links must resolve into the independent population.
  // A dependency tree may hide an absolute/live donor link several levels down.
  const pending = [target];
  let checked = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() && !insideReplayRoot(target, realpathSync(path)))
        throw new Error(`escaping-replay-snapshot-link:${path}`);
      if (entry.isDirectory()) pending.push(path);
      checked++;
      if (checked % 4096 === 0) options.onProgress?.({ phase: 'symlinks-checked', completed: checked, total: checked });
    }
  }
  const manifestPath = join(target, '.replay-source-snapshot.json');
  const manifest = JSON.stringify({ schemaVersion: 'lsp-replay-source-snapshot-v1', donor, rootPath: target,
    sourceFiles: hashes, absent, dependencyIsolation: 'independent-copy-under-install-mutex',
    loadedRuntime: 'unmeasured' }, null, 2);
  writeFileSync(manifestPath, manifest, { flag: 'wx' });
  return { ...input, rootPath: target, tsconfigPath, definition, references, runtimeFiles: [...runtimeFiles, dependencyStamp, manifestPath],
    sourceSnapshot: { manifestPath, sha256: replayHash(manifest) } };
}

/**
 * Independent static source census: resolves lexical bindings with the compiler
 * checker, never calls the subject adapter/server or learns sites from a warmup.
 * The explicit config/roots bound the population and are retained in the archive.
 */
interface ReplayOracleProgress {
  phase: 'config-parsed' | 'compiler-loaded' | 'oracle-resolved' | 'references-scanned' | 'files-validating' | 'file-validated' | 'validated';
  completed: number;
  total: number;
  file?: string;
}
export function freezeCompilerReplayConfig(input: ReplayOracleInput, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): DaemonReplayConfig {
  // Only plain config data crosses this boundary. Do not keep the compiler graph
  // reachable while rereading the complete source/config/binary population.
  const { config, sourceCount } = compilerReplayConfig(input, options);
  validateDaemonReplayConfig(config, options);
  options.onProgress?.({ phase: 'validated', completed: sourceCount, total: sourceCount });
  return config;
}
function compilerReplayConfig(input: ReplayOracleInput, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
}): { config: DaemonReplayConfig; sourceCount: number } {
  const tsconfigPath = resolve(input.rootPath, input.tsconfigPath);
  const loadedInputs = new Map<string, string>();
  // Capture the very bytes handed to the compiler, not a later disk read.
  // Match TypeScript's BOM decoding while retaining the original byte hash.
  const readCompilerInput = (file: string): string | undefined => {
    let bytes: Buffer;
    try { bytes = readFileSync(file); } catch { return undefined; }
    const absolute = resolve(file);
    if (input.sourceSnapshot && !insideReplayRoot(input.rootPath, absolute))
      throw new Error(`snapshot-input-escape:${absolute}`);
    const hash = replayHash(bytes);
    const previous = loadedInputs.get(absolute);
    if (previous && previous !== hash) throw new Error(`changed-compiler-input:${absolute}`);
    loadedInputs.set(absolute, hash);
    if (bytes[0] === 254 && bytes[1] === 255)
      return Buffer.from(bytes.subarray(2, bytes.length & ~1)).swap16().toString('utf16le');
    if (bytes[0] === 255 && bytes[1] === 254) return bytes.toString('utf16le', 2);
    return bytes.toString('utf8', bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0);
  };
  const read = ts.readConfigFile(tsconfigPath, readCompilerInput);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, { ...ts.sys, readFile: readCompilerInput }, resolve(tsconfigPath, '..'), undefined, tsconfigPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const roots = [...new Set([...parsed.fileNames, resolve(input.rootPath, input.definition.file), resolve(input.rootPath, input.references.file)])];
  options.onProgress?.({ phase: 'config-parsed', completed: 0, total: roots.length });
  const host = ts.createCompilerHost(parsed.options);
  host.readFile = readCompilerInput;
  const program = ts.createProgram({ rootNames: roots, options: parsed.options, host });
  options.onProgress?.({ phase: 'compiler-loaded', completed: program.getSourceFiles().length, total: program.getSourceFiles().length });
  const checker = program.getTypeChecker();
  const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    const seen = new Set<ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) { seen.add(symbol); symbol = checker.getAliasedSymbol(symbol); }
    return symbol;
  };
  const sourceFiles = program.getSourceFiles().filter(source => !source.isDeclarationFile &&
    !relative(input.rootPath, source.fileName).startsWith('..') && !source.fileName.includes('/node_modules/'));
  const files: Record<string, string> = Object.fromEntries(loadedInputs);
  // Declaration inputs and inherited configs affect symbol binding even though
  // they are not candidate reference sites. Their drift invalidates the oracle.
  for (const source of program.getSourceFiles()) if (!loadedInputs.has(resolve(source.fileName)))
    throw new Error(`unmeasured-compiler-input:${source.fileName}`);
  const hashBuffer = Buffer.allocUnsafe(64 * 1024);
  for (const file of input.runtimeFiles) {
    const absolute = resolve(input.rootPath, file);
    const hash = replayFileHash(absolute, hashBuffer);
    if (files[absolute] && files[absolute] !== hash) throw new Error(`changed-compiler-input:${absolute}`);
    files[absolute] = hash;
  }
  const sourceFingerprint = replaySourceFingerprint(files);
  const locate = (cursor: ReplayCorpus['cursor']) => {
    const source = program.getSourceFile(resolve(input.rootPath, cursor.file));
    if (!source) throw new Error(`oracle cursor outside compiler population:${cursor.file}`);
    const lines = source.getLineStarts();
    if (cursor.line1 < 1 || cursor.line1 > lines.length) throw new Error('oracle cursor line outside source');
    const offset = lines[cursor.line1 - 1] + cursor.character;
    let identifier: ts.Identifier | undefined;
    const visit = (node: ts.Node) => {
      if (offset < node.getStart(source) || offset >= node.end) return;
      if (ts.isIdentifier(node)) identifier = node;
      else ts.forEachChild(node, visit);
    };
    visit(source);
    const symbol = canonical(identifier ? checker.getSymbolAtLocation(identifier) : undefined);
    if (!symbol || !symbol.declarations?.length) throw new Error(`unresolved source oracle:${cursor.file}`);
    return symbol;
  };
  const site = (node: ts.Node) => ({ path: relative(input.rootPath, node.getSourceFile().fileName).replaceAll('\\', '/'),
    line1: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  const unique = (sites: ReplayOracle['sites']) => [...new Map(sites.map(site => [JSON.stringify(site), site])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || (a.line1 ?? 0) - (b.line1 ?? 0));
  const cheap = locate(input.definition);
  const hot = locate(input.references);
  const definitions = unique(cheap.declarations!.map(site));
  const references: { path: string; line1: number }[] = [];
  options.onProgress?.({ phase: 'oracle-resolved', completed: 0, total: sourceFiles.length });
  for (const [index, source] of sourceFiles.entries()) {
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        let symbol = canonical(checker.getSymbolAtLocation(node));
        // In `const [{ hot }] = await Promise.all([import('./source')])`,
        // the shorthand identifier binds a new LOCAL variable. The source
        // property still refers to the export; resolve it from the binding
        // pattern's type without treating later local uses as export sites.
        const binding = node.parent;
        if (ts.isBindingElement(binding) && binding.name === node &&
          !binding.propertyName && !binding.dotDotDotToken && ts.isObjectBindingPattern(binding.parent))
          symbol = canonical(checker.getTypeAtLocation(binding.parent).getProperty(node.text));
        if (symbol === hot) references.push(site(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if ((index + 1) % 64 === 0 || index + 1 === sourceFiles.length)
      options.onProgress?.({ phase: 'references-scanned', completed: index + 1, total: sourceFiles.length });
  }
  const corpus = (cursor: ReplayCorpus['cursor'], sites: ReplayOracle['sites']): ReplayCorpus => ({ cursor,
    oracle: { sites, sourceFingerprint, oracleFingerprint: replayOracleFingerprint({ sites }) } });
  const config: DaemonReplayConfig = { schemaVersion: 'lsp-daemon-replay-config-v1', runId: input.runId,
    rootPath: input.rootPath, socketPath: input.socketPath, workspaceId: input.workspaceId, levels: input.levels,
    requestTimeoutMs: input.requestTimeoutMs, files,
    oracleProvenance: { method: 'static TypeScript symbol-binding census over the frozen compiler source population; no daemon answers',
      evidenceRef: input.evidenceRef },
    corpus: { definition: corpus(input.definition, definitions), 'hot-references': corpus(input.references, unique(references)) },
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}) };
  return { config, sourceCount: sourceFiles.length };
}
export function replayFileMismatches(files: DaemonReplayConfig['files'], options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): string[] {
  const entries = Object.entries(files);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const mismatches: string[] = [];
  options.onProgress?.({ phase: 'files-validating', completed: 0, total: entries.length });
  for (const [index, [file, hash]] of entries.entries()) {
    // Emit the exact pending file before opening it, so a stalled read remains
    // distinguishable from a completed reference scan or a successful freeze.
    options.onProgress?.({ phase: 'files-validating', file, completed: index, total: entries.length });
    try { if (replayFileHash(file, buffer) !== hash) mismatches.push(`changed-file:${file}`); }
    catch { mismatches.push(`unreadable-file:${file}`); }
    options.onProgress?.({ phase: 'file-validated', file, completed: index + 1, total: entries.length });
  }
  return mismatches;
}

export function validateDaemonReplayConfig(config: DaemonReplayConfig, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): void {
  if (config.schemaVersion !== 'lsp-daemon-replay-config-v1' || !/^[a-zA-Z0-9_-]+$/.test(config.runId))
    throw new Error('invalid replay config identity');
  if (!isAbsolute(config.rootPath) || !isAbsolute(config.socketPath) || !config.workspaceId)
    throw new Error('replay requires absolute project/socket and explicit workspace');
  if (!config.levels.length || new Set(config.levels).size !== config.levels.length ||
      config.levels.some(level => !Number.isSafeInteger(level) || level < 1)) throw new Error('invalid declared ladder');
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1)
    throw new Error('invalid frozen request deadline');
  if (!config.oracleProvenance.method || !config.oracleProvenance.evidenceRef || !Object.keys(config.files).length)
    throw new Error('independent oracle provenance and frozen file population are required');
  for (const [file, hash] of Object.entries(config.files)) {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid frozen source identity');
    if (config.sourceSnapshot && !insideReplayRoot(config.rootPath, file)) throw new Error(`snapshot-input-escape:${file}`);
  }
  if (config.sourceSnapshot && (!insideReplayRoot(config.rootPath, config.sourceSnapshot.manifestPath) ||
      config.files[config.sourceSnapshot.manifestPath] !== config.sourceSnapshot.sha256))
    throw new Error('unmatched-replay-source-snapshot');
  for (const queryClass of REPLAY_CLASSES) {
    const { cursor, oracle } = config.corpus[queryClass];
    const file = resolve(config.rootPath, cursor.file);
    if (!config.files[file] || !Number.isInteger(cursor.line1) || cursor.line1 < 1 ||
        !Number.isInteger(cursor.character) || cursor.character < 0) throw new Error(`invalid frozen cursor:${queryClass}`);
    if (!oracle.sites.length || !oracle.sourceFingerprint || !oracle.oracleFingerprint)
      throw new Error(`missing complete positive oracle:${queryClass}`);
    if (oracle.sourceFingerprint !== replaySourceFingerprint(config.files) ||
        oracle.oracleFingerprint !== replayOracleFingerprint({ sites: oracle.sites, ...(oracle.staleSites ? { staleSites: oracle.staleSites } : {}) }))
      throw new Error(`unmatched frozen fingerprint:${queryClass}`);
    const seen = new Set<string>();
    for (const site of oracle.sites) {
      if (!site.line1 || !Number.isInteger(site.line1) || site.line1 < 1 || isAbsolute(site.path) ||
          relative(config.rootPath, resolve(config.rootPath, site.path)).startsWith('..'))
        throw new Error(`invalid oracle site:${queryClass}`);
      if (!config.files[resolve(config.rootPath, site.path)]) throw new Error(`unfrozen oracle file:${site.path}`);
      const key = JSON.stringify([site.path, site.line1]);
      if (seen.has(key)) throw new Error(`duplicate oracle site:${queryClass}`);
      seen.add(key);
    }
  }
  if (config.corpus.definition.oracle.sourceFingerprint !== config.corpus['hot-references'].oracle.sourceFingerprint)
    throw new Error('unmatched source fingerprints');
  const drift = replayFileMismatches(config.files, options);
  if (drift.length) throw new Error(drift.join('\n'));
}

/** Actual wire occupancy, not caller wait overlap. Epoch clocks come from daemon evidence. */
export function replayWireOverlap(report: ReplayReport): boolean {
  const cheap = report.samples.filter(row => row.request.queryClass === 'definition');
  const hot = report.samples.filter(row => row.request.queryClass === 'hot-references');
  return cheap.some(row => {
    const answer = row.answer as LspDaemonAnswer | null;
    const end = answer?.daemonEvidence?.respondedAtMs;
    return end !== null && end !== undefined && hot.some(reference =>
      (reference.answer as LspDaemonAnswer | null)?.daemonEvidence?.wire.some(wire =>
        wire.method === 'textDocument/references' && wire.endedAtMs !== null &&
        wire.startedAtMs < end && end < wire.endedAtMs));
  });
}

export function replayEvidenceProblems(report: ReplayReport): string[] {
  const problems: string[] = [];
  for (const sample of report.samples) {
    const answer = sample.answer as LspDaemonAnswer | null;
    const evidence = answer?.daemonEvidence;
    if (!evidence || evidence.requestId !== sample.request.id) { problems.push(`missing-daemon-identity:${sample.request.id}`); continue; }
    const method = sample.request.queryClass === 'definition' ? 'textDocument/definition' : 'textDocument/references';
    const wire = evidence.wire.filter(row => row.method === method);
    if (!wire.length || wire.some(row => !row.taskId || !row.pid || row.endedAtMs === null || row.outcome !== 'response'))
      problems.push(`unsettled-wire:${sample.request.id}`);
    const receipts = evidence.events.filter(event => event.phase === 'durable-enqueued');
    if (!receipts.length || receipts.some(receipt => !receipt.receiptId || !evidence.events.some(event =>
      event.receiptId === receipt.receiptId && event.phase === 'durable-settled' && event.confirmed === true)))
      problems.push(`unconfirmed-durable-settlement:${sample.request.id}`);
    const terminal = Math.max(...evidence.events.filter(event => event.phase === 'durable-settled').map(event => event.atMs));
    const clientEnd = sample.clientSettledAtMs ?? sample.settledAtMs;
    if (!Number.isFinite(terminal) || terminal < sample.issuedAtMs || terminal > clientEnd || evidence.respondedAtMs === null ||
        evidence.respondedAtMs > clientEnd) problems.push(`invalid-settlement-order:${sample.request.id}`);
  }
  return problems;
}

interface ReplayProcessReader {
  identity(pid: number): string | null;
  text(path: string): string;
  bytes(path: string): Buffer;
  link(path: string): string;
}
const replayProcessReader: ReplayProcessReader = {
  identity: readProcessIdentity,
  text: path => readFileSync(path, 'utf8'),
  bytes: readFileSync,
  link: readlinkSync,
};
/** Kernel executable bytes and boot/start identity, not a later disk-path hash. */
export function replayProcessIdentity(pid: number, reader: ReplayProcessReader = replayProcessReader, witness?: ReplayRuntimeWitness) {
  const unknown: string[] = [];
  const before = reader.identity(pid);
  const read = <T>(label: string, fn: () => T): T | null => {
    try { return fn(); } catch (error) { unknown.push(`${label}:${String(error)}`); return null; }
  };
  const cmdline = read('cmdline', () => reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean)) ?? [];
  const cgroup = read('cgroup', () => reader.text(`/proc/${pid}/cgroup`).trim());
  const executable = read('executable', () => ({ path: reader.link(`/proc/${pid}/exe`), sha256: replayHash(reader.bytes(`/proc/${pid}/exe`)) }));
  const after = reader.identity(pid);
  if (!before || !after) unknown.push('process-identity-unavailable');
  else if (before !== after) unknown.push('process-replaced-during-snapshot');
  const runtime = witness ? replayLoadedRuntime(pid, before, cmdline, witness, reader) : null;
  return { pid, identity: before, cmdline, cgroup, executable,
    loadedModules: runtime ?? 'unmeasured' as const, unknown };
}

/** Never substitute disk filenames for executed bytes. Missing receipts,
 * unsupported readers/loaders, native mappings and process epochs fail closed. */
export function replayLoadedRuntime(pid: number, identity: string | null, cmdline: string[],
  witness: ReplayRuntimeWitness, reader: ReplayProcessReader = replayProcessReader) {
  const unknown: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const native: { path: string; sha256: string }[] = [];
  try {
    const text = reader.text(join(witness.directory, `${pid}.jsonl`));
    if (!text.endsWith('\n')) unknown.push('incomplete-runtime-receipt');
    for (const line of text.trim().split('\n')) receipts.push(JSON.parse(line));
  } catch (error) { unknown.push(`unreadable-runtime-receipts:${String(error)}`); }
  const bootstrap = receipts[0];
  const evalIndex = cmdline.indexOf('--eval');
  const evalSha256 = evalIndex < 0 ? null : replayHash(cmdline[evalIndex + 1] ?? '');
  // A descendant is not a second trusted root. Its literal eval bytes must be
  // authorized by a currently witnessed parent's launch and kernel ancestry,
  // recursively ending at the predeclared root command line.
  const anchored = (childPid: number, childIdentity: string | null, childCommand: string[],
    rows: Record<string, unknown>[], seen = new Set<number>()): boolean => {
    if (seen.has(childPid) || seen.size >= 64) return false;
    seen.add(childPid);
    const boot = rows[0];
    const index = childCommand.indexOf('--eval');
    const codeHash = index < 0 ? null : replayHash(childCommand[index + 1] ?? '');
    if (!childIdentity || !boot || boot.kind !== 'bootstrap' || boot.nodeOptions !== '' ||
        boot.pid !== childPid || boot.identity !== childIdentity || boot.runId !== witness.runId ||
        boot.evalSha256 !== codeHash || !codeHash) return false;
    if (!boot.parent) return witness.bootstraps[String(boot.entry)] === codeHash;
    try {
      const parent = boot.parent as { pid: number; identity: string; evalSha256: string; launchId: string };
      if (!Number.isSafeInteger(parent.pid) || reader.identity(parent.pid) !== parent.identity) return false;
      const parentText = reader.text(join(witness.directory, `${parent.pid}.jsonl`));
      if (!parentText.endsWith('\n')) return false;
      const parentRows: Record<string, unknown>[] = parentText.trim().split('\n').map(line => JSON.parse(line));
      const parentCommand = reader.text(`/proc/${parent.pid}/cmdline`).split('\0').filter(Boolean);
      if (parentRows[0]?.evalSha256 !== parent.evalSha256 ||
          !anchored(parent.pid, parent.identity, parentCommand, parentRows, seen) ||
          !parentRows.some(row => row.kind === 'ready') || parentRows.some(row => row.kind === 'unknown') ||
          parentRows.some(row => row.pid !== parent.pid || row.identity !== parent.identity || row.runId !== witness.runId ||
            row.schemaVersion !== 'lsp-replay-runtime-receipt-v1')) return false;
      const launches = parentRows.filter(row => row.kind === 'child-launch' && row.launchId === parent.launchId);
      const started = parentRows.filter(row => row.kind === 'child-started' && row.launchId === parent.launchId);
      if (launches.length !== 1 || started.length !== 1) return false;
      const launch = launches[0];
      const child = started[0];
      if (launch.entry !== boot.entry || launch.evalSha256 !== codeHash ||
          !Array.isArray(launch.nodeArgv) || JSON.stringify(launch.nodeArgv) !== JSON.stringify(childCommand.slice(1)) ||
          !Number.isSafeInteger(child.childPid) || typeof child.childIdentity !== 'string') return false;
      const ppid = (processPid: number) => {
        const stat = reader.text(`/proc/${processPid}/stat`);
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      };
      if (ppid(childPid) !== boot.ppid || reader.identity(Number(boot.ppid)) !== boot.parentIdentity) return false;
      if (launch.route !== 'systemd-scope')
        return ['spawn', 'fork'].includes(String(launch.route)) && child.childPid === childPid &&
          child.childIdentity === childIdentity && boot.ppid === parent.pid && boot.parentIdentity === parent.identity;
      // Scope launchers may exec the payload or retain a short intermediary
      // chain. A manager-parented service or reparented process fails closed.
      let current = childPid;
      const ancestors = new Set<number>();
      while (!ancestors.has(current) && ancestors.size < 16) {
        ancestors.add(current);
        if (current === child.childPid)
          return reader.identity(current) === child.childIdentity && ppid(current) === parent.pid;
        current = ppid(current);
        if (!Number.isSafeInteger(current) || current < 1 || current === parent.pid) break;
      }
      return false;
    } catch { return false; }
  };
  if (!bootstrap || bootstrap.kind !== 'bootstrap' || bootstrap.nodeOptions !== '' ||
      !evalSha256 || bootstrap.evalSha256 !== evalSha256 ||
      !anchored(pid, identity, cmdline, receipts)) unknown.push('unwitnessed-runtime-bootstrap');
  if (!receipts.some(row => row.kind === 'ready')) unknown.push('runtime-recorder-not-ready');
  const loads = receipts.filter(row => ['esm-load-return', 'commonjs-compile', 'json-load'].includes(String(row.kind)));
  const canonicalEntry = bootstrap?.entryCanonical ?? bootstrap?.entry;
  if (typeof canonicalEntry !== 'string' || typeof bootstrap?.entry !== 'string' ||
      !witness.files[bootstrap.entry] || witness.files[canonicalEntry] !== witness.files[bootstrap.entry])
    unknown.push('unfrozen-runtime-entry-alias');
  if (!loads.length || !loads.some(row => row.path === canonicalEntry)) unknown.push('runtime-entry-not-loaded');
  for (const launch of receipts.filter(row => row.kind === 'child-launch' && row.controlPurpose)) {
    try {
      if (launch.controlPurpose !== 'systemd-scope-availability' || launch.route !== 'systemd-scope' ||
          receipts.filter(row => row.kind === 'child-launch' && row.launchId === launch.launchId).length !== 1 ||
          JSON.stringify(launch.originalArgv) !== JSON.stringify(replayScopeProbeArgv) ||
          typeof launch.command !== 'string' || basename(launch.command) !== 'systemd-run' ||
          typeof launch.node !== 'string' || !witness.files[launch.node] || !Array.isArray(launch.nodeArgv) || launch.nodeArgv.length !== 2 ||
          launch.nodeArgv[0] !== '--eval' || typeof launch.nodeArgv[1] !== 'string' ||
          replayHash(launch.nodeArgv[1]) !== launch.evalSha256 ||
          JSON.stringify(launch.argv) !== JSON.stringify([...replayScopeProbeArgv.slice(0, -1), launch.node, ...launch.nodeArgv]))
        throw Error('unsupported control launch');
      const starts = receipts.filter(row => row.kind === 'child-started' && row.launchId === launch.launchId);
      const exits = receipts.filter(row => row.kind === 'control-exit' && row.launchId === launch.launchId);
      if (starts.length !== 1 || exits.length !== 1 || exits[0].code !== 0 || exits[0].signal !== null || exits[0].error ||
          !Number.isSafeInteger(starts[0].childPid) || typeof starts[0].childIdentity !== 'string')
        throw Error('control probe incomplete or failed');
      // Short-lived control children are qualified from their recorded kernel
      // ancestry and terminal result, never from a reused PID after exit.
      let matching = 0;
      for (const file of readdirSync(witness.directory).filter(file => /^\d+\.jsonl$/.test(file))) {
        const text = reader.text(join(witness.directory, file));
        if (!text.endsWith('\n')) continue;
        const rows: Record<string, unknown>[] = text.trim().split('\n').map(line => JSON.parse(line));
        const boot = rows[0];
        const parent = boot?.parent as Record<string, unknown> | undefined;
        if (!parent || parent.launchId !== launch.launchId || parent.pid !== pid) continue;
        matching++;
        const complete = rows.filter(row => row.kind === 'control-complete');
        if (boot.kind !== 'bootstrap' || boot.controlPurpose !== launch.controlPurpose || boot.nodeOptions !== '' ||
            boot.entry !== launch.entry || typeof complete[0]?.executableSha256 !== 'string' ||
            boot.evalSha256 !== launch.evalSha256 || parent.identity !== identity || parent.evalSha256 !== evalSha256 ||
            JSON.stringify(boot.execArgv) !== JSON.stringify(launch.nodeArgv) || complete.length !== 1 ||
            rows.length !== 2 || rows.some(row => row.schemaVersion !== 'lsp-replay-runtime-receipt-v1' ||
              row.pid !== boot.pid || row.identity !== boot.identity || row.runId !== witness.runId) ||
            complete[0].purpose !== launch.controlPurpose || complete[0].executableSha256 !== witness.files[launch.node])
          throw Error('unwitnessed control completion');
        const ancestry = complete[0].ancestry as { pid: number; identity: string; ppid: number }[];
        if (!Array.isArray(ancestry) || !ancestry.length || ancestry.length > 16 || ancestry[0].pid !== boot.pid ||
            ancestry[0].identity !== boot.identity || ancestry[0].ppid !== boot.ppid ||
            boot.parentIdentity !== (ancestry[1]?.identity ?? identity) ||
            ancestry.some((row, index) => !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) ||
              typeof row.identity !== 'string' || row.ppid !== (ancestry[index + 1]?.pid ?? pid)) ||
            new Set(ancestry.map(row => row.pid)).size !== ancestry.length ||
            !ancestry.some(row => row.pid === starts[0].childPid && row.identity === starts[0].childIdentity))
          throw Error('unanchored control ancestry');
      }
      if (matching !== 1) throw Error('missing or ambiguous control receipt');
    } catch (error) { unknown.push(`unqualified-control-probe:${String(launch.launchId)}:${String(error)}`); }
  }
  for (const row of receipts) {
    if (row.schemaVersion !== 'lsp-replay-runtime-receipt-v1' || row.pid !== pid || !identity ||
        row.identity !== identity || row.runId !== witness.runId) unknown.push('runtime-receipt-identity-mismatch');
    if (row.kind === 'unknown') unknown.push(String(row.reason));
    if (row.kind === 'kernel-metadata') {
      try {
        const path = String(row.path);
        const match = /^\/proc\/(self|[1-9]\d*)\/(?:(stat|cgroup)|task\/([1-9]\d*)\/(children))$/.exec(path);
        const subjectPid = match ? (match[1] === 'self' ? pid : Number(match[1])) : pid;
        const subjectIdentity = reader.identity(subjectPid);
        if ((!match && path !== '/proc/sys/kernel/random/boot_id') ||
            (match?.[3] && Number(match[3]) !== subjectPid) ||
            row.subjectPid !== subjectPid || !subjectIdentity || row.subjectIdentity !== subjectIdentity ||
            typeof row.text !== 'string' || replayHash(row.text) !== row.sha256)
          throw Error('metadata identity or bytes mismatch');
        if (match?.[2] === 'stat') {
          const current = reader.text(`/proc/${subjectPid}/stat`);
          const boot = reader.text('/proc/sys/kernel/random/boot_id');
          if (!row.text.startsWith(`${subjectPid} (`) || linuxProcessIdentityFromStat(boot, row.text) !== subjectIdentity ||
              linuxPpidFromProcStat(row.text) === null || linuxPpidFromProcStat(row.text) !== linuxPpidFromProcStat(current))
            throw Error('stat epoch or parent mismatch');
        } else if (reader.text(match?.[4] === 'children' ? `/proc/${subjectPid}/task/${subjectPid}/children` :
          match ? `/proc/${subjectPid}/cgroup` : path) !== row.text) {
          throw Error('kernel control input changed');
        }
        if (reader.identity(subjectPid) !== subjectIdentity) throw Error('process changed during metadata validation');
      } catch (error) { unknown.push(`unqualified-kernel-metadata:${String(row.path)}:${String(error)}`); }
      continue;
    }
    if (row.kind === 'commonjs-load-pending') {
      // A default load hook can defer the format decision until _compile.
      // Qualification requires that actual compile, with matching source
      // when nextLoad supplied it; a deferred receipt alone proves nothing.
      if (!loads.some(load => load.kind === 'commonjs-compile' && load.path === row.path &&
          (row.sha256 === null || row.sha256 === load.sha256)))
        unknown.push(`uncompleted-commonjs-load:${String(row.path)}`);
      if (typeof row.path !== 'string' || !witness.files[row.path] ||
          (row.sha256 !== null && witness.files[row.path] !== row.sha256))
        unknown.push(`unfrozen-loaded-bytes:${String(row.path)}`);
      continue;
    }
    if (['esm-load-return', 'commonjs-compile', 'json-load', 'file-read'].includes(String(row.kind))) {
      if (typeof row.path !== 'string' || witness.files[row.path] !== row.sha256)
        unknown.push(`unfrozen-loaded-bytes:${String(row.path)}`);
    } else if (row.kind === 'control-exit') {
      if (!receipts.some(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId && launch.controlPurpose))
        unknown.push('orphan-control-exit');
    } else if (row.kind === 'child-stderr') {
      const launches = receipts.filter(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId);
      const starts = receipts.filter(start => start.kind === 'child-started' && start.launchId === row.launchId);
      const diagnostics = receipts.filter(diagnostic => diagnostic.kind === 'child-stderr' && diagnostic.launchId === row.launchId);
      const terminals = receipts.filter(terminal => ['child-exit', 'child-error'].includes(String(terminal.kind)) &&
        terminal.launchId === row.launchId);
      const start = starts[0];
      const tail = typeof row.tailBase64 === 'string' ? Buffer.from(row.tailBase64, 'base64') : null;
      // Diagnostic integrity is separate from query success. Anchor to the
      // original launch/epoch and terminal event, including an empty stream.
      if (typeof row.launchId !== 'string' || launches.length !== 1 || launches[0].controlPurpose ||
          starts.length !== 1 || diagnostics.length !== 1 || terminals.length === 0 ||
          !Number.isSafeInteger(row.childPid) || Number(row.childPid) <= 0 ||
          typeof row.childIdentity !== 'string' || row.childIdentity.length === 0 ||
          row.childPid !== start?.childPid || row.childIdentity !== start?.childIdentity ||
          !Number.isFinite(start?.atMs) || Number(start?.atMs) <= 0 || !Number.isFinite(row.atMs) ||
          Number(row.atMs) < Number(start?.atMs) ||
          terminals.some(terminal => terminal.childPid !== row.childPid || terminal.childIdentity !== row.childIdentity ||
            !Number.isFinite(terminal.atMs) || Number(terminal.atMs) < Number(start?.atMs) || Number(terminal.atMs) > Number(row.atMs)) ||
          typeof row.piped !== 'boolean' || !Number.isSafeInteger(row.totalBytes) || Number(row.totalBytes) < 0 ||
          !tail || tail.toString('base64') !== row.tailBase64 || tail.length !== Math.min(Number(row.totalBytes), 8192) ||
          replayHash(tail) !== row.sha256 || (!row.piped && Number(row.totalBytes) !== 0))
        unknown.push('unqualified-child-stderr');
    } else if (row.kind === 'child-exit' || row.kind === 'child-error') {
      const launches = receipts.filter(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId);
      const starts = receipts.filter(start => start.kind === 'child-started' && start.launchId === row.launchId);
      const exits = receipts.filter(exit => exit.kind === row.kind && exit.launchId === row.launchId);
      const start = starts[0];
      const validOutcome = row.kind === 'child-error' ? typeof row.error === 'string' && row.error.length > 0 :
        Number.isSafeInteger(row.childPid) && Number(row.childPid) > 0 && typeof row.childIdentity === 'string' &&
        row.childIdentity.length > 0 &&
        (row.code === null || (Number.isSafeInteger(row.code) && Number(row.code) >= 0)) &&
        (row.signal === null || (typeof row.signal === 'string' && /^SIG[A-Z0-9]+$/.test(row.signal))) &&
        ((row.code === null) !== (row.signal === null));
      if (typeof row.launchId !== 'string' || launches.length !== 1 || launches[0].controlPurpose ||
          starts.length !== 1 || exits.length !== 1 || row.childPid !== start?.childPid ||
          row.childIdentity !== start?.childIdentity || !Number.isFinite(row.atMs) ||
          !Number.isFinite(start?.atMs) || Number(start?.atMs) <= 0 || Number(row.atMs) < Number(start?.atMs) || !validOutcome)
        unknown.push('unqualified-child-terminal');
    } else if (!['bootstrap', 'ready', 'native-load', 'unknown', 'child-launch', 'child-started'].includes(String(row.kind))) unknown.push('unsupported-runtime-receipt');
  }
  // Kernel map_files names the mapped inode even after disk replacement/unlink.
  // Access failures are unknown; a later disk hash is never a fallback.
  try {
    const seen = new Set<string>();
    for (const line of reader.text(`/proc/${pid}/maps`).trim().split('\n')) {
      const match = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (!match || !match[2].startsWith('/') || seen.has(match[2])) continue;
      const path = match[2]; seen.add(path);
      // maps pads low addresses, but map_files names use canonical hex. Keep
      // 64-bit addresses exact instead of rounding them through Number.
      const range = match[1].split('-').map(address => BigInt(`0x${address}`).toString(16)).join('-');
      const sha256 = replayHash(reader.bytes(`/proc/${pid}/map_files/${range}`));
      native.push({ path, sha256 });
      if (witness.files[path] !== sha256) unknown.push(`unfrozen-native-mapping:${path}`);
    }
    for (const row of receipts.filter(row => row.kind === 'native-load'))
      if (!native.some(mapping => mapping.path === row.path)) unknown.push(`unwitnessed-native-load:${String(row.path)}`);
    if (!native.length) unknown.push('empty-native-mapping-census');
  } catch (error) { unknown.push(`unreadable-native-mappings:${String(error)}`); }
  if (reader.identity(pid) !== identity) unknown.push('process-replaced-during-runtime-witness');
  return { receipts, native, unknown: [...new Set(unknown)] };
}

/** Reuse the managed cgroup walk, retaining unreadable branches as unknown. */
export function replayServerPopulation(pid: number, taskId: string, deps: {
  process?: ReplayProcessReader; fs?: CgroupFs; witness?: ReplayRuntimeWitness;
} = {}) {
  const processReader = deps.process ?? replayProcessReader;
  const root = replayProcessIdentity(pid, processReader, deps.witness);
  const unknown = [...root.unknown];
  const cgroup = root.cgroup ? parseProcCgroup(root.cgroup) : null;
  if (!cgroup || taskIdFromScopeUnit(basename(cgroup)) !== taskId)
    unknown.push('server-task-cgroup-mismatch');
  const absolute = cgroup ? absCgroupDir(cgroup) : null;
  const checked = <T>(path: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (error) { unknown.push(`unreadable-cgroup:${path}:${String(error)}`); return fallback; }
  };
  const rawFs: CgroupFs = deps.fs ?? {
    readFile: path => readFileSync(path, 'utf8'),
    readDir: path => readdirSync(path),
    isDir: path => statSync(path).isDirectory(),
  };
  const fs: CgroupFs = {
    readFile: path => {
      const value = checked(path, () => rawFs.readFile(path), null);
      if (value === null) unknown.push(`unreadable-cgroup:${path}`);
      return value;
    },
    readDir: path => checked(path, () => rawFs.readDir(path), [] as string[]),
    isDir: path => {
      const directory = checked(path, () => rawFs.isDir(path), false);
      if (directory && absolute && relative(absolute, path).split('/').filter(Boolean).length > 32) {
        unknown.push(`cgroup-depth-unmeasured:${path}`);
        return false;
      }
      return directory;
    },
  };
  // Do not census a broad foreign service cgroup when task provenance failed.
  const groups = absolute && !unknown.length ? walkCgroupTree(absolute, fs) : [];
  const pids = [...new Set(groups.flatMap(group => group.pids))].sort((a, b) => a - b);
  if (!pids.includes(pid)) unknown.push('server-missing-from-cgroup-census');
  const processes = pids.map(child => child === pid ? root : replayProcessIdentity(child, processReader, deps.witness));
  for (const child of processes) {
    unknown.push(...child.unknown.map(reason => `pid:${child.pid}:${reason}`));
    const childGroup = child.cgroup ? parseProcCgroup(child.cgroup) : null;
    if (!childGroup || !cgroup || (childGroup !== cgroup && !childGroup.startsWith(`${cgroup}/`)))
      unknown.push(`process-outside-server-cgroup:${child.pid}`);
  }
  for (const child of processes) if (processReader.identity(child.pid) !== child.identity)
    unknown.push(`process-replaced-during-census:${child.pid}`);
  const finalPids = absolute && cgroup && taskIdFromScopeUnit(basename(cgroup)) === taskId
    ? [...new Set(walkCgroupTree(absolute, fs).flatMap(group => group.pids))].sort((a, b) => a - b) : [];
  if (JSON.stringify(finalPids) !== JSON.stringify(pids)) unknown.push('cgroup-population-changed-during-census');
  return { taskId, rootPid: pid, cgroup, groups, processes, unknown: [...new Set(unknown)] };
}

export function replayPopulationFingerprint(population: ReturnType<typeof replayServerPopulation>) {
  return replayHash(JSON.stringify(population.processes.map(row => ({ pid: row.pid, identity: row.identity,
    cgroup: row.cgroup, cmdline: row.cmdline, executable: row.executable }))));
}

export function replayDurableReport(report: ReplayReport, oracles: Readonly<Record<ReplayClass, ReplayOracle>>): ReplayReport {
  const samples = report.samples.map(sample => {
    const events = (sample.answer as LspDaemonAnswer | null)?.daemonEvidence?.events ?? [];
    const terminal = Math.max(...events.filter(event => event.phase === 'durable-settled' && event.confirmed === true).map(event => event.atMs));
    return { ...sample, clientSettledAtMs: sample.settledAtMs,
      settledAtMs: Number.isFinite(terminal) ? terminal : sample.settledAtMs };
  });
  return scoreReplay(report.concurrency, report.mode, report.population, samples, oracles);
}

interface ReplayRuntimePopulation {
  processes: ReturnType<typeof replayProcessIdentity>[];
  populations: ReturnType<typeof replayServerPopulation>[];
}
export interface ReplayBoundary extends ReplayRuntimePopulation {
  label: string;
  atMs: number;
  health: LspDaemonAnswer;
  admission: Pick<Awaited<ReturnType<typeof readLspDaemonAdmission>>, 'queued' | 'inFlight' | 'settlementFailures'>;
  fileDrift: string[];
}
/** The same loaded-byte and settlement checks govern admission to load and
 * qualification afterward. A healthy RPC alone cannot qualify a runtime. */
export function replayBoundaryProblems(snapshot: ReplayBoundary, config: DaemonReplayConfig): string[] {
  const problems = [...snapshot.fileDrift];
  const runtime = snapshot.health.daemonRuntime;
  if (snapshot.health.error !== null || !runtime?.enabled ||
      !snapshot.processes.some(process => process.pid === runtime.pid) ||
      snapshot.processes.some(process => process.unknown.length || !process.cgroup))
    problems.push('unqualified-runtime-or-process');
  if (snapshot.populations.length !== 1 || snapshot.populations.some(population => population.unknown.length))
    problems.push('unqualified-server-descendant-population');
  for (const process of [...snapshot.processes, ...snapshot.populations.flatMap(population => population.processes)]) {
    if (!process.executable || config.files[process.executable.path] !== process.executable.sha256)
      problems.push(`unfrozen-running-executable:${process.pid}`);
    if (process.loadedModules === 'unmeasured') problems.push(`unqualified-loaded-module-population:${process.pid}`);
    else problems.push(...process.loadedModules.unknown.map(reason => `runtime:${process.pid}:${reason}`));
  }
  const servers = runtime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath));
  if (!servers || servers.length !== 1 || servers[0].health !== 'healthy' || !servers[0].taskId || !servers[0].pid)
    problems.push('unqualified-warm-server-population');
  for (const server of servers ?? []) {
    const process = snapshot.processes.find(process => process.pid === server.pid);
    const unit = process?.cgroup?.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!unit || taskIdFromScopeUnit(basename(unit)) !== server.taskId) problems.push('unqualified-server-task-cgroup');
    if (!snapshot.populations.some(population => population.taskId === server.taskId && population.rootPid === server.pid &&
        population.processes.some(process => process.pid === server.pid)))
      problems.push('unmatched-server-descendant-population');
  }
  if (snapshot.admission.queued || snapshot.admission.inFlight || snapshot.admission.settlementFailures.length)
    problems.push('unsettled-boundary');
  return [...new Set(problems)];
}

/** Archive is append-only and exclusively created; no prior evidence is overwritten. */
export async function runDaemonReplay(config: DaemonReplayConfig, archiveParent: string, deps: {
  captureRuntime?: (health: LspDaemonAnswer) => ReplayRuntimePopulation;
} = {}) {
  validateDaemonReplayConfig(config);
  const directory = join(archiveParent, config.runId);
  if (existsSync(directory)) throw new Error(`archive already exists:${directory}`);
  mkdirSync(directory, { recursive: true });
  const configFingerprint = replayHash(JSON.stringify(config));
  const record = (name: string, value: unknown) => appendFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ configFingerprint, config }, null, 2), { flag: 'wx' });
  const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
  process.env[LSP_DAEMON_SOCKET_ENV] = config.socketPath;
  const query = (queryClass: ReplayClass, id: string, actorId: string) => callLspDaemonRpc(config.socketPath, {
    op: queryClass === 'definition' ? 'symbol' : 'references', workspaceId: config.workspaceId,
    args: { ...config.corpus[queryClass].cursor,
      file: resolve(config.rootPath, config.corpus[queryClass].cursor.file), rootPath: config.rootPath }, actorId, archive: true,
    deadlineAtMs: Date.now() + config.requestTimeoutMs,
  }, config.requestTimeoutMs + 5_000, id);
  const boundary = async (label: string) => {
    const health = await callLspDaemonRpc(config.socketPath, { op: 'health', args: {}, archive: true,
      workspaceId: config.workspaceId }, 10_000, `${config.runId}/${label}`);
    const admission = await readLspDaemonAdmission(config.workspaceId);
    const runtime = health.daemonRuntime;
    const { processes, populations } = deps.captureRuntime ? deps.captureRuntime(health) : {
      processes: runtime ? [runtime.pid, ...runtime.servers.flatMap(server => server.pid ? [server.pid] : [])]
        .map(pid => replayProcessIdentity(pid, replayProcessReader, config.runtimeWitness)) : [],
      populations: runtime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath))
        .flatMap(server => server.pid && server.taskId ? [replayServerPopulation(server.pid, server.taskId, { witness: config.runtimeWitness })] : []) ?? [],
    };
    const snapshot = { label, atMs: Date.now(), health, admission, processes, populations,
      fileDrift: replayFileMismatches({ ...config.files, ...config.runtimeWitness?.files }) };
    record('boundaries.jsonl', snapshot);
    return snapshot;
  };
  const oracles = { definition: config.corpus.definition.oracle, 'hot-references': config.corpus['hot-references'].oracle };
  const triplets: ReplayTriplet[] = [];
  try {
    // Warm both intents independently; warmups remain visible but outside measured populations.
    const readinessProblems: string[] = [];
    for (const queryClass of REPLAY_CLASSES) {
      const answer = await query(queryClass, `${config.runId}/warm/${queryClass}`, 'warmup');
      const classification = classifyReplayAnswer(answer, oracles[queryClass]);
      record('warmups.jsonl', { queryClass, answer, classification });
      if (!classification.usefulCorrect) readinessProblems.push(...classification.reasons.map(reason => `${queryClass}:${reason}`));
    }
    record('preflights.jsonl', { phase: 'readiness', ready: readinessProblems.length === 0, reasons: readinessProblems });
    if (readinessProblems.length) throw new Error(`replay-readiness-refused:${readinessProblems.join(';')}`);
    for (const concurrency of config.levels) for (let trial = 0; trial < 3; trial += 1) {
      const trialId = `${config.runId}/c${concurrency}/t${trial}`;
      const start = await boundary(`c${concurrency}/t${trial}/start`);
      const startProblems = replayBoundaryProblems(start, config);
      record('preflights.jsonl', { phase: 'runtime', trialId, ready: startProblems.length === 0, reasons: startProblems });
      if (startProblems.length) throw new Error(`replay-start-boundary-refused:${startProblems.join(';')}`);
      const modes: ReplayMode[] = trial === 1 ? ['mixed', 'hot-references', 'definition'] : ['definition', 'hot-references', 'mixed'];
      const reports = new Map<ReplayMode, ReplayReport>();
      const problems: string[] = [];
      for (const mode of modes) {
        const report = replayDurableReport(await runReplay({ concurrency, mode, runId: `${trialId}/${mode}`, oracles,
          now: lspEvidenceNow, execute: request => query(request.queryClass, request.id, request.actorId) }), oracles);
        // Preserve every raw answer/ID/timestamp before scoring or inspecting qualification.
        record('runs.jsonl', report);
        reports.set(mode, report);
        problems.push(...replayEvidenceProblems(report));
        record('progress.jsonl', { trialId, mode, concurrency, complete: report.complete, classes: report.classes,
          failures: report.failures.length, certifiedFalseEmpty: report.certifiedFalseEmpty, certifiedStale: report.certifiedStale });
      }
      const end = await boundary(`c${concurrency}/t${trial}/end`);
      problems.push(...replayBoundaryProblems(end, config));
      if (JSON.stringify(start.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid])) !==
          JSON.stringify(end.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid]))) problems.push('changed-server-population');
      // Read receipts grow as new inputs are consumed; compare immutable process
      // identity separately and validate both complete receipt boundaries above.
      const identities = (rows: typeof start.processes) => rows.map(({ loadedModules: _loaded, ...row }) => row);
      if (JSON.stringify(identities(start.processes)) !== JSON.stringify(identities(end.processes)) ||
          JSON.stringify(start.populations.map(replayPopulationFingerprint)) !== JSON.stringify(end.populations.map(replayPopulationFingerprint)))
        problems.push('changed-runtime-process-identity');
      const mixed = reports.get('mixed')!;
      if (concurrency > 1 && !replayWireOverlap(mixed)) problems.push('no-measured-expensive-wire-overlap');
      const triplet: ReplayTriplet = { trialId, definition: reports.get('definition')!, references: reports.get('hot-references')!, mixed,
        qualification: { qualified: problems.length === 0, fingerprint: configFingerprint, reasons: [...new Set(problems)] } };
      triplets.push(triplet);
      record('triplets.jsonl', { trialId, qualification: triplet.qualification });
    }
    const result = evaluateReplayLadder(triplets, config.levels);
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ configFingerprint, result }, null, 2), { flag: 'wx' });
    return { directory, configFingerprint, result };
  } catch (error) {
    record('errors.jsonl', { atMs: Date.now(), error: String(error) });
    throw error;
  } finally {
    if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  }
}
