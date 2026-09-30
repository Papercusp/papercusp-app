/**
 * Phase 6b — <PluginTabs> client component.
 *
 * Drop-in surface for rendering dashboard tabs contributed by plugins.
 * Hosts integrate with:
 *
 *   <PluginTabs slug={harnessSlug} />
 *
 * The component fetches /api/plugins/<slug>/contributions on mount,
 * resolves each tab's (componentRoot, componentId) pair to a React.lazy
 * component, and renders them with a tab-strip UX.
 *
 * Lazy-loaded so the import cost of plugin code is paid only when the
 * user clicks a tab, not on initial dashboard render.
 */
'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import {
  fetchContributions,
  resolveComponent,
  type DashboardTabContribution,
} from './plugin-runtime';
import { makeBrowserApi } from '@papercusp/operator-core/lib/browser-papercusp-api';

interface PluginTabsProps {
  slug: string;
  /** Optional — additional props passed to each tab's component (merged on top of {slug, api, readOnly}). */
  componentProps?: Record<string, unknown>;
  /** Optional — placeholder shown while a tab is loading */
  fallback?: React.ReactNode;
  /** Optional — render plugin tabs in read-only mode (default false). */
  readOnly?: boolean;
}

export default function PluginTabs({ slug, componentProps, fallback, readOnly = false }: PluginTabsProps) {
  const [tabs, setTabs] = useState<DashboardTabContribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useQueryState('pluginTab', parseAsString);

  // Per-(slug, plugin) browser API. Memoized so each plugin tab gets a
  // stable api reference across renders.
  const apiCache = useMemo(() => new Map<string, ReturnType<typeof makeBrowserApi>>(), [slug]);
  const apiFor = (pluginName: string) => {
    let api = apiCache.get(pluginName);
    if (!api) {
      api = makeBrowserApi(slug, pluginName);
      apiCache.set(pluginName, api);
    }
    return api;
  };

  useEffect(() => {
    let cancelled = false;
    fetchContributions(slug)
      .then((res) => {
        if (cancelled) return;
        setTabs(res.dashboardTabs);
        if (res.dashboardTabs.length > 0) setActive(res.dashboardTabs[0].id);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div role="alert" style={{ color: 'var(--bad)', padding: 8 }}>
        Plugin tabs failed to load: {error}
      </div>
    );
  }

  if (tabs === null) {
    return <div aria-busy>Loading plugin tabs…</div>;
  }

  if (tabs.length === 0) {
    return null;
  }

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];
  // Pattern 1 — render mode picked per-tab. Iframe wins if both are set
  // (cheaper to validate at runtime; no rebuild required to update).
  const renderMode: 'iframe' | 'react' | 'invalid' =
    activeTab.iframeUrl
      ? 'iframe'
      : (activeTab.componentRoot && activeTab.componentId)
        ? 'react'
        : 'invalid';
  const ActiveComponent =
    renderMode === 'react'
      ? resolveComponent({ componentRoot: activeTab.componentRoot!, componentId: activeTab.componentId! })
      : null;

  return (
    <div className="plugin-tabs">
      <div role="tablist" aria-label="Plugin-contributed tabs" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab.id;
          return (
            <button
              key={tab.pluginName + ':' + tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(tab.id)}
              style={{
                padding: '8px 12px',
                background: isActive ? 'var(--bg-3)' : 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {tab.label}
              <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                ({tab.pluginName})
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" style={{ padding: 12, height: '100%' }}>
        {renderMode === 'iframe' && (
          <iframe
            key={activeTab.pluginName + ':' + activeTab.id}
            src={activeTab.iframeUrl}
            title={`${activeTab.label} (${activeTab.pluginName})`}
            // Pattern 1 v2 capability gating happens via CSP from the
            // host. Defaults are tight; plugin can request relaxations
            // through its capabilities[] manifest (future work).
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            referrerPolicy="strict-origin-when-cross-origin"
            style={{ width: '100%', height: '100%', minHeight: 600, border: 0, display: 'block' }}
          />
        )}
        {renderMode === 'react' && ActiveComponent && (
          <Suspense fallback={fallback ?? <div aria-busy>Loading {activeTab.label}…</div>}>
            <ActiveComponent
              {...({
                slug,
                api: apiFor(activeTab.pluginName),
                readOnly,
                ...(componentProps ?? {}),
              } as any)}
            />
          </Suspense>
        )}
        {renderMode === 'invalid' && (
          <div role="alert" style={{ color: 'var(--bad)' }}>
            Plugin "{activeTab.pluginName}" tab "{activeTab.id}" declares neither an iframeUrl nor a (componentRoot, componentId) pair. Update the manifest.
          </div>
        )}
      </div>
    </div>
  );
}
