/**
 * The PORTAL half of MCP OAuth (external-app-access-to-workspaces-2026-09-29 P-325; D-019, D-021).
 *
 * An MCP client given `https://<portal>/api/workspaces/<id>/mcp` (the P-007 relay route) finds an
 * authorization server for THAT workspace here: issuer `https://<portal>/api/workspaces/<id>`,
 * RFC 9728 + RFC 8414 metadata, RFC 7591 registration, authorization code + S256 PKCE.
 *
 * A hosted workspace VM is headless, so consent is given on the portal by the signed-in account
 * that can reach the workspace (its organization owns it, and it holds `workspace:operate`). The
 * consent screen names the workspace and the scope, and the approver may only NARROW it.
 *
 * The access token is a connected-app key MINTED ON THE MACHINE over the connector relay (channel
 * kind `app-key-mint`), so the machine keeps checking it on every call (D-017). The portal stores
 * clients and requests (migration 1260) — never a key: it relays the one token response and keeps
 * nothing of it. An offline workspace gets a clear error at once and nothing is held (D-008).
 *
 * Every rule a token is minted under is shared with the local server (P-006, ./mcp-oauth.ts):
 * registration validation, scope strings, PKCE, client authentication and code shapes.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { parseAppKey } from './key';
import {
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CODE_TTL_MS,
  OAUTH_NO_STORE,
  OAUTH_REQUEST_TTL_MS,
  OAuthScopeError,
  clientSecretMatches,
  formatOAuthScope,
  isAuthorizationCode,
  isRelayableTokenAnswer,
  isRequestHandle,
  isValidCodeChallenge,
  newAuthorizationCode,
  newRequestHandle,
  oauthErrorResponse,
  parseOAuthScope,
  pkceMatches,
  readBasicCredentials,
  readFormOrJson,
  redirectWithParams,
  relayedTokenFields,
  sha256Hex,
  validateRegistration,
  type OAuthClient,
  type OAuthTokenEndpointAuthMethod,
  type RegisteredOAuthClient,
  type RegistrationInput,
} from './mcp-oauth';
import {
  CLIENT_ASSERTION_ALGORITHMS,
  TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
  TOKEN_GRANT_TYPES_SUPPORTED,
  publicOriginOf,
} from './mcp-oauth-discovery';
import type { AppKeyScopes } from './store';
import type { HostedPrincipal } from '../auth/hosted-principal';
import { isHostedConnectorLive } from '../endpoint-route/hosted-workspace-connector';
import type {
  AppRelayConnector,
  AppRelayPort,
  AppRelayServiceRunner,
  AppRelayWorkspace,
} from '../workspace-host/hosted-app-relay';

// ── URLs ─────────────────────────────────────────────────────────────────────────────────────

const WS = '([A-Za-z0-9][A-Za-z0-9_-]{0,127})';
const RESOURCE_METADATA_PATH = new RegExp(`^/\\.well-known/oauth-protected-resource/api/workspaces/${WS}/mcp$`);
/** RFC 8414 §3.1 inserts the issuer path after the well-known segment; some clients append it instead. */
const SERVER_METADATA_PATHS = [
  new RegExp(`^/\\.well-known/oauth-authorization-server/api/workspaces/${WS}$`),
  new RegExp(`^/api/workspaces/${WS}/\\.well-known/oauth-authorization-server$`),
];
const OAUTH_VERB_PATH = new RegExp(`^/api/workspaces/${WS}/oauth/(register|authorize|consent|token)$`);

/** Where a signed-out approver signs in (the plane's hosted auth routes). */
export const PORTAL_SIGN_IN_PATH = '/api/hosted/auth/sign-in';

export const portalIssuer = (origin: string, id: string): string => `${origin}/api/workspaces/${id}`;
export const portalMcpResource = (origin: string, id: string): string => `${origin}/api/workspaces/${id}/mcp`;
export const portalResourceMetadataUrl = (origin: string, id: string): string =>
  `${origin}/.well-known/oauth-protected-resource/api/workspaces/${id}/mcp`;

/** RFC 9728 metadata for a workspace's portal MCP endpoint. */
export function portalProtectedResourceMetadata(origin: string, id: string) {
  return {
    resource: portalMcpResource(origin, id),
    authorization_servers: [portalIssuer(origin, id)],
    bearer_methods_supported: ['header'],
    resource_name: `Papercusp workspace ${id}`,
  };
}

/** RFC 8414 metadata; the issuer is the workspace's path on the portal. */
export function portalAuthorizationServerMetadata(origin: string, id: string) {
  const issuer = portalIssuer(origin, id);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: [...TOKEN_GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGORITHMS],
    authorization_response_iss_parameter_supported: true,
  };
}

// ── store ────────────────────────────────────────────────────────────────────────────────────

export type PortalRequestStatus = 'pending' | 'approved' | 'denied' | 'redeeming' | 'consumed';

export interface PortalOAuthRequest {
  readonly handleHash: string;
  readonly clientId: string;
  readonly workspace: AppRelayWorkspace;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly resource: string | null;
  readonly requestedScopes: AppKeyScopes;
  readonly grantedScopes: AppKeyScopes | null;
  readonly status: PortalRequestStatus;
  readonly approvedBy: string | null;
  readonly codeExpiresAt: Date | null;
  readonly expiresAt: Date;
}

export type NewPortalOAuthRequest = Omit<PortalOAuthRequest, 'grantedScopes' | 'status' | 'approvedBy' | 'codeExpiresAt'> & {
  readonly createdAt: Date;
};

export interface PortalOAuthStore {
  registerClient(workspace: AppRelayWorkspace, input: RegistrationInput, now: Date): Promise<RegisteredOAuthClient>;
  getClient(customerWorkspaceId: string, clientId: string): Promise<OAuthClient | null>;
  createRequest(input: NewPortalOAuthRequest): Promise<void>;
  getRequest(customerWorkspaceId: string, handleHash: string): Promise<PortalOAuthRequest | null>;
  /** pending + unexpired → approved (with its one code) or denied; otherwise null. */
  decide(input: {
    customerWorkspaceId: string;
    handleHash: string;
    approved: boolean;
    grantedScopes: AppKeyScopes | null;
    approvedBy: string;
    codeHash: string | null;
    codeExpiresAt: Date | null;
    now: Date;
  }): Promise<PortalOAuthRequest | null>;
  /** approved + unexpired code → redeeming (exactly one caller wins); otherwise null. */
  claimCode(customerWorkspaceId: string, codeHash: string, now: Date): Promise<PortalOAuthRequest | null>;
  /** redeeming → approved: the mint did not happen, so the code may be retried within its TTL. */
  releaseCode(customerWorkspaceId: string, codeHash: string): Promise<void>;
  /** redeeming → consumed: the code is spent. */
  consumeCode(customerWorkspaceId: string, codeHash: string, clientId: string, now: Date): Promise<void>;
}

function newClientId(random: (size: number) => Uint8Array): string {
  return `${OAUTH_CLIENT_ID_PREFIX}${Buffer.from(random(16)).toString('base64url')}`;
}

function newClientSecret(method: OAuthTokenEndpointAuthMethod, random: (size: number) => Uint8Array): string | null {
  return method === 'none' ? null : `pcos_${Buffer.from(random(32)).toString('base64url')}`;
}

/** Tests and hosts without a database. */
export class InMemoryPortalOAuthStore implements PortalOAuthStore {
  readonly clients = new Map<string, OAuthClient & { customerWorkspaceId: string }>();
  readonly requests = new Map<string, PortalOAuthRequest & { codeHash: string | null }>();
  constructor(private readonly random: (size: number) => Uint8Array = nodeRandomBytes) {}

  async registerClient(workspace: AppRelayWorkspace, input: RegistrationInput, now: Date): Promise<RegisteredOAuthClient> {
    const clientSecret = newClientSecret(input.tokenEndpointAuthMethod, this.random);
    const client: OAuthClient = {
      clientId: newClientId(this.random),
      clientName: input.clientName,
      redirectUris: [...input.redirectUris],
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      clientSecretHash: clientSecret ? sha256Hex(clientSecret) : null,
      createdAt: now,
    };
    this.clients.set(client.clientId, { ...client, customerWorkspaceId: workspace.customerWorkspaceId });
    return { client, clientSecret };
  }

  async getClient(customerWorkspaceId: string, clientId: string): Promise<OAuthClient | null> {
    const row = this.clients.get(clientId);
    if (!row || row.customerWorkspaceId !== customerWorkspaceId) return null;
    const { customerWorkspaceId: _ws, ...client } = row;
    return client;
  }

  async createRequest(input: NewPortalOAuthRequest): Promise<void> {
    for (const [key, row] of this.requests) if (row.expiresAt.getTime() < input.createdAt.getTime()) this.requests.delete(key);
    const { createdAt: _created, ...rest } = input;
    this.requests.set(input.handleHash, { ...rest, grantedScopes: null, status: 'pending', approvedBy: null, codeExpiresAt: null, codeHash: null });
  }

  async getRequest(customerWorkspaceId: string, handleHash: string): Promise<PortalOAuthRequest | null> {
    const row = this.requests.get(handleHash);
    return row && row.workspace.customerWorkspaceId === customerWorkspaceId ? row : null;
  }

  async decide(input: Parameters<PortalOAuthStore['decide']>[0]): Promise<PortalOAuthRequest | null> {
    const row = this.requests.get(input.handleHash);
    if (!row || row.workspace.customerWorkspaceId !== input.customerWorkspaceId || row.status !== 'pending') return null;
    if (row.expiresAt.getTime() <= input.now.getTime()) return null;
    const next = {
      ...row,
      status: (input.approved ? 'approved' : 'denied') as PortalRequestStatus,
      grantedScopes: input.approved ? input.grantedScopes : null,
      approvedBy: input.approvedBy,
      codeHash: input.approved ? input.codeHash : null,
      codeExpiresAt: input.approved ? input.codeExpiresAt : null,
    };
    this.requests.set(input.handleHash, next);
    return next;
  }

  private byCode(customerWorkspaceId: string, codeHash: string) {
    for (const row of this.requests.values()) {
      if (row.codeHash === codeHash && row.workspace.customerWorkspaceId === customerWorkspaceId) return row;
    }
    return null;
  }

  async claimCode(customerWorkspaceId: string, codeHash: string, now: Date): Promise<PortalOAuthRequest | null> {
    const row = this.byCode(customerWorkspaceId, codeHash);
    if (!row || row.status !== 'approved' || !row.codeExpiresAt || row.codeExpiresAt.getTime() <= now.getTime()) return null;
    const next = { ...row, status: 'redeeming' as const };
    this.requests.set(row.handleHash, next);
    return next;
  }

  async releaseCode(customerWorkspaceId: string, codeHash: string): Promise<void> {
    const row = this.byCode(customerWorkspaceId, codeHash);
    if (row?.status === 'redeeming') this.requests.set(row.handleHash, { ...row, status: 'approved' });
  }

  async consumeCode(customerWorkspaceId: string, codeHash: string): Promise<void> {
    const row = this.byCode(customerWorkspaceId, codeHash);
    if (row?.status === 'redeeming') this.requests.set(row.handleHash, { ...row, status: 'consumed' });
  }
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: OAuthTokenEndpointAuthMethod;
  client_secret_hash: string | null;
  created_at: Date;
}

interface RequestRow {
  handle_hash: string;
  client_id: string;
  control_workspace_id: string;
  organization_id: string;
  customer_workspace_id: string;
  redirect_uri: string;
  code_challenge: string;
  oauth_state: string | null;
  resource: string | null;
  requested_scopes: AppKeyScopes;
  granted_scopes: AppKeyScopes | null;
  state: PortalRequestStatus;
  approved_by: string | null;
  code_expires_at: Date | null;
  expires_at: Date;
}

const REQUEST_COLUMNS = `handle_hash, client_id, control_workspace_id, organization_id, customer_workspace_id, redirect_uri,
  code_challenge, oauth_state, resource, requested_scopes, granted_scopes, state, approved_by, code_expires_at, expires_at`;

const requestOf = (row: RequestRow): PortalOAuthRequest => ({
  handleHash: row.handle_hash,
  clientId: row.client_id,
  workspace: {
    controlPlaneWorkspaceId: row.control_workspace_id,
    organizationId: row.organization_id,
    customerWorkspaceId: row.customer_workspace_id,
  },
  redirectUri: row.redirect_uri,
  codeChallenge: row.code_challenge,
  state: row.oauth_state,
  resource: row.resource,
  requestedScopes: row.requested_scopes ?? {},
  grantedScopes: row.granted_scopes,
  status: row.state,
  approvedBy: row.approved_by,
  codeExpiresAt: row.code_expires_at,
  expiresAt: row.expires_at,
});

/**
 * `papercusp_auth.hosted_mcp_oauth_*` (migration 1260), as the hosted service role — the only role
 * 1260 grants — the same way PostgresHostedAppRelayUsageStore runs. JSON travels as
 * `${text}::text::jsonb`, so the server parses it once whatever the client's parameter typing.
 */
export class PostgresPortalOAuthStore implements PortalOAuthStore {
  constructor(
    private readonly runService: AppRelayServiceRunner,
    private readonly random: (size: number) => Uint8Array = nodeRandomBytes,
  ) {}

  async registerClient(workspace: AppRelayWorkspace, input: RegistrationInput, now: Date): Promise<RegisteredOAuthClient> {
    const clientId = newClientId(this.random);
    const clientSecret = newClientSecret(input.tokenEndpointAuthMethod, this.random);
    const rows = await this.runService((sql: Sql) => sql<ClientRow[]>`
      INSERT INTO papercusp_auth.hosted_mcp_oauth_clients
        (client_id, control_workspace_id, organization_id, customer_workspace_id, client_name, redirect_uris,
         token_endpoint_auth_method, client_secret_hash, created_at)
      VALUES (${clientId}, ${workspace.controlPlaneWorkspaceId}, ${workspace.organizationId}, ${workspace.customerWorkspaceId},
              ${input.clientName}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...input.redirectUris])}::text::jsonb)),
              ${input.tokenEndpointAuthMethod}, ${clientSecret ? sha256Hex(clientSecret) : null}, ${now})
      RETURNING client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at`);
    const row = rows[0]!;
    return {
      client: {
        clientId: row.client_id,
        clientName: row.client_name,
        redirectUris: row.redirect_uris,
        tokenEndpointAuthMethod: row.token_endpoint_auth_method,
        clientSecretHash: row.client_secret_hash,
        createdAt: row.created_at,
      },
      clientSecret,
    };
  }

  async getClient(customerWorkspaceId: string, clientId: string): Promise<OAuthClient | null> {
    if (!/^pcoc_[A-Za-z0-9_-]{22}$/.test(clientId)) return null;
    const rows = await this.runService((sql: Sql) => sql<ClientRow[]>`
      SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at
        FROM papercusp_auth.hosted_mcp_oauth_clients
       WHERE client_id = ${clientId} AND customer_workspace_id = ${customerWorkspaceId}
       LIMIT 1`);
    const row = rows[0];
    return row
      ? {
          clientId: row.client_id,
          clientName: row.client_name,
          redirectUris: row.redirect_uris,
          tokenEndpointAuthMethod: row.token_endpoint_auth_method,
          clientSecretHash: row.client_secret_hash,
          createdAt: row.created_at,
        }
      : null;
  }

  async createRequest(input: NewPortalOAuthRequest): Promise<void> {
    const ws = input.workspace;
    await this.runService(async (sql: Sql) => {
      await sql`DELETE FROM papercusp_auth.hosted_mcp_oauth_requests WHERE expires_at < ${input.createdAt}`;
      await sql`
        INSERT INTO papercusp_auth.hosted_mcp_oauth_requests
          (handle_hash, client_id, control_workspace_id, organization_id, customer_workspace_id, redirect_uri,
           code_challenge, oauth_state, resource, requested_scopes, state, created_at, expires_at)
        VALUES (${input.handleHash}, ${input.clientId}, ${ws.controlPlaneWorkspaceId}, ${ws.organizationId},
                ${ws.customerWorkspaceId}, ${input.redirectUri}, ${input.codeChallenge}, ${input.state}, ${input.resource},
                ${JSON.stringify(input.requestedScopes)}::text::jsonb, 'pending', ${input.createdAt}, ${input.expiresAt})`;
    });
  }

  async getRequest(customerWorkspaceId: string, handleHash: string): Promise<PortalOAuthRequest | null> {
    const rows = await this.runService((sql: Sql) => sql<RequestRow[]>`
      SELECT ${sql.unsafe(REQUEST_COLUMNS)} FROM papercusp_auth.hosted_mcp_oauth_requests
       WHERE handle_hash = ${handleHash} AND customer_workspace_id = ${customerWorkspaceId} LIMIT 1`);
    return rows[0] ? requestOf(rows[0]) : null;
  }

  async decide(input: Parameters<PortalOAuthStore['decide']>[0]): Promise<PortalOAuthRequest | null> {
    const granted = input.approved && input.grantedScopes ? JSON.stringify(input.grantedScopes) : null;
    const rows = await this.runService((sql: Sql) => sql<RequestRow[]>`
      UPDATE papercusp_auth.hosted_mcp_oauth_requests
         SET state = ${input.approved ? 'approved' : 'denied'},
             granted_scopes = ${granted}::text::jsonb,
             approved_by = ${input.approvedBy},
             code_hash = ${input.approved ? input.codeHash : null},
             code_expires_at = ${input.approved ? input.codeExpiresAt : null}
       WHERE handle_hash = ${input.handleHash} AND customer_workspace_id = ${input.customerWorkspaceId}
         AND state = 'pending' AND expires_at > ${input.now}
      RETURNING ${sql.unsafe(REQUEST_COLUMNS)}`);
    return rows[0] ? requestOf(rows[0]) : null;
  }

  async claimCode(customerWorkspaceId: string, codeHash: string, now: Date): Promise<PortalOAuthRequest | null> {
    const rows = await this.runService((sql: Sql) => sql<RequestRow[]>`
      UPDATE papercusp_auth.hosted_mcp_oauth_requests SET state = 'redeeming'
       WHERE code_hash = ${codeHash} AND customer_workspace_id = ${customerWorkspaceId}
         AND state = 'approved' AND code_expires_at > ${now}
      RETURNING ${sql.unsafe(REQUEST_COLUMNS)}`);
    return rows[0] ? requestOf(rows[0]) : null;
  }

  async releaseCode(customerWorkspaceId: string, codeHash: string): Promise<void> {
    await this.runService((sql: Sql) => sql`
      UPDATE papercusp_auth.hosted_mcp_oauth_requests SET state = 'approved'
       WHERE code_hash = ${codeHash} AND customer_workspace_id = ${customerWorkspaceId} AND state = 'redeeming'`);
  }

  async consumeCode(customerWorkspaceId: string, codeHash: string, clientId: string, now: Date): Promise<void> {
    await this.runService(async (sql: Sql) => {
      await sql`
        UPDATE papercusp_auth.hosted_mcp_oauth_requests SET state = 'consumed'
         WHERE code_hash = ${codeHash} AND customer_workspace_id = ${customerWorkspaceId} AND state = 'redeeming'`;
      await sql`UPDATE papercusp_auth.hosted_mcp_oauth_clients SET last_used_at = ${now} WHERE client_id = ${clientId}`;
    });
  }
}

// ── the machine mint, over the connector relay ───────────────────────────────────────────────

/** Channel kind and frames of the machine mint (hosted-session-host.ts answers them). */
export const APP_KEY_MINT_CHANNEL_KIND = 'app-key-mint';
export const MINT_REQUEST_FRAME = 'mint.request';
export const PORTAL_MINT_TIMEOUT_MS = 30_000;

export interface PortalMintRequest {
  readonly label: string;
  readonly scopes: AppKeyScopes;
  /** Who consented, recorded as the key's creator on the machine. */
  readonly approvedBy: string;
}

export type PortalMintResult =
  | { readonly ok: true; readonly key: string; readonly scopes: AppKeyScopes }
  | { readonly ok: false; readonly code: string };

/**
 * Ask the machine to mint a key for a consented grant. One request, one answer: `mint.issued`
 * (an app-key-shaped key) or `mint.error`. A closed channel is `workspace_offline`; no answer in
 * time is `workspace_timeout`. The portal keeps nothing of the key it relays.
 */
export function mintAppKeyOverRelay(
  port: AppRelayPort,
  connector: AppRelayConnector,
  request: PortalMintRequest,
  options: { timeoutMs?: number; requestId?: string } = {},
): Promise<PortalMintResult> {
  return new Promise<PortalMintResult>((resolve) => {
    const requestId = options.requestId ?? nodeRandomBytes(12).toString('base64url');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: PortalMintResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const channel = port.openAppChannel(
      connector,
      {
        onFrame(frame) {
          if (frame.requestId !== requestId) return;
          // Strict: a consented grant is a long-lived `pcapp_` key, never a `pcat_` token.
          if (frame.type === 'mint.issued' && typeof frame.key === 'string' && parseAppKey(frame.key) !== null) {
            const scopes = frame.scopes && typeof frame.scopes === 'object' ? (frame.scopes as AppKeyScopes) : request.scopes;
            settle({ ok: true, key: frame.key, scopes });
          } else if (frame.type === 'mint.error') {
            settle({ ok: false, code: typeof frame.code === 'string' ? frame.code : 'mint_failed' });
          } else if (frame.type === 'mint.issued') {
            settle({ ok: false, code: 'mint_failed' });
          }
          channel?.close('mint_complete');
        },
        onClose() {
          settle({ ok: false, code: 'workspace_offline' });
        },
      },
      APP_KEY_MINT_CHANNEL_KIND,
    );
    if (!channel) {
      settle({ ok: false, code: 'workspace_offline' });
      return;
    }
    if (!channel.send({ type: MINT_REQUEST_FRAME, requestId, ...request })) {
      channel.close('mint_send_failed');
      settle({ ok: false, code: 'workspace_offline' });
      return;
    }
    timer = setTimeout(() => {
      channel.close('mint_timeout');
      settle({ ok: false, code: 'workspace_timeout' });
    }, options.timeoutMs ?? PORTAL_MINT_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** The frame that relays one client-credentials token request (P-016, D-022). */
export const TOKEN_REQUEST_FRAME = 'token.request';

export interface PortalTokenRequest {
  /** The request's form fields; only {@link RELAYED_TOKEN_FIELDS} cross the relay. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly basic: { id: string; secret: string } | null;
  /** The portal token endpoint the app addressed: an assertion's required `aud`. */
  readonly audience: string;
}

export type PortalTokenResult =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly code: string };

/**
 * Relay a `grant_type=client_credentials` request to the workspace's machine, which authenticates
 * the client and issues the token (client-credentials.ts). One request, one answer: `token.answer`
 * (an OAuth status + body, checked by {@link isRelayableTokenAnswer}) or `mint.error`. The portal
 * stores nothing: no secret, no token.
 */
export function requestTokenOverRelay(
  port: AppRelayPort,
  connector: AppRelayConnector,
  request: PortalTokenRequest,
  options: { timeoutMs?: number; requestId?: string } = {},
): Promise<PortalTokenResult> {
  return new Promise<PortalTokenResult>((resolve) => {
    const requestId = options.requestId ?? nodeRandomBytes(12).toString('base64url');
    const fields = relayedTokenFields(request.fields);
    if (!fields) {
      resolve({ ok: false, code: 'invalid_request' });
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: PortalTokenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const channel = port.openAppChannel(
      connector,
      {
        onFrame(frame) {
          if (frame.requestId !== requestId) return;
          if (frame.type === 'token.answer' && isRelayableTokenAnswer(frame.status, frame.body)) {
            settle({ ok: true, status: frame.status as number, body: frame.body as Record<string, unknown> });
          } else if (frame.type === 'mint.error') {
            settle({ ok: false, code: typeof frame.code === 'string' ? frame.code : 'token_failed' });
          } else {
            settle({ ok: false, code: 'token_failed' });
          }
          channel?.close('token_complete');
        },
        onClose() {
          settle({ ok: false, code: 'workspace_offline' });
        },
      },
      APP_KEY_MINT_CHANNEL_KIND,
    );
    if (!channel) {
      settle({ ok: false, code: 'workspace_offline' });
      return;
    }
    if (!channel.send({ type: TOKEN_REQUEST_FRAME, requestId, fields, basic: request.basic, audience: request.audience })) {
      channel.close('token_send_failed');
      settle({ ok: false, code: 'workspace_offline' });
      return;
    }
    timer = setTimeout(() => {
      channel.close('token_timeout');
      settle({ ok: false, code: 'workspace_timeout' });
    }, options.timeoutMs ?? PORTAL_MINT_TIMEOUT_MS);
    timer.unref?.();
  });
}

// ── consent rules ────────────────────────────────────────────────────────────────────────────

/** The account that may consent for a workspace: its organization owns it, and it may operate it. */
export function mayConsent(principal: HostedPrincipal, workspace: AppRelayWorkspace): boolean {
  return (
    principal.workspaceId === workspace.controlPlaneWorkspaceId &&
    principal.activeOrganizationId === workspace.organizationId &&
    principal.permissions.has('workspace:operate')
  );
}

const words = (value: unknown): string[] =>
  typeof value === 'string' ? [...new Set(value.split(/\s+/).map((w) => w.trim()).filter(Boolean))] : [];

/**
 * The approver's grant from the consent form, or why it is refused. The approver may only NARROW:
 * every granted tool or harness must have been requested, and a list the app restricted may not be
 * emptied. For harnesses an empty list means "any", which would widen the grant; for tools it means
 * "none", a key that can do nothing, so the approver is asked to deny instead. When the app named
 * no tools at all, the approver lists the ones to allow (an empty tool list is default-deny).
 */
export function narrowedGrant(
  requested: AppKeyScopes,
  fields: Record<string, unknown>,
): { ok: true; scopes: AppKeyScopes } | { ok: false; problem: string } {
  const granted: AppKeyScopes = {};
  for (const [field, list] of [['tools', requested.tools], ['harnesses', requested.harnesses]] as const) {
    const values = words(fields[field]);
    if (list?.length) {
      if (values.length === 0) return { ok: false, problem: `the app asked for specific ${field}; remove the ones you do not want, or deny` };
      const outside = values.find((v) => !list.includes(v));
      if (outside) return { ok: false, problem: `${outside} was not requested by the app` };
    }
    if (values.length) granted[field] = values;
  }
  return { ok: true, scopes: granted };
}

// ── pages ────────────────────────────────────────────────────────────────────────────────────

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}input{width:100%;font:inherit}
.row{display:flex;gap:.75rem;margin-top:1rem}button{font:inherit;padding:.4rem 1.2rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      ...OAUTH_NO_STORE,
    },
  });
}

function scopeSummary(scopes: AppKeyScopes): string {
  // An empty tool list grants NO tool (scope-policy.ts: default-deny), so say so rather than "all".
  const tools = scopes.tools?.length ? scopes.tools.map(escapeHtml).join(', ') : 'none yet (the app named no tools)';
  const harnesses = scopes.harnesses?.length ? scopes.harnesses.map(escapeHtml).join(', ') : 'any';
  return `<p>Tools: <b>${tools}</b><br>Harnesses: <b>${harnesses}</b></p>`;
}

function consentForm(id: string, handle: string, client: OAuthClient, request: PortalOAuthRequest): string {
  const tools = (request.requestedScopes.tools ?? []).join(' ');
  const harnesses = (request.requestedScopes.harnesses ?? []).join(' ');
  return `<p><b>${escapeHtml(client.clientName)}</b> wants to use the Papercusp workspace <b>${escapeHtml(id)}</b>.</p>
${scopeSummary(request.requestedScopes)}
<form method="post" action="/api/workspaces/${escapeHtml(id)}/oauth/consent">
<input type="hidden" name="request" value="${escapeHtml(handle)}">
<p><label>Tools it may call (${tools ? 'remove any you do not want to allow' : 'it can call none until you list them, for example plans:get or work_items:*'})<br>
<input name="tools" value="${escapeHtml(tools)}" placeholder="plans:get work_items:*"></label></p>
<p><label>Harnesses (remove any you do not want to allow${harnesses ? '' : '; leave empty for any'})<br>
<input name="harnesses" value="${escapeHtml(harnesses)}"></label></p>
<div class="row"><button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div></form>`;
}

// ── the handler ──────────────────────────────────────────────────────────────────────────────

export type PortalPrincipalResolution =
  | { readonly ok: true; readonly principal: HostedPrincipal }
  | { readonly ok: false; readonly reason: string };

export interface PortalMcpOAuthDependencies {
  readonly store: PortalOAuthStore;
  /** The connector broker: liveness and the mint channel. */
  readonly port: AppRelayPort;
  /** The plane's own cookie-session resolver. */
  readonly resolvePrincipal: (headers: Headers) => Promise<PortalPrincipalResolution>;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly mintTimeoutMs?: number;
}

/** True for a path this module serves (the host mounts it before `/api/*` and the SPA). */
export function isPortalMcpOAuthPath(pathname: string): boolean {
  return RESOURCE_METADATA_PATH.test(pathname) || SERVER_METADATA_PATHS.some((re) => re.test(pathname)) || OAUTH_VERB_PATH.test(pathname);
}

const offline = () =>
  oauthErrorResponse('temporarily_unavailable', 'the workspace is offline; try again when its computer is running', 503, { 'retry-after': '30' });

/** Serve one portal MCP OAuth request, or null when the path is not one of ours. */
export async function handleHostedMcpOAuth(request: Request, deps: PortalMcpOAuthDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const origin = publicOriginOf(request);
  const now = () => deps.now?.() ?? new Date();
  const random = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));

  const resourceMatch = RESOURCE_METADATA_PATH.exec(url.pathname);
  if (resourceMatch) {
    if (method !== 'GET') return oauthErrorResponse('invalid_request', 'use GET', 405);
    return Response.json(portalProtectedResourceMetadata(origin, resourceMatch[1]!), { headers: { 'cache-control': 'max-age=300' } });
  }
  for (const re of SERVER_METADATA_PATHS) {
    const m = re.exec(url.pathname);
    if (m) {
      if (method !== 'GET') return oauthErrorResponse('invalid_request', 'use GET', 405);
      return Response.json(portalAuthorizationServerMetadata(origin, m[1]!), { headers: { 'cache-control': 'max-age=300' } });
    }
  }
  const verbMatch = OAUTH_VERB_PATH.exec(url.pathname);
  if (!verbMatch) return null;
  const id = verbMatch[1]!;
  const verb = verbMatch[2]!;
  const issuer = portalIssuer(origin, id);
  const liveConnector = (): AppRelayConnector | null => {
    const connector = deps.port.appConnector(id);
    return connector && isHostedConnectorLive({ state: 'active', transport: 'websocket', heartbeatAt: connector.lastSeenAt }, now())
      ? connector
      : null;
  };

  if (verb === 'register') {
    if (method !== 'POST') return oauthErrorResponse('invalid_request', 'use POST', 405);
    const body = await readFormOrJson(request);
    if (!body) return oauthErrorResponse('invalid_client_metadata', 'the body must be a JSON object');
    const verdict = validateRegistration(body);
    if (!verdict.ok) return oauthErrorResponse(verdict.error, verdict.description);
    // The client is bound to the workspace, whose tenant only its live connector names (D-008).
    const connector = liveConnector();
    if (!connector) return offline();
    const { client, clientSecret } = await deps.store.registerClient(connector.binding, verdict.value, now());
    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      },
      { status: 201, headers: OAUTH_NO_STORE },
    );
  }

  if (verb === 'authorize') {
    if (method !== 'GET') return page('Not allowed', '<p>Open this link in a browser.</p>', 405);
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    // Until client and redirect URI are proven, an error is a page — never a redirect (RFC 6749 §4.1.2.1).
    const client = q.get('client_id') ? await deps.store.getClient(id, q.get('client_id')!) : null;
    if (!client) return page('Unknown app', '<p>This app is not registered for this workspace.</p>', 400);
    if (!client.redirectUris.includes(redirectUri)) {
      return page('Invalid redirect', '<p>The app asked to return to an address it did not register.</p>', 400);
    }
    const state = q.get('state');
    const fail = (error: string, description: string) =>
      redirectWithParams(redirectUri, { error, error_description: description, state, iss: issuer });
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
    const challenge = q.get('code_challenge');
    if (q.get('code_challenge_method') !== 'S256' || !isValidCodeChallenge(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = q.get('resource');
    if (resource && resource !== portalMcpResource(origin, id)) return fail('invalid_target', `resource must be ${portalMcpResource(origin, id)}`);
    let requestedScopes: AppKeyScopes;
    try {
      requestedScopes = parseOAuthScope(q.get('scope'));
    } catch (err) {
      if (err instanceof OAuthScopeError) return fail('invalid_scope', err.message);
      throw err;
    }
    const connector = liveConnector();
    if (!connector) return fail('temporarily_unavailable', 'the workspace is offline; try again when its computer is running');
    const handle = newRequestHandle(random);
    const createdAt = now();
    await deps.store.createRequest({
      handleHash: sha256Hex(handle),
      clientId: client.clientId,
      workspace: connector.binding,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource,
      requestedScopes,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + OAUTH_REQUEST_TTL_MS),
    });
    return new Response(null, {
      status: 302,
      headers: { location: `${issuer}/oauth/consent?request=${encodeURIComponent(handle)}`, ...OAUTH_NO_STORE },
    });
  }

  if (verb === 'consent') {
    const fields: Record<string, unknown> =
      method === 'POST' ? (await readFormOrJson(request)) ?? {} : Object.fromEntries(url.searchParams);
    if (method === 'POST' && request.headers.get('origin') !== origin) {
      return page('Not allowed', '<p>Consent must be given on this page.</p>', 403);
    }
    if (method !== 'GET' && method !== 'POST') return page('Not allowed', '<p>Open this link in a browser.</p>', 405);
    const handle = typeof fields.request === 'string' ? fields.request : '';
    if (!isRequestHandle(handle)) return page('Request not found', '<p>This link is not valid.</p>', 400);
    const pending = await deps.store.getRequest(id, sha256Hex(handle));
    if (!pending) return page('Request not found', '<p>Start connecting the app again.</p>', 400);
    if (pending.expiresAt.getTime() <= now().getTime()) return page('Request expired', '<p>Start connecting the app again.</p>', 400);
    if (pending.status !== 'pending') return page('Already answered', '<p>This request was already answered. Return to the app.</p>', 400);
    const client = await deps.store.getClient(id, pending.clientId);
    if (!client) return page('Unknown app', '<p>This app is no longer registered for this workspace.</p>', 400);

    const who = await deps.resolvePrincipal(request.headers);
    if (!who.ok) {
      const back = `${issuer}/oauth/consent?request=${encodeURIComponent(handle)}`;
      return page(
        'Sign in to continue',
        `<p><b>${escapeHtml(client.clientName)}</b> wants to use the Papercusp workspace <b>${escapeHtml(id)}</b>.</p>
<p><a href="${PORTAL_SIGN_IN_PATH}">Sign in to Papercusp</a> with an account that can use this workspace, then
<a href="${escapeHtml(back)}">open this page again</a>.</p>`,
        401,
      );
    }
    if (!mayConsent(who.principal, pending.workspace)) {
      return page('Not your workspace', '<p>The account you are signed in with cannot use this workspace, so it cannot approve this app.</p>', 403);
    }
    if (method === 'GET') return page(`Allow ${client.clientName}?`, consentForm(id, handle, client, pending));

    const approvedBy = `portal:${who.principal.userId}`;
    if (fields.decision !== 'approve') {
      const denied = await deps.store.decide({
        customerWorkspaceId: id, handleHash: sha256Hex(handle), approved: false, grantedScopes: null,
        approvedBy, codeHash: null, codeExpiresAt: null, now: now(),
      });
      if (!denied) return page('Already answered', '<p>This request was already answered. Return to the app.</p>', 400);
      return redirectWithParams(denied.redirectUri, { error: 'access_denied', error_description: 'the owner denied access', state: denied.state, iss: issuer });
    }
    const grant = narrowedGrant(pending.requestedScopes, fields);
    if (!grant.ok) return page('Check the scope', `<p>${escapeHtml(grant.problem)}.</p>${consentForm(id, handle, client, pending)}`, 400);
    const code = newAuthorizationCode(random);
    const decidedAt = now();
    const approved = await deps.store.decide({
      customerWorkspaceId: id, handleHash: sha256Hex(handle), approved: true, grantedScopes: grant.scopes,
      approvedBy, codeHash: sha256Hex(code), codeExpiresAt: new Date(decidedAt.getTime() + OAUTH_CODE_TTL_MS), now: decidedAt,
    });
    if (!approved) return page('Already answered', '<p>This request was already answered. Return to the app.</p>', 400);
    return redirectWithParams(approved.redirectUri, { code, state: approved.state, iss: issuer });
  }

  // token
  if (method !== 'POST') return oauthErrorResponse('invalid_request', 'use POST', 405);
  const body = await readFormOrJson(request);
  if (!body) return oauthErrorResponse('invalid_request', 'the body must be form-encoded');
  const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const basic = readBasicCredentials(request);
  if (field('grant_type') === 'client_credentials') {
    // An unattended app's service key (P-016): the machine authenticates it and issues the token.
    const connector = liveConnector();
    if (!connector) return offline();
    const relayed = await requestTokenOverRelay(
      deps.port,
      connector,
      { fields: body, basic, audience: `${issuer}/oauth/token` },
      { timeoutMs: deps.mintTimeoutMs ?? PORTAL_MINT_TIMEOUT_MS },
    );
    if (!relayed.ok) {
      if (relayed.code === 'invalid_request') return oauthErrorResponse('invalid_request', 'a token request field is malformed or too long');
      return relayed.code === 'workspace_offline' || relayed.code === 'workspace_timeout'
        ? offline()
        : oauthErrorResponse('server_error', `the workspace could not answer (${relayed.code})`, 502);
    }
    const headers: Record<string, string> = { ...OAUTH_NO_STORE };
    if (relayed.status === 401) headers['www-authenticate'] = 'Basic realm="papercusp"';
    return Response.json(relayed.body, { status: relayed.status, headers });
  }
  if (field('grant_type') !== 'authorization_code') {
    return oauthErrorResponse('unsupported_grant_type', 'grant_type must be authorization_code or client_credentials');
  }
  const clientId = basic?.id ?? field('client_id');
  const client = clientId ? await deps.store.getClient(id, clientId) : null;
  if (!client || !clientSecretMatches(client, basic?.secret ?? (field('client_secret') || null))) {
    return oauthErrorResponse('invalid_client', 'client authentication failed', 401, { 'www-authenticate': 'Basic realm="papercusp"' });
  }
  const code = field('code');
  if (!isAuthorizationCode(code)) return oauthErrorResponse('invalid_grant', 'the code is not valid');
  const codeHash = sha256Hex(code);
  const claimed = await deps.store.claimCode(id, codeHash, now());
  if (!claimed) return oauthErrorResponse('invalid_grant', 'the code is unknown, expired or already used');
  const burn = async (reason: string) => {
    await deps.store.consumeCode(id, codeHash, client.clientId, now());
    return oauthErrorResponse('invalid_grant', reason);
  };
  if (claimed.clientId !== client.clientId) return burn('the code was issued to another client');
  if (claimed.redirectUri !== field('redirect_uri')) return burn('redirect_uri does not match');
  if (!pkceMatches(field('code_verifier'), claimed.codeChallenge)) return burn('code_verifier does not match the code challenge');

  const connector = liveConnector();
  if (!connector) {
    await deps.store.releaseCode(id, codeHash);
    return offline();
  }
  const scopes = claimed.grantedScopes ?? claimed.requestedScopes;
  const minted = await mintAppKeyOverRelay(
    deps.port,
    connector,
    { label: client.clientName, scopes, approvedBy: claimed.approvedBy ?? 'portal:unknown' },
    { timeoutMs: deps.mintTimeoutMs ?? PORTAL_MINT_TIMEOUT_MS },
  );
  if (!minted.ok) {
    if (minted.code === 'invalid_scope') {
      await deps.store.consumeCode(id, codeHash, client.clientId, now());
      return oauthErrorResponse('invalid_scope', 'the consented scope is not grantable on this workspace');
    }
    await deps.store.releaseCode(id, codeHash);
    return minted.code === 'workspace_offline' || minted.code === 'workspace_timeout'
      ? offline()
      : oauthErrorResponse('server_error', `the workspace could not issue a key (${minted.code})`, 502);
  }
  await deps.store.consumeCode(id, codeHash, client.clientId, now());
  return Response.json(
    { access_token: minted.key, token_type: 'Bearer', scope: formatOAuthScope(minted.scopes) },
    { headers: OAUTH_NO_STORE },
  );
}
