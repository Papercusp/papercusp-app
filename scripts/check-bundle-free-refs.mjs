#!/usr/bin/env node
/**
 * Build-time recurrence guard for EI-19521771595863238 / EI-25217214806027261.
 *
 * esbuild does not resolve identifiers the way tsc does. A TypeScript source that
 * references a name with no binding in scope (tsc: TS2304 "Cannot find name") is
 * bundled verbatim as a bare GLOBAL reference, and nothing fails until that code
 * executes. bundle-host.sh bundles the LIVE shared tree, so a peer's half-finished
 * edit (the call site written before the import, a const used outside the block
 * that declares it) is enough to publish a host that throws
 * `ReferenceError: X is not defined`. Measured twice on 2026-10-06:
 *   - 07:23Z: `loadAttributionRosterForTick` referenced outside its block scope in
 *     git-sync-action.ts; every git-sync fire on every install faulted for ~1h.
 *   - 08:23Z: `ADMISSION_RULE_SOURCE_KINDS` used in admit.ts before its import was
 *     added; bg-host crashed on boot.
 *
 * Whole-bundle scope analysis is too heavy for the boot path (acorn + eslint-scope
 * over the 66 MB host bundle: 35 s, 2.9 GB RSS). This guard instead analyses each
 * repo-owned bundle INPUT on its own, using @typescript-eslint's parser + scope
 * manager, and reports VALUE references that reach the global scope without a
 * binding the host runtime provides. By default only inputs modified after
 * `--since <file>` (the last-known-good bundle) are checked; `--all` checks every
 * repo-owned input and is how the allowlist below is calibrated.
 *
 * Exit: 0 clean · 1 free references found (bundle-host refuses to publish, so the
 * last-known-good bundle boots) · 2 misuse / unreadable metafile.
 * A file the parser cannot read is reported as `unparsed` and does NOT fail the
 * build: esbuild already accepted it, so that is an instrument gap, not evidence of
 * a defect, and refusing on it would trade a real-defect guard for false outages.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/typescript-estree';
import { analyze } from '@typescript-eslint/scope-manager';
import { visitorKeys } from '@typescript-eslint/visitor-keys';

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Names a bundled host input may legitimately reference that are NOT own properties
 * of the Node `globalThis`. Every entry carries the reason it is provided at runtime.
 * Re-seed from a measuring `--all --json` run, never from a hand-run grep.
 */
export const RUNTIME_PROVIDED_NAMES = new Map([
  ['require', 'CommonJS wrapper / esbuild __require shim (createRequire in the host banner)'],
  ['module', 'CommonJS wrapper (esbuild __commonJS)'],
  ['exports', 'CommonJS wrapper (esbuild __commonJS)'],
  ['__filename', 'CommonJS wrapper / host banner'],
  ['__dirname', 'CommonJS wrapper / host banner'],
  // Browser-only paths of client modules the host graph inlines (measured --all,
  // 2026-10-06: window x71, location x7, document x6, PopStateEvent x1). They run
  // only behind a runtime environment check, never in the node host.
  ['window', 'browser global (client module inlined into the host graph)'],
  ['document', 'browser global (client module inlined into the host graph)'],
  ['location', 'browser global (client module inlined into the host graph)'],
  ['PopStateEvent', 'browser global (client module inlined into the host graph)'],
]);

/** Known global value names: the running Node's globalThis plus RUNTIME_PROVIDED_NAMES plus `extra`. */
export function knownGlobalNames(extra = []) {
  const names = new Set(Object.getOwnPropertyNames(globalThis));
  for (const n of RUNTIME_PROVIDED_NAMES.keys()) names.add(n);
  for (const n of extra) names.add(n);
  return names;
}

function walk(node, enter, typeDepth = 0) {
  if (!node || typeof node.type !== 'string') return;
  const inType = typeDepth > 0 || node.type === 'TSTypeQuery' || node.type === 'TSTypeReference'
    || node.type === 'TSQualifiedName' || node.type === 'TSModuleDeclaration' || node.declare === true;
  enter(node, inType);
  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, enter, inType ? typeDepth + 1 : 0);
    } else if (child && typeof child === 'object') {
      walk(child, enter, inType ? typeDepth + 1 : 0);
    }
  }
}

/**
 * Free VALUE references in one source text: identifiers that resolve to no binding
 * in the file and are not known globals. `typeof X` probes and identifiers inside
 * type-only / ambient (`declare`) constructs are excluded — esbuild erases those.
 */
export function findFreeValueReferences(code, { jsx = false, known = knownGlobalNames() } = {}) {
  const ast = parse(code, { jsx, loc: true, range: true, comment: false, errorOnUnknownASTType: false });
  const typeofArgs = new Set();
  const typeOnly = new Set();
  walk(ast, (node, inType) => {
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument?.type === 'Identifier') {
      typeofArgs.add(node.argument);
    }
    if (inType && node.type === 'Identifier') typeOnly.add(node);
  });
  const scopeManager = analyze(ast, { sourceType: 'module', lib: [], jsxPragma: null, jsxFragmentName: null });
  const found = [];
  for (const ref of scopeManager.globalScope.through) {
    if (!ref.isValueReference) continue;
    const id = ref.identifier;
    if (id.type !== 'Identifier') continue;
    if (typeofArgs.has(id) || typeOnly.has(id)) continue;
    if (known.has(id.name)) continue;
    found.push({ name: id.name, line: id.loc.start.line, column: id.loc.start.column + 1 });
  }
  return found;
}

/** Repo-owned source inputs of an esbuild metafile, as absolute paths. */
export function repoOwnedInputs(metafile, baseDir) {
  const out = [];
  for (const key of Object.keys(metafile.inputs ?? {})) {
    if (key.includes(':')) continue; // esbuild namespaced virtual modules (e.g. `<define:...>`)
    const abs = isAbsolute(key) ? key : resolve(baseDir, key);
    if (abs.split(sep).includes('node_modules')) continue;
    if (!SOURCE_EXTENSIONS.has(extname(abs))) continue;
    out.push(abs);
  }
  return out.sort();
}

export function checkInputs(files, { known, readFile = (f) => readFileSync(f, 'utf8') } = {}) {
  const findings = [];
  const unparsed = [];
  for (const file of files) {
    let code;
    try {
      code = readFile(file);
    } catch (err) {
      unparsed.push({ file, error: `unreadable: ${err?.code ?? err?.message ?? err}` });
      continue;
    }
    const ext = extname(file);
    try {
      for (const f of findFreeValueReferences(code, { jsx: ext === '.tsx' || ext === '.jsx', known })) {
        findings.push({ file, ...f });
      }
    } catch (err) {
      unparsed.push({ file, error: String(err?.message ?? err).split('\n')[0] });
    }
  }
  return { findings, unparsed };
}

function parseArgs(argv) {
  const opts = { allow: [], all: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--metafile') opts.metafile = next();
    else if (a === '--base-dir') opts.baseDir = next();
    else if (a === '--since') opts.since = next();
    else if (a === '--allow') opts.allow.push(next());
    // esbuild's own `--define:NAME=VALUE` arguments, passed through verbatim by
    // bundle-host.sh: esbuild substitutes NAME, so a source reference to it is bound.
    else if (a.startsWith('--define:')) opts.allow.push(a.slice('--define:'.length).split('=')[0]);
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.metafile || !opts.baseDir) throw new Error('--metafile and --base-dir are required');
  return opts;
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let opts;
  let metafile;
  try {
    opts = parseArgs(argv);
    metafile = JSON.parse(readFileSync(opts.metafile, 'utf8'));
  } catch (err) {
    io.error(`check-bundle-free-refs: ${err?.message ?? err}`);
    io.log('BUNDLE_FREE_REFS_RESULT status=error');
    return 2;
  }
  const inputs = repoOwnedInputs(metafile, opts.baseDir);
  let selection = 'all';
  let files = inputs;
  if (!opts.all) {
    let sinceMs = null;
    if (opts.since) {
      try {
        sinceMs = statSync(opts.since).mtimeMs;
      } catch {
        sinceMs = null;
      }
    }
    if (sinceMs === null) {
      // No last-known-good bundle: there is nothing to fall back to, so a refusal
      // would only turn a possibly-broken boot into a certain non-boot. Skip.
      io.log(`BUNDLE_FREE_REFS_RESULT status=skipped selection=no-baseline inputs=${inputs.length} checked=0 findings=0 unparsed=0 ms=0`);
      return 0;
    } else {
      selection = 'changed-since-baseline';
      files = inputs.filter((f) => {
        try {
          return statSync(f).mtimeMs > sinceMs;
        } catch {
          return true;
        }
      });
    }
  }
  const t0 = Date.now();
  const known = knownGlobalNames(opts.allow);
  const { findings, unparsed } = checkInputs(files, { known });
  const ms = Date.now() - t0;
  const status = findings.length > 0 ? 'refused' : 'clean';
  if (opts.json) {
    io.log(JSON.stringify({ status, selection, inputs: inputs.length, checked: files.length, ms, findings, unparsed }));
  } else {
    for (const f of findings) {
      io.error(`🚨 free reference \`${f.name}\` at ${f.file}:${f.line}:${f.column} — no binding in scope and not a host global; the bundle would throw ReferenceError when this runs`);
    }
    for (const u of unparsed) io.error(`⚠ could not analyse ${u.file}: ${u.error}`);
  }
  io.log(`BUNDLE_FREE_REFS_RESULT status=${status} selection=${selection} inputs=${inputs.length} checked=${files.length} findings=${findings.length} unparsed=${unparsed.length} ms=${ms}`);
  return findings.length > 0 ? 1 : 0;
}

// Basename pin, as in check-bundled-cli-entry-guards.mjs: bundle-host.sh runs this under
// plain node with the committed-source loader, before any bundle exists.
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-bundle-free-refs\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  process.exitCode = main();
}
