/**
 * useRegisterPluginPanels — fetches /api/plugins contributions and
 * registers each plugin panel in panelRegistry.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §8 (plugin contract)
 *
 * Hot-swap (§8.3): if a layout is already hydrated referencing
 * `plugin:<name>:<id>` and the plugin hasn't loaded yet, MissingPanel
 * renders. When this hook lands the registration, MissingPanel
 * subscribes-and-re-renders into the real component.
 *
 * Mount once at the dock root (or anywhere safe to refetch). Plugin
 * panels currently render as iframes pointing at the plugin's
 * iframeUrl; `type: 'react'` will require dynamic-import support via
 * componentRoot/componentId — that's TODO once a plugin actually uses
 * the new field.
 */

'use client';

import { useEffect } from 'react';
import dynamic from '@/lib/router-compat/dynamic';
import { panelRegistry, type PanelComponentProps } from './panel-registry';
import { IframePanel } from './IframePanel';
import { MissingPanel } from './MissingPanel';

/**
 * The sandbox every PLUGIN-contributed iframe panel is rendered under
 * (security-boundary-remediation-and-usability-2026-09-04 P-005: "isolate
 * plugin/preview content without native grants").
 *
 * WHY THIS IS NEEDED AT ALL. Tauri scopes capabilities by WINDOW LABEL, not by
 * frame origin — `capabilities/default.json` grants the `main` window
 * `allow-pty-spawn`, `fs:default`, `process:default`, `shell:allow-open`,
 * `allow-console-launch` and `allow-endpoint-invoke`. A plugin panel's `src`
 * comes from that plugin's own `/api/plugins/<slug>/contributions` manifest, so
 * a plugin that points a panel at a same-origin URL used to get an UNSANDBOXED
 * same-origin frame inside `main` — from which `window.__TAURI__` is reachable
 * and the whole native grant set with it. Before this constant, `PanelContrib`
 * had no `sandbox` field at all and `getOrCreateIframe` only sets the attribute
 * `if (options.sandbox)`, so the frame was created with no sandbox whatsoever.
 *
 * WHY `allow-same-origin` IS ABSENT, AND WHY THAT IS THE WHOLE POINT. Omitting
 * it puts the frame in an OPAQUE origin: it cannot touch the app origin's DOM,
 * storage, or the Tauri IPC bridge, which is origin-gated. Every other token
 * here is what a panel legitimately needs to be a usable panel. Note that
 * `allow-scripts` + `allow-same-origin` TOGETHER is the classic sandbox escape
 * (the frame can simply delete its own sandbox attribute), so the two must
 * never be granted as a pair.
 *
 * WHY A PLUGIN CANNOT OVERRIDE IT. This is applied AFTER the params spread and
 * is deliberately not a `PanelContrib` field. A manifest-supplied sandbox would
 * be attacker-supplied for exactly the attacker we are containing — a hostile
 * plugin would simply declare `allow-scripts allow-same-origin` and restore the
 * hole. First-party panels (workbench-panels.tsx and friends) render through
 * `IframePanel` directly and are untouched, which is what keeps code-server,
 * Drizzle Studio and the previews working (D-001: preserve the legitimate path).
 */
export const PLUGIN_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

/**
 * Known componentRoot/componentId combinations the dock can resolve
 * locally. Used when a plugin manifest declares a `react`-type panel
 * whose component ships inside the operator codebase rather than as
 * a remote import. Extend as new bundled-react panels arrive.
 *
 * The map key is `${componentRoot}::${componentId}`.
 */
const KNOWN_REACT_PANELS: Record<string, () => Promise<{ default: React.ComponentType<PanelComponentProps> }>> = {
  '@papercusp/papercusp-shared::PiTerminalsDock': async () => {
    const mod = await import('../PiTerminalsDock');
    const Inner = (mod as { default?: unknown }).default ?? (mod as Record<string, unknown>).PiTerminalsDock;
    if (typeof Inner !== 'function') {
      throw new Error('PiTerminalsDock export not found');
    }
    // Wrap so the dock's PanelComponentProps shape feeds the inner
    // component's expected props (which take slug, initialLaneId).
    const Wrap = (props: PanelComponentProps) => {
      const slug = (props.params.harnessSlug as string) || (props.params.slug as string) || '';
      const initialLaneId = (props.params.initialLaneId as string) || undefined;
      // @ts-expect-error — PiTerminalsDock has its own props shape; we
      // pass only the ones it understands.
      return <Inner slug={slug} initialLaneId={initialLaneId} />;
    };
    Wrap.displayName = 'PiTerminalsDockWrap';
    return { default: Wrap };
  },
};

interface PanelContrib {
  pluginName: string;
  id: string;
  fullType: string;
  title: string;
  icon?: string;
  type: 'react' | 'iframe';
  componentRoot?: string;
  componentId?: string;
  src?: string;
  defaultGroup?: string;
  defaultFloating?: { width?: number; height?: number };
  keepAlive?: boolean;
}

interface ContributionsResponse {
  panels?: PanelContrib[];
}

export function useRegisterPluginPanels(slug: string): void {
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/plugins/${encodeURIComponent(slug)}/contributions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ContributionsResponse | null) => {
        if (cancelled || !j?.panels) return;
        for (const panel of j.panels) {
          if (panel.type === 'iframe' && panel.src) {
            // Wrap IframePanel so the registered component carries the
            // panel's src as a closure (panel registry expects a fixed
            // component, not one that receives external src). We pass
            // src via params at openPanel time, but plugin panels often
            // have a fixed src. The simplest approach: register a
            // component that ignores params.src and uses the closed-over
            // value. But to support src-from-params openPanel calls,
            // we also fall through to params.src if set.
            const Comp = (props: Parameters<typeof IframePanel>[0]) => {
              const params = props.params as { src?: string };
              return (
                <IframePanel
                  {...props}
                  params={{
                    ...props.params,
                    src: params.src ?? panel.src,
                    // P-005: forced LAST, so neither the plugin manifest nor an
                    // openPanel caller can widen it back to `allow-same-origin`
                    // and reach the native grants `main` holds. See the
                    // PLUGIN_IFRAME_SANDBOX comment above.
                    sandbox: PLUGIN_IFRAME_SANDBOX,
                  }}
                />
              );
            };
            Comp.displayName = `PluginIframePanel(${panel.fullType})`;
            panelRegistry.register(panel.fullType, Comp, {
              title: panel.title,
              keepAlive: panel.keepAlive ?? true,
              defaultGroup: panel.defaultGroup,
            });
          } else {
            // React-type plugin panel. Check KNOWN_REACT_PANELS for a
            // local mapping (e.g. pi-coding's PiTerminalsDock); fall
            // back to a not-yet-wired message for genuinely-external
            // React panels whose componentRoot can't be resolved.
            const key = `${panel.componentRoot ?? ''}::${panel.componentId ?? ''}`;
            const loader = KNOWN_REACT_PANELS[key];
            if (loader) {
              const Comp = dynamic(loader, {
                ssr: false,
                loading: () => (
                  <div
                    style={{
                      padding: 16,
                      fontSize: 12,
                      color: 'var(--fg-mute)',
                    }}
                  >
                    Loading {panel.title}…
                  </div>
                ),
              });
              panelRegistry.register(panel.fullType, Comp as never, {
                title: panel.title,
                keepAlive: panel.keepAlive ?? true,
                defaultGroup: panel.defaultGroup,
              });
            } else {
              const NotYet = () => (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    padding: 16,
                    textAlign: 'center',
                    color: 'var(--fg-mute)',
                    fontSize: 12,
                  }}
                >
                  Plugin{' '}
                  <code style={{ color: 'var(--fg)' }}>
                    {panel.pluginName}:{panel.id}
                  </code>{' '}
                  is an external React-typed panel; the dock doesn't have
                  a loader for{' '}
                  <code>
                    {panel.componentRoot ?? '?'}::{panel.componentId ?? '?'}
                  </code>{' '}
                  yet. Add it to KNOWN_REACT_PANELS in useRegisterPluginPanels.tsx.
                </div>
              );
              NotYet.displayName = `PluginReactPanelNotYet(${panel.fullType})`;
              panelRegistry.register(panel.fullType, NotYet, {
                title: panel.title,
                keepAlive: false,
                defaultGroup: panel.defaultGroup,
              });
            }
          }
        }
      })
      .catch(() => {
        // Plugin contributions endpoint unreachable; plugin panels in
        // existing layouts will fall back to MissingPanel.
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
}
