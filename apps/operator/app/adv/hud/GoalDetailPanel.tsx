'use client';

/**
 * GoalDetailPanel (goal-mode-2026-08-07 P-021) — the goal opened from a HUD
 * goal card. The rail tab answers "is anything on fire"; this answers "I have
 * not looked in three days, what happened and what needs me".
 *
 * ── One query, one param ──────────────────────────────────────────────────
 * Everything on this page comes from `goals.detail` (resolveGoalDetail), which
 * already returns each section pre-shaped. A second query would be a second
 * clock: the pots grid and the spend chart are two readings of the same
 * ledger, and fetching them separately lets them disagree on screen.
 *
 * The open-state param is `hudgoal` — the SAME param the board uses for "the
 * selected goal", not a second `hudgoaldetail` key. Two params would let the
 * board sit scoped to goal A while this panel shows goal B, and there is no
 * reading of that screen that is not a lie about one of them. Closing the panel
 * therefore clears the selection, which is also what a second click on the card
 * does — the two exits agree.
 *
 * ⚠ `workspaceId` is REQUIRED and non-null here on purpose. `goals.detail`
 * defaults an absent workspace to the `'default'` tenant, which returns a goal
 * that renders as a healthy-looking empty page pointed at the wrong tenant (the
 * WI-5125 shape). HudView resolves the real id (`goalWorkspaceId`) for exactly
 * this reason; the type makes passing its nullable prop straight through a
 * compile error rather than a silent empty view.
 *
 * ── The frame is SessionChatModal's (P-018) ────────────────────────────────
 * [owner 2026-08-09] this popup "should mimic the design of the conversation
 * popup in the sessions tab". So it borrows that popup's shape wholesale: a
 * `pc-ctl-band--status` vitals band across the top, a scrolling body, a
 * collapsible `pc-zone` rail on the right, the popup widening to seat the rail
 * rather than crushing the body, and the rail becoming an overlay drawer on a
 * narrow window instead of silently doing nothing. The CLASSES are the same
 * ones, not lookalikes — a second vocabulary would drift the two popups apart
 * on the first restyle of either.
 *
 * IT BORROWS THE CONVERSATION TOO — see D-011 (which RETRACTED an earlier
 * ruling of mine; if you are reading that one, it is superseded).
 *
 * The retracted version said this popup should get the shape but no composer,
 * because "a goal is not a correspondent — there is nothing to send TO", and
 * offered a button routing out to the sessions popup instead. The premise was
 * sound and the conclusion did not follow. Mimicking a chat popup invites the
 * reader to expect a composer, and the owner's report is that expectation
 * arriving exactly as predicted: "I dont see a place to chat with the agent in
 * the goal popup like I do in the conversation popup". The reasoning had
 * treated "who is the message addressed to" as the design question when the
 * real one was "what does the reader expect to be able to do here". The goal's
 * AGENT is addressable, it is already on this very payload (`agents[]`), and
 * routing the owner elsewhere made this popup a dead end for the one action it
 * most obviously suggests.
 *
 * So the conversation is EMBEDDED, and embedded by REUSE: the same
 * `LiveSessionChat` the sessions popup renders, fed by the same
 * `useOwnerSessionChat` wiring. That is what keeps D-005 ("generalize
 * OperatorChat... never fork a second chat renderer") satisfied — the rule was
 * never "do not put a chat here", it was "do not build a SECOND one".
 * `onOpenAgent` survives as a secondary "open full-size" affordance, because
 * the embedded chat is width-constrained beside the work rail.
 *
 * ── P-023 (2026-08-10): the CONTROLS are borrowed too, not just the frame ───
 * [owner 2026-08-10] "mimic the design used in the equivalent popup in the
 * sessions tab for the hide and expand buttons instead of how it is currently
 * 'hide order hide brief etc.'"
 *
 * Which is the same rule as P-018/P-021, applied one level down and one level
 * later. This popup had grown the sessions popup's LAYOUT and its RAILS while
 * writing its own control vocabulary for them: five toggles that swapped their
 * own text ("Orders" → "Hide orders") where the sessions popup keeps a constant
 * label and moves a chevron. Both surfaces looked deliberate in isolation; side
 * by side one of them is wrong, and the owner is the one who has to notice.
 *
 * So the controls are SHARED CODE now, the same way the rails already are —
 * `PanelToggleButton` for the five toggles, `usePopupMaximize` for the expand
 * pair this popup previously had no equivalent of. Neither is a goal-flavoured
 * variant, so the next restyle of either popup lands in both.
 *
 * ⚠ SUPERSEDED IN PART BY WI-38428 (2026-08-13): the five directional toggles
 * described above are GONE from this popup. `GoalPanelVisibilityMenu` replaced
 * that row with one grouped checkbox popover, so this file no longer renders
 * `PanelToggleButton` and imports only PANEL_TOOLBAR_BUTTON_STYLE from it. The
 * expand pair (`usePopupMaximize`) and the shared toolbar style are still live
 * exactly as described. The popover is the later deliberate design — do not
 * reinstate the chevron row to make this paragraph true again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '@/app/harness/Modal';
import { Tooltip } from '@/app/harness/Tooltip';
import GoalWorkRail from './GoalWorkRail';
import GoalStatusControl from './GoalStatusControl';
// P-017: the hierarchy section. Its own file because it owns a WRITE (creating a
// subdirective) and this component is already long.
import SubGoalsSection from './SubGoalsSection';
// P-005: the launch-settings editor. Its own file for the same reason as the
// section above — it owns a WRITE (goals:update) and the form model behind it.
import GoalSettingsSection from './GoalSettingsSection';
import GoalEndsSection from './GoalEndsSection';
import GoalModeStateSection from './GoalModeStateSection';
/* D-011: the goal popup hosts the SAME conversation the sessions popup does —
   the same renderer, fed by the same extracted wiring. Not a second chat. */
import { LiveSessionChat } from '@/app/_components/chat/SessionChatModal';
import { useOwnerSessionChat } from '@/app/_components/chat/use-owner-session-chat';
/* ── P-023 [owner 2026-08-10]: the sessions popup's own hide/expand controls ──
   "mimic the design used in the equivalent popup in the sessions tab for the
   hide and expand buttons instead of how it is currently 'hide order hide
   brief etc.'"

   Both are SHARED with that popup rather than re-derived here — the same
   verbatim-reuse rule P-021 states for the rails and P-018 for the CSS. The
   hook carries the full-window/full-screen pair with its browser-vs-desktop
   split; PANEL_TOOLBAR_BUTTON_STYLE keeps this toolbar's buttons identical to
   the sessions popup's. NOTE we import the STYLE only, not PanelToggleButton
   itself — WI-38428 replaced this popup's chevron toggle row with
   GoalPanelVisibilityMenu, so the button has no call site here any more. */
import { PANEL_TOOLBAR_BUTTON_STYLE } from '@/app/_components/chat/PanelToggleButton';
import { usePopupMaximize } from '@/app/_components/chat/use-popup-maximize';
import { Maximize, Maximize2, MessagesSquare, Minimize, Minimize2, X } from 'lucide-react';
/* ── P-021 [owner 2026-08-10]: the sessions popup's three rails, IN ADDITION ──
   "the conversation popup for goals should have all the same left and right
   panels as the conversation popup in the sessions tab. the additional ones
   should be IN ADDITION not instead of."

   All three are imported VERBATIM — no forked copy, no goal-flavoured variant.
   That is the same D-005/D-012 rule the conversation itself already obeys here:
   the goal popup reuses the sessions popup's components and wiring, so a fix to
   any of them lands in both surfaces at once. Each takes an agent `ownerId`,
   which this panel already resolves as `primaryAgent`. */
import AgentOrders from '../sessions/AgentOrders';
import AgentDossier from '../sessions/AgentDossier';
import FleetPeersRail from '@/app/_components/chat/FleetPeersRail';
import { deriveFleetPeers } from '@/app/_components/chat/fleet-peers';
import GoalSessionsRail from './GoalSessionsRail';
import GoalPanelVisibilityMenu, { type GoalPanelVisibilityOption } from './GoalPanelVisibilityMenu';
import { deriveGoalSessions } from './goal-sessions';
import { advRosterArgs } from '@/lib/adv-roster-args';
import type { RosterEntry } from '../sessions/SessionsRosterView';
// pc-dossier__* — AgentDossier's stylesheet, imported the same way
// SessionChatModal imports it for the same reused rail. AgentOrders pulls its
// own CSS; FleetPeersRail's `pc-peers` lives in chat-controls.css, already
// imported below.
import '../sessions/SessionsRosterView.css';
// The conversation popup's own control vocabulary (pc-ctl-band, pc-zone,
// pc-peers). Imported rather than re-declared so P-018's "mimic" is literally
// the same CSS — see the docblock.
import '@/app/_components/chat/chat-controls.css';
// Self-sufficient, the way SessionChatModal imports this same sheet: the panel
// mounts on the Goals tab, where HudBoard (the file that otherwise pulls
// hud.css in) is not the rendered branch. It works today only because HudView
// imports HudBoard at module scope, which is an accident of import order rather
// than anything this component controls.
import './hud.css';
import {
  agoText,
  burnLine,
  ceilingLine,
  killCriterionLine,
  partitionPots,
  spendStack,
  tripwireBars,
  waitingCount,
  workRail,
  type GoalDetailInput,
  type GoalDetailPot,
  type TripwireBar,
} from './goal-detail-model';
import type { HudRosterEntry } from './hud-board-model';

/* The rail's two seatings, mirroring the conversation popup's rails exactly
   (DOSSIER_RAIL_SIDE_STYLE / _OVERLAY_STYLE in SessionChatModal). Side-by-side
   when there is room — the Modal widens below to make it — and an overlaying
   drawer when there is not, so the body is never crushed. */
const RAIL_WIDTH = 288;

const RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${RAIL_WIDTH}px`,
  width: RAIL_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

/* Overlaying rather than simply not rendering, for the reason SessionChatModal
   states for its own rails: a toggle that silently does nothing on a narrow
   window reads as a broken button, not as a layout decision. */
const RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(320px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

/** Below this the rail stops taking a column. The body wants ~560px and the
 *  rail 288, so two columns plus chrome need ~900. */
const RAIL_NARROW_MEDIA_QUERY = '(max-width: 900px)';

/* ── P-022 [owner 2026-08-10]: the goal BRIEF as its own left zone ────────
   "move the panel that houses this stuff … as another additional panel on the
   left, so the conversation takes up the full height like the conversation
   popups in the conversation tab".

   The brief used to be stacked ABOVE the conversation inside the centre column,
   which is precisely why the conversation could never run full height — it was
   pinned to whatever was left over (`flex: 0 0 46%`). Moving it into a zone
   BESIDE the conversation is what frees that column, so this constant and the
   `flex: 1` on the chat region are two halves of ONE change.

   Wider than the work rail (288): this zone carries prose — the goal body and
   the kill criterion — and a narrow measure makes a paragraph unreadable, where
   the work rail carries short rows that fit comfortably. */
const BRIEF_WIDTH = 340;

const BRIEF_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${BRIEF_WIDTH}px`,
  width: BRIEF_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

/* Below the breakpoint it overlays from the LEFT rather than taking a column —
   the same give-way pattern the work rail uses, mirrored to this edge. */
const BRIEF_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 'min(340px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

/* Wider than the work rail's 900px: the brief needs a real measure to stay
   readable, so it is the first of the two to give way under width pressure. */
const BRIEF_NARROW_MEDIA_QUERY = '(max-width: 1100px)';

/* ── P-021: the three BORROWED zones ────────────────────────────────────────
   Widths are the sessions popup's own, deliberately unchanged — a reader who
   opens Orders here and Orders there should get the same column, not a
   goal-flavoured near-copy. (SessionChatModal: orders 272, dossier 300,
   peers 248.)

   READING ORDER, left to right:
       Orders │ Brief │ conversation │ Work │ Activity │ Fleet
   Outermost is the most general, innermost the most specific to what is in
   front of the reader. So the agent's standing ORDERS sit outside this goal's
   BRIEF, and this goal's WORK sits inside the agent's ACTIVITY and FLEET. That
   keeps the sessions popup's own told → conversation → doing → who-with
   sequence intact while seating the goal's two zones next to the conversation
   they describe. DOM order matches, so the tab sequence agrees with the visual
   one — never a CSS `order` trick. */
const ORDERS_WIDTH = 272;
const DOSSIER_WIDTH = 300;
const PEERS_WIDTH = 248;

const ORDERS_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${ORDERS_WIDTH}px`,
  width: ORDERS_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const ORDERS_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 'min(300px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  /* Above the brief's own left-edge overlay (5): on a narrow window both
     collapse onto the SAME edge, and the one the reader opened last must not
     render underneath the other. Same rule the peers rail states against the
     dossier in SessionChatModal. */
  zIndex: 6,
};

const DOSSIER_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${DOSSIER_WIDTH}px`,
  width: DOSSIER_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const DOSSIER_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(320px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 6,
};

const PEERS_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${PEERS_WIDTH}px`,
  width: PEERS_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const PEERS_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(280px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  /* One above the dossier's overlay, which is itself one above the work rail's
     (5) — the three right-edge zones stack in the order they sit as columns. */
  zIndex: 7,
};

/* ── P-024 [owner 2026-08-10]: SESSIONS — who is working on this goal ───────
   "just put the pane on the right side, to the left of the 'WORK — what sits
   under this goal' pane. And when you implement the design mimic the design of
   the fleet leader/fleet member pane in the conversation popup."

   Hence PEERS_WIDTH exactly, not a width of its own: the owner asked for that
   pane's design, and the rows ARE that pane's rows (the same `pc-peer` two-line
   shape, the same COLUMN_WORD state words, imported rather than restated). A
   near-miss width is what would make it read as an imitation of the fleet rail
   instead of the same pane answering a different question. */
const SESSIONS_WIDTH = PEERS_WIDTH;

const SESSIONS_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${SESSIONS_WIDTH}px`,
  width: SESSIONS_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const SESSIONS_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(280px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  /* BELOW the work rail's 5, because the right-edge zones stack in the order
     they sit as columns and this one is now the INNERMOST of the four
     (Sessions 4 │ Work 5 │ Activity 6 │ Fleet 7). Giving it 5 like the rail
     would have two drawers tie on a narrow window, where the winner is DOM
     order rather than the layout's own rule. */
  zIndex: 4,
};

/** The four owner controls at the end of the vitals band move as ONE unit.
 *
 * The band wraps by design. At the desktop shell's real 1280px width, three
 * icon buttons used to fit on the first line while the wider Panels trigger
 * wrapped alone to the START of the second line. An open Orders drawer then
 * covered that exact spot, so the chooser could not hide the drawer that was
 * intercepting it. Keeping the cluster non-wrapping and end-aligned makes the
 * whole unit wrap to the clear conversation edge instead. The z-index sits one
 * above Fleet's outermost overlay (7), preserving that escape hatch when a
 * narrower viewport overlays a right-hand drawer too.
 *
 * This remains in normal flex flow rather than copying SessionChatModal's
 * absolute toolbar: these controls belong to the goal's vitals band, and flow
 * participation reserves their space instead of painting them over a status
 * chip. The button shape itself is still the shared
 * PANEL_TOOLBAR_BUTTON_STYLE used by both popups. */
const GOAL_PANEL_TOOLBAR_STYLE: React.CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  flexWrap: 'nowrap',
  alignItems: 'center',
  gap: 6,
  marginLeft: 'auto',
  position: 'relative',
  zIndex: 8,
};

/* ── The give-way ladder ────────────────────────────────────────────────────
   SEVEN zones cannot all be columns on an ordinary display, so each one names
   the viewport below which it can no longer HONESTLY seat as a column, and
   overlays instead. The numbers are derived, not chosen: the popup is
   `880 + (seated rail columns)` wide, capped at 97vw, where the 880 already
   covers the band, the brief and a ~540px conversation, and every seated column
   costs its own width + a 16px seam:

     Orders 288 │ Work 304 │ Activity 316 │ Fleet 264 │ Sessions 264

     all seven seated  880+288+304+316+264+264 = 2316 ⇒ needs ~2388px of viewport
     without Fleet     880+288+304+316    +264 = 2052 ⇒ needs ~2115
     also w/o Orders   880    +304+316    +264 = 1764 ⇒ needs ~1818
     also w/o Activity 880    +304        +264 = 1448 ⇒ needs ~1493

   (⇒ = total ÷ 0.97, the vw cap; each query then rounds DOWN to a clean number
   so the breakpoint fires slightly before the arithmetic demands it.)

   So the ladder is Fleet → Orders → Activity → Sessions → Brief (1100) →
   Work (900): the most SITUATIONAL zone yields first and the goal's OWN zones
   survive longest, because this is the goal popup — the reader came here for
   the goal, and the borrowed rails are context around it. Sessions sits inside
   the three borrowed ones (it is about THIS goal, not about the agent in
   general) and outside Brief and Work (those are the goal itself and what sits
   under it; who is working on it is the next question, not the first).

   ⚠ These are far wider than the sessions popup's equivalents (1400/1180/860)
   and that is correct rather than a transcription slip: there, three zones
   compete for the width; here, seven do. Copying those numbers across would
   seat columns that do not fit and crush the conversation to nothing.

   ⚠ Adding P-024's zone moved the three EXISTING rungs up by its 264px — a
   breakpoint is a statement about the whole seated set, so a new column that
   left them untouched would seat seven columns in the width six needed and
   crush the conversation at exactly the widths the ladder claims are safe. */
const PEERS_NARROW_MEDIA_QUERY = '(max-width: 2380px)';
const ORDERS_NARROW_MEDIA_QUERY = '(max-width: 2100px)';
const DOSSIER_NARROW_MEDIA_QUERY = '(max-width: 1810px)';
const SESSIONS_NARROW_MEDIA_QUERY = '(max-width: 1480px)';

/** Same matchMedia + effect shape SessionChatModal uses for its own rails.
 *
 *  P-021 SEEDS IT SYNCHRONOUSLY (it used to start `false` and let the effect
 *  correct it). That was harmless while this hook only chose a STYLE — one
 *  frame of the wrong style is invisible — and stopped being harmless the
 *  moment P-021 made the three borrowed rails' defaults ROOM-AWARE
 *  (`param ?? !isNarrow`). A hook that reports "wide" on the first render of a
 *  narrow window MOUNTS those panels, fires AgentOrders' carry-brief gather and
 *  AgentDossier's detail fetch, then unmounts them a frame later: a flash plus
 *  exactly the fetches the closed state exists to avoid. SessionChatModal hit
 *  this and fixed it the same way (WI-35470) — this is that fix, carried over
 *  with the rails rather than rediscovered.
 *
 *  The `typeof` guards keep it SSR-safe (no window ⇒ false, so the server still
 *  renders the column seating) and survive a test env whose jsdom lacks
 *  matchMedia. */
function useIsNarrowViewport(query: string): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [query]);
  return narrow;
}

export default function GoalDetailPanel({
  goalId,
  workspaceId,
  nowMs,
  onClose,
  onOpenWorkItem,
  onOpenAgent,
  onOpenGoal,
}: {
  /** The open goal — null renders nothing (closed). */
  goalId: string | null;
  /** The REAL workspace — never the nullable prop. See the docblock. */
  workspaceId: string;
  nowMs: number;
  onClose: () => void;
  /** Opens a work item in the HUD's existing popup, so the waiting-on-you and
   *  activity rows are destinations rather than dead text. */
  onOpenWorkItem?: (id: string) => void;
  /** P-018/D-011: opens the conversation of the agent RUNNING this goal, via
   *  the HUD's existing `hudsession` route. Optional — a host that cannot
   *  re-target the session popup passes nothing and the control is not
   *  rendered at all, rather than rendered dead. */
  onOpenAgent?: (ownerId: string) => void;
  /** P-017: re-targets this popup at another goal — used by the subdirective
   *  section to make "Subdirective of X" a destination. Optional: a host that
   *  cannot re-target passes nothing and the parent renders as text, never as a
   *  dead control. */
  onOpenGoal?: (goalId: string) => void;
}) {
  const open = goalId !== null;
  const detail = useSyncQuery<GoalDetailInput>({
    queryName: 'goals.detail',
    args: { workspaceId, goalId: goalId ?? '' },
    enabled: open,
  });

  // Single row wrapping the object — the shape goals.list and
  // automation.catalog already use.
  const data = detail.data?.[0] ?? null;
  const goal = data?.goal ?? null;

  const bars = useMemo(() => tripwireBars(goal), [goal]);
  const criterion = useMemo(() => killCriterionLine(goal), [goal]);
  const ceiling = useMemo(() => ceilingLine(goal), [goal]);
  const burn = useMemo(() => burnLine(goal, nowMs), [goal, nowMs]);
  const pots = useMemo(() => partitionPots(data?.pots), [data?.pots]);
  const stack = useMemo(() => spendStack(data?.spendByDay), [data?.spendByDay]);

  const waiting = data?.waitingOnYou ?? [];
  // P-006/D-018: the honest headline. `waiting.length` is a CAPPED row count, so
  // it is used only for what is on screen — never as the number we claim.
  const waitingN = useMemo(() => waitingCount(data), [data]);

  // The band chip is a jump, not a navigation: the section it targets is already
  // in this popup, so re-routing would be theatre. Focus moves WITH the scroll —
  // a scroll alone leaves a keyboard user's focus stranded in the band, which is
  // the accessibility half of "the count goes nowhere".
  const waitingSectionRef = useRef<HTMLElement | null>(null);
  const jumpToWaiting = useCallback(() => {
    const el = waitingSectionRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }, []);
  const activity = data?.activity ?? [];
  const rail = useMemo(() => workRail(data, nowMs), [data, nowMs]);

  /* nuqs, not useState: the rail's open-state is user-meaningful (it survives a
     reload and a shared link), and CLAUDE.md's rule is that anything
     user-meaningful goes in the URL where `ui:get_state`/`ui:dispatch` can see
     it. Defaulted OPEN — the rail is the answer to "what is under this goal",
     which is the question the popup exists to answer. */
  const [railOpen, setRailOpen] = useQueryState('hudgoalrail', parseAsBoolean.withDefault(true));
  const isRailNarrow = useIsNarrowViewport(RAIL_NARROW_MEDIA_QUERY);
  /* P-022: the brief's own open-state, in the URL like every other
     user-meaningful toggle here (`hudgoalrail` set the precedent). */
  const [briefOpen, setBriefOpen] = useQueryState('hudgoalbrief', parseAsBoolean.withDefault(true));
  const isBriefNarrow = useIsNarrowViewport(BRIEF_NARROW_MEDIA_QUERY);
  const briefVisible = open && briefOpen;
  const railVisible = open && railOpen;
  /* Widen ONLY when the rail is actually seated as a column. On a narrow window
     it overlays, so widening there would grow the popup for a rail that is not
     taking any width — the mistake SessionChatModal's own comment calls out. */
  const railColumns = railVisible && !isRailNarrow ? RAIL_WIDTH + 16 : 0;

  /* D-006: one directed agent, one goal — so this is the normal case. A second
     stamp is surfaced rather than hidden (see the resolver), but the band's
     control targets the most recent, which is the one a reader means by "the
     agent running this goal". */
  const agents = data?.agents ?? [];
  const primaryAgent = agents[0] ?? null;

  /* D-011: the live conversation with the agent running this goal. Passing null
     when there is no agent is what keeps the hook from resolving a session or
     opening a stream — an agent-less goal must render a plain statement, never
     an inert composer that looks live and can reach nobody. */
  const chat = useOwnerSessionChat(primaryAgent?.ownerId ?? null);
  /* Only a MOUNTED transcript claims height. Every other state (no agent,
     resolving, no session, error) is a single line. */
  const chatLive = Boolean(primaryAgent && chat.resolved && chat.streamUrl);

  /* ── P-021: the three borrowed zones ──────────────────────────────────────
     Every one of them describes the AGENT, so all three are gated on there
     being an agent at all. An agent-less goal renders none of them and shows no
     toggles for them — the same rule D-011 already applies to the conversation
     here: never a control that looks live and can reach nobody. */
  const agentOwnerId = primaryAgent?.ownerId ?? null;

  /* ONE roster read feeding both the dossier and the fleet rail.
     `useSyncQuery` caches by {queryName, args}, so this is a second READER of
     the row the sessions popup and the HUD board already hold — not a third
     fetch of the same payload. Same reasoning SessionChatModal records for
     re-using its own `actionRoster` row two ways. */
  const roster = useSyncQuery<{ active?: HudRosterEntry[]; pending?: HudRosterEntry[] }>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
  });

  /* AgentDossier's own prop shape. `RosterEntry` and `HudRosterEntry` are two
     independently-inlined TS projections of the IDENTICAL server payload, so
     the already-fetched row satisfies it structurally at runtime — cast rather
     than re-query, exactly as SessionChatModal does for the same rail. */
  const dossierEntry = useMemo<RosterEntry | null>(() => {
    const payload = roster.data?.[0];
    if (!payload || !agentOwnerId) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    const found = entries.find((e) => e.ownerId === agentOwnerId);
    return found ? (found as unknown as RosterEntry) : null;
  }, [roster.data, agentOwnerId]);

  /* null when this agent is in no fleet, which is the common case for a goal's
     directed agent — the rail is then not rendered at all rather than rendered
     empty. The derivation lives in the unit-tested module beside the rail; this
     panel only supplies the inputs. */
  const fleetPeers = useMemo(() => {
    const payload = roster.data?.[0];
    if (!payload || !agentOwnerId) return null;
    return deriveFleetPeers(payload.active ?? [], agentOwnerId, { nowMs });
  }, [roster.data, agentOwnerId, nowMs]);

  /* P-024: the SESSIONS model, off the SAME roster row the dossier and the
     fleet rail already read — a third reader, not a third fetch.

     Two deliberate differences from `fleetPeers` above:

     1. It is fed `active` AND `pending`. A session that is still launching is
        already working this goal in every sense the reader cares about, and the
        derivation keeps ENDED ones on purpose (a finished test agent is
        evidence the testing happened), so filtering the payload down to the
        live set here would silently defeat both.
     2. It takes EVERY stamped ownerId, not just `agentOwnerId`. D-006's
        "one directed agent" is the normal case, not a guarantee — the resolver
        surfaces a second stamp rather than hiding it, and membership leg 2
        walks the fleets of the stamped set, so passing only the primary would
        drop a second agent's whole fleet from the answer to "who is working on
        this goal".

     null when the goal has no agent stamp at all: the five sections exist to
     report COVERAGE GAPS in a goal that is running, and a goal that has not
     started has no gaps to report — the popup already says so in the
     conversation region, and an all-empty rail beside that sentence would be
     saying it a sixth time. */
  const goalSessions = useMemo(() => {
    const payload = roster.data?.[0];
    const stamped = agents.map((a) => a.ownerId).filter((id): id is string => Boolean(id));
    if (!payload || stamped.length === 0) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    return deriveGoalSessions(entries, stamped, { nowMs });
  }, [roster.data, agents, nowMs]);

  /* ROOM-AWARE defaults (`param ?? !isNarrow`), the pattern the sessions popup
     already uses for these same two rails — NOT `withDefault(true)`. With six
     zones competing, defaulting them open would stack two or three overlay
     drawers over the conversation the moment the popup opens on an ordinary
     display. Open where there is room, closed where there is not, and the
     reader's own choice overrides both and persists in the URL.

     This is why `useIsNarrowViewport` had to start seeding synchronously — see
     its docblock. */
  const isOrdersNarrow = useIsNarrowViewport(ORDERS_NARROW_MEDIA_QUERY);
  const [ordersParam, setOrdersOpen] = useQueryState('hudgoalorders', parseAsBoolean);
  const ordersOpen = ordersParam ?? !isOrdersNarrow;

  const isDossierNarrow = useIsNarrowViewport(DOSSIER_NARROW_MEDIA_QUERY);
  const [dossierParam, setDossierOpen] = useQueryState('hudgoalactivity', parseAsBoolean);
  const dossierOpen = dossierParam ?? !isDossierNarrow;

  const isPeersNarrow = useIsNarrowViewport(PEERS_NARROW_MEDIA_QUERY);
  const [peersParam, setPeersOpen] = useQueryState('hudgoalfleet', parseAsBoolean);
  const peersOpen = peersParam ?? !isPeersNarrow;

  /* P-024: room-aware like the three above rather than `withDefault(true)`.
     It is the seventh zone competing for the width, so a hard default-open
     would put a drawer over the conversation on any ordinary display. */
  const isSessionsNarrow = useIsNarrowViewport(SESSIONS_NARROW_MEDIA_QUERY);
  const [sessionsParam, setSessionsOpen] = useQueryState('hudgoalsessions', parseAsBoolean);
  const sessionsOpen = sessionsParam ?? !isSessionsNarrow;

  const ordersVisible = open && ordersOpen && Boolean(agentOwnerId);
  const dossierVisible = open && dossierOpen && Boolean(agentOwnerId);
  /* Unlike the other two this also needs a MODEL: an agent in no fleet has no
     peers to show, so there is nothing to seat. */
  const peersVisible = open && peersOpen && Boolean(agentOwnerId) && fleetPeers != null;
  /* Same model gate as the fleet rail, for the same reason — nothing to seat.
     NOT gated on `agentOwnerId`: the model already requires a stamp, and this
     zone describes the GOAL rather than the agent, so a goal whose agent has
     since ended still has sessions worth showing. */
  const sessionsVisible = open && sessionsOpen && goalSessions != null;

  /* ── P-023: maximize, the sessions popup's own pair ───────────────────────
     Its own URL key (`hudgoalmax`, never the sessions popup's `chatMax`): both
     popups can be open at once in the HUD, and one key would have them
     maximizing each other. Everything else — the two modes, the desktop split,
     the fullscreen-exit sync, Esc, the never-strand-the-display cleanups — is
     the shared hook's. */
  const {
    mode: goalMax,
    maximized,
    screenActive,
    screenMechanism,
    popupRef,
    toggleWindow,
    toggleScreen,
    reset: resetMaximize,
  } = usePopupMaximize({ param: 'hudgoalmax', open });

  /* Leaving the popup must not strand the display or leave the mode in the URL —
     reopening any goal would otherwise inherit a maximize it was never given. */
  const closePanel = useCallback(() => {
    resetMaximize();
    onClose();
  }, [resetMaximize, onClose]);

  /* Each seated column widens the popup; an OVERLAYING one must not, or the
     popup grows to make room for a rail that is taking no width. */
  const borrowedColumns =
    (ordersVisible && !isOrdersNarrow ? ORDERS_WIDTH + 16 : 0) +
    (dossierVisible && !isDossierNarrow ? DOSSIER_WIDTH + 16 : 0) +
    (peersVisible && !isPeersNarrow ? PEERS_WIDTH + 16 : 0) +
    /* P-024. Same "only while actually SEATED" test as its four neighbours:
       widening the popup for a zone that is overlaying would grow it for a
       column taking no width. */
    (sessionsVisible && !isSessionsNarrow ? SESSIONS_WIDTH + 16 : 0);

  /* P-025 [owner 2026-08-13]: the six directional toolbar controls became one
     explicit visibility chooser. The underlying states and URL keys stay the
     same — this is a clearer control surface over the existing behavior, not a
     second panel system. Unavailable rows are omitted on the same gates as the
     zones themselves, so the chooser never offers a checkbox that cannot seat
     anything. */
  const panelVisibilityOptions: GoalPanelVisibilityOption[] = [
    ...(agentOwnerId
      ? [{
          id: 'orders',
          label: 'Orders',
          side: 'left' as const,
          checked: ordersOpen,
          onChange: (checked: boolean) => void setOrdersOpen(checked),
          testId: 'goal-orders-toggle',
        }]
      : []),
    {
      id: 'brief',
      label: 'Brief',
      side: 'left',
      checked: briefOpen,
      onChange: (checked) => void setBriefOpen(checked),
      testId: 'goal-brief-toggle',
    },
    ...(goalSessions
      ? [{
          id: 'sessions',
          label: 'Sessions',
          side: 'right' as const,
          checked: sessionsOpen,
          onChange: (checked: boolean) => void setSessionsOpen(checked),
          testId: 'goal-sessions-toggle',
        }]
      : []),
    {
      id: 'work',
      label: 'Work',
      side: 'right',
      checked: railOpen,
      onChange: (checked) => void setRailOpen(checked),
      testId: 'goal-rail-toggle',
    },
    ...(agentOwnerId
      ? [{
          id: 'activity',
          label: 'Activity',
          side: 'right' as const,
          checked: dossierOpen,
          onChange: (checked: boolean) => void setDossierOpen(checked),
          testId: 'goal-activity-toggle',
        }]
      : []),
    ...(agentOwnerId && fleetPeers
      ? [{
          id: 'fleet',
          label: 'Fleet',
          side: 'right' as const,
          checked: peersOpen,
          onChange: (checked: boolean) => void setPeersOpen(checked),
          testId: 'goal-fleet-toggle',
        }]
      : []),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) closePanel();
      }}
      title={goal?.title?.trim() || goalId || 'Goal'}
      description="Goal detail"
      srOnlyTitle
      /* P-023: while the browser is painting this popup fullscreen, Esc is the
         user's way OUT of fullscreen — the UA consumes it and never dispatches
         the keydown. Leaving the dialog's own Esc handler armed means one press
         both drops fullscreen and closes the goal, so the popup disappears when
         the reader only asked for a smaller window. (The desktop path has its
         own Esc handler inside the hook, for the mirror-image reason.) */
      closeOnEscape={!screenActive}
      wrapStyle={maximized ? { padding: 0 } : undefined}
      /* The conversation popup's own frame: flex column, no padding of its own
         (the bands and body own their spacing), and a width that grows to seat
         the rail instead of squeezing the body. */
      contentStyle={
        maximized
          ? {
              // Fill the app window edge to edge. `100dvh` rather than `100vh`
              // so a mobile/overlay browser chrome bar cannot push the
              // conversation's composer below the fold.
              width: '100vw',
              maxWidth: 'none',
              height: '100dvh',
              maxHeight: '100dvh',
              borderRadius: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }
          : {
              /* P-021: the borrowed zones widen the popup on the same terms the
                 work rail already does — only while they are actually seated as
                 columns. The 97vw cap is what keeps the arithmetic honest on a
                 display too narrow for everything the breakpoints allowed. */
              width: `min(${880 + railColumns + borrowedColumns}px, ${railColumns + borrowedColumns > 0 ? 97 : 92}vw)`,
              height: 'min(80vh, 820px)',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }
      }
    >
      <div
        /* D-007's rule, borrowed with the hook: the fullscreen target is the
           container that holds EVERY zone, so a panel added later is included
           by construction. Pointing it at the centre column instead would drop
           all five rails the moment the reader hit full screen. */
        ref={popupRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
          // A DOM-fullscreened element is transparent by default (the UA paints
          // only ::backdrop, black), so without this the zones would sit on bare
          // black instead of the popup's surface. Scoped to the browser
          // mechanism: on the desktop path nothing is lifted out of the page.
          ...(screenMechanism === 'document' ? { background: 'var(--bg-popover, #0d1829)' } : null),
        }}
        data-testid="goal-detail-modal"
      >
        {/* ── ORDERS (P-021) — the outermost LEFT zone ──────────────────────
            What the agent running this goal was TOLD: mission and authority,
            modes and who set them, owner directives, standing facts, walls, the
            carry brief. It sits OUTSIDE the centre column on purpose, so the
            vitals band does not span it: that band is the GOAL's glance, and
            these orders are about the AGENT. The same reason the band already
            stops short of the work rail. */}
        {ordersVisible ? (
          <div
            className="pc-zone pc-zone--orders"
            data-testid="goal-orders-rail"
            style={isOrdersNarrow ? ORDERS_OVERLAY_STYLE : ORDERS_SIDE_STYLE}
          >
            <AgentOrders
              ownerId={agentOwnerId ?? ''}
              /* Gates the carry-brief gather: a closed zone must not fetch. */
              enabled={ordersVisible}
              onClose={() => void setOrdersOpen(false)}
            />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* ── VITALS BAND ─────────────────────────────────────────────────
              SessionChatModal's `SessionStateHeader` in goal vocabulary: the
              handful of facts that decide whether the reader needs to act,
              before any scrolling. Status, what ends the goal, what it has
              spent against its ceiling, and how many things are parked on the
              owner — the four the goal card promises and used to make the
              reader hunt for. */}
          <div
            className="pc-ctl-band pc-ctl-band--status"
            data-testid="goal-vitals"
            role="status"
          >
            <span className="pc-zone-cap">Goal</span>
            {goal?.status ? (
              <span className="pc-ctl-state" title={`Status: ${goal.status}`}>
                <span className="pc-ctl-state__dot" aria-hidden="true" />
                {goal.status}
              </span>
            ) : null}
            {/* P-016 — the status LEVER, beside the readout rather than on it. The pill
                above stays a pure readout: it moves when the STORE moves, so a failed
                write cannot leave it lying. Panel variant, so the terminal moves are
                here (behind a confirm) and the card keeps only the reversible pair. */}
            {goal ? (
              <GoalStatusControl
                goalId={goal.id}
                status={goal.status}
                effectiveStatus={data?.effectiveStatus}
                holderLiveness={data?.holderLiveness}
                variant="panel"
              />
            ) : null}
            {goal ? (
              <span
                className={`pc-ctl-state${criterion.missing ? ' pc-ctl-state--warn' : ''}`}
                title={criterion.text}
              >
                <span className="pc-ctl-band__label">ends when</span>
                <span className="pc-ctl-state__clip">{criterion.text}</span>
              </span>
            ) : null}
            {goal ? (
              <span
                className={`pc-ctl-state${ceiling.over ? ' pc-ctl-state--bad' : ''}`}
                title={data?.spendNote ?? undefined}
              >
                <span className="pc-ctl-band__label">{data?.spendLabel ?? 'fleet spend'}</span>
                {ceiling.text}
              </span>
            ) : null}
            {/* P-006/D-018 — the one number on this surface the OWNER can
                personally clear, so it is a control rather than a readout. The
                card's chip cannot be (HudEntityColumns makes the whole card a
                <button>, and a nested button is invalid HTML — see that file's
                P-016 docblock); this band is a plain <div> that already seats
                three buttons, so here it is legal.

                Tooltip, NOT a `title=` attribute: a native title is unreachable
                by keyboard and on touch, and `lint:design-primitives` fails a
                title on a <button> for exactly that reason — a green-checkpoint
                LEG, so it is a fleet-wide red rather than a style nit. Same note
                as the "Open full-size" control below. */}
            {waitingN.label ? (
              <Tooltip label="Jump to the items parked on you" side="bottom">
                <button
                  type="button"
                  className="pc-ctl-state pc-ctl-state--warn pc-ctl-state--action"
                  data-testid="goal-waiting-jump"
                  onClick={jumpToWaiting}
                >
                  {waitingN.label}
                </button>
              </Tooltip>
            ) : null}

            <span className="pc-ctl-band__spacer" />

            <div style={GOAL_PANEL_TOOLBAR_STYLE} data-testid="goal-panel-toolbar">
            {/* D-011: the ONE conversation affordance — a route to the agent's
                existing conversation, never a composer of this popup's own.
                Rendered only when there IS an agent and the host can route to
                it, so it is never a button that looks live and is not. */}
            {primaryAgent && onOpenAgent ? (
              /* The shared Tooltip primitive, NOT a `title=` attribute — a
                 native title is unreachable by keyboard and on touch, and
                 `lint:design-primitives` fails a title on a <button> for
                 exactly that reason (it is a green-checkpoint LEG, so this is
                 a fleet-wide red, not a style nit). FleetPeersRail carries the
                 same note over the same decision. */
              <Tooltip
                label={`Open this conversation full-size in the sessions popup (${primaryAgent.ownerId})`}
                side="bottom"
              >
                <button
                  type="button"
                  className="pc-button"
                  data-testid="goal-open-agent"
                  onClick={() => onOpenAgent(primaryAgent.ownerId)}
                  aria-label="Open conversation full-size"
                  style={PANEL_TOOLBAR_BUTTON_STYLE}
                >
                  <MessagesSquare size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {/* ── P-023: the EXPAND pair, ahead of the zone toggles ──────────
                [owner 2026-08-10] this popup should carry the sessions popup's
                "hide and expand buttons". These are that popup's two, verbatim
                in behavior (the shared hook) and in look (icon-only, tooltip,
                the same compact toolbar button) — full WINDOW and full SCREEN
                are genuinely different modes on the desktop, which is why there
                are two and not one.

                They lead the trailing cluster the way they lead the sessions
                popup's toolbar: they act on the WHOLE popup, where every toggle
                after them acts on one zone inside it.

                Tooltip, NOT a `title=` attribute: these are ICON-ONLY, so the
                hover text is the only place their meaning is written for a
                sighted user — and `lint:design-primitives` fails a title on a
                <button> because a native title is unreachable by keyboard and
                on touch. Same note as "Open full-size" above. */}
            <Tooltip
              label={goalMax === 'window' ? 'Exit full window' : 'Fill the app window with this goal'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleWindow}
                aria-pressed={goalMax === 'window'}
                aria-label={goalMax === 'window' ? 'Exit full window' : 'Full window'}
                data-testid="goal-full-window"
                style={PANEL_TOOLBAR_BUTTON_STYLE}
              >
                {goalMax === 'window' ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            <Tooltip
              label={screenActive ? 'Exit full screen' : 'Fill the whole screen with this goal'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleScreen}
                aria-pressed={screenActive}
                aria-label={screenActive ? 'Exit full screen' : 'Full screen'}
                data-testid="goal-full-screen"
                style={PANEL_TOOLBAR_BUTTON_STYLE}
              >
                {screenActive ? <Minimize size={12} aria-hidden="true" /> : <Maximize size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            {/* P-025: one chooser answers "which panels are visible?" without
                turning the status band into a row of directional glyphs. The
                grouped order still mirrors the layout — Orders/Brief on the
                left, then Sessions/Work/Activity/Fleet on the right. */}
            <GoalPanelVisibilityMenu options={panelVisibilityOptions} />
            {/* Maximized covers the backdrop, and in full screen Esc is spoken
                for — so without an explicit ✕ there is no way out of this popup
                but the two expand buttons. (Unmaximized, the Modal's own
                backdrop and Esc are the exits, so it would be a third one.) */}
            {maximized ? (
              <Tooltip label="Close goal" side="bottom" align="end">
                <button
                  type="button"
                  className="pc-button"
                  onClick={closePanel}
                  aria-label="Close goal"
                  data-testid="goal-close"
                  style={PANEL_TOOLBAR_BUTTON_STYLE}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            </div>
          </div>

          {/* ── P-022: BRIEF │ CONVERSATION ────────────────────────────────────
              Everything below the vitals band is a ROW, not a stack. That single
              change is what gives the conversation its full height: it used to
              sit UNDER the scrolling brief in this column, so it could only ever
              have the leftover space (and was pinned to `0 0 46%` to stop the
              brief crowding it out entirely).

              The band stays ABOVE this row, spanning both — it is the goal's
              glance, and it reads as a header for the brief and the conversation
              alike rather than belonging to either one.

              DOM order is brief → conversation, matching the left-to-right
              reading order, which is why this is a real reorder and not a CSS
              `order` trick: `order` would leave the tab sequence contradicting
              the visual one. Same reasoning SessionChatModal gives for keeping
              its own rails in reading order. */}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}>
          {/* The brief zone. A SIBLING of the conversation, never a parent of
              it — the layout contract every rail in this popup and in
              SessionChatModal holds to. */}
          {briefVisible ? (
          <div
            className="pc-zone pc-zone--brief"
            data-testid="goal-brief-rail"
            style={isBriefNarrow ? BRIEF_OVERLAY_STYLE : BRIEF_SIDE_STYLE}
          >
          {/* The scrolling body. `minHeight: 0` is load-bearing inside a flex
              column — without it the body grows past the popup instead of
              scrolling within it, and the vitals band scrolls away with it. */}
          <div className="hud-goal" data-testid="goal-detail" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <header className="hud-goal__head">
              <div className="hud-goal__title-row">
                <h2 className="hud-goal__title">{goal?.title?.trim() || goalId}</h2>
                {/* The status chip moved UP into the vitals band (P-018) rather
                    than being rendered in both places. Two copies of one status
                    is how a stale one goes unnoticed — the band is the glance,
                    so the band owns it. */}
              </div>
              {goal?.body?.trim() ? <p className="hud-goal__body">{goal.body.trim()}</p> : null}
            </header>

        {detail.loading && !data ? <p className="hud__state">Loading goal…</p> : null}
        {detail.error ? (
          <p className="hud__state hud__state--error">Could not load this goal: {String(detail.error)}</p>
        ) : null}
        {!detail.loading && !detail.error && data && !goal ? (
          <p className="hud__state">
            This goal no longer exists. It may have been deleted since the board last loaded.
          </p>
        ) : null}

        {goal ? (
          <>
            {/* ── 1. THIS GOAL ENDS WHEN ──────────────────────────────────
                First, and first for a reason: it is the only section that says
                when the goal STOPS. Everything below it describes activity,
                which a goal with no stopping condition will produce forever.

                Its own component since P-009 made both values EDITABLE here —
                the alarm now carries the control that resolves it. The display
                lines stay computed HERE because the vitals band above renders
                `criterion` and `ceiling` a second time, and the bars arrive as
                a slot so `TripwireRow` (P-012) stays in this file. */}
            <GoalEndsSection
              goalId={goalId ?? null}
              killCriterion={goal.killCriterion}
              budgetCents={goal.budgetCents}
              criterion={criterion}
              ceiling={ceiling}
              burn={burn}
              spendLabel={data?.spendLabel}
              spendNote={data?.spendNote}
              tripwires={
                bars.length > 0 ? (
                  <ul className="hud-goal__bars" data-testid="goal-tripwires">
                    {bars.map((b) => (
                      <TripwireRow key={b.key} bar={b} />
                    ))}
                  </ul>
                ) : null
              }
            />

            {/* P-009 (shared-agent-obligations-and-briefs-2026-09-05): one
                read-only rendering of the exact turn-start projection the
                goal holder receives. It belongs in the existing Brief zone,
                directly after the stop conditions, rather than becoming an
                eighth independent rail or a client-side policy engine. */}
            <GoalModeStateSection state={data?.goalModeState} />

            {/* ── 2. WAITING ON YOU ───────────────────────────────────────
                Above pots and activity because it is the only section the
                owner can ACT on — the rest is read-only reporting. */}
            {/* ── 2b. SUBDIRECTIVES (P-017) ───────────────────────────────
                Above "Waiting on you" on purpose: this section answers "what is
                this agent pointed at", which frames every ask below it. */}
            {goalId ? (
              <SubGoalsSection
                goalId={goalId}
                subGoals={data?.subGoals}
                parent={data?.parent}
                onOpenGoal={onOpenGoal}
              />
            ) : null}

            {/* ── 2c. LAUNCH SETTINGS (goal-mode-hardening P-005 / D-007) ──
                Directly after subdirectives, and for the same reason they sit
                here: both answer "what is this agent allowed to do" — the
                directions it is pointed in, then the ceiling on how much it may
                spawn pursuing them. */}
            {goalId ? (
              <GoalSettingsSection
                goalId={goalId}
                settings={data?.launchSettings}
                settingsInvalid={data?.launchSettingsInvalid}
                settingsUnknownKeys={data?.launchSettingsUnknownKeys}
                options={data?.launchSettingsOptions}
                defaults={data?.launchSettingsDefaults}
              />
            ) : null}

            {/* tabIndex -1: focusable by the band's jump control, but never a
                tab stop of its own — the rows below are the real stops. */}
            <section
              className="hud-goal__section"
              ref={waitingSectionRef}
              tabIndex={-1}
              data-testid="goal-waiting-section"
            >
              <h3 className="pc-zone-title">
                Waiting on you
                {/* The TOTAL, not the row count — the list below stops at 25 and
                    the note says so. Rendering the capped length here is what
                    made the card ("31 needs you") and this panel ("25") disagree. */}
                {(waitingN.total ?? waitingN.shown) > 0 ? (
                  <span className="hud__chip hud__chip--warn">{waitingN.total ?? waitingN.shown}</span>
                ) : null}
                {waitingN.note ? (
                  <span className="pc-zone-title__sub" data-testid="goal-waiting-note">
                    {waitingN.note}
                  </span>
                ) : null}
              </h3>
              {waiting.length === 0 ? (
                <p className="hud-goal__empty">Nothing is parked on you.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {waiting.map((w) => (
                    <li key={w.id} className="hud-goal__row">
                      <RowButton id={w.id} title={w.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {w.harnessSlug ?? '—'} · {agoText(w.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 3. POTS ─────────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="pc-zone-title">Pots</h3>
              {pots.active.length === 0 && pots.removed.length === 0 ? (
                <p className="hud-goal__empty">No pots serve this goal yet.</p>
              ) : null}
              {pots.active.length > 0 ? (
                <div className="hud-goal__grid" data-testid="goal-pots">
                  {pots.active.map((p) => (
                    <PotCard key={p.harnessSlug} pot={p} />
                  ))}
                </div>
              ) : null}

              {/* Killed pots STAY, greyed. If they vanished, the page would
                  only ever show growth — and "the agent actually closes things"
                  is the one behaviour the owner most needs to confirm, so it
                  must stay visible exactly when it is working. */}
              {pots.removed.length > 0 ? (
                <>
                  <h4 className="hud-goal__h4">Closed ({pots.removed.length})</h4>
                  <div className="hud-goal__grid" data-testid="goal-pots-closed">
                    {pots.removed.map((p) => (
                      <PotCard key={p.harnessSlug} pot={p} nowMs={nowMs} />
                    ))}
                  </div>
                </>
              ) : null}
            </section>

            {/* ── 4. ACTIVITY ─────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="pc-zone-title">Activity</h3>
              {activity.length === 0 ? (
                <p className="hud-goal__empty">Nothing has moved under this goal yet.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {activity.map((a) => (
                    <li key={a.id} className="hud-goal__row">
                      <span
                        className={`hud__dot hud__dot--${a.closedAt ? 'done' : 'working'}`}
                        aria-hidden="true"
                      />
                      <RowButton id={a.id} title={a.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {a.closedAt ? 'closed' : (a.status ?? 'open')} ·{' '}
                        {agoText(a.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 5. SPEND BY DAY ─────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="pc-zone-title">{data?.spendLabel ?? 'fleet spend'} by day</h3>
              {/* D-021: per-goal spend figures do NOT sum across goals — a
                  shared pot counts in full against each. The caveat rides
                  with the chart because this is the section most likely to be
                  screenshotted into a report. */}
              {data?.spendNote ? <p className="hud-goal__note">{data.spendNote}</p> : null}
              {stack.days.length === 0 ? (
                <p className="hud-goal__empty">No spend recorded for this goal yet.</p>
              ) : (
                <div className="hud-goal__chart" data-testid="goal-spend-chart">
                  {stack.days.map((d) => (
                    <div
                      key={d.day}
                      className="hud-goal__col"
                      title={`${d.day} · $${d.totalUsd.toFixed(2)}`}
                    >
                      <div className="hud-goal__col-track">
                        <div className="hud-goal__col-fill" style={{ height: `${d.heightPct}%` }}>
                          {d.slices.map((s) => (
                            <span
                              key={s.harnessSlug}
                              className="hud-goal__slice"
                              style={{ height: `${s.pct}%` }}
                              title={`${s.harnessSlug} · $${s.costUsd.toFixed(2)}`}
                            />
                          ))}
                        </div>
                      </div>
                      <span className="hud-goal__col-label">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

            <footer className="hud-goal__foot">
              <button type="button" className="hud-goal__close" onClick={onClose}>
                Close
              </button>
            </footer>
          </div>
          </div>
          ) : null}

          {/* ── THE LIVE CONVERSATION (D-011) ──────────────────────────────────
              A SIBLING of the scrolling body, not a child of it — for the same
              reason the rail is: a transcript has its own scroll, and nesting
              one inside another is the layout that makes a chat feel broken.
              As siblings, goal detail scrolls above while the composer stays
              pinned at the bottom of the popup, which is where the owner
              expects it from the conversation popup.

              This renders the SAME `LiveSessionChat` the sessions popup does,
              fed by the same `useOwnerSessionChat` wiring (D-005: never fork a
              second chat renderer).

              The region only claims its share of the height when a live chat is
              actually mounted; every other state is one line, and reserving 46%
              of the popup to say "no agent" would push the goal's own detail
              off screen to display an absence. */}
          <div
            data-testid="goal-chat"
            style={{
              /* P-022: FULL height of the row, not a 46% slice of the column.
                 The old share existed only because the brief sat above this
                 region and would otherwise have crowded it out — with the brief
                 moved into its own zone beside it, there is nothing left to
                 divide the column with, which is exactly what the owner asked
                 for ("so the conversation takes up the full height like the
                 conversation popups in the conversation tab"). */
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              /* No border here: the seam belongs to the brief zone, which owns
                 it as `.pc-zone--brief`'s border-right — the same way Orders
                 owns the seam against the conversation in SessionChatModal.
                 Putting it here too would double the rule whenever both are
                 open, and would leave a stray edge when the brief is closed. */
            }}
          >
            {!primaryAgent ? (
              /* D-011: a plain statement, never an inert composer. A composer
                 that looks live and can reach nobody is worse than none. */
              <p className="hud__state" data-testid="goal-chat-no-agent">
                No agent is running this goal yet, so there is no conversation to
                show. Starting a goal launches the agent that owns it.
              </p>
            ) : chat.resolving ? (
              <p className="hud__state">Finding this agent&rsquo;s conversation…</p>
            ) : chat.resolveError ? (
              <p className="hud__state hud__state--error" data-testid="goal-chat-error">
                Could not load the conversation: {chat.resolveError}
              </p>
            ) : !chat.resolved ? (
              <p className="hud__state" data-testid="goal-chat-no-session">
                No recent Claude session found for this agent.
              </p>
            ) : chat.streamUrl ? (
              <LiveSessionChat
                streamUrl={chat.streamUrl}
                sessionOwnerId={primaryAgent.ownerId}
                agentName={primaryAgent.ownerId}
                onSend={chat.send}
                sending={chat.sending}
                sendError={chat.sendError}
              />
            ) : null}
          </div>
          </div>
        </div>

        {/* ── SESSIONS (P-024) — who is working on this goal ────────────────
            [owner 2026-08-10] "just put the pane on the right side, to the left
            of the 'WORK — what sits under this goal' pane" — so it is the FIRST
            of the right-edge zones in DOM order, which is what puts it
            immediately left of Work and keeps the tab sequence agreeing with
            the visual order (never a CSS `order` trick).

            Reading order is now:
              Orders │ Brief │ conversation │ Sessions │ Work │ Activity │ Fleet
            which keeps the outermost-is-most-general rule intact: WHO is on the
            goal sits inside the agent's own Activity and Fleet, and outside the
            goal's Work — you ask who is on it before you ask what they have
            broken it into.

            `onSelectSession` routes through the host's existing `onOpenAgent`,
            the same destination the Fleet rail's rows use, so a session row
            lands in the sessions popup rather than inventing a second one. */}
        {sessionsVisible && goalSessions ? (
          <div
            className="pc-zone pc-zone--sessions"
            data-testid="goal-sessions-rail"
            style={isSessionsNarrow ? SESSIONS_OVERLAY_STYLE : SESSIONS_SIDE_STYLE}
          >
            <GoalSessionsRail
              model={goalSessions}
              onSelectSession={onOpenAgent}
              onClose={() => void setSessionsOpen(false)}
            />
          </div>
        ) : null}

        {/* ── THE WORK RAIL (P-019) ──────────────────────────────────────────
            A SIBLING of the body column, never a child of it — the same layout
            contract SessionChatModal's rails hold to. Nesting it inside the
            scrolling body would make it scroll away with the content, which is
            the opposite of what a rail is for. */}
        {railVisible ? (
          <div
            className="pc-zone pc-zone--work"
            data-testid="goal-work-rail"
            style={isRailNarrow ? RAIL_OVERLAY_STYLE : RAIL_SIDE_STYLE}
          >
            <GoalWorkRail
              model={rail}
              nowMs={nowMs}
              onOpenWorkItem={onOpenWorkItem}
              onClose={() => void setRailOpen(false)}
            />
          </div>
        ) : null}

        {/* ── ACTIVITY (P-021) — what the agent is DOING ────────────────────
            AgentDossier verbatim, the same component the sessions popup and the
            /adv two-pane both render. `zoneTitle` because here it is one of six
            named zones and needs to say which; in the two-pane it is the detail
            pane of a board that already says so.

            `startingUp`/`launchFailed` are deliberately NOT passed: they belong
            to the sessions popup's LAUNCH flow, which this surface has none of.
            A goal's agent is discovered from the goal's own roster stamp, never
            launched from here, so there is no boot window to describe and no
            corpse to report. Defaulting them false is the honest answer, not an
            omission. */}
        {dossierVisible ? (
          <div
            className="pc-zone pc-zone--activity"
            data-testid="goal-dossier-rail"
            style={isDossierNarrow ? DOSSIER_OVERLAY_STYLE : DOSSIER_SIDE_STYLE}
          >
            <AgentDossier
              ownerId={agentOwnerId ?? ''}
              entry={dossierEntry}
              zoneTitle
              onClose={() => void setDossierOpen(false)}
            />
          </div>
        ) : null}

        {/* ── FLEET (P-021) — who the agent is working WITH ─────────────────
            The outermost zone, last child so DOM order matches the reading
            order the layout promises. `onSelectPeer` routes through the host's
            existing `onOpenAgent`, so a peer row lands in the sessions popup —
            the destination this panel already uses for "Open full-size". A host
            that cannot re-target passes nothing and the rail degrades to
            read-only rows rather than rendering buttons that do nothing. */}
        {peersVisible && fleetPeers ? (
          <div
            className="pc-zone pc-zone--peers"
            data-testid="goal-peers-rail"
            style={isPeersNarrow ? PEERS_OVERLAY_STYLE : PEERS_SIDE_STYLE}
          >
            <FleetPeersRail
              model={fleetPeers}
              onSelectPeer={onOpenAgent}
              onClose={() => void setPeersOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** A work-item row. A button only when there is somewhere to go — the dead
 *  `<button>` WI-6742 filed was a card rendered clickable with no handler. */
function RowButton({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen?: (id: string) => void;
}) {
  if (!onOpen) return <span className="hud-goal__row-title">{title}</span>;
  return (
    <button type="button" className="hud-goal__row-title hud-goal__row-title--link" onClick={() => onOpen(id)}>
      {title}
    </button>
  );
}

function TripwireRow({ bar }: { bar: TripwireBar }) {
  return (
    <li
      className={`hud-goal__bar hud-goal__bar--${bar.tone}`}
      title={bar.title}
      /* The machine-readable half of the same distinction the styling makes:
         a tripwire nobody has wired up must be tellable from one measured at
         zero WITHOUT reading pixels or parsing prose. Driven by `measured`,
         never by `pct` — pct is also null for a reading with no threshold,
         which is measured. */
      data-measured={bar.measured ? 'true' : 'false'}
      /* The SECOND question, and a different one: `data-measured` says a reading
         exists, this says the platform took it. A hand-set reading is the normal
         case for a domain metric and is not an error — but it must not be
         readable as a live measurement (EI-21605510614702802). */
      data-derived={bar.derived ? 'true' : 'false'}
    >
      <span className="hud-goal__bar-label">{bar.label}</span>
      {/* ── P-012: real progressbar semantics ──────────────────────────────
          The track WAS a decorative span, so the state this widget exists to
          announce reached assistive tech only as a colour.

          `aria-valuenow` carries the CLAMPED pct, which is not a compromise —
          ARIA requires valuenow to lie within valuemin..valuemax, so an
          overshot tripwire genuinely cannot report 143 here. `aria-valuetext`
          is the sanctioned escape hatch and carries the TRUE figures
          ("$600 of $500"), and screen readers announce it in preference to
          valuenow — so the real number is what a listener actually hears,
          which is what the item asked for.

          When `pct` is null the bar is INDETERMINATE and valuenow is omitted
          entirely rather than sent as 0 — that is the whole unmeasured-vs-
          measured-at-zero distinction this surface exists to preserve, and a
          0 here would re-introduce it in the a11y tree after the visuals took
          such care to avoid it. Note `pct` is null for TWO reasons (no reading,
          or a reading with no threshold); both are genuinely indeterminate, so
          one branch is correct for both. */}
      <span
        className="hud-goal__bar-track"
        role="progressbar"
        /* Name from the same string the visible label renders, so the two
           cannot drift. */
        aria-label={bar.label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(bar.pct == null ? {} : { 'aria-valuenow': bar.pct })}
        aria-valuetext={bar.tone === 'breached' ? `${bar.valueText} — past limit` : bar.valueText}
      >
        {/* An unread tripwire gets NO fill at all — not a zero-width one. A
            0% bar and "nobody measured this" must not look identical. */}
        {bar.pct == null ? (
          <span className="hud-goal__bar-unread" />
        ) : (
          <span className="hud-goal__bar-fill" style={{ width: `${bar.pct}%` }} />
        )}
      </span>
      <span className="hud-goal__bar-value">
        {bar.valueText}
        {/* P-012: BREACH IN TEXT, not colour alone. Until now the only signal
            that a tripwire was past its limit was `--bad` on the fill and the
            value — invisible to anyone who cannot distinguish it, and absent
            from the a11y tree entirely.

            TEXT rather than an icon, deliberately: the item suggested matching
            "the AlertTriangle already used for the missing-criterion case", but
            measured across the whole operator app the HUD goal surface imports
            no icons at all — its missing-criterion alarm is text plus a class.
            An icon HERE would invent a second alarm vocabulary, which is the
            thing that clause was trying to prevent. */}
        {bar.tone === 'breached' ? (
          <span className="hud-goal__bar-breach" data-testid="goal-tripwire-breach">
            past limit
          </span>
        ) : null}
        {/* Same vocabulary as the breach marker above — text plus a class, no
            icon — for the reason documented there. Shown only for a reading that
            EXISTS but nobody measured; an unread bar already says so itself, and
            stacking a second caveat on it would be noise. */}
        {bar.measured && !bar.derived ? (
          <span className="hud-goal__bar-handset" data-testid="goal-tripwire-handset">
            hand-set
          </span>
        ) : null}
      </span>
    </li>
  );
}

function PotCard({ pot, nowMs }: { pot: GoalDetailPot; nowMs?: number }) {
  const removedAgo = nowMs != null ? agoText(pot.removedAt, nowMs) : null;
  return (
    <article className={`hud-goal__proj${pot.removed ? ' hud-goal__proj--removed' : ''}`}>
      <div className="hud-goal__proj-head">
        <span className="hud-goal__proj-slug">{pot.harnessSlug}</span>
        {pot.role === 'owner' ? <span className="hud__chip hud__role">main</span> : null}
        {pot.sharedBadge ? <span className="hud__chip">{pot.sharedBadge}</span> : null}
      </div>
      <p
        className={`hud-goal__proj-crit${pot.killCriterionMissing ? ' hud-goal__proj-crit--missing' : ''}`}
      >
        {pot.killCriterionText}
      </p>
      <div className="hud-goal__proj-meta">
        <span>${Math.round(pot.spendUsd ?? 0).toLocaleString('en-US')}</span>
        <span>{pot.openWorkItems ?? 0} open</span>
        {pot.removed ? <span>closed{removedAgo ? ` ${removedAgo}` : ''}</span> : null}
      </div>
      {/* The note is the REASON a pot was closed — the whole value of
          keeping killed pots on the page. */}
      {pot.removed && pot.note?.trim() ? (
        <p className="hud-goal__proj-note">{pot.note.trim()}</p>
      ) : null}
    </article>
  );
}
