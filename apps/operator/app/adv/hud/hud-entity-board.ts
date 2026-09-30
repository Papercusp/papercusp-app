/**
 * hud-entity-board — the pure model behind the HUD's Plans and Work items tabs
 * (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * Owner ask, 2026-07-26: "What's currently in the kanban board are the
 * sessions, which is good, but there is a section show the work items above.
 * The sessions that are currently being shown in the kanban board should be
 * inside a 'sessions' tab alongside a 'plans' tab and 'Work Items' which show
 * the plans or work items in the same kanban style to replace the sessions."
 *
 * So the board grows a tab axis: the SAME five-column kanban renders three
 * different entity types. `hud-board-model.ts` stays the session model — it is
 * already 700 lines of session-specific classification and none of it applies
 * to a plan — and this file is its sibling for the two non-session tabs.
 *
 * Two things are deliberately SHARED rather than re-derived:
 *   - the column VOCABULARY. A plan with a needs-human item and a session
 *     waiting on you are the same fact about your attention, so they sit in a
 *     column with the same id, label and colour. `HudEntityColumnId` mirrors
 *     `HudColumnId` where the meaning matches (needs-you / working / blocked)
 *     and diverges only where it must (a plan is `ready`, not `parked`).
 *   - `HudBadge`, imported from the session model, so a chip renders through
 *     exactly one styling path.
 *
 * Pure + injected-clock, like hud-board-model: no `Date.now()` inside, no
 * imports that reach the server. Input types are structural and declared HERE
 * rather than imported from `plans-api` / `WorkItemsPanel` — the same reason
 * HudView inlines its roster payload type: the wire shape is the contract, and
 * importing the real modules would drag hooks (and, through them, PG-touching
 * server modules) into a file whose whole value is being testable without a DOM.
 */

import type { BadgeTone, HudAsk, HudBadge } from './hud-board-model';
import { HUD_ASK_KIND_LABEL } from './hud-board-model';
import {
  matchSessionIdField,
  parseSessionIdQuery,
  type SessionIdBearing,
} from '@papercusp/operator-core/lib/adv-session-search';
import { WORK_ITEM_ID, trailingWorkItemId } from '@/lib/work-item-ref';
import { SEVERITY_TONE } from '../../harness/theme';

/** Structural subset of AdvScope so the shared app layer stays Vite-independent. */
export interface HudPotScope {
  allMode: boolean;
  slug: string | null;
  harnessSlugs: readonly string[] | null;
  ready: boolean;
}

/** null set = workspace-wide; a scoped row must carry an exact matching harness. */
export function isInHudPotScope(
  harnessSlug: string | null | undefined,
  harnessSlugs: readonly string[] | null,
): boolean {
  return harnessSlugs === null || (!!harnessSlug && harnessSlugs.includes(harnessSlug));
}

/**
 * Session-specific Pot scope with one deliberate escape hatch: an exact parsed
 * owner/session/thread id addresses a session rather than browsing a Pot.
 *
 * The HUD already lets an id-addressed session override its SU-only, goal,
 * fleet, and plan filters. Pot scope used to run earlier in HudView and discard
 * the row before that exemption could see it, so an active session with a null
 * or different `harnessSlug` was impossible to find by the id shown on its own
 * card. Keep prose queries scoped: only the conservative shared id parser can
 * open this path.
 */
export function isHudSessionInPotScope(
  session: SessionIdBearing & { harnessSlug?: string | null },
  harnessSlugs: readonly string[] | null,
  query: string,
): boolean {
  if (isInHudPotScope(session.harnessSlug, harnessSlugs)) return true;
  const token = parseSessionIdQuery(query);
  return token !== null && matchSessionIdField(session, token) !== null;
}

/** Sync-query argument shared by Goals, Plans, Work items, and Overview counts. */
export function hudHarnessScopeArgs(
  harnessSlugs: readonly string[] | null,
): Record<string, unknown> {
  return harnessSlugs === null ? {} : { harnessSlugs: [...harnessSlugs] };
}

/* ── tabs ────────────────────────────────────────────────────────────────── */

/**
 * `goals` is FIRST — leftmost in the tab strip.
 *
 * ⚠ FIRST ≠ DEFAULT. The default tab is a separate decision, set by the
 * `hudtab` nuqs parser's `.withDefault('sessions')` in HudView, and it is
 * deliberately UNCHANGED: the owner asked for a position in the strip, not for
 * a different landing tab, and quietly moving where the HUD opens would be a
 * behaviour change nobody requested. If you are here to make Goals the default,
 * that is the line to edit — and it wants its own owner ask.
 *
 * [owner 2026-08-09 interactive, verbatim: "make the goal tab in the hud tab
 * the left most tab"] — recorded as D-018 on goal-mode-2026-08-07. The ordering
 * is not cosmetic: sessions/plans/items each answer "what is happening", and a
 * board that opens on those reads as activity with no stated purpose. Goals
 * answers "what is it FOR", so it is the frame the other three tabs are read
 * inside — which only works if the owner meets it first.
 */
export const HUD_TABS = ['goals', 'sessions', 'plans', 'items'] as const;
export type HudTabId = (typeof HUD_TABS)[number];

/**
 * The tab the HUD OPENS on — deliberately NOT `HUD_TABS[0]`.
 *
 * Hoisted out of HudView's `parseAsStringLiteral(HUD_TABS).withDefault(...)` so
 * that "which tab is leftmost" and "which tab do we land on" are two separately
 * readable, separately testable facts. While they were one inline literal, the
 * only way to notice that adding a leftmost tab had also moved the landing tab
 * was to read the parser call — and adding a tab is exactly when nobody does.
 */
export const HUD_DEFAULT_TAB: HudTabId = 'sessions';

export const HUD_TAB_LABEL: Record<HudTabId, string> = {
  goals: 'Goals',
  sessions: 'Sessions',
  plans: 'Plans',
  items: 'Work items',
};

/* ── columns ─────────────────────────────────────────────────────────────── */

/**
 * The entity columns. Ordered most- to least-urgent, matching the session
 * board's left-to-right reading: what needs you, what is moving, what is
 * stuck, what is queued, what is finished.
 *
 * `ready` replaces the session board's `stalled`/`parked` pair: a plan or a
 * work item has no heartbeat, so it cannot stall — the honest fifth state is
 * "queued, nobody has picked it up".
 */
export const HUD_ENTITY_COLUMNS = ['needs-you', 'working', 'blocked', 'ready', 'done'] as const;
export type HudEntityColumnId = (typeof HUD_ENTITY_COLUMNS)[number];

export const HUD_ENTITY_COLUMN_LABEL: Record<HudEntityColumnId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  ready: 'Ready',
  done: 'Done',
};

/** Per-column empty text, written per ENTITY: "no plans are blocked" is good
 *  news, and phrasing it as such is what keeps an empty column readable. */
const PLAN_COLUMN_EMPTY: Record<HudEntityColumnId, string> = {
  'needs-you': 'No plan is waiting on a decision',
  working: 'No plan has work in flight',
  blocked: 'Nothing is blocked',
  ready: 'Nothing queued',
  done: 'Nothing finished yet',
};

const GOAL_COLUMN_EMPTY: Record<HudEntityColumnId, string> = {
  'needs-you': 'No goal is waiting on a decision',
  working: 'No goal has work in flight',
  blocked: 'No goal is paused',
  ready: 'No goal is idle',
  done: 'No goal has been closed yet',
};

const ITEM_COLUMN_EMPTY: Record<HudEntityColumnId, string> = {
  'needs-you': 'Nothing is waiting on you',
  working: 'Nothing is being worked',
  blocked: 'Nothing is blocked',
  ready: 'The queue is empty',
  done: 'Nothing closed yet',
};

/* ── card + board shapes ─────────────────────────────────────────────────── */

export interface HudEntityCard {
  /** Stable React key + the id a click resolves against (plan slug / WI id). */
  id: string;
  /** Short monospace identifier rendered where a session card shows its handle. */
  ref: string;
  /** The headline — a plan's title, a work item's title. */
  title: string;
  column: HudEntityColumnId;
  /** One line of "what is actually going on here", or null when there is
   *  nothing honest to say (an empty string would render as a blank row). */
  reason: string | null;
  /** Secondary context line — the harness for a plan, the plan for a work
   *  item. Rendered in the slot a session card gives its plan slug. */
  context: string | null;
  badges: HudBadge[];
  /** Age in seconds of the entity's last movement; null when unknown. */
  sinceSec: number | null;
  /** Sort key WITHIN the column: lower sorts first. */
  sortKey: number;
  /**
   * WHICH popup a click on this card opens (WI-6742). Set by the Work-items
   * board on every card it builds — real work items AND the folded asks — so
   * the handler never has to re-derive a destination by pattern-matching `id`
   * or `ref`. That re-derivation was the bug: an ask card's `ref` is a KIND
   * LABEL ("Improvement triage"), so it matched no work-item id and the click
   * silently did nothing.
   *
   * Optional because the Plans board doesn't use it (its card `id` IS the plan
   * slug, and its own handler reads that directly).
   */
  open?: HudAskTarget;
  /**
   * SUBDIRECTIVES steering this goal's agent, rendered INSIDE this card
   * (P-017, D-006 Q4 option A). Goals board only; omitted everywhere else.
   *
   * They live on the parent's card rather than in a lane because a child is not
   * an agent and so "has no business sitting in a lane of its own" (D-006).
   */
  subGoals?: HudSubGoal[];
  /**
   * WHO is behind this card, so every HUD tab can be filtered by session/agent
   * id the way the sessions tab already can ([owner 2026-08-10]).
   *
   * ⚠ NEVER populate this with a stand-in. `undefined` means "this card has no
   * single owning agent", and `matchesQuery` treats it as matching nothing.
   * Filling it with the nearest plausible value (a plan's harness, a goal's
   * first pot) would make the filter silently WRONG rather than merely
   * incomplete — and a filter that looks like it worked is far worse than one
   * that visibly returns nothing.
   *
   * One optional OBJECT rather than three optional sibling strings (D-002): the
   * card is built in three places, and siblings invite a builder to set one and
   * forget the rest, which half-works undetectably.
   *
   * ONE identity, or SEVERAL: a work item has a single assignee, a goal can
   * have more than one agent (see identityMatches).
   */
  identity?: HudCardIdentity | HudCardIdentity[];
  /**
   * The Plans board's enriched meta row + progress track
   * (plan-visibility-revamp-2026-08-23 P-007). Plans board only; omitted
   * everywhere else, so the other tabs' cards render byte-identical trees.
   */
  plan?: HudPlanCardMeta;
}

/**
 * The identity strings a query may match against. Every field optional and
 * independently absent: a card can know its agent without its session, or the
 * reverse, and neither absence may be papered over with a placeholder.
 */
export interface HudCardIdentity {
  /** Coordination owner id, e.g. `su-12b70e95-84ce-4ea0-b546-8a692cdc949c`. */
  ownerId?: string | null;
  /** Session id / number, when the card traces to one concrete session. */
  sessionId?: string | null;
  /** Short display handle, e.g. `su-12b70` — what the owner actually types. */
  agentHandle?: string | null;
  /**
   * Is this identity's session actually ALIVE right now?
   * `true` positively alive · `false` positively gone · `null`/absent UNKNOWN.
   *
   * goal-live-holder-guarantee-2026-08-18 P-001. For a GOAL card this is the
   * difference the whole plan exists for: a goal's agent is recorded as an
   * `agent_modes` row that OUTLIVES the session that wrote it, so a card
   * rendering the identity alone showed a steward six days dead exactly as it
   * showed one working. Never coerce `null` to `false` — an unresolvable
   * verdict is not a dead one, and treating it as such would mark every card
   * dead at once whenever the presence oracle degrades.
   */
  live?: boolean | null;
  /** The oracle's session state (live|parked|draining|suspect|ended|recorded),
   *  when resolved — the detail behind `live`, for a tooltip or a chip. */
  sessionState?: string | null;
}

export interface HudEntityBoard {
  columns: Array<{
    id: HudEntityColumnId;
    label: string;
    empty: string;
    cards: HudEntityCard[];
    /** Cards dropped by the per-column cap — surfaced as "+N more" so a
     *  truncated column never silently lies about its size. */
    hidden: number;
  }>;
  counts: Record<HudEntityColumnId, number>;
  total: number;
}

export interface HudEntityBuildOptions {
  /** Injected clock (ms epoch) — never read Date.now() inside the model. */
  nowMs: number;
  /**
   * Cards rendered per column before truncating. This workspace carries ~900
   * plans and ~1800 work items; rendering them all is thousands of DOM nodes
   * in a WebKitGTK webview for information nobody can read. The cap is a
   * RENDER bound only — `counts` and `total` always report the true numbers.
   */
  maxPerColumn?: number;
  /** Substring filter over ref/title/context, case-insensitive. */
  query?: string;
  /**
   * TRUE per-column totals over the whole store (P-004), when the caller can
   * supply them — the cards it passes are only a bounded sample.
   *
   * The docblock on `maxPerColumn` above promised "`counts` and `total` always
   * report the true numbers". That was false: counts were derived from whatever
   * rows happened to be fetched, so on `papercusp` the Work items tab reported
   * "201 needs you" (which were 201 unattributed ASKS and zero work items,
   * because none of the 45 real needs-human rows were inside the fetched
   * window) and "197 ready" against an actual 13,126. Every number on the board
   * was a window artifact wearing the clothes of a total.
   *
   * Supplying `totals` makes that promise true. Omitted ⇒ counts fall back to
   * the cards present, which is the honest answer when there is nothing better.
   */
  totals?: Partial<Record<HudEntityColumnId, number>> | null;
}

export const HUD_ENTITY_DEFAULT_MAX_PER_COLUMN = 60;

/* ── inputs ──────────────────────────────────────────────────────────────── */

/** The plan-list wire row, narrowed to what a card needs (see the file doc for
 *  why this is declared rather than imported from plans-api). */
export interface HudPlanInput {
  slug: string;
  title?: string | null;
  status: string;
  updated?: string | null;
  harnessSlug?: string | null;
  nextAction?: string | null;
  itemCounts?: Record<string, number> | null;
  archived?: boolean;
  /** `harness_plans.owner` — the agent that owns this plan, so the Plans tab
   *  filters by agent id like the Sessions tab does (P-006). Absent/null when
   *  the plan has no recorded owner; never substituted with the harness. */
  owner?: string | null;
  /**
   * ⚒ last WORK-ITEM activity on this plan, epoch ms — the `planWorkActivity.list`
   * feed joined by slug (plan-visibility-revamp-2026-08-23 P-001/P-006), exactly
   * the join PlansPane already does for its own ⚒ column. Absent/null = never
   * worked (a real state, distinct from "feed not loaded" only at the caller —
   * here both honestly mean "no ⚒ timestamp to sort by", so the row sinks under
   * the last-work sort rather than colonizing the top).
   */
  lastWorkAtMs?: number | null;
  /**
   * The agents currently ON this plan (plan-visibility-revamp-2026-08-23 P-007)
   * — the roster join by `currentPlanSlug` / claim planSlug, threaded in by
   * HudView from the SAME `advRoster.list` payload the Sessions tab renders.
   *
   * Absent/null = roster not joined (an older caller, or the feed not answered
   * yet) — meaningfully distinct from `[]`, which is a loaded answer of
   * "nobody is on this plan". Both render the same (no avatars), but only the
   * empty array is evidence of absence.
   */
  agents?: HudPlanAgent[] | null;
}

/**
 * One roster agent as the Plans board needs it (P-007). Narrowed from
 * `HudRosterEntry` at the caller rather than imported — same reason every
 * other input type in this file is declared structurally: the wire shape is
 * the contract, and importing the component-layer type would couple the pure
 * model to a file that types a full roster payload.
 */
export interface HudPlanAgent {
  ownerId: string;
  /**
   * Is this agent's session taking turns right now? Derived from the oracle's
   * `sessionState` at the caller: `true` only for a positive 'live' verdict,
   * `false` for a positive non-live one, `null`/absent UNKNOWN. Never coerce
   * unknown to false — the same rule HudCardIdentity.live documents.
   */
  live?: boolean | null;
  /** The oracle's session state, carried through for tooltips. */
  sessionState?: string | null;
  /** The agent's declared intent — the who-is-doing-what material. */
  intent?: string | null;
}

/**
 * The Plans board's sort axes (plan-visibility-revamp-2026-08-23 P-006, D-004:
 * "add a sort picker (default: last work)").
 *
 * Exactly the two timestamps the whole revamp is about — ⚒ last work (when an
 * agent last moved a work item on the plan) and ✎ last edit (when the plan text
 * itself last changed). The picker replaces this board's previous fixed
 * ordering; `sortKeyFor`'s oldest-first needs-you inversion remains the rule on
 * the goals/items boards, but on the Plans board the picked axis governs EVERY
 * column — a sort control that silently exempted one column would read as
 * broken in exactly that column.
 */
export const HUD_PLAN_SORTS = ['last-work', 'last-edit'] as const;
export type HudPlanSort = (typeof HUD_PLAN_SORTS)[number];

export const HUD_DEFAULT_PLAN_SORT: HudPlanSort = 'last-work';

export const HUD_PLAN_SORT_LABEL: Record<HudPlanSort, string> = {
  'last-work': 'Last work',
  'last-edit': 'Last edit',
};

/**
 * The `goals.list` wire row, narrowed the same way (goal-mode-2026-08-07 P-020).
 *
 * Declared here rather than imported from the resolver for the reason the file
 * doc gives for the other two: this module's whole value is being testable
 * without pulling a server module (and its `postgres` import) into a DOM-free
 * unit test.
 */
/** One pot serving a goal, as the list query samples it (P-007/D-022). */
export interface HudGoalPot {
  harnessSlug: string;
  role?: string | null;
  /** Live goals this same pot serves. >1 means its spend does not sum (D-021). */
  servesGoals?: number | null;
}

export interface HudGoalInput {
  id: string;
  title: string;
  status: string;
  /** Server-derived activity status; notably `dormant` for holderless active goals. */
  effectiveStatus?: string | null;
  deactivated?: boolean | null;
  killCriterion?: string | null;
  /** Items on this goal parked on the owner — the needs-you signal. */
  needsHuman?: number | null;
  openWorkItems?: number | null;
  potCount?: number | null;
  /**
   * WHICH pots those are — a BOUNDED SAMPLE from the list query, never the
   * total (goals-tab-improvement-2026-08-09 P-007, D-022).
   *
   * ⚠ Read `potCount` for how many, this for the names. `pots.length` is how
   * many names the query was willing to carry; a goal past the sample cap has
   * more pots than this array has entries, which is exactly the case where
   * counting it would report a confident wrong number.
   */
  pots?: HudGoalPot[] | null;
  /** FLEET spend: what the goal's child agents cost. Not the goal's own turns. */
  spendUsd?: number | null;
  /**
   * The same fleet spend, restricted to the recent window (P-003) — the RATE
   * input where `spendUsd` is the LEVEL.
   *
   * Optional, and its ABSENCE is meaningful: a payload that carries no reading
   * must render no rate at all, never `$0/day`. See goalBurn.
   */
  spendRecentUsd?: number | null;
  /** How wide that window is. Read from the payload, never assumed to be 7. */
  spendRecentWindowDays?: number | null;
  budgetCents?: number | null;
  createdAt?: string | null;
  /**
   * When the goal's DEFINITION last changed — NOT when it last progressed.
   * Kept for ORDERING only (see toGoalCard); never aged for display, because
   * only `goals:update` writes it. See GoalSummaryRow.updatedAt for the
   * measurement behind that claim.
   */
  updatedAt?: string | null;
  /**
   * When work under this goal last moved (P-004). Optional, and its ABSENCE is
   * meaningful in the same way `spendRecentUsd`'s is: no reading means no
   * staleness verdict at all, never "stale forever".
   */
  lastActivityAt?: string | null;
  /**
   * The parent goal, when this row is a SUBDIRECTIVE rather than a goal in its
   * own right (goals-tab-improvement-2026-08-09 P-017 / D-006).
   *
   * On the wire as `GoalSummaryRow.parentId` since goal-mode-2026-08-07 and read
   * by nothing until now. It is narrowed in here rather than imported for the
   * reason the type's own docblock gives.
   */
  parentId?: string | null;
  /**
   * The agents working this goal (`agent_modes` mode='goal', subject=<goal id>)
   * — so the Goals tab filters by agent id (P-006).
   *
   * A LIST, matching `resolveGoalDetail`'s shape and for its stated reason:
   * D-006 makes this one agent in practice, but collapsing it would silently
   * hide a second stamp, and a goal with two agents is a coordination fault
   * worth SEEING rather than a row to discard.
   *
   * P-001 (goal-live-holder-guarantee-2026-08-18): each entry now carries its
   * LIVENESS, resolved fresh by the payload on every read. Optional here only
   * because a cached/legacy payload predating P-001 has no such key — NOT
   * because it is discretionary: absent reads as UNKNOWN, never as dead.
   */
  agents?: Array<{
    ownerId: string;
    live?: boolean | null;
    sessionState?: string | null;
  }> | null;
  /**
   * The goal's holder verdict: `held` | `unheld` | `lost` | `unknown` (P-001).
   * Optional for the same legacy-payload reason as `agents` above.
   */
  holderLiveness?: string | null;
}

/**
 * A SUBDIRECTIVE, as rendered inside its parent's card.
 *
 * Deliberately NOT a `HudEntityCard`, and the omissions are the point (D-006):
 *
 *   - no `column`, because a child carries no independent lane state — it is not
 *     an agent, so there is nothing for a lane to describe;
 *   - no `badges`, and specifically NO SPEND. D-006 retired the parent/child
 *     half of the D-002 summing hazard by observing that one goal is one agent
 *     is one bill, so a child has no separable spend to show. Rendering a child
 *     figure would invent a number, and rendering a parent figure that INCLUDED
 *     children would be the summing D-002 forbids. Neither is representable
 *     here, which is stronger than a test asserting nobody wrote one;
 *   - no `open` target, because a child owns no session to open.
 */
export interface HudSubGoal {
  id: string;
  /** Short handle, same slice rule as a card's `ref`. */
  ref: string;
  title: string;
  /** Lower-cased goal status — rendered as a word, never as a lane. */
  status: string;
  /** True for `achieved`/`killed`: a finished directive is struck through, not hidden. */
  terminal: boolean;
}

/** The work-item wire row (workItems.byHarness), narrowed the same way. */
export interface HudWorkItemInput {
  id: string;
  kind: string;
  title: string;
  state: string;
  assignee?: string | null;
  severity?: string | null;
  planSlug?: string | null;
  updatedAt?: string | null;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Normalize a state token across the vocabulary drift the store still
 *  carries (`needs_human` vs `needs-human`, `in_progress` vs `wip`). Mirrors
 *  `ISSUE_STATE_ALIASES` in operator-core/lib/work-items.ts — NOT imported,
 *  because that module reaches Postgres and this one must not. */
function normalizeState(state: string | null | undefined): string {
  return (state ?? '').trim().toLowerCase().replace(/_/g, '-');
}

/** The cross-family settled set (`SETTLED_WORK_ITEM_STATES`, same reason for
 *  the local copy). The legacy terminals are still stored on pre-migration
 *  rows, so a card must recognize both spellings or a closed item reappears
 *  in the queue. */
const SETTLED_STATES: ReadonlySet<string> = new Set([
  'done',
  'dropped',
  'resolved',
  'closed',
  'passed',
  'deprecated',
]);

/**
 * The statuses the Work items tab fetches cards for (P-004), one bounded slice
 * each — see `workItems.byHarness`'s `states` arg for why a single
 * `updated_ts DESC` window is the wrong sample for a status-grouped board.
 *
 * Derived from the SAME vocabulary `workItemColumn` maps below (every branch it
 * names, plus the two `ready` states), so a status added to one is a visible
 * omission in the other rather than a column that silently stops loading.
 */
export const HUD_WORK_ITEM_FETCH_STATES: readonly string[] = [
  'needs-human',
  'wip',
  'in-progress',
  'blocked',
  'open',
  'todo',
  ...SETTLED_STATES,
];

/**
 * Roll a `{ state, n }` aggregate (the `workItems.stats` feed) up into TRUE
 * per-column totals, through the SAME `workItemColumn` mapping the cards use —
 * so the counts and the cards can never disagree about which column a status
 * belongs to. That shared mapping is the reason this rollup lives here in TS
 * rather than as a GROUP BY over a column expression in SQL.
 */
export function rollUpStateCounts(
  rows: readonly { state?: string | null; n?: number | null }[],
): Record<HudEntityColumnId, number> {
  const out = Object.fromEntries(
    HUD_ENTITY_COLUMNS.map((id) => [id, 0]),
  ) as Record<HudEntityColumnId, number>;
  for (const r of rows) {
    const n = typeof r.n === 'number' && Number.isFinite(r.n) ? r.n : 0;
    if (n <= 0) continue;
    out[workItemColumn(r.state)] += n;
  }
  return out;
}

export function workItemColumn(state: string | null | undefined): HudEntityColumnId {
  const s = normalizeState(state);
  if (s === 'needs-human') return 'needs-you';
  if (s === 'wip' || s === 'in-progress') return 'working';
  if (s === 'blocked') return 'blocked';
  if (SETTLED_STATES.has(s)) return 'done';
  // `open`, `todo`, and anything unrecognized: claimable, nobody on it.
  // Defaulting UNKNOWN states to `ready` rather than `done` is deliberate —
  // a state this file has not learned about yet should surface as work, not
  // vanish into the finished column.
  return 'ready';
}

/**
 * Which column a plan belongs in.
 *
 * Order is the whole decision, so it is spelled out rather than folded into a
 * lookup: a plan is usually several of these at once (items in flight AND
 * items blocked AND one waiting on a human), and the column has to answer
 * "what does this plan need from me right now", not "what does it contain".
 */
export function planColumn(plan: HudPlanInput): HudEntityColumnId {
  const c = plan.itemCounts ?? {};
  const needsHuman = c['needs-human'] ?? 0;
  const wip = c.wip ?? 0;
  const blocked = c.blocked ?? 0;
  const todo = c.todo ?? 0;
  const status = (plan.status ?? '').toLowerCase();

  // 1. A decision only you can make outranks everything else on the board.
  if (needsHuman > 0) return 'needs-you';
  // 2. An explicit `blocked` status is the author's own verdict — it beats
  //    inferring "working" from an item somebody left flipped to wip.
  if (status === 'blocked') return 'blocked';
  // 3. Something is genuinely in flight.
  if (wip > 0) return 'working';
  // 4. Nothing moving, something stuck.
  if (blocked > 0) return 'blocked';
  // 5. The author closed it.
  if (status === 'shipped' || status === 'superseded') return 'done';
  // 6. Work remains and nobody has picked it up.
  if (todo > 0) return 'ready';
  // 7. No todo, no wip, no blocked, not explicitly shipped: every item is
  //    done or dropped. A plan with NO items at all also lands here — it has
  //    nothing to offer the queue, and `ready` would be a false promise.
  return 'done';
}

/** "3 todo · 1 blocked · 2 done" — the plan's shape when it has no explicit
 *  nextAction to show instead. Ordered by decision value, not alphabetically. */
export function planCountsSummary(counts: Record<string, number> | null | undefined): string | null {
  const c = counts ?? {};
  const parts: string[] = [];
  for (const key of ['needs-human', 'wip', 'blocked', 'todo', 'done'] as const) {
    const n = c[key] ?? 0;
    if (n > 0) parts.push(`${n} ${key === 'needs-human' ? 'needs you' : key}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Does this identity match the query? Exported so the sessions board and the
 * entity boards apply ONE definition of "filtering by session/agent id" and
 * cannot drift ([owner 2026-08-10] asked for every tab to filter the way the
 * sessions tab does — two implementations is how that promise decays).
 *
 * Substring, case-insensitive, deliberately: the owner types `su-12b70`, not
 * the full `su-12b70e95-84ce-4ea0-b546-8a692cdc949c`. An exact-match rule would
 * make the feature useless for the ids people actually have in their heads.
 *
 * An absent/blank field matches NOTHING — never the empty string. `''.includes`
 * is vacuously true for any needle-free query, and this function is reached
 * only with a non-empty needle, but the explicit guard states the intent so a
 * later refactor cannot turn "no identity" into "matches everything".
 */
export function identityMatches(
  identity: HudCardIdentity | HudCardIdentity[] | undefined,
  needle: string,
): boolean {
  if (!identity || !needle) return false;
  // ONE-OR-MANY, because the two card kinds genuinely differ: a work item has a
  // single assignee, but a goal can carry SEVERAL agents. `resolveGoalDetail`
  // returns that as a list on purpose — "a goal with two agents is a
  // coordination fault worth SEEING rather than a row to discard" — so
  // collapsing it here to `agents[0]` would hide the second agent from search
  // and quietly re-introduce the bug that comment exists to prevent.
  for (const one of Array.isArray(identity) ? identity : [identity]) {
    if (!one) continue;
    for (const field of [one.ownerId, one.sessionId, one.agentHandle]) {
      if (field && field.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

function matchesQuery(
  card: {
    ref: string;
    title: string;
    context: string | null;
    subGoals?: HudSubGoal[];
    identity?: HudCardIdentity | HudCardIdentity[];
  },
  q: string,
): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    card.ref.toLowerCase().includes(needle) ||
    card.title.toLowerCase().includes(needle) ||
    (card.context ?? '').toLowerCase().includes(needle) ||
    // WHO is behind the card, so `su-12b70` filters every tab the way it
    // already filters sessions. Absent identity contributes nothing rather
    // than matching — see the warning on HudEntityCard.identity.
    identityMatches(card.identity, needle) ||
    // A subdirective has no card of its own (D-006), so the PARENT card is the
    // only thing a search can return it in. Without this the filter would hide
    // a child that matches — a silent loss, and the one outcome this board's
    // "+N more" / true-counts discipline exists to rule out.
    (card.subGoals ?? []).some(
      (s) => s.title.toLowerCase().includes(needle) || s.ref.toLowerCase().includes(needle),
    )
  );
}

/**
 * Assemble cards into the five columns.
 *
 * Sort: the needs-you column is OLDEST first (the thing that has been waiting
 * on you longest is the thing to answer next — the same urgency ordering
 * `unattributedAsks` applies), every other column is NEWEST first (the most
 * recently touched work is the most relevant context). That inversion is the
 * reason cards carry an explicit `sortKey` instead of the columns sorting by
 * age directly.
 */
function assemble(
  cards: HudEntityCard[],
  empty: Record<HudEntityColumnId, string>,
  opts: HudEntityBuildOptions,
): HudEntityBoard {
  const max = opts.maxPerColumn ?? HUD_ENTITY_DEFAULT_MAX_PER_COLUMN;
  const q = (opts.query ?? '').trim();
  const kept = q ? cards.filter((c) => matchesQuery(c, q)) : cards;

  const counts = Object.fromEntries(
    HUD_ENTITY_COLUMNS.map((id) => [id, 0]),
  ) as Record<HudEntityColumnId, number>;

  const byColumn = new Map<HudEntityColumnId, HudEntityCard[]>(
    HUD_ENTITY_COLUMNS.map((id) => [id, [] as HudEntityCard[]]),
  );
  for (const card of kept) {
    counts[card.column] += 1;
    byColumn.get(card.column)!.push(card);
  }

  /* True totals REPLACE the sampled counts — but only when no query is active.
     A filter's whole contract on this board is that "the counts above always
     describe what is actually on screen"; a store-wide total would break that
     the moment you typed into the box. So filtering falls back to counting the
     matches, which is then genuinely the right number. */
  const filtering = q.length > 0;
  const totals = filtering ? null : opts.totals ?? null;
  if (totals) {
    for (const id of HUD_ENTITY_COLUMNS) {
      const t = totals[id];
      // Never report FEWER than the cards actually held: the ask cards folded
      // into needs-you are not work items and so are not in the store-side
      // totals, and a count below the visible card count reads as a bug.
      if (typeof t === 'number' && Number.isFinite(t)) {
        counts[id] = Math.max(t, counts[id]);
      }
    }
  }

  const columns = HUD_ENTITY_COLUMNS.map((id) => {
    const all = byColumn.get(id)!.slice().sort((a, b) => a.sortKey - b.sortKey);
    const cards = all.slice(0, max);
    return {
      id,
      label: HUD_ENTITY_COLUMN_LABEL[id],
      empty: empty[id],
      cards,
      // Hidden is measured against the COUNT, not the sample: with true totals
      // the rows this board never fetched are hidden too, and saying so is the
      // difference between a bounded view and a wrong one.
      hidden: Math.max(0, counts[id] - cards.length),
    };
  });

  return {
    columns,
    counts,
    total: totals
      ? HUD_ENTITY_COLUMNS.reduce((n, id) => n + counts[id], 0)
      : kept.length,
  };
}

/* ── plans ───────────────────────────────────────────────────────────────── */

/**
 * The plan card's meta row + progress track (plan-visibility-revamp-2026-08-23
 * P-007, per the HudH2 mockup): ✎/⚒ ages, items progress, agent avatars with a
 * live-count pill, and the who-is-doing-what line.
 *
 * A separate optional structure on the card (like `subGoals`) rather than more
 * sibling fields, for the D-002 reason `identity` is one object: the card is
 * built in three places and only the Plans builder fills this, so siblings
 * would invite a half-set that half-works undetectably.
 */
export interface HudPlanCardMeta {
  /** ✎ seconds since the plan TEXT last changed; null unknown. */
  editedSec: number | null;
  /** ⚒ seconds since a work item on the plan last moved; null = never/unknown. */
  workedSec: number | null;
  /** Items progress: settled (done + dropped) over all items. Null total =
   *  the plan has no parsed items — render no fraction, never `0/0`. */
  itemsDone: number | null;
  itemsTotal: number | null;
  /** Bounded avatar stack — the first HUD_PLAN_AVATARS_SHOWN agents, live
   *  first. NOT the full population; `avatarsOverflow` says what was cut. */
  avatars: HudPlanAvatar[];
  avatarsOverflow: number;
  /**
   * How many agents are POSITIVELY live (`live === true`). Unknown liveness
   * counts zero here — the pill is a "working right now" claim, and counting
   * an unresolved verdict toward it would manufacture activity, the exact
   * direction HudCardIdentity.live forbids.
   */
  liveCount: number;
  /**
   * The two EXCEPTION counts, carried as numbers so the compact card can render
   * them as pips (hud-plan-card-density-2026-08-31 D-003).
   *
   * These same numbers are also formatted into `badges[]` as label strings
   * ("2 blocked"). The compact plan card does not render that chips row, and
   * reading a count back out of its own label would be a second copy of a truth
   * this model already owns — it breaks silently the moment the label is
   * reworded. So the counts travel here, beside the other derived plan facts,
   * and `toPlanCard`'s badge builder is left exactly as it was.
   *
   * ZERO IS A REAL ANSWER, not "unknown": a plan with no blocked items reports
   * 0 and the card renders no pip. `itemCounts` absent likewise reports 0 —
   * this is a count of KNOWN exceptions, and inventing an unknown-vs-none
   * distinction the card cannot draw would only invite a wrong reading.
   */
  needsHumanCount: number;
  blockedCount: number;
  /** "su-76a83: recording D-001 · su-6e294: P-045 verification" — live agents'
   *  declared intents, or null when nobody on the plan declared one. */
  who: string | null;
}

export interface HudPlanAvatar {
  ownerId: string;
  /** Short handle for the tooltip (`su-76a83`). */
  handle: string;
  /** The two characters inside the circle (`76`). */
  initials: string;
  /** Carried through from the roster verdict — null stays UNKNOWN. */
  live: boolean | null;
  /** Deterministic palette index (0..HUD_AVATAR_COLOR_COUNT-1) off ownerId, so
   *  one agent keeps one colour across cards and renders. */
  colorIndex: number;
}

/** Avatar circles rendered before the stack collapses to `+N`. Four, matching
 *  the mockup's densest card — a fifth reads as noise at 16px. */
export const HUD_PLAN_AVATARS_SHOWN = 4;

/** Intents woven into the who line. Two: the line is one ellipsized row, and a
 *  third entry is never visible at card width anyway. */
const HUD_PLAN_WHO_SHOWN = 2;

/**
 * ⚒ activity fresher than this renders "hot" (green). SAME threshold as
 * PlansPane's `WORK_HOT_MS` (1h) — the two surfaces show the same timestamp
 * and must agree on when it glows; not imported because that module is a
 * component file and this one must stay DOM-free.
 */
export const HUD_PLAN_WORK_HOT_SEC = 60 * 60;

/** How many distinct avatar palette classes hud.css defines (.hud__av--c0..). */
export const HUD_AVATAR_COLOR_COUNT = 8;

/** Deterministic string → palette index. Tiny FNV-1a — stability across
 *  renders/sessions is the requirement, not distribution quality. */
export function avatarColorIndex(ownerId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ownerId.length; i++) {
    h ^= ownerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % HUD_AVATAR_COLOR_COUNT;
}

/** `su-76a83f22-…` → `76` — the first two chars of the id segment, matching
 *  the mockup. Falls back to the first two chars of the whole string for an
 *  id that doesn't match the `prefix-hex` grammar. */
export function avatarInitials(ownerId: string): string {
  const m = /^[a-z]+-([0-9a-f]{2})/i.exec(ownerId);
  return (m ? m[1] : ownerId.slice(0, 2)).toLowerCase();
}

/**
 * Order agents for display: positively live first, unknown next, positively
 * gone last — so the avatar cap and the who line both spend their bounded
 * slots on the agents most likely to matter right now. Stable within a tier
 * (Array.prototype.sort is stable), so the caller's roster order is the
 * tiebreak rather than something re-invented here.
 */
function agentsByLiveness(agents: readonly HudPlanAgent[]): HudPlanAgent[] {
  const rank = (a: HudPlanAgent) => (a.live === true ? 0 : a.live == null ? 1 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

/**
 * Build the P-007 meta block. Exported for the model test — the counting rules
 * (live-only pill, capped avatars, settled-over-total progress) are the
 * substance, and asserting them through a rendered board would test the
 * renderer's pass-through instead.
 */
export function planCardMeta(plan: HudPlanInput, nowMs: number): HudPlanCardMeta {
  const workedSec =
    typeof plan.lastWorkAtMs === 'number' && Number.isFinite(plan.lastWorkAtMs)
      ? Math.max(0, Math.round((nowMs - plan.lastWorkAtMs) / 1000))
      : null;

  // Progress: SETTLED items over ALL items. `dropped` counts as settled — the
  // track answers "how much of this plan is still ahead", and a dropped item
  // is behind you the same way a done one is (rendering it as remaining work
  // would show a plan that can never reach 100%).
  const c = plan.itemCounts ?? {};
  let total = 0;
  for (const n of Object.values(c)) total += typeof n === 'number' && Number.isFinite(n) ? n : 0;
  const done = (c.done ?? 0) + (c.dropped ?? 0);

  const agents = agentsByLiveness(plan.agents ?? []);
  const shown = agents.slice(0, HUD_PLAN_AVATARS_SHOWN);
  const who = agents
    .filter((a) => a.intent && a.intent.trim())
    .slice(0, HUD_PLAN_WHO_SHOWN)
    .map((a) => `${shortAssignee(a.ownerId)}: ${(a.intent as string).trim()}`)
    .join(' · ');

  return {
    editedSec: ageSec(plan.updated, nowMs),
    workedSec,
    itemsDone: total > 0 ? done : null,
    itemsTotal: total > 0 ? total : null,
    avatars: shown.map((a) => ({
      ownerId: a.ownerId,
      handle: shortAssignee(a.ownerId),
      initials: avatarInitials(a.ownerId),
      live: a.live ?? null,
      colorIndex: avatarColorIndex(a.ownerId),
    })),
    avatarsOverflow: Math.max(0, agents.length - shown.length),
    liveCount: agents.filter((a) => a.live === true).length,
    // D-003: straight off itemCounts, the same source toPlanCard's badges read.
    needsHumanCount: c['needs-human'] ?? 0,
    blockedCount: c.blocked ?? 0,
    who: who || null,
  };
}

export function toPlanCard(
  plan: HudPlanInput,
  nowMs: number,
  sort: HudPlanSort = HUD_DEFAULT_PLAN_SORT,
): HudEntityCard {
  const column = planColumn(plan);
  const since = ageSec(plan.updated, nowMs);
  const badges: HudBadge[] = [];

  const c = plan.itemCounts ?? {};
  const needsHuman = c['needs-human'] ?? 0;
  if (needsHuman > 0) {
    badges.push({
      id: `${plan.slug}:needs-human`,
      label: `${needsHuman} needs you`,
      tone: 'warn',
      title: `${needsHuman} item${needsHuman === 1 ? '' : 's'} on this plan need a human decision`,
    });
  }
  const wip = c.wip ?? 0;
  if (wip > 0) {
    badges.push({ id: `${plan.slug}:wip`, label: `${wip} wip`, tone: 'good', title: `${wip} item${wip === 1 ? '' : 's'} in flight` });
  }
  const blocked = c.blocked ?? 0;
  if (blocked > 0) {
    badges.push({ id: `${plan.slug}:blocked`, label: `${blocked} blocked`, tone: 'bad', title: `${blocked} item${blocked === 1 ? '' : 's'} blocked` });
  }
  const todo = c.todo ?? 0;
  if (todo > 0) {
    badges.push({ id: `${plan.slug}:todo`, label: `${todo} todo`, tone: 'neutral', title: `${todo} item${todo === 1 ? '' : 's'} not started` });
  }
  if (plan.archived) {
    badges.push({ id: `${plan.slug}:archived`, label: 'archived', tone: 'neutral' });
  }

  // P-007: WHO can this card be found by. The recorded owner (P-006) PLUS the
  // roster agents currently on the plan — several identities, like a goal's
  // agent list, and for the same identityMatches reason: filtering by `su-76a`
  // should surface the plans su-76a is working, not only the ones it owns.
  // Deduped by ownerId (the owner is often also on the roster); still
  // UNDEFINED when neither source names anyone — never a fabricated stand-in.
  const identities: HudCardIdentity[] = [];
  const seenIds = new Set<string>();
  if (plan.owner) {
    identities.push({ ownerId: plan.owner, agentHandle: shortAssignee(plan.owner) });
    seenIds.add(plan.owner);
  }
  for (const a of plan.agents ?? []) {
    if (seenIds.has(a.ownerId)) continue;
    seenIds.add(a.ownerId);
    identities.push({
      ownerId: a.ownerId,
      agentHandle: shortAssignee(a.ownerId),
      live: a.live ?? null,
      sessionState: a.sessionState ?? null,
    });
  }

  return {
    id: plan.slug,
    ref: plan.slug,
    title: plan.title?.trim() || plan.slug,
    column,
    // `nextAction` is the plan's own answer to "what happens next", authored
    // by whoever wrote the plan — always better than a derived count line.
    reason: plan.nextAction?.trim() || planCountsSummary(plan.itemCounts),
    context: plan.harnessSlug ?? null,
    badges,
    sinceSec: since,
    sortKey: planSortKey(plan, sort),
    identity:
      identities.length === 0
        ? undefined
        : identities.length === 1
          ? identities[0]
          : identities,
    // P-007: the enriched meta row + track. Always built for a plan card —
    // ✎/⚒ and items progress are meaningful with no roster join at all.
    plan: planCardMeta(plan, nowMs),
  };
}

/**
 * The picked sort axis, as a numeric key (`assemble` orders ascending).
 *
 * Both axes are most-recent-first, and a plan with no timestamp on the picked
 * axis SINKS rather than colonizing the top — an unknown date is not evidence
 * of recency. Under `last-work` that sink is a real population, not an edge
 * case: a plan nobody has ever run a work item on has no ⚒ at all, and showing
 * it below every worked plan is exactly the "width follows attention" ordering
 * D-004 picked.
 *
 * Uniform across columns, INCLUDING needs-you — see HUD_PLAN_SORTS' docblock
 * for why the goals/items boards' oldest-first inversion does not apply here.
 */
function planSortKey(plan: HudPlanInput, sort: HudPlanSort): number {
  const t =
    sort === 'last-work'
      ? typeof plan.lastWorkAtMs === 'number' ? plan.lastWorkAtMs : Number.NaN
      : plan.updated ? new Date(plan.updated).getTime() : Number.NaN;
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return -t;
}

/** needs-you sorts oldest-first, everything else newest-first (see `assemble`).
 *  A row with no timestamp sinks to the bottom of either ordering rather than
 *  colonizing the top — an unknown date is not evidence of urgency. */
function sortKeyFor(column: HudEntityColumnId, iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : Number.NaN;
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return column === 'needs-you' ? t : -t;
}

export function buildPlanBoard(
  plans: HudPlanInput[],
  opts: HudEntityBuildOptions & { sort?: HudPlanSort },
): HudEntityBoard {
  return assemble(
    plans.map((p) => toPlanCard(p, opts.nowMs, opts.sort)),
    PLAN_COLUMN_EMPTY,
    opts,
  );
}

/* ── goals (goal-mode-2026-08-07 P-020) ──────────────────────────────────── */

/**
 * The goal statuses that are TERMINAL — reached, and advancing no further.
 *
 * Kept deliberately in lockstep with the canonical write vocabulary
 * (`GOAL_STATUSES = ['active','achieved','killed','paused']` in
 * `packages/agent-mcp/src/tools/goals/create.ts`, enforced by `z.enum` on both
 * `goals:create` and `goals:update`), because a hand-spelled copy of an enum
 * drifts silently and this one did:
 *
 * It previously read `['closed','done','achieved','abandoned']` — omitting
 * `killed`, the transition GOAL mode's contract MANDATES when a kill criterion
 * trips ("closing is the half that stops the ratchet"), while listing three
 * statuses `z.enum` rejects outright. A killed goal therefore matched nothing
 * here and fell through to needs-you / working / ready — rendering on the
 * owner's board as a LIVE goal, and asking them to act on a goal they had
 * deliberately killed. That is precisely the outcome precedence rule 1 below
 * exists to prevent (WI-37520).
 *
 * Exported so the test can assert the two vocabularies against each other; the
 * canonical enum is NOT imported here on purpose, as this module is pure and
 * browser-bundled and must not pull the tool graph in.
 */
export const GOAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['achieved', 'killed']);

/**
 * Which column a goal belongs in — keyed on WHAT IT IS WAITING ON, not on its
 * status string alone.
 *
 * The precedence is the interesting part, so it is stated rather than left to
 * be reverse-engineered from the `if` order:
 *
 *   1. TERMINAL first. A closed goal's leftover needs-human items are moot;
 *      routing it to `needs-you` would ask the owner to act on a finished goal.
 *   2. needs-you BEFORE paused. Both are owner actions, but `needsHuman` is a
 *      CONCRETE ask ("3 items are parked on you") while a pause is a state. A
 *      paused goal that also has asks still surfaces the pause — as a badge, so
 *      the fact is never lost, it just does not outrank the actionable thing.
 *   3. paused ⇒ blocked. Nothing on a paused goal advances until a human
 *      resumes it, which is exactly what `blocked` means on this board.
 *   4. open work ⇒ working; otherwise ⇒ ready ("active, but nothing is moving"),
 *      which is the state most worth noticing and the one a status field alone
 *      cannot express: a goal can be `active` and completely idle.
 *
 * Pure — no clock, no I/O.
 */
export function goalColumn(goal: HudGoalInput): HudEntityColumnId {
  const status = (goal.status ?? '').toLowerCase();
  if (GOAL_TERMINAL_STATUSES.has(status)) return 'done';
  if ((goal.needsHuman ?? 0) > 0) return 'needs-you';
  if (status === 'paused' || status === 'blocked') return 'blocked';
  if ((goal.openWorkItems ?? 0) > 0) return 'working';
  return 'ready';
}

/** `$310 / $500` — or bare spend when no ceiling was set. Pure. */
export function goalSpendLabel(goal: HudGoalInput): string {
  const spend = Math.round(goal.spendUsd ?? 0);
  if (goal.budgetCents == null) return `$${spend}`;
  return `$${spend} / $${Math.round(goal.budgetCents / 100)}`;
}

/**
 * "Showing 100 of 214 goals" — the disclosure that stops a capped list reading
 * as the whole set (EI-20080280064869122, dropped plan item P-014).
 *
 * The board renders whatever `goals.list` returned, and that query is capped.
 * Without this line a truncated board is pixel-identical to a complete one:
 * the owner sees goals, none of them wrong, and no reason to suspect absence.
 * Silent UNDER-reporting on a steering surface is the failure direction that
 * matters — a goal you cannot see is a goal you cannot stop.
 *
 * Returns null when nothing is hidden, so the notice slot stays empty in the
 * ordinary case rather than carrying a permanent "showing all N" banner.
 *
 * ⚠ `total` is the resolver's UNBOUNDED count, never `goals.length`. Passing
 * the array's own length here would make the check `shown > shown` — always
 * false, a disclosure that can never fire, and indistinguishable from a
 * working one until the day it is needed.
 */
export function goalsTruncationNotice(
  shown: number,
  total: number | null | undefined,
): string | null {
  if (total == null || !Number.isFinite(total)) return null;
  if (total <= shown) return null;
  return `Showing ${shown} of ${total} goals — this list is capped, so ${total - shown} more exist than are on screen.`;
}

/**
 * How many pot names fit in the chip before it becomes a count again. Two:
 * the chip shares a row capped at MAX_CHIPS=4, and a third name pushes the
 * label past what reads at a glance.
 */
const POT_NAMES_SHOWN = 2;

/**
 * The pots chip: WHICH pots pursue this goal, not merely how many
 * (goals-tab-improvement-2026-08-09 P-007, D-022).
 *
 * ONE chip, in the slot the bare count used to occupy. That is a constraint,
 * not a preference: the card renders only the first MAX_CHIPS (4) badges and a
 * goal can already spend three on needs-you / paused / open, so a chip PER pot
 * would routinely push the spend-vs-ceiling badge off the card — evicting one
 * of the two things that can actually stop a goal in order to say who is
 * working on it. Naming them inside the existing slot costs nothing and answers
 * the question the count only gestured at.
 *
 * ⚠ OVERFLOW COUNTS FROM `potCount`, NOT from the array. The array is a bounded
 * sample (POT_SAMPLE_LIMIT server-side), so `pots.length` is how many names
 * arrived, not how many exist — a goal with forty pots must still say "+38",
 * and deriving that from the sample would silently under-report it.
 *
 * Falls back to the old count-only chip when no sample arrived, so a payload
 * from before this shipped degrades to the previous behaviour rather than
 * losing the signal entirely.
 */
export function goalPotsChip(goal: HudGoalInput): HudBadge | null {
  const total = goal.potCount ?? 0;
  const sample = (goal.pots ?? []).filter((p) => p && p.harnessSlug);
  if (total <= 0 && sample.length === 0) return null;

  if (sample.length === 0) {
    return {
      id: `${goal.id}:pots`,
      label: `${total} pot${total === 1 ? '' : 's'}`,
      tone: 'neutral',
      title: `${total} pot${total === 1 ? '' : 's'} serve this goal`,
    };
  }

  const shown = sample.slice(0, POT_NAMES_SHOWN);
  const hidden = Math.max(0, (total || sample.length) - shown.length);
  const shared = sample.filter((p) => (p.servesGoals ?? 1) > 1);

  let label = shown.map((p) => p.harnessSlug).join(', ');
  if (hidden > 0) label += ` +${hidden}`;
  // D-021's visible face. In the LABEL rather than only the tooltip: a reader
  // adding two goals' spend together never hovers to find out they overlap.
  if (shared.length > 0) label += ' · shared';

  const lines = [
    `${total || sample.length} pot${(total || sample.length) === 1 ? '' : 's'} pursue this goal: ${sample
      .map((p) => (p.role ? `${p.harnessSlug} (${p.role})` : p.harnessSlug))
      // The title lists the whole SAMPLE; the ellipsis fires only when the goal
      // has pots the sample itself could not carry.
      .join(', ')}${total > sample.length ? ', …' : ''}`,
  ];
  for (const p of shared) {
    lines.push(
      `${p.harnessSlug} also serves ${(p.servesGoals ?? 1) - 1} other goal${(p.servesGoals ?? 1) - 1 === 1 ? '' : 's'} — its spend counts in FULL against each, so these goals' costs do not add up.`,
    );
  }

  return { id: `${goal.id}:pots`, label, tone: 'neutral', title: lines.join('\n') };
}

/**
 * Why there is no projected ceiling date. Rendered as a REASON, never as a
 * blank or a dash: the whole point of P-003 is that a missing rate is itself
 * information, and an empty slot reads as "nothing to worry about".
 */
export type GoalBurnEtaAbsence =
  | 'no-ceiling'
  | 'no-recent-spend'
  | 'already-over'
  | 'beyond-horizon';

/** The spend RATE behind the card's spend level. Pure. */
export interface GoalBurn {
  /** Dollars per day across `windowDays`. */
  perDayUsd: number;
  /** The denominator actually used — NOT necessarily the wire's window. */
  windowDays: number;
  /** True when the goal is younger than the wire window, so no caller may
   *  print "last 7 days" against this rate. */
  windowShort: boolean;
  /** Epoch ms the ceiling lands at this rate, or null — then read `etaAbsent`. */
  ceilingEtaMs: number | null;
  etaAbsent: GoalBurnEtaAbsence | null;
}

/** Past a year out the projection is arithmetic, not information. */
const BURN_HORIZON_DAYS = 365;

/** A goal minutes old would otherwise divide by ~0 and report millions/day. */
const MIN_BURN_WINDOW_DAYS = 1 / 24;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The goal's recent burn, and when the ceiling lands if it keeps up.
 *
 * ⚠ RETURNS NULL WHEN NOTHING MEASURED THE WINDOW — and that is the whole
 * contract. `spendRecentUsd` absent means "no reading", which is NOT the same
 * as a reading of zero, and collapsing the two would put `$0/day` on a goal
 * that might be burning fast. That is the identical unknown-is-not-absent
 * failure P-002 fixed one item earlier on this same surface, and it fails in
 * the same direction: toward reassurance. A measured zero is a real, useful
 * answer and comes back as `perDayUsd: 0` with `etaAbsent: 'no-recent-spend'`.
 *
 * ⚠ THE DENOMINATOR IS DELIBERATELY ASYMMETRIC. It is the wire's window
 * SHORTENED to the goal's own age, never lengthened. Shortening can only raise
 * the rate, and a raised rate can only pull the projected ceiling date EARLIER.
 * That is the safe direction for a warning: warning early costs the reader a
 * glance, warning late costs them the ceiling. A goal two days old that has
 * spent $100 is burning $50/day, and reporting $14/day because the window is
 * nominally seven would understate it by 3.5x on the one surface whose job is
 * advance notice.
 */
export function goalBurn(goal: HudGoalInput, nowMs: number): GoalBurn | null {
  const recent = goal.spendRecentUsd;
  const wireWindowDays = goal.spendRecentWindowDays;
  if (recent == null || !Number.isFinite(recent)) return null;
  if (wireWindowDays == null || !Number.isFinite(wireWindowDays) || wireWindowDays <= 0) {
    return null;
  }

  const ageInSec = ageSec(goal.createdAt, nowMs);
  const ageDays = ageInSec == null ? null : ageInSec / (24 * 60 * 60);
  const windowDays = Math.max(
    MIN_BURN_WINDOW_DAYS,
    ageDays == null ? wireWindowDays : Math.min(wireWindowDays, ageDays),
  );
  const perDayUsd = Math.max(0, recent) / windowDays;
  const base = { perDayUsd, windowDays, windowShort: windowDays < wireWindowDays };

  const ceilingUsd = goal.budgetCents == null ? null : goal.budgetCents / 100;
  if (ceilingUsd == null || ceilingUsd <= 0) {
    return { ...base, ceilingEtaMs: null, etaAbsent: 'no-ceiling' };
  }
  const spend = goal.spendUsd ?? 0;
  if (spend >= ceilingUsd) {
    return { ...base, ceilingEtaMs: null, etaAbsent: 'already-over' };
  }
  if (perDayUsd <= 0) {
    return { ...base, ceilingEtaMs: null, etaAbsent: 'no-recent-spend' };
  }
  const daysLeft = (ceilingUsd - spend) / perDayUsd;
  if (daysLeft > BURN_HORIZON_DAYS) {
    return { ...base, ceilingEtaMs: null, etaAbsent: 'beyond-horizon' };
  }
  return { ...base, ceilingEtaMs: nowMs + daysLeft * MS_PER_DAY, etaAbsent: null };
}

/**
 * `$52/day`. Deliberately finer-grained than `moneyish`'s whole dollars: a rate
 * is routinely under $10, where rounding to the dollar turns a real burn into
 * `$0/day` — a false zero on the number this feature exists to surface.
 */
export function burnRateText(perDayUsd: number): string {
  const digits = perDayUsd >= 10 ? 0 : perDayUsd >= 1 ? 1 : 2;
  return `$${perDayUsd.toFixed(digits)}/day`;
}

/** The card chip: the rate alone. Null when nothing measured it. */
export function goalBurnLabel(goal: HudGoalInput, nowMs: number): string | null {
  const burn = goalBurn(goal, nowMs);
  if (!burn) return null;
  return burnRateText(burn.perDayUsd);
}

/** Close enough that the projected date is promoted onto the card itself. */
const BURN_WARN_HORIZON_MS = 7 * MS_PER_DAY;

/** `Aug 14`. Day precision only — the projection is a linear extrapolation from
 *  one window, and an hour on it would claim a precision it does not have. */
export function burnEtaText(etaMs: number): string {
  return new Date(etaMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** How the window is described. Never says "7 days" when it measured less. */
function burnWindowText(burn: GoalBurn): string {
  if (!burn.windowShort) {
    const d = Math.round(burn.windowDays);
    return `the last ${d} day${d === 1 ? '' : 's'}`;
  }
  return burn.windowDays < 1
    ? 'this goal’s first hours'
    : `this goal’s ${Math.round(burn.windowDays)}-day life so far`;
}

/**
 * The full sentence. Every no-date case names its REASON — an unexplained
 * missing projection is exactly the blank this item set out to remove.
 */
export function burnTitle(burn: GoalBurn, goal: HudGoalInput): string {
  const rate = `Fleet spend is running at ${burnRateText(burn.perDayUsd)} over ${burnWindowText(burn)}`;
  switch (burn.etaAbsent) {
    case 'no-ceiling':
      return `${rate}. No ceiling is set, so there is nothing for it to run into.`;
    case 'already-over':
      return `${rate}. The ceiling has already been reached.`;
    case 'no-recent-spend':
      return `${rate} — nothing has been spent in that window, so no ceiling date can be projected.`;
    case 'beyond-horizon':
      return `${rate}. At that rate the ceiling is over a year out.`;
    default:
      break;
  }
  const ceiling = goal.budgetCents == null ? null : goal.budgetCents / 100;
  return (
    `${rate}. At that rate the ${ceiling == null ? 'ceiling' : `$${Math.round(ceiling)} ceiling`}` +
    ` lands around ${burnEtaText(burn.ceilingEtaMs as number)}.`
  );
}

/**
 * How long a goal has been silent, and whether that silence MEANS anything
 * (goals-tab-improvement-2026-08-09 P-004 / D-017).
 *
 * The states exist because "how long since this changed" and "should I worry"
 * are different questions, and the board previously answered only the first —
 * flatly, so a goal silent nine days looked like one silent nine minutes.
 *
 *   - `expected`   — terminal, paused or blocked. Silence is the POINT; saying
 *                    anything here would manufacture a false alarm.
 *   - `unmeasured` — no activity reading at all (no work item has ever been
 *                    stamped to this goal). NOT "silent forever": the P-002
 *                    unmeasured-is-not-zero rule, applied a third time.
 *   - `moving`     — measured and inside the threshold.
 *   - `stalled`    — claims to be running, nothing has moved.
 *   - `abandoned`  — stalled AND nothing is even queued to move it.
 */
export type GoalSilenceState = 'expected' | 'unmeasured' | 'moving' | 'stalled' | 'abandoned';

export interface GoalSilence {
  state: GoalSilenceState;
  /** Seconds since work last moved — null whenever there is no reading. */
  silentSec: number | null;
}

/** Silent this long on a goal that claims to be running, and we say so. */
const GOAL_STALE_AFTER_SEC = 24 * 60 * 60;
/** Silent this long with NOTHING queued, and "stalled" understates it. */
const GOAL_ABANDONED_AFTER_SEC = 72 * 60 * 60;

export function goalSilence(goal: HudGoalInput, nowMs: number): GoalSilence {
  const status = (goal.status ?? '').toLowerCase();
  // A finished goal is supposed to be quiet, and a paused/blocked one is quiet
  // ON PURPOSE — escalating either would invent exactly the dishonesty Phase A
  // exists to remove. Keyed on STATUS, not on the column: goalColumn reports
  // `needs-you` for a paused goal that also has an ask, and that goal is still
  // deliberately stopped.
  if (GOAL_TERMINAL_STATUSES.has(status) || status === 'paused' || status === 'blocked') {
    return { state: 'expected', silentSec: null };
  }

  // Aged off lastActivityAt, NEVER off updatedAt: only `goals:update` writes
  // that one, so a busy goal nobody has retitled would read as maximally stale.
  const silentSec = ageSec(goal.lastActivityAt, nowMs);
  if (silentSec == null) return { state: 'unmeasured', silentSec: null };
  if (silentSec < GOAL_STALE_AFTER_SEC) return { state: 'moving', silentSec };

  // Recent spend is an INDEPENDENT sign of life: a goal can be burning money
  // inside one long agent turn while no work item has moved yet. `?? 0` is the
  // safe direction HERE (unlike everywhere else in this file) precisely because
  // it is only ever used to DOWNGRADE the alarm — an absent reading must not be
  // treated as evidence of life.
  const spendingNow = (goal.spendRecentUsd ?? 0) > 0;
  const queued = (goal.openWorkItems ?? 0) > 0;
  if (!queued && !spendingNow && silentSec >= GOAL_ABANDONED_AFTER_SEC) {
    return { state: 'abandoned', silentSec };
  }
  return { state: 'stalled', silentSec };
}

/** A goal row rendered as one of its parent's subdirectives (D-006). */
export function toSubGoal(goal: HudGoalInput): HudSubGoal {
  const status = (goal.status ?? '').toLowerCase();
  return {
    id: goal.id,
    ref: goal.id.slice(0, 8),
    title: goal.title?.trim() || goal.id,
    status,
    terminal: GOAL_TERMINAL_STATUSES.has(status),
  };
}

export function toGoalCard(
  goal: HudGoalInput,
  nowMs: number,
  subGoals: HudSubGoal[] = [],
): HudEntityCard {
  const column = goalColumn(goal);
  const status = (goal.status ?? '').toLowerCase();
  const badges: HudBadge[] = [];

  const needsHuman = goal.needsHuman ?? 0;
  if (needsHuman > 0) {
    badges.push({
      id: `${goal.id}:needs-human`,
      label: `${needsHuman} needs you`,
      tone: 'warn',
      title: `${needsHuman} item${needsHuman === 1 ? '' : 's'} under this goal need a human decision`,
    });
  }
  // Rendered even when the goal sorted into `needs-you` — see the precedence
  // note on goalColumn: the column loses the pause, the badge keeps it.
  if (status === 'paused') {
    badges.push({ id: `${goal.id}:paused`, label: 'paused', tone: 'neutral', title: 'Nothing under this goal advances until it is resumed' });
  }
  const open = goal.openWorkItems ?? 0;
  if (open > 0) {
    badges.push({ id: `${goal.id}:open`, label: `${open} open`, tone: 'good', title: `${open} open work item${open === 1 ? '' : 's'} stamped to this goal` });
  }
  const potChip = goalPotsChip(goal);
  if (potChip) badges.push(potChip);
  // The spend chip goes `bad` only at/over the ceiling — the second of the two
  // things that can actually stop a goal, so it earns an alarm tone.
  const ceilingUsd = goal.budgetCents == null ? null : goal.budgetCents / 100;
  const overCeiling = ceilingUsd != null && (goal.spendUsd ?? 0) >= ceilingUsd;
  badges.push({
    id: `${goal.id}:spend`,
    label: goalSpendLabel(goal),
    tone: overCeiling ? 'bad' : 'neutral',
    title: overCeiling
      ? 'Fleet spend has reached this goal’s ceiling'
      : 'Fleet spend — what this goal’s CHILD agents cost. The goal agent’s own turns are subscription-billed.',
  });
  // The RATE beside the level (P-003). Absent entirely when nothing measured
  // the window — goalBurn returns null rather than a reassuring $0/day.
  const burn = goalBurn(goal, nowMs);
  if (burn && !overCeiling) {
    // The projected date is promoted INTO the label only when it is close
    // enough to act on. A date eleven months out is arithmetic; a date next
    // Tuesday is the warning this item exists to give, and burying that in a
    // tooltip on the glance surface would be the same miss in a new place.
    const eta = burn.ceilingEtaMs;
    const soon = eta != null && eta - nowMs <= BURN_WARN_HORIZON_MS;
    badges.push({
      id: `${goal.id}:burn`,
      label: soon
        ? `${burnRateText(burn.perDayUsd)} · ceiling ~${burnEtaText(eta as number)}`
        : burnRateText(burn.perDayUsd),
      tone: soon ? 'bad' : 'neutral',
      title: burnTitle(burn, goal),
    });
  }

  // SILENCE (P-004). The chip carries the VERDICT, never the duration — the
  // age already sits in the card header, and repeating it here would spend the
  // glance surface's scarcest space saying the same thing twice.
  const silence = goalSilence(goal, nowMs);
  if (silence.state === 'stalled' || silence.state === 'abandoned') {
    const abandoned = silence.state === 'abandoned';
    badges.push({
      id: `${goal.id}:silence`,
      label: abandoned ? 'abandoned' : 'stalled',
      tone: abandoned ? 'bad' : 'warn',
      title: abandoned
        ? 'No work item has moved here in days, nothing is open, and nothing is spending — this goal is active in name only'
        : 'This goal is running, but no work item under it has moved recently',
    });
  }

  return {
    id: goal.id,
    ref: goal.id.slice(0, 8),
    title: goal.title?.trim() || goal.id,
    column,
    // The kill criterion IS the reason line. It is the one sentence that says
    // when this goal stops, and a goal with none can never stop — so its
    // absence is stated outright rather than falling back to a count summary
    // that would read as though the card were merely uninformative.
    reason: goal.killCriterion?.trim() || 'No kill criterion — nothing can stop this goal',
    context: null,
    badges,
    // The age is ACTIVITY, not the definition-edit time it used to show. Null
    // when nothing has ever moved, which formatAge renders as an em-dash —
    // honest, where "0s" or the creation date would both be inventions.
    sinceSec: silence.silentSec,
    // ORDERING may fall back where DISPLAY must not: a total order is required
    // to lay the column out at all, so a goal with no activity yet sorts by
    // when it was defined rather than dropping to the bottom as unknown.
    sortKey: sortKeyFor(column, goal.lastActivityAt ?? goal.updatedAt),
    ...(subGoals.length > 0 ? { subGoals } : {}),
    // P-006. ALL the goal's agents, not just the first — see identityMatches.
    // Undefined (not []) when there are none, so "no agent on this goal" stays
    // one explicit state rather than an empty list that reads as "loaded, none".
    // P-001: `live`/`sessionState` are carried THROUGH, not dropped. The payload
    // resolves them fresh on every read (sync-resolver/goals.ts), and a board
    // that discarded them here would keep showing a dead holder identically to a
    // live one — the exact defect the resolver was built to end, surviving one
    // layer higher up.
    identity:
      goal.agents && goal.agents.length > 0
        ? goal.agents.map((a) => ({
            ownerId: a.ownerId,
            agentHandle: shortAssignee(a.ownerId),
            live: a.live ?? null,
            sessionState: a.sessionState ?? null,
          }))
        : undefined,
  };
}

/** The lane the "+ Start a goal" card lives in — the leftmost one. */
export const GOAL_START_COLUMN: HudEntityColumnId = 'needs-you';
/** Stable id for the action card, so a click handler and a test name the same thing. */
export const GOAL_START_CARD_ID = 'goal:start';

/**
 * The "+ Start a goal" card — the product's ONLY path to starting a goal
 * (goals-tab-improvement-2026-08-09 P-015).
 *
 * It exists because the rail deletion took the previous kickoff with it: the
 * HUD could render a goal an agent PROPOSED, but nothing on the surface could
 * originate one. Clicking it opens the composer, and submitting that composer
 * spawns the GOAL-mode agent (D-008 — the composer is the spawn, deliberately
 * overriding goal-mode-2026-08-07 P-022's conversational kickoff).
 *
 * `reason` doubles as the empty state: with no goals on the board this card is
 * the only thing in the column, so it has to say what the board would
 * otherwise have said.
 */
export function startGoalCard(opts: { goalCount: number }): HudEntityCard {
  return {
    id: GOAL_START_CARD_ID,
    ref: '+',
    title: 'Start a goal',
    column: GOAL_START_COLUMN,
    reason:
      opts.goalCount === 0
        ? 'No goals yet — start one and an agent takes it from here'
        : 'Outcome, kill criterion, ceiling — then an agent owns it',
    context: null,
    badges: [],
    sinceSec: null,
    // Prepended explicitly, so this is only a tiebreak safety net.
    sortKey: Number.NEGATIVE_INFINITY,
    open: { kind: 'start-goal' },
  };
}

/**
 * Split the goal rows into the cards that get a lane and the subdirectives that
 * get nested inside one (P-017 / D-006).
 *
 * A child is NOT lane-able: it steers its parent's agent rather than owning one,
 * so it has "no independent life on the board". Before this, `buildGoalBoard`
 * mapped every row through `toGoalCard`, which gave each child its own card in
 * whatever lane its own status implied — exactly the independent life D-006
 * forbids, and the reason a reader saw a directive and its goal as peers.
 *
 * ORPHANS ARE PROMOTED, NOT DROPPED. A child whose parent is absent from this
 * set — outside the fetched window, filtered away, or deleted — has no card to
 * nest inside, and silently discarding it would remove a real goal from the
 * board with nothing saying so. It is rendered as a top-level card whose
 * `context` states that its parent is not on the board, which is the honest
 * reading and keeps every fetched row visible exactly once.
 *
 * Exported for the test: the partition is the whole D-006 mechanism, and it is
 * worth asserting directly rather than only through a rendered board.
 */
export function partitionGoals(goals: HudGoalInput[]): {
  roots: HudGoalInput[];
  childrenByParent: Map<string, HudSubGoal[]>;
  orphans: HudGoalInput[];
} {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const roots: HudGoalInput[] = [];
  const orphans: HudGoalInput[] = [];
  const childrenByParent = new Map<string, HudSubGoal[]>();

  /**
   * Walk to the ROOT ancestor, not merely to the immediate parent.
   *
   * `goals.parent_id` is a free self-FK, so A←B←C is representable, and attaching
   * C to B would strand it: only roots and orphans get cards, so a grandchild
   * nested under a goal that is itself nested renders NOWHERE. That is the same
   * silent loss the orphan branch exists to prevent, one level deeper.
   *
   * Flattening to the root is also the semantically right answer, not just the
   * safe one: under D-006 the ROOT is the agent, and every descendant — at any
   * depth — is a direction that agent was pointed in. So they all belong on the
   * root's card.
   *
   * Returns null when the chain leaves this set (→ orphan) or cycles. A cycle is
   * impossible to render and must not hang the board, so `seen` bounds the walk;
   * the row is treated as an orphan, which keeps it VISIBLE rather than dropping
   * it — the honest failure direction for data we cannot interpret.
   */
  function rootOf(start: HudGoalInput): HudGoalInput | null {
    let cur = start;
    const seen = new Set<string>([cur.id]);
    for (;;) {
      const parentId = cur.parentId ?? null;
      if (!parentId || parentId === cur.id) return cur;
      const next = byId.get(parentId);
      if (!next) return null;
      if (seen.has(next.id)) return null;
      seen.add(next.id);
      cur = next;
    }
  }

  for (const g of goals) {
    const parentId = g.parentId ?? null;
    // Self-parenting would nest a card inside itself and drop it from the board.
    if (!parentId || parentId === g.id) {
      roots.push(g);
      continue;
    }
    const root = rootOf(g);
    if (!root) {
      orphans.push(g);
      continue;
    }
    const list = childrenByParent.get(root.id);
    if (list) list.push(toSubGoal(g));
    else childrenByParent.set(root.id, [toSubGoal(g)]);
  }
  return { roots, childrenByParent, orphans };
}

export function buildGoalBoard(goals: HudGoalInput[], opts: HudEntityBuildOptions): HudEntityBoard {
  const { roots, childrenByParent, orphans } = partitionGoals(goals);

  const cards = [
    ...roots.map((g) => toGoalCard(g, opts.nowMs, childrenByParent.get(g.id) ?? [])),
    ...orphans.map((g) => {
      const card = toGoalCard(g, opts.nowMs, childrenByParent.get(g.id) ?? []);
      return {
        ...card,
        // Says WHY this reads as a top-level card when it is really a child —
        // without it the promotion would look like the flat rendering P-017 set
        // out to remove.
        context: 'Subdirective — its goal is not on this board',
      };
    }),
  ];

  const board = assemble(cards, GOAL_COLUMN_EMPTY, opts);

  /* While the owner is SEARCHING, the board shows matches and nothing else. An
     action card surviving the filter would sit among results it does not match
     — and, worse, would keep the column non-empty, suppressing the "No goals
     match …" message that tells the owner their query found nothing. */
  if ((opts.query ?? '').trim()) return board;

  /* The card is NOT counted. `counts`/`total` describe how many GOALS exist,
     and this is not one: counting it would report "1" for an empty board, which
     is precisely the lie this module guards against everywhere else (the
     per-column "+N more", the `notice` docblock in HudEntityColumns). The
     consequence is that `total` can be 0 while a column has a card — which is
     why HudEntityColumns gates its empty state on "are there cards", not on the
     count. */
  return {
    ...board,
    columns: board.columns.map((c) =>
      c.id === GOAL_START_COLUMN
        ? { ...c, cards: [startGoalCard({ goalCount: board.total }), ...c.cards] }
        : c,
    ),
  };
}

/* ── work items ──────────────────────────────────────────────────────────── */

/**
 * Narrow the shared theme's `ToneKey` to the board's `BadgeTone`.
 *
 * `SEVERITY_TONE` is reused from `harness/theme` rather than kept as a second
 * local copy — but the theme's tone vocabulary is WIDER than a badge's: it
 * carries presentation-only keys (`fg`, …) that no chip knows how to render.
 * Every value currently mapped happens to be a legal badge tone, which is
 * exactly what makes a bare cast tempting and wrong: it would compile today
 * and start emitting an unstyleable chip the day somebody maps a severity to
 * one of the other keys.
 *
 * So this narrows by CHECKING, and falls back to the neutral chip for anything
 * outside the badge vocabulary — the same "degrade to something renderable
 * rather than trust the input" posture `workItemColumn` takes for an
 * unrecognized state.
 */
const BADGE_TONES: ReadonlySet<string> = new Set<BadgeTone>([
  'neutral',
  'accent',
  'good',
  'warn',
  'bad',
]);

export function toBadgeTone(tone: string | undefined | null): BadgeTone {
  return tone && BADGE_TONES.has(tone) ? (tone as BadgeTone) : 'neutral';
}

export function toWorkItemCard(item: HudWorkItemInput, nowMs: number): HudEntityCard {
  const column = workItemColumn(item.state);
  const badges: HudBadge[] = [
    { id: `${item.id}:kind`, label: item.kind, tone: 'neutral', workItemKind: item.kind },
  ];
  if (item.severity) {
    badges.push({
      id: `${item.id}:sev`,
      label: item.severity,
      tone: toBadgeTone(SEVERITY_TONE[item.severity.toLowerCase() as keyof typeof SEVERITY_TONE]),
    });
  }
  if (item.assignee) {
    badges.push({
      id: `${item.id}:assignee`,
      label: shortAssignee(item.assignee),
      tone: 'accent',
      title: `Assigned to ${item.assignee}`,
    });
  }
  return {
    id: item.id,
    ref: item.id,
    title: item.title?.trim() || item.id,
    column,
    reason: normalizeState(item.state) || null,
    context: item.planSlug ?? null,
    badges,
    sinceSec: ageSec(item.updatedAt, nowMs),
    sortKey: sortKeyFor(column, item.updatedAt),
    // Set here too, not just on asks: `open` is the ONE thing the click handler
    // reads, so a card without it is a dead button by construction. A real work
    // item is its own destination — `harnessSlug` stays null so the popup falls
    // back to the board's active harness, which is correct for these (unlike an
    // ask, they only ever render under a resolved harness).
    open: { kind: 'work-item', id: item.id, harnessSlug: null },
    // The assignee IS the agent id, so this board can filter by it today
    // ([owner 2026-08-10]). UNDEFINED when unassigned — deliberately not
    // `{ ownerId: null }`: an unassigned item has no owner to match, and a
    // present-but-empty identity is the shape most likely to be "fixed" later
    // into something that matches everything.
    //
    // `sessionId` is absent because a work item is not owned by one session —
    // its assignee outlives any single session, and inventing one would be the
    // fabrication D-003 forbids.
    identity: item.assignee
      ? { ownerId: item.assignee, agentHandle: shortAssignee(item.assignee) }
      : undefined,
  };
}

/** `su-709bb0d6-12de-…` → `su-709bb0d6`. Same treatment `shortHandle` gives a
 *  session's owner id, applied to an assignee (which is the same kind of id). */
export function shortAssignee(assignee: string): string {
  const m = /^([a-z]+)-([0-9a-f]{6,8})/i.exec(assignee);
  return m ? `${m[1]}-${m[2]}` : assignee;
}

/**
 * An unattributed ask rendered as a work-item card.
 *
 * This is the OTHER half of what P-009 moves. `hud-consolidation-2026-07-26`
 * P-002 established a hard gate before the sidebar Inbox could be retired
 * (D-001): every needs-human Decision with no owning agent must be visible
 * SOMEWHERE. It was visible as a strip above the session columns — exactly the
 * "section show the work items above" the owner asked to fold into a tab. So
 * the strip does not get deleted, it gets RE-HOMED into the Work items tab's
 * needs-you column, where it reads as what it is.
 *
 * Not every ask is a work item (an improvement triage, a dark-flag
 * ratification, an owner wall) — their kind rides on the card as a badge so
 * the distinction survives the move.
 */
/* The id grammar itself now lives in `@/lib/work-item-ref` — the chat's
 * status-card drill-in shipped the SAME anchored-whole-token bug independently
 * (also "unit tested green", also dead live), so the rule is shared rather than
 * spelled out twice. The shapes THIS caller must handle are recorded there.
 *
 *   · a card id is `ask:<ask.id>`, itself composite with the item LAST —
 *     `ask:work-item-needs-human:WI-1142`, `ask:owner-wall:work-item:WI-4271`
 *   · a card ref is a DISPLAY string ({@link askToCard} sets `ask.itemRef ?? kindLabel`),
 *     so it reads "Work item" / "Owner wall" whenever the ask has no itemRef — the
 *     case for every live card — and when itemRef IS set the curator writes it
 *     harness-qualified (`papercusp#WI-7`, see attention/adapters.test.ts). */

/** Which work item, if any, a Work-items board card opens.
 *
 *  Lives here rather than in HudView because the contract it reads is `askToCard`'s,
 *  directly below — the two drifted apart once already and the click silently died.
 *  An ask with no work item behind it (`ask:improvement-triage:1234`) still resolves
 *  to null, so it opens nothing instead of pointing the popup at a kind label. */
export function workItemIdForCard(card: Pick<HudEntityCard, 'id' | 'ref'>): string | null {
  if (WORK_ITEM_ID.test(card.id)) return card.id.toUpperCase();
  if (card.id.startsWith('ask:')) {
    return trailingWorkItemId(card.id) ?? trailingWorkItemId(card.ref);
  }
  return null;
}

/**
 * WHERE a click on a Work-items card lands (WI-6742, owner-reported: a card in
 * the "Needs you" column did nothing while every other column opened a popup).
 *
 * There is deliberately no "nothing" member. The bug was that a destination
 * could come back null while `HudEntityColumns` still rendered the card as a
 * `<button>` — board-wide, because the board supplies `onOpenCard`, not
 * per-card. A total function is what makes that unrepresentable: every card
 * carries somewhere to go, so a card that LOOKS activatable is.
 */
export type HudAskTarget =
  | { kind: 'work-item'; id: string; harnessSlug: string | null }
  | { kind: 'plan'; slug: string }
  | { kind: 'ask'; askId: string }
  /**
   * Not a destination — an ACTION. The Goals board's "+ Start a goal" card
   * opens the composer instead of a popup (goals-tab-improvement-2026-08-09
   * P-015/D-008: the composer IS the spawn).
   *
   * It rides this union rather than being pattern-matched out of the card id
   * for the WI-6742 reason the union exists at all: a click handler that
   * re-derives intent from an id is one unmatched string away from a dead
   * button, and this card has no entity id to match on.
   */
  | { kind: 'start-goal' };

/**
 * The ask → destination rule, in the owner's chosen order (2026-07-28: "entity
 * if there is one, else the ask").
 *
 * ⚠ The order is load-bearing and the work-item check MUST come first. An ask
 * frequently carries BOTH a work item and a `planSlug` — the latter as mere
 * context (`askToCard` renders it in the `context` slot for exactly that
 * reason) — so routing on the plan first would send every work-item-needs-human
 * ask to a plan popup instead of the item the human asked about.
 *
 * The `ask` case is a real destination, not a give-up: an improvement-triage or
 * standing-approval ask IS the thing to act on, and it carries its own
 * approve/resolve actions. That is also why an unmapped `ref.kind` degrades
 * here rather than to null — a new adapter can never reintroduce a dead button.
 */
export function askTargetFor(ask: HudAsk): HudAskTarget {
  const itemId = trailingWorkItemId(ask.itemRef) ?? trailingWorkItemId(ask.id);
  if (itemId) return { kind: 'work-item', id: itemId, harnessSlug: ask.harnessSlug ?? null };
  if (ask.ref?.kind === 'plan-item' && ask.ref.slug) {
    return { kind: 'plan', slug: ask.ref.slug };
  }
  return { kind: 'ask', askId: ask.id };
}

export function askToCard(ask: HudAsk, nowMs: number): HudEntityCard {
  const kindLabel = HUD_ASK_KIND_LABEL[ask.kind] ?? ask.kind;
  return {
    id: `ask:${ask.id}`,
    ref: ask.itemRef ?? kindLabel,
    title: ask.title,
    column: 'needs-you',
    reason: ask.itemRef ? kindLabel : null,
    context: ask.planSlug ?? ask.harnessSlug ?? null,
    badges: [{ id: `${ask.id}:kind`, label: kindLabel, tone: 'warn' }],
    sinceSec: ageSec(ask.occurredAt, nowMs),
    sortKey: sortKeyFor('needs-you', ask.occurredAt),
    open: askTargetFor(ask),
  };
}

/**
 * The Work items board: the harness's own work items, plus the unattributed
 * asks folded into needs-you.
 *
 * DEDUPE is load-bearing. An ask of kind `work-item-needs-human` names a work
 * item that is ALSO in the `workItems.byHarness` rows with
 * `state = 'needs-human'` — so without this the fold would render every such
 * item twice, in the same column, which is precisely the kind of double-count
 * that makes a board untrustworthy. The work item wins: it is the canonical
 * row, and it carries kind/severity/assignee the ask does not.
 *
 * ⚠ WI-6597 — this guard was INERT on the live board, in two independent ways,
 * and both are why it compares NORMALIZED IDS rather than raw ref strings:
 *
 *   1. `ask.itemRef` was null on 60/60 live cards (the attention adapter never
 *      populated it), so `!a.itemRef` short-circuited true and EVERY ask
 *      survived. Fixed upstream too, but the board must not depend on that: the
 *      ask's own `id` already ends in the work-item id
 *      (`work-item-needs-human:WI-1142`), so read the id from EITHER. A guard
 *      that only works when an optional upstream field is populated is a guard
 *      that silently stops working.
 *   2. Even with `itemRef` set it could not have matched: the curator writes it
 *      HARNESS-QUALIFIED (`papercusp#WI-1142`) while `known` held bare card ids
 *      (`WI-1142`), so `known.has(...)` was false for every populated ref too.
 *
 * Both collapse into one rule, the same one `workItemIdForCard` follows: a ref
 * token is a PATH with the id LAST — read the trailing segment via
 * `trailingWorkItemId`, never compare whole tokens. Hand-written `WI-7`-shaped
 * fixtures hide this (no producer emits that shape), so the tests use the real
 * strings — see work-item-ref.ts's warning.
 */
export function buildWorkItemBoard(
  items: HudWorkItemInput[],
  asks: HudAsk[],
  opts: HudEntityBuildOptions,
): HudEntityBoard {
  const itemCards = items.map((i) => toWorkItemCard(i, opts.nowMs));
  const known = new Set(
    itemCards.map((c) => trailingWorkItemId(c.id) ?? c.id.toUpperCase()),
  );
  const askCards = asks
    .filter((a) => {
      const id = trailingWorkItemId(a.itemRef) ?? trailingWorkItemId(a.id);
      return !id || !known.has(id);
    })
    .map((a) => askToCard(a, opts.nowMs));
  return assemble([...itemCards, ...askCards], ITEM_COLUMN_EMPTY, opts);
}
