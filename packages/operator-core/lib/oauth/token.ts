/**
 * `ctx.oauth.token(field)` helper — refresh + 401 retry transparent to plugins.
 *
 * Plugin authors call `ctx.oauth.token('github_token')`. Substrate:
 *   1. Reads stored token + expiry from plugin config.
 *   2. If expired or near-expiry, calls provider.refresh() and writes back.
 *   3. Returns a fresh access token.
 *
 * Concurrent callers share an in-flight refresh Promise (the cache is
 * keyed by `(plugin, harness, field)`), so 10 parallel actions hitting an
 * expired token send ONE refresh request to the provider, not ten.
 *
 * Spec: /docs/snapshots/oauth-integration#refresh-mechanics +
 *       /docs/snapshots/oauth-integration#concurrent-refresh-storm.
 */

import { getProvider, type OAuthProvider } from './providers';

const REFRESH_NEAR_EXPIRY_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export interface TokenStorage {
  /**
   * Read the plugin config for `(plugin, harness)`. Returns the raw config
   * object — the helper will read `field`, `field_refresh`, `field_expires_at`.
   */
  read(plugin: string, harness: string): Promise<Record<string, unknown>>;
  /**
   * Atomically merge `patch` into the plugin's config and persist.
   */
  update(plugin: string, harness: string, patch: Record<string, unknown>): Promise<void>;
}

export interface TokenHelperContext {
  plugin: string;
  harness: string;
  /** Maps a config field name to the OAuth provider it uses. */
  resolveProvider(field: string): { provider: string; scopes?: string[] } | null;
  storage: TokenStorage;
  /** Optional: override Date.now for tests. */
  now?: () => number;
}

interface CachedRefresh {
  promise: Promise<string | null>;
}

const refreshCache = new Map<string, CachedRefresh>();

function cacheKey(plugin: string, harness: string, field: string): string {
  return `${plugin}\0${harness}\0${field}`;
}

/**
 * Acquire a fresh access token. Returns null if no token has been stored
 * (user hasn't connected yet). Throws on refresh failure (caller may
 * surface "reconnect needed").
 */
export async function getOAuthToken(
  ctx: TokenHelperContext,
  field: string,
): Promise<string | null> {
  const key = cacheKey(ctx.plugin, ctx.harness, field);
  const inFlight = refreshCache.get(key);
  if (inFlight) return inFlight.promise;

  const promise = doGetToken(ctx, field).finally(() => {
    refreshCache.delete(key);
  });
  refreshCache.set(key, { promise });
  return promise;
}

async function doGetToken(
  ctx: TokenHelperContext,
  field: string,
): Promise<string | null> {
  const config = await ctx.storage.read(ctx.plugin, ctx.harness);
  const access = config[field];
  const expiresAtRaw = config[`${field}_expires_at`];
  const refresh = config[`${field}_refresh`];

  if (typeof access !== 'string' || access.length === 0) return null;

  const now = ctx.now?.() ?? Date.now();
  const expiresAt = typeof expiresAtRaw === 'number'
    ? expiresAtRaw
    : typeof expiresAtRaw === 'string'
    ? Date.parse(expiresAtRaw)
    : NaN;

  // No expiry recorded — return access token as-is.
  if (!Number.isFinite(expiresAt)) return access;

  // Still fresh.
  if (expiresAt - now > REFRESH_NEAR_EXPIRY_MS) return access;

  // Need to refresh — must have a refresh token.
  if (typeof refresh !== 'string' || refresh.length === 0) {
    // Mark expired so UI can show reconnect button.
    await ctx.storage.update(ctx.plugin, ctx.harness, {
      [`${field}_expired`]: true,
    });
    throw new Error(`oauth: ${field} expired and no refresh token available; reconnect required`);
  }

  const providerSpec = ctx.resolveProvider(field);
  if (!providerSpec) throw new Error(`oauth: no provider declared for field ${field}`);
  const provider = getProvider(providerSpec.provider);
  if (!provider) throw new Error(`oauth: provider ${providerSpec.provider} not registered`);

  const fresh = await provider.refresh(refresh);
  await ctx.storage.update(ctx.plugin, ctx.harness, {
    [field]: fresh.accessToken,
    [`${field}_refresh`]: fresh.refreshToken ?? refresh,
    [`${field}_expires_at`]: fresh.expiresAt ?? null,
    [`${field}_expired`]: false,
  });
  return fresh.accessToken;
}

/**
 * Wrap a provider call in 401-retry-once semantics. Plugins that don't
 * want to use this can call provider directly, but the helper enforces:
 * if the first call returns 401, force a refresh, retry once, propagate.
 */
export async function withRetry<T>(
  ctx: TokenHelperContext,
  field: string,
  call: (token: string) => Promise<{ status: number; result: T }>,
): Promise<T> {
  const token = await getOAuthToken(ctx, field);
  if (!token) throw new Error(`oauth: ${field} not connected`);
  const first = await call(token);
  if (first.status !== 401) return first.result;

  // Force a refresh by clearing the access token's expiry signal.
  await ctx.storage.update(ctx.plugin, ctx.harness, {
    [`${field}_expires_at`]: 0,
  });
  const retryToken = await getOAuthToken(ctx, field);
  if (!retryToken) throw new Error(`oauth: ${field} not connected after refresh`);
  const second = await call(retryToken);
  if (second.status === 401) {
    await ctx.storage.update(ctx.plugin, ctx.harness, {
      [`${field}_expired`]: true,
    });
    throw new Error(`oauth: ${field} still 401 after refresh; reconnect required`);
  }
  return second.result;
}

/** Test-only: clear the in-flight refresh cache. */
export function __resetTokenCacheForTest(): void {
  refreshCache.clear();
}

/** Test-only: count active in-flight refreshes (asserts cache discipline). */
export function __cacheSizeForTest(): number {
  return refreshCache.size;
}

/** Re-export for caller convenience. */
export type { OAuthProvider };
