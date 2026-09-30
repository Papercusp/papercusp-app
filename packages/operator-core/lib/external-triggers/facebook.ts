/**
 * Replay-safe Facebook Personal Vault adapter (personal-vault-live-integrations P-005).
 *
 * The adapter intentionally covers only the owner-authorized Graph surface:
 * profile metadata, posts, and photo metadata. It does not claim Messenger,
 * friends, private-group activity, ads/activity logs, or archive completeness.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import {
  type ExternalTriggerSourceRow,
  updateExternalTriggerSourceSyncState,
  upsertOwnedExternalTriggerSource,
} from './source-store';
import {
  createPersonalVaultExternalSinkForSource,
  type PersonalVaultExternalSink,
} from '../personal-vault/live-sink';
import { getProvider, loadAndRegisterProvidersFromDisk } from '../oauth/providers';
import { fsTokenStorage } from '../oauth/storage-fs';
import { getOAuthToken } from '../oauth/token';

export const FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN = 'facebook-personal-vault';
export const FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS = ['facebook'] as const;
const FACEBOOK_GRAPH_ORIGIN = 'https://graph.facebook.com';
const OAUTH_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGES = 10_000;

export interface FacebookProfile {
  id?: string;
  name?: string;
  link?: string;
  about?: string;
  picture?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FacebookProviderAccount {
  providerAccountId: string;
  displayName: string;
}

export interface FacebookPost {
  id?: string;
  message?: string;
  story?: string;
  created_time?: string;
  updated_time?: string;
  permalink_url?: string;
  from?: { id?: string; name?: string };
  attachments?: { data?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

export interface FacebookPhoto {
  id?: string;
  name?: string;
  created_time?: string;
  updated_time?: string;
  link?: string;
  picture?: string;
  images?: Array<Record<string, unknown>>;
  from?: { id?: string; name?: string };
  [key: string]: unknown;
}

interface FacebookConnection<T> {
  data?: T[];
  paging?: {
    cursors?: { after?: string };
    next?: string;
  };
  error?: { message?: string };
}

export interface FacebookSyncResult {
  profile: number;
  posts: number;
  photos: number;
  feedPages: number;
  photoPages: number;
  since: string;
}

type Ingest = (
  sql: postgres.Sql,
  input: IngestExternalTriggerInput,
) => Promise<IngestExternalTriggerResult>;

export interface FacebookSyncDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
  ingest?: Ingest;
  createPersonalSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
  ) => Promise<PersonalVaultExternalSink>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

export class FacebookGraphApiError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    detail?: string,
  ) {
    super('facebook_graph_' + operation + '_' + status + (detail ? ':' + detail : ''));
    this.name = 'FacebookGraphApiError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function appendDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

export function facebookPersonalVaultOAuthField(credentialRef: string | null): string {
  const prefix = FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN + ':';
  if (!credentialRef || !credentialRef.startsWith(prefix)) {
    throw new Error('facebook_personal_vault_credential_ref_invalid');
  }
  const field = credentialRef.slice(prefix.length);
  if (!OAUTH_FIELD.test(field)) throw new Error('facebook_personal_vault_credential_ref_invalid');
  return field;
}

export function facebookPersonalVaultCredentialRef(field: string): string {
  if (!OAUTH_FIELD.test(field)) throw new Error('facebook_personal_vault_oauth_field_invalid');
  return FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN + ':' + field;
}

export function assertFacebookPersonalVaultOwnerUserId(ownerUserId: string | undefined): string {
  const normalized = ownerUserId?.trim() ?? '';
  if (!UUID.test(normalized)) throw new Error('facebook_personal_vault_owner_user_id_invalid');
  return normalized;
}

export async function resolveFacebookPersonalVaultAccessToken(
  source: ExternalTriggerSourceRow,
  installSlug: string,
): Promise<string> {
  const field = facebookPersonalVaultOAuthField(source.credentialRef);
  if (!getProvider('facebook')) await loadAndRegisterProvidersFromDisk();
  const token = await getOAuthToken({
    plugin: FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
    harness: installSlug,
    storage: fsTokenStorage,
    resolveProvider: (candidate) => candidate === field ? { provider: 'facebook' } : null,
  }, field);
  if (!token) throw new Error('facebook_personal_vault_oauth_not_connected:' + field);
  return token;
}

export async function provisionOwnedFacebookPersonalVaultSource(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    providerAccountId: string;
    displayName?: string;
    field: string;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerSourceRow> {
  const ownerUserId = assertFacebookPersonalVaultOwnerUserId(input.ownerUserId);
  const providerAccountId = nonEmpty(input.providerAccountId);
  if (!providerAccountId) throw new Error('facebook_personal_vault_provider_account_id_required');
  return upsertOwnedExternalTriggerSource(sql, {
    workspaceId: input.workspaceId,
    kind: 'facebook',
    ownerUserId,
    providerAccountId,
    credentialRef: facebookPersonalVaultCredentialRef(input.field),
    status: 'connected',
    config: {
      coverage: ['profile', 'posts', 'photo-metadata'],
      ...(nonEmpty(input.displayName) ? { displayName: nonEmpty(input.displayName) } : {}),
    },
    createdBy: input.createdBy ?? 'owner:' + ownerUserId,
  });
}

export function normalizeFacebookProfile(profile: FacebookProfile): Record<string, unknown> {
  const id = nonEmpty(profile.id);
  if (!id) throw new Error('facebook_profile_id_required');
  const name = nonEmpty(profile.name) ?? id;
  const normalized: Record<string, unknown> = {
    id,
    author: name,
    text: nonEmpty(profile.about) ?? name,
    entityType: 'profile',
  };
  appendDefined(normalized, 'url', profile.link);
  appendDefined(normalized, 'picture', profile.picture);
  return normalized;
}

export function normalizeFacebookPost(post: FacebookPost): Record<string, unknown> {
  const id = nonEmpty(post.id);
  if (!id) throw new Error('facebook_post_id_required');
  const normalized: Record<string, unknown> = {
    id,
    text: nonEmpty(post.message) ?? nonEmpty(post.story) ?? '(Facebook post)',
    entityType: 'post',
  };
  appendDefined(normalized, 'author', post.from?.name ?? post.from?.id);
  appendDefined(normalized, 'url', post.permalink_url);
  appendDefined(normalized, 'occurredAt', post.created_time);
  appendDefined(normalized, 'updatedAt', post.updated_time);
  if (post.attachments?.data?.length) normalized.media = post.attachments.data;
  return normalized;
}

export function normalizeFacebookPhoto(photo: FacebookPhoto): Record<string, unknown> {
  const id = nonEmpty(photo.id);
  if (!id) throw new Error('facebook_photo_id_required');
  const media = photo.images?.length
    ? photo.images
    : photo.picture
      ? [{ url: photo.picture }]
      : [];
  const normalized: Record<string, unknown> = {
    id,
    text: nonEmpty(photo.name) ?? '(Facebook photo)',
    entityType: 'photo',
    media,
  };
  appendDefined(normalized, 'author', photo.from?.name ?? photo.from?.id);
  appendDefined(normalized, 'url', photo.link);
  appendDefined(normalized, 'occurredAt', photo.created_time);
  appendDefined(normalized, 'updatedAt', photo.updated_time);
  return normalized;
}

function assertSource(source: ExternalTriggerSourceRow, accessToken: string): void {
  if (source.kind !== 'facebook') {
    throw new Error('facebook_personal_vault_source_kind_mismatch:' + source.kind);
  }
  if (!source.ownerUserId) throw new Error('external_trigger_source_owner_required:' + source.id);
  if (!accessToken.trim()) throw new Error('facebook_personal_vault_access_token_required');
}

function sourceSince(source: ExternalTriggerSourceRow): string | null {
  return nonEmpty(source.cursor.since) ?? nonEmpty(source.cursor.lastSyncAt) ?? nonEmpty(source.cursor.last_sync_at);
}

function entityVersion(entity: Record<string, unknown>): string {
  return nonEmpty(entity.updated_time)
    ?? nonEmpty(entity.created_time)
    ?? createHash('sha256').update(JSON.stringify(entity)).digest('hex').slice(0, 24);
}

async function parseResponse<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 500) } };
    }
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object'
      ? nonEmpty((body as { error?: { message?: unknown } }).error?.message)
      : null;
    throw new FacebookGraphApiError(response.status, operation, detail ?? undefined);
  }
  return body as T;
}

async function graphGet<T>(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  path: string,
  operation: string,
  params: Record<string, string | null>,
): Promise<T> {
  const url = new URL(path, apiOrigin);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, {
    headers: {
      authorization: 'Bearer ' + accessToken,
      accept: 'application/json',
    },
  });
  return parseResponse<T>(response, operation);
}

/** Resolve the provider-native identity before assigning a durable source account. */
export async function resolveFacebookPersonalVaultProviderAccount(
  accessToken: string,
  provided: Pick<FacebookSyncDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<FacebookProviderAccount> {
  if (!accessToken.trim()) throw new Error('facebook_personal_vault_access_token_required');
  const profile = await graphGet<FacebookProfile>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? FACEBOOK_GRAPH_ORIGIN).replace(/\/$/, ''),
    accessToken,
    '/me',
    'profile_identity',
    { fields: 'id,name' },
  );
  const providerAccountId = nonEmpty(profile.id);
  if (!providerAccountId) throw new Error('facebook_personal_vault_provider_account_id_required');
  return {
    providerAccountId,
    displayName: nonEmpty(profile.name) ?? providerAccountId,
  };
}

async function deliver(
  sql: postgres.Sql,
  ingest: Ingest,
  sink: PersonalVaultExternalSink,
  source: ExternalTriggerSourceRow,
  entity: Record<string, unknown>,
  entityType: 'profile' | 'post' | 'photo',
  normalize: (value: never) => Record<string, unknown>,
): Promise<void> {
  const id = nonEmpty(entity.id);
  if (!id) throw new Error('facebook_' + entityType + '_id_required');
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: 'facebook',
    event: entityType + '.synced',
    externalId: id,
    datatypeId: 'social-post',
    adapterPayload: entity,
    normalize: (payload) => normalize(payload as never),
    occurredAt: nonEmpty(entity.created_time) ?? nonEmpty(entity.updated_time),
    dedupeKey: 'facebook:' + entityType + ':' + id + ':' + entityVersion(entity),
    additionalSinks: [sink],
  });
  if (!result.ok) throw new Error('facebook_delivery_failed:' + entityType + ':' + id);
}

async function syncConnection<T extends Record<string, unknown>>(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sink: PersonalVaultExternalSink,
  deps: Required<Pick<FacebookSyncDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  input: {
    path: '/me/feed' | '/me/photos';
    operation: 'feed_list' | 'photos_list';
    fields: string;
    since: string | null;
    entityType: 'post' | 'photo';
    normalize: (value: never) => Record<string, unknown>;
  },
): Promise<{ entities: number; pages: number }> {
  let after: string | null = null;
  let entities = 0;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Error('facebook_page_limit_exceeded:' + input.entityType);
    const sinceMs = input.since ? Date.parse(input.since) : NaN;
    const body = await graphGet<FacebookConnection<T>>(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      input.path,
      input.operation,
      {
        fields: input.fields,
        limit: '100',
        since: Number.isFinite(sinceMs) ? String(Math.floor(sinceMs / 1000)) : null,
        after,
      },
    );
    for (const entity of body.data ?? []) {
      await deliver(sql, deps.ingest, sink, source, entity, input.entityType, input.normalize);
      entities += 1;
    }
    const nextAfter = nonEmpty(body.paging?.cursors?.after);
    if (!nextAfter && body.paging?.next) {
      throw new Error('facebook_paging_cursor_missing:' + input.entityType);
    }
    after = nextAfter;
  } while (after);
  return { entities, pages };
}

/**
 * Sync one owned source. The durable `since` cursor advances only after the
 * profile, feed, photo pages, event bus, binding sink, and private-vault sink
 * all succeed. A partial retry therefore replays safely through the delivery
 * ledger instead of skipping provider records.
 */
export async function syncFacebookPersonalVaultSource(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  provided: FacebookSyncDeps = {},
): Promise<FacebookSyncResult> {
  assertSource(source, accessToken);
  const deps = {
    fetch: provided.fetch ?? fetch,
    apiOrigin: (provided.apiOrigin ?? FACEBOOK_GRAPH_ORIGIN).replace(/\/$/, ''),
    ingest: provided.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)),
  };
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const createSink = provided.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const sink = await createSink(sql, source.workspaceId, source.id);
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('facebook_personal_vault_now_invalid');
  const since = sourceSince(source);

  const profile = await graphGet<FacebookProfile>(
    deps.fetch,
    deps.apiOrigin,
    accessToken,
    '/me',
    'profile_get',
    { fields: 'id,name,link,about,picture' },
  );
  await deliver(
    sql,
    deps.ingest,
    sink,
    source,
    profile,
    'profile',
    normalizeFacebookProfile as (value: never) => Record<string, unknown>,
  );

  const feed = await syncConnection<FacebookPost>(sql, source, accessToken, sink, deps, {
    path: '/me/feed',
    operation: 'feed_list',
    fields: 'id,message,story,created_time,updated_time,permalink_url,from,attachments',
    since,
    entityType: 'post',
    normalize: normalizeFacebookPost as (value: never) => Record<string, unknown>,
  });
  const photos = await syncConnection<FacebookPhoto>(sql, source, accessToken, sink, deps, {
    path: '/me/photos',
    operation: 'photos_list',
    fields: 'id,name,created_time,updated_time,link,picture,images,from',
    since,
    entityType: 'photo',
    normalize: normalizeFacebookPhoto as (value: never) => Record<string, unknown>,
  });

  const nextSince = now.toISOString();
  await updateSource(sql, source.workspaceId, source.id, {
    status: 'connected',
    cursor: {
      ...source.cursor,
      since: nextSince,
      lastSyncAt: nextSince,
      profileId: nonEmpty(profile.id),
    },
    lastError: null,
    connected: true,
  });
  return {
    profile: 1,
    posts: feed.entities,
    photos: photos.entities,
    feedPages: feed.pages,
    photoPages: photos.pages,
    since: nextSince,
  };
}
