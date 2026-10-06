/**
 * trust:list — show the owner's LOCAL trusted-GitHub-user list
 * (shared-hive-trust-admission-2026-06-14 / P-009). Read-only counterpart of
 * trust:add / trust:remove.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'trust:list',
  profile: 'engineer',
  // Reads the workspace-scoped trust list via the admin handle, scoping by the
  // resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "List the owner's trusted GitHub user ids — the LOCAL, owner-scoped trust list the admission gate consults so a VERIFIED trusted author's remote (federated) work may auto-run without per-item screening.",
  capability: 'intel:read',
  guidance: {
    when: "Show who the owner trusts to auto-run foreign/federated work — the owner-scoped, local-only trust list (shared-hive-trust-admission).",
    notWhen: 'To grant or revoke trust use trust:add / trust:remove. This is read-only.',
    chaining: 'trust:list → trust:add { githubUserId } / trust:remove { githubUserId }.',
    seeAlso: [
      'trust:add (grant trust)',
      'trust:remove (revoke trust)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { listTrustedUsers } = await import('../../trust/user-trust-list');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const trusted = await listTrustedUsers(ws);
    return {
      data: { ok: true, workspaceId: ws, count: trusted.length, trusted },
    };
  },
});
