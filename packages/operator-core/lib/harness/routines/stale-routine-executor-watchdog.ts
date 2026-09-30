/**
 * stale-routine-executor-watchdog.ts — EI-19409061552037718: a long-lived host
 * with PAPERCUSP_DBOS_ROUTINES=1 silently keeps executing scheduled routines with
 * FROZEN code (loaded once at process start, never reloaded), so routine fixes
 * committed since that process's boot are not loaded by that process until it is
 * restarted.
 *
 * MEASURED 2026-08-03: a 7h-stale desktop-dev operator (:3270, PAPERCUSP_HONO_PORT
 * unset there but PAPERCUSP_DBOS_ROUTINES=1) kept firing condition-staleness-alarm
 * with pre-fix logic (a dedup key that embeds elapsed-minutes prose) alongside a
 * freshly-restarted papercup-bg-host running the fixed code — 97 pre-fix
 * escalation rows vs 2 post-fix ones in 24h, both shapes minted AFTER the fix
 * landed. `routines-workflow.ts`'s own doc comment already documents this as
 * "SAFE from double-fire" (claimDueRoutine's conditional next_fire_at advance is a
 * real per-tick single-flight guard). This watchdog has no visibility into a
 * different process or which process handled a particular tick; its evidence is
 * only this process's boot-time code snapshot versus the current tree.
 *
 * Two remedies were on the table (see the work-item): (a) refuse to CLAIM a
 * routine from a stale process, or (b) make the staleness LOUD instead of silent.
 * (a) risks the documented, owner-INTENTIONAL redundancy design — ROUTINES=1 was
 * deliberately enabled on the desktop dev operator "to give the Queen a healthy
 * executor when :3070 is saturated" (2026-06-16) — and a wrong staleness
 * heuristic could silently disable that redundancy exactly when it's needed
 * most (a saturated/slow :3070). This module is (b): the same shape as every
 * sibling watchdog already riding routinesTick (release-deploy-staleness,
 * rubric-staleness, session-ingest-lag, …) — detect, page once per episode via
 * the shared urgent-notify + fleet-broadcast + escalation-row trio, and get out
 * of the way. It NEVER touches routine claiming/dispatch — zero risk to the
 * fleet's live routine execution, whatever the verdict.
 *
 * Scoped PER EXECUTOR IDENTITY (PAPERCUSP_HONO_PORT/PORT, falling back to a
 * per-pid identity) so a stale desktop and a healthy :3070 — both running this
 * same sweep independently on their own routinesTick — never clear or flap each
 * other's alert (EI-16071's scopeKey pattern; see `scopedFireReason`'s doc
 * comment for the "reason must literally contain the scope key" trap this
 * avoids by routing through it rather than hand-rolling the LIKE match).
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimWatchdogFire, recentWatchdogFires, scopedFireReason } from '../../pot/watchdog';
import { RESTART_TARGET_UNITS } from '../../agent-tools/dev/restart-target-units';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { hostIdentity } from '../../serving-host-identity';
import {
  processBootCommitSha,
  processBootTimeMs,
  resolveCommitsBehind,
  resolveCurrentHeadCommit,
  resolveRoutineCodeDrift,
  type RoutineCodeDrift,
} from '../../dbos/process-boot-identity';

// Throttled — never shell out to git on every 30s routinesTick.
const CURRENT_HEAD_REFRESH_MS = 5 * 60_000;
let cachedCurrentHead: { sha: string | null; atMs: number } | null = null;

// Same reason, same cadence: once a process IS stale this sweep keeps running
// every tick (the alarm is debounced, the sweep is not), so the drift count is
// cached per head-pair rather than re-shelled 120×/hour for a number that only
// moves when HEAD does.
const cachedCommitsBehind = { key: '', value: null as number | null, atMs: 0 };

// Same pair-keyed memo, same reason: the routine-drift probe shells out to
// `git diff`, and the answer cannot change unless one endpoint sha does.
const cachedRoutineDrift = { key: '', value: null as RoutineCodeDrift | null, atMs: 0 };

async function currentHeadCommit(now: number): Promise<string | null> {
  if (cachedCurrentHead && now - cachedCurrentHead.atMs < CURRENT_HEAD_REFRESH_MS) {
    return cachedCurrentHead.sha;
  }
  const sha = await resolveCurrentHeadCommit();
  cachedCurrentHead = { sha, atMs: now };
  return sha;
}

/** Drift count for a boot/head PAIR, memoised on that pair. Keyed by both shas
 *  (not by time alone) so a moving HEAD invalidates it immediately while a
 *  static one is answered from cache — the count cannot change unless one of
 *  the two endpoints does. */
async function commitsBehindCached(bootCommit: string, currentCommit: string, now: number): Promise<number | null> {
  const key = `${bootCommit}..${currentCommit}`;
  if (cachedCommitsBehind.key === key && now - cachedCommitsBehind.atMs < CURRENT_HEAD_REFRESH_MS) {
    return cachedCommitsBehind.value;
  }
  const value = await resolveCommitsBehind(bootCommit, currentCommit);
  cachedCommitsBehind.key = key;
  cachedCommitsBehind.value = value;
  cachedCommitsBehind.atMs = now;
  return value;
}

async function routineDriftCached(
  bootCommit: string,
  currentCommit: string,
  now: number,
): Promise<RoutineCodeDrift | null> {
  const key = `${bootCommit}..${currentCommit}`;
  if (cachedRoutineDrift.key === key && now - cachedRoutineDrift.atMs < CURRENT_HEAD_REFRESH_MS) {
    return cachedRoutineDrift.value;
  }
  const value = await resolveRoutineCodeDrift(bootCommit, currentCommit);
  cachedRoutineDrift.key = key;
  cachedRoutineDrift.value = value;
  cachedRoutineDrift.atMs = now;
  return value;
}

// ── tunables (env-overridable, like every sibling watchdog) ───────────────────

/** How long a ROUTINES=1 process may run before its boot-commit-vs-tree-HEAD
 *  drift is even considered. Default 2h — long enough that a normal deploy/
 *  restart cadence never trips it, short enough that a genuinely long-lived
 *  stale executor (the measured case: 7h) is caught with real margin. `<=0`
 *  disables the sweep (kill switch). */
export function staleExecutorThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC ?? 7_200);
  return Number.isFinite(n) ? n : 7_200;
}

function routinesEnabledHere(): boolean {
  return process.env.PAPERCUSP_DBOS_ROUTINES === '1';
}

/** A stable-across-ticks, per-process identity so the debounce/escalation/paging
 *  never conflates two DIFFERENT executors (a stale desktop and a healthy
 *  :3070 must never clear each other's alert). Prefers the operator's own port
 *  (stable across restarts of "the same" logical service — :3070/:3170/:3270);
 *  falls back to a pid-scoped identity when no port is resolvable. */
export function executorIdentity(): string {
  // WI-1565914: ONE host vocabulary, shared with the `serving_host` column on
  // harness_shared.tool_invocations. Computing the label separately here would let
  // the two drift, and a drifted label cannot be joined — the staleness page and the
  // calls that host actually served would silently stop lining up.
  return hostIdentity();
}

export interface ExecutorAlarmContext {
  unit: string;
  restartLever: string;
  identityLabel: string;
  /** How the reader establishes that restarting is safe RIGHT NOW — null when no
   *  lever was resolved, because a safety claim about an unidentified service is
   *  worse than silence. See RESTART_SAFETY_NOTE for why this is written down at
   *  all rather than left to each reader. */
  restartSafety: string | null;
}

/**
 * The remediation half nobody could derive from the page, so everybody derived it
 * WRONG — separately, at full cost, more than once in a single night.
 *
 * The page already named the lever. What it never said is that the lever ANSWERS
 * the safety question itself: `dev:restart` without `confirm` is a side-effect-free
 * dry run whose `gate_collision` verdict comes from `checkGateCollision`, which
 * computes the real cgroup relation and blocks only on a genuine same-cgroup
 * collision or an imminent fire.
 *
 * Absent that sentence, two agents on 2026-08-30 each hand-derived the precondition
 * from process scans and each reached the same REFUTED conclusion — "a green-checkpoint
 * run is in flight, so restarting would kill it" — and both declined to remediate an
 * open page for an hour on the strength of it. The suite is deliberately spawned into
 * its own transient systemd scope (release-actions.ts `runScript`: "The routine parent
 * is not the durable owner of a scheduled run: it can be reaped while the systemd scope
 * keeps the suite alive"), so it is cgroup-isolated and survives the restart. That was
 * already established by MEASUREMENT twice — EI-20286473216066539 (2026-08-13) and
 * EI-21437097591910648 (2026-08-25, live probe with a run 2669s in flight reporting
 * kind:'run-in-flight-isolated', would_block:false).
 *
 * It keeps being re-derived because the false version is strictly SCARIER than the
 * truth, and a scary caution is the kind of claim agents preserve preferentially. The
 * durable fix is therefore to put the answer where the question is ASKED — on the page —
 * rather than to correct one more carry-note. Pinned against drift by
 * doc-claims/dev-restart-gate-collision-rationale.test.ts, so if the guard ever
 * legitimately starts blocking an isolated run, this text fails in the same change.
 *
 * THE SECOND HALF was added 2026-08-31 for the opposite failure. Once the refuted
 * caution was cleared, the remediation still did not happen — because the lever
 * REFUSES almost every time it is pulled, on `git_sync_collision`, and a single
 * refusal reads exactly like "blocked, not my problem". Measured that night: 20
 * consecutive attempts over 40s never saw fewer than 4 concurrent git-sync
 * operations. A reader who does not know that refusal is expected and transient
 * will abandon a remediation that was one retry loop away, which is how a page
 * stays open for two and a half hours with nothing actually wrong.
 *
 * AMENDED once that root cause was FIXED (EI-21930094737784126): the honest advice is
 * no longer "retry in a loop" but `git_sync_drain_sec`, which demotes the cgroup check
 * to advisory and lets the authoritative `git-sync` barrier arbitrate. A page that
 * names a lever owes its reader the ARGUMENTS that make it fire — not a hand-rolled
 * loop around a refusal the tool can now wait out itself.
 */
export const RESTART_SAFETY_NOTE =
  'Do NOT hand-derive whether restarting is safe right now — the lever answers it. Run the same call WITHOUT ' +
  '`confirm` first: that dry run has no side effects and returns `gate_collision` (plus `git_sync_collision`), ' +
  'which is authoritative. In particular an in-flight green-checkpoint run is NOT by itself a reason to wait — the ' +
  'suite runs detached in its own transient systemd scope, so it is cgroup-isolated and SURVIVES this restart ' +
  '(measured: EI-20286473216066539, re-confirmed EI-21437097591910648). Wait only if the dry run itself reports ' +
  'would_block:true. ' +
  'EXPECT the refusal you will actually get to be `git_sync_collision`, and do NOT read it as the end of the road: ' +
  'git-sync sweeps 38 submodules plus several pots from inside this host\'s own cgroup, so its operations are in ' +
  'flight nearly continuously (measured 2026-08-31: 20 consecutive attempts over 40s, never fewer than 4 in ' +
  'flight). That refusal is EXPECTED, TRANSIENT, and side-effect-free — "NOTHING was done: no cooldown claimed, ' +
  'no drain, no signal". The supported way through is `git_sync_drain_sec` (seconds, up to 45) on the same call: ' +
  'with a drain budget the cgroup check is only ADVISORY and the workspace-wide `git-sync` barrier arbitrates ' +
  'instead — fires hold that barrier just ~5-10s, and it measured FREE in 20 of 40 sampled seconds. Pass the same ' +
  'value to the dry run, so the preview answers for the call you are actually about to make. A `drain_timeout` is ' +
  'equally side-effect-free, so retry once rather than abandoning the remediation. ' +
  'Do NOT reach for `override_git_sync_collision` to force past it: that SIGKILLs a commit after lock acquisition ' +
  'and strands a peer\'s uncommitted work. It is reserved for a host that is genuinely wedged, which a merely ' +
  'busy one is not.';

/**
 * EI-23577541806415104: the stale-executor alarm is actionable on the one
 * executor that owns both git-sync and release-trigger. Keep this drain short
 * and bounded: it waits for an ordinary git-sync fire to finish, while the
 * restart tool's max_drain_sec:0 still refuses to trample a consequential
 * exclusive-resource holder. Never add an override flag here — those flags
 * turn a busy host into a peer-work-destroying restart.
 */
export const STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC = 45;
export const STALE_EXECUTOR_RESTART_COOLDOWN_MS = 13 * 60_000;
const STALE_EXECUTOR_PTOOL_TIMEOUT_MS = 30_000 + STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC * 1_000;
const STALE_EXECUTOR_RESTART_PID_WAIT_MS = 30_000;
const STALE_EXECUTOR_RESTART_PID_POLL_MS = 250;

let staleExecutorRestartInFlight = false;
let staleExecutorRestartCooldownUntilMs = 0;

type RestartCommandResult = { stdout: string; error?: string };
type RestartCommand = (
  command: string,
  args: string[],
  options: { stdin: string; timeout: number },
) => Promise<RestartCommandResult>;

function runRestartCommand(command: string, args: string[], options: { stdin: string; timeout: number }): Promise<RestartCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ stdout: String(stdout ?? ''), error: error?.message }),
    );
    child.stdin?.end(options.stdin);
  });
}

function parsePtoolJson(stdout: string): Record<string, unknown> | null {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    for (const line of raw.split('\n').reverse()) {
      try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      } catch {
        // ptool may be wrapped by a launcher that writes a non-JSON prelude.
      }
    }
    return null;
  }
}

async function readBgHostMainPid(run: RestartCommand = runRestartCommand): Promise<number | null> {
  const result = await run('systemctl', ['--user', 'show', RESTART_TARGET_UNITS['bg-host'], '-p', 'MainPID', '--value'], {
    stdin: '',
    timeout: 3_000,
  });
  if (result.error) return null;
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export interface StaleExecutorGenerationVerification {
  verified: boolean;
  beforePid: number | null;
  observedPid: number | null;
  code: 'generation_changed' | 'generation_unknown' | 'generation_unchanged' | 'baseline_unknown';
}

/** Verify that a detached restart actually replaced the bg-host generation. */
export async function waitForStaleExecutorRestartGeneration(
  beforePid: unknown,
  deps: {
    run?: RestartCommand;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
    pollMs?: number;
  } = {},
): Promise<StaleExecutorGenerationVerification> {
  const baseline = Number(beforePid);
  if (!Number.isInteger(baseline) || baseline <= 0) {
    return { verified: false, beforePid: null, observedPid: null, code: 'baseline_unknown' };
  }
  const run = deps.run ?? runRestartCommand;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = Number.isFinite(deps.waitMs) && (deps.waitMs ?? 0) >= 0 ? deps.waitMs! : STALE_EXECUTOR_RESTART_PID_WAIT_MS;
  const pollMs = Number.isFinite(deps.pollMs) && (deps.pollMs ?? 0) >= 0 ? deps.pollMs! : STALE_EXECUTOR_RESTART_PID_POLL_MS;
  const startedAt = now();
  let observedPid: number | null = null;
  while (now() - startedAt <= waitMs) {
    observedPid = await readBgHostMainPid(run).catch(() => null);
    if (observedPid !== null && observedPid !== baseline) {
      return { verified: true, beforePid: baseline, observedPid, code: 'generation_changed' };
    }
    const remaining = waitMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }
  return {
    verified: false,
    beforePid: baseline,
    observedPid,
    code: observedPid === null ? 'generation_unknown' : 'generation_unchanged',
  };
}

export interface StaleExecutorRestartResult {
  attempted: boolean;
  restarted: boolean;
  coalesced: boolean;
  verified: boolean;
  code: string;
  error?: string;
}

/**
 * Auto-remediate only the stale, routines-enabled bg-host executor. All
 * inputs/side effects are injectable so the sweep's recovery path has a real
 * regression test and cannot silently grow a raw-systemctl escape hatch.
 */
export async function restartStaleBgHostExecutor(
  identity: string,
  verdict: ExecutorStalenessVerdict,
  deps: {
    now?: () => number;
    run?: RestartCommand;
    verifyGeneration?: (beforePid: unknown) => Promise<StaleExecutorGenerationVerification>;
    ptoolScript?: string;
  } = {},
): Promise<StaleExecutorRestartResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const skipped = (code: string): StaleExecutorRestartResult => ({
    attempted: false,
    restarted: false,
    coalesced: false,
    verified: false,
    code,
  });
  if (identity !== 'port-3271') return skipped('identity_not_bg_host');
  if (!verdict.stale) return skipped('not_stale');
  if (staleExecutorRestartInFlight) return skipped('restart_in_flight');
  if (nowMs < staleExecutorRestartCooldownUntilMs) return skipped('restart_cooldown');

  staleExecutorRestartInFlight = true;
  try {
    const run = deps.run ?? runRestartCommand;
    const ptoolScript =
      deps.ptoolScript ??
      process.env.PAPERCUSP_PTOOL_SCRIPT?.trim() ??
      fileURLToPath(new URL('../../../../../apps/operator/scripts/ptool.mjs', import.meta.url));
    const beforePid = await readBgHostMainPid(run).catch(() => null);
    const args = {
      target: 'bg-host',
      confirm: true,
      authorize: true,
      max_drain_sec: 0,
      git_sync_drain_sec: STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC,
      reason: `auto-remediate stale routines-enabled bg-host executor; ${identity}`,
    };
    const result = await run(process.execPath, [ptoolScript, 'dev:restart', '--json', '-'], {
      stdin: JSON.stringify(args),
      timeout: STALE_EXECUTOR_PTOOL_TIMEOUT_MS,
    });
    // ptool exits non-zero on an ok:false answer (EI-24654733539966460), so a
    // refused restart arrives WITH result.error. Its body still names the
    // refusal — judge it before collapsing the error to 'ptool_failed'.
    const body = parsePtoolJson(result.stdout);
    if (result.error && body?.ok !== false) return { ...skipped('ptool_failed'), attempted: true, error: result.error };
    if (!body || body.ok !== true) {
      return { ...skipped(typeof body?.reason === 'string' ? body.reason : 'ptool_result_unknown'), attempted: true };
    }
    const coalesced = body.coalesced === true;
    if (coalesced) {
      staleExecutorRestartCooldownUntilMs = nowMs + STALE_EXECUTOR_RESTART_COOLDOWN_MS;
      return { attempted: true, restarted: false, coalesced: true, verified: body.verified === true, code: 'coalesced' };
    }
    if (body.restarted !== true) return { ...skipped('no_restart'), attempted: true };
    const verify =
      deps.verifyGeneration ??
      ((pid: unknown) => waitForStaleExecutorRestartGeneration(pid, { run }));
    const generation = await verify(body.restartedFromPid ?? beforePid);
    if (!generation.verified) {
      return { attempted: true, restarted: false, coalesced: false, verified: false, code: 'restart_unverified' };
    }
    staleExecutorRestartCooldownUntilMs = nowMs + STALE_EXECUTOR_RESTART_COOLDOWN_MS;
    return { attempted: true, restarted: true, coalesced: false, verified: true, code: 'restarted' };
  } catch (error) {
    return {
      ...skipped('restart_failed'),
      attempted: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    staleExecutorRestartInFlight = false;
  }
}

/**
 * Resolve the user-facing identity and sanctioned remediation for an executor.
 *
 * The routines primary is a child of `papercup-bg-host.service`; its worker PID
 * is therefore not the systemd MainPID and is unsafe as a standalone alarm
 * identity. Keep the mapping pure so the alarm text has a focused regression
 * bar and unknown identities fail visibly instead of suggesting a PID action.
 */
export function executorAlarmContext(identity: string): ExecutorAlarmContext {
  const knownByIdentity: Record<string, { unit: string; target: string }> = {
    'port-3070': { unit: RESTART_TARGET_UNITS.dev, target: 'dev' },
    'port-3170': { unit: RESTART_TARGET_UNITS.staging, target: 'staging' },
    'port-3271': { unit: RESTART_TARGET_UNITS['bg-host'], target: 'bg-host' },
  };
  const known = knownByIdentity[identity];
  if (known) {
    return {
      unit: known.unit,
      restartLever: `dev:restart { target: '${known.target}', confirm: true, authorize: true, reason: 'reload the owning executor with updated code' }`,
      identityLabel: `${known.unit} (executor identity ${identity})`,
      restartSafety: RESTART_SAFETY_NOTE,
    };
  }

  const configuredUnit = process.env.PAPERCUSP_SYSTEMD_UNIT?.trim();
  const unit = configuredUnit || 'systemd unit unresolved';
  return {
    unit,
    restartLever: configuredUnit
      ? `the sanctioned dev:restart target for ${configuredUnit}`
      : 'resolve the owning service before choosing its sanctioned dev:restart target',
    identityLabel: `${unit} (executor identity ${identity})`,
    // No resolved lever means no dry run to point at, and a safety claim about an
    // unidentified service would be exactly the unfounded reassurance this note
    // exists to replace. Stay silent instead.
    restartSafety: null,
  };
}

// ── pure decider (no DB, no git — everything injected) ────────────────────────

export interface ExecutorStalenessInput {
  routinesEnabled: boolean;
  bootCommit: string | null;
  currentCommit: string | null;
  bootTimeMs: number;
  now: number;
  thresholdMs: number;
  /** How many commits this process's boot code is behind the tree, when it can
   *  be resolved. OPTIONAL and injected (the decider stays pure): an omitted or
   *  null value degrades the alarm to its uptime-only wording rather than
   *  printing a fabricated magnitude. */
  commitsBehind?: number | null;
  /** WHICH routine code this process is wrong about, when it can be resolved.
   *  Injected like `commitsBehind` so the decider stays pure; null/omitted
   *  degrades the alarm to its commit-count wording rather than printing a
   *  fabricated — or falsely reassuring — functional verdict. */
  routineDrift?: RoutineCodeDrift | null;
}

export interface ExecutorStalenessVerdict {
  stale: boolean;
  reason: string;
  ageMs: number;
  /** Echoed through so the pager/broadcast can rank by DRIFT, not just uptime.
   *  null whenever it could not be resolved. */
  commitsBehind?: number | null;
  /** Echoed through so the escalation row carries the functional drift, not just
   *  the magnitude. null whenever it could not be resolved. */
  routineDrift?: RoutineCodeDrift | null;
}

/** How many file names a page prints before collapsing the rest into a count.
 *  Small on purpose: the page is read in a notification and an escalation row,
 *  and an unbounded list is how a page becomes unreadable and therefore ignored. */
export const ROUTINE_DRIFT_NAME_CAP = 4;

function nameList(paths: string[], cap = ROUTINE_DRIFT_NAME_CAP): string {
  const shown = paths.slice(0, cap).map((p) => p.slice(p.lastIndexOf('/') + 1));
  const extra = paths.length - shown.length;
  // The overflow is always STATED. Silently truncating a list of what is broken
  // is the same class of lie as printing a fabricated count.
  return extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
}

/**
 * PURE: turn resolved routine drift into the clause that makes a page credible.
 *
 * WHY THIS EXISTS. On 2026-08-31 a page reporting "143 COMMITS BEHIND" sat open and
 * unacted for over two hours while two agents read it. A commit count is a magnitude
 * with no content: it cannot distinguish 143 commits of unrelated churn from the
 * actual state, which was that four routine source files did not exist in the running
 * process at all — two of them whole routines that had therefore never fired once.
 * "143 commits behind" is ignorable. "two routines are not running" is not.
 *
 * The two cases are deliberately worded as different severities, because they ARE:
 * a CHANGED handler means the process runs an old version; an ADDED file means the
 * process has no version, and no amount of waiting will make it run.
 *
 * Returns '' for null (unresolvable) AND for an all-empty probe — never a negative
 * claim. The probe is a bounded lower bound (see ROUTINE_SOURCE_PREFIX), so "found
 * nothing" is not "nothing is wrong", and saying so would re-introduce exactly the
 * false all-clear this watchdog exists to prevent.
 */
export function routineDriftSentence(drift: RoutineCodeDrift | null | undefined): string {
  if (!drift) return '';
  const added = drift.addedSinceBoot ?? [];
  const changed = drift.changed ?? [];
  if (added.length === 0 && changed.length === 0) return '';
  const parts: string[] = [];
  if (added.length > 0) {
    const one = added.length === 1;
    parts.push(
      `${added.length} routine source file${one ? '' : 's'} (${nameList(added)}) ` +
        `${one ? 'does' : 'do'} not exist in this process at all, so ` +
        `${one ? 'the routine it defines is' : 'the routines they define are'} NOT RUNNING here`,
    );
  }
  if (changed.length > 0) {
    const one = changed.length === 1;
    parts.push(
      `${changed.length} routine handler${one ? '' : 's'} it does run ${one ? 'has' : 'have'} ` +
        `changed since boot (${nameList(changed)})`,
    );
  }
  return ` — ${parts.join('; and ')}`;
}

/**
 * PURE: is this process a stale routine executor right now?
 *
 * Deliberately conservative in every ambiguous direction — a false alert here
 * pages a human for nothing, but a false SILENCE is the exact bug this exists
 * to close, so the asymmetry is: fail toward not-stale whenever the inputs are
 * incomplete, and only alert on a positively-confirmed commit divergence.
 */
export function evaluateExecutorStaleness(input: ExecutorStalenessInput): ExecutorStalenessVerdict {
  const ageMs = Math.max(0, input.now - input.bootTimeMs);
  if (!input.routinesEnabled) {
    return { stale: false, reason: 'PAPERCUSP_DBOS_ROUTINES is not enabled on this process', ageMs };
  }
  if (input.thresholdMs <= 0) {
    return { stale: false, reason: 'kill switch (thresholdMs <= 0)', ageMs };
  }
  if (ageMs < input.thresholdMs) {
    return {
      stale: false,
      reason: `process uptime ${Math.round(ageMs / 60_000)}m is under the ${Math.round(input.thresholdMs / 60_000)}m threshold`,
      ageMs,
    };
  }
  if (!input.bootCommit || !input.currentCommit) {
    return {
      stale: false,
      reason: 'boot or current tree commit unresolvable (no git checkout, or a read failed) — skipping, fail-safe',
      ageMs,
    };
  }
  if (input.bootCommit === input.currentCommit) {
    return { stale: false, reason: 'boot commit still matches this checkout\'s tree HEAD — nothing has moved since boot', ageMs };
  }
  const ageHours = Math.round(ageMs / 3_600_000);
  // Lead with DRIFT, not uptime. A reader anchors on the first number they see,
  // and uptime systematically understates the harm: the 2026-08-30 incident
  // paged as "has run 2h" — mild-sounding — while the executor was 109 commits
  // behind. Hours measure how long it has been wrong; commits measure how wrong.
  const behind = typeof input.commitsBehind === 'number' && input.commitsBehind > 0 ? input.commitsBehind : null;
  const drift = behind === null ? '' : ` and is ${behind} COMMIT${behind === 1 ? '' : 'S'} BEHIND the tree`;
  // The magnitude says how wrong; this says WHAT is wrong, which is the half that
  // decides whether anyone acts on the page at all.
  const functional = routineDriftSentence(input.routineDrift);
  return {
    stale: true,
    reason:
      `this process has run ${ageHours}h with PAPERCUSP_DBOS_ROUTINES=1${drift}, code loaded at boot commit ` +
      `${input.bootCommit.slice(0, 10)}, while this checkout's tree HEAD has since moved to ` +
      `${input.currentCommit.slice(0, 10)}${functional}. Scheduled-routine fixes committed since boot are not loaded ` +
      `by this process (EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs ` +
      `to run routines, unset PAPERCUSP_DBOS_ROUTINES on it.`,
    ageMs,
    commitsBehind: input.commitsBehind ?? null,
    routineDrift: input.routineDrift ?? null,
  };
}

// ── paging rails (same trio every sibling pipeline/staleness watchdog uses) ───

function phaseFor(identity: string): string {
  return `stale-routine-executor-watchdog:${identity}`;
}

function conditionKeyFor(identity: string): string {
  return `stale-routine-executor:${identity}`;
}

/** " and 109 COMMITS BEHIND", or '' when the count could not be resolved — a
 *  page must never print a fabricated magnitude, and an absent number has to
 *  read as absent rather than as zero. */
function driftSuffix(verdict: ExecutorStalenessVerdict): string {
  const n = verdict.commitsBehind;
  if (typeof n !== 'number' || n <= 0) return '';
  return ` and ${n} COMMIT${n === 1 ? '' : 'S'} BEHIND`;
}

/** What the watchdog stores on an open escalation row — the thing a reader actually
 *  finds an hour later, once the notification has scrolled away. */
export interface StaleExecutorEscalation {
  kind: string;
  harness_slug: string;
  identity: string;
  ageHours: number;
  commitsBehind: number | null;
  /** WHICH routine code is wrong, not just how much — the field that lets a reader
   *  an hour later tell "143 commits of unrelated churn" from "two routines have
   *  never fired". null when the probe could not run; empty arrays mean it ran and
   *  found nothing IN ITS BOUNDED SCOPE, which is not a clean bill of health. */
  routineDrift: RoutineCodeDrift | null;
  detail: string;
  unit: string;
  restartLever: string;
  restartSafety: string | null;
  /** When the page FIRST opened. Never overwritten by a refresh — it is the only
   *  field that answers "how long has this been ignored". */
  emitted_at: number;
  refreshed_at?: number;
  /** Hours the page has been open and unacted. null when `emitted_at` was
   *  unreadable on the prior row, because a fabricated zero would read as "just
   *  opened" — the opposite of the truth this field exists to carry. */
  openForHours?: number | null;
}

/**
 * PURE: refresh an OPEN page's numbers without re-paging.
 *
 * The alarm is deliberately one-shot per episode, which is right for the NOTIFICATION
 * and wrong for the ROW: the escalation row froze at first-page and then silently
 * misreported for as long as the condition lasted. On 2026-08-30 it read "has run 2h"
 * for over an hour after that had stopped being true, while the drift kept growing —
 * a stale value inside the very watchdog built to report staleness.
 *
 * `openForHours` is the number that makes an ignored page hard to keep ignoring, and it
 * is why `emitted_at` is carried over rather than restamped: a refresh that moved it
 * would reset the page's apparent age on every tick and hide exactly what it should show.
 */
export function refreshedEscalationPayload(
  prev: unknown,
  next: Omit<StaleExecutorEscalation, 'emitted_at' | 'refreshed_at' | 'openForHours'>,
  now: number,
): StaleExecutorEscalation {
  // ⚠ `harness_escalations.escalation` is a TEXT column, not jsonb — verified against the
  // live schema — so the driver hands this back as a JSON STRING, not a parsed object. An
  // object-only reader would treat every real row as unreadable, silently restamp
  // `emitted_at`, and reset the page's apparent age on every refresh: the feature would
  // look implemented and do the exact opposite of its purpose, with no error anywhere.
  // Accept both shapes rather than relying on the column's storage type staying put.
  const parsed =
    typeof prev === 'string'
      ? (() => {
          try {
            return JSON.parse(prev) as unknown;
          } catch {
            return null;
          }
        })()
      : prev;
  const prevRow = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<StaleExecutorEscalation>;
  const emittedAt =
    typeof prevRow.emitted_at === 'number' && Number.isFinite(prevRow.emitted_at) ? prevRow.emitted_at : null;
  return {
    ...next,
    emitted_at: emittedAt ?? now,
    refreshed_at: now,
    openForHours: emittedAt === null ? null : Math.round((now - emittedAt) / 3_600_000),
  };
}

async function raiseExecutorStalenessAlarm(opts: {
  workspaceId: string;
  installSlug: string;
  identity: string;
  verdict: ExecutorStalenessVerdict;
  now: number;
}): Promise<boolean> {
  const { workspaceId, installSlug, identity, verdict, now } = opts;
  const phase = phaseFor(identity);
  const alarmContext = executorAlarmContext(identity);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // TEXT column (see refreshedEscalationPayload) — typed honestly so a reader is not
    // misled into assuming the driver parsed it.
    const existing = await sql<{ escalation: string | null }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${phase}`;
    const ageHours = Math.round(verdict.ageMs / 3_600_000);
    /** Everything about the CURRENT reading — shared by the first page and every later
     *  refresh, so the two can never describe the condition differently. */
    const rowFacts = {
      kind: phase,
      harness_slug: installSlug,
      identity,
      ageHours,
      commitsBehind: verdict.commitsBehind ?? null,
      routineDrift: verdict.routineDrift ?? null,
      detail: verdict.reason,
      // The escalation ROW is what a reader finds an hour later, once the notification
      // has scrolled away — so the remediation has to travel WITH it, not only on the
      // broadcast that announced it.
      unit: alarmContext.unit,
      restartLever: alarmContext.restartLever,
      restartSafety: alarmContext.restartSafety,
    };

    if (existing.length > 0 && existing[0].escalation != null) {
      // Already paged this EPISODE. The notification stays one-shot — re-paging an
      // unchanged condition is how a watchdog trains people to mute it. But the ROW must
      // not freeze at its first reading: this branch used to drop the claimed fire on the
      // floor, so an open page kept reporting the uptime and drift it had when it opened,
      // for as long as the condition lasted. Reached once per debounce window (the fire is
      // already claimed by the caller), so refreshing here adds no cadence of its own.
      try {
        const refreshed = refreshedEscalationPayload(existing[0].escalation, rowFacts, now);
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = ${JSON.stringify(refreshed)}, mtime_ms = ${now}
           WHERE harness_slug = ${installSlug} AND phase = ${phase}`;
      } catch (e) {
        console.warn(`[stale-routine-executor] escalation refresh failed: ${e instanceof Error ? e.message : e}`);
      }
      return false;
    }

    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: `Stale routine executor (${alarmContext.identityLabel}) is running code older than the checkout`,
        body: verdict.reason,
        importance: 'urgent',
        workspaceId,
        harnessSlug: installSlug,
        data: {
          ageHours,
          commitsBehind: verdict.commitsBehind ?? null,
          routineDrift: verdict.routineDrift ?? null,
          identity,
          unit: alarmContext.unit,
          restartLever: alarmContext.restartLever,
          restartSafety: alarmContext.restartSafety,
        },
      });
    } catch (e) {
      console.warn(`[stale-routine-executor] notify failed: ${e instanceof Error ? e.message : e}`);
    }

    const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
    await broadcastSevereEvent({
      summary:
        `stale routine executor ${alarmContext.identityLabel} has run ${ageHours}h${driftSuffix(verdict)} with code from ` +
        `its boot while PAPERCUSP_DBOS_ROUTINES=1 and the checkout has moved` +
        // The headline is the line most readers act (or fail to act) on, so the
        // functional drift belongs HERE and not only in the body: a magnitude alone
        // reads as background churn, which is precisely how the 2026-08-31 page was
        // read by two agents in succession.
        `${routineDriftSentence(verdict.routineDrift)}. Scheduled-routine fixes committed since boot ` +
        `are not loaded by this process; restart ${alarmContext.unit} with ${alarmContext.restartLever} to pick up current code.`,
      body:
        `${verdict.reason}\n\nThe worker identity is not necessarily the systemd MainPID. Do NOT kill or duplicate a worker PID ` +
        `to "fix" this; restart ${alarmContext.unit} with ${alarmContext.restartLever}, or stop carrying ` +
        `PAPERCUSP_DBOS_ROUTINES=1 on that service if it no longer needs to run routines.` +
        (alarmContext.restartSafety ? `\n\n${alarmContext.restartSafety}` : ''),
      category: 'severe-event',
      conditionKey: conditionKeyFor(identity),
      oneShot: true,
    });

    try {
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${installSlug}, ${phase}, ${JSON.stringify({ ...rowFacts, emitted_at: now })}, ${now}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
    } catch (e) {
      console.warn(`[stale-routine-executor] escalation write failed: ${e instanceof Error ? e.message : e}`);
    }
    return true;
  } catch (e) {
    console.warn(`[stale-routine-executor] alarm failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Recovery leg — mirrors clearDeployStalenessAlarm. Fires on every HEALTHY tick
 *  from THIS identity (idempotent; a no-op unless this identity was previously
 *  alarmed), so a restarted (freshly-booted) executor retracts its own stale page
 *  the moment it re-runs the sweep and finds itself no longer stale. */
async function clearExecutorStalenessAlarm(opts: { installSlug: string; identity: string; now: number }): Promise<boolean> {
  const { installSlug, identity, now } = opts;
  const phase = phaseFor(identity);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const cleared = await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${now}
       WHERE harness_slug = ${installSlug}
         AND phase = ${phase}
         AND escalation IS NOT NULL`;
    if (cleared.count === 0) return false;
    const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: conditionKeyFor(identity),
      summary: `stale routine executor (${identity}) RECOVERED — it is running current code again (restart, most likely).`,
    });
    return true;
  } catch (e) {
    console.warn(`[stale-routine-executor] recovery failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ── the sweep ───────────────────────────────────────────────────────────────

export interface StaleExecutorSweepResult {
  outcome: 'alerted' | 'skipped' | 'healthy' | 'error';
  verdict?: ExecutorStalenessVerdict;
  reason: string;
  paged?: boolean;
  recovered?: boolean;
  restart?: StaleExecutorRestartResult;
}

export interface StaleExecutorSweepDependencies {
  /** Injectable probe values keep the sweep's orchestration testable without git or DB. */
  bootCommit?: string | null;
  currentCommit?: string | null;
  bootTimeMs?: number;
  commitsBehind?: number | null;
  routineDrift?: RoutineCodeDrift | null;
  restart?: (identity: string, verdict: ExecutorStalenessVerdict) => Promise<StaleExecutorRestartResult>;
  recentWatchdogFires?: typeof recentWatchdogFires;
  claimWatchdogFire?: typeof claimWatchdogFire;
  raiseExecutorStalenessAlarm?: typeof raiseExecutorStalenessAlarm;
  clearExecutorStalenessAlarm?: typeof clearExecutorStalenessAlarm;
}

/**
 * Runs on this process's own routinesTick. Judges only THIS process (never a
 * peer's) via its own boot-commit-vs-tree-HEAD drift + uptime — no cross-process
 * coordination, no lease, no change to claiming/dispatch. Fail-soft throughout;
 * kill switch PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC<=0.
 */
export async function staleRoutineExecutorSweep(opts: {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
}, deps: StaleExecutorSweepDependencies = {}): Promise<StaleExecutorSweepResult> {
  const thresholdSec = staleExecutorThresholdSec();
  if (thresholdSec <= 0) return { outcome: 'skipped', reason: 'kill switch' };
  const enabled = routinesEnabledHere();
  if (!enabled) return { outcome: 'skipped', reason: 'PAPERCUSP_DBOS_ROUTINES not enabled on this process' };

  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? operatorHomeHarnessSlug();
  const now = opts.now ?? Date.now();
  const identity = executorIdentity();

  try {
    const [bootCommit, currentCommit] = await Promise.all([
      deps.bootCommit !== undefined ? deps.bootCommit : processBootCommitSha(),
      deps.currentCommit !== undefined ? deps.currentCommit : currentHeadCommit(now),
    ]);
    const bootTimeMs = deps.bootTimeMs ?? processBootTimeMs();
    const thresholdMs = thresholdSec * 1_000;
    // Only pay for the drift count once this process is ALREADY past the uptime
    // threshold AND the shas differ. A young process on a moving tree is the
    // common case and must not shell out to git on every 30s tick.
    const driftWorthResolving =
      now - bootTimeMs >= thresholdMs && !!bootCommit && !!currentCommit && bootCommit !== currentCommit;
    // One gate for both probes, so the magnitude and the functional detail can
    // never disagree about whether they were even measured.
    const [commitsBehind, routineDrift] = driftWorthResolving
      ? await Promise.all([
          deps.commitsBehind !== undefined
            ? deps.commitsBehind
            : commitsBehindCached(bootCommit!, currentCommit!, now),
          deps.routineDrift !== undefined
            ? deps.routineDrift
            : routineDriftCached(bootCommit!, currentCommit!, now),
        ])
      : [null, null];
    const verdict = evaluateExecutorStaleness({
      routinesEnabled: enabled,
      bootCommit,
      currentCommit,
      bootTimeMs,
      now,
      thresholdMs,
      commitsBehind,
      routineDrift,
    });

    if (!verdict.stale) {
      const clearAlarm = deps.clearExecutorStalenessAlarm ?? clearExecutorStalenessAlarm;
      const recovered = await clearAlarm({ installSlug, identity, now });
      return { outcome: 'healthy', verdict, reason: verdict.reason, recovered };
    }

    // Remediation is intentionally independent of the alert's one-shot debounce:
    // an old alert row must not strand a still-frozen executor. The actuator has
    // its own identity, staleness, in-flight, and cooldown guards.
    let restart: StaleExecutorRestartResult;
    try {
      const restartExecutor = deps.restart ?? restartStaleBgHostExecutor;
      restart = await restartExecutor(identity, verdict);
    } catch (error) {
      restart = {
        attempted: true,
        restarted: false,
        coalesced: false,
        verified: false,
        code: 'restart_hook_failed',
        error: error instanceof Error ? error.message : String(error),
      };
      console.warn(`[stale-routine-executor] remediation failed (non-fatal): ${restart.error}`);
    }

    const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
    const recentFires = deps.recentWatchdogFires ?? recentWatchdogFires;
    const alreadyFiredRecently =
      (await recentFires(workspaceId, installSlug, windowHours, 'stale-routine-executor', identity)) > 0;
    if (alreadyFiredRecently) {
      return { outcome: 'skipped', verdict, reason: 'debounced', restart };
    }

    const reason = scopedFireReason(`stale routine executor: ${verdict.reason}`, identity, 'stale-routine-executor');
    const claimFire = deps.claimWatchdogFire ?? claimWatchdogFire;
    const claimed = await claimFire({
      workspaceId,
      installSlug,
      source: 'stale-routine-executor',
      reason,
      wakeAt: null,
      windowHours,
      scopeKey: identity,
    });
    if (!claimed) {
      return { outcome: 'skipped', verdict, reason: 'debounced (raced or backed off)', restart };
    }

    const raiseAlarm = deps.raiseExecutorStalenessAlarm ?? raiseExecutorStalenessAlarm;
    const paged = await raiseAlarm({ workspaceId, installSlug, identity, verdict, now });
    console.warn(`[stale-routine-executor] ALERT (${identity}): ${reason}`);
    return { outcome: 'alerted', verdict, reason, paged, restart };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
