/**
 * release-checkpoint-launch — the agent-facing "fire the green-checkpoint NOW" lever's
 * launch primitive (WI-1320 follow-up: deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The gap it closes: the DEPLOY has a manual trigger (release:deploy op:trigger/force) and the
 * COMMIT routine now has one (git-sync:run) — but the GATE's verdict producer, the
 * `system:green-checkpoint` routine, only ever runs on its hourly cron (or via routines:set
 * pause/retune). So after fixing/quarantining reds there was no way to force a FRESH green
 * verdict now; you waited up to an hour for the next tick. This fires the SAME suite the cron
 * tick runs (apps/operator/lib/release/green-checkpoint.ts) on demand.
 *
 * Why DETACHED (mirrors release-deploy-launch.ts): the green-checkpoint suite runs the full
 * test battery under load for up to ~55 min — far past any MCP call budget — so an awaited
 * child would time out the tool. We launch it as a transient systemd unit with a loose
 * RuntimeMaxSec backstop (well above the suite timeout) so systemd never preempts a healthy
 * long run; the suite's own timeout still produces the verdict if it truly runs too long.
 * The OUTCOME lands on /admin/git (the pipeline event the CLI emits), not this caller.
 *
 * OOM-safety: green-checkpoint.ts self-locks (its status vocabulary includes 'skipped-locked'),
 * so firing this while the cron tick's suite is mid-run just no-ops the second run rather than
 * spawning a SECOND concurrent 8-fork suite (which would OOM the box — see release-actions.ts).
 *
 * Scope: the operator-home (papercusp) gate — root = integrationRoot(), the regression-safe
 * default the routine uses for the home harness (empty per-hive overlay). Per-hive manual
 * checkpoints can extend this later (they'd thread resolveCheckpointRouting's extraEnv).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { readFile as readFileAsync, readdir as readdirAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { integrationRoot, tsxBin, type SpawnLike } from './release-deploy-launch';
import { restrictedTreeHoldRefusal, type RestrictedHoldRefusal } from './agent-tools/testing/restricted-hold-fence';
import { CHECKPOINT_RUN_LOCK_STALE_MS } from './release-checkpoint-lock';
import { greenCheckpointDbPoolSetenvArgs } from './release/checkpoint-db-pool';
import { GREEN_CHECKPOINT_RESULT_MARKER, isFixtureLogLine } from './release/checkpoint-log-tags';
import {
  GREEN_CHECKPOINT_SIGKILL_GRACE_MS,
  GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
} from './release/green-checkpoint-schedule';
import { quietCutSecFromEnv } from './release/quiet-cut';
import {
  GATE_VERDICT_HARNESS_ENV,
  GATE_VERDICT_WORKSPACE_ENV,
  gateVerdictEnv,
  resolveHomeGateVerdictTarget,
  type GateVerdictTarget,
} from './release/gate-verdict-target';
import { GATE_FIRE_ID_ENV, isGateFireId, mintGateFireId, recordGateFire } from './release/gate-fire-ledger';
import { checkpointScopeMemoryMaxG, SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from './systemd-scope';
import { admitCheckpointMemory, type CheckpointMemoryAdmission } from './release/checkpoint-memory-admission';
import { CHECKPOINT_QUALIFICATION_ATTEMPT_ENV } from './release/checkpoint-qualification-transaction';
import type { CheckpointEligibilitySnapshot } from './release/checkpoint-eligibility-snapshot';
import {
  isCheckpointCandidateSource,
  type CheckpointCandidateSource,
} from './release/checkpoint-candidate-source';
import {
  callerEditsInCandidate,
  containingSubmodulePath,
  excludedCommitsTouchingPath,
  gitReadFromExecSync,
  submodulePrefixes,
  testImplSplitRisk,
  uncommittedPaths,
  type MissingReason,
  type PathContainment,
  type TestImplSplitRisk,
  type GitRead,
} from './candidate-contains';
import { execFileResultShared, runSyncWithAsyncExec, type AsyncExec } from './sync-exec-replay';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `\\'"'"'`)}'`;
}
/**
 * WI-4494: the harness whose gate a MANUAL checkpoint run judges — stamped into the detached unit's
 * env so the run RECORDS ITS OWN VERDICT instead of discarding it.
 *
 * This is the launcher whose verdicts were being thrown on the floor: it fires the full suite,
 * green-checkpoint.ts computes a real green/red — and, because only ROUTINE-invoked runs wrote
 * gate_health, nobody wrote it down. Meanwhile this run holds the run-lock, so the hourly routine
 * fire that COULD have recorded one gets `skipped-locked` instead. The gate then can't produce a
 * verdict at all while manual runs are in flight (observed live 2026-07-12: 3 consecutive fires
 * skipped, release pin frozen ~10h). See release/gate-verdict-target.ts.
 *
 * Scope matches this module's: the operator-home gate (root = integrationRoot()), so the target is
 * the operator-home harness. Fail-safe — if either half won't resolve we stamp nothing, the run
 * doesn't record, and the routine records exactly as it did before.
 */
/**
 * The transient systemd unit the detached manual checkpoint runs as. DISTINCT from the deploy
 * unit (a checkpoint and a deploy are independent) — but a second manual checkpoint while one
 * is active is refused by systemd-run (same-unit collision), and a manual-vs-cron collision is
 * absorbed by green-checkpoint.ts's own lock ('skipped-locked').
 */
export const CHECKPOINT_UNIT = 'papercup-green-checkpoint-manual';

/** PER-ROOT manual-checkpoint unit name (2026-07-01): the bare CHECKPOINT_UNIT
 *  made every repo's manual gate serialize on ONE systemd unit name — a peer
 *  hive's 55-minute run held THIS repo's `release:checkpoint-run` hostage (and
 *  vice versa), observed live when papercup's manual run blocked papercusp's
 *  post-fix re-verdict for ~an hour. Suffixing a short root hash keeps the
 *  same-root duplicate guard ("unit already exists ⇒ a run is in flight")
 *  while letting DIFFERENT roots run concurrently — they already isolate via
 *  their own checkouts + MemoryMax'd transient units. Exported for tests. */
export function checkpointUnitForRoot(root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return `${CHECKPOINT_UNIT}-${h.toString(36)}`;
}

/** Wall-clock ceiling for the detached suite's systemd backstop.
 *
 * Keep this strictly ABOVE the suite's own watchdog (120m15s) so the suite itself
 * still emits a red/verdict path if it genuinely overruns; the systemd cap is only a guard
 * against a truly wedged launch path, not the primary timeout.
 */
export const CHECKPOINT_MAX_RUNTIME_SEC = 3 * 60 * 60;

/**
 * Bound the synchronous user-manager probe independently of the caller's larger status-read
 * budget. A starved systemd manager must not monopolize `release:deploy {op:status}`; when this
 * expires, `spawnSync` returns a null status and the existing probe-failure branch fails closed
 * while consulting the file-based run-lock as an independent liveness oracle.
 */
export const CHECKPOINT_SYSTEMCTL_PROBE_TIMEOUT_MS = 5_000;

/** Internal env transport from the detached MANUAL launcher to green-checkpoint.ts.
 *
 * The scheduled path owns a parent-side suite timeout followed by a SIGKILL grace, while
 * this detached path has no such parent and previously inherited only the 3h orphan
 * backstop. Stamp the equivalent full kill window into the transient unit so a wedged manual
 * run terminates on the same schedule. The 3h systemd cap remains the final launch backstop.
 *
 * This used to be a hand-typed COPY of that window, because importing release-actions.ts
 * here registers routine actions as a module-load side effect, and the cross-file timing
 * test existed to catch the copy drifting. Both constants now come from
 * `release/green-checkpoint-schedule.ts`, a leaf with no imports and no side effects — so
 * the window is DERIVED and cannot drift, and retuning the budget moves this with it.
 */
export const MANUAL_CHECKPOINT_WATCHDOG_ENV = 'PAPERCUSP_MANUAL_GREEN_CHECKPOINT_WATCHDOG_MS';
export const MANUAL_CHECKPOINT_WATCHDOG_MS = GREEN_CHECKPOINT_SUITE_TIMEOUT_MS + GREEN_CHECKPOINT_SIGKILL_GRACE_MS;

export const CHECKPOINT_CAPACITY_MODE_ENV = 'PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE';

/** WI-10003521: the capacity contract a manual launch forwarded, with its provenance. */
export interface CheckpointCapacityReport {
  /** The mode the run will actually execute under ('shared' when nothing valid was declared). */
  mode: 'shared' | 'reserved';
  /** Where `mode` came from: the caller's `extraEnv`, the LAUNCHING process's env, or nothing
   *  (`default`) / an unrecognised value (`invalid`) — the last two are silent fallbacks. */
  source: 'extraEnv' | 'process-env' | 'default' | 'invalid';
  /** The raw declared value, verbatim (null when undeclared). */
  declared: string | null;
  /** Non-null when the run will silently get less capacity than the launcher's operator
   *  probably intended. Callers must surface it, not bury it in a nested field. */
  warning: string | null;
}

/**
 * WI-10003521: resolve the capacity contract for a manual checkpoint launch, and say LOUDLY
 * when it is a silent fallback.
 *
 * WI-39472 made the launcher forward its own capacity env into the detached run. That left a
 * second, quieter seam: the contract is read from the LAUNCHING process, and manual runs are
 * launched by whichever operator served `release:checkpoint-run` — on the dev box the staging
 * operator (:3170), whose unit had no capacity drop-in while papercup-dev-api and
 * papercup-bg-host did. Observed 2026-09-27: manual runs logged `mode=shared maxForks=2`,
 * operator-core lane-stateful got one fork and ran 55 min and then >86 min (killed by the 3h
 * backstop with no verdict), against ~20 min for scheduled runs at reserved. Nothing in the
 * launch reply said so; only the run's own GREEN_CHECKPOINT_CAPACITY log line did, an hour in.
 * An explicit `shared` is a choice and is not warned about; an absent or unrecognised value is.
 */
export function resolveCheckpointCapacity(
  extraEnv: Record<string, string | undefined> | undefined,
  env: Record<string, string | undefined> = process.env,
): CheckpointCapacityReport {
  const fromExtra = extraEnv?.[CHECKPOINT_CAPACITY_MODE_ENV];
  const fromProcess = env[CHECKPOINT_CAPACITY_MODE_ENV];
  const declared = fromExtra ?? fromProcess ?? null;
  const declaredSource: 'extraEnv' | 'process-env' = fromExtra !== undefined ? 'extraEnv' : 'process-env';
  if (declared === 'shared' || declared === 'reserved') {
    return { mode: declared, source: declaredSource, declared, warning: null };
  }
  const fix =
    `Set ${CHECKPOINT_CAPACITY_MODE_ENV}=reserved on the service that launched this run ` +
    `(a systemd drop-in like the 20-green-checkpoint-capacity.conf on papercusp-bg-host), restart it, ` +
    `and confirm the run log's GREEN_CHECKPOINT_CAPACITY line. Scheduled gate runs use their own ` +
    `host's contract, so this manual run may be several times slower than a scheduled one (WI-10003521).`;
  if (declared === null) {
    return {
      mode: 'shared',
      source: 'default',
      declared: null,
      warning: `⚠ CAPACITY: the launching process (pid ${process.pid}) declares no ${CHECKPOINT_CAPACITY_MODE_ENV}, so this manual run falls back to SHARED capacity (fewer vitest forks). ${fix}`,
    };
  }
  return {
    mode: 'shared',
    source: 'invalid',
    declared,
    warning: `⚠ CAPACITY: ${CHECKPOINT_CAPACITY_MODE_ENV}=${JSON.stringify(declared.slice(0, 40))} is not 'shared' or 'reserved', so it was DROPPED and this manual run falls back to SHARED capacity. ${fix}`,
  };
}

export interface LaunchCheckpointResult {
  launched: boolean;
  unit: string;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a manual checkpoint is running). */
  reason?: string;
  /** Present when `reason === 'already_running'` — the structured detail of the live run
   *  (WI-1562: a bare `reason` string left concurrent callers with no clean way to tell
   *  "this refused because one is already in flight, don't retry" from a transient spawn
   *  failure — they'd retry / manually kill what they assumed was stuck). */
  alreadyRunning?: ActiveCheckpointCheck;
  /** Present when `reason === 'memory_budget'` — P-006's cross-root memory bound deferred this
   *  launch because the SUM of live checkpoint commitments plus this run's cap would exceed the
   *  host budget. Structured for the same reason `alreadyRunning` is: "deferred, another pot's
   *  run is holding the budget, retry later" is a different instruction to the caller than a
   *  spawn failure, and the numbers behind the verdict are what make it checkable. */
  memoryAdmission?: CheckpointMemoryAdmission;
  /** Present when the launch was refused because a restricted session's writes are held in the
   *  tree this launch executes from (WI-10005763, D-012); `reason` is its `error`. Nothing was
   *  started or stopped. The census and the reason text are the routine dispatchers' own. */
  restrictedHold?: RestrictedHoldRefusal;
  /** EI-9672: set when `replaceStale:true` found the active run CONFIRMED stale and stopped
   *  it before this launch — the detail of what was stopped, for the caller's audit trail. */
  replacedStale?: ActiveCheckpointCheck;
  /** WI-10003521: the capacity contract this launch actually forwarded, and where it came
   *  from. Set on every launch attempt that reaches argv construction. `source: 'default'`
   *  (the launcher's env declares nothing) and `'invalid'` (it declares an unrecognised value)
   *  both mean the run silently falls back to SHARED — see `resolveCheckpointCapacity`. */
  capacity?: CheckpointCapacityReport;
  /** WI-5124: which commit this launch is PREDICTED to judge, computed the same way the run
   *  itself resolves it (quiet-cut applied) — set on every launch attempt (successful or
   *  refused), so a caller who just committed a fix and re-fires can see, from the REPLY
   *  alone, whether their fix is likely IN or OUT of this run. Absent only if the git reads
   *  themselves failed (current_head null).
   *
   *  EI-18759622667757826 — THIS IS A PREDICTION, NEVER SETTLED FACT, and its most likely
   *  error is the DANGEROUS direction. The quiet cut is purely an AGE test (`rev-list
   *  --before=@(now - quietCutSec)`) and the detached run re-resolves its OWN candidate ~1-2s
   *  after launch — so a commit excluded here merely for being seconds too young AGES INTO
   *  eligibility inside that gap and is judged after all. That is not an exotic race: it is
   *  the expected outcome for the "I just fixed the reds, re-judge" caller this field exists
   *  for, whose fix is by construction seconds old. Reported pessimistically it tells a caller
   *  its expensive in-flight run is worthless, and the cheapest-looking recovery is to KILL the
   *  run — which is how a healthy run nearly died on 2026-07-27. `excludedEligibility` below
   *  quantifies the gap per commit so no caller has to guess. */
  willJudge?: {
    /** The commit predicted to be judged (post quiet-cut). */
    candidate: string | null;
    /** Provenance selected for the detached producer. */
    candidateSource?: CheckpointCandidateSource;
    /** The true tip of the integration branch BEFORE any quiet-cut step-back. */
    tip: string | null;
    /** Did the quiet-cut step the candidate back from the tip? */
    quietCutApplied: boolean;
    /** The quiet window (seconds) in effect; 0/null when disabled. */
    quietCutSec: number | null;
    /** One-line `sha subject` entries for commits strictly newer than `candidate` — i.e. NOT
     *  judged by this run (your just-landed fix may be in here). Empty when quietCutApplied
     *  is false. Best-effort (BENIGN RACE, WI-5124): computed at launch time; the detached
     *  process re-resolves its own candidate ~1-2s later and a git-sync tick in that gap can
     *  shift it — this is "will judge as of launch", not a guarantee. */
    excludedCommits: string[];
    /** P-004: the FILES those excluded commits touch. `excludedCommits` alone is unusable by
     *  the reader it is written for — an agent knows which files it edited and nothing about
     *  which sha carries them, so a sha list forces the resolution back onto the caller (the
     *  "if your fix is among them" the EI-18752644493166307 filer had to resolve by hand).
     *  Answering in path-space is what makes the warning actionable. */
    excludedPaths: string[];
    /** EI-18759622667757826: per excluded commit, how many seconds until it AGES INTO quiet-cut
     *  eligibility (0 = already eligible; it is excluded only because the candidate was resolved
     *  a moment ago). Anything at or below CANDIDATE_RERESOLVE_WINDOW_SEC will very likely be
     *  judged by THIS run despite appearing in `excludedCommits` — this is the field that turns
     *  "your fix may not be in this run" from an unfalsifiable hedge into a number the caller
     *  can act on. */
    excludedEligibility: { sha: string; subject: string; eligibleInSec: number }[];
    /** The smallest `eligibleInSec` across `excludedEligibility` (null when nothing is excluded)
     *  — the single number that says how much to trust the exclusion prediction. */
    soonestEligibleInSec: number | null;
  };
}

/** The exact user-manager query that produced an ActiveCheckpointCheck reading. */
export interface CheckpointSystemdProbe {
  scope: 'user';
  /** Arguments passed to `systemctl`; the command name itself is recorded by the type. */
  argv: string[];
  /** Raw systemd LoadState, or null when the probe did not return it. */
  load_state: string | null;
  /** `true` only for LoadState=loaded; null means LoadState was unavailable. */
  known: boolean | null;
  /** Raw InvocationID, or null when systemd returned an empty/missing value. */
  invocation_id: string | null;
}

/** Detail of a live (already-active) manual checkpoint run for THIS root, or its absence. */
export interface ActiveCheckpointCheck {
  active: boolean;
  unit: string;
  /** Provenance for the systemd user-manager read used to establish this result. */
  systemd: CheckpointSystemdProbe;
  /** EI-20349211793685690: whether the stable unit log was readable and contained the
   *  CLI's exact machine-readable terminal result line. Absent means the log could not be
   *  read; `false` is therefore a measured no-verdict condition, not an unreadable-log guess.
   *  This is reported on trusted post-unit exits while preserving `active:false` for a unit
   *  that really finished. */
  terminal_marker?: boolean;
  /**
   * EI-210996: out-of-process terminal evidence appended by systemd's ExecStopPost.
   * Unlike the checkpoint CLI's own result marker, this survives SIGKILL/OOM because
   * the user manager writes it after the main process has exited. `candidate` comes
   * from the same immutable per-run log, so readers can refuse to attribute an old
   * abnormal exit to a newer candidate.
   */
  terminal_evidence?: CheckpointSystemdTerminalEvidence;
  /** Stable symlink for the active manual run's output (`/tmp/<unit>.log`). Null/absent
   *  when liveness came only from the shared run lock (for example the hourly cron), because
   *  that process does not publish its output path through the manual systemd unit. Readers
   *  should use this instead of guessing a timestamped per-run filename. */
  log_path?: string | null;
  /** Best-effort candidate sha the live run is judging. For the manual-unit case, parsed
   *  from its log's LAST "checkpointing candidate <sha>" line (null if the log isn't
   *  readable yet/at all). For the `held_externally` case (see below), resolved instead
   *  from the isolated checkpoint checkout's own HEAD — null only if THAT tree doesn't
   *  exist or isn't readable. Either way: the sha this field reports IS what the live run
   *  is judging, never a hypothetical "if launched now" value (see `current_candidate`).
   *
   * EI-19327704778173646 — why LAST, not first. A single run can legitimately change the
   * candidate it judges: on a stale red, `green-checkpoint.ts` recurses into
   * `runGreenCheckpoint({ candidate: tip, refireAttempts: +1 })` IN-PROCESS (L2649 test-file
   * rescue, L2693 lint/typecheck sibling) and the recursion re-enters `setupTree(candidate)`,
   * re-pinning the isolated checkout. `pid`/`started_at` belong to the outer frame and never
   * move, so **a candidate newer than `started_at` is the expected signature of a healthy
   * auto-refire, NOT corruption** — do not "sanity-check" this field by comparing commit dates
   * to `started_at` and do not fire a manual run on the strength of that comparison (it
   * discards the in-flight rescue and costs a full ~55min suite).
   *
   * Reading the FIRST match — what this did before — reported the ABANDONED sha for the rest
   * of the run, while the surrounding prose told callers to verify their fix against it. That
   * is the false-negative that produced several public retractions on 2026-08-02. */
  candidate?: string | null;
  /** EI-19327704778173646. The FIRST candidate this run judged, when it is known to differ
   *  from `candidate` — i.e. the run auto-refired onto a newer tip and this is the sha it
   *  started on and has since discarded. `null` when no refire was observed (the common case)
   *  or when the log could not be read. Never verify a fix against this sha; it is provenance,
   *  offered so a `candidate` that legitimately MOVED is self-describing rather than looking
   *  like a corrupt/unstable field to a caller who reads the status twice. */
  initial_candidate?: string | null;
  /** EI-19327704778173646. True when this run demonstrably re-candidated mid-flight (≥2
   *  distinct `checkpointing candidate` lines in its log). A `false` is NOT proof no refire
   *  happened — only that none was visible in the bytes read. */
  refire_observed?: boolean;
  /** Current integration checkout HEAD at status-read time. */
  current_head?: string | null;
  /** Current quiet-cut-eligible candidate at status-read time. May differ from `candidate`
   *  while a long checkpoint run is active and newer quiet commits landed after it started. */
  current_candidate?: string | null;
  /** True when the active run's parsed candidate is older/different than the current
   *  quiet-cut-eligible candidate. */
  candidate_stale?: boolean;
  /** Quiet-cut window used to resolve `current_candidate`; null when it could not be checked. */
  quiet_cut_sec?: number | null;
  /** ISO timestamp the unit actually started running (systemd ExecMainStartTimestamp). */
  started_at?: string | null;
  /** Seconds since the unit started — null when systemd did not report a start timestamp. */
  elapsed_sec?: number | null;
  /**
   * Latest observed checkpoint progress, from the run log/phase marker (or the log mtime).
   * This is distinct from `started_at`: a long-lived run can keep progressing after the
   * systemd start time has become old enough to look stalled.
   */
  progress_at?: string | null;
  /** Current phase published by the run in its per-run `phase.json` marker. */
  current_phase?: string | null;
  /** Seconds remaining before the systemd backstop (CHECKPOINT_MAX_RUNTIME_SEC)
   *  would kill it — a rough "how much longer" estimate, not a promise. Null when the
   *  run has reached `delivering`: the backstop remainder is no longer an honest estimate
   *  of time to verdict, and no bounded delivery-phase duration is published. */
  eta_sec?: number | null;
  /** What `eta_sec` measures. `full-suite` is the systemd backstop remainder; `delivery-phase`
   *  deliberately carries a null `eta_sec` until the run publishes a bounded verdict estimate. */
  eta_basis?: 'full-suite' | 'delivery-phase';
  /** EI-11667: set when a `replaceStale:true` request found the run stale but YOUNGER than
   *  REPLACE_STALE_MIN_AGE_SEC — the stop was refused (a young stale run is healthy-in-progress
   *  on a busy tree, not wedged; see the constant's doc for the 2026-07-13 replace-storm). */
  replace_refused_young?: boolean;
  /** EI-18757156963245979: the run has finished its SUITE and is in the verdict path
   *  (stale-red re-triage -> auto-refire -> prefix salvage), as published by the run itself
   *  in the run-lock's `phase.json`. Such a run is seconds-to-minutes from a verdict — and
   *  may VOID a stale red and re-fire onto a newer tip — so it is never replaceable, at any
   *  age. Undefined when the marker is absent/unreadable (older run, or the phase file was
   *  never written): the decision then degrades to the age test alone, as before. */
  delivering?: boolean;
  /** EI-18757156963245979: set when a `replaceStale:true` request was refused because the run
   *  is `delivering`. Distinct from `replace_refused_young` on purpose — "too young to be
   *  wedged" and "too close to done to interrupt" are different reasons to wait, and a caller
   *  that sees this one knows a verdict is imminent rather than ~20 minutes out. */
  replace_refused_delivering?: boolean;
  /** WI-5685: true when this active run was detected via the shared file-based RUN LOCK, not
   *  the manual systemd unit — almost certainly the hourly cron tick (or another out-of-band
   *  invocation). The holder's own log path isn't known, so `candidate` is instead resolved
   *  from the checkpoint checkout's own HEAD (best-effort — see `candidate`'s doc comment);
   *  `candidate_stale` is HARD-CODED false regardless of what that resolves to (EI-11667/
   *  EI-18695275971973546 safety: even a genuinely-stale externally-held run must never be
   *  reported replaceable — there is no manual unit here to stop, so `force`/`replaceStale`
   *  CANNOT free this slot; either would just spawn a second process that loses the exact
   *  same lock race a moment later and produces no verdict either). The only remedy is to
   *  wait for it (checkpoint:await, no candidateSha — its outcome covers your commit too as
   *  long as your commit is an ancestor of whatever it judges). `current_candidate`/
   *  `candidate_stale` describe a HYPOTHETICAL fresh launch, never this in-flight run. */
  held_externally?: boolean;
  /** P-009 / WI-41252: a checkpoint process exists before the shared run-lock and
   * candidate markers are published. This observation is rooted in the process's
   * gate-verdict authority stamps + exact integration-root environment + unified
   * cgroup membership — never argv text, which may merely mention the gate. */
  pre_lock_authority?: {
    workspace: string;
    harness: string;
    cgroup_path: string;
    pid: number;
  };
  /** WI-6962: the `systemctl show` probe could not be TRUSTED — its exit status was non-zero
   *  or its output did not contain an `ActiveState` key at all. This is NOT the same as
   *  "nothing is running", and conflating the two is what made this detection fail OPEN.
   *
   *  Measured 2026-08-02: `systemctl --user show <unknown-unit>` exits **0** and prints
   *  `ActiveState=inactive` / `MainPID=0`. So a well-formed negative ALWAYS arrives as
   *  exit 0 WITH an `ActiveState` key — which makes the converse decisive: a non-zero exit
   *  or a missing key means the probe itself failed (a fork that lost to host pressure, a
   *  `--user` manager too starved to answer), never that the unit is idle. The old code
   *  parsed that empty output into `activeState = ''`, fell through the active-state test,
   *  and returned `{ active: false }` — so `launchDetachedCheckpoint` launched straight
   *  over a live 8-fork suite. `systemd-run --unit=<same>` does not refuse that collision
   *  the way this file's comments assumed: journalctl for the run killed at 06:27:05Z shows
   *  `Stopping` → `Stopped` → `Started` within one second, i.e. the transient unit was
   *  REPLACED. Net effect: a healthy run 20 minutes into a ~34-55 min suite was destroyed
   *  and left no red, no error, and no verdict event, so every agent parked on the gate's
   *  outcome slept on a run that no longer existed (no verdict landed between 01:21Z and
   *  06:33Z).
   *
   *  Set alongside `active: true` deliberately: an indeterminate probe must READ as "a run
   *  may be in flight" to every consumer that only looks at `.active`, so the conservative
   *  behaviour is the default one rather than something each caller has to remember. */
  probe_failed?: boolean;
  /** WI-6962: why the probe was not trusted (exit status / stderr excerpt), for the refusal
   *  message — so a caller can tell a starved host from a genuinely broken systemctl. */
  probe_detail?: string;
}

/** Minimal options needed by the injected `child_process.spawnSync` seam. */
export type ExecSyncOptions = { timeout?: number };

/** Minimal shape of a `child_process.spawnSync` result — injectable so
 *  `checkActiveCheckpointRun` is unit-testable without a real systemctl call. */
export type ExecSyncLike = (
  cmd: string,
  args: string[],
  options?: ExecSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

function defaultExecSync(
  cmd: string,
  args: string[],
  options?: ExecSyncOptions,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `defaultExecSync`'s async twin: same result semantics, never blocks the event loop.
 *  EI-24852529885337741: read-only git calls share one child per argv for 2 s
 *  (execFileResultShared), because concurrent callers issue identical bursts and each fork of
 *  this process costs ~160 ms of main-thread time. */
const defaultAsyncExec: AsyncExec = (cmd, args, options) =>
  execFileResultShared(cmd, args, { timeout: typeof options?.timeout === 'number' ? options.timeout : undefined });

/**
 * WI-10005268: run a sync, exec-injected probe (`checkActiveCheckpointRun`,
 * `currentCheckpointCandidate`, `excludedCommitsSync`, …) from an operator handler WITHOUT parking
 * the main thread.
 *
 * With the real default exec, every git/systemctl call the probe makes goes through async
 * `execFile` under record/replay (sync-exec-replay.ts, WI-10005261); the final pass is a faithful
 * re-execution against the fetched results. A main-thread `spawnSync` is what the event-loop
 * sentinel wedge-kills :3070/:3170 for, dropping every MCP session on the host (#1155).
 *
 * An INJECTED exec (a test seam, or a caller already off the main thread) runs the probe directly
 * and returns its value SYNCHRONOUSLY, not a Promise. `launchDetachedCheckpoint` depends on that:
 * with synchronous seams it must reach `spawnFn` and attach the child's listeners in the caller's
 * own tick (see the note above its process-authority read). Await the result only when
 * `isPromiseLike` says so.
 *
 * Precondition (sync-exec-replay's): the probe is side-effect free apart from its exec calls, and
 * never issues the same exec call twice expecting a different answer. Read-only probes qualify;
 * `terminateActiveCheckpointUnit` (a kill) is deliberately not routed through here.
 */
export function runCheckpointProbe<T>(
  probe: (execFn: ExecSyncLike) => T,
  execFn: ExecSyncLike = defaultExecSync,
  asyncExec: AsyncExec = defaultAsyncExec,
): T | Promise<T> {
  if (execFn !== defaultExecSync) return probe(execFn);
  return runSyncWithAsyncExec(probe, asyncExec).then((r) => r.value);
}

/**
 * WI-10005268: `checkActiveCheckpointRun(root)` with the real probes, off the event loop. Use this
 * from any operator handler; the sync form with its default exec parks the main thread for every
 * systemctl/git call it makes.
 */
export async function checkActiveCheckpointRunAsync(root: string): Promise<ActiveCheckpointCheck> {
  return runCheckpointProbe((e) => checkActiveCheckpointRun(root, e));
}

/**
 * WI-10005268: a `GitRead` for `repo` that does not block the event loop when `execFn` is the
 * real default. An injected exec keeps the existing sync-backed adapter so tests stay hermetic.
 */
function checkpointGitRead(execFn: ExecSyncLike, repo: string): GitRead {
  if (execFn !== defaultExecSync) return gitReadFromExecSync(execFn, repo);
  return async (args) => {
    const r = await defaultAsyncExec('git', ['-C', repo, ...args]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
}

function defaultReadLogHead(logPath: string): string | null {
  try {
    // The FIRST candidate line is emitted at the top of the run
    // (`[green-checkpoint] checkpointing candidate …`); a small head-read is enough to
    // recover it and stays cheap even for a large/rotating log.
    //
    // EI-19327704778173646: a head-read is not by itself the bug — MEASURED on this box
    // 2026-08-02, the live run's two `checkpointing candidate` lines sat at byte offsets 177
    // and 2281, both comfortably inside this window. The bug was that the caller took the
    // FIRST regex match, which is wrong after an auto-refire at ANY log size.
    //
    // The window still matters at the margin, so `readLogTail` is not redundant: those two
    // candidates were ~2.1KB apart, and the refire cap is 2 (`autoRefireCapFromEnv`), so a
    // run that uses its full budget puts the THIRD candidate line near ~4.4KB — just past
    // this slice. Do not "fix" that by widening the slice; the point of a head-read is that
    // it is O(1) on a log that can grow to multi-MB.
    return readFileSync(logPath, { encoding: 'utf8' }).slice(0, 4096);
  } catch {
    return null;
  }
}

/** EI-19327704778173646: read the END of a run's log, where an auto-refire's second
 *  `checkpointing candidate <sha>` line lands. Bounded to the last 64KB and seeked from the
 *  file's end, so it stays O(1) on a multi-MB gate log rather than reading the whole thing.
 *
 * Best-effort by the same contract as `defaultReadLogHead`: any failure (missing file, no
 * permission, mid-rotation) returns null, which degrades to exactly the pre-EI behaviour —
 * the head-read's first candidate — rather than erroring a status probe.
 *
 * WI-7296: ON A SEEKED READ THE PARTIAL FIRST LINE IS DISCARDED. Seeking to `size - maxBytes`
 * lands mid-line, and a truncated FIXTURE line is the one shape that survives truncation into
 * something harmful: `[green-checkpoint:TEST-FIXTURE] checkpointing candidate <sha>` sliced
 * after the tag reads as a genuine candidate line to {@link parseCheckpointCandidates}.
 *
 * Keep it and the failure is a WRONG answer that looks right (a fixture sha reported as the
 * judged candidate). Drop it and the failure is a MISSING answer, which already has a defined
 * safe fallback: the caller does `tailCandidates.at(-1) ?? firstCandidate`, so an empty tail
 * degrades to the head-read's first candidate — the documented pre-EI behaviour.
 *
 * The two directions are NOT symmetric, which is what makes this free rather than a trade
 * (credit: su-4ca244e4, who filed EI-19395755190419540 and then pointed out I had documented
 * this residual as if it were a coin-flip). Truncation only ever removes from the LEFT, so a
 * sliced line either loses its leading tag while `checkpointing candidate <sha>` survives —
 * the harmful case — or has its match prefix destroyed and matches nothing. There is NO case
 * that yields a corrupted-but-matching sha, because any cut reaching the sha has already
 * destroyed `checkpointing candidate`. So dropping the line can only ever cost us a candidate,
 * never corrupt one.
 *
 * Cost: a candidate line that is BOTH the first line of the 64KB window AND the only one in
 * it. Vanishingly rare, and it fails safe. The read stays bounded and O(1) — this is one
 * `indexOf`, not a widened window; do NOT "fix" the rare case by reading more of the file. */
export function defaultReadLogTail(logPath: string, maxBytes = 65536): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    // Unseeked: the whole file, so the first line is genuinely the first line — keep it.
    if (size <= maxBytes) return readFileSync(logPath, { encoding: 'utf8' });
    fd = openSync(logPath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const window = buf.subarray(0, read).toString('utf8');
    const firstNewline = window.indexOf('\n');
    // No newline at all ⇒ the entire window is one partial line ⇒ nothing usable. Return ''
    // (the read SUCCEEDED and yielded no complete lines) rather than the raw partial slice.
    return firstNewline === -1 ? '' : window.slice(firstNewline + 1);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / never opened — nothing to recover */
      }
    }
  }
}

/** EI-19327704778173646: every `checkpointing candidate <sha>` sha in `text`, in emission
 *  order. Exported for the recurrence-guard test.
 *
 *  EI-19395755190419540 — FIXTURE LINES ARE EXCLUDED, and the exclusion must stay NEGATIVE.
 *  This used to be a bare `text.matchAll(/checkpointing candidate (\S+)/g)` with no anchor of
 *  any kind. The gate's own suite drives the real `runGreen` (green-checkpoint-real-deps.test.ts),
 *  so fixture `checkpointing candidate <fake-sha>` lines land in captured output and get
 *  persisted — and an unanchored match cannot tell them from the run's own. That corrupted the
 *  AUTOMATED answer to the most contested question in this repo ("which sha is the gate
 *  judging?"), feeding `readLogHead`/`readLogTail` and, through them, the candidate CLAUDE.md
 *  instructs every agent to trust. The FIRST-vs-LAST-match bug here was already fixed once
 *  (EI-19327704778173646) without anyone noticing the match SET itself was unsound.
 *
 *  ⚠ Do NOT "simplify" this to a positive anchor on `[green-checkpoint]`. That is the obvious
 *  fix and it is wrong: the persisted log's orchestrator transcript carries this same line
 *  UNPREFIXED (`log()` hands the raw message to `recordOrchestratorLine`; only `console.log`
 *  prepends a tag), so requiring the tag silently zeroes extraction for the scheduler-fired
 *  runs that are the majority. See {@link isFixtureLogLine} for the measured evidence.
 *
 *  Line-oriented on purpose: the tag and the sha are on the same line, so a per-line filter is
 *  exactly as precise as the data allows.
 *
 *  The seek-truncation hole this used to carry as a KNOWN RESIDUAL is CLOSED (WI-7296):
 *  `defaultReadLogTail` now discards the partial first line on a seeked read, so a fixture line
 *  whose leading tag was sliced off never reaches this parser. That was free rather than a
 *  trade because the two failure directions are asymmetric — see the reasoning on
 *  {@link defaultReadLogTail}. Nothing here needs to compensate for it. */
export function parseCheckpointCandidates(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (isFixtureLogLine(line)) continue;
    for (const m of line.matchAll(/checkpointing candidate (\S+)/g)) out.push(m[1]);
  }
  return out;
}

/** The persisted orchestrator log prefixes each real line with an ISO timestamp. */
const CHECKPOINT_LOG_TIMESTAMP = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/;

function latestLogTimestampMs(...texts: Array<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (isFixtureLogLine(line)) continue;
      const timestamp = line.match(CHECKPOINT_LOG_TIMESTAMP)?.[1];
      if (!timestamp) continue;
      const at = Date.parse(timestamp);
      if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
    }
  }
  return latest;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultReadLogMtime(logPath: string): number | null {
  try {
    const mtimeMs = statSync(logPath).mtimeMs;
    return Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the newest durable progress signal available to the probe. The log mtime covers
 * child-runner output that has no timestamp of its own; the timestamped transcript and phase
 * marker cover scheduler/persisted logs and state transitions. `startedAtMs` is deliberately
 * last: it is a baseline for old writers, never the preferred liveness clock.
 */
function checkpointProgressAtMs(input: {
  logHead?: string | null;
  logTail?: string | null;
  logMtimeMs?: number | null;
  phaseAt?: string | null;
  startedAtMs?: number | null;
}): number | null {
  const candidates = [
    latestLogTimestampMs(input.logHead, input.logTail),
    timestampMs(input.phaseAt),
    input.logMtimeMs != null && Number.isFinite(input.logMtimeMs) ? input.logMtimeMs : null,
    // Keep the start baseline in the comparison so a stale log/phase artifact can never move
    // progress backwards. It is still last in preference: any real heartbeat wins above it.
    input.startedAtMs != null && Number.isFinite(input.startedAtMs) ? input.startedAtMs : null,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  if (candidates.length > 0) return Math.max(...candidates);
  return null;
}

function isoTimestampOrNull(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function parseSystemctlShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Written by the transient unit's ExecStopPost, outside the checkpoint process. */
export const GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER = '__GREEN_CHECKPOINT_SYSTEMD_TERMINAL__';

export interface CheckpointSystemdTerminalEvidence {
  source: 'systemd-exec-stop-post';
  candidate: string | null;
  service_result: string;
  exit_code: string;
  exit_status: string;
  abnormal: boolean;
}

/** Return true only for the standalone production result line, with valid result JSON. Captured
 *  suite fixtures are prefixed/defanged and must not turn a finished-unit probe into a verdict. */
function hasCheckpointResultMarker(log: string | null): boolean {
  if (!log) return false;
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(GREEN_CHECKPOINT_RESULT_MARKER)) continue;
    const payload = trimmed.slice(GREEN_CHECKPOINT_RESULT_MARKER.length);
    if (!/^\s+/.test(payload)) continue;
    try {
      const parsed: unknown = JSON.parse(payload.trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const result = parsed as Record<string, unknown>;
      if (typeof result.reason === 'string' && Object.prototype.hasOwnProperty.call(result, 'green')) return true;
    } catch {
      // A partial/invalid marker is not terminal evidence.
    }
  }
  return false;
}

/** Read the stable unit path only for a trusted post-unit transition. Null preserves the
 *  distinction between an unreadable log and a readable log that contains no verdict. */
export function parseCheckpointSystemdTerminalEvidence(
  log: string | null,
): CheckpointSystemdTerminalEvidence | undefined {
  if (!log) return undefined;
  let tuple: Omit<CheckpointSystemdTerminalEvidence, 'source' | 'candidate' | 'abnormal'> | undefined;
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} `)) continue;
    const match = trimmed.match(
      /^__GREEN_CHECKPOINT_SYSTEMD_TERMINAL__ service_result=(\S+) exit_code=(\S+) exit_status=(\S+)$/,
    );
    if (!match) continue;
    // Fail closed if the systemd-run/printf serialization regresses and writes its
    // format placeholders literally. A literal "%s" tuple is not manager evidence;
    // accepting it would classify every finished unit as an abnormal termination.
    if (match[1]!.includes('%') || match[2]!.includes('%') || match[3]!.includes('%')) continue;
    tuple = { service_result: match[1]!, exit_code: match[2]!, exit_status: match[3]! };
  }
  if (!tuple) return undefined;
  const candidates = parseCheckpointCandidates(log);
  return {
    source: 'systemd-exec-stop-post',
    candidate: candidates[candidates.length - 1] ?? null,
    ...tuple,
    abnormal: !(tuple.service_result === 'success' && tuple.exit_code === 'exited' && tuple.exit_status === '0'),
  };
}

function readTerminalState(
  unit: string,
  readLogTail: (logPath: string) => string | null,
): { terminalMarker?: boolean; terminalEvidence?: CheckpointSystemdTerminalEvidence } {
  const log = readLogTail(checkpointLatestLogPath(unit));
  if (log == null) return {};
  const terminalEvidence = parseCheckpointSystemdTerminalEvidence(log);
  return {
    terminalMarker: hasCheckpointResultMarker(log),
    ...(terminalEvidence ? { terminalEvidence } : {}),
  };
}

function gitOutput(root: string, args: string[], execFn: ExecSyncLike): string | null {
  const r = execFn('git', ['-C', root, ...args]);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

function gitOk(root: string, args: string[], execFn: ExecSyncLike): boolean {
  return execFn('git', ['-C', root, ...args]).status === 0;
}

function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** EI-18759622667757826: the launch→re-resolution gap. `launchDetachedCheckpoint` resolves the
 *  predicted candidate immediately before spawning; the detached run then resolves its OWN
 *  candidate ~1-2s later. An excluded commit that ages into eligibility within this window is
 *  therefore judged after all, and any warning that says otherwise is actively misleading. Set
 *  generously (spawn + node startup under load) — the cost of over-inclusion is a hedged
 *  sentence, the cost of under-inclusion is a caller killing a healthy run. */
export const CANDIDATE_RERESOLVE_WINDOW_SEC = 10;

/** WI-5124 / EI-18759622667757826: commits strictly newer than `from` up to (and including)
 *  `to` — the sync/execFn counterpart of git-ops.ts's async `commitsBetween`, for reporting
 *  `willJudge`. Returns the one-line `sha subject` entry AND the commit's own age against the
 *  quiet window, because the exclusion is a pure age test and "how close is it?" is the whole
 *  question a caller needs answered. `from === to` (nothing excluded) short-circuits without a
 *  git call. */
function excludedCommitsSync(
  root: string,
  from: string,
  to: string,
  quietSec: number | null,
  execFn: ExecSyncLike,
): { line: string; sha: string; subject: string; eligibleInSec: number }[] {
  if (from === to) return [];
  // %x1f (unit separator) — a subject may contain anything, including the spaces that make
  // --oneline unparseable back into fields.
  const out = gitOutput(root, ['log', '--no-decorate', '--format=%h%x1f%ct%x1f%s', `${from}..${to}`], execFn);
  if (!out) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  return out
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      const [sha = '', ctRaw = '', ...rest] = raw.split('\x1f');
      const subject = rest.join('\x1f');
      const ct = Number(ctRaw);
      // Eligible once its age reaches the quiet window: at ct + quietSec. Unknown/disabled
      // quiet window ⇒ 0 (nothing is being held back by age).
      const eligibleInSec = quietSec && Number.isFinite(ct) ? Math.max(0, ct + quietSec - nowSec) : 0;
      return { line: `${sha} ${subject}`.trim(), sha, subject, eligibleInSec };
    });
}

/** P-004: the FILES the `(from, to]` window touches — `commitsBetweenSync` in path-space. */
function pathsBetweenSync(root: string, from: string, to: string, execFn: ExecSyncLike): string[] {
  if (from === to) return [];
  const out = gitOutput(root, ['diff', '--name-only', from, to], execFn);
  return out ? [...new Set(out.split('\n').filter(Boolean))] : [];
}

/** WI-5124: exported so `launchDetachedCheckpoint` can report `willJudge` on a fresh launch,
 *  not just (via `checkActiveCheckpointRun`) on an already-running refusal. Same quiet-cut
 *  resolution the run itself applies (green-checkpoint.ts's inline logic) — kept as a
 *  SEPARATE sync/execFn-based implementation rather than importing apps/operator/lib/release's
 *  async git-ops one: this operator-core module must not depend on apps/operator (the wrong
 *  dependency direction — see checkpointPipelineName's comment for the same constraint). */
export function currentCheckpointCandidate(
  root: string,
  execFn: ExecSyncLike = defaultExecSync,
): {
  current_head: string | null;
  current_candidate: string | null;
  quiet_cut_sec: number | null;
} {
  const currentHead = gitOutput(root, ['rev-parse', 'HEAD'], execFn);
  if (!currentHead) return { current_head: null, current_candidate: null, quiet_cut_sec: null };

  const quietSec = quietCutSecFromEnv();
  if (quietSec <= 0) return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };

  const tipTimeRaw = gitOutput(root, ['show', '-s', '--format=%ct', currentHead], execFn);
  const tipTime = tipTimeRaw == null ? NaN : Number(tipTimeRaw);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tipTime) || nowSec - tipTime >= quietSec) {
    return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };
  }

  const cutoff = String(nowSec - quietSec);
  const aged = gitOutput(root, ['rev-list', '-1', `--before=@${cutoff}`, 'HEAD'], execFn);
  if (!aged || aged === currentHead)
    return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };

  const ready = gitOutput(root, ['rev-parse', '--verify', 'ready'], execFn);
  if (ready && !gitOk(root, ['merge-base', '--is-ancestor', ready, aged], execFn)) {
    return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };
  }

  return { current_head: currentHead, current_candidate: aged, quiet_cut_sec: quietSec };
}

/**
 * EI-21047439235631660 — prove that a checkpoint candidate contains a caller-required
 * ancestor BEFORE spending the singleton gate run.
 *
 * This is deliberately a git-ancestry check, not a path/content heuristic: release safety
 * decisions name exact repair SHAs, and a detached frozen-repair head can carry superficially
 * similar bytes while living on a lineage that predates the required repair. Resolve both
 * inputs to commits first so an invalid/missing object is reported as `unverifiable`, never
 * conflated with the measured `not-ancestor` verdict from merge-base exit 1.
 */
export interface CheckpointRequiredAncestorCheck {
  ok: boolean;
  reason: 'contained' | 'not-ancestor' | 'unverifiable';
  requiredAncestor: string | null;
  candidate: string | null;
}

export function checkpointCandidateContainsAncestor(
  root: string,
  requiredAncestor: string,
  candidate: string,
  execFn: ExecSyncLike = defaultExecSync,
): CheckpointRequiredAncestorCheck {
  const ancestor = gitOutput(root, ['rev-parse', '--verify', `${requiredAncestor}^{commit}`], execFn);
  const resolvedCandidate = gitOutput(root, ['rev-parse', '--verify', `${candidate}^{commit}`], execFn);
  if (!ancestor || !resolvedCandidate) {
    return {
      ok: false,
      reason: 'unverifiable',
      requiredAncestor: ancestor,
      candidate: resolvedCandidate,
    };
  }
  const contained = gitOk(root, ['merge-base', '--is-ancestor', ancestor, resolvedCandidate], execFn);
  return {
    ok: contained,
    reason: contained ? 'contained' : 'not-ancestor',
    requiredAncestor: ancestor,
    candidate: resolvedCandidate,
  };
}

/** Default MainPID liveness probe: `kill(pid, 0)` — succeeds iff a process with that PID
 *  currently exists (and we have permission to signal it), without actually signalling it.
 *  Injectable so `checkActiveCheckpointRun` is unit-testable without touching real PIDs. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (genuinely dead). EPERM means a process WITH that PID exists
    // but we can't signal it (e.g. owned by another user) — that still proves it's alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Mirrors green-checkpoint.ts's PER-ROOT run-lock dir hash+path
 *  (apps/operator/lib/release/green-checkpoint.ts's `checkpointRunLockDir`) — duplicated here,
 *  READ-ONLY, for the same "operator-core must not depend on apps/operator" reason
 *  `checkpointPipelineName`/`checkpointUnitForRoot` already duplicate their own hash (see
 *  those doc comments). Keep the hash algorithm and the `.green-checkpoint-run-<hash>.lock`
 *  name in sync BY HAND with green-checkpoint.ts — a drift here means this probe silently
 *  checks the wrong path and always reports "not held", even while a real run holds the lock. */
function checkpointRunLockDirMirror(logDir: string, root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return path.join(logDir, `.green-checkpoint-run-${h.toString(36)}.lock`);
}

/** Mirrors release-config.ts's `checkpointLogDir` default resolution (env override, else
 *  `~/.papercusp/checkpoint-logs`) — same duplication rationale as the lock-dir mirror above. */
function checkpointLogDirFromEnv(): string {
  return process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ?? path.join(homedir(), '.papercusp', 'checkpoint-logs');
}

/** Mirrors release-config.ts's `checkpointRoot` derivation (env override, else
 *  `<parent-of-root>/<basename(root)>-checkpoint`) — same duplication rationale as the
 *  log-dir/lock-dir mirrors above (operator-core must not depend on apps/operator).
 *
 * EI-18695275971973546: used ONLY to resolve the ACTUAL in-flight candidate when a run is
 * `held_externally` (the hourly cron tick holds the run-lock, not our manual unit, so we have
 * no log to parse a candidate from). Reading that tree's HEAD *is* reading the true judged
 * candidate, not a guess. Best-effort: a missing/mid-checkout tree just means `candidate` stays
 * null, same as before this fix.
 *
 * ⚠ EI-19327704778173646 — CORRECTION. This comment previously claimed the checkout is "pinned
 * to its judged candidate for the run's WHOLE duration (setupTree checks it out once, up
 * front)". That is FALSE. On a stale red, green-checkpoint.ts recurses into
 * `runGreenCheckpoint({ candidate: tip, refireAttempts: +1 })` IN-PROCESS and the recursion
 * re-enters `setupTree(candidate)` — re-pinning this very tree mid-run. So HEAD here is a LIVE
 * read of a pin that can legitimately MOVE: two reads of the same run can return different
 * shas, and the second is the correct one. That is a healthy auto-refire, not corruption — do
 * not conclude the field is bogus (and above all do not fire a manual run over it: that
 * discards the in-flight rescue and costs a full suite). Unlike the manual-unit path, this one
 * always reports the CURRENT candidate; it simply cannot say what the run started on. */
export function checkpointRootMirror(root: string): string {
  return process.env.PAPERCUSP_CHECKPOINT_ROOT ?? path.join(path.dirname(root), `${path.basename(root)}-checkpoint`);
}

/** Default reader for the run-lock's `owner.json` — real fs; injectable for tests. Never
 *  throws: a missing/unreadable/malformed lock file just means "not held" (the common case —
 *  most of the time nothing is running). */
function defaultReadLockOwner(lockDir: string): { pid?: number; startedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as { pid?: number; startedAt?: string };
  } catch {
    return null;
  }
}

/**
 * Read the OS process-start instant for a PID when the host exposes Linux procfs.
 *
 * The run-lock records the wall-clock instant at which its owner acquired the lock. A
 * recycled PID can pass `kill(pid, 0)` while belonging to a process that started AFTER that
 * instant, so liveness alone is not an identity check. Procfs is deliberately best-effort:
 * non-Linux hosts and restricted procfs fall back to the existing PID probe rather than
 * turning an unreadable identity hint into a confident idle verdict.
 */
function defaultReadProcessStartMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
    // After the comm field, fields[0] is stat field 3 (state); starttime is field 22.
    const startTicks = Number(fields[19]);
    const uptimeSec = Number(readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return null;
    const clockTicksPerSecond = 100;
    return Date.now() - uptimeSec * 1000 + (startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

/** Defined in the dependency-free leaf ./release-checkpoint-lock (WI-10005170) and
 * re-exported here so existing importers keep working. New importers that need only
 * this number should import the leaf: importing this module drags its whole static
 * graph, including release-checkpoint-config.ts's module-scope database read. */
export { CHECKPOINT_RUN_LOCK_STALE_MS };

/** Procfs start times and lock timestamps use different clocks/precision on some hosts. A
 * small allowance avoids rejecting the genuine owner when it acquired the lock immediately
 * after process start, while still rejecting a recycled PID that started materially later. */
const PROCESS_START_AFTER_LOCK_TOLERANCE_MS = 5_000;

/** EI-18757156963245979: the run-lock's `phase.json` shape — the marker the RUN itself
 *  publishes (green-checkpoint.ts's `writeCheckpointRunPhase`) when it leaves the suite and
 *  enters the verdict path. */
export interface CheckpointRunPhase {
  phase?: string;
  at?: string;
}

/** Default reader for the run-lock's `phase.json`. Real fs; injectable for tests. Never throws:
 *  a missing or malformed marker returns null and the replace decision degrades to the age test
 *  alone. */
function defaultReadRunPhase(lockDir: string): CheckpointRunPhase | null {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'phase.json'), 'utf8')) as CheckpointRunPhase;
  } catch {
    return null;
  }
}

/**
 * Read a checkpoint run's published phase without spawning a subprocess.
 *
 * This is intentionally separate from the systemd-facing `checkActiveCheckpointRun`: the
 * process-level watchdog needs the same cheap, per-root marker for cron and manual runs alike.
 * A missing/unreadable phase is UNKNOWN and therefore returns null; callers must fail open and
 * retain their ordinary stall decision rather than treating an unreadable marker as `delivering`.
 * `checkpointLogDir` is injectable because per-hive gates route their run locks into a
 * slug-specific log directory while the operator-home gate uses the ambient default.
 */
export function readCheckpointRunPhaseCheap(
  root: string,
  checkpointLogDir: string = checkpointLogDirFromEnv(),
  readRunPhase: (lockDir: string) => CheckpointRunPhase | null = defaultReadRunPhase,
): CheckpointRunPhase | null {
  const lockDir = checkpointRunLockDirMirror(checkpointLogDir, root);
  try {
    return readRunPhase(lockDir);
  } catch {
    return null;
  }
}

/** Keep the already-running reply honest about what its ETA measures. Once the run publishes
 *  `delivering`, the suite is complete and the remaining systemd runtime is unrelated to the
 *  time-to-verdict. There is no bounded delivery estimate to substitute, so return null rather
 *  than a number that invites callers to kill a healthy self-healing run. */
function checkpointEta(
  elapsedSec: number | null,
  delivering: boolean,
): { eta_sec: number | null; eta_basis: 'full-suite' | 'delivery-phase' } {
  return delivering
    ? { eta_sec: null, eta_basis: 'delivery-phase' }
    : {
        eta_sec: elapsedSec != null ? Math.max(0, CHECKPOINT_MAX_RUNTIME_SEC - elapsedSec) : null,
        eta_basis: 'full-suite',
      };
}

/**
 * WI-5685 root fix: is the green-checkpoint RUN LOCK — the file-based, per-root lock
 * `acquireCheckpointRunLock` in green-checkpoint.ts serializes EVERY invocation on, cron
 * (spawned as a plain child by release-actions.ts's `runScript`, no systemd unit at all) and
 * manual (`release:checkpoint-run`'s detached systemd unit) alike — currently held by a LIVE
 * process, regardless of whether that process is the manual unit `checkActiveCheckpointRun`
 * already knows how to see?
 *
 * This is the check `checkActiveCheckpointRun` was missing: it only ever probed the MANUAL
 * unit's own systemd state, so a launch fired while the HOURLY CRON tick held the (unit-less)
 * run lock sailed straight past that probe, `systemd-run` happily started a brand-new detached
 * process, and THAT process immediately lost the race for the exact same lock file and exited
 * `skipped-locked` within about a second — after `release:checkpoint-run` had already replied
 * `launched:true`. Two consecutive manual fires burned two full `checkpoint:await` windows this
 * way with zero verdict ever produced (WI-5685 evidence, 2026-07-20/21).
 */
function checkRunLockHeld(
  root: string,
  pidAlive: (pid: number) => boolean,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null,
  readProcessStartMs: (pid: number) => number | null = defaultReadProcessStartMs,
  checkpointLogDir: string = checkpointLogDirFromEnv(),
): { held: boolean; pid?: number | null; started_at?: string | null; elapsed_sec?: number | null } {
  const lockDir = checkpointRunLockDirMirror(checkpointLogDir, root);
  const owner = readLockOwner(lockDir);
  if (!owner || typeof owner.pid !== 'number' || !pidAlive(owner.pid)) return { held: false };
  const startedMs = owner.startedAt ? Date.parse(owner.startedAt) : NaN;
  if (Number.isFinite(startedMs)) {
    const ageMs = Date.now() - startedMs;
    if (ageMs > CHECKPOINT_RUN_LOCK_STALE_MS) return { held: false };

    const processStartedMs = readProcessStartMs(owner.pid);
    if (Number.isFinite(processStartedMs) && processStartedMs! > startedMs + PROCESS_START_AFTER_LOCK_TOLERANCE_MS) {
      // kill(pid, 0) proved only that *a* process exists. Its start time proves it cannot be
      // the process that wrote this lock, so treating the lock as held would resurrect the
      // recycled-PID false positive that wedged dev:pipeline_position and checkpoint:run.
      return { held: false };
    }
  }
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  return { held: true, pid: owner.pid, started_at: owner.startedAt ?? null, elapsed_sec: elapsedSec };
}

/**
 * WI-4310: a CHEAP (no subprocess) "is a green-checkpoint run active right now" probe —
 * just `checkRunLockHeld` with real defaults wired in. Unlike `checkActiveCheckpointRun`
 * below (which forks `systemctl show` for the manual-unit ActiveState check), this reads
 * only the file-based run-lock's `owner.json`, so it is cheap enough for a HOT health-panel
 * read path (git-pipeline-stats.ts's `includeActiveRun` gate exists precisely because the
 * systemctl fork is NOT cheap enough for that — see its doc comment) — e.g. the workFeed
 * dead-routine window (system-health/compute.ts), which needs "is the checkpoint's known,
 * self-recovering resource footprint active right now" on every computation, not just an
 * opt-in background snapshot.
 *
 * Deliberately narrower than `checkActiveCheckpointRun`: it misses a manual-unit run that
 * hasn't (yet) raced for the shared run-lock, but every run — manual or cron — holds the
 * SAME lock for the run's whole duration (`acquireCheckpointRunLock` in green-checkpoint.ts),
 * so in practice this sees every genuinely in-flight suite. Fail-soft: `defaultReadLockOwner`
 * never throws (a missing/unreadable lock file just reads as "not held").
 */
export function isCheckpointRunLockHeldCheap(
  root: string,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
  readProcessStartMs: (pid: number) => number | null = defaultReadProcessStartMs,
  checkpointLogDir: string = checkpointLogDirFromEnv(),
): { held: boolean; pid?: number; elapsedSec: number | null } {
  const r = checkRunLockHeld(root, pidAlive, readLockOwner, readProcessStartMs, checkpointLogDir);
  // Keep the existing cheap shape for the clear path, but expose the verified owner PID when
  // held. Consumers that need to reason about the run's mechanism (rather than merely its
  // liveness) can now inspect /proc/<pid> without re-reading owner.json or racing a recycled PID.
  return r.held
    ? { held: true, pid: r.pid ?? undefined, elapsedSec: r.elapsed_sec ?? null }
    : { held: false, elapsedSec: null };
}

export interface CheckpointProcessAuthorityReading {
  active: boolean;
  probeFailed: boolean;
  /** Exact procfs leg that made the fail-closed reading indeterminate, when one failed. */
  probeDetail?: string;
  pid: number | null;
  startedAtMs: number | null;
  elapsedSec: number | null;
  cgroupPath: string | null;
  workspace: string | null;
  harness: string | null;
}

/** An authority reading whose four IDENTITY fields are proven present.
 *
 *  The census above only pushes a match after establishing every one of them — a non-empty
 *  `PAPERCUSP_GATE_VERDICT_*` workspace/harness stamp, a resolvable unified cgroup path, and a
 *  real pid from the process list — so an `active: true` reading always satisfies this in fact.
 *  The flat interface cannot express that per-field, which is why the identity fields are typed
 *  `| null` for the inactive/probe-failed branches that legitimately carry nulls. */
export type IdentifiedCheckpointProcessAuthority = CheckpointProcessAuthorityReading & {
  pid: number;
  cgroupPath: string;
  workspace: string;
  harness: string;
};

/** Narrow a reading to {@link IdentifiedCheckpointProcessAuthority}.
 *
 *  Publish `pre_lock_authority` only through this guard. Its contract is that all four fields
 *  are non-null strings/number, and a reading that fails the guard must OMIT the stamp rather
 *  than emit a partial one — a `null` coerced into a `string` slot would tell a caller a
 *  checkpoint process was identified when it was not. */
export function hasCheckpointProcessAuthorityIdentity(
  reading: CheckpointProcessAuthorityReading,
): reading is IdentifiedCheckpointProcessAuthority {
  return reading.pid !== null && reading.cgroupPath !== null && reading.workspace !== null && reading.harness !== null;
}

/** Keep the pre-lock authority read below the status surface's larger probe budget. */
export const CHECKPOINT_PROCESS_AUTHORITY_PROBE_TIMEOUT_MS = 1_000;

/**
 * Tolerate an individual procfs read briefly losing to host I/O pressure while the global
 * census deadline still bounds the launch path. The broad environment pass is bounded below.
 */
export const CHECKPOINT_PROCESS_AUTHORITY_READ_TIMEOUT_MS = 250;

/**
 * Keep the /proc census fast enough for the one-second launch budget without creating one
 * outstanding filesystem operation per process on a busy host. The cgroup pass is the broad
 * phase; environment and process-start reads only run for authority/root matches.
 */
export const CHECKPOINT_PROCESS_AUTHORITY_SCAN_CONCURRENCY = 384;

type ProbeAwaitable<T> = T | PromiseLike<T>;

function isPromiseLike<T>(value: ProbeAwaitable<T>): value is PromiseLike<T> {
  // Null-safe: a synchronous seam may legitimately answer `null` (the restricted-hold fence's
  // "nothing held", WI-10005763), and reading `.then` off it would throw.
  return value != null && typeof (value as PromiseLike<T>).then === 'function';
}

export interface CheckpointProcessAuthorityProbeDeps {
  listPids?: () => ProbeAwaitable<number[]>;
  readEnvironment?: (pid: number) => ProbeAwaitable<string | null>;
  /**
   * The cgroup is the broad filter across every host PID. Keep this synchronous: Linux
   * synthesizes /proc/<pid>/cgroup in memory, while thousands of async readFile requests
   * queue behind unrelated libuv work and can exhaust the whole census deadline before an
   * unrelated PID is excluded.
   */
  readCgroup?: (pid: number) => string | null;
  readProcessStartMs?: (pid: number) => ProbeAwaitable<number | null>;
  nowMs?: () => number;
  /** Override the total census budget in tests or a caller with a tighter deadline. */
  totalTimeoutMs?: number;
  /** Override the per-operation budget in tests or a caller with a tighter deadline. */
  perReadTimeoutMs?: number;
  /** Override the bounded number of PIDs scanned concurrently. */
  maxConcurrentReads?: number;
}

/** Injectable launch-time seam for the async pre-lock authority census. */
export type CheckpointProcessAuthorityReader = (
  root: string,
) => CheckpointProcessAuthorityReading | PromiseLike<CheckpointProcessAuthorityReading>;

async function defaultListProcPids(): Promise<number[]> {
  const entries = await readdirAsync('/proc', { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name));
}

async function defaultReadProcFile(pid: number, name: 'environ' | 'cgroup'): Promise<string | null> {
  try {
    return await readFileAsync(`/proc/${pid}/${name}`, 'utf8');
  } catch {
    // A process may exit between the directory listing and this read. That row simply
    // stopped being evidence; it does not poison the rest of the procfs census.
    return null;
  }
}

/**
 * Synchronous on purpose: this is the cheap OS-owned broad filter over every PID. Unlike
 * `/proc/<pid>/environ`, cgroup is a tiny kernel-generated virtual file. Reading it inline
 * avoids leaving thousands of uncancellable fs.promises requests queued after the one-second
 * authority census has already returned.
 */
function defaultReadProcCgroup(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  } catch {
    // The PID may disappear between enumeration and this read. That is absence of evidence,
    // not a failed authority probe.
    return null;
  }
}

/** Async counterpart used only by the bounded authority probe. The synchronous process-start
 * reader above remains the lock probe's cheap PID-identity hint and must not be widened into
 * this census. */
async function defaultReadProcessStartMsAsync(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const [stat, uptime] = await Promise.all([
      readFileAsync(`/proc/${pid}/stat`, 'utf8'),
      readFileAsync('/proc/uptime', 'utf8'),
    ]);
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
    // After the comm field, fields[0] is stat field 3 (state); starttime is field 22.
    const startTicks = Number(fields[19]);
    const uptimeSec = Number(uptime.trim().split(/\s+/)[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return null;
    const clockTicksPerSecond = 100;
    return Date.now() - uptimeSec * 1000 + (startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

type ProbeReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout'; timeoutMs: number }
  | { status: 'error'; error: string };

const PROC_PROBE_TIMEOUT = Symbol('checkpoint-process-authority-timeout');

function probeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/** Race one async procfs operation against a deadline. The underlying fs request may finish
 * later (Node's fs API has no universal cancellation seam), but the caller never waits for it
 * and its rejection is consumed so a late procfs failure cannot become an unhandled rejection. */
async function readProcWithTimeout<T>(
  operation: () => ProbeAwaitable<T>,
  timeoutMs: number,
): Promise<ProbeReadResult<T>> {
  const work = Promise.resolve().then(operation);
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PROC_PROBE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(PROC_PROBE_TIMEOUT), Math.max(1, timeoutMs));
  });
  try {
    const result = await Promise.race([work, timeout]);
    return result === PROC_PROBE_TIMEOUT ? { status: 'timeout', timeoutMs } : { status: 'ok', value: result as T };
  } catch (error) {
    return { status: 'error', error: probeErrorMessage(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unknownCheckpointProcessAuthority(probeDetail?: string): CheckpointProcessAuthorityReading {
  return {
    active: false,
    probeFailed: true,
    ...(probeDetail ? { probeDetail } : {}),
    pid: null,
    startedAtMs: null,
    elapsedSec: null,
    cgroupPath: null,
    workspace: null,
    harness: null,
  };
}

function probeReadFailureDetail<T>(label: string, result: Exclude<ProbeReadResult<T>, { status: 'ok' }>): string {
  return result.status === 'timeout'
    ? `${label} timed out after ${result.timeoutMs}ms`
    : `${label} failed: ${result.error}`;
}

function nulEnvironment(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

function unifiedCgroupPath(raw: string): string | null {
  const value = raw
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
    .trim();
  return value && value.startsWith('/') ? value : null;
}

/** A process carrying the gate stamps is only a checkpoint authority when systemd placed it
 * inside this root's transient manual-checkpoint unit. Environment is inherited by every child
 * and can be copied by an unrelated process; the unit cgroup is the launcher's OS-owned boundary.
 * Compare path segments, rather than using `includes`, so a similarly-named sibling unit cannot
 * satisfy the identity check. Descendant cgroups remain valid because they retain the unit's
 * service segment as their ancestor. */
function checkpointCgroupContainsUnit(cgroupPath: string, unit: string): boolean {
  return cgroupPath.split('/').includes(`${unit}.service`);
}

/**
 * P-009 / WI-41252: find a gate-owned process during the startup interval before
 * `green-checkpoint.ts` acquires its shared run-lock or publishes a candidate.
 *
 * The identity deliberately uses the launcher's OS-owned unit boundary plus the gate stamps and
 * ZERO argv:
 *  - authority: both gate-verdict target stamps are present;
 *  - environment: PAPERCUSP_INTEGRATION_ROOT resolves to the root being queried;
 *  - cgroup: the process belongs to this root's per-root manual-checkpoint service cgroup.
 *
 * An agent prompt or a status command can mention every checkpoint token in argv, so
 * argv matching is not liveness evidence. Descendants inherit the authority stamps and stay
 * valid when nested below the checkpoint service cgroup; an unrelated agent scope does not.
 * A failed procfs census is UNKNOWN, never a confident idle reading.
 */
export async function readCheckpointProcessAuthorityCheap(
  root: string,
  deps: CheckpointProcessAuthorityProbeDeps = {},
): Promise<CheckpointProcessAuthorityReading> {
  const listPids = deps.listPids ?? defaultListProcPids;
  const readEnvironment = deps.readEnvironment ?? ((pid: number) => defaultReadProcFile(pid, 'environ'));
  const readCgroup = deps.readCgroup ?? defaultReadProcCgroup;
  const readProcessStartMs = deps.readProcessStartMs ?? defaultReadProcessStartMsAsync;
  const nowMs = (deps.nowMs ?? Date.now)();
  const totalTimeoutMs = Math.max(1, deps.totalTimeoutMs ?? CHECKPOINT_PROCESS_AUTHORITY_PROBE_TIMEOUT_MS);
  const perReadTimeoutMs = Math.max(1, deps.perReadTimeoutMs ?? CHECKPOINT_PROCESS_AUTHORITY_READ_TIMEOUT_MS);
  const requestedConcurrency = deps.maxConcurrentReads ?? CHECKPOINT_PROCESS_AUTHORITY_SCAN_CONCURRENCY;
  const scanConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : CHECKPOINT_PROCESS_AUTHORITY_SCAN_CONCURRENCY;
  const deadlineMs = Date.now() + totalTimeoutMs;
  const remainingMs = () => deadlineMs - Date.now();
  const readBounded = <T>(operation: () => ProbeAwaitable<T>, timeoutBudgetMs = perReadTimeoutMs) => {
    const remaining = remainingMs();
    return remaining > 0
      ? readProcWithTimeout(operation, Math.min(timeoutBudgetMs, remaining))
      : Promise.resolve<ProbeReadResult<T>>({ status: 'timeout', timeoutMs: 0 });
  };

  const listed = await readBounded(listPids);
  if (listed.status !== 'ok') {
    return unknownCheckpointProcessAuthority(probeReadFailureDetail('procfs PID enumeration', listed));
  }
  if (!Array.isArray(listed.value)) {
    return unknownCheckpointProcessAuthority('procfs PID enumeration returned a non-array result');
  }
  const pids = listed.value;

  const expectedRoot = path.resolve(root);
  const expectedCheckpointUnit = checkpointUnitForRoot(expectedRoot);
  type ProcessAuthorityMatch = Omit<CheckpointProcessAuthorityReading, 'active' | 'probeFailed' | 'probeDetail'>;
  type ProcessAuthorityScan =
    | { status: 'ok'; match: ProcessAuthorityMatch | null }
    | { status: 'failed'; detail: string };
  const scanPid = async (pid: number): Promise<ProcessAuthorityScan> => {
    // The cgroup is the OS-owned authority boundary. Read it before the inherited environment
    // so an unrelated PID whose /proc/<pid>/environ read is delayed cannot consume the census
    // budget or turn an otherwise-idle gate into an indeterminate reading.
    let rawCgroup: string | null;
    try {
      rawCgroup = readCgroup(pid);
    } catch (error) {
      return {
        status: 'failed',
        detail: `cgroup read for pid ${pid} failed: ${probeErrorMessage(error)}`,
      };
    }
    if (rawCgroup === null) return { status: 'ok', match: null };
    const cgroupPath = unifiedCgroupPath(rawCgroup);
    if (!cgroupPath || !checkpointCgroupContainsUnit(cgroupPath, expectedCheckpointUnit)) {
      return { status: 'ok', match: null };
    }

    // Only a process in the exact checkpoint unit can be authoritative. Its inherited env is
    // now a candidate-specific read, so a delayed unrelated /proc environment entry is ignored
    // while a failed candidate read still fails closed.
    const environment = await readBounded(() => readEnvironment(pid));
    if (environment.status !== 'ok') {
      return {
        status: 'failed',
        detail: probeReadFailureDetail(`environment read for pid ${pid}`, environment),
      };
    }
    const rawEnv = environment.value;
    if (rawEnv === null) return { status: 'ok', match: null };
    const env = nulEnvironment(rawEnv);
    const workspace = (env.get(GATE_VERDICT_WORKSPACE_ENV) ?? '').trim();
    const harness = (env.get(GATE_VERDICT_HARNESS_ENV) ?? '').trim();
    const integrationRoot = (env.get('PAPERCUSP_INTEGRATION_ROOT') ?? '').trim();
    if (!workspace || !harness || !integrationRoot) return { status: 'ok', match: null };
    if (path.resolve(integrationRoot) !== expectedRoot) return { status: 'ok', match: null };

    const start = await readBounded(() => readProcessStartMs(pid));
    if (start.status !== 'ok') {
      return {
        status: 'failed',
        detail: probeReadFailureDetail(`process start-time read for pid ${pid}`, start),
      };
    }
    const startedAtMs = start.value;
    const elapsedSec = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((nowMs - startedAtMs!) / 1000)) : null;
    // A process tree that somehow retained the launch stamps past the run-lock's own
    // hard stale horizon must not wedge the gate forever. The same bound guards the
    // canonical lock owner above; an unmeasured start remains positive live evidence.
    if (elapsedSec !== null && elapsedSec * 1000 > CHECKPOINT_RUN_LOCK_STALE_MS) return { status: 'ok', match: null };
    return { status: 'ok', match: { pid, startedAtMs, elapsedSec, cgroupPath, workspace, harness } };
  };

  const matches: ProcessAuthorityMatch[] = [];
  let nextPidIndex = 0;
  let scannedCount = 0;
  let failureDetail: string | null = null;
  const totalTimeoutDetail = () =>
    `process-authority census exceeded total timeout of ${totalTimeoutMs}ms after ${scannedCount}/${pids.length} PID scans`;
  const scanWorker = async (): Promise<void> => {
    while (failureDetail === null) {
      if (remainingMs() <= 0) {
        failureDetail = totalTimeoutDetail();
        return;
      }
      const index = nextPidIndex++;
      if (index >= pids.length) return;
      const result = await scanPid(pids[index]!);
      scannedCount += 1;
      if (result.status === 'failed') {
        failureDetail = result.detail;
        return;
      }
      if (result.match) matches.push(result.match);
    }
  };
  const workerCount = Math.min(scanConcurrency, pids.length);
  await Promise.all(Array.from({ length: workerCount }, () => scanWorker()));
  if (failureDetail !== null) return unknownCheckpointProcessAuthority(failureDetail);

  matches.sort(
    (a, b) =>
      (a.startedAtMs ?? Number.POSITIVE_INFINITY) - (b.startedAtMs ?? Number.POSITIVE_INFINITY) ||
      (a.pid ?? Number.MAX_SAFE_INTEGER) - (b.pid ?? Number.MAX_SAFE_INTEGER),
  );
  const match = matches[0];
  if (remainingMs() <= 0) return unknownCheckpointProcessAuthority(totalTimeoutDetail());
  return match
    ? { active: true, probeFailed: false, ...match }
    : {
        active: false,
        probeFailed: false,
        pid: null,
        startedAtMs: null,
        elapsedSec: null,
        cgroupPath: null,
        workspace: null,
        harness: null,
      };
}

/**
 * Detect whether a manual checkpoint run for `root` is CURRENTLY ACTIVE, before we'd try to
 * launch a new one (WI-1562). Reads systemd's live unit state directly — rather than firing
 * `systemd-run` and parsing its refusal — so the caller gets a STRUCTURED answer (unit,
 * candidate, started_at, eta_sec) proactively instead of a bare "exited 1" string, and so
 * `launchDetachedCheckpoint` never has to attempt (and fail) the spawn just to find out.
 *
 * EI-9180: under extreme host load, systemd's own `--user` manager bookkeeping can lag well
 * behind reality (observed: an 18h phantom-wedge — ActiveState kept reading 'active' for a run
 * whose process was already gone, and every re-fire got refused with a stable, unchanging
 * started_at/eta_sec from the original dead run). Trusting ActiveState alone lets a KILLED run
 * (OOM, a manual `kill -9` outside systemd, a host-load-starved systemd manager that hasn't
 * processed the child's SIGCHLD yet) permanently wedge the gate — nothing self-heals it short of
 * an agent noticing and passing `force:true`. Cross-check with a real OS-level liveness probe
 * (`kill(pid, 0)`) on the unit's own MainPID: if systemd still claims 'active' but the PID it
 * itself reports is provably gone, the ActiveState is stale — treat the run as NOT active so the
 * gate self-heals on the very next fire instead of staying wedged until someone force-bypasses it.
 */
export function checkActiveCheckpointRun(
  root: string,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
  readRunPhase: (lockDir: string) => { phase?: string; at?: string } | null = defaultReadRunPhase,
  // EI-19327704778173646. Appended LAST and defaulted so every existing caller and test —
  // all of which pass positionally and stop at `readRunPhase` — is unaffected: they get the
  // real-file reader, which returns null for the synthetic paths tests use, degrading to the
  // previous head-only behaviour.
  readLogTail: (logPath: string) => string | null = defaultReadLogTail,
  readProcessStartMs: (pid: number) => number | null = defaultReadProcessStartMs,
  readLogMtime: (logPath: string) => number | null = defaultReadLogMtime,
): ActiveCheckpointCheck {
  const unit = checkpointUnitForRoot(root);
  const systemctlArgv = [
    '--user',
    'show',
    `${unit}.service`,
    '--property=ActiveState',
    '--property=ExecMainStartTimestamp',
    '--property=MainPID',
    '--property=LoadState',
    '--property=InvocationID',
  ];
  const r = execFn('systemctl', systemctlArgv, { timeout: CHECKPOINT_SYSTEMCTL_PROBE_TIMEOUT_MS });
  const props = parseSystemctlShow(r.stdout);
  const loadState = props.LoadState ?? null;
  const systemd: CheckpointSystemdProbe = {
    scope: 'user',
    argv: [...systemctlArgv],
    load_state: loadState,
    known: loadState === null ? null : loadState === 'loaded',
    invocation_id: props.InvocationID || null,
  };
  const activeState = props.ActiveState ?? '';
  // WI-6962: a negative is only believable when the probe itself succeeded. `systemctl --user
  // show` exits 0 and emits `ActiveState=inactive` even for a unit it has never heard of
  // (measured 2026-08-02), so a well-formed "nothing is running" ALWAYS carries an
  // `ActiveState` key. Absence of that key — or a non-zero exit — therefore means the probe
  // FAILED, and the previous code's `props.ActiveState ?? ''` silently turned exactly that
  // case into a confident negative. See `probe_failed` for the harm.
  if (r.status !== 0 || !Object.prototype.hasOwnProperty.call(props, 'ActiveState')) {
    // The run-lock is an INDEPENDENT oracle (a plain file read, no fork), so consult it before
    // giving up: it is what keeps a transiently-unforkable host from wedging the gate shut.
    const lockHeld = checkRunLockHeld(root, pidAlive, readLockOwner, readProcessStartMs);
    const runPhase = lockHeld.held ? readRunPhase(checkpointRunLockDirMirror(checkpointLogDirFromEnv(), root)) : null;
    const progressAt = checkpointProgressAtMs({
      phaseAt: runPhase?.at,
      startedAtMs: timestampMs(lockHeld.started_at),
    });
    const detail =
      `systemctl show exited ${r.status ?? 'null (spawn failed)'}` +
      `${Object.prototype.hasOwnProperty.call(props, 'ActiveState') ? '' : ' without an ActiveState property'}` +
      `${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`;
    return {
      active: true,
      unit,
      systemd,
      probe_failed: true,
      probe_detail: detail,
      ...(lockHeld.held
        ? {
            started_at: lockHeld.started_at ?? null,
            elapsed_sec: lockHeld.elapsed_sec ?? null,
            ...(progressAt != null ? { progress_at: isoTimestampOrNull(progressAt) } : {}),
            ...(runPhase?.phase ? { current_phase: runPhase.phase } : {}),
            held_externally: true,
          }
        : {}),
      // Never replaceable: `candidate_stale` is what unlocks a stop, and we cannot know the
      // candidate when we could not even read the unit's state.
      candidate_stale: false,
    };
  }
  // 'active' = running; 'activating'/'reloading' = transient states of the same live unit.
  // A NEVER-STARTED or GC'd unit shows 'inactive' — a TRUSTED negative, per the probe check above.
  if (activeState !== 'active' && activeState !== 'activating' && activeState !== 'reloading') {
    // WI-5685: the manual unit isn't active, but the shared RUN LOCK might still be held by a
    // process that never went through the manual unit at all (the hourly cron tick — see the
    // checkRunLockHeld doc comment). Cross-check it before declaring nothing active.
    const lockHeld = checkRunLockHeld(root, pidAlive, readLockOwner, readProcessStartMs);
    if (lockHeld.held) {
      const current = currentCheckpointCandidate(root, execFn);
      const runPhase = readRunPhase(checkpointRunLockDirMirror(checkpointLogDirFromEnv(), root));
      const progressAt = checkpointProgressAtMs({
        phaseAt: runPhase?.at,
        startedAtMs: timestampMs(lockHeld.started_at),
      });
      const eta = checkpointEta(lockHeld.elapsed_sec ?? null, runPhase?.phase === 'delivering');
      // EI-18695275971973546: resolve the REAL in-flight candidate from the isolated
      // checkpoint checkout's own HEAD (see checkpointRootMirror's doc comment) instead of
      // reporting `candidate: null` — a null here was being misread as "this run's candidate
      // is unknowable", pushing callers toward `current_candidate` (a HYPOTHETICAL fresh-launch
      // value) as if it described the running suite, which cost a wrong "this can go green"
      // broadcast to the whole fleet. Best-effort: stays null if the checkpoint tree can't be read.
      const externalCandidate = gitOutput(checkpointRootMirror(root), ['rev-parse', 'HEAD'], execFn);
      return {
        active: true,
        unit: `${unit} (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)`,
        systemd,
        candidate: externalCandidate,
        ...current,
        // Deliberately NOT derived from externalCandidate vs current_candidate — see the
        // held_externally doc comment (EI-11667 safety): even a genuinely-stale externally-held
        // run must never be reported replaceable.
        candidate_stale: false,
        started_at: lockHeld.started_at ?? null,
        elapsed_sec: lockHeld.elapsed_sec ?? null,
        ...(progressAt != null ? { progress_at: isoTimestampOrNull(progressAt) } : {}),
        ...(runPhase?.phase ? { current_phase: runPhase.phase } : {}),
        ...eta,
        ...(runPhase?.phase ? { delivering: runPhase.phase === 'delivering' } : {}),
        held_externally: true,
      };
    }
    const terminal = readTerminalState(unit, readLogTail);
    return {
      active: false,
      unit,
      systemd,
      ...(terminal.terminalMarker === undefined ? {} : { terminal_marker: terminal.terminalMarker }),
      ...(terminal.terminalEvidence ? { terminal_evidence: terminal.terminalEvidence } : {}),
    };
  }
  // EI-9180 self-heal: MainPID=0 means systemd has no main process to report (nothing to
  // cross-check — fall through and trust ActiveState as before). A NONZERO MainPID that
  // `kill(pid, 0)` proves is gone means systemd's ActiveState is stale — don't trust it.
  const mainPid = Number(props.MainPID ?? '0');
  if (Number.isFinite(mainPid) && mainPid > 0 && !pidAlive(mainPid)) {
    const terminal = readTerminalState(unit, readLogTail);
    return {
      active: false,
      unit,
      systemd,
      ...(terminal.terminalMarker === undefined ? {} : { terminal_marker: terminal.terminalMarker }),
      ...(terminal.terminalEvidence ? { terminal_evidence: terminal.terminalEvidence } : {}),
    };
  }
  const startedAt =
    props.ExecMainStartTimestamp && props.ExecMainStartTimestamp !== '' ? props.ExecMainStartTimestamp : null;
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  const logPath = `/tmp/${unit}.log`;
  const logHead = readLogHead(logPath);
  // EI-19327704778173646: the head-read can only ever show the FIRST candidate. Prefer the
  // LAST one seen in the log tail — after an in-process auto-refire that is the sha actually
  // being judged, and the first one has been discarded. The tail read is best-effort: when it
  // yields nothing (unreadable/mid-rotation/short log) this degrades to the head's first
  // match, i.e. exactly the pre-EI behaviour.
  const headCandidates = parseCheckpointCandidates(logHead);
  const logTail = readLogTail(logPath);
  const tailCandidates = parseCheckpointCandidates(logTail);
  const firstCandidate = headCandidates[0] ?? tailCandidates[0] ?? null;
  const candidate = tailCandidates[tailCandidates.length - 1] ?? firstCandidate;
  // Only report provenance when the run demonstrably MOVED. Note `candidate` may be an
  // 8-char prefix (green-checkpoint logs `candidate.slice(0, 8)`), so this compares like
  // with like — both sides come from the same log format.
  const refireObserved = candidate != null && firstCandidate != null && candidate !== firstCandidate;
  const current = currentCheckpointCandidate(root, execFn);
  // EI-18757156963245979: read the run's OWN published phase. A run past its suite is in the
  // verdict path (re-triage -> auto-refire -> salvage) and must not be replaced at any age.
  const runPhase = readRunPhase(checkpointRunLockDirMirror(checkpointLogDirFromEnv(), root));
  const progressAt = checkpointProgressAtMs({
    logHead,
    logTail,
    logMtimeMs: readLogMtime(logPath),
    phaseAt: runPhase?.at,
    startedAtMs: Number.isFinite(startedMs) ? startedMs : null,
  });
  const eta = checkpointEta(elapsedSec, runPhase?.phase === 'delivering');
  return {
    active: true,
    unit,
    systemd,
    log_path: logPath,
    candidate,
    // EI-19327704778173646: provenance only when the run actually re-candidated, so the
    // common (no-refire) status reply is byte-for-byte what it was before.
    ...(refireObserved ? { initial_candidate: firstCandidate, refire_observed: true } : {}),
    ...current,
    candidate_stale: Boolean(
      candidate && current.current_candidate && !shaMatches(candidate, current.current_candidate),
    ),
    started_at: startedAt,
    elapsed_sec: elapsedSec,
    ...(progressAt != null ? { progress_at: isoTimestampOrNull(progressAt) } : {}),
    ...(runPhase?.phase ? { current_phase: runPhase.phase } : {}),
    ...eta,
    ...(runPhase?.phase ? { delivering: runPhase.phase === 'delivering' } : {}),
  };
}

/** EI-11667 replace-storm guard: an in-flight run judging a "stale" candidate is the NORMAL
 *  state of a HEALTHY young run on a busy tree — the suite needs ~20-55 min while the tip moves
 *  every few minutes, so `candidate_stale` alone is not evidence of a wedged run. On 2026-07-13
 *  four sus each followed the "pass replaceStale:true" nudge and serially killed each other's
 *  runs (21:25→22:02); no verdict landed and the green pin froze for 2h. replaceStale therefore
 *  only unlocks once the run is old enough that it plausibly SHOULD have verdicted already (the
 *  true EI-9672 wedged-salvage case); younger runs — and runs whose age systemd cannot report —
 *  are refused with `replace_refused_young` so callers wait for the verdict instead.
 *
 *  ⚠ THIS NUMBER IS NOT FREE TO PICK — it is pinned to GREEN_CHECKPOINT_SUITE_TIMEOUT_MS
 *  (release/green-checkpoint-schedule.ts) by release-timing-invariants.test.ts, which is
 *  where the whole gate timing chain is enforced. It was written as a literal here for a
 *  real reason: release-actions.ts, its old home, calls registerSystemAction at module scope
 *  and pulls a large graph (pipeline-events, release-checkpoint-config, dev-data), so
 *  importing it into this low-level launch helper would have dragged that registration side
 *  effect into every consumer of this file. That is fixed at the source — the budget now
 *  lives in release/green-checkpoint-schedule.ts, a leaf with no imports — so this and the
 *  other former copies IMPORT it. Retuning the suite budget moves them automatically; the
 *  test now guards the ORDERING of the genuinely-different numbers in the chain, which is
 *  the part no import can enforce.
 *
 *  It was a literal `20 * 60` for months, which is SIX TIMES tighter than the budget the
 *  system actually grants a run, so
 *  "old enough to plausibly be wedged" was false by construction: every healthy run became
 *  replaceable ~20 min into a suite that is allowed to take 120. WI-38026 measured the
 *  consequence on 2026-08-12 — three consecutive runs SIGTERMed mid-suite, each by a
 *  DIFFERENT su reacting to the same red gate, none reaching a verdict:
 *
 *    01:34:53 judging c4d0f09c → killed at 1317s, superseded by 8365fc24
 *    01:56:49 judging 8365fc24 → killed at 1358s, superseded by d7d7f6de
 *
 *  Each log line read "a replaceStale before producing a verdict". The gate had been red
 *  6.5h and `main` frozen for the whole fleet — with the named test failures ALREADY FIXED
 *  in the tree. No amount of fixing tests can green a gate that is never allowed to finish
 *  judging, which is what makes this a starvation bug and not a tuning preference.
 *
 *  The invariant, stated so it cannot drift again: A RUN STILL INSIDE ITS OWN SUITE BUDGET
 *  IS NOT WEDGED — the system granted it that time, so killing it is destroying work the
 *  system asked for. Replacement therefore cannot unlock before the point at which the run's
 *  own suite would have been terminated (GREEN_CHECKPOINT_SUITE_TIMEOUT_MS). Past that, a
 *  still-running process genuinely is the EI-9672 salvage case. Deriving it also keeps the
 *  two numbers ONE decision: retuning the suite budget now carries this with it.
 *
 *  This is not the only protection — `delivering` (checked FIRST in classifyReplaceRequest)
 *  covers the verdict tail at any age, and an abandoned lock is reclaimed independently via
 *  CHECKPOINT_LOCK_STALE_MS. Enforced by release-timing-invariants.test.ts. */
export const REPLACE_STALE_MIN_AGE_SEC = 120 * 60;

/** Why a `replaceStale:true` request was (not) allowed to stop the in-flight run. */
export type ReplaceDecision = { replace: true } | { replace: false; reason: 'not_stale' | 'young' | 'delivering' };

/** Pure replace policy — extracted so the rule is testable rather than inline in the launch
 *  path (EI-18757156963245979; the bug below shipped precisely because the decision had no
 *  test of its own).
 *
 *  ORDER IS LOAD-BEARING: `delivering` is checked BEFORE the age test, because the two
 *  disagree exactly where it matters. `REPLACE_STALE_MIN_AGE_SEC` encodes "old enough to
 *  plausibly be wedged (past the fastest full-suite duration)" — but on a loaded box the
 *  suite REACHES that duration, so a healthy run crosses the age line at the very moment it
 *  finishes its suite and starts the verdict path. Measured 2026-07-27: candidate e4a93f8b's
 *  suite ran 1180s against the 1200s threshold, so it became "replaceable" ~20s after the
 *  suite ended and a peer's replaceStale call SIGTERMed it 85s into the stale-red re-triage —
 *  discarding the auto-refire that would have re-fired the gate onto a newer tip. Four
 *  consecutive runs died that way; `main` sat 49 commits behind with nothing actually broken.
 *
 *  So age alone is a bad proxy for "wedged": it protects YOUNG runs (which have the most work
 *  left) and kills MATURE ones (which are about to deliver). The run's own published phase is
 *  the direct signal, and it wins. Age remains the fallback for a run that never published a
 *  phase (older build, or wedged before it got that far) — which is also the genuine
 *  EI-9672 salvage case this flag exists for. */
export function classifyReplaceRequest(
  active: Pick<ActiveCheckpointCheck, 'candidate_stale' | 'elapsed_sec' | 'delivering'>,
): ReplaceDecision {
  if (!active.candidate_stale) return { replace: false, reason: 'not_stale' };
  if (active.delivering) return { replace: false, reason: 'delivering' };
  const oldEnough = typeof active.elapsed_sec === 'number' && active.elapsed_sec >= REPLACE_STALE_MIN_AGE_SEC;
  return oldEnough ? { replace: true } : { replace: false, reason: 'young' };
}

/** Pure: the full `systemd-run` argv for the detached green-checkpoint suite. Mirrors
 *  release-deploy-launch.ts's buildSystemdRunArgv (PATH passthrough so the unit doesn't depend
 *  on the systemd-manager env; PAPERCUSP_INTEGRATION_ROOT explicit like the deploy). Exported
 *  for unit-testing the command construction. */
/** The stable, well-known path readers poll (`/tmp/<unit>.log`). It is a SYMLINK to the
 *  newest run's own log — see checkpointRunLogPath. */
export function checkpointLatestLogPath(unit: string): string {
  return `/tmp/${unit}.log`;
}

/** A PER-RUN log path. The gate used to write every run to `/tmp/<unit>.log`, so the
 *  natural response to a red — re-fire — truncated the very output the red was telling
 *  you to read (2026-07-10: run #5's failure detail destroyed by the re-fire it
 *  prompted). Each run now owns a timestamped file; `checkpointLatestLogPath` symlinks
 *  to it, so every existing reader of the stable path keeps working. */
export function checkpointRunLogPath(unit: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `/tmp/${unit}-${stamp}.log`;
}

export function buildCheckpointSystemdArgv(
  root: string,
  logPath: string,
  pathEnv: string,
  partialGreenGate = false,
  /** When given, the run writes HERE and `logPath` is repointed at it as a symlink. */
  runLogPath?: string,
  /** WI-4494: when given, the run RECORDS ITS OWN VERDICT for this harness (gate_health + the
   *  pipeline event) instead of discarding it. Omitted ⇒ pre-WI-4494 behaviour (the caller records
   *  — which for a detached manual run meant nobody did). */
  verdictTarget?: GateVerdictTarget | null,
  /** WI-39472: the capacity contract ("shared" | "reserved") the launcher is running under.
   *  Same forwarding reason as `partialGreenGate` — see the note below. Anything other than
   *  those two literals is DROPPED rather than forwarded (see the validation below). */
  capacityMode?: string | null,
  /** Exact, request-side resolved launch target. Invalid values are never forwarded. */
  candidateSha?: string | null,
  /** Logical qualification identity transported to the producer-side verdict recorder. */
  logicalAttemptId?: string | null,
  /** Stable identity shared by this detached fire's anchor and producer outcomes. */
  gateFireId?: string | null,
  /** Subject integration root. `root` remains the tooling/cwd root. */
  subjectRoot = root,
  /** Per-harness environment overlay resolved by the routing helper. */
  extraEnv: Record<string, string> = {},
  /** Inherited environment keys that must be removed for a subject run. */
  clearEnv: string[] = [],
  /** Exact runnable provenance. Invalid/preflight-only values are never forwarded. */
  candidateSource?: CheckpointCandidateSource | null,
): string[] {
  // Mirror the PERIODIC gate: the routine spawns green-checkpoint.ts with { ...process.env } so it
  // inherits PAPERCUSP_PARTIAL_GREEN_GATE (the longest-green-prefix FF). A MANUAL checkpoint runs via
  // `systemd-run --user`, which does NOT inherit the launching process env — so without this it always
  // ran whole-batch. Forward the flag into the inner command when the launcher itself has it set, so
  // release:checkpoint-run behaves the same as the scheduled gate.
  //
  // WI-39472: PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE needs the SAME treatment, and its absence
  // was worse than whole-batch because it is SILENT: setting the var on papercup-dev-api.service
  // correctly changes every SCHEDULED run (the routine inherits process.env) while every MANUAL
  // run keeps the old capacity, so `systemctl show` reports the new value and the gate still runs
  // at the old fork count. Observed 2026-08-17: a drop-in set reserved/8, `systemctl show` and
  // /proc/<operator>/environ both confirmed it, and the very next release:checkpoint-run still
  // logged `mode=shared maxForks=2`. The run's own GREEN_CHECKPOINT_CAPACITY line is the only
  // honest witness of which contract it actually got — verifying the SERVICE proves nothing about
  // the RUN. Any future gate env var belongs here too, for the same reason.
  //
  // Forward ONLY the two literals release-config.ts accepts. This value reaches a `bash -c` string,
  // so an unvalidated passthrough would be a shell-injection seam; an unrecognised value is dropped
  // and the run falls back to its own default rather than inheriting something unquotable.
  const capacity =
    capacityMode === 'shared' || capacityMode === 'reserved'
      ? `PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE='${capacityMode}' `
      : '';
  const gateEnv = `${partialGreenGate ? `PAPERCUSP_PARTIAL_GREEN_GATE='1' ` : ''}${capacity}`;
  const candidateArg =
    candidateSha && /^[0-9a-f]{40}$/.test(candidateSha)
      ? ` --candidate '${candidateSha}' --candidate-source '${isCheckpointCandidateSource(candidateSource) ? candidateSource : 'tip'}'`
      : '';
  // Keep detached manual runs under the same cgroup memory policy as the periodic gate.
  // The capacity argument is the already-validated contract forwarded below; an omitted or
  // unrecognised value deliberately uses the conservative shared-mode cap. TasksMax is not
  // inferred here because no launcher-wide task budget has been established.
  const memoryMaxG = checkpointScopeMemoryMaxG({
    PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: capacityMode ?? 'shared',
  });
  // Write to the per-run file and point the stable path at it (`ln -sfn`, so a symlink
  // left by a previous run is replaced, not followed into). The redirect binds to the
  // green-checkpoint command only — the symlink is created first, so a reader polling
  // the stable path during startup follows it to the file this run is about to fill.
  const target = runLogPath ?? logPath;
  const link = runLogPath ? `ln -sfn '${runLogPath}' '${logPath}' && ` : '';
  const validClearEnv = clearEnv.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  const clearEnvCommand = validClearEnv.length
    ? `unset ${validClearEnv.map((key) => shellQuote(key)).join(' ')} && `
    : '';
  // WI-5377: this run is always detached (systemd-run, no interactive TTY ever reads it
  // live — it goes straight to a file), so stripping ANSI here can never lose the
  // "keep colour for an interactive TTY" case; that case belongs to a foreground/manual
  // invocation of green-checkpoint.ts, which never goes through this builder. Strip at
  // the ONE write site instead of leaving every downstream reader (this repo has several)
  // to keep re-implementing the same `sed 's/\x1b\[[0-9;]*m//g'` filter by hand.
  // `sed -u` (unbuffered — flush per line rather than in fixed-size blocks) matters here
  // specifically because a filtered write is a two-process pipeline instead of one process
  // writing a file directly: on a SIGKILL/OOM (the whole cgroup dies together, same
  // failure this file's EI-210996 terminal-marker comment above already guards against),
  // an unbuffered sed loses at most its already-in-flight line, matching the original
  // single-process write's own loss window — a block-buffered sed could instead lose a
  // whole buffered chunk of otherwise-successfully-produced output.
  const inner =
    `${link}${clearEnvCommand}${gateEnv}PAPERCUSP_INTEGRATION_ROOT=${shellQuote(subjectRoot)} '${tsxBin(root)}' ` +
    `apps/operator/lib/release/green-checkpoint.ts${candidateArg} 2>&1 | sed -u 's/\\x1b\\[[0-9;]*m//g' > ${target}`;
  // EI-210996: the checkpoint process cannot publish its own verdict after SIGKILL/OOM.
  // ExecStopPost belongs to systemd, so it still appends the manager-provided terminal
  // tuple to this run's immutable log. The transient property is passed over D-Bus, so
  // printf's `%s` placeholders must stay single-percent; `%%s` reaches printf unchanged and
  // prints literal `%s` tokens. Keep the manager variables single-dollar: if `$$` survives
  // transient-property serialization, /bin/sh expands it to its PID plus the variable name
  // (the observed `1922607SERVICE_RESULT` failure) instead of reading the terminal tuple.
  const terminalMarkerCommand =
    `/bin/sh -c 'printf "\\n${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} ` +
    `service_result=%s exit_code=%s exit_status=%s\\n" ` +
    `"$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" >> "${target}"'`;
  // WI-4494: a detached unit does NOT inherit the launcher's env (same reason the partial-green
  // flag above has to be forwarded explicitly), so the record target must be passed as --setenv or
  // the run has no idea whose gate it is judging and silently declines to record.
  const verdictEnv = verdictTarget
    ? Object.entries(gateVerdictEnv(verdictTarget)).map(([k, v]) => `--setenv=${k}=${v}`)
    : [];
  const qualificationEnv =
    logicalAttemptId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(logicalAttemptId)
      ? [`--setenv=${CHECKPOINT_QUALIFICATION_ATTEMPT_ENV}=${logicalAttemptId}`]
      : [];
  const gateFireEnv = isGateFireId(gateFireId) ? [`--setenv=${GATE_FIRE_ID_ENV}=${gateFireId}`] : [];
  const routedEnv = Object.entries(extraEnv)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `--setenv=${key}=${value}`);
  return [
    '--user',
    '--no-block',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--unit=${checkpointUnitForRoot(subjectRoot)}`,
    `--property=MemoryMax=${memoryMaxG}G`,
    '--property=MemorySwapMax=0',
    '--property=ManagedOOMPreference=avoid',
    // EI-213512: ordinary user-issued StopUnit calls must not kill a live gate run. The
    // authorized replaceStale path uses `systemctl kill` instead, after the stale/age/phase
    // guards above have proved that replacement is allowed.
    '--property=RefuseManualStop=yes',
    `--property=ExecStopPost=${terminalMarkerCommand}`,
    `--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    ...greenCheckpointDbPoolSetenvArgs(),
    `--setenv=${MANUAL_CHECKPOINT_WATCHDOG_ENV}=${MANUAL_CHECKPOINT_WATCHDOG_MS}`,
    ...routedEnv,
    ...verdictEnv,
    ...qualificationEnv,
    ...gateFireEnv,
    'bash',
    '-c',
    inner,
  ];
}

/**
 * The request handed to the durable eligibility waiter. Keep this serializable: it is
 * persisted as DBOS workflow input when `waitForEligibility:true` is used.
 */
export interface CheckpointEligibilityWaitRequest {
  paths: string[];
  waitSec: number;
  pendingId: string;
  root?: string;
  force?: boolean;
  replaceStale?: boolean;
  /** Re-check this lineage after the quiet-cut delay before the deferred launch. */
  requiredAncestorSha?: string;
  /** Resume the same logical attempt after the durable quiet-cut wait. */
  logicalAttemptId?: string;
  /** The request-side action-instant snapshot. The durable waiter updates the
   * predicates it rechecks instead of rebuilding a second, partial contract. */
  eligibilitySnapshot?: CheckpointEligibilitySnapshot;
}

/** The immediate receipt returned while the durable waiter sleeps/rechecks. */
export interface CheckpointEligibilityWaitReceipt {
  pendingId: string;
  workflowId: string;
  completionEvents: string[];
  logicalAttemptId?: string;
}

type CheckpointEligibilityWaitRunner = (
  request: CheckpointEligibilityWaitRequest,
) => Promise<CheckpointEligibilityWaitReceipt>;

let checkpointEligibilityWaitRunner: CheckpointEligibilityWaitRunner | null = null;

/** Install the DBOS-backed runner without pulling the DBOS SDK into request handlers. */
export function setCheckpointEligibilityWaitRunner(runner: CheckpointEligibilityWaitRunner | null): void {
  checkpointEligibilityWaitRunner = runner;
}

/** Whether the host has installed the crash-resumable wait path. */
export function checkpointEligibilityWaitEnabled(): boolean {
  return checkpointEligibilityWaitRunner !== null;
}

/** Enqueue a wait and return before the quiet-cut interval can exhaust MCP transport time. */
export async function scheduleCheckpointEligibilityWait(
  request: CheckpointEligibilityWaitRequest,
): Promise<CheckpointEligibilityWaitReceipt> {
  if (!checkpointEligibilityWaitRunner) {
    throw new Error('durable checkpoint eligibility waiter is not installed');
  }
  return checkpointEligibilityWaitRunner(request);
}

/**
 * Stable idempotency key for retries of a timed-out MCP call. A retry describing the same
 * quiet-cut candidate and paths must resume the same waiter rather than enqueueing a second
 * future gate run. The candidate/tip pair is part of the preflight observation, not a clock.
 */
export function checkpointEligibilityPendingId(input: {
  root?: string;
  candidate: string | null;
  tip: string | null;
  paths: string[];
  requiredAncestorSha?: string;
}): string {
  const canonical = JSON.stringify({
    root: input.root ?? null,
    candidate: input.candidate ?? null,
    tip: input.tip ?? null,
    paths: [...new Set(input.paths.map((p) => String(p).trim()).filter(Boolean))].sort(),
    requiredAncestorSha: input.requiredAncestorSha ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export interface LaunchCheckpointOpts {
  /** Integration tree root (default integrationRoot()). */
  root?: string;
  /** Subject repo root. The detached command still runs from `root` (tooling root). */
  integrationRoot?: string;
  /** Per-harness environment overlay for the detached subject run. */
  extraEnv?: Record<string, string>;
  /** Inherited environment keys to remove before the subject overlay is applied. */
  clearEnv?: string[];
  /** Exact preflight-resolved candidate to transport across the detached CLI seam. */
  candidate?: string | null;
  /** Exact runnable provenance to transport with the candidate. */
  candidateSource?: CheckpointCandidateSource | null;
  /** Skip the pre-launch active-run check (WI-1562) and attempt the launch regardless.
   *  ⚠ WI-6962: this was documented as safe because "systemd's own same-unit collision guard
   *  is still the final backstop". THAT IS FALSE, and the false belief is what made the
   *  fail-open probe above look harmless. `systemd-run --collect --unit=<name>` against a
   *  LIVE unit does not refuse: journalctl for the 2026-08-02T06:27:05Z launch shows
   *  `Stopping` → `Stopped` → `Started` inside one second — the running suite was REPLACED
   *  and killed mid-flight. So `force:true` DOES destroy an active run. Our proactive check
   *  is the only guard there is; treat force as "kill whatever is running", not as a
   *  no-op-if-busy. */
  force?: boolean;
  /** EI-9672: when the active run is CONFIRMED stale (`candidate_stale` — it's judging an
   *  older candidate than the current quiet-cut-eligible staging state, e.g. it's deep in
   *  post-verdict work like the longest-green-prefix salvage or an auto-refire chain on a
   *  candidate a newer commit has since superseded), stop that unit and launch a fresh run
   *  for the current candidate instead of refusing. Distinct from — and safer than — `force`:
   *  `force` blindly attempts a launch that systemd still refuses (the WI-1562/EI-9672
   *  repro — "force still failed because systemd refused the loaded singleton"); this
   *  actually frees the singleton, but ONLY for the stale case. A run judging the CURRENT
   *  candidate is never stopped, even with replaceStale:true — that's the CRITICAL danger
   *  the original investigation flagged (never suppress/kill a legitimately in-flight,
   *  still-relevant verdict). No supported "cancel" existed before this; the only prior path
   *  was a human running `systemctl --user stop` by hand, then relaunching. */
  replaceStale?: boolean;
  /** WI-4494: the harness whose gate this run judges — the run stamps its OWN verdict into that
   *  harness's gate_health + pipeline history instead of discarding it. Omitted ⇒ the operator-home
   *  gate (this launcher's scope). Pass `null` to explicitly launch a NON-recording run. */
  target?: GateVerdictTarget | null;
  /** Bind the detached producer's verdict to one durable logical qualification attempt. */
  logicalAttemptId?: string;
}

/**
 * P-004 (EI-18752644493166307) — "does the candidate this run judges contain MY edits?"
 *
 * The reply already names the candidate. Naming a sha answers a question the caller
 * cannot check: an agent knows exactly which FILES it edited and nothing about which
 * commit carries them. So the answer is computed here, in path-space, and returned
 * with the launch — the moment of the mistake, which is the only place it helps.
 * (Prose could not: the filer of EI-18752644493166307 had restated the correct rule
 * to the owner an hour before making both mistakes.)
 *
 * Deliberately a SEPARATE async function rather than folded into
 * `launchDetachedCheckpoint`: that function's steps from the active-run check to
 * `spawnFn` must stay in ONE tick (see the `cancelStaleAwaits` comment — a caller that
 * spawns and immediately drives the child's events would otherwise race a listener
 * that is not attached yet). An `await` in there would break every test in that file
 * and, worse, intermittently in production. So the tool calls this AFTER the launch
 * resolves.
 */
export interface CheckpointContainment {
  /** The commit whose containment these verdicts describe. */
  candidateSha: string | null;
  /** The integration tip at the time of the check (null when unresolvable). */
  tipSha: string | null;
  /** Where the checked path-set came from — caller-declared beats inferred. */
  source: 'caller-supplied' | 'inferred-uncommitted';
  /** Paths the candidate carries byte-identically to the working tree. */
  included: string[];
  /** Paths it does NOT carry. A red on any of these is NOT evidence your fix failed. */
  missing: string[];
  /** Paths whose containment could not be determined — never counted as included. */
  unknown: string[];
  /** Per-path verdict + the lever for each miss. */
  paths: PathContainment[];
  /**
   * The RESOLUTION of the old "if your fix is among them": for each checked path, the
   * excluded commits (candidate..tip) that actually touch it. Empty when the quiet-cut
   * excluded nothing, or excluded nothing of yours.
   */
  excludedCommitsTouchingYourFiles: { path: string; commits: string[] }[];
  /** EI-18796358994458975: does the declared path set itself look like a torn TDD pair —
   *  a `*.test.ts` the candidate carries plus its non-test sibling missing for reason
   *  `newer-commit`? `detected:false` when nothing in `paths` matches that shape. */
  testImplSplitRisk: TestImplSplitRisk;
  /** One hard-warning line when `missing` is non-empty; null when everything is in. */
  warning: string | null;
}

export async function checkpointCandidateContainment(args: {
  root?: string;
  candidateSha: string | null;
  tipSha?: string | null;
  /** The files the caller's change touches. Omitted ⇒ inferred from the working tree. */
  paths?: string[];
  execFn?: ExecSyncLike;
}): Promise<CheckpointContainment> {
  const root = args.root ?? integrationRoot();
  const execFn = args.execFn ?? defaultExecSync;
  const git = checkpointGitRead(execFn, root);

  // A caller that names its files gets an EXACT answer. One that doesn't gets the
  // objectively-hazardous set instead: anything uncommitted is invisible to every
  // committed candidate, so it needs no attribution to be worth warning about. That
  // inference is what makes this fire for the caller who did not know to ask.
  const source: CheckpointContainment['source'] = args.paths?.length ? 'caller-supplied' : 'inferred-uncommitted';
  // Bounded: an inferred set is the WHOLE fleet's dirty tree and can be large. A wall of a
  // hundred peer paths buries the one line that matters, so cap what is checked (the
  // warning caps again when it renders).
  const paths = args.paths?.length ? args.paths : (await uncommittedPaths(git)).slice(0, 40);

  const verdict = await callerEditsInCandidate(git, args.candidateSha, paths);
  const tipSha = args.tipSha ?? null;

  const excludedCommitsTouchingYourFiles: { path: string; commits: string[] }[] = [];
  if (args.candidateSha && tipSha && args.candidateSha !== tipSha) {
    // WI-38356: a path inside a SUBMODULE is invisible to the superproject `git log -- <path>`
    // this read performs — an excluded commit touches the GITLINK (`libs/papercusp`), never
    // `libs/papercusp/libs/db/sql/816-x.sql`. Left unattributed, every submodule path yields
    // zero commits, which empties `blockedPaths` in assessPreLaunchExclusion and downgrades a
    // DECIDED miss ('newer-commit', with the bump commit sitting right there in the quiet
    // window) to 'exclusion-undecidable'. That fails OPEN, so the pre-launch refusal cannot
    // arm and `waitForEligibility` becomes a silent no-op — measured 2026-08-13T01:56:22Z,
    // spending a ~55min suite on a candidate provably lacking all four declared paths, the
    // exact WI-6946 defect this guard exists to prevent.
    //
    // This is the COMMON case here, not an edge one: every migration lives under
    // `libs/papercusp/libs/db/sql/` and every borrowable lib under `libs/generic/*`, so the
    // guard was blind precisely where release-cut preflights (lint:migrations) send agents to
    // fire a manual gate run.
    const submodules = verdict.missing.length ? await submodulePrefixes(git) : [];
    for (const p of verdict.missing) {
      let commits = await excludedCommitsTouchingPath(git, args.candidateSha, tipSha, p);
      if (!commits.length) {
        const gitlink = containingSubmodulePath(submodules, p);
        // Recorded under the ORIGINAL declared path, not the gitlink: the caller asked about
        // `p`, the downstream eligibility join keys on `p`, and the gitlink bump IS the commit
        // that carries `p` into a later candidate — so waiting for it provably resolves the
        // exclusion, which is the precondition for refusing rather than launching.
        if (gitlink) commits = await excludedCommitsTouchingPath(git, args.candidateSha, tipSha, gitlink);
      }
      if (commits.length) excludedCommitsTouchingYourFiles.push({ path: p, commits });
    }
  }

  const splitRisk = testImplSplitRisk(verdict.paths);

  return {
    candidateSha: args.candidateSha,
    tipSha,
    source,
    included: verdict.included,
    missing: verdict.missing,
    unknown: verdict.unknown,
    paths: verdict.paths,
    excludedCommitsTouchingYourFiles,
    testImplSplitRisk: splitRisk,
    warning: verdict.missing.length
      ? renderContainmentWarning(verdict.missing, verdict.paths, excludedCommitsTouchingYourFiles, source, splitRisk)
      : null,
  };
}

/**
 * EI-20025784115349280 — the PRE-LAUNCH form of the containment check above.
 *
 * `checkpointCandidateContainment` answers "does the candidate carry my files?" AFTER the
 * ~55min suite is already committed: `launchDetachedCheckpoint` builds `willJudge` (candidate,
 * excluded commits, per-commit eligibility) and then spawns ~29 lines later, so every value the
 * warning is made of provably exists BEFORE the process starts. Reporting it afterwards makes
 * the caller the one who has to act on it, at the one moment acting is most expensive — the
 * run is already burning the gate's only serial slot.
 *
 * So this asks the same question BEFORE the spawn and, in one narrow case, refuses.
 *
 * THE REFUSAL IS DELIBERATELY NARROW, because a false refusal wedges the fleet's only manual
 * verdict lever during exactly the incidents when it is needed — a far worse failure than the
 * wasted suite it prevents. Every one of these must hold:
 *
 *  1. The caller DECLARED `paths`. No declaration ⇒ today's behaviour, untouched. The inferred
 *     working-tree set is the whole fleet's dirty files and attributes to nobody, so it can
 *     warn but must never gate.
 *  2. The path is missing for reason `newer-commit` ONLY — i.e. it IS committed and HEAD's blob
 *     matches the tree, so the sole thing between this caller and a candidate carrying it is
 *     quiet-cut AGE. `uncommitted` is excluded on purpose: waiting does not fix it (git-sync
 *     must run first) and, on a tree ~100 agents edit, the dirty content is as likely a peer's.
 *     `absent`/`unknown` are excluded because they mean undecidable, and undecidable must launch.
 *  3. A real excluded commit in `candidate..tip` is NAMED as touching that path. This is the
 *     literal-exclusion requirement: a verdict backed by a commit you can `git show`, never the
 *     content-comparison heuristic whose false positives this repo has paid for repeatedly.
 *  4. The wait is BOUNDED and known (`maxWaitSec`). This is what makes the rail safe rather
 *     than merely well-intentioned: the refusal can only ever say "wait N seconds", never
 *     "no". An excluded commit ages into eligibility by construction, so the caller is always
 *     seconds-to-minutes from the candidate they actually want — against a ~55min suite judging
 *     content they did not declare. A wait we cannot compute, or one past the cap, LAUNCHES.
 *
 * Note (3) still cannot prove the excluded commit is the CALLER'S — git-sync commits the whole
 * tree under one identity, so no commit is attributable (see `markerAtCommit`). It does not have
 * to: the claim is only that the run would judge a version of a file the caller declared which
 * differs from the committed one, which is true whoever wrote it, and is exactly the condition
 * under which a red is not evidence about the declared change.
 *
 * Ordering: an in-flight run short-circuits this. No spawn happens then anyway, so refusing for
 * exclusion would only mask `already_running`, which is the more actionable answer.
 */
export const PRELAUNCH_EXCLUSION_MAX_WAIT_SEC = 300;

/** Why the gate is NOT refusing. Enumerated so a caller (and a test) can branch on the
 *  fail-open PATH rather than infer it from an absence — every value here means "launch". */
export type PreLaunchProceedReason =
  | 'forced'
  | 'no-declared-paths'
  | 'run-already-active'
  | 'candidate-unresolved'
  | 'no-quiet-cut'
  | 'declared-paths-in-candidate'
  | 'ages-in-at-launch'
  | 'exclusion-undecidable'
  | 'wait-exceeds-cap';

export interface PreLaunchExclusion {
  /** true ⇒ do NOT spawn. False for every undecidable case, by construction. */
  refuse: boolean;
  /** Null exactly when `refuse` is true. */
  proceedReason: PreLaunchProceedReason | null;
  candidate: string | null;
  tip: string | null;
  quietCutSec: number | null;
  /** Declared paths the predicted candidate provably does not carry, each with the excluded
   *  commits that actually touch it and when the last of them ages into eligibility. */
  blockedPaths: { path: string; commits: string[]; eligibleInSec: number }[];
  /** Seconds until EVERY commit blocking a declared path is quiet-cut eligible. */
  waitSec: number | null;
}

export async function assessPreLaunchExclusion(args: {
  paths?: string[];
  force?: boolean;
  root?: string;
  execFn?: ExecSyncLike;
  maxWaitSec?: number;
  /** Injectable for tests; defaults to the real systemd probe. */
  activeRun?: (root: string, execFn: ExecSyncLike) => boolean;
  /** Injectable for tests. A doMock CANNOT reach this call — it is an internal module
   *  binding — so without this seam any test of the gate forks git against the live repo. */
  containmentFn?: typeof checkpointCandidateContainment;
}): Promise<PreLaunchExclusion> {
  const open = (proceedReason: PreLaunchProceedReason, rest: Partial<PreLaunchExclusion> = {}): PreLaunchExclusion => ({
    refuse: false,
    proceedReason,
    candidate: null,
    tip: null,
    quietCutSec: null,
    blockedPaths: [],
    waitSec: null,
    ...rest,
  });

  if (args.force) return open('forced');
  const declared = (args.paths ?? []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!declared.length) return open('no-declared-paths');

  const root = args.root ?? integrationRoot();
  const execFn = args.execFn ?? defaultExecSync;

  // WI-10005268: the real probes run off the event loop (runCheckpointProbe); an injected
  // `activeRun` seam is called once, directly, exactly as before.
  const isActive = args.activeRun
    ? args.activeRun(root, execFn)
    : (await runCheckpointProbe((e) => checkActiveCheckpointRun(root, e), execFn)).active;
  if (isActive) return open('run-already-active');

  const current = await runCheckpointProbe((e) => currentCheckpointCandidate(root, e), execFn);
  const candidate = current.current_candidate;
  const tip = current.current_head;
  const quietCutSec = current.quiet_cut_sec;
  if (!candidate || !tip) return open('candidate-unresolved', { candidate, tip, quietCutSec });
  // Nothing was cut, so nothing can be excluded.
  if (candidate === tip) return open('no-quiet-cut', { candidate, tip, quietCutSec });

  const containment = await (args.containmentFn ?? checkpointCandidateContainment)({
    root,
    candidateSha: candidate,
    tipSha: tip,
    paths: declared,
    execFn,
  });

  const verdictFor = new Map(containment.paths.map((p) => [p.path, p]));
  const commitsFor = new Map(containment.excludedCommitsTouchingYourFiles.map((e) => [e.path, e.commits]));
  // `excludedCommitsTouchingPath` returns `--oneline` rows ("<abbrev> <subject>") and
  // `excludedCommitsSync` reports `%h` for the same window in the same repo, so the row's
  // leading token is that sha. A row we cannot join to an eligibility is a wait we cannot
  // compute — which fails OPEN below, never into a refusal.
  const excluded = await runCheckpointProbe((e) => excludedCommitsSync(root, candidate, tip, quietCutSec, e), execFn);
  const eligibilityOf = (row: string): number | null =>
    excluded.find((e) => e.sha && row.startsWith(e.sha))?.eligibleInSec ?? null;

  const blockedPaths: PreLaunchExclusion['blockedPaths'] = [];
  for (const path of declared) {
    const verdict = verdictFor.get(path);
    if (!verdict || verdict.inCandidate !== false || verdict.reason !== 'newer-commit') continue;
    const commits = commitsFor.get(path) ?? [];
    if (!commits.length) continue;
    const secs = commits.map(eligibilityOf);
    if (secs.some((s) => s === null)) continue;
    blockedPaths.push({ path, commits, eligibleInSec: Math.max(...(secs as number[])) });
  }

  if (!blockedPaths.length) {
    const allIn = containment.included.length > 0 && containment.missing.length === 0;
    return open(allIn ? 'declared-paths-in-candidate' : 'exclusion-undecidable', { candidate, tip, quietCutSec });
  }

  const waitSec = Math.max(...blockedPaths.map((b) => b.eligibleInSec));
  const shape = { candidate, tip, quietCutSec, blockedPaths, waitSec };
  // Already eligible: the detached run re-resolves its OWN candidate ~1-2s from now and will
  // pick these up. Refusing here would block a launch that was about to be correct.
  if (waitSec <= 0) return open('ages-in-at-launch', shape);
  if (waitSec > (args.maxWaitSec ?? PRELAUNCH_EXCLUSION_MAX_WAIT_SEC)) return open('wait-exceeds-cap', shape);
  return { refuse: true, proceedReason: null, ...shape };
}

/**
 * The refusal text. Pure + exported for the same reason `renderContainmentWarning` is: the
 * PHRASING is the deliverable, and it must not require a repo or a systemd unit to test.
 *
 * It has one job the warning it replaces could not do — leave the reader with a MOVE rather
 * than a fact. So it never ends on the exclusion; it ends on the two exits, and it says what
 * each costs, because a refusal whose alternative is unclear is read as an obstacle and routed
 * around (that is precisely how a live auto-refire was killed on 2026-07-27).
 */
export function renderPreLaunchRefusal(v: PreLaunchExclusion): string {
  const paths = v.blockedPaths.map((b) => b.path);
  const list = `${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ` (+${paths.length - 6} more)` : ''}`;
  const commits = v.blockedPaths.flatMap((b) => b.commits).slice(0, 4);
  return (
    `NOT launched — this run would NOT have judged ${paths.length} file(s) you declared: ${list}. ` +
    `The quiet cut puts the candidate at ${v.candidate?.slice(0, 12) ?? 'unknown'} while those files are carried by ` +
    `commit(s) newer than it: ${commits.join(' | ')}${v.blockedPaths.flatMap((b) => b.commits).length > 4 ? ' | …' : ''}. ` +
    'This is a LITERAL exclusion — those commits are in `candidate..tip` and touch those paths — not the ' +
    'content-comparison heuristic, and the files are COMMITTED (nothing for git-sync to do). A suite fired now ' +
    `would spend ~55 min judging an older version of your declared files, and its red would not be evidence ` +
    'about your change. Nothing was spawned, so nothing was wasted and the gate slot is still free.\n' +
    `TWO EXITS: waitForEligibility:true — enqueue a durable waiter for ~${v.waitSec}s (until those commits age into the quiet window) ` +
    'and then launch, which is what a caller in this position almost always wants; or force:true — launch now ' +
    'and judge the older candidate anyway (correct when you need ANY fresh verdict more than a verdict on these ' +
    'files, e.g. greening a red gate that is blocking the fleet).'
  );
}

/**
 * The warning text. Kept pure + exported so the PHRASING — which is the entire
 * deliverable of P-004 — is unit-testable without a repo, a systemd unit, or a launch.
 *
 * It must do one thing above all: pre-empt the misread. A candidate without your fix
 * reds on the pre-fix failure with the pre-fix count, and the natural reading of that
 * is "my fix didn't work". Every branch below therefore says, explicitly, that a red
 * from this run is not evidence about your change.
 */
export function renderContainmentWarning(
  missing: string[],
  paths: PathContainment[],
  excluded: { path: string; commits: string[] }[],
  source: CheckpointContainment['source'],
  splitRisk?: TestImplSplitRisk,
): string {
  const byReason = (r: MissingReason) => missing.filter((p) => paths.find((x) => x.path === p)?.reason === r);
  const uncommitted = byReason('uncommitted');
  const newer = byReason('newer-commit');
  // `absent` no longer means "not committed" — the classifier resolves that against HEAD
  // and only falls back to `absent` when it had no HEAD to ask. Folding it into the
  // NOT-COMMITTED bucket asserted a lever (`git-sync:run`) that is a no-op for the file
  // this actually described most often: a new file already committed past the candidate.
  const unknownCommit = byReason('absent');
  const list = (xs: string[]) => `${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` (+${xs.length - 6} more)` : ''}`;
  const declared = source === 'caller-supplied';

  // OWNERSHIP IS ONLY CLAIMED WHEN IT WAS DECLARED. This tree is edited concurrently by
  // the whole fleet, so an inferred (working-tree) set routinely contains PEERS' edits —
  // calling those "your files" would be a false positive, and a detector that cries wolf
  // on a shared tree is one agents learn to scroll past. That would cost more than the
  // gap it closes, so the inferred branch states exactly what it knows and no more.
  const parts: string[] = [
    declared
      ? `⚠ THIS RUN WILL NOT SEE ${missing.length} of your file(s). A RED from it is NOT evidence your change failed — the suite is testing code WITHOUT them, so it reds on the ORIGINAL failure with the ORIGINAL count.`
      : `⚠ ${missing.length} uncommitted file(s) in this shared tree are INVISIBLE to the commit this run judges. They may be a peer's — but if any are YOURS, a red from this run is not evidence your change failed, because your change is not in what it tests.`,
  ];
  if (uncommitted.length) {
    parts.push(
      `NOT COMMITTED (the gate checks out a commit and cannot see the working tree): ${list(uncommitted)}. Fix: git-sync:run, then re-fire.`,
    );
  }
  if (newer.length) {
    parts.push(
      `COMMITTED BUT NEWER THAN THE CANDIDATE (the quiet-cut stepped the judged commit back): ${list(newer)}. Fix: wait out the quiet window (~4 min) and re-fire, or let the next run pick it up.`,
    );
  }
  // EI-18796358994458975: a torn TDD pair is a KNOWN false-red shape, not a generic
  // "wait it out" — name it explicitly so the caller does not spend the ~3h suite
  // re-debugging code that is already correct, only untested-together-with-its-test yet.
  if (splitRisk?.detected) {
    parts.push(
      `🔴 KNOWN FALSE-RED SHAPE (torn TDD pair): the candidate carries your test(s) ${list(
        splitRisk.includedTests,
      )} WITHOUT the implementation commit that makes them pass — ${list(
        splitRisk.missingImpl,
      )} is/are exactly the file(s) listed above as newer-than-candidate. This run is GUARANTEED red on those tests before it even starts; that red is not evidence anything is broken. Do not debug it — wait out the quiet window and re-fire (or let the next run pick it up).`,
    );
  }
  if (unknownCommit.length) {
    parts.push(
      `NOT IN THE CANDIDATE, committed-ness UNKNOWN (no HEAD was available to check whether a newer commit carries them): ${list(unknownCommit)}. Check with \`git log -1 -- <path>\` before assuming either lever.`,
    );
  }
  // The resolution of "if your fix is among them": which excluded commit carries which file.
  for (const e of excluded.slice(0, 4)) {
    parts.push(`'${e.path}' is carried by EXCLUDED commit(s): ${e.commits.slice(0, 3).join(' | ')}`);
  }
  if (!declared) {
    parts.push(
      'For a verdict about YOUR change specifically, pass `paths: [...]` naming the files it touches — then this answers included/missing exactly instead of listing the whole tree.',
    );
  }
  return parts.join(' ');
}

/** EI-213512: terminate a stale checkpoint through the authorized signal path.
 *
 * The transient unit refuses ordinary manual stops, so an unrelated `systemctl --user stop`
 * cannot tear down another lane's live gate run. `replaceStale` is the narrow, already-guarded
 * exception: it sends SIGTERM to every process in the unit, allowing green-checkpoint's existing
 * signal handler to release the run-lock before the replacement launch. Never throws; a failure
 * just means the subsequent launch attempt sees the same collision it would have seen anyway. */
export function terminateActiveCheckpointUnit(
  unit: string,
  execFn: ExecSyncLike = defaultExecSync,
): { stopped: boolean; reason?: string } {
  const r = execFn('systemctl', ['--user', 'kill', '--signal=SIGTERM', '--kill-whom=all', `${unit}.service`]);
  if (r.status === 0) return { stopped: true };
  return { stopped: false, reason: r.stderr.trim().slice(0, 300) || `systemctl kill exited ${r.status}` };
}

/** Backward-compatible name for callers that used the old stale-run cancellation helper. */
export const stopActiveCheckpointUnit = terminateActiveCheckpointUnit;

/** The subset of `ActiveCheckpointCheck` a displacement marker needs to describe. */
export type CheckpointDisplacementInfo = Pick<
  ActiveCheckpointCheck,
  'candidate' | 'current_candidate' | 'elapsed_sec' | 'started_at'
>;

/**
 * EI-19323010647367612: write a forensic marker into the STALE run's own log, BEFORE it is
 * SIGTERMed, naming what superseded it. Without this, a run stopped by `replaceStale` (or any
 * other out-of-band `systemctl --user stop`) leaves no trace of WHY it died: the transient unit
 * itself has no journal (`journalctl --user -u <unit>` returns "No entries" for a systemd-run
 * unit whose stdout is redirected to a file, per WI-6962/EI-9672's own notes), and the stable
 * `checkpointLatestLogPath` symlink this writes to is about to be repointed at the FRESH run's
 * own timestamped log the moment it launches. So this call is the ONLY place the stopped run's
 * displacement is ever recorded for whoever later reads its now-orphaned timestamped log file
 * wondering why it ends mid-suite with no verdict.
 *
 * Best-effort/fail-soft: a write failure is logged and swallowed, never blocks the stop or the
 * fresh launch that follows it (mirrors every other best-effort helper in this module).
 */
export function recordCheckpointDisplacement(
  logPath: string,
  info: CheckpointDisplacementInfo,
  // EI-19326961954611487: an un-injected caller under test previously fell through to a REAL
  // appendFileSync against the shared /tmp/papercup-green-checkpoint-manual-* namespace — the
  // exact glob CLAUDE.md tells agents to trust as gate ground truth — and wrote synthetic
  // "[displaced ...] STOPPED via replaceStale" lines with placeholder shas into it, which read
  // as a real gate event to whoever debugged a red gate next. Refuse the real write under test
  // (VITEST/NODE_ENV=test) instead of silently leaking to disk; the surrounding try/catch below
  // already treats this as a fail-soft, logged-and-swallowed write failure, so an un-injected
  // test call site now gets a loud console.error instead of a silent production-path leak.
  appendFn: (path: string, data: string) => void = (p, d) => {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      throw new Error(
        `[recordCheckpointDisplacement] refusing a real fs write to ${p} under test — inject an appendFn param instead of relying on the real default`,
      );
    }
    appendFileSync(p, d, 'utf8');
  },
): void {
  try {
    const line =
      `\n[displaced ${new Date().toISOString()}] this run is being STOPPED via replaceStale before producing a verdict — ` +
      `was judging ${info.candidate ? info.candidate.slice(0, 12) : 'an unresolved candidate'}` +
      `${info.started_at ? ` (started ${info.started_at}${info.elapsed_sec != null ? `, ~${info.elapsed_sec}s elapsed` : ''})` : ''}, ` +
      `superseded by ${info.current_candidate ? info.current_candidate.slice(0, 12) : 'current staging'}.\n`;
    appendFn(logPath, line);
  } catch (e) {
    console.error(
      `[release-checkpoint-launch] displacement log write failed (non-fatal — the stop/relaunch still proceeds): ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** WI-4957: local mirror of green-checkpoint.ts's `pipelineName` — this operator-core module
 *  must not depend on apps/operator (wrong dependency direction; apps/operator depends on
 *  operator-core, not the reverse), so the tiny pure sanitizer is duplicated here exactly like
 *  agent-tools/release/trace.ts already does for the identical reason. Keep in sync by hand;
 *  it is a one-line sanitizer that changes essentially never. */
export function checkpointPipelineName(root: string): string {
  return (path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

/**
 * The terminal event families a detached checkpoint can produce for this root. Keep this
 * alongside the pipeline-name sanitizer so request receipts and `checkpoint:await` use the
 * exact same scoped keys as the green-checkpoint producer.
 */
export function checkpointEligibilityCompletionEvents(root: string): string[] {
  const pipeline = checkpointPipelineName(root);
  return [`release:green:${pipeline}`, `green-checkpoint:red:${pipeline}`, `green-checkpoint:inconclusive:${pipeline}`];
}

/**
 * A failed systemd launch can still carry a useful liveness signal. In particular, a forced
 * launch intentionally skips our proactive unit check, so systemd may be the first observer to
 * report that the canonical unit is already loaded. Re-probe only this collision-shaped failure;
 * unrelated launch errors must retain their original diagnostics, and an inactive collision must
 * not be turned into a second unit name (the shared checkpoint run-lock is the actual suite
 * singleton — see the retracted EI-20243481373440343 retry path).
 */
function isCheckpointUnitCollision(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('already loaded') ||
    text.includes('already exists') ||
    text.includes('fragment file') ||
    text.includes('file exists')
  );
}

/**
 * WI-4957 / EI-20391462658650094 — wake pending checkpoint-family `events:await`
 * registrations bound (via candidateSha payload_filter) to a candidate whose run we
 * just KILLED (the EI-9672 `replaceStale` stop below) before it could ever produce a
 * verdict.
 *
 * Without this, `checkpoint:await { candidateSha }` registered against that exact
 * candidate has no way to learn its run is dead — it sleeps on, indistinguishable from
 * "still judging", until its own timeout. The durable candidate-replaced wake lets the
 * subscriber re-orient and register for the replacement run. See
 * events/await/engine.ts's cancelSupersededCandidateAwaits for the exact (narrow,
 * payload-filter-matched) wake rule.
 *
 * Exported + the 5th positional param of launchDetachedCheckpoint below so this is
 * injectable/unit-testable without a real events:await store. The legacy return field
 * remains `cancelled` for callers, although the engine now delivers a wake instead of
 * cancelling the await. Best-effort/fail-soft: never blocks the fresh launch it runs
 * ahead of.
 */
export async function cancelStaleCheckpointAwaits(
  root: string,
  staleCandidateSha: string,
): Promise<{ cancelled: number }> {
  try {
    // Dynamic ESM import, not require(): a runtime `require()` of a sibling TS module is
    // NOT reliably resolvable under this repo's ESM/vitest module graph (confirmed live —
    // it threw `Cannot find module` under vitest even though the file exists, and a
    // vi.mock on this path silently never applied to it either, since vi.mock only
    // intercepts the import graph). `import()` is the same seam every other lazy
    // cross-module load in this release/* code already uses (see green-checkpoint.ts's
    // deps.emitEvent).
    const { cancelSupersededCandidateAwaits } = await import('./events/await/engine');
    const pipeline = checkpointPipelineName(root);
    const result = await cancelSupersededCandidateAwaits({
      keys: [
        'release:green',
        `release:green:${pipeline}`,
        'green-checkpoint:red',
        `green-checkpoint:red:${pipeline}`,
        'green-checkpoint:inconclusive',
        `green-checkpoint:inconclusive:${pipeline}`,
      ],
      staleCandidateSha,
    });
    return { cancelled: result.cancelled };
  } catch (e) {
    console.error(
      `[release-checkpoint-launch] candidate-replaced wake failed (non-fatal — the fresh run still launches): ${e instanceof Error ? e.message : e}`,
    );
    return { cancelled: 0 };
  }
}

/**
 * Fire the green-checkpoint suite as a DETACHED transient systemd unit. Returns once systemd-run
 * has accepted/refused the unit — the suite's VERDICT is reported on /admin/git (the pipeline
 * event green-checkpoint.ts emits), NOT by this caller.
 *
 * WI-1562: BEFORE spawning, check whether a run for this root is already active and, unless
 * `force:true`, refuse with a STRUCTURED `alreadyRunning` detail (unit/candidate/started_at/
 * eta_sec) instead of letting the caller find out only via systemd-run's bare exit-1 string.
 * Two sus firing this ~8 minutes apart with no clear "don't retry" signal is exactly the
 * starvation this closes — the newest tip is auto-judged by the in-flight run's quiet-cut
 * anyway, so a re-fire is usually unnecessary (see the tool's guidance).
 *
 * `spawnFn`/`execFn`/`readLogHead` are injectable so the tool handler is unit-testable without
 * launching anything or shelling out to systemctl. `cancelStaleAwaits` (WI-4957) is likewise
 * injectable so the replaceStale path's candidate-replaced wake is testable without a real
 * DB, and `recordDisplacement` (EI-19323010647367612) the same for the pre-stop log marker.
 */
export async function launchDetachedCheckpoint(
  opts: LaunchCheckpointOpts = {},
  spawnFn: SpawnLike = spawn,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
  cancelStaleAwaits: (
    root: string,
    staleCandidateSha: string,
  ) => Promise<{ cancelled: number }> = cancelStaleCheckpointAwaits,
  recordDisplacement: (logPath: string, info: CheckpointDisplacementInfo) => void = recordCheckpointDisplacement,
  readProcessAuthority: CheckpointProcessAuthorityReader = readCheckpointProcessAuthorityCheap,
  recordGateFireFn: typeof recordGateFire = recordGateFire,
): Promise<LaunchCheckpointResult> {
  const root = opts.root ?? integrationRoot();
  const subjectRoot = opts.integrationRoot ?? root;
  const unit = checkpointUnitForRoot(subjectRoot);
  // `logPath` stays the stable, well-known path (readers + the alreadyRunning probe use
  // it); the run itself writes to its own timestamped file behind that symlink.
  const logPath = checkpointLatestLogPath(unit);
  const runLogPath = checkpointRunLogPath(unit);
  let replacedStale: ActiveCheckpointCheck | undefined;

  if (opts.candidate != null && !/^[0-9a-f]{40}$/.test(opts.candidate)) {
    return Promise.resolve({
      launched: false,
      unit,
      argv: [],
      logPath: runLogPath,
      reason: 'invalid_candidate',
    });
  }

  // WI-10005763 (D-012): the launched unit runs the green-checkpoint orchestrator FROM `root`, the
  // live shared tree, with network. Code a restricted session left there must not execute, so this
  // refuses before everything else — `force` included, and BEFORE the replaceStale branch below, so
  // a refusal can never stop a live run. Fencing the launcher (not only the release:checkpoint-run
  // door) covers its other callers too: repair auto-verify, the fire drill, the stall watchdog and
  // the eligibility workflow. Same census + reason text as the routine dispatchers
  // (restricted-tree-skip.ts). A synchronous injected fence keeps the same-tick spawn contract.
  const fenceRead: ProbeAwaitable<RestrictedHoldRefusal | null> = restrictedTreeHoldRefusal([root, subjectRoot]);
  const restrictedHold = isPromiseLike(fenceRead) ? await fenceRead : fenceRead;
  if (restrictedHold) {
    return { launched: false, unit, argv: [], logPath, reason: restrictedHold.error, restrictedHold };
  }

  if (!opts.force) {
    // WI-10005268: off the event loop with the real exec; same-tick with an injected one.
    const activeRead = runCheckpointProbe((e) => checkActiveCheckpointRun(subjectRoot, e, readLogHead), execFn);
    const active = isPromiseLike(activeRead) ? await activeRead : activeRead;
    // WI-6962: an INDETERMINATE probe is not a refusal to launch "because something is
    // running" — it is a refusal to GAMBLE. The costs are wildly asymmetric: refusing costs
    // the caller one retry, while launching into a live run destroys 20+ minutes of an
    // 8-fork suite and produces no verdict at all (systemd REPLACES the same-named transient
    // unit rather than refusing the collision, so there is no backstop underneath us). Report
    // it under its own reason so a caller can tell "wait for the run" from "the host could not
    // answer" — they need opposite responses, and `force:true` still bypasses this.
    if (active.probe_failed) {
      return Promise.resolve({
        launched: false,
        unit,
        argv: [],
        logPath,
        reason: 'probe_failed',
        alreadyRunning: active,
      });
    }
    // P-009 / EI-21340355513221785: systemd and the shared run-lock both have a blind
    // startup interval. The checkpoint materializer acquires the exclusive materialization
    // lock before it publishes either signal, so a trusted inactive systemd read is not yet
    // enough to authorize a second launch. This census is intentionally awaited BEFORE the
    // child is spawned; once spawnFn returns, listeners below are attached synchronously in
    // the same turn so callers cannot race a fast systemd-run child.
    // Preserve the same-turn path for synchronous test seams while still awaiting the
    // production reader (which is async). This matters because the child listeners below are
    // intentionally attached synchronously after spawnFn returns; an unconditional await here
    // would also insert a microtask before spawn for a synchronous reader and make callers that
    // drive a fake child immediately after launch lose its close event.
    const authorityRead = readProcessAuthority(subjectRoot);
    const authority = isPromiseLike(authorityRead) ? await authorityRead : authorityRead;
    if (authority.probeFailed) {
      const authorityProbe: ActiveCheckpointCheck = {
        active: true,
        unit,
        systemd: active.systemd,
        probe_failed: true,
        probe_detail: authority.probeDetail?.trim() || 'checkpoint process-authority probe failed before launch',
        candidate_stale: false,
      };
      return {
        launched: false,
        unit,
        argv: [],
        logPath,
        reason: 'probe_failed',
        alreadyRunning: authorityProbe,
      };
    }
    if (authority.active) {
      // The authority probe is deliberately stronger than argv matching: its environment,
      // exact integration root, and unified cgroup identify the live materializer before the
      // run-lock exists. Preserve the structured alreadyRunning contract so callers wait rather
      // than firing force:true and replacing the unit once materialization reaches systemd.
      const startedAt =
        authority.startedAtMs != null && Number.isFinite(authority.startedAtMs)
          ? new Date(authority.startedAtMs).toISOString()
          : null;
      const authorityProbe: ActiveCheckpointCheck = {
        active: true,
        unit,
        systemd: active.systemd,
        ...(hasCheckpointProcessAuthorityIdentity(authority)
          ? {
              pre_lock_authority: {
                workspace: authority.workspace,
                harness: authority.harness,
                cgroup_path: authority.cgroupPath,
                pid: authority.pid,
              },
            }
          : {}),
        candidate: null,
        candidate_stale: false,
        started_at: startedAt,
        elapsed_sec: authority.elapsedSec,
        progress_at: startedAt,
        current_phase: 'materializing',
      };
      return {
        launched: false,
        unit,
        argv: [],
        logPath,
        reason: 'already_running',
        alreadyRunning: authorityProbe,
      };
    }
    if (active.active) {
      // EI-9672: a CONFIRMED-stale active run (judging an older candidate than the current
      // quiet-cut-eligible staging state — e.g. deep in post-verdict salvage/refire on a
      // superseded candidate) can be replaced instead of refused. Deliberately narrow: a
      // run judging the CURRENT candidate is never touched, replaceStale or not.
      if (opts.replaceStale && active.candidate_stale) {
        // EI-11667 (age) + EI-18757156963245979 (phase): see classifyReplaceRequest for why a
        // run in its verdict path is never replaceable, and why age alone was the wrong axis.
        const decision = classifyReplaceRequest(active);
        if (!decision.replace) {
          return Promise.resolve({
            launched: false,
            unit,
            argv: [],
            logPath,
            reason: 'already_running',
            alreadyRunning: {
              ...active,
              ...(decision.reason === 'young' ? { replace_refused_young: true } : {}),
              ...(decision.reason === 'delivering' ? { replace_refused_delivering: true } : {}),
            },
          });
        }
        // EI-19323010647367612: record WHY this run is dying into its own log, before the
        // SIGTERM — the only forensic trail that survives a transient unit with no journal.
        recordDisplacement(logPath, active);
        const stop = terminateActiveCheckpointUnit(unit, execFn);
        if (stop.stopped) {
          // Re-check right before launching — a race where the run finished/advanced
          // between our stop and now is handled by the normal already_running path below
          // (systemd-run's own collision refusal is still the final backstop either way).
          replacedStale = active;
          // WI-4957: the run we just killed will NEVER produce a verdict for its candidate —
          // retire any events:await bound to it now, rather than leaving a wait that can only
          // ever time out (and, until it does, is indistinguishable from "still judging").
          // Deliberately NOT awaited: this function's remaining synchronous steps (build argv,
          // spawn, attach the child's event listeners) must run in the SAME tick — a caller
          // that spawns the child and immediately drives its events (every test in this file
          // does exactly that) would otherwise race a listener that isn't attached yet. The
          // The wake itself is already fail-soft/best-effort (see cancelStaleCheckpointAwaits),
          // so firing it without blocking keeps the child listener in the same tick.
          if (active.candidate) {
            void cancelStaleAwaits(subjectRoot, active.candidate).catch(() => {});
          }
        } else {
          return Promise.resolve({
            launched: false,
            unit,
            argv: [],
            logPath,
            reason: 'already_running',
            alreadyRunning: active,
          });
        }
      } else {
        return Promise.resolve({
          launched: false,
          unit,
          argv: [],
          logPath,
          reason: 'already_running',
          alreadyRunning: active,
        });
      }
    }
  }

  // P-006 (green-checkpoint-red-streak-root-cause-2026-08-17): the SAME cross-root memory
  // bound the scheduled gate consults, applied here because this is the OTHER seam that
  // creates a checkpoint scope. A bound at one launcher only is not a bound: the run-lock
  // below is per-root, so without this a manual run would still be free to stack its 40 GiB
  // on top of every other pot's in-flight scope. Placed immediately before the argv is built,
  // so returning here means no scope — and therefore no commitment — is ever created.
  //
  // The request is computed with the SAME expression buildCheckpointSystemdArgv uses for its
  // MemoryMax property, so the admission and the scope can never disagree about the size of
  // this run. Fails open on an unmeasurable probe and on a sole run — see the module note.
  // WI-10003521: resolve through the reporting resolver so the reply can say — at launch, not
  // an hour into the run — when this launcher declared no (or no valid) capacity contract.
  // Reported on the RESULT (callers render it), not console.warn: every caller already surfaces
  // the result, and a log line from a library function is the channel nobody reads.
  const capacity = resolveCheckpointCapacity(opts.extraEnv);
  const capacityMode = capacity.source === 'default' || capacity.source === 'invalid' ? null : capacity.mode;
  const memoryAdmission = admitCheckpointMemory({
    requestG: checkpointScopeMemoryMaxG({
      PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: capacity.mode,
    }),
  });
  if (!memoryAdmission.admit) {
    return Promise.resolve({
      launched: false,
      unit,
      argv: [],
      logPath,
      reason: 'memory_budget',
      memoryAdmission,
      capacity,
    });
  }

  // WI-10005268: this and the quiet-window reads below run off the event loop with the real exec.
  const currentRead = runCheckpointProbe((e) => currentCheckpointCandidate(subjectRoot, e), execFn);
  const current = isPromiseLike(currentRead) ? await currentRead : currentRead;
  const tipSha = current.current_head;
  const candidateSha = opts.candidate ?? current.current_candidate;
  // Keep the provenance in lockstep with the candidate forwarded below. Invalid or omitted
  // values retain the legacy tip default; preflight-owned callers pass one of the exact
  // runnable sources so a frozen repair head cannot be mislabeled as tip.
  const candidateSource: CheckpointCandidateSource = isCheckpointCandidateSource(opts.candidateSource)
    ? opts.candidateSource
    : 'tip';
  // WI-4494: this run records its own verdict. Explicit opt-out (`target: null`) is honoured;
  // omitted ⇒ the operator-home gate, which is this launcher's documented scope. Hoisted so
  // the P-001 fire ANCHOR (in the close handler below) and the argv env stamps can never
  // disagree about which gate the run records into.
  const verdictTarget = opts.target === undefined ? resolveHomeGateVerdictTarget() : opts.target;
  const gateFireId = verdictTarget ? mintGateFireId() : undefined;
  const argv = buildCheckpointSystemdArgv(
    root,
    logPath,
    process.env.PATH ?? '',
    opts.extraEnv?.PAPERCUSP_PARTIAL_GREEN_GATE === '1' || process.env.PAPERCUSP_PARTIAL_GREEN_GATE === '1',
    runLogPath,
    verdictTarget,
    // WI-39472: forward the launcher's capacity contract, so a manual run uses the same fork
    // budget as the scheduled gate instead of silently falling back to `shared`.
    capacityMode,
    candidateSha,
    opts.logicalAttemptId,
    gateFireId,
    subjectRoot,
    opts.extraEnv,
    opts.clearEnv,
    candidateSource,
  );

  // WI-5124: resolve — right before launch, so it's as fresh as possible — which commit this
  // run will ACTUALLY judge, so the caller sees it in the REPLY instead of having to read the
  // detached process's own log to discover their just-landed fix was quiet-cut EXCLUDED. See
  // the LaunchCheckpointResult.willJudge doc for the benign launch-time-vs-run-time race this
  // does not (and cannot) close.
  const quietCutApplied = Boolean(tipSha && candidateSha && tipSha !== candidateSha);
  const noQuietWindow = { excluded: [] as ReturnType<typeof excludedCommitsSync>, paths: [] as string[] };
  const quietWindowRead = runCheckpointProbe(
    (e) =>
      quietCutApplied && candidateSha && tipSha
        ? {
            excluded: excludedCommitsSync(subjectRoot, candidateSha, tipSha, current.quiet_cut_sec, e),
            paths: pathsBetweenSync(subjectRoot, candidateSha, tipSha, e),
          }
        : noQuietWindow,
    execFn,
  );
  const quietWindow = isPromiseLike(quietWindowRead) ? await quietWindowRead : quietWindowRead;
  const excluded = quietWindow.excluded;
  const willJudge: LaunchCheckpointResult['willJudge'] = {
    candidate: candidateSha,
    candidateSource,
    tip: tipSha,
    quietCutApplied,
    quietCutSec: current.quiet_cut_sec,
    excludedCommits: excluded.map((e) => e.line),
    // P-004: same window, expressed in the space the caller can actually check
    // (`git diff --name-only`, read in the quiet-window probe above).
    excludedPaths: quietWindow.paths,
    // EI-18759622667757826: how close each exclusion is to aging in — the difference between
    // a prediction a caller can act on and one that talks it into killing a healthy run.
    excludedEligibility: excluded.map(({ sha, subject, eligibleInSec }) => ({ sha, subject, eligibleInSec })),
    soonestEligibleInSec: excluded.length ? Math.min(...excluded.map((e) => e.eligibleInSec)) : null,
  };

  return new Promise<LaunchCheckpointResult>((resolve) => {
    // Report the RUN's own path: it is the file that survives the next re-fire, and the
    // one an agent should quote when triaging this verdict.
    const base: LaunchCheckpointResult = {
      launched: false,
      unit,
      argv,
      logPath: runLogPath,
      willJudge,
      capacity,
      ...(replacedStale ? { replacedStale } : {}),
    };
    let stderr = '';
    const child = spawnFn('systemd-run', argv);
    child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    // Async only for the collision re-probe below, which awaits nothing with an injected exec.
    // Every path resolves and nothing in it can reject (the probe is wrapped in try/catch).
    child.on('close', async (code: number | null) => {
      if (code === 0) {
        // P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31): anchor the FIRE —
        // one kind='green_checkpoint_fire' ledger row per accepted detached launch, so a unit
        // that dies before its first write is still countable from SQL. Fire-and-forget on
        // purpose: recordGateFire is best-effort by contract, and this handler must resolve
        // the caller without waiting on a ledger write. A `target: null` (explicitly
        // NON-recording) run writes no outcome row, so it gets no anchor either — anchoring
        // it would inflate `unaccounted` by construction.
        if (verdictTarget) {
          void recordGateFireFn(verdictTarget, { route: 'detached', root: subjectRoot, unit, gateFireId });
        }
        resolve({ ...base, launched: true });
        return;
      }

      if (isCheckpointUnitCollision(stderr)) {
        // force:true deliberately bypasses the pre-launch probe, but a systemd collision gives us
        // a second chance to answer the important question: is the canonical unit actually live?
        // Return the same structured refusal as the normal preflight path when it is. Do not
        // retry under a new unit name: that would create a second process which immediately
        // loses the shared run-lock, and would hide the real in-flight run from the caller.
        // WI-10005268: off the event loop with the real exec; same-tick with an injected one.
        let active: ActiveCheckpointCheck | null = null;
        try {
          const activeRead = runCheckpointProbe((e) => checkActiveCheckpointRun(subjectRoot, e, readLogHead), execFn);
          active = isPromiseLike(activeRead) ? await activeRead : activeRead;
        } catch {
          active = null; // unanswerable: fall through to the plain exit report below
        }
        if (active && (active.probe_failed || active.active)) {
          resolve({
            ...base,
            launched: false,
            reason: active.probe_failed ? 'probe_failed' : 'already_running',
            alreadyRunning: active,
          });
          return;
        }
      }

      resolve({
        ...base,
        launched: false,
        reason: `systemd-run exited ${code} (a manual checkpoint may already be running): ${stderr.trim().slice(0, 200)}`,
      });
    });
  });
}
