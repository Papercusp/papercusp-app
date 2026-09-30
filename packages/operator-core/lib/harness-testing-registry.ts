/**
 * harness-testing-registry.ts — the registry the harness Tests tab renders.
 *
 * Phase C / P-022 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * It is `[...universalDomains, ACCEPTANCE]`:
 *   - universalDomains (from @papercusp/testing-shell, via the React/CSS-
 *     free `./testing-domains` shim) — the Universal tier, glob-walked
 *     against the harness worktree once a consumer resolves its role globs.
 *   - ACCEPTANCE — the Project tier, whose "files" are the VAL-covering tests
 *     in the harness's `.papercusp/tests.json` (written by the tester). It has
 *     no globs/runners: the harness testing routes (P-024) populate its files
 *     from tests.json, not from a glob walk. (It is plain data, never passed
 *     through defineTestDomain, so the globs-or-runners invariant doesn't
 *     apply.)
 *
 * Shared by the server routes (apps/operator/lib/endpoint-route/routes/harness/
 * testing.ts) and the AdvTestsPanel (apps/operator/app/adv/harnesses/). Both
 * import this module; it is React/CSS-free and safe server-side.
 */

import { universalDomains, type TestDomain } from './testing-domains';

export const ACCEPTANCE_DOMAIN_ID = 'acceptance';

const ACCEPTANCE_DOMAIN: TestDomain = {
  id: ACCEPTANCE_DOMAIN_ID,
  label: 'Acceptance',
  description: 'VAL-covering tests written by the tester (from .papercusp/tests.json).',
  tier: 'project',
  sections: [{ id: 'all', label: 'All VALs' }],
};

/** The harness Tests tab's domains: Universal + Project (acceptance). */
export const harnessTestingRegistry: TestDomain[] = [...universalDomains, ACCEPTANCE_DOMAIN];

/**
 * tierId → section heading for the harness Tests tab (TestingShell tierLabels).
 * Two tiers: "Universal" = domains that apply to ANY project; "This Harness"
 * = tests specific to this harness (its own domains + Acceptance).
 */
export const HARNESS_TESTING_TIER_LABELS: Record<string, string> = {
  universal: 'Universal',
  project: 'This Harness',
};
