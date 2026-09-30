/**
 * Workbench panels — the three panes of the top-level desktop workbench
 * (plan `desktop-workbench-shell-2026-06-05`, P-002/P-003/P-004).
 *
 *   workbench:pui   → the embedded pui terminal (`/pi?harness=<slug>`)
 *   workbench:app   → the main /adv app (IframePanel, src baked in the seed)
 *   workbench:voice → the voice/video comms pane
 *
 * Per D-001 there is NO standalone operator-chat pane — the operator chat
 * lives inside the /adv app pane. Per D-005 the voice/video pane reserves
 * two seams: the holepunch `VideoGrid` (su-5729780f's
 * `holepunch-video-shared-harnesses`) and the universal-voice GUI
 * (su-3391a1bf's `universal-voice-interface`). Those land as separate
 * deliverables and slot into the seams below — this pane owns the mount
 * points, not the in-flight content.
 *
 * The active `harnessSlug` is patched into the pui + voice panels at
 * runtime from the route's `?harness=` (the dock-preview pattern), so the
 * static seed bakes an empty slug.
 */

'use client';

import { useEffect } from 'react';
import { panelRegistry, type PanelComponentProps } from './panel-registry';
import { IframePanel } from './IframePanel';

const fill: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const mute: React.CSSProperties = {
  color: 'var(--fg-mute, #888)',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
};

function EmptyPaneNote({ lines }: { lines: string[] }) {
  return (
    <div
      style={{
        ...fill,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 16,
        textAlign: 'center',
      }}
    >
      {lines.map((l, i) => (
        <span key={i} style={mute}>
          {l}
        </span>
      ))}
    </div>
  );
}

/**
 * pui pane — embeds the `/pi` terminals dock for the active harness.
 *
 * ⚠ RETIRED as the desktop terminal (native-terminal-desktop-2026-06-06,
 * D-002/D-008, superseding desktop-workbench-shell D-003). A webview can only
 * host a *web* terminal (iframe/xterm.js), never a NATIVE one — so the desktop
 * terminal is now a native sibling window glued to the GUI (the Tauri shell's
 * `native_terminal.rs`), NOT a dockview pane. This component is no longer
 * seeded into `defaultWorkbenchLayout` (a guard test enforces that), and is
 * kept only per the NO_TS_DELETION rule + for any standalone `/pi` consumer.
 * Do not re-add `workbench:pui` to the workbench seed.
 */
export function WorkbenchPuiPanel({ params }: PanelComponentProps) {
  const harnessSlug = typeof params.harnessSlug === 'string' ? params.harnessSlug : '';
  if (!harnessSlug) {
    return (
      <EmptyPaneNote
        lines={[
          'No harness selected for the pui pane.',
          'Pick a harness in the workbench header (or pass ?harness=<slug>).',
        ]}
      />
    );
  }
  const src = `/pi?harness=${encodeURIComponent(harnessSlug)}`;
  return (
    <iframe
      key={harnessSlug}
      src={src}
      title={`pui: ${harnessSlug}`}
      data-testid="workbench-pui-iframe"
      style={{ border: 0, width: '100%', height: '100%' }}
    />
  );
}

// NOTE: the `workbench:voice` panel lives on the operator-vite side
// (`apps/operator-vite/src/components/workbench/WorkbenchVoicePanel.tsx`)
// because it mounts the holepunch `VideoGrid`, which is an operator-vite
// component this package cannot import (the dependency direction is
// operator-vite → @/app, not the reverse). The route registers it via
// `registerWorkbenchVoicePanel()`.

let registered = false;

/**
 * Register the pui + app workbench panel types. Idempotent; safe to call from
 * the route on mount and on module import. (`workbench:voice` is registered
 * separately from operator-vite — see the note above.)
 */
export function registerWorkbenchPanels(): void {
  if (registered) return;
  registered = true;
  panelRegistry.register('workbench:pui', WorkbenchPuiPanel, { keepAlive: true });
  // The /adv app pane reuses the generic IframePanel — its src is baked into
  // the seed params ({ src: '/adv' }), and the iframe-host portal keeps it
  // alive across drag-reparent.
  panelRegistry.register('workbench:app', IframePanel, { keepAlive: true, title: 'App' });
}

export function useEnsureWorkbenchPanels(): void {
  useEffect(() => {
    registerWorkbenchPanels();
  }, []);
}

// Self-register on import so the registry is populated before the dock's
// first layout walk (mirrors sample-panels.tsx).
registerWorkbenchPanels();
