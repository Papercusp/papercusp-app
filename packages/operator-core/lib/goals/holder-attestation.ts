/**
 * First-turn GOAL holder proof, derived from existing durable records. A live
 * process is only a holder candidate: the elected GOAL mode, an active loop with
 * a checkpoint in that mode window, and a successful goal-scoped portfolio act
 * together show that it actually began the assigned stewardship.
 */
import type { Sql } from 'postgres';
import { getLoopStatus, type LoopStatus } from '../harness/routines/loop';
import { getLoopCarryNoteWithMeta, type LoopCarryNoteWithMeta } from '../carry-note';
import type { GoalHolderRow } from './holder';
import { portfolioActLedgerPredicate } from './portfolio-throughput';

export type GoalHolderAttestationLeg = 'goal-declaration' | 'loop' | 'checkpoint' | 'portfolio-act';

export interface GoalHolderFirstTurnAttestation {
  status: 'complete' | 'partial' | 'unknown';
  workspaceId: string;
  goalId: string;
  ownerId: string | null;
  modeSetAt: string | null;
  loopActive: boolean | null;
  checkpointAt: string | null;
  portfolioAct: { tool: string; at: string } | null;
  missing: GoalHolderAttestationLeg[];
  unavailable: GoalHolderAttestationLeg[];
}

export interface GoalHolderAttestationDeps {
  readLoop: (ownerId: string, sql: Sql) => Promise<LoopStatus | null>;
  readCheckpoint: (harness: string, ownerId: string) => Promise<LoopCarryNoteWithMeta>;
  readAct: (sql: Sql, workspaceId: string, goalId: string, ownerId: string, sinceMs: number) => Promise<{
    tool: string;
    at: string;
  } | null>;
}

export async function readGoalHolderPortfolioAct(
  sql: Sql, workspaceId: string, goalId: string, ownerId: string, sinceMs: number,
): Promise<{ tool: string; at: string } | null> {
  const rows = await sql<{ tool_name: string; invoked_at: Date | string }[]>`
      SELECT ti.tool_name, ti.invoked_at
        FROM harness_shared.tool_invocations ti
       WHERE ti.workspace_id = ${workspaceId}
         AND ti.goal_id = ${goalId}
         AND ti.goal_actor_class = 'holder-agent'
         AND ti.coord_owner_id = ${ownerId}
         AND ti.invoked_at >= to_timestamp(${sinceMs}::bigint / 1000.0)
         AND ti.status = 'ok'
         AND ${portfolioActLedgerPredicate(sql)}
       ORDER BY ti.invoked_at DESC
       LIMIT 1
    `;
  const row = rows[0];
  return row ? { tool: row.tool_name, at: new Date(row.invoked_at).toISOString() } : null;
}

const DEFAULT_DEPS: GoalHolderAttestationDeps = {
  readLoop: async (ownerId, sql) => await getLoopStatus(ownerId, { sql }),
  readCheckpoint: async (harness, ownerId) => await getLoopCarryNoteWithMeta({ harness, ownerId }),
  readAct: readGoalHolderPortfolioAct,
};

/** An unreadable leg is never converted into evidence that the holder failed. */
export async function readGoalHolderFirstTurnAttestation(
  sql: Sql,
  args: { workspaceId: string; goalId: string; holder: GoalHolderRow | null },
  deps: GoalHolderAttestationDeps = DEFAULT_DEPS,
): Promise<GoalHolderFirstTurnAttestation> {
  const { workspaceId, goalId, holder } = args;
  const modeSetAt = holder && Number.isFinite(holder.setAtMs)
    ? new Date(holder.setAtMs).toISOString()
    : null;
  const out: GoalHolderFirstTurnAttestation = {
    status: 'partial', workspaceId, goalId, ownerId: holder?.ownerId ?? null,
    modeSetAt, loopActive: null, checkpointAt: null, portfolioAct: null,
    missing: [], unavailable: [],
  };
  if (!holder || holder.workspaceId !== workspaceId || holder.goalId !== goalId || !modeSetAt) {
    out.missing.push('goal-declaration');
    return out;
  }

  let loop: LoopStatus | null = null;
  try {
    loop = await deps.readLoop(holder.ownerId, sql);
    if (loop && loop.ownerId !== holder.ownerId) {
      out.unavailable.push('loop');
      loop = null;
    } else {
      out.loopActive = loop?.active ?? false;
    }
    if (!loop?.active) out.missing.push('loop');
  } catch {
    out.unavailable.push('loop');
  }

  if (loop?.active && loop.harnessSlug) {
    try {
      const note = await deps.readCheckpoint(loop.harnessSlug, holder.ownerId);
      if (note.readFailed || (note.note && !Number.isFinite(note.updatedAtMs))) {
        out.unavailable.push('checkpoint');
      } else if (!note.note || note.updatedAtMs! < holder.setAtMs) {
        out.missing.push('checkpoint');
      } else {
        out.checkpointAt = new Date(note.updatedAtMs!).toISOString();
      }
    } catch {
      out.unavailable.push('checkpoint');
    }
  } else if (out.loopActive === false) {
    out.missing.push('checkpoint');
  } else {
    out.unavailable.push('checkpoint');
  }

  try {
    out.portfolioAct = await deps.readAct(sql, workspaceId, goalId, holder.ownerId, holder.setAtMs);
    if (!out.portfolioAct) out.missing.push('portfolio-act');
  } catch {
    out.unavailable.push('portfolio-act');
  }

  out.status = out.unavailable.length > 0 ? 'unknown' : out.missing.length > 0 ? 'partial' : 'complete';
  return out;
}
