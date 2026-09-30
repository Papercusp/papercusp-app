#!/usr/bin/env node
/**
 * check-registry-census-drift.mjs — the registry-vs-census-test drift trap,
 * mechanised (EI-19401978567233485, sibling of check-migration-fixture-drift.mjs
 * / EI-19359711978838614).
 *
 * THE TRAP: a registry is an exported array of entries — `BUILTIN_CELLS`,
 * `DEFAULT_CONTENT_DETECTORS`, … — and somewhere a test asserts its EXACT
 * ordered membership:
 *
 *     expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.key)).toEqual([ 'secrets', … ]);
 *
 * Adding an entry to the registry without updating that list turns the census
 * test red. The source edit typechecks, the source's own module is fine, and
 * the author has no reason to look at a test file they did not touch — so the
 * red surfaces at the fleet green-checkpoint ~an hour later, where it holds
 * `main` for EVERY agent and costs a release-fixer dispatch plus a ~55min
 * re-run. Measured (WI-7318, candidate 2edd4735, 2026-08-03): BOTH genuine reds
 * holding main that day were this identical class —
 *   1. GATE_OWNERSHIP_CELL added to BUILTIN_CELLS      -> cell-registrations.test.ts
 *   2. nulBytesDetector added to DEFAULT_CONTENT_DETECTORS -> content-lint/registry.test.ts
 * Two independent instances in ONE candidate is the signal.
 *
 * WHY THIS IS EXACT, NOT A HEURISTIC — and why that differs from its sibling.
 *   check-migration-fixture-drift.mjs must be a narrow DIFF-triggered trigger
 *   because most fixtures are INTENTIONALLY partial: "every migrated column
 *   must appear in every fixture" would be ~100% false-positive on this tree.
 *   The census case is the opposite. An exact-ordered-list `toEqual` is a
 *   COMPLETENESS ASSERTION by construction — the test author declared that this
 *   list is the whole registry. So a registry entry absent from its census list
 *   is not evidence suggesting drift; it means THAT TEST IS ALREADY RED. This
 *   check therefore needs no diff and carries no false-positive budget: it
 *   reports only what `vitest` would report, minutes earlier and to the person
 *   who caused it.
 *
 *   (The EDIT-TIME hook still diffs before/after — not for precision, but so a
 *   repeated edit to an already-drifted file does not re-nudge for a gap the
 *   author has already been told about.)
 *
 * SCOPE — deliberately only the exact-list form. A census asserting
 * `toHaveLength(11)`, `toContain('x')`, or a sorted/derived projection is NOT
 * matched: those are not completeness assertions over a known key set, so a
 * mismatch there would be a guess. Silence on them is correct, not a gap.
 *
 * Advisory by default (never blocks); --check exits 1 on any drift found.
 * No DB and no test run required — the registry literal and the asserted list
 * are both in tracked source, and their disagreement IS the failure.
 *
 * Usage:
 *   node scripts/check-registry-census-drift.mjs <source.ts> [...]
 *   node scripts/check-registry-census-drift.mjs --check <source.ts>
 *   node scripts/check-registry-census-drift.mjs --json <source.ts>
 *
 * Exit codes:
 *   0 — no registries found / no census asserts them / no drift, or advisory mode
 *   1 — --check found a registry whose census list disagrees with its entries
 *   2 — --check could not enumerate census tests, so the result is not measured
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Source parsing (pure; exported for the test)
// ---------------------------------------------------------------------------

/**
 * Index of the delimiter closing the one opened at `openIdx`, skipping string
 * literals so a bracket inside a quoted value cannot unbalance the scan.
 * Returns -1 when unbalanced (a truncated/being-edited file — callers skip).
 */
export function matchBracket(src, openIdx) {
  const open = src[openIdx];
  const close = open === '[' ? ']' : open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an array/object body on DEPTH-0 commas, ignoring commas inside nested literals. */
export function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < body.length) {
        if (body[i] === '\\') {
          i += 2;
          continue;
        }
        if (body[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The body of the array literal assigned to `identifier`, or null.
 * Matches `const X = [`, `export const X = [`, and an optional type annotation.
 */
export function findArrayLiteralBody(source, identifier) {
  const re = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escapeRe(identifier)}\\s*(?::[^=]*?)?=\\s*\\[`,
    'm',
  );
  const m = re.exec(source);
  if (!m) return null;
  const openIdx = source.indexOf('[', m.index + m[0].length - 1);
  if (openIdx < 0) return null;
  const closeIdx = matchBracket(source, openIdx);
  if (closeIdx < 0) return null;
  return source.slice(openIdx + 1, closeIdx);
}

/**
 * For each top-level entry of an array body, the string value of property
 * `accessor` (`key: 'secrets'`). Entries lacking it (a spread, a computed
 * value, an identifier reference) yield null — a registry containing ANY of
 * those is not statically enumerable, and callers must bail rather than
 * report a false gap.
 */
export function entryPropertyValues(arrayBody, accessor) {
  const propRe = new RegExp(`(?:^|[{,\\s])${escapeRe(accessor)}\\s*:\\s*(['"\`])([^'"\`]*)\\1`);
  return splitTopLevel(arrayBody).map((entry) => {
    const m = propRe.exec(entry);
    return m ? m[2] : null;
  });
}

/**
 * Exact-list census assertions in a test source:
 *   expect(IDENT.map((d) => d.key)).toEqual([ 'a', 'b' ])
 * Returns [{ identifier, accessor, expected }]. Only this shape — see SCOPE.
 */
export function findCensusAssertions(testSource) {
  const src = stripCommentsOnly(testSource, 'census.test.ts');
  const out = [];
  const re = /expect\(\s*([A-Za-z_$][\w$]*)\s*\.map\(/g;
  let m;
  while ((m = re.exec(src))) {
    const identifier = m[1];
    const mapOpen = src.indexOf('(', m.index + m[0].length - 1);
    const mapClose = matchBracket(src, mapOpen);
    if (mapClose < 0) continue;
    // The projected property: `(d) => d.key` / `d => d.cell` / `(x) => x.id`.
    const arrow = /=>\s*[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(
      src.slice(mapOpen + 1, mapClose).trim(),
    );
    if (!arrow) continue;
    // `.toEqual([` must follow the expect(...) call directly. Slice from AFTER the
    // map's own closing paren: at mapClose the text is `)).toEqual(` — two closers,
    // the map's then expect's — so anchoring at mapClose never matches.
    const after = src.slice(mapClose + 1, mapClose + 200);
    const eq = /^\s*\)\s*\.toEqual\(\s*\[/.exec(after);
    if (!eq) continue;
    const arrOpen = src.indexOf('[', mapClose);
    const arrClose = matchBracket(src, arrOpen);
    if (arrClose < 0) continue;
    const expected = splitTopLevel(src.slice(arrOpen + 1, arrClose)).map((el) => {
      const lit = /^(['"`])([^'"`]*)\1$/.exec(el.trim());
      return lit ? lit[2] : null;
    });
    if (expected.some((e) => e === null)) continue; // not a plain string census
    out.push({ identifier, accessor: arrow[1], expected });
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Tracked `*.test.ts` files that literally mention `identifier` (cheap, via git grep).
 * Returns the paths, or `{ kind: 'unavailable', ... }` when git could not enumerate them.
 */
export function testFilesMentioning(identifier, deps = {}) {
  const { root = ROOT, grep = defaultGitGrep } = deps;
  return grep(root, identifier);
}

/**
 * A git search can fail without being a negative result. Keep that distinction
 * explicit so callers cannot mistake "not a git repo" / spawn failures for a
 * successful no-match search.
 */
function unavailableGitSearch(error) {
  const result = { kind: 'unavailable' };
  if (Number.isInteger(error?.status)) result.status = error.status;
  if (typeof error?.code === 'string') result.code = error.code;
  return result;
}

/**
 * Run the tracked-test census lookup. `git grep` uses exit 1 for a successful
 * no-match search; every other thrown result means the lookup was unavailable.
 *
 * The optional runner is a focused test seam for the status/error distinction.
 */
export function defaultGitGrep(root, identifier, run = execFileSync) {
  try {
    const out = run(
      'git',
      ['grep', '-l', '--fixed-strings', identifier, '--', '*.test.ts', '*.test.tsx'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return []; // successful no-match
    return unavailableGitSearch(error);
  }
}

/**
 * Drift for ONE source file: every registry it declares that some test asserts
 * an exact census over, whose census list disagrees with the registry's entries.
 */
export function findCensusDrift(sourceText, deps = {}) {
  const { root = ROOT, readFile = defaultReadFile, testFiles = null } = deps;
  const src = stripCommentsOnly(sourceText, 'source.ts');
  const findings = [];
  // ANTI-VACUITY (the failure this guard would otherwise share with the class it
  // polices): an empty `findings` is ambiguous between "every census matches" and
  // "no census was ever compared" — a guard pointed at nothing reports exactly the
  // same green as a guard that passed. Counting the comparisons makes a green
  // falsifiable: `censusesCompared: 0` is NOT a pass, it is "did not measure".
  let registriesFound = 0;
  let censusesCompared = 0;
  let unavailable = null;

  // Identifiers this file declares as array literals — the only ones it can drift.
  const declared = [...src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]*?)?=\s*\[/g)].map(
    (m) => m[1],
  );

  for (const identifier of [...new Set(declared)]) {
    const body = findArrayLiteralBody(src, identifier);
    if (body === null) continue;
    registriesFound++;

    const candidates = testFiles ?? testFilesMentioning(identifier, { root });
    if (candidates?.kind === 'unavailable') {
      unavailable ??= candidates;
      continue;
    }
    for (const relPath of candidates) {
      const text = readFile(root, relPath);
      if (text === null) continue;
      for (const census of findCensusAssertions(text)) {
        if (census.identifier !== identifier) continue;
        const entries = splitTopLevel(body);
        // A spread makes the LENGTH itself non-static, so nothing below is sound.
        if (entries.some((e) => e.startsWith('...'))) continue;
        censusesCompared++;

        // ARITY IS THE EXACT SIGNAL, and it needs no knowledge of entry shape.
        // Both real registries here hold identifier REFERENCES (`secretsDetector`,
        // `GATE_OWNERSHIP_CELL`), whose `key` lives in another declaration — often
        // another module. Resolving those would be a module-resolution project and
        // would still fail on re-exports. It is also unnecessary: an exact-ordered
        // `toEqual` of N strings against an array of M entries CANNOT pass when
        // M !== N. So arity alone is a zero-false-positive proof of a red test, and
        // it is precisely the incident shape (an entry appended, census not updated).
        const actual = entryPropertyValues(body, census.accessor);
        const enumerable = actual.every((v) => v !== null);
        if (entries.length !== census.expected.length) {
          findings.push({
            identifier,
            accessor: census.accessor,
            testFile: relPath,
            registryCount: entries.length,
            censusCount: census.expected.length,
            // Names only when the entries are inline literals; otherwise the arity
            // mismatch stands on its own rather than guessing at names.
            missing: enumerable ? actual.filter((k) => !census.expected.includes(k)) : [],
            stale: enumerable ? census.expected.filter((k) => !actual.includes(k)) : [],
          });
        } else if (enumerable) {
          // Same arity: only an inline-literal registry can prove a rename/reorder.
          const missing = actual.filter((k) => !census.expected.includes(k));
          const stale = census.expected.filter((k) => !actual.includes(k));
          if (missing.length || stale.length) {
            findings.push({
              identifier,
              accessor: census.accessor,
              testFile: relPath,
              registryCount: entries.length,
              censusCount: census.expected.length,
              missing,
              stale,
            });
          }
        }
      }
    }
  }
  return { findings, registriesFound, censusesCompared, ...(unavailable ? { unavailable } : {}) };
}

function defaultReadFile(root, relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatReport(sourceFile, result) {
  const { findings, registriesFound = 0, censusesCompared = 0, unavailable = null } = result;
  const unavailableDetail = unavailable?.status
    ? `git grep exited with status ${unavailable.status}`
    : unavailable?.code
      ? `git grep could not start (${unavailable.code})`
      : 'git grep was unavailable';
  if (!findings.length) {
    // Never render a bare "✓ no drift" — see the ANTI-VACUITY note in findCensusDrift.
    // A reader must be able to tell a real pass from a check that compared nothing.
    return unavailable
      ? `· ${sourceFile}: NOT MEASURED — ${registriesFound} registr${
          registriesFound === 1 ? 'y' : 'ies'
        } found, census test lookup unavailable (${unavailableDetail})`
      : censusesCompared === 0
      ? `· ${sourceFile}: NOT MEASURED — ${registriesFound} registr${registriesFound === 1 ? 'y' : 'ies'} found, 0 exact-list censuses to compare against`
      : `✓ ${sourceFile}: ${censusesCompared} census comparison(s) checked, no drift`;
  }
  const lines = [`⚠ ${sourceFile} — registry membership disagrees with an exact-list census test:`];
  for (const f of findings) {
    lines.push(`  • ${f.identifier}.map(x => x.${f.accessor})  vs  ${f.testFile}`);
    if (f.registryCount !== f.censusCount) {
      lines.push(`      registry has ${f.registryCount} entr${f.registryCount === 1 ? 'y' : 'ies'}; census lists ${f.censusCount}`);
    }
    for (const k of f.missing) lines.push(`      in the registry, MISSING from the census list: '${k}'`);
    for (const k of f.stale) lines.push(`      in the census list, GONE from the registry: '${k}'`);
  }
  lines.push(
    '',
    '  That census asserts EXACT membership, so this is not a warning about a possible',
    '  problem — the listed test is red right now. Update the list in the same change',
    '  (EI-19401978567233485): otherwise it reds the fleet green-checkpoint ~an hour',
    '  later, where it holds main for every agent and costs a ~55min re-run.',
  );
  if (unavailable) lines.push('', `  Census test lookup was NOT MEASURED — ${unavailableDetail}.`);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const files = argv.filter((a) => !a.startsWith('--'));

  if (!files.length) {
    if (!json) console.log('check-registry-census-drift: no source files given — nothing to check');
    process.exitCode = 0;
    return;
  }

  const results = [];
  let anyFindings = false;
  let anyUnavailable = false;
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs)) continue;
    const relPath = relative(ROOT, abs).split(sep).join('/');
    const result = findCensusDrift(readFileSync(abs, 'utf8'));
    if (result.findings.length) anyFindings = true;
    if (result.unavailable) anyUnavailable = true;
    results.push({ file: relPath, ...result });
    if (!json) console.log(formatReport(relPath, result));
  }

  if (json) console.log(JSON.stringify({ results }, null, 2));
  // Set the status and let the program end naturally: process.exit() here would
  // truncate the unbounded --json dump above when stdout is a pipe
  // (lint:no-undrained-stdout-exit).
  process.exitCode = check ? (anyFindings ? 1 : anyUnavailable ? 2 : 0) : 0;
}

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. Once inlined into
 * a bundle every module inherits the bundle entry's `import.meta.url`, so the
 * familiar comparison runs every imported CLI's main() during host boot
 * (the class isCliEntry(import.meta.url) exists to close for TS CLIs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-registry-census-drift\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) main();
