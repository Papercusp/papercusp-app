/**
 * openFeatureChat — programmatic open of an agent chat in the dock.
 *
 * Extracted from the (now-retired) shared PiTerminalsDock copy so external
 * callers (FeatureList) don't pull the entire xterm + dockview module
 * graph just for a small fetch + event dispatch helper. The canonical
 * dock implementation lives in apps/operator/app/harness/PiTerminalsDock —
 * the operator listens for the same `papercusp:open-chat` event this
 * dispatches.
 */

export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
  /** Conversation mode carried to the chat panel: 'discuss' reframes a
   *  worker to talk the feature through first (vs the default 'chat'). */
  mode?: 'chat' | 'discuss';
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

/**
 * Pending opens are pushed to a window-level queue so the dock can drain
 * them on its next mount, even if it isn't mounted yet when this fn is
 * called. The dock pops from `window.__PAPERCUSP_PENDING_CHAT_OPENS__`
 * during its own onReady. Same shape the operator's PiTerminalsDock used
 * before the dock module moved out of this lib.
 */
type WindowWithQueue = Window & {
  __PAPERCUSP_PENDING_CHAT_OPENS__?: OpenChatEventDetail[];
};

export async function openFeatureChat(opts: {
  slug: string;
  role: string;
  featureId: string;
  title?: string;
  /** 'discuss' opens the chat in discuss mode (worker talks it through
   *  first, doesn't implement). Carried to the panel + sent per message;
   *  the agent-chats stream handler reads it when assembling the prompt. */
  mode?: 'chat' | 'discuss';
  /** WI-6023 — HOST-THE-PANEL callers pass false.
   *
   *  Default true keeps the dock path byte-identical: queue the detail on
   *  `__PAPERCUSP_PENDING_CHAT_OPENS__` + dispatch OPEN_CHAT_EVENT, which
   *  only HarnessesDock / PiTerminalsDock listen for.
   *
   *  A caller OUTSIDE a dock tree (WorkItemPopupModal, mounted by
   *  OperatorChat) must pass false and render <ChatPanel> itself with the
   *  returned chatId — the PlanChat precedent. Leaving it true there is the
   *  WI-6023 bug and is worse than a no-op: the event has no listener, so
   *  the click looks dead, AND the detail still lands on the pending queue,
   *  so the next time a dock mounts it drains a backlog of stale opens and
   *  spews chat panels the user asked for minutes ago somewhere else. */
  dispatch?: boolean;
}): Promise<{ chatId: string } | { error: string }> {
  const dispatch = opts.dispatch !== false;
  try {
    // Reuse-before-create (WI-125): a repeat click for the same
    // (role, featureId) focuses the existing live conversation instead of
    // minting a new agent_chats row each time. The list endpoint already
    // excludes archived chats; the dock dedupes panels by chatId, so
    // re-dispatching an existing chat focuses its panel. Best-effort — any
    // failure here falls through to the create path.
    try {
      const list = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`);
      if (list.ok) {
        const body = (await list.json()) as {
          chats?: Array<{ id: string; role: string; feature_id: string | null; title: string | null }>;
        };
        const existing = (body.chats ?? []).find(
          (c) => c.role === opts.role && c.feature_id === opts.featureId,
        );
        if (existing) {
          const detail: OpenChatEventDetail = {
            slug: opts.slug,
            chatId: existing.id,
            title: existing.title ?? opts.title,
            role: existing.role,
            featureId: opts.featureId,
            ...(opts.mode ? { mode: opts.mode } : {}),
          };
          if (dispatch && typeof window !== 'undefined') {
            const w = window as WindowWithQueue;
            const queue = w.__PAPERCUSP_PENDING_CHAT_OPENS__ ?? [];
            queue.push(detail);
            w.__PAPERCUSP_PENDING_CHAT_OPENS__ = queue;
            window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
          }
          return { chatId: existing.id };
        }
      }
    } catch {
      /* list unavailable — create as before */
    }
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: opts.role,
        feature_id: opts.featureId,
        title: opts.title,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      return { error: body.error ?? `HTTP ${r.status}` };
    }
    const chat = await r.json();
    const detail: OpenChatEventDetail = {
      slug: opts.slug,
      chatId: chat.id,
      title: chat.title,
      role: chat.role,
      featureId: chat.feature_id ?? undefined,
      ...(opts.mode ? { mode: opts.mode } : {}),
    };
    if (dispatch && typeof window !== 'undefined') {
      const w = window as WindowWithQueue;
      const queue = w.__PAPERCUSP_PENDING_CHAT_OPENS__ ?? [];
      queue.push(detail);
      w.__PAPERCUSP_PENDING_CHAT_OPENS__ = queue;
      window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    }
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
