/**
 * capability:revoke_role — remove runtime-granted capabilities from a role
 * (live-configurability-audit P-008; the inverse of capability:grant_role).
 *
 * Only removes caps from the runtime GRANT store (role_capability_grants) — it cannot touch the
 * code-level BLUEPRINT_ROLE_CAPS or a provisioned system_principals row (those are not runtime
 * surfaces). Revoking only REDUCES privilege, so it needs no floor/envelope checks; still
 * operator-authority + flag-gated + audited/revertible (a wrong revoke is one call back).
 */
import { z } from 'zod';
import { defineTool, entityRef, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readGrants, revokeCaps, writeGrants } from '../../role-capability-grants';

export default defineTool({
  name: 'capability:revoke_role',
  profile: 'engineer',
  description:
    'Remove runtime-granted capabilities from a role (the inverse of capability:grant_role). Only affects the runtime grant store, never code-level role caps. Operator-authority, audited + one-call-revertible. Dark until papercusp-capability-grant-tool is enabled.',
  capability: 'operator:write',
  guidance: {
    when: 'Walk back a runtime capability grant — confine a role after a grant proves too broad, or clean up grants. Reducing privilege, so always safe.',
    notWhen: 'To GRANT a cap, use capability:grant_role. To wipe ALL runtime grants at once (incident), use config:reset-overrides on the role-capability-grants concern.',
    chaining: 'config:list-overrides shows the active grants before/after.',
    seeAlso: [
      'capability:grant_role (grant a role capability)',
      'config:reset-overrides (wipe ALL runtime grants at once)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    role: entityRef('role', { max: 80, describe: 'The role to revoke capabilities from.' }),
    capabilities: z.array(z.string().min(1).max(120)).min(1).describe('Capability strings to remove.'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const ws = activeWorkspaceId();
    if (!(await getFlag(FLAGS.CAPABILITY_GRANT_TOOL, ws))) {
      throw new Error('capability:revoke_role is dark — enable papercusp-capability-grant-tool to use it.');
    }
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability:revoke_role requires operator, architect, or mug role');
    }
    const caps = [...new Set(args.capabilities)];

    const outcome = await runControlMutation<string[]>(
      {
        action: 'capability:revoke_role',
        subject: `role:${args.role}`,
        actor: `role:${ctx.role}`,
        capturePrev: () => readGrants(args.role),
        apply: () => revokeCaps(args.role, caps),
        revertTo: (prev) => writeGrants(args.role, prev).then(() => {}),
        verify: async (next) => {
          const ok = caps.every((c) => !next.includes(c));
          return { ok, detail: ok ? undefined : 'grant set still contains revoked capabilities' };
        },
        describe: (prev) => ({ role: args.role, current: prev, removing: caps }),
      },
      { dryRun: args.dryRun },
    );

    return {
      data: {
        ok: true,
        role: args.role,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
        grants: outcome.next ?? outcome.prev,
      },
    };
  },
});
