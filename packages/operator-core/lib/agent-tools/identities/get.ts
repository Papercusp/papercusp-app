import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getIdentitySource } from '../../agent-identities/source';
import { COORD_ROLES } from '../coordination/roles';
import { identityId, identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:get',
  description: 'Read an identity source by blueprint id, with its authored fields, source-document hash, layers and validation. Local sources precede installed and built-in sources; inherited slots never reclassify a plain blueprint.',
  guidance: { when: 'Inspecting one identity source before composing or changing it.', notWhen: 'Reading a session activation or applied specification; these are separate contracts.' },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: identityId, repoDir }),
  async handler(args) {
    return identityText(await getIdentitySource(args.id, { repoDir: args.repoDir }));
  },
});
