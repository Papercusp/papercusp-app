'use client';

import { useEffect, useMemo, useState } from 'react';
import { TestingShell, tabsFromRegistry } from '@papercusp/testing-shell';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
  ACCEPTANCE_DOMAIN_ID,
} from '@papercusp/operator-core/lib/harness-testing-registry';
import { type TestDomain } from '@papercusp/operator-core/lib/testing-domains';
import { useTestingCustomTabs, useUniversalTestingTabs } from '@/app/admin/testing/testing-custom-tabs';
import { makeHarnessTestingDataSource } from './harness-testing-data-source';
import AcceptancePanel from './AcceptancePanel';

/**
 * <HarnessTestsView> — the harness Tests tab. This is the SAME UI as
 * /admin/testing (the shared <TestingShell> + the same 8 bespoke panels from
 * `TESTING_CUSTOM_TABS`), just DRIVEN FROM THE HARNESS CONFIG instead of the
 * admin-global one:
 *
 *   - nav comes from the harness's own `.papercusp/testing-domains.json`
 *     (GET /api/harness/:slug/testing/domains; falls back to the generic
 *     generalized+Acceptance set), not a hard-wired operator registry;
 *   - the file-list domains read through `makeHarnessTestingDataSource(slug)`
 *     → /api/harness/:slug/testing/* (glob-walks the harness worktree);
 *   - the 8 bespoke panels (Test Runs, Live, Chaos, …) are reused verbatim
 *     from /admin — for the papercup dogfood harness (which IS the operator
 *     repo) their /api/admin/testing/* surface is the correct data;
 *   - plus the harness-only Acceptance panel.
 *
 * Renders nothing-special until the harness registry resolves — it shows the
 * fallback nav immediately (no blocking spinner) and swaps in the full set.
 */
export default function HarnessTestsView({ slug }: { slug: string }) {
  const universalTestingTabs = useUniversalTestingTabs();
  const testingCustomTabs = useTestingCustomTabs();
  const [declared, setDeclared] = useState<
    { domains: TestDomain[]; tierLabels: Record<string, string> } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${encodeURIComponent(slug)}/testing/domains?phase=staging`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`domains ${r.status}`))))
      .then((d) => {
        if (cancelled || !Array.isArray(d?.domains) || !d.domains.length) return;
        setDeclared({
          domains: d.domains as TestDomain[],
          tierLabels: d?.tierLabels ?? HARNESS_TESTING_TIER_LABELS,
        });
      })
      .catch(() => {
        /* keep the static fallback nav */
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const domains = declared?.domains ?? harnessTestingRegistry;
  const tierLabels = declared?.tierLabels ?? HARNESS_TESTING_TIER_LABELS;
  // The universal PANEL tabs (live-web, chaos-web, …) are config-not-data —
  // a domains contract only declares file/runner domains, so append any panel
  // tab it doesn't already carry (their components ship in TESTING_CUSTOM_TABS).
  const tabs = useMemo(() => {
    const declared = tabsFromRegistry(domains);
    const ids = new Set(declared.map((t) => t.id));
    return [...declared, ...universalTestingTabs.filter((t) => !ids.has(t.id))];
  }, [domains, universalTestingTabs]);
  const dataSource = useMemo(() => makeHarnessTestingDataSource(slug, 'staging'), [slug]);
  // Reuse the SAME bespoke panels as /admin, plus the harness Acceptance panel.
  const customTabs = useMemo(
    () => ({
      ...testingCustomTabs,
      [ACCEPTANCE_DOMAIN_ID]: () => <AcceptancePanel slug={slug} />,
    }),
    [slug, testingCustomTabs],
  );

  return (
    <TestingShell
      tabs={tabs}
      tierLabels={tierLabels}
      dataSource={dataSource}
      customTabs={customTabs}
      defaultTabId="test-runs"
      sectionLabel="Tests"
      queryKey="testsTab"
      platform="both"
    />
  );
}
