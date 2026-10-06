import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  PersonalDocumentInput,
  PersonalPrincipalType,
  PersonalSearchInput,
  PersonalSearchResult,
} from './types';
import {
  proseProfilePredicateSql,
  resolveCurrentProseProfileSelection,
} from '../search/prose-vector-dims';

const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePersonalSource(value: string): string {
  const source = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SOURCE_RE.test(source)) throw new Error(`invalid_personal_source:${value}`);
  return source;
}

export function personalScope(sourceOrScope: string): string {
  const raw = sourceOrScope.trim().toLowerCase();
  const source = raw.startsWith('personal:') ? raw.slice('personal:'.length) : raw;
  return `personal:${normalizePersonalSource(source)}`;
}

export function normalizeParticipant(value: string): string {
  const v = value.trim().toLowerCase();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  return (angle?.[1] ?? v).replace(/^mailto:/, '').replace(/^@/, '');
}

export function normalizePersonalProviderAccountId(value?: string | null): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  if (normalized.length > 512) throw new Error('personal_provider_account_id_too_long');
  return normalized;
}

export function normalizePersonalSourceId(value?: string | null): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  if (!UUID_RE.test(normalized)) throw new Error('personal_source_id_invalid');
  return normalized;
}

export function dedupeKeyFor(doc: PersonalDocumentInput): string {
  const raw = doc.dedupeKey?.trim() || createHash('sha256').update([
    normalizePersonalSource(doc.source),
    doc.kind.trim().toLowerCase(),
    doc.externalId ?? '',
    doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt ?? '',
    doc.title ?? '',
    doc.text ?? '',
  ].join('\u001f')).digest('hex');
  const accountId = normalizePersonalProviderAccountId(doc.providerAccountId);
  if (!accountId) return raw;
  return `account:${createHash('sha256').update(accountId).digest('hex')}:${raw}`;
}

type PersonalAliasKind = 'email' | 'contact' | 'social-handle' | 'name';

interface PersonalAliasCandidate {
  source: string;
  kind: PersonalAliasKind;
  normalized: string;
  display: string;
}

function nonEmailAliasKind(source: string, value: string): PersonalAliasKind {
  if (source === 'facebook' || source === 'instagram' || source === 'x') {
    return value.trim().startsWith('@') || !/\s/.test(value.trim()) ? 'social-handle' : 'name';
  }
  return 'name';
}

/**
 * Alias groups represent one human each. A contact row's multiple email
 * addresses + display name are one group; message/event participants are
 * separate people and must never be collapsed into one identity.
 */
export function personalAliasGroups(doc: PersonalDocumentInput): PersonalAliasCandidate[][] {
  const source = normalizePersonalSource(doc.source);
  const participants = [...new Set((doc.participants ?? []).map((value) => value.trim()).filter(Boolean))];
  if (doc.kind.trim().toLowerCase() === 'contact') {
    const group: PersonalAliasCandidate[] = participants.map((display) => {
      const normalized = normalizeParticipant(display);
      return { source, kind: normalized.includes('@') ? 'email' : nonEmailAliasKind(source, display), normalized, display };
    });
    const displayName = doc.title?.trim();
    if (displayName) {
      const normalized = normalizeParticipant(displayName);
      if (normalized && !group.some((alias) => alias.normalized === normalized)) {
        group.push({ source, kind: 'name', normalized, display: displayName });
      }
    }
    return group.length ? [group] : [];
  }
  return participants.flatMap((display) => {
    const normalized = normalizeParticipant(display);
    if (!normalized) return [];
    return [[{
      source,
      kind: normalized.includes('@') ? 'email' : nonEmailAliasKind(source, display),
      normalized,
      display,
    } satisfies PersonalAliasCandidate]];
  });
}

async function mergePersonalIdentities(
  sql: Sql,
  workspaceId: string,
  userId: string,
  targetId: string,
  duplicateIds: string[],
): Promise<void> {
  if (!duplicateIds.length) return;
  // Remove alias rows that would collide with an already-present canonical
  // alias, then move every remaining alias and document reference to target.
  await sql`
    DELETE FROM harness_shared.personal_identity_aliases duplicate
     USING harness_shared.personal_identity_aliases canonical
     WHERE duplicate.workspace_id = ${workspaceId}
       AND duplicate.user_id = ${userId}
       AND duplicate.identity_id = ANY(${duplicateIds}::uuid[])
       AND canonical.workspace_id = duplicate.workspace_id
       AND canonical.user_id = duplicate.user_id
       AND canonical.identity_id = ${targetId}::uuid
       AND canonical.source = duplicate.source
       AND canonical.alias_kind = duplicate.alias_kind
       AND canonical.normalized_value = duplicate.normalized_value`;
  await sql`
    UPDATE harness_shared.personal_identity_aliases
       SET identity_id = ${targetId}::uuid
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND identity_id = ANY(${duplicateIds}::uuid[])`;
  await sql`
    UPDATE harness_shared.documents d
       SET participant_ids = ARRAY(
         SELECT DISTINCT CASE
           WHEN participant_id = ANY(${duplicateIds}::uuid[]) THEN ${targetId}::uuid
           ELSE participant_id
         END
         FROM unnest(d.participant_ids) AS participant_id
       ),
       updated_at = now()
     WHERE d.workspace_id = ${workspaceId} AND d.user_id = ${userId}
       AND d.participant_ids && ${duplicateIds}::uuid[]`;
  await sql`
    DELETE FROM harness_shared.personal_identities
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND id = ANY(${duplicateIds}::uuid[])`;
}

async function resolvePersonalAliasGroup(
  sql: Sql,
  workspaceId: string,
  userId: string,
  aliases: PersonalAliasCandidate[],
): Promise<string> {
  const values = [...new Set(aliases.map((alias) => alias.normalized))];
  const existing = await sql<Array<{ identity_id: string; created_at: string }>>`
    SELECT identity_id, min(created_at)::text AS created_at
      FROM harness_shared.personal_identity_aliases
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND normalized_value = ANY(${values})
     GROUP BY identity_id
     ORDER BY min(created_at), identity_id`;
  const email = aliases.find((alias) => alias.kind === 'email')?.normalized ?? null;
  const displayName = aliases.find((alias) => alias.kind === 'name')?.display
    ?? aliases.find((alias) => alias.kind !== 'email')?.display
    ?? email
    ?? '';
  let identityId = existing[0]?.identity_id;
  if (!identityId) {
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.personal_identities
        (workspace_id, user_id, display_name, primary_email, metadata)
      VALUES (${workspaceId}, ${userId}, ${displayName}, ${email}, ${JSON.stringify({ resolver: 'exact-alias-v1' })}::jsonb)
      RETURNING id`;
    identityId = created[0]!.id;
  } else {
    await mergePersonalIdentities(sql, workspaceId, userId, identityId, existing.slice(1).map((row) => row.identity_id));
    await sql`
      UPDATE harness_shared.personal_identities
         SET display_name = CASE WHEN display_name = '' THEN ${displayName} ELSE display_name END,
             primary_email = COALESCE(primary_email, ${email}),
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${identityId}::uuid`;
  }
  for (const alias of aliases) {
    await sql`
      INSERT INTO harness_shared.personal_identity_aliases
        (workspace_id, user_id, identity_id, source, alias_kind,
         normalized_value, display_value, metadata)
      VALUES (${workspaceId}, ${userId}, ${identityId}::uuid, ${alias.source}, ${alias.kind},
              ${alias.normalized}, ${alias.display}, ${JSON.stringify({ resolver: 'exact-alias-v1' })}::jsonb)
      ON CONFLICT (workspace_id, user_id, source, alias_kind, normalized_value)
      DO UPDATE SET identity_id = EXCLUDED.identity_id,
                    display_value = EXCLUDED.display_value,
                    metadata = EXCLUDED.metadata`;
  }
  return identityId;
}

export async function resolvePersonalIdentityIds(
  sql: Sql,
  workspaceId: string,
  userId: string,
  doc: PersonalDocumentInput,
): Promise<string[]> {
  const ids: string[] = [];
  for (const group of personalAliasGroups(doc)) {
    ids.push(await resolvePersonalAliasGroup(sql, workspaceId, userId, group));
  }
  return [...new Set(ids)];
}

export async function isPersonalVaultEnabled(sql: Sql, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await sql<Array<{ enabled: boolean }>>`
    SELECT enabled
      FROM harness_shared.personal_vault_settings
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
     LIMIT 1`;
  return rows[0]?.enabled ?? true;
}

export async function setPersonalVaultEnabled(
  sql: Sql,
  workspaceId: string,
  userId: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.personal_vault_settings
      (workspace_id, user_id, enabled, updated_by)
    VALUES (${workspaceId}, ${userId}, ${enabled}, ${updatedBy})
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`;
}

export async function upsertPersonalDocuments(
  sql: Sql,
  workspaceId: string,
  userId: string,
  documents: PersonalDocumentInput[],
): Promise<{ insertedOrUpdated: number; ids: string[] }> {
  if (!(await isPersonalVaultEnabled(sql, workspaceId, userId))) throw new Error('personal_vault_disabled');
  const ids: string[] = [];
  for (const doc of documents) {
    const source = normalizePersonalSource(doc.source);
    const sourceId = normalizePersonalSourceId(doc.sourceId);
    const providerAccountId = normalizePersonalProviderAccountId(doc.providerAccountId);
    if (sourceId && !providerAccountId) throw new Error('personal_provider_account_id_required_for_source');
    const participants = [...new Set((doc.participants ?? []).map(normalizeParticipant).filter(Boolean))];
    const resolvedParticipantIds = participants.length
      ? await resolvePersonalIdentityIds(sql, workspaceId, userId, { ...doc, source })
      : [];
    const participantIds = [...new Set([...(doc.participantIds ?? []), ...resolvedParticipantIds])];
    const occurredAt = doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt ?? null;
    const metadata = JSON.stringify(doc.metadata ?? {});
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, source_id, provider_account_id, datatype_id, kind, external_id, occurred_at,
         participants, participant_ids, title, text, metadata, dedupe_key)
      VALUES
        (${workspaceId}, ${userId}, ${source}, ${sourceId}::uuid, ${providerAccountId},
         ${doc.datatypeId?.trim() || null}, ${doc.kind.trim()}, ${doc.externalId ?? null},
         ${occurredAt}, ${participants}, ${participantIds}, ${doc.title ?? ''}, ${doc.text ?? ''},
         ${metadata}::jsonb, ${dedupeKeyFor(doc)})
      ON CONFLICT (workspace_id, user_id, source, dedupe_key) DO UPDATE
        SET kind = EXCLUDED.kind,
            datatype_id = COALESCE(EXCLUDED.datatype_id, documents.datatype_id),
            source_id = COALESCE(EXCLUDED.source_id, documents.source_id),
            provider_account_id = COALESCE(EXCLUDED.provider_account_id, documents.provider_account_id),
            external_id = EXCLUDED.external_id,
            occurred_at = COALESCE(EXCLUDED.occurred_at, documents.occurred_at),
            participants = EXCLUDED.participants,
            participant_ids = EXCLUDED.participant_ids,
            title = EXCLUDED.title,
            text = EXCLUDED.text,
            metadata = EXCLUDED.metadata,
            embedding = CASE
              WHEN documents.title IS DISTINCT FROM EXCLUDED.title
                OR documents.text IS DISTINCT FROM EXCLUDED.text
              THEN NULL ELSE documents.embedding END,
            embedding_mode = CASE
              WHEN documents.title IS DISTINCT FROM EXCLUDED.title
                OR documents.text IS DISTINCT FROM EXCLUDED.text
              THEN NULL ELSE documents.embedding_mode END,
            embedding_profile = CASE
              WHEN documents.title IS DISTINCT FROM EXCLUDED.title
                OR documents.text IS DISTINCT FROM EXCLUDED.text
              THEN NULL ELSE documents.embedding_profile END,
            updated_at = now()
      RETURNING id`;
    ids.push(rows[0]!.id);
  }
  return { insertedOrUpdated: ids.length, ids };
}

export async function setPersonalSyncState(
  sql: Sql,
  workspaceId: string,
  userId: string,
  sourceInput: string,
  cursor: Record<string, unknown>,
  lastError: string | null = null,
): Promise<void> {
  const source = normalizePersonalSource(sourceInput);
  await sql`
    INSERT INTO harness_shared.personal_sync_state
      (workspace_id, user_id, source, cursor, last_sync_at, last_error)
    VALUES (${workspaceId}, ${userId}, ${source}, ${JSON.stringify(cursor)}::jsonb, now(), ${lastError})
    ON CONFLICT (workspace_id, user_id, source) DO UPDATE
      SET cursor = EXCLUDED.cursor,
          last_sync_at = EXCLUDED.last_sync_at,
          last_error = EXCLUDED.last_error,
          updated_at = now()`;
}

export async function createPersonalGrant(
  sql: Sql | TransactionSql,
  input: {
    workspaceId: string;
    userId: string;
    principalType: PersonalPrincipalType;
    principalId: string;
    scopes: string[];
    grantedBy: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; scopes: string[] }> {
  const scopes = [...new Set(input.scopes.map(personalScope))].sort();
  if (!scopes.length) throw new Error('personal_grant_scopes_required');
  const rows = await sql<Array<{ id: string; scopes: string[] }>>`
    INSERT INTO harness_shared.personal_grants
      (workspace_id, user_id, principal_type, principal_id, scopes,
       granted_by, expires_at, metadata)
    VALUES (${input.workspaceId}, ${input.userId}, ${input.principalType}, ${input.principalId.trim()},
            ${scopes}, ${input.grantedBy}, ${input.expiresAt ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb)
    ON CONFLICT (workspace_id, user_id, principal_type, principal_id, scopes)
      WHERE revoked_at IS NULL
    DO UPDATE SET granted_by = EXCLUDED.granted_by,
                  granted_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  metadata = EXCLUDED.metadata
    RETURNING id, scopes`;
  return rows[0]!;
}

/**
 * Replace the live grant set for one principal with exactly the scopes the
 * owner just approved. A plain create is intentionally append-friendly for
 * low-level callers, but the Settings/arming surface must not leave an older,
 * broader grant live when a template narrows its `personalScopes` declaration.
 */
export async function replacePersonalGrant(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    principalType: PersonalPrincipalType;
    principalId: string;
    scopes: string[];
    grantedBy: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; scopes: string[]; revoked: number }> {
  const scopes = [...new Set(input.scopes.map(personalScope))].sort();
  if (!scopes.length) throw new Error('personal_grant_scopes_required');
  const principalId = input.principalId.trim();
  if (!principalId) throw new Error('personal_grant_principal_required');

  return sql.begin(async (tx) => {
    const revoked = await tx<Array<{ id: string }>>`
      UPDATE harness_shared.personal_grants
         SET revoked_at = now()
       WHERE workspace_id = ${input.workspaceId}
         AND user_id = ${input.userId}
         AND principal_type = ${input.principalType}
         AND principal_id = ${principalId}
         AND revoked_at IS NULL
         AND scopes IS DISTINCT FROM ${scopes}::text[]
      RETURNING id`;
    const grant = await createPersonalGrant(tx, {
      ...input,
      principalId,
      scopes,
    });
    return { ...grant, revoked: revoked.length };
  });
}

export async function revokePersonalGrant(
  sql: Sql,
  workspaceId: string,
  userId: string,
  grantId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.personal_grants
       SET revoked_at = now()
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND id = ${grantId} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function listPersonalGrants(sql: Sql, workspaceId: string, userId: string) {
  return sql`
    SELECT id, principal_type, principal_id, scopes, granted_by,
           granted_at, expires_at, revoked_at
      FROM harness_shared.personal_grants
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
     ORDER BY granted_at DESC`;
}

export async function personalVaultStats(sql: Sql, workspaceId: string, userId: string) {
  const [counts, unembedded] = await Promise.all([
    sql<Array<{
      source: string;
      source_id: string | null;
      provider_account_id: string | null;
      documents: number;
      newest_at: string | null;
    }>>`
      SELECT source, source_id::text, provider_account_id,
             count(*)::int AS documents, max(occurred_at)::text AS newest_at
        FROM harness_shared.documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       GROUP BY source, source_id, provider_account_id
       ORDER BY source, provider_account_id NULLS FIRST, source_id NULLS FIRST`,
    sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND embedding IS NULL`,
  ]);
  return { sources: counts, unembedded: unembedded[0]?.count ?? 0 };
}

export async function purgePersonalSource(
  sql: Sql,
  workspaceId: string,
  userId: string,
  sourceInput?: string | null,
  provenance: { sourceId?: string | null; providerAccountId?: string | null } = {},
): Promise<{ documents: number; cursors: number; aliases: number; identities: number }> {
  const source = sourceInput ? normalizePersonalSource(sourceInput) : null;
  const sourceId = normalizePersonalSourceId(provenance.sourceId);
  const providerAccountId = normalizePersonalProviderAccountId(provenance.providerAccountId);
  const accountScoped = sourceId !== null || providerAccountId !== null;
  return sql.begin(async (tx) => {
    const docs = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND (${source}::text IS NULL OR source = ${source})
         AND (${sourceId}::uuid IS NULL OR source_id = ${sourceId}::uuid)
         AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
      RETURNING id`;
    const cursors = await tx<Array<{ source: string }>>`
      DELETE FROM harness_shared.personal_sync_state
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND ${!accountScoped}
         AND (${source}::text IS NULL OR source = ${source})
      RETURNING source`;
    const aliases = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.personal_identity_aliases
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND (
           (${!accountScoped} AND (${source}::text IS NULL OR source = ${source}))
           OR (${accountScoped} AND NOT EXISTS (
             SELECT 1 FROM harness_shared.documents document
              WHERE document.workspace_id = personal_identity_aliases.workspace_id
                AND document.user_id = personal_identity_aliases.user_id
                AND personal_identity_aliases.identity_id = ANY(document.participant_ids)
           ))
         )
      RETURNING id`;
    const identities = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.personal_identities i
       WHERE i.workspace_id = ${workspaceId} AND i.user_id = ${userId}
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.personal_identity_aliases a
            WHERE a.workspace_id = i.workspace_id AND a.user_id = i.user_id
              AND a.identity_id = i.id)
      RETURNING id`;
    return { documents: docs.length, cursors: cursors.length, aliases: aliases.length, identities: identities.length };
  });
}

export async function searchPersonalDocuments(
  sql: Sql,
  workspaceId: string,
  userId: string,
  input: PersonalSearchInput,
): Promise<PersonalSearchResult[]> {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const snippetChars = Math.max(80, Math.min(1200, input.snippetChars ?? 600));
  const scopes = [...new Set((input.scopes ?? []).map(personalScope))];
  const sourceIds = [...new Set(
    (input.sourceIds ?? []).map(normalizePersonalSourceId).filter((id): id is string => id !== null),
  )];
  const providerAccountIds = [...new Set(
    (input.providerAccountIds ?? [])
      .map(normalizePersonalProviderAccountId)
      .filter((id): id is string => id !== null),
  )];
  const participants = [...new Set((input.participants ?? []).map(normalizeParticipant).filter(Boolean))];
  const aliases = participants.length
    ? await sql<Array<{ identity_id: string }>>`
        SELECT DISTINCT identity_id
          FROM harness_shared.personal_identity_aliases
         WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
           AND normalized_value = ANY(${participants})`
    : [];
  const participantIds = aliases.map((r) => r.identity_id);
  const scopeFilter = scopes.length ? sql`AND d.scope_key = ANY(${scopes})` : sql``;
  const sourceIdFilter = sourceIds.length ? sql`AND d.source_id = ANY(${sourceIds}::uuid[])` : sql``;
  const providerAccountFilter = providerAccountIds.length
    ? sql`AND d.provider_account_id = ANY(${providerAccountIds})`
    : sql``;
  const participantFilter = participants.length
    ? sql`AND (d.participants && ${participants}::text[] OR d.participant_ids && ${participantIds}::uuid[])`
    : sql``;
  const fromFilter = input.timeRange?.from ? sql`AND d.occurred_at >= ${input.timeRange.from}` : sql``;
  const toFilter = input.timeRange?.to ? sql`AND d.occurred_at <= ${input.timeRange.to}` : sql``;
  const vector = input.queryEmbedding?.length ? `[${input.queryEmbedding.join(',')}]` : null;
  const personalSelection = resolveCurrentProseProfileSelection('gemma');
  const vectorCte = vector
    ? sql`SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS vector_rank
            FROM filtered WHERE embedding IS NOT NULL
              AND ${proseProfilePredicateSql(sql, personalSelection, 'embedding_profile', 'embedding_mode')}
           ORDER BY embedding <=> ${vector}::vector LIMIT ${Math.max(limit * 4, 20)}`
    : sql`SELECT id, NULL::bigint AS vector_rank FROM filtered WHERE false`;

  const rows = await sql<Array<{
    id: string; source: string; scope_key: string; source_id: string | null;
    provider_account_id: string | null; kind: string; external_id: string | null;
    occurred_at: string | null; participants: string[]; participant_ids: string[]; title: string;
    snippet: string; metadata: Record<string, unknown>; score: number | string;
    lexical_rank: number | string | null; vector_rank: number | string | null;
  }>>`
    WITH filtered AS (
      SELECT d.*
        FROM harness_shared.documents d
       WHERE d.workspace_id = ${workspaceId} AND d.user_id = ${userId}
         ${scopeFilter} ${sourceIdFilter} ${providerAccountFilter}
         ${participantFilter} ${fromFilter} ${toFilter}
    ), lexical AS (
      SELECT id,
             row_number() OVER (
               ORDER BY ts_rank_cd(text_tsv, websearch_to_tsquery('english', ${input.query})) DESC
             ) AS lexical_rank
        FROM filtered
       WHERE text_tsv @@ websearch_to_tsquery('english', ${input.query})
       ORDER BY ts_rank_cd(text_tsv, websearch_to_tsquery('english', ${input.query})) DESC
       LIMIT ${Math.max(limit * 4, 20)}
    ), vector AS (${vectorCte}), ranked AS (
      SELECT COALESCE(l.id, v.id) AS id,
             l.lexical_rank,
             v.vector_rank,
             COALESCE(1.0 / (60 + l.lexical_rank), 0)
               + COALESCE(1.0 / (60 + v.vector_rank), 0) AS score
        FROM lexical l FULL OUTER JOIN vector v ON v.id = l.id
    )
    SELECT d.id, d.source, d.scope_key, d.source_id::text, d.provider_account_id,
           d.kind, d.external_id,
           d.occurred_at::text, d.participants, d.participant_ids, d.title,
           left(d.text, ${snippetChars}) AS snippet, d.metadata,
           r.score, r.lexical_rank, r.vector_rank
      FROM ranked r JOIN filtered d ON d.id = r.id
     ORDER BY r.score DESC, d.occurred_at DESC NULLS LAST
     LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    scopeKey: r.scope_key,
    sourceId: r.source_id,
    providerAccountId: r.provider_account_id,
    kind: r.kind,
    externalId: r.external_id,
    occurredAt: r.occurred_at,
    participants: r.participants ?? [],
    participantIds: r.participant_ids ?? [],
    title: r.title,
    snippet: r.snippet,
    metadata: r.metadata ?? {},
    score: Number(r.score),
    lexicalRank: r.lexical_rank == null ? null : Number(r.lexical_rank),
    vectorRank: r.vector_rank == null ? null : Number(r.vector_rank),
  }));
}
