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

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { upsertConditionWorkItem } from '../coord/condition-upsert';
import { spawnAgentInHarness } from '../fleet/operator-spawn';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { claimWorkItem, mergeWorkItemPayload, releaseWorkItem } from '../work-items';
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
  /** Time of the stored CPU counter baseline; unchanged counters keep this time. */
  cpuSampledAtMs: number | null;
  lastActivityAtMs: number | null;
}

export interface CpuActivityEvidence {
  state: 'unknown' | 'idle' | 'active';
  previous: { cpuUsec: number; sampledAtMs: number } | null;
  current: { cpuUsec: number | null; sampledAtMs: number | null };
}

export interface LifecycleLivenessEvidence {
  status: 'present' | 'unknown';
  source: 'healthy-task-reconcile' | 'not-established';
  observedAt: string | null;
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
  liveness: LifecycleLivenessEvidence;
  metrics: {
    cpuUsec: number | null;
    cpuActivity: CpuActivityEvidence;
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

export interface LifecycleVerdictAuditContext {
  workspaceId: string;
  harnessSlug: string;
}

export interface LifecycleVerdictAuditRecord extends LifecycleVerdictAuditContext {
  taskId: string;
  verdict: ProcessLifecycleVerdict;
  target: LifecycleVerdictEnforcement['target'];
  targetId: string | null;
  phase: 'intent' | 'outcome';
  auditId?: string;
  outcome?: LifecycleVerdictEnforcement;
}

export interface LifecycleVerdictEnforcementDeps {
  loadTask(taskId: string): Promise<TaskRow | null>;
  killTask(taskId: string, opts: { reapTerminalResidue?: boolean }): Promise<ControlOutcome>;
  killScopeUnit(scopeUnit: string): Promise<ScopeControlOutcome>;
  recordAudit?(record: LifecycleVerdictAuditRecord): Promise<string>;
}

export interface OpenLifecycleCandidateItem {
  id: string;
  taskId: string;
  harnessSlug: string | null;
  /** A claim is dispatch ownership, even when the item still has open status. */
  takenBy?: string | null;
  /**
   * Holder as the engineer_issues VIEW names it (taken_by AS assignee). The base
   * work_items table has no assignee column, so the real query never sets this;
   * it exists only for callers and fakes that hand over view-shaped rows (WI-10005157).
   */
  assignee?: string | null;
}

export interface LifecycleJudgementDeps {
  loadRows(input: { workspaceId: string; residueTaskIds: readonly string[] }): Promise<TaskRow[]>;
  resolveLauncherStates(ownerIds: readonly string[]): Promise<Map<string, string | null>>;
  statLogMtimeMs(path: string): number | null;
  readLatestVerdicts(workspaceId: string, taskIds: readonly string[]): Promise<Map<string, ProcessLifecycleVerdict>>;
  enforceVerdicts(
    verdicts: ReadonlyMap<string, ProcessLifecycleVerdict>,
    context: LifecycleVerdictAuditContext,
  ): Promise<LifecycleVerdictEnforcement[]>;
  persistProbes(updates: readonly { taskId: string; probe: ProcessLifecycleProbe }[]): Promise<number>;
  upsertCandidate(
    conditionKey: string,
    candidate: LifecycleCandidate,
    fallbackHarness: string,
  ): Promise<{ id: string | null }>;
  listOpenCandidateItems(workspaceId: string): Promise<OpenLifecycleCandidateItem[]>;
  claimOpenCandidateItems(
    items: readonly OpenLifecycleCandidateItem[],
    assignee: string,
  ): Promise<OpenLifecycleCandidateItem[]>;
  releaseCandidateItems(items: readonly OpenLifecycleCandidateItem[], expectedAssignee: string): Promise<void>;
  spawnJudge(input: {
    workspaceId: string;
    harnessSlug: string;
    idempotencyKey: string;
    spawnId: string;
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
    cpuSampledAtMs: finiteNumber(raw.cpuSampledAtMs),
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
    a.cpuSampledAtMs === b.cpuSampledAtMs &&
    a.lastActivityAtMs === b.lastActivityAtMs
  );
}

function cpuActivityEvidence(
  currentCpuUsec: number | null,
  currentSampledAtMs: number | null,
  prior: ProcessLifecycleProbe | null,
): CpuActivityEvidence {
  const previous =
    prior?.cpuUsec !== null && prior?.cpuUsec !== undefined &&
    prior.cpuSampledAtMs !== null && prior.cpuSampledAtMs !== undefined
      ? { cpuUsec: prior.cpuUsec, sampledAtMs: prior.cpuSampledAtMs }
      : null;
  const current = { cpuUsec: currentCpuUsec, sampledAtMs: currentSampledAtMs };
  if (
    previous === null ||
    currentCpuUsec === null ||
    currentSampledAtMs === null ||
    currentSampledAtMs <= previous.sampledAtMs
  ) {
    return { state: 'unknown', previous, current };
  }
  return { state: currentCpuUsec === previous.cpuUsec ? 'idle' : 'active', previous, current };
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

export async function recordLifecycleVerdictAudit(record: LifecycleVerdictAuditRecord, inject?: Sql): Promise<string> {
  const sql = inject ?? getOrgPg().sql;
  const auditId = record.auditId ?? 'task-lifecycle-' + randomUUID();
  const details = {
    schemaVersion: 1,
    phase: record.phase,
    taskId: record.taskId,
    harnessSlug: record.harnessSlug,
    verdict: record.verdict,
    target: record.target,
    targetId: record.targetId,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    recordedAt: new Date().toISOString(),
  };

  if (record.phase === 'outcome' && record.auditId) {
    const updated = await sql.unsafe<{ id: string }[]>(
      'UPDATE harness_shared.audit_log SET details = $2::jsonb WHERE id = $1 AND workspace_id = $3 RETURNING id',
      [auditId, JSON.stringify(details), record.workspaceId],
    );
    if (updated.length !== 1) throw new Error('lifecycle verdict audit intent was not found for settlement');
    return auditId;
  }

  const inserted = await sql.unsafe<{ id: string }[]>(
    'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id',
    [
      auditId,
      Date.now(),
      'system:task-manager',
      'task.lifecycle.verdict',
      record.taskId,
      JSON.stringify(details),
      record.workspaceId,
    ],
  );
  if (inserted.length !== 1) throw new Error('lifecycle verdict audit intent was not inserted');
  return auditId;
}

export const nodeLifecycleVerdictEnforcementDeps: LifecycleVerdictEnforcementDeps = {
  loadTask: (taskId) => getTask(taskId),
  killTask: (taskId, opts) => killTask(taskId, opts),
  killScopeUnit: (scopeUnit) => killScopeUnit(scopeUnit),
  recordAudit: (record) => recordLifecycleVerdictAudit(record),
};

/** Enforce completed agent verdicts from the trusted task-manager boundary. */
export async function enforceLifecycleVerdicts(
  verdicts: ReadonlyMap<string, ProcessLifecycleVerdict>,
  deps: LifecycleVerdictEnforcementDeps = nodeLifecycleVerdictEnforcementDeps,
  context?: LifecycleVerdictAuditContext,
): Promise<LifecycleVerdictEnforcement[]> {
  const outcomes: LifecycleVerdictEnforcement[] = [];
  const recordAudit = async (
    event: Omit<LifecycleVerdictAuditRecord, 'workspaceId' | 'harnessSlug'>,
  ): Promise<string | null> => {
    if (!deps.recordAudit) return null;
    if (!context) throw new Error('lifecycle verdict audit requires workspace context');
    return deps.recordAudit({ ...context, ...event });
  };

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
      const auditId = await recordAudit({
        taskId,
        verdict,
        target: 'scope-unit',
        targetId: row.scopeUnit,
        phase: 'intent',
      });
      if (deps.recordAudit && !auditId) throw new Error('lifecycle verdict audit intent returned no id');
      const outcome = await deps.killScopeUnit(row.scopeUnit);
      const enforcement: LifecycleVerdictEnforcement = {
        taskId,
        decision: 'kill',
        target: 'scope-unit',
        targetId: row.scopeUnit,
        settled: controlOutcomeSettled(outcome, false),
        signalled: outcome.ok,
        reapTerminalResidue: false,
        ...(!outcome.ok ? { error: outcome.error } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
      await recordAudit({
        ...(auditId ? { auditId } : {}),
        taskId,
        verdict,
        target: 'scope-unit',
        targetId: row.scopeUnit,
        phase: 'outcome',
        outcome: enforcement,
      });
      outcomes.push(enforcement);
      continue;
    }

    let reapingResidue = isTerminalState(row.state);
    const auditId = await recordAudit({
      taskId,
      verdict,
      target: 'task-id',
      targetId: taskId,
      phase: 'intent',
    });
    if (deps.recordAudit && !auditId) throw new Error('lifecycle verdict audit intent returned no id');
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
    const enforcement: LifecycleVerdictEnforcement = {
      taskId,
      decision: 'kill',
      target: 'task-id',
      targetId: taskId,
      settled: controlOutcomeSettled(outcome, terminalConfinedTask),
      signalled: outcome.ok,
      reapTerminalResidue: reapingResidue,
      ...(!outcome.ok ? { error: outcome.error } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
    await recordAudit({
      ...(auditId ? { auditId } : {}),
      taskId,
      verdict,
      target: 'task-id',
      targetId: taskId,
      phase: 'outcome',
      outcome: enforcement,
    });
    outcomes.push(enforcement);
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
    const currentCpuSampledAtMs = parsedMs(row.lastSeenAt);

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

    if (row.state === 'unaccounted') {
      const cpuUsec = finiteNumber(row.cpuUsec);
      let nextCpuUsec = cpuUsec;
      let cpuSampledAtMs: number | null = null;
      let lastActivityAtMs = prior?.lastActivityAtMs ?? null;
      if (cpuUsec !== null) {
        if (prior?.cpuUsec == null || prior.cpuSampledAtMs == null) {
          // First measurable value is a baseline, not proof of past activity.
          cpuSampledAtMs = currentCpuSampledAtMs;
        } else if (currentCpuSampledAtMs !== null && currentCpuSampledAtMs > prior.cpuSampledAtMs) {
          if (cpuUsec !== prior.cpuUsec) {
            // A counter decrease means reset/wrap too; it is still observed CPU
            // activity and starts a new timestamped baseline.
            cpuSampledAtMs = currentCpuSampledAtMs;
            lastActivityAtMs = currentCpuSampledAtMs;
          } else {
            // Keep the prior baseline so a repeated no-delta pass stays write-free
            // while the candidate can compare it with the latest scan timestamp.
            nextCpuUsec = prior.cpuUsec;
            cpuSampledAtMs = prior.cpuSampledAtMs;
          }
        } else {
          // No ordered timestamp means this sample cannot establish activity.
          nextCpuUsec = prior.cpuUsec;
          cpuSampledAtMs = prior.cpuSampledAtMs;
        }
      }
      nextProbe = {
        version: 1,
        launcherEndedSinceMs: null,
        logPath: null,
        logMtimeMs: null,
        cpuUsec: nextCpuUsec,
        cpuSampledAtMs,
        lastActivityAtMs,
      };
      if (!sameProbe(prior, nextProbe)) probeUpdates.push({ taskId: row.taskId, probe: nextProbe });
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
      let cpuSampledAtMs: number | null = prior?.cpuSampledAtMs ?? null;

      if (logMtimeMs !== null) {
        lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, logMtimeMs);
      }
      if (sameLogPath && prior?.cpuUsec !== null && cpuUsec !== null && prior?.cpuUsec !== cpuUsec) {
        // A decrease means the counter reset; that is activity too, not evidence
        // that the process was quiet throughout the reset window.
        lastActivityAtMs = currentCpuSampledAtMs ?? input.nowMs;
      }
      if (!sameLogPath || prior === null) {
        // A readable log already carries its own activity clock. With no readable
        // log, the first CPU sample is only a baseline and starts the quiet clock now.
        lastActivityAtMs = logMtimeMs ?? (cpuUsec !== null ? currentCpuSampledAtMs ?? input.nowMs : null);
      }
      if (cpuUsec === null) {
        cpuSampledAtMs = null;
      } else if (prior?.cpuUsec == null || prior.cpuSampledAtMs == null || !sameLogPath) {
        cpuSampledAtMs = currentCpuSampledAtMs;
      } else if (
        currentCpuSampledAtMs !== null &&
        currentCpuSampledAtMs > prior.cpuSampledAtMs &&
        cpuUsec !== prior.cpuUsec
      ) {
        cpuSampledAtMs = currentCpuSampledAtMs;
      }

      nextProbe = {
        version: 1,
        launcherEndedSinceMs,
        logPath,
        logMtimeMs,
        cpuUsec,
        cpuSampledAtMs,
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
      liveness:
        confirmedResidue && (kinds.includes('unaccounted-residue') || kinds.includes('terminal-residue'))
          ? {
              status: 'present',
              source: 'healthy-task-reconcile',
              observedAt: new Date(input.nowMs).toISOString(),
            }
          : { status: 'unknown', source: 'not-established', observedAt: null },
      metrics: {
        cpuUsec: finiteNumber(row.cpuUsec),
        cpuActivity: cpuActivityEvidence(
          row.state === 'unaccounted' || row.state === 'pending' || row.state === 'running'
            ? finiteNumber(row.cpuUsec)
            : null,
          row.state === 'unaccounted' || row.state === 'pending' || row.state === 'running'
            ? currentCpuSampledAtMs
            : null,
          prior,
        ),
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
  // v3 teaches the explicit Count/PidCount process-list contract. Do not dedupe
  // this guidance update onto a v2 judge that may still use the ambiguous keys.
  return `process-lifecycle-judge:v3:${workspaceId}:${Math.floor(nowMs / LIFECYCLE_JUDGE_INTERVAL_MS)}`;
}

export function lifecycleJudgeBrief(items: readonly OpenLifecycleCandidateItem[]): string {
  const refs = items.map((item) => `- ${item.id} | taskId=${item.taskId} | harness=${item.harnessSlug ?? 'unknown'}`);
  return [
    'One-shot Papercusp process-lifecycle judge. Handle EVERY candidate below, then exit. Do not create a fleet or a monitor.',
    '',
    ...refs,
    '',
    'processLifecycleCandidate.liveness is a timestamped host-side observation: present means the task was seen during a healthy task-reconcile scan at observedAt, not necessarily now; unknown is not dead. Use processes:list for current evidence.',
    'capability:bash may run in a separate PID namespace: a missing /proc/<host-pid> means the PID is not visible to that shell, not that it exited. When diagnosing a bash-side probe, report readlink /proc/self/ns/pid, the visible numeric /proc PID count, and $$ in that same call. If $$ is tiny or only a few PIDs are visible, discard every /proc absence from that call. cgroup.procs containing only 0 means at least one task is in the cgroup but hidden from that PID namespace; it is presence evidence, not an empty cgroup or PID 0. A non-zero pids.current and the number of cgroup.procs entries can corroborate cgroup presence, but the listed PID values are namespace-relative. pids.current counts kernel tasks (including threads), not task-manager process rows. capability:bash loopback is proxied; HTTP 502 is not ECONNREFUSED (curl exit 7) and proves neither that the target answered nor that it is absent. Treat these shell readings as unknown; use host-side processes:list or dev:listening_ports for current evidence.',
    'For each item: read and claim the work item, then inspect its processLifecycleCandidate kinds and scopeUnit. For unaccounted-residue, a taskId-filtered processes:list result cannot prove absence: use processes:list { scopeUnit, live:true } and inspect only live.exactScopeUnitMatches entries with kind "unaccounted". An empty exact-scope result is not proof by itself. If scopeUnit is missing, use an unfiltered processes:list { live:true } census and inspect all live.unaccountedGroups and listed PIDs.',
    'Before a gone verdict, require a known-present same-kind unaccounted control from the unfiltered census. Read the control twice and confirm tasks[].ageSec advances by elapsed wall time. Require live.degraded=false, live.ownedTruncated=false, live.foreignTruncated=false, live.unaccountedCount matching live.unaccountedGroups.length, and live.unaccountedPidCount matching the listed PIDs. The complete, self-consistent census must contain every listed unaccounted group and PID; if a check is missing, unhealthy, truncated, inconsistent, or the control does not advance, leave the result unknown. unaccounted with confined:false does not prove abandonment; a kill needs positive abandonment evidence such as a dead spawner and a stale rig. For other kinds, use processes:list { taskId, live:true } and judge current evidence.',
    'Use processLifecycleCandidate.metrics.cpuActivity as cgroup cpu.stat evidence: active means usage_usec changed between its timestamps, idle means unchanged over that interval, and unknown means there is no valid comparison. Idle describes CPU use only; it does not prove the process is gone, and unknown must remain unknown.',
    'You produce evidence and a verdict only. NEVER signal a process: do not call processes:kill, shell, systemctl, or any pid/name/pattern kill. Trusted task-manager code enforces a completed kill verdict later through the exact task/scope identity.',
    'Complete every item with assumptions:"none" and top-level outputPayload.processLifecycleVerdict = { taskId, decision:"keep"|"kill"|"gone", reason, keepCount, recheckAt, decidedAt }. A keep MUST give a future ISO recheckAt and increment prior keepCount; kill/gone use recheckAt:null. Record concrete processes:list evidence in completion. Then exit.',
  ].join('\n');
}

export function lifecycleCandidateSummary(candidate: LifecycleCandidate): string {
  const namespaceProbeCaveat =
    'capability:bash may use a separate PID namespace: missing /proc/<host-pid> means invisible, cgroup.procs containing only 0 means hidden presence (not PID 0), and pids.current counts kernel tasks including threads. When diagnosing a shell probe, report readlink /proc/self/ns/pid, the visible numeric /proc PID count, and $$ in the same call; if $$ is tiny or only a few PIDs are visible, discard every /proc absence. Loopback traffic is proxied, so HTTP 502 is not ECONNREFUSED and proves neither presence nor absence. Do not infer death from these shell readings. ';
  // A condition-upsert refreshes this summary on each healthy reconcile tick.
  // Keep the claim subject stable: timestamped liveness, CPU samples, kinds,
  // reasons, and scope metadata live in processLifecycleCandidate payload and
  // can change while a judge holds the item.
  return (
    `Task ${candidate.taskId} is a process-lifecycle candidate. ` +
    'Read payload.processLifecycleCandidate for the current detector snapshot. Its liveness and metrics are timestamped host-side observations; present is a positive baseline only, and unknown is not dead. Use processes:list for current evidence. ' +
    namespaceProbeCaveat +
    'For unaccounted residue, a taskId-filtered read cannot prove absence. Read payload.processLifecycleCandidate.scopeUnit and use processes:list { scopeUnit, live:true }; inspect only live.exactScopeUnitMatches entries with kind "unaccounted". An empty result is not proof by itself. If scopeUnit is missing, use an unfiltered processes:list { live:true } and inspect the complete live.unaccountedGroups inventory and listed PIDs. ' +
    'Read cgroup CPU evidence from payload.processLifecycleCandidate.metrics.cpuActivity; active means usage_usec changed between its timestamps, idle means unchanged, and unknown means there is no valid comparison. ' +
    'Before recording gone, require a known-present same-kind unaccounted positive control from an unfiltered census. Read the control twice and confirm tasks[].ageSec advances by elapsed wall time; verify live.degraded, live.ownedTruncated, and live.foreignTruncated are false and the unaccounted group/PID counts match their complete lists. unaccounted with confined:false does not prove abandonment; require positive abandonment evidence before a kill. Keep with a reason and future recheck date, kill only by taskId, or record gone.'
  );
}

export function lifecycleCandidatePayload(candidate: LifecycleCandidate, observedAt: string) {
  return {
    taskId: candidate.taskId,
    scopeUnit: candidate.scopeUnit,
    observedAt,
    taskClass: candidate.taskClass,
    state: candidate.state,
    launchedBy: candidate.launchedBy,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt,
    kinds: candidate.kinds,
    reasons: candidate.reasons,
    liveness: candidate.liveness,
    metrics: candidate.metrics,
    previousVerdict: candidate.previousVerdict,
  };
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
  const enforcement = await deps.enforceVerdicts(latestVerdicts, {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
  });
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
      !item.assignee &&
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

  // Reserve ownership before the asynchronous child boot. The first version
  // spawned an agent and left the candidate rows unclaimed until its first turn;
  // an hourly boundary could then use a new idempotency key to launch a duplicate.
  // `spawnAgentInHarness` accepts a pre-minted spawnId, so the child owns exactly
  // the same claims when it starts and can idempotently claim them again in its brief.
  const spawnId = `s-${nowMs}-${randomUUID().slice(0, 8)}`;
  // The spawned operator's work-item caller identity is role-qualified. Store
  // that exact owner id so the judge can complete the candidate it was assigned.
  const judgeOwnerId = `system:${LIFECYCLE_JUDGE_ROLE}/${spawnId}`;
  const claimed = await deps.claimOpenCandidateItems(open, judgeOwnerId);
  if (claimed.length === 0) {
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
    spawnId,
    brief: lifecycleJudgeBrief(claimed),
  });
  // A failure or an idempotency hit on a different spawn did not attach this
  // preclaim to a child. Compare-and-release only our own claims; a concurrent
  // holder can never be cleared by this recovery path.
  if (!spawned.ok || spawned.deduped || spawned.spawnId !== spawnId) {
    await deps.releaseCandidateItems(claimed, judgeOwnerId);
  }
  return {
    rowsInspected: rows.length,
    candidates: evaluation.candidates.length,
    suppressedByKeep: evaluation.suppressedByKeep.length,
    suppressedByVerdict: evaluation.suppressedByVerdict.length,
    probesPersisted,
    enforcement,
    candidateItems,
    openItems: claimed.map((item) => item.id),
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
       ORDER BY payload #>> '{processLifecycleCandidate,taskId}',
                payload #>> '{out,processLifecycleVerdict,decidedAt}' DESC NULLS LAST,
                updated_ts DESC
    `;
    for (const row of rows) {
      const verdict = processLifecycleVerdictFrom(row.verdict);
      if (verdict && verdict.taskId === row.task_id) out.set(row.task_id, verdict);
    }
    return out;
  },

  enforceVerdicts: (verdicts, context) =>
    enforceLifecycleVerdicts(verdicts, nodeLifecycleVerdictEnforcementDeps, context),

  persistProbes: (updates) => mergeTaskLifecycleProbes(updates),

  async upsertCandidate(conditionKey, candidate, fallbackHarness) {
    const harness = candidate.harnessSlug ?? fallbackHarness;
    const payload = lifecycleCandidatePayload(candidate, new Date().toISOString());
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
    const rows = await sql<Array<{
      id: string;
      task_id: string;
      harness_slug: string | null;
      taken_by: string | null;
    }>>`
      SELECT feature_id AS id,
             payload #>> '{processLifecycleCandidate,taskId}' AS task_id,
             harness_slug, taken_by
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         -- Open is not unclaimed: the judge leaves status open while working.
         -- In this BASE table every family (feature AND issue) stores its holder
         -- in taken_by. The 'assignee' column exists only on the engineer_issues
         -- VIEW (taken_by AS assignee), so naming it here throws 42703 on every
         -- pass (WI-10005157). A dead holder is released by the stale-claim
         -- reaper; do not launch another judge against a still-owned item.
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

  async claimOpenCandidateItems(items, assignee) {
    const claimed: OpenLifecycleCandidateItem[] = [];
    for (const item of items) {
      const result = await claimWorkItem(item.id, assignee, { harness: item.harnessSlug ?? undefined });
      if (result) claimed.push({ ...item, takenBy: assignee, assignee });
    }
    return claimed;
  },

  async releaseCandidateItems(items, expectedAssignee) {
    await Promise.all(items.map((item) => releaseWorkItem(item.id, {
      harness: item.harnessSlug ?? undefined,
      expectedAssignee,
      releasingOwnerId: expectedAssignee,
      announceClaimable: false,
    })));
  },

  spawnJudge: ({ workspaceId, harnessSlug, idempotencyKey, spawnId, brief }) =>
    spawnAgentInHarness({
      workspaceId,
      harness: harnessSlug,
      role: LIFECYCLE_JUDGE_ROLE,
      extras: [...LIFECYCLE_JUDGE_EXTRAS],
      tier: 'quick',
      accountOverride: 'auto',
      brief,
      spawnId,
      spawnCaller: 'task-manager/lifecycle-judgement',
      parentRole: 'system:task-reconcile',
      turnTrigger: 'cron',
      idempotencyKey,
    }),
};
