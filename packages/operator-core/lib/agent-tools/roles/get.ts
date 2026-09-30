/**
 * roles:get — fetch one role manifest by id.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getRole, roleConsumes } from '../../role-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'roles:get',
  profile: 'engineer',
  guidance: {
    when: 'User names a specific role and wants its full definition (system prompt, allowed tools, quotas).',
    notWhen: 'For the role list, use `roles:list`. For the known-role enum (static), use `roles:known`.',
    seeAlso: [
      'roles:list (the configured role list)',
      'roles:known (the static known-role enum)',
    ],
  },
  description: 'Fetch one role manifest by id, scoped to a harness slug (or global when slug omitted).',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    id: z.string().min(1),
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    // Empty slug = the GLOBAL role registry (documented: "global when slug omitted").
    // Normalize the operator `'*'` auto-default / explicit `all` to that global scope
    // — never a literal `'*'` slug. allow-scope-default: intended global registry.
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx) ?? '';
    const role = getRole(args.id, slug);
    // `consumes` is resolved for ANY role id (kernel roles aren't
    // manifests but still have launch-context needs) so callers — esp.
    // the psu role picker — get it uniformly.
    const consumes = roleConsumes(args.id, slug);
    return {
      data: { id: args.id, harnessSlug: slug || null, found: role !== null, role, consumes },
    };
  },
});
