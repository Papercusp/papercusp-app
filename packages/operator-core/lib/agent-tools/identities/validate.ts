import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getIdentitySource, identityFailure, inspectIdentitySource } from '../../agent-identities/source';
import { parseBlueprintSource } from '../blueprint/_resolve';
import { COORD_ROLES } from '../coordination/roles';
import { identityId, identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:validate',
  description: 'Validate an identity by id or inline YAML/JSON using the blueprint source schema, inheritance and structural checks. Abstract modules are valid sources without becoming executable blueprints. Returns issues instead of throwing.',
  guidance: { when: 'Checking identity source, slots, bundle conflicts, attestations and mode authority before persisting or composing.', notWhen: 'Certifying publisher signatures or runtime grants; publication, conformance and authorization remain separate.' },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: identityId.optional(), source: z.string().min(1).max(128000).optional(), repoDir })
    .refine(args => (args.id != null) !== (args.source != null), { message: 'pass exactly one of id or source' }),
  async handler(args) {
    if (args.id) return identityText(await getIdentitySource(args.id, { repoDir: args.repoDir }));
    try {
      return identityText(inspectIdentitySource(parseBlueprintSource(args.source!), { repoDir: args.repoDir }));
    } catch (error) {
      return identityText(identityFailure(error));
    }
  },
});
