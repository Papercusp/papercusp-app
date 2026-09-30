/**
 * Telemetry pull — read `tool_invocations` + `operator_continue_chains`
 * rows tagged with this run's `uiClientId` so deterministic asserts
 * (tool_called, continue_chain_within_cap, mem0_*, spawn_dispatched)
 * actually have data to check.
 *
 * Plan §4.4 + §5.3. Queries are tolerant of the partial telemetry
 * tagging audit (§5.4) — until every tool threads `uiClientId`, some
 * runs will return fewer rows than the SUT actually called.
 */

import { sharedUtilityPoolMax } from '../resource-profile';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';

import type { ContinueChainRow, ToolInvocationRow } from '@papercusp/testing-shell/llm';

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () => getLongLivedAdminPool('llm-testing-telemetry', {
  max: sharedUtilityPoolMax(),
  prepare: false,
});

/**
 * Pull every tool_invocations row tagged with this run's uiClientId.
 * Caller threads in the same `llm-testing/<runId>` string the operator
 * target uses when POSTing to converse.
 */
export async function pullToolInvocations(uiClientId: string): Promise<ToolInvocationRow[]> {
  const sql = db();
  const rows = await sql<Array<{
    tool_name: string;
    plugin_name: string;
    role: string;
    duration_ms: number | null;
    status: string;
    output_size: number | null;
    error_message: string | null;
    metadata_json: Record<string, unknown> | null;
  }>>`
    SELECT tool_name, plugin_name, role, duration_ms, status,
           output_size, error_message, metadata_json
    FROM harness_shared.tool_invocations
    WHERE metadata_json @> ${sql.json({ uiClientId })}
    ORDER BY invoked_at ASC
  `;
  // The runner's RunSummary.ToolInvocationRow shape is a thin projection.
  // The raw row carries more context than the asserts need; collapse for now.
  return rows.map((r) => ({
    toolName: r.tool_name,
    argsJson: null,                 // args aren't stored in tool_invocations
    resultJson: r.error_message ?? null,
    costUsd: 0,                     // not tracked per-tool in this table
    latencyMs: r.duration_ms ?? 0,
    metadataJson: r.metadata_json ?? {},
  }));
}

/**
 * Pull every operator_continue_chains row tagged with this run's
 * uiClientId. Used by `continue_chain_within_cap` + `auto_fire_happened`
 * asserts.
 *
 * Returns empty array when the operator provider hasn't been wired to
 * write continue-chain rows yet — asserts treat this as "no chains",
 * which is correct when nothing in the run triggered <continue/>.
 */
export async function pullContinueChainRows(uiClientId: string): Promise<ContinueChainRow[]> {
  const sql = db();
  const rows = await sql<Array<{
    chain_id: string;
    turn_idx: number;
    trigger: string;
    started_at: Date;
    elapsed_secs_in_chain: string;   // numeric → string from postgres-js
    was_capped: boolean;
    cap_reason: string | null;
  }>>`
    SELECT chain_id, turn_idx, trigger, started_at,
           elapsed_secs_in_chain, was_capped, cap_reason
    FROM harness_shared.operator_continue_chains
    WHERE ui_client_id = ${uiClientId}
    ORDER BY started_at ASC, turn_idx ASC
  `;
  return rows.map((r) => ({
    chainId: r.chain_id,
    turnIdx: r.turn_idx,
    trigger: r.trigger as ContinueChainRow['trigger'],
    startedAt: r.started_at,
    elapsedSecsInChain: Number(r.elapsed_secs_in_chain),
    wasCapped: r.was_capped,
    capReason: r.cap_reason,
  }));
}
