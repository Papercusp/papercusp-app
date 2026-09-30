/**
 * MissingPanel — fallback rendered when a layout references a panel type
 * not yet registered (typically a plugin that hasn't loaded yet).
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §8.3, §8.4
 *
 * Behavior:
 *   1. On mount, subscribe to panelRegistry; if the missing type
 *      registers, re-render and render the real component.
 *   2. If still missing after 10s, switch from "loading…" to
 *      "not installed" with a Remove button.
 */

'use client';

import { useEffect, useState } from 'react';
import { panelRegistry, type PanelComponentProps } from './panel-registry';

const MISSING_PANEL_TIMEOUT_MS = 10_000;

export function MissingPanel(props: PanelComponentProps) {
  const { panelType, api } = props;
  const [tick, setTick] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const unsub = panelRegistry.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), MISSING_PANEL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Re-resolve on every registry tick.
  const entry = panelRegistry.get(panelType);
  if (entry) {
    const Real = entry.component;
    return <Real {...props} />;
  }

  // tick is read so the linter doesn't flag it as unused; it forces
  // the re-resolve above whenever the registry notifies us.
  void tick;

  if (!timedOut) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--fg-mute)',
          fontSize: 13,
        }}
      >
        Loading {panelType}…
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 12,
        color: 'var(--fg-mute)',
        fontSize: 13,
        padding: 16,
        textAlign: 'center',
      }}
    >
      <div>
        Panel type <code style={{ color: 'var(--fg)' }}>{panelType}</code> is not
        installed.
      </div>
      <button
        type="button"
        onClick={() => api.close()}
        style={{
          padding: '6px 12px',
          fontSize: 12,
          background: 'var(--bg-2)',
          color: 'var(--fg)',
          border: '1px solid var(--border, #333)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Remove panel
      </button>
    </div>
  );
}

export { MISSING_PANEL_TIMEOUT_MS };
