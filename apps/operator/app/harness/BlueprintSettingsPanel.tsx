'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import {
  resolveParamViews,
  validateParamPatch,
  applyParamPatch,
  type ParamView,
} from '@papercusp/orchestrator/blueprint/params';
import type { BlueprintParams } from '@papercusp/orchestrator/blueprint/schema';
import { OverridableSettingStyle } from '@papercusp/ui-primitives/override';
import { Checkbox } from './Checkbox';
import { Select } from './Select';
import SavedPromptsSection from './SavedPromptsSection';
import HarnessPluginsSection from './HarnessPluginsSection';
import IntegrationModeSection from './IntegrationModeSection';

/**
 * BlueprintSettingsPanel — the SCHEMA-DRIVEN per-harness settings panel
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-008 / D-003). It
 * renders controls from the harness blueprint's DECLARED `params` (P-006) instead
 * of the legacy `HarnessSettingsPanel`'s hardcoded coding-pipeline form — so a
 * `coding` harness shows the worker/typecheck/debugger knobs, a `research`/`gym`
 * harness shows its own, and a Cupboard-installed blueprint gets a settings panel
 * for free.
 *
 * Data flow (reuses the existing per-harness config path — zero new storage):
 *   - the blueprint's `params` come from `GET /api/harness/:slug/blueprint-params`;
 *   - the current per-harness values come from `config.json` via the existing
 *     `harnessProjectFiles.byHarness` sync mirror;
 *   - `resolveParamViews` (P-007) maps params + config → the controls' current values;
 *   - Save validates edits with `validateParamPatch` (reject unknown keys / type / range;
 *     secrets are skipped — they route through the credential store, never config.json),
 *     applies them with `applyParamPatch`, and PUTs the merged config to the SAME
 *     `/spec` endpoint the legacy panel used.
 *
 * Flag-gated behind `BLUEPRINT_AWARE_SETTINGS` (default off) at the AdvHarnessPanelPage
 * wire-in — the legacy panel stays the default until this is Tauri-verified.
 */
export default function BlueprintSettingsPanel({ slug, phase }: { slug: string; phase: string }) {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [params, setParams] = useState<BlueprintParams>({});
  const [blueprintId, setBlueprintId] = useState<string | null>(null);
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>({});
  /** In-flight edits keyed by param key (config.json dot-path). */
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // The declared schema for this harness's blueprint.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${slug}/blueprint-params?phase=${phase}`)
      .then((r) => r.json())
      .then((d: { blueprintId?: string | null; params?: BlueprintParams }) => {
        if (cancelled) return;
        setParams(d.params ?? {});
        setBlueprintId(d.blueprintId ?? null);
        setParamsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setParamsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, phase]);

  // Current per-harness config.json via the existing sync mirror (cross-tab live).
  const { data: cfgRows } = useSyncQuery<{ harnessSlug: string; config?: string | null }>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });
  useEffect(() => {
    if (!Array.isArray(cfgRows) || cfgRows.length === 0) return;
    const raw = cfgRows[0]?.config;
    let cfg: Record<string, unknown> = {};
    if (typeof raw === 'string' && raw.trim()) {
      try {
        cfg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
    }
    setOriginalConfig(cfg);
  }, [cfgRows]);

  // Param views: the declared params over the saved config, with in-flight edits overlaid.
  const views = useMemo<ParamView[]>(() => {
    const base = resolveParamViews(params, originalConfig);
    return base.map((v) => (v.key in edits ? { ...v, value: edits[v.key], overridden: true } : v));
  }, [params, originalConfig, edits]);

  const grouped = useMemo(() => {
    const groups: Record<string, ParamView[]> = {};
    for (const v of views) {
      const g = v.spec.group ?? 'General';
      (groups[g] ??= []).push(v);
    }
    return groups;
  }, [views]);

  const setEdit = useCallback((key: string, value: unknown) => {
    setEdits((e) => ({ ...e, [key]: value }));
    setErrors((er) => (er[key] ? { ...er, [key]: '' } : er));
  }, []);

  const save = useCallback(async () => {
    const res = validateParamPatch(params, edits);
    if (!res.ok) {
      const errMap: Record<string, string> = {};
      for (const e of res.errors) errMap[e.key] = e.error;
      for (const k of res.unknownKeys) errMap[k] = 'not a declared setting';
      setErrors(errMap);
      toast.error('Some settings are invalid');
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const nextCfg = applyParamPatch(originalConfig, params, res.patch);
      const r = await fetch(`/api/harness/${slug}/spec?phase=${phase}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: JSON.stringify(nextCfg, null, 2) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setOriginalConfig(nextCfg);
      setEdits({});
      toast.success('Settings saved');
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [params, edits, originalConfig, slug, phase]);

  if (!paramsLoaded) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Loading…</div>;
  }

  const hasParams = Object.keys(params).length > 0;
  const dirty = Object.keys(edits).length > 0;

  return (
    <div style={{ padding: 16, maxWidth: 920, overflowY: 'auto' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Settings — {slug}</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Schema-driven per-harness settings
          {blueprintId ? (
            <>
              {' '}
              from the <code>{blueprintId}</code> blueprint
            </>
          ) : null}
          . Saved to the <code>{phase}</code> spec; changes take effect on the next harness run.
        </p>
      </header>

      {!hasParams ? (
        <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 13 }}>
          This harness&rsquo;s blueprint declares no tunable settings
          {blueprintId ? '' : ' (no blueprint.yaml found for this harness)'}.
        </div>
      ) : (
        Object.entries(grouped).map(([group, items]) => (
          <section key={group} style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>{group}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {items.map((v) => (
                <ParamControl key={v.key} view={v} error={errors[v.key]} onChange={(val) => setEdit(v.key, val)} />
              ))}
            </div>
          </section>
        ))
      )}

      {hasParams && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            style={{ fontSize: 13, padding: '6px 18px', cursor: !dirty || saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-mute)' }}>
              {Object.keys(edits).length} unsaved change{Object.keys(edits).length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {/* WI-10006501 (pot-review-integration-mode-2026-10-05 P-016/P-017): the pot's
          "Where should the agents' work go?" switch. This is the panel the Settings tab
          mounts by default (BLUEPRINT_AWARE_SETTINGS on), so the switch must live here as
          well as in the legacy HarnessSettingsPanel. Saves on its own; hidden for
          projects that are not pots. */}
      <IntegrationModeSection slug={slug} />

      <SavedPromptsSection scope={{ kind: 'harness', slug }} />
      <HarnessPluginsSection slug={slug} />
    </div>
  );
}

/** One declared param → the right control by `type` (number / boolean / enum / string). */
function ParamControl({
  view,
  error,
  onChange,
}: {
  view: ParamView;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const { spec } = view;
  const labelW = 190;
  const valueStr = view.value === undefined || view.value === null ? '' : String(view.value);

  let control: React.ReactNode;
  if (spec.secret) {
    control = (
      <span style={{ fontSize: 11.5, color: 'var(--fg-mute)', fontStyle: 'italic' }}>
        set via the credential store (never stored in config)
      </span>
    );
  } else if (spec.type === 'boolean') {
    control = <Checkbox checked={view.value === true} onChange={onChange} ariaLabel={spec.label} />;
  } else if (spec.type === 'enum') {
    const opts = spec.options ?? [];
    control = (
      <Select
        value={valueStr}
        onChange={(sel) => {
          // map the selected string back to the option's actual (possibly non-string) value
          const match = opts.find((o) => String(o.value) === sel);
          onChange(match ? match.value : sel);
        }}
        options={opts.map((o) => ({ value: String(o.value), label: o.label }))}
      />
    );
  } else if (spec.type === 'number') {
    control = (
      <input
        type="number"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={valueStr}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        style={{ width: 100, fontSize: 13, padding: '3px 6px' }}
      />
    );
  } else {
    control = (
      <input
        type="text"
        value={valueStr}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, minWidth: 220, fontSize: 13, padding: '3px 6px', fontFamily: 'monospace' }}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: labelW, fontSize: 11.5, color: 'var(--fg-mute)' }}>{spec.label}</span>
        {control}
        {view.overridden && !spec.secret && (
          // The override marker now uses the shared pc-override badge chrome
          // (sentinel-herald P-035) instead of a hand-rolled ● dot. Presence-
          // based + shown only when overridden — same condition as before, so
          // non-overridden rows stay bare (no always-on "default" badge).
          <>
            <OverridableSettingStyle />
            <span
              className="pc-override-badge pc-override-badge--on"
              title="overridden (differs from the default)"
            >
              override
            </span>
          </>
        )}
      </div>
      {(spec.description || spec.affects) && (
        <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginLeft: labelW + 10, marginTop: 2, lineHeight: 1.4 }}>
          {spec.description}
          {spec.affects ? (
            <>
              {spec.description ? ' · ' : ''}
              <em>{spec.affects}</em>
            </>
          ) : null}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: 'var(--bad, #d97757)', marginLeft: labelW + 10, marginTop: 2 }}>⚠ {error}</div>
      )}
    </div>
  );
}
