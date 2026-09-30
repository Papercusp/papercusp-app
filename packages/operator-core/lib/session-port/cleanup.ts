import { markAdvSessionEnded, updateAdvSessionPortStatus } from '../adv-sessions';
import { deleteSessionPortArtifact, pruneStaleSessionPortArtifacts } from './artifact';
import {
  sessionPortsNeedingCleanup,
  transitionSessionPort,
  type SessionPortRow,
} from './store';
import { recordSessionPortTelemetry } from './telemetry';

export interface SessionPortCleanupResult {
  expiredRows: number;
  targetsFailed: number;
  artifactsDeleted: number;
  orphanArtifactsDeleted: number;
  errors: number;
}

/** Reused by the existing telemetry-retention action. This is deliberately not
 * its own timer/routine: immediate delivery deletion is primary, and this
 * idempotent pass repairs only crash/TTL residue. */
export async function cleanupExpiredSessionPorts(input: {
  workspaceId: string;
  rows?: SessionPortRow[];
  list?: typeof sessionPortsNeedingCleanup;
  deleteArtifact?: typeof deleteSessionPortArtifact;
  pruneArtifacts?: typeof pruneStaleSessionPortArtifacts;
  updateTarget?: typeof updateAdvSessionPortStatus;
  endTarget?: typeof markAdvSessionEnded;
  transition?: typeof transitionSessionPort;
  recordTelemetry?: typeof recordSessionPortTelemetry;
}): Promise<SessionPortCleanupResult> {
  const list = input.list ?? sessionPortsNeedingCleanup;
  const rows = input.rows ?? await list(input.workspaceId);
  const deleteArtifact = input.deleteArtifact ?? deleteSessionPortArtifact;
  const updateTarget = input.updateTarget ?? updateAdvSessionPortStatus;
  const endTarget = input.endTarget ?? markAdvSessionEnded;
  const transition = input.transition ?? transitionSessionPort;
  const recordTelemetry = input.recordTelemetry ?? recordSessionPortTelemetry;
  const out: SessionPortCleanupResult = {
    expiredRows: rows.length,
    targetsFailed: 0,
    artifactsDeleted: 0,
    orphanArtifactsDeleted: 0,
    errors: 0,
  };

  for (const row of rows) {
    let artifactComplete = false;
    let cleanupOutcome: 'deleted' | 'already-absent' | 'failed' = 'failed';
    try {
      const deleted = await deleteArtifact(row.artifactPath);
      if (deleted) out.artifactsDeleted += 1;
      cleanupOutcome = deleted ? 'deleted' : 'already-absent';
      artifactComplete = true; // false means already absent, also complete
    } catch {
      out.errors += 1;
    }

    let targetComplete = row.targetAdvSessionId == null;
    if (row.targetAdvSessionId != null) {
      try {
        targetComplete = await updateTarget(row.targetAdvSessionId, input.workspaceId, 'failed', {
          deliveryErrorClass: 'preparation-expired',
        });
        // 'cleanup', not 'self': nothing observed this session exit — it never ran. The
        // stamp is the administrative close time, so it cannot answer "when did it end".
        // exitCode NULL, not 1, for the same reason adv-sessions.ts refuses a sentinel in
        // reconcileDeadTerminalLaunches: we never reaped this process, so we never observed
        // a status, and a fabricated 1 is indistinguishable from an observed failure. The
        // failure itself is already recorded by updateTarget(status 'failed') above.
        await endTarget(row.targetAdvSessionId, null, 'cleanup');
        if (targetComplete) out.targetsFailed += 1;
        else out.errors += 1;
      } catch {
        out.errors += 1;
      }
    }

    try {
      await transition(row.id, input.workspaceId, 'expired', {
        metadata: {
          cleanupComplete: artifactComplete && targetComplete,
          cleanupArtifactAbsent: artifactComplete,
          cleanupTargetEnded: targetComplete,
        },
      });
    } catch {
      out.errors += 1;
    }

    // Expiration is a failed delivery, not merely a maintenance counter. Keep
    // the lifecycle visible with the same content-free allowlisted telemetry
    // as immediate failures; telemetry itself remains best-effort.
    await recordTelemetry({
      workspaceId: input.workspaceId,
      stage: 'failed',
      portId: row.id,
      sourceAdvSessionId: row.sourceAdvSessionId,
      targetAdvSessionId: row.targetAdvSessionId,
      sourceBackend: row.sourceBackend,
      targetBackend: row.targetBackend,
      targetModel: row.targetModel,
      sourceHash: row.sourceHash,
      renderedHash: row.renderedHash,
      protocolVersion: row.protocolVersion,
      cleanupOutcome,
      failureClass: 'preparation-expired',
    });
  }

  try {
    const pruned = await (input.pruneArtifacts ?? pruneStaleSessionPortArtifacts)();
    out.orphanArtifactsDeleted = pruned.removed;
    out.errors += pruned.errors;
  } catch {
    out.errors += 1;
  }
  return out;
}
