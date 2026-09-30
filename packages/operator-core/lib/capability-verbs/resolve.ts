/**
 * D-019 Tier-1 substrate: resolve a CANONICAL object id to the stored payload,
 * the owning trigger source, and its credential — under the D-008 explicit
 * local principal, never provider payload identity.
 *
 * This is what lets the capability verbs be provider-neutral. `mail:reply`
 * names a canonical `email-message`; which provider actually delivers it is a
 * property of the connected source, not of the verb the agent called. Adding
 * Outlook later is a new adapter behind `outboundAdapterKind`, not a new verb.
 *
 * Why the stored document and not a live provider fetch: the vault row was
 * written by OUR adapter from real message headers, so its `participants[]`
 * and reply coordinates are server-derived facts. That is precisely the
 * property the D-020 rails depend on — see `addressing.ts`.
 */
import type postgres from 'postgres';
import { listOwnedExternalTriggerSources, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { listSocialPlatforms } from '../external-triggers/social/platform-registry';

type Db = postgres.Sql | postgres.TransactionSql;

/** Canonical datatype (D-004) → the vault source that stores it. */
export const CANONICAL_SOURCE_BY_DATATYPE = {
  'email-message': 'gmail',
  'calendar-event': 'calendar',
  'chat-message': 'slack',
  contact: 'contacts',
} as const;

export type CanonicalDatatype = keyof typeof CANONICAL_SOURCE_BY_DATATYPE;

/**
 * Vault source name → trigger_sources.kind. They differ for calendar
 * ('calendar' in the vault, 'gcal' as a trigger source), which is exactly the
 * kind of drift a hand-maintained second copy would introduce silently.
 */
const TRIGGER_KIND_BY_VAULT_SOURCE: Record<string, string> = {
  gmail: 'gmail',
  calendar: 'gcal',
  contacts: 'contacts',
  slack: 'slack',
  facebook: 'facebook',
  // Social platforms (D-001): the platform id IS the vault source name AND the
  // trigger-source kind, so these are DERIVED from the registry rather than
  // restated. Writing the ten ids out by hand would be a second copy of a truth
  // the registry owns, and the drift it invites is silent — a platform whose
  // adapter works and whose credential simply never resolves.
  ...Object.fromEntries(listSocialPlatforms().map((row) => [row.id, row.id])),
};

export interface CanonicalDocument {
  id: string;
  source: string;
  /** Immutable trigger-source identity that owns this stored document. */
  sourceId?: string | null;
  /** Provider-native account identity retained for audit/display. */
  providerAccountId?: string | null;
  kind: string;
  externalId: string;
  occurredAt: string | null;
  participants: string[];
  title: string;
  text: string;
  /** The normalized provider-neutral payload written by the adapter. */
  payload: Record<string, unknown>;
}

export interface OutboundContext {
  source: ExternalTriggerSourceRow;
  /** Harness slug the OAuth credential is filed under. */
  installSlug: string;
  userId: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read one canonical object the owner actually has in their vault.
 *
 * Scoped to (workspace, user) so a caller can never address another
 * principal's mail by guessing an id.
 */
export async function resolveCanonicalDocument(
  sql: Db,
  params: { workspaceId: string; userId: string; source: string; externalId: string; sourceId?: string | null },
): Promise<CanonicalDocument> {
  const source = string(params.source);
  const externalId = string(params.externalId);
  const sourceId = string(params.sourceId);
  if (!source) throw new Error('canonical_source_required');
  if (!externalId) throw new Error('canonical_external_id_required');
  const rows = await sql<
    Array<{
      id: string;
      source: string;
      sourceId: string | null;
      providerAccountId: string | null;
      kind: string;
      externalId: string | null;
      occurredAt: string | null;
      participants: string[] | null;
      title: string | null;
      text: string | null;
      metadata: unknown;
    }>
  >`
    SELECT d.id::text,
           d.source,
           d.source_id::text AS "sourceId",
           d.provider_account_id AS "providerAccountId",
           d.kind,
           d.external_id AS "externalId",
           d.occurred_at::text AS "occurredAt",
           d.participants,
           d.title,
           d.text,
           d.metadata
      FROM harness_shared.personal_documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.user_id = ${params.userId}::uuid
       AND d.source = ${source}
       AND d.external_id = ${externalId}
       AND (${sourceId || null}::text IS NULL OR d.source_id = ${sourceId || null}::uuid)
     ORDER BY d.id
     LIMIT 2`;
  if (rows.length > 1) throw new Error(`canonical_document_ambiguous:${source}:${externalId}`);
  const row = rows[0];
  if (!row) throw new Error(`canonical_document_not_found:${source}:${externalId}`);
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    providerAccountId: row.providerAccountId,
    kind: row.kind,
    externalId: row.externalId ?? externalId,
    occurredAt: row.occurredAt,
    participants: row.participants ?? [],
    title: row.title ?? '',
    text: row.text ?? '',
    payload: object(row.metadata),
  };
}

/**
 * Resolve an exact connected account when a canonical source id is available.
 * Legacy callers without one remain supported only while the kind has a single
 * owned source; choosing the first of several accounts would silently act as
 * the wrong identity.
 */
export async function resolveOutboundContext(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    vaultSource: string;
    sourceId?: string | null;
    /**
     * Select the sending account by its provider address (`from`) when the
     * owner has connected more than one. Create-shaped outbound has no stored
     * document to resolve the account from — unlike a reply, which inherits it
     * — so with several accounts connected there is nothing to disambiguate on
     * and the caller must say. Matched case-insensitively against
     * provider_account_id.
     */
    providerAccountId?: string | null;
    defaultInstallSlug?: string;
  },
): Promise<OutboundContext> {
  const kind = TRIGGER_KIND_BY_VAULT_SOURCE[string(params.vaultSource)];
  if (!kind) throw new Error(`outbound_source_unsupported:${params.vaultSource}`);
  const owned = await listOwnedExternalTriggerSources(sql, params.workspaceId, params.userId);
  const candidates = owned.filter((row) => row.kind === kind);
  const sourceId = string(params.sourceId);
  const account = string(params.providerAccountId).toLowerCase();
  const byAccount = account
    ? candidates.filter((row) => string(row.providerAccountId).toLowerCase() === account)
    : null;
  if (byAccount && !byAccount.length) {
    // Name what IS connected: the caller asked for an account the owner does
    // not have, and the set they could have meant is the actionable half.
    const known = candidates.map((row) => string(row.providerAccountId) || row.id).filter(Boolean);
    throw new Error(
      `outbound_source_account_not_connected:${kind}:${account}${known.length ? ` (connected: ${known.join(', ')})` : ''}`,
    );
  }
  const pool = byAccount ?? candidates;
  const source = sourceId
    ? pool.find((row) => row.id === sourceId)
    : pool.length === 1 ? pool[0] : undefined;
  if (!source && sourceId) throw new Error(`outbound_source_not_connected:${kind}:${sourceId}`);
  if (!source && pool.length > 1) {
    // An ambiguous refusal is only actionable if it says what to choose
    // BETWEEN — otherwise the caller's only move is to guess.
    const known = pool.map((row) => string(row.providerAccountId) || row.id).filter(Boolean);
    throw new Error(`outbound_source_ambiguous:${kind}${known.length ? ` (connected: ${known.join(', ')})` : ''}`);
  }
  if (!source) throw new Error(`outbound_source_not_connected:${kind}`);
  if (!source.credentialRef) throw new Error(`outbound_source_credential_missing:${kind}`);
  if (source.status === 'disabled' || source.status === 'error') {
    throw new Error(`outbound_source_unavailable:${kind}:${source.status}`);
  }
  if (source.ownerUserId !== params.userId) {
    // Defence in depth: the query already scopes by owner, so reaching here
    // means the ownership contract itself is broken.
    throw new Error(`outbound_source_owner_mismatch:${kind}`);
  }
  return {
    source,
    installSlug: string(source.config.installSlug) || params.defaultInstallSlug || 'papercusp',
    userId: params.userId,
  };
}
