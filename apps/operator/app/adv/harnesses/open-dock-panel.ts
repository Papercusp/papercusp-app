'use client';

/**
 * Cross-tab "open a dock panel" request (owner ask 2026-07-19: the Overview
 * Agents tile's `open` must land on the Working tab WITH the agents panel
 * visible — if the user's persisted dock layout doesn't include the panel,
 * a bare tab switch shows nothing).
 *
 * Same window-queue + event + drain-on-bind shape as openFeatureChat's
 * OPEN_CHAT_EVENT (the dock may not be MOUNTED yet when the request fires —
 * the queue survives the Overview → Working mount gap; HarnessesDock drains
 * it when the dock api binds, and on each event while mounted).
 */

export const OPEN_DOCK_PANEL_EVENT = 'papercusp:adv-open-dock-panel';

export interface OpenDockPanelDetail {
  /** Registered panel type, e.g. 'adv:agents'. */
  type: string;
  /** Panel title when a new panel must be created (defaults to registry title). */
  title?: string;
}

type PanelQueueWindow = Window & { __PAPERCUSP_PENDING_PANEL_OPENS__?: OpenDockPanelDetail[] };

/** Queue a panel-open request and nudge any mounted dock to drain it. */
export function requestDockPanelOpen(type: string, title?: string): void {
  if (typeof window === 'undefined') return;
  const w = window as PanelQueueWindow;
  const queue = (w.__PAPERCUSP_PENDING_PANEL_OPENS__ ??= []);
  // Dedupe: a repeat click before the dock mounts must not stack N copies.
  if (!queue.some((d) => d.type === type)) queue.push({ type, title });
  window.dispatchEvent(new CustomEvent(OPEN_DOCK_PANEL_EVENT));
}

/**
 * Drain the pending queue against a dock: focus an existing panel of the
 * requested type, else open one (params carry the active harness slug like
 * every other panel). Entries whose open throws (dock api not bound yet)
 * stay queued — the bind handler retries. Exported pure-ish for tests.
 */
export function drainPanelOpens(deps: {
  slug: string;
  listPanels: () => Array<{ id: string; type: string; params: Record<string, unknown> }>;
  openPanel: (o: { type: string; title?: string; params: Record<string, unknown> }) => string;
  focusPanel: (id: string) => void;
}): void {
  if (typeof window === 'undefined') return;
  const w = window as PanelQueueWindow;
  const queue = w.__PAPERCUSP_PENDING_PANEL_OPENS__;
  if (!queue || queue.length === 0) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    const d = queue[i];
    try {
      const existing = deps.listPanels().find((p) => p.type === d.type);
      if (existing) {
        deps.focusPanel(existing.id);
      } else {
        const id = deps.openPanel({ type: d.type, title: d.title, params: { harnessSlug: deps.slug } });
        deps.focusPanel(id);
      }
    } catch {
      // Dock api not bound yet — leave it queued; the bind handler retries.
      continue;
    }
    queue.splice(i, 1);
  }
}
