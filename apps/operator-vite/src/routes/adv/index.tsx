import { Suspense } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import AdvShell, { ADV_TABS, portalEmbedAdvTab, useAdvScope, type AdvScope, type AdvTabId } from '../../components/adv/AdvShell';
import { isPortalEmbedLocation } from '@papercusp/operator-core/lib/portal-embed';
import AdvPotBar from '../../components/adv/AdvPotBar';
import { potBarModeForTab } from '../../components/adv/adv-pot-bar-tabs';
import AdvTabErrorBoundary from '../../components/adv/AdvTabErrorBoundary';

// Keep the landing route's startup graph lean: every tab body is a separate
// retryable chunk, so Overview does not pull the heavyweight workspaces,
// dashboards, or their noncritical styles into the first visit. The shell,
// selector, scope provider, and error boundary stay eager so navigation remains
// available while a tab chunk is loading (application-performance-implementation
// P-002).
const AdvOverviewTab = lazy(() => import('../../components/adv/AdvOverviewTab'));
const AdvStatsTab = lazy(() => import('../../components/adv/AdvStatsTab'));
const AdvConversationsTab = lazy(() => import('../../components/adv/AdvConversationsTab'));
const LearningTab = lazy(() => import('../../components/adv/LearningTab'));
const AdvFramesTab = lazy(() => import('../../components/adv/AdvFramesTab'));
const AdvEvalsTab = lazy(() => import('../../components/adv/AdvEvalsTab'));
const ScheduledCalendarTab = lazy(() => import('../../components/adv/ScheduledCalendarTab'));
const HealthTab = lazy(() => import('../../components/adv/HealthTab'));
const AdvHistoryTab = lazy(() => import('../../components/adv/AdvHistoryTab'));
const AdvHarnessPanelPage = lazy(() => import('../../components/adv/AdvHarnessPanelPage'));
const HarnessesWorkspace = lazy(() => import('@/app/adv/harnesses/HarnessesWorkspace'));
const AdvCreateDock = lazy(() => import('@/app/adv/create/AdvCreateDock'));
const HudView = lazy(() => import('@/app/adv/hud/HudView'));
const AdvWorkflowsTab = lazy(() => import('../../components/adv/AdvWorkflowsTab'));

const ADV_TAB_IDS = ADV_TABS.map((tab) => tab.id) as [AdvTabId, ...AdvTabId[]];

export const Route = createFileRoute('/adv/')({
  component: AdvIndexPage,
});

function AdvIndexPage() {
  const portalEmbed = typeof window !== 'undefined'
    && isPortalEmbedLocation(window.location.pathname, window.location.search);
  const [activeTab] = useQueryState(
    'tab',
    // Overview is the default landing surface (Brief 23 /
    // overview-dashboard-2026-06-05 D-001). Keep in sync with AdvShell.
    parseAsStringEnum<AdvTabId>(ADV_TAB_IDS).withDefault('overview'),
  );
  const renderedActiveTab = portalEmbedAdvTab(activeTab, portalEmbed);
  return (
    <AdvShell>
      <AdvScopedTabBody activeTab={renderedActiveTab} />
    </AdvShell>
  );
}

/**
 * This component MUST stay below AdvShell in the rendered tree. AdvShell owns
 * AdvScopeContext.Provider; reading useAdvScope in AdvIndexPage (before its
 * returned shell exists) can only see the context default, silently turning
 * every HUD query into All Pots regardless of the selector URL.
 */
function AdvScopedTabBody({ activeTab }: { activeTab: AdvTabId }) {
  // The pot cluster is a per-tab row now, not shell chrome (owner ask
  // 2026-07-27) — see AdvPotBar. `withStatus` (the running pills + start/stop) is
  // HUD only. It is rendered HERE rather than inside each tab component for two
  // reasons: HudBoard/AdvCreateDock/HarnessesWorkspace live under apps/operator/app,
  // which must not import up-layer from operator-vite/src (the same layering that
  // made QuickPanelHeaderControls a passed-in slot); and keeping it OUTSIDE the
  // error boundary means a crashed tab still leaves you a pot selector to switch
  // away with.
  const potBar = potBarModeForTab(activeTab);
  const potScope = useAdvScope();
  return (
    <>
      {potBar.show ? <AdvPotBar withStatus={potBar.withStatus} /> : null}
      {/* The tab body is wrapped in an error boundary so a render crash in ONE tab
          (e.g. a hook useMemo over a shape-changed query) can't white-screen the
          whole operator — the shell chrome (tab strip) and the pot bar sit OUTSIDE
          it and every other tab stays reachable. key={activeTab} resets it on
          navigation. */}
      <div className="pc-advshell__tabbody">
        <AdvTabErrorBoundary key={activeTab} tab={activeTab}>
          <Suspense fallback={<div className="pc-advshell__tab-loading" role="status">Loading…</div>}>
            {renderAdvTab(activeTab, potScope)}
          </Suspense>
        </AdvTabErrorBoundary>
      </div>
    </>
  );
}

function renderAdvTab(tab: AdvTabId, potScope: AdvScope) {
  switch (tab) {
    case 'overview':
      return <AdvOverviewTab />;
    case 'hud':
      // HUD — the session board: every live session grouped by what it needs
      // (adv-hud-fleet-board-2026-07-25). `/adv/HUD` redirects to ?tab=hud.
      return <HudView potScope={potScope} />;
    case 'workflows':
      return <AdvWorkflowsTab />;
    case 'conversations':
      return <AdvConversationsTab />;
    case 'learning':
      return <LearningTab />;
    case 'harnesses':
      return <HarnessesWorkspace />;
    case 'health':
      // The read-only system Health dashboard (system-health-tab-2026-06-15).
      return <HealthTab />;
    case 'frames':
      // Swarm live view — per-agent-display thumbnails from deployed frames
      // (hive-frame-desktops-live-view P-006).
      return <AdvFramesTab />;
    case 'evals':
      // Evaluation — the impartial-benchmark surface (External benchmarks |
      // Internal trends | Report) (impartial-benchmark-suite-2026-06-15 D-007).
      return <AdvEvalsTab />;
    case 'stats':
      return <AdvStatsTab />;
    case 'calendar':
      // Calendar — the schedulable time-surface: FullCalendar over the
      // backend-computed scheduled-plan occurrences (scheduled-recurring-plans P-018/P-019).
      return <ScheduledCalendarTab />;
    case 'history':
      return <AdvHistoryTab />;
    case 'brainstorm':
    case 'prs':
    case 'insights':
    case 'settings':
    case 'docs':
    case 'git':
    case 'testing':
      return <AdvHarnessPanelPage panel={tab} />;
    case 'plans':
      // The "Create" tab is now the dockview dock (inbox / plans / sessions /
      // preview panels), mirroring the Git tab's AdvGitWorkspace. Was the
      // <AdvPlansTabs><PlansClient/></AdvPlansTabs> tab-strip.
      return <AdvCreateDock />;
  }
}
