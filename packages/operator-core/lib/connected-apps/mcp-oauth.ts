/**
 * MCP OAuth authorization server for a LOCAL install (external-app-access-to-workspaces-2026-09-29
 * P-006; migration 1256).
 *
 * An off-the-shelf MCP client is given only the server URL. It discovers this authorization server
 * (RFC 9728 protected-resource metadata -> RFC 8414 server metadata), registers itself (RFC 7591),
 * sends the user through authorization code + PKCE (S256 only), and exchanges the code for an
 * access token. The token IS a connected-app key (`pcapp_…`, kind 'app'), so everything that
 * governs a key made in Connect-an-app — scope enforcement, the hard-deny set, pause, revoke, the
 * kill switch — governs it too. No portal is involved (D-001, D-004).
 *
 * An authorization request is stored as a device grant (./device-grants.ts): it waits for the SAME
 * local approval under the SAME user code, and the approver's choice (`granted_scopes`) is what the
 * key receives. The OAuth-only columns bind the one-time code to its client, redirect URI and PKCE
 * challenge.
 *
 * Scope strings: space-separated `tool:<tool or group:*>` and `harness:<slug>` tokens, mapped onto
 * the key's `{ tools, harnesses }`. Any other token is refused (`invalid_scope`), never ignored.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { AppKeyScopeError, insertAppKey, resolveAppKeyScopes, type AppKeyScopes, type CreatedAppKey } from './store';
import type { AppKeyScopeProblem } from './scope-policy';
import { parseAccessToken } from './key';

// ── the relayed client-credentials token request (P-016, D-022) ─────────────────────────────
// The portal token endpoint relays a `grant_type=client_credentials` request to the workspace's
// machine (portal-mcp-oauth.ts requestTokenOverRelay → workspace-host/hosted-app-relay.ts
// AppKeyMintChannel → routes/connected-apps/oauth.ts /connected-apps/portal-token). Both ends
// apply these checks, so they live here, below both, rather than in either.

/** The token-request form fields relayed, each a bounded string; nothing else crosses. */
export const RELAYED_TOKEN_FIELDS = ['grant_type', 'scope', 'client_id', 'client_secret', 'client_assertion', 'client_assertion_type'] as const;
const RELAYED_TOKEN_FIELD_MAX = 8192;
const RELAYED_BASIC_MAX = 512;
/** The statuses a client-credentials answer may carry (RFC 6749 §5.1 / §5.2); anything else is a fault. */
const TOKEN_ANSWER_STATUSES = new Set([200, 400, 401]);

/** The relayable subset of a token request's fields, or null when one is not a bounded string. */
export function relayedTokenFields(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const name of RELAYED_TOKEN_FIELDS) {
    const value = (input as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > RELAYED_TOKEN_FIELD_MAX) return null;
    out[name] = value;
  }
  return out;
}

/** Relayed client_secret_basic credentials: absent → null; malformed or oversized → undefined (refuse). */
export function relayedBasic(input: unknown): { id: string; secret: string } | null | undefined {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { id, secret } = input as { id?: unknown; secret?: unknown };
  if (typeof id !== 'string' || typeof secret !== 'string' || id.length > RELAYED_BASIC_MAX || secret.length > RELAYED_BASIC_MAX) {
    return undefined;
  }
  return { id, secret };
}

/**
 * A token answer that may cross the relay: an OAuth status with an object body; an error answer
 * names its `error`; a 200 carries a well-formed short-lived `pcat_` token. A long-lived `pcapp_`
 * key is never a token answer.
 */
export function isRelayableTokenAnswer(status: unknown, body: unknown): body is Record<string, unknown> {
  if (typeof status !== 'number' || !TOKEN_ANSWER_STATUSES.has(status)) return false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (status !== 200) return typeof (body as { error?: unknown }).error === 'string';
  const token = (body as { access_token?: unknown }).access_token;
  return typeof token === 'string' && parseAccessToken(token) !== null;
}

export const OAUTH_CLIENT_ID_PREFIX = 'pcoc_';
export const OAUTH_REQUEST_HANDLE_PREFIX = 'paz_';
/** How long an authorization request waits for approval. */
export const OAUTH_REQUEST_TTL_MS = 10 * 60_000;
/** How long a minted authorization code may be redeemed (RFC 6749 §4.1.2 recommends ≤ 10 min). */
export const OAUTH_CODE_TTL_MS = 60_000;
export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
export type OAuthTokenEndpointAuthMethod = (typeof OAUTH_TOKEN_ENDPOINT_AUTH_METHODS)[number];

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 80;
const CLIENT_ID_RE = /^pcoc_[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^paz_[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^pac_[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function hexEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ── scope strings ────────────────────────────────────────────────────────────────────────────

export class OAuthScopeError extends Error {
  constructor(readonly token: string) {
    super(`unsupported scope token "${token}" (use tool:<group:verb>, tool:<group>:* or harness:<slug>)`);
    this.name = 'OAuthScopeError';
  }
}

/** Parse an OAuth `scope` parameter into key scopes. Empty / absent → `{}`; unknown tokens throw. */
export function parseOAuthScope(scope: string | null | undefined): AppKeyScopes {
  const tools: string[] = [];
  const harnesses: string[] = [];
  for (const token of (scope ?? '').split(/\s+/).filter(Boolean)) {
    if (token.startsWith('tool:') && token.length > 'tool:'.length) tools.push(token.slice('tool:'.length));
    else if (token.startsWith('harness:') && token.length > 'harness:'.length) harnesses.push(token.slice('harness:'.length));
    else throw new OAuthScopeError(token);
  }
  const out: AppKeyScopes = {};
  if (tools.length) out.tools = [...new Set(tools)];
  if (harnesses.length) out.harnesses = [...new Set(harnesses)];
  return out;
}

/** The OAuth `scope` string for key scopes (the inverse of `parseOAuthScope`). */
export function formatOAuthScope(scopes: AppKeyScopes): string {
  return [
    ...(scopes.tools ?? []).map((t) => `tool:${t}`),
    ...(scopes.harnesses ?? []).map((h) => `harness:${h}`),
  ].join(' ');
}

// ── PKCE ─────────────────────────────────────────────────────────────────────────────────────

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && CODE_CHALLENGE_RE.test(challenge);
}

/** True when the verifier is well-formed and hashes to the challenge (constant-time compare). */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !CODE_VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(pkceS256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── redirect URIs ────────────────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);

/**
 * Why a redirect URI may not be registered, or null when it may. Allowed: https; http only to a
 * loopback host (RFC 8252 §7.3); a private-use scheme for native apps (RFC 8252 §7.1). Never a
 * fragment, never a script/data/file scheme.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > 2000) return 'redirect_uri must be a non-empty string';
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri is not an absolute URI';
  }
  if (u.hash) return 'redirect_uri must not contain a fragment';
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return `redirect_uri scheme ${u.protocol} is not allowed`;
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) return 'http redirect_uri must point at a loopback host';
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && !/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) {
    return 'redirect_uri scheme is not valid';
  }
  return null;
}

// ── client registration ──────────────────────────────────────────────────────────────────────

export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  readonly clientSecretHash: string | null;
  readonly createdAt: Date;
}

export interface RegisteredOAuthClient {
  readonly client: OAuthClient;
  /** Returned exactly once, only for a confidential client. */
  readonly clientSecret: string | null;
}

export type RegistrationInput = Pick<OAuthClient, 'clientName' | 'redirectUris' | 'tokenEndpointAuthMethod'>;

export type RegistrationVerdict =
  | { ok: true; value: RegistrationInput }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/** Validate an RFC 7591 registration request body. */
export function validateRegistration(body: Record<string, unknown>): RegistrationVerdict {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: 'invalid_redirect_uri', description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs` };
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return { ok: false, error: 'invalid_redirect_uri', description: problem };
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  if (typeof method !== 'string' || !(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: 'invalid_client_metadata', description: 'unsupported token_endpoint_auth_method' };
  }
  const grantTypes = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    return { ok: false, error: 'invalid_client_metadata', description: 'grant_types may only be authorization_code' };
  }
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
    return { ok: false, error: 'invalid_client_metadata', description: 'response_types may only be code' };
  }
  const rawName = typeof body.client_name === 'string' ? body.client_name : '';
  // eslint-disable-next-line no-control-regex
  const clientName = rawName.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_CLIENT_NAME) || 'MCP client';
  return {
    ok: true,
    value: {
      clientName,
      redirectUris: [...new Set(uris as string[])],
      tokenEndpointAuthMethod: method as OAuthTokenEndpointAuthMethod,
    },
  };
}

/** Client authentication at the token endpoint (RFC 6749 §2.3.1). */
export function clientSecretMatches(client: OAuthClient, presented: string | null): boolean {
  if (client.tokenEndpointAuthMethod === 'none') return true;
  if (!presented || !client.clientSecretHash) return false;
  return hexEquals(sha256Hex(presented), client.clientSecretHash);
}

// ── authorization requests and codes ─────────────────────────────────────────────────────────

export function isRequestHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_RE.test(value);
}

export function isAuthorizationCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

export interface NewAuthorizationRequest {
  readonly handleHash: string;
  readonly userCode: string;
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly resource: string | null;
  readonly requestedScopes: AppKeyScopes;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** What the browser's next visit to the continue endpoint should do. */
export type AuthorizationProgress =
  | { readonly status: 'pending'; readonly userCode: string }
  | { readonly status: 'expired' | 'invalid' }
  | { readonly status: 'denied'; readonly redirectUri: string; readonly state: string | null }
  | { readonly status: 'code'; readonly redirectUri: string; readonly state: string | null };

export type AuthorizationCodeRedemption =
  | { readonly status: 'invalid_grant'; readonly reason: string }
  | { readonly status: 'invalid_scope'; readonly problems: readonly AppKeyScopeProblem[] }
  | { readonly status: 'issued'; readonly issued: CreatedAppKey; readonly scopes: AppKeyScopes };

export interface OAuthStore {
  registerClient(input: RegistrationInput, now: Date): Promise<RegisteredOAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  /** False when the user code collided with a live grant; the caller draws another. */
  createAuthorizationRequest(input: NewAuthorizationRequest): Promise<boolean>;
  /** One visit to the continue endpoint: an approved request mints its code exactly once. */
  continueAuthorization(input: { handleHash: string; codeHash: string; now: Date }): Promise<AuthorizationProgress>;
  /** The token endpoint: an unexpired, unused code for this client, redirect URI and verifier becomes a key. */
  redeemAuthorizationCode(input: {
    codeHash: string;
    client: OAuthClient;
    redirectUri: string;
    codeVerifier: string;
    now: Date;
  }): Promise<AuthorizationCodeRedemption>;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: OAuthTokenEndpointAuthMethod;
  client_secret_hash: string | null;
  created_at: Date;
}

const clientOf = (row: ClientRow): OAuthClient => ({
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUris: row.redirect_uris,
  tokenEndpointAuthMethod: row.token_endpoint_auth_method,
  clientSecretHash: row.client_secret_hash,
  createdAt: row.created_at,
});

interface RequestRow {
  user_code: string;
  client_label: string;
  requested_scopes: AppKeyScopes;
  granted_scopes: AppKeyScopes | null;
  state: 'pending' | 'approved' | 'denied' | 'consumed';
  workspace_id: string | null;
  approved_by: string | null;
  expires_at: Date;
  oauth_client_id: string | null;
  oauth_redirect_uri: string | null;
  oauth_code_challenge: string | null;
  oauth_state: string | null;
  auth_code_hash: string | null;
  auth_code_expires_at: Date | null;
}

/** Thrown inside the redeem transaction when another redemption consumed the code first. */
class CodeAlreadyRedeemed extends Error {}

export class PostgresOAuthStore implements OAuthStore {
  async registerClient(input: RegistrationInput, now: Date): Promise<RegisteredOAuthClient> {
    const { sql } = getOrgPg();
    const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
    const clientSecret = input.tokenEndpointAuthMethod === 'none' ? null : `pcos_${randomBytes(32).toString('base64url')}`;
    // The URIs travel as JSON, typed by the query itself, so this insert does not depend on the
    // client having seeded postgres.js's array-type OIDs. Production clients seed them
    // (buildClient, WI-41207); the org TEST fixture once did not, and a `sql.array()` here then
    // failed on a fresh client's first query (WI-10004177, fixed in the fixture). Keeping JSON
    // means no client setup can bring that failure back for this row (WI-10004187).
    const rows = await sql<ClientRow[]>`
      INSERT INTO harness_shared.connected_app_oauth_clients
        (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at)
      VALUES (${clientId}, ${input.clientName},
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...input.redirectUris])}::jsonb)),
              ${input.tokenEndpointAuthMethod}, ${clientSecret ? sha256Hex(clientSecret) : null}, ${now})
      RETURNING client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at`;
    return { client: clientOf(rows[0]!), clientSecret };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    if (!CLIENT_ID_RE.test(clientId)) return null;
    const { sql } = getOrgPg();
    const rows = await sql<ClientRow[]>`
      SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at
        FROM harness_shared.connected_app_oauth_clients WHERE client_id = ${clientId} LIMIT 1`;
    return rows[0] ? clientOf(rows[0]) : null;
  }

  async createAuthorizationRequest(input: NewAuthorizationRequest): Promise<boolean> {
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.connected_app_device_grants WHERE expires_at < ${input.createdAt}`;
    const rows = await sql`
      INSERT INTO harness_shared.connected_app_device_grants
        (device_code_hash, user_code, client_label, requested_scopes, state, created_at, expires_at,
         oauth_client_id, oauth_redirect_uri, oauth_code_challenge, oauth_state, oauth_resource)
      VALUES (${input.handleHash}, ${input.userCode}, ${input.client.clientName},
              ${JSON.stringify(input.requestedScopes)}::jsonb, 'pending', ${input.createdAt}, ${input.expiresAt},
              ${input.client.clientId}, ${input.redirectUri}, ${input.codeChallenge}, ${input.state}, ${input.resource})
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    return rows.length === 1;
  }

  async continueAuthorization(input: { handleHash: string; codeHash: string; now: Date }): Promise<AuthorizationProgress> {
    const { sql } = getOrgPg();
    const rows = await sql<RequestRow[]>`
      SELECT user_code, state, expires_at, oauth_client_id, oauth_redirect_uri, oauth_state, auth_code_hash
        FROM harness_shared.connected_app_device_grants
       WHERE device_code_hash = ${input.handleHash} AND oauth_client_id IS NOT NULL
       LIMIT 1`;
    const row = rows[0];
    if (!row || row.state === 'consumed') return { status: 'invalid' };
    if (row.expires_at.getTime() <= input.now.getTime()) return { status: 'expired' };
    if (row.state === 'denied') return { status: 'denied', redirectUri: row.oauth_redirect_uri!, state: row.oauth_state };
    if (row.state === 'pending') return { status: 'pending', userCode: row.user_code };
    // approved: mint the code once. A second visit (a replayed continue URL) gets nothing.
    const minted = await sql`
      UPDATE harness_shared.connected_app_device_grants
         SET auth_code_hash = ${input.codeHash},
             auth_code_expires_at = ${new Date(input.now.getTime() + OAUTH_CODE_TTL_MS)}
       WHERE device_code_hash = ${input.handleHash} AND state = 'approved' AND auth_code_hash IS NULL
      RETURNING 1`;
    if (minted.length !== 1) return { status: 'invalid' };
    return { status: 'code', redirectUri: row.oauth_redirect_uri!, state: row.oauth_state };
  }

  async redeemAuthorizationCode(input: {
    codeHash: string;
    client: OAuthClient;
    redirectUri: string;
    codeVerifier: string;
    now: Date;
  }): Promise<AuthorizationCodeRedemption> {
    const { sql } = getOrgPg();
    const rows = await sql<RequestRow[]>`
      SELECT user_code, client_label, requested_scopes, granted_scopes, state, workspace_id, approved_by, expires_at,
             oauth_client_id, oauth_redirect_uri, oauth_code_challenge, oauth_state, auth_code_hash, auth_code_expires_at
        FROM harness_shared.connected_app_device_grants
       WHERE auth_code_hash = ${input.codeHash}
       LIMIT 1`;
    const row = rows[0];
    if (!row || row.state !== 'approved') return { status: 'invalid_grant', reason: 'code is unknown or already used' };
    if (!row.auth_code_expires_at || row.auth_code_expires_at.getTime() <= input.now.getTime()) {
      return { status: 'invalid_grant', reason: 'code has expired' };
    }
    if (row.oauth_client_id !== input.client.clientId) return { status: 'invalid_grant', reason: 'code was issued to another client' };
    if (row.oauth_redirect_uri !== input.redirectUri) return { status: 'invalid_grant', reason: 'redirect_uri does not match' };
    if (!row.oauth_code_challenge || !pkceMatches(input.codeVerifier, row.oauth_code_challenge)) {
      return { status: 'invalid_grant', reason: 'code_verifier does not match the code challenge' };
    }
    let scopes: AppKeyScopes;
    try {
      // The approver's consent is the ceiling (R-37); re-checked against the hard-deny set now.
      scopes = resolveAppKeyScopes(row.granted_scopes ?? row.requested_scopes ?? {});
    } catch (err) {
      if (err instanceof AppKeyScopeError) return { status: 'invalid_scope', problems: err.problems };
      throw err;
    }
    const workspaceId = row.workspace_id!;
    try {
      const issued = await withWorkspace(workspaceId, async (tx) => {
        const created = await insertAppKey(tx, {
          workspaceId,
          userEmail: row.approved_by ?? 'local@desktop',
          label: row.client_label,
          scopes,
        });
        const consumed = await tx`
          UPDATE harness_shared.connected_app_device_grants
             SET state = 'consumed', app_id = ${created.app.id}
           WHERE auth_code_hash = ${input.codeHash} AND state = 'approved'
          RETURNING 1`;
        if (consumed.length !== 1) throw new CodeAlreadyRedeemed();
        return created;
      });
      await sql`UPDATE harness_shared.connected_app_oauth_clients SET last_used_at = ${input.now} WHERE client_id = ${input.client.clientId}`;
      return { status: 'issued', issued, scopes };
    } catch (err) {
      if (err instanceof CodeAlreadyRedeemed) return { status: 'invalid_grant', reason: 'code is unknown or already used' };
      throw err;
    }
  }
}

/** A fresh request handle (the browser's secret for the continue endpoint) and code. */
export function newRequestHandle(random: (size: number) => Uint8Array = randomBytes): string {
  return `${OAUTH_REQUEST_HANDLE_PREFIX}${Buffer.from(random(32)).toString('base64url')}`;
}

export function newAuthorizationCode(random: (size: number) => Uint8Array = randomBytes): string {
  return `pac_${Buffer.from(random(32)).toString('base64url')}`;
}

// ── HTTP helpers shared by the local (P-006) and portal (P-325) authorization servers ────────

export const OAUTH_NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store', pragma: 'no-cache' };

/** An RFC 6749 §5.2 error body. */
export function oauthErrorResponse(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...OAUTH_NO_STORE, ...extra } });
}

/** Append OAuth response parameters to a registered redirect URI (RFC 6749 §4.1.2, RFC 9207 iss). */
export function redirectWithParams(redirectUri: string, params: Record<string, string | null>): Response {
  const target = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) target.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: target.toString(), ...OAUTH_NO_STORE } });
}

/** A form-urlencoded or JSON object body, or null. */
export async function readFormOrJson(req: Request): Promise<Record<string, unknown> | null> {
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
export function readBasicCredentials(req: Request): { id: string; secret: string } | null {
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
