'use client';

/**
 * GoalWorkRail — the goal popup's side panel
 * (goals-tab-improvement-2026-08-09 P-019).
 *
 * [owner 2026-08-09] "The way we have the sidepanel for the fleet members, we
 * can mimic that design for all the associated plans and work items from that
 * goal."
 *
 * So this is FleetPeersRail's shape applied to a goal's work: the same
 * `pc-zone-title` bar, the same capped `pc-peers__group` sections, the same
 * two-line rows — reusing that vocabulary rather than declaring a third rail
 * look, so the goal popup and the conversation popup read as one system.
 *
 * PRESENTATIONAL ONLY, exactly like FleetPeersRail. Every rule about what
 * appears, in what order, and what must not be double-counted lives in
 * `workRail()` in the pure, unit-tested `goal-detail-model.ts`. The caller
 * derives because the caller ALSO needs the answer — an empty rail is a layout
 * decision (do not widen the popup) this component cannot make from inside
 * itself.
 *
 * ── Where these rows come from, and why it is not obvious ──────────────────
 * WORK ITEMS are a direct read: `work_items.goal_id`. PLANS arrive by EITHER of
 * two legs (D-010): DERIVED — a work item stamped with this goal came from that
 * plan — or STAMPED — the plan itself carries `harness_plans.goal_id`
 * (migration 791), which is how a plan the goal just started shows up before it
 * has produced any work item. Do not "improve" that into listing the plans of
 * the goal's projects: a harness holds hundreds of plans and that would render a
 * whole plan directory under a one-day-old goal.
 *
 * ⚠ This block USED TO SAY "harness_plans carries no goal link at all". That
 * was true before migration 791 and is now FALSE. It was still being read as
 * current on 2026-08-10 and nearly produced a "missing" goal→plan link being
 * rebuilt when the link already existed. Do not reintroduce it.
 *
 * ⚠ EMPTY IS STILL A COMMON CASE (D-010), so the empty state is one explicit
 * sentence about the goal rather than three bare headings — three empty
 * sections read as a panel that failed to load, which is the misreading this
 * rail can least afford.
 *
 * The REASON has moved, though, and the distinction matters if you are
 * debugging an empty rail. This used to say "no work item in this workspace
 * carries a goal stamp yet"; goal-stamped work items DO exist now. What is
 * still typically zero is goal-stamped items that also carry a
 * `source_plan_slug` — and it is that pairing, not the stamp alone, that feeds
 * the DERIVED plan leg. So an empty PLANS section usually means "no stamped
 * item came from a plan", not "no goal stamps exist".
 *
 * Deliberately no counts here: a comment quoting a measurement goes stale the
 * moment the next commit lands, silently and with no guard. Measure it when you
 * need it, against harness_shared.work_items.
 */
import { useMemo } from 'react';
import type { GoalDetailPlanInput, GoalWorkRail as GoalWorkRailModel, GoalWorkRailItem } from './goal-detail-model';
import { agoText, planLabel } from './goal-detail-model';

function ItemRow({
  item,
  onOpen,
}: {
  item: GoalWorkRailItem;
  /** Absent ⇒ render read-only. A row that looks clickable and is not is worse
   *  than one that plainly is not — the dead-button shape WI-6742 filed. */
  onOpen?: (id: string) => void;
}) {
  const body = (
    <>
      <span className="pc-peer__r1">
        <span className="pc-peer__dot" data-goal-tone={item.tone} aria-hidden="true" />
        <span className="pc-peer__handle">{item.title}</span>
      </span>
      <span className="pc-peer__r2">
        <span className="pc-peer__state" data-goal-tone={item.tone}>
          {item.metaText}
        </span>
        {item.harnessSlug ? <span className="pc-peer__intent"> · {item.harnessSlug}</span> : null}
      </span>
    </>
  );

  if (!onOpen) {
    return (
      <li className="pc-peer" data-testid="goal-rail-item" data-id={item.id}>
        {body}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="pc-peer pc-peer--btn"
        onClick={() => onOpen(item.id)}
        data-testid="goal-rail-item"
        data-id={item.id}
        /* Spells out the DESTINATION: the visible row is a title and a state
         * word, neither of which says that pressing it opens the item. */
        aria-label={`Open work item ${item.id} — ${item.title}`}
      >
        {body}
      </button>
    </li>
  );
}

function PlanRow({ plan, nowMs }: { plan: GoalDetailPlanInput; nowMs: number }) {
  const label = planLabel(plan);
  const age = agoText(plan.updatedAt, nowMs);
  const open = plan.openItems ?? 0;
  const total = plan.items ?? 0;
  /* A plan this goal AUTHORED that has not yet produced a goal-stamped work
     item. The counts are honest — they really are zero — but "0 open of 0 on
     this goal" reads as "the agent did nothing", and this is the state EVERY
     goal passes through in its first minutes, which is precisely when the owner
     is looking. Say what actually happened instead. A stamped plan that HAS
     items falls through to the counts, which are the more informative reading. */
  const startedOnly = plan.stamped && total === 0;
  return (
    <li className="pc-peer" data-testid="goal-rail-plan" data-slug={plan.planSlug}>
      <span className="pc-peer__r1">
        <span className="pc-peer__handle" title={plan.planSlug}>
          {label.text}
        </span>
        {/* A plan row that no longer resolves keeps its slug and SAYS so — see
            planLabel(). Silently rendering the slug as if it were a title would
            hide the one thing worth noticing here. */}
        {label.missing ? <span className="pc-peer__kind">no plan row</span> : null}
        {plan.archived ? <span className="pc-peer__kind">archived</span> : null}
      </span>
      <span className="pc-peer__r2">
        {/* Deliberately "of this goal's N": these are the goal-stamped items
            that came from the plan, NOT the plan's own size. Labelling it
            "plan progress" would overstate what the goal owns — the plan is
            very often much larger than its goal-stamped slice. */}
        <span className="pc-peer__state" data-started-only={startedOnly ? 'true' : undefined}>
          {startedOnly ? 'started by this goal' : `${open} open of ${total} on this goal`}
        </span>
        {age ? <span className="pc-peer__intent"> · {age}</span> : null}
      </span>
    </li>
  );
}

export default function GoalWorkRail({
  model,
  nowMs,
  onOpenWorkItem,
  onClose,
}: {
  model: GoalWorkRailModel;
  nowMs: number;
  /** Reuses the panel's EXISTING work-item route into the HUD popup rather than
   *  adding a second one (P-019's explicit instruction). */
  onOpenWorkItem?: (id: string) => void;
  onClose: () => void;
}) {
  const sections = useMemo(
    () =>
      [
        { key: 'needs-you' as const, cap: 'Needs you', items: model.needsYou },
        { key: 'open' as const, cap: 'Open', items: model.open },
        { key: 'closed' as const, cap: 'Closed', items: model.closed },
      ].filter((s) => s.items.length > 0),
    [model.needsYou, model.open, model.closed],
  );

  return (
    <aside className="pc-peers" aria-label="Plans and work items for this goal">
      {/* Mirrors the conversation popup's rail title bars so the two popups read
          as one set rather than one plus an imitation. */}
      <header className="pc-zone-title" data-testid="goal-rail-title">
        <span>Work</span>
        <span className="pc-zone-title__sub">— what sits under this goal</span>
        <button
          type="button"
          className="pc-zone-title__close"
          onClick={onClose}
          aria-label="Hide plans and work items"
        >
          ✕
        </button>
      </header>

      {model.empty ? (
        /* ONE sentence, and it names the mechanism rather than saying "empty".
           A goal collects work when an agent running IN goal mode creates it —
           so nothing here means nothing has been created under it yet, which is
           a fact about the goal, not about this panel. */
        <div className="pc-peers__empty" data-testid="goal-rail-empty" role="status">
          Nothing is under this goal yet. Work items are attached when an agent
          running on this goal creates them; plans appear once those items come
          from one.
        </div>
      ) : (
        <div className="pc-peers__list">
          <ul className="pc-peers__group">
            <li className="pc-peers__cap" aria-hidden="true">
              <span>Plans</span>
              <span className="pc-peers__cap-n">{model.plans.length}</span>
            </li>
            {model.plans.length === 0 ? (
              <li className="pc-peers__empty" data-testid="goal-rail-no-plans">
                No work here came from a plan.
              </li>
            ) : (
              model.plans.map((p) => (
                <PlanRow key={`${p.harnessSlug}/${p.planSlug}`} plan={p} nowMs={nowMs} />
              ))
            )}
          </ul>

          {/* Only the sections that HAVE rows. An empty "Closed" heading on a
              young goal implies something was closed and is missing; the fleet
              rail makes the same call for the same reason. */}
          {sections.map((s) => (
            <ul className="pc-peers__group" key={s.key}>
              <li className="pc-peers__cap" aria-hidden="true">
                <span>{s.cap}</span>
                <span className="pc-peers__cap-n">{s.items.length}</span>
              </li>
              {s.items.map((it) => (
                <ItemRow key={it.id} item={it} onOpen={onOpenWorkItem} />
              ))}
            </ul>
          ))}
        </div>
      )}
    </aside>
  );
}
