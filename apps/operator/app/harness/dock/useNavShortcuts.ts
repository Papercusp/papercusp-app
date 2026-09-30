/**
 * useNavShortcuts — global Cmd+[ / Cmd+] (Ctrl+[ / Ctrl+] on linux/win)
 * dispatching to back/forward navigation.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §6.2, §16.5
 *
 * Precedence (option b of §16.5):
 *   1. Focused panel's per-panel useNavHistory if it opts in
 *      (DocsPanel, future Pin panels, plugin React panels)
 *   2. Falls through to dock-level useTabVisitHistory — back/forward
 *      across the panels the user has focused
 *
 * Ignored when focus is in an input/textarea/contenteditable.
 */

'use client';

import { useEffect } from 'react';
import { onDockApiBind } from './dock-actions';
import { getNavForPanel } from './NavChevrons';
import { getTabVisitHistorySync } from './useTabVisitHistory';

export function useNavShortcuts(): void {
  useEffect(() => {
    let activePanelId: string | null = null;
    let disposable: { dispose: () => void } | null = null;

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key !== '[' && e.key !== ']') return;
      // Don't hijack from input fields.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }
      // 1) Per-panel nav first.
      if (activePanelId) {
        const panelNav = getNavForPanel(activePanelId);
        if (panelNav) {
          if (e.key === '[' && panelNav.canBack) {
            e.preventDefault();
            panelNav.back();
            return;
          }
          if (e.key === ']' && panelNav.canForward) {
            e.preventDefault();
            panelNav.forward();
            return;
          }
        }
      }
      // 2) Fall through to dock-level tab-visit history.
      const dockNav = getTabVisitHistorySync();
      if (e.key === '[' && dockNav.canBack) {
        e.preventDefault();
        dockNav.back();
      } else if (e.key === ']' && dockNav.canForward) {
        e.preventDefault();
        dockNav.forward();
      }
    };

    const unbindApi = onDockApiBind((api) => {
      if (disposable) {
        disposable.dispose();
        disposable = null;
      }
      if (!api) {
        activePanelId = null;
        return;
      }
      activePanelId = api.activeGroup?.activePanel?.id ?? null;
      disposable = api.onDidActivePanelChange(() => {
        activePanelId = api.activeGroup?.activePanel?.id ?? null;
      });
    });

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (disposable) disposable.dispose();
      unbindApi();
    };
  }, []);
}
