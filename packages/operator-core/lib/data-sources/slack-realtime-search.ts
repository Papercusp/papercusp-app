/**
 * Slack Real-time Search adapter (plan enterprise-data-sources-2026-10-01 P-018,
 * owner ruling D-006): the first live-search adapter. It stores nothing, per
 * Slack's terms for this API, so it is the route for deployments where copying
 * Slack data is not permitted.
 *
 * It calls `assistant.search.context` with the PRINCIPAL's own Slack user token
 * (xoxp-), so Slack itself enforces what that person can see: their public and
 * private channels, DMs and group DMs. A bot token would need an `action_token`
 * from a user-triggered event, which a turn-start injection never has.
 *
 * User tokens live in the same token storage as the socket-mode app credentials,
 * under the data source's credential field: `<field>_search_user_tokens` maps a
 * provider user id (the provider_identity_mappings id) to that user's token.
 */
import type { TokenStorage } from '../oauth/token';
import { fsTokenStorage } from '../oauth/storage-fs';
import { SLACK_SOCKET_PLUGIN, slackSocketCredentialField } from '../external-triggers/slack-credential-ref';
import type { LiveSearchAdapter, LiveSearchHit, LiveSearchInput } from './live-search-adapter';

export const SLACK_SEARCH_CONTEXT_URL = 'https://slack.com/api/assistant.search.context';
/** Slack's own maximum and default for this method. */
export const SLACK_SEARCH_MAX_LIMIT = 20;
export const SLACK_SEARCH_CHANNEL_TYPES = ['public_channel', 'private_channel', 'mpim', 'im'] as const;

interface SlackSearchMessage {
  author_name?: string;
  author_user_id?: string;
  team_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  permalink?: string;
}

interface SlackSearchResponse {
  ok?: boolean;
  error?: string;
  results?: { messages?: SlackSearchMessage[] };
}

export interface SlackRealtimeSearchDeps {
  fetch: typeof fetch;
  resolveUserToken: (input: LiveSearchInput) => Promise<string | null>;
}

function userTokenField(credentialRef: string | null): string {
  return `${slackSocketCredentialField(credentialRef)}_search_user_tokens`;
}

function installSlugOf(input: Pick<LiveSearchInput, 'record'>): string {
  const slug = input.record.config?.installSlug;
  if (typeof slug !== 'string' || !slug.trim()) throw new Error('slack_search_install_slug_missing');
  return slug.trim();
}

/** Store one principal's Slack user token for live search on a data source's credential. */
export async function storeSlackSearchUserToken(
  installSlug: string,
  credentialRef: string,
  providerUserId: string,
  token: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<void> {
  const value = token.trim();
  if (!value.startsWith('xoxp-') || value.length <= 'xoxp-'.length) throw new Error('slack_search_user_token_invalid');
  const field = userTokenField(credentialRef);
  const current = (await storage.read(SLACK_SOCKET_PLUGIN, installSlug))[field];
  const tokens = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
  tokens[providerUserId.trim()] = value;
  await storage.update(SLACK_SOCKET_PLUGIN, installSlug, { [field]: tokens });
}

export function slackTokenStorageResolver(storage: TokenStorage = fsTokenStorage) {
  return async (input: LiveSearchInput): Promise<string | null> => {
    const config = await storage.read(SLACK_SOCKET_PLUGIN, installSlugOf(input));
    const tokens = config[userTokenField(input.record.credentialRef)];
    const token = tokens && typeof tokens === 'object' ? (tokens as Record<string, unknown>)[input.providerUserId] : null;
    return typeof token === 'string' && token.startsWith('xoxp-') ? token : null;
  };
}

/** Slack message ts ("1727784000.123456") as an ISO instant, or null when unparseable. */
export function slackTsToIso(ts: string | undefined): string | null {
  const seconds = Number(ts);
  return ts && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

export function mapSlackSearchMessages(messages: readonly SlackSearchMessage[]): LiveSearchHit[] {
  return messages
    .filter((m) => m.channel_id && m.message_ts && (m.content ?? '').trim())
    .map((m, index) => ({
      externalId: `${m.team_id ?? ''}:${m.channel_id}:${m.message_ts}`,
      title: m.channel_name ? `#${m.channel_name}` : `channel ${m.channel_id}`,
      text: (m.content ?? '').trim(),
      occurredAt: slackTsToIso(m.message_ts),
      participants: m.author_user_id ? [m.author_user_id] : [],
      permalink: m.permalink ?? null,
      // Slack returns results best-first (sort=score) without a numeric score.
      score: 1 / (index + 1),
    }));
}

export function createSlackRealtimeSearchAdapter(
  deps: Partial<SlackRealtimeSearchDeps> = {},
): LiveSearchAdapter {
  const doFetch = deps.fetch ?? fetch;
  const resolveUserToken = deps.resolveUserToken ?? slackTokenStorageResolver();
  return {
    kind: 'slack',
    async search(input) {
      const token = await resolveUserToken(input);
      if (!token) throw new Error('slack_search_user_token_not_connected');
      const response = await doFetch(SLACK_SEARCH_CONTEXT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          query: input.query,
          channel_types: SLACK_SEARCH_CHANNEL_TYPES,
          content_types: ['messages'],
          limit: Math.max(1, Math.min(SLACK_SEARCH_MAX_LIMIT, input.limit)),
          sort: 'score',
        }),
        signal: input.signal,
      });
      const body = (await response.json().catch(() => ({}))) as SlackSearchResponse;
      if (!response.ok || body.ok !== true) {
        throw new Error(`slack_search_${response.status}:${body.error ?? 'request_failed'}`);
      }
      return mapSlackSearchMessages(body.results?.messages ?? []);
    },
  };
}

export const slackRealtimeSearchAdapter: LiveSearchAdapter = createSlackRealtimeSearchAdapter();
