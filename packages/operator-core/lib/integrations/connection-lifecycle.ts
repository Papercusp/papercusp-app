/**
 * Provider-neutral connection lifecycle (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05, P-003; D-003 / D-006).
 *
 * The OAuth start and callback routes used to branch on provider names. They
 * now resolve a {@link ConnectionAdapter} for the verified `plugin` and run
 * one generic lifecycle:
 *
 *   owner assert -> code exchange -> account identity -> reconnect guard
 *   -> already-connected guard -> refresh-token guard -> token write
 *   -> source provisioning -> superseded-credential cleanup.
 *
 * Adapters come from two places:
 *   - first-party adapters registered in code (Google Workspace, Facebook);
 *   - descriptor adapters derived on demand from every provider in the
 *     provider registry that declares `oauth`. Providers sharing a
 *     `credentialGroup` share ONE credential, stored under the plugin
 *     `provider:<group>`, and get one source row each.
 *
 * Tokens never reach provider code: the host resolves the account identity
 * from the descriptor's `oauth.identity` endpoint with the fresh access token
 * (D-006). Reconnect never arms a trigger binding (D-003).
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type postgres from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import { providerEgressAllows, type ProviderDescriptor } from '@papercusp/plugin-sdk';
import { getProvider, loadAndRegisterProvidersFromDisk, type OAuthProvider, type TokenResponse } from '../oauth/providers';
import { operatorApiBase } from '../operator-api-base';
import type { OAuthFlowPrivateContext } from '../oauth/state';
import { fsTokenStorage } from '../oauth/storage-fs';
import { papercuspPath } from '../papercusp-root';
import {
  disconnectOwnedExternalTriggerSources,
  listOwnedExternalTriggerSources,
  markExternalTriggerSourcesReconnectRequired,
  renameOwnedExternalTriggerSourceAccount,
  upsertOwnedExternalTriggerSource,
  type OwnedExternalTriggerSourceRow,
} from '../external-triggers/source-store';
import { providerRegistry, type RegisteredProvider } from './provider-registry';

export interface ConnectionOwner {
  ownerUserId: string;
  workspaceId: string;
  /** Set on a targeted reconnect; null on an add-account flow. */
  reconnectProviderAccountId: string | null;
}

export interface ConnectionAccount {
  providerAccountId: string;
  displayName?: string;
}

export interface ConnectionProvisionInput {
  owner: ConnectionOwner;
  account: ConnectionAccount;
  field: string;
  createdBy: string;
}

export interface ConnectionAdapter {
  /** Token-store plugin the credential is written under (also the credentialRef prefix). */
  oauthPlugin: string;
  /** OAuth provider id the authorize/exchange flow uses. */
  oauthProviderId: string;
  /** Prefix for named lifecycle errors, e.g. `google_workspace` -> `google_workspace_account_mismatch`. */
  errorPrefix: string;
  /** Where the browser returns after consent. */
  returnPath: string;
  /** data_sources kinds this connection provisions. */
  sourceKinds: readonly string[];
  /** `union`: provider defaults plus caller scopes (scope upgrade); `defaults-only`: ignore caller scopes. */
  scopePolicy: 'union' | 'defaults-only';
  /** Record the requested scopes in the flow context, used when the token response omits them. */
  recordRequestedScopes: boolean;
  /** True when a first connect without a refresh token would silently die. */
  requiresRefreshToken(tokens: TokenResponse): boolean;
  assertOwnerUserId(value: string | undefined): string;
  /** OAuth field from a stored credentialRef (`<oauthPlugin>:<field>`). */
  oauthField(credentialRef: string | null): string;
  resolveAccount(accessToken: string): Promise<ConnectionAccount>;
  /**
   * Credential fields already connected for this account. `reconciled` means a
   * legacy/provisional row was adopted in place, which is not a duplicate.
   */
  previousFields(
    sql: postgres.Sql,
    owner: ConnectionOwner,
    account: ConnectionAccount,
  ): Promise<{ fields: string[]; reconciled: boolean }>;
  provision(sql: postgres.Sql, input: ConnectionProvisionInput): Promise<void>;
}

export type ConnectionRefusal = { refusal: string };
export type PreparedConnection = { account: ConnectionAccount; previousFields: string[] };

const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESCRIPTOR_OAUTH_PLUGIN_PREFIX = 'provider:';

const state = pinModuleState('@papercusp/operator-core.integrations.connection-lifecycle', () => ({
  adapters: new Map<string, ConnectionAdapter>(),
}));

/** Register a first-party adapter. Re-registering the same plugin replaces it. */
export function registerConnectionAdapter(adapter: ConnectionAdapter): void {
  state.adapters.set(adapter.oauthPlugin, adapter);
}

/** Adapter for a token-store plugin, first-party or descriptor-derived. */
export function connectionAdapterForPlugin(plugin: string): ConnectionAdapter | null {
  return state.adapters.get(plugin) ?? descriptorConnectionAdapter(plugin);
}

/** Adapter for a verified (plugin, provider) pair; null when the pair is not a managed connection. */
export function connectionAdapterFor(plugin: string, providerId: string): ConnectionAdapter | null {
  const adapter = connectionAdapterForPlugin(plugin);
  return adapter && adapter.oauthProviderId === providerId ? adapter : null;
}

/** Field-keyed credentialRef. */
export function connectionCredentialRef(adapter: Pick<ConnectionAdapter, 'oauthPlugin'>, field: string): string {
  return `${adapter.oauthPlugin}:${field}`;
}

/** Fields of sources already holding a credential for this account (the common case). */
export async function defaultPreviousFields(
  sql: postgres.Sql,
  adapter: ConnectionAdapter,
  owner: ConnectionOwner,
  account: ConnectionAccount,
): Promise<{ fields: string[]; reconciled: boolean }> {
  const owned = await listOwnedExternalTriggerSources(sql, owner.workspaceId, owner.ownerUserId);
  return { fields: fieldsForAccount(adapter, owned, account.providerAccountId), reconciled: false };
}

function fieldsForAccount(
  adapter: ConnectionAdapter,
  owned: OwnedExternalTriggerSourceRow[],
  providerAccountId: string,
): string[] {
  const prefix = `${adapter.oauthPlugin}:`;
  return [
    ...new Set(
      owned
        .filter(
          (source) =>
            adapter.sourceKinds.includes(source.kind) &&
            source.providerAccountId === providerAccountId &&
            source.credentialRef?.startsWith(prefix),
        )
        .map((source) => adapter.oauthField(source.credentialRef)),
    ),
  ];
}

/** Owner from the server-held flow context; throws a named error when it is missing or malformed. */
export function resolveConnectionOwner(
  adapter: ConnectionAdapter,
  privateContext: Readonly<Record<string, string>> | undefined,
): ConnectionOwner {
  const ownerUserId = adapter.assertOwnerUserId(privateContext?.ownerUserId);
  const workspaceId = privateContext?.workspaceId?.trim() ?? '';
  if (!workspaceId) throw new Error(`${adapter.errorPrefix}_workspace_id_required`);
  return {
    ownerUserId,
    workspaceId,
    reconnectProviderAccountId: privateContext?.reconnectProviderAccountId?.trim() || null,
  };
}

/**
 * Identify the consented account and apply the reconnect and duplicate guards.
 * A targeted reconnect that authenticates a different account is refused,
 * except that a provisional/legacy account id is adopted in place.
 */
export async function prepareConnection(
  sql: postgres.Sql,
  adapter: ConnectionAdapter,
  owner: ConnectionOwner,
  accessToken: string,
): Promise<PreparedConnection | ConnectionRefusal> {
  const account = await adapter.resolveAccount(accessToken);
  const expected = owner.reconnectProviderAccountId;
  if (expected && expected !== account.providerAccountId) {
    const provisional = expected.startsWith(`${adapter.oauthPlugin}:`) || expected.startsWith('legacy-owner:');
    if (!provisional) return { refusal: `${adapter.errorPrefix}_account_mismatch` };
    await renameOwnedExternalTriggerSourceAccount(sql, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.ownerUserId,
      previousProviderAccountId: expected,
      providerAccountId: account.providerAccountId,
    });
  }
  const previous = await adapter.previousFields(sql, owner, account);
  // An add-account flow carries no `expected` account, so the mismatch guard
  // cannot see a consent that came back with an account that is already
  // connected. Writing it under the freshly allocated field would create a
  // second credential slot for the same account; refuse instead.
  if (!expected && previous.fields.length > 0 && !previous.reconciled) {
    return { refusal: `${adapter.errorPrefix}_account_already_connected` };
  }
  return { account, previousFields: previous.fields };
}

/** Named refusal when a brand-new account slot arrives without a refresh token it needs. */
export function missingRefreshTokenRefusal(
  adapter: ConnectionAdapter,
  owner: ConnectionOwner,
  previousFields: readonly string[],
  tokens: TokenResponse,
): string | null {
  if (owner.reconnectProviderAccountId || previousFields.length > 0 || tokens.refreshToken) return null;
  return adapter.requiresRefreshToken(tokens) ? `${adapter.errorPrefix}_refresh_token_missing` : null;
}

/** Provision the account's sources, then retire credential fields the new grant superseded. */
export async function finishConnection(
  sql: postgres.Sql,
  adapter: ConnectionAdapter,
  input: ConnectionProvisionInput & { harness: string; previousFields: readonly string[] },
): Promise<void> {
  await adapter.provision(sql, input);
  for (const previousField of input.previousFields) {
    if (previousField === input.field) continue;
    await fsTokenStorage.update(adapter.oauthPlugin, input.harness, {
      [previousField]: null,
      [previousField + '_refresh']: null,
      [previousField + '_expires_at']: null,
      [previousField + '_scopes']: null,
      [previousField + '_expired']: true,
    });
  }
}

/**
 * Disconnect one account: its sources stop syncing (status `disabled`) and its
 * tokens are cleared, but source ids, cursors and synced data are kept so a
 * later reconnect resumes where it stopped.
 */
export async function disconnectConnection(
  sql: postgres.Sql,
  adapter: ConnectionAdapter,
  input: { workspaceId: string; ownerUserId: string; providerAccountId: string; harness: string },
): Promise<{ sources: number; clearedFields: string[] }> {
  const result = await disconnectOwnedExternalTriggerSources(
    sql,
    input.workspaceId,
    input.ownerUserId,
    [...adapter.sourceKinds],
    input.providerAccountId,
  );
  const prefix = `${adapter.oauthPlugin}:`;
  const clearedFields = result.credentialRefs
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => adapter.oauthField(ref));
  for (const field of clearedFields) {
    await fsTokenStorage.update(adapter.oauthPlugin, input.harness, {
      [field]: null,
      [field + '_refresh']: null,
      [field + '_expires_at']: null,
      [field + '_expired']: true,
    });
  }
  return { sources: result.sources, clearedFields };
}

export class ConnectionRefreshRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionRefreshRevokedError';
  }
}

/** True when a refresh failure means the grant is gone and only the owner can restore it. */
export function isRevokedGrantError(cause: unknown): boolean {
  if (cause instanceof ConnectionRefreshRevokedError) return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\binvalid_grant\b|\brevoked\b|\bunauthorized_client\b/i.test(message);
}

/**
 * Refresh one stored credential. A revoked or expired grant does not leave the
 * sources looking connected: every source on that credential moves to
 * `reconnect_required` (sync stops, data kept) and the token is marked expired.
 */
export async function refreshConnectionCredential(
  sql: postgres.Sql,
  adapter: ConnectionAdapter,
  input: { workspaceId: string; harness: string; field: string },
): Promise<{ ok: true; accessToken: string } | { ok: false; reconnectRequired: true; reason: string }> {
  const provider = await resolveOAuthProvider(adapter.oauthProviderId);
  if (!provider) throw new Error(`${adapter.errorPrefix}_oauth_provider_not_registered`);
  const stored = await fsTokenStorage.read(adapter.oauthPlugin, input.harness);
  const refreshToken = stored[`${input.field}_refresh`];
  const credentialRef = connectionCredentialRef(adapter, input.field);
  const requireReconnect = async (reason: string) => {
    await markExternalTriggerSourcesReconnectRequired(sql, input.workspaceId, credentialRef, reason);
    await fsTokenStorage.update(adapter.oauthPlugin, input.harness, { [`${input.field}_expired`]: true });
    return { ok: false as const, reconnectRequired: true as const, reason };
  };
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return requireReconnect(`${adapter.errorPrefix}_refresh_token_missing`);
  }
  let tokens: TokenResponse;
  try {
    tokens = await provider.refresh(refreshToken);
  } catch (error) {
    if (!isRevokedGrantError(error)) throw error;
    return requireReconnect(error instanceof Error ? error.message : String(error));
  }
  const patch: Record<string, unknown> = { [input.field]: tokens.accessToken, [`${input.field}_expired`]: false };
  if (tokens.refreshToken) patch[`${input.field}_refresh`] = tokens.refreshToken;
  if (tokens.expiresAt !== undefined) patch[`${input.field}_expires_at`] = tokens.expiresAt;
  await fsTokenStorage.update(adapter.oauthPlugin, input.harness, patch);
  return { ok: true, accessToken: tokens.accessToken };
}

/** Refresh an access token this many ms before its recorded expiry. */
const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * The access token for exactly one descriptor-provisioned source's account
 * (P-004 / D-006): the host-side half of `host.fetch`. Returns null for a
 * source that holds no descriptor credential (a provider that needs no grant).
 * A stored token is reused until shortly before its expiry, then refreshed
 * through {@link refreshConnectionCredential}; a revoked or missing refresh
 * grant marks the source reconnect-required and returns `{ reconnectRequired }`
 * so the sync driver can stop retrying until the owner reconnects.
 */
export async function connectionAccessToken(
  sql: postgres.Sql,
  input: { workspaceId: string; harness: string; credentialRef: string | null; now?: number },
): Promise<{ accessToken: string | null } | { reconnectRequired: true; reason: string }> {
  const ref = input.credentialRef;
  if (!ref) return { accessToken: null };
  // A credential ref is `<token-store plugin>:<field>`. Descriptor plugins are
  // themselves `provider:<group>`; first-party adapters (google-workspace,
  // whose refs existing Gmail and Calendar sources carry) use a bare plugin id.
  const descriptorRef = ref.startsWith(DESCRIPTOR_OAUTH_PLUGIN_PREFIX);
  const fieldSeparator = ref.indexOf(':', descriptorRef ? DESCRIPTOR_OAUTH_PLUGIN_PREFIX.length : 0);
  if (fieldSeparator < 0) {
    return descriptorRef ? { reconnectRequired: true, reason: `connection_credential_ref_invalid:${ref}` } : { accessToken: null };
  }
  const plugin = ref.slice(0, fieldSeparator);
  const adapter = connectionAdapterForPlugin(plugin);
  if (!adapter) {
    return descriptorRef ? { reconnectRequired: true, reason: `connection_provider_not_registered:${plugin}` } : { accessToken: null };
  }
  const field = adapter.oauthField(ref);
  const stored = await fsTokenStorage.read(plugin, input.harness);
  const token = stored[field];
  const expiresAt = stored[`${field}_expires_at`];
  const now = input.now ?? Date.now();
  const fresh = typeof expiresAt !== 'number' || expiresAt - ACCESS_TOKEN_SKEW_MS > now;
  if (typeof token === 'string' && token && stored[`${field}_expired`] !== true && fresh) {
    return { accessToken: token };
  }
  const refreshed = await refreshConnectionCredential(sql, adapter, {
    workspaceId: input.workspaceId,
    harness: input.harness,
    field,
  });
  return refreshed.ok ? { accessToken: refreshed.accessToken } : { reconnectRequired: true, reason: refreshed.reason };
}

/* ─── Descriptor-derived connections ─── */

function credentialGroupOf(descriptor: ProviderDescriptor): string {
  return descriptor.oauth?.credentialGroup ?? descriptor.id;
}

/** Token-store plugin for a descriptor provider's (possibly shared) credential. */
export function descriptorOAuthPlugin(descriptor: ProviderDescriptor): string {
  return `${DESCRIPTOR_OAUTH_PLUGIN_PREFIX}${credentialGroupOf(descriptor)}`;
}

function descriptorGroupMembers(plugin: string): RegisteredProvider[] {
  if (!plugin.startsWith(DESCRIPTOR_OAUTH_PLUGIN_PREFIX)) return [];
  const group = plugin.slice(DESCRIPTOR_OAUTH_PLUGIN_PREFIX.length);
  return providerRegistry()
    .list()
    .filter((entry) => entry.descriptor.oauth && credentialGroupOf(entry.descriptor) === group)
    .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
}

function readJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Account identity from the descriptor's identity endpoint, fetched by the host with the fresh token. */
async function resolveDescriptorAccount(
  members: RegisteredProvider[],
  errorPrefix: string,
  accessToken: string,
): Promise<ConnectionAccount> {
  const holder = members.find((entry) => entry.descriptor.oauth?.identity);
  const identity = holder?.descriptor.oauth?.identity;
  if (!holder || !identity) throw new Error(`${errorPrefix}_identity_endpoint_missing`);
  const url = new URL(identity.url);
  if (url.protocol !== 'https:' || !providerEgressAllows(holder.descriptor.egressHosts, url.hostname)) {
    throw new Error(`${errorPrefix}_identity_endpoint_not_allowed`);
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${errorPrefix}_identity_${response.status}`);
  const body = (await response.json()) as unknown;
  const id = readJsonPath(body, identity.idField);
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
    throw new Error(`${errorPrefix}_identity_unavailable`);
  }
  const display = identity.displayNameField ? readJsonPath(body, identity.displayNameField) : undefined;
  return {
    providerAccountId: String(id).trim(),
    ...(typeof display === 'string' && display.trim() ? { displayName: display.trim() } : {}),
  };
}

/** Adapter for a `provider:<group>` plugin built from the registered descriptors in that group. */
export function descriptorConnectionAdapter(plugin: string): ConnectionAdapter | null {
  const members = descriptorGroupMembers(plugin);
  if (members.length === 0) return null;
  const group = plugin.slice(DESCRIPTOR_OAUTH_PLUGIN_PREFIX.length);
  const errorPrefix = `provider_${group.replace(/[^a-z0-9]+/g, '_')}`;
  const prefix = `${plugin}:`;
  const adapter: ConnectionAdapter = {
    oauthPlugin: plugin,
    oauthProviderId: plugin,
    errorPrefix,
    returnPath: '/settings/personal-vault',
    sourceKinds: members.map((entry) => entry.descriptor.id),
    scopePolicy: 'union',
    recordRequestedScopes: true,
    requiresRefreshToken: (tokens) => tokens.expiresAt !== undefined,
    assertOwnerUserId(value) {
      const normalized = value?.trim() ?? '';
      if (!OWNER_UUID.test(normalized)) throw new Error(`${errorPrefix}_owner_user_id_invalid`);
      return normalized;
    },
    oauthField(credentialRef) {
      if (!credentialRef?.startsWith(prefix)) throw new Error(`${errorPrefix}_credential_ref_invalid`);
      return credentialRef.slice(prefix.length);
    },
    resolveAccount: (accessToken) => resolveDescriptorAccount(members, errorPrefix, accessToken),
    previousFields: (sql, owner, account) => defaultPreviousFields(sql, adapter, owner, account),
    async provision(sql, input) {
      // One credential per group: every provider in the group gets its own
      // source row pointing at the same credentialRef.
      for (const entry of members) {
        await upsertOwnedExternalTriggerSource(sql, {
          workspaceId: input.owner.workspaceId,
          kind: entry.descriptor.id,
          ownerUserId: input.owner.ownerUserId,
          providerAccountId: input.account.providerAccountId,
          credentialRef: connectionCredentialRef(adapter, input.field),
          status: 'connected',
          ...(input.account.displayName ? { config: { accountLabel: input.account.displayName } } : {}),
          createdBy: input.createdBy,
        });
      }
    },
  };
  return adapter;
}

interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientSecretFile?: string;
  redirectUri?: string;
}

async function readClientRegistration(ref: string): Promise<ClientRegistration | null> {
  let parsed: Record<string, ClientRegistration>;
  try {
    parsed = JSON.parse(await fs.readFile(papercuspPath('oauth-apps.json'), 'utf8')) as Record<string, ClientRegistration>;
  } catch {
    return null;
  }
  const entry = parsed?.[ref];
  return entry && typeof entry.clientId === 'string' && entry.clientId ? entry : null;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenResponseFrom(body: Record<string, unknown>, fallbackRefresh?: string): TokenResponse {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (!accessToken) throw new Error(`oauth token response missing access_token${body.error ? `: ${String(body.error)}` : ''}`);
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : fallbackRefresh;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(scope ? { scopes: scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

/** Standard authorization-code OAuth provider for a descriptor (optional PKCE). */
export function makeDescriptorOAuthProvider(
  id: string,
  oauth: NonNullable<ProviderDescriptor['oauth']>,
  client: { clientId: string; clientSecret?: string; redirectUri: string },
): OAuthProvider {
  const postToken = async (form: Record<string, string>, fallbackRefresh?: string): Promise<TokenResponse> => {
    const response = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        ...form,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body.error) {
      const code = typeof body.error === 'string' ? body.error : String(response.status);
      throw new Error(`${id} token endpoint ${response.status}: ${code}`);
    }
    return tokenResponseFrom(body, fallbackRefresh);
  };
  return {
    id,
    config: {
      clientId: client.clientId,
      clientSecret: client.clientSecret ?? '',
      authorizeUrl: oauth.authorizeUrl,
      tokenUrl: oauth.tokenUrl,
      redirectUri: client.redirectUri,
    },
    defaultScopes: oauth.scopes,
    allowedScopes: oauth.scopes,
    createFlowContext(): OAuthFlowPrivateContext {
      return oauth.pkce ? { codeVerifier: base64Url(randomBytes(48)) } : {};
    },
    buildAuthorizeUrl(scopes, stateToken, privateContext?: OAuthFlowPrivateContext) {
      const url = new URL(oauth.authorizeUrl);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', client.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', stateToken);
      if (oauth.pkce) {
        const verifier = privateContext?.codeVerifier;
        if (!verifier) throw new Error(`${id} pkce verifier missing from flow context`);
        url.searchParams.set('code_challenge', base64Url(createHash('sha256').update(verifier).digest()));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    exchangeCode(code, privateContext?: OAuthFlowPrivateContext) {
      const verifier = privateContext?.codeVerifier;
      if (oauth.pkce && !verifier) throw new Error(`${id} pkce verifier missing from flow context`);
      return postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: client.redirectUri,
        ...(verifier ? { code_verifier: verifier } : {}),
      });
    },
    refresh(refreshToken) {
      return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
    },
  };
}

/**
 * OAuth provider for an id: a code-registered provider, or (for `provider:<group>`)
 * one built from the group's descriptor plus the host-held client registration
 * in oauth-apps.json under `clientRegistrationRef` (default: the group id).
 */
export async function resolveOAuthProvider(providerId: string): Promise<OAuthProvider | null> {
  const registered = getProvider(providerId);
  if (registered) return registered;
  if (!providerId.startsWith(DESCRIPTOR_OAUTH_PLUGIN_PREFIX)) {
    // Code-registered providers (google, facebook, github) come from host-held
    // client files. Load them here instead of relying on an OAuth route having
    // run first in this process: the connector sync driver refreshes tokens in
    // a process that may never serve one (WI-10006541).
    await loadAndRegisterProvidersFromDisk();
    return getProvider(providerId);
  }
  const members = descriptorGroupMembers(providerId);
  const lead = members[0]?.descriptor;
  if (!lead?.oauth) return null;
  const group = providerId.slice(DESCRIPTOR_OAUTH_PLUGIN_PREFIX.length);
  const client = await readClientRegistration(lead.oauth.clientRegistrationRef ?? group);
  if (!client) return null;
  let clientSecret = client.clientSecret;
  if (!clientSecret && client.clientSecretFile) {
    clientSecret = (await fs.readFile(client.clientSecretFile, 'utf8')).trim();
  }
  const scopes = [...new Set(members.flatMap((entry) => entry.descriptor.oauth?.scopes ?? []))];
  // Default to the operator's one provider-neutral OAuth callback; a provider that
  // needs another redirect declares it in its client registration.
  const redirectUri = client.redirectUri ?? new URL('/api/oauth/callback', operatorApiBase()).toString();
  return makeDescriptorOAuthProvider(providerId, { ...lead.oauth, scopes }, { clientId: client.clientId, clientSecret, redirectUri });
}

/** Scopes to request for a managed connection, per the adapter's policy. */
export function connectionScopes(
  adapter: ConnectionAdapter,
  provider: Pick<OAuthProvider, 'defaultScopes'>,
  requested: readonly string[],
): string[] {
  const defaults = [...(provider.defaultScopes ?? [])];
  return adapter.scopePolicy === 'defaults-only' ? defaults : [...new Set([...defaults, ...requested])];
}
