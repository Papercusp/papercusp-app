'use client';

// Per-harness plugin management — relocated from the retired Config tab's
// ConfigPanel (config-tab-cleanup-2026-06-08).
//
// The Config tab's "Harness" pane (legacy 9-tab SpecEditor + the manifest
// `configFiles` bridge) was the pre-blueprint paradigm of editing a harness by
// hand-editing its dotfiles (AGENTS.md / config.json / .mcp.json / .claude/* /
// knowledge.md / .env). Blueprints replaced that: the blueprint is the
// declarative harness source (roles/prompts/spine/knobs), validated and
// PG-projected. So the file-editor was removed wholesale; the proper "configure
// the harness" replacement is a blueprint editor (follow-up).
//
// Plugin enable/disable/configure/invoke is blueprint-orthogonal and genuinely
// per-install, so it survives — moved here and mounted as a section inside the
// Settings tab. The plugin UX (a rail of enabled plugins + the selected
// plugin's card) is preserved verbatim, minus the dropped "Harness" file tab.

import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useForm } from 'react-hook-form';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import MonacoEditor from '@monaco-editor/react';
// Points the Monaco AMD loader at our local mirror. Without it Monaco fetches
// ~4MB from jsdelivr on first mount (cdn-egress-fixes-2026-08-02 P-001).
import '@/app/_components/monaco-runtime';
import { makeAjvResolver } from '@/lib/forms';
import { Button } from './Button';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { Tooltip } from './Tooltip';
import { Checkbox } from './Checkbox';
import { Select } from './Select';
import { useConfirmDialog } from './useConfirmDialog';
import {
  PluginIcon,
  pluginSlugFromPath,
  computePluginsMissing,
  dedupeEnabledManifests,
  pruneEmptyConfig,
  type InstalledPluginInfo,
  type EnabledPluginManifest,
} from './plugin-utils';

/**
 * Plugin tab button. Hoisted to module scope (NOT defined inline) so its
 * component identity is stable across renders — an inline component is a brand
 * new type every render, which remounts the whole rail and replays the
 * `useAutoAnimate` enter animation on every poll/state tick (the "subtab keeps
 * blinking" bug). `pane`/`setPane` are passed as props, not closed over.
 */
function PluginTabBtn({
  id,
  label,
  icon,
  missing,
  pane,
  setPane,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  missing?: string[];
  pane: string;
  setPane: (p: string) => void;
}) {
  const needsSetup = (missing?.length ?? 0) > 0;
  const tooltip = needsSetup
    ? `${missing!.map((f) => `${f} is empty`).join(' · ')}`
    : label;
  const selected = pane === id;
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => setPane(id)}
        className={`h-tab h-config-tab${selected ? ' is-active' : ''}${needsSetup ? ' needs-setup' : ''}`}
        aria-pressed={selected}
        style={{
          background: selected ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'transparent',
          border: 0,
          borderBottom: '2px solid',
          borderBottomColor: selected ? 'var(--accent)' : 'transparent',
          color: selected ? 'var(--fg)' : 'var(--fg-mute)',
          padding: '6px 10px 5px',
          fontSize: 11,
          cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          borderRadius: 0,
          whiteSpace: 'nowrap',
          maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis',
          minHeight: 31,
          boxShadow: 'none',
          transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
        }}
      >
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {needsSetup && (
          <span
            aria-label="needs setup"
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: 'var(--bad)', flex: '0 0 auto',
            }}
          />
        )}
      </button>
    </Tooltip>
  );
}

export default function HarnessPluginsSection({ slug }: { slug: string }) {
  const ws = useWorkspaceId();
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pane, setPane] = useQueryState('pluginPane', parseAsString.withDefault(''));
  const [tabRailRef] = useAutoAnimate<HTMLDivElement>();

  // Installed plugins (re-fetched when a plugin is enabled/disabled below).
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/plugins/global', { cache: 'no-store', signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setInstalledPlugins(Array.isArray(d?.plugins) ? d.plugins : []))
      .catch(() => { /* leave null → empty state */ });
    return () => ac.abort();
  }, [refreshKey]);

  // Enabled-plugin slugs for this harness (Zero, live).
  const { data: pluginEnableRows } = useSyncQuery<{ harnessSlug: string; pluginSlug: string; enabled: boolean }>({
    queryName: 'pluginEnables.byWorkspace',
    args: { workspaceId: ws },
    enabled: !!ws,
  });
  const enabledSlugs = useMemo(() => {
    if (!Array.isArray(pluginEnableRows)) return [];
    return pluginEnableRows.filter((r) => r.enabled && r.harnessSlug === slug).map((r) => r.pluginSlug);
  }, [pluginEnableRows, slug]);

  // Missing required config per plugin → the "needs setup" dots on tabs.
  const { data: pluginConfigRows } = useSyncQuery<{ harnessSlug: string; pluginSlug: string; config: Record<string, unknown> | null }>({
    queryName: 'pluginConfigs.byHarness',
    args: { harnessSlug: slug, workspaceId: ws },
    enabled: !!slug && !!ws,
  });
  const pluginsMissing = useMemo<Record<string, string[]>>(
    () => computePluginsMissing(installedPlugins, enabledSlugs, pluginConfigRows),
    [installedPlugins, enabledSlugs, pluginConfigRows],
  );

  const enabledManifests = useMemo(
    () => dedupeEnabledManifests(installedPlugins, enabledSlugs),
    [installedPlugins, enabledSlugs],
  );

  // Keep the active pane valid — fall back to the first enabled plugin.
  useEffect(() => {
    if (enabledManifests.length === 0) return;
    if (!enabledManifests.some((p) => p.name === pane)) void setPane(enabledManifests[0]!.name);
  }, [pane, enabledManifests, setPane]);

  const activePlugin = enabledManifests.find((p) => p.name === pane) ?? enabledManifests[0];
  const onPluginsChange = () => setRefreshKey((k) => k + 1);

  return (
    <section style={{ marginBottom: 24, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Plugins</h2>
      {enabledManifests.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 11.5, fontStyle: 'italic' }}>
          No plugins enabled for this harness. Install and enable plugins, then configure them here.
        </p>
      ) : (
        <div className="h-config-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div ref={tabRailRef} className="h-config-rail" style={{
            display: 'flex', alignItems: 'stretch', gap: 2,
            borderBottom: '1px solid var(--border)',
            overflowX: 'auto',
            minHeight: 32,
          }}>
            {enabledManifests.map((p) => {
              const tabIcon = p.dashboardTabs?.[0]?.icon ?? p.icon ?? null;
              const display = p.name.includes('/') ? p.name.split('/').pop()! : p.name;
              return (
                <PluginTabBtn
                  key={p.name}
                  id={p.name}
                  label={display}
                  icon={<PluginIcon name={tabIcon} size={13} />}
                  missing={pluginsMissing[p.name]}
                  pane={activePlugin?.name ?? pane}
                  setPane={(v) => void setPane(v)}
                />
              );
            })}
          </div>
          <div style={{ paddingTop: 16 }}>
            {activePlugin && (
              <PluginPanelCard
                plugin={activePlugin}
                harnessSlug={slug}
                onChange={onPluginsChange}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const inlineCode: React.CSSProperties = {
  fontFamily: "'SF Mono', monospace", fontSize: 11,
  padding: '1px 6px', borderRadius: 3,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
};

function PluginPanelCard({ plugin, harnessSlug, onChange }: {
  plugin: EnabledPluginManifest;
  harnessSlug: string;
  onChange: () => void;
}) {
  const dirSlug = pluginSlugFromPath(plugin.path, plugin.name);
  const tabIcon = plugin.dashboardTabs?.[0]?.icon ?? plugin.icon ?? null;
  const [busy, setBusy] = useState(false);
  const [invoking, setInvoking] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const configPath = `~/.papercusp/harnesses/${harnessSlug}/plugin-configs/${dirSlug}.json`;
  const secretCaps = (plugin.capabilities ?? []).filter((c) => c.startsWith('secrets:read:'));
  const eventListens = (plugin.capabilities ?? []).filter((c) => c.startsWith('events:listen:'));
  const httpFetches = (plugin.capabilities ?? []).filter((c) => c.startsWith('http:fetch:'));

  async function disable() {
    if (!await askConfirm({
      title: `Disable ${plugin.name}?`,
      body: `${plugin.name} will stop running in ${harnessSlug}. The plugin's config is preserved.`,
      confirmLabel: 'Disable',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dirSlug, harnesses: [harnessSlug], disable: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Disable failed`, { description: d.results?.[0]?.log?.slice(-300) ?? d.error });
        return;
      }
      toast.success(`${plugin.name} disabled in ${harnessSlug}`);
      onChange();
    } catch (e: any) {
      toast.error(`Disable failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  }

  async function invoke(actionId: string) {
    setInvoking(actionId);
    try {
      const r = await fetch('/api/plugins/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dirSlug, action: actionId, harness: harnessSlug }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Invoke failed: ${actionId}`, { description: d.error ?? d.log?.slice(-300) });
        return;
      }
      toast.success(`Action ${actionId} fired`, {
        description: typeof d.result === 'string' ? d.result.slice(0, 200) : 'Check the action history for details.',
      });
    } catch (e: any) {
      toast.error(`Invoke failed: ${e?.message ?? e}`);
    } finally { setInvoking(null); }
  }

  return (
    <div className="pc-card h-plugin-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {confirmEl}
      <div className="h-plugin-card-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <span className="h-plugin-card-icon" style={{
          flex: '0 0 auto', width: 40, height: 40, borderRadius: 8,
          background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <PluginIcon name={tabIcon} size={20} />
        </span>
        <div className="h-plugin-card-main" style={{ flex: 1, minWidth: 0 }}>
          <div className="h-plugin-card-title-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h3 className="h-plugin-card-title" style={{ margin: 0, fontSize: 16 }}>{plugin.name}</h3>
            <span className="h-plugin-card-version" style={{ fontSize: 11, color: 'var(--fg-mute)', fontFamily: "'SF Mono', monospace" }}>
              v{plugin.version}
            </span>
            {(plugin.dashboardTabs?.length ?? 0) === 0 && (
              <span className="h-plugin-card-badge" style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
              }}>action-only</span>
            )}
          </div>
          {plugin.description && (
            <p className="h-plugin-card-description" style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
              {plugin.description}
            </p>
          )}
        </div>
        <Tooltip label="Disable this plugin (config preserved)">
          <Button
          size="lg"
          onClick={disable}
          disabled={busy}
          style={{ background: 'transparent', color: 'var(--bad)', border: '1px solid var(--border)', flex: '0 0 auto' }}
        >
          {busy ? 'Disabling…' : 'Disable'}
        </Button>
        </Tooltip>
      </div>

      {(plugin.actions?.length ?? 0) > 0 && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Actions</div>
          <div className="h-plugin-action-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plugin.actions!.map((a) => {
              const id = a.id ?? a.name ?? '?';
              return (
                <div key={id} className="h-plugin-action-row" style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
                  border: '1px solid var(--border)',
                }}>
                  <code className="h-plugin-action-id" style={{ fontSize: 12, fontFamily: "'SF Mono', monospace", flex: '0 0 auto' }}>{id}</code>
                  <span className="h-plugin-action-label" style={{ flex: 1, fontSize: 12, color: 'var(--fg-mute)' }}>
                    {a.label ?? a.description ?? ''}
                  </span>
                  <Tooltip label="Manually invoke this hook now">
                    <Button
                    size="lg"
                    variant="accent"
                    onClick={() => invoke(id)}
                    disabled={invoking !== null}
                    style={{ fontSize: 11, padding: '4px 10px', flex: '0 0 auto' }}
                  >
                    {invoking === id ? 'Invoking…' : 'Invoke'}
                  </Button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {eventListens.length > 0 && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Listens to events</div>
          <div className="h-plugin-tags" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {eventListens.map((c) => (
              <span key={c} className="h-plugin-tag" style={tagStyle}>{c.replace('events:listen:', '')}</span>
            ))}
          </div>
        </div>
      )}

      {(secretCaps.length > 0 || httpFetches.length > 0) && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Required capabilities</div>
          <div className="h-plugin-tags" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {secretCaps.map((c) => {
              const key = c.replace('secrets:read:', '');
              return <span key={c} className="h-plugin-tag h-plugin-tag-secret" style={{ ...tagStyle, color: 'var(--warn)', borderColor: 'rgba(251, 191, 36, 0.3)', background: 'rgba(251, 191, 36, 0.1)' }} title={`Set this with: papercusp secrets set ${key} <value>`}>secret: {key}</span>;
            })}
            {httpFetches.map((c) => (
              <span key={c} className="h-plugin-tag" style={tagStyle}>http: {c.replace('http:fetch:', '')}</span>
            ))}
          </div>
          {secretCaps.length > 0 && (
            <p className="h-plugin-cli-hint" style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-mute)' }}>
              Set secrets via the CLI:{' '}
              <code style={inlineCode}>papercusp secrets set {secretCaps[0]!.replace('secrets:read:', '')} &lt;value&gt;</code>
            </p>
          )}
        </div>
      )}

      <PluginConfigEditor
        harnessSlug={harnessSlug}
        dirSlug={dirSlug}
        configPath={configPath}
        configSchema={plugin.configSchema}
        defaultConfig={(plugin as { defaultConfig?: Record<string, unknown> }).defaultConfig}
      />
    </div>
  );
}

interface PluginConfigField {
  type?: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

function PluginConfigEditor({ harnessSlug, dirSlug, configPath, configSchema, defaultConfig }: {
  harnessSlug: string;
  dirSlug: string;
  configPath: string;
  configSchema?: { required?: string[]; properties?: Record<string, PluginConfigField> };
  defaultConfig?: Record<string, unknown>;
}) {
  const open = true;
  const [mode, setMode] = useQueryState('editorMode', parseAsStringEnum<'fields' | 'json'>(['fields', 'json']).withDefault('fields'));
  const [loaded, setLoaded] = useState<Record<string, unknown> | null>(null);
  const [draftJson, setDraftJson] = useState<string>('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Plugin schemas may omit `type` at the root — Ajv requires it. Normalize.
  const ajvSchema = useMemo(() => ({
    type: 'object',
    additionalProperties: true,
    ...(configSchema ?? {}),
  }), [configSchema]);

  const resolver = useMemo(() => makeAjvResolver(ajvSchema), [ajvSchema]);

  const {
    handleSubmit,
    reset: rhfReset,
    setValue,
    getValues,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Record<string, unknown>>({
    resolver,
    defaultValues: {},
    mode: 'onSubmit',
  });

  // Eager via Zero — pluginConfigs.byHarness returns all rows for this harness;
  // filter for the single (harnessSlug, pluginSlug) match. Avoid
  // pluginConfigs.byKey because it uses .one() which can return undefined even
  // when upstream has rows. byHarness + client-side find is robust.
  const pluginConfigEditorWs = useWorkspaceId();
  const { data: pluginConfigEditorRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    config: Record<string, unknown> | null;
  }>({
    queryName: 'pluginConfigs.byHarness',
    args: { harnessSlug, workspaceId: pluginConfigEditorWs },
    enabled: !!harnessSlug && !!dirSlug && !!pluginConfigEditorWs,
  });
  useEffect(() => {
    if (loaded !== null) return;
    if (!Array.isArray(pluginConfigEditorRows)) return;
    const row = pluginConfigEditorRows.find((r) => r.pluginSlug === dirSlug);
    if (!row) return;
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    setLoaded(cfg);
    rhfReset(cfg);
    setDraftJson(JSON.stringify(cfg, null, 2));
  }, [loaded, pluginConfigEditorRows, dirSlug, rhfReset]);

  // REST back-stop — fires only if Zero hasn't hydrated within ~600ms,
  // covering harnesses that pre-date the plugin_configs mirror.
  useEffect(() => {
    if (loaded !== null) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled || loaded !== null) return;
      fetch(`/api/plugins/config?harness=${encodeURIComponent(harnessSlug)}&plugin=${encodeURIComponent(dirSlug)}`, { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((d) => {
          if (cancelled || loaded !== null) return;
          const cfg = (d?.config ?? {}) as Record<string, unknown>;
          setLoaded(cfg);
          rhfReset(cfg);
          setDraftJson(JSON.stringify(cfg, null, 2));
        })
        .catch((e) => { if (!cancelled) setServerError(String(e?.message ?? e)); });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [loaded, harnessSlug, dirSlug, rhfReset]);

  function resetToLoaded() {
    if (loaded) {
      rhfReset(loaded);
      setDraftJson(JSON.stringify(loaded, null, 2));
    }
    setServerError(null);
  }
  function loadDefaults() {
    const obj: Record<string, unknown> = { ...(defaultConfig ?? {}) };
    if (configSchema?.properties) {
      for (const [k, v] of Object.entries(configSchema.properties)) {
        if (!(k in obj) && v.default !== undefined) obj[k] = v.default;
      }
    }
    rhfReset(obj);
    setDraftJson(JSON.stringify(obj, null, 2));
    setServerError(null);
  }

  async function persist(parsed: Record<string, unknown>) {
    setServerError(null);
    try {
      const r = await fetch('/api/plugins/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: harnessSlug, plugin: dirSlug, config: parsed }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setServerError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setLoaded(parsed);
      rhfReset(parsed);
      setDraftJson(JSON.stringify(parsed, null, 2));
      setSavedAt(Date.now());
      toast.success(`Config saved for ${dirSlug}`);
    } catch (e: any) {
      setServerError(String(e?.message ?? e));
    }
  }

  // Submit handler dispatches based on which mode is active so JSON mode
  // round-trips through JSON.parse before ajvResolver validates.
  async function onClickSave() {
    if (mode === 'json') {
      let parsed: Record<string, unknown>;
      try {
        const j = JSON.parse(draftJson);
        if (typeof j !== 'object' || j === null || Array.isArray(j)) {
          setServerError('Config must be a JSON object.');
          return;
        }
        parsed = j as Record<string, unknown>;
      } catch (e: any) {
        setServerError(`Invalid JSON: ${e?.message ?? e}`);
        return;
      }
      await persist(parsed);
    } else {
      void handleSubmit(async (data) => {
        await persist(pruneEmptyConfig(data));
      })();
    }
  }

  // Switch modes — keep state in sync.
  function toggleMode() {
    if (mode === 'fields') {
      setDraftJson(JSON.stringify(getValues(), null, 2));
      setMode('json');
    } else {
      try {
        const j = JSON.parse(draftJson);
        if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
          rhfReset(j as Record<string, unknown>);
        }
      } catch { /* keep RHF state as-is */ }
      setMode('fields');
    }
  }

  const dirty = mode === 'json'
    ? (loaded !== null && draftJson !== JSON.stringify(loaded, null, 2))
    : isDirty;
  const schemaKeys = Object.keys(configSchema?.properties ?? {});
  const requiredSet = new Set(configSchema?.required ?? []);
  // Subscribe to changes so the field-mode renderer sees up-to-date values.
  watch();

  return (
    <div className="h-plugin-config-editor" style={{
      marginTop: 4, padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
      border: '1px solid var(--border)',
    }}>
      <div className="h-plugin-config-editor-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="h-plugin-config-editor-meta" style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
          <span className="h-plugin-config-title" style={{ fontWeight: 600, color: 'var(--fg-dim)', marginRight: 8 }}>Config</span>
          <code className="h-plugin-config-path" style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>{configPath}</code>
          {schemaKeys.length > 0 && (
            <span className="h-plugin-config-keys" style={{ marginLeft: 12, color: 'var(--fg-mute)' }}>
              keys: {schemaKeys.map((k) => <code key={k} className="h-plugin-config-key" style={{ ...inlineCode, fontSize: 10, marginLeft: 4 }}>{k}</code>)}
            </span>
          )}
        </div>
      </div>

      {open && (
        <div className="h-plugin-config-content" style={{ marginTop: 10 }}>
          {serverError && (
            <div className="h-plugin-config-error" style={{
              marginBottom: 8, padding: '6px 10px',
              background: '#450a0a', color: 'var(--bad)',
              border: '1px solid #7f1d1d', borderRadius: 4,
              fontSize: 11,
            }}>{serverError}</div>
          )}
          {loaded === null ? (
            <div className="h-plugin-config-loading" style={{ padding: '16px 8px', fontSize: 12, color: 'var(--fg-mute)' }}>Loading config…</div>
          ) : mode === 'fields' && schemaKeys.length > 0 ? (
            <div className="h-plugin-config-fields" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 8 }}>
              {schemaKeys.map((key) => {
                const field = (configSchema?.properties ?? {})[key]!;
                const required = requiredSet.has(key);
                const values = getValues();
                const current = (key in values) ? values[key] : (field.default ?? '');
                const fieldError = errors[key]?.message ? String(errors[key]!.message) : undefined;
                return (
                  <div key={key} className="h-config-field">
                    <label className="h-plugin-config-field-label" style={pluginFieldLabel}>
                      {key} {required && <span style={{ color: 'var(--bad)' }}>*</span>}
                    </label>
                    {field.description && (
                      <div className="h-plugin-config-field-description" style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 3 }}>{field.description}</div>
                    )}
                    {renderPluginConfigInput(key, field, current, (v) => setValue(key, v, { shouldDirty: true, shouldValidate: false }))}
                    {fieldError && (
                      <div role="alert" style={{ marginTop: 4, fontSize: 11, color: 'var(--bad)' }}>{fieldError}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-plugin-config-json" style={{ height: Math.min(420, Math.max(160, (draftJson.split('\n').length + 1) * 18)), border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
              <MonacoEditor
                height="100%"
                language="json"
                theme="vs-dark"
                value={draftJson}
                onChange={(v) => setDraftJson(v ?? '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </div>
          )}
          <div className="h-plugin-config-footer" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Tooltip label="Save plugin config changes">
              <Button
              size="lg"
              variant="accent"
              onClick={onClickSave}
              disabled={isSubmitting || !dirty}
              style={{ fontSize: 12, padding: '4px 12px' }}
            >{isSubmitting ? 'Saving…' : dirty ? 'Save' : 'No changes'}</Button>
            </Tooltip>
            <Tooltip label="Discard unsaved config changes">
              <button
              type="button"
              onClick={resetToLoaded}
              disabled={isSubmitting || !dirty}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--fg-mute)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Reset</button>
            </Tooltip>
            <Tooltip label="Replace draft with the plugin's defaultConfig + configSchema defaults">
              <button
              type="button"
              onClick={loadDefaults}
              disabled={isSubmitting}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--fg-mute)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Load defaults</button>
            </Tooltip>
            {schemaKeys.length > 0 && (
              <Tooltip label={mode === 'fields' ? 'Switch to raw JSON editing' : 'Switch back to schema-driven form'}>
                <button
                type="button"
                onClick={toggleMode}
                disabled={isSubmitting}
                style={{
                  fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                  background: 'transparent', color: 'var(--fg-mute)',
                  border: '1px solid var(--border)', borderRadius: 4,
                }}
              >{mode === 'fields' ? 'Edit as JSON' : 'Edit as form'}</button>
              </Tooltip>
            )}
            {savedAt && !dirty && (
              <span className="h-plugin-config-saved" style={{ fontSize: 10, color: 'var(--good)' }}>
                ✓ saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
            <span className="h-plugin-config-cli" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-mute)' }}>
              CLI:{' '}
              <code style={inlineCode}>papercusp plugin config {dirSlug} --harness {harnessSlug}</code>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function renderPluginConfigInput(
  key: string,
  field: PluginConfigField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactElement {
  const baseInput: React.CSSProperties = {
    width: '100%', padding: '6px 9px', fontSize: 12,
    background: 'var(--bg-2)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: 5,
    fontFamily: 'inherit', boxSizing: 'border-box',
    minHeight: 30,
  };
  if (field.type === 'boolean') {
    return (
      <Checkbox
        checked={!!value}
        onChange={onChange}
        ariaLabel={key}
        style={{ width: 16, height: 16 }}
      />
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        type="number"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        style={baseInput}
      />
    );
  }
  if (field.enum && Array.isArray(field.enum)) {
    const EMPTY_ENUM_VALUE = '__empty_enum_value__';
    const current = String(value ?? '');
    return (
      <Select
        value={current === '' ? EMPTY_ENUM_VALUE : current}
        onChange={(next) => onChange(next === EMPTY_ENUM_VALUE ? '' : next)}
        options={field.enum.map((opt) => {
          const stringValue = String(opt);
          return { value: stringValue === '' ? EMPTY_ENUM_VALUE : stringValue, label: stringValue };
        })}
        ariaLabel={key}
        triggerStyle={{ ...baseInput, justifyContent: 'space-between' }}
        contentStyle={{ zIndex: 90 }}
      />
    );
  }
  const isSecret = /token|key|secret|password|pat\b/i.test(key);
  return (
    <input
      type={isSecret ? 'password' : 'text'}
      value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
      onChange={(e) => onChange(e.target.value)}
      style={baseInput}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

const pluginFieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)', marginBottom: 3,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
  color: 'var(--fg-mute)', marginBottom: 8,
};
const tagStyle: React.CSSProperties = {
  fontSize: 11, fontFamily: "'SF Mono', monospace",
  padding: '2px 8px', borderRadius: 4,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
};
