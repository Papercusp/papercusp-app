'use client';


import { Button } from '@/app/harness/Button';
import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast } from 'sonner';
import RouteLink from '../../_components/RouteLink';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';

interface InstalledPluginRecord {
  name: string;
  version?: string;
  description?: string;
  source: string;
  path: string;
  hidden?: boolean;
}

interface UpdateRow {
  slug: string;
  name: string;
  installed: string;
  available: string;
  capChange: { added: string[]; removed: string[]; unchanged: string[] };
}

interface RuntimeStatusRow {
  plugin: string;
  runtime: 'wasm' | 'daemon';
  pid?: number;
  restartCount?: number;
  ok: boolean;
  loadedFor: string[];
}

interface CapabilityUnsatisfiedOutcome {
  code: 'capability_unsatisfied';
  potSlug: string;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  requiredBy: string[];
  optionalFor: string[];
  routes: ['operator-notify', 'suggest-provider', 'needs_human'];
  detail: string;
}

interface ProviderUninstallReview {
  providerPackage: string;
  providerVersion: string;
  bindings: Array<{ potSlug: string; classRef: string }>;
  dependents: Array<{ potSlug: string; identityRef: string; classRef: string; optional: boolean }>;
  capabilityUnsatisfied: CapabilityUnsatisfiedOutcome[];
  reviewToken: string;
}

export default function InstalledPluginsPage() {
  const t = useLexicon();
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});
  const [updates, setUpdates] = useState<Record<string, UpdateRow>>({});
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [uninstallOutcomes, setUninstallOutcomes] = useState<CapabilityUnsatisfiedOutcome[]>([]);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // pluginEnables is in Zero already (pluginEnables.byWorkspace). The
  // /plugins/global side is still REST — it's a cross-workspace listing
  // of installed plugins, not workspace-keyed. Two-phase load: render
  // the enabled-map from the cached subscription synchronously, then
  // pull plugin metadata from REST (typically <100ms cold).
  const pluginsWorkspaceId = useWorkspaceId();
  const { data: pluginEnableRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    enabled: boolean;
  }>({
    queryName: 'pluginEnables.byWorkspace',
    args: { workspaceId: pluginsWorkspaceId },
    enabled: !!pluginsWorkspaceId,
  });
  useEffect(() => {
    if (!Array.isArray(pluginEnableRows)) return;
    const m: Record<string, string[]> = {};
    for (const r of pluginEnableRows) {
      if (!r.enabled) continue;
      (m[r.harnessSlug] ??= []).push(r.pluginSlug);
    }
    setEnabledMap(m);
  }, [pluginEnableRows]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [pluginsRes, updatesRes, runtimeRes] = await Promise.all([
          fetch('/api/plugins/global', { cache: 'no-store' }),
          fetch('/api/plugins/updates', { cache: 'no-store' }),
          fetch('/api/plugins/host/runtime-status', { cache: 'no-store' }),
        ]);
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        const updatesJson = updatesRes.ok ? await updatesRes.json() : { updates: [] };
        const runtimeJson = runtimeRes.ok ? await runtimeRes.json() : { rows: [] };
        if (cancelled) return;
        const list = Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : [];
        setPlugins(list.filter((p: InstalledPluginRecord) => !p.hidden));
        const upd: Record<string, UpdateRow> = {};
        for (const u of updatesJson?.updates ?? []) upd[u.slug] = u;
        setUpdates(upd);
        setRuntimeStatus(Array.isArray(runtimeJson?.rows) ? runtimeJson.rows : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function update(slug: string) {
    const u = updates[slug];
    if (!u) return;
    if (u.capChange.added.length > 0) {
      const lines = u.capChange.added.map((c) => `  • ${c}`).join('\n');
      const ok = await askConfirm({
        title: `${slug}: v${u.installed} → v${u.available}`,
        body: `New capabilities this version requests:\n${lines}`,
        confirmLabel: 'Continue update',
      });
      if (!ok) return;
    }
    // Plugin install/update flows through the Cupboard now (kind=plugin) — the
    // legacy :3057 /api/marketplace/install-plugin route is retired
    // (revive-cupboard-distribution D-004). Direct the user to the Cupboard to
    // reinstall at the new version.
    toast.info(`Update ${slug} from the Cupboard`, {
      description: `Plugin install/update is now in the Cupboard (kind=plugin). Open the Cupboard and reinstall ${slug} to pick up v${u.available}.`,
      duration: 8000,
    });
  }

  async function uninstall(slug: string) {
    const ok = await askConfirm({
      title: `Remove ${slug}?`,
      body: `Plugin will be disabled in every ${t('pot', { lower: true })} it was enabled in.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusy(slug);
    try {
      let r = await fetch('/api/plugins/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      let d = await r.json() as {
        ok?: boolean;
        error?: string;
        detail?: string;
        review?: ProviderUninstallReview;
        capabilityUnsatisfied?: CapabilityUnsatisfiedOutcome[];
      };
      if (r.status === 409 && d.error === 'provider_has_capability_dependents' && d.review) {
        const review = d.review;
        const proceed = await askConfirm({
          title: `${slug} provides capabilities to ${review.bindings.length} pot binding${review.bindings.length === 1 ? '' : 's'}`,
          body: (
            <div data-testid="plugin-uninstall-dependent-review" style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0 }}>
                Removing <code>{review.providerPackage}@{review.providerVersion}</code> immediately unbinds these capability classes.
                Each affected live-agent path is represented as a typed <code>capability_unsatisfied</code> outcome instead of an unnamed missing tool.
              </p>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {review.capabilityUnsatisfied.map((outcome) => (
                  <li key={`${outcome.potSlug}:${outcome.classRef}`}>
                    <code>{outcome.potSlug}</code> · <code>{outcome.classRef}</code>
                    {outcome.requiredBy.length > 0 ? ` · required by ${outcome.requiredBy.join(', ')}` : ''}
                    {outcome.optionalFor.length > 0 ? ` · optional for ${outcome.optionalFor.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ),
          confirmLabel: 'Unbind and remove',
          destructive: true,
        });
        if (!proceed) return;
        r = await fetch('/api/plugins/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, capabilityReviewToken: review.reviewToken }),
        });
        d = await r.json() as typeof d;
      }
      if (!r.ok || !d.ok) {
        toast.error(`${d.error ?? 'uninstall failed'}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      const outcomes = d.capabilityUnsatisfied ?? [];
      setUninstallOutcomes(outcomes);
      toast.success(
        `${slug} removed` +
        (outcomes.length > 0
          ? ` — ${outcomes.length} capability binding${outcomes.length === 1 ? '' : 's'} now report capability_unsatisfied.`
          : ''),
      );
      setTimeout(() => setReloadKey((k) => k + 1), 400);
    } finally {
      setBusy(null);
    }
  }

  const runtimeStatusColumns: ColumnDef<RuntimeStatusRow>[] = [
    {
      key: 'plugin', header: 'Plugin', width: 2,
      toCopyText: (r) => r.plugin,
      render: ({ row }) => <>{row.plugin}</>,
    },
    {
      key: 'runtime', header: 'Runtime', width: 1,
      toCopyText: (r) => r.runtime,
      render: ({ row }) => <code style={{ fontSize: 11 }}>{row.runtime}</code>,
    },
    {
      key: 'loadedFor', header: 'Loaded for', width: 2,
      toCopyText: (r) => r.loadedFor.join(', '),
      render: ({ row }) => row.loadedFor.length > 0 ? <>{row.loadedFor.join(', ')}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'pid', header: 'PID', width: 1, align: 'right',
      toCopyText: (r) => r.pid != null ? String(r.pid) : '',
      render: ({ row }) => row.pid != null ? <>{row.pid}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'restarts', header: 'Restarts', width: 1, align: 'right',
      toCopyText: (r) => r.restartCount != null ? String(r.restartCount) : '',
      render: ({ row }) => row.restartCount != null ? <>{row.restartCount}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'ok', header: 'OK', width: 1, align: 'center',
      toCopyText: (r) => r.ok ? 'OK' : 'FAIL',
      render: ({ row }) => (
        <span style={{ color: row.ok ? 'var(--good)' : 'var(--bad)' }}>
          {row.ok ? '●' : '○'}
        </span>
      ),
    },
  ];

  return (
    <div className="pc-shell pc-marketplace-shell">
      {confirmEl}
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Installed plugins</p>
          <h1>Plugins on this machine.</h1>
          <p>Plugins you've installed locally. Each card shows where it's enabled.</p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Installed plugins">
          <div><strong>{plugins.length}</strong><span>installed</span></div>
          {Object.keys(updates).length > 0 && (
            <div style={{ background: 'var(--accent, #22d3ee)', color: 'var(--accent-ink, #051827)' }}>
              <strong>{Object.keys(updates).length}</strong>
              <span>update{Object.keys(updates).length === 1 ? '' : 's'}</span>
            </div>
          )}
          {runtimeStatus.length > 0 && (
            <div style={{ background: 'var(--bg-3)' }}>
              <strong>{runtimeStatus.length}</strong>
              <span>non-JS runtime{runtimeStatus.length === 1 ? '' : 's'}</span>
            </div>
          )}
        </div>
      </section>
      {uninstallOutcomes.length > 0 && (
        <section className="pc-card" data-testid="plugin-uninstall-capability-outcomes" style={{ padding: 12, marginBottom: 12 }}>
          <p className="pc-eyebrow" style={{ marginBottom: 8 }}>Capability bindings removed</p>
          <p style={{ margin: '0 0 8px' }}>
            The uninstall returned <code>capability_unsatisfied</code> for these classes, with the defined next routes:
            operator notification, provider suggestion, or <code>needs_human</code>.
          </p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {uninstallOutcomes.map((outcome) => (
              <li key={`${outcome.potSlug}:${outcome.classRef}`}>
                <code>{outcome.potSlug}</code> · <code>{outcome.classRef}</code> — {outcome.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      {runtimeStatus.length > 0 && (
        <section className="pc-card" style={{ padding: 12, marginBottom: 12 }}>
          <p className="pc-eyebrow" style={{ marginBottom: 8 }}>Plugin runtime status</p>
          <div style={{ height: Math.min(360, 36 + runtimeStatus.length * 32 + 4) }}>
            <RichGrid<RuntimeStatusRow>
              columns={runtimeStatusColumns}
              rows={runtimeStatus}
              getRowId={(r) => `${r.plugin}::${r.runtime}`}
              rowMinHeight={32}
              headerHeight={32}
            />
          </div>
        </section>
      )}
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading installed plugins…</div>
      ) : plugins.length === 0 ? (
        <div className="pc-card pc-marketplace-empty">
          <strong>No plugins installed yet.</strong>
          <span>Browse the <RouteLink href="/cupboard?kind=plugin">Cupboard plugin catalog</RouteLink> to install one.</span>
        </div>
      ) : (
        <div className="pc-marketplace-grid pc-installed-plugin-grid">
          {plugins.map((p) => {
            const enabledHere = Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.name)).map(([h]) => h);
            return (
              <article key={p.name} className="pc-card pc-marketplace-card installed pc-installed-plugin-card">
                <div className="pc-marketplace-card-head">
                  <span className="pc-marketplace-card-icon plugin"><Lucide.Puzzle size={18} /></span>
                  <div>
                    <RouteLink href="/cupboard?kind=plugin" className="pc-marketplace-card-title">{p.name}</RouteLink>
                    <span>{p.source}</span>
                  </div>
                  <em>Installed</em>
                </div>
                <p>{p.description ?? `Installed from ${p.source}.`}</p>
                <div className="pc-marketplace-meta">
                  <span>v{p.version ?? 'local'}</span>
                  <span>{p.path}</span>
                </div>
                {enabledHere.length > 0 && (
                  <div className="pc-marketplace-enabled pc-installed-plugin-enabled">
                    <strong>Enabled in</strong>
                    {enabledHere.map((h) => <code key={h}>{h}</code>)}
                  </div>
                )}
                <div className="pc-marketplace-card-actions pc-installed-plugin-actions">
                  {updates[p.name] && (
                    <Tooltip label={`Update v${updates[p.name].installed} → v${updates[p.name].available}${updates[p.name].capChange.added.length ? ` (new caps: ${updates[p.name].capChange.added.join(', ')})` : ''}`}><Button
                      size="lg"
                      variant="accent"
                      style={{ background: 'var(--accent, #22d3ee)', color: 'var(--accent-ink, #051827)' }}
                      onClick={() => update(p.name)}
                      disabled={busy === p.name}
                    >
                      {busy === p.name ? 'updating…' : `Update → v${updates[p.name].available}`}
                    </Button></Tooltip>
                  )}
                  <Button asChild size="lg" variant="accent">
                    <RouteLink href={`/installed/plugins/${encodeURIComponent(p.name)}/permissions`}>
                      Permissions
                    </RouteLink>
                  </Button>
                  <Button
                    size="lg"
                    variant="destructive"
                    className="pc-installed-plugin-uninstall"
                    onClick={() => uninstall(p.name)}
                    disabled={busy === p.name}
                  >
                    {busy === p.name ? 'removing…' : 'Uninstall'}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
