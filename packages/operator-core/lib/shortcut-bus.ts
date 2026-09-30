'use client';

/**
 * Runtime action bus — the Notion pattern for keyboard shortcuts.
 *
 * Notion's framework chunk attaches **one** keydown listener to
 * `window` at app-shell mount time, then dispatches every key event
 * through a single matcher that consults the resolved keymap. Each
 * registered action lives in a registry keyed by shortcut id; the
 * dispatcher looks up `keymap[id]` per registered action and fires
 * the matching one.
 *
 * Why this beats per-component `addEventListener`:
 *   - Print/save/find browser defaults are preventDefaulted on EVERY
 *     route, not just the page that happens to bind a hotkey. The user
 *     was hitting Ctrl+P from `/settings` etc., where no useShortcut
 *     was mounted, and the print dialog won.
 *   - One pass of registry → match → run, deterministic ordering.
 *   - Modal-/scope-/form-tag- guards live on the action options, not in
 *     scattered ad-hoc handlers.
 *
 * API:
 *   - `registerAction(id, opts)` returns an unregister function.
 *   - `dispatchKeydown(e)` is called by the global dispatcher.
 *
 * Multiple actions registered for the same id stack like a list:
 * the **most recently registered** runs first. If it returns false,
 * the next one is tried (so a parent and child can both bind the same
 * shortcut and the child shadows). In practice almost no one needs
 * stacking — every ID is registered by exactly one component.
 */
import { SHORTCUTS, effectiveCombo, getShortcutDef } from './shortcut-registry';
import { parseCombo, tryMatch, type ParsedCombo } from './shortcut-match';

export interface ActionOptions {
  /**
   * Allow the shortcut to fire while focus is in a form input. Defaults
   * to **false** — typing `j` in a textbox shouldn't move the feature
   * cursor. Set to e.g. `['INPUT', 'TEXTAREA']` for editor-save shortcuts.
   */
  enableOnFormTags?: ReadonlyArray<'INPUT' | 'TEXTAREA' | 'SELECT'>;
  /**
   * Returning true skips this action without firing. Useful for "don't
   * fire while a peek-modal is open".
   */
  ignoreEventWhen?: (e: KeyboardEvent) => boolean;
  /**
   * Override the default true (browser default cancelled when this
   * action fires). Set to false for shortcuts that should fall through.
   */
  preventDefault?: boolean;
}

export interface RegisteredAction {
  id: string;
  run: (e: KeyboardEvent) => void | boolean;
  options: ActionOptions;
}

const actionsById = new Map<string, RegisteredAction[]>();

/**
 * Register an action for a given shortcut id. Returns an unregister
 * function the caller MUST call on unmount.
 */
export function registerAction(action: RegisteredAction): () => void {
  const list = actionsById.get(action.id);
  if (list) list.unshift(action); // newest first
  else actionsById.set(action.id, [action]);
  return () => {
    const cur = actionsById.get(action.id);
    if (!cur) return;
    const idx = cur.indexOf(action);
    if (idx >= 0) cur.splice(idx, 1);
    if (cur.length === 0) actionsById.delete(action.id);
  };
}

/**
 * Resolved keymap snapshot built from the registry + active overrides.
 * The dispatcher refreshes this on overrides-changed.
 */
interface ResolvedEntry {
  id: string;
  combo: ParsedCombo;
}

let resolvedKeymap: ResolvedEntry[] = [];

export function refreshKeymap(overrides: Record<string, string>): void {
  // `SHORTCUTS` is statically imported above. It's only read here, at
  // call time (a React effect) — long after every module has evaluated —
  // so the ESM live binding is safe even if `shortcut-registry` and this
  // module form an import cycle. (Was a CommonJS `require()` for "lazy"
  // cycle-avoidance; that left a bare `require` in the browser bundle,
  // which crashes under Vite — `require` is not a browser global.)
  const list: ResolvedEntry[] = [];
  for (const def of SHORTCUTS as ReadonlyArray<{ id: string }>) {
    const raw = effectiveCombo(def.id, overrides);
    if (!raw) continue;
    list.push({ id: def.id, combo: parseCombo(raw) });
  }
  resolvedKeymap = list;
}

/** Currently-resolved keymap (read-only). Test/debug helper. */
export function getResolvedKeymap(): ReadonlyArray<ResolvedEntry> {
  return resolvedKeymap;
}

function isFormTag(target: EventTarget | null): null | 'INPUT' | 'TEXTAREA' | 'SELECT' {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return tag;
  // contentEditable counts as a form tag for safety.
  if (el.isContentEditable) return 'TEXTAREA';
  return null;
}

/**
 * Walk the keymap, find any combo that matches the event, run its
 * registered actions. Returns the matched shortcut id, if any (the
 * dispatcher uses this for preventDefault + diagnostic logging).
 */
export function dispatchKeydown(e: KeyboardEvent): string | null {
  for (const entry of resolvedKeymap) {
    if (!tryMatch(entry.id, entry.combo, e)) continue;
    // We have a match — find a runnable registered action.
    const list = actionsById.get(entry.id);
    if (!list || list.length === 0) {
      // Match but no handler. Still preventDefault if the registry def
      // has a known browser shortcut we want to claim — that way the
      // browser print dialog is suppressed even on routes that don't
      // bind the action (e.g. `/settings` for Cmd+P).
      const def = getShortcutDef(entry.id);
      if (def?.category === 'palette' || def?.category === 'editor' || entry.id === 'find.open') {
        e.preventDefault();
      }
      return entry.id;
    }
    // Try newest-first; if a handler returns false, fall through to next.
    for (const action of list) {
      const formTag = isFormTag(e.target);
      if (formTag && !(action.options.enableOnFormTags?.includes(formTag))) continue;
      if (action.options.ignoreEventWhen?.(e)) continue;
      const result = action.run(e);
      if (result === false) continue; // explicit skip
      if (action.options.preventDefault !== false) e.preventDefault();
      return entry.id;
    }
    // All handlers skipped — but the combo did match. Still preventDefault
    // for known browser-shortcut categories so we don't trigger the print
    // dialog while a modal-open guard skipped us.
    const def = getShortcutDef(entry.id);
    if (def?.category === 'palette' || def?.category === 'editor' || entry.id === 'find.open') {
      e.preventDefault();
    }
    return entry.id;
  }
  return null;
}

/** Internal — for tests. */
export function _resetActions() {
  actionsById.clear();
}
