/**
 * access:create — mint a key an outside app uses to call this workspace (P-012, WI-10004025).
 * Local-only; the secret goes to a private file, not the transcript. See ./handlers.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { accessWorkspaceId, defaultAccessToolDeps } from './_shared';
import { accessCreate, defaultAccessHandlerDeps } from './handlers';

export default defineTool({
  name: 'access:create',
  profile: 'engineer',
  description:
    'Create an app key (or a service key for an unattended app, which needs a spending cap) scoped to named tools. The secret is written once to a private file whose path is returned, never into the chat. Local-only: refused for app-key callers and tunnelled requests.',
  capability: 'operator:write',
  guidance: {
    when: 'The user asks to let an outside app, script or MCP client call this workspace, and has said what it may do.',
    notWhen: 'Scopes unclear: ask which tools the app needs. Default-deny: a key with no tools can call nothing. Shell, file, admin and credential tools are never grantable.',
    chaining: 'access:create { label, tools, kind? , spendCapCents? } → give the user secretFile → access:list to confirm.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    label: z.string().min(1).max(120).describe('Name the user will recognise, e.g. "Zapier" or "nightly report script".'),
    kind: z.enum(['app', 'service']).optional().describe("'app' (default) or 'service' for an unattended app; a service key requires spendCapCents."),
    tools: z.array(z.string().min(1)).optional().describe('Exact group:verb names or group:* the key may call. Omitted = nothing.'),
    capabilities: z.array(z.string().min(1)).optional().describe('Capability grants (e.g. operator:read). Hard-denied namespaces are refused.'),
    harnesses: z.array(z.string().min(1)).optional().describe('The only harnesses a call may name. Omitted = any in the workspace.'),
    expiresAt: z.string().optional().describe('ISO-8601 expiry. Omitted = no expiry.'),
    spendCapCents: z.number().int().nonnegative().nullable().optional().describe('LLM spending ceiling in US cents. Required for a service key.'),
    spendCapWindowSec: z.number().int().positive().nullable().optional().describe('Trailing window for the cap in seconds. Omitted = 30 days; null = lifetime.'),
    workspaceId: z.string().min(1).optional().describe('Workspace the key reaches. Defaults to the current workspace.'),
    revealSecret: z.boolean().optional().describe('Return the secret inline instead of in a file. Only when the user explicitly asks.'),
  }),
  async handler(args, ctx) {
    const deps = await defaultAccessHandlerDeps(await defaultAccessToolDeps());
    return accessCreate({ ...args, workspaceId: await accessWorkspaceId(args.workspaceId, ctx) }, ctx, deps);
  },
});
