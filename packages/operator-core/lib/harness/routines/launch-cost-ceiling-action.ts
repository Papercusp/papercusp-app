/**
 * `system:launch-cost-ceiling` — the standing watch on agent launch cost
 * (plan `agent-launch-context-cost-2026-09-18`, P-009(c); decision D-016).
 *
 * WHY THIS EXISTS. `scripts/measure-launch-cost.ts` has been committed and correct
 * for a while and already exits 1 against a `--target`. Nothing ever RAN it. The
 * consequence is the whole reason this plan exists: launch cost drifted
 * 107,841 -> 305,926 median tokens between 2026-08-13 and 2026-09-17 — a creep
 * phase plus a +134k step on 2026-09-11 — and the ONLY detector that ever fired was
 * a human noticing that agents felt slow and could manage "a couple of turns". The
 * same finding was then independently re-derived FOUR times across three epochs,
 * the shortest loss interval being five hours inside one session lineage.
 *
 * A measurement nobody runs is not a detector. This routine is the detector.
 *
 * TWO LEGS, because the two real failures look nothing alike:
 *
 *  1. REGRESSION — the recent median against a trailing baseline. This is the leg
 *     that would have caught the actual history: the 8/13->9/11 creep (no single
 *     day looks alarming; the trend is the signal) AND the 9/11->9/15 step. An
 *     absolute ceiling alone cannot see a creep until it is already a crisis.
 *  2. ABSOLUTE CEILING — the recent median against a hard number. This catches the
 *     structurally-broken state the regression leg goes quiet about once a bad
 *     level becomes the new normal: a fleet member's compaction limit is 250,000,
 *     so a launch median near it means sessions BREACH their 90% steer point at
 *     birth, before a single tool call. Measured on 2026-09-17: median 305,926 with
 *     p90 391,756 — sessions were being born past their own ceiling.
 *
 * Both legs carry a `<= 0` env kill switch, and the alarm is debounced per LEG
 * through the shared fires ledger — a level that stays bad is not new news nightly,
 * but a NEW leg crossing must not be suppressed by an older one still inside its
 * window (EI-16071, keyed source-only, is exactly that bug).
 *
 * `tier: 'durable'`: one measurement per period for the whole install. An ephemeral
 * row is armed per host, so a multi-host install would re-scan every transcript and
 * re-alarm once per host.
 *
 * SCOPE HONESTY: this measures what the transcripts on THIS host record, and only
 * `--owner-prefix su-` style superuser sessions by default. It is a regression
 * detector for our own agent launches, not a claim about any other client.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { median, type DayStats } from '../../launch-cost/launch-cost-metrics';
import { scanLaunchTranscripts, type ScanReport } from '../../launch-cost/scan-launch-transcripts';
import { recentWatchdogFires, recordFire } from '../../pot/watchdog';
import { openEscalation } from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

/** Synthetic identity for the background launch-cost escalation (mirrors the sibling watchdogs'). */
const LAUNCH_COST_IDENTITY: AgentIdentity = {
  ownerId: 'launch-cost-ceiling',
  ownerLabel: 'system · launch-cost-ceiling',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Days at the end of the window treated as "recent" and compared against the baseline. */
export const DEFAULT_RECENT_DAYS = 2;
/** Days immediately before the recent window that form the comparison baseline. */
export const DEFAULT_BASELINE_DAYS = 7;
/**
 * Absolute median ceiling. 250,000 is not arbitrary: it is the fleet-member
 * compaction limit (`COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP`), so a launch
 * median at or above it means such a session is past its 90% steer point at birth.
 */
export const DEFAULT_CEILING_TOKENS = 250_000;
/** Fractional growth of recent-vs-baseline median that counts as a regression. */
export const DEFAULT_REGRESSION_PCT = 0.2;
/** One alarm LEG stays debounced this long. A bad level is not new news every night. */
export const LAUNCH_COST_DEBOUNCE_HOURS = 24;
/** Below this many samples a median is noise, not a verdict. */
export const MIN_SAMPLES = 20;

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function launchCostCeilingTokens(fallback = DEFAULT_CEILING_TOKENS): number {
  return envNumber('LAUNCH_COST_CEILING_TOKENS', fallback);
}

export function launchCostRegressionPct(fallback = DEFAULT_REGRESSION_PCT): number {
  return envNumber('LAUNCH_COST_REGRESSION_PCT', fallback);
}

export interface LaunchCostLeg {
  /** Stable key for the fires-ledger debounce — per LEG, never per run. */
  key: 'regression' | 'ceiling';
  summary: string;
  detail: string;
  cohort?: string;
}

export interface LaunchCostVerdict {
  recentMedian: number | null;
  baselineMedian: number | null;
  recentSamples: number;
  baselineSamples: number;
  legs: LaunchCostLeg[];
  /** Why no verdict was reachable, when that is the honest answer. */
  insufficient: string | null;
}

/**
 * PURE. Given per-day stats (most recent LAST), decide which legs are crossed.
 *
 * Deliberately takes `DayStats[]` rather than doing its own IO so the thresholds
 * are unit-testable without a transcript tree — the property that makes this a
 * real guard rather than a script that happens to run nightly.
 *
 * Returns `insufficient` rather than a false all-clear when the sample is too thin:
 * a shrinking sample and a shrinking median look identical in the headline number,
 * which is precisely how a broken measurement reads as good news.
 */
export function evaluateLaunchCost(
  days: readonly DayStats[],
  opts: {
    recentDays?: number;
    baselineDays?: number;
    ceilingTokens?: number;
    regressionPct?: number;
    minSamples?: number;
  } = {},
): LaunchCostVerdict {
  const recentDays = Math.max(1, Math.floor(opts.recentDays ?? DEFAULT_RECENT_DAYS));
  const baselineDays = Math.max(1, Math.floor(opts.baselineDays ?? DEFAULT_BASELINE_DAYS));
  const ceiling = opts.ceilingTokens ?? DEFAULT_CEILING_TOKENS;
  const regressionPct = opts.regressionPct ?? DEFAULT_REGRESSION_PCT;
  const minSamples = opts.minSamples ?? MIN_SAMPLES;

  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const recent = sorted.slice(-recentDays);
  const baseline = sorted.slice(Math.max(0, sorted.length - recentDays - baselineDays), sorted.length - recentDays);

  const weighted = (rows: readonly DayStats[]): { median: number | null; count: number } => {
    const count = rows.reduce((n, r) => n + r.count, 0);
    if (count === 0) return { median: null, count: 0 };
    // Sample-weighted mean of per-day medians. Not a true pooled median — the
    // per-day rows are all this stage is given — so a day with 4 sessions cannot
    // swing the verdict the way an unweighted average would let it.
    const sum = rows.reduce((n, r) => n + r.medianTotal * r.count, 0);
    return { median: sum / count, count };
  };

  const r = weighted(recent);
  const b = weighted(baseline);
  const verdict: LaunchCostVerdict = {
    recentMedian: r.median === null ? null : Math.round(r.median),
    baselineMedian: b.median === null ? null : Math.round(b.median),
    recentSamples: r.count,
    baselineSamples: b.count,
    legs: [],
    insufficient: null,
  };

  if (r.median === null || r.count < minSamples) {
    verdict.insufficient = `recent window has ${r.count} sample(s), below the ${minSamples} needed for a verdict`;
    return verdict;
  }

  // Leg 2 first: it needs no baseline, so it still fires on a cold install.
  if (ceiling > 0 && r.median >= ceiling) {
    verdict.legs.push({
      key: 'ceiling',
      summary: `launch median ${verdict.recentMedian!.toLocaleString()} is at/over the ${ceiling.toLocaleString()}-token ceiling`,
      detail:
        `Recent median ${verdict.recentMedian!.toLocaleString()} tokens over ${r.count} launch(es) is at or above the ` +
        `absolute ceiling of ${ceiling.toLocaleString()}. That ceiling is the fleet-member compaction limit, so a member ` +
        `session at this level is past its 90% steer point BEFORE its first tool call.`,
    });
  }

  if (regressionPct > 0 && b.median !== null && b.count >= minSamples && b.median > 0) {
    const growth = (r.median - b.median) / b.median;
    if (growth >= regressionPct) {
      verdict.legs.push({
        key: 'regression',
        summary:
          `launch median grew ${(growth * 100).toFixed(1)}% ` +
          `(${verdict.baselineMedian!.toLocaleString()} -> ${verdict.recentMedian!.toLocaleString()} tokens)`,
        detail:
          `Recent ${recentDays}-day median ${verdict.recentMedian!.toLocaleString()} over ${r.count} launch(es) vs a ` +
          `${baselineDays}-day baseline of ${verdict.baselineMedian!.toLocaleString()} over ${b.count} launch(es): ` +
          `+${(growth * 100).toFixed(1)}%, at or past the ${(regressionPct * 100).toFixed(0)}% regression threshold. ` +
          `Something landed that every agent now pays at launch. Check recent changes to the tool seed, the launcher ` +
          `deny flags (native schema deferral is CONDITIONAL on ToolSearch existing), the su playbook render and the ` +
          `spliced repo CLAUDE.md — the two prose surfaces over 100KB with no byte ceiling.`,
      });
    }
  }

  return verdict;
}

/** Calendar-window, model/entrypoint comparison over the existing Claude launch scan.
 * Unknown models, invalid counts and unreadable sources lower coverage; they never
 * become zero-cost launches. This is input volume, not provider billing or hit rate. */
export function evaluateLaunchScan(report: ScanReport, opts: {
  now: number; recentDays?: number; baselineDays?: number;
  ceilingTokens?: number; regressionPct?: number; minSamples?: number; minCoverage?: number;
}) {
  const dayMs = 86_400_000;
  const recentDays = Math.max(1, Math.floor(opts.recentDays ?? DEFAULT_RECENT_DAYS));
  const baselineDays = Math.max(1, Math.floor(opts.baselineDays ?? DEFAULT_BASELINE_DAYS));
  const recentStart = opts.now - recentDays * dayMs;
  const baselineStart = recentStart - baselineDays * dayMs;
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const ceiling = opts.ceilingTokens ?? DEFAULT_CEILING_TOKENS;
  const regression = opts.regressionPct ?? DEFAULT_REGRESSION_PCT;
  const groups = new Map<string, { recent: number[]; baseline: number[] }>();
  let unknownSamples = 0;
  let validSamples = 0;
  let newest = -Infinity;
  const recentValues: number[] = [];
  for (const sample of report.samples) {
    const time = Date.parse(sample.timestamp);
    const numbers = [sample.inputTokens, sample.cacheReadTokens, sample.cacheCreationTokens, sample.totalPromptTokens];
    if (sample.usageCountsComplete !== true || !sample.model || !Number.isFinite(time) || time > opts.now ||
      numbers.some(n => !Number.isSafeInteger(n) || n < 0) ||
      sample.totalPromptTokens !== sample.inputTokens + sample.cacheReadTokens + sample.cacheCreationTokens) {
      unknownSamples++;
      continue;
    }
    if (time < baselineStart) continue;
    validSamples++;
    newest = Math.max(newest, time);
    if (time >= recentStart) recentValues.push(sample.totalPromptTokens);
    const key = JSON.stringify([sample.model, sample.entrypoint]);
    const group = groups.get(key) ?? { recent: [], baseline: [] };
    (time >= recentStart ? group.recent : group.baseline).push(sample.totalPromptTokens);
    groups.set(key, group);
  }
  const unmeasured = ['unreadable', 'undatable', 'no-usage-row', 'incomplete-usage'].reduce((n, key) =>
    n + (report.skippedByReason[key as keyof ScanReport['skippedByReason']] ?? 0), 0);
  const eligible = validSamples + unknownSamples + unmeasured;
  const coverage = eligible ? validSamples / eligible : null;
  const unknown: string[] = [];
  if (coverage === null || coverage < (opts.minCoverage ?? 0.8)) unknown.push('incomplete-telemetry-coverage');
  if (newest < recentStart) unknown.push('stale-or-absent-recent-telemetry');
  const cohorts = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const recentMedian = group.recent.length ? median(group.recent) : null;
    const baselineMedian = group.baseline.length ? median(group.baseline) : null;
    return { key, recentMedian, baselineMedian, recentSamples: group.recent.length, baselineSamples: group.baseline.length,
      regressionComparable: group.recent.length >= minSamples && group.baseline.length >= minSamples };
  });
  const legs: LaunchCostLeg[] = [];
  for (const c of cohorts) {
    if (c.recentSamples < minSamples || c.recentMedian === null) continue;
    if (ceiling > 0 && c.recentMedian >= ceiling) legs.push({ key: 'ceiling', cohort: c.key,
      summary: `${c.key} launch input median ${Math.round(c.recentMedian)} exceeds ${ceiling}`,
      detail: `${c.recentSamples} recent launches in this model/entrypoint cohort exceed the input-volume ceiling; provider cost and cache-miss cause are not inferred.` });
    if (regression > 0 && c.baselineSamples >= minSamples && c.baselineMedian !== null && c.baselineMedian > 0 &&
      c.recentMedian / c.baselineMedian - 1 >= regression) legs.push({ key: 'regression', cohort: c.key,
      summary: `${c.key} launch input grew ${((c.recentMedian / c.baselineMedian - 1) * 100).toFixed(1)}%`,
      detail: `Pooled recent median ${c.recentMedian} (${c.recentSamples} samples/${recentDays} days), baseline ${c.baselineMedian} (${c.baselineSamples} samples/${baselineDays} days). Model and entrypoint match; account and transport beyond this Claude transcript source are unmeasured.` });
  }
  if (!cohorts.some(c => c.recentSamples >= minSamples)) unknown.push('insufficient-recent-cohort-volume');
  return { cohorts, coverage, validSamples, unknownSamples, unmeasured,
    recentSamples: cohorts.reduce((n, c) => n + c.recentSamples, 0),
    recentMedian: recentValues.length ? median(recentValues) : null,
    // A fleet-level aggregate is descriptive only; it never selects alarm legs.
    legs: unknown.length ? [] : legs, unknown };
}

export interface LaunchCostRunResult {
  outcome: 'ok' | 'alerted' | 'debounced' | 'insufficient' | 'error';
  recentMedian: number | null;
  baselineMedian: number | null;
  recentSamples: number;
  filesScanned: number;
  filesMeasured: number;
  reason?: string;
  telemetry?: ReturnType<typeof evaluateLaunchScan>;
}

export interface LaunchCostCeilingDeps {
  scan?: typeof scanLaunchTranscripts;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

export async function runLaunchCostCeiling(
  opts: {
    workspaceId?: string;
    installSlug?: string;
    root?: string;
    ownerPrefix?: string;
    recentDays?: number;
    baselineDays?: number;
    ceilingTokens?: number;
    regressionPct?: number;
  } = {},
  deps: LaunchCostCeilingDeps = {},
): Promise<LaunchCostRunResult> {
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const recentDays = opts.recentDays ?? DEFAULT_RECENT_DAYS;
  const baselineDays = opts.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const base: LaunchCostRunResult = {
    outcome: 'insufficient',
    recentMedian: null,
    baselineMedian: null,
    recentSamples: 0,
    filesScanned: 0,
    filesMeasured: 0,
  };

  try {
    // Bound the scan to the window we actually judge. Scanning all history every
    // period is what makes a "cheap" nightly job quietly expensive.
    const sinceMs = (deps.now ?? Date.now()) - (recentDays + baselineDays + 1) * 86_400_000;
    const since = new Date(sinceMs).toISOString().slice(0, 10);

    const report = await (deps.scan ?? scanLaunchTranscripts)({
      root: opts.root ?? join(homedir(), '.papercusp', 'session-claude'),
      ownerPrefix: opts.ownerPrefix ?? 'su-',
      since,
    });

    const verdict = evaluateLaunchScan(report, {
      now: deps.now ?? Date.now(),
      recentDays,
      baselineDays,
      ceilingTokens: opts.ceilingTokens ?? launchCostCeilingTokens(),
      regressionPct: opts.regressionPct ?? launchCostRegressionPct(),
    });

    const counts: LaunchCostRunResult = {
      ...base,
      recentMedian: verdict.recentMedian,
      baselineMedian: null,
      recentSamples: verdict.recentSamples,
      filesScanned: report.filesScanned,
      filesMeasured: report.filesMeasured,
      telemetry: verdict,
    };

    if (verdict.unknown.length) return { ...counts, outcome: 'insufficient', reason: verdict.unknown.join('; ') };
    if (verdict.legs.length === 0) return { ...counts, outcome: 'ok' };

    // Debounce per LEG, not per run (EI-16071): a level that stays bad must not
    // suppress a DIFFERENT leg crossing for the first time.
    const scopeKey = verdict.legs
      .map((l) => `${l.key}:${l.cohort ?? 'legacy'}`)
      .sort()
      .join('+');
    const firedRecently =
      (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
        workspaceId,
        installSlug,
        LAUNCH_COST_DEBOUNCE_HOURS,
        'launch-cost-ceiling',
        scopeKey,
      )) > 0;
    if (firedRecently) return { ...counts, outcome: 'debounced', reason: `fires-ledger debounce (${scopeKey})` };

    const summary = `agent launch cost: ${verdict.legs.map((l) => l.summary).join('; ')}`;
    const body = [
      verdict.legs.map((l) => `## ${l.key}\n\n${l.detail}`).join('\n\n'),
      '',
      '## Measurement',
      `Scanned ${report.filesScanned} transcript file(s), measured ${report.filesMeasured}. ` +
        `Recent window ${recentDays}d (${verdict.recentSamples} launches), baseline ${baselineDays}d ` +
        `(per-cohort baseline counts in routine telemetry). Model/entrypoint coverage ${(verdict.coverage! * 100).toFixed(1)}%. Re-run the underlying scan with:`,
      '',
      '    npm run measure:launch-cost -- --target 120000 --require-samples',
      '',
      'Kill switches: LAUNCH_COST_CEILING_TOKENS=0 / LAUNCH_COST_REGRESSION_PCT=0.',
    ].join('\n');

    await (deps.recordFire ?? recordFire)({
      workspaceId,
      installSlug,
      source: 'launch-cost-ceiling',
      reason: `${summary} [${scopeKey}]`,
      wakeAt: null,
    });
    await (deps.openEscalation ?? openEscalation)(LAUNCH_COST_IDENTITY, {
      severity: 'advisory',
      summary,
      body,
    });
    return { ...counts, outcome: 'alerted', reason: summary };
  } catch (e) {
    return { ...base, outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

registerSystemAction('launch-cost-ceiling', async (ctx: SystemActionCtx) => {
  const cfg = (ctx.triggerConfig ?? {}) as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = cfg[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const result = await runLaunchCostCeiling({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    recentDays: num('recent_days'),
    baselineDays: num('baseline_days'),
    ceilingTokens: num('ceiling_tokens'),
    regressionPct: num('regression_pct'),
  });
  return result as unknown as Record<string, unknown>;
});
