/**
 * Provider-neutral hosted customer identity contract.
 *
 * The hosted control plane authenticates customers through an upstream
 * identity provider, but Papercusp remains authoritative for organizations,
 * memberships, roles, workspace grants, and entitlements. This seam therefore
 * carries verified identity/session facts only; it must never carry customer
 * credentials or Papercusp authorization grants.
 *
 * Predictable upstream failures are returned as a discriminated result rather
 * than thrown as raw SDK errors. Implementations may log a sanitized internal
 * cause, but only the secret-safe error fields below cross this boundary.
 */

export const HOSTED_IDENTITY_PROVIDER_ERROR_CODES = [
  'configuration_error',
  'invalid_request',
  'invalid_callback',
  'identity_not_verified',
  'invalid_session',
  'session_expired',
  'session_revoked',
  'organization_mismatch',
  'rate_limited',
  'provider_unavailable',
  'provider_error',
] as const;

export type HostedIdentityProviderErrorCode =
  (typeof HOSTED_IDENTITY_PROVIDER_ERROR_CODES)[number];

/** Secret-safe failure details suitable for route responses and audit metadata. */
export interface HostedIdentityProviderError {
  code: HostedIdentityProviderErrorCode;
  /** Human-readable and safe to expose. Never include tokens, codes, or SDK payloads. */
  safeMessage: string;
  retryable: boolean;
  /** Sanitized upstream code, when one is useful for support correlation. */
  providerCode?: string;
  /** Non-secret upstream request id, when supplied by the provider. */
  requestId?: string;
  retryAfterMs?: number;
}

export type HostedIdentityProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HostedIdentityProviderError };

export function hostedIdentityProviderOk<T>(value: T): HostedIdentityProviderResult<T> {
  return { ok: true, value };
}

export function hostedIdentityProviderFailure<T = never>(
  error: HostedIdentityProviderError,
): HostedIdentityProviderResult<T> {
  return { ok: false, error };
}

/** Optional upstream organization routing hint. It never grants local access. */
export type HostedOrganizationHint =
  | { kind: 'external-organization-id'; externalOrganizationId: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'login'; loginHint: string };

export interface HostedPkceChallenge {
  challenge: string;
  method: 'S256';
}

export interface HostedSignInInput {
  redirectUri: string;
  state: string;
  nonce: string;
  pkce: HostedPkceChallenge;
  intent?: 'sign-in' | 'sign-up';
  organizationHint?: HostedOrganizationHint;
}

export interface HostedSignInInitiation {
  authorizationUrl: string;
}

export interface HostedCallbackExchangeInput {
  code: string;
  redirectUri: string;
  pkceCodeVerifier: string;
  /** Nonce recovered from the server-owned flow state and verified upstream. */
  expectedNonce: string;
}

export interface HostedVerifiedIdentity {
  externalUserId: string;
  primaryEmail: string;
  /** A literal true prevents unverified identities from satisfying the contract. */
  emailVerified: true;
  displayName?: string;
  avatarUrl?: string;
}

/** Verified upstream facts. Local authorization is resolved after this boundary. */
export interface HostedVerifiedIdentitySession {
  /** Non-secret provider session reference; never a bearer/access/refresh token. */
  externalSessionId: string;
  identity: HostedVerifiedIdentity;
  /** An upstream routing/lifecycle reference, not a Papercusp membership grant. */
  externalOrganizationId?: string;
  issuedAtMs: number;
  authenticatedAtMs: number;
  expiresAtMs: number;
  /** Provider-neutral authentication-method references (OIDC amr-shaped). */
  authenticationMethods: readonly string[];
  mfaVerified: boolean;
}

export interface HostedSessionValidationInput {
  externalSessionId: string;
}

export interface HostedLogoutInput {
  externalSessionId: string;
  postLogoutRedirectUri: string;
}

export interface HostedLogoutInitiation {
  /** Null when local revocation is sufficient and no upstream redirect is required. */
  logoutUrl: string | null;
}

export type HostedSessionRevocationReason =
  | 'user_logout'
  | 'upstream_revocation'
  | 'membership_revocation'
  | 'security_event'
  | 'administrative';

export interface HostedSessionRevocationInput {
  externalSessionId: string;
  reason: HostedSessionRevocationReason;
}

export interface HostedSessionRevocation {
  externalSessionId: string;
  revokedAtMs: number;
}

/**
 * Hosted identity provider seam used by hosted auth routes and lifecycle sync.
 *
 * Routes own flow-state persistence, state/nonce/PKCE generation, CSRF checks,
 * and safe return-target validation. The provider performs the upstream SDK
 * operation using those server-validated inputs and returns normalized facts.
 */
export interface HostedIdentityProvider {
  readonly providerId: string;

  beginSignIn(
    input: HostedSignInInput,
  ): Promise<HostedIdentityProviderResult<HostedSignInInitiation>>;

  exchangeCallback(
    input: HostedCallbackExchangeInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>>;

  validateSession(
    input: HostedSessionValidationInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>>;

  beginLogout(
    input: HostedLogoutInput,
  ): Promise<HostedIdentityProviderResult<HostedLogoutInitiation>>;

  revokeSession(
    input: HostedSessionRevocationInput,
  ): Promise<HostedIdentityProviderResult<HostedSessionRevocation>>;
}
