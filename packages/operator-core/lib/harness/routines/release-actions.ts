/**
 * Release-gating system actions — plan release-gate-ready-branch-2026-06-04
 * (Phase 1 green-checkpoint); staging→main auto-serve model since
 * staging-branch-pipeline-2026-06-06.
 *
 * Two routines, registered here so the routines engine can fire them:
 *   - `system:green-checkpoint` — fast-forwards the green pin (the **`main`
 *     branch**) to the newest GREEN `staging` commit. Runs the suite in an
 *     ISOLATED checkout.
 *   - `system:release-trigger` — when green `main` is ahead of the running
 *     release checkout, runs the SCRIPTED deploy (`deploy-cli --execute`)
 *     directly: the green gate IS the go/no-go now (auto-serve), and the deploy
 *     mechanics carry their own drain + health-check + auto-rollback. The
 *     release-manager agent remains for interactive/incident use only.
 *
 * Both are seeded ACTIVE (seed-release-routines.ts) — auto-serve posture.
 *
 * Layering: these handlers SHELL OUT to the standalone scripts in
 * apps/operator/lib/release/* (operator-core must not import the apps/operator
 * tier). The scripts are designed to run standalone via tsx for exactly this.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { appendPipelineEvent } from '../git-sync/pipeline-events';
import {
  GATE_FIRE_ID_ENV,
  gateFireIdFromEnv,
  isGateFireId,
  mintGateFireId,
  recordGateFire,
} from '../../release/gate-fire-ledger';
import {
  ROUTINE_FIRE_ROUTINE_ID_ENV,
  ROUTINE_FIRE_WORKFLOW_ID_ENV,
} from '../../release/in-flight-candidate';
import { emitAwaitedEvent } from '../../events/await/engine';
import { gateVerdictEnv, isRecordableVerdict, type GateVerdictTarget } from '../../release/gate-verdict-target';
import { pipelineName, pipelineRef, pipelineTag } from '../../release/pipeline-name';
import { isAdmissionSyntheticCommitDate } from '../../release/admission-commit-date';
import type { FreezeAndConvergeDisposition } from '../../release/freeze-disposition';
import { parseTestPassReuseHealth, type TestPassReuseHealth } from '../../release/test-pass-reuse-report';
import { parseGateRoundPhases, type GateRoundPhases } from '../../release/gate-round-phases';
import { releaseCheckpointConfig, readQualificationAdmission } from '../../release-checkpoint-config';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from '../../release/green-checkpoint-schedule';
import {
  composeGateRedOwnership,
  describeGateRedOwnership,
  gateFailureSignature,
  projectGateRepairOwner,
  type GateRedOwnership,
} from '../../release/gate-red-ownership';
import { RELEASE_FIXER_NO_TURN_PHASE, releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import type postgres from 'postgres';
import { decideStallNotification, describeLadderPosition } from '../../release/stall-escalation-ladder';
import { summarizeStreakCause, type StreakCauseDigest, type StreakTick } from '../../release/streak-cause-digest';
// WI-37605: narrate under the RESOLVED tag, never a hardcoded '[green-checkpoint]'. This module's
// own suite (release-actions*.test.ts) drives these code paths, and vitest captures their stdout
// verbatim into the gate's persisted verdict log — so a hardcoded prefix emits a line
// byte-identical to a real gate decision. Measured: the `skipped-locked` line from
// gateStallNoopLogMessage() below appeared at line 6693 of the 33cd2bfebec8 verdict log reading
// exactly like the gate explaining why it stood down. It was a test fixture.
//
// WI-7274 fixed this class for green-checkpoint.ts's own narration by tagging at the emit funnel;
// this module never got that treatment because the tag was believed to live in apps/operator. It
// does not — it lives in operator-core (checkpoint-log-tags.ts, moved down by
// EI-19395755190419540), i.e. in THIS package, so the funnel is a plain relative import.
import { GREEN_CHECKPOINT_RESULT_MARKER, orchestratorStdoutTag } from '../../release/checkpoint-log-tags';
import { classifyGateAbort, isRecordedInconclusiveStatus } from '../../release/gate-abort-status';
import { greenCheckpointDbPoolEnv } from '../../release/checkpoint-db-pool';
import { admitCheckpointMemory } from '../../release/checkpoint-memory-admission';
import {
  FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS,
  FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
  describeUnreadableFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueueRead,
  markFrozenRepairFixerDispatched,
  buildFrozenRepairConvergenceGateHealth,
  buildFrozenRepairStatusIdentity,
  type FrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueueRead,
} from '../../release/frozen-candidate-repair-queue';
import {
  buildIsolatedScopeArgv,
  CHECKPOINT_FORKS_BY_MODE,
  checkpointScopeMemoryMaxG,
  SCOPE_LAUNCH_FAILURE_RE,
  SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
} from '../../systemd-scope';
import type { FlakeSuspect } from '../../dev-data';
import { buildDeployTerminalShell, RELEASE_DEPLOY_UNIT } from '../../release-deploy-terminal';
import {
  CHECKPOINT_QUALIFICATION_ATTEMPT_ENV,
  CHECKPOINT_SCHEDULED_RUN_ENV,
  beginStoredQualification,
  classifyQualificationVerdict,
  classifyScheduledQualificationJoin,
  describeQualificationSettleConflict,
  probeRunnerLiveness,
  readStoredQualification,
  recordStoredQualificationScheduledFire,
  recordStoredQualificationScheduledTerminalRecovery,
  recordStoredQualificationVerdict,
  reserveStoredQualificationRunner,
} from '../../release/checkpoint-qualification-transaction';
import { readLiveReleaseCertification, type LiveReleaseCertification } from '../../release/live-release-certification';
import { createTextCollector } from '../../child-output';
import {
  buildCandidateSnapshot,
  candidateSnapshotMatchesDispatch,
  parseCandidateSnapshot,
  type CandidateSnapshot,
} from '../../release/candidate-snapshot';
import type { CheckpointCandidateSource } from '../../release/checkpoint-candidate-source';

// Kept as exports from this historical module for callers/tests that already
// use the release-actions config surface. The implementation is shared with
// the detached manual launcher in release/checkpoint-db-pool.ts.
export {
  DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX,
  resolveGreenCheckpointDbPoolMax,
} from '../../release/checkpoint-db-pool';

// Re-exported for backward compatibility — release-actions.test.ts imports
// buildIsolatedScopeArgv from THIS module. The pure builder itself now lives in
// ../../systemd-scope so the orchestrator-runner.ts agent-spawn seam (WI-1499) can
// reuse it without pulling in this file's module-level registerSystemAction side effect.
export { buildIsolatedScopeArgv };
// The checkpoint cap policy is pure and shared with the detached manual launcher;
// preserve this historical export surface for release-actions callers/tests.
export { CHECKPOINT_FORKS_BY_MODE, checkpointScopeMemoryMaxG };

/** Markers the release CLIs print their result JSON behind (P-008) — parse ONE delimited
 *  line instead of brace-slicing all of stdout (fragile to any log line with braces).
 *  The checkpoint marker comes from the zero-import shared leaf; DEPLOY_PLAN_MARKER remains
 *  local because its producer has no second operator-core consumer. */
const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/** Parse the JSON on the line carrying `marker`, or null if absent/unparseable. */
function parseMarkerLine(stdout: string, marker: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((l) => l.includes(marker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Paths for the external evidence owned by a scheduled green-checkpoint wrapper. */
export interface CheckpointRunLogPaths {
  runId: string;
  logPath: string;
  terminalPath: string;
}

/** Versioned terminal evidence written by the out-of-process scheduled wrapper. */
export const SCHEDULED_CHECKPOINT_TERMINAL_SCHEMA_VERSION = 1 as const;

/**
 * Identity stamped before launch. These fields are nullable for callers that only use the
 * wrapper as a log/evidence primitive, but a reconciler never mutates qualification state
 * without all three exact identities.
 */
export interface ScheduledCheckpointTerminalContext {
  workspaceId?: string | null;
  installSlug?: string | null;
  qualificationAttemptId?: string | null;
  gateFireId?: string | null;
  integrationRoot?: string | null;
}

export interface ScheduledCheckpointTerminalRecord {
  schemaVersion: typeof SCHEDULED_CHECKPOINT_TERMINAL_SCHEMA_VERSION;
  runId: string;
  logPath: string;
  exitCode: number | null;
  killed: boolean;
  memoryEvents: unknown;
  finishedAt: string;
  workspaceId: string | null;
  installSlug: string | null;
  qualificationAttemptId: string | null;
  gateFireId: string | null;
  integrationRoot: string | null;
}

function nullableBoundedString(value: unknown, max = 512): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

/**
 * Parse one terminal file fail-closed. `terminalPath` binds the record to the file that
 * contained it; a copied/tampered record cannot point reconciliation at a different log.
 */
export function parseScheduledCheckpointTerminal(
  raw: unknown,
  terminalPath?: string,
): ScheduledCheckpointTerminalRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== SCHEDULED_CHECKPOINT_TERMINAL_SCHEMA_VERSION) return null;
  const runId = nullableBoundedString(value.runId, 160);
  const logPath = nullableBoundedString(value.logPath, 4096);
  const finishedAt = nullableBoundedString(value.finishedAt, 80);
  const workspaceId = nullableBoundedString(value.workspaceId, 160);
  const installSlug = nullableBoundedString(value.installSlug, 160);
  const qualificationAttemptId = nullableBoundedString(value.qualificationAttemptId, 200);
  const gateFireId = nullableBoundedString(value.gateFireId, 160);
  const integrationRoot = nullableBoundedString(value.integrationRoot, 4096);
  const exitCode = value.exitCode;
  if (
    !runId ||
    !logPath ||
    !finishedAt ||
    !Number.isFinite(Date.parse(finishedAt)) ||
    (exitCode !== null &&
      (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) ||
    workspaceId === undefined ||
    installSlug === undefined ||
    qualificationAttemptId === undefined ||
    gateFireId === undefined ||
    integrationRoot === undefined ||
    (integrationRoot !== null && !path.isAbsolute(integrationRoot)) ||
    (value.killed !== undefined && typeof value.killed !== 'boolean') ||
    (terminalPath && `${logPath}.terminal.json` !== terminalPath)
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEDULED_CHECKPOINT_TERMINAL_SCHEMA_VERSION,
    runId,
    logPath,
    exitCode: exitCode === null ? null : Number(exitCode),
    killed: value.killed === true,
    memoryEvents: value.memoryEvents ?? null,
    finishedAt,
    workspaceId,
    installSlug,
    qualificationAttemptId,
    gateFireId,
    integrationRoot,
  };
}

function nonNegativeCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** True only for cgroup counters that prove a kill, never for generic pressure/throttling. */
export function checkpointTerminalHasOomKill(
  terminal: Pick<ScheduledCheckpointTerminalRecord, 'memoryEvents'>,
): boolean {
  if (!terminal.memoryEvents || typeof terminal.memoryEvents !== 'object' || Array.isArray(terminal.memoryEvents)) {
    return false;
  }
  const events = terminal.memoryEvents as Record<string, unknown>;
  for (const scopeName of ['subtree', 'local'] as const) {
    const scope = events[scopeName];
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) continue;
    const counters = scope as Record<string, unknown>;
    if ((nonNegativeCounter(counters.oomKill) ?? 0) > 0 || (nonNegativeCounter(counters.oomGroupKill) ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

export function checkpointTerminalSummary(terminal: ScheduledCheckpointTerminalRecord): string {
  const exit = terminal.exitCode === null ? 'unknown exit' : `exit ${terminal.exitCode}`;
  const cause = checkpointTerminalHasOomKill(terminal)
    ? 'cgroup memory.events proves an OOM kill'
    : terminal.killed
      ? 'the wrapper was killed before the child returned'
      : 'no cgroup OOM-kill counter was observed';
  return `scheduled wrapper ${terminal.runId} ended with ${exit}; ${cause}; evidence ${terminal.logPath}`;
}

type ScheduledTerminalRecorder = typeof recordStoredQualificationVerdict;
type ScheduledTerminalRecovery = typeof recordStoredQualificationScheduledTerminalRecovery;
type ScheduledTerminalRead = (file: string) => Promise<string>;
type ScheduledTerminalMove = (from: string, to: string) => Promise<unknown>;

export interface ScheduledCheckpointTerminalReconcileDeps {
  recordVerdict?: ScheduledTerminalRecorder;
  recoverTerminal?: ScheduledTerminalRecovery;
  readText?: ScheduledTerminalRead;
  move?: ScheduledTerminalMove;
  listNames?: (dir: string) => Promise<string[]>;
}

export type ScheduledCheckpointTerminalReconcileStatus =
  | 'settled'
  | 'already-settled'
  | 'stale-attempt'
  | 'ignored-unattributed'
  | 'ignored-other-target'
  | 'invalid'
  | 'retry';

export interface ScheduledCheckpointTerminalReconcileResult {
  terminalPath: string;
  status: ScheduledCheckpointTerminalReconcileStatus;
  reason?: string;
  markerRetained?: boolean;
}

interface LoadedScheduledCheckpointTerminal {
  terminalPath: string;
  terminal: ScheduledCheckpointTerminalRecord;
  logText: string;
}

async function loadScheduledCheckpointTerminal(
  terminalPath: string,
  readText: ScheduledTerminalRead,
): Promise<LoadedScheduledCheckpointTerminal | null> {
  let terminalRaw: string;
  try {
    terminalRaw = await readText(terminalPath);
  } catch {
    return null;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(terminalRaw);
  } catch {
    return null;
  }
  const terminal = parseScheduledCheckpointTerminal(parsedJson, terminalPath);
  if (!terminal) return null;
  let logText = '';
  try {
    logText = await readText(terminal.logPath);
  } catch {
    // The terminal record itself remains authoritative for an abnormal exit. A missing log is
    // evidence loss, not permission to leave the logical attempt running forever.
  }
  return { terminalPath, terminal, logText };
}

async function markScheduledTerminalReconciled(terminalPath: string, move: ScheduledTerminalMove): Promise<boolean> {
  try {
    await move(terminalPath, `${terminalPath}.reconciled`);
    return true;
  } catch {
    return false;
  }
}

async function reconcileLoadedScheduledCheckpointTerminal(
  target: GateVerdictTarget,
  loaded: LoadedScheduledCheckpointTerminal,
  deps: Required<Pick<ScheduledCheckpointTerminalReconcileDeps, 'recordVerdict' | 'recoverTerminal' | 'move'>>,
): Promise<ScheduledCheckpointTerminalReconcileResult> {
  const { terminalPath, terminal, logText } = loaded;
  if (terminal.workspaceId !== target.workspaceId || terminal.installSlug !== target.installSlug) {
    return { terminalPath, status: 'ignored-other-target' };
  }
  if (!terminal.qualificationAttemptId) {
    const moved = await markScheduledTerminalReconciled(terminalPath, deps.move);
    return {
      terminalPath,
      status: 'ignored-unattributed',
      reason: 'terminal marker has no exact logical-attempt identity',
      markerRetained: !moved,
    };
  }

  const emitted = parseMarkerLine(logText, GREEN_CHECKPOINT_RESULT_MARKER);
  const emittedReason = typeof emitted?.reason === 'string' && emitted.reason.trim() ? emitted.reason.trim() : null;
  const reason = emittedReason ?? checkpointFallbackStatus(false, terminal.exitCode ?? undefined, null, terminal);
  const green = typeof emitted?.green === 'boolean' ? emitted.green : null;
  const emittedCandidate =
    typeof emitted?.candidate === 'string' && emitted.candidate.trim() ? emitted.candidate.trim() : null;
  const emittedRunId =
    typeof emitted?.runId === 'string' && emitted.runId.trim() ? emitted.runId.trim() : terminal.runId;
  const emittedRepairHead =
    emitted?.repairQueue &&
    typeof emitted.repairQueue === 'object' &&
    !Array.isArray(emitted.repairQueue) &&
    typeof (emitted.repairQueue as Record<string, unknown>).repairHead === 'string'
      ? String((emitted.repairQueue as Record<string, unknown>).repairHead).trim()
      : null;
  const evidenceRefs = [
    `checkpoint-terminal:${terminal.runId}`,
    `checkpoint-log:${terminal.logPath}`,
    ...(terminal.gateFireId ? [`gate-fire:${terminal.gateFireId}`] : []),
  ];
  const terminalEvent = {
    status: reason,
    detail: emittedReason && emitted
      ? buildCheckpointDetail(emitted as unknown as CheckpointVerdict, terminal.gateFireId ?? undefined)
      : {
          runId: terminal.runId,
          candidate: emittedCandidate,
          green: null,
          logPath: terminal.logPath,
          exitCode: terminal.exitCode,
          killed: terminal.killed ?? false,
          gateFireId: terminal.gateFireId ?? null,
          summary: checkpointTerminalSummary(terminal),
        },
  };
  let settlement: Awaited<ReturnType<ScheduledTerminalRecorder>>;
  try {
    settlement = await deps.recordVerdict(target, {
      attemptId: terminal.qualificationAttemptId,
      reason,
      green,
      ...(emittedCandidate ? { candidate: emittedCandidate } : {}),
      ...(emittedRepairHead ? { repairHead: emittedRepairHead } : {}),
      ...(emittedRunId ? { runId: emittedRunId } : {}),
      evidenceRefs,
      terminalEvent,
    });
  } catch (error) {
    return {
      terminalPath,
      status: 'retry',
      reason: error instanceof Error ? error.message : String(error),
      markerRetained: true,
    };
  }
  if (settlement.status === 'missing' || settlement.status === 'unreadable') {
    return {
      terminalPath,
      status: 'retry',
      reason: 'error' in settlement && settlement.error ? settlement.error : settlement.status,
      markerRetained: true,
    };
  }
  // The parent that normally emits the awaitable red wake may have died. Only the first
  // exact-attempt terminal transition emits; a replay sees an already-terminal attempt.
  if (settlement.status === 'updated' && terminal.integrationRoot && emittedCandidate && green === false &&
      classifyQualificationVerdict({ reason, green }).kind === 'red' &&
      !isPinnedCheckpointVerdict(emitted as CheckpointVerdict | null)) {
    await emitLegacyRedVerdictEvent(terminal.integrationRoot, {
      reason, green: false, candidate: emittedCandidate, runId: emittedRunId,
      from: typeof emitted?.from === 'string' ? emitted.from : undefined,
      summary: typeof emitted?.summary === 'string' ? emitted.summary : undefined,
      failingTests: Array.isArray(emitted?.failingTests) ? emitted.failingTests.filter((test): test is string => typeof test === 'string') : [],
      logPath: terminal.logPath,
    });
  }
  if (settlement.status === 'conflict') {
    // A different logical attempt is stale. A conflict within THIS attempt can mean the
    // scheduled wrapper finished before its unitless reservation attached to the CLI. Its
    // terminal marker and gate-fire id are exact runner proof even when the emitted candidate
    // drifted. Keep the marker unless a guarded recovery actually clears that runner.
    if (settlement.transaction.attemptId !== terminal.qualificationAttemptId) {
      const moved = await markScheduledTerminalReconciled(terminalPath, deps.move);
      return { terminalPath, status: 'stale-attempt', reason, markerRetained: !moved };
    }
    if (!terminal.gateFireId || classifyQualificationVerdict({ reason, green }).kind !== 'pre-suite-no-verdict') {
      return { terminalPath, status: 'retry', reason: 'same-attempt terminal conflict without exact no-verdict runner proof', markerRetained: true };
    }
    let recovery: Awaited<ReturnType<ScheduledTerminalRecovery>>;
    try {
      recovery = await deps.recoverTerminal(target, {
        attemptId: terminal.qualificationAttemptId,
        runnerId: terminal.gateFireId,
        runId: terminal.runId,
        reason,
        finishedAtMs: Date.parse(terminal.finishedAt),
        evidenceRefs,
      });
    } catch (error) {
      return { terminalPath, status: 'retry', reason: error instanceof Error ? error.message : String(error), markerRetained: true };
    }
    if (recovery.status !== 'updated' && recovery.status !== 'terminal') {
      return { terminalPath, status: 'retry', reason: `exact terminal recovery ${recovery.status}`, markerRetained: true };
    }
    const moved = await markScheduledTerminalReconciled(terminalPath, deps.move);
    return {
      terminalPath,
      status: recovery.status === 'updated' ? 'settled' : 'already-settled',
      reason: `orphaned-reservation-after-${reason}`,
      markerRetained: !moved,
    };
  }
  const moved = await markScheduledTerminalReconciled(terminalPath, deps.move);
  const status: ScheduledCheckpointTerminalReconcileStatus =
    settlement.status === 'updated'
      ? 'settled'
      : settlement.status === 'idempotent' || settlement.status === 'terminal'
        ? 'already-settled'
        : 'stale-attempt';
  return { terminalPath, status, reason, markerRetained: !moved };
}

/**
 * Reconcile one marker. The DB transition happens before the atomic same-directory rename;
 * a crash in that tiny gap replays an idempotent/CAS-conflicting transition on the next pass.
 */
export async function reconcileScheduledCheckpointTerminalFile(
  target: GateVerdictTarget,
  terminalPath: string,
  deps: ScheduledCheckpointTerminalReconcileDeps = {},
): Promise<ScheduledCheckpointTerminalReconcileResult> {
  const readText = deps.readText ?? ((file) => readFile(file, 'utf8'));
  const loaded = await loadScheduledCheckpointTerminal(terminalPath, readText);
  if (!loaded) return { terminalPath, status: 'invalid', markerRetained: true };
  return reconcileLoadedScheduledCheckpointTerminal(target, loaded, {
    recordVerdict: deps.recordVerdict ?? recordStoredQualificationVerdict,
    recoverTerminal: deps.recoverTerminal ?? recordStoredQualificationScheduledTerminalRecovery,
    move: deps.move ?? rename,
  });
}

/** Bounded startup sweep for a parent that died before it could consume its child's marker. */
export async function reconcileScheduledCheckpointTerminals(
  target: GateVerdictTarget,
  options: ScheduledCheckpointTerminalReconcileDeps & { dir?: string; limit?: number } = {},
): Promise<ScheduledCheckpointTerminalReconcileResult[]> {
  const dir = options.dir ?? scheduledCheckpointLogDir();
  const limit = Math.max(1, Math.min(64, Math.trunc(options.limit ?? 32)));
  const listNames = options.listNames ?? (async (root) => readdir(root));
  const readText = options.readText ?? ((file) => readFile(file, 'utf8'));
  let names: string[];
  try {
    names = await listNames(dir);
  } catch {
    return [];
  }
  const terminalPaths = names
    .filter((name) => name.endsWith('.terminal.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => path.join(dir, name));
  // Read independent files in parallel (performance A1); serialize only the CAS mutations
  // against the one routine row so two stale markers cannot race each other's state transition.
  const loaded = await Promise.all(
    terminalPaths.map((terminalPath) => loadScheduledCheckpointTerminal(terminalPath, readText)),
  );
  const results: ScheduledCheckpointTerminalReconcileResult[] = [];
  for (let i = 0; i < terminalPaths.length; i += 1) {
    const item = loaded[i];
    if (!item) {
      results.push({ terminalPath: terminalPaths[i]!, status: 'invalid', markerRetained: true });
      continue;
    }
    results.push(
      await reconcileLoadedScheduledCheckpointTerminal(target, item, {
        recordVerdict: options.recordVerdict ?? recordStoredQualificationVerdict,
        recoverTerminal: options.recoverTerminal ?? recordStoredQualificationScheduledTerminalRecovery,
        move: options.move ?? rename,
      }),
    );
  }
  return results;
}

/** Build a unique per-run checkpoint log path before the suite starts. */
export function checkpointRunLogPaths(
  logDir: string,
  runId: string = randomUUID(),
  now: Date = new Date(),
): CheckpointRunLogPaths {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const fileSafeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '-') || 'run';
  const logPath = path.join(logDir, `${stamp}-scheduled-${fileSafeRunId}.log`);
  return { runId, logPath, terminalPath: `${logPath}.terminal.json` };
}

/** The pre-spawn reservation and systemd scope share one inspectable runner identity. */
export function scheduledCheckpointScopeUnit(gateFireId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(gateFireId)) throw new Error('invalid scheduled gate-fire id');
  return `papercusp-checkpoint-${gateFireId}.scope`;
}

/**
 * EI-22129539141207312 — the systemd-enforced outer wall on a scoped checkpoint run.
 *
 * 4h, chosen to sit STRICTLY ABOVE the whole in-band chain green-checkpoint.ts documents
 * (suite timeout 115m < self-watchdog 180m < CHECKPOINT_LOCK_STALE_MS 190m). That ordering
 * is the point: every in-band mechanism keeps its full chance, and this only ever fires for
 * a run that has defeated ALL of them — so it can never preempt a healthy slow suite or
 * manufacture the pre-verdict kills the 55m→115m bump was made to stop.
 *
 * Measured motivation: one crashed run sat resident 29h with two ZOMBIE esbuild children
 * and no terminal marker, having outlived its 180m self-watchdog by an order of magnitude,
 * because its Node main thread was blocked in a synchronous native call and no JS timer
 * could run. When systemd stops the scope, the wrapper's EXIT trap DOES run and takes its
 * `checkpoint_reached_exit=0` branch, writing the `"killed":true` marker that branch already
 * exists for — so this one property also restores the missing terminal evidence and reaps
 * the tree, without any new cleanup code on a thread that may never execute again.
 */
export const CHECKPOINT_SCOPE_RUNTIME_MAX_SEC = 4 * 60 * 60;

/** Keep the scheduled wrapper's evidence directory aligned with the CLI's release config. */
function scheduledCheckpointLogDir(): string {
  return process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ?? path.join(homedir(), '.papercusp', 'checkpoint-logs');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `\'"\'"\'`)}'`;
}

/**
 * Wrap one checkpoint payload in an out-of-process evidence owner.
 *
 * The wrapper creates the log before invoking the suite, tees stdout/stderr back through the
 * caller's pipes while appending both streams to the log, and records its own exit in a
 * same-directory temp file followed by rename. That last write is deliberately outside the
 * routine parent: a scheduled systemd scope can outlive the parent that launched it.
 */
export function buildScheduledCheckpointShell(
  payload: readonly string[],
  paths: CheckpointRunLogPaths,
  context: ScheduledCheckpointTerminalContext = {},
): string {
  const command = payload.map(shellQuote).join(' ');
  const runIdJson = shellQuote(JSON.stringify(paths.runId));
  const logPathJson = shellQuote(JSON.stringify(paths.logPath));
  const workspaceIdJson = shellQuote(JSON.stringify(context.workspaceId ?? null));
  const installSlugJson = shellQuote(JSON.stringify(context.installSlug ?? null));
  const qualificationAttemptIdJson = shellQuote(JSON.stringify(context.qualificationAttemptId ?? null));
  const gateFireIdJson = shellQuote(JSON.stringify(context.gateFireId ?? null));
  const integrationRootJson = shellQuote(JSON.stringify(context.integrationRoot ?? null));
  const logDir = path.dirname(paths.logPath);
  return [
    `log=${shellQuote(paths.logPath)}`,
    `terminal=${shellQuote(paths.terminalPath)}`,
    `mkdir -p -- ${shellQuote(logDir)} 2>/dev/null || :`,
    'rm -f -- "$terminal" "$terminal.tmp.$$"',
    ': > "$log" 2>/dev/null || :',
    `printf '%s\\n' ${shellQuote(`# scheduled green-checkpoint wrapper runId=${paths.runId}`)} >> "$log" 2>/dev/null || :`,
    // The EXIT trap also runs when the wrapper is killed before it reaches the final
    // `exit "$status"`. In that path `$?` is only the last incidental cleanup command
    // (historically `wait ... || :`, i.e. 0), not the gate's fate. Keep an explicit
    // completion bit so an interrupted wrapper records an honest unknown code instead
    // of manufacturing a clean exit. This intentionally covers signals we did not
    // predict, rather than hard-coding TERM/INT exit codes.
    'checkpoint_reached_exit=0',
    '_papercusp_write_checkpoint_terminal() {',
    '  ec=$?',
    '  trap - EXIT',
    '  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '  tmp="$terminal.tmp.$$"',
    // WI-807897: the transient scope disappears as soon as this EXIT trap
    // returns, so this is the last reliable place to read the counters that
    // distinguish memory.max reclaim thrash from an ordinary red test. Keep
    // subtree and local counters separate: memory.events includes descendants,
    // while memory.events.local attributes only this cgroup.
    '  _papercusp_memory_event_value() {',
    '    value="$(awk -v key="$2" \'$1 == key { print $2; found=1; exit } END { if (!found) print 0 }\' "$1" 2>/dev/null)"',
    '    case "$value" in ""|*[!0-9]*) value=0 ;; esac',
    '    printf "%s" "$value"',
    '  }',
    '  memory_events_json=null',
    '  cgroup_rel="$(awk -F: \'$1 == "0" { print $3; exit }\' /proc/self/cgroup 2>/dev/null)"',
    '  cgroup_dir="/sys/fs/cgroup${cgroup_rel}"',
    '  subtree_events="$cgroup_dir/memory.events"',
    '  local_events="$cgroup_dir/memory.events.local"',
    '  peak_file="$cgroup_dir/memory.peak"',
    '  if [ -n "$cgroup_rel" ] && [ -r "$subtree_events" ]; then',
    '    subtree_json="$(printf \'{\"low\":%s,\"high\":%s,\"max\":%s,\"oom\":%s,\"oomKill\":%s,\"oomGroupKill\":%s}\' "$(_papercusp_memory_event_value "$subtree_events" low)" "$(_papercusp_memory_event_value "$subtree_events" high)" "$(_papercusp_memory_event_value "$subtree_events" max)" "$(_papercusp_memory_event_value "$subtree_events" oom)" "$(_papercusp_memory_event_value "$subtree_events" oom_kill)" "$(_papercusp_memory_event_value "$subtree_events" oom_group_kill)")"',
    '    local_json=null',
    '    if [ -r "$local_events" ]; then',
    '      local_json="$(printf \'{\"low\":%s,\"high\":%s,\"max\":%s,\"oom\":%s,\"oomKill\":%s,\"oomGroupKill\":%s}\' "$(_papercusp_memory_event_value "$local_events" low)" "$(_papercusp_memory_event_value "$local_events" high)" "$(_papercusp_memory_event_value "$local_events" max)" "$(_papercusp_memory_event_value "$local_events" oom)" "$(_papercusp_memory_event_value "$local_events" oom_kill)" "$(_papercusp_memory_event_value "$local_events" oom_group_kill)")"',
    '    fi',
    '    peak=null',
    '    if [ -r "$peak_file" ]; then peak="$(cat "$peak_file" 2>/dev/null)"; fi',
    '    case "$peak" in ""|*[!0-9]*) peak=null ;; esac',
    '    memory_events_json="$(printf \'{\"subtree\":%s,\"local\":%s,\"peakBytes\":%s}\' "$subtree_json" "$local_json" "$peak")"',
    '  fi',
    '  printf "GREEN_CHECKPOINT_MEMORY_EVENTS %s\\n" "$memory_events_json" >> "$log" 2>/dev/null || :',
    '  if [ "$checkpoint_reached_exit" = 1 ]; then',
    `    printf '{"schemaVersion":1,"runId":%s,"logPath":%s,"exitCode":%s,"memoryEvents":%s,"finishedAt":"%s","workspaceId":%s,"installSlug":%s,"qualificationAttemptId":%s,"gateFireId":%s,"integrationRoot":%s}\\n' ${runIdJson} ${logPathJson} "$ec" "$memory_events_json" "$finished_at" ${workspaceIdJson} ${installSlugJson} ${qualificationAttemptIdJson} ${gateFireIdJson} ${integrationRootJson} > "$tmp" 2>/dev/null || :`,
    '  else',
    `    printf '{"schemaVersion":1,"runId":%s,"logPath":%s,"exitCode":null,"killed":true,"memoryEvents":%s,"finishedAt":"%s","workspaceId":%s,"installSlug":%s,"qualificationAttemptId":%s,"gateFireId":%s,"integrationRoot":%s}\\n' ${runIdJson} ${logPathJson} "$memory_events_json" "$finished_at" ${workspaceIdJson} ${installSlugJson} ${qualificationAttemptIdJson} ${gateFireIdJson} ${integrationRootJson} > "$tmp" 2>/dev/null || :`,
    '  fi',
    '  mv -f -- "$tmp" "$terminal" 2>/dev/null || :',
    '  exit "$ec"',
    '}',
    'trap _papercusp_write_checkpoint_terminal EXIT',
    // The systemd scope intentionally outlives the routine/bg-host process that launched it.
    // When that parent restarts, the live stdout/stderr pipe loses its reader. Plain `tee`
    // exits on EPIPE, closes fd 3/4, and can crash the still-healthy checkpoint before it
    // records a verdict or releases its run lock. Keep the append-only log authoritative and
    // treat only PIPE output loss as best-effort; real log-file write errors still diagnose.
    'exec 3> >(tee --output-error=warn-nopipe -a "$log")',
    'stdout_tee_pid=$!',
    'exec 4> >(tee --output-error=warn-nopipe -a "$log" >&2)',
    'stderr_tee_pid=$!',
    `${command} >&3 2>&4`,
    'status=$?',
    'exec 3>&-',
    'exec 4>&-',
    'wait "$stdout_tee_pid" "$stderr_tee_pid" 2>/dev/null || :',
    'checkpoint_reached_exit=1',
    'exit "$status"',
  ].join('\n');
}

/**
 * EI-20981232855780375: keep the legacy routine fallback's red verdict wake-compatible with
 * the current CLI producer. An older integration-tree CLI cannot emit the awaitable event itself,
 * so the deployed routine must emit both the global and pipeline-scoped keys after parsing its
 * candidate-bound red result. Best-effort: a wake failure must not change gate recording.
 */
function isPinnedCheckpointVerdict(
  verdict: { candidateSource?: CheckpointCandidateSource; diagnostic?: 'candidate-pinned' } | null | undefined,
): boolean {
  return verdict?.candidateSource === 'pinned' || verdict?.diagnostic === 'candidate-pinned';
}

async function emitLegacyRedVerdictEvent(root: string, verdict: CheckpointVerdict): Promise<void> {
  // Candidate-pinned runs are diagnostics, not observations of the live gate. Keep their
  // append-only pipeline history (the caller records it separately), but never wake red
  // subscribers from the legacy/version-skew fallback.
  if (isPinnedCheckpointVerdict(verdict)) return;
  if (verdict.green !== false || !verdict.candidate) return;
  const pipeline = pipelineName(root);
  const candidate = verdict.candidate;
  // EI-22240267519750098: the SEVENTH emit site of this class, and the one a per-file audit
  // of green-checkpoint.ts could never see. `green-checkpoint:red` is a GLOBAL key fired by
  // every co-hosted pipeline, so a bare `main held` reads as the awaiter's OWN gate holding.
  const summary = `${pipelineTag(pipeline)} green-checkpoint: ${candidate.slice(0, 8)} not green — ${pipelineRef(pipeline, 'main')} held`;
  const payload = {
    sha: candidate,
    from: verdict.from ?? null,
    pipeline,
    summary: verdict.summary ?? null,
    failingTests: verdict.failingTests ?? [],
    logPath: verdict.logPath ?? null,
    runId: verdict.runId ?? null,
    lineage: verdict.lineage ?? null,
  };
  const cancelSiblingKeysFor = ['release:green', `release:green:${pipeline}`];
  try {
    await emitAwaitedEvent({
      key: 'green-checkpoint:red',
      summary,
      payload,
      source: 'green-checkpoint',
      cancelSiblingKeysFor,
    });
    await emitAwaitedEvent({
      key: `green-checkpoint:red:${pipeline}`,
      summary,
      payload,
      source: 'green-checkpoint',
      cancelSiblingKeysFor,
    });
  } catch (e) {
    console.warn(
      `${orchestratorStdoutTag()} legacy green-checkpoint:red emit failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Checkouts that must NEVER serve as the integration tree.
 *
 *  `papercup-release` / `papercusp-release` are the DEPLOY ARTIFACT (pinned to green
 *  `main`); `*-checkpoint` are the gate's own isolated test trees. Gating any of them
 *  judges code that is NOT what agents commit to — and does so SILENTLY, which is the
 *  whole defect: a wrong-tree run reports a perfectly well-formed verdict about the
 *  wrong commits. Two agents independently concluded the gate was executing the
 *  release copy while debugging a 22h freeze (EI-20263854732193595). */
const NON_INTEGRATION_CHECKOUTS = new Set([
  'papercup-release',
  'papercusp-release',
  'papercup-checkpoint',
  'papercusp-checkpoint',
]);

/** The integration tree (where green-checkpoint/deploy operate). Explicit env so
 *  it stays correct even after the operator itself runs from the release checkout.
 *
 *  FAIL-CLOSED (EI-20263854732193595): when `PAPERCUSP_INTEGRATION_ROOT` is unset the
 *  cwd-relative fallback is CORRECT for a normal operator (…/papercusp/apps/operator →
 *  …/papercusp) and CATASTROPHIC for one running out of the release checkout
 *  (…/papercup-release/apps/operator → …/papercup-release). The old code could not tell
 *  those apart and returned both without complaint. The guard is deliberately NARROW —
 *  it refuses ONLY the known-bad checkouts, so every working path keeps working and
 *  only the silent-wrong-tree case becomes a loud error. */
export function resolveIntegrationRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const explicit = env.PAPERCUSP_INTEGRATION_ROOT;
  if (explicit) return explicit;

  const derived = path.resolve(cwd, '..', '..');
  const base = path.basename(derived);
  if (NON_INTEGRATION_CHECKOUTS.has(base)) {
    throw new Error(
      `integrationRoot: refusing to gate ${derived} — "${base}" is a release/checkpoint checkout, ` +
        `not the integration tree. Gating it would judge code nobody commits to and report a ` +
        `well-formed verdict about the wrong commits. Set PAPERCUSP_INTEGRATION_ROOT to the ` +
        `staging checkout explicitly. (EI-20263854732193595)`,
    );
  }
  return derived;
}

function integrationRoot(): string {
  return resolveIntegrationRoot();
}

/** The integration tree for a READ-ONLY DIAGNOSTIC, or `null` when it cannot be resolved.
 *
 *  `resolveIntegrationRoot` is deliberately FAIL-CLOSED: it THROWS on a release/checkpoint
 *  checkout so a gate/deploy run can never silently act on the wrong tree. That is right for
 *  the gating and deploy paths — and wrong for the two best-effort diagnostics below, both of
 *  which are documented to degrade (nulls / fail-open) rather than fail a routine tick.
 *
 *  Those sites passed `integrationRoot()` as a call ARGUMENT, which puts a SYNCHRONOUS throw
 *  OUTSIDE the `.catch()` that implements their fail-safe — the promise never exists, so the
 *  handler never runs. Once the guard landed, that turned the gate's OWN unit runs red: vitest
 *  executes operator-core with cwd `<tree>/packages/operator-core`, so the `../..` fallback
 *  resolves to `…/papercusp-checkpoint` inside the checkpoint tree and the resolver refuses.
 *  Diagnostics ask for the root through here; the gating/deploy paths keep the throw. */
function integrationRootForDiagnostic(): string | null {
  try {
    return integrationRoot();
  } catch {
    return null;
  }
}

/** One line of run-scoped evidence: WHICH tree this gate run is judging, and HOW that was
 *  decided. The guard above stops the catastrophic case (a release/checkpoint checkout);
 *  this makes the merely-SURPRISING case legible — an explicit `PAPERCUSP_INTEGRATION_ROOT`
 *  pointing somewhere unexpected still produces a perfectly well-formed verdict about the
 *  wrong commits, and no guard can tell that apart from a correct one.
 *
 *  Why a line in the log at all (EI-20263854732193595): during the 22h freeze TWO agents
 *  independently concluded the gate was executing the release copy, and neither could
 *  cheaply confirm or refute it, because the checkpoint log never stated the root. The
 *  absence of that one line is what turned a five-minute check into hours of archaeology. */
export function integrationRootEvidence(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const root = resolveIntegrationRoot(env, cwd);
  const source = env.PAPERCUSP_INTEGRATION_ROOT ? 'PAPERCUSP_INTEGRATION_ROOT' : 'cwd-fallback';
  return `integration root: ${root} (source=${source}, emitter=routine-dispatcher)`;
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

export interface ReleaseToolingStatus {
  ok: boolean;
  reason?: 'missing_tsx' | 'missing_script';
  root: string;
  tsx: string;
  script: string;
}

export function releaseToolingStatus(
  root: string,
  relScript: string,
  exists: (p: string) => boolean = existsSync,
): ReleaseToolingStatus {
  const tsx = tsxBin(root);
  const script = path.join(root, relScript);
  if (!exists(tsx)) return { ok: false, reason: 'missing_tsx', root, tsx, script };
  if (!exists(script)) return { ok: false, reason: 'missing_script', root, tsx, script };
  return { ok: true, root, tsx, script };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Process signal reported by Node. `systemd-run --scope` commonly translates an
   *  externally-stopped scope to exit 143 instead, so callers must check both forms. */
  signal?: NodeJS.Signals | null;
  /** WI-39841 (Defect 2): THIS runner's own deadline timer fired and SIGTERM'd the group.
   *  Without it, a deadline-kill is indistinguishable from a script crash — both arrive as a
   *  non-zero exit with no parseable result marker, and both were recorded as a red. They call
   *  for opposite operator actions, so the fact is captured at the only place that knows it
   *  first-hand (the timer callback) rather than inferred downstream from empty fields. */
  timedOut?: boolean;
  /** Durable wrapper evidence path, present only for an isolated scheduled checkpoint. */
  terminalPath?: string;
  /** The same wrapper/CLI run identity, even if no terminal marker was written. */
  runId?: string;
}

function runScript(
  root: string,
  relScript: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
  isolate?: { memoryMaxG: number; terminalContext?: ScheduledCheckpointTerminalContext },
  /** Env keys DELETED from the inherited env before `extraEnv` is applied. `extraEnv` cannot
   *  express a deletion, and for a SUBJECT-hive gate run the value that must go is one this
   *  process INHERITED (EI-20709645463022690). Explicit string[] rather than
   *  Record<string,string|undefined> — the latter would lean on Node silently dropping
   *  undefined env values, which is true but unstated. */
  clearEnv: string[] = [],
): Promise<RunResult> {
  const base = [tsxBin(root), path.join(root, relScript), ...args];
  // Isolation kill-switch: PAPERCUSP_CHECKPOINT_SCOPE=0 forces the pre-2026-07-01
  // direct spawn (ops escape hatch, peer of PAPERCUSP_GATEWAY_RPM_SMOOTH).
  const wantScope = !!isolate && process.env.PAPERCUSP_CHECKPOINT_SCOPE !== '0';
  // The routine parent is not the durable owner of a scheduled run: it can be reaped while
  // the systemd scope keeps the suite alive. Put the log + EXIT terminal writer INSIDE that
  // scope, before the suite starts, so a completed or abnormal child exit leaves attributable
  // evidence even when this parent never observes `close`. The direct kill-switch path stays
  // byte-compatible with the historical escape hatch.
  const checkpointPaths = wantScope ? checkpointRunLogPaths(scheduledCheckpointLogDir()) : null;
  const scopedPayload =
    wantScope && checkpointPaths
      ? ['/bin/bash', '-c', buildScheduledCheckpointShell(base, checkpointPaths, isolate?.terminalContext)]
      : base;
  const attempt = (
    argv: string[],
    fallback: (() => Promise<RunResult>) | null,
    terminalPath?: string,
  ): Promise<RunResult> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      // P-007: detached → the child is its own process-GROUP leader, so on the timeout we
      // can SIGTERM the WHOLE group (tsx → npm → vitest workers), not just the tsx parent.
      // Killing only the parent orphaned the test workers, which kept loading the shared
      // box past the cap and manufactured the very load-flakes the gate then has to absorb.
      // (Under the scope wrapper the group leader is systemd-run; the payload inherits
      // its pgid, so the group kill covers the same tree.)
      // Deletions apply to the INHERITED env only, BEFORE the overlay — so an `extraEnv`
      // entry naming a cleared key still wins (that is how the gate hands the subject run
      // papercusp's own DSN under HARNESS_ADMIN_DATABASE_URL while clearing DATABASE_URL).
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of clearEnv) delete childEnv[key];
      const child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        env: {
          ...childEnv,
          PAPERCUSP_INTEGRATION_ROOT: root,
          ...extraEnv,
          // Reuse the scheduled-run transport: a modern scope sends its terminal-marker
          // runId; the legacy direct path retains the '1' sentinel and mints in the CLI.
          ...(checkpointPaths ? { [CHECKPOINT_SCHEDULED_RUN_ENV]: checkpointPaths.runId } : {}),
        },
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let sigkiller: NodeJS.Timeout | undefined;
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig); // negative pid → the whole group
        } catch {
          /* group already gone */
        }
      };
      // WI-39841 (Defect 2): remember that WE killed it. This is the only point in the system
      // that observes the deadline-kill directly; everywhere downstream sees only "non-zero
      // exit, no marker", which is the same shape a crash produces.
      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        // Escalate if a wedged worker ignores SIGTERM, so the group can't linger.
        sigkiller = setTimeout(() => killGroup('SIGKILL'), 15_000);
      }, timeoutMs);
      const finish = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        if (sigkiller) clearTimeout(sigkiller);
        const withTerminal = terminalPath
          ? { ...r, terminalPath, runId: checkpointPaths?.runId }
          : checkpointPaths ? { ...r, runId: checkpointPaths.runId } : r;
        resolve(timedOut ? { ...withTerminal, timedOut: true } : withTerminal);
      };
      // Scope-launch failure (spawn error / fast systemd-run exit with a launch-shaped
      // stderr) → retry without systemd once. Keep the SAME terminal wrapper, so a parent
      // death while that direct child runs still leaves an exact-attempt exit marker.
      const finishOrFallback = (r: RunResult, launchFailed: boolean): void => {
        if (settled) return;
        if (fallback && launchFailed) {
          settled = true;
          clearTimeout(killer);
          if (sigkiller) clearTimeout(sigkiller);
          resolve(fallback());
          return;
        }
        finish(r);
      };
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => finishOrFallback({ code: 1, stdout, stderr: stderr + String(e) }, true));
      child.on('close', (code, signal) =>
        finishOrFallback(
          { code: code ?? (signal === 'SIGTERM' ? 143 : 1), stdout, stderr, signal },
          code !== 0 && Date.now() - startedAt < 5_000 && SCOPE_LAUNCH_FAILURE_RE.test(stderr),
        ),
      );
    });
  return wantScope
    ? attempt(
        buildIsolatedScopeArgv(
          scopedPayload,
          isolate.memoryMaxG,
          'allow',
          CHECKPOINT_SCOPE_RUNTIME_MAX_SEC,
          isolate.terminalContext?.gateFireId
            ? scheduledCheckpointScopeUnit(isolate.terminalContext.gateFireId)
            : null,
        ),
        () => attempt(scopedPayload, null, checkpointPaths?.terminalPath),
        checkpointPaths?.terminalPath,
      )
    : attempt(base, null);
}

/**
 * The wall-clock budget for ONE green-checkpoint suite run before runScript
 * SIGTERMs the whole process group (P-007). This MUST track the gate's fork
 * concurrency: GREEN_CHECKPOINT_MAX_FORKS (green-checkpoint.ts) was lowered
 * 8→4→2 for OOM safety on this memory-pressured shared box, which ~doubled the
 * suite's wall-clock — but this budget stayed at the original 25m, so every
 * 2-fork run OVERRAN it and was SIGTERM-killed (exit 143) BEFORE producing any
 * verdict, wedging the green gate (and thus every fleet deploy) for ~18h
 * (green-checkpoint-timeout-vs-forks-2026-06-27). 55m gave a 2-fork run headroom
 * under MODERATE load — but under sustained full-fleet load (46+ sessions) the
 * multi-pass suite measured 60–90m wall-clock, so 55m resumed killing HEALTHY
 * runs pre-verdict: 4 consecutive gate losses on 2026-07-05 froze `main` ~17h
 * (EI-7553 posts 50747/50749 — run verifiably alive at 59m, SIGTERM'd, verdict
 * row null forever). 120m covers the measured worst case with ~30m headroom.
 *
 * INVARIANT: keep this the SMALLEST link in the gate's timing chain —
 *   THIS (115m)  <  SELF_WATCHDOG_MS (180m, green-checkpoint.ts)
 *     <  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (185m, dbos/dbos-executor-reaper.ts)
 *     <  CHECKPOINT_LOCK_STALE_MS (190m, green-checkpoint.ts)
 * — a run must be killed by THIS timeout (and release its lock) before that lock is
 * stale-reclaimable, else the next hourly fire spawns a SECOND concurrent suite and
 * OOMs the box; and the DBOS reaper's no-output window must sit above the whole run so
 * it cannot cancel a HEALTHY checkpoint's bookkeeping row mid-suite. That last link was
 * MISSING from this list when this budget was raised 55m→120m, so the reaper (still 60m)
 * silently became the tightest bound and reaped healthy runs — WI-6112. operator-core
 * cannot import from apps/operator, so the constants live in separate files; whoever
 * retunes one must retune the others (same convention as the result MARKERs above), and
 * apps/operator/lib/release/release-timing-invariants.test.ts asserts the ordering.
 *
 * Deeper root (see green-checkpoint.ts GREEN_CHECKPOINT_MAX_FORKS notes): the
 * box's memory BASELINE / the :3070 operator-cluster size. Freeing memory there
 * would let the gate run more forks → finish faster → afford a SHORTER budget.
 * This bump UNWEDGES the gate; it does not remove that deeper cost.
 *
 * SECOND INVARIANT — it must NOT be an integer multiple of the gate's fire period
 * (WI-39841). A scheduled run starts a second or two after its cron fire, so its
 * deadline lands a second or two after a LATER fire, and it is still holding the
 * exclusive run-lock at that moment: the fire that should have replaced it is refused,
 * and the gate sits idle until the following hour. At the old 120m against a 60m
 * period this was not a race that sometimes bit — it was deterministic for every run
 * that went the distance. Measured 2026-08-18: run started 17:15:04.877Z, cron fired
 * 19:15:01.941Z, run SIGTERMed 19:15:04 (journal `exited 143`), no run until 20:15.
 * One over-long run therefore cost ~2h of wall-clock, not 2h of work.
 *
 * Hence 115m, not 120m — the LARGEST value that still clears the boundary: a run that
 * starts at HH:15 now dies at HH+1:55 and the HH+2:15 fire finds the lock free, ~5 min
 * of slack. The 5 minutes given up are cheap — a run that needs >115m is a run that
 * was going to be killed mid-suite anyway and record a verdict-less red (the 17:15 run
 * produced NOTHING at its 120m mark) — while the slot recovered is a whole extra hour
 * of gate availability. `phase margin` in release-timing-invariants.test.ts pins it,
 * against the schedule facts in `../../release/green-checkpoint-schedule.ts` (the cron,
 * its fire period, and the required margin — that file is also the ONE place the seed
 * sites get the cron from, so this budget and the schedule it is phased against cannot
 * drift apart silently).
 *
 * ⚠ THE CONSTANT MOVED. It, and the reasoning above in full, now live in
 * `../../release/green-checkpoint-schedule.ts` — a leaf with no imports, which is what
 * lets the three files that used to hand-copy this number derive it instead. This module
 * imports it like everyone else and does NOT re-export it: one definition, one import
 * path, no second name to drift.
 */

/**
 * A green-checkpoint run's result, as the CLI reports it on its result-marker line.
 * (Structural mirror of green-checkpoint.ts's `CheckpointResult` — operator-core must not import
 * from apps/operator, so the shape is restated here, same convention as the result MARKERs above.)
 */
export interface CheckpointEvidence {
  logPath?: string;
  runId?: string;
  integrationRoot?: string;
}

export interface CheckpointTypecheckDiagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  code: string;
  category: 'error' | 'warning';
  message: string;
}

export interface CheckpointTypecheckPreflight {
  status: 'failed';
  checkedFiles: string[];
  failingFiles: string[];
  diagnostics: CheckpointTypecheckDiagnostic[];
}

function boundedCheckpointEvidence(evidence?: CheckpointEvidence | null): CheckpointEvidence | undefined {
  if (!evidence) return undefined;
  const logPath = typeof evidence.logPath === 'string' ? evidence.logPath.trim() : '';
  const runId = typeof evidence.runId === 'string' ? evidence.runId.trim() : '';
  const integrationRoot = typeof evidence.integrationRoot === 'string' ? evidence.integrationRoot.trim() : '';
  if (!logPath && !runId && !integrationRoot) return undefined;
  return {
    ...(logPath ? { logPath: logPath.slice(0, 1000) } : {}),
    ...(runId ? { runId: runId.slice(0, 128) } : {}),
    ...(integrationRoot ? { integrationRoot: integrationRoot.slice(0, 1000) } : {}),
  };
}

function boundedTypecheckPreflight(
  preflight?: CheckpointTypecheckPreflight | null,
): CheckpointTypecheckPreflight | undefined {
  if (!preflight) return undefined;
  return {
    status: 'failed',
    checkedFiles: preflight.checkedFiles.slice(0, 100).map((file) => file.slice(0, 1000)),
    failingFiles: preflight.failingFiles.slice(0, 100).map((file) => file.slice(0, 1000)),
    diagnostics: preflight.diagnostics.slice(0, 100).map((diagnostic) => ({
      file: diagnostic.file?.slice(0, 1000) ?? null,
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code.slice(0, 32),
      category: diagnostic.category,
      message: diagnostic.message.slice(0, 500),
    })),
  };
}

export interface CheckpointVerdict {
  reason: string;
  green?: boolean | null;
  /** Canonical provenance: pinned diagnostics never mutate the live gate. */
  candidateSource?: CheckpointCandidateSource;
  /** Compatibility field for older producers that predate candidateSource. */
  diagnostic?: 'candidate-pinned';
  candidate?: string;
  from?: string | null;
  summary?: string;
  failingTests?: string[];
  flakeSuspects?: string[];
  /** EI-18685042025868279: structural mirror of CheckpointResult.retriedTests — every
   *  test/workspace the gate had to RE-RUN to reach this verdict, with a measured attempt
   *  count. Kept as a loose row shape here (not an import) for the same reason every other
   *  field on this interface is: this is the DESERIALIZED verdict, parsed from the CLI's
   *  JSON marker, so it must not couple operator-core to apps/operator's types. */
  retriedTests?: Array<{ name: string; attempts: number; outcome: string; via: string }>;
  /** EI-18685042025868279: structural mirror of CheckpointResult.cleanGreen. true ⇒ green
   *  with nothing absorbed; false ⇒ green only after re-runs; ABSENT ⇒ unknown (an older
   *  CLI, or a red verdict, where the question has no referent). Never coerce absent to
   *  false — that would manufacture a "not clean" claim from no evidence. */
  cleanGreen?: boolean;
  /** P-013 (gate-file-level-test-reuse-2026-09-27): structural mirror of
   *  CheckpointResult.testPassReuse — what per-file pass reuse did in the suite round that formed
   *  this verdict. Re-validated with parseTestPassReuseHealth before it is stored, because the
   *  version-skew fallback reads it back out of JSON. ABSENT ⇒ not reported this round. */
  testPassReuse?: TestPassReuseHealth;
  /** P-013: structural mirror of CheckpointResult.roundPhases — where this round's time went.
   *  Re-validated with parseGateRoundPhases before storage. ABSENT ⇒ not measured. */
  roundPhases?: GateRoundPhases;
  advancedTo?: string;
  /** WI-4494: the CLI sets this when IT recorded the verdict (gate_health + pipeline event).
   *  The routine then MUST NOT record it again — a second `trackGateStall` for one verdict would
   *  double-increment the red streak. Absent/false ⇒ the caller records, exactly as pre-WI-4494. */
  recorded?: boolean;
  /** EI-20810521712303819: the suite verdict is known, but promotion has not reached its
   *  disposition point yet. This is written before optional post-suite legs so a kill in that
   *  window cannot leave the log ahead of gate_health. The final verdict for the same run clears
   *  this marker without incrementing the red streak a second time. */
  promotionPending?: boolean;
  /** WI-4957: this run's own identity (structural mirror of CheckpointResult.runId) —
   *  distinguishes two runs that happen to judge the same candidate sha. */
  runId?: string;
  /** Stable identity shared by this fire's anchor and terminal/pending outcome rows. */
  gateFireId?: string;
  /** WI-22344736163383832: candidate-selection timestamp, when the producer can attest it. */
  selectedAtMs?: number;
  /** WI-4957: the full-suite output log this run wrote (structural mirror of
   *  CheckpointResult.logPath), when produced. */
  logPath?: string;
  /** Exact producing-run identity, so responders never select a concurrent harness log. */
  checkpointEvidence?: CheckpointEvidence;
  /** Structured files/compiler diagnostics from an early changed-file typecheck abort. */
  typecheckPreflight?: CheckpointTypecheckPreflight;
  /** EI-203121: structural mirror of CheckpointResult.postSuiteLegs. The producer and
   *  this storage boundary both cap the collection and every free-text field. */
  /** WI-22344736163383832: whether the post-suite legs were measured for this verdict. */
  postSuiteMeasured?: boolean;
  postSuiteLegs?: Array<{
    id: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    skipReason?: string;
    executionIdentity?: {
      runId: string;
      candidate: string;
      treeDir: string;
      cwd: string;
      headAtStart: string;
      dependencies: {
        nodeModules: { hash: string | null; inode: number | null; source: string };
      };
      setup: { identity: string; output: string };
      result: {
        status: 'passed' | 'failed' | 'skipped';
        exit: 'completed' | 'skipped' | 'errored';
        exitCode: number | null;
        output: string;
      };
    };
  }>;
  /** EI-13288: structural mirror of green-checkpoint.ts's `RedTriage & { tip }` (stale-candidate
   *  re-triage, 2026-07-10). Present on the not-green path whenever the CLI could re-run the named
   *  failing files at a newer tip. When `classification === 'stale-candidate'` AND
   *  `autoRefire === false`, the CLI's OWN re-test already PROVED these exact files pass at `tip`
   *  and the refire was blocked, so this red's failing-test names must not be reported as a
   *  trustworthy, currently-reproducing verdict (see gate-verdict-freshness.ts Rule 3). An
   *  auto-refiring pass is an intermediate verdict that is about to be superseded; persisting its
   *  stale-cap fields would falsely tell readers that the cap was already reached. Never used to
   *  change the gate's green/red decision. */
  retriage?: {
    classification: 'real-red' | 'stale-candidate' | 'unknown';
    tip: string | null;
    /** Completion time of the tip measurement. Null/absent means no successful tip re-run. */
    tipObservedAtMs?: number | null;
    detail: string;
    /** Structural mirror of RedTriage.autoRefire. Optional for old CLI payloads; absent is not
     *  proof that the cap was reached, so callers must fail closed before persisting stale fields. */
    autoRefire?: boolean;
    refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
  };
  /** isolation-retry-resilience-2026-07-19 (EI-15849): the load-flake / worker-crash
   *  absorption attempt's own human-readable verdict note, persisted REGARDLESS of
   *  whether it flipped the gate green — before this, a not-absorbed attempt's reasoning
   *  (which files still failed, whether isolation ran at all) existed only as a
   *  console.log inside the detached checkpoint child process, truncated to its last
   *  ~200-500 chars by the routine's own logging and never durably recorded. A held-gate
   *  incident was previously undiagnosable after the fact without grepping raw checkpoint
   *  logs (which don't even contain the isolation re-run's own output). Present whenever
   *  the isolation/worker-crash absorber actually ran. */
  isolationNote?: string;
  /** EI-18685041726970077 (owner-flagged highest-leverage fix from the nine-detector
   *  audit): structural mirror of green-checkpoint.ts's `GateLineage` — the judged
   *  candidate's lineage vs the integration branch's tip AT VERDICT TIME (commits
   *  behind + which failing files were touched in that range). Persisted into the
   *  append-only pipeline event detail so a red's staleness is readable from the
   *  DURABLE record (/admin/git, gate_health) without re-deriving it by hand — the
   *  exact archaeology the owner's report named as costing hours. Never used to
   *  change the gate's green/red decision. */
  lineage?: {
    candidate: string;
    tip: string;
    commitsBehind: number;
    failingFilesChangedInRange: string[];
    /** EI-20215068298600724: path-shaped failing files that did not match the
     *  candidate→tip range. Their fixes may have landed in the subjects they
     *  police, so a mixed match must remain visibly undetermined in durable gate
     *  history instead of reading as one all-stale/red verdict. */
    failingFilesUnchangedInRange?: string[];
    /** EI-19390159514676981: TOTAL files changed in the range. Without it the durable
     *  record cannot distinguish "the range was empty" (a real red) from "the range
     *  changed other files, just not the failing TEST files" — which is the expected
     *  shape of an ALREADY-FIXED red whenever the failing test polices OTHER files
     *  (budget/lint/census ratchets are fixed in the file they police, never in
     *  themselves). Absent ⇒ unmeasured, which must read as UNDETERMINED. */
    rangeFilesChanged?: number;
    /** EI-19393306381214544: how many failing entries were path-shaped. 0 ⇒ the empty
     *  intersection compared NOTHING (the failures were bare workspace names), so it
     *  is vacuous rather than evidence. */
    failingPathsConsidered?: number;
    /** EI-20063423357086565: failing files with UNCOMMITTED working-tree changes — the fix
     *  may already be written and merely un-swept by git-sync. Carried here for the same
     *  reason as the two discriminators above: every OTHER field in this record is derived
     *  from commits, so a durable record without this one re-states the exact false
     *  confidence ("candidate IS the tip ⇒ a real red") that the transient line was fixed
     *  for. Absent ⇒ no failing file was dirty; it is NOT a claim the tree was clean. */
    failingFilesDirtyUncommitted?: string[];
  };
  /** EI-18850448565330905: structural mirror of green-checkpoint.ts's `CheckpointResult.crashed`
   *  — this verdict was synthesized by the CLI's own crash handler because the normal run
   *  THREW instead of resolving a leg-reported red (e.g. a non-test member like a PG-backed
   *  plane lint). `summary` carries the thrown error; treat this as "the process crashed", not
   *  as a leg-scoped verdict — the specific failing leg is not always recoverable here. */
  crashed?: boolean;
  /** D-001 / WI-39944: structural mirror of the serialized frozen repair queue.
   * Presence means the gate already dispatched/owns the targeted fixer, so the legacy
   * moving-tip dispatcher must not launch a second agent. Derive this field from
   * the canonical queue type: its schema version and phase vocabulary evolve
   * together, and a hand-copied subset already drifted at schema v3
   * (EI-21222252991281747). */
  repairQueue?: FrozenCandidateRepairQueue;
  /** P-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31): structural mirror of
   *  CheckpointResult.repairTickLegs — present ONLY on an `awaiting-fixer` repair hold, where
   *  the CLI re-measured the cheap NON_TEST_GATE_SCRIPTS legs at the queue's repairHead.
   *  `legs[].id` is the registry KEY (the same vocabulary leg-shaped `failingTests` entries
   *  use), which is what lets trackGateStall refresh exactly the measured entries without
   *  operator-core ever importing the registry (the measured set rides the verdict). */
  repairTickLegs?: {
    head: string;
    atMs: number;
    ok: boolean;
    failingSignatures: string[];
    legs: Array<{ id: string; status: 'pass' | 'fail' | 'errored'; durationMs: number; outputTail?: string }>;
  };
}

/**
 * A bounded, producer-side report from the DG-1 signed verdict publisher.
 *
 * The ordinary release gate is an aggregate run, while `gate_verdicts` is a
 * per-shard fact table.  Keeping this result separate from `CheckpointVerdict`
 * prevents a partial/empty publish from being mistaken for the gate's outcome.
 */
export interface SignedGateVerdictPublishResult {
  published: number;
  skipped: number;
  reason?:
    | 'not-recordable'
    | 'missing-run-identity'
    | 'registry-unreadable'
    | 'repo-unreadable'
    | 'identity-unreadable'
    | 'manifest-unreadable'
    | 'no-test-rows'
    | 'deadline-exceeded';
}

/** The signed shard ledger is additive evidence, so it cannot own the checkpoint run lock
 * after the aggregate verdict is known. A timed-out publisher may finish its idempotent
 * inserts later; the caller must still record gate health and release the run lock now. */
export const SIGNED_GATE_VERDICT_PUBLISH_DEADLINE_MS = 30_000;

export async function publishSignedGateVerdictsWithDeadline(
  publish: () => Promise<SignedGateVerdictPublishResult>,
  log: (line: string) => void,
  deadlineMs = SIGNED_GATE_VERDICT_PUBLISH_DEADLINE_MS,
): Promise<SignedGateVerdictPublishResult> {
  const startedAt = Date.now();
  log(`signed gate shard publication started (deadline ${deadlineMs}ms)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      publish(),
      new Promise<SignedGateVerdictPublishResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ published: 0, skipped: 0, reason: 'deadline-exceeded' }),
          deadlineMs,
        );
      }),
    ]);
    log(`signed gate shard publication ${result.reason ?? 'completed'} in ${Date.now() - startedAt}ms`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface GateTestRunRow {
  /** Database identity used to break same-timestamp retry ties. */
  id?: number | string | null;
  file_path: string;
  status: string;
  duration_ms: number | string | null;
  /** The reporter's completion timestamp; latest completion is authoritative. */
  finished_at?: string | Date | null;
}

/** Parse the immutable reporter evidence timestamp used both for retry ordering
 * and for the signed fact's timestamp. Invalid/absent evidence stays invalid;
 * callers must fail closed rather than falling back to the wall clock. */
function gateTestRunFinishedAtMs(value: GateTestRunRow['finished_at']): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Number.NaN;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Collapse retry rows to the writer's authoritative final attempt.
 *
 * `test_runs` is append-only: a retry records another row for the same
 * `(run_group_id, file_path)`.  The Tests-tab reader and verdict-diff reader
 * both use `finished_at DESC NULLS LAST, id DESC`; the signed-verdict producer
 * must apply that exact rule too.  Otherwise a historical fail survives beside
 * a later pass and `matching.some(...)` signs a false shard failure.
 *
 * Exported as a pure helper so the retry contract is regression-tested without
 * a live database. Rows from older callers may omit the ordering fields; those
 * retain input order, while a row with a measured timestamp/id wins whenever
 * available.
 */
export function collapseFinalTestRunRows(rows: readonly GateTestRunRow[]): GateTestRunRow[] {
  const byFile = new Map<string, { row: GateTestRunRow; index: number }>();
  const idValue = (value: number | string | null | undefined): number => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    }
    return Number.NEGATIVE_INFINITY;
  };
  const isLater = (candidate: GateTestRunRow, incumbent: GateTestRunRow): boolean => {
    const parsedCandidateTs = gateTestRunFinishedAtMs(candidate.finished_at);
    const parsedIncumbentTs = gateTestRunFinishedAtMs(incumbent.finished_at);
    const candidateTs = Number.isFinite(parsedCandidateTs) ? parsedCandidateTs : Number.NEGATIVE_INFINITY;
    const incumbentTs = Number.isFinite(parsedIncumbentTs) ? parsedIncumbentTs : Number.NEGATIVE_INFINITY;
    if (candidateTs !== incumbentTs) return candidateTs > incumbentTs;
    const candidateId = idValue(candidate.id);
    const incumbentId = idValue(incumbent.id);
    if (candidateId !== incumbentId) return candidateId > incumbentId;
    return false;
  };

  rows.forEach((row, index) => {
    const key = String(row.file_path ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
    const existing = byFile.get(key);
    if (!existing || isLater(row, existing.row)) byFile.set(key, { row, index });
  });
  return [...byFile.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ row }) => row);
}

/** Injectable seams for the signed-verdict producer. Production callers omit this;
 * focused tests provide deterministic registry/manifest/identity/DB fakes without
 * touching a real checkout, keychain, or Postgres. */
export interface SignedGateVerdictPublishDeps {
  canonicalRepoKey?: (entry: { slug: string; github_repository_id?: number; github_remote?: string; pot_repo_key?: string }) => string;
  loadHarnessRegistry?: (workspaceId: string, opts?: { fresh?: boolean }) => Promise<{ projects: Array<{
    slug: string;
    path?: string;
    harness_kind?: string;
    hive_slug?: string;
    pot_repo_key?: string;
  }> }>;
  buildShardManifestAtSha?: (repoPath: string, sha: string) => Promise<{
    manifest: {
      shards: Array<{ shardId: string; workspaceDir: string; layer: 'unit' | 'integration' }>;
      unreadableWorkspaces?: Array<unknown>;
    };
    inputsHashByShardId: Record<string, string>;
  }>;
  readTestRuns?: (runId: string, stagingSha: string) => Promise<GateTestRunRow[]>;
  resolveLocalGithubIdentity?: () => Promise<{ kind: string; githubUserId?: number }>;
  resolveDeviceKeychainId?: (githubUserId: number) => string;
  loadOrGenerateDeviceKeypair?: (keychainId: string) => Promise<{ pubkeyBase64: string }>;
  signWithDeviceKey?: (keychainId: string, bytes: Buffer) => Promise<Buffer>;
  signGateVerdict?: typeof import('../../sync/pot-git/gate/verdicts').signGateVerdict;
  gateVerdictId?: typeof import('../../sync/pot-git/gate/verdicts').gateVerdictId;
  insertGateVerdict?: (args: {
    target: GateVerdictTarget;
    hiveHomeSlug: string | null;
    signed: import('../../sync/pot-git/gate/verdicts').GateVerdict;
    verdictId: string;
  }) => Promise<void>;
}

interface SignedGateShard {
  repoKey: string;
  stagingSha: string;
  shardId: string;
  inputsHash: string;
  verdict: 'pass' | 'fail';
  durationMs: number;
  /** Latest immutable final-attempt evidence included in this shard verdict. */
  evidenceTsMs: number;
}

/**
 * Publish DG-1 signed shard facts for one completed checkpoint run.
 *
 * This is deliberately fail-closed and best-effort.  A checkpoint result has
 * no trustworthy shard identity of its own, so the publisher obtains every
 * load-bearing field from independent authoritative writers:
 *
 *   - registry entry → checkout path + canonical repo key + Hive home scope
 *   - committed candidate tree → shard manifest + `inputsHash`
 *   - CI `test_runs` rows for this exact runId/candidate → observed shard
 *     outcomes and measured durations
 *   - local GitHub identity + device keychain → signer and public key
 *
 * If any link is unavailable, no row is written.  In particular, aggregate
 * `green` is never expanded into passes for shards that produced no test rows.
 */
export async function publishSignedGateVerdicts(
  target: GateVerdictTarget,
  verdict: CheckpointVerdict,
  deps: SignedGateVerdictPublishDeps = {},
): Promise<SignedGateVerdictPublishResult> {
  if (!isRecordableVerdict(verdict.reason)) {
    return { published: 0, skipped: 0, reason: 'not-recordable' };
  }
  const stagingSha = typeof verdict.candidate === 'string' ? verdict.candidate.trim() : '';
  const runId = typeof verdict.runId === 'string' ? verdict.runId.trim() : '';
  // GateVerdict's shape guard requires a full commit SHA.  A short marker (or
  // a crash without a marker) is not enough to bind a signed fact to a tree.
  if (!/^[0-9a-f]{40,64}$/i.test(stagingSha) || !runId) {
    return { published: 0, skipped: 0, reason: 'missing-run-identity' };
  }

  try {
    const [{ loadHarnessRegistry: importedLoadRegistry }, { canonicalRepoKey: importedCanonicalRepoKey }, { buildShardManifestAtSha: importedBuildManifest }] =
      await Promise.all([
        deps.loadHarnessRegistry ? Promise.resolve({ loadHarnessRegistry: deps.loadHarnessRegistry }) : import('../../harness-registry'),
        import('../../sync/pot-git/repo-identity'),
        deps.buildShardManifestAtSha ? Promise.resolve({ buildShardManifestAtSha: deps.buildShardManifestAtSha }) : import('../../sync/pot-git/gate/shards'),
      ]);
    const loadHarnessRegistry = importedLoadRegistry as NonNullable<SignedGateVerdictPublishDeps['loadHarnessRegistry']>;
    const canonicalRepoKey = deps.canonicalRepoKey ?? importedCanonicalRepoKey;
    const registry = await loadHarnessRegistry(target.workspaceId, { fresh: true });
    const entry = registry.projects.find((project) => project.slug === target.installSlug);
    if (!entry?.path) return { published: 0, skipped: 0, reason: 'registry-unreadable' };
    const entryPath = entry.path;

    const manifestResult = await (deps.buildShardManifestAtSha
      ? deps.buildShardManifestAtSha(entryPath, stagingSha)
      : importedBuildManifest(
          entryPath,
          stagingSha,
          undefined,
          async (gitlinkPath) => {
            // The gate producer runs on the managed checkout, where initialized
            // submodules already hold the ODBs needed to read committed workspace
            // package.json files. Resolve only descendants of that checkout; an
            // absent/uninitialized submodule remains explicitly unreadable below.
            const repoPath = path.resolve(entryPath, gitlinkPath);
            const root = `${path.resolve(entryPath)}${path.sep}`;
            return repoPath.startsWith(root) && existsSync(repoPath) ? { repoPath } : null;
          },
        )).catch(() => null);
    if (!manifestResult) return { published: 0, skipped: 0, reason: 'manifest-unreadable' };
    // A manifest that explicitly reports workspaces behind an unresolved gitlink is
    // incomplete. Publishing the readable subset would make the aggregate gate look
    // covered while silently omitting a suite, so fail closed for the whole run.
    if (manifestResult.manifest.unreadableWorkspaces?.length) {
      return { published: 0, skipped: 0, reason: 'manifest-unreadable' };
    }

    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    // The checkpoint runner intentionally leaves test_runs.workspace_id and
    // harness_slug NULL (those rows describe the isolated gate tree).  The
    // run-group UUID is the exact, non-guessable join key; source+commit keep
    // unrelated local rows out even if a caller accidentally reuses a UUID.
    const rows = deps.readTestRuns
      ? await deps.readTestRuns(runId, stagingSha)
      : ((await sql.unsafe(
          `SELECT id, file_path, status, duration_ms, finished_at
             FROM harness_shared.test_runs
            WHERE run_group_id = $1
              AND source = 'ci'
              AND commit_sha = $2
            ORDER BY file_path, finished_at DESC NULLS LAST, id DESC`,
          [runId, stagingSha],
        )) as GateTestRunRow[]);
    if (!rows.length) return { published: 0, skipped: 0, reason: 'no-test-rows' };

    const identity = deps.resolveLocalGithubIdentity
      ? await deps.resolveLocalGithubIdentity()
      : await (await import('../../identity/resolve-local-github-identity')).resolveLocalGithubIdentity();
    if (identity.kind !== 'ok') return { published: 0, skipped: rows.length, reason: 'identity-unreadable' };
    if (typeof identity.githubUserId !== 'number') return { published: 0, skipped: rows.length, reason: 'identity-unreadable' };
    const keychainId = deps.resolveDeviceKeychainId
      ? deps.resolveDeviceKeychainId(identity.githubUserId)
      : (await import('../../identity/device-keychain-id')).resolveDeviceKeychainId(identity.githubUserId);
    const keypair = deps.loadOrGenerateDeviceKeypair
      ? await deps.loadOrGenerateDeviceKeypair(keychainId)
      : await (await import('../../identity/attest')).loadOrGenerateDeviceKeypair(keychainId);
    const signWithDeviceKey = deps.signWithDeviceKey
      ?? (await import('../../identity/sign-with-device-key')).signWithDeviceKey;
    const verdictFns = await import('../../sync/pot-git/gate/verdicts');
    const signGateVerdict = deps.signGateVerdict ?? verdictFns.signGateVerdict;
    const gateVerdictId = deps.gateVerdictId ?? verdictFns.gateVerdictId;

    const normalize = (file: string): string => file.replaceAll('\\', '/').replace(/^\.\//, '');
    const layerForFile = (file: string): 'unit' | 'integration' =>
      /(?:^|\/)(?:integration\/|[^/]*\.integration\.(?:test|spec)\.)/.test(file)
        ? 'integration'
        : 'unit';
    const finalRows = collapseFinalTestRunRows(rows);
    const normalizedRows = finalRows.map((row) => ({
      file: normalize(String(row.file_path ?? '')),
      status: String(row.status ?? '').toLowerCase(),
      durationMs: Math.max(0, Number(row.duration_ms ?? 0) || 0),
      finishedAtMs: gateTestRunFinishedAtMs(row.finished_at),
    }));
    const repoKey = canonicalRepoKey(entry);
    const hiveHomeSlug =
      typeof entry.hive_slug === 'string' && entry.hive_slug.trim()
        ? entry.hive_slug.trim()
        : entry.harness_kind === 'hive'
          ? entry.slug
          : null;
    const shards: SignedGateShard[] = [];
    for (const shard of manifestResult.manifest.shards) {
      const prefix = `${normalize(shard.workspaceDir).replace(/\/+$/, '')}/`;
      const matching = normalizedRows.filter(
        (row) =>
          row.file.startsWith(prefix) &&
          layerForFile(row.file.slice(prefix.length)) === shard.layer,
      );
      if (!matching.length) continue;
      // `GateVerdict.ts` participates in both the signature and verdict_id. A
      // wall-clock signing timestamp made a retry produce a second immutable
      // fact for identical evidence. Bind it to the latest final-attempt row
      // included in this shard instead. Missing timestamp evidence cannot be
      // replaced with Date.now(): that would recreate the non-idempotency.
      if (matching.some((row) => !Number.isFinite(row.finishedAtMs))) continue;
      // A skipped/cancelled/error module did not establish a passing shard
      // verdict.  Preserve a measured failure for explicit fail/error rows,
      // but never turn an absence of execution into a pass.
      if (matching.some((row) => ['skip', 'cancelled', 'error', 'running'].includes(row.status))) continue;
      const failed = matching.some((row) => !['pass', 'passed'].includes(row.status));
      const inputsHash = manifestResult.inputsHashByShardId[shard.shardId];
      if (!inputsHash) continue;
      shards.push({
        repoKey,
        stagingSha,
        shardId: shard.shardId,
        inputsHash,
        verdict: failed ? 'fail' : 'pass',
        durationMs: Math.round(matching.reduce((sum, row) => sum + row.durationMs, 0)),
        evidenceTsMs: Math.max(...matching.map((row) => row.finishedAtMs)),
      });
    }
    if (!shards.length) return { published: 0, skipped: rows.length, reason: 'no-test-rows' };

    let published = 0;
    for (const shard of shards) {
      const signed = await signGateVerdict(
        {
          repoKey: shard.repoKey,
          stagingSha: shard.stagingSha,
          shardId: shard.shardId,
          inputsHash: shard.inputsHash,
          verdict: shard.verdict,
          durationMs: shard.durationMs,
          devicePubkeyBase64: keypair.pubkeyBase64,
          nowMs: shard.evidenceTsMs,
        },
        (bytes) => signWithDeviceKey(keychainId, bytes),
      );
      const verdictId = gateVerdictId(signed);
      if (deps.insertGateVerdict) {
        await deps.insertGateVerdict({ target, hiveHomeSlug, signed, verdictId });
      } else {
        await sql.unsafe(
          `INSERT INTO harness_shared.gate_verdicts
            (workspace_id, verdict_id, harness_slug, schema_v, repo_key, staging_sha,
             shard_id, inputs_hash, verdict, duration_ms, device_pubkey, verdict_ts,
             sig, origin, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'local', now())
           ON CONFLICT (workspace_id, verdict_id) DO NOTHING`,
          [
            target.workspaceId,
            verdictId,
            hiveHomeSlug,
            signed.v,
            signed.repo_key,
            signed.staging_sha,
            signed.shard_id,
            signed.inputs_hash,
            signed.verdict,
            signed.duration_ms,
            signed.device_pubkey,
            signed.ts,
            signed.sig,
          ],
        );
      }
      published += 1;
    }
    return { published, skipped: Math.max(0, rows.length - shards.length) };
  } catch {
    // The signed ledger is additive evidence.  A keychain/DB/registry hiccup
    // must never erase the existing gate-health verdict or turn a green run
    // into a crash.  Callers can re-attempt on the next checkpoint run.
    return { published: 0, skipped: 0, reason: 'manifest-unreadable' };
  }
}

/** The pipeline-event `detail` blob for a checkpoint verdict. Shared by BOTH recorders (the CLI's
 *  producer-side write and the routine's fallback) so a manual run's history row is identical to a
 *  routine run's — the /admin/git timeline must not be able to tell who launched the suite. */
export function buildCheckpointDetail(v: CheckpointVerdict, fallbackGateFireId?: string): Record<string, unknown> {
  const detail: Record<string, unknown> = { green: v.green ?? null };
  const gateFireId = isGateFireId(v.gateFireId)
    ? v.gateFireId
    : isGateFireId(fallbackGateFireId)
      ? fallbackGateFireId
      : gateFireIdFromEnv();
  if (gateFireId) detail.gateFireId = gateFireId;
  if (isPinnedCheckpointVerdict(v)) detail.candidateSource = 'pinned';
  else if (v.candidateSource) detail.candidateSource = v.candidateSource;
  if (v.diagnostic) detail.diagnostic = v.diagnostic;
  if (v.promotionPending === true) detail.promotionPending = true;
  if (v.candidate) detail.candidate = v.candidate.slice(0, 12);
  if (v.from) detail.from = v.from.slice(0, 12);
  if (v.repairQueue) {
    // P-003 / D-002: `candidate` historically carried the mutable repair head on no-suite
    // outcomes. Persist the immutable pin and the head separately, then use the canonical queue
    // helper's provenance to make the distinction durable for readers that never see gate_health.
    const identity = buildFrozenRepairStatusIdentity(v.repairQueue);
    detail.frozenCandidate = identity.frozenCandidate.slice(0, 12);
    detail.repairHead = identity.repairHead.slice(0, 12);
    detail.verdictProvenance = {
      ...identity.verdictProvenance,
      frozenCandidate: identity.verdictProvenance.frozenCandidate.slice(0, 12),
      repairHead: identity.verdictProvenance.repairHead.slice(0, 12),
    };
    // WI-10000287: was `currentStatus === 'no-suite'`, a field that has been removed because it
    // restated this exact predicate in process-liveness language. "Has this queue reached an
    // isolated repair green?" is what actually decides whether `candidate` pins the frozen sha.
    if (identity.verdictProvenance.repairHeadVerdict !== 'isolated-repair-green') {
      detail.candidate = identity.frozenCandidate.slice(0, 12);
    }
  }
  // P-016: on a partial advance, record the prefix sha `main` was FF'd to (the red tip stays in
  // `candidate`) so /admin/git shows WHERE main landed vs the held tip.
  if (v.advancedTo) detail.advancedTo = v.advancedTo.slice(0, 12);
  // P-003 (git-sync-dx-hardening): persist the failing-test reason in the append-only event so WHY
  // the gate was red survives the per-tick metadata overwrite (capped).
  if (v.failingTests?.length) detail.failingTests = v.failingTests.slice(0, 20);
  // load-flake-isolation-2026-06-23: persist the files the gate ABSORBED as load-flakes.
  if (v.flakeSuspects?.length) detail.flakeSuspects = v.flakeSuspects.slice(0, 20);
  // EI-18685042025868279: persist the retry accounting, so "was this green clean?" is
  // answerable from the DURABLE record rather than only from a broadcast that scrolls away.
  // Without this the whole fix would stop at the log line — /admin/git, the flake ledger and
  // every gate-history reader would still see a retry-absorbed green as indistinguishable
  // from a clean one, which is the defect itself.
  if (v.retriedTests?.length) detail.retriedTests = v.retriedTests.slice(0, 20);
  // Recorded whenever the CLI stated it — INCLUDING `false`, which is the whole signal. A
  // truthiness check here would drop exactly the case worth persisting.
  if (typeof v.cleanGreen === 'boolean') detail.cleanGreen = v.cleanGreen;
  // P-013: a compact per-round reuse record in the append-only event, so the hit rate stays
  // readable across rounds after gate_health moves on. Full alarms live in gate_health.
  const reuse = parseTestPassReuseHealth(v.testPassReuse);
  if (reuse) {
    detail.testPassReuse = {
      judgedSha: reuse.judgedSha.slice(0, 12),
      candidates: reuse.candidates,
      reused: reuse.reused,
      minSavedTestMs: reuse.minSavedTestMs,
      unmeasured: reuse.unmeasured,
      alarms: reuse.alarms.length,
    };
  }
  // P-013: the round's phase breakdown rides the append-only event whole (it is capped at
  // GATE_ROUND_PHASES_MAX entries), so "where did the time go" is answerable per round.
  const roundPhases = parseGateRoundPhases(v.roundPhases);
  if (roundPhases) detail.roundPhases = roundPhases;
  // WI-4957: persist the run identity + exact log reference so /admin/git history (and
  // gate-verdict-freshness's readers) can tell WHICH run produced this row and open its
  // full output directly, instead of only the de-noised failing-test names.
  if (v.runId) detail.runId = v.runId;
  if (v.logPath) detail.logPath = v.logPath;
  if (v.checkpointEvidence) {
    detail.checkpointEvidence = {
      ...(v.checkpointEvidence.logPath ? { logPath: v.checkpointEvidence.logPath.slice(0, 1000) } : {}),
      ...(v.checkpointEvidence.runId ? { runId: v.checkpointEvidence.runId.slice(0, 128) } : {}),
      ...(v.checkpointEvidence.integrationRoot
        ? { integrationRoot: v.checkpointEvidence.integrationRoot.slice(0, 1000) }
        : {}),
    };
  }
  if (v.typecheckPreflight) {
    detail.typecheckPreflight = {
      status: 'failed',
      checkedFiles: v.typecheckPreflight.checkedFiles.slice(0, 100).map((file) => file.slice(0, 1000)),
      failingFiles: v.typecheckPreflight.failingFiles.slice(0, 100).map((file) => file.slice(0, 1000)),
      diagnostics: v.typecheckPreflight.diagnostics.slice(0, 100).map((diagnostic) => ({
        file: diagnostic.file?.slice(0, 1000) ?? null,
        line: diagnostic.line,
        column: diagnostic.column,
        code: diagnostic.code.slice(0, 32),
        category: diagnostic.category,
        message: diagnostic.message.slice(0, 500),
      })),
    };
  }
  if (v.postSuiteLegs?.length) {
    detail.postSuiteLegs = v.postSuiteLegs.slice(0, 32).map((leg) => ({
      id: leg.id.slice(0, 128),
      status: leg.status,
      durationMs: Math.max(0, Math.floor(leg.durationMs)),
      ...(leg.skipReason ? { skipReason: leg.skipReason.slice(0, 500) } : {}),
      ...(leg.executionIdentity
        ? {
            executionIdentity: {
              runId: leg.executionIdentity.runId.slice(0, 128),
              candidate: leg.executionIdentity.candidate.slice(0, 64),
              treeDir: leg.executionIdentity.treeDir.slice(0, 1000),
              cwd: leg.executionIdentity.cwd.slice(0, 1000),
              headAtStart: leg.executionIdentity.headAtStart.slice(0, 64),
              dependencies: {
                nodeModules: {
                  hash: leg.executionIdentity.dependencies.nodeModules.hash?.slice(0, 128) ?? null,
                  inode: leg.executionIdentity.dependencies.nodeModules.inode,
                  source: leg.executionIdentity.dependencies.nodeModules.source.slice(0, 1000),
                },
              },
              setup: {
                identity: leg.executionIdentity.setup.identity.slice(0, 200),
                output: leg.executionIdentity.setup.output.slice(-1000),
              },
              result: {
                status: leg.executionIdentity.result.status,
                exit: leg.executionIdentity.result.exit,
                exitCode: leg.executionIdentity.result.exitCode,
                output: leg.executionIdentity.result.output.slice(-2000),
              },
            },
          }
        : {}),
    }));
  }
  // P-009: persist the awaiting-fixer hold tick's cheap-legs measurement WITH ITS LEG NAMES —
  // this row IS the per-fire ledger entry that makes non-test legs SQL-visible during repair
  // (test_runs is structurally test-file-only, so without this the legs vanish for the whole
  // hold). Bounded like every sibling block; rides the EXISTING kind/status, no new kind.
  if (v.repairTickLegs) {
    detail.repairTickLegs = {
      head: v.repairTickLegs.head.slice(0, 12),
      atMs: v.repairTickLegs.atMs,
      ok: v.repairTickLegs.ok,
      failingSignatures: v.repairTickLegs.failingSignatures.slice(0, 20).map((s) => s.slice(0, 128)),
      legs: v.repairTickLegs.legs.slice(0, 32).map((leg) => ({
        id: leg.id.slice(0, 128),
        status: leg.status,
        durationMs: Math.max(0, Math.floor(leg.durationMs)),
        ...(leg.outputTail ? { outputTail: leg.outputTail.slice(-500) } : {}),
      })),
    };
  }
  // isolation-retry-resilience-2026-07-19 (EI-15849): persist the absorption verdict note
  // even on a red (not absorbed) — see CheckpointVerdict.isolationNote for why this closes
  // a real diagnosability gap.
  if (v.isolationNote) detail.isolationNote = v.isolationNote.slice(0, 2000);
  // EI-18685041726970077: persist the lineage so a red's staleness is readable from the
  // durable pipeline-event record itself, not only from the transient broadcast/escalate text.
  if (v.lineage) {
    detail.lineage = {
      candidate: v.lineage.candidate.slice(0, 12),
      tip: v.lineage.tip.slice(0, 12),
      commitsBehind: v.lineage.commitsBehind,
      failingFilesChangedInRange: v.lineage.failingFilesChangedInRange.slice(0, 20),
      ...(v.lineage.failingFilesUnchangedInRange?.length
        ? { failingFilesUnchangedInRange: v.lineage.failingFilesUnchangedInRange.slice(0, 20) }
        : {}),
      // Carry the two discriminators too, or the durable record reproduces exactly the
      // false confidence the transient line was fixed for: an empty
      // failingFilesChangedInRange is only real-red evidence when the range itself was
      // empty AND there was something path-shaped to compare (EI-19390159514676981,
      // EI-19393306381214544). Copied conditionally so an unmeasured leg stays absent
      // rather than being written as a 0 that reads like a measurement.
      ...(v.lineage.rangeFilesChanged != null ? { rangeFilesChanged: v.lineage.rangeFilesChanged } : {}),
      ...(v.lineage.failingPathsConsidered != null ? { failingPathsConsidered: v.lineage.failingPathsConsidered } : {}),
      // EI-20063423357086565: the only leg here NOT derived from commits. Without it the
      // durable record shows "candidate IS the tip, 0 behind, nothing changed in range" —
      // three commit-based facts that are all TRUE and together read as a confirmed real
      // red, while the fix sat uncommitted on disk the whole time.
      ...(v.lineage.failingFilesDirtyUncommitted?.length
        ? { failingFilesDirtyUncommitted: v.lineage.failingFilesDirtyUncommitted.slice(0, 20) }
        : {}),
    };
  }
  // WI-7290: persist the RE-TRIAGE verdict — the gate's own DIRECT measurement of whether the
  // red still reproduces at tip ("we re-ran these exact files at tip; they passed / they still
  // fail / we could not measure").
  //
  // Until now the durable record carried `lineage` but NOT this, which is exactly backwards:
  // lineage is the weaker PROXY ("a failing file was MODIFIED somewhere in the range" — a
  // modification is not a fix), while the re-triage is the direct measurement, and the gate
  // computed it and threw it away. `gate_health` keeps only the `stale-candidate` case
  // (retriageStaleTip/retriageDetail, deliberately paired + cleared so a stale note cannot
  // outlive its verdict), so a `real-red`-at-tip finding — the single most decision-relevant
  // fact about a red — survived nowhere at all.
  //
  // Measured cost of that hole, all on the night of 2026-08-02: three filings against the gate
  // (WI-7290; EI-19388705187359206, filed MAJOR against the failing-file parser and retracted
  // only after its author hand-built a probe that disproved it; EI-19389700122825304, the same
  // author's note on misreading a field that could not answer the question), each independently
  // re-deriving from raw logs whether the tip re-run had happened. Recording-only: nothing reads
  // this to decide green/red — see the `unknown`-synthesis note in green-checkpoint.ts.
  if (v.retriage) {
    detail.retriage = {
      classification: v.retriage.classification,
      tip: v.retriage.tip ? v.retriage.tip.slice(0, 12) : null,
      tipObservedAtMs:
        typeof v.retriage.tipObservedAtMs === 'number' && Number.isFinite(v.retriage.tipObservedAtMs)
          ? v.retriage.tipObservedAtMs
          : null,
      detail: v.retriage.detail.slice(0, 500),
    };
  }
  // EI-20702428259478130: persist the ABNORMAL-EXIT discriminators. `summary` and `crashed` were
  // the only CheckpointVerdict fields this function never copied, and that made an INFRA DEATH and
  // a REAL TEST FAILURE identical in the durable record: both landed as status='not-green' with
  // detail {green:false, runId, candidate} and nothing else to tell them apart. (EI-21465187777146773
  // has since separated them at the STATUS level too — a caught crash now publishes reason 'error',
  // the no-verdict class — but these two fields remain the machine-readable discriminators, and are
  // what the held-gate alarm quotes rather than infers; see readLastGateRunEvidence.)
  //
  // Measured cost, 2026-08-17 on oddsmith: four consecutive verdicts recorded not-green while the
  // suite passed 4460/4460. Nothing in the ledger could distinguish them from a genuine red — the
  // disproof required hand-reading the checkpoint log and diffing it against the last good run.
  // The thrown error exists at runtime, in `summary`, and was being discarded at exactly this
  // storage boundary. `crashed` is the structural mirror of CheckpointResult.crashed
  // (EI-18850448565330905) and is the field that makes the distinction MACHINE-readable rather
  // than leaving it to a human parsing prose.
  //
  // Copied conditionally, for the same reason the lineage discriminators above are: an absent leg
  // must stay ABSENT rather than be written as a falsey value that reads like a measurement — a
  // persisted `crashed: false` would assert a clean exit that nobody actually verified.
  if (v.summary) detail.summary = v.summary.slice(0, 2000);
  if (v.crashed === true) detail.crashed = true;
  if (v.repairQueue) {
    detail.repairQueue = {
      phase: v.repairQueue.phase,
      candidate: v.repairQueue.candidate.slice(0, 12),
      repairHead: v.repairQueue.repairHead.slice(0, 12),
      affectedTestProofGroup: v.repairQueue.affectedTestProofGroup ?? null,
      attempts: v.repairQueue.attempts,
      fixerSpawnId: v.repairQueue.fixerSpawnId,
    };
  }
  return detail;
}

/**
 * WI-4494 — RECORD A VERDICT, from whoever produced it.
 *
 * The single act of "this run said something about the gate": the append-only pipeline event (the
 * /admin/git history) plus `gate_health` (the current-verdict blob every consumer reads). Before
 * WI-4494 this lived only in the routine's action body, so ONLY routine-launched runs recorded —
 * a manual `release:checkpoint-run` ran the full suite and threw its verdict away. See
 * release/gate-verdict-target.ts for the failure loop that produced (and the skew-safety that
 * governs which side calls this).
 *
 * Callable from the CLI itself (`green-checkpoint.ts`, via a dynamic import) — hence a plain
 * `GateVerdictTarget` rather than the routine-only `SystemActionCtx`.
 *
 * EI-13723: this is ALSO the release-fixer dispatch's producer-side convergence point, for the
 * same reason WI-4494 made it the recording one. A manually-launched `release:checkpoint-run`
 * self-records its verdict through this exact function (the CLI stamps `gateVerdictEnv` and calls
 * this from its own process) but, before this fix, the fixer-dispatch check lived ONLY in the
 * scheduled routine's own post-processing below — a code path a manual run never executes. During
 * the 2026-07-16/17 stall a fleet repeatedly fired manual checkpoint runs to get a fresh verdict
 * after each fix attempt; each run recorded a real red (with failing tests) but never dispatched a
 * fixer, AND each run's held run-lock caused the scheduled routine's own hourly ticks (the only
 * path that DID dispatch) to land `skipped-locked` — starving the gate of dispatch from both
 * sides for hours until a human broadcast got it manually picked up. Dispatching HERE means every
 * caller of this function — self-recording CLI (routine- or manually-launched) and the routine's
 * own version-skew fallback below — gets fixer coverage uniformly.
 *
 * Returns true when the verdict was recorded; false when it is not a verdict at all (a `skipped-*`
 * outcome — the run that HOLDS the lock is producing the real one and records it itself).
 */
/**
 * WI-38150 — PRE-BIND the self-heal module graph before the long suite runs.
 *
 * The gate's two self-heal paths — the release-red NOTIFY and the release-fixer DISPATCH —
 * are reached through `await import(...)` at the very END of a run that has by then been
 * executing for 30-55 minutes against the LIVE, MUTATING staging checkout. git-sync commits
 * the whole tree every few minutes, so those late imports can bind a module graph assembled
 * from two different states of the same tree. Nothing throws until the last import resolves,
 * and what it throws is a bare `does not provide an export named 'X'`.
 *
 * Observed 2026-08-12 (run started 06:34:21Z, failed 07:02Z): BOTH self-heal paths died on
 * `The requested module './agent-tools/coordination/identity' does not provide an export
 * named 'isTransportOnlyIdentity'` — an export added to the tree at 06:55:16Z, 21 minutes
 * INTO the run. The gate was on its 12th consecutive red at the time. So the one code path
 * that only ever executes when the gate is red is the path that was broken, and it took the
 * notifier down with it: no repair, and no report that no repair had happened.
 *
 * Binding these modules HERE — at the start of the action, before a single test has run —
 * makes the self-heal graph coherent as of run start, which is the same tree state the rest
 * of the run was cut from. It cannot fix a genuinely-missing export, and it is not meant to:
 * it removes the WINDOW, so a self-healer that would work at run start still works at run end.
 *
 * Deliberately NOT silent. A prebind failure is a PREDICTION that the self-healer is already
 * dead for this run, delivered while there is still time to act on it — the opposite of the
 * failure above, which was discovered hours later by reading a log.
 */
let selfHealPrebound: Promise<void> | null = null;
export function prebindSelfHealModules(): Promise<void> {
  // Idempotent per process: several runs (and the stale-red auto-refire, which recurses in
  // the SAME process) share one binding — re-importing a bound module is a no-op anyway, but
  // caching keeps the "PREBOUND"/"PREBIND FAILED" line to one per process rather than per pass.
  if (selfHealPrebound) return selfHealPrebound;
  selfHealPrebound = (async () => {
    const results = await Promise.allSettled([
      import('../../attention-notify'),
      import('../../blueprint/launch-blueprint'),
      import('../../dev-data'),
      import('../../severe-event-broadcast'),
      import('../../coord/gate-ownership'),
    ]);
    const failed = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : [],
    );
    if (failed.length > 0) {
      console.warn(
        `${orchestratorStdoutTag()} SELF-HEAL PREBIND FAILED (${failed.length}/${results.length}) — ` +
          `the release-red notify and/or release-fixer dispatch for THIS run will not launch, so a red ` +
          `gate will go unreported AND unrepaired. Fix before trusting this run's outcome: ${failed.join(' | ')}`,
      );
      return;
    }
    console.log(
      `${orchestratorStdoutTag()} self-heal modules prebound (${results.length}) — notify + fixer dispatch are launchable`,
    );
  })();
  return selfHealPrebound;
}

/** Test seam: forget the cached prebind so a test can exercise the failure path. */
export function __resetSelfHealPrebindForTest(): void {
  selfHealPrebound = null;
}

export async function recordCheckpointVerdict(target: GateVerdictTarget, verdict: CheckpointVerdict): Promise<boolean> {
  // P-003: settle the logical qualification BEFORE filtering non-recordable pipeline outcomes.
  // `skipped-locked`, migrations-pending, and the other typed pre-suite no-verdicts are not gate
  // verdicts, but they are exactly the outcomes that return the same logical attempt to waiting.
  // The detached launcher transports the attempt id in its unit environment; scheduled/version-
  // skew paths omit it and best-effort settle the current global attempt instead.
  const transportedAttemptId = process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV]?.trim() || undefined;
  const pinned = isPinnedCheckpointVerdict(verdict);
  const recordable = isRecordableVerdict(verdict.reason);
  const atomicTerminalEvent = transportedAttemptId && !pinned && recordable
    ? { status: verdict.reason, detail: buildCheckpointDetail(verdict) }
    : undefined;
  const qualificationSettlement = pinned
    ? null
    : await recordStoredQualificationVerdict(target, {
        ...(transportedAttemptId ? { attemptId: transportedAttemptId } : {}),
        reason: verdict.reason,
        green: verdict.green,
        ...(verdict.candidate ? { candidate: verdict.candidate } : {}),
        ...(verdict.repairQueue?.repairHead ? { repairHead: verdict.repairQueue.repairHead } : {}),
        ...(verdict.runId ? { runId: verdict.runId } : {}),
        evidenceRefs: [
          ...(verdict.runId ? [`checkpoint-run:${verdict.runId}`] : []),
          ...(verdict.candidate ? [`candidate:${verdict.candidate}`] : []),
        ],
        ...(atomicTerminalEvent ? { terminalEvent: atomicTerminalEvent } : {}),
      }).catch((error) => ({
        status: 'unreadable' as const,
        error: error instanceof Error ? error.message : String(error),
      }));
  if (transportedAttemptId && qualificationSettlement?.status === 'conflict') {
    // WI-10002454 (b): this fires exactly when the state machine cannot decide, and the verdict
    // is then DISCARDED below — so it must be loud and name BOTH sides of the disagreement.
    const mismatches = describeQualificationSettleConflict(qualificationSettlement.transaction, {
      attemptId: transportedAttemptId,
      candidate: verdict.candidate ?? null,
      repairHead: verdict.repairQueue?.repairHead ?? null,
      runId: verdict.runId ?? null,
    });
    console.error(
      `${orchestratorStdoutTag()} ⚠ logical qualification ${transportedAttemptId} could not settle (conflict) — ` +
        (mismatches.length > 0
          ? mismatches.join('; ')
          : 'no identity mismatch: the stored row changed under a concurrent writer (CAS race)') +
        `. This ${verdict.reason} verdict is DISCARDED, not recorded.`,
    );
  } else if (transportedAttemptId && qualificationSettlement?.status === 'unreadable') {
    console.warn(
      `${orchestratorStdoutTag()} logical qualification ${transportedAttemptId} could not settle ` +
        `(${qualificationSettlement.status}${'error' in qualificationSettlement && qualificationSettlement.error ? `: ${qualificationSettlement.error}` : ''})`,
    );
  }
  // A terminal result from a stale/replaced runner must never wake or mutate the exact-candidate
  // waiters belonging to a newer physical run. The qualification transaction is the CAS
  // authority; a candidate/run identity conflict is therefore a deliberate no-op, not a reason
  // to emit a second terminal event from this producer.
  if (transportedAttemptId && qualificationSettlement?.status === 'conflict') return false;
  if (transportedAttemptId &&
      (qualificationSettlement?.status === 'missing' || qualificationSettlement?.status === 'unreadable')) return false;
  if (!recordable) return false;
  // An exact replay finds the already-terminal qualification. The first producer's
  // result and pipeline event committed together, so do not append or count it twice.
  if (transportedAttemptId && qualificationSettlement?.status === 'terminal') return true;
  if (!atomicTerminalEvent) {
    await appendPipelineEvent({
      workspaceId: target.workspaceId,
      installSlug: target.installSlug,
      kind: 'green_checkpoint',
      status: verdict.reason,
      detail: buildCheckpointDetail(verdict),
    });
  }
  // A pinned candidate is retained as diagnostic pipeline evidence, but it must not become
  // shared gate state or trigger any repair/escalation machinery.
  if (pinned) return true;
  // P-303: the terminal producer has the one exact (runId, candidate) pair that can
  // bind CI file outcomes to committed DG-2 shard inputs. Publish here, once, after
  // the recordability + pinned-diagnostic guards. The publisher is fail-closed and
  // additive: absent/ambiguous evidence writes no signed fact and never changes the
  // ordinary gate-health verdict below.
  const signedVerdicts = await publishSignedGateVerdictsWithDeadline(
    () => publishSignedGateVerdicts(target, verdict),
    (line) => console.log(`${orchestratorStdoutTag()} ${line}`),
  );
  if (signedVerdicts.published > 0) {
    console.log(
      `${orchestratorStdoutTag()} published ${signedVerdicts.published} signed gate shard verdict(s)` +
        (signedVerdicts.skipped > 0 ? ` (${signedVerdicts.skipped} test row(s) unmatched)` : ''),
    );
  }
  // EI-19405864032365760: `summary` rides along so the 'migrations-pending' abort path can name
  // the pending migration in `gate_health.inconclusive` — it is the only field carrying it.
  await trackGateStall(
    target,
    verdict.reason,
    verdict.candidate,
    verdict.failingTests,
    verdict.from ?? null,
    verdict.retriage,
    verdict.summary ?? null,
    undefined,
    // P-009: thread the hold tick's cheap-legs measurement so gate_health stays MEASURED
    // during an awaiting-fixer hold instead of stamping failingTestsMeasured:false.
    {
      runId: verdict.runId,
      candidateSource: verdict.candidateSource,
      diagnostic: verdict.diagnostic,
      selectedAtMs: verdict.selectedAtMs,
      postSuiteMeasured: verdict.postSuiteMeasured,
      postSuiteLegs: verdict.postSuiteLegs,
      testPassReuse: verdict.testPassReuse,
      roundPhases: verdict.roundPhases,
      repairQueue: verdict.repairQueue,
      repairTickLegs: verdict.repairTickLegs,
    },
  ).catch((error) => {
    // The exact terminal result and pipeline event already committed atomically.
    // A cache/projection fault must not relabel the marker as unrecorded and trigger
    // a second fallback history row from the scheduled parent.
    console.warn(`${orchestratorStdoutTag()} gate-health projection failed after terminal record: ${error instanceof Error ? error.message : error}`);
  });
  // EI-13723: see the doc above — the dispatch check moved here so a manual run gets fixer
  // coverage identical to a routine run. Fail-safe: never let a dispatch problem break verdict
  // recording, which already happened above.
  if (
    !verdict.repairQueue &&
    shouldDispatchReleaseFixer(verdict.reason, verdict.candidate, verdict.failingTests, verdict.retriage)
  ) {
    await dispatchReleaseFixer(target, verdict.candidate, verdict.failingTests).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }
  return true;
}

/**
 * EI-20810521712303819: persist the suite's known green/red result before optional promotion
 * work begins. The early `GATE_PROMOTION ... reason=decision-pending` trailer is durable log
 * evidence, but a process killed in the post-suite window never reaches the terminal recorder;
 * without this bridge, gate_health stays on the previous run and verdict watchers never wake.
 *
 * This deliberately records a separate `decision-pending` pipeline event. On normal completion,
 * the terminal recorder replaces the pending marker for the same run; `trackGateStall` uses the
 * run id to avoid counting that red twice. A failure here is handled by the CLI's best-effort
 * seam and must never prevent the promotion decision from continuing.
 */
export async function recordPendingCheckpointVerdict(
  target: GateVerdictTarget,
  verdict: CheckpointVerdict,
): Promise<boolean> {
  if (!verdict.promotionPending || !isRecordableVerdict(verdict.reason)) return false;
  await appendPipelineEvent({
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    kind: 'green_checkpoint',
    status: 'decision-pending',
    detail: buildCheckpointDetail(verdict),
  });
  // Keep the pending diagnostic row for history, but never mutate gate health or dispatch a
  // fixer for a candidate that was explicitly pinned for investigation.
  if (isPinnedCheckpointVerdict(verdict)) return true;
  await trackGateStall(
    target,
    verdict.reason,
    verdict.candidate,
    verdict.failingTests,
    verdict.from ?? null,
    verdict.retriage,
    verdict.summary ?? null,
    undefined,
    {
      promotionPending: true,
      green: verdict.green,
      runId: verdict.runId,
      candidateSource: verdict.candidateSource,
      diagnostic: verdict.diagnostic,
      selectedAtMs: verdict.selectedAtMs,
      postSuiteMeasured: verdict.postSuiteMeasured,
      postSuiteLegs: verdict.postSuiteLegs,
      testPassReuse: verdict.testPassReuse,
      roundPhases: verdict.roundPhases,
      repairQueue: verdict.repairQueue,
    },
  );
  return true;
}

/**
 * system:green-checkpoint — advance `ready` to the newest green integration
 * commit. Idempotent (FF-only, no-op when already green). Bounded so a stuck
 * suite can't wedge the routines tick.
 */
registerSystemAction('green-checkpoint', async (ctx: SystemActionCtx) => {
  // WI-38150: bind the self-heal graph NOW, while the tree still matches the state this run is
  // about to judge. By the time the suite ends (30-55min) the checkout has moved under us, and a
  // late `await import` of the notify/dispatch path can bind across the mutation and throw. Awaited
  // rather than fired-and-forgotten so the diagnostic lands BEFORE the suite's output buries it.
  await prebindSelfHealModules();
  // EI-22642378999251872: consume terminal evidence left by a prior scope whose parent died.
  // This is part of the existing hourly action (not a second scheduler), bounded to 32 newest
  // files. Exact target + attempt CAS prevents another hive or a stale run settling this one.
  const recoveredTerminals = await reconcileScheduledCheckpointTerminals(ctx).catch((error) => {
    console.warn(
      `${orchestratorStdoutTag()} scheduled terminal reconciliation failed: ${error instanceof Error ? error.message : error}`,
    );
    return [] as ScheduledCheckpointTerminalReconcileResult[];
  });
  const recoveredCount = recoveredTerminals.filter((result) =>
    ['settled', 'already-settled', 'stale-attempt'].includes(result.status),
  ).length;
  if (recoveredCount > 0) {
    console.log(`${orchestratorStdoutTag()} reconciled ${recoveredCount} scheduled checkpoint terminal marker(s)`);
  }
  // per-hive-git-and-release-gate P-010: route a per-hive routine to ITS OWN checkout /
  // branches / greenCmd. Operator-home (papercusp) → default root + empty overlay = EXACT
  // current behavior (regression-safe). A non-gated installSlug (gate disabled / no repo) →
  // skip (never run a suite for it). The overlay rides runScript's extraEnv → the
  // env-driven releaseConfig() in green-checkpoint.ts picks up the per-hive config.
  const { resolveCheckpointRouting } = await import('./hive-release-env');
  // EI-20263854732193595: state the judged tree ONCE per run, before any verdict exists.
  // Pinned by a source test — a builder nobody calls is the same silent-but-well-formed
  // failure this whole item is about.
  console.log(`${orchestratorStdoutTag()} ${integrationRootEvidence()}`);
  // P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31): anchor the FIRE itself,
  // before routing/admission/skip/spawn — a tick killed anywhere past this line still leaves
  // one kind='green_checkpoint_fire' ledger row (see ../../release/gate-fire-ledger.ts), so
  // "fires with no outcome" is reconstructable from SQL alone. Best-effort by contract
  // (appendPipelineEvent swallows + warns; until migration 1054 applies the DB CHECK makes it
  // a visible noop). `root` is the best-known-at-entry default — per-hive routing hasn't
  // resolved yet, and MUST NOT run first: its dynamic import can throw, which is exactly the
  // vanished-fire class the anchor exists to record.
  const gateFireId = mintGateFireId();
  const withGateFireId = (detail: Record<string, unknown>): Record<string, unknown> => ({
    ...detail,
    gateFireId,
  });
  await recordGateFire(
    { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug },
    { route: 'scheduled', root: integrationRoot(), gateFireId },
  );
  const routing = await resolveCheckpointRouting(ctx, integrationRoot());
  if (routing.skip) {
    console.log(`${orchestratorStdoutTag()} skip ${ctx.installSlug}: ${routing.skip.reason}`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-disabled',
      detail: withGateFireId({ reason: routing.skip.reason }),
    });
    // EI-17065: a green-checkpoint-{stall,watchdog} escalation for THIS installSlug can
    // never self-clear once the gate stops being routable — trackGateStall (the only
    // code that clears GATE_STALL_PHASE) fires only from a real green VERDICT below,
    // and this branch returns before that ever runs. Distinct from EI-8396's dead-
    // install-slug guard in collectEscalationSignals (watchdog.ts), which suppresses
    // the collector only when the routine ROW is missing/inactive — here the routine
    // is very much active and firing on schedule, it just never reaches trackGateStall
    // because resolveCheckpointRouting returns `skip` first (not_found / no_blueprint /
    // gate_disabled / no_repo — every reason means "no verdict will ever come from this
    // path again until routing changes"). So clear any OPEN escalation for this
    // installSlug right here — the one place that reliably observes the durable
    // (non-transient) reason no verdict is coming. Best-effort: a DB hiccup here must
    // never fail the routine tick, so this mirrors the try/catch used for the green-
    // transition escalation clear below rather than propagating.
    try {
      const { GREEN_CHECKPOINT_ESCALATION_PHASES } = await import('../improvements/watchdog');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const note =
        `\n[auto ${new Date().toISOString()}] green-checkpoint is not routable for this ` +
        `install-slug (${routing.skip.reason}) — an un-routed gate can never produce a ` +
        `green verdict to self-clear this escalation, so it was auto-cleared here.\n`;
      await sql.unsafe(
        `UPDATE harness_shared.harness_escalations
            SET supervisor_notes = COALESCE(supervisor_notes, '') || $4,
                escalation = NULL,
                mtime_ms = $3
          WHERE workspace_id = $1
            AND harness_slug = $2
            AND phase = ANY($5)
            AND escalation IS NOT NULL`,
        [ctx.workspaceId, ctx.installSlug, Date.now(), note, GREEN_CHECKPOINT_ESCALATION_PHASES],
      );
    } catch (e) {
      console.warn(
        `${orchestratorStdoutTag()} skipped-disabled escalation clear failed for ${ctx.installSlug}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return;
  }
  const root = routing.root;
  const tooling = releaseToolingStatus(root, 'apps/operator/lib/release/green-checkpoint.ts');
  if (!tooling.ok) {
    console.warn(
      `${orchestratorStdoutTag()} skip ${ctx.installSlug}: release tooling unavailable (${tooling.reason}) at ${root}`,
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-no-tooling',
      detail: withGateFireId({ reason: tooling.reason, root }),
    });
    return;
  }
  // EI-21363817573800034: ADMISSION — the LAST gate before we spawn, and deliberately so.
  //
  // The run-lock is taken by the CHILD (green-checkpoint.ts), so returning here means no lock is
  // ever acquired — which is the property this guard has to have. Until this existed, an active
  // serializer hold bound humans and agents but not the hourly cron: the wrapper took the lock,
  // and a supervisor hand-stopped the systemd scope afterwards (2026-08-24 D-025 at 18:16Z and
  // D-031 at 19:20Z; both candidates then had to be marked permanently non-qualifying).
  //
  // `unknown` is treated like `held` on purpose — see readQualificationAdmission: an admission we
  // could not MEASURE is not permission. It skips this tick only and retries on the next.
  const admission = await readQualificationAdmission();
  if (admission.status !== 'clear') {
    const held = admission.status === 'held';
    console.warn(
      `${orchestratorStdoutTag()} skip ${ctx.installSlug}: ` +
        (held
          ? `qualification HELD by ${admission.hold.governingRef}` +
            (admission.hold.blockingItems?.length ? ` (blocked on ${admission.hold.blockingItems.join(', ')})` : '')
          : `admission UNDETERMINED (${admission.reason}) — not launching`),
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: held ? 'skipped-held' : 'skipped-admission-unknown',
      detail: withGateFireId(held
        ? {
            governingRef: admission.hold.governingRef,
            blockingItems: admission.hold.blockingItems ?? [],
            reason: admission.hold.reason ?? null,
            placedBy: admission.hold.placedBy ?? null,
            placedAtMs: admission.hold.placedAtMs ?? null,
          }
        : { reason: admission.reason }),
    });
    return;
  }
  // P-006 (green-checkpoint-red-streak-root-cause-2026-08-17): the CROSS-ROOT memory bound.
  //
  // The run-lock one layer down is PER-ROOT — green-checkpoint.ts hashes integrationRoot into
  // the lock filename — so it serializes THIS pot and says nothing about the ~15 pots sharing
  // this hourly cron. Each reserved-mode run commits 40 GiB to its own transient scope, so
  // nothing prevented the sum from exceeding the host. This is the last gate before the scope
  // exists, for the same reason the qualification admission above is: the scope is created
  // inside runScript, so returning here means no memory is ever committed.
  //
  // Compute the cap ONCE and pass the same number to both the admission and the scope, so the
  // two can never disagree about how large this run is.
  //
  // Unlike readQualificationAdmission above, this one FAILS OPEN — see the module note. An
  // unmeasurable probe must not be more restrictive than the unbounded status quo it replaces,
  // and a lone run is never refused.
  const checkpointMemoryG = checkpointScopeMemoryMaxG();
  const memoryAdmission = admitCheckpointMemory({ requestG: checkpointMemoryG });
  if (!memoryAdmission.admit) {
    console.warn(`${orchestratorStdoutTag()} skip ${ctx.installSlug}: ${memoryAdmission.detail}`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-memory-budget',
      detail: withGateFireId({
        reason: memoryAdmission.reason,
        requestG: memoryAdmission.requestG,
        committedG: memoryAdmission.committedG,
        budgetG: memoryAdmission.budgetG,
        scopes: memoryAdmission.scopes,
        unbounded: memoryAdmission.unbounded,
        retryAfterMinutes: TRANSIENT_ABORT_REQUEUE_MINS,
      }),
    });
    // A capacity refusal is safe but not terminal: the competing scopes are expected to
    // drain before the next hourly cron. Reuse the same forward-only/pause-aware requeue
    // contract as transient aborts so a frozen candidate gets another ordinary attempt within
    // minutes, while the admission guard still protects the host. If the metadata write fails,
    // the cron remains the fail-safe fallback and the refusal is already recorded above.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      await requeueGreenCheckpointAfterCapacity(getOrgPg().sql, ctx.installSlug);
    } catch (e) {
      console.warn(
        `${orchestratorStdoutTag()} memory-budget prompt requeue failed: ${e instanceof Error ? e.message : e}`,
      );
    }
    return;
  }
  // Log the admitted verdict too: a bound nobody can see working is indistinguishable from a
  // bound that is silently failing open, which is exactly the failure mode this guard risks.
  console.log(`${orchestratorStdoutTag()} ${ctx.installSlug}: ${memoryAdmission.detail}`);
  // Join the existing logical attempt, or create its successor before spawning a physical run.
  // A scheduled tick is not suite progress: record its own clock while retaining the exact
  // attempt identity that the CLI and terminal marker will later settle.
  const qualificationAtLaunch = await readStoredQualification(ctx).catch(() => ({
    status: 'unreadable' as const,
    error: 'qualification read failed before launch',
  }));
  if (qualificationAtLaunch.status === 'unreadable') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, kind: 'green_checkpoint',
      status: 'skipped-qualification-unreadable',
      detail: withGateFireId({ reason: qualificationAtLaunch.error ?? 'qualification read failed' }),
    });
    return;
  }
  const activeAttempt =
    qualificationAtLaunch.status === 'present' && qualificationAtLaunch.transaction.phase !== 'terminal'
      ? qualificationAtLaunch.transaction
      : null;
  const qualificationBegin = activeAttempt
    ? { status: 'idempotent' as const, transaction: activeAttempt }
    : await beginStoredQualification(
        ctx,
        { attemptId: gateFireId, evidenceRefs: [`gate-fire:${gateFireId}`] },
        { reconcileTerminalRepairQueueForSuccessor: true },
      );
  if (qualificationBegin.status !== 'updated' && qualificationBegin.status !== 'idempotent') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, kind: 'green_checkpoint',
      status: 'skipped-qualification-conflict',
      detail: withGateFireId({ reason: qualificationBegin.status }),
    });
    return;
  }
  const scheduled = await recordStoredQualificationScheduledFire(ctx, qualificationBegin.transaction.attemptId);
  if (scheduled.status !== 'updated' && scheduled.status !== 'idempotent') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, kind: 'green_checkpoint',
      status: 'skipped-qualification-conflict',
      detail: withGateFireId({ reason: scheduled.status, attemptId: qualificationBegin.transaction.attemptId }),
    });
    return;
  }
  const qualificationAttemptId = scheduled.transaction.attemptId;
  const runner = scheduled.transaction.currentPhysicalRunner;
  const runnerLiveness = probeRunnerLiveness(runner);
  const join = classifyScheduledQualificationJoin(scheduled.transaction, runnerLiveness);
  if (join !== 'launch') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, kind: 'green_checkpoint',
      status: join === 'join' ? 'skipped-joined-attempt' : 'skipped-runner-liveness-unknown',
      detail: withGateFireId({
        attemptId: qualificationAttemptId,
        candidate: scheduled.transaction.candidate,
        repairHead: scheduled.transaction.repairHead,
        runId: scheduled.transaction.runId,
        runnerId: runner?.id ?? null,
        runnerLiveness,
      }),
    });
    return;
  }
  // Reserve the physical slot BEFORE the child starts. A second scheduler fire sees this
  // placeholder and joins/fails closed; the child replaces it with its measured PID identity.
  const reserved = await reserveStoredQualificationRunner(ctx, {
    attemptId: qualificationAttemptId,
    runnerId: gateFireId,
    ...(process.env.PAPERCUSP_CHECKPOINT_SCOPE !== '0' ? { unit: scheduledCheckpointScopeUnit(gateFireId) } : {}),
    leaseDurationMs: CHECKPOINT_SCOPE_RUNTIME_MAX_SEC * 1_000,
    started: false,
    evidenceRefs: [`gate-fire:${gateFireId}`],
  });
  if (reserved.status !== 'updated' && reserved.status !== 'idempotent') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, kind: 'green_checkpoint',
      status: 'skipped-qualification-conflict',
      detail: withGateFireId({ reason: reserved.status, attemptId: qualificationAttemptId }),
    });
    return;
  }
  const r = await runScript(
    root,
    'apps/operator/lib/release/green-checkpoint.ts',
    [],
    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    // WI-4494: hand the CLI the harness whose gate this run is judging, so the PRODUCER of the
    // verdict is the thing that records it (see release/gate-verdict-target.ts). A CLI old enough
    // not to know the env simply ignores it and never sets `recorded` — we then record below,
    // exactly as before. The env is what makes that skew safe in both directions.
    {
      ...routing.extraEnv,
      [GATE_FIRE_ID_ENV]: gateFireId,
      [CHECKPOINT_SCHEDULED_RUN_ENV]: '1',
      ...(ctx.routineId && ctx.workflowId
        ? {
            [ROUTINE_FIRE_ROUTINE_ID_ENV]: ctx.routineId,
            [ROUTINE_FIRE_WORKFLOW_ID_ENV]: ctx.workflowId,
          }
        : {}),
      ...(qualificationAttemptId ? { [CHECKPOINT_QUALIFICATION_ATTEMPT_ENV]: qualificationAttemptId } : {}),
      ...gateVerdictEnv({ workspaceId: ctx.workspaceId, installSlug: ctx.installSlug }),
      // WI-4310: the suite's child process must not inherit a large host pool and
      // starve routinesTick's shared org-admin pool. The checkpoint-specific knob
      // is intentionally translated to the db package's standard pool override.
      ...greenCheckpointDbPoolEnv(),
    },
    // Isolate the multi-GB suite in its own transient scope/cgroup so its memory
    // never counts against (or OOM-kills) the bg-host cage that runs the hive loop.
    {
      memoryMaxG: checkpointMemoryG,
      terminalContext: {
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        qualificationAttemptId: qualificationAttemptId ?? null,
        gateFireId,
        integrationRoot: root,
      },
    },
    // EI-20709645463022690: for a SUBJECT hive, drop the operator's inherited DATABASE_URL/PG*
    // so the pot's suite resolves its OWN database. EMPTY for operator-home, whose gate legs
    // genuinely need that DSN — so papercusp's own pipeline is byte-identical (D-007).
    routing.clearEnv,
  );
  if (r.code !== 0) {
    console.warn(`${orchestratorStdoutTag()} exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`${orchestratorStdoutTag()} ${(r.stdout || '').trim().slice(-200)}`);
  }

  // Pipeline history (mig 177): log the checkpoint outcome for the /admin Git tab.
  // The CLI prints the CheckpointResult as JSON ({ advanced, candidate, from,
  // green, reason }); `reason` IS our status vocabulary. On a crash before that
  // print (non-zero exit, no parseable JSON), record an 'error' row instead.
  // WI-39841 (Defect 2): a run KILLED at its own deadline is not a crash and is not a verdict.
  // Measured on the 2026-08-18T17:15:04Z cron run: SIGTERM'd at its 120m cap mid-salvage, it
  // recorded `failingTests:[] observedCandidate:null retriageDetail:null` — and still drove
  // consecutiveReds 26 -> 27, the streak that freezes `main` and dispatches release-fixers.
  // A contentless red is worse than no red: it names nothing to fix while asserting something
  // is broken. `parsed?.reason` below still wins whenever the run DID print a verdict before
  // dying, so this only relabels the genuinely verdict-less case.
  // Explicitly `string`, NOT the helper's narrow union: this is the broad status vocabulary and
  // it is reassigned from `parsed.reason` below (advanced | up-to-date | not-green | …).
  const loadedTerminal = r.terminalPath
    ? await loadScheduledCheckpointTerminal(r.terminalPath, (file) => readFile(file, 'utf8'))
    : null;
  let status: string = checkpointFallbackStatus(r.timedOut, r.code, r.signal, loadedTerminal?.terminal);
  let candidate: string | undefined;
  let summary: string | undefined;
  let failingTests: string[] | undefined;
  let flakeSuspects: string[] | undefined;
  // P-008: parse the delimited result marker, not a brace-slice of all stdout.
  const parsed = (parseMarkerLine(r.stdout, GREEN_CHECKPOINT_RESULT_MARKER) ??
    parseMarkerLine(loadedTerminal?.logText ?? '', GREEN_CHECKPOINT_RESULT_MARKER)) as CheckpointVerdict | null;
  if (parsed?.reason) {
    status = parsed.reason; // advanced | up-to-date | not-green | not-fast-forward | create-failed | skipped-locked
    candidate = parsed.candidate;
    summary = parsed.summary;
    failingTests = parsed.failingTests;
    flakeSuspects = parsed.flakeSuspects;
  } else if (loadedTerminal) {
    summary = checkpointTerminalSummary(loadedTerminal.terminal);
  }
  const terminalReconciliation = r.terminalPath
    ? await reconcileScheduledCheckpointTerminalFile(ctx, r.terminalPath)
    : null;
  if (terminalReconciliation) {
    if (terminalReconciliation.status === 'retry') {
      console.warn(
        `${orchestratorStdoutTag()} terminal marker retained for retry: ${terminalReconciliation.reason ?? r.terminalPath}`,
      );
    }
  }
  /**
   * WI-4494 — did the RUN already record its own verdict?
   *
   * The CLI is now the producer-side recorder (gate_health + the pipeline event), which is what
   * stops a detached `release:checkpoint-run` from computing a real green/red and discarding it.
   * When it recorded, recording again HERE would append a duplicate history row and — worse —
   * double-increment the red streak for a single verdict.
   *
   * We still record when it did NOT, and both cases are real:
   *  - version skew — the DEPLOYED routine drives the INTEGRATION tree's CLI, so an older CLI that
   *    knows nothing of `recorded` (or of the env that authorizes it to record) routinely runs here;
   *  - a crash with no parseable marker (status 'error'), which the CLI cannot report on its own
   *    behalf — it is dead. This branch is the ONLY reason the routine still holds a recorder.
   */
  const recordedByRun = parsed?.recorded === true;
  const terminalOutcome = classifyQualificationVerdict({ reason: status, green: parsed?.green });
  const terminalKind = terminalOutcome.kind === 'green' || terminalOutcome.kind === 'red' ||
    terminalOutcome.kind === 'code-inconclusive';
  const reconciliationSettled = terminalReconciliation?.status === 'settled' ||
    terminalReconciliation?.status === 'already-settled';
  const reconciliationRefused = terminalReconciliation?.status === 'retry' ||
    terminalReconciliation?.status === 'stale-attempt' ||
    terminalReconciliation?.status === 'ignored-other-target';
  let fallbackQualification: Awaited<ReturnType<typeof recordStoredQualificationVerdict>> | null = null;
  if (!recordedByRun && !reconciliationSettled && !reconciliationRefused && qualificationAttemptId) {
    // A scope can end before its CLI prints a marker (including launch refusal). Its
    // pre-spawn reservation must not survive as an ownerless, PID-less runner forever.
    fallbackQualification = await recordStoredQualificationVerdict(ctx, {
      attemptId: qualificationAttemptId,
      reason: status,
      green: parsed?.green ?? null,
      ...(candidate ? { candidate } : {}),
      ...(parsed?.repairQueue?.repairHead ? { repairHead: parsed.repairQueue.repairHead } : {}),
      ...(parsed?.runId ?? r.runId ? { runId: parsed?.runId ?? r.runId } : {}),
      evidenceRefs: [
        ...(r.runId ? [`checkpoint-run:${r.runId}`] : []),
        ...(r.terminalPath ? [`checkpoint-terminal:${r.terminalPath}`] : []),
      ],
      terminalEvent: {
        status,
        detail: parsed?.reason
          ? buildCheckpointDetail(parsed, gateFireId)
          : withGateFireId({ runId: r.runId ?? null, code: r.code, stderr: (r.stderr || r.stdout).slice(-300) }),
      },
    });
  }
  const atomicallyRecorded = terminalKind && (reconciliationSettled ||
    fallbackQualification?.status === 'updated' || fallbackQualification?.status === 'terminal');
  if (recordedByRun || atomicallyRecorded) {
    console.log(`${orchestratorStdoutTag()} '${status}' — recorded by the run that produced it (WI-4494)`);
  } else if (!reconciliationRefused && fallbackQualification?.status !== 'conflict' &&
             fallbackQualification?.status !== 'unreadable') {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status,
      detail: parsed?.reason
        ? buildCheckpointDetail(parsed, gateFireId)
        : // No parseable result marker (crash before print / non-zero exit) → 'error'.
          withGateFireId({ code: r.code, stderr: (r.stderr || r.stdout).slice(-300) }),
    });
  }
  // The old CLI can produce a real red without its own awaitable wake. The exact logical
  // terminal transaction may have persisted its event above, so the wake belongs AFTER that
  // commit on both atomic and legacy fallback paths. A replay or stale-attempt conflict must
  // not wake a newer candidate's waiters.
  if (!recordedByRun && !reconciliationRefused && fallbackQualification?.status !== 'conflict' &&
      fallbackQualification?.status !== 'unreadable' &&
      !isPinnedCheckpointVerdict(parsed) && parsed?.green === false && parsed.candidate &&
      (!atomicallyRecorded || fallbackQualification?.status === 'updated')) {
    await emitLegacyRedVerdictEvent(root, parsed);
  }

  // P-004: track the red streak + time-since-last-green across ticks and fire a
  // LOUDER urgent alert when the gate has been HELD too long (the "stuck for a
  // while" signal, distinct from the per-candidate notification). Runs for every
  // verdict so it resets on green; fail-safe.
  // WI-4494: skipped when the run recorded its own verdict — see `recordedByRun` above. A second
  // trackGateStall for ONE verdict would count the same red twice.
  if (!isPinnedCheckpointVerdict(parsed) && !recordedByRun) {
    // EI-13288: thread the parsed run's own retriage verdict through this fallback recorder too
    // (version-skew / crash path) — same as the WI-4494 producer-side path above.
    // EI-20767792192323374: thread `summary` here too. Both abort reasons ('migrations-pending',
    // 'infra-inconclusive') record their cause in `gate_health.inconclusive` and the summary is
    // the ONLY field carrying it — omitting it on this fallback path recorded a detail-less
    // abort, which reads as "aborted, cause unknown" exactly where the reader needs the cause.
    await trackGateStall(
      ctx,
      status,
      candidate,
      failingTests,
      parsed?.from ?? null,
      parsed?.retriage,
      parsed?.summary ?? null,
      undefined,
      // P-009: same threading as the producer-side path — the version-skew fallback must
      // not lose the measurement a modern CLI took.
      {
        runId: parsed?.runId,
        candidateSource: parsed?.candidateSource,
        diagnostic: parsed?.diagnostic,
        selectedAtMs: parsed?.selectedAtMs,
        postSuiteMeasured: parsed?.postSuiteMeasured,
        postSuiteLegs: parsed?.postSuiteLegs,
        testPassReuse: parsed?.testPassReuse,
        roundPhases: parsed?.roundPhases,
        repairQueue: parsed?.repairQueue,
        repairTickLegs: parsed?.repairTickLegs,
      },
    ).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} stall tracking failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  // P-006 (release-pipeline-resilience-2026-06-09): a held gate auto-dispatches a
  // release-fixer agent to diagnose + fix the failing test — the test-failure
  // sibling of git-sync's merge-resolver. Fail-safe + deduped per red-candidate.
  // EI-13723: only for the version-skew fallback (!recordedByRun) — when the run recorded
  // its own verdict, `recordCheckpointVerdict` (called from inside the CLI, above) already
  // ran this exact check. Dispatching here TOO for a recordedByRun verdict would double-fire
  // the dedup'd decision for every routine tick on a modern CLI; gating on !recordedByRun
  // keeps this a pure fallback instead of a race with the producer-side dispatch.
  // EI-22344736163383832: tracking must settle first so the dispatcher can compare its input
  // against the exact persisted snapshot rather than racing an unrecorded legacy fallback.
  if (
    !isPinnedCheckpointVerdict(parsed) &&
    !recordedByRun &&
    !parsed?.repairQueue &&
    shouldDispatchReleaseFixer(status, candidate, failingTests, parsed?.retriage)
  ) {
    await dispatchReleaseFixer(ctx, candidate as string, failingTests).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  // P-009: per-workspace flake history — tally workspaces the gate marked as a
  // PROVEN flake (failed then passed on retry) and notify when one is chronically
  // flaky so it gets quarantined accountably. Fail-safe.
  // load-flake-isolation-2026-06-23: ALSO tally the per-FILE flakes the new isolation
  // pass absorbed (red under load, green in isolation) — proven flakes keyed by
  // `<ws>::<file>`, finer-grained than the workspace-retry markers, so a chronically
  // load-flaky FILE trips the same quarantine nudge.
  if (!isPinnedCheckpointVerdict(parsed)) {
    await trackFlakeHistory(ctx, summary, flakeSuspects).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} flake history failed: ${e instanceof Error ? e.message : e}`),
    );
  }
});

/** P-004 thresholds: a gate held this many consecutive hourly checkpoints — or
 *  with no green for this long — is STALLED and worth an urgent, one-shot alert. */
// P-016: STALL thresholds are runtime-settable — see releaseCheckpointConfig() (release:checkpoint-config).

// P-003 (git-sync-dx-hardening): a stalled gate gets a DURABLE escalation row
// (every other pipeline failure has one) — its own phase so it never clobbers
// the git-sync conflict/error rows.
const GATE_STALL_PHASE = 'green-checkpoint-stall';
const GATE_STALL_KIND = 'green-checkpoint-stall';

/**
 * P-003: reuse the frozen queue's existing "a fixer should have materialized by now" floor.
 * A 15-minute policy observed only on the hourly gate cadence alarms on the next tick, while
 * still excluding the normal launch/reservation window. One threshold, not a second setting.
 */
export const FIXER_SUCCESSION_STALL_MS = FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;

export interface FrozenRepairFixerSuccession {
  /** Attempt-scoped identity; a replacement fixer starts a fresh ladder series. */
  key: string;
  state: 'dead' | 'absent';
  ageMs: number;
  spawnId: string | null;
  candidate: string;
  repairHead: string;
  attempts: number;
}

/**
 * Pure qualification for the fixer-succession ladder axis.
 *
 * Only an `awaiting-fixer` queue can qualify. A live fixer is progress; unknown liveness fails
 * closed against a false death alarm; an active dispatch reservation is a real owner during
 * the launch handoff. The remaining two shapes are actionable: a recorded spawn is confirmed
 * dead, or no spawn exists after the reservation window. `fixerStateChangedAtMs` is the
 * canonical fixer-succession transition timestamp and is part of the key, so bookkeeping on the
 * generic queue row cannot reset an attempt's first rung while repeated observations of the SAME
 * gap remain geometrically sparse. Legacy rows fall back to `updatedAtMs`.
 */
export function classifyFrozenRepairFixerSuccession(
  queue: FrozenCandidateRepairQueue | null,
  fixerAlive: boolean | null | undefined,
  nowMs: number,
): FrozenRepairFixerSuccession | null {
  if (!queue || queue.phase !== 'awaiting-fixer') return null;
  if (queue.dispatchReservation && queue.dispatchReservation.expiresAtMs > nowMs) return null;

  let state: FrozenRepairFixerSuccession['state'];
  if (queue.fixerSpawnId) {
    if (fixerAlive !== false) return null;
    state = 'dead';
  } else {
    state = 'absent';
  }

  const spawnId = queue.fixerSpawnId ?? null;
  const stateChangedAtMs =
    typeof queue.fixerStateChangedAtMs === 'number' &&
    Number.isFinite(queue.fixerStateChangedAtMs) &&
    queue.fixerStateChangedAtMs >= 0 &&
    queue.fixerStateChangedAtMs <= queue.updatedAtMs
      ? queue.fixerStateChangedAtMs
      : queue.updatedAtMs;
  // A reservation is intentionally invisible while active. Once it expires, an absent fixer
  // becomes actionable only after the handoff window; using the expiry as the lower bound keeps
  // a long-lived launch lease from generating an immediate stale alarm.
  const successionStartedAtMs =
    queue.dispatchReservation && queue.dispatchReservation.expiresAtMs <= nowMs
      ? Math.max(stateChangedAtMs, queue.dispatchReservation.expiresAtMs)
      : stateChangedAtMs;
  return {
    key: [
      queue.candidate,
      queue.repairHead,
      String(queue.attempts),
      String(successionStartedAtMs),
      spawnId ?? 'absent',
    ].join(':'),
    state,
    ageMs: Math.max(0, nowMs - successionStartedAtMs),
    spawnId,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    attempts: queue.attempts,
  };
}

/** Pure: the `harness_escalations` body for a green-checkpoint stall (testable). */
export function gateStallEscalationBody(opts: {
  installSlug: string;
  consecutiveReds: number;
  heldHrs: number | null;
  candidate?: string | null;
  failingTests?: string[];
  nowMs: number;
  /** EI-18672078222841101: WHO already owns this red, from the `last_fixer` record the
   *  dispatcher keys its own dedup on. Without it this escalation is a broadcast with no
   *  ownership field, and every recipient's individually-correct "a red gate blocking my
   *  work is mine to green" produces N parallel diagnoses of one single-owner question
   *  (observed: 3 agents, same leg, inside 15 minutes). Optional so an unwired/legacy
   *  caller still renders exactly as before. */
  ownership?: GateRedOwnership;
  /** WI-42118 (D-022(d)): the CROSS-STREAK cause digest. Everything else in this body is a
   *  snapshot of the alerting tick, so nothing here could say whether the failing set is one
   *  unfixed break or churn — the most decision-relevant fact about a long streak. Optional
   *  so an unwired/legacy caller still renders exactly as before. */
  causeDigest?: StreakCauseDigest | null;
}): string {
  const tests = (opts.failingTests ?? []).slice(0, 20);
  return JSON.stringify({
    kind: GATE_STALL_KIND,
    harness_slug: opts.installSlug,
    consecutiveReds: opts.consecutiveReds,
    heldHrs: opts.heldHrs,
    candidate: opts.candidate ? opts.candidate.slice(0, 12) : null,
    failingTests: tests,
    emitted_at: opts.nowMs,
    cause: opts.causeDigest
      ? {
          stability: opts.causeDigest.stability,
          persistent: opts.causeDigest.persistent,
          intermittent: opts.causeDigest.intermittent.slice(0, 20),
          redTicks: opts.causeDigest.redTicks,
          namingTicks: opts.causeDigest.namingTicks,
          silentRedTicks: opts.causeDigest.silentRedTicks,
          spanMs: opts.causeDigest.spanMs,
          // The counts above are FLOORS when this is set — see StreakCauseDigest.
          truncatedByLimit: opts.causeDigest.truncatedByLimit,
        }
      : null,
    ownership: opts.ownership
      ? {
          state: opts.ownership.state,
          covered: opts.ownership.covered,
          spawnId: opts.ownership.spawnId,
          ownerSignature: opts.ownership.ownerSignature,
        }
      : null,
    detail: `green-checkpoint has held main for ${opts.consecutiveReds} checkpoint(s)${
      opts.heldHrs != null ? ` (~${opts.heldHrs}h since the last green)` : ''
    }; staging changes are NOT reaching the release.${
      tests.length
        ? ` Failing: ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}.`
        : ''
    }${opts.ownership ? ` ${opts.ownership.label}` : ''}${opts.causeDigest ? ` ${opts.causeDigest.line}` : ''}`,
  });
}

/**
 * WI-42118 (ruling green-main-fast-2026-08-25 D-022(d)): the DB half of the cross-streak
 * cause digest — see `streak-cause-digest.ts` for the pure decision half and why this
 * DERIVES from the append-only event log instead of growing `gate_health` a history field.
 *
 * ⚠ ONE KNOWN BLIND SPOT, and it fails in the safe direction. `classifyGateStallStatus`
 * routes a proven-stale candidate to `'record-only'` — a tick that judged nothing current —
 * but that verdict comes from the RETRIAGE record, which `buildCheckpointDetail` does not
 * persist onto the event. So from the log alone such a tick is indistinguishable from a
 * real red and is counted as one. Its named files passed at tip, so including it can only
 * ADD names to the intermittent bucket and SHRINK the persistent core: the digest can
 * therefore understate stability ('stable' → 'mixed'), never manufacture a false 'stable'.
 * Persisting the class on the event would close it — filed rather than smuggled in here.
 *
 * Fail-safe: any read error yields `null` and the bodies render exactly as they did before.
 */
async function readStreakCauseDigest(
  sql: postgres.Sql,
  installSlug: string,
  workspaceId: string,
  streakStartMs: number | null,
): Promise<StreakCauseDigest | null> {
  try {
    // Bound the window on BOTH axes: from the streak's own start (falling back to a week for
    // a blob with no `firstRedAt`/`lastGreenAt`), and a hard row cap so a pathological streak
    // cannot pull an unbounded page into an alarm path.
    const sinceMs = streakStartMs ?? Date.now() - 7 * 24 * 3_600_000;
    const ROW_CAP = 80;
    const rows = (await sql.unsafe(
      `SELECT status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = $1 AND install_slug = $2 AND kind = 'green_checkpoint'
          AND created_at >= $3
        ORDER BY created_at DESC LIMIT ${ROW_CAP}`,
      [workspaceId, installSlug, new Date(sinceMs).toISOString()],
    )) as Array<{ status: string | null; detail: unknown; created_at: string | Date }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const ticks: StreakTick[] = rows.map((row) => {
      const detail = (typeof row.detail === 'string' ? safeJson(row.detail) : (row.detail ?? {})) as Record<
        string,
        unknown
      >;
      const failing = Array.isArray(detail.failingTests)
        ? detail.failingTests.filter((t): t is string => typeof t === 'string')
        : [];
      return {
        atMs: new Date(row.created_at).getTime(),
        // The SAME classifier the streak counter uses, so the digest's notion of "a red"
        // cannot drift from `consecutiveReds`'. `pinMoved: false` because a moved pin is a
        // property of the LIVE tick, not of a historical row.
        verdictBearing: classifyGateStallStatus(String(row.status ?? ''), false) === 'red',
        failingTests: failing,
      };
    });
    // A full page means older ticks exist beyond it, so every count the digest renders is a
    // FLOOR. Saying so on the aggregate is the repo rule: a bounded measurement rendered as a
    // confident total is indistinguishable from a real one.
    return summarizeStreakCause(ticks, rows.length >= ROW_CAP);
  } catch {
    return null;
  }
}

/**
 * PURE (P-005): the fleet broadcast that OPENS the `gate-red-streak:<harness>`
 * condition — the thing that gives a red gate exactly one ownable work-item.
 *
 * ── WHY THIS RIDES THE EXISTING EDGE RATHER THAN A NEW DETECTOR ────────────────
 * The state machine this needs already exists, immediately below: `consecutiveReds`
 * increments per red tick, `stallAlerted` makes this CONDITION one-shot per episode, and
 * the green branch resets both. A second detector (the obvious build — sweep
 * `gate_health` from the watchdog) would be a SECOND answer to a question the first
 * already answers, and the two would disagree the first time either threshold moved.
 * So the condition is emitted at the exact edge that already fires the urgent alert,
 * and resolved at the exact edge that already clears the escalation.
 *
 * ⚠ THE OPEN EDGE IS EITHER AXIS — red COUNT or stall AGE — NOT the count alone; the
 * name says "red-streak" because the count is the dominant trigger. Both axes are
 * evaluated ONLY inside the red branch, so both mean "the gate is red and stuck";
 * binding to the existing one-shot flag is what keeps open and close symmetric.
 * Splitting the count out would need a SECOND dedup flag and would double-alarm on
 * the overlap.
 *
 * ⚠ WI-42116 SPLIT THE CADENCES, NOT THE EDGE. `decideStallNotification` now re-raises
 * the HUMAN notification at geometric rungs on either axis, but THIS broadcast still
 * fires exactly once per episode, gated on the pre-tick `stallAlerted`. Keep it that way:
 * `oneShot: true` below plus a repeat open would mint a second owning work-item for one
 * stall, and the resolve edge (which reads `gh.stallAlerted` on the green tick) would no
 * longer be symmetric with it.
 *
 * The body names the sibling `green-stall:` condition on purpose: past 12h with no
 * green BOTH are open and one gate carries two owning work-items (see
 * {@link gateRedStreakConditionKey} for why that is accepted rather than suppressed).
 * A claimant who learns it here does not have to re-derive it.
 */
export function gateRedStreakBroadcast(opts: {
  installSlug: string;
  consecutiveReds: number;
  heldHrs: number | null;
  candidate?: string | null;
  failingTests?: string[];
  ownership?: GateRedOwnership;
  /** `staleness.commitsBehindTip` — how far the judged candidate trails staging. */
  commitsBehindTip?: number | null;
}): { summary: string; body: string } {
  const tests = (opts.failingTests ?? []).slice(0, 20);
  const held = opts.heldHrs != null ? ` (~${opts.heldHrs}h since the last green)` : '';
  return {
    summary:
      `green-checkpoint RED on ${opts.installSlug} — ${opts.consecutiveReds} consecutive red checkpoint(s)${held}; ` +
      `\`main\` is frozen and staging changes are NOT reaching the release.`,
    body:
      `The release gate is FIRING but every verdict is red${
        opts.candidate ? `; the last judged candidate was ${opts.candidate.slice(0, 12)}` : ''
      }.${
        tests.length
          ? ` Failing: ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}.`
          : ''
      }${opts.ownership ? ` ${opts.ownership.label}` : ''}${
        opts.commitsBehindTip != null && opts.commitsBehindTip > 0
          ? ` NOTE: that candidate is ${opts.commitsBehindTip} commit(s) behind staging — on this tree the ` +
            `fix is very often already committed, so confirm a named failure still reproduces AT TIP ` +
            `(npm run test:file -- <paths>) before chasing it.`
          : ''
      }\n\nThis condition owns ONE work-item for this red (the condition bridge mints it), so claim ` +
      `that item rather than opening another. Distinct from \`green-stall:${opts.installSlug}\`, which ` +
      `means the gate is not producing verdicts AT ALL — during a long red streak both can be open, and ` +
      `they are the same gate seen two ways.` +
      // P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27): DISCOVERABILITY AT THE
      // MOMENT OF FAILURE. A responder reaching a red gate has to learn two things before touching
      // anything — WHERE the repair is authored, and WHAT may be admitted — and both were previously
      // only in a doc nobody reads mid-incident. Naming them here puts them in front of the claimant
      // at the one moment they are load-bearing, and (via the condition state's `latest_body` fold)
      // on the owning work-item itself.
      `\n\nWHERE TO FIX IT: author the fix in the shared staging checkout like any other edit ` +
      `(D-010: there is NO repair worktree). \`release:repair-queue { op: 'get' }\` reports the exact ` +
      `\`candidate\` and \`repairHead\` for this red; \`git show <repairHead>:<path>\` is the blob you ` +
      `are fixing.` +
      `\n\nWHAT MAY BE ADMITTED (path-exact): \`release:repair-queue { op: 'admit', paths: [...] }\` — ` +
      `dry-run first (it returns the blobs and the diff-tree proof), then \`confirm: true\`. The ` +
      `admission commits ONLY the named paths' current staging blobs onto \`repairHead\` (P-001: the ` +
      `diff-tree must equal the allowlist, a stray file is refused) and the gate re-verifies every ` +
      `failing leg AT that new head. Nothing else reaches the judged lineage: an un-admitted edit is ` +
      `invisible to the gate, and no path ever re-cuts the candidate from tip. Full rule: ` +
      `/internal/docs/agent-insights/frozen-candidate-fix-only-admission.`,
  };
}

/** Pure classification of a green-checkpoint tick's outcome for gate_health tracking.
 *  Exported for unit testing (EI-2615). */
/**
 * 'record-only' (WI-39450) is deliberately NOT 'noop'. 'noop' means "leave gate_health entirely
 * untouched", which is right for a tick that never judged anything — but a superseded pass DID
 * run a full suite, and EI-13288 persists its `retriageClassification` (and suppresses the
 * stale-cap pair) on purpose. Routing it to 'noop' would silently delete that diagnostic. So
 * 'record-only' writes every field exactly as a red does, and changes ONE thing: it does not
 * advance the streak.
 */
export type GateStallClass = 'reset' | 'noop' | 'red' | 'record-only' | 'no-verdict';

/**
 * Classify a tick's `status` (+ whether the release pin moved since the last
 * observation) into how `trackGateStall` should treat `gate_health`:
 *   - 'reset': a real green verdict (or hard evidence `main` is advancing via
 *     `pinMoved`) — clear the red streak.
 *   - 'noop': `status === 'skipped-locked'` (EI-2615). Contention with an ACTIVE
 *     peer run is not evidence of a red build — it only proves another tick
 *     currently holds the lock, which is EXPECTED whenever ticks legitimately
 *     overlap (an hourly cron firing while a ~55min detached run is still in
 *     flight, or a manual `release:checkpoint-run` started mid-cycle).
 *     Counting it as a red produced exactly the EI-2615 symptom: a genuinely
 *     green FF (the OTHER, still-finishing tick) briefly shadowed by a
 *     colliding tick's false-red increment landing its own gate_health write
 *     afterward, leaving `gate.green=false` / a stale `consecutiveReds` for
 *     the gap between the two ticks' writes. The genuine "wedged, not firing"
 *     case `skipped-locked` was ALSO trying to catch is already covered by the
 *     separate `fireStale` signal (last-fire / last-green age,
 *     green-stall-watchdog.ts) — so leave `gate_health` untouched here rather
 *     than double-count healthy contention as a red.
 *   - 'noop': `status === 'migrations-pending'` (EI-18757975681519069) — the
 *     same reasoning one step earlier. The gate ABORTED before judging because
 *     the dev PG is known to be behind the candidate, so this tick produced no
 *     verdict about the code at all; counting a non-verdict as a red is the
 *     identical false-increment bug EI-2615 fixed for lock contention. And it
 *     is covered by a backstop, so "inconclusive" never goes silent — it just
 *     stops being mislabelled as a broken build. EI-19321275470651356 pins down
 *     WHICH backstop, because the obvious guess is wrong and cost a reader an
 *     investigation: it is NOT `fireStale`. `fireStale` keys on `last_fired_at`,
 *     which a noop tick still refreshes (see the WI-4489 note further down), so
 *     it reads FRESH throughout. The real detectors both live in
 *     release/green-stall-watchdog.ts, on a 15-min sweep:
 *       · `checkMainBehindStaging` — >20 commits behind AND >1h AND no advance
 *         in 2h. This is the one that actually fires (verified live on
 *         2026-08-02: a migrations-pending freeze escalated at 04:48Z, ~3.5h in).
 *       · `evaluateGreenStall`'s `verdictStale` — no GREEN verdict in 12h, the
 *         deep backstop. Keyed on `lastGreenAt`, which a noop leaves stale on
 *         purpose — that staleness IS the signal.
 *   - 'noop': `status === 'infra-inconclusive'` (EI-20767792192323374) — the same
 *     reasoning one step LATER. Here the suite DID run; what failed was the gate's
 *     own vite-node module cache, deleted underneath it mid-run by something on the
 *     host. Its ~4,800 failing files are innocent, so the tick is a non-verdict for
 *     the same reason a migrations-pending abort is, and gets the same backstops.
 *   - 'noop': `status === 'deadline-exceeded'` (WI-39841) — the run was SIGTERM'd at
 *     its own suite budget before it could record a verdict. The other two aborts
 *     happen BEFORE judging; this one is killed DURING or AFTER judging and simply
 *     cannot report, which is why it used to arrive here indistinguishable from a
 *     crash: non-zero exit, no parseable marker. The runner now stamps
 *     `RunResult.timedOut` at the timer that does the killing, so the two are told
 *     apart by an OBSERVED fact rather than by the shape of what is missing.
 *     Measured 2026-08-18: the 17:15:04Z run died at its 120m cap and banked red #27
 *     carrying `failingTests:[]` / `observedCandidate:null` — a red naming nothing to
 *     fix, which still drove the held-gate alarm and the release-fixer dispatch. Same
 *     backstops as the two above.
 *   - 'red': every other non-green verdict (not-green / error / create-failed /
 *     not-fast-forward / …) still counts toward the stall streak. 'error' keeps its
 *     place here: after WI-39841 it means a genuine crash or unparseable output, NOT
 *     a deadline-kill.
 */
/** The re-triage fields this module reads. Structural + narrow on purpose: `trackGateStall`'s
 *  own `retriage` param (and the CLI's CheckpointVerdict.retriage) satisfy it without either
 *  side importing the other's shape. */
export type GateStallRetriage = {
  classification?: 'real-red' | 'stale-candidate' | 'unknown' | null;
  autoRefire?: boolean;
  refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
};

/**
 * WI-39450: is this not-green verdict a PROVEN-STALE pass — one whose own re-triage re-ran the
 * failing files at tip and watched them PASS?
 *
 * This is the third instance of the EI-2615 / EI-18757975681519069 bug, and the most expensive:
 * a pass that judged an already-superseded tree is not a statement about the code, but
 * `trackGateStall` counted it anyway. Measured 2026-08-17: a run classified its own candidate
 * `stale-candidate`, stamped `superseded-by-refire`, and still drove consecutiveReds 10 -> 11 —
 * naming 7 `operator-core/lib/agent-tools/memory/*.test.ts` files that had ALL been modified in
 * the 23 commits since that candidate and passed 52/0 at tip. That red sends agents at
 * already-fixed files, which is precisely the harm EI-19405864032365760 documents.
 *
 * ⚠ THE FIRST VERSION OF THIS GUARD ALSO REQUIRED `autoRefire === true`, AND THAT MADE IT DEAD
 * CODE. Rationale then: "the guard is on the SUCCESSOR EXISTING — when the refire is blocked no
 * successor is coming, so this pass is the final word and must still count as a red." Measured
 * against 25 consecutive papercusp runs (2026-08-15..17), `autoRefire` was **false in 18 of 18**
 * runs that re-triaged at all — so the guarded branch never once executed. The run that actually
 * froze `main` (12:36:47Z, candidate 7a040c5c) is the exact shape it missed:
 * `classification=stale-candidate refireBlockedBy=deadline` — the gate PROVED all 4 failing files
 * pass at tip, then banked the red anyway because a second suite would outrun the run budget.
 *
 * The old rationale conflated two independent questions:
 *   · "is a rescue scheduled?"  — `autoRefire` / `refireBlockedBy`. A CLOCK-AND-BUDGET fact.
 *   · "is the code broken?"     — `classification`. An EVIDENCE fact, and the only one the streak
 *                                 is entitled to move on.
 * `stale-candidate` is returned from exactly one branch of `triageRed` (green-checkpoint.ts), the
 * one whose detail reads "N failing file(s) PASS at tip" — it is the strongest negative evidence
 * the gate ever produces. Whether the run then had the *minutes* to act on it changes nothing
 * about the code. So the streak guard keys on the evidence and ignores the schedule.
 *
 * ONE exception is preserved deliberately: `refireBlockedBy === 'charged-budget'` means the SAME
 * breakage survived every rescue attempt, which green-checkpoint.ts:2609-2611 calls out as the
 * loop guard "that must survive: it is what converges a genuinely-broken tip to a held gate and a
 * human". That one still counts as a red. The other three blockers are not evidentiary at all —
 * `deadline` is a clock, `cap-disabled` is a feature switch, and `absolute-ceiling`'s own operator
 * text says "every individual red WAS rescued ... the fix is to slow the tree or widen the window,
 * NOT to debug the files named above".
 *
 * Under-alerting is NOT a new risk here: this leaves `lastGreenAt` stale on purpose, exactly as
 * 'noop' does, so the two backstops documented above still fire — `checkMainBehindStaging`
 * (>20 commits behind, >1h, no advance in 2h) and `evaluateGreenStall`'s 12h `verdictStale`. A
 * frozen `main` escalates on its own; it never needed a miscounted red streak to be noticed.
 *
 * ⚠ Deliberately NOT keyed on the string `superseded-by-refire`: that is only a LOG trailer
 * (`green-checkpoint.ts` `stampPromotion`) and never reaches this function — the recorded
 * reason is a plain `not-green`.
 */
export function isProvenStaleCandidate(retriage?: GateStallRetriage | null): boolean {
  return retriage?.classification === 'stale-candidate' && retriage.refireBlockedBy !== 'charged-budget';
}

/** The announcement a torn sweep produces. Shaped like the other emitters here: one
 *  global key plus one install-scoped key, sharing a payload. */
export type TornSweepAnnouncement = {
  readonly keys: readonly string[];
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/**
 * Plan gate-resilience-vs-torn-git-sync-sweeps..., P-003 (final clause), D-002.
 *
 * WHY THIS EXISTS. The streak-carry above is the CORRECTION for a torn sweep — it stops a
 * pass that judged an already-superseded tree from advancing `consecutiveReds`. But a
 * correction is not a REPORT: today the phenomenon is absorbed perfectly and announced
 * nowhere. `consecutiveReds` deliberately does not move, no alarm escalates, and the only
 * trace is a log line nobody is subscribed to — so "how often does git-sync tear a sweep,
 * and which files does it strand?" is unanswerable without reading gate logs by hand. That
 * is the gap this closes: the streak stays flat AND the event is observable.
 *
 * NOT reusable from the existing red emitters. `emitLegacyRedVerdictEvent` fires on EVERY
 * not-green verdict, so a subscriber cannot tell a record-only tick from a real red, and its
 * payload carries no tip — hence no sha RANGE, which is precisely the field that makes a torn
 * sweep diagnosable (it names the window in which the fix landed).
 *
 * Pure + exported so it has a DB-free regression test, matching the convention
 * `shouldWarnOnStallClearMiss` / `classifyGateStallStatus` / `gateStallRecordOnlyLogMessage`
 * already set in this file.
 *
 * Returns null when this is not a torn sweep, so the caller never has to re-derive the
 * predicate. A MIXED red — some files healed at tip, at least one still failing — is BY
 * SPECIFICATION a real red (D-002) and is not announced here: it never reaches
 * `classification: 'stale-candidate'` at all.
 */
export function buildTornSweepAnnouncement(input: {
  installSlug: string;
  candidate?: string | null;
  failingTests?: readonly string[] | null;
  retriage?: { classification?: 'real-red' | 'stale-candidate' | 'unknown' | null; tip?: string | null } | null;
  runId?: string | null;
}): TornSweepAnnouncement | null {
  if (input.retriage?.classification !== 'stale-candidate') return null;

  const candidate = input.candidate ?? null;
  const tip = input.retriage?.tip ?? null;
  const files = (input.failingTests ?? []).filter((f) => typeof f === 'string' && f.length > 0);
  // The range is the diagnostic payload: it bounds where the healing commit landed. When
  // either end is missing it is reported as null rather than as a half-range, so a reader
  // cannot mistake an unknown bound for a measured one.
  const shaRange = candidate && tip ? `${candidate.slice(0, 12)}..${tip.slice(0, 12)}` : null;

  const named = files.length > 0 ? files.slice(0, 3).join(', ') : 'no named files';
  const more = files.length > 3 ? `, +${files.length - 3} more` : '';
  const summary =
    `[${input.installSlug}] green-checkpoint TORN SWEEP — ${files.length} failing file(s) judged at ` +
    `${candidate ? candidate.slice(0, 8) : 'an unknown candidate'} PASS at tip ` +
    `${tip ? tip.slice(0, 8) : '(tip unknown)'}${shaRange ? ` (healed within ${shaRange})` : ''}: ` +
    `${named}${more}. The red streak was NOT advanced — this pass judged an already-superseded ` +
    `tree, so do not fix the files it named without re-verifying at tip.`;

  return {
    keys: ['green-checkpoint:torn-sweep', `green-checkpoint:torn-sweep:${input.installSlug}`],
    summary,
    payload: {
      installSlug: input.installSlug,
      candidate,
      tip,
      shaRange,
      failingTests: files,
      fileCount: files.length,
      classification: 'stale-candidate',
      streakAdvanced: false,
      runId: input.runId ?? null,
    },
  };
}

/** Emit the torn-sweep announcement. Never throws: a failed announcement must not take down
 *  the gate tick that produced it — the streak-carry is the correctness-bearing half and has
 *  already been applied by the time this runs. */
async function emitTornSweepEvent(announcement: TornSweepAnnouncement): Promise<void> {
  try {
    for (const key of announcement.keys) {
      await emitAwaitedEvent({
        key,
        summary: announcement.summary,
        payload: announcement.payload,
        source: 'green-checkpoint',
      });
    }
  } catch (e) {
    console.warn(`${orchestratorStdoutTag()} torn-sweep emit failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * WI-39841 (Defect 2) — the status for a run that produced NO parseable result marker.
 *
 * Both inputs to this decision arrive looking identical downstream (non-zero exit, no marker),
 * so the discriminator has to be carried from the one place that observes it first-hand: the
 * runner's deadline timer, which stamps `RunResult.timedOut` at the moment it SIGTERMs the
 * group. This is deliberately NOT inferred from empty `failingTests`/`candidate` — a genuine
 * red can be sparse, and reading absence as a cause is how the two got conflated originally.
 *
 * ⚠ This is only the FALLBACK. A run that printed its verdict and was then killed keeps that
 * verdict: the caller overwrites `status` from `parsed.reason` whenever a marker parsed. So a
 * 'deadline-exceeded' status means "killed AND never reported", which is exactly the tick that
 * establishes nothing about the code.
 */
export function checkpointFallbackStatus(
  timedOut: boolean | undefined,
  exitCode?: number,
  signal?: NodeJS.Signals | null,
  terminal?: Pick<ScheduledCheckpointTerminalRecord, 'killed' | 'memoryEvents'> | null,
): 'deadline-exceeded' | 'cancelled' | 'infra-inconclusive' | 'error' {
  if (timedOut) return 'deadline-exceeded';
  if (terminal?.killed && checkpointTerminalHasOomKill(terminal)) return 'infra-inconclusive';
  // EI-21103236147949832: stopping a systemd transient scope makes the systemd-run
  // wrapper exit 143; a directly-spawned child reports SIGTERM. Neither produced a
  // suite verdict, so classifying either as a crash creates a false red and preserves
  // the previous run's failing-test signature. The runner's own deadline wins above.
  if (exitCode === 143 || signal === 'SIGTERM') return 'cancelled';
  // EI-22642378999251872: exit 137 alone says only SIGKILL. The wrapper-owned cgroup
  // counters are the direct evidence that distinguishes an OOM kill from an external kill;
  // never infer OOM from the exit code. Both are non-verdicts, but only the measured OOM gets
  // the infrastructure classification and its evidence in gate_health.inconclusive.detail.
  if (exitCode === 137 || signal === 'SIGKILL') {
    return terminal && checkpointTerminalHasOomKill(terminal) ? 'infra-inconclusive' : 'cancelled';
  }
  if (terminal?.killed) return 'cancelled';
  return 'error';
}

export function classifyGateStallStatus(
  status: string,
  pinMoved: boolean,
  retriage?: GateStallRetriage | null,
): GateStallClass {
  const isGreen = status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix';
  if (isGreen || pinMoved) return 'reset';
  // EI-20767792192323374: 'infra-inconclusive' joins the same class for the same reason one
  // step LATER in the run — the suite executed, but the gate's own vite-node module cache was
  // deleted underneath it, so its failures are a HOST fault and not a verdict about the code
  // (measured 2026-08-18: 4,789 of 5,505 files failed on candidate 1c64cd9f, and red #20 went
  // on the streak that freezes `main`). Same backstops as 'migrations-pending' — this leaves
  // `lastGreenAt` stale on purpose, so checkMainBehindStaging and evaluateGreenStall's 12h
  // `verdictStale` still escalate a frozen `main`; only the mislabelling stops.
  // WI-39841 (Defect 2): 'deadline-exceeded' — the run was SIGTERM'd at its own suite budget
  // before it could record a verdict. Same class, arrived at from the opposite end: the other
  // two abort BEFORE judging, this one is killed DURING/AFTER judging but cannot report. Either
  // way the tick establishes nothing about the code, and the streak may only move on evidence.
  // Measured 2026-08-18: the 17:15:04Z run died at its 120m cap and banked red #27 carrying
  // `failingTests:[]` and `observedCandidate:null` — a red that names nothing to fix, which
  // then drives the held-gate alarm and the release-fixer dispatch.
  // Same backstops as the other two, and they are what make this safe rather than quieter:
  // this leaves `lastGreenAt` stale ON PURPOSE, so checkMainBehindStaging (>20 behind, >1h, no
  // advance in 2h) and evaluateGreenStall's 12h `verdictStale` still escalate a frozen `main`.
  // A gate that keeps dying at its deadline therefore still reaches a human — as an abort that
  // names its own cause, instead of as a broken-build report naming nobody.
  if (
    status === 'skipped-locked' ||
    status === 'migrations-pending' ||
    status === 'infra-inconclusive' ||
    status === 'deadline-exceeded' ||
    status === 'cancelled' ||
    status === 'repair-in-progress' ||
    status === 'repair-staging-mismatch' ||
    // WI-42350: the run DECLINED to re-judge a sha that already reached a red
    // verdict on a byte-identical tree. The producer says so in as many words
    // ("This is NOT a new red: it is the same one") and returns `green: null`
    // rather than `false` precisely so it cannot inflate consecutiveReds.
    // 'noop', not 'no-verdict': the gate is not WEDGED — it judged this sha
    // already, banked that red, and is correctly refusing redundant work. It
    // self-clears the moment the tree moves. Without this line the reason falls
    // through to the trailing `return 'red'` and fabricates a second red naming
    // no failing test — the exact drift that froze main for 6 days as
    // 'candidate-fossil', and twice before as 'error' / 'dependency-prewarm-missing'.
    status === 'unchanged-since-verdict'
  )
    return 'noop';
  // EI-22642378999251872: a standing headroom breach does not self-clear by merely waiting for
  // another hourly fire. Count it as WEDGED (never as a code red) so repeated aborts trigger the
  // existing consecutiveNoVerdict escalation while preserving the prior real verdict.
  if (status === 'disk-headroom') return 'no-verdict';
  // WI-10002039: 'promotion-unauthorized' — the suite verdict was reached, then the promotion push
  // was refused as UNAUTHORIZED (HTTP 401/403). It joins 'disk-headroom' on the SAME reasoning
  // stated directly above: a standing breach that does not self-clear by waiting for another fire
  // must keep COUNTING, so repeated aborts still reach the consecutiveNoVerdict escalation.
  //
  // The point of the new status is the NAME and the LEVER, never the volume. It previously landed
  // here as 'error', which is also 'no-verdict' — so loudness is deliberately UNCHANGED by this
  // line, and nothing downstream gets quieter. What changes is that gate-abort-status can now
  // classify it 'standing-condition' instead of inheriting 'error's 'transient' lever, which told
  // readers a permanent 403 did not block a re-fire.
  //
  // ⚠ This line is load-bearing in the other direction too: a reason ABSENT from this function
  // falls through to the trailing `return 'red'` and banks a code red carrying NO failing test —
  // the contentless red that drives the held-gate alarm and dispatches a release-fixer at a
  // phantom file list. Removing it does not make the gate quieter; it makes it LIE.
  if (status === 'promotion-unauthorized') return 'no-verdict';
  /**
   * EI-21462211894072863 — 'error' is a NON-VERDICT that must still be COUNTED, which is why it
   * gets its own class instead of joining either neighbour.
   *
   * `status === 'error'` means exactly one thing: the run published no parseable result marker,
   * and it was neither killed by its own deadline nor SIGTERMed externally (those are
   * 'deadline-exceeded' / 'cancelled', decided first in `checkpointFallbackStatus`). So it
   * established NOTHING about the code — yet until now it fell through to 'red' and drove the
   * streak that freezes `main` and dispatches release-fixers.
   *
   * Measured 2026-08-25 on papercusp: scheduled run 8104 exited exitCode=1 with no marker, and
   * `consecutiveReds` climbed to 42 over a history never actually judged — the last REAL verdict
   * predated the last fire by 5.7h. Every read surface reported "the gate is RED (42 consecutive)"
   * with a failing-test list no run had named, so the gate presented as merely-red when it was
   * WEDGED. That misreading is what cost the fleet hours of deploy time.
   *
   * ⚠ DO NOT "simplify" this into the 'noop' class — that regression is explicitly guarded
   * (WI-39841's control test), and rightly: 'error' is the UNKNOWN-cause bucket, so silencing it
   * is how a genuinely crashing gate freezes `main` with nobody told. The distinction that
   * matters is not counted-vs-uncounted, it is WHICH counter: a verdict-less tick advances
   * `consecutiveNoVerdict` (and escalates on the same threshold, saying WEDGED) while leaving
   * `consecutiveReds` — a count of actual code verdicts — alone. Loud, and true.
   */
  if (status === 'error') return 'no-verdict';
  /**
   * P-007 — the same 'no-verdict' class as 'error', for the same load-bearing reason: the gate
   * refused BEFORE running a test (no prewarmed dependency generation for the candidate's input
   * fingerprint), so it established nothing about the code and must not touch `consecutiveReds`.
   *
   * ⚠ This line is not optional bookkeeping. `classifyGateStallStatus` ends in `return 'red'`, so
   * WITHOUT it a typed prerequisite outage falls through to the default and fabricates a code red
   * — strictly worse than the untyped crash it replaced. Producer vocabulary and consumer class
   * list must land together; that drift is what EI-21465187777146773 exists to guard.
   *
   * It stays COUNTED (no-verdict, not noop) on purpose: unlike the self-clearing infra aborts,
   * a missing prewarm persists until the producer publishes, so silencing it would let the gate
   * render nothing indefinitely with gate_health untouched.
   */
  if (status === 'dependency-prewarm-missing') return 'no-verdict';
  // P-006: same class, same reasoning — the sibling exit-74 condition where the selected
  // generation exists but is unusable. Both must be mapped here or they hit the 'red' default.
  if (status === 'dependency-generation-unusable') return 'no-verdict';
  /**
   * WI-42207 — 'candidate-fossil' is a WITHHELD verdict, so it is 'no-verdict', never a red.
   *
   * The producer refuses to publish a red whose candidate was already older than
   * CANDIDATE_FOSSIL_AGE_MS at verdict time: "No failing-test signature was published; the next
   * run must re-judge a fresh tip." By construction it establishes NOTHING about the code — the
   * suite's own opinion was discarded as describing a tree that no longer exists.
   *
   * This word never reached this list, so it hit the `return 'red'` default below and FABRICATED
   * a code red — precisely the drift the P-006 comment above warns about ("producer vocabulary and
   * consumer class list must land together"), and precisely the failure the 'error' comment
   * measured on 2026-08-25, one reason-code earlier.
   *
   * Measured 2026-08-26 on papercusp: `consecutiveReds` reached 44 and `main` sat frozen 6 days at
   * a2d69cef, while `gate_health.failingTests` stayed `[]` the entire time because no run ever
   * published a signature. Every read surface therefore reported "RED, 44 consecutive" with a
   * failing-test list no run had named. Multiple agents — including this one, twice — read that
   * empty list as "no tests are failing" and went hunting for phantom test breakage. The gate was
   * not red. It was WEDGED, and it had no vocabulary to say so.
   *
   * 'no-verdict' rather than 'noop' for the same reason as 'error': this condition is NOT
   * self-clearing (the frozen pin resumes the same sha until something releases it), so it must
   * stay COUNTED. It advances `consecutiveNoVerdict` — which escalates on the same threshold
   * saying WEDGED — while leaving `consecutiveReds`, a count of actual code verdicts, alone.
   * Loud, and true.
   */
  if (status === 'candidate-fossil') return 'no-verdict';
  // WI-39450: a pass whose own re-triage watched the failing files PASS at tip produced no
  // verdict about the code — see isProvenStaleCandidate. Its diagnostics are still written
  // (EI-13288); only the streak is left alone.
  if (isProvenStaleCandidate(retriage)) return 'record-only';
  return 'red';
}

/**
 * WI-2825 (harden trackGateStall's silent no-op): should the durable
 * harness_escalations clear be treated as a suspicious miss worth a loud warning?
 * Pure decision, exported for unit testing without a DB — `trackGateStall` (below)
 * supplies the two live inputs: `stallAlerted` (gate_health believed an escalation
 * was fired) and the actual row count the clear UPDATE matched.
 *
 * Only true when a row WAS expected (stallAlerted) and NONE matched — an everyday
 * "nothing to clear" reset (no prior escalation, stallAlerted false) must stay
 * silent, exactly as before this change.
 */
export function shouldWarnOnStallClearMiss(stallAlerted: boolean, clearedCount: number): boolean {
  return stallAlerted && clearedCount === 0;
}

/**
 * EI-20854484804457933: fold a newly-computed gate_health value over the value read from the
 * same routine row without losing a more-informative failing-test set. A later observation that
 * did not produce a fresh verdict is allowed to update its other diagnostics, but an empty list
 * from that observation is not evidence that the previously recorded failures disappeared.
 *
 * The final SQL write repeats this rule against the row's value at UPDATE time, because another
 * trackGateStall caller can commit between this function's SELECT and UPDATE. Keeping both
 * layers is intentional: this fold handles the ordinary sequential path and the SQL predicate
 * closes the stale read/modify/write race.
 *
 * EI-18832825158594027: preserving the list is right; presenting it as a fresh measurement is
 * not. Once preserved, those names were NOT observed by the tick that produced the verdict a
 * reader is holding, and every downstream surface (`git-pipeline-stats` → `release-deploy-launch`
 * → `release:trace` / `dev:why`) renders `failingTests` as a current, authoritative blame list.
 * That is what sends a fixer at already-green code, and re-firing the gate to "refresh" it is
 * the more expensive follow-on mistake.
 *
 * So stamp the axis rather than drop the data: `failingTestsCarriedForward` says the sibling
 * array is inherited, exactly as `inheritedRepairQueueFailingTestsSource` already labels the
 * OTHER inheritance path in this system. It is deliberately orthogonal to
 * `failingTestsMeasured`, which stays true — those names WERE measured, just not by this tick;
 * conflating "not measured" with "not measured HERE" would destroy real evidence.
 *
 * ⚠ The flag MUST be written on BOTH branches. A carried-forward marker that outlives the
 * carry-forward is the same defect one level up — a stale qualifier on a fresh list — so the
 * non-preserving branch clears it explicitly instead of letting an older `true` ride along.
 */
export function mergeGateHealthMonotonic(
  previous: { failingTests?: unknown; observedCandidate?: unknown } | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const previousFailingTests = Array.isArray(previous?.failingTests)
    ? previous.failingTests.filter((test): test is string => typeof test === 'string')
    : [];
  const nextFailingTests = Array.isArray(next.failingTests)
    ? next.failingTests.filter((test): test is string => typeof test === 'string')
    : [];
  const previousCandidate =
    typeof previous?.observedCandidate === 'string' ? previous.observedCandidate.trim().toLowerCase() : '';
  const nextCandidate = typeof next.observedCandidate === 'string' ? next.observedCandidate.trim().toLowerCase() : '';
  const preservesPreviousFailures =
    previousFailingTests.length > 0 &&
    nextFailingTests.length === 0 &&
    previousCandidate.length > 0 &&
    previousCandidate === nextCandidate &&
    next.lastFromFresh !== true &&
    next.lastVerdict !== 'green';
  return preservesPreviousFailures
    ? { ...next, failingTests: previousFailingTests, failingTestsCarriedForward: true }
    : { ...next, failingTestsCarriedForward: false };
}

/**
 * C4 of EI-22270968007901491 (main-green-status-visible-2026-09-03): `gate_health` is ONE blob
 * with MANY writers, and `trackGateStall` is the only one that used to REPLACE the whole key.
 * Every other writer merges (`gate-health-merge.ts`, `writeFreezeAndConvergeDisposition`, the
 * hold-tick leaf writes), so a key they own survived until the next real verdict — which then
 * dropped it. Measured live 2026-09-03: `freezeAndConverge` (written 19:23Z by the tick's
 * disposition writer) and `repairTickLegs` were both gone from the papercusp row after the
 * 19:25Z verdict write, so the freeze-disposition cell read "no record" while the freeze was
 * held, and the per-leg cell lost its measurement.
 *
 * The EI-7472 answer — hand-carry `watchdogAlerted` through every `next` — does not scale:
 * each new cross-writer key has to know to add itself here, and `freezeAndConverge` is the
 * proof that they do not. So the rule is inverted: a key this writer's `next` does NOT MENTION
 * belongs to someone else and is carried through verbatim. A key this writer wants CLEARED must
 * say so with an explicit `null` (the convention `inconclusive: null` / `repairTickLegs: null`
 * already follow), because clear-by-omission is exactly the behaviour that clobbered peers.
 *
 * Pure and exported so it is falsifiable without a database. The final SQL write applies the
 * same rule against the row's LIVE value (`COALESCE(metadata->'gate_health','{}') || next`), so
 * a peer's merge landing between this function's SELECT and its UPDATE survives too.
 */
export function carryForeignGateHealthKeys(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous || typeof previous !== 'object') return { ...next };
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!(key in next)) carried[key] = value;
  }
  return { ...carried, ...next };
}

/**
 * EI-19321275470651356: the log line `trackGateStall` emits for a `'noop'` tick.
 *
 * `'noop'` covers two conditions whose correct operator response is OPPOSITE, so they
 * must not share one message:
 *   · `skipped-locked`      — a peer run IS in flight and will produce the verdict.
 *                             "wait, this resolves itself" is correct advice.
 *   · `migrations-pending`  — the preflight aborted and NOBODY is coming. Telling that
 *                             reader "an active peer run holds the lock" is factually
 *                             false, and it points them away from the real cause at
 *                             exactly the moment they are asking why `main` is stuck.
 *
 * Pure + exported so the distinction has a DB-free regression test, matching the
 * convention `shouldWarnOnStallClearMiss` / `classifyGateStallStatus` already set here.
 */
/**
 * WI-39450: the log line for a `'record-only'` tick. Its own function because the operator
 * response differs from BOTH noop conditions: no peer run holds a lock, and unlike
 * `migrations-pending` a full suite really did run — it just judged a tree that has already
 * moved. Saying so is the point: that failing-file list is exactly what sends agents at
 * already-fixed tests.
 *
 * ⚠ Do NOT reintroduce "handed off to an auto-refire, which will record the real verdict" here.
 * That was the original wording and it is false in the case that actually dominates: a refire
 * blocked by `deadline` records nothing, and `main` simply stays where it is until the next cron.
 * Promising a successor that never arrives is worse than promising nothing — a reader who
 * believes it waits instead of looking at the gate.
 */
export function gateStallRecordOnlyLogMessage(status: string): string {
  return (
    `${orchestratorStdoutTag()} '${status}' — this pass proved its OWN candidate STALE (its ` +
    `re-triage re-ran the failing files at tip and they PASSED). Diagnostics written, streak NOT ` +
    `advanced: this pass judged an already-superseded tree, so any failing files it named are ` +
    `stale — re-verify at tip before fixing anything. NOTE this run did NOT promote and may not ` +
    `have refired, so \`main\` can stay put with the streak flat; a frozen \`main\` is escalated by ` +
    `checkMainBehindStaging / evaluateGreenStall, not by this counter. See classifyGateStallStatus`
  );
}

type InfraInconclusiveCause = 'dependency-snapshot-drift' | 'pc-heavy-admission' | 'vite-cache-loss' | 'unclassified';

function classifyInfraInconclusiveCause(detail: string | null | undefined): InfraInconclusiveCause {
  const normalized = detail?.toLowerCase() ?? '';
  if (
    normalized.includes('dependency-generation') &&
    (normalized.includes('torn snapshot') || normalized.includes('live node_modules changed'))
  ) {
    return 'dependency-snapshot-drift';
  }
  if (
    normalized.includes('pc-heavy') ||
    normalized.includes('exclusive-all-slots') ||
    (normalized.includes('materializ') && normalized.includes('slot'))
  ) {
    return 'pc-heavy-admission';
  }
  if (
    normalized.includes('vite-node') ||
    normalized.includes('module cache') ||
    normalized.includes('err_module_not_found')
  ) {
    return 'vite-cache-loss';
  }
  return 'unclassified';
}

function oneLineMeasuredDetail(detail: string | null | undefined): string | null {
  const normalized = detail?.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

export function gateStallNoopLogMessage(status: string, detail?: string | null): string {
  if (status === 'disk-headroom') {
    return (
      // EI-23424266636870803: this said "the temp filesystem", which routes a responder
      // into emptying /tmp. The breaching PATH is only where the shortage was sampled —
      // free space belongs to the FILESYSTEM behind it, which other mounts can share
      // (here /tmp, /mnt/data and /var/lib/systemd/coredump are one 7.3 TiB device, of
      // which /tmp holds ~104 GiB). Point at the measured detail, which now names the
      // reserve applied and the absolute byte deficit, instead of naming a directory to
      // go delete.
      `${orchestratorStdoutTag()} 'disk-headroom' — this run ABORTED before checkout setup or tests ` +
      `because a watched filesystem lacked safe byte/inode headroom. Read the measured detail for ` +
      `WHICH filesystem, the reserve applied and the byte deficit — reclaim that deficit anywhere ` +
      `on that filesystem, and check what else is mounted on it before deleting: the path named in ` +
      `the detail is where the shortage was SAMPLED, not necessarily what is consuming the space. ` +
      `It rendered no code verdict, ` +
      `so do not triage the prior red's files and do not re-fire until space is reclaimed. No peer ` +
      `run is in flight. This tick advances gate_health.consecutiveNoVerdict (never the red streak), ` +
      `and repeated aborts escalate as a WEDGED gate rather than masquerading as hourly progress`
    );
  }
  if (status === 'repair-in-progress') {
    return (
      `${orchestratorStdoutTag()} 'repair-in-progress' — the serialized frozen-candidate repair queue ` +
      `owns this candidate and either dispatched or is waiting on its one targeted fixer; this tick ran no ` +
      `suite and rendered no code verdict. Leaving the red-streak counters untouched while recording this ` +
      `hold under gate_health.inconclusive (the queue's bounded attempt/wall-clock policy and the ` +
      `green-stall watchdog remain the progress backstops)`
    );
  }
  if (status === 'repair-staging-mismatch') {
    return (
      `${orchestratorStdoutTag()} 'repair-staging-mismatch' — the frozen repair head is ready, but its exact ` +
      `candidate-to-repair patch is not yet observable on canonical staging; this tick deliberately spent no ` +
      `suite and rendered no code verdict. Leaving the red-streak counters untouched while recording this ` +
      `hold under gate_health.inconclusive (repair reconciliation and the green-stall watchdog remain the ` +
      `progress backstops)`
    );
  }
  // EI-20767792192323374 / EI-21393982931638628: `infra-inconclusive` is an outcome class,
  // not a root cause. It was introduced for a vite-node cache-loss incident, but the same
  // status now also covers pc-heavy admission/materialisation refusal. Narrating the original
  // incident for every member of the class invented a host failure even while the measured
  // summary named four live capacity holders. Derive the operator response from that summary;
  // when it is absent or unfamiliar, stay explicitly unclassified rather than guessing.
  if (status === 'infra-inconclusive') {
    const measuredDetail = oneLineMeasuredDetail(detail);
    const measuredClause = measuredDetail
      ? `Measured detail: ${measuredDetail}. `
      : 'No measured cause detail was supplied; inspect gate_health.inconclusive.detail or the checkpoint log. ';
    const sharedTail =
      `It rendered no verdict about the code IN EITHER DIRECTION, so ⚠ DO NOT TRIAGE a file merely because ` +
      `of this tick; re-verify any prior failing list at the candidate before acting on it. No peer ` +
      `green-checkpoint run is in flight. Leaving gate_health untouched (not a red; a frozen \`main\` is ` +
      `still escalated by checkMainBehindStaging / evaluateGreenStall, not by this counter — see ` +
      `classifyGateStallStatus)`;

    switch (classifyInfraInconclusiveCause(measuredDetail)) {
      case 'dependency-snapshot-drift':
        return (
          `${orchestratorStdoutTag()} 'infra-inconclusive' — live dependency inputs changed while ` +
          `the gate was pinning its immutable dependency snapshot, so the publisher refused the ` +
          `torn generation before any suite verdict. ${measuredClause}` +
          `Wait for the named dependency writer/churn to settle before the next authorized run. ${sharedTail}`
        );
      case 'pc-heavy-admission':
        return (
          `${orchestratorStdoutTag()} 'infra-inconclusive' — the gate could not acquire exclusive pc-heavy ` +
          `capacity and aborted during runner admission/materialisation, before a suite verdict. ${measuredClause}` +
          `Re-fire only after the named heavy-slot holders drain or are recovered. ${sharedTail}`
        );
      case 'vite-cache-loss':
        return (
          `${orchestratorStdoutTag()} 'infra-inconclusive' — the gate's own vite-node module cache disappeared ` +
          `mid-run, so the suite result is a host-infrastructure failure rather than a code verdict. ` +
          `${measuredClause}${sharedTail}`
        );
      case 'unclassified':
      default:
        return (
          `${orchestratorStdoutTag()} 'infra-inconclusive' — an infrastructure failure prevented a code ` +
          `verdict, but its mechanism is unclassified; no vite-cache or capacity cause is inferred. ` +
          `${measuredClause}${sharedTail}`
        );
    }
  }
  if (status === 'cancelled') {
    return (
      `${orchestratorStdoutTag()} 'cancelled' — this run was externally SIGTERMed before it ` +
      `published a result marker. It rendered no code verdict, so the red streak and prior ` +
      `failing-test signature stay untouched; gate_health.inconclusive records the cancellation`
    );
  }
  // EI-21462211894072863: 'error' reaches this message path as the 'no-verdict' class, NOT as a
  // 'noop' — it still COUNTS, just in `consecutiveNoVerdict` rather than `consecutiveReds`. The
  // generic tail below would be actively false here (it asserts a peer run holds the lock), which
  // is the wording that made a wedged gate read as ordinary contention.
  if (status === 'error') {
    return (
      `${orchestratorStdoutTag()} 'error' — this run exited WITHOUT publishing a parseable result ` +
      `marker, and was neither killed at its own deadline nor externally SIGTERMed. It rendered no ` +
      `code verdict IN EITHER DIRECTION, so ⚠ DO NOT triage the files any earlier red named — this ` +
      `tick judged no code at all. The red streak and prior failing-test signature stay untouched; ` +
      `this tick advances gate_health.consecutiveNoVerdict (a WEDGED gate, not a red one) and ` +
      `gate_health.inconclusive records the abort. A gate that keeps exiting this way still ` +
      `escalates on the same threshold a red streak would — see classifyGateStallStatus`
    );
  }
  if (status === 'migrations-pending') {
    return (
      `${orchestratorStdoutTag()} 'migrations-pending' — this run ABORTED at the migration preflight ` +
      `(the dev PG is known to be behind the candidate). NO peer run is in flight and no verdict ` +
      `is coming until the pending migration applies — see the pending migration(s) and their ` +
      `errors named just above. Leaving gate_health untouched (not a red: this tick judged no code ` +
      `at all; the deploy freeze itself is caught by checkMainBehindStaging / the green-stall ` +
      `watchdog, not by this counter — see classifyGateStallStatus)`
    );
  }
  return `${orchestratorStdoutTag()} '${status}' — an active peer run holds the lock; leaving gate_health untouched (not a red, see classifyGateStallStatus)`;
}

/**
 * P-002 (gate-verdict-liveness-and-repair-reliability-2026-08-31): how far forward a recorded
 * TRANSIENT abort pulls the routine's next fire, instead of waiting out the cron hour. 10min is
 * prompt without tight-looping: the run-lock serializes attempts, admission still gates each
 * tick, and a persistently-aborting gate at ~6 attempts/hour is exactly the signal P-003's
 * no-verdict rate alarm pages on. Exported for the trackGateStall requeue test.
 */
export const TRANSIENT_ABORT_REQUEUE_MINS = 10;

/**
 * Pull a scheduled green-checkpoint fire forward after a capacity-shaped skip.
 *
 * The routine claim has already advanced `next_fire_at` to the next cron occurrence by the
 * time the system action runs.  Capacity can clear well before that hour, so leaving the row
 * there turns a safe admission refusal into a silent release stall.  Keep this write shared by
 * transient aborts and memory-budget refusals: the three guards are load-bearing in both paths.
 *
 * - `active = true` keeps a deleted/deactivated routine from being resurrected.
 * - `metadata->'pause' IS NULL` leaves an intentional operator pause to its TTL/resume owner.
 * - the forward-only comparison never delays a fire that another writer already scheduled
 *   sooner (including an explicit near-term retune).
 *
 * Failures are handled by each caller as best-effort; the ordinary cron remains the safe
 * fallback if this prompt requeue cannot be written.
 */
export async function requeueGreenCheckpointAfterCapacity(
  sql: postgres.Sql,
  installSlug: string,
  delayMins: number = TRANSIENT_ABORT_REQUEUE_MINS,
): Promise<void> {
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET next_fire_at = now() + make_interval(mins => $2),
            updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
        AND active = true
        AND metadata->'pause' IS NULL
        AND (next_fire_at IS NULL OR next_fire_at > now() + make_interval(mins => $2))`,
    [installSlug, delayMins],
  );
}

/**
 * P-004: track green-checkpoint gate health in the routine metadata (`gate_health`)
 * and fire ONE urgent stall alert when the red streak / age crosses the threshold
 * (transition-only via `stallAlerted`). The data also surfaces on the Git tab via
 * gitPipelineSnapshot().gate. Fail-safe — the routine tick never depends on it.
 */
// Exported for the EI-7472 regression test (capture the gate_health write and
// assert the watchdog-owned dedup flag survives a red tick / clears on green).
export async function trackGateStall(
  // WI-4494: narrowed from SystemActionCtx to the two fields this actually reads, so the CLI (which
  // has no routine context) can record its own verdict through the same path. A SystemActionCtx
  // still satisfies it structurally — every existing caller is unchanged.
  ctx: GateVerdictTarget,
  status: string,
  candidate?: string,
  failingTests?: string[],
  from?: string | null,
  /** EI-13288: the CLI's own stale-candidate re-triage verdict (see CheckpointVerdict.retriage
   *  above), when the caller has one. */
  retriage?: {
    classification: 'real-red' | 'stale-candidate' | 'unknown';
    tip: string | null;
    detail: string;
    autoRefire?: boolean;
    refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
  },
  /** EI-19405864032365760: the verdict's own prose (`CheckpointVerdict.summary`). Only read on the
   *  `migrations-pending` noop path, where it is the ONLY place the pending migration is named. */
  summary?: string | null,
  /** EI-19329732364513693 test seam — injectable git runner for the candidate-staleness
   *  measurement below. Defaults to the real one; mirrors checkReleaseFixerCandidateStale. */
  gitRunner?: GitCheckRunner,
  options: {
    promotionPending?: boolean;
    green?: boolean | null;
    runId?: string;
    candidateSource?: CheckpointCandidateSource;
    diagnostic?: 'candidate-pinned';
    /** WI-22344736163383832: producer selection timestamp carried into the snapshot. */
    selectedAtMs?: number;
    /** WI-22344736163383832: measured post-suite scope carried into the snapshot. */
    postSuiteMeasured?: boolean;
    postSuiteLegs?: NonNullable<CheckpointVerdict['postSuiteLegs']>;
    /** WI-22344736163383832: the serialized repair state that owns this observation. */
    repairQueue?: FrozenCandidateRepairQueue | null;
    /** P-009: the awaiting-fixer hold tick's cheap-legs measurement (CheckpointVerdict.repairTickLegs).
     *  Present ⇒ this "no-verdict" tick DID measure the non-test legs at repairHead, so the
     *  inconclusive path refreshes instead of stamping failingTestsMeasured:false. */
    repairTickLegs?: NonNullable<CheckpointVerdict['repairTickLegs']>;
    /** P-013: the verdict's per-file reuse record. `unknown` on purpose — it is shape-checked
     *  here, so a malformed or pre-emitter value is dropped instead of stored. */
    testPassReuse?: unknown;
    /** P-013: the round's phase breakdown; shape-checked here like testPassReuse. */
    roundPhases?: unknown;
  } = {},
): Promise<void> {
  if (isPinnedCheckpointVerdict(options)) return;
  // P-016 (D-010): a partial advance ('advanced-prefix') MOVED `main` (the longest green
  // prefix is deployable), so it resets the "main hasn't advanced" stall streak just like
  // a full advance — the red tip is tracked separately via the release-fixer dispatch.
  const promotionPending = options.promotionPending === true;
  const isGreen =
    !promotionPending && (status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix');
  // P-006: every non-green verdict OTHER than 'skipped-locked' counts toward the stall
  // streak. WI-39841 CARVED THE TIMEOUT OUT of that set: a run killed at its own suite budget
  // now arrives as 'deadline-exceeded' (stamped from RunResult.timedOut) and is a 'noop',
  // because it recorded no verdict and its red named no failing file.
  // 'skipped-locked' (a run-lock collision — green-checkpoint-stale-
  // lock-2026-06-26) is handled separately below (EI-2615: `classifyGateStallStatus`
  // treats it as a no-op, not a red — see that function's doc for why).
  //
  // EI-21462211894072863 CARVED OUT 'error' — the crash/no-marker bucket — but into its own
  // 'no-verdict' class rather than into 'noop', because the two claims this comment used to
  // fuse are separable and only one of them was ever true:
  //   · "a persistently crashing gate must stay LOUD, not freeze `main` silently" — TRUE, and
  //     preserved exactly: `consecutiveNoVerdict` counts these ticks and escalates on the SAME
  //     `stallReds` threshold, so nothing goes quiet.
  //   · "…therefore it must count as a RED" — FALSE, and expensive. A tick that published no
  //     result marker judged no code, so calling it a red asserts a broken build on no evidence
  //     and hands the reader a failing-test list some older run named. Measured 2026-08-25:
  //     `consecutiveReds` reached 42 while the last REAL verdict predated the last fire by 5.7h.
  // Only a real verdict — of EITHER colour — resets the no-verdict streak; only a green (or a
  // moved pin) resets the red one.
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // EI-18672078222841101: `last_fixer` rides along in the SAME metadata row we already
  // read — no extra round-trip, and deliberately NOT a new ownership record. P-003 adds the
  // existing `repair_queue` key to that same read: it is the serialized convergence state whose
  // current fixer succession we need to judge, not a parallel detector or ownership row.
  const rows = (await sql.unsafe(
    `SELECT metadata->'gate_health' AS gh,
            metadata->'last_fixer' AS lf,
            metadata->'repair_queue' AS rq
       FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
        AND workspace_id = $2`,
    [ctx.installSlug, ctx.workspaceId],
  )) as Array<{
    gh: {
      consecutiveReds?: number;
      lastGreenAt?: number;
      firstRedAt?: number;
      stallAlerted?: boolean;
      // WI-42116: the escalation LADDER's high-water marks. `stallAlerted` remains the
      // one-shot flag for the CONDITION leg (mint-once, resolve-once); these two are the
      // per-axis marks that let the HUMAN-NOTIFY leg re-fire at a new rung. Absent on a
      // gate_health blob written before this shipped — the ladder seeds them from
      // `stallAlerted` in that case rather than re-alerting for an announced stall.
      stallAlertedAtReds?: number | null;
      stallAlertedAtAgeMs?: number | null;
      /** P-003: high-water mark for the CURRENT fixer-attempt succession gap. */
      stallAlertedAtFixerAgeMs?: number | null;
      /** Attempt identity paired with the mark above; a replacement resets that axis. */
      stallFixerSuccessionKey?: string | null;
      lastFrom?: string;
      lastMainPin?: string | null;
      watchdogAlerted?: boolean;
      pendingRunId?: string | null;
      failingTests?: string[];
      /** True only when a real code verdict measured the sibling failingTests array. */
      failingTestsMeasured?: boolean;
      /** EI-18832825158594027: true when the sibling failingTests array was INHERITED from an
       *  earlier observation of this same candidate rather than observed by the tick that wrote
       *  this verdict. Orthogonal to failingTestsMeasured, which stays true — those names were
       *  measured, just not here. See mergeGateHealthMonotonic. */
      failingTestsCarriedForward?: boolean;
      retriageStaleTip?: string | null;
      retriageDetail?: string | null;
      retriageClassification?: 'real-red' | 'stale-candidate' | 'unknown' | null;
    } | null;
    lf: ReleaseFixerRecord | null;
    rq: unknown;
  }>;
  const gh = rows[0]?.gh ?? {};
  const lastFixer = rows[0]?.lf ?? null;
  const repairQueue = parseFrozenCandidateRepairQueue(rows[0]?.rq);
  const snapshotQueue = options.repairQueue ?? repairQueue ?? undefined;
  const snapshotCandidate = candidate ?? snapshotQueue?.candidate;
  const snapshotFailures =
    options.repairTickLegs?.failingSignatures ?? failingTests ?? snapshotQueue?.failingTests ?? null;
  const repairFixerAlive = repairQueue?.fixerSpawnId
    ? await releaseFixerSpawnAlive(sql, repairQueue.fixerSpawnId).catch(() => null)
    : undefined;
  const fixerLivenessUnknown = repairQueue?.fixerSpawnId != null && repairFixerAlive === null;
  const fixerSuccession = classifyFrozenRepairFixerSuccession(repairQueue, repairFixerAlive, Date.now());
  // Release-pin movement (green-checkpoint-lock-starvation-2026-07-02): `from` is the
  // `main` pin the CLI observed. If it MOVED since the last routine observation, green
  // work landed on `main` through a path this routine never saw — a MANUAL detached run
  // or another lineage's gate (only ROUTINE-invoked runs write pipeline events /
  // gate_health). Without this, an hourly cron that keeps losing the run-lock to a
  // back-to-back manual runner records only 'skipped-locked' reds while `main` is in
  // fact advancing — 21 phantom reds, a false "main frozen ~21h" STALLED page, and a
  // false green-stall-watchdog escalation (it keys on lastGreenAt too). A moved pin is
  // hard evidence the pipeline is flowing, so it resets the streak like a green does.
  const fromPin = from ? from.slice(0, 12) : null;
  // EI-20706962612084953: compare the live pin against where `main` was LEFT by the last
  // routine observation — NOT against the pin that run STARTED from. `lastFrom` is the
  // pre-fast-forward pin by definition, so after any 'advanced' run the next run reads a
  // live pin that differs from it and declares `pinMoved` for the routine's OWN advance.
  // That misclassified the first red after a green as 'reset' — systematically masking
  // the single most important red to surface. `lastFrom` is deliberately NOT repurposed:
  // its "the pin as observed AT verdict time" contract is load-bearing for
  // `evaluateGateVerdictFreshness` Rule 1 ORDERING (gate-verdict-freshness.ts), which
  // needs the pre-FF value. `lastMainPin` records where main ENDED, so only a genuinely
  // EXTERNAL advance (a manual detached run, another lineage's gate — the
  // green-checkpoint-lock-starvation-2026-07-02 case this reset exists for) moves it.
  // The `?? gh.lastFrom` fallback covers a blob written before this field existed: it
  // degrades to exactly the previous behaviour rather than reading a missing pin as
  // "main never moved".
  const lastObservedMainPin = gh.lastMainPin ?? gh.lastFrom ?? null;
  const pinMoved = fromPin != null && lastObservedMainPin != null && fromPin !== lastObservedMainPin;
  const gateClass = promotionPending
    ? options.green === false
      ? 'red'
      : 'record-only'
    : classifyGateStallStatus(status, pinMoved, retriage);
  const buildTrackCandidateSnapshot = (
    staleness: CandidateStaleness,
    failingTestsMeasured: boolean | null,
  ): CandidateSnapshot | null => {
    if (!snapshotCandidate) return null;
    return buildCandidateSnapshot({
      candidate: snapshotCandidate,
      base: from,
      runId: options.runId,
      source: options.candidateSource ?? 'tip',
      selectedAtMs: options.selectedAtMs,
      candidateCommittedAt: staleness.candidateCommittedAt,
      commitsBehindTip: staleness.commitsBehindTip,
      failingTests: snapshotFailures,
      failingTestsMeasured,
      postSuiteMeasured: options.postSuiteMeasured,
      postSuiteLegs: options.postSuiteLegs,
      repairQueue: snapshotQueue,
      retriage: retriage
        ? { classification: retriage.classification, tip: retriage.tip }
        : undefined,
    });
  };
  // Compute all three ladder axes ONCE, before the noop split. `repair-in-progress` is
  // intentionally not a red and must never move the count/whole-gate-age axes, but it is the
  // primary producer of the fixer-succession axis. Keeping one decision call preserves
  // WI-42116's "exactly one production call site" invariant while letting that third axis speak
  // from the otherwise-noop branch.
  // A promotion-pending GREEN is a real suite result, but not yet the terminal promotion
  // disposition. It therefore carries the existing red episode without participating in the
  // ladder: a stale `lastGreenAt` must not turn this record-only bridge into a fresh age rung.
  const pendingGreen = promotionPending && options.green === true;
  const ladderTracksVerdict = !pendingGreen && (gateClass === 'red' || gateClass === 'record-only');
  const recordOnly = gateClass === 'record-only';
  const alreadyCountedPending = !promotionPending && !!options.runId && gh.pendingRunId === options.runId;
  const carryStreak = recordOnly || alreadyCountedPending;
  const consecutiveReds = ladderTracksVerdict
    ? carryStreak
      ? (gh.consecutiveReds ?? 0)
      : (gh.consecutiveReds ?? 0) + 1
    : pendingGreen
      ? (gh.consecutiveReds ?? 0)
      : 0;
  const firstRedAt =
    ladderTracksVerdict && !carryStreak ? (gh.firstRedAt ?? Date.now()) : (gh.firstRedAt ?? null);
  const lastGreenAt = gh.lastGreenAt ?? null;
  const stallAgeMs = ladderTracksVerdict && lastGreenAt != null ? Date.now() - lastGreenAt : null;
  const fixerAxisEligible =
    fixerSuccession != null && (status === 'repair-in-progress' || status === 'repair-staging-mismatch');
  const currentFixerSuccession = fixerAxisEligible ? fixerSuccession : null;
  const ladder = pendingGreen
    ? {
        shouldNotify: false,
        axis: null,
        rung: null,
        rungIndex: null,
        // This bridge is not a ladder observation. Preserve the prior marks verbatim so a
        // pending result cannot clear or advance an episode that the terminal verdict still owns.
        marks: {
          stallAlertedAtReds: gh.stallAlertedAtReds ?? null,
          stallAlertedAtAgeMs: gh.stallAlertedAtAgeMs ?? null,
          stallAlertedAtFixerAgeMs: gh.stallAlertedAtFixerAgeMs ?? null,
          stallFixerSuccessionKey: gh.stallFixerSuccessionKey ?? null,
        },
        reason: 'promotion-pending GREEN — carrying the prior stall ladder without observing a new rung',
      }
    : decideStallNotification({
        consecutiveReds,
        stallAgeMs,
        stallRedsThreshold: releaseCheckpointConfig().stallReds,
        stallAgeThresholdMs: releaseCheckpointConfig().stallAgeMs,
        fixerSuccessionAgeMs: currentFixerSuccession?.ageMs ?? null,
        fixerSuccessionThresholdMs: FIXER_SUCCESSION_STALL_MS,
        fixerSuccessionKey: currentFixerSuccession?.key ?? null,
        marks: {
          stallAlertedAtReds: ladderTracksVerdict ? (gh.stallAlertedAtReds ?? null) : null,
          stallAlertedAtAgeMs: ladderTracksVerdict ? (gh.stallAlertedAtAgeMs ?? null) : null,
          stallAlertedAtFixerAgeMs: gh.stallAlertedAtFixerAgeMs ?? null,
          stallFixerSuccessionKey: gh.stallFixerSuccessionKey ?? null,
          stallAlerted: ladderTracksVerdict ? (gh.stallAlerted ?? false) : false,
        },
      });
  const stallAlertedAtReds = ladder.marks.stallAlertedAtReds;
  const stallAlertedAtAgeMs = ladder.marks.stallAlertedAtAgeMs;
  const stallAlertedAtFixerAgeMs = fixerLivenessUnknown
    ? (gh.stallAlertedAtFixerAgeMs ?? null)
    : ladder.marks.stallAlertedAtFixerAgeMs;
  const stallFixerSuccessionKey = fixerLivenessUnknown
    ? (gh.stallFixerSuccessionKey ?? null)
    : (ladder.marks.stallFixerSuccessionKey ?? null);
  // EI-21462211894072863: 'no-verdict' shares this branch because it shares its ONE load-bearing
  // property — the tick rendered no verdict, so it must not touch `consecutiveReds`, `firstRedAt`
  // or the failing-test signature. It differs in exactly one way, handled after the shared record
  // below: it still COUNTS, in its own counter, so a crashing gate stays as loud as a red one.
  if (gateClass === 'noop' || gateClass === 'no-verdict') {
    // EI-2615: a lock collision with an ACTIVE peer run proves nothing about the
    // gate's health — leave gate_health completely untouched (don't even seed
    // lastFrom) so a slower, still-in-flight green tick's eventual reset write
    // can never be shadowed by this tick's false-red read-modify-write.
    // EI-19321275470651356: the two conditions in this class need opposite operator
    // advice, so the message is chosen by status (see gateStallNoopLogMessage).
    console.log(gateStallNoopLogMessage(status, summary));
    // EI-19405864032365760: 'noop' must not COUNT this tick as a red — that reasoning
    // (EI-2615 / EI-18757975681519069) is correct and unchanged above. But "don't count it"
    // silently became "don't record it AT ALL", and those are different claims. The counters
    // keep the PREVIOUS red's values, so every read surface (dev:pipeline_position, /admin/git,
    // the gate cells) keeps rendering that stale red — same candidate, same failing tests —
    // while the true state is "aborted before judging; no verdict is coming". Measured
    // 2026-08-03: a pending migration froze the pipeline ~2.5h during which the fleet was told
    // "Gate is RED (N consecutive) — the reds are yours to fix", sending multiple agents at
    // failing files that had nothing to do with it. The documented backstops DO fire, but
    // `checkMainBehindStaging` needs >1h AND no advance in 2h (it escalated at ~3.5h that day)
    // and `verdictStale` needs 12h — both are floors for "someone is eventually told", not for
    // "the reader asking RIGHT NOW gets a true answer".
    //
    // So record the abort in its OWN key, leaving every counter untouched:
    //   · written via jsonb_set on the `{gate_health,inconclusive}` PATH, so unlike the
    //     whole-key replace at the end of this function it cannot shadow a concurrent
    //     counter write — the EI-7472 hazard that makes a read-modify-write here unsafe.
    //   · cleared by the next REAL verdict for free: that write replaces the whole
    //     `gate_health` key, and `next` sets `inconclusive: null` explicitly (same
    //     recovery-clear convention as `failingTests` / `retriageStaleTip`).
    // Scoped to abort/serialized-hold conditions where NO peer gate verdict is coming.
    // 'skipped-locked' stays a total no-op on purpose: there a peer run IS in flight and about to
    // write the real verdict, which is precisely the write EI-2615 proved must not be raced. The
    // frozen-repair statuses join this path because their queue owner is progressing outside the
    // full-suite verdict path; leaving the previous red standing makes that bounded, intentional
    // hold look like an unchanged broken build and hides which repair phase owns progress.
    // WI-39841 (Defect 2): 'deadline-exceeded' joins them for the same reason, one phase later
    // still — the suite ran and may even have REACHED a verdict, but the process was killed
    // before it could record one, so nothing about the code was established. Recording it here
    // is what stops the abort going silent once it no longer counts as a red.
    // EI-21290961259437085: this list IS the set a reader can later be advised about, so it
    // is now the single source both sides share (RECORDED_INCONCLUSIVE_STATUSES) rather than
    // a literal chain here and a second, subtly different one in the advice path. Adding a
    // status here without classifying it there is what the guard test catches.
    if (isRecordedInconclusiveStatus(status)) {
      const inconclusivePayload = JSON.stringify({
        status,
        candidate: candidate?.slice(0, 12) ?? null,
        detail: summary ?? null,
        observedAtMs: Date.now(),
      });
      const tickLegs = options.repairTickLegs;
      const candidateSnapshot = buildTrackCandidateSnapshot(
        { candidateCommittedAt: null, commitsBehindTip: null },
        tickLegs ? true : false,
      );
      try {
        if (tickLegs) {
          // P-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31): this hold tick
          // DID measure — the CLI re-ran the cheap non-test legs at the queue's repairHead
          // (CheckpointVerdict.repairTickLegs). Stamping failingTestsMeasured:false here is
          // what left the flag false for HOURS during repair and sent agents chasing stale
          // names (D-001 loss class 4), so instead:
          //   · refresh exactly the MEASURED leg-shaped failingTests entries against the
          //     row's LIVE value at UPDATE time (filter measured ids out, append the fresh
          //     failing set) — the same at-UPDATE-time merge convention this function's
          //     final write uses, so a concurrent writer cannot be shadowed (EI-7472);
          //   · leave test-file entries untouched: they were measured by the suite red that
          //     froze the candidate, and this tick re-measured only the legs;
          //   · record provenance under gate_health.repairTickLegs (head + atMs + result)
          //     so a reader can see WHEN and AGAINST WHAT the leg half was refreshed.
          // The next REAL verdict clears all of this EXPLICITLY (`inconclusive: null`,
          // `repairTickLegs: null` in every verdict branch) — the final write MERGES since C4
          // of EI-22270968007901491, so nothing is cleared by omission. Fresh failing ids are all in the
          // measured set, so the filter+append cannot duplicate an entry.
          const measuredIds = tickLegs.legs.map((leg) => leg.id);
          await sql.unsafe(
            `UPDATE harness_shared.routines
                SET metadata = jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        jsonb_set(
                          jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gate_health,inconclusive}', $2::jsonb, true),
                          '{gate_health,failingTestsMeasured}', 'true'::jsonb, true),
                        '{gate_health,repairTickLegs}', $3::jsonb, true),
                      '{gate_health,failingTests}',
                      (SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
                         FROM jsonb_array_elements_text(COALESCE(metadata->'gate_health'->'failingTests', '[]'::jsonb)) AS e
                         WHERE NOT (e.value = ANY($4::text[]))) || $5::jsonb,
                      true),
                    '{gate_health,candidateSnapshot}',
                    $6::jsonb,
                    true),
                    updated_at = now()
              WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
                AND workspace_id = $7`,
            [
              ctx.installSlug,
              inconclusivePayload,
              JSON.stringify({
                head: tickLegs.head.slice(0, 12),
                atMs: tickLegs.atMs,
                ok: tickLegs.ok,
                failingSignatures: tickLegs.failingSignatures.slice(0, 20),
                // WI-10002091: persist the PER-LEG records too. Every consumer already expects
                // them and this is the only writer that can supply them:
                //   · `repair-tick-legs-snapshot.ts` DECLARES `legs: RepairTickLegSnapshot[]`
                //     and documents it "Bounded to 32 by the writer" — a bound only this line
                //     can apply, and which was never applied because the field was never written;
                //   · `readRepairTickLegOutputs` (P-021) reads `legs[].outputTail` as "the only
                //     evidence of WHICH files a lint / post-suite leg reported", so omitting the
                //     field made that reader return {} FOREVER and rendered every repair manifest
                //     pathless — which is why a full day of lint:tsc reds was undiagnosable from
                //     any surface (failingSignatures names the LEG, never the FILES).
                // outputTail is sliced from the FRONT, unlike the sibling pipeline-event mapping
                // above: per WI-10002075 each tail is digest-first (summarizeLegOutput), so
                // truncating from the end would discard exactly the file names the digest exists
                // to preserve.
                legs: tickLegs.legs.slice(0, 32).map((leg) => ({
                  id: leg.id.slice(0, 128),
                  status: leg.status,
                  durationMs: Math.max(0, Math.floor(leg.durationMs)),
                  ...(leg.outputTail ? { outputTail: leg.outputTail.slice(0, 1000) } : {}),
                })),
              }),
              measuredIds,
              JSON.stringify(tickLegs.failingSignatures.slice(0, 20)),
              JSON.stringify(candidateSnapshot),
              ctx.workspaceId,
            ],
          );
        } else {
          await sql.unsafe(
            `UPDATE harness_shared.routines
                SET metadata = jsonb_set(
                      jsonb_set(
                        jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gate_health,inconclusive}', $2::jsonb, true),
                      '{gate_health,failingTestsMeasured}',
                      'false'::jsonb,
                      true
                      ),
                    '{gate_health,candidateSnapshot}',
                    $3::jsonb,
                    true
                    ),
                    updated_at = now()
              WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
                AND workspace_id = $4`,
            [ctx.installSlug, inconclusivePayload, JSON.stringify(candidateSnapshot), ctx.workspaceId],
          );
        }
      } catch (e) {
        // Fail-safe, exactly like every other write in this function: an unrecorded abort
        // degrades to the pre-EI-19405864032365760 behaviour (invisible), never to a wrong verdict.
        console.warn(
          `${orchestratorStdoutTag()} inconclusive-verdict record failed: ${e instanceof Error ? e.message : e}`,
        );
      }
      // P-002 (gate-verdict-liveness-and-repair-reliability-2026-08-31): a TRANSIENT abort was
      // caused by something that has ALREADY HAPPENED (external kill, suite-budget SIGTERM, a
      // deleted module cache, an unexplained crash — see classifyGateAbort) and leaves nothing
      // standing to clear, so the retry must not wait out the rest of the cron hour: pull the
      // routine's next fire forward. Deliberately NOT for 'standing-condition' aborts
      // (migrations-pending, dependency-prewarm-missing, …): those persist until their producer
      // clears them, so the hourly tick is already the right cadence — a faster loop would only
      // reproduce the same recorded abort. Not for 'peer-owned' either (a repair owns progress).
      // Guards, each load-bearing:
      //   · forward-only — never DELAY a fire already scheduled sooner (a manual/near tick wins);
      //   · pause-aware — a paused routine keeps its pause (P-004's TTL sweep owns resumption);
      //   · run-lock + admission still gate the pulled-forward tick, so this cannot stack runs.
      // Worst case a persistently-transient-aborting gate retries ~6x/hour instead of 1x — which
      // is exactly the visibility P-003's no-verdict RATE alarm keys on, and strictly better than
      // discovering the same crash an hour later.
      if (classifyGateAbort(status) === 'transient') {
        try {
          await requeueGreenCheckpointAfterCapacity(sql, ctx.installSlug);
        } catch (e) {
          // Same fail-safe contract: a missed requeue degrades to the hourly cron, never worse.
          console.warn(
            `${orchestratorStdoutTag()} transient-abort prompt requeue failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }
    // P-003: a serialized repair hold is intentionally a red-counter NOOP, but its targeted
    // fixer can still be confirmed dead/absent. Let the third ladder axis notify without
    // manufacturing a code verdict or touching the one-shot red-streak condition.
    const repairHold = status === 'repair-in-progress' || status === 'repair-staging-mismatch';
    if (repairHold) {
      if (ladder.shouldNotify && ladder.axis === 'fixer' && currentFixerSuccession) {
        try {
          const { notifyAttentionOnce } = await import('../../attention-notify');
          const gapMins = Math.max(1, Math.round(currentFixerSuccession.ageMs / 60_000));
          const dead = currentFixerSuccession.state === 'dead';
          await notifyAttentionOnce({
            kind: 'intervention',
            title: dead
              ? `Release repair fixer DEAD — successor stalled (attempt ${currentFixerSuccession.attempts})`
              : `Release repair fixer ABSENT — dispatch stalled (attempt ${currentFixerSuccession.attempts + 1})`,
            body:
              `The frozen repair queue for candidate ${currentFixerSuccession.candidate.slice(0, 12)} ` +
              `has remained \`awaiting-fixer\` for ~${gapMins}m at repair head ` +
              `${currentFixerSuccession.repairHead.slice(0, 12)}, but its targeted fixer is ` +
              (dead
                ? `confirmed dead (${currentFixerSuccession.spawnId}).`
                : 'absent after the dispatch reservation window.') +
              ` This tick rendered NO code verdict and the queue remains serialized; the ` +
              `action is to restore fixer succession (inspect spawn/provider/launcher evidence ` +
              `and let the queue dispatch one replacement); do not start a parallel repair.`,
            importance: 'urgent',
            dedupeKey: `gate-stall:${ctx.installSlug}:fixer:${currentFixerSuccession.key}:` + `${ladder.rung ?? 0}`,
            workspaceId: ctx.workspaceId,
            data: {
              stallAxis: 'fixer',
              stallRung: ladder.rung,
              stallRungIndex: ladder.rungIndex,
              fixerSuccessionState: currentFixerSuccession.state,
              fixerSuccessionAgeMs: currentFixerSuccession.ageMs,
              fixerSuccessionKey: currentFixerSuccession.key,
              fixerSpawnId: currentFixerSuccession.spawnId,
              candidate: currentFixerSuccession.candidate.slice(0, 12),
              repairHead: currentFixerSuccession.repairHead.slice(0, 12),
              attempts: currentFixerSuccession.attempts,
            },
          });
        } catch (e) {
          console.warn(
            `${orchestratorStdoutTag()} fixer-succession alert failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      try {
        // Leaf-path writes preserve the exact noop safety invariant above: no read/modify/write
        // of the red counters, and no whole gate_health replacement that could shadow a peer.
        await sql.unsafe(
          `UPDATE harness_shared.routines
              SET metadata = jsonb_set(
                    jsonb_set(
                      COALESCE(metadata, '{}'::jsonb),
                      '{gate_health,stallAlertedAtFixerAgeMs}',
                      $2::jsonb,
                      true
                    ),
                    '{gate_health,stallFixerSuccessionKey}',
                    $3::jsonb,
                    true
                  ),
                  updated_at = now()
            WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
              AND workspace_id = $4`,
          [ctx.installSlug, JSON.stringify(stallAlertedAtFixerAgeMs), JSON.stringify(stallFixerSuccessionKey), ctx.workspaceId],
        );
      } catch (e) {
        console.warn(
          `${orchestratorStdoutTag()} fixer-succession mark write failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    /**
     * EI-21462211894072863 — the COUNTING half. Everything above deliberately leaves the counters
     * alone; this is what stops "don't count it as a red" from decaying into "don't count it".
     *
     * WI-39841's control test pins the property that matters: a genuinely crashing gate must not
     * go silent, because 'error' is the unknown-cause bucket and silence there is how `main`
     * freezes with nobody told. That property is preserved EXACTLY — same threshold, same
     * transition-only alarm — while the number a reader sees stops lying about what was measured.
     *
     * Written as ONE atomic statement rather than the read-modify-write the red path uses: this
     * branch runs concurrently with a peer run's real verdict write, and the EI-7472 hazard is
     * precisely that a whole-key replace here can shadow it. `jsonb_set` on the leaf PATH touches
     * nothing else in the blob, and the increment is computed in SQL from the OLD row, so two
     * ticks racing cannot lose a count. A non-numeric stored value degrades to 0 (via the
     * jsonb_typeof guard) instead of throwing the whole write away.
     *
     * The streak needs no explicit reset: every real verdict below REPLACES the whole `gate_health`
     * key, and both arms state `consecutiveNoVerdict: 0` outright — so one verdict of either colour
     * ends the streak, which is exactly the definition of "consecutive".
     */
    if (gateClass === 'no-verdict') {
      try {
        const bumped = (await sql.unsafe(
          `UPDATE harness_shared.routines
              SET metadata = jsonb_set(
                    COALESCE(metadata, '{}'::jsonb),
                    '{gate_health,consecutiveNoVerdict}',
                    to_jsonb(
                      COALESCE(
                        CASE WHEN jsonb_typeof(metadata #> '{gate_health,consecutiveNoVerdict}') = 'number'
                             THEN (metadata #>> '{gate_health,consecutiveNoVerdict}')::int
                        END,
                        0
                      ) + 1
                    ),
                    true
                  ),
                  updated_at = now()
            WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
              AND workspace_id = $2
        RETURNING (metadata #>> '{gate_health,consecutiveNoVerdict}')::int AS streak,
                  COALESCE((metadata #>> '{gate_health,noVerdictAlerted}')::boolean, false) AS alerted`,
          [ctx.installSlug, ctx.workspaceId],
        )) as Array<{ streak: number | null; alerted: boolean | null }>;
        const streak = bumped[0]?.streak ?? 0;
        const alreadyAlerted = bumped[0]?.alerted === true;
        console.log(
          `${orchestratorStdoutTag()} '${status}' — ${streak} consecutive tick(s) have produced NO verdict ` +
            `(consecutiveReds left at ${gh.consecutiveReds ?? 0}, which still describes the last run that ` +
            `actually judged code)`,
        );
        // Transition-only, exactly like `stallAlerted` on the red path: one alarm per episode,
        // cleared by the next real verdict's whole-key replace.
        if (streak >= releaseCheckpointConfig().stallReds && !alreadyAlerted) {
          await sql
            .unsafe(
              `UPDATE harness_shared.routines
                  SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gate_health,noVerdictAlerted}', 'true'::jsonb, true)
                WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
                  AND workspace_id = $2`,
              [ctx.installSlug, ctx.workspaceId],
            )
            .catch(() => undefined);
          const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
          await broadcastSevereEvent({
            summary:
              `[${ctx.installSlug}] green-checkpoint is WEDGED on ${ctx.installSlug} — ${streak} consecutive run(s) ` +
              `ended without producing ANY verdict (latest: ${status}). This is NOT a red build: no failing test has been named.`,
            body:
              `${streak} consecutive green-checkpoint run(s) on \`${ctx.installSlug}\` ended without a code ` +
              `verdict; the latest status is \`${status}\`. \`main\` is not advancing.\n\n` +
              `⚠ DO NOT triage failing tests on this signal. Any failing-test list still shown for this harness ` +
              `belongs to the last run that actually judged code, which is now at least ${streak} fire(s) old; ` +
              `\`gate_health.consecutiveReds\` describes THAT run, not these.\n\n` +
              `Read gate_health.inconclusive and the newest green-checkpoint log for the measured blocker. A standing ` +
              `preflight condition (for example disk-headroom) must be cleared before re-fire; an unreported process ` +
              `exit instead requires diagnosing why the runner died before it could publish a result.`,
            category: 'severe-event',
            // Deliberately NO conditionKey. `gate-red-streak:<harness>` mints exactly one claimable
            // work-item whose whole framing is "the reds are yours to fix" — the response this
            // alarm exists to prevent. Opening it here would hand someone a broken-build ticket for
            // a gate that never judged a build. A plain severe event still reaches every agent's
            // inbox, which is the loudness this needs.
          });
        }
      } catch (e) {
        // Fail-safe like every other write here: an unrecorded no-verdict tick degrades to
        // invisible, never to a wrong verdict.
        console.warn(
          `${orchestratorStdoutTag()} no-verdict streak record failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return;
  }
  // EI-19329732364513693: stamp HOW STALE the judged candidate is into the same blob that
  // carries the verdict, so a reader never has to re-derive it (and so the overwhelmingly
  // common case — not thinking to derive it at all — stops costing a wild-goose chase).
  // Fail-safe: nulls on any git error. Deliberately AFTER the 'noop' early-return above, which
  // leaves gate_health untouched and must not pay for a git call it will never record.
  // The root itself is part of the fail-safe: an unresolvable integration tree yields the same
  // nulls a git error does, instead of throwing out of the tick before `.catch()` can apply.
  const stalenessRoot = candidate ? integrationRootForDiagnostic() : null;
  // P-003 / EI-22710660172830156: an admitted repair head is a detached/synthesized commit,
  // not a normal staging commit. Its synthetic commit metadata can carry an epoch-like date
  // (the admission writer intentionally does not preserve the source commit timestamp), so
  // measuring that SHA as though it were a tip candidate produces a fossil verdict for a
  // fresh repair result. Only suppress the diagnostic when the verdict explicitly names the
  // queue's current repairHead AND that head has moved beyond the immutable candidate. A
  // queue whose head is still the candidate remains a normal tip measurement; ordinary tip
  // verdicts without queue provenance are unchanged.
  const detachedRepairHeadVerdict = Boolean(
    candidate &&
      snapshotQueue &&
      snapshotQueue.repairHead === candidate &&
      snapshotQueue.repairHead !== snapshotQueue.candidate,
  );
  const staleness: CandidateStaleness =
    candidate && stalenessRoot && !detachedRepairHeadVerdict
      ? await measureCandidateStaleness(stalenessRoot, candidate, gitRunner ?? defaultGitCheckRunner).catch(() => ({
          candidateCommittedAt: null,
          commitsBehindTip: null,
        }))
      : { candidateCommittedAt: null, commitsBehindTip: null };
  const verdictCandidateSnapshot = buildTrackCandidateSnapshot(staleness, true);
  // P-013: the round's per-file reuse record, shape-checked before storage. The write below
  // MERGES, so a round that reported nothing leaves the previous record in place — labelled with
  // its own judgedSha — rather than overwriting it with a zero nobody measured.
  const testPassReuseRecord = parseTestPassReuseHealth(options.testPassReuse);
  // P-013: unlike testPassReuse, the phase breakdown carries no sha of its own — it describes the
  // round beside `observedCandidate` — so an unmeasured round CLEARS it (explicit null) instead of
  // leaving an older round's phases next to a newer candidate.
  const roundPhasesRecord = parseGateRoundPhases(options.roundPhases);
  // EI-20706962612084953: where `main` is left AFTER this run — the value the NEXT tick
  // compares its live pin against (see `lastObservedMainPin` above). 'advanced' fast-forwards
  // main to the candidate; every non-advancing status leaves it exactly where this run found
  // it. 'advanced-prefix' moves main to the longest green PREFIX — a sha this function is
  // never handed — so it records null and the next tick falls back to `lastFrom`, i.e. the
  // pre-existing behaviour for that one status rather than a value we would be inventing.
  const mainPinAfterRun =
    status === 'advanced' ? (candidate?.slice(0, 12) ?? fromPin) : status === 'advanced-prefix' ? null : fromPin;
  // EI-13288 / WI-7482 / EI-20243738214569472 — full rationale on the red branch below.
  // Hoisted above the branch so the NOT-GREEN reset arm records the same re-triage
  // provenance a red does: that arm IS a red verdict in every respect except the stall
  // streak, and leaving these null there would re-introduce, one field down, the very
  // "a not-green run recorded as if it had nothing to report" defect this change fixes.
  const retriageStale = retriage?.classification === 'stale-candidate';
  const retriageBlocked = retriageStale && retriage?.autoRefire === false;
  let next: Record<string, unknown>;
  if (gateClass === 'reset') {
    if (!isGreen) {
      console.log(
        `${orchestratorStdoutTag()} release pin moved ${gh.lastFrom} → ${fromPin} outside this routine (status '${status}') — main is advancing; resetting the stall streak`,
      );
    }
    // EI-7472: `watchdogAlerted` is owned by the separate green-stall-watchdog sweep — it is
    // carried through every `next` here explicitly. (Until C4 of EI-22270968007901491 the
    // final write REPLACED the whole `gate_health` key, so omitting it dropped it; the write
    // now merges and carries unmentioned keys — see carryForeignGateHealthKeys — but the
    // explicit carry stays because on recovery (green) this writer CLEARS it, matching the
    // watchdog's own recovery-clear in green-stall-watchdog.ts.)
    // EI-7505: clear the failing-test list on recovery — a stale list from the
    // last red streak must not linger in gate_health once the gate is green again.
    // WI-4489: stamp WHEN this verdict was observed and WHAT it judged. Without it the blob is a
    // value with no provenance, and a consumer cannot tell a live verdict from one frozen hours ago
    // by a starved writer (a `skipped-locked` no-op leaves gate_health untouched while still
    // refreshing `last_fired_at`, so `fireStale` reads FRESH). See release/gate-verdict-freshness.ts.
    // EI-13288: a stale-candidate note from a PRIOR red streak must not linger once the gate is
    // green again — same recovery-clear convention as `failingTests` just above.
    // EI-19405864032365760: `inconclusive` records a preflight ABORT (see the noop branch above).
    // A real verdict supersedes it, so clear it here — explicit rather than relying on the
    // whole-key replace, matching the `retriageStaleTip` / `failingTests` convention so a later
    // change to a merging write cannot silently resurrect a stale abort note.
    // EI-20706962612084953: this branch has TWO populations and only one of them is green.
    // `pinMoved` puts a NOT-GREEN verdict here on purpose (main is advancing via a path this
    // routine never saw, so the "main is frozen" stall streak is not real) — but the blob
    // written below was the full green signature regardless: consecutiveReds 0, firstRedAt
    // null, failingTests [], lastGreenAt = now. Every field agreed with a green and nothing
    // marked it apart, so every surface pointed at gate_health answered "green" for a run
    // that recorded not-green, and the stall detectors keyed on lastGreenAt/consecutiveReds
    // were silently suppressed for it. Reset the STALL STREAK (this branch's legitimate
    // purpose) WITHOUT claiming a green:
    //   · `lastGreenAt` is CARRIED, never stamped — the gate did not green, so the age of the
    //     last real green must keep running (it is what `verdictStale` measures).
    //   · `failingTests` carries this run's real list instead of being cleared as a recovery.
    //   · `watchdogAlerted` is carried, not cleared: clearing is a RECOVERY action and this is
    //     not a recovery (EI-7472 — the whole-key replace drops whatever `next` omits).
    //   · `stallAlerted` is carried for the same reason, and for one more: it is the dedup flag
    //     recording that the red-streak CONDITION is open. Clearing it while leaving that
    //     condition open would strand it — the later genuine green reads `gh.stallAlerted`
    //     false and broadcasts no resolve, leaking a permanently-open incident item (D-011).
    //   · `lastVerdict` is the explicit marker that was missing: with it a reader can tell the
    //     two populations of this branch apart instead of having to infer it from side-effects.
    next = isGreen
      ? {
          consecutiveReds: 0,
          lastGreenAt: Date.now(),
          firstRedAt: null,
          stallAlerted: false,
          // WI-42116: a real green ENDS the episode, so the ladder resets to the bottom.
          // Clearing both marks is the ONLY intended way back to null — the decision layer
          // never regresses them — and it is what lets the NEXT stall alert at rung 1 again
          // instead of resuming halfway up a previous episode's ladder.
          stallAlertedAtReds: null,
          stallAlertedAtAgeMs: null,
          stallAlertedAtFixerAgeMs: null,
          stallFixerSuccessionKey: null,
          lastVerdict: 'green',
          lastFrom: fromPin ?? gh.lastFrom ?? null,
          lastFromFresh: fromPin != null,
          lastMainPin: mainPinAfterRun,
          pendingRunId: null,
          watchdogAlerted: false,
          failingTests: [],
          failingTestsMeasured: true,
          observedAt: Date.now(),
          observedCandidate: candidate?.slice(0, 12) ?? null,
          ...(testPassReuseRecord ? { testPassReuse: testPassReuseRecord } : {}),
          roundPhases: roundPhasesRecord,
          candidateSnapshot: verdictCandidateSnapshot,
          retriageStaleTip: null,
          retriageDetail: null,
          retriageClassification: null,
          candidateCommittedAt: staleness.candidateCommittedAt,
          commitsBehindTip: staleness.commitsBehindTip,
          inconclusive: null,
          // C4: a real verdict supersedes the hold tick's per-leg snapshot (P-009). Stated
          // outright now that the write MERGES — clear-by-omission no longer exists.
          repairTickLegs: null,
          // EI-21462211894072863: a real verdict ENDS a no-verdict streak — that is what
          // "consecutive" means. Stated outright rather than left to the whole-key replace,
          // matching the `inconclusive: null` convention directly above (a later change to a
          // merging write must not silently resurrect a dead streak, nor its one-shot flag).
          consecutiveNoVerdict: 0,
          noVerdictAlerted: false,
        }
      : {
          consecutiveReds: 0,
          lastGreenAt: gh.lastGreenAt ?? null,
          firstRedAt: null,
          stallAlerted: gh.stallAlerted ?? false,
          // WI-42116: CARRIED, not cleared — for the same reason `stallAlerted` is on this arm.
          // `pinMoved` puts a NOT-GREEN verdict here: the stall STREAK is reset because `main`
          // advanced by a path this routine never saw, but nothing greened and no alert was
          // resolved. Nulling the marks would silently re-arm rung 1, and the next red tick
          // would re-announce a stall the fleet was already told about (EI-7472's shape).
          stallAlertedAtReds: gh.stallAlertedAtReds ?? null,
          stallAlertedAtAgeMs: gh.stallAlertedAtAgeMs ?? null,
          stallAlertedAtFixerAgeMs: stallFixerSuccessionKey ? stallAlertedAtFixerAgeMs : null,
          stallFixerSuccessionKey,
          lastVerdict: 'not-green',
          lastFrom: fromPin ?? gh.lastFrom ?? null,
          lastFromFresh: fromPin != null,
          lastMainPin: mainPinAfterRun,
          pendingRunId: null,
          watchdogAlerted: gh.watchdogAlerted ?? false,
          failingTests: (failingTests ?? []).slice(0, 20),
          failingTestsMeasured: true,
          observedAt: Date.now(),
          observedCandidate: candidate?.slice(0, 12) ?? null,
          ...(testPassReuseRecord ? { testPassReuse: testPassReuseRecord } : {}),
          roundPhases: roundPhasesRecord,
          retriageStaleTip: retriageBlocked ? (retriage!.tip?.slice(0, 12) ?? null) : null,
          retriageDetail: retriageBlocked ? retriage!.detail : null,
          retriageClassification: retriage?.classification ?? null,
          candidateCommittedAt: staleness.candidateCommittedAt,
          commitsBehindTip: staleness.commitsBehindTip,
          inconclusive: null,
          // C4: see the green arm — a real verdict supersedes the hold tick's leg snapshot.
          repairTickLegs: null,
          // EI-21462211894072863: see the green arm — a verdict of EITHER colour ends the streak.
          consecutiveNoVerdict: 0,
          noVerdictAlerted: false,
        };
    // P-003: clear the durable stall escalation on the green transition (idempotent).
    // WI-2825: a 0-row match here (harness_slug/phase mismatch, or the row was already
    // cleared/removed some other way) previously succeeded silently — no error, no log —
    // so a genuinely-stuck escalation (gate_health.stallAlerted already true, meaning the
    // P-003 insert below DID fire earlier and a row SHOULD exist to clear) could linger in
    // harness_escalations forever while gate_health quietly reset to "no active alert".
    // That divergence is exactly the shape of the recurring "Unresolved escalation in
    // harness X" watchdog phantoms (EI-7569/EI-7575 this session): the routine metadata
    // says clear, the escalations table still shows one open. Surface it loudly instead —
    // only when we EXPECTED a row to clear (gh.stallAlerted), so a routine, everyday
    // "nothing to clear" reset (no prior escalation) stays silent as before.
    try {
      const cleared = await sql.unsafe(
        `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $2
          WHERE harness_slug = $1 AND phase = $3 AND escalation IS NOT NULL`,
        [ctx.installSlug, Date.now(), GATE_STALL_PHASE],
      );
      if (shouldWarnOnStallClearMiss(!!gh.stallAlerted, cleared.count)) {
        console.warn(
          `${orchestratorStdoutTag()} stall escalation clear MATCHED 0 ROWS for harness_slug='${ctx.installSlug}' phase='${GATE_STALL_PHASE}' despite gate_health.stallAlerted=true (an escalation should have existed) — the durable harness_escalations row may be stuck OPEN even though this routine believes the stall is resolved. Check harness_escalations for a stale row under a different harness_slug value.`,
        );
      }
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} stall escalation clear failed: ${e instanceof Error ? e.message : e}`);
    }
    // A no-turn fixer escalation belongs to the same red episode. Clear it on the first
    // genuinely green verdict so a later reader cannot mistake the old dead launch for a
    // current gate failure. This uses the existing escalation table/phase surface and is
    // deliberately idempotent like the stall clear above.
    //
    // EI-20706962612084953: "genuinely green" is what this comment always said, but the
    // guard was missing — a NOT-GREEN pin-moved tick reaches this branch too and was
    // clearing the escalation for a red episode that is still open. The stall clear above
    // stays unconditional on purpose: it asserts only "main is advancing", which pinMoved
    // is direct evidence of. This one asserts the gate RECOVERED, which is a different
    // claim and false here.
    if (isGreen) {
      try {
        await sql.unsafe(
          `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $2
            WHERE harness_slug = $1 AND phase = $3 AND escalation IS NOT NULL`,
          [ctx.installSlug, Date.now(), RELEASE_FIXER_NO_TURN_PHASE],
        );
      } catch (e) {
        console.warn(
          `${orchestratorStdoutTag()} release-fixer no-turn escalation clear failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    // P-005: CLOSE the red-streak condition — the bridge settles the owning work-item
    // on this broadcast, so a missed resolve leaks one permanently-open incident item
    // per episode (D-011's leak, which is exactly what the bridge's `settle: true`
    // exists to prevent). Guarded on `gh.stallAlerted`, the same transition edge the
    // escalation clear above uses: a routinely-green tick opened no condition and must
    // broadcast no recovery, or every green hour spams a resolution for nothing.
    //
    // ⚠ Read `gh.stallAlerted` (the value BEFORE this green reset), never `next`
    // (which sets it false unconditionally two lines up) — testing the post-reset
    // value would make this dead code that never fires.
    //
    // EI-20706962612084953: `isGreen` guards it for the second reason — the broadcast SAYS
    // "green-checkpoint GREEN again … the earlier red-gate alarm is stale", and on a
    // not-green pin-moved tick that is a false all-clear that also SETTLES the owning
    // work-item. A moved pin proves main is advancing; it proves nothing about this
    // verdict, which is precisely the conflation this whole change removes.
    if (isGreen && gh.stallAlerted) {
      try {
        const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
        const { gateRedStreakConditionKey } = await import('../../coord/gate-ownership');
        await broadcastSevereEventResolved({
          conditionKey: gateRedStreakConditionKey(ctx.installSlug),
          // The harness slug is repeated on EVERY clause on purpose. This broadcast lands in
          // the inbox of agents working OTHER harnesses, where the consequence clauses ("the
          // red streak is over", "the earlier red-gate alarm is stale") read as global
          // all-clears — a reader on a still-red harness can take it as their own gate
          // recovering. Naming the slug once in the lead is not enough: inbox summaries
          // TRUNCATE, and it is the unscoped tail that survives and gets believed. Observed
          // live 2026-08-17: a sidestage GREEN-again broadcast read as papercusp news while
          // papercusp sat at 15 consecutive reds.
          summary:
            `[${ctx.installSlug}] green-checkpoint GREEN again on ${ctx.installSlug} — ${ctx.installSlug}'s red ` +
            `streak is over and its \`main\` is advancing, so the earlier red-gate alarm for ${ctx.installSlug} ` +
            `is stale. This says NOTHING about any other harness's gate — each harness has its own.`,
        });
      } catch (e) {
        console.warn(
          `${orchestratorStdoutTag()} red-streak condition resolve failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } else {
    // WI-39450: a 'record-only' tick carries the streak FORWARD instead of advancing it. It is
    // not a green (nothing was promoted, so it must not reset either) — it is a pass whose own
    // re-triage re-ran the named failing files at tip and watched them PASS, i.e. it produced no
    // evidence about the current code at all. Measured 2026-08-17: consecutiveReds 10 -> 11 off a
    // pass whose own classifier said `stale-candidate`, naming 7 files that passed 52/0 at tip;
    // and 13 -> 14 off candidate 67c66f70, whose 4 named files passed 156/0 at tip.
    // When such a pass DOES refire, advancing would additionally double-count one logical run
    // (the superseded pass AND its successor each land a verdict) — but that is a second reason,
    // not the reason: `isProvenStaleCandidate` deliberately does not require a refire, because
    // `autoRefire` was false in 18 of 18 re-triaging runs sampled over 2026-08-15..17.
    // `firstRedAt` is left alone for the same reason — a non-verdict must not START a streak,
    // or a `stalledByAge` escalation could be dated from a tick that judged nothing current.
    if (recordOnly) {
      console.log(
        promotionPending
          ? `${orchestratorStdoutTag()} '${status}' — suite verdict recorded before promotion decision; carrying the prior red streak until final disposition`
          : gateStallRecordOnlyLogMessage(status),
      );
      // P-003 final clause (D-002): the streak-carry above is the CORRECTION; this is the
      // REPORT. Without it a torn sweep is absorbed silently — correct counters, zero
      // observability — so the phenomenon cannot be measured or subscribed to.
      // `promotionPending` is excluded deliberately: that branch carries the streak for a
      // different reason (a verdict recorded before the promotion decision), and announcing
      // it as a torn sweep would attribute a git-sync tear to a run that never proved one.
      if (!promotionPending) {
        const tornSweep = buildTornSweepAnnouncement({
          installSlug: ctx.installSlug,
          candidate,
          failingTests,
          retriage,
          runId: options.runId ?? null,
        });
        if (tornSweep) await emitTornSweepEvent(tornSweep);
      }
    }
    // WI-42116 (ruling green-main-fast-2026-08-25 D-022): the stall alarm is a BOUNDED,
    // SUPER-LINEAR LADDER, not a one-shot. The old edge was
    // `(stalledByCount || stalledByAge) && !stallAlerted`, and `stallAlerted` is carried on
    // every subsequent red — so the alarm fired once at `stallReds` and never again, however
    // deep the streak ran. Measured on papercusp 2026-08-26: `consecutiveReds: 43`, last green
    // 5.12 days earlier, on ONE alert raised on day one. Reds #4–#43 were silent, which is why
    // a livelocked gate read as "already alerted, someone's on it" for five days.
    //
    // ⚠ The obvious fix — re-alert while still red — is a REGRESSION, not an improvement:
    // EI-7472 is exactly that failure (dedup flag clobbered per tick → the fleet re-spammed
    // the STALLED severe-event ~hourly). The one-shot is an OVER-CORRECTED fix. So the rungs
    // are geometric: alert count is O(log stall depth), ~3 alerts across the measured 43-red /
    // 122.9h stall against 1 today and ~120 under a per-tick repeat.
    //
    // ⚠ THREE AXES. The age axis is load-bearing rather than belt-and-braces: `carryStreak`
    // above holds `consecutiveReds` FIXED on withheld / record-only ticks, so a livelocked gate
    // (every red withheld as a stale candidate) can sit at a fixed red count indefinitely while
    // time runs on. papercusp was in precisely that state, so a count-only ladder would go
    // silent on the exact gate this exists to catch.
    //
    // ⚠ TWO LEGS, DIFFERENT CADENCES — do not collapse them back into one flag:
    //   · the human `notifyAttention` → EVERY new rung. This is the decayed signal being fixed.
    //   · the durable escalation row + the `gate-red-streak:<harness>` condition → the FIRST
    //     rung of the episode ONLY, still keyed on the unchanged `stallAlerted` boolean.
    //     WI-6228's `oneShot: true` and D-011's open/close symmetry both depend on that flag
    //     staying one-per-episode: re-minting would hand one stall a second owning work-item,
    //     and re-opening a condition the staleness sweep already resolved would strand it.
    // Persisted UNCONDITIONALLY — including on a quiet tick — so the back-compat seeding of a
    // legacy `stallAlerted: true` blob (written before this shipped) lands exactly once and
    // cannot re-alert later for a stall that was already announced.
    let stallAlerted = gh.stallAlerted ?? false;
    // Read BEFORE the assignment below, so the one-shot legs see the PRE-tick value. Same trap
    // (and same fix) as the green path's `gh.stallAlerted` read at the resolve edge.
    const firstRungOfEpisode = !stallAlerted;
    const fixerOnlyAlert = ladder.shouldNotify && ladder.axis === 'fixer';
    if (ladder.shouldNotify) {
      // A fixer-succession alert is its OWN ladder axis. It must not open the generic
      // red-streak condition or mutate that condition's one-shot flag: the queue hold is
      // deliberately a no-verdict state, and opening a code-red work item would misroute
      // the response back to the already-dead candidate.
      if (!fixerOnlyAlert) stallAlerted = true;
      const heldHrs = lastGreenAt ? Math.round((Date.now() - lastGreenAt) / 3_600_000) : null;
      const ladderPosition = describeLadderPosition({
        consecutiveReds,
        stallAgeMs,
        stallRedsThreshold: releaseCheckpointConfig().stallReds,
        stallAgeThresholdMs: releaseCheckpointConfig().stallAgeMs,
        fixerSuccessionAgeMs: currentFixerSuccession?.ageMs ?? null,
        fixerSuccessionThresholdMs: FIXER_SUCCESSION_STALL_MS,
        fixerSuccessionKey: currentFixerSuccession?.key ?? null,
        marks: {},
      });
      console.log(`${orchestratorStdoutTag()} gate stall escalation — ${ladder.reason}; ${ladderPosition}`);
      // EI-18672078222841101: resolve the CURRENT owner before saying anything about one.
      // The old body asserted "A release-fixer is on it" unconditionally — which is simply
      // false whenever the dispatched fixer died without clearing the red, and that false
      // reassurance is the version of this bug that leaves a gate unowned instead of
      // triple-owned. Same signature derivation as the dispatcher (P-012: sorted failing
      // files, candidate as fallback) so the two cannot key on different things.
      // WI-42118 (D-022(d)): the CROSS-STREAK cause digest. Every other field in both bodies
      // below is a snapshot of THIS tick, so neither could say whether the failing set is one
      // unfixed break (fix that test) or churning (infrastructure — do not chase the names).
      // Computed only on an alerting tick, so a quiet red pays nothing for it.
      const causeDigest = fixerOnlyAlert
        ? null
        : await readStreakCauseDigest(sql, ctx.installSlug, ctx.workspaceId, firstRedAt ?? lastGreenAt);
      const currentSignature = gateFailureSignature(failingTests, candidate);
      // P-008: the alert and `release:trace` must not render contradictory truth about ONE
      // red. This rung used to read the automated fixer ALONE, so it could tell a whole
      // fleet "UNOWNED — claim it before investigating" at the exact moment a live agent
      // held the gate's condition singleton and was repairing it — the false invitation
      // that produced 37 agents / 97 stints on one gate item on 2026-08-26. Composing the
      // singleton in here uses the SAME pure composer `release:trace` calls, so the two
      // surfaces cannot disagree. One indexed SELECT, fail-soft, and only on an alerting
      // tick — the same cost profile as the causeDigest read immediately above.
      // Dynamically imported, matching this file's existing `coord/gate-ownership` call
      // sites (lines above) rather than adding a static edge to a module this one is
      // otherwise only reached FROM.
      const gateSingleton = fixerOnlyAlert
        ? null
        : await import('../../coord/gate-ownership')
            .then((m) => m.readGateOwnership({ harness: ctx.installSlug }))
            .catch(() => null);
      const ownership = fixerOnlyAlert
        ? null
        : composeGateRedOwnership({
            fixer: describeGateRedOwnership({
              ownerSignature: lastFixer?.signature ?? null,
              currentSignature,
              dispatchedAtMs: lastFixer?.at ?? null,
              spawnId: lastFixer?.spawnId ?? null,
              // Only meaningful for the fixer holding THIS signature; a mismatch short-circuits
              // to 'stale-signature' anyway, so skip the liveness query in that case.
              fixerAlive:
                lastFixer?.signature && lastFixer.signature === currentSignature
                  ? await releaseFixerSpawnAlive(sql, lastFixer.spawnId).catch(() => null)
                  : null,
              nowMs: Date.now(),
            }),
            repairOwner: projectGateRepairOwner(gateSingleton, Date.now()),
          });
      try {
        // WI-42116: `notifyAttentionOnce`, not `notifyAttention` — the replay-safe variant is
        // what accepts `dedupeKey`, and a ladder whose whole contract is "at most one alert per
        // rung" wants exactly that guarantee at the delivery layer too, not only in the marks.
        const { notifyAttentionOnce } = await import('../../attention-notify');
        await notifyAttentionOnce({
          kind: 'intervention',
          // WI-42116: the rung is IN the title. A re-escalation that reads identically to the
          // day-one alert is indistinguishable from a duplicate, and a reader who files it as
          // one has learned nothing — the whole point of rung 2 is that it says "still, and
          // deeper". `rungIndex` is 0-based; humans count escalations from 1.
          title: fixerOnlyAlert
            ? currentFixerSuccession?.state === 'dead'
              ? `Release repair fixer DEAD — succession escalation ${(ladder.rungIndex ?? 0) + 1}`
              : `Release repair fixer ABSENT — succession escalation ${(ladder.rungIndex ?? 0) + 1}`
            : firstRungOfEpisode
              ? 'Release pipeline STALLED — main frozen'
              : `Release pipeline STILL STALLED — escalation ${(ladder.rungIndex ?? 0) + 1} (main frozen)`,
          // EI-19329732364513693: name the candidate's distance behind tip IN the alert. This is
          // the surface a human actually reads, and a red whose candidate is far behind staging
          // is very often already fixed — saying so here is what stops the chase, rather than
          // leaving each reader to re-derive it (which, overwhelmingly, they do not).
          body:
            fixerOnlyAlert && currentFixerSuccession
              ? `The frozen repair queue for candidate ${currentFixerSuccession.candidate.slice(0, 12)} ` +
                `has remained \`awaiting-fixer\` for ~${Math.max(1, Math.round(currentFixerSuccession.ageMs / 60_000))}m ` +
                `at repair head ${currentFixerSuccession.repairHead.slice(0, 12)}, but its targeted fixer is ` +
                (currentFixerSuccession.state === 'dead'
                  ? `confirmed dead (${currentFixerSuccession.spawnId}).`
                  : 'absent after the dispatch reservation window.') +
                ` Restore fixer succession (inspect the exact spawn/provider evidence and let the ` +
                `serialized queue dispatch one replacement); do not start a parallel repair. [${ladderPosition}]`
              : `green-checkpoint has held \`main\` for ${consecutiveReds} consecutive checkpoint(s)${heldHrs != null ? ` (~${heldHrs}h since the last green)` : ''}. Staging changes are NOT reaching the release. ${ownership?.label ?? ''}${
                  staleness.commitsBehindTip != null && staleness.commitsBehindTip > 0
                    ? ` NOTE: the judged candidate is ${staleness.commitsBehindTip} commit(s) behind staging${staleness.candidateCommittedAt ? `, committed ${staleness.candidateCommittedAt}` : ''} — confirm a named failure still reproduces AT TIP before chasing it.`
                    : ''
                }${causeDigest ? ` ${causeDigest.line}` : ''} [${ladderPosition}]`,
          importance: 'urgent',
          // WI-42116: idempotent PER RUNG. The persisted marks already stop a second alert for
          // the same rung on a later tick; this closes the other window — two trackGateStall
          // calls racing the SAME tick (a retry, or a concurrent run) would otherwise each read
          // the pre-write marks and each notify. The key is the rung itself, so it is stable
          // across those callers and distinct at the next rung.
          dedupeKey:
            fixerOnlyAlert && currentFixerSuccession
              ? `gate-stall:${ctx.installSlug}:fixer:${currentFixerSuccession.key}:${ladder.rung ?? 0}`
              : `gate-stall:${ctx.installSlug}:${ladder.axis ?? 'count'}:${ladder.rung ?? 0}`,
          workspaceId: ctx.workspaceId,
          data: {
            consecutiveReds,
            candidate: candidate?.slice(0, 12) ?? null,
            ownership: ownership?.state ?? null,
            ownerSpawnId: ownership?.spawnId ?? null,
            candidateCommittedAt: staleness.candidateCommittedAt,
            commitsBehindTip: staleness.commitsBehindTip,
            // WI-42116: which rung this is, so a reader (and any consumer keying on `data`)
            // can tell escalation 3 from a duplicate of escalation 1 without parsing prose.
            stallAxis: ladder.axis,
            stallRung: ladder.rung,
            stallRungIndex: ladder.rungIndex,
            stallAgeMs,
            fixerSuccessionState: currentFixerSuccession?.state ?? null,
            fixerSuccessionAgeMs: currentFixerSuccession?.ageMs ?? null,
            fixerSuccessionKey: currentFixerSuccession?.key ?? null,
            fixerSpawnId: currentFixerSuccession?.spawnId ?? null,
            // WI-42118: structured alongside the prose, so a consumer can route on the cause
            // class (stable → one owner fixes one test; churning → infrastructure) without
            // parsing the sentence.
            causeStability: causeDigest?.stability ?? null,
            causePersistent: causeDigest?.persistent ?? null,
          },
        });
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} stall alert failed: ${e instanceof Error ? e.message : e}`);
      }
      // ── FIRST RUNG OF THE EPISODE ONLY (WI-42116) ──────────────────────────────────
      // A LATER rung re-notifies the human and stops there. Neither write below may repeat:
      //   · the escalation row is keyed (harness_slug, phase) and its UPSERT refreshes
      //     `mtime_ms` — re-writing it on rung 2 would make a five-day-old escalation look
      //     newly-raised to every age-based reader, i.e. it would make the stall QUIETER the
      //     longer it ran. That is the exact defect this work-item exists to remove.
      //   · re-broadcasting the condition would mint a SECOND owning work-item for one stall
      //     (WI-6228) and re-open a condition the staleness sweep may already have resolved.
      // `firstRungOfEpisode` is the PRE-tick `stallAlerted`, so this stays the same edge those
      // two legs have always fired on — only the human-notify leg above changed cadence.
      if (firstRungOfEpisode && !fixerOnlyAlert) {
        // P-003: ALSO write a durable harness_escalations row — the silent-stall
        // gap (every other pipeline failure escalates; this one only notified +
        // overwrote metadata). Its own phase, idempotent upsert; fail-safe.
        try {
          await sql.unsafe(
            `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (harness_slug, phase)
             DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
            [
              ctx.installSlug,
              GATE_STALL_PHASE,
              gateStallEscalationBody({
                installSlug: ctx.installSlug,
                consecutiveReds,
                heldHrs,
                candidate,
                failingTests,
                nowMs: Date.now(),
                ownership: ownership ?? undefined,
                causeDigest,
              }),
              Date.now(),
              ctx.workspaceId,
            ],
          );
        } catch (e) {
          console.warn(
            `${orchestratorStdoutTag()} stall escalation write failed: ${e instanceof Error ? e.message : e}`,
          );
        }
        // P-005: OPEN the `gate-red-streak:<harness>` condition, which is what turns
        // this red into exactly ONE claimable work-item (the condition bridge mints the
        // owner; see condition-bridge.ts's ACTIONABLE_CONDITIONS entry). Deliberately
        // inside the `!stallAlerted` edge with the two writes above, so all three fire
        // once per episode and the condition's lifetime IS the stall's.
        //
        // `oneShot: true` is load-bearing, not decoration (WI-6228): without it the
        // condition-staleness sweep reads this emitter's deliberate silence as recovery
        // and auto-resolves the condition on a timer — closing the owning work-item
        // while the gate is still red, which is worse than never minting one.
        try {
          const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
          const { gateRedStreakConditionKey } = await import('../../coord/gate-ownership');
          const ev = gateRedStreakBroadcast({
            installSlug: ctx.installSlug,
            consecutiveReds,
            heldHrs,
            candidate,
            failingTests,
            ownership: ownership ?? undefined,
            commitsBehindTip: staleness.commitsBehindTip,
          });
          await broadcastSevereEvent({
            summary: ev.summary,
            body: ev.body,
            category: 'severe-event',
            conditionKey: gateRedStreakConditionKey(ctx.installSlug),
            oneShot: true,
          });
        } catch (e) {
          console.warn(
            `${orchestratorStdoutTag()} red-streak condition broadcast failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }
    // Seed/carry the pin so the NEXT tick can detect movement (first observation
    // seeds it without resetting; an unchanged pin carries through).
    // EI-7472: PRESERVE the watchdog-owned dedup flag across red ticks. Without
    // this, the whole-object replace below drops `watchdogAlerted` back to absent
    // every hourly red fire, so the green-stall-watchdog re-fires its STALLED
    // severe-event ~hourly for the life of a red streak (it is designed one-shot
    // until recovery). This writer does not own the field — carry it through.
    // EI-7505: persist the failing-verdict-test list into gate_health itself (the
    // green-checkpoint action already parses it — see `failingTests` above — but
    // previously discarded it here, forcing responders to hand-spelunk
    // harness_shared.test_runs during a deploy-freeze, which is inconclusive
    // because that table mixes every agent's local dev-test runs with the verdict
    // run). Persisting it lets the green-stall-watchdog alarm body name the
    // failing test(s) directly, and makes it queryable via
    // `metadata->'gate_health'->'failingTests'` without any log-spelunking.
    // WI-4489: `observedAt`/`observedCandidate` — see the reset path above. This is the branch that
    // MATTERS: a RED is what misdirects (it dispatches the release-fixer at the tests it names), so
    // a red MUST carry the provenance that lets a reader judge whether it is still true.
    // EI-13288: the CLI's own re-triage already re-ran these EXACT named failing files at a
    // newer tip and they PASSED. Persist that evidence only when the refire was actually
    // BLOCKED (`autoRefire === false`). An auto-refiring pass is recorded before recursion so
    // a crashed refire still leaves a verdict, but it is an intermediate verdict — writing its
    // stale-cap fields would make gate-verdict-freshness claim "the auto-refire cap was reached"
    // while the rescue is still running (EI-20243738214569472). Missing autoRefire is treated as
    // unknown for this safety-critical field: an old CLI cannot prove the cap was reached.
    // (`retriageStale` / `retriageBlocked` are computed once above the branch — the
    // not-green reset arm records the same provenance, so they cannot be allowed to drift.)
    next = {
      consecutiveReds,
      lastGreenAt,
      firstRedAt,
      stallAlerted,
      // WI-42116: the ladder's high-water marks, persisted on EVERY red tick — including a
      // tick that did not notify, which is what makes the legacy `stallAlerted` seeding a
      // one-time migration rather than a decision re-taken every hour. `stallAlerted` above
      // stays the one-shot flag for the condition/escalation legs; these two carry the
      // human-notify ladder's position.
      stallAlertedAtReds,
      stallAlertedAtAgeMs,
      // EI-20706962612084953: the explicit verdict marker. Every write path states it, so a
      // reader never has to infer green-ness from a side-effect field like `lastGreenAt`.
      lastVerdict: promotionPending ? 'decision-pending' : 'not-green',
      lastFrom: fromPin ?? gh.lastFrom ?? null,
      // EI-20706962612084953: a red leaves `main` exactly where it found it.
      lastMainPin: mainPinAfterRun,
      pendingRunId: promotionPending ? (options.runId ?? null) : null,
      // EI-20571364274022293 — the PROVENANCE of the line above, and the only ordering evidence
      // this blob carries about the pin. `fromPin ?? gh.lastFrom` silently carries the PREVIOUS
      // pin forward whenever this run could not resolve the live one (a broken/orphaned release
      // worktree does exactly that), after which `lastFrom` is no longer "the pin at verdict
      // time" — it is "the pin the last time anyone could read one". A reader comparing it to the
      // live pin then sees a difference that may predate the red by hours and concludes, wrongly,
      // that the gate greened. Recording WHICH of the two branches produced the value is what
      // lets `evaluateGateVerdictFreshness` tell hard proof from a coincidence of two shas.
      lastFromFresh: fromPin != null,
      watchdogAlerted: gh.watchdogAlerted ?? false,
      failingTests: (failingTests ?? []).slice(0, 20),
      failingTestsMeasured: true,
      observedAt: Date.now(),
      observedCandidate: candidate?.slice(0, 12) ?? null,
      ...(testPassReuseRecord ? { testPassReuse: testPassReuseRecord } : {}),
      roundPhases: roundPhasesRecord,
      candidateSnapshot: verdictCandidateSnapshot,
      retriageStaleTip: retriageBlocked ? (retriage!.tip?.slice(0, 12) ?? null) : null,
      retriageDetail: retriageBlocked ? retriage!.detail : null,
      // WI-7482: the two fields above are stale-ONLY by design (paired + cleared together, per
      // the note above), which left a reader unable to distinguish the three non-stale outcomes:
      // the gate re-ran the red at tip and it genuinely reproduced (`real-red`); the gate could
      // not check at all (`unknown` — no tip, no runnable file, no runner wired); or no verdict
      // was recorded whatsoever (`null`). All three previously presented IDENTICALLY here, as
      // `retriageDetail: null` — which reads as "the gate never looked" and is wrong in two of
      // the three cases. That misreading is not hypothetical: it produced three separate wrong
      // reconstructions on 2026-08-02/03 (EI-19388705187359206 — filed against the parser, then
      // retracted; EI-19389700122825304; and this item's own first diagnosis).
      //
      // Deliberately ADDITIVE: the stale pair keeps its exact semantics and its consumers
      // (git-pipeline-stats, gate-verdict-freshness Rule 3) are untouched. This carries only the
      // machine-readable classification; the human-readable "why" for the non-stale cases now
      // lands in the persisted verdict log (green-checkpoint.ts, the re-triage append).
      retriageClassification: retriage?.classification ?? null,
      // EI-19329732364513693: this is the branch that MATTERS. A red names failing tests and
      // BOTH agents and the release-fixer dispatcher act on those names, so a red must carry
      // enough provenance for a reader to judge whether it is still true of the tree.
      candidateCommittedAt: staleness.candidateCommittedAt,
      commitsBehindTip: staleness.commitsBehindTip,
      // EI-19405864032365760: a real verdict supersedes any recorded preflight abort — see the
      // reset branch above for why this is explicit rather than left to the whole-key replace.
      inconclusive: null,
      // C4: a real verdict supersedes the hold tick's per-leg snapshot (P-009) — explicit,
      // because the final write now MERGES and no key is cleared by omission any more.
      repairTickLegs: null,
      // EI-21462211894072863: a RED is still a verdict — the gate ran and judged code — so it ends
      // a no-verdict streak just as a green does. Only a tick that produced NO verdict extends one.
      consecutiveNoVerdict: 0,
      noVerdictAlerted: false,
    };
  }
  // EI-20854484804457933: fold the value read above before writing, then repeat the
  // information-preserving guard against the CURRENT row value inside SQL. The latter is
  // necessary because two checkpoint observations can SELECT concurrently and the older,
  // less-informative snapshot can otherwise land after the completed run's populated verdict.
  // C4 (EI-22270968007901491): carry every key this writer does not own (freezeAndConverge,
  // inFlightCandidate, the fixer-succession marks, …) — see carryForeignGateHealthKeys. The
  // SQL below repeats the rule against the row's live value so a concurrent peer merge
  // between the SELECT above and this UPDATE cannot be clobbered either.
  next = carryForeignGateHealthKeys(gh as Record<string, unknown> | null, mergeGateHealthMonotonic(gh, next));
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{gate_health}',
          COALESCE(metadata->'gate_health', '{}'::jsonb) || (CASE
            WHEN jsonb_array_length(
              CASE WHEN jsonb_typeof(metadata->'gate_health'->'failingTests') = 'array'
                THEN metadata->'gate_health'->'failingTests' ELSE '[]'::jsonb END
            ) > 0
            AND jsonb_array_length(
              CASE WHEN jsonb_typeof($2::jsonb->'gate_health'->'failingTests') = 'array'
                THEN $2::jsonb->'gate_health'->'failingTests' ELSE '[]'::jsonb END
            ) = 0
            AND NULLIF(metadata->'gate_health'->>'observedCandidate', '') IS NOT NULL
            AND lower(metadata->'gate_health'->>'observedCandidate') =
                lower($2::jsonb->'gate_health'->>'observedCandidate')
            AND COALESCE(($2::jsonb->'gate_health'->>'lastFromFresh')::boolean, false) = false
            AND COALESCE($2::jsonb->'gate_health'->>'lastVerdict', '') <> 'green'
            THEN jsonb_set(
              jsonb_set(
                $2::jsonb->'gate_health',
                '{failingTests}',
                metadata->'gate_health'->'failingTests',
                true
              ),
              '{failingTestsCarriedForward}',
              'true'::jsonb,
              true
            )
            -- EI-18832825158594027: this branch is the RACE path — the TS fold saw no prior
            -- failures at SELECT time and therefore wrote false, but the row gained them
            -- before UPDATE. Stamping here too is what keeps the two layers from disagreeing;
            -- without it the concurrent case is the one that silently ships an unlabelled
            -- inherited list. The ELSE branch needs no reset: it writes next verbatim, and
            -- mergeGateHealthMonotonic has already set the flag false there.
            -- (No backticks in this comment: it lives inside a tagged template literal.)
            ELSE $2::jsonb->'gate_health'
          END),
          true
        ), updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
        AND workspace_id = $3`,
    [ctx.installSlug, JSON.stringify({ gate_health: next }), ctx.workspaceId],
  );
}

/** P-009 thresholds: a workspace that has flaked this often is "chronically
 *  flaky"; re-notify at most once a day per workspace. */
// P-016: CHRONIC-FLAKE thresholds are runtime-settable — see releaseCheckpointConfig().

/**
 * P-009: per-workspace flake history. The affected-tests runner prints
 * `>>> <ws> passed on retry — counted as a FLAKE` when a workspace FAILED then
 * PASSED on the gate's single retry — an EXPLICIT, PROVEN flake. A real
 * regression fails twice and never gets this marker, so tallying these respects
 * this plan's D-002 (classify before acting) + D-004 (a regression still holds
 * main). We accumulate the counts per workspace in the green-checkpoint routine
 * metadata (`flake_history`), surface them on the Git tab via
 * gitPipelineSnapshot().gate.flakyWorkspaces, and notify ONCE (per cooldown) when
 * a workspace becomes chronically flaky so it gets quarantined accountably — the
 * lock-respecting `quarantine.txt` edit + de-quarantine follow-up are the
 * release-fixer's / a human's job (D-003), never a tracked-file write from this
 * routine. Fail-safe — the routine tick never depends on it.
 */
async function trackFlakeHistory(ctx: SystemActionCtx, summary?: string, flakeSuspects?: string[]): Promise<void> {
  const flaked = new Set<string>();
  if (summary) {
    for (const m of summary.matchAll(/>>>\s+(\S+)\s+passed on retry — counted as a FLAKE/g)) {
      flaked.add(m[1]);
    }
  }
  // load-flake-isolation-2026-06-23: the per-file flakes the isolation pass absorbed
  // are PROVEN flakes too (failed under the gate's load, passed in an isolated re-run),
  // keyed by `<ws>::<file>` so the ledger distinguishes a chronically-flaky FILE from a
  // chronically-flaky workspace.
  for (const f of flakeSuspects ?? []) flaked.add(f);
  if (flaked.size === 0) return;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'flake_history' AS fh FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ fh: Record<string, { flakes?: number; lastFlakeAt?: number; notifiedAt?: number }> | null }>;
  const fh = rows[0]?.fh ?? {};
  const now = Date.now();
  const newlyChronic: string[] = [];
  for (const ws of flaked) {
    const prev = fh[ws] ?? {};
    const flakes = (prev.flakes ?? 0) + 1;
    let notifiedAt = prev.notifiedAt;
    if (
      flakes >= releaseCheckpointConfig().chronicFlakeCount &&
      (notifiedAt == null || now - notifiedAt > releaseCheckpointConfig().flakeNotifyCooldownMs)
    ) {
      newlyChronic.push(ws);
      notifiedAt = now;
    }
    fh[ws] = { flakes, lastFlakeAt: now, notifiedAt };
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ flake_history: fh })],
  );
  if (newlyChronic.length > 0) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'Chronically-flaky test(s) in the release gate',
        body: `${newlyChronic.join(', ')} has flaked ≥${releaseCheckpointConfig().chronicFlakeCount}× in the green-checkpoint suite (failed then passed on retry). Quarantine it accountably (quarantine.txt + a de-quarantine follow-up) so it stops risking gate stalls.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: { workspaces: newlyChronic.join(',') },
      });
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} flake notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Persisted release-fixer dedup record (green-checkpoint routine metadata `last_fixer`). */
export interface ReleaseFixerRecord {
  /** Stable failure signature (sorted failing test files) — dedup key across candidates. */
  signature?: string;
  candidate?: string;
  /** When the fixer was last dispatched for this signature (epoch ms). */
  at?: number;
  /** The dispatched fixer's spawn id (fire-and-forget path) — null on the DBOS-durable
   *  path (which re-fires on crash itself) or a legacy record predating this field.
   *  THE signal P-014/D-009 added: the id we check liveness against. */
  spawnId?: string | null;
  runId?: string | null;
  /** CandidateSnapshot.identity used to reserve and patch this record safely. */
  snapshotIdentity?: string;
  /** When the human was last notified for this signature (notify cooldown, separate from dispatch). */
  notifiedAt?: number;
}

/**
 * EI-8740: should a held (`not-green`/`advanced-prefix`) gate verdict dispatch a
 * release-fixer at all?
 *
 * P-016 (D-010): on 'advanced-prefix' the longest-green PREFIX was promoted but the
 * batch TIP is still red — `candidate` is that red tip + `failingTests` its failures,
 * so the fixer dispatch is identical to a full hold (it must still fix the red tip).
 *
 * A verdict with an EMPTY `failingTests` means there is no failing TEST to fix —
 * either a setup/tooling failure before any test ran (e.g. a pot with a `package.json`
 * but no `test:affected` script — "Missing script", distinct from the no-`package.json`
 * case EI-8744 already flips to vacuously-green) or a phantom candidate from a stalled
 * advance. A release-fixer's contract is to fix a failing test; dispatching it with
 * nothing to reproduce is a guaranteed no-op that only classifies-and-escalates —
 * observed as hourly wasted-spawn churn on codeless E2E-scaffold pots (dummy-pot-0707,
 * spoon-knife-hive). `trackGateStall` (the caller's sibling step) still fires the
 * human-facing "held too long" alert regardless of this gate, so a genuinely-stuck gate
 * is never silently dropped — this only spares the pointless fixer spawn.
 *
 * EI-20029143927692821: the same reasoning applies to a red the run has ALREADY PROVEN stale by
 * its own hand. When `retriage` reports `classification: 'stale-candidate'`, the CLI re-ran these
 * exact failing files at a newer tip and watched them PASS — the strongest negative evidence the
 * gate ever produces. Dispatching a fixer at those names asks an agent to re-derive from scratch a
 * conclusion this very verdict already carries; it reproduces nothing and stands down. Measured
 * cost: one full release-fixer agent per occurrence, recurring whenever a torn sweep lands near
 * the refire cap.
 *
 * This REUSES `isProvenStaleCandidate` rather than keying on the reader-side name for the same
 * evidence (`verdictStaleReasonCode === 'retriage-proven'`, gate-verdict-freshness.ts Rule 3), so
 * that ONE definition of "proven stale" governs BOTH decisions the evidence bears on — whether the
 * red moves the streak (`classifyGateTick` → 'record-only') and whether it spends an agent. Two
 * copies of this predicate would be free to drift; there is only one.
 *
 * ⚠ THE `charged-budget` CARVE-OUT IS LOAD-BEARING, and is why this is NOT a blanket "suppress
 * whenever the re-triage proved staleness". `refireBlockedBy === 'charged-budget'` means the SAME
 * breakage survived every rescue, which the operator text calls out as "the tip is genuinely
 * broken: a human is needed" — precisely when a fixer IS wanted. `isProvenStaleCandidate` already
 * encodes that single exclusion; the other three blockers are not evidentiary (`deadline` is a
 * clock, `cap-disabled` a feature switch, and `absolute-ceiling`'s own operator text says "the fix
 * is to slow the tree or widen the window, NOT to debug the files named above").
 *
 * `retriage` is REQUIRED, not optional, so a future dispatch site must ANSWER the question instead
 * of silently inheriting the un-guarded behaviour. Pass `undefined` when the caller genuinely has
 * no re-triage verdict (old CLI payload, or no tip re-run happened): absent evidence dispatches,
 * which is the fail-open direction — an unproven red still gets its fixer.
 */
export function shouldDispatchReleaseFixer(
  status: string,
  candidate: string | undefined,
  failingTests: string[] | undefined,
  retriage: GateStallRetriage | null | undefined,
): candidate is string {
  return (
    (status === 'not-green' || status === 'advanced-prefix') &&
    !!candidate &&
    !!failingTests &&
    failingTests.length > 0 &&
    !isProvenStaleCandidate(retriage)
  );
}

export interface ReleaseFixerDecision {
  /** (Re-)dispatch a fixer this tick. */
  dispatch: boolean;
  /** Notify the human this tick (rate-limited separately from dispatch). */
  notify: boolean;
  reason: 'fresh' | 'covered' | 'self-heal';
}

/** The fixer dedup / self-heal window (2h). The signature dedup that was the ONLY
 *  guard before P-014; now the liveness check overrides it for a dead fixer. */
export const RELEASE_FIXER_DEDUP_MS = 2 * 60 * 60_000;

/**
 * PURE dispatch decision (agent-activity-liveness-truth-2026-06-21 P-014 / D-009).
 *
 * The old dedup was purely TIME-based — skip a same-signature re-dispatch for 2h —
 * so a fixer that DIED inside the window left the gate red + UNCOVERED for up to 2h
 * (the 2026-06-21 incident: a dead gate-fix bee mistaken for "actively fixing it").
 * Now liveness-aware: within the window we skip ONLY if the dispatched fixer is
 * still ALIVE; a dead fixer re-dispatches immediately (self-heal). Notify is
 * decided separately (rate-limited) so an hourly self-heal re-dispatch can't spam.
 *
 * @param fixerAlive caller's liveness verdict for the recorded fixer spawn:
 *   `true` = running + fresh heartbeat (covered); `false` = confirmed GONE
 *   (dead / finished / stale heartbeat) → re-dispatch; `null` = UNKNOWN (no spawn
 *   id to check — a DBOS-durable fire that self-recovers, or a legacy record) →
 *   treated as covered within the window, so we never regress to hammering.
 */
export function decideReleaseFixerDispatch(args: {
  lf: ReleaseFixerRecord | null;
  signature: string;
  now: number;
  fixerAlive: boolean | null;
  dedupMs?: number;
  notifyCooldownMs?: number;
}): ReleaseFixerDecision {
  const dedupMs = args.dedupMs ?? RELEASE_FIXER_DEDUP_MS;
  const notifyCooldownMs = args.notifyCooldownMs ?? RELEASE_FIXER_DEDUP_MS;
  const { lf, signature, now } = args;
  const sameRecent = !!lf && lf.signature === signature && typeof lf.at === 'number' && now - lf.at < dedupMs;
  if (!sameRecent) {
    // A fresh failure (new signature, or the prior one aged out) — dispatch + notify.
    return { dispatch: true, notify: true, reason: 'fresh' };
  }
  // Same failure within the window: the liveness-aware gate (D-009).
  if (args.fixerAlive !== false) {
    // alive (true) OR unknown (null — durable/legacy) → a fixer is (presumed) on it.
    return { dispatch: false, notify: false, reason: 'covered' };
  }
  // The previously-dispatched fixer is CONFIRMED GONE → self-heal: re-dispatch now.
  // Re-notify only past the notify cooldown so an hourly self-heal doesn't spam.
  const lastNotify = lf.notifiedAt ?? lf.at ?? 0;
  return { dispatch: true, notify: now - lastNotify > notifyCooldownMs, reason: 'self-heal' };
}

/**
 * Re-exported from `../../release/fixer-liveness` — moved there so read-side surfaces (the
 * pipeline snapshot / release:trace) can resolve fixer liveness WITHOUT importing this
 * module, whose `registerSystemAction` calls run at import. Re-exported rather than
 * relocated-and-updated-at-every-callsite so existing importers keep working, and so there
 * stays exactly one definition shared by the dispatcher and the ownership renderer.
 */
export { releaseFixerSpawnAlive };

/**
 * EI-7443: render each CURRENTLY-failing test file's 7d flake stats (from
 * `flagFlakeSuspects`) as a one-line-per-file annotation the release-fixer's
 * kickoff can lead with — so it sees flake-vs-regression immediately instead of
 * re-deriving it from scratch. Pure (no PG) so it's unit-testable without a live
 * DB; the DB round-trip (`testFlakeRollup`) lives in the thin caller below.
 * Returns undefined when no failing file matches a flagged suspect (the common
 * case — most gate reds ARE real regressions, not flakes) so callers can skip
 * the annotation entirely rather than append an empty section.
 */
export function annotateFailingTestsWithFlakeStats(
  failingTests: string[] | undefined,
  suspects: FlakeSuspect[],
): string | undefined {
  if (!failingTests?.length || !suspects.length) return undefined;
  const byFile = new Map(suspects.map((s) => [s.file_path, s]));
  const lines = failingTests
    .map((f) => byFile.get(f))
    .filter((s): s is FlakeSuspect => !!s)
    .map(
      (s) =>
        `  - ${s.file_path}: ${s.fails}F/${s.passes}P over 7d, ${s.both_status_shas} commit(s) with both a pass and a fail (flake_rate=${s.flake_rate})`,
    );
  if (lines.length === 0) return undefined;
  return (
    `FLAKE SIGNAL (EI-7443, from the last 7d of harness_shared.test_runs — check this BEFORE assuming a regression):\n` +
    lines.join('\n')
  );
}

/** Result of a `git` invocation used only for the stale-candidate re-verify guard below —
 *  `ok` mirrors a zero exit code; `stdout` is trimmed. Never throws. */
export interface GitCheckResult {
  ok: boolean;
  stdout: string;
}

/** Injectable git runner (test seam) for {@link checkReleaseFixerCandidateStale}. Reuses
 *  the ALREADY-imported/mocked `spawn` (this file's tests mock `node:child_process` with
 *  only `spawn`) rather than pulling in `execFile`, so the default path stays exercisable
 *  under the existing test mock without widening it. */
export type GitCheckRunner = (root: string, args: string[]) => Promise<GitCheckResult>;

const defaultGitCheckRunner: GitCheckRunner = (root, args) =>
  new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn('git', ['-C', root, ...args]);
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve({ ok: false, stdout: '' }));
      child.on('close', (code) => resolve({ ok: code === 0, stdout: out.trim() }));
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });

/** Live re-verify inputs for {@link isStaleReleaseFixerCandidate} — see that function for
 *  the semantics of each flag. */
export interface ReleaseFixerCandidateStaleCheck {
  candidateExists: boolean;
  candidatePromoted: boolean;
}

/**
 * EI-8718: is `candidate` still worth dispatching a release-fixer for, RIGHT NOW — or has
 * it gone stale since the checkpoint run that reported it red? A long suite run (up to
 * 120min, per GREEN_CHECKPOINT_SUITE_TIMEOUT_MS) can finish red for a candidate the gate
 * has since moved past by other means (a later run, a manual force, GC) — dispatching a
 * fixer for it is then a guaranteed wasted spawn with nothing left to fix (observed:
 * candidate 2e7f9d7 present in no tree, gate green + promoted, 2 fixers dispatched for it).
 *
 * Checks BOTH:
 *  - `candidateExists` — `git cat-file -e <sha>^{commit}` in the integration checkout.
 *    False means the object was superseded and GC'd — definitely nothing to fix.
 *  - `candidatePromoted` — `candidate` is already reachable from `origin/main` HEAD (i.e.
 *    `origin/main` fast-forwarded PAST it). Only a green-verified commit ever reaches
 *    `origin/main`, so if `candidate` is an ancestor-or-equal of it, the gate already
 *    resolved this candidate to green by other means — nothing left to fix.
 *
 * Read-only (no `git fetch`) — reads the already-fetched `origin/main` ref, same
 * invariant as git-pipeline-position.ts's refContains.
 *
 * Deliberately does NOT suppress a genuinely still-red, not-yet-promoted candidate: a
 * valid object that `origin/main` does not yet contain is exactly the legitimate-dispatch
 * case (the CRITICAL danger the prior needs-human STOP flagged — never freeze the fixer
 * path on an actually-red gate).
 */
export function isStaleReleaseFixerCandidate(check: ReleaseFixerCandidateStaleCheck): boolean {
  return !check.candidateExists || check.candidatePromoted;
}

/**
 * WI-2140605. TRUE when a FROZEN-REPAIR dispatch would hand a reproduce-style fixer an
 * empty failure set — i.e. there is provably nothing to reproduce.
 *
 * Pure (no PG, no git) so it is unit-testable without a live DB, matching
 * `isStaleReleaseFixerCandidate` above.
 *
 * Why this is a dispatch-time question and not the fixer's problem to discover: the brief
 * `buildReleaseFixerKickoff` produces is "identify the exact failing tests, reproduce, fix
 * hermetically". With an empty set that brief is unexecutable BY CONSTRUCTION — the fixer
 * has no target, so it parks at "reproduce" rather than failing usefully. Measured
 * 2026-09-01 on candidate edaf692e: three consecutive fixers died/parked exactly there
 * against `failingTests=[]` while the verdict was itself stale.
 *
 * Scoped to the frozen-repair path on purpose. A fresh-verdict red whose failing set was
 * merely not extracted is a different question, and widening this predicate to cover it
 * would risk suppressing a legitimate dispatch on a genuinely red gate — the one outcome
 * the fixer path must never have.
 *
 * EI-22216541327801093: an EMPTY `failingTests` is not the only shape of "nothing to
 * reproduce". A plain inconclusive hold tick with no `repairTickLegs` data (run-lock
 * contention, a killed pass, …) stamps `gate_health.failingTestsMeasured:false` while
 * leaving the PRIOR tick's `failingTests` names untouched in the DB (see the hold-tick
 * write in `trackGateStall` — the branch with no `tickLegs`), so the array this function
 * sees can be non-empty yet describe nothing this tick actually verified. Measured on
 * candidate 5fdc2b24b770: `failingTests` named two lint legs, `failingTestsMeasured` was
 * `false` and `failingTestsCarriedForward` was `false` (so this is not the legitimate
 * `mergeGateHealthMonotonic` carry-forward, which deliberately leaves `failingTestsMeasured`
 * `true`), and three release-fixer dispatches then found all three legs passing.
 *
 * `failingTestsMeasured` is therefore an explicit third input, checked ONLY when it is the
 * literal `false` — `undefined`/`null` (measured flag genuinely unknown, or the caller
 * legitimately omitted it, as every pre-existing call site + test still does) preserves
 * the original array-emptiness behaviour exactly, so this stays backward compatible and
 * never turns "unknown" into a suppression a caller did not ask for.
 */
export function frozenRepairHasNoMeasuredFailures(
  repairQueue: FrozenCandidateRepairQueue | undefined,
  failingTests: string[] | undefined,
  failingTestsMeasured?: boolean | null,
): boolean {
  if (!repairQueue) return false;
  if (failingTestsMeasured === false) return true;
  return !failingTests || failingTests.length === 0;
}

/**
 * WI-10003213: the live-row form of the dispatcher's no-measured-failures refusal — reads
 * `gate_health.failingTestsMeasured` exactly as `dispatchReleaseFixer` does and applies the
 * same predicate to the queue's own failing set, so green-checkpoint's once-per-head
 * unmeasured-red retest fires precisely when the dispatcher would refuse. Any read failure
 * answers false (keep the old dispatch-only behaviour).
 *
 * Also true when the latest repair tick re-ran every queue signature at the current
 * repairHead and each passed (`repairTickClearedQueueSignature`): a red the gate cannot
 * reproduce at the same head leaves the dispatcher skipping on a snapshot mismatch every
 * tick, which is the same deadlock reached by a different refusal.
 */
export async function frozenRepairRedIsUnmeasured(
  ctx: GateVerdictTarget,
  repairQueue: FrozenCandidateRepairQueue,
): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gate_health'->>'failingTestsMeasured' AS ftm,
              metadata->'gate_health'->'repairTickLegs' AS legs
         FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
      [ctx.installSlug],
    )) as Array<{ ftm: string | null; legs: unknown }>;
    const ftm = rows[0]?.ftm === 'true' ? true : rows[0]?.ftm === 'false' ? false : null;
    if (frozenRepairHasNoMeasuredFailures(repairQueue, repairQueue.failingTests, ftm)) return true;
    const { parseRepairTickLegs, repairTickClearedQueueSignature } =
      await import('../../release/repair-tick-legs-snapshot');
    return repairTickClearedQueueSignature(parseRepairTickLegs(rows[0]?.legs), repairQueue);
  } catch {
    return false;
  }
}

/**
 * Build the release-fixer's task brief at the single dispatch seam.
 *
 * Frozen repairs are delegated children of the gate owner. The parent keeps the
 * LIVE_GATE_OPS singleton, while this child owns only the already-authorized
 * repair worktree. The old inline brief described the worktree but never stated
 * that distinction, so the shared no-duplicate rule interpreted the parent's
 * live hold as a competing fixer and exited before testing. Keep the exception
 * explicit and machine-verifiable: the child must call release:repair-queue{op:get}
 * and proceed only when callerAuthorization.status is `authorized-delegate`, which
 * means its verified signed spawn id equals the queue's fixerSpawnId.
 */
export function buildReleaseFixerKickoff(input: {
  candidate: string;
  failingTests?: readonly string[];
  repairQueue?: FrozenCandidateRepairQueue | null;
  flakeAnnotation?: string;
}): string {
  const queue = input.repairQueue;
  const kickoff = queue
    ? `green-checkpoint froze candidate ${queue.candidate.slice(0, 8)} and assigned you repair attempt ${queue.attempts + 1}. ` +
      `You are the AUTHORIZED delegated repair child, not a second LIVE_GATE_OPS owner. ` +
      `The parent gate owner intentionally retains the singleton hold; do NOT stop because ` +
      `gate.greenCheckpoint.ownership reports held-live. Before editing, call ` +
      `release:repair-queue { op: 'get' } and require ` +
      `callerAuthorization.status='authorized-delegate' (authorized=true): your VERIFIED ` +
      `signed spawn id must exactly equal repairQueue.fixerSpawnId. If the status is queue-unassigned, ` +
      `retry that read for a bounded handoff window; any other status is a fail-closed STOP, not permission ` +
      `to take over — EXCEPT: if your live MCP client dropped and you fell back to the sanctioned ` +
      `scripts/mcp-call.mjs recovery path, that transport authenticates you as an operator, not your ` +
      `signed release-fixer spawn, so this SAME read reports status='not-applicable' by design — that is ` +
      `NOT evidence you lost delegation. In that one case, compare the read's repairQueue.fixerSpawnId ` +
      `directly against your own PAPERCUSP_SID: if they still match and repairQueue.phase is still ` +
      `'awaiting-fixer', you remain the delegated fixer and may proceed (this tool independently ` +
      `authorizes an operator-role caller to converge); if they do not match, or the phase moved on, the ` +
      `queue was reassigned or closed — stop. Once authorized, author the fix in the canonical ` +
      `staging checkout under its normal file locks (D-010: there is NO repair worktree). The frozen ` +
      `lineage is at repairHead ${queue.repairHead}; \`git show ${queue.repairHead}:<path>\` is the blob ` +
      `you are fixing. Run focused tests, then ADMIT exactly the paths you changed with ` +
      `release:repair-queue { op: 'admit', paths: [...] } — dry-run first, then confirm: true. That ` +
      `admission is the ONLY way your fix reaches the judged lineage; an un-admitted edit is invisible ` +
      `to the gate. Do NOT claim the gate, launch a checkpoint, mutate deployment, commit, or push — ` +
      `git-sync and the gate finalizer own those steps.`
    : `green-checkpoint held \`main\`: candidate ${input.candidate.slice(0, 8)} failed the gate suite. ` +
      `Read the exact supplied checkpoint artifact, reproduce the failing test(s) locally to classify ` +
      `regression-vs-flake, then fix the code or de-flake (hermetic > tier-out > accountable quarantine). ` +
      `Do NOT push — the next checkpoint re-verifies.`;
  return kickoff + (input.flakeAnnotation ? `\n\n${input.flakeAnnotation}` : '');
}

/** Live-compute {@link ReleaseFixerCandidateStaleCheck} for `candidate` in `root`. */
export async function checkReleaseFixerCandidateStale(
  root: string,
  candidate: string,
  runner: GitCheckRunner = defaultGitCheckRunner,
): Promise<ReleaseFixerCandidateStaleCheck> {
  const exists = await runner(root, ['cat-file', '-e', `${candidate}^{commit}`]);
  const candidateExists = exists.ok;
  if (!candidateExists) return { candidateExists, candidatePromoted: false };
  // `origin/main..<candidate>` lists commits reachable from candidate but not from
  // origin/main; a count of 0 means origin/main's history already contains candidate.
  const ahead = await runner(root, ['rev-list', '--count', `origin/main..${candidate}`]);
  const candidatePromoted = ahead.ok && ahead.stdout === '0';
  return { candidateExists, candidatePromoted };
}

/** D-001 / WI-39944: read/write the one serialized frozen-candidate repair queue
 * inside the green-checkpoint routine's EXISTING metadata row. This deliberately does
 * not create a parallel table, routine, or ownership record. */
export async function readFrozenCandidateRepairQueueState(
  target: GateVerdictTarget,
): Promise<FrozenCandidateRepairQueueRead> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'repair_queue' AS repair_queue
       FROM harness_shared.routines
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'`,
    [target.workspaceId, target.installSlug],
  )) as Array<{ repair_queue: unknown }>;
  return parseFrozenCandidateRepairQueueRead(rows[0]?.repair_queue);
}

/**
 * Compatibility reader for callers that still consume `queue | null`.
 *
 * A real absence remains null. A present row this build cannot parse THROWS so every legacy
 * caller's existing failure path remains fail-closed; returning null here would tell the gate
 * that no candidate is frozen and reopen the moving-tip treadmill during schema skew.
 */
export async function readFrozenCandidateRepairQueue(
  target: GateVerdictTarget,
): Promise<FrozenCandidateRepairQueue | null> {
  const read = await readFrozenCandidateRepairQueueState(target);
  if (read.status === 'value') return read.queue;
  if (read.status === 'absent') return null;
  throw new Error(
   `${describeUnreadableFrozenCandidateRepairQueue(read)} — ` +
     'refusing to treat a persisted row as absent',
  );
}

/**
 * P-021 (D-007 #1): the per-leg output tails the gate's last repair tick persisted
 * (`gate_health.repairTickLegs[].outputTail`) — the only evidence of WHICH files a lint /
 * post-suite leg reported, and therefore of that leg's subject paths. Read raw on purpose:
 * `parseRepairTickLegs` deliberately drops `outputTail`. Any fault reads as "no evidence",
 * which the manifest renders as pathless — never as a fabricated path.
 */
async function readRepairTickLegOutputs(
  sql: Pick<import('../../work-items').OrgSql, 'unsafe'>,
  target: GateVerdictTarget,
): Promise<Record<string, string>> {
  try {
    const rows = (await sql.unsafe(
      `SELECT metadata->'gate_health'->'repairTickLegs' AS legs
         FROM harness_shared.routines
        WHERE workspace_id = $1 AND install_slug = $2 AND target_role = 'system:green-checkpoint'
        LIMIT 1`,
      [target.workspaceId, target.installSlug],
    )) as unknown as Array<{ legs?: unknown }> | undefined;
    const raw = Array.isArray(rows) ? rows[0]?.legs : undefined;
    const legs = raw && typeof raw === 'object' && Array.isArray((raw as { legs?: unknown }).legs)
      ? ((raw as { legs: unknown[] }).legs as Array<Record<string, unknown>>)
      : [];
    const out: Record<string, string> = {};
    for (const leg of legs) {
      if (leg && typeof leg.id === 'string' && typeof leg.outputTail === 'string') out[leg.id] = leg.outputTail;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * P-021 (D-007 #1): push the manifest onto the gate-red work-item — the `gate-red-streak:` /
 * `frozen-repair-convergence:` condition singleton(s) open for this install — as a structured
 * payload on every status move and as a rendered comment when the LEG SET changes (a freeze,
 * a new red leg). Never fatal: a queue that could not be described is still correctly frozen.
 */
async function publishRepairManifestToGateWorkItem(
  sql: Pick<import('../../work-items').OrgSql, 'unsafe'>,
  target: GateVerdictTarget,
  outcome: { manifest: import('../../release/repair-manifest').RepairManifest; signatureChanged: boolean; statusChanged: boolean },
): Promise<void> {
  if (!outcome.signatureChanged && !outcome.statusChanged) return;
  const { ANY_FAMILY_TERMINAL_STATES } = await import('../../work-item-dispatch-states');
  const rows = (await sql.unsafe(
    `SELECT feature_id, harness_slug
       FROM harness_shared.work_items
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND (condition_key LIKE 'gate-red-streak:%' OR condition_key LIKE 'frozen-repair-convergence:%')
        AND NOT (status = ANY($3::text[]))
      ORDER BY created_ts DESC
      LIMIT 4`,
    [target.workspaceId, target.installSlug, [...ANY_FAMILY_TERMINAL_STATES]],
  )) as unknown as Array<{ feature_id: string; harness_slug: string }> | undefined;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const { renderRepairManifest, summarizeRepairManifest } = await import('../../release/repair-manifest');
  const { commentWorkItem, mergeWorkItemPayload } = await import('../../work-items');
  const summary = summarizeRepairManifest(outcome.manifest);
  for (const row of rows) {
    await mergeWorkItemPayload(
      row.feature_id,
      { repairManifest: outcome.manifest, repairManifestSummary: summary },
      { harness: row.harness_slug },
    );
    if (outcome.signatureChanged) {
      await commentWorkItem(row.feature_id, renderRepairManifest(outcome.manifest), 'system:green-checkpoint', {
        harness: row.harness_slug,
      });
    }
  }
}

/**
 * P-027 (D-014): the row-version guard on `writeFrozenCandidateRepairQueue`.
 *
 * `expectedUpdatedAtMs` is the `updatedAtMs` the caller's copy of the row carried when it was
 * READ (a number), or `null` to assert that the routine row carries NO queue yet (the create
 * path). The UPDATE always matches only a row at that version; a miss throws
 * `FrozenRepairQueueWriteConflictError` carrying the fresh read so the caller can re-apply its
 * pure reducer to the row that actually exists. Every write states either the version it read
 * or null to assert that the routine row carries no queue yet.
 */
export interface WriteFrozenCandidateRepairQueueOptions {
  expectedUpdatedAtMs: number | null;
}

export class FrozenRepairQueueWriteConflictError extends Error {
  readonly code = 'frozen-repair-queue-write-conflict' as const;
  constructor(
    readonly expectedUpdatedAtMs: number | null,
    readonly fresh: FrozenCandidateRepairQueueRead,
  ) {
    super(
      `frozen repair queue write conflict: expected row version ${
        expectedUpdatedAtMs === null ? 'ABSENT' : `updatedAtMs=${expectedUpdatedAtMs}`
      }, found ${
        fresh.status === 'value'
          ? `updatedAtMs=${fresh.queue.updatedAtMs} at repairHead ${fresh.queue.repairHead.slice(0, 12)} (${fresh.queue.phase})`
          : fresh.status
      } — re-read the row and re-apply the transition to it`,
    );
    this.name = 'FrozenRepairQueueWriteConflictError';
  }
}

export function isFrozenRepairQueueWriteConflict(e: unknown): e is FrozenRepairQueueWriteConflictError {
  return (
    e instanceof FrozenRepairQueueWriteConflictError ||
    (!!e && typeof e === 'object' && (e as { code?: unknown }).code === 'frozen-repair-queue-write-conflict')
  );
}

export type FrozenRepairQueueTransition = (fresh: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue;

export interface FrozenRepairQueueTransitionOutcome {
  /**
   * `written` — the reducer's result was CAS-written on top of the fresh row.
   * `unchanged` — the reducer returned the fresh row itself (identity): nothing to persist. This
   *   is the SUPERSEDED verdict case: the run measured a head the row has already moved past.
   * `absent` — no queue is on the row (retired between the caller's read and now); nothing was
   *   written, because resurrecting a retired queue from a stale copy is the lost-update in the
   *   other direction.
   */
  status: 'written' | 'unchanged' | 'absent';
  /** The row as it stands after the call — the fresh-derived object, never the caller's copy. */
  queue: FrozenCandidateRepairQueue | null;
  /** Fresh row the reducer was applied to (null when absent). */
  fresh: FrozenCandidateRepairQueue | null;
  /** CAS misses absorbed before the write landed. */
  retries: number;
}

/**
 * P-027 (D-014): re-read → reduce → CAS-write, the one safe way to move a queue row whose
 * in-memory copy may be older than the row (a green-checkpoint run reads the queue once and
 * then runs a suite for up to an hour; `release:repair-queue { op:'admit' }` advances the row
 * meanwhile). The reducer is applied to the FRESH row, so an admission that landed in between
 * is carried, not overwritten; a CAS miss (another writer moved the row after our re-read) is
 * absorbed by re-reading and re-applying, up to `maxAttempts`.
 *
 * The row version is `updatedAtMs`. A reducer that does not advance it (same-ms transition,
 * or one that only re-arranges fields) is bumped by one ms so two writers can never both pass
 * the same predicate — the version must move on every persisted write or the CAS is decorative.
 * A reducer that returns the fresh row ITSELF (identity) writes nothing (`unchanged`).
 */
export async function applyFrozenCandidateRepairQueueTransition(
  target: GateVerdictTarget,
  transition: FrozenRepairQueueTransition,
  opts: { maxAttempts?: number } = {},
): Promise<FrozenRepairQueueTransitionOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let lastConflict: FrozenRepairQueueWriteConflictError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const read = await readFrozenCandidateRepairQueueState(target);
    if (read.status === 'unreadable') {
      throw new Error(
        `${describeUnreadableFrozenCandidateRepairQueue(read)} — refusing to transition a row this build cannot parse`,
      );
    }
    if (read.status === 'absent') return { status: 'absent', queue: null, fresh: null, retries: attempt };
    const fresh = read.queue;
    let next = transition(fresh);
    if (next === fresh) return { status: 'unchanged', queue: fresh, fresh, retries: attempt };
    if (!(next.updatedAtMs > fresh.updatedAtMs)) next = { ...next, updatedAtMs: fresh.updatedAtMs + 1 };
    try {
      await writeFrozenCandidateRepairQueue(target, next, { expectedUpdatedAtMs: fresh.updatedAtMs });
      return { status: 'written', queue: next, fresh, retries: attempt };
    } catch (e) {
      if (!isFrozenRepairQueueWriteConflict(e)) throw e;
      lastConflict = e;
    }
  }
  throw lastConflict ?? new Error('frozen repair queue transition exhausted its attempts');
}

export async function writeFrozenCandidateRepairQueue(
  target: GateVerdictTarget,
  queue: FrozenCandidateRepairQueue | null,
  opts: WriteFrozenCandidateRepairQueueOptions,
): Promise<void> {
  if (!opts || opts.expectedUpdatedAtMs === undefined) {
    throw new Error('writeFrozenCandidateRepairQueue requires an explicit expectedUpdatedAtMs');
  }
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // P-027 (D-014): the required CAS predicate. `updatedAtMs` is compared as TEXT (integer-ms
  // digits are exact on both sides; the reserve/renew CAS further down does the same), and an
  // expected ABSENCE matches only a row that carries no queue at all. `$N` is the next
  // positional parameter after the statement's own — each branch below passes its base count.
  const expected = opts.expectedUpdatedAtMs;
  const casClause = (nextParam: number): string =>
    expected === null
      ? `\n          AND metadata->'repair_queue' IS NULL`
      : `\n          AND metadata->'repair_queue'->>'updatedAtMs' = $${nextParam}::text`;
  const casParams: string[] = typeof expected === 'number' ? [String(expected)] : [];
  const assertWritten = async (rows: unknown): Promise<void> => {
    const written = Array.isArray(rows)
      ? rows.length
      : typeof (rows as { count?: unknown } | null)?.count === 'number'
        ? ((rows as { count: number }).count)
        : 0;
    if (written > 0) return;
    throw new FrozenRepairQueueWriteConflictError(expected, await readFrozenCandidateRepairQueueState(target));
  };
  // P-021 (D-007 #1): the repair manifest is DERIVED HERE, in the one production write path, so
  // it cannot describe a different row than the one persisted beside it. `withRepairManifest`
  // carries leg claims from the row's previous manifest and reports whether the leg set moved.
  let manifested: import('../../release/repair-manifest').WithRepairManifestResult<FrozenCandidateRepairQueue> | null = null;
  if (queue) {
    const { withRepairManifest } = await import('../../release/repair-manifest');
    // WI-10002500: the manifest is a PURE derivation, so the npm-workspace name→dir map is
    // resolved here (the one place that may do I/O) and passed in. Without it a workspace-task
    // leg's mined paths stay workspace-relative and can never join the repo-relative admission
    // ledger, which made every such leg read `red-at-candidate` even after its fix had landed.
    const { npmWorkspaceDirsByName } = await import('../../release/npm-workspace-dirs');
    manifested = withRepairManifest(queue, Date.now(), {
      legOutputs: await readRepairTickLegOutputs(sql, target),
      workspaceDirs: npmWorkspaceDirsByName(resolveIntegrationRoot()),
    });
    queue = manifested.queue;
    // P-013 / D-007: project the convergence summary into `gate_health.convergence` in the
    // SAME statement that persists the queue.
    //
    // Why here and not a second writer: this is the one production write path for
    // `repair_queue`, so a projection made here can never lag the queue it describes — there
    // is no window in which the stored shrink figures are about a previous round. A separate
    // best-effort writer (the `mergeGateHealth` marker idiom used by `inFlightRetriage`) would
    // reintroduce exactly that window, and its failure mode is a convergence panel confidently
    // reporting the round before last.
    //
    // The gate_health leg is a SHALLOW merge (`|| $4`), never a replace: the red streak,
    // failing-test list and `observedCandidate` are written by other paths at other times, and
    // a replace here would silently clobber whichever of them a concurrent reader depends on.
    // `jsonb_set(..., true)` creates `gate_health` when the row has none.
    const convergence = buildFrozenRepairConvergenceGateHealth(queue, Date.now());
    // An admission moves repairHead while the predecessor qualification may still be
    // terminal or finishing its old physical run. Persist the NEW unjudged head beside
    // the queue in this one CAS statement; the successor begin consumes this handoff.
    const latestAdmission = queue.admissions?.at(-1);
    const handoff = queue.qualificationAttemptId && latestAdmission?.toRepairHead === queue.repairHead
      ? { from: latestAdmission.fromRepairHead, to: queue.repairHead,
          attemptId: queue.qualificationAttemptId, atMs: queue.updatedAtMs }
      : null;
    const queueWithHandoff = handoff
      ? `CASE WHEN metadata->'repair_queue'->>'repairHead' = $5::text
           THEN jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                            '{qualificationTransaction,pendingRepairHead}', to_jsonb($6::text), true),
                  '{qualificationTransaction,updatedAtMs}', to_jsonb($8::bigint), true)
           ELSE COALESCE(metadata, '{}'::jsonb) || $3::jsonb END`
      : `COALESCE(metadata, '{}'::jsonb) || $3::jsonb`;
    const handoffGuard = handoff
      ? ` AND (metadata->'repair_queue'->>'repairHead' = $6::text
                OR (metadata->'repair_queue'->>'repairHead' = $5::text
                    AND metadata->'qualificationTransaction'->>'attemptId' = $7::text))`
      : '';
    const written = await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                ${queueWithHandoff},
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb) || $4::jsonb,
                true
              ),
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'${handoffGuard}${casClause(handoff ? 9 : 5)}
        RETURNING true AS written`,
      [
        target.workspaceId,
        target.installSlug,
        JSON.stringify({ repair_queue: queue }),
        JSON.stringify({ convergence }),
        ...(handoff ? [handoff.from, handoff.to, handoff.attemptId, String(handoff.atMs)] : []),
        ...casParams,
      ],
    );
    await assertWritten(written);
  } else {
    // Retiring the cycle CLEARS the projection (`#- '{gate_health,convergence}'`, a no-op when
    // absent). Leaving it behind would strand shrink figures for a candidate that no longer
    // exists next to a gate that has moved on — and because every field of the projection is
    // plausible on its own, a reader has no way to tell it is describing a dead cycle.
    const written = await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = (CASE
                WHEN metadata #>> '{gate_health,inconclusive,status}'
                       IN ('repair-in-progress', 'repair-staging-mismatch')
                  THEN (COALESCE(metadata, '{}'::jsonb) - 'repair_queue')
                       #- '{gate_health,inconclusive}'
                ELSE COALESCE(metadata, '{}'::jsonb) - 'repair_queue'
              END) #- '{gate_health,convergence}',
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'${casClause(3)}
        RETURNING true AS written`,
      [target.workspaceId, target.installSlug, ...casParams],
    );
    await assertWritten(written);
  }
  // P-004: project the edit-time marker from this same call, for the reason the convergence
  // projection above gives — this is the one production write path for `repair_queue`, so a
  // marker written here can never describe a previous round. Best-effort and non-throwing by
  // construction: a filesystem fault must never fail a release write, and an absent marker
  // simply leaves the hook silent (today's behaviour).
  const { projectFrozenRepairMarker } = await import('../../release/frozen-repair-edit-marker');
  projectFrozenRepairMarker(queue);
  if (manifested) {
    try {
      await publishRepairManifestToGateWorkItem(sql, target, manifested);
    } catch (e) {
      console.warn(
        `[release-actions] P-021 repair manifest not published to the gate-red work-item (non-fatal): ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

/**
 * WI-2141736 P-004: record WHAT the gate just did with freeze-and-converge, and WHY, where a
 * reader can query it — `gate_health.freezeAndConverge`.
 *
 * Deliberately a SEPARATE writer from `writeFrozenCandidateRepairQueue` above, unlike the
 * `convergence` projection that shares its statement. The two dispositions that matter most
 * are exactly the ones that write NO queue: a retire (which clears the row) and a
 * flag-suppressed red (which never creates one). A projection riding the queue write is
 * silent for both — which is how 20 retirements and 0 resumes in one day left no trace
 * outside the per-run logs.
 *
 * SHALLOW merge (`|| $3`), never a replace: the red streak, failing-test list and
 * `observedCandidate` are written by other paths at other times, and a replace here would
 * clobber whichever a concurrent reader depends on. `jsonb_set(..., true)` creates
 * `gate_health` when the row has none.
 *
 * Best-effort and non-throwing by construction: observability must never be able to fail a
 * gate tick. A write that does not land leaves the previous record standing, and its
 * `observedAtMs` is what tells a reader the record has gone stale.
 */
export async function writeFreezeAndConvergeDisposition(
  target: GateVerdictTarget,
  disposition: FreezeAndConvergeDisposition,
): Promise<void> {
  // R-7 / EI-23420599799124840: FIRST append the durable latency ledger row, THEN update
  // the mutable slot. Order is deliberate — the slot write is the leg that can throw (its
  // catch is below), and the ledger row is the only copy that outlives this tick, so it
  // must not be skipped by a slot failure. appendPipelineEvent is itself non-throwing.
  try {
    const { buildGateRepairLatencyLedgerRow, GATE_REPAIR_LATENCY_KIND } = await import(
      '../../release/freeze-disposition'
    );
    const row = buildGateRepairLatencyLedgerRow(disposition, Date.now());
    if (row) {
      const { appendPipelineEvent } = await import('../git-sync/pipeline-events');
      await appendPipelineEvent({
        workspaceId: target.workspaceId,
        installSlug: target.installSlug,
        kind: GATE_REPAIR_LATENCY_KIND,
        status: row.status,
        detail: row.detail,
      });
    }
  } catch (e) {
    console.warn(
      `${orchestratorStdoutTag()} repair-latency ledger append failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }
  try {
    const { buildFreezeAndConvergeGateHealth } = await import(
      '../../release/freeze-disposition'
    );
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const fragment = buildFreezeAndConvergeGateHealth(disposition, Date.now());
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'`,
      [target.workspaceId, target.installSlug, JSON.stringify(fragment)],
    );
  } catch (e) {
    console.warn(
      `${orchestratorStdoutTag()} freeze-disposition write failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Retire only the exact queue an operator inspected. The compare-and-swap uses the queue's
 * stable identity fields rather than the full parsed JSONB object, so additive fields written
 * by a newer checkpoint build cannot make an older release tool's otherwise-valid retirement
 * request fail forever. The caller owns liveness/phase policy; this function owns storage
 * atomicity.
 */
export async function retireFrozenCandidateRepairQueue(
  target: GateVerdictTarget,
  expectedQueue: FrozenCandidateRepairQueue,
): Promise<{
  retired: boolean;
  current: FrozenCandidateRepairQueue | null;
  fixerAlive?: boolean | null;
  refusal?:
    | 'identity-mismatch'
    | 'live-fixer'
    | 'liveness-unknown'
    | 'active-dispatch-reservation'
    | 'unsafe-phase';
}> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // EI-22026318885195355: lock the existing routine metadata row before taking the liveness
  // sample. The old path sampled liveness, released the queue read, then issued a separate CAS;
  // a concurrent queue writer could advance updatedAtMs in between, and the post-CAS diagnostic
  // could independently return null. The transaction makes identity, reservation, liveness, and
  // the clear one serialized lifecycle cut while retaining the shared liveness definition.
  const result = await sql.begin(async (tx) => {
    const currentRows = (await tx.unsafe(
      `SELECT metadata
         FROM harness_shared.routines
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'
        FOR UPDATE`,
      [target.workspaceId, target.installSlug],
    )) as Array<{ metadata?: Record<string, unknown> | string | null }>;
    // EI-22026318885195355 (folded on su-40d60b0c's request while this file's lock was held
    // for P-008): some pg client paths hand `routines.metadata` back as a JSON STRING rather
    // than a decoded object. Without normalization this locked read parses null and BOTH
    // sides of a concurrent retire refuse as identity-mismatch — a liveness bug wearing a
    // CAS-miss costume. Deliberately NARROW: normalize only this locked read; the queue
    // parser and the reserve/renew/finalize CAS paths are unchanged.
    const rawLockedMetadata = currentRows[0]?.metadata;
    let lockedMetadata: Record<string, unknown> | null | undefined;
    if (typeof rawLockedMetadata === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawLockedMetadata);
        lockedMetadata =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        lockedMetadata = null;
      }
    } else {
      lockedMetadata = rawLockedMetadata;
    }
    const current = parseFrozenCandidateRepairQueue(lockedMetadata?.repair_queue);
    if (!current) return { retired: false, current: null, refusal: 'identity-mismatch' as const };

    const identityMatches =
      current.candidate === expectedQueue.candidate &&
      current.repairHead === expectedQueue.repairHead &&
      current.updatedAtMs === expectedQueue.updatedAtMs &&
      current.fixerSpawnId === expectedQueue.fixerSpawnId;
    if (!identityMatches) return { retired: false, current, refusal: 'identity-mismatch' as const };
    if (current.phase !== 'awaiting-fixer' && current.phase !== 'blocked') {
      return { retired: false, current, refusal: 'unsafe-phase' as const };
    }
    if (current.dispatchReservation && current.dispatchReservation.expiresAtMs > Date.now()) {
      return { retired: false, current, refusal: 'active-dispatch-reservation' as const };
    }

    // This is deliberately sampled through the ONE liveness definition. Because the queue row is
    // locked for the duration, the answer is coupled to the exact identity being retired; a
    // false -> null oscillation cannot turn this operation into a misleading CAS miss.
    const fixerAlive = current.fixerSpawnId
      ? await releaseFixerSpawnAlive(tx, current.fixerSpawnId)
      : null;
    if (current.fixerSpawnId && fixerAlive !== false) {
      return {
        retired: false,
        current,
        fixerAlive,
        refusal: fixerAlive === true ? ('live-fixer' as const) : ('liveness-unknown' as const),
      };
    }

    const rows = (await tx.unsafe(
      // P-013: retiring the queue also clears `gate_health.convergence` — same reason as the
      // null-queue branch of writeFrozenCandidateRepairQueue. Both cycle-teardown paths must
      // clear it or one of them leaves shrink figures for a candidate that no longer exists.
      `UPDATE harness_shared.routines
          SET metadata = (CASE
                WHEN metadata #>> '{gate_health,inconclusive,status}'
                       IN ('repair-in-progress', 'repair-staging-mismatch')
                  THEN (COALESCE(metadata, '{}'::jsonb) - 'repair_queue')
                       #- '{gate_health,inconclusive}'
                ELSE COALESCE(metadata, '{}'::jsonb) - 'repair_queue'
              END) #- '{gate_health,convergence}',
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'
          -- Match only the stable queue identity. Comparing the whole JSONB object makes an
          -- additive field written by a newer checkpoint build a retroactive breaking change
          -- for an older release tool that parsed the same row and then attempted retirement.
          AND metadata->'repair_queue'->>'candidate' = $3::text
          AND metadata->'repair_queue'->>'repairHead' = $4::text
          AND metadata->'repair_queue'->'updatedAtMs' = to_jsonb($5::bigint)
          -- The fixer id is semantic identity, not an additive display field. Null-safe equality
          -- prevents a stale request from clearing a replacement fixer under the same queue tuple.
          AND metadata->'repair_queue'->>'fixerSpawnId' IS NOT DISTINCT FROM $6::text
        RETURNING true AS retired`,
      [
        target.workspaceId,
        target.installSlug,
        expectedQueue.candidate,
        expectedQueue.repairHead,
        expectedQueue.updatedAtMs,
        expectedQueue.fixerSpawnId,
      ],
    )) as Array<{ retired: boolean }>;
    if (rows[0]?.retired === true) return { retired: true, current: null };
    return {
      retired: false,
      current,
      fixerAlive,
      refusal: 'identity-mismatch' as const,
    };
  });
  if (result.retired) {
    // P-004: the queue is gone, so the edit-time marker must go with it. A stale marker would
    // warn agents off editing paths for a candidate that no longer exists — a false positive
    // that teaches them to ignore the signal, which is worse than no signal.
    const { projectFrozenRepairMarker } = await import('../../release/frozen-repair-edit-marker');
    projectFrozenRepairMarker(null);
    return result;
  }
  // `result.current` was read while the routine row was locked. Avoid a second liveness query
  // here; the caller can render the transaction's stable fixerAlive snapshot instead. An
  // identity miss is the one exception: the transaction saw a different queue, so refresh the
  // queue object for the caller's CAS diagnostic without re-running liveness against it.
  if (result.refusal !== 'identity-mismatch') return result;
  return { ...result, current: await readFrozenCandidateRepairQueue(target) };
}

export interface FrozenRepairFixerDispatchResult {
  spawnId: string | null;
  runId: string | null;
}

export interface FrozenRepairDispatchReservationOptions {
  /** A first red may create the queue and reserve it in one CAS write. */
  allowCreateIfAbsent?: boolean;
  nowMs?: number;
}

function queueWithoutDispatchReservation(queue: FrozenCandidateRepairQueue): FrozenCandidateRepairQueue {
  const { dispatchReservation: _dispatchReservation, ...withoutReservation } = queue;
  return withoutReservation;
}

/**
 * Atomically reserve the existing queue row for the external fixer launch.
 *
 * The old queue path did `read -> launch -> write`, which let two checkpoint processes both
 * observe `fixerSpawnId=null` and launch before either write became visible.  This is a
 * compare-and-swap on the existing routine metadata row: only one caller can install the
 * reservation token for the exact queue state it read.  `allowCreateIfAbsent` is used only by
 * the first-red path, so a stale reader cannot recreate a queue another process already cleared.
 */
export async function reserveFrozenCandidateRepairFixer(
  target: GateVerdictTarget,
  queue: FrozenCandidateRepairQueue,
  options: FrozenRepairDispatchReservationOptions = {},
): Promise<FrozenCandidateRepairQueue | null> {
  if (queue.phase !== 'awaiting-fixer') return null;
  const nowMs = options.nowMs ?? Date.now();
  if (queue.dispatchReservation && queue.dispatchReservation.expiresAtMs > nowMs) return null;

  const expectedQueue = queueWithoutDispatchReservation(queue);
  const reservation = {
    token: randomUUID(),
    claimedAtMs: nowMs,
    expiresAtMs: nowMs + FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS,
  };
  const reservedQueue: FrozenCandidateRepairQueue = {
    ...expectedQueue,
    // Taking the launch lease is the start of a new fixer-state handoff. Bump both clocks:
    // `updatedAtMs` remains the row-version CAS identity, while the dedicated field prevents
    // later manifest/leg bookkeeping from resetting the succession age.
    updatedAtMs: nowMs,
    fixerStateChangedAtMs: nowMs,
    dispatchReservation: reservation,
  };
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const allowCreate = options.allowCreateIfAbsent === true;
  // P-008 / EI-21813295393334986: the CAS matches IDENTITY (candidate + repairHead +
  // updatedAtMs — bumped on every transition, so together they ARE the row version) rather
  // than whole-row jsonb equality, and the write MERGES over the stored row. A build-skewed
  // peer's unknown fields (the `freeRetries` class) neither break the match nor get dropped;
  // whole-row equality wedged every exit path the moment writer/reader builds skewed.
  // `updatedAtMs` is compared as TEXT: integer-ms digits are exact on both sides, and a
  // corrupt non-numeric stored value then fails the match instead of throwing the UPDATE.
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{repair_queue}',
              COALESCE(NULLIF(metadata->'repair_queue', 'null'::jsonb), '{}'::jsonb) || $3::jsonb,
              true
            ),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'
        AND (
          ${allowCreate ? "metadata->'repair_queue' IS NULL OR metadata->'repair_queue' = 'null'::jsonb OR" : ''}
          (
            metadata->'repair_queue'->>'candidate' = $4
            AND metadata->'repair_queue'->>'repairHead' = $5
            AND metadata->'repair_queue'->>'updatedAtMs' = $6
            AND (
              metadata->'repair_queue'->'dispatchReservation' IS NULL
              OR COALESCE(
                CASE
                  WHEN metadata->'repair_queue'->'dispatchReservation'->>'expiresAtMs' ~ '^[0-9]+$'
                    THEN (metadata->'repair_queue'->'dispatchReservation'->>'expiresAtMs')::bigint
                  ELSE 0
                END,
                0
              ) <= $7::bigint
            )
          )
        )
      RETURNING metadata->'repair_queue' AS repair_queue`,
    [
      target.workspaceId,
      target.installSlug,
      JSON.stringify(reservedQueue),
      queue.candidate,
      queue.repairHead,
      String(queue.updatedAtMs),
      nowMs,
    ],
  )) as Array<{ repair_queue: unknown }>;
  return parseFrozenCandidateRepairQueue(rows[0]?.repair_queue);
}

/**
 * Extend the dispatch lease while the SAME owner is still preparing the frozen worktree or
 * launching its fixer. The exact token-bearing queue is the CAS authority: a caller that lost
 * the lease to a replacement can never renew over the winner.
 */
export async function renewFrozenCandidateRepairFixerReservation(
  target: GateVerdictTarget,
  queue: FrozenCandidateRepairQueue,
  nowMs = Date.now(),
): Promise<FrozenCandidateRepairQueue | null> {
  if (!queue.dispatchReservation || queue.phase !== 'awaiting-fixer') return null;
  const renewedQueue: FrozenCandidateRepairQueue = {
    ...queue,
    dispatchReservation: {
      ...queue.dispatchReservation,
      expiresAtMs: nowMs + FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS,
    },
  };
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // P-008: identity + reservation-token CAS (version-tolerant — see reserve above). The token
  // remains the lease authority; identity fields pin the queue generation the lease was taken on.
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{repair_queue}',
              COALESCE(NULLIF(metadata->'repair_queue', 'null'::jsonb), '{}'::jsonb) || $3::jsonb,
              true
            ),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'
        AND metadata->'repair_queue'->>'candidate' = $4
        AND metadata->'repair_queue'->>'repairHead' = $5
        AND metadata->'repair_queue'->>'updatedAtMs' = $6
        AND metadata->'repair_queue'->'dispatchReservation'->>'token' = $7
      RETURNING metadata->'repair_queue' AS repair_queue`,
    [
      target.workspaceId,
      target.installSlug,
      JSON.stringify(renewedQueue),
      queue.candidate,
      queue.repairHead,
      String(queue.updatedAtMs),
      queue.dispatchReservation.token,
    ],
  )) as Array<{ repair_queue: unknown }>;
  return parseFrozenCandidateRepairQueue(rows[0]?.repair_queue);
}

/**
 * Finalize (or release) a dispatch reservation with a conditional write.  The reservation is
 * removed only when the exact token-bearing queue is still present, so a stale launcher cannot
 * overwrite a replacement attempt that recovered after the lease expired.
 */
export async function finalizeFrozenCandidateRepairFixer(
  target: GateVerdictTarget,
  queue: FrozenCandidateRepairQueue,
  fired: FrozenRepairFixerDispatchResult | null | undefined,
  nowMs = Date.now(),
): Promise<FrozenCandidateRepairQueue | null> {
  if (!queue.dispatchReservation || queue.phase !== 'awaiting-fixer') return null;
  let finalizedQueue: FrozenCandidateRepairQueue;
  if (fired?.spawnId) {
    const withoutReservation = queueWithoutDispatchReservation(queue);
    finalizedQueue = queueWithoutDispatchReservation(
      markFrozenRepairFixerDispatched(withoutReservation, { spawnId: fired.spawnId, nowMs }),
    );
  } else {
    finalizedQueue = {
      ...queueWithoutDispatchReservation(queue),
      updatedAtMs: nowMs,
      // A failed launch ends the reservation and starts the absent-fixer succession state now.
      fixerStateChangedAtMs: nowMs,
    };
  }

  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // P-008: identity + token CAS with a merge-write (version-tolerant — see reserve above).
  // `finalizedQueue` is serialized WITHOUT the reservation key, and a jsonb merge cannot
  // delete a key, so the reservation is removed explicitly after the merge.
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{repair_queue}',
              (COALESCE(NULLIF(metadata->'repair_queue', 'null'::jsonb), '{}'::jsonb) || $3::jsonb) - 'dispatchReservation',
              true
            ),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'
        AND metadata->'repair_queue'->>'candidate' = $4
        AND metadata->'repair_queue'->>'repairHead' = $5
        AND metadata->'repair_queue'->>'updatedAtMs' = $6
        AND metadata->'repair_queue'->'dispatchReservation'->>'token' = $7
      RETURNING metadata->'repair_queue' AS repair_queue`,
    [
      target.workspaceId,
      target.installSlug,
      JSON.stringify(finalizedQueue),
      queue.candidate,
      queue.repairHead,
      String(queue.updatedAtMs),
      queue.dispatchReservation.token,
    ],
  )) as Array<{ repair_queue: unknown }>;
  return parseFrozenCandidateRepairQueue(rows[0]?.repair_queue);
}

/** EI-19329732364513693: how OLD is the candidate a verdict judged, and how far behind tip?
 *  See {@link measureCandidateStaleness} for why a verdict that omits this misleads. */
export interface CandidateStaleness {
  /** ISO-8601 commit time of the candidate; null when unreadable (GC'd sha, git error). */
  candidateCommittedAt: string | null;
  /** Commits on `staging` the candidate does NOT contain; null when unreadable. */
  commitsBehindTip: number | null;
}

/**
 * EI-19329732364513693: measure the candidate's AGE and DISTANCE BEHIND TIP, so a recorded
 * verdict can disclose them.
 *
 * Why this exists. The quiet-cut picks a candidate by waiting for a window with no recent
 * commits, so on a continuously-busy tree it can reach arbitrarily far back. What then makes
 * that candidate *fail* is not age as such — it is that git-sync commits the WHOLE tree on a
 * timer, so a refactor whose component edit and test edit are minutes-to-hours apart is
 * committed as a broken intermediate, and that intermediate is eligible to be judged.
 * Measured 2026-08-02: five failures across two consecutive reds, every one already green at
 * tip, with component→test skew windows of 34min, 2h11m, and (for the run fired 11:15:03Z) a
 * fix that landed 39 SECONDS after the candidate was cut.
 *
 * A red verdict names failing tests, and both agents and the release-fixer dispatcher act on
 * those names. Nothing in the log header, the broadcast, or `gate_health` said how old the
 * candidate was, so responders re-derived it by hand or — far more often — did not, and
 * chased failures that had been fixed hours earlier. Persisting these two numbers makes a
 * stale red self-defusing: "candidate is N commits / Xh behind tip" ends the chase at the
 * source instead of costing each reader the same rediscovery.
 *
 * Read-only and FAIL-SAFE: any git error yields nulls rather than throwing, because
 * `trackGateStall` must never fail a routine tick for want of a diagnostic.
 */
export async function measureCandidateStaleness(
  root: string,
  candidate: string,
  runner: GitCheckRunner = defaultGitCheckRunner,
): Promise<CandidateStaleness> {
  const committed = await runner(root, ['log', '-1', '--format=%cI', candidate]);
  // `<candidate>..staging` counts commits reachable from staging but NOT from the candidate —
  // i.e. exactly how far the tree moved on past what this verdict judged.
  const behind = await runner(root, ['rev-list', '--count', `${candidate}..staging`]);
  const parsedBehind = behind.ok ? Number.parseInt(behind.stdout, 10) : Number.NaN;
  const committedAt = committed.ok && committed.stdout ? committed.stdout : null;
  return {
    // A repair-queue ADMISSION commit carries a fixed sentinel date so its dry-run preview and its
    // confirmed write hash identically — so for a `repairHead` this reads `2000-01-01`, which is a
    // constant, not a measurement. Recording it would hand the CANDIDATE-FOSSIL rule a ~26.7-year
    // age for a commit made minutes ago, and under freeze-and-converge the judged candidate IS an
    // admission commit — so the rule fired on every repairHead verdict (WI-10002121, measured
    // live: "judged a commit that was ALREADY 234291.7h old"). Null is the honest record: the age
    // is UNAVAILABLE, which the rule already handles by standing down, rather than wrong.
    candidateCommittedAt: isAdmissionSyntheticCommitDate(committedAt) ? null : committedAt,
    commitsBehindTip: Number.isFinite(parsedBehind) ? parsedBehind : null,
  };
}

/**
 * P-006 + P-014: dispatch a release-fixer agent for a held (not-green) gate,
 * mirroring git-sync's merge-resolver. Fires the `release-fix` launch blueprint
 * from the `green-checkpoint:red` trigger via fireLaunchBlueprintForEvent — the
 * canonical, spawn-RECORDING, DBOS-DURABLE fire path the P-007 test already
 * exercises (replacing the old raw fire-and-forget loopbackFetch that recorded no
 * spawn + lost the fixer on a crash). Deduped per red-candidate via the
 * green-checkpoint routine metadata (`last_fixer`) — now LIVENESS-AWARE (D-009): a
 * dead fixer no longer blocks re-dispatch for 2h (the 2026-06-21 incident class).
 * EI-8718: re-verifies the candidate isn't STALE (superseded+GC'd, or already
 * promoted past by other means) before paying for a dedup-slot write + fixer spawn.
 * Fail-safe: every step is best-effort and never throws into the routine tick.
 *
 * EI-13723: takes the plain `GateVerdictTarget` (installSlug + workspaceId) rather than the
 * routine-only `SystemActionCtx` — the only two fields this function reads — so
 * `recordCheckpointVerdict` (callable from the CLI itself, which has no `SystemActionCtx`) can
 * call it directly. A `SystemActionCtx` still satisfies this structurally at every existing
 * call site.
 */
export async function dispatchReleaseFixer(
  ctx: GateVerdictTarget,
  candidate: string,
  failingTests?: string[],
  repairQueue?: FrozenCandidateRepairQueue,
): Promise<{ spawnId: string | null; runId: string | null } | null> {
  // workspace-work-scope-policy-2026-09-04 P-008: an out-of-scope install's gate still runs
  // (verdict-only) but never SPAWNS a release-fixer for it. Denials land on the policy
  // ledger; with no policy set this is one cached read and byte-identical behaviour.
  {
    const { gateWorkScope } = await import('../../work-scope-policy');
    const scope = await gateWorkScope('release-fixer', { harness: ctx.installSlug, actor: 'green-checkpoint' });
    if (!scope.allowed) {
      console.log(`${orchestratorStdoutTag()} release-fixer dispatch skipped for ${ctx.installSlug}: ${scope.message}`);
      await appendPipelineEvent({
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        kind: 'green_checkpoint',
        status: 'release-fixer-skipped-scope',
        detail: { candidate: candidate.slice(0, 12), allowHarnesses: scope.allowHarnesses },
      }).catch(() => {});
      return null;
    }
  }
  // EI-8718: cheap re-verify BEFORE touching dedup state — a candidate that's gone stale
  // between the checkpoint run reporting it and this dispatch call gets a no-op skip
  // instead of a wasted fixer spawn. Best-effort: a check failure (e.g. no repo at
  // integrationRoot(), transient git error) treats the candidate as NOT stale (fails open
  // to the pre-existing dispatch behavior) rather than silently swallowing a real red gate.
  const fixerRoot = integrationRootForDiagnostic();
  const staleCheck: ReleaseFixerCandidateStaleCheck = fixerRoot
    ? await checkReleaseFixerCandidateStale(fixerRoot, candidate).catch(
        () => ({ candidateExists: true, candidatePromoted: false }) satisfies ReleaseFixerCandidateStaleCheck,
      )
    : { candidateExists: true, candidatePromoted: false };
  if (isStaleReleaseFixerCandidate(staleCheck)) {
    console.log(
      `${orchestratorStdoutTag()} release-fixer dispatch skipped for ${candidate.slice(0, 8)}: stale candidate ` +
        `(exists=${staleCheck.candidateExists}, promoted=${staleCheck.candidatePromoted}) — gate already resolved`,
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'release-fixer-skipped-stale',
      detail: {
        candidate: candidate.slice(0, 12),
        candidateExists: staleCheck.candidateExists,
        candidatePromoted: staleCheck.candidatePromoted,
      },
    }).catch(() => {});
    return null;
  }

  // WI-2140605: a FROZEN-REPAIR dispatch with an EMPTY failing set has nothing for a
  // reproduce-style fixer to reproduce. The kickoff brief this dispatch produces is
  // "identify the exact failing tests, reproduce, fix hermetically"
  // (`buildReleaseFixerKickoff`), so an empty set makes that brief unexecutable by
  // construction — it is not a fixer that tried and failed, it is a fixer that was never
  // given a target. Measured 2026-09-01 on candidate edaf692e: three consecutive fixers
  // parked/died at "reproduce" against `failingTests=[]` while the verdict itself was
  // stale (`failingTestsMeasured=false`).
  //
  // The dispatch was not merely wasted, it DEADLOCKED the gate: each one wrote a
  // `last_fixer` record, and the owner policy ("no LIVE_GATE_OPS while a fixer is alive")
  // then blocked the very `release:checkpoint-run` that the STALE VERDICT label prescribes
  // as the fix. The gate stayed red 3h+ with the repair already in the tree.
  //
  // `describeGateRedOwnership` ALREADY refuses to name failures in this state
  // (`state:'verdict-stale'` → "do NOT diagnose the failures it names; get a fresh
  // verdict first"). This guard stops the DISPATCHER from quietly disagreeing with that
  // RENDERER — the same renderer/dispatcher drift `gateFailureSignature` was extracted to
  // prevent, one field over.
  //
  // Deliberately scoped to the frozen-repair path (`repairQueue` present): an ordinary
  // fresh-verdict red whose failing set was simply not extracted is a different question
  // and keeps its existing dispatch behaviour. Returning null here is an already-exercised
  // outcome — the stale-candidate guard above does the same, and
  // `finalizeFrozenCandidateRepairFixer` releases the dispatch reservation on a null
  // `fired` rather than wedging the queue.
  // The redundant `repairQueue &&` is load-bearing for the type checker: the predicate
  // returns a plain boolean rather than a `repairQueue is …` type guard on purpose, because
  // a type guard would also narrow the NEGATIVE branch to `undefined` — which is false here
  // (a defined queue WITH failures returns false) and would mis-type the dispatch path below.
  //
  // EI-22216541327801093: the measured-flag half of this guard needs the LIVE routine row
  // (the in-memory `failingTests` this function was called with can be the array a stale
  // hold tick left untouched — see `frozenRepairHasNoMeasuredFailures`'s doc comment), so
  // the dedup-record SELECT that already existed further down is pulled up here and widened
  // to also read `gate_health.failingTestsMeasured`. Same single query, same round trip —
  // only reordered, plus one more selected column.
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'last_fixer' AS lf,
            metadata->'gate_health'->>'failingTestsMeasured' AS ftm,
            metadata->'gate_health'->'candidateSnapshot' AS cs
       FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ lf: ReleaseFixerRecord | null; ftm: string | null; cs: unknown }>;
  const lf = rows[0]?.lf ?? null;
  const failingTestsMeasured = rows[0]?.ftm === 'true' ? true : rows[0]?.ftm === 'false' ? false : null;
  const candidateSnapshot = parseCandidateSnapshot(rows[0]?.cs);
  // The explicit null check is what lets TypeScript narrow `candidateSnapshot` for the
  // `.identity` read below (TS18047 at tip, 2026-09-06); a missing snapshot cannot match a
  // dispatch, so the skip branch is the same outcome the matcher already returns for null.
  if (
    !candidateSnapshot ||
    !candidateSnapshotMatchesDispatch(candidateSnapshot, {
      candidate,
      failingTests,
      repairQueue,
    })
  ) {
    console.log(
      `${orchestratorStdoutTag()} release-fixer dispatch skipped for ${candidate.slice(0, 8)}: ` +
        'no fresh candidate snapshot matches the candidate and failing-test signature',
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'release-fixer-skipped-snapshot',
      detail: {
        candidate: candidate.slice(0, 12),
        snapshotIdentity: candidateSnapshot?.identity ?? null,
      },
    }).catch(() => {});
    return null;
  }

  if (repairQueue && frozenRepairHasNoMeasuredFailures(repairQueue, failingTests, failingTestsMeasured)) {
    console.log(
      `${orchestratorStdoutTag()} release-fixer dispatch skipped for ${candidate.slice(0, 8)}: frozen repair ` +
        `queue has no measured failing tests (failingTestsMeasured=${failingTestsMeasured}) — nothing to ` +
        `reproduce; a fresh verdict is the unblock, not a fixer`,
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'release-fixer-skipped-no-measured-failures',
      detail: {
        candidate: candidate.slice(0, 12),
        repairHead: repairQueue.repairHead.slice(0, 12),
        phase: repairQueue.phase,
        attempts: repairQueue.attempts,
        failingTestsMeasured,
      },
    }).catch(() => {});
    return null;
  }

  // P-012: dedup by the FAILURE SIGNATURE (the failing test files / workspaces), not the
  // candidate sha. While the gate stays red, staging advances hourly so every checkpoint
  // is a NEW candidate — keying on sha re-notified the human + re-spawned a fixer every
  // hour for the SAME failure. The signature is stable across candidates; only a CHANGED
  // failure set re-dispatches. Falls back to the candidate sha when none was extracted.
  // `candidate` is non-null here, so the shared helper's null case is unreachable — the
  // `?? candidate` keeps that provable to the type checker rather than widening `signature`.
  const signature = gateFailureSignature(failingTests, candidate) ?? candidate;

  // D-009 liveness-aware dedup: within the window, skip ONLY if the previously-
  // dispatched fixer is still alive. A dead/finished fixer re-dispatches now.
  const sameSignature = !!lf && lf.signature === signature;
  const fixerAlive = sameSignature ? await releaseFixerSpawnAlive(sql, lf?.spawnId) : null;
  const now = Date.now();
  const decision = decideReleaseFixerDispatch({ lf, signature, now, fixerAlive });
  if (!decision.dispatch) return null; // a live fixer is covering this gate — the good dedup

  // Claim the dedup slot BEFORE firing (anti double-fire across ticks): a concurrent
  // tick now sees a fresh `at` with no spawn id → fixerAlive=null → covered → skips.
  // The spawn id is patched in after the fire below.
  const notifiedAt = decision.notify ? now : (lf?.notifiedAt ?? null);
  const snapshotIdentity = candidateSnapshot.identity;
  const previousLastFixer = JSON.stringify(lf ?? null);
  const writeRecord = async (rec: ReleaseFixerRecord, expectedLastFixer: ReleaseFixerRecord | null): Promise<boolean> => {
    const written = (await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = now()
        WHERE install_slug = $1
          AND target_role = 'system:green-checkpoint'
          AND metadata->'gate_health'->'candidateSnapshot'->>'identity' = $2
          AND COALESCE(metadata->'last_fixer', 'null'::jsonb) = $3::jsonb
        RETURNING true AS written`,
      [
        ctx.installSlug,
        snapshotIdentity,
        expectedLastFixer ? JSON.stringify(expectedLastFixer) : previousLastFixer,
        JSON.stringify({ last_fixer: rec }),
      ],
    )) as Array<{ written?: boolean }>;
    return written.length > 0;
  };
  const reservation: ReleaseFixerRecord = {
    signature,
    candidate,
    at: now,
    spawnId: null,
    runId: null,
    snapshotIdentity,
    notifiedAt: notifiedAt ?? undefined,
  };
  // EI-22344736163383832: reserve the dedup slot only if the exact snapshot and prior
  // last_fixer record are still current. Two concurrent dispatchers now cannot both fire.
  if (!(await writeRecord(reservation, lf))) {
    console.log(
      `${orchestratorStdoutTag()} release-fixer dispatch skipped for ${candidate.slice(0, 8)}: ` +
        'candidate snapshot or last_fixer changed before reservation',
    );
    return null;
  }

  // P-003: a user-facing notification (native OS notification on desktop, mobile push).
  // Rate-limited by decision.notify so an hourly self-heal re-dispatch doesn't spam.
  if (decision.notify) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      const selfHeal = decision.reason === 'self-heal';
      await notifyAttention({
        kind: 'intervention',
        title: selfHeal
          ? 'Release gate still held — prior fixer died, re-dispatched'
          : 'Release gate held — staging→main blocked',
        body:
          `green-checkpoint couldn't promote candidate ${candidate.slice(0, 8)} (gate red${failingTests && failingTests.length > 0 ? `: ${failingTests.slice(0, 5).join(', ')}` : ''}); ` +
          `${selfHeal ? 'the previous release-fixer ended without clearing it — a fresh one was' : 'a release-fixer was'} dispatched to diagnose it.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: {
          candidate: candidate.slice(0, 12),
          failing: (failingTests ?? []).slice(0, 10).join(','),
          selfHeal: String(selfHeal),
        },
      });
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} release-red notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // EI-7443: best-effort flake annotation for the CURRENTLY-failing files, from the
  // 7d harness_shared.test_runs rollup — never blocks/fails the dispatch (a rollup
  // hiccup just means no annotation, same as today).
  let flakeAnnotation: string | undefined;
  try {
    const { testFlakeRollup, flagFlakeSuspects } = await import('../../dev-data');
    const { entries } = await testFlakeRollup(7);
    flakeAnnotation = annotateFailingTestsWithFlakeStats(failingTests, flagFlakeSuspects(entries, 7));
  } catch (e) {
    console.warn(
      `${orchestratorStdoutTag()} flake-suspect annotation skipped (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }

  // P-006/P-014: fire the release-fixer via the canonical spawn-recording, DBOS-durable
  // path (fireLaunchBlueprintForEvent) so the fixer is liveness-trackable + survives a crash.
  const { fireLaunchBlueprintForEvent } = await import('../../blueprint/launch-blueprint');
  let fired: Awaited<ReturnType<typeof fireLaunchBlueprintForEvent>> = null;
  try {
    const kickoff = buildReleaseFixerKickoff({
      candidate,
      failingTests,
      repairQueue,
      flakeAnnotation,
    });
    fired = await fireLaunchBlueprintForEvent('green-checkpoint:red', {
      installSlug: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      kickoff,
      extra: ['--green-checkpoint-red', JSON.stringify({ candidate })],
      bodyExtra: {
        releaseFixerContext: {
          candidate: candidate.slice(0, 12),
          failingTests: (failingTests ?? []).slice(0, 20),
          ...(repairQueue
            ? {
                frozenCandidate: repairQueue.candidate,
                repairHead: repairQueue.repairHead,
                repairAttempt: repairQueue.attempts + 1,
              }
            : {}),
        },
      },
      // P-010: the fixer's reproduce→classify→fix loop (maxTurns 30) needs far more than
      // the old 280s. Give it the full 45-minute invoke budget; the liveness-aware dedup
      // re-dispatches promptly if this fixer dies, so a long timeout is no longer a 2h gap.
      timeoutMs: 2_700_000,
    });
  } catch (e) {
    console.warn(`${orchestratorStdoutTag()} release-fixer fire failed: ${e instanceof Error ? e.message : e}`);
  }
  // Patch the recorded fixer's spawn id so the NEXT tick can check ITS liveness (D-009).
  const spawnId = fired?.spawn?.spawnId ?? null;
  const runId = fired?.spawn?.runId ?? null;
  let recordPatched = true;
  if (spawnId || runId) {
    recordPatched = await writeRecord(
      { ...reservation, spawnId, runId },
      reservation,
    ).catch(() => false);
    if (!recordPatched) {
      console.warn(
        `${orchestratorStdoutTag()} release-fixer record patch lost snapshot/last_fixer CAS for ${candidate.slice(0, 8)}`,
      );
    }
  }
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'release_fixer',
    status: fired ? 'ok' : 'failed',
    detail: {
      candidate: candidate.slice(0, 12),
      reason: decision.reason,
      spawnId: spawnId ?? undefined,
      snapshotIdentity,
      recordPatched,
    },
  }).catch(() => {});
  return { spawnId, runId };
}

/** The fixed transient-unit name for the detached auto-deploy — fixed on
 *  purpose: systemd-run refuses a second unit with the same name while one is
 *  active, which is exactly the dedup we want across trigger ticks. */
export const AUTO_DEPLOY_UNIT = RELEASE_DEPLOY_UNIT;
/** P-010: one detached specialized-certification producer at a time. */
export const LIVE_RELEASE_CERTIFICATION_UNIT = 'papercup-live-release-certification';
export const LIVE_RELEASE_CERTIFICATION_LOG = `/tmp/${LIVE_RELEASE_CERTIFICATION_UNIT}.log`;

export function liveReleaseCertificationRoot(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-live-certification`);
}

/**
 * Build the detached exact-pin certification payload from existing primitives:
 * setup-release-checkout creates a clean immutable worktree, then the existing
 * live-federation writer certifies that checkout and banks schema-v2 evidence.
 */
export function buildLiveReleaseCertificationShell(root: string, targetSha: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(targetSha)) {
    throw new Error(`live certification requires a full git sha, got ${JSON.stringify(targetSha)}`);
  }
  const certificationRoot = liveReleaseCertificationRoot(root);
  const setup = path.join(root, 'apps/operator/bin/release/setup-release-checkout.sh');
  const gate = path.join(certificationRoot, 'papercusp-desktop/bin/live-federation-gate.sh');
  const desktopRoot = path.join(certificationRoot, 'papercusp-desktop');
  return [
    'set -euo pipefail',
    `bash ${shellQuote(setup)} --ref ${shellQuote(targetSha)} --integration ${shellQuote(root)} --release ${shellQuote(certificationRoot)} --node-modules auto --node-modules-copy copy`,
    `GATE_CERTIFICATION_TARGET_SHA=${shellQuote(targetSha)} GATE_FORCE=1 RIG_WAIT=1 REBUILD=1 DESKTOP_DIR=${shellQuote(desktopRoot)} bash ${shellQuote(gate)}`,
  ].join('; ');
}

async function launchLiveReleaseCertification(
  root: string,
  targetSha: string,
): Promise<{ launched: boolean; reason: string | null }> {
  const payload = `${buildLiveReleaseCertificationShell(root, targetSha)} > ${shellQuote(LIVE_RELEASE_CERTIFICATION_LOG)} 2>&1`;
  return new Promise((resolve) => {
    const child = spawn('systemd-run', [
      '--user',
      ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
      `--unit=${LIVE_RELEASE_CERTIFICATION_UNIT}`,
      `--working-directory=${root}`,
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      'bash',
      '-c',
      payload,
    ]);
    const stderr = createTextCollector(child.stderr);
    child.on('error', (error) =>
      resolve({ launched: false, reason: error instanceof Error ? error.message : String(error) }),
    );
    child.on('close', (code) =>
      resolve({
        launched: code === 0,
        reason: code === 0 ? null : `systemd-run exited ${String(code)}: ${stderr.text().trim().slice(0, 300)}`,
      }),
    );
  });
}

/** The subset of the deploy plan (deploy.ts `DeployPlan`, emitted as JSON by
 *  `deploy-cli`) that the auto-serve gate reads. */
export interface AutoServePlan {
  targetSha?: string;
  currentReleaseSha?: string | null;
  isFastForward?: boolean;
  commits?: string[];
  noop?: boolean;
  /** Every changed path in this plan is the papercusp-desktop submodule gitlink — a
   *  shell-only pointer bump the operator deploy must skip (desktop-submodule-of-
   *  papercup-2026-06-09 D-003). Set by gatherPlan; absent on old plan JSON. */
  desktopOnly?: boolean;
}

/**
 * Auto-serve policy — may the unattended release-trigger deploy this plan?
 *
 * The trigger may ONLY advance the release checkout **forward** to a green
 * `main` that brings ≥1 NEW commit via a fast-forward (or perform the first
 * deploy, when the checkout isn't set up yet). It must NEVER act on a
 * zero-new-commit plan.
 *
 * Why this guard exists (root-caused 2026-06-07): the *detached* release
 * checkout can transiently sit AHEAD of green `main` — a
 * `chore(git-sync): auto-commit` lands in it during a deploy / green-checkpoint
 * race — so `currentReleaseSha !== targetSha` (the old `noop` SHA-equality test
 * is false) while `commits` is empty and `isFastForward` is false. The old gate
 * (`if (plan.noop) return`) missed exactly this case and redeployed a plan that
 * applies ZERO commits, which reverts the checkout BACKWARD; the next git-sync
 * tick re-advances it → an infinite redeploy storm, each iteration
 * HARD-RESTARTING the `:3070` operator and dropping in-flight MCP/HTTP requests.
 * Forward-only + non-empty + fast-forward is the structural fix. A
 * backward / lateral / non-FF move is a deliberate rollback (`rollback.ts`) or a
 * reviewed forced deploy (`deploy-cli --force`), never auto-serve.
 *
 * Also skips a DESKTOP-ONLY pointer bump (desktop-submodule-of-papercup-2026-06-09
 * D-003): once papercusp-desktop is a submodule, every desktop edit bumps the
 * superproject `papercusp-desktop` gitlink → FFs onto green `main`. Without this guard
 * a shell-only change would drain + restart the live `:3070` operator (which never
 * builds or uses the desktop). A forced/manual `deploy-cli --execute` still can.
 */
export function shouldAutoServe(plan: AutoServePlan): boolean {
  // First deploy — the release checkout isn't set up yet → establish it.
  if (plan.currentReleaseSha === null) return true;
  // Malformed/absent field → conservative: don't deploy.
  if (typeof plan.currentReleaseSha !== 'string') return false;
  if (plan.noop === true) return false;
  // D-003: a desktop-only pointer bump doesn't touch the operator — don't
  // auto-redeploy :3070 for a shell-only change.
  if (plan.desktopOnly === true) return false;
  // Forward-only: a genuine fast-forward bringing ≥1 NEW commit. A 0-commit or
  // non-FF plan means the checkout is AT or AHEAD of `main` → never redeploy.
  return plan.isFastForward === true && Array.isArray(plan.commits) && plan.commits.length > 0;
}

/** P-013 back-off window: how long after a failed/rolled-back deploy of a target we
 *  refuse to re-attempt the SAME target. */
const DEPLOY_BACKOFF_MS = 60 * 60_000;

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DeployEventRow {
  status: string;
  detail: Record<string, unknown> | string | null;
  created_at: Date | string;
}

/**
 * P-013 pure decision: given the MOST-RECENT deploy event, should we skip re-attempting
 * `targetSha`? A deploy that fails/rolls-back reverts the release checkout BACKWARD, so
 * the next 15-min trigger sees green `main` still ahead and redeploys the SAME broken
 * target — draining + restarting :3070 every tick (2026-06-09 13:31–14:00: three
 * rolled-back retries of one broken green). True iff that event was a failure/rollback of
 * the SAME target within DEPLOY_BACKOFF_MS of `nowMs`. A new green (different sha) or the
 * window elapsing clears the back-off. Exported for unit testing.
 */
export function shouldBackOff(
  latest: DeployEventRow | null,
  targetSha: string,
  nowMs: number,
  backoffMs: number = DEPLOY_BACKOFF_MS,
): boolean {
  if (!latest || (latest.status !== 'failed' && latest.status !== 'rolled-back')) return false;
  const detail = typeof latest.detail === 'string' ? safeJson(latest.detail) : (latest.detail ?? {});
  const lastTarget = String((detail as Record<string, unknown>).targetSha ?? ''); // stored sliced(0,12)
  const ageMs = nowMs - new Date(latest.created_at).getTime();
  return lastTarget.length > 0 && targetSha.startsWith(lastTarget) && ageMs < backoffMs;
}

/** DB glue over shouldBackOff — reads the latest deploy event; never blocks a deploy on a
 *  stats-read failure (fail-open). */
async function recentDeployFailedFor(slug: string, targetSha: string): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT status, detail, created_at FROM harness_shared.pipeline_events
        WHERE install_slug = $1 AND kind = 'deploy'
        ORDER BY created_at DESC LIMIT 1`,
      [slug],
    )) as DeployEventRow[];
    return shouldBackOff(rows[0] ?? null, targetSha, Date.now(), releaseCheckpointConfig().deployBackoffMs);
  } catch {
    return false;
  }
}

/**
 * system:release-trigger — AUTO-SERVE (staging-branch-pipeline-2026-06-06 D-002):
 * when green `main` is ahead of what the operator runs, launch the SCRIPTED
 * deploy. The green gate is the go/no-go; deploy-cli's mechanics carry drain +
 * snapshot + migrate + restart + health-check + auto-rollback, and deploy.ts
 * records the `deploy` pipeline event itself.
 *
 * The deploy is launched as a DETACHED transient systemd unit, NOT a child of
 * this host: the deploy restarts the very host this routine runs in, so a child
 * deploy-cli dies at its own restart step — the 2026-06-06 10:31 auto-deploy
 * lost its health probe, AUTO-ROLLBACK, broadcast and event exactly that way
 * (swap+migrate land before restart, which is why it half-worked). A transient
 * unit survives the restart and completes the whole lifecycle.
 */
registerSystemAction('release-trigger', async (ctx: SystemActionCtx) => {
  // per-hive-git-and-release-gate-2026-06-29 (D-001): per-hive AUTO-DEPLOY (leg 3) is
  // DEFERRED — the systemd unit (AUTO_DEPLOY_UNIT) + health probe below are operator-home-
  // specific. A non-home release-trigger only exists if a hive declared releaseGate.deploy
  // and opted in; guard it to a NO-OP so it can NEVER run the papercusp deploy for another
  // hive. When per-hive deploy lands, resolve a per-hive deploy target here instead.
  const { operatorHomeHarnessSlug } = await import('../operator-home-harness');
  if (ctx.installSlug && ctx.installSlug !== operatorHomeHarnessSlug()) {
    console.warn(
      `[release-trigger] per-hive auto-deploy not yet supported (${ctx.installSlug}) — skipping (leg-3 deferred, D-001)`,
    );
    return;
  }
  const root = integrationRoot();
  const tooling = releaseToolingStatus(root, 'apps/operator/lib/release/deploy-cli.ts');
  if (!tooling.ok) {
    console.warn(`[release-trigger] release tooling unavailable (${tooling.reason}) at ${root} — skipping this tick`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'deploy',
      status: 'skipped-no-tooling',
      detail: { reason: tooling.reason, root },
    });
    return;
  }
  // Cheap, side-effect-free: is there anything green to deploy?
  const plan = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', [], 60_000);
  // P-008: parse the delimited plan marker, not a brace-slice of all stdout.
  const parsedPlan = parseMarkerLine(plan.stdout, DEPLOY_PLAN_MARKER) as { plan?: AutoServePlan } | null;
  if (!parsedPlan) {
    console.warn('[release-trigger] could not parse deploy plan marker — skipping this tick');
    return;
  }
  const planObj: AutoServePlan | null = parsedPlan.plan ?? null;
  // Forward-only auto-serve: only advance to a green `main` that brings ≥1 new
  // commit via a fast-forward (or the first deploy). Skips the
  // checkout-at/ahead-of-main case that previously storm-redeployed :3070 — see
  // `shouldAutoServe`.
  if (!planObj || !shouldAutoServe(planObj)) return;

  // P-010: code-green promotion and specialized live certification are
  // independent. `main` may advance quickly, but ordinary deployment fails
  // closed until the existing live-federation gate certifies this exact pin.
  const certificationTarget = typeof planObj.targetSha === 'string' ? planObj.targetSha : null;
  if (!certificationTarget) {
    console.warn('[release-trigger] deploy plan has no exact target sha — live certification cannot be resolved');
    return;
  }
  let certification: LiveReleaseCertification;
  try {
    certification = await readLiveReleaseCertification(certificationTarget);
  } catch (error) {
    certification = {
      status: 'unreadable',
      targetSha: certificationTarget,
      certified: false,
      reason: `live-certification read threw: ${error instanceof Error ? error.message : String(error)}`,
      bankPath: null,
      evidence: null,
      invalidLines: 0,
    };
  }
  if (!certification.certified) {
    console.warn(
      `[release-trigger] green ${certificationTarget.slice(0, 12)} is not live-certified (${certification.status}): ${certification.reason}`,
    );
    // A current exact-source RED is actionable evidence, not a retry request.
    // Re-running it every 15-minute trigger tick would create a heavy test storm;
    // a new target naturally becomes target-mismatch and starts a new attempt.
    if (certification.status === 'failed') {
      await appendPipelineEvent({
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        kind: 'deploy',
        status: 'certification-failed',
        detail: { targetSha: certificationTarget.slice(0, 12), reason: certification.reason },
      }).catch(() => {});
      return;
    }
    const launched = await launchLiveReleaseCertification(root, certificationTarget);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'deploy',
      status: launched.launched ? 'certification-launched' : 'certification-launch-refused',
      detail: {
        targetSha: certificationTarget.slice(0, 12),
        priorStatus: certification.status,
        unit: LIVE_RELEASE_CERTIFICATION_UNIT,
        logPath: LIVE_RELEASE_CERTIFICATION_LOG,
        ...(launched.reason ? { reason: launched.reason } : {}),
      },
    }).catch(() => {});
    if (!launched.launched) {
      console.warn(`[release-trigger] live-certification launch refused: ${launched.reason}`);
    }
    return;
  }

  // P-013: don't storm-redeploy a target that just failed/rolled-back — wait for a new
  // green (different sha) or the back-off window. This is what stops the every-15-min
  // retry of a broken green from draining + restarting the live operator each tick.
  if (typeof planObj.targetSha === 'string' && (await recentDeployFailedFor(ctx.installSlug, planObj.targetSha))) {
    console.warn(
      `[release-trigger] target ${planObj.targetSha.slice(0, 12)} failed/rolled-back within ${DEPLOY_BACKOFF_MS / 60_000}m — backing off (awaiting a new green or the window)`,
    );
    return;
  }

  const targetSha = typeof planObj.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : '?';
  const commits = Array.isArray(planObj.commits) ? planObj.commits.length : '?';
  console.log(
    `[release-trigger] green main is ahead — launching detached auto-deploy of ${targetSha} (${commits} commit(s)) as ${AUTO_DEPLOY_UNIT}`,
  );

  // PAPERCUSP_ALLOW_DEV_RESTART=1: the restart step is env-gated against ad-hoc
  // runs restarting the shared host — this routine IS the owner-authorized
  // auto-serve path (D-002), so it self-authorizes. Fire-and-forget: the
  // outcome is reported by deploy.ts (broadcast + pipeline event + awaitable
  // release:deployed/deploy-failed), not by this (about-to-be-restarted) host.
  await new Promise<void>((resolve) => {
    const child = spawn('systemd-run', [
      '--user',
      ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
      `--unit=${AUTO_DEPLOY_UNIT}`,
      `--working-directory=${root}`,
      // EI-193: a transient unit inherits the systemd USER-MANAGER environment,
      // NOT this process's — and after a reboot the manager PATH is the bare
      // default (no linuxbrew/nvm node), so a bare `npx` dies with exit 127
      // and auto-deploy silently stops (observed 2026-06-09: every deploy
      // tick 127'd until a manual `systemctl --user import-environment PATH`).
      // Pass THIS operator's PATH (it found node) + use the absolute tsx bin
      // (same resolution as runScript) so the unit never depends on the
      // manager environment. PATH is still needed: tsx's shebang is
      // `#!/usr/bin/env node`.
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      'bash',
      '-c',
      // P-014: `>` (truncate), not `>>` — each deploy's log is self-contained, so the
      // file can't grow unbounded; the durable record is pipeline_events + the journal.
      buildDeployTerminalShell(
        `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' apps/operator/lib/release/deploy-cli.ts --execute > /tmp/${AUTO_DEPLOY_UNIT}.log 2>&1`,
      ),
    ]);
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      console.warn(`[release-trigger] failed to launch ${AUTO_DEPLOY_UNIT}: ${e instanceof Error ? e.message : e}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Most common cause: the unit already exists = a deploy is in flight.
        console.warn(
          `[release-trigger] systemd-run exited ${code} (deploy already running?): ${stderr.trim().slice(0, 200)}`,
        );
      }
      resolve();
    });
  });
});
