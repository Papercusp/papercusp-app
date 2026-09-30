/**
 * Operator continue-chain ledger writes.
 *
 * Records one row per V8 auto-fire / <continue/> chain turn into
 * harness_shared.operator_continue_chains so deterministic asserts
 * (continue_chain_within_cap, auto_fire_happened, auto_fire_did_not_happen)
 * have data to work from.
 *
 * Triggers:
 *   - 'continue'              → the brain emitted <continue/>; provider
 *                                auto-fired the next turn
 *   - 'auto_fire_terminal'    → V8 terminal-question detector fired
 *                                user_says_ready after a `?` ending
 *   - 'reset'                 → user input ended an active chain
 *
 * Chain identity is reconstructed server-side: an arriving auto-fire
 * for (conversation_id, ui_client_id) extends the most recent chain
 * row in the last 5 minutes; otherwise a new chain_id is minted.
 *
 * Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md §5.3
 */

import { randomUUID } from 'node:crypto';
import { sharedUtilityPoolMax } from './resource-profile';

import { getLongLivedAdminPool } from './long-lived-admin-pool';
import { activeWorkspaceId } from './workspace-registry';

// EI-19306394439939264: was a module-level `let pool` that tracked no URL, so it could
// never notice the DB endpoint moving underneath it (WI-6739 — ~100 min of ECONNREFUSED
// to a dead embedded-pg port). The accessor re-resolves and rebinds; attribution options
// and idle_timeout now come from it, so this site cannot forget either.
function db() {
  return getLongLivedAdminPool('operator-continue-chains', {
    max: sharedUtilityPoolMax(),
    prepare: false,
  });
}

const CHAIN_LOOKBACK_SECS = 300; // 5 min — matches the V8 default maxContinueChainSecs

export interface ChainEventInput {
  conversationId: string;
  uiClientId: string;
  trigger: 'continue' | 'auto_fire_terminal' | 'reset';
}

/**
 * Record one chain event. Best-effort — DB hiccups warn but don't
 * propagate (the converse turn itself must not fail because of
 * telemetry).
 */
export async function recordChainEvent(input: ChainEventInput): Promise<void> {
  try {
    await writeChainEvent(input);
  } catch (err) {
    console.warn(
      `[operator-continue-chains] write failed (${input.trigger}): ${(err as Error).message}`,
    );
  }
}

async function writeChainEvent(input: ChainEventInput): Promise<void> {
  const sql = db();
  // Look at the most recent row for this (conversation, ui_client) pair
  // within the lookback. If the most recent row is a 'reset', the chain
  // is closed; otherwise we extend it.
  const recent = await sql<Array<{
    chain_id: string;
    turn_idx: number;
    trigger: string;
    started_at: Date;
  }>>`
    SELECT chain_id, turn_idx, trigger, started_at
    FROM harness_shared.operator_continue_chains
    WHERE conversation_id = ${input.conversationId}
      AND ui_client_id = ${input.uiClientId}
      AND started_at > now() - (${CHAIN_LOOKBACK_SECS} || ' seconds')::interval
    ORDER BY started_at DESC, turn_idx DESC
    LIMIT 1
  `;

  const head = recent[0];
  const chainStillActive = head !== undefined && head.trigger !== 'reset';
  const workspaceId = activeWorkspaceId();

  if (input.trigger === 'reset') {
    // Only write a 'reset' row if there IS an active chain to reset.
    // Unprompted resets (no active chain) are no-ops to keep the ledger lean.
    if (!chainStillActive) return;
    const elapsed = secondsBetween(head.started_at, new Date());
    await sql`
      INSERT INTO harness_shared.operator_continue_chains
        (conversation_id, ui_client_id, chain_id, turn_idx,
         trigger, started_at, elapsed_secs_in_chain, was_capped, cap_reason, workspace_id)
      VALUES
        (${input.conversationId}, ${input.uiClientId}, ${head.chain_id},
         ${head.turn_idx + 1}, 'reset', now(), ${elapsed}, false, NULL, ${workspaceId})
    `;
    return;
  }

  // continue / auto_fire_terminal — extend or start a chain.
  if (chainStillActive) {
    const elapsed = secondsBetween(head.started_at, new Date());
    await sql`
      INSERT INTO harness_shared.operator_continue_chains
        (conversation_id, ui_client_id, chain_id, turn_idx,
         trigger, started_at, elapsed_secs_in_chain, was_capped, cap_reason, workspace_id)
      VALUES
        (${input.conversationId}, ${input.uiClientId}, ${head.chain_id},
         ${head.turn_idx + 1}, ${input.trigger}, now(), ${elapsed}, false, NULL, ${workspaceId})
    `;
    return;
  }

  // Fresh chain.
  await sql`
    INSERT INTO harness_shared.operator_continue_chains
      (conversation_id, ui_client_id, chain_id, turn_idx,
       trigger, started_at, elapsed_secs_in_chain, was_capped, cap_reason, workspace_id)
    VALUES
      (${input.conversationId}, ${input.uiClientId}, ${randomUUID()},
       0, ${input.trigger}, now(), 0, false, NULL, ${workspaceId})
  `;
}

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 1000);
}
