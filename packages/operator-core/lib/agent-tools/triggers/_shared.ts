import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

export function triggerToolContext(ctx: UnifiedToolContext): {
  sql: ReturnType<typeof getOrgPg>['sql'];
  workspaceId: string;
  actorId: string;
} {
  const workspaceId = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
  return {
    sql: getOrgPg().sql,
    workspaceId,
    actorId: resolveAgentIdentity(ctx).ownerId,
  };
}

export async function invalidateTriggers(workspaceId: string): Promise<void> {
  const { notifySyncInvalidate } = await import('../../sync-sse');
  await notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
}

export function data(value: unknown): { data: unknown } {
  return { data: value };
}
