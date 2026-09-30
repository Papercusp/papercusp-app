/**
 * Autoloop fire-state + error-backoff — autoloop-pot-operator-rebuild-2026-06-05
 * P-009/P-010 (D-009).
 *
 * The two duplicate director-cadence loops are GONE:
 *   - the legacy in-process `setInterval` ticker that lived here, and
 *   - its DBOS twin (`dbos/autoloop-workflow.ts`) — both read
 *     `.papercusp/director-config.json` (`autoLoop:true`), an enablement
 *     surface nothing wrote (last fired 34 days before the rebuild).
 *
 * The surviving cadence loop is the BLUEPRINT path: a harness's blueprint
 * declares `triggers.schedule`, `harness:create` materializes them into
 * `harness_shared.routines`, and the durable DBOS `routinesTick` fires
 * `system:blueprint-run` (→ the blueprint's `spine.decider`) or an agent-role
 * routine directly. Enablement = the Pot creates a harness whose blueprint
 * carries its own autoloop — no `autoLoop:true` flag, no director-config.
 *
 * What REMAINS here is the per-(workspace, harness, role) fire-state on
 * `harness_shared.autoloop_state` — and the previously written-but-never-read
 * `consecutive_errors` is now READ (D-009): `evaluateFireGate` applies
 * exponential backoff to a repeatedly-failing role fire and opens the circuit
 * past a threshold, so a broken director can't be re-fired at full cadence
 * forever. The gate is consulted by the blueprint-run decider fire and the
 * role-routine fire (the live paths); `autoloop:control { op:'reset-errors' }`
 * closes the circuit by hand.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, inArray, or, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';

const at = generated.autoloopStateInHarnessShared;

/** EI-7009: the exact `last_status` string the WI-1399 terminal guard writes when it
 *  auto-pauses a durably-dead loop:arm owner's routine (reconcile-loop-routines.ts's
 *  `recordFire(row.install_slug, row.name, 'loop-terminal-unreachable', 'error')`). A
 *  row carrying this EXACT marker is a confirmed SYSTEM auto-pause, never a human pause
 *  for investigation — see pruneStaleFireState's second clause. */
export const LOOP_TERMINAL_AUTO_PAUSE_STATUS = 'loop-terminal-unreachable';

/** Backoff doubles from this base per consecutive error. */
export function backoffBaseSec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC ?? 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Backoff never exceeds this cap (also the circuit-open retry window). */
export function backoffCapSec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC ?? 3600);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/** Consecutive errors at which the circuit OPENS (fires only once per cap window). */
export function circuitThreshold(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD ?? 8);
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

/**
 * The recovery-debounce window (B7 / autonomous-loop-hardening F3). An OPEN circuit that
 * has not fired AT ALL for this long is genuinely WEDGED — its next_fire_at got stuck in
 * the past and routinesTick keeps withholding, so it is no longer even taking its half-open
 * probe (last_fired_at goes stale). Past this window the circuit AUTO-CLOSES so the role
 * resumes cadence, instead of staying gated until a human runs `autoloop:control
 * reset-errors`. Default 6× the cap (~6h) — far beyond the ~hourly probe cadence, so a
 * circuit that IS still probing (recent last_fired_at) never trips it; only a stalled one
 * self-heals. A correctly-failing circuit is thus left open, a stuck one recovers.
 */
export function recoverySec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_RECOVERY_SEC ?? backoffCapSec() * 6);
  return Number.isFinite(n) && n > 0 ? n : backoffCapSec() * 6;
}

export interface FireState {
  lastFiredAt: Date | null;
  consecutiveErrors: number;
}

export interface FireGateVerdict {
  allow: boolean;
  /** Why a fire was withheld. */
  reason?: 'backoff' | 'circuit-open';
  consecutiveErrors: number;
  /** Seconds until the next allowed attempt (when withheld). */
  retryAfterSec?: number;
  /** The circuit was open past the recovery window with no fire — the caller should
   *  ZERO consecutive_errors so the role returns to full cadence (self-heal, B7/F3).
   *  `checkFireGate` performs the reset; `evaluateFireGate` only flags it (stays pure). */
  autoReset?: boolean;
}

/**
 * The pure backoff decision (D-009). No errors ⇒ allow. With N consecutive
 * errors, a re-fire is allowed only after `base * 2^(N-1)` seconds (capped);
 * at ≥ the circuit threshold the circuit is OPEN — one attempt per cap window
 * (a half-open probe), so a persistently-broken role degrades to ~hourly
 * probes instead of full cadence. A success (`recordFire 'ok'`) closes it.
 */
export function evaluateFireGate(state: FireState | null, now: Date = new Date()): FireGateVerdict {
  const errors = state?.consecutiveErrors ?? 0;
  if (!state || errors <= 0) return { allow: true, consecutiveErrors: errors };
  const open = errors >= circuitThreshold();
  const lastMs = state.lastFiredAt ? state.lastFiredAt.getTime() : 0;
  const elapsedSec = (now.getTime() - lastMs) / 1000;
  // Recovery-debounce auto-heal (B7 / F3): an OPEN circuit that has not fired for the whole
  // recovery window is WEDGED (stuck next_fire_at, no half-open probe, stale last_fired_at).
  // Auto-close it — signal `autoReset` so checkFireGate zeroes the counter and the role
  // resumes cadence, rather than needing a manual `autoloop:control reset-errors`. A circuit
  // that is still probing keeps a recent last_fired_at, so it never trips this: only a
  // stalled circuit heals; a correctly-failing one stays open.
  if (open && elapsedSec >= recoverySec()) {
    return { allow: true, consecutiveErrors: errors, autoReset: true };
  }
  const requiredSec = open
    ? backoffCapSec()
    : Math.min(backoffBaseSec() * 2 ** (errors - 1), backoffCapSec());
  if (elapsedSec >= requiredSec) return { allow: true, consecutiveErrors: errors };
  return {
    allow: false,
    reason: open ? 'circuit-open' : 'backoff',
    consecutiveErrors: errors,
    retryAfterSec: Math.ceil(requiredSec - elapsedSec),
  };
}

/**
 * WI-41224 (loop-wake-reliability-2026-08-24 P-001, ruling D-006) — an OWNER-LOOP's
 * identity is its `role` alone.
 *
 * This table serves TWO populations and only one of them wants `harness_slug` in its key:
 *  - HARNESS-ROLES (`engineer`, `reviewer`, …): genuinely per-harness. Harness X's
 *    `engineer` IS a different thing from harness Y's, so (workspace, harness, role) is
 *    the CORRECT identity and is left untouched.
 *  - OWNER-LOOPS (`loop-su-<uuid>`): per-agent. The uuid is globally unique, so BOTH
 *    `harness_slug` and `workspace_id` are redundant — workspace is DERIVABLE from the
 *    owner rather than independent of it. The owner-loop was bolted onto a table keyed
 *    for harness-roles and inherited a scope it does not have.
 *
 * MEASURED 2026-08-24: 1,353 rows for 1,261 distinct owner-loops — 92 duplicates, every
 * one splitting on `harness_slug` and NONE on `workspace_id`. A split row wedges the
 * circuit permanently: the gate evaluates one row while `recordFire('ok')` stamps the
 * other, so `consecutive_errors` can never be cleared by a successful fire. One loop sat
 * at "consecutive_errors=1, retry in ~1s" for 90 minutes and fired 7 times against 111
 * expected.
 *
 * The same asymmetry is ALREADY known one function down: `pruneStaleFireState` class 3
 * matches loop rows "by workspace + role rather than `harness_slug`". It was never
 * carried into the gate.
 *
 * ⚠ `workspace_id` stays in the PREDICATE even though it leaves the IDENTITY. It cannot
 * discriminate (a globally-unique owner lives in exactly one workspace), but this schema
 * is genuinely multi-tenant and dropping tenant predicates from queries is a different,
 * worse bug. Identity and filtering are separate questions.
 */
const OWNER_LOOP_ROLE_PREFIX = 'loop-su-';

/** True for a per-AGENT loop row, whose identity is `role` alone (D-006). */
export function isOwnerLoopRole(role: string): boolean {
  return role.startsWith(OWNER_LOOP_ROLE_PREFIX);
}

/**
 * The identity predicate for one fire-state row. Owner-loops match on (workspace, role);
 * every other role keeps its per-harness identity unchanged.
 */
function fireStateWhere(ws: string, slug: string, role: string) {
  return isOwnerLoopRole(role)
    ? and(eq(at.workspaceId, ws), eq(at.role, role))
    : and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug), eq(at.role, role));
}

/** Read the fire-state row for (active workspace, slug, role), or null. */
export async function readFireState(slug: string, role: string): Promise<FireState | null> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ last_fired_at: at.lastFiredAt, consecutive_errors: at.consecutiveErrors })
    .from(at)
    .where(fireStateWhere(ws, slug, role))
    // ⚠ ORDER BY is load-bearing WHILE DUPLICATES EXIST (until the P-002 collapse +
    // partial unique index land). Widening the owner-loop predicate to (workspace, role)
    // makes it match EVERY split row, and the previous unordered `rows[0]` would then
    // pick one NONDETERMINISTICALLY — strictly worse than the old behaviour. Preferring
    // the most-recently-fired row makes the read deterministic and self-healing: the gate
    // converges on the row the writer is actually stamping, instead of alternating.
    // NULLS LAST so a never-fired row never shadows one with real history.
    .orderBy(dsql`${at.lastFiredAt} DESC NULLS LAST`);
  if (rows.length === 0) return null;
  return {
    lastFiredAt: rows[0].last_fired_at ? new Date(rows[0].last_fired_at) : null,
    consecutiveErrors: Number(rows[0].consecutive_errors ?? 0),
  };
}

/** Read + evaluate in one call — the gate the live fire paths consult. */
export async function checkFireGate(slug: string, role: string, now: Date = new Date()): Promise<FireGateVerdict> {
  try {
    const state = await readFireState(slug, role);
    const verdict = evaluateFireGate(state, now);
    if (verdict.autoReset) {
      // Recovery-debounce: the circuit was open past the recovery window with no fire (a
      // wedged routine, not a probing one) — self-heal by zeroing the counter so the role
      // resumes cadence (B7 / F3). Best-effort: on a write failure we still allow this fire
      // (fail-open, matching the gate's protection-not-dependency contract below).
      const openForSec = Math.round((now.getTime() - (state?.lastFiredAt?.getTime() ?? 0)) / 1000);
      await resetFireErrors(slug, role).catch((e) =>
        console.warn(
          `[autoloop] auto-recovery reset failed (${slug}/${role}):`,
          e instanceof Error ? e.message : e,
        ),
      );
      console.log(
        `[autoloop] ${slug}/${role}: circuit AUTO-RECOVERED (was open ~${openForSec}s with no fire, past the ${recoverySec()}s recovery window) — resuming cadence`,
      );
      return { allow: true, consecutiveErrors: 0 };
    }
    return verdict;
  } catch (e) {
    // Fail OPEN (allow): the gate is a protection, not a dependency — a PG
    // hiccup must not stop the fleet's scheduled fires.
    console.warn(`[autoloop] fire-gate read failed (${slug}/${role}) — allowing:`, e instanceof Error ? e.message : e);
    return { allow: true, consecutiveErrors: 0 };
  }
}

/**
 * Record a WITHHELD fire (EI-14483) — a fire-path guard denied the fire before it ever
 * reached `recordFire`'s 'attempt'/'ok'/'error' outcomes. `checkFireGate`'s backoff/
 * circuit-open deny is the motivating case: it returns early WITHOUT calling `recordFire`
 * (by design — touching `last_fired_at` there would reset the very backoff clock the gate
 * is enforcing), which left ZERO durable trace of "this loop has been attempted-and-denied
 * every tick for hours" — indistinguishable, from `autoloop_state` alone, from "hasn't been
 * attempted at all". That gap is exactly what stalled a live incident investigation
 * (EI-14483): a fleet-leader loop went quiet for ~4h and the only question that mattered —
 * was the loop firing-and-swallowed or genuinely un-scheduled — was unanswerable after the
 * fact because the withhold was logged only via an ephemeral `console.warn`.
 *
 * Deliberately writes to SEPARATE columns (`last_withheld_at/reason/detail`) rather than
 * reusing `last_fired_at`/`last_status`/`consecutive_errors` — those three remain the
 * backoff clock's exclusive input, untouched by a mere gate check, so recording a withhold
 * can never perturb the very backoff it is reporting on. Best-effort/fail-soft: a write
 * failure here must never affect the caller's gate decision.
 */
export async function recordWithheld(slug: string, role: string, reason: string, detail?: string): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  try {
    if (isOwnerLoopRole(role)) {
      // Owner-loop identity is role-only (WI-41224/P-001). Name migration 939's
      // partial index predicate explicitly, then refresh the one role-scoped row
      // (including its descriptive harness/workspace metadata) on conflict.
      const inserted = await db
        .insert(at)
        .values({
          harnessSlug: slug,
          role,
          workspaceId: ws,
          lastWithheldAt: dsql`now()` as any,
          lastWithheldReason: reason,
          lastWithheldDetail: detail ?? null,
        })
        .onConflictDoNothing({ target: at.role, where: dsql`${at.role} LIKE 'loop-su-%'` })
        .returning({ role: at.role });
      if (inserted.length === 0) {
        await db
          .update(at)
          .set({
            harnessSlug: slug,
            workspaceId: ws,
            lastWithheldAt: dsql`now()`,
            lastWithheldReason: reason,
            lastWithheldDetail: detail ?? null,
          })
          .where(fireStateWhere(ws, slug, role));
      }
    } else {
      await db
        .insert(at)
        .values({
          harnessSlug: slug,
          role,
          workspaceId: ws,
          lastWithheldAt: dsql`now()` as any,
          lastWithheldReason: reason,
          lastWithheldDetail: detail ?? null,
        })
        .onConflictDoUpdate({
          target: [at.workspaceId, at.harnessSlug, at.role],
          set: {
            lastWithheldAt: dsql`now()`,
            lastWithheldReason: dsql`EXCLUDED.last_withheld_reason`,
            lastWithheldDetail: dsql`EXCLUDED.last_withheld_detail`,
          },
        });
    }
  } catch (e) {
    console.warn(`[autoloop] recordWithheld failed (${slug}/${role}/${reason}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * Record a fire-path event for (active workspace, slug, role).
 *
 * `outcome` semantics (P-009 — fixes the old write path where the pre-fire
 * `'firing'` record RESET the counter, so consecutive_errors could never
 * exceed 1):
 *   - 'attempt' — a fire was dispatched; status updated, counter PRESERVED.
 *   - 'ok'      — the fire succeeded; counter reset to 0 (closes the circuit).
 *   - 'error'   — the fire failed; counter incremented.
 */
export { classifyFireError } from './autoloop-classify';

export async function recordFire(
  slug: string,
  role: string,
  status: string,
  outcome: 'attempt' | 'ok' | 'error' | 'infra-error',
): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const insertErrors = outcome === 'error' ? 1 : 0;
  const onUpdateErrors =
    outcome === 'error'
      ? dsql`${at.consecutiveErrors} + 1`
      : outcome === 'ok'
        ? dsql`0`
        : dsql`${at.consecutiveErrors}`; // attempt / infra-error (WI-669): preserve
  if (isOwnerLoopRole(role)) {
    // Owner-loop identity is role-only (WI-41224/P-001). Name migration 939's
    // partial index predicate explicitly; a re-home conflict then refreshes the
    // same workspace+role row the gate reads, rather than minting a split row.
    const inserted = await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: insertErrors,
        workspaceId: ws,
      })
      .onConflictDoNothing({ target: at.role, where: dsql`${at.role} LIKE 'loop-su-%'` })
      .returning({ role: at.role });
    if (inserted.length === 0) {
      await db
        .update(at)
        .set({
          harnessSlug: slug,
          lastFiredAt: dsql`now()`,
          lastStatus: status,
          consecutiveErrors: onUpdateErrors,
          workspaceId: ws,
        })
        .where(fireStateWhere(ws, slug, role));
    }
  } else {
    await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: insertErrors,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [at.workspaceId, at.harnessSlug, at.role],
        set: {
          lastFiredAt: dsql`now()`,
          lastStatus: dsql`EXCLUDED.last_status`,
          consecutiveErrors: onUpdateErrors,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
  }
  // Health-signal hygiene (autonomous-loop-hardening F6): piggyback a throttled prune of
  // long-dead fire-state rows on the existing fire path, so the table self-maintains without a
  // new scheduler. Fire-and-forget + time-gated, so it adds no per-fire cost in the common case
  // and never blocks or fails a fire.
  maybePruneStaleFireState(Date.now());
}

/** How stale a zero-error fire-state row must be before the hygiene prune retires it. A live
 *  autoloop role fires every minutes–hours, so a row untouched this long belongs to a
 *  since-deleted harness/role — never an active one. Env-overridable, floored at 1 day. */
export function pruneMaxAgeDays(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS ?? 14);
  return Number.isFinite(n) && n >= 1 ? n : 14;
}

/**
 * EI-22091466748669603 — fire-state roles belonging to the PERMANENTLY RETIRED Mug/Kettle/Cup
 * tier. `agent-tools/_mug-kettle-gate.ts` makes every actuator refusal UNCONDITIONAL (P-068
 * deleted `papercusp-mug-kettle-system`, so `mugKettleSystemEnabled()` is a permanent `false`),
 * which means a row for one of these roles can never advance its watermark again.
 *
 * WHY THIS NEEDED A FOURTH CLASS RATHER THAN WIDENING AN EXISTING ONE. A retired-tier row that
 * stopped WHILE ERRORING is reachable by none of classes 1–3: class 1 requires
 * `consecutive_errors = 0`; class 2 requires the loop-terminal auto-pause marker AND a matching
 * inactive `routines` row; class 3 is scoped to `role LIKE 'loop-%'`. Measured 2026-09-02: the
 * two surviving `kettle` rows (`papercup`, dead since 2026-06-25 with 6 errors, and `*`, 2 errors
 * — "HTTP 404 unknown project") had sat immortal for ~68 days, and a CORRECT silent-stop detector
 * (`harness/routines/autoloop-chronic-failure.ts`) reported them as major bugs on schedule:
 * EI-19370235414830628, EI-19463513273744786 and EI-22091466748669603 are the same finding filed
 * three times, the last two closed as "retired-tier residue; no source fix is warranted". The
 * detector is right and the data is wrong; this removes the data.
 *
 * ⛔ DO NOT "generalize" this by dropping the role list and keying class 3's structural test
 * (no matching `routines` row) onto fixed system roles. For a fixed system role that absence is
 * the NORMAL HEALTHY state, not evidence of death — `autoloop-chronic-failure.ts` says so
 * explicitly ("a fixed system role — director/gym-cycle/overwatch/scout-cycle ... carry null").
 * Such a widening would delete the fire-state of LIVE roles. Only a positively-known permanent
 * retirement justifies deleting an error-carrying watermark, which is why this is an explicit
 * allowlist tied to a gate that cannot be re-opened.
 *
 * `director` is deliberately ABSENT despite also being long dead: the source is self-contradictory
 * about it (`autoloop-chronic-failure.ts` calls it "the retired `director` role" in one comment and
 * lists it among the live fixed system roles the sweep is meant to watch in another), and an
 * ambiguous retirement is not a licence to delete state.
 */
export const RETIRED_TIER_AUTOLOOP_ROLES: readonly string[] = ['kettle', 'mug', 'cup'];

/**
 * Retire long-dead fire-state rows (autonomous-loop-hardening F6 — health-signal hygiene).
 * DELETEs rows matching ANY of four classes:
 *
 *  1. Have not fired for `maxAgeDays` AND carry no error signal (`consecutive_errors = 0`) —
 *     a role that fired once for a since-deleted harness and went quiet, leaving cruft that
 *     clutters `autoloop:status` and any health read. GLOBAL (every workspace): the
 *     accumulation is old dead harnesses across workspaces, and a ≥14-day-stale zero-error
 *     row cannot belong to a live role. Rows with a non-zero error counter are otherwise
 *     PRESERVED (real circuit signal for reset-errors / investigation), and recently-fired
 *     rows are untouched — so this can never disturb an active or a legitimately-failing
 *     circuit.
 *
 *  2. EI-7009: carry the EXACT `LOOP_TERMINAL_AUTO_PAUSE_STATUS` marker AND their matching
 *     `routines` row (workspace_id, install_slug=harness_slug, name=role) is now `active =
 *     false`. This is the WI-1399 terminal guard's own auto-pause of a durably-dead loop:arm
 *     owner — a system action, not a human pause for investigation, and it is PERMANENT (the
 *     paused routine will never fire 'ok' again to reset the counter, so class 1's
 *     zero-error rule can never catch it — the exact "permanently-red watermark" this class
 *     exists to clear). No age gate: the guard's own pause IS the definitive "this will never
 *     resolve on its own" signal. Scoped to the EXACT marker string (not any inactive
 *     routine) so a routine a HUMAN paused mid-investigation (any other `last_status`) keeps
 *     its error trail intact — this class never touches it.
 *
 *  3. Loop-owner orphan rows: a stale, non-zero `loop-%` watermark whose workspace has no
 *     routine with the same name. Loop fire-state historically used both concrete install
 *     slugs and `*`, so this intentionally matches by workspace + role rather than
 *     `harness_slug`. The age bound avoids deleting a newly re-homed row while its routine
 *     materialisation is still settling; any matching routine (including an inactive human
 *     pause) preserves the row for investigation.
 *
 * Returns the number of rows retired (both classes combined).
 */
export async function pruneStaleFireState(opts: { maxAgeDays?: number } = {}): Promise<number> {
  const maxAgeDays = opts.maxAgeDays && opts.maxAgeDays > 0 ? opts.maxAgeDays : pruneMaxAgeDays();
  const { db } = getOrgPg();
  const res = await db
    .delete(at)
    .where(
      or(
        and(
          dsql`${at.lastFiredAt} IS NOT NULL`,
          dsql`${at.lastFiredAt} < now() - (${maxAgeDays}::int * interval '1 day')`,
          eq(at.consecutiveErrors, 0),
        ),
        and(
          eq(at.lastStatus, LOOP_TERMINAL_AUTO_PAUSE_STATUS),
          dsql`EXISTS (
            SELECT 1 FROM harness_shared.routines r
             WHERE r.workspace_id = ${at.workspaceId}
               AND r.install_slug = ${at.harnessSlug}
               AND r.name = ${at.role}
               AND r.active = false
          )`,
        ),
        and(
          dsql`${at.role} LIKE 'loop-%'`,
          dsql`${at.lastFiredAt} IS NOT NULL`,
          dsql`${at.lastFiredAt} < now() - (${maxAgeDays}::int * interval '1 day')`,
          dsql`${at.consecutiveErrors} > 0`,
          dsql`NOT EXISTS (
            SELECT 1 FROM harness_shared.routines r
             WHERE r.workspace_id = ${at.workspaceId}
               AND r.name = ${at.role}
          )`,
        ),
        // 4. Retired-tier rows (EI-22091466748669603): a Mug/Kettle/Cup role whose watermark is
        //    stale beyond the age bound, REGARDLESS of `consecutive_errors`. The retirement is
        //    unconditional and irreversible, so an error trail on these rows preserves nothing
        //    investigable — it only keeps a permanently-frozen watermark alive for the
        //    silent-stop detector to re-report forever. See RETIRED_TIER_AUTOLOOP_ROLES.
        and(
          inArray(at.role, RETIRED_TIER_AUTOLOOP_ROLES),
          dsql`${at.lastFiredAt} IS NOT NULL`,
          dsql`${at.lastFiredAt} < now() - (${maxAgeDays}::int * interval '1 day')`,
        ),
      ),
    );
  return Number((res as unknown as { count?: number }).count ?? 0);
}

/** Hygiene-prune cadence (per process): at most one prune per this window. */
export const PRUNE_THROTTLE_MS = 6 * 3600_000;

/** Pure throttle gate — a prune is due when it has never run (lastPruneAtMs ≤ 0, the sentinel)
 *  or the window has elapsed. The never-run case is explicit so it holds for any clock, not
 *  only real epoch-ms. Extracted so the cadence is unit-testable without a DB or a clock. */
export function isPruneDue(
  nowMs: number,
  lastPruneAtMs: number,
  throttleMs: number = PRUNE_THROTTLE_MS,
): boolean {
  if (lastPruneAtMs <= 0) return true; // never pruned this process — always due
  return nowMs - lastPruneAtMs >= throttleMs;
}

let lastPruneAtMs = 0;

/** Fire-and-forget, time-gated hygiene prune (F6). Called from the fire path; runs the DELETE
 *  at most once per `PRUNE_THROTTLE_MS` per process, swallowing errors so it never affects a
 *  fire. The first call after process start runs it, clearing accumulated cruft on startup. */
export function maybePruneStaleFireState(nowMs: number): void {
  if (!isPruneDue(nowMs, lastPruneAtMs)) return;
  lastPruneAtMs = nowMs;
  void pruneStaleFireState().then(
    (n) => {
      if (n > 0) {
        console.log(
          `[autoloop] hygiene: retired ${n} stale fire-state row(s) (≥${pruneMaxAgeDays()}d idle, no errors)`,
        );
      }
    },
    (e) => console.warn('[autoloop] hygiene prune failed (non-fatal):', e instanceof Error ? e.message : e),
  );
}

/**
 * Atomically claim a fire slot for (active workspace, slug, role) — the
 * single-flight guard for schedulers whose check-then-act window can overlap
 * (EI-304: two concurrent Scout ticks both snapshot stale cadence state, both
 * pass the min-interval floor, both spend a full budgeted cycle).
 *
 * CAS on `last_fired_at`: the claim succeeds only while the row's value still
 * matches what the caller read (compared at ms precision — JS readers get a
 * Date and lose PG's µs), stamping `now()` so every concurrent loser's
 * expected value is stale by the time its UPDATE runs. A never-fired slot
 * (expected null) is claimed by insert, falling back to a NULL-guarded UPDATE
 * when the row exists unstamped. Each path is a single statement, so the
 * guard holds across processes, not just within one event loop.
 */
export async function claimFire(
  slug: string,
  role: string,
  expectedLastFiredAtMs: number | null,
  status = 'claimed',
): Promise<boolean> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const identityWhere = isOwnerLoopRole(role)
    ? fireStateWhere(ws, slug, role)
    : and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug), eq(at.role, role));
  if (expectedLastFiredAtMs == null) {
    const ins = await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: 0,
        workspaceId: ws,
      })
      .onConflictDoNothing(
        isOwnerLoopRole(role)
          ? { target: at.role, where: dsql`${at.role} LIKE 'loop-su-%'` }
          : { target: [at.workspaceId, at.harnessSlug, at.role] },
      );
    if (Number((ins as unknown as { count?: number }).count ?? 0) > 0) return true;
    const upd = await db
      .update(at)
      .set({ harnessSlug: slug, workspaceId: ws, lastFiredAt: dsql`now()`, lastStatus: status })
      .where(
        and(
          identityWhere,
          dsql`${at.lastFiredAt} IS NULL`,
        ),
      );
    return Number((upd as unknown as { count?: number }).count ?? 0) > 0;
  }
  const upd = await db
    .update(at)
    .set({ harnessSlug: slug, workspaceId: ws, lastFiredAt: dsql`now()`, lastStatus: status })
    .where(
      and(
        identityWhere,
        dsql`date_trunc('milliseconds', ${at.lastFiredAt}) = to_timestamp(${expectedLastFiredAtMs}::double precision / 1000.0)`,
      ),
    );
  return Number((upd as unknown as { count?: number }).count ?? 0) > 0;
}

/** Close the circuit by hand: zero the error counters for a harness (all roles,
 *  or one). The `autoloop:control { op:'reset-errors' }` target. */
export async function resetFireErrors(slug: string, role?: string): Promise<number> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const where = role
    ? fireStateWhere(ws, slug, role)
    : and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug));
  const res = await db
    .update(at)
    .set({ consecutiveErrors: 0, lastStatus: 'errors-reset' })
    .where(where);
  return Number((res as unknown as { count?: number }).count ?? 0);
}

/** Diagnostic read for a harness (all roles) — the autoloop:status surface. */
export async function getAutoLoopState(slug: string): Promise<any[] | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({
      harness_slug: at.harnessSlug,
      role: at.role,
      last_fired_at: at.lastFiredAt,
      last_status: at.lastStatus,
      consecutive_errors: at.consecutiveErrors,
      // EI-14483: surfaced alongside last_fired_at so "attempted-and-withheld" is
      // distinguishable from "never attempted" without log archaeology.
      last_withheld_at: at.lastWithheldAt,
      last_withheld_reason: at.lastWithheldReason,
      last_withheld_detail: at.lastWithheldDetail,
    })
    .from(at)
    .where(eq(at.harnessSlug, slug))
    .orderBy(at.role);
  return rows.length > 0 ? rows : null;
}
