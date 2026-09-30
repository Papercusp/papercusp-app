'use client';

import { useEffect } from 'react';

/**
 * Restore native text selection inside sonner toasts.
 *
 * Sonner v2.0.7 attaches a `pointerdown` handler to every toast `<li>` that
 * calls `event.target.setPointerCapture(event.pointerId)` to track its
 * swipe-to-dismiss gesture. Pointer capture prevents the browser from
 * starting a text selection on the same drag — so users trying to copy an
 * error message end up "dragging the panel" instead of selecting the text.
 *
 * Upstream issue: https://github.com/emilkowalski/sonner/issues/664 (closed
 * without a fix; the maintainer's stance is "embed a copy button in your
 * toast content"). The community-recommended workarounds are either invasive
 * (modify every `toast()` call site) or partial (CSS `user-select: text` —
 * doesn't help because pointer capture stops selection from ever starting).
 *
 * This component installs a capture-phase `pointerdown` listener on the
 * window. When the event target is inside a sonner toast, we call
 * `stopImmediatePropagation()` — which runs **before** sonner's React
 * handler at the root, so sonner never sees the event, never captures the
 * pointer, and the browser's native selection works as expected. Click
 * events are unaffected (they're a separate event type), so the toast's
 * close button (✕) and any other buttons inside the toast still work.
 *
 * The `Toaster` is mounted with `closeButton` to provide the dismiss
 * affordance that swipe-to-dismiss used to.
 */
export function ToasterSelectionFix() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      const toast = target.closest('ol[data-sonner-toaster] > li');
      if (!toast) return;
      // Don't block pointerdown on actual interactive controls — they need
      // it for focus/active styles. The click event still fires for
      // activation regardless.
      if (target.closest('button, [role="button"], a, input, textarea, select')) return;
      e.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, []);

  return null;
}
