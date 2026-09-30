'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * ColumnFilterBar — the visual surface for the generic column-filter system
 * (generic-column-filters-2026-06-14 Phase 2). Driven entirely by the
 * `controller` from `useColumnFilters`; renders NOTHING when the
 * `papercusp-grid-column-filters` flag is off.
 *
 * Chosen UX (plan P-009) — a single FILTER BAR, not per-column header funnels:
 *   - A `+ Add filter` design-system <Select> listing the filterable columns
 *     that are NOT yet active. Picking one opens a <Popover> editor for it.
 *   - Per-type editor inside the Popover: text → text input; enum → checkbox
 *     multiselect (each option shows its live count; single-select if !multi);
 *     number → min/max inputs; boolean → a true/false toggle.
 *   - Active filters render as removable `pc-advpanel__chip` chips (label + ×),
 *     with a `Clear all` when any is active.
 *
 * Built ONLY on the design-system Select / Popover / Checkbox primitives and the
 * existing `pc-advpanel__*` classes — no hand-rolled dropdowns/popovers, no
 * off-system component (P-009 design check). Bare <button>/<input> get explicit
 * frost tokens (they don't inherit the theme) or reuse the panel classes.
 */

import { memo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, ListFilter, X } from 'lucide-react';
import { FLAGS } from '@papercusp/flags';
import type { ColumnFilterValue, FilterableColumn, NumberFilterValue } from '@papercusp/grid-core';
import { useFlag } from '@/lib/flag-hooks';
import { Select } from '../Select';
import { Popover } from '../Popover';
import { Checkbox } from '../Checkbox';
import type { ColumnFilterController } from './useColumnFilters';
import { countEvidenceScopeText, formatCountNumber } from './count-evidence';

const ADD_FILTER = '_add_filter_';

/** Plain-text header for a column (the editor heading + the Add-filter option). */
export function headerText(col: FilterableColumn<unknown>): string {
  const h = col.header;
  if (typeof h === 'string' && h.length > 0) return h;
  if (typeof h === 'number') return String(h);
  if (typeof col.headerText === 'string' && col.headerText.length > 0) return col.headerText;
  return col.key;
}

const EDITOR_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 200,
  maxWidth: 280,
  padding: 10,
  background: 'color-mix(in srgb, var(--bg-deeper, #0b1622), transparent 2%)',
  color: 'var(--fg, #e7f7ff)',
  border: '1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 62%)',
  borderRadius: 10,
  boxShadow: '0 18px 54px rgba(0,0,0,0.62)',
  fontSize: 12,
};

const EDITOR_HEADING_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  color: 'var(--fg-mute, #7f9bb4)',
};

const NUMBER_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

/**
 * Above this many options the enum editor grows an in-list search box so a
 * long fixed-set property (plans, assignees, sources…) stays usable — you get
 * BOTH a type-to-narrow search AND the selectable checklist, not one or the
 * other. Short enums (kind, state, severity) stay clean with just the list.
 */
const ENUM_SEARCH_THRESHOLD = 8;

const ENUM_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 220,
  overflowY: 'auto',
};

const ENUM_SEARCH_INPUT_STYLE: CSSProperties = {
  width: '100%',
  padding: '4px 7px',
  fontSize: 12,
  fontFamily: 'inherit',
  color: 'var(--fg, #e7f7ff)',
  background: 'var(--bg-2, rgba(255,255,255,0.045))',
  border: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
  borderRadius: 6,
};

const ENUM_TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 10.5,
  color: 'var(--fg-mute, #7f9bb4)',
};

const ENUM_OPTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
};

const ENUM_COUNT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--fg-mute, #7f9bb4)',
  fontVariantNumeric: 'tabular-nums',
};

/** Frost-styled bare number input (bare <input> doesn't inherit the theme). */
const NUMBER_INPUT_STYLE: CSSProperties = {
  width: 70,
  padding: '4px 7px',
  fontSize: 12,
  fontFamily: 'inherit',
  color: 'var(--fg, #e7f7ff)',
  background: 'var(--bg-2, rgba(255,255,255,0.045))',
  border: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
  borderRadius: 6,
};

function asString(v: ColumnFilterValue | undefined): string {
  return typeof v === 'string' ? v : '';
}
function asArray(v: ColumnFilterValue | undefined): string[] {
  return Array.isArray(v) ? v : [];
}
function asNumberValue(v: ColumnFilterValue | undefined): NumberFilterValue {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as NumberFilterValue) : {};
}
function asBool(v: ColumnFilterValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function FilterEditor<TRow>({
  col,
  controller,
  onClose,
}: {
  col: FilterableColumn<TRow>;
  controller: ColumnFilterController<TRow>;
  /** Commit + close the editor — bound to Enter in the text/number inputs. The
   *  value is already saved live via setValue, so this just dismisses the box. */
  onClose: () => void;
}) {
  // Local, render-only search text for the enum checklist (long fixed-set
  // columns). Declared unconditionally (hooks-first); the editor is remounted
  // per column via `key`, so this resets when you switch columns.
  const [enumQuery, setEnumQuery] = useState('');
  const spec = col.filter;
  if (!spec) return null;
  const value = controller.valueFor(col.key);

  // Text + number editors save live as you type; Enter just closes the box.
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onClose();
    }
  };

  if (spec.type === 'text') {
    return (
      <input
        type="text"
        className="pc-advpanel__input"
        autoFocus
        value={asString(value)}
        onChange={(e) => controller.setValue(col.key, e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={`Filter ${headerText(col as FilterableColumn<unknown>)}…`}
        aria-label={`Filter ${headerText(col as FilterableColumn<unknown>)}`}
        style={{ width: '100%' }}
      />
    );
  }

  if (spec.type === 'enum') {
    const options = controller.optionsFor(col.key);
    const selected = asArray(value);
    const multi = spec.multi !== false;
    const toggle = (optValue: string, on: boolean) => {
      if (!multi) {
        controller.setValue(col.key, on ? [optValue] : []);
        return;
      }
      const next = on
        ? [...selected, optValue]
        : selected.filter((s) => s !== optValue);
      controller.setValue(col.key, next);
    };

    // Long lists grow a search box (type-to-narrow over label/value). The
    // checklist below it still shows the full SELECTABLE set — search only
    // narrows what's visible, never what's selectable.
    const showSearch = options.length > ENUM_SEARCH_THRESHOLD;
    const q = enumQuery.trim().toLowerCase();
    const visible = q
      ? options.filter((o) => (o.label ?? o.value).toLowerCase().includes(q))
      : options;
    const colLabel = headerText(col as FilterableColumn<unknown>);
    const countScope = countEvidenceScopeText(controller.countEvidence);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {showSearch ? (
          <input
            type="text"
            className="pc-advpanel__input"
            autoFocus
            value={enumQuery}
            onChange={(e) => setEnumQuery(e.target.value)}
            placeholder={`Search ${colLabel}…`}
            aria-label={`Search ${colLabel} options`}
            style={ENUM_SEARCH_INPUT_STYLE}
          />
        ) : null}
        {showSearch && selected.length > 0 ? (
          <div style={ENUM_TOOLBAR_STYLE}>
            <span>{selected.length} selected</span>
            <button
              type="button"
              className="pc-advpanel__chip"
              style={{ marginLeft: 'auto', fontSize: 10.5 }}
              onClick={() => controller.setValue(col.key, [])}
            >
              Clear selection
            </button>
          </div>
        ) : null}
        <div style={ENUM_LIST_STYLE}>
          {options.length === 0 ? (
            <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>No values</span>
          ) : visible.length === 0 ? (
            <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>No matches</span>
          ) : (
            visible.map((opt) => {
              const on = selected.includes(opt.value);
              return (
                <label key={opt.value} style={ENUM_OPTION_STYLE}>
                  <Checkbox
                    checked={on}
                    onChange={(c) => toggle(opt.value, c)}
                    ariaLabel={`${opt.label ?? opt.value}: ${formatCountNumber(opt.count)} in ${countScope}`}
                  />
                  <span>{opt.label ?? opt.value}</span>
                  <span
                    style={ENUM_COUNT_STYLE}
                    aria-label={`${formatCountNumber(opt.count)} in ${countScope}`}
                  >
                    {formatCountNumber(opt.count)}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>
    );
  }

  if (spec.type === 'number') {
    const range = asNumberValue(value);
    const setBound = (bound: 'min' | 'max', raw: string) => {
      const next: NumberFilterValue = { ...range };
      if (raw === '') delete next[bound];
      else {
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        next[bound] = n;
      }
      controller.setValue(col.key, next);
    };
    return (
      <div style={NUMBER_ROW_STYLE}>
        <input
          type="number"
          style={NUMBER_INPUT_STYLE}
          value={range.min ?? ''}
          onChange={(e) => setBound('min', e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="min"
          aria-label={`${headerText(col as FilterableColumn<unknown>)} minimum`}
        />
        <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>–</span>
        <input
          type="number"
          style={NUMBER_INPUT_STYLE}
          value={range.max ?? ''}
          onChange={(e) => setBound('max', e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="max"
          aria-label={`${headerText(col as FilterableColumn<unknown>)} maximum`}
        />
      </div>
    );
  }

  // boolean
  const current = asBool(value);
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {[
        { label: 'True', val: true },
        { label: 'False', val: false },
      ].map((opt) => (
        <button
          key={opt.label}
          type="button"
          className="pc-advpanel__chip"
          aria-pressed={current === opt.val}
          onClick={() => controller.setValue(col.key, opt.val)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * memo()'d deliberately (P-BUG-WI-37386): every caller (DepGraphPanel,
 * WorkItemsPanel) already returns a stably-memoized `controller`/`activeChips`/
 * `hasActive`/`clearAll` from `useColumnFilters` when the underlying filter
 * state hasn't changed — but WITHOUT memo() here, React re-renders this whole
 * subtree on every parent re-render regardless of prop stability (that's just
 * how React works for a plain function component), including parent re-renders
 * driven by something totally unrelated to filters (DepGraphPanel's ResizeObserver-
 * driven canvasW/zoom/scale state, for instance).
 *
 * That mattered because of a Radix landmine: `@radix-ui/react-slot`'s
 * SlotClone recomposes each Tooltip/Select trigger's ref UNMEMOIZED on every
 * render (`props2.ref = composeRefs(forwardedRef, childrenRef)`, called fresh
 * in the render body — see node_modules/@radix-ui/react-slot/dist/index.mjs).
 * Tooltip/SelectTrigger's own composed ref chain ends in an UNGUARDED
 * `context.onTriggerChange = setTrigger` (a raw useState setter with no
 * null-guard, unlike our own Popover.tsx's `anchorRef` callback which DOES
 * guard `if (!node) return`). A high enough re-render CADENCE of this bar's
 * Tooltip-wrapped picker-chip buttons (verified live: DepGraphPanel's own
 * ResizeObserver settling is enough, no external driver needed — reproduces
 * within seconds of mounting the harnesses dock) pushes that unguarded
 * detach/attach churn past React's nested-update ceiling: "Maximum update
 * depth exceeded", crashing the panel's error boundary (WI-37386).
 *
 * memo() here breaks the fuel supply at its true source — this bar re-renders
 * only when ITS OWN (already-stable) props actually change, independent of
 * how often the parent re-renders for unrelated reasons.
 *
 * The durable guard for the Radix half is `patches/@radix-ui+react-slot+1.2.3.patch`,
 * NOT a test — this comment used to cite a `ColumnFilterBar.crash-regression.test.tsx`
 * that does not exist anywhere in the repo (checked repo-wide, WI-39552), which reads
 * as "the memo() is test-guarded" when it is not.
 *
 * Your half of the contract: keep `controller`/`activeChips`/`hasActive`/`clearAll`
 * genuinely stable at every call site — `useColumnFilters`'s own `cols`/`rows` args
 * must not be fresh literals per render. memo() only helps if its inputs actually hold
 * still, and both callers have since been caught violating exactly that (WI-39552:
 * DepGraphPanel's `visibleItems` ran a real render loop, WorkItemsPanel passed a bare
 * `items ?? []`).
 */
function ColumnFilterBarImpl<TRow>({
  controller,
  activeChips,
  hasActive,
  clearAll,
  layout = 'compact',
  inlineMax = 8,
  promote,
}: {
  controller: ColumnFilterController<TRow>;
  activeChips: { colKey: string; label: string; clear: () => void }[];
  hasActive: boolean;
  clearAll: () => void;
  /**
   * 'compact' (default): the original single row — active-filter chips + one
   *  `+Add filter…` Select. Space-frugal; used by the wide dock panels.
   * 'facets': every filterable column is ALWAYS visible as a labeled group of
   *  value chips with live counts (QueueFilterBar-style), so the filters read
   *  as filters at a glance. An enum column with ≤ `inlineMax` options renders
   *  its values inline as toggle chips; a higher-cardinality (or non-enum)
   *  column renders one picker-chip that opens the same popover editor.
   */
  layout?: 'compact' | 'facets';
  /** In 'facets' layout, the max enum options rendered inline before a column
   *  collapses to a picker-chip (default 8, mirroring ENUM_SEARCH_THRESHOLD). */
  inlineMax?: number;
  /**
   * Column keys ALWAYS shown in 'compact' layout as a visible, labelled picker-chip,
   * even when inactive — i.e. promoted out of the `+Add filter…` dropdown into a
   * first-class axis, without paying for the full 'facets' bar.
   *
   * WHY THIS EXISTS rather than "just use layout='facets'" (dep-graph-design-pass-2
   * P-002): facets renders EVERY filterable column as a group. On the dependency-graph
   * pane that is ten groups competing with the pane's own six status chips, and the one
   * column that actually needed promoting — Plan — has more options than `inlineMax`,
   * so facets would collapse it to a picker-chip anyway. The bar would get materially
   * busier and the target axis would look exactly the same. Promotion is the smaller,
   * more precise instrument: one axis becomes visible, the rest stay in the dropdown.
   *
   * Ignored in 'facets' layout, where every column is visible by construction.
   */
  promote?: readonly string[];
}) {
  // Gate the WHOLE bar behind the flag — when off, render nothing (the panel
  // still lists unfiltered rows). Hook order is stable: useFlag + useState run
  // unconditionally, the early return is below them.
  const enabled = useFlag(FLAGS.GRID_COLUMN_FILTERS);
  // Which column's editor popover is open. Transient render-only UI state — the
  // filter VALUES live in nuqs (via the controller); this is just the open flag.
  const [editingKey, setEditingKey] = useState<string | null>(null);

  if (!enabled) return null;

  const activeKeys = new Set(activeChips.map((c) => c.colKey));
  const addable = controller.filterableColumns.filter((c) => !activeKeys.has(c.key));
  const editingCol = controller.filterableColumns.find((c) => c.key === editingKey) ?? null;
  // Active-filter label per column (for the facets picker-chip summary).
  const chipLabelByKey = new Map(activeChips.map((c) => [c.colKey, c.label]));
  const countScope = countEvidenceScopeText(controller.countEvidence);

  // Open an editor on a fresh MACROTASK, never synchronously inside the click
  // gesture that requested it — whether that's the Add-filter Select closing OR
  // a chip button click. That gesture dispatches trailing pointerup/focusout
  // events; mounting the editor Popover in the same tick lets its dismissable
  // layer catch one as an "outside" interaction and dismiss it instantly.
  // requestAnimationFrame is NOT enough (it runs before paint, same task tail);
  // setTimeout(0) is a macrotask that runs after those events drain. See
  // agent-insights/radix-popover-from-select-dismiss-race +
  // e2e/adv-work-items-filter.spec.ts.
  const openEditor = (key: string) => {
    setTimeout(() => setEditingKey(key), 0);
  };

  // Toggle one enum VALUE for a column (the facets inline chips). Multi-select
  // unless the column declares `multi: false`.
  const toggleEnumValue = (colKey: string, value: string, on: boolean, multi: boolean) => {
    const cur = asArray(controller.valueFor(colKey));
    if (!multi) {
      controller.setValue(colKey, on ? [value] : []);
      return;
    }
    controller.setValue(colKey, on ? [...cur, value] : cur.filter((v) => v !== value));
  };

  // One Popover, anchored to a 0-size sentinel, opened for the column being
  // edited. Shared by BOTH layouts (compact chips/Select + facets picker-chips).
  const editorPopover = (
    <Popover
      open={editingCol != null}
      onOpenChange={(open) => {
        if (!open) setEditingKey(null);
      }}
      trigger={<span aria-hidden style={{ width: 0, height: 0 }} />}
      side="bottom"
      align="start"
      ariaLabel={editingCol ? `Edit ${headerText(editingCol as FilterableColumn<unknown>)} filter` : 'Edit filter'}
      autoFocusOnOpen
      contentStyle={EDITOR_STYLE}
    >
      {editingCol ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={EDITOR_HEADING_STYLE}>{headerText(editingCol as FilterableColumn<unknown>)}</span>
            <button
              type="button"
              className="pc-advpanel__iconbtn"
              style={{ marginLeft: 'auto', width: 22, height: 22 }}
              aria-label="Close filter editor"
              onClick={() => setEditingKey(null)}
            >
              <X size={12} />
            </button>
          </div>
          <FilterEditor key={editingCol.key} col={editingCol} controller={controller} onClose={() => setEditingKey(null)} />
        </>
      ) : null}
    </Popover>
  );

  if (layout === 'facets') {
    return (
      <div
        className="pc-advpanel__filterbar pc-advpanel__filterbar--facets"
        data-count-evidence={controller.countEvidence.kind}
      >
        <span className="pc-sr-only">Filter option counts cover {countScope}.</span>
        {controller.filterableColumns.map((col) => {
          const spec = col.filter;
          const isEnum = spec?.type === 'enum';
          const selected = asArray(controller.valueFor(col.key));
          const options = isEnum ? controller.optionsFor(col.key) : [];
          const label = headerText(col as FilterableColumn<unknown>);
          // Bounded enum ⇒ inline value chips with counts.
          if (isEnum && options.length > 0 && options.length <= inlineMax) {
            const multi = spec?.type === 'enum' ? spec.multi !== false : true;
            return (
              <div key={col.key} className="pc-advpanel__facetgroup">
                <span className="pc-advpanel__facetlabel">{label}</span>
                {options.map((opt) => {
                  const on = selected.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className="pc-advpanel__chip"
                      aria-pressed={on}
                      aria-label={`${label} ${opt.label ?? opt.value}: ${formatCountNumber(opt.count)} in ${countScope}`}
                      onClick={() => toggleEnumValue(col.key, opt.value, !on, multi)}
                    >
                      <span>{opt.label ?? opt.value}</span>
                      <span className="pc-advpanel__chipcount" aria-hidden>
                        {formatCountNumber(opt.count)}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          }
          // High-cardinality enum / text / number / boolean ⇒ one picker-chip
          // that opens the shared popover editor.
          const active = activeKeys.has(col.key);
          return (
            <Tooltip key={col.key} label={active ? 'Edit filter' : `Filter by ${label}`}>
              <button
                type="button"
                className="pc-advpanel__chip"
                aria-pressed={active}
                onClick={() => openEditor(col.key)}
              >
                {active ? (chipLabelByKey.get(col.key) ?? label) : label}
                <ChevronDown size={11} aria-hidden />
              </button>
            </Tooltip>
          );
        })}

        {hasActive ? (
          <button type="button" className="pc-advpanel__chip" onClick={clearAll}>
            Clear all
          </button>
        ) : null}

        {editorPopover}
      </div>
    );
  }

  // Promoted-but-inactive columns get their own visible chip below, so they must NOT
  // also appear in the Add-filter dropdown — one axis, one control. An ACTIVE promoted
  // column is already rendered by `activeChips`, so it is excluded from both.
  const promotedKeys = new Set(promote ?? []);
  const promotedInactive = controller.filterableColumns.filter(
    (c) => promotedKeys.has(c.key) && !activeKeys.has(c.key),
  );
  const promotedInactiveKeys = new Set(promotedInactive.map((c) => c.key));

  const addOptions = [
    { value: ADD_FILTER, label: 'Add filter…', disabled: true },
    ...addable
      .filter((c) => !promotedInactiveKeys.has(c.key))
      .map((c) => ({
        value: c.key,
        label: headerText(c as FilterableColumn<unknown>),
      })),
  ];

  return (
    <div className="pc-advpanel__filterbar" data-count-evidence={controller.countEvidence.kind}>
      <span className="pc-sr-only">Filter option counts cover {countScope}.</span>
      <ListFilter size={13} aria-hidden style={{ color: 'var(--fg-mute, #7f9bb4)', flexShrink: 0 }} />

      {/*
        PROMOTED AXES (dep-graph-design-pass-2 P-002) — rendered FIRST, before the active
        chips, so a promoted axis holds a stable position instead of jumping as other
        filters come and go. Same picker-chip and same shared editor popover the facets
        layout uses for a high-cardinality column; the only difference is that this one
        is visible while inactive, which is the entire point — an axis nobody knows is
        filterable is not a filter.
      */}
      {promotedInactive.map((col) => {
        const label = headerText(col as FilterableColumn<unknown>);
        return (
          <Tooltip key={col.key} label={`Filter by ${label}`}>
            <button
              type="button"
              className="pc-advpanel__chip"
              aria-pressed={false}
              onClick={() => openEditor(col.key)}
            >
              {label}
              <ChevronDown size={11} aria-hidden />
            </button>
          </Tooltip>
        );
      })}

      {activeChips.map((chip) => (
        <Tooltip key={chip.colKey} label="Edit filter"><button

          type="button"
          className="pc-advpanel__chip"
          aria-pressed
          onClick={() => openEditor(chip.colKey)}

        >
          {chip.label}
          <X
            size={11}
            aria-label={`Remove ${chip.label} filter`}
            onClick={(e) => {
              e.stopPropagation();
              if (editingKey === chip.colKey) setEditingKey(null);
              chip.clear();
            }}
          />
        </button></Tooltip>
      ))}

      {addable.length > 0 ? (
        <Select
          value={ADD_FILTER}
          onChange={(key) => {
            if (key !== ADD_FILTER) openEditor(key);
          }}
          ariaLabel="Add a column filter"
          triggerClassName="pc-advpanel__chip"
          options={addOptions}
        />
      ) : null}

      {hasActive ? (
        <button type="button" className="pc-advpanel__chip" onClick={clearAll}>
          Clear all
        </button>
      ) : null}

      {editorPopover}
    </div>
  );
}

export const ColumnFilterBar = memo(ColumnFilterBarImpl) as typeof ColumnFilterBarImpl;
