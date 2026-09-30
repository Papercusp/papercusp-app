#!/usr/bin/env node
/**
 * P-056 (retire-mug-kettle-su-only-2026-08-09) — measure the `lib/pot` substrate split.
 *
 * WHY THIS IS A SCRIPT AND NOT A GREP: P-056 says "produce the exact keep-vs-move list
 * as a committed artifact, not a recollection — this list is what P-057 executes and
 * what P-059 depends on." A recollection cannot be re-run when a peer lands new imports
 * mid-flight; this can, and it prints a self-check against the previously measured
 * external-importer count so a drifted tree announces itself instead of silently
 * changing the answer under P-057.
 *
 * THE QUESTION: every symbol exported from packages/operator-core/lib/pot is either
 *   KEEP  — imported from OUTSIDE lib/pot ⇒ live substrate the su system runs on.
 *           The cutover flag deliberately does NOT gate these (gating them would break
 *           the replacement system with the flag that retires the old one), so moving
 *           one to _retired/ breaks a live import.
 *   MOVE  — referenced only within lib/pot (or nowhere) ⇒ safe to retire with the tier.
 *
 * Resolution is done by RESOLVING each import specifier to an absolute path, not by
 * string-matching "/pot/" — a path-substring test both over-matches (…/teapot/…,
 * …/spot/…) and under-matches (a bare `from '../pot'` index import).
 *
 * Usage:  node scripts/measure-pot-substrate-split.mjs [--json <out>] [--quiet]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';

/**
 * ⚠ IMPORT/EXPORT SCANNING IS AST-BASED, NOT REGEX (EI-20087329768209149, 2026-08-10).
 *
 * This script used to parse imports with
 *     /(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
 * and it was catastrophically wrong on large files: `[\s\S]*?` spans NEWLINES, so a match
 * starting at one `import` keyword ran forward to the NEXT `from '...'` and consumed every
 * import statement in between (matches are non-overlapping, so those were never seen again).
 * MEASURED on lib/agent-tools/index.ts: 686 real import lines, 7 regex matches — and the one
 * match for '../pot/wake' captured COMMENT PROSE as its clause, so the import was dropped.
 *
 * It also dropped inline type modifiers (`import { type Foo }` → " type Foo" fails the
 * identifier test) and every bare/package specifier (`@papercusp/operator-core/lib/pot/...`).
 *
 * All three failed in the UNDER-REPORTING direction, which is the dangerous one: a missed
 * importer makes a LIVE symbol look unreferenced, so it is classified MOVE and becomes a
 * stranded call site at runtime. The regex method scored keep=52; the AST method scores
 * keep=66 with ZERO symbols going the other way. D-047 required a second method before any
 * move list was executed — that requirement is what caught this.
 *
 * The GATE detection below deliberately stays a regex: it is a per-file boolean with no
 * span-spanning clause, and its self-match protections are load-bearing and hard-won.
 */
const ts = createRequire(import.meta.url)('typescript');

const REPO = resolve(import.meta.dirname, '..');
const POT_DIR = join(REPO, 'packages/operator-core/lib/pot');
const SEARCH_ROOTS = ['packages', 'apps', 'libs', 'scripts'];
const CODE_EXT = ['.ts', '.tsx', '.mts', '.mjs'];

/**
 * Previously measured, recorded in P-056's item text. A mismatch is signal, not noise.
 *
 * RECONCILED 2026-08-10 from 60 → 57. The tree did NOT drift; the two runs used different
 * universes. P-056's 60 counted three `.papercusp/scratch/wi-chat-*.ts` files that import
 * `lib/pot/cup-wake-dossier` via a bare `@papercusp/...` specifier. Those are UNTRACKED and
 * GITIGNORED (.gitignore:129, a recursive glob over .papercusp/scratch), not shipping source, so they
 * must not hold a symbol back from retirement. 57 + those 3 = 60 exactly.
 * The gap changes ZERO keep/move verdicts: their only symbol, `computeCupWakeDossier`, is
 * KEEP regardless on an independent real importer (lib/fleet/spawn-hydration-deps.ts).
 */
const EXPECTED_EXTERNAL_IMPORTERS = 55;

/**
 * RECONCILED 2026-08-10, 57 → 59 (EI-20087329768209149). The tree did not drift and
 * nothing was added to it: the parser started SEEING two importers it had always been blind to.
 * `resolveSpecifier` used to `return null` for any specifier not starting with '.', so the two
 * apps/operator-vite consumers that reach lib/pot through the package name were dropped:
 *     LearningTab.tsx            from '@papercusp/operator-core/lib/pot/soak-report'
 *     MugWakeEfficiencyPanel.tsx from '@papercusp/operator-core/lib/pot/mug-wake-efficiency'
 * MEASURED as a set difference against the pre-fix artifact: exactly those two ADDED, zero
 * removed — so the delta is fully explained and is not a coincidence of equal counts.
 *
 * ⚠ NOTE FOR THE NEXT READER: this constant reading MATCH is weak evidence, and was actively
 * misleading once. Before the AST fix it compared a number produced by the broken regex parser
 * against a number the SAME broken parser had produced earlier — so it printed MATCH while the
 * keep bucket was under-counted by 14 symbols. Agreement between two runs of one method is not
 * corroboration. The real guard is `scripts/verify-pot-substrate-ast.mjs`, an independently
 * written implementation that exits non-zero on disagreement; run THAT before executing a move.
 *
 * RECONCILED AGAIN 2026-08-12, 59 → 55. The source tree intentionally retired six old-tier
 * importers (including pot/survey.ts) and added two live consumers while P-059 was landing;
 * the net change is four fewer files. This is a real source-tree change, not parser drift, so
 * the baseline moves with it. The current tree is 24 pot source files / 311 exports; a future
 * mismatch still means the move list must be reconciled before P-057 executes it.
 */

const args = process.argv.slice(2);
const outPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const quiet = args.includes('--quiet');

// ── walk ────────────────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    // BUILD OUTPUT IS NOT SOURCE. `dist-host` is the one that actually bit: an exact-match
    // skip on 'dist' let apps/operator/dist-host/hono-host.mjs through, and a bundle inlines
    // the whole tree — so every pot symbol appears there and a dead symbol reads as live.
    // Prefix-match dist*, and drop the gitignored scratch tree for the same reason (its
    // untracked files were what made the earlier importer count read 60 instead of 57).
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

/**
 * ── TIER IMPORTERS (D-048 / D-049) ─────────────────────────────────────────
 *
 * WHY THIS EXISTS. The original predicate — "KEEP = at least one non-test
 * importer outside lib/pot" — answers **is it safe to move**, which is NOT the
 * same question as **is it substrate** (D-047). Both readings agree on most
 * symbols, which is exactly why the gap survived: `behavioral-supervision.ts` is
 * cup-supervision code by content, yet lands in KEEP because a RETIRED tier tool
 * outside lib/pot imports it. An importer that is itself retired is not evidence
 * of live substrate — it is evidence of one dead thing referencing another.
 *
 * ⚠ D-049 is explicit that GATING and CLASSIFICATION are independent, and this
 * set is built on the CLASSIFICATION. `pot:status` is ruled TIER by D-048 yet
 * deliberately carries no gate (it is the read-only diagnostic that lets
 * P-030/P-031 verify the tier is wound down), so a set derived ONLY from "does
 * it import _mug-kettle-gate" would wrongly count it live. Hence two sources:
 *   1. DERIVED — any file importing `_mug-kettle-gate` is gated, therefore dead
 *      at runtime, therefore tier. Self-maintaining: gate a new tool and it is
 *      classified with no edit here.
 *   2. DECLARED — tier files that are deliberately ungated. Each needs a cited
 *      decision, because an unexplained entry here silently deletes substrate
 *      evidence, which is the dangerous direction.
 */
const GATE_MODULE = '_mug-kettle-gate';
/**
 * Match an actual IMPORT of the gate, never a mere mention.
 *
 * ⚠ A bare `src.includes('_mug-kettle-gate')` self-matches, and both victims are
 * instructive (measured 2026-08-10, before this regex existed):
 *   - `_mug-kettle-gate.ts` itself — it names itself in its own header comment.
 *     Misclassifying it as tier is the DANGEROUS direction: it imports
 *     `mugKettleSystemEnabled` from lib/pot, so it would have deleted that
 *     symbol's substrate evidence. (It survived only because another live
 *     importer happened to exist — luck, not design.)
 *   - THIS SCRIPT — the moment it gained the string above, the measuring
 *     instrument classified itself into the population it measures.
 * Same self-match class the repo's pgrep guidance warns about; the fix is to
 * match the syntax you mean rather than the substring.
 *
 * Two details are load-bearing, and BOTH were found by running it, not by
 * reading it:
 *   - `import\s*\(` is required. `cup/spawn.ts:163` reaches the gate through a
 *     DYNAMIC `await import('../_mug-kettle-gate')`, so a from/require-only
 *     pattern silently dropped a genuinely gated actuator out of the tier set —
 *     a false NEGATIVE, which re-inflates the substrate bucket.
 *   - `[^'"\n]` (not `[^'"]`) is required. With `.`-spanning-newlines this very
 *     comment matched itself: the prose `derived ONLY from "does\n * it import
 *     _mug-kettle-gate"` is a `from`, a quote, and the module name. A real
 *     import specifier never contains a newline, so forbidding one costs
 *     nothing and stops a sentence ABOUT the detector from tripping it.
 */
const GATE_IMPORT_RE = /(?:from|require\s*\(|import\s*\()\s*['"][^'"\n]*_mug-kettle-gate['"]/;
const GATE_MODULE_FILE = 'packages/operator-core/lib/agent-tools/_mug-kettle-gate.ts';
/** Populated during the import scan below (source 1). Repo-relative paths. */
const gatedTierImporters = new Set();
/** Source 2 — ruled tier, deliberately ungated. Cite the decision for each. */
const DECLARED_TIER_IMPORTERS = new Map([
  [
    'packages/operator-core/lib/agent-tools/pot/status.ts',
    'D-048 ruled it TIER ("the read-side companion of two gated actuators"); D-049 settled its gating as NO, so it carries no _mug-kettle-gate import to derive from.',
  ],
]);
const isTierImporter = (rel) => gatedTierImporters.has(rel) || DECLARED_TIER_IMPORTERS.has(rel);

// ── resolve an import specifier to an absolute file, extensionless-aware ────
/**
 * Workspace package name -> directory, so a BARE specifier resolves.
 *
 * This used to `return null` for anything not starting with '.', which made
 * `@papercusp/operator-core/lib/pot/soak-report` invisible. Two real importers in
 * apps/operator-vite reach lib/pot exactly that way (LearningTab.tsx,
 * MugWakeEfficiencyPanel.tsx), and their symbols were being counted as unreferenced.
 */
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
    let best = null;
    for (const name of pkgDirs.keys())
      if ((spec === name || spec.startsWith(name + '/')) && (!best || name.length > best.length))
        best = name;
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
  // Unresolvable on disk (e.g. a .js specifier for a .ts file that moved) — fall back to
  // the literal base so a pot-directory import is still counted rather than dropped.
  return base;
}

const inPot = (abs) => abs === POT_DIR || abs.startsWith(POT_DIR + '/');

// ── exported symbols of lib/pot ─────────────────────────────────────────────
/**
 * AST, for the same reason the import side is (EI-20087329768209149). The regex
 * enumeration this replaces missed `CarryJournalEntry` (wake.ts:52): inside a multi-line
 * `export { … }` an element written `type CarryJournalEntry,` splits to "type
 * CarryJournalEntry", which fails /^[A-Za-z0-9_$]+$/ on the embedded space and is dropped —
 * the identical inline-type-modifier defect the import scan had. A missing EXPORT is the
 * quieter half of the same bug: the symbol never enters the population at all, so it cannot
 * be classified either way and simply vanishes from the artifact.
 */
const potFiles = walk(POT_DIR).filter((f) => !isTest(f));
/** symbol -> Set(defining file) */
const exportsBySymbol = new Map();
for (const f of potFiles) {
  const src = readFileSync(f, 'utf8');
  const relF = relative(REPO, f);
  const add = (name) => {
    if (!name) return;
    if (!exportsBySymbol.has(name)) exportsBySymbol.set(name, new Set());
    exportsBySymbol.get(name).add(relF);
  };
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hasExportMod = (node) =>
    (ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;
  const bind = (nameNode) => {
    if (ts.isIdentifier(nameNode)) add(nameNode.text);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode))
      for (const el of nameNode.elements) if (ts.isBindingElement(el)) bind(el.name);
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
      if (node.name) add(node.name.text);
    } else if (ts.isVariableStatement(node) && hasExportMod(node)) {
      for (const d of node.declarationList.declarations) bind(d.name);
    } else if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause))
        for (const el of node.exportClause.elements) add(el.name.text);
      else if (ts.isNamespaceExport(node.exportClause)) add(node.exportClause.name.text);
    } else if (ts.isExportAssignment(node)) {
      add('default');
    }
  });
}

// ── external importers ──────────────────────────────────────────────────────
const allFiles = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));
/** symbol -> Set(importing file) */
const importersBySymbol = new Map();
const externalImporterFiles = new Set();
const externalTestImporterFiles = new Set();
/** pot module (repo-relative) -> Set(external file that dynamically imports it) */
const dynamicImportersByModule = new Map();
const externalDynamicImporterFiles = new Set();
const externalTestDynamicImporterFiles = new Set();

// (the former IMPORT_RE regex lived here — removed in favour of the AST walk below;
//  see the header note on EI-20087329768209149 for why it was unsalvageable)

/**
 * DYNAMIC imports — `await import('../pot/x')` / `require('../pot/x')`.
 *
 * These are INVISIBLE to the static clause above, and this repo uses fail-soft dynamic
 * imports deliberately (the cup-wake-dossier mem0 wiring is one). That makes them the
 * single most dangerous blind spot in a keep-vs-move list: a symbol reached ONLY
 * dynamically looks unreferenced, gets classified MOVE, and breaks at RUNTIME — inside a
 * fail-soft catch, so it degrades silently instead of throwing. A static-only census would
 * hand P-057 a list that is wrong in exactly the direction nothing detects.
 *
 * A dynamic import names a MODULE, not a symbol, so we cannot attribute it to one export.
 * We therefore flag every symbol defined in a dynamically-imported module and let P-057
 * treat those as review-required rather than free to move.
 */
const DYNAMIC_RE = /(?:\bimport|\brequire)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const f of allFiles) {
  if (inPot(f)) continue; // internal to lib/pot — not an external consumer
  const src = readFileSync(f, 'utf8');
  // Source 1 of the tier set. Detected BEFORE the 'pot' prefilter so the
  // classification never depends on an unrelated substring happening to appear.
  const relF = relative(REPO, f);
  if (!isTest(f) && relF !== GATE_MODULE_FILE && GATE_IMPORT_RE.test(src)) gatedTierImporters.add(relF);
  if (!src.includes('pot')) continue; // cheap prefilter (a pot specifier always contains 'pot')

  // ── STATIC imports/re-exports, by AST (see the header note on EI-20087329768209149) ──
  const rel = relative(REPO, f);
  let sf;
  try {
    sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    continue;
  }
  const credit = (n) => {
    if (!n) return;
    if (!importersBySymbol.has(n)) importersBySymbol.set(n, new Set());
    importersBySymbol.get(n).add(rel);
  };
  /** bindings of `import * as X from '<pot module>'` — their `X.foo` uses are credited below */
  const namespaceBindings = new Set();

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = resolveSpecifier(f, node.moduleSpecifier.text);
      if (target && inPot(target)) {
        if (isTest(f)) externalTestImporterFiles.add(rel);
        else externalImporterFiles.add(rel);

        if (ts.isImportDeclaration(node)) {
          const c = node.importClause;
          if (c?.name) credit('default');
          const b = c?.namedBindings;
          // `propertyName ?? name` keeps `{ a as b }` attributed to the EXPORTED name `a`,
          // and an inline `{ type Foo }` is just a flag on the element — never a name here.
          if (b && ts.isNamedImports(b))
            for (const el of b.elements) credit((el.propertyName ?? el.name).text);
          else if (b && ts.isNamespaceImport(b)) namespaceBindings.add(b.name.text);
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) credit((el.propertyName ?? el.name).text);
        }
        // `export * from '<pot>'` names no symbol; the file is still recorded as an importer.
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

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

  for (const m of src.matchAll(DYNAMIC_RE)) {
    const target = resolveSpecifier(f, m[1]);
    if (!target || !inPot(target)) continue;
    const rel = relative(REPO, f);
    const mod = relative(REPO, target);
    if (!dynamicImportersByModule.has(mod)) dynamicImportersByModule.set(mod, new Set());
    dynamicImportersByModule.get(mod).add(rel);
    // NOT added to externalImporterFiles: that set is the STATIC-importer baseline the
    // self-check compares against P-056's recorded figure. Folding dynamic importers into
    // it silently changes the denominator and turns the self-check into noise (observed:
    // it read 83 vs 57 and looked like tree drift when it was my own conflation).
    if (isTest(f)) externalTestDynamicImporterFiles.add(rel);
    else externalDynamicImporterFiles.add(rel);
  }
}

/**
 * PRUNE the derived tier set to files that actually import from lib/pot.
 *
 * Membership only MEANS anything for a file that contributes importer evidence:
 * a file importing the gate but nothing from lib/pot cannot change any symbol's
 * bucket, so listing it is noise in an artifact people audit by reading.
 *
 * It also ends a self-match arms race honestly. THIS script kept classifying
 * ITSELF: first because it contained the module's name, then — after the regex
 * was tightened — because the comment above documents the dynamic form and
 * therefore literally contains `import('../_mug-kettle-gate')`. Every precise
 * explanation of the detector re-tripped it. A structural rule ends that, where
 * a third regex patch would only have moved it.
 */
for (const t of [...gatedTierImporters]) {
  if (!externalImporterFiles.has(t)) gatedTierImporters.delete(t);
}

/**
 * TIER SELF-CHECK — falsifiable in BOTH directions, because the detection above
 * failed in both and each failure produced a plausible-looking number.
 *
 * This is deliberately an in-script assertion rather than a vitest guard: the
 * whole script is P-056/P-057 tooling that P-068 deletes with the gate, so a
 * permanent test harness for it would outlive its subject. An assertion that
 * runs on EVERY invocation catches a regression at the only moment anyone cares
 * — when the census is actually being re-measured.
 */
const TIER_MUST_INCLUDE = [
  'packages/operator-core/lib/agent-tools/pot/start.ts',
  'packages/operator-core/lib/agent-tools/pot/wake.ts',
  'packages/operator-core/lib/agent-tools/pot/declare_wake.ts',
  'packages/operator-core/lib/agent-tools/pot/set_steering.ts',
  'packages/operator-core/lib/agent-tools/pot/mug_efficiency.ts',
];
/** FALSE-POSITIVE sentinels: each of these was wrongly classified tier at least once. */
const TIER_MUST_EXCLUDE = [
  GATE_MODULE_FILE, // names itself in its own header; imports lib/pot, so a false hit DELETES substrate evidence
  'scripts/measure-pot-substrate-split.mjs', // the measuring instrument classifying itself
];
const tierSelfCheck = {
  missing: TIER_MUST_INCLUDE.filter((p) => !gatedTierImporters.has(p)),
  falsePositives: TIER_MUST_EXCLUDE.filter((p) => gatedTierImporters.has(p)),
  note: 'A MISSING entry re-inflates the substrate bucket (false negative). A FALSE POSITIVE deletes a symbol\'s substrate evidence and is how P-057 moves a still-live symbol — the dangerous direction.',
};
tierSelfCheck.ok = tierSelfCheck.missing.length === 0 && tierSelfCheck.falsePositives.length === 0;

// ── classify ────────────────────────────────────────────────────────────────
const keep = [];
const keepTierOnly = [];
const move = [];
const moveNeedsReview = [];
for (const [symbol, files] of [...exportsBySymbol].sort((a, b) => a[0].localeCompare(b[0]))) {
  const importers = [...(importersBySymbol.get(symbol) ?? [])].sort();
  const nonTest = importers.filter((i) => !isTest(i));
  // THE D-049 SPLIT. `live` is the substrate evidence; `tier` is not.
  const tier = nonTest.filter(isTierImporter);
  const live = nonTest.filter((i) => !isTierImporter(i));
  const definedIn = [...files].sort();
  const dynamicImporters = [...new Set(definedIn.flatMap((d) => [...(dynamicImportersByModule.get(d) ?? [])]))].sort();
  const row = { symbol, definedIn, importers, externalNonTestImporters: nonTest.length };
  if (dynamicImporters.length) row.dynamicImporters = dynamicImporters;
  if (tier.length) row.tierImporters = tier;
  if (live.length > 0) {
    // Proven live substrate: at least one importer that is NOT retired tier.
    row.liveImporters = live;
    keep.push(row);
  } else if (nonTest.length > 0) {
    // KEEP under the OLD predicate, but every importer is retired tier. These
    // are the symbols the old census could not distinguish from substrate, and
    // they are the whole point of this pass — P-057's newly-drawable boundary.
    // NOT auto-moved: `move` is a candidate list under the methodRisk below, and
    // this bucket inherits that caution.
    keepTierOnly.push(row);
  } else if (dynamicImporters.length > 0) moveNeedsReview.push(row);
  else move.push(row);
}

const artifact = {
  generatedBy: 'scripts/measure-pot-substrate-split.mjs',
  planItem: 'P-056',
  plan: 'retire-mug-kettle-su-only-2026-08-09',
  generatedAt: new Date().toISOString(),
  method:
    'Import specifiers are RESOLVED to absolute paths (extensionless + /index aware) and tested for containment in packages/operator-core/lib/pot — not string-matched on "/pot/", which both over- and under-matches. KEEP = at least one LIVE (non-test, non-retired-tier) importer outside lib/pot. ⚠ READ THIS BEFORE EXECUTING ANY BUCKET (D-047/D-049): until 2026-08-10 the predicate was "at least one NON-TEST importer", which answers IS IT SAFE TO MOVE — not IS IT SUBSTRATE. The two agree on most symbols, so the old keep bucket looked right while quietly counting retired-tier tools as substrate evidence. Importers are now split into `liveImporters` (real evidence) and `tierImporters` (a dead thing referencing another dead thing), and symbols whose ONLY non-test importers are tier land in `keepTierOnly` rather than `keep`.',
  tierImporterSet: {
    why: 'D-048 ruled the middle-band pot tools tier-vs-container; D-049 established that GATING and CLASSIFICATION are independent, so this set is built on the ruling, not on the gate.',
    derived: [...gatedTierImporters].sort(),
    derivedRule: `any non-test file importing ${GATE_MODULE} — gated, therefore dead at runtime, therefore tier. Self-maintaining.`,
    declared: Object.fromEntries([...DECLARED_TIER_IMPORTERS].sort((a, b) => a[0].localeCompare(b[0]))),
    selfCheck: tierSelfCheck,
  },
  counts: {
    potSourceFiles: potFiles.length,
    exportedSymbols: exportsBySymbol.size,
    keep: keep.length,
    keepTierOnly: keepTierOnly.length,
    move: move.length,
    moveNeedsReview: moveNeedsReview.length,
    dynamicallyImportedPotModules: dynamicImportersByModule.size,
    externalNonTestImporterFiles: externalImporterFiles.size,
    externalTestImporterFiles: externalTestImporterFiles.size,
    externalNonTestDynamicImporterFiles: externalDynamicImporterFiles.size,
    externalTestDynamicImporterFiles: externalTestDynamicImporterFiles.size,
  },
  methodRisk:
    'TYPESCRIPT AST IMPORT/EXPORT WALKER. The previous hand-rolled regex walker under-reported imports — it missed standard static imports, inline type modifiers, and bare/package specifiers — and falsely flagged live packages as orphans. Under-reporting is the DANGEROUS direction here: it inflates MOVE, and moving a still-imported symbol breaks the tree. Treat `move` as a CANDIDATE list requiring the independent AST verifier in scripts/verify-pot-substrate-ast.mjs before P-057 executes it. `keep` is the safe direction — a symbol proven to have an importer is not going to lose one by being measured badly.',
  selfCheck: {
    expectedExternalNonTestImporters: EXPECTED_EXTERNAL_IMPORTERS,
    actual: externalImporterFiles.size,
    matches: externalImporterFiles.size === EXPECTED_EXTERNAL_IMPORTERS,
    note: 'Baseline 55 (P-056 recorded 60 → 57 after excluding 3 gitignored scratch importers → 59 once bare/package specifiers resolved, EI-20087329768209149 → 55 after the P-059 retirements landed). A mismatch means the tree moved — reconcile BEFORE P-057 executes this list. A MATCH is weak evidence on its own: it compares this method against itself. Run scripts/verify-pot-substrate-ast.mjs for independent confirmation.',
  },
  keep,
  keepTierOnly,
  moveNeedsReview,
  move,
  externalNonTestImporterFiles: [...externalImporterFiles].sort(),
  dynamicallyImportedPotModules: Object.fromEntries(
    [...dynamicImportersByModule].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, [...v].sort()]),
  ),
};

if (outPath) writeFileSync(resolve(REPO, outPath), JSON.stringify(artifact, null, 2) + '\n');

if (!quiet) {
  const c = artifact.counts;
  console.log(`pot source files (non-test): ${c.potSourceFiles}`);
  console.log(`exported symbols:            ${c.exportedSymbols}`);
  console.log(`  KEEP (live substrate):     ${c.keep}`);
  console.log(`  KEEP-TIER-ONLY (D-049):    ${c.keepTierOnly}   ← imported ONLY by retired tier; not substrate`);
  console.log(`  MOVE-NEEDS-REVIEW (dyn):   ${c.moveNeedsReview}`);
  console.log(`  MOVE (retire with tier):   ${c.move}`);
  console.log(
    `tier importers: ${artifact.tierImporterSet.derived.length} derived (import ${GATE_MODULE}) + ` +
      `${Object.keys(artifact.tierImporterSet.declared).length} declared`,
  );
  if (tierSelfCheck.ok) {
    console.log('TIER SELF-CHECK: OK (all expected gated tools detected; no known false positives)');
  } else {
    console.log('TIER SELF-CHECK: ⚠ FAILED — the substrate split below is NOT trustworthy');
    if (tierSelfCheck.missing.length) console.log(`  MISSING (re-inflates substrate): ${tierSelfCheck.missing.join(', ')}`);
    if (tierSelfCheck.falsePositives.length) console.log(`  FALSE POSITIVE (deletes substrate evidence): ${tierSelfCheck.falsePositives.join(', ')}`);
  }
  console.log(`dynamically-imported pot modules: ${c.dynamicallyImportedPotModules}`);
  console.log(`external non-test importers: ${c.externalNonTestImporterFiles} static  (test: ${c.externalTestImporterFiles})`);
  console.log(`                             ${c.externalNonTestDynamicImporterFiles} dynamic (test: ${c.externalTestDynamicImporterFiles})`);
  console.log(
    `SELF-CHECK vs baseline ${EXPECTED_EXTERNAL_IMPORTERS}: ${artifact.selfCheck.matches ? 'MATCH (same-method only — run verify-pot-substrate-ast.mjs to confirm)' : `MISMATCH (got ${artifact.selfCheck.actual})`}`,
  );
  console.log('\nKEEP symbols with the most external importers:');
  for (const r of [...keep].sort((a, b) => b.externalNonTestImporters - a.externalNonTestImporters).slice(0, 15)) {
    console.log(`  ${String(r.externalNonTestImporters).padStart(3)}  ${r.symbol}  (${r.definedIn.join(', ')})`);
  }
  if (outPath) console.log(`\nartifact → ${outPath}`);
}
