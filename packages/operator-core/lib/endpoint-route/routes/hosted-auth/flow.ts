/**
 * Server-owned state for the hosted browser authentication flow.
 *
 * The browser receives only the signed, single-use state token. PKCE verifier,
 * nonce, return target, redirect URI, and the browser-binding digest remain in
 * the existing OAuth nonce row's private context.
 */
import { signState, verifyAndConsumeState } from '../../../oauth/state';

const FLOW_PLUGIN = 'papercusp-hosted-auth';
const FLOW_HARNESS = 'hosted-control-plane';
const FLOW_FIELD = 'browser-session';

export interface HostedAuthFlow {
  readonly providerId: string;
  /** Explicit admission intent; absent is treated as legacy sign-in. */
  readonly intent?: 'sign-in' | 'sign-up';
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly nonce: string;
  readonly pkceCodeVerifier: string;
  readonly browserBindingDigest: string;
}

export type HostedAuthFlowConsumeResult =
  | { readonly ok: true; readonly flow: HostedAuthFlow }
  | {
      readonly ok: false;
      readonly error:
        | 'malformed'
        | 'bad-signature'
        | 'expired'
        | 'unknown-nonce'
        | 'already-consumed'
        | 'wrong-flow'
        | 'invalid-private-context';
    };

export interface HostedAuthFlowStore {
  create(flow: HostedAuthFlow): Promise<string>;
  consume(state: string): Promise<HostedAuthFlowConsumeResult>;
}

/**
 * Adapter over oauth/state.ts. Keeping this injectable lets route tests avoid a
 * database while production reuses the canonical HMAC + atomic nonce-consume
 * implementation instead of growing a parallel state-token system.
 */
export class OAuthHostedAuthFlowStore implements HostedAuthFlowStore {
  constructor(
    private readonly providerId: string,
    private readonly publicOriginHost: string,
  ) {}

  create(flow: HostedAuthFlow): Promise<string> {
    return signState(
      {
        plugin: FLOW_PLUGIN,
        harness: FLOW_HARNESS,
        field: FLOW_FIELD,
        providerHost: this.publicOriginHost,
        provider: this.providerId,
      },
      {
        privateContext: {
          providerId: flow.providerId,
          ...(flow.intent ? { intent: flow.intent } : {}),
          redirectUri: flow.redirectUri,
          returnTo: flow.returnTo,
          nonce: flow.nonce,
          pkceCodeVerifier: flow.pkceCodeVerifier,
          browserBindingDigest: flow.browserBindingDigest,
        },
      },
    );
  }

  async consume(state: string): Promise<HostedAuthFlowConsumeResult> {
    const verified = await verifyAndConsumeState(state);
    if (!verified.ok) {
      return { ok: false, error: verified.error ?? 'malformed' };
    }
    const claims = verified.claims;
    if (
      !claims ||
      claims.plugin !== FLOW_PLUGIN ||
      claims.harness !== FLOW_HARNESS ||
      claims.field !== FLOW_FIELD ||
      claims.provider !== this.providerId ||
      claims.providerHost !== this.publicOriginHost
    ) {
      return { ok: false, error: 'wrong-flow' };
    }

    const context = verified.privateContext;
    const flow: HostedAuthFlow = {
      providerId: context?.providerId ?? '',
      intent: context?.intent === 'sign-up' ? 'sign-up' : 'sign-in',
      redirectUri: context?.redirectUri ?? '',
      returnTo: context?.returnTo ?? '',
      nonce: context?.nonce ?? '',
      pkceCodeVerifier: context?.pkceCodeVerifier ?? '',
      browserBindingDigest: context?.browserBindingDigest ?? '',
    };
    if (Object.values(flow).some((value) => !value)) {
      return { ok: false, error: 'invalid-private-context' };
    }
    return { ok: true, flow };
  }
}
