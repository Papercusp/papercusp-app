/**
 * access:revoke — permanently revoke one outside app's key (P-012, WI-10004025). Local-only.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { accessWorkspaceId, defaultAccessToolDeps } from './_shared';
import { accessRevoke, defaultAccessHandlerDeps } from './handlers';

export default defineTool({
  name: 'access:revoke',
  profile: 'engineer',
  description:
    'Revoke an app or service key permanently: every secret it ever had, including one still inside a rotation overlap, is refused from then on. Cannot be undone; the app needs a new key. Local-only: refused for app-key callers and tunnelled requests.',
  capability: 'operator:write',
  guidance: {
    when: 'The user wants an outside app cut off for good, or a key may have leaked.',
    notWhen: 'For a temporary stop use access:pause, which can be resumed.',
    chaining: 'access:list → access:revoke { id } → access:list { includeRevoked: true } to confirm.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    id: z.string().min(1).describe('Key id from access:list.'),
    workspaceId: z.string().min(1).optional().describe('Workspace the key belongs to. Defaults to the current workspace.'),
  }),
  async handler(args, ctx) {
    const deps = await defaultAccessHandlerDeps(await defaultAccessToolDeps());
    return accessRevoke({ workspaceId: await accessWorkspaceId(args.workspaceId, ctx), id: args.id }, ctx, deps);
  },
});
