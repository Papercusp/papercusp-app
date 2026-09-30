/**
 * OAuth client-credentials grant (external-app-access-to-workspaces-2026-09-29 P-016, design D-022,
 * migration 1261).
 *
 * An unattended app holds a CLIENT: a service key (kind 'service', P-015) switched into
 * client-credentials mode (`setClientCredentialsMode` in ./store.ts). It authenticates at the token
 * endpoint with either
 *   - `client_secret_basic` / `client_secret_post`: client_id = the key id, client_secret = the
 *     full `pcapp_…` key; or
 *   - `private_key_jwt` (RFC 7523): a short-lived assertion signed by the key whose PUBLIC JWK is
 *     registered on the row. Each `jti` is accepted once.
 * and receives a short-lived `pcat_…` access token (R-15: it always expires, default one hour, never
 * after the client itself). The long-lived secret is refused as a bearer (`token_endpoint_only`),
 * so it is only ever sent to the token endpoint.
 *
 * A token request may NARROW the client's scope with the standard `scope` parameter; anything the
 * client does not hold is `invalid_scope` (R-35). Every call with a token re-checks the parent key
 * (./store.ts `accessTokenVerdictOf`, ./enforce.ts), so revoke, pause, expiry and a scope removed
 * from the client all take effect on the next call.
 *
 * Both token endpoints use `handleClientCredentialsGrant`: the local one
 * (routes/connected-apps/oauth.ts) and the machine half of the portal's
 * (routes/connected-apps/oauth.ts `/connected-apps/portal-token`, reached over the P-325 relay).
 */

import { decodeJwt, importJWK, jwtVerify, type JWK } from 'jose';
import { withWorkspace } from '@papercusp/db-org';
import { mintAccessToken } from './key';
import { OAuthScopeError, formatOAuthScope, parseOAuthScope } from './mcp-oauth';
import { CLIENT_ASSERTION_ALGORITHMS } from './mcp-oauth-discovery';
import { toolGroupOf } from './scope-policy';
import { appKeyVerdictOf, loadClientKeyRow, type AppKeyRow, type AppKeyScopes, type StoredAppKeyRow } from './store';

/** How long an access token lives when the client does not expire sooner. */
export const CLIENT_CREDENTIALS_TOKEN_TTL_SEC = 3600;
/** The longest-lived client assertion accepted (RFC 7523 §3: exp "within a short period"). */
export const CLIENT_ASSERTION_MAX_LIFETIME_SEC = 300;
/** Clock skew allowed on an assertion's exp / nbf / iat. */
export const CLIENT_ASSERTION_CLOCK_TOLERANCE_SEC = 30;
export const JWT_BEARER_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** Defined beside the metadata that advertises it, so the two cannot disagree. */
export { CLIENT_ASSERTION_ALGORITHMS };

const CLIENT_ID_RE = /^[A-Za-z0-9]{16}$/;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const PUBLIC_JWK_MEMBERS = ['kty', 'crv', 'n', 'e', 'x', 'y', 'alg', 'kid', 'use'] as const;

export type ClientKeyRow = StoredAppKeyRow & { client_jwk: Record<string, unknown> | null };

// ── scope narrowing (R-35) ────────────────────────────────────────────────────────────────────

/** True when a parent tool entry covers a requested one: exact, or `group:*` over that group. */
function toolEntryCovers(parentEntry: string, requested: string): boolean {
  const p = parentEntry.trim();
  if (p === requested) return true;
  if (!p.endsWith(':*') || requested.endsWith(':*')) return false;
  return requested.includes(':') && toolGroupOf(requested) === p.slice(0, -2);
}

export type NarrowedScopes = { ok: true; scopes: AppKeyScopes } | { ok: false; problem: string };

/**
 * The scopes a token receives: the client's own, narrowed by what the request names. A requested
 * tool must be covered by the client's tool list; a requested harness must be in the client's
 * harness list when it has one (a client with none may be narrowed to any harness). Capabilities
 * are the client's; the scope string cannot name them. Nothing outside the client's scope is ever
 * granted (R-35).
 */
export function narrowClientScopes(client: AppKeyScopes, requested: AppKeyScopes): NarrowedScopes {
  const clientTools = (client.tools ?? []).map((t) => t.trim()).filter(Boolean);
  for (const tool of requested.tools ?? []) {
    if (!clientTools.some((entry) => toolEntryCovers(entry, tool))) {
      return { ok: false, problem: `tool:${tool} is not in this client's scope` };
    }
  }
  const clientHarnesses = (client.harnesses ?? []).map((h) => h.trim()).filter(Boolean);
  if (clientHarnesses.length > 0) {
    for (const harness of requested.harnesses ?? []) {
      if (!clientHarnesses.includes(harness)) return { ok: false, problem: `harness:${harness} is not in this client's scope` };
    }
  }
  const scopes: AppKeyScopes = { capabilities: [...(client.capabilities ?? [])] };
  const tools = requested.tools?.length ? requested.tools : client.tools;
  const harnesses = requested.harnesses?.length ? requested.harnesses : client.harnesses;
  if (tools?.length) scopes.tools = [...tools];
  if (harnesses?.length) scopes.harnesses = [...harnesses];
  return { ok: true, scopes };
}

/** A token's expiry: the TTL from now, never after the client's own expiry (R-15). */
export function accessTokenExpiry(client: Pick<AppKeyRow, 'expires_at'>, now: Date, ttlSec = CLIENT_CREDENTIALS_TOKEN_TTL_SEC): Date {
  const byTtl = now.getTime() + ttlSec * 1000;
  const byClient = client.expires_at ? new Date(client.expires_at).getTime() : Infinity;
  return new Date(Math.min(byTtl, byClient));
}

// ── registered public keys ────────────────────────────────────────────────────────────────────

/** The signing algorithm an assertion must use with this JWK, or null when none is acceptable. */
export function assertionAlgorithmFor(jwk: Record<string, unknown>): (typeof CLIENT_ASSERTION_ALGORITHMS)[number] | null {
  const declared = typeof jwk.alg === 'string' ? jwk.alg : null;
  const fitting =
    jwk.kty === 'RSA' ? ['RS256', 'PS256'] : jwk.kty === 'EC' && jwk.crv === 'P-256' ? ['ES256'] : jwk.kty === 'OKP' && jwk.crv === 'Ed25519' ? ['EdDSA'] : [];
  if (declared) return fitting.includes(declared) ? (declared as (typeof CLIENT_ASSERTION_ALGORITHMS)[number]) : null;
  return (fitting[0] as (typeof CLIENT_ASSERTION_ALGORITHMS)[number] | undefined) ?? null;
}

export type ClientJwkVerdict = { ok: true; jwk: Record<string, unknown> } | { ok: false; problem: string };

/**
 * Check a JWK offered for `private_key_jwt`: an RSA, P-256 or Ed25519 PUBLIC key that parses. A
 * key carrying any private member is refused outright (it would mean the private key was sent to
 * us). Returns only the public members.
 */
export async function validateClientJwk(value: unknown): Promise<ClientJwkVerdict> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'the JWK must be a JSON object' };
  const raw = value as Record<string, unknown>;
  if (PRIVATE_JWK_MEMBERS.some((m) => m in raw)) return { ok: false, problem: 'send only the PUBLIC key; this JWK carries private key material' };
  const alg = assertionAlgorithmFor(raw);
  if (!alg) return { ok: false, problem: 'the JWK must be an RSA, EC P-256 or Ed25519 public key (with a matching alg, if any)' };
  const jwk: Record<string, unknown> = {};
  for (const m of PUBLIC_JWK_MEMBERS) if (raw[m] !== undefined) jwk[m] = raw[m];
  try {
    await importJWK(jwk as JWK, alg);
  } catch {
    return { ok: false, problem: 'the JWK does not parse as a public key' };
  }
  return { ok: true, jwk };
}

// ── the store ─────────────────────────────────────────────────────────────────────────────────

export interface ClientCredentialsStore {
  loadClient(id: string): Promise<ClientKeyRow | null>;
  /** Remember an accepted assertion's jti until it expires. False = already used (a replay). */
  rememberAssertion(input: { appId: string; workspaceId: string; jti: string; expiresAt: Date; now: Date }): Promise<boolean>;
  /** Store a new token's digest; returns the token, shown to the app once. */
  issueToken(input: { app: AppKeyRow; scopes: AppKeyScopes; now: Date; expiresAt: Date }): Promise<string>;
}

export class PostgresClientCredentialsStore implements ClientCredentialsStore {
  loadClient(id: string): Promise<ClientKeyRow | null> {
    return loadClientKeyRow(id);
  }

  async rememberAssertion(input: { appId: string; workspaceId: string; jti: string; expiresAt: Date; now: Date }): Promise<boolean> {
    return withWorkspace(input.workspaceId, async (tx) => {
      await tx`DELETE FROM harness_shared.connected_app_client_assertions WHERE app_id = ${input.appId} AND expires_at < ${input.now}`;
      const rows = await tx`
        INSERT INTO harness_shared.connected_app_client_assertions (app_id, jti, workspace_id, expires_at)
        VALUES (${input.appId}, ${input.jti}, ${input.workspaceId}, ${input.expiresAt})
        ON CONFLICT DO NOTHING
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  async issueToken(input: { app: AppKeyRow; scopes: AppKeyScopes; now: Date; expiresAt: Date }): Promise<string> {
    const minted = mintAccessToken();
    await withWorkspace(input.app.workspace_id, async (tx) => {
      // Expired tokens are dropped when their client next exchanges (D-022).
      await tx`DELETE FROM harness_shared.connected_app_access_tokens WHERE app_id = ${input.app.id} AND expires_at <= ${input.now}`;
      await tx`
        INSERT INTO harness_shared.connected_app_access_tokens (id, token_hash, app_id, workspace_id, scopes, created_at, expires_at)
        VALUES (${minted.id}, ${minted.tokenHash}, ${input.app.id}, ${input.app.workspace_id},
                ${JSON.stringify(input.scopes)}::jsonb, ${input.now}, ${input.expiresAt})`;
    });
    return minted.key;
  }
}

// ── the grant ─────────────────────────────────────────────────────────────────────────────────

export interface ClientCredentialsGrantInput {
  /** The token request's form fields. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** client_secret_basic credentials, if the request carried them. */
  readonly basic: { id: string; secret: string } | null;
  /** The token endpoint URL the request was sent to: an assertion's required `aud`. */
  readonly audience: string;
  readonly now: Date;
  readonly store: ClientCredentialsStore;
}

/** An OAuth token-endpoint answer (RFC 6749 §5.1 / §5.2). The route adds no-store headers. */
export interface TokenEndpointAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const oauthError = (error: string, description: string, status = 400): TokenEndpointAnswer => ({
  status,
  body: { error, error_description: description },
});
const badClient = (description = 'client authentication failed') => oauthError('invalid_client', description, 401);

function field(fields: Readonly<Record<string, unknown>>, name: string): string {
  const v = fields[name];
  return typeof v === 'string' ? v : '';
}

/** The parent-state and mode checks every client authentication shares. */
function clientUsable(row: ClientKeyRow | null, method: 'client_secret' | 'private_key_jwt', now: Date): row is ClientKeyRow {
  if (!row || row.kind !== 'service' || row.client_auth !== method) return false;
  if (row.revoked_at || row.paused_at) return false;
  return !(row.expires_at && new Date(row.expires_at).getTime() <= now.getTime());
}

async function authenticateByAssertion(input: ClientCredentialsGrantInput): Promise<ClientKeyRow | TokenEndpointAnswer> {
  if (field(input.fields, 'client_assertion_type') !== JWT_BEARER_ASSERTION_TYPE) {
    return oauthError('invalid_request', `client_assertion_type must be ${JWT_BEARER_ASSERTION_TYPE}`);
  }
  const assertion = field(input.fields, 'client_assertion');
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(assertion);
  } catch {
    return badClient('client_assertion is not a JWT');
  }
  const clientId = field(input.fields, 'client_id') || (typeof claims.iss === 'string' ? claims.iss : '');
  if (!CLIENT_ID_RE.test(clientId)) return badClient();
  const row = await input.store.loadClient(clientId);
  if (!clientUsable(row, 'private_key_jwt', input.now) || !row.client_jwk) return badClient();
  const alg = assertionAlgorithmFor(row.client_jwk);
  if (!alg) return badClient();
  let verified: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const key = await importJWK(row.client_jwk as JWK, alg);
    ({ payload: verified } = await jwtVerify(assertion, key, {
      algorithms: [alg],
      issuer: clientId,
      subject: clientId,
      audience: input.audience,
      requiredClaims: ['exp', 'jti'],
      currentDate: input.now,
      clockTolerance: CLIENT_ASSERTION_CLOCK_TOLERANCE_SEC,
    }));
  } catch {
    return badClient('client_assertion did not verify');
  }
  const exp = (verified.exp as number) * 1000;
  if (exp - input.now.getTime() > (CLIENT_ASSERTION_MAX_LIFETIME_SEC + CLIENT_ASSERTION_CLOCK_TOLERANCE_SEC) * 1000) {
    return badClient(`client_assertion must expire within ${CLIENT_ASSERTION_MAX_LIFETIME_SEC} seconds`);
  }
  const jti = typeof verified.jti === 'string' ? verified.jti : '';
  if (!jti || jti.length > 200) return badClient('client_assertion needs a jti');
  const fresh = await input.store.rememberAssertion({
    appId: row.id,
    workspaceId: row.workspace_id,
    jti,
    expiresAt: new Date(Math.max(exp, input.now.getTime()) + CLIENT_ASSERTION_CLOCK_TOLERANCE_SEC * 1000),
    now: input.now,
  });
  return fresh ? row : badClient('client_assertion was already used');
}

async function authenticateBySecret(input: ClientCredentialsGrantInput): Promise<ClientKeyRow | TokenEndpointAnswer> {
  const posted = field(input.fields, 'client_secret');
  // RFC 6749 §2.3: a client MUST NOT use more than one authentication method per request.
  if (input.basic && posted) return oauthError('invalid_request', 'use one client authentication method');
  const id = input.basic?.id ?? field(input.fields, 'client_id');
  const secret = input.basic?.secret ?? posted;
  if (!CLIENT_ID_RE.test(id) || !secret) return badClient();
  const row = await input.store.loadClient(id);
  if (!clientUsable(row, 'client_secret', input.now)) return badClient();
  const verdict = appKeyVerdictOf(row, secret, input.now, { at: 'token-endpoint' });
  if (!verdict.ok || verdict.app.id !== id) return badClient();
  return row;
}

/**
 * Serve one `grant_type=client_credentials` token request. Never throws for a bad request; a
 * store failure propagates (the route answers 500 rather than issuing).
 */
export async function handleClientCredentialsGrant(input: ClientCredentialsGrantInput): Promise<TokenEndpointAnswer> {
  if (field(input.fields, 'grant_type') !== 'client_credentials') {
    return oauthError('unsupported_grant_type', 'this handler serves grant_type=client_credentials');
  }
  const client = field(input.fields, 'client_assertion') || field(input.fields, 'client_assertion_type')
    ? await authenticateByAssertion(input)
    : await authenticateBySecret(input);
  if ('status' in client) return client;

  let requested: AppKeyScopes;
  try {
    requested = parseOAuthScope(field(input.fields, 'scope'));
  } catch (err) {
    if (err instanceof OAuthScopeError) return oauthError('invalid_scope', err.message);
    throw err;
  }
  const narrowed = narrowClientScopes(client.scopes ?? {}, requested);
  if (!narrowed.ok) return oauthError('invalid_scope', narrowed.problem);

  const expiresAt = accessTokenExpiry(client, input.now);
  const token = await input.store.issueToken({ app: client, scopes: narrowed.scopes, now: input.now, expiresAt });
  return {
    status: 200,
    body: {
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((expiresAt.getTime() - input.now.getTime()) / 1000)),
      scope: formatOAuthScope(narrowed.scopes),
    },
  };
}
