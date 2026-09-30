'use client';

/**
 * WorkItemPopupModal (chat-ref-pills-2026-07-26 P-008) — a clicked WI-/EI-/F-
 * ref pill in chat opens AS A POPUP instead of navigating the Working tab.
 * This is the D-002 seam: PapercupChat (P-004) exposes a plain
 * `onWorkRefActivate` passthrough with no destination logic of its own;
 * OperatorChat wires THIS component into that hook (D-001, owner re-spec
 * 2026-07-26 — supersedes the retired `resolveWorkingTabDrillIn` destination,
 * P-009). Reuses the P-002 ref -> live-item RESOLUTION unchanged (the ref
 * string IS the id `workItems.detail` reads); only the destination is new.
 *
 * Mirrors app/_components/plans/PlanPopupModal.tsx exactly in shape — Modal
 * (app/harness/Modal.tsx) + the EXISTING `WorkItemDetail` body
 * (app/adv/harnesses/DetailPanel.tsx:490, reused unchanged, never forked) — a
 * nuqs param for the open item is the CALLER's (OperatorChat) job, same split
 * PlanPopupModal has with ITS caller (PlansPane owns `pplan`; PlanPopupModal
 * only owns its own internal `ppv` tab state). This component is a pure
 * function of `id`/`harnessSlug` props, deep-linkable + agent-driveable
 * however the caller chooses to encode its own URL state.
 *
 * The two re-host traps PlanPopupModal already documents, checked here too:
 *  - scrolling parent: WorkItemDetail is ALREADY self-scrolling —
 *    `.pc-adv-detail__body` carries its own `overflow: auto` (injected by the
 *    component's own inlined `<DetailStyles/>`), unlike PlanDetail which
 *    needed an external `.pc-plans__main`-style scroller class. This popup
 *    only has to give `.pc-adv-detail` a BOUNDED height to fill — the same
 *    role the dock panel's own wrapper normally plays — via `.wi-popup__body`
 *    below (flex + `overflow: hidden`, so there's exactly one scroller, not
 *    two nested ones).
 *  - unsaved-edit guard: does not apply. WorkItemDetail has no in-place edit
 *    state, unlike PlanDetail's Vditor editor — nothing here can be silently
 *    discarded on close. Its legacy Chat action is hidden in this rehost;
 *    inline work-item Discuss is the sole chat entry point.
 */
import { useMemo, type ReactNode } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '../../harness/Modal';
import { WorkItemDetail } from '../../adv/harnesses/DetailPanel';
import type { WorkItemRow } from '../../adv/harnesses/WorkItemsPanel';
import './work-item-popup.css';

export default function WorkItemPopupModal({
  id,
  harnessSlug,
  onSelect,
  onClose,
}: {
  /** The open WI-/EI-/F- ref (e.g. "WI-5952"), or null — closed. */
  id: string | null;
  /** The harness `id` lives in — the SAME harness the chat/conversation is
   *  scoped to (OperatorChat's own `harnessSlug`). Null renders a "no
   *  harness context" empty state rather than guessing across harnesses —
   *  a popup pointed at the wrong harness is worse than no popup (mirrors
   *  P-006's "no plan context -> plain text" stance one layer over). */
  harnessSlug: string | null;
  /** WorkItemDetail's own cross-link handler (a related item's ref inside
   *  the detail body) — RE-TARGETS this same popup to the new id rather than
   *  navigating away, since there is no Working-tab destination left for it
   *  to navigate to (D-001). The caller just needs to update its own "open
   *  id" state with this value. */
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const open = id !== null;

  const query = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.detail',
    args: { harnessSlug: harnessSlug ?? '', id: id ?? '' },
    enabled: open && Boolean(harnessSlug) && Boolean(id),
  });
  const row = useMemo(() => query.data?.[0] ?? null, [query.data]);

  let body: ReactNode;
  if (!harnessSlug) {
    body = <div className="wi-popup__empty">No harness context for {id}.</div>;
  } else if (query.loading) {
    body = <div className="wi-popup__empty">Loading {id}…</div>;
  } else if (!row || row.id !== id) {
    body = <div className="wi-popup__empty">No item found for {id}.</div>;
  } else {
    // onBack is intentionally omitted — the popup has no selection history
    // stack (unlike the Working tab's swap panel); BackChip renders nothing
    // without it.
    body = (
      <WorkItemDetail
        slug={harnessSlug}
        workItem={row}
        onSelect={onSelect}
        showChatAction={false}
        showDiscussionAction={false}
      />
    );
  }

  return open ? (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={row?.title ? `${id} — ${row.title}` : (id ?? 'Work item')}
      srOnlyTitle
      contentClassName="wi-popup"
      contentStyle={{
        width: 'min(760px, 94vw)',
        height: 'min(720px, calc(100vh - 4rem))',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: 0,
      }}
    >
      {/* WorkItemDetail already renders its own id/title header
          (.pc-adv-detail__header) — this bar only carries the close
          affordance, so the id/title isn't duplicated. */}
      <div className="wi-popup__header">
        <button
          type="button"
          className="wi-popup__close"
          onClick={onClose}
          aria-label="Close work item popup"
          data-testid="wi-popup-close"
        >
          ✕
        </button>
      </div>
      <div className="wi-popup__body" data-testid="wi-popup-body">
        {body}
      </div>
    </Modal>
  ) : null;
}
