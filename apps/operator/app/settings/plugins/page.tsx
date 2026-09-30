/**
 * Settings → Plugins
 *
 * Per-harness plugin configuration UI. Lists every installed plugin that
 * declares a `configSchema`, lets the operator pick a harness, and renders
 * a generic JSON-schema-driven form (string / boolean / number / required
 * markers) backed by `GET|PUT /api/plugins/config?harness=<slug>&plugin=<dir>`.
 *
 * Settings are per-harness because the underlying contract is per-harness:
 * each harness owns its own plugin-configs directory under
 * `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json`. A future
 * "global plugin defaults" surface would layer above this.
 */
'use client';

import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import RouteLink from '@/app/_components/RouteLink';
import { makeAjvResolver } from '@/lib/forms';
import { useLexicon } from '@/lib/useLexicon';
import { ProvisionPanel } from './ProvisionPanel';
import { Select } from '../../harness/Select';
import { Checkbox } from '../../harness/Checkbox';

interface InstalledPlugin {
  name: string;
  version?: string;
  description?: string;
  path?: string;
  configSchema?: { type?: string; required?: string[]; properties?: Record<string, ConfigField> };
  provision?: {
    setup?: { path: string; timeoutSec?: number };
    teardown?: { path: string; timeoutSec?: number };
    verify?: { path: string; timeoutSec?: number };
    cloudProvider?: { id: string; region?: string; regions?: string[] };
    allowedHosts?: string[];
  };
}

interface ConfigField {
  type?: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  default?: unknown;
  description?: string;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  /** Share-semantics annotations (V1). */
  secret?: boolean;
  shareable?: boolean;
  snapshotPolicy?: 'strip' | 'include' | 'warn-and-prompt';
  oauth?: { provider: string; scopes?: string[] };
}

interface HarnessRow {
  slug: string;
  version?: string | null;
  description?: string | null;
}

function pluginDirSlug(name: string): string {
  // Mirror plugin-loader's safe-name rule: take the last segment of an
  // npm-scoped name (`@papercupai/foo` → `foo`).
  const last = name.split('/').pop() ?? name;
  return last.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export default function PluginSettingsPage() {
  const t = useLexicon();
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessRow[]>([]);
  const [enabledByHarness, setEnabledByHarness] = useState<Record<string, string[]>>({});
  // Drilldown selection — URL-backed for deep-links + agent visibility.
  const [activeHarness, setActiveHarness] = useQueryState('ph', parseAsString.withDefault(''));
  const [activePlugin, setActivePlugin] = useQueryState('pp', parseAsString.withDefault(''));
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial load: plugins + harnesses + enabled state.
  useEffect(() => {
    (async () => {
      try {
        const [a, b, c] = await Promise.all([
          fetch('/api/plugins/global', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/installed', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/plugins/enabled', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        setPlugins(Array.isArray(a?.plugins) ? a.plugins : []);
        setHarnesses(Array.isArray(b?.harnesses) ? b.harnesses : []);
        setEnabledByHarness(c?.enabled ?? {});
      } catch (e: any) {
        toast.error(`load failed: ${e?.message ?? e}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Plugins worth showing: those that declare a configSchema.
  const configurable = useMemo(
    () => (plugins ?? []).filter((p) => p.configSchema && Object.keys(p.configSchema.properties ?? {}).length > 0),
    [plugins],
  );

  // Default harness selection: first harness that has any plugin enabled.
  useEffect(() => {
    if (!activeHarness && harnesses.length > 0) {
      const firstWithPlugins = harnesses.find((h) => (enabledByHarness[h.slug]?.length ?? 0) > 0);
      setActiveHarness(firstWithPlugins?.slug ?? harnesses[0].slug);
    }
  }, [harnesses, enabledByHarness, activeHarness]);

  const activePluginManifest = configurable.find((p) => p.name === activePlugin);
  const enabledHere = !!activeHarness && (enabledByHarness[activeHarness] ?? []).some(
    (s) => s === activePlugin || s === pluginDirSlug(activePlugin),
  );

  // Plugin schemas may omit `type` at the root; Ajv requires it.
  const ajvSchema = useMemo(() => ({
    type: 'object',
    additionalProperties: true,
    ...(activePluginManifest?.configSchema ?? {}),
  }), [activePluginManifest?.configSchema]);
  const resolver = useMemo(() => makeAjvResolver(ajvSchema), [ajvSchema]);

  const {
    handleSubmit: rhfSubmit,
    setValue,
    getValues,
    reset: rhfReset,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Record<string, unknown>>({
    resolver,
    defaultValues: {},
    mode: 'onSubmit',
  });
  watch();

  // When harness or plugin changes, fetch its current config and reset RHF.
  useEffect(() => {
    if (!activeHarness || !activePlugin) return;
    setConfig(null);
    rhfReset({});
    const dirSlug = pluginDirSlug(activePlugin);
    fetch(`/api/plugins/config?harness=${encodeURIComponent(activeHarness)}&plugin=${encodeURIComponent(dirSlug)}`)
      .then((r) => r.json())
      .then((d) => {
        const cfg = (d?.config ?? {}) as Record<string, unknown>;
        setConfig(cfg);
        rhfReset(cfg);
      })
      .catch((e) => toast.error(`config load failed: ${e?.message ?? e}`));
  }, [activeHarness, activePlugin, rhfReset]);

  const onSave = rhfSubmit(async (data) => {
    if (!activeHarness || !activePlugin) return;
    if (!isDirty) {
      toast.message('No changes to save.');
      return;
    }
    try {
      // Empty strings drop the key (preserves "no value, fall back to default").
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' && v.length === 0) continue;
        merged[k] = v;
      }
      const r = await fetch('/api/plugins/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harness: activeHarness,
          plugin: pluginDirSlug(activePlugin),
          config: merged,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      toast.success(`Saved ${activePlugin} config`, { description: `hash ${(d.configHash ?? '').slice(0, 16)}…` });
      setConfig(merged);
      rhfReset(merged);
    } catch (e: any) {
      toast.error(`save failed: ${e?.message ?? e}`);
    }
  });

  if (loading) return <div><h1>Plugins</h1><p className="pc-settings-loading">Loading…</p></div>;

  return (
    <div>
      <h1>Plugins</h1>
      <p className="pc-settings-intro">
        Per-{t('pot')} configuration for installed plugins. Reads/writes{' '}
        <code>~/.papercusp/harnesses/&lt;slug&gt;/plugin-configs/</code>.
        See <RouteLink href="/settings/plugins/tools" style={{ color: 'var(--fg)' }}>tools contributed by plugins →</RouteLink>
      </p>

      {harnesses.length === 0 ? (
        <p>No {t('pot', { plural: true, lower: true })} installed yet.</p>
      ) : configurable.length === 0 ? (
        <p>No installed plugin declares a <code>configSchema</code>.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24 }}>
          <aside>
            <label style={lbl}>{t('pot')}</label>
            <Select
              value={activeHarness}
              onChange={(v) => { setActiveHarness(v); setActivePlugin(''); }}
              ariaLabel={t('pot')}
              options={harnesses.map((h) => ({ value: h.slug, label: h.slug }))}
              triggerStyle={input}
            />

            <label style={{ ...lbl, marginTop: 16 }}>Plugin</label>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {configurable.map((p) => {
                const isActive = p.name === activePlugin;
                const enabled = (enabledByHarness[activeHarness] ?? []).some(
                  (s) => s === p.name || s === pluginDirSlug(p.name),
                );
                return (
                  <li key={p.name}>
                    <Tooltip label={enabled ? '' : `Not enabled in this ${t('pot', { lower: true })}`}><button
                      type="button"
                      onClick={() => setActivePlugin(p.name)}
                      style={{
                        ...pluginBtn,
                        background: isActive ? 'var(--bg-1)' : 'transparent',
                        opacity: enabled ? 1 : 0.55,
                      }}

                    >
                      {p.name.split('/').pop()}
                      {!enabled && <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--fg-mute)' }}>off</span>}
                    </button></Tooltip>
                  </li>
                );
              })}
            </ul>
          </aside>

          <main>
            {!activePlugin ? (
              <p style={{ color: 'var(--fg-mute)' }}>Select a plugin on the left to configure it.</p>
            ) : !activePluginManifest ? (
              <p>Plugin not found.</p>
            ) : (
              <form onSubmit={onSave}>
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ margin: '0 0 4px' }}>{activePluginManifest.name}</h3>
                  <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>v{activePluginManifest.version}</div>
                  {activePluginManifest.description && (
                    <p style={{ margin: '8px 0 0', fontSize: 13 }}>{activePluginManifest.description}</p>
                  )}
                  {!enabledHere && (
                    <div style={notice}>
                      Not currently enabled on <strong>{activeHarness}</strong>. Saved config will apply
                      once you enable it from the {t('pot')} dashboard's plugin picker.
                    </div>
                  )}
                </div>
                {Object.entries(activePluginManifest.configSchema!.properties ?? {}).map(([key, field]) => {
                  const required = activePluginManifest.configSchema!.required?.includes(key);
                  const values = getValues();
                  const current = (key in values) ? values[key] : config?.[key] ?? field.default ?? '';
                  const fieldError = errors[key]?.message ? String(errors[key]!.message) : undefined;
                  return (
                    <div key={key} style={{ marginBottom: 16 }}>
                      <label style={lbl}>
                        {key} {required && <span style={{ color: 'var(--bad)' }}>*</span>}
                        {field.shareable === false && (
                          <span style={badgeMute} title="Stripped from snapshots — must be re-supplied at fork time">publisher-specific</span>
                        )}
                        {field.secret && (
                          <span style={badgeWarn} title="Stripped from snapshots by default">secret</span>
                        )}
                        {field.oauth && (
                          <span style={badgeAccent} title={`OAuth provider: ${field.oauth.provider}`}>oauth</span>
                        )}
                      </label>
                      {field.description && (
                        <div style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 4 }}>{field.description}</div>
                      )}
                      {field.oauth ? (
                        <OAuthFieldEditor
                          plugin={pluginDirSlug(activePlugin)}
                          harness={activeHarness}
                          field={key}
                          provider={field.oauth.provider}
                          scopes={field.oauth.scopes ?? []}
                          currentValue={typeof current === 'string' ? current : ''}
                        />
                      ) : (
                        renderInput(key, field, current, (v) => setValue(key, v, { shouldDirty: true, shouldValidate: false }))
                      )}
                      {fieldError && (
                        <div role="alert" style={{ marginTop: 4, fontSize: 11, color: 'var(--bad)' }}>{fieldError}</div>
                      )}
                    </div>
                  );
                })}
                <button type="submit" disabled={isSubmitting || !isDirty} style={primary}>
                  {isSubmitting ? 'Saving…' : isDirty ? 'Save' : 'No changes'}
                </button>
                {activePluginManifest.provision && enabledHere && (
                  <ProvisionPanel
                    harness={activeHarness}
                    plugin={pluginDirSlug(activePlugin)}
                    provision={activePluginManifest.provision}
                  />
                )}
              </form>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function renderInput(
  key: string,
  field: ConfigField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactElement {
  if (field.type === 'boolean') {
    return (
      <Checkbox
        checked={!!value}
        onChange={(v) => onChange(v)}
        ariaLabel={key}
      />
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        type="number"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => {
          const n = e.target.value === '' ? '' : Number(e.target.value);
          onChange(n);
        }}
        style={input}
      />
    );
  }
  if (field.enum && Array.isArray(field.enum)) {
    return (
      <Select
        value={String(value ?? '')}
        onChange={(v) => onChange(v)}
        ariaLabel={key}
        options={field.enum.map((opt) => ({ value: String(opt), label: String(opt) }))}
        triggerStyle={input}
      />
    );
  }
  // Strings — secret-ish keys get type=password.
  const isSecret = /token|key|secret|password/i.test(key);
  return (
    <input
      type={isSecret ? 'password' : 'text'}
      value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
      onChange={(e) => onChange(e.target.value)}
      style={input}
      autoComplete="off"
    />
  );
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--fg-mute)', marginBottom: 4,
  textTransform: 'uppercase',
};
const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-1)',
  border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)',
  fontSize: 13, fontFamily: 'inherit',
};
const pluginBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
  border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)',
  background: 'transparent', cursor: 'pointer', fontSize: 13, marginBottom: 4,
};
const primary: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--accent)', color: 'var(--accent-ink)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
};
const notice: React.CSSProperties = {
  marginTop: 12, padding: '8px 12px', background: 'var(--warn-bg)',
  border: '1px solid var(--warn-border)', borderRadius: 4, fontSize: 12, color: 'var(--warn)',
};
const badgeBase: React.CSSProperties = {
  display: 'inline-block', marginLeft: 8, padding: '1px 6px', borderRadius: 3,
  fontSize: 10, fontWeight: 500, textTransform: 'uppercase',
  verticalAlign: 'middle',
};
const badgeMute: React.CSSProperties = {
  ...badgeBase, background: 'color-mix(in srgb, var(--fg-mute), transparent 88%)', color: 'var(--fg-mute)', border: '1px solid color-mix(in srgb, var(--fg-mute), transparent 75%)',
};
const badgeWarn: React.CSSProperties = {
  ...badgeBase, background: 'var(--warn-bg)', color: 'var(--warn)', border: '1px solid var(--warn-border)',
};
const badgeAccent: React.CSSProperties = {
  ...badgeBase, background: 'color-mix(in srgb, var(--accent), transparent 88%)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent), transparent 70%)',
};

/* ─── OAuth field editor — Connect button + Advanced (paste PAT with scope verify) ─── */

interface OAuthFieldEditorProps {
  plugin: string;
  harness: string;
  field: string;
  provider: string;
  scopes: string[];
  currentValue: string;
}

function OAuthFieldEditor({ plugin, harness, field, provider, scopes, currentValue }: OAuthFieldEditorProps) {
  const [advanced, setAdvanced] = useQueryState('advanced', parseAsBoolean.withDefault(false));
  const [pastedToken, setPastedToken] = useState('');
  const [verifying, setVerifying] = useState(false);
  const connected = currentValue.length > 0;

  const startUrl = `/api/oauth/start?provider=${encodeURIComponent(provider)}` +
    `&plugin=${encodeURIComponent(plugin)}` +
    `&harness=${encodeURIComponent(harness)}` +
    `&field=${encodeURIComponent(field)}` +
    `&scopes=${encodeURIComponent(scopes.join(','))}`;

  async function verifyPaste() {
    if (!pastedToken) return;
    setVerifying(true);
    try {
      const r = await fetch('/api/oauth/verify-paste', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider, plugin, harness, field,
          token: pastedToken,
          requiredScopes: scopes,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`paste rejected: ${d.error ?? `HTTP ${r.status}`}`);
        return;
      }
      if (d.outcome === 'superset') {
        toast.warning(`Token has more scopes than needed`, {
          description: `extra: ${(d.extra ?? []).join(', ')}`,
        });
      } else {
        toast.success(`Connected via paste-PAT (${d.outcome ?? 'ok'})`);
      }
      setPastedToken('');
      // Reload page to refresh config display.
      window.location.reload();
    } catch (e: any) {
      toast.error(`verify failed: ${e?.message ?? e}`);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div>
      {connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span style={{ color: 'var(--good)' }}>● Connected</span>
          <a href={startUrl} style={linkBtn}>Reconnect</a>
        </div>
      ) : (
        <a href={startUrl} style={connectBtn}>Connect with {provider}</a>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={() => setAdvanced((a) => !a)} style={advBtn}>
          {advanced ? '▾' : '▸'} Advanced: paste a token
        </button>
      </div>
      {advanced && (
        <div style={advPanel}>
          <input
            type="password"
            placeholder={`paste a ${provider} token (scopes: ${scopes.join(', ') || 'any'})`}
            value={pastedToken}
            onChange={(e) => setPastedToken(e.target.value)}
            style={input}
            autoComplete="off"
          />
          <button
            type="button"
            disabled={verifying || !pastedToken}
            onClick={verifyPaste}
            style={primary}
          >
            {verifying ? 'Verifying…' : 'Verify + save'}
          </button>
          <p style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 6 }}>
            We'll hit the provider's introspection endpoint to confirm the
            token has the scopes this plugin needs. Tokens with too few
            scopes are rejected; tokens with extra scopes warn but save.
          </p>
        </div>
      )}
    </div>
  );
}

const connectBtn: React.CSSProperties = {
  display: 'inline-block', padding: '6px 12px', background: 'var(--accent)', color: 'var(--accent-ink)',
  borderRadius: 4, textDecoration: 'none', fontSize: 13, fontWeight: 600,
};
const linkBtn: React.CSSProperties = {
  fontSize: 12, color: 'var(--fg-mute)', textDecoration: 'underline',
};
const advBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--fg-mute)',
  fontSize: 12, cursor: 'pointer', padding: 0,
};
const advPanel: React.CSSProperties = {
  marginTop: 8, padding: 10, border: '1px solid var(--border)',
  borderRadius: 4, background: 'color-mix(in srgb, var(--fg), transparent 98%)',
  display: 'flex', flexDirection: 'column', gap: 8,
};
