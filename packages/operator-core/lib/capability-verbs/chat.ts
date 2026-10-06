/**
 * Provider-neutral chat capability seam (D-019 Tier 1, plan item P-031).
 *
 * Generalizes `slack:respond-in-thread { planRunId, text }` off its plan-run
 * binding: the same D-020 rail-1 guarantee (caller supplies text only; the
 * server resolves channel + thread) now keyed to a canonical `chat-message`
 * id, so an ad-hoc "reply to that thread" works without a trigger-bound run.
 *
 * Verb names carry no provider, so Teams/Discord land as adapters here rather
 * than as new agent-facing verbs.
 */
import type postgres from 'postgres';
import { postSlackThreadMessage, resolveSlackSocketCredentials } from '../external-triggers/slack';
import { fsTokenStorage } from '../oauth/storage-fs';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressee, type AddresseeProvenance } from './addressing';
import { resolveCanonicalDocument, resolveOutboundContext, string, type CanonicalDocument } from './resolve';

export interface ChatReplyCoordinates {
  channelId: string;
  threadId: string;
}

export interface ChatReplyResult {
  channelId: string;
  threadId: string;
  messageTs: string;
}

export type ChatDeps = {
  resolveCredentials?: typeof resolveSlackSocketCredentials;
  postThreadMessage?: typeof postSlackThreadMessage;
  storage?: Parameters<typeof resolveSlackSocketCredentials>[2];
  fetch?: typeof fetch;
  apiOrigin?: string;
};

/**
 * D-020 rail 1 for chat. Pure and exported for the same reason as the mail
 * equivalent: the security claim is "these coordinates come from the stored
 * document, never from a caller argument", and that is only checkable if the
 * derivation is a function of the document alone.
 *
 * A Slack thread reply targets `threadId` when the message is already in a
 * thread, and the message's own ts when it is a top-level message — replying
 * to a root message means STARTING its thread.
 */
export function resolveChatReplyCoordinates(doc: CanonicalDocument): ChatReplyCoordinates {
  if (doc.source !== 'slack') throw new Error(`chat_reply_source_unsupported:${doc.source}`);
  const payload = doc.payload;
  const channelId = string(payload.channelId);
  const threadId = string(payload.threadId) || string(payload.id) || doc.externalId;
  if (!channelId) throw new Error('chat_reply_coordinates_missing');
  if (!threadId) throw new Error('chat_reply_coordinates_missing');
  return { channelId, threadId };
}

/** `chat:reply` — caller supplies TEXT ONLY; destination is server-resolved. */
export async function replyToCanonicalChat(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    messageId: string;
    text: string;
    /**
     * Reader-set labels: see `sendNewMail` in ./mail. A channel's readers cannot
     * be enumerated as mailboxes, so any active disclosure refuses the post.
     */
    agentOwnerId: string | null;
  },
  deps: ChatDeps = {},
): Promise<ChatReplyResult> {
  const text = params.text.trim();
  if (!text || text.length > 4_000) throw new Error('chat_reply_text_invalid');

  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: 'slack',
    externalId: params.messageId,
  });
  const coordinates = resolveChatReplyCoordinates(doc);
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: `slack:${coordinates.channelId}`,
  });
  const ctx = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: 'slack',
  });
  const credentials = await (deps.resolveCredentials ?? resolveSlackSocketCredentials)(
    ctx.source,
    ctx.installSlug,
    deps.storage ?? fsTokenStorage,
  );
  return (deps.postThreadMessage ?? postSlackThreadMessage)(
    credentials.botToken,
    { channelId: coordinates.channelId, threadId: coordinates.threadId, text },
    { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
  );
}

/**
 * `chat:post` — create-shaped: the caller names the destination channel, so
 * D-020 rail 2 applies. A channel id quoted inside an inbound message body is
 * refused for the same reason an injected email address is.
 */
export async function postToChatChannel(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    channelId: string;
    threadId?: string | null;
    text: string;
    provenance: AddresseeProvenance;
    /** See `replyToCanonicalChat`. */
    agentOwnerId: string | null;
  },
  deps: ChatDeps = {},
): Promise<ChatReplyResult> {
  const text = params.text.trim();
  if (!text || text.length > 4_000) throw new Error('chat_post_text_invalid');
  const channelId = string(params.channelId);
  if (!channelId) throw new Error('chat_post_channel_required');

  await assertTrustedAddressee(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: channelId,
    provenance: params.provenance,
  });
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: `slack:${channelId}`,
  });

  const ctx = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: 'slack',
  });
  const credentials = await (deps.resolveCredentials ?? resolveSlackSocketCredentials)(
    ctx.source,
    ctx.installSlug,
    deps.storage ?? fsTokenStorage,
  );
  const threadId = string(params.threadId ?? '');
  if (!threadId) throw new Error('chat_post_thread_required');
  return (deps.postThreadMessage ?? postSlackThreadMessage)(
    credentials.botToken,
    { channelId, threadId, text },
    { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
  );
}
