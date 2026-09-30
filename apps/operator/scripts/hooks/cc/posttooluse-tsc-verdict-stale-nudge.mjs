#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-tsc-verdict-stale-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the stale-tsc-verdict
// trap (EI-19421388108187854, sibling of
// posttooluse-migration-fixture-drift-nudge.mjs and
// posttooluse-required-field-strand-nudge.mjs).
//
// THE TRAP
//   The ordinary debugging loop banks a verdict it then invalidates:
//     1. edit source
//     2. `lint:tsc --files=<source files>`  -> clean
//     3. run the suites                     -> 1 test FAILS
//     4. edit the TEST file to fix it
//     5. re-run the suites                  -> green
//     6. report "changed files tsc-clean"
//   Step 2's verdict was accurate when it ran. Step 4 edited a file outside
//   that verdict's scope, and nothing re-checks, so a verdict banked at step 2
//   is reported at step 6 as though it covered the final tree.
//
//   Two things compound to make it hard to notice:
//     1. The last edit is almost always a TEST file — because a failing test is
//        what sent you back to edit. Test files are exactly what gets filed
//        mentally under "not the real code", so they are the least likely to
//        trigger a "should I re-typecheck?" instinct.
//     2. The green suite at step 5 FEELS like the stronger, later, more
//        complete check. It is not: vitest transforms via esbuild and never
//        typechecks, so a green suite carries ZERO type information. The agent
//        ends holding a fresh green signal that is silent on types beside a
//        stale clean one that is not, and reads the pair as agreement.
//
//   The resulting regression is type-only, invisible to `test:affected` by
//   construction, and first surfaces at the fleet green-checkpoint hours later
//   where it reds the gate for everyone (measured instance: WI-7432 /
//   commit 190f0db90b, filed against a peer as WI-7495 while main sat frozen
//   >10.5h across 6 consecutive reds).
//
// WHY A HOOK RATHER THAN GUIDANCE
//   The trigger is an ABSENCE — the moment you STOP editing — which is the
//   same shape CLAUDE.md already identifies as unreliable for the end-of-turn
//   loop-arming rule ("it fires at a NON-EVENT... nothing prompts you"). A
//   discipline cannot fire on a non-event; a hook on the LAST edit can, because
//   every candidate last edit is itself an event.
//
// WHY IT CANNOT FALSE-POSITIVE INTO NOISE
//   It stays silent unless a real `lint:tsc` verdict is actually standing (a
//   marker written by that run), the edited file is one tsc would compile, and
//   the edit post-dates the verdict. It then fires at most ONCE per file per
//   verdict — a later `lint:tsc` writes a new marker and resets the ledger, so
//   re-running the check is what silences it.
//
// ADVISORY ONLY — always exits 0 and never blocks a write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionScopedScratchRel(baseName, sessionId = process.env.PAPERCUSP_SID) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!SESSION_ID_PATTERN.test(normalized)) return null;
  return join('.papercusp', 'scratch', `${baseName}.${normalized}.json`);
}

/** Extensions `tsc` actually compiles. A .js/.mjs edit cannot break a type. */
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * A verdict older than this is not "the standing verdict for what I am doing
 * now" — it is yesterday's. Nudging on it would be noise about a loop that
 * ended long ago.
 */
const VERDICT_LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`. Once
 * inlined into a bundle every module inherits the bundle entry's
 * `import.meta.url`, so the familiar comparison runs every imported CLI's main()
 * during host boot — the class `isCliEntry(import.meta.url)` exists to close for
 * TS CLIs. This hook is executed by bare node on every PostToolUse, so it pins
 * its own basename rather than paying an operator-core import on that hot path
 * (scripts/check-no-hand-rolled-cli-entry.mjs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return (
    typeof entryPath === 'string' &&
    /(?:^|[\\/])posttooluse-tsc-verdict-stale-nudge\.mjs$/.test(entryPath)
  );
}

const invokedDirectly = isDirectCliInvocation();

function readStdin(timeoutMs) {
  return new Promise((resolveStdin) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolveStdin(data || '{}');
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** Walk up from a file to the repo root (the dir holding both .git and package.json). */
export function repoRootFor(filePath, { exists = existsSync } = {}) {
  if (!filePath || !isAbsolute(filePath)) return null;
  let dir = dirname(filePath);
  for (let i = 0; i < 40; i += 1) {
    if (exists(join(dir, '.git')) && exists(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function isTypecheckedFile(relPath) {
  if (!relPath || relPath.startsWith('..')) return false;
  return TS_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}

/**
 * The whole decision, as a pure function of injected IO so every branch is
 * testable without a repo, a clock, or a real edit.
 *
 * @returns {string|null} the advisory text, or null to stay silent
 */
export function staleVerdictNudge({
  filePath,
  root,
  now,
  readMarker,
  readLedger,
  writeLedger,
}) {
  if (!root || !filePath) return null;

  const rel = relative(root, filePath);
  if (!isTypecheckedFile(rel)) return null;

  const marker = readMarker();
  // No standing verdict at all — there is nothing to invalidate. This is the
  // common case for an agent who has not run lint:tsc yet, and it must be
  // silent: nudging here would teach the opposite of the lesson.
  if (!marker || typeof marker.atMs !== 'number' || !Number.isFinite(marker.atMs)) return null;

  // The edit must post-date the verdict. (Guard, not a formality: a marker
  // written by a run still in flight can legitimately be newer than an edit.)
  if (now <= marker.atMs) return null;
  if (now - marker.atMs > VERDICT_LIVE_WINDOW_MS) return null;

  const ledger = readLedger() ?? {};
  // A new lint:tsc run resets the ledger: re-running the check is what silences
  // the nudge, which is exactly the behaviour we want to reward.
  const notified = ledger.atMs === marker.atMs && Array.isArray(ledger.notified) ? ledger.notified : [];
  if (notified.includes(rel)) return null;

  const nextNotified = [...notified, rel];
  writeLedger({ atMs: marker.atMs, notified: nextNotified });

  const covered = Array.isArray(marker.files) && marker.files.length > 0 ? marker.files : null;
  // The re-run set is the union of what the verdict covered and everything
  // edited since — naming only the new file would bank the same partial
  // verdict one step further along.
  const rerunSet = [...new Set([...(covered ?? []), ...nextNotified])];

  const scopeLine = covered
    ? `covered ${covered.length} file(s): ${covered.join(', ')}`
    : `scope=${marker.scope ?? 'unknown'} (whole-project run)`;

  return [
    `⚠ STALE TYPECHECK VERDICT — \`${rel}\` was edited AFTER your last \`lint:tsc\` run.`,
    '',
    `That run started ${marker.at ?? 'unknown'} and ${scopeLine}.`,
    'It cannot have seen this edit, so the standing "clean" no longer describes the tree.',
    '',
    'This matters most in the loop that usually produces it: typecheck → run suites →',
    'edit a TEST file to fix a failure → suites green → done. A green vitest run carries',
    'ZERO type information (esbuild transforms, it never typechecks), so it cannot stand in',
    'for the verdict this edit just invalidated.',
    '',
    'Re-run the typecheck LAST, over the full changed set:',
    `  npm run lint:tsc -- --files=${rerunSet.join(',')}`,
    '',
    'Read LINT_TSC_RESULT status=clean (partial is NOT clean). Advisory only — nothing is blocked.',
  ].join('\n');
}

async function main() {
  let hook;
  try {
    hook = JSON.parse(await readStdin(250));
  } catch {
    process.exit(0);
  }

  try {
    const filePath = hook?.tool_input?.file_path ?? hook?.tool_input?.filePath ?? null;
    if (!filePath) process.exit(0);

    const root = repoRootFor(filePath);
    if (!root) process.exit(0);

    const markerRel = sessionScopedScratchRel('lint-tsc-last-run');
    const ledgerRel = sessionScopedScratchRel('lint-tsc-stale-nudge');
    // A plain/non-Papercusp process has no session-owned verdict. Never fall
    // back to the old repo-wide files: doing so reintroduces cross-agent
    // overwrites and lets a peer's run silence this session's warning.
    if (!markerRel || !ledgerRel) process.exit(0);

    const markerPath = resolve(root, markerRel);
    const ledgerPath = resolve(root, ledgerRel);

    const msg = staleVerdictNudge({
      filePath,
      root,
      now: Date.now(),
      readMarker: () => {
        try {
          return JSON.parse(readFileSync(markerPath, 'utf-8'));
        } catch {
          return null;
        }
      },
      readLedger: () => {
        try {
          return JSON.parse(readFileSync(ledgerPath, 'utf-8'));
        } catch {
          return null;
        }
      },
      writeLedger: (next) => {
        try {
          mkdirSync(dirname(ledgerPath), { recursive: true });
          writeFileSync(ledgerPath, JSON.stringify(next, null, 2) + '\n');
        } catch {
          /* advisory bookkeeping — never fail the edit */
        }
      },
    });

    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }),
      );
    }
  } catch {
    // Fail OPEN, always. A nudge is never worth breaking a write over.
  }
  process.exit(0);
}

async function selfTest() {
  const failures = [];
  const check = (name, ok) => {
    if (!ok) failures.push(name);
  };

  const NOW = 1_000_000_000;
  const base = {
    filePath: '/repo/packages/x/lib/a.test.ts',
    root: '/repo',
    now: NOW,
    readMarker: () => ({
      at: '2026-01-01T00:00:00.000Z',
      atMs: NOW - 60_000,
      scope: 'files',
      files: ['packages/x/lib/a.ts'],
    }),
    readLedger: () => null,
    writeLedger: () => {},
  };

  const fired = staleVerdictNudge({ ...base });
  check('fires when a TS file is edited after a standing verdict', fired !== null);
  check(
    'names the re-run command with the UNION of covered + newly edited',
    fired !== null &&
      fired.includes('--files=packages/x/lib/a.ts,packages/x/lib/a.test.ts'),
  );

  check(
    'silent when no verdict is standing',
    staleVerdictNudge({ ...base, readMarker: () => null }) === null,
  );
  check(
    'silent on a non-typechecked file',
    staleVerdictNudge({ ...base, filePath: '/repo/packages/x/lib/a.md' }) === null,
  );
  check(
    'silent when the edit PRE-dates the verdict',
    staleVerdictNudge({
      ...base,
      readMarker: () => ({ atMs: NOW + 60_000, files: ['packages/x/lib/a.ts'] }),
    }) === null,
  );
  check(
    'silent when the verdict is older than the live window (yesterday is not standing)',
    staleVerdictNudge({
      ...base,
      readMarker: () => ({ atMs: NOW - VERDICT_LIVE_WINDOW_MS - 1, files: ['packages/x/lib/a.ts'] }),
    }) === null,
  );
  check(
    'fires at most ONCE per file per verdict',
    staleVerdictNudge({
      ...base,
      readLedger: () => ({ atMs: NOW - 60_000, notified: ['packages/x/lib/a.test.ts'] }),
    }) === null,
  );
  check(
    're-fires after a NEW lint:tsc run resets the ledger',
    staleVerdictNudge({
      ...base,
      readLedger: () => ({ atMs: NOW - 999_999, notified: ['packages/x/lib/a.test.ts'] }),
    }) !== null,
  );
  check(
    'handles a whole-project verdict with no explicit file list',
    staleVerdictNudge({ ...base, readMarker: () => ({ atMs: NOW - 60_000, scope: 'all', files: null }) }) !==
      null,
  );
  check(
    'uses a session-owned marker path',
    sessionScopedScratchRel('lint-tsc-last-run', 'agent-a') ===
      join('.papercusp', 'scratch', 'lint-tsc-last-run.agent-a.json'),
  );
  check(
    'does not fall back to an unscoped marker without a session id',
    sessionScopedScratchRel('lint-tsc-last-run', '') === null,
  );
  check(
    'a malformed marker is treated as no verdict, not as a stale one',
    staleVerdictNudge({ ...base, readMarker: () => ({ atMs: 'nonsense' }) }) === null,
  );
  check('isTypecheckedFile rejects a path outside the root', !isTypecheckedFile('../elsewhere/a.ts'));

  if (failures.length) {
    console.error(
      `posttooluse-tsc-verdict-stale-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log('posttooluse-tsc-verdict-stale-nudge --self-test: all cases passed');
  process.exit(0);
}

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) await selfTest();
  else await main();
}
