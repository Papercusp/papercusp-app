/**
 * MCP OAuth on a LOCAL install (external-app-access-to-workspaces-2026-09-29 P-006).
 *
 *   GET  /connected-apps/oauth/protected-resource     RFC 9728 metadata for /api/mcp
 *   GET  /connected-apps/oauth/authorization-server   RFC 8414 metadata (issuer = this origin)
 *   POST /connected-apps/oauth/register               RFC 7591 dynamic client registration
 *   GET  /connected-apps/oauth/authorize              authorization code + PKCE (S256), consent
 *   GET  /connected-apps/oauth/continue               the browser returns here until approved
 *   POST /connected-apps/oauth/token                  code + verifier → access token (an app key);
 *                                                     or grant_type=client_credentials (P-016) →
 *                                                     a short-lived pcat_ token (client-credentials.ts)
 *
 * The host serves the two metadata documents at the root well-known paths too
 * (apps/operator/bin/host-handler.ts rewrites `/.well-known/oauth-*` here), which is where MCP
 * clients look. All of these are public: an MCP client reaches them from another network through
 * the user's own tunnel (D-001). None grants anything by itself — the consent is given either on
 * the local consent page (a browser on this machine) or, for a browser elsewhere, on the approval
 * page of the computer running Papercusp under the user code the browser shows (the device-grant
 * approval, ./index.ts). Only then does `continue` mint a one-time code bound to the client, the
 * redirect URI and the PKCE challenge; only the token endpoint turns that into a key.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { isLoopbackHost } from '../device/_shared';
import { activeWorkspaceId, readRegistry, workspaceById } from '../../../workspace-registry';
import {
  PostgresClientCredentialsStore,
  handleClientCredentialsGrant,
  validateClientJwk,
  type ClientCredentialsStore,
  type TokenEndpointAnswer,
} from '../../../connected-apps/client-credentials';
import { PORTAL_APPROVER_RE } from '../../../workspace-host/hosted-app-relay';
import { sanitizeClientLabel } from '../hosted-cli';
import {
  OAUTH_REQUEST_TTL_MS,
  OAuthScopeError,
  PostgresOAuthStore,
  clientSecretMatches,
  formatOAuthScope,
  isAuthorizationCode,
  isRequestHandle,
  isValidCodeChallenge,
  newAuthorizationCode,
  newRequestHandle,
  parseOAuthScope,
  sha256Hex,
  validateRegistration,
  type OAuthClient,
  type OAuthStore,
} from '../../../connected-apps/mcp-oauth';
import {
  MCP_OAUTH_BASE,
  MCP_RESOURCE_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
  publicOriginOf,
} from '../../../connected-apps/mcp-oauth-discovery';
import {
  AppKeyScopeError,
  ClientCredentialsModeError,
  createAppKey,
  resolveAppKeyScopes,
  setClientCredentialsMode,
  type AppKeyScopeRequest,
  type AppKeyScopes,
  type CreateAppKeyOptions,
  type CreatedAppKey,
} from '../../../connected-apps/store';
import { consentFormHtml, escapeHtml, htmlPage } from './index';

type AnyRoute = RouteDefinition<any>;

const OAUTH_BASE = MCP_OAUTH_BASE;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' };

export interface McpOAuthRouteDependencies {
  readonly store: OAuthStore;
  readonly resolveScopes: (req: AppKeyScopeRequest) => AppKeyScopes;
  readonly listWorkspaces: () => ReadonlyArray<{ id: string; name: string }>;
  /** True when the request is from this machine and not through a tunnel or relay. */
  readonly isLocal: (req: Request) => boolean;
  /** The client-credentials grant (P-016). Absent = the token endpoint serves authorization_code only. */
  readonly clientCredentials?: ClientCredentialsStore;
  readonly clock?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** An OAuth token-endpoint answer as an HTTP response: no-store, and a Basic challenge on a 401. */
export function tokenAnswerResponse(answer: TokenEndpointAnswer): Response {
  const headers: Record<string, string> = { ...noStore };
  if (answer.status === 401) headers['www-authenticate'] = 'Basic realm="papercusp"';
  return Response.json(answer.body, { status: answer.status, headers });
}

function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...noStore, ...extra } });
}

/** Append OAuth response parameters to a registered redirect URI (RFC 6749 §4.1.2, RFC 9207 iss). */
function redirectTo(redirectUri: string, params: Record<string, string | null>): Response {
  const target = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) target.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: target.toString(), ...noStore } });
}

async function formOrJson(req: Request): Promise<Record<string, unknown> | null> {
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await req.text()));
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** client_secret_basic credentials (RFC 6749 §2.3.1: form-urlencoded, then base64). */
function basicCredentials(req: Request): { id: string; secret: string } | null {
  const header = req.headers.get('authorization') ?? '';
  if (!/^basic /i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return null;
  }
}

export function createMcpOAuthRoutes(deps: McpOAuthRouteDependencies): ReadonlyArray<AnyRoute> {
  const clock = deps.clock ?? (() => new Date());
  const random = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const randomUserCode = () => {
    let code = '';
    for (const byte of Buffer.from(random(8))) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  };

  const resourceMetadata = defineTool({
    method: 'GET',
    path: '/connected-apps/oauth/protected-resource',
    auth: 'public',
    async handler(req) {
      return Response.json(protectedResourceMetadata(publicOriginOf(req)), { headers: { 'cache-control': 'max-age=300' } });
    },
  });

  const serverMetadata = defineTool({
    method: 'GET',
    path: '/connected-apps/oauth/authorization-server',
    auth: 'public',
    async handler(req) {
      return Response.json(authorizationServerMetadata(publicOriginOf(req)), { headers: { 'cache-control': 'max-age=300' } });
    },
  });

  const register = defineTool({
    method: 'POST',
    path: '/connected-apps/oauth/register',
    auth: 'public',
    async handler(req) {
      const body = await formOrJson(req);
      if (!body) return oauthError('invalid_client_metadata', 'the body must be a JSON object');
      const verdict = validateRegistration(body);
      if (!verdict.ok) return oauthError(verdict.error, verdict.description);
      const { client, clientSecret } = await deps.store.registerClient(verdict.value, clock());
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
        { status: 201, headers: noStore },
      );
    },
  });

  const authorize = defineTool({
    method: 'GET',
    path: '/connected-apps/oauth/authorize',
    auth: 'public',
    async handler(req) {
      const q = new URL(req.url).searchParams;
      const clientId = q.get('client_id') ?? '';
      const redirectUri = q.get('redirect_uri') ?? '';
      // Until client and redirect URI are proven, an error is a page — never a redirect (§4.1.2.1).
      const client = clientId ? await deps.store.getClient(clientId) : null;
      if (!client) return htmlPage('Unknown app', '<p>This app is not registered with this computer.</p>', 400);
      if (!client.redirectUris.includes(redirectUri)) {
        return htmlPage('Invalid redirect', '<p>The app asked to return to an address it did not register.</p>', 400);
      }
      const origin = publicOriginOf(req);
      const state = q.get('state');
      const fail = (error: string, description: string) =>
        redirectTo(redirectUri, { error, error_description: description, state, iss: origin });
      if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
      const challenge = q.get('code_challenge');
      if (q.get('code_challenge_method') !== 'S256' || !isValidCodeChallenge(challenge)) {
        return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
      }
      const resource = q.get('resource');
      const expectedResource = `${origin}${MCP_RESOURCE_PATH}`;
      if (resource && resource !== expectedResource) return fail('invalid_target', `resource must be ${expectedResource}`);
      let requestedScopes: AppKeyScopes;
      try {
        requestedScopes = deps.resolveScopes(parseOAuthScope(q.get('scope')));
      } catch (err) {
        if (err instanceof OAuthScopeError || err instanceof AppKeyScopeError) return fail('invalid_scope', err.message);
        throw err;
      }
      const handle = newRequestHandle(random);
      const now = clock();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = randomUserCode();
        const created = await deps.store.createAuthorizationRequest({
          handleHash: sha256Hex(handle),
          userCode,
          client,
          redirectUri,
          codeChallenge: challenge,
          state,
          resource,
          requestedScopes,
          createdAt: now,
          expiresAt: new Date(now.getTime() + OAUTH_REQUEST_TTL_MS),
        });
        if (!created) continue;
        return consentPage(req, client, userCode, requestedScopes, handle, redirectUri);
      }
      return fail('temporarily_unavailable', 'could not open an authorization request');
    },
  });

  function consentPage(
    req: Request,
    client: OAuthClient,
    userCode: string,
    scopes: AppKeyScopes,
    handle: string,
    redirectUri: string,
  ): Response {
    const name = escapeHtml(client.clientName);
    if (deps.isLocal(req)) {
      // The form's answer goes decision → /oauth/continue → redirectUri; the page must admit that
      // last hop or the browser stays here and the client never gets its code (WI-10004470).
      return htmlPage(
        `Allow ${client.clientName} to use a workspace?`,
        `<p><b>${name}</b> wants to connect to a Papercusp workspace on this computer.</p>
${consentFormHtml({ userCode, scopes, workspaces: deps.listWorkspaces(), hidden: { oauth_handle: handle } })}`,
        200,
        [redirectUri],
      );
    }
    // A browser elsewhere cannot be trusted to speak for the owner: the owner approves on the
    // machine under this code, and this page keeps checking until they have.
    const next = `${OAUTH_BASE}/continue?request=${encodeURIComponent(handle)}`;
    const res = htmlPage(
      `Approve ${client.clientName} on your computer`,
      `<p>On the computer running Papercusp, open Settings → Remote access and approve code</p>
<p><code>${escapeHtml(userCode)}</code></p><p>This page continues by itself once you have. <a href="${escapeHtml(next)}">Check now</a></p>`,
    );
    res.headers.set('refresh', `3; url=${next}`);
    return res;
  }

  const cont = defineTool({
    method: 'GET',
    path: '/connected-apps/oauth/continue',
    auth: 'public',
    async handler(req) {
      const handle = new URL(req.url).searchParams.get('request');
      if (!isRequestHandle(handle)) return htmlPage('Request not found', '<p>This sign-in link is not valid.</p>', 400);
      const code = newAuthorizationCode(random);
      const progress = await deps.store.continueAuthorization({ handleHash: sha256Hex(handle), codeHash: sha256Hex(code), now: clock() });
      const origin = publicOriginOf(req);
      switch (progress.status) {
        case 'code':
          return redirectTo(progress.redirectUri, { code, state: progress.state, iss: origin });
        case 'denied':
          return redirectTo(progress.redirectUri, { error: 'access_denied', error_description: 'the owner denied access', state: progress.state, iss: origin });
        case 'pending': {
          const next = `${OAUTH_BASE}/continue?request=${encodeURIComponent(handle)}`;
          const res = htmlPage(
            'Waiting for approval',
            `<p>On the computer running Papercusp, approve code</p><p><code>${escapeHtml(progress.userCode)}</code></p>`,
          );
          res.headers.set('refresh', `3; url=${next}`);
          return res;
        }
        case 'expired':
          return htmlPage('Request expired', '<p>Start connecting the app again.</p>', 400);
        default:
          return htmlPage('Request not found', '<p>This sign-in was already completed or does not exist.</p>', 400);
      }
    },
  });

  const token = defineTool({
    method: 'POST',
    path: '/connected-apps/oauth/token',
    auth: 'public',
    async handler(req) {
      const body = await formOrJson(req);
      if (!body) return oauthError('invalid_request', 'the body must be form-encoded');
      const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
      if (field('grant_type') === 'client_credentials' && deps.clientCredentials) {
        // P-016: an unattended app exchanges its client credentials for a short-lived token.
        const answer = await handleClientCredentialsGrant({
          fields: body,
          basic: basicCredentials(req),
          audience: `${publicOriginOf(req)}${OAUTH_BASE}/token`,
          now: clock(),
          store: deps.clientCredentials,
        });
        return tokenAnswerResponse(answer);
      }
      if (field('grant_type') !== 'authorization_code') {
        return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or client_credentials');
      }
      const basic = basicCredentials(req);
      const clientId = basic?.id ?? field('client_id');
      const client = clientId ? await deps.store.getClient(clientId) : null;
      const presented = basic?.secret ?? (field('client_secret') || null);
      if (!client || !clientSecretMatches(client, presented)) {
        return oauthError('invalid_client', 'client authentication failed', 401, { 'www-authenticate': 'Basic realm="papercusp"' });
      }
      const code = field('code');
      if (!isAuthorizationCode(code)) return oauthError('invalid_grant', 'the code is not valid');
      const result = await deps.store.redeemAuthorizationCode({
        codeHash: sha256Hex(code),
        client,
        redirectUri: field('redirect_uri'),
        codeVerifier: field('code_verifier'),
        now: clock(),
      });
      if (result.status === 'invalid_grant') return oauthError('invalid_grant', result.reason);
      if (result.status === 'invalid_scope') return oauthError('invalid_scope', 'the consented scope is no longer grantable');
      return Response.json(
        { access_token: result.issued.key, token_type: 'Bearer', scope: formatOAuthScope(result.scopes) },
        { headers: noStore },
      );
    },
  });

  return [resourceMetadata, serverMetadata, register, authorize, cont, token];
}

export interface PortalMintRouteDependencies {
  readonly createKey: (opts: CreateAppKeyOptions) => Promise<CreatedAppKey>;
  /** The workspace this machine's keys belong to. */
  readonly workspaceId: () => string;
  /** True when the request is from this machine and not through a tunnel or relay. */
  readonly isLocal: (req: Request) => boolean;
}

/**
 * POST /connected-apps/portal-mint — the machine half of the PORTAL's MCP OAuth (P-325, D-021).
 * The portal's consent page approves a grant; its token endpoint asks this machine, over the
 * connector's `app-key-mint` channel, to mint the key. The channel's machine end
 * (workspace-host/hosted-app-relay.ts AppKeyMintChannel) is this route's only caller: it is
 * loopback-only at the route stack and in the handler, neither relay plane's allowlist reaches it,
 * and the external-ingress listener does not serve it. The scopes are resolved here against this
 * machine's catalog and hard-deny set, like every other issuance path.
 */
export function createPortalMintRoute(deps: PortalMintRouteDependencies): AnyRoute {
  return defineTool({
    method: 'POST',
    path: '/connected-apps/portal-mint',
    auth: 'loopback',
    async handler(req) {
      const refuse = (code: string, status: number, extra: Record<string, unknown> = {}) =>
        Response.json({ ok: false, error: { code, ...extra } }, { status, headers: noStore });
      if (!deps.isLocal(req)) return refuse('local_only', 403);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return refuse('invalid_json', 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid_json', 400);
      const fields = body as Record<string, unknown>;
      // sanitizeClientLabel returns '' when nothing printable is left (blank, spaces, control
      // characters only), so the check below refuses those labels.
      const label = sanitizeClientLabel(fields.label);
      const approvedBy = typeof fields.approvedBy === 'string' ? fields.approvedBy : '';
      const scopes = scopeFieldsOf(fields.scopes);
      if (!label || !scopes || !PORTAL_APPROVER_RE.test(approvedBy)) return refuse('invalid_request', 400);
      try {
        const created = await deps.createKey({ workspaceId: deps.workspaceId(), userEmail: approvedBy, label, ...scopes });
        return Response.json({ ok: true, key: created.key, scopes: created.app.scopes }, { status: 201, headers: noStore });
      } catch (err) {
        if (err instanceof AppKeyScopeError) return refuse('invalid_scope', 400, { problems: err.problems });
        throw err;
      }
    },
  });
}

export interface ClientCredentialsRouteDependencies {
  readonly store: ClientCredentialsStore;
  readonly setMode: typeof setClientCredentialsMode;
  readonly workspaceExists: (id: string) => boolean;
  /** True when the request is from this machine and not through a tunnel or relay. */
  readonly isLocal: (req: Request) => boolean;
  readonly clock?: () => Date;
}

const PORTAL_TOKEN_AUDIENCE_RE = /^https:\/\/[^\s/?#]+\/api\/workspaces\/[A-Za-z0-9_-]{1,120}\/oauth\/token$/;

/**
 * P-016 routes beside the token endpoint:
 *
 *   POST /connected-apps/client-credentials  local-only  switch a service key into (or out of)
 *        client-credentials mode: `{ workspaceId, id, auth: 'client_secret' | 'private_key_jwt' | null, jwk? }`.
 *        Switching ends the key's live access tokens.
 *   POST /connected-apps/portal-token        loopback    the machine half of the PORTAL's
 *        client-credentials grant. The portal's token endpoint relays the request's form fields
 *        and Basic credentials over the connector's `app-key-mint` channel
 *        (workspace-host/hosted-app-relay.ts AppKeyMintChannel is the only caller); this machine
 *        authenticates the client and issues the token, so the portal never holds a secret. The
 *        audience is the portal token endpoint the app addressed, which an assertion must name.
 */
export function createClientCredentialsRoutes(deps: ClientCredentialsRouteDependencies): ReadonlyArray<AnyRoute> {
  const clock = deps.clock ?? (() => new Date());
  const refuse = (code: string, status: number, extra: Record<string, unknown> = {}) =>
    Response.json({ ok: false, error: { code, ...extra } }, { status, headers: noStore });

  const setMode = defineTool({
    method: 'POST',
    path: '/connected-apps/client-credentials',
    auth: 'loopback',
    async handler(req) {
      if (!deps.isLocal(req)) return refuse('local_only', 403);
      const origin = req.headers.get('origin');
      if (origin !== null && origin !== new URL(req.url).origin) return refuse('cross_origin_blocked', 403);
      let body: Record<string, unknown>;
      try {
        const parsed = await req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('invalid_json', 400);
        body = parsed as Record<string, unknown>;
      } catch {
        return refuse('invalid_json', 400);
      }
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
      const id = typeof body.id === 'string' ? body.id : '';
      const auth = body.auth === null ? null : body.auth === 'client_secret' || body.auth === 'private_key_jwt' ? body.auth : undefined;
      if (!workspaceId || !id || auth === undefined) return refuse('invalid_request', 400);
      if (!deps.workspaceExists(workspaceId)) return refuse('workspace_not_found', 400);
      let jwk: Record<string, unknown> | null = null;
      if (auth === 'private_key_jwt') {
        const verdict = await validateClientJwk(body.jwk);
        if (!verdict.ok) return refuse('invalid_jwk', 400, { problem: verdict.problem });
        jwk = verdict.jwk;
      }
      try {
        const app = await deps.setMode(workspaceId, id, auth ? { auth, jwk } : null);
        if (!app) return refuse('key_not_found', 404);
        const tokenEndpoint = `${publicOriginOf(req)}${OAUTH_BASE}/token`;
        return Response.json({ ok: true, app: { id: app.id, kind: app.kind, label: app.label, clientAuth: app.client_auth }, tokenEndpoint }, { headers: noStore });
      } catch (err) {
        if (err instanceof ClientCredentialsModeError) return refuse(err.code, 400);
        throw err;
      }
    },
  });

  const portalToken = defineTool({
    method: 'POST',
    path: '/connected-apps/portal-token',
    auth: 'loopback',
    async handler(req) {
      if (!deps.isLocal(req)) return refuse('local_only', 403);
      let body: Record<string, unknown>;
      try {
        const parsed = await req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('invalid_json', 400);
        body = parsed as Record<string, unknown>;
      } catch {
        return refuse('invalid_json', 400);
      }
      const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : null;
      const audience = typeof body.audience === 'string' ? body.audience : '';
      const basicRaw = body.basic as { id?: unknown; secret?: unknown } | null | undefined;
      const basic =
        basicRaw && typeof basicRaw.id === 'string' && typeof basicRaw.secret === 'string' ? { id: basicRaw.id, secret: basicRaw.secret } : null;
      if (!fields || !PORTAL_TOKEN_AUDIENCE_RE.test(audience) || (basicRaw !== null && basicRaw !== undefined && !basic)) {
        return refuse('invalid_request', 400);
      }
      const answer = await handleClientCredentialsGrant({ fields, basic, audience, now: clock(), store: deps.store });
      return Response.json({ ok: true, status: answer.status, body: answer.body }, { headers: noStore });
    },
  });

  return [setMode, portalToken];
}

/** The scope object a mint request carries; null when a field is present but not a string array. */
function scopeFieldsOf(value: unknown): AppKeyScopeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: AppKeyScopeRequest = {};
  for (const field of ['tools', 'harnesses', 'capabilities'] as const) {
    const list = (value as Record<string, unknown>)[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) return null;
    out[field] = list as string[];
  }
  return out;
}

const clientCredentialsStore = new PostgresClientCredentialsStore();

const routes: ReadonlyArray<AnyRoute> = [
  ...createMcpOAuthRoutes({
    store: new PostgresOAuthStore(),
    resolveScopes: resolveAppKeyScopes,
    listWorkspaces: () => readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name ?? w.id })),
    isLocal: isLoopbackHost,
    clientCredentials: clientCredentialsStore,
  }),
  createPortalMintRoute({ createKey: createAppKey, workspaceId: activeWorkspaceId, isLocal: isLoopbackHost }),
  ...createClientCredentialsRoutes({
    store: clientCredentialsStore,
    setMode: setClientCredentialsMode,
    workspaceExists: (id) => Boolean(workspaceById(id)),
    isLocal: isLoopbackHost,
  }),
];

export default routes;
