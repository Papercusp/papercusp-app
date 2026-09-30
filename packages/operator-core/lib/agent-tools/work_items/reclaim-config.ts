/**
 * work_items:reclaim_config — read/set the stale-claim reclaim policy (live-configurability-audit P-014).
 *
 * reclaimGraceMs (how long a heartbeat-less claim sits before it's presumed orphaned + reclaimed) +
 * reclaimRequeueCap (requeues before a mid-flight item is dead-lettered to `blocked`). Threaded into
 * the periodic reclaimStaleWorkItemClaims sweep (dbos/in-process-periodic) — which already accepts
 * both as overrides. Absent ⇒ the baked defaults (STALE_MS grace, staleReclaimRequeueCap() cap) ⇒
 * byte-identical. Audited + one-call-revertible.
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
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'work_items:reclaim_config',
  profile: 'engineer',
  description:
    'Read or set the stale-claim reclaim policy: reclaimGraceMs (a heartbeat-less claim is presumed orphaned + reclaimed after this; default = the 10-min liveness window), reclaimParkedGraceMs (the LONGER grace before reaping a briefly-parked/resumable holder that beat recently — the reclaim-churn fix, default 30m, clamped ≥ reclaimGraceMs) and reclaimRequeueCap (requeues before a mid-flight item is dead-lettered to blocked; default 3). Threaded into the periodic reclaim sweep. set is audited + one-call-revertible.',
  capability: 'operator:write',
  guidance: {
    when: 'Tighten reclaim (shorter grace) to free orphaned work faster after a crash wave, or loosen it to avoid reclaiming briefly-quiet live work; raise reclaimParkedGraceMs to give loop-dropped members longer to re-arm before their claim is yanked (kills claim→release→reclaim churn); raise the requeue cap to retry flaky items more before dead-lettering.',
    notWhen: 'For the presence/liveness window itself (shared STALE_MS source) this only overrides the RECLAIM grace. For handoff TTL use coord:handoff_config; for session reaping use coord:session_reaper_config.',
    chaining: 'fleet:assignments shows orphaned claims; config:list-overrides shows the active override; config:reset-overrides reverts it.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      reclaimGraceMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
      reclaimParkedGraceMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
      reclaimRequeueCap: z.number().int().min(0).max(100).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const c = await readCoordLivenessConfig();
      return json({
        reclaimGraceMs: c.reclaimGraceMs ?? null,
        reclaimParkedGraceMs: c.reclaimParkedGraceMs ?? null,
        reclaimRequeueCap: c.reclaimRequeueCap ?? null,
        defaults: {
          reclaimGraceMs: COORD_LIVENESS_DEFAULTS.reclaimGraceMs,
          reclaimParkedGraceMs: COORD_LIVENESS_DEFAULTS.reclaimParkedGraceMs,
          reclaimRequeueCap: COORD_LIVENESS_DEFAULTS.reclaimRequeueCap,
        },
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('work_items:reclaim_config set requires operator, architect, or mug role');
    }
    const patch: CoordLivenessConfig = {};
    if (args.reclaimGraceMs !== undefined) patch.reclaimGraceMs = args.reclaimGraceMs;
    if (args.reclaimParkedGraceMs !== undefined) patch.reclaimParkedGraceMs = args.reclaimParkedGraceMs;
    if (args.reclaimRequeueCap !== undefined) patch.reclaimRequeueCap = args.reclaimRequeueCap;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of reclaimGraceMs / reclaimParkedGraceMs / reclaimRequeueCap');
    }

    const outcome = await runControlMutation<CoordLivenessConfig>(
      {
        action: 'work_items:reclaim_config',
        subject: 'stale-claim-reclaim',
        actor: `role:${ctx.role}`,
        capturePrev: () => readCoordLivenessConfig(),
        apply: () => writeCoordLivenessConfig(patch),
        revertTo: (prev) => setCoordLivenessConfig(prev),
        verify: async (next) => {
          const ok =
            (args.reclaimGraceMs === undefined || next.reclaimGraceMs === args.reclaimGraceMs) &&
            (args.reclaimParkedGraceMs === undefined || next.reclaimParkedGraceMs === args.reclaimParkedGraceMs) &&
            (args.reclaimRequeueCap === undefined || next.reclaimRequeueCap === args.reclaimRequeueCap);
          return { ok, detail: ok ? undefined : 'reclaim config did not persist' };
        },
        describe: (prev) => ({ current: prev, patch }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
