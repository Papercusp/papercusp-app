/**
 * release-force-guard — WI-4198: `work_items:release force:true` is no longer an
 * unconditional bypass of the EI-7588 compare-and-release.
 *
 * Incident (2026-07-11 19:40Z, owner-confirmed): a fleet leader executing a
 * backlog-drain mandate force-released a LIVE, progressing claim held by an agent
 * OUTSIDE their fleet — mid-deploy — with no authority check, no liveness check,
 * no recorded reason, no audit row, and no notification to holder or owner. The
 * tool description said "leader/reaper override only", but that was unenforced
 * prose. This module makes it a checked contract:
 *
 *   force on ANOTHER agent's claim is allowed iff
 *     (a) the holder is NOT live (presence stale/absent AND no recent item
 *         progress — the reaper case), or
 *     (b) the caller has hive-level authority (queen pane), or
 *     (c) the caller LEADS THE HOLDER'S fleet (not merely *a* fleet — the
 *         incident actor led their own).
 *   A cross-holder force additionally REQUIRES a `reason`, writes a
 *   harness_shared.audit_log row, and notifies the holder + the owner.
 *
 * `classifyFleetControlInvoker`'s 'owner' grade (any su pane) deliberately does
 * NOT authorize: the incident actor was itself an su pane, and with ~dozens of
 * su agent sessions in this hive "is an su" distinguishes nothing. The
 * su-as-owner convention grants fleet control, not peer-claim seizure.
 *
 * The reaper's direct releaseWorkItem() lib path is intentionally unaffected —
 * this guard is tool-layer only.
 */
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import type { Sql } from 'postgres';
import type { LivenessVerdict } from '../coordination/liveness-oracle';
import { agentToolInvocationPredicate } from '../sessions/automatic-tool-names';
import type { WorkItemReleaseRequest } from '../../work-items-release-request';
import { hasWorkItemProgressAfterReleaseRequest } from '../../work-items-release-request';

export type ForceReleaseBasis =
  | 'holder-not-live'
  | 'holder-warm-idle'
  | 'critical-claim-progress-expired'
  | 'holder-shutdown-accepted'
  | 'holder-session-ended'
  | 'holder-wake-missed'
  | 'announced-release-request-expired'
  | 'queen'
  | 'leads-holder-fleet';

/** A checked cross-holder mutation that can leave a forensic trail. */
export type ForceTransition = 'release' | 'claim';
export type ForceTransitionSurface = 'work_items' | 'plan_items';

/**
 * EI-18712366018708650: a fresh heartbeat is process keepalive, NOT evidence of real
 * work — a session can certify `live` via heartbeatAt alone while both REAL-activity
 * signals (lastActiveAt, itemLastProgressAt) have sat unmoved for hours (hit live:
 * heartbeat 44s old, lastActiveAt ~2h51m old, itemLastProgressAt ~3h old — all three
 * were fed into a bare `Math.max`, so the freshest one alone certified "live" and
 * blocked a force-release of an abandoned claim). This bounds how long available
 * activity signals may go stale before a fresh-heartbeat-only holder is reclassified from
 * "live" to "warm-idle" (the reaper case, WI-4198 leg (a)). An item that has not
 * recorded its first checkpoint has no item-progress signal yet; that explicit
 * absence must not protect an abandoned claim, while a present lastActiveAt remains
 * mandatory evidence of stale real activity. The window is deliberately generous
 * (3x PRESENCE_STALE_MS = 30min) so a holder genuinely mid-way through one long
 * operation is never misclassified: a working agent's own tool calls bump
 * lastActiveAt on a cadence far tighter than this, and a held item's own checkpoint
 * activity bumps itemLastProgressAt at least as often as its own turn cadence.
 */
export const WARM_IDLE_ACTIVITY_STALE_MS = 3 * PRESENCE_STALE_MS;

/**
 * P-008 critical claims are leased by ITEM progress independently of process
 * activity. A live agent doing unrelated work must not keep a release-critical
 * claim forever merely because lastActiveAt is fresh. The lease starts at the
 * newest genuine item progress stamp, falling back to takenAt for a newly
 * claimed item. Missing/unparseable evidence fails closed (not expired).
 */
export const CRITICAL_CLAIM_PROGRESS_LEASE_MS = WARM_IDLE_ACTIVITY_STALE_MS;

export interface CriticalClaimProgressLeaseVerdict {
  expired: boolean;
  anchorMs: number | null;
  ageMs: number | null;
  leaseMs: number;
}

export function assessCriticalClaimProgressLease(input: {
  takenAt: string | Date | null;
  lastProgressAt: string | Date | null;
  nowMs?: number;
  leaseMs?: number;
}): CriticalClaimProgressLeaseVerdict {
  const nowMs = input.nowMs ?? Date.now();
  const leaseMs = input.leaseMs ?? CRITICAL_CLAIM_PROGRESS_LEASE_MS;
  const progressMs = parseTs(input.lastProgressAt);
  const takenMs = parseTs(input.takenAt);
  const anchorMs = Number.isFinite(progressMs) && Number.isFinite(takenMs)
    ? Math.max(progressMs, takenMs)
    : Number.isFinite(progressMs)
      ? progressMs
      : Number.isFinite(takenMs)
        ? takenMs
        : null;
  const ageMs = anchorMs == null ? null : Math.max(0, nowMs - anchorMs);
  return {
    expired: ageMs != null && ageMs >= leaseMs,
    anchorMs,
    ageMs,
    leaseMs,
  };
}

/**
 * EI-18907586326157984: this guard's own heartbeat/lastActiveAt/itemLastProgressAt
 * comparison is a SEPARATE, hand-rolled liveness computation from the ONE shared
 * `sessionState` oracle (`liveness-oracle.ts` / `deriveSessionState`) every other
 * surface — coord:presence, fleet:status, fleet:assignments, coord:roster,
 * fleet:leader-brief, and coord:wake/coord:send's miss path — already routes
 * through (presence-derivation-unification-2026-07-17 P-001). The two can disagree
 * on the SAME holder: a cleanly-ended session's heartbeat row lingers "fresh" for
 * up to PRESENCE_STALE_MS after the process exits (heartbeat is process keepalive,
 * not a liveness proof — the module doc above already says this about
 * lastActiveAt/itemLastProgressAt, and it is equally true of heartbeatAt itself),
 * while the oracle's `wakeable` (a live `coord:inbox-wake:<id>` await — the SAME
 * mechanism coord:wake delivers through) + `liveTurn` (recent real agent_activity)
 * legs detect the clean end in SECONDS, not up to PRESENCE_STALE_MS/PRESENCE_DEAD_MS
 * later. Live repro: coord:wake reported `recipient_dead` (sessionState=ended, no
 * live inbox-wake await, no recent activity) for a holder whose heartbeat was still
 * only ~4.8min old — well under this guard's own staleness windows — so
 * `work_items:release{force:true}` refused `force_unauthorized` on a holder the
 * platform's own authoritative wake path had already proven dead, and
 * `fleet:assignments` simultaneously called the SAME row `verdict:'orphan',
 * action:'reclaim'` — an instruction the platform then refused to let anyone act on.
 *
 * The fix is ADDITIVE, not a replacement: `assessForceRelease` now ALSO consults
 * the shared oracle (`oracleSessionState`) for the holder, and treats an oracle
 * verdict of `ended` or `suspect` (pid-confirmed-dead / 30-min hard-stale — see
 * `isHardStale`/`PRESENCE_DEAD_MS`) as an independent reaper path
 * (`holder-session-ended`), alongside — never instead of — the existing
 * heartbeat/warm-idle check above (which catches a DIFFERENT case: a session that
 * IS still alive and taking turns, but has abandoned THIS SPECIFIC item — an
 * axis the session-level oracle has no visibility into at all). Either signal
 * alone is now sufficient to authorize a reclaim; both must say "live" to require
 * authority.
 */
export interface HolderLiveness {
  presenceFound: boolean;
  /** Positive lifecycle evidence: the holder's newest recorded session has ended. */
  recordedEnded: boolean;
  heartbeatAt: string | null;
  lastActiveAt: string | null;
  /** Newest durable tool-call ledger row for this owner. A Codex turn polling a
   *  long-running exec advances this even when presence lastActiveAt does not. */
  lastToolInvocationAt: string | null;
  itemLastProgressAt: string | null;
  /** ms since the FRESHEST of the three signals; null when none parses. */
  freshestAgeMs: number | null;
  /** heartbeat looked fresh, but BOTH lastActiveAt and itemLastProgressAt were
   *  present and provably stale beyond WARM_IDLE_ACTIVITY_STALE_MS — a
   *  process-keepalive-only signal, never inferred from missing data (EI-18712366018708650).
   *  When true, `live` is false (warm-idle counts as the reaper case). */
  warmIdle: boolean;
  /** EI-18907586326157984: the SAME sessionState verdict coord:wake / coord:presence /
   *  fleet:assignments already trust for this holder (null when the oracle lookup
   *  failed/degraded — never treated as evidence either way). `'ended'`/`'suspect'`
   *  independently authorizes a reclaim (`holder-session-ended`), regardless of how
   *  fresh the raw heartbeat above still looks. */
  oracleSessionState: LivenessVerdict['sessionState'] | null;
  /** EI-21216592915615709: a terminal wake attempt completed without any
   * post-attempt activity. Null means the shared oracle signal was unavailable. */
  oracleWakeAttemptMiss: boolean | null;
  /** The holder's managed host positively accepted session:end while the
   * process was still alive; this outranks a lingering fresh heartbeat. */
  shutdownAccepted: boolean;
  live: boolean;
}

export interface ForceReleaseVerdict {
  allowed: boolean;
  basis?: ForceReleaseBasis;
  holderLiveness: HolderLiveness;
}

export interface ForceReleaseDeps {
  getPresence?: (
    ownerId: string,
  ) => Promise<{ heartbeatAt: string; lastActiveAt: string | null; agentRole: string | null } | null>;
  /** Newest real tool invocation by the holder. Fail-soft: null means unknown,
   *  never evidence of idleness. */
  getLastToolInvocationAt?: (ownerId: string) => Promise<string | Date | null>;
  latestFleetMembership?: (
    workspaceId: string,
    ownerId: string,
  ) => Promise<{ fleetSlug: string | null; fleetRole: string | null } | null>;
  getFleet?: (workspaceId: string, fleetSlug: string) => Promise<{ leaderOwnerId: string | null } | null>;
  endedRecordedOwnerIds?: (ownerIds: string[]) => Promise<Set<string>>;
  /** Positive teardown acknowledgement written by session:end after the
   * managed host confirms it accepted the shutdown request. */
  shutdownAcceptedOwnerIds?: (ownerIds: string[]) => Promise<Set<string>>;
  /** EI-18907586326157984: the SAME shared liveness oracle coord:wake/coord:presence
   *  already use, resolving ONE holder by id (hydrated from its own presence row).
   *  Defaults to the real `resolveSessionStates([{ ownerId }], { hydratePerId: true })`.
   *  A lookup failure degrades to `null` (oracle signal absent) — never throws, never
   *  makes the guard STRICTER than before this fix (only ever additionally permissive
   *  when the oracle affirmatively says `ended`/`suspect`). */
  /** The full shared verdict is accepted so the force guard can consume the
   * pickup-miss leg without re-running the oracle. The legacy string shape is
   * retained for focused callers/tests that only provide sessionState. */
  resolveHolderSessionState?: (
    ownerId: string,
  ) => Promise<
    | LivenessVerdict['sessionState']
    | Pick<LivenessVerdict, 'sessionState' | 'wakeAttemptMiss'>
    | null
  >;
  now?: () => number;
}

/** PG timestamps arrive as `2026-07-11 16:38:41.614276-04` — normalize for Date.parse. */
function parseTs(v: unknown): number {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
}

/**
 * Read the holder's newest agent-authored tool call.
 *
 * Hook/UI/system telemetry can continue after an agent stops taking turns, so
 * a raw MAX(invoked_at) is not activity evidence for the warm-idle guard. Keep
 * this query on the shared behavior predicate: explicit agent/unknown origins
 * are real work, while legacy NULL rows retain the non-automatic tool-name
 * fallback used by the other behavior-facing readers.
 */
export async function readLastAgentToolInvocationAt(
  sql: Sql,
  ownerId: string,
): Promise<string | Date | null> {
  const rows = await sql<Array<{ last_tool_at: string | Date | null }>>`
    SELECT MAX(t.invoked_at) AS last_tool_at
      FROM harness_shared.tool_invocations t
     WHERE t.coord_owner_id = ${ownerId}
       AND ${agentToolInvocationPredicate(sql, 't')}
  `;
  return rows[0]?.last_tool_at ?? null;
}

/**
 * Decide whether `callerOwnerId` may force-release `holderOwnerId`'s claim.
 * Never throws; a lookup failure degrades to "signal absent", which only ever
 * makes the guard STRICTER on authority (an unresolvable fleet grants nothing)
 * and looser on liveness only when every signal is genuinely missing.
 */
export async function assessForceRelease(
  input: {
    callerOwnerId: string;
    holderOwnerId: string;
    workspaceId: string;
    itemLastProgressAt: string | Date | null;
    /** A pending work_items:request_release read from this exact item snapshot.
     *  When its announced reclaim deadline has expired, it is an authority basis
     *  only for the original requester against the original holder. */
    releaseRequest?: WorkItemReleaseRequest | null;
  },
  deps: ForceReleaseDeps = {},
): Promise<ForceReleaseVerdict> {
  const now = (deps.now ?? Date.now)();
  const getPresence =
    deps.getPresence ?? (async (o: string) => (await import('../coordination/presence')).getPresence(o));
  const getLastToolInvocationAt =
    deps.getLastToolInvocationAt ??
    (async (ownerId: string) => {
      const { getOrgPg } = await import('@papercusp/db-org');
      return readLastAgentToolInvocationAt(getOrgPg().sql, ownerId);
    });
  const endedOwnersOf =
    deps.endedRecordedOwnerIds ??
    (async (ownerIds: string[]) => (await import('../../adv-sessions')).endedRecordedOwnerIds(ownerIds));
  const shutdownAcceptedOwnersOf =
    deps.shutdownAcceptedOwnerIds ??
    (async (ownerIds: string[]) => (await import('../../adv-sessions')).shutdownAcceptedOwnerIds(ownerIds));
  // EI-18907586326157984: the SAME oracle coord:wake trusts, resolved in parallel
  // with the two lookups above — never gates on it (a hiccup degrades to `null`,
  // i.e. no oracle signal either way, same fail-soft posture as every other leg
  // here).
  const resolveHolderSessionState =
    deps.resolveHolderSessionState ??
    (async (ownerId: string) => {
      const { resolveSessionStates } = await import('../coordination/liveness-oracle');
      const map = await resolveSessionStates([{ ownerId }], { hydratePerId: true });
      return map.get(ownerId) ?? null;
    });
  const [holderPres, lastToolInvocationAt, endedOwners, shutdownAcceptedOwners, oracleSignal] = await Promise.all([
    getPresence(input.holderOwnerId).catch(() => null),
    getLastToolInvocationAt(input.holderOwnerId).catch(() => null),
    endedOwnersOf([input.holderOwnerId]).catch(() => new Set<string>()),
    shutdownAcceptedOwnersOf([input.holderOwnerId]).catch(() => new Set<string>()),
    resolveHolderSessionState(input.holderOwnerId).catch(() => null),
  ]);
  const oracleSessionState = typeof oracleSignal === 'string' ? oracleSignal : (oracleSignal?.sessionState ?? null);
  const oracleWakeAttemptMiss =
    oracleSignal != null && typeof oracleSignal === 'object' ? oracleSignal.wakeAttemptMiss === true : null;
  const recordedEnded = endedOwners.has(input.holderOwnerId);
  const shutdownAccepted = shutdownAcceptedOwners.has(input.holderOwnerId);
  // 'suspect' = the oracle CONFIRMED the process is gone (pid-probed ESRCH or
  // 30-min hard-stale) but is withholding a flat `ended` verdict only because
  // claims are still held — exactly the state a force-reclaim is FOR, so it
  // authorizes here just as `ended` does (the oracle's own caution about claim
  // CLEANUP order does not apply to the release call that IS the cleanup).
  const oracleNotLive = oracleSessionState === 'ended' || oracleSessionState === 'suspect';
  const wakeAttemptMiss = oracleWakeAttemptMiss === true;

  const heartbeatTs = holderPres ? parseTs(holderPres.heartbeatAt) : NaN;
  const lastActiveTs = holderPres ? parseTs(holderPres.lastActiveAt) : NaN;
  const lastToolInvocationTs = parseTs(lastToolInvocationAt);
  const itemProgressTs = parseTs(input.itemLastProgressAt);

  const signals = [heartbeatTs, lastActiveTs, lastToolInvocationTs, itemProgressTs].filter((t) => Number.isFinite(t));
  const freshest = signals.length ? Math.max(...signals) : null;
  // An ended newest adv-session row is authoritative over the warm presence row
  // that intentionally lingers for a short TTL after teardown. A resumed session
  // clears ended_at / creates a newer live row, so it naturally becomes live again.
  const presenceLive = !recordedEnded && freshest != null && now - freshest < PRESENCE_STALE_MS;

  // EI-18712366018708650: demote the specific "heartbeat is the only fresh signal"
  // shape to warm-idle. lastActiveAt must be PRESENT and provably stale beyond the
  // generous WARM_IDLE_ACTIVITY_STALE_MS window. itemLastProgressAt is different:
  // NULL means the item has never recorded progress, so it cannot be evidence that
  // this claim is alive; a present value must still parse and be stale. We continue
  // to fail closed when the real liveness signal (lastActiveAt) is missing.
  const heartbeatFresh = Number.isFinite(heartbeatTs) && now - heartbeatTs < PRESENCE_STALE_MS;
  const activitySignalsStale =
    Number.isFinite(lastActiveTs) &&
    now - lastActiveTs >= WARM_IDLE_ACTIVITY_STALE_MS &&
    (input.itemLastProgressAt == null ||
      (Number.isFinite(itemProgressTs) && now - itemProgressTs >= WARM_IDLE_ACTIVITY_STALE_MS));
  // EI-21377805080867612: Codex can remain inside one long turn while polling an
  // exec session at tool boundaries. Those calls are durable, genuine activity
  // even when presence.lastActiveAt and work-item checkpoints do not move. The
  // exact incident was force-released as warm-idle while this ledger advanced
  // every ~60s. A fresh tool row therefore vetoes warm-idle; an absent row remains
  // unknown and does not add evidence either way. The explicit NULL item-progress
  // case is handled above as no recorded progress, not as a fresh activity signal.
  const recentToolInvocation =
    Number.isFinite(lastToolInvocationTs) && now - lastToolInvocationTs < WARM_IDLE_ACTIVITY_STALE_MS;
  const warmIdle = presenceLive && heartbeatFresh && activitySignalsStale && !recentToolInvocation;
  // EI-18907586326157984: EITHER signal is now sufficient to declare the holder not
  // live — the raw heartbeat/activity heuristic (unchanged), OR the shared oracle
  // affirmatively saying the session is `ended`/`suspect`. Only when BOTH say "live"
  // does authority get required; this can only make the guard MORE permissive than
  // before (a null/degraded oracle read never flips `live` to false on its own).
  const live = presenceLive && !warmIdle && !oracleNotLive && !wakeAttemptMiss && !shutdownAccepted;

  const holderLiveness: HolderLiveness = {
    presenceFound: holderPres != null,
    recordedEnded,
    heartbeatAt: holderPres?.heartbeatAt ?? null,
    lastActiveAt: holderPres?.lastActiveAt ?? null,
    lastToolInvocationAt: lastToolInvocationAt == null ? null : String(lastToolInvocationAt),
    itemLastProgressAt: input.itemLastProgressAt == null ? null : String(input.itemLastProgressAt),
    freshestAgeMs: freshest == null ? null : now - freshest,
    warmIdle,
    oracleSessionState,
    oracleWakeAttemptMiss,
    shutdownAccepted,
    live,
  };

  // (a) reaper case: no live session and no recent progress — the claim is abandoned.
  // A warm-idle holder (fresh heartbeat, hours-stale real activity) or one the
  // shared oracle independently proved `ended`/`suspect` (EI-18907586326157984 — the
  // exact case a fresh-looking heartbeat can lag behind) counts as the same case,
  // just distinguished in `basis` for a clearer audit trail + notification.
  if (!live) {
    return {
      allowed: true,
      basis: !presenceLive
        ? 'holder-not-live'
        : warmIdle
          ? 'holder-warm-idle'
          : shutdownAccepted
            ? 'holder-shutdown-accepted'
            : oracleNotLive
              ? 'holder-session-ended'
              : 'holder-wake-missed',
      holderLiveness,
    };
  }

  // EI-21458682859181510: an expired onSilence:"reclaim" request is itself an
  // announced authority basis. The old code delegated the deadline sweep AND both
  // manual force surfaces to this ordinary liveness guard, so a process heartbeat or
  // background tool row could veto the promised consequence forever. Keep the
  // long-turn safety rail from EI-21377805080867612: an oracle `live`/`draining`
  // session may still be inside the turn that has not received the request. But once
  // the shared oracle says `parked` or `recorded`, there is no turn in flight; the
  // original requester may execute exactly the consequence they announced unless
  // the holder recorded item progress after the request, which is a response rather
  // than silence.
  const releaseRequest = input.releaseRequest;
  const holderProgressedSinceRequest =
    releaseRequest != null && hasWorkItemProgressAfterReleaseRequest(releaseRequest, input.itemLastProgressAt);
  const announcedReclaimExpired =
    releaseRequest != null &&
    !releaseRequest.resolved &&
    releaseRequest.onSilence === 'reclaim' &&
    releaseRequest.deadlineAt <= now &&
    releaseRequest.by === input.callerOwnerId &&
    releaseRequest.holder === input.holderOwnerId;
  const oracleBetweenTurns = oracleSessionState === 'parked' || oracleSessionState === 'recorded';
  if (announcedReclaimExpired && oracleBetweenTurns && !holderProgressedSinceRequest) {
    return {
      allowed: true,
      basis: 'announced-release-request-expired',
      holderLiveness,
    };
  }

  // Holder is LIVE — authority required. Classify the caller against the
  // HOLDER's fleet (control-core's classifier, per coord-authority-hardening).
  const [{ classifyFleetControlInvoker }, { classifyAgentPane }] = await Promise.all([
    import('../fleet_registry/control-core'),
    import('@papercusp/agent-mcp'),
  ]);
  const callerPres = await getPresence(input.callerOwnerId).catch(() => null);
  const paneKind = classifyAgentPane({
    role: callerPres?.agentRole ?? null,
    ownerId: input.callerOwnerId,
  }).kind;

  const membershipOf =
    deps.latestFleetMembership ??
    (async (ws: string, o: string) => (await import('../../fleet-membership-store')).latestFleetMembership(ws, o));
  const fleetOf =
    deps.getFleet ??
    (async (ws: string, slug: string) => (await import('../../agent-fleets-store')).getFleet(ws, slug));

  const holderFleet = (await membershipOf(input.workspaceId, input.holderOwnerId).catch(() => null))?.fleetSlug ?? null;
  const leaderOwnerId = holderFleet
    ? ((await fleetOf(input.workspaceId, holderFleet).catch(() => null))?.leaderOwnerId ?? null)
    : null;

  const invokedAs = classifyFleetControlInvoker({
    callerOwnerId: input.callerOwnerId,
    leaderOwnerId,
    paneKind,
  });
  if (invokedAs === 'leader') return { allowed: true, basis: 'leads-holder-fleet', holderLiveness };
  if (invokedAs === 'queen') return { allowed: true, basis: 'queen', holderLiveness };
  return { allowed: false, holderLiveness };
}

/** The refusal names what WOULD authorize — so the caller coordinates instead of retrying blind. */
export function forceRefusalHint(holder: string): string {
  return (
    `${holder} holds a LIVE claim (fresh presence/progress, and the shared sessionState oracle also reads it live) ` +
    `and you have no authority over it — force refused (WI-4198). ` +
    `What authorizes a force here: the holder's session going stale OR warm-idle — a fresh heartbeat with no real lastActiveAt/item-progress movement for ${Math.round(WARM_IDLE_ACTIVITY_STALE_MS / 60_000)}+ min (both reaper cases) — OR the shared liveness oracle (the same one coord:wake trusts) independently reporting the session \`ended\`/\`suspect\` (EI-18907586326157984), holding system-authority as an Overwatch pane, queen authority, or leading ${holder}'s OWN fleet. ` +
    `An accepted session:end acknowledgement also authorizes a reclaim while the host is winding down. ` +
    `A terminal wake with no post-attempt activity may also authorize a reclaim, but a queued/pending wake is not a miss. ` +
    `Otherwise coordinate with the holder (coord:send) — or with their fleet leader — instead of forcing.`
  );
}

/** Forensic audit row — mirrors release/deploy.ts's canonical full-column shape.
 * Fire-and-forget; never throws (the mutation already happened). The original
 * release-only helper below remains as a compatibility wrapper; claims reuse the
 * same audit path with a distinct action so a forced takeover is not misreported
 * as a release. */
export async function recordForceTransitionAudit(
  actor: string,
  itemId: string,
  operation: ForceTransition,
  details: Record<string, unknown>,
  surface: ForceTransitionSurface = 'work_items',
): Promise<void> {
  try {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    const { sql } = getOrgPg();
    const id = `wi-force-${operation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, `${surface}:${operation}:force`, itemId, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {
    console.warn(`[work_items:${operation}] force audit write failed:`, (err as Error)?.message);
  }
}

/** Backward-compatible release spelling used by the release handler. */
export async function recordForceReleaseAudit(
  actor: string,
  itemId: string,
  details: Record<string, unknown>,
): Promise<void> {
  return recordForceTransitionAudit(actor, itemId, 'release', details);
}

/** Notify the displaced holder (coord inbox — read on resume even if dead now)
 * and the owner (attention channel). Never throws. The operation is explicit so
 * a force-claim takeover says what actually happened to the old holder's claim. */
export async function notifyForceTransition(
  ident: { ownerId: string },
  input: {
    itemId: string;
    holder: string;
    basis: ForceReleaseBasis;
    reason: string;
    harness?: string | null;
    operation: ForceTransition;
    replacementAssignee?: string;
    surface?: ForceTransitionSurface;
  },
): Promise<void> {
  const isClaim = input.operation === 'claim';
  const surface = input.surface ?? 'work_items';
  const verb = isClaim ? 'FORCE-CLAIMED' : 'FORCE-RELEASED';
  const operationVerb = isClaim ? 'force-claimed' : 'force-released';
  try {
    const { sendMessage } = await import('../coordination/messages');
    await sendMessage(ident as never, {
      to: [input.holder],
      summary: `⚠ Your claim on ${input.itemId} was ${verb} by ${ident.ownerId} (basis: ${input.basis}) — ${input.reason.slice(0, 140)}`,
      harnessSlug: input.harness ?? undefined,
      extra: {
        auto: true,
        lifecycle: `force_${input.operation}`,
        work_item: input.itemId,
        basis: input.basis,
        ...(input.replacementAssignee ? { replacement_assignee: input.replacementAssignee } : {}),
      },
    });
  } catch (err) {
    console.warn(`[work_items:${input.operation}] force holder-notify failed:`, (err as Error)?.message);
  }
  try {
    const { notifyAttention } = await import('../../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `${surface}:${input.operation} force — ${input.itemId}`,
      body: `${ident.ownerId} ${operationVerb} ${input.holder}'s claim on ${input.itemId} (basis: ${input.basis})${input.replacementAssignee ? `; new assignee: ${input.replacementAssignee}` : ''}: ${input.reason}`,
      importance: 'high',
      harnessSlug: input.harness ?? undefined,
      data: {
        workItem: input.itemId,
        holder: input.holder,
        basis: input.basis,
        operation: input.operation,
        surface,
        ...(input.replacementAssignee ? { replacementAssignee: input.replacementAssignee } : {}),
      },
    });
  } catch (err) {
    console.warn(`[work_items:${input.operation}] force owner-notify failed:`, (err as Error)?.message);
  }
}

/** Backward-compatible release spelling used by the release handler. */
export async function notifyForceRelease(
  ident: { ownerId: string },
  input: {
    itemId: string;
    holder: string;
    basis: ForceReleaseBasis;
    reason: string;
    harness?: string | null;
  },
): Promise<void> {
  return notifyForceTransition(ident, { ...input, operation: 'release' });
}
