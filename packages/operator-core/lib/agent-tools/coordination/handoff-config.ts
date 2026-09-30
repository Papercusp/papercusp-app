/**
 * coord:handoff_config — read/set the stale-handoff auto-expiry TTL (live-configurability-audit P-014).
 *
 * A coordination handoff left pending past this TTL is auto-expired by the periodic reconcile sweep
 * (so a stale offer stops misleading successors). Default STALE_HANDOFF_TTL_MS = 12h (was the
 * PAPERCUSP_STALE_HANDOFF_TTL_MS env gate — P-023 overlap). Threaded into the reconcile routine
 * (dbos/periodic-workflows handoffReconcileTick); absent ⇒ the 12h default ⇒ byte-identical.
 * Audited + one-call-revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readCoordLivenessConfig,
  writeCoordLivenessConfig,
  setCoordLivenessConfig,
  COORD_LIVENESS_DEFAULTS,
  type CoordLivenessConfig,
} from '../../coord-liveness-config';

function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'coord:handoff_config',
  profile: 'engineer',
  description:
    'Read or set the stale-handoff auto-expiry TTL (handoffTtlMs): a pending coordination handoff older than this is auto-expired by the periodic reconcile sweep. Default 12h. set is audited + one-call-revertible.',
  capability: 'operator:write',
  guidance: {
    when: 'Shorten the TTL to clear stale handoff offers faster (a successor chasing a dead offer wastes a turn), or lengthen it if legitimate handoffs routinely sit unaccepted longer than 12h.',
    notWhen: 'For stale work-item CLAIMS use work_items:reclaim_config; for idle sessions use coord:session_reaper_config. This only governs pending HANDOFF expiry.',
    chaining: 'coord:handoffs lists open handoffs; config:list-overrides shows the active override.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      handoffTtlMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const c = await readCoordLivenessConfig();
      return json({ handoffTtlMs: c.handoffTtlMs ?? null, default: COORD_LIVENESS_DEFAULTS.handoffTtlMs });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('coord:handoff_config set requires operator, architect, or mug role');
    }
    const patch: CoordLivenessConfig = { handoffTtlMs: args.handoffTtlMs };
    const outcome = await runControlMutation<CoordLivenessConfig>(
      {
        action: 'coord:handoff_config',
        subject: 'handoff-ttl',
        actor: `role:${ctx.role}`,
        capturePrev: () => readCoordLivenessConfig(),
        apply: () => writeCoordLivenessConfig(patch),
        revertTo: (prev) => setCoordLivenessConfig(prev),
        verify: async (next) => ({ ok: next.handoffTtlMs === args.handoffTtlMs, detail: next.handoffTtlMs === args.handoffTtlMs ? undefined : 'handoff TTL did not persist' }),
        describe: (prev) => ({ current: prev.handoffTtlMs ?? COORD_LIVENESS_DEFAULTS.handoffTtlMs, proposed: args.handoffTtlMs }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
