/**
 * GET /api/plugins/:slug/contributions — manifest-only contribution metadata.
 * Returns dashboardTabs, sidebarItems, ui routes, and panels for plugins
 * enabled in the named harness.
 * Ported from app/api/plugins/[slug]/contributions/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { papercuspRoot } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

interface DashboardTabManifest {
  id: string; label: string; icon?: string;
  componentId?: string; componentRoot?: string;
  iframeUrl?: string; iframeUrlConfigKey?: string;
  replaces?: string[];
  iframeAppendProjectFolder?: boolean;
  embedMode?: 'iframe' | 'inline-dock';
}
interface SidebarItemManifest {
  id: string; label: string; href: string; icon?: string;
  badge?: { source: 'static' | 'fetch'; value?: string | number; url?: string };
}
interface UiContributionManifest {
  slug: string; label: string; icon?: string;
  componentId?: string; componentRoot?: string;
}
interface PluginManifest {
  name: string; version: string;
  description?: string; author?: string;
  componentRoot?: string;
  dashboardTabs?: DashboardTabManifest[];
  sidebarItems?: SidebarItemManifest[];
  ui?: UiContributionManifest;
  configSchema?: { properties?: Record<string, { default?: unknown }> };
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch { return null; }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const stripped = raw.replace(/,(\s*[\]}])/g, '$1');
    try {
      return JSON.parse(stripped) as T;
    } catch {
      console.warn(
        `[plugins/contributions] failed to parse ${path} — file is malformed JSON, treating as empty. Original error:`,
        (e as Error).message,
      );
      return null;
    }
  }
}

async function listPluginsIn(parent: string, source: 'project' | 'harness' | 'global'): Promise<Array<PluginManifest & { source: string; path: string }>> {
  const out: Array<PluginManifest & { source: string; path: string }> = [];
  if (!existsSync(parent)) return out;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDirOrLinkToDir = e.isDirectory();
    if (!isDirOrLinkToDir && e.isSymbolicLink()) {
      const stat = await fs.stat(join(parent, e.name)).catch(() => null);
      isDirOrLinkToDir = stat?.isDirectory() ?? false;
    }
    if (!isDirOrLinkToDir) continue;
    const dir = join(parent, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (!m?.name || !m?.version) continue;
    out.push({ ...m, source, path: dir });
  }
  return out;
}

async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('../../../harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

async function resolveIframeUrl(
  manifest: PluginManifest,
  tab: DashboardTabManifest,
  harnessConfig: Record<string, unknown> | null,
  harnessSlug: string,
): Promise<string | null> {
  let url: string | null = null;
  if (tab.iframeUrlConfigKey) {
    const k = tab.iframeUrlConfigKey;
    const fromConfig = harnessConfig?.[k];
    const fromDefault = manifest.configSchema?.properties?.[k]?.default;
    if (typeof fromConfig === 'string' && fromConfig.length > 0) url = fromConfig;
    else if (typeof fromDefault === 'string' && fromDefault.length > 0) url = fromDefault;
  }
  if (!url && typeof tab.iframeUrl === 'string' && tab.iframeUrl.length > 0) {
    url = tab.iframeUrl;
  }
  if (!url) return null;
  url = url.replace(/^https?:\/\/localhost:3055(\/|$)/, '$1');

  const sep = url.includes('?') ? '&' : '?';
  url = `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;

  if (tab.iframeAppendProjectFolder) {
    const projectPath = await resolveProjectPath(harnessSlug);
    if (projectPath) {
      url = `${url}&folder=${encodeURIComponent(projectPath)}`;
    }
  }

  return url;
}

export default defineTool({
  method: 'GET',
  path: '/plugins/:slug/contributions',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const projectPath = await resolveProjectPath(slug);
    const sources: Array<{ name: string; dir: string; source: 'project' | 'harness' | 'global' }> = [];
    if (projectPath) {
      sources.push({ name: slug, dir: join(projectPath, 'plugins'), source: 'project' });
    }
    if (existsSync(HARNESSES_DIR())) {
      const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
      for (const h of harnessDirs) {
        if (!h.isDirectory()) continue;
        sources.push({ name: h.name, dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
      }
    }
    sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

    type EnabledFile = { enabled: Record<string, { version: string }> };
    const enabledFile = await readJson<EnabledFile>(
      join(HARNESSES_DIR(), slug, 'enabled-plugins.json'),
    );
    const enabledSet = new Set<string>(enabledFile ? Object.keys(enabledFile.enabled) : []);

    const seen = new Set<string>();
    type Tab = DashboardTabManifest & { pluginName: string };
    type Item = SidebarItemManifest & { pluginName: string };
    type Route = UiContributionManifest & { pluginName: string };
    const dashboardTabs: Tab[] = [];
    const sidebarItems: Item[] = [];
    const routes: Route[] = [];
    type PanelContrib = {
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
    };
    const panelsContrib: PanelContrib[] = [];

    for (const s of sources) {
      for (const p of await listPluginsIn(s.dir, s.source)) {
        if (seen.has(p.name)) continue;
        const dirBasename = basename(p.path);
        if (s.source === 'global' && !(enabledSet.has(p.name) || enabledSet.has(dirBasename))) continue;
        seen.add(p.name);
        const pluginRoot = (p as PluginManifest & { componentRoot?: string }).componentRoot;
        const harnessConfig = await readJson<Record<string, unknown>>(
          join(HARNESSES_DIR(), slug, 'plugin-configs', `${p.name}.json`),
        );
        for (const tab of p.dashboardTabs ?? []) {
          const resolvedIframeUrl = await resolveIframeUrl(p, tab, harnessConfig, slug);
          dashboardTabs.push({
            componentRoot: tab.componentRoot ?? pluginRoot,
            ...tab,
            iframeUrl: resolvedIframeUrl ?? tab.iframeUrl,
            pluginName: p.name,
          });
          if (tab.replaces && Array.isArray(tab.replaces) && tab.replaces.length > 0) {
            console.warn(
              `[dock] plugin ${p.name} tab "${tab.id}" declares replaces=${JSON.stringify(tab.replaces)} — ignored in dock model (still honored in classic dashboard)`,
            );
          }
          const finalSrc = resolvedIframeUrl ?? tab.iframeUrl;
          panelsContrib.push({
            pluginName: p.name,
            id: tab.id,
            fullType: `plugin:${p.name}:${tab.id}`,
            title: tab.label,
            icon: tab.icon,
            type: finalSrc ? 'iframe' : 'react',
            componentRoot: tab.componentRoot ?? pluginRoot,
            componentId: tab.componentId,
            src: finalSrc ?? undefined,
          });
        }
        type PanelDecl = {
          id: string;
          title: string;
          icon?: string;
          type?: 'react' | 'iframe';
          componentRoot?: string;
          componentId?: string;
          src?: string;
          iframeUrl?: string;
          iframeUrlConfigKey?: string;
          defaultGroup?: string;
          defaultFloating?: { width?: number; height?: number };
          keepAlive?: boolean;
        };
        const declared = (p as PluginManifest & { panels?: PanelDecl[] }).panels ?? [];
        for (const panel of declared) {
          let resolvedSrc = panel.src ?? panel.iframeUrl;
          if (!resolvedSrc && panel.iframeUrlConfigKey) {
            const synthTab: DashboardTabManifest = {
              id: panel.id,
              label: panel.title,
              iframeUrlConfigKey: panel.iframeUrlConfigKey,
            };
            resolvedSrc = (await resolveIframeUrl(p, synthTab, harnessConfig, slug)) ?? undefined;
          }
          panelsContrib.push({
            pluginName: p.name,
            id: panel.id,
            fullType: `plugin:${p.name}:${panel.id}`,
            title: panel.title,
            icon: panel.icon,
            type: panel.type ?? (resolvedSrc ? 'iframe' : 'react'),
            componentRoot: panel.componentRoot ?? pluginRoot,
            componentId: panel.componentId,
            src: resolvedSrc,
            defaultGroup: panel.defaultGroup,
            defaultFloating: panel.defaultFloating,
            keepAlive: panel.keepAlive,
          });
        }
        for (const item of p.sidebarItems ?? []) {
          sidebarItems.push({ ...item, pluginName: p.name });
        }
        if (p.ui) {
          routes.push({
            componentRoot: p.ui.componentRoot ?? pluginRoot,
            ...p.ui,
            pluginName: p.name,
          });
        }
      }
    }

    return Response.json({
      project: { slug, path: projectPath },
      dashboardTabs, sidebarItems, routes,
      panels: panelsContrib,
    });
  },
});
