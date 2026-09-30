#!/usr/bin/env node
/**
 * check-optional-seam-strands.mjs — the optional-seam-dependency trap, mechanised
 * (EI-19318501078776560, sibling of `lint:required-field-strands` / WI-6814).
 *
 * THE ASYMMETRY this exists to close:
 * `lint:required-field-strands` catches adding a REQUIRED field to a shared interface —
 * every construction site instantly stales, LOUDLY, at tsc. This guard catches the
 * mirror image, which is strictly more dangerous because it fails SILENTLY:
 *
 *   ```ts
 *   // production
 *   const loadRevoked = deps?.loadRevoked ?? loadRevokedHivePubkeysForLocalPot;  // real → opens PG
 *   ```
 *
 * Add `loadRevoked` to the seam as OPTIONAL with a real-implementation fallback, and:
 *  - tsc says nothing — the field is optional, so every existing fixture still typechecks;
 *  - fixtures that omit it do not fail, they silently execute the REAL implementation;
 *  - if that implementation touches the network/database/filesystem, the test now asserts
 *    against live shared state while still reporting green.
 *
 * Two live instances of exactly this were found while greening the fleet gate under
 * WI-6877 (both already fixed by hand — see member-content-guard.test.ts's `loadRevoked`
 * stub and survey-workspace-scope.test.ts's `fetchEscalatedIssues` stub): in both cases a
 * SHARED fixture helper had been updated to supply the new seam member while an INLINE
 * fixture elsewhere had not, and silently fell through to a real Postgres pool. Neither
 * was caught by tests, tsc, or review — only by an unrelated rail (the forbid-real-PG
 * guard, EI-19311807188719573) that happened to catch the CONSEQUENCE rather than the
 * cause. Had the fallback been an HTTP client or a filesystem read instead of PG, nothing
 * would have caught it, and the test would still be silently exercising live state today.
 *
 * WHY THIS GUARD DOES REAL WORK (unlike its sibling): `lint:required-field-strands`
 * deliberately does NOT re-implement construction-site resolution — it just notices the
 * trigger and points at `tsc`, which already finds every stranded site perfectly. There is
 * no such oracle for the optional case (tsc is, definitionally, blind to it), so finding
 * the stranded fixture sites — the actual value described in the filing's "step 3" — has
 * to happen here. It does so with an intentionally CHEAP heuristic (object-literal shape
 * matching against sibling seam-member names), not full type-checking: this is advisory,
 * so a false positive costs a reader a glance and a false negative is no worse than today.
 *
 * WHAT COUNTS AS A "SEAM" MEMBER (kept narrow to avoid noise): an OPTIONAL member of an
 * EXPORTED interface / object-type alias whose type is a function type or a `typeof
 * <identifier>` query — the two forms every injectable test-double takes in this repo
 * (`loadRevoked?: typeof loadRevokedHivePubkeysForLocalPot`, `fetchEscalatedIssues?: (...) =>
 * Promise<...>`). A plain optional scalar (`label?: string`) is not a seam and is never
 * flagged — nobody would act on that noise.
 *
 * WHY THE MERE ADDITION IS NEVER ITSELF A FAILURE: same posture as the required-field
 * guard. Adding an optional seam member is usually correct and usually low-risk — this
 * only escalates past a silent no-op when BOTH (a) the production code demonstrably falls
 * back to a REAL (imported) implementation, not a local/inline default, AND (b) a fixture
 * that looks like an instance of the same seam shape (it supplies sibling members) omits
 * the new one.
 *
 *   node scripts/check-optional-seam-strands.mjs              # advisory: name findings
 *   node scripts/check-optional-seam-strands.mjs --base origin/main
 *   node scripts/check-optional-seam-strands.mjs --json
 *   node scripts/check-optional-seam-strands.mjs --fail        # exit 1 when strands are found
 *
 * Exit codes:
 *   0 — no optional-seam additions, no risky fallback, or (default) findings reported only
 *   1 — only with --fail, and only when a real stranded fixture site was found
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
// WI-37806: this guard inherited check-required-field-strands' "⚠ NOT CHECKED" PROSE when
// it was ported, but not its exit STATUS — so it printed "This is NOT a clean bill" and
// exited 0, which is what `&& echo PASS` and a CI step actually read.
import { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing } from './lib/not-checked.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bound on how far up an `extends` chain we will follow to collect sibling member names. */
const MAX_HERITAGE_DEPTH = 3;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function isSeamShapedType(t) {
  if (!t) return false;
  if (ts.isFunctionTypeNode(t)) return true;
  if (ts.isTypeQueryNode(t)) return true; // `typeof someImportedFn`
  return false;
}

function isExported(node) {
  return Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Members declared DIRECTLY on each exported interface / object-type alias in
 * `sourceText` — NOT following `extends` (that is `collectInterfaceMembersAcrossFiles`,
 * which needs a real file on disk to chase imports and is unit-tested separately).
 *
 * Returns Map<interfaceName, Map<memberName, { optional, seamShaped }>>.
 */
export function collectExportedInterfaceMembers(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const byInterface = new Map();

  const membersOf = (members) => {
    const out = new Map();
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (!name) continue;
      out.set(name, { optional: Boolean(m.questionToken), seamShaped: isSeamShapedType(m.type) });
    }
    return out;
  };

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      byInterface.set(stmt.name.text, membersOf(stmt.members));
    } else if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      byInterface.set(stmt.name.text, membersOf(stmt.type.members));
    }
  }
  return byInterface;
}

/**
 * Newly-added OPTIONAL seam-shaped members: present (optional + seam-shaped) in `after`,
 * absent from `before` under the same interface name. `siblings` is the OWN-FILE sibling
 * member set at this point — the caller (`main`) enriches it with cross-file `extends`
 * members via `collectInterfaceMembersAcrossFiles` before searching for stranded fixtures.
 */
export function diffOptionalSeamAdditions(beforeText, afterText, fileName = 'f.ts') {
  const before = collectExportedInterfaceMembers(beforeText, fileName);
  const after = collectExportedInterfaceMembers(afterText, fileName);
  const added = [];
  for (const [interfaceName, afterMembers] of after) {
    const beforeMembers = before.get(interfaceName);
    for (const [member, info] of afterMembers) {
      if (!info.optional || !info.seamShaped) continue;
      if (beforeMembers?.has(member)) continue; // pre-existing (or was already seam-shaped+optional)
      const siblings = [...afterMembers.keys()].filter((k) => k !== member);
      added.push({ interfaceName, member, siblings });
    }
  }
  return added;
}

/**
 * Does `sourceText` contain a `<expr>?.<member> ?? <fallback>` whose fallback identifier
 * is IMPORTED (a real module-level implementation) rather than declared locally (an inline
 * default)? Returns the fallback identifier, or null when no such risky pattern exists.
 *
 * A plain regex, not an AST walk: the two live instances this guard was built from both
 * write the fallback as `deps?.member ?? importedName` on a single statement, and a false
 * negative here only means "this addition isn't flagged" — the safe direction for an
 * advisory check to err in.
 */
export function findRealFallback(sourceText, member) {
  const re = new RegExp(`\\?\\.${member}\\b\\s*\\?\\?\\s*([A-Za-z_$][\\w$]*)`);
  const m = re.exec(sourceText);
  if (!m) return null;
  const fallback = m[1];
  const importedRe = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${fallback}\\b[^}]*\\}\\s*from`);
  return importedRe.test(sourceText) ? fallback : null;
}

/** Resolve a relative import specifier to an existing .ts/.tsx/index.ts file, or null. */
function resolveRelativeModule(fromDir, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(fromDir, specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The member names an interface exposes INCLUDING everything it (transitively) `extends`,
 * resolved from files on disk — bounded to `MAX_HERITAGE_DEPTH` and to RELATIVE imports
 * (a bare package specifier stops the walk; there is nothing local left to read). This is
 * what lets `MemberContentGuardDeps` (which declares only `loadRevoked` itself) still pick
 * up `loadMembers`/`now` from its `extends MemberDeviceSetDeps` in a different file — the
 * exact shape of the member-content-guard.ts live instance.
 */
export function collectInterfaceMembersAcrossFiles(fileAbsPath, interfaceName, depth = 0) {
  const result = new Map();
  if (depth > MAX_HERITAGE_DEPTH) return result;
  let text;
  try {
    text = readFileSync(fileAbsPath, 'utf8');
  } catch {
    return result;
  }
  const sf = ts.createSourceFile(fileAbsPath, text, ts.ScriptTarget.Latest, true);

  let decl = null;
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === interfaceName) {
      decl = stmt;
      break;
    }
  }
  if (!decl) return result;

  for (const m of decl.members) {
    if (!ts.isPropertySignature(m) || !m.name) continue;
    const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
    if (!name) continue;
    result.set(name, { optional: Boolean(m.questionToken), seamShaped: isSeamShapedType(m.type) });
  }

  for (const clause of decl.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (!ts.isIdentifier(type.expression)) continue;
      const parentName = type.expression.text;

      // Same-file parent — no import to chase.
      const sameFileParent = sf.statements.find(
        (s) => ts.isInterfaceDeclaration(s) && s.name.text === parentName,
      );
      if (sameFileParent) {
        const parentMembers = collectInterfaceMembersAcrossFiles(fileAbsPath, parentName, depth + 1);
        for (const [k, v] of parentMembers) if (!result.has(k)) result.set(k, v);
        continue;
      }

      // Cross-file parent — find its import and resolve the relative specifier.
      let modSpecifier = null;
      for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) || !s.importClause?.namedBindings) continue;
        if (!ts.isNamedImports(s.importClause.namedBindings)) continue;
        for (const el of s.importClause.namedBindings.elements) {
          if (el.name.text === parentName) {
            modSpecifier = s.moduleSpecifier.text;
            break;
          }
        }
        if (modSpecifier) break;
      }
      if (!modSpecifier) continue;
      const parentFile = resolveRelativeModule(dirname(fileAbsPath), modSpecifier);
      if (!parentFile) continue;
      const parentMembers = collectInterfaceMembersAcrossFiles(parentFile, parentName, depth + 1);
      for (const [k, v] of parentMembers) if (!result.has(k)) result.set(k, v);
    }
  }
  return result;
}

/**
 * Object-literal fixtures in `sourceText` that carry at least one of `siblingKeys` (a
 * strong signal they are meant to satisfy the seam interface's shape) but omit `member` —
 * exactly the site a REQUIRED field would have stranded loudly, that this class strands
 * silently instead. Returns 1-based line numbers, deduped.
 */
export function findStrandedObjectLiterals(sourceText, member, siblingKeys, fileName = 'f.ts') {
  if (siblingKeys.length === 0) return [];
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const hits = [];

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties
        .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null))
        .filter(Boolean);
      const hasSibling = keys.some((k) => siblingKeys.includes(k));
      const hasMember = keys.includes(member);
      if (hasSibling && !hasMember) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(hits)].sort((a, b) => a - b);
}

/** Files that plausibly import from `sourceFileRelPath` — a cheap, path-agnostic scope
 *  narrower than "every test file in the repo": we only want fixtures that could plausibly
 *  construct THIS seam's deps shape. A basename match is a heuristic, not a resolver — false
 *  positives here just widen the (already-advisory) search, never narrow it wrongly. */
function findImporters(sourceFileRelPath) {
  const base = sourceFileRelPath.replace(/\.tsx?$/, '').split('/').pop();
  if (!base) return [];
  const out = git(['grep', '-l', '-E', `from ['"].*${base}['"]`], { allowFail: true }) ?? '';
  return out.split('\n').filter(Boolean);
}

/**
 * The green path. Ported from check-required-field-strands.mjs (EI-19378316829314080),
 * which carried the byte-identical defect: a bare COUNT of "changed files examined".
 *
 * Why a count is not enough on THIS tree: the set is INFERRED from `git diff`, and the
 * working tree is shared by the whole fleet, so it is every agent's uncommitted edits.
 * git-sync commits YOUR file within minutes — dropping it out of the diff — while peers'
 * churn keeps the count non-zero. So the zero-files guard below never fires and the green
 * is a true statement about files you have never opened. That makes the guard effectively
 * unreachable in normal operation, which is precisely why it looked fine for so long.
 */
export function formatNoFindings(examinedFiles, base, { declared = false, identicalFiles = [] } = {}) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  if (files.length > 0) {
    // Naming the COUNT was not enough. A count is unfalsifiable by the one person who
    // could catch the mistake — the author, who knows which file carries their change.
    // Listing the files lets them see in one glance that theirs is not among them.
    //
    // EI-20103725040309933: `--files=` fixes ATTRIBUTION (which files) but not VACUITY
    // (whether the diff was real). "Examined" only ever meant "a before/after pair was
    // diffed", never that the two DIFFERED — so a named file that git-sync had already
    // swept produced `✓ … (1 file(s) examined)` about a file this run never compared.
    // The headline reads from the same `provedNothing` predicate as the exit status
    // below, because computing them separately is precisely how they drifted apart in
    // this guard's parent (EI-20097325488507587).
    const nothingProved = provedNothing({ examinedFiles: files, identicalFiles, declared });
    const lines = [
      nothingProved
        ? `⚠ NOT CHECKED — ${files.length} named file(s) are byte-identical to ${base}, so nothing was compared.`
        : `✓ no optional seam-dependency members added to exported types (${files.length} file(s) examined vs ${base})`,
      ...files.map((f) => `    ${f}`),
    ];
    if (!declared) {
      lines.push(
        '  ⚠ That set is INFERRED from `git diff` — on this shared tree it is EVERY agent’s',
        '    uncommitted edits, not necessarily yours. If the file carrying your change is',
        '    not listed above, this green says NOTHING about it (git-sync commits your edit',
        '    within minutes, which drops it out of this diff).',
        '    Scope it to what you actually changed:',
        '      node scripts/check-optional-seam-strands.mjs --files=<your,files>',
      );
    }
    // The per-file form of the same root cause, and it is SILENT under `declared` because
    // the inferred-set warning above deliberately does not fire there. A PARTIAL run (some
    // named files identical, others genuinely diffed) still reports a pass — it verified
    // what it could — so this block names the unverified remainder rather than voiding the
    // whole run.
    if (identicalFiles.length > 0) {
      lines.push(
        `  ⚠ NOT CHECKED — ${identicalFiles.length} of ${files.length} named file(s) are BYTE-IDENTICAL`,
        `    to ${base}, so this run proves NOTHING about them (git-sync likely already`,
        '    committed your edit — on this tree that happens within minutes):',
        ...identicalFiles.map((f) => `      ${f}`),
        '    Re-run against the commit that actually carried your change:',
        "      C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
        '      node scripts/check-optional-seam-strands.mjs --base "$C^" --files=<your,files>',
      );
    }
    return lines.join('\n');
  }
  return [
    `⚠ NOT CHECKED — nothing differs from '${base}', so ZERO files were examined.`,
    '  This is NOT a clean bill. On this shared tree it usually means git-sync',
    '  already committed your edit, not that you changed nothing.',
    '',
    '  Re-run against the commit that actually carried your change:',
    "    C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
    '    node scripts/check-optional-seam-strands.mjs --base "$C^"',
    '',
    '  (Use -G instead of -S when searching by a name you did not introduce.)',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const fail = argv.includes('--fail');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

  // `--files=a,b,c` DECLARES the set instead of inferring it. Mirrors lint:tsc, which
  // learned the same lesson: on a tree the whole fleet edits, an inferred "changed set"
  // is everyone's, so only a declared one carries trustworthy attribution.
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const declaredFiles = filesArg
    ? filesArg
        .slice('--files='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  let candidates;
  if (declaredFiles) {
    candidates = declaredFiles.map((file) => ({ status: 'M', file }));
  } else {
    const nameStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], { allowFail: true });
    if (nameStatus === null) {
      console.error(`check-optional-seam-strands: cannot diff against '${base}'`);
      // WI-37806: a base we cannot diff against means we examined nothing — the one thing
      // this must never report as a clean bill.
      process.exit(EXIT_NOT_CHECKED);
    }
    candidates = nameStatus
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status, file: rest[rest.length - 1] };
      });
  }

  const findings = [];
  // The files genuinely COMPARED — not merely listed as candidates. A candidate can be
  // skipped (added/deleted, .d.ts, no base version, gone from the tree), and counting
  // those as "examined" is the same overstatement this check exists to stop.
  const examinedFiles = [];
  // Named files that turned out byte-identical to `base` — only reachable in DECLARED mode,
  // since auto-diff mode derives its candidates FROM the diff and so cannot list one.
  const identicalFiles = [];
  for (const { status, file } of candidates) {
    if (!file || status.startsWith('A') || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;

    const beforeText = git(['show', `${base}:${file}`], { allowFail: true });
    if (beforeText === null) continue;
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');

    examinedFiles.push(file);
    if (declaredFiles && beforeText === afterText) identicalFiles.push(file);
    const additions = diffOptionalSeamAdditions(beforeText, afterText, file);
    for (const add of additions) {
      const fallback = findRealFallback(afterText, add.member);
      if (!fallback) continue; // no demonstrated real-implementation risk — silent, safe extension

      const crossFileSiblings = collectInterfaceMembersAcrossFiles(abs, add.interfaceName);
      const siblings = new Set([...add.siblings, ...crossFileSiblings.keys()]);
      siblings.delete(add.member);

      const importers = new Set([file, ...findImporters(file)]);
      const strandedSites = [];
      for (const candidate of importers) {
        if (!/\.test\.tsx?$/.test(candidate)) continue;
        const candAbs = resolve(ROOT, candidate);
        if (!existsSync(candAbs)) continue;
        const candText = readFileSync(candAbs, 'utf8');
        const lines = findStrandedObjectLiterals(candText, add.member, [...siblings], candidate);
        for (const ln of lines) strandedSites.push({ file: candidate, line: ln });
      }

      findings.push({
        file,
        interfaceName: add.interfaceName,
        member: add.member,
        fallback,
        strandedSites,
      });
    }
  }

  if (json) console.log(JSON.stringify({ base, examined: examinedFiles, identical: identicalFiles, findings }, null, 2));

  const realStrands = findings.filter((f) => f.strandedSites.length > 0);

  if (!findings.length) {
    if (!json) console.log(formatNoFindings(examinedFiles, base, { declared: Boolean(declaredFiles), identicalFiles }));
    // NOT process.exit(): under --json the report above is machine-readable output, and
    // exit() does not drain an async pipe write — a truncated report reads as FEWER
    // findings. See scripts/check-undrained-stdout-exit.mjs.
    //
    // WI-37806: 0 only when something was genuinely compared. This used to be a hardcoded
    // 0, so a run that examined ZERO files printed the "NOT CHECKED / This is NOT a clean
    // bill" text above and then reported success to every caller that reads a status.
    process.exitCode = exitForNoFindings({ examinedFiles, identicalFiles, declared: Boolean(declaredFiles) });
    return;
  }

  if (!json) {
    console.log('⚠ OPTIONAL SEAM-DEPENDENCY addition with a REAL fallback detected.');
    console.log('  tsc cannot see this — an optional field strands fixtures SILENTLY at runtime,');
    console.log('  the mirror of a required field (which strands loudly, and is already guarded).\n');
    for (const f of findings) {
      console.log(`  ${f.file} — ${f.interfaceName}.${f.member}  (falls back to real \`${f.fallback}\`)`);
      if (f.strandedSites.length === 0) {
        console.log('    (no fixture matching this seam\'s shape was found omitting it — nothing to fix yet)');
      } else {
        for (const s of f.strandedSites) console.log(`    ✗ ${s.file}:${s.line} — supplies sibling seam members but not \`${f.member}\``);
      }
    }
    console.log('\n  Adding an optional seam member is often correct — this is a prompt to verify,');
    console.log('  not a verdict. Either update every stranded fixture above to supply it, or make');
    console.log('  the member REQUIRED in the type (tsc then finds every site loudly, for good).');
  }

  if (fail && realStrands.length > 0) process.exit(1);
  process.exit(0);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
