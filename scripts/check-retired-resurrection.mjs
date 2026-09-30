#!/usr/bin/env node
/**
 * check-retired-resurrection.mjs — permanent retirement ratchets.
 *
 * It fails when a file exists BOTH under `_retired/` and, byte-identically, at a
 * live path (WI-37422), or when the retired cell-falsifier API returns to the cell
 * subsystem (cell-assessment-schema-and-falsifier-removal-2026-08-21 P-006).
 *
 * WHY THIS EXISTS. Retiring a surface here is a `mv` into `_retired/` plus removing
 * its import. Observed live 2026-08-09 while retiring `topics:subscribe`: the moved
 * file came BACK at its canonical path twice, byte-identical, and git-sync committed
 * the resurrection each time (`51709bff41 D` → `40eb34c3d2 A` → `2ee1fdce9f D` →
 * `f140b48983 A`).
 *
 * The failure is nasty for one specific reason: it restores FILES but not EDITS.
 * `index.ts` never regained its import in any of those commits, so the resurrected
 * file is an ORPHAN — not imported, therefore not registered, therefore the tool door
 * genuinely stays shut. Every signal an agent would normally read says something
 * different:
 *
 *   · `git status` reads clean either way — git-sync sweeps the tree every few
 *     minutes, so the window where a stray file is visibly dirty is minutes wide.
 *   · `lint:no-retired` checks IMPORTS of retired code. The import is exactly the
 *     half that was NOT restored, so it stays green.
 *   · `scan:retirement-surface` finds a live-looking source at the canonical path and
 *     reads as "the retirement was never finished" — inviting the next agent to redo
 *     completed work, or worse, to "fix" it by restoring the import and reviving a
 *     deliberately retired surface.
 *
 * So the one state that is unambiguously wrong — the same bytes present at both a
 * retired and a live path — was the one state nothing looked at.
 *
 * ── WHY BLOB IDENTITY, NOT FILENAMES ─────────────────────────────────────────
 * Matching by basename would flag every legitimately-coexisting `index.ts` /
 * `README.md`. The signature of a RESURRECTION is stronger and exact: the same
 * content at both places. We compare git's own blob SHAs from the index, so this is
 * byte-identity with zero file reads — and it cannot be fooled by a path that merely
 * looks similar.
 *
 * Zero-byte blobs are excluded: every empty file in the repo shares one SHA, so they
 * collide with each other and mean nothing. That exclusion is the whole difference
 * between a clean baseline and a permanently-red guard — measured 2026-08-09, the
 * only collision across 771 tracked `_retired/` files was the empty
 * `_retired/papercup/.next/turbopack`.
 *
 * ── SCOPE, STATED ────────────────────────────────────────────────────────────
 * Reads the SUPERPROJECT index only. `git ls-files` does not descend into submodules,
 * so a resurrection inside one is NOT covered. `_retired/` lives in the superproject,
 * which is what makes that boundary the right one today — but it is a real boundary,
 * not an absence of one, and this comment exists so nobody reads a green run as
 * "no resurrection anywhere".
 *
 * Reads the INDEX (tracked blobs), not the working tree — deliberately. A peer's
 * uncommitted edit is invisible here, so this cannot red the shared gate on someone
 * else's in-flight work; it fires only once a resurrection has actually been
 * committed, which is the point at which it is real.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const RETIRED_PREFIX = '_retired/';
const CELL_REGISTRATIONS_PATH = 'packages/operator-core/lib/cell-registrations.ts';
const CELL_REGISTRY_PATH = 'packages/operator-core/lib/cell-registry.ts';

const REMOVED_CELL_IDENTIFIERS = [
  { name: 'CellFalsifier', pattern: /\bCellFalsifier\b/g },
  { name: 'CellFalsifierRead', pattern: /\bCellFalsifierRead\b/g },
  { name: 'falsifierFrom', pattern: /\bfalsifierFrom\b/g },
  { name: 'falsifierPathExists', pattern: /\bfalsifierPathExists\b/g },
  { name: 'falsifierPath', pattern: /\bfalsifierPath\b/g },
  { name: 'falsifierLines', pattern: /\bfalsifierLines\b/g },
  { name: 'CellSpec.falsifier property', pattern: /(?:\.\s*falsifier\b|\[['"]falsifier['"]\]|\bfalsifier\s*\??\s*:)/g },
];

/** P-006's exact boundary. The ordinary word remains legal outside this subsystem. */
export function isCellSubsystemPath(file) {
  return (
    /^packages\/operator-core\/lib\/cell-[^/]+\.[cm]?[jt]sx?$/.test(file) ||
    /^packages\/operator-core\/lib\/agent-tools\/cell-[^/]+\.[cm]?[jt]sx?$/.test(file) ||
    file === 'packages/operator-core/lib/agent-facts/cells.ts' ||
    file === 'packages/operator-core/lib/coord/cell-thread.ts' ||
    /^packages\/operator-core\/lib\/events\/await\/[^/]*cell[^/]*\.[cm]?[jt]sx?$/.test(file) ||
    /^packages\/operator-core\/lib\/shared-pot-loop\/[^/]*cell[^/]*\.[cm]?[jt]sx?$/.test(file) ||
    file === 'scripts/check-cell-live-matrix.ts'
  );
}

/** Find only retired CELL-SYSTEM identifiers; unrelated falsifier vocabulary is legal. */
export function findRemovedCellIdentifiers(files) {
  const hits = [];
  for (const { path: file, source } of files) {
    if (!isCellSubsystemPath(file)) continue;
    for (const { name, pattern } of REMOVED_CELL_IDENTIFIERS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const line = source.slice(0, match.index).split('\n').length;
        hits.push({ path: file, line, identifier: name });
      }
    }
  }
  return hits;
}

function propertyName(node) {
  const name = node?.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Parse the canonical BUILTIN_CELLS array and prove every poll/value-bearing member
 * has exactly one non-null assessment declaration. This is deliberately AST-based:
 * regex-counting `assessment:` would include nested fixtures/comments and could stay
 * green after the real registry population disappeared.
 */
export function assessBuiltinCellDeclarations(source) {
  const file = ts.createSourceFile(CELL_REGISTRATIONS_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map();
  let builtinNames = null;

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (name === 'BUILTIN_CELLS') {
        if (declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) {
          builtinNames = declaration.initializer.elements.map((element) =>
            ts.isIdentifier(element) ? element.text : null,
          );
        }
        continue;
      }
      if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        declarations.set(name, declaration.initializer);
      }
    }
  }

  const violations = [];
  if (!builtinNames || builtinNames.length === 0) {
    return { builtinCount: 0, valueBearingCount: 0, violations: ['BUILTIN_CELLS is missing or empty'] };
  }

  const seen = new Set();
  let valueBearingCount = 0;
  for (const name of builtinNames) {
    if (!name) {
      violations.push('BUILTIN_CELLS contains a non-identifier entry');
      continue;
    }
    if (seen.has(name)) violations.push(`${name} appears more than once in BUILTIN_CELLS`);
    seen.add(name);

    const object = declarations.get(name);
    if (!object) {
      violations.push(`${name} is not a top-level object-literal CellSpec`);
      continue;
    }
    const assessmentProperties = object.properties.filter((property) => propertyName(property) === 'assessment');
    const changeSignalProperty = object.properties.find((property) => propertyName(property) === 'changeSignal');
    const changeSignal =
      changeSignalProperty && ts.isPropertyAssignment(changeSignalProperty) &&
      ts.isObjectLiteralExpression(changeSignalProperty.initializer)
        ? changeSignalProperty.initializer
        : null;
    const kindProperty = changeSignal?.properties.find((property) => propertyName(property) === 'kind');
    const kind =
      kindProperty && ts.isPropertyAssignment(kindProperty) && ts.isStringLiteral(kindProperty.initializer)
        ? kindProperty.initializer.text
        : null;

    if (kind !== 'poll') continue;
    valueBearingCount += 1;
    if (assessmentProperties.length !== 1) {
      violations.push(`${name} declares assessment ${assessmentProperties.length} times (expected exactly 1)`);
      continue;
    }
    const [assessment] = assessmentProperties;
    if (!ts.isPropertyAssignment(assessment) || assessment.initializer.kind === ts.SyntaxKind.NullKeyword) {
      violations.push(`${name} is poll/value-bearing but its assessment is null or not a value`);
    }
  }

  if (valueBearingCount === 0) violations.push('BUILTIN_CELLS contains no poll/value-bearing cells');
  return { builtinCount: builtinNames.length, valueBearingCount, violations };
}

function readCellSubsystem(repoRoot, entries, registryOverride) {
  const files = [];
  for (const { path: file } of entries) {
    if (!isCellSubsystemPath(file)) continue;
    const diskPath = file === CELL_REGISTRY_PATH && registryOverride
      ? path.resolve(registryOverride)
      : path.join(repoRoot, file);
    if (!existsSync(diskPath)) continue;
    files.push({ path: file, source: readFileSync(diskPath, 'utf8') });
  }
  return files;
}

/**
 * True only when this file is the process entrypoint. REALPATHED on both sides: node
 * resolves `import.meta.url` through symlinks while `process.argv[1]` keeps the path
 * as invoked, and this repo is reachable via a `papercupai-workspace/papercup ->
 * papercusp` symlink, so a naive string compare is false exactly where it matters.
 * Without this the `process.exit()` below fires on IMPORT and kills any test process
 * that pulls in the pure helpers.
 */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

/** `git ls-files -s` → [{ sha, path }]. Exported for the unit test's fixtures. */
export function parseLsFiles(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    if (meta.length < 2) continue;
    out.push({ sha: meta[1], path: line.slice(tab + 1) });
  }
  return out;
}

/**
 * The whole decision, pure. `sizes` maps blob sha → byte length; a sha missing from
 * it is treated as non-empty (fail loud rather than silently skipping a real hit).
 */
export function findResurrections(entries, sizes = new Map()) {
  const retired = new Map();
  const live = new Map();
  for (const { sha, path } of entries) {
    const bucket = path.startsWith(RETIRED_PREFIX) ? retired : live;
    if (!bucket.has(sha)) bucket.set(sha, []);
    bucket.get(sha).push(path);
  }
  const hits = [];
  for (const [sha, retiredPaths] of retired) {
    const livePaths = live.get(sha);
    if (!livePaths) continue;
    if (sizes.get(sha) === 0) continue; // every empty file shares one sha — see header
    hits.push({ sha, retiredPaths: retiredPaths.sort(), livePaths: livePaths.sort() });
  }
  return hits.sort((a, b) => a.retiredPaths[0].localeCompare(b.retiredPaths[0]));
}

function main() {
  const listOnly = process.argv.includes('--list');
  const registryOverrideAt = process.argv.indexOf('--cell-registry');
  const registryOverride = registryOverrideAt >= 0 ? process.argv[registryOverrideAt + 1] : null;
  if (registryOverrideAt >= 0 && !registryOverride) {
    console.error('[retired-resurrection] --cell-registry requires a file path.');
    return 2;
  }
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const entries = parseLsFiles(
    execFileSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 }),
  );

  const retiredCount = entries.filter((e) => e.path.startsWith(RETIRED_PREFIX)).length;

  // Size-check only the shas that actually collide — usually a handful, so this stays
  // one small batch rather than a walk over the whole index.
  const candidates = findResurrections(entries);
  const sizes = new Map();
  if (candidates.length) {
    const batch = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: repoRoot,
      input: candidates.map((c) => c.sha).join('\n') + '\n',
      encoding: 'utf8',
    });
    for (const line of batch.split('\n')) {
      const [sha, , size] = line.trim().split(/\s+/);
      if (sha && size !== undefined) sizes.set(sha, Number(size));
    }
  }
  const hits = findResurrections(entries, sizes);
  const cellFiles = readCellSubsystem(repoRoot, entries, registryOverride);
  const removedCellIdentifiers = findRemovedCellIdentifiers(cellFiles);
  const registrations = cellFiles.find((file) => file.path === CELL_REGISTRATIONS_PATH)?.source ?? '';
  const assessmentCensus = assessBuiltinCellDeclarations(registrations);

  if (listOnly) {
    console.log(
      `[retired-resurrection] scanned ${entries.length} tracked files (${retiredCount} under ${RETIRED_PREFIX}); ${hits.length} resurrection(s).`,
    );
    console.log(
      `[cell-retirement] scanned ${cellFiles.length} cell-subsystem file(s); ` +
        `${removedCellIdentifiers.length} removed identifier hit(s); ` +
        `${assessmentCensus.valueBearingCount}/${assessmentCensus.builtinCount} value-bearing built-in(s); ` +
        `${assessmentCensus.violations.length} assessment census violation(s).`,
    );
  }
  if (!hits.length && !removedCellIdentifiers.length && !assessmentCensus.violations.length) {
    if (listOnly) console.log('[retired-resurrection] clean.\n[cell-retirement] clean.');
    return 0;
  }

  if (hits.length) {
    console.error(
      `\n[retired-resurrection] ${hits.length} file(s) exist BOTH under ${RETIRED_PREFIX} and, byte-identically, at a live path.\n` +
        'A retirement has been partially undone: the file came back, but (as in WI-37422) its\n' +
        'import very likely did not, so the surface is an orphan that READS as live.\n',
    );
    for (const hit of hits) {
      console.error(`  retired: ${hit.retiredPaths.join(', ')}`);
      console.error(`  live:    ${hit.livePaths.join(', ')}`);
      console.error(`  blob:    ${hit.sha}\n`);
    }
    console.error(
      'FIX: decide which one is real. If the retirement stands, delete the live copy. If the\n' +
        'surface is being revived, move it out of _retired/ and restore its import — do not\n' +
        'leave both.\n',
    );
  }

  if (removedCellIdentifiers.length || assessmentCensus.violations.length) {
    console.error('\n[cell-retirement] the P-006 hard cutover regressed.');
    for (const hit of removedCellIdentifiers) {
      console.error(`  ${hit.path}:${hit.line}: removed cell identifier ${hit.identifier}`);
    }
    for (const violation of assessmentCensus.violations) console.error(`  ${CELL_REGISTRATIONS_PATH}: ${violation}`);
    console.error(
      'FIX: keep the cell subsystem on CellAssessmentSpec only. Every poll/value-bearing\n' +
        'BUILTIN_CELLS entry must declare exactly one non-null assessment; unrelated uses\n' +
        'of the word falsifier outside the scoped cell subsystem remain legal.\n',
    );
  }
  return 1;
}

if (isDirectRun()) process.exit(main());
