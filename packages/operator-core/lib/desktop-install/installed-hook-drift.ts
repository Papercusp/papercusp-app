/**
 * Detect divergence between the INSTALLED agent hooks (`~/.papercusp/hooks/cc`)
 * and their CANONICAL source under the integration root (WI-10002031).
 *
 * ## The gap this closes
 *
 * `install-source-guard.ts` and `resolveSourceDir()` stop the installer PICKING
 * the wrong source. Nothing detected that an installed hook had diverged from
 * its canonical source AFTER the fact — so the class recurred twice with an
 * identical signature, and both times the only thing that surfaced it was an
 * agent hand-md5ing two files while debugging something else:
 *
 * - 2026-08-03 (WI-7344 / EI-19412167276099357): `ask-gate-mirror.sh` installed
 *   byte-identical to a release copy EIGHT DAYS stale, re-installed FROM RELEASE
 *   hours after the fix landed in staging. Two of three fixes inert on arrival.
 * - 2026-09-20 (EI-23749662191699491): same file, same shape — installed md5
 *   48c32a50 (0 lines matching `tools_invoke`) vs staging 43bc5aa1 (1 line).
 *
 * Between those dates the WI-7344 guard shipped, was believed to close the
 * class, and was silently INERT for ~6 weeks because it read an env var nothing
 * sets. That is the real lesson here: the failure mode of a drift guard is to go
 * quiet, and a quiet guard is indistinguishable from a clean machine. Hence the
 * fail-closed contract below.
 *
 * This is not cosmetic. `ask-gate-mirror.sh` arms the turn-end Stop gate for
 * EVERY live agent on the box, so a stale copy livelocks agents at turn end
 * fleet-wide.
 *
 * ## Why this module is PURE and takes its directories as arguments
 *
 * The obvious implementation compares the real `~/.papercusp/hooks/cc` against
 * the real integration root, and is then tested against whatever that machine
 * happens to hold. That test measures the RUNNER, not the contract — it goes red
 * for reasons unrelated to the code (measured on this repo the same day, in
 * WI-10002057, where three tests read an ambient env var and so failed for every
 * psu-launched agent while passing in CI).
 *
 * It is also actively wrong for THIS subject right now: the installed copy is
 * LEGITIMATELY divergent until the EI-23749662191699491 fix reaches `:3070` and
 * that operator restarts. A detector calibrated against live state during that
 * window would be calibrated against a transient.
 *
 * So: the comparison is a pure function over two directories, unit-tested with
 * fixtures, and a caller (the watchdog seam) supplies the real paths.
 *
 * ## Fail-closed, deliberately
 *
 * An unreadable canonical dir returns `refused`, never an empty `drifted` list.
 * A detector that cannot see its source has not proven the machine clean — it
 * has failed to measure — and those two outcomes must not render identically.
 * Same contract, and the same reasoning, as `runLaunchContextGc`'s
 * `refused: 'no-live-render-evidence'`: report the refusal BEFORE reading
 * anything, so it can never be mistaken for "nothing was found".
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Why a single hook is reported. */
export type HookDriftStatus =
  /** Present in both, but the bytes differ — the recurring failure. */
  | 'divergent'
  /** Canonical ships it, the install does not have it — a rail that is not armed. */
  | 'missing-from-install'
  /** Installed but no longer canonical — a retired hook still firing. */
  | 'orphaned-in-install'
  /** Present in both but at least one side could not be read. */
  | 'unreadable';

export interface HookDrift {
  /** Hook basename, e.g. `ask-gate-mirror.sh`. */
  name: string;
  status: HookDriftStatus;
  /** sha256 of the canonical bytes, or null when absent/unreadable. */
  canonicalSha256: string | null;
  /** sha256 of the installed bytes, or null when absent/unreadable. */
  installedSha256: string | null;
  /** Populated only for `unreadable`, so a read failure is never a silent equal. */
  detail?: string;
}

export type HookDriftRefusal =
  | 'canonical-dir-unreadable'
  | 'installed-dir-unreadable';

export interface HookDriftReport {
  canonicalDir: string;
  installedDir: string;
  /** Hook basenames actually compared. Empty with `refused` set means NOTHING was measured. */
  checked: string[];
  /** Every divergence found. Empty AND `refused` unset is the only clean verdict. */
  drifted: HookDrift[];
  /**
   * True only when a real comparison ran and found nothing. Never true under a
   * refusal — that is the whole point of the fail-closed contract.
   */
  clean: boolean;
  /** Set when the check could not run. `clean` is false and `checked` is empty. */
  refused?: HookDriftRefusal;
}

export interface DetectInstalledHookDriftOptions {
  /** The canonical source dir, e.g. `<integrationRoot>/apps/operator/scripts/hooks/cc`. */
  canonicalDir: string;
  /** The installed dir, e.g. `~/.papercusp/hooks/cc`. */
  installedDir: string;
  /**
   * Test seam for the directory listing. Defaults to a real `readdirSync`
   * restricted to FILES (a subdirectory is never descended into and never
   * compared, matching runLaunchContextGc's direct-children-only rule).
   */
  listFilesFn?: (dir: string) => string[];
  /** Test seam for reading a file's bytes. Defaults to a real `readFileSync`. */
  readFileFn?: (filePath: string) => Buffer;
}

function defaultListFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compare every hook in `canonicalDir` against `installedDir`.
 *
 * Returns a structured report rather than throwing: the caller (a watchdog)
 * decides how loudly to surface it, and a thrown error inside a sweep is far
 * easier to swallow than a report with `clean: false`.
 */
export function detectInstalledHookDrift(
  opts: DetectInstalledHookDriftOptions,
): HookDriftReport {
  const { canonicalDir, installedDir } = opts;
  const listFiles = opts.listFilesFn ?? defaultListFiles;
  const readFile = opts.readFileFn ?? ((p: string) => readFileSync(p));

  const base = { canonicalDir, installedDir };

  // Fail-closed, and in this order: without the canonical set there is no
  // population to compare against, so an empty `drifted` here would assert the
  // machine is clean on the strength of having measured nothing.
  let canonicalNames: string[];
  try {
    canonicalNames = listFiles(canonicalDir);
  } catch {
    return { ...base, checked: [], drifted: [], clean: false, refused: 'canonical-dir-unreadable' };
  }

  let installedNames: string[];
  try {
    installedNames = listFiles(installedDir);
  } catch {
    return { ...base, checked: [], drifted: [], clean: false, refused: 'installed-dir-unreadable' };
  }

  const installedSet = new Set(installedNames);
  const drifted: HookDrift[] = [];
  const checked: string[] = [];

  for (const name of [...canonicalNames].sort()) {
    checked.push(name);

    let canonicalBytes: Buffer;
    try {
      canonicalBytes = readFile(path.join(canonicalDir, name));
    } catch (err) {
      drifted.push({
        name,
        status: 'unreadable',
        canonicalSha256: null,
        installedSha256: null,
        detail: `canonical unreadable: ${(err as Error)?.message ?? 'unknown'}`,
      });
      continue;
    }

    if (!installedSet.has(name)) {
      drifted.push({
        name,
        status: 'missing-from-install',
        canonicalSha256: sha256(canonicalBytes),
        installedSha256: null,
      });
      continue;
    }

    let installedBytes: Buffer;
    try {
      installedBytes = readFile(path.join(installedDir, name));
    } catch (err) {
      drifted.push({
        name,
        status: 'unreadable',
        canonicalSha256: sha256(canonicalBytes),
        installedSha256: null,
        detail: `installed unreadable: ${(err as Error)?.message ?? 'unknown'}`,
      });
      continue;
    }

    const canonicalHash = sha256(canonicalBytes);
    const installedHash = sha256(installedBytes);
    if (canonicalHash !== installedHash) {
      drifted.push({
        name,
        status: 'divergent',
        canonicalSha256: canonicalHash,
        installedSha256: installedHash,
      });
    }
  }

  // An installed hook with no canonical counterpart still FIRES on this box, so
  // it is reported rather than ignored — a retired rail left armed is the same
  // class of surprise as a stale one, just pointing the other way.
  const canonicalSet = new Set(canonicalNames);
  for (const name of [...installedNames].sort()) {
    if (canonicalSet.has(name)) continue;
    let installedHash: string | null = null;
    try {
      installedHash = sha256(readFile(path.join(installedDir, name)));
    } catch {
      installedHash = null;
    }
    drifted.push({
      name,
      status: 'orphaned-in-install',
      canonicalSha256: null,
      installedSha256: installedHash,
    });
  }

  return { ...base, checked, drifted, clean: drifted.length === 0 };
}

/**
 * One-line human summary for a watchdog/log line. Deliberately names the
 * refusal explicitly rather than printing "0 drifted", which is the reading a
 * failed measurement must never be allowed to produce.
 */
export function formatHookDriftSummary(report: HookDriftReport): string {
  if (report.refused) {
    return (
      `hook-drift NOT MEASURED (${report.refused}) — canonical=${report.canonicalDir} ` +
      `installed=${report.installedDir}. This is a failed measurement, not a clean machine.`
    );
  }
  if (report.clean) {
    return `hook-drift clean — ${report.checked.length} hook(s) match ${report.canonicalDir}`;
  }
  const detail = report.drifted
    .map((d) => `${d.name}:${d.status}`)
    .join(', ');
  return (
    `hook-drift DIVERGENT — ${report.drifted.length} of ${report.checked.length} checked ` +
    `differ from ${report.canonicalDir}: ${detail}`
  );
}
