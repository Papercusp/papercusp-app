/**
 * AdvContributorsPanel — Phase-8 P-048 Contributors tab (live /adv shell).
 *
 * One row per harness contributor: avatar + name + @login (→ user profile,
 * P-048b), binding-status badge (P-048a), joined date, tier-A merged-PRs /
 * tier-B features-shipped / tier-C activity badges (P-071), device count
 * (P-048a devices). Sortable by joined / PRs / features / activity (P-048c)
 * via the pure `compareContributors`. Unverified/pending bindings render
 * greyed with ZEROED stats (P-048d) — `statsAggregateForStatus`.
 *
 * Data: `contributors.byHarness` sync query. The resolver mirrors the
 * user-profile tier sources (`auto_review_audit`,
 * `harness_features_consolidated.taken_by`) and applies P-048d zeroing.
 */
import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { parseAsInteger, parseAsStringEnum, useQueryState } from 'nuqs';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { BindingStatusBadge, type BindingStatus } from '../../_components/BindingStatusBadge';
import { statsAggregateForStatus } from '@papercusp/operator-core/lib/identity/binding-verifier-types';
import {
  compareContributors,
  type ContributorSortKey,
  type ContributorTabRow,
} from '@papercusp/operator-core/lib/harness-insights/load-contributors-tab';
import {
  USAGE_EVENT_KINDS,
  type UsageEventKind,
  type UsageRollupForContributor,
} from '@papercusp/operator-core/lib/harness/contributor-usage-event-types';
import { useViewer } from './useViewer';

interface ApiRow {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: number;
  binding_status: BindingStatus;
  device_count: number;
  prs_merged: number;
  features_shipped: number;
  activity_events: number;
}

const SORTS: Array<{ key: ContributorSortKey; label: string }> = [
  { key: 'joined', label: 'Joined' },
  { key: 'prs', label: 'PRs ✓' },
  { key: 'features', label: 'Shipped ✓' },
  { key: 'activity', label: 'Activity' },
];

/** Map an API row → the ContributorTabRow shape, applying P-048d zeroing. */
function toTabRow(r: ApiRow): ContributorTabRow {
  const aggregate = statsAggregateForStatus(r.binding_status);
  return {
    github_user_id: r.github_user_id,
    login: r.github_username,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    binding_status: r.binding_status,
    joined_at: r.joined_at,
    device_count: r.device_count,
    prs_merged: aggregate ? r.prs_merged : 0,
    features_shipped: aggregate ? r.features_shipped : 0,
    activity_events: aggregate ? r.activity_events : 0,
  };
}

function fmtJoined(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '—';
  }
}

/** Short per-kind labels for the expanded P-070 activity breakdown. */
const KIND_LABEL: Record<UsageEventKind, string> = {
  feature_authored: 'authored',
  feature_queued: 'queued',
  feature_worked_start: 'started',
  feature_worked_end: 'worked',
  pr_opened: 'PRs',
  decision_added: 'decisions',
  plan_authored: 'plans',
  agent_run_completed: 'runs',
};

type UsageEntry = UsageRollupForContributor | 'loading' | 'error' | undefined;

/** Render the per-kind breakdown for one contributor's expanded activity row.
 *  Zero-count kinds are omitted so the line stays scannable. */
function renderUsageBreakdown(entry: UsageEntry): ReactNode {
  if (entry === undefined || entry === 'loading') {
    return <span className="pc-adv-contributors__usage-loading">Loading activity…</span>;
  }
  if (entry === 'error') {
    return <span className="pc-adv-contributors__usage-empty">Activity unavailable</span>;
  }
  const nonZero = USAGE_EVENT_KINDS.filter((k) => (entry.counts[k] ?? 0) > 0);
  if (nonZero.length === 0) {
    return <span className="pc-adv-contributors__usage-empty">No recorded activity yet</span>;
  }
  return nonZero.map((k) => (
    <span key={k} className="pc-adv-contributors__usage-kind">
      {KIND_LABEL[k]} {entry.counts[k]}
    </span>
  ));
}

export default function AdvContributorsPanel({ params, api }: PanelComponentProps) {
  const workspaceId = useWorkspaceId();
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [sort, setSort] = useQueryState(
    'csort',
    parseAsStringEnum<ContributorSortKey>(SORTS.map((s) => s.key)).withDefault('joined'),
  );
  // P-070: which contributor's per-kind activity breakdown is expanded (URL-backed
  // per the nuqs default), + a small id→rollup cache fetched from /contributor-usage.
  const [expandedId, setExpandedId] = useQueryState('cusage', parseAsInteger);
  const [usageById, setUsageById] = useState<Record<number, UsageEntry>>({});
  const { isMe } = useViewer();
  const contributorsQuery = useSyncQuery<ApiRow>({
    queryName: 'contributors.byHarness',
    args: slug ? { harnessSlug: slug, workspaceId } : undefined,
    enabled: !!slug && !!workspaceId,
  });
  const rows = useMemo(
    () => (contributorsQuery.data ? contributorsQuery.data.map(toTabRow) : null),
    [contributorsQuery.data],
  );
  const error = contributorsQuery.error ? String(contributorsQuery.error) : null;

  useEffect(() => {
    if (expandedId == null || !slug) return;
    const id = expandedId;
    let cancelled = false;
    setUsageById((m) => (m[id] ? m : { ...m, [id]: 'loading' }));
    (async () => {
      try {
        const res = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/contributor-usage?github_user_id=${id}`,
          { cache: 'no-store' },
        );
        const body = (await res.json().catch(() => ({}))) as { rollup?: UsageRollupForContributor };
        if (!cancelled) setUsageById((m) => ({ ...m, [id]: body.rollup ?? 'error' }));
      } catch {
        if (!cancelled) setUsageById((m) => ({ ...m, [id]: 'error' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedId, slug]);

  useEffect(() => {
    if (rows) api.setTitle(`Contributors · ${slug} (${rows.length})`);
  }, [rows, slug, api]);

  const sorted = useMemo(
    () => (rows ? [...rows].sort((a, b) => compareContributors(a, b, sort)) : []),
    [rows, sort],
  );

  if (!slug) return <div className="pc-advpanel__empty">No harness selected.</div>;
  if (error) return <div className="pc-advpanel__empty pc-advpanel__empty--err">Contributors unavailable: {error}</div>;
  if (rows === null) return <div className="pc-advpanel__empty">Loading contributors…</div>;
  if (rows.length === 0) return <div className="pc-advpanel__empty">No contributors yet.</div>;

  return (
    <div className="pc-advpanel pc-adv-contributors">
      <div className="pc-advpanel__bar" role="tablist" aria-label="Sort contributors">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={sort === s.key}
            className="pc-advpanel__chip"
            onClick={() => void setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="pc-adv-contributors__list">
        {sorted.map((c) => {
          const greyed = !statsAggregateForStatus(c.binding_status);
          return (
            <li
              key={c.github_user_id}
              className="pc-adv-contributors__row"
              style={greyed ? { opacity: 0.55 } : undefined}
            >
              <a
                className="pc-adv-contributors__who"
                href={`/users/github/${c.github_user_id}`}
                aria-label={`View ${c.login}'s profile`}
              >
                {c.avatar_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.avatar_url} alt="" width={22} height={22} className="pc-adv-contributors__avatar" />
                )}
                <span className="pc-adv-contributors__name">
                  {c.display_name || c.login}
                  <span className="pc-adv-contributors__login">@{c.login}</span>
                  {isMe(c.github_user_id) && <span className="pc-adv-contributors__you"> (you)</span>}
                </span>
              </a>
              <BindingStatusBadge status={c.binding_status} />
              <span className="pc-adv-contributors__tiers" aria-label="activity by trust tier">
                <span title="Tier-A merged PRs">✓{c.prs_merged} PR</span>
                <span title="Tier-B features shipped">✓{c.features_shipped} shipped</span>
                <Tooltip label="Tier-C activity events — click for the per-kind breakdown"><button
                  type="button"
                  className="pc-adv-contributors__activity"

                  aria-expanded={expandedId === c.github_user_id}
                  onClick={() =>
                    void setExpandedId(expandedId === c.github_user_id ? null : c.github_user_id)
                  }
                >
                  {c.activity_events} act
                </button></Tooltip>
              </span>
              <span className="pc-adv-contributors__joined" title="Joined">{fmtJoined(c.joined_at)}</span>
              {c.device_count > 0 && (
                <span className="pc-adv-contributors__devices" title="Bound devices">
                  {c.device_count} {c.device_count === 1 ? 'device' : 'devices'}
                </span>
              )}
              {expandedId === c.github_user_id && (
                <div
                  className="pc-adv-contributors__usage"
                  role="region"
                  aria-label={`${c.login} activity breakdown`}
                >
                  {renderUsageBreakdown(usageById[c.github_user_id])}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <style>{`
        .pc-adv-contributors__list {
          list-style: none; margin: 0; padding: 0;
          flex: 1; min-height: 0; overflow-y: auto;
        }
        .pc-adv-contributors__row {
          display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
          padding: 7px 12px; font-size: 12.5px;
          border-bottom: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 45%);
        }
        .pc-adv-contributors__row:hover { background: var(--bg-2, rgba(255, 255, 255, 0.045)); }
        .pc-adv-contributors__who {
          display: inline-flex; align-items: center; gap: 8px;
          flex: 1; min-width: 0; color: var(--fg, #e7f7ff); text-decoration: none;
        }
        .pc-adv-contributors__who:hover .pc-adv-contributors__name { color: var(--accent-strong, #7dd3fc); }
        .pc-adv-contributors__avatar { border-radius: 50%; flex-shrink: 0; }
        .pc-adv-contributors__name {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-weight: 600;
        }
        .pc-adv-contributors__login { margin-left: 6px; font-weight: 400; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-adv-contributors__you { font-size: 11px; color: var(--accent-strong, #7dd3fc); }
        .pc-adv-contributors__tiers {
          display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
          font-size: 11px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
        }
        .pc-adv-contributors__activity {
          padding: 1px 8px; font-size: 11px; color: var(--fg-dim, #b9d4e8);
          background: transparent;
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 999px; cursor: pointer; font-variant-numeric: tabular-nums;
        }
        .pc-adv-contributors__activity:hover { color: var(--fg, #e7f7ff); border-color: var(--accent, #38bdf8); }
        .pc-adv-contributors__activity[aria-expanded="true"] {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
        }
        .pc-adv-contributors__joined { flex-shrink: 0; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-adv-contributors__devices {
          flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 999px;
          background: var(--bg-3, rgba(255, 255, 255, 0.075)); color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-contributors__usage {
          flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px;
          padding: 2px 0 2px 30px; font-size: 11px; color: var(--fg-dim, #b9d4e8);
        }
        .pc-adv-contributors__usage-kind {
          padding: 1px 7px; border-radius: 999px;
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-contributors__usage-loading,
        .pc-adv-contributors__usage-empty { color: var(--fg-mute, #7f9bb4); font-style: italic; }
      `}</style>
    </div>
  );
}
