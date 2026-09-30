/**
 * General process-lifecycle judgement for task-ledger rows (memory-reduction
 * 2026-09-24 P-009 / D-006 / D-009).
 *
 * The task manager already owns enrolment, kernel reconciliation and the safe
 * task-id kill primitive. This module adds the missing judgement layer without
 * creating another registry, scheduler or process-control path:
 *
 *   ledger/reconcile -> pure candidates -> one condition-keyed item per task
 *                    -> one idempotent all-candidate judge per hour
 *
 * The spawned judge is evidence-only: it re-reads live state and records a
 * structured verdict. A later sweep enforces `kill` verdicts inside this trusted
 * task-manager process through the existing identity-safe control primitives.
 */

import { statSync } from 'node:fs';

import { getOrgPg } from '@papercusp/db-org';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { upsertConditionWorkItem } from '../coord/condition-upsert';
import { spawnAgentInHarness } from '../fleet/operator-spawn';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { mergeWorkItemPayload } from '../work-items';
import { getTask, listLifecycleJudgementTasks, mergeTaskLifecycleProbes } from './store';
import { killScopeUnit, killTask, type ControlOutcome, type ScopeControlOutcome } from './control';
import { isAutoReapExempt, isTerminalState, type TaskRow } from './types';

export const LIFECYCLE_LAUNCHER_ENDED_GRACE_MS = 15 * 60_000;
export const LIFECYCLE_OLD_TASK_MS = 6 * 60 * 60_000;
export const LIFECYCLE_IDLE_QUIET_MS = 6 * 60 * 60_000;
export const LIFECYCLE_UNACCOUNTED_RESIDUE_GRACE_MS = 15 * 60_000;
export const LIFECYCLE_TERMINAL_RESIDUE_GRACE_MS = 15 * 60_000;
export const LIFECYCLE_JUDGE_INTERVAL_MS = 60 * 60_000;
export const LIFECYCLE_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Reuse the maintained coding/operator persona rather than minting a parallel
 * lifecycle role. `operator` has the evidence surfaces this pass needs
 * (`processes:list` + work-item lifecycle) but not `processes:kill`; process
 * signalling remains inside the trusted task-manager boundary below.
 *
 * The explicit blueprint id is load-bearing. Papercusp's harness blueprint does
 * not itself carry an operator prompt, while the coding blueprint does. Without
 * this extra invoke-once falls through to the base prompt library and rejects the
 * spawn before the judge takes a turn.
 */
export const LIFECYCLE_JUDGE_ROLE = 'operator' as const;
export const LIFECYCLE_JUDGE_BLUEPRINT_ID = 'coding' as const;
export const LIFECYCLE_JUDGE_EXTRAS = [`BLUEPRINT_ID=${LIFECYCLE_JUDGE_BLUEPRINT_ID}`] as const;

const PROBE_DETAIL_KEY = 'processLifecycleProbe';
const CANDIDATE_PAYLOAD_KEY = 'processLifecycleCandidate';
const CONDITION_PREFIX = 'process-lifecycle:v1:';

export type LifecycleCandidateKind = 'launcher-ended' | 'old-and-idle' | 'terminal-residue' | 'unaccounted-residue';

export interface ProcessLifecycleProbe {
  version: 1;
  launcherEndedSinceMs: number | null;
  logPath: string | null;
  logMtimeMs: number | null;
  cpuUsec: number | null;
  lastActivityAtMs: number | null;
}

export interface ProcessLifecycleVerdict {
  taskId: string;
  decision: 'keep' | 'kill' | 'gone';
  reason: string;
  keepCount: number;
  recheckAt: string | null;
  decidedAt?: string | null;
}

export interface LifecycleCandidate {
  taskId: string;
  scopeUnit: string | null;
  workspaceId: string;
  harnessSlug: string | null;
  title: string;
  taskClass: string;
  state: string;
  launchedBy: string;
  startedAt: string;
  endedAt: string | null;
  kinds: LifecycleCandidateKind[];
  reasons: string[];
  metrics: {
    cpuUsec: number | null;
    pidsCurrent: number | null;
    lastMemoryBytes: number | null;
    logMtimeMs: number | null;
    lastActivityAtMs: number | null;
    launcherEndedSinceMs: number | null;
  };
  previousVerdict: ProcessLifecycleVerdict | null;
}

export interface LifecycleEvaluation {
  candidates: LifecycleCandidate[];
  suppressedByKeep: string[];
  suppressedByVerdict: string[];
  probeUpdates: Array<{ taskId: string; probe: ProcessLifecycleProbe }>;
}

export interface LifecycleVerdictEnforcement {
  taskId: string;
  decision: 'kill' | 'gone';
  target: 'task-id' | 'scope-unit' | 'none';
  targetId: string | null;
  /** Goal-state semantics: true means this verdict needs no further signal. */
  settled: boolean;
  /** True only when the control primitive reported that it sent a signal. */
  signalled: boolean;
  reapTerminalResidue: boolean;
  error?: string;
  detail?: string;
}

export interface LifecycleVerdictEnforcementDeps {
  loadTask(taskId: string): Promise<TaskRow | null>;
  killTask(taskId: string, opts: { reapTerminalResidue?: boolean }): Promise<ControlOutcome>;
  killScopeUnit(scopeUnit: string): Promise<ScopeControlOutcome>;
}

export interface OpenLifecycleCandidateItem {
  id: string;
  taskId: string;
  harnessSlug: string | null;
  /** A claim is dispatch ownership, even when the item still has open status. */
  takenBy?: string | null;
}

export interface LifecycleJudgementDeps {
  loadRows(input: { workspaceId: string; residueTaskIds: readonly string[] }): Promise<TaskRow[]>;
  resolveLauncherStates(ownerIds: readonly string[]): Promise<Map<string, string | null>>;
  statLogMtimeMs(path: string): number | null;
  readLatestVerdicts(workspaceId: string, taskIds: readonly string[]): Promise<Map<string, ProcessLifecycleVerdict>>;
  enforceVerdicts(verdicts: ReadonlyMap<string, ProcessLifecycleVerdict>): Promise<LifecycleVerdictEnforcement[]>;
  persistProbes(updates: readonly { taskId: string; probe: ProcessLifecycleProbe }[]): Promise<number>;
  upsertCandidate(
    conditionKey: string,
    candidate: LifecycleCandidate,
    fallbackHarness: string,
  ): Promise<{ id: string | null }>;
  listOpenCandidateItems(workspaceId: string): Promise<OpenLifecycleCandidateItem[]>;
  spawnJudge(input: {
    workspaceId: string;
    harnessSlug: string;
    idempotencyKey: string;
    brief: string;
  }): Promise<{ ok: boolean; spawnId: string | null; deduped?: boolean; error?: string | null }>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function processLifecycleProbeFromDetail(detail: Record<string, unknown>): ProcessLifecycleProbe | null {
  const raw = object(detail[PROBE_DETAIL_KEY]);
  if (!raw || raw.version !== 1) return null;
  return {
    version: 1,
    launcherEndedSinceMs: finiteNumber(raw.launcherEndedSinceMs),
    logPath: typeof raw.logPath === 'string' && raw.logPath ? raw.logPath : null,
    logMtimeMs: finiteNumber(raw.logMtimeMs),
    cpuUsec: finiteNumber(raw.cpuUsec),
    lastActivityAtMs: finiteNumber(raw.lastActivityAtMs),
  };
}

export function processLifecycleVerdictFrom(value: unknown): ProcessLifecycleVerdict | null {
  const raw = object(value);
  if (!raw) return null;
  const decision = raw.decision;
  if (decision !== 'keep' && decision !== 'kill' && decision !== 'gone') return null;
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!taskId || !reason) return null;
  return {
    taskId,
    decision,
    reason,
    keepCount: nonNegativeInteger(raw.keepCount),
    recheckAt: typeof raw.recheckAt === 'string' && raw.recheckAt ? raw.recheckAt : null,
    decidedAt: typeof raw.decidedAt === 'string' && raw.decidedAt ? raw.decidedAt : null,
  };
}

function sameProbe(a: ProcessLifecycleProbe | null, b: ProcessLifecycleProbe): boolean {
  return (
    a?.version === b.version &&
    a.launcherEndedSinceMs === b.launcherEndedSinceMs &&
    a.logPath === b.logPath &&
    a.logMtimeMs === b.logMtimeMs &&
    a.cpuUsec === b.cpuUsec &&
    a.lastActivityAtMs === b.lastActivityAtMs
  );
}

function parsedMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validLogMtime(value: number | null, nowMs: number): number | null {
  if (value === null || value < 0) return null;
  return Math.min(value, nowMs);
}

function activeKeepVerdict(verdict: ProcessLifecycleVerdict | undefined, nowMs: number): boolean {
  if (verdict?.decision !== 'keep' || !verdict.recheckAt) return false;
  const recheckAtMs = Date.parse(verdict.recheckAt);
  return Number.isFinite(recheckAtMs) && recheckAtMs > nowMs;
}

function controlOutcomeSettled(
  outcome: ControlOutcome | ScopeControlOutcome,
  terminalConfinedTask: boolean,
): boolean {
  if (outcome.ok) return true;
  if (outcome.error === 'already_gone') return true;
  // With reapTerminalResidue, not_live on a confined terminal row means the
  // authoritative cgroup re-read found it empty. The same error on an
  // unconfined row is a safety refusal, hence the explicit caller guard.
  return terminalConfinedTask && outcome.error === 'not_live';
}

export const nodeLifecycleVerdictEnforcementDeps: LifecycleVerdictEnforcementDeps = {
  loadTask: (taskId) => getTask(taskId),
  killTask: (taskId, opts) => killTask(taskId, opts),
  killScopeUnit: (scopeUnit) => killScopeUnit(scopeUnit),
};

/** Enforce completed agent verdicts from the trusted task-manager boundary. */
export async function enforceLifecycleVerdicts(
  verdicts: ReadonlyMap<string, ProcessLifecycleVerdict>,
  deps: LifecycleVerdictEnforcementDeps = nodeLifecycleVerdictEnforcementDeps,
): Promise<LifecycleVerdictEnforcement[]> {
  const outcomes: LifecycleVerdictEnforcement[] = [];
  for (const [taskId, verdict] of verdicts) {
    if (verdict.decision === 'keep') continue;
    if (verdict.decision === 'gone') {
      outcomes.push({
        taskId,
        decision: 'gone',
        target: 'none',
        targetId: null,
        settled: true,
        signalled: false,
        reapTerminalResidue: false,
        detail: verdict.reason,
      });
      continue;
    }

    let row = await deps.loadTask(taskId);
    if (!row) {
      outcomes.push({
        taskId,
        decision: 'kill',
        target: 'none',
        targetId: null,
        settled: true,
        signalled: false,
        reapTerminalResidue: false,
        error: 'task_not_found',
        detail: 'task row disappeared before enforcement; nothing remains to signal',
      });
      continue;
    }

    if (row.state === 'unaccounted') {
      if (!row.scopeUnit) {
        outcomes.push({
          taskId,
          decision: 'kill',
          target: 'scope-unit',
          targetId: null,
          settled: false,
          signalled: false,
          reapTerminalResidue: false,
          error: 'no_target',
          detail: 'unaccounted row has no exact scope unit; refusing to infer a target',
        });
        continue;
      }
      const outcome = await deps.killScopeUnit(row.scopeUnit);
      outcomes.push({
        taskId,
        decision: 'kill',
        target: 'scope-unit',
        targetId: row.scopeUnit,
        settled: controlOutcomeSettled(outcome, false),
        signalled: outcome.ok,
        reapTerminalResidue: false,
        ...(!outcome.ok ? { error: outcome.error } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      continue;
    }

    let reapingResidue = isTerminalState(row.state);
    let outcome = await deps.killTask(taskId, { reapTerminalResidue: reapingResidue });
    // A live row can become terminal between the routing read and killTask's own
    // authoritative read. Re-read once and use the positive residue path.
    if (!outcome.ok && outcome.error === 'not_live' && !reapingResidue) {
      const refreshed = await deps.loadTask(taskId);
      if (refreshed && isTerminalState(refreshed.state)) {
        row = refreshed;
        reapingResidue = true;
        outcome = await deps.killTask(taskId, { reapTerminalResidue: true });
      }
    }
    const terminalConfinedTask = reapingResidue && row.confined && Boolean(row.scopeUnit);
    outcomes.push({
      taskId,
      decision: 'kill',
      target: 'task-id',
      targetId: taskId,
      settled: controlOutcomeSettled(outcome, terminalConfinedTask),
      signalled: outcome.ok,
      reapTerminalResidue: reapingResidue,
      ...(!outcome.ok ? { error: outcome.error } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    });
  }
  return outcomes;
}

/**
 * Pure candidate selection. A missing/unreadable activity signal never means
 * idle. For a no-log task, the first CPU sample establishes the quiet baseline;
 * it cannot become an idle candidate on that same observation.
 */
export function evaluateLifecycleCandidates(input: {
  rows: readonly TaskRow[];
  confirmedResidueTaskIds: ReadonlySet<string>;
  launcherStates: ReadonlyMap<string, string | null>;
  latestVerdicts: ReadonlyMap<string, ProcessLifecycleVerdict>;
  settledVerdictTaskIds?: ReadonlySet<string>;
  statLogMtimeMs: (path: string) => number | null;
  nowMs: number;
}): LifecycleEvaluation {
  const candidates: LifecycleCandidate[] = [];
  const suppressedByKeep: string[] = [];
  const suppressedByVerdict: string[] = [];
  const probeUpdates: Array<{ taskId: string; probe: ProcessLifecycleProbe }> = [];

  for (const row of input.rows) {
    if (row.class === 'agent-session' || isAutoReapExempt(row)) continue;

    const kinds: LifecycleCandidateKind[] = [];
    const reasons: string[] = [];
    const confirmedResidue = input.confirmedResidueTaskIds.has(row.taskId);
    const prior = processLifecycleProbeFromDetail(row.detail);
    let nextProbe = prior;

    if (row.state === 'unaccounted' && confirmedResidue) {
      const startedAtMs = parsedMs(row.startedAt);
      // Reconcile's consecutive scans can both occur while a freshly enrolled
      // scope is still booting. Confirmation alone is not an age floor.
      if (startedAtMs !== null && input.nowMs - startedAtMs >= LIFECYCLE_UNACCOUNTED_RESIDUE_GRACE_MS) {
        kinds.push('unaccounted-residue');
        reasons.push('kernel residue persisted across consecutive healthy reconcile scans with no live owning row');
      }
    } else if (isTerminalState(row.state) && confirmedResidue) {
      const endedAtMs = parsedMs(row.endedAt) ?? parsedMs(row.lastSeenAt);
      if (endedAtMs !== null && input.nowMs - endedAtMs >= LIFECYCLE_TERMINAL_RESIDUE_GRACE_MS) {
        kinds.push('terminal-residue');
        reasons.push('terminal confined task still has kernel processes after the residue grace period');
      }
    }

    if (row.state === 'pending' || row.state === 'running') {
      const launcherIsSu = /^su-[0-9A-Za-z]/.test(row.launchedBy);
      const launcherState = launcherIsSu ? input.launcherStates.get(row.launchedBy) : null;
      const launcherEndedSinceMs =
        launcherState === 'ended'
          ? (prior?.launcherEndedSinceMs ?? input.nowMs)
          : launcherState == null
            ? (prior?.launcherEndedSinceMs ?? null)
            : null;

      const logPath = row.logPath?.trim() || null;
      const sameLogPath = prior?.logPath === logPath;
      const logMtimeMs = validLogMtime(logPath ? input.statLogMtimeMs(logPath) : null, input.nowMs);
      const cpuUsec = finiteNumber(row.cpuUsec);
      let lastActivityAtMs = sameLogPath ? (prior?.lastActivityAtMs ?? null) : null;

      if (logMtimeMs !== null) {
        lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, logMtimeMs);
      }
      if (sameLogPath && prior?.cpuUsec !== null && cpuUsec !== null && prior?.cpuUsec !== cpuUsec) {
        // A decrease means the counter reset; that is activity too, not evidence
        // that the process was quiet throughout the reset window.
        lastActivityAtMs = input.nowMs;
      }
      if (!sameLogPath || prior === null) {
        // A readable log already carries its own activity clock. With no readable
        // log, the first CPU sample is only a baseline and starts the quiet clock now.
        lastActivityAtMs = logMtimeMs ?? (cpuUsec !== null ? input.nowMs : null);
      }

      nextProbe = {
        version: 1,
        launcherEndedSinceMs,
        logPath,
        logMtimeMs,
        cpuUsec,
        lastActivityAtMs,
      };
      if (!sameProbe(prior, nextProbe)) probeUpdates.push({ taskId: row.taskId, probe: nextProbe });

      if (
        launcherState === 'ended' &&
        launcherEndedSinceMs !== null &&
        input.nowMs - launcherEndedSinceMs >= LIFECYCLE_LAUNCHER_ENDED_GRACE_MS
      ) {
        kinds.push('launcher-ended');
        reasons.push(`starter ${row.launchedBy} has remained ended for at least 15 minutes`);
      }

      const startedAtMs = parsedMs(row.startedAt);
      const currentlyMeasured = logMtimeMs !== null || cpuUsec !== null;
      if (
        currentlyMeasured &&
        startedAtMs !== null &&
        input.nowMs - startedAtMs >= LIFECYCLE_OLD_TASK_MS &&
        lastActivityAtMs !== null &&
        input.nowMs - lastActivityAtMs >= LIFECYCLE_IDLE_QUIET_MS
      ) {
        kinds.push('old-and-idle');
        reasons.push('task is at least 6 hours old and measured log/CPU activity has been quiet for at least 6 hours');
      }
    }

    if (kinds.length === 0) continue;
    const previousVerdict = input.latestVerdicts.get(row.taskId);
    if (previousVerdict?.decision === 'gone' || input.settledVerdictTaskIds?.has(row.taskId)) {
      suppressedByVerdict.push(row.taskId);
      continue;
    }
    if (activeKeepVerdict(previousVerdict, input.nowMs)) {
      suppressedByKeep.push(row.taskId);
      continue;
    }
    const probe = nextProbe ?? prior;
    candidates.push({
      taskId: row.taskId,
      scopeUnit: row.scopeUnit ?? null,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug ?? null,
      title: row.title,
      taskClass: String(row.class),
      state: row.state,
      launchedBy: row.launchedBy,
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? null,
      kinds,
      reasons,
      metrics: {
        cpuUsec: finiteNumber(row.cpuUsec),
        pidsCurrent: finiteNumber(row.pidsCurrent),
        lastMemoryBytes: finiteNumber(row.lastMemoryBytes),
        logMtimeMs: probe?.logMtimeMs ?? null,
        lastActivityAtMs: probe?.lastActivityAtMs ?? null,
        launcherEndedSinceMs: probe?.launcherEndedSinceMs ?? null,
      },
      previousVerdict: previousVerdict ?? null,
    });
  }

  return { candidates, suppressedByKeep, suppressedByVerdict, probeUpdates };
}

export function lifecycleCandidateConditionKey(taskId: string): string {
  return `${CONDITION_PREFIX}${taskId}`;
}

export function lifecycleJudgeIntervalKey(workspaceId: string, nowMs: number): string {
  // v2 deliberately does not dedupe onto v1 rows: every v1 production spawn
  // selected an unusable persona and therefore cannot satisfy this operation.
  return `process-lifecycle-judge:v2:${workspaceId}:${Math.floor(nowMs / LIFECYCLE_JUDGE_INTERVAL_MS)}`;
}

export function lifecycleJudgeBrief(items: readonly OpenLifecycleCandidateItem[]): string {
  const refs = items.map((item) => `- ${item.id} | taskId=${item.taskId} | harness=${item.harnessSlug ?? 'unknown'}`);
  return [
    'One-shot Papercusp process-lifecycle judge. Handle EVERY candidate below, then exit. Do not create a fleet or a monitor.',
    '',
    ...refs,
    '',
    'For each item: read and claim the work item, then inspect its processLifecycleCandidate kinds and scopeUnit. For unaccounted-residue, a taskId-filtered processes:list result cannot prove absence: use processes:list { scopeUnit, live:true } and inspect live.exactScopeUnitMatches. If scopeUnit is missing, use an unfiltered live census and inspect all live.unaccountedGroups; an omitted or truncated group list cannot prove absence. Require a known-present positive control before a gone verdict. For other kinds, use processes:list { taskId, live:true } and judge current evidence.',
    'You produce evidence and a verdict only. NEVER signal a process: do not call processes:kill, shell, systemctl, or any pid/name/pattern kill. Trusted task-manager code enforces a completed kill verdict later through the exact task/scope identity.',
    'Complete every item with assumptions:"none" and top-level outputPayload.processLifecycleVerdict = { taskId, decision:"keep"|"kill"|"gone", reason, keepCount, recheckAt, decidedAt }. A keep MUST give a future ISO recheckAt and increment prior keepCount; kill/gone use recheckAt:null. Record concrete processes:list evidence in completion. Then exit.',
  ].join('\n');
}

export function lifecycleCandidateSummary(candidate: LifecycleCandidate): string {
  const verification = candidate.kinds.includes('unaccounted-residue')
    ? candidate.scopeUnit
      ? `For unaccounted residue, re-verify with processes:list { scopeUnit:${JSON.stringify(candidate.scopeUnit)}, live:true } and inspect live.exactScopeUnitMatches. A taskId-filtered read cannot prove absence.`
      : 'For unaccounted residue with no recorded scopeUnit, re-verify with an unfiltered processes:list { live:true } and inspect the complete live.unaccountedGroups inventory. A taskId-filtered read cannot prove absence.'
    : 'Re-verify with processes:list { taskId, live:true }.';
  return (
    `Task ${candidate.taskId} is a lifecycle candidate (${candidate.kinds.join(', ')}). ` +
    `${candidate.reasons.join('; ')}. ${verification} ` +
    'Before recording gone, require a known-present positive control and check that reconciliation is healthy and the relevant inventory is complete. Keep with a reason and future recheck date, kill only by taskId, or record gone.'
  );
}

export interface LifecycleSweepResult {
  rowsInspected: number;
  candidates: number;
  suppressedByKeep: number;
  suppressedByVerdict: number;
  probesPersisted: number;
  enforcement: LifecycleVerdictEnforcement[];
  candidateItems: string[];
  openItems: string[];
  judge: {
    attempted: boolean;
    idempotencyKey: string | null;
    ok?: boolean;
    spawnId?: string | null;
    deduped?: boolean;
    error?: string | null;
  };
}

export async function runLifecycleJudgementSweep(
  input: {
    workspaceId: string;
    harnessSlug: string;
    confirmedResidueTaskIds?: readonly string[];
    nowMs?: number;
  },
  deps: LifecycleJudgementDeps = nodeLifecycleJudgementDeps,
): Promise<LifecycleSweepResult> {
  const nowMs = input.nowMs ?? Date.now();
  const residueTaskIds = [...new Set(input.confirmedResidueTaskIds ?? [])];
  const rows = await deps.loadRows({ workspaceId: input.workspaceId, residueTaskIds });
  const launcherIds = [
    ...new Set(
      rows
        .filter((row) => row.class !== 'agent-session' && /^su-[0-9A-Za-z]/.test(row.launchedBy))
        .map((row) => row.launchedBy),
    ),
  ];
  const taskIds = rows.map((row) => row.taskId);
  const [launcherStates, latestVerdicts] = await Promise.all([
    deps.resolveLauncherStates(launcherIds),
    deps.readLatestVerdicts(input.workspaceId, taskIds),
  ]);
  const enforcement = await deps.enforceVerdicts(latestVerdicts);
  const settledVerdictTaskIds = new Set(
    enforcement.filter((outcome) => outcome.settled).map((outcome) => outcome.taskId),
  );
  const evaluation = evaluateLifecycleCandidates({
    rows,
    confirmedResidueTaskIds: new Set(residueTaskIds),
    launcherStates,
    latestVerdicts,
    settledVerdictTaskIds,
    statLogMtimeMs: deps.statLogMtimeMs,
    nowMs,
  });
  const probesPersisted = await deps.persistProbes(evaluation.probeUpdates);

  const candidateItems: string[] = [];
  for (const candidate of evaluation.candidates) {
    const filed = await deps.upsertCandidate(
      lifecycleCandidateConditionKey(candidate.taskId),
      candidate,
      input.harnessSlug,
    );
    if (filed.id) candidateItems.push(filed.id);
  }

  // Query after filing. This also recovers items left open by an earlier failed
  // launch even if their task stopped matching the detector in the meantime.
  const open = (await deps.listOpenCandidateItems(input.workspaceId)).filter(
    (item) =>
      !item.takenBy &&
      !settledVerdictTaskIds.has(item.taskId) &&
      latestVerdicts.get(item.taskId)?.decision !== 'gone',
  );
  if (open.length === 0) {
    return {
      rowsInspected: rows.length,
      candidates: evaluation.candidates.length,
      suppressedByKeep: evaluation.suppressedByKeep.length,
      suppressedByVerdict: evaluation.suppressedByVerdict.length,
      probesPersisted,
      enforcement,
      candidateItems,
      openItems: [],
      judge: { attempted: false, idempotencyKey: null },
    };
  }

  const idempotencyKey = lifecycleJudgeIntervalKey(input.workspaceId, nowMs);
  const spawned = await deps.spawnJudge({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    idempotencyKey,
    brief: lifecycleJudgeBrief(open),
  });
  return {
    rowsInspected: rows.length,
    candidates: evaluation.candidates.length,
    suppressedByKeep: evaluation.suppressedByKeep.length,
    suppressedByVerdict: evaluation.suppressedByVerdict.length,
    probesPersisted,
    enforcement,
    candidateItems,
    openItems: open.map((item) => item.id),
    judge: {
      attempted: true,
      idempotencyKey,
      ok: spawned.ok,
      spawnId: spawned.spawnId,
      deduped: spawned.deduped,
      error: spawned.error,
    },
  };
}

export const nodeLifecycleJudgementDeps: LifecycleJudgementDeps = {
  loadRows: ({ workspaceId, residueTaskIds }) => listLifecycleJudgementTasks({ workspaceId, residueTaskIds }),

  async resolveLauncherStates(ownerIds) {
    if (ownerIds.length === 0) return new Map();
    try {
      const verdicts = await resolveSessionStates(
        ownerIds.map((ownerId) => ({ ownerId })),
        { hydratePerId: true },
      );
      return new Map([...verdicts].map(([ownerId, verdict]) => [ownerId, verdict.sessionState]));
    } catch {
      // Unknown liveness disables the launcher-ended class for this pass. The
      // persisted clock is preserved by the pure evaluator rather than reset.
      return new Map(ownerIds.map((ownerId) => [ownerId, null]));
    }
  },

  statLogMtimeMs(path) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },

  async readLatestVerdicts(workspaceId, taskIds) {
    const out = new Map<string, ProcessLifecycleVerdict>();
    if (taskIds.length === 0) return out;
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ task_id: string; verdict: unknown }>>`
      SELECT DISTINCT ON (payload #>> '{processLifecycleCandidate,taskId}')
             payload #>> '{processLifecycleCandidate,taskId}' AS task_id,
             payload #> '{out,processLifecycleVerdict}' AS verdict
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND payload #>> '{processLifecycleCandidate,taskId}' = ANY(${taskIds as string[]}::text[])
         AND payload #> '{out,processLifecycleVerdict}' IS NOT NULL
       ORDER BY payload #>> '{processLifecycleCandidate,taskId}', updated_ts DESC
    `;
    for (const row of rows) {
      const verdict = processLifecycleVerdictFrom(row.verdict);
      if (verdict && verdict.taskId === row.task_id) out.set(row.task_id, verdict);
    }
    return out;
  },

  enforceVerdicts: (verdicts) => enforceLifecycleVerdicts(verdicts),

  persistProbes: (updates) => mergeTaskLifecycleProbes(updates),

  async upsertCandidate(conditionKey, candidate, fallbackHarness) {
    const harness = candidate.harnessSlug ?? fallbackHarness;
    const payload = {
      taskId: candidate.taskId,
      scopeUnit: candidate.scopeUnit,
      observedAt: new Date().toISOString(),
      taskClass: candidate.taskClass,
      state: candidate.state,
      launchedBy: candidate.launchedBy,
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt,
      kinds: candidate.kinds,
      reasons: candidate.reasons,
      metrics: candidate.metrics,
      previousVerdict: candidate.previousVerdict,
    };
    const result = await upsertConditionWorkItem(conditionKey, {
      kind: 'task',
      harness,
      workspaceId: candidate.workspaceId,
      createdBy: 'system:task-lifecycle-judge',
      title: `Judge process lifecycle: ${candidate.taskId} — ${candidate.title}`.slice(0, 240),
      summary: lifecycleCandidateSummary(candidate),
      payload: { [CANDIDATE_PAYLOAD_KEY]: payload },
    });
    if (result.id) {
      // condition-upsert refreshes title/summary but deliberately preserves the
      // incumbent payload. Refresh this detector evidence additively as well.
      await mergeWorkItemPayload(result.id, { [CANDIDATE_PAYLOAD_KEY]: payload }, { harness });
    }
    return { id: result.id };
  },

  async listOpenCandidateItems(workspaceId) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; task_id: string; harness_slug: string | null; taken_by: string | null }>>`
      SELECT feature_id AS id,
             payload #>> '{processLifecycleCandidate,taskId}' AS task_id,
             harness_slug, taken_by
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         -- Open is not unclaimed: the judge leaves status open while working.
         -- A dead holder is released by the existing stale-claim reaper;
         -- do not launch another judge against a still-owned candidate.
         AND (taken_by IS NULL OR taken_by = '')
         AND COALESCE(payload #>> '{processLifecycleCandidate,taskId}', '') <> ''
       ORDER BY updated_ts ASC, feature_id ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      harnessSlug: row.harness_slug ?? null,
      takenBy: row.taken_by,
    }));
  },

  spawnJudge: ({ workspaceId, harnessSlug, idempotencyKey, brief }) =>
    spawnAgentInHarness({
      workspaceId,
      harness: harnessSlug,
      role: LIFECYCLE_JUDGE_ROLE,
      extras: [...LIFECYCLE_JUDGE_EXTRAS],
      tier: 'quick',
      accountOverride: 'auto',
      brief,
      spawnCaller: 'task-manager/lifecycle-judgement',
      parentRole: 'system:task-reconcile',
      turnTrigger: 'cron',
      idempotencyKey,
    }),
};
