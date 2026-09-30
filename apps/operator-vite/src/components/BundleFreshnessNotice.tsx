import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';
import { shouldOfferReload } from '@/lib/spa-build-identity';

/**
 * Proactively surfaces "this window is running a stale bundle" (EI-15848).
 *
 * THE FAILURE (observed 2026-07-18, owner-graded 5/5): the owner's open Tauri
 * window kept serving a bundle built hours earlier, so the owner reported
 * symptoms — a 1,928-row unvirtualized inbox, a conversation-popup 500 — that
 * were ALREADY FIXED on disk. Nothing was broken except that neither the window
 * nor the person looking at it had any way to know it was stale. Each instance
 * costs a full diagnostic round-trip against code that no longer exists.
 *
 * WHY ChunkReloadPrompt DOES NOT ALREADY COVER THIS, though its toast says the
 * same words. That one is REACTIVE: it listens for `vite:preloadError`, so it
 * can only speak when the stale page happens to request a code-split chunk that
 * has since 404'd. A page whose chunks are all already loaded — or one under
 * `vite build --watch`, which RETAINS old chunks (EI-18694489428714850, cited in
 * its own source) — never fires that event and runs stale indefinitely, in
 * silence. That is precisely the observed case. This component asks the
 * question directly instead of waiting for a symptom, so the two are
 * complementary: same recovery, different evidence.
 *
 * WHY A PROMPT AND NOT AN AUTO-RELOAD. The desktop host overrides
 * `location.reload()` to a no-op on purpose, so `vite build --watch` cannot yank
 * a session mid-task; `DevReloadGate` does the same for the dev shell. Those
 * decisions are correct and this does not relitigate them — the missing piece
 * was never the reload, it was the SIGNAL that one is now worth doing. The user
 * keeps the trigger and gets told when to pull it, so an unsaved draft is never
 * destroyed by a peer's unrelated build. The button therefore calls
 * `hardReload()`, NOT `location.reload()`: on the desktop host the latter is
 * silently a no-op, which would ship a button that does nothing.
 *
 * WHY IT CANNOT NAG. `shouldOfferReload` is false unless BOTH ids are known and
 * differ, closing every way this could become noise: the Vite dev server
 * injects no id (so `loaded` is null and this is inert — HMR already owns that
 * surface), a bundle missing mid-rebuild reports a null served id rather than a
 * mismatch, and a failed poll changes nothing. A notice that cried wolf on
 * every rebuild would be muted within a day, and then silent for the one case
 * it exists for.
 */

/** How often to re-check. Deliberately unhurried: staleness is measured in the
 *  minutes-to-hours an owner leaves a window open, never in seconds. */
const POLL_MS = 60_000;

/** Stable id → sonner dedupes, so repeated checks never stack toasts. Distinct
 *  from ChunkReloadPrompt's: the two are triggered by different evidence and
 *  their packaged-app copy differs, so neither should overwrite the other's
 *  message while both conditions hold. */
const TOAST_ID = 'bundle-freshness-notice';

function loadedBuildId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = (window as { __PAPERCUSP_BUILD_ID__?: unknown }).__PAPERCUSP_BUILD_ID__;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export default function BundleFreshnessNotice() {
  /**
   * The build we have already prompted about, compared by VALUE rather than a
   * boolean. A `shown` flag would mean one dismissal silences the feature for
   * the rest of the session — the same muted end-state as nagging, reached
   * politely. Keyed by id, a LATER build prompts again.
   */
  const promptedFor = useRef<string | null>(null);

  useEffect(() => {
    const loaded = loadedBuildId();
    // No injected id ⇒ this surface cannot answer the question (Vite dev, or a
    // shell predating this feature). Never poll for an answer we would discard.
    if (!loaded) return;

    let cancelled = false;
    const check = async () => {
      let served: string | null = null;
      try {
        const res = await fetch('/__spa/build-id', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { buildId?: unknown };
        served = typeof body.buildId === 'string' ? body.buildId : null;
      } catch {
        // Operator restarting, offline, mid-deploy. Fail-soft by contract: an
        // error is not evidence of a new build.
        return;
      }
      if (cancelled) return;
      if (!shouldOfferReload(loaded, served)) return;
      if (promptedFor.current === served) return;
      promptedFor.current = served;
      toast('A newer build of the operator UI is available', {
        id: TOAST_ID,
        description:
          'This window is still running an older build, so it may not reflect recent fixes. Reload to pick up the latest.',
        duration: Infinity,
        action: { label: 'Reload', onClick: () => hardReload() },
      });
    };

    void check();
    // timer-classification: must-sample — samples /api/health for the SERVED bundle sha.
    // No store pushes "a newer build is deployed" into the webview (the sync layer carries
    // data queries, not the host's build identity), so the only signal source is a fetch.
    const timer = setInterval(() => void check(), POLL_MS);
    // Re-check when the window regains attention — by far the highest-value
    // trigger, because an owner returning to a long-idle window is exactly the
    // moment a stale bundle gets mistaken for current behaviour.
    const onFocus = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return null;
}
