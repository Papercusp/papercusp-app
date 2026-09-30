/**
 * Owner-facing Personal Vault HTTP projection.
 *
 * This is deliberately a thin projection over the canonical Personal Vault
 * store. The desktop never writes the vault tables directly: status, local
 * archive import, the kill switch, verified purge, and default-deny grants all
 * pass through the same invariants used by the agent tools.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { parsePlan } from '@papercusp/plan-parser';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  disconnectOwnedExternalTriggerSources,
  getExternalTriggerSource,
  listOwnedExternalTriggerSources,
  setOwnedExternalTriggerSourceCapability,
  type OwnedExternalTriggerSourceRow,
} from '../../../external-triggers/source-store';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  GOOGLE_WORKSPACE_SOURCE_KINDS,
  googleWorkspaceOAuthField,
  googleWorkspaceSourceAccountId,
} from '../../../external-triggers/google-workspace';
import { googleGmailBackfillState } from '../../../external-triggers/google-gmail';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
  facebookPersonalVaultOAuthField,
} from '../../../external-triggers/facebook';
import {
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CONTACTS_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE,
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  getProvider,
  loadAndRegisterProvidersFromDisk,
} from '../../../oauth/providers';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import {
  isPersonalVaultEnabled,
  listPersonalGrants,
  personalScope,
  personalVaultStats,
  purgePersonalSource,
  replacePersonalGrant,
  revokePersonalGrant,
  setPersonalVaultEnabled,
} from '../../../personal-vault/store';
import {
  MAX_PERSONAL_VAULT_IMPORT_BYTES,
  finalizePersonalVaultImportUpload,
  listPersonalVaultImportJobs,
  personalVaultImportStorageUsage,
  publicPersonalVaultImportJob,
  purgePersonalVaultImportArchives,
  releasePersonalVaultImportUpload,
  removePersonalVaultImportArchive,
  reservePersonalVaultImportUpload,
  requestPersonalVaultImportCancellation,
  retryPersonalVaultImportJob,
  storeReservedPersonalVaultImportArchive,
  type PersonalVaultImportUploadReservation,
} from '../../../personal-vault/import-jobs';
import type { PersonalPrincipalType } from '../../../personal-vault/types';

const SUPPORTED_SOURCES = ['gmail', 'calendar', 'contacts', 'facebook', 'instagram', 'x'] as const;
const PRINCIPAL_TYPES: readonly PersonalPrincipalType[] = ['plan-template', 'binding', 'agent-role'];

interface SafeIntegrationSource {
  kind: string;
  providerAccountId: string | null;
  status: string;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
  /** Provider failure text for a degraded/error source; the owner's own row, so no cross-user leak. */
  lastError: string | null;
  /** Gmail initial-backfill progress, so partial data has a visible reason. */
  backfill: { status: 'pending' | 'throttled' | 'complete'; messages: number } | null;
}

interface SafeIntegrationStatus {
  provider: 'google' | 'facebook';
  configured: boolean;
  connected: boolean;
  status: 'needs-app-config' | 'available' | 'connected' | 'degraded' | 'error';
  sources: SafeIntegrationSource[];
  capabilities?: SafeGoogleCapability[];
  accounts?: Array<SafeGoogleAccountStatus | SafeFacebookAccountStatus>;
}

type GoogleCapabilityId = 'gmail' | 'calendar' | 'contacts' | 'youtube';

interface SafeGoogleCapability {
  id: GoogleCapabilityId;
  sourceKind: 'gmail' | 'gcal' | 'contacts' | 'youtube';
  enabled: boolean;
  connected: boolean;
  status: 'needs-app-config' | 'available' | 'connected' | 'disabled' | 'needs-consent' | 'degraded' | 'error';
  missingScopes: string[];
}

interface SafeGoogleAccountStatus {
  providerAccountId: string;
  displayName: string;
  connected: boolean;
  status: SafeIntegrationStatus['status'];
  sources: SafeIntegrationSource[];
  grantedScopes: string[];
  capabilities: SafeGoogleCapability[];
}

interface SafeFacebookAccountStatus {
  providerAccountId: string;
  displayName: string;
  connected: boolean;
  status: SafeIntegrationStatus['status'];
  sources: SafeIntegrationSource[];
}

const GOOGLE_CAPABILITY_DEFS: ReadonlyArray<{
  id: GoogleCapabilityId;
  sourceKind: SafeGoogleCapability['sourceKind'];
  requiredScopes: readonly string[];
}> = [
  {
    id: 'gmail',
    sourceKind: 'gmail',
    requiredScopes: [GOOGLE_GMAIL_READONLY_SCOPE, GOOGLE_GMAIL_COMPOSE_SCOPE],
  },
  {
    id: 'calendar',
    sourceKind: 'gcal',
    requiredScopes: [GOOGLE_CALENDAR_READONLY_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
  },
  {
    id: 'contacts',
    sourceKind: 'contacts',
    requiredScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
  },
  {
    // P-015. Rides the SAME Google Workspace OAuth source as Gmail and Calendar
    // (the external-triggers D-010 one-credential-path pattern) — a scope
    // addition with an incremental-consent upgrade, never a second credential
    // path.
    //
    // ⚠ D-019: both scopes are in GOOGLE_WORKSPACE_ALLOWED_SCOPES (requestable)
    // and listed here (required), and NEITHER is in GOOGLE_WORKSPACE_SCOPES.
    // That list is presumed-granted for legacy connections, so putting them
    // there would make this capability report connected:true with no
    // missingScopes for an owner who never consented — surfacing as a 403 at
    // call time instead of as an honest needs-consent here.
    id: 'youtube',
    sourceKind: 'youtube',
    requiredScopes: [GOOGLE_YOUTUBE_READONLY_SCOPE, GOOGLE_YOUTUBE_FORCE_SSL_SCOPE],
  },
];

function jsonBody<T>(req: Request): Promise<T | null> {
  return req.json().catch(() => null) as Promise<T | null>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function importError(err: unknown): Response {
  const error = messageOf(err);
  if (error.includes('too_large') || error.includes('too_many_entries')) {
    return Response.json({ ok: false, error }, { status: 413 });
  }
  if (error === 'personal_vault_disabled') {
    return Response.json({ ok: false, error }, { status: 409 });
  }
  return Response.json({ ok: false, error }, { status: 400 });
}

function importFilename(req: Request): string {
  const encoded = req.headers.get('x-papercusp-filename')?.trim();
  if (!encoded) throw new Error('filename_required');
  try {
    const filename = decodeURIComponent(encoded).trim();
    if (!filename) throw new Error('filename_required');
    return filename;
  } catch (error) {
    if (messageOf(error) === 'filename_required') throw error;
    throw new Error('filename_invalid');
  }
}

async function resolveImportProvenance(
  workspaceId: string,
  userId: string,
  url: URL,
): Promise<{ sourceId: string | null; providerAccountId: string | null }> {
  const requestedSourceId = url.searchParams.get('sourceId')?.trim() ?? '';
  const requestedProviderAccountId = url.searchParams.get('providerAccountId')?.trim() ?? '';
  let sourceId: string | null = requestedSourceId || null;
  let providerAccountId: string | null = requestedProviderAccountId || null;
  if (!sourceId) return { sourceId, providerAccountId };
  const owned = await getExternalTriggerSource(getOrgPg().sql, workspaceId, sourceId);
  if (!owned?.ownerUserId || owned.ownerUserId !== userId) {
    throw new Error('personal_import_source_not_owned');
  }
  if (!owned.providerAccountId) throw new Error('personal_import_source_account_required');
  if (providerAccountId && providerAccountId !== owned.providerAccountId) {
    throw new Error('personal_import_source_account_mismatch');
  }
  providerAccountId = owned.providerAccountId;
  sourceId = owned.id;
  return { sourceId, providerAccountId };
}

function safeLastSyncAt(source: OwnedExternalTriggerSourceRow): string | null {
  const value = source.cursor.lastSyncAt ?? source.cursor.last_sync_at;
  return typeof value === 'string' && value.trim() ? value : null;
}

function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
          .map((scope) => scope.trim()),
      ),
    ];
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return scopeList(JSON.parse(value));
  } catch {
    return [
      ...new Set(
        value
          .split(/[\s,]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ];
  }
}

function googleCredentialState(
  owned: OwnedExternalTriggerSourceRow[],
  tokenConfig: Readonly<Record<string, unknown>>,
): { connected: boolean; grantedScopes: string[] } {
  const source = owned.find(
    (candidate) =>
      GOOGLE_WORKSPACE_SOURCE_KINDS.includes(candidate.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]) &&
      candidate.credentialRef !== null,
  );
  if (!source?.credentialRef) return { connected: false, grantedScopes: [] };
  const field = googleWorkspaceOAuthField(source.credentialRef);
  const token = tokenConfig[field];
  const connected =
    typeof token === 'string' ? Boolean(token.trim()) : token !== null && token !== undefined && token !== false;
  const stored = scopeList(tokenConfig[field + '_scopes']);
  // Older connections predate granted-scope metadata. Their base read scopes
  // were mandatory, but calendar.events was not, so only the write upgrade is
  // conservatively reported missing until the next consent round-trip.
  return {
    connected,
    grantedScopes: stored.length ? stored : connected ? [...GOOGLE_WORKSPACE_SCOPES] : [],
  };
}

function googleCapabilities(
  configured: boolean,
  providerLoadFailed: boolean,
  owned: OwnedExternalTriggerSourceRow[],
  grantedScopes: string[],
  sharedConnected: boolean,
): SafeGoogleCapability[] {
  const sources = owned.filter((source) =>
    GOOGLE_WORKSPACE_SOURCE_KINDS.includes(source.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]),
  );
  const granted = new Set(grantedScopes);
  return GOOGLE_CAPABILITY_DEFS.map((definition) => {
    // The shared credential lives on a Workspace source, but capability rows
    // may have their own source kind (YouTube is the first such capability).
    // Keep sharedConnected scoped to Workspace kinds while resolving the
    // per-capability toggle across every owned source.
    const source = owned.find((candidate) => candidate.kind === definition.sourceKind);
    const enabled = source?.config.capabilityEnabled !== false;
    const missingScopes =
      sharedConnected && enabled ? definition.requiredScopes.filter((scope) => !granted.has(scope)) : [];
    const status: SafeGoogleCapability['status'] = providerLoadFailed
      ? 'error'
      : !configured
        ? 'needs-app-config'
        : !sharedConnected
          ? 'available'
          : !enabled
            ? 'disabled'
            : missingScopes.length
              ? 'needs-consent'
              : source?.status === 'error'
                ? 'error'
                : source?.status === 'degraded'
                  ? 'degraded'
                  : 'connected';
    return {
      id: definition.id,
      sourceKind: definition.sourceKind,
      enabled,
      connected: sharedConnected && enabled && missingScopes.length === 0,
      status,
      missingScopes,
    };
  });
}

function safeSources(owned: OwnedExternalTriggerSourceRow[]): SafeIntegrationSource[] {
  return owned.map((source) => {
    const backfill = source.kind === 'gmail' ? googleGmailBackfillState(source) : null;
    return {
      kind: source.kind,
      providerAccountId: source.providerAccountId,
      status: source.status,
      lastConnectedAt: source.lastConnectedAt,
      lastSyncAt: safeLastSyncAt(source),
      lastError: source.status === 'degraded' || source.status === 'error' ? source.lastError : null,
      backfill: backfill ? { status: backfill.status, messages: backfill.messages } : null,
    };
  });
}

function facebookOwnedSources(owned: OwnedExternalTriggerSourceRow[]): OwnedExternalTriggerSourceRow[] {
  return owned.filter(
    (source) =>
      FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS.includes(
        source.kind as (typeof FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS)[number],
      ) &&
      (source.credentialRef?.startsWith(`${FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN}:`) ||
        source.providerAccountId !== null),
  );
}

function facebookAccountStatus(
  providerAccountId: string,
  configured: boolean,
  providerLoadFailed: boolean,
  owned: OwnedExternalTriggerSourceRow[],
  tokenConfig: Readonly<Record<string, unknown>>,
): SafeFacebookAccountStatus {
  const source = owned.find((candidate) => candidate.credentialRef !== null);
  const field = source?.credentialRef ? facebookPersonalVaultOAuthField(source.credentialRef) : null;
  const token = field ? tokenConfig[field] : null;
  const connected =
    source?.status !== 'disabled' &&
    (typeof token === 'string' ? Boolean(token.trim()) : token !== null && token !== undefined && token !== false);
  const status: SafeIntegrationStatus['status'] =
    providerLoadFailed || owned.some((candidate) => candidate.status === 'error')
      ? 'error'
      : connected && owned.some((candidate) => candidate.status === 'degraded')
        ? 'degraded'
        : connected
          ? 'connected'
          : configured
            ? 'available'
            : 'needs-app-config';
  const displayName = owned
    .map((candidate) => candidate.config.displayName)
    .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
  return {
    providerAccountId,
    displayName: displayName?.trim() || providerAccountId,
    connected,
    status,
    sources: safeSources(owned),
  };
}

function googleAccountStatus(
  providerAccountId: string,
  configured: boolean,
  providerLoadFailed: boolean,
  owned: OwnedExternalTriggerSourceRow[],
  tokenConfig: Readonly<Record<string, unknown>>,
): SafeGoogleAccountStatus {
  const credential = googleCredentialState(owned, tokenConfig);
  const status: SafeIntegrationStatus['status'] =
    providerLoadFailed || owned.some((source) => source.status === 'error')
      ? 'error'
      : credential.connected && owned.some((source) => source.status === 'degraded')
        ? 'degraded'
        : credential.connected
          ? 'connected'
          : configured
            ? 'available'
            : 'needs-app-config';
  return {
    providerAccountId,
    displayName: providerAccountId,
    connected: credential.connected,
    status,
    sources: safeSources(owned),
    grantedScopes: credential.grantedScopes,
    capabilities: googleCapabilities(
      configured,
      providerLoadFailed,
      owned,
      credential.grantedScopes,
      credential.connected,
    ),
  };
}

function googleOwnedSources(owned: OwnedExternalTriggerSourceRow[]): OwnedExternalTriggerSourceRow[] {
  const kinds = new Set(GOOGLE_CAPABILITY_DEFS.map((definition) => definition.sourceKind));
  return owned.filter(
    (source) =>
      kinds.has(source.kind as SafeGoogleCapability['sourceKind']) &&
      (source.credentialRef?.startsWith(`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:`) || source.providerAccountId !== null),
  );
}

function selectOwnedGoogleProviderAccount(owned: OwnedExternalTriggerSourceRow[], requested: string): string {
  const accountIds = [
    ...new Set(
      googleOwnedSources(owned)
        .map((source) => source.providerAccountId?.trim() ?? '')
        .filter(Boolean),
    ),
  ];
  const normalized = requested.trim();
  if (normalized) {
    if (!accountIds.includes(normalized)) throw new Error('google_workspace_account_not_found');
    return normalized;
  }
  if (accountIds.length === 1) return accountIds[0]!;
  if (accountIds.length === 0) throw new Error('google_workspace_not_connected');
  throw new Error('google_workspace_account_required');
}

function googleAccountSelectionError(error: unknown): Response {
  const message = messageOf(error);
  const status =
    message === 'google_workspace_account_not_found' ? 404 : message === 'google_workspace_not_connected' ? 409 : 400;
  return Response.json({ ok: false, error: message }, { status });
}

function selectOwnedFacebookProviderAccount(owned: OwnedExternalTriggerSourceRow[], requested: string): string {
  const accountIds = [
    ...new Set(
      facebookOwnedSources(owned)
        .map((source) => source.providerAccountId?.trim() ?? '')
        .filter(Boolean),
    ),
  ];
  const normalized = requested.trim();
  if (normalized) {
    if (!accountIds.includes(normalized)) throw new Error('facebook_personal_vault_account_not_found');
    return normalized;
  }
  if (accountIds.length === 1) return accountIds[0]!;
  if (accountIds.length === 0) throw new Error('facebook_personal_vault_not_connected');
  throw new Error('facebook_personal_vault_account_required');
}

function facebookAccountSelectionError(error: unknown): Response {
  const message = messageOf(error);
  const status =
    message === 'facebook_personal_vault_account_not_found'
      ? 404
      : message === 'facebook_personal_vault_not_connected'
        ? 409
        : 400;
  return Response.json({ ok: false, error: message }, { status });
}

async function integrationStatuses(
  workspaceId: string,
  ownerUserId: string,
): Promise<{ google: SafeIntegrationStatus; facebook: SafeIntegrationStatus }> {
  let providerLoadFailed = false;
  try {
    await loadAndRegisterProvidersFromDisk();
  } catch {
    providerLoadFailed = true;
  }
  const owned = await listOwnedExternalTriggerSources(getOrgPg().sql, workspaceId, ownerUserId);
  const googleConfigured = !providerLoadFailed && getProvider('google') !== null;
  const googleSources = googleOwnedSources(owned);
  const [tokenConfig, facebookTokenConfig] = await Promise.all([
    fsTokenStorage.read(GOOGLE_WORKSPACE_OAUTH_PLUGIN, 'papercusp'),
    fsTokenStorage.read(FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN, 'papercusp'),
  ]);
  const accounts = [
    ...new Set(
      googleSources
        .map((source) => googleWorkspaceSourceAccountId(source, googleSources))
        .filter((providerAccountId): providerAccountId is string => Boolean(providerAccountId)),
    ),
  ].map((providerAccountId) =>
    googleAccountStatus(
      providerAccountId,
      googleConfigured,
      providerLoadFailed,
      googleSources.filter(
        (source) => googleWorkspaceSourceAccountId(source, googleSources) === providerAccountId,
      ),
      tokenConfig,
    ),
  );
  const googleConnected = accounts.some((account) => account.connected);
  const googleStatus: SafeIntegrationStatus['status'] =
    providerLoadFailed || accounts.some((account) => account.status === 'error')
      ? 'error'
      : accounts.some((account) => account.status === 'degraded')
        ? 'degraded'
        : googleConnected
          ? 'connected'
          : googleConfigured
            ? 'available'
            : 'needs-app-config';
  const facebookConfigured = !providerLoadFailed && getProvider('facebook') !== null;
  const facebookSources = facebookOwnedSources(owned);
  const facebookAccounts = [
    ...new Set(facebookSources.map((source) => source.providerAccountId?.trim() ?? '').filter(Boolean)),
  ].map((providerAccountId) =>
    facebookAccountStatus(
      providerAccountId,
      facebookConfigured,
      providerLoadFailed,
      facebookSources.filter((source) => source.providerAccountId === providerAccountId),
      facebookTokenConfig,
    ),
  );
  const facebookConnected = facebookAccounts.some((account) => account.connected);
  const facebookStatus: SafeIntegrationStatus['status'] =
    providerLoadFailed || facebookAccounts.some((account) => account.status === 'error')
      ? 'error'
      : facebookAccounts.some((account) => account.status === 'degraded')
        ? 'degraded'
        : facebookConnected
          ? 'connected'
          : facebookConfigured
            ? 'available'
            : 'needs-app-config';
  return {
    google: {
      provider: 'google',
      configured: googleConfigured,
      connected: googleConnected,
      status: googleStatus,
      sources: safeSources(googleSources),
      accounts,
      ...(accounts.length === 1 ? { capabilities: accounts[0]!.capabilities } : {}),
    },
    facebook: {
      provider: 'facebook',
      configured: facebookConfigured,
      connected: facebookConnected,
      status: facebookStatus,
      sources: safeSources(facebookSources),
      accounts: facebookAccounts,
    },
  };
}

export function declaredPersonalScopes(raw: Record<string, string | string[]>): string[] {
  const value = raw.personalScopes ?? raw.personal_scopes ?? raw['personal-scopes'];
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.map((scope) => personalScope(scope)).filter(Boolean))].sort();
}

interface PlanGrantPreview {
  planSlug: string;
  harnessSlug: string;
  principalType: 'plan-template';
  principalId: string;
  declaredScopes: string[];
}

async function resolvePlanGrantPreview(
  workspaceId: string,
  planSlugInput: string,
  harnessSlugInput?: string | null,
): Promise<PlanGrantPreview> {
  const planSlug = planSlugInput.trim();
  const harnessSlug = harnessSlugInput?.trim() || null;
  if (!planSlug) throw new Error('plan_slug_required');
  const { sql } = getOrgPg();
  const harnessFilter = harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``;
  const rows = await sql<
    Array<{
      plan_slug: string;
      harness_slug: string;
      template_slug: string | null;
      content: string;
    }>
  >`
    SELECT plan_slug, harness_slug, template_slug, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${planSlug}
       ${harnessFilter}
     ORDER BY updated_at DESC
     LIMIT 2`;
  if (!rows.length) throw new Error('plan_not_found');
  if (!harnessSlug && rows.length > 1) throw new Error('plan_harness_ambiguous');
  const row = rows[0]!;
  const parsed = parsePlan(row.content, { filePath: `${row.plan_slug}.md` });
  return {
    planSlug: row.plan_slug,
    harnessSlug: row.harness_slug,
    principalType: 'plan-template',
    principalId: row.template_slug?.trim() || row.plan_slug,
    declaredScopes: declaredPersonalScopes(parsed.frontmatter.raw),
  };
}

const status = defineTool({
  method: 'GET',
  path: '/user/personal-vault',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    const [enabled, stats, grants, integrations, importStorage] = await Promise.all([
      isPersonalVaultEnabled(sql, workspaceId, user.id),
      personalVaultStats(sql, workspaceId, user.id),
      listPersonalGrants(sql, workspaceId, user.id),
      integrationStatuses(workspaceId, user.id),
      personalVaultImportStorageUsage(sql, workspaceId, user.id),
    ]);
    return Response.json({
      ok: true,
      workspaceId,
      user: { id: user.id, displayName: user.display_name },
      enabled,
      stats,
      grants,
      supportedSources: SUPPORTED_SOURCES,
      embedding: { mode: 'gemma', localOnly: true },
      integrations,
      importStorage,
    });
  },
});

const disconnectGoogle = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/integrations/google',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const sql = getOrgPg().sql;
    const owned = await listOwnedExternalTriggerSources(sql, workspaceId, user.id);
    let providerAccountId: string;
    try {
      providerAccountId = selectOwnedGoogleProviderAccount(owned, new URL(req.url).searchParams.get('account') ?? '');
    } catch (error) {
      return googleAccountSelectionError(error);
    }
    const disconnected = await disconnectOwnedExternalTriggerSources(
      sql,
      workspaceId,
      user.id,
      [...GOOGLE_WORKSPACE_SOURCE_KINDS],
      providerAccountId,
    );
    for (const credentialRef of disconnected.credentialRefs) {
      const field = googleWorkspaceOAuthField(credentialRef);
      await fsTokenStorage.update(GOOGLE_WORKSPACE_OAUTH_PLUGIN, 'papercusp', {
        [field]: null,
        [field + '_refresh']: null,
        [field + '_expires_at']: null,
        [field + '_scopes']: null,
        [field + '_expired']: true,
      });
    }
    return Response.json({
      ok: true,
      provider: 'google',
      providerAccountId,
      disconnectedSources: disconnected.sources,
    });
  },
});

const setGoogleCapability = defineTool({
  method: 'PATCH',
  path: '/user/personal-vault/integrations/google/capabilities',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ capability?: unknown; enabled?: unknown; providerAccountId?: unknown }>(req);
    const definition = GOOGLE_CAPABILITY_DEFS.find((candidate) => candidate.id === body?.capability);
    if (!definition) {
      return Response.json({ ok: false, error: 'google_capability_invalid' }, { status: 400 });
    }
    if (typeof body?.enabled !== 'boolean') {
      return Response.json({ ok: false, error: 'enabled_must_be_boolean' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const sql = getOrgPg().sql;
    const owned = await listOwnedExternalTriggerSources(sql, workspaceId, user.id);
    let providerAccountId: string;
    try {
      providerAccountId = selectOwnedGoogleProviderAccount(
        owned,
        typeof body?.providerAccountId === 'string' ? body.providerAccountId : '',
      );
    } catch (error) {
      return googleAccountSelectionError(error);
    }
    const credentialRef = owned.find(
      (source) =>
        source.providerAccountId === providerAccountId &&
        GOOGLE_WORKSPACE_SOURCE_KINDS.includes(source.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]) &&
        source.credentialRef !== null,
    )?.credentialRef;
    if (!credentialRef) {
      return Response.json({ ok: false, error: 'google_workspace_not_connected' }, { status: 409 });
    }
    const source = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId,
      ownerUserId: user.id,
      providerAccountId,
      kind: definition.sourceKind,
      credentialRef,
      enabled: body.enabled,
      createdBy: `owner:${user.id}`,
    });
    return Response.json({
      ok: true,
      providerAccountId,
      capability: definition.id,
      enabled: body.enabled,
      source: { kind: source.kind, status: source.status },
    });
  },
});

const disconnectFacebook = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/integrations/facebook',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const sql = getOrgPg().sql;
    const owned = await listOwnedExternalTriggerSources(sql, workspaceId, user.id);
    let providerAccountId: string;
    try {
      providerAccountId = selectOwnedFacebookProviderAccount(
        owned,
        new URL(req.url).searchParams.get('account') ?? '',
      );
    } catch (error) {
      return facebookAccountSelectionError(error);
    }
    const disconnected = await disconnectOwnedExternalTriggerSources(
      sql,
      workspaceId,
      user.id,
      [...FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS],
      providerAccountId,
    );
    for (const credentialRef of disconnected.credentialRefs) {
      const field = facebookPersonalVaultOAuthField(credentialRef);
      await fsTokenStorage.update(FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN, 'papercusp', {
        [field]: null,
        [field + '_refresh']: null,
        [field + '_expires_at']: null,
        [field + '_expired']: true,
      });
    }
    return Response.json({
      ok: true,
      provider: 'facebook',
      providerAccountId,
      disconnectedSources: disconnected.sources,
    });
  },
});

const setEnabled = defineTool({
  method: 'PATCH',
  path: '/user/personal-vault',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ enabled?: unknown }>(req);
    if (typeof body?.enabled !== 'boolean') {
      return Response.json({ ok: false, error: 'enabled_must_be_boolean' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    await setPersonalVaultEnabled(getOrgPg().sql, workspaceId, user.id, body.enabled, `owner:${user.id}`);
    return Response.json({ ok: true, enabled: body.enabled });
  },
});

const purge = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{
      source?: unknown;
      sourceId?: unknown;
      providerAccountId?: unknown;
      confirm?: unknown;
    }>(req);
    if (body?.confirm !== true) {
      return Response.json({ ok: false, error: 'confirm_required' }, { status: 400 });
    }
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : null;
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : null;
    const providerAccountId = typeof body.providerAccountId === 'string' ? body.providerAccountId : null;
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    try {
      const removed = await purgePersonalSource(getOrgPg().sql, workspaceId, user.id, source, {
        sourceId,
        providerAccountId,
      });
      const imports = await purgePersonalVaultImportArchives(
        getOrgPg().sql,
        workspaceId,
        user.id,
        { sourceId, providerAccountId },
      );
      return Response.json({
        ok: true,
        source,
        sourceId,
        providerAccountId,
        removed: {
          ...removed,
          importJobs: imports.jobs,
          importArchives: imports.archives,
          importArchiveCleanupFailures: imports.cleanupFailures,
        },
      });
    } catch (err) {
      return Response.json({ ok: false, error: messageOf(err) }, { status: 400 });
    }
  },
});

const archiveImport = defineTool({
  method: 'POST',
  path: '/user/personal-vault/import',
  auth: 'loopback',
  // The request ends after a bounded disk stream + durable enqueue. Parsing is
  // owned by the system routine, outside this request's memory and timeout.
  timeoutSec: 300,
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    let reservation: PersonalVaultImportUploadReservation | null = null;
    try {
      if (!(await isPersonalVaultEnabled(getOrgPg().sql, workspaceId, user.id))) {
        throw new Error('personal_vault_disabled');
      }
      const filename = importFilename(req);
      if (!req.body) throw new Error('file_required');
      const contentLength = req.headers.get('content-length');
      const declaredSize = contentLength == null ? null : Number(contentLength);
      if (declaredSize != null && (!Number.isInteger(declaredSize) || declaredSize <= 0)) {
        throw new Error('personal_vault_import_content_length_invalid');
      }
      if (declaredSize != null && declaredSize > MAX_PERSONAL_VAULT_IMPORT_BYTES) {
        throw new Error('personal_archive_too_large');
      }
      const { sourceId, providerAccountId } = await resolveImportProvenance(
        workspaceId,
        user.id,
        new URL(req.url),
      );
      reservation = await reservePersonalVaultImportUpload(getOrgPg().sql, {
        workspaceId,
        userId: user.id,
        filename,
        declaredSizeBytes: declaredSize,
      });
      const stored = await storeReservedPersonalVaultImportArchive(
        getOrgPg().sql,
        reservation,
        req.body as unknown as AsyncIterable<Uint8Array>,
      );
      const job = await finalizePersonalVaultImportUpload(getOrgPg().sql, reservation, stored, {
        contentType: req.headers.get('content-type'),
        sourceId,
        providerAccountId,
      });
      reservation = null;
      const duplicate = job.storagePath !== stored.storagePath;
      if (duplicate) {
        await removePersonalVaultImportArchive(workspaceId, stored.storagePath);
      }
      return Response.json({
        ok: true,
        duplicate,
        job: publicPersonalVaultImportJob(job),
      }, { status: 202 });
    } catch (err) {
      if (reservation) {
        await releasePersonalVaultImportUpload(getOrgPg().sql, reservation).catch(() => undefined);
      }
      return importError(err);
    }
  },
});

const archiveImports = defineTool({
  method: 'GET',
  path: '/user/personal-vault/imports',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const jobs = await listPersonalVaultImportJobs(
      getOrgPg().sql,
      activeWorkspaceId(),
      user.id,
      50,
    );
    const storage = await personalVaultImportStorageUsage(
      getOrgPg().sql,
      activeWorkspaceId(),
      user.id,
    );
    return Response.json({ ok: true, jobs: jobs.map(publicPersonalVaultImportJob), storage });
  },
});

const cancelArchiveImport = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/imports',
  auth: 'loopback',
  async handler(req) {
    const id = new URL(req.url).searchParams.get('id')?.trim();
    if (!id) return Response.json({ ok: false, error: 'import_job_id_required' }, { status: 400 });
    const user = await getSessionUserOrDefault(req.headers);
    const job = await requestPersonalVaultImportCancellation(
      getOrgPg().sql,
      activeWorkspaceId(),
      user.id,
      id,
    );
    if (!job) return Response.json({ ok: false, error: 'import_job_not_found' }, { status: 404 });
    return Response.json({ ok: true, job: publicPersonalVaultImportJob(job) });
  },
});

const retryArchiveImport = defineTool({
  method: 'POST',
  path: '/user/personal-vault/imports/retry',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ id?: unknown }>(req);
    if (typeof body?.id !== 'string' || !body.id.trim()) {
      return Response.json({ ok: false, error: 'import_job_id_required' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const job = await retryPersonalVaultImportJob(
      getOrgPg().sql,
      activeWorkspaceId(),
      user.id,
      body.id.trim(),
    );
    if (!job) {
      return Response.json({ ok: false, error: 'import_job_not_retryable' }, { status: 409 });
    }
    return Response.json({ ok: true, job: publicPersonalVaultImportJob(job) });
  },
});

const grants = defineTool({
  method: 'GET',
  path: '/user/personal-vault/grants',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    return Response.json({
      ok: true,
      grants: await listPersonalGrants(getOrgPg().sql, workspaceId, user.id),
    });
  },
});

const previewGrant = defineTool({
  method: 'POST',
  path: '/user/personal-vault/grants/preview',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ planSlug?: unknown; harnessSlug?: unknown }>(req);
    if (typeof body?.planSlug !== 'string') {
      return Response.json({ ok: false, error: 'plan_slug_required' }, { status: 400 });
    }
    try {
      const preview = await resolvePlanGrantPreview(
        activeWorkspaceId(),
        body.planSlug,
        typeof body.harnessSlug === 'string' ? body.harnessSlug : null,
      );
      return Response.json({ ok: true, ...preview });
    } catch (err) {
      const error = messageOf(err);
      const statusCode = error === 'plan_not_found' ? 404 : 400;
      return Response.json({ ok: false, error }, { status: statusCode });
    }
  },
});

const approveGrant = defineTool({
  method: 'POST',
  path: '/user/personal-vault/grants',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{
      planSlug?: unknown;
      harnessSlug?: unknown;
      principalType?: unknown;
      principalId?: unknown;
      scopes?: unknown;
      expiresAt?: unknown;
    }>(req);
    if (!body) return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });

    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    let principalType: PersonalPrincipalType;
    let principalId: string;
    let scopes: string[];
    let metadata: Record<string, unknown> = { source: 'owner-settings' };
    try {
      if (typeof body.planSlug === 'string') {
        const preview = await resolvePlanGrantPreview(
          workspaceId,
          body.planSlug,
          typeof body.harnessSlug === 'string' ? body.harnessSlug : null,
        );
        principalType = preview.principalType;
        principalId = preview.principalId;
        scopes = preview.declaredScopes;
        metadata = {
          ...metadata,
          planSlug: preview.planSlug,
          harnessSlug: preview.harnessSlug,
          declaration: 'personalScopes',
        };
      } else {
        if (!PRINCIPAL_TYPES.includes(body.principalType as PersonalPrincipalType)) {
          throw new Error('invalid_principal_type');
        }
        if (typeof body.principalId !== 'string' || !body.principalId.trim()) {
          throw new Error('principal_id_required');
        }
        if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== 'string')) {
          throw new Error('scopes_required');
        }
        principalType = body.principalType as PersonalPrincipalType;
        principalId = body.principalId.trim();
        scopes = body.scopes as string[];
      }
      if (!scopes.length) throw new Error('personal_scopes_not_declared');
      const grant = await replacePersonalGrant(getOrgPg().sql, {
        workspaceId,
        userId: user.id,
        principalType,
        principalId,
        scopes,
        grantedBy: `owner:${user.id}`,
        expiresAt: typeof body.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt : null,
        metadata,
      });
      return Response.json({ ok: true, principalType, principalId, grant });
    } catch (err) {
      const error = messageOf(err);
      return Response.json({ ok: false, error }, { status: error === 'plan_not_found' ? 404 : 400 });
    }
  },
});

const revokeGrant = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/grants',
  auth: 'loopback',
  async handler(req) {
    const id = new URL(req.url).searchParams.get('id')?.trim();
    if (!id) return Response.json({ ok: false, error: 'grant_id_required' }, { status: 400 });
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const revoked = await revokePersonalGrant(getOrgPg().sql, workspaceId, user.id, id);
    return Response.json({ ok: true, id, revoked }, { status: revoked ? 200 : 404 });
  },
});

export default [
  status,
  setEnabled,
  purge,
  disconnectGoogle,
  setGoogleCapability,
  disconnectFacebook,
  archiveImport,
  archiveImports,
  cancelArchiveImport,
  retryArchiveImport,
  grants,
  previewGrant,
  approveGrant,
  revokeGrant,
];
