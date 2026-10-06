/**
 * Organization documents corpus (plan enterprise-data-sources-2026-10-01 P-014,
 * owner ruling D-005; schema: migration 1316).
 *
 * There is ONE documents corpus (`harness_shared.documents`, renamed from
 * `personal_documents` by migration 1327). A row's `scope` says whose it is:
 *   - personal      — owner-local Personal Vault row; read through personal-vault/store.ts, unchanged here.
 *   - organization  — user_id IS NULL; readable only through a source-derived permission list.
 *   - pot           — user_id IS NULL, pot_slug set; written by chat-retrieval-units.ts (P-015) for
 *                     a pot-scoped source and readable by an agent working in that pot
 *                     (searchPotDocuments below).
 *
 * Access to an organization document needs ALL of:
 *   1. the vault grant machinery: authorizePersonalAccess for the acting principal
 *      with the `organization` scope (coding-agent fence, vault kill switch, live grant);
 *   2. the source ACL: the document's permission list contains a provider identity
 *      that is mapped, explicitly and live, to the principal (D-002 — a provider
 *      identity never selects a principal on its own);
 *   3. the disclosure ledger: every returned document passes discloseDocuments in
 *      the caller's transaction, so the same reader-set labels and outbound
 *      refusals apply as for personal documents.
 *
 * ACL membership is evaluated at query time, so replacing a list's members takes
 * effect on the next read with no cache to invalidate.
 */
import type { Sql } from 'postgres';
import { authorizePersonalAccess, type PersonalAuthorization } from '../personal-vault/authorization';
import { discloseDocuments } from '../personal-vault/disclosure-ledger';
import type { DocumentLabel } from '../personal-vault/disclosure-labels';
import { normalizePersonalSource } from '../personal-vault/store';
import type { PersonalToolContext } from '../personal-vault/types';

/**
 * Vault grant scope that authorizes organization-corpus reads. personalScope()
 * stores it as `personal:organization`; an owner grants it like any other scope.
 */
export const ORGANIZATION_CORPUS_SCOPE = 'organization';
export const ORGANIZATION_SEARCH_VIA = 'organization:search';

export interface ProviderIdentity {
  provider: string;
  providerUserId: string;
}

function normalizeIdentity(identity: ProviderIdentity): ProviderIdentity {
  const provider = normalizePersonalSource(identity.provider);
  const providerUserId = identity.providerUserId.trim();
  if (!providerUserId) throw new Error('invalid_provider_user_id');
  return { provider, providerUserId };
}

function nonEmpty(value: string, code: string): string {
  const out = value.trim();
  if (!out) throw new Error(code);
  return out;
}

export async function upsertPermissionList(
  sql: Sql,
  workspaceId: string,
  input: { source: string; sourceRef: string; title?: string },
): Promise<{ id: string }> {
  const source = normalizePersonalSource(input.source);
  const sourceRef = nonEmpty(input.sourceRef, 'invalid_permission_list_source_ref');
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.document_permission_lists (workspace_id, source, source_ref, title)
    VALUES (${workspaceId}, ${source}, ${sourceRef}, ${input.title ?? ''})
    ON CONFLICT (workspace_id, source, source_ref)
    DO UPDATE SET title = EXCLUDED.title
    RETURNING id`;
  return { id: rows[0]!.id };
}

/**
 * Replace a list's members with exactly `members` — the refresh a connector runs
 * whenever the source reports a membership change. One statement, so a reader
 * never sees a half-applied set.
 */
export async function replacePermissionListMembers(
  sql: Sql,
  workspaceId: string,
  listId: string,
  members: readonly ProviderIdentity[],
): Promise<{ added: number; removed: number }> {
  const seen = new Map<string, ProviderIdentity>();
  for (const member of members.map(normalizeIdentity)) {
    seen.set(`${member.provider}\u0000${member.providerUserId}`, member);
  }
  const incoming = [...seen.values()];
  const providers = incoming.map((m) => m.provider);
  const providerUserIds = incoming.map((m) => m.providerUserId);
  const rows = await sql<Array<{ added: string; removed: string; touched: string }>>`
    WITH incoming AS (
      SELECT * FROM unnest(${providers}::text[], ${providerUserIds}::text[]) AS t(provider, provider_user_id)
    ), touched AS (
      UPDATE harness_shared.document_permission_lists
         SET refreshed_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${listId}::uuid
      RETURNING id
    ), removed AS (
      DELETE FROM harness_shared.document_permission_members m
       WHERE m.workspace_id = ${workspaceId} AND m.list_id = ${listId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM incoming i
            WHERE i.provider = m.provider AND i.provider_user_id = m.provider_user_id)
      RETURNING 1
    ), added AS (
      INSERT INTO harness_shared.document_permission_members (workspace_id, list_id, provider, provider_user_id)
      SELECT ${workspaceId}, ${listId}::uuid, i.provider, i.provider_user_id
        FROM incoming i
       WHERE EXISTS (SELECT 1 FROM touched)
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM added) AS added,
           (SELECT count(*) FROM removed) AS removed,
           (SELECT count(*) FROM touched) AS touched`;
  const row = rows[0]!;
  if (Number(row.touched) === 0) throw new Error('permission_list_not_found');
  return { added: Number(row.added), removed: Number(row.removed) };
}

/**
 * Map a provider identity to a local user (D-002). The caller is the owner-
 * controlled surface; `mappedBy` records who configured it. Re-mapping the same
 * identity to the same user is a no-op; to a different user it is refused — the
 * old mapping must be revoked first, never silently replaced.
 */
export async function mapProviderIdentity(
  sql: Sql,
  workspaceId: string,
  input: ProviderIdentity & { userId: string; mappedBy: string },
): Promise<{ id: string; created: boolean }> {
  const { provider, providerUserId } = normalizeIdentity(input);
  const mappedBy = nonEmpty(input.mappedBy, 'invalid_mapped_by');
  const inserted = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.provider_identity_mappings
      (workspace_id, provider, provider_user_id, user_id, mapped_by)
    VALUES (${workspaceId}, ${provider}, ${providerUserId}, ${input.userId}::uuid, ${mappedBy})
    ON CONFLICT (workspace_id, provider, provider_user_id) WHERE revoked_at IS NULL
    DO NOTHING
    RETURNING id`;
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const live = await sql<Array<{ id: string; user_id: string }>>`
    SELECT id, user_id FROM harness_shared.provider_identity_mappings
     WHERE workspace_id = ${workspaceId} AND provider = ${provider}
       AND provider_user_id = ${providerUserId} AND revoked_at IS NULL`;
  if (live[0] && live[0].user_id === input.userId) return { id: live[0].id, created: false };
  throw new Error('provider_identity_already_mapped');
}

export async function revokeProviderIdentityMapping(
  sql: Sql,
  workspaceId: string,
  input: ProviderIdentity & { revokedBy: string },
): Promise<{ revoked: number }> {
  const { provider, providerUserId } = normalizeIdentity(input);
  const revokedBy = nonEmpty(input.revokedBy, 'invalid_revoked_by');
  const rows = await sql`
    UPDATE harness_shared.provider_identity_mappings
       SET revoked_at = now(), revoked_by = ${revokedBy}
     WHERE workspace_id = ${workspaceId} AND provider = ${provider}
       AND provider_user_id = ${providerUserId} AND revoked_at IS NULL
    RETURNING id`;
  return { revoked: rows.length };
}

export interface OrganizationDocumentInput {
  source: string;
  kind: string;
  dedupeKey: string;
  externalId?: string | null;
  occurredAt?: string | null;
  participants?: string[];
  title?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export async function upsertOrganizationDocuments(
  sql: Sql,
  workspaceId: string,
  permissionListId: string,
  documents: readonly OrganizationDocumentInput[],
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (const doc of documents) {
    const source = normalizePersonalSource(doc.source);
    const kind = nonEmpty(doc.kind, 'invalid_document_kind');
    const dedupeKey = nonEmpty(doc.dedupeKey, 'invalid_document_dedupe_key');
    const rows = await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, scope, permission_list_id, source, kind, external_id,
         occurred_at, participants, title, text, metadata, dedupe_key)
      VALUES (${workspaceId}, NULL, 'organization', ${permissionListId}::uuid, ${source}, ${kind},
              ${doc.externalId ?? null}, ${doc.occurredAt ?? null}, ${doc.participants ?? []}::text[],
              ${doc.title ?? ''}, ${doc.text ?? ''}, ${sql.json((doc.metadata ?? {}) as never)}, ${dedupeKey})
      ON CONFLICT (workspace_id, source, dedupe_key) WHERE scope = 'organization'
      DO UPDATE SET permission_list_id = EXCLUDED.permission_list_id,
                    kind = EXCLUDED.kind,
                    external_id = EXCLUDED.external_id,
                    occurred_at = EXCLUDED.occurred_at,
                    participants = EXCLUDED.participants,
                    title = EXCLUDED.title,
                    text = EXCLUDED.text,
                    metadata = EXCLUDED.metadata,
                    updated_at = now()
      RETURNING id`;
    upserted += rows.length;
  }
  return { upserted };
}

export interface OrganizationSearchResult {
  id: string;
  source: string;
  kind: string;
  externalId: string | null;
  occurredAt: string | null;
  participants: string[];
  title: string;
  snippet: string;
  metadata: Record<string, unknown>;
  permissionListId: string;
  score: number;
  privacy: DocumentLabel | null;
}

export type OrganizationSearchOutcome =
  | { allowed: true; results: OrganizationSearchResult[]; withheld: number; disclosed: number }
  | { allowed: false; reason: NonNullable<PersonalAuthorization['reason']> };

/**
 * Search the organization corpus as `principalUserId` (the local user the agent
 * acts for, resolved server-side — never taken from a provider payload). Run it
 * inside the transaction that returns the results: the disclosure rows must
 * commit with the read.
 */
export async function searchOrganizationDocuments(
  sql: Sql,
  ctx: PersonalToolContext,
  params: {
    workspaceId: string;
    principalUserId: string;
    agentOwnerId: string | null;
    query: string;
    sources?: string[];
    limit?: number;
    snippetChars?: number;
  },
): Promise<OrganizationSearchOutcome> {
  const auth = await authorizePersonalAccess(
    sql, ctx, params.workspaceId, params.principalUserId, [ORGANIZATION_CORPUS_SCOPE],
  );
  if (!auth.allowed) return { allowed: false, reason: auth.reason ?? 'no_live_grant' };

  const limit = Math.max(1, Math.min(50, params.limit ?? 10));
  const snippetChars = Math.max(80, Math.min(1200, params.snippetChars ?? 600));
  const sources = [...new Set((params.sources ?? []).map(normalizePersonalSource))];
  const sourceFilter = sources.length ? sql`AND d.source = ANY(${sources})` : sql``;
  const rows = await sql<Array<{
    id: string; source: string; kind: string; external_id: string | null; occurred_at: string | null;
    participants: string[]; title: string; snippet: string; metadata: Record<string, unknown>;
    permission_list_id: string; score: number | string;
  }>>`
    SELECT d.id, d.source, d.kind, d.external_id, d.occurred_at::text AS occurred_at, d.participants, d.title,
           left(d.text, ${snippetChars}) AS snippet, d.metadata, d.permission_list_id,
           ts_rank_cd(d.text_tsv, websearch_to_tsquery('english', ${params.query})) AS score
      FROM harness_shared.documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.scope = 'organization' AND d.user_id IS NULL
       AND d.text_tsv @@ websearch_to_tsquery('english', ${params.query})
       ${sourceFilter}
       AND EXISTS (
         SELECT 1
           FROM harness_shared.document_permission_members m
           JOIN harness_shared.provider_identity_mappings p
             ON p.workspace_id = m.workspace_id
            AND p.provider = m.provider
            AND p.provider_user_id = m.provider_user_id
            AND p.revoked_at IS NULL
          WHERE m.workspace_id = d.workspace_id
            AND m.list_id = d.permission_list_id
            AND p.user_id = ${params.principalUserId}::uuid)
     ORDER BY score DESC, d.occurred_at DESC NULLS LAST
     LIMIT ${limit}`;

  const documents = rows.map((r) => ({
    id: r.id,
    source: r.source,
    kind: r.kind,
    externalId: r.external_id,
    occurredAt: r.occurred_at,
    participants: r.participants,
    title: r.title,
    snippet: r.snippet,
    metadata: r.metadata,
    permissionListId: r.permission_list_id,
    score: Number(r.score),
  }));
  const disclosed = await discloseDocuments(sql, {
    workspaceId: params.workspaceId,
    userId: params.principalUserId,
    agentOwnerId: params.agentOwnerId,
    documents,
    via: ORGANIZATION_SEARCH_VIA,
  });
  return {
    allowed: true,
    results: disclosed.documents,
    withheld: disclosed.withheld,
    disclosed: disclosed.disclosed,
  };
}

export const POT_SEARCH_VIA = 'pot:search';

export interface PotSearchResult {
  id: string;
  source: string;
  kind: string;
  externalId: string | null;
  occurredAt: string | null;
  participants: string[];
  title: string;
  snippet: string;
  metadata: Record<string, unknown>;
  potSlug: string;
  score: number;
  privacy: DocumentLabel | null;
}

export interface PotSearchOutcome {
  results: PotSearchResult[];
  withheld: number;
  disclosed: number;
}

/**
 * Search the pot corpus (scope = 'pot') of ONE pot. A pot row carries no
 * permission list (chat-retrieval-units refuses a source-acl source for exactly
 * that reason), so membership of the pot is the whole access rule: `potSlug`
 * MUST be the pot the agent is working in, read from server-owned presence
 * (coord_presence.pot_slug) — never a slug from tool input or a provider payload.
 * Results still pass the disclosure ledger, so the principal's privacy rules
 * label them and refuse a wider outbound audience. Run it inside the
 * transaction that returns the results.
 */
export async function searchPotDocuments(
  sql: Sql,
  params: {
    workspaceId: string;
    potSlug: string;
    principalUserId: string;
    agentOwnerId: string | null;
    query: string;
    sources?: string[];
    limit?: number;
    snippetChars?: number;
  },
): Promise<PotSearchOutcome> {
  const potSlug = params.potSlug.trim();
  if (!potSlug || !params.query.trim()) return { results: [], withheld: 0, disclosed: 0 };
  const limit = Math.max(1, Math.min(50, params.limit ?? 10));
  const snippetChars = Math.max(80, Math.min(1200, params.snippetChars ?? 600));
  const sources = [...new Set((params.sources ?? []).map(normalizePersonalSource))];
  const sourceFilter = sources.length ? sql`AND d.source = ANY(${sources})` : sql``;
  const rows = await sql<Array<{
    id: string; source: string; kind: string; external_id: string | null; occurred_at: string | null;
    participants: string[]; title: string; snippet: string; metadata: Record<string, unknown>;
    pot_slug: string; score: number | string;
  }>>`
    SELECT d.id, d.source, d.kind, d.external_id, d.occurred_at::text AS occurred_at, d.participants, d.title,
           left(d.text, ${snippetChars}) AS snippet, d.metadata, d.pot_slug,
           ts_rank_cd(d.text_tsv, websearch_to_tsquery('english', ${params.query})) AS score
      FROM harness_shared.documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.scope = 'pot' AND d.user_id IS NULL AND d.pot_slug = ${potSlug}
       AND d.text_tsv @@ websearch_to_tsquery('english', ${params.query})
       ${sourceFilter}
     ORDER BY score DESC, d.occurred_at DESC NULLS LAST
     LIMIT ${limit}`;
  const documents = rows.map((r) => ({
    id: r.id,
    source: r.source,
    kind: r.kind,
    externalId: r.external_id,
    occurredAt: r.occurred_at,
    participants: r.participants,
    title: r.title,
    snippet: r.snippet,
    metadata: r.metadata,
    potSlug: r.pot_slug,
    score: Number(r.score),
  }));
  const disclosed = await discloseDocuments(sql, {
    workspaceId: params.workspaceId,
    userId: params.principalUserId,
    agentOwnerId: params.agentOwnerId,
    documents,
    via: POT_SEARCH_VIA,
  });
  return { results: disclosed.documents, withheld: disclosed.withheld, disclosed: disclosed.disclosed };
}
