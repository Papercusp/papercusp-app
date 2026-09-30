'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { Bell, X, Trash2 } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '../harness/Tooltip';
import { Popover } from '../harness/Popover';
import { useConfirmDialog } from '../harness/useConfirmDialog';

interface ToastEntry {
  id: number;
  level: string;
  message: string;
  description: string | null;
  harnessSlug: string | null;
  createdAt: number;
  actionLabel: string | null;
  actionHref: string | null;
}

// Row shape from the harness_shared.toast_log Zero query (camelCase columns).
type ToastLogRow = {
  id: number;
  level: string;
  message: string;
  description?: string | null;
  harnessSlug?: string | null;
  createdAt: number;
  actionLabel?: string | null;
  actionHref?: string | null;
};

/**
 * Persistent toast history bell. Lives in the chrome (top-right of
 * pc-header). Click to open a dropdown panel of recent toasts pulled
 * from harness_shared.toast_log via /api/toast-log. Toasts are logged
 * automatically by ToastHistoryRecorder so this panel surfaces every
 * notification ever shown to the user, across reloads.
 *
 * The unread badge counts toasts created since the panel was last
 * opened (tracked in localStorage).
 */
export function NotificationCenter() {
  const [open, setOpen] = useQueryState('notifications', parseAsBoolean.withDefault(false));
  // Source of truth is `harness_shared.operator_user_profile.toast_last_seen_ms`
  // (PG, surfaced via /api/profile). localStorage is a per-device cache for
  // instant initial render; on mount we GET /api/profile and overwrite if PG
  // is newer (so the unread count is consistent across devices).
  const [lastSeen, setLastSeen] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return Number(localStorage.getItem(wsLocalKey('papercusp.toastLog.lastSeen')) ?? '0') || 0;
  });
  useEffect(() => {
    void fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        const pg = typeof p?.toast_last_seen_ms === 'number' ? p.toast_last_seen_ms : 0;
        if (pg > lastSeen) {
          setLastSeen(pg);
          try { localStorage.setItem(wsLocalKey('papercusp.toastLog.lastSeen'), String(pg)); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* offline / no session — localStorage already loaded */ });
    // Hydrate once on mount; deliberate empty deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Outside-click + ESC handled by Radix Popover via harness/Popover wrapper.

  // HarnessSyncProvider is now hoisted to root layout (2026-05-07,
  // resolved by Paperclip's harness-phases-const fix); useSyncQuery
  // works on every route. Server emits notifySyncInvalidate('toastLog.recent')
  // on every /api/toast-log POST → SSEAdapter invalidates → refetch.
  const sync = useSyncQuery<ToastLogRow>({
    queryName: 'toastLog.recent',
    args: { limit: 50 },
  });
  const toastRows = sync.data;
  const loading = sync.loading;
  const toasts = useMemo<ToastEntry[]>(
    () =>
      (toastRows ?? []).map((r) => ({
        id: r.id,
        level: r.level,
        message: r.message,
        description: r.description ?? null,
        harnessSlug: r.harnessSlug ?? null,
        createdAt: r.createdAt,
        actionLabel: r.actionLabel ?? null,
        actionHref: r.actionHref ?? null,
      })),
    [toastRows],
  );

  // Mark seen when the panel is opened. Updates the per-device cache for
  // instant subsequent renders + posts to PG so other devices see the new
  // last-seen on their next mount.
  useEffect(() => {
    if (!open) return;
    const now = Date.now();
    setLastSeen(now);
    try {
      localStorage.setItem(wsLocalKey('papercusp.toastLog.lastSeen'), String(now));
    } catch { /* ignore */ }
    void fetch('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toast_last_seen_ms: now }),
    }).catch(() => { /* offline — localStorage already saved */ });
  }, [open]);

  const unread = toasts.filter((t) => t.createdAt > lastSeen).length;
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const clearAll = useCallback(async () => {
    if (!await askConfirm({
      title: 'Clear all notification history?',
      body: 'Removes every entry from the notification log. This cannot be undone.',
      confirmLabel: 'Clear all',
      destructive: true,
    })) return;
    try {
      await fetch('/api/toast-log?all=1', { method: 'DELETE' });
    } catch { /* ignore */ }
  }, [askConfirm]);

  return (
    <div className="notif-center">
      {confirmEl}
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Notification history"
        tooltipLabel="Notification history"
        side="bottom"
        align="end"
        sideOffset={8}
        zIndex={1400}
        contentClassName="notif-panel"
        trigger={
          <button
            type="button"
            className="notif-bell"
            aria-label={`Notification history${unread ? ` (${unread} new)` : ''}`}
          >
            <Bell size={16} aria-hidden="true" />
            {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        }
      >
          <div className="notif-panel-head">
            <span>Notifications</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <Tooltip label="Clear all notification history">
                <button
                  type="button"
                  className="notif-panel-action"
                  onClick={clearAll}
                  aria-label="Clear all"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </Tooltip>
              <button
                type="button"
                className="notif-panel-action"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="notif-panel-body">
            {toasts.length === 0 ? (
              <div className="notif-empty">{loading ? 'Loading…' : 'No notifications yet.'}</div>
            ) : (
              <ul className="notif-list">
                {toasts.map((t) => (
                  <li key={t.id} className={`notif-item notif-item--${t.level}`}>
                    <div className="notif-item-head">
                      <span className={`notif-level notif-level--${t.level}`}>{t.level}</span>
                      <span className="notif-time">{formatRelative(t.createdAt)}</span>
                      {t.harnessSlug && <span className="notif-slug">{t.harnessSlug}</span>}
                    </div>
                    <div className="notif-message">{t.message}</div>
                    {t.description && <div className="notif-description">{t.description}</div>}
                    {t.actionLabel && t.actionHref && (
                      <a
                        href={t.actionHref}
                        className="notif-action"
                        target={t.actionHref.startsWith('/') ? undefined : '_blank'}
                        rel={t.actionHref.startsWith('/') ? undefined : 'noopener noreferrer'}
                        onClick={() => setOpen(false)}
                      >
                        {t.actionLabel} →
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
      </Popover>
    </div>
  );
}

export function formatRelative(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}


