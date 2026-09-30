/**
 * The ONE derivation of a psu launch's BOOT LOG path — WI-37841.
 *
 * WHY THIS EXISTS
 *
 * A HUD "+ New session" launch that dies before psu registers can only ever be
 * reported as "This session's launch failed — its terminal closed before the
 * session came online." That copy is a fixed string because the failure verdict
 * is DERIVED, not stored: `isFailedTerminalLaunch(row)` is just
 * `display='terminal' AND ended_at IS NOT NULL AND session_id IS NULL`
 * (adv-sessions.ts). It knows THAT the launch failed and structurally cannot
 * know WHY — the one artifact naming the cause is whatever psu printed on its
 * way out, and that went to the spawned window's pty and nowhere else.
 *
 * The cost is measured, not theoretical: that single banner has consumed TWO
 * full forensic sessions for TWO DIFFERENT underlying causes (WI-37743's
 * pre-pinned-owner 409, and the 2026-08-10T22:40Z pair of dead rows). Each time,
 * the message that would have answered it in one read had already been printed —
 * to a window nobody could read afterwards.
 *
 * WHY THIS FILE IS PLAIN .mjs
 *
 * Three parties need the SAME path and none of them can be handed it by another:
 *   • `apps/operator/scripts/psu-launcher.mjs` — the WRITER. Bare `node`,
 *     unbundled, cannot import TypeScript.
 *   • `…/endpoint-route/routes/adv/launch-su.ts` — passes it to
 *     `keepWindowOpenOnFailure` as the receipt path, so a failure that happens
 *     BEFORE node even runs (psu not on PATH, a broken login shell) still lands
 *     in the same file the launcher would have written.
 *   • the READER that surfaces the tail on the failed-launch banner.
 *
 * Same shape (and same reasoning) as `su-tier-roles.mjs`: plain ESM here plus a
 * `.d.mts` sibling so TypeScript callers stay typechecked with no build step. A
 * copy on each side would be three path expressions that drift silently, and the
 * failure mode is the quiet one — the writer logging to a path no reader reads,
 * which is indistinguishable from "the launch left no evidence".
 *
 * KEYED BY COORD OWNER ID, deliberately. The id is PRE-PINNED by launch-su
 * before the spawn (`psu --owner-id=…`), so it is the one handle that exists on
 * both sides of a launch that never came online — the adv_sessions row has no
 * session_id and no pid yet, and there is nothing else to key on. It is also
 * unique per launch, so each launch owns its own file and no launch can ever
 * read another's diagnostic.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

/** Directory under `~/.papercusp` holding per-launch boot logs. */
export const PSU_LAUNCH_LOG_DIRNAME = 'psu-launch-logs';

/**
 * Max bytes captured per launch. The FIRST N bytes, not a ring — a boot failure
 * announces itself within a few lines, and taking the head keeps the writer a
 * plain bounded append with no buffering. A healthy session simply saturates the
 * cap with boot chatter and stops writing; its log is never read, because only a
 * FAILED launch is ever surfaced.
 */
export const PSU_LAUNCH_LOG_MAX_BYTES = 64 * 1024;

/** Max chars handed to a UI surface from the tail of a log. */
export const PSU_LAUNCH_LOG_TAIL_CHARS = 1200;

/** Max bytes inspected from a live headless terminal log. Always read as a tail. */
export const HEADLESS_LAUNCH_LOG_SCAN_BYTES = 64 * 1024;

/** Logs older than this are pruned on the next launch (best-effort). */
export const PSU_LAUNCH_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Coord owner ids this module will build a path from.
 *
 * This guard is SECURITY, not tidiness: the value becomes a path segment AND is
 * interpolated into a shell one-liner by launch-su. A rejected id returns `null`
 * everywhere rather than throwing — no launch has ever been worth failing over a
 * diagnostic side-channel, and a null path degrades exactly to today's behaviour
 * (no log, the pre-WI-37841 status quo).
 */
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Exact receipt emitted by console-spawn's headless launcher. */
const HEADLESS_LOG_RECEIPT_RE = /^headless \(log: ([^)\r\n]+)\)$/;

/** The provider dialog observed live in WI-6821, after ANSI/control stripping. */
const CLAUDE_WEEKLY_LIMIT_RE = /you(?:'|’)?ve hit your weekly limit(?:\s*[\u00b7•-]\s*resets\s+([^\r\n]+))?/i;

/** The native Codex JSON error observed on WI-6821 row 15363. */
const CODEX_CHATGPT_MODEL_RE =
  /the\s+['‘’"]([^'‘’"\r\n]+)['‘’"]\s+model is not supported when using codex with a chatgpt account/i;

/**
 * Remove terminal paint instructions while preserving visible text. This is
 * deliberately local rather than an app-layer import: this .mjs is shared by
 * bare-node launchers and operator-core readers.
 */
function stripTerminalControls(value) {
  return value
    // OSC (window title / hyperlinks), terminated by BEL or ST.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // CSI cursor/color/erase sequences, including private `?25l` forms.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // A TUI reuses one row with CR; treating it as a line boundary prevents a
    // reset hint from swallowing the next painted row.
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Extract the one headless-log path shape the launcher persists.
 *
 * `terminal_bin` is stored state, not authority to read an arbitrary file. The
 * parent-pair + basename guards keep a corrupted row from turning the roster
 * read into a general local-file reader. The app creates exactly
 * `<workspace>/.papercusp/fleet-logs/<safe-name>.log`.
 */
function headlessLaunchLogPath(terminalBin) {
  if (typeof terminalBin !== 'string') return null;
  const match = HEADLESS_LOG_RECEIPT_RE.exec(terminalBin.trim());
  if (!match) return null;
  const file = match[1];
  if (!isAbsolute(file) || normalize(file) !== file) return null;
  if (basename(dirname(file)) !== 'fleet-logs') return null;
  if (basename(dirname(dirname(file))) !== '.papercusp') return null;
  if (!/^[A-Za-z0-9._-]{1,240}\.log$/.test(basename(file))) return null;
  return file;
}

/** Read at most `bytes` from the END of a file. Never throws. */
function readFileTailBytes(file, bytes) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, Math.max(1, bytes));
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort display-path diagnostic
      }
    }
  }
}

/**
 * Recognize a PRE-TURN provider block from visible terminal text.
 *
 * Return constructed, owner-facing copy rather than arbitrary log bytes: the
 * log contains terminal control state and may contain unrelated startup data.
 * null means the evidence does not support this diagnosis.
 */
export function detectPsuHeadlessLaunchBlockHint(logText) {
  if (typeof logText !== 'string' || logText.length === 0) return null;
  const visible = stripTerminalControls(logText);
  const weeklyLimit = CLAUDE_WEEKLY_LIMIT_RE.exec(visible);
  if (weeklyLimit) {
    const reset = weeklyLimit[1]?.trim().replace(/\s+/g, ' ') ?? '';
    return (
      `Claude's weekly usage limit was reached${reset ? `; it resets ${reset}` : ''}. ` +
      'Launch with Codex or an available account, or retry after the reset.'
    );
  }

  const unsupportedCodexModel = CODEX_CHATGPT_MODEL_RE.exec(visible);
  if (unsupportedCodexModel) {
    const model = unsupportedCodexModel[1].trim().replace(/\s+/g, ' ');
    return (
      `Codex rejected model \`${model}\` for this ChatGPT account. ` +
      'Retry with a supported full Codex model id or choose another model.'
    );
  }

  return null;
}

/**
 * Read the bounded headless-terminal tail named by `terminal_bin` and return an
 * actionable PRE-TURN block hint, or null when the row/log proves no such state.
 */
export function readPsuHeadlessLaunchBlockHint(
  terminalBin,
  { scanBytes = HEADLESS_LAUNCH_LOG_SCAN_BYTES } = {},
) {
  const file = headlessLaunchLogPath(terminalBin);
  if (!file) return null;
  const tail = readFileTailBytes(file, scanBytes);
  return tail == null ? null : detectPsuHeadlessLaunchBlockHint(tail);
}

/** The per-workspace-home directory holding launch boot logs. */
export function psuLaunchLogRoot(home = homedir()) {
  return join(home, '.papercusp', PSU_LAUNCH_LOG_DIRNAME);
}

/**
 * The boot-log path for `ownerId`, or `null` when the id is absent or not a
 * plain identifier (see OWNER_ID_RE). Pure — creates nothing.
 */
export function psuLaunchLogPath(ownerId, { home = homedir() } = {}) {
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) return null;
  return join(psuLaunchLogRoot(home), `${ownerId}.log`);
}

/**
 * Delete boot logs older than {@link PSU_LAUNCH_LOG_TTL_MS}. Best-effort and
 * bounded: owner ids are unique per launch, so this directory would otherwise
 * accrete one small file per launch forever. Never throws — pruning is
 * housekeeping, and a launch must not fail because a stale log resisted
 * deletion.
 */
export function prunePsuLaunchLogs({ home = homedir(), now = Date.now(), ttlMs = PSU_LAUNCH_LOG_TTL_MS, max = 500 } = {}) {
  const dir = psuLaunchLogRoot(home);
  let removed = 0;
  try {
    if (!existsSync(dir)) return 0;
    for (const name of readdirSync(dir).slice(0, max)) {
      if (!name.endsWith('.log')) continue;
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > ttlMs) {
          rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        // one unreadable entry must not abort the sweep
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

/**
 * Read the tail of a launch's boot log, or `null` when there is none.
 *
 * `null` and `''` mean DIFFERENT things and callers must keep them apart: null =
 * no log exists (an old launch, a pre-WI-37841 binary, a rejected owner id), so
 * say nothing; empty = the launch ran and printed nothing, which is itself a
 * finding. Neither is ever an error — this is read on a display path.
 */
export function readPsuLaunchLogTail(ownerId, { home = homedir(), chars = PSU_LAUNCH_LOG_TAIL_CHARS } = {}) {
  const file = psuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim().slice(-chars);
  } catch {
    return null;
  }
}

/**
 * Ensure the log directory exists and return the path to write, or null.
 * Separated from {@link psuLaunchLogPath} so the pure path derivation stays
 * side-effect-free for the READERS, which must never create a directory just by
 * asking a question.
 */
export function ensurePsuLaunchLogPath(ownerId, { home = homedir() } = {}) {
  const file = psuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  try {
    mkdirSync(psuLaunchLogRoot(home), { recursive: true });
    return file;
  } catch {
    return null;
  }
}
