/**
 * adv-agent-detail.ts — Tier-3 per-agent enrichment for the Sessions dossier
 * (plan adv-sessions-live-roster-2026-06-02, P-009). This is the LAZY half of
 * the roster: the cheap presence-primary list (adv-roster.ts) renders the grid;
 * opening one agent's detail pane fetches THIS, scoped to a single owner, so the
 * roster query stays one cheap read while the dossier joins across stores.
 *
 * Two cross-store reads, run concurrently:
 *   - locks  → papercusp_su agent_file_locks / agent_lock_waiters (readQueue)
 *   - coord  → harness_shared coord_event_log (messages / handoffs / escalations)
 *
 * As with adv-roster, the DB I/O is a thin wrapper; the shaping logic is pure
 * (deriveAgentLocks / deriveCoordState) so it unit-tests without PG.
 */

import { readAckedMsgIds, readInvolvingOwner } from './agent-tools/coordination/messages';
import { ownerVisiblePromptText } from './agent-tools/coordination/owner-chat-turn';
import { readWatermark, pickUnreadCursor } from './agent-tools/coordination/watermarks';
import { lastInboxReadAtBatch } from './agent-tools/coordination/inbox-read-freshness';
import { listHandoffs, type HandoffWithAcceptance } from './agent-tools/coordination/handoffs';
import { listEscalations, type EscalationRecord } from './agent-tools/coordination/escalations';
import { latestAdvSessionByCoordOwner, firstAdvSessionStartByCoordOwner } from './adv-sessions';
import {
  ensureBootstrap,
  getTxPool,
  readQueue,
  type QueueResult,
} from './agent-tools/locks/su-lock-store';
import type { CoordEnvelope } from '@papercusp/coordination/core';
// unread-count-truthfulness-2026-07-27 P-005 / D-006: the SAME default-visibility
// rules coord:inbox applies, imported from the pure module they were relocated to
// (never re-implemented here — a second copy would drift from the reader).
import {
  isAmbientBroadcast,
  excludeIntentDeclares,
  coalesceRepeatedBroadcasts,
} from './agent-tools/coordination/inbox-visibility';
import { collectRetractedIds, suppressRetracted } from './agent-tools/coordination/retraction';
// Read-only dossier diagnostics live outside role-codex-home so this cold path
// does not link the Codex spawn/TOML builder into every agent-detail request.
import { readCodexHomeDiagnostics, type CodexHomeDiagnostics } from './codex-home-diagnostics';
// The admission funnel's stage vocabulary, so the dossier's drop breakdown is
// named and explained from the SAME source the write path records against.
import { ADMISSION_STAGES, ADMISSION_STAGE_SHORT_WHY } from './memory/recall-stats';
import {
  nativeSessionHandleForAdvSession,
  claudeHandleAfterRematerializeAttempt,
  type NativeSessionHandle,
  type ClaudeNativeSessionHandle,
} from './native-session-handles';
// hud-first-nav-and-dossier-2026-07-26 P-005: the six "is this agent healthy and
// will it keep going?" signals, each sourced from an EXISTING roster/sync feed
// (no new query per field) — see the docstring on `getAgentSignals` below.
import { getLoopStatus } from './harness/routines/loop';
import { readHeldWorkItems } from './carry-brief';
import { getPresence } from './agent-tools/coordination/presence';
// P-009 leg (c): the SHARED stalled-lane threshold + oracle. Imported, never
// re-derived — a second local rule is how two surfaces end up disagreeing about
// whether the same agent is stalled.
import { computeIntentStale } from './agent-tools/coordination/presence-tier1';
import {
  resolveSessionStates,
  type LivenessVerdict,
} from './agent-tools/coordination/liveness-oracle';
import { fetchPresenceFleet } from './agent-tools/coordination/presence-fleet';
import {
  fetchOrientPipeline,
  type OrientPipeline,
} from './agent-tools/coordination/pipeline-health';
import { fetchUnansweredDirected } from './agent-tools/coordination/unanswered-directed';
import { lastToolCallAtByOwner } from './fleet/assignments';
import { activeWorkspaceId } from './workspace-registry';

// ──────────────────────────── DTOs (the endpoint JSON contract) ────────────
// Dates are ISO strings on the wire (readQueue returns Date objects; we map).

export interface LockHeld {
  path: string;
  intent: string;
  acquiredAt: string;
  expiresAt: string;
}

/** An active lock held by ANOTHER agent that overlaps a path this agent waits on. */
export interface LockBlocker {
  path: string;
  holder: string;
  holderLabel: string | null;
  intent: string;
  expiresAt: string;
}

export interface LockWaiting {
  ticketId: string;
  paths: string[];
  intent: string;
  /** Position in the global lock-waiter FIFO (0 = next to be granted). */
  aheadCount: number;
  queuedAt: string;
  waitUntil: string;
  /** Who currently holds the path(s) this ticket is blocked on. */
  blockedBy: LockBlocker[];
}

export interface AgentLocks {
  held: LockHeld[];
  waiting: LockWaiting[];
  /** Non-null when the locks read failed (store unreachable); UI shows it gracefully. */
  error: string | null;
}

export interface CoordMessageSummary {
  msgId: string;
  from: string;
  to: string[];
  kind: string;
  summary: string;
  ts: string;
  direction: 'inbound' | 'outbound';
}

export interface CoordHandoffSummary {
  msgId: string;
  from: string;
  to: string[];
  summary: string;
  ts: string;
  planSlug: string | null;
  nextAction: string | null;
  direction: 'inbound' | 'outbound';
  accepted: boolean;
}

export interface CoordEscalationSummary {
  msgId: string;
  severity: EscalationRecord['severity'];
  summary: string;
  ts: string;
  planSlug: string | null;
}

export interface AgentCoordState {
  /** Most recent message directly involving this agent (sent or addressed to it). */
  lastMessage: CoordMessageSummary | null;
  /**
   * Messages addressed to this agent (kind=message; broadcasts included,
   * self-sent excluded) that arrived AFTER its last read receipt and were
   * never explicitly acked. Null receipt (no watermark, no recorded
   * coord:inbox/orient call) ⇒ the agent genuinely has read nothing, so the
   * whole log counts — that is the honest answer, not a bug.
   */
  unreadCount: number;
  /**
   * THE MESSAGES `unreadCount` COUNTS — newest first, bounded to
   * `UNREAD_LIST_LIMIT`.
   *
   * [owner 2026-07-28, verbatim] "I looked up the conversation for
   * su-4ef7fb1d and it says in the COORD section 38 unread, but I only see 2
   * messages, why? fix it". Before this field the state carried the COUNT and
   * threw the rows away, so the dossier's coord section could only ever render
   * `lastMessage` (exactly one) plus open handoffs/escalations. A badge saying
   * 38 sat beside a section structurally incapable of showing 38 — and there
   * was no scroll, no pagination and no "show all", because the data to show
   * simply was not carried.
   *
   * Built from the SAME array whose length is `unreadCount` (never a second
   * query and never a re-derivation), so the list and the badge cannot drift
   * apart — which is exactly the failure D-006 names: a counter that disagrees
   * with its reader.
   *
   * `unreadCount` stays the TRUE total and is deliberately NOT capped to this
   * list's length (D-003: capping the badge to a page size would just be a new
   * lie). When `unreadCount > unread.length` the surface must say so — the
   * dossier renders "showing N of M".
   */
  unread: CoordMessageSummary[];
  /** Open (un-accepted) handoffs this agent sent or received. */
  openHandoffs: CoordHandoffSummary[];
  /** Open (unresolved) escalations this agent raised. */
  openEscalations: CoordEscalationSummary[];
  error: string | null;
}

/**
 * hud-first-nav-and-dossier-2026-07-26 P-005: "is this agent healthy and will
 * it keep going?" — six signals the dossier panel didn't surface before this,
 * each read from an EXISTING primitive (no new query authored for any of
 * them):
 *   1. loop            — `getLoopStatus` (harness/routines/loop.ts), the same
 *                         read `loop:status` and the leader-brief use.
 *   2. currentClaim     — `readHeldWorkItems` (carry-brief.ts), the same held-
 *                         item read the carry doc / post-compaction recovery
 *                         fold use. The panel showed PLAN but never the
 *                         work-item within it.
 *   3. contextTokens/
 *      compactionLimit  — `getPresence` (coordination/presence.ts); the HUD
 *                         board already derives its context% bar from the
 *                         same two fields (hud-board-model.ts `contextPct`).
 *   4. lastCheckpoint   — the SAME `readHeldWorkItems` row's `.checkpoint` —
 *                         the carry note a restart would resume from.
 *   5. unansweredDirectedCount — `fetchUnansweredDirected` (unanswered-
 *                         directed.ts), the same fold `fleet:assignments`'
 *                         `unanswered_directed` summary counts against.
 *   6. lastToolCallAt   — `lastToolCallAtByOwner` (fleet/assignments.ts), the
 *                         "real work" freshness signal distinct from the
 *                         60s-keepalive `heartbeatAt` already shown above (a
 *                         warm-dead session can heartbeat while doing nothing).
 */
export interface AgentDossierLoopStatus {
  active: boolean;
  intervalSec: number | null;
  nextFireAt: string | null;
  parked: boolean;
  stalled: boolean;
}

/** The shared liveness-oracle verdict projected for the dossier Health rail. */
export interface AgentDossierLiveness {
  sessionState: LivenessVerdict['sessionState'];
  /** A turn is actively speaking; false means the session is currently silent. */
  liveTurn: boolean;
}

/**
 * Is the agent holding this claim actually MOVING it? (P-009 leg (c) — the
 * health word the deck renders on the claim's own row.)
 *
 * A claim id alone is the single most misread field in the dossier: it looks
 * identical whether the holder took it 30 seconds ago or wandered off two hours
 * back, and "held" reads as "being worked on". That is exactly the wrong
 * conclusion for the reader who matters here — a leader deciding whether to
 * reclaim — so the id never renders without this verdict beside it.
 *
 * `unknown` is a first-class third state, NOT a pessimistic default: presence
 * carries no activity timestamp until a row's first genuine-activity write, and
 * guessing `stalled` there would invent a stall out of missing data.
 */
export type ClaimProgress = 'progressing' | 'stalled' | 'unknown';

export interface AgentDossierClaim {
  id: string;
  title: string | null;
  harness: string | null;
  /** Derived from the holder's last GENUINE activity vs INTENT_STALE_SEC — the
   *  same threshold + `computeIntentStale` oracle every other surface judges a
   *  stalled lane with, never a second local rule (a divergent idea of "stalled"
   *  is worse than none: two surfaces then disagree about the same agent). */
  progress: ClaimProgress;
  /** Seconds since that last genuine activity — what makes the verdict legible
   *  ("stalled 40m" vs a bare "stalled"). null ⇔ progress === 'unknown'. */
  idleSec: number | null;
}

export interface AgentDossierCheckpoint {
  text: string;
  updatedAtMs: number | null;
}

/**
 * EI-18694403367371331: the underlying read for each signal below is best-
 * effort (`.catch(() => <empty>)`) so ONE broken source can never crash the
 * whole dossier — but that previously collapsed "the read threw" into the
 * exact same shape as "the agent genuinely holds/has none", which reads as
 * healthy-idle when it may really mean broken-and-invisible. A key present in
 * `unavailableSignals` means ITS read threw this call — render "unavailable",
 * never the same look as a legitimate empty/none state.
 */
export type AgentSignalKey =
  | 'loop'
  | 'liveness'
  | 'currentClaim'
  | 'context'
  | 'unanswered'
  | 'lastToolCall'
  | 'lane'
  | 'announcedGates'
  | 'fleetControl'
  | 'pipeline';

/**
 * P-009 leg (a) — the agent's LANE: which plan it declared, and what that plan
 * says about where the work stands.
 *
 * The dossier could already answer "what is this agent holding" but not "what is
 * it FOR" — and a claim id divorced from its plan's `## Now` is unreadable to
 * anyone who did not write the plan. This is the section that makes the rest of
 * the rail interpretable.
 */
export interface AgentLane {
  planSlug: string;
  /**
   * WHERE the plan came from, because the two legs are not equally strong and a
   * reader deciding "is this agent really on this plan" needs to know which one
   * answered.
   *
   * `declared` — the agent itself said so (`coord:orient { planSlug }` →
   * presence.currentPlanSlug). Current by construction, and it MOVES when the
   * agent moves between plans mid-session.
   * `launch` — nobody declared anything; this is the plan the session was
   * SPAWNED on (`adv_sessions.plan_slug`, stamped by fleet:launch-on-plan and
   * any `--plan` launch). Fixed at spawn, so it can be stale if the agent has
   * since moved on — but it is real evidence, and suppressing it is what made
   * the dossier narrower than the roster (D-006).
   */
  source: 'declared' | 'launch';
  /** The plan's `## Now` state/next lines — null when the plan carries no Now block. */
  nowState: string | null;
  nowNext: string | null;
  /** The first ACTIONABLE item (effectiveStatus todo, no unresolved blockers,
   *  not needs-human) — the same admissibility `plans:get` computes, resolved
   *  through the shared `resolveEffectiveStatus` oracle rather than a second
   *  local rule. null when nothing qualifies (plan fully claimed/blocked/done). */
  nextActionable: { id: string; title: string; phase: string | null } | null;
  /** How many items meet that same bar — "3 items in this lane". A count of 0
   *  with a non-null `nowState` is the honest signal that a plan is alive but
   *  has nothing pickable, which a single `nextActionable` alone cannot say. */
  claimableCount: number;
}

/**
 * P-009 leg (b) — an announced gate VISIBLE to this agent. Rendered SPLIT
 * against the agent's live subscriptions: awaited on one side, available-but-
 * not-awaited on the other.
 *
 * Neither half is diagnostic alone, which is the whole reason the deck insists
 * on showing both together. An await on a key nobody ever declared looks
 * perfectly healthy in the subscriptions list — it is simply a wait that will
 * never end. A declared gate the agent is not listening for looks like nothing
 * at all. Side by side, both failures are obvious at a glance.
 */
export interface AgentAnnouncedGate {
  event: string;
  note: string | null;
  /** `fleet:<slug>` / `plan:<slug>` / `harness:<slug>` / `global`. */
  scope: string;
  announcedBy: string;
  /** True when this agent has NO active await on the key. Computed EXACT-match
   *  on purpose: a near-miss key (`phase3_ready` vs `phase-3-ready`) does NOT
   *  rendezvous at runtime, so collapsing the two here would hide precisely the
   *  bug this split exists to expose. */
  awaited: boolean;
}

/**
 * P-009 leg (d) — the agent's fleet control state, surfaced ONLY when it is not
 * plain `active`.
 *
 * That conditionality is the design: a fleet winding down is news, an active one
 * is not, so the section's mere PRESENCE is the signal. It answers "why is this
 * agent refusing work" for a reader who never saw the wind-down cue — including
 * one looking at an agent that joined after it was issued.
 */
export interface AgentFleetControl {
  fleet: string;
  state: string;
  reason: string | null;
  by: string | null;
  /** Epoch ms, as the registry stores it. */
  since: number | null;
}

export interface AgentSignals {
  /** null when the agent has no engine loop routine at all (never armed) —
   *  OR the read threw; check `unavailableSignals` to tell them apart. */
  loop: AgentDossierLoopStatus | null;
  /** One shared-oracle verdict, never a heartbeat-derived lookalike. null when
   *  the oracle degraded; check `unavailableSignals` for that fail-soft state. */
  liveness: AgentDossierLiveness | null;
  /** The agent's most recently taken held work-item, or null if it holds none
   *  — OR the read threw; check `unavailableSignals` to tell them apart. */
  currentClaim: AgentDossierClaim | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  /** null when the held claim (if any) carries no checkpoint yet. */
  lastCheckpoint: AgentDossierCheckpoint | null;
  /** Directed messages (never a broadcast) addressed to this agent that are
   *  still unanswered — "how many peers are blocked on this agent". */
  unansweredDirectedCount: number;
  /** Last recorded tool_invocations row for this owner — null if never observed. */
  lastToolCallAt: string | null;
  /** The agent's declared plan + where that plan stands. null when it declared
   *  no plan, the plan is unreadable — OR the read threw; check
   *  `unavailableSignals` to tell a lane-less agent from a broken read. */
  lane: AgentLane | null;
  /** The release-pipeline block — THE SAME `OrientPipeline` this agent is handed
   *  at its own wake (`fetchOrientPipeline`, shared 60s single-flight cache), so
   *  the popup shows what the agent was told rather than a lookalike re-derived
   *  from a different snapshot.
   *
   *  Repo-global rather than per-agent, and included anyway because it answers a
   *  question the rest of this dossier cannot: whether the work described above
   *  it can reach `:3070` at all. A reader looking at a busy, healthy agent whose
   *  merges are going nowhere has no other signal for it here.
   *
   *  `null` is UNMEASURED (`health.known === false`, or the read had a bad day —
   *  the producer is fail-soft by construction and resolves null rather than
   *  throwing), so per plan D-011 it renders as NOTHING. It is deliberately NOT
   *  reported through `unavailableSignals`: nothing threw, so there is no failed
   *  read to disclose — and a green pipeline is likewise silent, never an
   *  "all clear" badge. */
  pipeline: OrientPipeline | null;
  /** Gates visible to this agent, each flagged awaited / not-awaited. Empty is a
   *  legitimate answer (nothing declared in its scopes) — a THROWN read is
   *  reported through `unavailableSignals`, never as an empty list. */
  announcedGates: AgentAnnouncedGate[];
  /** Present only when the agent's fleet is NOT in plain `active` control state
   *  (see the DTO) — null for a non-fleet agent, an active fleet, or a failed read. */
  fleetControl: AgentFleetControl | null;
  /** Signal keys whose underlying read THREW this call rather than returning
   *  genuinely empty data (EI-18694403367371331). Empty array = every signal
   *  resolved normally (even if some legitimately came back empty/none). */
  unavailableSignals: AgentSignalKey[];
}

/** One event this agent is currently subscribed to — an un-fired, un-cancelled
 *  row in `harness_shared.event_awaits`. */
export interface AgentSubscription {
  eventKey: string;
  policy: string;
  note: string | null;
  /** One-shot await (fires once, then auto-consumes) vs a standing watch that
   *  survives each fire. The two behave very differently for a reader deciding
   *  whether an agent will wake AGAIN, so it is surfaced rather than inferred. */
  once: boolean;
  /** A fire actually WAKES the agent (it carries a wake handle). A subscription
   *  without one is observational: it records the fire but starts no turn. */
  wakes: boolean;
  /** Bypasses the per-subscriber wake floor (human-message / escalation watch). */
  urgent: boolean;
  createdAt: string;
  expiresTs: string | null;
}

/** The agent's live event subscriptions, for the dossier's Events section. */
export interface AgentSubscriptions {
  /** Newest first, bounded by the store's own LIMIT 100. */
  items: AgentSubscription[];
  count: number;
  /** Set when the underlying read FAILED. Never collapse a failure into an
   *  empty list: "subscribed to nothing" and "we could not ask" are opposite
   *  conclusions for anyone deciding whether an agent will ever wake again
   *  (same rationale as `getAgentSignals`' unavailableSignals). */
  error?: string;
}

/** One injection moment: context this agent was PUSHED, and whether retrieval
 *  was healthy when it happened. */
export interface PushedContextEvent {
  /** ISO — when the recall behind this injection ran. */
  at: string;
  /** The injection port that pushed it (turn-start, mid-turn, wake-brief, …). */
  surface: string;
  /** What the index RETURNED, before the six admission filters. */
  returned: number;
  /** What actually reached the agent. The gap between this and `returned` is
   *  the whole point of the section — "was given context" vs "was given the
   *  context that survived". */
  admitted: number;
  /** The char budget cut the tail off an already-RANKED list. */
  truncated: boolean;
  /** Did the SEMANTIC (cosine) leg execute? `null` = not recorded (a pre-P-002
   *  row), which is NOT the same as `false` (the leg was short-circuited). That
   *  distinction is the column P-013 exists for, so it must survive the DTO. */
  semanticRan: boolean | null;
  /** Did the LEXICAL leg execute? Same null-vs-false rule as above. */
  lexicalRan: boolean | null;
  /**
   * The funnel BEHIND the summary counts, for the row's hover panel. Absent
   * whenever the ledger row carries nothing beyond what the fields above
   * already say — see `derivePushedDetail` for the emission rule and why an
   * empty block is worse than no block.
   */
  detail?: PushedContextEventDetail;
}

/** One admission stage that actually dropped rows on this recall. */
export interface PushedContextDroppedStage {
  /** The stage key as `recall-stats.ts` records it (`dedup`, `budget`, …). */
  stage: string;
  /** How many rows it removed. Always > 0 — see the emission rule below. */
  count: number;
  /**
   * The stage's one-clause explanation, resolved SERVER-side from
   * `ADMISSION_STAGE_SHORT_WHY` and shipped rather than re-typed in the client.
   * The client cannot import that vocabulary (`recall-stats.ts` pulls in
   * `@papercusp/flags/server`), and a hand-copied gloss in a component is how a
   * count and its explanation drift apart.
   */
  why: string;
}

/** What one retrieval leg did, beyond whether it ran. */
export interface PushedContextLegDetail {
  /** Rows the leg returned, pre-fusion. Absent when it did not run. */
  candidates?: number;
  /**
   * Rows that cleared this leg's OWN bar and were given a rank in the fusion
   * (the lexical leg's `minLexScore`). `candidates - qualifying` is what the bar
   * removed — the number that says whether the bar is doing anything, and the
   * reason a leg can show a green "ran" tick while contributing nothing.
   */
  qualifying?: number;
  /**
   * The per-scope row budget in effect for this leg on this call. PER-SCOPE, so
   * `candidates` legitimately exceeds it on a multi-scope recall (measured
   * 2026-08-09: depth 12, candidates 25) — do NOT derive a saturation verdict
   * by comparing the two, which is why this DTO carries the raw numbers and
   * computes nothing.
   */
  depth?: number;
}

/**
 * The admission funnel and per-leg detail behind one injection row.
 *
 * Every field is OPTIONAL for the wire-skew reason documented on
 * `AgentPushedContext.refs`: the SPA rebuilds on the vite hot path while the
 * sidecar only rebuilds on restart, so a fresh bundle can be handed an older
 * payload. Read each field defensively.
 */
export interface PushedContextEventDetail {
  /**
   * ONLY the stages that dropped something, in the funnel's own pipeline order.
   *
   * The zeros are dropped on purpose: a real row is `{ dedup: 3, budget: 8,
   * pack: 0, feedback: 0, workspace: 0, nearDuplicate: 0 }`, and rendering all
   * six buries the two numbers that explain where the rows went behind four that
   * say nothing happened.
   */
  dropped?: PushedContextDroppedStage[];
  /** Chars the admitted lines actually consumed. */
  spent?: number;
  /** The char budget in force at this port — PER-PORT and deliberately tight
   *  (mid-turn runs ~350 against a 16,000 global default), so a low admit rate
   *  here is usually the design working rather than a defect. */
  budgetChars?: number;
  /** Which leg(s) the ADMITTED rows came from. Counts only — no per-ref leg
   *  attribution exists anywhere (D-085). */
  byLeg?: { both: number; cosineOnly: number; lexicalOnly: number };
  /** The fusion mode in effect (`cosine-gated` | `floored-union`). */
  mode?: string;
  /** Distinct entries in the FUSED candidate set, before any caller limit. */
  fused?: number;
  /** The semantic leg. Pairs with `semanticRan` above, which holds the tri-state. */
  cosine?: PushedContextLegDetail;
  /** The lexical leg. Pairs with `lexicalRan` above. */
  lexical?: PushedContextLegDetail;
}

/**
 * Which ledger a ref count came from. REQUIRED, and the reason is measured:
 * the two ledgers deliberately record the SAME `port` labels (see
 * `memory/corpus-surfaced-ledger.ts`'s header), and on 2026-08-09 all 6 corpus
 * ports — mid-turn, turn-start, claim, initialize, create, compact — also
 * existed as memory ports. So a port label alone never identifies a row, and
 * summing the two would report two different KINDS of thing as one number
 * 100% of the time rather than in some edge case.
 *
 * `memory` = mem0 memories (`memory_session_surfaced`, keyed `memory_id uuid`).
 * `corpus` = corpus handles like `WI-6512` (`corpus_session_surfaced`, keyed
 * `ref text`). A pointer the agent chose not to resolve is not a fact it was
 * given, which is exactly why these must stay countable apart.
 */
export type PushedContextRefKind = 'memory' | 'corpus';

/** Distinct refs surfaced to this session, per injection port AND kind. */
export interface PushedContextPortRefs {
  port: string;
  refs: number;
  kind: PushedContextRefKind;
}

/**
 * ONE ref actually surfaced to this session.
 *
 * The LEDGER stores the handle and never the body (D-004: the surfaced ledgers
 * are pointer stores, and stamping a title INTO them would invent the write
 * path that decision forbids). `title`/`detail` below do not touch that: they
 * are resolved at READ time from the canonical row the pointer already names,
 * and nothing is persisted. Recorded as
 * context-injection-retrieval-reach-and-visibility-2026-08-03#D-092 so the next
 * reader does not have to re-derive that a read-side join is not a write path —
 * this very comment used to assert the opposite, and that over-reading is why
 * the section shipped rendering handles nobody could act on.
 *
 * [owner 2026-08-09] "the user doesn't care about the ids, it should show a
 * title" — a dossier row reading `mem 89f230d3…` names a fact the operator
 * cannot act on, which is the same defect as a count that names rows the list
 * cannot show.
 *
 * `kind` doubles as the LEG OF ORIGIN, and it is the ONLY leg attribution that
 * exists per ref: each ledger has exactly one writer, so a `corpus` row came
 * from the corpus pointer leg and a `memory` row from the mem0 recall leg, by
 * construction (`memory/injection.ts` → `stampSurfacedRefs`). The finer
 * cosine-vs-lexical attribution is NOT recorded per ref anywhere — recall_stats'
 * `admission.byLeg` carries COUNTS (`{cosineOnly, lexicalOnly, both}`), never a
 * per-ref label, and no column ties a surfaced row back to a recall row. The
 * only available tie is a (session, port, nearest-time) heuristic, measured at
 * 76% exact / 21% no-match / 3% ambiguous — so it is recorded as plan decision
 * D-085 rather than rendered as if it were exact.
 */
export interface PushedContextRef {
  /** The handle: a corpus pointer (`WI-6512`) or a mem0 memory id (uuid). */
  ref: string;
  kind: PushedContextRefKind;
  /** The injection port it arrived at. `(unrecorded)` when the ledger row
   *  carries none — `corpus_session_surfaced.port` is nullable, so an absent
   *  label must read as absent rather than as a port named "null". */
  port: string;
  /** ISO — when it was FIRST surfaced under `epoch`. Both ledgers key on
   *  (session_id, epoch, ref) and stamp once, so a ref repeated inside an epoch
   *  is SUPPRESSED rather than re-stamped: this is when the agent was first
   *  given it, not the only turn it was in context. */
  at: string;
  /** Compaction epoch it was surfaced under — the dedup scope above. */
  epoch: number;
  /** Human label for the row, resolved at read time. Absent whenever
   *  `titleState` is not `'ok'` — read the two together, never `title` alone. */
  title?: string;
  /** The fuller body behind `title`, for the hover detail. Capped
   *  (`PUSHED_REF_DETAIL_MAX_CHARS`) — the dossier is a rail, not a reader. */
  detail?: string;
  /**
   * TRI-STATE, and the reason is the same one the `semanticRan` glyphs above
   * exist for: the three cases are operationally different and collapsing them
   * loses the only interesting one.
   *
   *   `undefined`    — resolution was never ATTEMPTED (the pure-shaper path,
   *                    and any older payload from before this field existed).
   *   `'ok'`         — resolved; `title` is set.
   *   `'unresolved'` — we looked and the canonical row is NOT there. A real
   *                    finding: the agent was handed a pointer to something
   *                    that has since been deleted or was never fetchable.
   *   `'unavailable'`— the lookup ITSELF failed. Says nothing about the row.
   *
   * Rendering `'unresolved'` and `'unavailable'` the same way would report "we
   * could not ask" as "there is nothing there", which is the exact conflation
   * `unavailable` on the parent DTO already exists to prevent.
   */
  titleState?: 'ok' | 'unresolved' | 'unavailable';
}

export interface AgentPushedContext {
  /** Newest first, CAPPED (see `count` for the true total in the window). */
  events: PushedContextEvent[];
  /** Every injection in the window, not just the ones `events` could carry —
   *  the Coord section's lesson [owner 2026-07-28: "it says 38 unread, but I
   *  only see 2 messages"]: a count must never name rows the list cannot show. */
  count: number;
  /** From the per-session surfaced ledgers — the refs, never the bodies.
   *  Carries BOTH kinds; read `kind`, never `port` alone, to tell them apart. */
  refsByPort: PushedContextPortRefs[];
  /** The handles themselves, newest first, CAPPED — this is P-013's "what was
   *  pushed", one row per ref instead of a per-port tally. */
  refs: PushedContextRef[];
  /** Ledger rows in the window across the ledgers that ANSWERED, so the carried
   *  slice above can never masquerade as the total (the same honesty rule as
   *  `count`). Read it WITH `unavailable`: a ledger that could not be read
   *  contributes 0, which is not a ledger that surfaced nothing. */
  refsTotal: number;
  /** Sources that could not be read while the OTHERS succeeded — e.g. the
   *  corpus ledger on a box where migration 712 has not been applied.
   *
   *  This is the partial-failure half of the `error` rule below, and it needs
   *  its own channel precisely because it must NOT replace the data: reporting
   *  it through `error` would hide the sources that did answer, while dropping
   *  it would render "we could not ask this ledger" as "this ledger surfaced
   *  nothing" — the exact conflation this DTO exists to prevent. */
  unavailable?: string[];
  /** Set when the read FAILED. Never collapse a failure into an empty list:
   *  "nothing was pushed to this agent" and "we could not ask" are opposite
   *  conclusions (same rule as `getAgentSignals` / `getAgentSubscriptions`). */
  error?: string;
}

export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  nativeSession: NativeSessionHandle | null;
  codex: CodexHomeDiagnostics | null;
  /** Optional (not required) so existing fixtures/mocks built before P-005
   *  (e.g. the chat footer's summary-chip test harness, a second reader of
   *  this SAME DTO) keep compiling without an update — `getAgentDetail`
   *  always populates it for real traffic. */
  signals?: AgentSignals;
  /** Optional for the same reason as `signals` above: this DTO has other
   *  readers whose fixtures predate the field. Always populated for real
   *  traffic by `getAgentDetail`. */
  subscriptions?: AgentSubscriptions;
  /** Optional for the same reason as `signals`/`subscriptions` above — and
   *  here it is load-bearing rather than courtesy: making it REQUIRED would
   *  strand every fixture that constructs an AgentDetail, in files this change
   *  never touches (the `lint:required-field-strands` trigger). */
  pushedContext?: AgentPushedContext;
}

// ──────────────────────────── pure shaping ─────────────────────────────────

/**
 * Normalise a timestamp to real ISO-8601.
 *
 * ⚠ The string branch used to be a bare `String(d)` passthrough, and that was
 * WRONG against live data rather than merely lax: measured 2026-08-09, this
 * module's PG reads hand back timestamptz as the postgres wire format
 * (`2026-08-09 09:12:26.944435-04`) — no `T`, no `Z` — so every field this
 * DTO documents as "ISO" was shipping a non-ISO string. It went unnoticed
 * because `new Date()` parses that form happily, so the UI rendered fine and
 * only a consumer that treated the field AS a string could see it.
 *
 * Which is exactly what made it worth fixing rather than tolerating: the P-013
 * ref list merges two independently-sorted result sets and orders them by
 * comparing `at` LEXICALLY. Mixed formats sort wrongly — `'…T09:12'` sorts
 * after `'… 09:12'` because `'T' > ' '` — so a single Date-valued row among
 * string-valued ones would have silently mis-ordered the list.
 *
 * Unparseable input falls through unchanged: a label we cannot read is not
 * improved by rendering it as "Invalid Date".
 */
function iso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  const s = String(d);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? s : new Date(ms).toISOString();
}

/**
 * Split a full lock-queue snapshot into one agent's held locks + waiting
 * tickets, cross-referencing each waiting ticket to the lock(s) currently
 * blocking it. Pure → unit-tested. `queue` is the UNFILTERED readQueue result
 * (so blockers from other owners are visible and ahead_count is global).
 */
export function deriveAgentLocks(queue: QueueResult, owner: string): AgentLocks {
  const held: LockHeld[] = queue.active_locks
    .filter((l) => l.owner === owner)
    .map((l) => ({
      path: l.path,
      intent: l.intent,
      acquiredAt: iso(l.acquired_ts),
      expiresAt: iso(l.expires_ts),
    }));

  const waiting: LockWaiting[] = queue.waiting
    .filter((w) => w.owner === owner)
    .map((w) => ({
      ticketId: w.ticket_id,
      paths: w.paths,
      intent: w.intent,
      aheadCount: w.ahead_count ?? 0,
      queuedAt: iso(w.queued_ts),
      waitUntil: iso(w.wait_until),
      blockedBy: queue.active_locks
        // WI-5979: match WITHIN a lock domain. The read is now cross-domain, and
        // the same repo-relative path in two different checkouts is two different
        // physical files — cross-attributing them would invent blockers.
        .filter(
          (l) =>
            l.owner !== owner &&
            l.coordination_domain === w.coordination_domain &&
            w.paths.includes(l.path),
        )
        .map((l) => ({
          path: l.path,
          holder: l.owner,
          holderLabel: l.owner_label,
          intent: l.intent,
          expiresAt: iso(l.expires_ts),
        })),
    }));

  return { held, waiting, error: null };
}

/** Stable (ts, msg_id) ascending comparator — the canonical coord ordering. */
function byTs(a: CoordEnvelope, b: CoordEnvelope): number {
  return a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id);
}

/** Direction relative to the agent (helper keeps the literal type through .map). */
function directionFor(from: string, owner: string): 'inbound' | 'outbound' {
  return from === owner ? 'outbound' : 'inbound';
}

/**
 * Recipients of an envelope, defensively.
 *
 * `getAgentCoordState` reads the append-only coord log and CASTS the raw lines
 * to `CoordEnvelope[]` — an unchecked assertion over a historical file that
 * spans format changes and several writers, so `to` is not guaranteed to be the
 * array the type promises. It only has to be missing on ONE row: every call
 * site below is inside a `.filter`, the throw escapes to getAgentCoordState's
 * try/catch, and the whole Coord section collapses to an error string for EVERY
 * agent (owner-reported 2026-07-26: "Cannot read properties of undefined
 * (reading 'includes')" rendered in place of the panel's coord state).
 *
 * Coercing here — rather than `?? []` at each of the four call sites — keeps the
 * fix in one place and makes the degradation proportionate: a malformed row
 * simply matches no owner, instead of blinding the panel.
 */
/**
 * Max unread rows carried in `AgentCoordState.unread`.
 *
 * A BOUND ON THE LIST ONLY — never on `unreadCount`, which stays the true
 * total (D-003: a badge capped to its page size is just a different lie). 25 is
 * the reader's own default page, so the dossier shows what one `coord:inbox`
 * read would show and says "showing 25 of M" past that.
 */
export const UNREAD_LIST_LIMIT = 25;

function recipientsOf(env: { to?: unknown }): string[] {
  return Array.isArray(env.to) ? (env.to as string[]) : [];
}

/**
 * Shape one agent's coord state from the raw message log + handoff/escalation
 * folds. Pure → unit-tested. `messages` is the full `messages` surface;
 * `acked` is the set the owner has acknowledged; `handoffs`/`escalations` are
 * already folded to status=open; `readCursor` is the agent's last read
 * receipt (see `readUnreadCursor`), or null when it has none on record;
 * `bornAt` is the BIRTH FLOOR, which governs BROADCASTS ONLY (WI-6589).
 */
export function deriveCoordState(
  messages: CoordEnvelope[],
  acked: Set<string>,
  handoffs: HandoffWithAcceptance[],
  escalations: EscalationRecord[],
  owner: string,
  readCursor: string | null,
  bornAt: string | null = null,
): AgentCoordState {
  // Last message directly involving the agent — sent by it or addressed to it.
  // Pure '*' broadcasts where the agent isn't explicitly listed are excluded:
  // they aren't really "this agent's" message.
  const involving = messages
    .filter((m) => m.from === owner || recipientsOf(m).includes(owner))
    .sort(byTs);
  const last = involving.length > 0 ? involving[involving.length - 1] : null;
  const lastMessage: CoordMessageSummary | null = last
    ? {
        msgId: last.msg_id,
        from: last.from,
        to: last.to,
        kind: last.kind,
        summary: last.summary ?? last.body ?? '',
        ts: last.ts,
        direction: directionFor(last.from, owner),
      }
    : null;

  // Unread = inbox messages (to the agent or broadcast) of kind 'message', not
  // self-sent, that arrived AFTER the agent's last read receipt and were not
  // explicitly acked.
  //
  // The read-cursor leg is unread-count-truthfulness-2026-07-27 P-002. Before
  // it, this counted the WHOLE log minus explicit acks — and agents essentially
  // never send an explicit `kind:'ack'`, so the badge was an all-time total. It
  // read 19,391 for one live agent (19,390 of them broadcasts), which is the
  // ~19k the owner reported. Note the fix is to INTRODUCE a cursor, not to add
  // a fallback to a dead one: unlike the continuation gate, this path never
  // consulted `messages_since_ts` at all (D-004).
  //
  // ts values are ISO strings and compare lexicographically — the same
  // assumption `byTs` above already relies on.
  //
  // Phase 2 (P-004/P-005, D-006) then narrowed this to what the agent is
  // actually SHOWN: the count is the INTERSECTION of the predicate above and a
  // DEFAULT `coord:inbox` read, so it can only ever go down, never up. The four
  // visibility rules are REUSED from coord:inbox's own modules — never a second
  // copy, since a counter that disagrees with the reader is this plan's bug.
  //
  // Applied in coord:inbox's own order (tools/inbox.ts): retraction → ambient →
  // intent-declare → coalesce. Deliberately NOT applied: the display `limit`
  // (a badge capped at the page size would be a new lie, and D-003 forbade
  // capping) and the opt-in `from`/`unanswered_only` narrowing (caller-supplied,
  // not "what a default read shows"). The `kind:'message'` narrowing STAYS:
  // reading "agree with coord:inbox" literally would ADD acks/handoffs and
  // raise the number, which is the opposite of this plan's purpose.
  // WI-6589: the BIRTH FLOOR governs BROADCASTS ONLY.
  //
  // D-012 folded the floor into the same `pickUnreadCursor` max as the three
  // read receipts, which made it govern EVERY candidate. Its own justification
  // never reached that far: "a `to:['*']` broadcast is a fan-out to the
  // population ALIVE AT SEND TIME, so an agent born afterwards was never in that
  // population". A message that NAMES this owner is the opposite case — a peer
  // addressed this exact agent id, so it was deliverable by construction and no
  // statement about the agent's birth can make it un-addressed.
  //
  // That distinction is load-bearing because the floor is not the true birth:
  // `adv_sessions` keeps ONE row per coord owner and four paths bump its
  // `started_at = now()` in place on resume/re-anchor, so MIN(started_at) is the
  // LATEST LAUNCH for every one of the 13,797 owners on record. Measured on the
  // live log (papercusp-workspace, 7d): 8,954 targeted non-self messages to 153
  // owners, of which 6,957 (78%) across 78 owners (51%) sit BELOW their
  // recipient's computed floor. Every one of those was a peer writing to a
  // specific agent.
  //
  // Applying the floor only to broadcasts keeps WI-6496 intact (a newborn still
  // does not inherit the fleet's broadcast backlog) while making it impossible
  // for a respawn to hide mail somebody actually addressed to this agent.
  // `first_seen_at` (migration 707) makes the broadcast half honest too.
  const unreadCandidates = messages.filter((m) => {
    if (m.kind !== 'message' || m.from === owner || acked.has(m.msg_id)) return false;
    const to = recipientsOf(m);
    const addressed = to.includes(owner);
    if (!addressed && !to.includes('*')) return false;
    if (readCursor && m.ts <= readCursor) return false;
    // Broadcasts only — an explicitly-addressed message is never floored.
    if (!addressed && bornAt && m.ts <= bornAt) return false;
    return true;
  });
  // Retraction markers are collected from the FULL raw window, not the unread
  // slice — the "disregard that" notice may sit either side of the cursor.
  const visible = suppressRetracted(unreadCandidates, collectRetractedIds(messages)).filter(
    (m) => !isAmbientBroadcast(m as unknown as Record<string, unknown>),
  );
  // Intent declares are the LARGER of the two Phase-2 legs and are NOT
  // broadcasts: they fan out addressed to each @plan/@fleet subscriber, so the
  // recipient predicate above counts every one (measured 2026-07-27: up to 68%
  // of one agent's counted messages over 12h).
  const { kept: withoutIntents } = excludeIntentDeclares(
    visible as unknown as Array<Record<string, unknown>>,
    {},
  );
  // A coalesced group is ONE row in the reader, so it counts once.
  const unreadRows = coalesceRepeatedBroadcasts(withoutIntents);
  const unreadCount = unreadRows.length;
  // Carry the ROWS, not just their length. `unreadCount` used to be the only
  // thing derived from this array, which left the dossier's coord section with
  // nothing to render but `lastMessage` — one line beside a badge promising N.
  // Newest first (the same lexicographic ISO compare `byTs` uses) and bounded,
  // because this rides the agent-detail payload on every poll; `unreadCount`
  // above stays the TRUE total, so the surface can say "showing N of M".
  const unread: CoordMessageSummary[] = (unreadRows as unknown as CoordEnvelope[])
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, UNREAD_LIST_LIMIT)
    .map((m) => ({
      msgId: m.msg_id,
      from: m.from,
      to: recipientsOf(m),
      kind: m.kind,
      summary: m.summary ?? m.body ?? '',
      ts: m.ts,
      direction: directionFor(m.from, owner),
    }));

  const openHandoffs: CoordHandoffSummary[] = handoffs
    .filter((h) => h.record.from === owner || recipientsOf(h.record).includes(owner))
    .map((h) => ({
      msgId: h.record.msg_id,
      from: h.record.from,
      to: h.record.to,
      summary: h.record.summary ?? '',
      ts: h.record.ts,
      planSlug: h.record.plan_slug ?? null,
      nextAction: h.record.next_action ?? null,
      direction: directionFor(h.record.from, owner),
      accepted: h.accepted_by != null,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const openEscalations: CoordEscalationSummary[] = escalations
    .filter((e) => e.from === owner)
    .map((e) => ({
      msgId: e.msg_id,
      severity: e.severity,
      summary: e.summary ?? '',
      ts: e.ts,
      planSlug: e.plan_slug ?? null,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  return { lastMessage, unreadCount, unread, openHandoffs, openEscalations, error: null };
}

// ──────────────────────────── thin async fetchers ──────────────────────────

const EMPTY_LOCKS: AgentLocks = { held: [], waiting: [], error: null };

/** Read one agent's held + waiting locks from the SU lock store. */
export async function getAgentLocks(owner: string): Promise<AgentLocks> {
  try {
    await ensureBootstrap();
    const sql = getTxPool();
    // Unfiltered read: we need other owners' active locks (to attribute
    // blockers) and the global ahead_count. The result is small (active edits).
    //
    // WI-5979: `coordinationDomain: null` = read across EVERY domain, deliberately
    // NOT `lockCoordinationDomain()`. That helper keys off the repo root of the
    // process that loaded it, so this dossier read matched only locks acquired
    // through an operator running from the SAME checkout. In practice the ports
    // disagree — :3070 serves from papercup-release while the Tauri desktop's
    // :3270 serves from the staging tree — so every lock (100% of live rows were
    // recorded under the release root) was invisible to the desktop dossier, and
    // invisible SILENTLY: an empty read is not an error, so "No locks held or
    // waiting." was indistinguishable from a wrong-namespace lookup.
    //
    // `owner` is a globally-unique ownerId, so the domain filter added no
    // correctness to a per-agent diagnostic — only this bug. Blocker attribution
    // stays within-domain in deriveAgentLocks.
    const queue = await readQueue(sql, { coordinationDomain: null });
    return deriveAgentLocks(queue, owner);
  } catch (e) {
    return { ...EMPTY_LOCKS, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The two bounds on this agent's unread set — kept SEPARATE (WI-6589).
 *
 * `receipts` answers "what has this agent already read" and applies to every
 * message. `bornAt` answers "what could ever have reached it" and applies to
 * BROADCASTS ONLY — see the filter in `deriveCoordState` for why, and for the
 * measured cost of conflating them. Either may be null (nothing on record).
 */
type UnreadCursors = { receipts: string | null; bornAt: string | null };

/**
 * This agent's unread bounds (ISO), each null if nothing on record sets it.
 *
 * FOUR signals. The first three are read RECEIPTS ("what has this agent already
 * read"), folded by the shared `pickUnreadCursor` rule (the LATER wins); the
 * fourth is a BIRTH FLOOR ("what could ever have reached it"), returned
 * separately because it governs only broadcasts.
 *
 * unread-count-truthfulness-2026-07-27 D-012 (owner-reported 2026-07-27: a
 * BRAND-NEW session showed 1031 unread). The three receipt legs are all empty
 * by construction for a newborn — it has no watermark row, and it has not yet
 * called coord:inbox/coord:orient — so `pickUnreadCursor` honestly returned
 * null and the count fell back to the WHOLE visible log. D-007 measured that
 * same no-cursor path but reasoned about it ONLY as a REAPED agent, where a
 * historical backlog is defensible; the newborn is the opposite end of the same
 * branch and is NOT defensible: every one of those messages predates the
 * agent's existence.
 *
 * Why this is a truthfulness fix and not the display cap D-003 forbids: a
 * `to:['*']` broadcast is a fan-out to the population ALIVE AT SEND TIME. An
 * agent born afterwards was never in that population, so the message was never
 * deliverable to it — "unread" would assert it was addressed to this agent and
 * ignored, which is false. The floor changes which messages are CANDIDATES, not
 * how a candidate count is rendered.
 *
 * It composes with the existing legs rather than replacing them, and cannot
 * raise a count above the no-floor baseline:
 *   - newborn, no receipts        → floor wins    → counts only post-birth broadcasts
 *   - live agent with receipts    → receipt wins  → unchanged (receipts are later)
 *   - reaped agent, row GC'd      → floor is null → unchanged, D-007 preserved
 *   - reaped agent, row surviving → floor wins    → counts its LIFETIME, not all time
 *
 * WI-6589 narrowed WHAT the floor governs (broadcasts, not addressed mail) —
 * not whether it applies. Every row above still holds for broadcasts.
 *
 * Deliberately folded HERE and not inside `pickUnreadCursor` itself: that
 * helper is shared with the continuation gate (loop/checkpoint.ts), and D-008 /
 * D-011 define it as a pure max over cursor legs. Pushing a birth floor into it
 * would silently change what makes a second consumer continue a turn.
 *
 * The receipt signals, unchanged:
 *   - `messages_since_ts` — the turn-END settle watermark. ATTACHED-ONLY, so a
 *     detached/headless session keeps its initial `''` forever; on its own it
 *     is a dead pointer for ~95% of rows.
 *   - `messages_shown_ts` — advanced deterministically by `coord:inbox` at
 *     injection. The authoritative "this agent was shown it" signal (D-002).
 *   - the newest `coord:inbox`/`coord:orient` row in `tool_invocations`, via
 *     the shared `lastInboxReadAtBatch` — the same list the coord-deafness
 *     derivation uses, so the two cannot drift on what counts as a read.
 *
 * Fail-soft to null: an unreadable receipt must not silently claim the agent
 * has read something it has not. Null is honest ("no receipt on record") and
 * simply restores the pre-cursor behaviour for that one agent.
 */
async function readUnreadCursor(owner: string): Promise<UnreadCursors> {
  try {
    const [wm, lastReadByOwner, bornAt] = await Promise.all([
      readWatermark(owner),
      lastInboxReadAtBatch([owner]),
      // Fail-soft on its own, so a birth-time lookup failure degrades to the
      // three-receipt behaviour rather than taking the whole cursor down.
      firstAdvSessionStartByCoordOwner(owner).catch(() => null),
    ]);
    const receipts = pickUnreadCursor(
      pickUnreadCursor(wm?.messages_since_ts, wm?.messages_shown_ts),
      lastReadByOwner.get(owner) ?? null,
    );
    return { receipts, bornAt };
  } catch {
    return { receipts: null, bornAt: null };
  }
}

/** Read one agent's coord state (last message, unread, open handoffs/escalations). */
export async function getAgentCoordState(owner: string): Promise<AgentCoordState> {
  try {
    // EI-19323734935411369: this used to be an unconditional
    // `coordLog.readLines('messages')` — the ENTIRE messages surface (~76k rows /
    // ~63MB of JSONB, growing) pulled and JSON-parsed on every dossier open/poll
    // (`getAgentDetail` calls this unconditionally). `readInvolvingOwner` pushes
    // the exact same "sent by OR addressed to OR broadcast" union this owner
    // needs down into SQL, bounded + newest-first — see its docstring in
    // messages.ts for the full rationale (mirrors readInbox/readOutbox's fix).
    const [messages, acked, handoffs, escalations, cursors] = await Promise.all([
      readInvolvingOwner(owner) as Promise<CoordEnvelope[]>,
      readAckedMsgIds(owner),
      listHandoffs({ status: 'open' }),
      listEscalations({ status: 'open' }),
      readUnreadCursor(owner),
    ]);
    return deriveCoordState(
      messages,
      acked,
      handoffs,
      escalations,
      owner,
      cursors.receipts,
      cursors.bornAt,
    );
  } catch (e) {
    return {
      lastMessage: null,
      unreadCount: 0,
      unread: [],
      openHandoffs: [],
      openEscalations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function getAgentCodexDiagnostics(owner: string): Promise<CodexHomeDiagnostics | null> {
  try {
    const session = await latestAdvSessionByCoordOwner(owner);
    if (session?.agent !== 'codex') return null;
    return await readCodexHomeDiagnostics(session.id);
  } catch (e) {
    return {
      ...(await readCodexHomeDiagnostics(`unknown-${owner}`)),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function getAgentNativeSession(owner: string): Promise<NativeSessionHandle | null> {
  try {
    const session = await latestAdvSessionByCoordOwner(owner);
    if (!session) return null;
    let handle: NativeSessionHandle | null;
    if (session.agent === 'codex') {
      const diagnostics = await readCodexHomeDiagnostics(session.id);
      handle = nativeSessionHandleForAdvSession(session, {
        findCodexRolloutId: () => diagnostics.latestRolloutId,
      });
    } else {
      // WI-38369: the row's own pid is the authoritative config-dir source for a LIVE
      // session — without it the handle falls back to the transcript scan, which is
      // right but slower and only works while a transcript exists.
      handle = nativeSessionHandleForAdvSession(session, { pidHint: session.pid });
    }
    // WI-5226 (EI-308 gap 2): an ENDED claude session's transcript is almost
    // always already deleted (archive-at-death hook, ~15s after turn end) by
    // the time a human opens this dossier — verify + best-effort rematerialize
    // before telling the UI "exact resume: supported" with a command that would
    // otherwise ENOENT. Only for ended sessions — a live one's dir is untouched.
    if (
      handle?.backend === 'claude' &&
      handle.exactResumeSupported &&
      session.endedAt &&
      handle.sessionId &&
      handle.configDir
    ) {
      handle = await ensureClaudeResumeDirMaterialized(handle);
    }
    return handle;
  } catch {
    return null;
  }
}

/**
 * I/O wrapper for {@link claudeHandleAfterRematerializeAttempt}: checks whether
 * `handle`'s session transcript is actually present on disk under `configDir`,
 * and if not, best-effort rematerializes it from the archive (the SAME primitive
 * `/adv/sessions/rematerialize` and the wake-executor already use). Never throws
 * — a failed check/rematerialize just downgrades the handle, it never breaks the
 * dossier. Lazy import: session-archive fails LOUD at import when zstd is
 * unavailable, matching the rematerialize route's own lazy-import rationale.
 */
async function ensureClaudeResumeDirMaterialized(
  handle: ClaudeNativeSessionHandle,
): Promise<ClaudeNativeSessionHandle> {
  const sessionId = handle.sessionId;
  const configDir = handle.configDir;
  if (!sessionId || !configDir) return handle;
  try {
    const { listClaudeSessionIds, rematerializeSession } = await import('./session-archive');
    const present = (await listClaudeSessionIds(configDir)).includes(sessionId);
    if (present) {
      return claudeHandleAfterRematerializeAttempt(handle, { presentOnDisk: true, rematerialized: false });
    }
    const result = await rematerializeSession({ sourceKind: 'claude', sessionId, targetRoot: configDir });
    return claudeHandleAfterRematerializeAttempt(handle, {
      presentOnDisk: false,
      rematerialized: result.ok,
      rematReason: result.ok ? undefined : result.reason,
    });
  } catch (e) {
    return claudeHandleAfterRematerializeAttempt(handle, {
      presentOnDisk: false,
      rematerialized: false,
      rematReason: e instanceof Error ? e.message : String(e),
    });
  }
}

const ALL_AGENT_SIGNAL_KEYS: AgentSignalKey[] = [
  'loop',
  'liveness',
  'currentClaim',
  'context',
  'unanswered',
  'lastToolCall',
  'lane',
  'announcedGates',
  'fleetControl',
  'pipeline',
];

// ─────────────── P-009 pure derivations (unit-tested without PG) ────────────

/**
 * PURE (leg c): is a held claim progressing, and how idle is its holder?
 *
 * Delegates the threshold judgement to `computeIntentStale` — the SAME oracle
 * coord:presence, fleet:assignments and the leader-brief all judge a stalled
 * lane with. Re-deriving it locally would let this surface quietly disagree
 * with every other one about the same agent, which is worse than not showing it.
 */
export function deriveClaimProgress(
  lastActiveAt: string | null | undefined,
  nowMs: number = Date.now(),
): { progress: ClaimProgress; idleSec: number | null } {
  if (!lastActiveAt) return { progress: 'unknown', idleSec: null };
  const t = Date.parse(lastActiveAt);
  if (Number.isNaN(t)) return { progress: 'unknown', idleSec: null };
  const idleSec = Math.max(0, Math.round((nowMs - t) / 1000));
  const stale = computeIntentStale(idleSec);
  if (stale == null) return { progress: 'unknown', idleSec };
  return { progress: stale ? 'stalled' : 'progressing', idleSec };
}

/**
 * PURE (leg a): shape a parsed plan into the lane section.
 *
 * `resolvedItems` must come from `resolveEffectiveStatus` — passing raw
 * `storedStatus` items would silently count blocked work as claimable, which is
 * the specific over-count the shared resolver exists to prevent.
 */
export function deriveLane(
  planSlug: string,
  now: { state?: string | null; next?: string | null } | null | undefined,
  resolvedItems: Array<{
    id: string;
    text: string;
    phase?: string | null;
    effectiveStatus?: string;
    unresolvedBlockers?: unknown[];
    needsHuman?: boolean;
  }>,
  /** Where `planSlug` came from — see AgentLane.source. Defaults to 'declared',
   *  which is what every caller before the launch-record fallback existed. */
  source: AgentLane['source'] = 'declared',
): AgentLane {
  const actionable = resolvedItems.filter(
    (it) =>
      it.effectiveStatus === 'todo' &&
      (it.unresolvedBlockers?.length ?? 0) === 0 &&
      !it.needsHuman,
  );
  const first = actionable[0] ?? null;
  return {
    planSlug,
    source,
    // A Now block is present-or-absent as a whole, but an EMPTY string in either
    // line is as good as absent to a reader — normalize both to null so the UI
    // never renders a labelled blank.
    nowState: now?.state?.trim() ? now.state.trim() : null,
    nowNext: now?.next?.trim() ? now.next.trim() : null,
    nextActionable: first
      ? { id: first.id, title: first.text, phase: first.phase ?? null }
      : null,
    claimableCount: actionable.length,
  };
}

/**
 * PURE (leg b): flag each visible gate as awaited or not, against the keys this
 * agent actually holds an active await on.
 *
 * EXACT key match, deliberately — see `AgentAnnouncedGate.awaited`. Awaited
 * gates sort last so the actionable half (what nobody is listening for) reads
 * first, which is the only ordering that makes the section scannable.
 */
export function deriveAnnouncedGates(
  visible: Array<{
    eventKey: string;
    note: string | null;
    scopeKind: string | null;
    scopeRef: string | null;
    subscriberId: string;
  }>,
  subscribedEventKeys: readonly string[],
): AgentAnnouncedGate[] {
  const awaitedKeys = new Set(subscribedEventKeys);
  return visible
    .map((a) => ({
      event: a.eventKey,
      note: a.note,
      scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
      announcedBy: a.subscriberId,
      awaited: awaitedKeys.has(a.eventKey),
    }))
    .sort((x, y) => Number(x.awaited) - Number(y.awaited));
}

const EMPTY_SIGNALS: AgentSignals = {
  loop: null,
  liveness: null,
  currentClaim: null,
  contextTokens: null,
  compactionLimit: null,
  lastCheckpoint: null,
  unansweredDirectedCount: 0,
  lastToolCallAt: null,
  lane: null,
  pipeline: null,
  announcedGates: [],
  fleetControl: null,
  // The outer-catch fallback below can't tell which individual read failed
  // (it fires on a synchronous bug in the shaping code, not a rejected
  // promise — every promise already carries its own per-key catch), so it
  // marks ALL of them unavailable rather than claiming a clean read.
  unavailableSignals: ALL_AGENT_SIGNAL_KEYS,
};

// ─────────── P-009 IO seams (thin; every shaping decision is pure above) ─────
// Dynamically imported so adv-agent-detail's STATIC module graph is unchanged —
// the plans tree and the events store are both large, and the dossier is on the
// operator's cold path. Same pattern orient.ts uses for its own fleet legs.

/** Leg (a): the agent's declared plan, shaped into the lane section. */
async function readAgentLane(
  planSlug: string | null,
  harnessSlug: string | null,
  workspaceId: string | null,
  source: AgentLane['source'] = 'declared',
): Promise<AgentLane | null> {
  if (!planSlug) return null;
  const [{ readPlanBySlug }, { resolveEffectiveStatus }] = await Promise.all([
    import('./agent-tools/plans/source'),
    import('@papercusp/plan-parser'),
  ]);
  const res = await readPlanBySlug(planSlug, {
    ...(harnessSlug ? { harnessSlug } : {}),
    ...(workspaceId && workspaceId !== '*' ? { workspaceId } : {}),
  });
  if (!res) return null;
  return deriveLane(planSlug, res.parsed.now, resolveEffectiveStatus(res.parsed).items, source);
}

/** Leg (b): gates visible in this agent's scopes, split awaited / not-awaited. */
async function readAnnouncedGatesFor(
  owner: string,
  reader: { fleetSlug: string | null; planSlug: string | null; harnessSlug: string | null },
): Promise<AgentAnnouncedGate[]> {
  const [{ listActiveAnnouncements, listActiveAwaits }, { announcementVisibleTo }] =
    await Promise.all([import('./events/await/store'), import('./events/await/announce-key')]);
  // The awaits read duplicates getAgentSubscriptions' (both run concurrently
  // under getAgentDetail, so it costs no latency) — deliberately, so
  // getAgentSignals stays correct when called standalone. A signal whose
  // correctness depends on its CALLER having fetched something else is the kind
  // of coupling that breaks silently the first time someone reuses it.
  const [anns, awaits] = await Promise.all([
    listActiveAnnouncements({ unfiredOnly: true, limit: 50 }),
    listActiveAwaits(owner),
  ]);
  const visible = anns.filter((a) => announcementVisibleTo(a, reader)).slice(0, GATE_FOLD_LIMIT);
  return deriveAnnouncedGates(visible, awaits.map((w) => w.eventKey));
}

/** Leg (d): the fleet's control state — null unless it is NOT plain 'active'. */
async function readFleetControlFor(
  workspaceId: string | null,
  fleetSlug: string | null,
): Promise<AgentFleetControl | null> {
  if (!fleetSlug || !workspaceId || workspaceId === '*') return null;
  const { getFleet } = await import('./agent-fleets-store');
  const fleet = await getFleet(workspaceId, fleetSlug);
  if (!fleet || fleet.controlState === 'active') return null;
  return {
    fleet: fleetSlug,
    state: fleet.controlState,
    reason: fleet.controlReason,
    by: fleet.controlBy,
    since: fleet.controlAt,
  };
}

/** Matches orient's own announced-gate fold: a discovery aid, not a full list. */
const GATE_FOLD_LIMIT = 8;

/** Read one agent's dossier health signals — the P-005 six (loop / claim /
 *  context / checkpoint / unanswered / last-tool-call) plus the P-009 three
 *  (lane / announced gates / fleet control). */
export async function getAgentSignals(owner: string): Promise<AgentSignals> {
  const unavailable: AgentSignalKey[] = [];
  // EI-18694403367371331: a signal's underlying read failing must be VISIBLE
  // (logged + surfaced in `unavailableSignals`), never silently collapsed
  // into the same shape as a legitimate "holds nothing" / "no loop" state —
  // a leader reading a falsely-empty CLAIM as "this agent is idle" is
  // precisely the wrong conclusion when deciding whether to reclaim work.
  const onFailure =
    (key: AgentSignalKey) =>
    <T>(fallback: T) =>
    (err: unknown): T => {
      unavailable.push(key);
      console.warn(`[adv-agent-detail] getAgentSignals(${owner}) ${key} signal threw:`, err);
      return fallback;
    };
  try {
    const workspaceId = activeWorkspaceId();
    const [loopStatus, held, presence, unanswered, lastToolCall, fleetByOwner] = await Promise.all([
      getLoopStatus(owner).catch(onFailure('loop')(null)),
      readHeldWorkItems(owner, workspaceId).catch(onFailure('currentClaim')([])),
      getPresence(owner).catch(onFailure('context')(null)),
      fetchUnansweredDirected([owner]).catch(onFailure('unanswered')(new Map())),
      lastToolCallAtByOwner([owner]).catch(onFailure('lastToolCall')(new Map())),
      // Feeds BOTH the fleet-control leg and the gate-visibility filter; keyed
      // 'fleetControl' because that is the leg a reader loses outright if it
      // fails (gates degrade to a narrower, still-correct visibility scope).
      fetchPresenceFleet([owner]).catch(onFailure('fleetControl')(new Map())),
    ]);
    // readHeldWorkItems is ordered DESC by feature_id (most-recently-created
    // first) — the front row is the agent's most current claim, matching what
    // "current claim" means at a glance.
    const top = held[0] ?? null;

    // ── P-009 second phase: three legs that need phase-one context to scope
    // their reads (the plan the agent declared, the fleet it belongs to, the
    // harness its claim lives in). Run concurrently with each other; each is
    // independently best-effort on the SAME contract as phase one — a throw is
    // reported through `unavailableSignals`, never rendered as a clean empty.
    const fleetSlug = fleetByOwner.get(owner)?.fleetSlug ?? null;
    // Same fallback chain the ROSTER uses for the identical agent one pane away
    // (adv-roster.ts: `p.currentPlanSlug ?? adv?.planSlug`). Reading only the
    // DECLARED plan made the dossier strictly narrower than the roster: an agent
    // launched via fleet:launch-on-plan that never re-declared had a plan the
    // roster showed and the popup did not — 3 of 11 live plan-launched sessions
    // when measured (plan session-popup-compaction-and-contrast-2026-08-02
    // D-006). Declared still WINS: it is the agent's own current statement of
    // what it is on, and it is what changes when an agent moves between plans
    // mid-session, whereas the launch record is fixed at spawn.
    const declaredPlanSlug = presence?.currentPlanSlug ?? null;
    const launchPlanSlug = declaredPlanSlug
      ? null
      : (await latestAdvSessionByCoordOwner(owner).catch(onFailure('lane')(null)))?.planSlug ?? null;
    const planSlug = declaredPlanSlug ?? launchPlanSlug;
    const harnessSlug = top?.harness ?? null;
    const [lane, announcedGates, fleetControl, pipeline, liveness] = await Promise.all([
      readAgentLane(planSlug, harnessSlug, workspaceId, declaredPlanSlug ? 'declared' : 'launch').catch(
        onFailure('lane')(null),
      ),
      readAnnouncedGatesFor(owner, { fleetSlug, planSlug, harnessSlug }).catch(
        onFailure('announcedGates')([] as AgentAnnouncedGate[]),
      ),
      readFleetControlFor(workspaceId, fleetSlug).catch(onFailure('fleetControl')(null)),
      // Scoped to the harness the agent's own claim lives in, so the popup reads
      // the pipeline that agent's work actually ships through — `undefined`
      // falls back to the default/home pipeline exactly as orient's own call
      // does. No `.catch` and no `unavailableSignals` key on purpose: the
      // producer NEVER throws (it resolves null on every failure path), so a
      // catch here would be unreachable code asserting a contract that already
      // holds one layer down. Cost is a shared 60s single-flight cache entry —
      // the same one the waking fleet is already paying for.
      fetchOrientPipeline(harnessSlug ?? undefined),
      // The dossier must project the SAME verdict every other supervisory
      // surface uses. Reuse the presence + claim reads already paid for above,
      // call the oracle exactly once, and keep its two axes together: lifecycle
      // (`sessionState`) and current turn activity (`liveTurn`). A missing map
      // entry is the oracle's degraded-read shape, so surface it as unavailable
      // rather than inventing a state from heartbeat freshness.
      resolveSessionStates([
        {
          ownerId: owner,
          heartbeatAt: presence?.heartbeatAt ?? null,
          stale: presence?.stale ?? null,
          host: presence?.host ?? null,
          pid: presence?.pid ?? null,
          source: presence?.source ?? null,
          agentRole: presence?.agentRole ?? null,
          claimsHeld: top != null,
        },
      ])
        .then((verdicts): AgentDossierLiveness => {
          const verdict = verdicts.get(owner);
          if (!verdict) throw new Error('shared liveness oracle returned no verdict');
          return { sessionState: verdict.sessionState, liveTurn: verdict.liveTurn };
        })
        .catch(onFailure('liveness')(null)),
    ]);
    const claimProgress = deriveClaimProgress(presence?.lastActiveAt ?? null);

    return {
      lane,
      pipeline,
      announcedGates,
      fleetControl,
      liveness,
      loop: loopStatus
        ? {
            active: loopStatus.active,
            intervalSec: loopStatus.intervalSec,
            nextFireAt: loopStatus.nextFireAt,
            parked: loopStatus.parked,
            stalled: loopStatus.stalled,
          }
        : null,
      currentClaim: top
        ? {
            id: top.id,
            title: top.title,
            harness: top.harness,
            progress: claimProgress.progress,
            idleSec: claimProgress.idleSec,
          }
        : null,
      contextTokens: presence?.contextTokens ?? null,
      compactionLimit: presence?.compactionLimit ?? null,
      lastCheckpoint:
        top?.checkpoint != null
          ? { text: top.checkpoint, updatedAtMs: top.checkpointUpdatedAtMs ?? null }
          : null,
      unansweredDirectedCount: unanswered.get(owner)?.count ?? 0,
      lastToolCallAt: lastToolCall.get(owner) ?? null,
      unavailableSignals: unavailable,
    };
  } catch (err) {
    console.warn(`[adv-agent-detail] getAgentSignals(${owner}) failed entirely:`, err);
    return EMPTY_SIGNALS;
  }
}

/** The full Tier-3 dossier for one agent: locks + coord + client diagnostics, fetched concurrently. */
/**
 * The events this agent is currently subscribed to — the un-fired, un-cancelled
 * `event_awaits` rows that `events:status` reports as "active awaits".
 *
 * [owner 2026-07-28, verbatim] "are the events an agent currently subscribed to
 * listed in their chat popup? If not add that". They were not: the dossier
 * carried locks, coord and signals, so a reader could see what an agent HELD
 * and what it had SAID, but not what it was WAITING FOR — which is the field
 * that explains an agent sitting apparently idle. An agent parked on an await
 * looks identical to a dead one until you can see the await.
 *
 * A read failure surfaces as `error`, never as an empty list (see the DTO).
 */
export async function getAgentSubscriptions(owner: string): Promise<AgentSubscriptions> {
  try {
    const { listActiveAwaits } = await import('./events/await/store');
    const rows = await listActiveAwaits(owner);
    return {
      items: rows.map((r) => ({
        eventKey: r.eventKey,
        policy: r.policy,
        note: r.note,
        once: r.once,
        wakes: r.wakeHandle !== null,
        urgent: r.urgency,
        createdAt: r.createdAt,
        expiresTs: r.expiresTs,
      })),
      count: rows.length,
    };
  } catch (err) {
    console.warn(`[adv-agent-detail] getAgentSubscriptions(${owner}) threw:`, err);
    return { items: [], count: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Dynamically pushed context (P-011/P-012) ────────────────────────────────
// Backed ENTIRELY by ledgers that already exist (D-004: no new write path):
//   - harness_shared.memory_recall_stats     — one row per recall, carrying the
//     per-leg provenance (`legs`, landed by P-002) and the admission funnel.
//   - harness_shared.memory_session_surfaced — which mem0 refs were surfaced.
//   - harness_shared.corpus_session_surfaced — which CORPUS handles were
//     surfaced (P-012's third source). A separate table, not a separate column,
//     because its key is `ref text` (`WI-6512`) where the sibling's is
//     `memory_id uuid` — see migration 712 / `memory/corpus-surfaced-ledger.ts`.
// All three key `session_id` on the coord ownerId, which is what the dossier is
// keyed by — so this needs no owner→session mapping (verified live 2026-08-09).

/** How far back the section looks. */
const PUSHED_CONTEXT_WINDOW_HOURS = 24;
/** Rows carried on the wire. `count` still reports the true window total. */
const PUSHED_CONTEXT_MAX_EVENTS = 12;

/** A `legs`/`admission` jsonb blob as it arrives — shape-checked, never cast. */
type JsonBlob = Record<string, unknown> | null | undefined;

function blob(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numAt(o: Record<string, unknown> | null, key: string): number {
  const v = o?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Did a named retrieval leg RUN? Tri-state on purpose.
 *
 * `null` (leg absent / not a boolean) means NOT RECORDED — a pre-P-002 row.
 * `false` means the leg was recorded and did NOT execute (the cosine-gated
 * short-circuit). Collapsing those two into one falsy value is exactly the
 * mistake this column exists to prevent: it would render "we never measured
 * retrieval health" identically to "retrieval was degraded".
 */
export function legRan(legs: JsonBlob, leg: 'cosine' | 'lexical'): boolean | null {
  const ran = blob(blob(legs)?.[leg])?.ran;
  return typeof ran === 'boolean' ? ran : null;
}

/** A number that was actually RECORDED, or `undefined`. Distinct from `numAt`,
 *  which floors an absent value to 0: `spent: 0` ("nothing was spent") and an
 *  absent `spent` ("we never measured it") are different claims, and the panel
 *  that renders them must not state the second as the first. Same tri-state
 *  discipline `legRan` exists for. */
function optNumAt(o: Record<string, unknown> | null, key: string): number | undefined {
  const v = o?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** One leg's post-run detail, or `undefined` when the blob recorded none. */
function legDetail(legs: JsonBlob, leg: 'cosine' | 'lexical'): PushedContextLegDetail | undefined {
  const b = blob(blob(legs)?.[leg]);
  if (!b) return undefined;
  const out: PushedContextLegDetail = {};
  const candidates = optNumAt(b, 'candidates');
  const qualifying = optNumAt(b, 'qualifying');
  const depth = optNumAt(b, 'depth');
  if (candidates !== undefined) out.candidates = candidates;
  if (qualifying !== undefined) out.qualifying = qualifying;
  if (depth !== undefined) out.depth = depth;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The funnel behind one injection row — or `undefined` when there is nothing to
 * add.
 *
 * THE EMISSION RULE, which is the whole design of this function: emit a block
 * only when it carries something the summary fields do NOT already say. Two
 * cases it must therefore refuse, both real:
 *
 *  - A LEGACY row (pre-P-002, no `admission`/`legs` blob) must yield NO block —
 *    not a block of zeros. A rendered "0 dropped by dedup, 0 by budget" is a
 *    measurement we never took, presented as a measurement of nothing, which is
 *    the same conflation `legRan`'s null-vs-false tri-state exists to prevent.
 *  - A row whose blobs hold ONLY `ran` flags adds nothing: `semanticRan` and
 *    `lexicalRan` already carry those, so a block here would be pure duplication
 *    on the wire and an empty hover panel in the UI.
 */
export function derivePushedDetail(r: PushedContextRow): PushedContextEventDetail | undefined {
  const admission = blob(r.admission);
  const detail: PushedContextEventDetail = {};

  // Only the stages that actually dropped rows, in the funnel's pipeline order
  // (ADMISSION_STAGES is that order). Zeros are omitted — see the DTO.
  const droppedBlob = blob(admission?.dropped);
  const dropped: PushedContextDroppedStage[] = [];
  for (const stage of ADMISSION_STAGES) {
    const count = optNumAt(droppedBlob, stage);
    if (count !== undefined && count > 0) {
      dropped.push({ stage, count, why: ADMISSION_STAGE_SHORT_WHY[stage] });
    }
  }
  if (dropped.length > 0) detail.dropped = dropped;

  const spent = optNumAt(admission, 'spent');
  if (spent !== undefined) detail.spent = spent;
  const budgetChars = optNumAt(admission, 'budgetChars');
  if (budgetChars !== undefined) detail.budgetChars = budgetChars;

  const byLeg = blob(admission?.byLeg);
  if (byLeg) {
    detail.byLeg = {
      both: numAt(byLeg, 'both'),
      cosineOnly: numAt(byLeg, 'cosineOnly'),
      lexicalOnly: numAt(byLeg, 'lexicalOnly'),
    };
  }

  const legs = blob(r.legs);
  const mode = legs?.mode;
  if (typeof mode === 'string' && mode !== '') detail.mode = mode;
  const fused = optNumAt(legs, 'fused');
  if (fused !== undefined) detail.fused = fused;

  const cosine = legDetail(r.legs, 'cosine');
  if (cosine) detail.cosine = cosine;
  const lexical = legDetail(r.legs, 'lexical');
  if (lexical) detail.lexical = lexical;

  return Object.keys(detail).length > 0 ? detail : undefined;
}

export interface PushedContextRow {
  created_at: Date | string;
  surface: string;
  legs: JsonBlob;
  admission: JsonBlob;
}

/** A per-port ref count as the ledgers hand it over, before shaping. */
export interface PushedContextRefRow {
  port: string | null;
  refs: number | string;
  kind: PushedContextRefKind;
  /** Raw LEDGER ROWS behind `refs`, which is a DISTINCT count. Kept apart
   *  because the two answer different questions and only this one is summable:
   *  a ref surfaced at two ports is one distinct ref in each group, so adding
   *  the distinct counts across ports double-counts it. */
  rows?: number | string;
}

/** One surfaced-ledger row as PG hands it over, before shaping. */
export interface PushedContextRefDetailRow {
  ref: string;
  port: string | null;
  epoch: number | string;
  surfaced_at: Date | string;
  kind: PushedContextRefKind;
}

/** Everything the pure shaper needs. An object rather than five positional
 *  arguments because three of them are lists and a swapped pair would type-check
 *  cleanly while silently reporting one ledger as the other. */
export interface DerivePushedContextInput {
  rows: PushedContextRow[];
  refRows: PushedContextRefRow[];
  /** Window total for `rows` — the recall-stats count, not the ref count. */
  total: number;
  refDetail?: PushedContextRefDetailRow[];
  unavailable?: string[];
}

/** A ledger row that recorded no port. Rendered, never coalesced to a real port
 *  label: `corpus_session_surfaced.port` is nullable, and "we did not record
 *  where this arrived" must not read as "it arrived at `injection`". */
const UNRECORDED_PORT = '(unrecorded)';

/** Rows carried on the wire. `refsTotal` still reports the true window total. */
const PUSHED_CONTEXT_MAX_REFS = 40;

/** Pure shaping — unit-tested without PG, per this module's contract. */
export function derivePushedContext({
  rows,
  refRows,
  total,
  refDetail = [],
  unavailable = [],
}: DerivePushedContextInput): AgentPushedContext {
  const events: PushedContextEvent[] = rows.map((r) => {
    const admission = blob(r.admission);
    const detail = derivePushedDetail(r);
    return {
      at: iso(r.created_at),
      surface: r.surface,
      returned: numAt(admission, 'returned'),
      admitted: numAt(admission, 'admitted'),
      truncated: admission?.truncated === true,
      semanticRan: legRan(r.legs, 'cosine'),
      lexicalRan: legRan(r.legs, 'lexical'),
      // Omitted rather than set to `undefined`: the sibling test asserts the
      // event shape with toEqual, and an explicit undefined key is a different
      // object there. It is also one less key on the wire per legacy row.
      ...(detail ? { detail } : {}),
    };
  });
  const refsByPort = refRows
    .map((r) => ({ port: r.port ?? UNRECORDED_PORT, refs: Number(r.refs) || 0, kind: r.kind }))
    .filter((r) => r.refs > 0)
    // The two ledgers arrive as separate result sets, each already sorted
    // within itself; merging needs a TOTAL order or the row sequence would
    // depend on which query resolved first. Ties break on kind then port so
    // the dossier is stable between reads.
    .sort((a, b) => b.refs - a.refs || a.kind.localeCompare(b.kind) || a.port.localeCompare(b.port));
  // Summed from the RAW row counts, never from `refsByPort` above: those are
  // DISTINCT-per-port, so a ref surfaced at two ports would be counted twice.
  // A ledger that predates the `rows` column contributes its distinct count as
  // the closest available floor rather than 0 — an undercount is survivable
  // here, a total lower than the rows we are showing is not (guarded below).
  const refsTotal = refRows.reduce(
    (n, r) => n + (Number(r.rows ?? r.refs) || 0),
    0,
  );
  const refs: PushedContextRef[] = refDetail
    .map((r) => ({
      ref: r.ref,
      kind: r.kind,
      port: r.port ?? UNRECORDED_PORT,
      at: iso(r.surfaced_at),
      epoch: Number(r.epoch) || 0,
    }))
    // Same total-order argument as refsByPort: two independently-sorted result
    // sets merged into one list. Newest first; ties break on kind then ref.
    .sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref))
    .slice(0, PUSHED_CONTEXT_MAX_REFS);
  return {
    events,
    // Never let the carried slice masquerade as the total.
    count: Math.max(total, events.length),
    refsByPort,
    refs,
    refsTotal: Math.max(refsTotal, refs.length),
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ref → title resolution (read-side only; see PushedContextRef's header).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Which canonical store a surfaced ref points AT. `unknown` is a real outcome,
 *  not a parse failure to swallow: a ref shape we do not recognise must render
 *  as its raw handle rather than be silently dropped from the list. */
export type PushedRefClass = 'memory' | 'work-item' | 'session' | 'unknown';

/** A work-item / issue handle: `WI-7005`, `EI-19310032174584195`, `F-12`.
 *  Deliberately `{1,4}`+`\d+` and NOT a fixed prefix list — the id families in
 *  this ledger already span WI/EI/F and a new one must degrade to `unknown`
 *  only if it is genuinely differently SHAPED, not merely newer. */
const WORK_ITEM_REF_RE = /^[A-Z]{1,4}-\d+$/i;

/** A session pointer: `claude:<uuid>` / `codex:<uuid>` / `omp:<uuid>` — the
 *  `<source_kind>:<session_id>` form `corpus-recall.ts` emits. */
const SESSION_REF_RE = /^([a-z][a-z0-9_-]{1,15}):([0-9a-f][0-9a-f-]{7,})$/i;

/** A bare mem0 uuid (the memory ledger's key). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PURE. `kind` leads because it is the ledger of origin and therefore
 * authoritative — a memory ledger row is a memory even if its uuid somehow
 * matched another shape. Only the corpus ledger's `ref` is free-form.
 */
export function classifyPushedRef(ref: string, kind: PushedContextRefKind): PushedRefClass {
  if (kind === 'memory') return UUID_RE.test(ref) ? 'memory' : 'unknown';
  if (WORK_ITEM_REF_RE.test(ref)) return 'work-item';
  if (SESSION_REF_RE.test(ref)) return 'session';
  return 'unknown';
}

/** Split a session ref into its source kind and session id, or null. */
export function parseSessionRef(ref: string): { source: string; sessionId: string } | null {
  const m = SESSION_REF_RE.exec(ref);
  return m ? { source: m[1].toLowerCase(), sessionId: m[2] } : null;
}

/** One resolved row. `title` is always a single line; `detail` may wrap. */
export interface PushedRefResolution {
  title: string;
  detail?: string;
}

/** Title: one line, short enough to sit in a rail row. */
const PUSHED_REF_TITLE_MAX_CHARS = 110;
/** Detail: enough to be worth selecting, bounded so 40 refs cannot bloat the
 *  sync payload (40 × 800 ≈ 32KB worst case). */
export const PUSHED_REF_DETAIL_MAX_CHARS = 800;

/** Collapse whitespace and cut to `max`, appending an ellipsis only when the cut
 *  actually removed something. PURE. */
export function oneLineClamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Build a `{title, detail}` from a raw body: first line as the title, the
 *  clamped body as the detail. PURE — shared by all three resolvers so the
 *  three stores cannot drift in how they present themselves. */
export function resolutionFromBody(body: string, prefix?: string): PushedRefResolution | null {
  const flat = body.trim();
  if (!flat) return null;
  const firstLine = flat.split('\n').find((l) => l.trim().length > 0) ?? flat;
  const title = oneLineClamp(prefix ? `${prefix} ${firstLine}` : firstLine, PUSHED_REF_TITLE_MAX_CHARS);
  const detail = flat.length > PUSHED_REF_DETAIL_MAX_CHARS
    ? `${flat.slice(0, PUSHED_REF_DETAIL_MAX_CHARS - 1).trimEnd()}…`
    : flat;
  return { title, detail };
}

/**
 * PURE. Stamp resolutions onto refs and set the tri-state.
 *
 * `attempted` is a separate argument from "the map is non-empty" on purpose: a
 * lookup that ran and legitimately matched NOTHING must mark every row
 * `'unresolved'` (a finding), while a lookup that never ran must leave
 * `titleState` undefined (not a finding). Those two collapse into the same
 * empty map, so the distinction cannot be recovered from the map alone — which
 * is exactly how "we could not ask" would come to render as "there is nothing
 * there".
 */
export function applyPushedRefTitles(
  refs: readonly PushedContextRef[],
  resolved: ReadonlyMap<string, PushedRefResolution>,
  attempted: { ran: boolean; failed?: boolean } = { ran: true },
): PushedContextRef[] {
  if (!attempted.ran) return refs.map((r) => ({ ...r }));
  return refs.map((r) => {
    if (attempted.failed) return { ...r, titleState: 'unavailable' as const };
    const hit = resolved.get(pushedRefKey(r));
    if (!hit) return { ...r, titleState: 'unresolved' as const };
    return {
      ...r,
      title: hit.title,
      ...(hit.detail ? { detail: hit.detail } : {}),
      titleState: 'ok' as const,
    };
  });
}

/** The postgres.js template tag `withWorkspace` hands its callback. Declared
 *  STRUCTURALLY rather than importing the driver's `Sql` type, so this module
 *  keeps its existing "no direct driver dependency" shape (`withWorkspace` is
 *  itself a dynamic import here) and the resolver stays unit-testable against a
 *  hand-rolled fake tag. */
export type PushedRefSqlTag = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** The resolution map's key. Kind-qualified because the two ledgers share a
 *  namespace only by accident — a corpus ref and a memory uuid are different
 *  rows even in the (impossible today, cheap to exclude) case they collide. */
export function pushedRefKey(r: Pick<PushedContextRef, 'ref' | 'kind'>): string {
  return `${r.kind}:${r.ref}`;
}

/**
 * IO half: resolve every ref in one batched round-trip per store.
 *
 * SCOPING — deliberately NOT filtered by workspace/harness, which is the
 * opposite of the usual rule for these tables, so here is the reason MEASURED
 * (2026-08-09) rather than assumed:
 *   - the ref set is already bounded by THIS session's own ledger rows, so
 *     there is no cross-tenant fan-in to guard against; the ids come from the
 *     agent's own history, not from a user-supplied filter.
 *   - `memory_canonical` legitimately holds these rows under TWO workspace ids
 *     (`default` and the active workspace — 2 distinct values across a 40-row
 *     sample), so a workspace predicate would drop real rows and report them as
 *     `'unresolved'`, i.e. manufacture a finding out of a scoping bug.
 *   - `session_turns.workspace_id` is ALWAYS the literal `default` — a corpus
 *     namespace, never a tenant — so scoping it is meaningless by construction.
 * `work_items` is keyed (harness_slug, feature_id), so that one CAN fan out
 * across harnesses; `DISTINCT ON` picks the most recently updated row rather
 * than letting the join multiply the list.
 */
export async function resolvePushedRefTitles(
  tx: PushedRefSqlTag,
  refs: readonly PushedContextRef[],
): Promise<Map<string, PushedRefResolution>> {
  const out = new Map<string, PushedRefResolution>();
  const workItemIds: string[] = [];
  const sessionIds: string[] = [];
  const memoryIds: string[] = [];
  const sessionRefBySessionId = new Map<string, string>();
  for (const r of refs) {
    switch (classifyPushedRef(r.ref, r.kind)) {
      case 'work-item':
        workItemIds.push(r.ref);
        break;
      case 'session': {
        const parsed = parseSessionRef(r.ref);
        if (parsed) {
          sessionIds.push(parsed.sessionId);
          sessionRefBySessionId.set(parsed.sessionId, r.ref);
        }
        break;
      }
      case 'memory':
        memoryIds.push(r.ref);
        break;
      default:
        break;
    }
  }

  const [wiRows, memRows, sessRows] = await Promise.all([
    workItemIds.length > 0
      /* Column names verified against the live relation, not inferred from the
         DTO: it is `status` (not `state`), `updated_ts` (bigint epoch-ms, not
         `updated_at`), and the badge wants `item_kind` — the bug/change/task
         DISCRIMINATOR — rather than the legacy `kind`, which is a feature
         sub-category (infra/security/…) and would print a confusing word for
         every issue-family row. All three read plausibly and all three were
         wrong; the fake-tag unit tests below cannot catch that class, which is
         why this is exercised against the real DB. */
      ? tx<{ feature_id: string; title: string | null; item_kind: string | null; status: string | null; summary: string | null }[]>`
          SELECT DISTINCT ON (feature_id)
                 feature_id, title, item_kind, status, summary
            FROM harness_shared.work_items
           WHERE feature_id = ANY(${workItemIds}::text[])
           ORDER BY feature_id, updated_ts DESC NULLS LAST
        `
      : Promise.resolve([] as never[]),
    memoryIds.length > 0
      ? tx<{ id: string; body: string | null; kind: string | null }[]>`
          SELECT id::text AS id,
                 payload->>'data' AS body,
                 payload->>'kind' AS kind
            FROM harness_shared.memory_canonical
           WHERE id = ANY(${memoryIds}::uuid[])
        `
      : Promise.resolve([] as never[]),
    sessionIds.length > 0
      /* The ORDER BY is the interesting part. "First user turn" alone is wrong
         for THREE QUARTERS of this corpus: measured 2026-08-09, 487 of 645
         sessions open with a machine `⟦turn-origin:…⟧` wake envelope, so the
         naive read titled them `⟦turn-origin:loop-fire nonce:…⟧` — a nonce, in
         the UI, as the human-readable label. Rank the same leading markers as
         `ownerVisiblePromptText` after genuine owner turns, so the selected row
         is owner-visible whenever one exists. The JS filter remains the final
         authority; this SQL ranking only avoids selecting a hidden row when a
         visible one exists later in the transcript. (`session_briefs.intent`
         would have been the better source and was measured first:
         `native_session_id` matched 0 of 40 real refs, so that join is dead —
         recorded here so nobody rebuilds it.) */
      ? tx<{ session_id: string; text: string | null }[]>`
          SELECT DISTINCT ON (session_id) session_id, text
            FROM harness_shared.session_turns
           WHERE session_id = ANY(${sessionIds}::text[])
             AND speaker = 'user'
           ORDER BY session_id,
             CASE
               WHEN text IS NULL OR btrim(text) = '' THEN 1
               -- ⚠ These two patterns are POSIX (Postgres) dialect, and they are
               -- LITERAL on purpose: interpolating them would bind them as
               -- parameters, which (a) hides the ordering rule from this query's
               -- unit test, whose fake tag captures only the SQL text, and
               -- (b) risks "could not determine data type of parameter" on an
               -- untyped text-tilde-parameter comparison (WI-37757, same codebase).
               -- They are NOT unpoliced: envelope-grammar-cross-language.test.ts
               -- reads them out of this file and asserts they equal
               -- envelopePatternSql(OWNER_CHAT_TURN_ORIGIN) / envelopePatternSql().
               WHEN text ~ '^[[:space:]]*⟦turn-origin:coord-inject:owner nonce:[a-f0-9]{8,64}⟧' THEN 0
               WHEN text ~ '^[[:space:]]*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧' THEN 1
               WHEN btrim(text) LIKE 'Stop hook feedback:%' THEN 1
               ELSE 0
             END,
             turn_idx ASC
        `
      : Promise.resolve([] as never[]),
  ]);

  for (const w of wiRows as unknown as { feature_id: string; title: string | null; item_kind: string | null; status: string | null; summary: string | null }[]) {
    if (!w.title) continue;
    const badge = [w.item_kind, w.status].filter(Boolean).join(' · ');
    out.set(`corpus:${w.feature_id}`, {
      title: oneLineClamp(w.title, PUSHED_REF_TITLE_MAX_CHARS),
      detail: oneLineClamp(
        `${w.feature_id}${badge ? ` [${badge}]` : ''} — ${w.title}${w.summary ? `\n\n${w.summary}` : ''}`,
        PUSHED_REF_DETAIL_MAX_CHARS,
      ),
    });
  }
  for (const m of memRows as unknown as { id: string; body: string | null; kind: string | null }[]) {
    if (!m.body) continue;
    const res = resolutionFromBody(m.body);
    if (res) out.set(`memory:${m.id}`, res);
  }
  for (const s of sessRows as unknown as { session_id: string; text: string | null }[]) {
    const ref = sessionRefBySessionId.get(s.session_id);
    if (!ref || !s.text) continue;
    // The session's first OWNER-VISIBLE user turn is the closest thing a
    // transcript has to a title. Not the matched turn: the ledger records the
    // ref, never which turn matched (D-085's per-ref attribution limit), so
    // claiming otherwise would be an invented precision. Keep this predicate
    // on the shared allow-list: stripping an envelope is not enough because it
    // returns the machine wake body, and hook walls have no envelope at all.
    const visibleText = ownerVisiblePromptText(s.text);
    if (!visibleText) {
      // All-machine sessions still have a meaningful dossier row, but exposing
      // their first wake would leak private supervision text. A neutral label
      // is honest about why there is no owner-authored title.
      out.set(`corpus:${ref}`, {
        title: 'machine-driven session',
        detail: 'No owner-authored user turn was found in this session.',
      });
      continue;
    }
    const res = resolutionFromBody(visibleText, '↳');
    if (res) out.set(`corpus:${ref}`, res);
  }
  return out;
}

/**
 * Read what context was PUSHED to this agent, and whether retrieval was healthy
 * when it happened.
 *
 * ⚠ `workspace_id` is admitted as NULL-or-match rather than a strict equality.
 * Measured 2026-08-09: 410 of 12,390 rows in the window carry a NULL
 * workspace_id, so `workspace_id = $ws` would silently drop 3.3% of real
 * injections — an empty/short list that reads exactly like "nothing was pushed".
 * `session_id` is the real scope key here (it is this one agent's ownerId);
 * the workspace predicate is defence-in-depth, and must not erase un-stamped rows.
 */
export async function getAgentPushedContext(owner: string): Promise<AgentPushedContext> {
  try {
    const ws = activeWorkspaceId();
    const { withWorkspace } = await import('@papercusp/db-org');
    const base = await withWorkspace(ws, async (tx) => {
      const [rows, totals, memRefs, memRefDetail] = await Promise.all([
        tx<PushedContextRow[]>`
          SELECT created_at, surface, legs, admission
            FROM harness_shared.memory_recall_stats
           WHERE session_id = ${owner}
             AND (workspace_id = ${ws} OR workspace_id IS NULL)
             AND created_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
           ORDER BY created_at DESC
           LIMIT ${PUSHED_CONTEXT_MAX_EVENTS}
        `,
        // `corpus_relation` rides along here rather than as its own round trip:
        // see the guard below for why it must be asked BEFORE the corpus read.
        tx<{ total: string; corpus_relation: string | null }[]>`
          SELECT count(*)::text AS total,
                 to_regclass('harness_shared.corpus_session_surfaced')::text AS corpus_relation
            FROM harness_shared.memory_recall_stats
           WHERE session_id = ${owner}
             AND (workspace_id = ${ws} OR workspace_id IS NULL)
             AND created_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
        `,
        // Neither surfaced ledger has a workspace_id column at all — session_id
        // carries the scope. Refs, never bodies.
        tx<{ port: string; refs: string; rows: string }[]>`
          SELECT port, count(DISTINCT memory_id)::text AS refs, count(*)::text AS rows
            FROM harness_shared.memory_session_surfaced
           WHERE session_id = ${owner}
             AND surfaced_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
           GROUP BY port
           ORDER BY count(DISTINCT memory_id) DESC
        `,
        // P-013's "what was pushed": the handles themselves, one row each.
        // Capped in SQL — merging two capped DESC lists and re-cutting to the
        // same cap yields the true newest N, so the cap costs no correctness.
        tx<{ ref: string; port: string; epoch: number; surfaced_at: Date }[]>`
          SELECT memory_id::text AS ref, port, epoch, surfaced_at
            FROM harness_shared.memory_session_surfaced
           WHERE session_id = ${owner}
             AND surfaced_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
           ORDER BY surfaced_at DESC
           LIMIT ${PUSHED_CONTEXT_MAX_REFS}
        `,
      ]);

      // The corpus ledger is the one source that may legitimately not exist:
      // `memory/corpus-surfaced-ledger.ts` latches a process-wide no-op for
      // exactly this case ("migration 712 not applied on this box yet").
      //
      // It CANNOT simply join the Promise.all above. `withWorkspace` runs its
      // callback inside a TRANSACTION, so a missing-relation error would abort
      // that transaction and take the three queries above down with it —
      // turning one absent ledger into a section-wide "we could not ask".
      // Asking `to_regclass` first is the cheap way to keep the failure local:
      // it returns NULL instead of raising, and rode along on the query above.
      const totalRow = (totals as unknown as { total: string; corpus_relation: string | null }[])[0];
      const unavailable: string[] = [];
      type PortCount = { port: string | null; refs: string; rows: string };
      type RefDetail = { ref: string; port: string | null; epoch: number; surfaced_at: Date };
      let corpusRefs: PortCount[] = [];
      let corpusRefDetail: RefDetail[] = [];
      if (totalRow?.corpus_relation) {
        [corpusRefs, corpusRefDetail] = await Promise.all([
          tx<PortCount[]>`
            SELECT port, count(DISTINCT ref)::text AS refs, count(*)::text AS rows
              FROM harness_shared.corpus_session_surfaced
             WHERE session_id = ${owner}
               AND surfaced_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
             GROUP BY port
             ORDER BY count(DISTINCT ref) DESC
          `,
          tx<RefDetail[]>`
            SELECT ref, port, epoch, surfaced_at
              FROM harness_shared.corpus_session_surfaced
             WHERE session_id = ${owner}
               AND surfaced_at > now() - make_interval(hours => ${PUSHED_CONTEXT_WINDOW_HOURS})
             ORDER BY surfaced_at DESC
             LIMIT ${PUSHED_CONTEXT_MAX_REFS}
          `,
        ]) as unknown as [PortCount[], RefDetail[]];
      } else {
        unavailable.push('corpus-surfaced-refs');
      }

      const shaped = derivePushedContext({
        rows: rows as unknown as PushedContextRow[],
        refRows: [
          ...(memRefs as unknown as PortCount[]).map((r) => ({
            ...r,
            kind: 'memory' as const,
          })),
          ...corpusRefs.map((r) => ({ ...r, kind: 'corpus' as const })),
        ],
        refDetail: [
          ...(memRefDetail as unknown as RefDetail[]).map((r) => ({
            ...r,
            kind: 'memory' as const,
          })),
          ...corpusRefDetail.map((r) => ({ ...r, kind: 'corpus' as const })),
        ],
        total: Number(totalRow?.total ?? 0) || 0,
        unavailable,
      });
      return shaped;
    });

    // Titles resolve in their OWN transaction, deliberately — the same reason
    // the corpus-ledger read above is fenced behind `to_regclass` rather than
    // joining the `Promise.all`: `withWorkspace` runs its callback inside a
    // TRANSACTION, so ANY error in here (a missing relation, a cast, a
    // statement timeout) would abort the surrounding one and take the whole
    // ledger read down with it — turning "we could not read three titles" into
    // a section-wide "we could not ask". A second round-trip is the cheap price
    // of keeping the failure local.
    //
    // Titles are also a SEPARATE failure DOMAIN: a dossier that lost its ref
    // list is broken; one that lost its titles is merely less readable, and it
    // degrades to `titleState: 'unavailable'` (rendered as the raw handle plus
    // a note), never to an empty list.
    if (base.refs.length === 0) return base;
    let resolved = new Map<string, PushedRefResolution>();
    let failed = false;
    try {
      resolved = await withWorkspace(ws, async (tx) =>
        resolvePushedRefTitles(tx as unknown as PushedRefSqlTag, base.refs),
      );
    } catch (titleErr) {
      failed = true;
      console.warn(`[adv-agent-detail] resolvePushedRefTitles(${owner}) threw:`, titleErr);
    }
    return { ...base, refs: applyPushedRefTitles(base.refs, resolved, { ran: true, failed }) };
  } catch (err) {
    console.warn(`[adv-agent-detail] getAgentPushedContext(${owner}) threw:`, err);
    return {
      events: [],
      count: 0,
      refsByPort: [],
      refs: [],
      refsTotal: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getAgentDetail(owner: string): Promise<AgentDetail> {
  const [locks, coord, nativeSession, codex, signals, subscriptions, pushedContext] =
    await Promise.all([
      getAgentLocks(owner),
      getAgentCoordState(owner),
      getAgentNativeSession(owner),
      getAgentCodexDiagnostics(owner),
      getAgentSignals(owner),
      getAgentSubscriptions(owner),
      getAgentPushedContext(owner),
    ]);
  return {
    ownerId: owner,
    locks,
    coord,
    nativeSession,
    codex,
    signals,
    subscriptions,
    pushedContext,
  };
}
