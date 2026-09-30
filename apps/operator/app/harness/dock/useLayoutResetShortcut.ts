/**
 * useLayoutResetShortcut — Shift+Esc (1s long-press) hard-resets the
 * current dock layout to its default seed.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §10 Phase 5
 *
 * This is the recovery hatch for "the dock is wedged / blank and I
 * can't get to the reset menu." Long-press avoids accidental triggers.
 *
 * Mount once at the dock root, passing a callback that DELETEs the
 * layout via /api/dock-layouts/:name (server reseeds on next GET).
 */

'use client';

import { useEffect, useRef } from 'react';

const LONG_PRESS_MS = 1000;

export function useLayoutResetShortcut(onReset: () => void): void {
  const triggerRef = useRef(onReset);
  useEffect(() => {
    triggerRef.current = onReset;
  }, [onReset]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pressed = false;

    const isShiftEsc = (e: KeyboardEvent) =>
      e.key === 'Escape' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;

    const onDown = (e: KeyboardEvent) => {
      if (!isShiftEsc(e)) return;
      if (pressed) return;
      pressed = true;
      timer = setTimeout(() => {
        triggerRef.current();
        timer = null;
      }, LONG_PRESS_MS);
    };

    const onUp = (e: KeyboardEvent) => {
      // Release on any keyup (Shift or Escape both reset the press).
      if (e.key === 'Escape' || e.key === 'Shift') {
        pressed = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
