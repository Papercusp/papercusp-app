'use client';

/**
 * SessionChatModal (owner-inbox-single-pane-2026-07-17 P-007) — the "chat-grade"
 * popup: click an inbox item whose `ownerAgentId` names a live/recent su agent
 * and see that agent's session as a friendly, Papercup-style conversation —
 * not AgentInspectorModal's raw technical timeline (tool JSON, cost, tokens),
 * which stays the debugging surface it always was. Composer sends a real
 * message to the agent (D-007's live-asker path).
 *
 * Data layer — entirely REUSED, nothing new invented (D-005 "generalize
 * OperatorChat... never fork a second chat renderer" + reuse-first):
 *   - owner → native transcript: the canonical advRoster.list nativeSession
 *     handle for Claude/Codex/OMP, with the existing sessions:list admin proxy
 *     as the compatibility/history fallback.
 *   - session id → live transcript: the SAME `/api/adv/session/thinking` SSE
 *     stream + `useAgentThinkingStream` hook that already backs
 *     AgentInspectorModal (apps/operator/app/harness/AgentThinkingStream.tsx)
 *     — no new transcript-reading/parsing code.
 *   - transcript → ChatMessage[]: session-transcript-mapping.ts (this plan
 *     item's actual new logic — the tool-noise-filtering mapping layer).
 *   - rendering: <OperatorChat>, passive (read + reply; no auto-brain).
 *
 * Composer send: a plain coord:send via the existing /api/admin/coord/send
 * proxy — the SAME endpoint AssignDialog's `assignToUser` already POSTs to.
 * `wake:'required'` per D-007 (this is a live two-way chat action, distinct
 * from P-006's inbox "answer this ask" action, which owns actions/provenance).
 *
 * Cards in the popup (P-008): when this owner has a pending `coord-escalation`
 * with named options, it renders inline above the chat as the SAME
 * `OtherDetail` card the Queue and InboxPane already use (REUSE, not a second
 * card renderer) — sourced from the SAME `useInboxAttention` feed (shared sync
 * cache entry, no new query) InboxPane reads. Answering it here goes through
 * `OtherDetail`'s own action path unmodified, so it is byte-identical to
 * answering from the inbox (P-006's resolve/reply routing + provenance stamp).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncPrefetch, useSyncQuery } from '@papercusp/sync';
import { Modal } from '../../harness/Modal';
import { Tooltip } from '../../harness/Tooltip';
import { OperatorChat } from '../OperatorChat';
import { useAgentThinkingStream, type TimelineEntry } from '../../harness/AgentThinkingStream';
import { mapSessionTimeline } from './session-transcript-mapping';
import { classifyStreamFreshness, streamFreshnessMessage } from './stream-freshness';
import { mergeSentEchoes, useSentEchoes } from './sent-message-echo';
import {
  ConversationContextProjectionView,
  mergeConversationProjectionMessages,
  useConversationContextProjection,
  type ConversationContextProjectionTarget,
} from './ConversationContextProjectionView';
/* D-011: the session resolve, the SSE url builder and the send state machine
   were extracted here so the goal popup can host this same conversation
   without forking any of them. Re-exported below for the existing importers. */
import {
  deliveryFromSendResponse,
  fetchOwnerHistoryPage,
  resolveOwnerClaudeSession,
  sendToSessionOwner,
  useOwnerSessionChat,
  type SendDelivery,
  type SessionListRow,
} from './use-owner-session-chat';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import { ChatActionBar } from './ChatActionBar';
import FleetRoleGlyph from '../FleetRoleGlyph';
import FleetLaunchRow from './FleetLaunchRow';
import { LocalCardHost } from './LocalCardHost';
import AgentDossier from '../../adv/sessions/AgentDossier';
// chat-popup-fleet-peers-rail-2026-08-09: the FLEET rail + its pure derivation.
// The rail is presentational; every rule about what counts as a fleet, how peers
// group and how they sort lives in the unit-tested module beside it.
import FleetPeersRail from './FleetPeersRail';
// chat-popup-turn-rail-2026-08-31: the turn index + its rail. The derivation is
// pure and unit-tested; this file derives it (inside LiveSessionChat, the only
// place the rendered messages exist) and renders the rail one level up, as a
// sibling of the conversation region — see D-002.
import TurnRail from './TurnRail';
import {
  deriveSessionTurns,
  resolveFocusPrecedence,
  turnAtInstant,
  turnAtMessageIndex,
  type SessionTurn,
} from './session-turn-index';
import { deriveFleetPeers, isUnknownSession } from './fleet-peers';
import { deriveLeaderBriefAlerts } from './leader-brief-alerts';
import { useChatClock } from './message-timestamp';
// P-015: the ORDERS panel — what the agent was TOLD (mission/authority,
// modes + who set them, owner directives, standing facts, walls, carry brief).
// Sibling of the dossier, opposite edge; see ORDERS_RAIL_SIDE_STYLE below.
import AgentOrders from '../../adv/sessions/AgentOrders';
import type { RosterEntry } from '../../adv/sessions/SessionsRosterView';
// P-009: the SAME countdown formatter the dossier's Locks section uses, so an
// expiry cannot read one way on the band and another way one pane over.
import { formatTimeLeft } from '@papercusp/operator-core/lib/format/relative-time';
/* D-003: the ONE resolver. This popup's title must be the string the HUD card
   and the OS terminal title already show, so it calls the shared chain rather
   than growing a third `manualName ?? objective ?? handle` expression. */
import { sessionDisplayName } from '@papercusp/operator-core/lib/agent-tools/coordination/status-display';
// hud-first-nav-and-dossier-2026-07-26 P-004: the footer's liveness dot +
// its "N locks / M unread" summary-chip counts. Imported from the standalone
// use-agent-detail module (not AgentDossier.tsx, which SessionChatModal.test.tsx
// mocks wholesale) so this hook keeps working under that mock.
import { LivenessDot, normalizeSessionState } from '@/app/coord/presence-ui';
import { useAgentDetail } from '../../adv/sessions/use-agent-detail';
import { useAgentLeaderBrief } from '../../adv/sessions/use-agent-leader-brief';
import type { ChatActionContext } from '@/lib/chat-actions/types';
import { Maximize, Maximize2, Minimize, Minimize2, Terminal, X } from 'lucide-react';
import { AGENT_MARKS } from './chat-agent-marks';
import type { ChatMessage } from './chat-types';
import {
  contextPct,
  deriveBadges,
  formatAge,
  HUD_DEFAULT_THRESHOLDS,
  isInfrastructureAwait,
  // P-006: the zombie predicate AND its wording come from the board, so the two
  // surfaces cannot describe the same session differently.
  isZombieSession,
  shortHandle,
  ZOMBIE_REASON,
  type HudBadge,
  type HudRosterEntry,
} from '../../adv/hud/hud-board-model';
// OtherDetail's styles (pc-items__*, pc-tier/pc-kind badges) — global CSS, so
// importing it here (as InboxPane already does) makes this modal
// self-sufficient wherever it's mounted.
import '@/app/admin/plans/plans.css';
// hud__handle / hud__chip / hud__chip--accent — reused by the identity chip
// (P-012) below, rather than re-declaring the same look under a new class.
import '../../adv/hud/hud.css';
import './session-chat.css';
// pc-dossier__* — hud-first-nav-and-dossier-2026-07-26 P-003: the right rail
// below reuses AgentDossier verbatim (no forked dossier), so its stylesheet
// rides along the same way hud.css/plans.css already do for their own reused
// pieces.
import '../../adv/sessions/SessionsRosterView.css';
// P-003: the control VOCABULARY (pc-ctl-*) — the five shapes that make a label,
// a button and a mode tell themselves apart. Loaded here because this modal is
// the surface Direction D restyles; see chat-controls.css's own header for the
// grammar and the two repo rails (letter-spacing:0, no flex on a <button>).
import './chat-controls.css';
import { advRosterArgs } from '@/lib/adv-roster-args';
// P-001 full-screen (window + display), extracted 2026-08-10 so the goal popup
// gets the same pair without a forked copy of the mechanism.
import { usePopupMaximize } from './use-popup-maximize';
// The panel show/hide control — constant label, chevron carrying the verb.
// Shared with GoalDetailPanel; see its header for the grammar.
import PanelToggleButton, { PANEL_TOOLBAR_BUTTON_STYLE } from './PanelToggleButton';

/** The roster payload shape (advRoster.list). Inlined, never imported from the
 *  server module — same rationale as HudView.tsx's identical inline type
 *  (importing it would drag PG/node builtins into the SPA bundle). */
interface RosterPayload {
  active: HudRosterEntry[];
  /** Terminal adv-session rows. These are historical evidence, not live peers. */
  ended?: Array<{ coordOwnerId?: string | null; endedAt?: string | null }>;
  pending?: HudRosterEntry[];
  /** WI-6376's launch-record tier: sessions whose launch is durably recorded but
   *  which have not registered in the roster yet. WI-6440 reads it here so the
   *  boot window survives a reload — see `startingEntry` below. Deduped against
   *  `active` server-side, so a row here is authoritatively still booting. */
  starting?: HudRosterEntry[];
}

interface SessionChatComposerState {
  passive: boolean;
  disabled: boolean;
  message?: string;
}

/**
 * The composer has three user-facing affordances: reply to a live turn, wake
 * a parked session, or explain that an ended session needs relaunch/resume.
 * Only `ended` is terminal; draining/suspect are intentionally left on the
 * conservative wake path until the oracle gives a definitive terminal state.
 * Missing/unknown state keeps the legacy passive affordance for old payloads.
 */
function sessionChatComposerState(value: string | null | undefined): SessionChatComposerState {
  switch (normalizeSessionState(value)) {
    case 'live':
      return { passive: false, disabled: false };
    case 'parked':
      return { passive: true, disabled: false };
    case 'ended':
      return {
        passive: true,
        disabled: true,
        message: 'This session has ended — relaunch or resume the agent.',
      };
    default:
      return { passive: true, disabled: false };
  }
}

/* Moved to `use-owner-session-chat` (D-011) and re-exported here: nothing
   outside this file imported them, but the names are referenced from comments
   in HudView/PostureActions and from tests, and a chat surface is the natural
   place to look for them. */
export {
  deliveryFromSendResponse,
  resolveOwnerClaudeSession,
  sendToSessionOwner,
  type SendDelivery,
  type SessionListRow,
};

const BANNER_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--fg-mute)',
  borderBottom: '1px solid var(--border)',
};

const ERROR_BANNER_STYLE: React.CSSProperties = { ...BANNER_STYLE, color: 'var(--bad, #f87171)' };

/** WI-6367: how long a just-launched session may take to register before the
 *  modal stops saying "starting up" and admits it did not come online. Sized
 *  well past a normal psu boot (a few seconds) so a slow-but-fine launch is
 *  never mislabelled as failed. */
const STARTUP_GRACE_MS = 60_000;

/** EI-19403137552594870: cap on the pending-cards region (below) so a large
 *  owner-owed-ask backlog can't push the transcript out of view. */
const PENDING_CARDS_MAX = 5;

// hud-first-nav-and-dossier-2026-07-26 P-003: the AgentDossier right rail.
// Side-by-side on a wide window (the Modal's own contentStyle widens to make
// room, below in the component); on a narrow window it renders as an
// overlaying drawer instead, so it never crushes the transcript column.
const DOSSIER_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: '0 0 300px',
  width: 300,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const DOSSIER_RAIL_OVERLAY_STYLE: React.CSSProperties = {
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

/** Narrow-viewport breakpoint below which the dossier rail stops sitting
 *  side-by-side and becomes a collapsible overlay drawer instead — same
 *  matchMedia + useEffect pattern BrainstormFull.tsx already uses for its own
 *  compact-layout switch. */
const DOSSIER_NARROW_MEDIA_QUERY = '(max-width: 1400px)';

/* ── chat-popup-fleet-peers-rail-2026-08-09: the FLEET rail ──────────────────
   The fourth zone, one column further out than Activity, so the popup reads
   told → conversation → doing → who with. Like both other rails it is a SIBLING
   of the conversation region (P-015's guard), which since D-007 means it is
   INSIDE the fullscreen target and shows in both maximize modes for free. */
const PEERS_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: '0 0 248px',
  width: 248,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

const PEERS_RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(280px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  /* Above the dossier's own overlay (5): with both rails collapsed on a narrow
     window they occupy the same edge, and the one the reader opened last should
     not render underneath the other. */
  zIndex: 6,
};

/* D-002 [owner 2026-08-09]: under width pressure the rails give way Fleet →
   Orders → Activity, so this breakpoint is the WIDEST of the three (Orders
   1180px, the dossier 860px). Four columns need ~1330px of content — 248 fleet
   + 300 dossier + 272 orders + ~510 conversation — so below 1400 there is no
   honest way to seat this one as a column. Activity survives longest because it
   changes every turn; this rail is the most situational. */
const PEERS_NARROW_MEDIA_QUERY = '(max-width: 2100px)';

/* ── session-chat-popup-direction-d-2026-08-02 P-015: the ORDERS panel ───────
   The second panel [owner 2026-08-02: "Two panels: told on the left, did on
   the right"]. It sits on the LEFT so the three columns read in causal order —
   what the agent was TOLD → the conversation → what the agent DID.

   It is a SIBLING of the conversation region, exactly like the dossier rail, so
   P-001's D-002 keeps holding without a second rule: maximize paints the
   conversation element's subtree, and both panels are outside it. Do NOT move a
   panel inside that element to make it visible in fullscreen — that silently
   breaks the scoping invariant and nothing in the tree would catch it. */
const ORDERS_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: '0 0 272px',
  width: 272,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

/* Orders collapses at a WIDER breakpoint than the dossier (860px) on purpose:
   when space runs out the left panel goes first. It is the more static of the
   two — orders change when a mode flips or a fact is asserted, activity changes
   every turn — so losing it costs the reader least. */
const ORDERS_NARROW_MEDIA_QUERY = '(max-width: 1760px)';

/* Below that breakpoint Orders overlays instead of taking a column — the same
   trade the dossier already makes. Overlaying rather than simply not rendering
   matters: a toggle that silently does nothing on a narrow window reads as a
   broken button, not as a layout decision. */
const ORDERS_RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 'min(300px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

/* ── the TURN RAIL's geometry (chat-popup-turn-rail-2026-08-31 P-004) ────────
   Narrower than every other rail on purpose: its rows are two clamped lines of
   the reader's own question, not a data panel, and the transcript beside it is
   what the width scheme exists to protect.

   There is NO overlay style here, unlike the other three. Under width pressure
   this rail DEGRADES to spine density rather than becoming a drawer (D-003) —
   a "you are here" marker you have to open something to see has stopped being
   one.

   It is the only one that never DISAPPEARS, but it is not the last to give way.
   The real order is Fleet (1400px) → Orders (1180px) → THIS (1000px, full rail
   → spine) → Activity (860px). Third of four. An earlier version of this
   comment claimed it was last, which the TURNS_NARROW_MEDIA_QUERY constant
   twenty lines below has always contradicted; the independent acceptance
   grading (EI-21986741094464185) caught it by checking the breakpoints against
   the prose instead of trusting the prose. Degrading EARLY is deliberate — at
   214px the rail costs a third of what Orders does, so giving way before
   Activity buys back real content width while still leaving a position
   indicator on screen. */
const TURN_RAIL_WIDTH = 214;
const TURN_SPINE_WIDTH = 42;

const TURN_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${TURN_RAIL_WIDTH}px`,
  width: TURN_RAIL_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

const TURN_SPINE_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${TURN_SPINE_WIDTH}px`,
  width: TURN_SPINE_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

/* Tighter than Orders' 1180px: at 214px this rail costs a third of what Orders
   does, so it can hold its full density well past the point Orders has to fold.
   Below this it is still on screen, just as a spine. */
const TURNS_NARROW_MEDIA_QUERY = '(max-width: 1000px)';

function useIsNarrowViewport(query: string): boolean {
  /* Seeded from matchMedia SYNCHRONOUSLY rather than starting false and
     correcting in the effect below. It used to start false, which was harmless
     while this hook only chose a STYLE (column vs overlay) — one frame of the
     wrong style is invisible. It stopped being harmless when the Orders default
     became room-aware (WI-35470): a hook that reports "wide" on the first render
     of a narrow window would MOUNT the panel, fire the agentOrders.byOwner
     carry-brief gather, and then unmount it a frame later — a flash plus exactly
     the fetch the closed state exists to avoid. The `typeof` guards keep it
     SSR-safe and survive a test env whose jsdom lacks matchMedia. */
  const [isNarrow, setIsNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const sync = () => setIsNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return isNarrow;
}

/* ── Maximize (session-chat-popup-direction-d-2026-08-02 P-001) ─────────────
 *
 * The MECHANISM moved to `use-popup-maximize.ts` (2026-08-10) so the goal popup
 * could grow the same two buttons without a second copy of it — read that file's
 * header for the whole design: the two modes, D-007's "the target is the popup
 * container, so every zone is included by construction", and D-006's two
 * mechanisms for `screen` (browser DOM fullscreen vs. driving the Tauri window).
 *
 * What stays HERE is only what is specific to this popup: which element the ref
 * lands on (`session-chat-modal`, the container holding Orders │ conversation │
 * Activity — pointing it at the conversation region would silently drop all
 * three panels again, which is exactly the D-002 bug D-007 fixed) and the two
 * `contentStyle` branches below.
 *
 * [owner 2026-08-02, verbatim] "lets actually make the left panel and right
 * panel and bottom and top panel all show in both full screen views"
 */

/* The panel-toggle chevron and the compact toolbar button both live in
   PanelToggleButton now (2026-08-10) — two copies of this grammar is how the
   popups drift apart. The goal popup rendered the same five toggles until
   WI-38428 (2026-08-13) replaced its row with GoalPanelVisibilityMenu; it still
   shares PANEL_TOOLBAR_BUTTON_STYLE, so the two toolbars stay matched. */

/**
 * Badge tone → the P-003 vocabulary's State-pill tone class.
 *
 * Replaces the old `hud__chip--*` mapping: Direction D renders these as the
 * vocabulary's STATE shape (full-round, borderless, tinted) so a fact can never
 * be mistaken for a control. `accent` collapses to the neutral pill on purpose —
 * accent was carrying the MODE chips, and modes are no longer facts on this
 * surface: they are controls in the band below (P-005).
 */
const STATE_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: '',
  good: 'pc-ctl-state--good',
  warn: 'pc-ctl-state--warn',
  bad: 'pc-ctl-state--bad',
};

function stateChipClass(b: HudBadge): string {
  const tone = STATE_TONE_CLASS[b.tone];
  return tone ? `pc-ctl-state ${tone}` : 'pc-ctl-state';
}

/**
 * P-007: the session status row rendered under the composer — built ENTIRELY
 * from the SAME advRoster.list entry the identity chip (P-012) already
 * fetches (no new query, no new endpoint). INFORMATIONAL only (D-002): no
 * click handlers, no write path — mode CONTROL lives in the chat action bar
 * (Lane B's P-004), not here. `objective` = the roster's declared `intent`;
 * model/effort are NOT on the roster entry and are omitted rather than
 * guessed at.
 *
 * hud-first-nav-and-dossier-2026-07-26 P-004 (D-002's glance-frequency
 * split): the footer owns exactly what CHANGES while you read the
 * conversation — liveness, context %, current claim (the claims-progress
 * badge below), mode chips, awaiting-gate. Identity/reference fields that
 * duplicated the AgentDossier panel verbatim (the short handle, the plan
 * slug, the intent line — all re-shown by the panel's own header/meta rows,
 * P-003) were REMOVED from here rather than kept in both places; they're
 * still one click away via the dossier rail (default open) or the modal
 * title bar. Fleet role/slug stay: the panel never showed them, so they are
 * not a duplicate to remove.
 */

/**
 * The popup's title — the session's NAME, edited in place
 * (hud-session-display-names-2026-08-31 P-008, D-002: this is the ONLY rename
 * affordance in the product; the HUD card stays read-only).
 *
 * WHY IT SITS IN THE STATUS BAND. D-002 named "the SessionChatModal header
 * title", which at the time meant the `title` prop on Modal — but Radix renders
 * that `Dialog.Title` at `display:none` unless `srOnlyTitle`, so it is the
 * ACCESSIBLE name and has never been on screen. (The docblock above still points
 * readers at "the modal title bar" for the same reason; it is describing
 * something invisible.) The status band is what a reader actually sees at the
 * top of the popup — the window controls sit on its row — so that is where the
 * title goes. The a11y `title` is resolved from the same string, so the two
 * cannot disagree.
 *
 * The band's own rule is "facts, not verbs", and this respects it: a name is a
 * fact about the session, rendered as text. The edit is an affordance ON that
 * fact, not a command performed on the session — which is the line that keeps
 * it out of the Controls band, where every neighbour would make it read as
 * something you DO to the agent rather than what the agent IS.
 */
function SessionNameField({
  headline,
  manualName,
  onRename,
  onEditingChange,
}: {
  /** The resolved display name — what every other surface shows. Never blank. */
  headline: string;
  /** The stored MANUAL name, or null when the headline came from the fallback. */
  manualName: string | null;
  onRename?: (name: string) => Promise<void>;
  /** Reported UP so the dialog can hand Escape to this edit — see `setEditing`. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editingState, setEditingState] = useState(false);
  const editing = editingState;
  /* Escape has to mean "cancel this edit", and the popup would otherwise take
     it as "close the conversation". Reporting the edit up is the ONLY way to
     win that: Radix's dismissable layer registers its Escape handler on
     `document` in the CAPTURE phase, so it runs before this input's own
     keydown ever fires and no amount of stopPropagation here can head it off.
     SessionChatModal disarms `closeOnEscape` while this is true — the same
     mechanism it already uses while the browser is painting fullscreen. */
  const setEditing = useCallback(
    (next: boolean) => {
      setEditingState(next);
      onEditingChange?.(next);
    },
    [onEditingChange],
  );
  // Mid-edit draft: `useState` on purpose. The repo's nuqs-by-default rule lists
  // a draft as one of its explicit exceptions, and a rename half-typed into the
  // URL would be shared/restored as if it had been committed.
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = () => {
    // Seeded with the MANUAL name only — never the resolved headline. Seeding
    // the fallback would turn "press Enter to keep what I see" into silently
    // FREEZING the objective as a manual name, so the card would stop tracking
    // what the session is doing and nobody would know why.
    setDraft(manualName ?? '');
    setError(null);
    setEditing(true);
  };

  const commit = async () => {
    if (!onRename || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    /* ⚠ THE UNNAMED CASE RENDERS NO TEXT FROM THE FALLBACK CHAIN, and that is
       not a style choice. This band is governed by P-004/D-002, which REMOVED
       every identity/reference field that the AgentDossier panel already shows
       verbatim — the handle, the plan slug, the intent line — rather than keep
       them in two places. The resolved headline of an unnamed session IS that
       intent (or that handle), so printing it here would quietly reinstate the
       duplicate; `SessionChatModal.test.tsx`'s band test asserts the intent is
       absent, and it is right to.

       A MANUAL name is different in kind: nothing else on this surface shows
       it, so it is new information, not a repeat. Hence the split — a named
       session gets its name as the title, an unnamed one gets only the
       affordance to give it one. Either way the popup's accessible title still
       carries the full resolved headline, where duplication costs nothing. */
    return (
      <button
        type="button"
        className="pc-ctl-name"
        onClick={onRename ? open : undefined}
        disabled={!onRename}
        data-testid="session-chat-name"
        data-named={manualName ? 'true' : 'false'}
        aria-label={
          manualName
            ? `Session name: ${manualName}${onRename ? '. Click to rename.' : ''}`
            : 'This session has no name. Click to name it.'
        }
      >
        {manualName ?? 'Name this session'}
      </button>
    );
  }

  return (
    <span className="pc-ctl-name pc-ctl-name--editing">
      <input
        ref={inputRef}
        className="pc-ctl-name__input"
        value={draft}
        disabled={busy}
        aria-label="Session name — leave blank to clear it and fall back to the objective"
        // The fallback, shown rather than filled in, so an empty field reads as
        // "unnamed, and this is what you get instead" rather than as data loss.
        placeholder={headline}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        /* Blur DISCARDS rather than submits. A blank commit CLEARS the name
           (R6), so a blur-submit would make clicking anywhere else a silent
           destructive act on a field the user may have only meant to look at.
           Enter is the one way to commit, including to commit a clear. */
        onBlur={() => {
          if (!busy) setEditing(false);
        }}
      />
      {error ? (
        <span className="pc-ctl-name__error" data-testid="session-chat-name-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function SessionStateHeader({
  entry,
  onOpenDetail,
  onRename,
  onRenamingChange,
}: {
  entry: HudRosterEntry;
  /** Commit a new manual name (blank CLEARS — R6). Absent while the popup has
   *  no owner-scoped action context, which is also when the rename could not
   *  be routed anywhere. */
  onRename?: (name: string) => Promise<void>;
  /** True while the name field is in edit mode, so the dialog can yield Escape
   *  to it (SessionNameField explains why that has to travel this far up). */
  onRenamingChange?: (editing: boolean) => void;
  /** D-002's ONE deliberate duplicate: the "⚠ N locks / M unread" alert
   *  opens (if collapsed) and scrolls the dossier rail to the named
   *  section — "the glance stays in the reading path, the detail moves." */
  onOpenDetail?: (section: 'locks' | 'coord') => void;
}) {
  // A live ticking clock so context/age readings stay current without a new
  // fetch — same pattern + tick cadence as HudView.tsx's board clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const pct = contextPct(entry.contextTokens, entry.compactionLimit);
  // deriveBadges' own ctx chip is threshold-gated (only once it's getting
  // full); the footer shows the number unconditionally below, so drop the
  // derived duplicate rather than double-render it. deriveBadges assumes
  // modes/claims/currentFiles are always arrays (true for a real roster
  // payload) — default them defensively so a partial/stale entry can't
  // throw mid-render (`e.claims.length` etc. on undefined).
  const badges = useMemo(() => {
    const normalized: HudRosterEntry = {
      ...entry,
      modes: entry.modes ?? [],
      claims: entry.claims ?? [],
      currentFiles: entry.currentFiles ?? [],
    };
    return deriveBadges(normalized, { nowMs, thresholds: HUD_DEFAULT_THRESHOLDS }).filter(
      // 'ctx' and 'claims' are rendered as their own pills below (unconditionally,
      // and with the claim's identity rather than a bare done/total), so the
      // derived duplicates are dropped rather than double-rendered.
      //
      // kind:'mode' is dropped for a DIFFERENT and more important reason: a mode
      // is no longer a fact on this surface. Direction D makes it a control in
      // the band below (P-005), and that is precisely what kills the duplicate
      // pairs the owner reported — an `AUTO` chip up here beside an `Autonomy`
      // button down there was the same concept wearing two costumes.
      (b) => b.kind !== 'mode' && b.id !== 'ctx' && b.id !== 'claims',
    );
  }, [entry, nowMs]);

  /** Seconds since this session last did anything. `lastActiveAt` is the only
   *  timestamp the roster row carries for it; an absent/unparseable one yields
   *  null and the pill simply omits the age rather than inventing one. */
  const ageSec = useMemo(() => {
    if (!entry.lastActiveAt) return null;
    const t = Date.parse(entry.lastActiveAt);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
  }, [entry.lastActiveAt, nowMs]);

  /** P-008: seconds since the CONTEXT READING was taken — not since the session
   *  was active, and emphatically not a claim that the reading is current. null
   *  when the roster carries no stamp (an older payload, a federated peer, or a
   *  row the watchdog has never sampled), in which case the pill says nothing
   *  rather than implying "just now". */
  const ctxMeasuredAgeSec = useMemo(() => {
    if (!entry.contextEstimatedAt) return null;
    const t = Date.parse(entry.contextEstimatedAt);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
  }, [entry.contextEstimatedAt, nowMs]);

  /**
   * The held claim — deck change #2 calls it "the single most useful thing about
   * a working agent", and today it lives only in the rail.
   *
   * The deck drew it as `WI-6747 · 18m`. The AGE is deliberately absent: the
   * roster row's claims are `{ id, planSlug, status }` with NO timestamp on
   * them, and the nearest available field (`intentDeclaredAt`) dates the
   * INTENT, not the claim. Rendering that as "claimed 18m ago" would put a
   * confident, wrong number in the most-read pill on the surface. The id alone
   * is honest and still the useful half.
   */
  const claimIds = useMemo(
    () => (entry.claims ?? []).map((c) => c.id).filter((id): id is string => Boolean(id)),
    [entry.claims],
  );
  const awaitText =
    entry.openAwait && !isInfrastructureAwait(entry.openAwait)
      ? entry.openAwait.note?.trim() || `Waiting on ${entry.openAwait.eventKey}`
      : null;
  /**
   * P-009: HOW LONG the await has been open, and when it gives up.
   *
   * The chip said WHAT the agent is waiting on and never for how long, which is
   * the half that decides whether to intervene: a 40-second await is the system
   * working, and the same sentence at 3 hours is an agent parked on an event
   * that may never fire. `openAwait.sinceIso` has been on the roster payload the
   * whole time (`HudOpenAwait`) and had no reader.
   *
   * null when the stamp is absent or unparseable — the chip then renders exactly
   * what it renders today rather than a manufactured "0s", which would read as
   * "this wait just started" about a wait we never dated. Same rule for
   * `expiresIso`: no recorded timeout is NOT the same as "no timeout", so it
   * says nothing rather than "no expiry".
   */
  const awaitWaitedSec = useMemo(() => {
    const since = entry.openAwait?.sinceIso;
    if (!since) return null;
    const t = Date.parse(since);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
  }, [entry.openAwait?.sinceIso, nowMs]);
  const awaitTimeLeft = formatTimeLeft(entry.openAwait?.expiresIso, nowMs);
  /* The popup's title, resolved through the SHARED chain (D-003) and given the
     BOARD's short-id form (D-004) — so the title of the popup is byte-identical
     to the card that opened it, including in the unnamed fallback case where
     the two shortenings would otherwise differ and read as two sessions. */
  const display = sessionDisplayName({
    manualName: entry.displayName,
    objective: entry.objective ?? entry.intent,
    ownerId: entry.ownerId,
    shortHandle: shortHandle(entry.ownerId),
  });
  const headline = display.name;
  // Only a MANUAL name seeds the edit field; an objective/handle headline must
  // leave it empty, or committing unchanged would freeze the fallback as a name.
  const manualName = display.source === 'manual' ? display.name : null;
  const sessionState = normalizeSessionState(entry.sessionState);
  const statusLabel = sessionState ?? entry.liveness;
  const activityAgeTitle = ageSec != null ? `; last activity: ${formatAge(ageSec)} ago` : '';
  const statusTitle = sessionState
    ? `Session state: ${sessionState}${activityAgeTitle}`
    : `Heartbeat liveness: ${entry.liveness}${activityAgeTitle}`;

  // P-004: the SAME agentDetail.byOwner cache AgentDossier's own Locks/Coord
  // sections read (useSyncQuery shares its cache by {queryName, args} — a
  // second reader, not a second fetch) — just enough to size the summary
  // chip's counts, without the full dossier DTO plumbed down as a prop.
  const { detail } = useAgentDetail(entry.ownerId);
  const locksCount = (detail?.locks.held.length ?? 0) + (detail?.locks.waiting.length ?? 0);
  const unreadCount = detail?.coord.unreadCount ?? 0;
  // WI-6504 (owner-reported): this counts COORD messages addressed to the agent
  // — a DIFFERENT corpus from the conversation rendered directly above it. That
  // is why "32 unread" sat beside a single visible message and read as a
  // contradiction: two truthful numbers about different things, presented as if
  // they described the same pane. D-003 forbids clamping or hiding the count, so
  // the fix is to NAME what it counts rather than shrink it.
  const detailChipTitle =
    unreadCount > 0
      ? `${unreadCount} unread coord message${unreadCount === 1 ? '' : 's'} addressed to this agent — a separate list from the conversation shown here. Opens the agent detail panel.`
      : 'Open the agent detail panel to this section';

  return (
    <div
      className="pc-ctl-band pc-ctl-band--status"
      data-testid="session-chat-state-header"
    >
      {/* Panel controls live on their rails, leaving the identity band clear. */}
      <span className="pc-zone-cap">Status</span>
      {/* The popup's TITLE (P-008) — see SessionNameField for why the name is
          here rather than on the invisible Radix dialog title. It leads the
          band because it says WHAT this session is; everything after it says
          how it is doing. */}
      <SessionNameField
        headline={headline}
        manualName={manualName}
        onRename={onRename}
        onEditingChange={onRenamingChange}
      />
      <span
        className="pc-ctl-state"
        title={statusTitle}
        data-session-state={sessionState ?? undefined}
      >
        {/* The shared presence dot, not a local one — session-state colour stays
            single-sourced with /coord and the HUD board when that oracle field
            is available; heartbeat freshness is the older-payload fallback. */}
        <LivenessDot liveness={entry.liveness} sessionState={sessionState} size={6} />
        {statusLabel}
        {ageSec != null ? ` · ${formatAge(ageSec)}` : ''}
      </span>
      {/* P-006. A zombie renders as "live" everywhere else on this surface, and
          the composer is directly below — so this chip is the difference between
          "it is ignoring me" and "there is nothing there to ignore me". It sits
          INLINE beside the status chip it contradicts rather than behind the
          right-edge alert affordance [D-007]: an alert you have to click is the
          wrong home for the one fact that invalidates the control underneath it.
          Wording is the board's, imported, so the two surfaces cannot describe
          the same session differently. */}
      {isZombieSession(entry) ? (
        <span
          className="pc-ctl-state pc-ctl-state--bad"
          data-testid="session-chat-state-zombie"
          title={ZOMBIE_REASON}
        >
          <span aria-hidden="true">☠</span> process gone
        </span>
      ) : null}
      {pct != null ? (
        <span
          className="pc-ctl-state"
          title={`${entry.contextTokens ?? '?'} / ${entry.compactionLimit ?? '?'} tokens${
            ctxMeasuredAgeSec != null
              ? `\n\nReading taken ${formatAge(ctxMeasuredAgeSec)} ago. This is the age of the READING, not a freshness guarantee: the estimate can freeze while its timestamp keeps refreshing, which is how 48 sessions were once misjudged (one at 2.7× its true usage).`
              : '\n\nNo measurement time on record for this reading.'
          }`}
        >
          ctx {pct}%
          {/* P-008 / D-004. The AGE of the reading, never a freshness CLAIM —
              "measured 3m ago", not "fresh". A fresh contextEstimatedAt does not
              prove a fresh value, and presenting it as if it did is precisely
              how the recorded incident hid. Absent stamp ⇒ say nothing here and
              let the tooltip carry the gap; inventing "just now" would be the
              same lie in a shorter form. */}
          {ctxMeasuredAgeSec != null ? (
            <span className="pc-ctl-state__muted"> · measured {formatAge(ctxMeasuredAgeSec)} ago</span>
          ) : null}
        </span>
      ) : null}
      {claimIds.length > 0 ? (
        <span
          className="pc-ctl-state"
          data-testid="session-chat-state-claim"
          title={
            claimIds.length === 1
              ? `Holds ${claimIds[0]}`
              : `Holds ${claimIds.length} items: ${claimIds.join(', ')}`
          }
        >
          {claimIds[0]}
          {claimIds.length > 1 ? ` +${claimIds.length - 1}` : ''}
        </span>
      ) : null}
      {awaitText ? (
        /* The note is agent-authored free text and can be a paragraph, so the
           visible chip clips to one line (.pc-ctl-state__clip) and the FULL
           text moves into the tooltip. The title used to carry only the event
           key, which would have made the clip lossy — you would see a truncated
           sentence and have no way to read the rest. Key first, then the note,
           because the key is what you search for. */
        <span
          className="pc-ctl-state pc-ctl-state--warn"
          data-testid="session-chat-state-await"
          title={[
            entry.openAwait?.eventKey && entry.openAwait.eventKey !== awaitText
              ? `${entry.openAwait.eventKey}\n\n${awaitText}`
              : awaitText,
            /* P-009: the two durations spelled out, because the chip has room
               for one number and the pair is what the reader acts on — an
               await 3h old with 5m left is about to end itself, and the same
               age with no timeout is not. */
            awaitWaitedSec != null
              ? `\n\nOpen for ${formatAge(awaitWaitedSec)}.`
              : '\n\nNo start time on record for this await.',
            awaitTimeLeft === 'expired'
              ? ' Its timeout has already passed.'
              : awaitTimeLeft
                ? ` Times out in ${awaitTimeLeft.replace(/ left$/, '')}.`
                : ' No timeout on record — it ends only when the event fires.',
          ].join('')}
        >
          <span aria-hidden="true">⏳</span>
          <span className="pc-ctl-state__clip">{awaitText}</span>
          {/* The AGE, never a verdict. "3h" is a fact the reader judges; the
              band deliberately does not decide for them what counts as too
              long — that judgement is the leader-brief's (P-003/P-004) and it
              speaks in the peers rail with the evidence behind it. */}
          {awaitWaitedSec != null ? (
            <span className="pc-ctl-state__muted" data-testid="session-chat-state-await-age">
              {' '}
              · {formatAge(awaitWaitedSec)}
            </span>
          ) : null}
          {awaitTimeLeft === 'expired' ? (
            <span className="pc-ctl-state__muted" data-testid="session-chat-state-await-expiry">
              {' '}
              · timed out
            </span>
          ) : null}
        </span>
      ) : null}
      {badges.map((b) => (
        <span key={b.id} className={stateChipClass(b)} title={b.title}>
          {b.label}
        </span>
      ))}
      {/* Alerts sit at the FAR edge, away from the plain facts: they are the
          only things in this band you can click, and the one-way trip they make
          (band → rail) is easier to learn when it always starts in one place. */}
      <span className="pc-ctl-band__spacer" />
      {locksCount > 0 ? (
        <Tooltip label="Open the agent detail panel to its Locks section" side="bottom">
          <button
            type="button"
            className="pc-ctl-alert"
            onClick={() => onOpenDetail?.('locks')}
            data-testid="session-chat-alert-locks"
            aria-label={`${locksCount} lock${locksCount === 1 ? '' : 's'} — open the detail panel`}
          >
            <span className="pc-ctl-alert__inner">
              ⚠ {locksCount} lock{locksCount === 1 ? '' : 's'}
              <span className="pc-ctl-alert__chevron" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
        </Tooltip>
      ) : null}
      {unreadCount > 0 ? (
        <Tooltip label={detailChipTitle} side="bottom">
          <button
            type="button"
            className="pc-ctl-alert"
            onClick={() => onOpenDetail?.('coord')}
            data-testid="session-chat-alert-coord"
            /* WI-6504: the count must NAME its corpus. A bare "3 unread" beside
               a transcript reads as "this conversation has 3 unread", but it
               counts COORD messages — the owner reported "32 unread" next to a
               single rendered message. The visible label carries the qualifier
               and this carries the full distinction, so the explanation is
               announced to a screen reader rather than hidden in a hover. */
            aria-label={`${unreadCount} unread coord message${unreadCount === 1 ? '' : 's'} addressed to this agent — a separate list from the conversation shown here. Opens the agent detail panel.`}
          >
            <span className="pc-ctl-alert__inner">
              {unreadCount} coord unread
              <span className="pc-ctl-alert__chevron" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The live half — only mounted once a streamUrl exists, so the shared
 *  useAgentThinkingStream hook never opens its harness-run-log default URL
 *  (it only skips that when `streamUrl` is already truthy at call time).
 *
 *  EXPORTED (D-011) so the goal popup renders THIS component rather than a
 *  second chat renderer of its own — the fork D-005 forbids. Pair it with
 *  `useOwnerSessionChat`, which supplies every prop below. */
export function LiveSessionChat({
  streamUrl,
  sessionOwnerId,
  agentName,
  onSend,
  sending,
  sendError,
  focusAnchor,
  focusTerm,
  projectionTarget = null,
  onTurnIndex,
  onTopMessageIndex,
  jumpToIndex = null,
  jumpNonce = null,
}: {
  streamUrl: string;
  /** The su agent this session belongs to — resolves its roster entry for the
   *  identity chip (P-012). */
  sessionOwnerId: string;
  agentName: string;
  onSend: (text: string) => void;
  sending: boolean;
  sendError: string | null;
  /** Scroll the transcript to the message containing this text instead of
   *  opening at the tail — the HUD search result's matched turn (owner ask
   *  2026-08-02). Null/absent keeps the pre-existing tail behavior. */
  focusAnchor?: string | null;
  /** The search term — used to CORROBORATE the stream's anchor before
   *  trusting it (see the `focusIndex` memo below). */
  focusTerm?: string | null;
  /** The canonical projection identity. Unsupported source kinds deliberately
   * resolve to no row until their producer adapter lands. */
  projectionTarget?: ConversationContextProjectionTarget | null;
  /* ── The turn rail's two wires (chat-popup-turn-rail-2026-08-31 P-003) ─────
     The rail is a SIBLING of the conversation region (D-002), so it cannot see
     `projectedMessages` — which only exists here. The index therefore flows UP
     and the jump request flows DOWN. Do not resolve that by moving the rail
     inside this component: the sibling shape is the layout invariant maximize
     depends on, and nothing in the tree would catch breaking it. */
  /** Publishes the derived turn index whenever the rendered messages change. */
  onTurnIndex?: (turns: SessionTurn[]) => void;
  /** Publishes which message is under the top of the viewport, on change. */
  onTopMessageIndex?: (index: number) => void;
  /** Scroll to this message index — the rail's chosen turn ANSWER (D-005). */
  jumpToIndex?: number | null;
  /** Bumped per rail click so clicking the SAME row twice scrolls twice. */
  jumpNonce?: number | null;
}) {
  const { events, status, thinking, anchor, history, transport, lastSignalAt } = useAgentThinkingStream('', '', '', streamUrl);
  const [earlierEvents, setEarlierEvents] = useState<TimelineEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    setEarlierEvents([]);
    setHistoryCursor(null);
    setHasMoreEarlier(false);
    setHistoryReady(false);
    setLoadingEarlier(false);
    setHistoryError(null);
  }, [streamUrl]);

  useEffect(() => {
    if (!history || earlierEvents.length > 0) return;
    setHistoryCursor(history.cursor);
    setHasMoreEarlier(history.hasMore);
    setHistoryReady(true);
  }, [history, earlierEvents.length]);

  const ownerPagingEnabled = useMemo(() => {
    try {
      return Boolean(new URL(streamUrl, 'http://papercusp.local').searchParams.get('historyOwner'));
    } catch {
      return false;
    }
  }, [streamUrl]);

  const loadEarlier = useCallback(() => {
    if (!historyCursor || loadingEarlier || !hasMoreEarlier) return;
    setLoadingEarlier(true);
    setHistoryError(null);
    fetchOwnerHistoryPage(streamUrl, historyCursor)
      .then((page) => {
        setEarlierEvents((current) => [...page.entries, ...current]);
        setHistoryCursor(page.cursor);
        setHasMoreEarlier(page.hasMore);
      })
      .catch((error: unknown) => {
        setHistoryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoadingEarlier(false));
  }, [streamUrl, historyCursor, loadingEarlier, hasMoreEarlier]);

  const timelineEvents = useMemo(() => [...earlierEvents, ...events], [earlierEvents, events]);

  // P-012: the SAME advRoster.list sync query the HUD/Sessions roster read
  // (shared cache, no new endpoint) — narrowed to this session's owner so the
  // chip can reuse fleetColor/fleetRole exactly as the HUD derives them.
  // Computed BEFORE `messages` (WI-5997): its `currentPlanSlug` is the
  // per-message `planSlug` source those messages are stamped with below.
  const roster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
  });
  const rosterEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = roster.data?.[0];
    if (!payload) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    return entries.find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [roster.data, sessionOwnerId]);

  const composerState = useMemo(
    () => sessionChatComposerState(rosterEntry?.sessionState),
    [rosterEntry?.sessionState],
  );

  // WI-5997: stamp every mapped message with this session's roster
  // currentPlanSlug so a P-NNN ref pill's click can resolve which plan to
  // open (D-001 PlanPopupModal) — an approximation (uniform across the whole
  // session, not truly per-message-historical) but the one available with no
  // new query. `undefined` (no roster entry / no active plan) degrades to the
  // pre-fix behavior: a P-ref pill still renders, just stays a static link
  // (ChatMessageContent/HydratedWorkRefPill's existing no-plan-context stance).
  const mapped = useMemo(
    () => mapSessionTimeline(timelineEvents, rosterEntry?.currentPlanSlug),
    [timelineEvents, rosterEntry?.currentPlanSlug],
  );

  /* P-002: the owner's OWN sends, merged in.
     A coord:send to a LIVE agent is injected mid-turn and the timeline parser
     suppresses it (see sent-message-echo.ts's header), so without this the
     transcript never changes when you send something — which is exactly the
     "nothing happened" the owner reported against a send that had in fact
     succeeded.
     Appended at the TAIL, so `focusIndex` below — which indexes into the mapped
     stream — keeps pointing at the same turns. */
  const echoes = useSentEchoes(sessionOwnerId);
  const messages = useMemo(() => mergeSentEchoes(mapped.messages, echoes), [mapped.messages, echoes]);
  const { projection } = useConversationContextProjection(projectionTarget);
  const projectedMessages = useMemo(
    () => mergeConversationProjectionMessages(projection, messages),
    [messages, projection],
  );

  /* Search deep-link (owner ask 2026-08-02, part b). The stream's `anchor`
     event names the matched entry by its index in the FLAT timeline the server
     just sent — NOT a message index, because the mapper collapses entries into
     turns and drops tool_result/status entirely. `messageIndexForEntryIndex`
     is that translation, done at the seam that does the collapsing.

     This is the exact path; PapercupChat still takes `focusAnchor` as the
     text fallback for when the server had no anchor to give (an anchor-less
     deep-link, or a match outside the window it returned). */
  const focusIndex = useMemo(() => {
    if (!anchor?.found || anchor.index == null) return -1;
    const idx = mapped.messageIndexForEntryIndex(anchor.index);
    if (idx < 0) return -1;
    /* CORROBORATE before trusting it. `anchor.found` alone is not enough: when
       `find` matches nothing the route still answers with a window and an
       anchor, so an unverified index reads as a confident answer and scrolls
       to a turn that has nothing to do with the search. Measured live
       2026-08-02 — it anchored message 0 of 8, which did not contain the
       matched text.

       The term is short and came from the user, so requiring the focused
       message to actually contain it is a cheap, decisive check. Failing it
       returns -1, which hands the decision to the text-anchor fallback rather
       than to a wrong scroll. A missing term means nothing to corroborate
       against, so the anchor stands on its own. */
    const term = (focusTerm ?? '').trim().toLowerCase();
    if (!term) return idx;
    const content = (mapped.messages[idx]?.content ?? '').toLowerCase();
    return content.includes(term) ? idx : -1;
  }, [anchor, mapped, focusTerm]);

  /* ── The turn index (chat-popup-turn-rail-2026-08-31 P-003) ───────────────
     Derived from `projectedMessages` — the array actually on screen — for the
     reason session-turn-index.ts's header gives: the mapper collapses and drops
     entries, then echoes and projection rows are merged in, so an index built
     any earlier would address messages that are not in the list being scrolled.

     Published upward rather than rendered here, because the rail is a sibling
     of the conversation region (D-002). */
  const turns = useMemo(() => deriveSessionTurns(projectedMessages), [projectedMessages]);
  useEffect(() => {
    onTurnIndex?.(turns);
  }, [turns, onTurnIndex]);

  /* Which focus request wins — the rule itself lives in session-turn-index.ts
     (resolveFocusPrecedence) so it is testable without mounting this component.
     Inlined here it had no coverage at all, which is what the independent
     acceptance grading caught (EI-21986741094464185). */
  const {
    railJumpActive,
    focusIndex: effectiveFocusIndex,
    focusNonce: effectiveFocusNonce,
  } = resolveFocusPrecedence({ jumpToIndex, jumpNonce, focusIndex, projection: Boolean(projection) });

  // D-004: the chip is READ-ONLY (no click handler) — a plain span, only for
  // the assistant's own turns. Declining (null) on a USER turn is what hands
  // it to OperatorChat's own user-profile-icon fallback (WI-6503) — the owner's
  // own messages must wear the OWNER's icon, never this session's agent mark.
  // So this early return is load-bearing, not just an optimisation.
  const renderAvatar = useCallback(
    (m: ChatMessage): ReactNode | null => {
      // An explicit agent kind selects the pane mark below (Papercup or the
      // neutral terminal fallback). Only an entry without a kind gets the
      // roster identity chip; otherwise this override would mask the icon and
      // make the kind-to-mark contract unreachable.
      if (m.role !== 'assistant' || !rosterEntry || rosterEntry.agent !== undefined) return null;
      return (
        <span
          className="oracle-msg-avatar oracle-msg-avatar--identity"
          aria-hidden="true"
          style={
            rosterEntry.fleetColor
              ? ({ '--hud-fleet': rosterEntry.fleetColor } as React.CSSProperties)
              : undefined
          }
        >
          <span className="hud__handle">{shortHandle(rosterEntry.ownerId)}</span>
          {rosterEntry.fleetRole === 'leader' ? (
            <FleetRoleGlyph role="leader" className="hud__role" />
          ) : null}
        </span>
      );
    },
    [rosterEntry],
  );

  // WI-6503 [owner 2026-07-27, verbatim] "remove the papercup icon from the
  // chatbox for the chatboces where the conversation isnt with papercup."
  // OperatorChat's pane mark defaults to the Papercup logo, which is right for
  // the Papercup sidebar and wrong here: this modal's counterparty is whichever
  // agent the roster says it is. Resolved from the COUNTERPARTY's own agent
  // kind (never a title/label match, per the item) — so a session that really
  // IS papercup still gets the cup, via the same AGENT_MARKS table WI-4731
  // established for per-message stamps. Unknown/absent kind (a plain su
  // session) falls back to a neutral terminal mark rather than someone else's
  // branding.
  const paneIcon = (rosterEntry?.agent ? AGENT_MARKS[rosterEntry.agent] : undefined) ?? Terminal;

  /* Is what the reader is looking at actually CURRENT? (P-003 of
     gui-chat-pane-repaint-2026-08-12.)

     The ladder below used to have no answer for that. `status` only reaches
     'error' after the transport racks up three consecutive failures with zero
     successful opens, so a connection that keeps half-recovering — and one the
     transport still calls open that has quietly stopped delivering — both
     rendered a frozen transcript with NOTHING to distinguish it from a live
     one. That is what turned "the pane went deaf" into the owner's reasonable
     but wrong reading, "my message was never sent".

     `Date.now()` is read during render on purpose: the verdict is a function of
     elapsed time, and the hook re-renders us at the stale edge precisely so this
     is re-evaluated then. */
  const freshness = classifyStreamFreshness({ transport, lastSignalAtMs: lastSignalAt, nowMs: Date.now() });
  const freshnessNote = streamFreshnessMessage(freshness);

  let banner: ReactNode = null;
  if (status === 'connecting' && timelineEvents.length === 0) {
    banner = <div style={BANNER_STYLE}>Connecting to the live session…</div>;
  } else if (status === 'error') {
    banner = <div style={ERROR_BANNER_STYLE}>Lost the live connection — retrying…</div>;
  } else if (freshnessNote) {
    /* Above the empty-session branch: a pane that is behind may ALSO look empty,
       and "no conversation yet" would then be a confident false statement about
       the agent rather than an honest one about our connection to it. */
    banner = <div style={ERROR_BANNER_STYLE} data-stream-freshness={freshness}>{freshnessNote}</div>;
  } else if (status === 'live' && projectedMessages.length === 0) {
    banner = <div style={BANNER_STYLE}>No conversation text in this session yet.</div>;
  }

  return (
    <div className="pc-conversation-context-layout">
      <ConversationContextProjectionView projection={projection} />
      <div className="pc-conversation-context-layout__chat">
        <OperatorChat
          messages={projectedMessages}
          onLoadEarlier={ownerPagingEnabled && historyReady ? loadEarlier : undefined}
          hasMoreEarlier={hasMoreEarlier}
          loadingEarlier={loadingEarlier}
          focusAnchor={focusAnchor}
          // The native stream's flat-entry index cannot address projection-only
          // tool rows. Once a projection exists, use the corroborated text anchor
          // — unless the RAIL asked for a specific message, which is an index
          // into the projected array and so is valid either way.
          focusIndex={effectiveFocusIndex}
          focusNonce={effectiveFocusNonce}
          onTopMessageIndex={onTopMessageIndex}
          busy={sending}
          peerBusy={thinking}
          passive={composerState.passive}
          composerDisabled={composerState.disabled}
          composerDisabledMessage={composerState.message}
          onSend={onSend}
          banner={banner}
          error={sendError ?? historyError}
          agentName={agentName}
          renderAvatar={renderAvatar}
          paneIcon={paneIcon}
          // P-004: no footer. Everything it held was READ-ONLY state, and Direction
          // D's spatial rule is that description sits ABOVE the transcript and
          // operation below it — so those facts now render as the status band at
          // the top of the conversation region (SessionStateHeader), and the space
          // under the composer belongs entirely to controls.
          // chat-ref-pills-2026-07-26 P-008: scopes this session's WI-/EI-/F- ref
          // pills (live hydration + the popup destination) to the harness the
          // roster attributes this agent's spawned run to — the SAME roster
          // entry the identity chip (P-012) and footer (P-007) already read, no
          // new query. Null (no matching spawned-agent run, e.g. an interactive
          // psu session) degrades to static pills, same as any other
          // unscoped conversation.
          harnessSlug={projection?.session.harness ?? rosterEntry?.harnessSlug ?? undefined}
        />
      </div>
    </div>
  );
}

/**
 * One decision in the shelf: the shared `OtherDetail` card, wrapped so the
 * SHELF owns the only scroll [owner 2026-08-09: "the additional scrollable text
 * in that box is weird to navigate"].
 *
 * The measurement behind this, taken live before the fix: the escalation body
 * held 3,280 characters (486px of laid-out text) inside a scroll port
 * **24 pixels tall** — 20× its own height, nested inside the shelf list's own
 * scroll. Not a stylistic nit; a two-line reading window.
 *
 * The cause is structural, not a missing height. `.pc-items__detail` is
 * `height: 100%` — correct in the Queue, where the card owns a tall pane — and
 * its toolbar is `flex-shrink: 0`. In a height-CAPPED shelf that inverts: the
 * toolbar (chips + three sentence-long option buttons, wrapping) measured 147px
 * of the card's 146px, and the body got the remainder. So the same crowding
 * that made the buttons unreadable is what starved the text. One root, two of
 * the three asks.
 *
 * The fix is CSS (the card goes intrinsic-height, the body stops scrolling —
 * see chat-controls.css `.pc-chat-decisions`); this component adds only what
 * CSS cannot: an accessible expand toggle, so a 3,000-character escalation is
 * clamped to a readable preview instead of turning the shelf into a tunnel you
 * scroll several screens of to reach the second decision.
 *
 * Deliberately NOT pushed into `OtherDetail`: it is shared with the Queue, the
 * HUD and PreviewPanel, none of which cap their host and none of which asked
 * for a clamp.
 */
function DecisionCard({
  item,
  onResolved,
  askedAtIndex = null,
  onJump,
}: {
  item: AttentionItem;
  onResolved: () => void;
  /**
   * Message index of the turn this ask was made in, or null when it could not
   * be DERIVED (see `turnAtInstant`). Null is the common case and renders no
   * link — the parent never passes a fallback, because a jump to the wrong
   * message is worse than no jump and would pass a presence-only check.
   */
  askedAtIndex?: number | null;
  onJump?: (messageIndex: number) => void;
}) {
  // Collapsed by default: the shelf's job is "how many decisions, and roughly
  // what" — reading one in full is the deliberate act. `overflowing` is set by
  // the layout effect below, so the toggle never appears on a card that already
  // fits (a control that expands nothing reads as broken).
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // The clamp lands on `.ask-choice-card` — the request text — and NOT on the
    // body that contains it, because the body is also where the Answer box and
    // the Discuss thread mount. Clamping the body would clip a chat you had
    // just opened, which is a worse bug than the one being fixed.
    const target = () => root.querySelector<HTMLElement>('.ask-choice-card');
    // Truth comes from the laid-out element, not from a copy of the CSS clamp
    // kept in JS: overflowing IS `scrollHeight > clientHeight`, so retuning the
    // `max-height` in chat-controls.css alone can never desync the toggle from
    // what is actually clipped.
    //
    // ⚠ MEASURE ONLY WHILE COLLAPSED. Expanding removes the clamp, so the very
    // next measurement reports "fits" — which unmounted the toggle and stranded
    // the card open with no way back. Caught by DRIVING the control live rather
    // than asserting it exists: the `check` that only asserted presence passed
    // against a card in exactly that broken state. `expanded` is therefore a
    // real dependency, not an omission.
    const measure = () => {
      if (expanded) return;
      const el = target();
      setOverflowing(!!el && el.scrollHeight > el.clientHeight + 4);
    };
    measure();
    // Re-measure on reflow: the popup maximizes/drags/resizes, and the card
    // hydrates its full body in after the slim list row paints.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const el = target();
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [item.id, expanded]);

  return (
    <div className={`pc-chat-decisions__card${expanded ? ' is-expanded' : ''}`} ref={rootRef}>
      {/* key remounts per item so its local card state (answered/discuss)
          resets on selection change — same contract as OtherDetail's other
          hosts (the Queue's PlansClient, the HUD, PreviewPanel). */}
      <OtherDetail key={item.id} item={item} onResolved={onResolved} />
      {/* D-007 step 5 (WI-7323): the card answers "what needs you"; this answers
          "why". It scrolls the transcript BELOW to the turn the agent was in
          when it filed the ask — the same `onRailJump` the Orders rail drives,
          so the shelf and the rail cannot scroll to different places.

          Rendered ONLY when the parent could derive the target: `askedAtIndex`
          is null whenever the ask predates this transcript or the session was
          idle when it was filed (see `turnAtInstant`). There is deliberately no
          fallback target — "jump to the agent's last message" would look right
          in a screenshot and be wrong in the reading. */}
      {askedAtIndex !== null && onJump ? (
        <button
          type="button"
          className="pc-chat-decisions__asked-at"
          data-testid="decision-asked-at"
          onClick={() => onJump(askedAtIndex)}
        >
          see where this was asked ↑
        </button>
      ) : null}
      {/* `expanded ||` is the other half of the strand fix above: once open, the
          toggle is the ONLY way back, so it must survive its own success. */}
      {expanded || overflowing ? (
        <button
          type="button"
          className="pc-chat-decisions__more"
          aria-expanded={expanded}
          data-testid="decision-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show full request'}
        </button>
      ) : null}
    </div>
  );
}

export default function SessionChatModal({
  sessionOwnerId,
  ownerLabel,
  onClose,
  pendingLaunch = null,
  focusAnchor = null,
  focusAnchorTs = null,
  focusTerm = null,
  focusSessionId = null,
  onSelectPeer,
}: {
  /** The inbox item's ownerAgentId — null hides the modal. */
  sessionOwnerId: string | null;
  /** Friendly display label, when the caller has one (falls back to the raw id). */
  ownerLabel?: string | null;
  onClose: () => void;
  /** WI-6367: the session this modal was opened for was JUST LAUNCHED by the
   *  caller and has not booted yet. Without this, a brand-new session is
   *  indistinguishable from a long-gone one — both simply have no roster row —
   *  so the modal greeted a session that had not started with the past-tense
   *  "no longer in the live roster" / "no recent Claude session" copy, which
   *  reads as "it died". Passing the launch moment lets the boot window render
   *  as "starting up" instead. Self-clears: as soon as the session registers
   *  (roster row) or its transcript resolves, the normal branches take over. */
  pendingLaunch?: { ownerId: string; startedAtMs: number } | null;
  /** Open the transcript ON the turn containing this text rather than at the
   *  tail. HudView passes the anchor derived from the search hit that put the
   *  card on screen (`searchHitAnchor`), so clicking a search result lands on
   *  the match. Null (every other caller) is unchanged behavior. */
  focusAnchor?: string | null;
  /** ISO timestamp of the matched turn. Sent as the route's `anchorTs` so the
   *  server centers its window on THAT turn rather than the last one matching
   *  the term — the search's own ordering is newest-first, so without it a
   *  session with many matches opens on the wrong one. */
  focusAnchorTs?: string | null;
  /** The SEARCH TERM, sent as the route's `find`. Must be the short user term,
   *  not the excerpt: `find` is matched with a plain substring test against the
   *  raw entry text, and the excerpt is `ts_headline` output whose whitespace
   *  has been reflowed, so it almost never matches (measured 2026-08-02). */
  focusTerm?: string | null;
  /** The session the matched turn lives in. Search is OWNER-scoped across an
   *  agent's whole carry-respawn chain while this modal resolves the owner's
   *  LATEST session, so a hit from an earlier link is not in the transcript
   *  that would otherwise be streamed. Overrides the resolved session id for
   *  the stream only. */
  focusSessionId?: string | null;
  /**
   * chat-popup-fleet-peers-rail-2026-08-09 P-005 [owner 2026-08-09]: "Clicking
   * on a peer should update the conversation popup to display that peer."
   *
   * The modal is a pure function of props — the CALLER owns which agent is open
   * (HudView's `hudsession` param), exactly as it owns `onClose`. So switching
   * peers is the caller's write to make, not something this component can do to
   * itself.
   *
   * OPTIONAL, and its absence is a real case rather than an oversight: a host
   * that cannot re-target the popup passes nothing and the rail renders its rows
   * read-only, instead of offering clicks that quietly do nothing.
   */
  onSelectPeer?: (ownerId: string) => void;
}) {
  const open = sessionOwnerId !== null;
  const prefetchSync = useSyncPrefetch();
  useEffect(() => {
    if (!open || !sessionOwnerId) return;
    // Warm the exact key AgentOrders reads, including when the narrow layout
    // keeps its rail collapsed. The rail itself remains unsubscribed until open.
    prefetchSync({ queryName: 'agentOrders.byOwner', args: { ownerId: sessionOwnerId } });
  }, [open, sessionOwnerId, prefetchSync]);
  // P-008: this owner's pending coord-escalation(s) — the same `plans.attention`
  // feed InboxPane/the Queue read, SCOPED to this agent.
  //
  // WI-2144754: the scoping is server-side (`ownerAgentId`). This used to read
  // the shared unscoped feed and filter the result in `pendingEscalations`
  // below, but that feed is PAGED — 100 items, offset 0, and this component
  // never calls `loadMore` — so the client filter ran over page one of a
  // fleet-wide list rather than over this agent's items. Page one of a
  // fleet-wide feed is not a superset of any one agent's rows, so that filter
  // returned whatever happened to fit. Measured 2026-09-05: 145 open
  // agent-filed decision-tier escalations against that 100-item page, so some
  // owners' asks provably fall past the boundary and cannot appear in the
  // popup the owner opens to ANSWER them. An empty shelf and "nothing needs
  // you" render identically, which is why that would fail silently.
  //
  // ⚠ SCOPE OF THE ABOVE — do not read it as the cause of an empty shelf.
  // This scoping is a correctness fix for the filter, and it is NOT known to
  // fix the empty Decisions shelf. An earlier revision of this comment claimed
  // it did, citing an owner whose two open `question` escalations sat "97
  // places past the page boundary"; that inference was WRONG and is retracted.
  // Replaying the popup's own `plans:attention { limit:100, offset:0 }` read
  // puts that owner's two rows at flat index 53 and 55 — INSIDE page one — so
  // the pre-fix client filter would have found them. The feed is importance-
  // sorted, not recency-sorted; the 97 came from a SQL recency ordering that
  // does not describe feed position. Driven live with this fix provably in the
  // bundle, the shelf at first STILL read empty (modal=true, shelf=false,
  // cards=0) — but that reading was an instrument false negative, not the
  // shelf. WI-7323's close (2026-09-05T04:19Z) established the positive
  // control this comment used to say did not exist: a self-calibrating
  // headless-rig drive (.papercusp/scratch/wi7323-selfcal.sh) rendered exactly
  // 2 cards for each of two real owners and 0 for a bogus owner. Every earlier
  // `shelf=false` was uninformative for two instrument reasons recorded there:
  // tauri-agent-tools aborts an eval at ~2-5s (so a polling eval never ran),
  // and expected counts were taken from :3170 while the rig had booted a
  // different pot. The shelf itself was never broken; the one real defect is
  // the server-rejection case described two paragraphs down.
  //
  // Scoped here rather than by paging to the item: paging pulls the whole ~1MB
  // feed to find a handful of rows, and still has no bound that guarantees
  // reaching them. Disabled while closed so a hidden modal never holds an
  // extra live query open.
  // `error` is READ, not discarded — the shelf renders nothing when there are
  // no pending asks, so a FAILED feed read and a genuinely empty queue produce
  // the identical pixels: "nothing needs you". That is the one reading never
  // safe to guess, and this file's own badge already refuses to guess it (see
  // AttentionCountsRow.degraded in use-inbox-pending.ts: "Read it before
  // believing a zero").
  //
  // Not hypothetical. Measured 2026-09-05: the scoped read above sends
  // `ownerAgentId`, and a server built before that arg existed REJECTS the
  // whole call (`invalid_args: Unrecognized key` — undeclared args are
  // rejected, not ignored, EI-10883). Every running operator did exactly that,
  // so `q.data` was undefined, `items` was [], and this shelf rendered empty
  // for EVERY owner — including one with 81 matching rows. The empty shelf was
  // a failing query wearing an empty queue's clothes, and it cost a full
  // session of investigation precisely because the error had nowhere to show.
  const {
    items: attentionItems,
    refresh: refreshAttention,
    error: attentionError,
  } = useInboxAttention(open, sessionOwnerId);
  // EI-19403137552594870 (2026-08-03): this USED to require
  // `kind === 'coord-escalation' && isEscalationWithOptions(i)` — so an
  // agent's own `kind:'conversation'` question to the owner (no named
  // `ref.options`; answered via OtherDetail's inline Answer InputCard, not
  // AskChoiceCard buttons) was excluded TWICE and invisible in the very
  // popup the owner opens to answer it. Widened to any owner-owed ask this
  // session's agent filed — coord-escalation (with or without named
  // options; OtherDetail already falls back to its generic `actions` bar
  // when there are none) and conversation (OtherDetail already renders its
  // Answer action for this kind — see attention-card.ts answerAttentionItem
  // / replyToAttentionItem). Capped so a large backlog can't swallow the
  // transcript below the region (which is itself already scroll-bounded to
  // 45% height).
  const pendingEscalations = useMemo(
    () =>
      attentionItems
        .filter(
          (i) =>
            i.ownerAgentId === sessionOwnerId &&
            effectiveTier(i) !== 'handled' &&
            (i.kind === 'coord-escalation' || i.kind === 'conversation'),
        )
        .slice(0, PENDING_CARDS_MAX),
    [attentionItems, sessionOwnerId],
  );

  // gui-chat-session-controls-2026-07-25 P-002: the bottom-of-chat action
  // bar's context bag. Concrete actions (posture P-004, grade P-005, session
  // actions P-006, identity P-012) extend this via their own ctx fields —
  // this modal only owns the two fields every action can rely on.
  // P-006 (session actions): the SAME advRoster.list query LiveSessionChat
  // uses for the identity chip (P-012) — useSyncQuery shares its cache by
  // {queryName, args}, so this is a second READER of the same cached data,
  // not a second fetch. Needed here (not just in the child) because the
  // action bar's ctx is built in THIS component's scope.
  const actionRoster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
  });
  const actionRosterEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = actionRoster.data?.[0];
    if (!payload) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    return entries.find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [actionRoster.data, sessionOwnerId]);

  // EI-21590502169409362: an absent target row is ambiguous until the shared
  // roster read has answered. Preserve that distinction for the two pills
  // whose availability is derived from fields on this row: they show a
  // disabled loading placeholder while the query is in flight, then either
  // become real controls for a resolved target or disappear for a resolved
  // missing target. A target row wins over `loading` so a background refresh
  // cannot regress a populated pill back to a placeholder.
  const rosterReadState = actionRosterEntry
    ? ('resolved' as const)
    : actionRoster.loading
      ? ('loading' as const)
      : ('resolved-missing' as const);

  // hud-first-nav-and-dossier-2026-07-26 P-003: the SAME advRoster.list row
  // (actionRoster, already fetched above for the action bar — no new query)
  // re-read as a RosterEntry (AgentDossier's own prop shape) instead of
  // HudRosterEntry. Both are independently-inlined TS projections of the
  // identical server payload (same rationale as this file's own RosterPayload
  // duplicate of hud-board-model's), so the already-fetched row structurally
  // satisfies RosterEntry at runtime even though it was fetched under a
  // narrower type — cast rather than re-query.
  //
  // Declared ABOVE the chat hook (P-012) because it is now also the projection
  // that reads `thinkingResolvable` for the stream URL: RosterEntry declares
  // that field and HudRosterEntry does not, and one cast beats two.
  const dossierEntry = useMemo<RosterEntry | null>(() => {
    if (!actionRosterEntry) return null;
    return actionRosterEntry as unknown as RosterEntry;
  }, [actionRosterEntry]);

  /* Resolve only after the roster read is in scope: its canonical nativeSession
     handle is what distinguishes a Codex rollout/adv-row key from an OMP thread
     and a Claude session id. The hook retains sessions:list as the compatibility
     path when this popup is opened without a roster row. */
  const {
    resolved,
    resolveError,
    resolving,
    streamUrl,
    send: handleSend,
    sending,
    sendError,
    sentOk,
  } = useOwnerSessionChat(
    sessionOwnerId,
    { focusSessionId, focusTerm, focusAnchorTs },
    {
      agent: actionRosterEntry?.agent,
      advSessionId: actionRosterEntry?.advSessionId,
      sessionId: actionRosterEntry?.sessionId,
      ompThreadId: actionRosterEntry?.ompThreadId,
      nativeSession: actionRosterEntry?.nativeSession,
      // P-012: the roster's own transcript probe. Only `false` acts — it routes
      // the stream to the rematerialize-from-archive fallback, which is the one
      // thing that can still fill this pane once the on-disk transcript is gone.
      thinkingResolvable: dossierEntry?.thinkingResolvable,
    },
  );

  // WI-6440: the DURABLE half of the same signal. `pendingLaunch` below is
  // client-local state that dies with the page, so before this a reload during
  // the boot window dropped the modal back onto the gone-away copy for a session
  // the board was concurrently rendering as "starting" — two surfaces
  // contradicting each other about one session. This is the same `starting` tier
  // the board reads (HudView's `entries`), so they cannot disagree.
  //
  // NOT folded into `actionRosterEntry` on purpose: that row drives the dossier,
  // the footer and the action bar, and a session that has not registered has
  // nothing to put in them — leaving it null is what routes AgentDossier to its
  // "Starting up" note rather than a dossier full of blanks.
  const startingEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = actionRoster.data?.[0];
    if (!payload || !sessionOwnerId) return null;
    return (payload.starting ?? []).find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [actionRoster.data, sessionOwnerId]);

  // `active`/`pending`/`starting` answer whether an owner is live or booting;
  // the terminal tier is the separate historical answer. Keeping it separate
  // prevents an ended owner from falling through to the same "not found" copy
  // as an id that has never existed.
  const endedEntry = useMemo<{ coordOwnerId?: string | null; endedAt?: string | null } | null>(() => {
    const payload = actionRoster.data?.[0];
    if (!payload || !sessionOwnerId) return null;
    return (payload.ended ?? []).find((e) => e.coordOwnerId === sessionOwnerId) ?? null;
  }, [actionRoster.data, sessionOwnerId]);

  const rosterReady = actionRoster.data?.[0] != null && actionRoster.error == null;
  const agentKnown = Boolean(actionRosterEntry || startingEntry || endedEntry || resolved);
  const unknownSession = rosterReady && !resolving && resolveError == null && !agentKnown;
  const sessionEnded = Boolean(endedEntry) || resolved?.active === false;

  // ── WI-6367: the "starting up" window ──────────────────────────────────────
  // True while THIS modal is showing a session that has neither registered in
  // the roster nor produced a transcript yet, and that we have positive evidence
  // was launched rather than lost: either the caller just launched it
  // (`pendingLaunch`, zero-latency, fires before any roster refetch) or the
  // server still lists it as starting (WI-6440, survives a reload). Both inputs
  // are reactive (advRoster.list pushes; the resolve effect re-runs), so this
  // flips off on its own the moment the session comes online — no clearing
  // handshake with the caller. `resolved` is deliberately NOT a prerequisite:
  // sessions:list can resolve the native transcript as soon as bootstrap has
  // recorded it, before advRoster.list has observed the same owner in its live
  // presence leg. That is still the boot window, and treating a resolved live
  // transcript as proof of roster registration recreates WI-6367's gone-away
  // dossier copy (EI-20228009737109144).
  const launchedByThisView =
    pendingLaunch != null && sessionOwnerId != null && pendingLaunch.ownerId === sessionOwnerId;
  const startingUp =
    !actionRosterEntry &&
    !endedEntry &&
    resolved?.active !== false &&
    (launchedByThisView || startingEntry != null);

  // WI-6821: the server OBSERVED this launch die (terminal process gone, never
  // registered) rather than inferring it from elapsed time. Server-derived on
  // purpose — `launchedByThisView` alone can be true for a launch this client
  // fired seconds ago, and only the operator can see the process. It therefore
  // stays false until the roster says otherwise, so the honest "starting up"
  // copy still leads for a launch that is genuinely still booting.
  const launchFailed = startingEntry?.launchFailed === true;
  // WI-37841: WHY it failed, in psu's own words. Server-captured (the boot log
  // psu-launcher tees into), because the reason is printed inside the spawned
  // window and no client can ever see it. Trimmed to a couple of lines here —
  // this is a banner, not a log viewer; the full file is on disk for an agent.
  const launchFailureHint =
    launchFailed && typeof startingEntry?.launchFailureHint === 'string'
      ? startingEntry.launchFailureHint.trim()
      : '';
  // WI-6821 follow-up: a live headless host parked at a provider usage-limit
  // dialog is neither healthy boot nor process death. The roster derives this
  // from the bounded headless log receipt and supplies constructed remediation.
  const launchBlocked = !launchFailed && startingEntry?.launchBlocked === true;
  const launchBlockedHint =
    launchBlocked && typeof startingEntry?.launchBlockedHint === 'string'
      ? startingEntry.launchBlockedHint.trim()
      : '';

  // When the boot window started, for the did-not-come-online fallback below.
  // The caller's launch moment wins when we have it (it is the earlier and more
  // precise of the two); otherwise fall back to the launch record's own
  // timestamp, which is what makes the fallback work after a reload. An
  // unparseable/absent `startedAt` yields null — we then never time out, matching
  // the board's own `ageSec(...) == null` fallthrough rather than inventing a
  // failure we cannot date.
  const startedAtMs = useMemo<number | null>(() => {
    if (launchedByThisView) return pendingLaunch!.startedAtMs;
    if (!startingEntry?.startedAt) return null;
    const t = Date.parse(startingEntry.startedAt);
    return Number.isNaN(t) ? null : t;
  }, [launchedByThisView, pendingLaunch?.startedAtMs, startingEntry?.startedAt]);

  // A launch that never comes online (psu exits at boot — e.g. no usable
  // display) would otherwise sit on "starting up" forever, which is the same
  // class of lie as the copy this fixes, just in the hopeful direction. After
  // the grace window we say plainly that it did not come up. One-shot timeout,
  // not an interval — nothing here needs a ticking clock.
  // ⚠ …but "it did not come up" is only honest if we could SEE the roster.
  //
  // [owner 2026-08-01, verbatim] "in the hud tab I tried launching a new
  // session and the conversation window came up but I got that error." The
  // launch was fine. `~/.papercusp/embedded-pg.json` pointed at a dead Postgres
  // port, so every DB-backed read failed, the session could never register, the
  // grace window expired, and this banner told the owner to relaunch — advice
  // that could not possibly work, and which pointed them at their own action
  // instead of the broken backend. (`:3070/api/health` answered 200 in 1.6ms
  // throughout, so nothing else contradicted the banner either.)
  //
  // The roster IS our evidence that a session came online. When we cannot read
  // it we have no evidence in EITHER direction, so blaming the launch is a
  // fabricated diagnosis — the same class of lie as the past-tense "gone away"
  // copy WI-6367 removed, just pointed at the user's action instead of the
  // session's age. Report the thing we actually observed: we cannot reach the
  // operator.
  const rosterUnreadable = actionRoster.error != null || actionRoster.data?.[0] == null;

  const [startupTimedOut, setStartupTimedOut] = useState(false);
  useEffect(() => {
    setStartupTimedOut(false);
    if (!startingUp || startedAtMs == null) return;
    const elapsed = Date.now() - startedAtMs;
    if (elapsed >= STARTUP_GRACE_MS) {
      setStartupTimedOut(true);
      return;
    }
    const t = setTimeout(() => setStartupTimedOut(true), STARTUP_GRACE_MS - elapsed);
    return () => clearTimeout(t);
  }, [startingUp, startedAtMs]);

  // Open/collapsed state via nuqs (never useState) — deep-linkable + agent
  // -driveable, per the plan item's requirement. Defaults open: every
  // conversation opened from the HUD should carry the dossier unless the
  // viewer collapses it (or the viewport is too narrow to show it side-by-
  // side, handled separately by isNarrow below).
  const [dossierParam, setDossierOpen] = useQueryState('chatDossier', parseAsBoolean);
  const isNarrow = useIsNarrowViewport(DOSSIER_NARROW_MEDIA_QUERY);
  const dossierOpen = dossierParam ?? !isNarrow;
  const [fleetLaunchOpen, setFleetLaunchOpen] = useQueryState('chatLaunchFleet', parseAsBoolean.withDefault(true));

  /* ── chat-popup-fleet-peers-rail-2026-08-09: the FLEET rail ────────────────
     Derived HERE rather than inside the rail because the answer is load-bearing
     OUTSIDE it too: a null model means no rail, no toggle, and no widening — all
     layout decisions the rail cannot make from within itself.

     No new query. `actionRoster` above is the advRoster.list subscription this
     popup already holds (shared by {queryName, args} with the identity chip and
     the dossier), so the peers list is a filter over data that is already here.
     That is also what makes the rail PUSH-fed with nothing new wired: a member
     joining/leaving/stalling writes coord_presence, which the existing
     table-to-query bridge SSE-invalidates onto advRoster.list, which re-renders
     this memo. See fleet-peers.ts's header for the full chain. */
  const nowMs = useChatClock();
  const fleetPeers = useMemo(() => {
    const payload = actionRoster.data?.[0];
    if (!payload) return null;
    return deriveFleetPeers(payload.active ?? [], sessionOwnerId, { nowMs });
  }, [actionRoster.data, sessionOwnerId, nowMs]);
  /* EI-19968489971947616: `fleetPeers === null` collapses two different
     situations — a genuinely solo agent (no rail, correctly) and an open
     `hudsession=` id that matches NOTHING in the roster (e.g. truncated),
     which used to vanish identically. Distinguish the second so the rail can
     render an explicit "not in the roster" placeholder instead of silently
     showing nothing. Only meaningful once the roster payload has actually
     loaded — before that, `fleetPeers` being null just means "not fetched
     yet", not "unknown session". */
  const fleetUnknownSession = useMemo(() => {
    if (fleetPeers != null) return false;
    const payload = actionRoster.data?.[0];
    if (!payload) return false;
    return unknownSession && isUnknownSession(payload.active ?? [], sessionOwnerId);
  }, [fleetPeers, actionRoster.data, sessionOwnerId, unknownSession]);

  /* Room-aware default, following the NEWER of the two precedents in this file
     (Orders' D-009, not the dossier's flat withDefault(true)) — and it matters
     more here than there, because D-002 puts this rail's breakpoint at the
     widest of the three, so it is the rail most often without a column to sit
     in. [owner 2026-08-09] asked for default-OPEN, which this delivers at every
     width where the rail HAS a column; below that "expanded" would mean
     "covering the conversation you just opened", which is not what was asked
     for. An explicit ?chatFleet= choice still wins at every width, so the toggle
     never reads as a broken button.

     `??` not `||`: `false` is a real explicit choice and must not fall through
     to the derived default. (The mocked nuqs stores in this file's suite yield
     `undefined` rather than nuqs's own `null`, so both must fall through — which
     `??` does and `||` would do wrongly for `false`.) */
  const [fleetParam, setFleetOpen] = useQueryState('chatFleet', parseAsBoolean);
  const isPeersNarrow = useIsNarrowViewport(PEERS_NARROW_MEDIA_QUERY);
  const fleetOpen = fleetParam ?? !isPeersNarrow;
  /* The rail is only ever on screen for an agent that IS in a fleet, OR one
     whose id is unrecognized (EI-19968489971947616 — that gets an explicit
     placeholder, not silence). A solo agent still gets no rail AND no toggle,
     rather than a toggle that opens an empty column explaining it is empty. */
  const peersVisible = open && fleetOpen && (fleetPeers != null || fleetUnknownSession);

  /* popup-agent-state-coverage-2026-08-18 P-003/P-004: the leader-brief overlay
     for the rail above — the object a fleet LEADER is actually handed, which no
     UI read before this plan.

     Gated on the rail being ON SCREEN and the agent being in a fleet at all, so
     a collapsed rail and a solo agent both cost nothing. It is deliberately NOT
     gated on "the roster says this agent is the leader": the roster carries only
     the PRESENCE half of leadership, and presence disagreeing with the fleet
     registry is exactly the drift `coord:orient` warns leaders about. Gating on
     it here would blank the pane for the agent whose own orient says it leads.
     The server decides leadership from both sources; a non-leader costs two
     cheap reads and returns a `skipped` verdict with no brief. */
  const { leaderBrief } = useAgentLeaderBrief(
    sessionOwnerId,
    peersVisible && fleetPeers != null,
  );
  const leaderBriefAlerts = useMemo(() => deriveLeaderBriefAlerts(leaderBrief), [leaderBrief]);

  /* P-015: the Orders panel's own toggle, nuqs like every other bit of this
     popup's state. Defaults OPEN, same as the dossier
     [owner 2026-08-03, verbatim: "In the HUD tab when opening a conversation
     the 'ORDERS — what they were told' should be expanded by default"] —
     superseding the original opt-in default, which reasoned from
     cost: `agentOrders.byOwner` is a separate heavier query (it runs the
     carry-brief gather), so a panel nobody opened cost nothing. That trade is
     now decided the other way: what the agent was TOLD is the context a reader
     needs to make sense of the transcript they just opened, so the popup pays
     the gather by default.

     `ordersVisible` below still gates the live subscription. A collapsed rail
     gets one cache prefetch on modal open, then pays no ongoing query cost.
     Keep the query separate from agentDetail.byOwner for that reason.

     ── Why the default is DERIVED rather than a plain withDefault(true) ──────
     (WI-35470, D-009.) There is no width at which "expanded" and "not covering
     the transcript" are both achievable: below ORDERS_NARROW_MEDIA_QUERY the
     rail has no column to take and renders as an OVERLAY, so a blanket
     default-open put a panel on top of the very conversation the reader just
     opened — measured at 1100px, the rail sat x=28→328 over a conversation
     spanning x=28→772.

     So the three cases are separated, and only the third moves:
       - an EXPLICIT choice (?chatOrders=…) always wins, at every width. That
         keeps P-015's overlay rationale exactly intact: a toggle that silently
         did nothing on a narrow window would read as a broken button.
       - no choice + room for a column  ⇒ OPEN  (the owner's ask).
       - no choice + no room            ⇒ CLOSED, because "expanded" there means
         "covering what you opened", which is not what was asked for.
     `null` is nuqs's absent-param value; the mocked stores used by this file's
     suite yield `undefined`, so `??` (not `||`) is load-bearing — `false` is a
     real explicit choice and must not fall through to the derived default. */
  const [ordersParam, setOrdersOpen] = useQueryState('chatOrders', parseAsBoolean);
  /* ── the TURN RAIL (chat-popup-turn-rail-2026-08-31 P-004) ────────────────
     The fifth zone, and the only one that is about the TRANSCRIPT rather than
     about the agent — so it sits closest to the conversation, on its left.

     Open by default: it is a navigation aid for the thing the popup exists to
     show, and a reader who has to find a toggle before they can see where they
     are has the problem this plan was filed to fix. `chatTurns` in the URL is
     the only thing that hides it, exactly like the other three rails.

     It has no OVERLAY style, deliberately (D-003). Below its breakpoint it
     switches to spine density instead — a position indicator you must open a
     drawer to read has stopped being one. */
  const [turnsParam, setTurnsOpen] = useQueryState('chatTurns', parseAsBoolean);
  const isTurnsNarrow = useIsNarrowViewport(TURNS_NARROW_MEDIA_QUERY);
  const turnsOpen = turnsParam ?? true;
  const turnsVisible = open && turnsOpen;

  /* The rail's own state. `turns` and `topMessageIndex` are PUBLISHED UP from
     LiveSessionChat (D-002); `jump` flows back down. The nonce is what makes a
     second click on the row you are already parked on scroll again — focus is
     keyed on the request, so an unchanged index alone would be a no-op. */
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [topMessageIndex, setTopMessageIndex] = useState(-1);
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const liveTurn = useMemo(
    () => turnAtMessageIndex(turns, topMessageIndex),
    [turns, topMessageIndex],
  );
  const onRailJump = useCallback((messageIndex: number) => {
    setJump((prev) => ({ index: messageIndex, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* D-007 step 5 (WI-7323): per-pending-card jump target, derived HERE because
     this is the only scope holding both the cards and `turns` (the rail's own
     index, published up from LiveSessionChat). Keyed by item id rather than
     position so a card that arrives or resolves cannot shift another card's
     target. An item missing from the map has NO derivable target and renders no
     link — see `turnAtInstant` for why -1 is the honest answer there. */
  const askedAtJumpIndex = useMemo(() => {
    const out = new Map<string, number>();
    for (const it of pendingEscalations) {
      const t = turnAtInstant(turns, it.occurredAt);
      if (t >= 0) out.set(it.id, turns[t].jumpIndex);
    }
    return out;
  }, [pendingEscalations, turns]);

  const isOrdersNarrow = useIsNarrowViewport(ORDERS_NARROW_MEDIA_QUERY);
  const ordersOpen = ordersParam ?? !isOrdersNarrow;

  /* ── P-001 maximize ──────────────────────────────────────────────────────
     The whole mechanism — the two modes, the URL param, the browser/desktop
     split for `screen`, the fullscreen-exit sync, the Esc handler and the
     never-strand-the-display cleanups — lives in `usePopupMaximize`. Shared
     with GoalDetailPanel since 2026-08-10; read that file's header, not a
     re-derivation here. */
  const {
    mode: chatMax,
    maximized,
    screenActive,
    screenMechanism,
    popupRef,
    toggleWindow,
    toggleScreen,
    reset: resetMaximize,
  } = usePopupMaximize({ param: 'chatMax', open });
  /* Focus target (`onOpenAutoFocus`) and the scroll container the reader came
     for. NOT the fullscreen target — that is the hook's `popupRef`, which goes
     on the popup CONTAINER (D-007). */
  const conversationRef = useRef<HTMLDivElement | null>(null);

  /* P-015: whether the Orders panel is actually on screen. Since D-007 maximize
     is NOT part of this answer — the panel shows in every mode, and the only
     thing that hides it is the user closing it. This still GATES THE FETCH:
     `agentOrders.byOwner` runs the carry-brief gather, so a closed panel must
     not keep a live subscription. */
  const ordersVisible = open && ordersOpen;
  // Moving between the edge strip and header remounts the control. Keep
  // keyboard focus on that same action after its URL state changes.
  const panelFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const testId = panelFocusRef.current;
    if (!testId) return;
    popupRef.current?.querySelector<HTMLButtonElement>('[data-testid="' + testId + '"]')?.focus({ preventScroll: true });
    panelFocusRef.current = null;
  }, [ordersOpen, dossierOpen, fleetOpen, popupRef]);

  const panelToggle = (panel: 'orders' | 'activity' | 'fleet') => {
    const { label, describe, side, visible, setOpen, testId } = {
      orders: { label: 'Orders', describe: 'agent orders', side: 'left' as const, visible: ordersOpen, setOpen: setOrdersOpen, testId: 'session-chat-orders-toggle' },
      activity: { label: 'Activity', describe: 'agent activity', side: 'right' as const, visible: dossierOpen, setOpen: setDossierOpen, testId: 'session-chat-dossier-toggle' },
      fleet: { label: 'Fleet', describe: 'fleet peers', side: 'right' as const, visible: fleetOpen, setOpen: setFleetOpen, testId: 'session-chat-fleet-toggle' },
    }[panel];
    return (
      <PanelToggleButton
        label={label}
        describe={describe}
        side={side}
        open={visible}
        placement={visible ? 'panel' : 'edge'}
        onToggle={() => {
          panelFocusRef.current = testId;
          void setOpen(!visible);
        }}
        data-testid={testId}
      />
    );
  };

  /* ── how wide the popup has to be ─────────────────────────────────────────
     Replaces the nested ternary that enumerated the rail COMBINATIONS: with
     three rails that is eight cases, and the fourth zone would have made it
     sixteen — a shape where adding a rail means editing every branch and
     forgetting one is invisible. Summing the columns instead means a rail
     contributes its own width and nothing else has to know it exists.

     Only a rail that TAKES A COLUMN counts. Below its own breakpoint a rail
     OVERLAYS (it is drawn on top of the conversation, not beside it), so
     widening for it would leave a band of empty popup behind the drawer.

     The +16 per rail is its gutter; the 720 base is the transcript's own
     comfortable width, which is what this whole scheme protects — the popup
     grows to make room for a rail rather than the transcript shrinking. */
  const railColumns =
    (ordersVisible && !isOrdersNarrow ? 272 + 16 : 36) +
    (dossierOpen && !isNarrow ? 300 + 16 : 36) +
    (fleetPeers || fleetUnknownSession ? (peersVisible && !isPeersNarrow ? 248 + 16 : 36) : 0) +
    /* The turn rail contributes at BOTH densities, because unlike the other
       three it never overlays (D-003) — it always takes a column, just a
       narrower one once space runs out. */
    (turnsVisible ? (isTurnsNarrow ? TURN_SPINE_WIDTH : TURN_RAIL_WIDTH) + 16 : 0);

  /* Leaving the popup must not leave the browser in fullscreen or the mode in
     the URL — reopening any session would otherwise inherit a maximize the
     user never asked for on it. */
  const closeChat = useCallback(() => {
    resetMaximize();
    onClose();
  }, [resetMaximize, onClose]);

  // hud-first-nav-and-dossier-2026-07-26 P-004 (D-002's one deliberate
  // duplicate): the footer's "⚠ N locks / M unread" chip opens the rail
  // (it may be collapsed) and scrolls it to the named section — a plain DOM
  // query rather than plumbing a ref down through AgentDossier, since the
  // rail and the footer are siblings under this component, not parent/child.
  const scrollToDossierSection = useCallback(
    (section: 'locks' | 'coord') => {
      void setDossierOpen(true);
      // Wait a frame so a just-opened rail has mounted before we query it.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-testid="session-chat-dossier-rail"] #pc-dossier-${section}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [setDossierOpen],
  );

  const actionCtx: ChatActionContext | null = useMemo(
    () =>
      sessionOwnerId
        ? {
            sessionOwnerId,
            ownerLabel,
            rosterReadState,
            // P-006 (session actions): only Claude consumes `sessionId`; OMP
            // reads ompThreadId and Codex remains gated by the console-launch
            // action until its CODEX_HOME/rollout contract is wired there.
            agent: actionRosterEntry?.agent ?? null,
            sessionId: resolved?.source_kind === 'claude' ? resolved.session_id : null,
            advSessionId: actionRosterEntry?.advSessionId ?? null,
            windowId: actionRosterEntry?.windowId ?? null,
            // SessionActionCtx declares these two as "supplied by
            // SessionChatModal from the SAME advRoster.list entry" and they were
            // not (EI-20209690740975295): `focusWindow` posts
            // { advSessionId, windowId, pid } and was always sending
            // pid: undefined, and `resumableSessionId` falls back
            // sessionId ?? ompThreadId — so an omp session with no resolved
            // Claude transcript id silently offered no Resume at all.
            ompThreadId: actionRosterEntry?.ompThreadId ?? null,
            pid: actionRosterEntry?.pid ?? null,
            // P-005: the mode pills read their CURRENT value from here. Same
            // roster row the status band renders, so the pill and the rest of
            // the surface cannot disagree about what is set — and it costs no
            // fetch, which is what lets `current()` stay pure and synchronous.
            modes: actionRosterEntry?.modes ?? [],
            // P-003: the ACCOUNT pill's current value, from the SAME roster row
            // — which is what lets its `current()` stay pure and synchronous
            // rather than putting a gateway:owner_report fetch on every popup
            // open. `undefined` (an older operator's payload has no such field)
            // is deliberately NOT collapsed to null: the axis reads it as
            // "unknown" and omits the pill, where null means "no dynamic pin".
            accountPin: actionRosterEntry?.accountPin,
            // P-002: the MODEL pill parses its current spec out of the session's
            // own launch argv, off the SAME roster row — the effective value the
            // session actually launched with, never a predicted one (D-009 §B).
            //
            // NOT `?? []`. The two absences differ and the axis reads them
            // differently: `undefined` (no roster row yet, or an older payload)
            // means UNKNOWN and omits the pill, while an EMPTY array is a
            // positive claim that the argv carries no --model, which the pill
            // renders as "default". Defaulting here would make a session whose
            // row has not arrived assert it is on the backend default.
            launchArgv: actionRosterEntry?.launchArgv,
            // P-004: the CTX (token-limit) pill's current value, off the SAME
            // roster row whose `compactionLimit` is the `ctx N%` denominator in
            // the status band — so the pill and that percentage cannot disagree
            // about which limit is in force.
            //
            // Preserve the roster value exactly, including `undefined` for an
            // older/partial payload. Omitting the key entirely made the pill
            // read 'auto' for EVERY session, including ones with a real stored
            // limit (EI-20207719407463922); preserving the raw value keeps the
            // action context honest and leaves unknown distinct from an
            // explicit null for future axis readers.
            compactionLimit: actionRosterEntry?.compactionLimit,
          }
        : null,
    [sessionOwnerId, ownerLabel, actionRosterEntry, resolved, rosterReadState],
  );

  const agentName = ownerLabel || sessionOwnerId || 'agent session';
  /* The ACCESSIBLE dialog name. Radix keeps `Dialog.Title` at display:none here,
     so this is never on screen — the visible title is SessionNameField in the
     status band — but a screen reader announces it on open, and announcing a raw
     owner id is exactly the regression this plan set out to fix. Resolved
     through the shared chain (D-003) so the two cannot disagree; falls back to
     the old label while the roster row has not arrived. */
  const headlineName = actionRosterEntry
    ? sessionDisplayName({
        manualName: actionRosterEntry.displayName,
        objective: actionRosterEntry.objective ?? actionRosterEntry.intent,
        ownerId: actionRosterEntry.ownerId,
        shortHandle: shortHandle(actionRosterEntry.ownerId),
      }).name
    : agentName;
  const title = `Chat — ${headlineName}`;

  /* While the header's name field is in edit mode, Escape belongs to THAT edit
     (see SessionNameField: Radix takes Escape on document in the capture phase,
     so disarming the dialog is the only way to hand it over). */
  const [renaming, setRenaming] = useState(false);

  /* P-007's write path, wired here rather than in the band so the band stays a
     presentation component: it is handed a committed-name callback, not a fetch.
     Absent until an owner-scoped action context exists — which is also when
     there is nothing to route a rename to. */
  const handleRename = useCallback(
    async (name: string) => {
      if (!actionCtx) throw new Error('no session action context');
      const { renameSession } = await import('@/lib/chat-actions/SessionActions');
      await renameSession(actionCtx, name);
      // No client-side invalidation: the route fires notifySyncInvalidate on the
      // SERVER after the write commits, which is what reaches every open board —
      // not just this one — over the SSE transport the desktop always runs.
    },
    [actionCtx],
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) closeChat();
      }}
      title={title}
      /* P-001: while the browser is painting the conversation fullscreen, Esc
         is the user's way OUT of fullscreen — the UA consumes it and never
         dispatches the keydown. Leaving the dialog's own Esc handler armed
         means the one press both drops fullscreen and closes the chat, so the
         conversation the user was reading disappears when they only asked for
         a smaller window. */
      /* …and `!renaming` for the same shape of reason one layer in: while the
         header's name field is being edited, Escape means "cancel this edit".
         Radix takes Escape on `document` in the CAPTURE phase, so the input
         cannot claim it by stopping propagation — disarming the dialog is the
         only handover there is. */
      closeOnEscape={!screenActive && !renaming}
      /* Send the dialog's initial focus to the CONVERSATION, not to a window
         control. Radix otherwise focuses the first tabbable descendant, which
         since P-001 is the full-window button — and that button is a tooltip
         trigger, so focusing it OPENS the tooltip, which mounts its own
         dismissable layer and eats the first Escape. The chat then ignored the
         first Escape press entirely (caught by the pre-existing "calls onClose
         when the dialog is dismissed" test, which is why it is a test worth
         having). Focusing the transcript is also the better landing spot: it is
         what the reader opened the popup for, and it is scrollable by keyboard. */
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        conversationRef.current?.focus();
      }}
      wrapStyle={maximized ? { padding: 0 } : undefined}
      contentStyle={
        maximized
          ? {
              // Fill the app window edge to edge. `100dvh` rather than `100vh`
              // so a mobile/overlay browser chrome bar cannot push the
              // composer below the fold — the composer is the half of this the
              // owner explicitly asked to keep.
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
              // hud-first-nav-and-dossier-2026-07-26 P-003: widen to make room for
              // the dossier rail when it's open AND there's room to show it
              // side-by-side; on a narrow viewport the rail overlays instead
              // (DOSSIER_RAIL_OVERLAY_STYLE below), so the modal stays at its
              // original width rather than crushing the transcript.
              // P-015: three columns need ~1240px (272 orders + ~560
              // conversation + 300 dossier + chrome). The ladder is
              // both-open → dossier-only → bare, so opening Orders widens the
              // popup rather than crushing the transcript between two panels.
              width: `min(${720 + railColumns}px, ${railColumns > 0 ? 97 : 92}vw)`,
              height: 'min(88dvh, 960px)',
              borderRadius: 16,
              overflowX: 'hidden',
              overflowY: 'hidden',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }
      }
    >
      <div
        ref={popupRef}
        className="session-chat"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
          // D-007: this is the fullscreen target, and a DOM-fullscreened element
          // is transparent by default (the UA paints only ::backdrop, black), so
          // without this the panels would sit on bare black instead of the
          // popup's own surface. Scoped to the browser mechanism: on the desktop
          // path (D-006) nothing is lifted out of the page and the modal's
          // surface is already behind us.
          ...(screenMechanism === 'document' ? { background: 'var(--bg-popover, #0d1829)' } : null),
        }}
        data-testid="session-chat-modal"
      >
        {/* ── ORDERS (P-015) — the LEFT panel, and deliberately the FIRST child
            so the DOM order matches the reading order the layout promises:
            told → conversation → did. A screen reader and a sighted user get
            the same causal sequence.

            A SIBLING of the conversation region, never a child — the layout
            contract P-015's own guard asserts. Since D-007 that no longer means
            "excluded from maximize": the fullscreen target moved UP to the
            popup container that holds this rail, the conversation and the
            Activity rail alike, so a sibling is INCLUDED by construction. ── */}
        {open && (isOrdersNarrow || !ordersVisible) ? (
          <div className="pc-zone pc-zone--orders pc-panel-dock" data-testid="session-chat-orders-dock">
            {!ordersVisible ? panelToggle('orders') : null}
          </div>
        ) : null}
        {ordersVisible ? (
          <div
            /* `pc-zone` is what carries the Framed vocabulary into the rail: it
               defines --pc-zone-rule (used by this element's own border, above)
               and scopes the framed-card treatment to the POPUP, so the same
               AgentDossier rendered in the /adv two-pane is untouched. */
            className="pc-zone pc-zone--orders pc-panel-surface"
            data-testid="session-chat-orders-rail"
            style={isOrdersNarrow ? ORDERS_RAIL_OVERLAY_STYLE : ORDERS_RAIL_SIDE_STYLE}
          >
            <AgentOrders
              ownerId={sessionOwnerId ?? ''}
              enabled={ordersVisible}
              ownerKnown={unknownSession ? false : rosterReady ? agentKnown : undefined}
              onClose={() => void setOrdersOpen(false)}
              headerControl={panelToggle('orders')}
            />
          </div>
        ) : null}
        {/* ── TURNS (chat-popup-turn-rail-2026-08-31 P-004) — the fifth zone,
            and the innermost on this side: every other rail describes the
            AGENT, this one describes the transcript it sits against, so it
            belongs next to it.

            A SIBLING of the conversation region like the other three
            (chat-popup-turn-rail-2026-08-31 D-002) — which is also what puts it
            inside the maximize target for free. Do NOT move it into the
            conversation element to make something line up. That instruction is
            now TESTED: SessionChatModal.test.tsx asserts both nesting directions
            and that the rail stays inside the popup container. Before those
            tests it was prose only, which is exactly the state D-002 warns about.

            No overlay branch by design (chat-popup-turn-rail-2026-08-31 D-003):
            under width pressure this rail changes DENSITY rather than becoming a
            drawer.

            ⚠ Decision ids are PLAN-LOCAL and collide in this file: the
            `D-007 superseded D-002` note further down belongs to a DIFFERENT
            plan, as does the `D-002 seam` cited in the ref-pill tests. Always
            qualify a D-NNN here with its plan slug. ── */}
        {turnsVisible ? (
          <div
            className="pc-zone pc-zone--turns"
            data-testid="session-chat-turn-rail"
            style={isTurnsNarrow ? TURN_SPINE_SIDE_STYLE : TURN_RAIL_SIDE_STYLE}
          >
            <TurnRail
              turns={turns}
              liveTurn={liveTurn}
              density={isTurnsNarrow ? 'spine' : 'rail'}
              onJump={onRailJump}
              onClose={() => void setTurnsOpen(false)}
            />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* THE conversation region: transcript, composer, status band, and the
            escalation cards that are part of the conversation.

            ⚠ It is NO LONGER the fullscreen target (D-007 superseded D-002) —
            `requestFullscreen()` is called on `popupRef` above, the container
            that also holds the two rails and the bands below. Re-pointing it
            here would restore the old behavior and silently drop all four
            panels from full screen, which is the bug the owner reported. */}
        <div
          ref={conversationRef}
          data-testid="session-chat-conversation"
          /* -1: focusable so `onOpenAutoFocus` can land here, but NOT tabbable,
             so it never becomes a stop in the Tab order itself. */
          tabIndex={-1}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
        <div className="pc-chat-heading">
        {actionRosterEntry ? (
          <SessionStateHeader
            entry={actionRosterEntry}
            onOpenDetail={scrollToDossierSection}
            onRename={actionCtx ? handleRename : undefined}
            onRenamingChange={setRenaming}
          />
        ) : null}
        {open ? (
          <div className="pc-chat-window-actions" data-testid="session-chat-toolbar">
            {/* Tooltip, not a `title=` attribute: these are ICON-ONLY buttons, so
                the hover text is the only place their meaning is written for a
                sighted user — and a native title is unreachable by keyboard and
                on touch. `lint:design-primitives` fails a title on a <button>
                for exactly this reason. */}
            <Tooltip
              label={chatMax === 'window' ? 'Exit full window' : 'Fill the app window with the conversation'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleWindow}
                aria-pressed={chatMax === 'window'}
                aria-label={chatMax === 'window' ? 'Exit full window' : 'Full window'}
                data-testid="session-chat-full-window"
                style={PANEL_TOOLBAR_BUTTON_STYLE}
              >
                {chatMax === 'window' ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            <Tooltip
              label={screenActive ? 'Exit full screen' : 'Fill the whole screen with the conversation'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleScreen}
                aria-pressed={screenActive}
                aria-label={screenActive ? 'Exit full screen' : 'Full screen'}
                data-testid="session-chat-full-screen"
                style={PANEL_TOOLBAR_BUTTON_STYLE}
              >
                {screenActive ? <Minimize size={12} aria-hidden="true" /> : <Maximize size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            {/* Maximized covers the backdrop, and in fullscreen Esc is spoken
                for — so without an explicit ✕ there is no way out but the
                maximize toggles. */}
            {maximized ? (
              <Tooltip label="Close conversation" side="bottom" align="end">
                <button
                  type="button"
                  className="pc-button"
                  onClick={closeChat}
                  aria-label="Close conversation"
                  data-testid="session-chat-close"
                  style={PANEL_TOOLBAR_BUTTON_STYLE}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        </div>
        {resolving ? (
          <div style={BANNER_STYLE}>Finding this agent's session…</div>
        ) : resolveError ? (
          // WI-5364: friendly headline first — the raw transport error (status
          // codes, JSON) is real diagnostic signal but not owner-facing copy,
          // so it rides below in small muted mono instead of leading.
          <div style={ERROR_BANNER_STYLE} data-testid="session-chat-resolve-error">
            <div>Couldn't load this agent's conversation right now — try reopening the popup.</div>
            <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--font-mono, monospace)', color: 'var(--fg-mute)', overflowWrap: 'anywhere' }}>
              {resolveError}
            </div>
          </div>
        ) : startingUp ? (
          // WI-6367: a session launched seconds ago has no roster row and no
          // transcript yet — the same shape as one that ended long ago. Say
          // which it is, in the present tense, instead of the gone-away copy.
          <div style={BANNER_STYLE} data-testid="session-chat-starting-up">
            {launchFailed
              ? // WI-6821: not a timeout — the operator OBSERVED this launch die
                // (its terminal process is gone and it never registered). That is
                // evidence, so this is stated flatly and immediately, with no
                // "may have" hedge and no 60s wait for a timer to guess it.
                //
                // WI-37841: and when we captured what psu printed on its way out,
                // SHOW IT. Without the cause this banner could only ever say "the
                // terminal closed" plus "try again" — advice that cannot work when
                // the failure is deterministic, and which twice sent the owner to
                // retry a launch that failed identically every time. The retry
                // suggestion is therefore dropped whenever a cause is present:
                // with a reason on screen, "try again" is noise at best.
                (
                  <>
                    <div>
                      This session’s launch failed — its terminal closed before the session came
                      online.{launchFailureHint ? '' : ' Try launching it again.'}
                    </div>
                    {launchFailureHint ? (
                      <div
                        data-testid="session-chat-launch-failure-hint"
                        style={{
                          marginTop: 4,
                          fontSize: 10,
                          fontFamily: 'var(--font-mono, monospace)',
                          color: 'var(--fg-mute)',
                          overflowWrap: 'anywhere',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {launchFailureHint}
                      </div>
                    ) : null}
                  </>
                )
              : launchBlocked
                ? (
                  <>
                    <div data-testid="session-chat-launch-blocked">
                      This session is waiting at a provider usage-limit screen, so it cannot take a
                      turn.
                    </div>
                    <div
                      data-testid="session-chat-launch-blocked-hint"
                      style={{
                        marginTop: 4,
                        fontSize: 10,
                        fontFamily: 'var(--font-mono, monospace)',
                        color: 'var(--fg-mute)',
                        overflowWrap: 'anywhere',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {launchBlockedHint ||
                        'Choose another account or backend, or retry after the provider limit resets.'}
                    </div>
                  </>
                )
              : startupTimedOut
                ? rosterUnreadable
                  ? "Can't reach the operator to check on this session — this looks like a connection problem, not a failed launch. Relaunching won't help until it's back."
                  : "This session hasn't come online. The launch may have failed — try launching it again."
                : 'Starting up — waiting for this session to come online…'}
          </div>
        ) : unknownSession ? (
          <div style={BANNER_STYLE} data-testid="session-chat-unknown-session">
            No agent with this id was found in the current roster or session history.
          </div>
        ) : !resolved ? (
          <div style={BANNER_STYLE}>
            No recent session found for this agent.
          </div>
        ) : streamUrl && sessionOwnerId ? (
          <>
            {/* P-012 / D-011: `thinkingResolvable === false` is a PROPERTY of
                the record — the operator ALREADY probed this session's recorded
                id and found no transcript — not a measurement we failed to
                take, so it is said out loud rather than left to present as an
                empty pane (WI-2680: an empty inspector reads as "the agent is
                silent", which is the one thing it does not mean).

                The view is MARKED, never suppressed: the stream still mounts,
                because the `ended=1` fallback this flag now also triggers can
                still rematerialize the transcript from the archive, and a
                federated/older payload that carries no flag says nothing here. */}
            {dossierEntry?.thinkingResolvable === false ? (
              <div
                style={{ ...BANNER_STYLE, color: 'var(--warn, #fbbf24)' }}
                data-testid="session-chat-thinking-unresolvable"
              >
                No live transcript for this session — the operator probed its recorded id and found
                none (it has ended, or its transcript was rotated away since it last took a turn).
                Anything below is replayed from the archive; an empty pane means the archive had no
                copy either, NOT that this agent has gone quiet. Messages you send still reach its
                inbox.
              </div>
            ) : null}
            <LiveSessionChat
              streamUrl={streamUrl}
              sessionOwnerId={sessionOwnerId}
              agentName={agentName}
              onSend={handleSend}
              sending={sending}
              sendError={sendError}
              focusAnchor={focusAnchor}
              focusTerm={focusTerm}
              projectionTarget={resolved && (focusSessionId || resolved.stream_key !== 'codexSessionKey') ? {
                sourceKind: resolved.source_kind,
                sessionId: focusSessionId || resolved.session_id,
                harness: actionRosterEntry?.harnessSlug ?? null,
              } : null}
              /* The turn rail's two wires (chat-popup-turn-rail-2026-08-31
                 D-002 — plan-qualified, because bare D-NNN ids collide in this
                 file): the index comes UP from here, because this is the only
                 component that holds the rendered messages; the jump goes back
                 DOWN. */
              onTurnIndex={setTurns}
              onTopMessageIndex={setTopMessageIndex}
              jumpToIndex={jump?.index ?? null}
              jumpNonce={jump?.nonce ?? null}
            />
          </>
        ) : null}
        {/* P-002: say what ACTUALLY happened. "Staged" is the case this fixes —
            a manual-wake-mode agent has the message held for you to release, so
            reporting a bare "Sent" sends the human away believing they have
            asked for something that is not yet in front of anyone. */}
        {sentOk ? (
          <div
            style={sentOk.kind === 'woken' ? BANNER_STYLE : { ...BANNER_STYLE, color: 'var(--warn, #fbbf24)' }}
            data-testid="session-chat-send-outcome"
            data-delivery={sentOk.kind}
          >
            {sentOk.kind === 'woken'
              ? 'Sent — the agent was woken and is working on it.'
              : sentOk.kind === 'staged'
                ? 'Staged — this agent has manual wakes, so the message is held until you release it. It is not working on this yet.'
                : sentOk.kind === 'absent'
                  ? 'Delivered to the inbox, but no live session picked it up — the agent may need respawning.'
                  : 'Delivered to the agent’s inbox — it will be read at its next turn.'}
          </div>
        ) : null}
        {/* ── DECISIONS shelf [owner 2026-08-09, verbatim: "those decision
            buttons at the top of the conversation should be displayed at the
            bottom instead. fix that now. Also improve the design of it as you
            do that"].

            It used to sit between the status band and the transcript, where a
            45%-tall block could eat half the popup before a single message was
            readable. Bottom is also where this file's OWN spatial rule already
            put it (see the status-band comment above: "description sits above
            and operation below") — answering an escalation is operation, so
            the move settles an inconsistency rather than inventing a new rule.

            LAST child of the conversation region, not a sibling after it: that
            keeps it inside what maximize paints (the same reason D-007 gives
            for the bottom band) and directly above the action bar, so every
            thing you can DO to this session is one contiguous stack.

            `.pc-zone` is load-bearing, not decorative — chat-controls.css
            defines the zone vars ON the zone roots, so a container that holds
            a `.pc-zone-title` without it resolves the cap's fill to `unset`:
            an invisible cap rather than a loud failure. ── */}
        {pendingEscalations.length > 0 || attentionError ? (
          <section
            className="pc-zone pc-chat-decisions"
            data-testid="session-chat-pending-escalations"
            aria-label="Decisions that need you"
          >
            {/* Mirrors the Orders / Activity / Fleet title bars so the shelf
                reads as one of the popup's zones rather than a stray panel. */}
            <header className="pc-zone-title">
              <span>Decisions</span>
              {/* "you", not "they": the other zones describe the AGENT, this
                  one is the only zone addressed to the reader. */}
              <span className="pc-zone-title__sub">— what needs you</span>
              {/* No count while the read is failing: a "0" here would assert
                  the very fact we could not establish. */}
              {attentionError ? null : (
                <span className="pc-chat-decisions__count">{pendingEscalations.length}</span>
              )}
            </header>
            {/* [owner 2026-08-09] "What do those buttons actually do its
                unclear." The two rows of buttons below do CATEGORICALLY
                different things and nothing on screen said so: an answer is a
                terminal, agent-waking, not-undoable-here act; Discuss touches
                no server state at all. Stated once for the shelf rather than
                per card — the split is a property of the surface, and repeating
                it under every decision would be the noise the owner is already
                complaining about.

                Every clause is checked against the dispatch it describes:
                `resolveAttentionAction` (coord-escalation branch) resolves the
                escalation and then best-effort delivers the picked option's
                LABEL to `item.ownerAgentId`, waking them; `discuss` is in
                NAVIGATE_ACTION_IDS, so it returns before any of that and only
                opens DiscussPanel. Change either and change this line. */}
            {attentionError ? (
              /* The read FAILED. Say so, and say it in the shelf's own body
                 rather than as a toast: the question the reader came here to
                 answer is "what needs me", and the honest answer is "we could
                 not find out", never a silent absence. Retry is offered
                 because the common causes (a stale server, a transient sync
                 failure) are cleared by re-asking, not by reloading the app. */
              <div data-testid="session-chat-pending-escalations-error">
                <p className="pc-chat-decisions__legend">
                  <b>Couldn’t load decisions.</b> This is <em>not</em> the same as having none —
                  this agent may still be waiting on you.
                </p>
                <p className="pc-chat-decisions__legend">{attentionError}</p>
                {/* Reuses the shelf's own button style rather than inventing a
                    class: `__more` is already the shelf's full-width, quiet,
                    accent-strong affordance, and it is styled. */}
                <button type="button" className="pc-chat-decisions__more" onClick={refreshAttention}>
                  Retry
                </button>
              </div>
            ) : (
              <>
                <p className="pc-chat-decisions__legend">
                  Picking an answer replies to the agent, wakes it, and closes the decision.
                  {' '}
                  <b>Discuss</b> just opens a thread — it answers nothing.
                </p>
                <div className="pc-chat-decisions__list">
                  {pendingEscalations.map((i) => (
                    <DecisionCard
                      key={i.id}
                      item={i}
                      onResolved={refreshAttention}
                      askedAtIndex={askedAtJumpIndex.get(i.id) ?? null}
                      onJump={onRailJump}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        ) : null}
        </div>
        {/* ── The BOTTOM band. Below the conversation region, and since D-007
            inside what maximize paints — the owner asked for it in both modes.
            The only gate left is `actionCtx`, which is about whether there is a
            live session to act ON, not about layout. ── */}
        {actionCtx && (
          <>
            {/* Renders whatever askUserLocal card an action's params()/confirm
                step opens (P-002 substrate) — the SAME renderer the
                agent-initiated card path uses, mounted here so action-bar
                cards appear inline in this modal specifically. */}
            <LocalCardHost />
            <ChatActionBar ctx={actionCtx} />
          </>
        )}
        {/* WI-6505 (owner ask 2026-07-27): the fleet-launch row is ALWAYS
            visible — deliberately OUTSIDE the `actionCtx` gate above. The action
            bar needs a resolved live session to act ON; launching a fleet does
            not, and the moment a human most wants a fleet is often exactly when
            this session is dead, still starting, or failed to resolve — the
            states where `actionCtx` is null and the bar is absent.

            D-007 removed the one remaining exception: maximize used to hide it
            too, and the owner asked for it back in both modes. "ALWAYS visible"
            is now literally true, which is what WI-6505 wanted in the first
            place. (Deck item 5 proposes moving this row to the Sessions board
            entirely; that is P-007 and is owner-gated — see D-003.) */}
        {/* A native <details> rather than LazyDetails: the open state is
            nuqs-controlled (URL), which LazyDetails cannot take. The A6 intent
            — do not mount the heavy child while collapsed — is met by gating
            FleetLaunchRow on the same URL state below.
            // perf:allow A6 nuqs-controlled disclosure; child mounts only while open */}
        <details className="session-chat__fleet-setup" open={fleetLaunchOpen}>
          <summary onClick={(event) => {
            event.preventDefault();
            void setFleetLaunchOpen(!fleetLaunchOpen);
          }}>Launch a fleet</summary>
          {fleetLaunchOpen ? <FleetLaunchRow /> : null}
        </details>
      </div>
        {/* The RIGHT panel. A SIBLING of the conversation region — which since
            D-007 means it is INSIDE the fullscreen target (the popup container
            above), so it shows in both maximize modes. `dossierOpen` is the
            user's own choice and the only thing that hides it. */}
        {open && (isNarrow || !dossierOpen) ? (
          <div className="pc-zone pc-zone--activity pc-panel-dock" data-testid="session-chat-activity-dock">
            {!dossierOpen ? panelToggle('activity') : null}
          </div>
        ) : null}
        {open && dossierOpen ? (
          <div
            className="pc-zone pc-zone--activity pc-panel-surface"
            data-testid="session-chat-dossier-rail"
            style={isNarrow
              ? { ...DOSSIER_RAIL_OVERLAY_STYLE, ...(fleetPeers || fleetUnknownSession ? { right: 36, width: 'min(320px, calc(100% - 36px))' } : {}) }
              : DOSSIER_RAIL_SIDE_STYLE}
          >
            <AgentDossier
              ownerId={sessionOwnerId ?? ''}
              entry={dossierEntry}
              /* Only here: in the popup this rail is one of six named zones, so
                 it wears its name. In the /adv two-pane it is the detail pane of
                 a board that already says what it is. */
              zoneTitle
              // WI-6367: same never-started-vs-ended distinction as the banner
              // above — without it the rail says "no longer in the live roster"
              // about a session that has not started yet.
              startingUp={startingUp}
              // WI-6821: and the rail must not keep saying "starting up" about a
              // launch the banner beside it already reports as dead.
              launchFailed={launchFailed}
              // Same distinct state as the banner: keep the adjacent activity
              // rail from promising that a quota-blocked client is still booting.
              launchBlocked={launchBlocked}
              sessionEnded={sessionEnded}
              sessionEndedAt={endedEntry?.endedAt ?? null}
              unknownSession={unknownSession}
              onClose={() => void setDossierOpen(false)}
              headerControl={panelToggle('activity')}
            />
          </div>
        ) : null}
        {/* ── FLEET (chat-popup-fleet-peers-rail-2026-08-09) — the FOURTH zone,
            and the last child so the DOM order matches the reading order the
            layout promises: told → conversation → doing → who with.

            A SIBLING of the conversation region like both other rails, which is
            the layout contract P-015's guard asserts — and since D-007 that is
            what INCLUDES it in both maximize modes for free, with no hide-list
            to keep. Do NOT move it inside the conversation element. ── */}
        {open && (fleetPeers || fleetUnknownSession) && (isPeersNarrow || !peersVisible) ? (
          <div className="pc-zone pc-zone--peers pc-panel-dock" data-testid="session-chat-fleet-dock">
            {!peersVisible ? panelToggle('fleet') : null}
          </div>
        ) : null}
        {peersVisible ? (
          <div
            className="pc-zone pc-zone--peers pc-panel-surface"
            data-testid="session-chat-peers-rail"
            style={isPeersNarrow ? PEERS_RAIL_OVERLAY_STYLE : PEERS_RAIL_SIDE_STYLE}
          >
            {fleetPeers ? (
              <FleetPeersRail
                model={fleetPeers}
                alerts={leaderBriefAlerts}
                onSelectPeer={onSelectPeer}
                onClose={() => void setFleetOpen(false)}
                headerControl={panelToggle('fleet')}
              />
            ) : (
              /* EI-19968489971947616: the id in view matches nothing in the
                 roster (e.g. a truncated `hudsession=`) — say so explicitly
                 rather than rendering an empty column with no explanation. */
              <div className="pc-peers pc-peers--unknown" data-testid="fleet-peers-unknown-session">
                <header className="pc-zone-title">
                  {panelToggle('fleet')}
                </header>
                <div className="pc-peers__empty" role="status">
                  No agent with this id was found in the current roster or session history, so
                  fleet peers can’t be shown.
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
