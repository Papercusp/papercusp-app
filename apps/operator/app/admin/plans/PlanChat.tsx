'use client';

/**
 * PlanChat — an in-app agent chat rendered INLINE (inbox-cards-unification
 * D-006). Creates a harness-scoped agent-chat
 * (POST /api/harness/:slug/agent-chats) and mounts the standalone
 * <ChatPanel> — the same component the dock uses — directly in place, beneath
 * the card whose "💬 Chat" option opened it.
 *
 * Replaces the modal-based PlanChatModal (retired): the Plans tab isn't inside
 * the /adv HarnessesDock so it can't use the dock's OPEN_CHAT_EVENT, but it
 * can host a ChatPanel itself. agent_chats are per-harness, so a chat needs a
 * harnessSlug; a plan with no harness shows a clear "no harness" message.
 */

import { useEffect, useState } from 'react';
import ChatPanel from '@/app/harness/ChatPanel';

interface Props {
  /** Harness the chat is scoped to (agent_chats are per-harness schema). */
  harnessSlug: string | null | undefined;
  /** Context title for the chat (e.g. "<plan> · P-007"). */
  label: string;
}

export default function PlanChat({ harnessSlug, label }: Props) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create the chat once (when a harness is known). Re-create if the harness
  // or label changes (a different item was opened).
  useEffect(() => {
    setChatId(null);
    setError(null);
    if (!harnessSlug) return;
    let cancelled = false;
    setCreating(true);
    fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', title: label }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ id: string }>;
      })
      .then((chat) => {
        if (!cancelled) setChatId(chat.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessSlug, label]);

  if (!harnessSlug) {
    return (
      <div className="pc-plan-chat-inline__note pc-plans__placeholder">
        This isn’t attached to a harness, so an agent chat can’t be opened here.
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-plan-chat-inline__note pc-plans__placeholder pc-plans__placeholder--error">
        Couldn’t start the chat: <code>{error}</code>
      </div>
    );
  }
  if (!chatId) {
    return <div className="pc-plan-chat-inline__note pc-plans__placeholder">Starting chat…</div>;
  }
  return (
    <div className="pc-plan-chat-inline">
      <ChatPanel slug={harnessSlug} chatId={chatId} mode="discuss" />
    </div>
  );
}
