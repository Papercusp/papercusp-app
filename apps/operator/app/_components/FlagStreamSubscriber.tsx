'use client';

/**
 * FlagStreamSubscriber — wires live flag flips onto the sync bus once at the
 * app root, so every `useFlag` consumer (now reactive via useSyncExternalStore
 * — fix A, `libs/flags/src/client.ts`) re-renders the instant a flag flips,
 * with no reload and no private EventSource.
 *
 * The server mirrors `publishFlagChange()` onto `FLAGS_CHANGED_EVENT` after
 * the flag write. This listener turns that push into the same bootstrap
 * refetch as the legacy dedicated flags stream, while leaving the generic
 * `subscribeToFlagStream()` API available to non-operator clients.
 *
 * Mounted once at the router root, next to the other Global- and Desktop-
 * prefixed bridge components (DesktopAttentionNotifier, DesktopConsoleLaunchBridge).
 * Renders nothing; it rides the sync transport's already-open EventSource.
 */
import { useEffect } from 'react';
import { FLAGS_CHANGED_EVENT } from '@papercusp/flags';
import { loadFlags } from '@papercusp/flags/client';
import { onSyncBusEvent } from '@papercusp/sync';

export default function FlagStreamSubscriber() {
  useEffect(() => {
    return onSyncBusEvent((ev) => {
      if (ev.name !== FLAGS_CHANGED_EVENT) return;
      void loadFlags().catch(() => {
        // Keep the last known payload; the next flip or route bootstrap retries.
      });
    });
  }, []);
  return null;
}
