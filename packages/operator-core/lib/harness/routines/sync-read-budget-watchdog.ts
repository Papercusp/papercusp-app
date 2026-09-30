/**
 * sync-read-budget-watchdog.ts — EI-19457924854150358, the WARN half.
 *
 * The `syncReads.audit` producer (derived-reads/producers.ts) now MEASURES every
 * sync read daily. This is the leg that makes a breach reach a human: without it
 * the measurement lands in a snapshot nobody reads, which is only marginally
 * better than the original defect (an audit nothing ran).
 *
 * ── Two legs, deliberately, because there are two ways to lose ─────────────────
 *
 *  BREACH — a read is over its byte ceiling. Two disjoint buckets, kept disjoint
 *    (collapsing them is the WI-7084 defect the audit exists to surface):
 *      `violations`         = newly fat and NOT allowlisted.
 *      `ratchetRegressions` = allowlisted yet busting its OWN recorded ceiling.
 *        This is the LOUDER one: someone already looked at that read, wrote a
 *        number down, and it has since rotted. Every byte cut on
 *        `no-http-anywhere-2026-07-28` ratchets a ceiling down so the win cannot
 *        silently drift back — a promise that is only real if something re-checks.
 *
 *  BLIND — the audit itself stopped producing (snapshot missing, or older than
 *    `blindAfterMs`). A watchdog with only the breach leg goes quiet in exactly
 *    the case where it can no longer see anything, i.e. it would report "healthy"
 *    while the instrument is dead. That is the ORIGINAL defect wearing a new
 *    costume, so it gets its own alarm and its own scope key. (`plans.list`
 *    drifted past its ceiling for ~12h and was found by luck; the whole point of
 *    this item is that "nobody is watching" must itself be observable.)
 *
 * ── Deliberate non-behaviours ─────────────────────────────────────────────────
 *
 *  • WARNS, NEVER BLOCKS. `no-http-anywhere-2026-07-28` #D-009 draws the line: an
 *    INVARIANT blocks, a BUDGET warns. #D-011 adds that `invariant: true` is for a
 *    property of the SHIPPED APP, explicitly not for harness/instrument health —
 *    "the remedy for a blind instrument is a RED SPEC, not a blocked deploy". A
 *    payload ceiling drifts with CONTENT (plans grow ~45-50/week), so gating
 *    deploys on it would red on days when nobody changed any code.
 *
 *  • BYTES ONLY — `overMs` is deliberately ignored. `SyncReadAuditReport.host`
 *    documents why: `ms` is load-DEPENDENT and `bytes` is not. Measured on a
 *    loaded box, `plans.attentionCounts` returned 103 bytes in 442ms — a 103-byte
 *    response cannot be slow for payload reasons; that is queue time. On that same
 *    run three of four ratchetRegressions were flagged on latency alone. Paging on
 *    that axis would send a reader chasing ghosts, and WI-7084's latency-axis
 *    design call is genuinely unresolved. Ship the payload bucket; leave latency
 *    non-failing until someone decides what it should mean.
 *
 *  • READS THE TABLE DIRECTLY, never `readDerivedSnapshot`. Originally because that
 *    helper kicked a fire-and-forget `warmMissedSnapshot` on a miss, which calls
 *    `refreshDerivedReads({ only, force })` — and `only` intentionally OVERRIDES
 *    `excludeFromDefaultSweep`. So reading this snapshot through the normal helper
 *    would have launched the ~12-minute audit as a SIDE EFFECT OF A HEALTH CHECK,
 *    on a routinesTick cadence, defeating the very flag that keeps it off the
 *    shared sweep. ⚠ That hazard is now FIXED at the source (EI-19480218051289304:
 *    `warmMissedSnapshot` declines an `excludeFromDefaultSweep` producer outright),
 *    so the helper is safe here today — this stays a direct read only because the
 *    watchdog wants the raw `computed_at`/`error` columns, not because it must dodge
 *    a warm. The principle it was reasoning from still stands: a watchdog must
 *    observe, never cause.
 *
 * Kill switch: PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC <= 0 disables the sweep.
 * Fail-soft throughout — a watchdog must never be able to break the tick it rides.
 */

import { claimWatchdogFire } from '../../pot/watchdog';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** The producer key this watchdog observes. */
const SNAPSHOT_KEY = 'syncReads.audit';
/** `scope: 'workspace'` producers are stored under the empty-string harness sentinel. */
const GLOBAL_SCOPE = '';
/** Default: the audit is daily, so ~2 missed days is unambiguous, not a blip. */
const DEFAULT_BLIND_AFTER_SEC = 2 * 24 * 60 * 60;

export function syncReadBudgetBlindAfterSec(): number {
  const raw = process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC;
  if (raw == null || raw.trim() === '') return DEFAULT_BLIND_AFTER_SEC;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_BLIND_AFTER_SEC;
}

export interface SyncReadBudgetRow {
  name: string;
  bytes: number;
  byteCeil: number;
  overBytes: boolean;
  allowlisted: boolean;
}

export interface SyncReadBudgetInput {
  /** Epoch ms the snapshot was computed; null when there is no usable snapshot. */
  computedAtMs: number | null;
  nowMs: number;
  blindAfterMs: number;
  /** The producer's own last compute error, when the most recent refresh failed. */
  producerError?: string | null;
  /**
   * Epoch ms the audit routine is NEXT due, when it exists and has NEVER fired —
   * i.e. a legitimate cold start. Null when the routine has already fired at least
   * once, is absent, or could not be read.
   *
   * Without this, a COLD START is indistinguishable from a DEAD AUDIT: both show
   * "no snapshot". The first deploy after this ships would page a BLIND alarm for
   * a routine that is simply not due yet — a false alarm on day one, which is the
   * fastest way to teach everyone to ignore this watchdog (the fatigue trap D-006
   * forbids). A routine that is scheduled and not yet due is PENDING, not blind.
   */
  firstFireDueAtMs?: number | null;
  violations: SyncReadBudgetRow[];
  ratchetRegressions: SyncReadBudgetRow[];
}

export type SyncReadBudgetVerdict =
  | { state: 'pending'; scope: null; reason: string }
  | { state: 'blind'; scope: 'blind'; reason: string; ageMs: number | null }
  | {
      state: 'breach';
      scope: 'breach';
      reason: string;
      violations: string[];
      ratchetRegressions: string[];
    }
  | { state: 'healthy'; scope: null; reason: string };

/**
 * PURE decider — no I/O, so the interesting cases are unit-testable without a
 * populated operator (the constraint that kept this audit un-run for so long).
 */
export function evaluateSyncReadBudget(input: SyncReadBudgetInput): SyncReadBudgetVerdict {
  const { computedAtMs, nowMs, blindAfterMs, producerError } = input;

  if (computedAtMs == null) {
    // COLD START, not a failure: the routine exists, has never fired, and is not
    // due yet. Alarming here would fire on every fresh install / first deploy.
    const dueAt = input.firstFireDueAtMs;
    if (dueAt != null && dueAt > nowMs) {
      return {
        state: 'pending',
        scope: null,
        reason:
          `${SNAPSHOT_KEY} not yet computed — audit routine scheduled and first due in ` +
          `${Math.round((dueAt - nowMs) / 60_000)}m (cold start, not a failure)`,
      };
    }
    return {
      state: 'blind',
      scope: 'blind',
      ageMs: null,
      reason:
        `no ${SNAPSHOT_KEY} snapshot exists — the sync-read payload audit has never produced a result ` +
        `(routine 'sync-read-audit' missing, inactive, or failing)` +
        (producerError ? `; last producer error: ${producerError}` : ''),
    };
  }

  const ageMs = nowMs - computedAtMs;
  if (ageMs > blindAfterMs) {
    return {
      state: 'blind',
      scope: 'blind',
      ageMs,
      reason:
        `${SNAPSHOT_KEY} snapshot is ${Math.round(ageMs / 3_600_000)}h old (blind after ` +
        `${Math.round(blindAfterMs / 3_600_000)}h) — the daily audit has stopped producing, so no ` +
        `sync read is being checked against its ceiling` +
        (producerError ? `; last producer error: ${producerError}` : ''),
    };
  }

  // BYTES ONLY — see the module doc. A row flagged solely on `overMs` is not a
  // payload regression and must not page.
  const byteOnly = (rows: SyncReadBudgetRow[]) => rows.filter((r) => r.overBytes);
  const violations = byteOnly(input.violations);
  const ratchets = byteOnly(input.ratchetRegressions);

  if (violations.length === 0 && ratchets.length === 0) {
    return {
      state: 'healthy',
      scope: null,
      reason: `${SNAPSHOT_KEY} fresh (${Math.round(ageMs / 60_000)}m old), no read over its byte ceiling`,
    };
  }

  const fmt = (r: SyncReadBudgetRow) => `${r.name} ${r.bytes}B > ${r.byteCeil}B`;
  const parts: string[] = [];
  // Ratchet regressions lead: they are the ones someone already measured.
  if (ratchets.length > 0) {
    parts.push(`${ratchets.length} RATCHET REGRESSION(S) [${ratchets.map(fmt).join('; ')}]`);
  }
  if (violations.length > 0) {
    parts.push(`${violations.length} unallowlisted violation(s) [${violations.map(fmt).join('; ')}]`);
  }

  return {
    state: 'breach',
    scope: 'breach',
    reason: `sync-read payload budget: ${parts.join(', ')}`,
    violations: violations.map((r) => r.name),
    ratchetRegressions: ratchets.map((r) => r.name),
  };
}

function asRows(v: unknown): SyncReadBudgetRow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    if (r == null || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (typeof o.name !== 'string') return [];
    return [
      {
        name: o.name,
        bytes: Number(o.bytes ?? 0),
        byteCeil: Number(o.byteCeil ?? 0),
        // Absent `overBytes` must not be read as "over" — an unknown axis is not a breach.
        overBytes: o.overBytes === true,
        allowlisted: o.allowlisted === true,
      },
    ];
  });
}

export interface SyncReadBudgetSweepResult {
  outcome: 'alerted' | 'healthy' | 'skipped' | 'error';
  verdict?: SyncReadBudgetVerdict;
  reason: string;
  paged?: boolean;
}

/**
 * Ride `routinesTick`: read the snapshot the daily audit wrote, judge it, and page
 * once per episode per scope. Cheap by construction — one indexed SELECT.
 */
export async function syncReadBudgetSweep(opts: {
  workspaceId?: string;
  installSlug?: string;
  now?: number;
}): Promise<SyncReadBudgetSweepResult> {
  const blindAfterSec = syncReadBudgetBlindAfterSec();
  if (blindAfterSec <= 0) {
    return { outcome: 'skipped', reason: 'disabled (PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC <= 0)' };
  }

  try {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const installSlug = opts.installSlug ?? operatorHomeHarnessSlug();
    const now = opts.now ?? Date.now();

    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // Direct read — deliberately NOT readDerivedSnapshot (see module doc: it would
    // trigger a background refresh, i.e. a 12-minute audit, from a health check).
    const rows = (await sql`
      SELECT payload, computed_at, error
        FROM harness_shared.derived_read_snapshots
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${GLOBAL_SCOPE}
         AND key = ${SNAPSHOT_KEY}
       LIMIT 1
    `) as Array<{ payload: unknown; computed_at: string | number | null; error: string | null }>;

    const row = rows[0];
    const payload = (row?.payload ?? null) as Record<string, unknown> | null;
    const computedAtMs = row ? Number(row.computed_at ?? 0) || null : null;

    // Only when there is NO snapshot do we need to tell a cold start from a dead
    // audit — so this second read is skipped on the overwhelmingly common path.
    let firstFireDueAtMs: number | null = null;
    if (computedAtMs == null) {
      try {
        const r = (await sql`
          SELECT next_fire_at, last_fired_at
            FROM harness_shared.routines
           WHERE name = 'sync-read-audit'
             AND install_slug = ${installSlug}
             AND workspace_id = ${workspaceId}
             AND active
           LIMIT 1
        `) as Array<{ next_fire_at: string | Date | null; last_fired_at: string | Date | null }>;
        const rr = r[0];
        if (rr && rr.last_fired_at == null && rr.next_fire_at != null) {
          const t = new Date(rr.next_fire_at).getTime();
          firstFireDueAtMs = Number.isFinite(t) ? t : null;
        }
      } catch {
        // Unreadable ⇒ leave null ⇒ fall through to BLIND. Failing toward the
        // alarm is right here: a routines table we cannot read is itself a reason
        // to doubt the audit is running.
        firstFireDueAtMs = null;
      }
    }

    const verdict = evaluateSyncReadBudget({
      computedAtMs,
      nowMs: now,
      blindAfterMs: blindAfterSec * 1000,
      producerError: row?.error ?? null,
      firstFireDueAtMs,
      violations: asRows(payload?.violations),
      ratchetRegressions: asRows(payload?.ratchetRegressions),
    });

    if (verdict.state === 'healthy' || verdict.state === 'pending') {
      return { outcome: 'healthy', verdict, reason: verdict.reason };
    }

    // Scope key separates the two failure modes so a BLIND alarm can never be
    // debounced away by a BREACH alarm (or vice versa) — they have different
    // owners and different remedies.
    const scopeKey = `sync-read-budget:${verdict.scope}:${installSlug}`;
    const paged = await claimWatchdogFire({
      workspaceId,
      installSlug,
      source: 'sync-read-budget',
      // `scopeKey` is matched via `reason LIKE '%scopeKey%'`, so it must appear
      // verbatim in the reason — routed through scopedFireReason by claimWatchdogFire.
      reason: verdict.reason,
      scopeKey,
      wakeAt: null,
      windowHours: 24,
    });

    return { outcome: 'alerted', verdict, reason: verdict.reason, paged };
  } catch (e) {
    // Fail-soft: never break routinesTick over a budget report.
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
