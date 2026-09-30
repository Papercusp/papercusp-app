'use client';

/**
 * DesktopAttentionNotifier — the desktop-native consumer of attention pushes
 * (planning-attention-importance-2026-05-31, D-007).
 *
 * Subscribes to the sync bus for `attention.notify` events (emitted by
 * notifyAttention on the operator side at the ≥high attention sources) and
 * surfaces each one two ways, both fail-safe:
 *   1. an in-app sonner toast — always (works in the browser and the desktop
 *      webview, visible the moment it fires);
 *   2. in the Tauri desktop only, a native OS notification via the
 *      `show_attention_notification` Rust command (tauri-plugin-notification),
 *      so the human is pinged even when the window is backgrounded — DISABLED
 *      BY DEFAULT (owner request 2026-06-18; opt in via
 *      localStorage['papercusp:desktopOsNotifications']='1').
 *
 * Rides the sync transport's OWN stream via `onSyncBusEvent` — it must NOT
 * open a second EventSource against /api/zero-harness/sse: in the browser
 * every standing SSE stream holds one of Chromium's ~6 per-host HTTP/1.1
 * sockets, and the duplicate stream pushed the app to the limit, starving
 * ordinary fetches (route loaders queued indefinitely). The sync layer also
 * already owns the reconnect/zombie-watchdog resilience this component used
 * to hand-roll for its private stream.
 *
 * Lives at the app level (NOT in the generic @papercusp/sync lib, which stays
 * domain-free) and is mounted once at the root. An attention push rides the
 * bus as an event with `name === 'attention.notify'`.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';
import { onSyncBusEvent } from '@papercusp/sync';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';

const ATTENTION_NOTIFY_EVENT = 'attention.notify';

interface NotifyArgs {
  title?: string;
  body?: string;
  kind?: string;
  importance?: string;
  harnessSlug?: string | null;
}

export default function DesktopAttentionNotifier() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let desktopAllowed = false;
    void canUseContentOriginDesktopActions().then((allowed) => { desktopAllowed = allowed; });

    return onSyncBusEvent((ev) => {
      if (ev.name !== ATTENTION_NOTIFY_EVENT) return;
      const a = (ev.args ?? {}) as NotifyArgs;
      const title = a.title || 'Needs your attention';
      const body = a.body || '';

      // 1. In-app toast — always. urgent → error styling.
      if (a.importance === 'urgent') toast.error(title, { description: body });
      else toast(title, { description: body });

      // 2. Native OS notification — DISABLED BY DEFAULT (owner request
      // 2026-06-18: the OS popups were noisy and there was no toggle). The
      // in-app toast above already surfaces every attention push, so nothing
      // is lost — we just don't raise an OS-level popup. Opt back in per
      // webview by setting localStorage['papercusp:desktopOsNotifications']='1'.
      // (The Rust command is also absent until the desktop is rebuilt with
      // tauri-plugin-notification; the catch keeps that a no-op.)
      const osNotificationsEnabled =
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('papercusp:desktopOsNotifications') === '1';
      if (osNotificationsEnabled && desktopAllowed) {
        void (async () => {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_attention_notification', { title, body });
        })().catch(() => {
          /* command missing (pre-rebuild) or permission denied — toast stands */
        });
      }
    });
  }, []);

  return null;
}
