'use client';
/**
 * Harness Gym operator dashboard (P-024 + the gym-ui-handoff surfaces).
 *
 * One instrument panel over the gym control plane (`/api/gym/*`, D-020): pick a harness,
 * review the proposer's suggested prompt edits as a diff and accept/reject (the headline),
 * edit the per-role prompts + judge rubric, drive the per-harness autoloop, and read the
 * run analytics (cycles / variants / compare / frontier). All user-meaningful state is in
 * the URL via nuqs (CLAUDE.md) so it deep-links and the agent ui:* surface can drive it.
 *
 * Visual craft (the Pareto scatter, spacing, motion, the richer Monaco/md editors named in
 * the handoff) is a focused designer pass on top of this — the structure, data-binding, and
 * the accept→promote flow are complete and wired. Brief: lib/gym/DASHBOARD-MOCKUP.md.
 */
import { useCallback, useEffect, useMemo, useState, lazy, Suspense, Component, type ReactNode } from 'react';
import {
  parseAsString,
  parseAsStringEnum,
  useQueryState,
} from 'nuqs';
import { diffLines } from 'diff';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';
// Points the Monaco AMD loader at our local mirror. Without it Monaco fetches
// ~4MB from jsdelivr on first mount (cdn-egress-fixes-2026-08-02 P-001).
import '@/app/_components/monaco-runtime';
// The compare table is lifted to a shared eval-viz component (P-021 / BRIEF 10),
// reused on the Evaluation surface; the gym renders the same one here.
import { Compare } from '../eval-viz';
import { Select } from '../harness/Select';

// Monaco DiffEditor (the gym-ui-handoff's named merge surface) — lazy so it never weighs on
// first paint, and wrapped (below) in an error boundary that falls back to the robust jsdiff
// line-diff if Monaco can't load/render in the WebKitGTK Tauri webview.
const MonacoDiffEditor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.DiffEditor })));

class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ── API types (mirror lib/gym/control-plane.ts + read-api.ts) ──────────────────
interface HarnessRow { harnessSlug: string; pendingCount: number; lastCycle: number | null; autoloop: { enabled: boolean; status: string; budgetUsd: number | null; spentUsd: number } | null }
interface Proposal { id: string; cycle: number; variantId: string | null; role: string; originalMd: string | null; proposedMd: string; rationale: string | null; devAnchorDelta: number | null; costDelta: number | null; probeStatus: string | null; status: string }
interface PromptsResp { judgeRubric: string | null; roles: Record<string, string>; editableKeys: string[] }
interface AutoloopResp { autoloop: { enabled: boolean; status: string; budgetUsd: number | null; spentUsd: number; lastCycle: number | null } | null; configured: boolean }
interface CycleRow { cycle: number; parentId: string | null; candidateId: string | null; decision: string | null }
interface CompareRow { taskId: string; aComposite: number | null; bComposite: number | null; delta: number | null }
interface VariantRow { variantId: string; label?: string; parentId?: string | null; onFrontier?: boolean }

const TABS = ['proposals', 'prompts', 'autoloop', 'cycles', 'variants', 'compare', 'frontier'] as const;
type Tab = (typeof TABS)[number];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/gym${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg-2)' };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 };
const inputStyle: React.CSSProperties = { ...mono, background: 'var(--bg-deeper)', color: 'inherit', border: '1px solid var(--border)', borderRadius: 6 };
const dangerText = 'var(--bad)';
const goodText = 'var(--good)';

const cycleColumns: ColumnDef<CycleRow>[] = [
  { key: 'cycle', header: '#', width: 0.6, toCopyText: (c) => String(c.cycle), render: ({ row }) => row.cycle },
  { key: 'parent', header: 'Parent', width: 1.5, toCopyText: (c) => c.parentId ?? '—', render: ({ row }) => row.parentId ?? '—' },
  { key: 'candidate', header: 'Candidate', width: 1.5, toCopyText: (c) => c.candidateId ?? '—', render: ({ row }) => row.candidateId ?? '—' },
  {
    key: 'decision',
    header: 'Decision',
    width: 1,
    toCopyText: (c) => c.decision ?? '—',
    render: ({ row }) => <span style={{ color: row.decision === 'accept' ? goodText : dangerText }}>{row.decision ?? '—'}</span>,
  },
];

const variantColumns: ColumnDef<VariantRow>[] = [
  { key: 'variant', header: 'Variant', width: 1.6, toCopyText: (v) => v.variantId, render: ({ row }) => row.variantId },
  { key: 'parent', header: 'Parent', width: 1.4, toCopyText: (v) => v.parentId ?? '—', render: ({ row }) => row.parentId ?? '—' },
  { key: 'frontier', header: 'Frontier', width: 0.8, toCopyText: (v) => v.onFrontier ? 'yes' : '', render: ({ row }) => row.onFrontier ? '✓' : '' },
];

export default function GymDashboard() {
  const t = useLexicon();
  const [slug, setSlug] = useQueryState('gymSlug', parseAsString.withDefault(''));
  const [tab, setTab] = useQueryState('gymTab', parseAsStringEnum<Tab>([...TABS]).withDefault('proposals'));

  const [harnesses, setHarnesses] = useState<HarnessRow[]>([]);
  const [harnessErr, setHarnessErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ harnesses: HarnessRow[] }>('/harnesses')
      .then(({ harnesses: rows }) => { if (live) { setHarnesses(rows); setHarnessErr(null); if (!slug && rows[0]) void setSlug(rows[0].harnessSlug); } })
      .catch((e) => { if (live) setHarnessErr(String(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, color: 'var(--fg)', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Harness Gym</h1>
        <label style={{ ...mono, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('pot', { lower: true })}
          <Select
            value={slug}
            onChange={(value) => void setSlug(value)}
            testId="gym-harness-select"
            ariaLabel={`Select ${t('pot', { lower: true })}`}
            triggerStyle={{ ...mono, padding: '3px 6px' }}
            options={harnesses.map((h) => ({
              value: h.harnessSlug,
              label: `${h.harnessSlug}${h.pendingCount ? ` (${h.pendingCount})` : ''}`,
            }))}
            placeholder="select"
          />
        </label>
        {harnessErr && <span style={{ color: dangerText, ...mono }} data-testid="gym-harness-error">{harnessErr}</span>}
      </header>

      <nav role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            data-testid={`gym-tab-${t}`}
            onClick={() => void setTab(t)}
            style={{
              ...mono, cursor: 'pointer', padding: '4px 10px', borderRadius: 6,
              border: '1px solid ' + (tab === t ? 'var(--accent-strong)' : 'var(--border)'),
              background: tab === t ? 'color-mix(in srgb, var(--accent), transparent 82%)' : 'transparent',
              color: tab === t ? 'var(--accent-soft)' : 'inherit',
            }}
          >
            {t}
          </button>
        ))}
      </nav>

      {!slug ? (
        <div style={card} data-testid="gym-empty">Pick a {t('pot', { lower: true })} to begin.</div>
      ) : (
        <main>
          {tab === 'proposals' && <ProposalsTab slug={slug} />}
          {tab === 'prompts' && <PromptsTab slug={slug} />}
          {tab === 'autoloop' && <AutoloopTab slug={slug} />}
          {tab === 'cycles' && <CyclesTab slug={slug} />}
          {tab === 'variants' && <VariantsTab slug={slug} />}
          {tab === 'compare' && <CompareTab slug={slug} />}
          {tab === 'frontier' && <FrontierTab slug={slug} />}
        </main>
      )}
    </div>
  );
}

// ── Proposals (the headline: proposer-diff review → accept/reject → promote) ────
/** Status pill colour: accepted=good, rejected=bad, pending/other=accent. */
function proposalStatusColor(status: string): string {
  return status === 'accepted' ? goodText : status === 'rejected' ? dangerText : 'var(--accent-soft)';
}

function ProposalsTab({ slug }: { slug: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selId, setSelId] = useQueryState('proposalId', parseAsString.withDefault(''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    // P-020: default to ALL statuses. The gym auto-decides every proposal (owner mandate
    // 2026-07-19 — "no human in the loop"), so a pending-only view hides EVERY challenger the
    // gym produces. Show accepted/rejected/pending so the auto-promoted winners are visible;
    // accept/reject stays available for any row still pending (a manual/attended run).
    api<{ proposals: Proposal[] }>(`/${slug}/proposals?status=all`)
      .then((r) => {
        // Pending first (still actionable), then the decided history in the API's order.
        const rank = (p: Proposal) => (p.status === 'pending' ? 0 : 1);
        setProposals([...r.proposals].sort((a, b) => rank(a) - rank(b)));
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  const sel = useMemo(() => proposals.find((p) => p.id === selId) ?? proposals[0], [proposals, selId]);
  const pendingCount = useMemo(() => proposals.filter((p) => p.status === 'pending').length, [proposals]);

  const decide = async (decision: 'accept' | 'reject') => {
    if (!sel) return;
    setBusy(true); setErr(null);
    try {
      await api(`/${slug}/${decision}`, { method: 'POST', body: JSON.stringify({ id: sel.id }) });
      await setSelId('');
      load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12 }}>
      <div style={card} data-testid="gym-proposal-list">
        <div style={{ ...mono, opacity: 0.7, marginBottom: 6 }} data-testid="gym-proposal-count">
          proposals ({proposals.length}){pendingCount ? ` · ${pendingCount} pending` : ''}
        </div>
        {proposals.length === 0 && <div style={{ ...mono, opacity: 0.6 }}>No proposals yet. Run the autoloop to generate suggestions.</div>}
        {proposals.map((p) => (
          <button key={p.id} onClick={() => void setSelId(p.id)} data-testid="gym-proposal-row"
            style={{ ...mono, display: 'block', width: '100%', textAlign: 'left', padding: 6, marginBottom: 4, borderRadius: 6, cursor: 'pointer',
              border: '1px solid ' + (sel?.id === p.id ? 'var(--accent-strong)' : 'var(--border)'), background: sel?.id === p.id ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'transparent', color: 'inherit' }}>
            <div>cycle {p.cycle} · <b>{p.role}</b> · <span style={{ color: proposalStatusColor(p.status) }}>{p.status}</span></div>
            <div style={{ opacity: 0.7 }}>devΔ {fmt(p.devAnchorDelta)} · costΔ {fmt(p.costDelta)} · probe {p.probeStatus ?? '—'}</div>
          </button>
        ))}
      </div>
      <div style={card}>
        {err && <div style={{ color: dangerText, ...mono, marginBottom: 8 }} data-testid="gym-proposal-error">{err}</div>}
        {!sel ? (
          <div style={{ ...mono, opacity: 0.6 }}>Select a proposal to review its diff.</div>
        ) : (
          <div>
            <div style={{ ...mono, marginBottom: 8 }}>
              <b>{sel.role}</b> — cycle {sel.cycle}{sel.variantId ? ` · ${sel.variantId}` : ''} · <span style={{ color: proposalStatusColor(sel.status) }} data-testid="gym-proposal-status">{sel.status}</span>
            </div>
            {sel.rationale && <div style={{ ...mono, opacity: 0.85, marginBottom: 8, whiteSpace: 'pre-wrap' }}>“{sel.rationale}”</div>}
            <ProposalDiff original={sel.originalMd ?? ''} proposed={sel.proposedMd} />
            {sel.status === 'pending' ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button disabled={busy} onClick={() => decide('accept')} data-testid="gym-accept"
                  style={{ ...mono, cursor: 'pointer', padding: '6px 14px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--good), transparent 55%)', background: 'color-mix(in srgb, var(--good), transparent 84%)', color: 'var(--good)' }}>
                  Accept → promote
                </button>
                <button disabled={busy} onClick={() => decide('reject')} data-testid="gym-reject"
                  style={{ ...mono, cursor: 'pointer', padding: '6px 14px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--bad), transparent 55%)', background: 'transparent', color: 'var(--bad)' }}>
                  Reject
                </button>
              </div>
            ) : (
              <div style={{ ...mono, opacity: 0.75, marginTop: 10 }} data-testid="gym-proposal-decided">
                Auto-{sel.status} by the loop — {sel.status === 'accepted' ? 'promoted to the live prompt.' : 'not promoted.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A line-level source diff (original → proposed). jsdiff, robust in WebKitGTK. */
function DiffView({ original, proposed }: { original: string; proposed: string }) {
  const parts = useMemo(() => diffLines(original, proposed), [original, proposed]);
  return (
    <pre data-testid="gym-diff" style={{ ...mono, margin: 0, padding: 10, borderRadius: 6, background: 'var(--bg-deeper)', overflowX: 'auto', maxHeight: 320 }}>
      {parts.map((p, i) => (
        <div key={i} style={{ background: p.added ? 'color-mix(in srgb, var(--good), transparent 86%)' : p.removed ? 'color-mix(in srgb, var(--bad), transparent 86%)' : 'transparent', color: p.added ? goodText : p.removed ? dangerText : 'inherit', whiteSpace: 'pre-wrap' }}>
          {p.value.replace(/\n$/, '').split('\n').map((l, j) => <div key={j}>{p.added ? '+ ' : p.removed ? '- ' : '  '}{l}</div>)}
        </div>
      ))}
    </pre>
  );
}

/** The proposer diff: Monaco side-by-side DiffEditor when it loads, else the jsdiff line-diff. */
function ProposalDiff({ original, proposed }: { original: string; proposed: string }) {
  const fallback = <DiffView original={original} proposed={proposed} />;
  return (
    <div data-testid="gym-diff-wrap" style={{ height: 320, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <LoadBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <MonacoDiffEditor
            height="320px"
            language="markdown"
            theme="vs-dark"
            original={original}
            modified={proposed}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, lineNumbers: 'off' }}
          />
        </Suspense>
      </LoadBoundary>
    </div>
  );
}

// ── Prompts editor (judge rubric + each role) ──────────────────────────────────
function PromptsTab({ slug }: { slug: string }) {
  const [data, setData] = useState<PromptsResp | null>(null);
  const [role, setRole] = useQueryState('role', parseAsString.withDefault('judge'));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api<PromptsResp>(`/${slug}/prompts`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(String(e)));
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  const current = useMemo(() => (!data ? '' : role === 'judge' ? data.judgeRubric ?? '' : data.roles[role] ?? ''), [data, role]);
  useEffect(() => { setDraft(current); setSaved(false); }, [current, role]);

  const keys = data?.editableKeys ?? ['judge'];

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api(`/${slug}/prompts`, { method: 'POST', body: JSON.stringify({ role, md: draft }) });
      setSaved(true); load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12 }}>
      <div style={card} data-testid="gym-prompt-roles">
        {keys.map((k) => (
          <button key={k} onClick={() => void setRole(k)} data-testid={`gym-role-${k}`}
            style={{ ...mono, display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', marginBottom: 3, borderRadius: 6, cursor: 'pointer',
              border: '1px solid ' + (role === k ? 'var(--accent-strong)' : 'var(--border)'), background: role === k ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'transparent', color: 'inherit' }}>
            {k === 'judge' ? 'judge (rubric)' : k}
          </button>
        ))}
      </div>
      <div style={card}>
        {err && <div style={{ color: dangerText, ...mono, marginBottom: 8 }} data-testid="gym-prompt-error">{err}</div>}
        <textarea value={draft} onChange={(e) => { setDraft(e.target.value); setSaved(false); }} data-testid="gym-prompt-editor"
          spellCheck={false}
          style={{ ...inputStyle, width: '100%', minHeight: 320, padding: 10, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button disabled={busy || draft === current} onClick={save} data-testid="gym-prompt-save"
            style={{ ...mono, cursor: 'pointer', padding: '6px 14px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 55%)', background: 'color-mix(in srgb, var(--accent), transparent 84%)', color: 'var(--accent-soft)' }}>
            Save {role === 'judge' ? 'rubric' : role}
          </button>
          {saved && <span style={{ ...mono, color: goodText }} data-testid="gym-prompt-saved">saved ✓</span>}
        </div>
      </div>
    </div>
  );
}

// ── Autoloop control ───────────────────────────────────────────────────────────
function AutoloopTab({ slug }: { slug: string }) {
  const [cfg, setCfg] = useState<AutoloopResp | null>(null);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api<AutoloopResp>(`/${slug}/autoloop`).then((d) => { setCfg(d); setBudget(d.autoloop?.budgetUsd != null ? String(d.autoloop.budgetUsd) : ''); setErr(null); }).catch((e) => setErr(String(e)));
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api(`/${slug}/autoloop`, { method: 'POST', body: JSON.stringify(body) }); load(); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const a = cfg?.autoloop;
  return (
    <div style={{ ...card, maxWidth: 480 }}>
      {err && <div style={{ color: dangerText, ...mono, marginBottom: 8 }} data-testid="gym-autoloop-error">{err}</div>}
      <div style={{ ...mono, marginBottom: 10 }} data-testid="gym-autoloop-status">
        status: <b>{a?.status ?? 'idle'}</b> · enabled: <b>{a?.enabled ? 'yes' : 'no'}</b><br />
        budget: {a?.budgetUsd != null ? `$${a.budgetUsd}` : '∞'} · spent: ${Number(a?.spentUsd ?? 0).toFixed(2)} · last cycle: {a?.lastCycle ?? '—'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => post({ enabled: !a?.enabled })} data-testid="gym-autoloop-toggle"
          style={{ ...mono, cursor: 'pointer', padding: '6px 14px', borderRadius: 6, border: `1px solid color-mix(in srgb, ${a?.enabled ? 'var(--bad)' : 'var(--good)'}, transparent 55%)`, background: `color-mix(in srgb, ${a?.enabled ? 'var(--bad)' : 'var(--good)'}, transparent 84%)`, color: a?.enabled ? dangerText : goodText }}>
          {a?.enabled ? 'Disable' : 'Enable'} autoloop
        </button>
        <label style={{ ...mono, display: 'flex', alignItems: 'center', gap: 4 }}>
          budget $
          <input value={budget} onChange={(e) => setBudget(e.target.value)} data-testid="gym-autoloop-budget" inputMode="decimal"
            style={{ ...inputStyle, width: 80, padding: '3px 6px' }} />
        </label>
        <button disabled={busy} onClick={() => post({ budgetUsd: budget.trim() === '' ? null : Number(budget) })} data-testid="gym-autoloop-save-budget"
          style={{ ...mono, cursor: 'pointer', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit' }}>
          Set budget
        </button>
      </div>
      <p style={{ ...mono, opacity: 0.6, marginTop: 10 }}>The loop is human-gated: it proposes + scores prompt edits and records them under Proposals for you to accept; it never promotes unattended.</p>
    </div>
  );
}

// ── Read dashboards (cycles / variants / compare / frontier) ────────────────────
function useGymList<T>(slug: string, path: string, pick: (j: unknown) => T[]) {
  const [rows, setRows] = useState<T[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    api<unknown>(`/${slug}${path}`).then((j) => {
      if (!live) return;
      if (j && typeof j === 'object' && (j as { available?: boolean }).available === false) { setUnavailable(true); setRows([]); }
      else { setRows(pick(j)); setUnavailable(false); }
      setErr(null);
    }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, path]);
  return { rows, err, unavailable };
}

function Unavailable() {
  return <div style={{ ...card, ...mono, opacity: 0.7 }} data-testid="gym-unavailable">Run analytics require a gym run database (PAPERCUSP_GYM_DATABASE_URL). No runs to show yet.</div>;
}

function CyclesTab({ slug }: { slug: string }) {
  const { rows, err, unavailable } = useGymList<CycleRow>(slug, '/cycles', (j) => ((j as { cycles?: CycleRow[] }).cycles ?? []));
  if (unavailable) return <Unavailable />;
  return (
    <div style={card} data-testid="gym-cycles">
      {err && <div style={{ color: dangerText, ...mono }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ ...mono, opacity: 0.6, paddingTop: 8 }}>No cycles yet.</div>
      ) : (
        <div style={{ height: Math.min(420, 32 + rows.length * 28 + 4), fontFamily: mono.fontFamily }}>
          <RichGrid<CycleRow>
            columns={cycleColumns}
            rows={rows}
            getRowId={(c) => `${c.cycle}:${c.candidateId ?? 'none'}`}
            rowMinHeight={28}
            headerHeight={32}
          />
        </div>
      )}
    </div>
  );
}

function VariantsTab({ slug }: { slug: string }) {
  const { rows, err, unavailable } = useGymList<VariantRow>(slug, '/variants', (j) => ((j as { variants?: VariantRow[] }).variants ?? []));
  if (unavailable) return <Unavailable />;
  return (
    <div style={card} data-testid="gym-variants">
      {err && <div style={{ color: dangerText, ...mono }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ ...mono, opacity: 0.6, paddingTop: 8 }}>No variants yet.</div>
      ) : (
        <div style={{ height: Math.min(420, 32 + rows.length * 28 + 4), fontFamily: mono.fontFamily }}>
          <RichGrid<VariantRow>
            columns={variantColumns}
            rows={rows}
            getRowId={(v) => v.variantId}
            rowMinHeight={28}
            headerHeight={32}
          />
        </div>
      )}
    </div>
  );
}

function CompareTab({ slug }: { slug: string }) {
  const [a, setA] = useQueryState('a', parseAsString.withDefault(''));
  const [b, setB] = useQueryState('b', parseAsString.withDefault(''));
  const [rubric] = useQueryState('rubric', parseAsString.withDefault(''));
  const [rows, setRows] = useState<CompareRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!a || !b) { setRows([]); return; }
    let live = true;
    api<unknown>(`/${slug}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&rubricHash=${encodeURIComponent(rubric)}`)
      .then((j) => { if (!live) return; if ((j as { available?: boolean }).available === false) setUnavailable(true); else { setRows((j as { rows?: CompareRow[] }).rows ?? []); setUnavailable(false); } setErr(null); })
      .catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [slug, a, b, rubric]);

  if (unavailable) return <Unavailable />;
  return (
    <div style={card} data-testid="gym-compare">
      <div style={{ ...mono, display: 'flex', gap: 8, marginBottom: 8 }}>
        <input placeholder="variant A" value={a} onChange={(e) => void setA(e.target.value)} data-testid="gym-compare-a" style={{ ...inputStyle, padding: '3px 6px' }} />
        <input placeholder="variant B" value={b} onChange={(e) => void setB(e.target.value)} data-testid="gym-compare-b" style={{ ...inputStyle, padding: '3px 6px' }} />
      </div>
      {err && <div style={{ color: dangerText, ...mono }}>{err}</div>}
      <Compare
        baseline={a || 'A'}
        treatment={b || 'B'}
        perTask={rows.map((r) => ({ label: r.taskId, baseline: r.aComposite, treatment: r.bComposite }))}
        emptyHint="Enter two variant ids to compare."
      />
    </div>
  );
}

function FrontierTab({ slug }: { slug: string }) {
  const [rubric] = useQueryState('rubric', parseAsString.withDefault(''));
  const { rows, err, unavailable } = useGymList<string>(slug, `/frontier?rubricHash=${encodeURIComponent(rubric)}`, (j) => ((j as { frontier?: string[] }).frontier ?? []));
  if (unavailable) return <Unavailable />;
  return (
    <div style={card} data-testid="gym-frontier">
      {err && <div style={{ color: dangerText, ...mono }}>{err}</div>}
      <div style={{ ...mono, opacity: 0.7, marginBottom: 6 }}>Pareto-optimal variants (train vectors):</div>
      {rows.length === 0 ? <div style={{ ...mono, opacity: 0.6 }}>No frontier yet.</div> : (
        <ul style={{ ...mono, margin: 0, paddingLeft: 18 }}>{rows.map((v) => <li key={v}>{v}</li>)}</ul>
      )}
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : (Math.round(n * 100) / 100).toString();
}
