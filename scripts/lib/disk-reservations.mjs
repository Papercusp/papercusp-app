/**
 * Reader for the build disk-reservation ledger (EI-21951384112327922).
 *
 * The ledger is WRITTEN by papercusp-desktop/bin/lib/disk-preflight.sh, which every
 * multi-GB shell build entry point calls. This module is the Node-side READER, so
 * that the Cargo admission gate in cargo-result.mjs stops admitting into space a
 * sidecar/Windows-cross build has already been promised.
 *
 * WHY READ-ONLY HERE: a reservation is a DECLARED demand ("I am about to consume
 * N GB"). The shell callers declare one (8GB staging, 12GB cross-compile); the
 * Cargo gate has no declared demand — it enforces floors, not a size — so it has
 * nothing honest to reserve. Inventing a number would be a guess dressed as a
 * measurement. Respecting other builds' declarations needs no such guess, and is
 * the half that removes the over-commit.
 *
 * FAIL-OPEN, ALWAYS: every failure to locate, read, or parse the ledger returns 0
 * outstanding bytes, matching disk-preflight.sh's rule that a guard which cannot
 * measure must never become a new way for builds to die.
 *
 * ⚠ THE ON-DISK FORMAT AND THE MOUNT KEY ARE SHARED WITH THAT SHELL FILE. If the
 * two derivations ever diverge, the ledger silently SPLITS in two and each side
 * reads an empty ledger — the failure is invisible, and looks exactly like "no
 * other builds are running". disk-reservations.test.ts pins the two against each
 * other by executing both, so drift fails a test instead of disabling the guard.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const GIB = 1024 * 1024 * 1024;

/** Ledger root. Mirrors PAPERCUSP_DISK_RESERVATION_DIR in disk-preflight.sh. */
export function reservationDir(env = process.env) {
  return env.PAPERCUSP_DISK_RESERVATION_DIR || join(env.TMPDIR || '/tmp', 'papercusp-disk-reservations');
}

/**
 * Sanitized mount point for `path` — the per-filesystem ledger key, so a claim on
 * /tmp never shrinks the budget for /. Uses the same `df -Pk` field and the same
 * [^A-Za-z0-9] -> '_' substitution as papercusp_mount_key.
 * Returns '' when it cannot be determined (caller then fails open).
 */
export function mountKeyForPath(path) {
  try {
    const out = execFileSync('df', ['-Pk', path], { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n')[1];
    if (!line) return '';
    // -P guarantees one line per fs, so the mount point is everything from field 6.
    const fields = line.trim().split(/\s+/);
    const mount = fields.slice(5).join(' ');
    if (!mount) return '';
    return mount.replace(/[^A-Za-z0-9]/g, '_');
  } catch {
    return '';
  }
}

/** A pid is live only if it exists AND is the same process that made the claim. */
function ownerStillLive(pid, recordedStart) {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // gone (ESRCH), or not ours to signal (EPERM) — treat as dead
  }
  if (!recordedStart) return true; // no start time recorded (darwin): TTL is the backstop
  let currentStart = '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens: split after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(') ') + 2);
    currentStart = rest.split(/\s+/)[19] || '';
  } catch {
    return true; // unreadable /proc — fall back to the TTL rather than over-reaping
  }
  if (!currentStart) return true;
  return currentStart === recordedStart; // differs => pid was recycled
}

function parseRecord(text) {
  const rec = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return rec;
}

/**
 * Total GB other LIVE builds have reserved on the filesystem containing `path`.
 * Read-only: unlike the shell writer this never reaps, so a concurrent build's
 * ledger is never mutated by a mere reader.
 */
export function readReservedGb(path, { env = process.env, now = Date.now() } = {}) {
  const key = mountKeyForPath(path);
  if (!key) return 0;
  let entries;
  try {
    entries = readdirSync(join(reservationDir(env), key));
  } catch {
    return 0; // no ledger yet == nothing reserved
  }
  let total = 0;
  const nowSec = Math.floor(now / 1000);
  for (const name of entries) {
    if (!name.endsWith('.res')) continue;
    let rec;
    try {
      rec = parseRecord(readFileSync(join(reservationDir(env), key, name), 'utf8'));
    } catch {
      continue;
    }
    const pid = Number(rec.pid);
    const gb = Number(rec.gb);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(gb) || gb < 0) continue;
    const expires = Number(rec.expires);
    if (Number.isFinite(expires) && nowSec > expires) continue;
    if (!ownerStillLive(pid, rec.start)) continue;
    total += gb;
  }
  return total;
}

/** Same, in bytes — the unit assessCargoDiskAdmission takes. */
export function readReservedBytes(path, opts) {
  return readReservedGb(path, opts) * GIB;
}
