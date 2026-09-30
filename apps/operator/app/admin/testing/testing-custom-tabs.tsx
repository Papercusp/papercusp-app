'use client';

import { useMemo, type ReactElement } from 'react';
import { buildUniversalTesting, type TestingShellTab } from '@papercusp/testing-shell';
import { useLexicon } from '@/lib/useLexicon';
import LiveMetricsTab from './_components/LiveMetricsTab';
import RoutesTab from './_components/RoutesTab';
import PackagedBuildTab from './_components/PackagedBuildTab';
import TestRunsTab from './_components/TestRunsTab';
import MemoryTab from './_components/MemoryTab';
import CoverageTab from './_components/CoverageTab';
// Panel-helper styles (.pc-test-tab-header / cards / tables) travel with the
// panels themselves — every host of these tabs (the /adv harness Tests tab)
// gets them without needing a route-level import.
import './testing.css';

// Base URL the browser-chaos run drives — the BUILT operator SPA on :3070 (the
// port the desktop webview loads). NOT :3055: that's the Vite HMR dev server,
// which throws `createHotContext` in a plain headless browser so nothing
// renders. :3070 serves the hashed-asset build that actually paints + clicks.
const OPERATOR_SPA_URL = 'http://127.0.0.1:3070/';

/**
 * The universal test panels (Live / Chaos-web / AI Explore / Chaos-desktop /
 * LLM), wired ONCE here via `buildUniversalTesting` (universal-testing-domains-
 * generic Phase 6 + Phase 7 P-073) — the same "config not code" surface
 * Restart's /tests uses. The lib
 * owns the panels + their spawn/stream substance; the operator just supplies its
 * endpoints + base URL.
 *
 * - chaos-web / ai-explore POST to the operator's /api/admin/testing/* routes
 *   (which delegate to the testing-shell server cores, P-063).
 * - chaos-desktop opens a recorder window at the current origin; the lib's
 *   <RecorderHost> (mounted in operator-vite __root.tsx) runs the observers +
 *   clicker. The lib's recorder-channel is channel/storage-compatible with the
 *   operator's _lib (same CHANNEL_NAME + localStorage key), so RoutesTab still
 *   sees chaos-desktop runs.
 * - liveObserver (live-web) is a pure in-page observer, no backend.
 */
/**
 * Build the universal-testing config + tabs. A hook (not a module const) so the
 * AI-Explore default goal renders the project unit through the active lexicon
 * pack ("harnesses"/"harness" → "Hives"/"Hive" when the-hive is on). Reactive
 * to a live flag flip via `useLexicon()`.
 */
function useUniversalTesting() {
  const t = useLexicon();
  return useMemo(
    () =>
      buildUniversalTesting({
        liveObserver: true,
        chaosWeb: { runEndpoint: '/api/admin/testing/chaos-web', baseUrl: OPERATOR_SPA_URL },
        aiExplore: {
          runEndpoint: '/api/admin/testing/ai-explore',
          defaultStartUrl: 'http://127.0.0.1:3055/',
          defaultGoal: `Open the ${t('pot', { plural: true, lower: true })} page, click into the first ${t('pot', { lower: true })}, switch to the Issues tab.`,
        },
        chaosDesktop: { defaultRoute: '/' }, // recorderUrl defaults to the current origin
        // LLM scenario-driven evaluation (sim-user → SUT → judge). The lib's
        // LlmTestPanel (Runs / Scenarios / Targets / Findings) drives the operator's
        // existing /api/admin/llm-tests/* routes + /api/credentials — every path is a
        // prop, nothing hardcoded in the lib (Phase 7 P-073).
        llm: {
          scenariosEndpoint: '/api/admin/llm-tests/scenarios',
          runsEndpoint: '/api/admin/llm-tests/runs',
          runDetailEndpoint: '/api/admin/llm-tests/runs',
          findingsEndpoint: '/api/admin/llm-tests/findings',
          credentialsEndpoint: '/api/credentials',
        },
      }),
    [t],
  );
}

/** The universal tabs' metadata (Live / Chaos-web / AI Explore / Chaos-desktop), for the host tab lists. */
export function useUniversalTestingTabs(): TestingShellTab[] {
  return useUniversalTesting().tabs;
}

/**
 * id→component map for the testing panels.
 *
 * SHARED between `/admin/testing` (operator-vite `TestingClient`) and the
 * `/adv` harness Tests tab (`HarnessTestsView`) so both render the IDENTICAL
 * panels. The universal panels come from `buildUniversalTesting` (single
 * source — incl. the LLM panel as of Phase 7 P-073); the rest are
 * operator-specific (Test Runs / Live metrics (vitals) / Memory / Routes /
 * Packaged). Tabs not in this map render via the shared `<DomainTestPanel>`.
 *
 * A hook (not a module const) so the universal panels' lexicon-derived copy
 * (e.g. the AI-Explore default goal) tracks the active brand pack.
 *
 * Lives under `app/admin/testing/` (alongside `_components/`) so it is
 * importable from both operator-vite (`@/app/...`) and the `/adv` view.
 */
export function useTestingCustomTabs(): Record<string, () => ReactElement> {
  const universal = useUniversalTesting();
  return useMemo(
    () => ({
      ...universal.customTabs, // live-web, chaos-web, ai-explore, chaos-desktop
      'test-runs': TestRunsTab,
      // The census view: what surfaces EXIST and which are proven. Complements
      // `test-runs`, which can only speak about tests that ran — a green suite says
      // nothing about the routes it never touched.
      coverage: CoverageTab,
      vitals: LiveMetricsTab, // operator desktop vitals (renamed from `live`; the universal observer owns `live-web`)
      memory: MemoryTab,
      routes: RoutesTab,
      packaged: PackagedBuildTab,
      // `llm` is supplied by `...universal.customTabs` (the lib's LlmTestPanel).
    }),
    [universal],
  );
}
