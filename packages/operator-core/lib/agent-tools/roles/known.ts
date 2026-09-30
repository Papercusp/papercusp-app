/**
 * roles:known — return the static well-known role-id allowlist.
 *
 * The list is the kernel set of role ids the orchestrator + scoper +
 * UI use as defaults; plugin-registered roles append on top of this.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getKnownRoles } from '../../known-roles';
import { roleConsumes } from '../../role-registry';

export default defineTool({
  name: 'roles:known',
  profile: 'engineer',
  guidance: {
    when: 'Static enum of role names the runtime supports — use to validate a role string before passing it elsewhere.',
    notWhen: 'For the workspace\'s ACTUAL roles (may be a subset), use `roles:list`. known is the universe; list is what\'s configured.',
    seeAlso: [
      'roles:list (the workspace\'s actual configured roles)',
      'roles:get (one role\'s definition)',
    ],
  },
  description: 'Static well-known role-id allowlist (kernel set; plugin-registered roles extend this).',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    // Enrich each known role id with its launch-context needs so the psu
    // role picker (and any UI) gets role+consumes in one call.
    const roles = getKnownRoles();
    const consumes = Object.fromEntries(roles.map((id) => [id, roleConsumes(id)]));
    return { data: { roles, consumes } };
  },
});
