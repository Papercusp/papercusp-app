'use client';

/**
 * React hooks that wrap @papercusp/flags/client with subscription so
 * components re-render when flag values change.
 *
 * Lives in apps/operator (not libs/flags) so libs/flags can stay
 * react-free and bundle into any client surface (Tauri webview,
 * non-React mobile, etc.).
 */
import { useEffect, useState } from 'react';

import { FLAGS_CHANGED_EVENT, type FlagKey, type FlagValues } from '@papercusp/flags';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import {
  getFlagSnapshot,
  loadFlags,
  subscribe,
} from '@papercusp/flags/client';
import { onSyncBusEvent } from '@papercusp/sync';

let bootstrapStarted = false;

// The sync adapter owns the one app-wide SSE transport and reports its
// connectivity to the shared store. Flag changes ride that same transport;
// this hook only turns the event into a normal bootstrap refetch.
function ensureBootstrap(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  if (typeof window === 'undefined') return;
  void loadFlags().catch(() => {
    // network failures fall back to FLAG_DEFAULTS via getFlagSnapshot
  });
  onSyncBusEvent((ev) => {
    if (ev.name !== FLAGS_CHANGED_EVENT) return;
    void loadFlags().catch(() => {
      // Keep the last known payload; the next flip or route bootstrap retries.
    });
  });
}

export function useFlag(key: FlagKey): boolean {
  ensureBootstrap();
  const [value, setValue] = useState<boolean>(() => {
    const snap = getFlagSnapshot();
    return snap.flags[key] ?? FLAG_DEFAULTS[key];
  });
  useEffect(() => {
    const unsub = subscribe((next: FlagValues) => {
      setValue(next[key] ?? FLAG_DEFAULTS[key]);
    });
    return unsub;
  }, [key]);
  return value;
}
