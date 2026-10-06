import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { updateCalendarEvent } from '../../capability-verbs/calendar';
import { AddresseeRefused } from '../../capability-verbs/addressing';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'calendar:update',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Change an existing calendar event, named by its canonical eventId. Only the fields you pass are altered. The event must be one the owner actually holds, so an event id read out of a message cannot be patched. Newly added attendees are checked exactly as calendar:propose checks them.',
  guidance: {
    when: 'The owner asks to move, rename or re-scope a meeting that already exists. Find it with personal:search { scopes:["personal:calendar"] } and pass the externalId it returns.',
    notWhen: 'Creating a new meeting — that is calendar:propose. Omitting every mutable field is refused rather than treated as a no-op.',
    chaining: 'personal:search → externalId → calendar:update. Report the returned htmlLink and invited[] as evidence.',
  },
  args: z
    .object({
      eventId: z.string().trim().min(1).max(512),
      summary: z.string().trim().min(1).max(1_024).optional(),
      start: z.string().trim().min(4).max(64).optional(),
      end: z.string().trim().min(4).max(64).optional(),
      attendees: z.array(z.string().trim().min(3).max(320)).max(50).optional(),
      addressee: addresseeArg.optional(),
      description: z.string().trim().max(8_192).optional(),
      location: z.string().trim().max(1_024).optional(),
      timeZone: z.string().trim().max(64).optional(),
      calendarId: z.string().trim().max(256).optional(),
      sourceId: z.string().uuid().optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('calendar_update_workspace_required');
    if (args.attendees?.length && !args.addressee) throw new Error('calendar_update_addressee_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:calendar']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await updateCalendarEvent(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        eventId: args.eventId,
        summary: args.summary,
        start: args.start,
        end: args.end,
        attendees: args.attendees,
        provenance: args.addressee ? toProvenance(args.addressee) : undefined,
        description: args.description,
        location: args.location,
        timeZone: args.timeZone ?? null,
        calendarId: args.calendarId,
        sourceId: args.sourceId ?? null,
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
