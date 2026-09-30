/**
 * fleet/governor — the layered backpressure governor (papercusp binding).
 *
 * The mechanism (token bucket + bulkhead + circuit breaker + credits, all-or-nothing
 * admission) lives in @papercusp/structured-concurrency's `createGovernor`. This module
 * binds it to the PG governor store (harness_shared.fleet_governor) and keeps the
 * historical `<fn>(sql, opts)` entry points the fleet:governor / fleet:admit tools use.
 */
import type { Sql } from 'postgres';
import {
  createGovernor,
  DEFAULT_CB_COOLDOWN_SEC,
  DEFAULT_CB_THRESHOLD,
  type AdmitInput,
  type AdmitResult,
  type CircuitState,
} from '@papercusp/structured-concurrency';
import { pgGovernorStore } from './pg-stores';

export { DEFAULT_CB_THRESHOLD, DEFAULT_CB_COOLDOWN_SEC };
export type { CircuitState, AdmitInput, AdmitResult } from '@papercusp/structured-concurrency';

const gov = (sql: Sql) => createGovernor(pgGovernorStore(sql));

export async function configureBucket(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; capacity: number; refillPerSec: number; tokens?: number; now?: number },
): Promise<void> {
  await gov(sql).configureBucket(opts);
}

export async function configureCircuit(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; threshold?: number; cooldownSec?: number },
): Promise<void> {
  await gov(sql).configureCircuit(opts);
}

export async function configureCredits(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; credits: number; max?: number },
): Promise<void> {
  await gov(sql).configureCredits(opts);
}

export async function grantCredits(sql: Sql, opts: { workspaceId: string; scopeKey: string; n: number }): Promise<number> {
  return gov(sql).grantCredits(opts);
}

export async function recordCircuitSuccess(sql: Sql, opts: { workspaceId: string; scopeKey: string }): Promise<void> {
  await gov(sql).recordCircuitSuccess(opts);
}

export async function recordCircuitFailure(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; now?: number },
): Promise<{ state: CircuitState; failures: number } | null> {
  return gov(sql).recordCircuitFailure(opts);
}

export async function admitSpawn(sql: Sql, input: AdmitInput): Promise<AdmitResult> {
  return gov(sql).admitSpawn(input);
}

/**
 * Try to consume ONE pre-granted spawn credit from a stream's budget pool
 * (unify-agent-spawn-chokepoint P-009). Atomic (row-locked): if the
 * `fleet_governor` credit pool for `scopeKey` exists with credits > 0, decrement it
 * and return true; otherwise return false (no pool / exhausted). This is the
 * "trusted stream spawns freely up to its budget" check — the brain pre-allocates a
 * budget via `fleet:governor { op:'grant_n', scopeKey }` (or configureCredits/
 * grantCredits), and `new_subagent:request` consumes one here to AUTO-APPROVE,
 * skipping per-spawn brain adjudication, until the budget runs out (then it routes
 * to the brain). Distinct from `admitSpawn`, which admits-by-default when no credit
 * gate is configured — this returns false unless a credit was actually available.
 */
export async function tryConsumeSpawnCredit(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ credits: number | null }[]>`
      SELECT credits FROM harness_shared.fleet_governor
       WHERE workspace_id = ${opts.workspaceId} AND kind = 'credit' AND scope_key = ${opts.scopeKey}
       FOR UPDATE`;
    if (!rows.length || rows[0].credits == null || Number(rows[0].credits) <= 0) return false;
    await tx`
      UPDATE harness_shared.fleet_governor SET credits = credits - 1
       WHERE workspace_id = ${opts.workspaceId} AND kind = 'credit' AND scope_key = ${opts.scopeKey}`;
    return true;
  }) as Promise<boolean>;
}

/** The fleet_governor credit-pool scope key for an agent stream's pre-granted spawn
 *  budget (P-009). The brain grants to this key; `new_subagent:request` consumes it. */
export function spawnBudgetScopeKey(streamOwnerId: string): string {
  return `spawn-budget:${streamOwnerId}`;
}
