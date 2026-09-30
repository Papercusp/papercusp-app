'use client';

/**
 * Canonical list of every keyboard shortcut the operator binds.
 *
 * Why a registry: shortcuts are user-customizable through
 * `/settings/shortcuts`. The page UI, the cheat-sheet modal, and the
 * runtime bindings all read from this same source of truth so a remap
 * in settings flows through to every surface.
 *
 * To add a new shortcut: add an entry here, then call
 * `useShortcutAction('my.shortcut.id', handler)` from the component
 * that owns the action. The settings page picks it up automatically.
 *
 * Combo grammar:
 *   - `mod+k`              → Cmd on macOS, Ctrl elsewhere
 *   - `mod+shift+p`        → adds Shift modifier
 *   - `mod+k, mod+shift+p` → comma separates alternates (either fires)
 *   - `j, ArrowDown`       → either single key fires the binding
 *   - `g>d`                → sequence: g, then d (within 1 s)
 *   - `slash`, `bracketright`, `Enter`, `Space`, `Escape` → named keys
 *   - Spaces are insignificant; `mod + k` and `mod+k` are equivalent.
 */
import type { ActionOptions } from './shortcut-bus';
import { wsLocalKey } from './browser-workspace';
import { reconcileProfilePref, shallowJsonEquals, writeProfileField } from './profile-pref';

export type ShortcutCategory = 'global' | 'navigation' | 'history' | 'editor' | 'palette' | 'voice';

export interface ShortcutDef {
  /** Stable id used for storage + the settings UI. Dotted convention. */
  id: string;
  /** Human-readable label shown in the cheat-sheet + settings page. */
  description: string;
  /** Default combo (or comma-separated alternates). */
  defaultCombo: string;
  category: ShortcutCategory;
  /**
   * Per-shortcut option defaults (merged before per-call options on
   * `useShortcutAction`). Most relevant for `enableOnFormTags`.
   */
  options?: Partial<ActionOptions>;
  /**
   * Optional Action Registry command id. If set, the shortcut auto-fires
   * the registry command — the consumer doesn't need to wire a handler.
   * The component-side `useShortcutAction(id, ...)` still wins (registers
   * later, runs first), so per-component overrides keep working.
   */
  command?: string;
}

// Order in this array drives the order in the cheat-sheet + settings UI
// (within each category). Keep related shortcuts adjacent.
export const SHORTCUTS: readonly ShortcutDef[] = [
  // ── Global / palette ────────────────────────────────────────────
  {
    id: 'palette.toggle',
    description: 'Open or close the command palette',
    // Two alternates — either fires the toggle (Discord-parity pass,
    // discord-shortcuts 2026-06-06):
    //   * Mod+K    — PRIMARY: Discord/Linear/Slack quick-switcher muscle
    //                memory (works in the Tauri webview; only FF/Safari
    //                browsers swallow it for address-bar search).
    //   * Mod+P    — overrides the browser print dialog (Notion-style).
    //                Browsers let preventDefault win on Ctrl/Cmd+P, so
    //                the user gets our palette, not OS print. Requires
    //                `enableOnFormTags` so it works while focus is in a
    //                textarea/input — otherwise Mod+P inside vditor
    //                would still trigger the browser print path.
    //   (Mod+/ moved to `shortcuts.show` — Discord uses it for the
    //   keyboard-shortcuts help, and we follow.)
    defaultCombo: 'mod+k, mod+p',
    category: 'palette',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    // The quick panel (prompts | brainstorm | docs). On the desktop it is a
    // NATIVE popup window opened by a Tauri global shortcut, so no web handler
    // binds this id there and the combo falls through (category 'global', not
    // 'palette', precisely so an unhandled press is NOT swallowed). The cloud
    // portal mounts the same page as a shell panel and binds this id to it
    // (portal-global-shortcuts-2026-09-06 D-002); the entry lives here so the
    // cheat sheet and settings/shortcuts list the binding in both hosts.
    id: 'panel.quick',
    description: 'Open or close the quick panel (prompts, brainstorm, docs)',
    defaultCombo: 'mod+j',
    category: 'global',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'shortcuts.show',
    description: 'Show keyboard-shortcut cheat-sheet',
    // Mod+/ is Discord's "Keyboard Shortcuts menu" combo; `?` kept as the
    // classic alternate.
    defaultCombo: 'mod+slash, shift+slash',
    // 'global' (not 'palette') — the dispatcher preventDefaults palette
    // combos even when the form-tag guard skips the handler, which would
    // swallow a literal '?' typed into any text input.
    category: 'global',
  },
  // (operator.toggle — the panel.toggle binding on mod+; — was removed with
  // the operator-card panel, unify-agent-launches D-005.)
  {
    id: 'operator.generateIdeas',
    description: 'Ask Papercup for suggestions (Generate ideas)',
    // mod+shift+i — 'i' for ideas. Not bound elsewhere.
    defaultCombo: 'mod+shift+i',
    category: 'global',
  },
  {
    id: 'editor.save',
    description: 'Save the current editor (prompts, memory, etc.)',
    defaultCombo: 'mod+s',
    category: 'editor',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },

  // ── Voice / video (Discord-parity; universal-voice session bus) ───
  // Mute is a BUS control: it applies once at the session host and the
  // resulting state broadcasts to every attached surface (P-004 of
  // universal-voice-interface-2026-06-05). Deafen is LOCAL-only: this
  // surface keeps receiving transcripts but silences its own playout.
  {
    id: 'voice.toggleMute',
    description: 'Toggle microphone mute (shared voice session)',
    defaultCombo: 'mod+shift+m', // Discord: Ctrl+Shift+M
    category: 'voice',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'voice.toggleDeafen',
    description: 'Toggle deafen (silence local voice playout)',
    defaultCombo: 'mod+shift+d', // Discord: Ctrl+Shift+D
    category: 'voice',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'voice.toggleMode',
    description: 'Toggle shared voice mode (push-to-talk / always-on)',
    defaultCombo: 'mod+shift+a',
    category: 'voice',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'voice.forceHost',
    description: 'Force this surface to become the shared voice host/player',
    defaultCombo: 'mod+shift+h',
    category: 'voice',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'video.toggleCamera',
    description: 'Toggle camera (video pane)',
    defaultCombo: 'mod+shift+v', // Discord: Ctrl+Shift+V
    category: 'voice',
  },

  // ── Browser history (back / forward) ────────────────────────────
  // Mirror the universal browser shortcuts. The Tauri webview does NOT
  // wire these by default — without an explicit binding, Alt+Left /
  // Alt+Right are dead keys in the desktop shell. We bind them to the
  // app router's history (Next App Router uses real window.history, so
  // `history.back()` / `history.forward()` traverse the route stack).
  // `enableOnFormTags` so they still navigate while focus sits in an
  // input/textarea — the browser default does the same.
  {
    id: 'navigation.back',
    description: 'Go back (browser history)',
    defaultCombo: 'alt+ArrowLeft',
    category: 'history',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'navigation.forward',
    description: 'Go forward (browser history)',
    defaultCombo: 'alt+ArrowRight',
    category: 'history',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },

  // ── Tab navigation (Linear-style 2-stroke `g b` / `g i`) ────────
  // The dashboard/summary/config/proposals bindings were removed with their
  // /adv tabs (settings-audit 2026-07-09) — their tab ids are long gone from
  // ADV_TAB_IDS, so the settings rows let a user rebind a dead key.
  {
    id: 'goto.brainstorm',
    description: 'Go to Brainstorm tab',
    defaultCombo: 'g>b',
    category: 'navigation',
  },
  {
    id: 'goto.insights',
    description: 'Go to Insights tab',
    defaultCombo: 'g>i',
    category: 'navigation',
  },

  // ── Discord-parity navigation (discord-shortcuts 2026-06-06) ──────
  // Alt+↑/↓ mirrors Discord's prev/next-channel; our channel-analog is
  // the /adv tab strip. Mod+Alt+←/→ mirrors Discord's server switcher;
  // our server-analog is the harness/pot selector. Handlers live in
  // AdvShell (the component that owns the nuqs ?tab= / ?slug= state).
  {
    id: 'goto.prevTab',
    description: 'Previous tab',
    defaultCombo: 'alt+ArrowUp',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'goto.nextTab',
    description: 'Next tab',
    defaultCombo: 'alt+ArrowDown',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'harness.prev',
    description: 'Previous harness (pot)',
    defaultCombo: 'mod+alt+ArrowLeft',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'harness.next',
    description: 'Next harness (pot)',
    defaultCombo: 'mod+alt+ArrowRight',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  // Two-level fullscreen for the /adv tab surface (owner ask 2026-08-31: "I
  // should be able to full screen the main section that shows up inside the
  // tabs"). One press maximizes the tab content inside the app window; a second
  // escalates to real OS fullscreen; Escape walks back down a level at a time.
  // The handler lives in AdvShell (the component that owns the nuqs ?max=
  // state), so the shortcut is a no-op outside /adv — same shape as the tab and
  // harness cycling above.
  {
    id: 'view.fullscreen',
    description: 'Maximize the tab (again for fullscreen, Esc to step back)',
    defaultCombo: 'mod+shift+Enter',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] },
  },
  {
    id: 'goto.inbox',
    description: 'Go to Conversations (inbox)',
    defaultCombo: 'mod+i', // Discord: Ctrl+I opens the inbox
    category: 'navigation',
  },
  {
    id: 'harness.create',
    description: 'Create a new harness (pot)',
    defaultCombo: 'mod+shift+n', // Discord: Ctrl+Shift+N = new server
    category: 'navigation',
  },
  {
    id: 'settings.open',
    description: 'Open settings',
    defaultCombo: 'mod+comma', // Discord (and most apps): Ctrl+,
    category: 'navigation',
  },
  {
    id: 'search.global',
    description: 'Search everywhere (plans, docs, turns, decisions)',
    defaultCombo: 'mod+shift+f', // Discord: search all channels
    category: 'global',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'panel.togglePresence',
    description: 'Toggle the live-agents rail (member list)',
    defaultCombo: 'mod+u', // Discord: Ctrl+U member list
    category: 'global',
  },

  // (The 'feature-list' category — feature.move-down/up/next/prev/open/search/
  // reset/toggle-select/cycle-status/search-blur — was removed in the
  // settings-audit 2026-07-09: no FeatureList component with keyboard
  // navigation exists any more, so all ten ids were unregistered rows the
  // settings page still offered to rebind. `find.open` below is 'navigation',
  // not feature-list, and stays.)
  {
    id: 'find.open',
    description: 'Find in page (highlight + scroll matches)',
    // Mod+F opens the in-app find bar (GlobalFindInPage) and claims the
    // combo from the webview's own find: native find-in-page is
    // inconsistent across Tauri webviews (WebView2 yes, WKWebView /
    // WebKitGTK no), so we own it. The global dispatcher
    // (`GlobalShortcutDispatcher`) preventDefaults whenever a registered
    // action runs; shortcut-bus also id-claims `find.open` so the native
    // find never shows even before the handler mounts. `enableOnFormTags`
    // is required so Ctrl+F works while focus is in the chat composer /
    // vditor / any input.
    defaultCombo: 'mod+f',
    category: 'navigation',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
] as const;

const SHORTCUT_BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s] as const));

export function getShortcutDef(id: string): ShortcutDef | undefined {
  return SHORTCUT_BY_ID.get(id);
}

// ── Storage ─────────────────────────────────────────────────────────

const STORAGE_KEY = 'papercusp.shortcuts.v1';

export type OverrideMap = Record<string, string>;

export function loadOverrides(): OverrideMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(wsLocalKey(STORAGE_KEY));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as OverrideMap) : {};
  } catch {
    return {};
  }
}

/**
 * Write the override map to the local cache + notify in-page listeners —
 * WITHOUT pushing to PG. Shared by the mutators (which queue the PG write
 * separately) and {@link reconcileShortcutOverrides} (adopting a PG value).
 * localStorage 'storage' events fire only in OTHER tabs, so emit a synthetic
 * event so our own components re-bind.
 */
function setOverridesLocal(all: OverrideMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(wsLocalKey(STORAGE_KEY), JSON.stringify(all));
  window.dispatchEvent(new CustomEvent('papercusp:shortcuts-changed'));
}

export function saveOverride(id: string, combo: string): void {
  if (typeof window === 'undefined') return;
  const all = loadOverrides();
  const trimmed = combo.trim();
  if (!trimmed) {
    delete all[id];
  } else {
    all[id] = trimmed;
  }
  setOverridesLocal(all);
  // PG is the source of truth (survives the desktop webview's flaky
  // localStorage); cache above keeps the binding instant.
  writeProfileField('shortcut_overrides', all);
}

export function resetOverride(id: string): void {
  saveOverride(id, '');
}

export function resetAllOverrides(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(wsLocalKey(STORAGE_KEY));
  window.dispatchEvent(new CustomEvent('papercusp:shortcuts-changed'));
  writeProfileField('shortcut_overrides', {});
}

/**
 * Reconcile shortcut overrides from PG on app mount — adopt the stored profile
 * map if it differs from the local cache. Pre-existing local-only overrides
 * (from before this migration) are preserved: a missing PG field parses to
 * null and is skipped, and they get pushed to PG the next time the user edits
 * a binding.
 */
export function reconcileShortcutOverrides(): Promise<OverrideMap | null> {
  return reconcileProfilePref<OverrideMap>({
    field: 'shortcut_overrides',
    parse: (raw) =>
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as OverrideMap) : null,
    current: loadOverrides,
    equals: shallowJsonEquals,
    adopt: setOverridesLocal,
  });
}

export function effectiveCombo(id: string, overrides?: OverrideMap): string {
  const def = SHORTCUT_BY_ID.get(id);
  if (!def) return '';
  const o = overrides ?? loadOverrides();
  return (o[id] ?? def.defaultCombo).trim();
}
