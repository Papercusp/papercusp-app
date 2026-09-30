'use client';

/**
 * useAgentDetail — the lazy Tier-3 `agentDetail.byOwner` dossier fetch
 * (locks held/waiting, coord last-message/unread/handoffs/escalations, native
 * session handle, codex runtime diagnostics), factored out of AgentDossier.tsx
 * (hud-first-nav-and-dossier-2026-07-26 P-004) so a SECOND reader — the chat
 * footer's compact "N locks / M unread" summary chip — can share the exact
 * same `useSyncQuery` cache entry ({queryName, args}-keyed, per
 * SessionChatModal.tsx's own established pattern for `advRoster.list`)
 * instead of re-fetching or duplicating the DTO shape. No new endpoint.
 */

import { useSyncQuery } from '@papercusp/sync';
import type { NativeSessionHandle } from './SessionsRosterView';

// ── Server DTO mirror (apps/operator/lib/adv-agent-detail.ts). Inlined, not
//    imported, so this client module never pulls the PG-backed server module.
export interface LockHeld {
  path: string;
  intent: string;
  acquiredAt: string;
  expiresAt: string;
}
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
  aheadCount: number;
  queuedAt: string;
  waitUntil: string;
  blockedBy: LockBlocker[];
}
export interface AgentLocks {
  held: LockHeld[];
  waiting: LockWaiting[];
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
  severity: 'blocker' | 'question' | 'advisory';
  summary: string;
  ts: string;
  planSlug: string | null;
}
export interface AgentCoordState {
  lastMessage: CoordMessageSummary | null;
  unreadCount: number;
  /** The messages `unreadCount` counts (newest first, bounded server-side).
   *  `unreadCount > unread.length` ⇒ the surface must say "showing N of M".
   *
   *  OPTIONAL ON PURPOSE — this models the WIRE, not the current server. It is a
   *  newer field than some operators serving it: the SPA rebuilds on the vite
   *  hot path while the sidecar only reloads on restart, so a bundle that knows
   *  about `unread` is routinely served payloads that predate it. Declaring it
   *  required is exactly what let `coord.unread.length` typecheck and then throw
   *  "undefined is not an object" at runtime, killing the whole hud tab. Treat
   *  every field added to a sync payload this way until the floor has shipped. */
  unread?: CoordMessageSummary[];
  openHandoffs: CoordHandoffSummary[];
  openEscalations: CoordEscalationSummary[];
  error: string | null;
}
export interface CodexHomeDiagnostics {
  codexHome: string;
  exists: boolean;
  agentsPath: string;
  agentsExists: boolean;
  configPath: string;
  configExists: boolean;
  hooksPath: string;
  hooksExists: boolean;
  promptsPath: string;
  promptsExists: boolean;
  authPath: string;
  authExists: boolean;
  diagnosticsPath: string;
  diagnosticsExists: boolean;
  diagnostics: {
    lockEnforcement?: string;
    codexPreToolUseStatus?: string;
    requiresExplicitPapercuspLocks?: boolean;
    inheritedPromptsCopied?: boolean;
  } | null;
  latestRolloutId: string | null;
  latestRolloutPath: string | null;
  resumeStrategy: 'codex-resume-last-in-code-home';
  resumeCommand: string;
  error: string | null;
}
// hud-first-nav-and-dossier-2026-07-26 P-005: the six health signals — see the
// server-side docstring on AgentSignals (adv-agent-detail.ts) for what each is
// sourced from.
export interface AgentDossierLoopStatus {
  active: boolean;
  intervalSec: number | null;
  nextFireAt: string | null;
  parked: boolean;
  stalled: boolean;
}
/** Mirrors the server-side `ClaimProgress` — `unknown` is a real third state
 *  (the holder has no recorded activity yet), never a pessimistic default. */
export type ClaimProgress = 'progressing' | 'stalled' | 'unknown';

export interface AgentDossierClaim {
  id: string;
  title: string | null;
  harness: string | null;
  /** Is the holder actually moving this claim? A claim id renders identically
   *  whether it was taken 30s or 2h ago — this is what disambiguates it. */
  progress: ClaimProgress;
  /** Seconds idle, for "stalled 40m". null ⇔ progress === 'unknown'. */
  idleSec: number | null;
}
export interface AgentDossierCheckpoint {
  text: string;
  updatedAtMs: number | null;
}
// EI-18694403367371331: keys whose underlying read THREW this call rather
// than returning genuinely empty data — see the server-side AgentSignals
// docstring (adv-agent-detail.ts) for the full rationale.
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

/** Mirrors the server-side `OrientPipeline` — the release-pipeline block THIS
 *  agent is handed at its own wake. Every field but `gate`/`deploy` is optional
 *  because the producer omits each one when it has nothing to say (no reds, gate
 *  currently green, all legs ok), so an absent field means "nothing to report",
 *  never zero. See pipeline-health.ts for the field meanings. */
export interface AgentPipeline {
  /** `stale-verdict` = the recorded red is superseded, so the colour is UNKNOWN
   *  — never render it as either green or red. */
  gate: 'green' | 'red' | 'stalled' | 'wedged' | 'stale-verdict' | 'conflict';
  /** Is what is live on :3070 caught up with the green pin and main? */
  deploy: 'current' | 'behind';
  consecutiveReds?: number;
  lastGreenAgoMs?: number;
  /** The test files behind a REAL red — the ones to go fix. Never set for a
   *  stale-verdict gate, whose names must NOT be dispatched against. */
  failingFiles?: string[];
  rootCause?: string;
  note?: string;
  checkedAtMs?: number;
}

/** Mirrors the server-side `AgentLane` — the plan this agent declared and where
 *  that plan says the work stands. See adv-agent-detail.ts for field meaning. */
export interface AgentLane {
  planSlug: string;
  /** Which leg answered: `declared` = the agent said so itself (presence);
   *  `launch` = nobody declared, this is the plan the session was SPAWNED on
   *  (fixed at spawn, so possibly stale — the UI labels it). See D-006. */
  source: 'declared' | 'launch';
  nowState: string | null;
  nowNext: string | null;
  nextActionable: { id: string; title: string; phase: string | null } | null;
  claimableCount: number;
}

/** Mirrors the server-side `AgentAnnouncedGate`. `awaited:false` = declared and
 *  visible to this agent, but it is NOT listening — rendered as the second half
 *  of "Waiting on", because neither half is diagnostic without the other. */
export interface AgentAnnouncedGate {
  event: string;
  note: string | null;
  scope: string;
  announcedBy: string;
  awaited: boolean;
}

/** Mirrors the server-side `AgentFleetControl`. Non-null ONLY when the fleet is
 *  not plain `active` — its presence is itself the news. */
export interface AgentFleetControl {
  fleet: string;
  state: string;
  reason: string | null;
  by: string | null;
  since: number | null;
}

/** Mirrors the shared liveness-oracle projection on the server. */
export interface AgentDossierLiveness {
  sessionState: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded';
  liveTurn: boolean;
}

export interface AgentSignals {
  loop: AgentDossierLoopStatus | null;
  liveness: AgentDossierLiveness | null;
  currentClaim: AgentDossierClaim | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  lastCheckpoint: AgentDossierCheckpoint | null;
  unansweredDirectedCount: number;
  lastToolCallAt: string | null;
  lane: AgentLane | null;
  /** The release pipeline this agent's work ships through. `null` is UNMEASURED
   *  (the producer is fail-soft and resolves null rather than throwing), so it
   *  renders as nothing — and it is deliberately absent from
   *  `unavailableSignals` for the same reason: nothing threw. */
  pipeline: AgentPipeline | null;
  announcedGates: AgentAnnouncedGate[];
  fleetControl: AgentFleetControl | null;
  unavailableSignals: AgentSignalKey[];
}

/** One event the agent is currently subscribed to. Mirrors the server-side
 *  `AgentSubscription` (adv-agent-detail.ts) — see that file for field meaning. */
export interface AgentSubscription {
  eventKey: string;
  policy: string;
  note: string | null;
  once: boolean;
  wakes: boolean;
  urgent: boolean;
  createdAt: string;
  expiresTs: string | null;
}

/** Mirrors the server-side `AgentSubscriptions`. `error` set ⇒ the read FAILED;
 *  that is not the same as an empty list, and the dossier renders them
 *  differently on purpose. */
export interface AgentSubscriptions {
  items: AgentSubscription[];
  count: number;
  error?: string;
}

/** One injection moment — mirror of adv-agent-detail.ts's PushedContextEvent. */
export interface PushedContextEvent {
  at: string;
  surface: string;
  returned: number;
  admitted: number;
  truncated: boolean;
  /** Tri-state: `null` = NOT RECORDED (pre-P-002 row), `false` = the leg was
   *  recorded and did not run. The dossier renders those differently on
   *  purpose — see the server DTO for why collapsing them is a bug. */
  semanticRan: boolean | null;
  lexicalRan: boolean | null;
  /** The funnel behind the counts, for the row's hover panel. Absent whenever
   *  the ledger row carried nothing beyond what the fields above already say —
   *  a legacy (pre-P-002) row has NO block rather than a block of zeros. */
  detail?: PushedContextEventDetail;
}

/** One admission stage that dropped rows on this recall. `why` is resolved
 *  server-side from the funnel's own vocabulary and shipped, because the client
 *  cannot import it (`recall-stats.ts` pulls in `@papercusp/flags/server`) and a
 *  hand-copied gloss is how a count and its explanation drift apart. */
export interface PushedContextDroppedStage {
  stage: string;
  /** Always > 0 — zero-drop stages are omitted, not rendered as zeros. */
  count: number;
  why: string;
}

/** What one retrieval leg did, beyond whether it ran. */
export interface PushedContextLegDetail {
  /** Rows the leg returned, pre-fusion. */
  candidates?: number;
  /** ...that cleared the leg's OWN bar and were ranked in the fusion. A leg can
   *  run, supply candidates, and qualify NONE — which is why a bare "ran ✓" tick
   *  is not evidence the leg contributed anything. */
  qualifying?: number;
  /** Per-scope row budget for this leg. PER-SCOPE, so `candidates` legitimately
   *  exceeds it on a multi-scope recall — never derive saturation from the pair. */
  depth?: number;
}

/** Mirror of adv-agent-detail.ts's PushedContextEventDetail. Every field is
 *  optional for the same SPA-vs-sidecar wire-skew reason as `refs` below. */
export interface PushedContextEventDetail {
  /** ONLY the stages that dropped something, in funnel order. */
  dropped?: PushedContextDroppedStage[];
  spent?: number;
  budgetChars?: number;
  byLeg?: { both: number; cosineOnly: number; lexicalOnly: number };
  mode?: string;
  fused?: number;
  cosine?: PushedContextLegDetail;
  lexical?: PushedContextLegDetail;
}

/** `memory` = mem0 memories, `corpus` = corpus handles (WI-6512). REQUIRED:
 *  the two ledgers record the SAME `port` labels on purpose, so a port alone
 *  never identifies a row — see the server DTO for the measurement. */
export type PushedContextRefKind = 'memory' | 'corpus';

export interface PushedContextPortRefs {
  port: string;
  refs: number;
  kind: PushedContextRefKind;
}

/** One surfaced ref — mirror of adv-agent-detail.ts's PushedContextRef. */
export interface PushedContextRef {
  /** The handle (a corpus pointer like `WI-6512`, or a mem0 memory id). */
  ref: string;
  /** Also the LEG OF ORIGIN — each ledger has exactly one writer. */
  kind: PushedContextRefKind;
  port: string;
  at: string;
  epoch: number;
  /** Human label resolved server-side at read time. Optional on the wire for
   *  the same reason `refs` is: the SPA rebuilds on the vite hot path while the
   *  sidecar rebuilds only on restart, so a fresh bundle can be handed a payload
   *  from before this field existed. Render the raw handle when it is absent. */
  title?: string;
  /** Fuller body behind `title`, for the hover panel. */
  detail?: string;
  /** TRI-STATE — see the server DTO. `undefined` = this payload predates
   *  resolution (or it was never attempted), `'unresolved'` = the row is GONE,
   *  `'unavailable'` = the lookup failed. The last two must not render alike:
   *  one is a finding about the pointer, the other is a gap in our own read. */
  titleState?: 'ok' | 'unresolved' | 'unavailable';
}

export interface AgentPushedContext {
  /** Newest first, capped — `count` carries the true window total. */
  events: PushedContextEvent[];
  count: number;
  refsByPort: PushedContextPortRefs[];
  /** The handles themselves, newest first, capped.
   *
   *  OPTIONAL here while REQUIRED on the server DTO, and the asymmetry is the
   *  wire contract rather than a dodge: the producer always populates it, but
   *  the SPA rebuilds on the vite hot path while the sidecar only rebuilds on
   *  restart, so a fresh bundle can genuinely be handed an older payload with
   *  no `refs` at all. Reading `.length` off such a field is what took down the
   *  whole HUD tab once (see `subscriptions`/`unread` below) — so read it
   *  through `?? []`, never bare. */
  refs?: PushedContextRef[];
  /** True window total behind the capped `refs` above. Optional for the same
   *  wire reason; read it as `?? 0`. */
  refsTotal?: number;
  /** Ledgers that could not be read while the others succeeded — render it,
   *  never drop it: an unreadable ledger is not a ledger that surfaced zero. */
  unavailable?: string[];
  error?: string;
}

export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  nativeSession: NativeSessionHandle | null;
  codex: CodexHomeDiagnostics | null;
  /** Optional — see the server-side AgentDetail doc (adv-agent-detail.ts) for why. */
  signals?: AgentSignals;
  /** Optional for the same reason as `signals`, and additionally because an
   *  operator predating this field serves a payload without it. */
  subscriptions?: AgentSubscriptions;
  /** Optional for the same reason as `subscriptions` — this is a NEW field and
   *  the sidecar only rebuilds on restart, so a fresh SPA bundle can genuinely
   *  be served a payload without it. Every read below goes through `?.`. */
  pushedContext?: AgentPushedContext;
}

/** Lazy-load the Tier-3 dossier for one owner id through sync. Any number of
 *  call sites can invoke this for the SAME ownerId — `useSyncQuery` shares
 *  its cache by `{queryName, args}`, so it is a second READER, not a second
 *  fetch. */
export function useAgentDetail(ownerId: string | null): {
  detail: AgentDetail | null;
  error: string | null;
  loading: boolean;
} {
  const query = useSyncQuery<AgentDetail>({
    queryName: 'agentDetail.byOwner',
    args: ownerId ? { ownerId } : undefined,
    enabled: !!ownerId,
  });
  return {
    detail: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
  };
}
