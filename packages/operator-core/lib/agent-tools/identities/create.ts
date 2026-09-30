import { z } from 'zod';
import { stringify } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { inspectIdentitySource } from '../../agent-identities/source';
import { COORD_ROLES } from '../coordination/roles';
import { identityId, identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:create',
  description: 'Author an identity as a blueprint source with its own slots declaration. Returns validated canonical YAML to persist in the existing blueprint directory; creates no file, table, session or listing.',
  guidance: {
    when: 'Authoring a new identity module, including an abstract module without a runnable workItem/spine.',
    notWhen: 'Authoring a plain executable blueprint — blueprint:create/extend. Attaching a live session is a separate operation.',
    chaining: 'Persist valid YAML at <repo>/.papercusp/blueprints/<id>/blueprint.yaml; use identities:get/validate, then the existing blueprint:publish path when sharing.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ identity: z.record(z.string(), z.unknown()).describe('Authored blueprint source; must declare id and slots.'), repoDir }),
  async handler(args) {
    const id = identityId.safeParse(args.identity.id);
    if (!id.success) return identityText({ ok: false, error: 'invalid-identity-id', message: id.error.message });
    const result = inspectIdentitySource(args.identity, { repoDir: args.repoDir });
    return identityText({ ...result, ...(result.ok ? { yaml: stringify(args.identity, { lineWidth: 100 }) } : {}) });
  },
});
