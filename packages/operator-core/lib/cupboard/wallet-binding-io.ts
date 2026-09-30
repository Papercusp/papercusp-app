/**
 * Hosted transport for `cupboard:bind-wallet` (P-029).
 *
 * The Worker authenticates the GitHub bearer and owns D1 persistence. This
 * desktop-side seam deliberately accepts no principal id and no address lookup:
 * identity comes only from the bearer, and a wallet enters the system only
 * through a signed server challenge.
 */
import { resolveCupboardBaseUrl } from './base-url';

export const WALLET_BINDING_CHALLENGE_PATH = '/commerce/wallet-bindings/challenges';
export const WALLET_BINDING_PATH = '/commerce/wallet-bindings';
export const WALLET_BINDING_ME_PATH = '/commerce/wallet-bindings/me';

export interface WalletBindingTransportDeps {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly authToken?: string;
}

export type WalletBindingHostedResult =
  | { readonly ok: true; readonly status: number; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly detail: string | null;
    };

async function githubToken(override: string | undefined): Promise<string | null> {
  if (override !== undefined) return override;
  const { getGhAuthToken } = await import('../identity/gh-token');
  const resolved = await getGhAuthToken();
  return resolved.kind === 'ok' ? resolved.token : null;
}

async function hostedRequest(
  path: string,
  init: RequestInit,
  deps: WalletBindingTransportDeps,
): Promise<WalletBindingHostedResult> {
  const token = await githubToken(deps.authToken);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'gh_auth_required',
      detail: 'no GitHub token is available to authenticate the wallet-binding request',
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'transport_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const value =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof value.error === 'string' ? value.error : `http_${response.status}`,
      detail: typeof value.detail === 'string' ? value.detail : null,
    };
  }
  return { ok: true, status: response.status, value };
}

export function requestWalletBindingChallenge(
  input: { walletAddress: string; chainId?: number },
  deps: WalletBindingTransportDeps = {},
): Promise<WalletBindingHostedResult> {
  return hostedRequest(
    WALLET_BINDING_CHALLENGE_PATH,
    {
      method: 'POST',
      body: JSON.stringify({
        walletAddress: input.walletAddress,
        ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
      }),
    },
    deps,
  );
}

export function submitWalletBinding(
  input: { challengeId: string; signature: string },
  deps: WalletBindingTransportDeps = {},
): Promise<WalletBindingHostedResult> {
  return hostedRequest(
    WALLET_BINDING_PATH,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    deps,
  );
}

export function readWalletBinding(
  deps: WalletBindingTransportDeps = {},
): Promise<WalletBindingHostedResult> {
  return hostedRequest(WALLET_BINDING_ME_PATH, { method: 'GET' }, deps);
}

export function unbindWallet(
  deps: WalletBindingTransportDeps = {},
): Promise<WalletBindingHostedResult> {
  return hostedRequest(WALLET_BINDING_ME_PATH, { method: 'DELETE' }, deps);
}
