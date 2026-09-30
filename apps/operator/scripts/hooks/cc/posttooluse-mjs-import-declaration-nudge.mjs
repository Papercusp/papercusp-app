#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-mjs-import-declaration-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the unenrolled-`.mjs`-import
// trap (EI-20043039577586381, sibling of posttooluse-migration-fixture-drift-nudge.mjs
// / posttooluse-required-field-strand-nudge.mjs).
//
// THE TRAP
//   A `.ts`/`.tsx` file importing a relative `.mjs` that has no sibling `.d.mts`
//   and is not enrolled in tsconfig.declarations.json raises TS7016, which reds
//   the whole fleet gate via the RATCHET in check-unenrolled-mjs-imports.test.ts.
//   Two shapes produce it, and the second is the counter-intuitive one:
//
//     1. A brand-new `scripts/*.mjs` imported from a `.test.ts`. It gets no
//        `.d.mts`, and BOTH `gen:declarations` AND `gen:declarations:check`
//        report SUCCESS about it (EI-20035436440627349) — so the author's
//        natural confirmation step actively reassures them.
//     2. A MULTI-LINE import whose `@ts-expect-error`/`@ts-ignore` sits above
//        the `import` keyword rather than above the `} from '...'` line. tsc
//        reports TS7016 at the module SPECIFIER, not at the import keyword, so
//        a directive that LOOKS correctly placed suppresses nothing.
//
//   Shape 2 has now bitten at least three times (EI-19389216343173748,
//   EI-18817201237512691, and candidate ff45f298 / WI-37657, which held `main`
//   and burned a full gate suite). The offending author in that last case had
//   written a correct multi-line explanatory comment about the constraint —
//   which is exactly why prose warnings keep failing to prevent it and a
//   mechanical edit-time check is warranted.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-unenrolled-mjs-imports.mjs detects both shapes perfectly —
//   `isSuppressed` deliberately anchors on the SPECIFIER line, which is what
//   makes shape 2 visible to it. The detection is already correct; the TIMING
//   is wrong. It runs only inside the vitest suite, i.e. at the green gate,
//   hours after the edit. `npm run lint:tsc -- --files=<file>` would also catch
//   it for anything under packages/operator-core, but nothing prompts an author
//   to run it after adding an import. So the cheapest possible check lands at
//   the most expensive possible moment.
//
//   Running the CLI later does not reliably work on THIS tree either, for the
//   reason the required-field-strand hook documents: git-sync commits the whole
//   shared checkout on a schedule, so a diff-vs-HEAD run minutes after the edit
//   can already see the import as committed history with no informative
//   "before". A PostToolUse hook runs milliseconds after the write, while the
//   file is unambiguously fresh, and reports to the author while it is still
//   their turn to fix it cheaply.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to.
//   - REUSES the detector: `offendersIn` / `enrolledModules` / `isSuppressed` /
//     `BASELINE` / `baselineKey` are dynamically imported from the repo,
//     resolved off the edited file's own path (the hook is installed to
//     ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible). The hook stays a thin trigger; ALL detection logic stays in
//     ONE place, so this nudge cannot drift from the ratchet's verdict.
//   - Only NEWLY introduced offenders fire. A file's HEAD version is the
//     "before"; a brand-new file (no HEAD version) is treated as an empty
//     before, so every offender in it counts as new — shape 1 above is
//     precisely the new-file case, so this is the event we WANT to catch.
//   - BASELINE entries never fire. That baseline is documented as closed and
//     shrink-only, so in practice it is empty; filtering is for correctness,
//     not for an expected population.
//   - Distinguishes shape 2 explicitly: when a directive DOES suppress at the
//     import-keyword line but not at the specifier line, the advisory says the
//     directive is mis-positioned rather than repeating the generic fix.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an
//     unresolvable detector, a parse failure. A bug here must never disturb an
//     edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors the sibling nudges.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-unenrolled-mjs-imports.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/** Separator for the (specifier, target) identity key — never a bare space. */
const KEY_SEP = '::';

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. Once inlined into a
 * bundle every module inherits the bundle entry's `import.meta.url`, so the
 * familiar comparison runs every imported CLI's main() during host boot — the
 * class `isCliEntry(import.meta.url)` exists to close for TS CLIs. The older
 * siblings still use the fileURLToPath shape only as grandfathered, shrink-only
 * debt; new code must not imitate it (scripts/check-no-hand-rolled-cli-entry.mjs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return (
    typeof entryPath === 'string' &&
    /(?:^|[\\/])posttooluse-mjs-import-declaration-nudge\.mjs$/.test(entryPath)
  );
}

if (isDirectCliInvocation()) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = await nudgeFor(filePath);
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/**
 * True for a TypeScript source file the ratchet actually scans. Mirrors the
 * filter in the detector's own `scan()` so the nudge cannot fire on a file the
 * gate would never judge.
 */
export function isCandidateFile(filePath) {
  const norm = filePath.split(sep).join('/');
  if (!norm.endsWith('.ts') && !norm.endsWith('.tsx')) return false;
  if (norm.endsWith('.d.ts')) return false;
  if (norm.includes('/node_modules/')) return false;
  if (norm.includes('/_retired/')) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists.
 */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, DETECTOR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Stable identity for an offending import, independent of line movement. */
function offenderKey(o) {
  return `${o.spec}${KEY_SEP}${o.target}`;
}

/** The advisory text for a set of findings. Exported so the test asserts the real string. */
export function formatNudge(relPath, findings) {
  const lines = [
    '⚠ NEW .mjs IMPORT WITH NO TYPE DECLARATION — this reds the fleet gate (TS7016), not just your file.',
    `  ${relPath}`,
  ];
  for (const { line, spec, target, misplacedDirective } of findings) {
    lines.push(`    • line ${line}: ${spec}  →  ${target}`);
    if (misplacedDirective) {
      lines.push(
        '        ↳ A ts-directive above the `import` keyword does NOT suppress this.',
        '        ↳ tsc reports TS7016 at the module SPECIFIER, so it must sit directly',
        "        ↳ above the `} from '...'` line instead.",
      );
    }
  }
  const anyMisplaced = findings.some((f) => f.misplacedDirective);
  lines.push(
    '',
    '  There are exactly TWO sanctioned fixes — the BASELINE is closed and may not grow:',
    '    1. Enrol the module and commit the emitted sibling .d.mts:',
    '         tsconfig.declarations.json  →  npm run gen:declarations',
    "    2. Suppress at the SPECIFIER line (the `} from '...'` line), not above `import`.",
    '',
  );
  if (anyMisplaced) {
    lines.push(
      '  ⚠ At least one finding above is the mis-positioned-directive shape specifically.',
      '    That is the recurrence this hook exists for (3rd occurrence: EI-19389216343173748,',
      '    EI-18817201237512691, WI-37657 — the last one held `main` and burned a gate suite).',
      '',
    );
  }
  lines.push(
    '  ⚠ `npm run gen:declarations` reports SUCCESS for a brand-new unenrolled .mjs',
    '    (EI-20035436440627349), so it will NOT confirm this for you. Use:',
    '      node scripts/check-unenrolled-mjs-imports.mjs',
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited TypeScript file. Returns the advisory string, or null.
 * `deps` is injected by the self-test; production passes nothing.
 */
export async function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadDetector = defaultLoadDetector,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  const afterText = readFile(abs);
  // No HEAD version (a brand-new test file importing a brand-new .mjs) is the
  // shape-1 case this hook most wants to catch, so treat it as an empty before.
  const beforeText = showHead(root, relPath) ?? '';
  if (beforeText === afterText) return null;

  const detector = await loadDetector(root);
  if (!detector) return null;
  const { offendersIn, enrolledModules, isSuppressed, BASELINE, baselineKey } = detector;
  if (typeof offendersIn !== 'function' || typeof enrolledModules !== 'function') return null;

  let enrolled;
  try {
    enrolled = enrolledModules(root);
  } catch {
    return null; // unreadable/!JSON tsconfig.declarations.json — fail open
  }

  const isBaselined =
    BASELINE && typeof baselineKey === 'function'
      ? (o) => BASELINE.has(baselineKey(o))
      : () => false;

  const after = offendersIn(relPath, afterText, enrolled, root).filter((o) => !isBaselined(o));
  if (!after.length) return null;

  // Only offenders this edit INTRODUCED. Keyed by (specifier, target) so an
  // unrelated edit that merely shifts line numbers does not re-nudge.
  const before = new Set(
    offendersIn(relPath, beforeText, enrolled, root).map((o) => offenderKey(o)),
  );
  const newly = after.filter((o) => !before.has(offenderKey(o)));
  if (!newly.length) return null;

  const afterLines = afterText.split('\n');
  const findings = newly.map((o) => ({
    line: o.line,
    spec: o.spec,
    target: o.target,
    misplacedDirective: hasMisplacedDirective(afterLines, o.line - 1, isSuppressed),
  }));
  return formatNudge(relPath, findings);
}

/**
 * Shape 2 detection: a directive that suppresses at the import-keyword line but
 * NOT at the specifier line. Uses the detector's own `isSuppressed` for both
 * probes, so this can never disagree with the ratchet about what suppresses.
 * Returns false when `isSuppressed` is unavailable — a missing refinement must
 * not suppress the whole advisory.
 */
export function hasMisplacedDirective(lines, specifierLineIdx, isSuppressed) {
  if (typeof isSuppressed !== 'function') return false;
  // The specifier line is by definition NOT suppressed (it was reported as an
  // offender); walk back to the statement's `import` keyword and probe there.
  for (let i = specifierLineIdx; i >= 0 && specifierLineIdx - i <= 20; i -= 1) {
    if (!/\bimport\b/.test(lines[i] ?? '')) continue;
    try {
      return isSuppressed(lines, i) === true;
    } catch {
      return false;
    }
  }
  return false;
}

function defaultShowHead(root, relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open to '' upstream
  }
}

async function defaultLoadDetector(root) {
  try {
    return await import(`file://${join(root, DETECTOR_REL)}`);
  } catch {
    return null;
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf || '{}');
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  check('isCandidateFile accepts a .ts file', isCandidateFile('packages/operator-core/lib/x.test.ts'));
  check('isCandidateFile accepts a .tsx file', isCandidateFile('apps/operator/app/x.tsx'));
  check('isCandidateFile rejects a .d.ts file', !isCandidateFile('packages/operator-core/lib/x.d.ts'));
  check('isCandidateFile rejects node_modules', !isCandidateFile('/repo/node_modules/p/x.ts'));
  check('isCandidateFile rejects _retired', !isCandidateFile('/repo/apps/_retired/x.ts'));
  check('isCandidateFile rejects a .mjs file', !isCandidateFile('scripts/x.mjs'));

  // A stand-in detector driven by markers, mirroring the real one's shapes.
  const fakeDetector = {
    enrolledModules: () => new Set(),
    BASELINE: new Set(),
    baselineKey: (o) => `${o.file}|${o.spec}`,
    isSuppressed: (lines, idx) => /SUPPRESSED_HERE/.test(lines[idx] ?? ''),
    offendersIn: (file, text) => {
      const out = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (/OFFEND_A/.test(lines[i])) {
          out.push({ file, line: i + 1, spec: './a.mjs', target: 'scripts/a.mjs' });
        }
        if (/OFFEND_B/.test(lines[i])) {
          out.push({ file, line: i + 1, spec: './b.mjs', target: 'scripts/b.mjs' });
        }
      }
      return out;
    },
  };
  // `exists` must be realistic, not a blanket true: findRepoRoot stops at the
  // FIRST directory containing the detector, so a blanket true would make the
  // root the edited file's own directory and every relPath a bare basename —
  // which would silently weaken the baseline case (its key is a repo-relative
  // path) into passing for the wrong reason.
  const base = {
    exists: (p) => {
      const s = String(p);
      return s.endsWith(DETECTOR_REL) ? s === join('/repo', DETECTOR_REL) : true;
    },
    sizeOf: () => 10,
    loadDetector: async () => fakeDetector,
  };

  // A brand-new file (no HEAD version) introducing an offender => nudge.
  const brandNew = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'OFFEND_A',
  });
  check('fires on a brand-new file with an unenrolled .mjs import', !!brandNew && brandNew.includes('scripts/a.mjs'));
  check('names the confirm command', !!brandNew && brandNew.includes('check-unenrolled-mjs-imports.mjs'));
  check(
    'warns that gen:declarations reports success anyway',
    !!brandNew && brandNew.includes('gen:declarations` reports SUCCESS'),
  );

  // An edit that introduces NO new offender must stay silent even though one
  // pre-existed (only NEW introductions fire).
  const reEdit = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    showHead: () => 'OFFEND_A',
    readFile: () => 'OFFEND_A\n// comment tweak',
  });
  check('silent on a re-edit that introduces no NEW offender', reEdit === null);

  // Adding a SECOND offender to a file that already had one fires for the new one only.
  const second = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    showHead: () => 'OFFEND_A',
    readFile: () => 'OFFEND_A\nOFFEND_B',
  });
  check('fires for the newly added offender', !!second && second.includes('scripts/b.mjs'));
  check('does not re-report the pre-existing offender', !!second && !second.includes('scripts/a.mjs'));

  // Unchanged content must never fire.
  const same = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    showHead: () => 'OFFEND_A',
    readFile: () => 'OFFEND_A',
  });
  check('silent when content is unchanged', same === null);

  // Shape 2: directive suppresses at the `import` keyword line but not at the
  // specifier line => the advisory must call the mis-positioning out explicitly.
  const misplaced = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'import SUPPRESSED_HERE {\n  thing,\n} from OFFEND_A',
  });
  check('detects the mis-positioned directive shape', !!misplaced && misplaced.includes('does NOT suppress'));
  check('cites the recurrence class', !!misplaced && misplaced.includes('WI-37657'));

  // A baselined offender must never fire.
  const baselined = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      BASELINE: new Set(['packages/operator-core/lib/x.test.ts|./a.mjs']),
    }),
    showHead: () => null,
    readFile: () => 'OFFEND_A',
  });
  check('silent for a baselined offender', baselined === null);

  // Non-candidate path short-circuits before any git/detector work.
  const notTs = await nudgeFor('/repo/scripts/foo.mjs', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => '',
  });
  check('skips a non-TypeScript path without touching git', notTs === null);

  // An unresolvable detector must fail OPEN, not throw.
  const noDetector = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    loadDetector: async () => null,
    showHead: () => null,
    readFile: () => 'OFFEND_A',
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  // An unreadable tsconfig.declarations.json must fail OPEN, not throw.
  const badConfig = await nudgeFor('/repo/packages/operator-core/lib/x.test.ts', {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      enrolledModules: () => {
        throw new Error('bad json');
      },
    }),
    showHead: () => null,
    readFile: () => 'OFFEND_A',
  });
  check('fails open when tsconfig.declarations.json cannot be read', badConfig === null);

  if (failures.length) {
    console.error(`posttooluse-mjs-import-declaration-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-mjs-import-declaration-nudge --self-test: all cases passed');
  process.exit(0);
}
