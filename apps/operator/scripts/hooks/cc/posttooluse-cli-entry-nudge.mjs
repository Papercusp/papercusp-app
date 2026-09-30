#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-cli-entry-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the hand-rolled ESM
// CLI-entry trap (EI-22085994981415983, sibling of
// posttooluse-mjs-import-declaration-nudge.mjs).
//
// THE TRAP
//   `import.meta.url === pathToFileURL(process.argv[1]).href` (and the
//   `file://${process.argv[1]}` / `fileURLToPath(import.meta.url) ===
//   process.argv[1]` spellings) is correct in an unbundled file and WRONG once
//   esbuild inlines the module into the desktop sidecar: every inlined module
//   inherits the bundle entry's `import.meta.url`, so every imported CLI runs
//   its main() — and its process.exit() — during host boot. That is EI-650,
//   where the sidecar exited before serving and took embedded PG with it.
//
//   It is the single most natural thing to type when adding a `.mjs` script, so
//   it keeps coming back. In the three days before this hook was written it
//   reddened the repo-wide gate THREE times — WI-1398269 (08-30),
//   EI-21985446777087608 (08-31) and EI-22085994981415983 (09-01, four sites in
//   one day) — each time blocking every agent's affected run, not just the
//   author's.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-no-hand-rolled-cli-entry.mjs detects all three spellings
//   correctly. The detection is already right; the TIMING is wrong. It runs as
//   a repo-wide guard attached to affected runs and the ~55-minute
//   green-checkpoint, so the cheapest possible fix (one line, at the moment of
//   writing) surfaces at the most expensive possible moment (a fleet-wide gate
//   red, hours later, to whoever happens to be holding the gate).
//
//   Running the CLI later does not reliably work on THIS tree either: git-sync
//   commits the whole shared checkout on a schedule, so a diff-vs-HEAD run
//   minutes after the edit can already see the line as committed history with
//   no informative "before". A PostToolUse hook runs milliseconds after the
//   write, while the file is unambiguously fresh and still cheap to fix.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to.
//   - REUSES the detector: `findGuards`, `ALLOW_COUNTS` and
//     `STANDALONE_ENTRY_EXEMPTIONS` are dynamically imported from the repo,
//     resolved off the edited file's own path (the hook is installed to
//     ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible). ALL pattern knowledge stays in ONE place, so this nudge
//     cannot drift from the gate's verdict.
//   - Fires only when the edit BOTH introduces an occurrence (vs the file's
//     HEAD version) AND leaves the file over its allowance — i.e. only when the
//     gate would actually fail. A brand-new file has no HEAD version and is
//     treated as an empty before, which is the case we most want to catch.
//   - Costs nothing on the overwhelming majority of edits: the same
//     `import.meta.url` substring short-circuit the detector itself uses runs
//     BEFORE any git or detector work.
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
const DETECTOR_REL = join('scripts', 'check-no-hand-rolled-cli-entry.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/**
 * Source roots the gate actually scans (SOURCE_ROOTS in the detector). An edit
 * outside these can never fail the gate, so it must never nudge.
 */
const SOURCE_ROOTS = ['scripts', 'packages', 'libs', 'apps'];

/** Extensions the gate scans (SOURCE_EXT in the detector). */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/i;

/** Directories the gate skips (SKIP_DIRS in the detector). */
const SKIP_DIRS = [
  '.git',
  '.next',
  '_retired',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'dist-sidecar',
  'node_modules',
  'out',
  'public',
  'target',
];

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. This hook exists
 * precisely to stop that idiom spreading, so it must not use it itself; it is
 * executed by bare node from an install directory with no repo around it, so it
 * pins its own basename rather than importing the TypeScript `isCliEntry`
 * helper (scripts/check-no-hand-rolled-cli-entry.mjs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return (
    typeof entryPath === 'string' && /(?:^|[\\/])posttooluse-cli-entry-nudge\.mjs$/.test(entryPath)
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
 * True for a path the gate actually scans. Mirrors the detector's `walk()`
 * filter plus its SOURCE_ROOTS, so the nudge cannot fire on a file the gate
 * would never judge. `relPath` is repo-relative and slash-separated.
 */
export function isScannedPath(relPath) {
  const norm = String(relPath).split(sep).join('/');
  if (norm.startsWith('../') || norm.startsWith('/')) return false;
  const root = norm.split('/')[0];
  if (!SOURCE_ROOTS.includes(root)) return false;
  const segments = norm.split('/');
  const base = segments[segments.length - 1];
  if (!SOURCE_EXT.test(base)) return false;
  if (/(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(base)) return false;
  if (base.endsWith('.d.ts')) return false;
  // The detector never descends into these, so a file under one is invisible to it.
  if (segments.slice(0, -1).some((s) => SKIP_DIRS.includes(s))) return false;
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

/** The advisory text for a set of findings. Exported so the test asserts the real string. */
export function formatNudge(relPath, findings) {
  const lines = [
    '⚠ NEW HAND-ROLLED ESM CLI-ENTRY GUARD — this reds the repo-wide gate for every agent, not just your file.',
    `  ${relPath}`,
  ];
  for (const { line, kind, text } of findings) {
    lines.push(`    • line ${line}  (${kind}): ${text}`);
  }
  lines.push(
    '',
    '  WHY IT IS WRONG: correct unbundled, a landmine once esbuild inlines this module',
    '  into the desktop sidecar — every inlined module inherits the BUNDLE entry’s',
    '  import.meta.url, so this comparison is true for every imported CLI and runs its',
    '  main()/process.exit() during host boot (EI-650 took embedded PG down that way).',
    '',
    '  THE FIX — for anything that can import the helper:',
    "    import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';",
    '    if (isCliEntry(import.meta.url)) main();',
    '  A bare-node .mjs CAN import it (node resolves the .ts through package exports);',
    '  scripts/check-partial-install.mjs and scripts/lint-migrations.mjs already do.',
    '',
    '  If this file is a hook or runner COPIED VERBATIM outside the repo (so it cannot',
    '  import operator-core), pin its own basename instead — the sanctioned form:',
    '    function isDirectCliInvocation(entryPath = process.argv[1]) {',
    '      return typeof entryPath === \'string\' && /(?:^|[\\\\/])your-file\\.mjs$/.test(entryPath);',
    '    }',
    '',
    '  ⛔ Do NOT add this to ALLOW_COUNTS — that baseline is shrink-only and is for',
    '     pre-existing debt. New code never grows it. A genuinely standalone entrypoint',
    '     gets a reason-carrying STANDALONE_ENTRY_EXEMPTIONS entry instead.',
    '',
    '  Confirm with:  node scripts/check-no-hand-rolled-cli-entry.mjs',
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited file. Returns the advisory string, or null.
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

  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  if (!isScannedPath(relPath)) return null;

  const afterText = readFile(abs);
  // The same short-circuit the detector uses: every supported spelling contains
  // this exact token, so almost every edit leaves here without touching git.
  if (!afterText.includes('import.meta.url')) return null;

  // No HEAD version (a brand-new script) is the case this hook most wants to
  // catch, so treat it as an empty before.
  const beforeText = showHead(root, relPath) ?? '';
  if (beforeText === afterText) return null;

  const detector = await loadDetector(root);
  if (!detector) return null;
  const { findGuards, ALLOW_COUNTS, STANDALONE_ENTRY_EXEMPTIONS } = detector;
  if (typeof findGuards !== 'function') return null;

  let after;
  let before;
  try {
    after = findGuards(afterText, relPath);
    before = findGuards(beforeText, relPath);
  } catch {
    return null; // parse failure — fail open
  }
  if (!after.length) return null;

  const countByKind = (hits) => {
    const m = new Map();
    for (const hit of hits) m.set(hit.kind, (m.get(hit.kind) ?? 0) + 1);
    return m;
  };
  const afterCounts = countByKind(after);
  const beforeCounts = countByKind(before);

  const allowanceFor = (kind) => {
    const key = `${relPath}|${kind}`;
    const baseline = ALLOW_COUNTS instanceof Map ? (ALLOW_COUNTS.get(key) ?? 0) : 0;
    const exemption =
      STANDALONE_ENTRY_EXEMPTIONS instanceof Map
        ? (STANDALONE_ENTRY_EXEMPTIONS.get(key)?.count ?? 0)
        : 0;
    return baseline + exemption;
  };

  // Fire only for a kind this edit ADDED to that is also over its allowance —
  // i.e. exactly the condition under which the gate itself would fail.
  const offendingKinds = new Set();
  for (const [kind, count] of afterCounts) {
    if (count <= (beforeCounts.get(kind) ?? 0)) continue;
    if (count <= allowanceFor(kind)) continue;
    offendingKinds.add(kind);
  }
  if (!offendingKinds.size) return null;

  const findings = after
    .filter((hit) => offendingKinds.has(hit.kind))
    .map((hit) => ({ line: hit.line, kind: hit.kind, text: String(hit.text).trim().slice(0, 160) }));
  return formatNudge(relPath, findings);
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

  check('isScannedPath accepts scripts/*.mjs', isScannedPath('scripts/foo.mjs'));
  check('isScannedPath accepts apps/**/*.ts', isScannedPath('apps/operator/scripts/lint-tests.ts'));
  check('isScannedPath rejects an unscanned root', !isScannedPath('papercusp-desktop/bin/x.mjs'));
  check('isScannedPath rejects a test file', !isScannedPath('scripts/foo.test.mjs'));
  check('isScannedPath rejects a .d.ts', !isScannedPath('packages/operator-core/lib/x.d.ts'));
  check('isScannedPath rejects node_modules', !isScannedPath('scripts/node_modules/p/x.mjs'));
  check('isScannedPath rejects _retired', !isScannedPath('apps/_retired/x.mjs'));
  check('isScannedPath rejects a non-source extension', !isScannedPath('scripts/foo.json'));

  // A stand-in detector driven by markers, mirroring the real one's shapes.
  const fakeDetector = {
    ALLOW_COUNTS: new Map(),
    STANDALONE_ENTRY_EXEMPTIONS: new Map(),
    findGuards: (text) => {
      const out = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (/OFFEND_A/.test(lines[i]))
          out.push({ kind: 'path-to-file-url', line: i + 1, offset: i, text: 'OFFEND_A' });
        if (/OFFEND_B/.test(lines[i]))
          out.push({ kind: 'file-template', line: i + 1, offset: i, text: 'OFFEND_B' });
      }
      return out;
    },
  };
  // `exists` must be realistic, not a blanket true: findRepoRoot stops at the
  // FIRST directory containing the detector, so a blanket true would make the
  // root the edited file's own directory and every relPath a bare basename —
  // which would silently weaken the allowance cases into passing for the wrong
  // reason (their keys are repo-relative paths).
  const base = {
    exists: (p) => {
      const s = String(p);
      return s.endsWith(DETECTOR_REL) ? s === join('/repo', DETECTOR_REL) : true;
    },
    sizeOf: () => 10,
    loadDetector: async () => fakeDetector,
  };
  const NEW_FILE = '/repo/scripts/new-cli.mjs';

  // A brand-new file (no HEAD version) introducing an occurrence => nudge.
  const brandNew = await nudgeFor(NEW_FILE, {
    ...base,
    showHead: () => null,
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('fires on a brand-new file with a hand-rolled guard', !!brandNew);
  check('names the isCliEntry fix', !!brandNew && brandNew.includes('isCliEntry(import.meta.url)'));
  check(
    'warns against growing ALLOW_COUNTS',
    !!brandNew && brandNew.includes('Do NOT add this to ALLOW_COUNTS'),
  );
  check(
    'names the confirm command',
    !!brandNew && brandNew.includes('node scripts/check-no-hand-rolled-cli-entry.mjs'),
  );

  // The substring short-circuit must run before any git work.
  const noToken = await nudgeFor(NEW_FILE, {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => 'const x = 1;',
  });
  check('short-circuits a file with no import.meta.url without touching git', noToken === null);

  // An edit that introduces NO new occurrence must stay silent.
  const reEdit = await nudgeFor(NEW_FILE, {
    ...base,
    showHead: () => 'import.meta.url\nOFFEND_A',
    readFile: () => 'import.meta.url\nOFFEND_A\n// comment tweak',
  });
  check('silent on a re-edit that introduces no NEW occurrence', reEdit === null);

  // Unchanged content must never fire.
  const same = await nudgeFor(NEW_FILE, {
    ...base,
    showHead: () => 'import.meta.url\nOFFEND_A',
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('silent when content is unchanged', same === null);

  // Adding a SECOND, different-kind occurrence fires for that kind only.
  const second = await nudgeFor(NEW_FILE, {
    ...base,
    showHead: () => 'import.meta.url\nOFFEND_A',
    readFile: () => 'import.meta.url\nOFFEND_A\nOFFEND_B',
  });
  check('fires for the newly added kind', !!second && second.includes('file-template'));
  check(
    'does not re-report the pre-existing kind',
    !!second && !second.includes('path-to-file-url'),
  );

  // A path the gate never scans must never fire, even with an offender in it.
  const unscanned = await nudgeFor('/repo/papercusp-desktop/bin/x.mjs', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('silent for a path outside the scanned roots', unscanned === null);

  // An occurrence WITHIN the shrink-only baseline must not fire (it is the
  // measured pre-existing population, and the gate tolerates it).
  const baselined = await nudgeFor(NEW_FILE, {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      ALLOW_COUNTS: new Map([['scripts/new-cli.mjs|path-to-file-url', 1]]),
    }),
    showHead: () => null,
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('silent for an occurrence inside the shrink-only baseline', baselined === null);

  // ...but exceeding that baseline DOES fire, which is the ratchet's real rule.
  const overBaseline = await nudgeFor(NEW_FILE, {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      ALLOW_COUNTS: new Map([['scripts/new-cli.mjs|path-to-file-url', 1]]),
    }),
    showHead: () => 'import.meta.url\nOFFEND_A',
    readFile: () => 'import.meta.url\nOFFEND_A\nOFFEND_A',
  });
  check('fires when an edit exceeds the baselined count', !!overBaseline);

  // A reasoned standalone exemption must not fire.
  const exempted = await nudgeFor(NEW_FILE, {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      STANDALONE_ENTRY_EXEMPTIONS: new Map([
        ['scripts/new-cli.mjs|path-to-file-url', { count: 1, reason: 'copied verbatim' }],
      ]),
    }),
    showHead: () => null,
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('silent for a reasoned standalone exemption', exempted === null);

  // An unresolvable detector must fail OPEN, not throw.
  const noDetector = await nudgeFor(NEW_FILE, {
    ...base,
    loadDetector: async () => null,
    showHead: () => null,
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  // A detector whose findGuards throws must fail OPEN, not throw.
  const throwingDetector = await nudgeFor(NEW_FILE, {
    ...base,
    loadDetector: async () => ({
      ...fakeDetector,
      findGuards: () => {
        throw new Error('parse failure');
      },
    }),
    showHead: () => null,
    readFile: () => 'import.meta.url\nOFFEND_A',
  });
  check('fails open when the detector throws', throwingDetector === null);

  if (failures.length) {
    console.error(`posttooluse-cli-entry-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-cli-entry-nudge --self-test: all cases passed');
  process.exit(0);
}
