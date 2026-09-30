/**
 * Durable logical qualification transaction.
 *
 * One record lives beside the green-checkpoint routine's existing gate_health /
 * repair_queue metadata. It is a coordination root, not a second scheduler or
 * lock: the existing routine claimant and physical run lock remain the safety
 * authorities. This record makes the logical attempt, retry policy, current
 * physical runner, blockers, and evidence machine-readable across processes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import { boundedOrgTxn } from '../pg-bounded-txn';
import { appendPipelineEvent } from '../harness/git-sync/pipeline-events';
import {
  frozenRepairHeadAwaitsVerification,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  parseCheckpointEligibilitySnapshot,
  type CheckpointEligibilitySnapshot,
} from './checkpoint-eligibility-snapshot';

export const CHECKPOINT_QUALIFICATION_METADATA_KEY = 'qualificationTransaction';
export const CHECKPOINT_QUALIFICATION_SCHEMA_VERSION = 1 as const;
/** Transported into a detached checkpoint so its verdict settles the exact logical attempt. */
export const CHECKPOINT_QUALIFICATION_ATTEMPT_ENV = 'PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID';
/** The scheduled wrapper reserves this attempt before spawn; the CLI activates that same runner. */
export const CHECKPOINT_SCHEDULED_RUN_ENV = 'PAPERCUSP_CHECKPOINT_SCHEDULED_RUN';

export function checkpointPidIdentity(pid: number): string | null {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (!bootId || commandEnd < 0) return null;
    const startTicks = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    return startTicks && /^\d+$/.test(startTicks) ? `${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
}

/**
 * What a caller has PROVED about a runner's process. 'unknown' is not a soft 'dead': every
 * reclaim path below treats it exactly as the pre-liveness code did, so a probe that breaks
 * degrades to the old lease-only behaviour instead of handing one candidate to two runners.
 */
export type RunnerLiveness = 'live' | 'dead' | 'unknown';
export type RunnerLivenessProber = (runner: QualificationPhysicalRunner) => RunnerLiveness;

/**
 * How long an attempt with NO physical runner may sit untouched before it is treated as abandoned.
 *
 * Deliberately derived, not tuned: a runner cannot outlive the detached suite's own systemd
 * ceiling (`CHECKPOINT_MAX_RUNTIME_SEC`, 3h — duplicated here rather than imported to keep this
 * coordination record free of a dependency on the launcher). So a record untouched for longer than
 * that ceiling cannot still have a living owner, whatever it claims.
 */
export const QUALIFICATION_OWNER_ABANDONED_MS = 3 * 60 * 60 * 1_000;
/** Three missed one-minute runner heartbeats warrant investigation, never a second runner. */
export const QUALIFICATION_PROGRESS_STALE_MS = 3 * 60_000;
/** An admitted scheduler fire may be probed before systemd has created its named scope. */
export const QUALIFICATION_LAUNCH_GRACE_MS = 60_000;

function launchReservationInGrace(runner: QualificationPhysicalRunner | null | undefined, nowMs: number): boolean {
  return !!runner && runner.phase === 'launching' && nowMs - runner.reservedAtMs < QUALIFICATION_LAUNCH_GRACE_MS;
}

const systemdRunnerLiveness: RunnerLivenessProber = (runner) => {
  if (runner.pid != null) {
    try {
      process.kill(runner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    }
    const observed = checkpointPidIdentity(runner.pid);
    return !observed || !runner.pidIdentity ? 'unknown' : observed === runner.pidIdentity ? 'live' : 'dead';
  }
  const unit = runner.unit?.trim();
  // Rows written before `unit` existed cannot be falsified — say so rather than guessing.
  if (!unit) return 'unknown';
  const read = (value: unknown): RunnerLiveness | null => {
    const state = String(value ?? '').trim();
    if (state === 'active' || state === 'activating') return 'live';
    // `is-active` prints `inactive` for a unit systemd has never heard of, which is precisely the
    // case we care about: a transient unit that has already been collected.
    if (state === 'inactive' || state === 'failed' || state === 'deactivating') return 'dead';
    return null;
  };
  try {
    return (
      read(
        execFileSync('systemctl', ['--user', 'is-active', unit], {
          encoding: 'utf8',
          timeout: 5_000,
        }),
      ) ?? 'unknown'
    );
  } catch (error) {
    // A non-active unit makes `is-active` exit non-zero WITH the state on stdout, so the throw is
    // the normal path for a dead unit, not an error.
    return read((error as { stdout?: unknown } | null)?.stdout) ?? 'unknown';
  }
};

let runnerLivenessProber: RunnerLivenessProber = systemdRunnerLiveness;

/** Host seam — tests install a deterministic prober instead of shelling out to systemd. */
export function configureRunnerLivenessProber(prober: RunnerLivenessProber | null): void {
  runnerLivenessProber = prober ?? systemdRunnerLiveness;
}

export function probeRunnerLiveness(runner: QualificationPhysicalRunner | null | undefined, nowMs = Date.now()): RunnerLiveness {
  if (!runner) return 'unknown';
  const observed = runnerLivenessProber(runner);
  // A scope name is reserved in the DB before systemd-run creates it. Its temporary absence
  // cannot authorize a second physical run during that launch interval.
  return observed === 'dead' && launchReservationInGrace(runner, nowMs) ? 'unknown' : observed;
}

export const PRE_SUITE_NO_VERDICT_REASONS = [
  'authority-unreadable',
  'authority-held',
  'migrations-pending',
  'source-mutated',
  'eligibility-wait',
  'would-exclude-declared-paths',
  'wait-for-eligibility-unavailable',
  'repair-in-progress',
  'repair-queue-unreadable',
  'required-ancestor-missing',
  'required-ancestor-unverifiable',
  'probe-failed',
  'already-running',
  'skipped-locked',
  'cancelled',
  'deadline-exceeded',
  // The reserving process PROVED the incumbent runner's unit was gone and took the lease from it.
  // Distinct from 'deadline-exceeded' (a runner that overran) and from 'cancelled' (a deliberate
  // stop): this one means nobody was ever going to advance that attempt.
  'runner-vanished',
  'disk-headroom',
  'infra-inconclusive',
  'target-readers',
  'dependency-generation',
  'backup-admission',
  'launch-refused',
] as const;

export type PreSuiteNoVerdictReason = (typeof PRE_SUITE_NO_VERDICT_REASONS)[number];
export type QualificationPhase = 'waiting' | 'ready' | 'running' | 'terminal';
export type QualificationOutcome =
  | { kind: 'pending' }
  | { kind: 'pre-suite-no-verdict'; reason: PreSuiteNoVerdictReason }
  | { kind: 'green'; reason: string }
  | { kind: 'red'; reason: string }
  | { kind: 'code-inconclusive'; reason: string };

export interface QualificationBlocker {
  code: string;
  detail?: string;
  clearEvents: string[];
  observedAtMs: number;
}

export interface QualificationPhysicalRunner {
  id: string;
  candidate: string | null;
  reservedAtMs: number;
  leaseExpiresAtMs?: number;
  evidenceRefs: string[];
  /**
   * The systemd unit that IS this runner, when the reserver knows it — the only field here that
   * can FALSIFY the lease. Everything else is a timestamp, and a timestamp cannot tell a working
   * runner from a dead one; see `reserveQualificationRunner`. Optional because rows written before
   * this field existed have none, and those must keep their pre-existing (lease-only) behaviour.
   */
  unit?: string | null;
  pid?: number | null;
  pidIdentity?: string | null;
  heartbeatAtMs?: number;
  phase?: 'launching' | 'materializing' | 'suite' | 'isolating' | 'delivering';
}

export interface QualificationPhysicalRun extends QualificationPhysicalRunner {
  endedAtMs: number;
  outcome: QualificationOutcome;
}

export type QualificationSafeNextAction =
  | { code: 'launch-physical-run'; reason: string; waitEvents: string[] }
  | { code: 'launch-preflight-runner'; reason: string; waitEvents: string[] }
  | { code: 'await-blocker-events'; reason: string; waitEvents: string[] }
  | { code: 'await-current-run'; reason: string; waitEvents: string[] }
  | { code: 'recover-expired-runner'; reason: string; waitEvents: string[] }
  | { code: 'inspect-runner-liveness'; reason: string; waitEvents: string[] }
  | { code: 'repair-code'; reason: string; waitEvents: string[] }
  | { code: 'inspect-terminal-evidence'; reason: string; waitEvents: string[] }
  | { code: 'read-release-control'; reason: string; waitEvents: string[] };

export interface CheckpointQualificationState {
  status: 'none' | 'unreadable' | 'present';
  attemptId: string | null;
  candidate: string | null;
  phase: QualificationPhase | null;
  outcome: QualificationOutcome | null;
  owner: { kind: 'routine'; id: 'system:green-checkpoint' };
  lease: {
    holder: string;
    acquiredAtMs: number;
    expiresAtMs: number;
    expired: boolean;
  } | null;
  runnerHealth: {
    state: 'none' | 'progressing' | 'stalled' | 'dead';
    liveness: RunnerLiveness;
    phase: QualificationPhysicalRunner['phase'] | null;
    progressAgeMs: number | null;
  };
  blockers: QualificationBlocker[];
  phaseDurationsMs: Partial<Record<QualificationPhase, number>>;
  clocks: {
    lastScheduledAtMs: number | null;
    lastStartedAtMs: number | null;
    lastProgressAtMs: number | null;
    lastTerminalVerdictAtMs: number | null;
  };
  agesMs: {
    attempt: number | null;
    scheduled: number | null;
    started: number | null;
    progress: number | null;
    terminal: number | null;
  };
  consumedPhysicalRuns: QualificationPhysicalRun[];
  eligibilitySnapshot: CheckpointEligibilitySnapshot | null;
  safeNextAction: QualificationSafeNextAction;
  unknown: { code: 'resolver-failed'; detail: string } | null;
}

export interface CheckpointQualificationTransaction {
  schemaVersion: typeof CHECKPOINT_QUALIFICATION_SCHEMA_VERSION;
  attemptId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** A scheduler tick is not evidence that a suite started or progressed. */
  lastScheduledAtMs?: number;
  lastStartedAtMs?: number;
  lastProgressAtMs?: number;
  lastTerminalVerdictAtMs?: number;
  requiredAncestorSha: string | null;
  candidatePolicy: {
    kind: 'quiet-cut';
    declaredPaths: string[];
  };
  candidate: string | null;
  /** Exact repair-head identity selected for this attempt, when a frozen queue supplied one. */
  repairHead: string | null;
  /** A newly admitted head waiting for its own successor verification attempt. */
  pendingRepairHead?: string | null;
  /** Physical run identity that currently owns (or produced) this logical attempt. */
  runId: string | null;
  phase: QualificationPhase;
  phaseEnteredAtMs?: number;
  phaseDurationsMs?: Partial<Record<QualificationPhase, number>>;
  outcome: QualificationOutcome;
  blockers: QualificationBlocker[];
  waitGeneration: number;
  currentPhysicalRunner: QualificationPhysicalRunner | null;
  consumedPhysicalRuns?: QualificationPhysicalRun[];
  evidenceRefs: string[];
  previousAttemptId: string | null;
  eligibilitySnapshot?: CheckpointEligibilitySnapshot | null;
}

export interface BeginQualificationInput {
  attemptId: string;
  requiredAncestorSha?: string | null;
  declaredPaths?: readonly string[];
  candidate?: string | null;
  repairHead?: string | null;
  runId?: string | null;
  evidenceRefs?: readonly string[];
  /** What the caller proved about the INCUMBENT attempt's runner. Default 'unknown' = old behaviour. */
  incumbentLiveness?: RunnerLiveness;
  nowMs?: number;
  /**
   * Same-row proof that an unowned `repair-in-progress` wait now has an exact,
   * never-judged `ready-to-verify` repair head. Set only by
   * {@link beginStoredQualification}; callers cannot infer this from the
   * qualification record alone because the repair queue is the authority.
   */
  resumeUnownedRepairVerification?: boolean;
  /**
   * EI-22931381517977345: derive the logical attempt identity from the frozen repair queue's
   * VERIFICATION TARGET (`repairHead`, else `candidate`), read from the SAME locked routine row
   * the transaction lives in. Without it a request that declares no paths hashes to a per-root
   * constant (the pre-launch preflight yields candidate:null/tip:null), so one terminal
   * code-inconclusive attempt refuses every later verify of the lineage — even after an
   * admission advanced `repairHead` — via the same-id 'terminal' branch, which never reaches the
   * distinct-successor reconciliation. Called only when a queue target exists; the returned id
   * replaces `attemptId`.
   */
  attemptIdForVerificationTarget?: (target: string) => string;
}

export interface CancelQualificationInput {
  /** The exact logical attempt the caller intends to stop. */
  attemptId: string;
  /** The exact systemd unit recorded on that attempt's physical runner. */
  unit: string;
  /** A durable, human-readable reason for the inconclusive terminal outcome. */
  reason?: string;
  evidenceRefs?: readonly string[];
  nowMs?: number;
}

export type QualificationTransition =
  | { status: 'updated' | 'idempotent'; transaction: CheckpointQualificationTransaction }
  | { status: 'conflict' | 'terminal'; transaction: CheckpointQualificationTransaction };

/**
 * EI-21643577467008123 — this waiting reason is emitted only after the durable
 * waiter failed to start. It therefore has no owner that can ever advance it and
 * must not retain the singleton transaction against a later retry/successor.
 * Every other pre-suite wait remains exclusive until its real owner advances it.
 */
function isRetryableUnownedWait(
  current: CheckpointQualificationTransaction | null,
  resumeUnownedRepairVerification = false,
): boolean {
  if (
    !current ||
    current.phase !== 'waiting' ||
    current.outcome.kind !== 'pre-suite-no-verdict' ||
    current.currentPhysicalRunner !== null
  )
    return false;
  if (current.outcome.reason === 'wait-for-eligibility-unavailable') return true;
  return resumeUnownedRepairVerification && current.outcome.reason === 'repair-in-progress';
}

/**
 * Has the attempt's owner GONE, leaving the singleton held by nobody?
 *
 * The exclusivity above is correct only while "its real owner advances it" holds. Nothing enforced
 * that: an owner that died mid-attempt kept the transaction non-terminal AND non-retryable
 * forever, so `beginQualificationTransaction` returned `conflict` to every later attempt — the
 * scheduled routine included. The gate then renders no verdict at all while looking merely red,
 * and no amount of fixing tests moves it. Two provable ways an owner is gone:
 *
 *  - a physical runner whose unit the caller probed and found absent; or
 *  - no runner at all, and no write for longer than a runner could legally live.
 *
 * Both require evidence. An owner we cannot prove dead keeps its claim.
 */
function isAbandonedQualification(
  current: CheckpointQualificationTransaction | null,
  incumbentLiveness: RunnerLiveness | undefined,
  nowMs: number,
): boolean {
  if (!current || isTerminalQualificationOutcome(current.outcome)) return false;
  if (current.currentPhysicalRunner)
    return incumbentLiveness === 'dead' && !launchReservationInGrace(current.currentPhysicalRunner, nowMs);
  return nowMs - current.updatedAtMs > QUALIFICATION_OWNER_ABANDONED_MS;
}

const uniqueStrings = (values: readonly string[], cap = 64): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, cap);

export const isTerminalQualificationOutcome = (outcome: QualificationOutcome): boolean =>
  outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive';

function isQualificationOutcome(value: unknown): value is QualificationOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as { kind?: unknown; reason?: unknown };
  if (outcome.kind === 'pending') return true;
  if (outcome.kind === 'pre-suite-no-verdict') {
    return (PRE_SUITE_NO_VERDICT_REASONS as readonly unknown[]).includes(outcome.reason);
  }
  return ['green', 'red', 'code-inconclusive'].includes(String(outcome.kind)) && typeof outcome.reason === 'string';
}

function isPhysicalRun(value: unknown): value is QualificationPhysicalRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<QualificationPhysicalRun>;
  return (
    typeof run.id === 'string' &&
    !!run.id &&
    (run.candidate === null || typeof run.candidate === 'string') &&
    Number.isFinite(run.reservedAtMs) &&
    Number.isFinite(run.leaseExpiresAtMs) &&
    Number.isFinite(run.endedAtMs) &&
    (run.pid == null || (Number.isInteger(run.pid) && run.pid > 0)) &&
    (run.pidIdentity == null || typeof run.pidIdentity === 'string') &&
    Array.isArray(run.evidenceRefs) &&
    run.evidenceRefs.every((ref) => typeof ref === 'string') &&
    isQualificationOutcome(run.outcome)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function completedPhaseDurations(
  current: CheckpointQualificationTransaction,
  nextPhase: QualificationPhase,
  nowMs: number,
): Partial<Record<QualificationPhase, number>> {
  if (current.phase === nextPhase) return current.phaseDurationsMs ?? {};
  const phaseDurations = current.phaseDurationsMs ?? {};
  const phaseEnteredAtMs = current.phaseEnteredAtMs ?? current.updatedAtMs;
  return {
    ...phaseDurations,
    [current.phase]: (phaseDurations[current.phase] ?? 0) + Math.max(0, nowMs - phaseEnteredAtMs),
  };
}

function consumedRunner(
  current: CheckpointQualificationTransaction,
  outcome: QualificationOutcome,
  nowMs: number,
  settledRunId: string | null = null,
): QualificationPhysicalRun[] {
  const runner = current.currentPhysicalRunner;
  if (!runner) return current.consumedPhysicalRuns ?? [];
  const evidenceRefs = settledRunId && canBindRunIdToRunner(runner, settledRunId)
    ? uniqueStrings([...runner.evidenceRefs, `checkpoint-run:${settledRunId}`])
    : runner.evidenceRefs;
  return [
    ...(current.consumedPhysicalRuns ?? []),
    { ...runner, evidenceRefs, endedAtMs: nowMs, outcome },
  ].slice(-32);
}

/** A runner may carry at most one run id: bind only when it has none yet, or already has this one. */
function canBindRunIdToRunner(runner: { evidenceRefs?: readonly string[] }, runId: string): boolean {
  const bound = (runner.evidenceRefs ?? []).filter((ref) => ref.startsWith('checkpoint-run:'));
  return bound.length === 0 || bound.includes(`checkpoint-run:${runId}`);
}

/**
 * WI-10003212 — the run id a transition that RELEASES the current runner (wait / terminal settle)
 * may store on the attempt, plus the id to bind into the released runner's history.
 *
 * A runner binds its run id at activation (`checkpoint-run:<runId>`). A run that settles BEFORE
 * activating — `skipped-locked`, which emits its verdict before it ever attaches to its
 * reservation — used to store its run id on the attempt while the released runner carried no
 * binding. `storedRunIdIsFromEndedRunner` therefore could not recognise the id as history, every
 * fresh reservation inherited it (`runIdForFreshRunner`), and each later scheduled CLI was refused
 * at activation (`run stored=<skipped run> produced=<own run>`): attempt 075de039 wedged every fire
 * from 04:23Z on 2026-09-26 on run 1977bd22, the 02:23Z fire that lock-skipped behind a manual run.
 * The released runner now takes the binding, and an id no runner can carry is never stored.
 */
function runIdOnRelease(
  current: CheckpointQualificationTransaction,
  inputRunId: string | null | undefined,
): { runId: string | null; bind: string | null } {
  const own = inputRunId?.trim() || null;
  if (!own) return { runId: current.runId, bind: null };
  const runner = current.currentPhysicalRunner;
  if (runner && canBindRunIdToRunner(runner, own)) return { runId: own, bind: own };
  if ((current.consumedPhysicalRuns ?? []).some((run) => runIdBoundToRunner(run, own))) {
    return { runId: own, bind: null };
  }
  return { runId: current.runId, bind: null };
}

/**
 * WI-10002602 — a run id belongs to the physical runner that bound it. A runner that starts
 * records `checkpoint-run:<runId>` in its evidence (activateScheduledCheckpointRunner), so this
 * evidence is how an id is traced back to its runner. A transition that releases a runner
 * (wait, displacement) keeps `runId` on the attempt as history. Before this helper, the next
 * runner INHERITED that id: its CLI activated with its own run id, the stale id did not match,
 * and activation refused with `conflict`. Every later fire re-joined the same attempt, so the
 * gate wedged permanently (attempt 984d0934: 08:23Z fire refused, stored=abf32d6d, which was
 * bound to the runner consumed at 06:38Z).
 */
function runIdBoundToRunner(
  runner: { evidenceRefs?: readonly string[] } | null | undefined,
  runId: string,
): boolean {
  return Boolean(runner?.evidenceRefs?.includes(`checkpoint-run:${runId}`));
}

/**
 * WI-10003215 — the verdict came from the attempt's own incumbent physical run: the producer's run
 * id is the stored run id AND the live runner bound it at activation (`checkpoint-run:<runId>`).
 * Run ids are unique per CLI invocation, and requiring the incumbent binding (not merely a stored
 * id, which can be inherited history) rules out a late verdict from an earlier run.
 */
function verdictIsFromIncumbentRun(current: CheckpointQualificationTransaction, runId: string | null): boolean {
  return Boolean(runId && current.runId === runId && runIdBoundToRunner(current.currentPhysicalRunner, runId));
}

/**
 * The candidate half of the settle identity check. Two cases name the same judged code even though
 * the stored and produced candidates differ:
 *
 * - WI-10002602: a repair-head verification is RESERVED against the head it verifies (the launcher
 *   pins queue.repairHead as the run's candidate), but its verdict names the FROZEN candidate as
 *   `candidate` and the verified head as `repairHead`. A stored candidate equal to the verdict's
 *   repair head is the same identity. Comparing only `candidate` returned conflict for every
 *   repair-head verdict, and the attempt wedged every later scheduled fire.
 * - WI-10003215: the incumbent run re-resolved its target after reservation — a scheduled
 *   reservation stores the quiet-cut tip, then the run resumes the frozen lineage and its own
 *   lockfile convergence advances repairHead mid-run. Its verdict names the sha it actually judged
 *   (and, once promotion retires the queue, no repair head). Refusing it DISCARDED a green that had
 *   already promoted main, withheld every release:green wake, and left the attempt `running` under
 *   a dead runner (attempt 1cf6ef83, run e787243b, 2026-09-26).
 */
function candidateIdentityConflicts(
  current: CheckpointQualificationTransaction,
  produced: { candidate: string | null; repairHead: string | null; runId: string | null },
): boolean {
  if (!current.candidate || !produced.candidate || current.candidate === produced.candidate) return false;
  if (current.candidate === produced.repairHead) return false;
  return !verdictIsFromIncumbentRun(current, produced.runId);
}

/** The stored run id is history: it is bound to a consumed runner, not the incumbent. */
function storedRunIdIsFromEndedRunner(current: CheckpointQualificationTransaction): boolean {
  const runId = current.runId;
  if (!runId) return false;
  if (runIdBoundToRunner(current.currentPhysicalRunner, runId)) return false;
  return (current.consumedPhysicalRuns ?? []).some((run) => runIdBoundToRunner(run, runId));
}

/**
 * WI-10003212 recovery — the stored run id cannot belong to the incumbent's CLI: the incumbent is a
 * placeholder no CLI ever attached to (no pid, still `launching`, no `checkpoint-run:` binding),
 * so the id was inherited, not assigned. The scheduled pre-spawn reservation never carries a run
 * id, so its first attach is the only claimant. Needed for rows wedged BEFORE `runIdOnRelease`
 * existed, whose orphaned id has aged out of the 32-run history (oddsmith attempt de070acc: run
 * 8e9dbf64 lock-skipped at 2026-09-25T16:01Z and wedged every later fire). An attached runner keeps
 * single flight: a second, different run id against it still conflicts.
 */
function storedRunIdOrphanedAtUnattachedRunner(current: CheckpointQualificationTransaction): boolean {
  const runner = current.currentPhysicalRunner;
  if (!runner || !current.runId) return false;
  if (runner.pid != null || runner.pidIdentity || runner.phase !== 'launching') return false;
  return !(runner.evidenceRefs ?? []).some((ref) => ref.startsWith('checkpoint-run:'));
}

/** The run id a FRESH runner reservation carries: its own, never one bound to another runner. */
function runIdForFreshRunner(current: CheckpointQualificationTransaction, inputRunId: string | null | undefined): string | null {
  const own = inputRunId?.trim() || null;
  if (own) return own;
  if (!current.runId) return null;
  if (runIdBoundToRunner(current.currentPhysicalRunner, current.runId)) return null;
  if (storedRunIdIsFromEndedRunner(current)) return null;
  return current.runId;
}

export function qualificationPhaseDurations(
  current: CheckpointQualificationTransaction,
  nowMs = Date.now(),
): Partial<Record<QualificationPhase, number>> {
  return {
    ...(current.phaseDurationsMs ?? {}),
    [current.phase]:
      ((current.phaseDurationsMs ?? {})[current.phase] ?? 0) +
      Math.max(0, nowMs - (current.phaseEnteredAtMs ?? current.updatedAtMs)),
  };
}

export function projectCheckpointQualificationState(
  raw: unknown,
  nowMs = Date.now(),
  runnerLiveness: RunnerLiveness = 'unknown',
): CheckpointQualificationState {
  const owner = { kind: 'routine' as const, id: 'system:green-checkpoint' as const };
  const emptyClocks = {
    lastScheduledAtMs: null,
    lastStartedAtMs: null,
    lastProgressAtMs: null,
    lastTerminalVerdictAtMs: null,
  };
  const emptyAges = { attempt: null, scheduled: null, started: null, progress: null, terminal: null };
  if (raw == null) {
    return {
      status: 'none',
      attemptId: null,
      candidate: null,
      phase: null,
      outcome: null,
      owner,
      lease: null,
      runnerHealth: { state: 'none', liveness: 'unknown', phase: null, progressAgeMs: null },
      blockers: [],
      phaseDurationsMs: {},
      clocks: emptyClocks,
      agesMs: emptyAges,
      consumedPhysicalRuns: [],
      unknown: null,
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason:
          'no logical qualification attempt exists; read current serializer/manual-run authority before starting one',
        waitEvents: [],
      },
    };
  }
  const transaction = parseCheckpointQualificationTransaction(raw);
  if (!transaction) {
    return {
      status: 'unreadable',
      attemptId: null,
      candidate: null,
      phase: null,
      outcome: null,
      owner,
      lease: null,
      runnerHealth: { state: 'none', liveness: 'unknown', phase: null, progressAgeMs: null },
      blockers: [],
      phaseDurationsMs: {},
      clocks: emptyClocks,
      agesMs: emptyAges,
      consumedPhysicalRuns: [],
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason: 'qualification metadata is malformed; repair the durable record before launching',
        waitEvents: [],
      },
      unknown: { code: 'resolver-failed', detail: 'qualification transaction metadata is malformed' },
    };
  }
  const runner = transaction.currentPhysicalRunner;
  const age = (at: number | undefined): number | null =>
    at === undefined ? null : Math.max(0, nowMs - at);
  const lease = runner
    ? {
        holder: runner.id,
        acquiredAtMs: runner.reservedAtMs,
        expiresAtMs: runner.leaseExpiresAtMs ?? runner.reservedAtMs,
        expired: nowMs >= (runner.leaseExpiresAtMs ?? runner.reservedAtMs),
      }
    : null;
  const progressAgeMs = runner
    ? Math.max(0, nowMs - (runner.heartbeatAtMs ?? transaction.lastProgressAtMs ?? runner.reservedAtMs))
    : null;
  const runnerHealth: CheckpointQualificationState['runnerHealth'] = {
    state: !runner ? 'none' : runnerLiveness === 'dead' ? 'dead'
      : progressAgeMs != null && progressAgeMs > QUALIFICATION_PROGRESS_STALE_MS ? 'stalled' : 'progressing',
    liveness: runner ? runnerLiveness : 'unknown',
    phase: runner?.phase ?? null,
    progressAgeMs,
  };
  const waitEvents = uniqueStrings(transaction.blockers.flatMap((blocker) => blocker.clearEvents));
  let safeNextAction: QualificationSafeNextAction;
  if (transaction.outcome.kind === 'green') {
    safeNextAction = {
      code: 'read-release-control',
      reason: 'qualification is green; read promotion/deploy authority before acting',
      waitEvents: [],
    };
  } else if (transaction.outcome.kind === 'red') {
    safeNextAction = {
      code: 'repair-code',
      reason: 'a real red is terminal for this logical attempt; repair code before starting a successor',
      waitEvents: [],
    };
  } else if (transaction.outcome.kind === 'code-inconclusive') {
    safeNextAction = {
      code: 'inspect-terminal-evidence',
      reason: 'the terminal code outcome is inconclusive; inspect evidence before a successor',
      waitEvents: [],
    };
  } else if (runner && runnerLiveness === 'dead') {
    safeNextAction = {
      code: 'recover-expired-runner',
      reason: 'the exact physical runner was proved dead without a terminal result',
      waitEvents: [],
    };
  } else if (runner && (lease?.expired || runnerHealth.state === 'stalled')) {
    safeNextAction = {
      code: 'inspect-runner-liveness',
      reason: 'the runner missed progress or its deadline; preserve single flight until exact process liveness is proved',
      waitEvents: [],
    };
  } else if (runner) {
    safeNextAction = { code: 'await-current-run', reason: 'one physical runner owns the live lease', waitEvents: [] };
  } else if (transaction.eligibilitySnapshot) {
    // The snapshot describes request-time preflight only. A physical runner's lease is
    // action-time authority and must win over a stale snapshot, so this branch is reached
    // only when the transaction has no current runner.
    safeNextAction = transaction.eligibilitySnapshot.safeNextAction;
  } else if (transaction.phase === 'waiting') {
    safeNextAction = {
      code: 'await-blocker-events',
      reason: 'pre-suite infrastructure blocked this attempt; resume it after the named events clear',
      waitEvents,
    };
  } else {
    safeNextAction = {
      code: 'launch-physical-run',
      reason: 'the logical attempt is ready and has no live physical runner',
      waitEvents: [],
    };
  }
  return {
    status: 'present',
    attemptId: transaction.attemptId,
    candidate: transaction.candidate,
    phase: transaction.phase,
    outcome: transaction.outcome,
    owner,
    lease,
    runnerHealth,
    blockers: transaction.blockers,
    phaseDurationsMs: qualificationPhaseDurations(transaction, nowMs),
    clocks: {
      lastScheduledAtMs: transaction.lastScheduledAtMs ?? null,
      lastStartedAtMs: transaction.lastStartedAtMs ?? null,
      lastProgressAtMs: transaction.lastProgressAtMs ?? null,
      lastTerminalVerdictAtMs: transaction.lastTerminalVerdictAtMs ?? null,
    },
    agesMs: {
      attempt: age(transaction.createdAtMs),
      scheduled: age(transaction.lastScheduledAtMs),
      started: age(transaction.lastStartedAtMs),
      progress: age(transaction.lastProgressAtMs),
      terminal: age(transaction.lastTerminalVerdictAtMs),
    },
    consumedPhysicalRuns: transaction.consumedPhysicalRuns ?? [],
    eligibilitySnapshot: transaction.eligibilitySnapshot ?? null,
    safeNextAction,
    unknown: null,
  };
}

/**
 * A waiting/running logical attempt survives candidate movement. The caller intent is the
 * required ancestor plus the declared-path policy; the candidate is a physical-run snapshot.
 */
export function qualificationIntentMatches(
  current: CheckpointQualificationTransaction,
  input: Pick<BeginQualificationInput, 'requiredAncestorSha' | 'declaredPaths'>,
): boolean {
  if (isTerminalQualificationOutcome(current.outcome)) return false;
  return (
    current.requiredAncestorSha === (input.requiredAncestorSha?.trim() || null) &&
    sameStrings(current.candidatePolicy.declaredPaths, input.declaredPaths ?? [])
  );
}

/**
 * The sha a suite would judge for a stored frozen repair queue: the advanced `repairHead` when
 * one exists, else the frozen `candidate`. Deliberately a lenient structural read (not the full
 * queue parser): the identity of a logical attempt must be derivable from a legacy or partially
 * populated row too, and the policy read that decides whether a suite RUNS happens later.
 */
export function frozenRepairQueueVerificationTarget(rawRepairQueue: unknown): string | null {
  if (!rawRepairQueue || typeof rawRepairQueue !== 'object' || Array.isArray(rawRepairQueue)) return null;
  const row = rawRepairQueue as Record<string, unknown>;
  const pick = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return pick(row.repairHead) ?? pick(row.candidate);
}

/**
 * EI-22931381517977345: the logical attempt id a begin request actually installs. With a frozen
 * queue present and a caller-supplied `attemptIdForVerificationTarget`, the id is derived from
 * the queue's verification target so an advanced repairHead is a NEW logical attempt after a
 * terminal predecessor; otherwise the caller's `attemptId` stands.
 */
export function resolveQualificationAttemptId(input: BeginQualificationInput, rawRepairQueue: unknown): string {
  const target = frozenRepairQueueVerificationTarget(rawRepairQueue);
  if (target === null || !input.attemptIdForVerificationTarget) return input.attemptId;
  const derived = input.attemptIdForVerificationTarget(target);
  return typeof derived === 'string' && derived.trim() ? derived.trim() : input.attemptId;
}

export function parseCheckpointQualificationTransaction(value: unknown): CheckpointQualificationTransaction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CheckpointQualificationTransaction>;
  if (
    row.schemaVersion !== CHECKPOINT_QUALIFICATION_SCHEMA_VERSION ||
    typeof row.attemptId !== 'string' ||
    !row.attemptId ||
    !Number.isFinite(row.createdAtMs) ||
    !Number.isFinite(row.updatedAtMs) ||
    !Number.isInteger(row.waitGeneration) ||
    (row.waitGeneration ?? -1) < 0 ||
    !row.outcome ||
    typeof row.outcome !== 'object' ||
    !['waiting', 'ready', 'running', 'terminal'].includes(String(row.phase)) ||
    !row.candidatePolicy ||
    row.candidatePolicy.kind !== 'quiet-cut' ||
    !Array.isArray(row.candidatePolicy.declaredPaths) ||
    !Array.isArray(row.blockers) ||
    !Array.isArray(row.evidenceRefs) ||
    (row.repairHead != null && (typeof row.repairHead !== 'string' || !row.repairHead.trim())) ||
    (row.pendingRepairHead != null && (typeof row.pendingRepairHead !== 'string' || !row.pendingRepairHead.trim())) ||
    (row.runId != null && (typeof row.runId !== 'string' || !row.runId.trim())) ||
    [row.lastScheduledAtMs, row.lastStartedAtMs, row.lastProgressAtMs, row.lastTerminalVerdictAtMs].some(
      (at) => at != null && (!Number.isFinite(at) || at < 0),
    ) ||
    (row.phaseEnteredAtMs != null && !Number.isFinite(row.phaseEnteredAtMs)) ||
    (row.phaseDurationsMs != null &&
      (typeof row.phaseDurationsMs !== 'object' ||
        Array.isArray(row.phaseDurationsMs) ||
        Object.entries(row.phaseDurationsMs).some(
          ([phase, duration]) =>
            !['waiting', 'ready', 'running', 'terminal'].includes(phase) ||
            typeof duration !== 'number' ||
            !Number.isFinite(duration) ||
            duration < 0,
        ))) ||
    (row.consumedPhysicalRuns != null &&
      (!Array.isArray(row.consumedPhysicalRuns) || row.consumedPhysicalRuns.some((run) => !isPhysicalRun(run)))) ||
    (row.eligibilitySnapshot != null && !parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot))
  )
    return null;
  if (!isQualificationOutcome(row.outcome)) return null;
  if (
    row.blockers.some(
      (blocker) =>
        !blocker ||
        typeof blocker !== 'object' ||
        typeof blocker.code !== 'string' ||
        !Array.isArray(blocker.clearEvents) ||
        blocker.clearEvents.some((event) => typeof event !== 'string') ||
        !Number.isFinite(blocker.observedAtMs),
    ) ||
    row.evidenceRefs.some((ref) => typeof ref !== 'string') ||
    row.candidatePolicy.declaredPaths.some((declaredPath) => typeof declaredPath !== 'string')
  )
    return null;
  if (
    row.currentPhysicalRunner != null &&
    (typeof row.currentPhysicalRunner !== 'object' ||
      typeof row.currentPhysicalRunner.id !== 'string' ||
      !row.currentPhysicalRunner.id ||
      !Number.isFinite(row.currentPhysicalRunner.reservedAtMs) ||
      (row.currentPhysicalRunner.leaseExpiresAtMs != null &&
        !Number.isFinite(row.currentPhysicalRunner.leaseExpiresAtMs)) ||
      (row.currentPhysicalRunner.pid != null &&
        (!Number.isInteger(row.currentPhysicalRunner.pid) || row.currentPhysicalRunner.pid <= 0)) ||
      (row.currentPhysicalRunner.pidIdentity != null && typeof row.currentPhysicalRunner.pidIdentity !== 'string') ||
      !Array.isArray(row.currentPhysicalRunner.evidenceRefs) ||
      row.currentPhysicalRunner.evidenceRefs.some((ref) => typeof ref !== 'string'))
  )
    return null;
  const phaseEnteredAtMs = Number.isFinite(row.phaseEnteredAtMs) ? row.phaseEnteredAtMs! : row.updatedAtMs!;
  const phaseDurationsMs =
    row.phaseDurationsMs && typeof row.phaseDurationsMs === 'object' && !Array.isArray(row.phaseDurationsMs)
      ? Object.fromEntries(
          Object.entries(row.phaseDurationsMs).filter(
            ([phase, duration]) =>
              ['waiting', 'ready', 'running', 'terminal'].includes(phase) &&
              typeof duration === 'number' &&
              Number.isFinite(duration) &&
              duration >= 0,
          ),
        )
      : {};
  const consumedPhysicalRuns = Array.isArray(row.consumedPhysicalRuns) ? row.consumedPhysicalRuns.slice(-32) : [];
  const currentPhysicalRunner = row.currentPhysicalRunner
    ? {
        ...row.currentPhysicalRunner,
        leaseExpiresAtMs:
          typeof row.currentPhysicalRunner.leaseExpiresAtMs === 'number'
            ? row.currentPhysicalRunner.leaseExpiresAtMs
            : row.currentPhysicalRunner.reservedAtMs,
      }
    : null;
  const eligibilitySnapshot =
    row.eligibilitySnapshot == null ? null : parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot);
  return {
    ...(row as CheckpointQualificationTransaction),
    repairHead: typeof row.repairHead === 'string' ? row.repairHead.trim() : null,
    pendingRepairHead: typeof row.pendingRepairHead === 'string' ? row.pendingRepairHead.trim() : null,
    runId: typeof row.runId === 'string' ? row.runId.trim() : null,
    phaseEnteredAtMs,
    phaseDurationsMs,
    currentPhysicalRunner,
    consumedPhysicalRuns,
    eligibilitySnapshot,
  };
}

export function beginQualificationTransaction(
  current: CheckpointQualificationTransaction | null,
  input: BeginQualificationInput,
): QualificationTransition {
  const nowMs = input.nowMs ?? Date.now();
  const retryableUnownedWait = isRetryableUnownedWait(current, input.resumeUnownedRepairVerification === true);
  const abandoned = isAbandonedQualification(current, input.incumbentLiveness, nowMs);
  if (current?.attemptId === input.attemptId) {
    if (retryableUnownedWait) {
      return {
        status: 'updated',
        transaction: {
          ...current,
          updatedAtMs: nowMs,
          requiredAncestorSha: input.requiredAncestorSha?.trim() || current.requiredAncestorSha,
          candidatePolicy: {
            ...current.candidatePolicy,
            declaredPaths: uniqueStrings(input.declaredPaths ?? current.candidatePolicy.declaredPaths),
          },
          candidate: input.candidate?.trim() || current.candidate,
          repairHead: input.repairHead?.trim() || current.repairHead,
          pendingRepairHead: null,
          runId: input.runId?.trim() || current.runId,
          phase: 'ready',
          phaseEnteredAtMs: nowMs,
          phaseDurationsMs: completedPhaseDurations(current, 'ready', nowMs),
          outcome: { kind: 'pending' },
          blockers: [],
          eligibilitySnapshot: input.resumeUnownedRepairVerification === true ? null : current.eligibilitySnapshot,
          evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
        },
      };
    }
    return {
      status: isTerminalQualificationOutcome(current.outcome) ? 'terminal' : 'idempotent',
      transaction: current,
    };
  }
  if (current && !isTerminalQualificationOutcome(current.outcome) && !retryableUnownedWait && !abandoned) {
    return { status: 'conflict', transaction: current };
  }
  const transaction: CheckpointQualificationTransaction = {
    schemaVersion: CHECKPOINT_QUALIFICATION_SCHEMA_VERSION,
    attemptId: input.attemptId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    requiredAncestorSha: input.requiredAncestorSha?.trim() || null,
    candidatePolicy: {
      kind: 'quiet-cut',
      declaredPaths: uniqueStrings(input.declaredPaths ?? []),
    },
    candidate: input.candidate?.trim() || null,
    repairHead: input.repairHead?.trim() || null,
    pendingRepairHead: null,
    runId: input.runId?.trim() || null,
    phase: 'ready',
    phaseEnteredAtMs: nowMs,
    phaseDurationsMs: {},
    outcome: { kind: 'pending' },
    blockers: [],
    waitGeneration: 0,
    currentPhysicalRunner: null,
    consumedPhysicalRuns: [],
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    previousAttemptId: current?.attemptId ?? null,
    eligibilitySnapshot: null,
  };
  return { status: 'updated', transaction };
}

/** A colliding scheduler fire joins the active attempt without manufacturing progress. */
export function recordQualificationScheduledFire(
  current: CheckpointQualificationTransaction,
  nowMs = Date.now(),
): QualificationTransition {
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.lastScheduledAtMs !== undefined && current.lastScheduledAtMs >= nowMs) {
    return { status: 'idempotent', transaction: current };
  }
  return {
    status: 'updated',
    transaction: { ...current, lastScheduledAtMs: nowMs },
  };
}

/** A scheduler collision is not another run. Unknown owner life fails closed. */
export function classifyScheduledQualificationJoin(
  current: CheckpointQualificationTransaction,
  runnerLiveness: RunnerLiveness,
): 'launch' | 'join' | 'unknown-liveness' {
  if (current.phase !== 'running' || !current.currentPhysicalRunner || isTerminalQualificationOutcome(current.outcome)) {
    return 'launch';
  }
  if (runnerLiveness === 'live') return 'join';
  if (runnerLiveness === 'unknown') return 'unknown-liveness';
  return 'launch';
}

export function recordQualificationEligibilitySnapshot(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    snapshot: CheckpointEligibilitySnapshot;
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId || input.snapshot.attemptId !== input.attemptId)
    return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) {
    return { status: 'terminal', transaction: current };
  }
  const parsed = parseCheckpointEligibilitySnapshot(input.snapshot);
  if (!parsed) return { status: 'conflict', transaction: current };
  if (JSON.stringify(current.eligibilitySnapshot ?? null) === JSON.stringify(parsed)) {
    return { status: 'idempotent', transaction: current };
  }
  const evidenceRefs = uniqueStrings([
    ...current.evidenceRefs,
    ...parsed.predicates.flatMap((predicate) => predicate.evidenceRefs),
  ]);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: input.nowMs ?? Date.now(),
      eligibilitySnapshot: parsed,
      evidenceRefs,
    },
  };
}

export function waitQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    reason: PreSuiteNoVerdictReason;
    blockers?: readonly Omit<QualificationBlocker, 'observedAtMs'>[];
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (
    current.phase === 'waiting' &&
    current.outcome.kind === 'pre-suite-no-verdict' &&
    current.outcome.reason === input.reason &&
    (input.blockers ?? []).length === current.blockers.length &&
    (input.blockers ?? []).every((blocker, index) => {
      const existing = current.blockers[index];
      return (
        existing?.code === blocker.code &&
        existing.detail === blocker.detail &&
        sameStrings(existing.clearEvents, blocker.clearEvents)
      );
    }) &&
    (input.evidenceRefs ?? []).every((ref) => current.evidenceRefs.includes(ref))
  ) {
    return { status: 'idempotent', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  const outcome = { kind: 'pre-suite-no-verdict' as const, reason: input.reason };
  const released = runIdOnRelease(current, input.runId);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'waiting',
      phaseEnteredAtMs: current.phase === 'waiting' ? current.phaseEnteredAtMs : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'waiting', nowMs),
      outcome,
      candidate: input.candidate?.trim() || current.candidate,
      repairHead: input.repairHead?.trim() || current.repairHead,
      runId: released.runId,
      blockers: (input.blockers ?? []).slice(0, 24).map((blocker) => ({ ...blocker, observedAtMs: nowMs })),
      waitGeneration: current.waitGeneration + 1,
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs, released.bind),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

export function reserveQualificationRunner(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
      runnerId: string;
    runId?: string | null;
    repairHead?: string | null;
    candidate?: string | null;
    evidenceRefs?: readonly string[];
    leaseDurationMs: number;
    unit?: string | null;
    pid?: number | null;
    pidIdentity?: string | null;
    /** false reserves the scheduled launch; true attaches the real CLI process. */
    started?: boolean;
    /**
     * What the caller PROVED about the incumbent runner's process. Default 'unknown' keeps the
     * historical lease-only behaviour, so this can never loosen the lock on its own.
     */
    incumbentLiveness?: RunnerLiveness;
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const incumbent = current.currentPhysicalRunner;
  if (incumbent?.id === input.runnerId) {
    if (
      (current.candidate && input.candidate && current.candidate !== input.candidate.trim()) ||
      (current.repairHead && input.repairHead && current.repairHead !== input.repairHead.trim()) ||
      (current.runId && input.runId && current.runId !== input.runId.trim() &&
        !storedRunIdIsFromEndedRunner(current) && !storedRunIdOrphanedAtUnattachedRunner(current)) ||
      (incumbent.pidIdentity && input.pidIdentity && incumbent.pidIdentity !== input.pidIdentity)
    ) return { status: 'conflict', transaction: current };
    if (input.started !== true && input.pid == null && !input.unit) {
      return { status: 'idempotent', transaction: current };
    }
    const evidenceRefs = uniqueStrings([...incumbent.evidenceRefs, ...(input.evidenceRefs ?? [])]);
    return {
      status: 'updated',
      transaction: {
        ...current,
        updatedAtMs: nowMs,
        candidate: input.candidate?.trim() || current.candidate,
        repairHead: input.repairHead?.trim() || current.repairHead,
        runId: input.runId?.trim() || current.runId,
        lastStartedAtMs: input.started === true ? nowMs : current.lastStartedAtMs,
        lastProgressAtMs: input.started === true ? nowMs : current.lastProgressAtMs,
        currentPhysicalRunner: {
          ...incumbent,
          candidate: input.candidate?.trim() || incumbent.candidate,
          leaseExpiresAtMs: nowMs + Math.max(1, input.leaseDurationMs),
          evidenceRefs,
          unit: input.unit?.trim() || incumbent.unit,
          pid: input.pid ?? incumbent.pid,
          pidIdentity: input.pidIdentity ?? incumbent.pidIdentity,
          heartbeatAtMs: nowMs,
          phase: input.started === true ? 'materializing' : incumbent.phase,
        },
        evidenceRefs: uniqueStrings([...current.evidenceRefs, ...evidenceRefs]),
      },
    };
  }
  // A lease timeout alone cannot prove death. Unknown or live ownership keeps single flight.
  if (incumbent && (input.incumbentLiveness !== 'dead' || launchReservationInGrace(incumbent, nowMs))) {
    return { status: 'conflict', transaction: current };
  }
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  // Keep the two displacement causes distinct in the history: a lease that ran out is a runner that
  // overran, a reclaimed one is a runner that DIED. Collapsing them would hide exactly the signal
  // that makes a recurring vanish diagnosable.
  const displacedOutcome: QualificationOutcome = {
    kind: 'pre-suite-no-verdict',
    reason: 'runner-vanished',
  };
  const expiredRuns = incumbent
    ? consumedRunner(current, displacedOutcome, nowMs)
    : (current.consumedPhysicalRuns ?? []);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      candidate: input.candidate?.trim() || current.candidate,
      repairHead: input.repairHead?.trim() || current.repairHead,
      runId: runIdForFreshRunner(current, input.runId),
      phase: 'running',
      ...(input.started === false ? {} : { lastStartedAtMs: nowMs, lastProgressAtMs: nowMs }),
      phaseEnteredAtMs:
        current.phase === 'running' && !current.currentPhysicalRunner
          ? (current.phaseEnteredAtMs ?? current.updatedAtMs)
          : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'running', nowMs),
      outcome: { kind: 'pending' },
      blockers: [],
      currentPhysicalRunner: {
        id: input.runnerId,
        candidate: input.candidate?.trim() || current.candidate,
        reservedAtMs: nowMs,
        leaseExpiresAtMs: nowMs + Math.max(1, input.leaseDurationMs),
        evidenceRefs,
        unit: input.unit?.trim() || null,
        pid: input.pid ?? null,
        pidIdentity: input.pidIdentity ?? null,
        heartbeatAtMs: nowMs,
        phase: input.started === false ? 'launching' : 'materializing',
      },
      consumedPhysicalRuns: expiredRuns,
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...evidenceRefs]),
    },
  };
}

/** Progress belongs to the exact active runner. A scheduler tick cannot call this transition. */
export function recordQualificationRunnerProgress(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    runnerId: string;
    runId: string;
    phase: NonNullable<QualificationPhysicalRunner['phase']>;
    pidIdentity?: string | null;
    nowMs?: number;
  },
): QualificationTransition {
  const runner = current.currentPhysicalRunner;
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.attemptId !== input.attemptId || current.phase !== 'running' ||
      !runner || runner.id !== input.runnerId || !current.runId || current.runId !== input.runId ||
      !runner.pidIdentity || !input.pidIdentity || runner.pidIdentity !== input.pidIdentity) {
    return { status: 'conflict', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (nowMs < (runner.heartbeatAtMs ?? 0) ||
      (nowMs === runner.heartbeatAtMs && input.phase === runner.phase)) {
    return { status: 'idempotent', transaction: current };
  }
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      lastProgressAtMs: nowMs,
      currentPhysicalRunner: { ...runner, heartbeatAtMs: nowMs, phase: input.phase },
    },
  };
}

export function classifyQualificationVerdict(input: { reason: string; green?: boolean | null }): QualificationOutcome {
  const normalized = input.reason.trim().replaceAll('_', '-');
  if (input.green === true || ['advanced', 'up-to-date', 'advanced-prefix'].includes(normalized)) {
    return { kind: 'green', reason: input.reason };
  }
  if ((PRE_SUITE_NO_VERDICT_REASONS as readonly string[]).includes(normalized)) {
    return { kind: 'pre-suite-no-verdict', reason: normalized as PreSuiteNoVerdictReason };
  }
  if (input.green === false || normalized === 'not-green') return { kind: 'red', reason: input.reason };
  return { kind: 'code-inconclusive', reason: input.reason || 'unknown' };
}

export function settleQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    reason: string;
    green?: boolean | null;
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  const candidate = input.candidate?.trim() || null;
  const verifiedRepairHead = input.repairHead?.trim() || null;
  const runId = input.runId?.trim() || null;
  const sameRun = verdictIsFromIncumbentRun(current, runId);
  if (candidateIdentityConflicts(current, { candidate, repairHead: verifiedRepairHead, runId })) {
    return { status: 'conflict', transaction: current };
  }
  if (current.runId && runId && current.runId !== runId && !storedRunIdIsFromEndedRunner(current)) {
    return { status: 'conflict', transaction: current };
  }
  const outcome = classifyQualificationVerdict(input);
  // Only the identical outcome is a replay. A changed run, candidate, or verdict may
  // never turn a terminal red into a green wake under the same logical attempt.
  if (isTerminalQualificationOutcome(current.outcome)) {
    return {
      status: current.outcome.kind === outcome.kind &&
        'reason' in current.outcome && 'reason' in outcome && current.outcome.reason === outcome.reason
        ? 'terminal' : 'conflict',
      transaction: current,
    };
  }
  if (outcome.kind === 'pre-suite-no-verdict') {
    return waitQualificationTransaction(current, {
      attemptId: input.attemptId,
      reason: outcome.reason,
      candidate,
      repairHead: input.repairHead,
      runId,
      evidenceRefs: input.evidenceRefs,
      nowMs: input.nowMs,
    });
  }
  const nowMs = input.nowMs ?? Date.now();
  const released = runIdOnRelease(current, runId);
  // WI-10003215: when the incumbent run judged the pending admission handoff itself (the gate's
  // in-run convergence moved repairHead and this same run verified the new head), that handoff
  // is consumed here. Leaving it set would hand an already-judged head to the next attempt.
  const judgedPending = sameRun && current.pendingRepairHead != null &&
    (current.pendingRepairHead === candidate || current.pendingRepairHead === verifiedRepairHead);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      candidate: candidate ?? current.candidate,
      repairHead: verifiedRepairHead || (judgedPending ? current.pendingRepairHead ?? null : current.repairHead),
      ...(judgedPending ? { pendingRepairHead: null } : {}),
      // A TERMINAL attempt pins the verdict's own run id even with no runner to bind it to: a
      // terminal attempt refuses every later runner reservation, so the id can never be inherited
      // (the WI-10003212 wedge was a non-terminal wait), and the pin is what makes a different
      // run's replay conflict instead of reading as an idempotent `terminal`.
      runId: runId ?? released.runId,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs, released.bind),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

/** Recover only the exact unstarted scheduled runner proved finished by its terminal marker. */
export function recoverQualificationScheduledTerminal(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    runnerId: string;
    runId: string;
    reason: string;
    finishedAtMs: number;
    evidenceRefs: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  const terminalRef = `checkpoint-terminal:${input.runId}`;
  if (current.attemptId !== input.attemptId || !input.evidenceRefs.includes(terminalRef)) {
    return { status: 'conflict', transaction: current };
  }
  const outcome = classifyQualificationVerdict({ reason: input.reason });
  if (outcome.kind !== 'pre-suite-no-verdict') return { status: 'conflict', transaction: current };
  const recoveredReason = `orphaned-reservation-after-${outcome.reason}`;
  if (isTerminalQualificationOutcome(current.outcome)) {
    return current.outcome.kind === 'code-inconclusive' &&
      current.outcome.reason === recoveredReason && current.evidenceRefs.includes(terminalRef)
      ? { status: 'terminal', transaction: current }
      : { status: 'conflict', transaction: current };
  }
  const runner = current.currentPhysicalRunner;
  if (current.phase !== 'running' || !runner || runner.id !== input.runnerId ||
      runner.pid != null || runner.unit || runner.phase !== 'launching' ||
      !runner.evidenceRefs.includes(`gate-fire:${input.runnerId}`) ||
      !Number.isFinite(input.finishedAtMs) || input.finishedAtMs < runner.reservedAtMs) {
    return { status: 'conflict', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  const recoveredOutcome: QualificationOutcome = { kind: 'code-inconclusive', reason: recoveredReason };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome: recoveredOutcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, recoveredOutcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...input.evidenceRefs]),
    },
  };
}

/**
 * WI-10002454 (b): name the measurements behind a `settleQualificationTransaction` conflict —
 * each identity the producer carried that disagrees with the stored transaction, as
 * `<field> stored=<x> produced=<y>`. Mirrors the three conflict predicates above (attempt,
 * candidate, run). Unlike the settle, it reports EVERY mismatch, not just the first.
 * An EMPTY result is itself a finding: the conflict did not come from an identity
 * mismatch but from the store-level CAS (a concurrent writer changed the row between read and
 * update). Callers must say so rather than print nothing.
 */
export function describeQualificationSettleConflict(
  stored: CheckpointQualificationTransaction,
  produced: { attemptId: string; candidate?: string | null; repairHead?: string | null; runId?: string | null },
): string[] {
  const mismatches: string[] = [];
  if (stored.attemptId !== produced.attemptId) {
    mismatches.push(`attempt stored=${stored.attemptId} produced=${produced.attemptId}`);
  }
  const candidate = produced.candidate?.trim() || null;
  const runId = produced.runId?.trim() || null;
  if (candidateIdentityConflicts(stored, { candidate, repairHead: produced.repairHead?.trim() || null, runId })) {
    mismatches.push(`candidate stored=${stored.candidate} produced=${candidate}`);
  }
  if (stored.runId && runId && stored.runId !== runId) {
    mismatches.push(`run stored=${stored.runId} produced=${runId}`);
  }
  return mismatches;
}

/**
 * Deliberately cancel one known physical runner without turning an ordinary external
 * SIGTERM into a retryable pre-suite wait. The caller must name both identities that
 * make the destructive action safe: the logical attempt and the systemd unit recorded
 * for its current runner. A terminal `code-inconclusive` result preserves the repair
 * queue and prevents the producer's later signal/result callback from settling a newer
 * attempt by accident.
 */
export function cancelQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: CancelQualificationInput,
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const runner = current.currentPhysicalRunner;
  if (!runner || runner.unit !== input.unit.trim()) return { status: 'conflict', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const outcome: QualificationOutcome = {
    kind: 'code-inconclusive',
    reason: input.reason?.trim() || 'cancelled',
  };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? []), `cancelled:${runner.id}`]),
    },
  };
}

export type RepairQueueReconciliation = {
  status: 'none' | 'preserved' | 'retired' | 'blocked';
  reason:
    | 'no-queue'
    | 'queue-malformed'
    | 'queue-origin-mismatch'
    | 'queue-origin-unknown'
    | 'queue-not-safe-unstarted'
    | 'matching-untested-repair-head'
    | 'promoted-awaiting-staging-bridge'
    | 'exact-safe-unstarted'
    | 'cas-miss';
  predecessorAttemptId: string;
  successorAttemptId: string;
  candidate?: string;
};

export type StoredQualificationMutation =
  | (QualificationTransition & { repairQueueReconciliation?: RepairQueueReconciliation })
  | { status: 'missing' | 'unreadable'; error?: string };

export type StoredQualificationCancellation =
  | StoredQualificationMutation
  | { status: 'stop-failed'; transaction: CheckpointQualificationTransaction; error: string };

/**
 * A terminal or provably abandoned logical attempt may leave its frozen queue behind. Retire it
 * only for an explicitly distinct successor and only while the queue is still the exact,
 * unstarted row created by that predecessor. Any legacy, mismatched, dispatched, repaired,
 * or otherwise advanced queue stays authoritative and blocks the successor fail-closed.
 *
 * A queue with a NULL `qualificationAttemptId` (schema v3 permits this — see WI-41667) is
 * judged the same way: null means the origin is unknown, not that it belongs to someone
 * else, so it is never fail-closed purely for that reason. It is retired when it is
 * otherwise exact/safe/unstarted, and blocked with the distinguishing `queue-origin-unknown`
 * reason only when the phase/attempts/fixer checks say it genuinely isn't idle (WI-2142947).
 */
export function assessTerminalRepairQueueReconciliation(
  current: CheckpointQualificationTransaction,
  successor: BeginQualificationInput,
  rawRepairQueue: unknown,
): RepairQueueReconciliation {
  const base = {
    predecessorAttemptId: current.attemptId,
    successorAttemptId: successor.attemptId,
  };
  if (rawRepairQueue == null) return { status: 'none', reason: 'no-queue', ...base };
  const queue = parseFrozenCandidateRepairQueue(rawRepairQueue);
  if (!queue) return { status: 'blocked', reason: 'queue-malformed', ...base };
  // A NULL origin is an ABSENCE of provenance, not evidence of a competing owner: schema v3
  // permits a queue created without a stamped `qualificationAttemptId` (see WI-41667), and such
  // a queue is well-formed, not corrupt. Only a KNOWN, DIFFERENT attemptId is a genuine mismatch
  // (someone else's queue) that must stay fail-closed forever. A null origin instead falls
  // through to the same phase/attempts/fixer safety checks below, so it is judged on its actual
  // state rather than being permanently blocked (WI-2142947).
  const originUnknown = queue.qualificationAttemptId === null;
  const originMatchesTerminal = queue.qualificationAttemptId === current.attemptId;
  // A logical qualification can inherit the queue selected by its immediate predecessor.
  // If that inherited run then terminates inconclusively, the queue still names the earlier
  // attempt while `previousAttemptId` is the durable link from the terminal transaction back
  // to it. This link is accepted only for the narrow untested repair-head state below.
  const originMatchesImmediatePredecessor =
    current.previousAttemptId !== null && queue.qualificationAttemptId === current.previousAttemptId;
  // `fixerSpawnId` is historical provenance once the queue reaches ready-to-verify:
  // markFrozenRepairFixerFinished intentionally keeps the completed spawn id so the
  // repair lineage can explain who produced the head.  The phase is the ownership
  // boundary; an active fixer is only allowed to hold an awaiting-fixer row, and an
  // active launch is separately fenced by dispatchReservation.  Requiring a NULL
  // fixerSpawnId here therefore strands every completed fixer admission behind a
  // terminal qualification predecessor (the live failure this reconciliation exists
  // to recover from).
  const safeUntestedRepairHead =
    queue.phase === 'ready-to-verify' &&
    queue.dispatchReservation == null &&
    frozenRepairHeadAwaitsVerification(queue);
  // A legacy/null-origin queue can still be handed forward safely when the caller independently
  // pins the exact never-judged repairHead. The required-ancestor equality supplies the missing
  // provenance link without weakening takeover safety: absent/mismatched pins remain blocked.
  const unknownOriginPinnedToRepairHead = originUnknown && successor.requiredAncestorSha?.trim() === queue.repairHead;
  if (!originUnknown && !originMatchesTerminal && !(originMatchesImmediatePredecessor && safeUntestedRepairHead)) {
    return {
      status: 'blocked',
      reason: 'queue-origin-mismatch',
      candidate: queue.candidate,
      ...base,
    };
  }
  // EI-24610407938327281: main ALREADY advanced to this queue's repairHead, but the P-008
  // post-promotion staging bridge (green-checkpoint.ts `absorbPromotedLineageIntoStaging`)
  // did not complete — measured 2026-09-29: git-sync held `git-sync:papercusp` at the
  // instant the promoting run tried it — so the row stays at `ready-to-promote` as the
  // documented idempotent retry marker for "the next tick". Only a gate RUN can retry that
  // bridge, and a scheduled run needs a successor qualification first. Falling through to
  // `queue-not-safe-unstarted` refused every successor (`skipped-qualification-conflict`
  // at 16:23Z and 17:24Z), so the bridge could never be retried, staging never absorbed the
  // promoted lineage, and no fresh cut could fast-forward main: a silent pipeline deadlock.
  // Deliberately narrow: the terminal predecessor itself proved THIS head green and still
  // owns the queue, and no dispatch reservation is live.
  if (
    originMatchesTerminal &&
    current.phase === 'terminal' &&
    current.outcome.kind === 'green' &&
    queue.phase === 'ready-to-promote' &&
    queue.repairHead === current.candidate &&
    queue.dispatchReservation == null
  ) {
    return {
      status: 'preserved',
      reason: 'promoted-awaiting-staging-bridge',
      candidate: queue.candidate,
      ...base,
    };
  }
  // WI-10000288: a red terminal attempt may own a queue that has since converged onto a
  // DIFFERENT, never-judged repairHead. That row is not predecessor residue to retire and it
  // is not an in-flight repair to block behind: `ready-to-verify` is the queue's explicit
  // suite-producing state. Preserve the exact queue while installing the successor logical
  // qualification, which will select the same repairHead through the ordinary frozen-queue /
  // required-ancestor preflight below. Keep this deliberately narrow: provenance must name the
  // terminal attempt or its explicitly recorded immediate predecessor, no fixer or dispatch
  // reservation may still own the row, and the head must be absent from the convergence rounds.
  // Unknown, unrelated, or deeper ancestry stays fail-closed, as does a repairHead that has
  // already consumed a verification run.
  if (
    (originMatchesTerminal || originMatchesImmediatePredecessor || unknownOriginPinnedToRepairHead) &&
    safeUntestedRepairHead
  ) {
    return {
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      candidate: queue.candidate,
      ...base,
    };
  }
  if (
    queue.phase !== 'ready-to-test' ||
    queue.repairHead !== queue.candidate ||
    queue.attempts !== 0 ||
    queue.fixerSpawnId !== null ||
    queue.dispatchReservation != null
  ) {
    return {
      status: 'blocked',
      // Origin-unknown-and-unsafe gets its own reason so the refusal is diagnosable as "we
      // don't know whose queue this is, and it also isn't verifiably idle" rather than reading
      // like a takeover race against a known owner.
      reason: originUnknown ? 'queue-origin-unknown' : 'queue-not-safe-unstarted',
      candidate: queue.candidate,
      ...base,
    };
  }
  return {
    status: 'retired',
    reason: 'exact-safe-unstarted',
    candidate: queue.candidate,
    ...base,
  };
}

/** What the locked routine row held beside the transaction when a mutation was decided. */
type StoredQualificationRowContext = {
  /** `metadata.repair_queue` exactly as stored (null when no frozen queue exists). */
  rawRepairQueue: unknown;
};

type StoredQualificationMutationOptions = {
  /**
   * Reconcile the predecessor's exact safe queue in the SAME locked row update that
   * installs a distinct successor qualification. A function form receives the locked row's
   * context so the successor's attempt id can be derived from the queue it will verify.
   */
  successorInput?: BeginQualificationInput | ((context: StoredQualificationRowContext) => BeginQualificationInput);
  /** A terminal pipeline result committed with the exact qualification transition. */
  terminalEvent?: { status: string; detail: Record<string, unknown> };
};

async function mutateStoredQualification(
  target: GateVerdictTarget,
  change: (
    current: CheckpointQualificationTransaction | null,
    context: StoredQualificationRowContext,
  ) => StoredQualificationMutation,
  options: StoredQualificationMutationOptions = {},
): Promise<StoredQualificationMutation> {
  try {
    return await boundedOrgTxn<StoredQualificationMutation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      const rowContext: StoredQualificationRowContext = { rawRepairQueue: metadata.repair_queue ?? null };
      const queueHead = frozenRepairQueueVerificationTarget(rowContext.rawRepairQueue);
      if (current?.pendingRepairHead && queueHead && current.pendingRepairHead !== queueHead) {
        return { status: 'conflict' as const, transaction: current };
      }
      const transition = change(current, rowContext);
      if (transition.status !== 'updated') return transition;
      const persistTerminalEvent = async (): Promise<void> => {
        if (!options.terminalEvent || !isTerminalQualificationOutcome(transition.transaction.outcome)) return;
        await appendPipelineEvent({
          workspaceId: target.workspaceId,
          installSlug: target.installSlug,
          kind: 'green_checkpoint',
          ...options.terminalEvent,
        }, tx as unknown as Sql, { required: true });
      };
      const successorInput =
        typeof options.successorInput === 'function' ? options.successorInput(rowContext) : options.successorInput;
      // A distinct successor may replace a proved-dead nonterminal runner as well as a
      // terminal attempt. Both inherit the predecessor's queue, so both must reconcile and
      // re-stamp its owner in the same row write. Leaving the abandoned queue's old id in
      // place makes a later gate self-heal fail its handoff guard despite a matching CAS.
      const predecessor =
        successorInput && current && current.attemptId !== transition.transaction.attemptId
          ? current
          : null;
      const reconciliation =
        predecessor && successorInput
          ? assessTerminalRepairQueueReconciliation(predecessor, successorInput, metadata.repair_queue)
          : null;
      if (reconciliation?.status === 'blocked') {
        return {
          status: 'conflict' as const,
          transaction: predecessor!,
          repairQueueReconciliation: reconciliation,
        };
      }
      if (reconciliation?.status === 'retired') {
        const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   CASE
                     WHEN metadata #>> '{gate_health,inconclusive,status}'
                            IN ('repair-in-progress', 'repair-staging-mismatch')
                       THEN (COALESCE(metadata, '{}'::jsonb) - 'repair_queue')
                            #- '{gate_health,inconclusive}'
                     ELSE COALESCE(metadata, '{}'::jsonb) - 'repair_queue'
                   END,
                   '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                   ${JSON.stringify(transition.transaction)}::text::jsonb,
                   true
                 ),
                 updated_at = now()
           WHERE workspace_id = ${target.workspaceId}
             AND install_slug = ${target.installSlug}
             AND target_role = 'system:green-checkpoint'
             AND metadata->'repair_queue' = ${JSON.stringify(metadata.repair_queue)}::text::jsonb
             AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
           RETURNING metadata`;
        if (updatedRows.length === 0) {
          return {
            status: 'conflict' as const,
            transaction: predecessor!,
            repairQueueReconciliation: {
              ...reconciliation,
              status: 'blocked',
              reason: 'cas-miss',
            },
          };
        }
        await persistTerminalEvent();
        return { ...transition, repairQueueReconciliation: reconciliation };
      }
      if (reconciliation?.status === 'preserved') {
        // Preservation is a queue handoff, not just permission to leave an old id behind.
        // Re-stamp the queue to the successor in the SAME exact-row CAS that installs the
        // successor transaction. Otherwise the next inconclusive run sees ancestry two hops
        // old and wedges on queue-origin-mismatch again.
        const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{repair_queue,qualificationAttemptId}',
                     ${JSON.stringify(transition.transaction.attemptId)}::text::jsonb,
                     true
                   ),
                   '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                   ${JSON.stringify(transition.transaction)}::text::jsonb,
                   true
                 ),
                 updated_at = now()
           WHERE workspace_id = ${target.workspaceId}
             AND install_slug = ${target.installSlug}
             AND target_role = 'system:green-checkpoint'
             AND metadata->'repair_queue' = ${JSON.stringify(metadata.repair_queue)}::text::jsonb
             AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
           RETURNING metadata`;
        if (updatedRows.length === 0) {
          return {
            status: 'conflict' as const,
            transaction: predecessor!,
            repairQueueReconciliation: {
              ...reconciliation,
              status: 'blocked',
              reason: 'cas-miss',
            },
          };
        }
        await persistTerminalEvent();
        return { ...transition, repairQueueReconciliation: reconciliation };
      }
      await tx`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'`;
      await persistTerminalEvent();
      return reconciliation ? { ...transition, repairQueueReconciliation: reconciliation } : transition;
    });
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function beginStoredQualification(
  target: GateVerdictTarget,
  input: BeginQualificationInput,
  options: { reconcileTerminalRepairQueueForSuccessor?: boolean } = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(
    target,
    // Probe INSIDE the mutation so the liveness verdict is taken against the same `current` the
    // transition decides on. Probing outside would race: the incumbent can die, or a fresh runner
    // can take the lease, between the read and the write.
    (current, context) => {
      const queue = parseFrozenCandidateRepairQueue(context.rawRepairQueue);
      const resumableRepairHead =
        current &&
        current.phase === 'waiting' &&
        current.outcome.kind === 'pre-suite-no-verdict' &&
        current.outcome.reason === 'repair-in-progress' &&
        current.currentPhysicalRunner === null &&
        queue?.phase === 'ready-to-verify' &&
        queue.qualificationAttemptId === current.attemptId &&
        queue.fixerSpawnId === null &&
        queue.dispatchReservation == null &&
        frozenRepairHeadAwaitsVerification(queue)
          ? queue.repairHead
          : null;
      return beginQualificationTransaction(current, {
        ...input,
        // EI-22931381517977345: the identity is decided against the SAME locked row's queue.
        // A repair wait already owns that queue. Reuse its logical attempt when the SAME
        // locked row proves the fixer has published a never-judged head; a new id would
        // conflict with the still-nonterminal waiter before it could verify its own repair.
        attemptId: resumableRepairHead
          ? current!.attemptId
          : resolveQualificationAttemptId(input, context.rawRepairQueue),
        candidate: resumableRepairHead ?? input.candidate,
        incumbentLiveness: input.incumbentLiveness ?? probeRunnerLiveness(current?.currentPhysicalRunner),
        resumeUnownedRepairVerification: resumableRepairHead !== null,
      });
    },
    options.reconcileTerminalRepairQueueForSuccessor
      ? {
          successorInput: (context) => ({
            ...input,
            attemptId: resolveQualificationAttemptId(input, context.rawRepairQueue),
          }),
        }
      : {},
  );
}

export function recordStoredQualificationScheduledFire(
  target: GateVerdictTarget,
  attemptId: string,
  nowMs = Date.now(),
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current && current.attemptId === attemptId
      ? recordQualificationScheduledFire(current, nowMs)
      : current
        ? { status: 'conflict', transaction: current }
        : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function waitStoredQualification(
  target: GateVerdictTarget,
  input: Parameters<typeof waitQualificationTransaction>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? waitQualificationTransaction(current, input) : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function reserveStoredQualificationRunner(
  target: GateVerdictTarget,
  input: Parameters<typeof reserveQualificationRunner>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current
      ? reserveQualificationRunner(current, {
          ...input,
          incumbentLiveness: input.incumbentLiveness ?? probeRunnerLiveness(current.currentPhysicalRunner),
        })
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function recordStoredQualificationRunnerProgress(
  target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationRunnerProgress>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? recordQualificationRunnerProgress(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function recordStoredQualificationEligibility(
  target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationEligibilitySnapshot>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current
      ? recordQualificationEligibilitySnapshot(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

export async function readStoredQualification(
  target: GateVerdictTarget,
): Promise<
  | { status: 'present'; transaction: CheckpointQualificationTransaction }
  | { status: 'none' | 'unreadable'; error?: string }
> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ transaction: unknown }[]>`
      SELECT metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} AS transaction
        FROM harness_shared.routines
       WHERE workspace_id = ${target.workspaceId}
         AND install_slug = ${target.installSlug}
         AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (!rows[0]?.transaction) return { status: 'none' };
    const transaction = parseCheckpointQualificationTransaction(rows[0].transaction);
    return transaction
      ? { status: 'present', transaction }
      : { status: 'unreadable', error: 'qualification transaction metadata is malformed' };
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function recordStoredQualificationVerdict(
  target: GateVerdictTarget,
  input: {
    attemptId?: string;
    reason: string;
    green?: boolean | null;
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
    /** Present for a recordable terminal verdict; included in the same DB transaction. */
    terminalEvent?: { status: string; detail: Record<string, unknown> };
  },
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    return settleQualificationTransaction(current, {
      ...input,
      attemptId: input.attemptId ?? current.attemptId,
    });
  }, { terminalEvent: input.terminalEvent });
}

export function recordStoredQualificationScheduledTerminalRecovery(
  target: GateVerdictTarget,
  input: Parameters<typeof recoverQualificationScheduledTerminal>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? recoverQualificationScheduledTerminal(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

/**
 * Stop and settle a runner while the qualification row is held FOR UPDATE. The exact
 * attempt/unit predicates are repeated on the UPDATE as a row-level CAS, and the repair
 * queue is intentionally absent from the SET clause: cancelling a verifier may abandon
 * the physical run, but it must never retire or rewrite the frozen repair lineage.
 */
export async function cancelStoredQualification(
  target: GateVerdictTarget,
  input: CancelQualificationInput,
  stop: () => Promise<{ stopped: boolean; reason?: string }> | { stopped: boolean; reason?: string },
): Promise<StoredQualificationCancellation> {
  try {
    return await boundedOrgTxn<StoredQualificationCancellation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      if (!current) return { status: 'unreadable' as const, error: 'missing attempt' };
      const transition = cancelQualificationTransaction(current, input);
      if (transition.status !== 'updated') return transition;

      const stopped = await stop();
      if (!stopped.stopped) {
        return {
          status: 'stop-failed' as const,
          transaction: current,
          error: stopped.reason?.trim() || 'systemd kill did not stop the exact checkpoint unit',
        };
      }

      const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->>'attemptId' = ${input.attemptId}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->'currentPhysicalRunner'->>'unit' = ${input.unit.trim()}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
         RETURNING metadata`;
      if (updatedRows.length === 0) return { status: 'conflict' as const, transaction: current };
      return transition;
    });
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}
