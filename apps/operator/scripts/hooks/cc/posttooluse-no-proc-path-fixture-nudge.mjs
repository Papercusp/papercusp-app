#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-no-proc-path-fixture-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge: the file you just wrote contains
// a MADE-UP `/proc/...` path literal, which HANGS Node forever (EI-19968483416347685).
//
// THE TRAP
//   procfs answers mkdir on a non-existent path with ENOENT rather than EACCES/EPERM.
//   Node's recursive mkdir reads ENOENT as "the parent is missing", walks up to create
//   /proc, gets EEXIST ("parent exists — retry the child"), and ping-pongs forever:
//   44,995 mkdirat syscalls in a 3s strace. The hang happens during vitest COLLECTION,
//   so the run emits ZERO output — no banner, no filename, no test count — and looks
//   exactly like a heavy job queued behind the pc-heavy slot clamp. It also poisons
//   sibling files sharing the vitest process, so they look wedged too.
//
// WHY EDIT TIME, WHEN A GATE TEST ALREADY EXISTS
//   The detector (scripts/check-no-proc-path-fixture.mjs) is excellent and the gate
//   test (packages/operator-core/lib/no-proc-path-fixture-guard.test.ts) is correct.
//   But together they were the ONLY two ways to learn about this, and neither reaches
//   the author: nobody runs `npm run lint:no-proc-path-fixture` by name, and the gate
//   answers ~55min later — as a red that freezes `main` for the whole fleet.
//
//   That ordering was backwards. Five cheaper traps (migration drift, forward-compat,
//   required-field strand, tool-prompt weight, ts-parse) all had PostToolUse nudges,
//   while the one trap that can silently freeze the fleet had none. This closes that
//   gap; it is the third recorded incident (2026-07-11 wedged every gate for hours;
//   2026-08-02 cost a peer two misdiagnoses, two kills and a pointless re-route;
//   2026-08-09 red-pinned `main` across two cycles — that one was mine, which is why
//   this hook exists).
//
// WHY AN AUTHOR CANNOT SELF-DEFEND HERE
//   The hang is implementation-dependent and INVISIBLE AT THE CALL SITE: coreutils
//   `mkdir -p` on the identical path fails in 5ms, so the same string is harmless in a
//   shell script and wedges the run in Node. A careful author writing a /proc path has
//   no local signal that anything is wrong — in the 2026-08-09 case every check the
//   author ran was green (58 own tests, 18 sibling/consumer suites, lint:tsc clean,
//   lint:tests clean). Only a whole-tree census guard saw it, hours later.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to.
//   - IMPORTS THE REAL DETECTOR rather than mirroring it. Unlike the ts-parse sibling
//     (whose detector is .ts, so a plain-node hook had to reimplement it and pin the
//     copy with a drift test), `check-no-proc-path-fixture.mjs` is already .mjs with a
//     symlink-robust isMain guard, so importing it executes no scan and cannot exit
//     the process. There is therefore NO second copy of the policy to drift — the
//     allowlist, the known-procfs-entry set and the comment-stripping all come from
//     the one source of truth the gate itself uses.
//   - RESPECTS THE DETECTOR'S ALLOWLIST, so editing the guard or its own test — both
//     of which contain the banned form by construction — never nags.
//   - FAILS OPEN on every internal error: bad JSON, missing file, unreadable path, no
//     resolvable detector, an oversized file. A bug here must never disturb an edit
//     that already succeeded, and silence is the correct degraded state for a guard
//     whose real backstop (the gate) still exists.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure;
//     mirrors the sibling PostToolUse nudges.
//
// ⚠ EDITING THIS FILE: do NOT write a made-up `/proc/<segment>` literal in it. This
//   file is NOT on the detector's allowlist, so a literal fixture here would red the
//   very gate leg this hook exists to prevent. The self-test below builds its inputs
//   by concatenation for exactly that reason — see the note there.
//
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

/**
 * How the repo root is identified — and, because the detector is what this hook
 * needs, finding it also PROVES it is present. One check, so there is no separate
 * existence probe to drift out of sync (mirrors the ts-parse sibling's TS_REL trick).
 */
const DETECTOR_REL = join('scripts', 'check-no-proc-path-fixture.mjs');

/** File types the gate's own scan covers (SCANNED_EXT in the detector's CLI half). */
const CANDIDATE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;

/** Scanning a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 2_000_000;

// Run the hook ONLY when executed as a binary — never on import, so the test suite can
// import the checker without main() waiting on stdin and then exiting the vitest worker.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

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

/** True for a file type the detector's tree scan would cover. */
export function isCandidateFile(filePath) {
  return CANDIDATE_EXT.test(filePath);
}

/**
 * Walk up from the edited file until a directory carries the detector. Returns the
 * repo root, or null when the edit is outside any tree that has it (in which case the
 * hook stays silent rather than guessing).
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

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, offenders) {
  const lines = [
    'This file contains a MADE-UP /proc/… path literal, which HANGS Node forever:',
    `  ${relPath}`,
  ];
  for (const o of offenders) lines.push(`    →  ${o.literal}`);
  lines.push(
    '',
    '  Recursive mkdir on a non-existent procfs path NEVER RETURNS: procfs answers',
    '  mkdir with ENOENT, Node reads that as "parent missing", creates /proc (EEXIST),',
    '  retries the child, and ping-pongs forever (~45k syscalls per 3s).',
    '',
    '  The symptom is why this matters: the hang happens during vitest COLLECTION, so',
    '  the run emits ZERO output — no banner, no filename, no test count — and is',
    '  indistinguishable from a heavy job queued behind the pc-heavy slot clamp. It',
    '  also poisons sibling files sharing the vitest process. It has red-pinned or',
    '  wedged the fleet gate three times.',
    '',
    '  Note it looks fine locally: coreutils `mkdir -p` on the same path fails in 5ms,',
    '  so this is harmless in a shell script and fatal in Node. You cannot tell from',
    '  the call site which one will consume it.',
    '',
    '  Use the shared fixture instead — it fails ENOTDIR in 0ms and is portable:',
    "    import { unwritablePath } from '@papercusp/operator-core/lib/testing/unwritable-path';",
    '',
    '  See EI-19369372064589484. Run `npm run lint:no-proc-path-fixture` to check the tree.',
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited file. Returns the advisory string, or null.
 * Every dependency is injectable so the test can drive it without a real repo.
 */
export async function nudgeFor(filePath, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const sizeOf = deps.sizeOf ?? ((p) => statSync(p).size);
  const loadDetector = deps.loadDetector ?? defaultLoadDetector;

  if (!isCandidateFile(filePath)) return null;

  const repoRoot = deps.repoRoot ?? findRepoRoot(filePath, exists);
  if (!repoRoot) return null;

  const rel = (relative(repoRoot, resolve(filePath)) || filePath).split(/[\\/]/).join('/');

  const detector = await loadDetector(repoRoot);
  if (!detector || typeof detector.findProcFixtureOffenders !== 'function') return null;

  // The guard and its own test contain the banned form by construction.
  if (detector.ALLOWLIST && detector.ALLOWLIST.has(rel)) return null;

  let text;
  try {
    if (sizeOf(filePath) > MAX_BYTES) return null;
    text = readFile(filePath);
  } catch {
    return null; // deleted/renamed/unreadable between the write and this hook
  }
  if (typeof text !== 'string' || text.length === 0) return null;

  const offenders = detector.findProcFixtureOffenders(text);
  if (!offenders || offenders.length === 0) return null;

  // De-duplicate: the same literal repeated is one problem to report, not N.
  const seen = new Set();
  const unique = offenders.filter((o) => (seen.has(o.literal) ? false : (seen.add(o.literal), true)));

  return formatNudge(rel, unique);
}

/**
 * Import the detector from the REPO BEING EDITED, not from the hook's own location.
 * This hook is installed to ~/.papercusp/hooks/cc/, detached from any repo, so a
 * relative import resolves against that directory and finds nothing — which would fail
 * open silently, i.e. the guard would appear installed and never fire.
 */
async function defaultLoadDetector(repoRoot) {
  try {
    return await import(pathToFileURL(join(repoRoot, DETECTOR_REL)).href);
  } catch {
    return null;
  }
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('');
    let data = '';
    const t = setTimeout(() => res(data), timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      res(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      res(data);
    });
  });
}

function done() {
  process.exit(0);
}

async function selfTest() {
  const failures = [];
  const check = (name, ok) => {
    if (!ok) failures.push(name);
  };

  const detector = await defaultLoadDetector(findRepoRoot(fileURLToPath(import.meta.url)) ?? process.cwd());
  if (!detector) {
    console.error('posttooluse-no-proc-path-fixture-nudge --self-test: cannot resolve the detector');
    process.exit(1);
  }

  // ⚠ Every banned literal below is built by CONCATENATION, never written out. The
  // detector anchors on a quote immediately followed by the /proc/ prefix, and treats a
  // bare '/proc/' (empty first segment) as legitimate — so `'/proc/' + 'made-up'`
  // leaves NO offending literal in this file's source while producing the exact
  // offending string at runtime. Spelling it literally would red the gate leg this
  // hook exists to prevent, because this file is not on the detector's allowlist.
  const P = '/proc/';
  const madeUp = `const p = '${P}definitely-not-real/x';\n`;
  const realEntry = `const p = '${P}self/status';\n`;
  const pidPath = `const p = '${P}1234/cmdline';\n`;

  const base = {
    exists: () => true,
    repoRoot: '/repo',
    sizeOf: () => 100,
    loadDetector: async () => detector,
  };

  const hit = await nudgeFor('/repo/packages/x/a.test.ts', { ...base, readFile: () => madeUp });
  check('reports a made-up /proc literal', typeof hit === 'string' && /HANGS Node forever/.test(hit));
  check('names the file', typeof hit === 'string' && /packages\/x\/a\.test\.ts/.test(hit));
  check('points at the shared fixture', typeof hit === 'string' && /unwritablePath/.test(hit));

  const realOk = await nudgeFor('/repo/packages/x/b.ts', { ...base, readFile: () => realEntry });
  check('silent on a REAL procfs entry', realOk === null);

  const pidOk = await nudgeFor('/repo/packages/x/c.ts', { ...base, readFile: () => pidPath });
  check('silent on a literal pid path', pidOk === null);

  const clean = await nudgeFor('/repo/packages/x/d.ts', {
    ...base,
    readFile: () => 'export const a = 1;\n',
  });
  check('silent on a clean file', clean === null);

  // A comment WARNING about the trap must not nag (the detector strips comments).
  const inComment = await nudgeFor('/repo/packages/x/e.ts', {
    ...base,
    readFile: () => `// never use '${P}made-up-thing' as a fixture\nexport const a = 1;\n`,
  });
  check('silent when the literal is only in a comment', inComment === null);

  // The detector's own allowlist is honoured.
  const allowlisted = await nudgeFor('/repo/scripts/check-no-proc-path-fixture.mjs', {
    ...base,
    readFile: () => madeUp,
  });
  check('silent on an allowlisted file', allowlisted === null);

  const notCode = await nudgeFor('/repo/docs/readme.md', {
    ...base,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('skips a non-code path without reading it', notCode === null);

  const noRoot = await nudgeFor('/elsewhere/a.ts', {
    ...base,
    repoRoot: null,
    exists: () => false,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('silent outside a repo carrying the detector', noRoot === null);

  const unreadable = await nudgeFor('/repo/packages/x/gone.ts', {
    ...base,
    readFile: () => {
      throw new Error('ENOENT');
    },
  });
  check('fails open on an unreadable file', unreadable === null);

  const noDetector = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    readFile: () => madeUp,
    loadDetector: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  const huge = await nudgeFor('/repo/packages/x/huge.ts', {
    ...base,
    sizeOf: () => MAX_BYTES + 1,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('skips an oversized file without reading it', huge === null);

  // CALIBRATION: prove the fixtures above are real inputs, not vacuous ones — without
  // this, every "silent on X" case would also pass if the detector were a no-op.
  check('calibration: the detector really flags the made-up literal', detector.findProcFixtureOffenders(madeUp).length > 0);
  check('calibration: the detector really allows a real entry', detector.findProcFixtureOffenders(realEntry).length === 0);

  if (failures.length) {
    console.error(`posttooluse-no-proc-path-fixture-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-no-proc-path-fixture-nudge --self-test: all cases passed');
  process.exit(0);
}
