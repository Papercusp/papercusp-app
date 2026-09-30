'use client';

import type { CSSProperties } from 'react';
import type { ColumnDef } from '@papercusp/grid-core';
import { IssueStatusPill, KindPill, SeverityPill, StatusPill } from '../../harness/primitives';
import { TrustBadge, trustBadgeState } from '../../harness/TrustBadge';
import type { HarnessStatus } from '../../harness/theme';
import type { WorkItemRow } from './WorkItemsPanel';

/**
 * SHARED work-item column + filter definitions (dependency-health-pane-2026-08-02
 * P-010, from owner requirement D-003 req 4: "all the filters from the work item
 * list pane should also be brought over").
 *
 * This module is the SINGLE definition of the work-item columns and — the part
 * that matters for the graph pane — their `filter` specs. Both the list pane
 * (WorkItemsPanel) and the dependency-graph pane (DepGraphPanel) import it and
 * feed it to `useColumnFilters(columns, rows, { ns: WORK_ITEM_FILTER_NS })`.
 *
 * Two properties follow from that, and BOTH are the point of the lift:
 *
 *  1. **Parity cannot drift.** A column added/removed/re-typed here changes both
 *     panes in the same commit. The alternative — hand-copying ten filter specs
 *     into the graph pane — is parity that is correct exactly once, on the day it
 *     is written.
 *  2. **Filtering either pane updates BOTH.** `useColumnFilters` persists to one
 *     nuqs param derived from `ns`, so a shared `ns` means the list and the graph
 *     read/write the SAME `wif` URL state. Narrowing the grid to `state=blocked`
 *     narrows the graph to the same set, with no cross-pane wiring at all — the
 *     URL is the bus (see the repo's "almost all state should be in nuqs" rule).
 *
 * ⚠ The `ns` MUST stay `'wi'`: that is the param WorkItemsPanel has always
 * written, so keeping it preserves every existing deep link / saved layout AND is
 * what couples the two panes. Changing it silently decouples them and orphans
 * links — the failure would be invisible, since each pane still works alone.
 */
export const WORK_ITEM_FILTER_NS = 'wi';

/**
 * Grid-cell truncation (native title= is the approved pattern for dynamic
 * per-row truncation tooltips — see design/gotchas).
 */
export const CELL_TRUNCATE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export interface WorkItemColumnOptions {
  /**
   * Whether a row's verified remote author is on the owner's trust list (Trust
   * A4). Injected rather than fetched here so this module stays render-pure and
   * the trust query is opened ONCE by the pane that needs the badge — the graph
   * pane consumes only the `filter` specs and passes a constant `false`.
   */
  isTrusted: (row: WorkItemRow) => boolean;
}

/**
 * The canonical work-item column set. Column `key`s are the filter identities
 * persisted into the `wif` param, so renaming one invalidates existing saved
 * filters — treat them as a wire format.
 */
export function buildWorkItemColumns({
  isTrusted,
}: WorkItemColumnOptions): ColumnDef<WorkItemRow>[] {
  return [
    {
      key: 'id',
      header: 'ID',
      width: 1.4,
      toCopyText: (r) => r.id,
      filter: { type: 'text', accessor: (r) => r.id },
      render: ({ row }) => (
        <code style={CELL_TRUNCATE} title={row.id}>{row.id}</code>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      toCopyText: (r) => r.kind,
      filter: { type: 'enum', accessor: (r) => r.kind },
      // Canonical kind chip (WORK_ITEM_KIND table) — same chip recipe as the
      // Sev column so the table's pill columns read as one visual language.
      render: ({ row }) => <KindPill kind={row.kind} size="xs" />,
    },
    {
      key: 'title',
      header: 'Title',
      width: 4,
      toCopyText: (r) => r.title,
      filter: { type: 'text', accessor: (r) => r.title },
      render: ({ row }) => (
        <span style={CELL_TRUNCATE} title={row.title}>{row.title}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 1.2,
      toCopyText: (r) => r.state,
      filter: { type: 'enum', accessor: (r) => r.state },
      // Canonical status pills (app/harness/theme.ts tables — the same coloring
      // FeatureList/IssuesList use). Family picks the table; unknown states fall
      // back to the tables' neutral meta, so plain text never regresses to bare.
      // chip variant = the SeverityPill look, matching the Kind + Sev columns.
      render: ({ row }) =>
        row.family === 'issue' ? (
          <IssueStatusPill status={row.state} size="xs" variant="chip" />
        ) : (
          <StatusPill status={row.state as HarnessStatus} size="xs" variant="chip" />
        ),
    },
    {
      // Trust A4: author trust-state for shared (federated) work — empty for local items.
      key: 'trust',
      header: 'Trust',
      width: 1.3,
      toCopyText: (r) =>
        trustBadgeState({
          origin: r.origin,
          auditVerdict: r.auditVerdict,
          verifiedAuthorGithubUserId: r.verifiedAuthorGithubUserId,
          trusted: isTrusted(r),
        })?.label ?? '',
      render: ({ row }) => (
        <TrustBadge
          origin={row.origin}
          auditVerdict={row.auditVerdict}
          verifiedAuthorGithubUserId={row.verifiedAuthorGithubUserId}
          trusted={isTrusted(row)}
        />
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      width: 1.7,
      toCopyText: (r) => (r.spineRole ? `${r.spineRole}${r.spineStatus ? ` (${r.spineStatus})` : ''}` : ''),
      filter: { type: 'enum', accessor: (r) => r.spineRole },
      render: ({ row }) =>
        row.spineRole ? (
          <span
            style={CELL_TRUNCATE}
            title={`latest spine role · status (spawned_agents): ${row.spineRole}${row.spineStatus ? ` (${row.spineStatus})` : ''}`}
          >
            {row.spineRole}
            {row.spineStatus ? <span style={{ color: 'var(--fg-mute)' }}> ({row.spineStatus})</span> : null}
          </span>
        ) : (
          <>—</>
        ),
    },
    {
      key: 'assignee',
      header: 'Assignee',
      width: 1.8,
      toCopyText: (r) => r.assignee ?? '',
      filter: { type: 'enum', accessor: (r) => r.assignee },
      render: ({ row }) => (
        <span
          style={CELL_TRUNCATE}
          title={
            row.assignee
              ? `${row.assignee}${row.assignedBy ? ` — delegated by ${row.assignedBy}` : ''}`
              : undefined
          }
        >
          {row.assignee ?? '—'}
          {row.assignedBy ? <span style={{ color: 'var(--fg-mute)' }}> ·by {row.assignedBy}</span> : null}
        </span>
      ),
    },
    {
      key: 'severity',
      header: 'Sev',
      width: 0.9,
      toCopyText: (r) => r.severity ?? '',
      filter: { type: 'enum', accessor: (r) => r.severity },
      render: ({ row }) =>
        row.severity ? <SeverityPill severity={row.severity} size="xs" /> : <>—</>,
    },
    {
      key: 'priority',
      header: 'Prio',
      width: 0.8,
      toCopyText: (r) => (r.priority == null ? '' : String(r.priority)),
      filter: { type: 'number', accessor: (r) => r.priority },
      render: ({ row }) => <>{row.priority ?? '—'}</>,
    },
    {
      key: 'rank',
      header: 'Rank',
      width: 0.8,
      toCopyText: (r) => (r.rank == null ? '' : String(r.rank)),
      filter: { type: 'number', accessor: (r) => r.rank },
      render: ({ row }) => <>{row.rank ?? '—'}</>,
    },
    {
      key: 'plan',
      header: 'Plan',
      width: 1.8,
      toCopyText: (r) => r.planSlug ?? '',
      // Plan is a FIXED SET (the harness's plan slugs), not free text — enum so
      // the filter offers a selectable checklist of the actual plans (with live
      // counts + an in-list search for long sets), not a blank search box.
      filter: { type: 'enum', accessor: (r) => r.planSlug },
      render: ({ row }) =>
        row.planSlug ? (
          <code style={{ ...CELL_TRUNCATE, fontSize: 11 }} title={row.planSlug}>{row.planSlug}</code>
        ) : (
          <>—</>
        ),
    },
  ];
}

/**
 * The graph pane's view of the same definitions: identical `filter` specs, with
 * every `render`/`toCopyText` dropped. The graph never draws a grid cell, and
 * carrying JSX renderers into it would drag `primitives`/`TrustBadge` into a
 * canvas-only bundle for nothing.
 *
 * It deliberately derives FROM `buildWorkItemColumns` rather than re-listing the
 * columns — a hand-written second list is exactly the drift this module exists to
 * prevent.
 */
export function workItemFilterColumns(): ColumnDef<WorkItemRow>[] {
  return buildWorkItemColumns({ isTrusted: () => false }).map((col) => ({
    key: col.key,
    header: col.header,
    width: col.width,
    filter: col.filter,
    render: col.render,
  }));
}
