/**
 * Plugin runtime diagnostics page — shows everything the in-process host
 * runtime knows about the loaded plugin set: counts, initialized
 * (plugin, harness) pairs, registered actions per pair, free-form hook
 * subscriptions, and load errors.
 *
 * Backed by `GET /api/plugins/runtime/status`. Includes a one-click reset
 * button (calls `?reset=1`) for ops who've just changed something on disk
 * and want the runtime to re-discover.
 */
import RuntimeView from './RuntimeView';

export const dynamic = 'force-dynamic';

interface RuntimeStatus {
  loaded: number;
  errors: number;
  reactionRules: { id: string; on: string | string[]; fire: string; plugin: string }[];
  plugins: { name: string; version: string; source: string }[];
  loadErrors: { error: string | object; path: string }[];
  initializedPairs: string[];
  registeredActions: { key: string; declared: string[]; registered: string[] }[];
}

async function loadStatus(): Promise<RuntimeStatus | null> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/plugins/runtime/status`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as RuntimeStatus;
  } catch {
    return null;
  }
}

export default async function PluginRuntimePage() {
  const status = await loadStatus();
  return (
    <div>
      <h1>Plugin runtime</h1>
      <p className="pc-settings-intro">
        In-process plugin host state. Plugins are discovered from{' '}
        <code>~/.papercusp/global-plugins/</code> on first request and cached
        until the next reset, install, uninstall, or hot-reload trigger.
      </p>
      {status === null ? (
        <div className="pc-card" style={{ padding: 24, color: 'var(--bad)' }}>
          Failed to read <code>/api/plugins/runtime/status</code>. Is the server up?
        </div>
      ) : (
        <RuntimeView status={status} />
      )}
    </div>
  );
}
