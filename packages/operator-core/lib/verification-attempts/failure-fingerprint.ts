/**
 * failure-fingerprint.ts — a stable, short key for "how did this slow attempt fail".
 *
 * expensive-verification-loops-2026-09-29 P-001 (R-1). The loop detector (P-002)
 * compares these keys across a work-item's attempts: two failures with DIFFERENT
 * fingerprints, or three with the SAME one, is the grinding signal. So the key has to
 * be equal for the same failure across runs and different for different failures, and
 * it must never be derived from volatile text (timestamps, pids, temp dirs, run ids).
 *
 * Three sources, strongest first:
 *  1. `structured` — the harness told us: phase / step / reason code. The failing
 *     `HARNESS_RESULT … first_failure=<phase>/<step>/<reason>` line that every
 *     verification-harness adopter prints (P-003 runner and bin/vh.sh), read with the
 *     contract's own `parseSummaryLine` so the line has one owner; or the caller's object.
 *     WI-10004032: this used to look for a `VERIFY_RESULT` line nothing emits, so every
 *     adopter fell through to (2) and fingerprinted the HARNESS_RESULT line itself, run id
 *     and all — two runs of the SAME failure never compared equal.
 *  2. `log` — the hive-git physical drill's `phase <X> (<fn>): <reason>` summary (alone on
 *     a line, or inside its `… adapter failed (exit N) in phase …` line), else the LAST
 *     error-shaped line of the log tail, with volatile tokens masked. The capability:bash
 *     runner's own marker lines (JOB END / JOB DIED) are never that line.
 *  3. `exit` — nothing readable: the exit reason and code alone.
 *
 * Pure: no I/O. The ledger (attempt-ledger.ts) reads the log tail and calls this.
 */
import { createHash } from 'node:crypto';
import { parseSummaryLine } from '@papercusp/verification-harness';

export type FailureFingerprintSource = 'structured' | 'log' | 'exit';

export interface StructuredFailure {
  phase: string;
  step?: string | null;
  reasonCode: string;
}

export interface FailureFingerprintInput {
  exitCode?: number | null;
  exitReason?: string | null;
  /** The last few KB of the attempt's log, if one exists. */
  logTail?: string | null;
  /** A harness-reported result; wins over anything parsed from the log. */
  structured?: StructuredFailure | null;
}

export interface FailureFingerprint {
  /** `<source>:<12 hex>` — compare these, never the label. */
  fingerprint: string;
  /** The normalized text the fingerprint was hashed from, for humans. */
  label: string;
  source: FailureFingerprintSource;
  structured: StructuredFailure | null;
}

/**
 * The drill summary `phase <X> (<fn>): <reason>`, alone on a line (physical-failure-summary.sh)
 * or embedded in hive-git-drill.sh's `✗ physical E/G adapter failed (exit N) in phase …` line.
 * The trailing `— evidence kept in <per-run dir>` is not part of the reason: it differs on
 * every run and would make two runs of the same failure look distinct.
 */
const DRILL_SUMMARY_RE = /(?:^|\bin )phase ([A-Za-z0-9_-]+) \(([^)]+)\): (.+?)(?:\s+— evidence kept in \S+)?$/;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERRORISH_RE =
  /\b(error|errors|fail|failed|failure|failing|refus(?:ed|al|es)|fatal|panic|assert(?:ion)?|traceback|exception|timed? ?out|timeout|denied|not found|cannot|unable|aborted?|mismatch)\b|✗|❌/i;
/** Lines that mention failure only to report that there was none. */
const ZERO_FAILURE_RE = /\b(fail(?:ed|ures?|ing)?|errors?)\s*[=:]\s*0\b|\b0\s+(failed|failures?|errors?)\b|\bno (errors?|failures?)\b/i;

/**
 * Prefix of the lines the capability:bash runner itself appends to a job log
 * (`[capability:bash] JOB END: status=failed exit=N …`, `… JOB DIED`, …). They describe the
 * WRAPPER, not the attempt: every failed job ends with one, so reading it as the failure line
 * made two different drill failures share one fingerprint (WI-10004209). Such lines are never
 * fingerprinted; a log with nothing else readable falls through to the exit-code fingerprint.
 * Pinned against bash-jobs.ts's JOB_LOG_*_MARKER_PREFIX in failure-fingerprint.test.ts.
 */
export const RUNNER_MARKER_PREFIX = '[capability:bash] ';

/** Mask the tokens that differ between two runs of the same failure. */
export function normalizeFailureText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, (m) => (/[a-f]/i.test(m) && /\d/.test(m) ? '<hex>' : m))
    .replace(/(?:\/tmp|\/var\/tmp|\/run\/user\/\d+)\/[^\s'":]+/g, '<tmp>')
    .replace(/\b\d+(?:\.\d+)?(ms|s|m|h|kb|mb|gb|b)?\b/gi, (_m, unit: string | undefined) => `N${unit ?? ''}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function hashKey(source: FailureFingerprintSource, key: string): string {
  return `${source}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function fromStructured(s: StructuredFailure): FailureFingerprint {
  const phase = s.phase.trim();
  const step = s.step?.trim() || null;
  const reasonCode = s.reasonCode.trim();
  const label = `phase=${phase} step=${step ?? '-'} reason=${reasonCode}`;
  return {
    fingerprint: hashKey('structured', label),
    label,
    source: 'structured',
    structured: { phase, step, reasonCode },
  };
}

/** The last line matching `re`, scanning from the end. */
function lastMatch(lines: readonly string[], re: RegExp): RegExpMatchArray | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(re);
    if (m) return m;
  }
  return null;
}

export function failureFingerprint(input: FailureFingerprintInput): FailureFingerprint {
  if (input.structured?.phase && input.structured.reasonCode) return fromStructured(input.structured);

  const lines = (input.logTail ?? '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(RUNNER_MARKER_PREFIX));

  for (let i = lines.length - 1; i >= 0; i--) {
    const summary = parseSummaryLine(lines[i]!);
    if (!summary) continue;
    // The newest HARNESS_RESULT line is the run's verdict. A passing one (or one with no
    // named failure) says nothing about why the attempt failed; fall through to the log.
    const ff = summary.firstFailure;
    if (summary.verdict !== 'pass' && ff?.phase) {
      return fromStructured({ phase: ff.phase, step: ff.step, reasonCode: ff.reasonCode ?? 'unspecified' });
    }
    break;
  }

  const drill = lastMatch(lines, DRILL_SUMMARY_RE);
  if (drill) {
    const label = `phase ${drill[1]} (${drill[2]}): ${normalizeFailureText(drill[3]!)}`;
    return { fingerprint: hashKey('log', label), label, source: 'log', structured: null };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!ERRORISH_RE.test(line) || ZERO_FAILURE_RE.test(line)) continue;
    const label = normalizeFailureText(line);
    if (label) return { fingerprint: hashKey('log', label), label, source: 'log', structured: null };
  }

  const reason = input.exitReason?.trim() || 'no exit reason';
  const label = `exit ${normalizeFailureText(reason)} code=${input.exitCode ?? 'none'}`;
  return { fingerprint: hashKey('exit', label), label, source: 'exit', structured: null };
}
