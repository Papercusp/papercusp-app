import type { Sql } from 'postgres';
import { getExternalTriggerSource } from '../external-triggers/source-store';
import { GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT } from '../oauth/providers';
import type { PersonalDocumentInput } from './types';
import { setPersonalSyncState, upsertPersonalDocuments } from './store';

export interface NormalizedExternalEvent {
  key: string;
  externalId: string;
  occurredAt?: string | null;
  payload: Record<string, unknown>;
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === 'string')
  : typeof value === 'string' ? [value] : [];

export interface PersonalDocumentProvenance {
  sourceId?: string | null;
  providerAccountId?: string | null;
}

export function personalDocumentFromExternalEvent(
  event: NormalizedExternalEvent,
  provenance: PersonalDocumentProvenance = {},
): PersonalDocumentInput {
  const p = event.payload;
  if (event.key.startsWith('ext:gmail:')) {
    return {
      source: 'gmail', ...provenance, kind: 'message', externalId: event.externalId, occurredAt: event.occurredAt,
      participants: [...strings(p.from), ...strings(p.to), ...strings(p.cc)],
      title: String(p.subject ?? '(no subject)'), text: String(p.text ?? p.snippet ?? ''),
      metadata: p, dedupeKey: `gmail:${event.externalId}`,
    };
  }
  if (event.key.startsWith('ext:gcal:')) {
    const attendees = Array.isArray(p.attendees)
      ? p.attendees.flatMap((a) => typeof a === 'string' ? [a] : strings((a as { email?: unknown }).email))
      : [];
    return {
      source: 'calendar', ...provenance, kind: 'event', externalId: event.externalId, occurredAt: event.occurredAt,
      participants: [...strings(p.organizer), ...attendees],
      title: String(p.summary ?? '(untitled event)'), text: String(p.description ?? ''),
      metadata: p, dedupeKey: `calendar:${event.externalId}`,
    };
  }
  if (event.key.startsWith('ext:facebook:')) {
    const entityType = p.entityType === 'profile' || p.entityType === 'photo'
      ? p.entityType
      : 'post';
    const author = typeof p.author === 'string' && p.author.trim() ? p.author.trim() : null;
    const text = String(p.text ?? '');
    const title = entityType === 'profile'
      ? author ?? 'Facebook profile'
      : entityType === 'photo'
        ? text || 'Facebook photo'
        : 'Facebook post';
    return {
      source: 'facebook', ...provenance, kind: entityType, externalId: event.externalId, occurredAt: event.occurredAt,
      participants: author ? [author] : [], title, text,
      metadata: p, dedupeKey: `facebook:${entityType}:${event.externalId}`,
    };
  }
  throw new Error(`unsupported_personal_event:${event.key}`);
}

/** Second-sink seam consumed by the external-trigger adapters: normalization is
 * done once, then the same event feeds ext:* and this local Personal Vault row. */
export async function ingestPersonalExternalEvent(
  sql: Sql,
  workspaceId: string,
  userId: string,
  event: NormalizedExternalEvent,
  provenance: PersonalDocumentProvenance = {},
): Promise<{ insertedOrUpdated: number; ids: string[] }> {
  return upsertPersonalDocuments(sql, workspaceId, userId, [personalDocumentFromExternalEvent(event, provenance)]);
}

/**
 * Structural match for external-triggers/ingestion.ts's ExternalTriggerSink.
 * Kept local instead of importing that interface so ingestion can continue to
 * import NormalizedExternalEvent from this module without forming a cycle.
 */
export interface PersonalVaultExternalSink {
  kind: 'personal-vault';
  ref: string;
  deliver(event: NormalizedExternalEvent): Promise<unknown>;
}

/**
 * Ready-to-pass additional sink for one locally authenticated human. The user
 * id is part of the delivery-ledger identity, so two users connected to the
 * same provider event never dedupe each other's private vault writes.
 */
export function createPersonalVaultExternalSink(
  sql: Sql,
  workspaceId: string,
  userId: string,
  provenance: PersonalDocumentProvenance = {},
): PersonalVaultExternalSink {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error('personal_vault_user_required');
  return {
    kind: 'personal-vault',
    ref: provenance.sourceId ? `user:${normalizedUserId}:source:${provenance.sourceId}` : `user:${normalizedUserId}`,
    deliver: (event) => ingestPersonalExternalEvent(sql, workspaceId, normalizedUserId, event, provenance),
  };
}

/**
 * Resolve a source's server-owned local principal and construct its Personal
 * Vault sink. Adapters call this before passing the sink through
 * `ingestExternalTriggerEvent.additionalSinks`; no provider payload field can
 * nominate or widen the target user.
 */
export async function createPersonalVaultExternalSinkForSource(
  sql: Sql,
  workspaceId: string,
  sourceId: string,
): Promise<PersonalVaultExternalSink> {
  const source = await getExternalTriggerSource(sql, workspaceId, sourceId);
  if (!source?.ownerUserId) throw new Error(`external_trigger_source_owner_required:${sourceId}`);
  if (!source.providerAccountId) throw new Error(`external_trigger_source_account_required:${sourceId}`);
  return createPersonalVaultExternalSink(sql, workspaceId, source.ownerUserId, {
    sourceId: source.id,
    providerAccountId: source.providerAccountId,
  });
}

export async function syncGoogleContacts(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    accessToken: string;
    fetchImpl?: typeof fetch;
    pageToken?: string | null;
  },
): Promise<{ contacts: number; pages: number; nextPageToken: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let pageToken = input.pageToken ?? null;
  let contacts = 0;
  let pages = 0;
  do {
    const url = new URL(GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT);
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${input.accessToken}` } });
    if (!response.ok) throw new Error(`google_people_${response.status}`);
    const body = await response.json() as {
      connections?: Array<Record<string, unknown>>;
      nextPageToken?: string;
      totalPeople?: number;
    };
    const docs = (body.connections ?? []).map((person): PersonalDocumentInput => {
      const names = person.names as Array<{ displayName?: string }> | undefined;
      const emails = person.emailAddresses as Array<{ value?: string }> | undefined;
      const phones = person.phoneNumbers as Array<{ value?: string }> | undefined;
      const resourceName = String(person.resourceName ?? '');
      const primaryEmail = emails?.map((e) => e.value).find(Boolean) ?? null;
      return {
        source: 'contacts', kind: 'contact', externalId: resourceName || primaryEmail,
        participants: emails?.map((e) => e.value ?? '').filter(Boolean) ?? [],
        title: names?.map((n) => n.displayName).find(Boolean) ?? primaryEmail ?? '(unnamed contact)',
        text: [...(emails?.map((e) => e.value) ?? []), ...(phones?.map((p) => p.value) ?? [])].filter(Boolean).join('\n'),
        metadata: person,
        dedupeKey: `contacts:${resourceName || primaryEmail || JSON.stringify(person)}`,
      };
    });
    if (docs.length) await upsertPersonalDocuments(sql, input.workspaceId, input.userId, docs);
    contacts += docs.length;
    pages += 1;
    pageToken = body.nextPageToken ?? null;
    await setPersonalSyncState(sql, input.workspaceId, input.userId, 'contacts', { pageToken, totalPeople: body.totalPeople ?? null });
  } while (pageToken);
  return { contacts, pages, nextPageToken: pageToken };
}
