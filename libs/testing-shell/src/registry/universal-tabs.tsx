/**
 * buildUniversalTesting — the one-call "config, not code" surface for the
 * universal test domains (Phase 5 of universal-testing-domains-generic-2026-06-03).
 *
 * A consumer passes ONE config object; this returns the platform-tagged nav
 * tabs + the pre-wired custom panels for whichever domains the config supplies
 * (presence ⇒ tab — D-005). The host spreads them into <TestingShell> and its
 * `platform` prop hides the non-matching variants. Routes is the one
 * glob/role domain — it emits a tab but NO customTab (it renders through
 * <DomainTestPanel> + the host's dataSource; the host registers the domain via
 * applyRoleGlobs(universalDomains, { endpoints: cfg.routes.globs })).
 *
 * NOTE: chaos-desktop (Phase 4) and llm (Phase 7) panels are wired here; this
 * file imports React panels and so is NOT loaded by the server-safe `./registry`
 * entry.
 */
import { type ReactElement } from 'react';
import { type TestingShellTab } from '../TestingShell';
import { universalDomains, UNIVERSAL_PANEL_DOMAINS } from './universal';
import LoadTestPanel from '../web/LoadTestPanel';
import LiveWebPanel from '../web/LiveWebPanel';
import ChaosWebPanel from '../web/ChaosWebPanel';
import AiExplorePanel, { type AiExploreModelOption } from '../web/AiExplorePanel';
import ChaosDesktopPanel from '../desktop/ChaosDesktopPanel';
import LlmTestPanel, { type LlmTestPanelProps } from '../llm/LlmTestPanel';

export interface UniversalTestingConfig {
  /** Endpoint-test globs for the `routes` domain. Omit → no Routes tab. The host must also register the domain (applyRoleGlobs). */
  routes?: { globs: string[] };
  /** k6 load tests. Omit → no Load tab. */
  load?: { scriptsEndpoint: string; runEndpoint: string; stopEndpoint: string; resultsEndpoint: string; project?: string; dashboardUrl?: string };
  /** In-page passive observer (agnostic; no backend). Omit → no Live tab. */
  liveObserver?: boolean;
  /** Headless-Chromium clicker over a base URL (web). Omit → no Chaos (web) tab. */
  chaosWeb?: { runEndpoint: string; baseUrl: string; defaultMaxSteps?: number };
  /** Stagehand LLM walk over a base URL (web). Omit → no AI Explore tab. */
  aiExplore?: { runEndpoint: string; defaultStartUrl: string; defaultGoal?: string; models?: AiExploreModelOption[] };
  /** In-app perf-recorder chaos (desktop). The host must mount <RecorderHost> at recorderUrl. Omit → no Chaos (desktop) tab. */
  chaosDesktop?: { recorderUrl?: string; defaultRoute?: string; blocklist?: string; durations?: Record<string, number> };
  /**
   * Scenario-driven LLM evaluation (sim-user → SUT → judge). Agnostic; every
   * route is injected. Omit → no LLM tab. Operator route defaults:
   * scenariosEndpoint `/api/admin/llm-tests/scenarios`, runsEndpoint +
   * runDetailEndpoint `/api/admin/llm-tests/runs` (detail is `${base}/${id}`),
   * findingsEndpoint `/api/admin/llm-tests/findings`, credentialsEndpoint
   * `/api/credentials`.
   */
  llm?: LlmTestPanelProps;
}

export interface UniversalTesting {
  tabs: TestingShellTab[];
  customTabs: Record<string, () => ReactElement>;
}

/** Build the universal tabs + custom panels for the domains a consumer configures. */
export function buildUniversalTesting(cfg: UniversalTestingConfig): UniversalTesting {
  const tabs: TestingShellTab[] = [];
  const customTabs: Record<string, () => ReactElement> = {};

  const add = (key: keyof typeof UNIVERSAL_PANEL_DOMAINS, panel: () => ReactElement) => {
    const d = UNIVERSAL_PANEL_DOMAINS[key];
    tabs.push({ id: d.id, label: d.label, hint: d.description, tier: d.tier, platform: d.platform });
    customTabs[d.id] = panel;
  };

  if (cfg.routes) {
    const r = universalDomains.find((d) => d.id === 'routes');
    if (r) tabs.push({ id: r.id, label: r.label, hint: r.description, tier: r.tier }); // agnostic; no customTab → DomainTestPanel
  }
  if (cfg.load) add('load', () => <LoadTestPanel {...cfg.load!} />);
  if (cfg.liveObserver) add('live-web', () => <LiveWebPanel />);
  if (cfg.chaosWeb) {
    const c = cfg.chaosWeb;
    add('chaos-web', () => <ChaosWebPanel runEndpoint={c.runEndpoint} baseUrl={c.baseUrl} defaultMaxSteps={c.defaultMaxSteps} />);
  }
  if (cfg.aiExplore) {
    const a = cfg.aiExplore;
    add('ai-explore', () => <AiExplorePanel runEndpoint={a.runEndpoint} defaultStartUrl={a.defaultStartUrl} defaultGoal={a.defaultGoal} models={a.models} />);
  }
  if (cfg.chaosDesktop) {
    const cd = cfg.chaosDesktop;
    add('chaos-desktop', () => <ChaosDesktopPanel recorderUrl={cd.recorderUrl} defaultRoute={cd.defaultRoute} blocklist={cd.blocklist} durations={cd.durations} />);
  }
  if (cfg.llm) add('llm', () => <LlmTestPanel {...cfg.llm!} />);

  return { tabs, customTabs };
}
