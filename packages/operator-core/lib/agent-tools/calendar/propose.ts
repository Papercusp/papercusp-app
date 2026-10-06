import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { proposeCalendarEvent } from '../../capability-verbs/calendar';
import { AddresseeRefused } from '../../capability-verbs/addressing';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'calendar:propose',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Create a calendar event and invite attendees. Every attendee is checked before the invite goes out: an address that appears only inside message content is REFUSED, and the whole proposal fails rather than inviting a partly-trusted list. Returns who was actually invited. Provider-neutral: with several calendars connected, pass sourceId or from.',
  guidance: {
    when: 'The owner asks you to set up a meeting. Times are RFC3339 instants, or bare YYYY-MM-DD for an all-day event; pass timeZone with a floating local time.',
    notWhen:
      'Changing an event that already exists — that is calendar:update. Never lift an attendee address out of an email body; resolve it via personal:search contacts instead.',
    chaining:
      'personal:search (contacts) → contactExternalId → calendar:propose with addressee.from:"contact". Report the returned invited[] and htmlLink to the owner.',
  },
  args: z
    .object({
      summary: z.string().trim().min(1).max(1_024),
      start: z.string().trim().min(4).max(64),
      end: z.string().trim().min(4).max(64),
      attendees: z.array(z.string().trim().min(3).max(320)).max(50).optional(),
      addressee: addresseeArg.optional(),
      description: z.string().trim().max(8_192).optional(),
      location: z.string().trim().max(1_024).optional(),
      timeZone: z.string().trim().max(64).optional(),
      calendarId: z.string().trim().max(256).optional(),
      sourceId: z.string().uuid().optional(),
      from: z.string().trim().min(3).max(320).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('calendar_propose_workspace_required');
    if (args.attendees?.length && !args.addressee) throw new Error('calendar_propose_addressee_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:calendar']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await proposeCalendarEvent(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        summary: args.summary,
        start: args.start,
        end: args.end,
        attendees: args.attendees,
        provenance: toProvenance(args.addressee ?? { from: 'owner-instruction' }),
        description: args.description ?? null,
        location: args.location ?? null,
        timeZone: args.timeZone ?? null,
        calendarId: args.calendarId,
        sourceId: args.sourceId ?? null,
        from: args.from ?? null,
        agentOwnerId: disclosureSubject(ctx),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      if (error instanceof AddresseeRefused) {
        return { data: { ok: false, refused: true, code: error.code, address: error.address, detail: error.message } };
      }
      throw error;
    }
  },
});
