/**
 * Utilities for keeping drizzle-kit's progress renderer readable when the
 * schema CLI runs without an interactive terminal.
 *
 * drizzle-kit v0.31.10 renders a spinner frame on a timer even when its
 * stdout is a pipe. Each redraw contains cursor-control sequences and the
 * complete progress view, so forwarding that stream verbatim turns a short
 * command into thousands of duplicate lines. Keep this helper independent of
 * child-process and database code so the terminal behavior can be tested with
 * ordinary strings.
 */

// CSI, OSC, C1-CSI, and one-byte ESC controls. The sequence is intentionally
// local instead of adding a dependency to this small CLI-only helper.
const ANSI_SEQUENCE =
  /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;

// hanji's clear() uses ESC[2K followed by cursor.to(0) (ESC[1G) when stdout
// is a pipe and has no `columns`. Accept the longer multi-line clear sequence
// too, so a captured TTY-like stream is normalized by the same code.
const REDRAW_PREFIX =
  /\u001b\[2K(?:\u001b\[[0-?]*[ -/]*[@-~])*\u001b\[(?:0|1)G/g;

// drizzle-kit's spinner is a braille glyph in square brackets. Replacing the
// glyph makes otherwise-identical frames compare equal without assuming one
// particular spinner character or leaking terminal animation into CI output.
const SPINNER_GLYPH = /\[[\u2800-\u28ff]\]/gu;
const NON_INTERACTIVE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Build spawnSync options for the drizzle-kit child.
 *
 * Interactive runs keep the existing live renderer. Non-interactive runs pipe
 * only stdout so the caller can collapse redraws before writing the result;
 * stderr remains inherited so diagnostics are still visible immediately.
 *
 * @param {{ cwd: string, env: Record<string, string | undefined>, interactive: boolean }} options
 * @returns {Record<string, unknown>}
 */
export function createSchemaCliSpawnOptions({ cwd, env, interactive }) {
  if (interactive) {
    return { cwd, stdio: 'inherit', env };
  }

  return {
    cwd,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: NON_INTERACTIVE_MAX_BUFFER,
    env,
  };
}

function stripTerminalControls(value) {
  return value.replace(ANSI_SEQUENCE, '');
}

function normalizeFrame(value) {
  return stripTerminalControls(value)
    .replace(SPINNER_GLYPH, '[ ]')
    .replace(/\r/g, '');
}

/**
 * Remove terminal controls and collapse repeated spinner redraws from a
 * drizzle-kit stdout capture while preserving distinct progress transitions.
 *
 * @param {string | Buffer | null | undefined} output captured child stdout
 * @returns {string} readable, non-animated CLI output
 */
export function normalizeSchemaCliOutput(output) {
  if (output == null || output === '') return '';

  const source = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  // CRLF is an ordinary line ending, while a bare CR is a redraw boundary.
  const chunks = source
    .replace(/\r\n/g, '\n')
    .split(REDRAW_PREFIX)
    .flatMap((chunk) => chunk.split('\r'));

  let normalized = '';
  let previousFrame = null;
  for (const chunk of chunks) {
    const frame = normalizeFrame(chunk);
    if (frame === '' || frame === previousFrame) continue;

    // A bare-CR frame has no line ending of its own. Do not concatenate it
    // with the preceding frame when normalizing a conventional progress line.
    if (normalized !== '' && !normalized.endsWith('\n')) normalized += '\n';
    normalized += frame;
    previousFrame = frame;
  }

  return normalized;
}
