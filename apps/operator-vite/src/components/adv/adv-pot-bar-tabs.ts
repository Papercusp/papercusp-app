import type { AdvTabId } from './AdvShell';

/**
 * WHICH /adv tabs carry the pot bar — the pure half of AdvPotBar, kept in its own
 * module so the route can ask the question without importing the component (and
 * so a test can pin the answer without mounting the selector, the four status
 * pills, and their sync queries).
 *
 * Owner ask 2026-07-27 #3: the single pot selector in the shell's header bar was
 * removed with that bar, so "the tabs that are pot scoped" each need their own.
 * These are the tabs whose CONTENT is filtered by `?slug=`, which is exactly the
 * set that must be able to change it:
 *
 *   hud        — the cluster's new home (ask #2a); its Work-items board is per-pot
 *                (useResolvedHarnessSlug), and the pot's own status widgets
 *                (AdvNowRunning · Discord) live here. The only entry rendered
 *                `withStatus`. NOTE `withStatus` no longer covers the two
 *                workspace-wide pills (pots running · agents running): those moved
 *                to AdvShell's tab strip on 2026-08-01, since neither is filtered
 *                by `?slug=` and gating them on one tab hid a workspace readout.
 *   overview   — the work-item tiles scope to `?slug=` when one is picked.
 *   plans      — the Create dock's plan list resolves a pot the same way.
 *   harnesses  — "Work" IS the per-pot work view.
 *   learning   — filters observations/ideas by the inherited pot (useAdvScope).
 *   brainstorm · insights · settings · docs · git · stats · testing · prs
 *              — AdvHarnessPanelPage: every one is a single-pot panel (one repo,
 *                one docs tree, one settings form).
 *
 * Deliberately absent: calendar, health, frames, evals, conversations. Those
 * aggregate the whole workspace, and a pot picker that changes nothing on screen
 * is precisely the confusion this change set out to remove.
 */
export const POT_BAR_TAB_IDS: ReadonlySet<AdvTabId> = new Set<AdvTabId>([
  'hud',
  'overview',
  'brainstorm',
  'plans',
  'harnesses',
  'learning',
  'insights',
  'settings',
  'docs',
  'history',
  'git',
  'stats',
  'testing',
  'prs',
]);

/** Whether a tab shows the bar, and whether it also shows the status pills. */
export function potBarModeForTab(tab: AdvTabId): { show: boolean; withStatus: boolean } {
  return { show: POT_BAR_TAB_IDS.has(tab), withStatus: tab === 'hud' };
}
