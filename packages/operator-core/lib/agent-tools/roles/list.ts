/**
 * roles:list — list role manifests for a harness (or globally if no slug).
 *
 * Wraps `listRoles()` from apps/operator/lib/role-registry.ts. Useful
 * for agents introspecting which roles they can spawn into.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listRoles } from '../../role-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'roles:list',
  profile: 'engineer',
  guidance: {
    when: 'You need the set of agent roles configured in the workspace (architect, worker, validator, …) before spawning or dispatching.',
    notWhen: 'For agents currently RUNNING, use `agents:list`. roles:list is the static configuration; agents:list is the live processes.',
    chaining: 'Pair with `roles:get` for one role\'s definition.',
    seeAlso: [
      'roles:get (one role\'s definition)',
      'roles:known (the static role enum)',
      'agents:list (roles currently RUNNING)',
    ],
  },
  description: 'List role manifests (id, source, fires-on, etc.) for a harness, or globally when no harness given.',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    // Empty slug = the GLOBAL role registry (documented: "globally when no harness
    // given"). Route through the resolver only to normalize the operator `'*'`
    // auto-default / explicit `all` to that global scope — never a literal `'*'` slug.
    // allow-scope-default: empty == the intended global role registry, not a leak.
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx) ?? '';
    const roles = listRoles(slug);
    return { data: { harnessSlug: slug || null, roles } };
  },
});
