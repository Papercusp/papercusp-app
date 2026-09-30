'use client';

import { useCallback, useEffect, useState } from 'react';

interface Usage {
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface RoleSummary extends Usage {
  role: string;
  avgCostUsd: number;
  avgDurationMs: number;
}

interface RecentRun {
  runId: string;
  role: string;
  featureId?: string | null;
  ts: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface FeatureSummary {
  featureId: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  avgCostUsd: number;
  byRole: Record<string, number>;
}

interface Props {
  slug: string;
  onClose: () => void;
}

const ROLE_COLOR: Record<string, string> = {
  planner: '#3b82f6',
  worker: '#10b981',
  validator: '#a855f7',
  orchestrator: '#f59e0b',
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export default function UsagePanel({ slug, onClose }: Props) {
  const [data, setData] = useState<{ totals: Usage; byRole: RoleSummary[]; byFeature?: FeatureSummary[]; recent: RecentRun[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/usage`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch (e) {
      setError(String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '80vw', maxWidth: 1100, height: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Usage — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>aggregated from .papercusp/logs/*.jsonl</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>auto-refresh 5s</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        {error && <div style={{ padding: '1rem', color: '#ef4444' }}>error: {error}</div>}

        {!data ? (
          <div style={{ padding: '2rem', color: '#9ca3af' }}>loading…</div>
        ) : (
          <div style={{ padding: '1rem', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Totals */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>Totals</div>
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                <Stat label="runs" value={data.totals.runs.toLocaleString()} />
                <Stat label="cost" value={fmtCost(data.totals.costUsd)} />
                <Stat label="input tokens" value={data.totals.inputTokens.toLocaleString()} />
                <Stat label="output tokens" value={data.totals.outputTokens.toLocaleString()} />
                <Stat label="total duration" value={fmtDuration(data.totals.durationMs)} />
              </div>
            </div>

            {/* Per-role table */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                Per-role breakdown — {data.byRole.length === 0 ? 'no runs yet' : `${data.byRole.length} roles`}
              </div>
              {data.byRole.length > 0 && (
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                      <th style={{ padding: '0.35rem 0.6rem' }}>Role</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Runs</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Total cost</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Avg cost</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Input tok</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Output tok</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Total dur</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Avg dur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byRole.map((r) => (
                      <tr key={r.role} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={{ padding: '0.35rem 0.6rem' }}>
                          <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.55rem', borderRadius: 3, background: ROLE_COLOR[r.role] ?? '#374151', color: 'white', fontWeight: 600 }}>
                            {r.role}
                          </span>
                        </td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>{r.runs}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(r.costUsd)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', fontFamily: 'monospace', color: '#9ca3af' }}>{fmtCost(r.avgCostUsd)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: '#9ca3af' }}>{r.inputTokens.toLocaleString()}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: '#9ca3af' }}>{r.outputTokens.toLocaleString()}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>{fmtDuration(r.durationMs)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: '#9ca3af' }}>{fmtDuration(r.avgDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Per-feature breakdown */}
            {data.byFeature && data.byFeature.length > 0 && (
              <div>
                <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                  Per-feature breakdown — {data.byFeature.length} features
                  <span style={{ textTransform: 'none', marginLeft: '0.5rem', color: '#6b7280', letterSpacing: 0 }}>
                    (only includes runs invoked with FEATURE_ID; older untagged runs roll up under Per-role only)
                  </span>
                </div>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                      <th style={{ padding: '0.35rem 0.6rem' }}>Feature</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Runs</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Total cost</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>Avg cost</th>
                      <th style={{ padding: '0.35rem 0.6rem' }}>Per-role cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byFeature.map((f) => (
                      <tr key={f.featureId} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={{ padding: '0.35rem 0.6rem', fontFamily: 'ui-monospace, monospace' }}>{f.featureId}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>{f.runs}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(f.costUsd)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', fontFamily: 'monospace', color: '#9ca3af' }}>{fmtCost(f.avgCostUsd)}</td>
                        <td style={{ padding: '0.35rem 0.6rem' }}>
                          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                            {Object.entries(f.byRole).sort((a, b) => b[1] - a[1]).map(([role, cost]) => (
                              <span key={role} style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: ROLE_COLOR[role] ?? '#374151', color: 'white' }}>
                                {role.slice(0, 4)} {fmtCost(cost)}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recent runs */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                Recent runs — {data.recent.length === 0 ? 'none' : `last ${data.recent.length}`}
              </div>
              {data.recent.length > 0 && (
                <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                      <th style={{ padding: '0.3rem 0.5rem' }}>When</th>
                      <th style={{ padding: '0.3rem 0.5rem' }}>Role</th>
                      <th style={{ padding: '0.3rem 0.5rem' }}>Run ID</th>
                      <th style={{ padding: '0.3rem 0.5rem', textAlign: 'right' }}>Cost</th>
                      <th style={{ padding: '0.3rem 0.5rem', textAlign: 'right' }}>In</th>
                      <th style={{ padding: '0.3rem 0.5rem', textAlign: 'right' }}>Out</th>
                      <th style={{ padding: '0.3rem 0.5rem', textAlign: 'right' }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => (
                      <tr key={r.runId} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={{ padding: '0.3rem 0.5rem', color: '#9ca3af' }}>{fmtTs(r.ts)}</td>
                        <td style={{ padding: '0.3rem 0.5rem' }}>
                          <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: ROLE_COLOR[r.role] ?? '#374151', color: 'white' }}>
                            {r.role}
                          </span>
                        </td>
                        <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace', color: '#6b7280' }}>{r.runId}</td>
                        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCost(r.costUsd)}</td>
                        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', color: '#9ca3af' }}>{r.inputTokens.toLocaleString()}</td>
                        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', color: '#9ca3af' }}>{r.outputTokens.toLocaleString()}</td>
                        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right' }}>{fmtDuration(r.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <span style={{ fontSize: '0.65rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '1.25rem', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{value}</span>
    </div>
  );
}
