#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-mock-cast-escape-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge when an edit ADDS a
// `as never` / `as any` cast that closes a vitest `.mock*(...)` call — i.e. when it
// raises the `lint:mock-cast-escape` ratchet (WI-37497, the durable half of WI-37495).
//
// THE TRAP THIS CLOSES IS NOT THE CAST — IT IS WHO PAYS FOR IT
//   `lint:mock-cast-escape` is a ratchet lint wired as a green-checkpoint leg. A ratchet
//   lint bites ONLY at the fleet gate, so the cost of adding one cast never lands on the
//   author: it lands, hours later, on whichever unrelated agent is waiting on a deploy.
//   Nothing in the edit loop can catch it either, and not by accident —
//     • `test:affected` cannot: this is not a test failure, and vitest does not typecheck.
//     • `lint:tsc` cannot: the cast is PRECISELY what makes the file typecheck.
//   So the count rises invisibly between burn-downs. Measured twice: burned 1121 -> 1061
//   on 2026-08-03 (EI-19452618085391226), back to 1113 six days later, where it became the
//   SOLE holder of a red gate and froze `main` — the 2026-08-09T13:59Z verdict on candidate
//   00376d971c read `GATE_HELD_BY count=1 entries=["lint:mock-cast-escape"]` with every
//   single test passing. A burn-down alone is empirically a ~6-day fix; this is the half
//   that makes the cost visible to the person actually choosing to pay it.
//
// WHY A HOOK RATHER THAN "RUN THE GUARD AFTERWARDS"
//   Same reason as posttooluse-required-field-strand-nudge.mjs: on this tree git-sync
//   commits the WHOLE working tree every few minutes, so a few minutes after you edit,
//   working-tree == HEAD and any after-the-fact diff is empty. The window in which the
//   pre-edit content is still recoverable is minutes wide. A PostToolUse hook runs
//   milliseconds after the write, when `git show HEAD:<file>` is still unambiguously the
//   PRE-edit content — the one moment the signal is both correct and actionable.
//
// ⚠ DELIBERATE DIVERGENCE FROM THE STRAND NUDGE — DO NOT "FIX" THIS TO MATCH IT
//   posttooluse-required-field-strand-nudge.mjs SKIPS a file with no HEAD version, because
//   a brand-new interface has no pre-existing construction sites and therefore cannot
//   strand anything. That reasoning does NOT carry over here: a brand-new test file full of
//   `as never` raises the count and reds the gate exactly like an edit to an existing file.
//   So a missing HEAD version is treated as before-count = 0, NOT as a skip. Copying the
//   sibling's skip would leave the single most likely breach path uncovered while looking
//   complete.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: the baseline tolerates
//     1076 of these and a deliberate `as never` is sometimes the right call. This reports a
//     delta and names the alternatives; it never renders a verdict.
//   - REUSES THE GUARD'S OWN MATCHER. `findMockCastEscapesInText` is dynamically imported
//     from scripts/check-mock-cast-escape.mjs, resolved off the edited file's own path (the
//     hook is INSTALLED to ~/.papercusp/hooks/cc/, detached from any repo, so a static
//     import is impossible). Re-implementing the regex here would fork it and drift — and
//     that drift is not hypothetical: a hand-grep on `as never|as unknown as` counts 7656
//     tree-wide against the guard's 1113, a DIFFERENT POPULATION entirely. The guard counts
//     only a trailing `as never`/`as any` inside a mock-install call, with strings and
//     comments masked. One matcher, one place, and a future widening propagates here free.
//   - SCOPED TO THE GUARD'S OWN FILE POPULATION: `.test.ts` / `.test.tsx` only, because
//     that is exactly what `listTestFiles()` scans. A cast anywhere else is not counted by
//     the ratchet, so nudging about it would be a false positive by construction.
//   - FIRES ONLY ON AN INCREASE. Refactors that move casts around, or remove them, are
//     silent. Only a net-new escape costs anyone anything.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an unresolvable
//     guard, a parse failure. A bug here must never disturb an edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure;
//     mirrors posttooluse-required-field-strand-nudge.mjs / pretooluse-secrets-guard.mjs.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Guard location, relative to the repo root — also how the root is identified. */
const GUARD_REL = join('scripts', 'check-mock-cast-escape.mjs');

/** Scanning two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/** At most this many NEW sites are listed; the count line always states the true total. */
const MAX_LISTED = 5;

// Run the hook ONLY when executed as a binary — never on import. Without this, importing
// the module (as the test suite does, to exercise nudgeFor against the REAL guard) runs
// main(), which waits on stdin and then calls process.exit(0), killing the vitest worker
// mid-run. Mirrors the sibling nudges' own `invokedDirectly` guard.
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

/**
 * True for a file the `lint:mock-cast-escape` ratchet actually counts. Mirrors
 * `listTestFiles()` in scripts/check-mock-cast-escape.mjs — keep the two in step.
 */
export function isCandidateFile(filePath) {
  return filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx');
}

/**
 * Walk up from the edited file until a directory contains the guard.
 * Returns the repo root, or null. Finding it also PROVES the guard exists,
 * so there is no separate existence check to drift out of sync.
 */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, GUARD_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The escapes present in `after` that are NOT accounted for by `before`, as a multiset
 * difference over the snippet text. Line numbers shift when anything above them moves, so
 * they cannot identify a site across two versions; the snippet can, and the multiset makes
 * repeated identical snippets come out right (N before, N+1 after => exactly one new).
 */
export function newEscapes(beforeFound, afterFound) {
  const remaining = new Map();
  for (const e of beforeFound) remaining.set(e.snippet, (remaining.get(e.snippet) || 0) + 1);
  const fresh = [];
  for (const e of afterFound) {
    const left = remaining.get(e.snippet) || 0;
    if (left > 0) remaining.set(e.snippet, left - 1);
    else fresh.push(e);
  }
  return fresh;
}

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, fresh, beforeCount, afterCount) {
  const delta = afterCount - beforeCount;
  const lines = [
    `⚠ NEW MOCK-CAST ESCAPE (+${delta}) — this raises the lint:mock-cast-escape ratchet.`,
    `  ${relPath}  (${beforeCount} → ${afterCount} in this file)`,
  ];
  for (const e of fresh.slice(0, MAX_LISTED)) {
    const snippet = e.snippet.length > 100 ? `${e.snippet.slice(0, 99)}…` : e.snippet;
    lines.push(`    • L${e.line} ${e.verb}(… as ${e.kind})  ${snippet}`);
  }
  if (fresh.length > MAX_LISTED) lines.push(`    … and ${fresh.length - MAX_LISTED} more`);
  lines.push(
    '',
    '  `as never` on a mock argument defeats the ONE check vi.mocked() exists to give you:',
    '  the installed value is no longer typechecked against the real signature, so when that',
    '  signature gains a required field this fixture goes stale INVISIBLY and fails at runtime',
    '  in a file your change never touched.',
    '',
    '  Neither of your normal checks can see this: test:affected does not typecheck, and',
    '  lint:tsc passes BECAUSE of the cast. It surfaces at the fleet green-checkpoint — as a',
    '  red gate for whoever is next waiting on a deploy, hours from now.',
    '',
    '  Prefer, in order:',
    '    1. make the fixture genuinely typecheck (a factory returning the COMPLETE type, with',
    '       a `Partial<T>` override seam) — this removes the cast rather than relocating it;',
    '    2. the typed helpers in packages/operator-core/lib/testing/typed-mock.ts',
    '       (mockResolvedTyped / mockReturnTyped / mockImplementationTyped / …).',
    '',
    '  Check the gate leg you are moving:  node scripts/check-mock-cast-escape.mjs',
    '  Do NOT raise .mock-cast-escape-baseline.json — it is shrink-only; raising it needs',
    '  owner sign-off. Advisory: a deliberate cast is sometimes right, so this is a prompt to',
    '  reconsider, not a verdict.',
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
    loadFinder = defaultLoadFinder,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  // ⚠ A missing HEAD version means a BRAND-NEW test file, which can absolutely raise the
  // count — so it is before-text '' (count 0), never a skip. See the divergence note above.
  const beforeText = showHead(root, relPath) ?? '';
  const afterText = readFile(abs);
  if (beforeText === afterText) return null;

  const findEscapes = await loadFinder(root);
  if (!findEscapes) return null;

  const beforeFound = findEscapes(beforeText);
  const afterFound = findEscapes(afterText);
  if (afterFound.length <= beforeFound.length) return null;

  const fresh = newEscapes(beforeFound, afterFound);
  // Defensive: the count rose, so there is at least one unaccounted site. If the multiset
  // diff somehow disagrees, still report rather than swallow a real ratchet increase.
  if (!fresh.length) return formatNudge(relPath, afterFound.slice(0, 1), beforeFound.length, afterFound.length);
  return formatNudge(relPath, fresh, beforeFound.length, afterFound.length);
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
    return null; // new file, submodule path, detached/empty repo — treated as before-count 0
  }
}

async function defaultLoadFinder(root) {
  try {
    const mod = await import(`file://${join(root, GUARD_REL)}`);
    return typeof mod.findMockCastEscapesInText === 'function' ? mod.findMockCastEscapesInText : null;
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

  check('isCandidateFile accepts .test.ts', isCandidateFile('a/b.test.ts'));
  check('isCandidateFile accepts .test.tsx', isCandidateFile('a/b.test.tsx'));
  check('isCandidateFile rejects a plain .ts', !isCandidateFile('a/b.ts'));
  check('isCandidateFile rejects .d.ts', !isCandidateFile('a/b.d.ts'));

  // A stand-in finder: one escape per line containing the marker. Keeps the self-test
  // independent of the real guard (the vitest suite exercises the REAL one).
  const fakeFinder = (text) =>
    text
      .split('\n')
      .map((l, i) => ({ line: i + 1, verb: 'mockResolvedValue', kind: 'never', snippet: l.trim() }))
      .filter((e) => e.snippet.includes('as never'));
  const base = {
    exists: () => true,
    sizeOf: () => 10,
    loadFinder: async () => fakeFinder,
  };

  const added = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => 'm.mockResolvedValue(1 as never);',
    readFile: () => 'm.mockResolvedValue(1 as never);\nm.mockResolvedValue(2 as never);',
  });
  check('fires when an escape is added', !!added && added.includes('+1'));
  check('names the file counts', !!added && added.includes('1 → 2'));
  check('lists only the NEW site', !!added && added.includes('mockResolvedValue(2 as never)'));
  check('points at typed-mock', !!added && added.includes('typed-mock.ts'));
  check('warns against a baseline bump', !!added && added.includes('.mock-cast-escape-baseline.json'));

  // A brand-new file (no HEAD) still raises the count — must NOT be skipped.
  const brandNew = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'm.mockResolvedValue(1 as never);',
  });
  check('fires for a brand-new file with no HEAD version', !!brandNew && brandNew.includes('0 → 1'));

  // Removing an escape must be silent.
  const removed = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => 'm.mockResolvedValue(1 as never);\nm.mockResolvedValue(2 as never);',
    readFile: () => 'm.mockResolvedValue(1 as never);',
  });
  check('silent when an escape is removed', removed === null);

  // Same count, different placement (a refactor) must be silent.
  const moved = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => 'm.mockResolvedValue(1 as never);',
    readFile: () => '// reordered\nm.mockResolvedValue(1 as never);',
  });
  check('silent when the count is unchanged', moved === null);

  // Unchanged content never fires (the common case: an edit elsewhere in the file).
  const same = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => 'm.mockResolvedValue(1 as never);',
    readFile: () => 'm.mockResolvedValue(1 as never);',
  });
  check('silent when content is unchanged', same === null);

  // A non-test file short-circuits before any git work.
  const plain = await nudgeFor('/repo/x/a.ts', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => '',
  });
  check('skips a non-test file without touching git', plain === null);

  // An unresolvable guard must fail OPEN, not throw.
  const noGuard = await nudgeFor('/repo/x/a.test.ts', {
    ...base,
    showHead: () => '',
    readFile: () => 'm.mockResolvedValue(1 as never);',
    loadFinder: async () => null,
  });
  check('fails open when the guard cannot be loaded', noGuard === null);

  if (failures.length) {
    console.error(`posttooluse-mock-cast-escape-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-mock-cast-escape-nudge --self-test: all cases passed');
  process.exit(0);
}
