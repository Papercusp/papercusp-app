import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listIdentitySources } from '../../agent-identities/source';
import { COORD_ROLES } from '../coordination/roles';
import { identityText, repoDir } from './_shared';

export default defineTool({
  name: 'identities:list',
  description: 'List authored identities from the existing blueprint file catalog. Pages scan at most limit source documents; follow nextAfter even when the identity page is empty. Broken sources appear in unreadable; use identities:get for composition validation.',
  guidance: { when: 'Choosing identity modules to compose or inspect.', notWhen: 'Browsing marketplace listings or enumerating live sessions.' },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ repoDir, after: z.string().max(120).optional(), limit: z.number().int().min(1).max(100).default(30) }),
  async handler(args) {
    return identityText(await listIdentitySources(args));
  },
});
