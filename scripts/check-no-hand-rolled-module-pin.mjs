#!/usr/bin/env node
/**
 * lint:no-hand-rolled-module-pin — every module that pins its state to the realm
 * must do it THROUGH `@papercusp/module-singleton`, not by hand.
 *
 * ## What it detects
 *
 * The shape `globalThis[<key>] = state` — a module storing its mutable state on
 * the realm so a duplicated module record cannot split it in half. That is a
 * CORRECT fix for the split; the problem is that it is an INVISIBLE one.
 *
 * ⚠ BOTH key forms count, and missing the second one cost this guard its own
 * credibility once. The original detector matched `Symbol.for('...')` ONLY, so
 * it reported 14 remaining sites while ~20 more pinned with a plain STRING key
 * (`const K = '__papercuspPulseCache'; (globalThis as G)[K]`) and were invisible
 * to it — including THREE in `harness-core.ts` sitting beside a fourth it did
 * flag. That is the same defect this guard exists to catch, one level up: a
 * proxy measurement's negative covers only the conditions it reproduced, so a
 * detector written to look for one form answers a confident "that's all of
 * them" about a population it never scanned (EI-19479108855357092). Measure the
 * population with `--list`, and keep `--list` honest by matching on the PIN
 * (the globalThis index), never on the key's spelling.
 *
 * `listModuleDuplications()` only knows about keys pinned through
 * `pinModuleState()`. A hand-rolled pin is therefore absent from the realm-wide
 * report, which then answers a confident, clean `[]` while the module is
 * duplicated. That is the exact failure shape of the outage that motivated the
 * primitive (EI-19451658870832332): a surface reporting health because its
 * subject is invisible to it, not because the subject is healthy. An empty
 * report is evidence only when there is exactly one report and it can see
 * everything.
 *
 * So this guard exists to keep the report complete BY CONSTRUCTION rather than
 * by memory — the same reason `pinModuleState` counts evaluations instead of
 * only sharing state.
 *
 * ## What it deliberately does NOT flag
 *
 *  - Reading a THIRD-PARTY well-known symbol (`Symbol.for('drizzle:Name')`) —
 *    that is not pinning anything.
 *  - Tagging a non-`globalThis` shared object (`console[Symbol.for(...)]` in
 *    log-events.ts) — a different pattern with a different fix.
 *  - Test files, which may legitimately probe the realm store.
 *  - `libs/generic/module-singleton` itself, which IS the mechanism.
 *
 * ## The allowlist
 *
 * ALLOW is the measured population that predates this guard, and it is
 * SHRINK-ONLY: migrating a site removes its entry. Do not add to it — a new
 * hand-rolled pin re-opens the hole this guard closes. Migration is tracked on
 * EI-19469900474673886.
 *
 * Exit 0 clean / 1 on a new violation.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['libs', 'packages', 'apps'];

/** Directories never worth walking. */
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'dist-sidecar', 'build', '.next', 'target',
  '_retired', 'coverage', '.git', 'out',
]);

/**
 * Known hand-rolled pins that predate this guard. SHRINK-ONLY — see the header.
 * Each entry is a repo-relative path; a file may hold more than one pin.
 *
 * ⚠ This list GREW once, from 14 files to 32, and that was a BASELINE
 * CORRECTION rather than a shrink-only violation. Not one hand-rolled pin was
 * added: the detector was widened to see plain-string keys alongside
 * `Symbol.for` ones, and 18 files that had pinned to the realm all along became
 * visible for the first time (EI-19479108855357092). The distinction is the
 * whole point of the rule — "the list may only shrink" governs NEW debt, and is
 * not a reason to keep a measurement wrong. Growing it for any OTHER reason
 * re-opens the hole this guard closes.
 */
const ALLOW = new Set([
  // LAST remaining entry (20 of the original 21 sites migrated). Unlike the rest
  // of this list, it is NOT unmigrated debt — the pin is DELIBERATE, and its
  // reason is stated at the site: channel.ts:22-25 picks a brand-neutral,
  // package-internal key precisely so the lib stays borrowable ("No consuming-app
  // or project coupling — any project can borrow this as-is").
  //
  // That rationale argues AGAINST the ordinary fix here: libs/generic/* are
  // standalone published submodules, so declaring @papercusp/module-singleton
  // couples a generic lib to this monorepo for every downstream borrower that
  // does not inherit our hoisting. Note there is no configure*() seam in
  // libs/generic/sse to inject it through either — grep for `export .* configure`
  // returns zero; one would have to be built.
  //
  // So the open question is narrow: does pinModuleState's central visibility
  // (listModuleDuplications() can see the module) outweigh the borrowability the
  // author chose on purpose? That is a generic-first trade-off, tracked on
  // EI-19479108855357092 and still awaiting a plan Decision. Until it is settled,
  // this entry is an intentional exemption, not a migration someone forgot.
  'libs/generic/sse/src/server/channel.ts',
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec)\.[cm]?tsx?$/.test(name)) {
      yield full;
    }
  }
}

/**
 * Find hand-rolled pins in one file's source.
 *
 * A pin needs BOTH halves: a key const (`Symbol.for('...')` OR a plain string)
 * AND that key used to index `globalThis`. The second half is what carries the
 * precision — it is the half that says "this is a REALM PIN" — so it is matched
 * against a globalThis ACCESSOR (`globalThis` itself, or a local bound to it),
 * never against the key's spelling.
 *
 * That accessor requirement is load-bearing for the string form, which is
 * otherwise far too common to match on shape alone: `process.env[ENV_NAME]`,
 * `localStorage[K]` and every other string-keyed index look identical to a pin
 * until you ask WHAT is being indexed. Measured on this tree, requiring the
 * accessor is exactly what separates the 20 real string-key pins from
 * `FORCE_HTTP_ENV_NAME` (a `process.env` read in transport-adapters/configure.ts).
 *
 * Still deliberately NOT flagged: a third-party symbol read with no globalThis
 * (`Symbol.for('drizzle:Name')`), and tagging a non-globalThis shared object
 * (`console[Symbol.for(...)]`).
 */
export function findPins(src, fileName = 'pin.ts') {
  const hits = [];
  // CODE ONLY. This file's own header carries a complete worked pin as PROSE
  // (`const K = '__papercuspPulseCache'; (globalThis as G)[K]`) — measured under
  // WI-37717 to trip this very detector when a file containing it is scanned, which
  // is a rule's documentation reddening its own gate. Any doc comment that shows the
  // banned shape is the same phantom.
  //
  // stripCommentsOnly, NEVER stripCommentsAndStrings: the pin KEY is a string literal
  // (`Symbol.for('…')` / `const K = '…'`), so masking strings would delete the thing
  // being detected and turn this guard into a silent pass. The mask is length-
  // preserving, so the `declLine` line numbers below stay correct.
  src = stripCommentsOnly(src, fileName);
  if (!/globalThis/.test(src)) return hits;

  // Bind each key const to the name it is assigned to. Symbol form first, so a
  // name declared both ways keeps its (more specific) symbol classification.
  const keyByName = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Symbol\.for\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    keyByName.set(m[1], { key: m[2], form: 'symbol' });
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]{2,})['"]\s*(?:as\s+const\s*)?;/g)) {
    if (!keyByName.has(m[1])) keyByName.set(m[1], { key: m[2], form: 'string' });
  }
  if (keyByName.size === 0) return hits;

  // Every identifier that IS globalThis: the builtin, plus any local bound to
  // it (`const g = globalThis as PulseGlobals`) — the dominant shape here.
  const accessors = new Set(['globalThis']);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\b/g)) {
    accessors.add(m[1]);
  }
  const accessorAlt = [...accessors].join('|');

  const lines = src.split('\n');
  for (const [name, info] of keyByName) {
    // The pin half, in the two shapes this repo actually writes. Both are
    // ANCHORED to globalThis — never "the key appears somewhere" — because the
    // string form is otherwise indistinguishable from `process.env[K]`.
    //
    //  (a) INDEXED through an accessor: `g[K]`, `(globalThis as R)[K]`, where
    //      `g` is any local bound to globalThis.
    //  (b) DECLARED in a globalThis intersection type, which wraps across lines:
    //          type G = typeof globalThis & {
    //            [K]?: T;
    //          };
    //      scratch-gc.ts is (b)-only — its indexing call site was deleted when
    //      DBOS took over the schedule, leaving the pin type behind. A
    //      line-local rule silently DROPPED it, i.e. the widening would have
    //      lost a site it was meant to keep. The stale-ALLOW check is what
    //      surfaced that; keep both shapes covered.
    const indexed = new RegExp(
      `\\b(?:${accessorAlt})\\b\\s*(?:as\\s+[^\\[\\]\\n]*?)?\\)?\\s*\\[\\s*${name}\\s*\\]`,
    );
    const declaredInGlobalType = new RegExp(
      `typeof\\s+globalThis\\s*&\\s*\\{[^}]*?\\[\\s*${name}\\s*\\]`,
      's',
    );
    if (!indexed.test(src) && !declaredInGlobalType.test(src)) continue;

    const declRe =
      info.form === 'symbol'
        ? new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*Symbol\\.for`)
        : new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*['"]`);
    const declLine = lines.findIndex((l) => declRe.test(l));
    hits.push({ line: declLine + 1, key: info.key, name, form: info.form });
  }
  return hits;
}

/**
 * `--list` ignores ALLOW and prints the FULL measured population.
 *
 * Seed and re-measure the allowlist from this, never from a hand-run grep: the
 * first version of this list came from an `rg | head -30` and was two sites
 * short, which would have baked a wrong count into the very guard whose job is
 * to make the count trustworthy.
 */
const LIST_ONLY = process.argv.includes('--list');

/**
 * Scan the tree. Exported so a unit test can assert the CURRENT population
 * without shelling out or duplicating the walk.
 */
export function scanTree() {
  const violations = [];
  const allowedSeen = new Set();
  const everyPin = [];

  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      // The mechanism itself is exempt — it IS the sanctioned pin.
      if (rel.startsWith('libs/generic/module-singleton/')) continue;

      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // Cheap prefilter — must admit BOTH key forms, so it keys on the pin half
      // (globalThis) rather than on `Symbol.for`. Narrowing this back to the
      // symbol spelling is precisely what hid ~20 string-key pins.
      if (!src.includes('globalThis')) continue;

      const pins = findPins(src, rel);
      if (pins.length === 0) continue;

      for (const p of pins) everyPin.push({ rel, ...p });

      if (ALLOW.has(rel)) {
        allowedSeen.add(rel);
        continue;
      }
      for (const p of pins) violations.push({ rel, ...p });
    }
  }
  const stale = [...ALLOW].filter((f) => !allowedSeen.has(f)).sort();
  return { violations, allowedSeen, everyPin, stale };
}

/**
 * Run the scan only when invoked as a CLI — importing this module (for the unit
 * test) must NOT exit the process. Symlink-robust (WI-1443): node realpaths
 * import.meta.url while argv[1] keeps the invoked path, so compare both.
 */
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();

if (!isMain) {
  // Imported for its predicate — nothing else to do.
} else {
  main();
}

/**
 * Render a pin's key AS IT IS WRITTEN. Printing every hit as `Symbol.for('...')`
 * would restate the very blind spot this guard was widened to remove — a report
 * asserting a form it did not check.
 */
function renderKey(p) {
  return p.form === 'string' ? `globalThis['${p.key}']` : `Symbol.for('${p.key}')`;
}

function main() {
const { violations, allowedSeen, everyPin, stale } = scanTree();

if (LIST_ONLY) {
  everyPin.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  const files = new Set(everyPin.map((p) => p.rel));
  console.log(`${everyPin.length} hand-rolled pin(s) across ${files.size} file(s):\n`);
  const bySymbol = everyPin.filter((p) => p.form === 'symbol').length;
  for (const p of everyPin) console.log(`  ${p.rel}:${p.line}  ${renderKey(p)}`);
  console.log(
    `\n  (${bySymbol} Symbol.for key(s), ${everyPin.length - bySymbol} plain-string key(s) — ` +
      `both are realm pins and both are invisible to listModuleDuplications())`,
  );
  console.log('\nALLOW seed (paste into this script):\n');
  for (const f of [...files].sort()) console.log(`  '${f}',`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error('\n✖ lint:no-hand-rolled-module-pin — new hand-rolled realm pin(s):\n');
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${renderKey(v)}  (via ${v.name})`);
  }
  console.error(`
Pin module state THROUGH the primitive instead:

    import { pinModuleState } from '@papercusp/module-singleton';
    const state = pinModuleState('${violations[0].key}', () => ({ /* ... */ }));

A hand-rolled globalThis[Symbol.for(...)] slot is equally CORRECT and completely
INVISIBLE to listModuleDuplications() — so the realm-wide report answers a clean
[] while your module is split. The primitive shares the state AND counts the
module records, which is what makes an empty report mean something.

Worked example: libs/generic/scheduled-registry/src/index.ts
Migration of the remaining known sites: EI-19469900474673886
`);
  process.exit(1);
}

if (stale.length > 0) {
  console.log('✔ lint:no-hand-rolled-module-pin — no new hand-rolled pins.');
  console.log(
    `\n  ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer match — ` +
      'migrated or moved. Remove from ALLOW in scripts/check-no-hand-rolled-module-pin.mjs ' +
      '(the list is shrink-only, so a stale entry hides a regression):',
  );
  for (const f of stale) console.log(`    ${f}`);
  process.exit(0);
}

console.log(
  `✔ lint:no-hand-rolled-module-pin — no new hand-rolled pins ` +
    `(${allowedSeen.size} known site${allowedSeen.size === 1 ? '' : 's'} still awaiting migration, EI-19469900474673886).`,
);
}
