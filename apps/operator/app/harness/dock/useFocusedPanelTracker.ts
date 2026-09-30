/**
 * useFocusedPanelTracker — keeps `?focusSlug=` in sync with the active
 * panel's `params.harnessSlug` so:
 *   - agent context defaults to whichever harness you're looking at
 *   - voice "summarize this state" picks the right harness
 *   - new panel opens default to the current slug
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.4 + §9.3
 *
 * Mount once at the dock root (HarnessDock invokes this). Does nothing
 * if no focused panel; ignores panels without a harnessSlug param.
 */

'use client';

import { useEffect } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { onDockApiBind } from './dock-actions';

export function useFocusedPanelTracker(): void {
  const [, setFocusSlug] = useQueryState(
    'focusSlug',
    parseAsString.withDefault(''),
  );

  useEffect(() => {
    return onDockApiBind((api) => {
      if (!api) return;
      const refresh = () => {
        const active = api.activeGroup?.activePanel;
        if (!active) return;
        const params = active.params as { harnessSlug?: string } | undefined;
        const slug = params?.harnessSlug;
        if (typeof slug === 'string' && slug.length > 0) {
          // Use history: 'replace' so panel-focus changes don't spam the
          // browser's back stack. setFocusSlug returns a promise — best-effort.
          void setFocusSlug(slug, { history: 'replace' });
        }
      };
      refresh();
      api.onDidActivePanelChange(refresh);
    });
  }, [setFocusSlug]);
}
