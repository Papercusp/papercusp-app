/**
 * DemandPanel — the Knowledge view's missing-knowledge demand map
 * (self-learning-frontier-2026-06-12 P-010 / FB-04).
 *
 * Renders the negative-space miner's output (`learning.demand` sync query):
 * the docs/plans/memory searches agents ran that found NOTHING — recorded
 * demand for knowledge that doesn't exist yet, hottest first. Entries the
 * miner already filed as kind=change candidates carry a "filed" chip; until
 * the frontier arming gate (the plan's P-001) flips the miner's flag the map
 * is empty and the panel renders its nothing-mined state.
 *
 * Self-contained on purpose (own sync query + pc-demand__* styles, mirroring
 * BenchmarkTrend's self-carried idiom) so the LearningTab hotspot wiring
 * stays at two lines. Defensive about the snapshot shape — anything but the
 * expected {entries: []} renders the empty state, never a crash.
 */
import { useSyncQuery } from '@papercusp/sync';
import { SearchX, RefreshCw } from 'lucide-react';
import type { DemandSnapshot } from '@papercusp/operator-core/lib/negative-space/demand-read';

const SURFACE_TONE: Record<string, string> = {
  docs: 'var(--accent-strong, var(--accent))',
  memory: '#c4b5fd',
  plans: '#fcd34d',
};

function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DemandPanel() {
  const sync = useSyncQuery<DemandSnapshot>({ queryName: 'learning.demand', args: {}, staleTime: 30_000 });
  const snap = sync.data?.[0];
  const entries = Array.isArray(snap?.entries) ? snap.entries : [];

  return (
    <section className="pc-demand" aria-label="Missing-knowledge demand map">
      <div className="pc-demand__head">
        <h3 className="pc-demand__title">
          <SearchX size={14} aria-hidden /> Missing knowledge
        </h3>
        <span className="pc-demand__sub">searches that found nothing — recorded demand for docs, plans, and memories that don’t exist yet</span>
        <button
          type="button"
          className="pc-demand__refresh"
          aria-label="Reload the demand map"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="pc-demand__empty">
          Nothing mined yet. The negative-space miner aggregates zero-hit searches on a cadence
          {' '}— it ships dark until the frontier arming gate flips it on.
        </p>
      ) : (
        <>
          <p className="pc-demand__rollup">
            {snap!.totalEntries} missing-knowledge quer{snap!.totalEntries === 1 ? 'y' : 'ies'} ·{' '}
            {snap!.totalMisses} zero-hit search{snap!.totalMisses === 1 ? '' : 'es'} · {snap!.filedCount} filed
            {snap!.minedAt ? ` · mined ${dateShort(snap!.minedAt)}` : ''}
          </p>
          <ul className="pc-demand__list">
            {entries.map((e) => (
              <li key={`${e.surface}:${e.queryNorm}`} className="pc-demand__row" title={e.exampleQuery}>
                <span className="pc-demand__surface" style={{ background: SURFACE_TONE[e.surface] ?? '#7f9bb4' }}>
                  {e.surface}
                </span>
                <span className="pc-demand__query">{e.queryNorm}</span>
                <span className="pc-demand__meta">
                  <span title="Zero-hit searches">{e.missCount}×</span>
                  <span title="Distinct agents that missed">{e.distinctAgents} agent{e.distinctAgents === 1 ? '' : 's'}</span>
                  <span className="pc-demand__age" title="Last missed">{dateShort(e.lastMissedAt)}</span>
                  {e.candidateImprovementId ? (
                    <span className="pc-demand__filed" title={`Filed as ${e.candidateImprovementId}`}>filed</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{`
        .pc-demand { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-demand__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-demand__title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 650; }
        .pc-demand__sub { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-demand__refresh { display: inline-flex; align-items: center; border: none; background: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 2px; }
        .pc-demand__refresh:disabled { opacity: 0.5; cursor: default; }
        .pc-demand__empty { margin: 8px 0 2px; font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-demand__rollup { margin: 6px 0 4px; font-size: 11px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-demand__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-demand__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-demand__surface { flex: none; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: #06121a; border-radius: 4px; padding: 1px 5px; }
        .pc-demand__query { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
        .pc-demand__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-demand__age { opacity: 0.85; }
        .pc-demand__filed { color: #34d399; font-weight: 650; }
      `}</style>
    </section>
  );
}

export default DemandPanel;
