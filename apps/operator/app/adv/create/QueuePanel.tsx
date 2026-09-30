'use client';

/**
 * create:queue dock panel — the cross-plan item Queue.
 *
 * Parity with PlansClient's "Queue" view (queue-authorization-redesign-2026-06-14):
 *   - A1 (P-004/P-005): the "Other" attention list groups by AUTHORIZER —
 *     "Needs your call" / "Automatable — for now" / "Alerts" — with a per-card
 *     why-line + category badge, behind the QUEUE_AUTHORIZATION_VIEW flag
 *     (PlanOtherList renders all of this when `groupByAuthorizer` is set; the
 *     `?qcat` category facet lives inside it too).
 *   - B1 (P-006): a Needs Decision | Queen's-log segmented control + the two-halves
 *     QueueSummary strip, reusing the shared <DecisionLog/> for the log.
 *
 * The redesign originally landed in PlansClient only; this panel is the surface
 * the /adv Create tab actually renders, so it carries the same wiring. Data and
 * selection (?item / ?other) come from the shared hooks / list components.
 */

import { useMemo } from 'react';
import { parseAsArrayOf, parseAsBoolean, parseAsStringEnum, useQueryState } from 'nuqs';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { useLexicon } from '@/lib/useLexicon';
import { Tooltip } from '@/app/harness/Tooltip';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanItemsList from '@/app/admin/plans/PlanItemsList';
import PlanOtherList from '@/app/admin/plans/PlanOtherList';
import QueueFilterBar from '@/app/admin/plans/QueueFilterBar';
import QueueSummary from '@/app/admin/plans/QueueSummary';
import { queueTabs, queenLogLayers } from '@/app/admin/plans/queue-authorizer';
import type { AttentionKind } from '@/app/admin/plans/plans-api';
import DecisionLog from '@/app/_components/DecisionLog';
import {
  useCreateScope,
  usePlanListMaps,
  useQueueData,
  useItemStatusFilter,
  usePlanBucketFilter,
  useItemPlanFilter,
  ITEM_FILTERS,
  ITEM_FILTER_LABEL,
  resolveLex,
  type ItemStatusFilter,
} from './use-create-data';

const QUEUE_KIND_IDS = [
  'coord-escalation',
  'coord-message',
  'smoke-fail',
  'operator-report',
  'improvement',
  'standing-approval',
  'conversation',
  'scout-grade',
] as const satisfies readonly AttentionKind[];

export default function QueuePanel(_props?: Partial<PanelComponentProps>) {
  const t = useLexicon();
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [istatus, setIstatus] = useItemStatusFilter();
  const [pBuckets] = usePlanBucketFilter();
  const [itemPlans] = useItemPlanFilter();

  // A1 authorizer-split + B1 tabs are flag-gated (default-ON). OFF = the legacy
  // plan/harness grouping and no Queen's-log tab.
  const queueAuthzView = useFlag(FLAGS.QUEUE_AUTHORIZATION_VIEW);
  const [queueTab, setQueueTab] = useQueryState(
    'queueTab',
    parseAsStringEnum<'pending' | 'queen-log'>(['pending', 'queen-log']).withDefault('pending'),
  );
  const [qlLayer, setQlLayer] = useQueryState(
    'qlLayer',
    parseAsStringEnum<'disposition' | 'action'>(['disposition', 'action']).withDefault('disposition'),
  );
  const [queueKinds, setQueueKinds] = useQueryState(
    'qKinds',
    parseAsArrayOf(parseAsStringEnum<AttentionKind>([...QUEUE_KIND_IDS])).withDefault([]),
  );
  const [qTodos, setQTodos] = useQueryState('qTodos', parseAsBoolean.withDefault(false));
  const [qBlocked, setQBlocked] = useQueryState('qBlocked', parseAsBoolean.withDefault(false));
  const [qFilterOpen, setQFilterOpen] = useQueryState('qFilter', parseAsBoolean.withDefault(false));

  const queueStatusFilters = useMemo<ItemStatusFilter[]>(
    () =>
      queueAuthzView
        ? // Single authorizer list: needs-human plan-items render in PlanOtherList's
          // "Needs you" bucket (includePlanItems), so PlanItemsList carries ONLY the
          // opt-in backlog (todos/blocked) — not needs-human (else double-shown).
          [...(qTodos ? ['todo' as const] : []), ...(qBlocked ? ['blocked' as const] : [])]
        : istatus,
    [queueAuthzView, qTodos, qBlocked, istatus],
  );

  const queue = useQueueData({
    istatus: queueStatusFilters,
    pBuckets,
    planBucketBySlug: maps.planBucketBySlug,
    scope,
  });

  const toggleItemStatus = (id: ItemStatusFilter) =>
    void setIstatus(istatus.includes(id) ? istatus.filter((x) => x !== id) : [...istatus, id]);
  const toggleQueueKind = (kind: AttentionKind) =>
    void setQueueKinds(queueKinds.includes(kind) ? queueKinds.filter((x) => x !== kind) : [...queueKinds, kind]);

  const itemTitle = queueAuthzView
    ? 'Backlog — pickable work'
    : istatus.length
      ? istatus.map((s) => resolveLex(ITEM_FILTER_LABEL[s], t)).join(' · ')
      : 'All items';

  const showQueenLog = queueAuthzView && queueTab === 'queen-log';
  const showOther = queueAuthzView || queue.showOther;
  // In the authorizer view the unified list owns needs-human; PlanItemsList only
  // appears for the opt-in backlog (todos/blocked toggled in the Filter).
  const showPlanItems = queueAuthzView ? qTodos || qBlocked : queue.showPlanItems;

  return (
    <div className="pc-queue__list" style={{ height: '100%', overflow: 'auto' }}>
      {/* B1 (P-006): two-halves summary + Needs Decision|Queen's-log tabs (flag-gated). */}
      {queueAuthzView ? (
        <div className="pc-queue__masthead">
          <QueueSummary waitingOnYou={queue.tierCounts.decision} />
          <nav className="pc-queue__tabs" aria-label="Queue tab">
            {queueTabs(t).map((tb) => (
              <Tooltip key={tb.id} label={tb.hint} side="bottom">
                <button
                  type="button"
                  className={`pc-queue__tab${queueTab === tb.id ? ' is-active' : ''}`}
                  aria-pressed={queueTab === tb.id}
                  onClick={() => void setQueueTab(tb.id)}
                >
                  {tb.label}
                </button>
              </Tooltip>
            ))}
          </nav>
        </div>
      ) : null}

      {showQueenLog ? (
        <section className="pc-queue__queenlog" aria-label={`${t('brain')}'s decision log`}>
          <nav className="pc-queue__tabs pc-queue__layer-toggle" aria-label="Decision log layer">
            {queenLogLayers(t).map((l) => (
              <Tooltip key={l.id} label={l.hint} side="bottom">
                <button
                  type="button"
                  className={`pc-queue__tab${qlLayer === l.id ? ' is-active' : ''}`}
                  aria-pressed={qlLayer === l.id}
                  onClick={() => void setQlLayer(l.id)}
                >
                  {l.label}
                </button>
              </Tooltip>
            ))}
          </nav>
          <DecisionLog
            layer={qlLayer}
            limit={50}
            title={qlLayer === 'disposition' ? `What the ${t('brain')} decided` : 'Governed actions (audit)'}
            description={
              qlLayer === 'disposition'
                ? `Every item the ${t('brain')} considered and what it chose — act, defer, reject, route, or no-op. Newest first.`
                : 'Every governed action that ran, auto or gated — the full audit trail. Newest first.'
            }
            emptyText={`No decisions logged yet. As the ${t('brain')} considers items, they appear here.`}
            externalDetail
          />
        </section>
      ) : (
        <>
          {queueAuthzView ? (
            <QueueFilterBar
              kinds={queueKinds}
              onToggleKind={toggleQueueKind}
              counts={queue.itemStatusCounts}
              showTodos={qTodos}
              showBlocked={qBlocked}
              onToggleTodos={() => void setQTodos(!qTodos)}
              onToggleBlocked={() => void setQBlocked(!qBlocked)}
              todoCount={queue.itemStatusCounts.todo ?? 0}
              blockedCount={queue.itemStatusCounts.blocked ?? 0}
              open={qFilterOpen}
              onOpenChange={(open) => void setQFilterOpen(open)}
            />
          ) : (
            <nav className="pc-queue__filters" aria-label="Queue item filters">
              {ITEM_FILTERS.map((f) => {
                const active = istatus.includes(f.id);
                return (
                  <Tooltip key={f.id} label={resolveLex(f.hint, t)} side="bottom">
                    <button
                      type="button"
                      className={`pc-queue__filter pc-plans__view--${f.id} ${active ? 'is-active' : ''}`}
                      aria-pressed={active}
                      onClick={() => toggleItemStatus(f.id)}
                    >
                      <span className="pc-queue__filter-label">{resolveLex(f.label, t)}</span>
                      <span className="pc-queue__filter-count">
                        {queue.loading ? '…' : queue.itemStatusCounts[f.id]}
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </nav>
          )}
          <div className="pc-items__listpane">
            {showOther ? (
              <PlanOtherList
                groups={queue.otherGroups}
                loading={queue.attentionRaw.loading}
                error={queue.attentionRaw.error}
                refresh={queue.attentionRaw.refresh}
                title={queueAuthzView ? 'Needs Decision' : 'Other'}
                kinds={queueAuthzView ? queueKinds : queue.otherFacets}
                planFilters={itemPlans}
                groupByAuthorizer={queueAuthzView}
                includePlanItems={queueAuthzView}
                hasMore={queue.attentionRaw.hasMore}
                loadingMore={queue.attentionRaw.loadingMore}
                loadMore={queue.attentionRaw.loadMore}
                totalCount={queue.attentionRaw.totalItemCount}
                loadedCount={queue.attentionRaw.loadedItemCount}
              />
            ) : null}
            {showPlanItems ? (
              <PlanItemsList
                items={queue.filteredItems}
                loading={queue.loading}
                error={queue.error}
                refresh={queue.refresh}
                harnessByPlan={maps.harnessByPlan}
                planMeta={maps.planMetaBySlug}
                planFilters={itemPlans}
                title={itemTitle}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
