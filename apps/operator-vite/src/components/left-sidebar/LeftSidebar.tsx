/**
 * Left sidebar (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * dock's retired main pane: tabs in a docked, collapsible, drag-resizable
 * FAR-LEFT rail. The Papercup chat sidebar docks after it as the middle pane.
 * The zellij dock is now consoles-only (operator chat ⇄ brain ⇄ live
 * bees); the tab-style surfaces live HERE.
 *
 * SCOPE (owner placement corrections, 2026-07-16 → 2026-07-17): this rail is
 * the SETTINGS / steering surface — Accounts, Mug, Kettle, Papercup. (Pots was
 * removed 2026-08-10 on owner directive — see the note at its old slot in TABS.)
 * The
 * LIVE surfaces moved out to the leftmost op-chat sidebar one by one: Inbox
 * (EI-13037), then Fleet + Peers (WI-5162). Their panes still live in this
 * directory; only their host changed — see components/chat-faces/ChatFacesHost.
 *
 * Architecture mirrors the proven DevAdminRail (dev-admin-sidebar-2026-06-05):
 *   - DOCKED, not floating — reserves layout space (body.has-left-sidebar
 *     padding-left + --left-sidebar-w) so the app shifts right; it is the
 *     far-left dock at x=0.
 *   - Collapses to a thin icon rail (the three tab icons — clicking one
 *     expands straight into that tab), never disappears.
 *   - Drag-resizable from its RIGHT edge, width persisted per-workspace.
 *   - State in the URL via nuqs (`?lsb=…&lst=queen`) so it is deep-linkable
 *     and agent-driveable (ui:get_state / ui:dispatch).
 *   - Only the ACTIVE tab's panel is mounted (lazy chunks; queries gate on
 *     mount), and the whole body unmounts while collapsed.
 *
 * Unlike DevAdminRail this is NOT dev-gated — it's a first-class app surface.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
// Retry-wrapped lazy: a transient first-boot chunk fetch failure on the packaged
// WebKitGTK desktop must retry, not escalate to the fatal boundary (WI-2902).
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Tooltip } from '@/app/harness/Tooltip';
import { useQueryStates, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { usePathname } from '@/lib/router-compat/navigation';
import { isChromelessPath } from '@papercusp/operator-core/lib/chromeless-routes';
// Intentional cross-tree import: operator-vite's `@` points at apps/operator,
// where the shared two-dock layout contract lives.
import { isCompactDockViewport } from '@/app/_components/operator-chat-layout';
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';
// `Target` left with the Goals tab (2026-08-09) — it was that tab's icon and
// nothing else in this rail uses it.
// `Network` left with the Pots tab (2026-08-10) — it was that tab's icon and
// nothing else in this rail uses it.
import { Activity, CupSoda, KeyRound, MessagesSquare, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { LEFT_SIDEBAR_CSS } from './left-sidebar.styles';
// The always-on operator-voice controls that used to sit here (PapercupVoiceBar)
// are RETIRED (WI-4740, owner ask 2026-07-13): they duplicated the chat
// sidebar's op-chat-controls row button-for-button, so the chat bar is now the
// ONLY voice-controls surface (the TTS mute moved there too). Only the rail
// collapse control — the one genuinely rail-specific button — stays, in the
// slim row above the tabs.

// SwarmTab / VoiceTab are no longer mounted here — they render as op-chat
// sidebar faces now (WI-5162); components/chat-faces/ChatFacesHost lazy-loads
// them. The files stay where they are: only their HOST moved.
// (🌐 Pots is no longer mounted here — the tab was REMOVED from this rail on
// 2026-08-10 by owner directive, and `PotsTab.tsx` has since been DELETED (P-077).
// The two surfaces it hosted that are NOT retired tier code — `PotFederationStatus`
// and the p2p roster, both readers of the SHARED POT SUBSTRATE that D-003 says
// SURVIVES the retirement — were re-homed into Workspace pulse rather than deleted
// with their host; the roster lives in `PotPeerRoster.tsx` now.
// for why that tab is their home. Only the per-pot start/stop control
// (`LocalPotsControl`) went with the tier.)
// 🔑 Accounts — the owner's session-now account override (which Max accounts the fleet
// may use right now), beside Mug as a sibling owner-steering lever (accounts-pool-tab
// P-005; promoted to the LEFTMOST sidebar tab by owner request 2026-06-17).
const AccountsTab = lazy(() => import('./AccountsTab'));
// (👑 Mug steering — the owner's focus/pause controls for the autonomous Mug —
// sat HERE until 2026-08-12. RETIRED with its tier to
// `_retired/mug-kettle-deciders/` by retire-mug-kettle-su-only-2026-08-09
// P-063/D-096, together with the four panels MugTab was the ONLY importer of:
// MugHeartbeat, ModelTiersOverride, ThrottleSection, AutonomySurfacing. The
// panel's controls all wrote `pot:set-steering` for a tier that cannot run.
// Its siblings PotSteeringTree + useModelOverride are KEPT per P-064 and are
// now unmounted — see D-095.)
// (👁 Overwatch — the Kettle's actionable panel — sat HERE until 2026-08-11.
// RETIRED with its tier to `_retired/mug-kettle-deciders/` by
// retire-mug-kettle-su-only-2026-08-09 P-059/D-083: the panel's only controls
// were `kettle:start`/`kettle:pause`, which retired in the same slice, so the
// tab could not have done anything even with both its flags forced on.)
// 📣 Sentinel — the always-on, voice-first human-facing companion's
// quick live-override settings (audience mode, voice, proactive nudges, DND). The
// sidebar is the quick live-override surface; full workspace settings hold the
// defaults. Flag-gated (PAPERCUP); hidden until the role is live.
const PapercupTab = lazy(() => import('./PapercupTab'));
// Workspace pulse — the middle pane now carries live attention and handoffs,
// not a second automation catalog. Its shortcuts preserve HUD, Health, shared
// federation, peer-roster, and Ask-an-agent access; schedules, controls, history,
// and spend live in the full-width /adv Automations tab.
const WorkspacePulseTab = lazy(() => import('./WorkspacePulseTab'));
// 💬 Conversations — the curated conversation stream (Q&A, group decisions,
// agent chats, work-item mail) at rail width (WI-5754, owner ask 2026-07-25).
// It is the SAME four SSE-cached reads /adv's Conversations tab consumes — see
// components/conversations/unified-conversations for the shared composition —
// re-laid-out as a single drill-in column. Reading only: composing a question
// lives in Workspace pulse (AskAgentPane), so the rail has exactly one place to
// ask and one place to read.
const ConversationsTab = lazy(() => import('./ConversationsTab'));
// (The 🎯 Goals tab is REMOVED from this rail — owner directive 2026-08-09,
// verbatim: "remove the goals middle pane tab entirely. We already have a goals
// tab inside the hud tab lets just use that." It shipped here two days earlier
// under goal-mode-2026-08-07 P-019/D-018, which argued the rail was the right
// home because a goal is what the neighbouring Mug/Overwatch agents are
// supervised against. The owner's correction supersedes D-018: the HUD's Goals
// tab (apps/operator/app/adv/hud, `?hudtab=goals`) is now the ONE goals surface,
// and two boards reading the same `goals.list` was the duplication to cut.
//
// `goal` joins `blender`, `docs` and `tasks` as a RETIRED tab id: a stale
// `?lst=goal` deep link now falls through to the default tab. This was a
// REMOVAL FROM THE MIDDLE of the array, so unlike the append-only additions
// every tab after it shifts left by one — the pinned order test is what proves
// nothing else moved relative to its neighbours.
//
// ⚠ CARRIED DEBT: GoalTab owned the product's ONLY "Start a goal" affordance
// (it seeded the chat kickoff draft that leads to the goals:propose confirm
// card). The HUD renders that confirm card but has no kickoff of its own, so
// until the button is relocated there is no UI path to STARTING a goal — only
// to viewing one. Tracked as the first item of goals-tab-improvement-2026-08-09.
// (The 📥 Inbox tab (EI-13037) MOVED to the op-chat sidebar — owner placement
// correction 2026-07-16: this middle rail is the SETTINGS surface; the far-left
// papercup-chat sidebar is the live surface. See _components/inbox/InboxPane.)

// `tip` is the hover tooltip (owner ask 2026-06-23) — a one-line "what is this
// tab for", surfaced via the button's native `title` on hover.
//
// label/tip are BUILDERS of the active lexicon `t` (restore-pot-lexicon P-005):
// brand nouns resolve through the flag-gated pack — classic/public shows Pot,
// Brain, Operator, Fleet; the-hive skin shows Hive, Queen, Sentinel, Colony.
// Overwatch has no TermKey (D-002) so it stays literal in both packs.
// ORDER IS OWNER-SET (Automations consolidation 2026-08-22):
// Accounts · Papercup · Pulse. The owner read the
// rail left-to-right as "who am I / what am I running / who talks to me"
// (Accounts → Pots → Papercup) before the autonomous machinery (Mug → Kettle → the
// scheduled-work surfaces). Those catalogs now live in the workspace-wide
// Automations main tab; Pulse is their live-attention replacement here.
// Tab IDS ARE FROZEN — `?lst=<id>` deep links, ui:dispatch, and the collapsed rail
// buttons key on them — so reordering only moves array entries; never rename an id
// to match a new position. (`blender` and `docs` are RETIRED ids: their panes were
// dissolved into the Agents/System split, which was itself replaced by the
// full-width Automations tab. A stale `?lst=blender` deep link now
// falls through to the default tab rather than resolving.)
const TABS = [
  { id: 'accounts', label: (_t: BoundLexicon) => 'Accounts', icon: KeyRound, tip: (_t: BoundLexicon) => 'Provider accounts & API keys your agents sign in with', render: (a: boolean) => <AccountsTab active={a} /> },
  // (The Fleet + Peers tabs MOVED to the op-chat sidebar — owner ask 2026-07-17
  // (WI-5162): they now sit right of the 🎯 Pot Health "kettle" button as faces
  // of the far-left live surface, alongside the Inbox that moved there the day
  // before (EI-13037). Same panes (SwarmTab / VoiceTab), composed for the
  // sidebar in components/chat-faces/ChatFacesHost. This middle rail keeps the
  // SETTINGS/steering surfaces.)
  // (🌐 Pots sat HERE, right of Accounts, from 2026-07-25 to 2026-08-10. REMOVED
  // on owner directive [owner 2026-08-10, verbatim: "Remove the 'Pots' tab
  // from the middle pane."]. `hives` joins `blender`, `docs` and `tasks` as a
  // RETIRED tab id — a stale `?lst=hives` deep link now falls through to the
  // default tab.
  //
  // DELETED rather than flag-gated, unlike the Convos entry below: the owner
  // asked for removal, not "behind a testing flag" (his words for Convos).
  // `PotsTab.tsx` itself is now deleted too (P-077), but NOT its contents: the
  // federation panel and the p2p roster were SURVIVING shared-pot substrate
  // (D-003/D-069) whose only surface this tab was, and both are now re-homed into
  // Workspace pulse. `LocalPotsControl` is the one part
  // that went with the tier: adv/PotsRunningPill (P-075) and this tab were its
  // only two mounts, so D-070's deferred deletion landed with P-077.)
  // Cup-cast nav icons (restore-pot-lexicon D-006): Papercup→CupSoda 🥤.
  // classic labels flow from the lexicon.
  // (Two siblings retired with their tabs, each taking its lucide import with
  // it: Kettle→Thermometer on 2026-08-11 — P-059/D-083 — and Mug→Coffee ☕ on
  // 2026-08-12 — P-063/D-096.)
  { id: 'sentinel', label: (t: BoundLexicon) => t('operator'), icon: CupSoda, tip: (t: BoundLexicon) => `${t('operator')} — your voice/text front-door agent; talks, suggests, and hands work to the ${t('brain')}`, render: (a: boolean) => <PapercupTab active={a} /> },
  // (☕ Mug/`queen` — the owner's steering tab, and the DEFAULT-OPEN leftmost
  // tab since 2026-06-15 — sat HERE until 2026-08-12. RETIRED with its tier by
  // P-063/D-096, exactly the way the Kettle entry below went: removing the
  // entry IS the retirement, because TabId and TAB_IDS are both DERIVED from
  // this array, so 'queen' leaves the type — making any stale
  // `tab === 'queen'` a compile error rather than dead code — and leaves the
  // nuqs parser, which rejects `?lst=queen` back to the default tab.
  // ⚠ That default MOVED to 'accounts' in this same change (see the `lst`
  // parser below): a static 'queen' default would no longer typecheck, and a
  // first load with no `?lst` would otherwise land on a tab that is gone.)
  // (👁 Kettle/overwatch sat HERE until 2026-08-11 — RETIRED with its tier by
  // P-059/D-083. Removing the entry is what retires it: TabId and TAB_IDS are
  // both DERIVED from this array, so the id leaves the type (making any stale
  // `tab === 'overwatch'` a compile error rather than dead code) and leaves the
  // nuqs parser, which rejects `?lst=overwatch` back to the default tab.)
  // (🎯 Goals sat HERE, between Kettle and Agents, from 2026-08-07 to 2026-08-09.
  // Removed on owner directive — see the note above the imports. The HUD's Goals
  // tab is the one goals surface now.)
  { id: 'pulse', label: (_t: BoundLexicon) => 'Pulse', icon: Activity, tip: (_t: BoundLexicon) => 'Workspace pulse — live agents, system warnings, handoffs, and shortcuts to the full Workflows, HUD, and Health tabs', render: (a: boolean) => <WorkspacePulseTab active={a} /> },
  // 💬 Conversations sits LAST (owner ask 2026-07-25). Appending rather than
  // inserting keeps the owner-set order of every tab before it untouched — the
  // order is pinned by a test precisely so a later addition can't quietly
  // reshuffle it. Label is "Convos": a 3-column tab cell fits ~8 characters
  // beside its icon at the rail's 300px minimum, and "Conversations" would
  // ellipsise; the pane header carries the full word.
  // The tip names the pane's ACTUAL sources. It previously advertised
  // "questions ... and work-item mail" — both gone: Q&A left the rail with
  // conversations-agent-messages-2026-07-27 D-001, and the work-item mail
  // surface was retired 2026-07-26 (WI-6097). Agent messages replaced them as
  // the pane's highest-volume source, so it leads.
  //
  // FLAG-GATED (CONVERSATIONS_RAIL_TAB, DEFAULT OFF — WI-37561, owner directive
  // 2026-08-09 "put the 'convos' tab in the middle pane behind a testing flag").
  // The entry STAYS HERE, in its owner-set last position, rather than being
  // deleted: `visibleTabs` filters it out at render, so flipping the flag on at
  // /admin/features restores it exactly where the owner put it, and the pinned
  // order test keeps policing that position while the tab is dark. Deleting the
  // entry would have made the flip a code change.
  { id: 'conversations', label: (_t: BoundLexicon) => 'Convos', icon: MessagesSquare, tip: (_t: BoundLexicon) => 'Conversations — agent messages, group decisions and agent chats', render: (a: boolean) => <ConversationsTab active={a} /> },
  // ☎ No Phone tab here — owner directive 2026-08-30, verbatim: "REMOVE THE PHONE
  // BUTTON FROM THE PAPERCUSP APP YOU ADDED IT TO". The phone surface belongs to
  // the SUITE phone app (apps/phone-app, alongside email and calendar), reached
  // from the Portal — not to this operator rail. Do not re-add it here.
  // (The 📊 Tasks tab MOVED to the AdvShell header — owner ask 2026-08-02,
  // WI-6844: "move the location of it from the middle pane to a button on our top
  // bar to the right of the 'agents running' button". It is now TasksRunningPill,
  // the third pill in `pc-advshell__header-status`, beside the two other
  // workspace-wide pills. `tasks` joins `blender`/`docs` as a RETIRED tab id: a
  // stale `?lst=tasks` deep link falls through to the default tab.
  //
  // This supersedes plan decision D-014, which settled where in THIS rail the tab
  // belonged — a question the move makes moot. The reasoning there still holds and
  // is in fact why the pill reads the whole box: Tasks was never pot-scoped, and
  // the header strip is where the other workspace-wide reads already live.)
] as const;

type TabId = (typeof TABS)[number]['id'];
/** Exported so DEEP-LINKERS can be checked against the real tab set: `lst` is
 *  parsed with parseAsStringLiteral(TAB_IDS), so a link writing an id that is not
 *  here is silently rejected and lands on the default tab (see
 *  LearningTab's ARMING_SIDEBAR_TAB — that is how "Open Arming" became a no-op). */
export const TAB_IDS = TABS.map((t) => t.id) as unknown as TabId[];

// Width model — mirrors DevAdminRail's.
const COLLAPSED_WIDTH = 48;
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 384;
const WIDTH_STORAGE_KEY = 'papercusp.leftSidebar.width';

// Chromeless-route detection lives in lib/chromeless-routes (shared with __root
// + DevAdminRail) so the list can't drift per-component.

function widthCeiling(viewportWidth: number): number {
  return Math.max(MIN_WIDTH, Math.floor(viewportWidth * 0.5));
}

function clampWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(widthCeiling(viewportWidth), width));
}

/** Far-left rail resize math: the pointer's viewport x is the rail width. */
export function leftSidebarWidthFromPointer(clientX: number, viewportWidth: number): number {
  return clampWidth(clientX, viewportWidth);
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(wsLocalKey(WIDTH_STORAGE_KEY));
    if (!raw) return DEFAULT_WIDTH;
    return clampWidth(Number(raw), window.innerWidth);
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * @param docked Render as the ONLY content of a pane-sized document instead of
 *   the app's far-left fixed dock (the cloud portal frames `/portal-panes/steering`
 *   as one of its own sidebars — owner ask 2026-09-01). Docked = always open,
 *   fills its frame, no collapse/expand rail, no drag handle, and no
 *   `body.has-left-sidebar` layout reservation (there is no app beside it to
 *   shift). The `?lst=` tab param keeps working so the portal can deep-link a tab.
 */
export default function LeftSidebar({ docked = false }: { docked?: boolean } = {}) {
  const t = useLexicon();
  // ONE useQueryStates group (not two useQueryState hooks): the collapsed
  // rail's icon buttons set open+tab together, and two same-tick writes race
  // through the custom nuqs adapter (each merges over the pre-tick search, so
  // the last writer clobbers the first's key — observed live: lst landed,
  // lsb=false survived). A single setRail() write is atomic.
  const [{ lsb: open, lst: tab }, setRail] = useQueryStates({
    lsb: parseAsBoolean.withDefault(true),
    // Accounts is the default-open tab. It was 'queen' — the Mug steering
    // panel, the owner's call 2026-06-15 — until the Mug tab RETIRED on
    // 2026-08-12 (P-063/D-096). That move was FORCED, not cosmetic:
    // parseAsStringLiteral's default is STATIC and TAB_IDS is derived from
    // TABS, so once the entry went a 'queen' default no longer typechecked.
    // A stale `?lst=queen` now self-heals through the PARSER instead of a
    // snap-back guard — the unknown id is rejected and falls back here — which
    // is the same treatment `?lst=overwatch` has had since P-059/D-083.
    // Accounts is TABS[0] and ungated, so it is also what `active`'s
    // `?? visibleTabs[0]` renders: URL and screen agree with no hand-kept branch.
    lst: parseAsStringLiteral(TAB_IDS).withDefault('accounts'),
  });
  const setOpen = (v: boolean) => void setRail({ lsb: v });
  const setTab = (v: TabId) => void setRail({ lst: v });

  // (The OVERWATCH flag was read HERE to hide the Kettle tab while its role was
  // dark. The tab is now RETIRED outright (P-059/D-083), so there is nothing
  // left to gate and the read is gone. FLAGS.OVERWATCH itself still exists and
  // still gates the live overwatch runtime — cross-monitor.ts, the system-action
  // waker — so this removal is of a CONSUMER, not of the flag.)
  // Papercup is flag-gated too (PAPERCUP, default ON since
  // voice-unified-sentinel-pipeline made Papercup the one voice brain) — same
  // hide-tab + stale-?lst snap-back treatment as overwatch for when it IS off.
  const sentinelOn = useFlag(FLAGS.PAPERCUP);
  // Convos is flag-gated too (CONVERSATIONS_RAIL_TAB) and, unlike the two above,
  // is DEFAULT OFF — an owner-requested testing gate (WI-37561), so the common
  // case is the tab being absent. Same hide-tab + snap-back treatment: the id
  // stays in TAB_IDS (so `?lst=conversations` still PARSES) and this guard is
  // what turns a parsed-but-hidden tab into a landing on Mug instead of a blank
  // body. Without the snap-back, `active` falls through to visibleTabs[0] —
  // Accounts — while `?lst=` still reads `conversations`, so the URL and the
  // rendered tab disagree and ui:get_state reports a tab that is not on screen.
  const conversationsOn = useFlag(FLAGS.CONVERSATIONS_RAIL_TAB);
  // (`queen` (Mug) and `overwatch` (Kettle) were BOTH gated here on
  // FLAGS.MUG_KETTLE_SYSTEM. Both are now retired from TABS entirely — Kettle
  // by P-059/D-083, Mug by P-063/D-096 — so neither needs a gate: a tab that
  // does not exist cannot be resurrected by a flag. FLAGS.MUG_KETTLE_SYSTEM
  // itself STAYS until P-068 — adv/AdvNowRunning.tsx still reads it — so what
  // went here is a CONSUMER, not the flag.)
  const visibleTabs = TABS.filter(
    (x) =>
      (x.id !== 'sentinel' || sentinelOn) &&
      (x.id !== 'conversations' || conversationsOn),
  );
  // Where a hidden tab lands: Accounts — TABS[0], ungated, and now the nuqs
  // default too, which is what `active`'s `?? visibleTabs[0]` already renders.
  // (This read `mugKettleOn ? 'queen' : 'accounts'` while the Mug tab existed;
  // with that tab retired there is only one possible landing, so it is a
  // constant. Kept as a named binding because three gates below read it.)
  const homeTab: TabId = 'accounts';
  useEffect(() => {
    if (!sentinelOn && tab === 'sentinel') void setRail({ lst: homeTab });
    if (!conversationsOn && tab === 'conversations') void setRail({ lst: homeTab });
    // Stale `?lst=queen` and `?lst=overwatch` need no branch of their own: both
    // ids left TAB_IDS when their TABS entries retired (Mug P-063/D-096, Kettle
    // P-059/D-083), so parseAsStringLiteral REJECTS them and `tab` reads the
    // 'accounts' default. Those deep links self-heal through the parser rather
    // than through a guard that has to be kept in sync by hand.
  }, [sentinelOn, conversationsOn, homeTab, tab, setRail]);

  const pathname = usePathname() ?? '';
  const chromeless = isChromelessPath(pathname);

  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);
  const [compactAutoCollapsed, setCompactAutoCollapsed] = useState(false);
  const compactViewportRef = useRef(false);

  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Compact view is presentation-only: keep ?lsb=true intact so leaving compact
  // restores the requested layout. Crossing INTO compact collapses once; an
  // explicit expand clears the local auto-collapse for that compact interval.
  // A docked pane is never collapsed — the portal that frames it owns
  // open/closed, so a collapsed rail inside an already-narrow frame would be
  // a 48px strip of icons the viewer cannot widen.
  const presentedOpen = docked || (open && !compactAutoCollapsed);

  // Reserve left-side layout space (released on chromeless routes, and never
  // in a docked pane — nothing shares that document) so the app docks beside
  // the rail rather than under it.
  useEffect(() => {
    if (!hydrated) return;
    if (chromeless || docked) {
      document.body.classList.remove('has-left-sidebar');
      document.documentElement.style.removeProperty('--left-sidebar-w');
      return;
    }
    const offsetWidth = presentedOpen ? width : COLLAPSED_WIDTH;
    document.documentElement.style.setProperty('--left-sidebar-w', `${offsetWidth}px`);
    document.body.classList.add('has-left-sidebar');
    try {
      window.localStorage.setItem(wsLocalKey(WIDTH_STORAGE_KEY), String(width));
    } catch {
      /* sandbox / quota */
    }
  }, [presentedOpen, width, hydrated, chromeless, docked]);

  useEffect(() => {
    if (!hydrated) return;
    const onResize = () => {
      const viewportWidth = window.innerWidth;
      setWidth((current) => clampWidth(current, viewportWidth));
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

  // Strip the reservation on unmount (HMR / route teardown safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-left-sidebar');
        document.documentElement.style.removeProperty('--left-sidebar-w');
      } catch {
        /* DOM may be torn down already */
      }
    };
  }, []);

  // Drag-to-resize from the RIGHT edge. This is now the far-left pane, so its
  // width is the pointer's viewport x directly (no chat offset subtraction).
  const draggingRef = useRef(false);
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setWidth(leftSidebarWidthFromPointer(e.clientX, window.innerWidth));
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  // A chromeless route is a bare embedded document — unless THIS render is the
  // docked pane document itself (/portal-panes/steering is chromeless so that
  // no other chrome mounts around the rail).
  if (chromeless && !docked) return null;

  const renderedWidth = docked
    ? '100%'
    : presentedOpen ? (hydrated ? width : DEFAULT_WIDTH) : COLLAPSED_WIDTH;
  const active = visibleTabs.find((x) => x.id === tab) ?? visibleTabs[0];

  return (
    <>
      <style>{LEFT_SIDEBAR_CSS}</style>
      <TooltipPrimitive.Provider delayDuration={250}>
        <aside
          className={`pclsb${docked ? ' pclsb--docked' : ''}`}
          data-testid="left-sidebar"
          data-collapsed={presentedOpen ? 'false' : 'true'}
          data-docked={docked ? 'true' : undefined}
          data-tab={active.id}
          style={{ width: renderedWidth }}
          // Was "<Fleet> sidebar" — stale once the Fleet tab moved out
          // (WI-5162); this rail holds the steering/settings tabs now.
          aria-label={`${t('pot')} steering sidebar`}
        >
        {/* Collapsed: the expand control on TOP — the mirror of the collapse
            chevron (re-expands to the LAST pane, no tab switch; owner ask
            2026-07-14) — then the tab icons, each of which expands straight
            INTO its own tab. */}
        <div className="pclsb__expand-rail" aria-hidden={presentedOpen}>
          <Tooltip label="Expand sidebar" side="right">
            <button
              type="button"
              className="pclsb__rail-btn pclsb__rail-btn--expand"
              data-testid="left-sidebar-rail-expand"
              onClick={() => {
                setCompactAutoCollapsed(false);
                setOpen(true);
              }}
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
          </Tooltip>
          {visibleTabs.map((x) => {
            const Icon = x.icon;
            return (
              <button
                key={x.id}
                type="button"
                className={`pclsb__rail-btn pclsb__rail-btn--${x.id}`}
                data-testid={`left-sidebar-rail-${x.id}`}
                aria-label={`Open ${x.label(t)}`}
                onClick={() => {
                  setCompactAutoCollapsed(false);
                  void setRail({ lsb: true, lst: x.id });
                }}
              >
                <Icon size={17} aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <div className="pclsb__expanded-shell" aria-hidden={!presentedOpen}>
          {presentedOpen && (
            <>
              {/* WI-4740: the voice-controls bar that lived here is retired —
                  its buttons duplicated the chat sidebar's header controls.
                  Only the rail-specific collapse control remains. */}
              <div className="pclsb__collapse-row">
                <Tooltip label="Collapse sidebar" side="right">
                  <button
                    type="button"
                    className="pclsb__collapse-btn"
                    onClick={() => setOpen(false)}
                    aria-label="Collapse sidebar"
                  >
                    <PanelLeftClose size={15} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>

              <div className="pclsb__tabs" role="tablist">
                {visibleTabs.map((x) => {
                  const Icon = x.icon;
                  const isActive = x.id === tab;
                  return (
                    // The per-tab tip is an owner ask (2026-06-23) and is PRESERVED
                    // verbatim — only its delivery moved from a native `title=` to the
                    // shared Tooltip primitive (design-simplification P-009), which the
                    // design lint requires. Radix's Provider/Root render no DOM and the
                    // trigger renders the button itself, so `role="tablist" > role="tab"`
                    // is unchanged.
                    <Tooltip key={x.id} label={x.tip(t)} side="right">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className={`pclsb__tab pclsb__tab--${x.id}${isActive ? ' is-active' : ''}`}
                        data-testid={`left-sidebar-tab-${x.id}`}
                        onClick={() => setTab(x.id)}
                      >
                        <span className="pclsb__tab-icon">
                          <Icon size={14} aria-hidden="true" />
                        </span>
                        <span className="pclsb__tab-label">{x.label(t)}</span>
                      </button>
                    </Tooltip>
                  );
                })}
              </div>

              <div className="pclsb__body">
                <Suspense fallback={<div className="pclsb-panel__empty">Loading…</div>}>
                  {active.render(true)}
                </Suspense>
              </div>
            </>
          )}
        </div>

          <div
            className="pclsb__resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          />
        </aside>
      </TooltipPrimitive.Provider>
    </>
  );
}
