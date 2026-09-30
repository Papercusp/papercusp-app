/** Slack Socket Mode adapter and dual-token connection seam (P-006/P-007). */
import type postgres from 'postgres';
import type { TokenStorage } from '../oauth/token';
import { fsTokenStorage } from '../oauth/storage-fs';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import {
  type ExternalTriggerSourceRow,
  upsertOwnedExternalTriggerSource,
  updateExternalTriggerSourceSyncState,
} from './source-store';

export const SLACK_SOCKET_PLUGIN = 'slack-socket';
export const SLACK_HISTORY_MIN_INTERVAL_MS = 60_000;
const SLACK_API_ORIGIN = 'https://slack.com';
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const SLACK_APP_MANIFEST_TEMPLATE = {
  _metadata: { major_version: 2 },
  display_information: {
    name: 'Papercusp Triggers',
    description: 'Starts Papercusp triggered plans from Slack mentions, direct messages, and slash commands.',
    background_color: '#312e81',
  },
  features: {
    bot_user: { display_name: 'Papercusp', always_online: false },
    slash_commands: [{
      command: '/papercusp',
      description: 'Start a Papercusp triggered plan',
      should_escape: false,
    }],
  },
  oauth_config: {
    scopes: {
      bot: [
        'app_mentions:read',
        'channels:history',
        'groups:history',
        'im:history',
        'mpim:history',
        'commands',
        'chat:write',
      ],
    },
  },
  settings: {
    socket_mode_enabled: true,
    token_rotation_enabled: false,
    event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
    interactivity: { is_enabled: true },
  },
} as const;

export interface SlackSocketCredentials {
  appToken: string;
  botToken: string;
}

export interface SlackSocketEnvelope {
  envelope_id?: string;
  type?: string;
  accepts_response_payload?: boolean;
  payload?: Record<string, unknown>;
  reason?: string;
}

export interface SlackNormalizedEvent {
  event: 'mention' | 'dm' | 'slash-command';
  externalId: string;
  dedupeKey: string;
  occurredAt: string | null;
  channelId: string | null;
  payload: Record<string, unknown>;
}

type Ingest = (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;

export function slackSocketCredentialRef(field: string): string {
  if (!FIELD.test(field)) throw new Error('slack_socket_credential_field_invalid');
  return `${SLACK_SOCKET_PLUGIN}:${field}`;
}

export function slackSocketCredentialField(ref: string | null): string {
  const prefix = `${SLACK_SOCKET_PLUGIN}:`;
  if (!ref?.startsWith(prefix) || !FIELD.test(ref.slice(prefix.length))) {
    throw new Error('slack_socket_credential_ref_invalid');
  }
  return ref.slice(prefix.length);
}

function assertToken(value: string, prefix: 'xapp-' | 'xoxb-', name: string): string {
  const token = value.trim();
  if (!token.startsWith(prefix) || token.length <= prefix.length) {
    throw new Error(`slack_${name}_invalid`);
  }
  return token;
}

export async function storeSlackSocketCredentials(
  installSlug: string,
  field: string,
  credentials: SlackSocketCredentials,
  storage: TokenStorage = fsTokenStorage,
): Promise<string> {
  const appToken = assertToken(credentials.appToken, 'xapp-', 'app_token');
  const botToken = assertToken(credentials.botToken, 'xoxb-', 'bot_token');
  const ref = slackSocketCredentialRef(field);
  await storage.update(SLACK_SOCKET_PLUGIN, installSlug, {
    [`${field}_app_token`]: appToken,
    [`${field}_bot_token`]: botToken,
    [`${field}_expired`]: false,
  });
  return ref;
}

export async function resolveSlackSocketCredentials(
  source: ExternalTriggerSourceRow,
  installSlug: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<SlackSocketCredentials> {
  const field = slackSocketCredentialField(source.credentialRef);
  const config = await storage.read(SLACK_SOCKET_PLUGIN, installSlug);
  const appToken = config[`${field}_app_token`];
  const botToken = config[`${field}_bot_token`];
  if (typeof appToken !== 'string' || !appToken.startsWith('xapp-')) {
    throw new Error(`slack_app_token_not_connected:${field}`);
  }
  if (typeof botToken !== 'string' || !botToken.startsWith('xoxb-')) {
    throw new Error(`slack_bot_token_not_connected:${field}`);
  }
  return { appToken, botToken };
}

function uniqueStrings(values: unknown): string[] {
  return Array.isArray(values)
    ? [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))]
    : [];
}

async function slackJson<T>(response: Response, operation: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(`slack_${operation}_${response.status}:${body.error ?? 'request_failed'}`);
  }
  return body;
}

/** Validate the bot token, persist both secrets outside the tree, and upsert one owned source. */
export async function connectOwnedSlackSource(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    installSlug: string;
    field?: string;
    appToken: string;
    botToken: string;
    channels?: string[];
    createdBy?: string | null;
  },
  deps: { fetch?: typeof fetch; storage?: TokenStorage; apiOrigin?: string } = {},
): Promise<ExternalTriggerSourceRow> {
  const appToken = assertToken(input.appToken, 'xapp-', 'app_token');
  const botToken = assertToken(input.botToken, 'xoxb-', 'bot_token');
  const fetchImpl = deps.fetch ?? fetch;
  const origin = (deps.apiOrigin ?? SLACK_API_ORIGIN).replace(/\/$/, '');
  const auth = await slackJson<{
    ok?: boolean;
    team_id?: string;
    user_id?: string;
    bot_id?: string;
    app_id?: string;
  }>(await fetchImpl(`${origin}/api/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}`, accept: 'application/json' },
  }), 'auth_test');
  if (!auth.team_id || !auth.user_id) throw new Error('slack_auth_identity_missing');
  const field = input.field ?? input.ownerUserId;
  const credentialRef = await storeSlackSocketCredentials(
    input.installSlug,
    field,
    { appToken, botToken },
    deps.storage ?? fsTokenStorage,
  );
  return upsertOwnedExternalTriggerSource(sql, {
    workspaceId: input.workspaceId,
    kind: 'slack',
    ownerUserId: input.ownerUserId,
    credentialRef,
    status: 'connecting',
    config: {
      installSlug: input.installSlug,
      teamId: auth.team_id,
      botUserId: auth.user_id,
      ...(auth.bot_id ? { botId: auth.bot_id } : {}),
      ...(auth.app_id ? { appId: auth.app_id } : {}),
      channels: uniqueStrings(input.channels),
    },
    createdBy: input.createdBy,
  });
}

export function parseSlackSocketEnvelope(raw: unknown): SlackSocketEnvelope | null {
  try {
    const text = typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : String(raw);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SlackSocketEnvelope
      : null;
  } catch {
    return null;
  }
}

/** ACK is deliberately synchronous and precedes every async ingest operation. */
export function acknowledgeSlackSocketEnvelope(
  envelope: SlackSocketEnvelope,
  send: (payload: string) => void,
): boolean {
  if (!envelope.envelope_id) return false;
  send(JSON.stringify({ envelope_id: envelope.envelope_id }));
  return true;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function slackOccurredAt(value: unknown): string | null {
  const raw = text(value);
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : null;
}

function mentions(message: string): string[] {
  return [...message.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]);
}

export function normalizeSlackSocketEnvelope(envelope: SlackSocketEnvelope): SlackNormalizedEvent | null {
  const payload = envelope.payload ?? {};
  if (envelope.type === 'events_api') {
    const event = payload.event && typeof payload.event === 'object'
      ? payload.event as Record<string, unknown>
      : null;
    const eventId = text(payload.event_id);
    if (!event || !eventId || event.bot_id || event.subtype) return null;
    const channelId = text(event.channel) || null;
    const message = text(event.text);
    const kind = event.type === 'app_mention'
      ? 'mention'
      : event.type === 'message' && (event.channel_type === 'im' || channelId?.startsWith('D'))
        ? 'dm'
        : null;
    if (!kind || !message) return null;
    const occurredAt = slackOccurredAt(event.event_ts ?? event.ts ?? payload.event_time);
    return {
      event: kind,
      externalId: eventId,
      dedupeKey: `slack:${eventId}`,
      occurredAt,
      channelId,
      payload: {
        id: eventId,
        channelId,
        threadId: text(event.thread_ts) || text(event.ts) || undefined,
        sender: text(event.user),
        text: message,
        occurredAt: occurredAt ?? undefined,
        mentions: mentions(message),
        slackEventType: text(event.type),
      },
    };
  }
  if (envelope.type === 'slash_commands') {
    const externalId = text(payload.trigger_id) || envelope.envelope_id || '';
    if (!externalId) return null;
    const channelId = text(payload.channel_id) || null;
    const message = [text(payload.command), text(payload.text)].filter(Boolean).join(' ');
    return {
      event: 'slash-command',
      externalId,
      dedupeKey: `slack:${externalId}`,
      occurredAt: null,
      channelId,
      payload: {
        id: externalId,
        channelId,
        sender: text(payload.user_id),
        text: message,
        mentions: mentions(message),
        command: text(payload.command),
      },
    };
  }
  return null;
}

export async function ingestSlackSocketEnvelope(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  envelope: SlackSocketEnvelope,
  ingest: Ingest = (db, event) => ingestExternalTriggerEvent(db, event),
): Promise<SlackNormalizedEvent | null> {
  const normalized = normalizeSlackSocketEnvelope(envelope);
  if (!normalized) return null;
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: 'slack',
    event: normalized.event,
    externalId: normalized.externalId,
    datatypeId: 'chat-message',
    adapterPayload: normalized.payload,
    normalize: () => normalized.payload,
    occurredAt: normalized.occurredAt,
    dedupeKey: normalized.dedupeKey,
  });
  if (!result.ok) throw new Error(`slack_canonical_payload_invalid:${result.validationErrors?.join(';') ?? 'unknown'}`);
  return normalized;
}

export async function openSlackSocketUrl(
  appToken: string,
  fetchImpl: typeof fetch = fetch,
  apiOrigin = SLACK_API_ORIGIN,
): Promise<string> {
  const body = await slackJson<{ ok?: boolean; url?: string }>(
    await fetchImpl(`${apiOrigin.replace(/\/$/, '')}/api/apps.connections.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${assertToken(appToken, 'xapp-', 'app_token')}`, accept: 'application/json' },
    }),
    'connections_open',
  );
  if (!body.url?.startsWith('wss://')) throw new Error('slack_socket_url_missing');
  return body.url;
}

export interface SlackThreadMessageResult {
  channelId: string;
  threadId: string;
  messageTs: string;
}

/** Post one bounded bot reply to the exact Slack thread selected by the caller. */
export async function postSlackThreadMessage(
  botToken: string,
  input: { channelId: string; threadId: string; text: string },
  deps: { fetch?: typeof fetch; apiOrigin?: string } = {},
): Promise<SlackThreadMessageResult> {
  const channelId = input.channelId.trim();
  const threadId = input.threadId.trim();
  const message = input.text.trim();
  if (!channelId || channelId.length > 80) throw new Error('slack_reply_channel_invalid');
  if (!/^\d+(?:\.\d+)?$/.test(threadId)) throw new Error('slack_reply_thread_invalid');
  if (!message || message.length > 4_000) throw new Error('slack_reply_text_invalid');
  const origin = (deps.apiOrigin ?? SLACK_API_ORIGIN).replace(/\/$/, '');
  const body = await slackJson<{ ok?: boolean; channel?: string; ts?: string }>(
    await (deps.fetch ?? fetch)(`${origin}/api/chat.postMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${assertToken(botToken, 'xoxb-', 'bot_token')}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, thread_ts: threadId, text: message }),
    }),
    'chat_post_message',
  );
  if (!body.ts) throw new Error('slack_reply_message_ts_missing');
  return { channelId: body.channel?.trim() || channelId, threadId, messageTs: body.ts };
}

function historyChannels(source: ExternalTriggerSourceRow): string[] {
  return uniqueStrings([
    ...uniqueStrings(source.config.channels),
    ...uniqueStrings(source.cursor.channels),
  ]);
}

function historyEvent(
  source: ExternalTriggerSourceRow,
  channelId: string,
  message: Record<string, unknown>,
): SlackNormalizedEvent | null {
  if (message.bot_id || message.subtype) return null;
  const body = text(message.text);
  const ts = text(message.ts);
  if (!body || !ts) return null;
  const botUserId = text(source.config.botUserId);
  const kind = channelId.startsWith('D')
    ? 'dm'
    : botUserId && body.includes(`<@${botUserId}>`)
      ? 'mention'
      : null;
  if (!kind) return null;
  const externalId = text(message.client_msg_id) || `${channelId}:${ts}`;
  const occurredAt = slackOccurredAt(ts);
  return {
    event: kind,
    externalId,
    dedupeKey: `slack:${channelId}:${ts}`,
    occurredAt,
    channelId,
    payload: {
      id: externalId,
      channelId,
      threadId: text(message.thread_ts) || ts,
      sender: text(message.user),
      text: body,
      occurredAt: occurredAt ?? undefined,
      mentions: mentions(body),
      slackEventType: 'history',
    },
  };
}

export interface SlackHistoryResult {
  skipped: boolean;
  rateLimited: boolean;
  channelId: string | null;
  messages: number;
  retryAt: string | null;
  source: ExternalTriggerSourceRow;
}

/** One bounded conversations.history page per call; the cursor enforces the conservative one-minute cadence. */
export async function reconcileSlackHistoryOnce(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  botToken: string,
  deps: {
    fetch?: typeof fetch;
    now?: () => Date;
    apiOrigin?: string;
    ingest?: Ingest;
    updateSource?: typeof updateExternalTriggerSourceSyncState;
  } = {},
): Promise<SlackHistoryResult> {
  const channels = historyChannels(source);
  if (channels.length === 0) {
    return { skipped: true, rateLimited: false, channelId: null, messages: 0, retryAt: null, source };
  }
  const now = (deps.now ?? (() => new Date()))();
  const nextAt = Date.parse(text(source.cursor.historyNextAt));
  if (Number.isFinite(nextAt) && nextAt > now.getTime()) {
    return { skipped: true, rateLimited: false, channelId: null, messages: 0, retryAt: new Date(nextAt).toISOString(), source };
  }
  const indexRaw = Number(source.cursor.historyChannelIndex);
  const index = Number.isInteger(indexRaw) && indexRaw >= 0 ? indexRaw % channels.length : 0;
  const channelId = channels[index];
  const url = new URL('/api/conversations.history', deps.apiOrigin ?? SLACK_API_ORIGIN);
  url.searchParams.set('channel', channelId);
  url.searchParams.set('limit', '15');
  const byChannel = source.cursor.historyTsByChannel && typeof source.cursor.historyTsByChannel === 'object'
    ? source.cursor.historyTsByChannel as Record<string, unknown>
    : {};
  const oldest = text(byChannel[channelId]);
  if (oldest) url.searchParams.set('oldest', oldest);
  const pageCursor = text(source.cursor.historyPageCursor);
  if (pageCursor) url.searchParams.set('cursor', pageCursor);
  const response = await (deps.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${assertToken(botToken, 'xoxb-', 'bot_token')}`, accept: 'application/json' },
  });
  const updateSource = deps.updateSource ?? updateExternalTriggerSourceSyncState;
  if (response.status === 429) {
    const retrySeconds = Math.max(1, Number(response.headers.get('retry-after')) || 60);
    const retryAt = new Date(now.getTime() + retrySeconds * 1_000).toISOString();
    const updated = await updateSource(sql, source.workspaceId, source.id, {
      status: 'degraded',
      cursor: { ...source.cursor, channels, historyNextAt: retryAt },
      lastError: `slack_conversations_history_rate_limited:${retrySeconds}`,
    });
    return { skipped: false, rateLimited: true, channelId, messages: 0, retryAt, source: updated };
  }
  const body = await slackJson<{
    ok?: boolean;
    messages?: Array<Record<string, unknown>>;
    response_metadata?: { next_cursor?: string };
  }>(response, 'conversations_history');
  let delivered = 0;
  let newest = oldest;
  for (const message of [...(body.messages ?? [])].reverse()) {
    const normalized = historyEvent(source, channelId, message);
    const ts = text(message.ts);
    if (ts && (!newest || Number(ts) > Number(newest))) newest = ts;
    if (!normalized) continue;
    const result = await (deps.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)))(sql, {
      workspaceId: source.workspaceId,
      sourceId: source.id,
      source: 'slack',
      event: normalized.event,
      externalId: normalized.externalId,
      datatypeId: 'chat-message',
      adapterPayload: normalized.payload,
      normalize: () => normalized.payload,
      occurredAt: normalized.occurredAt,
      dedupeKey: normalized.dedupeKey,
    });
    if (!result.ok) throw new Error('slack_history_canonical_payload_invalid');
    delivered += 1;
  }
  const nextCursor = text(body.response_metadata?.next_cursor);
  const nextIndex = nextCursor ? index : (index + 1) % channels.length;
  const retryAt = new Date(now.getTime() + SLACK_HISTORY_MIN_INTERVAL_MS).toISOString();
  const cursor = {
    ...source.cursor,
    channels,
    historyTsByChannel: { ...byChannel, ...(newest ? { [channelId]: newest } : {}) },
    historyChannelIndex: nextIndex,
    historyPageCursor: nextCursor || undefined,
    historyNextAt: retryAt,
    ...(!nextCursor && nextIndex === 0 ? { historyReconciledAt: now.toISOString() } : {}),
  };
  const updated = await updateSource(sql, source.workspaceId, source.id, {
    status: source.status === 'connected' ? 'connected' : 'connecting',
    cursor,
    lastError: null,
  });
  return { skipped: false, rateLimited: false, channelId, messages: delivered, retryAt, source: updated };
}
