/**
 * roles:firing_on — list role manifests that subscribe to a hook event.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { rolesFiringOn } from '../../role-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'roles:firing_on',
  profile: 'engineer',
  guidance: {
    when: 'You need to know which roles are configured to fire on a given hook event before firing it (avoids no-op fires).',
    notWhen: 'For the hook-event ENUM itself, use `hooks:known`. For role details, use `roles:get`.',
    seeAlso: [
      'hooks:known (the hook-event enum itself)',
      'roles:get (a role\'s full definition)',
    ],
  },
  description: 'Return role manifests whose `firesOn` array includes the given hook event.',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: z.string().min(1),
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    // Empty slug = the GLOBAL role registry (documented). Normalize the operator
    // `'*'` auto-default / explicit `all` to that global scope — never a literal
    // `'*'` slug. allow-scope-default: intended global registry, not a leak.
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx) ?? '';
    const roles = rolesFiringOn(args.event, slug);
    return {
      data: { event: args.event, harnessSlug: slug || null, roles },
    };
  },
});
