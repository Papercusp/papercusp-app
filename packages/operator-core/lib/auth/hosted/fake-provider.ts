/** Deterministic HostedIdentityProvider implementation for route and adapter tests. */

import {
  hostedIdentityProviderFailure,
  hostedIdentityProviderOk,
  type HostedCallbackExchangeInput,
  type HostedIdentityProvider,
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

export const FAKE_HOSTED_IDENTITY_NOW_MS = 1_700_000_000_000;

export const FAKE_HOSTED_IDENTITY_SESSION: HostedVerifiedIdentitySession = {
  externalSessionId: 'session_test_001',
  identity: {
    externalUserId: 'user_test_001',
    primaryEmail: 'verified@example.test',
    emailVerified: true,
    displayName: 'Verified Test User',
    avatarUrl: 'https://identity.test/avatar/user_test_001',
  },
  externalOrganizationId: 'organization_test_001',
  issuedAtMs: FAKE_HOSTED_IDENTITY_NOW_MS - 60_000,
  authenticatedAtMs: FAKE_HOSTED_IDENTITY_NOW_MS - 30_000,
  expiresAtMs: FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000,
  authenticationMethods: ['pwd', 'mfa'],
  mfaVerified: true,
};

type Awaitable<T> = T | Promise<T>;
type FakeOperation<Input, Output> =
  | HostedIdentityProviderResult<Output>
  | ((input: Input) => Awaitable<HostedIdentityProviderResult<Output>>);

export interface FakeHostedIdentityProviderScript {
  beginSignIn?: FakeOperation<HostedSignInInput, HostedSignInInitiation>;
  exchangeCallback?: FakeOperation<HostedCallbackExchangeInput, HostedVerifiedIdentitySession>;
  validateSession?: FakeOperation<HostedSessionValidationInput, HostedVerifiedIdentitySession>;
  beginLogout?: FakeOperation<HostedLogoutInput, HostedLogoutInitiation>;
  revokeSession?: FakeOperation<HostedSessionRevocationInput, HostedSessionRevocation>;
}

export interface FakeHostedIdentityProviderOptions {
  providerId?: string;
  nowMs?: number;
  session?: HostedVerifiedIdentitySession;
  authorizeUrl?: string;
  logoutUrl?: string;
  script?: FakeHostedIdentityProviderScript;
}

export interface FakeHostedIdentityProviderCalls {
  readonly beginSignIn: HostedSignInInput[];
  readonly exchangeCallback: HostedCallbackExchangeInput[];
  readonly validateSession: HostedSessionValidationInput[];
  readonly beginLogout: HostedLogoutInput[];
  readonly revokeSession: HostedSessionRevocationInput[];
}

function resolveFakeOperation<Input, Output>(
  operation: FakeOperation<Input, Output> | undefined,
  input: Input,
  fallback: () => HostedIdentityProviderResult<Output>,
): Promise<HostedIdentityProviderResult<Output>> {
  if (typeof operation === 'function') return Promise.resolve(operation(input));
  return Promise.resolve(operation ?? fallback());
}

function applyOrganizationHint(url: URL, input: HostedSignInInput): void {
  const hint = input.organizationHint;
  if (!hint) return;
  if (hint.kind === 'external-organization-id') {
    url.searchParams.set('organization_id', hint.externalOrganizationId);
  } else if (hint.kind === 'domain') {
    url.searchParams.set('domain_hint', hint.domain);
  } else {
    url.searchParams.set('login_hint', hint.loginHint);
  }
}

export class FakeHostedIdentityProvider implements HostedIdentityProvider {
  readonly providerId: string;
  readonly calls: FakeHostedIdentityProviderCalls = {
    beginSignIn: [],
    exchangeCallback: [],
    validateSession: [],
    beginLogout: [],
    revokeSession: [],
  };

  private readonly nowMs: number;
  private readonly session: HostedVerifiedIdentitySession;
  private readonly authorizeUrl: string;
  private readonly logoutUrl: string;
  private readonly script: FakeHostedIdentityProviderScript;
  private readonly revokedSessionIds = new Set<string>();

  constructor(options: FakeHostedIdentityProviderOptions = {}) {
    this.providerId = options.providerId ?? 'fake';
    this.nowMs = options.nowMs ?? FAKE_HOSTED_IDENTITY_NOW_MS;
    this.session = options.session ?? FAKE_HOSTED_IDENTITY_SESSION;
    this.authorizeUrl = options.authorizeUrl ?? 'https://identity.test/authorize';
    this.logoutUrl = options.logoutUrl ?? 'https://identity.test/logout';
    this.script = options.script ?? {};
  }

  beginSignIn(
    input: HostedSignInInput,
  ): Promise<HostedIdentityProviderResult<HostedSignInInitiation>> {
    this.calls.beginSignIn.push(input);
    return resolveFakeOperation(this.script.beginSignIn, input, () => {
      const url = new URL(this.authorizeUrl);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      url.searchParams.set('code_challenge', input.pkce.challenge);
      url.searchParams.set('code_challenge_method', input.pkce.method);
      if (input.intent) url.searchParams.set('screen_hint', input.intent);
      applyOrganizationHint(url, input);
      return hostedIdentityProviderOk({ authorizationUrl: url.toString() });
    });
  }

  exchangeCallback(
    input: HostedCallbackExchangeInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>> {
    this.calls.exchangeCallback.push(input);
    return resolveFakeOperation(this.script.exchangeCallback, input, () =>
      hostedIdentityProviderOk(this.session),
    );
  }

  validateSession(
    input: HostedSessionValidationInput,
  ): Promise<HostedIdentityProviderResult<HostedVerifiedIdentitySession>> {
    this.calls.validateSession.push(input);
    return resolveFakeOperation(this.script.validateSession, input, () => {
      if (this.revokedSessionIds.has(input.externalSessionId)) {
        return hostedIdentityProviderFailure({
          code: 'session_revoked',
          safeMessage: 'The hosted identity session has been revoked.',
          retryable: false,
        });
      }
      if (input.externalSessionId !== this.session.externalSessionId) {
        return hostedIdentityProviderFailure({
          code: 'invalid_session',
          safeMessage: 'The hosted identity session is not valid.',
          retryable: false,
        });
      }
      if (this.session.expiresAtMs <= this.nowMs) {
        return hostedIdentityProviderFailure({
          code: 'session_expired',
          safeMessage: 'The hosted identity session has expired.',
          retryable: false,
        });
      }
      return hostedIdentityProviderOk(this.session);
    });
  }

  beginLogout(
    input: HostedLogoutInput,
  ): Promise<HostedIdentityProviderResult<HostedLogoutInitiation>> {
    this.calls.beginLogout.push(input);
    return resolveFakeOperation(this.script.beginLogout, input, () => {
      const url = new URL(this.logoutUrl);
      url.searchParams.set('session_id', input.externalSessionId);
      url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
      return hostedIdentityProviderOk({ logoutUrl: url.toString() });
    });
  }

  async revokeSession(
    input: HostedSessionRevocationInput,
  ): Promise<HostedIdentityProviderResult<HostedSessionRevocation>> {
    this.calls.revokeSession.push(input);
    const result = await resolveFakeOperation(this.script.revokeSession, input, () =>
      hostedIdentityProviderOk({
        externalSessionId: input.externalSessionId,
        revokedAtMs: this.nowMs,
      }),
    );
    if (result.ok) this.revokedSessionIds.add(input.externalSessionId);
    return result;
  }
}

export function createFakeHostedIdentityProvider(
  options: FakeHostedIdentityProviderOptions = {},
): FakeHostedIdentityProvider {
  return new FakeHostedIdentityProvider(options);
}
