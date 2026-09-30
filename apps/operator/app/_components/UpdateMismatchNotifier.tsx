'use client';

/**
 * UpdateMismatchNotifier — surfaces the P-013 post-update self-check
 * (desktop-build-hardening-tri-platform-2026-07-11). The Tauri host (main.rs,
 * `run_update_self_check`) compares the running operator's `/api/health` sha
 * against THIS build's OWN baked sha; on a mismatch — the EI-9002 silent no-op
 * update, where a stale operator survived and was adopted instead of replaced —
 * it fires a `papercusp:update-mismatch` window event (+ the
 * `window.__papercuspUpdateMismatch` global). This turns that invariant into
 * something the USER sees: a persistent error toast telling them to restart,
 * instead of silently running against a stale operator.
 *
 * Mounted once at the app root (RootSyncProvider). Uses a stable toast id so the
 * host's re-eval loop (it re-injects for ~10s to beat the bootstrap→SPA handoff)
 * collapses to a single toast rather than twenty.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';

const TOAST_ID = 'papercusp-update-mismatch';

interface UpdateMismatchDetail {
  expected?: string;
  running?: string;
}

function surface(detail: UpdateMismatchDetail | undefined) {
  const expected = detail?.expected || 'this build';
  const running = detail?.running || 'an older build';
  toast.error('Update did not fully apply', {
    id: TOAST_ID,
    duration: Infinity,
    description:
      `The app updated to ${expected}, but it's still talking to an operator running ${running}. ` +
      `Quit and reopen Papercusp (or restart Papercusp Server) to finish the update.`,
  });
}

export default function UpdateMismatchNotifier() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // The host re-injects the event for ~10s; also read the global once in case
    // it landed before this listener attached.
    const existing = (
      window as unknown as { __papercuspUpdateMismatch?: UpdateMismatchDetail }
    ).__papercuspUpdateMismatch;
    if (existing) surface(existing);

    const onMismatch = (e: Event) =>
      surface((e as CustomEvent<UpdateMismatchDetail>).detail);
    window.addEventListener('papercusp:update-mismatch', onMismatch as EventListener);
    return () =>
      window.removeEventListener('papercusp:update-mismatch', onMismatch as EventListener);
  }, []);

  return null;
}
