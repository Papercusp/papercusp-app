'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { Popover } from '@/app/harness/Popover';
/**
 * OperatorChatSidebar — fixed left, full-height, and collapsible.
 *
 * Hosts the OperatorChat. Width is drag-resizable from the right
 * edge while expanded; the expanded width persists in localStorage
 * so it survives reloads. The open/closed state is user-meaningful,
 * so it lives in the URL via nuqs (`?chat=`).
 *
 * Sets `--op-chat-w` on :root so the rest of the app can use it
 * for left-padding on the body. Pages with centered content
 * absorb the loss into existing margin; edge-to-edge pages may
 * need per-page padding tweaks (caught visually post-mount).
 *
 * In this commit the chat content is a placeholder driver — turns
 * are local state only and onSend just echoes locally. The real
 * conversation engine wires in via the OperatorConversation provider
 * commit; this file's contract with it is `useOperatorConversation()`.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { reconcileProfilePref, writeProfileField } from '@papercusp/operator-core/lib/profile-pref';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Inbox as InboxIcon,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useRouter } from '@/lib/router-compat/navigation';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { OperatorChat } from './OperatorChat';
import {
  resolveDrillInTarget,
  resolveInboxDrillIn,
  reportNeedsLiveItems,
} from './chat/curator-card-drill-in';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  encodeScopedRef,
} from './chat/chat-ref-popup-params';
import { PotHealthPane } from './PotHealthPane';
import {
  useAttentionCountsDegraded,
  useInboxPendingCount,
  usePlansNeedingYouCount,
} from './inbox/use-inbox-pending';
import { useAttentionRefs } from '@/app/admin/plans/plans-api';
import { BUILT_IN_CHAT_VIEWS, dedupeChatFaces, type OpChatFace } from './op-chat-faces';

// The Plans view (owner-plans-single-pane-2026-07-17) pulls PlanDetail + the
// plan popup + sessions tab — lazy for the boot-lean reason (the boot-critical
// chat chunk stays lean; it loads on first toggle).
const PlansPane = lazy(() => import('./plans/PlansPane'));
// D-009/P-012: the Resolution Inbox is a built-in chat face again. Keep its
// full attention/detail graph out of the boot-critical chat chunk until picked.
const InboxPane = lazy(() => import('./inbox/InboxPane'));
import { LocalCardHost } from './chat/LocalCardHost';
import { useOperatorConversation } from './OperatorConversationProvider';
import { useShortcutAction } from '@/lib/hotkeys';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { OperatorLogoMark } from './OperatorLogoMark';
import { OperatorActiveToggle } from './OperatorActiveToggle';
import { VoiceButton } from './voice/VoiceButton';
import { AudienceModeSelector } from './AudienceModeSelector';
import { isVoiceOutputMuted, setVoiceOutputMuted } from './voice/voice-mode';
import {
  OPERATOR_CHAT_COLLAPSED_WIDTH,
  OPERATOR_CHAT_DEFAULT_WIDTH,
  OPERATOR_CHAT_OPEN_QUERY_KEY,
  clampOperatorChatWidth,
  isCompactDockViewport,
  operatorChatWidthFromPointer,
} from './operator-chat-layout';

const STORAGE_KEY = 'papercusp.operatorChat.width';

/** EI-13551: below this sidebar width, AudienceModeSelector (the biggest
 *  single piece of the rigid voice-controls cluster — 67px of icon buttons,
 *  MEASURED in the Tauri shell) collapses from two inline icon buttons into
 *  one small overflow trigger, so the width it frees goes back to the
 *  owner-asked-for [🥤 Papercup] / [🎯 Pot Health] identity labels (WI-4793 /
 *  WI-4789), which were squeezing to literal 0px at the 360px DEFAULT width.
 *  MEASURED against the 360/460/560/700/900 checkpoints already used by the
 *  WI-5162 face-label container query above; unlike that query this is a JS
 *  threshold (not a CSS container query) because collapsing into a Popover
 *  is a real DOM/state change, not a pure style toggle. */
const AUDIENCE_MODE_OVERFLOW_WIDTH = 620;

/** The header toggles' view values: the chat body ⇄ the full-height Pot
 *  Health view (WI-4778) ⇄ the simplified Plans tracker. URL state via nuqs so
 *  agents (ui:get_state / ui:dispatch) can see + drive it.
 *
 *  The human Inbox face was restored as the owner-selected Resolution Inbox
 *  (owner-inbox-single-pane D-009/P-012). HUD remains a fleet/session view;
 *  the Inbox is the canonical heterogeneous blocker resolver.
 *
 *  EXTRA faces (WI-5162: [👥 Fleet] [🎧 Peers], mounted right of 🎯) widen this
 *  enum at runtime — their panes live in operator-vite and arrive as `faces`
 *  descriptors, see op-chat-faces.ts. */
const CHAT_VIEW_VALUES = BUILT_IN_CHAT_VIEWS;

/**
 * Speak-responses (TTS output) mute toggle — MOVED here from the left rail's
 * PapercupVoiceBar (WI-4740: the owner asked for the duplicated voice controls
 * to live on the chat bar ONLY; this was the one control the chat bar lacked).
 * Muting silences spoken output but keeps voice mode + PTT live. Same
 * persisted flag + cross-tab broadcast event as the original. NOTE: only
 * replies to VOICE-input turns are ever spoken (OperatorConversationProvider
 * gates speak() on `spokenReply`) — TYPED chat is always silent, so the label
 * is scoped to "voice replies" to match the behavior rather than promising all
 * responses are read aloud (EI-12152, owner call 2026-07-14).
 */
function TtsMuteButton() {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(isVoiceOutputMuted());
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ muted?: boolean }>).detail;
      setMuted(typeof d?.muted === 'boolean' ? d.muted : isVoiceOutputMuted());
    };
    window.addEventListener('papercusp:voiceOutputMutedChanged', onChange);
    return () => window.removeEventListener('papercusp:voiceOutputMutedChanged', onChange);
  }, []);
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setVoiceOutputMuted(next);
  };
  return (
    <Tooltip label={muted ? 'Voice replies muted — click to hear Papercup answer your spoken turns aloud' : 'Papercup speaks its replies when you talk by voice — click to mute (typed chat stays silent)'}>
      <button
        type="button"
        className={`op-chat-tts${muted ? ' is-muted' : ''}`}
        onClick={toggle}
        aria-pressed={!muted}
        aria-label={muted ? 'Unmute spoken voice replies' : 'Mute spoken voice replies'}
      >
        {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

/** Read the stored width from localStorage, clamped to the viewport ceiling. */
function readStoredWidth(): number {
  if (typeof window === 'undefined') return OPERATOR_CHAT_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(wsLocalKey(STORAGE_KEY));
    if (!raw) return OPERATOR_CHAT_DEFAULT_WIDTH;
    const n = Number(raw);
    return clampOperatorChatWidth(n, window.innerWidth);
  } catch {
    return OPERATOR_CHAT_DEFAULT_WIDTH;
  }
}

/**
 * @param faces EXTRA header faces mounted to the RIGHT of 🎯 Pot Health
 *   (WI-5162, owner ask 2026-07-17: "put them to the right of the kettle
 *   button"). The Vite SPA root (apps/operator-vite/src/routes/__root.tsx)
 *   injects the Fleet + Peers panes here — those components live under
 *   operator-vite/src and cannot be imported up-layer from this tree, so the
 *   route composes them and passes them down (op-chat-faces.ts; same shape as
 *   quick-panel's headerSlot, D-001). Omitted ⇒ the three built-in faces only.
 */
/**
 * @param docked Render as the ONLY content of a pane-sized document instead of
 *   the app's middle fixed dock (the cloud portal frames `/portal-panes/chat`
 *   as one of its own sidebars — owner ask 2026-09-01). Docked = always open,
 *   fills its frame, no collapse/expand controls, no drag handle, and no
 *   `body.has-op-chat` layout reservation (nothing shares that document).
 */
export function OperatorChatSidebar({ faces = [], docked = false }: { faces?: readonly OpChatFace[]; docked?: boolean } = {}) {
  const [chatOpen, setChatOpen] = useQueryState(
    OPERATOR_CHAT_OPEN_QUERY_KEY,
    parseAsBoolean.withDefault(true),
  );
  const [width, setWidth] = useState<number>(OPERATOR_CHAT_DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);
  const [compactAutoCollapsed, setCompactAutoCollapsed] = useState(false);
  const compactViewportRef = useRef(false);

  // Hydrate width from localStorage post-mount to keep SSR markup stable.
  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Reconcile from PG (source of truth) on mount: if the stored profile width
  // differs from the local cache (set on another device, or the cache was
  // lost), adopt it. localStorage stays the instant first-paint value above.
  useEffect(() => {
    void reconcileProfilePref<number>({
      field: 'op_chat_width',
      parse: (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null),
      current: readStoredWidth,
      adopt: (n) => {
        const clamped = clampOperatorChatWidth(n, window.innerWidth);
        try {
          window.localStorage.setItem(wsLocalKey(STORAGE_KEY), String(clamped));
        } catch { /* sandbox / quota */ }
        setWidth(clamped);
      },
    });
  }, []);

  // Compact view is presentation-only: retain ?chat=true so leaving compact
  // restores the requested layout. Crossing INTO compact collapses once; an
  // explicit expand clears the local auto-collapse for the rest of that compact
  // interval instead of being undone by the next resize event.
  // A docked pane is never collapsed — the portal that frames it owns
  // open/closed, so a collapsed dock inside its own frame would be a strip
  // the viewer could not widen.
  const presentedOpen = docked || (chatOpen && !compactAutoCollapsed);

  // Mirror the active offset width to a CSS var so app content shifts. Never
  // in a docked pane: nothing shares that document, and the class would
  // pad the pane away from its own frame edge.
  useEffect(() => {
    if (!hydrated || docked) return;
    const offsetWidth = presentedOpen ? width : OPERATOR_CHAT_COLLAPSED_WIDTH;
    document.documentElement.style.setProperty('--op-chat-w', `${offsetWidth}px`);
    document.body.classList.add('has-op-chat');
    document.body.classList.toggle('op-chat-collapsed', !presentedOpen);
    try {
      window.localStorage.setItem(wsLocalKey(STORAGE_KEY), String(width));
    } catch { /* sandbox / quota */ }
    return () => { /* leave the classes in place across re-renders */ };
  }, [presentedOpen, hydrated, width, docked]);

  useEffect(() => {
    if (!hydrated) return;
    const onResize = () => {
      const viewportWidth = window.innerWidth;
      setWidth((current) => clampOperatorChatWidth(current, viewportWidth));
      const compact = isCompactDockViewport(viewportWidth);
      if (compact !== compactViewportRef.current) {
        compactViewportRef.current = compact;
        setCompactAutoCollapsed(compact);
      }
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hydrated]);

  // Strip the body class on unmount (chromeless routes don't render
  // this component — the cleanup is for completeness/HMR safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-op-chat');
        document.body.classList.remove('op-chat-collapsed');
        document.documentElement.style.removeProperty('--op-chat-w');
      } catch { /* DOM may be torn down already */ }
    };
  }, []);

  // Drag-to-resize handle. The steering/settings rail is the FAR-LEFT dock;
  // this chat pane is the MIDDLE dock, so clientX includes --left-sidebar-w.
  // Subtract that offset before clamping the chat pane's own width.
  const draggingRef = useRef(false);
  const leftSidebarOffset = () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--left-sidebar-w');
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = operatorChatWidthFromPointer(e.clientX, leftSidebarOffset(), window.innerWidth);
    setWidth(next);
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // Persist the final width to PG (source of truth) on drag-commit — once
    // per resize, not per pointermove. The cache is kept in sync by the width
    // effect; this just makes it durable across reload/restart.
    try {
      const final = operatorChatWidthFromPointer(e.clientX, leftSidebarOffset(), window.innerWidth);
      writeProfileField('op_chat_width', final);
    } catch { /* ignore */ }
  }, []);

  const collapseChat = useCallback(() => {
    void setChatOpen(false);
  }, [setChatOpen]);

  const expandChat = useCallback(() => {
    setCompactAutoCollapsed(false);
    void setChatOpen(true);
  }, [setChatOpen]);

  // Conversation state from the OperatorConversationProvider mounted
  // in the root layout. The provider owns the state machine + silence
  // timers + tag dispatch; this component is a presentational thin
  // wrapper around <OperatorChat> with the provider's value.
  const conv = useOperatorConversation();
  const workspaceId = useWorkspaceId();

  // Cmd/Ctrl+Shift+I → Generate ideas (same as clicking the lightbulb
  // button in the composer). Plan §C.9 promised this keyboard binding.
  useShortcutAction('operator.generateIdeas', () => {
    conv.generateIdeas();
  });

  // Pre-hydration: render the sidebar at its expanded default width so
  // the lazy mount lines up with the bootstrap script in layout.tsx.
  const renderedWidth: number | string = docked
    ? '100%'
    : hydrated
      ? (presentedOpen ? width : OPERATOR_CHAT_COLLAPSED_WIDTH)
      : OPERATOR_CHAT_DEFAULT_WIDTH;

  const sidebarStyle = useMemo<React.CSSProperties>(() => ({
    width: renderedWidth,
  }), [renderedWidth]);

  let statusText: string;
  if (conv.busy) {
    statusText = 'thinking';
  } else if (conv.mode === 'passive') {
    statusText = 'quiet until asked';
  } else {
    statusText = 'ready';
  }

  // WI-4778 (reverts WI-4739): the header is ALWAYS the Papercup identity —
  // Papercup is the one persona you talk to. The 🎯 toggle below swaps the BODY
  // between the chat and the full-height Pot Health view — now the pot's goals,
  // its su agents, and its throughput (retire-mug-kettle-su-only-2026-08-09
  // P-018..P-021), not the retired Mug/Kettle briefs — inside this same pane.
  // WI-5162: extra faces widen the enum, so ?opcv=fleet survives a reload
  // instead of being rejected back to 'chat'. Memoised on the ids alone — a new
  // parser identity each render would make nuqs re-parse on every tick.
  const extraFaces = useMemo(() => dedupeChatFaces(faces), [faces]);
  const extraFaceIds = extraFaces.map((f) => f.id).join(',');
  const viewParser = useMemo(
    () => parseAsStringEnum([...CHAT_VIEW_VALUES, ...extraFaceIds.split(',').filter(Boolean)]).withDefault('chat'),
    [extraFaceIds],
  );
  const [view, setView] = useQueryState('opcv', viewParser);
  // P-013: a report row that already corresponds to a live attention item
  // opens the canonical Resolution Inbox face and selects that exact card.
  // Keep these params beside `opcv`: the click owns one atomic destination,
  // even though InboxPane also reads the same URL state once mounted.
  const [, setInboxFilter] = useQueryState('opci', parseAsString);
  const [, setInboxSelection] = useQueryState('opcis', parseAsString);
  const potOpen = view === 'pot';
  const plansOpen = view === 'plans';
  const inboxOpen = view === 'inbox';
  // The live attention items, so a drill-in can RESOLVE its ref against a real
  // attention item and read its owning agent (WI-5342). Held in a ref so
  // handleCardDrillIn stays identity-stable (it's memo-keyed into OperatorChat's
  // renderers) while still reading the freshest items at click time.
  //
  // ⚠ COST — this line used to read "same shared plans.attention cache the badge
  // hooks read — no extra query", and that stopped being true when WI-5955 moved
  // both badges onto the narrow `plans.attentionCounts`. It then became the ONLY
  // app-wide consumer of the FULL feed, and ChromeShell mounts this sidebar on
  // every non-chromeless route — so it fetched on EVERY screen. Measured
  // 2026-08-03 (no-http-anywhere-2026-07-28 D-028/D-030/D-031): 1,461 KB on the
  // git tab against :3055 (891 KB against :3270 — different backends, never
  // compare the two), on a page that renders no attention feed at all.
  //
  // TWO CUTS, composed (both measured — D-031):
  //
  // 1. NARROWER ROW. This reads `plans.attentionRefs`, not the fat feed. The
  //    resolver below reads exactly four fields per item (id / itemRef /
  //    planSlug / ownerAgentId — `RefDestinationItem`), so the projection is
  //    lossless FOR THIS USE. It is a separate query NAME, not narrowed args on
  //    the fat one: arg narrowing is pushed down into ~10 server-side sources
  //    and silently drops rows (D-029; ~677 items in slim-plans-attention
  //    D-001). Every item is still here — only the row got smaller.
  //
  // 2. FETCH ONLY WHEN A REF NEEDS IT. `resolveRefDestination` answers `wi:…` /
  //    `plan:…` / bare work-item refs at steps 1-2 WITHOUT reading items at all;
  //    only `escalation:` / `decision:` / bare non-work-item refs reach the
  //    live-item match. `refNeedsLiveItems` RUNS that short-circuit rather than
  //    restating it, so it cannot drift as the ref vocabulary grows.
  //    Measured behaviour-preservation: with the feed off, exactly the 7 of 13
  //    rendered refs that resolve without it still render their Open buttons.
  //
  // ⚠ Gate 2 alone saves nothing in practice — real curator cards carry
  // `escalation:` refs (6 of 13 measured), so it evaluates TRUE on a live chat.
  // That is why the projection (cut 1) exists; do not remove it as redundant.
  //
  // ⛔ Do NOT "simplify" the gate to `chatOpen` — it defaults to TRUE and the
  // collapsed shell still MOUNTS OperatorChat (aria-hidden), so it saves nothing.
  //
  // ⚠ Anyone editing this: re-measure before claiming a saving, and update THIS
  // comment with it. A stale cost note is how the 891 KB stayed invisible.
  const needsAttentionFeed = useMemo(
    () => conv.messages.some((m) => reportNeedsLiveItems(m.report)),
    [conv.messages],
  );
  const { items: inboxItems } = useAttentionRefs(needsAttentionFeed);
  const inboxItemsRef = useRef(inboxItems);
  inboxItemsRef.current = inboxItems;
  // hud-consolidation-2026-07-26 P-004 pointed a curator card's drill-in at the
  // agent's HUD conversation, replacing the retired Inbox pane. That covered
  // exactly ONE of the things a report row can name, and every other ref fell
  // through to a bare `/adv?tab=hud` with nothing selected — which, fired from
  // this sidebar (already on /adv), is a visible no-op. That is the owner report
  // of 2026-07-27 ("clicking open ... is supposed to open something relevant but
  // it isn't").
  //
  // hud-open-destinations-and-true-counts-2026-07-27 P-003: route through the
  // shared `resolveRefDestination` (P-001) instead, and open the thing the ref
  // actually names. Work items and plans open the SAME popups the chat's own
  // ref pills and the Plans pane already use — by writing the popups' nuqs
  // params (`wpop`/`wppop`, owned by OperatorChat), never a second renderer.
  // Only a genuine agent ref still navigates to the HUD conversation.
  const router = useRouter();
  const harnessSlug = useResolvedHarnessSlug();
  // The SAME two params OperatorChat declares for its own ref-pill popups —
  // driving them from here is the whole reason this state is in the URL rather
  // than in component state (repo convention: user-meaningful state is nuqs).
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  const [, setOpenChatPlan] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);
  // A drill-in NAVIGATION must carry the workspace + harness context params
  // forward. Pushing a bare `/adv?tab=hud[&hudsession=…]` drops `?ws` and
  // `?slug` (confirmed live 2026-07-28: clicking an escalation card left the
  // URL at `/adv?tab=hud&hudsession=…`, with the workspace no longer named),
  // which is a defect twice over:
  //   1. the user lands on a URL that no longer identifies their workspace, so
  //      a reload/share resolves somewhere else;
  //   2. `harnessSlug` resolves FROM `?slug` (useResolvedHarnessSlug, with only
  //      a best-effort localStorage fallback) — so once it is dropped, the very
  //      next work-item drill-in fails the `harnessSlug` gate below and falls
  //      through to the bare-HUD fallback. That is exactly the visible no-op
  //      this plan exists to fix, reachable again in two clicks.
  // Only these two CONTEXT params are carried — not the whole param bag: this
  // sidebar also mounts outside /adv (quick-panel), and dragging view state
  // like `wpop` across the navigation would open a stale popup on arrival.
  // ⚠ CARRY the params that are LIVE IN THE URL — do not re-derive them from the
  // hooks. `useWorkspaceId()` snapshots `window.__PAPERCUSP_WS__ ?? ?ws ?? 'default'`
  // ONCE at mount (useState initialiser, never re-read — a workspace switch is a
  // full app restart), so on any surface where it resolved before `?ws` was present
  // it returns the literal 'default'. Writing that back would OVERWRITE a real
  // `?ws=papercusp-workspace` with 'default' — silently rewriting workspace identity,
  // which is strictly worse than the dropped-param bug this helper exists to fix.
  // Caught live 2026-07-28: the first cut of this helper did exactly that.
  // So: live URL value first, hook only as a fallback when the param is absent
  // (the /quick-panel mount, where there may be no `?ws`/`?slug` to carry).
  const buildAdvHudHref = useCallback(
    (ownerAgentId?: string) => {
      const current = new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search,
      );
      const params = new URLSearchParams();
      params.set('tab', 'hud');
      const ws = current.get('ws') ?? workspaceId;
      const slug = current.get('slug') ?? harnessSlug;
      if (ws) params.set('ws', ws);
      if (slug) params.set('slug', slug);
      if (ownerAgentId) params.set('hudsession', ownerAgentId);
      return `/adv?${params.toString()}`;
    },
    [workspaceId, harnessSlug],
  );
  // Does this ref open ANYTHING? Same resolver, same items, as the click below —
  // deliberately one source of truth, so a rendered button and its click can
  // never disagree about whether there is a destination.
  //
  // [owner 2026-07-28] "if there is nothing to open there should be no open
  // button": a curator ref only resolves against the LIVE attention items, and an
  // escalation whose message has aged out of that snapshot resolves to `none`.
  // The old fallback then pushed the HUD board the chat is ALREADY on — a button
  // that visibly does nothing. Measured live on the owner's fleet-status cards:
  // 4 of the first 7 were dead this way.
  //
  // Depends on `inboxItems` (not the ref) ON PURPOSE: this feeds RENDER, so it
  // must re-evaluate when the items arrive or a matching item ages out, or a
  // button's visibility would be frozen at first paint. `handleCardDrillIn`
  // keeps reading the ref instead, so the CLICK path stays identity-stable and
  // the WI-6502 typing-lag memo is unaffected by keystrokes.
  // ⚠ Both the gate and the click go through `resolveDrillInTarget`, NOT
  // `resolveRefDestination` — the latter is not the openable-verdict, and using
  // it here is what let a rendered button disagree with its own click (a
  // work-item destination also needs a harness). See that function's docblock
  // for the live measurement.
  const canCardDrillIn = useCallback(
    (ref: string) => resolveDrillInTarget(ref, inboxItems, harnessSlug) !== null,
    [inboxItems, harnessSlug],
  );
  const handleCardDrillIn = useCallback(
    (ref: string) => {
      const liveItems = inboxItemsRef.current;
      const inboxTarget = resolveInboxDrillIn(ref, liveItems);
      // `resolveInboxDrillIn` intentionally synthesizes an escalation id even
      // after that row ages out. Only prefer the Inbox when the selected id is
      // present NOW; otherwise preserve the specific popup/HUD fallback below.
      if (
        inboxTarget.selId &&
        liveItems.some((item) => item.id === inboxTarget.selId)
      ) {
        void setView('inbox');
        void setInboxFilter(inboxTarget.filter ?? 'all');
        void setInboxSelection(inboxTarget.selId);
        return;
      }

      const target = resolveDrillInTarget(ref, liveItems, harnessSlug);
      switch (target?.kind) {
        case 'work-item':
          // `wpop` encodes "<harness>::<id>" — workItems.detail is harness-scoped.
          // The harness comes from the REF when it names one, so a
          // harness-qualified curator ref opens even where `?slug` is absent.
          void setOpenWorkItem(encodeScopedRef(target.harness, target.id));
          return;
        case 'plan':
          // A plan drill-in target carries no harness of its own (DrillInItem
          // does not project one), so this scopes to the resolved surface
          // harness — null on a cross-harness mount, which the root renderer
          // then falls back to resolving itself. Same value as before; routed
          // through the shared encoder so writer and reader cannot drift.
          void setOpenChatPlan(encodeScopedRef(harnessSlug, target.slug));
          return;
        case 'session':
          router.push(buildAdvHudHref(target.ownerAgentId));
          return;
      }
      // Unreachable from a rendered button now that the gate above agrees with
      // this click (a `health:<panelId>` ref resolves to null and renders no
      // button). Kept only for a click that races the items updating out from
      // under it: the HUD board's unattributed lane (hud-consolidation P-002)
      // renders the ask itself, so it is the least-wrong destination.
      router.push(buildAdvHudHref());
    },
    [
      router,
      harnessSlug,
      setOpenWorkItem,
      setOpenChatPlan,
      setView,
      setInboxFilter,
      setInboxSelection,
      buildAdvHudHref,
    ],
  );
  // The lit extra face, if any — drives both the pill state and the body swap.
  const activeFace = extraFaces.find((f) => f.id === view) ?? null;
  // Live decision-tier count (shared plans.attention sync feed) — badge on
  // the Inbox toggle + the collapsed rail, so "needs you" is visible either way.
  const inboxPending = useInboxPendingCount();
  const inboxBadge = inboxPending > 99 ? '99+' : String(inboxPending);
  const plansNeedingYou = usePlansNeedingYouCount();
  const plansBadge = plansNeedingYou > 99 ? '99+' : String(plansNeedingYou);
  // WI-39779: the server's attention read has an 8s deadline whose graceful
  // fallback is an EMPTY feed, which derives to zero. Both badges render a zero
  // by rendering NOTHING — so a timed-out read looked exactly like "nothing
  // needs you", the one reading we must never assert without knowing.
  //
  // When the read degraded we show the badge anyway, with an indeterminate mark
  // instead of a count. Deliberately not a silent hide and not a spinner: the
  // user's question is "does anything need me", and the honest answer here is
  // "unknown", which a spinner (implying "any moment now") also misstates.
  const attentionUnknown = useAttentionCountsDegraded();
  const showInboxBadge = inboxPending > 0 || attentionUnknown;
  const showPlansBadge = plansNeedingYou > 0 || attentionUnknown;
  const INDETERMINATE = '–';
  const UNKNOWN_LABEL = 'Could not load what needs you — this count is unavailable, not zero';

  // EI-13551: collapse AudienceModeSelector into a Popover below
  // AUDIENCE_MODE_OVERFLOW_WIDTH — see the constant's doc comment. Driven off
  // the already-tracked `renderedWidth` (the same value the sidebar's own
  // inline style + the CSS container query respond to), not a separate
  // ResizeObserver.
  // A docked pane renders at '100%' of a portal-owned frame, so there is no
  // numeric width to compare against; the CSS container query alone drives
  // the audience-mode collapse there.
  const audienceModeOverflow = typeof renderedWidth === 'number' && renderedWidth < AUDIENCE_MODE_OVERFLOW_WIDTH;
  const [audienceMenuOpen, setAudienceMenuOpen] = useState(false);

  return (
    <aside
      className={`op-chat-sidebar${docked ? ' op-chat-sidebar--docked' : ''}`}
      style={sidebarStyle}
      aria-label="Papercup chat"
      data-collapsed={presentedOpen ? 'false' : 'true'}
      data-docked={docked ? 'true' : undefined}
    >
      <style>{OP_CHAT_SIDEBAR_CSS}</style>
      <Tooltip label="Expand Papercup chat"><button
        type="button"
        className="op-chat-expand-rail"
        onClick={expandChat}
        aria-label="Expand Papercup chat"

        aria-hidden={presentedOpen}
      >
        <span className="op-chat-expand-orb" aria-hidden="true">
          <OperatorLogoMark className="op-chat-expand-logo" />
        </span>
        {showInboxBadge ? (
          <span
            className="op-chat-rail-badge"
            data-testid="op-chat-rail-badge"
            data-degraded={attentionUnknown ? 'true' : undefined}
            title={attentionUnknown ? UNKNOWN_LABEL : undefined}
            aria-label={attentionUnknown ? UNKNOWN_LABEL : `${inboxPending} inbox items need you`}
          >
            {attentionUnknown ? INDETERMINATE : inboxBadge}
          </span>
        ) : null}
        <span className="op-chat-expand-label">Chat</span>
        <ChevronRight className="op-chat-expand-chevron" strokeWidth={1.9} aria-hidden="true" />
      </button></Tooltip>
      <div className="op-chat-expanded-shell" aria-hidden={!presentedOpen}>
        {/* WI-4738: ONE header line (owner ask 2026-07-13) — orb, name, then the
            compact controls and the collapse chevron on the same row. The old
            two-row layout (title row over a full-width controls row, with the
            voice button stretched to fill it) read as a "gigantic" mic. */}
        <div className="op-chat-header">
          <div className="op-chat-header-main">
            {/* WI-4793 (owner ask 2026-07-14 "make the Papercup button look
                like the Pot Health button"): the Papercup identity is now a
                FLAT peer toggle sharing the 🎯 button's pill chrome — the two
                faces read as a matched pair [🥤 Papercup] [🎯 Pot Health]. It
                is lit (is-on) while the chat face shows and returns to it from
                the pot view (the symmetric dual of the 🎯 toggle). The old
                raised, glowing 38px orb is gone. */}
            {/* owner-plans-single-pane-2026-07-17 + owner ask 2026-07-17: the
                Plans face sits LEFT of Papercup — [📋 Plans] [🥤 Papercup]
                [🎯 Pot Health]. Simplified plan tracking; badge = plans that
                need YOU. The restored Inbox face sits between Plans and
                Papercup as the canonical blocker destination (D-009). */}
            <Tooltip label={plansOpen ? 'Back to chat' : 'Plans — track active plans, open one in a popup, view its agent sessions'}>
              <button
                type="button"
                className={`op-chat-inbox-toggle op-chat-plans-toggle${plansOpen ? ' is-on' : ''}`}
                onClick={() => void setView(plansOpen ? 'chat' : 'plans')}
                aria-pressed={plansOpen}
                aria-label={plansOpen ? 'Back to chat' : 'Show plans'}
                data-testid="op-chat-plans-toggle"
              >
                <ClipboardList className="op-chat-inbox-icon" aria-hidden="true" />
                <span className="op-chat-inbox-toggle-label">Plans</span>
                {showPlansBadge ? (
                  <span
                    className="op-chat-inbox-badge"
                    data-testid="op-chat-plans-badge"
                    data-degraded={attentionUnknown ? 'true' : undefined}
                    title={attentionUnknown ? UNKNOWN_LABEL : undefined}
                    aria-label={attentionUnknown ? UNKNOWN_LABEL : undefined}
                  >
                    {attentionUnknown ? INDETERMINATE : plansBadge}
                  </span>
                ) : null}
              </button>
            </Tooltip>
            <Tooltip label={inboxOpen ? 'Back to chat' : 'Resolution Inbox — resolve everything blocked on you'}>
              <button
                type="button"
                className={`op-chat-inbox-toggle${inboxOpen ? ' is-on' : ''}`}
                onClick={() => void setView(inboxOpen ? 'chat' : 'inbox')}
                aria-pressed={inboxOpen}
                aria-label={inboxOpen ? 'Back to chat' : 'Show Resolution Inbox'}
                data-testid="op-chat-inbox-toggle"
              >
                <InboxIcon className="op-chat-inbox-icon" aria-hidden="true" />
                <span className="op-chat-inbox-toggle-label">Inbox</span>
                {showInboxBadge ? (
                  <span
                    className="op-chat-inbox-badge"
                    data-testid="op-chat-inbox-badge"
                    data-degraded={attentionUnknown ? 'true' : undefined}
                    title={attentionUnknown ? UNKNOWN_LABEL : undefined}
                    aria-label={attentionUnknown ? UNKNOWN_LABEL : `${inboxPending} inbox items need you`}
                  >
                    {attentionUnknown ? INDETERMINATE : inboxBadge}
                  </span>
                ) : null}
              </button>
            </Tooltip>
            <Tooltip label={view === 'chat' ? 'Papercup chat' : 'Back to Papercup chat'}>
              <button
                type="button"
                className={`op-chat-papercup-toggle${view === 'chat' ? ' is-on' : ''}`}
                onClick={() => void setView('chat')}
                aria-pressed={view === 'chat'}
                aria-label="Papercup chat"
              >
                <span className="op-chat-papercup-mark" aria-hidden="true">
                  <OperatorLogoMark className="op-chat-papercup-logo" />
                </span>
              </button>
            </Tooltip>
            {/* WI-4778/WI-4789: the Pot Health toggle — chat ⇄ the full-height
                Pot Health view, same pane. Sits RIGHT BESIDE the Papercup
                identity (owner ask 2026-07-14) and carries its own "Pot Health"
                wordmark-style label (owner ask 2026-07-14) so the pane's two
                "faces" read as peers: [🥤 Papercup] [🎯 Pot Health].

                GLYPH 🎯 → 🎯 (retire-mug-kettle-su-only-2026-08-09 P-022 / D-032
                §8). The teapot was the KETTLE's mark, not the pot's — it is the
                cast glyph for `kettle`/`overwatch` in `AgentsRunningPill`'s
                KIND_GLYPH map, which is why this control was called "the kettle
                button" throughout the codebase. Leaving a retired mind's mark on
                a live control kept advertising the tier to the owner. 🎯 is this
                product's own Goals mark, freed when the Goals rail tab was
                removed (owner directive 2026-08-09) — and the rebuilt pane now
                LEADS with goals, so the glyph says what the pane is for. The
                NAME "Pot Health" survives: pots are ungated and outlive the
                Mug/Kettle tier (D-003). */}
            <Tooltip label={potOpen ? 'Back to chat' : 'Pot health — goals, agents and throughput'}>
              <button
                type="button"
                className={`op-chat-pot-toggle${potOpen ? ' is-on' : ''}`}
                onClick={() => void setView(potOpen ? 'chat' : 'pot')}
                aria-pressed={potOpen}
                aria-label={potOpen ? 'Back to chat' : 'Show pot health'}
              >
                <span aria-hidden="true">🎯</span>
                <span className="op-chat-pot-toggle-label">Pot Health</span>
              </button>
            </Tooltip>
            {/* WI-5162 (owner ask 2026-07-17 "move the fleet and peers panes
                from the middle section to the leftmost section and put them to
                the right of the kettle button"): the Fleet + Peers faces, which
                used to be tabs in the MIDDLE rail (LeftSidebar), now sit here as
                peers of 🎯 — [📥 Inbox] [🥤 Papercup] [🎯 Pot Health] [👥 Fleet]
                [🎧 Peers]. They share the 🎯 pill chrome and the same body-swap
                contract; their panes arrive from operator-vite (op-chat-faces). */}
            {extraFaces.map((face) => {
              const isOn = view === face.id;
              return (
                <Tooltip key={face.id} label={isOn ? 'Back to chat' : face.tip}>
                  <button
                    type="button"
                    className={`op-chat-pot-toggle op-chat-face-toggle op-chat-face-toggle--${face.id}${isOn ? ' is-on' : ''}`}
                    onClick={() => void setView(isOn ? 'chat' : face.id)}
                    aria-pressed={isOn}
                    aria-label={isOn ? 'Back to chat' : `Show ${face.label}`}
                    data-testid={`op-chat-face-${face.id}`}
                  >
                    <span className="op-chat-face-icon" aria-hidden="true">{face.icon}</span>
                    <span className="op-chat-pot-toggle-label">{face.label}</span>
                  </button>
                </Tooltip>
              );
            })}
            <div className="op-chat-controls" role="group" aria-label={`Papercup voice controls — ${statusText}`}>
              {audienceModeOverflow ? (
                <Popover
                  open={audienceMenuOpen}
                  onOpenChange={setAudienceMenuOpen}
                  ariaLabel="Audience mode"
                  tooltipLabel="Audience mode — engineer or novice tone"
                  contentClassName="op-chat-audience-popover"
                  trigger={
                    <button
                      type="button"
                      className="op-chat-audience-overflow-trigger"
                      aria-label="Audience mode settings"
                      aria-expanded={audienceMenuOpen}
                    >
                      <SlidersHorizontal size={14} aria-hidden="true" />
                    </button>
                  }
                >
                  <AudienceModeSelector />
                </Popover>
              ) : (
                <AudienceModeSelector />
              )}
              <OperatorActiveToggle />
              <VoiceButton />
              <TtsMuteButton />
            </div>
            <Tooltip label="Collapse Papercup chat"><button
              type="button"
              className="op-chat-toggle"
              onClick={collapseChat}
              aria-label="Collapse Papercup chat"
            >
              <ChevronLeft strokeWidth={1.9} aria-hidden="true" />
            </button></Tooltip>
          </div>
        </div>
        {activeFace ? (
          /* WI-5162: a Fleet/Peers face is lit — its pane replaces the chat
             body, same as 🎯 does. The pane is rendered lazily by the
             provider (operator-vite), so nothing mounts until it is picked. */
          <Suspense fallback={<div className="op-chat-view-loading">Loading {activeFace.label.toLowerCase()}…</div>}>
            {activeFace.render()}
          </Suspense>
        ) : potOpen ? (
          /* WI-4778: 🎯 on — the full-height Pot Health view replaces the
             chat body (strip + messages + composer), same pane, one scroll. */
          <PotHealthPane />
        ) : plansOpen ? (
          /* owner-plans-single-pane-2026-07-17: 📋 on — the simplified Plans
             tracker replaces the chat body. Rows open the plan in a popup
             (PlanDetail read-first) with a per-plan Sessions tab. */
          <Suspense fallback={<div className="op-chat-view-loading">Loading plans…</div>}>
            <PlansPane />
          </Suspense>
        ) : inboxOpen ? (
          /* owner-inbox-single-pane D-009/P-012/P-018: the canonical
             Resolution Inbox is a built-in face in this same pane. The pane
             owns its list/detail URL state; Discuss stays inline in the
             expanded item and never switches or seeds the global transcript. */
          <Suspense fallback={<div className="op-chat-view-loading">Loading inbox…</div>}>
            <InboxPane />
          </Suspense>
        ) : (
          /* WI-4789 (owner ask 2026-07-14): the ambient Mug/Kettle status
             strip that used to sit here is GONE — the 🎯 Pot Health toggle
             beside the Papercup name is the one entry to that information. */
          <OperatorChat
            messages={conv.messages}
            busy={conv.busy}
            peerBusy={conv.peerBusy}
            passive={conv.mode === 'passive'}
            onSend={conv.sendUserMessage}
            onGenerateIdeas={conv.generateIdeas}
            banner={conv.bannerText ? <div className="op-chat-banner">{conv.bannerText}</div> : null}
            error={conv.error}
            onLoadEarlier={conv.loadEarlier}
            hasMoreEarlier={conv.hasMoreEarlier}
            loadingEarlier={conv.loadingEarlier}
            onAnswerChoice={conv.answerChoice}
            conversationId={conv.conversationId ?? undefined}
            workspaceId={workspaceId}
            onDrillIn={handleCardDrillIn}
            canDrillIn={canCardDrillIn}
            /* Without this, OperatorChat's own handleWorkRefActivate hits its
               `if (!harnessSlug) return` guard and EVERY WI-/EI-/F- ref pill in
               the chat is inert — the same dead-click the curator card's
               drill-in had (P-003). The sidebar never passed it. */
            harnessSlug={harnessSlug ?? undefined}
          />
        )}
        {/* M6: askUserLocal renderer host. Mounted once per sidebar so any
            client-side caller of askUserLocal has a slot to render into.
            Cards render here when triggered by render-time UI affordances
            (tab pickers, confirms) rather than server-side tool flows
            which go through PendingCardsBar instead. */}
        <LocalCardHost />
      </div>
      <div
        className="op-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Papercup chat"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      />
    </aside>
  );
}

const OP_CHAT_SIDEBAR_CSS = `
/* ── Shared face-pill chrome (Inbox + Plans):
   [📋 Plans] [📥 Inbox] [🥤 Papercup] [🎯 Pot Health].
   Pill chrome mirrors .op-chat-pot-toggle so they read as peers. */
.op-chat-header-main .op-chat-inbox-toggle {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 26px;
  padding: 0 8px 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 74%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-1), transparent 4%);
  color: var(--fg-dim);
  cursor: pointer;
}
.op-chat-header-main .op-chat-inbox-toggle.is-on {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 30%);
  background: color-mix(in srgb, var(--accent), transparent 82%);
}
.op-chat-header-main .op-chat-inbox-toggle:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%);
  background: color-mix(in srgb, var(--accent), transparent 88%);
}
.op-chat-header-main .op-chat-inbox-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong), transparent 18%);
  outline-offset: 2px;
}
.op-chat-header-main .op-chat-inbox-icon { width: 14px; height: 14px; flex: 0 0 auto; }
.op-chat-header-main .op-chat-inbox-toggle-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 640;
  color: var(--fg-dim);
}
.op-chat-header-main .op-chat-inbox-toggle:hover .op-chat-inbox-toggle-label,
.op-chat-header-main .op-chat-inbox-toggle.is-on .op-chat-inbox-toggle-label {
  color: var(--fg);
}
.op-chat-inbox-badge {
  flex: 0 0 auto;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  margin-left: 2px;
  border-radius: 999px;
  background: var(--bad, #f87171);
  /* EI-20188337255817233: --bad is a light rose in the frost theme
     (#fb7185), so white at 9px only reaches 2.69:1. The deepest surface
     token stays dark in every theme and clears the 4.5:1 body-text floor. */
  color: var(--bg-deepest, #02060c);
  font-size: 9px;
  font-weight: 750;
  line-height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* Collapsed rail: the pending count stays visible on the expand strip. */
.op-chat-expand-rail .op-chat-rail-badge {
  position: absolute;
  top: 8px;
  right: 5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--bad, #f87171);
  color: var(--bg-deepest, #02060c);
  font-size: 9px;
  font-weight: 750;
  line-height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.op-chat-view-loading { padding: 12px; font-size: 12px; color: var(--fg-mute, #8a8a91); }

.op-chat-sidebar {
  position: fixed;
  /* Sit BELOW the dev env-switcher bar (WI-4729: the header orb was clipped
     under it). The operator-vite EnvSwitcherBar publishes its measured height
     as --pc-env-bar-h on the root element while shown; the 0px fallback keeps
     the sidebar flush to the top everywhere else — same convention as
     .pclsb/.pcdar and .pc-header. */
  top: var(--pc-env-bar-h, 0px);
  /* D-009: the steering/settings rail is the far-left dock; chat is the
     middle dock and therefore begins at that rail's rendered width. */
  left: var(--left-sidebar-w, 0px);
  bottom: 0;
  /* Above .operator-panel (z-index 1200) so the Deck scrim + backdrop-filter
     don't dim/blur the chat when the Deck panel is open. */
  z-index: 1300;
  border-right: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
  background:
    radial-gradient(circle at 50% -12%, color-mix(in srgb, var(--accent), transparent 84%), transparent 34%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 100%);
  color: var(--fg, #e7eef7);
  display: flex;
  flex-direction: column;
  box-shadow: inset -1px 0 0 rgba(255,255,255,0.03), 18px 0 44px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  /* Width set inline via style. */
}
.op-chat-expanded-shell {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  /* WI-5162: the query container the header's face labels respond to. The
     sidebar is drag-resized independently of the viewport, so its own inline
     size — not the screen's — is what decides whether the labels fit. */
  container-type: inline-size;
  container-name: op-chat;
}

.op-chat-expand-rail {
  position: relative;
  z-index: 3;
  display: none;
  width: 100%;
  height: 100%;
  padding: 12px 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  align-items: center;
  justify-content: flex-start;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
}

.op-chat-expand-orb {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 76%);
  background: radial-gradient(circle at 35% 25%, rgba(255,255,255,0.18), transparent 24%), color-mix(in srgb, var(--accent), transparent 88%);
  color: var(--accent-strong, var(--accent-soft));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 28px color-mix(in srgb, var(--bg-deeper), transparent 76%);
}

.op-chat-expand-logo {
  width: 30px;
  height: 30px;
}

.op-chat-expand-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  color: color-mix(in srgb, var(--fg), transparent 14%);
}

.op-chat-expand-chevron {
  width: 18px;
  height: 18px;
  color: var(--accent-soft);
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-expanded-shell {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-expand-rail {
  display: flex;
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-resize-handle {
  display: none;
}

/* Docked pane document (/portal-panes/chat, framed by the cloud portal as one
   of ITS sidebars — owner ask 2026-09-01): the chat IS the page, so it flows
   in the document instead of pinning to the viewport, fills the frame, and
   drops the controls the portal now owns (collapse/expand, drag-resize). */
.op-chat-sidebar.op-chat-sidebar--docked {
  position: static;
  width: 100% !important;
  height: 100%;
  min-height: 100dvh;
  z-index: auto;
  box-shadow: none;
}
.op-chat-sidebar.op-chat-sidebar--docked .op-chat-expand-rail,
.op-chat-sidebar.op-chat-sidebar--docked .op-chat-toggle,
.op-chat-sidebar.op-chat-sidebar--docked .op-chat-resize-handle {
  display: none;
}

.op-chat-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 10px 12px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 16%), color-mix(in srgb, var(--bg), transparent 6%)),
    var(--bg);
}

.op-chat-header-main {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

/* WI-4738 one-line header: the wordmark yields (truncates) before the
   controls do, so the row never wraps at narrow sidebar widths. */
.op-chat-header-main .op-chat-wordmark {
  flex: 0 1 auto;
  min-width: 0;
}

.op-chat-header-main .op-chat-wordmark-title {
  font-size: 14px;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.op-chat-toggle {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-1), transparent 6%);
  color: #eef8ff;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  cursor: pointer;
}

.op-chat-toggle svg {
  width: 16px;
  height: 16px;
}

.op-chat-expand-rail:hover,
.op-chat-toggle:hover {
  background: color-mix(in srgb, var(--bg-popover), transparent 2%);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%);
}

.op-chat-expand-rail:focus-visible,
.op-chat-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong), transparent 18%);
  outline-offset: 2px;
}

.op-chat-controls {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: visible;
  /* WI-4738: right-align the control cluster on the single header row. */
  margin-left: auto;
  flex: 0 0 auto;
  flex-wrap: nowrap;
}

.op-chat-controls .op-active-toggle {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 3px 7px;
  font-size: 10px;
  letter-spacing: 0;
}

.op-chat-controls .pc-voice-control {
  position: relative;
  /* WI-4738: natural size — the old flex:1 stretched the voice button across
     the whole row, which is exactly the "gigantic mic" the owner flagged. */
  flex: 0 0 auto;
  min-width: 0;
  gap: 4px;
  margin-left: 0;
  overflow: visible;
}

.op-chat-controls .pc-voice-btn {
  flex: 0 0 auto;
  justify-content: center;
  min-width: 0;
  min-height: 26px;
  padding: 3px 7px 3px 6px;
  gap: 5px;
}

/* WI-4778/WI-4789: the 🎯 pot-health toggle — flat control (design docs §
   buttons: 1px border, tinted fill, no shadow/gradient/lift), lit accent
   while the pot view is on. Docked immediately AFTER the Papercup orb + name
   (owner ask 2026-07-14) and carrying its own "Pot Health" label so the
   pane's two faces read as peers: [🥤 Papercup] [🎯 Pot Health]. */
.op-chat-header-main .op-chat-papercup-toggle,
.op-chat-header-main .op-chat-pot-toggle {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 26px;
  padding: 0 8px 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 74%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-1), transparent 4%);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

/* WI-4793: the Papercup toggle's leading glyph — the brand mark inline at the
   🎯 peer's scale, with NO orb box / gradient / glow (the 🎯 side is a plain
   text emoji), so the two pills read as a matched pair. */
.op-chat-header-main .op-chat-papercup-mark {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.op-chat-header-main .op-chat-papercup-logo {
  width: 18px;
  height: 18px;
}

/* The label besides the glyph — the wordmark-title treatment, one step
   smaller so the Papercup identity stays the header's lead. Truncates before
   the voice controls do at narrow widths. */
.op-chat-header-main .op-chat-pot-toggle-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 640;
  color: var(--fg-dim);
}

.op-chat-header-main .op-chat-pot-toggle:hover .op-chat-pot-toggle-label,
.op-chat-header-main .op-chat-pot-toggle.is-on .op-chat-pot-toggle-label {
  color: var(--fg);
}

/* WI-5162: the Fleet + Peers faces — same flat pill chrome as 🎯 (they share
   .op-chat-pot-toggle), but their glyph is a lucide icon rather than an emoji,
   so it needs explicit sizing to sit at the 🎯/🥤 peers' scale. */
.op-chat-header-main .op-chat-face-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim);
}
.op-chat-header-main .op-chat-face-toggle:hover .op-chat-face-icon,
.op-chat-header-main .op-chat-face-toggle.is-on .op-chat-face-icon {
  color: var(--fg);
}

/* Five faces + the voice controls do not fit one header row at any width the
   sidebar is actually used at, so the ADDED faces collapse to icon-only pills
   and let their labels go — the three original faces keep theirs.

   The 860px threshold is MEASURED, not guessed (WI-5162, in the Tauri shell at
   1280x800). Label widths by sidebar width, potLabel:wordmark:fleetLabel:
       360→0:0:0   460→0:0:0   560→4:2:0   700→37:35:15   900→65:62:32
   i.e. this row is ALREADY over-subscribed before these two faces exist: at the
   360px default the "Pot Health" label (WI-4789) and the Papercup wordmark
   (WI-4793) are flex-squeezed to ZERO width and render as icons regardless.
   They only reach full size around 900px. Below 860 there is no room for a face
   label, and a squeezed 0-width label is worse than none — it keeps its padding
   and gap, so the pill reads as a lopsided icon. Cutting it cleanly ALSO hands
   the space back to the original labels (measured: at 700px, potLabel 37→53).
   Drag the sidebar past 860 and the face labels appear.

   (The underlying crush is pre-existing and NOT fixed here — that would mean
   re-opening the one-header-line decision (WI-4738) uninvited. Filed separately
   with these measurements.)

   A container query, not a media query: the sidebar is drag-resized
   independently of the viewport, so its own inline size is what decides. */
@container op-chat (max-width: 860px) {
  .op-chat-header-main .op-chat-face-toggle .op-chat-pot-toggle-label {
    display: none;
  }
  .op-chat-header-main .op-chat-face-toggle {
    padding: 0 6px;
  }

  /* OWNER ASK 2026-07-27 ("the learning tab button is too hard to see — make it
     have the text Learning like the pot health button"): 🎓 Learning is EXEMPT
     from the icon-only collapse above and keeps its label at every width the
     button itself renders at, exactly like [🎯 Pot Health] and the [🥤 Papercup]
     wordmark. A bare graduation-cap glyph was not self-evident — the owner could
     not tell what the button was, which is the whole point of a label.

     This deliberately re-spends some of the header width the rule above was
     reclaiming. That trade is now explicitly the owner's call and supersedes the
     WI-5162 "cut cleanly rather than squeeze" default FOR THIS ONE FACE — Fleet
     and Peers still collapse to icons, so the row gives up one label's width, not
     three. The shared truncation treatment (overflow:hidden + text-overflow:
     ellipsis) still applies, so if a narrow sidebar does run out of room the
     label ellipsises instead of overflowing the row. */
  .op-chat-header-main .op-chat-face-toggle--learning .op-chat-pot-toggle-label {
    display: block;
  }
  /* …and with the label back, match [🎯 Pot Health]'s pill padding rather than
     the tightened icon-only padding, so the two read as the matched pair the
     owner asked for. */
  .op-chat-header-main .op-chat-face-toggle--learning {
    padding: 0 8px 0 6px;
  }
}

/* EI-13551: the voice-control cluster (.op-chat-controls) is flex: 0 0 auto
   — it never shrinks, so ANY width shortfall lands entirely on the two
   owner-asked-for identity labels ([🥤 Papercup] wordmark WI-4793, [🎯 Pot
   Health] WI-4789), which squeeze to literal 0px well before the sidebar's
   860px default. Below that same threshold, drop the controls cluster's own
   TEXT labels (OperatorActiveToggle's state word, VoiceButton's mode word —
   both already convey their state via icon/color/tooltip/aria-label, same as
   TtsMuteButton and AudienceModeSelector already do icon-only) and tighten
   their padding, so the cluster's footprint shrinks instead of staying rigid
   — handing the freed width back to the identity labels, the same "cut
   cleanly rather than let it squeeze to an unreadable sliver" strategy used
   for the face labels above. This does NOT reopen the one-header-line
   decision (WI-4738) — still one row, just a smaller rigid block. */
@container op-chat (max-width: 860px) {
  .op-chat-controls .op-active-toggle-label,
  .op-chat-controls .pc-voice-btn-label {
    display: none;
  }
  .op-chat-controls .op-active-toggle {
    gap: 0;
    padding: 3px 6px;
  }
  .op-chat-controls .pc-voice-btn {
    gap: 0;
    padding: 3px 6px;
  }
  /* The mic-settings gear is a convenience shortcut to /settings/voice
     (already reachable from the app's main Settings nav) — icon-only since
     WI-owner-ask-2026-06-23, and the least-essential control left in this
     cluster. Drop it before the identity labels lose any more room. */
  .op-chat-controls .pc-voice-settings-link {
    display: none;
  }
  .op-chat-controls {
    gap: 3px;
  }
}

/* EI-13551 cont'd: even with the controls cluster + face labels compacted
   above, the row still doesn't fit at the sidebar's 360px DEFAULT width
   (measured: potLabel:wordmark still 0:0 at 360, only 11.8:9.5 at 460) — the
   Plans + Inbox toggles' own labels (flex:0 1 auto, same shrink class as the
   two owner-mandated labels) are still competing for the same budget, and
   the 11px header-main gap across 8 flex items (7 gaps) alone costs 77px.
   Neither Plans nor Inbox is a WI-4789/WI-4793 ask, so below a narrower
   threshold they get the SAME icon-only treatment already given to the
   Fleet/Peers faces above — freeing their label's flex-basis entirely back
   to the row — and the row's own gap tightens to match .op-chat-controls'.
   480px (not 860) because Plans/Inbox reads fine with labels down to ~560. */
@container op-chat (max-width: 480px) {
  .op-chat-header-main .op-chat-inbox-toggle-label {
    display: none;
  }
  .op-chat-header-main .op-chat-inbox-toggle {
    padding: 0 6px;
    gap: 0;
  }
  /* Even with every other lever above pulled, the row exactly BREAKS EVEN
     at the 360px default (339px of content for 339px of room) — there is
     no slack left for the two owner-mandated labels to render at all. The
     Fleet/Peers faces (WI-5162, added AFTER WI-4789/WI-4793) are the one
     remaining non-essential element still taking floor space (icon +
     padding + gap, even with their own labels already dropped at 860px
     above) — drop them ENTIRELY below 480px, the same "cut cleanly" call
     already made for their labels, just carried one step further. This
     trades their one-click header access at the narrowest widths for the
     two owner-mandated labels actually rendering — worth revisiting
     (e.g. folding them into the audience-mode-style overflow popover) if
     that trade turns out to be wrong. */
  .op-chat-header-main .op-chat-face-toggle {
    display: none;
  }
}

.op-chat-header-main .op-chat-papercup-toggle.is-on,
.op-chat-header-main .op-chat-pot-toggle.is-on {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 30%);
  background: color-mix(in srgb, var(--accent), transparent 82%);
}

.op-chat-header-main .op-chat-papercup-toggle:hover,
.op-chat-header-main .op-chat-pot-toggle:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%);
  background: color-mix(in srgb, var(--accent), transparent 88%);
}

.op-chat-header-main .op-chat-papercup-toggle:focus-visible,
.op-chat-header-main .op-chat-pot-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong), transparent 18%);
  outline-offset: 2px;
}

/* WI-4740: the speak-responses (TTS) mute — moved here from the retired
   middle-bar (PapercupVoiceBar) so voice controls live on the chat bar only. */
.op-chat-controls .op-chat-tts {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 74%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-1), transparent 4%);
  color: #eef8ff;
  cursor: pointer;
}

.op-chat-controls .op-chat-tts.is-muted {
  color: var(--fg-mute, #7f9bb4);
  background: transparent;
}

.op-chat-controls .op-chat-tts:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%);
  background: color-mix(in srgb, var(--accent), transparent 88%);
}

/* EI-13551: the AudienceModeSelector overflow trigger — same flat-pill
   chrome as .op-chat-tts (an icon-only control button already in this
   cluster), shown only below AUDIENCE_MODE_OVERFLOW_WIDTH. */
.op-chat-controls .op-chat-audience-overflow-trigger {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 74%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-1), transparent 4%);
  color: #eef8ff;
  cursor: pointer;
}
.op-chat-controls .op-chat-audience-overflow-trigger[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 30%);
  background: color-mix(in srgb, var(--accent), transparent 82%);
}
.op-chat-controls .op-chat-audience-overflow-trigger:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%);
  background: color-mix(in srgb, var(--accent), transparent 88%);
}
.op-chat-audience-popover {
  padding: 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 74%);
  background: var(--bg-popover, var(--bg-1));
  box-shadow: 0 10px 28px rgba(0,0,0,0.32);
}

.op-chat-controls .pc-voice-btn-orb {
  width: 16px;
  height: 16px;
}

.op-chat-controls .pc-voice-btn-label {
  font-size: 10px;
  letter-spacing: 0;
}

.op-chat-controls .pc-voice-settings-link {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 0 6px;
}
.op-chat-controls .pc-voice-settings-text {
  display: none;
}
.op-chat-controls .pc-voice-wake-hint {
  z-index: 5;
}

.op-chat-sidebar .op-chat-banner {
  margin: 10px 12px 0;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent-strong), transparent 93%);
  color: #cfeeff;
  font-size: 12px;
  line-height: 1.4;
}

.op-chat-sidebar .oracle-body {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 4%), color-mix(in srgb, var(--bg-deeper), transparent 2%)) !important;
  padding: 14px 13px;
  gap: 12px;
  scrollbar-color: color-mix(in srgb, var(--accent-strong), transparent 78%) transparent;
}

.op-chat-sidebar .oracle-virtual-container {
  flex: 0 0 auto;
}

.op-chat-sidebar .oracle-msg {
  width: 100% !important;
  max-width: 100% !important;
  padding: 0 2px;
  box-sizing: border-box;
}

.op-chat-sidebar .oracle-msg-avatar {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
}

.op-chat-sidebar .oracle-msg-stack {
  max-width: calc(100% - 40px);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  margin-left: auto;
}

.op-chat-sidebar .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 87%);
  background: color-mix(in srgb, var(--bg), transparent 8%) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 10px 22px rgba(0,0,0,0.16);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent), transparent 72%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 2%), color-mix(in srgb, var(--bg-popover), transparent 2%)) !important;
}

.op-chat-sidebar .oracle-msg-content:empty,
.op-chat-sidebar .oracle-msg-content:has(> :only-child:empty) {
  display: none;
}

.op-chat-sidebar .oracle-tool-chip {
  max-width: 100%;
  overflow: hidden;
}

.op-chat-sidebar .oracle-form {
  border-top-color: color-mix(in srgb, var(--accent-strong), transparent 86%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg), transparent 8%), color-mix(in srgb, var(--bg-deeper), transparent 2%)) !important;
  padding: 12px;
}

.op-chat-sidebar .oracle-form input {
  background: rgba(255,255,255,0.04);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%);
}

.op-chat-sidebar .oracle-form input:focus {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 52%);
}

.op-chat-sidebar .oracle-send-button {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%);
  background: color-mix(in srgb, var(--accent-strong), transparent 90%);
}

.op-chat-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 1;
  touch-action: none;
}
.op-chat-resize-handle:hover {
  background: color-mix(in srgb, var(--accent-strong), transparent 82%);
}

/* Body shift: every page absorbs the sidebar's width as left padding.
   Pages with margin: auto centered content stay centered within the
   remaining space (the centering algorithm absorbs the loss into
   what used to be margin). Edge-to-edge pages may need their own
   per-page padding tweaks.

   ⚠ COMMUTATION CONTRACT (WI-4725): the LeftSidebar rail (operator-vite
   left-sidebar.styles.ts) sets an equal-specificity body.has-left-sidebar
   rule: padding-left: calc(--op-chat-w + --left-sidebar-w). When BOTH are
   open, cascade order between the two independently-injected <style> tags
   decides which rule applies — so BOTH rules must compute the IDENTICAL
   full sum (each var defaults 0px when its surface is absent; the owning
   component sets its var before adding its body class and removes it on
   unmount). An op-chat-only padding-left: var(--op-chat-w) here silently
   clobbers the rail's additive rule and the rail lands ON TOP of the main
   pane (owner-reported overlap, 2026-07-13). Same for the .pc-header
   width leg below. Keep the formulas in the two files in lockstep. */
body.has-op-chat {
  padding-left: calc(var(--op-chat-w, 360px) + var(--left-sidebar-w, 0px));
}

/* Only the global sticky header needs an explicit width clamp.
   The harness strip (.h-header) already sits inside body content, so the
   body padding-left above shifts it naturally; offsetting it again doubles
   the shift and clips the right-side controls after chat mount / resize.
   Width must subtract EVERY docked rail (see the commutation contract
   above) — 100vw minus only --op-chat-w over-widens by the rail width and
   pushes the right-side nav off-viewport when the rail is open. */
body.has-op-chat .pc-header {
  left: calc(var(--left-sidebar-w, 0px) + var(--op-chat-w, 360px));
  width: calc(100vw - var(--op-chat-w, 360px) - var(--left-sidebar-w, 0px) - var(--dev-rail-w, 0px));
}

.op-chat-sidebar {
  isolation: isolate;
  background:
    radial-gradient(circle at 16% 0%, color-mix(in srgb, var(--accent-strong), transparent 84%), transparent 22%),
    radial-gradient(circle at 82% 12%, rgba(255,255,255,0.06), transparent 16%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 58%, var(--bg-deepest) 100%);
  box-shadow:
    inset -1px 0 0 rgba(255,255,255,0.03),
    inset 0 1px 0 rgba(255,255,255,0.04),
    22px 0 54px rgba(0, 0, 0, 0.24);
}

.op-chat-sidebar::before,
.op-chat-sidebar::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.op-chat-sidebar::before {
  border-right: 1px solid color-mix(in srgb, var(--accent-soft), transparent 90%);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 12%, transparent 88%, rgba(255,255,255,0.03));
  opacity: 0.8;
}

.op-chat-sidebar::after {
  inset: 118px 0 58px;
  background:
    linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent-strong), transparent 95.5%) 16%, transparent 36%),
    repeating-linear-gradient(180deg, rgba(255,255,255,0.015) 0 1px, transparent 1px 32px);
  opacity: 0.55;
}

.op-chat-header {
  position: relative;
  z-index: 3;
  overflow: visible;
  isolation: isolate;
  backdrop-filter: blur(12px);
  background:
    radial-gradient(circle at 12% 12%, color-mix(in srgb, var(--accent-strong), transparent 88%), transparent 18%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 4%), color-mix(in srgb, var(--bg-deep), transparent 2%)),
    var(--bg);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent-strong), transparent 92%);
}
.op-chat-header-main {
  position: relative;
  z-index: 1;
}

/* WI-6530: the header sheen used to sweep on a 9s infinite animation. ANY
   always-on animation keeps the whole 60fps repaint loop alive, and on this
   software-rendered webview that repaint costs ~40% of a CPU core permanently
   (measured: 48-63% of a core at idle with animations running, 9-16% with all
   of them paused; pausing only SOME buys nothing). The sheen was invisible at
   rest (opacity 0 for 0%/12%/100% of the cycle), so dropping the element keeps
   the header exactly as it looks between sweeps. */

.op-chat-sidebar .op-chat-banner {
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(8px);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 90%), color-mix(in srgb, var(--accent), transparent 95%));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

/* WI-6530: the banner sheen was the same always-on infinite sweep as the header
   one above — it only escaped the idle-CPU measurement because the banner was not
   rendered at the time. Also invisible at rest (opacity 0 for 0%/72%/100% of its
   cycle), so dropping it leaves the banner looking identical between sweeps. */

.op-chat-sidebar .oracle-body {
  position: relative;
  z-index: 1;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 4%), color-mix(in srgb, var(--bg-deeper), transparent 1.5%)) !important;
}

.op-chat-sidebar .oracle-msg-content {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-1), transparent 3%), color-mix(in srgb, var(--bg-deep), transparent 1%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 12px 24px rgba(0,0,0,0.18);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 1%), color-mix(in srgb, var(--bg-popover), transparent 1%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 14px 28px color-mix(in srgb, var(--bg-deeper), transparent 78%);
}

.op-chat-sidebar .oracle-form {
  position: relative;
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.025);
}

.op-chat-sidebar .oracle-form::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent-strong), transparent 76%), transparent);
}

.op-chat-sidebar .oracle-form input {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

.op-chat-sidebar .oracle-send-button {
  position: relative;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--accent-strong), transparent 70%);
  background: linear-gradient(180deg, rgba(71, 198, 255, 0.22), color-mix(in srgb, var(--accent), transparent 88%));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.06),
    0 8px 18px color-mix(in srgb, var(--bg-deeper), transparent 82%);
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background 120ms ease;
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 58%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 74%), color-mix(in srgb, var(--accent), transparent 84%));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    0 10px 20px color-mix(in srgb, var(--bg-deeper), transparent 78%);
}

.op-chat-sidebar .oracle-send-button::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.14), transparent);
  transform: translateX(-150%);
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled)::after {
  animation: op-chat-button-sheen 800ms ease;
}

.op-chat-resize-handle {
  width: 7px;
}

.op-chat-resize-handle:hover {
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent-strong), transparent 96%), color-mix(in srgb, var(--accent-strong), transparent 78%), color-mix(in srgb, var(--accent-strong), transparent 96%));
}

/* op-chat-header-sheen / op-chat-banner-sheen removed with their always-on
   animations (WI-6530). op-chat-button-sheen below stays: it is hover-triggered
   and runs once for 800ms, so it never holds the repaint loop open. */
@keyframes op-chat-button-sheen {
  from { transform: translateX(-150%); }
  to { transform: translateX(150%); }
}

/* Simplicity/readability pass: flatten decorative motion, tighten message
   rhythm, and give the composer more useful text space. */
.op-chat-sidebar {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 1%), color-mix(in srgb, var(--bg-deepest), transparent 1%)) !important;
  box-shadow:
    inset -1px 0 0 rgba(255,255,255,0.035),
    14px 0 34px rgba(0, 0, 0, 0.18) !important;
}

.op-chat-sidebar::after,
.op-chat-header::after,
.op-chat-sidebar .op-chat-banner::after,
.op-chat-sidebar .oracle-form::before,
.op-chat-sidebar .oracle-send-button::after,
.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content::before,
.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content::after {
  display: none !important;
}

.op-chat-sidebar::before {
  opacity: 0.42 !important;
  background: none !important;
}

.op-chat-header {
  padding: 8px 10px 7px !important;
  background: color-mix(in srgb, var(--bg-deep), transparent 4%) !important;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent-strong), transparent 90%) !important;
  backdrop-filter: none !important;
}

.op-chat-header-main {
  gap: 9px !important;
}

/* EI-13551: the "Simplicity/readability pass" above hardcodes gap:9px
   !important UNCONDITIONALLY — it silently defeated the container-query gap
   tightening added earlier in this file (same specificity, but that rule's
   !important loses to this later, also-!important one, regardless of
   container width). Re-assert the narrow-width tightening here, AFTER it in
   source order, so the cascade actually reaches the container query — same
   specificity + !important + later source wins. */
@container op-chat (max-width: 480px) {
  .op-chat-header-main {
    gap: 6px !important;
  }
}

.op-chat-header-main .op-chat-wordmark-title {
  font-size: 13.5px !important;
}

.op-chat-controls .op-active-toggle,
.op-chat-controls .pc-voice-btn,
.op-chat-controls .pc-voice-settings-link,
.op-chat-header-main .op-chat-papercup-toggle,
.op-chat-header-main .op-chat-pot-toggle,
.op-chat-controls .op-chat-tts {
  min-height: 27px !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-body {
  padding: 8px 8px 9px !important;
  gap: 7px !important;
  background: color-mix(in srgb, var(--bg-deepest), transparent 2%) !important;
}

.op-chat-sidebar .oracle-msg {
  padding-inline: 0 !important;
  column-gap: 7px !important;
}

/* WI-4731: the owner flagged the agent mark as too small to read. This
   compact-density override was pinning it at 20px with !important, silently
   defeating the globals.css bump (24 -> 34px) -- the avatar the owner sees IS
   this rule. Keep the sidebar denser than the full-width chat, but large
   enough that the role mark reads: 30px avatar / 18px glyph. */
.op-chat-sidebar .oracle-msg-avatar {
  width: 30px !important;
  height: 30px !important;
  flex-basis: 30px !important;
  margin-top: 1px;
  opacity: 0.9;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-msg-icon {
  width: 18px !important;
  height: 18px !important;
}

.op-chat-sidebar .oracle-msg-stack {
  max-width: calc(100% - 38px) !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  max-width: min(84%, 286px) !important;
}

.op-chat-sidebar .oracle-msg-content {
  padding: 9px 10px !important;
  border-radius: 12px !important;
  background: color-mix(in srgb, var(--bg), transparent 6%) !important;
  box-shadow: none !important;
  font-size: 13px !important;
  line-height: 1.5 !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background: color-mix(in srgb, var(--bg-raised-high), transparent 4%) !important;
}

.op-chat-sidebar .oracle-tool-chip {
  min-height: 22px;
  padding: 3px 8px;
  border-radius: 999px;
  opacity: 0.74;
  font-size: 10.5px;
  box-shadow: none !important;
}

.op-chat-sidebar .op-chat-banner {
  margin: 8px 9px 0 !important;
  padding: 8px 9px !important;
  border-radius: 10px !important;
  background: color-mix(in srgb, var(--accent), transparent 92.5%) !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-form {
  padding: 8px !important;
  gap: 6px !important;
  background: color-mix(in srgb, var(--bg-deep), transparent 2%) !important;
}

.op-chat-sidebar .oracle-input-shell {
  min-height: 38px !important;
  border-radius: 12px !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-input-shell input {
  padding-right: 12px !important;
  font-size: 13px !important;
}

.op-chat-sidebar .oracle-input-meta {
  display: none !important;
}

.op-chat-sidebar .oracle-send-button {
  min-width: 58px !important;
  min-height: 38px !important;
  border-radius: 12px !important;
  box-shadow: none !important;
  transform: none !important;
}

/* Contrast follow-up: separate chat surfaces from the sidebar background so
   reading requires less effort at a glance. */
.op-chat-sidebar .oracle-body {
  background: color-mix(in srgb, var(--bg-deepest), transparent 1%) !important;
}

.op-chat-controls .op-active-toggle,
.op-chat-controls .pc-voice-btn,
.op-chat-controls .pc-voice-settings-link,
.op-chat-header-main .op-chat-papercup-toggle,
.op-chat-header-main .op-chat-pot-toggle,
.op-chat-controls .op-chat-tts {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 74%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 4%) !important;
  color: #eef8ff !important;
}

/* Keep the muted TTS state visually distinct despite the contrast group's
   !important ink above. */
.op-chat-controls .op-chat-tts.is-muted {
  color: var(--fg-mute, #7f9bb4) !important;
  background: transparent !important;
}

/* Same carve-out for the lit 🎯 / Papercup state (WI-4778 / WI-4793). */
.op-chat-header-main .op-chat-papercup-toggle.is-on,
.op-chat-header-main .op-chat-pot-toggle.is-on {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 30%) !important;
  background: color-mix(in srgb, var(--accent), transparent 82%) !important;
}

.op-chat-controls .pc-voice-btn-orb {
  background: color-mix(in srgb, var(--accent), transparent 86%) !important;
}

.op-chat-sidebar .op-chat-banner {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--accent), transparent 89%) !important;
  color: #e6f6ff !important;
}

.op-chat-sidebar .oracle-tool-chip {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--accent), transparent 88%) !important;
  color: #c5edff !important;
  opacity: 0.92;
}

.op-chat-sidebar .oracle-msg-content {
  border: 1px solid rgba(148, 163, 184, 0.22) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 2%), color-mix(in srgb, var(--bg), transparent 1%)) !important;
  color: #f3f9ff !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 1%), color-mix(in srgb, var(--bg-raised-high), transparent 1%)) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-input-shell {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .oracle-input-shell input {
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-input-shell input::placeholder {
  color: color-mix(in srgb, var(--accent-soft), transparent 44%) !important;
}

.op-chat-sidebar .oracle-send-button {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%) !important;
  background: color-mix(in srgb, var(--accent), transparent 83%) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-send-button:disabled {
  border-color: rgba(148, 163, 184, 0.18) !important;
  background: rgba(255, 255, 255, 0.05) !important;
  color: color-mix(in srgb, var(--fg), transparent 28%) !important;
}

.op-chat-sidebar .ask-choice-card {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .ask-choice-option {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 86%) !important;
  background: rgba(255, 255, 255, 0.028) !important;
}

/* Readability follow-up: clarify utility text and affordances without adding
   chrome. These are the surfaces users scan before typing or responding. */
.op-chat-sidebar .oracle-load-earlier {
  padding: 7px 0 8px !important;
  color: color-mix(in srgb, var(--fg), transparent 46%) !important;
  font-size: 10px !important;
  font-weight: 760 !important;
  letter-spacing: 0 !important;
}

.op-chat-sidebar .oracle-load-earlier-end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: color-mix(in srgb, var(--fg), transparent 42%) !important;
}

.op-chat-sidebar .oracle-load-earlier-end::before,
.op-chat-sidebar .oracle-load-earlier-end::after {
  content: "";
  width: 42px;
  height: 1px;
  background: color-mix(in srgb, var(--accent-strong), transparent 86%);
}

.op-chat-sidebar .oracle-tool-chip {
  font-size: 11px;
  line-height: 1.25;
  letter-spacing: 0;
}

.op-chat-sidebar .oracle-msg-content {
  border-color: rgba(148, 163, 184, 0.30) !important;
  font-size: 13.25px !important;
  line-height: 1.54 !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 50%) !important;
}

.op-chat-sidebar .oracle-empty-state-title {
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-empty-state-text {
  color: color-mix(in srgb, var(--fg), transparent 22%) !important;
}

.op-chat-sidebar .op-chat-empty-panel {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-panel-label {
  color: color-mix(in srgb, var(--fg), transparent 18%) !important;
}

.op-chat-sidebar .op-chat-empty-row {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 84%) !important;
  background: rgba(255, 255, 255, 0.035) !important;
}

.op-chat-sidebar .op-chat-empty-row-hint {
  color: color-mix(in srgb, var(--fg), transparent 22%) !important;
}

.op-chat-sidebar .oracle-input-icon {
  color: color-mix(in srgb, var(--accent-soft), transparent 24%) !important;
}

.op-chat-sidebar .oracle-input-shell input::placeholder {
  color: color-mix(in srgb, var(--fg), transparent 34%) !important;
}

.op-chat-sidebar .oracle-send-button:disabled {
  opacity: 0.86 !important;
}

.op-chat-sidebar .ask-choice-question {
  color: var(--fg) !important;
}

.op-chat-sidebar .ask-choice-picked {
  color: color-mix(in srgb, var(--fg), transparent 14%) !important;
}

.op-chat-sidebar .ask-choice-picked span {
  color: var(--fg) !important;
  font-weight: 720 !important;
}

.op-chat-sidebar .ask-choice-option[data-picked="true"] {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 62%) !important;
  background: color-mix(in srgb, var(--accent), transparent 86%) !important;
}

.op-chat-sidebar .ask-choice-submit-hint {
  color: color-mix(in srgb, var(--fg), transparent 20%) !important;
}

/* Usability follow-up: make the first-run panel, composer, and selectable
   choices read as practical controls rather than decorative HUD pieces. */
.op-chat-sidebar .oracle-body {
  overflow-x: hidden !important;
}

.op-chat-sidebar .oracle-empty-state {
  gap: 11px !important;
}

.op-chat-sidebar .oracle-empty-state-icon {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%) !important;
  background: color-mix(in srgb, var(--bg-raised-high), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-panel {
  width: min(100%, 284px) !important;
  padding: 13px !important;
}

.op-chat-sidebar .op-chat-empty-panel-head {
  margin-bottom: 10px !important;
}

.op-chat-sidebar .op-chat-empty-panel-label {
  letter-spacing: 0 !important;
}

.op-chat-sidebar .op-chat-empty-row {
  gap: 3px !important;
  padding: 9px 10px !important;
  border-color: color-mix(in srgb, var(--accent-strong), transparent 80%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-row-title {
  color: var(--fg) !important;
  font-size: 12.5px !important;
  line-height: 1.28 !important;
}

.op-chat-sidebar .op-chat-empty-row-hint {
  line-height: 1.42 !important;
}

.op-chat-sidebar .oracle-msg-content,
.op-chat-sidebar .oracle-tool-chip,
.op-chat-sidebar .ask-choice-question,
.op-chat-sidebar .ask-choice-option-label,
.op-chat-sidebar .ask-choice-option-hint {
  overflow-wrap: anywhere;
}

.op-chat-sidebar .ask-choice-option {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 8%) !important;
}

.op-chat-sidebar .ask-choice-option:hover:not([data-disabled="true"]) {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 68%) !important;
  background: color-mix(in srgb, var(--bg-raised), transparent 4%) !important;
}

.op-chat-sidebar .ask-choice-option-label {
  color: var(--fg) !important;
  line-height: 1.28 !important;
  white-space: normal !important;
}

.op-chat-sidebar .ask-choice-option-hint {
  color: color-mix(in srgb, var(--fg), transparent 20%) !important;
  line-height: 1.34 !important;
  white-space: normal !important;
}

.op-chat-sidebar .ask-choice-option-icon {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--accent), transparent 85%) !important;
}

.op-chat-sidebar .ask-choice-option-chevron {
  color: color-mix(in srgb, var(--fg), transparent 18%) !important;
}

.op-chat-sidebar .oracle-form {
  position: relative;
  z-index: 4;
  border-top-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--bg-deep), transparent 1%) !important;
  box-shadow: 0 -14px 26px rgba(0, 0, 0, 0.24) !important;
}

.op-chat-sidebar .oracle-input-shell {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 70%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 1%) !important;
}

.op-chat-sidebar .oracle-input-shell::before {
  content: none !important;
  display: none !important;
}

.op-chat-sidebar .oracle-input-shell:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 58%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 1%) !important;
}

.op-chat-sidebar .oracle-input-shell:focus-within {
  border-color: color-mix(in srgb, var(--accent), transparent 42%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 1%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 0 16px color-mix(in srgb, var(--accent), transparent 84%) !important;
}

.op-chat-sidebar .oracle-input-shell input {
  caret-color: var(--accent-strong);
}

.op-chat-sidebar .oracle-send-button:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 52%) !important;
  background: color-mix(in srgb, var(--accent), transparent 76%) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 34%) !important;
  background: color-mix(in srgb, var(--accent), transparent 70%) !important;
}

.op-chat-sidebar button.op-chat-empty-row {
  position: relative;
  width: 100%;
  padding-right: 58px !important;
  appearance: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.op-chat-sidebar button.op-chat-empty-row::after {
  content: "Draft";
  position: absolute;
  right: 10px;
  top: 50%;
  height: 19px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 76%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent), transparent 88%);
  color: rgba(224, 247, 255, 0.90);
  font-size: 9.5px;
  font-weight: 760;
  letter-spacing: 0;
  line-height: 1;
  text-transform: uppercase;
  transform: translateY(-50%);
}

.op-chat-sidebar button.op-chat-empty-row:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 64%) !important;
  background: color-mix(in srgb, var(--bg-raised), transparent 1%) !important;
}

.op-chat-sidebar button.op-chat-empty-row:hover:not(:disabled)::after,
.op-chat-sidebar button.op-chat-empty-row:focus-visible::after {
  border-color: color-mix(in srgb, var(--accent), transparent 54%);
  background: color-mix(in srgb, var(--accent), transparent 82%);
  color: var(--fg);
}

.op-chat-sidebar button.op-chat-empty-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent), transparent 38%);
  outline-offset: 3px;
}

.op-chat-sidebar button.op-chat-empty-row:disabled {
  cursor: wait;
  opacity: 0.72;
}

.op-chat-sidebar .oracle-send-button:disabled {
  border-color: rgba(148, 163, 184, 0.24) !important;
  background: rgba(255, 255, 255, 0.06) !important;
  color: color-mix(in srgb, var(--fg), transparent 24%) !important;
}

.op-chat-sidebar .oracle-tool-chip {
  max-width: min(100%, 286px);
  display: inline-flex !important;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.op-chat-sidebar .oracle-tool-chip svg {
  flex: 0 0 auto;
  opacity: 0.78;
}

.op-chat-sidebar .oracle-tool-chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.op-chat-sidebar .oracle-tool-chip:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent), transparent 38%);
  outline-offset: 3px;
}

.op-chat-tool-tooltip {
  display: grid;
  gap: 4px;
  max-width: 280px;
  overflow-wrap: anywhere;
}

.op-chat-tool-tooltip strong {
  color: var(--fg);
  font-size: 11px;
  line-height: 1.35;
}

.op-chat-tool-tooltip span {
  color: color-mix(in srgb, var(--fg), transparent 22%);
  font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 10px;
  line-height: 1.35;
}

/* WI-6503 [owner 2026-07-27, verbatim follow-up] "the chat box should disaply
   the users profile icon in their chat, not the papercup icon."

   This rule used to be "display: none !important", which made the owner's own
   turns avatar-LESS in the rail. That was defensible while the only thing the
   slot could show was the pane's papercup mark — a duplicate of the mark on
   every reply, so hiding it saved ~37px of a narrow rail for free. It is not
   defensible now: the slot carries the USER's own profile icon, which is
   exactly what the item asks to see, so hiding it here would silently defeat
   the fix on the one surface the owner actually reported.

   Sized by the '.op-chat-sidebar .oracle-msg-avatar' rule above (30px), so the
   row costs 30px + the 7px column-gap. */
.op-chat-sidebar .oracle-msg-user .oracle-msg-avatar {
  display: inline-flex !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  max-width: min(86%, 300px) !important;
}

/* Readability/usability follow-up: keep transcript bubbles distinct in the
   narrow rail without making the chat feel loose. Padding lives on the
   virtualized row itself so the measured item height includes the gap. */
.op-chat-sidebar .oracle-body {
  padding: 10px 9px 11px !important;
}

.op-chat-sidebar .oracle-msg {
  padding-block: 2px !important;
}

.op-chat-sidebar .oracle-msg-stack {
  gap: 3px !important;
}

.op-chat-sidebar .oracle-msg-content {
  padding: 9px 11px !important;
  border-radius: 13px !important;
  border-color: rgba(148, 163, 184, 0.36) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 1%), color-mix(in srgb, var(--bg), transparent 0.5%)) !important;
  color: var(--fg) !important;
  line-height: 1.56 !important;
}

.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 72%) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 0.5%), color-mix(in srgb, var(--bg), transparent 0.5%)) !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent), transparent 38%) !important;
  background: linear-gradient(180deg, rgba(24, 78, 113, 0.99), color-mix(in srgb, var(--bg-raised-high), transparent 0.5%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 8px 18px color-mix(in srgb, var(--bg-deeper), transparent 80%) !important;
}

.op-chat-sidebar .oracle-msg-system .oracle-msg-content {
  border-color: rgba(250, 204, 21, 0.30) !important;
  background: rgba(42, 31, 9, 0.86) !important;
  color: #fff7d6 !important;
}

.op-chat-sidebar .oracle-tool-chip {
  margin: 0 0 3px !important;
  border-color: color-mix(in srgb, var(--accent), transparent 66%) !important;
  background: color-mix(in srgb, var(--accent), transparent 84%) !important;
  color: #ddf6ff !important;
  opacity: 1 !important;
}

.op-chat-sidebar .oracle-input-shell input {
  height: 100% !important;
  border: 0 !important;
  border-radius: inherit !important;
  background: transparent !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-input-shell input:focus {
  border: 0 !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-thinking-row {
  flex-shrink: 0 !important;
  max-width: calc(100% - 38px) !important;
  margin: 4px 8px 12px 30px !important;
  border-color: color-mix(in srgb, var(--accent), transparent 66%) !important;
  border-radius: 13px !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
  color: #dff6ff !important;
  overflow: visible !important;
}

/* Deck panel open → chat must stay fully visible and unblurred.
   The Deck (.operator-panel) sits behind chat at z-index 1200 and has
   a backdrop-filter blur + box-shadow scrim that bleeds through any
   translucent chat surface. Neutralize every backdrop-filter inside
   the chat and force its background to opaque so the chat reads as
   sharp, unblurred, fully interactive on top of the Deck. */
body:has(.operator-panel) .op-chat-sidebar,
body:has(.operator-panel) .op-chat-sidebar * {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
body:has(.operator-panel) .op-chat-sidebar {
  background:
    radial-gradient(circle at 50% -12%, color-mix(in srgb, var(--accent), transparent 84%), transparent 34%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 100%),
    var(--bg-deeper) !important;
}
`;
