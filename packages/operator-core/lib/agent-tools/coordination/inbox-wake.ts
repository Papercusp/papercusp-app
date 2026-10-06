/**
 * inbox-wake.ts — the deliver-and-wake key convention + the single-target
 * wake fan (local-hive-orchestration-2026-06-06 Phase 4: P-040/P-041/P-042,
 * D-005).
 *
 * `coord:send` is inbox-inject by default (unify-watch D-002 — inject is cheap,
 * wake is the deliberate opt-in). When a sender passes `{ wake:true }` the
 * message still lands in the inbox AND we fire each addressed recipient's OWN
 * inbox-wake key through the shipped await-event pump (the floor + coalesce +
 * liveness-ladder built in unify-watch). We do NOT build a second wake pump —
 * this just composes `emitAwaitedEvent`.
 *
 * The wake-key convention is the per-recipient pair to the standing watch an
 * idle bee registers (P-041): a bee that ends a turn idle registers
 * `watch:create { pattern: inboxWakeKey(self), wake:true, once:false }` and
 * sleeps; a later `coord:send {wake:true, to:[bee]}` re-invokes exactly it.
 *
 * SINGLE-TARGET, NEVER A BROADCAST (P-042 / unify-watch P-008/D-005, the
 * lock-grant-bridge pattern): each wake is one `emitAwaitedEvent` on
 * `coord:inbox-wake:<ownerId>` — a key only THAT owner ever watches. We fan one
 * emit per addressed ownerId; we never emit on a wildcard/shared key, so the
 * pump only resumes the addressee(s), never the whole fleet (a wildcard would
 * thunder-herd N sleeping agents into N billable turns).
 */

import { getOrgPg, withDbCallDeadline } from '@papercusp/db-org';
import { emitAwaitedEvent } from '../../events/await/engine';
import { listActiveAwaitsForKey } from '../../events/await/store';
// hive-agent-tabs P-007/D-005: the per-agent wake-mode gate (consumed below).
import { resolveWakeMode } from './wake-mode';
import { stagePendingWake } from './pending-wakes';
import { ADMIN_COORD_UI_OWNER } from './identity';
import { listPresence } from './presence';
import { resolveBestEffortAgainstRoster, isSelectorOrWildcard, knownOwnerIdSet } from './recipient-resolve';
import { getLoopStatuses, type LoopStatus } from '../../harness/routines/loop';
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  isOwnerVerifiedRelay,
  RELAY_PROVENANCE_FIELD,
  type RelayProvenanceStamp,
} from './relay-provenance';

/** Prefix for the per-agent inbox-wake key. A bee watches `inboxWakeKey(self)`;
 *  a `{wake:true}` send to that bee fires exactly this key. */
export const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

/** The wake key for one recipient ownerId. The standing-watch pattern and the
 *  send-side fire MUST agree on this string — it is the rendezvous. */
export function inboxWakeKey(ownerId: string): string {
  return `${COORD_INBOX_WAKE_PREFIX}${ownerId}`;
}

/** Recover the ownerId from an inbox-wake key (null if it isn't one). */
export function ownerFromInboxWakeKey(key: string): string | null {
  return key.startsWith(COORD_INBOX_WAKE_PREFIX) ? key.slice(COORD_INBOX_WAKE_PREFIX.length) : null;
}

/** Addressees we never wake even when `wake:true`: the broadcast wildcard and
 *  the human inbox (the human is not a wake-resumable agent; '*' would be the
 *  exact thunder-herd P-042 forbids). Plain ownerIds pass through. The
 *  idle-recipient probe (coord-dispatch-reliability P-001) reuses this same set
 *  so the no-wake report and the wake fan skip exactly the same addressees. */
export const NON_WAKEABLE = new Set(['*', 'human', '']);

/** P-022 (cross-machine-coord-parity, fan-out governance): the MAX concrete
 *  agents ONE send's wake fan will re-invoke. Beyond it, the overflow is
 *  INJECTED (durable, seen next turn) but NOT woken — a `@fleet:`/`@topic:` that
 *  expands to thousands (256×10 = 2560 agents) must not turn one message into
 *  thousands of billable turns. A legitimate directed set is far under this;
 *  env-tunable. */
export const MAX_WAKE_FANOUT = Number(process.env.PAPERCUSP_MAX_WAKE_FANOUT) || 64;

/**
 * A direct wake is best-effort after the inbox row is durable, but its caller still needs a
 * result before the MCP transport gives up. Keep the target fan's whole per-recipient chain
 * below the observed ~30s coord:send transport budget. The cap prevents an accidental env
 * override from reintroducing a transport-sized wait; a timeout means delivery is UNKNOWN,
 * not that the recipient was absent, because the underlying emit may complete after we return.
 */
const configuredWakeTargetTimeoutMs = Number(process.env.PAPERCUSP_COORD_WAKE_TIMEOUT_MS);
export const COORD_WAKE_TARGET_TIMEOUT_MS =
  Number.isFinite(configuredWakeTargetTimeoutMs) && configuredWakeTargetTimeoutMs > 0
    ? Math.min(25_000, Math.max(500, Math.trunc(configuredWakeTargetTimeoutMs)))
    : 15_000;

/** A LOOP wake's source convention (loop-fire.ts: `loop:<routineId>`). */
export const LOOP_WAKE_SOURCE_PREFIX = 'loop:';

/** The delivery-ladder rescue wake must not be muted by the manual gate it detects. */
export const DELIVERY_LADDER_WAKE_SOURCE = 'system:delivery-ladder';

/** The escalation-SLA reroute is a system-owned detector that must reach its
 * selected live driver even while the global wake mode is manual. Staging this
 * wake defeats the SLA: there is no separate owner review step for a
 * time-sensitive system handoff. */
export const ESCALATION_SLA_REROUTE_WAKE_SOURCE = 'system:escalation-sla-reroute';

/** Prefix for a wake explicitly released by the owner from coord:wake-queue. */
export const MANUAL_WAKE_QUEUE_RELEASE_SOURCE_PREFIX = 'coord:wake-queue-release:';

/**
 * Is this wake a LOOP's self-wake? A loop wake is the agent driving ITSELF (loop:arm), so it
 * must BYPASS the manual pause/edit gate below: there is no separate owner to release a staged
 * wake — the asleep agent waiting on `coord:inbox-wake:<self>` is the ONLY one who could release
 * it, so STAGING a self-wake DEADLOCKS the loop (fire → stage → nobody releases → never executes).
 * Observed live 2026-06-23: a self-loop fired ~10× into a manual-mode session (global default was
 * `manual` via pot:pause) and every wake staged → the loop did zero work. The manual gate exists
 * for an OWNER reviewing a SUBORDINATE's wakes; a self-loop has neither, so its wake always fires.
 * (loop:arm is su/interactive-only — never a fleet agent — so this never un-pauses a fleet bee.)
 */
export function isLoopWakeSource(source: string | undefined): boolean {
  return (source ?? '').startsWith(LOOP_WAKE_SOURCE_PREFIX);
}

/** Exact-match detector rescue source; broad system-source matching would bypass the pause. */
export function isDeliveryLadderWakeSource(source: string | undefined): boolean {
  return source === DELIVERY_LADDER_WAKE_SOURCE;
}

/** Exact-match detector for the escalation-SLA reroute's mandatory wake. */
export function isEscalationSlaRerouteWakeSource(source: string | undefined): boolean {
  return source === ESCALATION_SLA_REROUTE_WAKE_SOURCE;
}

/**
 * Is this wake the HUMAN OWNER's, sent from the operator GUI? Same deadlock shape as the
 * self-loop bypass above, one actor over: the manual gate stages a wake **for the owner to
 * review**, so a wake the OWNER THEMSELF just sent has no separate reviewer — it stages into
 * a queue only the sender can release, i.e. the owner must go find their own message in
 * `coord:wake-queue` and release it to itself. Nothing in the GUI says so; the composer's
 * placeholder literally reads "Type to wake <ownerId>…", so the send returns `ok:true`,
 * `staged:1`, and the conversation stays EMPTY forever.
 *
 * Measured (WI-37858, owner-reported "chat window opens but stays empty"): this workspace has
 * `wake_mode:default = manual` set 2026-08-09; SessionChatModal's composer POSTs
 * /api/admin/coord/send → coord:send { wake:'required' }, whose identity resolves to
 * `ADMIN_COORD_UI_OWNER` (the admin routes pin `?client=`), and every message the owner typed
 * staged instead of delivering — `pending_wakes` row 51591, `source='pc-admin-coord-ui'`.
 *
 * Scope is deliberately ONE constant, not "any non-agent sender": `ADMIN_COORD_UI_OWNER` is
 * the single id every GUI write route pins (mode/set.ts already keys owner-authority off the
 * same comparison), and a wake fan only runs when a caller explicitly ASKED to wake — so this
 * fires only on a human deliberately clicking Send at a named agent. It does NOT un-pause the
 * hive: agent→agent wakes stage exactly as before, which is what the pause primitive is for.
 */
export function isOwnerGuiWakeSource(source: string | undefined): boolean {
  return source === ADMIN_COORD_UI_OWNER;
}

/** Carry server-verified authority through the async delivery row. */
function payloadWithRelayProvenance(
  payload: unknown,
  stamp: RelayProvenanceStamp | null | undefined,
): unknown {
  if (!stamp) return payload;
  const record =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : payload === undefined || payload === null
        ? {}
        : { value: payload };
  return { ...record, [RELAY_PROVENANCE_FIELD]: stamp };
}

export interface WakeRecipientsResult {
  /** Concrete recipient ownerIds we fired a wake key for (post-filter). */
  targets: string[];
  /** The keys fired (one per target) — for assertions / debugging. */
  keys: string[];
  /** Total durable wake deliveries matched/queued by the event engine (sum over targets;
   *  0 if none was listening). The detached wake pump has not run to completion yet. */
  queued?: number;
  /** Legacy queue-count alias retained for callers that predate `queued`. Despite its
   *  name, this is NOT execution-confirmed turn count; it mirrors EmitResult.woken. */
  woken: number;
  /** ALWAYS `false`, and typed `false` on purpose — a wake fan CANNOT answer this.
   *
   *  `wakeRecipients` returns once the wake is ENQUEUED on the await-event pump; the
   *  target has not been scheduled a turn yet, let alone taken one. So a truthful
   *  pickup confirmation is unavailable AT THIS SEAM BY CONSTRUCTION, not merely
   *  unimplemented — no future change to this function can make it `true` without
   *  first inventing an execution handshake that reports back LATER.
   *
   *  The literal type is the guard (EI-22733985246154315). It was previously
   *  `boolean`, which let `checkpoint-run` gate a gate-ownership stand-down on
   *  `wake.pickupConfirmed === true` — a branch production could never enter, kept
   *  green by a unit test that mocked the value `true`. Narrowing to `false` makes
   *  any such comparison a compile error instead of silently-dead code.
   *
   *  To establish that a target actually picked up, observe it AFTERWARDS: a fresh
   *  `lastActiveAt` / work-item checkpoint / `lastProgressAt` that post-dates the wake. */
  pickupConfirmed?: false;
  /** Recipients whose wake was STAGED (wake-mode `manual` — the hive Pause
   *  primitive) instead of fired — always 0 when everything resolves `auto`
   *  (the default). Graduated off the POT_AGENT_TABS flag (start-hive P-007). */
  staged: number;
  /** EI-5957: the ACTUAL ownerIds whose wake STAGED (manual wake-mode) — the
   *  named set behind `staged`, so a leader-steering send/dispatch can surface a
   *  loud "directive STAGED, not delivered for <who>" warning instead of a quiet
   *  `staged:1` that reads like success. `staged === stagedTargets.length`. */
  stagedTargets: string[];
  /** P-022: recipients BEYOND MAX_WAKE_FANOUT — injected (durable) but not woken.
   *  Non-empty only on an oversized audience fan (the cost-DoS shape). */
  fanoutCapped: string[];
  /** Recipients whose wake chain exceeded the local deadline. Their durable inbox message
   *  exists, but the wake may still complete late; never classify these as absent/missed. */
  timedOutTargets: string[];
}

type RequiredWakeAttempt = {
  subscriberId: string;
  eventKey: string;
  outcome: 'queued' | 'missed';
};

/**
 * Record only completed required-wake fires. This is deliberately one batched,
 * fail-soft write: the inbox message and wake result are already the durable
 * delivery path, while this ledger is liveness evidence used by presence and
 * reclaim readers. Staged, timed-out, and fire-error outcomes are unknown and
 * must not be rewritten as misses.
 */
async function recordRequiredWakeAttempts(
  attempts: readonly RequiredWakeAttempt[],
  workspaceId: string | undefined,
): Promise<void> {
  if (attempts.length === 0 || !workspaceId) return;
  try {
    const { sql } = getOrgPg();
    const subscriberIds = attempts.map((a) => a.subscriberId);
    const eventKeys = attempts.map((a) => a.eventKey);
    const outcomes = attempts.map((a) => a.outcome);
    await withDbCallDeadline(
      sql`
        INSERT INTO harness_shared.event_wake_attempts
          (workspace_id, subscriber_id, event_key, outcome)
        SELECT ${workspaceId}, subscriber_id, event_key, outcome
          FROM unnest(
            ${subscriberIds}::text[],
            ${eventKeys}::text[],
            ${outcomes}::text[]
          ) AS attempt(subscriber_id, event_key, outcome)
      `,
      {
        // The inbox row and completed wake are already durable. Bound this
        // diagnostic ledger write by the wake leg budget so it cannot make a
        // successful coord:send exceed the transport deadline.
        ms: COORD_WAKE_TARGET_TIMEOUT_MS,
        label: 'coord:inbox-wake.required-attempt-ledger',
      },
    );
  } catch (e) {
    // The ledger is diagnostic/reclaim evidence, not part of the send's
    // delivery transaction. Never turn a successful inbox send into a failure.
    console.warn(
      `[inbox-wake] required-wake attempt ledger write failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Fire the inbox-wake key for each addressed recipient — one targeted emit per
 * ownerId, never a broadcast (P-042). `recipients` is the POST-expansion `to[]`
 * (audience selectors already resolved to concrete ownerIds by sendMessage), so
 * `*`/`human`/empty are filtered here and never reach the pump.
 *
 * Fail-soft: the inbox write is the durable truth; a wake fan that errors must
 * not fail the send. Each recipient's emit is independent (one bad key never
 * starves the others).
 */
export async function wakeRecipients(
  recipients: readonly string[],
  opts: {
    summary?: string;
    payload?: unknown;
    source?: string;
    workspaceId?: string;
    /** Record completed fire outcomes for a coord:send wake:'required'. */
    requiredWake?: boolean;
    /** Server-verified relay provenance from the message envelope. A verified
     * OWNER origin bypasses manual staging: the owner has already reviewed and
     * authorized this wake. Missing/unverified/agent-origin stamps never bypass. */
    relayProvenance?: RelayProvenanceStamp | null;
  } = {},
): Promise<WakeRecipientsResult> {
  // owner-2026-06-17: resolve a short ownerId PREFIX to the full id before firing
  // the wake key — the key is exact (`coord:inbox-wake:<full-ownerId>`), so a short
  // prefix would fire a key nobody watches (woken:0). Best-effort + fail-soft.
  // EI-20239029846984233: the resolver and the manual-mode membership check share
  // a memoized roster promise, but a stalled presence/recorded-session/remote read
  // can otherwise hold both before the per-target wake deadline below is reached.
  // Bound the shared preflight once so a wake still returns a degraded, fail-open
  // result before coord:send's transport timeout.
  type WakeRosterSnapshot = readonly [string[], Set<string> | null];
  const rosterBounded = await withBoundedTimeout<WakeRosterSnapshot>(
    () =>
      Promise.all([
        resolveBestEffortAgainstRoster(recipients, opts.workspaceId),
        knownOwnerIdSet(opts.workspaceId),
      ]) as Promise<WakeRosterSnapshot>,
    {
      fallback: [[...recipients], null] as WakeRosterSnapshot,
      timeoutMs: COORD_WAKE_TARGET_TIMEOUT_MS,
      label: 'coord:inbox-wake:roster',
    },
  );
  const [resolved, roster] = rosterBounded.value;
  const allTargets = [...new Set(resolved)].filter((r) => !NON_WAKEABLE.has(r));
  // P-022: cap the wake fan — beyond MAX_WAKE_FANOUT the overflow is injected but
  // NOT woken (the durable inbox row already landed at sendMessage), so an
  // oversized audience can't detonate thousands of billable turns from one send.
  const targets = allTargets.slice(0, MAX_WAKE_FANOUT);
  const fanoutCapped = allTargets.slice(MAX_WAKE_FANOUT);
  if (fanoutCapped.length > 0) {
     
    console.warn(
      `[inbox-wake] wake fan-out capped at ${MAX_WAKE_FANOUT}: ${fanoutCapped.length} recipient(s) ` +
        'INJECTED but not woken (oversized audience — they see it on their next turn).',
    );
  }
  // The per-agent wake-MODE gate (hive-agent-tabs P-007/D-005), GRADUATED off
  // the POT_AGENT_TABS flag (start-hive-wake P-007 / OQ-2): the gate is the
  // hive's PAUSE primitive (pot:pause sets the global default to `manual`), so
  // it must hold regardless of a UI flag — a flipped-off flag silently unmaking
  // Pause would fire wakes into a frozen hive. Behavior-neutral otherwise:
  // everything resolves `auto` by default, and auto fires immediately as before.
  //
  // EI-9322 (coord:send repeated 60s-timeout watchdog fires): each target's
  // {resolveWakeMode → stagePendingWake|emitAwaitedEvent} chain used to run in
  // a sequential `for` loop — up to MAX_WAKE_FANOUT (64) recipients × 2 DB
  // round-trips each. Under this fleet's write contention, per-call latency of
  // even a couple hundred ms compounds into minutes (confirmed via
  // tool_invocations: coord:send durations up to 360s against a nominal 60s
  // timeout, ~4% of calls over a 6h window). Each target's work is fully
  // independent (no shared mutable state read-then-written across
  // iterations), so fan it out with Promise.all instead of awaiting one at a
  // time — same total DB work, but issued concurrently instead of serially.
  // A self-loop wake bypasses the manual gate entirely (staging it deadlocks — see
  // isLoopWakeSource), as does the OWNER's own GUI wake (staging it queues the owner's
  // message for the owner's own review — see isOwnerGuiWakeSource, WI-37858). The
  // delivery-ladder rescue also bypasses it: staging the alarm behind the manual gate
  // would mute the detector whose job is to surface unread directed mail (EI-201236...).
  // The escalation-SLA reroute likewise bypasses it: staging the system's selected
  // handoff would make the time-bound remediation depend on an owner noticing and
  // releasing a review item (EI-22967284569456680).
  // An owner-verified relay is the fourth narrow bypass: staging an authenticated
  // owner resume behind the manual PAUSE gate asks the owner to approve a command
  // they already issued and strands the paused target indefinitely
  // (EI-21420024752195459). The provenance was resolved server-side by coord:send;
  // an unverified or merely agent-origin coord chain does NOT cross the gate.
  // Everything else still honors the per-agent manual pause/edit gate exactly as
  // before (default-preserving).
  const bypassManualGate =
    isLoopWakeSource(opts.source) ||
    isOwnerGuiWakeSource(opts.source) ||
    isDeliveryLadderWakeSource(opts.source) ||
    isEscalationSlaRerouteWakeSource(opts.source) ||
    isOwnerVerifiedRelay(opts.relayProvenance);
  type TargetOutcome =
    | { kind: 'staged'; ownerId: string }
    | { kind: 'fired'; key: string; woken: number }
    | { kind: 'fire-failed'; key: string }
    | { kind: 'timed-out'; ownerId: string; key: string }
    | { kind: 'skipped' };
  const outcomes = await Promise.all(
    targets.map(async (ownerId): Promise<TargetOutcome> => {
      const key = inboxWakeKey(ownerId);
      type CompletedOutcome = Exclude<TargetOutcome, { kind: 'timed-out' }>;
      const bounded = await withBoundedTimeout<CompletedOutcome | null>(
        async (): Promise<CompletedOutcome> => {
          // Manual mode → STAGE instead of fire; the agent is not re-invoked (EXCEPT a self-loop wake).
          if (!bypassManualGate) {
            let manual = false;
            try {
              manual = (await resolveWakeMode(ownerId)) === 'manual';
            } catch {
              manual = false; // mode store unreadable → default auto (fire)
            }
            if (manual) {
              // EI-9971: a target that matches NO known agent (local, recorded-session, or
              // federated) would stage a `pending_wakes` row nobody can ever review/release —
              // pure debris until the hourly dead-owner sweep's grace window lapses. Skip
              // staging (never fire it either — firing a key nobody watches is a harmless
              // no-op, but the manual gate means we'd stage, not fire). `roster === null`
              // (unavailable/empty) fails OPEN — stage as before rather than guess.
              if (roster !== null && !roster.has(ownerId)) {
                console.warn(
                  `[inbox-wake] skipping wake-stage for unresolvable recipient "${ownerId}" ` +
                    '(matches no known local/recorded/federated agent — would be undeletable debris).',
                );
                return { kind: 'skipped' };
              }
              try {
                await stagePendingWake({
                  ownerId,
                  summary: opts.summary,
                  payload: opts.payload,
                  source: opts.source,
                  workspaceId: opts.workspaceId,
                });
                return { kind: 'staged', ownerId };
              } catch (e) {
                console.warn(
                  `[inbox-wake] stage for ${ownerId} failed: ${e instanceof Error ? e.message : e}`,
                );
                return { kind: 'skipped' };
              }
            }
          }
          try {
            const res = await emitAwaitedEvent({
              key,
              summary: opts.summary,
              payload: payloadWithRelayProvenance(opts.payload, opts.relayProvenance),
              source: opts.source,
              workspaceId: opts.workspaceId,
            });
            return { kind: 'fired', key, woken: res.woken };
          } catch (e) {
            // Best-effort: the message already persisted to the inbox; a wake-fan
            // hiccup degrades to "seen on the recipient's next natural turn".
            console.warn(
              `[inbox-wake] wake fire for ${ownerId} failed: ${e instanceof Error ? e.message : e}`,
            );
            return { kind: 'fire-failed', key };
          }
        },
        {
          fallback: null,
          timeoutMs: COORD_WAKE_TARGET_TIMEOUT_MS,
          label: `coord:inbox-wake:${ownerId}`,
        },
      );
      if (bounded.reason === 'timeout') return { kind: 'timed-out', ownerId, key };
      if (bounded.value === null) return { kind: 'fire-failed', key };
      return bounded.value;
    }),
  );
  const keys: string[] = [];
  const requiredAttempts: RequiredWakeAttempt[] = [];
  let woken = 0;
  let staged = 0;
  const stagedTargets: string[] = [];
  const timedOutTargets: string[] = [];
  for (const o of outcomes) {
    switch (o.kind) {
      case 'staged':
        staged += 1;
        stagedTargets.push(o.ownerId);
        break;
      case 'fired':
        keys.push(o.key);
        woken += o.woken;
        if (opts.requiredWake) {
          requiredAttempts.push({
            subscriberId: ownerFromInboxWakeKey(o.key) ?? o.key,
            eventKey: o.key,
            outcome: o.woken > 0 ? 'queued' : 'missed',
          });
        }
        break;
      case 'fire-failed':
        keys.push(o.key);
        break;
      case 'timed-out':
        keys.push(o.key);
        timedOutTargets.push(o.ownerId);
        break;
      case 'skipped':
        break;
    }
  }
  await recordRequiredWakeAttempts(requiredAttempts, opts.workspaceId);
  return {
    targets,
    keys,
    queued: woken,
    woken,
    pickupConfirmed: false,
    staged,
    stagedTargets,
    fanoutCapped,
    timedOutTargets,
  };
}

/**
 * EI-5957: the LOUD note for a wake that STAGED instead of delivering (the
 * target is in `manual` wake-mode — the hive pause/edit gate). The failure this
 * fixes: a fleet LEADER's `coord:send`/`coord:dispatch` directive to a member in
 * manual mode returns a quiet `staged:1` that reads like success, so the leader
 * assumes delivery while the member never receives the directive (it sat in the
 * wake-queue undelivered). Pure so it unit-tests without PG; the caller
 * (send.ts / composeDispatch) attaches it to the wake result.
 */
export function buildStagedWakeNote(stagedTargets: readonly string[]): string {
  const who = stagedTargets.join(', ');
  return (
    `wake STAGED, NOT delivered for ${who}: target(s) are in MANUAL wake-mode (the hive pause/edit gate), ` +
    'so this directive was queued for owner review instead of re-invoking them — they will NOT act on it. ' +
    'To make it land, RELEASE the staged wake (coord:wake-queue { action: "release_all", agent: <target> }) ' +
    'or flip the target to auto (coord:wake-mode { agent: <target>, mode: "auto" }), then re-send. ' +
    'A fleet leader steering its own members almost always wants them on auto.'
  );
}

// ── Idle-recipient REPORTING on the no-wake (default inject-only) path ──────────
// coord-dispatch-reliability-2026-06-21 P-001. A plain `coord:send` (no wake)
// lands in the recipient's inbox and is seen on their NEXT natural turn — it does
// NOT re-invoke a sleeping agent. So a hand-off injected to an idle agent silently
// stalls: the message is durable, but nobody picks it up until something else
// wakes them. This path REPORTS (never acts on) that risk: for each concrete
// addressee we NON-FIRINGLY probe whether anyone is watching its inbox-wake key,
// so the sender learns "this landed in an inbox no live session is watching".
//
// INVARIANTS (the load-bearing ones):
//  (a) REPORT-ONLY — we NEVER call emitAwaitedEvent / wake on this path. Auto-waking
//      would violate the wake=billable cost model (unify-watch D-002: inject is the
//      default, wake is the deliberate opt-in) and thunder-herd idle agents.
//  (b) We skip the SAME non-wakeable targets the wake fan skips ('*' / 'human' /
//      empty + audience selectors) — they are not single, wake-resumable agents.
//  (c) FEDERATION FAIL-SOFT — a recipient NOT in the local roster is federated /
//      remote, and its watchers live on its home instance, not in OUR await store.
//      We must NEVER falsely flag it idle: it is classified `unknown` (advisory).
//      And ANY roster / await-store read hiccup DEGRADES to "report nothing"
//      (the send already succeeded) — it must never throw or block. The send
//      succeeding is sacred.

/** Per-recipient liveness disposition on the no-wake path. */
export type RecipientLiveness =
  /** Concrete local recipient with ≥1 active watcher on its inbox-wake key — a
   *  live session will see the inject; NOT idle. */
  | 'live'
  /** Concrete local recipient with ZERO active watchers — the inject lands in an
   *  inbox no session is watching; the work silently stalls until something else
   *  wakes them. Flagged in `idleRecipients` / `notWoken`. */
  | 'idle'
  /** Not in the local roster (federated / remote, or a just-swept id): its
   *  watchers aren't in OUR await store, so we CANNOT know — advisory only,
   *  NEVER flagged idle (invariant c). */
  | 'unknown';

export interface IdleClassificationInput {
  /** A concrete, wakeable recipient ownerId (caller pre-filters selectors). */
  ownerId: string;
  /** Is this ownerId in the local presence roster? (false ⇒ federated/unknown) */
  inRoster: boolean;
  /** How many active (unfired, uncancelled) watchers are on its inbox-wake key.
   *  Only meaningful when inRoster — a federated recipient's watchers live
   *  elsewhere. */
  activeWatchers: number;
}

/**
 * PURE core (unit-tested): classify ONE concrete recipient's no-wake liveness.
 *  - not in the local roster → `unknown` (federated/remote — never falsely idle)
 *  - in roster, ≥1 active watcher → `live`
 *  - in roster, zero active watchers → `idle` (the report-worthy case)
 */
export function classifyRecipientLiveness(input: IdleClassificationInput): RecipientLiveness {
  if (!input.inRoster) return 'unknown';
  return input.activeWatchers > 0 ? 'live' : 'idle';
}

/**
 * WI-5994: a recipient this probe would otherwise call `idle` (zero active
 * inbox-wake watchers), reclassified because it has an ARMED engine loop with
 * a KNOWN future fire — dormant BETWEEN loop fires, not dead. The disconfirming
 * data (`nextFireAt`) was already sitting in `fleet:leader-brief`/`loop:status`
 * the whole time; this is that same signal consulted on the wake path instead
 * of only on the read-only presence path.
 */
export interface DormantScheduledInfo {
  ownerId: string;
  /** ISO timestamp of the loop's next scheduled fire — when the message will
   *  actually be seen with NO respawn needed. Null when the loop is currently
   *  PARKED (a turn is in flight right now — the fire is imminent/unknown, not
   *  merely "some time in the future"). */
  nextFireAt: string | null;
  /** True when the loop's turn is in flight right now (parked) rather than
   *  waiting for a future `nextFireAt`. */
  parked: boolean;
}

/**
 * PURE: does this loop status turn an "idle" (no active wake-watcher) verdict
 * into "dormant-scheduled" (a real future delivery is already scheduled, no
 * respawn needed)? Only an ACTIVE, non-stalled loop counts — a stalled loop's
 * `nextFireAt` is not a promise anything will actually happen (WI-5975 sibling:
 * a broken dead-man's-switch must not be read as "fine, it'll fire").
 */
export function classifyDormantSchedule(
  loop: Pick<LoopStatus, 'active' | 'nextFireAt' | 'parked' | 'stalled'> | null | undefined,
  nowMs: number = Date.now(),
): { parked: boolean; nextFireAt: string | null } | null {
  if (!loop || !loop.active || loop.stalled) return null;
  if (loop.parked) return { parked: true, nextFireAt: null };
  if (loop.nextFireAt) {
    const t = Date.parse(loop.nextFireAt);
    if (Number.isFinite(t) && t > nowMs) return { parked: false, nextFireAt: loop.nextFireAt };
  }
  return null;
}

export interface IdleRecipientReport {
  /** Concrete local recipients whose inject lands in an inbox NO live session is
   *  watching AND no scheduled loop fire will pick it up either — the work
   *  silently stalls until respawn. The genuinely reportable/reassignable set
   *  (P-001, tightened by WI-5994 to exclude dormant-scheduled recipients, and
   *  by EI-19937974676482462 to exclude `aliveNotWakeable` below). */
  idle: string[];
  /** Concrete local recipients with a live watcher — the inject will be seen. */
  live: string[];
  /** WI-5994: recipients that would otherwise read `idle` but have an armed
   *  loop with a known future fire (or a turn in flight right now) — delivery
   *  is DEFERRED, not lost. NEVER treat these as grounds for reassignment or a
   *  `recipient_dead` verdict. */
  dormantScheduled: DormantScheduledInfo[];
  /** Recipients not in the local roster (federated/remote) — advisory, NEVER
   *  reported as idle (invariant c). */
  unknown: string[];
  /** True when a roster / await-store read failed and we degraded to report
   *  NOTHING (the send still succeeded — invariant c). `idle` is empty here. */
  degraded: boolean;
  /**
   * EI-19937974676482462: idle candidates (zero active inbox-wake watchers)
   * that the SHARED liveness oracle (`resolveSessionStates`, the same one
   * fleet:assignments/coord:presence use) confirms are ALIVE per the
   * session-log/activity truth (`sessionState` 'live' or 'recorded') despite
   * having no live wake-await — e.g. a cup mid-turn that never registered one
   * (EI-12699), or a session between coord-presence registration and its
   * first await. A wake genuinely will NOT land via the inbox-wake key for
   * these — that part of `idle`'s meaning still holds — but the target is
   * demonstrably NOT dead, so callers must never fold these into a
   * `recipient_dead` / "sessionState=ended" claim (that claim would be false;
   * it is exactly the false-dead half of the alive/dead disagreement this
   * fixes between coord:wake and fleet:assignments for the SAME agent).
   * Best-effort: an oracle hiccup leaves the candidate in `idle` (prior
   * behavior), never invents a false alive verdict.
   */
  aliveNotWakeable: string[];
  /**
   * Recipients whose complete probe set includes a measured shared-oracle
   * `sessionState: 'ended'` verdict. This is narrower than `idle`: callers
   * making routing decisions must use this positive classification only.
   */
  confirmedDead?: string[];
}

/** Complete fail-soft value for callers that need to degrade a report probe
 * without changing the durable send outcome. Keep every optional classification
 * field present: consumers should be able to distinguish a degraded diagnostic
 * from a partial/older-shaped result without guessing at omitted keys. */
export const EMPTY_IDLE_REPORT: IdleRecipientReport = {
  idle: [],
  live: [],
  dormantScheduled: [],
  unknown: [],
  degraded: true,
  aliveNotWakeable: [],
  confirmedDead: [],
};

/**
 * Probe the no-wake liveness of `recipients` (the POST-expansion `to[]` — audience
 * selectors already resolved to concrete ownerIds). REPORT-ONLY: this NEVER fires
 * a wake (invariant a) — it reads the await store with the NON-FIRING
 * `listActiveAwaitsForKey` probe + the local presence roster, classifies each
 * concrete recipient, and returns who would silently stall.
 *
 * Fully fail-soft (invariant c): a roster or await-store read error degrades to
 * `EMPTY_IDLE_REPORT` (degraded:true, empty `idle`) — it can NEVER throw, so the
 * send always succeeds regardless. Federated recipients (not in our roster) are
 * `unknown`, never falsely idle.
 */
export async function reportIdleRecipients(
  recipients: readonly string[],
  opts: { workspaceId?: string } = {},
): Promise<IdleRecipientReport> {
  // (b) Skip the same non-wakeable targets the wake fan skips: '*'/'human'/empty
  // and audience selectors ('@…') are not single wake-resumable agents.
  const concrete = [...new Set(recipients)].filter(
    (r) => !isSelectorOrWildcard(r) && !NON_WAKEABLE.has(r),
  );
  if (concrete.length === 0) return { idle: [], live: [], dormantScheduled: [], unknown: [], degraded: false, aliveNotWakeable: [], confirmedDead: [] };

  // The local roster — the membership truth for "is this recipient federated?".
  // A read hiccup DEGRADES the whole probe (invariant c): we cannot tell idle
  // from federated without it, and a false idle flag is worse than no flag.
  let rosterIds: Set<string>;
  try {
    const presence = await listPresence({ workspaceId: opts.workspaceId });
    rosterIds = new Set(presence.map((p) => p.ownerId));
  } catch (e) {
    console.warn(
      `[inbox-wake] idle-probe roster read failed, reporting no idle recipients: ${e instanceof Error ? e.message : e}`,
    );
    return EMPTY_IDLE_REPORT;
  }

  // EI-9322: probe every recipient's watcher count CONCURRENTLY rather than one
  // at a time in a sequential loop — this path can run against the same
  // env.to set the (already-parallelized, see wakeRecipients above) wake fan
  // does, and a sequential per-recipient DB round-trip was part of the same
  // compounding-latency shape behind the coord:send 60s-timeout watchdog
  // fires. Each recipient's probe is independent; a single hiccup must still
  // degrade the WHOLE report (invariant c) — preserved below by scanning the
  // settled outcomes for any 'error' disposition before deciding.
  type Disposition = RecipientLiveness | 'error';
  const probed = await Promise.all(
    concrete.map(async (ownerId): Promise<{ ownerId: string; disposition: Disposition }> => {
      const inRoster = rosterIds.has(ownerId);
      if (!inRoster) return { ownerId, disposition: 'unknown' };
      // NON-FIRING probe (invariant a): listActiveAwaitsForKey READS the active
      // watchers without firing/waking any of them — the deliberate report-only
      // peek the store documents for "is anyone waiting at all?".
      try {
        const watchers = await listActiveAwaitsForKey(inboxWakeKey(ownerId));
        return {
          ownerId,
          disposition: classifyRecipientLiveness({ ownerId, inRoster, activeWatchers: watchers.length }),
        };
      } catch (e) {
        // A per-recipient await-store hiccup degrades the WHOLE report (invariant
        // c): a missing watcher count would otherwise mis-classify this concrete
        // local recipient as idle. Report nothing rather than a false idle.
        console.warn(
          `[inbox-wake] idle-probe await read for ${ownerId} failed, reporting no idle recipients: ${e instanceof Error ? e.message : e}`,
        );
        return { ownerId, disposition: 'error' };
      }
    }),
  );
  if (probed.some((p) => p.disposition === 'error')) return EMPTY_IDLE_REPORT;

  const idleCandidates: string[] = [];
  const live: string[] = [];
  const unknown: string[] = [];
  for (const p of probed) {
    switch (p.disposition) {
      case 'idle':
        idleCandidates.push(p.ownerId);
        break;
      case 'live':
        live.push(p.ownerId);
        break;
      case 'unknown':
        unknown.push(p.ownerId);
        break;
    }
  }

  // WI-5994: before calling an idle candidate genuinely dead, consult the SAME
  // loop-schedule signal fleet:leader-brief already reads. An agent between
  // loop fires has zero active inbox-wake watchers (correctly `idle` per the
  // probe above) yet is dormant-SCHEDULED, not dead — its exact next fire is
  // known. Best-effort: a loop-status read hiccup just leaves the candidate in
  // `idle` (today's behavior), never invents a false dormant-scheduled entry.
  const idle: string[] = [];
  const dormantScheduled: DormantScheduledInfo[] = [];
  let loopStatusDegraded = false;
  if (idleCandidates.length > 0) {
    let loops: Map<string, LoopStatus>;
    try {
      loops = await getLoopStatuses(idleCandidates);
    } catch (e) {
      console.warn(
        `[inbox-wake] idle-probe loop-status read failed, treating candidates as plain idle: ${e instanceof Error ? e.message : e}`,
      );
      loopStatusDegraded = true;
      loops = new Map();
    }
    for (const ownerId of idleCandidates) {
      const schedule = classifyDormantSchedule(loops.get(ownerId) ?? null);
      if (schedule) dormantScheduled.push({ ownerId, ...schedule });
      else idle.push(ownerId);
    }
  }

  // EI-19937974676482462: before calling a remaining idle candidate dead, cross-check
  // the SAME shared liveness oracle fleet:assignments/coord:presence already apply
  // (resolveSessionStates — presence-derivation-unification-2026-07-17). This probe's
  // own `idle` verdict only knows "no active coord:inbox-wake watcher" — it has NO
  // opinion on the session-log/activity truth, so it was reporting `recipient_dead` /
  // "sessionState=ended" for agents the oracle itself classifies `live` or `recorded`
  // (a cup mid-turn that never registered a wake-await, per EI-12699 — the exact repro
  // that surfaced this: fleet:assignments read alive:true/recorded for a cup coord:wake
  // simultaneously called dead). Lazy dynamic import — liveness-oracle.ts pulls
  // presence-wakeability.ts, which imports THIS module for COORD_INBOX_WAKE_PREFIX, so a
  // static import here would cycle (the same reason recipient-liveness.ts imports it
  // lazily). Best-effort: an oracle hiccup leaves every candidate in `idle` (prior
  // behavior), never invents a false alive verdict.
  const aliveNotWakeable: string[] = [];
  const confirmedDead: string[] = [];
  if (idle.length > 0) {
    try {
      const { resolveSessionStates } = await import('./liveness-oracle');
      const verdicts = await resolveSessionStates(
        idle.map((ownerId) => ({ ownerId })),
        {
          hydratePerId: true,
          // EI-22546045794068839: this miss classifier must use the same
          // psu-host positive-authority leg as gate ownership / coord:presence.
          // Otherwise a live hosted session can read `held-live` in
          // state:read while this required-wake path calls it dead.
          psuHostPositiveAuthority: true,
        },
      );
      for (let i = idle.length - 1; i >= 0; i--) {
        const v = verdicts.get(idle[i]);
        if (v && (v.sessionState === 'live' || v.sessionState === 'recorded')) {
          aliveNotWakeable.unshift(idle[i]);
          idle.splice(i, 1);
        } else if (
          !loopStatusDegraded &&
          v?.sessionState === 'ended' &&
          v.signalMissing !== true &&
          v.confirmLiveness === false
        ) {
          // Only a complete, positive verdict supports moving work away from
          // this recipient. Missing/degraded oracle data and suspect/draining
          // states remain plain `idle`, never confirmed dead.
          confirmedDead.unshift(idle[i]);
        }
      }
    } catch (e) {
      console.warn(
        `[inbox-wake] idle-probe liveness-oracle cross-check failed, treating candidates as plain idle: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return { idle, live, dormantScheduled, unknown, degraded: false, aliveNotWakeable, confirmedDead };
}
