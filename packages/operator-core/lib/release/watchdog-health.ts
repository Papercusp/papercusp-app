/**
 * Make a release watchdog's OWN failure visible (EI-21297913810967409).
 *
 * `green-stall-watchdog.ts` runs five passes over the release safety net — the stranded-pause
 * scan, green-stall, main-behind-staging, release-trigger-freeze, release-trigger-fire-stale.
 * Each is wrapped in a try/catch that emits a `console.warn(... (non-fatal))` and returns an
 * empty result. That TOLERANCE is correct and is deliberately preserved: one broken scan must
 * not take down the other four. The defect is INVISIBILITY — from outside, "the guard ran and
 * found nothing" and "the guard could not run" are identical, because both produce silence.
 *
 * The verified instance: the stranded-pause scan joined `harness_shared.coord_presence` on
 * `cp.revoked_at`, a column that does not exist. Postgres rejected the whole statement on every
 * run for as long as the predicate had been there, so the stranded-pause guard never returned a
 * row in its life — and the only witness was a console line nobody greps
 * (EI-21291109975568717). A watchdog is the one component where a swallowed error is least
 * acceptable, because its entire job is to notice that something else stopped working.
 *
 * ── WHERE THIS WRITES ────────────────────────────────────────────────────────────────────────
 * Each pass records on the routine row it WATCHES: the green-checkpoint passes on the
 * green-checkpoint rows, the release-trigger passes on the release-trigger row. So an agent who
 * reaches for `routines:list { name:'release-trigger' }` learns that the watcher of THAT routine
 * is broken, without having to know this module exists.
 *
 * The write scope is COPIED FROM THE PASS'S OWN SCAN SCOPE, which is why an install-wide write
 * here is not the unscoped-write mistake its sibling {@link ./gate-health-merge} warns about.
 * `checkGreenStall` scans every green-checkpoint row with no install or workspace filter; when it
 * throws, every one of those rows genuinely went unwatched, so every one carries the marker.
 * That is the opposite of gate-health-merge's case, where ONE run's marker leaked onto another
 * tenant's row. A pass that scans a single install (`main-behind-staging`, both release-trigger
 * passes) passes its `installSlug` and writes only there.
 *
 * ── WHY NOT gate_health ──────────────────────────────────────────────────────────────────────
 * `gate_health` is a cache of the GATE'S VERDICT — consecutiveReds, failingTests,
 * observedCandidate — and is already routinely misread as live when it is a frozen artifact of
 * an old run (see gate-verdict-freshness.ts). Folding "the thing that WATCHES the gate is
 * broken" into that same blob would fuse two independent subjects into one field an agent
 * already mistrusts. This is a separate top-level metadata key, surfaced by the same
 * `routines:list` health projection.
 *
 * ── WHY NEITHER STATEMENT TOUCHES `updated_at` ───────────────────────────────────────────────
 * When this file was written, `updated_at` was not bookkeeping on this table — it was a SIGNAL:
 * `evaluateReleaseTriggerFreeze` derived the age of a pause from `now - updated_at`. Both
 * release-trigger passes write to THAT row, so a `SET updated_at = now()` here would have reset
 * the age of the very freeze they exist to detect — every failing pass refreshing the clock, and
 * the silent fleet-wide deploy freeze (recurred 2026-06-18 and 2026-07-12, no auto-recovery
 * either time, "will NEVER self-clear") simply never alarming.
 *
 * That near-miss is what prompted EI-21299569563939689, and migration 933 has since removed the
 * hazard at its root: the pause age now comes from `active_changed_at`, stamped by a database
 * trigger ONLY when `active` actually flips, so no metadata write here or anywhere else can move
 * it. The omission below is therefore no longer load-bearing for that alarm — it is kept because
 * `updated_at` remains a shared column with no single owner, and a diagnostic has no business
 * claiming one. The marker carries its own `lastErrorAt`; nothing here needs the column.
 *
 * (The original near-miss was caught by an existing assertion in green-stall-watchdog.test.ts
 * that the salvage path writes nothing — a guard that looked like it was merely being pedantic
 * about SQL. Worth remembering the next time one of those looks like a nuisance.)
 *
 * ── BEST-EFFORT, and the one rung it cannot reach ────────────────────────────────────────────
 * Both writes swallow their own errors: a diagnostic must never break, or slow, the watchdog it
 * describes. That leaves one honest gap — if THIS write is what is broken, the failure is
 * invisible in exactly the way this module exists to fix, since the database is the recording
 * surface. It is logged under a distinct `[watchdog-health]` prefix so the console retains a
 * witness, and there is no lower rung available without inventing a second store.
 */
import type { Sql } from 'postgres';

/**
 * The `harness_shared.routines.metadata` key these markers live under.
 *
 * IMPORTED by the `routines:list` health projection rather than re-typed there, so the reader
 * cannot drift from this writer — the same discipline `ROUTINE_VALIDATION_METADATA_KEY` follows,
 * and for the same reason: that key's detector worked for months while nothing surfaced it.
 */
export const WATCHDOG_HEALTH_METADATA_KEY = 'watchdog_health';

/** The six passes in `green-stall-watchdog.ts` that swallow their own failure. */
export type WatchdogPassName =
  | 'paused-green-checkpoint'
  | 'green-stall'
  | 'main-behind-staging'
  | 'release-trigger-freeze'
  | 'release-trigger-fire-stale'
  | 'stranded-repair-queue';

export interface WatchdogPassScope {
  /** `routines.name` of the routine this pass watches. */
  routineName: 'green-checkpoint' | 'release-trigger';
  /** Limit to one install. Omitted ⇒ every row of that routine, matching a pass that scans them all. */
  installSlug?: string;
}

/** What one pass's entry under `metadata.watchdog_health` looks like to a reader. */
export interface WatchdogPassHealth {
  lastError: string;
  lastErrorAt: string;
  consecutiveFailures: number;
}

/** Error text is a diagnostic, not a payload — cap it so a pathological message cannot bloat the row. */
const MAX_ERROR_CHARS = 400;

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw;
}

/**
 * Record ONE pass's outcome. `error === undefined` ⇒ the pass completed, so any standing marker
 * for it is cleared; anything else ⇒ the pass failed, so the marker is written and its
 * consecutive-failure count incremented.
 *
 * Call this from a `finally`, not from the tail of the `try`: every one of these passes has
 * early `return out` paths (`alreadyAlarmed`, "no deploy target declared"), and a clear reached
 * only by the tail would leave a stale marker standing while the pass is in fact succeeding —
 * a watchdog falsely reported broken, which is the same class of wrong reading as the silence
 * this module removes. A `finally` covers every exit, including ones added later.
 *
 * NEVER THROWS: it runs inside the watchdog's own `finally`, where a throw would replace the
 * pass's return value.
 *
 * @returns rows written (0 when there was nothing to clear — the healthy steady state).
 */
export async function recordWatchdogPassOutcome(
  sql: Sql,
  pass: WatchdogPassName,
  scope: WatchdogPassScope,
  error?: unknown,
): Promise<number> {
  try {
    return error === undefined
      ? await clearWatchdogPassFailure(sql, pass, scope)
      : await recordWatchdogPassFailure(sql, pass, scope, error);
  } catch (e) {
    console.warn(
      `[watchdog-health] could not record ${pass} outcome (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

/**
 * Write `{ lastError, lastErrorAt, consecutiveFailures }` for one pass.
 *
 * The nesting is built by MERGING into the parent object rather than by `jsonb_set`-ing a
 * two-level path: `jsonb_set(metadata, '{watchdog_health,green-stall}', …)` returns the row
 * UNCHANGED when `watchdog_health` does not yet exist, which would make the first failure — the
 * one that matters most — silently vanish. That is the very shape of bug this file exists to
 * surface, so it is not reproduced here.
 */
async function recordWatchdogPassFailure(
  sql: Sql,
  pass: WatchdogPassName,
  scope: WatchdogPassScope,
  error: unknown,
): Promise<number> {
  const slug = scope.installSlug ?? null;
  const res = await sql`
    /* watchdog-health (EI-21297913810967409) — a liveness marker, NOT watchdog state. Tests that
       assert a pass writes no routine STATE key off this marker; keep it in both statements. */
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             ARRAY[${WATCHDOG_HEALTH_METADATA_KEY}]::text[],
             COALESCE(metadata->${WATCHDOG_HEALTH_METADATA_KEY}, '{}'::jsonb)
               || jsonb_build_object(
                    ${pass}::text,
                    jsonb_build_object(
                      'lastError', ${errorText(error)}::text,
                      'lastErrorAt', ${new Date().toISOString()}::text,
                      'consecutiveFailures',
                        COALESCE(
                          (metadata->${WATCHDOG_HEALTH_METADATA_KEY}->${pass}->>'consecutiveFailures')::int,
                          0
                        ) + 1
                    )
                  ),
             true
           )
     WHERE name = ${scope.routineName}
       AND (${slug}::text IS NULL OR install_slug = ${slug}::text)`;
  return res.count ?? 0;
}

/**
 * Remove one pass's marker, and the parent key too once it is empty — so a healthy net leaves no
 * residue in the health projection at all.
 *
 * The `jsonb_exists` guard in the WHERE clause is load-bearing: without it every healthy tick
 * would rewrite `updated_at` on every routine row it watches, turning a diagnostic into
 * write churn on a table other watchdogs read for freshness.
 */
async function clearWatchdogPassFailure(sql: Sql, pass: WatchdogPassName, scope: WatchdogPassScope): Promise<number> {
  const slug = scope.installSlug ?? null;
  const res = await sql`
    /* watchdog-health (EI-21297913810967409) — a liveness marker, NOT watchdog state. */
    UPDATE harness_shared.routines
       SET metadata = CASE
             WHEN (metadata #- ARRAY[${WATCHDOG_HEALTH_METADATA_KEY}, ${pass}]::text[])
                    -> ${WATCHDOG_HEALTH_METADATA_KEY} = '{}'::jsonb
               THEN (metadata #- ARRAY[${WATCHDOG_HEALTH_METADATA_KEY}, ${pass}]::text[])
                      - ${WATCHDOG_HEALTH_METADATA_KEY}
             ELSE  metadata #- ARRAY[${WATCHDOG_HEALTH_METADATA_KEY}, ${pass}]::text[]
           END
     WHERE name = ${scope.routineName}
       AND (${slug}::text IS NULL OR install_slug = ${slug}::text)
       AND jsonb_exists(metadata->${WATCHDOG_HEALTH_METADATA_KEY}, ${pass})`;
  return res.count ?? 0;
}
