/**
 * First-party connection adapters (P-003). The OAuth routes are provider
 * neutral; what is specific to Google Workspace and Facebook lives here,
 * behind the {@link ConnectionAdapter} contract, and is registered once.
 * Descriptor providers need no entry here: connection-lifecycle derives their
 * adapters from the provider registry.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  GOOGLE_WORKSPACE_SOURCE_KINDS,
  assertGoogleWorkspaceOwnerUserId,
  googleWorkspaceOAuthField,
  googleWorkspaceSourceAccountId,
  isGoogleWorkspaceProvisionalProviderAccountId,
  provisionOwnedGoogleWorkspaceSources,
  resolveGoogleWorkspaceProviderAccount,
} from '../external-triggers/google-workspace';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
  assertFacebookPersonalVaultOwnerUserId,
  facebookPersonalVaultOAuthField,
  provisionOwnedFacebookPersonalVaultSource,
  resolveFacebookPersonalVaultProviderAccount,
} from '../external-triggers/facebook';
import {
  listOwnedExternalTriggerSources,
  renameOwnedExternalTriggerSourceAccount,
} from '../external-triggers/source-store';
import {
  defaultPreviousFields,
  registerConnectionAdapter,
  type ConnectionAdapter,
} from './connection-lifecycle';

const PERSONAL_VAULT_RETURN_PATH = '/settings/personal-vault';

/** One Google consent backs Gmail, Calendar and Contacts. */
export const googleWorkspaceConnectionAdapter: ConnectionAdapter = {
  oauthPlugin: GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  oauthProviderId: 'google',
  errorPrefix: 'google_workspace',
  returnPath: PERSONAL_VAULT_RETURN_PATH,
  sourceKinds: GOOGLE_WORKSPACE_SOURCE_KINDS,
  // A caller-supplied subset must not create source rows that look connected
  // but cannot read one of the Workspace surfaces; extra scopes are an upgrade.
  scopePolicy: 'union',
  recordRequestedScopes: true,
  // Google access tokens expire within the hour; a new slot without a refresh
  // token is what an authorize URL that skips re-consent produces.
  requiresRefreshToken: () => true,
  assertOwnerUserId: assertGoogleWorkspaceOwnerUserId,
  oauthField: googleWorkspaceOAuthField,
  async resolveAccount(accessToken) {
    const resolved = await resolveGoogleWorkspaceProviderAccount(accessToken);
    return { providerAccountId: resolved.providerAccountId };
  },
  async previousFields(sql, owner, account) {
    let owned = await listOwnedExternalTriggerSources(sql, owner.workspaceId, owner.ownerUserId);
    const accountId = account.providerAccountId;
    const provisionalAccountIds = [
      ...new Set(
        owned
          .filter((source) => {
            const providerAccountId = source.providerAccountId?.trim() ?? '';
            return (
              Boolean(providerAccountId) &&
              providerAccountId !== accountId &&
              isGoogleWorkspaceProvisionalProviderAccountId(providerAccountId) &&
              googleWorkspaceSourceAccountId(source, owned) === accountId
            );
          })
          .map((source) => source.providerAccountId!.trim()),
      ),
    ];
    const directCanonicalSources = owned.filter(
      (source) => source.providerAccountId?.trim() === accountId && source.credentialRef !== null,
    );
    // Older rows may have persisted the Gmail cursor's canonical email while
    // retaining `google-workspace:<field>` as providerAccountId. Adopt that
    // identity before provisioning the new OAuth field; otherwise upsert creates
    // a second canonical row and Personal Vault shows the old row as a ghost
    // account. Only reconcile an unambiguous provisional group.
    let reconciled = false;
    if (!owner.reconnectProviderAccountId && directCanonicalSources.length === 0 && provisionalAccountIds.length === 1) {
      await renameOwnedExternalTriggerSourceAccount(sql, {
        workspaceId: owner.workspaceId,
        ownerUserId: owner.ownerUserId,
        previousProviderAccountId: provisionalAccountIds[0]!,
        providerAccountId: accountId,
      });
      reconciled = true;
      owned = await listOwnedExternalTriggerSources(sql, owner.workspaceId, owner.ownerUserId);
    }
    const fields = [
      ...new Set(
        owned
          .filter(
            (source) => googleWorkspaceSourceAccountId(source, owned) === accountId && source.credentialRef !== null,
          )
          .map((source) => googleWorkspaceOAuthField(source.credentialRef)),
      ),
    ];
    return { fields, reconciled };
  },
  async provision(sql, input) {
    const sources = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: input.owner.workspaceId,
      ownerUserId: input.owner.ownerUserId,
      providerAccountId: input.account.providerAccountId,
      field: input.field,
      createdBy: input.createdBy,
    });
    if (!sources.some((source) => source.kind === 'gmail')) throw new Error('google_workspace_gmail_source_missing');
    // No trigger binding is created on connect (plan generalized-integrations-…-2026-10-05
    // D-019.3): owner directive #869 forbids auto-composing draft replies, so a draft
    // responder is opt-in through the email-draft-responder trigger pack.
  },
};

export const facebookPersonalVaultConnectionAdapter: ConnectionAdapter = {
  oauthPlugin: FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  oauthProviderId: 'facebook',
  errorPrefix: 'facebook_personal_vault',
  returnPath: PERSONAL_VAULT_RETURN_PATH,
  sourceKinds: FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
  scopePolicy: 'defaults-only',
  recordRequestedScopes: false,
  requiresRefreshToken: () => false,
  assertOwnerUserId: assertFacebookPersonalVaultOwnerUserId,
  oauthField: facebookPersonalVaultOAuthField,
  async resolveAccount(accessToken) {
    const account = await resolveFacebookPersonalVaultProviderAccount(accessToken);
    return { providerAccountId: account.providerAccountId, displayName: account.displayName };
  },
  previousFields: (sql, owner, account) =>
    defaultPreviousFields(sql, facebookPersonalVaultConnectionAdapter, owner, account),
  async provision(sql, input) {
    await provisionOwnedFacebookPersonalVaultSource(sql, {
      workspaceId: input.owner.workspaceId,
      ownerUserId: input.owner.ownerUserId,
      providerAccountId: input.account.providerAccountId,
      displayName: input.account.displayName ?? input.account.providerAccountId,
      field: input.field,
      createdBy: input.createdBy,
    });
  },
};

const registered = pinModuleState('@papercusp/operator-core.integrations.builtin-connection-adapters', () => ({
  done: false,
}));

/** Idempotently register the first-party adapters. */
export function ensureBuiltinConnectionAdapters(): void {
  if (registered.done) return;
  registerConnectionAdapter(googleWorkspaceConnectionAdapter);
  registerConnectionAdapter(facebookPersonalVaultConnectionAdapter);
  registered.done = true;
}
