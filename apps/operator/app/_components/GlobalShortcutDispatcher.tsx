'use client';

/**
 * Single window-level keydown listener — the Notion pattern.
 *
 * Notion's framework chunk attaches one `window.addEventListener("keydown", ...)`
 * at the app shell, then dispatches every event through their resolved
 * keymap. We do the same here:
 *
 *   1. Resolve the registry → keymap on mount + whenever the override
 *      store changes.
 *   2. Listen on `window`, bubble phase (matches Notion).
 *   3. On each keydown, walk the keymap, call the matching action.
 *      The action's options handle modal-skip / form-input gating.
 *      The dispatcher calls `preventDefault()` automatically when an
 *      action fires, so browser defaults (print, save-as, in-page find)
 *      never trigger on shortcuts we own.
 *
 * Mount this component **exactly once** at the root of the app
 * (`app/layout.tsx`). It renders nothing.
 */
import { useEffect } from 'react';
import { dispatchKeydown, refreshKeymap } from '@papercusp/operator-core/lib/shortcut-bus';
import { loadOverrides } from '@papercusp/operator-core/lib/shortcut-registry';

export default function GlobalShortcutDispatcher() {
  useEffect(() => {
    // Initial keymap.
    refreshKeymap(loadOverrides());

    // Refresh keymap when the user remaps a shortcut.
    const onChange = () => refreshKeymap(loadOverrides());
    window.addEventListener('papercusp:shortcuts-changed', onChange);
    window.addEventListener('storage', onChange); // cross-tab

    // Single window-level dispatcher. Bubble phase, no third arg —
    // matches Notion's pattern.
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchKeydown(e);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('papercusp:shortcuts-changed', onChange);
      window.removeEventListener('storage', onChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return null;
}
