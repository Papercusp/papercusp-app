'use client';

/**
 * HudBoard — the presentational half of /adv/HUD (adv-hud-fleet-board-2026-07-25
 * P-003). Columns are states, cards are sessions, colour is fleet.
 *
 * This file renders; it does not decide. Every classification, badge and rollup
 * arrives already computed from `hud-board-model.ts` so the logic is testable
 * without a DOM (plan P-002). If you need a new signal on a card, derive it in
 * the model and render it here.
 *
 * Deliberately NOT built on `app/harness/Kanban.tsx` (plan D-001): that
 * primitive is a dnd-kit sortable board, and HUD's columns are DERIVED from
 * live session state. A drag handle would promise that moving a card changes
 * what the agent is doing — it cannot. Cards open the session only when that
 * agent kind has a supported chat surface; Codex/OMP rows remain readable but
 * are deliberately non-clickable.
 */

import { memo, useMemo, useRef, type ReactNode } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';
import { Combobox, type ComboboxOption } from '@/app/harness/Combobox';
import FleetRoleGlyph from '@/app/_components/FleetRoleGlyph';
import {
  ALL_FLEETS,
  ALL_PLANS,
  NO_PLAN_TOKEN,
  SOLO_FLEET_KEY,
  formatAge,
  hudRenderStabilitySwitch,
  hudSessionRendersSame,
  parseHighlight,
  type HudBoard as HudBoardData,
  type HudBadge,
  type HudColumnId,
  type HudFleetRollup,
  type HudSearchHit,
  type HudSession,
} from './hud-board-model';
import { HUD_TABS, HUD_TAB_LABEL, type HudTabId } from './hud-entity-board';
import HudSearchBox from './HudSearchBox';
import { RowBoundary, SectionBoundary } from '@/app/_components/RenderBoundary';
import './hud.css';

const CHIP_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: 'hud__chip--accent',
  good: 'hud__chip--good',
  warn: 'hud__chip--warn',
  bad: 'hud__chip--bad',
};

/** Chips are capped so a busy card can't grow unbounded; the model already
 *  orders them by decision value, so the survivors are the useful ones.
 *  Mode chips are exempt (see SessionCard) — this caps the derived stats. */
const MAX_CHIPS = 4;

/**
 * A chip's classes: tone, plus the mode modifiers.
 *
 * A standing mode is a different KIND of thing from a statistic — it is the
 * posture the agent is operating under — so it reads as a mode chip rather than
 * borrowing the accent tone it happens to share with LEAD. Owner-directed modes
 * get a second modifier: you armed that one, and a peer agent cannot override it.
 */
function chipClass(b: HudBadge): string {
  const tone = CHIP_TONE_CLASS[b.tone];
  if (b.kind !== 'mode') return `hud__chip ${tone}`;
  return `hud__chip ${tone} hud__chip--mode${b.ownerDirected ? ' hud__chip--mode-owner' : ''}`;
}

export interface HudBoardProps {
  board: HudBoardData;
  /** Fleet slugs currently selected (empty = all). `null` = the solo group. */
  selectedFleets: Array<string | null>;
  onToggleFleet: (slug: string | null) => void;
  /**
   * Plans currently selected (empty = all). `null` = the no-plan group — the
   * same array contract `selectedFleets` uses, so the two filters compose in
   * the model without either knowing about the other. The CONTROL is
   * single-select (see the plan filter below), so this holds 0 or 1 entries
   * today; the array shape is what keeps `hudplan` a superset of `hudfleet`'s
   * URL contract rather than a second, differently-shaped one.
   */
  selectedPlans: Array<string | null>;
  /** `ALL_PLANS` clears the filter; `null` selects the no-plan group. Mirrors
   *  `onToggleFleet`'s sentinel contract exactly. */
  onSelectPlan: (slug: string | null) => void;
  /** Column filter — when set, only this column is shown expanded. */
  focusColumn: HudColumnId | null;
  onFocusColumn: (id: HudColumnId | null) => void;
  suOnly: boolean;
  onToggleSuOnly: () => void;
  onOpenSession: (ownerId: string) => void;
  loading: boolean;
  error: string | null;
  /**
   * Sessions-board search box (owner ask 2026-07-26, made live-as-you-type
   * 2026-08-02). HudView runs TWO passes and hands down an already-narrowed
   * `board`, so this component stays presentation-only: an instant pass over the
   * roster it already holds (same feel as the entity tabs' filter) and a
   * debounced pass over every session's full TURN HISTORY server-side, unioned.
   */
  sessionQuery?: string;
  onSessionQuery?: (q: string) => void;
  /** A query is active — drives the empty copy, so "nothing matched your search"
   *  never reads as "no sessions are running". */
  searchActive?: boolean;
  /**
   * The SLOW (transcript) pass is in flight. Reported on the input itself rather
   * than as a board-wide spinner: the instant pass has already filtered the
   * board by now, and hiding that behind a loading state for the length of a
   * multi-second request is exactly the inertness this pair of props exists to
   * remove. The board must keep showing what it already knows.
   */
  sessionSearching?: boolean;
  /** How many sessions the transcript pass added BEYOND the instant matches —
   *  what waiting actually bought you. `null` = it has not answered yet. */
  transcriptExtra?: number | null;
  /** WI-37912 — what the owner-visibility filter removed from this page. */
  hiddenMachineHits?: { count: number; truncatedByLimit: boolean } | null;
  /**
   * Slot rendered at the right edge of the board header, before the
   * su-only toggle — the "+ New session" launch control
   * (hud-consolidation-2026-07-26 P-001). A slot rather than a fixed
   * component so this file stays presentation-only and testable without
   * mocking a live plan-list fetch (see the file docblock); HudView
   * supplies the real `<NewSessionLauncher />`, tests can omit it or pass a
   * stub node.
   */
  headerAction?: ReactNode;
  /**
   * Which board is showing (hud-session-launcher-and-board-tabs-2026-07-26
   * P-009). `sessions` renders everything below — the su-only toggle, the
   * column counts, the fleet strip and the session columns. The other tabs
   * expose `entityView` instead: those controls are session CONCEPTS (a plan
   * has no fleet, a work item has no context window), so showing them on a
   * plans board would be chrome that lies. Both panels stay mounted so a tab
   * switch does not destroy and recreate every session card.
   */
  tab: HudTabId;
  onSelectTab: (tab: HudTabId) => void;
  /**
   * Body for the non-session tabs. A slot, for the same reason `headerAction`
   * is one: this file stays presentation-only and testable without mocking a
   * live plan-list fetch. HudView supplies the real `<HudEntityColumns />`.
   */
  entityView?: ReactNode;
}

/**
 * The matched transcript excerpt, on the card that matched.
 *
 * Segments, never `dangerouslySetInnerHTML` — see `parseHighlight`'s docblock
 * for why that is a correctness rule and not caution: this is arbitrary agent
 * transcript text, which routinely contains markup and quoted HTML.
 */
function SearchHitStrip({ hit }: { hit: HudSearchHit }) {
  const segments = useMemo(
    () => parseHighlight(hit.highlight ?? hit.excerpt),
    [hit.highlight, hit.excerpt],
  );
  if (segments.length === 0) return null;
  return (
    <span className="hud__hit">
      <span className="hud__hit-meta">
        {/* Whose turn matched changes what the excerpt MEANS — the agent saying
            a thing and the human asking it are different results. */}
        {hit.speaker ? <span className="hud__hit-who">{hit.speaker}</span> : null}
        {/* Not "+N results": these are other TURNS inside this one session, and
            the card is already the session. */}
        {hit.more > 0 ? (
          <span className="hud__hit-more">
            +{hit.more} more match{hit.more === 1 ? '' : 'es'}
          </span>
        ) : null}
      </span>
      <span className="hud__hit-text">
        {segments.map((s, i) =>
          s.mark ? (
            <mark key={i} className="hud__hit-mark">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </span>
  );
}

function SessionCard({
  session,
  onOpen,
}: {
  session: HudSession;
  onOpen: (ownerId: string) => void;
}) {
  // Mode chips are never truncated: they are the agent's standing posture (is my
  // silence fine, or am I the thing blocking it?), and an agent stacking
  // auto+ideate+grade would otherwise spend the whole cap on modes and hide its
  // claims and asks. Only the derived stats compete for MAX_CHIPS.
  const modeChips = session.badges.filter((b) => b.kind === 'mode');
  const statChips = session.badges.filter((b) => b.kind !== 'mode');
  const chips = [...modeChips, ...statChips.slice(0, MAX_CHIPS)];
  const overflow = statChips.length - Math.min(statChips.length, MAX_CHIPS);
  // D-001: the headline is the RESOLVED display name — a human-set name, else
  // the session's objective, else the short id — never blank, because the chain
  // bottoms out at `handle`. The id is NOT dropped from the card by this: it
  // moves to the dim ref row below, since it is how a human correlates a card
  // with logs, `--resume` lines and work-item bodies.
  const headline = session.displayName;
  // R3. For a WORKING card `reason` is the session's declared intent, and the
  // objective the headline falls back to is that SAME intent whenever the
  // session holds no wip work-item — so without this a large fraction of live
  // cards would print one string twice, one line apart. Byte-identical only:
  // a reason that merely starts the same is still telling you something.
  const reason = session.reason === headline ? null : session.reason;
  // Same dedupe one level down: when the chain bottomed out at the id, the
  // headline already IS the id, so the ref row does not repeat it. Both forms
  // come from the board's own `shortHandle` (D-004), so this compares equal.
  const idRefs = [
    session.displayNameSource === 'handle' ? null : session.handle,
    session.objectiveWorkItemRef,
    session.planSlug,
  ].filter((r): r is string => Boolean(r));
  const cardProps = {
    className: `hud__card hud__card--${session.column}${session.chatSupported ? '' : ' hud__card--chat-unavailable'}`,
    style: session.fleetColor ? ({ '--hud-fleet': session.fleetColor } as React.CSSProperties) : undefined,
    // The accessible name leads with the headline for the same reason the card
    // does — announcing the bare id first is what this plan set out to fix. The
    // id still follows it, because a screen-reader user needs the same
    // correlation handle the sighted ref row gives.
    'aria-label': [headline, session.handle, reason].filter(Boolean).join(' — '),
    'data-chat-supported': session.chatSupported ? 'true' : 'false',
  };
  const contents = (
    <>
      {/* Flex row lives on this inner span, never the <button> itself — see
          the WebKitGTK note on .hud__card in hud.css. */}
      <span className="hud__card-row">
        <span className="hud__rail" aria-hidden="true" />
        <span className="hud__card-b">
          <span className="hud__card-h">
            <span className={`hud__dot hud__dot--${session.column}`} aria-hidden="true" />
            <span
              className={`hud__name${session.displayNameSource === 'handle' ? ' hud__name--id' : ''}`}
            >
              {headline}
            </span>
            {session.isLeader ? <FleetRoleGlyph role="leader" className="hud__role" /> : null}
            <span className="hud__age">{formatAge(session.sinceSec)}</span>
          </span>

          {/* The reason IS the content — for Blocked/Stalled it is the finding,
              not a label. Intent is the reason for a working session. Absent
              when it would only restate the headline (R3). */}
          {reason ? <span className="hud__reason">{reason}</span> : null}

          {/* D-001's ref row: short id, the in-flight work-item, the plan slug —
              the three handles a human uses to find this session somewhere that
              is not this board. It replaces the standalone .hud__plan line the
              card used to carry (that class is still the entity board's). */}
          {idRefs.length > 0 ? (
            <span className="hud__idrow">
              {idRefs.map((r) => (
                <span key={r} className="hud__idref">
                  {r}
                </span>
              ))}
            </span>
          ) : null}

          {/* WHY this card is in the result set (owner ask 2026-08-02: "when
              searching a transcript it doesn't show the relevant part of the
              conversation on the preview card"). Without it a search returns a
              wall of cards reading "Claude needs your permission" — true, and
              useless as a search result, because the matched words are nowhere
              on screen.

              Rendered only when a transcript match put it here: a session that
              matched on its own card text needs no excerpt, since the thing that
              matched is already visible above. */}
          {session.searchHit ? <SearchHitStrip hit={session.searchHit} /> : null}

          {chips.length > 0 ? (
            <span className="hud__chips">
              {chips.map((b) =>
                b.title ? (
                  <Tooltip key={b.id} label={b.title}>
                    <span className={chipClass(b)}>{b.label}</span>
                  </Tooltip>
                ) : (
                  <span key={b.id} className={chipClass(b)}>
                    {b.label}
                  </span>
                ),
              )}
              {overflow > 0 ? <span className="hud__chip">+{overflow}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
  if (!session.chatSupported) {
    return (
      <div
        {...cardProps}
        title={`Chat is unavailable for ${session.agent ?? 'this'} sessions.`}
        role="group"
        aria-disabled="true"
      >
        {contents}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...cardProps}
      onClick={() => onOpen(session.ownerId)}
    >
      {contents}
    </button>
  );
}

/**
 * WI-6668: the per-ITEM boundary — one malformed session row degrades to a
 * one-line placeholder instead of blanking the column and, via the /adv tab
 * boundary, the whole HUD. Same shape (and same reasoning) as the entity
 * board's SafeEntityCard; see RenderBoundary.tsx.
 *
 * Boundary INSIDE the memo so an unchanged row re-renders neither (WI-6560).
 * The label is optional-chained because computing it happens ABOVE the boundary.
 */
const MemoSessionCard = memo(
  function SafeSessionCard(props: { session: HudSession; onOpen: (ownerId: string) => void }) {
    /* WI-6755 — count the render React actually performed, and whether it was
       this instance's first. Counted at the TOP of the body, before any branch,
       so it is a workload bound-check and not a claim about an arm: a tab switch
       that reports `cardRenders === 0` genuinely did no card work, whereas the
       memo comparator's `compares === 0` is also what a full unmount looks like.
       See `hudRenderStabilitySwitch.cardRenders` for why they cannot substitute
       for one another. Cost is two integer increments per card render. */
    hudRenderStabilitySwitch.cardRenders++;
    const mounted = useRef(false);
    if (!mounted.current) {
      mounted.current = true;
      hudRenderStabilitySwitch.cardMounts++;
    }
    return (
      <RowBoundary
        label={props.session?.handle || props.session?.ownerId || 'This session'}
        scope="hud-card"
      >
        <SessionCard {...props} />
      </RowBoundary>
    );
  },
  /* WI-6560 — a DISPLAY-aware comparator, not memo's default shallow compare.
     `buildHudBoard` allocates a new session object on every 15s clock tick
     because `sinceSec` is raw seconds (720 -> 735), so the default compare
     missed on every card, every tick, while `formatAge` still printed "12m".
     `hudSessionRendersSame` compares what this card actually renders — see its
     docblock for why `sortKey` is excluded and why the rest is compared
     structurally rather than field-by-field. Unchanged DATA (as opposed to an
     unchanged render) is collapsed one level up by `reconcileBoardIdentity`. */
  (prev, next) => prev.onOpen === next.onOpen && hudSessionRendersSame(prev.session, next.session),
);

/* The unattributed-ask card used to live here — a full-width strip above the
   session columns, the coverage gate hud-consolidation-2026-07-26 P-002 put in
   place before the sidebar Inbox could be retired (D-001).
   `hud-session-launcher-and-board-tabs-2026-07-26` P-009 RE-HOMED it, it did
   not delete it: the owner's ask was that "the section show[ing] the work items
   above" become its own tab, so those asks now render as cards in the Work
   items board's needs-you column (`askToCard` in hud-entity-board.ts, deduped
   against the canonical work-item rows). The P-002 gate still holds — the asks
   are visible, in a place that names them — and this file no longer carries a
   second card renderer. */

function FleetChip({
  fleet,
  selected,
  onToggle,
}: {
  fleet: HudFleetRollup;
  selected: boolean;
  onToggle: (slug: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="hud__fleet"
      aria-pressed={selected}
      onClick={() => onToggle(fleet.fleetSlug)}
      style={fleet.fleetColor ? ({ '--hud-fleet': fleet.fleetColor } as React.CSSProperties) : undefined}
    >
      {/* Flex row on the inner span — see the WebKitGTK note on .hud__fleet
          in hud.css. */}
      <span className="hud__fleet-row">
        <span className="hud__fleet-swatch" aria-hidden="true" />
        <span>{fleet.label}</span>
        <span className="hud__fleet-n">{fleet.total}</span>
        {/* Present only when something is wrong, so the strip stays quiet when
            the fleet is healthy — an absent warning is itself information. */}
        {fleet.warning ? <span className="hud__fleet-warn">· {fleet.warning}</span> : null}
      </span>
    </button>
  );
}

/**
 * The plan filter's rows (P-004).
 *
 * Built as Combobox options rather than a second chip strip because plan slugs
 * are long (`hud-session-launcher-and-board-tabs-2026-07-26` is 44 chars) and
 * numerous — a chip per plan would wrap the filter row several times deep on a
 * narrow HUD rail. D-002 anticipated exactly this: the P-003 Combobox was built
 * "deliberately generic so P-004 (plan filter) … reuse[s] it rather than
 * growing more bespoke pickers". Behaviour still mirrors the fleet filter: the
 * options are derived from what is in view, each carries its count and the same
 * one-line health note, and there is an always-present row that clears it.
 */
function planFilterOptions(plans: HudBoardData['plans']): ComboboxOption[] {
  const inView = plans.reduce((n, p) => n + p.total, 0);
  return [
    {
      value: ALL_PLANS,
      label: 'All plans',
      // `board.total` would be the POST-filter count and would read as "1
      // session" while the list beneath it offers nine. Sum the rollups, which
      // are pre-filter by construction (see buildHudBoard).
      detail: `${inView} session${inView === 1 ? '' : 's'} in view`,
    },
    ...plans.map((p): ComboboxOption => ({
      value: p.planSlug ?? NO_PLAN_TOKEN,
      label: p.label,
      detail: `${p.total} session${p.total === 1 ? '' : 's'}${p.warning ? ` · ${p.warning}` : ''}`,
      // A human half-remembers "the HUD plan" or "hud tabs", not the date
      // suffix; cmdk scores keywords equally with the label.
      keywords: p.planSlug ? p.planSlug.split('-') : ['unbound', 'no plan'],
    })),
  ];
}

export default function HudBoard({
  board,
  selectedFleets,
  onToggleFleet,
  selectedPlans,
  onSelectPlan,
  focusColumn,
  onFocusColumn,
  suOnly,
  onToggleSuOnly,
  onOpenSession,
  loading,
  error,
  headerAction,
  sessionQuery = '',
  onSessionQuery,
  searchActive = false,
  sessionSearching = false,
  transcriptExtra = null,
  hiddenMachineHits = null,
  tab,
  onSelectTab,
  entityView,
}: HudBoardProps) {
  const needsYou = board.counts['needs-you'];
  const unattributedCount = board.unattributed.length;
  const visibleColumns = focusColumn
    ? board.columns.filter((c) => c.id === focusColumn)
    : board.columns;
  const onSessions = tab === 'sessions';

  const planOptions = useMemo(() => planFilterOptions(board.plans), [board.plans]);
  /* The control is single-select, so it shows the first selection; `ALL_PLANS`
     is the Combobox's `emptyValue`, which makes the box render its placeholder
     rather than the row's label while nothing is filtered. */
  const planValue = selectedPlans.length === 0
    ? ALL_PLANS
    : (selectedPlans[0] ?? NO_PLAN_TOKEN);

  return (
    <div className="hud">
      <header className="hud__heading">
        <div>
          <h1>Workspace activity</h1>
          <p>Follow your agents and keep work moving.</p>
        </div>
      </header>
      {/* The launcher owns a ROW OF ITS OWN, ABOVE the tab strip (owner ask
          2026-07-27, restated: "put the row with the new session button above the
          sessions / plans / work items tabs"). Its position has moved several
          times — far right of the strip behind a spacer, then after the tabs, then
          ahead of them, then onto its own row below the strip, and now that same
          row above it. Each ask was about a ROW, not about the order of controls
          inside the launcher; that is the reading these two document-order
          assertions in HudBoard.test.tsx pin.

          It stays OUTSIDE the tab bodies (and out of the `role="tablist"`, which
          must contain only tabs): launching a session is not a thing you do to the
          sessions board, it is a thing you do from the HUD, so hiding it behind a
          tab would make it unreachable from the two tabs most likely to make you
          want it.

          It is also a SIBLING of .hud__tabs rather than a child: that strip runs
          padding-bottom:0 + align-items:flex-end + a bottom border so the selected
          tab can BRIDGE the border (.hud__tab--on). A second line inside it would
          land under that border and break the bridge. The launch row and its
          control cluster both declare `justify-content:flex-start` in hud.css;
          that causal contract is what a live layout check should verify, not
          a bounding-rectangle gap that becomes degenerate when the rail is full. */}
      {headerAction ? <div className="hud__launchrow">{headerAction}</div> : null}

      {/* The tab strip owns its own row above the controls, not a slot inside
          them: the controls BELONG to a tab (fleet chips are a session idea),
          so nesting the switch among the things it switches would read as a
          sibling filter rather than the axis it is. */}
      <div className="hud__tabs">
        <div className="hud__tablist" role="tablist" aria-label="HUD board">
          {HUD_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`hud__tab${tab === id ? ' hud__tab--on' : ''}`}
              aria-selected={tab === id}
              // EI-18772095428507037: opt out of the adv shell's blanket
              // `box-shadow: none !important` on in-page buttons. That reset
              // targets DECORATIVE bevels; .hud__tab--on's shadow is STRUCTURAL
              // (it bridges the tab strip's border into the board below), and the
              // blanket rule silently stripped it with no way to tell.
              data-shadow-ok=""
              onClick={() => onSelectTab(id)}
            >
              <span className="hud__tab-row">{HUD_TAB_LABEL[id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className="hud__panel hud__panel--sessions"
        hidden={!onSessions}
        aria-hidden={!onSessions}
      >
      <div className="hud__top">
        {/* Owner ask 2026-08-02: "move the search sessions input to the left
            side instead of the right and highlight it so that it's very hard to
            miss". It used to render LAST in this row — past the plan filter, the
            agent toggle and every count chip, i.e. the far right of a wide board
            — wearing the same quiet .hud__search chrome as the entity tabs'
            filter boxes, so it read as one more muted chip and was routinely
            missed. It now LEADS the row and carries the --hero treatment
            (magnifier + accent ring + tinted well).

            ⚠ The clause that used to end this sentence — "the quiet base stays
            for HudEntityColumns" — no longer holds. [owner 2026-08-10] asked
            every HUD tab to share one highlighted box, so the markup moved into
            <HudSearchBox/> and HudEntityColumns renders the SAME control. Style
            changes belong in that component now, never inline here, or the two
            boards re-split exactly the way they had before.

            What it searches is the reason it is worth this much salience: every
            session's FULL TRANSCRIPT, not the card text. The roster carries only
            metadata, so "which session was I debugging the gym gate in" is
            unanswerable from the board itself.

            In this row (not .hud__fleets) for the same nowrap/overflow reason
            documented on the plan filter below. */}
        {onSessionQuery ? (
          <HudSearchBox
            value={sessionQuery}
            onChange={onSessionQuery}
            placeholder="Search transcripts…"
            ariaLabel="Search session transcripts"
            testId="hud-session-search"
            status={
              /* The slow pass, reported where you are already looking. Typing
                 filters the board on THIS keystroke; this says whether a wider
                 answer is still coming, so a pause reads as "still searching"
                 rather than "it ignored me" — the whole complaint behind the
                 2026-08-02 ask. role=status (not alert): it must reach a screen
                 reader without stealing focus from the box being typed in.

                 It rides in HudSearchBox's `status` slot so it stays INSIDE the
                 control's wrap, exactly where it rendered before the extraction. */
              searchActive &&
              (sessionSearching ||
                (transcriptExtra ?? 0) > 0 ||
                (hiddenMachineHits?.count ?? 0) > 0) ? (
                <span
                  className={`hud__search-status${sessionSearching ? ' hud__search-status--busy' : ''}`}
                  data-testid="hud-session-search-status"
                  role="status"
                >
                  {sessionSearching
                    ? 'transcripts…'
                    : (transcriptExtra ?? 0) > 0
                      ? `+${transcriptExtra} transcript${transcriptExtra === 1 ? '' : 's'}`
                      : null}
                  {/* WI-37912 — the page can come back SHORT because the
                      owner-visibility filter emptied the candidate pool before
                      the page filled (`loop wake` measured 16/30 with 74
                      hidden). The route discloses that; until this chip nothing
                      rendered it, so the user saw an unexplained short page and
                      had no way to tell "few matches" from "mostly filtered".

                      The trailing `+` is not decoration: `truncatedByLimit`
                      means the count was taken over a CAPPED pool, so it is a
                      floor. Rendering it bare would present a bounded
                      measurement as a total — the exact misread the route's own
                      boundedness marker exists to prevent. */}
                  {!sessionSearching && (hiddenMachineHits?.count ?? 0) > 0 ? (
                    <span
                      className="hud__search-status-hidden"
                      data-testid="hud-session-search-hidden"
                      title={
                        `${hiddenMachineHits!.count}${hiddenMachineHits!.truncatedByLimit ? ' or more' : ''} matching turns are machine-authored ` +
                        `(hook output, wake prompts, tool traces) and are not part of the owner's conversation, so they are not shown.`
                      }
                    >
                      {(transcriptExtra ?? 0) > 0 ? ' · ' : ''}
                      {hiddenMachineHits!.count}
                      {hiddenMachineHits!.truncatedByLimit ? '+' : ''} hidden
                    </span>
                  ) : null}
                </span>
              ) : null
            }
          />
        ) : null}

        {/* P-002 (owner asks 2026-07-26) put the launch cluster at the head of
            this row, ahead of the count chips. P-009 lifted it one level, into
            the tab strip above — it is a HUD-wide control, not a sessions-board
            one, and leaving it here would have made it vanish on the Plans and
            Work items tabs. The ordering the owner asked for is preserved: the
            launcher still leads, the counts still follow. */}
        {/* Owner ask 2026-07-27: "move the plan filter as the first filter
            before all agents". It previously sat at the END of this row, past a
            flex:1 .hud__spacer that right-aligned it — so on a wide board it was
            a screen-width away from the other filters it belongs with. It now
            leads the FILTER cluster, ahead of the su-only/all-agents toggle —
            behind only the transcript search, which took the head of the row
            under the 2026-08-02 ask above.

            Keeping it in .hud__top (not down in .hud__fleets) still matters for
            the original reason: .hud__fleets is nowrap + overflow-x:auto, so a
            picker appended there is reachable only by scrolling past every fleet
            chip (verified live 2026-07-26 — with 14 fleets it was entirely off
            screen). .hud__top wraps, so this stays visible at any width.

            `align="end"` is dropped with the right-alignment that motivated it:
            a leading control should open flush with its own left edge. */}
        {board.plans.length > 0 ? (
          <span className="hud__planfilter">
            <Combobox
              ariaLabel="Filter by plan"
              triggerClassName="hud__planfilter-box"
              testId="hud-plan-filter"
              value={planValue}
              emptyValue={ALL_PLANS}
              placeholder="All plans"
              emptyLabel="No plan matches"
              options={planOptions}
              onChange={(v) => onSelectPlan(v === NO_PLAN_TOKEN ? null : v)}
            />
          </span>
        ) : null}

        <Tooltip
          label={
            suOnly
              ? 'Currently showing your su sessions only. Include nursery cups and autonomous agents too.'
              : 'Currently showing every agent on the roster. Narrow back to your su sessions.'
          }
        >
          <button
            type="button"
            className="hud__count"
            aria-pressed={!suOnly}
            onClick={onToggleSuOnly}
          >
            <span className="hud__count-row">{suOnly ? 'su sessions' : 'all agents'}</span>
          </button>
        </Tooltip>

        <div className="hud__counts">
          {board.columns.map((c) => {
            const hot = c.id === 'needs-you' && c.sessions.length > 0;
            return (
              <Tooltip key={c.id} label={`Show only ${c.label}`}>
                <button
                  type="button"
                  className={`hud__count${hot ? ' hud__count--hot' : ''}`}
                  aria-pressed={focusColumn === c.id}
                  onClick={() => onFocusColumn(focusColumn === c.id ? null : c.id)}
                >
                  {/* Flex row on the inner span — see the WebKitGTK note on
                      .hud__count in hud.css. */}
                  <span className="hud__count-row">
                    <b>{c.sessions.length}</b> {c.label.toLowerCase()}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>

      </div>

      {board.fleets.length > 0 ? (
        <div className="hud__fleets">
          <Tooltip label="Show every fleet">
            <button
              type="button"
              className="hud__fleet"
              aria-pressed={selectedFleets.length === 0}
              onClick={() => onToggleFleet(ALL_FLEETS)}
            >
              <span className="hud__fleet-row">
                <span>all fleets</span>
                <span className="hud__fleet-n">{board.total}</span>
              </span>
            </button>
          </Tooltip>
          {board.fleets.map((f) => (
            <FleetChip
              key={f.fleetSlug ?? SOLO_FLEET_KEY}
              fleet={f}
              selected={selectedFleets.includes(f.fleetSlug)}
              onToggle={onToggleFleet}
            />
          ))}
        </div>
      ) : null}

      {/* The unattributed-ask strip that used to sit here now renders inside
          the Work items tab — see the note where UnattributedAskCard was. A
          pointer stays on the sessions board so the count is never simply
          gone: an ask nobody can see is the failure P-002 existed to prevent. */}
      {unattributedCount > 0 ? (
        <p className="hud__nudge">
          <button type="button" className="hud__count hud__count--hot" onClick={() => onSelectTab('items')}>
            <span className="hud__count-row">
              <b>{unattributedCount}</b> unattributed ask{unattributedCount === 1 ? '' : 's'} — open Work items
            </span>
          </button>
        </p>
      ) : null}

      {error ? (
        <p className="hud__state hud__state--error">
          Could not read the session roster: {error}
        </p>
      ) : loading && board.total === 0 ? (
        <p className="hud__state">Reading the session roster…</p>
      ) : board.total === 0 ? (
        <p className="hud__state">
          {/* A search that matched nothing must NOT render as "no sessions are
              running" — that reads as an empty roster and sends you looking for
              a launch bug instead of clearing the filter.

              Three states, not two, since the search became two passes: nothing
              matched YET but the slow pass is still running (say so, or a board
              that is about to fill reads as a final "no matches"), nothing
              matched at all, and no search at all. */}
          {searchActive
            ? sessionSearching
              ? 'No session card matches that yet — still searching transcripts…'
              : 'Nothing matched that search — neither the session cards nor their transcripts. Sessions whose history has not been indexed yet will not appear; clear the search to see the full board.'
            : suOnly
              ? 'No su sessions are running. Launch one with the psu command, or from the New session button — either way it appears here.'
              : 'No agents on the roster.'}
        </p>
      ) : (
        <div className="hud__cols" style={focusColumn ? { gridTemplateColumns: '1fr' } : undefined}>
          {visibleColumns.map((c) => (
            /* WI-6668: the per-SECTION boundary — one column's throw degrades
               THAT column to a retryable notice; the other four columns and the
               tab keep rendering. Classes are carried onto the fallback so the
               grid does not reflow around a missing column. */
            <SectionBoundary
              key={c.id}
              label={c.label}
              scope="hud-column"
              className={`hud__col hud__col--${c.id}`}
            >
              <section className={`hud__col hud__col--${c.id}`} aria-label={c.label}>
                <h3 className="hud__col-h">
                  {c.label}
                  <span className="n">{c.sessions.length}</span>
                </h3>
                <div className="hud__col-b">
                  {c.sessions.length === 0 ? (
                    <p className="hud__empty">{c.empty}</p>
                  ) : (
                    c.sessions.map((s) => (
                      <MemoSessionCard key={s.ownerId} session={s} onOpen={onOpenSession} />
                    ))
                  )}
                </div>
              </section>
            </SectionBoundary>
          ))}
        </div>
      )}

      {/* Screen-reader summary: the counts are the point of the board, and a
          five-column grid does not convey them linearly. */}
      <p className="sr-only" role="status">
        {needsYou > 0
          ? `${needsYou} session${needsYou === 1 ? '' : 's'} waiting on you.`
          : 'Nothing is waiting on you.'}
        {unattributedCount > 0
          ? ` ${unattributedCount} unattributed ask${unattributedCount === 1 ? '' : 's'} with no owning session, on the Work items tab.`
          : ''}
      </p>
      </div>

      <div
        className="hud__panel hud__panel--entities"
        hidden={onSessions}
        aria-hidden={onSessions}
      >
        {entityView ?? null}
      </div>
    </div>
  );
}
