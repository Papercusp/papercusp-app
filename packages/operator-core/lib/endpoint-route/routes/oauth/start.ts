/**
 * GET /api/oauth/start
 *
 * Creates the provider authorize URL with an HMAC-signed state token
 * (plugin/harness/field/provider — read by the callback from the verified
 * state, never from URL params). The default response redirects in place;
 * `response=json` returns the immediate-use URL for the owned desktop shell
 * and a shareable start URL that mints fresh state when visited.
 *
 * Managed connections (Google Workspace, Facebook, and every descriptor
 * provider with `oauth`) resolve a ConnectionAdapter for the plugin; the
 * adapter supplies the provider pairing, scope policy, source kinds and return
 * path. This route holds no provider-name branch (P-003).
 *
 * Ported from app/api/oauth/start/route.ts. `auth: 'public'` — the
 * caller is an un-authed browser starting an OAuth flow.
 */
import { randomBytes } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { signState } from '../../../oauth/state';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { listOwnedExternalTriggerSources } from '../../../external-triggers/source-store';
import {
  connectionAdapterForPlugin,
  connectionScopes,
  resolveOAuthProvider,
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
    // A managed-connection plugin is bound to exactly one OAuth provider; a
    // mismatched pair would write a credential the lifecycle cannot read.
    const adapter = connectionAdapterForPlugin(plugin);
    if (adapter && adapter.oauthProviderId !== providerId) {
      return Response.json(
        { ok: false, error: `${plugin} plugin requires provider ${adapter.oauthProviderId}` },
        { status: 400 },
      );
    }
    const provider = await resolveOAuthProvider(providerId);
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
    // A managed connection requests what its adapter's scope policy says: a
    // caller-supplied subset must not create source rows that look connected
    // but cannot read one of the provider surfaces.
    const scopes = adapter
      ? connectionScopes(adapter, provider, requestedScopes)
      : requestedScopes.length > 0
        ? requestedScopes
        : [...(provider.defaultScopes ?? [])];
    if (adapter && scopes.length === 0) {
      return Response.json({ ok: false, error: `${plugin} provider has no default scopes` }, { status: 500 });
    }
    const providerHost = new URL(provider.config.authorizeUrl).host;
    let field = requestedField;
    let privateContext: Record<string, string> = { ...((await provider.createFlowContext?.()) ?? {}) };
    if (adapter) {
      const owner = await getSessionUserOrDefault(req.headers);
      let reconnectProviderAccountId: string | undefined;
      let reconnectField: string | null = null;
      if (requestedProviderAccountId) {
        const owned = await listOwnedExternalTriggerSources(getOrgPg().sql, activeWorkspaceId(), owner.id);
        const accountSources = owned.filter(
          (source) =>
            source.providerAccountId === requestedProviderAccountId && adapter.sourceKinds.includes(source.kind),
        );
        if (!accountSources.length) {
          return Response.json({ ok: false, error: `${adapter.errorPrefix}_account_not_found` }, { status: 404 });
        }
        reconnectProviderAccountId = requestedProviderAccountId;
        const credentialRef = accountSources.find((source) => source.credentialRef)?.credentialRef ?? null;
        reconnectField = credentialRef ? adapter.oauthField(credentialRef) : null;
      }
      field = reconnectField ?? `owner-${owner.id}-${randomBytes(8).toString('hex')}`;
      privateContext = {
        ...privateContext,
        ownerUserId: owner.id,
        workspaceId: activeWorkspaceId(),
        returnPath: adapter.returnPath,
        ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
        ...(adapter.recordRequestedScopes ? { requestedScopes: JSON.stringify(scopes) } : {}),
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
