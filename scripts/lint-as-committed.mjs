#!/usr/bin/env node
/**
 * lint-as-committed.mjs — run a lint the way the RELEASE GATE runs it: the
 * COMMITTED detector over COMMITTED content, in a tree isolated from your edits.
 *
 * WHY THIS EXISTS (a real, observed wrong-instrument failure — EI-18672078222841101)
 * On 2026-07-26 three agents each "verified" a red `lint:identity-leak` gate leg by
 * running `npm run lint:no-owner-name-tags` FROM THE WORKING TREE and reported green.
 * At that moment a peer had an uncommitted refactor of `scripts/check-no-owner-name-tags.mjs`
 * plus an untracked `scripts/lib/identity-leak-patterns.mjs` sitting on disk. So the
 * command they ran executed a DIFFERENT DETECTOR than the one the gate runs. They
 * happened to get the right answer; the method could equally have produced a
 * confident wrong one — and a confident wrong "the gate leg is green" is worse than
 * no answer, because it retires the question.
 *
 * THE POINT IS NOT "the working tree is dirty". It is that `npm run lint:x` answers a
 * DIFFERENT QUESTION than the gate asks, and the two questions are indistinguishable
 * from the command line. The gate runs `npm run <lint>` with cwd set to its own
 * isolated checkout of a candidate commit (green-checkpoint.ts: `exec('npm', ['run',
 * <lint>], { cwd: cfg.checkpointRoot })`). BOTH axes come from the commit:
 *
 *     axis 1 — the DETECTOR: which version of the lint script executes
 *     axis 2 — the CONTENT:  which bytes it scans
 *
 * A working-tree run gets both axes wrong, silently. This tool gets both right, and
 * costs ~5 seconds — so the sound check is as cheap as the unsound one. That price
 * parity is the entire design goal: a correct method nobody reaches for because it is
 * expensive loses every time to a fast wrong one.
 *
 * WHY NOT THE OBVIOUS ALTERNATIVES
 *  - `git stash` then run: FORBIDDEN here and genuinely dangerous — this checkout is
 *    edited concurrently by the whole fleet and everyone's work sits unstaged, so a
 *    stash irrecoverably destroys peers' in-flight edits (see CLAUDE.md).
 *  - `git worktree`: the shared tree stays on `staging` by policy, and a worktree
 *    would still need its own node_modules.
 *  - Extracting only the lint script and running it against the working tree: fixes
 *    axis 1 and leaves axis 2 wrong. A half-fidelity check that PRESENTS as full is
 *    the same class of bug this tool exists to remove, so it is deliberately not an
 *    option here.
 *  - Reading `papercup-checkpoint/`: that is the gate's own tree — it is reset and
 *    cleaned out from under you on every run, and writing to it poisons the gate.
 *  - `git archive <ref> | tar -x` into a tmpdir: this was the first implementation and
 *    it DOES NOT WORK, for a reason worth recording. A tar extraction is not a git
 *    repository, and most of these lints enumerate their inputs with `git ls-files`
 *    (that is how they scan tracked content rather than node_modules). Every one of
 *    them died with "fatal: not a git repository". The gate's tree is a real CHECKOUT,
 *    so faithfully reproducing it requires a real repo, not just the right bytes.
 *
 * So: `git clone --local --shared --no-checkout` + `checkout --detach <ref>` into a
 * tmpdir. `--local --shared` means the clone borrows the source object store via
 * alternates instead of copying it, so this costs ~3s and almost no disk beyond the
 * checked-out files, and it touches the shared checkout only for reads. node_modules
 * is linked in (never copied or installed); missing workspace runtime exports are
 * built with each package's committed build command inside the disposable tree.
 *
 * The alternates borrow is safe for a run of this length but is a borrow: if the
 * source repo pruned the ref's objects mid-run the clone would break. It cannot
 * silently corrupt anything — git errors loudly — and the tree is disposable.
 *
 * THE SAME BUG HAS A TEST-SHAPED FACE (EI-19328... , 2026-08-02)
 * Everything above is written about lints, but the trap is not specific to them. On
 * 2026-08-02 an agent ran a failing gate test standalone via `testing:run`, saw it
 * PASS, and published "not reproducible => spy pollution / ordering effect, don't touch
 * the impl". It was passing because a peer's FIX was sitting UNCOMMITTED in the shared
 * working tree: `testing:run` (like `npm run test:file`) executes the WORKING TREE, so
 * the green was evidence of the peer's fix, not evidence of flakiness. The wrong
 * conclusion was shipped to the peer who was relying on it before being retracted.
 *
 * That is axis 1 and axis 2 again, wearing a test's clothes: which test file ran, and
 * which source it exercised. So `--` forwarding exists to make the sound check as cheap
 * as the unsound one for tests too:
 *
 *     npm run lint:as-committed -- test:file --any -- path/to/one.test.ts
 *
 * Before drawing ANY conclusion from a test run, name which of the three programs you
 * ran: the working tree, HEAD, or the gate's candidate. This tool answers for the
 * second (and, with --ref, the third).
 *
 * USAGE
 *   npm run lint:as-committed -- lint:no-owner-name-tags
 *   npm run lint:as-committed -- lint:no-owner-name-tags lint:no-identity-literals
 *   npm run lint:as-committed -- lint:tsc --ref=origin/staging
 *   npm run lint:as-committed -- lint:no-box-identity --keep   # keep the tree to poke at
 *   npm run lint:as-committed -- test:file --any -- a.test.ts  # run a TEST as committed
 *
 * FAIL-CLOSED BEHAVIOUR (the property that makes a green from this tool mean anything)
 *  - A script that does not exist AT THE REF is a hard FAILURE, never a skip. "It only
 *    exists in your working tree" is precisely the finding worth surfacing, and a tool
 *    that skipped it would report green for a lint it never ran.
 *  - The overall exit code is nonzero if ANY requested lint failed or could not run.
 *  - Detector drift (your copy of the lint script differs from the ref's) is reported
 *    explicitly, so you can see WHY a working-tree run disagreed with this one.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Child environment for commands executing against the isolated committed clone. */
export function lintAsCommittedChildEnv(environment = process.env, repoRoot = null) {
  const child = {
    ...environment,
    npm_config_workspaces: undefined,
    PAPERCUSP_LINT_AS_COMMITTED_CLONE: '1',
  };
  // Each immutable clone has a fresh tmp path. Keep resumable verdict storage
  // scoped to its source repository instead, separately from ordinary/gate
  // caches. The affected runner still checks command and dependency contents.
  if (repoRoot && !child.AFFECTED_TASK_VERDICT_CACHE_PATH) {
    const scope = createHash('sha256').update(realpathSync(repoRoot)).digest('hex').slice(0, 16);
    child.AFFECTED_TASK_VERDICT_CACHE_PATH = join(
      homedir(), '.papercusp', 'cache',
      `papercusp-affected-passing-verdicts-v2-committed-${scope}.json`,
    );
  }
  return child;
}

/**
 * The Android producer is a separate sibling repository, rather than a gitlink.
 * Its source contract must read an identified committed blob even when the
 * candidate checkout lives under tmpdir. Keep the snapshot inside clone metadata
 * and reuse the release tooling's existing PAPERCUSP_MOBILE_ROOT override.
 */
export function materializeMobileSourceContract(repoRoot, workRoot, environment = process.env) {
  const requestedRoot = environment.PAPERCUSP_MOBILE_ROOT;
  const sourceRoot = requestedRoot || join(dirname(repoRoot), 'papercup-rust-mobile');
  if (!existsSync(sourceRoot)) {
    if (requestedRoot) throw new Error(`lint-as-committed: explicit mobile source root is missing: ${sourceRoot}`);
    return null;
  }
  const sourcePath = 'tools/build-scripts/build-android.sh';
  // A test may launch another committed-source check. Its inherited override
  // points at our snapshot, which is metadata, not a second Git checkout.
  // Re-read the recorded commit from the original repository; do not substitute
  // its newer HEAD or accept the snapshot's loose file as committed source.
  const priorProvenancePath = join(sourceRoot, 'source-provenance.json');
  const prior = existsSync(priorProvenancePath)
    ? JSON.parse(readFileSync(priorProvenancePath, 'utf8'))
    : null;
  if (prior && (prior.schemaVersion !== 1 || typeof prior.sourceRepoRoot !== 'string'
    || !/^[0-9a-f]{40}$/.test(prior.sourceCommit)
    || !Array.isArray(prior.paths) || !prior.paths.includes(sourcePath))) {
    throw new Error('lint-as-committed: invalid mobile source snapshot provenance');
  }
  const sourceRepoRoot = prior?.sourceRepoRoot ?? git(['rev-parse', '--show-toplevel'], sourceRoot);
  const sourceCommit = git(['rev-parse', '--verify', `${prior?.sourceCommit ?? 'HEAD'}^{commit}`], sourceRepoRoot);
  const content = gitShowOrNull(sourceRepoRoot, `${sourceCommit}:${sourcePath}`);
  if (content === null) {
    throw new Error(`lint-as-committed: mobile source contract ${sourcePath} is absent at ${sourceCommit}`);
  }
  const root = join(workRoot, '.git', 'mobile-source-contract');
  mkdirSync(join(root, dirname(sourcePath)), { recursive: true });
  writeFileSync(join(root, sourcePath), content);
  const provenance = { schemaVersion: 1, sourceRepoRoot, sourceCommit, paths: [sourcePath] };
  writeFileSync(join(root, 'source-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return { root, ...provenance };
}

/* ─────────────────────── extracted-tree lifecycle (WI-10005705) ─────────────────────── */

/**
 * Every run extracts a ~1.4 GB tree under tmpdir. Measured 2026-10-03: 26 of them sat in
 * /tmp (~36 GB), 24 with no live process inside, and they refilled the root disk at
 * 2-5 per hour. Three ways a tree outlives its run: `--keep` (the testing:evidence
 * re-prove recipe asks for it, then nobody deletes it), a `process.exit` inside the try
 * (exit skips `finally`), and a signal kill. The first two are handled in `main`; the
 * sweep below is what catches the rest, including SIGKILL, on the NEXT run.
 *
 * Each tree records its owner in `<tree>/.git/lint-as-committed-owner.json` (inside .git
 * so the extracted repo's `git status` stays clean for the lints that read it).
 */
export const WORK_ROOT_PREFIX = 'papercusp-lint-as-committed-';
export const OWNER_MARKER = join('.git', 'lint-as-committed-owner.json');
/** A `--keep` tree is for poking at, then re-proving from: six hours is generous. */
export const KEEP_TTL_MS = 6 * 3600_000;
/** Absolute ceiling for any tree no live process is inside (covers pid reuse). */
export const MAX_AGE_MS = 24 * 3600_000;
/**
 * WI-10005934: the TTL alone does not bound disk. The re-prove recipe passes `--keep`
 * 2-5 times an hour and nobody deletes the tree after its follow-up testing:run, so a
 * 6h TTL held ~27 idle trees (~37 GB) on root. Only the newest few idle kept trees are
 * worth keeping; a tree with a live process inside is never counted or removed.
 */
export const MAX_IDLE_KEPT_TREES = 4;

/**
 * Decide one tree's fate. Pure: the caller supplies liveness facts.
 * - `inUse`: some live process has its cwd inside the tree (e.g. a testing:run on the
 *   clone's test path). Never removed, whatever its age.
 * - `marker`: parsed owner marker, or null (pre-marker tree, or a run still cloning).
 * - `ownerAlive`: whether `marker.pid` is a live process (ignored without a marker).
 * - `ageMs`: from `marker.createdAtMs`, else from the directory mtime.
 */
export function classifyWorkRoot({ inUse, marker, ownerAlive, ageMs, keepTtlMs = KEEP_TTL_MS, maxAgeMs = MAX_AGE_MS }) {
  if (inUse) return { remove: false, reason: 'in-use' };
  if (!(ageMs >= 0)) return { remove: false, reason: 'age-unknown' };
  if (ageMs > maxAgeMs) return { remove: true, reason: 'max-age' };
  if (!marker) return ageMs > keepTtlMs ? { remove: true, reason: 'unmarked-expired' } : { remove: false, reason: 'unmarked-young' };
  if (marker.keep) return ageMs > keepTtlMs ? { remove: true, reason: 'keep-expired' } : { remove: false, reason: 'keep-young' };
  return ownerAlive ? { remove: false, reason: 'owner-alive' } : { remove: true, reason: 'owner-dead' };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** Absolute cwds of every visible process, or null where /proc is unavailable. */
function liveProcessCwds() {
  let pids;
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  const cwds = [];
  for (const pid of pids) {
    try {
      cwds.push(readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      /* exited, or not ours to read */
    }
  }
  return cwds;
}

/**
 * Remove stale extracted trees under `root`. Returns what it did, for the caller to print.
 * Without /proc it cannot prove a tree is idle, so it only removes trees whose marker
 * names a dead non-keep owner — the one verdict that needs no cwd scan.
 */
export function sweepStaleWorkRoots({ root = tmpdir(), nowMs = Date.now(), cwds = liveProcessCwds(), isAlive = pidAlive, remove = (p) => rmSync(p, { recursive: true, force: true }), maxIdleKept = MAX_IDLE_KEPT_TREES } = {}) {
  const removed = [];
  const kept = [];
  const idleKept = [];
  const tryRemove = (name, path, reason) => {
    try {
      remove(path);
      removed.push({ name, reason });
    } catch {
      kept.push({ name, reason: 'remove-failed' });
    }
  };
  let names;
  try {
    names = readdirSync(root).filter((n) => n.startsWith(WORK_ROOT_PREFIX));
  } catch {
    return { removed, kept };
  }
  for (const name of names) {
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let marker = null;
    try {
      marker = JSON.parse(readFileSync(join(path, OWNER_MARKER), 'utf8'));
    } catch {
      marker = null;
    }
    const inUse = cwds === null ? null : cwds.some((c) => c === path || c.startsWith(path + sep));
    const createdAtMs = Number.isFinite(marker?.createdAtMs) ? marker.createdAtMs : st.mtimeMs;
    const ownerAlive = marker ? isAlive(marker.pid) : false;
    const verdict = classifyWorkRoot({ inUse: inUse === true, marker, ownerAlive, ageMs: nowMs - createdAtMs });
    // A dead non-keep owner is proof the tree is abandoned whatever its age; anything else
    // needs the cwd scan to rule out a process still working inside it.
    const ownerDead = marker !== null && !marker.keep && !ownerAlive;
    const provable = inUse !== null || ownerDead;
    if (verdict.remove && provable) {
      tryRemove(name, path, verdict.reason);
    } else if (verdict.reason === 'keep-young' && inUse === false) {
      // Idle only when the cwd scan ran and found nobody inside (inUse === false, not null).
      idleKept.push({ name, path, createdAtMs });
    } else {
      kept.push({ name, reason: verdict.remove ? 'unprovable-without-proc' : verdict.reason });
    }
  }
  idleKept.sort((a, b) => b.createdAtMs - a.createdAtMs);
  idleKept.forEach(({ name, path }, i) => {
    if (i < maxIdleKept) kept.push({ name, reason: 'keep-young' });
    else tryRemove(name, path, 'keep-over-cap');
  });
  return { removed, kept };
}

/* ─────────────────────────── pure helpers (unit-tested) ─────────────────────────── */

/**
 * Parse argv. Script names are positional; everything else is a flag.
 *
 * The `lint:` prefix guard is not pedantry: this tool runs a command inside an
 * extracted tree with symlinked node_modules, which is a fine place to run a
 * read-only scanner and a bad place to run a build/migrate/deploy script. Requiring
 * `--any` makes the blast radius an explicit choice rather than a typo away.
 *
 * A bare `--` ends this tool's own arguments: everything after it is FORWARDED
 * verbatim to the npm script. That is what lets a script taking operands — above all
 * `test:file` — be run as committed:
 *
 *     npm run lint:as-committed -- test:file --any -- path/to/one.test.ts
 *
 * Forwarding to SEVERAL scripts at once is refused rather than guessed at (see
 * `forwardAmbiguous` below): one operand list cannot be meant for two different
 * scripts, and quietly passing it to both is how a run tests something nobody asked
 * for and reports green for it.
 */
export function parseArgs(argv) {
  const scripts = [];
  const forward = [];
  let ref = 'HEAD';
  let keep = false;
  let any = false;
  let sawSeparator = false;
  const unknown = [];

  for (const arg of argv) {
    if (sawSeparator) {
      forward.push(arg);
      continue;
    }
    if (arg === '--') sawSeparator = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--any') any = true;
    else if (arg.startsWith('--ref=')) ref = arg.slice('--ref='.length);
    else if (arg === '--help' || arg === '-h')
      return { help: true, scripts: [], forward: [], ref, keep, any, unknown };
    else if (arg.startsWith('-')) unknown.push(arg);
    else scripts.push(arg);
  }

  const nonLint = any ? [] : scripts.filter((s) => !s.startsWith('lint:'));
  // Self-recursion is a real footgun, not a hypothetical: `lint:as-committed` starts
  // with `lint:`, so a sweep over every lint:* script picks it up, and the inner run
  // (invoked with no script arguments) exits 2 on its own usage guard. That surfaces
  // as "FAIL lint:as-committed — exit 2", which reads exactly like a lint VIOLATION at
  // the ref rather than "this is a runner, not a lint". Name it instead of letting the
  // reader misdiagnose it.
  const selfRecursive = scripts.filter((s) => s === 'lint:as-committed');
  // One operand list, two scripts, is never a coherent request — and the failure mode
  // of guessing is silent: both scripts run, one of them against operands meant for the
  // other, and the summary reports on whatever came back. Refuse instead.
  const forwardAmbiguous = forward.length > 0 && scripts.length > 1;
  return { help: false, scripts, forward, ref, keep, any, unknown, nonLint, selfRecursive, forwardAmbiguous };
}

/**
 * Pull the detector file paths out of an npm script command, so we can report whether
 * YOUR copy of the lint differs from the ref's.
 *
 * Matches repo-relative .mjs/.ts/.js paths (`node scripts/check-x.mjs`,
 * `tsx apps/operator/scripts/check-y.mjs`, and multi-file commands like
 * `node scripts/test-files.mjs a.test.ts b.test.ts`). Intentionally ignores bare
 * binaries (`knip`, `vitest`) — those come from node_modules, which this tool does not
 * and cannot version against a git ref, and pretending otherwise would be a lie.
 */
export function detectorPathsFromCommand(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  const re = /(?:^|[\s'"=])((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|cjs|ts|tsx|js))(?=$|[\s'"])/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const p = m[1];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Parse a `.gitmodules` file's content into `[{ name, path, url }, ...]`.
 *
 * WHY THIS EXISTS (EI-21033860565861795 — the submodule-blindness bug)
 * `git clone --local --shared --no-checkout` + `checkout --detach` (the extraction
 * strategy this whole file is built on) materialises gitlinks as EMPTY directories —
 * it does not, and cannot without extra work, recurse into submodules. So a repo with
 * submodules (this one has 30+, e.g. `libs/papercusp`) gets a tree that is silently
 * MISSING every submodule's content, and a lint that resolves an import through one
 * (say, `libs/papercusp/libs/db/src/connection`) reports a fabricated TS2307 — a
 * regression the committed code does not actually have. That is axis 2 (content)
 * wrong in exactly the way this tool exists to prevent, just for a different reason
 * than the header's `git archive` story: this failure mode is silent, not loud —
 * there is no "fatal: not a git repository", just a wrong answer that looks like a
 * real one.
 *
 * A minimal INI-style parser is enough here: `.gitmodules` is git's own config
 * format, always `[submodule "name"]` headers with `key = value` lines under them.
 */
export function parseGitmodules(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (header) {
      current = { name: header[1], path: null, url: null };
      out.push(current);
      continue;
    }
    if (!current || line.startsWith('#') || line.startsWith(';')) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'path') current.path = value.trim();
    else if (key === 'url') current.url = value.trim();
  }
  // A `[submodule "x"]` stanza with no `path =` line is not a real submodule entry —
  // git itself ignores it. Filtering here keeps every caller from having to re-check.
  return out.filter((s) => s.path);
}

/**
 * Which clone-local `info/exclude` each linked `node_modules` path belongs in.
 *
 * WHY THIS EXISTS (WI-10004898): the extracted tree must be CLEAN to `git status`, because a
 * test run inside it records `worktree_dirty` from `git status --porcelain
 * --untracked-files=all`, and spec-evidence currentness rates every dirty run's `testRun`
 * dimension `unknown`. The linked node_modules made every extracted tree dirty: `.gitignore`
 * says `node_modules/`, and a trailing-slash pattern matches only a real DIRECTORY, so git
 * reports a node_modules SYMLINK as `?? node_modules`. The links are infrastructure this tool
 * adds, never committed content, so they are excluded in the clone's own `.git/info/exclude`.
 * Neither `.gitignore` nor the shared checkout is touched.
 *
 * A link inside a submodule must be excluded by THAT submodule's repository (the superproject
 * only sees the gitlink, which an untracked file inside it marks modified), so each path is
 * routed to the deepest submodule that contains it, else to the superproject (key `''`).
 * Returns `{ [repoRelativeRoot]: ['/<path relative to that repo>', ...] }`; anchored patterns
 * so an exclusion can never hide a same-named file elsewhere in the tree.
 */
export function planLinkExcludes(linkedPaths, submodulePaths) {
  const subs = [...new Set((Array.isArray(submodulePaths) ? submodulePaths : []).filter((p) => typeof p === 'string' && p))]
    .sort((a, b) => b.length - a.length);
  const plan = {};
  for (const rel of Array.isArray(linkedPaths) ? linkedPaths : []) {
    if (typeof rel !== 'string' || rel.length === 0) continue;
    const owner = subs.find((s) => rel.startsWith(`${s}/`)) ?? '';
    const inner = owner ? rel.slice(owner.length + 1) : rel;
    (plan[owner] ??= []).push(`/${inner}`);
  }
  return plan;
}

/** Git resolves metadata for both ordinary repositories and absorbed submodules. */
export function writeLinkExcludes(workRoot, excludePlan) {
  for (const [repoRel, patterns] of Object.entries(excludePlan)) {
    const repository = join(workRoot, repoRel);
    const excludePath = resolve(repository, git(['rev-parse', '--git-path', 'info/exclude'], repository));
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `\n# lint-as-committed: linked node_modules (WI-10004898)\n${patterns.join('\n')}\n`);
  }
}

/**
 * Where a symlinked `node_modules` entry should point INSIDE the extracted tree, or null when it
 * is not a workspace-package link (EI-24790229053787032).
 *
 * WHY: npm links each workspace package as a RELATIVE symlink (`node_modules/@papercusp/search ->
 * ../../libs/generic/search`). When the whole shared `node_modules` was symlinked into the
 * extracted tree, those relative links resolved against the SHARED checkout, so every
 * `@papercusp/*` import ran the working tree instead of the ref, beside the extracted tree's own
 * copy of the same files reached by relative import. Module-scoped state then split across the
 * two copies, with no error: measured on harness-doc-sections-sync R-29 (the search policy read
 * an embedder registry the test never stamped, so the semantic leg got no profile and returned
 * nothing) and carry-notes-no-unread-vector R-32 ("configureResourceProfile() called after the
 * profile was already detected"). Both passed in the shared tree at the same commit.
 *
 * `realTarget` is the entry's resolved real path. A target inside the shared checkout and outside
 * any `node_modules` is a workspace package; it maps to the same relative path under `workRoot`.
 */
export function cloneWorkspaceTarget(realTarget, repoRoot, workRoot) {
  if (typeof realTarget !== 'string' || typeof repoRoot !== 'string' || typeof workRoot !== 'string') return null;
  if (!realTarget || !repoRoot || !workRoot) return null;
  const rel = relative(repoRoot, realTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (rel.split(sep).includes('node_modules')) return null;
  return join(workRoot, rel);
}

/**
 * Build `cloneNm` as a REAL directory mirroring `sharedNm` entry by entry (EI-24790229053787032).
 * Installed packages have real directory shells with linked contents (nothing is installed or
 * copied). npm's graph reader cannot resolve a hoisted dependency of a package whose directory
 * is linked outside the tree, even though Node can: it reports that dependency missing and its
 * installed copy extraneous. Preserve package and nested node_modules directories for npm,
 * while runtime files still resolve to the shared install. A workspace-package link points at
 * the extracted tree's own package when that package
 * exists there (has a package.json). A workspace package absent from the extracted tree (an
 * uninitialised submodule) falls back to the shared target and is COUNTED, so the fallback is
 * visible rather than silent. Scope directories (`@x`) are mirrored one level down.
 * Returns `{ entries, remapped, fallback }`.
 */
export function linkNodeModulesShadow(sharedNm, cloneNm, repoRoot, workRoot, workspacePaths = new Set()) {
  const stats = { entries: 0, remapped: 0, fallback: 0 };
  const moduleAncestors = new Set();
  const linkPackage = (sharedPath, clonePath) => {
    mkdirSync(clonePath, { recursive: true });
    for (const child of readdirSync(sharedPath)) {
      const source = join(sharedPath, child);
      const target = join(clonePath, child);
      if (child === 'node_modules' && statSync(source).isDirectory()) mirrorModules(source, target);
      else symlinkSync(source, target);
    }
  };
  const linkEntry = (sharedPath, clonePath) => {
    let real = null;
    try {
      if (lstatSync(sharedPath).isSymbolicLink()) real = realpathSync(sharedPath);
    } catch {
      /* a dangling link stays a link to the shared path, exactly as before */
    }
    const remap = real ? cloneWorkspaceTarget(real, repoRoot, workRoot) : null;
    if (remap && existsSync(join(remap, 'package.json'))) {
      symlinkSync(remap, clonePath, 'dir');
      stats.remapped += 1;
      workspacePaths.add(remap);
    } else {
      if (remap) stats.fallback += 1;
      if (!remap && existsSync(join(sharedPath, 'package.json')) && statSync(sharedPath).isDirectory()) {
        linkPackage(sharedPath, clonePath);
      } else {
        symlinkSync(sharedPath, clonePath);
      }
    }
    stats.entries += 1;
  };
  const mirrorModules = (source, target) => {
    const identity = realpathSync(source);
    if (moduleAncestors.has(identity)) throw new Error(`cyclic installed node_modules: ${source}`);
    moduleAncestors.add(identity);
    try {
      mkdirSync(target, { recursive: true });
      for (const ent of readdirSync(source, { withFileTypes: true })) {
        // npm's mutable install cache describes the physical source topology, not this shadow.
        if (ent.name === '.package-lock.json') continue;
        const sharedPath = join(source, ent.name);
        const clonePath = join(target, ent.name);
        if (ent.name.startsWith('@') && statSync(sharedPath).isDirectory()) {
          mkdirSync(clonePath, { recursive: true });
          for (const sub of readdirSync(sharedPath)) linkEntry(join(sharedPath, sub), join(clonePath, sub));
        } else {
          linkEntry(sharedPath, clonePath);
        }
      }
    } finally {
      moduleAncestors.delete(identity);
    }
  };
  mirrorModules(sharedNm, cloneNm);
  return stats;
}

/** Runtime prerequisites belong to the pinned package, never the shared dist/assets. */
export function prepareWorkspaceExports(workRoot, workspacePaths, { prepareAssets = false } = {}) {
  for (const packageRoot of workspacePaths) {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const targets = new Set();
    const visit = (value, runtime = false) => {
      if (typeof value === 'string') {
        if (runtime) targets.add(value);
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item, runtime);
      } else if (value && typeof value === 'object') {
        for (const [condition, item] of Object.entries(value)) {
          if (condition !== 'types') visit(item, runtime || condition === 'require' || condition === 'default');
        }
      }
    };
    if (manifest.exports) visit(manifest.exports, typeof manifest.exports === 'string');
    else if (manifest.main) targets.add(manifest.main);
    // CLI packages can have no exports/main at all. Their committed build also
    // emits companion assets (for example the OMP native MCP adapter).
    for (const bin of Object.values(typeof manifest.bin === 'string' ? { bin: manifest.bin } : manifest.bin ?? {})) {
      if (typeof bin === 'string') targets.add(bin);
    }
    const concrete = [...targets].filter((target) => !target.includes('*'));
    for (const target of concrete) {
      const rel = relative(packageRoot, join(packageRoot, target));
      if (isAbsolute(target) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`${manifest.name}: runtime export escapes its pinned package: ${target}`);
      }
    }
    const missing = () => concrete.filter((target) => !existsSync(join(packageRoot, target)));
    const needsBuild = missing().length > 0;
    const assetLifecycle = prepareAssets && /\bsetup-[a-z0-9-]+-runtime\b/.test(manifest.scripts?.postinstall ?? '');
    if (!needsBuild && !assetLifecycle) continue;
    if (needsBuild && !manifest.scripts?.build) {
      throw new Error(`${manifest.name}: missing runtime export(s) ${missing().join(', ')} and no committed build script`);
    }
    for (const script of [...(needsBuild ? ['build'] : []), ...(assetLifecycle ? ['postinstall'] : [])]) {
      console.log(`  ${script === 'build' ? 'building pinned runtime exports' : 'preparing pinned runtime assets'}: ${manifest.name} (${relative(workRoot, packageRoot)})`);
      const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
        cwd: packageRoot,
        stdio: 'inherit',
        env: { ...process.env, npm_config_workspaces: undefined },
      });
      if (run.error || run.status !== 0) {
        throw new Error(`${manifest.name}: committed ${script} failed (${run.error?.message ?? `exit ${run.status}, signal ${run.signal}`})`);
      }
    }
    if (missing().length > 0) {
      throw new Error(`${manifest.name}: committed build did not emit runtime export(s): ${missing().join(', ')}`);
    }
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], packageRoot);
    if (dirty) throw new Error(`${manifest.name}: committed build changed source or emitted unignored files:\n${dirty}`);
  }
}

/**
 * Overall verdict. Nonzero if ANY lint failed OR could not be run.
 *
 * `missing` (absent at the ref) and `error` (the run itself blew up) MUST count as
 * failures. If they were skips, this tool would print a green summary for a lint it
 * never executed — reproducing, in a tool meant to prevent it, the exact
 * "confidently green without having asked the question" bug it was built for.
 */
export function summarize(results) {
  const failed = results.filter((r) => r.status !== 'pass');
  const lines = results.map((r) => {
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : r.status === 'missing' ? 'MISSING@REF' : 'ERROR';
    return `  ${mark.padEnd(11)} ${r.script}${r.note ? `  — ${r.note}` : ''}`;
  });
  return { exitCode: failed.length > 0 ? 1 : 0, failedCount: failed.length, lines };
}

/* ─────────────────────────────────── the CLI ─────────────────────────────────── */

const USAGE = `
lint-as-committed — run a lint as the release gate runs it (committed detector, committed content)

  npm run lint:as-committed -- <lint:script> [<lint:script>...] [--ref=<git-ref>] [--keep] [--any]
  npm run lint:as-committed -- <script> --any -- <args forwarded to the script>

  --ref=<git-ref>   which commit to test (default HEAD). e.g. --ref=origin/staging
  --keep            do not delete the extracted tree (path is printed)
  --any             allow a non-'lint:' npm script (blast-radius opt-in)
  --                everything after this is forwarded verbatim to the npm script
                    (only one script may be named when forwarding)

Why: 'npm run lint:x' runs YOUR detector over YOUR uncommitted content. The gate runs
the COMMITTED detector over COMMITTED content. Those are different questions.

The same holds for TESTS — 'npm run test:file' / testing:run execute the WORKING TREE,
so a green there can be a peer's uncommitted fix rather than a property of the code:
  npm run lint:as-committed -- test:file --any -- path/to/one.test.ts
`.trimStart();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitShowOrNull(cwd, spec) {
  try {
    return execFileSync('git', ['show', spec], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The submodule (by repo-relative path) that owns `path`, or null when the superproject does.
 * Deepest match wins, mirroring `planLinkExcludes`; nested submodules are resolved one level
 * at a time by `showAtRef` recursing into the owner's own repository.
 */
export function owningSubmodule(path, submodulePaths) {
  const subs = (Array.isArray(submodulePaths) ? submodulePaths : [])
    .filter((p) => typeof p === 'string' && p)
    .sort((a, b) => b.length - a.length);
  return subs.find((s) => path.startsWith(`${s}/`)) ?? null;
}

/**
 * Bytes of a path at a ref, or null if the path does not exist there.
 *
 * WI-10004908: `git show <ref>:<path>` never crosses a gitlink, so for a path inside a
 * submodule it reports "exists on disk, but not in <ref>" even though the materialised tree
 * contains the file. That made every submodule test operand (libs/generic/*, libs/papercusp/*)
 * fail the forwarded-operand check below as MISSING@REF. A path inside a submodule is
 * therefore read from THAT submodule's repository at the commit the superproject pins at
 * `ref` — the same bytes the submodule-init step materialises into the clone.
 */
export function showAtRef(repoRoot, ref, path) {
  const gitmodules = gitShowOrNull(repoRoot, `${ref}:.gitmodules`);
  const owner = owningSubmodule(path, parseGitmodules(gitmodules ?? '').map((s) => s.path));
  if (owner === null) return gitShowOrNull(repoRoot, `${ref}:${path}`);
  let pin;
  try {
    pin = git(['rev-parse', `${ref}:${owner}`], repoRoot);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(pin)) return null;
  const subRoot = join(repoRoot, owner);
  if (!existsSync(subRoot)) return null;
  return showAtRef(subRoot, pin, path.slice(owner.length + 1));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.scripts.length === 0) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (args.unknown.length > 0) {
    console.error(`lint-as-committed: unknown flag(s): ${args.unknown.join(', ')}\n`);
    process.stdout.write(USAGE);
    process.exit(2);
  }
  if (args.selfRecursive.length > 0) {
    console.error(
      `lint-as-committed: 'lint:as-committed' is this runner, not a lint — refusing to run it against itself.\n` +
        `  (It matches the lint:* prefix, so a sweep over every lint script picks it up; the inner run would\n` +
        `   exit 2 on its own usage guard and report as a FAIL, which reads like a violation at the ref.)\n` +
        `  Pass the lints you actually want checked.\n`,
    );
    process.exit(2);
  }
  if (args.forwardAmbiguous) {
    console.error(
      `lint-as-committed: refusing to forward arguments to ${args.scripts.length} scripts (${args.scripts.join(', ')}).\n` +
        `  Everything after '--' is one operand list; it cannot be meant for two different scripts.\n` +
        `  Name exactly one script when forwarding.\n`,
    );
    process.exit(2);
  }
  if (args.nonLint.length > 0) {
    console.error(
      `lint-as-committed: refusing to run non-lint script(s): ${args.nonLint.join(', ')}\n` +
        `  This tool extracts a tree and runs a command in it — safe for a read-only scanner,\n` +
        `  not for a build/migrate/deploy script. Pass --any if you really mean it.\n`,
    );
    process.exit(2);
  }

  let repoRoot;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    console.error('lint-as-committed: not inside a git repository.');
    process.exit(2);
  }

  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${args.ref}^{commit}`], repoRoot);
  } catch {
    console.error(`lint-as-committed: cannot resolve ref '${args.ref}'.`);
    process.exit(2);
  }

  const short = sha.slice(0, 10);
  // main is an independent source snapshot: clone normally leaves it under origin/.
  // Resolve before cloning, and never substitute the candidate when main is absent.
  let mainSnapshot = null;
  try {
    mainSnapshot = git(['rev-parse', '--verify', 'refs/heads/main^{commit}'], repoRoot);
  } catch {
    /* A repository without main must remain without a fabricated main. */
  }
  console.log(`lint-as-committed: ref ${args.ref} = ${short}`);
  console.log(`  repo: ${repoRoot}`);

  // The one thing worth saying out loud up front: this is NOT what you get from a
  // plain `npm run lint:x`, and the difference is the whole point.
  let dirtyTracked = 0;
  try {
    dirtyTracked = git(['diff', '--name-only', sha], repoRoot).split('\n').filter(Boolean).length;
  } catch {
    /* non-fatal */
  }
  if (dirtyTracked > 0) {
    console.log(`  note: your working tree differs from this ref in ${dirtyTracked} tracked file(s) — those edits are NOT under test here.`);
  }

  const swept = sweepStaleWorkRoots();
  if (swept.removed.length > 0) {
    console.log(`  swept ${swept.removed.length} stale extracted tree(s): ${swept.removed.map((r) => `${r.name} (${r.reason})`).join(', ')}`);
  }

  const workRoot = mkdtempSync(join(tmpdir(), `${WORK_ROOT_PREFIX}${short}-`));
  let results = [];
  // Every exit path must remove a non-keep tree: `process.exit` skips `finally`, and a
  // signal never reaches it. SIGKILL is left to the next run's sweep.
  const cleanupWorkRoot = () => {
    if (!args.keep) rmSync(workRoot, { recursive: true, force: true });
  };
  const bail = (code) => {
    cleanupWorkRoot();
    process.exit(code);
  };
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.once(signal, () => bail(128 + number));
  }

  try {
    // ── materialise the committed content as a REAL git repo ──
    // It must be a real repo, not just the right bytes: these lints enumerate their
    // inputs with `git ls-files`. See the header for the archive/tar attempt that died
    // on exactly this.
    const t0 = Date.now();
    const clone = spawnSync('git', ['clone', '--local', '--shared', '--no-checkout', '--quiet', repoRoot, workRoot], {
      encoding: 'utf8',
    });
    if (clone.status !== 0) {
      console.error(`lint-as-committed: failed to clone ${repoRoot}:\n${clone.stderr || clone.stdout}`);
      bail(2);
    }
    const checkout = spawnSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', sha], {
      cwd: workRoot,
      encoding: 'utf8',
    });
    if (checkout.status !== 0) {
      console.error(`lint-as-committed: failed to check out ${short}:\n${checkout.stderr || checkout.stdout}`);
      bail(2);
    }
    try {
      writeFileSync(join(workRoot, OWNER_MARKER), JSON.stringify({ pid: process.pid, keep: args.keep, createdAtMs: Date.now(), sha }));
    } catch {
      /* best-effort: an unmarked tree still ages out by mtime */
    }
    if (mainSnapshot) {
      git(['update-ref', 'refs/heads/main', mainSnapshot], workRoot);
      console.log(`  main snapshot: ${mainSnapshot} (independent of tested HEAD ${sha})`);
    }
    console.log(`  materialised committed tree in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${workRoot}`);

    // ── initialise submodules: a plain checkout leaves them as EMPTY gitlink dirs ──
    // Must run BEFORE the node_modules symlink step below: a submodule that is itself
    // an npm workspace (e.g. libs/papercusp) needs its real directory populated before
    // anything symlinks into it, and `git clone` refuses to clone into a non-empty
    // target — a node_modules symlink already sitting there would break it.
    //
    // DELIBERATELY NOT `git submodule update`: that goes through git's submodule
    // transport, which — since the CVE-2022-39253 hardening — refuses a `file`
    // transport for a submodule URL by default (`fatal: transport 'file' not
    // allowed`), even when the URL is one THIS SCRIPT constructed pointing at the
    // caller's own local checkout, not anything the untrusted commit specifies. That
    // restriction exists to stop a malicious commit's `.gitmodules` from making git
    // silently clone an attacker-chosen local path; loosening it globally to route
    // around that would reintroduce exactly the class of bug it fixes. So: skip the
    // submodule subsystem entirely and repeat the SAME plain `git clone --local
    // --shared --no-checkout` + `checkout --detach` recipe already used for the
    // superproject above, once per submodule — an ordinary top-level clone of a local
    // path, which git allows by default, and which needs no submodule config at all.
    const gitmodulesPath = join(workRoot, '.gitmodules');
    const submodules = existsSync(gitmodulesPath) ? parseGitmodules(readFileSync(gitmodulesPath, 'utf8')) : [];
    if (submodules.length > 0) {
      const t1 = Date.now();
      // Fail-closed BEFORE touching any submodule: if even one lacks a local checkout
      // to source from, the resulting tree would be silently incomplete for lints that
      // resolve imports through it (exactly the bug this section exists to fix), and
      // this isolated run has no SSH credentials to fetch it — a network attempt would
      // either fail or hang. Refuse with a diagnostic naming exactly what's missing,
      // per the header's fail-closed contract, rather than proceed on a partial tree.
      const unresolvable = submodules
        .filter((s) => !existsSync(join(repoRoot, s.path, '.git')))
        .map((s) => `${s.path}: no local checkout at ${join(repoRoot, s.path)} (would need a network clone of ${s.url})`);
      if (unresolvable.length > 0) {
        console.error(
          `lint-as-committed: cannot materialise ${unresolvable.length} submodule(s) at ${short} — refusing to run an incomplete tree:\n` +
            unresolvable.map((m) => `    - ${m}`).join('\n') +
            `\n  (This tool never fetches submodules over the network — that would either fail with no\n` +
            `   credentials or hang. Check out the submodule(s) locally first.)`,
        );
        bail(2);
      }

      for (const sub of submodules) {
        // The exact committed pin: `rev-parse <sha>:<path>` resolves a gitlink tree
        // entry to the pointed-at commit sha, the same way it resolves a blob entry
        // to its content sha. For `--ref=HEAD` (the default) this is literally the
        // commit the local checkout already has; for another ref it is reachable
        // through that checkout's own fetched history, since these are full,
        // continuously-synced local clones, not shallow ones.
        let pin;
        try {
          pin = git(['rev-parse', `${sha}:${sub.path}`], repoRoot);
        } catch (err) {
          console.error(`lint-as-committed: cannot resolve the pinned commit for submodule ${sub.path} at ${short}: ${err.message}`);
          bail(2);
        }

        const subLocal = join(repoRoot, sub.path);
        const subWork = join(workRoot, sub.path);
        const subClone = spawnSync('git', ['clone', '--local', '--shared', '--no-checkout', '--quiet', subLocal, subWork], {
          encoding: 'utf8',
        });
        if (subClone.status !== 0) {
          console.error(`lint-as-committed: failed to clone submodule ${sub.path} from its local checkout:\n${subClone.stderr || subClone.stdout}`);
          bail(2);
        }
        const subCheckout = spawnSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', pin], {
          cwd: subWork,
          encoding: 'utf8',
        });
        if (subCheckout.status !== 0) {
          console.error(
            `lint-as-committed: failed to check out submodule ${sub.path} at its pinned commit ${pin.slice(0, 10)}:\n${subCheckout.stderr || subCheckout.stdout}`,
          );
          bail(2);
        }
        // A standalone clone has the bytes but does not enroll the submodule in its
        // parent's recursive Git enumeration. Whole-tree guards would silently omit
        // those bytes despite a successful materialisation. Mark only this verified,
        // locally cloned pin active; no URL or network transport is enabled.
        git(['config', '--local', `submodule.${sub.name}.active`, 'true'], workRoot);
      }
      // WI-10006131: preserve submodule identity as well as its pinned bytes.
      // A standalone .git directory makes reporter root discovery stop inside the
      // submodule, producing doubled paths and submodule-relative ledger keys.
      // Absorption is local Git metadata only: it keeps each commit and alternates,
      // writes the normal .git/modules gitlinks, and performs no fetch or checkout.
      git(['submodule', 'absorbgitdirs', '--', ...submodules.map((sub) => sub.path)], workRoot);
      console.log(
        `  initialised ${submodules.length} submodule(s) from local checkouts in ${((Date.now() - t1) / 1000).toFixed(1)}s (no network)`,
      );
    }

    // ── symlink (never copy, never install) every node_modules the workspaces need ──
    // These are the ONE thing not versioned against the ref, and that is stated in the
    // header rather than papered over: a lint whose behaviour depends on a dependency
    // version is not made reproducible by this tool.
    let linked = 0;
    const linkedPaths = [];
    const shadow = { remapped: 0, fallback: 0 };
    const workspacePaths = new Set();
    const discoveredPackages = new Set();
    const nmDirs = spawnSync(
      'bash',
      ['-c', `find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*' 2>/dev/null`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const modulePaths = new Set((nmDirs.stdout || '').split('\n').map((s) => s.replace(/^\.\//, '').trim()).filter(Boolean));
    for (const rel of modulePaths) {
      const target = join(repoRoot, rel);
      const linkPath = join(workRoot, rel);
      if (existsSync(linkPath)) continue;
      try {
        mkdirSync(dirname(linkPath), { recursive: true });
      } catch {
        continue; /* a workspace absent at this ref simply has nowhere to link — fine */
      }
      try {
        // Entry-by-entry, so workspace packages resolve INTO this tree (EI-24790229053787032).
        const s = linkNodeModulesShadow(target, linkPath, repoRoot, workRoot, workspacePaths);
        shadow.remapped += s.remapped;
        shadow.fallback += s.fallback;
      } catch (err) {
        // Never leave a half-built directory: fall back to the whole-directory link, loudly,
        // because that link re-opens the shared-tree import escape for this location.
        rmSync(linkPath, { recursive: true, force: true });
        try {
          symlinkSync(target, linkPath, 'dir');
        } catch {
          continue;
        }
        console.warn(
          `  ⚠ ${rel}: per-entry link failed (${err instanceof Error ? err.message : String(err)}); ` +
            `linked the whole directory, so @papercusp/* imports there run the SHARED tree`,
        );
      }
      // The shallow inventory cannot see installs in deeper selected packages.
      // Follow the existing pinned-package set, including its resolution ancestors,
      // rather than scanning scratch trees or descending into installed dependencies.
      // Set iteration also visits the additional directories discovered here.
      for (const packageRoot of workspacePaths) {
        if (discoveredPackages.has(packageRoot)) continue;
        discoveredPackages.add(packageRoot);
        for (let owner = packageRoot; owner !== workRoot; owner = dirname(owner)) {
          const localModules = relative(workRoot, join(owner, 'node_modules'));
          const sourceModules = join(repoRoot, localModules);
          if (existsSync(sourceModules) && statSync(sourceModules).isDirectory()) {
            modulePaths.add(localModules);
          }
        }
      }
      linked += 1;
      linkedPaths.push(rel);
    }
    // Keep the extracted tree CLEAN to `git status` (WI-10004898, see planLinkExcludes):
    // a run inside it must be able to record worktree_dirty=false.
    const excludePlan = planLinkExcludes(linkedPaths, submodules.map((s) => s.path));
    writeLinkExcludes(workRoot, excludePlan);
    console.log(
      `  linked ${linked} node_modules dir(s) (not installed, not copied; excluded from git status); ` +
        `${shadow.remapped} workspace package link(s) resolve into this tree` +
        (shadow.fallback ? `, ${shadow.fallback} fell back to the SHARED tree (package absent here)` : ''),
    );
    try {
      prepareWorkspaceExports(workRoot, workspacePaths, { prepareAssets: args.any });
    } catch (err) {
      console.error(`lint-as-committed: workspace runtime prerequisites failed: ${err.message}`);
      process.exitCode = 2;
      return;
    }

    // ── read the COMMITTED package.json: the script DEFINITION is versioned too ──
    let refScripts = {};
    try {
      refScripts = JSON.parse(readFileSync(join(workRoot, 'package.json'), 'utf8')).scripts ?? {};
    } catch (err) {
      console.error(`lint-as-committed: cannot read package.json at ${short}: ${err.message}`);
      bail(2);
    }

    const childEnvironment = lintAsCommittedChildEnv(process.env, repoRoot);
    if (args.scripts.some((script) => script.startsWith('test:'))) {
      const mobileSource = materializeMobileSourceContract(repoRoot, workRoot, process.env);
      if (mobileSource) {
        childEnvironment.PAPERCUSP_MOBILE_ROOT = mobileSource.root;
        console.log(`  mobile producer source: ${mobileSource.sourceRepoRoot} @ ${mobileSource.sourceCommit} -> ${mobileSource.root}`);
      }
    }

    for (const script of args.scripts) {
      const command = refScripts[script];
      console.log(`\n─── ${script} ───`);

      if (!command) {
        console.log(`  MISSING at ${short}: this npm script does not exist in the committed package.json.`);
        console.log(`  That is a real finding, not a skip — a working-tree run of it tests something the gate cannot run.`);
        results.push({ script, status: 'missing', note: `not in package.json at ${short}` });
        continue;
      }
      console.log(`  committed command: ${command}`);
      if (args.forward.length > 0) console.log(`  forwarded args:    ${args.forward.join(' ')}`);

      // Detector drift: WHY a working-tree run may disagree with this one. Forwarded
      // operands (the test file you named) get the same treatment as the detector —
      // for `test:file` the operand IS the code under test, so its drift is the whole
      // answer to "did my green come from the commit or from someone's dirty edit?".
      const forwardedPaths = args.forward.filter((a) => !a.startsWith('-') && /\.[cm]?[jt]sx?$/.test(a));
      for (const p of [...detectorPathsFromCommand(command), ...forwardedPaths]) {
        const atRef = showAtRef(repoRoot, sha, p);
        const local = existsSync(join(repoRoot, p)) ? readFileSync(join(repoRoot, p), 'utf8') : null;
        if (atRef === null) console.log(`  detector ${p}: absent at ${short} (untracked locally?)`);
        else if (local === null) console.log(`  detector ${p}: present at ${short}, absent in your working tree`);
        else if (local !== atRef) console.log(`  detector ${p}: DIFFERS from your working tree — a local run executes different code`);
      }

      // A forwarded file that does not exist at the ref must stop the run, not be
      // handed to the script anyway. Running it would answer a question about a
      // DIFFERENT program than the one requested, and the tool's whole contract is that
      // a result names the program it came from. Fail-closed, same as MISSING@REF.
      const absentOperands = forwardedPaths.filter((p) => showAtRef(repoRoot, sha, p) === null);
      if (absentOperands.length > 0) {
        console.log(`  MISSING at ${short}: forwarded file(s) not present at this ref: ${absentOperands.join(', ')}`);
        console.log(`  Refusing to run — the result would describe a different program than you asked about.`);
        results.push({ script, status: 'missing', note: `operand(s) absent at ${short}: ${absentOperands.join(', ')}` });
        continue;
      }

      const run = spawnSync('npm', ['run', script, ...(args.forward.length > 0 ? ['--', ...args.forward] : [])], {
        cwd: workRoot,
        encoding: 'utf8',
        stdio: 'inherit',
        // Astro reads clone-specific Vite resolution from this marker. Keep Node's own
        // symlink resolution unchanged: --preserve-symlinks makes Node 25 reject remapped
        // workspace TypeScript imports under node_modules before lints can execute.
        env: childEnvironment,
      });

      if (run.error) {
        results.push({ script, status: 'error', note: run.error.message });
      } else if (run.status === 0) {
        results.push({ script, status: 'pass' });
      } else {
        results.push({ script, status: 'fail', note: `exit ${run.status}` });
      }
    }
  } finally {
    if (args.keep) console.log(`\n  --keep: extracted tree left at ${workRoot} (swept by a later run after ${KEEP_TTL_MS / 3600_000}h unless a process is inside it)`);
    else cleanupWorkRoot();
  }

  const { exitCode, failedCount, lines } = summarize(results);
  console.log(`\n═══ as committed at ${short} ═══`);
  for (const line of lines) console.log(line);
  console.log(
    failedCount === 0
      ? `\nAll ${results.length} check(s) pass AS COMMITTED at ${short}.`
      : `\n${failedCount} of ${results.length} check(s) did NOT pass as committed at ${short}.`,
  );
  // NOT process.exit(): the per-check `lines` loop above grows with the number of
  // checks and exit() does not drain an async pipe write, so piping this summary would
  // cut the very lines that say what failed. See scripts/check-undrained-stdout-exit.mjs.
  process.exitCode = exitCode;
}

/**
 * Only run when invoked directly. This module is imported by its unit test for the
 * pure exports above, and an import must never extract a tree or spawn npm. Keyed on
 * the process entry basename (not `import.meta.url`, which a bundler rewrites — see
 * the long note in check-conflict-markers.mjs for that landmine).
 */
export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  typeof entryPath === 'string' && /(?:^|[\\/])lint-as-committed\.mjs$/.test(entryPath);

if (isDirectCliInvocation()) {
  main();
}
