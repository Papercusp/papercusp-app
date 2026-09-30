/**
 * sentinel-pane-input — write a line of user input into the dock's 🛡 Sentinel
 * pane (a `psu --role=sentinel` Claude-Code TUI) so it lands in THE one Sentinel
 * pipeline (voice-unified-sentinel-pipeline-2026-07-01, D-001: the pane is the
 * single brain of record for every modality).
 *
 * Extracted from the POST /operator/papercup-input route so in-process callers
 * (the operator voice host relaying EL utterances, the deep-delegation watch
 * injecting answers) share the exact mechanics + guards instead of self-calling
 * HTTP:
 *   - pane targeting via the ~/.papercusp/sentinel-pane registration
 *     (`psu-sentinel` writes "<session> <paneId>" at launch),
 *   - the boot-window warm-up gate (a fresh registration means psu/Claude is
 *     still booting; writing early silently loses the turn),
 *   - the exited-pane guard (writing Enter into a zellij re-run prompt would
 *     TRIGGER the re-run and lose the turn).
 *
 * LOCAL APP USER ONLY (owner constraint, 2026-06-22): this is the local
 * input→pane pipeline, NOT the P2P voice-channel system.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * How long after the Sentinel pane registers (launch start) to treat it as still
 * "warming up" — psu bootstrap + Claude TUI boot before the composer accepts
 * input. A write inside this window is delayed (not dropped) so it lands in a
 * ready composer. Sized to cover a typical psu+claude cold boot on the dev box.
 */
export const SENTINEL_WARMUP_MS = 8000;

/** The operator may not carry ~/.cargo/bin on PATH; prefer the known location. */
function zellijBin(): string {
  const cargoBin = join(homedir(), '.cargo', 'bin', 'zellij');
  return existsSync(cargoBin) ? cargoBin : 'zellij';
}

 
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * True when a `dump-screen` shows a zellij command pane whose process has
 * EXITED and is "held" at the re-run prompt (e.g. the Sentinel's psu/Claude
 * session crashed or quit). Writing into such a pane is harmful: `write-chars`
 * goes nowhere useful and the trailing Enter (`write 13`) TRIGGERS the re-run,
 * spawning a fresh session AND losing the turn. Requires BOTH `EXIT CODE:` and
 * a `re-run` hint so ordinary chat content mentioning "exit code" can't
 * false-positive.
 */
export function isExitedPaneScreen(dump: string): boolean {
  const clean = dump.replace(ANSI, '');
  return /EXIT CODE:/i.test(clean) && /re-?run/i.test(clean);
}

/** Every live (non-EXITED) `pui-dock-*` zellij session. Multiple can coexist —
 *  the dock relaunches on shell restarts and more than one desktop shell may be
 *  running — so "the" dock session is only knowable via the pane REGISTRATION,
 *  never by picking the first listed session (P-019 hardening). */
async function listLiveDockSessions(): Promise<string[]> {
  const out: string[] = [];
  try {
    const { stdout } = await exec(zellijBin(), ['ls'], { timeout: 4000 });
    for (const raw of stdout.split('\n')) {
      const line = raw.replace(ANSI, '');
      const m = line.match(/^(pui-dock-\S+)/);
      if (m && !/EXITED/.test(line)) out.push(m[1]);
    }
  } catch {
    /* zellij unavailable / no sessions */
  }
  return out;
}

/**
 * Read the Sentinel pane registration that `psu-sentinel` writes at launch
 * ("<session> <paneId>"), so we can write to the Sentinel pane specifically via
 * `--pane-id` instead of whatever pane is focused. null if absent/malformed.
 */
function readSentinelPaneReg(): { session: string; paneId: string } | null {
  try {
    const raw = readFileSync(join(homedir(), '.papercusp', 'sentinel-pane'), 'utf8').trim();
    const sp = raw.indexOf(' ');
    if (sp <= 0) return null;
    const session = raw.slice(0, sp).trim();
    const paneId = raw.slice(sp + 1).trim();
    return session && paneId ? { session, paneId } : null;
  } catch {
    return null;
  }
}

export type SentinelPaneWrite =
  | { ok: true; session: string; paneId: string | null; targeted: boolean }
  | {
      ok: false;
      /** Machine-readable failure class for callers that branch (HTTP status, spoken error). */
      reason: 'no-dock' | 'no-sentinel-pane' | 'pane-exited' | 'write-failed';
      error: string;
      session?: string;
      paneId?: string;
    };

/**
 * The pane-input prefix a voice-origin turn is tagged with (EI-10563). Mirrors
 * the `[deep-answer WI-NNN]` pattern (papercup-deep-watch.ts) that the papercup
 * persona already keys on reliably: the pane can't otherwise tell a spoken
 * turn from typed text (both arrive as plain stdin), so "was this voice?"
 * silently degraded to an LLM guess — a real ack one turn, dead air the next.
 * A leading, unmissable textual marker is a much stronger signal than
 * expecting the model to always remember "every turn is spoken."
 */
export const VOICE_TURN_PREFIX = '[voice]';

/**
 * Write `text` into the Sentinel pane's composer + Enter to submit the turn.
 * Applies the warm-up gate and the exited-pane guard. Never throws.
 *
 * TARGETED WRITES ONLY (voice-public-release-readiness P-019): the write goes
 * to the pane the `psu-sentinel` shim REGISTERED (~/.papercusp/sentinel-pane),
 * and only when that registration's session is still among the live docks.
 * The old "fall back to whatever pane is focused" behavior is gone — with
 * dock relaunch churn and multiple concurrent `pui-dock-*` sessions it typed
 * the user's words into an arbitrary agent's composer (a misfire far worse
 * than degrading). Callers treat `no-sentinel-pane` like `no-dock`: the pane
 * route is unavailable — fall back (voice → the in-process converse brain;
 * deep-watch → the hindsight channel).
 *
 * `opts.spoken` (EI-10563): when true, the written line is tagged with
 * `VOICE_TURN_PREFIX` so the persona can deterministically `voice:say` an
 * ack/reply instead of relying on inferring modality from plain text. Pass it
 * from every caller whose turn actually originated as speech (the dock voice
 * bridge, the ElevenLabs relay) — never from the deep-answer injection, which
 * already carries its own `[deep-answer WI-NNN]` marker.
 */
export async function writeToSentinelPane(
  text: string,
  opts?: { spoken?: boolean },
): Promise<SentinelPaneWrite> {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'write-failed', error: 'empty text' };

  const liveSessions = await listLiveDockSessions();
  if (liveSessions.length === 0) {
    return { ok: false, reason: 'no-dock', error: 'no live pui-dock session' };
  }

  const reg = readSentinelPaneReg();
  if (!reg || !liveSessions.includes(reg.session)) {
    return {
      ok: false,
      reason: 'no-sentinel-pane',
      error: reg
        ? `sentinel pane registration points at '${reg.session}' but live dock session(s) are ${liveSessions.join(', ')} — the registered pane is gone (dock relaunched?)`
        : 'no sentinel pane registration (~/.papercusp/sentinel-pane) — psu-sentinel has not launched',
    };
  }
  const session = reg.session;
  const paneId = reg.paneId;

  // Boot-window guard (dock-relaunch race): a write that lands in the pane's
  // warm-up window is typed into a not-yet-ready composer and SILENTLY LOST.
  // When the registration is very fresh, wait out the remaining warm-up before
  // writing — delayed a few seconds, not dropped. Bounded; a stat failure
  // skips the gate.
  try {
    const ageMs = Date.now() - statSync(join(homedir(), '.papercusp', 'sentinel-pane')).mtimeMs;
    if (ageMs >= 0 && ageMs < SENTINEL_WARMUP_MS) {
      await new Promise((r) => setTimeout(r, SENTINEL_WARMUP_MS - ageMs));
    }
  } catch {
    /* stat unavailable — proceed without the warm-up gate */
  }

  const z = zellijBin();

  // Exited-pane guard: refuse rather than Enter-trigger a re-run that loses the
  // turn. Best-effort (a dump failure falls through to the write).
  try {
    const { stdout } = await exec(
      z,
      ['-s', session, 'action', 'dump-screen', '--pane-id', paneId],
      { timeout: 4000 },
    );
    if (isExitedPaneScreen(stdout)) {
      return {
        ok: false,
        reason: 'pane-exited',
        error: 'sentinel pane exited (held at re-run prompt); not writing',
        session,
        paneId,
      };
    }
  } catch {
    /* dump unavailable — proceed with the write (best-effort guard) */
  }

  try {
    // EI-10563: tag a voice-origin turn so the pane can key on it deterministically
    // (see VOICE_TURN_PREFIX above) instead of guessing modality from bare text.
    const line = opts?.spoken ? `${VOICE_TURN_PREFIX} ${t}` : t;
    // `--` end-of-options marker: `text` is user-controlled, so without it a
    // value starting with `-` would be parsed as a zellij flag (argv flag
    // smuggling). After `--` everything is positional.
    await exec(z, ['-s', session, 'action', 'write-chars', '--pane-id', paneId, '--', line], { timeout: 4000 });
    await exec(z, ['-s', session, 'action', 'write', '--pane-id', paneId, '13'], { timeout: 4000 });
    return { ok: true, session, paneId, targeted: true };
  } catch (e) {
    return {
      ok: false,
      reason: 'write-failed',
      error: `zellij write failed: ${String(e).slice(0, 200)}`,
      session,
      paneId,
    };
  }
}
