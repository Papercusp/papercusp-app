import type { ChildProcess } from 'node:child_process';

import type { SpawnChildExit, SpawnConsoleResult } from '../console-spawn';
import type { GoalLaunchResolution } from '../goal-launch-settings';
import type { AdmissionContext, AdmissionMetadataValue, ResourceDemand } from './admission';
import { beginGovernedExecution, governedExecutionRuntime, type GovernedExecution } from './execution';
import { withAgentSpawnPacing } from './spawn-pacing';

export interface GovernedProcessSpawnInput {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly owner: string;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext;
  readonly demand?: ResourceDemand;
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
}

/** The final resolver decision, written inside the existing reservation receipt. */
export interface GoalProcessAdmission {
  stage: 'final';
  goalId: string | null;
  launcherOwnerId: string | null;
  targetOwnerId: string | null;
  fleet: string | null;
  requested: 1;
  decision: 'admitted' | 'refused' | 'unknown' | 'not-applicable';
  ceilings: GoalLaunchResolution['ceilings'] | null;
  headcount: GoalLaunchResolution['headcount'] | null;
  measurement: NonNullable<GoalLaunchResolution['headcountMeasurement']> | null;
  refusal: GoalLaunchResolution['refusal'];
  capacityStatus: 'enforced' | 'unenforced' | 'not-checked' | 'unknown';
  degraded: boolean;
  degradedReasons: string[];
}

function finalGoalAdmission(input: GovernedProcessSpawnInput, goalId: string | null,
  resolution: GoalLaunchResolution | null, degradedReason: string | null): GoalProcessAdmission {
  const degradedReasons = [...(resolution?.degradedReasons ?? []), ...(degradedReason ? [degradedReason] : [])];
  return {
    stage: 'final', goalId,
    launcherOwnerId: typeof input.metadata?.launchedBy === 'string' ? input.metadata.launchedBy : null,
    targetOwnerId: typeof input.metadata?.targetOwnerId === 'string' ? input.metadata.targetOwnerId : null,
    fleet: typeof input.metadata?.fleetSlug === 'string' ? input.metadata.fleetSlug : null,
    requested: 1,
    decision: resolution ? resolution.refusal ? 'refused' : 'admitted'
      : goalId || degradedReason ? 'unknown' : 'not-applicable',
    ceilings: resolution?.ceilings ?? null,
    headcount: resolution?.headcountMeasurement ? resolution.headcount : null,
    measurement: resolution?.headcountMeasurement ?? null,
    refusal: resolution?.refusal ?? null,
    capacityStatus: !resolution ? 'unknown'
      : degradedReasons.some((reason) => reason.startsWith('ceiling not enforced')) ? 'unenforced'
        : resolution.headcountMeasurement ? 'enforced' : 'not-checked',
    degraded: resolution?.degraded === true || degradedReasons.length > 0,
    degradedReasons,
  };
}

function receiptGoalAdmission(context: AdmissionContext): GoalProcessAdmission | null {
  const raw = context.metadata?.goalAdmission;
  if (typeof raw !== 'string') return null;
  try {
    const snapshot = JSON.parse(raw) as GoalProcessAdmission | null;
    return snapshot?.stage === 'final' &&
      ['admitted', 'refused', 'unknown', 'not-applicable'].includes(snapshot.decision) &&
      Array.isArray(snapshot.degradedReasons) && snapshot.degradedReasons.every((reason) => typeof reason === 'string')
      ? snapshot : null;
  } catch {
    return null;
  }
}

export type GovernedSpawnResult = SpawnConsoleResult & {
  /** Durable context for nested work started by the spawned process. */
  admissionContext?: AdmissionContext;
  goalAdmission?: GoalProcessAdmission;
  goalAdmissionDegraded?: string[];
};

/**
 * Whether the resource governor can hold or refuse an agent launch at this door.
 *
 * 'observe-only': `beginGovernedExecution` enqueues the durable receipt and the caller
 * immediately takes a TARGETED lease on it; no controller decision is consulted, so the
 * governor records agent launches but never restricts them (spawn-door-governor-migration
 * P-003; its binding migration is P-005..P-012). Readers that judge "was an agent launch
 * admissible" (goal-placement-turn-receipts.ts, plan goal-brief D-031) treat an
 * unpublished agent-class admission state as open ONLY while this reads 'observe-only'.
 *
 * Flip to 'binding' in the same change that makes this door wait on a controller.
 * execution.test.ts pins the targeted-lease behavior against this value, so that change
 * fails there until the declaration moves with it.
 */
export const AGENT_ADMISSION_GOVERNOR_BINDING: 'observe-only' | 'binding' = 'observe-only';

function observeVisibleChild(child: ChildProcess): Promise<SpawnChildExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

function settleOnExit(execution: GovernedExecution, exit: Promise<SpawnChildExit>): void {
  void exit.then(
    () => execution.finish(),
    () => execution.finish(),
  );
}

/**
 * Admit at the actual process-start boundary, then keep the durable lease for
 * the lifetime of the spawned terminal process. A spawn failure cancels the
 * visible receipt; a process exit exact-releases it. Callers receive the
 * context so nested fan-out can pass it back as `parent`.
 *
 * TWO DIFFERENT CEILINGS APPLY HERE, and only one of them is the governor's.
 * The durable lease above rations STEADY-STATE agent capacity and is held until the
 * process exits — a fleet is supposed to run twenty agents at once, so that lease
 * cannot also bound how many agents may be BOOTING at once. Boot is the scarcer
 * resource: a starting agent boots a CLI, restores its transcript and completes an MCP
 * handshake, and its kickoff brief survives only if that finishes inside psu-pty-host's
 * fixed submit-verify budget. `withAgentSpawnPacing` supplies the missing ceiling
 * (EI-21935016329074048 — a 21-way simultaneous burst blew that budget and dropped two
 * briefs while every launch reported success).
 *
 * The pacing wraps ONLY the spawn call, never admission: the durable receipt must be
 * taken first so a queued launch is still visible to the governor as intended work
 * rather than disappearing into an unaccounted local wait.
 */
export async function spawnGovernedAgentProcess(
  input: GovernedProcessSpawnInput,
  spawnProcess: (context: AdmissionContext) => Promise<SpawnConsoleResult>,
): Promise<GovernedSpawnResult> {
  let goalAdmission: GoalProcessAdmission | undefined;
  const register = (goalId: string | null, resolution: GoalLaunchResolution | null = null,
    degradedReason: string | null = null) => {
    goalAdmission = finalGoalAdmission(input, goalId, resolution, degradedReason);
    return beginGovernedExecution(
      {
        idempotencyKey: input.idempotencyKey,
        admissionClass: 'agent',
        demand: input.demand ?? { cpuWeight: 1 },
        payloadRef: input.payloadRef,
        parent: input.parent,
        metadata: {
          ...input.metadata,
          ...(goalId ? { goalId, goalReservation: true } : {}),
          // Metadata values are scalar; preserve the exact final snapshot as JSON.
          // Do not replace this with a post-spawn census or the batch preflight.
          goalAdmission: JSON.stringify(goalAdmission),
        },
      },
      { owner: input.owner },
      governedExecutionRuntime(input.workspaceId, 'agent-process'),
    );
  };

  // Both fleet launch and ad-hoc launch enter here. A tool-level preflight is
  // useful for a batch, but cannot reserve against another concurrent tool.
  const launchedBy = input.metadata?.launchedBy;
  const admitted = typeof launchedBy === 'string' && launchedBy
    ? await (await import('../goal-launch-settings')).registerGoalLaunch({
        workspaceId: input.workspaceId, launcherOwnerId: launchedBy,
        targetOwnerId: typeof input.metadata?.targetOwnerId === 'string' ? input.metadata.targetOwnerId : null,
        fleetSlug: typeof input.metadata?.fleetSlug === 'string' ? input.metadata.fleetSlug : null,
        excludeOwnerIds: typeof input.metadata?.replacesOwnerId === 'string' ? [input.metadata.replacesOwnerId] : [],
      }, register)
    : { value: await register(null), resolution: null, degradedReason: null };
  if (admitted.resolution?.refusal) {
    return { status: 'error', error: admitted.resolution.refusal.message, code: 409,
      goalAdmission: finalGoalAdmission(input, admitted.resolution.goalId, admitted.resolution, admitted.degradedReason) };
  }
  const execution = admitted.value!;
  // A replay can reuse an earlier receipt. The resolver just revalidated this
  // attempt, but the returned admission proof belongs to the receipt we leased.
  if (goalAdmission && goalAdmission.decision !== 'not-applicable') {
    goalAdmission = receiptGoalAdmission(execution.context) ?? finalGoalAdmission(input,
      goalAdmission.goalId, null, 'final goal admission snapshot unavailable in durable receipt');
  }
  const goalAdmissionDegraded = [...new Set([
    ...(goalAdmission?.degradedReasons ?? []),
    ...(admitted.resolution?.degradedReasons ?? []), ...(admitted.degradedReason ? [admitted.degradedReason] : []),
  ])];
  const admissionEvidence = goalAdmission?.decision !== 'not-applicable' && goalAdmission
    ? { goalAdmission, admissionContext: execution.context } : {};

  let result: SpawnConsoleResult;
  try {
    result = await withAgentSpawnPacing(() => spawnProcess(execution.context));
  } catch (error) {
    await execution.cancel(`spawn threw: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  if (result.status === 'error') {
    await execution.cancel(result.error);
    return { ...result, ...admissionEvidence, ...(goalAdmissionDegraded.length ? { goalAdmissionDegraded } : {}) };
  }

  const exit = result.childExit ?? (result.child ? observeVisibleChild(result.child) : null);
  if (exit) settleOnExit(execution, exit);
  return { ...result, ...admissionEvidence, admissionContext: execution.context,
    ...(goalAdmissionDegraded.length ? { goalAdmissionDegraded } : {}) };
}
