'use client';

import { useEffect } from 'react';
import { OPEN_CHAT_EVENT, type OpenChatEventDetail } from '@papercusp/papercusp-shared';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import {
  focusPanel,
  listPanels,
  onDockApiBind,
  openPanel,
  setPanelParams,
  setPanelTitle,
} from '../../harness/dock/dock-actions';
import { OPEN_DOCK_PANEL_EVENT, drainPanelOpens } from './open-dock-panel';
import WorkItemsPanel from './WorkItemsPanel';
import DepGraphPanel from './DepGraphPanel';
import DetailPanel from './DetailPanel';
import AdvChatPanel from './AdvChatPanel';
import AdvAgentsPanel from './AdvAgentsPanel';
import MemberWorkPanel from './MemberWorkPanel';
import PotContentPanel from './PotContentPanel';
import AdvLogsPanel from './AdvLogsPanel';
import AdvInsightsPanel from './AdvInsightsPanel';
import AdvContributorsPanel from './AdvContributorsPanel';
import AdvSyncHealthPanel from './AdvSyncHealthPanel';

const CHAT_PANEL_TYPE = 'adv:chat';

/**
 * Open a worker chat into the dock, preferring (a) the panel already
 * showing this chat, then (b) the first FREE chat slot (an `adv:chat`
 * panel with no chatId), then (c) a brand-new chat panel. This gives the
 * "open in the first not-used chat panel" + multi-instance behaviour.
 * Throws if the dock api isn't bound yet (callers guard on that).
 */
function openChatInDock(d: OpenChatEventDetail): void {
  const panels = listPanels();
  const already = panels.find(
    (p) => p.type === CHAT_PANEL_TYPE && p.params.chatId === d.chatId,
  );
  if (already) {
    focusPanel(already.id);
    return;
  }
  const title = d.title ?? (d.featureId ? `${d.role ?? 'worker'} · ${d.featureId}` : 'chat');
  const free = panels.find((p) => p.type === CHAT_PANEL_TYPE && !p.params.chatId);
  if (free) {
    // updateParameters replaces — pass mode explicitly so reusing a slot
    // that previously held a discuss chat doesn't carry a stale mode.
    setPanelParams(free.id, { harnessSlug: d.slug, chatId: d.chatId, title, mode: d.mode });
    setPanelTitle(free.id, title);
    focusPanel(free.id);
    return;
  }
  const id = openPanel({
    type: CHAT_PANEL_TYPE,
    title,
    params: { harnessSlug: d.slug, chatId: d.chatId, mode: d.mode },
  });
  focusPanel(id);
}

let registered = false;
function ensureRegistered() {
  if (registered) return;
  panelRegistry.register('adv:detail', DetailPanel, { title: 'Detail' });
  panelRegistry.register('adv:pinned', DetailPanel, { title: 'Pinned' });
  // Git is no longer a Harness-page panel — it has its own /adv Git dock
  // (AdvGitDock registers adv:git-graph + adv:prs).
  panelRegistry.register('adv:agents', AdvAgentsPanel, { title: 'Agents' });
  // adv:member-work — "what is each member working on" grouped by hive member
  // (shared-hive-collaboration-2026-06-14 P-010, Brief B10). Additive: openable
  // from the panel menu, not forced into the default layout (mirrors insights/
  // contributors). The per-agent sibling is adv:agents.
  panelRegistry.register('adv:member-work', MemberWorkPanel, { title: 'Members' });
  // adv:hive-content — cross-member browse rollup (WI-259 P-006). Registered
  // always (cheap + inert without a hive); its CATALOG availability is flag-gated
  // (FLAGS.THE_HIVE) in HarnessTopBar's allowedTypes.
  panelRegistry.register('adv:hive-content', PotContentPanel, { title: 'Shared content' });
  panelRegistry.register('adv:logs', AdvLogsPanel, { title: 'Run log' });
  // Phase-8 Insights (P-073) — built + tested but previously had no in-shell
  // mount; register it so it's openable from the panel menu (additive — not
  // forced into the default layout).
  panelRegistry.register('adv:insights', AdvInsightsPanel, { title: 'Insights' });
  // Phase-8 Contributors tab (P-048) — openable from the panel menu (additive).
  panelRegistry.register('adv:contributors', AdvContributorsPanel, { title: 'Contributors' });
  // P-010 (blueprint-aware-harness-ui-2026-06-09): the unified work_items view — one
  // table across both families (feature + issue), surfacing kind/assignee/claim/
  // severity/priority/rank + the plan-link/spine-position joins. This REPLACED the
  // legacy adv:features/adv:issues panels (retired 2026-06-10; row-click drives the
  // same `?sel` the Detail pane reads).
  panelRegistry.register('adv:work-items', WorkItemsPanel, { title: 'Work items' });
  // adv:dep-graph (dependency-health-pane-2026-08-02) — the work-items corpus in GRAPH form,
  // seeded BESIDE the grid in the default layout per D-002/D-006. It shares the grid's
  // `workItems.byHarness` subscription for nodes and its `?sel` selection param, so the two
  // panes are two views of one dataset rather than two datasets.
  panelRegistry.register('adv:dep-graph', DepGraphPanel, { title: 'Dependency graph' });
  // adv:sync-health — the sync layer's own numbers (P-003(b) of
  // no-http-anywhere-2026-07-28): live concurrency-gate depth, queue-wait vs
  // request time, per-query bytes/ms, and desktop IPC bridge health. Additive and
  // openable from the panel menu, like insights/contributors. NOT keepAlive: it
  // polls a 1s display timer, and the metrics are process-wide, so a hidden copy
  // would sample for nothing — reopening it re-reads the same singleton.
  panelRegistry.register('adv:sync-health', AdvSyncHealthPanel, { title: 'Sync health' });
  // keepAlive: the chat keeps its SSE stream + transcript when its tab is
  // inactive. Multi-instance: several chat slots can coexist (the open-chat
  // drain fills the first free one).
  panelRegistry.register(CHAT_PANEL_TYPE, AdvChatPanel, { title: 'Chat', keepAlive: true });
  registered = true;
}

/**
 * Mounts the dockview shell for /adv/harnesses with a layout name
 * keyed by harness slug. The seed (`defaultAdvHarnessesLayout` in
 * operator-core lib/dock-layouts.ts) is Work items | Dependency graph
 * side by side, over a persistent full-width Detail pane.
 *
 * Layout-name history — each bump ABANDONS persisted rows on purpose:
 *   adv-harnesses  → adv-harnesses2  Features/Issues panels retired, so old rows
 *                                    would hydrate now-unregistered panel types.
 *   adv-harnesses2 → adv-harnesses3  the dependency-graph pane joined the DEFAULT
 *                                    layout (dependency-health-pane-2026-08-02 D-002).
 *
 * That second bump is not cosmetic and was a deliberate trade. A PERSISTED layout row
 * WINS over the seed, so editing the seed alone would have shipped the new pane to new
 * installs only — every existing user would have kept their saved two-pane layout and
 * never seen it, while the plan's requirement was explicitly "one of the panes in the
 * default view". Bumping delivers it to everyone at the cost of resetting a customised
 * Work-tab arrangement once.
 *
 * When the user switches slug, `listPanels()` is walked and each
 * panel's `harnessSlug` param is rebound — same trick `HarnessDockShell`
 * uses for the legacy dock.
 */
export default function HarnessesDock({ slug }: { slug: string }) {
  useEffect(() => {
    ensureRegistered();
  }, []);

  const layoutName = slug ? `adv-harnesses3:${slug}` : 'adv-harnesses3';

  useEffect(() => {
    if (!slug) return;
    let addPanelDispose: { dispose: () => void } | null = null;
    const unbind = onDockApiBind((api) => {
      if (addPanelDispose) {
        addPanelDispose.dispose();
        addPanelDispose = null;
      }
      if (!api) return;
      const patch = (p: { id: string; params: Record<string, unknown> }) => {
        if (p.params.harnessSlug !== slug) {
          setPanelParams(p.id, { ...p.params, harnessSlug: slug });
        }
      };
      try {
        for (const p of listPanels()) patch(p);
      } catch {
        /* dock not yet hydrated; onDidAddPanel covers it */
      }
      addPanelDispose = api.onDidAddPanel((panel) => {
        try {
          const found = listPanels().find((x) => x.id === panel.id);
          if (found) patch(found);
        } catch {
          /* ignore */
        }
      });
    });
    return () => {
      if (addPanelDispose) addPanelDispose.dispose();
      unbind();
    };
  }, [slug]);

  // Open-chat handling: `openFeatureChat` (feature row / detail buttons)
  // creates the chat row, pushes a detail onto the window queue, and fires
  // OPEN_CHAT_EVENT. We drain the queue into a chat panel — on the dock api
  // binding (chats opened before the dock mounted) and on each event (chats
  // opened while mounted). Adapts /pi's PiTerminalsDock drain into this dock.
  useEffect(() => {
    if (!slug) return;
    const drain = () => {
      const w = window as Window & {
        __PAPERCUSP_PENDING_CHAT_OPENS__?: OpenChatEventDetail[];
      };
      const queue = w.__PAPERCUSP_PENDING_CHAT_OPENS__;
      if (!queue || queue.length === 0) return;
      for (let i = queue.length - 1; i >= 0; i--) {
        const d = queue[i];
        if (d.slug !== slug || !d.chatId) continue;
        try {
          openChatInDock(d);
        } catch {
          // Dock api not bound yet — leave it queued; the bind handler retries.
          continue;
        }
        queue.splice(i, 1);
      }
    };
    let bound = false;
    const unbind = onDockApiBind((api) => {
      bound = !!api;
      if (api) drain();
    });
    const handler = () => {
      if (bound) drain();
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => {
      window.removeEventListener(OPEN_CHAT_EVENT, handler);
      unbind();
    };
  }, [slug]);

  // Panel-open handling (owner ask 2026-07-19): the Overview tiles' `open`
  // can request a specific dock panel (e.g. adv:agents) that may be absent
  // from the user's persisted layout — ensure it exists + focus it. Same
  // queue/drain shape as open-chat above; drainPanelOpens lives in
  // open-dock-panel.ts (exported for tests).
  useEffect(() => {
    if (!slug) return;
    const drain = () =>
      drainPanelOpens({ slug, listPanels, openPanel, focusPanel });
    let bound = false;
    const unbind = onDockApiBind((api) => {
      bound = !!api;
      if (api) drain();
    });
    const handler = () => {
      if (bound) drain();
    };
    window.addEventListener(OPEN_DOCK_PANEL_EVENT, handler);
    return () => {
      window.removeEventListener(OPEN_DOCK_PANEL_EVENT, handler);
      unbind();
    };
  }, [slug]);

  // Absolute fill instead of height:100%. DockviewReact's root (.dv-shell)
  // sizes from its container; a height:100% chain collapses to 0 in
  // WebKitGTK (the Tauri webview) when an ancestor's height comes from
  // `flex: 1` rather than an explicit value — Chromium resolves it, WebKit
  // doesn't. position:absolute + inset:0 against the relative dock wrapper
  // gives a definite pixel box that both engines honour.
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HarnessDock layoutName={layoutName} />
    </div>
  );
}
