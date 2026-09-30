'use client';

/**
 * React hook for registering a feature-specific UI intent.
 *
 * Usage:
 *   useUiIntent('refresh-build', () => refetch());
 *   useUiIntent('open-feature-modal', ({ featureId }) => setOpen(featureId));
 *
 * The intent is registered on mount and unregistered on unmount, so
 * it only exists while the component is on screen. Agents that
 * dispatch a non-mounted intent get back `unknown_intent`.
 */

import { useEffect, useRef } from 'react';
import { registerIntent, type IntentHandler } from '@papercusp/operator-core/lib/ui/intent-registry';

export function useUiIntent(name: string, handler: IntentHandler): void {
  // Keep handler fresh without re-registering on every render — the
  // outer wrapper stays stable, but `latestRef.current` follows the
  // handler closure across renders.
  const latestRef = useRef(handler);
  latestRef.current = handler;

  useEffect(() => {
    const wrapper: IntentHandler = (args) => latestRef.current(args);
    return registerIntent(name, wrapper, { builtIn: false });
  }, [name]);
}
