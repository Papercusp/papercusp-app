/**
 * Pause TTL + auto-resume for RELEASE-GROUP routines, and the standing
 * "GATE PAUSED" banner every gate status surface renders while one is held.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────
 * `routines:set { active:false }` has required a `reason` since
 * EI-18654017982759582, and `routines:list` surfaces `{ reason, by, at }` since
 * EI-19336000265007219. So a deliberate pause is ATTRIBUTED. It is still
 * UNBOUNDED, and nothing announces it on the surfaces a responder actually reads
 * during an incident.
 *
 * Measured (11-day red-gate audit, 2026-08-31): the green-checkpoint routine was
 * deliberately paused for 99 hours across 14 windows — 37% of the streak —
 * including single windows of 42h17m and 21h44m. No TTL, no auto-resume, and no
 * mention of the hold in the watchdog messages, so "the gate is OFF" was
 * indistinguishable from "the gate is FAILING" to everyone reading them. Both
 * halves of that are this module:
 *
 *   1. every release-group pause carries a FINITE expiry (default
 *      {@link DEFAULT_RELEASE_PAUSE_TTL_HOURS}h, overridable per-pause), and
 *      {@link sweepExpiredReleasePauses} — one step on the existing routines
 *      engine tick — auto-resumes it and records a notice when it lapses;
 *   2. {@link gatePausedBanner} is the ONE rendering of that hold, folded into
 *      the gate status surfaces so a paused gate can never read as a merely-red
 *      one.
 *
 * ── BACK-COMPAT (the rule, stated once) ────────────────────────────────────────
 * A pause row written before this module has no `expiresAtMs`. For a
 * RELEASE-GROUP routine such a legacy pause is treated as expiring at
 * `pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS` — i.e. exactly as if the default
 * TTL had been stamped when it was taken. That is the simpler of the two
 * candidate rules (the other being "N hours after this code deploys", which needs
 * a deploy-time baseline nothing durable records) and it is the safe one: a
 * legacy pause is by construction OLD, so it resumes on the first sweep instead
 * of buying itself another TTL window. A legacy pause with NO parseable
 * `pausedAtMs` is UNDATABLE and is never auto-resumed — it is reported, loudly,
 * as having no scheduled auto-resume, because inventing a start time for it
 * would be inventing the very evidence its absence is the problem.
 *
 * ── THE ONE EXCLUSION ──────────────────────────────────────────────────────────
 * The structured D-012/D-013 quiescence hold (`CHECKPOINT_QUIESCENCE_PAUSE_MARKER`)
 * is NOT TTL'd and NOT swept here. It already has a purpose-built recovery path
 * that is strictly better than a timer — `decidePausedGreenCheckpointRecovery` in
 * release/green-stall-watchdog.ts re-arms it the moment its serializer owner goes
 * non-live, and deliberately leaves it alone while that owner is live. Expiring it
 * on a clock would race the release serializer it exists to protect. Because it is
 * excluded from stamping too, its banner honestly reports "no scheduled
 * auto-resume" rather than promising one that will not come.
 *
 * Scheduling: this adds NO new mechanism. It is a bounded sweep on the existing
 * durable `routinesTick` (repo rule: no bare setInterval, no third scheduler).
 */
import type { Sql } from 'postgres';
import { CHECKPOINT_QUIESCENCE_PAUSE_MARKER } from '../../release/checkpoint-serializer-authority';

/** The routine group whose pauses are release-critical and therefore always finite. */
export const RELEASE_ROUTINE_GROUP = 'release';

/**
 * Default lifetime of a release-group pause. Four hours: long enough to cover the
 * delicate manual operations these pauses exist for (a deploy-checkout surgery, a
 * frozen-candidate repair, a coordinated host restart — all measured in tens of
 * minutes), and short enough that the 21h and 42h windows the audit found cannot
 * recur silently. A caller who genuinely needs longer passes `pauseTtlHours`; the
 * point is not that four hours is right for every hold, it is that SOME finite
 * number is always recorded.
 */
export const DEFAULT_RELEASE_PAUSE_TTL_HOURS = 4;
export const DEFAULT_RELEASE_PAUSE_TTL_MS = DEFAULT_RELEASE_PAUSE_TTL_HOURS * 3_600_000;

/** Rows scanned per sweep pass. The release group holds ~12 rows; the cap is a blast-radius bound, not a page size. */
const SWEEP_ROW_CAP = 200;

/** The deliberate-pause record as persisted at `routines.metadata.pause`. */
export interface RoutinePauseRecord {
  /** True when `metadata.pause` was present at all (even if every field was empty). */
  present: boolean;
  reason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
  /** The stamped finite expiry, when the writer recorded one. */
  expiresAtMs: number | null;
  /** True when the record predates TTL stamping (present, but no `expiresAtMs`). */
  legacy: boolean;
}

const EMPTY_PAUSE: RoutinePauseRecord = {
  present: false,
  reason: null,
  pausedBy: null,
  pausedAtMs: null,
  expiresAtMs: null,
  legacy: false,
};

const finiteMs = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Parse `routines.metadata.pause` without trusting its shape. Accepts the same
 * field aliases the paused-gate watchdog already tolerates, so one legacy row does
 * not read as two different pauses depending on which reader looked at it.
 */
export function readRoutinePause(value: unknown): RoutinePauseRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_PAUSE;
  const rec = value as Record<string, unknown>;
  const expiresAtMs = finiteMs(rec.expiresAtMs ?? rec.pauseExpiresAtMs);
  return {
    present: true,
    reason: str(rec.reason ?? rec.pauseReason),
    pausedBy: str(rec.pausedBy ?? rec.by ?? rec.owner),
    pausedAtMs: finiteMs(rec.pausedAtMs ?? rec.pausedAt ?? rec.atMs ?? rec.at),
    expiresAtMs,
    legacy: expiresAtMs == null,
  };
}

/** Is this the structured D-012/D-013 serializer quiescence hold (see the module header's ONE EXCLUSION)? */
export function isCheckpointQuiescencePause(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(CHECKPOINT_QUIESCENCE_PAUSE_MARKER);
}

/** Does this routine belong to the group whose pauses must always be finite? */
export function isReleaseGroup(groupSlug: string | null | undefined): boolean {
  return groupSlug === RELEASE_ROUTINE_GROUP;
}

/**
 * WRITE side: the `expiresAtMs` to stamp when a pause is taken, or null when this
 * pause is not TTL-governed (not release-group, or the excluded quiescence hold).
 *
 * `ttlHours` must be finite and positive; anything else falls back to the default
 * rather than producing an infinite hold — for a release-group routine "always
 * finite" is the invariant, so a malformed override must not be able to defeat it.
 */
export function resolvePauseExpiryMs(opts: {
  groupSlug: string | null | undefined;
  pausedAtMs: number;
  ttlHours?: number | null;
  reason?: string | null;
}): number | null {
  if (!isReleaseGroup(opts.groupSlug)) return null;
  if (isCheckpointQuiescencePause(opts.reason ?? null)) return null;
  const hours =
    typeof opts.ttlHours === 'number' && Number.isFinite(opts.ttlHours) && opts.ttlHours > 0
      ? opts.ttlHours
      : DEFAULT_RELEASE_PAUSE_TTL_HOURS;
  return Math.round(opts.pausedAtMs + hours * 3_600_000);
}

/**
 * READ/ENFORCE side: when this pause lapses, applying the legacy rule from the
 * module header. Null means "no auto-resume is scheduled" — and callers must
 * render that as the absence it is, never as "not yet".
 */
export function effectivePauseExpiryMs(
  pause: RoutinePauseRecord,
  opts: { groupSlug?: string | null } = {},
): number | null {
  if (!pause.present) return null;
  if (pause.expiresAtMs != null) return pause.expiresAtMs;
  if (!isReleaseGroup(opts.groupSlug)) return null;
  if (isCheckpointQuiescencePause(pause.reason)) return null;
  if (pause.pausedAtMs == null) return null; // undatable legacy pause — see the module header
  return pause.pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS;
}

export type ReleasePauseExpiryVerdict =
  | {
      expired: false;
      reason: 'not-paused' | 'not-release-group' | 'serializer-quiescence-hold' | 'undatable' | 'not-yet';
      expiresAtMs: number | null;
    }
  | { expired: true; expiresAtMs: number; overdueMs: number; legacy: boolean };

/** PURE: has this release-group pause outlived its (explicit or legacy-default) TTL? */
export function classifyReleasePauseExpiry(
  input: { active: boolean | null; groupSlug: string | null; pause: RoutinePauseRecord },
  nowMs: number,
): ReleasePauseExpiryVerdict {
  if (input.active !== false || !input.pause.present) return { expired: false, reason: 'not-paused', expiresAtMs: null };
  if (!isReleaseGroup(input.groupSlug)) return { expired: false, reason: 'not-release-group', expiresAtMs: null };
  if (isCheckpointQuiescencePause(input.pause.reason)) {
    return { expired: false, reason: 'serializer-quiescence-hold', expiresAtMs: null };
  }
  const expiresAtMs = effectivePauseExpiryMs(input.pause, { groupSlug: input.groupSlug });
  if (expiresAtMs == null) return { expired: false, reason: 'undatable', expiresAtMs: null };
  if (nowMs <= expiresAtMs) return { expired: false, reason: 'not-yet', expiresAtMs };
  return { expired: true, expiresAtMs, overdueMs: nowMs - expiresAtMs, legacy: input.pause.legacy };
}

const stamp = (ms: number | null): string => (ms == null ? 'unknown' : new Date(ms).toISOString());

/**
 * PURE: the standing banner every gate status surface renders while the routine is
 * held. Returns null when there is no deliberate hold, so a caller can render it
 * unconditionally and get exactly nothing on a healthy gate.
 *
 * The auto-resume clause is deliberately three-valued rather than two: a hold with
 * no scheduled auto-resume must SAY so, because "GATE PAUSED …" with the clause
 * silently omitted reads as "it will come back on its own" — which is the belief
 * that let a 42-hour window pass unremarked.
 */
export function gatePausedBanner(opts: {
  routineName: string;
  installSlug?: string | null;
  groupSlug?: string | null;
  pause: RoutinePauseRecord;
  nowMs: number;
}): string | null {
  if (!opts.pause.present) return null;
  const where = opts.installSlug ? ` on ${opts.installSlug}` : '';
  const heldMs = opts.pause.pausedAtMs != null ? Math.max(0, opts.nowMs - opts.pause.pausedAtMs) : null;
  const heldFor = heldMs != null ? ` (held ~${Math.max(1, Math.round(heldMs / 60_000))}m)` : '';
  const expiresAtMs = effectivePauseExpiryMs(opts.pause, { groupSlug: opts.groupSlug });
  const resume =
    expiresAtMs == null
      ? isCheckpointQuiescencePause(opts.pause.reason)
        ? ' — NO timed auto-resume: this is the structured D-012/D-013 serializer quiescence hold, ' +
          'which is re-armed when its serializer owner goes non-live, not on a clock.'
        : ' — ⚠ NO auto-resume is scheduled; NOTHING will re-arm it. Resume it deliberately with ' +
          `routines:set { name: "${opts.routineName}", active: true }.`
      : opts.nowMs > expiresAtMs
        ? ` — its ${opts.pause.legacy ? 'legacy-default ' : ''}TTL LAPSED at ${stamp(expiresAtMs)}; ` +
          'the routines engine auto-resumes it on the next tick.'
        : ` — auto-resumes ${stamp(expiresAtMs)}${opts.pause.legacy ? ' (legacy pause: default release TTL applied)' : ''}.`;
  return (
    `⛔ ${opts.routineName.toUpperCase()} PAUSED${where} since ${stamp(opts.pause.pausedAtMs)} ` +
    `by ${opts.pause.pausedBy ?? '(unknown)'} (${opts.pause.reason ?? 'no reason recorded'})${heldFor}${resume} ` +
    'A PAUSED gate is not a FAILING gate: no verdict is coming, so any red counters below describe an older run.'
  );
}

/** One routine this sweep re-armed. */
export interface ReleasePauseAutoResume {
  workspaceId: string;
  installSlug: string;
  name: string;
  expiresAtMs: number;
  overdueMs: number;
  legacy: boolean;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
}

interface ReleasePauseRow {
  workspace_id: string;
  install_slug: string;
  name: string;
  active: boolean | null;
  group_slug: string | null;
  pause: unknown;
}

/**
 * One bounded sweep pass: auto-resume every release-group routine whose deliberate
 * pause has outlived its TTL, and record a notice for each.
 *
 * Fail-soft throughout — this rides the routines engine tick, so a bad row, a dead
 * notification rail or an unreadable pause must never break the tick that fires
 * git-sync. The re-arm UPDATE is guarded on the EXACT pause blob it classified
 * (jsonb equality is order-insensitive), so a pause that changed between the read
 * and the write is left for the next pass instead of being clobbered — the same
 * optimistic-concurrency idiom the serializer re-arm in green-stall-watchdog uses.
 */
export async function sweepExpiredReleasePauses(
  sql: Sql,
  opts: { nowMs?: number; limit?: number; notify?: boolean } = {},
): Promise<ReleasePauseAutoResume[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? SWEEP_ROW_CAP;
  const resumed: ReleasePauseAutoResume[] = [];

  let rows: ReleasePauseRow[];
  try {
    rows = await sql<ReleasePauseRow[]>`
      SELECT workspace_id, install_slug, name, active, group_slug, metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE group_slug = ${RELEASE_ROUTINE_GROUP}
         AND active = false
         AND metadata ? 'pause'
       LIMIT ${limit}`;
  } catch (e) {
    console.warn(`[release-pause-ttl] scan failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return resumed;
  }

  for (const row of rows) {
    const pause = readRoutinePause(row.pause);
    const verdict = classifyReleasePauseExpiry(
      { active: row.active, groupSlug: row.group_slug, pause },
      nowMs,
    );
    if (!verdict.expired) continue;

    try {
      const lastPause = {
        ...((row.pause as Record<string, unknown> | null) ?? {}),
        resumedAtMs: nowMs,
        autoResumedAtMs: nowMs,
        autoResumedBy: 'release-pause-ttl',
        autoResumeReason: verdict.legacy ? 'legacy-pause-default-ttl-lapsed' : 'pause-ttl-lapsed',
        expiresAtMs: verdict.expiresAtMs,
      };
      const updated = await sql<{ install_slug: string }[]>`
        UPDATE harness_shared.routines r
           SET active = true,
               next_fire_at = now(),
               metadata = jsonb_set(
                 COALESCE(r.metadata, '{}'::jsonb) - 'pause',
                 '{lastPause}',
                 ${JSON.stringify(lastPause)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE r.workspace_id = ${row.workspace_id}
           AND r.install_slug = ${row.install_slug}
           AND r.name = ${row.name}
           AND r.group_slug = ${RELEASE_ROUTINE_GROUP}
           AND r.active = false
           AND r.metadata->'pause' = ${JSON.stringify(row.pause)}::text::jsonb
        RETURNING r.install_slug`;
      if (!updated[0]) continue; // raced — the next pass classifies the new state

      const record: ReleasePauseAutoResume = {
        workspaceId: row.workspace_id,
        installSlug: row.install_slug,
        name: row.name,
        expiresAtMs: verdict.expiresAtMs,
        overdueMs: verdict.overdueMs,
        legacy: verdict.legacy,
        pauseReason: pause.reason,
        pausedBy: pause.pausedBy,
        pausedAtMs: pause.pausedAtMs,
      };
      resumed.push(record);
      console.warn(
        `[release-pause-ttl] AUTO-RESUMED ${row.install_slug}/${row.name} — pause by ${pause.pausedBy ?? '(unknown)'} ` +
          `("${pause.reason ?? 'no reason recorded'}") lapsed at ${stamp(verdict.expiresAtMs)} ` +
          `(${Math.round(verdict.overdueMs / 60_000)}m overdue${verdict.legacy ? ', legacy pause / default TTL' : ''})`,
      );

      if (opts.notify !== false) await notifyAutoResume(record);
    } catch (e) {
      console.warn(
        `[release-pause-ttl] auto-resume failed for ${row.install_slug}/${row.name} (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return resumed;
}

/**
 * The notice. Same primitive every other routine-lifecycle event here uses
 * (`notifyAttention*` from attention-notify) — deliberately NOT a new channel.
 * `notifyAttentionOnce` because a DBOS step retry must not deliver twice; the key
 * is the lapsed expiry, so a LATER pause on the same routine notifies again.
 */
// ─────────────────────────────────────────────────────────────────────────────
// LOOP STAND-DOWN (EI-22138154596110669) — the SAME "a deliberate pause must
// carry a finite expiry, and lapsing it must never depend on a human staying
// alive" pattern as the release-group pause above, applied to a fleet-wide
// engine-loop stand-down (`loop:standdown-all`, agent-tools/loop/standdown-all.ts).
//
// Motivation: a stand-down broadcast asserted "all engine loops are paused"
// (routines:set active:false, resumable) but had, by hand-calling routines:set
// a few times, actually touched only 2 of 26+ active loop-su-% rows — there was
// no dedicated bulk-pause tool for engine loops (routines:group-set bulk-pauses
// a routine GROUP, and loop-su-% rows are never group members). No expiry was
// stamped on the ad-hoc pause either, so the broadcast's sole resume authority
// dying would have stranded every paused loop indefinitely.
//
// UNLIKE a release-group pause, a stand-down pause is not scoped by
// `group_slug` and is ALWAYS finite (loop:standdown-all never accepts an
// open-ended hold) — so there is no group gating and no quiescence exclusion to
// replicate. It is scoped instead by a discriminating MARKER
// (`pause.standdownAll === true`) stamped only by loop:standdown-all itself.
//
// ⚠ THE MARKER IS LOAD-BEARING, not decorative. `loop:end` (deactivateLoop
// above) ALSO stamps `metadata.pause` on the routine it deactivates — a
// DELIBERATE, PERMANENT stop with no TTL. Sweeping every paused loop-su-% row
// the way the release sweep scans every paused release-group row would
// auto-REVIVE a loop its owner intentionally ended, which is a strictly worse
// bug than the one this section fixes. The marker turns "was this row paused BY
// THIS mechanism" into a positive check instead of an inferred default, so an
// ended loop's pause (no marker) is never a sweep candidate.
// ─────────────────────────────────────────────────────────────────────────────

/** The `metadata.pause` marker key `loop:standdown-all` stamps — the sweep's
 *  positive discriminator (see the section header above for why it must be
 *  positive rather than inferred from the mere presence of a pause). */
export const LOOP_STANDDOWN_MARKER = 'standdownAll';

/**
 * Does this RAW `metadata.pause` value carry the loop:standdown-all marker?
 * Takes the raw jsonb value (not `readRoutinePause`'s parsed record, which
 * intentionally drops unrecognized keys) so the marker survives untouched.
 * Never true for an ordinary per-loop pause (routines:set, loop:end) — only
 * for a bulk stand-down this module's own writer stamped.
 */
export function isLoopStanddownPause(rawPause: unknown): boolean {
  if (rawPause == null || typeof rawPause !== 'object' || Array.isArray(rawPause)) return false;
  return (rawPause as Record<string, unknown>)[LOOP_STANDDOWN_MARKER] === true;
}

/**
 * Does this stand-down cover the whole workspace rather than one fleet?
 * `loop:standdown-all` writes `fleetSlug` only for its fleet-scoped form, so
 * the absence of that key is the durable distinction. Keep this predicate on
 * the raw pause blob: `readRoutinePause` intentionally drops scope metadata.
 */
export function isWorkspaceWideLoopStanddownPause(rawPause: unknown): boolean {
  if (!isLoopStanddownPause(rawPause)) return false;
  if (rawPause == null || typeof rawPause !== 'object' || Array.isArray(rawPause)) return false;
  return !Object.prototype.hasOwnProperty.call(rawPause, 'fleetSlug');
}

/**
 * WRITE side for a stand-down pause: ALWAYS finite (unlike resolvePauseExpiryMs,
 * which returns null for anything outside the release group) — reuses the SAME
 * default constant and rounding rather than forking the math.
 */
export function resolveLoopStanddownExpiryMs(opts: { pausedAtMs: number; ttlHours?: number | null }): number {
  const hours =
    typeof opts.ttlHours === 'number' && Number.isFinite(opts.ttlHours) && opts.ttlHours > 0
      ? opts.ttlHours
      : DEFAULT_RELEASE_PAUSE_TTL_HOURS;
  return Math.round(opts.pausedAtMs + hours * 3_600_000);
}

export type FinitePauseExpiryVerdict =
  | { expired: false; reason: 'not-paused' | 'undatable' | 'not-yet'; expiresAtMs: number | null }
  | { expired: true; expiresAtMs: number; overdueMs: number; legacy: boolean };

/**
 * PURE, group-agnostic sibling of `classifyReleasePauseExpiry`: has this pause
 * outlived its (explicit or legacy-default) TTL, with no group/quiescence
 * gating? Every stand-down pause stamps `expiresAtMs` explicitly
 * (`resolveLoopStanddownExpiryMs` never returns null), so the legacy
 * (`pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS`) branch below only matters
 * defensively — a hand-edited or pre-this-module row with no `expiresAtMs`.
 */
export function classifyFinitePauseExpiry(pause: RoutinePauseRecord, nowMs: number): FinitePauseExpiryVerdict {
  if (!pause.present) return { expired: false, reason: 'not-paused', expiresAtMs: null };
  const expiresAtMs = pause.expiresAtMs ?? (pause.pausedAtMs != null ? pause.pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS : null);
  if (expiresAtMs == null) return { expired: false, reason: 'undatable', expiresAtMs: null };
  if (nowMs <= expiresAtMs) return { expired: false, reason: 'not-yet', expiresAtMs };
  return { expired: true, expiresAtMs, overdueMs: nowMs - expiresAtMs, legacy: pause.expiresAtMs == null };
}

const stampIso = (ms: number | null): string => (ms == null ? 'unknown' : new Date(ms).toISOString());

/**
 * The `loop:status` / fleet-health rendering of an active stand-down — the
 * loop-scoped analog of `gatePausedBanner` above. Returns null when the pause
 * is absent, so a caller can render it unconditionally. Callers must first
 * confirm `isLoopStanddownPause(rawPause)` before parsing + passing the record
 * here — this function does not itself re-check the marker.
 */
export function loopStanddownBanner(opts: { pause: RoutinePauseRecord; nowMs: number }): string | null {
  if (!opts.pause.present) return null;
  const heldMs = opts.pause.pausedAtMs != null ? Math.max(0, opts.nowMs - opts.pause.pausedAtMs) : null;
  const heldFor = heldMs != null ? ` (held ~${Math.max(1, Math.round(heldMs / 60_000))}m)` : '';
  const verdict = classifyFinitePauseExpiry(opts.pause, opts.nowMs);
  const resume =
    verdict.expiresAtMs == null
      ? ' — ⚠ NO auto-resume is scheduled (undatable pause); resume it deliberately with routines:set { active: true }.'
      : verdict.expired
        ? ` — its TTL LAPSED at ${stampIso(verdict.expiresAtMs)}; the routines engine auto-resumes it on the next tick.`
        : ` — auto-resumes ${stampIso(verdict.expiresAtMs)}.`;
  return (
    `⛔ STAND-DOWN ACTIVE since ${stampIso(opts.pause.pausedAtMs)} by ${opts.pause.pausedBy ?? '(unknown)'} ` +
    `(${opts.pause.reason ?? 'no reason recorded'})${heldFor}${resume}`
  );
}

/** One loop this sweep re-armed. */
export interface LoopStanddownAutoResume {
  workspaceId: string;
  installSlug: string;
  name: string;
  targetOwnerId: string | null;
  expiresAtMs: number;
  overdueMs: number;
  legacy: boolean;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
}

interface LoopStanddownRow {
  workspace_id: string;
  install_slug: string;
  name: string;
  target_owner_id: string | null;
  active: boolean | null;
  pause: unknown;
}

/**
 * Which owners are CURRENTLY held under an active `loop:standdown-all` — the
 * READ side of {@link LOOP_STANDDOWN_MARKER}, for automation that must not act
 * on a stood-down agent.
 *
 * WHY (EI-21451978219397190): during an owner-directed global stand-down,
 * "unacknowledged by the human" is the EXPECTED steady state — the owner is
 * deliberately away, which is the whole point of the pause. Any automation that
 * reads unacknowledged-by-human as a fault and goes hunting for a live agent to
 * drive it finds PAUSED agents and wakes them, so the pause itself manufactures
 * the wakes that defeat the pause. Consult this instead of re-deriving the
 * marker predicate, so the stand-down primitive stays the single source of
 * truth for "who is held".
 *
 * An EXPIRED stand-down is deliberately NOT reported: `sweepExpiredLoopStanddowns`
 * auto-resumes those, and reusing `classifyFinitePauseExpiry` here makes the hold
 * release at exactly the moment the loop does — one expiry notion, not two that
 * can disagree during the window between lapse and sweep.
 *
 * Fails OPEN (empty set) on a read error. This guard SUPPRESSES delivery, so a
 * scan failure must never silently strand escalations that nothing is pausing.
 */
export async function listLoopStanddownOwners(
  sql: Sql,
  opts: { workspaceId?: string | null; nowMs?: number; limit?: number; workspaceWideOnly?: boolean } = {},
): Promise<Set<string>> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? SWEEP_ROW_CAP;
  const workspaceId = opts.workspaceId ?? null;
  const held = new Set<string>();

  type HoldRow = Pick<LoopStanddownRow, 'target_owner_id' | 'pause'>;
  let rows: HoldRow[];
  try {
    rows = await sql<HoldRow[]>`
      SELECT target_owner_id, metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE reschedule_interval_sec IS NOT NULL
         AND active = false
         AND metadata->'pause'->>${LOOP_STANDDOWN_MARKER} = 'true'
         AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId})
       LIMIT ${limit}`;
  } catch (e) {
    console.warn(
      `[loop-standdown] hold scan failed (non-fatal, failing open): ${e instanceof Error ? e.message : String(e)}`,
    );
    return held;
  }

  for (const row of rows) {
    if (!row.target_owner_id) continue;
    if (opts.workspaceWideOnly && !isWorkspaceWideLoopStanddownPause(row.pause)) continue;
    if (classifyFinitePauseExpiry(readRoutinePause(row.pause), nowMs).expired) continue;
    held.add(row.target_owner_id);
  }
  return held;
}

/**
 * Is a WORKSPACE-WIDE `loop:standdown-all` currently in force? The gate for
 * automation that does not act ON an existing agent but CREATES new ones —
 * principally the fleet headcount governor.
 *
 * WHY THIS IS NOT `listLoopStanddownOwners(...).size > 0` (EI-23259368987233359):
 * two independent reasons, and each alone is sufficient.
 *
 *   1. WRONG QUESTION. That helper answers "which EXISTING owners are held", so
 *      it is keyed on owners that already exist. Repopulation opens members that
 *      do not exist yet and therefore appear in no held set, however complete
 *      that set is. The question here is workspace-level, not per-owner: "may
 *      anything be opened at all right now?"
 *   2. WRONG FAIL DIRECTION — the load-bearing half. `listLoopStanddownOwners`
 *      fails OPEN by design because it SUPPRESSES delivery: a scan failure there
 *      must never strand escalations that nothing is pausing. This guard is its
 *      mirror image — it AUTHORIZES SPAWNING — so failing open on a scan error
 *      silently re-creates the exact incident it exists to prevent (an
 *      owner-directed stand-down verified at zero sessions, after which the
 *      governor repopulated five members, four loops and four claims). It
 *      therefore fails CLOSED: on a read error the stand-down is ASSUMED ACTIVE
 *      and top-up is blocked. A blocked top-up is self-healing — the governor
 *      re-evaluates every tick and carries its own backoff — whereas an
 *      unwanted repopulation mid-stand-down is not self-healing at all.
 *
 * Two guards over the SAME marker with OPPOSITE fail directions is correct, not
 * an inconsistency to tidy away: the direction follows from whether the guard
 * SUPPRESSES an action or AUTHORIZES one. Do not refactor this into a delegation
 * to `listLoopStanddownOwners` — that would silently adopt its fail-open
 * behaviour and re-arm the trap while looking like pure deduplication.
 *
 * A FLEET-SCOPED stand-down deliberately does NOT satisfy this predicate: it is
 * a statement about one fleet's members, not an instruction to freeze every
 * controller in the workspace. Scoping that case belongs to the fleet's own
 * control_state, not here.
 *
 * Expiry reuses `classifyFinitePauseExpiry`, exactly as the owner-set read does,
 * so the hold releases at the same moment the loops themselves resume — one
 * expiry notion, not two that can disagree during the window between lapse and
 * sweep.
 */
export async function isWorkspaceWideLoopStanddownActive(
  sql: Sql,
  opts: { workspaceId?: string | null; nowMs?: number; limit?: number } = {},
): Promise<boolean> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? SWEEP_ROW_CAP;
  const workspaceId = opts.workspaceId ?? null;

  type HoldRow = Pick<LoopStanddownRow, 'pause'>;
  let rows: HoldRow[];
  try {
    rows = await sql<HoldRow[]>`
      SELECT metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE reschedule_interval_sec IS NOT NULL
         AND active = false
         AND metadata->'pause'->>${LOOP_STANDDOWN_MARKER} = 'true'
         AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId})
       LIMIT ${limit}`;
  } catch (e) {
    // FAIL CLOSED — see the second numbered reason above. Loud, because a
    // persistently unreadable routines table would otherwise hold the governor
    // down silently and read exactly like a quiet workspace.
    console.warn(
      `[loop-standdown] workspace-wide hold scan failed (FAILING CLOSED, top-up blocked): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return true;
  }

  return rows.some(
    (row) =>
      isWorkspaceWideLoopStanddownPause(row.pause)
      && !classifyFinitePauseExpiry(readRoutinePause(row.pause), nowMs).expired,
  );
}

/**
 * One bounded sweep pass: auto-resume every loop-su-% routine whose
 * loop:standdown-all pause has outlived its TTL, and record a notice for each.
 * Sibling of `sweepExpiredReleasePauses` — same row-scan/re-arm shape, scoped to
 * `reschedule_interval_sec IS NOT NULL` (a loop row) instead of `group_slug`,
 * and gated on the `standdownAll` marker in SQL so a legacy/ordinary loop pause
 * (routines:set, loop:end) can never be a scan candidate in the first place —
 * belt-and-suspenders alongside `isLoopStanddownPause`/`classifyFinitePauseExpiry`
 * being marker-and-record-shape driven rather than presence-driven.
 *
 * Fail-soft + race-guarded identically to the release sweep: a bad row or dead
 * notification rail must never break the shared routines tick, and the re-arm
 * UPDATE is guarded on the EXACT pause blob classified so a pause that changed
 * between read and write is left for the next pass instead of clobbered.
 */
export async function sweepExpiredLoopStanddowns(
  sql: Sql,
  opts: { nowMs?: number; limit?: number; notify?: boolean } = {},
): Promise<LoopStanddownAutoResume[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? SWEEP_ROW_CAP;
  const resumed: LoopStanddownAutoResume[] = [];

  let rows: LoopStanddownRow[];
  try {
    rows = await sql<LoopStanddownRow[]>`
      SELECT workspace_id, install_slug, name, target_owner_id, active, metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE reschedule_interval_sec IS NOT NULL
         AND active = false
         AND metadata->'pause'->>'standdownAll' = 'true'
       LIMIT ${limit}`;
  } catch (e) {
    console.warn(`[loop-standdown] scan failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return resumed;
  }

  for (const row of rows) {
    const pause = readRoutinePause(row.pause);
    const verdict = classifyFinitePauseExpiry(pause, nowMs);
    if (!verdict.expired) continue;

    try {
      const lastPause = {
        ...((row.pause as Record<string, unknown> | null) ?? {}),
        resumedAtMs: nowMs,
        autoResumedAtMs: nowMs,
        autoResumedBy: 'loop-standdown-ttl',
        autoResumeReason: verdict.legacy ? 'legacy-pause-default-ttl-lapsed' : 'standdown-ttl-lapsed',
        expiresAtMs: verdict.expiresAtMs,
      };
      const updated = await sql<{ install_slug: string }[]>`
        UPDATE harness_shared.routines r
           SET active = true,
               next_fire_at = now(),
               metadata = jsonb_set(
                 COALESCE(r.metadata, '{}'::jsonb) - 'pause',
                 '{lastPause}',
                 ${JSON.stringify(lastPause)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE r.workspace_id = ${row.workspace_id}
           AND r.install_slug = ${row.install_slug}
           AND r.name = ${row.name}
           AND r.reschedule_interval_sec IS NOT NULL
           AND r.active = false
           AND r.metadata->'pause' = ${JSON.stringify(row.pause)}::text::jsonb
        RETURNING r.install_slug`;
      if (!updated[0]) continue; // raced — the next pass classifies the new state

      const record: LoopStanddownAutoResume = {
        workspaceId: row.workspace_id,
        installSlug: row.install_slug,
        name: row.name,
        targetOwnerId: row.target_owner_id,
        expiresAtMs: verdict.expiresAtMs,
        overdueMs: verdict.overdueMs,
        legacy: verdict.legacy,
        pauseReason: pause.reason,
        pausedBy: pause.pausedBy,
        pausedAtMs: pause.pausedAtMs,
      };
      resumed.push(record);
      console.warn(
        `[loop-standdown] AUTO-RESUMED ${row.install_slug}/${row.name} (owner ${row.target_owner_id ?? '(unknown)'}) — ` +
          `stand-down by ${pause.pausedBy ?? '(unknown)'} ("${pause.reason ?? 'no reason recorded'}") lapsed at ` +
          `${stampIso(verdict.expiresAtMs)} (${Math.round(verdict.overdueMs / 60_000)}m overdue${
            verdict.legacy ? ', legacy pause / default TTL' : ''
          })`,
      );

      if (opts.notify !== false) await notifyLoopStanddownAutoResume(record);
    } catch (e) {
      console.warn(
        `[loop-standdown] auto-resume failed for ${row.install_slug}/${row.name} (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return resumed;
}

/** Same notice primitive as `notifyAutoResume` above — deliberately not a new channel. */
async function notifyLoopStanddownAutoResume(record: LoopStanddownAutoResume): Promise<void> {
  try {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    await notifyAttentionOnce({
      kind: 'intervention',
      importance: 'high',
      harnessSlug: record.installSlug,
      workspaceId: record.workspaceId,
      title: `Engine loop AUTO-RESUMED — stand-down TTL lapsed (${record.targetOwnerId ?? record.name})`,
      body:
        `A loop:standdown-all pause on "${record.name}" (owner ${record.targetOwnerId ?? '(unknown)'}, ${record.installSlug}) ` +
        `lapsed at ${stampIso(record.expiresAtMs)} (${Math.round(record.overdueMs / 60_000)}m overdue)` +
        `${record.legacy ? ' — this pause predates TTL stamping, so the default TTL was applied to it' : ''}, ` +
        `and the routines engine has re-armed it. The stand-down was taken by ${record.pausedBy ?? '(unknown)'}: ` +
        `"${record.pauseReason ?? 'no reason recorded'}". If the stand-down is still needed, re-issue loop:standdown-all ` +
        'with an explicit `pauseTtlHours` rather than assuming it stays down.',
      dedupeKey: `loop-standdown-ttl:${record.installSlug}:${record.name}:${record.expiresAtMs}`,
      data: {
        routine: record.name,
        targetOwnerId: record.targetOwnerId,
        installSlug: record.installSlug,
        event: 'loop-standdown-ttl-auto-resume',
        expiresAtMs: record.expiresAtMs,
        overdueMs: record.overdueMs,
        legacyPause: record.legacy,
        pausedBy: record.pausedBy,
        pauseReason: record.pauseReason,
      },
    });
  } catch (e) {
    console.warn(`[loop-standdown] auto-resume notice failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    notifySyncInvalidate('automation.catalog');
  } catch {
    /* SSE hub unavailable — the automation pane refreshes on its next read */
  }
}

async function notifyAutoResume(record: ReleasePauseAutoResume): Promise<void> {
  try {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    await notifyAttentionOnce({
      kind: 'intervention',
      importance: 'high',
      harnessSlug: record.installSlug,
      workspaceId: record.workspaceId,
      title: `Release routine AUTO-RESUMED — "${record.name}" pause TTL lapsed`,
      body:
        `"${record.name}" (${record.installSlug}) is in the release group, so its deliberate pause carries a finite TTL. ` +
        `That TTL lapsed at ${stamp(record.expiresAtMs)} (${Math.round(record.overdueMs / 60_000)}m overdue)` +
        `${record.legacy ? ' — this pause predates TTL stamping, so the default release TTL was applied to it' : ''}, ` +
        `and the routines engine has re-armed the routine. The hold was taken by ${record.pausedBy ?? '(unknown)'} ` +
        `at ${stamp(record.pausedAtMs)}: "${record.pauseReason ?? 'no reason recorded'}". ` +
        'If the hold is still needed, re-pause it with an explicit `pauseTtlHours` rather than leaving it open-ended.',
      dedupeKey: `release-pause-ttl:${record.installSlug}:${record.name}:${record.expiresAtMs}`,
      data: {
        routine: record.name,
        installSlug: record.installSlug,
        event: 'release-pause-ttl-auto-resume',
        expiresAtMs: record.expiresAtMs,
        overdueMs: record.overdueMs,
        legacyPause: record.legacy,
        pausedBy: record.pausedBy,
        pauseReason: record.pauseReason,
      },
    });
  } catch (e) {
    console.warn(`[release-pause-ttl] auto-resume notice failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    notifySyncInvalidate('automation.catalog');
  } catch {
    /* SSE hub unavailable — the automation pane refreshes on its next read */
  }
}
