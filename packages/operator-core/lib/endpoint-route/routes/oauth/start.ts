/**
 * GET /api/oauth/start
 *
 * Creates the provider authorize URL with an HMAC-signed state token
 * (plugin/harness/field/provider — read by the callback from the verified
 * state, never from URL params). The default response redirects in place;
 * `response=json` returns the immediate-use URL for the owned desktop shell
 * and a shareable start URL that mints fresh state when visited.
 *
 * Ported from app/api/oauth/start/route.ts. `auth: 'public'` — the
 * caller is an un-authed browser starting an OAuth flow.
 */
import { randomBytes } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { getProvider, loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { signState } from '../../../oauth/state';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  GOOGLE_WORKSPACE_SOURCE_KINDS,
  googleWorkspaceOAuthField,
} from '../../../external-triggers/google-workspace';
import { listOwnedExternalTriggerSources } from '../../../external-triggers/source-store';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  facebookPersonalVaultOAuthField,
} from '../../../external-triggers/facebook';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

export default defineTool({
  method: 'GET',
  path: '/oauth/start',
  auth: 'public',
  async handler(req) {
    await ensureProvidersLoaded();
    const url = new URL(req.url);
    const providerId = url.searchParams.get('provider') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    const harness = url.searchParams.get('harness') ?? '';
    const requestedField = url.searchParams.get('field') ?? '';
    const requestedProviderAccountId = url.searchParams.get('account')?.trim() ?? '';
    const scopesRaw = url.searchParams.get('scopes') ?? '';
    const responseMode = url.searchParams.get('response') ?? 'redirect';

    if (!providerId || !plugin || !harness || !requestedField) {
      return Response.json({ ok: false, error: 'provider, plugin, harness, field all required' }, { status: 400 });
    }
    if (responseMode !== 'redirect' && responseMode !== 'json') {
      return Response.json({ ok: false, error: 'response must be redirect or json' }, { status: 400 });
    }
    const connectsGoogleWorkspace = providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN;
    const connectsFacebookPersonalVault = providerId === 'facebook' && plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN;
    if (plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN && !connectsGoogleWorkspace) {
      return Response.json({ ok: false, error: 'google-workspace plugin requires provider google' }, { status: 400 });
    }
    if (plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN && !connectsFacebookPersonalVault) {
      return Response.json(
        { ok: false, error: 'facebook-personal-vault plugin requires provider facebook' },
        { status: 400 },
      );
    }
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `unknown provider "${providerId}"` }, { status: 404 });
    }

    const requestedScopes = scopesRaw
      ? scopesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const allowedScopes = provider.allowedScopes ? new Set(provider.allowedScopes) : null;
    const forbiddenScopes = allowedScopes ? requestedScopes.filter((scope) => !allowedScopes.has(scope)) : [];
    if (forbiddenScopes.length > 0) {
      return Response.json(
        { ok: false, error: `provider ${providerId} does not allow scope(s): ${forbiddenScopes.join(', ')}` },
        { status: 400 },
      );
    }
    // The reserved Workspace connection backs Gmail, Calendar, and Contacts as
    // one consent. A caller-supplied subset must not create source rows that look
    // connected but cannot actually read one of those provider surfaces.
    const scopes = connectsGoogleWorkspace
      ? [...new Set([...(provider.defaultScopes ?? []), ...requestedScopes])]
      : connectsFacebookPersonalVault
        ? [...(provider.defaultScopes ?? [])]
        : requestedScopes.length > 0
          ? requestedScopes
          : [...(provider.defaultScopes ?? [])];
    if (connectsGoogleWorkspace && scopes.length === 0) {
      return Response.json({ ok: false, error: 'google-workspace provider has no default scopes' }, { status: 500 });
    }
    if (connectsFacebookPersonalVault && scopes.length === 0) {
      return Response.json(
        { ok: false, error: 'facebook-personal-vault provider has no default scopes' },
        { status: 500 },
      );
    }
    const providerHost = new URL(provider.config.authorizeUrl).host;
    let field = requestedField;
    let privateContext: Record<string, string> = { ...((await provider.createFlowContext?.()) ?? {}) };
    if (connectsGoogleWorkspace || connectsFacebookPersonalVault) {
      const owner = await getSessionUserOrDefault(req.headers);
      let reconnectProviderAccountId: string | undefined;
      let reconnectField: string | null = null;
      if (requestedProviderAccountId) {
        const owned = await listOwnedExternalTriggerSources(getOrgPg().sql, activeWorkspaceId(), owner.id);
        const accountSources = owned.filter(
          (source) =>
            source.providerAccountId === requestedProviderAccountId &&
            (connectsGoogleWorkspace
              ? GOOGLE_WORKSPACE_SOURCE_KINDS.includes(
                  source.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number],
                )
              : source.kind === 'facebook'),
        );
        if (!accountSources.length) {
          return Response.json(
            {
              ok: false,
              error: connectsGoogleWorkspace
                ? 'google_workspace_account_not_found'
                : 'facebook_personal_vault_account_not_found',
            },
            { status: 404 },
          );
        }
        reconnectProviderAccountId = requestedProviderAccountId;
        const credentialRef = accountSources.find((source) => source.credentialRef)?.credentialRef ?? null;
        reconnectField = credentialRef
          ? connectsGoogleWorkspace
            ? googleWorkspaceOAuthField(credentialRef)
            : facebookPersonalVaultOAuthField(credentialRef)
          : null;
      }
      field = reconnectField ?? `owner-${owner.id}-${randomBytes(8).toString('hex')}`;
      privateContext = {
        ...privateContext,
        ownerUserId: owner.id,
        workspaceId: activeWorkspaceId(),
        returnPath: '/settings/personal-vault',
        ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
        ...(connectsGoogleWorkspace
          ? {
              requestedScopes: JSON.stringify(scopes),
            }
          : {}),
      };
    }
    if (responseMode === 'json') {
      // This marker is stored with the nonce-backed private context. The
      // callback never trusts a query parameter to select its completion-page
      // response, so a provider redirect cannot change the response mode.
      privateContext = { ...privateContext, returnMode: 'external-browser' };
    }
    const state = await signState(
      {
        plugin,
        harness,
        field,
        provider: providerId,
        providerHost,
      },
      { privateContext },
    );
    const authorizationUrl = provider.buildAuthorizeUrl(scopes, state, privateContext);
    if (responseMode === 'json') {
      const shareUrl = new URL(url);
      shareUrl.searchParams.delete('response');
      return Response.json(
        {
          ok: true,
          authorizationUrl,
          shareUrl: shareUrl.toString(),
          instruction: 'Open authorizationUrl immediately. Share shareUrl with another person; it creates fresh OAuth state when opened.',
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    return Response.redirect(authorizationUrl, 302);
  },
});
