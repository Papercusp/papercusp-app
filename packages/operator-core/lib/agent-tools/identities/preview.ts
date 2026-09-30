/** identities:preview — what a wearer of an identity would receive (P-015, D-033). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parseBlueprintSource } from '../blueprint/_resolve';
import { COORD_ROLES } from '../coordination/roles';
import { identityFailure } from '../../agent-identities/source';
import { identityId, identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:preview',
  description: 'Preview an identity in a pot as its wearer would receive it: each injection point rendered by the runtime sink evaluators from sample provider output (budgets, omissions, fences), timing, declared grants/rules/visibility, consent subjects, and, with ownerId, what a detach or upgrade would cancel or keep. Read-only.',
  guidance: {
    when: 'Authoring an identity: checking what each sink renders against sample state before installing or attaching it.',
    notWhen: 'Schema and structural checks only (identities:validate); attaching or installing (identities:create, cupboard install).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: identityId.optional(),
    source: z.string().min(1).max(128000).optional(),
    potSlug: z.string().min(1).max(120).optional().describe('Pot to resolve providers and grants in; defaults to the caller\'s harness.'),
    samples: z.record(z.string(), z.string().max(65536)).optional()
      .describe('Raw provider output (serialized JSON) per contribution id or rule id.'),
    tools: z.array(z.string().min(1)).max(50).optional().describe('Tool names of a post-tool batch, for rule tool filters.'),
    pendingCall: z.object({ tool: z.string().min(1), input: z.unknown() }).optional()
      .describe('A pending call to run the pre-tool guards against.'),
    ownerId: z.string().min(1).max(200).optional().describe('A session wearing this identity: adds the lifecycle section.'),
    repoDir,
  }).refine(args => (args.id != null) !== (args.source != null), { message: 'pass exactly one of id or source' }),
  async handler(args, ctx) {
    const workspaceId = ctx?.workspaceId;
    const potSlug = args.potSlug ?? ctx?.harnessSlug;
    if (!workspaceId || !potSlug) return identityText({ ok: false, error: 'a workspace and potSlug (or harness scope) are required' });
    try {
      const { previewIdentity } = await import('../../agent-identities/identity-preview');
      return identityText(await previewIdentity({
        workspaceId, potSlug,
        ...(args.id ? { identityId: args.id } : { source: parseBlueprintSource(args.source!) }),
        ...(args.repoDir ? { repoDir: args.repoDir } : {}),
        ...(args.samples ? { samples: args.samples } : {}),
        ...(args.tools ? { tools: args.tools } : {}),
        ...(args.pendingCall ? { pendingCall: { tool: args.pendingCall.tool, input: args.pendingCall.input } } : {}),
        ...(args.ownerId ? { ownerId: args.ownerId } : {}),
      }));
    } catch (error) {
      return identityText(identityFailure(error));
    }
  },
});
