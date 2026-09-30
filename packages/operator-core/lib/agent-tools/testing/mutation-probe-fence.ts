/** Read the active file-lock lease that marks an in-tree mutation window. */
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getuid } from 'node:process';
import { build, type Metafile, type Plugin } from 'esbuild';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';
import { createRequireSpecifiers, unfollowableImportCall } from './create-require-specifiers';

/**
 * Return active mutation-probe paths for one physical checkout. The lock is a
 * checkout-wide marker: which test files it fences is decided by
 * `mutationProbeRefusal` below, not by path overlap with the requested tests.
 */
export async function activeMutationProbePaths(checkoutRoot: string): Promise<string[]> {
  const coordinationDomain = await realpath(checkoutRoot);
  await ensureBootstrap();
  const queue = await readQueue(getTxPool(), { coordinationDomain });
  return queue.active_locks
    .filter((lock) => String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe')
    .map((lock) => lock.path)
    .sort();
}

export type MutationProbeRefusal = {
  error: 'mutation_probe_active' | 'mutation_probe_state_unknown';
  hint: string;
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const CLOSURE_FILE_CAP = 20_000;
const CLOSURE_BUDGET_MS = 20_000;
/**
 * Test-side code that reaches source through the FILESYSTEM or a child process instead of an
 * import. The import closure cannot see those reads, so a match refuses the run. A heuristic
 * that can only over-refuse: a false hit costs a retry, a miss would admit a mutant.
 */
const OUT_OF_GRAPH_ACCESS =
  /(?<![\w$])(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|fastGlob|spawn|spawnSync|execSync|execFile|execFileSync|execa|fork)\s*\(|(?<![\w$.])exec\s*\(|import\.meta\.glob/;
const TEST_SIDE_FILE = /(^|[\\/])(__tests__|tests?|fixtures?)[\\/]|\.(test|spec)\.|test-?(helpers?|utils?)/i;

/** esbuild resolves a bare specifier; anything that lands in node_modules is a package, not source. */
const externalPackages: Plugin = {
  name: 'mutation-probe-external-packages',
  setup(pluginBuild) {
    const nested = Symbol('nested');
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === nested || isAbsolute(args.path)) return undefined;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      const resolved = await pluginBuild.resolve(args.path, {
        kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: nested,
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      if (resolved.external) return { path: args.path, external: true };
      return resolved.path.split(sep).includes('node_modules') ? { path: args.path, external: true } : { path: resolved.path };
    });
  },
};

/**
 * EI-24556278753778650: make `createRequire` loaders visible to the import graph. esbuild cannot
 * follow a require made through `createRequire(...)`, so each such module is analysed and every
 * specifier its loaders can load is appended as a side-effect import. esbuild then resolves those
 * and walks them like any other edge (a builtin/package stays external), so a test's closure grows
 * by exactly what the loader can reach. A loader whose specifier set cannot be established is
 * recorded per MODULE, which refuses only the tests whose closure actually reaches that module.
 */
const CODE_FILTER = /\.(?:[cm]?[jt]s|[jt]sx)$/;
function createRequireEdges(unfollowable: Map<string, string>): Plugin {
  return {
    name: 'mutation-probe-create-require-edges',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: CODE_FILTER }, async (args) => {
        if (args.namespace !== 'file' || args.path.split(sep).includes('node_modules')) return undefined;
        const text = await readFile(args.path, 'utf8');
        // The regex is a cheap prefilter; the AST decides (strings and comments are not calls).
        const dynamic = unfollowedImportAt(text) === null ? null : unfollowableImportCall(args.path, text);
        if (dynamic) unfollowable.set(args.path, `has an import this walk cannot follow: ${dynamic}`);
        const analysis = createRequireSpecifiers(args.path, text);
        if (analysis === null) return undefined;
        if (analysis.status === 'unfollowable') {
          if (!unfollowable.has(args.path)) unfollowable.set(args.path, `has a createRequire loader this walk cannot follow: ${analysis.reason}`);
          return undefined;
        }
        if (analysis.specifiers.length === 0) return undefined;
        const ext = extname(args.path).slice(1);
        const loader = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : /^[cm]?ts$/.test(ext) ? 'ts' : 'js';
        return {
          contents: `${text}\n${analysis.specifiers.map((spec) => `import ${JSON.stringify(spec)};`).join('\n')}\n`,
          loader, resolveDir: dirname(args.path),
        };
      });
    },
  };
}

type Closure =
  | { status: 'complete'; files: Map<string, Set<string>>; unfollowable: Map<string, string> }
  | { status: 'incomplete'; reason: string };

/**
 * An import esbuild could not follow. esbuild inlines every literal import it resolves and
 * keeps a quoted specifier for an external package, so an `import(`/`require(` left in the
 * bundle without a plain string literal is an edge the metafile graph does not contain.
 * Comments before a literal are trivia, while template literals can interpolate runtime paths.
 * esbuild does not warn for a non-literal `import()` in ESM output, so this scan is the signal.
 */
const IMPORT_CALL = /(?<![\w$.])(?:import|__require|require)\s*\(/g;

/** Skip comments as well as whitespace before classifying an import argument. */
function importArgumentStart(text: string, start: number): number {
  let at = start;
  for (;;) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) return at;
      at = end + 2;
    } else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at + 2);
      if (end < 0) return at;
      at = end + 1;
    } else {
      return at;
    }
  }
}

/** createRequire loaders are handled by the AST analysis above, not by this textual scan. */
function unfollowedImportAt(text: string): number | null {
  IMPORT_CALL.lastIndex = 0;
  for (const match of text.matchAll(IMPORT_CALL)) {
    const at = importArgumentStart(text, match.index + match[0].length);
    // esbuild keeps resolved external package imports as quoted specifiers.
    if (text[at] !== '"' && text[at] !== "'") return match.index;
  }
  return null;
}

/**
 * The static module closure of each requested test file (absolute paths), computed by bundling
 * with esbuild and walking the metafile's import graph from each entry. The graph is walked
 * rather than read from the outputs because tree-shaking drops side-effect-free modules from
 * an output, while Vitest still evaluates them.
 */
async function testImportClosures(root: string, tests: string[]): Promise<Closure> {
  let metafile: Metafile;
  const unfollowable = new Map<string, string>();
  try {
    const outdir = join(tmpdir(), 'mutation-probe-closure');
    const result = await Promise.race([
      build({
        entryPoints: tests, absWorkingDir: root, bundle: true, write: false, metafile: true,
        // Tree-shaking off so the unfollowed-import scan below sees every module's code.
        outdir, platform: 'node', format: 'esm', treeShaking: false,
        logLevel: 'silent', plugins: [externalPackages, createRequireEdges(unfollowable)],
        loader: {
          '.json': 'json', '.md': 'text', '.sql': 'text', '.txt': 'text', '.html': 'text', '.yaml': 'text', '.yml': 'text',
          '.css': 'empty', '.scss': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.gif': 'empty',
          '.woff': 'empty', '.woff2': 'empty', '.wasm': 'empty', '.node': 'empty',
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`closure exceeded ${CLOSURE_BUDGET_MS}ms`)), CLOSURE_BUDGET_MS).unref()),
    ]);
    // An import esbuild could not follow is an edge this walk cannot see.
    const unfollowed = result.warnings.find((w) => w.id === 'unsupported-dynamic-import' || w.id === 'unsupported-require-call');
    if (unfollowed) {
      const at = unfollowed.location ? ` (${unfollowed.location.file}:${unfollowed.location.line})` : '';
      return { status: 'incomplete', reason: `non-literal import${at}` };
    }
    // Non-literal import()/require() calls and createRequire loaders are recorded per source
    // module by the onLoad plugin (EI-24556278753778650), so they refuse only the tests whose
    // closure reaches that module. Scanning the bundle TEXT refused every test for the words
    // `import(...)` inside a string.
    metafile = result.metafile;
  } catch (error) {
    const first = (error as { errors?: Array<{ text: string }> }).errors?.[0]?.text;
    return { status: 'incomplete', reason: (first ?? (error instanceof Error ? error.message : String(error))).slice(0, 200) };
  }
  const inputs = Object.keys(metafile.inputs);
  if (inputs.length > CLOSURE_FILE_CAP) return { status: 'incomplete', reason: `closure exceeds ${CLOSURE_FILE_CAP} files` };
  const edges = new Map(inputs.map((key) => [resolve(root, key),
    metafile.inputs[key]!.imports.filter((edge) => !edge.external).map((edge) => resolve(root, edge.path))]));
  const files = new Map<string, Set<string>>();
  for (const test of tests) {
    const seen = new Set<string>([test]);
    const queue = [test];
    while (queue.length > 0) {
      for (const next of edges.get(queue.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    files.set(test, seen);
  }
  return { status: 'complete', files, unfollowable };
}

/** Why one test file may observe a probed source, or null when its closure provably cannot. */
async function reachReason(
  closure: Set<string>, test: string, probes: string[], unfollowable: Map<string, string>,
): Promise<string | null> {
  const hit = probes.find((probe) => closure.has(probe));
  if (hit) return `imports ${hit}`;
  for (const [file, why] of unfollowable) {
    if (closure.has(file)) return `${file} ${why}`;
  }
  // The extension-less stem also catches a path assembled at runtime (`name + '.ts'`).
  const names = probes.map((probe) => basename(probe, extname(probe)));
  for (const file of closure) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return `could not read ${file}`;
    const named = names.find((name) => text.includes(name));
    if (named) return `${file} names ${named}`;
    if ((file === test || TEST_SIDE_FILE.test(file)) && OUT_OF_GRAPH_ACCESS.test(text)) {
      return `${file} reads the filesystem or spawns a process`;
    }
  }
  return null;
}

/**
 * The mutation-probe preflight for one checkout, or null when the run may proceed. Called
 * BEFORE anything durable is written for the run (EI-24100872054224181): a refusal that
 * starts no test process must not leave evidence rows behind.
 *
 * An in-tree probe holds its subject mutated for the dirty window. A requested test file is
 * admitted only when its whole static import closure resolves, excludes every probed path,
 * never names one, and does no filesystem walk or spawn from test-side code. Anything the walk
 * cannot establish refuses the run, as does a probed path that is not a code module (only the
 * filesystem reaches it). The lock read is fail-closed: without a current answer this runner
 * cannot claim it avoided a mutant.
 */
export async function mutationProbeRefusal(
  root: string,
  files: string[],
  deps: { probePaths?: typeof activeMutationProbePaths } = {},
): Promise<MutationProbeRefusal | null> {
  if (!existsSync(root)) return null;
  let probePaths: string[];
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    probePaths = await (deps.probePaths ?? activeMutationProbePaths)(root);
  } catch (error) {
    return {
      error: 'mutation_probe_state_unknown',
      hint: `could not verify whether an in-tree mutation probe is active; no test process was started (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (probePaths.length === 0) return null;
  // The in-tree probe publishes its immutable original before changing the
  // subject. Every testing:run child enters the admission wrapper, which holds
  // a shared flock through the whole test and binds this copy over the mutant.
  // A legacy probe without that snapshot still needs the closure fence below.
  const admissionKey = createHash('sha256').update(realRoot).digest('hex');
  const manifestPath = join('/tmp', `papercusp-mutation-probe-${getuid?.() ?? 0}-${admissionKey}`, 'original.manifest');
  const manifest = await readFile(manifestPath).catch(() => null);
  if (manifest) {
    const fields = manifest.toString('utf8').split('\0');
    if (fields.length === 5 && fields[4] === '' && fields[0] === realRoot && probePaths.length === 1
      && fields[1] === resolve(realRoot, probePaths[0]!)) return null;
  }
  const refuse = (why: string): MutationProbeRefusal => ({
    error: 'mutation_probe_active',
    hint: `no test process was started because this checkout has an active mutation probe on ${probePaths.join(', ')} and ${why}; retry after the probe restores its source`,
  });
  const probes = probePaths.map((path) => resolve(realRoot, path));
  const nonModule = probePaths.find((path) => !CODE_EXTENSIONS.has(extname(path)));
  if (nonModule) return refuse(`${nonModule} is not a code module, so only a filesystem read can reach it`);
  const tests: string[] = [];
  for (const file of files) {
    const absolute = resolve(realRoot, file);
    if (!existsSync(absolute)) return refuse(`${file} could not be resolved for an import-closure check`);
    tests.push(await realpath(absolute));
  }
  const closure = await testImportClosures(realRoot, tests);
  if (closure.status === 'incomplete') return refuse(`the import closure could not be established (${closure.reason})`);
  for (const test of tests) {
    const reason = await reachReason(closure.files.get(test)!, test, probes, closure.unfollowable);
    if (reason) return refuse(`${test.startsWith(realRoot + sep) ? test.slice(realRoot.length + 1) : test} may observe it: ${reason}`);
  }
  return null;
}
