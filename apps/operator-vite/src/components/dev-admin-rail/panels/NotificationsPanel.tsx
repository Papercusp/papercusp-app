/**
 * Notifications / errors (P-004) — the recent toast+error stream, the first stop
 * for "why did the app just error?". Reads the existing `toastLog.recent` sync
 * query (live: the server emits notifySyncInvalidate('toastLog.recent') on every
 * toast write, so this refreshes on its own). Newest-first, dismissible (per-row
 * local hide + clear-all via the existing DELETE /api/toast-log endpoint).
 */
import { useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { X, Trash2 } from 'lucide-react';
import { PanelBar, PanelState, formatRelative } from '../panel-kit';
import { Tooltip } from '@/app/harness/Tooltip';

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

export default function NotificationsPanel({ active }: { active: boolean }) {
  const sync = useSyncQuery<ToastLogRow>({
    queryName: 'toastLog.recent',
    args: { limit: 50 },
    enabled: active,
  });
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());

  const rows = useMemo(
    () => (sync.data ?? []).filter((r) => !hidden.has(r.id)).sort((a, b) => b.createdAt - a.createdAt),
    [sync.data, hidden],
  );
  const errorCount = useMemo(
    () => (sync.data ?? []).filter((r) => r.level === 'error' && !hidden.has(r.id)).length,
    [sync.data, hidden],
  );

  const dismiss = (id: number) => setHidden((prev) => new Set(prev).add(id));
  const clearAll = async () => {
    try {
      await fetch('/api/toast-log?all=1', { method: 'DELETE' });
    } catch {
      /* offline — the sync query will simply keep showing rows */
    }
    setHidden(new Set());
  };

  return (
    <div className="pcdar-panel">
      <PanelBar label="Notifications" fetching={sync.fetching} onRefresh={sync.invalidate}>
        {errorCount > 0 && <span className="pcdar-pill is-bad">{errorCount} err</span>}
        {(sync.data?.length ?? 0) > 0 && (
          <Tooltip label="Clear all notification history">
            <button
              type="button"
              className="pcdar-panel__refresh"
              onClick={clearAll}
              aria-label="Clear all notifications"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </PanelBar>
      <PanelState
        loading={sync.loading}
        error={sync.error}
        empty={rows.length === 0}
        emptyHint="No notifications yet."
      />
      {rows.map((t) => (
        <div key={t.id} className="pcdar-row">
          <span
            className={`pcdar-dot ${t.level === 'error' ? 'is-down' : t.level === 'warning' ? '' : 'is-up'}`}
            aria-hidden="true"
          />
          <div className="pcdar-row__main">
            <div className="pcdar-row__title" title={t.message}>
              {t.message}
            </div>
            <div className="pcdar-row__sub">
              {t.level}
              {t.harnessSlug ? ` · ${t.harnessSlug}` : ''} · {formatRelative(t.createdAt)}
            </div>
            {t.description && (
              <div className="pcdar-row__sub" title={t.description}>
                {t.description}
              </div>
            )}
          </div>
          <button
            type="button"
            className="pcdar__iconbtn"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            style={{ width: 22, height: 22 }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
