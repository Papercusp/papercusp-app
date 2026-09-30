/**
 * saved_prompts:list — read the cross-client saved prompts for one scope
 * (workspace-global, or a single harness).
 *
 * The on-disk `/name` command files (Claude / Codex / OMP) are a projection
 * of these PG rows (D-001); this is the canonical read so superuser / agents
 * can inspect what prompts exist without an HTTP call. Added per D-007's
 * standing offer — mutation deliberately stays off the agent catalog and on
 * the dashboard route-shaped endpoint (POST /api/agent-mcp/saved-prompts[/remove]).
 * Read-only.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { listSavedPrompts, type PromptScope } from '../../saved-prompts-store';

export default defineTool({
  name: 'saved_prompts:list',
  profile: 'engineer',
  description:
    'List cross-client saved prompts for a scope: omit harness_slug for workspace-global prompts, or pass a harness slug for that harness. Returns the canonical PG rows (name, body, description, arg_hint) that materialize to the /name slash-commands in Claude / Codex / OMP.',
  capability: 'intel:read',
  guidance: {
    when:
      'When you need to inspect which saved `/name` prompts exist for a workspace or harness (e.g. to answer "what prompts are defined?" or before suggesting one).',
    notWhen:
      'To create/edit/delete a prompt — that is the dashboard settings UI (POST /api/agent-mcp/saved-prompts). This tool is read-only.',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'cup'],
  args: z.object({
    harness_slug: z
      .string()
      .optional()
      .describe('Harness slug for harness-scoped prompts; omit for workspace-global prompts.'),
  }),
  async handler(args, ctx) {
    const scope: PromptScope = args.harness_slug
      ? { kind: 'harness', slug: args.harness_slug }
      : { kind: 'workspace' };
    // Mirror the GET route: explicit workspace_id filter on the org Sql
    // (the store scopes by workspace_id; the intel:read gate still applies).
    // Prefer the principal's workspace when present, else the active one.
    const ws = ctx.principal?.workspaceId ?? activeWorkspaceId();
    const prompts = await listSavedPrompts(getOrgPg().sql, ws, scope);
    return { data: { ok: true, scope, prompts } };
  },
});
