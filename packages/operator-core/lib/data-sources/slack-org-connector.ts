/**
 * Slack organization connector (plan enterprise-data-sources-2026-10-01 P-016).
 *
 * Credential model: the CUSTOMER'S OWN internal Slack app. The customer creates the
 * app in their own workspace and gives us its bot token (plus the Socket Mode app
 * token, so the same credential serves realtime events). Slack rate-limits
 * conversations.history / conversations.replies far harder for commercially
 * distributed apps than for a customer-built internal app, so the backfill below is
 * paced for the internal-app tier and still obeys every 429 Retry-After.
 *
 * The source is organization-scoped (D-005): permission_mapping.mode = source-acl,
 * chat-message -> document. Two jobs feed the documents corpus:
 *   - membership sync: every channel the app is a member of gets a permission list
 *     (source 'slack', source_ref = team-qualified channel id) whose members are the
 *     channel's team-qualified Slack user ids. A provider identity never selects a
 *     principal on its own (D-002); reads still need an explicit identity mapping.
 *   - backfill: one paced conversations.history page per step, thread replies
 *     included, written as raw chat messages (chat-retrieval-units.ts) that the
 *     rollup turns into thread / window units.
 *
 * GATE: a legal read of Slack's 2025 API terms for this credential model had to be on
 * record before the connector was enabled for any customer workspace; it is
 * (enterprise-data-sources-2026-10-01 D-029), so the `papercusp-slack-org-connector`
 * flag defaults ON. Every entry point still refuses while that flag is switched OFF.
 */
import type postgres from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { TokenStorage } from '../oauth/token';
import { fsTokenStorage } from '../oauth/storage-fs';
import { storeSlackSocketCredentials } from '../external-triggers/slack';
import {
  type ExternalTriggerSourceRow,
  updateExternalTriggerSourceSyncState,
  upsertOwnedExternalTriggerSource,
} from '../external-triggers/source-store';
import { upsertChatMessages, type ChatMessageInput } from './chat-retrieval-units';
import type { ChatAdmissionAdapter } from './chat-admission-sink';
import { replacePermissionListMembers, upsertPermissionList } from './documents-corpus';

const SLACK_API_ORIGIN = 'https://slack.com';
export const SLACK_ORG_CREDENTIAL_MODEL = 'customer-internal-app';
/** conversations.history / conversations.replies page size; Slack's documented maximum is 999, 200 is its recommendation. */
export const SLACK_ORG_HISTORY_PAGE = 200;
/** Internal-app Tier 3 is ~50 calls/minute; 1.5s between backfill steps stays under it with headroom. */
export const SLACK_ORG_MIN_STEP_MS = 1_500;
export const SLACK_ORG_DISABLED_ERROR = 'slack_org_connector_disabled:legal_review_pending';

type Sql = postgres.Sql;

export interface SlackOrgDeps {
  fetch?: typeof fetch;
  apiOrigin?: string;
  now?: () => Date;
  storage?: TokenStorage;
  /** Gate check; defaults to the slack-org-connector flag. */
  isEnabled?: () => Promise<boolean>;
}

async function assertEnabled(deps: SlackOrgDeps): Promise<void> {
  const enabled = deps.isEnabled
    ? await deps.isEnabled()
    : await getFlag(FLAGS.SLACK_ORG_CONNECTOR, 'system').catch(() => false);
  if (!enabled) throw new Error(SLACK_ORG_DISABLED_ERROR);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function botTokenOf(token: string): string {
  const out = token.trim();
  if (!out.startsWith('xoxb-') || out.length <= 5) throw new Error('slack_bot_token_invalid');
  return out;
}

class SlackRateLimited extends Error {
  constructor(readonly retryAfterSec: number, operation: string) {
    super(`slack_${operation}_rate_limited:${retryAfterSec}`);
  }
}

async function slackCall<T>(
  deps: SlackOrgDeps,
  botToken: string,
  method: string,
  params: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(`/api/${method}`, (deps.apiOrigin ?? SLACK_API_ORIGIN).replace(/\/$/, ''));
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const response = await (deps.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${botTokenOf(botToken)}`, accept: 'application/json' },
  });
  const operation = method.replace(/\./g, '_');
  if (response.status === 429) {
    throw new SlackRateLimited(Math.max(1, Number(response.headers.get('retry-after')) || 60), operation);
  }
  const body = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(`slack_${operation}_${response.status}:${body.error ?? 'request_failed'}`);
  }
  return body;
}

function teamOf(source: ExternalTriggerSourceRow): string {
  const team = text(source.config?.teamId);
  if (!team) throw new Error('slack_org_team_missing');
  return team;
}

/** Team-qualified ids keep channels and users unique across an Enterprise Grid org. */
export function slackOrgChannelRef(teamId: string, channelId: string): string {
  return `${teamId}:${channelId}`;
}

export function slackOrgUserRef(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

/**
 * Connect a customer's internal Slack app as an organization data source. The
 * caller is the authenticated admin who installs it; they become the source's
 * owner (who manages the connection), never the principal its data is read as.
 */
export async function connectOrganizationSlackSource(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    installSlug: string;
    appToken: string;
    botToken: string;
    field?: string;
    createdBy?: string | null;
  },
  deps: SlackOrgDeps = {},
): Promise<ExternalTriggerSourceRow> {
  await assertEnabled(deps);
  const auth = await slackCall<{ team_id?: string; user_id?: string; bot_id?: string; app_id?: string }>(
    deps, input.botToken, 'auth.test', {},
  );
  if (!auth.team_id || !auth.user_id) throw new Error('slack_auth_identity_missing');
  const field = input.field ?? `org-${auth.team_id}`;
  const credentialRef = await storeSlackSocketCredentials(
    input.installSlug,
    field,
    { appToken: input.appToken, botToken: input.botToken },
    deps.storage ?? fsTokenStorage,
  );
  const source = await upsertOwnedExternalTriggerSource(sql, {
    workspaceId: input.workspaceId,
    kind: 'slack',
    ownerUserId: input.ownerUserId,
    providerAccountId: `org:${auth.team_id}`,
    credentialRef,
    status: 'connecting',
    config: {
      installSlug: input.installSlug,
      teamId: auth.team_id,
      botUserId: auth.user_id,
      ...(auth.bot_id ? { botId: auth.bot_id } : {}),
      ...(auth.app_id ? { appId: auth.app_id } : {}),
      credentialModel: SLACK_ORG_CREDENTIAL_MODEL,
    },
    createdBy: input.createdBy,
  });
  await sql`
    UPDATE harness_shared.data_sources
       SET scope = 'organization',
           scope_ref = NULL,
           permission_mapping = '{"mode": "source-acl"}'::jsonb,
           datatype_mappings = '{"message": "chat-message"}'::jsonb,
           destination_policy = '{"chat-message": ["document"]}'::jsonb,
           backfill_status = CASE WHEN backfill_status = 'complete' THEN backfill_status ELSE 'pending' END,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId} AND id = ${source.id}::uuid`;
  return source;
}

interface SlackChannel { id?: string; name?: string; is_member?: boolean; is_archived?: boolean }

async function listMemberChannels(deps: SlackOrgDeps, botToken: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const page = await slackCall<{ channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
      deps, botToken, 'conversations.list',
      { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', cursor },
    );
    for (const channel of page.channels ?? []) {
      if (channel.is_member && !channel.is_archived && text(channel.id)) out.push(channel);
    }
    cursor = text(page.response_metadata?.next_cursor) || undefined;
  } while (cursor);
  return out;
}

async function listChannelMembers(deps: SlackOrgDeps, botToken: string, channelId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await slackCall<{ members?: string[]; response_metadata?: { next_cursor?: string } }>(
      deps, botToken, 'conversations.members', { channel: channelId, limit: '1000', cursor },
    );
    for (const member of page.members ?? []) if (text(member)) out.push(text(member));
    cursor = text(page.response_metadata?.next_cursor) || undefined;
  } while (cursor);
  return out;
}

export interface SlackOrgMembershipResult {
  channels: string[];
  added: number;
  removed: number;
}

/**
 * Refresh every member channel's permission list to exactly the channel's current
 * members, and record the channel set on the source cursor for the backfill.
 */
export async function syncSlackOrgMembership(
  sql: Sql,
  source: ExternalTriggerSourceRow,
  botToken: string,
  deps: SlackOrgDeps = {},
): Promise<SlackOrgMembershipResult> {
  await assertEnabled(deps);
  const team = teamOf(source);
  const channels = await listMemberChannels(deps, botToken);
  let added = 0;
  let removed = 0;
  const refs: string[] = [];
  for (const channel of channels) {
    const channelId = text(channel.id);
    const ref = slackOrgChannelRef(team, channelId);
    const members = await listChannelMembers(deps, botToken, channelId);
    const list = await upsertPermissionList(sql, source.workspaceId, {
      source: 'slack',
      sourceRef: ref,
      title: channel.name ? `#${channel.name}` : ref,
    });
    const delta = await replacePermissionListMembers(
      sql, source.workspaceId, list.id,
      members.map((member) => ({ provider: 'slack', providerUserId: slackOrgUserRef(team, member) })),
    );
    added += delta.added;
    removed += delta.removed;
    refs.push(channelId);
  }
  const prior = orgCursor(source);
  await updateExternalTriggerSourceSyncState(sql, source.workspaceId, source.id, {
    status: source.status === 'connected' ? 'connected' : 'connecting',
    cursor: {
      ...source.cursor,
      orgBackfill: { ...prior, channels: refs, membershipSyncedAt: (deps.now ?? (() => new Date()))().toISOString() },
    },
    lastError: null,
  });
  return { channels: refs, added, removed };
}

interface OrgBackfillCursor {
  channels?: string[];
  index?: number;
  pageCursor?: string;
  nextAt?: string;
  membershipSyncedAt?: string;
}

function orgCursor(source: ExternalTriggerSourceRow): OrgBackfillCursor {
  const raw = source.cursor?.orgBackfill;
  return raw && typeof raw === 'object' ? { ...(raw as OrgBackfillCursor) } : {};
}

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  edited?: { ts?: string };
}

function slackTsDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1_000));
}

function toChatMessage(team: string, channelId: string, message: SlackMessage): ChatMessageInput | null {
  const ts = text(message.ts);
  if (!ts || !Number.isFinite(Number(ts))) return null;
  // Join/leave and other system subtypes carry no content worth indexing.
  if (message.subtype && message.subtype !== 'thread_broadcast' && message.subtype !== 'bot_message') return null;
  const threadTs = text(message.thread_ts);
  const user = text(message.user);
  const edited = text(message.edited?.ts);
  return {
    channelId: slackOrgChannelRef(team, channelId),
    providerMessageId: ts,
    threadKey: threadTs ? `${slackOrgChannelRef(team, channelId)}:${threadTs}` : null,
    authorRef: user ? slackOrgUserRef(team, user) : null,
    authorLabel: text(message.username) || user || null,
    body: typeof message.text === 'string' ? message.text : '',
    postedAt: slackTsDate(ts),
    editedAt: edited ? slackTsDate(edited) : null,
  };
}

async function fetchReplies(deps: SlackOrgDeps, botToken: string, channelId: string, threadTs: string): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await slackCall<{ messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
      deps, botToken, 'conversations.replies',
      { channel: channelId, ts: threadTs, limit: String(SLACK_ORG_HISTORY_PAGE), cursor },
    );
    out.push(...(page.messages ?? []));
    cursor = text(page.response_metadata?.next_cursor) || undefined;
  } while (cursor);
  return out;
}

/**
 * Slack's chat admission adapter (chat-admission-sink.ts; slack-messages-to-bug-reports D-008,
 * D-009). Slack messages are stored exactly as the backfill stores them (toChatMessage): channel
 * `<team>:<channel>`, provider id = ts, thread key `<team>:<channel>:<thread_ts>`. A subject the
 * event does not carry (a reaction, an in-thread mention, a shortcut) is fetched as ONE message:
 * conversations.history pinned to its ts finds a top-level post, conversations.replies a reply.
 * Fetching reads channel history, so it is gated like the backfill (slack-org-connector flag).
 */
export function createSlackChatAdmissionAdapter(
  source: ExternalTriggerSourceRow,
  botToken: () => Promise<string>,
  deps: SlackOrgDeps = {},
): ChatAdmissionAdapter {
  // Resolved per call, not here: the sink is built for every envelope, and a source without a
  // team id must fail only its chat admission (when a rule needs it), never the whole ingest.
  const team = () => teamOf(source);
  return {
    keys(subject) {
      const channel = slackOrgChannelRef(team(), subject.channelId);
      return {
        channelId: channel,
        providerMessageId: subject.ts,
        threadKey: subject.threadTs ? `${channel}:${subject.threadTs}` : null,
        ownThreadKey: `${channel}:${subject.ts}`,
      };
    },
    fromEvent(subject, payload) {
      const sender = text(payload.sender);
      const own = toChatMessage(team(), subject.channelId, {
        ts: subject.ts,
        ...(subject.threadTs ? { thread_ts: subject.threadTs } : {}),
        ...(sender ? { user: sender } : {}),
        text: subject.text,
      });
      if (!own) throw new Error(`slack_chat_message_unmappable:${subject.channelId}:${subject.ts}`);
      return own;
    },
    async fetch(subject) {
      await assertEnabled(deps);
      const token = await botToken();
      const top = await slackCall<{ messages?: SlackMessage[] }>(
        deps, token, 'conversations.history',
        { channel: subject.channelId, latest: subject.ts, oldest: subject.ts, inclusive: 'true', limit: '1' },
      );
      const found = (top.messages ?? []).find((m) => text(m.ts) === subject.ts)
        ?? (await fetchReplies(deps, token, subject.channelId, subject.ts)).find((m) => text(m.ts) === subject.ts);
      return found ? toChatMessage(team(), subject.channelId, found) : null;
    },
  };
}

export interface SlackOrgBackfillStep {
  status: 'skipped' | 'paused' | 'rate-limited' | 'progressed' | 'complete';
  channelId: string | null;
  written: number;
  nextAt: string | null;
}

async function setBackfillStatus(sql: Sql, source: ExternalTriggerSourceRow, status: string): Promise<void> {
  await sql`
    UPDATE harness_shared.data_sources SET backfill_status = ${status}, updated_at = now()
     WHERE workspace_id = ${source.workspaceId} AND id = ${source.id}::uuid AND backfill_status <> ${status}`;
}

/**
 * One paced backfill step: a single conversations.history page of one channel (with
 * the replies of every threaded parent on it). The cursor walks channels in order and
 * pages each one to its start; `nextAt` spaces steps for the internal-app tier, and a
 * 429 pushes it to Slack's Retry-After. Re-running after a crash repeats at most the
 * page in flight, which upsertChatMessages absorbs.
 */
export async function backfillSlackOrgOnce(
  sql: Sql,
  source: ExternalTriggerSourceRow,
  botToken: string,
  deps: SlackOrgDeps = {},
): Promise<SlackOrgBackfillStep> {
  await assertEnabled(deps);
  const team = teamOf(source);
  const now = (deps.now ?? (() => new Date()))();
  const cursor = orgCursor(source);
  const channels = Array.isArray(cursor.channels) ? cursor.channels.filter((c) => text(c)) : [];
  if (channels.length === 0) return { status: 'skipped', channelId: null, written: 0, nextAt: null };
  const index = Number.isInteger(cursor.index) && (cursor.index as number) >= 0 ? cursor.index as number : 0;
  if (index >= channels.length) {
    await setBackfillStatus(sql, source, 'complete');
    return { status: 'complete', channelId: null, written: 0, nextAt: null };
  }
  const nextAtMs = Date.parse(text(cursor.nextAt));
  if (Number.isFinite(nextAtMs) && nextAtMs > now.getTime()) {
    return { status: 'paused', channelId: channels[index]!, written: 0, nextAt: new Date(nextAtMs).toISOString() };
  }
  const channelId = channels[index]!;
  await setBackfillStatus(sql, source, 'running');
  const save = async (next: OrgBackfillCursor, lastError: string | null) => {
    await updateExternalTriggerSourceSyncState(sql, source.workspaceId, source.id, {
      status: lastError ? 'degraded' : (source.status === 'connected' ? 'connected' : 'connecting'),
      cursor: { ...source.cursor, orgBackfill: next },
      lastError,
    });
  };
  try {
    const page = await slackCall<{ messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
      deps, botToken, 'conversations.history',
      { channel: channelId, limit: String(SLACK_ORG_HISTORY_PAGE), cursor: cursor.pageCursor },
    );
    const batch: ChatMessageInput[] = [];
    for (const message of page.messages ?? []) {
      const own = toChatMessage(team, channelId, message);
      if (own) batch.push(own);
      const threadTs = text(message.thread_ts);
      if (threadTs && threadTs === text(message.ts) && Number(message.reply_count ?? 0) > 0) {
        for (const reply of await fetchReplies(deps, botToken, channelId, threadTs)) {
          if (text(reply.ts) === threadTs) continue;
          const row = toChatMessage(team, channelId, reply);
          if (row) batch.push(row);
        }
      }
    }
    const { written } = await upsertChatMessages(sql, source.workspaceId, source.id, batch);
    const pageCursor = text(page.response_metadata?.next_cursor) || undefined;
    const nextIndex = pageCursor ? index : index + 1;
    const nextAt = new Date(now.getTime() + SLACK_ORG_MIN_STEP_MS).toISOString();
    await save({ ...cursor, channels, index: nextIndex, pageCursor, nextAt }, null);
    if (nextIndex >= channels.length) {
      await setBackfillStatus(sql, source, 'complete');
      return { status: 'complete', channelId, written, nextAt: null };
    }
    return { status: 'progressed', channelId, written, nextAt };
  } catch (error) {
    if (error instanceof SlackRateLimited) {
      const nextAt = new Date(now.getTime() + error.retryAfterSec * 1_000).toISOString();
      await save({ ...cursor, channels, index, nextAt }, error.message);
      return { status: 'rate-limited', channelId, written: 0, nextAt };
    }
    throw error;
  }
}
