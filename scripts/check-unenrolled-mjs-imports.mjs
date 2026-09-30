#!/usr/bin/env node
/**
 * check-unenrolled-mjs-imports.mjs — fail-loud guard against a `.mjs` imported
 * from TypeScript that is NEITHER enrolled for declaration generation NOR
 * type-suppressed (EI-19346163916263067).
 *
 * `packages/operator-core` is `allowJs: false` + `strict`, so importing a plain
 * `.mjs` from a `.ts` file needs one of exactly two things:
 *
 *   1. ENROL it in `tsconfig.declarations.json`, so `npm run gen:declarations`
 *      emits a committed sibling `.d.mts` (16 modules today — fully typed, and
 *      kept honest by `generated-declarations.test.ts`); or
 *   2. SUPPRESS the import with `@ts-ignore` / `@ts-expect-error` (37 modules
 *      today — the `// @ts-ignore — pure JS guard script, no .d.ts` convention).
 *      Everything the module exports is `any` in that file.
 *
 * Both are legitimate and this guard endorses both. It catches only the THIRD
 * case — doing neither — which is the natural thing to write and is always
 * `TS7016: Could not find a declaration file for module '...'`.
 *
 * WHY A DEDICATED GUARD (none of the existing checks can see this):
 *   - vitest never typechecks (esbuild transform), so `test:affected` is green.
 *   - the tsc baseline cannot absorb it: baselines are per-file, and the new
 *     import is in a file whose errors were never baselined — which is exactly
 *     why it REDS the gate instead of being tolerated.
 *   - `gen:declarations:check` only validates modules the config already LISTS,
 *     so a module nobody enrolled is invisible to it by construction.
 *
 * So the first signal today is the ~55-minute green-checkpoint, where it reds
 * the gate for the whole fleet. This turns that into a ~1s local failure.
 *
 *   node scripts/check-unenrolled-mjs-imports.mjs
 *
 * BASELINE is deliberately EMPTY and must stay that way: every existing import
 * already satisfies (1) or (2), so any offender this reports is genuinely new.
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listFilesIncludingUntracked, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'tsconfig.declarations.json';

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY; NEW entries may NOT be added).
 *
 * Every entry is in `apps/operator` (`@papercusp/web`), which is `allowJs: false`
 * + strict and so genuinely has TS7016 on each of these — but which NO tsc gate
 * compiles. The four per-project gates are operator-core, operator-VITE
 * (`apps/operator-vite/`, a different directory), orchestrator and papercusp-libs;
 * `apps/operator` has no `typecheck` script of its own either. So these are real
 * but latent: they red nothing today, and failing on them would make this guard
 * unadoptable without fixing 13 unrelated imports first.
 *
 * Keyed by `file -> target`, deliberately NOT by line, so ordinary edits don't
 * churn it while a NEW module imported into an already-listed file still fires.
 * Fix one by giving it a `@ts-ignore` or enrolling it, then delete its line.
 *
 * @type {Set<string>}
 */
export const BASELINE = new Set([
  'apps/operator/scripts/check-vitest-mock-paths.test.ts -> apps/operator/scripts/check-vitest-mock-paths.mjs',
]);

/**
 * The baseline key for an offender — `file -> target`, no line number.
 *
 * @param {{ file: string, target: string }} o
 * @returns {string}
 */
export function baselineKey(o) {
  return `${o.file} -> ${o.target}`;
}

/**
 * The `.mjs` modules enrolled for declaration generation, as absolute paths.
 * Read from `tsconfig.declarations.json` (JSONC — tsc accepts `//` comments)
 * so this guard and `gen-declarations.ts` can never disagree about the set.
 *
 * @param {string} [root]
 * @returns {Set<string>}
 */
export function enrolledModules(root = ROOT) {
  const raw = readFileSync(resolve(root, CONFIG), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = /** @type {{ files?: string[] }} */ (JSON.parse(raw));
  return new Set((parsed.files ?? []).map((f) => resolve(root, f)));
}

/**
 * Scan upwards from `anchor` for a `@ts-ignore` / `@ts-expect-error` directive,
 * skipping blank lines, comment lines, and the `eslint-disable-next-line
 * @typescript-eslint/ban-ts-comment` pragma the local convention pairs with it.
 *
 * ⚠ COMMENT LINES ARE TRIVIA AND DO NOT BREAK SUPPRESSION — a directive keeps
 * suppressing across ANY number of intervening comment lines. This is tsc's real
 * behaviour (it walks back over blank/comment-only lines looking for a preceding
 * comment directive), not an approximation of it.
 *
 * This function previously scanned with a budget of 3 non-blank lines and counted
 * comment lines AGAINST that budget, so an import whose directive carried more
 * than three lines of explanation was reported as unsuppressed — a pure false
 * positive on code tsc compiles clean. It red-pinned the fleet gate on
 * `no-module-scope-flag-subscribe-guard.test.ts` (6 explanatory comment lines
 * between the directive and the import) while `tsc` reported no TS7016 for it at
 * all. Measured with an isolated tsc run over that exact shape plus a
 * no-directive control: control → TS7016, offender shape → clean.
 *
 * The "don't borrow a directive from an unrelated statement" property is enforced
 * by the break on the first line of real CODE below — never by the line budget —
 * so removing the budget does not weaken it.
 *
 * THE RULE, as a measured truth table (tsc, 2026-08-03, two agents independently).
 * It is neither "adjacency" nor "no comments": THE MODULE SPECIFIER MUST LAND ON
 * THE LINE THE DIRECTIVE COVERS. tsc skips comment/blank trivia and applies the
 * directive to the next line of CODE; a multi-line import moves the specifier past
 * it.
 *
 *   @ts-ignore immediately before a ONE-LINE import    -> clean
 *   @ts-ignore + N comment lines, then ONE-LINE import -> clean   (this bug)
 *   no directive at all                                -> TS7016  (the control)
 *   @ts-ignore immediately before a MULTI-LINE import  -> TS7016  (WI-8887)
 *   comments between AND a multi-line import           -> TS7016
 *
 * The control line matters: without a case that DOES error, a clean result proves
 * only that the probe is inert. Both wrong readings of this rule were published
 * from measurements that lacked one (EI-19457275636306147).
 *
 * @param {string[]} lines
 * @param {number} anchor 0-based index of the line the directive must precede
 * @returns {boolean}
 */
function directiveAbove(lines, anchor) {
  for (let i = anchor - 1; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim();
    if (text === '') continue;
    if (/@ts-(?:ignore|expect-error)/.test(text)) return true;
    if (text.startsWith('// eslint-disable')) continue;
    // Comment-only line: trivia to tsc, so keep scanning without consuming budget.
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
    // First line of real code — any directive above THIS one belongs to it, not to us.
    break;
  }
  return false;
}

/**
 * True when the import carrying the specifier on `lineIdx` is type-suppressed.
 *
 * There is exactly ONE valid anchor: tsc reports TS7016 at the line carrying the
 * module specifier, and a `@ts-ignore`/`@ts-expect-error` suppresses the next
 * line of real CODE (blank and comment-only lines in between are trivia and are
 * skipped — see `directiveAbove`) — so the directive must sit above `lineIdx`
 * with nothing but comments/blanks between them. For a single-line
 * `import { x } from './y.mjs'`, `lineIdx`
 * IS the statement's own line, so this is also "directive above the statement".
 * For a MULTI-LINE `import {\n  x,\n} from './y.mjs'`, `lineIdx` is the `from`
 * line, so the directive must sit immediately above THAT — i.e. inside the
 * braces (see the comments in fs-mutex.test.ts / test-file-router.test.ts,
 * which spell this out).
 *
 * A directive placed above the `import` keyword of a MULTI-LINE import does
 * **not** suppress anything — verified empirically against `tsc` (EI-19389216343173748:
 * `check-migration-fixture-drift.test.ts` shipped exactly this shape and still
 * red TS7016, plus a bonus TS2578 "unused directive"). A prior cut of this
 * function anchored there as a fallback to avoid false positives on genuinely
 * suppressed multi-line imports — but every import that fallback was rescuing
 * already has its directive correctly placed immediately above the specifier
 * line, so `directiveAbove(lines, lineIdx)` alone already recognizes it; the
 * fallback's only real effect was to also accept the BROKEN placement as if it
 * worked. Removed rather than special-cased, so the guard cannot again give
 * false assurance for the exact case it exists to catch (EI-19365056012137849 is
 * the same bug class, found independently in `tsc-red-observations.mjs`'s import).
 *
 * @param {string[]} lines
 * @param {number} lineIdx 0-based index of the line carrying the specifier
 * @returns {boolean}
 */
export function isSuppressed(lines, lineIdx) {
  return directiveAbove(lines, lineIdx);
}

/**
 * Whether the nearest enclosing tsconfig for `file` sets `allowJs`.
 *
 * A project with `allowJs: true` (e.g. `libs/papercusp/libs/db`) consumes a
 * plain `.mjs` happily and never emits TS7016, so flagging an import there
 * would be a pure false positive. Resolution walks up to the nearest
 * `tsconfig.json` and follows `extends` so a base-config setting still counts.
 *
 * @param {string} file repo-relative path to the importing file
 * @param {string} [root]
 * @returns {boolean}
 */
export function projectAllowsJs(file, root = ROOT) {
  let dir = dirname(resolve(root, file));
  const stop = resolve(root);
  while (dir.startsWith(stop)) {
    const cfg = resolve(dir, 'tsconfig.json');
    if (existsSync(cfg)) return readAllowJs(cfg, 0);
    if (dir === stop) break;
    dir = dirname(dir);
  }
  return false;
}

/**
 * @param {string} cfgPath
 * @param {number} depth
 * @returns {boolean}
 */
function readAllowJs(cfgPath, depth) {
  if (depth > 4) return false;
  let parsed;
  try {
    parsed = /** @type {{ compilerOptions?: { allowJs?: boolean }, extends?: string }} */ (
      JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    );
  } catch {
    return false;
  }
  if (typeof parsed.compilerOptions?.allowJs === 'boolean') return parsed.compilerOptions.allowJs;
  if (parsed.extends) {
    const base = resolve(dirname(cfgPath), parsed.extends);
    const withExt = base.endsWith('.json') ? base : `${base}.json`;
    if (existsSync(withExt)) return readAllowJs(withExt, depth + 1);
  }
  return false;
}

/**
 * Every relative `.mjs` specifier in `text`, with the 0-based line it sits on.
 * Covers both static `from '...'` and dynamic `import('...')`.
 *
 * @param {string} text
 * @returns {{ spec: string, lineIdx: number }[]}
 */
export function findMjsSpecifiers(text) {
  const lines = text.split('\n');
  /** @type {{ spec: string, lineIdx: number }[]} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const re = /(?:from|import\s*\()\s*['"](\.[^'"]*\.mjs)['"]/g;
    let m;
    while ((m = re.exec(lines[i] ?? '')) !== null) found.push({ spec: m[1], lineIdx: i });
  }
  return found;
}

/**
 * Offending imports in one TypeScript file: a resolvable `.mjs` with no
 * declaration, not enrolled, and not suppressed.
 *
 * @param {string} file repo-relative path to a .ts/.tsx file
 * @param {string} text its contents
 * @param {Set<string>} enrolled
 * @param {string} [root]
 * @returns {{ file: string, line: number, spec: string, target: string }[]}
 */
export function offendersIn(file, text, enrolled, root = ROOT) {
  const lines = text.split('\n');
  /** @type {{ file: string, line: number, spec: string, target: string }[]} */
  const out = [];
  for (const { spec, lineIdx } of findMjsSpecifiers(text)) {
    const abs = resolve(dirname(resolve(root, file)), spec);
    // An unresolvable specifier is a different bug (and tsc reports it as
    // TS2307); this guard only speaks to modules that genuinely exist.
    if (!existsSync(abs)) continue;
    if (existsSync(abs.replace(/\.mjs$/, '.d.mts'))) continue;
    if (enrolled.has(abs)) continue;
    if (isSuppressed(lines, lineIdx)) continue;
    out.push({ file, line: lineIdx + 1, spec, target: relative(root, abs) });
  }
  return out;
}

/**
 * Scan every `.ts`/`.tsx` file, INCLUDING untracked-but-not-ignored ones.
 *
 * Untracked coverage is the point, not a bonus (the WI-6730 reasoning the
 * identity guards use): a brand-new file is invisible to a plain
 * `git ls-files` until it is added, and on this tree that is the entire window
 * in which the author can still fix a bad import cheaply — once git-sync
 * commits it, the next green-checkpoint reds for the whole fleet.
 *
 * @param {string} [root]
 * @returns {{ file: string, line: number, spec: string, target: string }[]}
 */
export function scan(root = ROOT) {
  const enrolled = enrolledModules(root);
  const files = listFilesIncludingUntracked(root).files.filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.endsWith('.d.ts') &&
      !f.includes('node_modules/') &&
      !f.includes('_retired/'),
  );
  /** @type {{ file: string, line: number, spec: string, target: string }[]} */
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('.mjs')) continue;
    if (projectAllowsJs(file, root)) continue;
    out.push(...offendersIn(file, text, enrolled, root));
  }
  return out;
}

function main() {
  const all = scan();
  const offenders = all.filter((o) => !BASELINE.has(baselineKey(o)));

  // Report coverage honestly rather than inferring it from an exit code — a
  // submodule git cannot descend into contributes no files and would otherwise
  // read as "clean" (the shared coverage contract in scripts/lib/tracked-files.mjs).
  const unscanned = describeUnscanned(listFilesIncludingUntracked(ROOT));
  if (unscanned) console.error(unscanned);

  // A baseline entry that no longer offends has been FIXED — say so loudly so the
  // ratchet actually shrinks, but do NOT fail on it: this runs on a tree the whole
  // fleet edits concurrently, and failing a peer's build the moment they improve
  // something is how a guard gets disabled rather than obeyed.
  const live = new Set(all.map(baselineKey));
  const stale = [...BASELINE].filter((k) => !live.has(k));
  if (stale.length) {
    console.error(`\n⚠ ${stale.length} BASELINE entr(y/ies) no longer offend — delete them from BASELINE`);
    console.error('  in scripts/check-unenrolled-mjs-imports.mjs so the ratchet cannot rot:\n');
    for (const k of stale) console.error(`    ${k}`);
  }

  if (offenders.length === 0) {
    console.log(
      `✓ check-unenrolled-mjs-imports: every .mjs imported from TS is enrolled or suppressed (${BASELINE.size} baselined)`,
    );
    return;
  }
  console.error('\n✗ .mjs imported from TypeScript with no declaration and no suppression.');
  console.error('  These projects are `allowJs: false` + strict, so each one is TS7016 —');
  console.error('  which vitest cannot see and the tsc baseline cannot absorb (new file, new error).\n');
  for (const o of offenders) console.error(`    ${o.file}:${o.line}  ->  ${o.target}`);
  console.error('\n  Fix with EITHER:');
  console.error(`    1. add the module to ${CONFIG} and run \`npm run gen:declarations\` (typed), or`);
  console.error('    2. prefix the import with `// @ts-ignore — pure JS script, no .d.ts` (untyped).');
  console.error('\n  For a MULTI-LINE import the directive must go immediately above the `} from ...`');
  console.error('  line — that is where tsc lands the diagnostic — not above the `import` keyword.');
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit
// test) must NOT walk the tree or exit the process. Symlink-robust (WI-1443):
// node realpaths import.meta.url while argv[1] keeps the invoked path.
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
if (isMain) {
  main();
}
