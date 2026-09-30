/**
 * supervision:annotate-pause — record WHY (and by whom) a currently-paused SUPERVISED systemd
 * unit is paused, and optionally when to re-review it (EI-20302762698704679).
 *
 * Pausing a systemd-user unit is NOT mediated by any Papercusp tool call (an operator runs
 * `systemctl --user disable --now <unit>` directly), so — unlike `routines:set`'s pause path,
 * which can REQUIRE a reason at the moment of pausing — there is no call site to enforce this at
 * pause time. This tool is the after-the-fact annotation surface instead: call it any time after
 * the reconciler observes a unit paused (or proactively, before its next tick) to attach the same
 * `{reason, by, reviewBy}` triple `routines:set`'s pause path already requires
 * (EI-18654017982759582 fixed the identical bug one layer over — a pause with no recorded
 * reason/owner stays silently off for days because every reader faces the same unanswerable
 * choice between re-arming it blind and leaving it alone). `unit-reconciler.ts`'s escalation
 * surfaces the ABSENCE of an annotation as the anomaly to report, past `PAUSE_ESCALATION_MS`.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { annotatePause } from '../../supervision/pause-clock';
import { pausedByFrom } from '../routines/set';

export default defineTool({
  name: 'supervision:annotate-pause',
  profile: 'engineer',
  description:
    'Record WHY (and by whom) a currently-paused SUPERVISED systemd unit was administratively disabled/masked, and optionally when to re-review it. Pausing a unit is a raw `systemctl --user disable --now` outside any Papercusp tool call, so this is the after-the-fact annotation the reconciler\'s escalation reads back — a pause left unannotated past 4h is reported as the anomaly (⚠ NO REASON RECORDED) in both the ambient notify and the filed EI.',
  capability: 'operator:write',
  guidance: {
    when:
      'You (or someone) just paused a SUPERVISED unit (`systemctl --user disable --now <unit>`) and want the pause on record — or you are triaging a `[supervision-paused]` EI / a "NO REASON RECORDED" escalation and can supply the missing context. Also usable proactively, before the reconciler\'s next tick observes the pause.',
    notWhen:
      'For a scheduled ROUTINE\'s pause (git-sync, green-checkpoint, scout, …) use routines:set { active:false, reason } instead — that path is mediated by a tool call and already requires a reason at pause time. This tool is only for the systemd-unit supervision layer (`SUPERVISED_PROCESSES`).',
    chaining:
      'dev:service_health or routines:list to confirm the unit is actually paused first; supervision:annotate-pause to record why; the reconciler auto-resolves the escalation once the unit is re-enabled — nothing to call to "un-annotate".',
    seeAlso: ['routines:set (the routine-pause analog)', 'dev:service_health (unit state)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    unit: z.string().min(1).max(200).describe('The systemd-user unit name, e.g. "papercup-live-federation-gate.timer".'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe('Why this unit is paused — persisted verbatim and surfaced in the reconciler\'s escalation body/notify text.'),
    by: z
      .string()
      .max(200)
      .optional()
      .describe('Who to attribute this annotation to. Defaults to the calling agent/ownerId (or role: fallback) when omitted.'),
    reviewBy: z
      .string()
      .datetime()
      .optional()
      .describe(
        'An ISO timestamp you intend to re-review this pause by — the DARK_FLAGS_REVIEW_BY / routines-pause reviewBy analog. Advisory only. Omitting it leaves any existing reviewBy untouched (a partial re-annotation, e.g. bumping only the reason, does not clear a previously-set reviewBy).',
      ),
  }),
  async handler(args, ctx) {
    const record = await annotatePause(
      args.unit,
      {
        reason: args.reason,
        by: args.by ?? pausedByFrom(ctx, ctx.role),
        ...(args.reviewBy !== undefined ? { reviewBy: args.reviewBy } : {}),
      },
      Date.now(),
    );
    return { data: { ok: true, unit: args.unit, record } };
  },
});
