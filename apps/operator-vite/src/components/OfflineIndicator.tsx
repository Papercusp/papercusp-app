import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useSyncConnectivity } from '@papercusp/sync';

/**
 * Surfaces operator connectivity loss as a persistent toast (EI-239) — but
 * only for a SUSTAINED outage, never a brief reconnect blip (EI-3033).
 *
 * Without this, an operator death left the SPA looking healthy-but-empty —
 * panels render zero-counts indistinguishable from a real empty state and
 * every action fails silently. The sync transports already detect sustained
 * network-level failure (`@papercusp/sync`'s connectivity store, fed by the
 * SSE reconnect loop and the REST batch fetcher); this component renders
 * that state. Same idiom as ChunkReloadPrompt: a stable-id sonner toast,
 * auto-dismissed once a transport proves the origin STABLY reachable again —
 * held briefly so a flapping operator shows ONE steady toast, not a strobe
 * (WI-3307, OFFLINE_TOAST_RECOVERY_HOLD_MS). The SPA soft-recovers on its own —
 * reload is NOT offered, a full document load against a dead origin strands the
 * webview.
 *
 * EI-3033: under heavy fleet load the desktop's SSE/IPC stream drops and
 * re-dials frequently (CPU-starved operator, webview IPC re-dials), flipping
 * `offline` true for a second or two before the next attempt reconnects.
 * Firing the alarming "actions will not save" toast on every such blip is
 * noise that recovers on its own. So we DEBOUNCE the toast on the time axis:
 * it only appears once the outage has persisted past OFFLINE_TOAST_GRACE_MS.
 * A drop that recovers within the grace window never interrupts the user; a
 * genuine sustained outage still surfaces promptly. Recovery cancels a pending
 * alarm outright, but a toast already SHOWN is held until the origin has been
 * stably reachable for OFFLINE_TOAST_RECOVERY_HOLD_MS — so a flapping operator
 * (repeated >grace stalls split by a single successful reply) shows one steady
 * toast, not a strobe. The connectivity store's `offline` boolean stays pure
 * truth — both debounces are view-layer presentation decisions, not a change
 * to what "offline" means.
 */
const TOAST_ID = 'sync-offline-indicator';

/**
 * How long the connection must stay continuously down before we alarm the
 * user. Long enough to ride out a reconnect / IPC re-dial under load
 * (EI-3033), short enough that a genuine outage surfaces promptly.
 *
 * Raised 5s → 8s (WI-1957): under heavy fleet load the operator's main thread
 * stalls for up to ~5.7s (observed event-loop-lag maxMs), which tripped the old
 * 5s grace and fired the alarming toast for a stall the app rode out on its own.
 * 8s clears the observed stall ceiling while still surfacing a genuine outage
 * (a deploy restart / operator death lasts well beyond 8s) promptly. The real
 * fix for the stalls themselves is tracked separately; this keeps the *toast*
 * honest in the meantime.
 */
export const OFFLINE_TOAST_GRACE_MS = 8000;

/**
 * Once the toast is SHOWING, how long the connection must stay CONTINUOUSLY
 * reachable before we dismiss it (WI-3307). Without this hold, a *flapping*
 * operator makes the toast strobe: the connectivity store clears `offline` on
 * the FIRST reachable report, so a >8s stall → one successful request → next
 * >8s stall reads as show → dismiss → show, and the user experiences the popup
 * "coming back" over and over. That flap is the real-world shape of a
 * CPU/IO-starved operator (a co-located build, disk pressure, a deploy
 * restart's warm-up). Holding dismissal until the origin has been *stably*
 * reachable collapses a flapping stretch into ONE steady toast that still
 * clears promptly once the connection is genuinely back. Same time-axis
 * debounce philosophy as OFFLINE_TOAST_GRACE_MS (EI-3033/WI-1957), applied to
 * the recovery edge. Kept shorter than the grace: a single successful reply is
 * NOT proof of recovery, but a few seconds of continuous reachability is.
 */
export const OFFLINE_TOAST_RECOVERY_HOLD_MS = 5000;

export default function OfflineIndicator() {
  const { offline } = useSyncConnectivity();
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the alarm toast is currently on screen. Gates the recovery-hold
  // (only a shown toast needs holding) and prevents re-arming the grace timer
  // for a flap while the toast is already up.
  const shown = useRef(false);

  useEffect(() => {
    const clearGrace = () => {
      if (graceTimer.current !== null) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };
    const clearRecovery = () => {
      if (recoveryTimer.current !== null) {
        clearTimeout(recoveryTimer.current);
        recoveryTimer.current = null;
      }
    };

    if (offline) {
      // Back offline — cancel any pending dismissal so a flap keeps the ONE
      // toast rather than tearing it down and re-alarming.
      clearRecovery();
      // Debounce: only alarm once the outage outlasts a brief reconnect blip,
      // and never stack a second grace timer while the toast is already up.
      if (!shown.current && graceTimer.current === null) {
        graceTimer.current = setTimeout(() => {
          graceTimer.current = null;
          shown.current = true;
          toast.error('Operator connection lost', {
            id: TOAST_ID,
            description:
              'Live data is paused and actions will not save. Reconnecting automatically — the app resumes by itself once the operator is back.',
            duration: Infinity,
          });
        }, OFFLINE_TOAST_GRACE_MS);
      }
    } else {
      // Reachable again. A pending first-alarm (toast not yet shown) is a brief
      // blip — cancel it outright.
      clearGrace();
      if (shown.current) {
        // Our toast is up: dismiss only after the connection stays reachable
        // for the hold window, so a flapping operator shows one steady toast.
        if (recoveryTimer.current === null) {
          recoveryTimer.current = setTimeout(() => {
            recoveryTimer.current = null;
            shown.current = false;
            toast.dismiss(TOAST_ID);
          }, OFFLINE_TOAST_RECOVERY_HOLD_MS);
        }
      } else {
        // Never showed (brief blip) or a fresh online mount — defensively clear
        // any stale toast a prior mount may have left up (duration:Infinity
        // survives unmount). A no-op when nothing is showing.
        toast.dismiss(TOAST_ID);
      }
    }

    // Cleanup runs only on an `offline` flip (or unmount): re-arm/cancel is
    // re-decided by the next run, so clearing both pending timers here is
    // correct — a timer that must survive an unchanged stretch is never torn
    // down because the effect does not re-run without a flip.
    return () => {
      clearGrace();
      clearRecovery();
    };
  }, [offline]);

  return null;
}
