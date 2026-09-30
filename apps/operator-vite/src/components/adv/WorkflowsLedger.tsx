/**
 * WorkflowsLedger — the one frame's dense ledger, and the Activity mode's feed.
 *
 * Plan: workflows-tab-one-frame-2026-08-28 (P-002), governed by D-001.
 *
 * Every automation the workspace runs is ONE row here: triggered plans, AI routines and
 * system tasks alike, with kind and state as facets rather than as separate destinations.
 * All derivation lives in workflows-ledger-model.ts; this file is presentation only, which
 * is what lets the sort, the facet counts and the truthfulness rules be tested without
 * mounting React.
 *
 * ── TWO REPO RAILS SHAPE THE MARKUP, NOT TASTE ──────────────────────────────────────────
 * 1. The `design-primitives` lint blocks new native <table> in app UI, so the ledger renders
 *    through the shared <Table> primitive rather than hand-rolling thead/tbody.
 * 2. That same lint blocks `display:flex` on a <button> selector, because WebKitGTK — the
 *    desktop's webview — ignores it. Every button here is therefore a bare <button> wrapping
 *    a `__btn-inner` span, and the span is what carries the layout.
 */

import { Table, type TableColumn } from '@/app/harness/Table';
import { Workflow } from 'lucide-react';
import type { AutomationActivityItem } from './workflows-model';
import { relativeTime } from './workflows-model';
import type { LedgerRow } from './workflows-ledger-model';

const KIND_CHIP: Record<LedgerRow['kind'], string | null> = {
  // A triggered plan is the unmarked default — chipping every row would be noise.
  triggered: null,
  routine: 'routine',
  system: 'system',
};

/**
 * The shared <Table> primitive sets its own inline `fontSize: 11` on <th> and 12 on the
 * table. Inline styles beat a stylesheet, so the legibility floors this surface is held to
 * (secondary metadata at 12px or larger, on --fg-dim) are asserted HERE, through the
 * primitive's own per-column style hooks, rather than with an `!important` in the CSS.
 * `adv-workflows.legibility.test.ts` pins both numbers.
 */
const LEDGER_HEADER_STYLE = { fontSize: 12, color: 'var(--fg-dim)', opacity: 1 } as const;
const LEDGER_CELL_STYLE = { padding: '9px 10px' } as const;

/** Apply the floors to every column, so a new column cannot quietly ship below them. */
function withLegibleStyles<Row>(columns: TableColumn<Row>[]): TableColumn<Row>[] {
  return columns.map((column) => ({
    ...column,
    headerStyle: { ...LEDGER_HEADER_STYLE, ...column.headerStyle },
    cellStyle: { ...LEDGER_CELL_STYLE, ...column.cellStyle },
  }));
}

export interface WorkflowsLedgerProps {
  rows: readonly LedgerRow[];
  /** Matching rows the caller did NOT pass, held back by the render cap. Always disclosed. */
  hiddenCount?: number;
  selectedId: string | null;
  loading: boolean;
  /** Short heading for the loaded empty state. */
  emptyTitle: string;
  /** Rendered when `rows` is empty — the caller says WHY it is empty. */
  emptyLabel: string;
  onSelect: (row: LedgerRow) => void;
  onToggleArm: (row: LedgerRow) => void;
  /** Row id whose arm control is mid-flight, or null. */
  busyRowId: string | null;
}

export default function WorkflowsLedger({
  rows,
  hiddenCount = 0,
  selectedId,
  loading,
  emptyTitle,
  emptyLabel,
  onSelect,
  onToggleArm,
  busyRowId,
}: WorkflowsLedgerProps) {
  const columns: TableColumn<LedgerRow>[] = [
    {
      key: 'workflow',
      header: 'Workflow',
      render: (row) => (
        <span className="pc-wf__cell-name">
          <i className="pc-wf__dot" data-state={row.state} aria-hidden />
          <span className="pc-wf__name-text">{row.label}</span>
          {KIND_CHIP[row.kind] ? <em className="pc-wf__kind">{KIND_CHIP[row.kind]}</em> : null}
        </span>
      ),
      cellTitle: (row) => row.description,
    },
    {
      key: 'chain',
      header: 'Trigger → plan → outcome',
      render: (row) => (
        <span className="pc-wf__chain">
          <span className="pc-wf__chip" data-part="trigger">{row.chain.trigger}</span>
          <span className="pc-wf__arrow" aria-hidden>→</span>
          <span className="pc-wf__chip" data-part="plan">{row.chain.plan}</span>
          {row.chain.outcome ? (
            <>
              <span className="pc-wf__arrow" aria-hidden>→</span>
              <span className="pc-wf__chip" data-part="outcome">{row.chain.outcome}</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last',
      // null means never fired. An em dash, never a fabricated time.
      render: (row) => <span className="pc-wf__num">{row.lastLabel ?? '—'}</span>,
    },
    {
      key: 'next',
      header: 'Next',
      render: (row) => <span className="pc-wf__num">{row.nextLabel}</span>,
    },
    {
      key: 'spend',
      header: 'Spend',
      // D-005: an honest classification token; the verified dollars are in the inspector.
      render: (row) => <span className="pc-wf__num">{row.spendToken}</span>,
      cellTitle: (row) => row.spendLabel,
    },
    {
      key: 'armed',
      header: 'Armed',
      render: (row) => <ArmCell row={row} busy={busyRowId === row.id} onToggle={() => onToggleArm(row)} />,
    },
  ];

  if (loading && rows.length === 0) {
    return (
      <div className="pc-wf__panel pc-wf__ledger" aria-busy="true">
        <div className="pc-wf__loading" role="status" aria-label="Loading workflows">
          <div className="pc-wf__loading-copy">
            <strong>Loading workflow inventory</strong>
            <span>Combining schedules, triggers, routines, and recent runs…</span>
          </div>
          <div className="pc-wf__loading-rows" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <span key={index} className="pc-wf__loading-row">
                <i className="pc-wf__skeleton pc-wf__skeleton--dot" />
                <i className="pc-wf__skeleton pc-wf__skeleton--name" />
                <i className="pc-wf__skeleton pc-wf__skeleton--meta" />
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="pc-wf__panel pc-wf__ledger pc-wf__ledger--empty">
        <div className="pc-wf__empty-state" role="status">
          <span className="pc-wf__empty-icon" aria-hidden><Workflow size={19} /></span>
          <div>
            <strong>{emptyTitle}</strong>
            <p>{emptyLabel}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-wf__panel pc-wf__ledger">
      <Table
        className="pc-wf__table pc-wf__table--ledger"
        columns={withLegibleStyles(columns)}
        rows={[...rows]}
        getRowKey={(row) => row.id}
        onRowClick={onSelect}
        isRowSelected={(row) => row.id === selectedId}
        rowClassName={(row) => (row.id === selectedId ? 'is-selected' : undefined)}
        rowTestId={(row) => `wf-row:${row.id}`}
      />
      {hiddenCount > 0 ? (
        <p className="pc-wf__more" data-testid="wf-ledger-more">
          {hiddenCount} more match these filters. Narrow with a facet or the search box to see them.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The arm control.
 *
 * Three states, and the third is the point: `armed === null` means no trigger reports an
 * armed state, which is NOT the same as disarmed. It renders as a disabled dash rather than
 * as an off switch, because an off switch invites a click that would do nothing.
 */
function ArmCell({ row, busy, onToggle }: { row: LedgerRow; busy: boolean; onToggle: () => void }) {
  if (row.armed === null) {
    return <span className="pc-wf__armed" data-armed="unknown">—</span>;
  }
  const label = row.triggerCount > 1 ? `${row.armedCount}/${row.triggerCount}` : row.armed ? 'on' : 'off';
  return (
    <button
      type="button"
      className="pc-wf__arm"
      data-armed={String(row.armed)}
      disabled={busy}
      aria-pressed={row.armed}
      aria-label={`${row.armed ? 'Disarm' : 'Arm'} ${row.label}`}
      // The row is clickable; the toggle must not also select it.
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
    >
      <span className="pc-wf__btn-inner">
        <i className="pc-wf__switch" data-armed={String(row.armed)} aria-hidden />
        <span className="pc-wf__armed-label">{label}</span>
      </span>
    </button>
  );
}

export interface ActivityListProps {
  activity: readonly AutomationActivityItem[];
  /** Entries the caller did NOT pass, held back by the same render cap as the ledger. */
  hiddenCount?: number;
  nowMs?: number;
  onOpen: (item: AutomationActivityItem) => void;
}

/**
 * Activity — the same frame in its other mode (D-001), not a separate page.
 *
 * Newest first, one row per observed fire. `costUsd` is null on every producer today, so no
 * cost column is rendered: an all-em-dash column would only advertise a measurement we do
 * not take.
 */
export function ActivityList({ activity, hiddenCount = 0, nowMs, onOpen }: ActivityListProps) {
  const columns: TableColumn<AutomationActivityItem>[] = [
    {
      key: 'workflow',
      header: 'Workflow',
      render: (row) => (
        <span className="pc-wf__cell-name">
          <i className="pc-wf__dot" data-state={activityState(row.status)} aria-hidden />
          <span className="pc-wf__name-text">{row.label}</span>
        </span>
      ),
    },
    { key: 'detail', header: 'Detail', render: (row) => <span className="pc-wf__chain-text">{row.detail}</span> },
    { key: 'status', header: 'Outcome', render: (row) => <span className="pc-wf__num">{row.status}</span> },
    { key: 'at', header: 'When', render: (row) => <span className="pc-wf__num">{relativeTime(row.at, nowMs)}</span> },
  ];

  return (
    <div className="pc-wf__panel pc-wf__ledger">
      <Table
        className="pc-wf__table pc-wf__table--activity"
        columns={withLegibleStyles(columns)}
        rows={[...activity]}
        getRowKey={(row) => row.id}
        onRowClick={onOpen}
        rowTestId={(row) => `wf-activity:${row.id}`}
        emptyLabel="No workflow activity has been recorded yet."
      />
      {hiddenCount > 0 ? (
        <p className="pc-wf__more" data-testid="wf-activity-more">
          {hiddenCount} older {hiddenCount === 1 ? 'entry is' : 'entries are'} not shown. The feed is newest first.
        </p>
      ) : null}
    </div>
  );
}

/** Map a producer's run status onto the same four state dots the ledger uses. */
function activityState(status: string): LedgerRow['state'] {
  const normalized = status.toLocaleLowerCase();
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('attention')) return 'attention';
  if (normalized.includes('running')) return 'running';
  if (normalized.includes('paused') || normalized.includes('disarmed')) return 'paused';
  return 'ready';
}
