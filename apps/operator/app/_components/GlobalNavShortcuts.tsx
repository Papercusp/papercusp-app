'use client';

/**
 * Browser-style back/forward navigation for the desktop shell.
 *
 * The Tauri webview does NOT bind Alt+Left / Alt+Right to history
 * navigation the way a normal browser does — in the desktop app those
 * keys are dead by default. This component registers them against the
 * global shortcut bus (see `lib/shortcut-bus.ts`), so the binding works
 * on EVERY route: the dispatcher is a single window-level listener
 * mounted once at the app shell, and this component lives at the root
 * (`app/layout.tsx`), so it's never unmounted by route changes.
 *
 * Implementation: the Next.js App Router pushes real entries onto
 * `window.history`, so `history.back()` / `history.forward()` traverse
 * the in-app route stack exactly like the browser chrome's buttons.
 * We use the raw History API rather than `router.back()` so a forward
 * entry is honoured too (Next's `useRouter` exposes `.forward()` only in
 * newer versions, and the History API is unambiguous on both).
 *
 * Renders nothing.
 */
import { useShortcutAction } from '../../lib/hotkeys';

export default function GlobalNavShortcuts() {
  // enableOnFormTags so Alt+Arrow still navigates while focus is in an
  // input — matches native browser behaviour (Alt+Arrow is never a
  // text-editing key, so there's nothing to shadow).
  const opts = { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] as const };

  useShortcutAction('navigation.back', () => {
    window.history.back();
  }, opts);

  useShortcutAction('navigation.forward', () => {
    window.history.forward();
  }, opts);

  return null;
}
