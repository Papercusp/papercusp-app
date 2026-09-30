'use client';

import { useSyncExternalStore } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { injectedPref, reconcileProfilePref, writeProfileField } from '@papercusp/operator-core/lib/profile-pref';

export type VisualEffectsMode = 'system' | 'full' | 'minimal';
export type EffectiveVisualEffects = 'full' | 'minimal';

export const VISUAL_EFFECTS_STORAGE_KEY = 'papercusp.visualEffectsMode';
export const VISUAL_EFFECTS_CHANGE_EVENT = 'papercusp:visual-effects-changed';
export const VISUAL_EFFECTS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const VISUAL_EFFECTS_MODES = new Set<VisualEffectsMode>(['system', 'full', 'minimal']);

export function isVisualEffectsMode(value: unknown): value is VisualEffectsMode {
  return typeof value === 'string' && VISUAL_EFFECTS_MODES.has(value as VisualEffectsMode);
}

function getReducedMotionPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(VISUAL_EFFECTS_REDUCED_MOTION_QUERY).matches;
}

export function readVisualEffectsMode(): VisualEffectsMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(wsLocalKey(VISUAL_EFFECTS_STORAGE_KEY));
    if (isVisualEffectsMode(stored)) return stored;
  } catch {
    /* fall through to the injected value */
  }
  // Cache cold/unreliable after a desktop reload: fall back to the host-injected
  // PG value so the snapshot matches what the boot script painted (otherwise
  // React resets data-visual-effects to 'system' on first render).
  const injected = injectedPref('visual_effects_mode');
  return isVisualEffectsMode(injected) ? injected : 'system';
}

export function getEffectiveVisualEffects(mode: VisualEffectsMode): EffectiveVisualEffects {
  if (mode === 'minimal') return 'minimal';
  if (mode === 'system' && getReducedMotionPreference()) return 'minimal';
  return 'full';
}

export function applyVisualEffectsMode(mode: VisualEffectsMode = readVisualEffectsMode()): void {
  if (typeof document === 'undefined') return;
  const safeMode = isVisualEffectsMode(mode) ? mode : 'system';
  const effective = getEffectiveVisualEffects(safeMode);
  document.documentElement.dataset.visualEffects = effective;
  document.documentElement.dataset.visualEffectsMode = safeMode;
}

/**
 * Write the mode to the local cache, apply it, and notify subscribers —
 * WITHOUT pushing to PG. Shared by {@link writeVisualEffectsMode} (after it
 * queues the PG write) and {@link reconcileVisualEffectsMode} (adopting a
 * value that came FROM PG).
 */
function setVisualEffectsModeLocal(mode: VisualEffectsMode): void {
  const safeMode = isVisualEffectsMode(mode) ? mode : 'system';
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(wsLocalKey(VISUAL_EFFECTS_STORAGE_KEY), safeMode);
    } catch {
      // localStorage can be unavailable in private/embedded contexts; still apply in-memory.
    }
  }
  applyVisualEffectsMode(safeMode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(VISUAL_EFFECTS_CHANGE_EVENT, {
        detail: { mode: safeMode, effective: getEffectiveVisualEffects(safeMode) },
      }),
    );
  }
}

/**
 * Set the visual-effects mode: cache + apply + notify (instant), and persist
 * to the operator profile in PG (source of truth). Canonical entry point for
 * the settings UI.
 */
export function writeVisualEffectsMode(mode: VisualEffectsMode): void {
  const safeMode = isVisualEffectsMode(mode) ? mode : 'system';
  setVisualEffectsModeLocal(safeMode);
  writeProfileField('visual_effects_mode', safeMode);
}

/**
 * Reconcile the visual-effects mode from PG on app mount — adopt the stored
 * profile value if it differs from the local cache. Mirrors the host pre-paint
 * injection; keeps other/long-lived windows in sync and recovers when
 * injection is absent.
 */
export function reconcileVisualEffectsMode(): Promise<VisualEffectsMode | null> {
  return reconcileProfilePref<VisualEffectsMode>({
    field: 'visual_effects_mode',
    parse: (raw) => (isVisualEffectsMode(raw) ? raw : null),
    current: readVisualEffectsMode,
    adopt: setVisualEffectsModeLocal,
  });
}

export function subscribeVisualEffects(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const sync = () => {
    applyVisualEffectsMode();
    listener();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === wsLocalKey(VISUAL_EFFECTS_STORAGE_KEY)) sync();
  };

  window.addEventListener(VISUAL_EFFECTS_CHANGE_EVENT, sync);
  window.addEventListener('storage', handleStorage);

  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia(VISUAL_EFFECTS_REDUCED_MOTION_QUERY)
    : null;
  media?.addEventListener?.('change', sync);
  media?.addListener?.(sync);

  return () => {
    window.removeEventListener(VISUAL_EFFECTS_CHANGE_EVENT, sync);
    window.removeEventListener('storage', handleStorage);
    media?.removeEventListener?.('change', sync);
    media?.removeListener?.(sync);
  };
}

function getVisualEffectsSnapshot(): EffectiveVisualEffects {
  const mode = readVisualEffectsMode();
  applyVisualEffectsMode(mode);
  return getEffectiveVisualEffects(mode);
}

function getServerVisualEffectsSnapshot(): EffectiveVisualEffects {
  return 'full';
}

export function useEffectiveVisualEffects(): EffectiveVisualEffects {
  return useSyncExternalStore(
    subscribeVisualEffects,
    getVisualEffectsSnapshot,
    getServerVisualEffectsSnapshot,
  );
}

export function useFancyEffectsEnabled(): boolean {
  return useEffectiveVisualEffects() === 'full';
}
