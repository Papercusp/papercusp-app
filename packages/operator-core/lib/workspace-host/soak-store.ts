/**
 * Durable soak samples (D-391). Samples are controller-side OBSERVATIONS of a host, so they live
 * in the host's own log stream (`stream='controller'`, `unit='workspace-host-soak'`) rather than a
 * table of their own — they show up on the host timeline beside everything else that happened to
 * it — and they are deliberately NOT a `workspace_host_operations` row: operations are the fenced
 * lifecycle ledger, and a 24h reader holding the host's controller fence would lock every real
 * lifecycle action out for a day.
 */
import { withWorkspace } from '@papercusp/db-org';
import { appendWorkspaceHostLogs, recordWorkspaceHostHealth } from './observability-store';
import {
  WORKSPACE_HOST_SOAK_LOG_UNIT,
  parseWorkspaceHostSoakSample,
  workspaceHostSoakAttestation,
  workspaceHostSoakSampleOk,
  type WorkspaceHostSoakPolicy,
  type WorkspaceHostSoakSample,
} from './soak';

/** Everything a later reader needs to judge a soak from its rows alone, carried on every row. */
export interface WorkspaceHostSoakEnvelope {
  policy: WorkspaceHostSoakPolicy;
  releaseTaskId: string | null;
}

/**
 * Deterministic per-sample row id. The DBOS step that writes a sample can re-execute after a crash
 * between the write and the step's checkpoint; `ON CONFLICT DO NOTHING` on this id makes that
 * replay a no-op instead of a duplicate that would shrink the measured gaps.
 */
export function workspaceHostSoakSampleLogId(soakId: string, sequence: number): string {
  return `soak:${soakId}:${sequence}`;
}

export async function recordWorkspaceHostSoakSample(input: {
  workspaceId: string;
  hostId: string;
  sample: WorkspaceHostSoakSample;
  envelope: WorkspaceHostSoakEnvelope;
}): Promise<void> {
  const { sample } = input;
  const failing = sample.checks.filter((check) => check.ok === false).map((check) => check.name);
  const unmeasured = sample.checks.filter((check) => check.ok === null).map((check) => check.name);
  await appendWorkspaceHostLogs(input.workspaceId, input.hostId, [
    {
      id: workspaceHostSoakSampleLogId(sample.soakId, sample.sequence),
      observedAt: sample.observedAt,
      stream: 'controller',
      unit: WORKSPACE_HOST_SOAK_LOG_UNIT,
      level: workspaceHostSoakSampleOk(sample) ? 'info' : 'warn',
      message:
        `soak ${sample.soakId} sample ${sample.sequence}: ` +
        (failing.length > 0 ? `${failing.join(', ')} failing` : 'all measured checks passing') +
        (unmeasured.length > 0 ? `; unmeasured: ${unmeasured.join(', ')}` : ''),
      metadata: { ...sample, soak: input.envelope },
    },
  ]);
  await recordWorkspaceHostHealth(input.workspaceId, workspaceHostSoakAttestation(input.hostId, sample));
}

function parsePolicy(value: unknown): WorkspaceHostSoakPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    'durationMs',
    'intervalMs',
    'maxGapIntervals',
    'maxReachFailureRate',
    'maxConsecutiveReachFailures',
    'minSampleCoverage',
  ] as const;
  if (!keys.every((key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, raw[key]])) as unknown as WorkspaceHostSoakPolicy;
}

export interface WorkspaceHostSoakRecord {
  soakId: string;
  envelope: WorkspaceHostSoakEnvelope | null;
  samples: WorkspaceHostSoakSample[];
  /** Rows that exist for this soak but do not parse — excluded, and so costing coverage. */
  malformedRows: number;
}

/** Read one soak back from the rows it wrote. This, not a workflow tally, is what gets judged. */
export async function readWorkspaceHostSoak(
  workspaceId: string,
  hostId: string,
  soakId: string,
): Promise<WorkspaceHostSoakRecord> {
  const rows = await withWorkspace(workspaceId, (tx) => tx<Array<{ metadata: unknown }>>`
    SELECT metadata
      FROM harness_shared.workspace_host_logs
     WHERE workspace_id = ${workspaceId}
       AND host_id = ${hostId}
       AND stream = 'controller'
       AND unit = ${WORKSPACE_HOST_SOAK_LOG_UNIT}
       AND metadata ->> 'soakId' = ${soakId}
     ORDER BY observed_at, id
  `);
  const samples: WorkspaceHostSoakSample[] = [];
  let envelope: WorkspaceHostSoakEnvelope | null = null;
  let malformedRows = 0;
  for (const row of rows) {
    const sample = parseWorkspaceHostSoakSample(row.metadata);
    if (!sample) {
      malformedRows += 1;
      continue;
    }
    samples.push(sample);
    if (!envelope) {
      const soak = (row.metadata as { soak?: { policy?: unknown; releaseTaskId?: unknown } }).soak;
      const policy = parsePolicy(soak?.policy);
      if (policy) {
        envelope = {
          policy,
          releaseTaskId: typeof soak?.releaseTaskId === 'string' ? soak.releaseTaskId : null,
        };
      }
    }
  }
  return { soakId, envelope, samples, malformedRows };
}

/** The release the host reports running (bundle digest + version), or null when unrecorded. */
export async function readWorkspaceHostRuntimeRelease(workspaceId: string, hostId: string): Promise<unknown> {
  const rows = await withWorkspace(workspaceId, (tx) => tx<Array<{ runtime_release: unknown }>>`
    SELECT runtime_release
      FROM harness_shared.workspace_hosts
     WHERE workspace_id = ${workspaceId} AND id = ${hostId}
  `);
  return rows[0]?.runtime_release ?? null;
}

/** The most recent soak recorded for a host, or null when it was never soaked. */
export async function readLatestWorkspaceHostSoakId(workspaceId: string, hostId: string): Promise<string | null> {
  const rows = await withWorkspace(workspaceId, (tx) => tx<Array<{ soak_id: string | null }>>`
    SELECT metadata ->> 'soakId' AS soak_id
      FROM harness_shared.workspace_host_logs
     WHERE workspace_id = ${workspaceId}
       AND host_id = ${hostId}
       AND stream = 'controller'
       AND unit = ${WORKSPACE_HOST_SOAK_LOG_UNIT}
     ORDER BY observed_at DESC, id DESC
     LIMIT 1
  `);
  return rows[0]?.soak_id ?? null;
}
