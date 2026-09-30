/** Shared Google Workspace OAuth → owned trigger-source connection seam. */
import type postgres from 'postgres';
import { type ExternalTriggerSourceRow, upsertOwnedExternalTriggerSource } from './source-store';
import { ensureExternalTriggerBinding } from './admin';
import {
  GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT,
  getProvider,
  loadAndRegisterProvidersFromDisk,
} from '../oauth/providers';
import { fsTokenStorage } from '../oauth/storage-fs';
import { getOAuthToken, withRetry } from '../oauth/token';

import type { gmail_v1 } from '@googleapis/gmail';

export const GOOGLE_WORKSPACE_OAUTH_PLUGIN = 'google-workspace';
export const GOOGLE_WORKSPACE_SOURCE_KINDS = ['gmail', 'gcal', 'contacts'] as const;
export const GOOGLE_GMAIL_PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const GOOGLE_CALENDAR_MEETING_PREP_HARNESS = 'papercusp';
export const GOOGLE_CALENDAR_MEETING_PREP_PLAN = 'meeting-prep-brief-2026-08-22';
export const GOOGLE_CALENDAR_MEETING_PREP_EVENT = 'ext:gcal:event-upcoming';
const OAUTH_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GoogleContactsProbeResult {
  status: number;
  endpoint: string;
}

export interface GoogleWorkspaceProviderAccount {
  providerAccountId: string;
  displayName: string;
}

type GoogleWorkspaceSourceIdentity = Pick<
  ExternalTriggerSourceRow,
  'kind' | 'providerAccountId' | 'cursor' | 'config'
>;

/** Legacy OAuth/source rows used the credential slot as their account id. */
export function isGoogleWorkspaceProvisionalProviderAccountId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? '';
  return (
    normalized.startsWith(`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:`) || normalized.startsWith('legacy-owner:')
  );
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.includes('@') ? normalized : null;
}

/** Read the canonical mailbox identity persisted by the Gmail adapter. */
export function googleWorkspaceSourceEmail(source: GoogleWorkspaceSourceIdentity): string | null {
  if (source.kind !== 'gmail') return null;
  return (
    normalizedEmail(source.cursor.emailAddress) ??
    normalizedEmail(source.cursor.email_address) ??
    normalizedEmail(source.config.emailAddress) ??
    normalizedEmail(source.config.email_address)
  );
}

/**
 * Resolve the account identity exposed to OAuth/status callers. Legacy source
 * rows may carry a provisional account id on every surface, while their Gmail
 * cursor already records the provider's canonical email. Sibling source rows
 * inherit that Gmail identity so one old connection cannot render as a ghost
 * account beside its canonical row.
 */
export function googleWorkspaceSourceAccountId(
  source: GoogleWorkspaceSourceIdentity,
  sources: readonly GoogleWorkspaceSourceIdentity[] = [source],
): string | null {
  const providerAccountId = source.providerAccountId?.trim() ?? '';
  if (!providerAccountId) return null;
  if (!isGoogleWorkspaceProvisionalProviderAccountId(providerAccountId)) return providerAccountId;
  const normalizedProviderAccountId = providerAccountId.toLowerCase();
  const gmailSource = sources.find(
    (candidate) =>
      candidate.kind === 'gmail' &&
      candidate.providerAccountId?.trim().toLowerCase() === normalizedProviderAccountId,
  );
  return googleWorkspaceSourceEmail(gmailSource ?? source) ?? providerAccountId;
}

/** Resolve the provider-native identity behind a freshly exchanged token. */
export async function resolveGoogleWorkspaceProviderAccount(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleWorkspaceProviderAccount> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_workspace_access_token_required');
  const response = await fetchImpl(GOOGLE_GMAIL_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`google_workspace_profile_${response.status}`);
  // The wire shape comes from @googleapis/gmail (already a dependency) instead
  // of being hand-written, so a field Google re-types cannot drift out of this
  // file. Schema$Profile is WIDER than the `{ emailAddress?: unknown }` it
  // replaces — `emailAddress` is `string | null | undefined` — and the
  // `typeof === 'string'` guard below already rejected null on its first
  // branch, so the runtime was always correct and only the annotation was
  // narrower than the behaviour it described.
  const body = (await response.json()) as gmail_v1.Schema$Profile;
  const emailAddress = typeof body.emailAddress === 'string' ? body.emailAddress.trim().toLowerCase() : '';
  if (!emailAddress || !emailAddress.includes('@')) {
    throw new Error('google_workspace_profile_email_required');
  }
  return { providerAccountId: emailAddress, displayName: emailAddress };
}

/**
 * Validate a Google token against the Contacts permission it actually needs.
 * Do not replace this with GET `/v1/people/me`: that profile-only resource
 * rejects a valid `contacts.readonly` token with 403.
 */
export async function probeGoogleContactsAccess(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleContactsProbeResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_contacts_access_token_required');

  const url = new URL(GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT);
  url.searchParams.set('personFields', 'names,emailAddresses');
  url.searchParams.set('pageSize', '1');
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`google_contacts_${response.status}`);
  return { status: response.status, endpoint: url.toString() };
}

export function googleWorkspaceOAuthField(credentialRef: string | null): string {
  const prefix = `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:`;
  if (!credentialRef?.startsWith(prefix)) {
    throw new Error('google_workspace_credential_ref_invalid');
  }
  const field = credentialRef.slice(prefix.length);
  if (!OAUTH_FIELD.test(field)) throw new Error('google_workspace_credential_ref_invalid');
  return field;
}

export function googleWorkspaceCredentialRef(field: string): string {
  if (!OAUTH_FIELD.test(field)) throw new Error('google_workspace_oauth_field_invalid');
  return `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${field}`;
}

/**
 * Distinguish reconnect-required Google credential failures from transient
 * provider faults. Google may surface revocation either while refreshing the
 * OAuth grant or as a provider API 401 against an otherwise unexpired token.
 */
export function isGoogleWorkspaceTerminalAuthError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:oauth|credential_ref|access_token).*(?:invalid|expired|revoked|not[_ -]?connected|not[_ -]?registered|required)|(?:invalid_grant|invalid_token)|google_(?:workspace|gmail|calendar)_[a-z0-9_]+_401\b|still[_ -]?401/i.test(
    message,
  );
}

export function assertGoogleWorkspaceOwnerUserId(ownerUserId: string | undefined): string {
  const normalized = ownerUserId?.trim() ?? '';
  if (!UUID.test(normalized)) throw new Error('google_workspace_owner_user_id_invalid');
  return normalized;
}

function googleWorkspaceTokenContext(field: string, installSlug: string) {
  return {
    plugin: GOOGLE_WORKSPACE_OAUTH_PLUGIN,
    harness: installSlug,
    storage: fsTokenStorage,
    resolveProvider: (candidate: string) => (candidate === field ? { provider: 'google' } : null),
  };
}

/** Resolve the shared Google Workspace Desktop OAuth token for either source. */
export async function resolveGoogleWorkspaceAccessToken(
  source: ExternalTriggerSourceRow,
  installSlug: string,
): Promise<string> {
  const field = googleWorkspaceOAuthField(source.credentialRef);
  if (!getProvider('google')) await loadAndRegisterProvidersFromDisk();
  const token = await getOAuthToken(googleWorkspaceTokenContext(field, installSlug), field);
  if (!token) throw new Error(`google_workspace_oauth_not_connected:${field}`);
  return token;
}

/**
 * Run one provider operation with the shared OAuth helper's forced-refresh
 * retry. Callers report the upstream status so a 401 retries once with a fresh
 * access token; a second 401 marks the credential expired and requires an
 * account-targeted reconnect.
 */
export async function withGoogleWorkspaceAccessTokenRetry<T>(
  source: ExternalTriggerSourceRow,
  installSlug: string,
  call: (accessToken: string) => Promise<{ status: number; result: T }>,
): Promise<T> {
  const field = googleWorkspaceOAuthField(source.credentialRef);
  if (!getProvider('google')) await loadAndRegisterProvidersFromDisk();
  return withRetry(googleWorkspaceTokenContext(field, installSlug), field, call);
}

/**
 * One OAuth consent backs every provider surface. They remain separate source
 * rows because canonical event keys, replay cursors, and enablement are
 * source-kind scoped, while every row points at the same opaque OAuth
 * credential reference. The rows are adapter state, not additional consents.
 */
export async function provisionOwnedGoogleWorkspaceSources(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    providerAccountId: string;
    field: string;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerSourceRow[]> {
  const ownerUserId = assertGoogleWorkspaceOwnerUserId(input.ownerUserId);
  const credentialRef = googleWorkspaceCredentialRef(input.field);
  const rows: ExternalTriggerSourceRow[] = [];
  for (const kind of GOOGLE_WORKSPACE_SOURCE_KINDS) {
    rows.push(
      await upsertOwnedExternalTriggerSource(sql, {
        workspaceId: input.workspaceId,
        kind,
        ownerUserId,
        providerAccountId: input.providerAccountId,
        credentialRef,
        status: 'connected',
        config: { capabilityEnabled: true },
        createdBy: input.createdBy ?? `owner:${ownerUserId}`,
      }),
    );
  }
  const calendar = rows.find((row) => row.kind === 'gcal');
  if (!calendar) throw new Error('google_workspace_calendar_source_missing');
  await ensureExternalTriggerBinding(sql, input.workspaceId, {
    sourceId: calendar.id,
    planHarnessSlug: GOOGLE_CALENDAR_MEETING_PREP_HARNESS,
    planSlug: GOOGLE_CALENDAR_MEETING_PREP_PLAN,
    eventPattern: GOOGLE_CALENDAR_MEETING_PREP_EVENT,
    eventFilter: { 'attendees.0': { exists: true } },
    createdBy: input.createdBy ?? `owner:${ownerUserId}`,
  });
  return rows;
}
