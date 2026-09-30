'use client';

/**
 * Pub/sub bus for the aria-live regions.
 *
 * `speak()` (in voice-mode.ts) writes here synchronously alongside its
 * TTS call so screen-reader users see the same text. This module is
 * separate from AriaLiveRegions.tsx so non-React modules (engine
 * adapters, voice-mode bridge) can publish without importing JSX.
 */

import type { Priority } from '@papercusp/operator-core/lib/voice-engines';

type Listener = (priority: Priority, text: string) => void;

const listeners = new Set<Listener>();

export function publishAriaLive(priority: Priority, text: string): void {
  for (const l of listeners) l(priority, text);
}

export function subscribeAriaLiveText(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
