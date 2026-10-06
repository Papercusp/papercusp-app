/**
 * GET /api/oauth/callback
 *
 * Provider redirects here with code + state. State is HMAC-verified +
 * nonce-consumed; on success the code is exchanged and the token
 * persisted to the plugin's per-harness config. plugin/harness/field
 * come from the verified state, never the URL.
 *
 * Managed connections (Google Workspace, Facebook, and every descriptor
 * provider with `oauth`) run the provider-neutral lifecycle in
 * integrations/connection-lifecycle.ts; this route holds no provider-name
 * branch (P-003).
 *
 * Ported from app/api/oauth/callback/route.ts. `auth: 'public'` — the
 * caller is the OAuth provider's redirect.
 */
import { loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { verifyAndConsumeState } from '../../../oauth/state';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  connectionAdapterFor,
  finishConnection,
  missingRefreshTokenRefusal,
  prepareConnection,
  resolveConnectionOwner,
  resolveOAuthProvider,
  type ConnectionOwner,
  type PreparedConnection,
} from '../../../integrations/connection-lifecycle';
import { ensureBuiltinConnectionAdapters } from '../../../integrations/builtin-connection-adapters';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  ensureBuiltinConnectionAdapters();
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

function redirectWith(reqUrl: string, path: string, key: string, value: string): Response {
  const destination = new URL(path, reqUrl);
  destination.searchParams.set(key, value);
  return Response.redirect(destination.toString(), 307);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function externalBrowserCompletion(key: string, value: string): Response {
  const connected = key === 'oauth_connected';
  const title = connected ? 'Connection complete' : 'Connection not completed';
  const detail = connected
    ? 'Your account is connected. Papercusp will refresh when you return to the app.'
    : `Papercusp could not complete this connection. Error: ${escapeHtml(value.slice(0, 500))}`;
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · Papercusp</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(32rem, calc(100% - 3rem)); }
      p { line-height: 1.55; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${detail}</p>
      <p>You can close this tab and return to Papercusp.</p>
    </main>
  </body>
</html>`;
  return new Response(body, {
    status: connected ? 200 : 400,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

function oauthResultResponse(
  reqUrl: string,
  path: string,
  key: string,
  value: string,
  privateContext?: Readonly<Record<string, string>>,
  legacyJsonStatus?: number,
): Response {
  if (privateContext?.returnMode === 'external-browser') {
    return externalBrowserCompletion(key, value);
  }
  if (legacyJsonStatus !== undefined) {
    return Response.json({ ok: false, error: value }, { status: legacyJsonStatus });
  }
  return redirectWith(reqUrl, path, key, value);
}

function callbackReturnPath(plugin: string, providerId: string, harness: string): string {
  return connectionAdapterFor(plugin, providerId)?.returnPath ?? '/harness/' + encodeURIComponent(harness) + '?panel=config';
}

function requestedScopes(privateContext: Readonly<Record<string, string>> | undefined): string[] {
  const raw = privateContext?.requestedScopes;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
              .map((scope) => scope.trim()),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineTool({
  method: 'GET',
  path: '/oauth/callback',
  auth: 'public',
  async handler(req) {
    await ensureProvidersLoaded();
    const url = new URL(req.url);
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
      if (state) {
        const verified = await verifyAndConsumeState(state);
        if (verified.ok && verified.claims) {
          const path = callbackReturnPath(verified.claims.plugin, verified.claims.provider, verified.claims.harness);
          return oauthResultResponse(req.url, path, 'oauth_error', errorParam, verified.privateContext);
        }
      }
      return redirectWith(req.url, '/harness', 'oauth_error', errorParam);
    }
    if (!code || !state) {
      return Response.json({ ok: false, error: 'code + state required' }, { status: 400 });
    }

    const verified = await verifyAndConsumeState(state);
    if (!verified.ok || !verified.claims) {
      return Response.json({ ok: false, error: `oauth state ${verified.error}` }, { status: 400 });
    }

    const { plugin, harness, field, provider: providerId } = verified.claims;
    const adapter = connectionAdapterFor(plugin, providerId);
    const returnPath = callbackReturnPath(plugin, providerId, harness);
    const fail = (message: string, legacyJsonStatus?: number) =>
      oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext, legacyJsonStatus);
    const provider = await resolveOAuthProvider(providerId);
    if (!provider) return fail(`provider ${providerId} not registered`, 500);

    let owner: ConnectionOwner | null = null;
    if (adapter) {
      try {
        owner = resolveConnectionOwner(adapter, verified.privateContext);
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    }

    let tokens;
    try {
      tokens = await provider.exchangeCode(code, verified.privateContext);
    } catch (e: unknown) {
      return fail(errorMessage(e));
    }

    let prepared: PreparedConnection | null = null;
    if (adapter && owner) {
      try {
        const result = await prepareConnection(getOrgPg().sql, adapter, owner, tokens.accessToken);
        if ('refusal' in result) return fail(result.refusal);
        prepared = result;
      } catch (error) {
        return fail(errorMessage(error));
      }
      const refusal = missingRefreshTokenRefusal(adapter, owner, prepared.previousFields, tokens);
      if (refusal) return fail(refusal);
    }

    const patch: Record<string, unknown> = { [field]: tokens.accessToken };
    if (tokens.refreshToken) patch[`${field}_refresh`] = tokens.refreshToken;
    if (tokens.expiresAt !== undefined) patch[`${field}_expires_at`] = tokens.expiresAt;
    const grantedScopes = tokens.scopes?.length
      ? [...new Set(tokens.scopes.map((scope) => scope.trim()).filter(Boolean))]
      : requestedScopes(verified.privateContext);
    if (grantedScopes.length) patch[`${field}_scopes`] = grantedScopes;
    patch[`${field}_expired`] = false;
    await fsTokenStorage.update(plugin, harness, patch);

    if (adapter && owner && prepared) {
      try {
        await finishConnection(getOrgPg().sql, adapter, {
          owner,
          account: prepared.account,
          field,
          harness,
          previousFields: prepared.previousFields,
          createdBy: `owner:${owner.ownerUserId}`,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }

    return oauthResultResponse(req.url, returnPath, 'oauth_connected', plugin, verified.privateContext);
  },
});
