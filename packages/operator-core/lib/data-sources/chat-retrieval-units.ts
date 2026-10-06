/**
 * Chat retrieval units (plan enterprise-data-sources-2026-10-01 P-015; schema:
 * migration 1320).
 *
 * Raw chat messages are stored one row per provider message (`chat_messages`). The
 * unit that is INDEXED is a rollup of them (`chat_retrieval_units`):
 *   - thread — every live message sharing a thread_key;
 *   - window — non-thread channel messages split wherever two consecutive messages
 *              are more than `gapMinutes` apart. A window never crosses a UTC day,
 *              so a change only ever re-renders the windows of its own day.
 *
 * Writes never render directly. They enqueue the affected bucket (the thread, or the
 * channel-day) in `chat_rollup_queue`, and `rollupChatUnits` re-renders each queued
 * bucket from the LIVE messages. So an edit re-renders its unit, and a delete
 * (`tombstoneChatMessage`) removes the text from the unit on the next rollup.
 * A change to a source's routing (scope, scope_ref, owner, provider account,
 * datatype mapping, destination or permission policy) re-queues every bucket of that
 * source in the database itself (trigger `data_sources_requeue_chat_buckets`,
 * migration 1326), so the next rollup moves existing units without a new message.
 *
 * Rendered units go to the documents corpus (D-005) only when destination_policy routes
 * the source's chat-message datatype to `document`. Where they land follows the
 * source's scope (see corpusRouteFor):
 *   - organization (permission_mapping.mode = source-acl): the unit's permission list
 *     is the channel's list (source = connector kind, source_ref = channel id). A list
 *     that does not exist yet is created EMPTY, so nobody can read the unit until the
 *     connector reports the channel's members (fail closed).
 *   - personal (mode = owner): the owner's Personal Vault, through the vault writer, so
 *     vault semantics apply (deny-by-default grants, disclosure ledger, the disabled
 *     switch). The key is account-prefixed like every vault row.
 *   - pot: a scope='pot' row for the source's scope_ref; read only by that pot's agents.
 * Any other configuration still computes units but writes no corpus row, and counts
 * the reason in ChatRollupResult.corpusSkipped.
 *
 * Retention (`retention_policy.maxAgeDays`) and legal holds: `purgeExpiredChatMessages`
 * deletes expired messages and erases tombstoned bodies, skipping anything under an
 * active hold. The database enforces holds independently (trigger
 * chat_messages_enforce_legal_hold), so no path — including deleting the data source —
 * can destroy held content.
 *
 * Run each call inside the caller's transaction when its writes must commit together.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  dedupeKeyFor,
  isPersonalVaultEnabled,
  normalizePersonalSource,
  upsertPersonalDocuments,
} from '../personal-vault/store';
import type { PersonalDocumentInput } from '../personal-vault/types';
import { upsertOrganizationDocuments, type OrganizationDocumentInput } from './documents-corpus';

export const DEFAULT_WINDOW_GAP_MINUTES = 30;
export const DEFAULT_CHAT_MESSAGE_DATATYPE = 'chat-message';
const DEFAULT_ROLLUP_BATCH = 200;

export type ChatUnitKind = 'thread' | 'window';
type BucketKind = 'thread' | 'day';

export interface ChatMessageInput {
  channelId: string;
  providerMessageId: string;
  /** Thread the message belongs to (the root included once it has replies); null = channel message. */
  threadKey?: string | null;
  authorRef?: string | null;
  authorLabel?: string | null;
  body: string;
  postedAt: string | Date;
  editedAt?: string | Date | null;
  raw?: Record<string, unknown> | null;
}

export interface WindowableMessage {
  postedAt: Date;
}

function nonEmpty(value: string, code: string): string {
  const out = value.trim();
  if (!out) throw new Error(code);
  return out;
}

function toDate(value: string | Date, code: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(code);
  return d;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bucketFor(threadKey: string | null, postedAt: Date): { kind: BucketKind; key: string } {
  return threadKey ? { kind: 'thread', key: threadKey } : { kind: 'day', key: utcDay(postedAt) };
}

/**
 * Split time-ordered messages into windows: a new window starts when the gap to the
 * previous message exceeds `gapMs` or the UTC day changes.
 */
export function splitIntoWindows<T extends WindowableMessage>(messages: readonly T[], gapMs: number): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  for (const message of messages) {
    const prev = current[current.length - 1];
    if (prev && (message.postedAt.getTime() - prev.postedAt.getTime() > gapMs
      || utcDay(message.postedAt) !== utcDay(prev.postedAt))) {
      windows.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) windows.push(current);
  return windows;
}

async function enqueue(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  channelId: string,
  bucket: { kind: BucketKind; key: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.chat_rollup_queue (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key)
    VALUES (${workspaceId}, ${dataSourceId}::uuid, ${channelId}, ${bucket.kind}, ${bucket.key})
    ON CONFLICT DO NOTHING`;
}

/**
 * Insert or edit raw messages. A changed message re-queues its bucket (and its old
 * bucket, when an edit moved it into or out of a thread). A tombstoned message is
 * never revived by a late upsert.
 */
export async function upsertChatMessages(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  messages: readonly ChatMessageInput[],
): Promise<{ written: number; unchanged: number }> {
  let written = 0;
  for (const msg of messages) {
    const channelId = nonEmpty(msg.channelId, 'invalid_chat_channel_id');
    const providerMessageId = nonEmpty(msg.providerMessageId, 'invalid_chat_provider_message_id');
    const threadKey = msg.threadKey?.trim() || null;
    const postedAt = toDate(msg.postedAt, 'invalid_chat_posted_at');
    const editedAt = msg.editedAt ? toDate(msg.editedAt, 'invalid_chat_edited_at') : null;
    const rows = await sql<Array<{ prev_thread_key: string | null; prev_posted_at: Date | null; existed: boolean }>>`
      WITH prev AS (
        SELECT thread_key, posted_at
          FROM harness_shared.chat_messages
         WHERE workspace_id = ${workspaceId} AND data_source_id = ${dataSourceId}::uuid
           AND channel_id = ${channelId} AND provider_message_id = ${providerMessageId}
      ), up AS (
        INSERT INTO harness_shared.chat_messages AS m
          (workspace_id, data_source_id, channel_id, provider_message_id, thread_key,
           author_ref, author_label, body, posted_at, edited_at, raw)
        VALUES (${workspaceId}, ${dataSourceId}::uuid, ${channelId}, ${providerMessageId}, ${threadKey},
                ${msg.authorRef ?? null}, ${msg.authorLabel ?? null}, ${msg.body}, ${postedAt}, ${editedAt},
                ${msg.raw ? sql.json(msg.raw as never) : null})
        ON CONFLICT (workspace_id, data_source_id, channel_id, provider_message_id)
        DO UPDATE SET thread_key = EXCLUDED.thread_key,
                      author_ref = EXCLUDED.author_ref,
                      author_label = EXCLUDED.author_label,
                      body = EXCLUDED.body,
                      posted_at = EXCLUDED.posted_at,
                      edited_at = EXCLUDED.edited_at,
                      raw = coalesce(EXCLUDED.raw, m.raw),
                      updated_at = now()
         WHERE m.deleted_at IS NULL
           AND (m.body IS DISTINCT FROM EXCLUDED.body
             OR m.thread_key IS DISTINCT FROM EXCLUDED.thread_key
             OR m.posted_at IS DISTINCT FROM EXCLUDED.posted_at
             OR m.author_ref IS DISTINCT FROM EXCLUDED.author_ref
             OR m.author_label IS DISTINCT FROM EXCLUDED.author_label)
        RETURNING 1
      )
      SELECT (SELECT thread_key FROM prev) AS prev_thread_key,
             (SELECT posted_at FROM prev) AS prev_posted_at,
             EXISTS (SELECT 1 FROM prev) AS existed
        FROM up`;
    const row = rows[0];
    if (!row) continue;
    written += 1;
    const next = bucketFor(threadKey, postedAt);
    await enqueue(sql, workspaceId, dataSourceId, channelId, next);
    if (row.existed && row.prev_posted_at) {
      const prev = bucketFor(row.prev_thread_key, new Date(row.prev_posted_at));
      if (prev.kind !== next.kind || prev.key !== next.key) {
        await enqueue(sql, workspaceId, dataSourceId, channelId, prev);
      }
    }
  }
  return { written, unchanged: messages.length - written };
}

/**
 * Record a provider delete. The body and raw payload are erased at once unless a
 * legal hold covers the message, in which case they are kept but never rendered.
 */
export async function tombstoneChatMessage(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  input: { channelId: string; providerMessageId: string; deletedAt?: string | Date },
): Promise<{ tombstoned: boolean; held: boolean }> {
  const channelId = nonEmpty(input.channelId, 'invalid_chat_channel_id');
  const providerMessageId = nonEmpty(input.providerMessageId, 'invalid_chat_provider_message_id');
  const deletedAt = input.deletedAt ? toDate(input.deletedAt, 'invalid_chat_deleted_at') : new Date();
  const rows = await sql<Array<{ thread_key: string | null; posted_at: Date; held: boolean }>>`
    WITH target AS (
      SELECT id, harness_shared.chat_message_under_hold(workspace_id, data_source_id, channel_id) AS held
        FROM harness_shared.chat_messages
       WHERE workspace_id = ${workspaceId} AND data_source_id = ${dataSourceId}::uuid
         AND channel_id = ${channelId} AND provider_message_id = ${providerMessageId}
         AND deleted_at IS NULL
    )
    UPDATE harness_shared.chat_messages m
       SET deleted_at = ${deletedAt},
           body = CASE WHEN t.held THEN m.body ELSE NULL END,
           raw = CASE WHEN t.held THEN m.raw ELSE NULL END,
           held_revisions = CASE WHEN t.held THEN m.held_revisions ELSE '[]'::jsonb END,
           updated_at = now()
      FROM target t
     WHERE m.workspace_id = ${workspaceId} AND m.id = t.id
    RETURNING m.thread_key, m.posted_at, t.held`;
  const row = rows[0];
  if (!row) return { tombstoned: false, held: false };
  await enqueue(sql, workspaceId, dataSourceId, channelId, bucketFor(row.thread_key, new Date(row.posted_at)));
  return { tombstoned: true, held: row.held };
}

interface SourceRow {
  id: string;
  kind: string;
  scope: string;
  scope_ref?: string | null;
  owner_user_id?: string | null;
  provider_account_id?: string | null;
  datatype_mappings: Record<string, unknown>;
  destination_policy: Record<string, unknown>;
  permission_mapping: Record<string, unknown>;
}

export type CorpusSkipReason =
  | 'destination_not_document'
  | 'permission_mapping_mismatch'
  | 'personal_owner_missing'
  | 'personal_account_missing'
  | 'personal_vault_disabled'
  | 'pot_ref_missing'
  | 'scope_unknown';

/**
 * Where a data source's units land in the documents corpus (D-005):
 *   - organization: needs permission_mapping.mode = source-acl; read through the channel's permission list.
 *   - personal: needs mode = owner; written into the owner's Personal Vault with the vault's own
 *     semantics (deny-by-default grants, disclosure ledger). Needs the source's provider account,
 *     the same rule the live vault sink applies.
 *   - pot: pot_slug = the source's scope_ref. A source-acl source is refused because a pot row
 *     carries no permission list, so it would widen access past the provider ACL.
 */
export type CorpusRoute =
  | { write: true; scope: 'organization'; source: string }
  | { write: true; scope: 'personal'; source: string; userId: string; providerAccountId: string }
  | { write: true; scope: 'pot'; source: string; potSlug: string }
  | { write: false; reason: CorpusSkipReason };

type RouteInput = Pick<SourceRow, 'kind' | 'scope' | 'datatype_mappings' | 'destination_policy' | 'permission_mapping'>
  & Partial<Pick<SourceRow, 'scope_ref' | 'owner_user_id' | 'provider_account_id'>>;

/** Which of a source's provider objects is being routed. Chat sources route `message`
 *  (default chat-message); other connectors name their own object, e.g. a ticket source
 *  routes `comment` with default ticket-comment. */
export interface CorpusRouteObject {
  mappingKey: string;
  defaultDatatype: string;
}

const CHAT_MESSAGE_OBJECT: CorpusRouteObject = { mappingKey: 'message', defaultDatatype: DEFAULT_CHAT_MESSAGE_DATATYPE };

/** Whether, and where, this data source's units go to the documents corpus. */
export function corpusRouteFor(source: RouteInput, object: CorpusRouteObject = CHAT_MESSAGE_OBJECT): CorpusRoute {
  const mapped = source.datatype_mappings?.[object.mappingKey];
  const datatype = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : object.defaultDatatype;
  const natures = source.destination_policy?.[datatype];
  if (!Array.isArray(natures) || !natures.includes('document')) return { write: false, reason: 'destination_not_document' };
  const corpusSource = normalizePersonalSource(source.kind);
  const mode = source.permission_mapping?.mode;
  switch (source.scope) {
    case 'organization':
      if (mode !== 'source-acl') return { write: false, reason: 'permission_mapping_mismatch' };
      return { write: true, scope: 'organization', source: corpusSource };
    case 'personal': {
      if (mode !== 'owner') return { write: false, reason: 'permission_mapping_mismatch' };
      const userId = source.owner_user_id?.trim();
      if (!userId) return { write: false, reason: 'personal_owner_missing' };
      const providerAccountId = source.provider_account_id?.trim();
      if (!providerAccountId) return { write: false, reason: 'personal_account_missing' };
      return { write: true, scope: 'personal', source: corpusSource, userId, providerAccountId };
    }
    case 'pot': {
      if (mode === 'source-acl') return { write: false, reason: 'permission_mapping_mismatch' };
      const potSlug = source.scope_ref?.trim();
      if (!potSlug) return { write: false, reason: 'pot_ref_missing' };
      return { write: true, scope: 'pot', source: corpusSource, potSlug };
    }
    default:
      return { write: false, reason: 'scope_unknown' };
  }
}

/** The dedupe key the corpus row is stored under (the vault prefixes personal keys by account). */
export function storedDedupeKey(route: Extract<CorpusRoute, { write: true }>, unitKey: string, kind: string): string {
  if (route.scope !== 'personal') return unitKey;
  return dedupeKeyFor({ source: route.source, kind, dedupeKey: unitKey, providerAccountId: route.providerAccountId });
}

async function upsertPotDocument(sql: Sql, workspaceId: string, potSlug: string, doc: OrganizationDocumentInput): Promise<void> {
  await sql`
    INSERT INTO harness_shared.documents
      (workspace_id, user_id, scope, pot_slug, source, kind, external_id,
       occurred_at, participants, title, text, metadata, dedupe_key)
    VALUES (${workspaceId}, NULL, 'pot', ${potSlug}, ${doc.source}, ${doc.kind},
            ${doc.externalId ?? null}, ${doc.occurredAt ?? null}, ${doc.participants ?? []}::text[],
            ${doc.title ?? ''}, ${doc.text ?? ''}, ${sql.json((doc.metadata ?? {}) as never)}, ${doc.dedupeKey})
    ON CONFLICT (workspace_id, pot_slug, source, dedupe_key) WHERE scope = 'pot'
    DO UPDATE SET kind = EXCLUDED.kind,
                  external_id = EXCLUDED.external_id,
                  occurred_at = EXCLUDED.occurred_at,
                  participants = EXCLUDED.participants,
                  title = EXCLUDED.title,
                  text = EXCLUDED.text,
                  metadata = EXCLUDED.metadata,
                  updated_at = now()`;
}

/** Write one unit's corpus row to the destination its route names. An organization route
 *  needs the permission list the row is read through (see ensurePermissionList). */
export async function writeCorpusDocument(
  sql: Sql,
  workspaceId: string,
  route: Extract<CorpusRoute, { write: true }>,
  dataSourceId: string,
  permissionListId: string | null,
  doc: OrganizationDocumentInput,
): Promise<void> {
  if (route.scope === 'organization') {
    await upsertOrganizationDocuments(sql, workspaceId, permissionListId!, [doc]);
  } else if (route.scope === 'pot') {
    await upsertPotDocument(sql, workspaceId, route.potSlug, doc);
  } else {
    const personal: PersonalDocumentInput = {
      source: doc.source,
      sourceId: dataSourceId,
      providerAccountId: route.providerAccountId,
      kind: doc.kind,
      externalId: doc.externalId ?? null,
      occurredAt: doc.occurredAt ?? null,
      participants: doc.participants,
      title: doc.title,
      text: doc.text,
      metadata: doc.metadata,
      dedupeKey: doc.dedupeKey,
    };
    await upsertPersonalDocuments(sql, workspaceId, route.userId, [personal]);
  }
}

export function chatUnitDedupeKey(dataSourceId: string, channelId: string, unitKind: ChatUnitKind, unitKey: string): string {
  return `chat:${dataSourceId}:${channelId}:${unitKind}:${unitKey}`;
}

interface LiveMessage {
  providerMessageId: string;
  authorRef: string | null;
  authorLabel: string | null;
  body: string;
  postedAt: Date;
}

/** The text a unit is indexed by: one `author: body` line per live message. */
export function renderChatUnit(messages: readonly LiveMessage[]): string {
  return messages
    .map((m) => `${m.authorLabel?.trim() || m.authorRef?.trim() || 'unknown'}: ${m.body}`)
    .join('\n');
}

/** The channel's permission list, created empty (nobody can read) when missing. */
/** The permission list for one provider ACL container (a Slack channel, a GitHub repository). */
export async function ensurePermissionList(sql: Sql, workspaceId: string, source: string, sourceRef: string): Promise<{ id: string; title: string }> {
  await sql`
    INSERT INTO harness_shared.document_permission_lists (workspace_id, source, source_ref, title)
    VALUES (${workspaceId}, ${source}, ${sourceRef}, '')
    ON CONFLICT (workspace_id, source, source_ref) DO NOTHING`;
  const rows = await sql<Array<{ id: string; title: string }>>`
    SELECT id, title FROM harness_shared.document_permission_lists
     WHERE workspace_id = ${workspaceId} AND source = ${source} AND source_ref = ${sourceRef}`;
  return rows[0]!;
}

async function deleteUnit(
  sql: Sql,
  workspaceId: string,
  unit: { id: string; document_dedupe_key: string | null },
  corpusSource: string,
): Promise<void> {
  // Any scope: the key embeds the data-source id, so only this unit ever wrote it.
  if (unit.document_dedupe_key) {
    await sql`
      DELETE FROM harness_shared.documents
       WHERE workspace_id = ${workspaceId}
         AND source = ${corpusSource} AND dedupe_key = ${unit.document_dedupe_key}`;
  }
  await sql`DELETE FROM harness_shared.chat_retrieval_units WHERE workspace_id = ${workspaceId} AND id = ${unit.id}::uuid`;
}

export interface ChatRollupResult {
  buckets: number;
  unitsWritten: number;
  unitsUnchanged: number;
  unitsRemoved: number;
  documentsWritten: number;
  /** Buckets whose source routes no corpus row, by reason. */
  corpusSkipped: Partial<Record<CorpusSkipReason, number>>;
}

/**
 * Re-render up to `limit` queued buckets. Dequeue and re-render happen in the
 * caller's statement sequence; run inside a transaction so a failure re-queues.
 */
export async function rollupChatUnits(
  sql: Sql,
  workspaceId: string,
  opts: { dataSourceId?: string; limit?: number; gapMinutes?: number } = {},
): Promise<ChatRollupResult> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? DEFAULT_ROLLUP_BATCH));
  const gapMs = Math.max(1, opts.gapMinutes ?? DEFAULT_WINDOW_GAP_MINUTES) * 60_000;
  const sourceFilter = opts.dataSourceId ? sql`AND data_source_id = ${opts.dataSourceId}::uuid` : sql``;
  const buckets = await sql<Array<{ data_source_id: string; channel_id: string; bucket_kind: BucketKind; bucket_key: string }>>`
    DELETE FROM harness_shared.chat_rollup_queue q
     WHERE (q.workspace_id, q.data_source_id, q.channel_id, q.bucket_kind, q.bucket_key) IN (
       SELECT workspace_id, data_source_id, channel_id, bucket_kind, bucket_key
         FROM harness_shared.chat_rollup_queue
        WHERE workspace_id = ${workspaceId} ${sourceFilter}
        ORDER BY queued_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING q.data_source_id, q.channel_id, q.bucket_kind, q.bucket_key`;

  const result: ChatRollupResult = {
    buckets: buckets.length, unitsWritten: 0, unitsUnchanged: 0, unitsRemoved: 0, documentsWritten: 0, corpusSkipped: {},
  };
  const sources = new Map<string, { source: SourceRow; route: CorpusRoute }>();
  for (const bucket of buckets) {
    let resolved = sources.get(bucket.data_source_id);
    if (!resolved) {
      const rows = await sql<SourceRow[]>`
        SELECT id, kind, scope, scope_ref, owner_user_id::text AS owner_user_id, provider_account_id,
               datatype_mappings, destination_policy, permission_mapping
          FROM harness_shared.data_sources
         WHERE workspace_id = ${workspaceId} AND id = ${bucket.data_source_id}::uuid`;
      if (!rows[0]) continue;
      let route = corpusRouteFor(rows[0]);
      // A disabled vault takes no writes (upsertPersonalDocuments would throw and re-queue forever).
      if (route.write && route.scope === 'personal' && !(await isPersonalVaultEnabled(sql, workspaceId, route.userId))) {
        route = { write: false, reason: 'personal_vault_disabled' };
      }
      resolved = { source: rows[0], route };
      sources.set(bucket.data_source_id, resolved);
    }
    const { source, route } = resolved;
    const corpusSource = normalizePersonalSource(source.kind);
    if (!route.write) result.corpusSkipped[route.reason] = (result.corpusSkipped[route.reason] ?? 0) + 1;

    const unitKind: ChatUnitKind = bucket.bucket_kind === 'thread' ? 'thread' : 'window';
    const messageFilter = bucket.bucket_kind === 'thread'
      ? sql`AND thread_key = ${bucket.bucket_key}`
      : sql`AND thread_key IS NULL
            AND posted_at >= ${bucket.bucket_key}::date::timestamp AT TIME ZONE 'UTC'
            AND posted_at < (${bucket.bucket_key}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
    const live = (await sql<Array<{
      provider_message_id: string; author_ref: string | null; author_label: string | null; body: string; posted_at: Date;
    }>>`
      SELECT provider_message_id, author_ref, author_label, body, posted_at
        FROM harness_shared.chat_messages
       WHERE workspace_id = ${workspaceId} AND data_source_id = ${bucket.data_source_id}::uuid
         AND channel_id = ${bucket.channel_id} AND deleted_at IS NULL
         ${messageFilter}
       ORDER BY posted_at, provider_message_id`).map((r): LiveMessage => ({
      providerMessageId: r.provider_message_id,
      authorRef: r.author_ref,
      authorLabel: r.author_label,
      body: r.body,
      postedAt: new Date(r.posted_at),
    }));

    const groups = live.length === 0 ? [] : unitKind === 'thread' ? [live] : splitIntoWindows(live, gapMs);
    const computed = groups.map((messages) => ({
      unitKey: unitKind === 'thread' ? bucket.bucket_key : messages[0]!.providerMessageId,
      messages,
      text: renderChatUnit(messages),
    }));

    const existing = await sql<Array<{ id: string; unit_key: string; content_hash: string; document_dedupe_key: string | null }>>`
      SELECT id, unit_key, content_hash, document_dedupe_key
        FROM harness_shared.chat_retrieval_units
       WHERE workspace_id = ${workspaceId} AND data_source_id = ${bucket.data_source_id}::uuid
         AND channel_id = ${bucket.channel_id} AND unit_kind = ${unitKind} AND bucket_key = ${bucket.bucket_key}`;
    const keep = new Set(computed.map((u) => u.unitKey));
    for (const stale of existing.filter((u) => !keep.has(u.unit_key))) {
      await deleteUnit(sql, workspaceId, stale, corpusSource);
      result.unitsRemoved += 1;
    }

    const list = route.write && route.scope === 'organization'
      ? await ensurePermissionList(sql, workspaceId, route.source, bucket.channel_id)
      : null;
    const docKind = unitKind === 'thread' ? 'chat-thread' : 'chat-window';
    const target = route.write
      ? {
          scope: route.scope,
          userId: route.scope === 'personal' ? route.userId : null,
          potSlug: route.scope === 'pot' ? route.potSlug : null,
        }
      : null;
    for (const unit of computed) {
      const first = unit.messages[0]!;
      const last = unit.messages[unit.messages.length - 1]!;
      const unitDedupeKey = chatUnitDedupeKey(bucket.data_source_id, bucket.channel_id, unitKind, unit.unitKey);
      const dedupeKey = route.write ? storedDedupeKey(route, unitDedupeKey, docKind) : null;
      // The destination is part of the hash, so a scope or owner change forces a rewrite.
      const destination = target ? `${target.scope}:${target.userId ?? ''}:${target.potSlug ?? ''}` : '';
      const contentHash = createHash('sha256')
        .update(`${unit.text}\u0000${dedupeKey ?? ''}\u0000${list?.title ?? ''}\u0000${destination}`)
        .digest('hex');
      const prior = existing.find((u) => u.unit_key === unit.unitKey);
      if (prior && prior.content_hash === contentHash && prior.document_dedupe_key === dedupeKey) {
        result.unitsUnchanged += 1;
        continue;
      }
      // Drop the prior row unless it IS the row about to be upserted (same key, scope, owner, pot).
      if (prior?.document_dedupe_key) {
        await sql`
          DELETE FROM harness_shared.documents
           WHERE workspace_id = ${workspaceId}
             AND source = ${corpusSource} AND dedupe_key = ${prior.document_dedupe_key}
             AND (${dedupeKey}::text IS NULL OR NOT (
                   dedupe_key = ${dedupeKey}::text
               AND scope = ${target?.scope ?? ''}
               AND user_id IS NOT DISTINCT FROM ${target?.userId ?? null}::uuid
               AND pot_slug IS NOT DISTINCT FROM ${target?.potSlug ?? null}::text))`;
      }
      await sql`
        INSERT INTO harness_shared.chat_retrieval_units
          (workspace_id, data_source_id, channel_id, unit_kind, unit_key, bucket_key,
           first_posted_at, last_posted_at, message_count, content_hash, document_dedupe_key)
        VALUES (${workspaceId}, ${bucket.data_source_id}::uuid, ${bucket.channel_id}, ${unitKind}, ${unit.unitKey},
                ${bucket.bucket_key}, ${first.postedAt}, ${last.postedAt}, ${unit.messages.length}, ${contentHash}, ${dedupeKey})
        ON CONFLICT (workspace_id, data_source_id, channel_id, unit_kind, unit_key)
        DO UPDATE SET bucket_key = EXCLUDED.bucket_key,
                      first_posted_at = EXCLUDED.first_posted_at,
                      last_posted_at = EXCLUDED.last_posted_at,
                      message_count = EXCLUDED.message_count,
                      content_hash = EXCLUDED.content_hash,
                      document_dedupe_key = EXCLUDED.document_dedupe_key,
                      rolled_at = now()`;
      result.unitsWritten += 1;
      if (route.write) {
        await writeCorpusDocument(sql, workspaceId, route, bucket.data_source_id, list?.id ?? null, {
          source: route.source,
          kind: docKind,
          // The personal writer re-applies its account prefix, so pass the unprefixed key.
          dedupeKey: unitDedupeKey,
          externalId: unit.unitKey,
          occurredAt: last.postedAt.toISOString(),
          participants: [...new Set(unit.messages.map((m) => m.authorRef).filter((a): a is string => !!a))],
          title: list?.title || bucket.channel_id,
          text: unit.text,
          metadata: {
            dataSourceId: bucket.data_source_id,
            channelId: bucket.channel_id,
            unitKind,
            unitKey: unit.unitKey,
            messageCount: unit.messages.length,
            firstPostedAt: first.postedAt.toISOString(),
            lastPostedAt: last.postedAt.toISOString(),
            providerMessageIds: unit.messages.map((m) => m.providerMessageId),
          },
        });
        result.documentsWritten += 1;
      }
    }
  }
  return result;
}

/**
 * Apply retention and release erased content. Never touches a message under an
 * active legal hold:
 *   1. delete messages older than the source's retention_policy.maxAgeDays;
 *   2. erase the kept body/raw of tombstones whose hold has been released;
 *   3. drop superseded bodies kept for a released hold.
 * Deleted messages re-queue their buckets; run rollupChatUnits afterwards.
 */
export async function purgeExpiredChatMessages(
  sql: Sql,
  workspaceId: string,
  opts: { dataSourceId?: string; now?: Date } = {},
): Promise<{ expired: number; tombstonesErased: number; revisionsDropped: number }> {
  const now = opts.now ?? new Date();
  const sourceFilter = opts.dataSourceId ? sql`AND m.data_source_id = ${opts.dataSourceId}::uuid` : sql``;
  const expired = await sql<Array<{ data_source_id: string; channel_id: string; thread_key: string | null; posted_at: Date }>>`
    DELETE FROM harness_shared.chat_messages m
     USING harness_shared.data_sources s
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND s.workspace_id = m.workspace_id AND s.id = m.data_source_id
       AND jsonb_typeof(s.retention_policy -> 'maxAgeDays') = 'number'
       AND m.posted_at < ${now}::timestamptz - make_interval(days => (s.retention_policy ->> 'maxAgeDays')::int)
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING m.data_source_id, m.channel_id, m.thread_key, m.posted_at`;
  const queued = new Set<string>();
  for (const row of expired) {
    const bucket = bucketFor(row.thread_key, new Date(row.posted_at));
    const key = `${row.data_source_id}\u0000${row.channel_id}\u0000${bucket.kind}\u0000${bucket.key}`;
    if (queued.has(key)) continue;
    queued.add(key);
    await enqueue(sql, workspaceId, row.data_source_id, row.channel_id, bucket);
  }

  const erased = await sql`
    UPDATE harness_shared.chat_messages m
       SET body = NULL, raw = NULL, held_revisions = '[]'::jsonb, updated_at = now()
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND m.deleted_at IS NOT NULL
       AND (m.body IS NOT NULL OR m.raw IS NOT NULL OR m.held_revisions <> '[]'::jsonb)
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING 1`;
  const dropped = await sql`
    UPDATE harness_shared.chat_messages m
       SET held_revisions = '[]'::jsonb, updated_at = now()
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND m.deleted_at IS NULL AND m.held_revisions <> '[]'::jsonb
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING 1`;
  return { expired: expired.length, tombstonesErased: erased.length, revisionsDropped: dropped.length };
}

export async function placeLegalHold(
  sql: Sql,
  workspaceId: string,
  input: { dataSourceId: string; channelId?: string | null; reason: string; placedBy: string },
): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_source_legal_holds (workspace_id, data_source_id, channel_id, reason, placed_by)
    VALUES (${workspaceId}, ${input.dataSourceId}::uuid, ${input.channelId?.trim() || null},
            ${nonEmpty(input.reason, 'invalid_legal_hold_reason')}, ${nonEmpty(input.placedBy, 'invalid_legal_hold_placed_by')})
    RETURNING id`;
  return { id: rows[0]!.id };
}

export async function releaseLegalHold(
  sql: Sql,
  workspaceId: string,
  input: { id: string; releasedBy: string },
): Promise<{ released: number }> {
  const rows = await sql`
    UPDATE harness_shared.data_source_legal_holds
       SET released_at = now(), released_by = ${nonEmpty(input.releasedBy, 'invalid_legal_hold_released_by')}
     WHERE workspace_id = ${workspaceId} AND id = ${input.id}::uuid AND released_at IS NULL
    RETURNING id`;
  return { released: rows.length };
}
