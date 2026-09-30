/**
 * The bash→tool substitution REPORT (plan `bash-to-tool-substitution-2026-07-26`,
 * P-002) — the repeatable form of the one-shot 2026-07-26 audit, and the
 * after-number P-029 is judged on.
 *
 * Four headline measures, which the audit produced by hand and this reproduces
 * from stored state:
 *   1. Bash share of tool_use blocks       — how much of all tool use is shell
 *   2. per-intent bucket counts            — how much of it a registered tool covers
 *   3. per-bucket tool-counterpart counts  — how often the tool was used instead
 *   4. result-token cost                   — what the shell output costs in context
 *
 * Shaped like `code-run-adoption.ts`: canonical SQL + an injected `RunQuery`, a
 * PURE summariser that is unit-tested without Postgres, and a grader — so the
 * thin `activity:bash-substitution-report` tool is just a wrapper.
 *
 * ── WHY THE BEFORE-NUMBER IS A COMMITTED FIXTURE AND NOT A QUERY ──────────────
 * `harness_shared.tool_usage_rollup` only counts FORWARD, from the moment the
 * ingester started writing it (2026-07-26). Transcript files already had
 * advanced byte offsets, so no history was backfilled and the audit's 7-day
 * window CANNOT be reconstructed from the table — re-running this report over
 * "the last 7 days" today does not reproduce the audit, it reports a shorter
 * window that merely looks like one.
 *
 * So P-029 compares the FROZEN fixture baselines (`fixtures/*.sample.json`,
 * whose `totalAtoms` were counted over the real 7d corpus at 2026-07-26T01:23Z)
 * against this report's live bucket counts. That is only legitimate because
 * both sides are counted the SAME way — per matching ATOM, by the same
 * `bash_pattern` through the same matcher (see `matchAtomsToSubstitutions`,
 * whose doc explains why it must not inherit the advisory dedup). That
 * cross-grain discipline is load-bearing evidence, not ceremony.
 *
 * `windowCoverage` below exists so this can never be read dishonestly: it
 * reports the days actually present in the table, so a 7-day request that only
 * has 1 day of data says so instead of quietly under-reporting.
 */

import { ALL_PAIRS } from './pairs';
import { BYTES_PER_TOKEN, RESULT_BYTES_TOOL, SHELL_TOOL_NAME } from './usage-rollup';
import { loadFixture } from './corpus';
import type { SubstitutionRow } from './match';

/** Injectable query runner (mirrors code-run-adoption.ts / load-token-rollups.ts). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/**
 * The corpus namespace the rollup is written under.
 *
 * ⚠ This is NOT a tenant id. `session_turns` and `tool_usage_rollup` both use
 * the literal 'default' for the session-transcript corpus, while the
 * substitution REGISTRY lives under the real workspace ('papercusp-workspace').
 * Querying the rollup with a real tenant id returns zero rows and reads as "no
 * bash usage at all" — a silent empty that looks exactly like success.
 */
export const ROLLUP_CORPUS_WORKSPACE = 'default';

export const REPORT_MAX_SINCE_DAYS = 90;

/** Clamp to [1, 90], defaulting to 7. Pure + exported so the clamp is testable. */
export function clampReportSinceDays(sinceDays: number | undefined): number {
  const n = sinceDays == null ? NaN : Math.trunc(sinceDays);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, REPORT_MAX_SINCE_DAYS);
}

/** One aggregated rollup row over the window. */
export interface UsageWindowRow {
  toolName: string;
  /** '' on a per-call row. */
  verb: string;
  /** '' unless this is a bucket row. */
  intentLabel: string;
  calls: number;
  atoms: number;
  resultBytes: number;
  sessions: number;
  firstDay: string | null;
  lastDay: string | null;
}

/**
 * Canonical window read. Grouped in SQL so a busy window never streams raw
 * per-session rows over the wire (the code-run-adoption precedent).
 */
export const USAGE_WINDOW_SQL = `
SELECT tool_name,
       verb,
       intent_label,
       sum(calls)::bigint          AS calls,
       sum(atoms)::bigint          AS atoms,
       sum(result_bytes)::bigint   AS result_bytes,
       count(DISTINCT session_id)::int AS sessions,
       min(day)::text              AS first_day,
       max(day)::text              AS last_day
  FROM harness_shared.tool_usage_rollup
 WHERE workspace_id = $1
   AND day >= ((now() AT TIME ZONE 'UTC')::date - ($2)::int)
 GROUP BY tool_name, verb, intent_label
`;

/**
 * Counterpart tool usage over the same window.
 *
 * From `tool_invocations`, which records MCP calls — which is exactly right
 * here: every counterpart (`capability:read`, `capability:git`, `dev:pg_query`)
 * IS an MCP tool. The asymmetry that made the bash side unmeasurable from
 * Postgres (D-012: native `Bash` never reaches this table) does not apply to
 * the tools it is being compared against.
 */
export const COUNTERPART_SQL = `
SELECT tool_name,
       count(*)::bigint                AS calls,
       count(DISTINCT spawn_id)::int   AS spawns
  FROM harness_shared.tool_invocations
 WHERE invoked_at >= now() - (($1)::int || ' days')::interval
   AND status = 'ok'
   AND tool_name = ANY($2)
 GROUP BY tool_name
`;

export interface CounterpartRow {
  toolName: string;
  calls: number;
  spawns: number;
}

/** Per-intent-bucket result. */
export interface BucketReport {
  intentLabel: string;
  /** The tool the registry says should serve this intent. */
  toolName: string;
  tier: string;
  equivalenceVerdict: string;
  /** Matching bash ATOMS in the window (from ingest-time bucket rows). */
  bashAtoms: number;
  /** Distinct sessions that issued them. */
  sessions: number;
  /** Counterpart tool calls in the same window. */
  toolCalls: number;
  /**
   * toolCalls / (toolCalls + bashAtoms) — the share of this intent served by
   * the tool.
   *
   * Null in the two cases where a number would LIE:
   *  - neither side occurred (an honest "no demand", never 0%, which would read
   *    as total failure), and
   *  - the window carries no bucket attribution at all (see
   *    `coverage.bucketAttribution`). With a zero bash side by construction,
   *    every bucket would compute a triumphant 100% off an empty table — which
   *    is how a metric ends up certifying the very thing it failed to measure.
   */
  substitutionRate: number | null;
  /**
   * True when another bucket in this report shares the same counterpart tool
   * (e.g. operator-db-select and operator-db-describe are both dev:pg_query).
   * `toolCalls` is per-TOOL, so those rows repeat one figure — never sum them.
   */
  toolCallsShared: boolean;
  /** The frozen 7d audit baseline for this bucket, when one exists. */
  baseline: { atoms: number; sessions: number; extractedAt: string } | null;
}

export interface WindowCoverage {
  /** Days requested. */
  requestedDays: number;
  /** Distinct days actually present in the rollup for this window. */
  daysWithData: number;
  firstDay: string | null;
  lastDay: string | null;
  /**
   * True when the table holds fewer days than requested — the rollup counts
   * only forward from when it went live, so an early report is a PARTIAL
   * window and must not be compared to the 7d baseline as if it were whole.
   */
  partial: boolean;
  /**
   * Whether ANY intent-bucket row exists in this window.
   *
   * False means the bash side of every bucket is unmeasured — either the window
   * predates ingest-time bucket attribution (migration 674) or the registry was
   * empty while it was ingested. It does NOT mean agents stopped using the
   * shell. Every substitutionRate is forced to null in that case, because the
   * alternative is a report that grades itself `healthy` at 100% substitution
   * on a table with no bash data in it at all.
   */
  bucketAttribution: boolean;
}

export interface SubstitutionReport {
  sinceDays: number;
  calls: {
    bash: number;
    total: number;
    /** Bash ÷ all tool_use blocks — the headline. Null when the window is empty. */
    bashShare: number | null;
    bashSessions: number;
  };
  cost: {
    resultBytes: number;
    /** resultBytes ÷ BYTES_PER_TOKEN — an ESTIMATE, and a FLOOR (large results
     *  are stubbed in the transcript; see extractToolResultBytes). */
    estimatedResultTokens: number;
  };
  buckets: BucketReport[];
  /**
   * Highest-volume raw verbs. Diagnostic only — do NOT read as intent.
   * `atomize` is explicitly not a shell parser, so an inlined script payload
   * (`npx tsx -e "const x = …"`) contributes pseudo-verbs like `const`. Those
   * match no registry pattern, so they cannot pollute a BUCKET count, but they
   * do appear here and will look like a bug if mistaken for commands.
   */
  topVerbs: Array<{ verb: string; atoms: number }>;
  coverage: WindowCoverage;
  /** True when the registry read returned nothing — every bucket would be 0. */
  emptyRegistry: boolean;
}

/**
 * Fold the raw window rows + counterparts + registry into the report. PURE.
 */
export function summarizeSubstitutionReport(opts: {
  sinceDays: number;
  usage: UsageWindowRow[];
  counterparts: CounterpartRow[];
  registry: SubstitutionRow[];
  /** Injectable so the summariser stays pure/testable (defaults to the frozen fixtures). */
  baselineOf?: (intentLabel: string) => { atoms: number; sessions: number; extractedAt: string } | null;
  topVerbLimit?: number;
}): SubstitutionReport {
  const { sinceDays, usage, counterparts, registry } = opts;
  const baselineOf = opts.baselineOf ?? frozenBaselineOf;

  let bashCalls = 0;
  let bashSessions = 0;
  let totalCalls = 0;
  let resultBytes = 0;
  const verbAtoms = new Map<string, number>();
  const bucketAtoms = new Map<string, { atoms: number; sessions: number }>();
  const days = new Set<string>();
  let firstDay: string | null = null;
  let lastDay: string | null = null;

  for (const r of usage) {
    if (r.firstDay) {
      days.add(r.firstDay);
      if (firstDay === null || r.firstDay < firstDay) firstDay = r.firstDay;
    }
    if (r.lastDay) {
      days.add(r.lastDay);
      if (lastDay === null || r.lastDay > lastDay) lastDay = r.lastDay;
    }
    // The synthetic result-bytes row is a COST row, not a tool call — folding it
    // into the denominator would deflate the bash share with non-calls.
    if (r.toolName === RESULT_BYTES_TOOL) {
      resultBytes += r.resultBytes;
      continue;
    }
    if (r.verb === '' && r.intentLabel === '') {
      totalCalls += r.calls;
      if (r.toolName === SHELL_TOOL_NAME) {
        bashCalls += r.calls;
        bashSessions = Math.max(bashSessions, r.sessions);
      }
      continue;
    }
    if (r.intentLabel !== '') {
      const cur = bucketAtoms.get(r.intentLabel) ?? { atoms: 0, sessions: 0 };
      cur.atoms += r.atoms;
      cur.sessions = Math.max(cur.sessions, r.sessions);
      bucketAtoms.set(r.intentLabel, cur);
      continue;
    }
    if (r.verb !== '') verbAtoms.set(r.verb, (verbAtoms.get(r.verb) ?? 0) + r.atoms);
  }

  const callsByTool = new Map(counterparts.map((c) => [c.toolName, c.calls]));

  // Is the bash side of the buckets measured AT ALL in this window? Without
  // this the rate below divides by a zero that means "unmeasured", not "none".
  const bucketAttribution = bucketAtoms.size > 0;

  const toolUseCount = new Map<string, number>();
  for (const row of registry) toolUseCount.set(row.toolName, (toolUseCount.get(row.toolName) ?? 0) + 1);

  const buckets: BucketReport[] = registry
    .map((row) => {
      const hit = bucketAtoms.get(row.intentLabel) ?? { atoms: 0, sessions: 0 };
      const toolCalls = callsByTool.get(row.toolName) ?? 0;
      const denom = toolCalls + hit.atoms;
      return {
        intentLabel: row.intentLabel,
        toolName: row.toolName,
        tier: row.tier,
        equivalenceVerdict: row.equivalenceVerdict,
        bashAtoms: hit.atoms,
        sessions: hit.sessions,
        toolCalls,
        substitutionRate: bucketAttribution && denom > 0 ? toolCalls / denom : null,
        toolCallsShared: (toolUseCount.get(row.toolName) ?? 0) > 1,
        baseline: baselineOf(row.intentLabel),
      };
    })
    .sort((a, b) => (b.bashAtoms - a.bashAtoms) || a.intentLabel.localeCompare(b.intentLabel));

  const topVerbs = [...verbAtoms.entries()]
    .map(([verb, atoms]) => ({ verb, atoms }))
    .sort((a, b) => (b.atoms - a.atoms) || a.verb.localeCompare(b.verb))
    .slice(0, opts.topVerbLimit ?? 15);

  return {
    sinceDays,
    calls: {
      bash: bashCalls,
      total: totalCalls,
      bashShare: totalCalls > 0 ? bashCalls / totalCalls : null,
      bashSessions,
    },
    cost: {
      resultBytes,
      estimatedResultTokens: Math.round(resultBytes / BYTES_PER_TOKEN),
    },
    buckets,
    topVerbs,
    coverage: {
      requestedDays: sinceDays,
      daysWithData: days.size,
      firstDay,
      lastDay,
      partial: days.size < sinceDays,
      bucketAttribution,
    },
    emptyRegistry: registry.length === 0,
  };
}

/**
 * The frozen 7d baseline for an intent, read from the committed fixtures.
 *
 * Maps intent → fixture via ALL_PAIRS rather than a hardcoded table, so a new
 * audited pair carries its baseline automatically. Returns null (never throws)
 * for an intent with no fixture: a bucket without frozen evidence is reported
 * without a comparison, which is honest — inventing a zero baseline would make
 * any new bucket look like pure regression.
 */
export function frozenBaselineOf(
  intentLabel: string,
): { atoms: number; sessions: number; extractedAt: string } | null {
  const pair = ALL_PAIRS.find((p) => p.intentLabel === intentLabel);
  if (!pair) return null;
  try {
    const fx = loadFixture(pair.id);
    return { atoms: fx.totalAtoms, sessions: fx.totalSessions, extractedAt: fx.extractedAt };
  } catch {
    return null;
  }
}

/** Run the canonical queries and summarize. */
export async function readSubstitutionReport(
  runQuery: RunQuery,
  registry: SubstitutionRow[],
  opts: { sinceDays?: number; workspaceId?: string } = {},
): Promise<SubstitutionReport> {
  const sinceDays = clampReportSinceDays(opts.sinceDays);
  const rawUsage = await runQuery<{
    tool_name: string; verb: string; intent_label: string;
    calls: string | number; atoms: string | number; result_bytes: string | number;
    sessions: string | number; first_day: string | null; last_day: string | null;
  }>(USAGE_WINDOW_SQL, [opts.workspaceId ?? ROLLUP_CORPUS_WORKSPACE, sinceDays]);

  const usage: UsageWindowRow[] = rawUsage.map((r) => ({
    toolName: r.tool_name,
    verb: r.verb ?? '',
    intentLabel: r.intent_label ?? '',
    calls: Number(r.calls) || 0,
    atoms: Number(r.atoms) || 0,
    resultBytes: Number(r.result_bytes) || 0,
    sessions: Number(r.sessions) || 0,
    firstDay: r.first_day,
    lastDay: r.last_day,
  }));

  // Only the tools the registry actually names — a counterpart read is a join
  // key, not a survey of the whole tool catalogue.
  const toolNames = [...new Set(registry.map((r) => r.toolName))];
  let counterparts: CounterpartRow[] = [];
  if (toolNames.length > 0) {
    try {
      const raw = await runQuery<{ tool_name: string; calls: string | number; spawns: string | number }>(
        COUNTERPART_SQL,
        [sinceDays, toolNames],
      );
      counterparts = raw.map((r) => ({
        toolName: r.tool_name,
        calls: Number(r.calls) || 0,
        spawns: Number(r.spawns) || 0,
      }));
    } catch {
      // Counterpart counts are the comparison half; losing them must not lose
      // the bash half, which is the number P-029 actually tracks.
      counterparts = [];
    }
  }

  return summarizeSubstitutionReport({ sinceDays, usage, counterparts, registry });
}

/** A pot-coordination-health-shaped rating. */
export interface SubstitutionGrade {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/** Below this many bash calls the window is too thin to grade. */
export const REPORT_MIN_SAMPLE = 50;

/**
 * Grade the report.
 *
 * Deliberately graded on BUCKET substitution — the share of registered intents
 * served by their tool — and NOT on the aggregate bash share. Per D-006 the
 * aggregate moves for reasons unrelated to this plan (fleet mix, task mix), so
 * it is reported but is not the criterion.
 */
export function gradeSubstitution(report: SubstitutionReport): SubstitutionGrade {
  if (report.emptyRegistry) {
    return { rating: 'unknown', evidence: 'substitution registry is empty — no bucket can be attributed' };
  }
  if (report.calls.bash < REPORT_MIN_SAMPLE) {
    return {
      rating: 'unknown',
      evidence:
        `only ${report.calls.bash} Bash calls in the window (< ${REPORT_MIN_SAMPLE})` +
        `${report.coverage.partial ? `; rollup covers ${report.coverage.daysWithData}/${report.coverage.requestedDays} days` : ''}` +
        ' — too thin to grade',
    };
  }
  if (!report.coverage.bucketAttribution) {
    // The failure this guard exists for: with no bucket rows the bash side of
    // every bucket is 0, so a naive rate reports 100% substitution and grades
    // `healthy` — declaring the plan won on a table that contains none of the
    // evidence. Refuse to grade instead.
    return {
      rating: 'unknown',
      evidence:
        'no intent-bucket rows in this window — the bash side is UNMEASURED (window predates ' +
        'ingest-time bucket attribution, or the registry was empty during ingest). Substitution ' +
        'cannot be rated; the Bash share and cost figures below are still valid.',
    };
  }
  const rated = report.buckets.filter((b) => b.substitutionRate !== null);
  if (rated.length === 0) {
    return { rating: 'unknown', evidence: 'no registered intent occurred in the window' };
  }
  const mean = rated.reduce((s, b) => s + (b.substitutionRate ?? 0), 0) / rated.length;
  const pct = Math.round(mean * 100);
  const share = report.calls.bashShare === null ? '—' : `${Math.round(report.calls.bashShare * 100)}%`;
  const rating = mean >= 0.6 ? 'healthy' : mean >= 0.25 ? 'degraded' : 'broken';
  return {
    rating,
    evidence:
      `mean per-bucket substitution ${pct}% across ${rated.length} registered intents; ` +
      `Bash is ${share} of tool_use blocks (${report.calls.bash}/${report.calls.total}) over ` +
      `${report.coverage.daysWithData} day(s)` +
      `${report.coverage.partial ? ' — PARTIAL window, the rollup counts only forward' : ''}.`,
  };
}
