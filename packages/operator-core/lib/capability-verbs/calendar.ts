/**
 * Provider-neutral calendar capability seam (D-019 Tier 1, plan item P-030;
 * provider dispatch per plan generalized-integrations-google-migration-
 * cupboard-workflows-2026-10-05 P-007, design authority D-014).
 *
 * The verbs name the canonical `calendar-event` datatype and the
 * `calendar.write` capability, never a provider. `resolveCapabilitySource`
 * picks the owner's connected calendar source and the provider that serves it,
 * refusing by name when the choice is ambiguous or the provider lacks the
 * capability. The provider receives `calendar.write` with
 * `{ operation: 'create' | 'update', … }`; Google Calendar is the bundled
 * `gcal` provider plugin (P-009, D-021), with no host-side Google path.
 *
 * Calendar is where D-020's create-shaped rail earns its keep. `calendar:propose`
 * genuinely takes caller-supplied attendees — rail 1 cannot cover it — so every
 * attendee goes through the trusted-addressee check and the cleared list is
 * echoed back before anyone is invited. The rails run here, before dispatch,
 * identically for every provider.
 */
import type postgres from 'postgres';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressees, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import {
  invokeOutboundProvider,
  OUTBOUND_CAPABILITIES,
  resolveCapabilitySource,
  resultString,
  resultStrings,
  type OutboundDispatchDeps,
  type OutboundTarget,
} from './provider-dispatch';
import { CANONICAL_SOURCE_BY_DATATYPE, resolveCanonicalDocument, string } from './resolve';

/** What any provider reports back for a written event. */
export interface CalendarWriteResult {
  id: string;
  htmlLink: string | null;
  status: string | null;
  attendees: string[];
}

export interface CalendarProposeResult extends CalendarWriteResult {
  /** Who was actually invited, with how each addressee cleared rail 2. */
  invited: AddresseeDecision[];
  summary: string;
}

/** Injectable seams: `registry` / `hostFetchFor` / `hostFetchImpl` reach the provider. */
export type CalendarDeps = OutboundDispatchDeps;

/** The event fields a write carries; `undefined` means "leave unchanged" on update. */
interface CalendarEventFields {
  calendarId?: string;
  summary?: string;
  description?: string | null;
  location?: string | null;
  start?: string;
  end?: string;
  timeZone?: string | null;
  attendees?: string[];
}

/** Drop `undefined` so a provider sees an update's omitted fields as absent, not as cleared. */
function presentFields(fields: CalendarEventFields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Invoke `calendar.write` on a registered provider and validate what it reports. */
async function writeViaProvider(
  sql: postgres.Sql,
  target: OutboundTarget,
  operation: { operation: 'create' } | { operation: 'update'; eventId: string },
  fields: CalendarEventFields,
  deps: CalendarDeps,
): Promise<CalendarWriteResult> {
  const capability = OUTBOUND_CAPABILITIES.calendarWrite;
  const result = await invokeOutboundProvider(sql, target, capability, { ...operation, ...presentFields(fields) }, deps);
  return {
    id: resultString(result, 'id', target, capability),
    htmlLink: resultString(result, 'htmlLink', target, capability, false) || null,
    status: resultString(result, 'status', target, capability, false) || null,
    attendees: resultStrings(result, 'attendees'),
  };
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
    /** The connected calendar source to create the event in. Required when several are connected. */
    sourceId?: string | null;
    /** The calendar account address to act as; an alternative to `sourceId`. */
    from?: string | null;
    /** Reader-set labels: see `sendNewMail` in ./mail. Every invitee receives the event. */
    agentOwnerId: string | null;
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
  if (invited.length) {
    await assertDisclosurePermits(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.agentOwnerId,
      recipients: invited.map((decision) => decision.address),
      sink: 'calendar:propose',
    });
  }

  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'calendar-event',
      capabilities: [OUTBOUND_CAPABILITIES.calendarWrite],
      sourceId: params.sourceId,
      providerAccountId: params.from,
    },
    deps,
  );
  const fields = {
    calendarId: params.calendarId,
    summary,
    description: params.description ?? null,
    location: params.location ?? null,
    start: params.start,
    end: params.end,
    timeZone: params.timeZone ?? null,
    attendees: invited.map((decision) => decision.address),
  };
  const created = await writeViaProvider(sql, target, { operation: 'create' }, fields, deps);
  return { ...created, invited, summary };
}

/**
 * `calendar:update` — patch an event the owner already has in their vault.
 *
 * The event must resolve as a canonical `calendar-event` the owner holds,
 * which is what stops a caller patching an arbitrary event id it read out of
 * a message. Newly ADDED attendees still go through rail 2. The update goes out
 * through the source that holds the event.
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
    /** The source holding the event; required only when the same event id is stored under several. */
    sourceId?: string | null;
    /** See `proposeCalendarEvent`. */
    agentOwnerId: string | null;
  },
  deps: CalendarDeps = {},
): Promise<CalendarProposeResult> {
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: CANONICAL_SOURCE_BY_DATATYPE['calendar-event'],
    externalId: params.eventId,
    sourceId: params.sourceId,
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
  // An update notifies everyone on the event, not only newly added attendees,
  // so the audience is the stored participants plus any additions.
  const audience = [...new Set([...doc.participants, ...invited.map((decision) => decision.address)])];
  if (audience.length) {
    await assertDisclosurePermits(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.agentOwnerId,
      recipients: audience,
      sink: 'calendar:update',
    });
  }

  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'calendar-event',
      capabilities: [OUTBOUND_CAPABILITIES.calendarWrite],
      sourceId: doc.sourceId ?? params.sourceId,
    },
    deps,
  );
  const fields: CalendarEventFields = {
    calendarId: params.calendarId,
    summary: params.summary,
    description: params.description,
    location: params.location,
    start: params.start,
    end: params.end,
    timeZone: params.timeZone ?? null,
    ...(params.attendees?.length ? { attendees: invited.map((decision) => decision.address) } : {}),
  };
  const summary = params.summary?.trim() || string(doc.payload.summary);
  const updated = await writeViaProvider(
    sql,
    target,
    { operation: 'update', eventId: doc.externalId },
    fields,
    deps,
  );
  return { ...updated, invited, summary };
}
