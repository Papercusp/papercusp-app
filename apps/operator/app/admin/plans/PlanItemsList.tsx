'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation (presentational).
 *
 * Renders the items it's handed, already filtered by PlansClient via the
 * additive filter model: item-status (Needs Human / Needs Decision /
 * Blocked, OR within) AND plan-status buckets (OR within). The list is
 * therefore mixed-status, so per-item affordances key off each item's own
 * status (needs-human items get the Answer/Resolve/Drop toolkit).
 *
 * `planFilter` narrows the displayed groups to one plan (the left rail
 * sets it). Plans are collapsible groups; a row selects the item (via the
 * `?item=` param) into the shared TwoPaneShell detail pane that PlansClient
 * renders alongside this list, rather than navigating away.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { type PlanItemRow, type PlanBucket } from './plans-api';
import { AuthorBadge } from '../../_components/AuthorBadge';
import AssignDialog from './AssignDialog';
import { Tooltip } from '@/app/harness/Tooltip';

interface Props {
  items: PlanItemRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** plan-slug → harness-slug map; lets needs-human rows relaunch the loop. */
  harnessByPlan?: Map<string, string>;
  /** plan-slug → display title + lifecycle bucket, for the group headers.
   *  Headers show the human title + a ready/running pill instead of the slug. */
  planMeta?: Map<string, { title?: string | null; bucket: PlanBucket }>;
  /** Narrow the list to these plans (multi-select OR; the rail toggles
   *  them). Empty/undefined = all plans. */
  planFilters?: string[];
  /** Section heading for the list column. */
  title: string;
}

// The items view groups by EFFECTIVE status, so the row pill surfaces that
// (not stored) — otherwise a blocked item (stored 'todo', effective 'blocked')
// would show a "todo" pill instead of "blocked".
function itemPillStatus(item: { effectiveStatus: string }): string {
  return item.effectiveStatus;
}

export default function PlanItemsList({
  items,
  loading,
  error,
  refresh,
  harnessByPlan,
  planMeta,
  planFilters,
  title,
}: Props) {
  // A single selected plan renders "bare" (no repeated title); multiple
  // selected (or none) render grouped with plan headers.
  const planList = planFilters ?? [];
  const planFiltersKey = planList.join('|');
  const bareSingle = planList.length === 1 ? planList[0]! : null;
  // Selected item for the read-only detail pane, encoded
  // "<planSlug>::<itemId>". Distinct from PlansClient's `?plan=` (which
  // opens the FULL PlanDetail) — this only drives the right-hand preview.
  const [selectedItem, setSelectedItem] = useQueryState('item', parseAsString);
  // Inbox shares one preview pane across the Other + item lists; selecting an
  // item here clears any Other selection so the shared pane shows this item.
  const [, setOtherSel] = useQueryState('other', parseAsString);
  const selectItem = (key: string) => {
    void setSelectedItem(key);
    void setOtherSel(null);
  };
  // Expanded plan groups (Radix Collapsible), URL-pinned like Sessions.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  const [selectedPlan, selectedItemId] = splitItemKey(selectedItem);

  // Auto-expand the selected item's group (mirrors the Sessions tab). The
  // ref token stops us reopening a group the user just collapsed while the
  // selection stays put.
  const autoExpandRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPlan || !selectedItemId || planList.length > 0) {
      autoExpandRef.current = null;
      return;
    }
    const token = `${selectedItemId}:${selectedPlan}`;
    if (expandedGroups.includes(selectedPlan)) {
      autoExpandRef.current = token;
      return;
    }
    if (autoExpandRef.current === token) return;
    autoExpandRef.current = token;
    void setExpandedGroups([...expandedGroups, selectedPlan]);
  }, [selectedPlan, selectedItemId, planFiltersKey, expandedGroups, setExpandedGroups]);

  // This list is one section of the shared TwoPaneShell's left column (the
  // selected item's preview lives in the shell's detail slot, owned by
  // PlansClient), so it renders just its heading + rows.
  const wrap = (inner: ReactNode) => (
    <section className="pc-items__section">
      <h3 className="pc-items__section-label">{title}</h3>
      {inner}
    </section>
  );

  if (loading) {
    return wrap(<p className="pc-plans__placeholder">Loading…</p>);
  }
  if (error) {
    return wrap(
      <div className="pc-plans__placeholder pc-plans__placeholder--error">
        <p>Failed to load items:</p>
        <code>{error}</code>
        <button type="button" className="pc-plans__retry" onClick={refresh}>
          Retry
        </button>
      </div>,
    );
  }

  const rows = planList.length ? items.filter((r) => planList.includes(r.plan)) : items;
  if (!rows.length) {
    const empty = bareSingle
      ? `No items in ${bareSingle}.`
      : planList.length
        ? 'No items in the selected plans.'
        : 'No items match the current filters.';
    return wrap(<div className="pc-items__empty">{empty}</div>);
  }

  // Group by parent plan; Map preserves insertion order, which is the
  // server's ordering (active plans tend to appear before archived).
  const groups = new Map<string, PlanItemRow[]>();
  for (const r of rows) {
    if (!groups.has(r.plan)) groups.set(r.plan, []);
    groups.get(r.plan)!.push(r);
  }

  // The rows for one plan — shared by the bare (rail-filtered) and the
  // collapsible group renders. Clicking a row selects it into the detail
  // pane; it no longer redirects to the full plan tab. Per-item actions
  // key off the item's own status, since the list is mixed-status.
  // Rows are plain selectable buttons. The per-item actions (Answer /
  // Resolve / Drop for needs-human, Chat with agent) live in the shared
  // detail pane's toolbar — rendering them inline in the row broke the
  // layout and crowded the answer textarea.
  const renderRows = (planSlug: string, planRows: PlanItemRow[]) => (
    <ul className="pc-items__rows" role="list">
      {planRows.map((r) => {
        const isSel = selectedItem === itemKey(planSlug, r.item.id);
        return (
          <li key={r.item.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
            <Tooltip label={r.item.text}><button
              type="button"
              className="pc-items__row"
              aria-current={isSel ? 'true' : undefined}

              onClick={() => selectItem(itemKey(planSlug, r.item.id))}
            >
              {/* Free-form text first (leftmost); id + status + importance
                  pills follow on the right. */}
              <span className="pc-items__text">{r.item.text}</span>
              <span className="pc-items__rowmeta">
                <span className="pc-items__id">{r.item.id}</span>
                <span className={`pc-count pc-count--${itemPillStatus(r.item)}`}>
                  {itemPillStatus(r.item)}
                </span>
                {r.item.importance && r.item.importance !== 'normal' ? (
                  <span
                    className={`pc-imp pc-imp--${r.item.importance}`}
                    title={`Importance: ${r.item.importance}`}
                  >
                    {r.item.importance}
                  </span>
                ) : null}
                {/* B1 (P-001): per-item author — renders only when a real per-op
                    author pubkey has federated (dark on a single box). */}
                {r.item.lastEditedBy ? (
                  <AuthorBadge identity={r.item.lastEditedBy} variant="compact" prefix="by" />
                ) : null}
              </span>
            </button></Tooltip>
            {/* P-008: per-item cross-user assign — sibling of the row button
                (can't nest a button). Compact, hover-revealed via CSS. */}
            <span className="pc-items__row-actions">
              <AssignDialog planSlug={planSlug} itemRef={r.item.id} compact />
            </span>
          </li>
        );
      })}
    </ul>
  );

  const groupsEl = (
    <ul className="pc-items__groups" role="list">
      {[...groups.entries()].map(([planSlug, planRows]) => {
              const harnessSlug = harnessByPlan?.get(planSlug);
              // When the left rail has filtered to one plan, don't repeat
              // its title here — render the items bare (the plan name is
              // already shown, selected, in the rail).
              if (bareSingle) {
                return (
                  <li key={planSlug} className="pc-items__group pc-items__group--bare">
                    {renderRows(planSlug, planRows)}
                  </li>
                );
              }
              const isExpanded = expandedGroups.includes(planSlug);
              const meta = planMeta?.get(planSlug);
              const planTitle = meta?.title?.trim() || planSlug;
              const bucket = meta?.bucket;
              return (
                <li key={planSlug} className="pc-items__group">
                  <Collapsible.Root
                    open={isExpanded}
                    onOpenChange={(open) =>
                      void setExpandedGroups(
                        open
                          ? Array.from(new Set([...expandedGroups, planSlug]))
                          : expandedGroups.filter((k) => k !== planSlug),
                      )
                    }
                  >
                    <Collapsible.Trigger asChild>
                      <button type="button" className="pc-items__plan-head">
                        <ChevronRight className="pc-items__group-chevron" size={13} aria-hidden />
                        <span className="pc-items__plan-copy">
                          <Tooltip label={planSlug}>
                            <span className="pc-items__plan-name">{planTitle}</span>
                          </Tooltip>
                          {bucket || harnessSlug ? (
                            <span className="pc-items__plan-meta">
                              {bucket ? (
                                <span className={`pc-pill pc-pill--bucket-${bucket}`}>{bucket}</span>
                              ) : null}
                              {harnessSlug ? (
                                <span className="pc-pill pc-pill--harness">{harnessSlug}</span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        <span className="pc-items__plan-count">{itemCountLabel(planRows.length)}</span>
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content className="pc-items__group-content">
                      {renderRows(planSlug, planRows)}
                    </Collapsible.Content>
                  </Collapsible.Root>
                </li>
              );
      })}
    </ul>
  );

  // List-only now: the selected item's preview lives in the shared
  // TwoPaneShell's detail slot (owned by PlansClient), not inside this list.
  return wrap(groupsEl);
}

/** Encode / decode the `?item=` selection key ("<planSlug>::<itemId>"). */
function itemKey(planSlug: string, itemId: string): string {
  return `${planSlug}::${itemId}`;
}
function splitItemKey(key: string | null): readonly [string | null, string | null] {
  if (!key) return [null, null];
  const idx = key.indexOf('::');
  if (idx === -1) return [null, null];
  return [key.slice(0, idx), key.slice(idx + 2)];
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
