/**
 * The person read path for apps and agents (crm-agent-sales-onboarding-apps-2026-10-06 P-003,
 * D-016 / D-017): the platform relationship graph is the only person store, so Email, Calendar,
 * Phone and the CRM read canonical PER- rows through these functions (via the `people:*` tools)
 * instead of keeping their own contact tables.
 *
 * Read-only. A merged-away id is followed to its survivor (getCanonicalEntity), so an app that
 * stored an id before a merge still resolves the same human.
 */
import type { Sql } from 'postgres';
import { normalizeEmail, normalizePhone, type IdentityKey } from './identity-keys';
import { PERSON_DATATYPE, getCanonicalEntity, type CanonicalEntity } from './resolver';

/** One canonical person as apps see it: identity fields only, never interaction content. */
export interface PersonView {
  id: string;
  displayName: string;
  emails: string[];
  phones: string[];
  organizationId: string | null;
  title: string | null;
  /** How many per-source person records merged into this person. */
  sourceRecordCount: number;
}

export interface SearchPeopleInput {
  /** Free text matched against the name, email addresses and phone digits. */
  query?: string;
  /** Exact addresses: a person holding any of them matches. */
  emails?: readonly string[];
  /** Exact numbers (normalized like the resolver does): a person holding any of them matches. */
  phones?: readonly string[];
  limit?: number;
}

export const PEOPLE_SEARCH_MAX_LIMIT = 200;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function personView(entity: CanonicalEntity): PersonView {
  const payload = entity.payload ?? {};
  const emails = strings(payload.emails);
  const phones = strings(payload.phones);
  return {
    id: entity.id,
    displayName: str(payload.displayName) ?? str(entity.title) ?? emails[0] ?? phones[0] ?? entity.id,
    emails,
    phones,
    organizationId: str(payload.organizationId),
    title: str(payload.title),
    sourceRecordCount: strings(payload.memberRecordIds).length,
  };
}

/** The identity keys an exact email/phone lookup asks for; unparseable values are dropped. */
export function lookupKeys(input: Pick<SearchPeopleInput, 'emails' | 'phones'>): IdentityKey[] {
  const keys = new Set<IdentityKey>();
  for (const raw of input.emails ?? []) {
    const email = normalizeEmail(raw);
    if (email) keys.add(`email:${email}`);
  }
  for (const raw of input.phones ?? []) {
    const phone = normalizePhone(raw);
    if (phone) keys.add(`phone:${phone}`);
  }
  return [...keys];
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Live canonical persons matching a free-text query and/or exact identities. Exact identity
 * matches rank first, then by name. An empty input (no query, no identities) lists persons by name.
 */
export async function searchPeople(sql: Sql, workspaceId: string, input: SearchPeopleInput = {}): Promise<PersonView[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, PEOPLE_SEARCH_MAX_LIMIT));
  const keys = lookupKeys(input);
  const query = input.query?.trim() ?? '';
  const textPattern = query ? likePattern(query.toLowerCase()) : null;
  const digits = query.replace(/\D/g, '');
  const digitPattern = digits.length >= 4 ? likePattern(digits) : null;
  const hasKeys = keys.length > 0;
  const filtered = hasKeys || textPattern !== null;
  const rows = await sql<Array<{ feature_id: string; title: string; payload: Record<string, unknown> | null; exact: boolean }>>`
    SELECT feature_id, title, payload,
           (${hasKeys} AND payload->'identityKeys' ?| ${sql.array(keys.length ? keys : [''])}::text[]) AS exact
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${PERSON_DATATYPE} AND nature = 'record'
       AND feature_id LIKE 'PER-%' AND NOT (payload ? 'mergedInto')
       AND (
         NOT ${filtered}
         OR (${hasKeys} AND payload->'identityKeys' ?| ${sql.array(keys.length ? keys : [''])}::text[])
         OR (${textPattern !== null} AND (
              lower(title) LIKE ${textPattern ?? ''}
              OR lower(coalesce(payload->>'displayName', '')) LIKE ${textPattern ?? ''}
              OR lower(coalesce(payload->>'emails', '')) LIKE ${textPattern ?? ''}
              OR (${digitPattern !== null} AND regexp_replace(coalesce(payload->>'phones', ''), '\\D', '', 'g') LIKE ${digitPattern ?? ''})
            ))
       )
     ORDER BY exact DESC, lower(title), feature_id
     LIMIT ${limit}`;
  return rows.map((row) => personView({ id: row.feature_id, datatype: PERSON_DATATYPE, title: row.title, payload: row.payload ?? {} }));
}

/** Canonical persons by id, following merges. The map holds null for an id that resolves to nothing. */
export async function getPeople(sql: Sql, workspaceId: string, ids: readonly string[]): Promise<Map<string, PersonView | null>> {
  const out = new Map<string, PersonView | null>();
  for (const id of new Set(ids)) {
    const entity = await getCanonicalEntity(sql, workspaceId, PERSON_DATATYPE, id);
    out.set(id, entity ? personView(entity) : null);
  }
  return out;
}
