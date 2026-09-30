'use client';

// Shared plugin helpers used by HarnessPluginsSection (the per-harness plugin
// manager that lives in the Settings tab since the Config tab was retired —
// config-tab-cleanup-2026-06-08). Lives in its own module so consumers don't
// have to import a panel — same pattern as the standalone panel components
// (BrainstormFull, PrsTab, …).

import type { ComponentType } from 'react';
import {
  Activity, ArrowRight, AlertTriangle, BarChart, Bell, BookOpen, Box, Calendar,
  CheckCircle2, CheckSquare, Cloud, Code, Code2, Coins, Database, Download,
  FileText, Folder, FolderOpen, GitBranch, Globe, Image as ImageIcon, Inbox,
  Layers, LayoutDashboard, Lightbulb, LineChart, Link as LinkIcon, ListChecks,
  Loader2, Mail, MessageSquare, Music, PieChart, Play, Plus, Puzzle, RotateCcw,
  Search, Send, Server, Settings, Shield, SlidersHorizontal, Square,
  Star, Tag, Terminal, TrendingUp, Upload, Video, Wrench, Zap,
} from 'lucide-react';

/** Manifest-declared lucide icon name → component. Falls back to Puzzle. */
export const PLUGIN_ICON_MAP: Record<string, ComponentType<{ size?: number | string }>> = {
  Activity, ArrowRight, AlertTriangle, BarChart, Bell, BookOpen, Box, Calendar,
  CheckCircle2, CheckSquare, Cloud, Code, Code2, Coins, Database, Download,
  FileText, Folder, FolderOpen, GitBranch, Globe, Image: ImageIcon, Inbox,
  Layers, LayoutDashboard, Lightbulb, LineChart, Link: LinkIcon, ListChecks,
  Loader2, Mail, MessageSquare, Music, PieChart, Play, Plus, Puzzle, RotateCcw,
  Search, Send, Server, Settings, Shield, Slack: MessageSquare, SlidersHorizontal, Square,
  Star, Tag, Terminal, TrendingUp, Upload, Video, Wrench, Zap,
};

export function PluginIcon({ name, size = 13 }: { name?: string | null; size?: number }) {
  const Icon: ComponentType<{ size?: number | string }> = (name && PLUGIN_ICON_MAP[name]) || Puzzle;
  return <Icon size={size} />;
}

/**
 * The dir slug the CLI keys enable/disable by — the path basename (with the
 * `@scope/` parent kept), independent of the scoped manifest.name.
 */
export function pluginSlugFromPath(path: string | null | undefined, fallbackName: string): string {
  if (!path) return fallbackName;
  const parts = path.replace(/\/$/, '').split('/');
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent && parent.startsWith('@')) return `${parent}/${last}`;
  return last ?? fallbackName;
}

export interface InstalledPluginAction {
  name?: string;
  label?: string;
  surfaces?: string[];
  /** Optional manifest-declared lucide icon name. Resolved via PLUGIN_ICON_MAP. */
  icon?: string;
}

export interface InstalledPluginInfo {
  name: string;
  version?: string;
  description?: string;
  source?: string;
  icon?: string;
  /** Absolute on-disk path; basename is the dir slug the CLI keys enable/disable by. */
  path?: string;
  dashboardTabs?: Array<{ id?: string; label?: string; icon?: string }>;
  actions?: InstalledPluginAction[];
}

export interface EnabledPluginManifest extends InstalledPluginInfo {
  capabilities?: string[];
  actions?: Array<{ id?: string; name?: string; label?: string; description?: string; params?: Record<string, unknown> }>;
  routines?: Array<{ name?: string; trigger?: string }>;
  configSchema?: { properties?: Record<string, { default?: unknown; description?: string }> };
}

/**
 * Per-plugin REQUIRED-but-missing config fields — drives the "needs setup" dots
 * on the plugin tabs. For each enabled slug, resolve its manifest (by `name` or
 * dir slug), then check every `configSchema.required` field against the stored
 * config: a field is missing when its value is undefined, null, or the empty
 * string. Keyed by manifest `name`; plugins with nothing missing are omitted.
 */
export function computePluginsMissing(
  installedPlugins: InstalledPluginInfo[] | null,
  enabledSlugs: string[],
  pluginConfigRows: Array<{ pluginSlug: string; config: Record<string, unknown> | null }> | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!installedPlugins || enabledSlugs.length === 0) return out;
  const cfgByDir = new Map<string, Record<string, unknown>>();
  if (Array.isArray(pluginConfigRows)) {
    for (const r of pluginConfigRows) cfgByDir.set(r.pluginSlug, (r.config ?? {}) as Record<string, unknown>);
  }
  for (const s of enabledSlugs) {
    const m = installedPlugins.find(
      (p) => p.name === s || (p.path ? pluginSlugFromPath(p.path, p.name) : null) === s,
    );
    if (!m) continue;
    const required = (m as { configSchema?: { required?: string[] } }).configSchema?.required ?? [];
    if (required.length === 0) continue;
    const dirSlug = m.path ? pluginSlugFromPath(m.path, m.name) : m.name;
    const cfg = cfgByDir.get(dirSlug) ?? {};
    const missing = required.filter((f) => {
      const v = cfg[f];
      return v === undefined || v === null || (typeof v === 'string' && v.length === 0);
    });
    if (missing.length) out[m.name] = missing;
  }
  return out;
}

/**
 * Resolve enabled slugs → their manifests, deduped by `name`. enabled-plugins
 * may legitimately list the same plugin under both its scoped and bare-dir
 * names; we keep the first match for each manifest.
 */
export function dedupeEnabledManifests(
  installedPlugins: InstalledPluginInfo[] | null | undefined,
  enabledSlugs: string[],
): EnabledPluginManifest[] {
  const seen = new Set<string>();
  const out: EnabledPluginManifest[] = [];
  for (const slugName of enabledSlugs) {
    const m = installedPlugins?.find((p) => {
      const dirSlug = p.path ? pluginSlugFromPath(p.path, p.name) : null;
      return p.name === slugName || dirSlug === slugName;
    });
    if (!m || seen.has(m.name)) continue;
    seen.add(m.name);
    out.push(m as EnabledPluginManifest);
  }
  return out;
}

/** Drop empty-string values on config save (empty = "no value, use default"). */
export function pruneEmptyConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}
