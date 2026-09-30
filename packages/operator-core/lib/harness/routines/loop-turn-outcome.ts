/**
 * Loop turn-outcome handler — feed a DEAD loop wake turn back into the autoloop circuit
 * (loop-wake-rate-limit-robustness-2026-06-23 P0b + P1a).
 *
 * THE GAP (agent-insights/loop-wake-turn-deaths-recorded-as-delivered): a loop's re-wake
 * runs a DETACHED `claude --resume … -p` turn whose delivery is recorded `delivered` on
 * SPAWN. If that turn then 429s and dies, the failure-streak fire-gate never sees it
 * (`fireLoopWake` records the enqueue as success), so the loop keeps firing empty wakes
 * into a rate-limited void and only the ≥30-minute stuck-park backstop ever recovers it —
 * blind, with no backoff.
 *
 * This is the registered `onResumeTurnExit` handler (wired into the await pump via
 * `registerResumeTurnOutcomeHandler`, the seam that avoids the harness/routines → engine
 * import cycle). For a LOOP-sourced (`source = loop:<routineId>`) resume turn that DIED, it:
 *   1. feeds the EXISTING autoloop circuit — `recordFire(installSlug, name, …, 'error')` —
 *      so a storm of dead loop turns backs off + opens the circuit (P0b), and
 *   2. re-arms the loop's `next_fire_at` by the 429 `retry-after` (P1a) instead of blindly
 *      retrying into the same wall — only while the loop is still parked at 'infinity' (the
 *      very turn we observed die), so a healthy/already-re-armed loop is never disturbed, and
 *   3. (EI-13818) raises a loud, debounced alert the FIRST time a `surfaceToUser` wedge class
 *      (usage_limit/auth/permanent) is observed — loop:arm loops are deliberately excluded
 *      from the chronic-failure sweep's own escalation (it expects the dead-owner terminal
 *      guard to cover them), but that guard only fires on a CONFIRMED-unreachable owner, never
 *      a rate-limited-but-alive one — the exact "nothing alerted while a leader burned" gap.
 *
 * A clean exit is USUALLY success, but resume-turn-outcome.ts's `classifyResumeTurnExit` (also
 * EI-13818) now first scans it for the same provider-wedge signature (a clean-exit "You've hit
 * your session limit" is otherwise indistinguishable from a normal turn) before trusting it —
 * closing the actual root cause: FOUR such deaths in 10 minutes were previously all recorded
 * `ok:true`, so neither the circuit nor this handler ever saw them.
 *
 * A genuine success (a clean exit with no wedge signature) is a NO-OP here: the reconcile-loop completion-rebase owns the
 * `recordFire('ok')` circuit reset when it sees the turn's lifecycle 'ended' marker — the
 * channel-agnostic success signal (a live-INJECT wake has no subprocess to observe). The
 * reconcile stuck-park backstop is the channel-agnostic FAILURE fallback for the rare cases
 * this fast/precise observer misses (an inject-path death, or an operator restart between
 * spawn and exit).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { clampUsageRearmDelayMs } from '@papercusp/papercusp-shared/agent';
import { runWithWorkspace } from '../../workspace-als';
import { classifyFireError, recordFire as defaultRecordFire } from '../../autoloop';
import { getLoopCarryNote as defaultGetLoopCarryNote, splitCarryNoteWalls } from '../../carry-note';
import { buildOwnerRespawnLaunchSpec, type RespawnLaunchSpec } from '../../carry-respawn';
import { markRespawnExpected as defaultMarkRespawnExpected } from '../../carry-respawn-marker';
import { estimateContextWindowForOwner, resolveModelSpecForOwner } from '../../compaction-usage';
import { modelWindowForSpec } from '../../agent-config-constants';
import {
  injectIntoHost as defaultInjectIntoHost,
  selfCompactionAvailability as defaultSelfCompactionAvailability,
  type SelfCompactionAvailability,
} from '../../events/await/psu-pty-discovery';
import { bumpSessionEpoch as defaultBumpSessionEpoch } from '../../memory/session-epoch-ledger';
import { tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from '../../agent-tools/coordination/compaction-recovery';
import { addressContinuationToOwner } from '../../carry-respawn-addressing';
import { autoPauseLoopRoutine as defaultAutoPauseLoopRoutine } from './loop-cost-cap';
import { detectOwnerAsk, stashLoopWallNag as defaultStashLoopWallNag } from './loop-wall-nag';
import { buildLoopWakePrompt, materializeLoop as defaultMaterializeLoop, type MaterializeLoopInput } from './loop';
import { registerResumeTurnOutcomeHandler } from '../../events/await/engine';
import {
  classifyResumeTurnExit,
  isUnavailableToolReferenceError,
  isStaleResumeTargetError,
  type ResumeTurnExitRaw,
  type ResumeTurnOutcome,
} from '../../events/await/resume-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';

const log = (msg: string) => console.warn(`[loop-turn-outcome] ${msg}`);

/** The loop wake `source` convention (loop-fire.ts): `loop:<routineId>`. */
const LOOP_SOURCE_PREFIX = 'loop:';

/** Same conservative fallback used by session:request-compaction when the live model window
 * cannot be resolved. A smaller carry budget is safe; a guessed larger one can recreate the
 * context-overflow wall while assembling the recovery itself. */
const FALLBACK_EFFECTIVE_WINDOW_TOKENS = 200_000;

/** A carry-respawn is latency-insensitive to this observer: the dying loop turn is already
 * over, so allow a pre-ack host enough time to pass its clean-boundary gate. */
const CARRY_RESPAWN_SOCKET_TIMEOUT_MS = 15 * 60_000;

const CONTEXT_OVERFLOW_RECOVERY_PROMPT =
  'Context-overflow recovery queued. ' +
  MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION +
  ' Resume the loop goal from the carried checkpoints.';

/** Recover the loop routine id from a delivery's source (`loop:<routineId>`), else null
 *  (a non-loop wake — we never attribute its turn death to a loop). */
export function loopRoutineIdFromSource(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(LOOP_SOURCE_PREFIX)) return null;
  const id = source.slice(LOOP_SOURCE_PREFIX.length).trim();
  return id || null;
}

/* The 6h re-arm ceiling that used to live here (and again in reconcile-loop-routines.ts, each
 * asking the other to be kept in step) is now the shared `clampUsageRearmDelayMs` — see its doc
 * comment. EI-20544023385610622 made it two-tier, and duplicating that twice would drift. */

/**
 * EI-19381528967421062: below this, a rate_limited/overloaded backoff is ORDINARY
 * governor-absorbed noise — turn-error.ts's `SURFACE_TO_USER` set deliberately excludes
 * `rate_limited` (an isolated 429 recovers in well under this; alerting on every one would
 * be pure spam). At or above it, the loop has gone SILENT long enough that a leader/owner
 * needs to know even though the error CLASS alone says "handle silently": measured live, a
 * dead-egress-proxy streak of bare 429s (not a normal RPM bump) pushed two members' waits
 * to ~50-100 minutes with NOTHING alerted, because the wedge alert below was gated on
 * `surfaceToUser` alone — a fleet ran with two stranded claims and no leader signal for the
 * whole window. This is a SEPARATE trigger from `surfaceToUser`, not a replacement for it:
 * a `usage_limit`/`auth`/`permanent` death still always alerts regardless of the computed
 * delay (those classes are inherently the human's business); this only widens the net to
 * catch a CHRONIC `rate_limited`/`overloaded` streak the class-based gate structurally
 * cannot see.
 */
const CHRONIC_BACKOFF_ALERT_FLOOR_MS = 10 * 60_000;

/**
 * The re-arm delay (ms from now) for a DEAD loop turn (P1a). A rate-limit / usage-cap death
 * backs off by the classified `retry-after` (or `resetAt - now`), floored at the loop's own
 * interval (never fire sooner than the cadence) and capped. Any other death (crash / empty)
 * re-arms at the plain interval — the failure-streak fire-gate (fed by recordFire('error'))
 * owns escalation for repeated non-rate-limit failures. Pure + injectable `now` for tests.
 */
export function computeDeathRearmMs(outcome: ResumeTurnOutcome, intervalMs: number, now: number = Date.now()): number {
  if (outcome.ok) return intervalMs; // not expected here (handler only re-arms deaths)
  const { error } = outcome;
  if (error.class === 'rate_limited' || error.class === 'usage_limit') {
    const fromRetryAfter = error.retryAfterMs != null && error.retryAfterMs > 0 ? error.retryAfterMs : undefined;
    const fromReset = error.resetAt != null ? error.resetAt - now : undefined;
    const hint = fromRetryAfter ?? (fromReset != null && fromReset > 0 ? fromReset : undefined);
    // The LONG ceiling is earned by two things at once, and both are required
    // (EI-20544023385610622). (1) The hint must be the RESET INSTANT, not `retry-after`: a
    // retry-after is a duration the provider expects you back after, never evidence of a
    // multi-day wall, so `usedRetryAfter` keeps the tight rail even on a usage_limit. (2) The
    // class must be `usage_limit`: a transient RPM 429 recovers in seconds, so however
    // confidently its reset instant was derived, parking a loop on it for days is never right.
    const usedRetryAfter = fromRetryAfter != null;
    const precision = error.class === 'usage_limit' && !usedRetryAfter ? error.resetPrecision : undefined;
    if (hint != null) return clampUsageRearmDelayMs(hint, intervalMs, precision);
  }
  return intervalMs;
}

interface LoopRoutineRef {
  id: string;
  name: string;
  installSlug: string;
  workspaceId: string;
  intervalSec: number | null;
  /** The pinned session the loop wakes — the carry-note / wall-nag scope key (P-006). */
  targetOwnerId: string | null;
  /** Existing wake configuration, so a cold recovery keeps the loop's goal and guardrails. */
  payloadTemplate: Record<string, unknown>;
}

/** Resolve a loop routine's fire-gate key (install_slug + name) + workspace + interval. */
async function getLoopRoutineRef(sql: Sql, routineId: string): Promise<LoopRoutineRef | null> {
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      install_slug: string;
      workspace_id: string;
      reschedule_interval_sec: number | null;
      target_owner_id: string | null;
      payload_template: Record<string, unknown> | null;
    }>
  >`
    SELECT id, name, install_slug, workspace_id, reschedule_interval_sec, target_owner_id, payload_template
      FROM harness_shared.routines
     WHERE id = ${routineId} AND reschedule_interval_sec IS NOT NULL
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    installSlug: r.install_slug,
    workspaceId: r.workspace_id,
    intervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    targetOwnerId: r.target_owner_id ?? null,
    payloadTemplate: r.payload_template ?? {},
  };
}

/**
 * Re-arm a loop's `next_fire_at` after its turn died — ONLY while it is still parked at
 * 'infinity' (the turn we observed die). Idempotent + never-backwards: a loop already
 * re-armed (by a racing reconcile) or cron-advanced no longer matches the guard, so this
 * never disturbs a healthy loop nor double-re-arms.
 */
async function rearmLoopAfterDeath(sql: Sql, routineId: string, delayMs: number, now: number): Promise<boolean> {
  const iso = new Date(now + delayMs).toISOString();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET next_fire_at = ${iso}::timestamptz, updated_at = now()
     WHERE id = ${routineId}
       AND active = TRUE
       AND next_fire_at = 'infinity'::timestamptz
    RETURNING id
  `;
  return rows.length > 0;
}

export interface LoopTurnOutcomeDeps {
  sql?: Sql;
  recordFire?: typeof defaultRecordFire;
  /** Injected pause seam for terminal context-overflow deaths. */
  autoPause?: typeof defaultAutoPauseLoopRoutine;
  /** Context-overflow recovery seams. Each defaults to the production carry-respawn path. */
  selfCompactionAvailability?: typeof defaultSelfCompactionAvailability;
  buildRespawnSpec?: typeof buildOwnerRespawnLaunchSpec;
  injectPsuHost?: typeof defaultInjectIntoHost;
  markRespawnExpected?: typeof defaultMarkRespawnExpected;
  bumpSessionEpoch?: typeof defaultBumpSessionEpoch;
  materializeLoop?: typeof defaultMaterializeLoop;
  /** Test/diagnostic seam; production resolves the owner's effective model window. */
  effectiveWindowTokens?: number;
  now?: number;
  /** P-006 turn-settle nag seams. */
  getLoopCarryNote?: typeof defaultGetLoopCarryNote;
  stashWallNag?: typeof defaultStashLoopWallNag;
}

interface ContextOverflowRecoveryResult {
  queued: boolean;
  rearmed: boolean;
  reason?: string;
}

async function resolveRecoveryWindowTokens(ownerId: string, override?: number): Promise<number> {
  if (override != null && Number.isFinite(override) && override > 0) return Math.floor(override);
  try {
    const observed = await estimateContextWindowForOwner(ownerId);
    if (observed != null && Number.isFinite(observed) && observed > 0) return Math.floor(observed);
    const modelSpec = await resolveModelSpecForOwner(ownerId);
    if (modelSpec) return modelWindowForSpec(modelSpec);
  } catch {
    // The recovery must not fail merely because telemetry/model lookup is unavailable.
  }
  return FALLBACK_EFFECTIVE_WINDOW_TOKENS;
}

function numericPayloadValue(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recoveryKickoff(ref: LoopRoutineRef, ownerId: string, intervalSec: number): string {
  const payload = ref.payloadTemplate;
  // Preserve an explicit custom prompt. The default prompt is rebuilt as COLD so it does not
  // tell the successor that it is continuing a warm transcript after the carry-respawn.
  if (payload.customWakePrompt === true && typeof payload.kickoff === 'string' && payload.kickoff.trim()) {
    return payload.kickoff;
  }
  const goal = typeof payload.goal === 'string' && payload.goal.trim() ? payload.goal : 'resume after context-overflow recovery';
  return buildLoopWakePrompt({
    ownerId,
    intervalSec,
    harness: ref.installSlug,
    goal,
    carry: 'cold',
    continuation: payload.continuation === 'gated' ? 'gated' : 'settle',
    mode: payload.mode === 'monitor' ? 'monitor' : 'work',
  });
}

function recoveryMaterializeInput(ref: LoopRoutineRef, ownerId: string, now: number): MaterializeLoopInput {
  const payload = ref.payloadTemplate;
  const intervalSec = ref.intervalSec ?? 60;
  const goal = typeof payload.goal === 'string' && payload.goal.trim() ? payload.goal : undefined;
  const costCapCents = numericPayloadValue(payload, 'costCapCents');
  const maxFires = numericPayloadValue(payload, 'maxFires');
  const maxDurationSec = numericPayloadValue(payload, 'maxDurationSec');
  return {
    workspaceId: ref.workspaceId,
    harnessSlug: ref.installSlug,
    ownerId,
    intervalSec,
    kickoff: recoveryKickoff(ref, ownerId, intervalSec),
    customWakePrompt: payload.customWakePrompt === true,
    ...(goal ? { goal } : {}),
    ...(costCapCents != null ? { costCapCents } : {}),
    ...(maxFires != null ? { maxFires } : {}),
    ...(maxDurationSec != null ? { maxDurationSec } : {}),
    carry: 'cold',
    continuation: payload.continuation === 'gated' ? 'gated' : 'settle',
    mode: payload.mode === 'monitor' ? 'monitor' : 'work',
    active: true,
    onlyIfInactive: true,
    sql: undefined,
    now: new Date(now),
  };
}

function recoveryFirstPrompt(ownerId: string, spec: RespawnLaunchSpec): string {
  if (spec.firstPrompt?.trim()) return spec.firstPrompt;
  const recoveryPrompt = addressContinuationToOwner(CONTEXT_OVERFLOW_RECOVERY_PROMPT, ownerId);
  try {
    return tagTurnForInjection({
      sid: ownerId,
      origin: 'watchdog',
      text: recoveryPrompt,
    }).taggedText;
  } catch {
    return recoveryPrompt;
  }
}

/**
 * Queue a deterministic carry-respawn for a context-overflowed loop owner, then restore the
 * loop as a COLD routine. Every step before the host accepts the carry is deliberately guarded:
 * the old loop stays paused and no marker/epoch write or materialization can claim that a
 * successor exists when it does not. `onlyIfInactive` on the final materialization is the CAS
 * rail against an explicit loop:arm racing this stale death observation.
 */
async function recoverContextOverflow(
  sql: Sql,
  ref: LoopRoutineRef,
  deps: LoopTurnOutcomeDeps,
  now: number,
): Promise<ContextOverflowRecoveryResult> {
  const ownerId = ref.targetOwnerId?.trim();
  if (!ownerId) return { queued: false, rearmed: false, reason: 'missing_target_owner' };

  let availability: SelfCompactionAvailability;
  try {
    const canCompact = deps.selfCompactionAvailability ?? defaultSelfCompactionAvailability;
    availability = canCompact(ownerId);
  } catch (e) {
    return {
      queued: false,
      rearmed: false,
      reason: `host_probe_failed:${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!availability.available) return { queued: false, rearmed: false, reason: availability.reason };

  const effectiveWindowTokens = await resolveRecoveryWindowTokens(ownerId, deps.effectiveWindowTokens);
  const buildSpec = deps.buildRespawnSpec ?? buildOwnerRespawnLaunchSpec;
  let spec: RespawnLaunchSpec | null;
  try {
    spec = await buildSpec(ownerId, {
      effectiveWindowTokens,
      buildOpts: { workspaceId: ref.workspaceId, boundaryDeliberate: true },
    });
  } catch (e) {
    return {
      queued: false,
      rearmed: false,
      reason: `carry_build_failed:${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!spec) return { queued: false, rearmed: false, reason: 'carry_build_failed' };

  const inject = deps.injectPsuHost ?? defaultInjectIntoHost;
  let queued = false;
  try {
    queued = await inject(
      availability.host.sock,
      {
        mode: 'carry-respawn',
        data: recoveryFirstPrompt(ownerId, spec),
        systemPromptAddendum: spec.systemPromptAddendum,
        ownerId,
      },
      CARRY_RESPAWN_SOCKET_TIMEOUT_MS,
    );
  } catch (e) {
    return {
      queued: false,
      rearmed: false,
      reason: `carry_queue_failed:${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!queued) return { queued: false, rearmed: false, reason: 'carry_queue_rejected' };

  // The host accepted the cut. Only now may SessionEnd skip claim release and the successor
  // re-prime memory after its context boundary. Both writes are best-effort, matching the
  // deliberate session:request-compaction path; neither can turn an accepted queue into a
  // reported failure.
  try {
    await (deps.markRespawnExpected ?? defaultMarkRespawnExpected)(ownerId);
  } catch (e) {
    log(`respawn marker failed for loop ${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await (deps.bumpSessionEpoch ?? defaultBumpSessionEpoch)(sql, ownerId);
  } catch (e) {
    log(`session epoch bump failed for loop ${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const materialized = await (deps.materializeLoop ?? defaultMaterializeLoop)({
      ...recoveryMaterializeInput(ref, ownerId, now),
      sql,
    });
    return {
      queued: true,
      rearmed: materialized.changed,
      ...(materialized.changed ? {} : { reason: 'cold_rearm_raced_existing_active_loop' }),
    };
  } catch (e) {
    return {
      queued: true,
      rearmed: false,
      reason: `cold_rearm_failed:${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Handle a resume turn's observed exit for a LOOP-sourced wake. Fail-soft (never throws):
 * the outcome feed is a protection layer, and the reconcile stuck-park backstop is the
 * durable fallback. Returns a small result for tests/observability.
 */
export async function handleLoopResumeTurnExit(
  d: DeliveryWork,
  raw: ResumeTurnExitRaw,
  deps: LoopTurnOutcomeDeps = {},
): Promise<{
  handled: boolean;
  routineId?: string;
  class?: string;
  rearmedMs?: number;
  nagged?: boolean;
  recoveryQueued?: boolean;
  recoveryRearmed?: boolean;
  recoveryReason?: string;
}> {
  try {
    const routineId = loopRoutineIdFromSource(d.source);
    if (!routineId) return { handled: false }; // not a loop wake — nothing to attribute
    const now = deps.now ?? Date.now();
    const outcome = classifyResumeTurnExit(raw, now);
    if (outcome.ok) {
      // Survived — reconcile owns the 'ok' circuit reset. P-006 turn-settle nag: a clean
      // detached turn's stdout tail IS its final text — an owner-ask there with ZERO wall
      // rows is a commitment about to dissolve; stash the nag for the next fire. Pure
      // detect FIRST (no DB unless it hits), then everything fail-soft.
      let nagged = false;
      try {
        const excerpt = detectOwnerAsk(raw.stdoutTail);
        if (excerpt) {
          const sql = deps.sql ?? getOrgPg().sql;
          const ref = await getLoopRoutineRef(sql, routineId);
          if (ref?.targetOwnerId) {
            const getNote = deps.getLoopCarryNote ?? defaultGetLoopCarryNote;
            const note = await getNote({ harness: ref.installSlug, ownerId: ref.targetOwnerId });
            if (splitCarryNoteWalls(note).walls.length === 0) {
              const stash = deps.stashWallNag ?? defaultStashLoopWallNag;
              nagged = await stash({ harness: ref.installSlug, ownerId: ref.targetOwnerId }, excerpt, now);
              if (nagged) log(`loop '${routineId}' turn ended on a row-less owner-ask — nag stashed for the next wake`);
            }
          }
        }
      } catch { /* the nag is best-effort — never disturb the outcome contract */ }
      return { handled: false, routineId, ...(nagged ? { nagged: true } : {}) };
    }

    const sql = deps.sql ?? getOrgPg().sql;
    const recordFire = deps.recordFire ?? defaultRecordFire;
    const ref = await getLoopRoutineRef(sql, routineId);
    if (!ref) return { handled: false, routineId }; // loop ended / not a loop routine

    const klass = outcome.error.class;
    const staleResumeTarget = isStaleResumeTargetError(outcome);
    const unavailableToolReference = isUnavailableToolReferenceError(outcome);
    // 1. Feed the EXISTING autoloop circuit (P0b). recordFire keys off activeWorkspaceId(),
    //    so run it under the loop's workspace (the delivery lives in the coord workspace).
    await runWithWorkspace(ref.workspaceId, () =>
      recordFire(
        ref.installSlug,
        ref.name,
        staleResumeTarget ? `resume-target-stale:${klass}` : `resume-turn-death:${klass}`,
        // WI-669: an infra-shaped death (rate-limit/transport/timeout) must not
        // ratchet the exponential backoff — classify; genuine turn deaths still count.
        classifyFireError(`resume-turn-death:${klass}`),
      ),
    ).catch((e) => log(`recordFire failed for loop ${routineId}: ${e instanceof Error ? e.message : e}`));

    // 2. Context-window deaths, stale resume targets and AUTH WALLS are terminal for THIS loop
    // instance. Re-arming the same warm transcript, missing native session, or rejected
    // credential at the normal cadence only repeats a known wall. Pause the routine so the
    // operator/overwatch path can arrange a fresh carry-respawn or corrected launch; all other
    // classes keep the existing retry-after-aware re-arm below. The classifier lives in the
    // shared turn taxonomy, but use a string comparison for context overflow so this protection
    // remains fail-safe while mixed-version operator processes roll forward to the new class.
    //
    // EI-21331509652694202: `auth` was the one class the shared taxonomy marks NOT retryable
    // ("401/403 — NOT retryable without new creds", turn-error.ts) that still landed in the
    // re-arm branch — and `computeDeathRearmMs` special-cases ONLY rate_limited/usage_limit, so
    // it fell through to the PLAIN interval. An auth-walled loop therefore respawned a CLI every
    // `intervalSec` forever, each process dying on the same rejected credential. Measured live on
    // loop-su-173ff9eb: 0 real turns across 18 minutes while the loop kept firing on a ~77s
    // cadence (60s interval + reconcile tick), the session reading `wakeable` the whole time.
    // Time cannot clear an org/subscription disable — only new credentials or a relaunch on a
    // different account can — so this pauses instead, exactly like the two walls beside it. The
    // wedge alert below still fires (auth is in SURFACE_TO_USER), so pausing removes the futile
    // respawn, never the notification.
    const contextOverflow = String(klass) === 'context_overflow';
    const authWall = String(klass) === 'auth';
    const malformedAuthorization = authWall && outcome.error.message.startsWith('malformed Authorization header:');
    let delayMs: number | undefined;
    let rearmed = false;
    let recovery: ContextOverflowRecoveryResult | undefined;
    if (contextOverflow || staleResumeTarget || authWall || unavailableToolReference) {
      const autoPause = deps.autoPause ?? defaultAutoPauseLoopRoutine;
      const pauseReason = unavailableToolReference
        ? 'loop-turn-outcome: stale tool reference (' +
          outcome.error.message +
          '); paused to prevent replaying the rejected transcript'
        : contextOverflow
        ? `loop-turn-outcome: context overflow (${outcome.error.message}); paused to prevent repeated oversized warm wakes`
        : authWall
          ? malformedAuthorization
            ? `loop-turn-outcome: malformed Authorization header (${outcome.error.message}); paused to prevent repeated resumes with a credential-construction error — inspect the bearer construction and relaunch with a valid credential`
            : `loop-turn-outcome: auth wall (${outcome.error.message}); paused to prevent repeated resumes into a rejected credential — needs new creds or a relaunch on a different account`
          : `loop-turn-outcome: stale resume target (${outcome.error.message}); paused to prevent repeated resumes of a missing session`;
      await autoPause(
        sql,
        routineId,
        pauseReason,
        'loop-turn-outcome',
      ).catch((e) => log(`terminal pause failed for loop ${routineId}: ${e instanceof Error ? e.message : e}`));
      if (contextOverflow) {
        recovery = await recoverContextOverflow(sql, ref, deps, now);
        log(
          `loop '${routineId}' context-overflow recovery: ${recovery.queued ? 'carry queued' : 'carry not queued'}${
            recovery.reason ? ` (${recovery.reason})` : ''
          }${recovery.rearmed ? ', cold loop re-armed' : ''}`,
        );
      }
    } else {
      // 429-aware re-arm (P1a) — only while still parked at 'infinity' (the dead turn).
      const intervalMs = (ref.intervalSec ?? 60) * 1000;
      delayMs = computeDeathRearmMs(outcome, intervalMs, now);
      rearmed = await rearmLoopAfterDeath(sql, routineId, delayMs, now).catch((e) => {
        log(`re-arm failed for loop ${routineId}: ${e instanceof Error ? e.message : e}`);
        return false;
      });
    }
    log(
      "loop '" +
        routineId +
        "' turn DIED (" +
        klass +
        ") → recorded error + " +
        (unavailableToolReference
          ? 'paused for stale tool reference'
          : contextOverflow
            ? 'paused for fresh-context recovery'
            : staleResumeTarget
              ? 'paused for stale resume target'
              : authWall
                ? 'paused for auth wall (needs new creds / different account)'
                : rearmed
                  ? `re-armed +${Math.round(delayMs! / 1000)}s`
                  : 'not re-armed (already advanced)'),
    );

    // 3. EI-13818 (c): raise a LOUD, debounced signal the first time this loop is observed
    // wedged. `outcome.error.surfaceToUser` is the shared taxonomy's own "the human must know
    // about this" flag (true for usage_limit/auth/permanent — the exact classes a clean-exit
    // wedge classifies into via resume-turn-outcome.ts). This loop is a `loop:arm`-owned routine
    // (target_owner_id non-null), which `autoloop-chronic-failure.ts`'s sweep DELIBERATELY
    // EXCLUDES from its own escalation — by design it expects the reconcile dead-owner guard's
    // `escalateDeadLoop` to cover loop:arm loops instead. But that guard only fires once the
    // owner is CONFIRMED unreachable; a rate-limited-but-alive owner (this bug's exact reported
    // scenario — a fleet ran leaderless ~16min, would've been ~4h) never trips it, so nothing
    // alerted. Fire on the FIRST wedge (not a chronic streak — post-fix, the 429-aware re-arm
    // above can space failures hours apart, so waiting for a streak could itself take hours),
    // debounced 6h per loop via the SAME watchdog-fires ledger + captureImprovement +
    // immediate overwatch-wake primitives `autoloop-chronic-failure.ts` already uses — no
    // parallel alerting system, just a second, narrower trigger into the same pipeline.
    //
    // EI-19381528967421062: `surfaceToUser` alone missed the class of death THIS bug
    // reported — a `rate_limited` streak (dead egress proxy, not a normal RPM bump) whose
    // computed re-arm delay ran ~50-100 minutes with no alert, because `rate_limited` is
    // deliberately excluded from `SURFACE_TO_USER` (a single isolated 429 SHOULD stay
    // silent). `chronicBackoff` widens the net for exactly the case the class-based gate
    // structurally cannot see: the delay computed for THIS fire is long enough that a human
    // needs to know regardless of class. See CHRONIC_BACKOFF_ALERT_FLOOR_MS's own doc for why.
    const chronicBackoff =
      !contextOverflow && !staleResumeTarget && !authWall && !outcome.error.surfaceToUser && delayMs! >= CHRONIC_BACKOFF_ALERT_FLOOR_MS;
    if (contextOverflow || staleResumeTarget || authWall || outcome.error.surfaceToUser || chronicBackoff) {
      try {
        const { claimWatchdogFire } = await import('../../pot/watchdog');
        const claimed = await claimWatchdogFire({
          workspaceId: ref.workspaceId,
          installSlug: `${ref.installSlug}::${routineId}`,
          source: 'loop-wedge-death',
          reason: `loop '${routineId}' (owner ${ref.targetOwnerId ?? 'unknown'}) turn died wedged: ${klass} — ${outcome.error.message}`,
          wakeAt: null,
          windowHours: 6,
        });
        if (claimed) {
          const { captureImprovement } = await import('../improvements/capture-core');
          await captureImprovement({
            title: `LOOP WEDGED: '${routineId}'@${ref.installSlug} turn died — ${klass} (owner ${ref.targetOwnerId ?? 'unknown'})`,
            kind: 'bug',
            severity: 'major',
            body:
              `A loop:arm-owned loop's resume turn died on a ${klass} the operator must know about: ` +
              `${outcome.error.message}\n\n` +
              // WI-2143683: `klass` is decided by scanning stderr+stdout TOGETHER, while the message
              // quoted above is taken from stderr alone whenever stderr is non-empty — so on a failed
              // exit whose provider wall went to stdout, the quoted text is NOT what produced the
              // class. Measured over the 191 alerts this filer has written: 41 of 59 `usage_limit`
              // ones quote a message containing no usage-limit signature at all, which reads as a
              // misclassification to every agent who claims one. Render the classifier's OWN evidence
              // whenever it differs, so the class can be judged instead of taken on trust.
              (outcome.error.classifiedOn
                ? `Classified \`${klass}\` on this line of the process output — the message above came ` +
                  `from a different stream and is NOT the classifier's evidence:\n  ${outcome.error.classifiedOn}\n\n`
                : '') +
              // WI-41683: the re-fire warning is only TRUE for the classes that re-arm.
              // contextOverflow and staleResumeTarget PAUSE the loop instead (the bracket
              // note below says so), so telling that reader "every wake risks re-firing"
              // contradicts the same body two sentences later and sends them looking for a
              // wake-loop that was already stopped. Give each class the residue it actually
              // has, and — for the paused ones — the criterion that CLOSES the item, since
              // by the time anyone reads it the answer is usually "already resolved".
              (unavailableToolReference
                ? 'The loop was paused after the provider rejected its saved tool reference: ' +
                  outcome.error.message +
                  '. Resume from a fresh session using the durable carry/checkpoint after correcting or restoring the available tool surface. Check this owner’s claims and fleet-leader state for stranded work.'
                : contextOverflow || staleResumeTarget
                ? `The loop was PAUSED by a terminal guard, so it is NOT re-firing on a cadence and there ` +
                  `is no wake-loop left to clear. The residue to check is STRANDED WORK, because this ` +
                  `owner's session is gone: does owner ${ref.targetOwnerId ?? 'unknown'} still hold claims ` +
                  `(work_items:list { assignee }), and was it a FLEET LEADER whose fleet is now running ` +
                  `leaderless (coord:presence / fleet:assignments)? If the claims are already released and ` +
                  `no fleet is leaderless, the condition this alert describes is over — close the item as ` +
                  `already-resolved rather than re-investigating the loop.`
                : malformedAuthorization
                ? `This loop was PAUSED because its Authorization header could not be encoded. This is ` +
                  `a credential-construction error, not a provider usage cap; do not wait for a reset. ` +
                  `Inspect the bearer construction for text accidentally placed in the credential and ` +
                  `relaunch with a valid credential/session.`
                : authWall
                ? `The loop was PAUSED by an auth-wall terminal guard, so it is NOT re-firing on a ` +
                  `cadence. The owner needs new credentials or a relaunch on a different account before ` +
                  `resuming it. Check this owner's claims and fleet-leader state; if no claims remain and ` +
                  `no fleet is leaderless, close the item as already resolved.`
                : `This loop wakes its owner session on a fixed cadence — while wedged ` +
                  `(rate-limited/capped/auth-locked), every wake risks re-firing into the same wall. The ` +
                  `fire-gate + 429-aware re-arm (loop-turn-outcome.ts) are backing off automatically, but ` +
                  `if this owner is a FLEET LEADER the fleet may be running leaderless until it clears. ` +
                  `Check sessions:read / coord:presence for owner ${ref.targetOwnerId ?? 'unknown'}; if it ` +
                  `is a fleet leader, consider relaunching leadership on another account/session rather ` +
                  `than waiting out the cap.`) +
              (contextOverflow
                ? ` [context-overflow terminal guard: the loop was paused instead of re-arming the same ` +
                  `oversized warm transcript; ${
                    recovery?.queued
                      ? 'a carry-respawn was queued and the loop will resume cold.'
                      : `recovery was not queued${recovery?.reason ? ` (${recovery.reason})` : ''}.`
                  }]`
                : unavailableToolReference
                ? ' [stale-tool-reference terminal guard: the provider rejected a saved tool reference absent from the current tool surface; the loop was paused instead of replaying the same transcript.]'
                : malformedAuthorization
                ? ` [malformed-authorization terminal guard: the header value could not be encoded; do not wait for a provider reset. Inspect the credential-construction path and relaunch with a valid credential.]`
                : authWall
                ? ` [auth-wall terminal guard: the loop was paused; new credentials or a relaunch on a different account are required before resuming.]`
                : staleResumeTarget
                ? ` [stale-resume-target terminal guard: the loop was paused instead of re-arming a ` +
                  `missing native session; relaunch or rebind the owner before resuming the loop.]`
                : chronicBackoff
                ? ` [chronic-backoff trigger: ${klass} is normally auto-absorbed silently, but the computed ` +
                  `re-arm delay for this fire was ${Math.round(delayMs! / 60_000)}min — well past a normal ` +
                  `transient wait, so this alerted despite the class alone saying "handle silently".]`
                : ''),
            scope: `harness:${ref.installSlug}`,
            foundDuring: 'loop-turn-outcome resume-turn wedge classification (EI-13818/EI-19381528967421062)',
          });
          try {
            const { requestOverwatchWake } = await import('../../overwatch/wake-bridge');
            const { resolvePotHomeSlug } = await import('../../pot/wake');
            const wakeHarness = resolvePotHomeSlug(ref.installSlug, undefined);
            if (wakeHarness) {
              await requestOverwatchWake({
                reason: `LOOP WEDGED: '${routineId}'@${ref.installSlug} (owner ${ref.targetOwnerId ?? 'unknown'}) — ${klass}, observation filed`,
                harness: wakeHarness,
                workspaceId: ref.workspaceId,
              });
            }
          } catch (e) {
            log(`overwatch wake failed for wedged loop ${routineId} (observation still filed): ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        log(`wedge-alert failed for loop ${routineId} (fail-soft): ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      handled: true,
      routineId,
      class: klass,
      rearmedMs: rearmed ? delayMs : undefined,
      ...(recovery
        ? {
            recoveryQueued: recovery.queued,
            recoveryRearmed: recovery.rearmed,
            ...(recovery.reason ? { recoveryReason: recovery.reason } : {}),
          }
        : {}),
    };
  } catch (e) {
    log(`handler failed (fail-soft): ${e instanceof Error ? e.message : e}`);
    return { handled: false };
  }
}

// ── Registration (module side-effect, mirroring lock-grant-bridge's reconciler) ─────────
// Wire this handler into the await pump so every resume-headless turn's exit is observed.
// Fire-and-forget: the pump's onResumeTurnExit is sync (a child 'close' listener), so we
// kick the async handler and never block the close.
registerResumeTurnOutcomeHandler((d, exit) => {
  void handleLoopResumeTurnExit(d, exit);
});
