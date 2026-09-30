/**
 * Shared caller fence for every write-side `goals:*` tool.
 *
 * Tool handlers differ in where they resolve workspace/transactions, but they
 * must not differ in who may mutate goal state. This seam derives the same
 * transport identity coordination uses, preserves the legacy direct ownerId
 * shape, and delegates the actual election verdict to goal-context's canonical
 * fail-closed authority reader.
 */
import type { Sql } from 'postgres';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../agent-tools/coordination/identity';
import { assertGoalHolderMutationAuthority } from '../modes/goal-context';
import type { GoalHolderAuthority } from './holder-authority';

export type GoalWriteAuthorityCtx = ResolveIdentityCtx & { ownerId?: string | null };

export async function assertGoalWriteAuthorityForCaller(
  ctx: GoalWriteAuthorityCtx,
  workspaceId: string,
  sql: Sql,
): Promise<GoalHolderAuthority | null> {
  let ownerId: string | null = null;
  try {
    ownerId = resolveAgentIdentity(ctx).ownerId;
  } catch {
    ownerId = ctx.ownerId?.trim() || null;
  }
  // Truly unattributable legacy/system embeddings cannot correspond to a
  // superseded durable holder row. Every admitted agent transport is resolved.
  if (!ownerId) return null;
  return await assertGoalHolderMutationAuthority(workspaceId, ownerId, sql);
}
