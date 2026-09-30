'use client';

/**
 * usePopupMaximize — the "full window / full screen" pair, extracted from
 * SessionChatModal (session-chat-popup-direction-d-2026-08-02 P-001) so a
 * SECOND popup can have the same two buttons without a second copy of the
 * mechanism [owner 2026-08-10: the goal popup should mimic the sessions popup's
 * "hide and expand buttons"].
 *
 * The mechanism is the part worth sharing, not the buttons: below the two icons
 * sit four things that are each a bug the first time you write them —
 * a DOM-fullscreen exit we did not drive (Esc, F11, a tab switch), the desktop
 * shell needing the WINDOW rather than the document, every failure path having
 * to land on the OTHER mode instead of doing nothing, and never stranding the
 * display when the popup closes or unmounts. A forked copy gets three of them.
 *
 * [owner 2026-08-01 22:29, verbatim] "add 2 buttons. a full window button that
 * makes it take up the full size of the window and a full screen button that
 * makes it take up the full screen."
 *
 * Two modes. `window` grows the popup to the whole app WINDOW; `screen` puts it
 * on the whole DISPLAY.
 *
 * ── D-007 (2026-08-02): the fullscreen TARGET is the popup container ────────
 * [owner 2026-08-02, verbatim] "lets actually make the left panel and right
 * panel and bottom and top panel all show in both full screen views"
 *
 * The browser paints the target element's subtree and nothing else, so pointing
 * `requestFullscreen()` at the CONVERSATION region made the panels — its
 * siblings — structurally impossible to show, however the layout was written.
 * Hence `popupRef`: put it on the container that holds every zone, and a panel
 * added later is included by construction, with no hide-list. A caller that
 * points this ref at an inner region silently drops its own panels again.
 *
 * ── D-006 (2026-08-02): `screen` needs TWO mechanisms ───────────────────────
 * [owner 2026-08-02, verbatim] "both fullscreen buttons do the same thing. one
 * of them is supposed to full screen on the full desktop display not just the
 * window."
 *   - BROWSER — `requestFullscreen()` on the popup container. The UA takes the
 *     OS window fullscreen and paints that element on it.
 *   - DESKTOP (Tauri) — drive the WINDOW (`setFullscreen`) and let the same
 *     maximized layout fill it.
 * The desktop split is NOT because the webview swallows a DOM request — it was
 * measured doing the opposite (see desktop-window-fullscreen.ts's header for
 * the numbers). It is because that call is conditional on transient
 * activation, and EVERY way it can fail lands on `window` — the other button's
 * behavior. A control that degrades into its neighbour reads as a duplicate,
 * which is what was reported. The window path has no gesture requirement, so a
 * deep link and an agent-driven `ui:dispatch` reach the display too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import {
  enterDesktopWindowFullscreen,
  exitDesktopWindowFullscreen,
  isDesktopShell,
} from '@/lib/desktop-window-fullscreen';

export const POPUP_MAX_MODES = ['window', 'screen'] as const;
export type PopupMaxMode = (typeof POPUP_MAX_MODES)[number];

/**
 * Is `el` the element currently painted fullscreen?
 *
 * Deliberately reads the DOM rather than trusting our own "I asked for
 * fullscreen" flag: the user can leave fullscreen by pressing Esc or F11,
 * which fires no click of ours. `document.fullscreenElement` is the only
 * source that is right in every one of those exits.
 */
export function isFullscreenElement(el: Element | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  return document.fullscreenElement === el;
}

export interface PopupMaximize {
  /** The mode in the URL: `null` is the ordinary centred popup. */
  mode: PopupMaxMode | null;
  /** Layout-maximized: true for BOTH modes — see the `maximized` note below. */
  maximized: boolean;
  /** Whether something is ACTUALLY painting us on the whole display. */
  screenActive: boolean;
  /** WHICH mechanism is doing it, when one is — and the caller has to care:
   *  a DOM-fullscreened element is transparent by default (the UA paints only
   *  `::backdrop`, black), so a `'document'` popup must paint its own surface
   *  or its panels sit on bare black. Under `'desktop-window'` nothing is
   *  lifted out of the page and the modal's own surface is still behind it. */
  screenMechanism: 'document' | 'desktop-window' | null;
  /** THE fullscreen target — put it on the container holding every zone. */
  popupRef: React.MutableRefObject<HTMLDivElement | null>;
  toggleWindow: () => void;
  toggleScreen: () => void;
  /** Give the display back. Safe to call when nothing is engaged. */
  exitScreen: () => Promise<void>;
  /** Leave both the display AND the URL mode — for the popup's close path. */
  reset: () => void;
}

/**
 * @param param  the nuqs key this popup's mode lives under. Per-popup, never
 *   shared: two popups on one key would maximize and un-maximize each other,
 *   and a deep link could not say which one it meant.
 * @param open   whether the popup is open. Closing releases the display —
 *   without it the app fills the screen with the control that undoes it no
 *   longer rendered.
 */
export function usePopupMaximize({ param, open }: { param: string; open: boolean }): PopupMaximize {
  /* In the URL like every other bit of popup state (nuqs-by-default) so it is
     deep-linkable and reachable from ui:get_state / ui:dispatch. */
  const [mode, setMode] = useQueryState(param, parseAsStringLiteral(POPUP_MAX_MODES));
  const popupRef = useRef<HTMLDivElement | null>(null);

  /* Whether something is ACTUALLY painting our region on the whole display,
     which is not the same question as `mode === 'screen'` and must not be
     inferred from it. Two ways they diverge, both routine:
       - a shared/reloaded URL carrying the mode cannot enter fullscreen on
         load, because the DOM API requires a user gesture. The page renders
         maximized and the button still offers to go fullscreen;
       - Esc / F11 leaves fullscreen without any click of ours.
     So the host is the authority and this mirrors it. */
  const [screenActive, setScreenActive] = useState(false);

  /* D-006 — the DESKTOP half of `screen`, and the only state that says whether
     we may put the window back:
       'owned'   we fullscreened the window, so exiting is ours to do;
       'adopted' it was ALREADY fullscreen (the user's own F11, another
                 surface) — we ride it and must NOT take it away on the way out;
       null      the desktop path is not engaged (browser, or refused).
     A ref rather than state: it is read inside the document listener below,
     where a stale closure over a state value would make the listener act on
     the mode we were in one render ago. */
  const windowScreen = useRef<'owned' | 'adopted' | null>(null);

  /** Give the window back. Idempotent, and safe to fire from an unmount. */
  const releaseWindowScreen = useCallback(async () => {
    const held = windowScreen.current;
    windowScreen.current = null;
    setScreenActive(false);
    if (held === 'owned') await exitDesktopWindowFullscreen();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => {
      // Desktop path: the DOCUMENT never enters fullscreen there, so a
      // fullscreenchange raised by anything else (a video player, an embedded
      // frame) would read as "the user left fullscreen" and cancel a mode they
      // are still in. The window state is authoritative while it is engaged.
      if (windowScreen.current) return;
      const active = isFullscreenElement(popupRef.current);
      setScreenActive(active);
      // Left fullscreen by a route we did not drive (Esc, F11, the browser
      // dropping it on tab switch) — drop the mode with it, or the popup sits
      // in a maximized layout the user just asked to leave.
      if (!active) setMode((prev) => (prev === 'screen' ? null : prev));
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [setMode]);

  /** Layout-maximized: true for BOTH modes. `screen` still needs the
   *  full-window layout underneath it — if the webview refuses fullscreen (or
   *  a deep link arrives before a gesture can grant it) the user gets the
   *  maximized popup rather than nothing happening. */
  const maximized = mode != null;

  const exitScreen = useCallback(async () => {
    // Desktop first: if the window is carrying the mode, the document is not.
    if (windowScreen.current) {
      await releaseWindowScreen();
      return;
    }
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Already gone, or the UA refused — `fullscreenchange`/the next sync
        // settles the real state either way. Nothing to report to the user.
      }
    }
  }, [releaseWindowScreen]);

  /* Never strand the display. Closing the popup while `screen` is engaged would
     leave the whole app filling the screen with the control that undoes it no
     longer rendered — so release on close AND on unmount, not only in the
     caller's close handler (which a route change or a cleared session skips).
     `exitScreen` rather than `releaseWindowScreen` so this covers the browser's
     DOM fullscreen too; the unmount case cannot wait for an event to correct
     it. */
  useEffect(() => {
    if (!open) void exitScreen();
  }, [open, exitScreen]);
  useEffect(
    () => () => {
      void exitScreen();
    },
    [exitScreen],
  );

  const toggleWindow = useCallback(() => {
    if (mode === 'window') {
      void setMode(null);
      return;
    }
    if (screenActive) {
      // Coming from `screen`: give the display back FIRST (whichever mechanism
      // is holding it), then land in window mode. The set has to come after: the
      // fullscreenchange handler above clears the mode on the way out — without
      // it this click would read as "exit maximize" rather than "switch to
      // full window".
      void exitScreen().then(() => setMode('window'));
      return;
    }
    // The ordinary path stays SYNCHRONOUS. Routing it through the same promise
    // as the fullscreen exit cost a microtask for nothing and made the mode
    // land a tick after the click — a visible flash of the old layout, and a
    // click whose effect a caller could not observe in the same turn.
    void setMode('window');
  }, [mode, screenActive, exitScreen, setMode]);

  const toggleScreen = useCallback(() => {
    if (screenActive) {
      void exitScreen().then(() => setMode(null));
      return;
    }
    /* D-006 — DESKTOP: drive the WINDOW, not the document. The DOM request
       below needs transient activation, and every way it can fail falls through
       to `window` — the other button's mode, which is the reported bug. Moving
       the OS window is unconditional, and readable back afterwards. */
    if (isDesktopShell()) {
      void enterDesktopWindowFullscreen().then(({ active, owned }) => {
        windowScreen.current = active ? (owned ? 'owned' : 'adopted') : null;
        setScreenActive(active);
        // Refused — an older desktop binary whose baked capabilities predate
        // `core:window:allow-set-fullscreen`. Same rule as the browser fallback
        // below: the user asked for bigger, so give the bigger we still have.
        void setMode(active ? 'screen' : 'window');
      });
      return;
    }
    // D-007: the POPUP, not an inner region — this element's subtree is what
    // the browser paints, so it is the only target that keeps every panel.
    const el = popupRef.current;
    // No element, or a webview with the Fullscreen API switched off: fall back
    // to full-window rather than doing nothing. A dead button is the worse
    // failure — the user asked for "bigger" and there IS a bigger we can give.
    if (!el || typeof el.requestFullscreen !== 'function') {
      void setMode('window');
      return;
    }
    void Promise.resolve(el.requestFullscreen())
      .then(() => setMode('screen'))
      .catch(() => setMode('window'));
  }, [screenActive, exitScreen, setMode]);

  /* D-003 — Esc leaves DESKTOP full screen.
     In the browser the UA owns Esc while it paints a fullscreen element, which
     is why the dialog's own `closeOnEscape` is disarmed by callers while
     `screenActive`. On the desktop path nothing consumes it, so with that
     handler disarmed Esc would simply be dead — leaving a fullscreen window
     whose only exit is one small icon in a corner. Restore the gesture people
     already expect. */
  useEffect(() => {
    if (!screenActive || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !windowScreen.current) return;
      e.preventDefault();
      e.stopPropagation();
      void exitScreen().then(() => setMode(null));
    };
    // Capture: the dialog's own layers see the key first otherwise.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [screenActive, exitScreen, setMode]);

  /* Leaving the popup must not leave the browser in fullscreen or the mode in
     the URL — reopening the popup would otherwise inherit a maximize the user
     never asked for on it. */
  const reset = useCallback(() => {
    void exitScreen();
    void setMode(null);
  }, [exitScreen, setMode]);

  /* Read at render, exactly as the caller used to read the ref itself: the ref
     never changes without `setScreenActive` running beside it, so every flip
     of this value arrives with a render of its own. */
  const screenMechanism = screenActive ? (windowScreen.current ? 'desktop-window' : 'document') : null;

  return {
    mode,
    maximized,
    screenActive,
    screenMechanism,
    popupRef,
    toggleWindow,
    toggleScreen,
    exitScreen,
    reset,
  };
}
