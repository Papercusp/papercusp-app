/**
 * fleet/parent-wake — when a spawn reaches terminal status and has parent_spawn_id,
 * fire the parent's inbox-wake key with a death notice.
 * (EI-108: wake-on-bee-death for Queen oversight)
 *
 * This closes the liveness hole: every Queen placement now re-wakes with verdict
 * (the child's completion message) OR a death certificate (the child died, parent
 * was waiting, now parent knows).
 */

import type { Sql } from 'postgres';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

interface SpawnRecord {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  session_owner: string | null;
  status: string;
  error_message: string | null;
  output_tail: string | null;
  exit_code: number | null;
}

export interface ParentWakeResult {
  parentWoken: boolean;
  parentSpawnId?: string;
  parentOwnerId?: string;
}

/**
 * Fire the parent's inbox-wake key when a spawn reaches terminal status.
 * If the spawn has no parent, returns parentWoken=false silently.
 * Best-effort: errors (DB/inbox/wake) are logged but don't throw.
 */
export async function wakeParentOnChildDeath(
  sql: Sql,
  spawnId: string,
  workspaceId: string,
  childStatus: string,
): Promise<ParentWakeResult> {
  try {
    // Fetch the spawn and its parent (if any)
    const rows = await sql<SpawnRecord[]>`
      SELECT spawn_id, parent_spawn_id, workspace_id, session_owner, status,
             error_message, output_tail, exit_code
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${spawnId} AND workspace_id = ${workspaceId}`;

    if (rows.length === 0) {
      return { parentWoken: false };
    }

    const spawn = rows[0];
    if (!spawn.parent_spawn_id) {
      return { parentWoken: false };
    }

    // The parent's coord owner id IS `parent_spawn_id` — wake it DIRECTLY.
    //
    // Do NOT look the parent up in spawned_agents to read its session_owner:
    // a fleet-spawned parent sets `sessionOwner = spawnId` (so the lookup was a
    // no-op identity), but a HIVE/Queen parent (launched via the invoke route
    // with bpkind=hive) has NO spawned_agents row at all — it lives in
    // adv_sessions, keyed by coord_owner_id == this `parent_spawn_id`. The old
    // lookup therefore found 0 rows and silently dropped the wake for EVERY
    // Queen placement (Stage-B finding, 2026-06-07: a reclaimed bee left the
    // Queen asleep forever). `parent_spawn_id` is the coord owner in both cases,
    // and wakeRecipients keys on the owner's inbox-wake — so fire it straight.
    const parentOwnerId = spawn.parent_spawn_id;

    const deathNotice = `Child spawn ${spawnId} reached terminal status: ${childStatus}`;
    const payload = {
      childSpawnId: spawnId,
      status: childStatus,
      errorMessage: spawn.error_message,
      outputTail: spawn.output_tail,
      exitCode: spawn.exit_code,
    };

    const result = await wakeRecipients([parentOwnerId], {
      summary: deathNotice,
      payload,
      source: 'spawn-finish',
      workspaceId,
    });

    return {
      parentWoken: result.woken > 0,
      parentSpawnId: spawn.parent_spawn_id,
      parentOwnerId,
    };
  } catch (err) {
    // Best-effort: log but don't throw. The spawn's terminal status is already
    // durable; a wake fan error downgrades to "parent sees the message on their
    // next natural turn" instead of immediate re-invoke.
    console.warn(
      `[parent-wake] failed to wake parent of spawn ${spawnId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { parentWoken: false };
  }
}
