#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the required-field-strand
// trap (EI-19374535041074908, the class behind WI-6814's detector).
//
// THE TRAP
//   Adding a REQUIRED field to an exported interface instantly strands every
//   construction site of that type — in files your change never touched.
//   `test:affected` is type-blind and would not select them anyway, and a stale
//   fixture in a file whose tsc baseline already tolerates errors is invisible to
//   the ratchet too. So the first thing that reliably notices is the fleet
//   green-checkpoint, hours later, where it red-pins the gate for everyone.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-required-field-strands.mjs already answers this perfectly, and
//   its own header states the real gap: "finding the stranded sites is not the
//   hard part — tsc already does it perfectly. The hard part is KNOWING TO RUN
//   IT." Documentation did not close that gap: the class recurred 7× in ~48h
//   (WI-6867, EI-19340691974632497, EI-19331709872526777, EI-19332542096444388,
//   EI-19365056012137849, EI-19374026323028948, agent-facts/assumptions.test.ts),
//   each filed / claimed / fixed / closed one file at a time by a different agent.
//
//   Worse, running the CLI *later* does not work ON THIS TREE, and that is a
//   measured fact recorded in its own `formatNoFindings` docstring: git-sync
//   commits the whole tree on a schedule, so a few minutes after you edit,
//   working-tree == HEAD and the default `--base HEAD` diff is EMPTY. It printed
//   a green for a change that HAD added required field `ServeProgress.bytesIn`,
//   purely because git-sync had already swept it. So the author who remembers to
//   run it can still get a false clean bill — the window is minutes wide.
//
//   A PostToolUse hook closes exactly that: it runs milliseconds after the write,
//   when `git show HEAD:<file>` is still unambiguously the PRE-edit content, and
//   it reports to the AUTHOR while it is still their turn. That is the one moment
//   the signal is both correct and actionable.
//
// WHY THE PRESCRIBED COMMAND IS ANCHORED (EI-20097325488507587)
//   This hook used to prescribe the bare `npm run lint:required-field-strands:typecheck`,
//   which re-derives its own subject from `git diff HEAD` — a DIFFERENT comparison from
//   the one the hook just made, and one that decays within minutes. Measured: with the
//   author's file already swept into HEAD and one peer file left dirty, it printed
//   `✓ no required fields added to exported types (1 file(s) examined vs HEAD)` naming
//   only the peer's file, and exited 0 — a true statement about a file the author never
//   opened, standing in for the answer they asked for. The nudge fired correctly and
//   then handed over a verification that silently verified nothing.
//
//   So the command carries BOTH pins: `--base <the sha this hook diffed against>` and
//   `--files=<the file this hook observed>`. It therefore reproduces THIS hook's exact
//   comparison and keeps working after git-sync commits the edit. The same resolved ref
//   is used for the hook's own `git show`, so the two cannot drift apart even if a sweep
//   lands mid-hook. If the ref cannot be resolved we fall back to `--files=` alone, which
//   still cannot go falsely green: the detector reports NOT CHECKED (exit 2) when the
//   named file turns out byte-identical to the base.
//
// WHY THE COMMAND MUST BE BACKGROUNDED (EI-21590234510185238)
//   The --typecheck leg runs operator-core's full lint:tsc and queues behind pc-heavy.
//   Under fleet load it can take several minutes or exceed five minutes before it can
//   report anything. A foreground Bash call can therefore hit its timeout with no output,
//   which is not evidence that the check passed. The nudge names the managed background
//   route (`capability:bash { run_in_background: true }`) and its reader so the author can
//   wait for the real exit_code instead of losing the verdict to a foreground timeout.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: adding a
//     required field is usually CORRECT and usually accompanied by updated call
//     sites. This names the trigger and the command; it never renders a verdict.
//     Do NOT make a field optional to silence it — that reintroduces whatever
//     under-reporting the required field existed to prevent (the WI-6409 bug).
//   - REUSES the detector: `diffRequiredAdditions` is dynamically imported from
//     the repo resolved off the edited file's own path. The hook is INSTALLED to
//     ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible — but re-implementing the AST diff here would fork the logic and
//     drift. The hook stays a thin trigger; the analysis stays in ONE place.
//   - SKIPS a file with no HEAD version. A brand-new exported interface has no
//     pre-existing construction sites, so it cannot strand anything (mirrors the
//     CLI's own `status.startsWith('A')` skip). Also skips .d.ts (same as CLI).
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, a
//     submodule path `git show` cannot resolve, an unresolvable detector, a parse
//     failure. A bug here must never disturb an edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors pretooluse-secrets-guard.mjs / nul-byte-edit-guard.mjs.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-required-field-strands.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

// Run the hook ONLY when executed as a binary — never on import. Mirrors
// scripts/check-required-field-strands.mjs's own `invokedDirectly` guard.
// Without this, importing the module (as the test suite does, to exercise
// nudgeFor against the REAL detector) runs main(), which waits on stdin and
// then calls process.exit(0) — killing the vitest worker mid-run. Caught by
// this file's own tests: 10 passed, and the run still reported FAILED.
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

/** True for a source file that can declare an exported interface worth diffing. */
export function isCandidateFile(filePath) {
  if (!/\.tsx?$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists,
 * so there is no separate existence check to drift out of sync.
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
 * The advisory text for a set of findings. Exported so the test asserts the real string.
 *
 * `baseSha` is the ref this hook actually diffed against. Passing it turns the
 * prescribed command into a reproduction of THIS comparison rather than a fresh,
 * decaying one — see "WHY THE PRESCRIBED COMMAND IS ANCHORED" in the header.
 */
export function formatNudge(relPath, added, { baseSha = null } = {}) {
  const lines = [
    '⚠ REQUIRED-FIELD ADDITION — you may have just stranded construction sites you cannot see.',
    `  ${relPath}`,
  ];
  for (const a of added) {
    const how = a.reason === 'optional-to-required' ? 'optional → required' : 'new required field';
    lines.push(`    • ${a.path}  (${how})`);
  }
  lines.push(
    '',
    '  Every site constructing this type in OTHER files just went stale — including',
    '  files test:affected will not select and vitest cannot see. The first thing that',
    '  otherwise notices is the fleet green-checkpoint, hours from now, for everyone.',
    '',
  );
  if (baseSha) {
    lines.push(
      '  Confirm now — this reproduces the exact comparison this hook just made, and (unlike',
      '  the bare `npm run lint:required-field-strands`) stays correct after git-sync commits',
      '  your edit and drops it out of `git diff HEAD`:',
      `    node scripts/check-required-field-strands.mjs --typecheck --base ${baseSha} --files=${relPath}`,
    );
  } else {
    lines.push(
      '  Confirm now, while it is still your turn (--files pins YOUR file: without it this',
      '  goes green about peers’ files once git-sync commits your edit):',
      `    node scripts/check-required-field-strands.mjs --typecheck --files=${relPath}`,
    );
  }
  lines.push(
    '',
    '  This full check can queue behind pc-heavy for several minutes (and may exceed five',
    '  minutes under fleet load). Run the command above with',
    '  `capability:bash { run_in_background: true }` so a foreground Bash timeout cannot kill it.',
    '  Then read `capability:bash_output` and trust its `exit_code`; a launch or timeout',
    '  response is not a clean result.',
    '',
    '  Adding a required field is usually CORRECT — this is a prompt to verify, not a',
    '  verdict. Do NOT make the field optional to silence errors: that reintroduces the',
    '  under-reporting the required field exists to prevent.',
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
    loadDiffer = defaultLoadDiffer,
    resolveBase = defaultResolveBase,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  // Pin the ref ONCE, and use that same pin for the comparison below AND for the command
  // we prescribe. Resolving it separately would leave a window in which git-sync commits
  // between the two, so the command would name a base that already contains the edit and
  // report NOT CHECKED. Symbolic 'HEAD' is the fail-open fallback: it preserves the
  // pre-existing behaviour exactly, and only costs the anchoring in the prescription.
  const baseSha = resolveBase(root);
  const baseRef = baseSha ?? 'HEAD';
  // No version at the base => a new file => no pre-existing construction sites to strand.
  const beforeText = showHead(root, relPath, baseRef);
  if (beforeText === null) return null;

  const afterText = readFile(abs);
  if (beforeText === afterText) return null;

  const diffRequiredAdditions = await loadDiffer(root);
  if (!diffRequiredAdditions) return null;

  const added = diffRequiredAdditions(beforeText, afterText, relPath);
  if (!added || !added.length) return null;
  return formatNudge(relPath, added, { baseSha });
}

/**
 * The commit the working tree is being compared against — baked into the prescribed
 * command so it survives git-sync. Fails open to null (detached/empty repo, no git),
 * which degrades the prescription to `--files=` alone rather than losing the nudge.
 */
function defaultResolveBase(root) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function defaultShowHead(root, relPath, ref = 'HEAD') {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open
  }
}

async function defaultLoadDiffer(root) {
  try {
    const mod = await import(`file://${join(root, DETECTOR_REL)}`);
    return typeof mod.diffRequiredAdditions === 'function' ? mod.diffRequiredAdditions : null;
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

  check('isCandidateFile accepts .ts', isCandidateFile('a/b.ts'));
  check('isCandidateFile accepts .tsx', isCandidateFile('a/b.tsx'));
  check('isCandidateFile rejects .d.ts', !isCandidateFile('a/b.d.ts'));
  check('isCandidateFile rejects .mjs', !isCandidateFile('a/b.mjs'));

  const differ = (before, after) => {
    const had = /name: string/.test(before);
    const has = /name: string/.test(after);
    return !had && has ? [{ path: 'Foo.name', reason: 'added-required' }] : [];
  };
  const base = {
    exists: () => true,
    sizeOf: () => 10,
    loadDiffer: async () => differ,
  };

  // A required field appearing where there was none => nudge, naming the field.
  const hit = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string; name: string }',
    resolveBase: () => 'abc1234',
  });
  check('fires on a required-field addition', !!hit && hit.includes('Foo.name'));
  check('names the remediation command', !!hit && hit.includes('check-required-field-strands.mjs --typecheck'));
  // EI-20097325488507587: the command must be pinned to BOTH the base this hook diffed
  // against and the file it observed. Unpinned, it re-derives its own subject from
  // `git diff HEAD` and goes green about peers' files once git-sync sweeps the edit.
  check('pins the base commit it actually diffed against', !!hit && hit.includes('--base abc1234'));
  check('pins the file it observed', !!hit && hit.includes('--files=a.ts'));

  // The SAME pin must drive the comparison, or the prescribed command reproduces a
  // different diff than the one that produced the finding.
  let seenRef = null;
  await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: (_root, _rel, ref) => {
      seenRef = ref;
      return 'export interface Foo { id: string }';
    },
    readFile: () => 'export interface Foo { id: string; name: string }',
    resolveBase: () => 'deadbee',
  });
  check('diffs against the same ref it prescribes', seenRef === 'deadbee');

  // Unresolvable base => still never the unpinned form; --files= alone cannot go
  // falsely green (the detector reports NOT CHECKED when the file matches its base).
  const noBase = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string; name: string }',
    resolveBase: () => null,
  });
  check('degrades to --files= when the base cannot be resolved', !!noBase && noBase.includes('--files=a.ts'));
  check('never prescribes the unpinned form', !!noBase && !noBase.includes('npm run lint:required-field-strands:typecheck'));

  // Unchanged content must never fire (the common case: an edit elsewhere in the file).
  const same = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string }',
  });
  check('silent when content is unchanged', same === null);

  // No HEAD version => brand-new file => cannot strand anything.
  const brandNew = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'export interface Foo { id: string; name: string }',
  });
  check('silent for a file with no HEAD version', brandNew === null);

  // An unresolvable detector must fail OPEN, not throw.
  const noDetector = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string; name: string }',
    loadDiffer: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  // A non-candidate path short-circuits before any git/AST work.
  const dts = await nudgeFor('/repo/packages/x/a.d.ts', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => '',
  });
  check('skips .d.ts without touching git', dts === null);

  if (failures.length) {
    console.error(`posttooluse-required-field-strand-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-required-field-strand-nudge --self-test: all cases passed');
  process.exit(0);
}
