'use client';

/**
 * HudView — the data half of /adv/HUD (adv-hud-fleet-board-2026-07-25 P-004).
 *
 * Owner ask, 2026-07-25: "I want the sessions to show up there whether or not
 * they are launched with the new session button or if they are launched with the
 * psu utility." That is satisfied structurally rather than by special-casing:
 * this view reads `advRoster.list`, which is PRESENCE-PRIMARY — coord_presence
 * is the roster and adv_sessions is only a LEFT-joined enrichment, so an agent
 * with no launch record still appears. Every psu session heartbeats presence on
 * each tool call, so it lands here with no launch-path-specific code.
 *
 * REUSE, not re-derivation:
 *   - roster: the SAME `advRoster.list` sync query the Sessions roster reads
 *     (shared cache entry, SSE-invalidated on any adv_sessions write);
 *   - asks: the SAME `plans.attention` feed + `scopeInboxItems` narrowing the
 *     inbox uses — the board never invents a second asks pipeline, so an item
 *     answered here and an item answered in the inbox are the same item;
 *   - conversation: the EXISTING `SessionChatModal`. Clicking a card opens the
 *     agent's real transcript with a live composer; no second chat renderer.
 *
 * State lives in the URL (nuqs) per the repo's nuqs-by-default policy, so the
 * board is deep-linkable and agent-driveable via ui:get_state / ui:dispatch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import { parseAsArrayOf, parseAsBoolean, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import SessionChatModal from '@/app/_components/chat/SessionChatModal';
import { PLAN_DASHBOARD_PARAM } from '@/app/_components/plans/PlanDashboardHost';
import { encodeScopedRef } from '@/app/_components/chat/chat-ref-popup-params';
import WorkItemPopupModal from '@/app/_components/work-items/WorkItemPopupModal';
import { scopeInboxItems, useInboxAttention } from '@/app/_components/inbox/use-inbox-pending';
import { Modal } from '@/app/harness/Modal';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import NewSessionLauncher from '@/app/adv/sessions/NewSessionLauncher';
import { usePlanList } from '@/app/admin/plans/plans-api';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { hudLaunchOpenDecision } from './hud-launch-open';
import HudBoard from './HudBoard';
import HudEntityColumns from './HudEntityColumns';
import GoalComposer from './GoalComposer';
import GoalDetailPanel from './GoalDetailPanel';
import GoalStatusControl from './GoalStatusControl';
import GoalPackagesRail, { type GoalPackageRailEntry } from './GoalPackagesRail';
import {
  goalsTruncationNotice,
  hudHarnessScopeArgs,
  isHudSessionInPotScope,
  isInHudPotScope,
  workItemIdForCard,
  type HudEntityCard,
  type HudPotScope,
} from './hud-entity-board';
import { advRosterArgs } from '@/lib/adv-roster-args';
import {
  ALL_FLEETS,
  ALL_PLANS,
  NO_PLAN_TOKEN,
  buildHudBoard,
  matchesSessionText,
  reconcileBoardIdentity,
  searchHitAnchor,
  HUD_COLUMNS,
  type HudAsk,
  /* Aliased: `HudBoard` is already the default-imported COMPONENT above, and
     the collision is invisible to vitest (which does not typecheck). */
  type HudBoard as HudBoardData,
  type HudColumnId,
  type HudRosterEntry,
  type HudSearchHit,
  type HudHiddenMachineHits,
  fetchTranscriptSearch,
} from './hud-board-model';
/* WI-37204 — the SAME id parser + field matcher the server's id leg runs
   (GET /adv/sessions/search-transcripts). Importing it rather than re-spelling
   the shapes here is what keeps "is this query an id?" from drifting between
   the instant client pass and the server pass, which would show up as the board
   and the transcript results disagreeing about whether an id matched anything.
   Safe in a browser bundle: adv-session-search is pure TS with no server-only
   dependencies. Its one runtime import (WI-37883) is
   `agent-tools/coordination/owner-chat-turn`, a deliberate ZERO-IMPORT leaf —
   documented as such in its own header and kept that way precisely so client
   code can share it. Everything else it imports is type-only and erases.
   ⚠ Keep it that way: a value import of anything that reaches node:fs/node:path
   from this module white-screens the whole route, which is the recurring
   ":3055 route error" class, not a build warning. */
import {
  matchSessionIdField,
  parseSessionIdQuery,
} from '@papercusp/operator-core/lib/adv-session-search';
import {
  buildGoalBoard,
  buildPlanBoard,
  buildWorkItemBoard,
  HUD_DEFAULT_TAB,
  HUD_DEFAULT_PLAN_SORT,
  HUD_ENTITY_COLUMNS,
  HUD_PLAN_SORTS,
  HUD_TABS,
  HUD_WORK_ITEM_FETCH_STATES,
  rollUpStateCounts,
  type HudEntityColumnId,
  type HudGoalInput,
  type HudPlanAgent,
  type HudPlanInput,
  type HudTabId,
  type HudWorkItemInput,
} from './hud-entity-board';

/** The roster payload shape (advRoster.list). Inlined, never imported from the
 *  server module — importing it would drag PG/node builtins into the SPA bundle
 *  (the operator-vite blank-page failure mode). The endpoint JSON is the contract. */
interface RosterPayload {
  active: HudRosterEntry[];
  pending?: HudRosterEntry[];
  /** WI-6376: terminal-spawned psu launches inside their boot window, already
   *  deduped server-side against `active`. A separate tier from `pending`
   *  because the pui panes that one and these sessions own a terminal already. */
  starting?: HudRosterEntry[];
}

/** The board re-derives ages from a clock; without a tick, a card would say
 *  "blocked 2m" an hour later. 15s is fine — every age is rendered at
 *  minute-or-coarser granularity, so a faster tick would only cost renders. */
const CLOCK_TICK_MS = 15_000;

/** Work-item CARDS pulled per status (P-004). 12 statuses × 40 ≈ 480 rows —
 *  about what the old single 500-row window cost, but spread so every column is
 *  actually represented instead of whichever statuses happened to be touched
 *  most recently. The board renders at most
 *  HUD_ENTITY_DEFAULT_MAX_PER_COLUMN (60) per column regardless; counts come
 *  from the store-wide aggregate, so under-fetching a column understates no
 *  number, it only means more of it sits behind "+N more". */
const WORK_ITEM_PER_STATE = 40;

/** Deadline for the transcript-search round-trip (WI-7344).
 *
 *  Sized from measurement, not taste: the endpoint's steady state is ~0.2-0.5s
 *  and its cold tail a few seconds, so 20s is far outside normal while still
 *  leaving a genuinely loaded operator room to answer. Without ANY deadline a
 *  server-side stall showed as a permanently-spinning "still searching
 *  transcripts…" — the owner's 2026-08-03 report. */
const SEARCH_TIMEOUT_MS = 20_000;


/* The "all fleets" sentinel is imported from hud-board-model, not re-declared:
   HudBoard raises it and this file compares against it, and while each spelled
   the literal out separately the two drifted (HudBoard's leading space became a
   raw NUL byte, so this comparison never matched). One definition, imported. */

export default function HudView({
  workspaceId = null,
  potScope,
}: {
  workspaceId?: string | null;
  potScope?: HudPotScope;
}) {
  // Legacy/direct mounts remain workspace-wide. The live /adv route always
  // passes the shell's resolved scope structurally.
  const scopedHarnessSlugs = potScope?.harnessSlugs ?? null;
  const scopeReady = potScope?.ready ?? true;
  const [focusColumn, setFocusColumn] = useQueryState(
    'hudcol',
    parseAsStringLiteral(HUD_COLUMNS),
  );
  const [fleetParam, setFleetParam] = useQueryState(
    'hudfleet',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  /* P-004 — the plan axis. An ARRAY param like `hudfleet`, not a scalar, so the
     two filters have one URL contract rather than two: the model already takes
     `plans` as an array (same shape as `fleets`), and a later multi-select
     control would then be a control change with no URL migration. */
  const [planParam, setPlanParam] = useQueryState(
    'hudplan',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [allAgents, setAllAgents] = useQueryState(
    'hudall',
    parseAsBoolean.withDefault(false),
  );
  const [openOwner, setOpenOwner] = useQueryState('hudsession', parseAsString);
  // `agentConversation` is the portal bridge's companion key for the same
  // conversation. Both keys are written when a Portal inspector opens this
  // popup, so closing it must clear both or a reload can resurrect a stale
  // conversation target even though `hudsession` is gone.
  const [, setConversation] = useQueryState('agentConversation', parseAsString);
  /* Which turn the modal should open ON — the text of the search match that
     put this card on screen (owner ask 2026-08-02, part b).

     nuqs, not useState, and deliberately so: it is user-meaningful (it changes
     what the modal shows), it must survive the reload/share the `hudsession`
     param already survives, and — the repo rule that settles it — anything in
     useState is invisible to the agent UI control surface (`ui:get_state` /
     `ui:dispatch` read the URL). TEXT rather than a turn index because the
     search index and the modal's transcript are different stores; see
     `searchHitAnchor`. */
  const [openFocus, setOpenFocus] = useQueryState('hudfocus', parseAsString);
  /* The matched turn's timestamp, sent on to the transcript route as
     `anchorTs`. Carried SEPARATELY from the text because the two do different
     jobs: the text is what marks and scrolls to the row client-side, the
     timestamp is what makes the server return a window containing that turn at
     all. A session with many matches needs it — the search orders newest-first,
     so without a timestamp the route anchors on the LAST match rather than the
     one whose excerpt is on the card you clicked. */
  const [openFocusTs, setOpenFocusTs] = useQueryState('hudfocusts', parseAsString);
  /* The SEARCH TERM that produced the hit, snapshotted at click time.
     Sent to the transcript route as `find`.

     It has to be the short user term and NOT the excerpt text, and that is a
     correction from measurement rather than a preference: `find` is matched by
     `entryMatches` with a plain case-insensitive `includes` against the RAW
     entry text, while the excerpt comes from `ts_headline`, which reflows the
     source — every hard newline arrives as a single space. So a long excerpt
     substring essentially never matches the raw entry, the collector finds
     nothing, and the route falls back to the tail while the stream still
     reports an anchor. Measured live 2026-08-02: passing the excerpt as `find`
     anchored on message 0, which did NOT contain the matched text.

     Snapshotted rather than read live off `hudsq` so that editing the search
     box while the modal is open cannot silently re-stream the transcript
     underneath it. */
  const [openFocusQ, setOpenFocusQ] = useQueryState('hudfocusq', parseAsString);
  /* The SESSION the matched turn actually lives in — and the reason the whole
     feature could not work without it.

     Search is OWNER-scoped across an agent's entire carry-respawn CHAIN
     (`session_turns` rows for one ownerId span every session it ever ran),
     while the modal is SESSION-scoped: `resolveOwnerClaudeSession` returns the
     owner's LATEST session and the route streams THAT transcript file. So a
     hit from any earlier link in the chain is simply not in the file being
     streamed, and no amount of anchoring can find it.

     Measured 2026-08-02 on su-1c1faa38: 10+ distinct session_ids for that one
     owner; the resolved session covered 20:46–22:56Z while the clicked hit's
     turn was at 03:18Z, in a different session entirely. The route dutifully
     anchored on the first term-matching entry of the file it DID have, which
     is how this surfaced as a confident scroll to the wrong turn.

     `HudSearchHit.sessionId` already carries the right answer — it was being
     dropped on the floor. */
  const [openFocusSid, setOpenFocusSid] = useQueryState('hudfocussid', parseAsString);
  // WI-6367: which session THIS view just launched, and when. Deliberately
  // useState, not nuqs: it is mid-flight lifecycle state, not user-meaningful
  // (a shared/reloaded URL must not claim a session is "starting up" — by then
  // it either registered or failed, and both read correctly without this).
  const [pendingLaunch, setPendingLaunch] = useState<{ ownerId: string; startedAtMs: number } | null>(
    null,
  );

  /* P-009 — the board's tab axis, and the two controls the non-session tabs
     need. All three in the URL per the repo's nuqs-by-default policy: which
     board you are looking at is exactly the "reasonably user-meaningful state"
     that has to be deep-linkable and reachable from ui:get_state/ui:dispatch. */
  const [tab, setTab] = useQueryState(
    'hudtab',
    // HUD_DEFAULT_TAB, not HUD_TABS[0]: goals is leftmost but sessions is still
    // where the HUD lands (see the constant's docblock — the two are pinned
    // separately so adding a tab cannot silently move the landing tab).
    parseAsStringLiteral(HUD_TABS).withDefault(HUD_DEFAULT_TAB),
  );
  const [entityColumn, setEntityColumn] = useQueryState(
    'hudecol',
    parseAsStringLiteral(HUD_ENTITY_COLUMNS),
  );
  // Separate from the sessions board's own filter state: `hudcol` is typed to
  // the SESSION column ids and shares none of its members with the entity
  // columns (`ready`/`done`), so one param cannot serve both without silently
  // dropping a value on every tab switch.
  const [entityQuery, setEntityQuery] = useQueryState(
    'hudq',
    parseAsString.withDefault(''),
  );
  /* `hudpsort` — the Plans board's sort axis (plan-visibility-revamp-2026-08-23
     P-006, D-004: "add a sort picker (default: last work)"). Its own param, not
     folded into `hudq`/`hudecol`, because it is a third independent control; in
     the URL per the nuqs rule — which ordering the board is in is exactly the
     state an agent reads back through ui:get_state. */
  const [planSort, setPlanSort] = useQueryState(
    'hudpsort',
    parseAsStringLiteral(HUD_PLAN_SORTS).withDefault(HUD_DEFAULT_PLAN_SORT),
  );
  /* `hudgoal` — the SELECTED goal (goal-mode-2026-08-07 P-020). A goal id, or
     null for none. It is what the Goals tab highlights and what P-021's detail
     view opens on.

     ⚠ SELECTION, not yet a cross-tab FILTER — and that limit is deliberate, not
     an oversight. Filtering Sessions/Plans/Work-items by goal needs `goalId` on
     those wire rows, and today it is stamped on `work_items` only (P-016) while
     the read path that ships those rows — listIssues → listWorkItems →
     listEnrichedWorkItems → `workItems.byHarness` — does not carry the column.
     Threading it is a real data-layer change through two shared type layers and
     a perf-tuned query, so it is its own work-item rather than something to
     half-do here.

     A param that LOOKS like a filter but silently filters nothing is the worst
     of the three options — the board would appear scoped while showing
     everything — so this one is honestly named and honestly scoped until the
     column lands.

     In the URL per the nuqs-by-default rule, and here that is load-bearing
     rather than ceremonial: "select this goal" is precisely the camera move an
     agent needs to make on the owner's behalf via ui:dispatch, and anything in
     useState is invisible to it. */
  const [goalFilter, setGoalFilter] = useQueryState('hudgoal', parseAsString);
  /* P-015 — the "+ Start a goal" composer's open-state. A SEPARATE param from
     `hudgoal` on purpose: `hudgoal` names an EXISTING goal (the board's
     selection and the detail panel's subject), and the composer's subject is a
     goal that does not exist yet. Folding them would make "which goal is on
     screen" unanswerable at exactly the moment the answer is "none, we are
     making one". In the URL per the repo's nuqs rule — dialog open-state is
     user-meaningful state, and the agent control surface reads the URL. */
  const [goalComposerOpen, setGoalComposerOpen] = useQueryState(
    'hudgoalnew',
    parseAsBoolean.withDefault(false),
  );

  /* The SESSIONS board's own search (owner ask 2026-07-26). Separate param from
     `hudq`: that one filters the entity tabs' loaded rows, this one searches
     something the roster payload does not even contain, and sharing a param
     would drop a value on every tab switch (same reasoning as `hudecol`). */
  const [rawSessionQuery, setSessionQuery] = useQueryState(
    'hudsq',
    parseAsString.withDefault(''),
  );
  const sessionQuery = useDebouncedValue(rawSessionQuery, 300);

  // Ticking clock so relative ages stay honest between roster pushes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const roster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: advRosterArgs(workspaceId),
  });

  /**
   * Owner ask 2026-07-27: "when you click +new session the gui chat with them
   * should show up". The launcher hands back the `adv_sessions` id it just
   * recorded; the chat is keyed by ROSTER OWNER ID.
   *
   * WI-6363: that owner id is now known AT LAUNCH — `launch-su` pre-pins it via
   * `psu --owner-id=` and returns it — so the launch handler sets `hudsession`
   * directly (see `headerAction` below) and there is nothing to park here.
   *
   * This deliberately does NOT wait for the roster to carry a row first. The
   * previous version parked an `advSessionId` and resolved it against the roster,
   * which could never fire: on the terminal path launch-su records no
   * adv_sessions row at all, so the id was always null. Opening the chat straight
   * away is also the better behaviour — the modal is a live sync surface, so it
   * populates as the session boots rather than making the human wait for it.
   */

  const attention = useInboxAttention();

  /** The asks addressed to the human, narrowed by the SAME scoping the inbox
   *  applies. Without it the raw attention feed is the whole ~15-source
   *  firehose (the "328" bug) and every agent would look like it needs you.
   *
   * hud-consolidation-2026-07-26 P-002: this INCLUDES items with no
   * `ownerAgentId` (previously filtered out here) — `buildHudBoard` splits
   * them into `board.unattributed` on its own (`asksByOwner` already ignores
   * the ownerless ones for per-session columns, so this is additive, not a
   * behavior change to the existing needs-you column). See HudAsk's doc for
   * why an ownerless Decision is structural, not an edge case. */
  const asks: HudAsk[] = useMemo(() => {
    const scoped = scopeInboxItems(attention.items ?? []);
    return scoped
      .filter((i) => i.needsHuman && isInHudPotScope(i.harnessSlug, scopedHarnessSlugs))
      .map((i) => ({
        ownerAgentId: i.ownerAgentId,
        title: i.title,
        occurredAt: (i as { occurredAt?: string | null }).occurredAt ?? null,
        id: i.id,
        kind: i.kind,
        itemRef: i.itemRef,
        planSlug: i.planSlug,
        harnessSlug: i.harnessSlug,
        // WI-6742: the STRUCTURED destination. Carried through the slimming
        // (ui-read-projection clips `body` but retains both `ref` and the small
        // action descriptors), so routing needs no extra fetch.
        ref: (i as { ref?: { kind: string; slug?: string | null } | null }).ref ?? null,
      }));
  }, [attention.items, scopedHarnessSlugs]);

  const entries: HudRosterEntry[] = useMemo(() => {
    const payload = roster.data?.[0];
    if (!payload) return [];
    // Pending launches are recorded-but-not-started sessions; they belong on the
    // board (they are real, the human asked for them) and classify as `needs-you`
    // — owner ask 2026-07-27, "all fresh sessions start as needs you". They used
    // to land in `parked`; see deriveColumn step 1c for why that was backwards.
    //
    // `starting` is the same argument for the OTHER launch path (WI-6376): a
    // terminal-spawned psu session is equally real and equally the human's, and
    // before this tier existed it appeared in no column for its whole boot
    // window. Already deduped against `active` server-side.
    return [...(payload.active ?? []), ...(payload.pending ?? []), ...(payload.starting ?? [])]
      .filter((entry) => isHudSessionInPotScope(entry, scopedHarnessSlugs, rawSessionQuery));
  }, [roster.data, scopedHarnessSlugs, rawSessionQuery]);

  // `null` in the URL array marks the solo group — encoded as the literal
  // "solo" because a URL array cannot carry a null.
  const selectedFleets = useMemo(
    () => fleetParam.map((f) => (f === 'solo' ? null : f)),
    [fleetParam],
  );

  /* The no-plan group travels as NO_PLAN_TOKEN for the same reason the solo
     fleet travels as "solo": a URL array cannot carry a null. Unlike the fleet
     path, the token has exactly one definition (see NO_PLAN_TOKEN's docblock)
     — it is imported here, not re-spelled. */
  const selectedPlans = useMemo(
    () => planParam.map((p) => (p === NO_PLAN_TOKEN ? null : p)),
    [planParam],
  );

  /* ── Sessions transcript search ──────────────────────────────────────────
     The owner asked for the entity tabs' filter on the Sessions tab, searching
     the FULL TURN HISTORY of every returned session — not the roster metadata.
     That text is not in the roster payload at all, so this cannot be a client
     filter like `hudq`: it reuses the EXISTING
     GET /api/adv/sessions/search-transcripts route (the shared @papercusp/search
     `session_turn` source that also backs the agents pill and `sessions:search`),
     exactly as PlanSessionsTab does — never a forked searcher.

     Matches roll up to ownerIds and filter the roster BEFORE buildHudBoard, so
     the column counts keep describing what is actually on screen — the same
     model-not-view rule the entity boards' search already follows. */
  const [searchOwners, setSearchOwners] = useState<Set<string> | null>(null);
  /** The top transcript match per session — the card excerpt AND the turn the
   *  modal opens on (owner ask 2026-08-02). */
  const [searchHits, setSearchHits] = useState<Map<string, HudSearchHit> | null>(null);
  /* WI-37912: what the owner-visibility filter removed from the page the server
     just returned. Null until a transcript pass answers; cleared on every reset
     and on every failure path alongside `searchHits`, so a stale disclosure can
     never outlive the results it described. */
  const [searchHidden, setSearchHidden] = useState<HudHiddenMachineHits | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  /* The INSTANT half (owner ask 2026-08-02 — see `matchesSessionText`). Keyed on
     the RAW query, not the debounced one: this is the pass that has to land on
     the same frame as the keystroke, exactly like the Work-items pane. The
     transcript pass below stays debounced, because it is the one that costs a
     round-trip. */
  const localOwners = useMemo(() => {
    const q = rawSessionQuery.trim();
    if (!q) return null;
    const out = new Set<string>();
    for (const e of entries) if (matchesSessionText(e, q)) out.add(e.ownerId);
    return out;
  }, [entries, rawSessionQuery]);

  /* WI-37204 — sessions the query ADDRESSES by id rather than describes.
     They are exempt from the board's own narrowing filters (see
     HudBuildOptions.exemptOwners): naming a session by its unique su id or
     session id and getting an empty board because the agent is a non-su cup, or
     sits in a fleet you filtered away earlier, is indistinguishable from the
     search being broken.

     Computed over the FULL roster, not `searchedEntries` — an entry that
     matched by id is in `localOwners` anyway (matchesSessionText covers both id
     fields), so this only ever names sessions that survive the search filter. */
  const idExemptOwners = useMemo(() => {
    const token = parseSessionIdQuery(rawSessionQuery);
    if (!token) return undefined;
    const out = new Set<string>();
    for (const e of entries) if (matchSessionIdField(e, token)) out.add(e.ownerId);
    return out.size > 0 ? out : undefined;
  }, [entries, rawSessionQuery]);

  useEffect(() => {
    const q = sessionQuery.trim();
    // <2 chars is "not searching yet", NOT "no matches" — it must clear the
    // filter rather than empty the board.
    if (q.length < 2) {
      setSearchOwners(null);
      setSearchHits(null);
      setSearchHidden(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    const ctl = new AbortController();
    setSearching(true);
    setSearchError(null);
    /* WI-7344 (owner report 2026-08-03: "searched 'theory' … still showed
       searching transcripts 30 seconds later"). This call had NO deadline, so a
       stalled operator produced a spinner that never stopped — no error, and no
       way to tell a slow answer from a dead one. The root cause that time was
       the desktop operator's event loop blocking in multi-second chunks (git
       fork()s on a single-process host — fixed at its source in
       dev-operator-ifneeded.sh), but the UI must not depend on the server always
       being healthy in order to avoid an infinite spinner.

       The request + response-shaping now live in `fetchTranscriptSearch`
       (hud-board-model) so they are TESTABLE: this component pulls in
       useSyncQuery/useInboxAttention/nuqs and has no render harness, which is
       why its sibling guards resort to regex-ing this file's source. What stays
       here is only what genuinely belongs to the component — the seq guard and
       the state writes.

       A timeout DEGRADES rather than empties: `localOwners` keeps filtering the
       board per keystroke, and an empty (not null) `searchOwners` means "the
       transcript pass matched nothing", which unions correctly with it. */
    (async () => {
      try {
        const outcome = await fetchTranscriptSearch(q, {
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal: ctl.signal,
        });
        if (seq !== searchSeq.current) return; // superseded by a newer keystroke
        if (!outcome.ok) {
          setSearchError(outcome.message);
          setSearchOwners(new Set());
          setSearchHits(null);
          setSearchHidden(null);
          return;
        }
        setSearchOwners(outcome.owners);
        setSearchHits(outcome.hits);
        setSearchHidden(outcome.hiddenMachineHits);
      } catch (e) {
        /* Only a supersede/unmount abort reaches here — fetchTranscriptSearch
           converts a TIMEOUT into an `ok:false, timedOut:true` outcome above
           rather than throwing, precisely so it cannot be mistaken for one of
           these and silently swallowed (which is how a deadline would re-create
           the very hang it was added to fix). */
        if (ctl.signal.aborted || seq !== searchSeq.current) return;
        setSearchError(e instanceof Error ? e.message : 'search failed');
        setSearchOwners(new Set());
        setSearchHits(null);
        setSearchHidden(null);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    })();
    return () => ctl.abort();
  }, [sessionQuery]);

  /* UNION, not intersection: the two passes answer different questions about the
     same session ("does its card say this" vs "did it ever say this"), so a hit
     from either is a hit. Intersecting would make the board NARROW when the
     slow pass returned, i.e. cards would vanish a second after appearing.

     `null` from a pass means "not applicable / nothing yet", never "matched
     nothing" — an empty Set is the real no-match. That distinction is what keeps
     a 1-character query (below the transcript floor) filtering locally instead
     of blanking the board. */
  const searchedEntries = useMemo(() => {
    if (!localOwners && !searchOwners) return entries;
    return entries.filter(
      (e) => Boolean(localOwners?.has(e.ownerId)) || Boolean(searchOwners?.has(e.ownerId)),
    );
  }, [entries, localOwners, searchOwners]);

  /* How many sessions the SLOW pass added that the instant one had not already
     found — the honest measure of what waiting bought you, and what the input's
     status chip reports. A transcript hit that the card text also matched is not
     "+1 transcript": it was already on screen. */
  const transcriptExtra = useMemo(() => {
    if (!searchOwners) return null;
    let n = 0;
    for (const id of searchOwners) if (!localOwners?.has(id)) n += 1;
    return n;
  }, [searchOwners, localOwners]);

  /* WI-6560 — `buildHudBoard` is pure and allocates fresh session objects every
     call, and this memo re-runs on every 15s clock tick. `reconcileBoardIdentity`
     hands back the PREVIOUS object for any session/column/board that is
     structurally unchanged, which is what lets `MemoSessionCard`'s shallow
     compare hold across a tick that did not change what any card renders (see
     the long rationale on the function). Writing the ref during the memo is a
     pure cache: if React discards this render, the next comparison is still
     structural, so the output can never be stale — at most one extra render. */
  const prevBoardRef = useRef<HudBoardData | null>(null);
  const board = useMemo(() => {
    const built = buildHudBoard(searchedEntries, asks, {
      nowMs,
      suOnly: !allAgents,
      fleets: selectedFleets,
      plans: selectedPlans,
      searchHits: searchHits ?? undefined,
      exemptOwners: idExemptOwners,
    });
    const reconciled = reconcileBoardIdentity(prevBoardRef.current, built);
    prevBoardRef.current = reconciled;
    return reconciled;
  }, [searchedEntries, asks, nowMs, allAgents, selectedFleets, selectedPlans, searchHits, idExemptOwners]);

  const onToggleFleet = useCallback(
    (slug: string | null) => {
      if (slug === ALL_FLEETS) {
        void setFleetParam([]);
        return;
      }
      const token = slug ?? 'solo';
      void setFleetParam((prev) =>
        prev.includes(token) ? prev.filter((f) => f !== token) : [...prev, token],
      );
    },
    [setFleetParam],
  );

  /* Single-select: picking a plan REPLACES the selection, the "All plans" row
     clears it. Deliberately not a toggle — re-picking the row you are already
     filtered to reads as "yes, this one", not "undo". */
  const onSelectPlan = useCallback(
    (slug: string | null) => {
      if (slug === ALL_PLANS) {
        void setPlanParam([]);
        return;
      }
      void setPlanParam([slug ?? NO_PLAN_TOKEN]);
    },
    [setPlanParam],
  );

  const openLabel = useMemo(
    () =>
      board.columns
        .flatMap((c) => c.sessions)
        .find((s) => s.ownerId === openOwner)?.label ?? null,
    [board, openOwner],
  );

  /* ── Plans tab ─────────────────────────────────────────────────────────── */

  // The SAME `plans.list` read NewSessionLauncher's plan picker already makes
  // (it renders in this board's header). useSyncQuery dedupes on
  // ['sync', name, args], so this second caller costs one memo, not one fetch —
  // and the two views can never disagree about what plans exist.
  const planList = usePlanList({
    includeArchived: false,
    includeLegacy: true,
    harness_slugs: scopedHarnessSlugs ?? undefined,
    enabled: scopeReady,
  });
  /* ⚒ last-work per plan — the SAME `planWorkActivity.list` feed PlansPane
     already joins by slug for its sidebar timestamps (P-001), reused here as
     the default sort axis (P-006/D-004: "sort picker (default: last work)").
     Gated on the tab because the HUD lands on Sessions; when the left sidebar
     is open too, useSyncQuery dedupes the read on ['sync', name, args].

     ⚠ The workspace fallback mirrors the goals query below: the `workspaceId`
     PROP is nullable, and an omitted workspace is the WI-5125 shape (a
     healthy-looking answer about the wrong tenant). */
  const browserWorkspaceId = useWorkspaceId();
  const activityWorkspaceId = workspaceId ?? browserWorkspaceId;
  const planWorkActivity = useSyncQuery<{ slug?: string; lastWorkAtMs?: number }>({
    queryName: 'planWorkActivity.list',
    args: { workspaceId: activityWorkspaceId },
    enabled: tab === 'plans' && scopeReady,
  });
  /* WHO is on each plan (P-007) — the roster join behind the plan cards'
     avatar stacks, live pills and who-is-doing-what lines. The SAME
     `advRoster.list` payload the Sessions tab renders (fetched above,
     unconditionally), so this is one memo, not one fetch.

     An agent is "on" a plan when it DECLARED it (`currentPlanSlug`) or holds a
     CLAIM on one of its items — both, deduped, because a fleet member routinely
     claims items on a plan it never re-declared. Sessions the oracle says are
     over (`ended`/`recorded`) are excluded: a dead session's stale claim is
     noise on a "who is here now" surface, and the pill counts positive `live`
     verdicts only anyway. */
  const planAgentsBySlug = useMemo(() => {
    const bySlug = new Map<string, HudPlanAgent[]>();
    for (const e of roster.data?.[0]?.active ?? []) {
      if (e.sessionState === 'ended' || e.sessionState === 'recorded') continue;
      const slugs = new Set<string>();
      if (e.currentPlanSlug) slugs.add(e.currentPlanSlug);
      for (const c of e.claims ?? []) {
        if (c?.planSlug) slugs.add(c.planSlug);
      }
      if (slugs.size === 0) continue;
      const agent: HudPlanAgent = {
        ownerId: e.ownerId,
        // Positive verdicts only; an absent sessionState stays UNKNOWN (null),
        // never false — the HudCardIdentity.live rule.
        live: e.sessionState == null ? null : e.sessionState === 'live',
        sessionState: e.sessionState ?? null,
        intent: e.intent?.trim() || null,
      };
      for (const slug of slugs) {
        const list = bySlug.get(slug);
        if (list) list.push(agent);
        else bySlug.set(slug, [agent]);
      }
    }
    return bySlug;
  }, [roster.data]);
  const planInputs = useMemo((): HudPlanInput[] => {
    const rows = (planList.data?.plans ?? []) as HudPlanInput[];
    const bySlug = new Map<string, number>();
    for (const r of planWorkActivity.data ?? []) {
      if (typeof r?.slug === 'string' && r.slug && typeof r.lastWorkAtMs === 'number') {
        bySlug.set(r.slug, r.lastWorkAtMs);
      }
    }
    /* Feeds not answered yet (or genuinely empty): hand the rows through
       untouched. Every plan then has no ⚒ key and no agents, so the last-work
       sort degrades to the fetch order instead of fabricating an ordering from
       a half-loaded join — and re-running this memo when a feed lands re-sorts
       honestly. */
    if (bySlug.size === 0 && planAgentsBySlug.size === 0) return rows;
    return rows.map((p) => ({
      ...p,
      lastWorkAtMs: bySlug.get(p.slug) ?? null,
      agents: planAgentsBySlug.get(p.slug) ?? null,
    }));
  }, [planList.data, planWorkActivity.data, planAgentsBySlug]);
  const planBoard = useMemo(
    () =>
      buildPlanBoard(planInputs, {
        nowMs,
        query: entityQuery,
        sort: planSort,
      }),
    [planInputs, nowMs, entityQuery, planSort],
  );

  /* ── Goals tab (goal-mode-2026-08-07 P-020) ────────────────────────────── */

  // Workspace-scoped, like the goals themselves. Threading the real id rather
  // than leaning on the resolver's `'default'` fallback: an omitted workspace
  // returns zero rows, which renders as a healthy-looking empty board pointed
  // at the wrong tenant (the WI-5125 shape) — and "no goals yet" is a state
  // this board legitimately shows, so it is the hardest place to spot.
  //
  // ⚠ The `workspaceId` PROP is nullable, so it cannot be passed straight
  // through: `goals.list` types the arg as a string, and a null would either be
  // rejected or coerced to the `'default'` tenant — i.e. exactly the failure the
  // paragraph above is guarding against, reintroduced by the guard's own call
  // site. Fall back to the host-injected browser workspace, which is what the
  // rest of the SPA resolves against. (`browserWorkspaceId` is declared up in
  // the Plans-tab section, which needed the same fallback first — one hook call
  // serves both.)
  const goalWorkspaceId = workspaceId ?? browserWorkspaceId;
  const goalsQuery = useSyncQuery<{
    goals: HudGoalInput[];
    /** UNBOUNDED count from the resolver — NOT goals.length, which is capped. */
    totalGoals?: number;
    truncatedByLimit?: boolean;
    /** Installed/bundled goal packages × their instances (P-009,
     *  work-on-everything-goal-2026-08-23). Optional so an older resolver
     *  payload still renders the board — rail absent, never a crash. The shape
     *  is INLINED client-side in GoalPackagesRail (endpoint JSON is the
     *  contract), same rule as RosterPayload above. */
    goalPackages?: GoalPackageRailEntry[];
    portfolioSpendUsd: number;
    portfolioPots: number;
  }>({
    queryName: 'goals.list',
    args: { workspaceId: goalWorkspaceId, ...hudHarnessScopeArgs(scopedHarnessSlugs) },
    enabled: tab === 'goals' && scopeReady,
  });
  const goalBoard = useMemo(
    () =>
      buildGoalBoard(goalsQuery.data?.[0]?.goals ?? [], {
        nowMs,
        query: entityQuery,
      }),
    [goalsQuery.data, nowMs, entityQuery],
  );

  /**
   * The board's one notice line, carrying up to two independent facts.
   *
   * TRUNCATION FIRST: a capped list is a statement about what is MISSING, and a
   * selection message is about what is present. If only one can be read at a
   * glance it must be the one that says the screen is incomplete
   * (EI-20080280064869122).
   *
   * The count comes from the resolver's UNBOUNDED `totalGoals`, never from the
   * rendered array — see goalsTruncationNotice. Note it is deliberately NOT
   * derived from `goalBoard`, whose cards are additionally filtered by the
   * search query: the disclosure is about the QUERY's cap, not about what the
   * local filter hid, and conflating the two would blame the cap for a search.
   */
  const goalNotice = useMemo(() => {
    const payload = goalsQuery.data?.[0];
    const parts = [
      goalsTruncationNotice(payload?.goals?.length ?? 0, payload?.totalGoals),
      goalFilter ? `Selected goal ${goalFilter} — click its card again to deselect.` : null,
    ].filter((s): s is string => !!s);
    return parts.length > 0 ? parts.join(' ') : null;
  }, [goalsQuery.data, goalFilter]);

  /* ── Work items tab ────────────────────────────────────────────────────── */

  // Work items are stored PER HARNESS, so this board is scoped to the active
  // one — the same `slug` the rest of /adv is scoped by, with the same
  // localStorage fallback the Create dock uses. Deliberately not a new picker:
  // a second harness selector on this surface would be a second source of
  // truth for "which harness am I looking at".
  const fallbackHarnessSlug = useResolvedHarnessSlug();
  const harnessSlug = potScope ? potScope.slug : fallbackHarnessSlug;
  const workItemScopeArgs = potScope
    ? hudHarnessScopeArgs(scopedHarnessSlugs)
    : harnessSlug
      ? { harnessSlug }
      : {};
  const workItemScopeUsable = scopeReady && (scopedHarnessSlugs === null || scopedHarnessSlugs.length > 0);
  const workItems = useSyncQuery<HudWorkItemInput>({
    queryName: 'workItems.byHarness',
    // P-004: a FAIR slice per status, not one `updated_ts DESC` window across
    // all of them. The old window (limit 500 of 27,514) held zero of the 45
    // needs-human rows — recently-touched `done` work crowded them out — so the
    // needs-you column rendered no work items while reporting a count. This
    // asks for every status the board maps, bounded, and costs LESS data.
    args: {
      ...workItemScopeArgs,
      states: HUD_WORK_ITEM_FETCH_STATES,
      perState: WORK_ITEM_PER_STATE,
    },
    // Only fetch when the tab is actually showing: this is the heaviest read
    // on the surface and the HUD's default tab is Sessions.
    enabled: tab === 'items' && (potScope ? workItemScopeUsable : Boolean(harnessSlug)),
  });
  /* The counts the board REPORTS come from a store-wide aggregate, never from
     the sampled cards — reusing the existing `workItems.stats` feed rather than
     adding a second counting path. */
  const workItemStats = useSyncQuery<{ state?: string | null; n?: number | null }>({
    queryName: 'workItems.stats',
    args: workItemScopeArgs,
    enabled: tab === 'items' && (potScope ? workItemScopeUsable : Boolean(harnessSlug)),
  });
  const itemTotals = useMemo(
    () => (workItemStats.data ? rollUpStateCounts(workItemStats.data) : null),
    [workItemStats.data],
  );
  const itemBoard = useMemo(
    () =>
      buildWorkItemBoard(workItems.data ?? [], board.unattributed, {
        nowMs,
        query: entityQuery,
        totals: itemTotals,
      }),
    [workItems.data, board.unattributed, nowMs, entityQuery, itemTotals],
  );

  /* ── Card → destination (P-002; plans re-routed by P-007) ───────────────
     Owner ask 2026-07-27: clicking a Plans/Work-items row should open it in a
     popup, "like it works in the plans tab in the left hand side bar".

     PLANS NO LONGER FOLLOW THAT ASK — the newer one supersedes it
     [owner 2026-08-23 interactive: "clicking a plan should open option C from
     the mockup not the full plan"; recorded on plan-visibility-revamp-2026-08-23].
     A plan click now writes `pdash` — the SAME app-pane dashboard takeover
     PlansPane's rows navigate to (P-005/D-002, PlanDashboardHost at the SPA
     root) — so a plan opens identically from the sidebar and the HUD, and the
     full-plan popup is retired on every plan-CLICK path. `pplan` (the popup)
     remains for its other writers (chat ref pills).

     Work items keep their popup + own nuqs key (`hudwi`), distinct from
     OperatorChat's `wpop`/`wppop`, so a popup opened from the HUD and one
     opened elsewhere can coexist instead of fighting over one URL key. Key
     uniqueness inside THIS component is asserted mechanically by
     `app/_lints/nuqs-key-collisions.test.ts` (the `hudplan` filter-axis
     collision that motivated it is documented there). */
  const [, setDashPlan] = useQueryState(PLAN_DASHBOARD_PARAM, parseAsString);
  const [openItemId, setOpenItemId] = useQueryState('hudwi', parseAsString);
  /* WI-6742: the third destination — the ask itself, for the asks that are not
     ABOUT a work item or plan (improvement triage, standing approval, dark-flag
     ratification). nuqs, not useState, like every other popup here; the key is
     asserted unique by app/_lints/nuqs-key-collisions.test.ts. */
  const [openAskId, setOpenAskId] = useQueryState('hudask', parseAsString);

  /* WorkItemPopupModal is harness-scoped, and the board's
     active harness is not a safe stand-in: the Work items tab renders the
     unattributed ASK cards even under `scope=all` with no harness resolved, so
     `harnessSlug` is null exactly when those cards are on screen and the popup
     renders "No harness context for <id>" instead of the item (measured live
     2026-07-28). The ask carries its own harness — read it from there and fall
     back to the board's, mirroring `openPlanRow` above. */
  const openItemHarness = useMemo(() => {
    if (!openItemId) return null;
    const hit = asks.find(
      (a) => workItemIdForCard({ id: `ask:${a.id}`, ref: a.itemRef ?? '' }) === openItemId,
    );
    return hit?.harnessSlug ?? null;
  }, [asks, openItemId]);

  /* The ask behind `hudask`. Read from the SAME scoped feed the cards are built
     from, so a card that is on screen always resolves — and an id that no
     longer matches (the ask was resolved elsewhere, or the URL was pasted into
     a differently-scoped board) yields null and the modal simply stays shut
     rather than opening empty. */
  const openAsk = useMemo(
    () => (openAskId ? (attention.items ?? []).find((i) => i.id === openAskId) ?? null : null),
    [attention.items, openAskId],
  );

  /* Option C (P-007 re-route): a plan card opens the app-pane dashboard
     takeover, never the full-plan popup. The card `id` IS the slug.

     HARNESS-QUALIFIED, exactly as PlansPane writes it (`encodeScopedRef` —
     the `harness::slug` grammar decodeScopedRef expects): PlanDashboard is
     harness-scoped, and a bare slug decodes to a null harness — the same
     "Server: not_found" wrong-harness trap the retired popup documented. The
     row already knows its harness; the board's active harness is the fallback,
     mirroring what the popup mount used to do. */
  const openPlanDashboard = useCallback(
    (slug: string) => {
      const row = (planList.data?.plans ?? []).find((p) => p.slug === slug);
      void setDashPlan(encodeScopedRef(row?.harness ?? harnessSlug, slug));
    },
    [planList.data, setDashPlan, harnessSlug],
  );
  const onOpenPlanCard = useCallback(
    (card: HudEntityCard) => openPlanDashboard(card.id),
    [openPlanDashboard],
  );
  /* Clicking a goal SELECTS it (goal-mode-2026-08-07 P-020): `hudgoal` becomes
     that goal's id, which scopes the other tabs to it and — once P-021 lands —
     is also what opens its detail view.

     ONE param for "the selected goal" rather than a filter param plus a
     separate detail param. Two params would let the board sit filtered to goal
     A while the detail panel shows goal B, and there is no reading of that
     screen that is not a lie about one of them.

     Clicking the SAME goal again clears the selection, so the filter is
     reversible from the card that set it — otherwise the only way out of a
     scoped board is hand-editing the URL. */
  /* P-016 — the per-card pause/resume lever.
     Status comes from the QUERY, not the card model: `HudEntityCard` is a presentational
     projection with no status field, and adding one just to drive a control would put a
     second copy of the goal's state on screen that could disagree with the pill in the
     popup. One store, read twice. */
  const goalStatusById = useMemo(() => {
    const m = new Map<
      string,
      { status: string; effectiveStatus?: string | null; holderLiveness?: string | null }
    >();
    for (const g of goalsQuery.data?.[0]?.goals ?? []) {
      if (g.id) {
        m.set(g.id, {
          status: String(g.status ?? ''),
          effectiveStatus: g.effectiveStatus,
          holderLiveness: g.holderLiveness,
        });
      }
    }
    return m;
  }, [goalsQuery.data]);

  const renderGoalCardAction = useCallback(
    (card: HudEntityCard) => {
      /* The board's one non-goal card carries no status and nothing to steer. Gated on
         the DECLARED intent, never on pattern-matching the id — that re-derivation is
         exactly what WI-6742 fixed. */
      if (card.open?.kind === 'start-goal') return null;
      const goalState = goalStatusById.get(card.id);
      if (!goalState?.status) return null;
      /* CARD variant: the reversible pair only. Closing a goal is a decision that
         belongs in the popup, next to the kill criterion that justifies it. */
      return (
        <GoalStatusControl
          goalId={card.id}
          status={goalState.status}
          effectiveStatus={goalState.effectiveStatus}
          holderLiveness={goalState.holderLiveness}
          variant="card"
        />
      );
    },
    [goalStatusById],
  );

  const onOpenGoalCard = useCallback(
    (card: HudEntityCard) => {
      /* P-015: the board's one non-goal card. Its intent is DECLARED
         (`open.kind`), never re-derived from the id — the WI-6742 lesson from
         the sibling handler below, where pattern-matching an id produced a
         button that rendered fine and did nothing. */
      if (card.open?.kind === 'start-goal') {
        void setGoalComposerOpen(true);
        return;
      }
      void setGoalFilter((prev) => (prev === card.id ? null : card.id));
    },
    [setGoalFilter, setGoalComposerOpen],
  );

  /* P-009: the packages rail opens its instance goal exactly the way clicking
     that goal's own card does — toggle the board selection — so the rail adds
     no second navigation pattern to the tab. */
  const onOpenPackageGoal = useCallback(
    (goalId: string) => {
      void setGoalFilter((prev) => (prev === goalId ? null : goalId));
    },
    [setGoalFilter],
  );
  /* WI-6742 [owner-reported]: clicking a "Needs you" card did nothing, while
     every other column opened a popup.

     This handler used to RE-DERIVE a destination by pattern-matching the card's
     `id`/`ref`. That fails for the ask cards folded into needs-you — and only
     for them, which is why exactly one column was dead: an ask's `ref` is a
     KIND LABEL ("Improvement triage"), so it matched no work-item id and the
     handler returned early. `HudEntityColumns` still rendered the card as a
     `<button>` (board-wide, keyed off `onOpenCard` being supplied, not
     per-card), producing the dead button its own docblock warns about.

     The board now DECLARES the destination on every card it builds, so there is
     nothing to re-derive and no early return to fall through. `card.open` is a
     total function (see HudAskTarget) — an unmapped ref opens the ask itself
     rather than nothing, so a future adapter cannot reintroduce this. */
  const onOpenItemCard = useCallback(
    (card: HudEntityCard) => {
      const target = card.open;
      if (!target) return;
      if (target.kind === 'work-item') void setOpenItemId(target.id);
      // Option C everywhere a click resolves to a PLAN (P-007 re-route): the
      // ask card's plan destination opens the same dashboard takeover the
      // Plans tab and sidebar open — one destination per entity, not per door.
      else if (target.kind === 'plan') openPlanDashboard(target.slug);
      else if (target.kind === 'ask') void setOpenAskId(target.askId);
      /* `start-goal` is the Goals board's own card and never reaches this
         handler — but it is named rather than swept into a trailing `else`,
         because the trailing else is what silently broke when the union grew:
         it read `target.askId` off a member that has none. A named branch turns
         the NEXT addition into a compile error instead of a runtime undefined. */
    },
    [setOpenItemId, openPlanDashboard, setOpenAskId],
  );

  /* WI-6560 — this MUST stay a stable reference, and it is load-bearing in a way
     that is invisible locally. It is the `onOpen` prop of `MemoSessionCard`
     (HudBoard.tsx), so a fresh arrow here changes one prop of EVERY session card
     on EVERY HudView render, and `memo`'s shallow compare then misses on all of
     them. Both row components carry docblocks explaining that their error
     boundary sits INSIDE the memo "so an unchanged row re-renders neither" —
     that saving was inert on the session board for exactly this reason, while
     the entity board got it right (onOpenItemCard / onOpenPlanCard above are
     already useCallback'd, which is why MemoEntityCard's memo does hold).

     On its own this fixes the large class of renders where session data did NOT
     change — work-item/plan data arriving, entity-search typing, opening/closing
     the chat modal, switching tabs — which used to re-render every session card
     for nothing.

     It did NOT, on its own, fix the two paths WI-6560 actually measured: `board`
     is also rebuilt whenever roster data arrives or the 15s clock ticks, and
     `buildHudBoard` allocates new session objects, so the `session` prop churned
     on those renders regardless. `reconcileBoardIdentity` (at the `board` memo
     above) closes that second half by handing back the previous object whenever
     the rebuilt one is structurally identical. Both halves are required: a
     stable `onOpen` with churning `session` objects, or stable sessions with a
     fresh `onOpen` arrow, each leaves the memo missing on every card.

     Pinned by hud-render-stability.test.tsx: the memo BEHAVIOUR is proven by
     rendering HudBoard (including the failure direction — a changing onOpen
     identity re-renders every card), and this call site is held by a structural
     guard in the same file, because HudView itself has no render harness. Do
     not inline it back. */
  /* The hits are read through a ref rather than taken as a dep ON PURPOSE.
     `onOpenSession`'s identity is load-bearing — hud-render-stability.test.tsx
     pins that a changing identity re-renders every card — and `searchHits`
     changes on every keystroke's search response, which is exactly when the
     board is busiest. The handler only needs the hits AT CLICK TIME, never a
     re-render when they change, which is precisely the case a latest-ref is
     for. */
  const searchHitsRef = useRef(searchHits);
  searchHitsRef.current = searchHits;
  // Same latest-ref reason as `searchHitsRef`: the term is read at CLICK time,
  // and taking it as a dep would change the callback identity on every
  // keystroke and re-render every card.
  const queryRef = useRef(sessionQuery);
  queryRef.current = sessionQuery;
  const onOpenSession = useCallback(
    (ownerId: string) => {
      void setOpenOwner(ownerId);
      // Null clears BOTH params: opening a NON-search card must not inherit
      // the previous search's anchor and scroll to a turn nobody asked about.
      const hit = searchHitsRef.current?.get(ownerId) ?? null;
      void setOpenFocus(searchHitAnchor(hit));
      void setOpenFocusTs(hit?.ts ?? null);
      // P-004: anchor on the literal the matched turn actually contains (an exact hit inside a
      // longer token, or a fuzzy hit's near spelling) — the typed query may not occur in it.
      void setOpenFocusQ(hit ? (hit.focusTerm || queryRef.current.trim() || null) : null);
      void setOpenFocusSid(hit?.sessionId || null);
    },
    [setOpenOwner, setOpenFocus, setOpenFocusTs, setOpenFocusQ, setOpenFocusSid],
  );

  const entityView =
    tab === 'goals' ? (
      <>
        {/* P-009 (work-on-everything-goal-2026-08-23): installed goal packages,
            "Work on everything" featured — one-click start when no live
            instance; status + windowed-spend readout when one exists. Above
            the columns: the rail is the tab's entry point, not another lane. */}
        <GoalPackagesRail
          entries={goalsQuery.data?.[0]?.goalPackages ?? []}
          goals={goalsQuery.data?.[0]?.goals ?? []}
          onOpenGoal={onOpenPackageGoal}
        />
        <HudEntityColumns
          board={goalBoard}
          focusColumn={(entityColumn as HudEntityColumnId | null) ?? null}
          onFocusColumn={(id) => void setEntityColumn(id)}
          query={entityQuery}
          onQuery={(q) => void setEntityQuery(q)}
          loading={goalsQuery.loading}
          error={goalsQuery.error ? String(goalsQuery.error) : null}
          /* P-015 made this near-unreachable: the "+ Start a goal" card is
             always in the leftmost lane when no query is active, so the board
             is never card-less for the no-query case this text serves — the
             CARD is the empty state now, and says so in its own reason line.
             Kept accurate rather than deleted (the prop is required, and the
             loading/error branches can still fall through here). */
          emptyLabel="No goals yet."
          /* Name the selected goal on screen. A selection the owner cannot see
             is a selection they cannot clear — and since clicking the same card
             toggles it off, the notice is also the only thing that explains why
             a second click appears to "do nothing". */
          notice={goalNotice}
          noun="goals"
          onOpenCard={onOpenGoalCard}
          renderCardAction={renderGoalCardAction}
        />
      </>
    ) : tab === 'plans' ? (
      <HudEntityColumns
        board={planBoard}
        focusColumn={(entityColumn as HudEntityColumnId | null) ?? null}
        onFocusColumn={(id) => void setEntityColumn(id)}
        query={entityQuery}
        onQuery={(q) => void setEntityQuery(q)}
        loading={planList.loading}
        error={planList.error ? String(planList.error) : null}
        emptyLabel="No plans in this workspace yet."
        noun="plans"
        onOpenCard={onOpenPlanCard}
        /* The H2 weighted board (P-006/D-004) — Plans tab only: the goals and
           work-items boards keep the unweighted grid and bare count chips. */
        weighted
        sort={planSort}
        onSort={(s) => void setPlanSort(s)}
      />
    ) : tab === 'items' ? (
      <HudEntityColumns
        board={itemBoard}
        focusColumn={(entityColumn as HudEntityColumnId | null) ?? null}
        onFocusColumn={(id) => void setEntityColumn(id)}
        query={entityQuery}
        onQuery={(q) => void setEntityQuery(q)}
        loading={workItems.loading}
        error={workItems.error ? String(workItems.error) : null}
        emptyLabel={
          scopedHarnessSlugs === null
            ? 'No work items in this workspace.'
            : harnessSlug
            ? `No work items in ${harnessSlug}.`
            : 'Pick a harness to see its work items.'
        }
        /* The read above is gated on a resolved harness, so with none the board
           holds ONLY the unattributed asks — which still push `total` above
           zero and therefore suppress `emptyLabel` entirely. Without this the
           tab reads as a complete work-item board while containing no work
           items at all (verified live 2026-07-26: 146 needs-you, zero of them
           work items, no explanation on screen). Say what is missing. */
        notice={
          scopedHarnessSlugs === null || harnessSlug
            ? null
            : 'No harness is selected, so no work items could be loaded — these are asks that belong to no single harness. Pick a harness to see its work items.'
        }
        noun="work items"
        onOpenCard={onOpenItemCard}
      />
    ) : null;

  return (
    <>
      <HudBoard
        board={board}
        selectedFleets={selectedFleets}
        onToggleFleet={onToggleFleet}
        selectedPlans={selectedPlans}
        onSelectPlan={onSelectPlan}
        focusColumn={(focusColumn as HudColumnId | null) ?? null}
        onFocusColumn={(id) => void setFocusColumn(id)}
        suOnly={!allAgents}
        onToggleSuOnly={() => void setAllAgents((v) => !v)}
        onOpenSession={onOpenSession}
        /* NOT `|| searching` any more. Folding the transcript pass into the
           board's loading flag made every keystroke put the whole board into
           "Reading the session roster…" for the length of a 0.4–4.9s request —
           the instant local results were computed and then hidden behind a
           spinner, which is the very inertness this change exists to remove.
           The slow pass now reports itself on the input instead. */
        loading={roster.loading}
        error={roster.error ? String(roster.error) : searchError}
        sessionQuery={rawSessionQuery}
        onSessionQuery={(q) => void setSessionQuery(q === '' ? null : q)}
        /* A QUERY is active, which is not the same as "the transcript pass has
           answered" (the old test, `searchOwners !== null`). With the instant
           pass a 1-char query filters the board while the transcript pass has
           not run at all, and the empty-board copy has to say "nothing matched"
           for that case rather than "no sessions are running". */
        searchActive={rawSessionQuery.trim().length > 0}
        sessionSearching={searching}
        transcriptExtra={transcriptExtra}
        hiddenMachineHits={searchHidden}
        headerAction={
          <NewSessionLauncher
            onViewSessions={() => void setTab('sessions')}
            onLaunched={(ownerId) => {
              // WI-6363: `ownerId` is the pre-pinned coord owner id the new
              // session registers as, so it is exactly the key `hudsession`
              // (and SessionChatModal) already take. Null only from an operator
              // predating the pre-pin, in which case we open nothing rather
              // than guessing.
              //
              // WI-38009: opening nothing must not be SILENT. By the time this
              // runs NewSessionLauncher has already fired a SUCCESS toast, so a
              // bare `return` left the user looking at whichever chat was
              // previously open with every visible signal saying the launch
              // worked — which reads exactly as "+ New session resumed an
              // existing session" (the owner's 2026-08-11 report). Reproduced
              // live on an isolated instance: stub /api/adv/sessions/launch-su
              // to return {status:'ok'} with no ownerId, click with a chat open,
              // and `hudsession` never moves. The launch is REAL (an agent is
              // running); what we cannot do is OPEN it — so say that, because a
              // stale pane is otherwise indistinguishable from a deliberate
              // resume.
              const decision = hudLaunchOpenDecision(ownerId);
              if (decision.kind === 'warn') {
                toast.warning(decision.message);
                return;
              }
              // WI-6367: remember WHEN, so the chat can render the boot window
              // as "starting up" rather than as the gone-away empty state a
              // session with no roster row otherwise gets.
              setPendingLaunch({ ownerId: decision.ownerId, startedAtMs: Date.now() });
              void setOpenOwner(decision.ownerId);
            }}
          />
        }
        tab={tab as HudTabId}
        onSelectTab={(next) => void setTab(next)}
        entityView={entityView}
      />
      {/* The existing chat-grade session popup: real transcript + live composer.
          Reused wholesale so answering from HUD is byte-identical to answering
          from the inbox. */}
      <SessionChatModal
        sessionOwnerId={openOwner}
        ownerLabel={openLabel}
        pendingLaunch={pendingLaunch}
        focusAnchor={openFocus}
        focusAnchorTs={openFocusTs}
        focusTerm={openFocusQ}
        focusSessionId={openFocusSid}
        /* chat-popup-fleet-peers-rail-2026-08-09 P-005 [owner 2026-08-09]:
           "Clicking on a peer should update the conversation popup to display
           that peer."

           The SAME handler the board's session cards use — a peer click and a
           card click are the identical action (open this agent's conversation),
           so they must not drift into two behaviours. Reusing it also gets the
           focus-param handling right for free, which is the part that is easy
           to miss: `hudfocus*` anchor into a SPECIFIC agent's transcript, and
           `onOpenSession` re-resolves them against the agent being opened
           (clearing them when that agent has no search hit) rather than
           carrying the previous agent's anchor across. Left uncleared, hopping
           to a peer would scroll their transcript to a turn that does not
           exist in it.

           Everything else re-resolves on `sessionOwnerId` already — transcript,
           Orders, Activity, the status band — and the fleet rail itself does not
           flicker, because the new agent is in the same fleet: the "viewing"
           marker just moves down the column. */
        onSelectPeer={onOpenSession}
        onClose={() => {
          // WI-6367: the launch context is only meaningful for the modal it
          // opened — drop it on close so reopening the same session later
          // (by then a normal, possibly ended, session) gets the normal
          // empty states rather than a stale "starting up".
          setPendingLaunch(null);
          void setOpenOwner(null);
          void setConversation(null);
          void setOpenFocus(null);
          void setOpenFocusTs(null);
          void setOpenFocusQ(null);
          void setOpenFocusSid(null);
        }}
      />
      {/* P-002: the Work items tab's destination. Mounted here (not in
          HudEntityColumns) for the same reason PlansPane mounts its own — the
          popup is a pure function of props, the CALLER owns the open-id param.
          The PLAN popup that used to mount beside it is retired (P-007): a plan
          click writes `pdash`, and PlanDashboardHost at the SPA root renders
          the option-C takeover — no per-view mount to own. */}
      <WorkItemPopupModal
        id={openItemId}
        harnessSlug={openItemHarness ?? harnessSlug}
        onSelect={(id) => void setOpenItemId(id)}
        onClose={() => void setOpenItemId(null)}
      />
      {/* P-021: the Goals tab's destination. Keyed off `hudgoal` — the SAME
          param the board uses for "the selected goal", not a second detail key,
          so the board and this panel can never disagree about which goal is on
          screen. Closing therefore clears the selection, matching what a second
          click on the card already does.

          `goalWorkspaceId` (the RESOLVED id), never the nullable `workspaceId`
          prop: an absent workspace reads the 'default' tenant and renders a
          healthy-looking empty page pointed at the wrong one. */}
      <GoalDetailPanel
        goalId={goalFilter}
        workspaceId={goalWorkspaceId}
        nowMs={nowMs}
        onClose={() => void setGoalFilter(null)}
        onOpenWorkItem={(id) => void setOpenItemId(id)}
        /* P-018/D-011: the goal popup's ONE conversation affordance. It routes
           into the SAME `hudsession` popup the sessions pane opens rather than
           growing a chat surface of its own — D-005, never fork a second chat
           renderer. `setOpenOwner` is that route, already owned here. */
        onOpenAgent={(ownerId) => void setOpenOwner(ownerId)}
        /* P-017: re-targets THIS popup at the parent goal when the open goal is a
           subdirective. Same `hudgoal` route the board click uses — not a second
           navigation path, and not a nested popup. */
        onOpenGoal={(id) => void setGoalFilter(id)}
      />
      {/* P-015: the ORIGIN of a goal, opposite the panel above which is its
          destination. Submitting spawns the GOAL-mode agent (D-008), so on
          success we select the new goal — the owner lands on the detail panel
          for the thing they just started rather than back on an unchanged
          board. `goalWorkspaceId` for the same tenant reason as the panel. */}
      <GoalComposer
        open={goalComposerOpen}
        workspaceId={goalWorkspaceId}
        harnessSlug={harnessSlug}
        onClose={() => void setGoalComposerOpen(null)}
        onStarted={(goalId, agentOwnerId) => {
          void setGoalComposerOpen(null);
          void setGoalFilter(goalId);
          // EI-20049126246088530: seed the SAME zero-latency launch signal the
          // /adv launch path already sets (setPendingLaunch above). Without it a
          // goal's agent has NEITHER leg of SessionChatModal's `startingUp`:
          // `startingEntry` is null because listStartingTerminalLaunches filters
          // `WHERE display = 'terminal'` and the console-spawn path that goals
          // use never stamps a display; and `launchedByThisView` was false
          // because this callback dropped the ownerId that `goals:start` had
          // already returned. So the modal fell straight through to "No recent
          // Claude session found for this agent" for the agent's whole boot
          // window — while the agent was in fact alive and working.
          if (agentOwnerId) setPendingLaunch({ ownerId: agentOwnerId, startedAtMs: Date.now() });
        }}
      />
      {/* WI-6742: the ask's own popup, for asks that are not ABOUT a work item
          or plan. `OtherDetail` is the SAME component the Plans queue and
          SessionChatModal already render — never a second renderer — so these
          cards get the real approve/resolve/discuss actions rather than a
          read-only echo. It re-fetches the full item itself (the list feed is
          slimmed), which is why passing the slimmed row is correct here. */}
      <Modal
        open={openAsk != null}
        onOpenChange={(o) => {
          if (!o) void setOpenAskId(null);
        }}
        title={openAsk?.title ?? 'Ask'}
        srOnlyTitle
      >
        {openAsk ? (
          <OtherDetail
            key={openAsk.id}
            item={openAsk}
            onResolved={() => {
              attention.refresh();
              void setOpenAskId(null);
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}
