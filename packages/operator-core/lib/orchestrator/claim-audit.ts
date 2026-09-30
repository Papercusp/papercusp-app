/**
 * claim_audit emitter.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-039.
 *
 * LOCAL (PG-only) audit log of every claim attempt the orchestrator
 * makes on a feature. Independent of the Autobase feature_claims log
 * — that one is the authoritative shared record; this is per-engineer
 * diagnostics.
 *
 * Schema: `harness_shared.claim_audit` (ensured by
 * `ensure-schema-dogfood.ts::ensureClaimAuditTable`).
 */

import { getOrgPg } from '@papercusp/db-org';

export type ClaimOutcome = 'won' | 'lost' | 'timeout' | 'error';

export interface ClaimAttempt {
  workspaceId: string;
  harnessSlug: string;
  feature_id: string;
  claimer_pubkey: string;
  outcome: ClaimOutcome;
  detail?: string;
  /** Override for tests. Defaults to `now()` in PG. */
  attempt_ts?: number;
}

const OUTCOMES: ReadonlySet<string> = new Set(['won', 'lost', 'timeout', 'error']);

export class ClaimAuditValidationError extends Error {
  constructor(public field: string, value: unknown) {
    super(`claim-audit: invalid ${field}: ${JSON.stringify(value)}`);
  }
}

export async function recordClaimAttempt(attempt: ClaimAttempt): Promise<void> {
  if (!attempt.workspaceId) throw new ClaimAuditValidationError('workspaceId', attempt.workspaceId);
  if (!attempt.harnessSlug) throw new ClaimAuditValidationError('harnessSlug', attempt.harnessSlug);
  if (!attempt.feature_id) throw new ClaimAuditValidationError('feature_id', attempt.feature_id);
  if (!attempt.claimer_pubkey) throw new ClaimAuditValidationError('claimer_pubkey', attempt.claimer_pubkey);
  if (!OUTCOMES.has(attempt.outcome)) throw new ClaimAuditValidationError('outcome', attempt.outcome);

  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.claim_audit
      (workspace_id, harness_slug, feature_id, claimer_pubkey, attempt_ts, outcome, detail)
    VALUES
      (${attempt.workspaceId},
       ${attempt.harnessSlug},
       ${attempt.feature_id},
       ${attempt.claimer_pubkey},
       ${attempt.attempt_ts != null ? sql`to_timestamp(${attempt.attempt_ts} / 1000.0)` : sql`now()`},
       ${attempt.outcome},
       ${attempt.detail ?? null})
  `;
}

export interface RecentAttemptsOpts {
  workspaceId: string;
  harnessSlug: string;
  feature_id?: string;
  limit?: number;
}

export interface ClaimAuditRow {
  id: number;
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  claimer_pubkey: string;
  attempt_ts: Date;
  outcome: ClaimOutcome;
  detail: string | null;
}

export async function recentClaimAttempts(opts: RecentAttemptsOpts): Promise<ClaimAuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const { sql } = getOrgPg();
  if (opts.feature_id) {
    const rows = await sql<ClaimAuditRow[]>`
      SELECT id, workspace_id, harness_slug, feature_id, claimer_pubkey,
             attempt_ts, outcome, detail
        FROM harness_shared.claim_audit
       WHERE workspace_id = ${opts.workspaceId}
         AND harness_slug = ${opts.harnessSlug}
         AND feature_id = ${opts.feature_id}
       ORDER BY attempt_ts DESC
       LIMIT ${limit}
    `;
    return rows;
  }
  const rows = await sql<ClaimAuditRow[]>`
    SELECT id, workspace_id, harness_slug, feature_id, claimer_pubkey,
           attempt_ts, outcome, detail
      FROM harness_shared.claim_audit
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
     ORDER BY attempt_ts DESC
     LIMIT ${limit}
  `;
  return rows;
}

export const _testing = {
  OUTCOMES,
};
