/** The existing conservative graph walk, executed only inside an owned compiler worker. */
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';
import { createRequireSpecifiers, unfollowableImportCall } from './create-require-specifiers.ts';

const CLOSURE_FILE_CAP = 20_000;

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

export type Closure =
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
export async function computeImportClosures(root: string, tests: string[]): Promise<Closure> {
  let metafile: Metafile;
  const unfollowable = new Map<string, string>();
  try {
    const outdir = join(tmpdir(), 'mutation-probe-closure');
    const result = await build({
        entryPoints: tests, absWorkingDir: root, bundle: true, write: false, metafile: true,
        // Tree-shaking off so the unfollowed-import scan below sees every module's code.
        outdir, platform: 'node', format: 'esm', treeShaking: false,
        logLevel: 'silent', plugins: [externalPackages, createRequireEdges(unfollowable)],
        loader: {
          '.json': 'json', '.md': 'text', '.sql': 'text', '.txt': 'text', '.html': 'text', '.yaml': 'text', '.yml': 'text',
          '.css': 'empty', '.scss': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.gif': 'empty',
          '.woff': 'empty', '.woff2': 'empty', '.wasm': 'empty', '.node': 'empty',
        },
      });
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

