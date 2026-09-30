'use client';

/**
 * PotWorkspaceCards — the all-mode (`?scope=all`, "All Pots") workspace view
 * for the Working tab (harnesses-tab-hive-model-2026-06-07 P-003 / D-003).
 *
 * Redesign 2026-07-07 (WI-3345, owner ask): this used to be a grid of big
 * icon CARDS (one per hive, with a nested member list). It is now a flat,
 * SORTABLE list rendered with the shared `RichGrid` (@papercusp/grid-core) —
 * the same rich grid the admin / testing / evaluation / projects pages use —
 * so All-Pots reads as a scannable table with real detail columns:
 *
 *   Pot · Kind · Hive · Description · Members · State · Shared · Spec · Path
 *
 * The name kept `PotWorkspaceCards` (its import + the `pot-workspace-cards`
 * mount oracle + the `hive-card-<slug>` / `hive-member-<slug>` row testids are
 * relied on by HarnessesWorkspace and the adv-harness-member-axis e2e). Rows
 * flatten `groupByHive`: each group's root (the hive/pot) is a `hive-card-*`
 * row, followed by its member harnesses as `hive-member-*` rows; a row click
 * drills in via `onDrill(hiveRootSlug, rowSlug)` exactly as the cards did.
 *
 * Description is the "best-available" brief — the first prose line of the pot's
 * SPEC.md, plumbed through the projects-lite payload (ProjectsLiteEntry.description).
 * Pots carry no first-class description field; SPEC.md is the one brief nearly
 * every pot has. Blank pots show "—".
 *
 * Presentational; labels route through `useLexicon` (D-006). The State dot
 * reuses the `hasState` flag already in the projects/lite payload — no new poller.
 */

import { useMemo, useState } from 'react';
import { Boxes, Check, Home, Plus, Share2 } from 'lucide-react';
import {
  RichGrid,
  applySort,
  type ColumnDef,
  type RichGridSortState,
} from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';
import { HIVE_KIND, type HiveGroup, type HiveGroupProject } from './harness-pot-groups';

/**
 * The pot metadata a row reads. A superset of `HiveGroupProject` with the
 * card-facing fields the projects-lite payload also carries (path / hasSpec /
 * description). At runtime the group roots + members ARE the lite entries, so
 * these are present; the wider type lets the columns read them.
 */
export type PotProject = HiveGroupProject & {
  path?: string | null;
  hasSpec?: boolean;
  description?: string | null;
};

export interface HiveWorkspaceCardsProps {
  /** One group per hive (root + members), from `groupByHive`. */
  groups: readonly HiveGroup[];
  /** The active workspace's display name — the header above the list. */
  workspaceLabel?: string;
  /** Drill into a pot — caller writes `?slug=`(hive) + `?harness=`(member) and exits all-mode. */
  onDrill: (potSlug: string, memberSlug: string) => void;
  /** Open the create flow from the empty state. */
  onCreate?: () => void;
}

/** One flat row: a hive/pot root or one of its member harnesses. */
interface PotRow {
  /** Unique row id (slug is unique across the workspace registry). */
  id: string;
  slug: string;
  /** Display kind: 'hive' | 'department' | <harness_kind> | 'harness'. */
  kind: string;
  /** Parent hive slug for members; '' for roots (renders '—'). Sort axis. */
  hiveLabel: string;
  description: string | null;
  /** Sub-harness count for roots; null for member rows. */
  memberCount: number | null;
  hasState: boolean;
  is_shared: boolean;
  hasSpec: boolean;
  path: string | null;
  // ── meta (not columns) ──
  isRoot: boolean;
  /** The hive root to drill into (for onDrill's first arg). */
  hiveRootSlug: string;
}

/** Display kind for a pot: hive homes read 'hive'; a declared non-default
 *  harness_kind (department, sub, …) shows through; everything else 'harness'. */
function displayKind(p: PotProject): string {
  if (p.harness_kind === HIVE_KIND) return 'hive';
  if (p.harness_kind && p.harness_kind !== 'harness') return p.harness_kind;
  return 'harness';
}

/**
 * Flatten `groupByHive` output into one row per DISTINCT pot: the group root
 * (the hive/pot), then each member harness that isn't the root itself. A
 * hive HOME (`harness_kind:'hive'`) is the root row and never also a member
 * row — the same de-dupe the cards did so a hive + its one harness don't read
 * as two flat siblings.
 */
export function flattenPotRows(groups: readonly HiveGroup[]): PotRow[] {
  const rows: PotRow[] = [];
  for (const g of groups) {
    const root = g.root as PotProject;
    const memberProjects = g.members.filter((m) => m.slug !== root.slug) as PotProject[];
    rows.push({
      id: root.slug,
      slug: root.slug,
      kind: displayKind(root),
      hiveLabel: '',
      description: root.description ?? null,
      memberCount: memberProjects.length,
      hasState: !!root.hasState,
      is_shared: !!root.is_shared,
      hasSpec: !!root.hasSpec,
      path: root.path ?? null,
      isRoot: true,
      hiveRootSlug: root.slug,
    });
    for (const m of memberProjects) {
      rows.push({
        id: m.slug,
        slug: m.slug,
        kind: displayKind(m),
        hiveLabel: root.slug,
        description: m.description ?? null,
        memberCount: null,
        hasState: !!m.hasState,
        is_shared: !!m.is_shared,
        hasSpec: !!m.hasSpec,
        path: m.path ?? null,
        isRoot: false,
        hiveRootSlug: root.slug,
      });
    }
  }
  return rows;
}

export default function PotWorkspaceCards({ groups, workspaceLabel, onDrill, onCreate }: HiveWorkspaceCardsProps) {
  const t = useLexicon();
  const hiveLabel = t('pot');
  const hivesLabel = t('pot', { plural: true });
  const membersLabel = t('harness', { plural: true });

  const baseRows = useMemo(() => flattenPotRows(groups), [groups]);
  const [sort, setSort] = useState<RichGridSortState | null>(null);
  const rows = useMemo(() => applySort(baseRows, sort), [baseRows, sort]);

  const columns = useMemo<ColumnDef<PotRow>[]>(() => [
    {
      key: 'pot',
      header: hiveLabel,
      width: 2.4,
      sortKey: 'slug',
      toCopyText: (r) => r.slug,
      render: ({ row }) => (
        <span
          className={`pc-pot-name${row.isRoot ? ' is-root' : ' is-member'}`}
          title={row.path ?? row.slug}
        >
          {row.isRoot ? (
            <Boxes size={14} className="pc-pot-name__icon" aria-hidden />
          ) : (
            <span className="pc-pot-name__branch" aria-hidden>↳</span>
          )}
          <span className="pc-pot-name__slug">{row.slug}</span>
          {row.isRoot && row.memberCount === 0 && (
            <Home size={11} className="pc-pot-name__home" aria-label={`${hiveLabel} root`} />
          )}
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 0.9,
      sortKey: 'kind',
      toCopyText: (r) => r.kind,
      render: ({ row }) => (
        <span className={`pc-pot-badge pc-pot-badge--${row.kind === 'hive' ? 'hive' : 'kind'}`}>
          {row.kind}
        </span>
      ),
    },
    {
      key: 'hive',
      header: hiveLabel,
      width: 1.2,
      sortKey: 'hiveLabel',
      toCopyText: (r) => r.hiveLabel || '',
      render: ({ row }) =>
        row.hiveLabel ? (
          <span className="pc-pot-hive">{row.hiveLabel}</span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
    {
      key: 'description',
      header: 'Description',
      width: 3,
      sortKey: 'description',
      toCopyText: (r) => r.description ?? '',
      render: ({ row }) =>
        row.description ? (
          <span className="pc-pot-desc" title={row.description}>{row.description}</span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
    {
      key: 'members',
      header: membersLabel,
      width: 0.8,
      align: 'right',
      sortKey: 'memberCount',
      toCopyText: (r) => (r.memberCount != null && r.memberCount > 0 ? String(r.memberCount) : ''),
      render: ({ row }) =>
        row.memberCount != null && row.memberCount > 0 ? (
          <span className="pc-pot-count" title={`${row.memberCount} ${membersLabel.toLowerCase()}`}>
            {row.memberCount}
          </span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
    {
      key: 'state',
      header: 'State',
      width: 0.95,
      sortKey: 'hasState',
      toCopyText: (r) => (r.hasState ? 'ready' : 'new'),
      render: ({ row }) => (
        <span className="pc-pot-state" title={row.hasState ? `${hiveLabel} has state` : 'Not set up yet'}>
          <span className={`pc-pot-dot${row.hasState ? ' is-live' : ''}`} aria-hidden />
          <span className="pc-pot-state__label">{row.hasState ? 'ready' : 'new'}</span>
        </span>
      ),
    },
    {
      key: 'shared',
      header: 'Shared',
      width: 0.9,
      sortKey: 'is_shared',
      toCopyText: (r) => (r.is_shared ? 'shared' : ''),
      render: ({ row }) =>
        row.is_shared ? (
          <span className="pc-pot-shared">
            <Share2 size={12} aria-hidden /> shared
          </span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
    {
      key: 'spec',
      header: 'Spec',
      width: 0.7,
      align: 'center',
      sortKey: 'hasSpec',
      toCopyText: (r) => (r.hasSpec ? 'yes' : ''),
      render: ({ row }) =>
        row.hasSpec ? (
          <span className="pc-pot-spec" title="Has SPEC.md">
            <Check size={13} aria-hidden />
          </span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
    {
      key: 'path',
      header: 'Path',
      width: 2,
      sortKey: 'path',
      toCopyText: (r) => r.path ?? '',
      render: ({ row }) =>
        row.path ? (
          <span className="pc-pot-path" title={row.path}>{row.path}</span>
        ) : (
          <span className="pc-pot-dim">—</span>
        ),
    },
  ], [hiveLabel, membersLabel]);

  if (baseRows.length === 0) {
    return (
      <div className="pc-pot-cards pc-pot-cards--empty" data-testid="pot-workspace-cards">
        <div>No {hivesLabel.toLowerCase()} yet.</div>
        {onCreate && (
          <button type="button" className="pc-pot-cards__create" onClick={onCreate}>
            <Plus size={14} aria-hidden /> Create new {hiveLabel.toLowerCase()}
          </button>
        )}
        <ListStyles />
      </div>
    );
  }

  return (
    <div className="pc-pot-cards" data-testid="pot-workspace-cards">
      <div className="pc-pot-cards__ws-header">
        <Boxes size={13} aria-hidden />
        <span className="pc-pot-cards__ws-name" title={workspaceLabel ? `Workspace: ${workspaceLabel}` : undefined}>
          {workspaceLabel ?? 'Workspace'}
        </span>
        <span className="pc-pot-cards__ws-count">
          {baseRows.length} {(baseRows.length === 1 ? hiveLabel : hivesLabel).toLowerCase()}
        </span>
        {onCreate && (
          <button type="button" className="pc-pot-cards__create pc-pot-cards__create--inline" onClick={onCreate}>
            <Plus size={13} aria-hidden /> New {hiveLabel.toLowerCase()}
          </button>
        )}
      </div>
      <RichGrid<PotRow>
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        sortState={sort}
        onSortChange={setSort}
        onRowClick={(r) => onDrill(r.hiveRootSlug, r.slug)}
        getRowBg={(r) =>
          r.isRoot ? 'color-mix(in oklab, var(--accent, #38bdf8), transparent 92%)' : undefined
        }
        rowProps={({ row }) => ({
          'data-testid': row.isRoot ? `hive-card-${row.slug}` : `hive-member-${row.slug}`,
          className: row.isRoot ? 'pc-pot-row pc-pot-row--root' : 'pc-pot-row pc-pot-row--member',
          tabIndex: 0,
        })}
        className="pc-pot-grid"
        style={{ flex: 1, minHeight: 0 }}
      />
      <ListStyles />
    </div>
  );
}

function ListStyles() {
  return (
    <style>{`
      .pc-pot-cards {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 12px 12px 0;
      }
      .pc-pot-cards--empty {
        align-items: center;
        justify-content: center;
        gap: 14px;
        color: var(--fg-mute, #7f9bb4);
        font-size: 13px;
        text-align: center;
        padding: 24px;
      }
      .pc-pot-cards__create {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
        color: var(--fg, #e7f7ff);
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .pc-pot-cards__create:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 65%); }
      .pc-pot-cards__create--inline {
        margin-left: auto;
        padding: 4px 10px;
        font-size: 11px;
      }
      .pc-pot-cards__ws-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--fg-mute, #7f9bb4);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .pc-pot-cards__ws-name {
        color: var(--fg, #e7f7ff);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-pot-cards__ws-count {
        font-weight: 600;
        text-transform: none;
        color: var(--fg-mute, #7f9bb4);
        font-variant-numeric: tabular-nums;
      }

      /* Row testids carry a class hook; make root rows read as group anchors. */
      .pc-pot-row { cursor: pointer; }
      .pc-pot-row--root .pc-pot-name__slug { font-weight: 700; color: var(--fg, #e7f7ff); }

      .pc-pot-name {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        max-width: 100%;
      }
      .pc-pot-name__icon { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-pot-name__branch { flex: 0 0 auto; color: var(--fg-mute, #7f9bb4); padding-left: 6px; }
      .pc-pot-name__slug {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-pot-name__home { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }

      .pc-pot-badge {
        display: inline-block;
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-pot-badge--hive {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        color: var(--accent-soft, #bae6fd);
      }

      .pc-pot-hive {
        color: var(--fg-dim, #b9d4e8);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-pot-desc {
        color: var(--fg-dim, #b9d4e8);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: block;
      }
      .pc-pot-dim { color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 25%); }
      .pc-pot-count {
        font-size: 10.5px;
        font-weight: 700;
        padding: 1px 7px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-pot-state { display: inline-flex; align-items: center; gap: 6px; }
      .pc-pot-state__label { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-pot-dot {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--fg-dim, #b9d4e8), transparent 72%);
        box-shadow: inset 0 0 0 1px var(--bg-3, rgba(255, 255, 255, 0.075));
      }
      .pc-pot-dot.is-live {
        background: var(--good, #34d399);
        box-shadow: 0 0 6px color-mix(in srgb, var(--good, #34d399), transparent 40%);
      }
      .pc-pot-shared {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--accent-soft, #7dd3fc);
      }
      .pc-pot-spec { display: inline-flex; color: var(--good, #34d399); }
      .pc-pot-path {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: block;
      }
    `}</style>
  );
}
