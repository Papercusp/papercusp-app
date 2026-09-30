/**
 * Phase 6b — plugin runtime: componentId → React component resolver.
 *
 * Phase 6a (server) exposes plugin manifests via /api/plugins/* with
 * componentRoot + componentId as strings. Phase 6b (this file) takes those
 * strings and produces actual React components at render time.
 *
 * v1 (build-time): componentRoot must be an npm-resolvable package name
 *   (workspace package or installed dep). Dynamic import + named-export
 *   lookup. Plugins must be in transpilePackages if they ship TS sources.
 *
 * v2 (iframe, deferred): same API, different loader — postMessage RPC to
 *   a CDN-hosted iframe instead of in-process import. See spec §8.6.
 */
import type { ComponentType } from 'react';
import { lazy } from 'react';

export interface ComponentRef {
  /** npm package name (e.g. '@papercusp/papercusp-shared') */
  componentRoot: string;
  /** Named export within that module (e.g. 'DirectivesView') */
  componentId: string;
}

/**
 * Pattern 1 — a plugin tab can ship as either an in-process React component
 * (componentRoot + componentId) or an iframe URL. PluginTabs picks the
 * render mode at component-mount time based on which is present.
 *
 * If both are set, the host prefers iframeUrl (cheaper to validate at
 * runtime; no rebuild required to update). `replaces` lets a plugin tab
 * supersede a built-in dashboard tab id (docs/vscode/pi/etc.); the
 * dashboard hides the built-in version when a replacement is present.
 */
export interface DashboardTabContribution {
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
  componentRoot?: string;
  componentId?: string;
  iframeUrl?: string;
  replaces?: string[];
}

export interface SidebarItemContribution {
  pluginName: string;
  id: string;
  label: string;
  href: string;
  icon?: string;
}

export interface RouteContribution extends ComponentRef {
  pluginName: string;
  slug: string;
  label: string;
  icon?: string;
}

/**
 * Dockview-migration v4 §8.1 — plugin-contributed dock panels.
 *
 * Plugins declare panels[] in their manifest. The host:
 *   1. Loads the plugin (existing flow)
 *   2. For each panel, registers via panelRegistry.register(id, ...)
 *   3. Hot-swap (§8.3) covers the case where a layout references a
 *      type before the plugin loaded.
 *
 * `dashboardTabs[]` continues to work as a back-compat alias (warned at
 * load time, never broken — §9 decision: warn-forever).
 */
export interface PluginPanelContribution {
  /** Plugin-scoped id. Combined with plugin name as `plugin:<pluginName>:<id>`. */
  id: string;
  /** Display title in the tab strip. */
  title: string;
  /** Icon name (lucide-react). Optional. */
  icon?: string;
  /** 'react' for componentRoot+componentId, 'iframe' for src. */
  type: 'react' | 'iframe';
  /** Used when type='react'. */
  componentRoot?: string;
  /** Used when type='react'. */
  componentId?: string;
  /** Used when type='iframe'. The iframe src URL or a configKey to resolve. */
  src?: string;
  iframeUrlConfigKey?: string;
  /** Default group hint when opening via openPanel without explicit group. */
  defaultGroup?: string;
  /** Default floating geometry if user opens as floating. */
  defaultFloating?: { width?: number; height?: number };
  /** Whether dockview should keep mounted when its tab is inactive. */
  keepAlive?: boolean;
}

export interface PluginPanelRegistration extends PluginPanelContribution {
  pluginName: string;
  /** Full registry type key: `plugin:<pluginName>:<id>`. */
  fullType: string;
}

export interface ContributionsResponse {
  project: { slug: string; path: string | null };
  dashboardTabs: DashboardTabContribution[];
  sidebarItems: SidebarItemContribution[];
  routes: RouteContribution[];
  /**
   * Phase 6 of dockview-migration. May be empty if no plugin uses the new
   * field. Plugins using `dashboardTabs` are surfaced both there AND as
   * a synthesized `panels` entry (back-compat shim) so the new dock UI
   * works without forcing plugin manifest changes.
   */
  panels?: PluginPanelRegistration[];
}

/**
 * Fetch contributions for a project slug from the host's /api/plugins endpoint.
 *
 * Designed to be called from React Server Components or client-side fetchers.
 * On the server, callers can pass an absolute URL; on the client, a relative
 * path resolves against the current origin.
 */
export async function fetchContributions(
  slug: string,
  baseUrl: string = '',
): Promise<ContributionsResponse> {
  const url = `${baseUrl}/api/plugins/${encodeURIComponent(slug)}/contributions`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`fetchContributions(${slug}): ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ContributionsResponse;
}

/**
 * Static registry of plugin componentRoots known to Turbopack at build
 * time. Each entry is a factory that bundles the package as its own
 * chunk. New plugin component packages must register here so the
 * bundler can include them.
 */
const KNOWN_ROOTS: Record<string, () => Promise<unknown>> = {
  '@papercusp/papercusp-shared': () => import('@papercusp/papercusp-shared'),
};

/**
 * Resolve a (componentRoot, componentId) pair to a React.lazy()-wrapped
 * component, suitable for use inside <Suspense>.
 *
 * Caches per (componentRoot, componentId) so the same plugin tab rendered
 * twice doesn't trigger two dynamic imports.
 */
const cache = new Map<string, ComponentType<unknown>>();

export function resolveComponent(ref: ComponentRef): ComponentType<unknown> {
  const key = `${ref.componentRoot}#${ref.componentId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const Component = lazy(async () => {
    let mod: Record<string, unknown>;
    try {
      // Static registry of known componentRoot packages so Turbopack can
      // bundle them at build time. A bare `import(varName)` with a runtime
      // variable specifier is unbundleable in the browser; using factory
      // functions per known package gives the bundler a static target.
      // To register a new plugin componentRoot: add it to KNOWN_ROOTS below.
      const factory = KNOWN_ROOTS[ref.componentRoot];
      if (!factory) {
        const known = Object.keys(KNOWN_ROOTS).join(', ') || '(none)';
        throw new Error(
          `unknown componentRoot "${ref.componentRoot}". Known: ${known}. ` +
            `Add it to KNOWN_ROOTS in plugin-runtime.ts.`,
        );
      }
      mod = (await factory()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `resolveComponent: failed to import componentRoot "${ref.componentRoot}". ` +
          `Plugin must be in transpilePackages or installed as a dep. Original: ${String(err)}`,
      );
    }
    const exported = mod[ref.componentId];
    if (typeof exported !== 'function') {
      const available = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
      throw new Error(
        `resolveComponent: "${ref.componentId}" is not an exported function in "${ref.componentRoot}". ` +
          `Available named exports: ${available.join(', ') || '(none)'}`,
      );
    }
    return { default: exported as ComponentType<unknown> };
  });

  cache.set(key, Component);
  return Component;
}

/**
 * Test-only: clear the resolver cache. Use sparingly — production code
 * should never need to evict.
 */
export function _resetCacheForTests(): void {
  cache.clear();
}
