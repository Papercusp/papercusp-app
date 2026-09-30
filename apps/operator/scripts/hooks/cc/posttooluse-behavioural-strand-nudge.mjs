#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-behavioural-strand-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the BEHAVIOURAL cross-workspace
// strand trap (EI-20022235111425919, the class behind scripts/check-behavioural-strands.mjs).
//
// THE TRAP
//   Adding a CALL to an injected collaborator inside a shared lib changes HOW MANY TIMES
//   that seam is called. Rewriting a returned or persisted output PROPERTY can change its
//   runtime value while keeping the object shape and types identical. Every test in another
//   workspace that asserts on the call COUNT/ORDER or changed output value —
//   `toHaveBeenCalledTimes`, `callCount`, `.mock.calls`, exact `invocations.map(...).toEqual([...])`,
//   `expect(x).not.toHaveBeenCalled()`,
//   direct property reads, object matchers, `toHaveProperty`, or `assert.*` — is instantly
//   stranded, in files your change never touched.
//
//   This class is invisible to BOTH of the checks an author naturally runs:
//     - `lint:tsc` cannot see it. The types did not change; only a runtime count did.
//     - `test:affected` cannot select it. Its radius is the workspaces the changed PATHS
//       map into, and the stranded fixtures live in a DIFFERENT workspace.
//   So it is structurally invisible to the two instruments whose green the author reads as
//   "verified", and the first thing that reliably notices is the fleet green-checkpoint,
//   hours later, where it red-pins the gate for everyone.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   Same reasoning as the required-field sibling, and the commissioning item makes it
//   explicitly: finding the stranded sites is not the hard part — the hard part is KNOWING
//   TO RUN IT. Documentation alone did not close that gap for the required-field class,
//   which recurred 7x in ~48h, each instance filed / claimed / fixed / closed one file at a
//   time by a different agent. There is no reason to expect prose to fare better here, and
//   this class is strictly harder to notice: the required-field one at least surfaces in a
//   typecheck somewhere, whereas this one type-checks perfectly by construction.
//
//   Running the CLI *later* does not work on this tree either, and that is measured, not
//   assumed: git-sync commits the whole working tree on a schedule, so a few minutes after
//   an edit `--base HEAD` diffs against content that ALREADY CONTAINS the edit and the
//   comparison is empty. The detector refuses to call that green — it reports NOT CHECKED
//   (exit 2) — but the author has still lost the window.
//
//   A PostToolUse hook closes exactly that: it runs milliseconds after the write, when the
//   owning repo's HEAD is still unambiguously the PRE-edit content, and it reports to the
//   AUTHOR while it is still their turn. That is the one moment the signal is both correct
//   and actionable.
//
// WHY THE PRESCRIBED COMMAND IS ANCHORED (EI-20097325488507587, learned by the sibling)
//   The command carries BOTH pins: `--base <the sha this hook diffed against>` and
//   `--files=<the file this hook observed>`. It therefore reproduces THIS hook's exact
//   comparison and keeps working after git-sync commits the edit. The same resolved ref is
//   used for the hook's own `git show`, so the two cannot drift apart even if a sweep lands
//   mid-hook. Without the pins the author gets a true statement about somebody else's file
//   standing in for the answer they asked for.
//
// ⚠ WHY THIS HOOK MUST BE SUBMODULE-AWARE (the defect a copy of the sibling would have)
//   `libs/generic/*` and `libs/papercusp` are SUBMODULES, and they are not an edge case
//   here — they are this guard's whole trigger class (the commissioning item's title is
//   literally "a libs/generic change that adds a call"). A superproject `git show HEAD:<path>`
//   returns NOTHING for a submodule path: the superproject tracks a submodule as one
//   gitlink, so it answers "absent" for a file that is committed. The sibling hook's
//   showHead treats that null as "new file — nothing to strand" and fails open.
//
//   Copying it verbatim would therefore produce a hook that NEVER FIRES on exactly the
//   files it exists for, while looking correct and passing any test written on a
//   superproject fixture. So the owning repo is resolved per file, and both the `git show`
//   and the prescribed `--base` are asked of THAT repo. The routing is not re-implemented
//   here: `repoForPath` / `submodulePaths` are imported from the detector, because a
//   slightly-different second copy is the failure mode above wearing a different hat.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: adding a call is
//     usually CORRECT. This names the trigger and the command; it never renders a verdict.
//     Do NOT delete or loosen a downstream count assertion to silence it — that assertion
//     is load-bearing; if the new count is right, UPDATE it to the new count.
//   - REUSES the detector: `increasedSeams`, `changedSeamControlFlow`, `repoForPath` and `submodulePaths` are
//     dynamically imported from the repo resolved off the edited file's own path. The hook
//     is INSTALLED to ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible — but re-implementing the seam counting (a TS-AST walk) or the submodule
//     routing here would fork the logic and drift. The hook stays a thin trigger.
//   - SKIPS a file with no version at the base. A brand-new file has no pre-existing call
//     count, so it cannot strand an existing count assertion (mirrors the CLI's own skip).
//     Also skips .d.ts and test files (same as the CLI: a test is not a shared seam).
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an unresolvable
//     detector, a parse failure. A bug here must never disturb an edit that already
//     succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure;
//     mirrors pretooluse-secrets-guard.mjs / the required-field sibling.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-behavioural-strands.mjs');

/** Two full TS parses per fire; a file bigger than this is a bundle, not a hand-written seam. */
const MAX_BYTES = 400_000;

/** Mirrors the CLI's SOURCE_RE / TEST_RE / EXCLUDED_* — see isCandidateFile. */
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js|jsx)$/;
const EXCLUDED_DIR_RE = /(?:^|\/)(?:dist|build|node_modules|coverage|\.next|\.papercusp)\//;
const EXCLUDED_ROOT_RE = /^(?:papercup-release|papercup-checkpoint)\//;

/**
 * Run the hook ONLY when executed as a binary — never on import. Without this, importing
 * the module (as the test suite does, to exercise nudgeFor against the REAL detector) runs
 * main(), which waits on stdin and then calls process.exit(0) — killing the vitest worker
 * mid-run. The sibling hook's own tests caught exactly that: 10 passed, run reported FAILED.
 *
 * This is the BASENAME-PINNED form, not `resolve(argv[1]) === resolve(fileURLToPath(import.meta.url))`,
 * and not `isCliEntry` from operator-core. This file is INSTALLED VERBATIM to
 * ~/.papercusp/hooks/cc/ — detached from the repo and from node_modules — so it cannot
 * import the helper; and the import.meta.url comparison is a landmine once esbuild inlines
 * a module into the desktop sidecar, because every inlined module inherits the BUNDLE
 * entry's import.meta.url (EI-650 took embedded PG down that way).
 * `npm run lint:no-hand-rolled-cli-entry` enforces this choice.
 */
export function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])posttooluse-behavioural-strand-nudge\.mjs$/.test(entryPath);
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
 * True for a source file that can declare a shared seam worth diffing.
 *
 * Mirrors the CLI's own candidate filter (`SOURCE_RE && !TEST_RE && keepPath`). A TEST file
 * is excluded on purpose and is not an oversight: this guard is about a shared seam whose
 * call count OTHER workspaces assert on, and a test file is not something anyone injects.
 */
export function isCandidateFile(filePath) {
  const posix = String(filePath).split(sep).join('/');
  if (!SOURCE_RE.test(posix)) return false;
  if (posix.endsWith('.d.ts')) return false;
  if (TEST_RE.test(posix)) return false;
  if (EXCLUDED_DIR_RE.test(posix) || EXCLUDED_ROOT_RE.test(posix)) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists, so there is
 * no separate existence check to drift out of sync.
 *
 * Note this walks THROUGH a submodule to the superproject — which is correct and required:
 * the detector, the file enumeration and the `--files=` paths are all superproject-rooted.
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

/**
 * The advisory text for a set of seam increases. Exported so the test asserts the real string.
 *
 * `baseSha` is the ref this hook actually diffed against, in the file's OWNING repo. Passing
 * it turns the prescribed command into a reproduction of THIS comparison rather than a
 * fresh, decaying one — see "WHY THE PRESCRIBED COMMAND IS ANCHORED" in the header.
 */
export function formatNudge(relPath, seamsOrTriggers, { baseSha = null, submodule = null } = {}) {
  // Keep the old `(relPath, seams, opts)` shape for installed hooks and third-party callers;
  // the detector's value-aware form passes `{ seams, values }` as the second argument.
  const seams = Array.isArray(seamsOrTriggers) ? seamsOrTriggers : seamsOrTriggers?.seams ?? [];
  const controlFlow = Array.isArray(seamsOrTriggers) ? [] : seamsOrTriggers?.controlFlow ?? [];
  const values = Array.isArray(seamsOrTriggers) ? [] : seamsOrTriggers?.values ?? [];
  const hasCallTriggers = seams.length > 0;
  const hasControlFlowTriggers = controlFlow.length > 0;
  const hasValueTriggers = values.length > 0;
  const lines = [
    (hasCallTriggers || hasControlFlowTriggers) && hasValueTriggers
      ? '⚠ BEHAVIOURAL STRAND RISK — a seam call count and an output value changed; downstream assertions may be stale.'
      : hasControlFlowTriggers
        ? '⚠ CONTROL-FLOW STRAND RISK — a dependency call’s invocation eligibility changed; downstream invocation assertions may be stale.'
      : hasValueTriggers
        ? '⚠ OUTPUT-VALUE STRAND — you may have just changed a downstream runtime value contract you cannot see.'
        : '⚠ SEAM CALL-COUNT INCREASE — you may have just stranded call-count assertions you cannot see.',
    `  ${relPath}`,
  ];
  for (const s of seams) {
    lines.push(`    • ${s.seam}  (called ${s.before}× → ${s.after}×)`);
  }
  for (const change of controlFlow) {
    lines.push(`    • ${change.seam} in ${change.function}  (control-flow eligibility changed)`);
  }
  if (hasCallTriggers || hasControlFlowTriggers) {
    lines.push(
      '',
      '  Every test in ANOTHER workspace asserting on this dependency call’s count or exact',
      '  invocation sequence may now be stale — toHaveBeenCalledTimes, callCount, .mock.calls,',
      '  invocations.map(...).toEqual([...]), or not.toHaveBeenCalled.',
    );
  }
  if (hasValueTriggers) {
    lines.push(
      '',
      '  Every test in ANOTHER workspace asserting on a changed output PROPERTY may still encode',
      '  the old value — direct reads, element access, object matchers, toHaveProperty, assert.*.',
      '  The property name is the stable join key; the writer expression may have been rewritten.',
    );
    for (const value of values) {
      lines.push(`    • ${value.property}  (${value.before} → ${value.after})`);
    }
  }
  lines.push(
    '',
    '  Neither check you are about to run can see this runtime strand:',
    '    • lint:tsc  — the TYPES may be unchanged, so it can be clean.',
    '    • test:affected — its radius is the workspaces your changed PATHS map into; the',
    '      stranded fixtures are in a DIFFERENT one, so it will not select them.',
    '  The next thing that notices is the fleet green-checkpoint, hours from now, for everyone.',
    '',
  );
  if (baseSha) {
    const where = submodule ? ` (resolved in submodule ${submodule}, which owns this file)` : '';
    lines.push(
      '  Confirm now — this reproduces the exact comparison this hook just made, and (unlike',
      '  a bare `npm run lint:behavioural-strands`) stays correct after git-sync sweeps your',
      `  edit into HEAD and the default diff goes empty${where}:`,
      `    node scripts/check-behavioural-strands.mjs --base ${baseSha} --files=${relPath}`,
    );
  } else {
    lines.push(
      '  Confirm now, while it is still your turn (--files pins YOUR file; without it this',
      '  reports on peers’ files once git-sync commits your edit):',
      `    node scripts/check-behavioural-strands.mjs --files=${relPath}`,
    );
  }
  lines.push(
    '',
    '  Read the exit code, not the prose: 0 = checked, no strands · 1 = strands named ·',
    '  2 = NOT CHECKED (nothing was actually compared — that is not a clean bill).',
    '  The named set is a RANKING, not a boundary: the run prints both band sizes, and',
    '  `--wide` runs the full reachable band if the narrowed one looks wrong.',
    '',
  );
  if (hasCallTriggers || hasControlFlowTriggers) {
    lines.push(
      '  Adding a call is usually CORRECT — this is a prompt to verify, not a verdict. If a',
      '  downstream count assertion now fails, UPDATE it to the new count; do not delete or',
      '  loosen it, because that assertion is what makes the next such change detectable.',
    );
  }
  if (hasValueTriggers) {
    lines.push(
      '  A value rewrite may be intentional — this is a prompt to verify, not a verdict. Run',
      '  the named tests, then update the expectation only when the new runtime contract is right.',
    );
  }
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
    showAt = defaultShowAt,
    loadDetector = defaultLoadDetector,
    resolveBase = defaultResolveBase,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  // Re-check against the superproject-relative path: `isCandidateFile` above saw whatever
  // the tool reported (often absolute), so the dist/ and node_modules/ exclusions only
  // become meaningful once the path is repo-rooted.
  if (!isCandidateFile(relPath)) return null;

  const detector = await loadDetector(root);
  if (!detector) return null;

  // Ask every git question of the repo that OWNS the file — see the submodule note in the
  // header. This is the difference between a hook that fires on libs/generic/* and one that
  // silently never does.
  const { submodule, cwd, relPath: inRepo } = detector.repoForPath(relPath, detector.submodulePaths());

  // Pin the ref ONCE, and use that same pin for the comparison below AND for the command we
  // prescribe. Resolving it separately would leave a window in which git-sync commits
  // between the two, so the command would name a base that already contains the edit and
  // report NOT CHECKED. Symbolic 'HEAD' is the fail-open fallback.
  const baseSha = resolveBase(cwd);
  const baseRef = baseSha ?? 'HEAD';
  // No version at the base => a new file => no pre-existing count assertion to strand.
  const beforeText = showAt(cwd, inRepo, baseRef);
  if (beforeText === null) return null;

  const afterText = readFile(abs);
  if (beforeText === afterText) return null;

  const seams = detector.increasedSeams(beforeText, afterText, relPath) ?? [];
  const controlFlow = typeof detector.changedSeamControlFlow === 'function'
    ? detector.changedSeamControlFlow(beforeText, afterText, relPath) ?? []
    : [];
  const values = typeof detector.diffOutputValues === 'function'
    ? detector.diffOutputValues(beforeText, afterText, relPath) ?? []
    : [];
  if (!seams.length && !controlFlow.length && !values.length) return null;
  return formatNudge(relPath, { seams, controlFlow, values }, { baseSha, submodule });
}

/**
 * The commit the working tree is being compared against, IN THE OWNING REPO — baked into
 * the prescribed command so it survives git-sync. A submodule sha is legitimate as a
 * `--base`: the detector accepts a base that resolves in the superproject OR any submodule,
 * and routes each file to the repo the expression actually resolves in.
 *
 * Fails open to null (detached/empty repo, no git), which degrades the prescription to
 * `--files=` alone rather than losing the nudge.
 */
function defaultResolveBase(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function defaultShowAt(cwd, relPath, ref = 'HEAD') {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, detached/empty repo — all fail open
  }
}

async function defaultLoadDetector(root) {
  try {
    const mod = await import(`file://${join(root, DETECTOR_REL)}`);
    const ok =
      typeof mod.increasedSeams === 'function' &&
      typeof mod.repoForPath === 'function' &&
      typeof mod.submodulePaths === 'function';
    return ok ? mod : null;
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

// ── self-test ───────────────────────────────────────────────────────────────────────────
// Runs without git, without a repo and without the real detector: every seam is injected.
// The point is that the hook's own WIRING is self-consistent (candidate filter, owning-repo
// routing, base pinning, silence conditions) — the seam ANALYSIS is the detector's job and
// is tested against the real thing in the vitest suite.

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  const SEAMS = [{ seam: 'deps.emit', before: 1, after: 3 }];
  const fakeDetector = (calls = null) => ({
    increasedSeams: (before, after) => (before === after ? [] : SEAMS),
    changedSeamControlFlow: () => [],
    diffOutputValues: () => [],
    submodulePaths: () => ['libs/generic/search'],
    repoForPath: (file, subs) => {
      const hit = subs.find((s) => file === s || file.startsWith(`${s}/`));
      if (calls) calls.push(file);
      return hit
        ? { submodule: hit, cwd: `/repo/${hit}`, relPath: file.slice(hit.length + 1) }
        : { submodule: null, cwd: '/repo', relPath: file };
    },
  });
  // `exists` must be EXACT about where the detector lives. An `endsWith(DETECTOR_REL)`
  // fake reports a detector in every ancestor, so findRepoRoot stops at the first one and
  // every path in this file becomes relative to the wrong root — which is how the first
  // run of this self-test failed six assertions at once. Only /repo is a repo root.
  const DETECTOR_POSIX = DETECTOR_REL.split(sep).join('/');
  const DETECTOR_ABS = `/repo/${DETECTOR_POSIX}`;
  const fakeExists = (p) => {
    const s = String(p).split(sep).join('/');
    // The detector exists at EXACTLY one path. Every other candidate detector path must be
    // absent, or the walk stops in the first ancestor it probes.
    if (s.endsWith(`/${DETECTOR_POSIX}`)) return s === DETECTOR_ABS;
    return s.startsWith('/repo/');
  };
  const baseDeps = (over = {}) => ({
    exists: fakeExists,
    sizeOf: () => 100,
    readFile: () => 'after',
    showAt: () => 'before',
    resolveBase: () => 'abc1234',
    loadDetector: async () => fakeDetector(),
    ...over,
  });

  // FIRES on an ordinary superproject source file, and names the seam + the anchored command.
  const fired = await nudgeFor('/repo/packages/operator-core/lib/thing.ts', baseDeps());
  check('fires on a superproject source file', typeof fired === 'string');
  check('names the seam', fired?.includes('deps.emit'));
  check('names the transition', fired?.includes('1× → 3×'));
  check(
    'prescribes the anchored command',
    fired?.includes('--base abc1234 --files=packages/operator-core/lib/thing.ts'),
  );

  // ⚠ THE REGRESSION THIS HOOK EXISTS TO NOT HAVE: a submodule file must route to the
  // SUBMODULE's repo, not the superproject's. Assert the cwd actually handed to git.
  let seenCwd = null;
  const sub = await nudgeFor('/repo/libs/generic/search/src/hybrid.ts', {
    ...baseDeps(),
    showAt: (cwd, rel) => {
      seenCwd = { cwd, rel };
      return 'before';
    },
  });
  check('fires on a submodule file', typeof sub === 'string');
  check('asks git inside the submodule', seenCwd?.cwd === '/repo/libs/generic/search');
  check('asks for the submodule-relative path', seenCwd?.rel === 'src/hybrid.ts');
  check('--files= stays superproject-relative', sub?.includes('--files=libs/generic/search/src/hybrid.ts'));
  check('discloses which repo the base came from', sub?.includes('submodule libs/generic/search'));

  // The base pin used for `git show` is the SAME one prescribed — they cannot drift.
  let showRef = null;
  await nudgeFor('/repo/packages/x/a.ts', {
    ...baseDeps(),
    showAt: (_cwd, _rel, ref) => {
      showRef = ref;
      return 'before';
    },
  });
  check('diffs against the pinned sha, not symbolic HEAD', showRef === 'abc1234');

  // Unpinned fallback: no git => still nudges, with the --files-only form.
  const unpinned = await nudgeFor('/repo/packages/x/a.ts', baseDeps({ resolveBase: () => null }));
  check('still nudges when the base cannot be resolved', typeof unpinned === 'string');
  check('degrades to the --files-only form', unpinned?.includes('--files=packages/x/a.ts') && !unpinned.includes('--base'));

  // SILENT cases.
  const silent = async (label, path, over) => {
    check(label, (await nudgeFor(path, baseDeps(over))) === null);
  };
  await silent('silent when the file is unchanged at base', '/repo/packages/x/a.ts', { showAt: () => 'after' });
  await silent('silent for a new file (no version at base)', '/repo/packages/x/a.ts', { showAt: () => null });
  await silent('silent when no seam count increased', '/repo/packages/x/a.ts', {
    loadDetector: async () => ({ ...fakeDetector(), increasedSeams: () => [] }),
  });
  await silent('silent when the detector cannot be loaded', '/repo/packages/x/a.ts', {
    loadDetector: async () => null,
  });
  await silent('silent for an oversized file', '/repo/packages/x/a.ts', { sizeOf: () => MAX_BYTES + 1 });

  // Candidate filter — asserted directly, since these short-circuit before any dep runs.
  check('skips .d.ts', !isCandidateFile('packages/x/a.d.ts'));
  check('skips a test file', !isCandidateFile('packages/x/a.test.ts'));
  check('skips a spec file', !isCandidateFile('packages/x/a.spec.tsx'));
  check('skips node_modules', !isCandidateFile('packages/x/node_modules/y/a.ts'));
  check('skips dist', !isCandidateFile('packages/x/dist/a.ts'));
  check('skips the release checkout', !isCandidateFile('papercup-release/packages/x/a.ts'));
  check('skips non-TS', !isCandidateFile('packages/x/a.js'));
  check('accepts .mts', isCandidateFile('packages/x/a.mts'));
  check('accepts a submodule source file', isCandidateFile('libs/generic/search/src/hybrid.ts'));

  if (failures.length) {
    console.error(`self-test FAILED (${failures.length}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('self-test passed');
  process.exit(0);
}
