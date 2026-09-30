#!/usr/bin/env node
/**
 * P-057 (retire-mug-kettle-su-only-2026-08-09) — SECOND METHOD for the lib/pot substrate split.
 *
 * WHY THIS EXISTS. D-047 records a standing requirement for an independent verification method
 * before any move list is executed. `scripts/measure-pot-substrate-split.mjs` now uses a
 * TypeScript AST walker; this script answers the SAME question with a separately implemented AST
 * parse so that a disagreement localises a defect instead of confirming a shared blind spot.
 * The older primary implementation was a regex walker, and its historical failure modes remain
 * documented below because they explain the cases this independent check must continue to cover.
 *
 * DEFINITIONS ARE DELIBERATELY IDENTICAL; ONLY THE METHOD DIFFERS. The tier-importer set
 * (D-048/D-049), the isTest predicate, the walk universe and the KEEP predicate
 *     KEEP = ∃ importer ∉ lib/pot, ¬isTest(importer), ¬isRetiredTier(importer)
 * are reproduced exactly. A second method that also changed a definition would produce
 * disagreements nobody could interpret.
 *
 * THE THREE BLIND SPOTS IT IS AIMED AT — all in the UNDER-REPORTING direction, which is the
 * dangerous one (an under-reported importer is a live call site that gets classified MOVE and
 * breaks at runtime):
 *
 *   1. NAMESPACE IMPORTS. The retired regex implementation took the non-braced import clause
 *      and tested it against /^[A-Za-z0-9_$]+$/. For `import * as pot from '../pot/wake'` the
 *      clause is `* as pot`, whose first segment is `*` — it was dropped, so EVERY symbol reached
 *      as `pot.resolvePotHomeSlug()` contributed zero symbol evidence. Here: the namespace
 *      binding is resolved and every `binding.PROP` access in the file is credited to PROP.
 *
 *   2. BARE / PACKAGE SPECIFIERS. The retired regex implementation returned null for any
 *      specifier not starting with '.', so `@papercusp/operator-core/lib/pot/x` was invisible.
 *      The original sample was in gitignored scratch (and was correctly excluded), but nothing
 *      checked whether a TRACKED file did the same. Here: workspace package names are resolved
 *      to directories and bare specifiers land.
 *
 *   3. RE-EXPORT CHAINS. `export * from '../pot/x'` and `export { a } from '../pot/x'` in a
 *      barrel re-publish pot symbols to consumers that never name lib/pot. The regex clause
 *      for `export *` is again `*` and is dropped by the same identifier test.
 *      Here: both forms are walked, and `export *` is reported explicitly because it
 *      re-publishes the WHOLE module.
 *
 * Usage:  node scripts/verify-pot-substrate-ast.mjs [--census <path>] [--json <out>]
 *   --census defaults to docs/pot-substrate-split-census.json (P-056's committed artifact).
 * Exit code is 0 on agreement, 1 when the two methods disagree — so it can gate the move.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO = resolve(import.meta.dirname, '..');
const POT_DIR = join(REPO, 'packages/operator-core/lib/pot');
const SEARCH_ROOTS = ['packages', 'apps', 'libs', 'scripts'];
const CODE_EXT = ['.ts', '.tsx', '.mts', '.mjs'];

const args = process.argv.slice(2);
const censusPath = args.includes('--census')
  ? resolve(args[args.indexOf('--census') + 1])
  : join(REPO, 'docs/pot-substrate-split-census.json');
const outPath = args.includes('--json') ? resolve(args[args.indexOf('--json') + 1]) : null;

// ── walk — identical universe to the primary census ─────────────────────────
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (
      e.name === 'node_modules' ||
      e.name === '.git' ||
      e.name.startsWith('dist') ||
      e.name === 'build' ||
      e.name === '.papercusp'
    )
      continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (CODE_EXT.some((x) => e.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

const isTest = (f) => /\.(test|spec)\.[cm]?tsx?$/.test(f) || f.includes('/__tests__/');
const inPot = (abs) => abs === POT_DIR || abs.startsWith(POT_DIR + '/');

// ── workspace package name -> directory (closes blind spot 2) ───────────────
const pkgDirs = new Map();
for (const root of ['packages', 'libs', 'apps']) {
  const stack = [join(REPO, root)];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('dist') || e.name === '.git') continue;
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (e.name === 'package.json') {
        try {
          const name = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name;
          if (name && !pkgDirs.has(name)) pkgDirs.set(name, d);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec);
  } else {
    // bare specifier: longest matching workspace package name
    let best = null;
    for (const name of pkgDirs.keys()) {
      if ((spec === name || spec.startsWith(name + '/')) && (!best || name.length > best.length))
        best = name;
    }
    if (!best) return null;
    const rest = spec.slice(best.length).replace(/^\//, '');
    base = rest ? join(pkgDirs.get(best), rest) : pkgDirs.get(best);
  }
  const candidates = [
    base,
    ...CODE_EXT.map((x) => base + x),
    ...['.js', '.mjs'].map((x) => base.replace(/\.[cm]?js$/, '') + x),
    ...CODE_EXT.map((x) => join(base, 'index' + x)),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return spec.startsWith('.') ? base : null;
}

const parse = (file, src) =>
  ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);

const hasExportMod = (node) =>
  (ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers)?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;

// ── exported symbols of lib/pot, by AST ─────────────────────────────────────
const potFiles = walk(POT_DIR).filter((f) => !isTest(f));
/** symbol -> Set(defining file, repo-relative) */
const exportsBySymbol = new Map();
const addExport = (name, file) => {
  if (!name) return;
  if (!exportsBySymbol.has(name)) exportsBySymbol.set(name, new Set());
  exportsBySymbol.get(name).add(relative(REPO, file));
};

for (const f of potFiles) {
  const sf = parse(f, readFileSync(f, 'utf8'));
  const collectBinding = (nameNode) => {
    if (ts.isIdentifier(nameNode)) addExport(nameNode.text, f);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode))
      for (const el of nameNode.elements)
        if (ts.isBindingElement(el)) collectBinding(el.name);
  };
  sf.forEachChild((node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      hasExportMod(node)
    ) {
      if (node.name) addExport(node.name.text, f);
    } else if (ts.isVariableStatement(node) && hasExportMod(node)) {
      for (const d of node.declarationList.declarations) collectBinding(d.name);
    } else if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause))
        for (const el of node.exportClause.elements) addExport(el.name.text, f);
      else if (ts.isNamespaceExport(node.exportClause)) addExport(node.exportClause.name.text, f);
    } else if (ts.isExportAssignment(node)) {
      addExport('default', f);
    }
  });
}

// ── tier importers (D-048/D-049) — same two sources, detected by AST ────────
const GATE_MODULE_FILE = 'packages/operator-core/lib/agent-tools/_mug-kettle-gate.ts';
const DECLARED_TIER_IMPORTERS = new Map([
  [
    'packages/operator-core/lib/agent-tools/pot/status.ts',
    'D-048 ruled it TIER; D-049 settled its gating as NO.',
  ],
]);
const gatedTierImporters = new Set();

// ── external importers, by AST ──────────────────────────────────────────────
const allFiles = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));
/** symbol -> Set(importing file) */
const importersBySymbol = new Map();
const externalImporterFiles = new Set();
/** evidence of the specific blind spots, for the report */
const namespaceEvidence = [];
const bareSpecifierEvidence = [];
const reExportStarEvidence = [];

for (const f of allFiles) {
  if (inPot(f)) continue;
  const src = readFileSync(f, 'utf8');
  const relF = relative(REPO, f);
  let sf;
  try {
    sf = parse(f, src);
  } catch {
    continue;
  }

  // tier source 1 — an actual IMPORT of the gate module, by AST (never a mention)
  if (!isTest(f) && relF !== GATE_MODULE_FILE) {
    let gated = false;
    const visitGate = (node) => {
      let spec = null;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        spec = node.moduleSpecifier;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length &&
        ts.isStringLiteral(node.arguments[0])
      )
        spec = node.arguments[0];
      if (spec && ts.isStringLiteral(spec) && spec.text.includes('_mug-kettle-gate')) gated = true;
      ts.forEachChild(node, visitGate);
    };
    visitGate(sf);
    if (gated) gatedTierImporters.add(relF);
  }

  const credit = (name) => {
    if (!name) return;
    if (!importersBySymbol.has(name)) importersBySymbol.set(name, new Set());
    importersBySymbol.get(name).add(relF);
  };

  /** namespace binding -> true, for pot modules imported as `* as X` */
  const namespaceBindings = new Set();
  let touchesPot = false;

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const target = resolveSpecifier(f, spec);
      if (target && inPot(target)) {
        touchesPot = true;
        externalImporterFiles.add(relF);
        if (!spec.startsWith('.')) bareSpecifierEvidence.push({ file: relF, spec });

        if (ts.isImportDeclaration(node)) {
          const c = node.importClause;
          if (c?.name) credit('default');
          const b = c?.namedBindings;
          if (b && ts.isNamedImports(b))
            for (const el of b.elements) credit((el.propertyName ?? el.name).text);
          else if (b && ts.isNamespaceImport(b)) {
            namespaceBindings.add(b.name.text);
            namespaceEvidence.push({ file: relF, spec, binding: b.name.text });
          }
        } else {
          // export ... from '<pot>'
          if (!node.exportClause) reExportStarEvidence.push({ file: relF, spec });
          else if (ts.isNamedExports(node.exportClause))
            for (const el of node.exportClause.elements) credit((el.propertyName ?? el.name).text);
          else if (ts.isNamespaceExport(node.exportClause))
            reExportStarEvidence.push({ file: relF, spec, as: node.exportClause.name.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // blind spot 1 — credit `binding.PROP` for every namespace-imported pot module
  if (namespaceBindings.size) {
    const visitUse = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaceBindings.has(node.expression.text)
      )
        credit(node.name.text);
      ts.forEachChild(node, visitUse);
    };
    visitUse(sf);
  }
  void touchesPot;
}

for (const t of [...gatedTierImporters]) if (!externalImporterFiles.has(t)) gatedTierImporters.delete(t);
const isTierImporter = (rel) => gatedTierImporters.has(rel) || DECLARED_TIER_IMPORTERS.has(rel);

// ── classify with the IDENTICAL predicate ───────────────────────────────────
const astKeep = new Map(); // symbol -> live importers
for (const [symbol, defs] of exportsBySymbol) {
  const importers = [...(importersBySymbol.get(symbol) ?? [])];
  const live = importers.filter((i) => !isTest(join(REPO, i)) && !isTierImporter(i));
  if (live.length) astKeep.set(symbol, { definedIn: [...defs], live });
}

// ── diff against the primary census ────────────────────────────────────────
let census = null;
try {
  census = JSON.parse(readFileSync(censusPath, 'utf8'));
} catch (e) {
  console.error(`✖ could not read census at ${censusPath}: ${e.message}`);
  process.exit(2);
}
const censusKeep = new Set((census.keep ?? []).map((r) => r.symbol));
const astKeepSet = new Set(astKeep.keys());

const onlyAst = [...astKeepSet].filter((s) => !censusKeep.has(s)).sort();
const onlyCensus = [...censusKeep].filter((s) => !astKeepSet.has(s)).sort();

console.log('INDEPENDENT METHOD (TypeScript AST) vs primary census');
console.log('='.repeat(72));
console.log(`census keep:      ${censusKeep.size}`);
console.log(`AST keep:         ${astKeepSet.size}`);
console.log(`pot exports seen: AST ${exportsBySymbol.size}  /  census ${census.counts?.exportedSymbols ?? '?'}`);
console.log(`tier importers:   AST ${gatedTierImporters.size} derived + ${DECLARED_TIER_IMPORTERS.size} declared`);
console.log('');
console.log(`⚠ KEEP only in AST (census UNDER-reported → would have been wrongly moved): ${onlyAst.length}`);
for (const s of onlyAst) {
  const r = astKeep.get(s);
  console.log(`   + ${s}  [${r.definedIn.join(', ')}]`);
  for (const i of r.live.slice(0, 6)) console.log(`       ← ${i}`);
}
console.log('');
console.log(`  KEEP only in census (AST saw no live importer): ${onlyCensus.length}`);
for (const s of onlyCensus) console.log(`   - ${s}`);

console.log('');
console.log('BLIND-SPOT EVIDENCE (historical regex method could not credit)');
console.log(`  namespace imports of pot modules: ${namespaceEvidence.length}`);
for (const e of namespaceEvidence.slice(0, 12)) console.log(`     ${e.file}  import * as ${e.binding} from '${e.spec}'`);
console.log(`  bare-specifier pot imports:       ${bareSpecifierEvidence.length}`);
for (const e of bareSpecifierEvidence.slice(0, 12)) console.log(`     ${e.file}  from '${e.spec}'`);
console.log(`  export-* re-exports of pot:       ${reExportStarEvidence.length}`);
for (const e of reExportStarEvidence.slice(0, 12)) console.log(`     ${e.file}  export * from '${e.spec}'`);

const agree = onlyAst.length === 0 && onlyCensus.length === 0;
console.log('');
console.log(agree ? '✅ METHODS AGREE — the keep set is confirmed by two independent methods.' : '❌ METHODS DISAGREE — do not execute the move list until reconciled (D-047).');

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedBy: 'scripts/verify-pot-substrate-ast.mjs',
        generatedAt: new Date().toISOString(),
        method: 'TypeScript AST (createSourceFile), namespace + bare-specifier + re-export aware',
        comparedAgainst: relative(REPO, censusPath),
        counts: {
          censusKeep: censusKeep.size,
          astKeep: astKeepSet.size,
          onlyAst: onlyAst.length,
          onlyCensus: onlyCensus.length,
        },
        onlyAst: onlyAst.map((s) => ({ symbol: s, ...astKeep.get(s) })),
        onlyCensus,
        blindSpotEvidence: { namespaceEvidence, bareSpecifierEvidence, reExportStarEvidence },
        astKeep: [...astKeep].map(([symbol, r]) => ({ symbol, ...r })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${relative(REPO, outPath)}`);
}

process.exit(agree ? 0 : 1);
