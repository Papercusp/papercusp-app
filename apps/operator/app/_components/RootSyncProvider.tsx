'use client';
import type { ReactNode } from 'react';
import { enablePersistedSyncCache } from '@papercusp/sync';
import { HarnessSyncProvider } from '../../providers/HarnessSyncProvider';
import { installDesktopIpcPolyfills } from '@papercusp/operator-core/lib/transport-adapters/desktop-bootstrap';
import { installWorkspaceHeaderFetch } from '@papercusp/operator-core/lib/transport-adapters/workspace-header-fetch';
import { installWorkspaceParamEventSource } from '@papercusp/operator-core/lib/transport-adapters/workspace-eventsource';
import { installOriginSchedulerFetch } from '@papercusp/operator-core/lib/transport-adapters/origin-scheduler-fetch';
import { installCallToolResolver } from '@papercusp/operator-core/lib/call-tool-resolver';
import { installIpcInspector } from '@papercusp/operator-core/lib/dev/ipc-inspector-client';
import HostedWorkspaceSelectionGate from './HostedWorkspaceSelectionGate';
import UpdateMismatchNotifier from './UpdateMismatchNotifier';
import { VoicePrefsSyncBridge } from './voice/VoicePrefsSyncBridge';

/**
 * Root sync provider. Wraps the app in `HarnessSyncProvider` and, on
 * Tauri, installs the desktop IPC polyfills so same-origin /api/*
 * `fetch` and every `EventSource` ride the IPC bridge instead of the
 * webview's HTTP connection pool.
 *
 * The install fires at *module-evaluation time*, not in `useEffect`:
 * React effects run in child-first commit order, so a `useEffect` here
 * would land *after* child components' effects had already opened their
 * SSE streams against the native `EventSource`. Module-eval runs once
 * per bundle load, well before any component's runtime
 * `new EventSource(...)` call. See
 * `lib/transport-adapters/desktop-bootstrap.ts` for the install rules.
 *
 * `installWorkspaceHeaderFetch` + `installWorkspaceParamEventSource` run
 * immediately after, wrapping whatever `window.fetch` / `window.EventSource` now
 * are — `ipcFetch`/`IpcEventSource` on desktop, native in the dev browser. The
 * fetch wrapper stamps `x-papercusp-workspace`; the EventSource wrapper appends
 * `?ws=` (streams can't set headers). Both make the backend resolve per-window
 * rather than against the global `reg.current`
 * (per-window-workspace-context-2026-05-31, P-013/P-015). They must install
 * after the IPC polyfills (to wrap the IPC transports) but before any component
 * opens a stream — module-eval ordering guarantees that.
 */
if (typeof window !== 'undefined') {
  // Dev-only IPC-traffic recorder. Installs FIRST so it captures every dispatch
  // from the very first one; no-op in production. Exposes window.__ipcInspector
  // (.churn()/.summary()/.events()) — Plan: calltool-endpoint-seam (Phase C).
  installIpcInspector();
  installDesktopIpcPolyfills();
  installWorkspaceHeaderFetch();
  // P-019: route every finite operator API fetch through the one process-pinned
  // per-origin scheduler. This wraps the already-installed IPC/workspace layer,
  // so desktop routing and per-window workspace headers remain transparent;
  // sync-owned rest-query and long-lived streams are explicitly skipped.
  installOriginSchedulerFetch();
  installWorkspaceParamEventSource();
  // Register the callTool seam's transport resolver (tool name → canonical route
  // + Phase-E eligibility). No runtime change yet — nothing calls callTool until
  // the Phase B migration. Plan: calltool-endpoint-seam-2026-06-01.
  installCallToolResolver();
  // Persisted sync cache (WI-3318): hydrate the sync QueryClient from
  // localStorage NOW — module-eval runs before any component mounts, so the
  // first render of every panel paints from the last session's data while
  // staleTime + SSE invalidates revalidate it in the background. Bump the
  // buster when sync row shapes change incompatibly.
  enablePersistedSyncCache({ buster: 'v1' });
}

export function RootSyncProvider({ children }: { children: ReactNode }) {
  return (
    <HostedWorkspaceSelectionGate>
      <HarnessSyncProvider>
        {/* P-013: surface a post-update stale-operator mismatch (EI-9002) to the user. */}
        <UpdateMismatchNotifier />
        <VoicePrefsSyncBridge />
        {children}
      </HarnessSyncProvider>
    </HostedWorkspaceSelectionGate>
  );
}
