#!/usr/bin/env node
/**
 * check-transitive-boundary.mjs — transitive client/server boundary preflight.
 *
 * Walks the import graph from apps/operator-vite (the browser SPA entry) and
 * identifies every forbidden server-only import, aggregating the full import
 * chain for each violation in a single run. Catches boundary leaks before
 * Vite's runtime externalization warnings.
 *
 * Source list of forbidden imports from:
 *   - apps/operator-vite/vite.config.ts (resolve.alias shims)
 *   - Node.js built-ins (node:*)
 *   - Known server-only packages (database, P2P, test infra, eval)
 *
 *   npm run lint:boundary-check             # Check operator-vite boundary
 *   npm run lint:boundary-check --verbose   # Print import chains
 *   npm run lint:boundary-check --update    # Update baseline (future feature)
 *
 * Exit codes:
 *   0 — OK (no forbidden imports in the client graph)
 *   1 — Forbidden imports found (prints full import chains)
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'apps/operator-vite');
const OPERATOR_DIR = resolve(ROOT, 'apps/operator');
const PACKAGES_DIR = resolve(ROOT, 'packages');

/** Modules forbidden in the client graph (defined by vite.config.ts shims and safety rules) */
const FORBIDDEN_PATTERNS = [
  // Node.js built-ins — NEVER in browser
  /^node:/,
  // Database clients and ORM — server-only
  /^postgres($|\/)/,
  /^pg($|\/)/,
  /^drizzle-orm($|\/)/,
  /^@electric-sql\/pglite($|\/)/,
  // Server-only coordination backends (event-log FS/Postgres backends)
  /^@papercusp\/coordination($|\/)/,
  // Code execution and compile-time tools
  /^typescript($|\/)/,
  /^@typescript-eslint($|\/)/,
  // Feature flags (PostHog server backend)
  /^posthog-node($|\/)/,
  // Server runtime (DBOS)
  /^@dbos-inc\/dbos-sdk($|\/)/,
  // P2P networking (server-only substrate)
  /^(corestore|hyperswarm|hyperdht|hyperbee|hypercore|hypercore-crypto|sodium-universal|sodium-native|sodium-secretstream|udx-native|dht-rpc|blind-relay)($|\/)/,
  // Test infrastructure (server-only)
  /^(ssh2|cpu-features)($|\/)/,
  // Build tools (dev-only)
  /^(tsx|vite|rollup|esbuild|webpack|vitest|jest)($|\/)/,
  // Backend-only operator-core subtrees. Client-safe leaves under the same
  // package are traversed, so a future relative re-export of one of these is
  // still caught with the complete chain that introduced it.
  /^@papercusp\/operator-core\/lib\/agent-tools(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/cross-hive-asks-pg(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/dbos(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/endpoint-route(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/harness-(?:readers|issues)(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/harness\/routines(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/memory\/knowledge-read(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/(?:operator-audit|operator-notes|plugin-loader|storage|text-artifacts|work-items)(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/sync\/hyperbee(?:\/|$)/,
  /^@papercusp\/operator-core\/lib\/sync-resolver(?:$|\/(?!list-meta$))/,
  /^@papercusp\/(?:papercusp-db|db)(?:\/|$)/,
];

/**
 * Extract the package name from an import specifier.
 * @param {string} spec - Specifier like "postgres/lib/connection.js"
 * @returns {string} Package name like "postgres"
 */
function getPackageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

/**
 * Check if a package name is forbidden in the client.
 * @param {string} specifier - Specifier or package name
 * @returns {boolean}
 */
export function isForbidden(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  const pkg = getPackageName(specifier);
  return FORBIDDEN_PATTERNS.some((p) => p.test(specifier) || p.test(pkg));
}

/**
 * Attempt to load a source file. Returns null if not found/unreadable.
 * @param {string} path - File path
 * @returns {ts.SourceFile | null}
 */
function loadSourceFile(path) {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats || !stats.isFile()) return null;
    const text = readFileSync(path, 'utf-8');
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  } catch {
    return null;
  }
}

/**
 * Try to resolve a module. Handles:
 *   - Relative paths (./foo, ../foo)
 *   - Path aliases (@/, ~/)
 *   - Bare exports (node_modules packages)
 * @param {string} spec - Specifier to resolve
 * @param {string} fromFile - Resolving file's absolute path
 * @returns {string | null} Resolved path, or null if not found
 */
export function resolveModulePath(spec, fromFile) {
  if (spec.startsWith('@/')) {
    // @/ alias → apps/operator
    const path = resolve(OPERATOR_DIR, spec.slice(2));
    return findFile(path);
  }

  if (spec.startsWith('~/')) {
    // ~/ alias → root
    const path = resolve(ROOT, spec.slice(2));
    return findFile(path);
  }

  if (spec.startsWith('.')) {
    // Relative import
    const fromDir = dirname(fromFile);
    const path = resolve(fromDir, spec);
    return findFile(path);
  }

  // Package seams are the graph boundary. Server-heavy package subpaths are
  // denied above; client-safe workspace packages retain their own leaf tests.
  // Walking arbitrary package source here would ignore Vite's browser aliases
  // and report the intentionally shimmed server graph as hundreds of false
  // positives rather than identifying the client import that crossed the seam.
  return null;
}

/**
 * Find a file by trying extensions: .ts, .tsx, .js, /index.ts, /index.tsx, /index.js
 * @param {string} base - Base path without extension
 * @returns {string | null} Resolved path or null
 */
export function findFile(base) {
  if (statSync(base, { throwIfNoEntry: false })?.isFile()) return base;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs']) {
    const withExt = base + ext;
    if (statSync(withExt, { throwIfNoEntry: false })?.isFile()) {
      return withExt;
    }
  }
  const indexBase = base + '/index';
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']) {
    const withExt = indexBase + ext;
    if (statSync(withExt, { throwIfNoEntry: false })?.isFile()) {
      return withExt;
    }
  }
  return null;
}

/**
 * Extract import/export specifiers from TypeScript AST.
 * @param {ts.SourceFile} source - Source file
 * @param {{ onUnresolved?: (site: { kind: string, line: number }) => void }} [options]
 * @returns {Array<{ spec: string, kind: string, typeOnly: boolean, line: number }>}
 */
export function extractImports(source, options = {}) {
  const specs = [];

  const add = (node, spec, kind, typeOnly = false) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    specs.push({ spec, kind, typeOnly, line: line + 1 });
  };

  function visit(node) {
    if (!node) return;

    // import ... from '...'
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node, node.moduleSpecifier.text, 'import', node.importClause?.isTypeOnly === true);
      }
    }
    // export ... from '...'
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node, node.moduleSpecifier.text, 'export', node.isTypeOnly === true);
      }
    }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = node.moduleReference.expression;
      if (spec && ts.isStringLiteral(spec)) add(node, spec.text, 'import-equals', node.isTypeOnly);
    }
    // require('...') or import('...')
    else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (!expr) return;

      const kind = ts.isIdentifier(expr) && expr.text === 'require' ? 'require'
        : expr.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : null;
      if (kind) {
        const spec = node.arguments[0];
        if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
          add(node, spec.text, kind);
        } else {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          options.onUnresolved?.({ kind, line: line + 1 });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return specs;
}

/**
 * Walk the import graph from an entry file, tracking violations.
 *
 * The `violations` value type was documented as `string[][]` (a bare list of
 * chains) but has never been that — `visit()` below pushes a RECORD carrying the
 * chain plus the importer, line and import kind, and both the CLI printer and
 * `check-transitive-boundary.test.ts` read `.chain`/`.line` off it. The wrong
 * annotation survived because this module shipped no `.d.mts`, so every importer
 * got `any` and nothing ever checked the claim (WI-6394). Generating the
 * declaration is what surfaced it.
 *
 * @param {string} entryFile - Absolute path to entry
 * @returns {{ files: Set<string>, violations: Map<string, Array<{ chain: string[], importer: string, line: number, kind: string }>> }}
 */
export function walkGraph(entryFile) {
  const visited = new Set(); // Visited file paths
  const violations = new Map(); // forbidden module -> array of import chains

  function visit(filePath, chain = []) {
    // Prevent cycles and stack overflow
    if (visited.has(filePath) || chain.length > 100) return;
    visited.add(filePath);

    const source = loadSourceFile(filePath);
    if (!source) return;

    const specs = extractImports(source);
    const currentChain = [...chain, filePath];

    for (const imported of specs) {
      if (imported.typeOnly) continue;
      const { spec } = imported;
      // Check if this direct import is forbidden
      if (isForbidden(spec)) {
        if (!violations.has(spec)) {
          violations.set(spec, []);
        }
        // Record the chain that leads to this forbidden import
        violations.get(spec).push({
          chain: currentChain,
          importer: filePath,
          line: imported.line,
          kind: imported.kind,
        });
      } else {
        // Not forbidden, recurse into it
        const resolved = resolveModulePath(spec, filePath);
        if (resolved) {
          visit(resolved, currentChain);
        }
      }
    }
  }

  visit(entryFile);
  return { files: visited, violations };
}

/**
 * Format an import chain for display (entry → ... → forbidden).
 * @param {string[]} chain - Chain of files ending at the file importing the forbidden module
 * @param {string} forbidden - The forbidden module name
 * @returns {string}
 */
export function formatChain(chain, forbidden, line) {
  const formatted = chain.map((item) => {
    const rel = relative(ROOT, item);
    return rel.startsWith('..') ? item : rel;
  });
  return [
    '        ' + formatted.join('\n        ↓\n        '),
    `        → ${forbidden}${line ? ` (line ${line})` : ''}`,
  ].join('\n');
}

/**
 * Main entrypoint
 */
export function main() {

  // Allow custom entry point (for testing)
  let entryFile = null;
  const customEntryArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

  if (customEntryArg) {
    // Custom entry point provided
    const customPath = resolve(customEntryArg);
    // Try exact path first, then with extensions
    if (statSync(customPath, { throwIfNoEntry: false })?.isFile()) {
      entryFile = customPath;
    } else {
      entryFile = findFile(customPath);
    }
  } else {
    // Default to operator-vite
    entryFile = findFile(resolve(APP_DIR, 'src/main'));
  }

  if (!entryFile) {
    const tried = customEntryArg ? resolve(customEntryArg) : resolve(APP_DIR, 'src/main');
    console.error(`❌ Entry point not found (tried ${tried}.*)`);
    process.exit(1);
  }

  console.log(`Scanning import graph from ${relative(ROOT, entryFile)}...\n`);

  const { files, violations } = walkGraph(entryFile);

  if (violations.size === 0) {
    console.log(`✓ No forbidden imports detected in the client graph.`);
    console.log(`  Scanned: ${files.size} files`);
    process.exit(0);
  }

  // Sort and format violations
  const sorted = Array.from(violations.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.error(`❌ Found ${violations.size} forbidden import(s):\n`);

  let totalChains = 0;
  for (const [module, chains] of sorted) {
    totalChains += chains.length;
    console.error(`  ⚠  ${module}`);
    for (const violation of chains) {
      console.error(`\n${formatChain(violation.chain, module, violation.line)}`);
    }
  }

  console.error(`
Total: ${totalChains} import chain(s) to forbidden module(s)

Fix options:
  1. Lazy-load: \`const x = await import('...')\` in functions that need it
  2. Type-only: \`import type { X } from '...'\` if only types are needed
  3. Add shim: Add entry to apps/operator-vite/vite.config.ts resolve.alias
  4. Re-export: Deep-import from origin instead of importing barrel

Read more: /internal/docs/agent-insights/fcp-server-libs-leak-into-eager-client-bundle
`);

  process.exit(1);
}

if (isCliEntry(import.meta.url)) {
  main();
}
