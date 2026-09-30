import { useEffect } from 'react';
import { toast } from 'sonner';
import { useSyncStaleOperator } from '@papercusp/sync';

/**
 * Surfaces a version-skewed operator as a persistent toast (WI-5956).
 *
 * The desktop dev operator (:3270) is a LONG-LIVED process serving a
 * SPA `dist` that a `vite build` watcher rebuilds continuously from the same
 * tree. The two halves drift the moment any agent adds a new sync resolver:
 * the freshly-rebuilt client calls a query the still-running server has never
 * heard of, `GET /rest-query` answers `400 unknown queryName: <name>`, and —
 * before this component — that failure surfaced as nothing more than one
 * silently-broken panel. There was no signal to the human that the FIX is
 * "restart your operator", and no signal to the agent who added the resolver
 * that they just broke every desktop shell on the box.
 *
 * Unlike OfflineIndicator this needs no grace/hold debounce: a real
 * connectivity blip can recover on its own retry, but a version mismatch
 * between a running process and its own rebuilt dist does not self-heal —
 * the toast should appear on the FIRST occurrence and stay up (an operator
 * restart is what clears it, which reloads the whole page, tearing this
 * component down with it — so there is no in-app "dismiss" to wire).
 */
const TOAST_ID = 'sync-stale-operator-indicator';

export default function StaleOperatorIndicator() {
  const { stale, queryNames } = useSyncStaleOperator();

  useEffect(() => {
    if (!stale) return;
    toast.error('Your desktop operator is out of date', {
      id: TOAST_ID,
      description:
        queryNames.length === 1
          ? `A recent code change added "${queryNames[0]}", which this running operator doesn't know about yet. Restart the app to pick it up.`
          : `Recent code changes added ${queryNames.length} queries this running operator doesn't know about yet. Restart the app to pick them up.`,
      duration: Infinity,
    });
  }, [stale, queryNames]);

  return null;
}
