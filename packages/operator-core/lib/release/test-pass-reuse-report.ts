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
import { auditDraw } from '../../../../scripts/lib/test-pass-reuse.mjs';
import type { runPureLaneProofCapture } from '../../../../scripts/lib/pure-lane-proof-capture.mjs';

/** The existing capture result, without its diagnostic console lines. */
export type PureProofCaptureResult = Omit<Awaited<ReturnType<typeof runPureLaneProofCapture>>, 'lines'>;

/**
 * Read the named capture population retained by the producer. Aggregate-only historical
 * records remain unmeasured. A valid record with proofs:null still describes an UNKNOWN
 * population; it cannot establish ordering, subsequent reuse, or acceptance by itself.
 */
export function parsePureProofCaptureResult(value: unknown): PureProofCaptureResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const counters = ['slices', 'files', 'rows', 'retired', 'failed', 'isolatedFail', 'remaining'] as const;
  const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
  if (!['done', 'skipped'].includes(v.state as string) || !counters.every((k) => isCount(v[k])) ||
      !(v.sha === null || (typeof v.sha === 'string' && /^[0-9a-f]{40}$/.test(v.sha))) ||
      !(v.reason === null || text(v.reason)) || !(v.stoppedBy === null || text(v.stoppedBy)) ||
      (v.rows as number) > (v.files as number) || (v.slices as number) > (v.files as number) ||
      (v.failed as number) > (v.files as number) || (v.isolatedFail as number) > (v.failed as number) ||
      !v.evidence || typeof v.evidence !== 'object' || Array.isArray(v.evidence)) return null;
  const e = v.evidence as Record<string, unknown>;
  if (e.version !== 1 || !text(e.runGroupId) || !isCount(e.startedAtMs) || !isCount(e.completedAtMs) ||
      e.completedAtMs < e.startedAtMs || !(e.clean === null || typeof e.clean === 'boolean') ||
      !(e.proofs === null || Array.isArray(e.proofs))) return null;
  if (v.state === 'skipped' && (v.reason === null || e.proofs !== null)) return null;
  if (v.state === 'done' && (v.sha === null || v.reason !== null || e.clean !== true)) return null;

  let proofs: PureProofCaptureResult['evidence']['proofs'] = null;
  if (Array.isArray(e.proofs)) {
    if (v.state !== 'done' || e.clean !== true || e.proofs.length !== v.rows) return null;
    proofs = [];
    const files = new Set<string>();
    const testRunIds = new Set<string>();
    let runner: string | null = null;
    for (const raw of e.proofs) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const p = raw as Record<string, unknown>;
      if (!text(p.file) || !p.file.startsWith('packages/operator-core/') || p.file.includes('\\') ||
          p.file.split('/').some((part) => !part || part === '.' || part === '..') ||
          typeof p.testRunId !== 'string' || !/^[1-9]\d*$/.test(p.testRunId) ||
          !isCount(p.recordedAtMs) || p.recordedAtMs < e.startedAtMs || p.recordedAtMs > e.completedAtMs ||
          !text(p.runnerIdentity) || p.source !== 'local' || p.runContext !== 'green-checkpoint' ||
          p.runGroupId !== e.runGroupId || files.has(p.file) || testRunIds.has(p.testRunId) ||
          (runner !== null && runner !== p.runnerIdentity)) return null;
      files.add(p.file);
      testRunIds.add(p.testRunId);
      runner = p.runnerIdentity;
      proofs.push({ file: p.file, testRunId: p.testRunId, recordedAtMs: p.recordedAtMs,
        runnerIdentity: p.runnerIdentity, runContext: 'green-checkpoint',
        runGroupId: e.runGroupId, source: 'local' });
    }
  }
  return { state: v.state as string, reason: v.reason as string | null, sha: v.sha as string | null,
    slices: v.slices as number, files: v.files as number, rows: v.rows as number,
    retired: v.retired as number, failed: v.failed as number, isolatedFail: v.isolatedFail as number,
    remaining: v.remaining as number, stoppedBy: v.stoppedBy as string | null,
    evidence: { version: 1, runGroupId: e.runGroupId, startedAtMs: e.startedAtMs,
      completedAtMs: e.completedAtMs, clean: e.clean as boolean | null, proofs } };
}

/** Exactly one complete producer result in the stored process output; duplicates are unknown. */
export function readPureProofCaptureResult(output: string): PureProofCaptureResult | null {
  const records = output.split(/\r?\n/).map((line) =>
    /^(?:\[[^\]]*\]\s*)?PURE_PROOF_CAPTURE_RESULT(?:\s+(.*))?$/.exec(line.trim()),
  ).filter((record) => record !== null);
  if (records.length !== 1 || !records[0]![1]) return null;
  try { return parsePureProofCaptureResult(JSON.parse(records[0]![1])); }
  catch { return null; }
}

/** Create-only per-process receipt in the existing checkpoint-log artifact directory. */
export interface PureProofCaptureArchive {
  version: 1;
  runId: string;
  gateFireId: string | null;
  pid: number;
  processStartedAtMs: number;
  judgedSha: string;
  resolvedAtMs: number;
  terminalEmissionCompletedAtMs: number;
  /** null when the producing process did not confirm its durable verdict write. */
  verdictRecordedAtMs: number | null;
  promotion: { candidate: string; recordedAtMs: number; reason: string; promoted: boolean } | null;
  capture: PureProofCaptureResult | null;
  archivedAtMs: number;
}

/** Historical/missing boundaries stay null; inconsistent identities or clocks are rejected. */
export function parsePureProofCaptureArchive(value: unknown): PureProofCaptureArchive | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.runId !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(v.runId) ||
      !(v.gateFireId === null || (typeof v.gateFireId === 'string' && v.gateFireId.trim())) ||
      !isCount(v.pid) || v.pid === 0 || typeof v.judgedSha !== 'string' || !/^[0-9a-f]{40}$/.test(v.judgedSha) ||
      !['processStartedAtMs', 'resolvedAtMs', 'terminalEmissionCompletedAtMs', 'archivedAtMs'].every((k) => isCount(v[k])) ||
      !(v.verdictRecordedAtMs === null || isCount(v.verdictRecordedAtMs))) return null;
  const start = v.processStartedAtMs as number;
  const resolved = v.resolvedAtMs as number;
  const emitted = v.terminalEmissionCompletedAtMs as number;
  const archived = v.archivedAtMs as number;
  if (start > resolved || resolved > emitted || emitted > archived ||
      (v.verdictRecordedAtMs !== null && ((v.verdictRecordedAtMs as number) < resolved ||
        (v.verdictRecordedAtMs as number) > emitted))) return null;
  let promotion: PureProofCaptureArchive['promotion'] = null;
  if (v.promotion !== null) {
    if (!v.promotion || typeof v.promotion !== 'object' || Array.isArray(v.promotion)) return null;
    const p = v.promotion as Record<string, unknown>;
    if (typeof p.candidate !== 'string' || !/^[0-9a-f]{12}$/.test(p.candidate) ||
        !v.judgedSha.startsWith(p.candidate) || !isCount(p.recordedAtMs) ||
        p.recordedAtMs < start || p.recordedAtMs > resolved ||
        typeof p.reason !== 'string' || !/^[a-z-]+$/.test(p.reason) ||
        ['decision-pending', 'superseded-by-refire'].includes(p.reason) || typeof p.promoted !== 'boolean') return null;
    promotion = { candidate: p.candidate, recordedAtMs: p.recordedAtMs,
      reason: p.reason, promoted: p.promoted };
  }
  const capture = v.capture === null ? null : parsePureProofCaptureResult(v.capture);
  if (v.capture !== null && !capture) return null;
  if (capture && (capture.evidence.runGroupId !== `${v.runId}:pure-proof-capture` ||
      (capture.state === 'done' && capture.sha !== v.judgedSha) ||
      capture.evidence.startedAtMs < emitted || capture.evidence.completedAtMs > archived)) return null;
  return { version: 1, runId: v.runId, gateFireId: v.gateFireId as string | null,
    pid: v.pid as number, processStartedAtMs: start, judgedSha: v.judgedSha,
    resolvedAtMs: resolved, terminalEmissionCompletedAtMs: emitted,
    verdictRecordedAtMs: v.verdictRecordedAtMs as number | null, promotion, capture, archivedAtMs: archived };
}

export interface TestPassReuseTotal {
  tasks: number;
  candidates: number;
  reused: number;
  /** Missing audit counters are unmeasured, including in historical logs. */
  audited: number | null;
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
  /** The actual selector configuration; never inferred from its random sample size. */
  auditRate: number | null;
  lane: 'pure' | 'db' | null;
  /** Selector identity also exists when this task drew zero sampled files. */
  runtime?: TestPassReuseRuntime | null;
}

export interface TestPassReuseRuntime {
  version: 1;
  judgedSha: string;
  runnerIdentity: string;
  runContext: string;
  runGroupId: string | null;
  dirty: boolean;
}

function parseReuseRuntime(value: unknown): TestPassReuseRuntime | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.judgedSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.judgedSha) ||
      !['runnerIdentity', 'runContext'].every((k) => typeof v[k] === 'string' && (v[k] as string).trim()) ||
      !(v.runGroupId === null || (typeof v.runGroupId === 'string' && v.runGroupId.trim())) ||
      typeof v.dirty !== 'boolean') return null;
  return { version: 1, judgedSha: v.judgedSha, runnerIdentity: v.runnerIdentity as string,
    runContext: v.runContext as string, runGroupId: v.runGroupId as string | null, dirty: v.dirty };
}

function parseRuntimeField(value: string): TestPassReuseRuntime | null {
  try { return parseReuseRuntime(JSON.parse(decodeURIComponent(value))); }
  catch { return null; }
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
  auditResults?: TestPassReuseAuditFile[];
  malformedAuditResults?: number;
}

/** Exact reporter identity, retained in the existing round archive without a display cap. */
export interface TestPassReuseAuditFile {
  invocation: number;
  ws: string;
  file: string;
  verdict: 'pass' | 'fail' | 'unknown';
  evidenceRef: string;
  judgedSha: string | null;
  runnerIdentity: string | null;
  runContext: string | null;
  runGroupId: string | null;
  dirty: boolean | null;
}

function parseAuditFile(value: unknown): TestPassReuseAuditFile | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.invocation) || (v.invocation as number) < 0 ||
      typeof v.ws !== 'string' || !v.ws.trim() || typeof v.file !== 'string' || !v.file.trim() ||
      v.file.startsWith('/') || v.file.includes('\\') ||
      v.file.split('/').some((part) => !part || part === '.' || part === '..') ||
      !['pass', 'fail', 'unknown'].includes(v.verdict as string) ||
      typeof v.evidenceRef !== 'string' || !v.evidenceRef.trim() ||
      !(v.judgedSha === null || (typeof v.judgedSha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.judgedSha))) ||
      !['runnerIdentity', 'runContext', 'runGroupId'].every((k) => v[k] === null || (typeof v[k] === 'string' && (v[k] as string).trim())) ||
      !(v.dirty === null || typeof v.dirty === 'boolean')) return null;
  return { invocation: v.invocation as number, ws: v.ws, file: v.file,
    verdict: v.verdict as TestPassReuseAuditFile['verdict'], evidenceRef: v.evidenceRef,
    judgedSha: v.judgedSha as string | null, runnerIdentity: v.runnerIdentity as string | null,
    runContext: v.runContext as string | null, runGroupId: v.runGroupId as string | null,
    dirty: v.dirty as boolean | null };
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

function rate(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
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

  let line = 0;
  for (const raw of output.split(/\r?\n/)) {
    line += 1;
    const named = /^(?:\[[^\]]*\]\s*)?TEST_PASS_REUSE_AUDIT_RESULT (.*)$/.exec(raw.trimStart());
    if (named) {
      const run = current ?? openRun();
      let file: TestPassReuseAuditFile | null = null;
      try {
        const payload = JSON.parse(named[1]!);
        if (payload.version === 1) file = parseAuditFile({ ...payload,
          invocation: runs.length - 1, evidenceRef: `suite-output:line:${line}` });
      } catch { /* malformed evidence remains unknown */ }
      if (!file) run.malformedAuditResults = (run.malformedAuditResults ?? 0) + 1;
      else {
        (run.auditResults ??= []).push(file);
        // Inline retry failures may never print a final FAIL row. Preserve their actual miss.
        if (file.verdict === 'fail' && file.dirty === false && file.judgedSha && file.runnerIdentity && file.runContext &&
            !run.alarms.some((a) => a.ws === file.ws && a.file === file.file)) {
          run.alarms.push({ ws: file.ws, file: file.file, proof: 'audit' });
        }
      }
      continue;
    }
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
        audited: int(f.get('audited')),
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
        auditRate: null,
        lane: null,
      });
      continue;
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of f) {
      if (k === 'ws' || k === 'minSavedTestMs' || k === 'narrowed' || k === 'auditRate') continue;
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
      auditRate: rate(f.get('auditRate')),
      lane: f.get('lane') === 'pure' ? 'pure' : f.get('lane') === 'db' ? 'db' : null,
      ...(f.has('runtime') ? { runtime: parseRuntimeField(f.get('runtime')!) } : {}),
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
  /** Qualified counters only; null means a missing, malformed or inconsistent invocation. */
  audit?: TestPassReuseAuditSummary | null;
  /** null means that named first-attempt audit coverage was not retained completely. */
  auditedFiles?: TestPassReuseAuditFile[] | null;
  /** Uncapped per-task selector population, retained for exact archived-window qualification. */
  auditRuns?: TestPassReuseRun[] | null;
  headline: string;
}

export interface TestPassReuseAuditSummary {
  auditRate: number;
  audited: number;
  /** Includes the files selected for audit, which were eligible but deliberately not skipped. */
  eligible: number;
  /** null when any task omitted its lane, so a missing lane cannot turn into zero pure reuse. */
  pureReused: number | null;
  /** Full count, before the persisted alarm list is capped. */
  alarmCount: number;
}

function summarizeReuseAudits(runs: TestPassReuseRun[]): TestPassReuseAuditSummary | null {
  if (!runs.length) return null;
  let audited = 0;
  let eligible = 0;
  let pureReused: number | null = 0;
  let auditRate: number | null = null;
  for (const run of runs) {
    const total = run.total;
    if (!run.applied || !total || !run.workspaces.length || total.tasks !== run.workspaces.length ||
        total.audited === null) return null;
    let workspaceCandidates = 0;
    let workspaceReused = 0;
    let workspaceAudited = 0;
    const seen = new Set<string>();
    for (const w of run.workspaces) {
      const c = w.counts;
      if (!w.applied || seen.has(w.ws) || w.auditRate === null ||
          !isCount(c.candidates) || !isCount(c.reused) || !isCount(c.audited) ||
          c.reused + c.audited > c.candidates) return null;
      seen.add(w.ws);
      if (auditRate !== null && auditRate !== w.auditRate) return null;
      auditRate = w.auditRate;
      workspaceCandidates += c.candidates;
      workspaceReused += c.reused;
      workspaceAudited += c.audited;
      if (w.lane === null) pureReused = null;
      else if (w.lane === 'pure' && pureReused !== null) pureReused += c.reused;
    }
    if (workspaceCandidates !== total.candidates || workspaceReused !== total.reused ||
        workspaceAudited !== total.audited) return null;
    audited += workspaceAudited;
    eligible += workspaceReused + workspaceAudited;
  }
  if (auditRate === null || !isCount(audited) || !isCount(eligible) ||
      (pureReused !== null && !isCount(pureReused))) return null;
  return { auditRate, audited, eligible, pureReused, alarmCount: runs.reduce((n, r) => n + r.alarms.length, 0) };
}

function summarizeAuditFiles(runs: TestPassReuseRun[], summary: TestPassReuseAuditSummary | null): TestPassReuseAuditFile[] | null {
  if (!summary) return null;
  const files: TestPassReuseAuditFile[] = [];
  for (const [invocation, run] of runs.entries()) {
    if (run.malformedAuditResults) return null;
    const results = run.auditResults ?? [];
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const file of results) {
      const identity = `${file.ws}\0${file.file}`;
      if (file.invocation !== invocation || seen.has(identity) ||
          !run.workspaces.some((w) => w.ws === file.ws)) return null;
      seen.add(identity);
      counts.set(file.ws, (counts.get(file.ws) ?? 0) + 1);
      files.push(file);
    }
    if (run.workspaces.some((w) => (counts.get(w.ws) ?? 0) !== w.counts.audited)) return null;
  }
  return files.length === summary.audited ? files : null;
}

/** Archived invocation identity comes from the run ledger, not a grader's aggregate count. */
export interface TestPassReuseAuditInvocation {
  runId: string;
  judgedSha: string;
  runnerIdentity: string;
  startedAtMs: number;
  completedAtMs: number;
  output: string;
  /** Per-file first-attempt results. null means that the archive did not retain them. */
  auditedFiles: TestPassReuseAuditFile[] | null;
  /** Canonical archive can retain the parsed suite evidence without the whole console log. */
  auditRuns?: TestPassReuseRun[];
  expectedRunGroupId?: string;
}

/**
 * R-2 detector over an exact archived population. A caller must resolve `expectedRunIds` from
 * the canonical ledger for these boundaries before using the result as acceptance evidence.
 * A bounded page, sampled population or empty window cannot establish zero real misses.
 */
export function evaluateTestPassReuseAuditWindow(input: {
  windowStartMs: number;
  windowEndMs: number;
  expectedRunIds: string[];
  invocations: TestPassReuseAuditInvocation[];
}): { verdict: 'pass' | 'fail' | 'unknown'; reason: string; runIds: string[]; audited: number; alarms: number } {
  const result = (verdict: 'pass' | 'fail' | 'unknown', reason: string, audited = 0, alarms = 0) =>
    ({ verdict, reason, runIds: input.invocations.map((r) => r.runId), audited, alarms });
  const ids = new Set(input.expectedRunIds);
  if (!isCount(input.windowStartMs) || !isCount(input.windowEndMs) || input.windowStartMs >= input.windowEndMs ||
      !ids.size || ids.size !== input.expectedRunIds.length || input.expectedRunIds.some((id) => !id.trim()) ||
      input.invocations.length !== ids.size || new Set(input.invocations.map((r) => r.runId)).size !== ids.size ||
      input.invocations.some((r) => !ids.has(r.runId))) {
    return result('unknown', 'The exact nonempty invocation population and window are required.');
  }
  let audited = 0;
  let alarms = 0;
  let incomplete = false;
  let wrongRate = false;
  for (const invocation of input.invocations) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(invocation.judgedSha) || !invocation.runnerIdentity.trim() ||
        !isCount(invocation.startedAtMs) || !isCount(invocation.completedAtMs) ||
        invocation.startedAtMs < input.windowStartMs || invocation.completedAtMs > input.windowEndMs ||
        invocation.startedAtMs > invocation.completedAtMs) {
      return result('unknown', 'An invocation has missing or out-of-window source/runtime identity.');
    }
    const runs = invocation.auditRuns ?? parseTestPassReuse(invocation.output);
    const summary = summarizeReuseAudits(runs);
    const misses = new Set(runs.flatMap((run, i) => run.alarms.map((a) => `${i}\0${a.ws}\0${a.file}`)));
    if (!summary || invocation.auditedFiles === null) {
      alarms += misses.size;
      incomplete = true;
      continue;
    }
    wrongRate ||= summary.auditRate !== 0.05;
    const files = invocation.auditedFiles;
    const seen = new Set<string>();
    const byWorkspace = new Map<string, number>();
    for (const file of files) {
      const taskIdentity = `${file.invocation}\0${file.ws}`;
      const identity = `${taskIdentity}\0${file.file}`;
      const valid = isCount(file.invocation) && file.invocation < runs.length &&
        Boolean(file.ws.trim() && file.file.trim() && file.evidenceRef.trim()) &&
        file.judgedSha === invocation.judgedSha && file.runnerIdentity === invocation.runnerIdentity &&
        file.runContext === 'green-checkpoint' && file.dirty === false &&
        (invocation.expectedRunGroupId === undefined || file.runGroupId === invocation.expectedRunGroupId) &&
        runs[file.invocation]!.workspaces.some((w) => w.ws === file.ws && (w.counts.audited ?? 0) > 0) &&
        // The selector hashes the repo-relative file and judged SHA; an unrelated passing
        // file cannot be substituted for one of its actual audit draws.
        auditDraw(file.file, invocation.judgedSha) < 0.05 &&
        ['pass', 'fail'].includes(file.verdict);
      if (!valid || seen.has(identity)) incomplete = true;
      seen.add(identity);
      byWorkspace.set(taskIdentity, (byWorkspace.get(taskIdentity) ?? 0) + 1);
      if (valid && file.verdict === 'fail') misses.add(identity);
    }
    // Several affected-tests invocations can occur in one suite output. A file may be audited
    // in both, but the results must name which invocation actually executed it.
    const expected = new Map<string, number>();
    runs.forEach((run, i) => run.workspaces.forEach((w) => expected.set(`${i}\0${w.ws}`, w.counts.audited!)));
    if (files.length !== summary.audited || [...byWorkspace.keys()].some((ws) => !expected.has(ws)) ||
        [...expected].some(([ws, count]) => (byWorkspace.get(ws) ?? 0) !== count)) incomplete = true;
    audited += files.length;
    alarms += misses.size;
  }
  if (alarms > 0) return result('fail', 'A first-attempt reuse soundness miss was observed.', audited, alarms);
  if (wrongRate) return result('fail', 'The archived selector did not use the required 5% audit rule.', audited);
  if (incomplete || audited === 0) return result('unknown', 'Audit files/results or nonempty observed audit coverage are missing.', audited);
  return result('pass', 'Every named audit in the complete window passed under the 5% rule.', audited);
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
  const audit = summarizeReuseAudits(runs);
  return {
    invocations: runs.length,
    candidates,
    reused,
    minSavedTestMs,
    unmeasured,
    alarms,
    offReasons: reasons,
    recorder,
    audit,
    auditedFiles: summarizeAuditFiles(runs, audit),
    auditRuns: audit ? runs.map(({ applied, offReason, workspaces, total, alarms }) =>
      ({ applied, offReason, workspaces, total, alarms })) : null,
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
  /** Actual candidate-suite invocation; absence in historical records means unmeasured. */
  suite?: TestPassReuseSuite | null;
}

export interface TestPassReuseSuite {
  command: string;
  runGroupId: string;
  startedAtMs: number;
  completedAtMs: number;
}

function parseReuseSuite(value: unknown, recordedAtMs: number): TestPassReuseSuite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.command !== 'string' || !v.command.trim() ||
      typeof v.runGroupId !== 'string' || !v.runGroupId.trim() ||
      !isCount(v.startedAtMs) || !isCount(v.completedAtMs) ||
      v.startedAtMs > v.completedAtMs || v.completedAtMs > recordedAtMs) return null;
  return { command: v.command, runGroupId: v.runGroupId,
    startedAtMs: v.startedAtMs, completedAtMs: v.completedAtMs };
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
    ...(v.suite === undefined ? {} : { suite: parseReuseSuite(v.suite, v.recordedAtMs) }),
    invocations: v.invocations,
    candidates: v.candidates,
    reused: v.reused,
    minSavedTestMs: v.minSavedTestMs as number | null,
    unmeasured: v.unmeasured,
    alarms,
    offReasons: v.offReasons as string[],
    recorder: parseRecorderSummary(v.recorder),
    ...(v.audit === undefined ? {} : { audit: parseAuditSummary(v.audit) }),
    ...(v.auditedFiles === undefined ? {} : { auditedFiles: parseArchivedAuditFiles(v.auditedFiles) }),
    ...(v.auditRuns === undefined ? {} : { auditRuns: parseArchivedAuditRuns(v.auditRuns) }),
    headline: v.headline,
  };
}

function parseArchivedAuditFiles(value: unknown): TestPassReuseAuditFile[] | null {
  if (!Array.isArray(value)) return null;
  const files = value.map(parseAuditFile);
  if (files.some((file) => file === null)) return null;
  const seen = new Set<string>();
  for (const file of files as TestPassReuseAuditFile[]) {
    const identity = `${file.invocation}\0${file.ws}\0${file.file}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
  }
  return files as TestPassReuseAuditFile[];
}

function parseAuditSummary(value: unknown): TestPassReuseAuditSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.auditRate !== 'number' || !Number.isFinite(v.auditRate) || v.auditRate < 0 || v.auditRate > 1 ||
      !isCount(v.audited) || !isCount(v.eligible) || v.audited > v.eligible || !isCount(v.alarmCount) ||
      (v.pureReused !== null && (!isCount(v.pureReused) || v.pureReused > v.eligible - v.audited))) return null;
  return { auditRate: v.auditRate, audited: v.audited, eligible: v.eligible,
    pureReused: v.pureReused as number | null, alarmCount: v.alarmCount };
}

function parseArchivedAuditRuns(value: unknown): TestPassReuseRun[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const runs: TestPassReuseRun[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.applied !== true || r.offReason !== null || !Array.isArray(r.workspaces) ||
        !Array.isArray(r.alarms) || !r.total || typeof r.total !== 'object') return null;
    const t = r.total as Record<string, unknown>;
    if (!['tasks', 'candidates', 'reused', 'audited', 'expiredClean', 'unmeasured'].every((k) => isCount(t[k])) ||
        !(t.minSavedTestMs === null || isCount(t.minSavedTestMs))) return null;
    const workspaces: TestPassReuseWorkspace[] = [];
    for (const rawWorkspace of r.workspaces) {
      if (!rawWorkspace || typeof rawWorkspace !== 'object') return null;
      const w = rawWorkspace as Record<string, unknown>;
      if (typeof w.ws !== 'string' || !w.ws.trim() || w.applied !== true || w.reason !== null ||
          !w.counts || typeof w.counts !== 'object' || Array.isArray(w.counts) ||
          !Object.values(w.counts).every(isCount) ||
          !(w.minSavedTestMs === null || isCount(w.minSavedTestMs)) ||
          !(w.narrowed === null || typeof w.narrowed === 'boolean') ||
          !(w.lane === null || w.lane === 'pure' || w.lane === 'db') ||
          typeof w.auditRate !== 'number' || !Number.isFinite(w.auditRate) || w.auditRate < 0 || w.auditRate > 1) return null;
      workspaces.push({ ws: w.ws, applied: true, reason: null, counts: { ...w.counts as Record<string, number> },
        minSavedTestMs: w.minSavedTestMs as number | null, narrowed: w.narrowed as boolean | null,
        lane: w.lane as TestPassReuseWorkspace['lane'], auditRate: w.auditRate,
        ...(w.runtime === undefined ? {} : { runtime: parseReuseRuntime(w.runtime) }) });
    }
    if (new Set(workspaces.map((w) => w.ws)).size !== workspaces.length) return null;
    const alarms: TestPassReuseAlarm[] = [];
    for (const rawAlarm of r.alarms) {
      if (!rawAlarm || typeof rawAlarm !== 'object') return null;
      const a = rawAlarm as Record<string, unknown>;
      if (!['ws', 'file', 'proof'].every((k) => typeof a[k] === 'string' && (a[k] as string).trim())) return null;
      alarms.push({ ws: a.ws as string, file: a.file as string, proof: a.proof as string });
    }
    runs.push({ applied: true, offReason: null, workspaces, total: { ...t } as unknown as TestPassReuseTotal, alarms });
  }
  return summarizeReuseAudits(runs) ? runs : null;
}

/** Parse the compact append-only checkpoint archive, not the mutable display health slot. */
export function parseTestPassReuseAuditArchive(value: unknown): {
  judgedSha: string; recordedAtMs: number; auditRuns: TestPassReuseRun[]; auditedFiles: TestPassReuseAuditFile[];
  suite?: TestPassReuseSuite | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!v.audit || typeof v.audit !== 'object') return null;
  const audit = v.audit as Record<string, unknown>;
  const summary = parseAuditSummary(audit);
  const runs = parseArchivedAuditRuns(v.auditRuns);
  const files = parseArchivedAuditFiles(v.auditedFiles);
  if (!summary || !runs || !files || !isCount(audit.recordedAtMs) ||
      typeof audit.judgedSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(audit.judgedSha)) return null;
  const derived = summarizeReuseAudits(runs)!;
  if (Object.keys(derived).some((k) => derived[k as keyof TestPassReuseAuditSummary] !==
      summary[k as keyof TestPassReuseAuditSummary])) return null;
  return { judgedSha: audit.judgedSha, recordedAtMs: audit.recordedAtMs, auditRuns: runs, auditedFiles: files,
    ...(v.suite === undefined ? {} : { suite: parseReuseSuite(v.suite, audit.recordedAtMs) }) };
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
  suite?: TestPassReuseSuite | null,
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
    ...(suite === undefined ? {} : { suite: parseReuseSuite(suite, recordedAtMs) }),
  };
}
