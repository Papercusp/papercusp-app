'use client';

// adv:hive-content — CROSS-MEMBER BROWSE: the "Hive content" rollup
// (shared-hive-member-content-federation-2026-06-20 WI-259 P-006, D-010). In a
// shared hive, each member's content (features + plans) federates to every peer
// and lands locally under the AUTHORING member's own slug. The normal per-harness
// grids read `WHERE harness_slug = own` — so a member only ever sees its OWN
// content. This panel is the EXPLICIT cross-member view: it reads
// `featuresConsolidated.byHive` + `plans.byHive` (the resolver resolves the hive's
// member-slug set via the registry — hiveMemberHarnessScopes — and unions across
// them), and renders the rows member-ORIGIN-labeled so you can see + drill into
// what every member is building.
//
// READ-ONLY by design (a browse surface): a row click DRILLS into that member
// (`?harness=<origin-slug>` + `?sel=<id>` for the Detail pane); it never mutates
// another member's content. The per-member reads + grids are unchanged — this is
// purely additive. Inert outside a shared hive (no `?slug=` hive home ⇒ empty
// state), and gated behind FLAGS.THE_HIVE at the dock catalog.
//
// Visual vocabulary mirrors MemberWorkPanel / WorkItemsPanel (pc-advpanel chrome +
// the shared StatusPill primitive) so it reads as one language with the dock.

import { useEffect, useMemo } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RefreshCw, FileText, ListTodo } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '../../harness/Tooltip';
import { StatusPill } from '../../harness/primitives';
import type { HarnessStatus } from '../../harness/theme';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { useLexicon } from '@/lib/useLexicon';

/** A federated feature row (featuresConsolidated.byHive = harness_features_consolidated). */
interface PotFeatureRow {
  featureId: string;
  harnessSlug: string;
  title: string | null;
  status: string | null;
  updatedTs: string | number | null;
}

/** A federated plan row (plans.byHive = the plans:list shape; `harness` = origin). */
interface HivePlanRow {
  slug: string;
  title: string | null;
  status: string;
  harness: string;
  updated: string | null;
}

type Tab = 'features' | 'plans';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: typeof FileText }> = [
  { id: 'features', label: 'Features', icon: ListTodo },
  { id: 'plans', label: 'Plans', icon: FileText },
];

// Generous fetch ceiling for the live rollup (the byHive reads are bounded by the
// hive's member-slug set; all data is local). The grid is a plain list — a hive
// rollup is small relative to a single harness's full work set.
function matchesSearch(haystack: Array<string | null | undefined>, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return haystack.some((h) => (h ?? '').toLowerCase().includes(q));
}

export default function PotContentPanel({ params, api }: PanelComponentProps) {
  const t = useLexicon();
  // The dock auto-binds `harnessSlug` to the active route slug for every panel
  // (HarnessesDock rebinds it on slug-switch), so read it FIRST — same convention
  // as MemberWorkPanel. In scope=all that slug is the HIVE HOME; in single-harness
  // scope it's the current harness (whose hive peers the resolver enumerates via
  // the registry). `slug`/`potHomeSlug` are explicit-open fallbacks.
  const potHomeSlug =
    (params.harnessSlug as string) || (params.slug as string) || (params.potHomeSlug as string) || '';

  const [tab, setTab] = useQueryState('hct', parseAsStringEnum<Tab>(['features', 'plans']).withDefault('features'));
  const [search, setSearch] = useQueryState('hcq', parseAsString.withDefault(''));
  // Drill axes the workspace + Detail pane already interpret.
  const [, setHarness] = useQueryState('harness', parseAsString);
  const [, setSel] = useQueryState('sel', parseAsString.withDefault(''));

  const featuresQ = useSyncQuery<PotFeatureRow>({
    queryName: 'featuresConsolidated.byHive',
    args: { potHomeSlug },
    enabled: Boolean(potHomeSlug),
  });
  const plansQ = useSyncQuery<HivePlanRow>({
    queryName: 'plans.byHive',
    args: { potHomeSlug },
    enabled: Boolean(potHomeSlug),
  });

  const features = useMemo(() => featuresQ.data ?? [], [featuresQ.data]);
  const plans = useMemo(() => plansQ.data ?? [], [plansQ.data]);

  const visibleFeatures = useMemo(
    () => features.filter((f) => matchesSearch([f.title, f.featureId, f.harnessSlug], search)),
    [features, search],
  );
  const visiblePlans = useMemo(
    () => plans.filter((p) => matchesSearch([p.title, p.slug, p.harness], search)),
    [plans, search],
  );

  // Distinct member origins present in the rollup — the headline "N members" count.
  const memberCount = useMemo(() => {
    const s = new Set<string>();
    for (const f of features) s.add(f.harnessSlug);
    for (const p of plans) s.add(p.harness);
    return s.size;
  }, [features, plans]);

  useEffect(() => {
    if (!potHomeSlug) return;
    const n = tab === 'features' ? visibleFeatures.length : visiblePlans.length;
    api.setTitle(`${t('pot')} content · ${potHomeSlug} (${n})`);
  }, [potHomeSlug, tab, visibleFeatures.length, visiblePlans.length, api, t]);

  function drillToMember(memberSlug: string, selId?: string): void {
    // Browse → drill: focus that member harness; the Detail pane opens `selId`.
    void setHarness(memberSlug);
    void setSel(selId ?? '');
  }

  if (!potHomeSlug) {
    return (
      <div className="pc-advpanel__empty">
        Cross-member browse shows every {t('pot', { lower: true })} member&rsquo;s features + plans. Select a {t('pot', { lower: true })} (all-mode) to see its rollup.
      </div>
    );
  }

  const loading = featuresQ.loading || plansQ.loading;

  return (
    <div className="pc-advpanel pc-potcontent">
      <div className="pc-advpanel__toolbar">
        <div className="pc-potcontent__tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`pc-potcontent__tab${tab === id ? ' is-active' : ''}`}
              onClick={() => void setTab(id)}
            >
              <Icon size={13} aria-hidden />
              {label}
              <span className="pc-potcontent__tabcount">{id === 'features' ? features.length : plans.length}</span>
            </button>
          ))}
        </div>
        <input
          className="pc-advpanel__search"
          type="search"
          placeholder="Filter title / id / member…"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          aria-label={`Filter ${t('pot', { lower: true })} content`}
        />
        <Tooltip label="Refresh">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => {
              featuresQ.invalidate?.();
              plansQ.invalidate?.();
            }}
            aria-label={`Refresh ${t('pot', { lower: true })} content`}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </Tooltip>
      </div>

      <div className="pc-potcontent__meta">
        {memberCount} {memberCount === 1 ? 'member' : 'members'} · browsing every member’s federated content (read-only)
      </div>

      {loading ? (
        <div className="pc-advpanel__empty">Loading {potHomeSlug}…</div>
      ) : tab === 'features' ? (
        visibleFeatures.length === 0 ? (
          <div className="pc-advpanel__empty">
            No federated features in this {t('pot', { lower: true })} yet — peer members&rsquo; features land here live as they sync.
          </div>
        ) : (
          <ul className="pc-potcontent__list" role="list">
            {visibleFeatures.map((f) => (
              <li key={`${f.harnessSlug}:${f.featureId}`}>
                <Tooltip label={`Open ${f.featureId} in ${f.harnessSlug}`}>
                  <button
                    type="button"
                    className="pc-potcontent__row"
                    onClick={() => drillToMember(f.harnessSlug, f.featureId)}
                  >
                    <span className="pc-potcontent__origin" title={`Member: ${f.harnessSlug}`}>{f.harnessSlug}</span>
                    <span className="pc-potcontent__id">{f.featureId}</span>
                    <span className="pc-potcontent__title">{f.title ?? '(untitled)'}</span>
                    {f.status && <StatusPill status={f.status as HarnessStatus} size="xs" />}
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )
      ) : visiblePlans.length === 0 ? (
        <div className="pc-advpanel__empty">
          No federated plans in this {t('pot', { lower: true })} yet — peer members’ plans land here live as they sync.
        </div>
      ) : (
        <ul className="pc-potcontent__list" role="list">
          {visiblePlans.map((p) => (
            <li key={`${p.harness}:${p.slug}`}>
              <Tooltip label={`Open plan ${p.slug} in ${p.harness}`}>
                <button
                  type="button"
                  className="pc-potcontent__row"
                  onClick={() => drillToMember(p.harness)}
                >
                  <span className="pc-potcontent__origin" title={`Member: ${p.harness}`}>{p.harness}</span>
                  <span className="pc-potcontent__title">{p.title ?? p.slug}</span>
                  {p.status && <StatusPill status={p.status as HarnessStatus} size="xs" />}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .pc-potcontent { display: flex; flex-direction: column; min-height: 0; }
        .pc-potcontent__tabs { display: inline-flex; gap: 2px; }
        .pc-potcontent__tab {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 9px; border-radius: 6px;
          font-size: 12px; color: var(--fg-mute); background: transparent;
          border: 1px solid transparent; cursor: pointer;
        }
        .pc-potcontent__tab:hover { background: color-mix(in oklab, var(--accent), transparent 88%); }
        .pc-potcontent__tab.is-active {
          color: var(--text); background: color-mix(in oklab, var(--accent), transparent 82%);
          border-color: color-mix(in oklab, var(--accent), transparent 70%);
        }
        .pc-potcontent__tabcount { font-variant-numeric: tabular-nums; opacity: 0.7; font-size: 11px; }
        .pc-potcontent__meta { padding: 4px 8px; font-size: 11px; color: var(--fg-mute); }
        .pc-potcontent__list { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
        .pc-potcontent__row {
          display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 8px;
          width: 100%; text-align: left; padding: 5px 8px; background: transparent; border: 0;
          border-bottom: 1px solid var(--border-subtle, color-mix(in oklab, var(--text), transparent 92%));
          cursor: pointer; font-size: 12.5px; color: var(--text);
        }
        .pc-potcontent__row:hover { background: color-mix(in oklab, var(--accent), transparent 90%); }
        .pc-potcontent__origin {
          font-size: 11px; font-weight: 600; color: var(--accent);
          padding: 1px 6px; border-radius: 999px;
          background: color-mix(in oklab, var(--accent), transparent 86%);
          white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-potcontent__id { font-variant-numeric: tabular-nums; color: var(--fg-mute); font-size: 11.5px; white-space: nowrap; }
        .pc-potcontent__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
    </div>
  );
}
