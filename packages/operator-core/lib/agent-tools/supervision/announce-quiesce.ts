/**
 * supervision:announce-quiesce — register (or clear) a durable, ad-hoc "I am
 * deliberately taking <subject> down for <reason> until <until>" announcement, so a
 * health guard that would otherwise alarm on the resulting absence — and instruct
 * every agent on the box to "restart" it — reads your announcement first instead
 * (EI-22040647386284200).
 *
 * See system-health/announced-quiesce.ts for the full rationale: this is
 * deliberately WEAKER, broader evidence than D-026's systemd-verified cut+restore
 * pair — a self-report, not an independently observable signal — so a caller like
 * single-primary-check.ts checks D-026 FIRST and this SECOND. `until` is REQUIRED
 * (unless `end:true`) and clamped to announced-quiesce.ts's MAX_QUIESCE_MS, so a
 * missed `end` call cannot wedge suppression open past a bounded window — re-announce
 * to extend a genuinely longer window.
 *
 * The one subject `single-primary-check.ts` currently reads is
 * `ANNOUNCED_QUIESCE_SUBJECT = 'bg-host'` — pass `subject: 'bg-host'` to suppress
 * that specific alarm while you have it deliberately down. Other guards could
 * register/read their own subjects later; nothing here is bg-host-specific.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { announceQuiesce, endQuiesce } from '../../system-health/announced-quiesce';
import { pausedByFrom } from '../routines/set';

export default defineTool({
  name: 'supervision:announce-quiesce',
  profile: 'engineer',
  description:
    "Register (or clear) a deliberate, bounded-duration quiesce window for `subject` (e.g. 'bg-host') so a health guard that would otherwise alarm on the resulting absence — and instruct peers to \"restart\" it — reads your announcement first instead. Weaker evidence than a systemd-verified contract (D-026), so a guard checks that first and this second. `until` is required unless `end:true`, and is clamped to a maximum window (~12h); re-announce to extend.",
  capability: 'operator:write',
  guidance: {
    when:
      "You are about to (or just did) deliberately take a service down by hand — a manual kill/systemctl stop plus your own restore trap, not a Papercusp-mediated cut — and want a guard's alarm to name your window instead of instructing peers to restart it. `single-primary-check.ts` currently reads subject 'bg-host' for this.",
    notWhen:
      'For the systemd-verified release-cut whole-cut+restore contract (D-026), nothing to call — that suppression is automatic from the cut/restore units themselves. This tool is only for an ad-hoc, self-reported quiesce D-026 cannot observe.',
    chaining:
      "Call with end:true (no reason/until needed) once the quiesced service is restored, or let the window expire on its own — a forgotten end call cannot wedge the alarm off past `until`.",
    seeAlso: ['supervision:annotate-pause (the systemd-unit-pause analog)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      subject: z.string().min(1).max(200).describe("What is being quiesced, e.g. 'bg-host'."),
      reason: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Why this subject is deliberately down — persisted verbatim into the advisory text a guard surfaces. Required unless `end:true`.',
        ),
      until: z
        .string()
        .datetime()
        .optional()
        .describe(
          'ISO timestamp this window expires. Required unless `end:true` — clamped to a maximum window (~12h); re-announce to extend past it.',
        ),
      by: z
        .string()
        .max(200)
        .optional()
        .describe('Who to attribute this announcement to. Defaults to the calling agent/ownerId (or role: fallback) when omitted.'),
      end: z.boolean().optional().describe('Clear an active announcement early instead of registering one. When true, `reason`/`until` are ignored.'),
    })
    .superRefine((a, ctx) => {
      if (a.end) return;
      if (!a.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reason is required unless end:true' });
      if (!a.until) ctx.addIssue({ code: 'custom', path: ['until'], message: 'until is required unless end:true' });
    }),
  async handler(args, ctx) {
    if (args.end) {
      await endQuiesce(args.subject);
      return { data: { ok: true, subject: args.subject, ended: true } };
    }
    const record = await announceQuiesce(
      args.subject,
      {
        reason: args.reason!,
        by: args.by ?? pausedByFrom(ctx, ctx.role),
        untilMs: Date.parse(args.until!),
      },
      Date.now(),
    );
    return { data: { ok: true, subject: args.subject, record } };
  },
});
