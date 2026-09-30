'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsStringEnum } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { toast } from 'sonner';
import { z } from 'zod';
import { Controller } from 'react-hook-form';
import { SettingsMarkdownEditor } from '../SettingsMarkdownEditor';
import { useFormWith, SubmitButton } from '@/lib/forms';
import { useLexicon } from '@/lib/useLexicon';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { useSyncQuery } from '@papercusp/sync';
import { OperatorSettingsSlot } from '@papercusp/operator-ui/settings-slots';

// Form schema — both fields are free-form markdown, allowed to be empty.
const ConfigSchema = z.object({
  prompt_user: z.string().default(''),
  preferences: z.string().default(''),
});
type ConfigFormData = z.infer<typeof ConfigSchema>;

interface OperatorConfig {
  prompt_user: string;
  preferences: string;
  substrate_prompt: string;
  prompt_user_path: string;
  prefs_path: string;
}

interface PreferenceEntry {
  key: string;
  date: string;
  body: string;
  tags: string[];
  addedAt: string;
}

type FilterMode = 'all' | 'user-typed' | 'operator-proposed';

const FILTER_MODES: FilterMode[] = ['all', 'user-typed', 'operator-proposed'];

const DAY_MS = 24 * 60 * 60 * 1000;

export default function OperatorSettingsPage() {
  const t = useLexicon();
  const [cfg, setCfg] = useState<OperatorConfig | null>(null);
  const [entries, setEntries] = useState<PreferenceEntry[]>([]);
  // User-meaningful list filter → URL via nuqs (visible to ui:get_state).
  const [filter, setFilter] = useQueryState('filter', parseAsStringEnum<FilterMode>(FILTER_MODES).withDefault('all'));
  const [loading, setLoading] = useState(true);

  const [statsOpen, setStatsOpen] = useQueryState('stats', parseAsBoolean.withDefault(false));
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { control, submit, reset, isSubmitting } = useFormWith(ConfigSchema, {
    defaultValues: { prompt_user: '', preferences: '' },
  });
  const [budget, setBudget] = useState<{ dailyCapUsd: number; todaySpendUsd: number; configured: boolean } | null>(null);
  const [candidates, setCandidates] = useState<{ capability: string; targetHarness: string; count: number; lastSeenAt: string }[]>([]);
  const [stats, setStats] = useState<{
    cardsTotal: number;
    dispatched: number;
    dismissed: number;
    consumed: number;
    escalated: number;
    rejected: number;
    failed: number;
    undoCancelled: number;
    medianAckLatencyMs: number | null;
    unconsumedFraction: number | null;
    totalSpendUsd: number;
    byActorMethod?: { voice: number; click: number; api: number; unspecified: number };
  } | null>(null);
  const configSync = useSyncQuery<OperatorConfig>({ queryName: 'operatorConfig.byWorkspace', staleTime: 30_000 });
  const prefsSync = useSyncQuery<PreferenceEntry>({ queryName: 'operatorPreferences.byWorkspace', staleTime: 30_000 });
  const budgetSync = useSyncQuery<{ dailyCapUsd: number; todaySpendUsd: number; configured: boolean }>({
    queryName: 'operatorBudget.byWorkspace', staleTime: 30_000,
  });
  const candidatesSync = useSyncQuery<{ capability: string; targetHarness: string; count: number; lastSeenAt: string }>({
    queryName: 'operatorStandingApprovals.byWorkspace', staleTime: 30_000,
  });

  // Seed the prompt/preferences FORM exactly once. loadAll re-runs after
  // saves and actions (and twice on mount under StrictMode, both fetches in
  // flight) — a later reset() here would clobber unsaved textarea edits.
  // Display data (cfg paths, entries, budget, candidates) re-applies freely.
  const formSeededRef = useRef(false);

  useEffect(() => {
    const cfgR = configSync.data?.[0];
    if (!cfgR) return;
    setCfg(cfgR);
    if (!formSeededRef.current) {
      formSeededRef.current = true;
      reset({ prompt_user: cfgR.prompt_user ?? '', preferences: cfgR.preferences ?? '' });
    }
  }, [configSync.data, reset]);
  useEffect(() => setEntries(prefsSync.data ?? []), [prefsSync.data]);
  useEffect(() => setBudget(budgetSync.data?.[0] ?? null), [budgetSync.data]);
  useEffect(() => setCandidates(candidatesSync.data ?? []), [candidatesSync.data]);

  useEffect(() => {
    if (!statsOpen) return;
    void fetch('/api/agent-mcp/operator-stats').then((r) => r.json()).then(setStats).catch(() => {});
  }, [statsOpen]);

  const decideCandidate = useCallback(async (capability: string, targetHarness: string, decision: 'approve' | 'dismiss') => {
    try {
      const r = await fetch('/api/agent-mcp/operator-standing-approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, targetHarness, decision }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Refresh only the candidates/stats — never the form (an unsaved
      // prompt edit must survive approving a card on the same page).
      candidatesSync.invalidate();
      prefsSync.invalidate();
    } catch (err) {
      toast.error(`standing-approval ${decision} failed: ${(err as Error).message}`);
    }
  }, [candidatesSync, prefsSync]);

  useEffect(() => {
    setLoading(configSync.loading || prefsSync.loading || budgetSync.loading || candidatesSync.loading);
  }, [budgetSync.loading, candidatesSync.loading, configSync.loading, prefsSync.loading]);


  const onSave = async (data: ConfigFormData) => {
    if (!cfg) {
      toast.error('Papercup config is still loading');
      return;
    }
    try {
      const r = await fetch('/api/agent-mcp/operator-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt_user: data.prompt_user, preferences: data.preferences }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Mark the form clean with exactly what was saved (loadAll no longer
      // resets the form — its once-guard protects in-flight edits).
      reset(data);
      configSync.invalidate();
      toast.success('Saved');
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    }
  };

  const removeEntry = useCallback(async (key: string) => {
    const ok = await askConfirm({
      title: 'Remove this preference entry?',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    await fetch(`/api/agent-mcp/operator-preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    prefsSync.invalidate();
    configSync.invalidate();
    toast.success('Removed');
  }, [askConfirm, configSync, prefsSync]);

  const setBudgetCap = useCallback(async (cap: number) => {
    await fetch('/api/agent-mcp/operator-budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyCapUsd: cap }),
    });
    budgetSync.invalidate();
  }, [budgetSync]);


  const filteredEntries = useMemo(() => {
    if (filter === 'all') return entries;
    if (filter === 'user-typed') return entries.filter((e) => e.tags.includes('USER-TYPED'));
    return entries.filter((e) => e.tags.some((t) => t.startsWith('OPERATOR-PROPOSED')));
  }, [entries, filter]);

  const recentEntries = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    return entries.filter((e) => new Date(e.addedAt).getTime() > cutoff);
  }, [entries]);



  return (
    <div>
      {confirmEl}
      <h1>Papercup</h1>
      <p className="pc-settings-intro">
        Papercup is the proactive concierge accessed from the top-bar Papercup button.
        {cfg ? (
          <> Stored in <code>{cfg.prompt_user_path}</code> and <code>{cfg.prefs_path}</code>.</>
        ) : (
          <> Loading workspace prompt store…</>
        )}
      </p>

      {/* The web portal owns which backend/model answers its universal-bar
          questions, but that is still a Papercup-agent setting. A host slot
          keeps the control on this canonical page; the desktop renders none. */}
      <OperatorSettingsSlot name="papercup-agent" />

      {loading && (
        <p role="status" style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 13 }}>
          Loading Papercup config…
        </p>
      )}


      {candidates.length > 0 && (
        <section style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 6, padding: 12, marginBottom: 24 }}>
          <strong style={{ fontSize: 13 }}>Standing-approval candidates</strong>
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '4px 0 8px' }}>
            Papercup dispatched these (capability, target) pairs ≥3 times in the last 24h. Approve to skip the ask-first prompt for future identical dispatches.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {candidates.map((c) => (
              <li key={`${c.capability}::${c.targetHarness}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                <span><code>{c.capability}</code> → <code>{c.targetHarness}</code> · {c.count}× in 24h</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => decideCandidate(c.capability, c.targetHarness, 'approve')}>Approve</button>
                  <button type="button" onClick={() => decideCandidate(c.capability, c.targetHarness, 'dismiss')}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentEntries.length > 0 && (
        <section style={{ background: 'color-mix(in srgb, var(--accent), transparent 94%)', border: '1px solid color-mix(in srgb, var(--accent), transparent 70%)', borderRadius: 6, padding: 12, marginBottom: 24 }}>
          <strong style={{ fontSize: 13 }}>Papercup recently learned (last 24h)</strong>
          <ul style={{ marginTop: 8, fontSize: 13, paddingLeft: 18 }}>
            {recentEntries.map((e) => (
              <li key={e.key} style={{ marginBottom: 4 }}>
                <code style={{ fontSize: 11 }}>{e.tags.join(' ')}</code>{' '}
                <span style={{ opacity: 0.8 }}>{e.body.replace(/^- /, '').slice(0, 160)}{e.body.length > 160 ? '…' : ''}</span>{' '}
                <button type="button" onClick={() => removeEntry(e.key)} style={{ fontSize: 11 }}>undo</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats && (
        <Collapsible.Root open={statsOpen} onOpenChange={setStatsOpen}>
          <section className="pc-settings-diagnostics">
            <div className="pc-settings-diagnostics-head">
              <div>
                <h2>Papercup diagnostics</h2>
                <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '4px 0 0' }}>
                  Last 7 days. Useful when tuning Papercup behavior; collapsed by default because it is a report, not a setting.
                </p>
              </div>
              <div className="pc-settings-diagnostics-summary">
                <span className="pc-settings-status-pill is-set">{stats.dispatched} dispatched</span>
                <span className="pc-settings-status-pill">${stats.totalSpendUsd.toFixed(2)} spent</span>
                {stats.unconsumedFraction !== null && (
                  <span className={`pc-settings-status-pill ${stats.unconsumedFraction > 0.25 ? 'is-warn' : 'is-set'}`}>
                    {(stats.unconsumedFraction * 100).toFixed(0)}% unconsumed
                  </span>
                )}
                <Collapsible.Trigger asChild>
                  <button type="button" className="pc-settings-diagnostics-toggle">
                    {statsOpen ? 'Hide details' : 'Show details'}
                  </button>
                </Collapsible.Trigger>
              </div>
            </div>
            <Collapsible.Content>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, fontSize: 13, marginTop: 14 }}>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Cards seen</div>
              <strong style={{ fontSize: 22 }}>{stats.cardsTotal}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Dispatched</div>
              <strong style={{ fontSize: 22 }}>{stats.dispatched}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Consumed</div>
              <strong style={{ fontSize: 22 }}>{stats.consumed}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Dismissed</div>
              <strong style={{ fontSize: 22 }}>{stats.dismissed}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Escalated</div>
              <strong style={{ fontSize: 22, color: stats.escalated > 0 ? 'var(--warn)' : 'inherit' }}>{stats.escalated}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Undo-cancel</div>
              <strong style={{ fontSize: 22 }}>{stats.undoCancelled}</strong>
            </div>
            {stats.medianAckLatencyMs !== null && (
              <div>
                <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Median ack</div>
                <strong style={{ fontSize: 22 }}>{Math.round(stats.medianAckLatencyMs / 1000)}s</strong>
              </div>
            )}
            {stats.unconsumedFraction !== null && (
              <div title="Path-(a) escalation criterion: trigger if >25%">
                <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Unconsumed</div>
                <strong style={{ fontSize: 22, color: stats.unconsumedFraction > 0.25 ? 'var(--warn)' : 'inherit' }}>
                  {(stats.unconsumedFraction * 100).toFixed(0)}%
                </strong>
              </div>
            )}
            <div>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase' }}>Spend</div>
              <strong style={{ fontSize: 22 }}>${stats.totalSpendUsd.toFixed(2)}</strong>
            </div>
          </div>
          {stats.unconsumedFraction !== null && stats.unconsumedFraction > 0.25 && (
            <p style={{ fontSize: 12, color: 'var(--warn)', marginTop: 8 }}>
              ⚠ Unconsumed fraction {`>`}25% — recipient {t('pot', { plural: true })} are slow to consume Papercup directives.
              The v5 plan's Path-(a) (`dispatch_role`) escalation criterion is met; consider raising the issue
              with the substrate maintainers.
            </p>
          )}
          {stats.byActorMethod && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <strong>How you act</strong>
              <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                <span>🎤 voice: <strong>{stats.byActorMethod.voice}</strong></span>
                <span>🖱 click: <strong>{stats.byActorMethod.click}</strong></span>
                <span>⚙ api/CLI: <strong>{stats.byActorMethod.api}</strong></span>
                {stats.byActorMethod.unspecified > 0 && (
                  <span style={{ opacity: 0.6 }}>? unspecified: {stats.byActorMethod.unspecified}</span>
                )}
              </div>
            </div>
          )}
          </Collapsible.Content>
        </section>
      </Collapsible.Root>
      )}

      <section className="pc-settings-section">
        <h2>Daily budget</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', marginBottom: 8 }}>
          Today: <strong>${budget?.todaySpendUsd?.toFixed(2) ?? '0.00'}</strong> of{' '}
          <strong>${budget?.dailyCapUsd?.toFixed(2) ?? '0.00'}</strong>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          {[5, 20, 50].map((cap) => (
            <button key={cap} type="button" onClick={() => setBudgetCap(cap)}>${cap}/day</button>
          ))}
        </div>
      </section>

      <form onSubmit={submit(onSave)}>
        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
          Your prompt (voice + free-form preferences)
        </label>
        <div style={{ minHeight: 200, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <Controller
            name="prompt_user"
            control={control}
            render={({ field }) => (
              <SettingsMarkdownEditor value={field.value} onChange={field.onChange} mode="ir" minHeight={200} />
            )}
          />
        </div>

        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
          Preferences notebook (free-form markdown)
        </label>
        <div style={{ minHeight: 240, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <Controller
            name="preferences"
            control={control}
            render={({ field }) => (
              <SettingsMarkdownEditor value={field.value} onChange={field.onChange} mode="ir" minHeight={240} />
            )}
          />
        </div>

        <SubmitButton pending={isSubmitting || loading} style={{ marginBottom: 24 }}>
          Save prompt + preferences
        </SubmitButton>
      </form>

      <section className="pc-settings-section">
        <h2>Per-entry view</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {(['all', 'user-typed', 'operator-proposed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                background: filter === f ? 'var(--bg-raised)' : 'transparent',
                color: filter === f ? 'var(--fg)' : 'inherit',
                border: '1px solid var(--border)',
                borderRadius: 4,
              }}
            >
              {f}
            </button>
          ))}
        </div>
        {filteredEntries.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>(no entries match)</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {filteredEntries.map((e) => (
              <li key={e.key} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
                  <span>{e.date} · {e.tags.join(' ')}</span>
                  <button type="button" onClick={() => removeEntry(e.key)} style={{ fontSize: 11 }}>remove</button>
                </div>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{e.body}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pc-settings-section">
        <h2>Substrate prompt (read-only)</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', marginBottom: 8 }}>
          Tier rules, schema, and anti-patterns. Ships with the substrate; cannot be edited here.
        </p>
        <div style={{ height: 320, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <SettingsMarkdownEditor
            value={cfg?.substrate_prompt ?? ''}
            readOnly
            mode="ir"
            minHeight={280}
            height={320}
          />
        </div>
      </section>
    </div>
  );
}
