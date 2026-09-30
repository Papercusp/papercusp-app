/**
 * Durable terminal evidence for the detached release deploy.
 *
 * The deploy runs under `systemd-run --collect`, so systemd intentionally erases
 * the transient unit after it exits. The deploy normally records a pipeline event,
 * but a shell/process exit before that writer runs used to leave no durable answer
 * to "did the detached deploy finish, and with what exit code?". Both launch paths
 * wrap the same payload with this EXIT marker so status survives unit collection.
 */

import * as fs from 'node:fs';

export const RELEASE_DEPLOY_UNIT = 'papercup-auto-deploy';
export const DEPLOY_TERMINAL_MARKER_PATH = `/tmp/${RELEASE_DEPLOY_UNIT}.terminal.json`;

export interface DeployTerminalMarker {
  exitCode: number;
  finishedAt: string;
  markerPath: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Wrap a deploy payload in one bash EXIT owner.
 *
 * - removes the prior run's marker before the payload starts;
 * - preserves the payload's exit code;
 * - writes through a same-directory temporary file and rename, so readers see
 *   either the complete old record or the complete new record, never torn JSON.
 */
export function buildDeployTerminalShell(
  payload: string,
  markerPath = DEPLOY_TERMINAL_MARKER_PATH,
): string {
  return [
    `marker=${shellQuote(markerPath)}`,
    'rm -f -- "$marker" "$marker.tmp.$$"',
    '_papercusp_write_deploy_terminal() {',
    '  ec=$?',
    '  trap - EXIT',
    '  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '  tmp="$marker.tmp.$$"',
    `  printf '{"exitCode":%s,"finishedAt":"%s"}\\n' "$ec" "$finished_at" > "$tmp"`,
    '  mv -f -- "$tmp" "$marker"',
    '  exit "$ec"',
    '}',
    'trap _papercusp_write_deploy_terminal EXIT',
    payload,
  ].join('\n');
}

export function parseDeployTerminalMarker(
  raw: string,
  markerPath = DEPLOY_TERMINAL_MARKER_PATH,
): DeployTerminalMarker | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const exitCode = parsed.exitCode;
    const finishedAt = parsed.finishedAt;
    if (
      typeof exitCode !== 'number' ||
      !Number.isInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > 255 ||
      typeof finishedAt !== 'string' ||
      !Number.isFinite(Date.parse(finishedAt))
    ) {
      return null;
    }
    return { exitCode, finishedAt, markerPath };
  } catch {
    return null;
  }
}

/** Best-effort status read: absent or malformed evidence is unknown, never success. */
export function readDeployTerminalMarker(
  markerPath = DEPLOY_TERMINAL_MARKER_PATH,
): DeployTerminalMarker | null {
  try {
    return parseDeployTerminalMarker(fs.readFileSync(markerPath, 'utf8'), markerPath);
  } catch {
    return null;
  }
}
