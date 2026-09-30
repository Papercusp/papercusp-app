/**
 * capability:grant_role — runtime-grant capabilities to a role (live-configurability-audit P-008).
 *
 * The role→capability map is otherwise a code literal (BLUEPRINT_ROLE_CAPS, the recurring
 * `owner-fix` redeploy trap) + provisioned system_principals. This grants caps at runtime, unioned
 * into loadRoleCapabilities (flag-gated). It is a PRIVILEGE-ESCALATION surface, so D-007 applies and
 * is enforced HERE, on the tool, not merely inherited:
 *   (a) cannot grant the protected floor (secrets:*, processes:kill);
 *   (b) cannot grant a capability the GRANTER does not itself hold (no self-escalation);
 *   (c) owner-authority — operator/architect/queen only, and the autonomy category is
 *       system-control (PROTECTED / never-auto), so it never auto-runs from a bee.
 *
 * SHIPS DARK behind papercusp-capability-grant-tool (default-OFF) — the owner's flag flip is the
 * activation/ratification gate. Wrapped in the control harness (dryRun, verify+auto-revert, audit,
 * one-call revert).
 */
import { z } from 'zod';
import { defineTool, entityRef, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../../workspace-registry';
import { PROTECTED_CAPABILITY_GLOBS, matchesAny } from '../../capability-envelope/policy';
import { loadRoleCapabilities } from '../../endpoint-route/routes/transport/role-principal-caps';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readGrants, grantCaps } from '../../role-capability-grants';

export default defineTool({
  name: 'capability:grant_role',
  profile: 'engineer',
  description:
    "Runtime-grant capabilities to a role (unioned into loadRoleCapabilities, flag-gated). Replaces editing BLUEPRINT_ROLE_CAPS + redeploying to unblock a role. Privilege-escalation surface — enforces D-007: no protected-floor caps (secrets:*/processes:kill), cannot grant above the granter's own envelope, operator-authority only. Audited + one-call-revertible. Dark until papercusp-capability-grant-tool is enabled.",
  capability: 'operator:write',
  guidance: {
    when: 'A role is blocked from its job for lack of a capability and you (operator/architect/mug) need to grant it live, instead of editing role-principal-caps.ts + redeploying.',
    notWhen: 'To REMOVE a cap, use capability:revoke_role. The protected floor (secrets:*, processes:kill) can never be granted. While the papercusp-capability-grant-tool flag is off this refuses (the grant surface is owner-ratified, D-007).',
    chaining: 'config:list-overrides shows active grants (concern role-capability-grants); config:reset-overrides wipes them.',
    seeAlso: [
      'capability:revoke_role (revoke a granted role)',
      'capability_envelope:set_role (set the whole role envelope)',
      'config:list-overrides (see active grants)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    role: entityRef('role', {
      max: 80,
      describe: 'The role to grant capabilities to (e.g. "planner", "cup").',
    }),
    capabilities: z.array(z.string().min(1).max(120)).min(1).describe('Capability strings to add, e.g. ["plans:write"].'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const ws = activeWorkspaceId();
    // D-007(c) part 1 — owner-ratification gate: dark until the owner flips the flag.
    if (!(await getFlag(FLAGS.CAPABILITY_GRANT_TOOL, ws))) {
      throw new Error('capability:grant_role is dark — enable papercusp-capability-grant-tool to use it (owner-authority, D-007).');
    }
    // D-007(c) part 2 — operator-authority only (never a bee; the autonomy category is system-control/never-auto).
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability:grant_role requires operator, architect, or mug role');
    }
    const caps = [...new Set(args.capabilities)];
    // D-007(a) — never grant the protected floor.
    const floor = caps.filter((c) => matchesAny(c, PROTECTED_CAPABILITY_GLOBS));
    if (floor.length) {
      throw new Error(`cannot grant protected-floor capabilities: ${floor.join(', ')} (D-007 — these stay deny-only for every role)`);
    }
    const { sql } = getOrgPg();
    // D-007(b) — no self-escalation: only grant caps the granter's own role already holds.
    const granterCaps = await loadRoleCapabilities(sql, ws, ctx.role ?? '');
    const exceed = caps.filter((c) => !granterCaps.has(c));
    if (exceed.length) {
      throw new Error(`cannot grant capabilities you do not hold: ${exceed.join(', ')} (no self-escalation, D-007)`);
    }

    const outcome = await runControlMutation<string[]>(
      {
        action: 'capability:grant_role',
        subject: `role:${args.role}`,
        actor: `role:${ctx.role}`,
        capturePrev: () => readGrants(args.role),
        apply: () => grantCaps(args.role, caps),
        revertTo: async (prev) => {
          // Replace the grant set back to exactly the captured prev (restore).
          const { writeGrants } = await import('../../role-capability-grants');
          await writeGrants(args.role, prev);
        },
        verify: async (next) => {
          const ok = caps.every((c) => next.includes(c));
          return { ok, detail: ok ? undefined : 'grant set did not reflect the added capabilities' };
        },
        describe: (prev) => ({ role: args.role, current: prev, adding: caps }),
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
