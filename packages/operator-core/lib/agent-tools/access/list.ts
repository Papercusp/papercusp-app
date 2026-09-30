/**
 * access:list — the keys outside apps use to reach a workspace (P-012, WI-10004025).
 * Local-only; see ./_shared.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { accessWorkspaceId, defaultAccessToolDeps } from './_shared';
import { accessList, defaultAccessHandlerDeps } from './handlers';

export default defineTool({
  name: 'access:list',
  profile: 'engineer',
  description:
    "List the app and service keys that let outside apps call this workspace: label, kind, creator, scopes, status (active/paused/revoked/expired), last use and spending cap. Never shows a key's secret. Local-only: refused for app-key callers and tunnelled requests.",
  capability: 'operator:read',
  guidance: {
    when: 'The user asks which outside apps can reach this workspace, or you need a key id before pausing or revoking it.',
    notWhen: 'To see what an app DID, read its activity instead; this lists keys, not calls.',
    chaining: 'access:list → access:pause / access:revoke { id }.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    workspaceId: z.string().min(1).optional().describe('Workspace whose keys to list. Defaults to the current workspace.'),
    includeRevoked: z.boolean().optional().describe('Include revoked keys (default false).'),
  }),
  async handler(args, ctx) {
    const deps = await defaultAccessHandlerDeps(await defaultAccessToolDeps());
    return accessList({ ...args, workspaceId: await accessWorkspaceId(args.workspaceId, ctx) }, ctx, deps);
  },
});
