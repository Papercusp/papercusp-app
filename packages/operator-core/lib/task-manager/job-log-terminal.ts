/**
 * task-manager/job-log-terminal — the durable JOB END marker in a job's log.
 *
 * A confined `capability:bash` background job runs as a transient systemd
 * service whose runner (`systemd-scope-env-runner.mjs`) owns the log file and
 * writes `[capability:bash] JOB END: status=… exit=N at …` when the payload
 * finishes. The operator host only WATCHES the unit (`systemd-run --pipe
 * --wait`), and it is restartable. When the host restarts while the job runs,
 * the watcher is gone, so the reconciler closes the row. It reads systemd for
 * the exit. A SUCCESSFUL transient service is garbage-collected at once, so
 * systemd answers `not-found` with no ExecMainStatus, and the row used to close
 * as `ended_unobserved` (verification outcome `unknown`) even though the exit
 * code sat in the log file (WI-10004208).
 *
 * This module is the one parser for that marker. It lives in task-manager, below
 * the capability tool layer, so the reconciler and `capability:bash_output`
 * share it without the lower layer importing a tool module.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { SYSTEMD_RUNNER_JOB_END_PREFIX } from '../systemd-scope-env-runner.mjs';

/** Every status a JOB END line can carry (the runner writes the first two; the
 *  operator's own close handler can also write killed/timed_out). */
export type JobLogTerminalStatus = 'completed' | 'failed' | 'killed' | 'timed_out';

export interface JobLogTerminal {
  status: JobLogTerminalStatus;
  exitCode: number | null;
}

/** The prefix is DERIVED from the runner that writes it, never restated. */
export const JOB_LOG_END_MARKER_PREFIX: string = SYSTEMD_RUNNER_JOB_END_PREFIX;

// The marker is written only after the child reaches a terminal state and the
// spill stream is flushed. A confined service runner can write a raw verdict
// first so reader loss never strands the log; when the operator survives, it
// appends a later normalized verdict. The LAST matching marker is authoritative.
// Anchored at the start of a line so ordinary command output containing the
// prefix mid-line cannot become a false terminal verdict.
const JOB_LOG_END_MARKER_RE = new RegExp(
  '^' +
    JOB_LOG_END_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ': status=(completed|failed|killed|timed_out) exit=(null|-?\\d+) at [^\\n]*(?:\\n|$)',
  'gm',
);

/** Parse the durable terminal marker from a job log (or its tail). */
export function parseJobLogEndMarker(log: string): JobLogTerminal | null {
  JOB_LOG_END_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let latest: RegExpExecArray | null = null;
  while ((match = JOB_LOG_END_MARKER_RE.exec(log)) !== null) latest = match;
  JOB_LOG_END_MARKER_RE.lastIndex = 0;
  if (!latest) return null;
  return {
    status: latest[1] as JobLogTerminalStatus,
    exitCode: latest[2] === 'null' ? null : Number(latest[2]),
  };
}

/** Bytes read from the END of the log. The marker is the last thing written, so
 *  a bounded tail is enough and a multi-GB log costs one small read. */
export const JOB_LOG_TERMINAL_TAIL_BYTES = 64 * 1024;

/**
 * Read the durable JOB END verdict from a job log on disk. Returns null when the
 * file is missing, unreadable or carries no marker — "no evidence", never a
 * verdict. Reads only the last {@link JOB_LOG_TERMINAL_TAIL_BYTES}.
 */
export function readJobLogTerminal(logPath: string): JobLogTerminal | null {
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    const length = Math.min(size, JOB_LOG_TERMINAL_TAIL_BYTES);
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    fd = openSync(logPath, 'r');
    readSync(fd, buf, 0, length, size - length);
    return parseJobLogEndMarker(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}
