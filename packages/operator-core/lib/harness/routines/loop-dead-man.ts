/**
 * Loop dead-man guard — bound a runaway / forgotten / permanently-dead loop
 * (loop-wake-rate-limit-robustness-2026-06-23 P2a).
 *
 * The gap (agent-insights/loop-wake-turn-deaths-recorded-as-delivered #6): there is no
 * max-iterations / max-duration / dead-man's-switch, so a loop armed by a session that then
 * dies permanently is re-armed forever by the stuck-park backstop. This adds an OPTIONAL
 * upper bound — `maxFires` (total wake attempts) and/or `maxDurationSec` (wall-clock since
 * arm) — that auto-pauses the loop when crossed (the time/iteration sibling of the existing
 * cost-cap auto-pause, mirroring `checkLoopCostCap`).
 *
 * Config rides the routine's `payload_template` (exactly like `costCapCents`), and the live
 * fire count rides `metadata.fire_count` — so NO migration / new columns (reuse-first: extend
 * the existing jsonb seams rather than widen the routine table). No cap configured ⇒ zero
 * reads, byte-identical to today.
 *
 * EI-7613 — the max-duration clock must measure from the LATEST arm, not the routine row's
 * `created_at`. `materializeLoop` re-arms an EXISTING loop via `upsertRoutine`'s
 * `INSERT ... ON CONFLICT (id) DO UPDATE` (routines-runtime.ts) — an UPDATE never touches
 * `created_at` (it's only set by the true INSERT branch), so a loop armed on day 1 and
 * re-armed on day 2 with a FRESH `maxDurationSec` still measured its duration since day 1: the
 * re-armed loop was dead on arrival, its very first fire immediately breaching a bound that
 * had not actually elapsed since the re-arm. `stampLoopArmedAt` records the true latest-arm
 * instant in `metadata.armed_at` (mirrors the `fire_count` seam — no migration); the dead-man
 * read below prefers it, falling back to `created_at` for a loop armed before this fix ran.
 *
 * EI-19339729634604096 — `maxFires` gets the SAME re-arm fix as `maxDurationSec`, for the
 * identical reason: `metadata.fire_count` is a LIFETIME counter (bumped by every fire since the
 * routine row was first created, never reset by a re-arm), so comparing it directly to a
 * freshly-armed `maxFires` silently auto-paused a loop on its very first post-re-arm fire
 * whenever the session had already fired more times, ever, than the new bound — exactly the
 * dead-on-arrival failure EI-7613 fixed for duration, just left unfixed for fires. `maxFires` is
 * documented (and every sibling dead-man bound behaves) as "since this arm", so the lifetime
 * counter was never the right comparison. `stampLoopArmedAt` now ALSO snapshots the fire count
 * AT arm time into `metadata.fire_count_at_arm` (fresh arm and re-arm alike, same UPDATE, same
 * no-migration jsonb seam), and the dead-man read below compares `fire_count - fire_count_at_arm`
 * (fires SINCE this arm) against `maxFires` — never the raw lifetime total. A loop armed before
 * this fix ran has no `fire_count_at_arm` yet and falls back to 0 (baseline = "no fires yet
 * since an unknown arm"), which is the safe direction: it may undercount fires-since-arm by the
 * ones that happened before the first stamp, never overcount into a spurious breach.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { autoPauseLoopRoutine } from './loop-cost-cap';
import type { AttentionNotifyInput } from '../../attention-notify';
import { getModes } from '../../modes/store';
import { modeById } from '../../modes/registry';

/**
 * Pure dead-man decision. Duration is checked first (a forgotten loop is the headline case).
 * A null / non-positive bound is "no bound". `fireCount` is the count of PRIOR fires SINCE THIS
 * LOOP'S MOST RECENT ARM (the caller is responsible for subtracting the arm-time baseline —
 * see `checkLoopDeadMan` — EI-19339729634604096; this pure function has no notion of "arm" at
 * all, it just compares whatever count it is given), so `>= maxFires` withholds the
 * (maxFires+1)-th SINCE-ARM fire — exactly `maxFires` fires occur per arm.
 */
export function evaluateDeadManGuard(input: {
  armedAtMs: number;
  nowMs: number;
  fireCount: number;
  maxFires?: number | null;
  maxDurationSec?: number | null;
}): { breach: boolean; reason?: string } {
  const { armedAtMs, nowMs, fireCount, maxFires, maxDurationSec } = input;
  if (maxDurationSec != null && maxDurationSec > 0 && nowMs - armedAtMs > maxDurationSec * 1000) {
    return { breach: true, reason: `max-duration ${Math.round((nowMs - armedAtMs) / 1000)}s > ${maxDurationSec}s (since arm)` };
  }
  if (maxFires != null && maxFires > 0 && fireCount >= maxFires) {
    return { breach: true, reason: `max-fires ${fireCount} >= ${maxFires} (since arm)` };
  }
  return { breach: false };
}

/**
 * Does this owner hold an AUTONOMY posture (EI-19899671638499010)?
 *
 * Anchored to the registry's `axis` PROPERTY, never to a list of mode-id spellings — a new
 * autonomy mode must be covered the day it is added, not the day someone remembers to extend
 * a string list here. (`drain` and the other overlays are not autonomy themselves; the registry
 * documents that a drain also sets the autonomy axis, so such a session still matches.)
 *
 * An UNKNOWN mode id counts as autonomous. That is deliberate and it is the whole cost
 * asymmetry of this bug: a spurious page costs one notification, while a missed one costs DAYS
 * of a silently-halted agent (measured: 4 days, plan advanced zero items). An unrecognized
 * posture is not evidence of "not autonomous", so it must not buy silence.
 */
export function hasAutonomyPosture(modes: ReadonlyArray<{ mode: string }>): boolean {
  return modes.some((m) => {
    const def = modeById(m.mode);
    return def == null || def.axis === 'autonomy';
  });
}

export interface LoopDeadManDeps {
  autoPause?: typeof autoPauseLoopRoutine;
  /** Injectable for tests; defaults to the real standing-modes read (harness_shared.agent_modes). */
  getModes?: typeof getModes;
  /**
   * Injectable for tests; defaults to the real OWNER page (EI-19899671638499010).
   *
   * Imported dynamically at call time, matching `stalled-loops-guard.ts`: `attention-notify`
   * pulls in the push/SSE transports, and this gate is consulted on the loop-fire path, so it
   * must not carry them just to page on the rare dead-man breach.
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
}

/**
 * The dead-man gate the loop fire consults BEFORE waking. No bound configured ⇒ never breaches
 * (zero reads). With a bound: read the loop's arm time (created_at) + live fire count and, on
 * breach, auto-pause the routine and report it so the fire is withheld.
 */
export async function checkLoopDeadMan(
  input: { sql?: Sql; routineId: string; maxFires?: number | null; maxDurationSec?: number | null; nowMs?: number },
  deps: LoopDeadManDeps = {},
  // `escalated` is OPTIONAL on purpose: every existing caller reads only `breach`/`reason`, and a
  // required field here would strand every fixture that constructs this shape (the trap CLAUDE.md
  // documents under lint:required-field-strands).
): Promise<{ breach: boolean; reason?: string; escalated?: boolean }> {
  const hasFires = input.maxFires != null && input.maxFires > 0;
  const hasDuration = input.maxDurationSec != null && input.maxDurationSec > 0;
  if (!hasFires && !hasDuration) return { breach: false };

  const db = input.sql ?? getOrgPg().sql;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;
  const nowMs = input.nowMs ?? Date.now();

  const rows = await db<
    Array<{
      armed_ms: string | number | null;
      fire_count: string | number | null;
      fire_count_at_arm: string | number | null;
      target_owner_id: string | null;
      workspace_id: string | null;
    }>
  >`
    SELECT (EXTRACT(EPOCH FROM COALESCE((metadata->>'armed_at')::timestamptz, created_at)) * 1000)::bigint AS armed_ms,
           COALESCE((metadata->>'fire_count')::int, 0)         AS fire_count,
           COALESCE((metadata->>'fire_count_at_arm')::int, 0)  AS fire_count_at_arm,
           target_owner_id,
           workspace_id
      FROM harness_shared.routines
     WHERE id = ${input.routineId}`;
  const armedAtMs = Number(rows[0]?.armed_ms ?? nowMs);
  const fireCountTotal = Number(rows[0]?.fire_count ?? 0);
  const fireCountAtArm = Number(rows[0]?.fire_count_at_arm ?? 0);
  // EI-19339729634604096 — fires SINCE THIS ARM, not the lifetime total. Clamp at 0: a loop
  // armed before the fire_count_at_arm stamp existed reads baseline 0, and if its lifetime
  // count somehow undershoots that (should not happen, but never let a negative delta subtract
  // fires) the max() keeps the guard from ever going negative.
  const fireCount = Math.max(0, fireCountTotal - fireCountAtArm);

  const verdict = evaluateDeadManGuard({
    armedAtMs,
    nowMs,
    fireCount,
    maxFires: input.maxFires,
    maxDurationSec: input.maxDurationSec,
  });
  if (!verdict.breach) return verdict;

  await autoPause(db, input.routineId, `dead-man guard: ${verdict.reason}`);

  // EI-19899671638499010: page the OWNER when the session we just silenced was running under a
  // registered AUTONOMY posture.
  //
  // This is the only instant where the fix is cheap. The system is still executing, and it holds
  // BOTH facts at once — that this loop is being stopped, and who owned it. A moment later the
  // session is inert and every downstream detector is unreachable, because the one warning built
  // for this state (`coord:orient`'s wakeSourceLostWarning) is delivered on a wake, and a wake is
  // exactly what no longer happens. A detector whose trigger requires the liveness whose absence
  // it reports can only ever reach an agent that does not need it.
  //
  // Measured (su-1f7ee244, 2026-08-08): registered mode auto/ownerDirected, bound to an
  // owner-directed plan, ZERO turns for 4 days after `dead-man max-fires 12 >= 12`. The plan
  // advanced not one item; it restarted only because the owner typed into the session. Note the
  // asymmetry that makes this worth a page: the cap exists to bound a RUNAWAY loop, which wastes
  // tokens and is noticed in minutes — the failure it actually produced here was the exact
  // opposite, and cost days precisely because nothing was noisy.
  //
  // Non-autonomous loops stay silent: an interactive session that hits its own bound has a human
  // in front of it who will see the next turn, so paging would be noise.
  const ownerId = rows[0]?.target_owner_id ?? null;
  const workspaceId = rows[0]?.workspace_id ?? null;
  if (!ownerId || !workspaceId) return { ...verdict, escalated: false };

  // Wrapped whole: the pause above is the load-bearing write and has already committed. Neither
  // the modes read nor a downed push transport may turn a successful pause into a thrown fire.
  try {
    const readModes = deps.getModes ?? getModes;
    const modes = await readModes(workspaceId, ownerId, db);
    if (!hasAutonomyPosture(modes)) return { ...verdict, escalated: false };

    const notify =
      deps.notify ??
      (async (payload: AttentionNotifyInput) => {
        const { notifyAttention } = await import('../../attention-notify');
        await notifyAttention(payload);
      });
    await notify({
      kind: 'intervention',
      title: `Autonomous session ${ownerId} was just stopped by its dead-man bound — it cannot restart itself`,
      body:
        `Loop routine ${input.routineId} hit ${verdict.reason} and has been paused.\n\n` +
        `This session holds a registered autonomy posture (${modes.map((m) => m.mode).join(', ')}), so ` +
        `nothing else is going to wake it: a paused loop does not fire, and the warning designed to ` +
        `catch this state (coord:orient's wakeSourceLostWarning) is only ever delivered ON a wake. ` +
        `Until a human acts, this agent takes no further turns and any plan it was advancing stops ` +
        `where it is.\n\n` +
        `To bring it back: resume the session and re-arm its loop (loop:arm). If it should not have ` +
        `been bounded at all, re-arm without maxFires/maxDurationSec — those bounds exist to stop a ` +
        `RUNAWAY loop, and a silently halted one is the opposite failure.`,
      importance: 'urgent',
      workspaceId,
      data: { ownerId, routineId: input.routineId, reason: verdict.reason ?? '', modes: modes.map((m) => m.mode).join(',') },
    });
    return { ...verdict, escalated: true };
  } catch (e) {
    console.warn(
      `[loop-dead-man] owner page failed for ${ownerId} after ${verdict.reason}: ` +
        `${e instanceof Error ? e.message : e}`,
    );
    return { ...verdict, escalated: false };
  }
}

/**
 * Read the loop's live fire count (`metadata.fire_count`) — the number of PRIOR fires (0 when
 * never fired). The cold-auto wakeCount cadence (su-cold-auto-mode-2026-07-03 P-003/P-005)
 * stamps wakeCount = priorFireCount + 1 on a cold wake so the consumer's coldWakeMode can
 * recycle every Nth wake. Best-effort; 0 on any miss. Reuses the same jsonb seam as the
 * dead-man guard (no new column).
 */
export async function readLoopFireCount(sql: Sql | undefined, routineId: string): Promise<number> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ fire_count: string | number | null }>>`
    SELECT COALESCE((metadata->>'fire_count')::int, 0) AS fire_count
      FROM harness_shared.routines
     WHERE id = ${routineId}`;
  return Number(rows[0]?.fire_count ?? 0);
}

/**
 * EI-7613 — stamp the loop's LATEST arm instant (`metadata.armed_at`), called by
 * `materializeLoop` on EVERY `loop:arm` (a fresh arm and a re-arm alike). The dead-man
 * max-duration guard must measure "since arm" from the most recent arm — a re-arm goes
 * through `upsertRoutine`'s `ON CONFLICT DO UPDATE`, which never touches `created_at`, so
 * without this stamp a re-armed loop's clock kept running from the ORIGINAL arm and a fresh
 * `maxDurationSec` could breach instantly on the loop's very first post-re-arm fire. Mirrors
 * the `fire_count` seam (no migration, no new column). Best-effort: a stamp failure must
 * never fail the arm itself (the caller awaits this after the upsert has already succeeded).
 *
 * EI-19339729634604096 — ALSO snapshots `metadata.fire_count_at_arm` = the routine's lifetime
 * `fire_count` AS OF THIS ARM, in the SAME statement (the RHS `jsonb_build_object` reads the
 * pre-UPDATE `metadata` — a single-statement read-then-write, so there is no read/write race
 * with a concurrent `incrementLoopFireCount`). This is the `maxFires` sibling of `armed_at`:
 * `fire_count` itself is a lifetime counter that a re-arm never resets, so a fresh `maxFires`
 * bound must be compared against fires SINCE THIS BASELINE, not the lifetime total — exactly
 * the class of bug EI-7613 already fixed for `maxDurationSec`, left unfixed for `maxFires`
 * until now. `checkLoopDeadMan` reads this back and subtracts it from the live `fire_count`.
 */
export async function stampLoopArmedAt(sql: Sql | undefined, routineId: string, atMs?: number): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  const iso = new Date(atMs ?? Date.now()).toISOString();
  await db`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'armed_at', ${iso}::text,
             'fire_count_at_arm', COALESCE((metadata->>'fire_count')::int, 0)
           )
     WHERE id = ${routineId}`;
}

/**
 * Bump the loop's live fire counter (`metadata.fire_count`) after a fire. Single-flight per
 * loop (parked at 'infinity' while a turn runs), so no concurrent-increment race. Stored as a
 * jsonb number; read back via `(metadata->>'fire_count')::int`.
 *
 * P-024 (review-system-rework-reduction-2026-09-23): the SAME statement also stamps
 * `metadata.last_delivered_at` — the instant the loop last REACHED its owner. The routine
 * row's `last_fired_at` cannot answer that: `claimDueRoutine` stamps it on every CLAIM,
 * including claims whose wake the await-suppression guard then withholds. The blocking-await
 * heartbeat anchors on this stamp so a session parked on an owner answer gets one slow
 * liveness fire per heartbeat period instead of one per interval.
 */
export async function incrementLoopFireCount(sql: Sql | undefined, routineId: string): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  await db`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'fire_count', COALESCE((metadata->>'fire_count')::int, 0) + 1,
                         'last_delivered_at', to_jsonb(now())
                       )
     WHERE id = ${routineId}`;
}

/**
 * Read `metadata.last_delivered_at` (see `incrementLoopFireCount`) as epoch ms. `null` when
 * the loop has never delivered since this stamp existed, or on any read failure — callers
 * treat `null` as "unknown" and fall back to their pre-heartbeat behavior.
 */
export async function readLoopLastDeliveredAtMs(sql: Sql | undefined, routineId: string): Promise<number | null> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ last_delivered_at: string | null }>>`
    SELECT metadata->>'last_delivered_at' AS last_delivered_at
      FROM harness_shared.routines
     WHERE id = ${routineId}`;
  const raw = rows[0]?.last_delivered_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
