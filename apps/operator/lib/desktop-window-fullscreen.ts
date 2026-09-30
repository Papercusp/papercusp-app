'use client';

/**
 * desktop-window-fullscreen — "fill the DISPLAY", for the Tauri desktop shell.
 *
 * WHY THIS EXISTS
 * ---------------
 * [owner 2026-08-02] "both fullscreen buttons do the same thing. one of them is
 * supposed to full screen on the full desktop display not just the window."
 *
 * The chat popup's full-screen control had exactly one mechanism — the DOM
 * Fullscreen API on the conversation element — and every way that call can fail
 * lands on `chatMax='window'`, i.e. the OTHER button's behavior. A control that
 * degrades into its neighbour is indistinguishable from a duplicate.
 *
 * ⚠ MEASURED, because the obvious explanation is WRONG and cost a wrong comment
 * here before it was checked (2026-08-02, papercusp-desktop debug build,
 * WebKitGTK on X11, driven under Xvfb+openbox):
 *   - `requestFullscreen()` on the conversation region, from a GENUINE click on
 *     the real button inside the Radix dialog, DOES escape the webview: the OS
 *     window went 1280x800 -> 1920x1080 and `document.fullscreenElement` became
 *     that region. So "the webview swallows it" is NOT true on this platform.
 *   - The same call WITHOUT transient activation rejects outright —
 *     "Cannot request fullscreen without transient activation" — and the old
 *     handler's `.catch` turned that into full-WINDOW.
 *
 * So the DOM path is not broken; it is CONDITIONAL, on something the caller
 * cannot inspect or guarantee. Driving the window instead is what makes the
 * control deterministic:
 *   1. no user-gesture requirement — a deep link (`?chatMax=screen`), a restored
 *      URL, or an agent driving the UI through `ui:dispatch` reaches the display
 *      too, where the DOM path silently gives them the smaller mode instead;
 *   2. no reliance on the embedder honoring a web request — WKWebView and
 *      WebView2 are not WebKitGTK, and this is the shipping desktop app;
 *   3. it cannot degrade into the neighbouring mode: `setFullscreen` either
 *      moves the window (we can READ that back and confirm) or it does not.
 *
 * `getCurrentWindow().setFullscreen` puts the OS window on the whole display and
 * the caller's own maximized layout fills it — verified live at 1920x1080 for
 * both the window and the conversation region. See `SessionChatModal`'s
 * `toggleScreen`, which picks between the two mechanisms on `isDesktopShell()`.
 *
 * OWNERSHIP (why `owned` is in the return type)
 * ---------------------------------------------
 * The window is shared with the rest of the app and with the user, who may have
 * fullscreened it themselves before opening the surface that calls this. Taking
 * it out of fullscreen on the way back would then undo something we never did.
 * `enterDesktopWindowFullscreen()` reports whether it was the one that CHANGED
 * the window, so a caller can leave a pre-existing fullscreen alone.
 *
 * Everything here is soft-fail: a browser session, an older desktop binary
 * whose baked capabilities lack `core:window:allow-set-fullscreen`, or a
 * missing `@tauri-apps/api` all resolve to "did not take effect" rather than
 * throwing, so the caller can fall back to its window-sized mode instead of
 * presenting a dead control.
 */

/** Is this webview the Tauri desktop shell (rather than a browser tab)? */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** The slice of `@tauri-apps/api/window`'s Window we use. Declared structurally
 *  so this module never has to import the type (and so tests can stub it). */
interface DesktopWindowHandle {
  setFullscreen(fullscreen: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
}

async function currentWindow(): Promise<DesktopWindowHandle | null> {
  if (!isDesktopShell()) return null;
  try {
    const mod = (await import('@tauri-apps/api/window')) as unknown as {
      getCurrentWindow?: () => DesktopWindowHandle;
    };
    return mod.getCurrentWindow?.() ?? null;
  } catch {
    // Desktop shell without the JS API bundled — treat as "no window control".
    return null;
  }
}

export interface EnterFullscreenResult {
  /** Is the OS window fullscreen now? False ⇒ the caller should fall back. */
  active: boolean;
  /** Did WE put it there? Only then may the caller take it back out. */
  owned: boolean;
}

const INACTIVE: EnterFullscreenResult = { active: false, owned: false };

/**
 * Put the desktop window on the whole display.
 *
 * Resolves `{ active:false }` — never rejects — when there is no window to
 * drive (browser) or the call is refused (capability not baked into this
 * build). A refusal is a routine outcome here, not an error: the desktop
 * binary's ACL is compiled in, so a freshly-shipped frontend can legitimately
 * run against a shell that predates the permission.
 */
export async function enterDesktopWindowFullscreen(): Promise<EnterFullscreenResult> {
  const win = await currentWindow();
  if (!win) return INACTIVE;
  try {
    // Already fullscreen (the user's own F11, or a previous caller): adopt it
    // WITHOUT claiming ownership, so we don't un-fullscreen their window later.
    if (await win.isFullscreen()) return { active: true, owned: false };
    await win.setFullscreen(true);
    // Trust the window, not the call: a denied capability can still resolve.
    const active = await win.isFullscreen();
    return { active, owned: active };
  } catch {
    return INACTIVE;
  }
}

/**
 * Take the desktop window back out of fullscreen.
 *
 * Call ONLY when `enterDesktopWindowFullscreen()` reported `owned: true` — see
 * the ownership note in this file's header.
 */
export async function exitDesktopWindowFullscreen(): Promise<void> {
  const win = await currentWindow();
  if (!win) return;
  try {
    await win.setFullscreen(false);
  } catch {
    /* Nothing to report: the window is either already out, or not ours to move. */
  }
}

/** Is the desktop window fullscreen right now? False in a browser. */
export async function isDesktopWindowFullscreen(): Promise<boolean> {
  const win = await currentWindow();
  if (!win) return false;
  try {
    return await win.isFullscreen();
  } catch {
    return false;
  }
}
