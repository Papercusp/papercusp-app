/**
 * Phase 6b — render one React-mode plugin tab.
 *
 * Wraps `resolveComponent()` (from plugin-runtime) in a Suspense boundary
 * and a small error boundary. The dashboard's tab strip already chooses
 * which tab is active; this component just renders the active one.
 *
 * Keeps `<PluginTabs>` (the standalone tab strip) intact for future use
 * cases where a host page wants the whole strip without integrating with
 * the harness dashboard's own strip.
 */
'use client';

import { Component, Suspense, type ReactNode } from 'react';
import { resolveComponent } from './plugin-runtime';
import { makeBrowserApi } from '@papercusp/operator-core/lib/browser-papercusp-api';

interface Props {
  pluginName: string;
  componentRoot: string;
  componentId: string;
  slug: string;
  label: string;
  readOnly?: boolean;
}

class TabErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: 'var(--fg-dim)' }}>
          Plugin tab <strong>{this.props.label}</strong> failed to render:{' '}
          <code>{this.state.error}</code>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function PluginReactTab({ pluginName, componentRoot, componentId, slug, label, readOnly = false }: Props) {
  const Component = resolveComponent({ componentRoot, componentId });
  const api = makeBrowserApi(slug, pluginName);
  return (
    <TabErrorBoundary label={label}>
      <Suspense fallback={<div style={{ padding: 24, color: 'var(--fg-dim)' }}>Loading {label}…</div>}>
        <Component {...({ slug, api, readOnly } as any)} />
      </Suspense>
    </TabErrorBoundary>
  );
}
