/** WorkOS AuthKit adapter for the provider-neutral hosted identity seam. */

import {
  WorkOS,
  type AuthenticateWithCodeOptions,
  type AuthenticateWithSessionCookieFailedResponse,
  type AuthenticateWithSessionCookieSuccessResponse,
  type AuthenticationResponse,
  type LogoutURLOptions,
  type RevokeSessionOptions,
  type UserManagementAuthorizationURLOptions,
} from '@workos-inc/node';
import {
  hostedIdentityProviderFailure,
  hostedIdentityProviderOk,
  type HostedCallbackExchangeInput,
  type HostedIdentityProvider,
  type HostedIdentityProviderError,
  type HostedIdentityProviderErrorCode,
  type HostedIdentityProviderResult,
  type HostedLogoutInitiation,
  type HostedLogoutInput,
  type HostedSessionRevocation,
  type HostedSessionRevocationInput,
  type HostedSessionValidationInput,
  type HostedSignInInitiation,
  type HostedSignInInput,
  type HostedVerifiedIdentitySession,
} from './provider';
import {
  resolveWorkOSHostedIdentityConfiguration,
  WORKOS_HOSTED_IDENTITY_PROVIDER_ID,
  WorkOSHostedIdentityConfigurationError,
  type ResolvedWorkOSHostedIdentityConfiguration,
  type WorkOSHostedIdentityConfiguration,
  type WorkOSHostedIdentitySecretResolver,
} from './workos-config';

type WorkOSSessionAuthentication =
  | AuthenticateWithSessionCookieSuccessResponse
  | AuthenticateWithSessionCookieFailedResponse;

export interface WorkOSUserManagementClientLike {
  getAuthorizationUrl(options: UserManagementAuthorizationURLOptions): string;
  authenticateWithCode(options: AuthenticateWithCodeOptions): Promise<AuthenticationResponse>;
  loadSealedSession(options: { sessionData: string; cookiePassword: string }): {
    authenticate(): Promise<WorkOSSessionAuthentication>;
    /** Renews the access token with the session's refresh token; reseals on success. */
    refresh(options?: { cookiePassword?: string }): Promise<
      { authenticated: true; sealedSession?: string } | { authenticated: false; reason?: string }
    >;
  };
  getLogoutUrl(options: LogoutURLOptions): string;
  revokeSession(options: RevokeSessionOptions): Promise<void>;
}

export interface WorkOSClientLike {
  readonly userManagement: WorkOSUserManagementClientLike;
}

export type WorkOSClientFactory = (
  configuration: Pick<ResolvedWorkOSHostedIdentityConfiguration, 'apiKey' | 'clientId'>,
) => WorkOSClientLike;

/** Encrypted upstream session data belongs in an injected secret-bearing store. */
export interface WorkOSSealedSessionRecord {
  externalSessionId: string;
  sealedSession: string;
  expiresAtMs: number;
}

export interface WorkOSSealedSessionVault {
  get(externalSessionId: string): Promise<WorkOSSealedSessionRecord | null>;
  put(record: WorkOSSealedSessionRecord): Promise<void>;
  delete(externalSessionId: string): Promise<void>;
}

export interface WorkOSHostedIdentityProviderOptions {
  configuration: WorkOSHostedIdentityConfiguration;
  resolveSecret: WorkOSHostedIdentitySecretResolver;
  sessionVault: WorkOSSealedSessionVault;
  /** Injection seam for deterministic tests; production uses the official SDK. */
  createClient?: WorkOSClientFactory;
  now?: () => number;
}

type WorkOSOperation =
  | 'begin-sign-in'
  | 'exchange-callback'
  | 'validate-session'
  | 'begin-logout'
  | 'revoke-session';

interface WorkOSAccessTokenClaims {
  sid: string;
  iat: number;
  exp: number;
  authTime: number;
  nonce?: string;
  amr: string[];
}

class NormalizedProviderFailure extends Error {
  readonly name = 'NormalizedProviderFailure';

  constructor(readonly providerError: HostedIdentityProviderError) {
    super(providerError.safeMessage);
  }
}

function failure(
  code: HostedIdentityProviderErrorCode,
  safeMessage: string,
  retryable = false,
): NormalizedProviderFailure {
  return new NormalizedProviderFailure({ code, safeMessage, retryable });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function safeCorrelation(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return undefined;
  return value;
}

function numericStatus(record: Record<string, unknown> | null): number | undefined {
  const value = record?.status ?? record?.statusCode;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function mapWorkOSError(operation: WorkOSOperation, cause: unknown): HostedIdentityProviderError {
  if (cause instanceof NormalizedProviderFailure) return cause.providerError;
  if (cause instanceof WorkOSHostedIdentityConfigurationError) {
    return {
      code: 'configuration_error',
      safeMessage: 'Hosted identity is not configured.',
      retryable: false,
      providerCode: cause.code,
    };
  }

  const record = asRecord(cause);
  const status = numericStatus(record);
  const providerCode = safeCorrelation(record?.code ?? record?.error);
  const requestId = safeCorrelation(record?.requestID ?? record?.requestId);
  const retryAfter = record?.retryAfter;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.round(retryAfter * 1_000)
      : undefined;
  const shared = { providerCode, requestId, retryAfterMs };

  if (status === 429) {
    return {
      code: 'rate_limited',
      safeMessage: 'Hosted identity is temporarily rate limited.',
      retryable: true,
      ...shared,
    };
  }
  if ((status !== undefined && status >= 500) || record?.name === 'TypeError') {
    return {
      code: 'provider_unavailable',
      safeMessage: 'Hosted identity is temporarily unavailable.',
      retryable: true,
      ...shared,
    };
  }
  if (operation === 'exchange-callback' && status !== undefined && status >= 400) {
    return {
      code: 'invalid_callback',
      safeMessage: 'The hosted identity callback is not valid.',
      retryable: false,
      ...shared,
    };
  }
  if (operation === 'validate-session') {
    return {
      code: 'invalid_session',
      safeMessage: 'The hosted identity session is not valid.',
      retryable: false,
      ...shared,
    };
  }
  if (operation === 'begin-sign-in' && status !== undefined && status >= 400 && status < 500) {
    return {
      code: 'invalid_request',
      safeMessage: 'The hosted sign-in request is not valid.',
      retryable: false,
      ...shared,
    };
  }
  return {
    code: 'provider_error',
    safeMessage: 'Hosted identity could not complete the request.',
    retryable: false,
    ...shared,
  };
}

function decodeVerifiedAccessToken(accessToken: string): WorkOSAccessTokenClaims {
  const parts = accessToken.split('.');
  if (parts.length !== 3) {
    throw failure('invalid_session', 'The hosted identity session is not valid.');
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = asRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw failure('invalid_session', 'The hosted identity session is not valid.');
  }
  if (!payload) throw failure('invalid_session', 'The hosted identity session is not valid.');

  const sid = payload.sid;
  const iat = payload.iat;
  const exp = payload.exp;
  const authTime = payload.auth_time ?? iat;
  if (
    typeof sid !== 'string' ||
    sid.length === 0 ||
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    typeof authTime !== 'number' ||
    !Number.isFinite(authTime)
  ) {
    throw failure('invalid_session', 'The hosted identity session is not valid.');
  }

  const amr = Array.isArray(payload.amr)
    ? payload.amr.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  return {
    sid,
    iat,
    exp,
    authTime,
    nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
    amr,
  };
}

function normalizeMethod(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .toLowerCase();
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeVerifiedSession(
  authenticated: AuthenticateWithSessionCookieSuccessResponse,
  nowMs: number,
  expectedNonce?: string,
): HostedVerifiedIdentitySession {
  const claims = decodeVerifiedAccessToken(authenticated.accessToken);
  if (claims.sid !== authenticated.sessionId) {
    throw failure('invalid_session', 'The hosted identity session is not valid.');
  }
  // WorkOS Staging AuthKit currently omits `nonce` from otherwise-valid sealed
  // password sessions even when the authorization URL carries `claim_nonce`.
  // The callback route has already consumed signed single-use state, matched
  // the browser-binding digest, and the exchange above validated the exact PKCE
  // verifier. Preserve nonce mismatch detection when WorkOS emits the claim,
  // but do not turn its observed omission into a universal login failure.
  if (
    expectedNonce !== undefined &&
    claims.nonce !== undefined &&
    claims.nonce !== expectedNonce
  ) {
    throw failure('invalid_callback', 'The hosted identity callback is not valid.');
  }
  if (authenticated.user.emailVerified !== true) {
    throw failure('identity_not_verified', 'A verified email address is required.');
  }

  const issuedAtMs = Math.round(claims.iat * 1_000);
  const authenticatedAtMs = Math.round(claims.authTime * 1_000);
  const expiresAtMs = Math.round(claims.exp * 1_000);
  if (expiresAtMs <= nowMs) {
    throw failure('session_expired', 'The hosted identity session has expired.');
  }

  const externalUserId = nonEmpty(authenticated.user.id);
  const primaryEmail = nonEmpty(authenticated.user.email);
  if (!externalUserId || !primaryEmail) {
    throw failure('identity_not_verified', 'A verified hosted identity is required.');
  }

  const methods = new Set(claims.amr.map(normalizeMethod));
  if (authenticated.authenticationMethod) {
    methods.add(normalizeMethod(authenticated.authenticationMethod));
  }
  const displayName =
    nonEmpty(authenticated.user.name) ??
    nonEmpty([authenticated.user.firstName, authenticated.user.lastName].filter(Boolean).join(' '));

  return {
    externalSessionId: authenticated.sessionId,
    identity: {
      externalUserId,
      primaryEmail,
      emailVerified: true,
      ...(displayName ? { displayName } : {}),
      ...(nonEmpty(authenticated.user.profilePictureUrl)
        ? { avatarUrl: authenticated.user.profilePictureUrl as string }
        : {}),
    },
    ...(nonEmpty(authenticated.organizationId)
      ? { externalOrganizationId: authenticated.organizationId as string }
      : {}),
    issuedAtMs,
    authenticatedAtMs,
    expiresAtMs,
    authenticationMethods: [...methods],
    mfaVerified: methods.has('mfa'),
  };
}

function organizationOptions(input: HostedSignInInput): Partial<UserManagementAuthorizationURLOptions> {
  const hint = input.organizationHint;
  if (!hint) return {};
  if (hint.kind === 'external-organization-id') {
    return { organizationId: hint.externalOrganizationId };
  }
  if (hint.kind === 'domain') return { domainHint: hint.domain };
  return { loginHint: hint.loginHint };
}

function defaultCreateClient(
  configuration: Pick<ResolvedWorkOSHostedIdentityConfiguration, 'apiKey' | 'clientId'>,
): WorkOSClientLike {
  return new WorkOS({ apiKey: configuration.apiKey, clientId: configuration.clientId });
}

export class WorkOSHostedIdentityProvider implements HostedIdentityProvider {
  readonly providerId = WORKOS_HOSTED_IDENTITY_PROVIDER_ID;

  private readonly configuration: WorkOSHostedIdentityConfiguration;
  private readonly resolveSecret: WorkOSHostedIdentitySecretResolver;
  private readonly sessionVault: WorkOSSealedSessionVault;
  private readonly createClient: WorkOSClientFactory;
  private readonly now: () => number;

  constructor(options: WorkOSHostedIdentityProviderOptions) {
    this.configuration = options.configuration;
    this.resolveSecret = options.resolveSecret;
    this.sessionVault = options.sessionVault;
    this.createClient = options.createClient ?? defaultCreateClient;
    this.now = options.now ?? Date.now;
  }

  private async operationContext(): Promise<{
    client: WorkOSClientLike;
    configuration: ResolvedWorkOSHostedIdentityConfiguration;
  }> {
    const configuration = await resolveWorkOSHostedIdentityConfiguration(
      this.configuration,
      this.resolveSecret,
    );
    return {
      client: this.createClient({
        apiKey: configuration.apiKey,
        clientId: configuration.clientId,
      }),
      configuration,
    };
  }

  async beginSignIn(
    input: HostedSignInInput,
  ): Promise<HostedIdentityProviderResult<HostedSignInInitiation>> {
    try {
      const { client, configuration } = await this.operationContext();
      const authorizationUrl = client.userManagement.getAuthorizationUrl({
        clientId: configuration.clientId,
        provider: 'authkit',
        redirectUri: input.redirectUri,
        state: input.state,
        claimNonce: input.nonce,
        codeChallenge: input.pkce.challenge,
        codeChallengeMethod: input.pkce.method,
        ...(input.intent ? { screenHint: input.intent } : {}),
        ...organizationOptions(input),
      });
      return hostedIdentityProviderOk({ authorizationUrl });
    } catch (cause) {
      return hostedIdentityProviderFailure(mapWorkOSError('begin-sign-in', cause));
    }
  }

  async exchangeCallback(
    input: HostedCallbackExchangeInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>> {
    try {
      const { client, configuration } = await this.operationContext();
      const response = await client.userManagement.authenticateWithCode({
        clientId: configuration.clientId,
        code: input.code,
        codeVerifier: input.pkceCodeVerifier,
        session: { sealSession: true, cookiePassword: configuration.cookiePassword },
      });
      if (!response.sealedSession) {
        throw failure('invalid_callback', 'The hosted identity callback is not valid.');
      }
      const authenticated = await client.userManagement
        .loadSealedSession({
          sessionData: response.sealedSession,
          cookiePassword: configuration.cookiePassword,
        })
        .authenticate();
      if (!authenticated.authenticated) {
        throw failure('invalid_callback', 'The hosted identity callback is not valid.');
      }
      const session = normalizeVerifiedSession(authenticated, this.now(), input.expectedNonce);
      await this.sessionVault.put({
        externalSessionId: session.externalSessionId,
        sealedSession: response.sealedSession,
        expiresAtMs: session.expiresAtMs,
      });
      return hostedIdentityProviderOk(session);
    } catch (cause) {
      return hostedIdentityProviderFailure(mapWorkOSError('exchange-callback', cause));
    }
  }

  async validateSession(
    input: HostedSessionValidationInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>> {
    try {
      const record = await this.sessionVault.get(input.externalSessionId);
      if (!record || record.externalSessionId !== input.externalSessionId) {
        throw failure('invalid_session', 'The hosted identity session is not valid.');
      }

      const { client, configuration } = await this.operationContext();
      const load = (sessionData: string) =>
        client.userManagement.loadSealedSession({ sessionData, cookiePassword: configuration.cookiePassword });
      let sealedSession = record.sealedSession;
      let authenticated: WorkOSSessionAuthentication | null =
        record.expiresAtMs > this.now() ? await load(sealedSession).authenticate() : null;
      if (!authenticated?.authenticated) {
        // The access token inside lives about five minutes; the WorkOS session behind it
        // lives far longer. Renew with the session's refresh token. WorkOS stays the
        // authority: a signed-out, revoked or ended session refuses the refresh, and the
        // session route then ends ours. Before this, every hosted sign-in lasted five minutes.
        const refreshed = await load(sealedSession).refresh({ cookiePassword: configuration.cookiePassword });
        if (!refreshed.authenticated || !refreshed.sealedSession) {
          await this.sessionVault.delete(input.externalSessionId);
          throw failure('session_expired', 'The hosted identity session has expired.');
        }
        sealedSession = refreshed.sealedSession;
        authenticated = await load(sealedSession).authenticate();
      }
      if (!authenticated.authenticated) {
        throw failure('invalid_session', 'The hosted identity session is not valid.');
      }
      const session = normalizeVerifiedSession(authenticated, this.now());
      if (session.externalSessionId !== input.externalSessionId) {
        throw failure('invalid_session', 'The hosted identity session is not valid.');
      }
      if (sealedSession !== record.sealedSession) {
        await this.sessionVault.put({
          externalSessionId: session.externalSessionId,
          sealedSession,
          expiresAtMs: session.expiresAtMs,
        });
      }
      return hostedIdentityProviderOk(session);
    } catch (cause) {
      return hostedIdentityProviderFailure(mapWorkOSError('validate-session', cause));
    }
  }

  async beginLogout(
    input: HostedLogoutInput,
  ): Promise<HostedIdentityProviderResult<HostedLogoutInitiation>> {
    try {
      const { client } = await this.operationContext();
      return hostedIdentityProviderOk({
        logoutUrl: client.userManagement.getLogoutUrl({
          sessionId: input.externalSessionId,
          returnTo: input.postLogoutRedirectUri,
        }),
      });
    } catch (cause) {
      return hostedIdentityProviderFailure(mapWorkOSError('begin-logout', cause));
    }
  }

  async revokeSession(
    input: HostedSessionRevocationInput,
  ): Promise<HostedIdentityProviderResult<HostedSessionRevocation>> {
    let upstreamFailure: unknown;
    let vaultFailure: unknown;
    try {
      const { client } = await this.operationContext();
      await client.userManagement.revokeSession({ sessionId: input.externalSessionId });
    } catch (cause) {
      upstreamFailure = cause;
    }
    try {
      await this.sessionVault.delete(input.externalSessionId);
    } catch (cause) {
      vaultFailure = cause;
    }

    if (upstreamFailure) {
      return hostedIdentityProviderFailure(mapWorkOSError('revoke-session', upstreamFailure));
    }
    if (vaultFailure) {
      return hostedIdentityProviderFailure({
        code: 'provider_unavailable',
        safeMessage: 'Hosted identity session storage is temporarily unavailable.',
        retryable: true,
      });
    }
    return hostedIdentityProviderOk({
      externalSessionId: input.externalSessionId,
      revokedAtMs: this.now(),
    });
  }
}

export function createWorkOSHostedIdentityProvider(
  options: WorkOSHostedIdentityProviderOptions,
): WorkOSHostedIdentityProvider {
  return new WorkOSHostedIdentityProvider(options);
}
