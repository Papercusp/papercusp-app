'use client';

/**
 * Operator keyboard shortcut hooks — Notion-style.
 *
 * Replaces our prior react-hotkeys-hook adapter with a thin wrapper
 * around the project-local action bus (`lib/shortcut-bus.ts`).
 *
 *   - One global `keydown` listener is mounted at the app shell via
 *     `<GlobalShortcutDispatcher />` in `app/layout.tsx`.
 *   - Components register actions via `useShortcutAction(id, run, opts)`.
 *   - The dispatcher resolves the registry combo for `id`, matches each
 *     keydown against it, and calls the most recently registered action.
 *
 * Public API:
 *   - `useShortcutAction(id, run, opts?)` — bind an action to a registry
 *     id. Run is called with the KeyboardEvent. Default options stop
 *     firing inside form inputs; pass `enableOnFormTags` to opt in.
 *   - `useShortcutOverrides()` — subscribe to override changes (so the
 *     cheat-sheet/settings-page re-render when bindings change).
 *   - Legacy `useShortcut` is kept as an alias for back-compat during
 *     the migration period. New code should call `useShortcutAction`.
 *
 * Removed: `useHotkey`, `HotkeysProvider`, `HOTKEY_SCOPES`, the whole
 * scope abstraction, and the react-hotkeys-hook dependency from active
 * code paths. Scopes never got real use; modal-/form-tag-guards on the
 * action options cover the actual use cases.
 */

import { useEffect, useRef, useState } from 'react';
import { loadOverrides } from '@papercusp/operator-core/lib/shortcut-registry';
import { registerAction, type ActionOptions } from '@papercusp/operator-core/lib/shortcut-bus';

export type { ActionOptions };

/**
 * Subscribe to override changes — re-renders the calling component
 * when a user remap is saved (this tab or another).
 */
export function useShortcutOverrides(): Record<string, string> {
  const [overrides, setOverrides] = useState(() => loadOverrides());
  useEffect(() => {
    const refresh = () => setOverrides(loadOverrides());
    window.addEventListener('papercusp:shortcuts-changed', refresh);
    window.addEventListener('storage', refresh); // cross-tab
    return () => {
      window.removeEventListener('papercusp:shortcuts-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return overrides;
}

/**
 * Bind a handler to a shortcut id from `shortcut-registry.ts`.
 * Returns nothing — the cleanup is automatic on unmount.
 *
 * The `run` callback receives the keyboard event. Returning `false`
 * explicitly skips this handler (so a parent listener registered for
 * the same id can run instead).
 *
 * Default options:
 *   - `enableOnFormTags: undefined` (treated as "block while in form
 *      inputs"). Pass `['INPUT', 'TEXTAREA']` for editor-save style keys.
 *   - `preventDefault: true` (browser default action is cancelled).
 */
export function useShortcutAction(
  id: string,
  run: (e: KeyboardEvent) => void | boolean,
  options: ActionOptions = {},
): void {
  // Stash the latest `run` in a ref so we register ONCE per component
  // mount (or per id change) without unregistering+re-registering on
  // every parent render. This avoids tiny windows where a key press
  // races with a useEffect cleanup that hasn't yet re-registered the
  // new callback.
  const runRef = useRef(run);
  runRef.current = run;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    return registerAction({
      id,
      run: (e) => runRef.current(e),
      options: {
        get enableOnFormTags() { return optionsRef.current.enableOnFormTags; },
        get ignoreEventWhen() { return optionsRef.current.ignoreEventWhen; },
        get preventDefault() { return optionsRef.current.preventDefault; },
      },
    });
  }, [id]);
}

/**
 * Back-compat alias for `useShortcutAction`. Existing call sites pass
 * (id, run, opts, deps) — we accept and ignore the deps array since
 * the new hook doesn't need it (register-on-every-render is cheap).
 */
export function useShortcut(
  id: string,
  run: (e: KeyboardEvent) => void | boolean,
  options: ActionOptions = {},
  _deps: unknown[] = [],
): void {
  useShortcutAction(id, run, options);
}
