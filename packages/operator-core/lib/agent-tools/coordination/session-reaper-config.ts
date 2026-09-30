/**
 * coord:session_reaper_config — read/set the idle-session reaper grace (live-configurability-audit P-014).
 *
 * The idle-session reaper marks DEAD-process open sessions ended once their owner has been gone past
 * the grace window (default IDLE_SESSION_GRACE_MS = the 10-min liveness window). This makes the grace
 * settable, threaded into the reaper routine. A `set` with dryRun returns a WOULD-REAP count (runs the
 * reaper's pure plan at the proposed grace WITHOUT marking anything) — de-risking the SIGKILL-adjacent
 * change before it lands. Audited + one-call-revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { runIdleSessionReap } from '../../idle-session-reaper';
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
  name: 'coord:session_reaper_config',
  profile: 'engineer',
  description:
    'Read or set the idle-session reaper grace (sessionReaperGraceMs): a dead-process session is reaped once its owner has been gone past this window. Default = the 10-min liveness window. A set with dryRun returns a WOULD-REAP count at the proposed grace (marks nothing) to de-risk the change. set is audited + one-call-revertible.',
  capability: 'operator:write',
  guidance: {
    when: 'Tune how aggressively dead-process ghost sessions are reaped — shorten to reclaim the operator footprint faster, lengthen if a just-launched session is being reaped before its first presence beat. dryRun first to see the would-reap count.',
    notWhen: 'For stale work-item claims use work_items:reclaim_config; for handoff expiry use coord:handoff_config. To ARM the reaper itself, flip FLAGS.IDLE_SESSION_REAPER via /admin/features (this only tunes the grace).',
    chaining: 'set with dryRun:true previews the would-reap count; config:list-overrides shows the active override.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      sessionReaperGraceMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const c = await readCoordLivenessConfig();
      return json({ sessionReaperGraceMs: c.sessionReaperGraceMs ?? null, default: COORD_LIVENESS_DEFAULTS.sessionReaperGraceMs });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('coord:session_reaper_config set requires operator, architect, or mug role');
    }

    // dryRun: preview the would-reap count at the proposed grace — mark nothing (de-risk the SIGKILL change).
    if (args.dryRun) {
      const preview = await runIdleSessionReap({ dryRun: true, graceMs: args.sessionReaperGraceMs }).catch(() => null);
      return json({
        ok: true, dryRun: true, applied: false, proposed: { sessionReaperGraceMs: args.sessionReaperGraceMs },
        reaperEnabled: preview?.enabled ?? false, scanned: preview?.scanned ?? null, wouldReap: preview?.reaped ?? null,
      });
    }

    const patch: CoordLivenessConfig = { sessionReaperGraceMs: args.sessionReaperGraceMs };
    const outcome = await runControlMutation<CoordLivenessConfig>(
      {
        action: 'coord:session_reaper_config',
        subject: 'session-reaper-grace',
        actor: `role:${ctx.role}`,
        capturePrev: () => readCoordLivenessConfig(),
        apply: () => writeCoordLivenessConfig(patch),
        revertTo: (prev) => setCoordLivenessConfig(prev),
        verify: async (next) => ({ ok: next.sessionReaperGraceMs === args.sessionReaperGraceMs, detail: next.sessionReaperGraceMs === args.sessionReaperGraceMs ? undefined : 'grace did not persist' }),
        describe: (prev) => ({ current: prev.sessionReaperGraceMs ?? COORD_LIVENESS_DEFAULTS.sessionReaperGraceMs, proposed: args.sessionReaperGraceMs }),
      },
      { dryRun: false },
    );
    return json({
      ok: true, dryRun: false, applied: outcome.applied, reverted: outcome.reverted,
      verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
