/**
 * GET /api/oauth/callback
 *
 * Provider redirects here with code + state. State is HMAC-verified +
 * nonce-consumed; on success the code is exchanged and the token
 * persisted to the plugin's per-harness config. plugin/harness/field
 * come from the verified state, never the URL.
 *
 * Ported from app/api/oauth/callback/route.ts. `auth: 'public'` — the
 * caller is the OAuth provider's redirect.
 */
import { getProvider, loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { verifyAndConsumeState } from '../../../oauth/state';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  assertGoogleWorkspaceOwnerUserId,
  googleWorkspaceOAuthField,
  googleWorkspaceSourceAccountId,
  isGoogleWorkspaceProvisionalProviderAccountId,
  provisionOwnedGoogleWorkspaceSources,
  resolveGoogleWorkspaceProviderAccount,
} from '../../../external-triggers/google-workspace';
import {
  listOwnedExternalTriggerSources,
  renameOwnedExternalTriggerSourceAccount,
} from '../../../external-triggers/source-store';
import { ensureGmailRespondDraftBinding } from '../../../external-triggers/gmail-flagship';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  assertFacebookPersonalVaultOwnerUserId,
  provisionOwnedFacebookPersonalVaultSource,
  resolveFacebookPersonalVaultProviderAccount,
} from '../../../external-triggers/facebook';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
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
  if (
    (providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN) ||
    (providerId === 'facebook' && plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN)
  ) {
    return '/settings/personal-vault';
  }
  return '/harness/' + encodeURIComponent(harness) + '?panel=config';
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
    const returnPath = callbackReturnPath(plugin, providerId, harness);
    const provider = getProvider(providerId);
    if (!provider) {
      return oauthResultResponse(
        req.url,
        returnPath,
        'oauth_error',
        `provider ${providerId} not registered`,
        verified.privateContext,
        500,
      );
    }

    const connectsGoogleWorkspace = providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN;
    const connectsFacebookPersonalVault = providerId === 'facebook' && plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN;
    let googleOwner: {
      ownerUserId: string;
      workspaceId: string;
      reconnectProviderAccountId: string | null;
    } | null = null;
    let facebookOwner: {
      ownerUserId: string;
      workspaceId: string;
      reconnectProviderAccountId: string | null;
    } | null = null;
    if (connectsGoogleWorkspace) {
      try {
        const ownerUserId = assertGoogleWorkspaceOwnerUserId(verified.privateContext?.ownerUserId);
        const workspaceId = verified.privateContext?.workspaceId?.trim() ?? '';
        if (!workspaceId) throw new Error('google_workspace_workspace_id_required');
        googleOwner = {
          ownerUserId,
          workspaceId,
          reconnectProviderAccountId: verified.privateContext?.reconnectProviderAccountId?.trim() || null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext, 400);
      }
    }
    if (connectsFacebookPersonalVault) {
      try {
        const ownerUserId = assertFacebookPersonalVaultOwnerUserId(verified.privateContext?.ownerUserId);
        const workspaceId = verified.privateContext?.workspaceId?.trim() ?? '';
        if (!workspaceId) throw new Error('facebook_personal_vault_workspace_id_required');
        facebookOwner = {
          ownerUserId,
          workspaceId,
          reconnectProviderAccountId: verified.privateContext?.reconnectProviderAccountId?.trim() || null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext, 400);
      }
    }

    let tokens;
    try {
      tokens = await provider.exchangeCode(code, verified.privateContext);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return oauthResultResponse(req.url, returnPath, 'oauth_error', msg, verified.privateContext);
    }

    let googleProviderAccountId: string | null = null;
    let googlePreviousFields: string[] = [];
    if (googleOwner) {
      try {
        const resolved = await resolveGoogleWorkspaceProviderAccount(tokens.accessToken);
        googleProviderAccountId = resolved.providerAccountId;
        const expected = googleOwner.reconnectProviderAccountId;
        if (expected && expected !== resolved.providerAccountId) {
          const provisional =
            expected.startsWith(`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:`) || expected.startsWith('legacy-owner:');
          if (!provisional) {
            return oauthResultResponse(
              req.url,
              returnPath,
              'oauth_error',
              'google_workspace_account_mismatch',
              verified.privateContext,
            );
          }
          await renameOwnedExternalTriggerSourceAccount(getOrgPg().sql, {
            workspaceId: googleOwner.workspaceId,
            ownerUserId: googleOwner.ownerUserId,
            previousProviderAccountId: expected,
            providerAccountId: resolved.providerAccountId,
          });
        }
        let owned = await listOwnedExternalTriggerSources(
          getOrgPg().sql,
          googleOwner.workspaceId,
          googleOwner.ownerUserId,
        );
        let reconciledProvisionalAccount = false;
        const provisionalAccountIds = [
          ...new Set(
            owned
              .filter((source) => {
                const providerAccountId = source.providerAccountId?.trim() ?? '';
                return (
                  Boolean(providerAccountId) &&
                  providerAccountId !== resolved.providerAccountId &&
                  isGoogleWorkspaceProvisionalProviderAccountId(providerAccountId) &&
                  googleWorkspaceSourceAccountId(source, owned) === resolved.providerAccountId
                );
              })
              .map((source) => source.providerAccountId!.trim()),
          ),
        ];
        const directCanonicalSources = owned.filter(
          (source) =>
            source.providerAccountId?.trim() === resolved.providerAccountId && source.credentialRef !== null,
        );
        // Older rows may have persisted the Gmail cursor's canonical email while
        // retaining `google-workspace:<field>` as providerAccountId. Adopt that
        // identity before provisioning the new OAuth field; otherwise upsert
        // creates a second canonical row and Personal Vault exposes the old row
        // as a ghost account. Only reconcile an unambiguous provisional group.
        if (!expected && directCanonicalSources.length === 0 && provisionalAccountIds.length === 1) {
          await renameOwnedExternalTriggerSourceAccount(getOrgPg().sql, {
            workspaceId: googleOwner.workspaceId,
            ownerUserId: googleOwner.ownerUserId,
            previousProviderAccountId: provisionalAccountIds[0]!,
            providerAccountId: resolved.providerAccountId,
          });
          reconciledProvisionalAccount = true;
          owned = await listOwnedExternalTriggerSources(
            getOrgPg().sql,
            googleOwner.workspaceId,
            googleOwner.ownerUserId,
          );
        }
        googlePreviousFields = [
          ...new Set(
            owned
              .filter(
                (source) =>
                  googleWorkspaceSourceAccountId(source, owned) === resolved.providerAccountId &&
                  source.credentialRef !== null,
              )
              .map((source) => googleWorkspaceOAuthField(source.credentialRef)),
          ),
        ];
        // The mismatch guard above only covers RECONNECT (it needs an `expected`
        // account to compare against). An add-account flow carries no `expected`,
        // so without this a consent screen that came back with the account that is
        // already connected would be written under the freshly allocated field from
        // oauth/start — a second credential slot pointing at the same mailbox, with
        // no error surfaced to the owner. Refuse instead: the owner picked the wrong
        // account in the chooser, and the honest repair is to run it again.
        if (!expected && googlePreviousFields.length > 0 && !reconciledProvisionalAccount) {
          return oauthResultResponse(
            req.url,
            returnPath,
            'oauth_error',
            'google_workspace_account_already_connected',
            verified.privateContext,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext);
      }
    }

    let facebookProviderAccount: { providerAccountId: string; displayName: string } | null = null;
    let facebookPreviousFields: string[] = [];
    if (facebookOwner) {
      try {
        facebookProviderAccount = await resolveFacebookPersonalVaultProviderAccount(tokens.accessToken);
        const expected = facebookOwner.reconnectProviderAccountId;
        if (expected && expected !== facebookProviderAccount.providerAccountId) {
          const provisional =
            expected.startsWith(`${FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN}:`) || expected.startsWith('legacy-owner:');
          if (!provisional) {
            return oauthResultResponse(
              req.url,
              returnPath,
              'oauth_error',
              'facebook_personal_vault_account_mismatch',
              verified.privateContext,
            );
          }
          await renameOwnedExternalTriggerSourceAccount(getOrgPg().sql, {
            workspaceId: facebookOwner.workspaceId,
            ownerUserId: facebookOwner.ownerUserId,
            previousProviderAccountId: expected,
            providerAccountId: facebookProviderAccount.providerAccountId,
          });
        }
        const owned = await listOwnedExternalTriggerSources(
          getOrgPg().sql,
          facebookOwner.workspaceId,
          facebookOwner.ownerUserId,
        );
        facebookPreviousFields = [
          ...new Set(
            owned
              .filter(
                (source) =>
                  source.kind === 'facebook' &&
                  source.providerAccountId === facebookProviderAccount!.providerAccountId &&
                  source.credentialRef !== null,
              )
              .map((source) => source.credentialRef!.slice(`${FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN}:`.length)),
          ),
        ];
        // Symmetric to the Google guard above (WI-129473/WI-133209). oauth/start
        // allocates a fresh field for BOTH plugins, and this branch's mismatch
        // guard likewise needs an `expected` account, so it covers RECONNECT only.
        // Facebook makes this easier to hit than Google: its authorize URL carries
        // no account-chooser hint at all, so an active session simply continues as
        // the logged-in user. Refuse rather than write a second slot for an account
        // that is already connected.
        if (!expected && facebookPreviousFields.length > 0) {
          return oauthResultResponse(
            req.url,
            returnPath,
            'oauth_error',
            'facebook_personal_vault_account_already_connected',
            verified.privateContext,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext);
      }
    }

    // A brand-new Google account slot that arrives without a refresh token is
    // already broken: the access token expires within the hour and there is
    // nothing to renew it with. That is precisely what an authorize URL which
    // lets Google skip re-consent produces, so fail loudly here instead of
    // persisting a credential that dies quietly a while after the owner was
    // told the connection succeeded. Reconnects are exempt — they legitimately
    // keep the refresh token already stored for that account.
    if (
      googleOwner &&
      !googleOwner.reconnectProviderAccountId &&
      googlePreviousFields.length === 0 &&
      !tokens.refreshToken
    ) {
      return oauthResultResponse(
        req.url,
        returnPath,
        'oauth_error',
        'google_workspace_refresh_token_missing',
        verified.privateContext,
      );
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
    if (googleOwner) {
      try {
        const sources = await provisionOwnedGoogleWorkspaceSources(getOrgPg().sql, {
          workspaceId: googleOwner.workspaceId,
          ownerUserId: googleOwner.ownerUserId,
          providerAccountId: googleProviderAccountId!,
          field,
          createdBy: `owner:${googleOwner.ownerUserId}`,
        });
        const gmail = sources.find((source) => source.kind === 'gmail');
        if (!gmail) throw new Error('google_workspace_gmail_source_missing');
        await ensureGmailRespondDraftBinding(
          getOrgPg().sql,
          googleOwner.workspaceId,
          gmail,
          `owner:${googleOwner.ownerUserId}`,
        );
        for (const previousField of googlePreviousFields) {
          if (previousField === field) continue;
          await fsTokenStorage.update(GOOGLE_WORKSPACE_OAUTH_PLUGIN, harness, {
            [previousField]: null,
            [previousField + '_refresh']: null,
            [previousField + '_expires_at']: null,
            [previousField + '_scopes']: null,
            [previousField + '_expired']: true,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext);
      }
    }
    if (facebookOwner) {
      try {
        await provisionOwnedFacebookPersonalVaultSource(getOrgPg().sql, {
          workspaceId: facebookOwner.workspaceId,
          ownerUserId: facebookOwner.ownerUserId,
          providerAccountId: facebookProviderAccount!.providerAccountId,
          displayName: facebookProviderAccount!.displayName,
          field,
          createdBy: `owner:${facebookOwner.ownerUserId}`,
        });
        for (const previousField of facebookPreviousFields) {
          if (previousField === field) continue;
          await fsTokenStorage.update(FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN, harness, {
            [previousField]: null,
            [previousField + '_refresh']: null,
            [previousField + '_expires_at']: null,
            [previousField + '_scopes']: null,
            [previousField + '_expired']: true,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return oauthResultResponse(req.url, returnPath, 'oauth_error', message, verified.privateContext);
      }
    }

    return oauthResultResponse(
      req.url,
      returnPath,
      'oauth_connected',
      plugin,
      verified.privateContext,
    );
  },
});
