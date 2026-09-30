/**
 * chat-seed — hand a drafted message to the Papercup chat composer
 * (owner ask 2026-07-16: the Inbox "Discuss" action opens a chat with
 * Papercup about the item, instead of a thread with the — usually dead or
 * system — originating agent).
 *
 * Two delivery paths, consume-once either way:
 *  - the pending store: OperatorChat is usually NOT mounted when Discuss is
 *    clicked (the inbox view replaces the chat body), so it consumes the seed
 *    in its input-state initializer on mount;
 *  - the window event: covers a mounted composer (defensive — no current
 *    caller seeds while the chat is visible).
 */
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

let pending: string | null = null;

export const CHAT_SEED_EVENT = 'papercusp:seedOperatorChatDraft';

/** Stage `text` as the Papercup composer draft and notify a mounted chat. */
export function seedOperatorChatDraft(text: string): void {
  pending = text;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHAT_SEED_EVENT, { detail: { text } }));
  }
}

/** One-shot read: returns the staged draft and clears it. */
export function consumePendingChatSeed(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/**
 * Composer-draft persistence — the composer's in-progress text, keyed per
 * workspace in sessionStorage (per-window, survives an OperatorChat REMOUNT:
 * flipping the sidebar to the inbox/pot view and back, an SSE-reconnect
 * re-key, an in-window reload). Without this, a seeded Discuss draft — or a
 * half-typed message — silently vanished on any body swap (EI-13037 deferred
 * item). Storage failures (sandboxed webview, quota) degrade to the old
 * lose-the-draft behavior rather than throwing into render.
 */
const DRAFT_STORAGE_KEY = 'op-chat-draft';

function draftKey(): string {
  return wsLocalKey(DRAFT_STORAGE_KEY);
}

/** The persisted composer draft, or null when none is stored. */
export function readChatDraft(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(draftKey());
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** Persist the composer draft; empty/blank text clears the stored draft. */
export function writeChatDraft(text: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (text.trim()) window.sessionStorage.setItem(draftKey(), text);
    else window.sessionStorage.removeItem(draftKey());
  } catch {
    // Best-effort — an unwritable store just means the draft won't survive a remount.
  }
}
