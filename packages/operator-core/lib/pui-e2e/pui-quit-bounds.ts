/**
 * How long a PTY harness must wait for `pui` to exit, derived from pui's own
 * source rather than restated by hand.
 *
 * pui turns SIGHUP/SIGTERM/SIGINT into an ordinary quit and guarantees exit
 * within `SIGNAL_QUIT_DEADLINE` (apps/tui/src/main.rs). A harness that kills the
 * PTY and then gives up after exactly that long races pui's own watchdog: in
 * rehearsal run 8b (WI-10004247) the real-claude greeting journey passed its
 * body and then failed teardown with "pui PTY did not exit" after a 5 s wait
 * against a 5 s deadline. Reading the constant keeps the two from drifting
 * back into a tie.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export const PUI_MAIN_RS = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'tui', 'src', 'main.rs');

/** Time allowed beyond pui's deadline for the process and PTY to be reaped. */
export const PUI_EXIT_REAP_MARGIN_MS = 3_000;

/** Read `const NAME: Duration = Duration::from_secs(N)` (or from_millis) from Rust source. */
export function rustDurationConstMs(source: string, name: string): number {
  const match = new RegExp(
    String.raw`const\s+${name}\s*:\s*Duration\s*=\s*Duration::from_(secs|millis)\(\s*(\d+)\s*\)`,
  ).exec(source);
  if (!match) throw new Error(`${name} is not a Duration::from_secs/from_millis constant in pui's main.rs`);
  const value = Number(match[2]);
  return match[1] === 'secs' ? value * 1_000 : value;
}

export interface PuiQuitBounds {
  /** pui's own bound on a signal-initiated quit. */
  signalQuitDeadlineMs: number;
  /** How long a harness waits after killing the PTY before calling it hung. */
  afterKillWaitMs: number;
}

export function puiQuitBounds(source: string = readFileSync(PUI_MAIN_RS, 'utf8')): PuiQuitBounds {
  const signalQuitDeadlineMs = rustDurationConstMs(source, 'SIGNAL_QUIT_DEADLINE');
  return { signalQuitDeadlineMs, afterKillWaitMs: signalQuitDeadlineMs + PUI_EXIT_REAP_MARGIN_MS };
}
