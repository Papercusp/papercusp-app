import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getIdentitySource, identityFailure, inspectIdentitySource } from '../../agent-identities/source';
import { parseBlueprintSource } from '../blueprint/_resolve';
import { COORD_ROLES } from '../coordination/roles';
import { identityId, identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:validate',
  description: 'Validate an identity by id or inline YAML/JSON using the blueprint source schema, inheritance and structural checks. Abstract modules are valid sources without becoming executable blueprints. In a pot, also compiles it there (`package`: compile and grant issues, declared surface). Returns issues instead of throwing.',
  guidance: { when: 'Checking identity source, slots, bundle conflicts, attestations and mode authority before persisting or composing.', notWhen: 'Certifying publisher signatures or runtime grants; publication, conformance and authorization remain separate. What a wearer receives: identities:preview.' },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: identityId.optional(), source: z.string().min(1).max(128000).optional(), repoDir })
    .refine(args => (args.id != null) !== (args.source != null), { message: 'pass exactly one of id or source' }),
  async handler(args, ctx) {
    let inspection;
    let source: Record<string, unknown> | undefined;
    if (args.id) {
      inspection = await getIdentitySource(args.id, { repoDir: args.repoDir });
    } else {
      try {
        source = parseBlueprintSource(args.source!);
        inspection = inspectIdentitySource(source, { repoDir: args.repoDir });
      } catch (error) {
        return identityText(identityFailure(error));
      }
    }
    // P-015 (D-033): the pot compile runs only for an accepted, runnable source;
    // an abstract module is valid without being compilable on its own.
    if (!inspection.ok || !('runnable' in inspection) || !inspection.runnable) return identityText(inspection);
    const { identityPackageValidation } = await import('../../agent-identities/identity-preview');
    const pkg = await identityPackageValidation({
      workspaceId: ctx?.workspaceId, potSlug: ctx?.harnessSlug,
      ...(args.id ? { identityId: args.id } : { source }), ...(args.repoDir ? { repoDir: args.repoDir } : {}),
    });
    return identityText(pkg ? { ...inspection, ok: inspection.ok && pkg.ok, package: pkg } : inspection);
  },
});
