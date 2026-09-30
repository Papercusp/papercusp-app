/**
 * Formats an ISO timestamp as a compact relative-time string, e.g. `12s ago`,
 * `4m ago`, `2h ago`, `3d ago`. Used across the Substrate KPIs dashboard
 * (`/installed/kpis`) for "last fired" / "updated" labels.
 *
 * An invalid/unparseable ISO string returns `'—'` rather than `NaN ago` /
 * `Invalid Date ago`.
 */
export function formatRel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const ms = Math.max(0, Date.now() - then);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
