/**
 * plugins:tui_panes — resolve the TUI pane UI contributions a harness's
 * enabled plugins offer (revive-plugin-system-2026-06-04 D-002).
 *
 * A plugin declares `ui: [{ type: 'tui-pane', slug, label, command }]` in its
 * manifest. This tool returns the subset the caller is allowed to open — those
 * whose plugin holds BOTH `ui:tui-pane` AND `compute:exec:<command[0]>` under
 * the two-tier capability check (manifest ∩ user-granted). The pui (apps/tui)
 * calls GET/POST /api/agent-tools/plugins/tui_panes and opens a chosen pane in
 * a zellij pane it manages — running `command` with cwd = the plugin's install
 * dir. Zellij is the pui's layout engine, not the plugin contract.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { hasCapability, type CapabilityCheckContext } from '@papercusp/plugin-loader';
import { getPluginHost } from '../../plugin-host-runtime';
import { getGrantsForPluginInHarness } from '../../plugin-grants';

export interface TuiPaneContribution {
  pluginName: string;
  slug: string;
  label: string;
  icon?: string;
  command: string[];
  /** cwd to run `command` in — the plugin's install dir (so a shipped render script resolves). */
  cwd: string;
}

interface LoadedForPanes {
  plugin: {
    name: string;
    capabilities?: string[];
    ui?: Array<{ type?: string; slug?: string; label?: string; icon?: string; command?: unknown }>;
  };
  path: string;
}

/**
 * Pure resolver: from the loaded plugins + a granted-caps lookup, return the
 * tui-pane contributions the caller may open. Extracted so it's unit-testable
 * without PG or the live host. `grantedFor` returns the user-granted caps for a
 * plugin (or undefined for "no grant info" → manifest-only, two-tier fallback).
 */
export function collectTuiPanes(
  loaded: LoadedForPanes[],
  grantedFor: (pluginName: string) => string[] | undefined,
): TuiPaneContribution[] {
  const out: TuiPaneContribution[] = [];
  for (const lp of loaded) {
    const ui = lp.plugin.ui;
    if (!Array.isArray(ui)) continue;
    const tuiEntries = ui.filter(
      (u) =>
        u.type === 'tui-pane' &&
        Array.isArray(u.command) &&
        u.command.length > 0 &&
        typeof u.command[0] === 'string' &&
        typeof u.slug === 'string' &&
        typeof u.label === 'string',
    );
    if (tuiEntries.length === 0) continue;
    const capCtx: CapabilityCheckContext = {
      pluginName: lp.plugin.name,
      capabilities: (lp.plugin.capabilities ?? []) as CapabilityCheckContext['capabilities'],
      granted: grantedFor(lp.plugin.name) as CapabilityCheckContext['granted'],
    };
    if (!hasCapability(capCtx, 'ui:tui-pane')) continue;
    for (const u of tuiEntries) {
      const command = u.command as string[];
      if (!hasCapability(capCtx, `compute:exec:${command[0]}`)) continue;
      out.push({
        pluginName: lp.plugin.name,
        slug: u.slug as string,
        label: u.label as string,
        ...(typeof u.icon === 'string' ? { icon: u.icon } : {}),
        command,
        cwd: lp.path,
      });
    }
  }
  return out;
}

export default defineTool({
  name: 'plugins:tui_panes',
  profile: 'engineer',
  guidance: {
    when: "The pui (or an agent) needs the TUI panes (type:'tui-pane' UI contributions) a harness's enabled plugins offer, to open one in a terminal pane.",
    notWhen: 'For desktop UI surfaces (react/iframe) or the full plugin runtime status, use plugins:runtime_status.',
    seeAlso: [
      'plugins:runtime_status (full plugin runtime status + desktop UI surfaces)',
    ],
  },
  description:
    'List the capability-gated tui-pane UI contributions for a harness (pluginName, slug, label, command, cwd). The pui opens these in a zellij pane.',
  capability: 'plugins:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harness: z.string().min(1).describe('Harness slug to resolve tui-pane contributions for.'),
  }),
  async handler({ harness }) {
    const host = await getPluginHost();
    // Preload the granted caps for each plugin that contributes a tui-pane, so
    // collectTuiPanes stays pure (no per-call PG read inside the hot loop).
    const grantsCache = new Map<string, string[] | undefined>();
    for (const lp of host.loaded) {
      const ui = (lp.plugin as { ui?: Array<{ type?: string }> }).ui;
      if (Array.isArray(ui) && ui.some((u) => u.type === 'tui-pane')) {
        try {
          const rows = await getGrantsForPluginInHarness(lp.plugin.name, lp.plugin.version, harness);
          grantsCache.set(lp.plugin.name, rows.length === 0 ? undefined : rows);
        } catch {
          grantsCache.set(lp.plugin.name, undefined);
        }
      }
    }
    const panes = collectTuiPanes(host.loaded as unknown as LoadedForPanes[], (name) => grantsCache.get(name));
    return { content: [{ type: 'text', text: JSON.stringify({ panes }) }] };
  },
});
