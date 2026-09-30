/**
 * correction-decay-miner.ts — P-019 (coordination-spec-adoption-2026-08-03): the CAPTURE
 * and MEMORY side of D-104's endgame check.
 *
 * `../../correction-decay.ts` is the pure measurement layer (probes / rollup / grade /
 * describe, all unit-testable without PG). This module is the tick that runs it on a
 * cadence, PERSISTS each day's counts, and files a promotion proposal against any rule
 * whose coerced shape has stopped decaying — the same split `tool-rejection-miner.ts` has
 * between its measurement module and its tick.
 *
 * ## Why this tick has to remember, when its siblings do not
 *
 * `tool_invocations` retains roughly 14 days. Every other miner beside this one asks a
 * question that fits inside that window ("is this verb rejecting people THIS week?"). This
 * one asks whether a correction's population has fallen since the correction shipped, and
 * that comparison outlives the raw rows by construction: the baseline is, by definition,
 * the period BEFORE the rule landed, and it ages out while the current window is still
 * accumulating.
 *
 * So each tick folds the live window into a persisted per-day snapshot and grades the
 * union. The raw rows stay the source of truth; the snapshot is only memory of rows that
 * have since been pruned. Days present in both are deduped by (rule, day) in
 * `rollupCorrectionShape`, so re-reading an already-snapshotted day is idempotent rather
 * than double-counted.
 *
 * ## Where the snapshot lives, and why not a new table
 *
 * In this routine's OWN `harness_shared.routines.metadata`, under `correction_decay` —
 * the same place `green-checkpoint` keeps `gate_health` and `gitnexus-reindex` keeps
 * `gitnexus_health`. It is small and bounded by construction (see
 * {@link mergeCorrectionSnapshot}: at most ~90 day-rows per rule, each four integers), it
 * belongs to exactly one routine, and nothing else reads it. A migration for a table with
 * one writer and one reader would be a new durable surface where an existing one already
 * fits — the reuse-first smell the repo guide names.
 *
 * ## What it deliberately does NOT do
 *
 * Change a schema. A promotion is an API decision — it retires a declared shape that other
 * callers may depend on — so this files the evidence as a proposal and stops. Nothing here
 * pages either: `gradeCorrectionDecay` has no `broken` branch, because a correction that
 * became permanent is a design debt, not an outage.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  CORRECTION_DECAY_MAX_PER_TICK,
  CORRECTION_DECAY_PROBES,
  describeCorrectionPromotion,
  gradeCorrectionDecay,
  readCorrectionShapeDays,
  rollupCorrectionShape,
  type CorrectionDecayProbe,
  type CorrectionDecayThresholds,
  type CorrectionShapeDayRow,
  type RunQuery,
} from '../../correction-decay';
import { captureImprovement, type CaptureDeps, type CaptureImprovementResult } from './capture-core';

/** The routine whose metadata carries the snapshot. */
export const CORRECTION_DECAY_ROUTINE_TARGET = 'system:improvement-correction-decay';

/** The metadata key holding it. */
export const CORRECTION_DECAY_METADATA_KEY = 'correction_decay';

/**
 * Pre-correction days retained per rule. The baseline is the OLDEST data and the entire
 * reason the snapshot exists, so it is retained on its own budget and can never be evicted
 * by newer days — the failure a plain "keep the newest N" prune would produce, silently,
 * months later.
 */
export const CORRECTION_DECAY_BASELINE_KEEP_DAYS = 30;

/** Post-correction days retained per rule. */
export const CORRECTION_DECAY_CURRENT_KEEP_DAYS = 60;

/** `[fieldCalls, coercedCalls, coercedOkCalls, distinctOwners]` — tuple-packed to keep the jsonb small. */
export type CorrectionDayTuple = readonly [number, number, number, number];

export interface CorrectionDecaySnapshot {
  /** Shape version, so a later change is detectable rather than silently mis-parsed. */
  v: 1;
  /** rule → `YYYY-MM-DD` → counts. */
  days: Record<string, Record<string, CorrectionDayTuple>>;
  /** When the snapshot was last folded, ISO-8601. */
  updatedAt: string;
}

export const EMPTY_CORRECTION_DECAY_SNAPSHOT: CorrectionDecaySnapshot = {
  v: 1,
  days: {},
  updatedAt: '',
};

/** Snapshot → day rows. PURE. Unknown/!=1 versions read as empty rather than half-parsed. */
export function snapshotToRows(snap: unknown): CorrectionShapeDayRow[] {
  if (!snap || typeof snap !== 'object') return [];
  const s = snap as Partial<CorrectionDecaySnapshot>;
  if (s.v !== 1 || !s.days || typeof s.days !== 'object') return [];
  const out: CorrectionShapeDayRow[] = [];
  for (const [rule, days] of Object.entries(s.days)) {
    if (!days || typeof days !== 'object') continue;
    for (const [day, tuple] of Object.entries(days)) {
      if (!Array.isArray(tuple) || tuple.length < 4) continue;
      out.push({
        rule,
        day,
        fieldCalls: Number(tuple[0]) || 0,
        coercedCalls: Number(tuple[1]) || 0,
        coercedOkCalls: Number(tuple[2]) || 0,
        distinctOwners: Number(tuple[3]) || 0,
      });
    }
  }
  return out;
}

/**
 * Fold fresh day rows into the stored snapshot and prune it. PURE.
 *
 * Fresh rows WIN over stored ones for the same (rule, day): a day re-read while it is still
 * in progress must be corrected upward by the next tick, never frozen at its first partial
 * reading.
 *
 * Pruning keeps two budgets per rule rather than one, for the reason on
 * {@link CORRECTION_DECAY_BASELINE_KEEP_DAYS}: the newest
 * {@link CORRECTION_DECAY_BASELINE_KEEP_DAYS} days that are strictly BEFORE the rule was
 * first observed serving, plus the newest {@link CORRECTION_DECAY_CURRENT_KEEP_DAYS} days
 * from that point on. Before the rule has ever been observed serving there is no pivot yet,
 * so every day counts as baseline and is retained on the baseline budget.
 */
export function mergeCorrectionSnapshot(
  stored: unknown,
  fresh: readonly CorrectionShapeDayRow[],
  opts: { baselineKeep?: number; currentKeep?: number; now?: Date } = {},
): { snapshot: CorrectionDecaySnapshot; rows: CorrectionShapeDayRow[] } {
  const baselineKeep = opts.baselineKeep ?? CORRECTION_DECAY_BASELINE_KEEP_DAYS;
  const currentKeep = opts.currentKeep ?? CORRECTION_DECAY_CURRENT_KEEP_DAYS;

  const byRule = new Map<string, Map<string, CorrectionShapeDayRow>>();
  const put = (r: CorrectionShapeDayRow): void => {
    if (!r.rule || !r.day) return;
    let days = byRule.get(r.rule);
    if (!days) {
      days = new Map();
      byRule.set(r.rule, days);
    }
    days.set(r.day, r);
  };
  for (const r of snapshotToRows(stored)) put(r);
  for (const r of fresh) put(r); // fresh wins on collision — see the docblock

  const days: Record<string, Record<string, CorrectionDayTuple>> = {};
  const rows: CorrectionShapeDayRow[] = [];
  for (const [rule, dayMap] of byRule) {
    const sorted = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    let liveFrom: string | null = null;
    for (const r of sorted) {
      if (r.coercedOkCalls > 0 && (liveFrom === null || r.day < liveFrom)) liveFrom = r.day;
    }
    const pivot = liveFrom;
    const baseline = pivot === null ? sorted : sorted.filter((r) => r.day < pivot);
    const current = pivot === null ? [] : sorted.filter((r) => r.day >= pivot);
    const kept = [...baseline.slice(-baselineKeep), ...current.slice(-currentKeep)];
    if (kept.length === 0) continue;
    const perDay: Record<string, CorrectionDayTuple> = {};
    for (const r of kept) {
      perDay[r.day] = [r.fieldCalls, r.coercedCalls, r.coercedOkCalls, r.distinctOwners];
      rows.push(r);
    }
    days[rule] = perDay;
  }

  return {
    snapshot: { v: 1, days, updatedAt: (opts.now ?? new Date()).toISOString() },
    rows,
  };
}

export interface CorrectionDecayMinerOptions {
  /** Live lookback. Only needs to exceed the tick interval; the snapshot carries history. */
  windowDays?: number;
  maxPerTick?: number;
  thresholds?: CorrectionDecayThresholds;
  probes?: readonly CorrectionDecayProbe[];
}

export interface CorrectionDecayMinerResult {
  /** Rules measured this tick. */
  rulesSeen: number;
  /** Day-rows folded (live + replayed snapshot, deduped). */
  daysSeen: number;
  /** The one-line rating, carried so a tick that files nothing is still legible in the log. */
  rating: string;
  evidence: string;
  /** Rules whose coerced shape has stopped decaying. */
  notDecaying: number;
  /** Ids of newly-created improvement items this tick. */
  captured: string[];
  /** Rules declined as a likely duplicate of an already-open item. */
  declined: number;
  /** Capture calls that errored (never blocks the rest of the tick). */
  failed: number;
  /** True when the snapshot was written back. */
  snapshotted: boolean;
}

/** Default runner: the org pool, matching how the sibling rate readers are wired. */
function defaultRunQuery(): RunQuery {
  const { sql } = getOrgPg();
  return async <T = unknown>(q: string, params: unknown[]): Promise<T[]> =>
    (await sql.unsafe(q, params as never)) as unknown as T[];
}

async function readStoredSnapshot(installSlug: string): Promise<unknown> {
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'${CORRECTION_DECAY_METADATA_KEY}' AS snap
       FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = '${CORRECTION_DECAY_ROUTINE_TARGET}'`,
    [installSlug],
  )) as Array<{ snap: unknown }>;
  return rows[0]?.snap ?? null;
}

async function writeSnapshot(installSlug: string, snap: CorrectionDecaySnapshot): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = '${CORRECTION_DECAY_ROUTINE_TARGET}'`,
    [installSlug, JSON.stringify({ [CORRECTION_DECAY_METADATA_KEY]: snap })],
  );
}

/**
 * The scheduled tick: read the live window → fold it into the persisted snapshot → grade
 * the union → file one promotion proposal per rule that has stopped decaying.
 *
 * Self-measuring (close-loop D-006 pattern, like its siblings): the returned counts make
 * this detector's own yield visible in the routine's log line, so a tick that files nothing
 * is distinguishable from a tick that never ran.
 */
export async function runCorrectionDecayMinerTick(
  installSlug: string,
  workspaceId: string,
  opts: CorrectionDecayMinerOptions = {},
  deps: {
    runQuery?: RunQuery;
    capture?: typeof captureImprovement;
    captureDeps?: CaptureDeps;
    readSnapshot?: (installSlug: string) => Promise<unknown>;
    writeSnapshot?: (installSlug: string, snap: CorrectionDecaySnapshot) => Promise<void>;
    now?: Date;
  } = {},
): Promise<CorrectionDecayMinerResult> {
  const probes = opts.probes ?? CORRECTION_DECAY_PROBES;
  const capture = deps.capture ?? captureImprovement;
  const maxPerTick = opts.maxPerTick ?? CORRECTION_DECAY_MAX_PER_TICK;
  const runQuery = deps.runQuery ?? defaultRunQuery();

  const fresh: CorrectionShapeDayRow[] = [];
  for (const probe of probes) {
    fresh.push(
      ...(await readCorrectionShapeDays(runQuery, probe, {
        workspaceId,
        windowDays: opts.windowDays,
      })),
    );
  }

  const stored = await (deps.readSnapshot ?? readStoredSnapshot)(installSlug);
  const merged = mergeCorrectionSnapshot(stored, fresh, { now: deps.now });
  let snapshotted = false;
  try {
    await (deps.writeSnapshot ?? writeSnapshot)(installSlug, merged.snapshot);
    snapshotted = true;
  } catch (e) {
    // A failed write costs this tick's memory, not its verdict: the union of the live
    // window and the PREVIOUS snapshot is still what was graded, so the reading below is
    // unaffected. Losing the day silently would be the real defect, so it is reported.
    console.warn(
      '[improvement-correction-decay] snapshot write FAILED (grading proceeded on the live union):',
      e instanceof Error ? e.message : e,
    );
  }

  const roll = rollupCorrectionShape(merged.rows, probes, opts.thresholds);
  const grade = gradeCorrectionDecay(roll);

  const capturedIds: string[] = [];
  let declined = 0;
  let failed = 0;
  for (const row of roll.notDecaying.slice(0, maxPerTick)) {
    const finding = describeCorrectionPromotion(row);
    try {
      const result: CaptureImprovementResult = await capture(
        {
          kind: 'change',
          title: finding.title,
          body: finding.body,
          severity: 'minor',
          subTopic: 'correction-decay',
          scope: 'operator',
          sourceRole: 'system',
          dedupScope: 'open',
          watchdogKey: finding.watchdogKey,
          findingClass: finding.watchdogKey,
        },
        deps.captureDeps,
      );
      if (result.created) capturedIds.push(result.issue?.id ?? '(unknown-id)');
      else declined += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `[improvement-correction-decay] capture failed for ${row.rule}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    rulesSeen: roll.rules.length,
    daysSeen: roll.daysSeen,
    rating: grade.rating,
    evidence: grade.evidence,
    notDecaying: roll.notDecaying.length,
    captured: capturedIds,
    declined,
    failed,
    snapshotted,
  };
}
