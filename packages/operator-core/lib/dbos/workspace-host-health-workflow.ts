/**
 * Standing workspace-host health (WI-10004950): every 15 minutes the controller attests each live
 * hosted host it holds authority for, so `workspace_hosts.health_status` is a current reading for
 * every running customer host rather than NULL outside a soak.
 *
 * The pass itself (`runWorkspaceHostStandingHealthPass`) is DBOS-free and tested over an injected
 * runtime; this module only binds it to `DBOS.runStep` and the real seams/writer, then schedules it.
 * Default skip-missed mode: after downtime one pass re-attests every host, there is no backlog.
 *
 * A second schedule, the spot-reclaim sweep (WI-10005210, D-028), runs every 2 minutes over live
 * SPOT hosts only, so a host the cloud reclaimed is restarted in minutes rather than at the next
 * 15-minute pass.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { resolveWorkspaceHostSoakSeams } from '../workspace-host/soak-seams';
import { recordWorkspaceHostHealth } from '../workspace-host/observability-store';
import { DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY } from '../workspace-host/provisioning-runner';
import { hostedGcpWorkspaceProject } from '../workspace-host/hosted-gcp-hosting';
import {
  papercuspHostedRoleAttestationSummary,
  runPapercuspHostedRoleAttestation,
  type PapercuspHostedRoleAttestationRuntime,
} from '../workspace-host/hosted-gcp-roles';
import {
  listWorkspaceHostSpotReclaimTargets,
  listWorkspaceHostStandingHealthTargets,
  prepareWorkspaceHostReclaimRestart,
  type WorkspaceHostReclaimRestartInput,
} from '../workspace-host/standing-health-store';
import {
  runWorkspaceHostSpotReclaimSweep,
  runWorkspaceHostStandingHealthPass,
  WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB,
  WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
  type WorkspaceHostReclaimRecovery,
  type WorkspaceHostReclaimRestartSeams,
  type WorkspaceHostSpotReclaimSweepResult,
  type WorkspaceHostSpotReclaimSweepRuntime,
  type WorkspaceHostStandingHealthPassResult,
  type WorkspaceHostStandingHealthRuntime,
} from '../workspace-host/standing-health';
/**
 * Restart a reclaimed spot host with the controller's own lifecycle `start` (WI-10005210).
 * `enqueue` runs at the workflow layer of the standing-health tick, where DBOS allows starting a
 * child workflow; the per-host dedup id makes a busy host a skip, never a second operation.
 *
 * The lifecycle module is imported lazily: it registers the provisioning workflow and its queue at
 * load, which the host has already done at boot, and an eager import would drag that registration
 * into every importer of this schedule.
 */
export function workspaceHostReclaimRestartSeams(
  enqueue?: (input: WorkspaceHostReclaimRestartInput) => Promise<unknown>,
): WorkspaceHostReclaimRestartSeams {
  return {
    prepare: (target, operationId) => prepareWorkspaceHostReclaimRestart(target, operationId),
    enqueue: async ({ operationId, input }): Promise<WorkspaceHostReclaimRecovery> => {
      const lifecycle = await import('./workspace-host-provision-workflow');
      try {
        await (enqueue ?? lifecycle.enqueueWorkspaceHostLifecycleWorkflow)(input as WorkspaceHostReclaimRestartInput);
        return { kind: 'restart-enqueued', operationId };
      } catch (error) {
        if (error instanceof lifecycle.WorkspaceHostProvisioningConflictError) {
          return { kind: 'restart-skipped', reason: 'another lifecycle operation holds the host' };
        }
        throw error;
      }
    },
  };
}

export const WORKSPACE_HOST_HEALTH_WORKFLOW_NAME = 'workspaceHostStandingHealth';

export function workspaceHostStandingHealthDbosRuntime(): WorkspaceHostStandingHealthRuntime {
  return {
    // One attempt per host per tick: a probe that failed IS the observation (it is attested as
    // such), and retrying would only re-pay the IAP reach the next tick pays anyway.
    step: (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false }),
    controllerId: DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY.controllerId,
    listTargets: (controllerId) => listWorkspaceHostStandingHealthTargets(controllerId),
    resolveSeams: (input) => resolveWorkspaceHostSoakSeams(input),
    recordHealth: recordWorkspaceHostHealth,
    now: () => new Date(),
    reclaim: workspaceHostReclaimRestartSeams(),
  };
}

function recoveryNote(recovery: WorkspaceHostReclaimRecovery | undefined): string {
  if (!recovery) return '';
  if (recovery.kind === 'restart-enqueued') return ` (spot reclaimed, restart enqueued ${recovery.operationId})`;
  if (recovery.kind === 'restart-skipped') return ` (spot reclaimed, restart skipped: ${recovery.reason})`;
  return ` (spot reclaimed, restart FAILED: ${recovery.error})`;
}

/** A one-line summary, or null when every probed host is healthy and nothing failed. */
export function workspaceHostStandingHealthSummary(result: WorkspaceHostStandingHealthPassResult): string | null {
  const attested = result.outcomes.filter((outcome) => outcome.kind === 'attested');
  const unhealthy = attested.filter((outcome) => outcome.status !== 'healthy');
  const failed = result.outcomes.filter((outcome) => outcome.kind === 'record-failed');
  if (unhealthy.length === 0 && failed.length === 0) return null;
  const parts = [
    ...unhealthy.map(
      (outcome) => `${outcome.workspaceId}/${outcome.hostId}=${outcome.status}${recoveryNote(outcome.recovery)}`,
    ),
    ...failed.map((outcome) => `${outcome.workspaceId}/${outcome.hostId} record failed: ${outcome.error}`),
  ];
  return (
    `[workspace-host-health] ${result.controllerId}: ${attested.length} attested, ` +
    `${unhealthy.length} not healthy, ${failed.length} not recorded | ${parts.join(' | ')}`
  );
}

/**
 * The control plane's side of WI-10005251: read the two Papercusp-hosted custom roles with the
 * delegation source (read-only, `roles/iam.roleViewer`) and file a finding per drifted role.
 * Heavy modules load lazily so a controller without a hosting project pays nothing.
 */
export function papercuspHostedRoleAttestationDbosRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PapercuspHostedRoleAttestationRuntime {
  let projectId: string | null = null;
  try {
    projectId = hostedGcpWorkspaceProject(env);
  } catch {
    projectId = null;
  }
  return {
    projectId,
    accessToken: async () => {
      const { hostedGcpDelegationSource } = await import('../workspace-host/hosted-gcp-auth');
      return hostedGcpDelegationSource(env).accessToken();
    },
    openFindingExists: async (watchdogKey) => {
      const { findIssuesByWatchdogKeys } = await import('../issues-engineer');
      const existing = await findIssuesByWatchdogKeys([watchdogKey]);
      return existing.some((issue) => issue.state === 'open');
    },
    fileFinding: async (finding) => {
      const { captureImprovement } = await import('../harness/improvements/capture-core');
      await captureImprovement({
        title: finding.title,
        kind: 'bug',
        severity: 'major',
        scope: 'operator',
        foundDuring: 'workspace-host standing health: hosted GCP role attestation (WI-10005251)',
        createdBy: 'system:hosted-gcp-role-attestation',
        sourceRole: 'system',
        source: 'su',
        dedupScope: 'open',
        watchdogKey: finding.watchdogKey,
        paths: [
          'packages/operator-core/lib/workspace-host/hosted-gcp-hosting.ts',
          'packages/operator-core/lib/workspace-host/hosted-gcp-roles.ts',
        ],
        body: finding.body,
      });
    },
  };
}

async function workspaceHostStandingHealthTick(): Promise<WorkspaceHostStandingHealthPassResult> {
  const result = await runWorkspaceHostStandingHealthPass(workspaceHostStandingHealthDbosRuntime());
  const summary = workspaceHostStandingHealthSummary(result);
  if (summary) console.log(summary);
  // Appended after the pass so the step order of in-flight older workflows is unchanged.
  const roles = await DBOS.runStep(
    () => runPapercuspHostedRoleAttestation(papercuspHostedRoleAttestationDbosRuntime()),
    { name: 'hosted-gcp-role-attestation', retriesAllowed: false },
  );
  const rolesSummary = papercuspHostedRoleAttestationSummary(roles);
  if (rolesSummary) console.log(rolesSummary);
  return result;
}

const workspaceHostStandingHealthWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_HEALTH_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostStandingHealthTick, {
    name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
    maxRecoveryAttempts: 3,
  }),
);

DBOS.registerScheduled(workspaceHostStandingHealthWorkflow, {
  name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
  crontab: WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
});

export const WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME = 'workspaceHostSpotReclaimSweep';

export function workspaceHostSpotReclaimSweepDbosRuntime(): WorkspaceHostSpotReclaimSweepRuntime {
  const standing = workspaceHostStandingHealthDbosRuntime();
  return {
    step: standing.step,
    controllerId: standing.controllerId,
    listSpotTargets: (controllerId) => listWorkspaceHostSpotReclaimTargets(controllerId),
    resolveSeams: standing.resolveSeams,
    recordHealth: standing.recordHealth,
    now: standing.now,
    reclaim: workspaceHostReclaimRestartSeams(),
  };
}

/**
 * A one-line summary, or null when no spot host was reclaimed and nothing failed to record. A
 * spot host the sweep could not read is left to the standing pass, which attests it as unknown, so
 * it is not repeated here every 2 minutes.
 */
export function workspaceHostSpotReclaimSweepSummary(result: WorkspaceHostSpotReclaimSweepResult): string | null {
  const parts: string[] = [];
  for (const outcome of result.outcomes) {
    if (outcome.kind === 'attested') {
      parts.push(`${outcome.workspaceId}/${outcome.hostId}=${outcome.status}${recoveryNote(outcome.recovery)}`);
    } else if (outcome.kind === 'record-failed') {
      parts.push(`${outcome.workspaceId}/${outcome.hostId} record failed: ${outcome.error}`);
    }
  }
  if (parts.length === 0) return null;
  return `[workspace-host-spot-reclaim] ${result.controllerId}: ${result.outcomes.length} spot host(s) read | ${parts.join(' | ')}`;
}

async function workspaceHostSpotReclaimSweepTick(): Promise<WorkspaceHostSpotReclaimSweepResult> {
  const result = await runWorkspaceHostSpotReclaimSweep(workspaceHostSpotReclaimSweepDbosRuntime());
  const summary = workspaceHostSpotReclaimSweepSummary(result);
  if (summary) console.log(summary);
  return result;
}

const workspaceHostSpotReclaimSweepWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostSpotReclaimSweepTick, {
    name: WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME,
    maxRecoveryAttempts: 3,
  }),
);

DBOS.registerScheduled(workspaceHostSpotReclaimSweepWorkflow, {
  name: WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME,
  crontab: WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB,
});
