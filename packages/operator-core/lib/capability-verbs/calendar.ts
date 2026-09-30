/**
 * Provider-neutral calendar capability seam (D-019 Tier 1, plan item P-030).
 *
 * This is the AGENT-FACING HALF OF P-022 (the Google Calendar write path), not
 * a parallel surface: it rides the `calendar.events` scope on the SAME Google
 * Workspace OAuth source per D-010/D-012, so there is exactly one credential
 * path for read and write.
 *
 * Calendar is where D-020's create-shaped rail earns its keep. `calendar:propose`
 * genuinely takes caller-supplied attendees — rail 1 cannot cover it — so every
 * attendee goes through the trusted-addressee check and the cleared list is
 * echoed back before anyone is invited.
 */
import type postgres from 'postgres';
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  type GoogleCalendarWriteResult,
} from '../external-triggers/google-calendar';
import { resolveGoogleWorkspaceAccessToken } from '../external-triggers/google-workspace';
import { assertTrustedAddressees, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import { resolveCanonicalDocument, resolveOutboundContext, string } from './resolve';

export interface CalendarProposeResult extends GoogleCalendarWriteResult {
  /** Who was actually invited, with how each addressee cleared rail 2. */
  invited: AddresseeDecision[];
  summary: string;
}

export type CalendarDeps = {
  resolveAccessToken?: typeof resolveGoogleWorkspaceAccessToken;
  createEvent?: typeof createGoogleCalendarEvent;
  updateEvent?: typeof updateGoogleCalendarEvent;
  fetch?: typeof fetch;
  apiOrigin?: string;
};

async function calendarToken(
  sql: postgres.Sql,
  params: { workspaceId: string; userId: string },
  deps: CalendarDeps,
): Promise<string> {
  const ctx = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: 'calendar',
  });
  return (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(ctx.source, ctx.installSlug);
}

/**
 * `calendar:propose` — create a meeting. Create-shaped, so D-020 rail 2 gates
 * every attendee. An attendee address that appears only inside inbound message
 * content is refused, and the whole proposal fails rather than inviting a
 * partially-trusted list.
 */
export async function proposeCalendarEvent(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    summary: string;
    start: string;
    end: string;
    attendees?: readonly string[];
    provenance: AddresseeProvenance;
    description?: string | null;
    location?: string | null;
    timeZone?: string | null;
    calendarId?: string;
  },
  deps: CalendarDeps = {},
): Promise<CalendarProposeResult> {
  const summary = params.summary.trim();
  if (!summary) throw new Error('calendar_propose_summary_required');

  const attendees = params.attendees ?? [];
  const invited = attendees.length
    ? await assertTrustedAddressees(sql, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        addresses: attendees,
        provenance: params.provenance,
      })
    : [];

  const token = await calendarToken(sql, params, deps);
  const created = await (deps.createEvent ?? createGoogleCalendarEvent)(
    token,
    {
      calendarId: params.calendarId,
      summary,
      description: params.description ?? null,
      location: params.location ?? null,
      start: params.start,
      end: params.end,
      timeZone: params.timeZone ?? null,
      attendees: invited.map((decision) => decision.address),
    },
    { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
  );
  return { ...created, invited, summary };
}

/**
 * `calendar:update` — patch an event the owner already has in their vault.
 *
 * The event must resolve as a canonical `calendar-event` the owner holds,
 * which is what stops a caller patching an arbitrary event id it read out of
 * a message. Newly ADDED attendees still go through rail 2.
 */
export async function updateCalendarEvent(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    eventId: string;
    summary?: string;
    start?: string;
    end?: string;
    attendees?: readonly string[];
    provenance?: AddresseeProvenance;
    description?: string | null;
    location?: string | null;
    timeZone?: string | null;
    calendarId?: string;
  },
  deps: CalendarDeps = {},
): Promise<CalendarProposeResult> {
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: 'calendar',
    externalId: params.eventId,
  });

  let invited: AddresseeDecision[] = [];
  if (params.attendees?.length) {
    if (!params.provenance) throw new Error('calendar_update_attendee_provenance_required');
    invited = await assertTrustedAddressees(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      addresses: params.attendees,
      provenance: params.provenance,
    });
  }

  const token = await calendarToken(sql, params, deps);
  const updated = await (deps.updateEvent ?? updateGoogleCalendarEvent)(
    token,
    doc.externalId,
    {
      calendarId: params.calendarId,
      summary: params.summary,
      description: params.description,
      location: params.location,
      start: params.start,
      end: params.end,
      timeZone: params.timeZone ?? null,
      ...(params.attendees?.length ? { attendees: invited.map((decision) => decision.address) } : {}),
    },
    { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
  );
  return { ...updated, invited, summary: params.summary?.trim() || string(doc.payload.summary) };
}
