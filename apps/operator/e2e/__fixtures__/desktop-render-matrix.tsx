import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostedDesktopWorkspace, type DesktopSelection } from '../../app/cloud-workspaces/HostedDesktopWorkspace';
import type { HostedDesktopViewerState } from '../../app/cloud-workspaces/HostedDesktopViewer';

// Component/state evidence only. Keep the actual viewer and substitute only its
// transport and RFB boundary, as the existing viewer unit tests do.
class LocalSocket extends EventTarget {
  static OPEN = 1; static CLOSED = 3; static CONNECTING = 0; static CLOSING = 2;
  readyState = LocalSocket.OPEN;
  binaryType = 'arraybuffer';
  constructor(readonly url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send() {}
  close(code = 1000, reason = '') { this.readyState = LocalSocket.CLOSED; this.dispatchEvent(new CloseEvent('close', { code, reason })); }
}
window.WebSocket = LocalSocket as unknown as typeof WebSocket;
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url, location.href).pathname === '/api/hosted/workspaces/fixture-workspace/connectors/session-ticket') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ticket: `ht_${'a'.repeat(43)}` }), { headers: { 'content-type': 'application/json' } }));
  }
  return originalFetch(input, init);
};
const state = new URL(location.href).searchParams.get('state') ?? 'disconnected';
const theme = new URL(location.href).searchParams.get('theme') ?? 'light';
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;
function Fixture() {
  const [viewerState, setViewerState] = useState<HostedDesktopViewerState | null>(null);
  const [selected, setSelected] = useState<DesktopSelection | null>(
    state === 'ready' ? { desktopSessionId: 'fixture-display-1', mode: 'watch' } : null,
  );
  return <main>
    <p role="note">Controlled {state} fixture · no real service connection</p>
    <HostedDesktopWorkspace
      hostName="Design acceptance fixture" workspaceId="fixture-workspace" hostId="fixture-host"
      routeLabel="fixture-route"
      bridge={state === 'disconnected' ? null : { requestRoster: () => true, requestThumbnail: () => true, requestStart: () => true }}
      roster={state === 'ready' ? [{ desktopSessionId: 'fixture-display-1', displayNumber: 1,
        state: 'running', geometry: '1280x720', lastActiveAt: '2026-09-08T12:00:00Z' }] : []}
      rosterState={state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'ready'}
      rosterError={state === 'error' ? 'Controlled roster error' : null}
      startState="idle" startError={null} thumbnails={{}}
      selectedDesktop={selected} viewerState={viewerState}
      onSelectDesktop={setSelected} onViewerStateChange={setViewerState}
      pinned={[]} onPinnedChange={() => {}} filter="" onFilterChange={() => {}}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
