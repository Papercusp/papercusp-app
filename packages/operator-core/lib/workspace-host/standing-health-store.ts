/**
 * Target selection for the standing health pass (WI-10004950, see standing-health.ts).
 *
 * Cross-workspace by design: one controller serves hosts in every workspace it provisioned, so the
 * read uses the admin pool (`getOrgPg`, RLS-bypassing — `workspace_hosts` forces RLS) and scopes by
 * the controller authority stamped on each row instead of by workspace. The attestation WRITE stays
 * workspace-scoped (`recordWorkspaceHostHealth` → `withWorkspace`).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { RunWorkspaceHostLifecycleInput } from './lifecycle-runner';
import { readWorkspaceHostConnection, readWorkspaceHostDestroyTarget } from './observability-store';
import type { WorkspaceHostReclaimRestartPlan, WorkspaceHostStandingHealthTarget } from './standing-health';

/** The actor a spot-reclaim restart is attributed to in lifecycle records (WI-10005210). */
export const WORKSPACE_HOST_SPOT_RECLAIM_ACTOR = 'system:workspace-host-spot-reclaim';

/** The lifecycle request a reclaim restart enqueues (the DBOS start input). */
export type WorkspaceHostReclaimRestartInput = Omit<RunWorkspaceHostLifecycleInput, 'provider' | 'store' | 'signal'> & {
  operationId: string;
};

/** The host's desired state RIGHT NOW, read with the same admin pool the target list uses. */
export async function readWorkspaceHostDesiredState(
  workspaceId: string,
  hostId: string,
  sql?: Sql,
): Promise<string | null> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ desired_state: string }>>`
    SELECT desired_state
      FROM harness_shared.workspace_hosts
     WHERE workspace_id = ${workspaceId} AND id = ${hostId}
     LIMIT 1
  `;
  return rows[0]?.desired_state ?? null;
}

export interface WorkspaceHostReclaimRestartDeps {
  readDesiredState?: (workspaceId: string, hostId: string) => Promise<string | null>;
  readTarget?: (workspaceId: string, hostId: string) => ReturnType<typeof readWorkspaceHostDestroyTarget>;
  readConnection?: (workspaceId: string, connectionId: string) => ReturnType<typeof readWorkspaceHostConnection>;
}

/**
 * Build the lifecycle `start` for a reclaimed spot host, or say why not (WI-10005210).
 *
 * The desired state is re-read here rather than trusted from the target list: a controller stop
 * that completed after the list was taken leaves a stopped spot VM that is the customer's choice,
 * not a reclaim, and restarting it would undo the stop. The request is the same shape the
 * workspace-host action route builds for a `start`.
 */
export async function prepareWorkspaceHostReclaimRestart(
  target: { workspaceId: string; hostId: string },
  operationId: string,
  deps: WorkspaceHostReclaimRestartDeps = {},
): Promise<WorkspaceHostReclaimRestartPlan> {
  const { workspaceId, hostId } = target;
  const desiredState = await (deps.readDesiredState ?? readWorkspaceHostDesiredState)(workspaceId, hostId);
  if (desiredState === null) return { kind: 'skip', reason: 'the host row is gone' };
  if (!(WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES as readonly string[]).includes(desiredState)) {
    return { kind: 'skip', reason: `desired state is now '${desiredState}', so the stop was ordered, not a reclaim` };
  }
  const host = await (deps.readTarget ?? ((ws, id) => readWorkspaceHostDestroyTarget(ws, id)))(workspaceId, hostId);
  if (!host) return { kind: 'skip', reason: 'the host row is gone' };
  if (host.desired.target === 'aws') {
    // WI-10005389: an AWS spot host runs on a persistent spot request with stop-on-interrupt, and
    // EC2 itself restarts the instance once capacity returns. EC2 refuses a StartInstances on an
    // instance it interrupted, so a controller start could only fail. The reclaim is still
    // attested, so the host reads unhealthy until the next standing pass sees it running.
    return {
      kind: 'skip',
      reason: 'EC2 restarts an interrupted persistent spot instance itself; a controller start is refused',
    };
  }
  const stored = await (deps.readConnection ?? ((ws, id) => readWorkspaceHostConnection(ws, id)))(
    workspaceId,
    host.connectionId,
  );
  if (!stored) return { kind: 'skip', reason: `workspace-host connection '${host.connectionId}' was not found` };
  const input: WorkspaceHostReclaimRestartInput = {
    workspaceId,
    hostId,
    action: 'start',
    connection: { ...stored.connection, scope: host.desired.scope },
    operationId,
    actorId: WORKSPACE_HOST_SPOT_RECLAIM_ACTOR,
  };
  return { kind: 'restart', operationId, input };
}

/**
 * Lifecycle states in which a host is meant to be up. `repairing`, `provisioning`, `stopped` and the
 * teardown states are excluded: a lifecycle action owns those hosts and expects them to be down or
 * changing, so a standing "unreachable" there would be noise.
 */
export const WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES = ['running', 'degraded'] as const;

/** The clouds with standing seams (`resolveWorkspaceHostSoakSeams` dispatches on the host's target). */
export const WORKSPACE_HOST_STANDING_HEALTH_TARGETS = ['gcp', 'aws'] as const;

interface TargetRow {
  workspace_id: string;
  id: string;
  health_attested_at: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Every live host whose controller authority is `controllerId`, in a stable order. */
export async function listWorkspaceHostStandingHealthTargets(
  controllerId: string,
  sql?: Sql,
): Promise<WorkspaceHostStandingHealthTarget[]> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<TargetRow[]>`
    SELECT workspace_id, id, health_attested_at
      FROM harness_shared.workspace_hosts
     WHERE controller_id = ${controllerId}
       AND target = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_TARGETS] as string[]}::text[])
       AND desired_state = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES] as string[]}::text[])
       AND desired_spec IS NOT NULL
     ORDER BY workspace_id, id
  `;
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    hostId: row.id,
    healthAttestedAt: isoOrNull(row.health_attested_at),
  }));
}

/**
 * The `desired_spec.provider.provisioningModel` value of a spot host (gcp-provider.ts
 * `GCP_WORKSPACE_HOST_PROVISIONING_MODELS`, aws-provider.ts `AWS_WORKSPACE_HOST_PROVISIONING_MODELS`;
 * an absent value means `standard`).
 */
export const WORKSPACE_HOST_SPOT_PROVISIONING_MODEL = 'spot';

/**
 * Every live SPOT host whose controller authority is `controllerId`, for the spot-reclaim sweep
 * (WI-10005210). The same authority and liveness rules as the standing list, narrowed to spot, so
 * the 2-minute sweep never reads an on-demand host the cloud cannot reclaim.
 */
export async function listWorkspaceHostSpotReclaimTargets(
  controllerId: string,
  sql?: Sql,
): Promise<{ workspaceId: string; hostId: string }[]> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ workspace_id: string; id: string }>>`
    SELECT workspace_id, id
      FROM harness_shared.workspace_hosts
     WHERE controller_id = ${controllerId}
       AND target = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_TARGETS] as string[]}::text[])
       AND desired_state = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES] as string[]}::text[])
       AND desired_spec -> 'provider' ->> 'provisioningModel' = ${WORKSPACE_HOST_SPOT_PROVISIONING_MODEL}
     ORDER BY workspace_id, id
  `;
  return rows.map((row) => ({ workspaceId: row.workspace_id, hostId: row.id }));
}
