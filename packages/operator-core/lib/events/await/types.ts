/**
 * await-event primitive — shared types (await-event-primitive-2026-06-05).
 *
 * The layering (plan D-001): SOURCES resolve who an event concerns and call
 * `emitAwaitedEvent`; the DELIVERY layer here is dumb and uniform — deliver
 * event E to its addressed recipients, honoring each recipient's declared
 * policy (`wake` = re-invoke me, `notify` = put it in my coord inbox). No
 * cardinality lives in the primitive: a lock grants to ONE waiter by emitting
 * a targeted `lock:grant:<ticket>` key; CI-green broadcasts; both are plain
 * emits here.
 */

/** How a fired event reaches a subscriber (plan D-002). `announce` (EI-9270) is
 *  NOT a delivery policy: it marks an emitter-side DECLARATION row ("this gate
 *  key WILL fire — await it") that never wakes anyone itself; every delivery
 *  path excludes it, and the real emit stamps its `fired_at` as the LATCH. */
export type AwaitPolicy = 'wake' | 'notify' | 'announce';

/**
 * Reserved note prefix written only by `coord:await-inbox` to distinguish its
 * deliberate idle park from the automatically armed inbox-wake keepalive.
 * Keep this in the shared await types so every reader uses the same byte-level
 * marker without importing a lifecycle module back into the store.
 */
export const EXPLICIT_PARK_NOTE_MARKER = '[coord:await-inbox:explicit-park]';

export function isExplicitParkNote(note: string | null | undefined): boolean {
  return note?.startsWith(EXPLICIT_PARK_NOTE_MARKER) === true;
}

/** What happens when an await's deadline passes without the event (D-009):
 *  `wake` = synthesize a timeout wake (the agent learns the event did NOT
 *  happen — as actionable as the event itself for a blocked agent);
 *  `expire` = lapse silently (visible in events:status, no turn spent). */
export type TimeoutBehavior = 'expire' | 'wake';

/**
 * Why an automatically/suggested-armed watch exists. Manual awaits leave this
 * null: their lifecycle remains caller-owned. Bound watches are retired when
 * the state named here dies, and the same object is folded into their wake
 * payload so the recipient can attribute (and cancel) the machinery.
 */
export interface LifecycleBinding {
  kind: string;
  ref: string;
}

/**
 * The fallback timeout-wake window: the default deadline for a one-shot wake
 * await when the caller names none (await-timeout-fallback-defaults-2026-07-03).
 *
 * The fallback exists so an agent BLOCKED on an event that never fires is
 * auto-woken (a `timeout` wake, `fired_reason='timeout'`) to re-orient, instead
 * of hanging until a human notices. It was 4h — far below the owner's actual
 * check-in cadence, so blocked agents sat dead for hours. 30min matches "a human
 * would have looked by now". This is the ONE source of truth: events:await,
 * watch:create, and the events sugar verbs all import it (it replaced three
 * duplicated `DEFAULT_TIMEOUT_SEC = 4 * 60 * 60` copies).
 */
export const AWAIT_DEFAULT_TIMEOUT_SEC = 30 * 60; // 30min

/** Hard cap on a caller-supplied await deadline — shared by every await surface. */
export const AWAIT_MAX_TIMEOUT_SEC = 7 * 24 * 60 * 60; // 7d

/** The session wake-handle stamped onto an await at registration (D-003 —
 *  it cannot be fetched at fire time; the agent is asleep). */
export type WakeHandle =
  | {
      kind: 'adv-session';
      /** harness_shared.adv_sessions.id — re-read at fire time for fresh pid/ended. */
      advSessionId: number;
      /** Which agent CLI backs the session ('claude' | 'codex' | 'omp'). */
      agent: string | null;
      /** The agent's NATIVE session id (claude UUID) — required for an exact
       *  claude resume. NEVER fall back to `--continue` on the shared tree:
       *  most sessions share one cwd, so most-recent-in-cwd resumes the WRONG
       *  agent's conversation. */
      sessionId: string | null;
      ompThreadId: string | null;
      cwd: string | null;
      pid: number | null;
    }
  | {
      kind: 'plan-run';
      /** harness_shared.plan_runs.id — woken via the plans:resume path. */
      runId: number;
    };

export interface AwaitRow {
  id: number;
  /** Number of pending rows retired atomically by this registration. Present
   *  only when registerAwait was called with supersedePending. */
  supersededPendingCount?: number;
  workspaceId: string;
  subscriberId: string;
  eventKey: string;
  policy: AwaitPolicy;
  note: string | null;
  /** True when `coord:await-inbox` deliberately parked on this standing inbox-wake row. */
  explicitPark?: boolean;
  wakeHandle: WakeHandle | null;
  timeoutBehavior: TimeoutBehavior;
  expiresTs: string | null;
  createdAt: string;
  firedAt: string | null;
  firedReason: string | null;
  cancelledAt: string | null;
  /** Why an active await was cancelled, when the cancellation came from a
   *  user-facing control surface. Internal lifecycle cleanup leaves this null. */
  cancelReason: string | null;
  /** Cardinality (unify-watch-primitive D-001): true = one-shot (fires once,
   *  auto-consumes via fired_at — today's await); false = standing watch (a fire
   *  queues a delivery WITHOUT consuming the row — the pot-style recurring wake). */
  once: boolean;
  /** Per-subscriber wake floor for this watch's wakes, in seconds. null/0 = no floor
   *  (one-shot grants wake promptly); >0 throttles a recurring wake:true watch. */
  minSleepSec: number | null;
  /** A watch whose wakes ALWAYS bypass the floor (a human-message / escalation watch).
   *  OR'd with the emit-time urgent flag onto each delivery. */
  urgency: boolean;
  /** EI-8998: optional predicate evaluated against the emitted PAYLOAD (a
   *  @papercusp/rules DataCondition — the same MatchMap vocabulary as an ECA
   *  rule's `when`), in ADDITION to the key/pattern match. null = no payload
   *  predicate (today's behavior, unchanged fast path). */
  payloadFilter: unknown | null;
  /** Interest-machinery lifecycle owner. Null/undefined on manually armed rows. */
  boundTo?: LifecycleBinding | null;
  /** EI-9270 (announced gate events): DISCOVERY scope of a policy='announce' row —
   *  who sees the declaration in events:catalog / coord:orient ('fleet'|'plan'|
   *  'harness'|'global'). null on ordinary awaits. The rendezvous plane itself
   *  stays flat (WI-3575); this scopes visibility only. */
  scopeKind: string | null;
  /** The fleet/plan/harness slug for scopeKind; null for 'global' / ordinary rows. */
  scopeRef: string | null;
  /** P-018: monotonic generation of an announced event key. Null on ordinary
   *  waiter rows; generation N is superseded when N+1 is declared. */
  causalGeneration?: number | null;
  /** Stable identity for the logical gate represented by an announced route. */
  logicalGateKey?: string | null;
  /** Optional completion condition declared by the gate emitter. */
  expectedCondition?: unknown | null;
  /** A newer announcement generation replaced this row. */
  supersededAt?: string | null;
  /** Source/owner that fired this announced generation, when known. */
  firedBy?: string | null;
  /** Emit payload captured on the announcement latch for expectation checks. */
  firedPayload?: unknown | null;
  /** composable-event-awaits-2026-07-11 (migration 572): a composed-await LEAF carries the
   *  parent threshold NODE it propagates its claim to (event_await_nodes.id) instead of waking.
   *  null on an ordinary await AND on a tree's root-anchor row (which has root_id but no node_id).
   *  OPTIONAL (like eventSubscribers on EmitResult) so hand-built AwaitRow test literals that
   *  predate the composed columns stay valid — mapAwait always populates it (`?? null`), and the
   *  only consumer (`a.nodeId != null`) treats undefined identically to null. */
  nodeId?: number | null;
  /** The tree this row belongs to (root node id); null on an ordinary await. Set on BOTH the
   *  leaves and the root-anchor row, so a single root_id-scoped statement voids the whole tree. */
  rootId?: number | null;
  /** When this leaf claimed as a tree member (it propagated instead of waking); null until then. */
  memberFiredAt?: string | null;
  /** The emit payload captured at leaf fire → folded into the root wake's { fired: leaf→payload }. */
  memberPayload?: unknown | null;
  /** Verified-wait fallback metadata; null keeps legacy timeout semantics. */
  producerHealthCertificate?: import('./verified-wait').ProducerHealthCertificate | null;
  /** Last diagnosed timeout outcome, retained for status/leader evidence. */
  timeoutVerification?: import('./verified-wait').VerifiedWaitTimeoutResult | null;
  /** Internal lease preventing two sweepers from verifying the same due row. */
  verificationClaimedAt?: string | null;
}

export type DeliveryStatus = 'pending' | 'parked' | 'delivering' | 'delivered' | 'dropped' | 'dead';

/** The wake channel that (eventually) carried a delivery — also the meter's
 *  per-wake attribution dimension (D-007). `coalesced` = this delivery folded into
 *  another wake for the same subscriber (no turn spent — unify-watch-primitive P-005). */
export type WakeChannel =
  | 'pty-inject'
  | 'psu-socket-inject'
  // su-cold-auto-mode-2026-07-03 Phase 2: a COLD loop wake injects a fresh-context
  // RESET-CONTEXT (`/clear` in place, keep the MCP warm) or a periodic RECYCLE
  // (kill+respawn the psu host) carrying the carry-note, instead of a warm
  // `mode:'turn'` inject. Both re-invoke the agent (it re-derives from the note), so
  // both join WAKE_TURN_CHANNELS below. Dormant until a caller wires coldAutoEnabled.
  | 'psu-socket-reset'
  | 'psu-socket-recycle'
  // WI-6862: the SAME delivery as the two above, except the host never ACKed it — the write
  // only got the optimistic bare-close fallback, which also covers a host that crashed or was
  // killed mid-delivery (what a provider usage-limit wall does to a respawn). Booked distinctly
  // so `loop:status.lastWakeChannel` / event_wake_deliveries stop reporting an unconfirmed
  // re-exec as a clean success. They still BURN A TURN for floor purposes (below): the write
  // was accepted, so we must assume the agent may have been re-invoked.
  | 'psu-socket-reset-unconfirmed'
  | 'psu-socket-recycle-unconfirmed'
  | 'resume'
  | 'resume-headless'
  // An exited cold-loop owner starts a fresh context under its existing coord id.
  | 'cold-fresh-successor'
  // P-013 part A (review-system-rework-reduction-2026-09-23): every Claude account was
  // walled, so the dead session was continued on Codex via a session port instead of
  // resumed into the wall. Burns a turn like a resume.
  | 'resume-rehome-backend'
  // The Hive Queen is never resumed — her ended-session wake fires a FRESH hive
  // launch (queen-brief-cache-assembly B-01 / P-012). Burns a turn like a resume.
  | 'hive-fresh-wake'
  // A drained bee warm-injected a NEW work-item is re-routed to a FRESH spawn instead
  // of `--resume`-ing its grown transcript (bee-context-efficiency P-005 / D-018/D-021).
  // Like hive-fresh-wake, it burns a turn (a fresh bee runs the task).
  | 'fresh-context-warm-inject'
  | 'plan-run-resume'
  | 'inbox'
  | 'coalesced'
  // EI-18673058981655804 (redundant-inbox-wake-suppression): an always-armed
  // inbox-wake (`coord:inbox-wake:<owner>`) whose triggering message(s) all
  // predate the subscriber's own last coord:inbox/coord:orient read — the mail
  // was already surfaced by the subscriber's own polling, so firing a turn for
  // it would provably discover nothing new. Settled without ever calling
  // executeWake (no liveness ladder, no spawn). Does NOT burn a turn, same as
  // 'inbox'/'coalesced'.
  | 'suppressed-redundant';

/** The wake channels that actually burn a turn (re-invoke the agent) — used to derive a
 *  subscriber's `last_woken_at` for the floor. 'inbox'/'coalesced'/'suppressed-redundant'
 *  do NOT burn a turn. */
export const WAKE_TURN_CHANNELS: readonly WakeChannel[] = [
  'pty-inject',
  'psu-socket-inject',
  'psu-socket-reset',
  'psu-socket-recycle',
  // WI-6862: an UNCONFIRMED reset/recycle must still count as a burned turn. The write was
  // accepted, so the agent may well have been re-invoked; treating it as no-turn would let the
  // floor re-wake the subscriber immediately and hammer a host that is very likely wedged.
  'psu-socket-reset-unconfirmed',
  'psu-socket-recycle-unconfirmed',
  'resume',
  'resume-headless',
  'cold-fresh-successor',
  'resume-rehome-backend',
  'hive-fresh-wake',
  'fresh-context-warm-inject',
  'plan-run-resume',
];

/** Whether a settled channel attempted to re-invoke the subscriber's agent.
 *
 * `psu-socket-*-unconfirmed` remains true here: the host accepted the write, so
 * the channel burns wake budget even though the turn-start acknowledgement was
 * not observed. Inbox, coalesced, and redundant-suppression channels are
 * explicitly false because they settle without invoking a turn.
 */
export function wakeChannelInvokesTurn(channel: WakeChannel | null | undefined): boolean {
  return channel != null && WAKE_TURN_CHANNELS.includes(channel);
}

export interface DeliveryRow {
  id: number;
  workspaceId: string;
  awaitId: number;
  subscriberId: string;
  eventKey: string;
  payload: unknown;
  summary: string | null;
  status: DeliveryStatus;
  channel: WakeChannel | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
  /** Bypass the per-subscriber wake floor for this delivery (unify-watch-primitive P-005). */
  urgent: boolean;
  /** The floor (seconds) denormalized from the await, so the pump decides without a join.
   *  null/0 = no floor. */
  minSleepSec: number | null;
  /** How many fires folded into this wake (1 = not coalesced). */
  coalescedCount: number;
  /** Emit-time attribution (migration 387) — e.g. a loop fire's `loop:<routineId>`. Persisted
   *  so the async resume-turn-exit handler can attribute a turn DEATH to its source (the
   *  loop-wake-rate-limit-robustness fix). null = unattributed. */
  source: string | null;
}

/** EI-13705: the unconditional per-key "did this ever genuinely fire" latch
 *  (harness_shared.event_key_fires) — upserted on every real emit regardless
 *  of announce/waiters, so `events:status` can tell a key that fired but was
 *  never announced (`fired_undeclared`) apart from one that truly never has
 *  (`undeclared`), independent of how much time has passed since. */
export interface KeyFireRow {
  workspaceId: string;
  eventKey: string;
  firstFiredAt: string;
  lastFiredAt: string;
  lastFiredBy: string | null;
  lastPayload: unknown;
  fireCount: number;
}

/** A delivery row joined with its await's wake handle + note (the pump's unit). */
export interface DeliveryWork extends DeliveryRow {
  wakeHandle: WakeHandle | null;
  note: string | null;
  /** Ambient-push delivery rail (ambient-semantic-push P-003): a pre-rendered,
   *  already-injection-door-capped teaser block that rides THIS wake's injection.
   *  Populated ONLY when PAPERCUSP_AMBIENT_CURSOR is on (fail-soft, best-effort);
   *  undefined on the default path ⇒ the wake body is byte-identical. Appended by
   *  wakeTurnText after its own line-collapse, so it flows through applyInjectionDoor
   *  (the injection-door tally) with the rest of the wake text. */
  ambientPushBlock?: string;
  /**
   * P-022 / D-007 — the subscribed cell's reading, resolved at TURN-ASSEMBLY time and
   * stamped, for a `predicate:<id>` wake. Prepared in the async delivery path (never in
   * the synchronous `wakeTurnText`) and absent whenever the delivery is not a
   * cell-backed predicate fire or the reading could not be taken in budget.
   */
  cellWakeFoldBlock?: string;
}

/** The wake executor's verdict for one delivery attempt. */
export type WakeOutcome =
  | { kind: 'delivered'; channel: WakeChannel }
  /** Recipient alive but uninjectable (detached terminal) — re-check later;
   *  converts to a resume when the process exits. */
  | {
      kind: 'park';
      reason: string;
      /** The psu host accepted this delivery id and still owns its detached gate pipeline. */
      hostCommitPending?: true;
    }
  /** Dead waiter (D-004 net #2) — no liveness, nothing resumable. Visible. */
  | { kind: 'drop'; reason: string }
  | { kind: 'error'; error: string };
