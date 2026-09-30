/**
 * P-013 (plan gate-file-level-test-reuse-2026-09-27): the gate-side reader of the per-file
 * pass-reuse lines `scripts/affected-tests.mjs` prints. The line formats are defined in
 * `scripts/lib/test-pass-reuse.mjs` (`formatTestReuseLine`, `formatTestReuseTotalLine`,
 * `formatReuseAlarmLine`) plus the two `applied=false` lines in `armTestPassReuse`.
 *
 * Pure over captured suite output, so the gate can record one structured summary per round
 * (`gate_health.testPassReuse`) and /admin/git can show "what did reuse do" without anyone
 * re-grepping a run log. Lives in operator-core so both the writer (the green-checkpoint
 * runner) and the reader (`git-pipeline-stats.ts`) share one definition.
 *
 * One affected-tests invocation prints, in order:
 *   - either ONE whole-run `TEST_PASS_REUSE applied=false reason=<r>` line (reuse off), or
 *   - one `TEST_PASS_REUSE ws=<name> …` line per armed task (counts, or
 *     `applied=false reason=<r>` for that task only), then one `TEST_PASS_REUSE_TOTAL …` line;
 *   - later, after the tasks ran, zero or more `TEST_PASS_REUSE_ALARM ws=… file=… proof=…`
 *     lines (a file reuse WOULD have skipped failed on a fresh run).
 * A gate round can concatenate several invocations (selective phase, full phase), so the
 * parser returns one entry per invocation, in output order.
 */

export interface TestPassReuseTotal {
  tasks: number;
  candidates: number;
  reused: number;
  audited: number;
  expiredClean: number;
  /**
   * Lower bound on the test time the reused files would have cost: the sum of each reused
   * file's last CI pass duration. `null` = the durations could not be read for some task.
   */
  minSavedTestMs: number | null;
  /** Reused files with no recorded duration, so not counted in `minSavedTestMs`. */
  unmeasured: number;
}

export interface TestPassReuseWorkspace {
  ws: string;
  /** False when reuse was not applied to this task (`reason` says why). */
  applied: boolean;
  reason: string | null;
  /** Every numeric `key=value` field on the line (candidates, reused, noProof, expired, …). */
  counts: Record<string, number>;
  minSavedTestMs: number | null;
  /** Whether the task ran a narrowed (related-files) selection; null when the line omits it. */
  narrowed: boolean | null;
}

export interface TestPassReuseAlarm {
  ws: string;
  file: string;
  /** Why the file ran instead of being reused (the proof state, e.g. `expired`). */
  proof: string;
}

export interface TestPassReuseRun {
  /** False when the whole invocation printed `TEST_PASS_REUSE applied=false`. */
  applied: boolean;
  offReason: string | null;
  workspaces: TestPassReuseWorkspace[];
  total: TestPassReuseTotal | null;
  alarms: TestPassReuseAlarm[];
}

const LINE_RE = /^(?:\[[^\]]*\]\s*)?(TEST_PASS_REUSE(?:_TOTAL|_ALARM)?) (.*)$/;
const FIELD_RE = /(?:^|\s)([A-Za-z]+)=(\S+)/g;

function fields(rest: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rest.matchAll(FIELD_RE)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

function int(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** `applied=false reason=<r>` keeps everything after `reason=`, since a reason may carry spaces. */
function reasonOf(rest: string): string | null {
  const i = rest.indexOf('reason=');
  return i < 0 ? null : rest.slice(i + 'reason='.length).trim() || null;
}

export function parseTestPassReuse(output: string): TestPassReuseRun[] {
  const runs: TestPassReuseRun[] = [];
  let current: TestPassReuseRun | null = null;
  const openRun = (): TestPassReuseRun => {
    if (current && current.applied && current.total === null) return current;
    current = { applied: true, offReason: null, workspaces: [], total: null, alarms: [] };
    runs.push(current);
    return current;
  };

  for (const raw of output.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trimStart());
    if (!m) continue;
    const kind = m[1]!;
    const rest = m[2]!;
    const f = fields(rest);

    if (kind === 'TEST_PASS_REUSE_TOTAL') {
      const run = openRun();
      run.total = {
        tasks: int(f.get('tasks')) ?? 0,
        candidates: int(f.get('candidates')) ?? 0,
        reused: int(f.get('reused')) ?? 0,
        audited: int(f.get('audited')) ?? 0,
        expiredClean: int(f.get('expiredClean')) ?? 0,
        minSavedTestMs: int(f.get('minSavedTestMs')),
        unmeasured: int(f.get('unmeasured')) ?? 0,
      };
      continue;
    }

    if (kind === 'TEST_PASS_REUSE_ALARM') {
      const ws = f.get('ws');
      const file = f.get('file');
      if (!ws || !file) continue;
      const run = current ?? openRun();
      run.alarms.push({ ws, file, proof: f.get('proof') ?? 'unknown' });
      continue;
    }

    // TEST_PASS_REUSE
    const ws = f.get('ws');
    if (!ws) {
      if (f.get('applied') === 'false') {
        current = {
          applied: false,
          offReason: reasonOf(rest),
          workspaces: [],
          total: null,
          alarms: [],
        };
        runs.push(current);
      }
      continue;
    }
    const run = openRun();
    if (f.get('applied') === 'false') {
      run.workspaces.push({
        ws,
        applied: false,
        reason: reasonOf(rest),
        counts: {},
        minSavedTestMs: null,
        narrowed: null,
      });
      continue;
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of f) {
      if (k === 'ws' || k === 'minSavedTestMs' || k === 'narrowed') continue;
      const n = int(v);
      if (n !== null) counts[k] = n;
    }
    const narrowed = f.get('narrowed');
    run.workspaces.push({
      ws,
      applied: true,
      reason: null,
      counts,
      minSavedTestMs: int(f.get('minSavedTestMs')),
      narrowed: narrowed === 'true' ? true : narrowed === 'false' ? false : null,
    });
  }
  return runs;
}

// ── Pass-proof recorder outcome (WI-10003603) ─────────────────────────────────────────────────
// Per-file reuse can only ever skip what an earlier clean round RECORDED. The recorder (the
// executed-source-map reporter) used to report only to task stderr, which the gate discards, so
// a writer failing on every row (WI-10003597) left reuse at zero for ~8h unnoticed. affected-tests
// now prints the lines below (formats in scripts/lib/executed-source-map.mjs):
//   EXECUTED_SOURCE_MAP_ALARM task=<ws::script> outcome=<failed|timed-out|no-report-unexpected> rows=N error=<message>
//   EXECUTED_SOURCE_MAP_TOTAL tasks=N written=N rows=N retired=N notPersisted=N nothingToRecord=N failed=N timedOut=N noReport=N malformed=N noReportExpected=N noReportUnexpected=N
// The two split keys (WI-10003792) are absent from lines written before the split; they read as 0.

export interface ExecutedSourceMapRecorderTotal {
  tasks: number;
  written: number;
  rows: number;
  retired: number;
  notPersisted: number;
  nothingToRecord: number;
  failed: number;
  timedOut: number;
  /** Armed tasks that wrote no result file — the total, whatever their expectation. */
  noReport: number;
  malformed: number;
  /** Of `noReport`: tasks that never could report (non-vitest, or a config outside the gate). WI-10003792. */
  noReportExpected: number;
  /** Of `noReport`: tasks whose enrolled config SHOULD have reported — a recorder regression or a killed run. */
  noReportUnexpected: number;
}

export interface ExecutedSourceMapRecorderAlarm {
  task: string;
  outcome: string;
  error: string;
}

/**
 * `write-failing` = a database write failed or timed out; `not-persisted` = the round's run was
 * not clean, so it recorded nothing; `unreported` = no armed task reported any outcome (the
 * recorder is not wired); `task-silent` = at least one task whose enrolled config should have
 * reported wrote nothing (WI-10003792); `nothing-to-record` = clean, but no recordable file ran;
 * `recorded` = proofs landed. The first four are alarms: in the gate's own clean checkout
 * each one means the next round has nothing (or less) to reuse.
 */
export type ExecutedSourceMapRecorderVerdict =
  | 'recorded'
  | 'nothing-to-record'
  | 'write-failing'
  | 'not-persisted'
  | 'unreported'
  | 'task-silent';

export interface ExecutedSourceMapRecorderSummary extends ExecutedSourceMapRecorderTotal {
  /** TOTAL lines seen (one per affected-tests invocation). */
  invocations: number;
  verdict: ExecutedSourceMapRecorderVerdict;
  alarm: boolean;
  alarms: ExecutedSourceMapRecorderAlarm[];
}

const RECORDER_TOTAL_KEYS = [
  'tasks',
  'written',
  'rows',
  'retired',
  'notPersisted',
  'nothingToRecord',
  'failed',
  'timedOut',
  'noReport',
  'malformed',
] as const satisfies readonly (keyof ExecutedSourceMapRecorderTotal)[];

/**
 * WI-10003792 split of `noReport`. Kept OUT of RECORDER_TOTAL_KEYS on purpose: a TOTAL line or a
 * persisted recorder written before the split carries neither key, and must still parse (as 0)
 * rather than read as malformed.
 */
const RECORDER_SPLIT_KEYS = ['noReportExpected', 'noReportUnexpected'] as const satisfies readonly (keyof ExecutedSourceMapRecorderTotal)[];

const RECORDER_LINE_RE = /^(?:\[[^\]]*\]\s*)?(EXECUTED_SOURCE_MAP_(?:TOTAL|ALARM)) (.*)$/;
const RECORDER_ALARM_VERDICTS = new Set<ExecutedSourceMapRecorderVerdict>([
  'write-failing',
  'not-persisted',
  'unreported',
  'task-silent',
]);

function recorderVerdict(t: ExecutedSourceMapRecorderTotal): ExecutedSourceMapRecorderVerdict {
  if (t.failed + t.timedOut > 0) return 'write-failing';
  // Every armed task silent is `unreported` — unless every one of them was KNOWN unable to report,
  // which is a round with nothing recordable, not a broken recorder.
  if (t.tasks > 0 && t.noReport === t.tasks) {
    return t.noReportExpected === t.tasks ? 'nothing-to-record' : 'unreported';
  }
  if (t.noReportUnexpected > 0) return 'task-silent';
  if (t.written > 0) return 'recorded';
  if (t.notPersisted > 0) return 'not-persisted';
  return 'nothing-to-record';
}

/**
 * The round's recorder outcome, summed over its affected-tests invocations. Null when the output
 * carries no `EXECUTED_SOURCE_MAP_TOTAL` line (a runner predating the channel, or a round with no
 * recording task) — NOT REPORTED, never "recorded nothing".
 */
export function summarizeExecutedSourceMapRecorder(output: string): ExecutedSourceMapRecorderSummary | null {
  const total: ExecutedSourceMapRecorderTotal = {
    tasks: 0,
    written: 0,
    rows: 0,
    retired: 0,
    notPersisted: 0,
    nothingToRecord: 0,
    failed: 0,
    timedOut: 0,
    noReport: 0,
    malformed: 0,
    noReportExpected: 0,
    noReportUnexpected: 0,
  };
  let invocations = 0;
  const alarms: ExecutedSourceMapRecorderAlarm[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = RECORDER_LINE_RE.exec(raw.trimStart());
    if (!m) continue;
    const rest = m[2]!;
    const f = fields(rest);
    if (m[1] === 'EXECUTED_SOURCE_MAP_ALARM') {
      const task = f.get('task');
      if (!task) continue;
      const i = rest.indexOf('error=');
      alarms.push({
        task,
        outcome: f.get('outcome') ?? 'unknown',
        error: i < 0 ? 'unknown' : rest.slice(i + 'error='.length).trim() || 'unknown',
      });
      continue;
    }
    invocations += 1;
    for (const k of RECORDER_TOTAL_KEYS) total[k] += int(f.get(k)) ?? 0;
    for (const k of RECORDER_SPLIT_KEYS) total[k] += int(f.get(k)) ?? 0;
  }
  if (invocations === 0) return null;
  const verdict = recorderVerdict(total);
  return { ...total, invocations, verdict, alarm: RECORDER_ALARM_VERDICTS.has(verdict), alarms };
}

function recorderHeadline(r: ExecutedSourceMapRecorderSummary): string {
  switch (r.verdict) {
    case 'recorded':
      return `pass proofs: ${r.rows} row(s) recorded by ${r.written} task run(s)`;
    case 'nothing-to-record':
      return 'pass proofs: nothing recordable this round';
    case 'write-failing':
      return (
        `PASS-PROOF RECORDER FAILING: ${r.failed} write(s) failed, ${r.timedOut} timed out` +
        (r.alarms[0] ? ` (${r.alarms[0].task}: ${r.alarms[0].error})` : '')
      );
    case 'not-persisted':
      return `PASS-PROOF RECORDER persisted nothing: ${r.notPersisted} run(s) saw a dirty or sha-less checkout`;
    case 'unreported':
      return `PASS-PROOF RECORDER silent: none of ${r.tasks} recording task(s) reported an outcome`;
    case 'task-silent': {
      const first = r.alarms.find((a) => a.outcome === 'no-report-unexpected');
      return (
        `PASS-PROOF RECORDER partly silent: ${r.noReportUnexpected} enrolled task(s) reported no outcome` +
        (first ? ` (${first.task})` : '')
      );
    }
  }
}

export interface TestPassReuseRoundSummary {
  /** Invocations seen (0 = the round printed no reuse line at all, e.g. an older runner). */
  invocations: number;
  candidates: number;
  reused: number;
  /** Summed lower bound; null when any invocation's savings were unknown. */
  minSavedTestMs: number | null;
  unmeasured: number;
  alarms: TestPassReuseAlarm[];
  /** Distinct reasons reuse was off, whole-run or per task. */
  offReasons: string[];
  /** What the pass-proof recorder did this round (WI-10003603); null = not reported. */
  recorder: ExecutedSourceMapRecorderSummary | null;
  headline: string;
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** One gate round's reuse effect, summed over its invocations, with a one-line headline. */
export function summarizeTestPassReuse(
  runs: TestPassReuseRun[],
  recorder: ExecutedSourceMapRecorderSummary | null = null,
): TestPassReuseRoundSummary {
  let candidates = 0;
  let reused = 0;
  let unmeasured = 0;
  let minSavedTestMs: number | null = 0;
  const alarms: TestPassReuseAlarm[] = [];
  const offReasons = new Set<string>();
  for (const run of runs) {
    alarms.push(...run.alarms);
    if (!run.applied) {
      offReasons.add(run.offReason ?? 'unknown');
      continue;
    }
    for (const w of run.workspaces) {
      if (!w.applied) offReasons.add(w.reason ?? 'unknown');
    }
    if (run.total) {
      candidates += run.total.candidates;
      reused += run.total.reused;
      unmeasured += run.total.unmeasured;
      if (run.total.minSavedTestMs === null) minSavedTestMs = null;
      else if (minSavedTestMs !== null) minSavedTestMs += run.total.minSavedTestMs;
    }
  }
  const reasons = [...offReasons];
  let headline: string;
  if (runs.length === 0) {
    headline = 'per-file reuse: not reported by this round';
  } else if (runs.every((r) => !r.applied)) {
    headline = `per-file reuse off: ${reasons.join(', ')}`;
  } else {
    const saved =
      minSavedTestMs === null
        ? 'test time saved unknown'
        : `at least ${formatDurationMs(minSavedTestMs)} test time saved` +
          (unmeasured > 0 ? ` (${unmeasured} file(s) unmeasured)` : '');
    headline =
      `per-file reuse: ${reused} of ${candidates} candidate file(s) reused, ${saved}` +
      (alarms.length > 0 ? `, ${alarms.length} ALARM(s)` : ', no alarms') +
      (reasons.length > 0 ? `; off for some tasks: ${reasons.join(', ')}` : '');
  }
  if (recorder) headline += `; ${recorderHeadline(recorder)}`;
  return {
    invocations: runs.length,
    candidates,
    reused,
    minSavedTestMs,
    unmeasured,
    alarms,
    offReasons: reasons,
    recorder,
    headline,
  };
}

const RECORDER_VERDICTS = new Set<string>([
  'recorded',
  'nothing-to-record',
  'write-failing',
  'not-persisted',
  'unreported',
  'task-silent',
]);

/** Shape check for a persisted `recorder`; a malformed one reads as not reported (null). */
function parseRecorderSummary(value: unknown): ExecutedSourceMapRecorderSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.invocations) || !RECORDER_TOTAL_KEYS.every((k) => isCount(v[k]))) return null;
  // A record persisted before the WI-10003792 split has neither key (read as 0); a present one must be a count.
  if (!RECORDER_SPLIT_KEYS.every((k) => v[k] === undefined || isCount(v[k]))) return null;
  if (typeof v.verdict !== 'string' || !RECORDER_VERDICTS.has(v.verdict) || typeof v.alarm !== 'boolean') return null;
  if (!Array.isArray(v.alarms)) return null;
  const alarms: ExecutedSourceMapRecorderAlarm[] = [];
  for (const a of v.alarms) {
    if (!a || typeof a !== 'object') return null;
    const { task, outcome, error } = a as Record<string, unknown>;
    if (typeof task !== 'string' || typeof outcome !== 'string' || typeof error !== 'string') return null;
    alarms.push({ task, outcome, error });
  }
  const totals = Object.fromEntries([
    ...RECORDER_TOTAL_KEYS.map((k) => [k, v[k] as number]),
    ...RECORDER_SPLIT_KEYS.map((k) => [k, (v[k] as number | undefined) ?? 0]),
  ]) as unknown as ExecutedSourceMapRecorderTotal;
  return {
    ...totals,
    invocations: v.invocations,
    verdict: v.verdict as ExecutedSourceMapRecorderVerdict,
    alarm: v.alarm,
    alarms,
  };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Read-side shape check for `gate_health.testPassReuse` (the persisted
 * `TestPassReuseRoundSummary` plus the sha it describes). Never a cast: a blob predating the
 * field, or written by a version that shaped it differently, reads as `null` ("not measured")
 * rather than as a half-populated summary a panel would render as fact.
 */
export interface TestPassReuseHealth extends TestPassReuseRoundSummary {
  /** The sha the round judged. */
  judgedSha: string;
  recordedAtMs: number;
}

export function parseTestPassReuseHealth(value: unknown): TestPassReuseHealth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.judgedSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(v.judgedSha)) return null;
  if (!isCount(v.recordedAtMs)) return null;
  if (!isCount(v.invocations) || !isCount(v.candidates) || !isCount(v.reused) || !isCount(v.unmeasured)) {
    return null;
  }
  if (v.minSavedTestMs !== null && !isCount(v.minSavedTestMs)) return null;
  if (typeof v.headline !== 'string' || v.headline.length === 0) return null;
  if (!Array.isArray(v.offReasons) || !v.offReasons.every((r) => typeof r === 'string')) return null;
  if (!Array.isArray(v.alarms)) return null;
  const alarms: TestPassReuseAlarm[] = [];
  for (const a of v.alarms) {
    if (!a || typeof a !== 'object') return null;
    const { ws, file, proof } = a as Record<string, unknown>;
    if (typeof ws !== 'string' || typeof file !== 'string' || typeof proof !== 'string') return null;
    alarms.push({ ws, file, proof });
  }
  return {
    judgedSha: v.judgedSha,
    recordedAtMs: v.recordedAtMs,
    invocations: v.invocations,
    candidates: v.candidates,
    reused: v.reused,
    minSavedTestMs: v.minSavedTestMs as number | null,
    unmeasured: v.unmeasured,
    alarms,
    offReasons: v.offReasons as string[],
    recorder: parseRecorderSummary(v.recorder),
    headline: v.headline,
  };
}

/** Storage caps for `gate_health.testPassReuse`. The headline keeps the full alarm COUNT, so a
 *  capped list never hides how many alarms fired — it only bounds the blob. */
export const TEST_PASS_REUSE_HEALTH_MAX_ALARMS = 20;
const HEALTH_HEADLINE_MAX_CHARS = 400;
const HEALTH_ALARM_FIELD_MAX_CHARS = 300;

/**
 * P-013 runner half: the one record the gate keeps per suite round. The producer (the real
 * `runGreen` in green-checkpoint.ts) builds it from the suite's OWN output — never the post-suite
 * legs or an isolation re-run, which would double-count a task — and stamps the sha that suite
 * actually ran at, so a reader never pairs one round's numbers with another round's verdict.
 *
 * Returns null when the round reported nothing (a candidate that predates the emitter, an early
 * preflight abort) or when the sha is not a commit id. Null means NOT REPORTED, never "zero
 * reused": the recorder then leaves the previous round's record in place, labelled with its own
 * sha, rather than writing a zero that nobody measured.
 */
export function buildTestPassReuseHealth(
  suiteOutput: string,
  judgedSha: string | null | undefined,
  recordedAtMs: number,
): TestPassReuseHealth | null {
  if (!judgedSha || !/^[0-9a-f]{7,64}$/.test(judgedSha)) return null;
  if (!isCount(recordedAtMs)) return null;
  const runs = parseTestPassReuse(suiteOutput);
  const recorder = summarizeExecutedSourceMapRecorder(suiteOutput);
  if (runs.length === 0 && recorder === null) return null;
  const summary = summarizeTestPassReuse(runs, recorder);
  const clip = (s: string) => s.slice(0, HEALTH_ALARM_FIELD_MAX_CHARS);
  return {
    ...summary,
    alarms: summary.alarms
      .slice(0, TEST_PASS_REUSE_HEALTH_MAX_ALARMS)
      .map((a) => ({ ws: clip(a.ws), file: clip(a.file), proof: clip(a.proof) })),
    recorder: summary.recorder
      ? {
          ...summary.recorder,
          alarms: summary.recorder.alarms
            .slice(0, TEST_PASS_REUSE_HEALTH_MAX_ALARMS)
            .map((a) => ({ task: clip(a.task), outcome: clip(a.outcome), error: clip(a.error) })),
        }
      : null,
    headline: summary.headline.slice(0, HEALTH_HEADLINE_MAX_CHARS),
    judgedSha,
    recordedAtMs,
  };
}
