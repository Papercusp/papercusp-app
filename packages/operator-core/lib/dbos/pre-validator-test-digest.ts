/**
 * Pre-validator test-result digest (token-usage-reduction-audit-2026-06-09
 * P-010).
 *
 * The validator's run-and-reread loop was the fleet's most expensive turn
 * pattern (avg 2.1 MTok cache-read/run): it ran the project's whole test
 * suite via Bash, read the output, then re-read it in every later call of
 * the session. Instead, the pipeline now runs the harness's configured test
 * command ONCE, deterministically, just before the validator spawn, and
 * hands the validator a bounded digest artifact. The validator spot-replays
 * only specific failures.
 *
 * This module is the PURE digest half (unit-tested); the side-effecting hook
 * (resolve project → run command → save artifact → return extras) lives in
 * orchestrator-runner.ts next to its siblings (realDebuggerHook).
 */

 
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Lines that indicate a failure / error worth quoting to the validator. */
const FAILURE_LINE_RE =
  /\b(FAIL|FAILED|FAILURE|ERROR|ERR!|✗|✖|×|AssertionError|Expected|Received|Timeout|Cannot|undefined is not|not ok \d)\b|^\s*●|^\s*\d+\)\s/;

/** Suite-summary lines (vitest/jest/cargo/pytest/go style). */
const SUMMARY_LINE_RE =
  /\b(\d+\s+(passed|failed|skipped|pending|todo|errors?)|Tests?:|Test Files|test result:|=+ .* =+|ok\s+\d+|not ok)\b/i;

export interface DigestOptions {
  /** Total byte cap for the digest body. Default 8192. */
  maxBytes?: number;
  /** Max failure-excerpt lines. Default 120. */
  maxFailureLines?: number;
  /** Tail lines always included (summaries live at the end). Default 30. */
  tailLines?: number;
}

export interface TestDigestResult {
  /** One-line human summary for the spawn extra (e.g. "3 failed | 240 passed"). */
  summary: string;
  /** The bounded markdown digest body written to the artifact. */
  body: string;
}

/**
 * Digest a raw test-command output into a bounded artifact body + a one-line
 * summary. Pure — no I/O, no clock.
 */
export function digestTestOutput(
  raw: string,
  exitCode: number,
  command: string,
  opts: DigestOptions = {},
): TestDigestResult {
  const maxBytes = opts.maxBytes ?? 8192;
  const maxFailureLines = opts.maxFailureLines ?? 120;
  const tailLines = opts.tailLines ?? 30;

  const lines = raw.replace(ANSI_RE, '').split('\n');

  // Tail — suite summaries live at the end.
  const tail = lines.slice(-tailLines);

  // Failure excerpt — first N matching lines outside the tail region.
  const tailStart = Math.max(0, lines.length - tailLines);
  const failures: string[] = [];
  for (let i = 0; i < tailStart && failures.length < maxFailureLines; i++) {
    const line = lines[i] ?? '';
    if (FAILURE_LINE_RE.test(line)) failures.push(line);
  }
  const failuresTruncated = failures.length >= maxFailureLines;

  // One-line summary: the last summary-looking line, else exit-code fallback.
  let summary = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line && SUMMARY_LINE_RE.test(line)) {
      summary = line.slice(0, 160);
      break;
    }
  }
  if (!summary) summary = exitCode === 0 ? 'exit 0 (no summary line found)' : `exit ${exitCode}`;

  const sections: string[] = [
    `# Test digest`,
    ``,
    `- Command: \`${command}\``,
    `- Exit code: ${exitCode} (${exitCode === 0 ? 'GREEN' : 'FAILING'})`,
    `- Summary: ${summary}`,
  ];
  if (failures.length > 0) {
    sections.push(
      ``,
      `## Failure excerpt${failuresTruncated ? ` (first ${maxFailureLines} matching lines)` : ''}`,
      '```',
      ...failures,
      '```',
    );
  }
  sections.push(``, `## Output tail (last ${tailLines} lines)`, '```', ...tail, '```');

  let body = sections.join('\n');
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Trim from the failure excerpt first (the tail carries the verdict).
    body = body.slice(0, maxBytes) + '\n[…digest truncated at ' + maxBytes + ' bytes]';
  }
  return { summary, body };
}
