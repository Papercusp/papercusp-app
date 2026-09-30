/**
 * Tool-usage glance (usage-insights-tab-2026-06-22 P-003/P-004) — the dev-rail
 * panel over `harness_shared.tool_invocations` telemetry. Three sub-views, all
 * URL-selected via nuqs (NO useState for selection, so the panel is deep-linkable
 * + agent-driveable via ui:get_state/ui:dispatch):
 *   - hot:      top tools by TOKEN COST (total served bytes) — the token-opt target list.
 *   - adoption: served-format mix on the MCP transport — the compact-% (toon/csv vs
 *               json), the real D-002 token-opt-adoption number once the re-encode is live.
 *   - batching: repeat-within-spawn clusters — bulk-conversion candidates (items[]).
 *
 * Reads dev.telemetry + dev.toolFormatAdoption via @papercusp/sync (useSyncQuery,
 * SSE-primary on desktop — P-004); read-only/poll-light (staleTime + manual refresh,
 * no write-path invalidation). Lazy-mounted by DevAdminRail only while its section is
 * open. Primitives are the shared panel-kit + rail CSS classes (no hand-rolled UI;
 * no native <select>/<table> — the design-primitive lint bans those).
 */
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { PanelBar, PanelState } from '../panel-kit';

interface TelemetryEntry {
  tool_name: string;
  call_count: number;
  error_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  total_bytes: number;
  avg_bytes: number | null;
  repeat_within_spawn: number;
}
interface FormatRow {
  format: string;
  n: number;
}

const WINDOWS = ['24h', '7d', '14d'] as const;
type Win = (typeof WINDOWS)[number];
const WIN_HOURS: Record<Win, number> = { '24h': 24, '7d': 168, '14d': 336 };

const VIEWS = ['hot', 'adoption', 'batching'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  hot: 'Hot tools',
  adoption: 'Format adoption',
  batching: 'Batching waste',
};
const COMPACT_FORMATS = new Set(['toon', 'csv', 'tsv']);

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtMs(n: number | null): string {
  return n == null ? '—' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

export default function ToolUsagePanel({ active }: { active: boolean }) {
  const [win, setWin] = useQueryState('tuWin', parseAsStringLiteral(WINDOWS).withDefault('24h'));
  const [view, setView] = useQueryState('tuView', parseAsStringLiteral(VIEWS).withDefault('hot'));
  const hours = WIN_HOURS[win];

  const tel = useSyncQuery<TelemetryEntry>({
    queryName: 'dev.telemetry',
    args: { hours, limit: 100 },
    enabled: active,
    staleTime: 30_000,
  });
  const adoption = useSyncQuery<FormatRow>({
    queryName: 'dev.toolFormatAdoption',
    args: { hours },
    enabled: active && view === 'adoption',
    staleTime: 30_000,
  });

  const entries = tel.data ?? [];
  const refresh = () => {
    tel.invalidate();
    adoption.invalidate();
  };

  const hot = [...entries].sort((a, b) => b.total_bytes - a.total_bytes).slice(0, 30);
  const batching = entries
    .filter((e) => e.repeat_within_spawn > 0)
    .sort((a, b) => b.repeat_within_spawn - a.repeat_within_spawn)
    .slice(0, 30);

  const fmtRows = adoption.data ?? [];
  const totalFmt = fmtRows.reduce((s, r) => s + r.n, 0);
  const compact = fmtRows.filter((r) => COMPACT_FORMATS.has(r.format)).reduce((s, r) => s + r.n, 0);
  const compactPct = totalFmt ? Math.round((compact / totalFmt) * 100) : 0;

  return (
    <div className="pcdar-panel" data-testid="tool-usage-panel">
      <PanelBar label="Tool usage" fetching={tel.fetching || adoption.fetching} onRefresh={refresh}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            data-testid={`tu-win-${w}`}
            aria-pressed={win === w}
            className={`pcdar-pill${win === w ? ' is-warn' : ''}`}
            onClick={() => void setWin(w)}
          >
            {w}
          </button>
        ))}
      </PanelBar>

      <div className="pcdar-panel__bar" role="tablist" aria-label="Tool-usage view">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            data-testid={`tu-view-${v}`}
            className={`pcdar-pill${view === v ? ' is-warn' : ''}`}
            onClick={() => void setView(v)}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
        <span className="pcdar-panel__bar-spacer" />
      </div>

      <PanelState
        loading={tel.loading && entries.length === 0}
        error={tel.error}
        empty={!tel.loading && entries.length === 0}
        emptyHint="No tool invocations in this window."
      />

      {view === 'hot' &&
        hot.map((e) => (
          <div key={e.tool_name} className="pcdar-row" data-testid="tu-hot-row">
            <div className="pcdar-row__main">
              <div className="pcdar-row__title">{e.tool_name}</div>
              <div className="pcdar-row__sub">
                {e.call_count} calls · {fmtBytes(e.total_bytes)} ({fmtBytes(e.avg_bytes)} avg) · p50{' '}
                {fmtMs(e.p50_ms)} / p95 {fmtMs(e.p95_ms)}
                {e.error_count > 0 ? ` · ${e.error_count} err` : ''}
              </div>
            </div>
          </div>
        ))}

      {view === 'adoption' && (
        <>
          <div className="pcdar-kv">
            <span className="pcdar-kv__k">compact %</span>
            <span className="pcdar-kv__v">
              {adoption.loading && totalFmt === 0
                ? '…'
                : `${compactPct}% — ${compact}/${totalFmt} mcp calls served compact`}
            </span>
          </div>
          {fmtRows.map((r) => (
            <div key={r.format} className="pcdar-row" data-testid="tu-fmt-row">
              <div className="pcdar-row__main">
                <div className="pcdar-row__sub">
                  {r.format} · {r.n} · {totalFmt ? Math.round((r.n / totalFmt) * 100) : 0}%
                </div>
              </div>
              <span className={`pcdar-pill${COMPACT_FORMATS.has(r.format) ? ' is-good' : ''}`}>
                {COMPACT_FORMATS.has(r.format) ? 'compact' : 'verbose'}
              </span>
            </div>
          ))}
        </>
      )}

      {view === 'batching' &&
        (batching.length === 0 ? (
          <div className="pcdar-panel__empty">No repeat-within-spawn waste in this window.</div>
        ) : (
          batching.map((e) => (
            <div key={e.tool_name} className="pcdar-row" data-testid="tu-batch-row">
              <div className="pcdar-row__main">
                <div className="pcdar-row__title">{e.tool_name}</div>
                <div className="pcdar-row__sub">
                  {e.repeat_within_spawn} repeats within a spawn · {e.call_count} calls → convert to bulk items[]
                </div>
              </div>
              <span className="pcdar-pill is-warn">bulk?</span>
            </div>
          ))
        ))}
    </div>
  );
}
