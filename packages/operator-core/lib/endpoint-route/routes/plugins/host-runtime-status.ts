/**
 * GET /api/plugins/host/runtime-status — non-JS plugin runtime status rows.
 * Ported from app/api/plugins/host/runtime-status/route.ts. `auth: 'public'`.
 */
import { getPluginHost } from '../../../plugin-host-runtime';
import { defineTool } from '@papercusp/agent-mcp';

interface RuntimeStatusRow {
  plugin: string;
  runtime: 'wasm' | 'daemon';
  pid?: number;
  restartCount?: number;
  ok: boolean;
  loadedFor: string[];
}

export default defineTool({
  method: 'GET',
  path: '/plugins/host/runtime-status',
  auth: 'public',
  async handler() {
    const state = await getPluginHost();
    const rows: RuntimeStatusRow[] = [];

    const byPlugin = new Map<string, { runtime: 'wasm' | 'daemon'; slugs: string[]; handles: unknown[] }>();
    for (const [key, handle] of state.wasmHandles) {
      const [pluginName, slug] = key.split('::');
      if (!pluginName) continue;
      const lp = state.loaded.find((p) => p.plugin.name === pluginName);
      const rk = lp?.runtime?.kind === 'daemon' ? 'daemon' : 'wasm';
      let entry = byPlugin.get(pluginName);
      if (!entry) {
        entry = { runtime: rk, slugs: [], handles: [] };
        byPlugin.set(pluginName, entry);
      }
      if (slug) entry.slugs.push(slug);
      entry.handles.push(handle);
    }

    for (const [plugin, entry] of byPlugin) {
      let pid: number | undefined;
      let restartCount: number | undefined;
      if (entry.runtime === 'daemon') {
        const h = entry.handles[0] as { pid?: () => number | undefined; restartCount?: () => number };
        try {
          pid = typeof h?.pid === 'function' ? h.pid() : undefined;
          restartCount = typeof h?.restartCount === 'function' ? h.restartCount() : undefined;
        } catch { /* handle gone */ }
      }
      rows.push({
        plugin,
        runtime: entry.runtime,
        pid,
        restartCount,
        ok: entry.handles.length > 0,
        loadedFor: entry.slugs,
      });
    }

    return Response.json({ rows });
  },
});
