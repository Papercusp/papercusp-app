import { createFileRoute } from '@tanstack/react-router';
import RuntimeView from '@/app/settings/plugin-runtime/RuntimeView';

/**
 * /settings/plugin-runtime — plugin runtime diagnostics. Translated from
 * `apps/operator/app/settings/plugin-runtime/page.tsx`.
 *
 * next → TSR diff: the original was an async Server Component that
 * `fetch`ed `/api/plugins/runtime/status` server-side then rendered
 * `<RuntimeView status={…}>`. Moved the fetch into a TSR `loader`
 * (relative URL — no `PAPERCUSP_INTERNAL_BASE` needed in the SPA). The
 * small wrapper markup (heading, intro, error card) is copied here.
 */

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
  try {
    const r = await fetch('/api/plugins/runtime/status', { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as RuntimeStatus;
  } catch {
    return null;
  }
}

export const Route = createFileRoute('/settings/plugin-runtime')({
  loader: async () => ({ status: await loadStatus() }),
  component: PluginRuntimePage,
});

function PluginRuntimePage() {
  const { status } = Route.useLoaderData();
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
