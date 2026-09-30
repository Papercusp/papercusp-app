'use client';

/**
 * MessageOwnerThread — the inbox "Message owner" inline thread
 * (inbox-tiering-and-message-agent-2026-06-05, D-004, P-009).
 *
 * Renders beneath the inbox detail card when the human picks "Message owner":
 * a compose box that opens a work-item-scoped conversation with the item's
 * owning agent (coord:message-agent via the /api/admin/coord proxy), then the
 * resulting thread (conversations:get) with a reply box (conversations:post).
 * The same conversation is browsable in Brief 25's Conversations tab.
 *
 * Request/response model (no SSE) per the Planning tab's D-008 — refetch on
 * send + an explicit Refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  messageOwner,
  getConversation,
  postConversation,
  type AttentionItem,
  type ConversationDetail,
} from './plans-api';

export default function MessageOwnerThread({ item }: { item: AttentionItem }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);

  const ownerLabel = item.ownerLabel ?? item.ownerAgentId ?? (item.harnessSlug ? `${item.harnessSlug} agents` : 'owner');

  const loadThread = useCallback(async (id: string) => {
    try {
      const d = await getConversation(id);
      if ('error' in d) {
        toast.error('Failed to load thread', { description: d.error });
        return;
      }
      setDetail(d);
    } catch (e) {
      toast.error('Failed to load thread', { description: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    if (conversationId) void loadThread(conversationId);
  }, [conversationId, loadThread]);

  const open = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await messageOwner({
        to: item.ownerAgentId,
        body,
        harness: item.harnessSlug,
        plan_slug: item.planSlug,
        item_ref: item.itemRef,
        title: item.title.slice(0, 120),
      });
      if (!r.ok || !r.conversation_id) {
        toast.error('Could not open the thread', { description: r.error ?? 'unknown error' });
        return;
      }
      setDraft('');
      setConversationId(r.conversation_id);
      toast.success(r.to ? `Messaged ${ownerLabel}` : 'Opened a thread for this item');
    } catch (e) {
      toast.error('Could not open the thread', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const body = reply.trim();
    if (!body || !conversationId || busy) return;
    setBusy(true);
    try {
      const r = await postConversation(conversationId, body);
      if (!r.ok) {
        toast.error('Reply failed', { description: r.error ?? 'unknown error' });
        return;
      }
      setReply('');
      await loadThread(conversationId);
    } catch (e) {
      toast.error('Reply failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!conversationId) {
    return (
      <div className="pc-msgowner" data-testid="message-owner-compose">
        <label className="pc-msgowner__label">
          Message {ownerLabel}
          {item.itemRef ? <span className="pc-msgowner__scope"> · {item.itemRef}</span> : null}
        </label>
        <textarea
          className="pc-msgowner__input"
          rows={3}
          placeholder={`Ask ${ownerLabel} about this — opens a thread scoped to the work-item.`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <div className="pc-msgowner__actions">
          <button type="button" className="pc-btn pc-btn--primary" onClick={() => void open()} disabled={busy || !draft.trim()}>
            {busy ? 'Opening…' : 'Send'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-msgowner" data-testid="message-owner-thread">
      <div className="pc-msgowner__head">
        <span className="pc-msgowner__label">Thread with {ownerLabel}</span>
        <button type="button" className="pc-btn pc-btn--ghost" onClick={() => conversationId && void loadThread(conversationId)} disabled={busy}>
          Refresh
        </button>
      </div>
      <ul className="pc-msgowner__posts" role="list">
        {detail?.conversation ? (
          <li className="pc-msgowner__post">
            <span className="pc-msgowner__author">{detail.conversation.asker_id}</span>
            <span className="pc-msgowner__body">{detail.conversation.body}</span>
          </li>
        ) : null}
        {(detail?.posts ?? []).map((p) => (
          <li key={p.id} className="pc-msgowner__post">
            <span className="pc-msgowner__author">{p.author_id}</span>
            <span className="pc-msgowner__body">{p.body}</span>
          </li>
        ))}
      </ul>
      <textarea
        className="pc-msgowner__input"
        rows={2}
        placeholder="Reply…"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        disabled={busy}
      />
      <div className="pc-msgowner__actions">
        <button type="button" className="pc-btn pc-btn--primary" onClick={() => void send()} disabled={busy || !reply.trim()}>
          {busy ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}
