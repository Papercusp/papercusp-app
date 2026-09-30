/**
 * Durable implementation of the workspace-host initialization replay seam (P-046 / WI-40474).
 *
 * The contract in `@papercusp/deployment-driver` declares
 * `WorkspaceHostInitializationReplayStore.runOnce()` as the durable controller seam: it must
 * EITHER return the prior receipt for a completed identity OR own and persist exactly one
 * execution. Until now the only implementation was an in-memory one inside the contract's own
 * test file, which is why `ReplaySafeWorkspaceHostInitializationExecutor` was never constructed
 * in production despite the contract and the GCP IAP host adapter both being complete.
 *
 * Ownership model
 * ---------------
 * The primary key IS the idempotency key, so two controllers racing the same step collide on
 * INSERT rather than both executing. A winner holds a time-bounded lease; a lease that expires
 * (crashed controller) is reclaimable, so a step can never be wedged forever by a dead process.
 *
 * The closure deliberately runs OUTSIDE any open transaction. It performs network I/O against a
 * real host, and holding a Postgres transaction open across that would pin a connection for the
 * duration of a remote operation.
 */
import { withWorkspace } from '@papercusp/db-org';
import type {
  WorkspaceHostInitializationReplayIdentity,
  WorkspaceHostInitializationReplayStore,
  WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';

const FINGERPRINT = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export interface WorkspaceHostInitializationReplayStoreOptions {
  workspaceId: string;
  /** The provisioned host these steps run against; rows are FK'd to it. */
  hostId: string;
  /** Stable identity of the controller taking leases, so its own lease is re-entrant. */
  leaseOwner: string;
  /** How long a claim stays owned before another controller may reclaim it. */
  leaseTtlMs?: number;
  /** Test seam. */
  now?: () => Date;
}

/** Raised when one idempotency key is reused for a materially different step. */
export class WorkspaceHostInitializationReplayConflictError extends Error {
  readonly idempotencyKey: string;
  readonly expectedFingerprint: string;
  readonly actualFingerprint: string;

  constructor(idempotencyKey: string, expected: string, actual: string) {
    super(
      `Workspace-host initialization idempotency key '${idempotencyKey}' was reused with a ` +
        `different step (stored fingerprint ${expected}, supplied ${actual})`,
    );
    this.name = 'WorkspaceHostInitializationReplayConflictError';
    this.idempotencyKey = idempotencyKey;
    this.expectedFingerprint = expected;
    this.actualFingerprint = actual;
  }
}

/** Raised when another controller currently holds a live lease on the step. */
export class WorkspaceHostInitializationReplayInFlightError extends Error {
  readonly idempotencyKey: string;
  readonly leaseOwner: string;

  constructor(idempotencyKey: string, leaseOwner: string) {
    super(
      `Workspace-host initialization step '${idempotencyKey}' is already in flight under ` +
        `controller '${leaseOwner}'`,
    );
    this.name = 'WorkspaceHostInitializationReplayInFlightError';
    this.idempotencyKey = idempotencyKey;
    this.leaseOwner = leaseOwner;
  }
}

interface StoredRow {
  step_id: string | null;
  step_fingerprint: string;
  status: 'running' | 'succeeded';
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  observed_at: string | Date | null;
  public_evidence: Record<string, unknown> | null;
}

function isoOf(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function receiptOf(row: StoredRow, idempotencyKey: string): WorkspaceHostInitializationStepReceipt {
  const observedAt = isoOf(row.observed_at);
  if (!row.step_id || !observedAt) {
    // The succeeded-row CHECK constraint makes this unreachable; failing loudly beats
    // handing back a receipt with missing fields.
    throw new Error(
      `Stored initialization receipt for '${idempotencyKey}' is incomplete (step_id or observed_at is null)`,
    );
  }
  return {
    stepId: row.step_id,
    status: 'succeeded',
    observedAt,
    ...(row.public_evidence ? { publicEvidence: row.public_evidence } : {}),
  };
}

export function createWorkspaceHostInitializationReplayStore(
  options: WorkspaceHostInitializationReplayStoreOptions,
): WorkspaceHostInitializationReplayStore {
  const { workspaceId, hostId, leaseOwner } = options;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => new Date());

  if (!workspaceId) throw new Error('replay store requires a workspaceId');
  if (!hostId) throw new Error('replay store requires a hostId');
  if (!leaseOwner) throw new Error('replay store requires a leaseOwner');
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error('replay store requires a positive leaseTtlMs');
  }

  return {
    async runOnce(
      identity: WorkspaceHostInitializationReplayIdentity,
      run: () => Promise<WorkspaceHostInitializationStepReceipt>,
    ): Promise<WorkspaceHostInitializationStepReceipt> {
      const { idempotencyKey, stepFingerprint } = identity;
      if (!idempotencyKey) throw new Error('replay identity requires an idempotencyKey');
      if (!FINGERPRINT.test(stepFingerprint)) {
        throw new Error(
          `replay identity requires a sha-256 stepFingerprint, received '${stepFingerprint}'`,
        );
      }

      // --- Phase 1: claim, or short-circuit on a prior receipt. -------------------------------
      const claimed = await withWorkspace(workspaceId, async (tx) => {
        const at = now();
        const expiresAt = new Date(at.getTime() + leaseTtlMs).toISOString();

        const existing = (await tx`
          SELECT step_id, step_fingerprint, status, lease_owner, lease_expires_at,
                 observed_at, public_evidence
            FROM harness_shared.workspace_host_initialization_steps
           WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}
           FOR UPDATE
        `) as unknown as StoredRow[];

        const row = existing[0];

        if (!row) {
          await tx`
            INSERT INTO harness_shared.workspace_host_initialization_steps (
              workspace_id, idempotency_key, host_id, step_fingerprint,
              status, lease_owner, lease_expires_at, created_at, updated_at
            ) VALUES (
              ${workspaceId}, ${idempotencyKey}, ${hostId}, ${stepFingerprint},
              'running', ${leaseOwner}, ${expiresAt}, now(), now()
            )
          `;
          return { owned: true as const };
        }

        // A reused key with different input must never silently return another step's receipt.
        if (row.step_fingerprint !== stepFingerprint) {
          throw new WorkspaceHostInitializationReplayConflictError(
            idempotencyKey,
            row.step_fingerprint,
            stepFingerprint,
          );
        }

        if (row.status === 'succeeded') {
          return { owned: false as const, receipt: receiptOf(row, idempotencyKey) };
        }

        const leaseExpiry = isoOf(row.lease_expires_at);
        const leaseLive = leaseExpiry !== null && Date.parse(leaseExpiry) > at.getTime();
        if (leaseLive && row.lease_owner !== leaseOwner) {
          throw new WorkspaceHostInitializationReplayInFlightError(
            idempotencyKey,
            row.lease_owner ?? 'unknown',
          );
        }

        // Either our own lease (re-entrant retry) or a stale one from a crashed controller.
        await tx`
          UPDATE harness_shared.workspace_host_initialization_steps
             SET lease_owner = ${leaseOwner}, lease_expires_at = ${expiresAt}, updated_at = now()
           WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}
        `;
        return { owned: true as const };
      });

      if (!claimed.owned) return claimed.receipt;

      // --- Phase 2: execute outside any open transaction. -------------------------------------
      let receipt: WorkspaceHostInitializationStepReceipt;
      try {
        receipt = await run();
      } catch (error) {
        // Release the claim so a later attempt starts clean rather than inheriting a dead lease.
        await withWorkspace(workspaceId, async (tx) => {
          await tx`
            DELETE FROM harness_shared.workspace_host_initialization_steps
             WHERE workspace_id = ${workspaceId}
               AND idempotency_key = ${idempotencyKey}
               AND status = 'running'
               AND lease_owner = ${leaseOwner}
          `;
        }).catch(() => {
          // The original failure is the interesting one; never mask it with cleanup noise.
        });
        throw error;
      }

      // --- Phase 3: persist the receipt. ------------------------------------------------------
      await withWorkspace(workspaceId, async (tx) => {
        await tx`
          UPDATE harness_shared.workspace_host_initialization_steps
             SET status = 'succeeded',
                 step_id = ${receipt.stepId},
                 observed_at = ${receipt.observedAt},
                 public_evidence = ${
                   receipt.publicEvidence === undefined
                     ? null
                     : tx.json(receipt.publicEvidence as never)
                 },
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 updated_at = now()
           WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}
        `;
      });

      return receipt;
    },
  };
}
