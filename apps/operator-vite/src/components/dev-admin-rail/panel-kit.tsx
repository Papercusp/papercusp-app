/**
 * Shared bits for the dev-admin-rail glance panels (P-004..P-008).
 * Kept tiny + dependency-free so each panel stays a thin read view.
 */
import { RotateCw } from 'lucide-react';

/** "12s ago" / "4m ago" / "2h ago" / "3d ago" from an epoch-ms timestamp. */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** A panel header bar: an uppercase label, a spacer, and a refresh button. */
export function PanelBar({
  label,
  fetching,
  onRefresh,
  children,
}: {
  label: string;
  fetching?: boolean;
  onRefresh?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="pcdar-panel__bar">
      <span className="pcdar-panel__bar-label">{label}</span>
      <span className="pcdar-panel__bar-spacer" />
      {children}
      {onRefresh && (
        <button
          type="button"
          className={`pcdar-panel__refresh${fetching ? ' is-spinning' : ''}`}
          onClick={onRefresh}
          disabled={fetching}
          aria-label={`Refresh ${label}`}
        >
          <RotateCw size={12} aria-hidden="true" />
          {fetching ? 'Refreshing…' : 'Refresh'}
        </button>
      )}
    </div>
  );
}

/** Loading / empty / error placeholder for a glance panel body. */
export function PanelState({
  loading,
  error,
  empty,
  emptyHint,
}: {
  loading?: boolean;
  error?: Error | null;
  empty?: boolean;
  emptyHint?: string;
}) {
  if (error) {
    return <div className="pcdar-panel__error">Failed to load: {error.message}</div>;
  }
  if (loading) {
    return <div className="pcdar-panel__empty">Loading…</div>;
  }
  if (empty) {
    return <div className="pcdar-panel__empty">{emptyHint ?? 'Nothing to show.'}</div>;
  }
  return null;
}
