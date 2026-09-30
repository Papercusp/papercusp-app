/**
 * Types for the shared psu launch boot-log path (WI-37841).
 *
 * psu-launch-log.mjs must stay plain ESM so psu-launcher.mjs (bare `node`,
 * unbundled) writes to the same path the TypeScript reader reads from. This
 * declaration keeps the TypeScript callers type-checked without forcing a build
 * step on the launcher. Same shape as `su-tier-roles.d.mts`.
 */

/** Directory under `~/.papercusp` holding per-launch boot logs. */
export const PSU_LAUNCH_LOG_DIRNAME: string;

/** Max bytes captured per launch (the FIRST N — see the .mjs docblock). */
export const PSU_LAUNCH_LOG_MAX_BYTES: number;

/** Max chars handed to a UI surface from the tail of a log. */
export const PSU_LAUNCH_LOG_TAIL_CHARS: number;

/** Max bytes inspected from the tail of a live headless terminal log. */
export const HEADLESS_LAUNCH_LOG_SCAN_BYTES: number;

/** Logs older than this are pruned on the next launch. */
export const PSU_LAUNCH_LOG_TTL_MS: number;

/** The per-home directory holding launch boot logs. */
export function psuLaunchLogRoot(home?: string): string;

/** The boot-log path for `ownerId`, or null when absent/not a plain id. Pure. */
export function psuLaunchLogPath(
  ownerId: string | null | undefined,
  opts?: { home?: string },
): string | null;

/** Delete boot logs older than the TTL. Best-effort; returns how many went. */
export function prunePsuLaunchLogs(opts?: {
  home?: string;
  now?: number;
  ttlMs?: number;
  max?: number;
}): number;

/**
 * The tail of a launch's boot log, or null when there is none.
 * null = no log (say nothing); '' = the launch printed nothing (a finding).
 */
export function readPsuLaunchLogTail(
  ownerId: string | null | undefined,
  opts?: { home?: string; chars?: number },
): string | null;

/** Recognize the pre-turn Claude weekly-limit dialog in terminal output. */
export function detectPsuHeadlessLaunchBlockHint(logText: string | null | undefined): string | null;

/** Read a bounded headless log tail named by terminal_bin and recognize a block. */
export function readPsuHeadlessLaunchBlockHint(
  terminalBin: string | null | undefined,
  opts?: { scanBytes?: number },
): string | null;

/** {@link psuLaunchLogPath}, but creates the directory. Null when unusable. */
export function ensurePsuLaunchLogPath(
  ownerId: string | null | undefined,
  opts?: { home?: string },
): string | null;
