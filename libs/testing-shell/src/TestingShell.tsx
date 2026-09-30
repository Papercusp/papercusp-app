/**
 * <TestingShell> — the left-rail + panel host for a testing surface.
 *
 * Extracted from apps/operator-vite/src/components/admin/TestingClient.tsx
 * as Phase A / P-003 of harness-tests-tab-and-tester-promotion-2026-05-26,
 * so the harness Tests tab (Phase C) renders the same shell as
 * /admin/testing. Behavior is identical to the admin original; the tab
 * list, tier labels, data source, and bespoke-tab overrides are now props
 * instead of module constants.
 *
 * Each tab renders either a caller-supplied bespoke component
 * (`customTabs[id]`) or the shared <DomainTestPanel domainId={id}>. The
 * admin's 3-tier grouping (quick / domain / surface) generalizes to an
 * arbitrary `tierLabels` map whose key order defines the order tiers
 * render in the rail — so the harness can use its own tiers (Built-in /
 * Project) without touching this component.
 */

import { type ReactElement, type ReactNode } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import './testing-shell.css';
import DomainTestPanel from './DomainTestPanel';
import { type TestingDataSource } from './data-source';
import { type TestDomain } from './registry';
import { visibleTabs, type Platform, type TabPlatform } from './platform';

/** One entry in the left-rail nav. */
export interface TestingShellTab {
  id: string;
  label: string;
  /** One-line descriptor shown under the label. */
  hint: string;
  /** Tier id — should be a key of the shell's `tierLabels`. */
  tier: string;
  /** Platform variant this tab belongs to; omit = platform-agnostic. */
  platform?: TabPlatform;
}

export interface TestingShellProps {
  /** Left-rail nav entries, in display order within each tier. */
  tabs: TestingShellTab[];
  /**
   * tierId → section heading. Key ORDER defines the order tiers render in
   * the rail. A tab whose `tier` is not a key here is dropped from the nav.
   */
  tierLabels: Record<string, string>;
  /** Backend surface passed through to every <DomainTestPanel>. */
  dataSource: TestingDataSource;
  /**
   * id → bespoke component. A tab listed here renders its component in
   * place of <DomainTestPanel>. Used by /admin/testing's hand-built tabs,
   * which can't live in this lib (operator-vite-only dependencies).
   */
  customTabs?: Partial<Record<string, () => ReactElement>>;
  /** Default selected tab id. Defaults to the first tab. */
  defaultTabId?: string;
  /** Heading above the nav. Defaults to "Testing". */
  sectionLabel?: string;
  /**
   * Optional content rendered in the left rail between the section label and
   * the nav — e.g. a project switcher. Lets a host put rail-scoped controls
   * here instead of a separate top bar. Omit for none (the operator does).
   */
  railHeader?: ReactNode;
  /** nuqs query key for the active tab. Defaults to "tab". */
  queryKey?: string;
  /**
   * Which platform(s) this host runs on. Tabs tagged with a non-matching
   * `platform` are hidden. Defaults to 'both' (back-compat: untagged tabs
   * always show).
   */
  platform?: Platform;
}

/**
 * Map a `TestDomain[]` registry to the shell's nav tabs (`hint` =
 * `description`). Lets registry-shaped callers (e.g. the harness Tests
 * tab, P-022) pass their domains straight through.
 */
export function tabsFromRegistry(domains: TestDomain[]): TestingShellTab[] {
  return domains.map((d) => ({
    id: d.id,
    label: d.label,
    hint: d.description,
    tier: d.tier,
  }));
}

export default function TestingShell({
  tabs,
  tierLabels,
  dataSource,
  customTabs,
  defaultTabId,
  sectionLabel = 'Testing',
  queryKey = 'tab',
  platform = 'both',
  railHeader,
}: TestingShellProps): ReactElement {
  const shown = visibleTabs(tabs, platform);
  const tabIds = shown.map((t) => t.id) as [string, ...string[]];
  const [tab, setTab] = useQueryState(
    queryKey,
    parseAsStringEnum<string>(tabIds).withDefault(defaultTabId ?? shown[0]?.id ?? ''),
  );

  // Group by tier in tierLabels key order; drop empty tiers.
  const groups = Object.keys(tierLabels)
    .map((tier) => ({
      tier,
      label: tierLabels[tier] ?? tier,
      tabs: shown.filter((t) => t.tier === tier),
    }))
    .filter((g) => g.tabs.length > 0);

  const CustomComponent = customTabs?.[tab];

  return (
    <div className="pc-test-shell">
      <aside className="pc-test-left">
        <h2 className="pc-test-section-label">{sectionLabel}</h2>
        {railHeader ? <div className="pc-test-rail-header">{railHeader}</div> : null}
        <nav aria-label={`${sectionLabel} tabs`}>
          {groups.map(({ tier, label, tabs: tierTabs }) => (
            <div key={tier} className="pc-test-tab-group" data-tier={tier}>
              <div className="pc-test-tier-label">
                <span>{label}</span>
                <span className="pc-test-tier-count">{tierTabs.length}</span>
              </div>
              {tierTabs.map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`pc-test-tab ${active ? 'is-active' : ''}`}
                    data-tier={tier}
                    aria-current={active ? 'page' : undefined}
                    aria-pressed={active}
                    onClick={() => setTab(t.id)}
                  >
                    <span className="pc-test-tab-label">{t.label}</span>
                    <span className="pc-test-tab-hint">{t.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="pc-test-main">
        {CustomComponent ? (
          <CustomComponent />
        ) : (
          <DomainTestPanel domainId={tab} dataSource={dataSource} />
        )}
      </main>
    </div>
  );
}
