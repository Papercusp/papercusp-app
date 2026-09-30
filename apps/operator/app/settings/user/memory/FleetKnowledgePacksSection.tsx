'use client';

/**
 * "Fleet knowledge packs — workspace-wide" (knowledge-pack-settings-2026-07-19
 * P-005, D-001): the runtime-tunable knobs for the knowledge-pack loop, hosted
 * on the memory settings page because knowledge packs ARE fleet memory — but
 * explicitly badged workspace-wide (the rest of this page is user-scoped).
 *
 * Backed by GET/POST /api/user/knowledge-pack-settings (the same bounded
 * one-shot REST pattern as this page's backend/feedback envelope — WI-5030
 * discipline: every fetch carries an AbortSignal timeout). Cadence + policy
 * selects apply immediately (mirrors the backend select's apply-live
 * behavior); numeric knobs are draft-edited (useState per the nuqs policy —
 * mid-edit drafts) behind one Save. The Advanced cost-bounds toggle is
 * URL-backed (nuqs) so agents/deep-links see it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { toast } from 'sonner';
import { Select } from '@/app/harness/Select';

const FETCH_TIMEOUT_MS = 15_000;

interface CadenceView {
  preset: string;
  cron: string | null;
  active: boolean;
  nextFireAt: string | null;
  seeded: boolean;
}
interface Envelope {
  settings: Record<string, unknown>;
  resolved: {
    adoptionPolicy: 'auto' | 'owner-approval';
    minAgeDays: number;
    pruneDismissedDays: number;
    pendingCandidateCap: number;
    maxReviewsPerTick: number;
    hygieneMaxHivesPerTick: number;
    deliveryMaxHivesPerTick: number;
  };
  defaults: Envelope['resolved'];
  cadence: { delivery: CadenceView; hygiene: CadenceView } | null;
}

const NUMERIC_FIELDS = [
  { key: 'minAgeDays', label: 'Re-review lessons older than (days)', hint: 'hygiene pass (a): how old an adopted lesson must be before the judge re-checks it' },
  { key: 'pruneDismissedDays', label: 'Keep dismissed candidates (days)', hint: 'hygiene pass (c): dismissed rows older than this are pruned (adopted rows are kept forever)' },
  { key: 'pendingCandidateCap', label: 'Pending candidate cap', hint: 'staging refuses new candidates past this (queue, not landfill)' },
] as const;
const ADVANCED_FIELDS = [
  { key: 'maxReviewsPerTick', label: 'Re-judgements per hygiene tick', hint: 'LLM cost bound' },
  { key: 'hygieneMaxHivesPerTick', label: 'Hives swept per hygiene tick', hint: 'conflict-sweep bound' },
  { key: 'deliveryMaxHivesPerTick', label: 'Hives visited per delivery tick', hint: 'delivery bound' },
] as const;
type NumericKey = (typeof NUMERIC_FIELDS)[number]['key'] | (typeof ADVANCED_FIELDS)[number]['key'];

function fmtNext(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? ` · next ${new Date(iso).toLocaleString()}` : '';
}

export function FleetKnowledgePacksSection(): React.ReactElement {
  const [env, setEnv] = useState<Envelope | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<NumericKey, string>>>({});
  const [advancedOpen, setAdvancedOpen] = useQueryState('kpAdvanced', parseAsBoolean.withDefault(false));

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/user/knowledge-pack-settings', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnv((await res.json()) as Envelope);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (patch: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/user/knowledge-pack-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = (await res.json()) as Envelope & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setEnv(body);
      setDrafts({});
      toast.success(okMsg);
    } catch (e) {
      toast.error(`Knowledge-pack settings save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const saveNumbers = useCallback(() => {
    const patch: Record<string, number> = {};
    for (const [k, v] of Object.entries(drafts)) {
      if (v == null || v.trim() === '') continue;
      const n = Number.parseInt(v.trim(), 10);
      if (!Number.isFinite(n)) { toast.error(`"${v}" is not a number`); return; }
      patch[k] = n;
    }
    if (Object.keys(patch).length === 0) return;
    void post(patch, 'Knowledge-pack knobs saved — applies on the next routine tick.');
  }, [drafts, post]);

  const dirty = Object.values(drafts).some((v) => v != null && v.trim() !== '');

  const numberRow = (f: { key: NumericKey; label: string; hint: string }): React.ReactElement => (
    <label key={f.key} title={f.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--fg-mute)', minWidth: 240 }}>{f.label}</span>
      <input
        type="number"
        value={drafts[f.key] ?? String(env?.resolved[f.key] ?? '')}
        onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
        style={{ width: 90, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 13 }}
      />
      {env && env.defaults[f.key] !== env.resolved[f.key] && (
        <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>default {env.defaults[f.key]}</span>
      )}
    </label>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Fleet knowledge packs</strong>
        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'color-mix(in srgb, var(--accent), transparent 85%)', color: 'var(--accent)' }}>
          workspace-wide
        </span>
        <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
          The shared fleet-lessons loop: how lessons are adopted, delivered to every pot, and cleaned up.
        </span>
      </div>

      {loadError && (
        <div style={{ padding: 8, border: '1px solid var(--warn-border)', borderRadius: 6, background: 'var(--warn-bg)', fontSize: 13 }}>
          Couldn&rsquo;t load knowledge-pack settings: <code>{loadError}</code>{' '}
          <button type="button" onClick={() => void load()} style={{ fontSize: 12, cursor: 'pointer' }}>retry</button>
        </div>
      )}

      {env && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-mute)', minWidth: 240 }}>Lesson adoption</span>
            <Select
              value={env.resolved.adoptionPolicy}
              disabled={saving}
              onChange={(value) => void post({ adoptionPolicy: value }, value === 'auto'
                ? 'Auto-adopt ON — candidates passing the transferability bar adopt automatically.'
                : 'Owner approval required — candidates now wait for your decision in the Learnings view.')}
              ariaLabel="Lesson adoption policy"
              triggerStyle={{ padding: '4px 8px', fontSize: 13 }}
              options={[
                { value: 'auto', label: 'auto-adopt (judged)' },
                { value: 'owner-approval', label: 'owner approval required' },
              ]}
            />
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              auto = the transferability judge adopts/dismisses; owner approval = everything waits for you.
            </span>
          </div>

          {env.cadence && ([
            ['Delivery cadence', 'deliveryCadence', env.cadence.delivery, [
              { value: 'hourly', label: 'hourly' }, { value: '6h', label: 'every 6 h' },
              { value: 'daily', label: 'daily' }, { value: 'paused', label: 'paused' },
            ], 'installs new fleet lessons into every pot'],
            ['Hygiene cadence', 'hygieneCadence', env.cadence.hygiene, [
              { value: 'daily', label: 'daily (05:00)' }, { value: 'weekly', label: 'weekly (Sun 05:00)' },
              { value: 'paused', label: 'paused' },
            ], 're-judges stale lessons, sweeps contradictions, prunes the queue'],
          ] as const).map(([label, field, view, options, hint]) => (
            <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--fg-mute)', minWidth: 240 }}>{label}</span>
              {view.seeded ? (
                <>
                  <Select
                    value={view.preset}
                    disabled={saving}
                    onChange={(value) => void post({ [field]: value }, `${label} → ${value}.`)}
                    ariaLabel={label}
                    triggerStyle={{ padding: '4px 8px', fontSize: 13 }}
                    options={view.preset === 'custom' ? [{ value: 'custom', label: `custom (${view.cron ?? '—'})` }, ...options] : [...options]}
                  />
                  <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>{hint}{view.active ? fmtNext(view.nextFireAt) : ' · paused'}</span>
                </>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
                  routine not seeded yet — run <code>seed-improvement-routines.ts --active</code>
                </span>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {NUMERIC_FIELDS.map(numberRow)}
            <button
              type="button"
              onClick={() => void setAdvancedOpen(!advancedOpen)}
              aria-expanded={advancedOpen}
              style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--fg-mute)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {advancedOpen ? '▾' : '▸'} Advanced cost bounds
            </button>
            {advancedOpen && ADVANCED_FIELDS.map(numberRow)}
            {dirty && (
              <button
                type="button"
                onClick={saveNumbers}
                disabled={saving}
                style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: saving ? 'wait' : 'pointer', border: '1px solid var(--border)', background: 'var(--accent)', color: 'var(--bg)' }}
              >
                {saving ? '…' : 'Save knobs'}
              </button>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
            Master switch lives in <a href="/admin/features">/admin/features</a> (<code>KNOWLEDGE_PACKS</code>) ·
            per-pot pack mute in each pot&rsquo;s Learnings view · routine health in{' '}
            <a href="/admin/schedules">/admin/schedules</a>. Knob changes apply on the next routine tick — no restart.
          </div>
        </>
      )}
    </div>
  );
}
