/**
 * The `chat-message` and `chat-thread` admission sources
 * (enterprise-data-sources-2026-10-01 P-021, D-004, D-028, D-030).
 *
 * "Can someone fix X" in Slack becomes work only when a person promotes it, or an explicit
 * per-data-source rule does, through the ONE admission path (`work_items:admit`, see
 * ../work-admission/admission-sources.ts). This module only teaches that path what a chat source
 * is. It adds no verb and no table.
 *
 * Identity. A chat row's uuid dies with retention and data-source deletes, so the source key is
 * the provider identity the connector already upserts on (chat_messages_provider_key):
 *   - message: `<dataSourceId>:<channelId>:<providerMessageId>`
 *   - thread:  `<dataSourceId>:<channelId>:thread:<threadKey>`
 * The admission keeps a snapshot (title, excerpt, permalink) and has no FK to chat_messages, so
 * the work item outlives the source rows.
 *
 * Covering. A message that belongs to a thread declares the thread's key in `coveredBy`, so
 * admitting a reply of an already-admitted thread returns the thread's work item ('covered')
 * instead of minting a second one. The verb enforces it; the resolver only declares it.
 * A message carries a thread_key only when it has a thread (the Slack root carries thread_ts once
 * it has replies), so a stand-alone message declares nothing — unless the caller names the thread
 * the message roots (ref.threadKey). The ingest-time chat admission sink does exactly that for a
 * top-level post, and names the opening message of a thread with no replies yet
 * (ref.rootMessageId), so "every new thread is a bug" and "this message is a bug" fold onto one
 * work item whichever rule fires first (slack-messages-to-bug-reports-2026-10-05 D-008).
 *
 * Visibility (person admissions). A person may admit only what they can read, using the same
 * model documents:search reads through:
 *   - organization scope: the person's mapped provider identity is a member of the channel's
 *     permission list (document_permission_lists source = normalized source kind,
 *     source_ref = channel id).
 *   - personal scope: the data source belongs to the person.
 *   - pot scope: the data source is the admitting pot's own (scope_ref = harness).
 * A person admission with no resolved principal user fails closed. Rule admissions skip the
 * person check: the verb already refuses a source outside the rule's data source.
 *
 * Deleted messages (provider tombstones) are refused; a deleted message is not a request anymore.
 */
import { normalizePersonalSource } from '../personal-vault/store';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  DEFAULT_FIELD_AUTHORITY,
  registerAdmissionSource,
  type Admitter,
  type AdmissionRefusal,
  type AdmissionResolveContext,
  type AdmissionSourceIdentity,
  type AdmissionSourceResolver,
  type ResolvedAdmissionSource,
} from '../work-admission/admission-sources';

export const CHAT_MESSAGE_SOURCE_KIND = 'chat-message';
export const CHAT_THREAD_SOURCE_KIND = 'chat-thread';

/** Most messages a thread snapshot reads. A longer thread keeps its first messages. */
export const CHAT_THREAD_SNAPSHOT_MAX_MESSAGES = 50;
/** Longest snapshot excerpt kept on the admission (the verb also bounds the body). */
export const CHAT_SNAPSHOT_BODY_MAX = 4000;
const TITLE_MAX = 140;
const REF_FIELD_MAX = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatMessageRef {
  dataSourceId: string;
  channelId: string;
  providerMessageId: string;
  /**
   * The thread this message belongs to or roots, when the caller knows it and the stored row
   * does not say (a top-level post with no replies yet carries no thread_key). Only widens
   * `coveredBy`: it never changes the source key.
   */
  threadKey?: string;
}

export interface ChatThreadRef {
  dataSourceId: string;
  channelId: string;
  threadKey: string;
  /**
   * The provider id of the thread's opening message. A top-level post with no replies yet is a
   * thread of one, but its stored row carries no thread_key, so without this the thread would
   * not resolve. Not part of the source key.
   */
  rootMessageId?: string;
}

export function chatMessageSourceKey(ref: ChatMessageRef): string {
  return `${ref.dataSourceId}:${ref.channelId}:${ref.providerMessageId}`;
}

export function chatThreadSourceKey(ref: ChatThreadRef): string {
  return `${ref.dataSourceId}:${ref.channelId}:thread:${ref.threadKey}`;
}

interface SourceRow {
  id: string;
  kind: string;
  scope: string;
  scope_ref: string | null;
  owner_user_id: string | null;
}

interface MessageRow {
  provider_message_id: string;
  thread_key: string | null;
  author_ref: string | null;
  author_label: string | null;
  body: string | null;
  posted_at: Date | string;
  deleted_at: Date | string | null;
  raw: Record<string, unknown> | null;
}

function field(raw: Record<string, unknown>, name: string, what: string): string {
  const value = typeof raw[name] === 'string' ? (raw[name] as string).trim() : '';
  if (!value) throw new Error(`admission_source_invalid: ${what} source needs { ${name} }`);
  if (value.length > REF_FIELD_MAX) throw new Error(`admission_source_invalid: ${name} is too long`);
  return value;
}

function withOptional<K extends string>(name: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, string>);
}

function optionalField(raw: Record<string, unknown>, name: string, what: string): string | undefined {
  if (raw[name] === undefined || raw[name] === null) return undefined;
  return field(raw, name, what);
}

function dataSourceIdField(raw: Record<string, unknown>, what: string): string {
  const id = field(raw, 'dataSourceId', what);
  if (!UUID_RE.test(id)) throw new Error('admission_source_invalid: dataSourceId must be a uuid');
  return id.toLowerCase();
}

function refuse(code: string, message: string): AdmissionRefusal {
  return { refused: true, code, message };
}

/**
 * The person's local user id, when the verb resolved one. Read structurally so this module does
 * not depend on the exact Admitter shape beyond `via`.
 */
export function admitterPrincipalUserId(admitter: Admitter): string | null {
  if (admitter.via !== 'person') return null;
  const value = (admitter as { principalUserId?: unknown }).principalUserId;
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

async function loadSource(ctx: AdmissionResolveContext, dataSourceId: string): Promise<SourceRow | null> {
  const [row] = await ctx.db<SourceRow[]>`
    SELECT id::text AS id, kind, scope, scope_ref, owner_user_id::text AS owner_user_id
      FROM harness_shared.data_sources
     WHERE workspace_id = ${ctx.workspaceId} AND id = ${dataSourceId}::uuid
     LIMIT 1`;
  return row ?? null;
}

/** Null when the admitter may read the channel, otherwise the refusal. */
async function checkVisible(
  ctx: AdmissionResolveContext,
  source: SourceRow,
  channelId: string,
): Promise<AdmissionRefusal | null> {
  if (ctx.admitter.via === 'rule') return null;
  const notVisible = refuse('not_visible', 'the admitting person cannot read this chat source');
  if (source.scope === 'pot') {
    return source.scope_ref?.trim() && source.scope_ref.trim() === ctx.harness ? null : notVisible;
  }
  const userId = admitterPrincipalUserId(ctx.admitter);
  if (!userId) return notVisible;
  if (source.scope === 'personal') {
    return source.owner_user_id?.toLowerCase() === userId ? null : notVisible;
  }
  if (source.scope !== 'organization') return notVisible;
  let listSource: string;
  try {
    listSource = normalizePersonalSource(source.kind);
  } catch {
    return notVisible;
  }
  const [hit] = await ctx.db<Array<{ ok: number }>>`
    SELECT 1 AS ok
      FROM harness_shared.document_permission_lists l
      JOIN harness_shared.document_permission_members m
        ON m.workspace_id = l.workspace_id AND m.list_id = l.id
      JOIN harness_shared.provider_identity_mappings p
        ON p.workspace_id = m.workspace_id
       AND p.provider = m.provider
       AND p.provider_user_id = m.provider_user_id
       AND p.revoked_at IS NULL
     WHERE l.workspace_id = ${ctx.workspaceId}
       AND l.source = ${listSource}
       AND l.source_ref = ${channelId}
       AND p.user_id = ${userId}::uuid
     LIMIT 1`;
  return hit ? null : notVisible;
}

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function speaker(m: MessageRow): string {
  return m.author_label?.trim() || m.author_ref?.trim() || 'unknown';
}

function permalinkOf(m: MessageRow): string | null {
  const raw = m.raw ?? {};
  const link = typeof raw.permalink === 'string' ? raw.permalink.trim() : '';
  return /^https:\/\//.test(link) ? link : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function bounded(text: string): string {
  return text.length > CHAT_SNAPSHOT_BODY_MAX ? `${text.slice(0, CHAT_SNAPSHOT_BODY_MAX - 1)}…` : text;
}

export function createChatMessageAdmissionSource(): AdmissionSourceResolver<ChatMessageRef> {
  return {
    kind: CHAT_MESSAGE_SOURCE_KIND,
    parseRef(raw) {
      return {
        dataSourceId: dataSourceIdField(raw, 'chat-message'),
        channelId: field(raw, 'channelId', 'chat-message'),
        providerMessageId: field(raw, 'providerMessageId', 'chat-message'),
        ...withOptional('threadKey', optionalField(raw, 'threadKey', 'chat-message')),
      };
    },
    async resolve(ctx, ref): Promise<ResolvedAdmissionSource | AdmissionRefusal> {
      const source = await loadSource(ctx, ref.dataSourceId);
      if (!source) return refuse('source_not_found', `no data source '${ref.dataSourceId}' in this workspace`);
      const hidden = await checkVisible(ctx, source, ref.channelId);
      if (hidden) return hidden;
      const [row] = await ctx.db<MessageRow[]>`
        SELECT provider_message_id, thread_key, author_ref, author_label, body, posted_at, deleted_at, raw
          FROM harness_shared.chat_messages
         WHERE workspace_id = ${ctx.workspaceId}
           AND data_source_id = ${ref.dataSourceId}::uuid
           AND channel_id = ${ref.channelId}
           AND provider_message_id = ${ref.providerMessageId}
         LIMIT 1`;
      if (!row) return refuse('source_not_found', 'no such chat message (it may have aged out of retention)');
      if (row.deleted_at || row.body == null) return refuse('source_deleted', 'the chat message was deleted at the provider');
      const threadKey = row.thread_key ?? ref.threadKey ?? null;
      const coveredBy: AdmissionSourceIdentity[] = threadKey
        ? [{ kind: CHAT_THREAD_SOURCE_KIND, key: chatThreadSourceKey({ ...ref, threadKey }) }]
        : [];
      const permalink = permalinkOf(row);
      return {
        dataSourceId: source.id,
        sourceKey: chatMessageSourceKey(ref),
        title: firstLine(row.body) || `Chat message in ${ref.channelId}`,
        body: bounded(`${speaker(row)}: ${row.body}`),
        permalink,
        sourceRef: {
          provider: source.kind,
          dataSourceId: source.id,
          channelId: ref.channelId,
          providerMessageId: ref.providerMessageId,
          ...(row.thread_key ? { threadKey: row.thread_key } : {}),
          postedAt: iso(row.posted_at),
          author: speaker(row),
          ...(permalink ? { url: permalink } : {}),
        },
        fieldAuthority: DEFAULT_FIELD_AUTHORITY,
        coveredBy,
      };
    },
  };
}

export function createChatThreadAdmissionSource(): AdmissionSourceResolver<ChatThreadRef> {
  return {
    kind: CHAT_THREAD_SOURCE_KIND,
    parseRef(raw) {
      return {
        dataSourceId: dataSourceIdField(raw, 'chat-thread'),
        channelId: field(raw, 'channelId', 'chat-thread'),
        threadKey: field(raw, 'threadKey', 'chat-thread'),
        ...withOptional('rootMessageId', optionalField(raw, 'rootMessageId', 'chat-thread')),
      };
    },
    async resolve(ctx, ref): Promise<ResolvedAdmissionSource | AdmissionRefusal> {
      const source = await loadSource(ctx, ref.dataSourceId);
      if (!source) return refuse('source_not_found', `no data source '${ref.dataSourceId}' in this workspace`);
      const hidden = await checkVisible(ctx, source, ref.channelId);
      if (hidden) return hidden;
      const rows = await ctx.db<MessageRow[]>`
        SELECT provider_message_id, thread_key, author_ref, author_label, body, posted_at, deleted_at, raw
          FROM harness_shared.chat_messages
         WHERE workspace_id = ${ctx.workspaceId}
           AND data_source_id = ${ref.dataSourceId}::uuid
           AND channel_id = ${ref.channelId}
           AND (thread_key = ${ref.threadKey}
                OR (thread_key IS NULL AND provider_message_id = ${ref.rootMessageId ?? null}::text))
         ORDER BY posted_at, provider_message_id
         LIMIT ${CHAT_THREAD_SNAPSHOT_MAX_MESSAGES}`;
      if (rows.length === 0) return refuse('source_not_found', 'no such chat thread (it may have aged out of retention)');
      const live = rows.filter((r) => !r.deleted_at && r.body != null);
      if (live.length === 0) return refuse('source_deleted', 'every message in the chat thread was deleted at the provider');
      const opener = live[0]!;
      const permalink = permalinkOf(opener);
      return {
        dataSourceId: source.id,
        sourceKey: chatThreadSourceKey(ref),
        title: firstLine(opener.body ?? '') || `Chat thread in ${ref.channelId}`,
        body: bounded(live.map((m) => `${speaker(m)}: ${m.body}`).join('\n')),
        permalink,
        sourceRef: {
          provider: source.kind,
          dataSourceId: source.id,
          channelId: ref.channelId,
          threadKey: ref.threadKey,
          firstPostedAt: iso(opener.posted_at),
          messageCount: live.length,
          ...(permalink ? { url: permalink } : {}),
        },
        fieldAuthority: DEFAULT_FIELD_AUTHORITY,
      };
    },
  };
}

/** The process-wide registrations. Idempotent across module re-imports (same objects). */
export const chatMessageAdmissionSource = pinModuleState(
  '@papercusp/operator-core.data-sources.chat-message-admission-source',
  () => createChatMessageAdmissionSource(),
);
export const chatThreadAdmissionSource = pinModuleState(
  '@papercusp/operator-core.data-sources.chat-thread-admission-source',
  () => createChatThreadAdmissionSource(),
);
registerAdmissionSource(chatMessageAdmissionSource);
registerAdmissionSource(chatThreadAdmissionSource);
