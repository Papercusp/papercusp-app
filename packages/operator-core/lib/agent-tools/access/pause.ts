/**
 * access:pause — pause or resume one outside app's key (P-012, WI-10004025). Local-only.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { accessWorkspaceId, defaultAccessToolDeps } from './_shared';
import { accessSetPaused, defaultAccessHandlerDeps } from './handlers';

export default defineTool({
  name: 'access:pause',
  profile: 'engineer',
  description:
    "Pause an app or service key so every call with it is refused until resumed (paused:false resumes). Reversible; the key's scopes and secret are kept. Local-only: refused for app-key callers and tunnelled requests.",
  capability: 'operator:write',
  guidance: {
    when: 'The user wants to stop an outside app temporarily, e.g. while investigating unexpected activity.',
    notWhen: 'To cut an app off for good use access:revoke. To pause every app at once use the Remote access kill switch.',
    chaining: 'access:list → access:pause { id } → later access:pause { id, paused: false }.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    id: z.string().min(1).describe('Key id from access:list.'),
    paused: z.boolean().optional().describe('true (default) pauses; false resumes.'),
    workspaceId: z.string().min(1).optional().describe('Workspace the key belongs to. Defaults to the current workspace.'),
  }),
  async handler(args, ctx) {
    const deps = await defaultAccessHandlerDeps(await defaultAccessToolDeps());
    const workspaceId = await accessWorkspaceId(args.workspaceId, ctx);
    return accessSetPaused({ workspaceId, id: args.id, paused: args.paused ?? true }, ctx, deps);
  },
});
