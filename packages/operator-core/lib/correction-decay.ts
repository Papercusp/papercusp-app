/**
 * correction-decay — D-104's ENDGAME check (coordination-spec-adoption-2026-08-03 P-019).
 *
 * D-104 lets a re-encoding correction auto-run at the tool boundary, on the understanding
 * that a correction is a stopgap: if agents keep sending the coerced shape indefinitely,
 * the schema — not the caller — is the thing that is wrong, and the coerced shape should be
 * PROMOTED to the declared one with the original retired. This module is the instrument
 * that decides that, per RULE.
 *
 * ## What it measures — and the trap it exists to avoid (D-109 / D-113)
 *
 * It measures **the shape agents SENT**, read from `tool_invocations.args_json`. It never
 * derives its rate from `status`.
 *
 * That is the whole design, and it is counter-intuitive enough to state plainly. The
 * obvious instrument — "how often is this verb rejected for this field?" — is
 * ANTI-CORRELATED with the thing it is supposed to watch. `status='invalid-input'` is
 * stamped only when the route's zod parse fails (`endpoint-route/route-stack.ts`,
 * `inputStep`). A re-encoding rule re-validates and returns a value, so the invocation
 * completes as `ok`. Every rule that lands therefore moves its own population OUT of the
 * rejected set: a rejection-keyed decay check reads a clean fall to zero at exactly the
 * moment the coercion becomes most load-bearing, while agent behaviour is unchanged.
 *
 * Measured on live `tool_invocations` before P-016 shipped (2026-09-02, 15d window,
 * `coord:send`): calls sending `premises: [{ref}]` split **1,250 rejected / 0 accepted** —
 * perfect separation. All 1,250 flip to `ok` the day the rule serves. `args_json` is
 * written regardless of outcome, so the same classifier answers the same question either
 * side of that landing; nothing else on the row does.
 *
 * `status` is used in exactly ONE place here, and not as a rate: the first day a
 * coerced-shape call is recorded `ok` is taken as the day the rule STARTED SERVING (see
 * {@link splitOnCoercionLive}). That is a deployment fact this module would otherwise have
 * to hand-maintain in the probe registry, where it would silently rot; deriving it from
 * the ledger is self-correcting and needs no maintenance.
 *
 * ## Why a sibling module and not an extension of tool-rejection-rate.ts
 *
 * `tool-rejection-rate.ts` (P-017) is the closest existing surface, and reuse-first says
 * extend it. It cannot carry this signal:
 *
 *  1. **Different population.** That module's numerator IS `status='invalid-input'` —
 *     precisely the field this one must not read. Extending it would put the anti-correlated
 *     quantity inside the one detector that must be immune to it.
 *  2. **Different key.** It keys on the VERB. D-104 promotes and retires per RULE, and one
 *     verb can carry several rules with independent fates.
 *  3. **Different question.** It asks "is this schema refusing people?" (a rate that SHOULD
 *     fall when fixed). This asks "are agents still reaching for the other shape?" — a rate
 *     whose failure to fall is the finding.
 *
 * What IS reused is its shape: pure `rollup → grade → describe`, injectable `RunQuery`,
 * canonical SQL runnable as-is, day-level counting so "sustained" is expressible, and the
 * capture side split into a separate miner. Same house pattern as
 * `tool-failure-rate.ts` / `empty-result-rate.ts` / `tool-rejection-rate.ts`.
 *
 * ## Why the baseline must be PERSISTED
 *
 * `tool_invocations` retains roughly 14 days. The question D-104 asks spans the life of a
 * correction, which is longer. So the miner snapshots each day's counts into its own
 * routine metadata and folds the persisted history together with the live window — the raw
 * rows are the source, the snapshot is the memory. A check that could only ever see 14 days
 * could never answer "did this ever decay?".
 *
 * ## Thresholds are measured, not guessed
 *
 * Swept against live `tool_invocations` for `premises.unwrap-ref-objects`, 2026-08-19..09-02,
 * entirely BEFORE the coercion shipped — i.e. a period in which, by construction, no decay
 * was possible and every movement is noise:
 *
 * | grain                     | spread observed with no intervention |
 * |---------------------------|--------------------------------------|
 * | single UTC day            | 2.6% .. 20.3% (an 8x swing)          |
 * | 7d window vs the next 6d  | 8.96% -> 11.28% (+25.9% relative)    |
 *
 * The day grain is unusable on its own; the window grain is stable to about 26% relative
 * drift. {@link CORRECTION_DECAY_RELATIVE_DROP_PCT} is therefore 50 — roughly twice the
 * observed no-intervention drift, so ordinary fleet churn cannot be read as learning. The
 * same sweep is why {@link CORRECTION_DECAY_DAY_MIN_CALLS} exists at all: 2 coerced calls
 * out of 246 on a low-traffic day is not a 0.8% design fact.
 *
 * Pure + injectable: `rollupCorrectionShape` / `gradeCorrectionDecay` /
 * `describeCorrectionPromotion` are pure and unit-tested without PG;
 * `readCorrectionShapeDays` runs the canonical SQL through an injected runQuery.
 */

import { DISPATCH_WRAPPER_EXCLUSION_SQL } from './agent-tools/sessions/automatic-tool-names';
import { PREMISES_REENCODING_RULE } from './agent-tools/coordination/message-fields';

/** Injectable query runner (mirrors tool-rejection-rate.ts's RunQuery). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/**
 * One registered re-encoding rule's decay probe.
 *
 * The `rule` id is IMPORTED from the module that declares the rule, never retyped, so the
 * two cannot drift apart (derived-truth-ladder, rung 2 — PIN). `correction-decay.test.ts`
 * additionally asserts that every `ArgReencoding` declared in the tree has a probe here, so
 * a new rule cannot ship unmeasured.
 *
 * The two SQL fragments are correlated boolean expressions over `c.a` — the call's
 * `args_json` as jsonb — and are code constants, never caller input.
 */
export interface CorrectionDecayProbe {
  /** The `ArgReencoding.rule` id, imported from the module declaring it. */
  readonly rule: string;
  /** The verb whose arguments carry the corrected field. */
  readonly toolName: string;
  /** Human-readable field path, for the filed finding. */
  readonly field: string;
  /** What the schema declares today. */
  readonly declaredShape: string;
  /** What agents send instead, and what the rule repairs to the declared form. */
  readonly coercedShape: string;
  /** TRUE when the call exercised the field at all — the denominator. */
  readonly fieldPresentSql: string;
  /** TRUE when the call sent the shape this rule repairs — the numerator. */
  readonly coercedShapeSql: string;
}

/**
 * Sections of a `coord:send` call that can carry `premises`, per the verb's own schema:
 * the top-level `body[]`, and `items[].body[]` for the batch form. Enumerated from the
 * schema rather than walked generically, so the classifier is exact rather than
 * approximate — a `**`-style deep walk would also match a `premises` key nested inside
 * some unrelated payload and quietly inflate both counts.
 */
const COORD_SEND_SECTIONS_SQL = `
      SELECT s FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.a->'body') = 'array' THEN c.a->'body' ELSE '[]'::jsonb END) s
      UNION ALL
      SELECT s2 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.a->'items') = 'array' THEN c.a->'items' ELSE '[]'::jsonb END) it,
           LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(it->'body') = 'array' THEN it->'body' ELSE '[]'::jsonb END) s2`;

/**
 * The registered probes. One per live `ArgReencoding`.
 *
 * The `premises` predicate mirrors `isRefObjectArray` in
 * `agent-tools/coordination/message-fields.ts` exactly — non-empty array, every member an
 * object carrying a non-empty string `ref` — because the numerator must be "calls the rule
 * WOULD repair", not "calls that look roughly like it". The two cases the rule deliberately
 * refuses (a bare-string premise; a member with no `ref`) are excluded here for the same
 * reason: they are the taught-refusal population, not the corrected one.
 */
export const CORRECTION_DECAY_PROBES: readonly CorrectionDecayProbe[] = [
  {
    rule: PREMISES_REENCODING_RULE,
    toolName: 'coord:send',
    field: 'body[].premises',
    declaredShape: 'string[] (an array of ref strings)',
    coercedShape: '{ ref: string }[] (an array of objects carrying a ref)',
    fieldPresentSql: `EXISTS (
    SELECT 1 FROM (${COORD_SEND_SECTIONS_SQL}
    ) sections(s)
     WHERE jsonb_typeof(s->'premises') = 'array'
  )`,
    coercedShapeSql: `EXISTS (
    SELECT 1 FROM (${COORD_SEND_SECTIONS_SQL}
    ) sections(s)
     WHERE jsonb_typeof(s->'premises') = 'array'
       AND jsonb_array_length(s->'premises') > 0
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(s->'premises') p
              WHERE jsonb_typeof(p) <> 'object'
                 OR jsonb_typeof(p->'ref') <> 'string'
                 OR length(btrim(p->>'ref')) = 0)
  )`,
  },
];

/** One rule's counts for ONE UTC day. The SQL's row shape, and the snapshot's unit. */
export interface CorrectionShapeDayRow {
  rule: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Calls that exercised the corrected field at all — the denominator. */
  fieldCalls: number;
  /** Calls that sent the shape this rule repairs. */
  coercedCalls: number;
  /**
   * Coerced-shape calls recorded `ok` that day. Used ONLY to derive when the rule started
   * serving (see the module docblock) — never as a rate.
   */
  coercedOkCalls: number;
  /** Distinct agents sending the coerced shape that day. */
  distinctOwners: number;
}

/** One window's fold over {@link CorrectionShapeDayRow}s. */
export interface CorrectionWindow {
  /** Days with enough traffic to count. */
  days: number;
  fieldCalls: number;
  coercedCalls: number;
  /** Coerced share of field-exercising calls, percent, one decimal. */
  pct: number;
  peakDistinctOwners: number;
  /** Earliest and latest counted day, so a reader can see what period this is. */
  firstDay: string | null;
  lastDay: string | null;
}

export type CorrectionDecayVerdict =
  /** The coercion has not started serving yet — there is no post-intervention window. */
  | 'not-yet-live'
  /** Not enough traffic on one side to say anything. */
  | 'insufficient-data'
  /** The coerced shape is falling away: the correction is teaching. Do NOT promote. */
  | 'decaying'
  /** Agents keep sending it. D-104's endgame applies: promote the coerced shape. */
  | 'not-decaying';

/** One rule's verdict. */
export interface CorrectionDecayRow {
  rule: string;
  toolName: string;
  field: string;
  declaredShape: string;
  coercedShape: string;
  /** UTC day the coercion was first observed serving, or null when it never has been. */
  coercionLiveFrom: string | null;
  /** Everything strictly before `coercionLiveFrom`. */
  baseline: CorrectionWindow;
  /** Everything from `coercionLiveFrom` onward. */
  current: CorrectionWindow;
  /**
   * How far the coerced share fell, as a percentage OF THE BASELINE — not a difference of
   * percentages. A fall from 9% to 8% is a 1-point difference and an 11% relative drop; the
   * relative form is the one that means "agents stopped doing this".
   * Null when the baseline had no coerced calls to fall from.
   */
  relativeDropPct: number | null;
  verdict: CorrectionDecayVerdict;
  /** Why this verdict, in one line — carried so a consumer never re-derives it. */
  because: string;
}

export interface CorrectionDecayRollup {
  rules: CorrectionDecayRow[];
  /** Rules whose coerced shape is NOT decaying — the promotion candidates. */
  notDecaying: CorrectionDecayRow[];
  /** Distinct days of evidence folded, across all rules. */
  daysSeen: number;
}

/** Recent window used when a rule has been live for a long time. Days, UTC. */
export const CORRECTION_DECAY_CURRENT_DAYS = 14;

/**
 * A day counts toward a window only above this many field-exercising calls. Below it the
 * daily share is noise: 2 coerced of 246 on a quiet day is not a design fact.
 */
export const CORRECTION_DECAY_DAY_MIN_CALLS = 20;

/** Per-window floor on counted calls. Below it, no verdict is honest. */
export const CORRECTION_DECAY_MIN_CALLS = 100;

/** Counted days required on EACH side before a comparison is made. */
export const CORRECTION_DECAY_MIN_DAYS = 3;

/**
 * How far the coerced share must fall, relative to baseline, to count as decaying.
 * Measured: adjacent multi-day windows drifted 25.9% relative with no intervention at all,
 * so the bar is set at roughly twice that. See the docblock's threshold table.
 */
export const CORRECTION_DECAY_RELATIVE_DROP_PCT = 50;

/** Anti-flood cap on promotion findings filed in one tick. */
export const CORRECTION_DECAY_MAX_PER_TICK = 3;

export interface CorrectionDecayThresholds {
  currentDays?: number;
  dayMinCalls?: number;
  minCalls?: number;
  minDays?: number;
  relativeDropPct?: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const EMPTY_WINDOW: CorrectionWindow = {
  days: 0,
  fieldCalls: 0,
  coercedCalls: 0,
  pct: 0,
  peakDistinctOwners: 0,
  firstDay: null,
  lastDay: null,
};

function foldWindow(rows: readonly CorrectionShapeDayRow[], dayMinCalls: number): CorrectionWindow {
  const counted = rows.filter((r) => r.fieldCalls >= dayMinCalls);
  if (counted.length === 0) return { ...EMPTY_WINDOW };
  let fieldCalls = 0;
  let coercedCalls = 0;
  let peakDistinctOwners = 0;
  let firstDay = counted[0]!.day;
  let lastDay = counted[0]!.day;
  for (const r of counted) {
    fieldCalls += r.fieldCalls;
    coercedCalls += r.coercedCalls;
    peakDistinctOwners = Math.max(peakDistinctOwners, r.distinctOwners);
    if (r.day < firstDay) firstDay = r.day;
    if (r.day > lastDay) lastDay = r.day;
  }
  return {
    days: counted.length,
    fieldCalls,
    coercedCalls,
    pct: fieldCalls === 0 ? 0 : round1((100 * coercedCalls) / fieldCalls),
    peakDistinctOwners,
    firstDay,
    lastDay,
  };
}

/**
 * The day the rule started SERVING, derived from the ledger: the earliest day on which a
 * coerced-shape call was recorded `ok`.
 *
 * Before the rule serves, a coerced-shape call cannot validate, so it is stamped
 * `invalid-input` — the pre-P-016 window split 1,250/0 on exactly this. After it serves,
 * the re-encoding re-validates and the invocation completes `ok`. The first `ok` is
 * therefore the transition, observed rather than declared.
 *
 * Deliberately derived and not configured: a hand-maintained "went live on" date in the
 * probe registry is a second copy of a deployment fact, and it would rot silently the
 * first time a rule is reverted, re-landed, or shipped on a different day than planned.
 */
export function splitOnCoercionLive(rows: readonly CorrectionShapeDayRow[]): {
  liveFrom: string | null;
  baseline: CorrectionShapeDayRow[];
  current: CorrectionShapeDayRow[];
} {
  let liveFrom: string | null = null;
  for (const r of rows) {
    if (r.coercedOkCalls > 0 && (liveFrom === null || r.day < liveFrom)) liveFrom = r.day;
  }
  if (liveFrom === null) return { liveFrom: null, baseline: [...rows], current: [] };
  const pivot = liveFrom;
  return {
    liveFrom,
    baseline: rows.filter((r) => r.day < pivot),
    current: rows.filter((r) => r.day >= pivot),
  };
}

/**
 * Composite key for deduping (rule, day).
 *
 * `|` is safe as a separator and is deliberately NOT a control byte: rule ids are
 * `field.kebab-name` and days are `YYYY-MM-DD`, so neither can contain it, while a raw
 * control byte would make ripgrep treat this file as binary and git render its diffs
 * blind. Same reasoning as `dayKey` in `tool-rejection-rate.ts`.
 */
function ruleDayKey(rule: string, day: string): string {
  return `${rule}|${day}`;
}

/**
 * Fold day rows into per-rule verdicts. PURE.
 *
 * `rows` may mix freshly-queried days with days replayed from the persisted snapshot; the
 * fold is by (rule, day) so an overlap between the two is idempotent rather than doubled.
 */
export function rollupCorrectionShape(
  rows: readonly CorrectionShapeDayRow[],
  probes: readonly CorrectionDecayProbe[] = CORRECTION_DECAY_PROBES,
  thresholds: CorrectionDecayThresholds = {},
): CorrectionDecayRollup {
  const currentDays = thresholds.currentDays ?? CORRECTION_DECAY_CURRENT_DAYS;
  const dayMinCalls = thresholds.dayMinCalls ?? CORRECTION_DECAY_DAY_MIN_CALLS;
  const minCalls = thresholds.minCalls ?? CORRECTION_DECAY_MIN_CALLS;
  const minDays = thresholds.minDays ?? CORRECTION_DECAY_MIN_DAYS;
  const relativeDropPct = thresholds.relativeDropPct ?? CORRECTION_DECAY_RELATIVE_DROP_PCT;

  // Dedupe by (rule, day): the snapshot and the live window overlap by design.
  const byKey = new Map<string, CorrectionShapeDayRow>();
  for (const r of rows) {
    if (!r.rule || !r.day) continue;
    byKey.set(ruleDayKey(r.rule, r.day), {
      rule: r.rule,
      day: r.day,
      fieldCalls: Number(r.fieldCalls) || 0,
      coercedCalls: Number(r.coercedCalls) || 0,
      coercedOkCalls: Number(r.coercedOkCalls) || 0,
      distinctOwners: Number(r.distinctOwners) || 0,
    });
  }
  const allDays = new Set<string>();
  const byRule = new Map<string, CorrectionShapeDayRow[]>();
  for (const r of byKey.values()) {
    allDays.add(r.day);
    const list = byRule.get(r.rule);
    if (list) list.push(r);
    else byRule.set(r.rule, [r]);
  }

  const out: CorrectionDecayRow[] = [];
  for (const probe of probes) {
    const days = (byRule.get(probe.rule) ?? []).sort((a, b) => a.day.localeCompare(b.day));
    const split = splitOnCoercionLive(days);
    // Once a rule has been live a long time, "current" means RECENT, not "everything since
    // it landed" — otherwise the first months of adoption dominate the reading forever.
    const currentRows = split.current.slice(-currentDays);
    const baseline = foldWindow(split.baseline, dayMinCalls);
    const current = foldWindow(currentRows, dayMinCalls);

    const relativeDrop =
      baseline.pct > 0 ? round1((100 * (baseline.pct - current.pct)) / baseline.pct) : null;

    let verdict: CorrectionDecayVerdict;
    let because: string;
    if (split.liveFrom === null) {
      verdict = 'not-yet-live';
      because =
        `No coerced-shape call has been recorded \`ok\` yet, so ${probe.rule} has not been ` +
        `observed serving. There is no post-correction window to compare against` +
        (baseline.days > 0
          ? ` — the ${baseline.days}-day pre-correction baseline stands at ${baseline.pct}%.`
          : '.');
    } else if (
      baseline.days < minDays ||
      current.days < minDays ||
      baseline.fieldCalls < minCalls ||
      current.fieldCalls < minCalls
    ) {
      verdict = 'insufficient-data';
      because =
        `Needs >= ${minDays} counted days and >= ${minCalls} field-exercising calls on each ` +
        `side; have baseline ${baseline.days}d/${baseline.fieldCalls} and current ` +
        `${current.days}d/${current.fieldCalls} (rule serving since ${split.liveFrom}).`;
    } else if (relativeDrop !== null && relativeDrop >= relativeDropPct) {
      verdict = 'decaying';
      because =
        `Coerced share fell ${baseline.pct}% -> ${current.pct}% (${relativeDrop}% relative, ` +
        `bar ${relativeDropPct}%) since ${split.liveFrom}. The correction is teaching; leave ` +
        `the declared shape alone.`;
    } else {
      verdict = 'not-decaying';
      because =
        `Coerced share ${baseline.pct}% -> ${current.pct}% since ${split.liveFrom}` +
        (relativeDrop === null ? '' : ` (${relativeDrop}% relative)`) +
        `, short of the ${relativeDropPct}% bar, across ${current.days} counted days and ` +
        `${current.peakDistinctOwners} distinct agents at peak.`;
    }

    out.push({
      rule: probe.rule,
      toolName: probe.toolName,
      field: probe.field,
      declaredShape: probe.declaredShape,
      coercedShape: probe.coercedShape,
      coercionLiveFrom: split.liveFrom,
      baseline,
      current,
      relativeDropPct: relativeDrop,
      verdict,
      because,
    });
  }

  return {
    rules: out,
    notDecaying: out.filter((r) => r.verdict === 'not-decaying'),
    daysSeen: allDays.size,
  };
}

/**
 * The canonical live query for ONE probe — per-UTC-day counts over the last `$2` days for
 * workspace `$1`. Runnable as-is via dev:pg_query once the probe's fragments are spliced.
 *
 * ## Cost
 *
 * Scoped to a single `tool_name`, so the serving index
 * (`tool_invocations_invoked_at_cov_idx`, which INCLUDEs `tool_name`) filters before the
 * heap is touched, and only the surviving rows pay for `args_json`. Measured 2026-09-02 on
 * a 20-day window of `coord:send`: ~6.8s for ~28k rows — comfortable on a routine's budget,
 * and deliberately NOT on any interactive or health path (same rule as
 * `tool-rejection-rate.ts`, for the same reason).
 *
 * `args_json` is cast rather than assumed jsonb: the cast is a no-op if it already is, and
 * correct if it is text.
 */
export function correctionShapeDailySql(probe: CorrectionDecayProbe): string {
  return `
WITH c AS (
  SELECT (invoked_at AT TIME ZONE 'UTC')::date AS day,
         coord_owner_id,
         status,
         args_json::jsonb AS a
    FROM harness_shared.tool_invocations
   WHERE workspace_id = $1
     AND tool_name = '${probe.toolName}'
     AND invoked_at > now() - (($2)::int || ' days')::interval
     AND ${DISPATCH_WRAPPER_EXCLUSION_SQL}
), k AS (
  SELECT c.day,
         c.coord_owner_id,
         c.status,
         ${probe.fieldPresentSql} AS field_present,
         ${probe.coercedShapeSql} AS coerced
    FROM c
)
SELECT to_char(day, 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE field_present)                              AS field_calls,
       count(*) FILTER (WHERE field_present AND coerced)                  AS coerced_calls,
       count(*) FILTER (WHERE field_present AND coerced AND status='ok')  AS coerced_ok_calls,
       count(DISTINCT coord_owner_id) FILTER (WHERE field_present AND coerced) AS distinct_owners
  FROM k
 GROUP BY day
HAVING count(*) FILTER (WHERE field_present) > 0
 ORDER BY day`;
}

/** Read one probe's day rows from PG. */
export async function readCorrectionShapeDays(
  runQuery: RunQuery,
  probe: CorrectionDecayProbe,
  opts: { workspaceId: string; windowDays?: number },
): Promise<CorrectionShapeDayRow[]> {
  const rows = await runQuery<{
    day: string;
    field_calls: number | string;
    coerced_calls: number | string;
    coerced_ok_calls: number | string;
    distinct_owners: number | string;
  }>(correctionShapeDailySql(probe), [
    opts.workspaceId,
    opts.windowDays ?? CORRECTION_DECAY_CURRENT_DAYS,
  ]);
  return rows.map((r) => ({
    rule: probe.rule,
    day: r.day,
    fieldCalls: Number(r.field_calls) || 0,
    coercedCalls: Number(r.coerced_calls) || 0,
    coercedOkCalls: Number(r.coerced_ok_calls) || 0,
    distinctOwners: Number(r.distinct_owners) || 0,
  }));
}

/** A rating in the panel's shape ({ rating, evidence }). */
export interface CorrectionDecayGrade {
  /**
   * `degraded` means a correction has become permanent — a schema owing a change, not an
   * outage. There is deliberately no `broken`: nothing here pages, for the same reason
   * `gradeToolRejections` has no `broken` branch.
   */
  rating: 'healthy' | 'degraded' | 'unknown';
  evidence: string;
  /** Rules whose coerced shape should be promoted. */
  promotionCandidates: string[];
}

/** Map a rollup → a rating. PURE. */
export function gradeCorrectionDecay(roll: CorrectionDecayRollup): CorrectionDecayGrade {
  if (roll.rules.length === 0) {
    return {
      rating: 'unknown',
      evidence: 'No re-encoding rules registered.',
      promotionCandidates: [],
    };
  }
  const graded = roll.rules.filter((r) => r.verdict === 'decaying' || r.verdict === 'not-decaying');
  if (graded.length === 0) {
    const r = roll.rules[0]!;
    return {
      rating: 'unknown',
      evidence: `${roll.rules.length} rule(s) registered, none yet gradeable. ${r.rule}: ${r.because}`,
      promotionCandidates: [],
    };
  }
  if (roll.notDecaying.length === 0) {
    return {
      rating: 'healthy',
      evidence:
        `${graded.length} correction(s) gradeable, all decaying — agents are moving to the ` +
        `declared shape. ` +
        `${graded.map((r) => `${r.rule} ${r.baseline.pct}%->${r.current.pct}%`).join('; ')}.`,
      promotionCandidates: [],
    };
  }
  const worst = [...roll.notDecaying].sort(
    (a, b) => (a.relativeDropPct ?? 0) - (b.relativeDropPct ?? 0),
  )[0]!;
  return {
    rating: 'degraded',
    evidence:
      `${worst.rule} is not decaying: ${worst.because} ` +
      `A correction that never decays is a schema that never got fixed (D-104 endgame)` +
      (roll.notDecaying.length > 1 ? ` (+${roll.notDecaying.length - 1} other rule(s))` : '') +
      '.',
    promotionCandidates: roll.notDecaying.map((r) => r.rule),
  };
}

/** The improvement item one non-decaying rule should file. PURE. */
export interface CorrectionPromotionFinding {
  title: string;
  body: string;
  /** Stable per-rule key, so a rule re-files at most once while an item is open. */
  watchdogKey: string;
}

/**
 * Render one non-decaying rule into a filed finding. PURE, so the wording is unit-testable
 * without PG or the capture stack.
 *
 * The recommendation is D-104's endgame verbatim: promote the coerced shape to the DECLARED
 * shape and retire the original. It is filed as a proposal against the tool that owns the
 * schema — nothing here changes a schema on its own, because promoting a shape is a
 * deliberate API decision and the measurement is only the evidence for it.
 */
export function describeCorrectionPromotion(row: CorrectionDecayRow): CorrectionPromotionFinding {
  return {
    watchdogKey: `correction-decay:${row.rule}`,
    title: `${row.rule} has become permanent — promote \`${row.field}\` to the shape agents actually send`,
    body:
      `Correction-decay check (P-019 / D-104 endgame).\n\n` +
      `The re-encoding **${row.rule}** on **${row.toolName}** has been serving since ` +
      `**${row.coercionLiveFrom}**, and the share of \`${row.field}\` calls that need it has ` +
      `NOT fallen:\n\n` +
      `| window | days | calls using the field | sent the coerced shape | share |\n` +
      `|---|---|---|---|---|\n` +
      `| before the correction | ${row.baseline.days} | ${row.baseline.fieldCalls} | ` +
      `${row.baseline.coercedCalls} | ${row.baseline.pct}% |\n` +
      `| since (${row.current.firstDay ?? '?'}..${row.current.lastDay ?? '?'}) | ` +
      `${row.current.days} | ${row.current.fieldCalls} | ${row.current.coercedCalls} | ` +
      `${row.current.pct}% |\n\n` +
      `Relative drop: **${row.relativeDropPct === null ? 'n/a' : `${row.relativeDropPct}%`}** ` +
      `against a ${CORRECTION_DECAY_RELATIVE_DROP_PCT}% bar. Peak distinct agents sending the ` +
      `coerced shape in a single day since: ${row.current.peakDistinctOwners}.\n\n` +
      `**The recommendation (D-104's endgame clause): promote the coerced shape to the ` +
      `DECLARED shape and retire the original.**\n\n` +
      `- declared today: \`${row.declaredShape}\`\n` +
      `- what agents send: \`${row.coercedShape}\`\n\n` +
      `A correction is a stopgap. It was admitted on the understanding that it buys time ` +
      `while callers converge on the declared shape; ${row.current.peakDistinctOwners} agents ` +
      `a day still reaching for the other one is the measurement saying they will not. At ` +
      `that point the declared shape is the thing that is wrong, and keeping the correction ` +
      `forever means every caller pays a repair for a schema nobody intends to fix.\n\n` +
      `Scope note: this rate is read from \`tool_invocations.args_json\` — the shape callers ` +
      `SENT — and never from \`status\`. A rejection-keyed rate is anti-correlated with this ` +
      `question: the moment a correction serves, its whole population moves from ` +
      `\`invalid-input\` to \`ok\` and a status-keyed check reads a clean decay to zero while ` +
      `nothing about caller behaviour changed (D-109 / D-113).`,
  };
}
