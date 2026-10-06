#!/usr/bin/env node
/**
 * check-no-unenrolled-detached-spawn.mjs — the task manager's build guard
 * (task-manager-no-escape-2026-07-27, P-016).
 *
 *   node scripts/check-no-unenrolled-detached-spawn.mjs
 *
 * ── WHAT IT POLICES, AND WHY NOT MORE ───────────────────────────────────────
 *
 * There are ~813 raw `spawn`/`exec` call sites in this tree. A guard over all of
 * them would need an allowlist so large it would be meaningless, and it would be
 * policing the wrong thing anyway: cgroup membership is INHERITED, so a short-lived
 * `git rev-parse` inside an already-confined process is already accounted for. What
 * actually needs naming is the ROOT of a subtree — a process launched to OUTLIVE
 * the call that made it (plan D-001).
 *
 * ── THE TRIGGER, AND WHY IT IS NOT `detached: true` ANY MORE (EI-19483245448673321)
 *
 * The original trigger was the literal text `detached: true`. That picked a property
 * CORRELATED with "outlives the call" rather than the property itself, and it was
 * blind in two measured ways (sized 2026-08-17 over 7,058 tracked files):
 *
 *   A. `detached: <non-literal>` was INVISIBLE. `/detached:\s*true/` cannot see
 *      `detached: detach` (green-checkpoint.ts:9289) or `detached: isPosix`
 *      (scratch-env.ts:200). Worse than a miss: the old predicate returned false at
 *      that regex BEFORE reaching the ALLOWLIST check, so scratch-env's allowlist
 *      entry was DECORATIVE — a maintainer read it as "judged and consciously
 *      exempted" when the file was never judged at all. An allowlist is evidence of
 *      what a guard was ASKED to ignore, never evidence of what it can SEE.
 *
 *   B. A `detached: false` child whose HANDLE IS PARKED on a module/class property
 *      outlives its call in every way that matters — it just does so inside the
 *      parent's cgroup, which is the exact hazard enrolment prevents. It never
 *      tripped the rule and never reached the allowlist either.
 *
 * So the trigger is now, on the AST:
 *   (1) a spawn/fork call whose options carry `detached` set to anything but the
 *       literal `false` — a strict superset of the old rule;
 *   (2) a spawn/fork call whose handle is STORED ON A PROPERTY (`state.child = c`,
 *       `this.proc = c`) — the statically-detectable form of "kept past the call"; and
 *   (3) a launch whose ARGV carries a SELF-DAEMONIZING flag (`--fork`, `--daemon`,
 *       `--daemonize`) — see C below.
 *
 *   C. A child that DAEMONIZES ITSELF presents NEITHER (1) nor (2), and was invisible
 *      twice over. The parent passes no `detached` (it never asked — the CHILD forks),
 *      and there is no handle worth parking (the one returned refers to a process that
 *      has already exited). Worse, such a site never reaches the ALLOWLIST check, so
 *      there is no allowlist entry to find and grepping for one is a FALSE-ABSENCE
 *      instrument: the escape looks deliberate when nothing decided it.
 *      Measured cost of the blind spot (WI-41043): `dbus-daemon --fork` in
 *      desktop/a11y-bus.ts leaked one daemon + 2 at-spi children per provisioned
 *      desktop, ~10/hour, reaching 115 host-wide with 14 leaders 77h old — entirely
 *      unseen by this guard, which is the defect WI-41108 fixes.
 *
 * Deliberately NOT a trigger: a handle merely RETURNED to the caller (9 measured
 * sites). An awaited caller is precisely the false-positive class the ALLOWLIST
 * header below already documents as category (2); hard-failing it would encode a
 * rule this file's own doc says is wrong.
 *
 * ── WHY AN AST AND NOT A WIDER REGEX ────────────────────────────────────────
 *
 * A text rule cannot answer "is this a spawn option?". `git-stats.ts:883` carries
 * `detached: live.branch === null && ...` on an unrelated DATA object in a file that
 * also calls spawn(); any widened text rule scores it an offender. The TS parse is
 * gated behind a cheap raw pre-filter, so ~160 call sites get parsed rather than
 * 7,058 files. Eight sibling guards already do exactly this.
 *
 * A file passes when it EITHER imports the task-manager enrolment surface
 * (`task-manager/managed-spawn` or `task-manager/enroll-sync`) OR carries an
 * explicit ALLOWLIST entry with a reason. New unenrolled spawns fail.
 *
 * The predicate is exported and unit-tested, so "fails on a new raw detached spawn"
 * is a durably verified property rather than green-on-a-clean-tree (the same
 * discipline check-no-raw-agent-spawn.mjs applies to its own bypass predicate).
 */
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Sites that legitimately spawn a detached process WITHOUT task-manager enrolment.
 * Every entry needs a reason. Shrinking this list is the point; growing it needs a
 * justification in review.
 */
export const ALLOWLIST = new Map([
  ['packages/operator-core/lib/harness/git-sync/run-git-sync.ts', 'detached ONLY for group cancellation of referenced, awaited local Git; processGroupLifetime proves helper exit before resolution and lease release (EI-24141765530574665)'],
  ['packages/operator-core/lib/sync/pot-git/storage.ts', 'runGitLocal: detached ONLY for group cancellation of referenced, awaited local Git; processGroupLifetime waitForExit proves the group exited before the promise settles (same shape as run-git-sync.ts; WI-10003582)'],
  ['packages/operator-core/lib/fleet/sidecar-exec-process.ts','governed execution owns the referenced command; detached ONLY for group cancellation, and processGroupLifetime proves helper exit before admission settlement (EI-24143584172308161)'],
  // ── detached ONLY for process-group kill of an AWAITED child ─────────────
  //
  // A third category the original guard did not anticipate, and its false-positive
  // class. `detached: true` has TWO distinct uses, and this guard's premise —
  // "detached means the process outlives the call" — only covers one of them:
  //
  //   (1) outlive the caller           -> must be enrolled (the guard's real target)
  //   (2) become a process-group LEADER so a timeout can `kill(-pid)` the whole
  //       tree instead of orphaning grandchildren -> the child is AWAITED and dies
  //       with the call. Nothing outlives anything; there is no subtree to keep
  //       addressable after the call returns, so a ledger row would be born and
  //       closed inside one tool invocation.
  //
  // bash-jobs.ts documents (2) explicitly (capability-bash-orphan-kill-2026-06-21)
  // and it is now the idiom for any tool that shells out with a timeout. Both
  // entries below are that shape: added after this guard landed, both awaited, both
  // group-killed on timeout. Enrolling them would add ledger churn with no
  // addressability gain.
  //
  // If a static way to separate (1) from (2) appears — an awaited `child` whose
  // promise resolves in the same function — the predicate should prefer it and
  // these two should come off the list.
  ['packages/operator-core/lib/agent-tools/testing/run.ts', 'detached ONLY to lead a process group so a timeout group-kills vitest; the child is awaited and dies with the call'],
  ['packages/operator-core/lib/agent-tools/build/typecheck.ts', 'detached ONLY to lead a process group so a timeout group-kills tsc; the child is awaited and dies with the call'],
  // Same category-(2) lifecycle: the closure worker is bounded by its request
  // deadline, terminated in `finally`, and awaited through exit before the
  // preflight settles. `detached` supplies only the POSIX group that cleanup kills.
  ['packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts', 'detached ONLY to let the request deadline kill the esbuild worker process group; testImportClosures terminates it in finally and awaits worker exit before the preflight settles'],
  ['packages/operator-core/lib/release/admission-fix-precheck.ts', 'detached ONLY to lead a process group so a timeout (or a stdout-holding grandchild after exit) group-kills the pre-check subtree; the child is awaited and dies with the call (WI-10004928 part 5)'],
  // Same category-(2) shape, verified first-hand (WI-10004340): each spawn site is inside
  // `await new Promise((resolve) => …)` that resolves on the child's `close`, and `detached`
  // exists only so the timeout can `process.kill(-child.pid, 'SIGTERM')` the whole replay /
  // record CLI group. Nothing outlives the awaiting call.
  ['scripts/agent-capacity/load-driver.ts', 'detached ONLY to lead a process group so the replay timeout group-kills the CLI; the child is awaited (Promise resolves on close) and dies with the call'],
  ['scripts/agent-capacity/record-session.ts', 'detached ONLY to lead a process group so the record timeout group-kills the CLI; the child is awaited (Promise resolves on close) and dies with the call'],
  ['libs/generic/deployment-driver/src/workspace-host-agent-authentication.ts', 'detached ONLY to lead the awaited agent probe process group; timeout and output-limit paths kill runuser plus its descendants, closing inherited pipes before the host initializer exits (EI-22527750869820737)'],
  // Surfaced for the FIRST time by the AST trigger: `detached: detach` at :9289, where
  // `const detach = opts.killProcessGroupOnTimeout === true`. The literal-text predicate
  // could not see a computed value, so this file had never been judged at all — it is in
  // neither the allowlist nor any enrolment import. Verified first-hand before adding:
  // the child is AWAITED (Promise + `settled` + resolve/reject) and detached ONLY so the
  // timeout can `process.kill(-child.pid)` the group (L9320-9337). Same shape, same reason
  // string, as the two entries above.
  ['apps/operator/lib/release/green-checkpoint.ts', 'detached ONLY to lead a process group so a timeout group-kills the leg; the child is awaited and dies with the call'],
  // Same category-(2) shape, verified first-hand before adding (WI-7319):
  // `runDependencyPrebuildCommand` returns a Promise that ALWAYS settles — `close` and
  // `error` both call finish(), and an idle/hard timeout calls terminate() which
  // SIGTERMs then SIGKILLs the group and finishes. `detached: true` exists solely so
  // `terminateProcessGroup` can `process.kill(-pid)` the whole tree instead of
  // orphaning grandchildren. Nothing outlives the call, so a ledger row would be born
  // and closed inside one invocation.
  ['packages/operator-core/lib/release/dependency-generation-prebuild.ts', 'detached ONLY to lead a process group so a timeout group-kills the prebuild; the child is awaited and dies with the call'],
  // Same category-(2) shape, verified first-hand before adding (WI-10002061).
  // `dumpWorkspace` wraps the spawn in a Promise with a `settled` flag and a single
  // `finalize()` that always resolve()s; `detached: dumpDetached` exists solely so
  // `terminateSpawnTree` can `process.kill(-child.pid)` the guard->pg_dump tree, and
  // FIVE paths call killDumpTree() before finalizing (PG_DUMP_TIMEOUT_MS watchdog, gz
  // error, out-stream error, gz.stdin EPIPE, dump.stdout EPIPE). The irony is the point:
  // this `detached` IS the WI-10000839 fix for an orphaned pg_dump grandchild that
  // inherited the guard flock and blocked the hourly recovery-point dump for hours —
  // i.e. the remedy for exactly the harm this guard exists to prevent.
  // NOTE: enrolment is not merely unnecessary here, it is architecturally UNAVAILABLE —
  // @papercusp/backup declares dependencies:{} and operator-core depends on IT (see
  // host-dump-coverage.ts:232), so importing the operator-core enrolment seam would
  // invert the layer graph. That constraint is real but secondary: category (2) would
  // not be enrolled even if the import were free.
  ['packages/backup/src/hook.ts', 'detached ONLY to lead a process group so the watchdog group-kills the guard->pg_dump tree; the child is awaited and dies with the call'],
  // Same category-(2) shape, verified first-hand before adding (WI-10002061): the option
  // is literally named `ownsProcessGroup`, the child is awaited behind a `settled` flag,
  // and `killTransport()` does `process.kill(-child.pid, 'SIGKILL')`. ssh launches gcloud
  // as its ProxyCommand, so without an isolated group a failure bound reaches only ssh
  // and orphans the proxy — the group is what makes the tree killable, not escapable.
  ['packages/operator-core/lib/workspace-host/gcp-iap-initialization-operations.ts', 'detached ONLY to lead a process group so a failure bound group-kills the ssh->gcloud proxy tree; the child is awaited and dies with the call'],

  // ── one-shot host/dev plumbing, not fleet work ───────────────────────────
  // NOTE: this file serves TWO shapes and only ONE of them is exempt. The HEADLESS
  // path (spawnHeadless) IS enrolled — it has no window, it is the largest agent
  // subtree on the box, and it is the EI-9748 population. The exemption covers only
  // spawnConsole, where a human's terminal WINDOW is the unit of control. Treating
  // the whole file as exempt was the original mistake and left 80 live fleet
  // members invisible; the import of task-manager/enroll-sync now clears the guard
  // for the file, so this entry is documentation rather than a live exemption.
  ['packages/operator-core/lib/console-spawn.ts', 'spawnConsole opens a desktop TERMINAL for a human (window is the unit of control); spawnHeadless IS enrolled'],
  ['packages/operator-core/lib/terminal-spawn.ts', 'same: a human-facing terminal window'],
  ['packages/operator-core/lib/harness-launch.ts', 'harness bring-up, supervised by the harness lifecycle rather than the task ledger'],
  ['packages/operator-core/lib/agent-tools/dev/restart.ts', 'restarts a systemd unit — already supervised by SUPERVISED_PROCESSES + unit-reconciler'],
  ['packages/operator-core/lib/harness/env-operator-launcher.ts', 'boots an operator; enrolling it in a ledger the operator itself owns would be circular'],
  ['apps/operator/bin/host-bootstrap.ts', 'runs BEFORE the operator (and therefore the ledger) exists'],

  // ── sidecars ─────────────────────────────────────────────────────────────
  // substrate-sidecar-spawn.ts USED to sit here as "ledger enrolment is a P-009
  // follow-up". P-009 landed (task-manager-no-escape-2026-07-27): it now calls
  // beginSyncEnrolment/completeSyncEnrolment/finishSyncEnrolment, so the guard
  // clears it on the import and the entry is gone rather than kept as dead
  // documentation. Deliberately NOT left in place: a stale exemption whose stated
  // reason has become false would silently re-cover the file if the enrolment were
  // ever removed — the D-012 lesson (an allowlist entry is scoped to the lifetime
  // semantics it actually describes, and a reviewer should read a no-longer-true
  // reason as a smell).
  //
  // The other three sidecars need no entry: spawner-sidecar goes through
  // managedSpawn, embed-sidecar spawns with detached:false (so it dies with the
  // operator and is cgroup-inherited per D-001, and this guard's predicate never
  // fires on it), and the inference gateway is a systemd-user unit the operator
  // does not spawn at all.

  // ── gym / bench harnesses: throwaway rigs, torn down by their own runner ──
  ['packages/operator-core/lib/gym/ab-run.ts', 'gym A/B rig: bounded, torn down by its own runner at the end of the cycle, never outlives it'],
  ['packages/operator-core/lib/gym/blueprint-cycle.ts', 'gym blueprint cycle: bounded rig torn down by its own runner when the cycle ends'],
  ['packages/operator-core/lib/gym/smoke.ts', 'gym smoke rig: own process group purely so teardown can kill the npx->node tree'],
  ['packages/operator-core/lib/gym/autoloop-cycle.ts', 'gym autoloop cycle: bounded rig torn down by its own runner'],
  ['packages/operator-core/lib/gym/wake-mode.ts', 'gym wake-mode rig: bounded, torn down by its own runner'],
  ['packages/operator-core/lib/behaviour-suite/runner-node.ts', 'behaviour-suite runner: a bounded test rig whose lifetime is the suite run itself'],
  ['packages/operator-core/lib/harness/routines/p2p-perf-actions.ts', 'p2p perf bench: a bounded advisory run, reaped by the routine that started it'],
  ['packages/operator-core/lib/harness/routines/cargo-test-action.ts', 'cargo test run: bounded by the test command, reaped by the routine that started it'],
  ['packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts', 'detached ONLY to lead a process group so the timeout group-kills bounded oddsmith npm/claude routines; runBounded waits for child close and reaps the group before resolving'],
  ['packages/operator-core/lib/harness/routines/project-history-refresh-action.ts', 'project-history refresh: detached ONLY to own a process group so the timeout can kill the whole bash-wrapper->tsx->node->ptool tree (runProjectHistoryGenerate.killTree, SIGTERM then SIGKILL) rather than the wrapper, which would orphan live ptool readers. Bounded by timeoutMs; same precedent as gitnexus-reindex-action.ts above'],
  ['packages/operator-core/lib/harness/routines/template-gym-runner.ts', 'template gym: detached ONLY to own a process group so the timeout can kill the awaited vitest tree; runProcess waits for close and reaps the group before returning'],
  ['scripts/affected-tests.mjs', 'affected-test task: detached ONLY to own a process group so the per-task watchdog reaps npm->shell->vitest->workers and closes captured pipes at the bound; the bounded runner waits for and owns the group'],
  ['libs/papercusp/packages/orchestrator/src/scratch-env.ts', 'scratch env for a throwaway harness; the harness lifecycle owns teardown, not the ledger'],
  ['tools/perf-test/wdio/wdio.conf.ts', 'wdio perf runner: detached ONLY to get a killable process GROUP so onComplete can reap the xvfb-run -> tauri-driver -> {WebKitWebDriver, Xvfb} tree instead of the wrapper shell (EI-18886600444441200). The group never outlives the run — reaped in onComplete AND on exit/SIGINT/SIGTERM/SIGHUP. Standalone test-runner config: the operator, and therefore the ledger, is not running in this process'],

  // ── release/deploy: detached BY DESIGN so it survives the operator restart ─
  ['packages/operator-core/lib/harness/routines/release-actions.ts', 'release cut must survive the operator restart it performs — a ledger row the operator owns cannot outlive it'],
  ['packages/operator-core/lib/endpoint-route/routes/admin/run.ts', 'admin-triggered script run, owned by the admin request that started it and killed with it'],

  // ── media/device pipelines: lifetime bound to a stream, not a task ───────
  ['packages/operator-core/lib/voice-node/screen-track/screen-capture-source.ts', 'capture pipeline bound to a live stream'],
  ['packages/operator-core/lib/deployment/frame-vnc.ts', 'VNC frame server bound to a display lease'],
  ['packages/operator-core/lib/inference-gateway/codex-cli-bridge.ts', 'inference bridge bound to a gateway session'],

  // wake-executor.ts USED to sit here as "delivers a wake to an already-enrolled
  // agent session". That was false for its `resume-headless` channel, which spawns
  // a NEW `claude/omp/codex … -p` process. The already-enrolled session had died,
  // which is why the wake resumed it at all. So every headless wake turn ran with
  // no ledger row, and on 2026-09-24 one of them became an invisible second process
  // on a live coord identity (WI-10002854). It now enrolls through
  // enroll-sync, so the guard clears the file on the import and the entry is gone,
  // same as substrate-sidecar-spawn.ts above.
]);

/**
 * Sites the WIDENED trigger newly finds that are real defects rather than legitimate
 * exemptions. Kept OUT of ALLOWLIST on purpose: that list means "this lifetime is not
 * ours to own", and diluting it with "we know, we haven't fixed it yet" is how an
 * allowlist becomes a rubber stamp (the D-012 lesson quoted above). Every entry needs
 * a tracking ref, and `main()` prints this list LOUDLY on every run — including a
 * clean one — so a parked defect cannot go quiet the way the old blind spot did.
 */
export const KNOWN_DEFECTS = new Map([
  // Deliberately EMPTY. Two entries have passed through and BOTH were fixed rather than
  // exempted, which is the outcome this map is supposed to produce — it is a holding
  // pen with a tracking ref, never a quiet retirement home.
  //
  // local-whisper-service.ts (WI-39563): the widened trigger caught it parking a
  // `detached: false` whisper-server in module-scope `state.child`. Now goes through
  // `managedSpawn`, so the enrolment-import check clears the file.
  //
  // desktop/a11y-bus.ts (WI-41108): the site that MOTIVATED trigger (3) — a
  // `dbus-daemon --fork` that self-daemonizes and so presents neither a `detached`
  // option nor a stored child handle. Now ENROLLED via `beginSyncEnrolment` +
  // `completeSyncEnrolment`, registering the forked daemon's own `--print-pid=1` PID,
  // with `finishSyncEnrolment` wired into its release handle. It enrols
  // `confine: false` ON PURPOSE (the same caller-side veto substrate-sidecar-spawn.ts
  // uses): the bus's lifetime is owned by the DISPLAY, not by the spawn client that
  // has already exited — see the long note at the spawn site for why confinement is
  // the wrong ownership claim here and what would have to be measured first. Note the
  // old entry's "is itself flag-gated (WI-6499)" caveat was already STALE when it was
  // written: WI-6844 graduated that flag out of DARK_FLAGS on 2026-08-02.
  //
  // The bar for a new entry: a real hazard AND a tracking ref. `main()` prints this
  // list LOUDLY on every run — including a clean one — so a parked defect cannot go
  // quiet the way the original blind spot did.
]);

/**
 * The enrolment PRIMITIVES themselves. They spawn, and they hand the handle back —
 * that is what enrolling something looks like from the inside. Without this, a
 * widened guard flags the fix as the defect.
 */
const SELF_EXCLUDED = new Set([
  'packages/operator-core/lib/task-manager/managed-spawn.ts',
  'packages/operator-core/lib/task-manager/enroll-sync.ts',
]);

const ENROLMENT_IMPORTS = [
  'task-manager/managed-spawn',
  'task-manager/enroll-sync',
  './managed-spawn',
  './enroll-sync',
];

/** A type-only import disappears at runtime and cannot enrol a spawned child. */
function hasEnrolmentEvidence(relPath, source) {
  const t = ts();
  const sf = t.createSourceFile(relPath, source, t.ScriptTarget.Latest, false, relPath.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!t.isImportDeclaration(stmt) || !t.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!ENROLMENT_IMPORTS.some((name) => stmt.moduleSpecifier.text.includes(name))) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name || (clause.namedBindings && !t.isNamedImports(clause.namedBindings))) return true;
    if (clause.namedBindings?.elements.some((element) => !element.isTypeOnly)) return true;
  }

  // A reusable core can receive the three runtime functions from its adapter.
  // Require both typed primitives and actual calls through the injected seam;
  // merely naming enroll-sync in an erased import must not clear the guard.
  const typed = new Set();
  const called = new Set();
  const visit = (node) => {
    if (t.isTypeQueryNode(node) && t.isIdentifier(node.exprName)) typed.add(node.exprName.text);
    if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      if (t.isPropertyAccessExpression(access.expression) && access.expression.name.text === 'enrollment') {
        called.add(access.name.text);
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return ['beginSyncEnrolment', 'completeSyncEnrolment', 'finishSyncEnrolment'].every((name) => typed.has(name))
    && ['begin', 'complete', 'finish'].every((name) => called.has(name));
}

/** Callee names treated as process launches. `spawnFn` is the repo's DI seam name. */
const SPAWN_CALLEES = new Set(['spawn', 'childSpawn', 'spawnFn', 'fork']);

/** Cheap RAW pre-filter: no spawn token in the raw bytes ⇒ no need to parse at all. */
const SPAWN_TOKEN = /\b(spawn|childSpawn|spawnFn|fork)\s*\(/;

/**
 * TRIGGER (3) — callees that launch a process SYNCHRONOUSLY. Deliberately absent from
 * SPAWN_CALLEES, and that absence is correct for (1)/(2): a sync launch blocks until
 * the child exits, so the child CANNOT outlive the call and there is nothing to enrol.
 * That premise has exactly one exception — a child that daemonizes ITSELF — so these
 * callees are admitted for trigger (3) ONLY, and only together with a daemonizing flag.
 *
 * Note `spawnSync(` does not match SPAWN_TOKEN (`spawn` must be followed by `(`), so
 * before this widening such a file was skipped by the raw pre-filter BEFORE any parse.
 * That is why a11y-bus.ts was invisible for two independent reasons, not one.
 *
 * Measured 2026-08-23 over 6,734 tracked non-test files: admitting these callees
 * UNCONDITIONALLY would put 121 files in front of a triage pass (spawnSync 34,
 * execFileSync 58, execFile 29); gated on the flag below it is exactly 1.
 */
const SYNC_LAUNCH_CALLEES = new Set(['spawnSync', 'execFileSync', 'execSync', 'execFile', 'exec']);

/**
 * Flags whose ONLY meaning is "detach from the caller and keep running".
 *
 * DELIBERATELY EXCLUDED — `--detach`, `-d`, `-D`, `-b`. They are ambiguous, and in THIS
 * tree the ambiguity dominates: all four `--detach` sites are `git checkout --detach`,
 * a ref operation that daemonizes nothing. A guard that cries wolf on `git checkout`
 * gets its findings rubber-stamped into ALLOWLIST — the D-012 failure this file already
 * warns about — so the narrow set is the load-bearing choice, not timidity.
 *
 * Known cost of that exclusion: a `docker run --detach` would NOT be caught. Widen this
 * by pairing a flag with its COMMAND (`docker` + `--detach`), never by adding the bare
 * ambiguous flag.
 */
const SELF_DAEMONIZING_FLAGS = new Set(['--fork', '--daemon', '--daemonize']);

/**
 * Cheap RAW pre-filter for trigger (3). Same MONOTONICITY contract as SPAWN_TOKEN: a
 * file with no daemonizing flag in its raw bytes cannot fire (3) in its AST, because
 * (3) requires one of these exact strings as a string literal.
 */
const DAEMONIZE_TOKEN = /--(fork|daemon|daemonize)\b/;

const require_ = createRequire(import.meta.url);
/** @type {any} */
let tsCache = null;
function ts() {
  if (!tsCache) tsCache = require_('typescript');
  return tsCache;
}

/**
 * PURE predicate: does this file spawn a detached process without enrolling it?
 *
 * Exported for the unit test — the guard's own correctness is a property that must
 * be verified, not assumed from a green run on a tree that happens to be clean.
 *
 * @param {string} relPath - Repo-relative path, as it appears in ALLOWLIST.
 * @param {string} source - The file's full source text.
 * @returns {boolean}
 */
export function isUnenrolledDetachedSpawn(relPath, source) {
  const { detachedNotFalse, storedOnProperty, selfDaemonizing } = spawnTriggers(relPath, source);
  if (!detachedNotFalse && !storedOnProperty && !selfDaemonizing) return false;
  // Inspect import declarations, not source substrings: comments and erased type
  // imports provide no runtime enrolment. A DI seam must call all three injected
  // lifecycle functions to qualify.
  if (hasEnrolmentEvidence(relPath, source)) return false;
  if (ALLOWLIST.has(relPath)) return false;
  return !KNOWN_DEFECTS.has(relPath);
}

/**
 * Which triggers a file fires, before any exemption is applied. Exported so `main()`
 * can say WHICH rule caught an offender — "detached" and "handle parked on a property"
 * want different fixes, and a guard that only says FAIL makes the reader re-derive that.
 *
 * @param {string} relPath - Repo-relative path.
 * @param {string} source - The file's full source text.
 * @returns {{ detachedNotFalse: boolean, storedOnProperty: boolean, selfDaemonizing: boolean }}
 */
export function spawnTriggers(relPath, source) {
  const none = { detachedNotFalse: false, storedOnProperty: false, selfDaemonizing: false };
  if (SELF_EXCLUDED.has(relPath)) return none;
  // Cheap RAW pre-filter. Gating the TS parse on a raw token is what keeps this
  // affordable: ~160 of 7,058 tracked files carry a spawn token, and an unconditional
  // parse of all of them costs minutes. The filter is MONOTONIC — a file with no spawn
  // token in its raw bytes cannot have a spawn CALL in its AST.
  if (!SPAWN_TOKEN.test(source) && !DAEMONIZE_TOKEN.test(source)) return none;

  const t = ts();
  const sf = t.createSourceFile(
    relPath,
    source,
    t.ScriptTarget.Latest,
    false,
    relPath.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS,
  );

  let detachedNotFalse = false;
  let storedOnProperty = false;
  /** TRIGGER (3), halves — see `selfDaemonizing` below for why both are file-level. */
  let hasLaunchCall = false;
  let hasDaemonizeFlag = false;
  /** identifiers bound to a spawn result: `const child = spawn(...)` */
  const spawnBound = new Set();
  /** identifiers used as the RHS of a property assignment: `state.child = child` */
  const parkedNames = new Set();

  /** Strip await/parens/`as`/`!` so `await spawn(...)` still reads as a spawn call. */
  const unwrap = (node) => {
    let n = node;
    while (
      t.isAwaitExpression(n) ||
      t.isParenthesizedExpression(n) ||
      t.isAsExpression(n) ||
      t.isNonNullExpression(n)
    ) {
      n = n.expression;
    }
    return n;
  };

  const isSpawnCall = (node) => {
    if (!t.isCallExpression(node)) return false;
    const e = node.expression;
    if (t.isIdentifier(e)) return SPAWN_CALLEES.has(e.text);
    if (t.isPropertyAccessExpression(e)) return SPAWN_CALLEES.has(e.name.text);
    return false;
  };

  // TRIGGER (1): `detached` present in an options object and NOT the literal `false`.
  // A computed value (`detached: detach`) and a shorthand (`{ detached }`) both count —
  // being unable to prove it false is exactly the case the old text rule silently passed.
  // A spread (`{ ...opts }`) is NOT counted: it is genuinely undecidable here, and
  // guessing would manufacture false positives across the whole tree.
  const detachedTrigger = (call) => {
    for (const arg of call.arguments) {
      if (!t.isObjectLiteralExpression(arg)) continue;
      for (const p of arg.properties) {
        const name = p.name;
        const key = name && (t.isIdentifier(name) || t.isStringLiteral(name)) ? name.text : null;
        if (key !== 'detached') continue;
        if (t.isShorthandPropertyAssignment(p)) return true;
        if (!t.isPropertyAssignment(p)) continue;
        return p.initializer.kind !== t.SyntaxKind.FalseKeyword;
      }
    }
    return false;
  };

  /** Any process launch, sync or async — the widened callee set, for TRIGGER (3) only. */
  const isLaunchCall = (node) => {
    if (isSpawnCall(node)) return true;
    if (!t.isCallExpression(node)) return false;
    const e = node.expression;
    if (t.isIdentifier(e)) return SYNC_LAUNCH_CALLEES.has(e.text);
    if (t.isPropertyAccessExpression(e)) return SYNC_LAUNCH_CALLEES.has(e.name.text);
    return false;
  };

  const visit = (node) => {
    if (isSpawnCall(node) && detachedTrigger(node)) detachedNotFalse = true;

    // TRIGGER (3), matched at FILE level rather than per-call, deliberately. The argv is
    // routinely built somewhere other than the call: a11y-bus.ts:82 parks `--fork` in an
    // `args:` property of a command DESCRIPTOR and spawns it at :230 as `busCmd.args`, so
    // walking a call's own arguments would miss the real offender — the exact site this
    // trigger exists for. File-level also matches how every exemption here already works
    // (ALLOWLIST, KNOWN_DEFECTS and the enrolment-import check are all keyed by file).
    // Reading string LITERALS off the AST — not the raw text — is what keeps a flag named
    // only in a comment from tripping it.
    if (isLaunchCall(node)) hasLaunchCall = true;
    if (
      (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node)) &&
      SELF_DAEMONIZING_FLAGS.has(node.text)
    ) {
      hasDaemonizeFlag = true;
    }

    // TRIGGER (2), direct form: `state.child = spawn(...)`, `this.proc = spawn(...)`,
    // or a class field initialised straight from a spawn.
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.EqualsToken) {
      const lhs = node.left;
      const rhs = unwrap(node.right);
      const lhsIsProperty = t.isPropertyAccessExpression(lhs) || t.isElementAccessExpression(lhs);
      if (lhsIsProperty && isSpawnCall(rhs)) storedOnProperty = true;
      if (lhsIsProperty && t.isIdentifier(rhs)) parkedNames.add(rhs.text);
      if (t.isIdentifier(lhs) && isSpawnCall(rhs)) spawnBound.add(lhs.text);
    }
    if (t.isPropertyDeclaration(node) && node.initializer && isSpawnCall(unwrap(node.initializer))) {
      storedOnProperty = true;
    }
    // TRIGGER (2), two-step form: `const child = spawn(...)` … `state.child = child`.
    if (t.isVariableDeclaration(node) && node.initializer && t.isIdentifier(node.name)) {
      if (isSpawnCall(unwrap(node.initializer))) spawnBound.add(node.name.text);
    }

    t.forEachChild(node, visit);
  };
  t.forEachChild(sf, visit);

  if (!storedOnProperty) {
    for (const n of spawnBound) {
      if (parkedNames.has(n)) {
        storedOnProperty = true;
        break;
      }
    }
  }
  return { detachedNotFalse, storedOnProperty, selfDaemonizing: hasLaunchCall && hasDaemonizeFlag };
}

/**
 * WI-6730: enumerate via the shared helper, which recurses into submodules. The
 * previous `git ls-files "*.ts" "*.tsx"` did not — it emits one gitlink entry per
 * submodule — so this guard never looked inside any of the 39, including
 * libs/papercusp (orchestrator/harness spawn paths) and papercusp-desktop. The
 * extension filter moved from a git pathspec into JS so the helper stays
 * single-purpose and pathspec semantics can't differ between the two call forms.
 */
function trackedFiles() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  return {
    files: files
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !p.includes('/_retired/') && !p.includes('/node_modules/'))
      .filter((p) => !/\.(test|spec)\.tsx?$/.test(p)),
    unscanned,
  };
}

function main() {
  const offenders = [];
  const { files, unscanned } = trackedFiles();
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(`${ROOT}${rel}`, 'utf8');
    } catch {
      continue;
    }
    if (isUnenrolledDetachedSpawn(rel, source)) {
      const { detachedNotFalse, storedOnProperty, selfDaemonizing } = spawnTriggers(rel, source);
      const why = [
        detachedNotFalse ? '`detached` set to something other than false' : null,
        storedOnProperty ? 'spawn handle parked on a property (outlives the call)' : null,
        selfDaemonizing
          ? 'argv carries a SELF-DAEMONIZING flag (--fork/--daemon/--daemonize): the child forks and reparents to init, so no `detached` option and no handle ever appear'
          : null,
      ]
        .filter(Boolean)
        .join(' + ');
      offenders.push(`${rel}  — ${why}`);
    }
  }

  // Printed on EVERY run, clean or not. The blind spot this guard was widened to fix
  // (EI-19483245448673321) was invisible precisely because nothing said it out loud;
  // a parked defect that only appears in a source file nobody opens repeats that.
  const parked = KNOWN_DEFECTS.size
    ? `\n  ⚠ ${KNOWN_DEFECTS.size} KNOWN DEFECT(S) suppressed — real hazards, not exemptions:\n` +
      [...KNOWN_DEFECTS].map(([p, r]) => `      ${p}\n        ${r}`).join('\n')
    : '';

  if (offenders.length === 0) {
    console.log(
      `[no-unenrolled-detached-spawn] OK — ${ALLOWLIST.size} allowlisted site(s), no new ones.` +
        describeUnscanned(unscanned) +
        parked,
    );
    return;
  }

  console.error('[no-unenrolled-detached-spawn] FAIL — spawn(s) that outlive their call with no task-manager enrolment:\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(parked);
  console.error(
    '\nA spawn that outlives the call that made it — because it is `detached`, because its\n' +
      'handle is parked on a property, or because the CHILD DAEMONIZES ITSELF — is the exact\n' +
      'population the task manager exists to keep addressable. Either:\n\n' +
      '  1. enrol it — `beginSyncEnrolment` + `completeSyncEnrolment` from\n' +
      '     packages/operator-core/lib/task-manager/enroll-sync.ts (sync seams), or\n' +
      '     `managedSpawn` from task-manager/managed-spawn.ts (async seams).\n' +
      '     A self-daemonizing child has NO handle to enrol — that is not a blocker:\n' +
      '     the sync seam takes a PID, so ask the daemon for its own\n' +
      '     (`dbus-daemon --print-pid=1`) and enrol that; or\n' +
      '  2. add it to ALLOWLIST in this file WITH A REASON, if its lifetime genuinely\n' +
      '     is not ours to own (a human terminal window, a pre-operator bootstrap, a\n' +
      '     release cut that must survive the restart it performs).\n\n' +
      'Silently un-enrolled is the one option that is not available: it becomes an\n' +
      '`unaccounted` alarm on the next reconcile anyway, just without provenance.',
  );
  process.exitCode = 1;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
