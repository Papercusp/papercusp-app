'use client';

/**
 * HudEntityColumns — the presentational half of the HUD's Plans and Work items
 * tabs (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * Same contract as HudBoard.tsx: this file renders, it does not decide. Every
 * column, badge and count arrives already computed from `hud-entity-board.ts`.
 *
 * It reuses the session board's CLASS NAMES wholesale (`hud__cols`, `hud__col`,
 * `hud__card`, `hud__chip`, …) rather than defining a parallel set, because the
 * owner's ask was explicitly "the same kanban style" — a second set of styles
 * would be a promise to keep them looking identical forever, by hand. The only
 * new CSS this tab needs is the tab strip itself and the search box.
 *
 * Cards were `<div>`s, not `<button>`s, because a plan or work-item card had no
 * destination wired yet and "a button that looks activatable but does nothing is
 * worse than a card that never claimed to be". That was always a deliberate
 * future seam (the card model already carries `id`/`ref`) — and the owner asked
 * for it on 2026-07-27, expecting the left sidebar's behaviour: clicking a row
 * opens it in a POPUP.
 *
 * hud-open-destinations-and-true-counts-2026-07-27 P-002 closes the seam. A card
 * is a `<button>` exactly when `onOpenCard` is supplied, and stays an inert
 * `<div>` otherwise — so the reasoning above still holds for any board that has
 * no destination. The destinations live with the CALLER (HudView): a work item
 * opens `WorkItemPopupModal` (the same component OperatorChat opens); a plan
 * opens the option-C dashboard takeover (`pdash` → PlanDashboardHost — P-007 /
 * D-005, the same navigation PlansPane's rows make), never a second renderer.
 */

import { memo, type ReactNode } from 'react';
import { RowBoundary, SectionBoundary } from '@/app/_components/RenderBoundary';
import { Tooltip } from '@/app/harness/Tooltip';
import { Combobox, type ComboboxOption } from '@/app/harness/Combobox';
import { KindPill } from '@/app/harness/primitives';
import { formatAge, type HudBadge } from './hud-board-model';
import HudSearchBox from './HudSearchBox';
import {
  HUD_ENTITY_COLUMNS,
  HUD_ENTITY_COLUMN_LABEL,
  HUD_PLAN_SORTS,
  HUD_PLAN_SORT_LABEL,
  HUD_PLAN_WORK_HOT_SEC,
  type HudEntityBoard,
  type HudEntityCard,
  type HudEntityColumnId,
  type HudPlanCardMeta,
  type HudPlanSort,
} from './hud-entity-board';

/**
 * The two columns the WEIGHTED board collapses to count rails
 * (plan-visibility-revamp-2026-08-23 P-006, D-004): Ready and Done are the
 * populations you consult, not the ones that need attention, so they trade
 * their card lists for a 46px count rail that expands (via the existing
 * column-focus mechanism) on click. A Set, not two `id ===` checks, so the
 * render sites below cannot drift from each other.
 */
const WEIGHTED_RAIL_COLUMNS: ReadonlySet<HudEntityColumnId> = new Set(['ready', 'done']);

/** The sort picker's rows — static, so they are built once at module scope. */
const PLAN_SORT_OPTIONS: ComboboxOption[] = HUD_PLAN_SORTS.map((s) => ({
  value: s,
  label: HUD_PLAN_SORT_LABEL[s],
  detail:
    s === 'last-work'
      ? '⚒ most recent work-item activity first'
      : '✎ most recent plan edit first',
}));

const CHIP_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: 'hud__chip--accent',
  good: 'hud__chip--good',
  warn: 'hud__chip--warn',
  bad: 'hud__chip--bad',
};

/** Same cap the session card applies — a card with eight chips communicates
 *  less than one with four, and the model already orders them by value. */
const MAX_CHIPS = 4;

/**
 * Plan columns where the card does NOT render a "now" line
 * (hud-plan-card-density-2026-08-31 D-002, variant D).
 *
 * A plan sitting in Ready has not started and one in Done has finished, so
 * neither has a next action worth a whole row — and these are usually the two
 * fullest columns on the board. Suppressing the row here rather than with a
 * `display:none` rule keeps the accessible name honest (a screen reader is not
 * offered a line the sighted reader cannot see) and avoids a CSS rule that
 * would have to be double-scoped to spare the work-item cards sharing these
 * columns.
 */
const SETTLED_PLAN_COLUMNS: ReadonlySet<HudEntityColumnId> = new Set<HudEntityColumnId>([
  'ready',
  'done',
]);

/**
 * The COMPACT plan card — hud-plan-card-density-2026-08-31, D-001 variant B.
 *
 * Two rows, measured at 52px against the 155px this card used to cost, which is
 * 8 plans per column instead of 3:
 *
 *   ● Restore Papercusp main green…      ●1  ⚒ 9m  ●2     <- title + activity rail
 *     su-60f: P-002 SSE boundary regression test…         <- the "now" item
 *   ▔▔▔▔▔▔▔▔▔▔▔▔░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░       <- .hud__track, 0px tall
 *
 * WHY THE RAIL IS TRIAGED RATHER THAN RELOCATED. The owner asked for the icons
 * to "float on the right side of the first line". Rendered with real data at a
 * 244px card, the full former meta strip — pips + ✎ + ⚒ + four avatars + the
 * live pill — measures 128px and leaves the title 69px, about eight characters;
 * `.hud__cols` is `repeat(5, minmax(190px, 1fr))`, so at the grid floor the
 * text box is only 146px wide. Moving the whole strip is therefore not buildable
 * at any width this grid produces. The rail carries ONE signal — ⚒ last work
 * plus the live pill, "is anything happening here", 62px — plus the two
 * exception counts, and the title keeps 121px.
 *
 * WHAT THE PLAN CARD DELIBERATELY NO LONGER SHOWS, and where it went (D-001):
 *   - the slug row      → the `title` attribute; it was the title in kebab-case
 *                         plus a date, so the card was printing its own name twice
 *   - `card.context`    → the `title` attribute, beside the slug. This line used
 *                         to read "→ nothing; it reads `papercusp` on every card
 *                         here", which was FALSE and was never checked: `context`
 *                         is `plan.harnessSlug` (hud-entity-board.ts), and
 *                         HudView passes `harness_slugs: scopedHarnessSlugs ??
 *                         undefined` — undefined means UNFILTERED, so on an
 *                         unscoped HUD, or a pot spanning more than one harness,
 *                         the harness genuinely differs per card. Caught by the
 *                         independent rubric review (WI-1743279 F2). Folding it
 *                         into the hover title costs zero pixels and stops the
 *                         fact being lost in exactly the case the claim ignored.
 *   - the chips row     → the two exception counts survive as pips. `wip`/`todo`
 *                         and `archived` are DROPPED. The reason is deliberate
 *                         and it is not the one this line used to give: it read
 *                         "`wip`/`todo` restate the track and the column the
 *                         card sits in", which is FALSE, and was the second
 *                         unchecked premise found in this docblock (the
 *                         `card.context` note above was the first). `planColumn`
 *                         is ORDERED — `needsHuman > 0` returns `needs-you`
 *                         before `wip > 0` can return `working`, and an explicit
 *                         `blocked` status outranks both — so a plan with
 *                         needsHuman=2 AND wip=3 sits in `needs-you` and its
 *                         column restates nothing about wip; `todo` is rung 6
 *                         and is likewise unreachable for any plan with wip. Nor
 *                         does the track restate them: `.hud__track` draws
 *                         itemsDone/itemsTotal, where total sums ALL buckets, so
 *                         it isolates neither. The HONEST disposition is that
 *                         `wip`/`todo` are the ORDINARY states of a live plan
 *                         and the rail is budgeted for the EXCEPTIONAL ones —
 *                         they are dropped because they are not worth the pixels
 *                         on a two-line card, which is a design call, not a
 *                         redundancy. Caught by the independent acceptance
 *                         grading (EI-21975441333986366); see D-006.
 *                         `archived` never reaches this board at all —
 *                         HudView.tsx passes `usePlanList({ includeArchived:
 *                         false })`, so the badge kind cannot render here.
 *   - `n/m items`       → nothing; `.hud__track` below already draws it
 *   - ✎ last edit and the avatar stack → nothing. This is the accepted cost of
 *     variant B over variant C, which spent the same rail on presence instead.
 *
 * All spans: this subtree renders inside a card that is a <button> whenever the
 * board supplies a destination (see the Tag note in EntityCardBody), so phrasing
 * content is a structural requirement, not a style choice, and the flex rows
 * live on the spans themselves rather than on the button (WebKitGTK).
 *
 * Native `title`s, not <Tooltip>, matching PlansPane's V1 header pair — the two
 * surfaces show the SAME timestamps and should explain them identically.
 */
function PlanCardCompact({ card, meta }: { card: HudEntityCard; meta: HudPlanCardMeta }) {
  const workHot = meta.workedSec != null && meta.workedSec < HUD_PLAN_WORK_HOT_SEC;
  // P-007's rule, unchanged: what agents DECLARED outranks the stored next
  // action, because it is what is actually happening. D-002 then drops the row
  // entirely in the settled columns.
  const now = SETTLED_PLAN_COLUMNS.has(card.column) ? null : (meta.who ?? card.reason);
  return (
    <>
      <span className="hud__card-h">
        <span className={`hud__dot hud__dot--${card.column}`} aria-hidden="true" />
        {/* The slug is the accessible name (see EntityCardBody's aria-label) and
            the hover title; the TITLE is what a reader scans for, so it takes
            the line. The harness rides along in the hover title when the card
            carries one — see the `card.context` note above: a multi-harness
            board is the case where dropping it outright would lose a fact. */}
        <span className="hud__cardtitle" title={card.context ? `${card.ref} · ${card.context}` : card.ref}>
          {card.title}
        </span>
        <span className="hud__cardright">
          {meta.needsHumanCount > 0 ? (
            <span
              className="hud__pip hud__pip--warn"
              title={`${meta.needsHumanCount} item${meta.needsHumanCount === 1 ? '' : 's'} on this plan need a human decision`}
            >
              {meta.needsHumanCount}
            </span>
          ) : null}
          {meta.blockedCount > 0 ? (
            <span
              className="hud__pip hud__pip--bad"
              title={`${meta.blockedCount} item${meta.blockedCount === 1 ? '' : 's'} blocked`}
            >
              {meta.blockedCount}
            </span>
          ) : null}
          <span
            className={`hud__mt${workHot ? ' hud__mt--hot' : ''}`}
            title={meta.workedSec != null ? '⚒ Last work-item activity' : '⚒ No work-item activity yet'}
          >
            ⚒ {formatAge(meta.workedSec)}
          </span>
          {meta.liveCount > 0 ? (
            <span
              className="hud__liven"
              title={`${meta.liveCount} agent${meta.liveCount === 1 ? '' : 's'} live on this plan right now`}
            >
              <span className="hud__dotg" aria-hidden="true" />
              {meta.liveCount}
            </span>
          ) : null}
        </span>
      </span>

      {now ? (
        <span
          className={`hud__entity-why${meta.who ? ' hud__entity-why--who' : ''}`}
          /* When the live who-line DISPLACES the stored next-action, the
             next-action survives as the hover title — it is a fact the card
             still knows, not one it threw away (the P-007 rule, kept). When
             there is no who-line the row already IS the next-action, so the
             title reveals whatever the single-line clamp cut off instead. */
          title={meta.who ? (card.reason ?? undefined) : now}
        >
          {now}
        </span>
      ) : null}

      {meta.itemsTotal != null && meta.itemsDone != null ? (
        <span className="hud__track" aria-hidden="true">
          <span
            className="hud__track-fill"
            style={{ width: `${Math.round((100 * meta.itemsDone) / meta.itemsTotal)}%` }}
          />
        </span>
      ) : null}
    </>
  );
}

function EntityCard({
  card,
  onOpen,
  renderAction,
}: {
  card: HudEntityCard;
  onOpen?: (card: HudEntityCard) => void;
  renderAction?: (card: HudEntityCard) => ReactNode;
}) {
  const chips = card.badges.slice(0, MAX_CHIPS);
  const overflow = card.badges.length - chips.length;
  // A button ONLY when there is somewhere to go (see the file docblock). The
  // session card's `type="button"` + className shape is mirrored exactly so the
  // two boards keep looking identical without a parallel style set.
  const Tag = onOpen ? 'button' : 'div';

  const action = renderAction?.(card);
  // A card-level ACTION cannot live INSIDE the card (P-016): the card is itself a
  // <button> whenever it has a destination, and a button inside a button is invalid
  // HTML — browsers reparent it, and the inner click target becomes unreliable. So the
  // action is a SIBLING under a positioning wrapper, and the wrapper only exists when
  // a board actually supplies one. Boards that do not (Plans, Work items) render the
  // exact same tree as before, so this adds no layout surface to surfaces that never
  // asked for it.
  if (action) {
    return (
      <span className="hud__card-wrap">
        <EntityCardBody card={card} onOpen={onOpen} chips={chips} overflow={overflow} Tag={Tag} />
        <span className="hud__card-actions">{action}</span>
      </span>
    );
  }
  return <EntityCardBody card={card} onOpen={onOpen} chips={chips} overflow={overflow} Tag={Tag} />;
}

function EntityCardBody({
  card,
  onOpen,
  chips,
  overflow,
  Tag,
}: {
  card: HudEntityCard;
  onOpen?: (card: HudEntityCard) => void;
  chips: HudBadge[];
  overflow: number;
  Tag: 'button' | 'div';
}) {
  return (
    <Tag
      className={`hud__card hud__card--${card.column} hud__card--entity`}
      aria-label={`${card.ref} — ${card.title}`}
      {...(onOpen
        ? { type: 'button' as const, onClick: () => onOpen(card) }
        : {})}
    >
      {/* Flex row on the inner span, never the outer element — see the
          WebKitGTK note on .hud__card in hud.css. */}
      <span className="hud__card-row">
        <span className="hud__rail" aria-hidden="true" />
        <span className="hud__card-b">
          {/* hud-plan-card-density-2026-08-31 D-004: the compact two-line form is
              for PLAN cards ONLY. `card.plan` is written by `toPlanCard` and by
              nothing else, so it is the discriminator — session, goal and
              work-item cards render exactly the tree they always have.

              Inside the else-branch `card.plan` is known falsy, so the three
              ternaries that used to test it here are gone rather than left as
              dead branches: the header age always renders, and the "why" line
              reduces to the stored reason (the live who-line moved into
              PlanCardCompact, which is the only card that ever had one). */}
          {card.plan ? (
            <PlanCardCompact card={card} meta={card.plan} />
          ) : (
            <>
              <span className="hud__card-h">
                <span className={`hud__dot hud__dot--${card.column}`} aria-hidden="true" />
                <span className="hud__handle">{card.ref}</span>
                <span className="hud__age">{formatAge(card.sinceSec)}</span>
              </span>

              <span className="hud__reason">{card.title}</span>

              {/* The "why" line sits BELOW the title here, inverting the session
                  card (where the reason IS the content and there is no separate
                  title). A card's title is the thing you scan for; its reason is
                  the detail you read once you have found it. */}
              {card.reason ? <span className="hud__entity-why">{card.reason}</span> : null}

              {card.context ? <span className="hud__plan">{card.context}</span> : null}

              {chips.length > 0 ? (
                <span className="hud__chips">
                  {chips.map((b) =>
                    b.workItemKind ? (
                      <KindPill key={b.id} kind={b.workItemKind} size="xs" />
                    ) : b.title ? (
                      <Tooltip key={b.id} label={b.title}>
                        <span className={`hud__chip ${CHIP_TONE_CLASS[b.tone]}`}>{b.label}</span>
                      </Tooltip>
                    ) : (
                      <span key={b.id} className={`hud__chip ${CHIP_TONE_CLASS[b.tone]}`}>
                        {b.label}
                      </span>
                    ),
                  )}
                  {overflow > 0 ? <span className="hud__chip">+{overflow}</span> : null}
                </span>
              ) : null}
            </>
          )}

          {/* SUBDIRECTIVES (P-017, D-006 Q4 option A). Nested inside the parent
              because a child steers this goal's agent rather than owning one, so
              it "has no business sitting in a lane of its own".

              Every element here is a <span>: this subtree can be inside a
              <button> (see the Tag note above), and a button's content model is
              phrasing content — a <ul>/<li> list would be invalid and browsers
              would reparent it, which is the same defect P-016 hit with a nested
              <button>.

              These rows are deliberately INERT — no click target, no link. A
              subdirective owns no session to open (D-006), so anything
              activatable here would promise a destination that does not exist:
              the exact mistake this file's own docblock was written about ("a
              button that looks activatable but does nothing is worse than a card
              that never claimed to be").

              NO SPEND FIGURE, and none is available to render: one goal is one
              agent is one bill, so a child has no separable spend (D-006). That
              is why `HudSubGoal` carries no badges — the summing D-002 forbids
              is unrepresentable here rather than merely untested. */}
          {card.subGoals && card.subGoals.length > 0 ? (
            <span className="hud__subs">
              <span className="hud__subs-h">
                {card.subGoals.length} subdirective{card.subGoals.length === 1 ? '' : 's'}
              </span>
              {card.subGoals.map((s) => (
                <span
                  key={s.id}
                  className={`hud__sub${s.terminal ? ' hud__sub--done' : ''}`}
                >
                  <span className="hud__sub-mark" aria-hidden="true">
                    ↳
                  </span>
                  <span className="hud__sub-title">{s.title}</span>
                  <span className="hud__sub-status">{s.status}</span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </span>
    </Tag>
  );
}

/**
 * WI-6668: the per-ITEM boundary. A card that throws while rendering degrades to
 * a one-line placeholder; every sibling card, the column, and the tab all
 * survive. Before this, one malformed row blanked the whole HUD tab.
 *
 * The boundary is INSIDE the `memo`, not around it, so this costs nothing per
 * commit: a card whose props are unchanged re-renders neither the boundary nor
 * the card (WI-6560 — HUD list commits are already the expensive ones).
 */
const MemoEntityCard = memo(function SafeEntityCard(props: {
  card: HudEntityCard;
  onOpen?: (card: HudEntityCard) => void;
  renderAction?: (card: HudEntityCard) => ReactNode;
}) {
  return (
    /* Optional-chained on purpose: the label is computed OUTSIDE the boundary
       (it is this component's own render), so a null/undefined row would throw
       here — above the very boundary meant to contain it — and take the column
       down anyway. The types say it cannot be null; the feed is what actually
       decides. */
    <RowBoundary
      label={props.card?.ref || props.card?.id || 'This item'}
      scope="hud-card"
    >
      <EntityCard {...props} />
    </RowBoundary>
  );
});

export interface HudEntityColumnsProps {
  board: HudEntityBoard;
  /** Column filter — when set, only this column is shown, expanded. */
  focusColumn: HudEntityColumnId | null;
  onFocusColumn: (id: HudEntityColumnId | null) => void;
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  error: string | null;
  /** Shown when the board is genuinely empty (not loading, not filtered). */
  emptyLabel: string;
  /** Noun for the search placeholder + filtered-empty message ("plans"). */
  noun: string;
  /**
   * A caveat about what the board is showing, rendered ABOVE the columns and —
   * critically — independently of whether there are cards.
   *
   * `emptyLabel` cannot serve this role: it only renders on the `total === 0`
   * branch, so a board that loaded NOTHING but still has cards from another
   * source silently reads as complete. That is not hypothetical — the Work
   * items tab gates its read on a resolved harness, and the unattributed asks
   * folded into needs-you kept `total` above zero, so a session with no harness
   * showed 146 "work items", none of which were work items, with nothing on
   * screen saying why (verified live 2026-07-26).
   *
   * Same principle as the per-column "+N more": a board that cannot show you
   * everything has to SAY so, or every count on it becomes untrustworthy.
   */
  notice?: string | null;
  /**
   * Open a card (P-002). Supplied ⇒ cards render as real buttons; omitted ⇒
   * they stay inert `<div>`s, so a board with no destination never grows a
   * control that does nothing. The whole card is passed (not just `id`) because
   * the popups are harness/slug-scoped and the caller decides which popup a
   * given board's cards belong to.
   */
  onOpenCard?: (card: HudEntityCard) => void;
  /**
   * Render a per-card ACTION (P-016) — a control that acts on the entity WITHOUT
   * navigating to it. Supplied only by the Goals board today (pause/resume).
   *
   * A render prop rather than a flag because the action is host-specific: the control
   * needs the goal's status and its own write path, neither of which this presentational
   * file should know about. Omitted ⇒ the card tree is byte-identical to before, so the
   * boards with no action grow no wrapper.
   */
  renderCardAction?: (card: HudEntityCard) => ReactNode;
  /**
   * The H2 weighted layout (plan-visibility-revamp-2026-08-23 P-006, D-004:
   * "keep the five-column kanban but weight widths by attention"). Supplied by
   * the Plans tab only. When set:
   *
   *   - the grid weights its columns 1.35fr / 2fr / 1fr (needs-you wide,
   *     working widest, blocked narrow) with Ready + Done as fixed 46px rails;
   *   - Ready and Done render as collapsed COUNT RAILS — a vertical label and
   *     the true count — that expand through the existing column-focus
   *     mechanism on click (so `hudecol` deep links keep working unchanged);
   *   - the bare count chips become the labeled segmented filter strip, with an
   *     explicit "All" segment clearing the focus.
   *
   * Omitted ⇒ the board renders exactly as before, so the Goals and Work-items
   * tabs are untouched by this variant.
   */
  weighted?: boolean;
  /**
   * The sort picker (D-004: "add a sort picker (default: last work)"). Rendered
   * only when BOTH are supplied; the picked value must be the same one the
   * caller passed to `buildPlanBoard`, or the control would claim an ordering
   * the cards don't have.
   */
  sort?: HudPlanSort;
  onSort?: (sort: HudPlanSort) => void;
}

export default function HudEntityColumns({
  board,
  focusColumn,
  onFocusColumn,
  query,
  onQuery,
  loading,
  error,
  emptyLabel,
  noun,
  notice = null,
  onOpenCard,
  renderCardAction,
  weighted = false,
  sort,
  onSort,
}: HudEntityColumnsProps) {
  const visibleColumns = focusColumn
    ? board.columns.filter((c) => c.id === focusColumn)
    : board.columns;

  /* "Is there anything to show", NOT "is the count zero" — the two can honestly
     disagree, and gating the empty state on the COUNT hid real cards.

     `counts`/`total` describe the ENTITY population, and a board may legitimately
     carry a card that is not one of those entities: the Goals board prepends a
     "+ Start a goal" ACTION card and deliberately leaves it uncounted, because a
     board reporting "1 goal" when zero exist is the same class of lie as an
     uncaveated truncated column. Gated on `total === 0`, that card rendered
     nowhere in exactly the empty-board case it exists for. (`opts.totals` can
     also make `total` a store-wide figure that no longer matches the sampled
     cards, so the two were never safely interchangeable.) */
  const hasCards = board.columns.some((c) => c.cards.length > 0);

  return (
    <>
      <div className="hud__top hud__top--entity">
        {weighted ? (
          /* The labeled segmented filter strip (P-006, D-004: "replace the bare
             count chips with a labeled segmented filter strip"). Same state, same
             writes as the chips it replaces — every segment drives the existing
             column focus — plus an explicit "All" segment, because a strip whose
             only cleared state is re-clicking the active segment makes "show me
             everything" an invisible affordance. */
          <div className="hud__seg" role="group" aria-label={`Filter ${noun} by column`}>
            <button
              type="button"
              className="hud__seg-btn"
              aria-pressed={focusColumn === null}
              onClick={() => onFocusColumn(null)}
            >
              <span className="hud__seg-row">
                All <b>{board.total}</b>
              </span>
            </button>
            {HUD_ENTITY_COLUMNS.map((id) => {
              const n = board.counts[id];
              const hot = id === 'needs-you' && n > 0;
              return (
                <button
                  key={id}
                  type="button"
                  className={`hud__seg-btn${hot ? ' hud__seg-btn--hot' : ''}`}
                  aria-pressed={focusColumn === id}
                  onClick={() => onFocusColumn(focusColumn === id ? null : id)}
                >
                  <span className="hud__seg-row">
                    {HUD_ENTITY_COLUMN_LABEL[id]} <b>{n}</b>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="hud__counts">
            {HUD_ENTITY_COLUMNS.map((id) => {
              const n = board.counts[id];
              const hot = id === 'needs-you' && n > 0;
              return (
                <Tooltip key={id} label={`Show only ${HUD_ENTITY_COLUMN_LABEL[id]}`}>
                  <button
                    type="button"
                    className={`hud__count${hot ? ' hud__count--hot' : ''}`}
                    aria-pressed={focusColumn === id}
                    onClick={() => onFocusColumn(focusColumn === id ? null : id)}
                  >
                    <span className="hud__count-row">
                      <b>{n}</b> {HUD_ENTITY_COLUMN_LABEL[id].toLowerCase()}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}

        {/* A workspace this size carries ~900 plans and ~1800 work items, so
            search is not a nicety — without it the board is a wall. It filters
            the MODEL (ref/title/context), so the counts above always describe
            what is actually on screen. */}
        <HudSearchBox
          value={query}
          onChange={onQuery}
          placeholder={`Filter ${noun}…`}
          ariaLabel={`Filter ${noun}`}
          testId="hud-entity-search"
        />

        <span className="hud__spacer" />

        {/* The sort picker (P-006, D-004 — default: last work). Far right of the
            row, mirroring the mockup; rendered only when the caller actually
            sorts by it, so the other entity tabs grow no control that lies. */}
        {sort && onSort ? (
          <span className="hud__sortpick">
            <Combobox
              ariaLabel={`Sort ${noun}`}
              triggerClassName="hud__sortpick-box"
              testId="hud-entity-sort"
              value={sort}
              options={PLAN_SORT_OPTIONS}
              onChange={(v) => onSort(v as HudPlanSort)}
            />
          </span>
        ) : null}
      </div>

      {/* Outside the branch below on purpose: a caveat about what could not be
          loaded has to survive the board having cards anyway. */}
      {notice ? (
        <p className="hud__state hud__state--notice" role="status">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p className="hud__state hud__state--error">Could not read {noun}: {error}</p>
      ) : loading && board.total === 0 ? (
        <p className="hud__state">Reading {noun}…</p>
      ) : !hasCards ? (
        <p className="hud__state">{query.trim() ? `No ${noun} match “${query.trim()}”.` : emptyLabel}</p>
      ) : (
        <div
          className={`hud__cols${weighted ? ' hud__cols--weighted' : ''}`}
          style={focusColumn ? { gridTemplateColumns: '1fr' } : undefined}
        >
          {visibleColumns.map((c) => {
            /* Ready + Done collapse to COUNT RAILS on the weighted board (P-006)
               — but only while nothing is focused: a focused rail column IS the
               expansion, rendered by the ordinary branch below at full width, so
               deep links to ?hudecol=done keep working with zero extra state.
               The rail is a real <button> into the same onFocusColumn the strip
               and chips drive; its accessible name carries the count because the
               vertical label alone reads as decoration to a screen reader. */
            if (weighted && !focusColumn && WEIGHTED_RAIL_COLUMNS.has(c.id)) {
              const n = board.counts[c.id];
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`hud__railcol hud__col--${c.id}`}
                  aria-label={`Show ${c.label} (${n})`}
                  onClick={() => onFocusColumn(c.id)}
                >
                  {/* Column flex on the inner span, never the <button> — the
                      same WebKitGTK anonymous-box collapse documented on
                      .hud__count in hud.css. */}
                  <span className="hud__railcol-b">
                    <span className="hud__railcol-n">{n}</span>
                    <span className="hud__railcol-lbl">{c.label}</span>
                  </span>
                </button>
              );
            }
            return (
            /* WI-6668: the per-SECTION boundary. Anything the column's own
               render touches (its header, its counts, a card the row boundary
               could not reach) degrades THIS column to a retryable notice and
               leaves the other columns — and the tab — standing. The fallback
               keeps the column's classes so the grid geometry does not collapse. */
            <SectionBoundary
              key={c.id}
              label={c.label}
              scope="hud-column"
              className={`hud__col hud__col--${c.id}`}
            >
              <section className={`hud__col hud__col--${c.id}`} aria-label={c.label}>
                <h3 className="hud__col-h">
                  {c.label}
                  <span className="n">{board.counts[c.id]}</span>
                </h3>
                <div className="hud__col-b">
                  {c.cards.length === 0 ? (
                    <p className="hud__empty">{c.empty}</p>
                  ) : (
                    <>
                      {c.cards.map((card) => (
                        <MemoEntityCard
                          key={card.id}
                          card={card}
                          onOpen={onOpenCard}
                          renderAction={renderCardAction}
                        />
                      ))}
                      {/* A truncated column says so. The cap is a render bound;
                          pretending the column holds 60 items when it holds 400
                          would make every count on this board suspect. */}
                      {c.hidden > 0 ? (
                        <p className="hud__empty hud__more">
                          +{c.hidden} more — narrow with the filter
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </section>
            </SectionBoundary>
            );
          })}
        </div>
      )}
    </>
  );
}
