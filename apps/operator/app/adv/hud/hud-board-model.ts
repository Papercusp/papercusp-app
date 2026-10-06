/**
 * hud-board-model — the pure derivation behind /adv/HUD's fleet board
 * (adv-hud-fleet-board-2026-07-25 P-002).
 *
 * The board answers ONE question: *where is the work piling up?* Its columns are
 * therefore DERIVED from live session state, never assigned by a human — which
 * is exactly why the board is not built on the repo's dnd-kit `Kanban` primitive
 * (plan D-001): a drag affordance would promise that moving a card changes the
 * session's state, and it cannot.
 *
 * Everything here is pure and clock-injected so the whole classification is
 * unit-testable without PG, without React, and without a real `Date.now()`. The
 * component layer does presentation only; if you find yourself deriving state in
 * a `.tsx` under this directory, it belongs here instead.
 *
 * The two columns that justify the surface are `blocked` and `stalled`. Both are
 * failure modes nobody raises a hand for: a gate that will never open, and an
 * agent that is nominally alive but has stopped moving. Everything else the
 * roster already showed; these are the ones that cost hours.
 */

import { deepEqual } from '@papercusp/rules';

import type { Liveness } from '@papercusp/operator-core/lib/liveness';
import type { NativeSessionHandle } from '@papercusp/operator-core/lib/native-session-handles';
// Mode chip label + hover come from the registry (pure data, zero imports of its
// own — safe in the SPA bundle) so the five official modes are explained here
// without this file keeping its own copy of what each one means.
import { modeChipLabel, modeChipTitle } from '@papercusp/operator-core/lib/modes/registry';
// THE display-name resolver (plan hud-session-display-names-2026-08-31, D-003).
// The OS terminal title resolves its headline through this same function, and
// R8 makes a second private `manualName ?? objective ?? handle` chain here the
// regression the plan exists to prevent — so the board imports it rather than
// growing one. `shortHandle` below stays: it is this file's own id FORMAT, which
// the resolver takes as an input, not a competing rule.
import {
  sessionDisplayName,
  type SessionDisplayNameSource,
} from '@papercusp/operator-core/lib/agent-tools/coordination/status-display';
// The ONE derivation of "is this session a goal's agent" (D-007/P-020) — pure,
// SPA-safe, and shared with the Goals tab so the two boards cannot disagree
// about which sessions this one hides.
import { isGoalSessionModes } from '@papercusp/operator-core/lib/modes/goal-session';

/**
 * Sentinel for the "all fleets" chip. Not a real slug (slugs are kebab and never
 * contain a space), so it cannot collide with one.
 *
 * EXPORTED deliberately: HudBoard raises it and HudView compares against it, and
 * when each spelled the literal out itself the two silently drifted — HudBoard's
 * copy had its leading space corrupted to a raw NUL byte, so `slug === ALL_FLEETS`
 * never matched and the chip filtered the board to nothing instead of clearing
 * the filter. A whitespace-ish sentinel is invisible in a diff, so it gets exactly
 * one definition; never re-spell it inline.
 */
export const ALL_FLEETS = ' all';

/** Grouping key for sessions belonging to no fleet. Same rule: one definition. */
export const SOLO_FLEET_KEY = ' solo';

/**
 * Sentinel for the "All plans" row of the plan filter (P-004) — the plan-axis
 * twin of ALL_FLEETS, and same rule: ONE definition, never re-spelled inline
 * (see ALL_FLEETS' docblock for the NUL-byte drift that rule is paying for).
 * A leading space keeps it out of slug space.
 */
export const ALL_PLANS = ' all-plans';

/**
 * The plan filter's token for "sessions bound to no plan at all".
 *
 * Unlike the fleet strip — which carries SOLO_FLEET_KEY as its grouping key and
 * then spells `'solo'` again as the URL token in HudView — this is ONE constant
 * doing both jobs: it is the Combobox option value AND the value that lands in
 * the `hudplan` query param. Two spellings of one concept is exactly what
 * ALL_FLEETS' comment is a monument to; a plain token needs no %20 in the URL,
 * so there is no reason to have a second form.
 */
export const NO_PLAN_TOKEN = 'none';

/** One standing mode as the roster delivers it (adv-roster's AdvRosterMode). */
export interface HudMode {
  mode: string;
  ownerDirected?: boolean;
  since?: string | null;
  /** What the mode is about (adv-roster's AdvRosterMode.subject). For GOAL it is
   *  the goal id this session runs, which is how this board knows to hide it
   *  (D-007/P-020). Optional: a payload from an older operator, or the tolerated
   *  bare-string mode form, simply carries no subject — read as "not a goal
   *  session", which keeps the session VISIBLE rather than vanishing it. */
  subject?: string | null;
}

/** Normalize the tolerated bare-string form to the object form. */
export function toHudMode(m: HudMode | string): HudMode {
  return typeof m === 'string' ? { mode: m } : m;
}

/** The open `events:await` shape as the roster carries it (adv-roster's OpenAwait).
 *  Re-declared structurally so this client module never imports the server file. */
export interface HudOpenAwait {
  eventKey: string;
  note: string | null;
  sinceIso: string;
  expiresIso: string | null;
}

/**
 * The subset of `RosterEntry` the board reads. Structural, not an import: the
 * server module pulls in the PG presence store, and importing it from a client
 * component leaks node builtins into the SPA bundle (the operator-vite
 * blank-page failure mode). The endpoint JSON is the contract.
 */
export interface HudRosterEntry {
  ownerId: string;
  label: string;
  source: string;
  intent: string;
  /**
   * The owner-keyed MANUAL name a human gave this session (adv-roster's
   * `displayName`), or absent when it has none.
   *
   * Optional for the same reason as `sessionId` below: a payload from an older
   * operator, or a mid-deploy SSE push, legitimately carries neither — and the
   * headline must still resolve, one layer down, rather than blank the card.
   */
  displayName?: string | null;
  /**
   * What this session is working on — its in-flight work-item title falling back
   * to its declared intent, resolved server-side through the SAME shared chain
   * the OS terminal title uses (R1). Absent on an older payload, where the
   * headline falls back to `intent` directly.
   */
  objective?: string | null;
  /** The work-item id the objective came from; absent when it came from the intent. */
  objectiveWorkItemRef?: string | null;
  currentFiles: string[];
  liveness: Liveness;
  /**
   * THE liveness verdict from the shared oracle (adv-roster's `sessionState`,
   * via `resolveSessionStates`) — the same one coord:presence, fleet:status and
   * leader-brief project. Optional so a payload from an older operator (or a
   * mid-deploy SSE push) still classifies via the heartbeat legs.
   *
   * `liveness` above is HEARTBEAT FRESHNESS, not "is it taking turns" — a
   * parked agent waiting on its inbox keeps beating, so `liveness` reads 'live'
   * for a session that has not taken a turn in days. Prefer this field.
   */
  sessionState?: string | null;
  /**
   * Current-turn activity from the same shared oracle. This is orthogonal to
   * liveness: `sessionState` is the verdict, while `liveTurn` explains whether
   * that verdict is backed by an in-flight turn. Optional for older payloads.
   */
  liveTurn?: boolean | null;
  stale: boolean;
  lastActiveAt: string | null;
  intentDeclaredAt: string | null;
  loopArmed: boolean;
  /** Standing modes with provenance (adv-roster's AdvRosterMode). A bare string is
   *  tolerated so a roster payload from an older operator still renders chips
   *  instead of throwing — federation and a mid-deploy SSE push both produce one. */
  modes: Array<HudMode | string>;
  pidAlive: boolean | null;
  /**
   * WI-6821: this launch is OBSERVED dead — the terminal process is gone and it
   * never registered a session. Only the `starting` tier sets it. Optional so a
   * payload from an older operator (or a mid-deploy SSE push) still renders;
   * absent means "not a failed launch", never "unknown".
   */
  launchFailed?: boolean;
  /**
   * WI-37841: WHY it failed — the tail of psu's boot log, as captured server-side.
   * Set only alongside `launchFailed`, and absent from an older operator's
   * payload, so a reader must fall back to the generic copy rather than assume
   * a cause is always available. '' (the launch printed nothing) is a real
   * finding and is NOT the same as null/absent (no log at all).
   */
  launchFailureHint?: string | null;
  /** The live headless client is parked at a recognized pre-turn provider wall. */
  launchBlocked?: boolean;
  /** Actionable, constructed remediation for `launchBlocked`. */
  launchBlockedHint?: string | null;
  claims: Array<{ id?: string; planSlug?: string | null; status?: string | null }>;
  declaredUnclaimed: boolean;
  currentPlanSlug: string | null;
  /** The harness a spawned-agent run row attributes this session to (adv-
   *  roster.ts's `spawnedAgentRunInfoByOwner`) — null for a session with no
   *  matching run (chat-ref-pills-2026-07-26 P-008: SessionChatModal's own
   *  harness scoping for its WI-/EI-/F- ref-pill popup destinations). Always
   *  present on the raw roster row; only newly TYPED here. */
  harnessSlug: string | null;
  agentPaneKind: string;
  role: string | null;
  agent: string | null;
  advSessionId: number | null;
  windowId: string | null;
  wakeMode: string | null;
  pendingWakes: number;
  fleetSlug: string | null;
  fleetColor: string | null;
  fleetRole: string | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  /**
   * WHEN the `contextTokens` reading was taken (adv-roster's
   * `contextEstimatedAt`). Render the reading's AGE from it — "ctx 47% ·
   * measured 3m ago" — and NEVER a freshness claim
   * (popup-agent-state-coverage-2026-08-18 D-004): a fresh timestamp does not
   * prove a fresh value, which is exactly how the recorded incident hid.
   *
   * OPTIONAL for the same reason as `sessionState` and `accountPin`: an older
   * operator's payload, a mid-deploy SSE push, and the pending/starting launch
   * tiers all legitimately carry none. Absent = the roster could not tell us.
   */
  contextEstimatedAt?: string | null;
  /** The agent's home Hive slug (adv-roster's `potSlug`); optional for the same
   *  reason as `contextEstimatedAt`. */
  potSlug?: string | null;
  /** The host machine's capability tags. `[]` is a real value ("resolved,
   *  none"); absent is "unknown" — do not collapse the two. */
  capabilityTags?: string[];
  /** The terminal device this session owns (adv-roster's `tty`); null when never
   *  reported (headless, or a pre-tty-column row). */
  tty?: string | null;
  /**
   * The DURABLE dynamic account pin in force for this session (adv-roster's
   * `accountPin`) — what the chat footer's ACCOUNT pill reports and sets
   * (hud-chat-owner-controls-2026-08-11 P-003).
   *
   * OPTIONAL for the same reason as `sessionState`: a payload from an older
   * operator, or a mid-deploy SSE push, predates the field. Absent means the
   * roster could not tell us, `null` means NOT DYNAMICALLY PINNED — and neither
   * means "routed through the pool default", since a static `--account=` spawn
   * pin is invisible to this layer.
   */
  accountPin?: { account: string; hard: boolean } | null;
  /**
   * The session's recorded launch arguments (adv-roster's `launchArgv`) — what
   * the chat footer's MODEL pill parses its current `<model>[:<effort>]` spec
   * out of (hud-chat-owner-controls-2026-08-11 P-002).
   *
   * OPTIONAL for the same reason as `accountPin` above: an older operator's
   * payload predates it, and the pill treats ABSENT as unknown and omits itself
   * rather than claiming a model it cannot source (D-005 §5). Do NOT default it
   * to `[]` anywhere on the way here — an empty array is the positive claim
   * "launched with no --model", which the pill renders as "default".
   *
   * Two shapes travel in this field and `modelSpecFromArgv` reads both: raw
   * tokens (["psu", "--model=…"]) from a psu/fleet launch, and
   * [terminal, greetingCmd] from a console launch, where the flag is embedded in
   * the recorded shell command.
  */
  launchArgv?: string[];
  openAwait: HudOpenAwait | null;
  /** Recent transcript-output freshness. Display decoration only. */
  transcriptFresh?: boolean | null;
  /** @deprecated Compatibility alias for transcriptFresh on older payloads. */
  thinking: boolean;
  /** The adv_sessions `display` hint. Optional — only the launch-record tiers
   *  carry one ('workbench' for a D-006 pane launch, 'terminal' for a WI-6376
   *  terminal spawn); a presence-derived row has none. Read ONLY to tell a
   *  terminal launch that never came online from one that is still booting. */
  display?: string | null;
  /** When the session (or its launch record) started. Optional for the same
   *  reason as `display`. */
  startedAt?: string | null;
  /**
   * The agent's NATIVE session id (the claude uuid) and, for omp, its thread
   * id. Both have always ridden on the roster payload (adv-roster's
   * `RosterEntry.sessionId` / `.ompThreadId`); they were simply never TYPED
   * here, which is why `matchesSessionText` could not search them and pasting a
   * session id into the board's search box matched nothing (WI-37204).
   *
   * Optional for the same reason as `display`: a presence-derived row, a
   * pending launch, and a payload from an older operator all legitimately carry
   * neither.
   */
  sessionId?: string | null;
  ompThreadId?: string | null;
  /** Canonical per-backend transcript/resume handle emitted by advRoster.list. */
  nativeSession?: NativeSessionHandle | null;
  /**
   * The session's OS pid, when the roster resolved one (adv-roster's
   * `RosterEntry.pid`). Untyped here for the same reason as the two ids above —
   * it has always ridden on the payload — and its absence had the same shape of
   * consequence: SessionActionCtx declares `pid` as "supplied by
   * SessionChatModal from the SAME advRoster.list entry", so
   * /adv/sessions/focus was silently posting `pid: undefined` and resolving the
   * window from advSessionId/windowId alone (EI-20209690740975295).
   */
  pid?: number | null;
}

/** How long a terminal-spawned launch may sit un-registered before the board
 *  stops calling it "starting" and calls it a launch that never came online.
 *  Matches the 60s did-not-come-online fallback WI-6367 gave the chat modal —
 *  the two surfaces should not disagree about the same session. */
export const TERMINAL_LAUNCH_ONLINE_GRACE_SEC = 60;

/** An unanswered thing addressed to the human, keyed to the agent that asked.
 *  Sourced from the SAME `plans.attention` feed the inbox and Queue read — the
 *  board never invents a second asks pipeline.
 *
 * `ownerAgentId` is nullable BY DESIGN, not an edge case to special-case away:
 * several AttentionItem sources (hud-consolidation-2026-07-26 P-002 — the
 * `improvement`, `standing-approval`, and `dark-flag-ratification` adapters
 * structurally always carry `ownerAgentId: null`; `operator-report` and
 * `plan-item` carry it only when a claimant is resolvable) are genuine
 * needs-human Decisions with no live agent to attach them to. Live count as
 * of 2026-07-26 (workspace-wide, papercusp harness — the query is `plans:
 * attention` with `payloadTier:'full'`, decision-tier items filtered
 * `!ownerAgentId`): 301, dominated by `work-item-needs-human` (240). These
 * MUST still render somewhere on the board (see `unattributedAsks` /
 * `HudBoard.unattributed`) — a `.filter(i => i.ownerAgentId)` upstream of
 * this type would silently drop every one of them with no UI anywhere in the
 * app once the sidebar Inbox is retired (D-001). The remaining fields
 * (id/kind/itemRef/planSlug/harnessSlug) mirror the subset of `AttentionItem`
 * an unattributed card needs to render + be identified without an owning
 * agent to key off of. */
export interface HudAsk {
  ownerAgentId?: string | null;
  title: string;
  occurredAt?: string | null;
  /** The source AttentionItem's own id — stable React key for an unattributed
   *  card (there is no ownerAgentId to key off of). */
  id: string;
  /** AttentionItem['kind'] — not re-typed here (a full string import would
   *  drag the admin/plans module into this pure, PG-free file); rendered as a
   *  human label via HUD_ASK_KIND_LABEL, unknown kinds falling back to the
   *  raw string. */
  kind: string;
  itemRef?: string | null;
  planSlug?: string | null;
  harnessSlug?: string | null;
  /** The source `AttentionItem.ref` — the STRUCTURED destination, kept because
   *  it is the only field that says what an ask is ABOUT rather than what it
   *  looks like (WI-6742). `itemRef`/`planSlug` cannot stand in for it:
   *  `planSlug` is set as CONTEXT on asks that are not plan items at all, so
   *  routing on it would send an improvement-triage ask to a plan popup.
   *
   *  Declared structurally rather than importing `AttentionItem['ref']` for the
   *  same reason as every other field here — the real type is a discriminated
   *  union across ~10 adapters and importing it drags the admin/plans module
   *  into this pure, PG-free file. Widening to the fields we route on keeps the
   *  real union assignable to it. */
  ref?: HudAskRef | null;
}

/** The subset of `AttentionItem['ref']` the HUD routes on: the discriminant,
 *  plus the plan-item coordinates. Every other member of the real union has a
 *  `kind` and no `slug`, so it lands on the ask itself — which is the correct
 *  destination for it, not a fallback. */
export interface HudAskRef {
  kind: string;
  slug?: string | null;
  itemId?: string | null;
}

/** Human label for an unattributed ask's kind badge. Deliberately covers only
 *  the kinds that are STRUCTURALLY capable of reaching here (ownerAgentId
 *  null on a decision-tier item — see HudAsk's doc) rather than every
 *  AttentionKind; an unlisted kind still renders via the raw string
 *  fallback, so this table can never make a real ask invisible by omission. */
export const HUD_ASK_KIND_LABEL: Record<string, string> = {
  improvement: 'Improvement triage',
  'standing-approval': 'Standing approval',
  'dark-flag-ratification': 'Dark flag',
  'operator-report': 'Operator report',
  'plan-item': 'Plan item',
  'work-item-needs-human': 'Work item',
  'owner-wall': 'Owner wall',
};

/** The unattributed asks — needs-human items with no `ownerAgentId` to key a
 *  session card off of (see HudAsk's doc for why this is structural, not an
 *  edge case). Oldest first: the same urgency ordering `deriveColumn` applies
 *  to a session's own needs-you reason. */
export function unattributedAsks(asks: HudAsk[]): HudAsk[] {
  return asks
    .filter((a) => !a.ownerAgentId)
    .slice()
    .sort((a, b) => {
      const at = a.occurredAt ? new Date(a.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.occurredAt ? new Date(b.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      return at - bt;
    });
}

export const HUD_COLUMNS = ['needs-you', 'working', 'blocked', 'stalled', 'parked'] as const;
export type HudColumnId = (typeof HUD_COLUMNS)[number];

export const HUD_COLUMN_LABEL: Record<HudColumnId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  stalled: 'Stalled',
  parked: 'Parked · done',
};

/** Per-column one-liner shown when the column is EMPTY. Written as good news,
 *  because an empty Blocked/Stalled column IS the good outcome. */
export const HUD_COLUMN_EMPTY: Record<HudColumnId, string> = {
  'needs-you': 'Nothing is waiting on you',
  working: 'No sessions are running',
  blocked: 'Nothing is waiting on a gate',
  stalled: 'Everything alive is moving',
  parked: 'Nothing parked',
};

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

export interface HudBadge {
  id: string;
  label: string;
  tone: BadgeTone;
  /** Work-item kind badges render through the canonical icon-bearing KindPill. */
  workItemKind?: string;
  /** Hover text — the full explanation the short label compresses. */
  title?: string;
  /** 'mode' = a standing mode (rendered always, exempt from the chip cap);
   *  'stat' (default) = a derived statistic, capped by the card. */
  kind?: 'mode' | 'stat';
  /** Mode chips only: the human owner armed it, so it is sticky against peers. */
  ownerDirected?: boolean;
}

/**
 * One transcript match, carried from the search endpoint onto the card that
 * matched (owner ask 2026-08-02: "when searching a transcript it doesn't show
 * the relevant part of the conversation on the preview card").
 *
 * The endpoint already returned every field here — HudView read `ownerId` out
 * of the response and dropped the rest, so a search result rendered as an
 * ordinary card with nothing saying WHY it matched.
 */
export interface HudSearchHit {
  /** Turn index within the transcript. The reason this is worth carrying: it is
   *  what lets opening a search result land ON the match instead of at the tail. */
  turnIdx: number;
  /** PG `ts_headline` output — the excerpt with `<mark>` around matched terms.
   *  Null when the engine returned none; `excerpt` is then the fallback. */
  highlight: string | null;
  /** The unmarked excerpt. Always present. */
  excerpt: string;
  /** 'user' | 'assistant' | … — whose turn matched. */
  speaker: string | null;
  ts: string | null;
  sessionId: string;
  sourceKind: string;
  /** How many OTHER turns in this session also matched. A single excerpt with
   *  no hint that 40 more exist misrepresents the result as the whole answer. */
  more: number;
  /** The lowercased literal this turn actually contains (P-004 exact/fuzzy tiers) — the
   *  deep-link must anchor on THIS rather than the typed query: a fuzzy hit's turn contains
   *  the near spelling, not the typo, and the viewer only focuses a message containing its
   *  term. Absent ⇒ anchor on the typed query (an older server / a hybrid-only hit). */
  focusTerm?: string;
}

/** A run of excerpt text, flagged as matched or not — see `parseHighlight`. */
export interface HudHighlightSegment {
  text: string;
  mark: boolean;
}

/** Shape of one session entry in the /api/adv/sessions/search-transcripts body. */
export interface HudTranscriptSearchSession {
  active?: { ownerId?: string | null } | null;
  session?: { coordOwnerId?: string | null } | null;
  sessionId?: string | null;
  sourceKind?: string | null;
  hits?: {
    turnIdx?: number | null;
    excerpt?: string | null;
    highlight?: string | null;
    speaker?: string | null;
    ts?: string | null;
    /** P-004: the literal the turn contains — see {@link HudSearchHit.focusTerm}. */
    focusTerm?: string | null;
  }[];
}

/** The transcript pass rolled up for the board: which owners matched, and the
 *  best hit per owner (the card excerpt + the turn the modal opens on). */
export interface HudTranscriptSearchResult {
  owners: Set<string>;
  hits: Map<string, HudSearchHit>;
}

/**
 * Roll the search response up to owners + best-hit-per-owner.
 *
 * Extracted from HudView (WI-7344) so it can be tested at all: HudView pulls in
 * useSyncQuery / useInboxAttention / nuqs and has no render harness, which is
 * why its sibling guards resort to regex-ing the source file. Logic that can
 * silently mis-render a search result belongs on this side of that line.
 */
export function rollUpTranscriptSearch(
  sessions: HudTranscriptSearchSession[] | null | undefined,
): HudTranscriptSearchResult {
  const owners = new Set<string>();
  const hits = new Map<string, HudSearchHit>();
  for (const s of sessions ?? []) {
    const id = s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
    if (!id) continue;
    owners.add(id);
    /* The engine ranks hits, so [0] is the best one. A hit with no usable text
       is skipped rather than rendered as an empty strip — but the OWNER still
       counts as matched above, because the session genuinely did match. */
    const top = s.hits?.[0];
    const text = top?.highlight ?? top?.excerpt ?? '';
    if (!top || !text.trim()) continue;
    hits.set(id, {
      turnIdx: typeof top.turnIdx === 'number' ? top.turnIdx : -1,
      highlight: top.highlight ?? null,
      excerpt: top.excerpt ?? '',
      speaker: top.speaker ?? null,
      ts: top.ts ?? null,
      sessionId: s.sessionId ?? '',
      sourceKind: s.sourceKind ?? '',
      more: Math.max(0, (s.hits?.length ?? 0) - 1),
      ...(top.focusTerm ? { focusTerm: top.focusTerm } : {}),
    });
  }
  return { owners, hits };
}

/** Outcome of one transcript-search round-trip. `timedOut` is deliberately its
 *  own field rather than folded into `message`: the caller must be able to tell
 *  "the operator is wedged" from "the query was rejected" without string-matching. */
/**
 * What the owner-visibility filter removed from THIS page, as reported by the
 * route's `hiddenMachineHits`.
 *
 * WI-37912 shipped this in two halves and only the server half landed: the
 * route over-fetches a candidate pool, filters machine-authored turns out of
 * it, and cuts to the page — but a boilerplate-heavy query can still exhaust
 * the pool before the page fills (measured live 2026-08-12: `loop wake` 16/30
 * with 74 hidden, `checkpoint` 18/30 with 72 hidden). The route's own header
 * accepts a short page ONLY because it is disclosed; nothing read this field,
 * so the disclosure reached the wire and stopped there, leaving the silently
 * short page the item was filed about. This type is the client half.
 *
 * `truncatedByLimit` marks `count` as a FLOOR taken over a capped pool, never
 * a total — render it as such, or a bounded measurement reads as a real count.
 */
export interface HudHiddenMachineHits {
  count: number;
  truncatedByLimit: boolean;
}

export type HudTranscriptSearchOutcome =
  | ({ ok: true; hiddenMachineHits: HudHiddenMachineHits } & HudTranscriptSearchResult)
  | { ok: false; timedOut: boolean; message: string };

/**
 * Run the transcript search under a hard deadline.
 *
 * WI-7344 (owner report 2026-08-03: "searched 'theory' … still showed searching
 * transcripts 30 seconds later"). The call had no deadline, so a stalled
 * operator produced a spinner that never stopped — indistinguishable from a
 * slow answer, with no error and no way out.
 *
 * The subtlety worth keeping: a timeout abort and a supersede/unmount abort BOTH
 * set `signal.aborted`, so a caller that branches on that flag alone swallows
 * the timeout and re-creates the very hang the deadline was added to fix. The
 * deadline therefore aborts with a private reason and reports `timedOut`
 * explicitly, rather than leaving the caller to infer it.
 */
export async function fetchTranscriptSearch(
  query: string,
  opts: {
    limit?: number;
    timeoutMs: number;
    /** Caller's abort signal (a newer keystroke / unmount). */
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<HudTranscriptSearchOutcome> {
  const timeoutReason = { hudSearchTimeout: true };
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(timeoutReason), opts.timeoutMs);
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const r = await doFetch(
      `/api/adv/sessions/search-transcripts?q=${encodeURIComponent(query)}&limit=${opts.limit ?? 100}`,
      { signal: ctl.signal },
    );
    const body = (await r.json()) as {
      ok?: boolean;
      sessions?: HudTranscriptSearchSession[];
      error?: string;
      hiddenMachineHits?: { count?: number; truncatedByLimit?: boolean } | null;
    };
    if (!r.ok || body.ok === false) {
      return {
        ok: false,
        timedOut: false,
        message: body.error ?? `search failed (${r.status})`,
      };
    }
    /* A MISSING field degrades to "nothing hidden" (renders no chip) rather
       than to a guess. That deliberately makes an older server — one that
       predates `hiddenMachineHits` — indistinguishable from a page with
       nothing filtered. It is the safe direction: the failure is a missing
       disclosure, not a fabricated count on a page that was never filtered. */
    const rawHidden = body.hiddenMachineHits;
    const hiddenMachineHits: HudHiddenMachineHits = {
      count: typeof rawHidden?.count === 'number' && rawHidden.count > 0 ? rawHidden.count : 0,
      truncatedByLimit: rawHidden?.truncatedByLimit === true,
    };
    return { ok: true, hiddenMachineHits, ...rollUpTranscriptSearch(body.sessions) };
  } catch (e) {
    if (ctl.signal.reason === timeoutReason) {
      return {
        ok: false,
        timedOut: true,
        message: `transcript search timed out after ${Math.round(opts.timeoutMs / 1000)}s — the operator may be busy`,
      };
    }
    throw e; // a supersede/unmount abort stays the caller's to ignore
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) {
      const n = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (key.startsWith('#')) {
      const n = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return HTML_ENTITIES[key] ?? whole;
  });
}

/**
 * Split a `ts_headline` string into marked / unmarked runs for rendering.
 *
 * This exists so the card can render the highlight as REACT NODES. The obvious
 * alternative — `dangerouslySetInnerHTML` — is not acceptable here on any
 * argument: the string is agent transcript text, i.e. arbitrary content that
 * routinely CONTAINS markup, code and quoted HTML. Escaping is the server's job
 * and `ts_headline` does escape, but a rendering path whose safety depends on an
 * upstream escaper staying correct forever is one regression away from
 * executing transcript content in the operator. Segments cannot do that: every
 * run becomes a text node no matter what it holds.
 *
 * Whitespace is condensed because this is a DISPLAY helper — transcript
 * excerpts carry markdown and hard newlines that would otherwise break a
 * two-line card clamp into ragged fragments.
 */
export function parseHighlight(raw: string): HudHighlightSegment[] {
  const out: HudHighlightSegment[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/gi;
  const push = (text: string, mark: boolean) => {
    const condensed = decodeEntities(text).replace(/\s+/g, ' ');
    if (condensed.trim().length > 0 || (out.length > 0 && condensed === ' ')) {
      out.push({ text: condensed, mark });
    }
  };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) push(raw.slice(last, m.index), false);
    push(m[1], true);
    last = m.index + m[0].length;
  }
  if (last < raw.length) push(raw.slice(last), false);
  return out;
}

/**
 * The text a transcript modal should scroll to, derived from a search hit.
 *
 * ── Why TEXT and not `turnIdx` ──────────────────────────────────────────────
 * `HudSearchHit.turnIdx` is an index into `harness_shared.session_turns` — the
 * Postgres table the search engine indexes. The modal renders a DIFFERENT
 * store: `/api/adv/session/thinking` streams the on-disk transcript, which
 * `sessionTimelineToChatMessages` then groups into turns and FILTERS
 * (tool_result and status entries are dropped, a text-and-tool-less turn
 * produces no message at all). Nothing establishes the two numberings are the
 * same, and the filtering guarantees they diverge whenever a session has a
 * status-only turn. Scrolling to `turnIdx` would therefore land confidently on
 * the wrong message — a worse failure than not scrolling, because it looks
 * like it worked.
 *
 * Matched TEXT survives the store boundary: whatever the row numbering, the
 * words are the same words. So the anchor is a literal substring of the
 * matched turn, and `turnIdx` is kept only as a last-resort tiebreak when two
 * messages contain it.
 *
 * ── Which substring ─────────────────────────────────────────────────────────
 * `highlight` is PG `ts_headline` output over the turn text, so stripping its
 * `<mark>` tags yields exact contiguous runs of the source — but it is capped
 * at `MaxWords=18` per fragment and glues up to 2 fragments with `" … "`, so
 * the WHOLE string is not contiguous. Split on that delimiter and take the
 * longest piece.
 *
 * `excerpt` is `"[speaker owner ts] " + first 200 chars of the turn` — also
 * exact, but it carries a synthetic bracket prefix that appears nowhere in the
 * transcript, so it is only usable with that prefix stripped, and only as a
 * fallback (a headline fragment sits ON the match; an excerpt prefix may be
 * hundreds of chars above it).
 *
 * Returns null when nothing usable survives — the caller then opens the modal
 * at the tail exactly as before, which is the honest degradation.
 */
export function searchHitAnchor(hit: HudSearchHit | null | undefined): string | null {
  if (!hit) return null;

  // Longest contiguous headline fragment. parseHighlight already decodes
  // entities and condenses whitespace, which is exactly the normalization the
  // consumer applies to message text before matching.
  if (hit.highlight) {
    const joined = parseHighlight(hit.highlight)
      .map((s) => s.text)
      .join('');
    const best = joined
      .split(/\s+…\s+/)
      .map((s) => s.trim())
      .sort((a, b) => b.length - a.length)[0];
    // Under ~8 chars an anchor stops discriminating: a 3-letter run matches
    // half the transcript, and the FIRST such match is almost never the hit.
    if (best && best.length >= MIN_ANCHOR_CHARS) return best;
  }

  // Fallback: the excerpt, minus the synthetic `[speaker owner ts]` prefix the
  // search source prepends (it is not in the transcript, so leaving it on
  // guarantees a miss). Cap the length — the excerpt runs to 200 chars and
  // may end mid-word or be truncated with `…`, and a long tail only adds ways
  // for it not to match.
  const bare = hit.excerpt.replace(/^\[[^\]]*\]\s*/, '').replace(/…$/, '');
  const condensed = bare.replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return condensed.length >= MIN_ANCHOR_CHARS ? condensed : null;
}

/** Below this an anchor matches too much to be the match. */
const MIN_ANCHOR_CHARS = 8;

export interface HudSession {
  ownerId: string;
  /** Short display handle, e.g. `su-92bacd`. */
  handle: string;
  /**
   * THE card headline — `manualName ?? objective ?? handle`, resolved through
   * the shared `sessionDisplayName` (D-001/D-003), so it is the same string the
   * session's OS terminal title leads with.
   *
   * Never blank: the chain bottoms out at `handle`, which is why the card can
   * render this unconditionally. `handle` is NOT replaced by it — D-001 keeps
   * the short id on the card as a dim secondary row, because it is how a human
   * correlates a card with logs, `--resume` lines and work-item bodies.
   */
  displayName: string;
  /**
   * Which layer of the chain won. The card uses it to avoid printing the same
   * sentence twice (R3) and to distinguish a name a human chose from the
   * objective the system derived.
   */
  displayNameSource: SessionDisplayNameSource;
  /** The work-item id behind the objective, for the card's dim secondary row (R2). */
  objectiveWorkItemRef: string | null;
  label: string;
  /** Declared intent, or null when the agent never declared one (the roster
   *  normalizes its self-referential placeholder away, so empty means empty). */
  intent: string | null;
  column: HudColumnId;
  /** Why it landed in this column, in words a human can act on. */
  reason: string;
  /** Seconds it has been in this condition; null when unknown. */
  sinceSec: number | null;
  badges: HudBadge[];
  fleetSlug: string | null;
  fleetColor: string | null;
  isLeader: boolean;
  /** Native agent kind, retained so presentation can explain an unavailable
   *  chat surface without re-reading the roster or guessing from the label. */
  agent: string | null;
  /** False for Codex/OMP rows: those cards must not promise Claude chat. */
  chatSupported: boolean;
  planSlug: string | null;
  blockedOn: HudOpenAwait | null;
  /** Context use as a 0–100 percentage; null when never sampled (NOT 0 — an
   *  unmeasured context rendered as 0% reads as "plenty of room left"). */
  contextPct: number | null;
  claimedCount: number;
  doneCount: number;
  advSessionId: number | null;
  windowId: string | null;
  /** The transcript match that put this card in a filtered result, or null when
   *  no search is running / this session matched on its card text instead. */
  searchHit: HudSearchHit | null;
  /** Sort key WITHIN the column: lower sorts first. */
  sortKey: number;
}

export interface HudFleetRollup {
  fleetSlug: string | null;
  fleetColor: string | null;
  label: string;
  total: number;
  leaderOwnerId: string | null;
  byColumn: Record<HudColumnId, number>;
  /** The one-line health note shown beside the fleet chip — present only when
   *  something is actually wrong, so its absence is meaningful. */
  warning: string | null;
}

/**
 * One row of the plan filter (P-004) — the plan-axis twin of HudFleetRollup.
 *
 * Deliberately the same SHAPE as a fleet rollup rather than a bare
 * `{ slug, count }`: the plan filter "works like the existing fleet filter"
 * (P-004), and the per-column breakdown is what lets a plan row carry the same
 * one-line health note a fleet chip does — "3 needs you, 1 stalled" reads the
 * same whether the group is a fleet or a plan.
 */
export interface HudPlanRollup {
  /** `null` = sessions bound to no plan. Rendered from NO_PLAN_TOKEN. */
  planSlug: string | null;
  label: string;
  total: number;
  byColumn: Record<HudColumnId, number>;
  /** Present only when something needs a human — an absent warning is itself
   *  information, exactly as on HudFleetRollup. */
  warning: string | null;
}

export interface HudBoard {
  columns: Array<{ id: HudColumnId; label: string; empty: string; sessions: HudSession[] }>;
  fleets: HudFleetRollup[];
  /**
   * The plan filter's option list, derived from the sessions the FLEET filter
   * left in view but BEFORE the plan filter narrows them (P-004: "driven by the
   * fleets currently in view"). See buildHudBoard for why that ordering is
   * load-bearing rather than incidental.
   */
  plans: HudPlanRollup[];
  counts: Record<HudColumnId, number>;
  total: number;
  /** Needs-human asks with no owning agent — see `unattributedAsks`. Kept
   *  OUT of `counts`/`columns['needs-you']`: those are per-SESSION
   *  classifications, and an unattributed ask has no session to classify. */
  unattributed: HudAsk[];
}

export interface HudThresholds {
  /** No genuine tool activity for this long, while nominally alive ⇒ stall
   *  candidate. The heartbeat keeps beating every 60s regardless, so activity —
   *  not heartbeat — is the only honest movement signal. */
  stallActivitySec: number;
  /** …AND the intent text has not changed for this long. Both are required: a
   *  long single task with fresh tool calls is working, not stalled. */
  stallIntentSec: number;
  contextWarnPct: number;
  contextCritPct: number;
}

export const HUD_DEFAULT_THRESHOLDS: HudThresholds = {
  stallActivitySec: 15 * 60,
  stallIntentSec: 30 * 60,
  contextWarnPct: 60,
  contextCritPct: 85,
};

export interface HudBuildOptions {
  /** Injected clock (ms epoch) — never read Date.now() inside the model. */
  nowMs: number;
  thresholds?: HudThresholds;
  /** Restrict to the owner's own su sessions (plan D-003). The roster carries
   *  ~85 agents, mostly nursery cups; showing them all rebuilds the firehose the
   *  board exists to replace. */
  suOnly?: boolean;
  /** Show only these fleets (empty/omitted = all). `null` selects the no-fleet
   *  (solo) group, so it can be filtered like any other. */
  fleets?: Array<string | null>;
  /** Show only sessions on these plans (empty/omitted = all). `null` selects
   *  the no-plan group, so it filters like any other — same contract as
   *  `fleets`, on purpose (P-004). Applied AFTER `fleets`. */
  plans?: Array<string | null>;
  /** Transcript matches by ownerId (owner ask 2026-08-02). Absent = no search
   *  running; a session missing from a PRESENT map matched on card text, not
   *  transcript, which is a real and different state — hence a map rather than
   *  a field on the roster entry. */
  searchHits?: ReadonlyMap<string, HudSearchHit>;
  /**
   * Owners the board's own narrowing filters (`suOnly`, `fleets`, `plans`) must
   * NOT drop (WI-37204).
   *
   * These filters run AFTER the search filter, so before this existed a search
   * could resolve a session exactly — by its full su id or session id — and the
   * board would still show nothing, because the matched agent happened to be a
   * non-su cup, or to sit in a fleet the human had filtered away an hour
   * earlier. The filters read as "narrow what I'm browsing"; naming a session
   * by its unique id is not browsing, it is addressing, and an address that
   * silently resolves to an empty board is indistinguishable from a broken
   * search — which is exactly the complaint this work item came from.
   *
   * Deliberately scoped to ID matches only, not to every search hit: a text
   * query is browsing, so it stays subject to the filters (otherwise typing a
   * common word would blow past the su-only toggle and rebuild the ~85-agent
   * firehose the board exists to replace).
   */
  exemptOwners?: ReadonlySet<string>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** `su-709bb0d6-12de-…` → `su-709bb0d6`. Long uuids are unreadable on a card and
 *  the leading segment is already unique in practice. */
export function shortHandle(ownerId: string): string {
  const m = /^([a-z]+)-([0-9a-f]{6,8})/i.exec(ownerId);
  if (m) return `${m[1]}-${m[2]}`;
  return ownerId.length > 16 ? `${ownerId.slice(0, 16)}…` : ownerId;
}

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Compact duration for a card: `40s`, `12m`, `3h`, `2d`. */
export function formatAge(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Context use as a percentage, or null when either input is unknown. Returning
 *  null (rather than 0) is deliberate — see HudSession.contextPct. */
export function contextPct(tokens: number | null, limit: number | null): number | null {
  if (tokens == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
}

/**
 * Awaits that are INFRASTRUCTURE, not a block on work.
 *
 * `coord:inbox-wake:<self>` is armed permanently for every agent at
 * SessionStart (migration 183) and means "I am reachable by a wake" — the
 * opposite of blocked. Measured live while building this board: 126 of 139 open
 * awaits were inbox-wakes, one per agent, against 13 real gates. Treating them
 * as blocks would have parked ~93% of sessions in Blocked and made the column
 * worthless, since a signal that fires for nearly everyone distinguishes no one.
 *
 * The server query already excludes these; this is the second line of defence,
 * so a caller passing a raw awaits list (a test, a future endpoint, a cached
 * payload written before that fix) still cannot resurrect the bug.
 */
export function isInfrastructureAwait(a: HudOpenAwait | null | undefined): boolean {
  return Boolean(a && a.eventKey.startsWith('coord:inbox-wake:'));
}

/** Is this entry one of the owner's interactive su sessions? Uses the existing
 *  shared taxonomy (classifyAgentPane stamps `agentPaneKind`) rather than
 *  re-sniffing ids, so the board can't drift from the rest of the app. */
export function isSuSession(e: HudRosterEntry): boolean {
  return e.agentPaneKind === 'su';
}

/**
 * Whether the shared SessionChatModal has a transcript/composer surface for
 * this roster agent kind. All three interactive runtimes use the same popup;
 * only their native transcript key differs. Claude remains the default for an
 * older/partial roster payload, and `papercup` is Claude-backed.
 */
export function hasSessionChatSurface(agent: string | null | undefined): boolean {
  const kind = agent?.trim().toLowerCase();
  return kind == null || kind === '' || kind === 'claude' || kind === 'papercup' || kind === 'codex' || kind === 'omp';
}

/**
 * Does this session's own ON-CARD text match the query?
 *
 * The INSTANT half of the sessions search (owner ask 2026-08-02: "the search
 * transcripts doesn't automatically run the search instead I have to press
 * enter — mimic the implementation we did in the Work tab for the work items
 * pane"). The Work-items pane feels live because its query is applied by a
 * `useMemo` over rows already in memory — zero latency per keystroke. The
 * sessions box could not do that: it searches full turn HISTORY, which is not
 * in the roster payload, so every keystroke had to wait on a network round-trip
 * (measured 0.4–4.9s on /api/adv/sessions/search-transcripts, 2026-08-02).
 * Seconds of no visible change reads as "it didn't run", and whatever you press
 * next looks like what triggered it — there is no Enter handler in that path and
 * never was.
 *
 * So the board now filters on THIS synchronously while the transcript pass runs
 * behind it, and unions the two. Deliberately the same shape as the entity
 * board's `matchesQuery` (case-insensitive substring, no ranking, no fuzzy):
 * the two search boxes sit one tab apart and must not behave subtly differently.
 *
 * Fields are the ones a human can actually SEE on the card or would name from
 * memory — its label/handle, what it said it is doing, its plan/fleet/harness,
 * its role. Not `currentFiles`: a path match would silently pull in sessions
 * whose card shows nothing resembling the query.
 */
export function matchesSessionText(e: HudRosterEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    e.label,
    e.ownerId,
    shortHandle(e.ownerId),
    e.intent,
    // R7: a session a human NAMED must be findable by that name — it is the
    // card's headline, so this is the see-it-on-the-card rule, not an exception
    // to it. `objective` joins it because it is what the headline shows when
    // there is no manual name.
    e.displayName,
    e.objective,
    e.objectiveWorkItemRef,
    e.role,
    e.agent,
    e.fleetSlug,
    e.fleetRole,
    e.currentPlanSlug,
    e.harnessSlug,
    // WI-37204 (owner ask 2026-08-08 — "search by the su id and the session
    // id"). `ownerId` above already answered the su id; these are the OTHER
    // handle a human holds for a session, and the one that turns up in logs,
    // `--resume` lines and work-item bodies. Not visible on the card, so they
    // are a deliberate exception to the see-it-on-the-card rule in this
    // function's header: an id is not something you'd match by accident, and a
    // human who types one is naming exactly one session.
    e.sessionId,
    e.ompThreadId,
    ...e.claims.flatMap((c) => [c.id, c.planSlug]),
  ];
  for (const v of hay) {
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** The asks addressed to the human, grouped by the agent that asked. */
export function asksByOwner(asks: HudAsk[]): Map<string, HudAsk[]> {
  const out = new Map<string, HudAsk[]>();
  for (const a of asks) {
    if (!a.ownerAgentId) continue;
    const list = out.get(a.ownerAgentId);
    if (list) list.push(a);
    else out.set(a.ownerAgentId, [a]);
  }
  return out;
}

// ── column derivation ───────────────────────────────────────────────────────

export interface ColumnVerdict {
  column: HudColumnId;
  reason: string;
  sinceSec: number | null;
}

/**
 * Classify ONE session. Precedence is the whole design, so it is spelled out
 * rather than implied:
 *
 *   needs-you > blocked > stalled > working > parked
 *
 * - `needs-you` outranks everything because it is the only column whose fix is
 *   the human's to apply; a blocked agent that ALSO asked you something is your
 *   problem first.
 * - `blocked` outranks `stalled` because an agent parked on a gate is behaving
 *   CORRECTLY — calling it stalled would cry wolf on the one signal that must
 *   stay trustworthy.
 * - `stalled` outranks `working` because it is the *contradiction* of working:
 *   nominally alive, demonstrably not moving.
 */
/**
 * Is this session SUPPOSED to be producing turns right now?
 *
 * Extracted from `deriveColumn` (popup-agent-state-coverage-2026-08-18 P-006)
 * only so `isZombieSession` below can be shared; the rule is unchanged.
 *
 * `loopArmed` stays in the test on purpose, and is the one case where a
 * non-live verdict still belongs: an agent whose engine loop is armed is
 * SUPPOSED to be producing turns on a cadence, so an armed loop with a dead
 * activity clock is a dead loop — the sharpest genuine stall the board can
 * report, and exactly what its stalled column exists for.
 *
 * `sessionState` absent/null means the oracle had no verdict (an older payload,
 * or a degraded fetch). Fall back to the heartbeat legs rather than guessing —
 * an unknown verdict must never silently empty the stalled column, which would
 * hide a real stall instead of a fake one.
 */
export function isNominallyAlive(
  e: Pick<HudRosterEntry, 'sessionState' | 'loopArmed' | 'liveness'>,
): boolean {
  return e.sessionState != null
    ? e.sessionState === 'live' || e.loopArmed
    : e.liveness === 'live' || e.liveness === 'idle' || e.loopArmed;
}

/**
 * The zombie verdict's wording, single-sourced.
 *
 * EXPORTED (P-006) because the board and the conversation popup both report
 * this condition now, and two surfaces describing the same session in different
 * words is worse than one of them staying silent: the reader cannot tell
 * whether they disagree about the wording or about the session.
 */
export const ZOMBIE_REASON =
  'Heartbeat is fresh but the OS process is gone — this session is a zombie';

/**
 * Fresh heartbeat, dead process. The sharpest failure this model can name, and
 * the one whose cost is immediate on the popup: the composer sits inches below
 * the status band, so a zombie rendered as "live" means you type, see "Sent",
 * and get nothing back — with no way to tell that from an agent thinking hard.
 *
 * `!e.stale` is load-bearing: a STALE row is already known-gone and is reported
 * as such, so calling it a zombie would be redundant noise on the one signal
 * that has to stay sharp. `pidAlive === false` (not falsy) is equally
 * load-bearing — `null` is "could not check" (different host, no pid, stale
 * entry) and must never render as a positive death claim.
 */
export function isZombieSession(
  e: Pick<HudRosterEntry, 'sessionState' | 'loopArmed' | 'liveness' | 'pidAlive' | 'stale'>,
): boolean {
  return isNominallyAlive(e) && e.pidAlive === false && !e.stale;
}

export function deriveColumn(
  e: HudRosterEntry,
  asks: HudAsk[] | undefined,
  opts: { nowMs: number; thresholds: HudThresholds },
): ColumnVerdict {
  const { nowMs, thresholds } = opts;

  // 1. Needs you — an unanswered directed ask, or a wake staged behind manual
  //    mode. A staged wake is genuinely owner-gated: the message is sitting
  //    there undelivered until a human releases it.
  if (asks && asks.length > 0) {
    const oldest = asks.reduce((acc, a) => {
      const t = a.occurredAt ? new Date(a.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      return t < acc.t ? { t, a } : acc;
    }, { t: Number.POSITIVE_INFINITY, a: asks[0] });
    return {
      column: 'needs-you',
      reason: oldest.a.title || 'Asked you a question',
      sinceSec: ageSec(oldest.a.occurredAt, nowMs),
    };
  }
  if (e.pendingWakes > 0) {
    return {
      column: 'needs-you',
      reason: `${e.pendingWakes} wake${e.pendingWakes === 1 ? '' : 's'} staged behind manual mode — nothing reaches this agent until you release them`,
      sinceSec: null,
    };
  }
  // 1c. Fresh — launched but has never taken a turn (owner ask 2026-07-27: "all
  //     fresh sessions start as needs you"). These used to land in `parked`, which
  //     was precisely backwards: a session you just launched is not idle-and-fine,
  //     it is sitting there with no task, and the ONLY thing that starts it moving
  //     is you telling it what to work on. That is the definition of this column —
  //     the one whose fix is the human's to apply.
  //
  //     `lastActiveAt == null` is the honest "never took a turn" signal: the
  //     pending tier synthesizes it as null (adv-roster's pendingLaunchesToRosterEntries)
  //     and a real session sets it on its first tool call, so a session leaves this
  //     column on its own the moment it starts working — no timer, no cleanup.
  //
  //     Guarded on !stale so a session that was recorded, never ran, and has since
  //     died is NOT advertised as fresh; that one is genuinely parked (dead), and
  //     calling it "needs you" would put unfixable rows in the column whose whole
  //     value is that everything in it is actionable.
  if (e.lastActiveAt == null && !e.stale && e.liveness !== 'stale') {
    const sinceStart = ageSec(e.startedAt ?? null, nowMs);
    // Observed server states outrank the generic fresh-session copy immediately;
    // neither needs to wait for the age-based fallback to guess.
    if (e.launchFailed === true) {
      return {
        column: 'needs-you',
        reason: 'Launch failed before the session came online. Relaunch it.',
        sinceSec: sinceStart,
      };
    }
    if (e.launchBlocked === true) {
      return {
        column: 'needs-you',
        reason:
          e.launchBlockedHint?.trim() ||
          'Launch blocked before its first turn. Choose another account or backend, or retry after the provider limit resets.',
        sinceSec: sinceStart,
      };
    }
    // WI-6376: a TERMINAL launch that is still un-registered well past the point
    // it should have booted is not "fresh", it is a launch that failed — the
    // terminal never opened, or psu died on startup. Say so. It stays in
    // needs-you because it is still the human's to fix (relaunch it); what
    // changes is that the card stops implying a healthy session is on its way.
    if (
      e.display === 'terminal' &&
      sinceStart != null &&
      sinceStart >= TERMINAL_LAUNCH_ONLINE_GRACE_SEC
    ) {
      return {
        column: 'needs-you',
        reason: `Launched ${formatAge(sinceStart)} ago but never came online — the terminal may have failed to start. Relaunch it.`,
        sinceSec: sinceStart,
      };
    }
    return {
      column: 'needs-you',
      reason:
        e.liveness === 'pending'
          ? 'Fresh session — launched, not started yet. Tell it what to work on.'
          : 'Fresh session — no turn taken yet. Tell it what to work on.',
      sinceSec: null,
    };
  }

  // 2. Blocked — parked on a REAL gate, and we know which one. An
  //    infrastructure await (the always-armed inbox wake every agent holds) is
  //    explicitly not a block: see isInfrastructureAwait for why counting it
  //    would have swallowed ~93% of the roster. An ended session cannot still
  //    be parked on a gate; its owner-scoped await can outlive the liveness
  //    verdict, so do not let that stale enrichment resurrect a Blocked card.
  if (e.openAwait && e.sessionState !== 'ended' && !isInfrastructureAwait(e.openAwait)) {
    const waited = ageSec(e.openAwait.sinceIso, nowMs);
    return {
      column: 'blocked',
      reason: e.openAwait.note?.trim()
        ? `${e.openAwait.note.trim()} (${e.openAwait.eventKey})`
        : `Waiting on ${e.openAwait.eventKey}`,
      sinceSec: waited,
    };
  }

  // 3. Stalled — nominally alive but not moving. Requires BOTH a dead activity
  //    clock and an unchanged intent, so a long single task with live tool calls
  //    is never mislabelled.
  const sinceActivity = ageSec(e.lastActiveAt, nowMs);
  const sinceIntent = ageSec(e.intentDeclaredAt, nowMs);
  // WI-6636: "nominally alive" MUST come from the shared liveness oracle, not
  // from `liveness`. `liveness` is heartbeat freshness alone, and a PARKED agent
  // — idle between turns, waiting on its inbox wake — keeps beating, so it reads
  // 'live' forever. Combined with the stall test below (no tool call in 15min +
  // unchanged intent for 30min), every parked agent eventually became "Stalled":
  // measured 2026-07-28 on the default board, 110 of 133 cards, median 2 DAYS
  // and up to 11 days stale, while coord:presence called the same population
  // live 5 / parked 123. The board asserted the system was mostly stuck when it
  // was mostly idle — and `parked` is column 5, whose own doc says it is "not a
  // problem by itself".
  //
  // The `loopArmed` and null-`sessionState` halves of the rule now live on
  // `isNominallyAlive` (P-006), which is where they are enforced.
  const nominallyAlive = isNominallyAlive(e);

  // A zombie is the sharpest case: heartbeat fresh, process gone. Report it as a
  // stall with its own reason rather than letting it masquerade as working.
  if (isZombieSession(e)) {
    return {
      column: 'stalled',
      reason: ZOMBIE_REASON,
      sinceSec: sinceActivity,
    };
  }
  if (
    nominallyAlive &&
    sinceActivity != null &&
    sinceActivity >= thresholds.stallActivitySec &&
    sinceIntent != null &&
    sinceIntent >= thresholds.stallIntentSec
  ) {
    return {
      column: 'stalled',
      reason: `No tool call in ${formatAge(sinceActivity)} and the intent has not changed in ${formatAge(sinceIntent)}`,
      sinceSec: sinceActivity,
    };
  }

  // 4. Working — taking turns or carried by an armed loop.
  //
  // WI-6636: this must consult the oracle for the same reason step 3 does, and
  // it is the half that makes the fix safe. Dropping parked agents out of
  // `stalled` without touching this test would have sent all 110 straight into
  // `working` — `liveness` reads 'live' for every one of them — turning a board
  // that overstated stalls into one that overstates progress, which is worse.
  // `thinking` is only transcript-MTIME freshness. It may decorate an older or
  // degraded payload, but it must NEVER overturn an available oracle verdict:
  // a parked/ended session can receive a final transcript write and otherwise
  // masquerade as working for the freshness window.
  const oracleWorking =
    e.sessionState != null
      ? e.sessionState === 'live'
      : e.liveTurn === true || e.liveness === 'live';
  const transcriptFresh = e.transcriptFresh ?? e.thinking;
  const transcriptFreshFallback =
    e.sessionState == null && e.liveTurn == null && transcriptFresh;
  if (oracleWorking || transcriptFreshFallback || (e.loopArmed && e.liveness !== 'stale')) {
    return {
      column: 'working',
      reason: e.intent?.trim() || 'Running',
      sinceSec: sinceActivity,
    };
  }

  // 5. Parked — idle, stale, ended, or not yet started. Not a problem by itself.
  return {
    column: 'parked',
    reason:
      e.sessionState === 'ended' || e.liveness === 'stale'
        ? 'No heartbeat — session has ended'
        : e.liveness === 'pending'
          ? 'Recorded — has not started yet'
          : 'Idle between turns',
    sinceSec: sinceActivity,
  };
}

// ── badges ──────────────────────────────────────────────────────────────────

/** The chip row under a card's intent. Ordered by decision value, capped by the
 *  caller — the most useful chips must survive truncation. */
export function deriveBadges(
  e: HudRosterEntry,
  opts: { nowMs: number; thresholds: HudThresholds },
): HudBadge[] {
  const out: HudBadge[] = [];

  // NOTE: fleet leadership is deliberately NOT a badge. It is IDENTITY, not
  // state, so the card renders it beside the handle (HudSession.isLeader) —
  // emitting it here as well rendered "LEAD" twice on every leader card, and
  // spent one of the capped badge slots on it. Keep identity out of this row.

  // Standing modes decide whether your silence is fine or is the thing blocking
  // this agent — the single most useful chip on the card.
  //
  // Label and hover come from the MODE REGISTRY, not from a hand-written map
  // here: the map only covered auto/ideate/drain, so `cold-auto` and `grade`
  // rendered a bare "Standing mode: grade" that explained nothing. Registry-derived
  // means a mode added there is explained here the same day, with no edit.
  //
  // kind:'mode' is what keeps them out of the chip cap (HudBoard renders every
  // mode chip and caps only the stats) — an agent in auto+ideate+grade used to
  // spend the whole 4-chip budget on modes and hide its claims and asks.
  for (const raw of e.modes) {
    const m = toHudMode(raw);
    out.push({
      id: `mode-${m.mode}`,
      kind: 'mode',
      label: modeChipLabel(m.mode),
      tone: 'accent',
      ownerDirected: m.ownerDirected === true,
      title: modeChipTitle(m.mode, { ownerDirected: m.ownerDirected }),
    });
  }

  const claimed = e.claims.length;
  if (claimed > 0) {
    const done = e.claims.filter((c) => (c.status ?? '').toLowerCase() === 'done').length;
    out.push({
      id: 'claims',
      label: `${done}/${claimed}`,
      tone: done === claimed ? 'good' : 'neutral',
      title: `${done} of ${claimed} claimed item${claimed === 1 ? '' : 's'} done`,
    });
  }

  const pct = contextPct(e.contextTokens, e.compactionLimit);
  if (pct != null && pct >= opts.thresholds.contextWarnPct) {
    out.push({
      id: 'ctx',
      label: `ctx ${pct}%`,
      tone: pct >= opts.thresholds.contextCritPct ? 'bad' : 'warn',
      title: `Context ${pct}% full — answers degrade as this approaches the compaction limit`,
    });
  }

  // A manual-wake session STAGES your reply instead of delivering it. Surfacing
  // this is the difference between "it ignored me" and "it never heard me".
  //
  // popup-agent-state-coverage-2026-08-18 P-007: the COUNT rides in this badge
  // rather than in a chip of its own. `pendingWakes` has always been on the
  // roster row and was rendered nowhere, so the badge could say the mechanism
  // was armed but never that anything was actually caught in it — and in the
  // popup the composer is inches below, which makes "3 staged" the difference
  // between "it is ignoring me" and "it has not heard any of the three things I
  // said". A separate chip would have spent one of the capped board slots to say
  // half of what this badge already says.
  if (e.wakeMode === 'manual') {
    // `?? 0` guards a payload from an older operator only: the field is required
    // on the roster row, and 0 is a real value (armed, nothing caught yet).
    const staged = e.pendingWakes ?? 0;
    out.push({
      id: 'wake',
      label: staged > 0 ? `wake: manual · ${staged} staged` : 'wake: manual',
      tone: 'warn',
      title:
        staged > 0
          ? `${staged} message${staged === 1 ? '' : 's'} staged and NOT delivered — this agent has not seen ${staged === 1 ? 'it' : 'them'}. Release the wake to deliver.`
          : 'Messages are staged, not delivered, until released',
    });
  }

  if (e.loopArmed) {
    out.push({ id: 'loop', label: 'loop', tone: 'good', title: 'An engine loop is armed — it re-wakes on a cadence' });
  }

  // A declared plan with no claim backing it: the agent says it is on something
  // it never took, so peers cannot see the lane and work gets double-placed.
  if (e.declaredUnclaimed) {
    out.push({
      id: 'unclaimed',
      label: 'unclaimed lane',
      tone: 'warn',
      title: `Declared plan ${e.currentPlanSlug ?? ''} but claimed no item on it`.trim(),
    });
  }

  if (e.currentFiles.length > 0) {
    out.push({
      id: 'files',
      label: `${e.currentFiles.length} file${e.currentFiles.length === 1 ? '' : 's'}`,
      tone: 'neutral',
      title: e.currentFiles.join('\n'),
    });
  }

  return out;
}

// ── board assembly ──────────────────────────────────────────────────────────

/** Within a column, the longest-suffering card sorts first: a 40-minute block is
 *  more urgent than a 40-second one. Unknown ages sort last (they carry no
 *  urgency signal, so they must never outrank a measured one). */
function sortKeyFor(v: ColumnVerdict): number {
  return v.sinceSec == null ? Number.MAX_SAFE_INTEGER : -v.sinceSec;
}

export function toHudSession(
  e: HudRosterEntry,
  asks: HudAsk[] | undefined,
  opts: { nowMs: number; thresholds: HudThresholds; searchHit?: HudSearchHit | null },
): HudSession {
  const verdict = deriveColumn(e, asks, opts);
  const claimed = e.claims.length;
  const done = e.claims.filter((c) => (c.status ?? '').toLowerCase() === 'done').length;
  const handle = shortHandle(e.ownerId);
  // The headline, resolved through the SHARED chain (D-003) — never a local
  // rule. `objective` is the roster's server-resolved work-item-title ?? intent;
  // the `?? e.intent` keeps an older payload (which carries no `objective`)
  // rendering exactly as it did, one layer down, instead of dropping to the id.
  const display = sessionDisplayName({
    manualName: e.displayName,
    objective: e.objective ?? e.intent,
    ownerId: e.ownerId,
    shortHandle: handle,
  });
  return {
    ownerId: e.ownerId,
    handle,
    displayName: display.name,
    displayNameSource: display.source,
    objectiveWorkItemRef: e.objectiveWorkItemRef ?? null,
    label: e.label,
    intent: e.intent?.trim() ? e.intent.trim() : null,
    column: verdict.column,
    reason: verdict.reason,
    sinceSec: verdict.sinceSec,
    badges: deriveBadges(e, opts),
    fleetSlug: e.fleetSlug,
    fleetColor: e.fleetColor,
    isLeader: e.fleetRole === 'leader',
    agent: e.agent,
    chatSupported: hasSessionChatSurface(e.agent),
    planSlug: e.currentPlanSlug,
    blockedOn: e.openAwait,
    contextPct: contextPct(e.contextTokens, e.compactionLimit),
    claimedCount: claimed,
    doneCount: done,
    advSessionId: e.advSessionId,
    windowId: e.windowId,
    searchHit: opts.searchHit ?? null,
    sortKey: sortKeyFor(verdict),
  };
}

/** The fleet chips + their health notes. A fleet's warning names only the
 *  conditions that need a human — an all-clear fleet gets `null`, so the chip
 *  row stays quiet when everything is fine. */
export function deriveFleetRollups(sessions: HudSession[]): HudFleetRollup[] {
  const groups = new Map<string, HudFleetRollup>();
  for (const s of sessions) {
    const key = s.fleetSlug ?? SOLO_FLEET_KEY;
    let g = groups.get(key);
    if (!g) {
      g = {
        fleetSlug: s.fleetSlug,
        fleetColor: s.fleetColor,
        label: s.fleetSlug ?? 'solo',
        total: 0,
        leaderOwnerId: null,
        byColumn: { 'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0 },
        warning: null,
      };
      groups.set(key, g);
    }
    g.total += 1;
    g.byColumn[s.column] += 1;
    if (s.isLeader && !g.leaderOwnerId) g.leaderOwnerId = s.ownerId;
    if (!g.fleetColor && s.fleetColor) g.fleetColor = s.fleetColor;
  }
  for (const g of groups.values()) {
    const parts: string[] = [];
    if (g.byColumn['needs-you']) parts.push(`${g.byColumn['needs-you']} needs you`);
    if (g.byColumn.blocked) parts.push(`${g.byColumn.blocked} blocked`);
    if (g.byColumn.stalled) parts.push(`${g.byColumn.stalled} stalled`);
    // A fleet with members but no leader cannot be driven — nobody reclaims a
    // dead member's claim or opens the gates the members are parked on.
    if (g.fleetSlug && !g.leaderOwnerId) parts.push('no leader');
    g.warning = parts.length ? parts.join(', ') : null;
  }
  return [...groups.values()].sort((a, b) => {
    // Solo last; otherwise the fleet needing the most attention first.
    if ((a.fleetSlug == null) !== (b.fleetSlug == null)) return a.fleetSlug == null ? 1 : -1;
    const aw = a.byColumn['needs-you'] + a.byColumn.blocked + a.byColumn.stalled;
    const bw = b.byColumn['needs-you'] + b.byColumn.blocked + b.byColumn.stalled;
    if (aw !== bw) return bw - aw;
    return a.label.localeCompare(b.label);
  });
}

/** The plan filter's rows + their health notes — the plan-axis twin of
 *  `deriveFleetRollups`, down to the ordering rule (the group needing the most
 *  attention first, the "no plan" group last). Kept as its own function rather
 *  than a generic groupBy over a key selector: the two differ in their label
 *  and warning rules (a fleet with no leader is broken; a plan with no leader
 *  is normal), and collapsing them would mean a config object per call site to
 *  express three lines of difference. */
export function derivePlanRollups(sessions: HudSession[]): HudPlanRollup[] {
  const groups = new Map<string, HudPlanRollup>();
  for (const s of sessions) {
    const key = s.planSlug ?? NO_PLAN_TOKEN;
    let g = groups.get(key);
    if (!g) {
      g = {
        planSlug: s.planSlug,
        label: s.planSlug ?? 'no plan',
        total: 0,
        byColumn: { 'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0 },
        warning: null,
      };
      groups.set(key, g);
    }
    g.total += 1;
    g.byColumn[s.column] += 1;
  }
  for (const g of groups.values()) {
    const parts: string[] = [];
    if (g.byColumn['needs-you']) parts.push(`${g.byColumn['needs-you']} needs you`);
    if (g.byColumn.blocked) parts.push(`${g.byColumn.blocked} blocked`);
    if (g.byColumn.stalled) parts.push(`${g.byColumn.stalled} stalled`);
    // No "no leader" rule here: a plan does not have a leader, and inventing
    // one would be the chrome-that-lies failure P-009's docblock warns about.
    g.warning = parts.length ? parts.join(', ') : null;
  }
  return [...groups.values()].sort((a, b) => {
    // The unbound group last; otherwise the plan needing the most attention first.
    if ((a.planSlug == null) !== (b.planSlug == null)) return a.planSlug == null ? 1 : -1;
    const aw = a.byColumn['needs-you'] + a.byColumn.blocked + a.byColumn.stalled;
    const bw = b.byColumn['needs-you'] + b.byColumn.blocked + b.byColumn.stalled;
    if (aw !== bw) return bw - aw;
    return a.label.localeCompare(b.label);
  });
}

/** Build the whole board from a roster snapshot + the attention feed. */
export function buildHudBoard(
  roster: HudRosterEntry[],
  asks: HudAsk[],
  options: HudBuildOptions,
): HudBoard {
  const thresholds = options.thresholds ?? HUD_DEFAULT_THRESHOLDS;
  const nowMs = options.nowMs;
  const byOwner = asksByOwner(asks);

  /* WI-37204: an id-addressed session is exempt from the narrowing filters
     below — see `exemptOwners`. An empty/absent set makes every `exempt(…)`
     call false, i.e. the pre-existing behaviour exactly. */
  const exemptOwners = options.exemptOwners;
  const exempt = (ownerId: string) => Boolean(exemptOwners?.has(ownerId));

  let entries =
    options.suOnly === false ? roster : roster.filter((e) => isSuSession(e) || exempt(e.ownerId));

  /* P-020 [owner 2026-08-09: "the goal sessions shouldnt show in the normal
     sessions pane. goals are just sessions but a special type"]. A goal's agent
     renders as a card on the GOALS tab, so showing it here too is the same
     duplication the rail deletion was meant to end.

     Two properties this filter must keep, both of which fail SILENTLY if lost:
       - it hides only a session that HAS a goal to appear under. A session in
         GOAL mode whose goal is not yet filed carries no subject and stays
         visible — see goalIdFromModes. Hiding on "is in goal mode" instead
         would remove it from BOTH boards at once.
       - `exempt` still wins, exactly as it does for suOnly/fleets above
         (WI-37204). A session the user navigated to BY ID must render, and a
         goal's agent is precisely the kind of session a deep link points at. */
  entries = entries.filter((e) => !isGoalSessionModes(e.modes) || exempt(e.ownerId));

  if (options.fleets && options.fleets.length > 0) {
    const want = new Set(options.fleets);
    entries = entries.filter((e) => want.has(e.fleetSlug) || exempt(e.ownerId));
  }

  const inView = entries.map((e) =>
    toHudSession(e, byOwner.get(e.ownerId), {
      nowMs,
      thresholds,
      searchHit: options.searchHits?.get(e.ownerId) ?? null,
    }),
  );

  /* The plan filter's options are derived HERE — after the fleet filter, before
     the plan filter — and that ordering is the whole of P-004's "driven by the
     fleets currently in view":

       - AFTER `fleets`, so picking a fleet narrows the plan list to the plans
         that fleet is actually on. That is the feature.
       - BEFORE the plan filter, so the picker does not eat its own options. A
         single-select control whose list collapses to the one row already
         selected can only be changed by first clearing it — two steps to do
         one thing. (The fleet strip derives its chips from the post-filter set
         and has exactly that wrinkle; it gets away with it because its "all
         fleets" chip is always visible on screen. A closed combobox has no
         such affordance, so the plan axis does not inherit the wrinkle.) */
  const plans = derivePlanRollups(inView);

  let sessions = inView;
  if (options.plans && options.plans.length > 0) {
    const wantPlans = new Set(options.plans);
    sessions = inView.filter((s) => wantPlans.has(s.planSlug) || exempt(s.ownerId));
  }

  const counts: Record<HudColumnId, number> = {
    'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0,
  };
  for (const s of sessions) counts[s.column] += 1;

  const columns = HUD_COLUMNS.map((id) => ({
    id,
    label: HUD_COLUMN_LABEL[id],
    empty: HUD_COLUMN_EMPTY[id],
    sessions: sessions
      .filter((s) => s.column === id)
      .sort((a, b) => a.sortKey - b.sortKey || a.handle.localeCompare(b.handle)),
  }));

  return {
    columns,
    fleets: deriveFleetRollups(sessions),
    plans,
    counts,
    total: sessions.length,
    unattributed: unattributedAsks(asks),
  };
}

/**
 * WI-6560 — does this session render IDENTICALLY to that one?
 *
 * The clock-tick half of the fix. `sinceSec` is stored as RAW SECONDS, so it
 * changes on every 15s tick for every session — a plain structural comparison
 * therefore never holds across a tick and `React.memo` misses on every card,
 * even though `formatAge` prints minutes (or hours, or days) and the rendered
 * output is unchanged. For a 12-minute-old session the card is byte-identical
 * while `sinceSec` walks 720 -> 735 -> 750.
 *
 * So the comparison the memo needs is "does this RENDER the same", not "is this
 * the same value". Two fields are treated specially, and only because the card
 * provably does not render them as-is:
 *   - `sinceSec` reaches the DOM only through `formatAge`, so it is compared
 *     through `formatAge`.
 *   - `sortKey` never reaches the card at all; it orders the column, and the
 *     column re-orders by React key. Comparing it would defeat the memo on
 *     every tick for no rendered difference.
 * Everything else is compared STRUCTURALLY via rest-destructuring, so a field
 * added to `HudSession` later is compared automatically. That is the
 * anti-rot property: a hand-listed comparator silently stops covering new
 * fields and starts rendering stale cards, which is far worse than a missed
 * memo. If you add a field the card renders, this needs no change; if you add
 * one it renders through a formatter, extend the special cases above.
 *
 * Verified against the card by test, not by reading: see
 * hud-render-stability.test.tsx, which pins both directions (an age crossing a
 * minute boundary MUST re-render).
 */
/**
 * WI-6560 — MEASUREMENT SEAM. A dev-only ablation switch for the two
 * render-stability fixes in this file (`hudSessionRendersSame` and
 * `reconcileBoardIdentity`). Product code must never write it.
 *
 * WHY THIS EXISTS — it is the thing that unblocks this item, so it is worth
 * stating rather than rediscovering. WI-6560 stalled twice at the SAME wall,
 * and the wall was the measurement design, not the hypothesis. On this box the
 * unchanged control arm measured 46, 76 and 90ms across three boots on
 * IDENTICAL CSS, so a before/after taken across two boots cannot resolve a
 * ~5-10ms effect — it is pure drift. The item's own Round 2 wrote the verdict:
 * only an IN-RUN paired comparison (base and arm interleaved inside one eval,
 * reporting the median of PAIRED deltas) has the power to resolve anything
 * here.
 *
 * But an in-run comparison needs the thing under test to be switchable at
 * RUNTIME, and a landed code fix is not — which is precisely why the previous
 * rounds could only ablate CSS (inline `!important` overrides) and never the
 * React work that this item actually turned out to be about. This switch closes
 * that gap: it makes the fix ablatable, so the fix can be measured by the same
 * paired design that the CSS arms already used.
 *
 * When `off` is true, both functions behave as they did BEFORE the fix landed:
 * the memo comparator always misses (pre-fix, `MemoSessionCard`'s `onOpen` prop
 * was a fresh inline arrow, so its shallow compare never held) and the board is
 * rebuilt with entirely fresh identity.
 *
 * Cost when unused: one boolean property read per comparison.
 *
 * ⚠ It MUST default to `off: false`. A seam left flipped would silently ship the
 * un-fixed behavior while every unit test still passed, so
 * hud-render-stability.test.tsx pins the default rather than trusting review.
 */
export const hudRenderStabilitySwitch: {
  off: boolean;
  /** Times the card comparator ran — i.e. how often the board actually re-rendered. */
  compares: number;
  /** Of those, how many card renders it SKIPPED. This is the fix's work, counted. */
  skips: number;
  /** Times board reconciliation ran, and how often it handed back the previous board. */
  reconciles: number;
  reuses: number;
  /**
   * WI-6755 — renders React ACTUALLY performed on a session card, counted in the
   * card's own body.
   *
   * `compares` above cannot stand in for this, and the difference is the whole
   * reason this counter exists. A memo comparator only runs when React is
   * deciding whether to re-render an ALREADY-MOUNTED element; it is not called
   * on a mount, and it is not called at all when the element is being removed.
   * `HudBoard` swaps the entire sessions subtree out for `entityView` on a tab
   * switch, so a switch that unmounts (or remounts) 132 cards moves `compares`
   * by ZERO — which reads exactly like "no card work happened" while every card
   * is in fact being torn down or built. `cardRenders`/`cardMounts` are the only
   * counters that can tell those two states apart.
   */
  cardRenders: number;
  /** Of those, first-ever renders of that card instance — i.e. mounts. */
  cardMounts: number;
} = {
  off: false,
  compares: 0,
  skips: 0,
  reconciles: 0,
  reuses: 0,
  cardRenders: 0,
  cardMounts: 0,
};

/* The probe drives the app from OUTSIDE the bundle (`tauri-agent-tools eval`),
   so the switch has to be reachable from the page's global scope — an exported
   binding alone is unreachable to it. Assigning the object itself (never a copy)
   keeps the live reference, so a probe writing `.off` is seen by both functions
   above. Guarded for SSR/test environments that have no `window`. */
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__hudRenderStabilitySwitch =
    hudRenderStabilitySwitch;
}

export function hudSessionRendersSame(a: HudSession, b: HudSession): boolean {
  /* Counted BEFORE the ablation branch, so `compares` measures how often the
     board re-rendered regardless of which arm is active — that is what makes it
     a workload bound-check: `compares === 0` means the workload never exercised
     this path at all, and any latency verdict drawn from it would be a
     statement about a dead workload rather than about the fix. */
  hudRenderStabilitySwitch.compares++;
  if (hudRenderStabilitySwitch.off) return false;
  if (a === b) {
    hudRenderStabilitySwitch.skips++;
    return true;
  }
  const { sinceSec: aSince, sortKey: _aSort, ...aRest } = a;
  const { sinceSec: bSince, sortKey: _bSort, ...bRest } = b;
  const same = formatAge(aSince) === formatAge(bSince) && deepEqual(aRest, bRest);
  if (same) hudRenderStabilitySwitch.skips++;
  return same;
}

/**
 * WI-6560 — reuse the PREVIOUS board's object references wherever the freshly
 * derived value is structurally identical, so `React.memo` downstream can
 * actually bite.
 *
 * WHY THIS IS NEEDED AT ALL, stated narrowly — because the obvious claim
 * ("it stops the cards re-rendering") is NOT what it earns. `hudSessionRendersSame`
 * already spares the CARDS: it compares rendered content, so an unchanged roster
 * arriving at the same `nowMs` skips every card render with or without this
 * function. Confirmed by mutation — disabling this reuse leaves the card-render
 * test green.
 *
 * What this earns is IDENTITY ABOVE THE CARD, which no per-card comparator can
 * provide: `buildHudBoard` allocates a new board, new column arrays and new
 * session objects on every call, so everything downstream that memoises on the
 * BOARD (`openLabel`'s useMemo, and any future consumer of `board`/`columns`)
 * is invalidated on every roster poll even when nothing changed. Returning the
 * previous object where the rebuilt one is structurally identical keeps those
 * memos intact and keeps the reference stable for effect dependencies.
 *
 * ⚠ SCOPE — this does NOT help the 15s clock tick, and it is worth being precise
 * about why, because the obvious assumption is wrong. `sinceSec` is stored as
 * RAW SECONDS, so a tick changes it (720 -> 735) on EVERY session even when
 * `formatAge` still prints "12m". Structural equality therefore never holds
 * across a tick and nothing here is reused. The tick is handled at the memo
 * boundary instead, by `hudSessionRendersSame` above. The two are complementary:
 * this one collapses unchanged DATA, that one collapses an unchanged RENDER.
 *
 * Quantising `sinceSec` to display granularity would merge the two cases, and is
 * deliberately not done: `sinceSec` also feeds `sortKey` and the threshold
 * comparisons, so rounding it would change CLASSIFICATION, not just
 * presentation. Comparing at the point of use is the safer half of that trade.
 *
 * Equality is STRUCTURAL (`deepEqual`), never a hand-listed field comparison.
 * That is the load-bearing choice: a hand-written comparator silently goes stale
 * the moment someone adds a field to `HudSession`, and the failure mode is a
 * card that renders permanently stale data — far worse than a missed memo. A
 * structural compare cannot rot that way.
 *
 * Reuse is applied bottom-up (session → column → board) so that an unchanged
 * board returns the IDENTICAL object, which lets memos above the board hold too.
 * A session that is unchanged but has MOVED position still forces a new column
 * object, because the column's rendered order genuinely differs.
 *
 * SAFETY NOTE for the caller: this is a pure cache, so it stays correct even if
 * a render is discarded (React may run a memo and throw the result away). The
 * worst case is that `prev` refers to a board that was never committed; the next
 * comparison is still structural, so the output is never stale — at most one
 * extra re-render happens.
 */
export function reconcileBoardIdentity(prev: HudBoard | null, next: HudBoard): HudBoard {
  // WI-6560 measurement seam — see `hudRenderStabilitySwitch`. Returning `next`
  // unchanged is exactly the pre-fix behavior: a freshly allocated board every call.
  hudRenderStabilitySwitch.reconciles++;
  if (hudRenderStabilitySwitch.off) return next;
  if (!prev) return next;

  const priorByOwner = new Map<string, HudSession>();
  for (const col of prev.columns) {
    for (const s of col.sessions) priorByOwner.set(s.ownerId, s);
  }

  let anyColumnChanged = false;
  const columns = next.columns.map((col, colIdx) => {
    const prevCol = prev.columns[colIdx];
    let columnChanged =
      !prevCol ||
      prevCol.id !== col.id ||
      prevCol.label !== col.label ||
      prevCol.empty !== col.empty ||
      prevCol.sessions.length !== col.sessions.length;

    const sessions = col.sessions.map((s, i) => {
      const prior = priorByOwner.get(s.ownerId);
      if (prior && deepEqual(prior, s)) {
        // Unchanged content — but a different slot means the column's order
        // changed, so the column object itself must not be reused.
        if (!prevCol || prevCol.sessions[i] !== prior) columnChanged = true;
        return prior;
      }
      columnChanged = true;
      return s;
    });

    if (!columnChanged && prevCol) return prevCol;
    anyColumnChanged = true;
    return { ...col, sessions };
  });

  const fleets = deepEqual(prev.fleets, next.fleets) ? prev.fleets : next.fleets;
  const plans = deepEqual(prev.plans, next.plans) ? prev.plans : next.plans;
  const counts = deepEqual(prev.counts, next.counts) ? prev.counts : next.counts;
  const unattributed = deepEqual(prev.unattributed, next.unattributed)
    ? prev.unattributed
    : next.unattributed;

  if (
    !anyColumnChanged &&
    prev.columns.length === next.columns.length &&
    fleets === prev.fleets &&
    plans === prev.plans &&
    counts === prev.counts &&
    unattributed === prev.unattributed &&
    prev.total === next.total
  ) {
    hudRenderStabilitySwitch.reuses++;
    return prev;
  }

  return { columns, fleets, plans, counts, total: next.total, unattributed };
}
