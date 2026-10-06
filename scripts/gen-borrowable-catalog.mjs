#!/usr/bin/env node
/**
 * gen-borrowable-catalog.mjs — regenerate BORROWABLE.md.
 *
 * Papercusp owns a set of general-purpose libraries that carry **no
 * Papercusp/Restart domain coupling** — any project can borrow them. They
 * live scattered across `packages/*` (in-repo) and `libs/*` (git
 * submodules = standalone repos under github.com/Papercusp/). This script
 * is the single source of truth for *which* libs are borrowable; it reads
 * each one's package.json for name + description and its repo from
 * .gitmodules, then emits a grouped catalog.
 *
 *   node scripts/gen-borrowable-catalog.mjs        # write BORROWABLE.md
 *   node scripts/gen-borrowable-catalog.mjs --check # CI: fail if stale
 *
 * To add/remove a lib, edit BORROWABLE below and re-run. Membership is
 * curated here (not a package.json keyword) so tagging a submodule never
 * requires a submodule commit. See papercusp-systems-abstraction-2026-05-29.
 *
 * EI-14414: a brand-new submodule repo has NO .gitignore of its own — the
 * superproject .gitignore does not reach inside a submodule (each is its own
 * repo), and git-sync auto-commits every submodule on a schedule with no
 * grace period. That means the moment anything creates untracked files in a
 * fresh submodule (an `npm install`, a test run), git-sync can sweep
 * `node_modules`/build scratch straight into its history within minutes —
 * exactly what happened extracting @papercusp/model-pricing (WI-5143). So
 * this script, already the single source of truth for the borrowable set,
 * also scaffolds/verifies each submodule-rooted lib's `.gitignore`: `--check`
 * fails CI if one is missing (same as a stale BORROWABLE.md); the default
 * write mode creates the standard one on the spot, so adding a lib to
 * BORROWABLE and running `npm run gen:borrowable` can never forget it.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Standard .gitignore for a new borrowable-lib submodule (verbatim from
 * `libs/generic/rate-limit/.gitignore`, the WI-4419-hardened template already
 * used across the existing libs). Applied only to submodule ROOTS (not a
 * nested path inside an already-covered submodule) that don't have one yet.
 */
const STANDARD_LIB_GITIGNORE = `node_modules/
dist/
*.tsbuildinfo
coverage/
junit.xml
.DS_Store

# WI-4419 (2026-07-12): agent state dirs (.papercusp/) appear inside submodules too,
# and git-sync auto-commits the superproject AND every submodule — so any scratch a
# gitignore does not cover is committed automatically and then swept into every
# release bundle by the sidecar source-tar glob. The superproject .gitignore does NOT
# reach inside a submodule, so the guard must be repeated here. Depth-matching (**/)
# on purpose: a slash-bearing pattern is anchored to THIS file's directory.
.papercusp/scratch/
.papercusp/vitest-tmp/
.papercusp/tmp/
.papercusp/tmp-*/
.papercusp/logs/
.papercusp/bench-reports/
.papercusp/pi-sessions/
**/.papercusp/scratch/
**/.papercusp/vitest-tmp/
**/.papercusp/tmp/
**/.papercusp/tmp-*/
**/.papercusp/logs/
**/.papercusp/bench-reports/
**/.papercusp/pi-sessions/
`;

/** Submodule ROOTS (non-nested) among BORROWABLE that are missing a `.gitignore`. */
function findMissingGitignores(submodules) {
  const missing = [];
  for (const [p] of BORROWABLE) {
    const src = sourceFor(p, submodules);
    if (src.kind !== 'submodule' || src.nested) continue;
    if (!existsSync(join(ROOT, p, '.gitignore'))) missing.push(p);
  }
  return missing;
}

/**
 * The borrowable set — genuinely generic, zero retained domain tie-in.
 * Exported (WI-4973 / decouple-generic-libs-private-deps-2026-08-03) so
 * scripts/check-generic-independence.mjs can classify a dependency as
 * "public" off this SAME curated list instead of re-curating it — the
 * package.json `"private": true` field is NOT a public/private signal here
 * (it appears on fully-public libs too; it only means "not npm-published").
 */
export const BORROWABLE = [
  // path (repo-relative)                  category                fallback description (only if package.json lacks one)
  ['libs/generic/rrf',                        'Pure utilities & infra'],
  ['libs/generic/rules',                      'Pure utilities & infra'],
  ['libs/generic/image-blankness',            'Pure utilities & infra'],
  ['libs/generic/step-program',               'Pure utilities & infra'],
  ['libs/generic/event-reaction',             'Pure utilities & infra'],
  ['libs/generic/structured-concurrency',     'Pure utilities & infra'],
  ['libs/generic/failure-detector',           'Pure utilities & infra'],
  ['libs/generic/locks-core',                 'Pure utilities & infra'],
  ['libs/generic/fanout-resolver',            'Pure utilities & infra'],
  ['libs/generic/projection-index',           'Pure utilities & infra'],
  ['libs/generic/activity-bridge',            'Pure utilities & infra'],
  ['libs/generic/plugin-loader',              'Pure utilities & infra'],
  ['libs/generic/control-mutation',           'Pure utilities & infra'],
  ['libs/generic/embedded-pg-discovery',      'Pure utilities & infra'],
  ['libs/generic/linkable-edges',             'Pure utilities & infra'],
  ['libs/generic/dependency-order',           'Pure utilities & infra'],
  ['libs/generic/plan-parser',                'Pure utilities & infra'],
  ['libs/generic/seed-bundle',                'Pure utilities & infra'],
  ['libs/generic/pot-app-seam',              'Pure utilities & infra'],
  ['libs/generic/rate-limit',                 'Pure utilities & infra'],
  ['libs/generic/model-pricing',               'Pure utilities & infra'],
  ['libs/generic/artifact-registry',          'Pure utilities & infra'],
  ['libs/generic/release-profile',            'Pure utilities & infra'],
  ['libs/generic/papergrid/kv-persist',           'Pure utilities & infra'],
  ['libs/generic/papergrid/kv-persist-indexeddb', 'Pure utilities & infra'],
  ['libs/papercusp/packages/file-claim',  'Pure utilities & infra'],
  ['libs/generic/token-kit',                      'Pure utilities & infra'],
  ['libs/generic/resumable-download',             'Pure utilities & infra'],
  ['libs/generic/result-encoding',                'Pure utilities & infra'],
  ['libs/generic/module-singleton',                'Pure utilities & infra'],
  ['libs/generic/debounce-coalesce',              'Pure utilities & infra'],
  ['libs/generic/search',                     'Search & retrieval'],
  ['libs/generic/search-core',                    'Search & retrieval'],
  ['libs/generic/rerank',                         'Search & retrieval'],
  ['libs/generic/memory',                     'Search & retrieval'],
  ['libs/generic/ipc-framing',                'IPC, transport & sync'],
  ['libs/generic/ipc-endpoint-server',        'IPC, transport & sync'],
  ['libs/generic/desktop-ipc',                'IPC, transport & sync'],
  ['libs/generic/sse',                            'IPC, transport & sync'],
  ['libs/generic/sync',                           'IPC, transport & sync'],
  ['libs/generic/chat-protocol',                  'IPC, transport & sync'],
  ['libs/generic/tooldef',                        'IPC, transport & sync'],
  ['libs/generic/tooldef-http',                   'IPC, transport & sync'],
  ['libs/generic/pubsub-substrate',               'IPC, transport & sync'],
  ['libs/generic/p2p-voice',                      'Audio & media'],
  ['libs/generic/audio-dsp',                      'Audio & media'],
  ['libs/generic/kokoro-tts',                     'Audio & media'],
  ['libs/generic/ui-primitives',                  'UI components'],
  ['libs/generic/card-stack',                     'UI components'],
  ['libs/generic/dock-workbench',                 'UI components'],
  ['libs/generic/git-graph',                      'UI components'],
  ['libs/generic/papergrid/grid-core',            'UI components'],
  ['libs/generic/papergrid/bloom-grid',           'UI components'],
  ['libs/generic/tauri-release-kit',              'Build & release'],
  ['libs/testing-shell',                          'Testing & QA'],
  ['libs/test-config',                            'Testing & QA'],
];

/**
 * Reusable-but-coupled: shipped with a host-injection seam, but deliberately
 * retain a Papercusp tie-in (kept by decision). Listed for discoverability,
 * not "borrow as-is".
 */
const SEAMED = [
  ['libs/papercusp/packages/locks', 'Distributed file-lock coordinator (own side-DB + advisory locks); generic via an opaque coordination domain.'],
  ['packages/coordination',   'Papercusp Postgres tie-in adapter over @papercusp/pubsub-substrate (generic pub/sub: core + event-log + presence + watermark + topic/subscription/thread fan-out) and @papercusp/linkable-edges; keeps only the harness_shared-bound Pg* backends.'],
  ['packages/backup',         'Per-workspace kopia backup behind a BackupHost config seam.'],
  ['packages/docs-engine',    'Source-agnostic docs retrieval; ships a generic-fs/starlight adapter plus a harness-fs one.'],
  ['libs/host-platform',      'The host-boundary interface — the ~10% that is genuinely host-specific (fs, PG-DSN resolution).'],
];

const CATEGORY_ORDER = ['Pure utilities & infra', 'Search & retrieval', 'IPC, transport & sync', 'Audio & media', 'UI components', 'Build & release', 'Testing & QA'];

/**
 * Libraries whose public exports are listed in the catalog's "Export index",
 * so a reader can find a piece (and grep for a function) without opening the
 * library. Opt-in, and limited to libraries that bundle several independent
 * pieces under one package: indexing every library would add about 57K
 * characters (1,374 values + 1,194 types across 57 libraries, measured
 * 2026-10-01) and would make `gen:borrowable:check` go stale on every export
 * change anywhere. The list itself is derived from each entry module, never
 * hand-written. Added for shared-vector-search-libraries-2026-09-29 R-15.
 */
export const EXPORT_INDEX = new Set(['libs/generic/search', 'libs/generic/search-core']);

/** The TypeScript parser, loaded only when an export index is built. */
function typescript() {
  return createRequire(import.meta.url)('typescript');
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** The TypeScript source a library's root import resolves to. */
export function entryModule(libDir) {
  const pkg = JSON.parse(readFileSync(join(libDir, 'package.json'), 'utf8'));
  const dot = pkg.exports?.['.'];
  const fromExports = typeof dot === 'string' ? dot : dot?.types ?? dot?.import ?? dot?.default;
  for (const rel of [fromExports, pkg.types, pkg.main, 'src/index.ts', 'index.ts']) {
    if (typeof rel !== 'string') continue;
    const p = join(libDir, rel);
    if (/\.(m?ts|tsx)$/.test(p) && isFile(p)) return p;
    const ts = p.replace(/\.m?js$/, '.ts');
    if (isFile(ts)) return ts;
  }
  return null;
}

function resolveRelative(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  const bare = base.replace(/\.m?js$/, '');
  for (const c of [base, `${bare}.ts`, `${bare}.tsx`, `${bare}.mts`, join(base, 'index.ts')]) {
    if (/\.(m?ts|tsx)$/.test(c) && isFile(c)) return c;
  }
  return null;
}

function parse(file) {
  const ts = typescript();
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
}

function exportsKeyword(node) {
  const ts = typescript();
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Names declared at a module's top level, each marked 'type' or 'value'. */
function declaredKinds(sf) {
  const ts = typescript();
  const kinds = new Map();
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) kinds.set(st.name.text, 'type');
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) kinds.set(st.name.text, 'value');
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) kinds.set(d.name.text, 'value');
    } else if (ts.isImportDeclaration(st) && st.importClause) {
      const bindings = st.importClause.namedBindings;
      const typeOnly = st.importClause.isTypeOnly;
      if (st.importClause.name) kinds.set(st.importClause.name.text, typeOnly ? 'type' : 'value');
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) kinds.set(el.name.text, typeOnly || el.isTypeOnly ? 'type' : 'value');
    }
  }
  return kinds;
}

/**
 * Every name a module exports, mapped to 'type' or 'value', following
 * relative re-exports. `external` collects packages re-exported wholesale
 * (`export * from 'pkg'`), whose names cannot be listed from this tree.
 */
export function moduleExports(file, seen = new Set()) {
  const ts = typescript();
  const names = new Map();
  const external = new Set();
  if (seen.has(file)) return { names, external };
  seen.add(file);
  const sf = parse(file);
  const local = declaredKinds(sf);
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const target = spec?.startsWith('.') ? resolveRelative(file, spec) : null;
      if (spec?.startsWith('.') && !target) throw new Error(`${file}: cannot resolve re-export '${spec}'`);
      const inner = target ? moduleExports(target, seen) : null;
      if (!st.exportClause) {
        if (inner) {
          for (const [n, k] of inner.names) if (n !== 'default') names.set(n, k);
          inner.external.forEach((e) => external.add(e));
        } else if (spec) external.add(spec);
      } else if (ts.isNamespaceExport(st.exportClause)) {
        names.set(st.exportClause.name.text, 'value');
      } else {
        for (const el of st.exportClause.elements) {
          const source = (el.propertyName ?? el.name).text;
          const known = inner ? inner.names.get(source) : spec ? undefined : local.get(source);
          names.set(el.name.text, st.isTypeOnly || el.isTypeOnly ? 'type' : known ?? 'value');
        }
      }
    } else if (ts.isExportAssignment(st)) {
      names.set('default', 'value');
    } else if (exportsKeyword(st)) {
      for (const [n, k] of declaredKinds({ statements: [st] })) names.set(n, k);
    }
  }
  return { names, external };
}

/**
 * A library's public exports grouped by the entry statement that exposes
 * them: one group per re-exported module (in entry order), one for names the
 * entry declares itself, one per package re-exported wholesale.
 */
export function exportIndex(libDir) {
  const ts = typescript();
  const entry = entryModule(libDir);
  if (!entry) throw new Error(`${libDir}: no TypeScript entry module (package.json exports/types/main)`);
  const groups = [];
  const group = (label, external = false) => {
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, external, values: [], types: [], wholesale: false }));
    return g;
  };
  const sf = parse(entry);
  const local = declaredKinds(sf);
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const relative = spec?.startsWith('.');
      const g = group(spec ?? 'entry', Boolean(spec && !relative));
      const target = relative ? resolveRelative(entry, spec) : null;
      if (relative && !target) throw new Error(`${entry}: cannot resolve re-export '${spec}'`);
      const inner = target ? moduleExports(target) : null;
      if (!st.exportClause) {
        if (!inner) { g.wholesale = true; continue; }
        for (const [n, k] of inner.names) if (n !== 'default') (k === 'type' ? g.types : g.values).push(n);
        for (const e of inner.external) group(e, true).wholesale = true;
      } else if (ts.isNamespaceExport(st.exportClause)) {
        g.values.push(st.exportClause.name.text);
      } else {
        for (const el of st.exportClause.elements) {
          const source = (el.propertyName ?? el.name).text;
          const known = inner ? inner.names.get(source) : spec ? undefined : local.get(source);
          ((st.isTypeOnly || el.isTypeOnly ? 'type' : known ?? 'value') === 'type' ? g.types : g.values).push(el.name.text);
        }
      }
    } else if (ts.isExportAssignment(st)) {
      group('entry').values.push('default');
    } else if (exportsKeyword(st)) {
      for (const [n, k] of declaredKinds({ statements: [st] })) (k === 'type' ? group('entry').types : group('entry').values).push(n);
    }
  }
  return { entry, groups };
}

function exportIndexSection(libDir) {
  const pkg = readPkg(libDir);
  const { entry, groups } = exportIndex(join(ROOT, libDir));
  const tick = (names) => names.map((n) => `\`${n}\``).join(', ');
  const lines = [`### \`${pkg.name}\``, '', `Entry: \`${entry.slice(ROOT.length + 1)}\`.`, ''];
  for (const g of groups) {
    const label = g.label === 'entry' ? 'declared in the entry' : g.external ? `\`${g.label}\` (re-exported)` : `\`${g.label}\``;
    const parts = [];
    if (g.wholesale) parts.push('everything it exports');
    if (g.values.length) parts.push(tick(g.values));
    if (g.types.length) parts.push(`types: ${tick(g.types)}`);
    lines.push(`- ${label} — ${parts.join(' · ')}`);
  }
  lines.push('');
  return lines;
}

export function parseGitmodules() {
  const map = {};
  let text = '';
  try { text = readFileSync(join(ROOT, '.gitmodules'), 'utf8'); } catch { return map; }
  let path = null;
  for (const line of text.split('\n')) {
    const p = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    const u = line.match(/^\s*url\s*=\s*(.+)\s*$/);
    if (p) path = p[1].trim();
    if (u && path) { map[path] = u[1].trim(); path = null; }
  }
  return map;
}

export function readPkg(p) {
  return JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
}

/** Find the submodule root that contains `p` (a path may live under a submodule). */
export function sourceFor(p, submodules) {
  if (submodules[p]) return { kind: 'submodule', repo: submodules[p], path: p };
  for (const subPath of Object.keys(submodules)) {
    if (p === subPath || p.startsWith(subPath + '/')) {
      return { kind: 'submodule', repo: submodules[subPath], path: p, nested: p !== subPath };
    }
  }
  return { kind: 'in-repo', path: p };
}

function repoCell(src) {
  if (src.kind === 'submodule') {
    const slug = src.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const label = src.nested ? `\`${src.path}\` · ` : '';
    return `${label}[${slug}](${src.repo})`;
  }
  return `in-repo · \`${src.path}\``;
}

function row(p, fallbackDesc, submodules) {
  const pkg = readPkg(p);
  const desc = (pkg.description || fallbackDesc || '—').replace(/\s+/g, ' ').trim();
  return `| \`${pkg.name}\` | ${desc} | ${repoCell(sourceFor(p, submodules))} |`;
}

function build(submodules) {
  const byCat = {};
  for (const [p, cat, fb] of BORROWABLE) (byCat[cat] ??= []).push(row(p, fb, submodules));

  const lines = [];
  lines.push('# Borrowable libraries');
  lines.push('');
  lines.push('> **Generated — do not edit by hand.** Run `npm run gen:borrowable`.');
  lines.push('> Source of truth: `scripts/gen-borrowable-catalog.mjs`.');
  lines.push('');
  lines.push('Papercusp builds a number of **general-purpose libraries with zero');
  lines.push('Papercusp/Restart domain coupling** — any project can borrow them. Each');
  lines.push('names no consuming app: where a host-specific value is needed it is');
  lines.push('injected via a small seam (a `configure*()` call or a prop), and Papercusp');
  lines.push('maps its own domain onto that seam in the operator.');
  lines.push('');
  lines.push('Most live as standalone git submodules (their own repo under');
  lines.push('`github.com/Papercusp/`) — clone that one repo to borrow it. In-repo');
  lines.push('packages are consumed as `file:` workspace deps and can be promoted to');
  lines.push('their own repo when needed.');
  lines.push('');
  lines.push('**Generic-first.** A new domain-free algorithm — a textbook concurrency /');
  lines.push('distributed-systems / data-structure core — **starts in `libs/generic/<name>`');
  lines.push('behind a seam**, not in the app to be migrated out later. `npm run');
  lines.push('lint:generic-first` (advisory; `:all` for a full-tree sweep) flags a');
  lines.push('zero-coupling, concept-naming algorithm file that landed in the app and nudges');
  lines.push('it here.');
  lines.push('');
  for (const cat of CATEGORY_ORDER) {
    if (!byCat[cat]) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    lines.push('| Package | What it is | Source |');
    lines.push('|---|---|---|');
    lines.push(...byCat[cat].sort());
    lines.push('');
  }
  lines.push('## Reusable with host wiring (Papercusp tie-in kept by design)');
  lines.push('');
  lines.push('These ship a host-injection seam but deliberately retain a Papercusp');
  lines.push('tie-in (DB/schema/path assumptions). Borrowable with adaptation, not as-is.');
  lines.push('');
  lines.push('| Package | What it is | Source |');
  lines.push('|---|---|---|');
  for (const [p, fb] of SEAMED) lines.push(row(p, fb, submodules));
  lines.push('');
  const indexed = BORROWABLE.filter(([p]) => EXPORT_INDEX.has(p)).map(([p]) => p);
  if (indexed.length) {
    lines.push('## Export index');
    lines.push('');
    lines.push('What each library below exports from its root, grouped by the module that');
    lines.push('defines it, so you can find a piece or grep for a function name. Generated');
    lines.push("from each library's entry module; only libraries listed in `EXPORT_INDEX` in");
    lines.push('the generator are indexed.');
    lines.push('');
    for (const p of indexed) lines.push(...exportIndexSection(p));
  }
  return lines.join('\n') + '\n';
}

// Run as a CLI only when invoked directly — NOT merely on import. This module
// is now also imported for its exports (BORROWABLE, sourceFor, readPkg, …) by
// scripts/check-generic-independence.mjs; before this guard, importing it for
// ANY purpose unconditionally rewrote BORROWABLE.md as a side effect (WI-4973
// / decouple-generic-libs-private-deps-2026-08-03) — a landmine for any future
// importer, and a needless filesystem write on this heavily-shared tree.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const submodules = parseGitmodules();
  const out = build(submodules);
  const target = join(ROOT, 'BORROWABLE.md');
  const missingGitignores = findMissingGitignores(submodules);
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(target, 'utf8'); } catch { /* missing */ }
    let failed = false;
    if (cur !== out) {
      console.error('BORROWABLE.md is stale — run `npm run gen:borrowable` and commit.');
      failed = true;
    }
    if (missingGitignores.length) {
      console.error(
        `EI-14414: ${missingGitignores.length} borrowable submodule(s) missing a .gitignore ` +
        `(git-sync can sweep node_modules/build scratch into their history): ${missingGitignores.join(', ')}\n` +
        'Run `npm run gen:borrowable` to scaffold the standard one, then commit.',
      );
      failed = true;
    }
    if (failed) process.exit(1);
    console.log('BORROWABLE.md is up to date.');
  } else {
    writeFileSync(target, out);
    console.log(`Wrote ${target} (${BORROWABLE.length} borrowable + ${SEAMED.length} seam'd).`);
    for (const p of missingGitignores) {
      writeFileSync(join(ROOT, p, '.gitignore'), STANDARD_LIB_GITIGNORE);
      console.log(`EI-14414: scaffolded missing ${p}/.gitignore (standard borrowable-lib template).`);
    }
  }
}
