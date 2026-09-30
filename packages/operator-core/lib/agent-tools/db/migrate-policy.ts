/**
 * db:migrate-policy — read/set the deploy-migration connection policy
 * (live-configurability-audit-2026-06-20 P-003).
 *
 * The deploy migrator's `lock_timeout` (a hardcoded 15s) is the single value behind two
 * multi-hour deploy outages. This tool makes it (+ an optional statement_timeout) runtime-settable
 * without editing migrate.ts + redeploying through the very path you're tuning — wrapped in the
 * control harness (dryRun preview, post-apply verify+auto-revert, audit, one-call revert).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readMigratePolicy, writeMigratePolicy, type MigratePolicy } from '../../migrate-policy';

export default defineTool({
  name: 'db:migrate-policy',
  profile: 'engineer',
  description:
    'Read or set the deploy-migration connection policy: lockTimeoutMs (the DDL lock_timeout the deploy migrator uses — default 15000, the value behind two deploy outages) and statementTimeoutMs (optional; null to unset). set is audited + one-call-revertible via the control harness; migrate.ts reads it fail-safe (defaults on any read error).',
  capability: 'operator:write',
  guidance: {
    when: 'Before a deploy whose migration legitimately needs longer to acquire its lock — raise lockTimeoutMs for that window — or to add a statement_timeout, without editing migrate.ts and redeploying through the path you are tuning.',
    notWhen: 'For the BOOT-time migration lock_timeout (it runs before PG config is readable — stays an env/code default per the plan keep-hardcoded list). To see all live overrides, config:list-overrides.',
    chaining: 'config:list-overrides shows the active override; config:reset-overrides reverts it to the 15000 default.',
    seeAlso: [
      'db:migrate (apply migrations)',
      'config:list-overrides (active migrate-policy override)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      lockTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
      statementTimeoutMs: z.number().int().min(1000).max(3_600_000).nullable().optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return { content: [{ type: 'text', text: JSON.stringify({ policy: await readMigratePolicy() }) }] };
    }
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('db:migrate-policy set requires an operator-config write role (operator, architect, or mug; the isOperatorConfigWriteRole set is operator-equivalent write authority, NOT any su/worker role)');
    }
    if (args.lockTimeoutMs === undefined && args.statementTimeoutMs === undefined) {
      throw new Error('set requires lockTimeoutMs and/or statementTimeoutMs');
    }
    const patch: Partial<MigratePolicy> = {};
    if (args.lockTimeoutMs !== undefined) patch.lockTimeoutMs = args.lockTimeoutMs;
    if (args.statementTimeoutMs !== undefined) patch.statementTimeoutMs = args.statementTimeoutMs;

    const outcome = await runControlMutation<MigratePolicy>(
      {
        action: 'db:migrate-policy',
        subject: 'deploy-migrate',
        actor: `role:${ctx.role}`,
        capturePrev: () => readMigratePolicy(),
        apply: () => writeMigratePolicy(patch),
        revertTo: (prev) => writeMigratePolicy(prev).then(() => {}),
        verify: async (next) => {
          const ok =
            (args.lockTimeoutMs === undefined || next.lockTimeoutMs === args.lockTimeoutMs) &&
            (args.statementTimeoutMs === undefined || next.statementTimeoutMs === args.statementTimeoutMs);
          return { ok, detail: ok ? undefined : 'policy did not reflect the patch' };
        },
        describe: (prev) => ({ current: prev, proposed: { ...prev, ...patch } }),
      },
      { dryRun: args.dryRun },
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            dryRun: outcome.dryRun,
            applied: outcome.applied,
            reverted: outcome.reverted,
            preview: outcome.preview,
            verify: outcome.verify,
            auditId: outcome.auditId,
            prev: outcome.prev,
            next: outcome.next,
          }),
        },
      ],
    };
  },
});
