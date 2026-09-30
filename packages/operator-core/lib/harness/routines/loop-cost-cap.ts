/**
 * Loop cost-cap — the one net-new guardrail a "loop" routine adds over the existing
 * routine fire path (loop-routines-interval-recurrence-2026-06-20 P-004 / D-006, B-LOOP-3).
 *
 * A loop fires a recurring WARM `coord` wake at a pinned su session (the engine-managed
 * replacement for Claude /loop). Its existing safety net is the failure-streak fire-gate
 * (`checkFireGate`, autoloop.ts). D-006 adds exactly ONE more: a per-loop COST cap — when
 * the bound session's cumulative attributed spend since the loop was armed exceeds the
 * configured cap, auto-pause the routine (the cost sibling of the failure-streak auto-pause,
 * mirroring `plan-run-cost.ts` `autoPauseOnCostBreach` — but at the ROUTINE layer, since a
 * loop mints no plan_run, D-005/D-006).
 *
 * The cap lives in the routine's `payload_template.costCapCents` (a loop's config rides the
 * payload_template, set by the B-LOOP-5 arm-verb); the schema columns are su-d5a84's frozen
 * B-LOOP-1 seam (`reschedule_interval_sec` + `target_owner_id`), which this module does NOT
 * touch.
 *
 * ── Spend attribution: owner → session_id → cost (FAIL-OPEN on uncertain data) ────────────
 * `agent_usage_samples` (mig 161/170/279) is keyed by session_id, NOT the coord ownerId, so we
 * attribute via owner → `adv_sessions.session_id` → SUM(cost_usd) keyed on `session_id`. This
 * now WORKS for a warm interactive su session (loop-wake-rate-limit-robustness P3): the
 * interactive-usage ingestion (interactive-usage/ingest-claude-transcripts.ts) previously wrote
 * the native session UUID only into `run_id`, leaving `session_id` NULL — so the join found
 * nothing and `readLoopSpendCents` always returned 0. That is fixed: the ingestion now also
 * populates `session_id` with the native UUID (= the value `adv_sessions.session_id` carries),
 * so a warm-session loop's resume-turn spend is attributable and the cap actually binds. STILL
 * fail-open on genuinely uncertain data: when the owner has no tracked session id or a read
 * errors, `readLoopSpendCents` returns 0 (a false-pause is worse than a missed cap — the
 * failure-streak gate + the wake-delivery drop visibility still bound a runaway/dead loop). The
 * cap MECHANISM (evaluate → auto-pause → fire-gate integration) is exact + fully tested.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { advSessionsByCoordOwner } from '../../adv-sessions';
import { recordLoopTransition } from './loop-transition-log';

/**
 * Pure cap decision: a positive cap is breached when cumulative spend strictly exceeds it.
 * A null / non-finite / non-positive cap is "no cap" → never breaches.
 */
export function evaluateLoopCostCap(input: {
  spendCents: number;
  capCents: number | null | undefined;
}): { breach: boolean } {
  const cap = input.capCents;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return { breach: false };
  return { breach: input.spendCents > cap };
}

/**
 * Best-effort cumulative spend (cents) attributed to a loop's bound owner since `sinceMs`.
 * FAIL-OPEN: any uncertainty (no resolvable session id, read error) → 0. See the file header.
 * Injectable for tests via the `checkLoopCostCap` deps seam.
 */
export async function readLoopSpendCents(opts: {
  sql?: Sql;
  targetOwnerId: string;
  sinceMs: number;
}): Promise<number> {
  try {
    const db = opts.sql ?? getOrgPg().sql;
    // owner (coord ownerId / PAPERCUSP_SID) → the native session id its usage samples carry.
    const byOwner = await advSessionsByCoordOwner();
    const sessionId = byOwner.get(opts.targetOwnerId)?.sessionId;
    if (!sessionId) return 0; // no tracked session → can't attribute → fail-open
    const rows = await db<Array<{ usd: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
        FROM harness_shared.agent_usage_samples
       WHERE session_id = ${sessionId}
         AND ts >= ${opts.sinceMs}
    `;
    const usd = rows[0]?.usd ?? 0;
    return Math.max(0, Math.round(usd * 100));
  } catch {
    return 0; // fail-open — never pause a working loop because attribution is fuzzy
  }
}

/**
 * Auto-pause a loop routine on a guardrail breach: deactivate it + stamp the reason into
 * metadata (the paused state IS the notification — autoloop:status / the loop surface show
 * it inactive with the reason). Mirrors the spirit of `disarmPlanSchedule` at the routine
 * layer. `active=FALSE` stops the tick from claiming it; `next_fire_at=NULL` is tidy (an
 * inactive routine is never claimed regardless).
 *
 * ⚠ EI-19406534159939583: that `next_fire_at=NULL` used to be lossy, and "tidy" was exactly
 * the wrong trade. `next_fire_at` is the ONE field that separates the two failure modes a
 * pause reacts to, and the pause was erasing it:
 *
 *   - `'infinity'`  → the loop was parked as IN-FLIGHT (`claim.ts`'s sentinel) and never
 *                     re-armed by the completion-rebase. The agent may be perfectly healthy;
 *                     what broke is the re-arm path.
 *   - a real timestamp → the loop WAS scheduled and fires were landing, but no turn came of
 *                     them. That is the comatose owner `stalled-loops-guard` exists for.
 *
 * Post-pause both read `NULL`, so an investigator cannot tell "healthy agent, broken re-arm"
 * from "dead agent" and has to reconstruct it from timestamp archaeology. Measured live
 * 2026-08-03: five fleet members were disarmed at 04:07:16Z and the leading hypothesis about
 * WHY could be neither confirmed nor refuted from state, because this write had already
 * discarded the evidence. So preserve the prior value as `loop_paused_next_fire_at` before
 * nulling — one jsonb key, and the next occurrence is diagnosable in a single query.
 *
 * The key is written even when the prior value was NULL (as an explicit JSON `null`), so a
 * row that carries the key with `null` is distinguishable from a pre-fix row that lacks the
 * key entirely — absence means "paused before this fix", not "was unscheduled".
 */
export async function autoPauseLoopRoutine(
  sql: Sql,
  routineId: string,
  reason: string,
  /**
   * The code path requesting the pause, recorded as the transition's `actor` (WI-37571).
   * Defaults to this function's own name because that IS the honest answer when a caller
   * does not say: four guards funnel through here (stalled-loops-guard, loop-unreachable-guard,
   * loop-dead-man, loop-cost-cap), and `detail.reason` carries each one's full reason string,
   * which names the guard. Passing it explicitly makes `GROUP BY actor` answer "which guard
   * disarms the most loops" without parsing prose.
   */
  actor = 'auto-pause-loop-routine',
): Promise<void> {
  const paused = await sql<
    Array<{
      workspace_id: string;
      install_slug: string;
      name: string | null;
      target_role: string | null;
      target_owner_id: string | null;
      reschedule_interval_sec: number | null;
      was_active: boolean;
      prev_next_fire_at: string | null;
    }>
  >`
    UPDATE harness_shared.routines AS r
       SET active = FALSE,
           next_fire_at = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'loop_paused_reason', ${reason}::text,
                         'loop_paused_at', now()::text,
                         -- EI-19479519679704136: ALSO write the CANONICAL pause shape the
                         -- stale-paused detector actually reads. readStalePausedRoutines
                         -- (system-health/compute.ts) consumes metadata.pause.reason +
                         -- metadata.pause.pausedAtMs and nothing else, so every loop paused
                         -- here — with a full, timestamped reason sitting right beside it
                         -- under loop_paused_* — was classified reasonMissing:true and
                         -- reported as "a stale/unexplained pause". That verdict ignores the
                         -- age threshold by design ("an unattributed pause is exactly the bug
                         -- class"), so the row stayed flagged until the 7d decommissioned
                         -- cutoff. Measured 2026-08-04: 50 of the 63 flagged routines were
                         -- explained pauses the reader could not see — ~79% of the
                         -- stale-paused-routines alarm population was this mismatch.
                         -- pausedAtMs is epoch MILLISECONDS as a JSON number: the reader
                         -- gates on typeof pausedAtMs === 'number', so a string here would
                         -- read as missing and reintroduce the same false positive silently.
                         -- The legacy loop_paused_* keys stay — carry-note-pause-declaration
                         -- reads them, and this is an ADD, not a rename.
                         -- (NB: no backticks in this comment — it lives inside a tagged
                         --  template literal, where a backtick would terminate the string.)
                         'pause', jsonb_build_object(
                           'reason', ${reason}::text,
                           'pausedAtMs', (extract(epoch from now()) * 1000)::bigint
                         ),
                         -- OLD value: in an UPDATE, a column read in the SET expression is
                         -- the pre-update one, so this captures what we are about to null.
                         'loop_paused_next_fire_at', to_jsonb(next_fire_at::text)
                       ),
           updated_at = now()
      -- WI-37571: snapshot the PRE-update row so the transition log can record what actually
      -- changed. A subquery in FROM is evaluated against the statement-start snapshot, so
      -- was_active is the value before this write. Joined on the same primary key, so it
      -- selects exactly the row the old single-predicate form selected -- 0 rows in, 0 rows
      -- updated, identical semantics. RETURNING is likewise purely additive: it cannot change
      -- which rows are updated, which is what makes this safe on a load-bearing guard write.
      -- (NB: no backticks in this comment -- it lives inside a tagged template literal, where
      --  a backtick would terminate the string.)
      FROM (
        SELECT id AS prev_id, active AS was_active, next_fire_at::text AS prev_next_fire_at
          FROM harness_shared.routines
         WHERE id = ${routineId}
      ) AS prev
     WHERE r.id = prev.prev_id
    RETURNING r.workspace_id, r.install_slug, r.name, r.target_role, r.target_owner_id,
              r.reschedule_interval_sec, prev.was_active, prev.prev_next_fire_at
  `;

  // WI-37571 — the durable disarm record. Fire-and-forget and deliberately NOT awaited: this
  // module's log is EVIDENCE, never an input to scheduling, and an instrument that can fail
  // the write it reports on is worse than no instrument (loop-transition-log.ts's invariant).
  //
  // Emitted ONLY when the row genuinely crossed TRUE -> FALSE. This write has no
  // `AND active = TRUE` guard, so re-pausing an already-inactive routine re-stamps its
  // metadata and would otherwise log a disarm that never happened — inflating exactly the
  // count this item's falsifier reconciles against the routines-metadata census.
  const row = paused[0];
  if (row && row.was_active) {
    void recordLoopTransition(sql, {
      workspaceId: row.workspace_id,
      installSlug: row.install_slug,
      routineId,
      routineName: row.name,
      targetRole: row.target_role,
      targetOwnerId: row.target_owner_id,
      event: 'disarmed',
      actor,
      newNextFireAt: null, // a disarm writes no fire time — the column's documented NULL case
      intervalSec: row.reschedule_interval_sec,
      // `reason` is the full guard-authored string (e.g. "stalled-loops-guard (WI-6639): ..."),
      // so the disarming guard stays recoverable even when the caller passed no explicit actor.
      // `pausedNextFireAt` preserves the EI-19406534159939583 discriminator — 'infinity' means
      // the loop was parked in-flight and the re-arm path broke, a concrete instant means fires
      // were landing and no turn came of them. Those are different faults with different fixes.
      detail: { reason, pausedNextFireAt: row.prev_next_fire_at },
    });
  }
}

export interface LoopCostGuardDeps {
  /** Injected for tests; defaults to the real best-effort attribution read. */
  readSpend?: typeof readLoopSpendCents;
  /** Injected for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
}

export interface LoopCostCapResult {
  breach: boolean;
  spendCents: number;
  capCents: number | null;
}

/**
 * The cost-cap gate the loop fire consults BEFORE waking. No cap configured ⇒ never breaches
 * (zero reads). With a cap: window the bound owner's cumulative spend since the loop armed
 * (the routine's `created_at`) and, on breach, auto-pause the routine and report it so the
 * fire is withheld.
 */
export async function checkLoopCostCap(
  input: {
    sql?: Sql;
    routineId: string;
    targetOwnerId: string;
    capCents: number | null | undefined;
  },
  deps: LoopCostGuardDeps = {},
): Promise<LoopCostCapResult> {
  const cap = input.capCents;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) {
    return { breach: false, spendCents: 0, capCents: null };
  }
  const db = input.sql ?? getOrgPg().sql;
  const readSpend = deps.readSpend ?? readLoopSpendCents;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;

  // Arm anchor = the routine's created_at (when the loop was armed). Cumulative-since-arm is
  // the "total budget" semantic; a re-armed loop keeps the original created_at, which slightly
  // over-counts but is safe (errs toward pausing sooner) and is the documented v1 behavior.
  const armed = await db<Array<{ armed_ms: string | number | null }>>`
    SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS armed_ms
      FROM harness_shared.routines
     WHERE id = ${input.routineId}
  `;
  const armedAtMs = Number(armed[0]?.armed_ms ?? 0);

  const spendCents = await readSpend({ sql: db, targetOwnerId: input.targetOwnerId, sinceMs: armedAtMs });
  const { breach } = evaluateLoopCostCap({ spendCents, capCents: cap });
  if (breach) {
    await autoPause(db, input.routineId, `cost-cap breached: ${spendCents}¢ > ${cap}¢ (cumulative since arm)`);
  }
  return { breach, spendCents, capCents: cap };
}
