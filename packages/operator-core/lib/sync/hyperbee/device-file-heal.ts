/**
 * Repair a corestore `CORESTORE` device file that was invalidated by RELOCATING
 * the store directory rather than by any real corruption.
 *
 * corestore 7.x guards every writable open with the upstream `device-file`
 * package, which records the device file's own inode + creation time inside the
 * file and re-checks them on open (`node_modules/device-file/index.js`):
 *
 *   if (st.ino !== inode || (created && Math.abs(modified - created) >= 5000))
 *     throwDeviceFileError('Invalid device file, was modified', true)
 *
 * A directory copied with its metadata intact — macOS Migration Assistant,
 * `ditto`, `cp -p`, `rsync -X` — keeps the `device-file` xattr and even the
 * birthtime, but every inode necessarily changes. The store is then PERMANENTLY
 * unopenable: the guard fails identically on every subsequent boot, with an
 * opaque message and no repair path. Measured on the macOS rig 2026-08-16
 * (EI-20584279536840151): 9 of 10 stores were in this state, which silently cost
 * the pot-git substrate every peer connection it should have had — the harness
 * never booted, so it never joined its topic, so both ends' pot-git dial
 * registries stayed empty and reported `no-path` against a perfectly reachable
 * peer.
 *
 * Healing is deliberately narrow. We rewrite ONLY when the recorded inode
 * disagrees with the real one, and we rewrite IN PLACE (`O_RDWR` + `ftruncate`)
 * so the inode we are about to record stays the inode the file actually has and
 * the `device-file` xattr survives untouched. `device/created` is re-stamped in
 * the same write because the write itself moves mtime to now, which would
 * otherwise trip the second half of the guard.
 *
 * What this does NOT do, on purpose:
 *  - it never creates a device file that was absent (that is corestore's job);
 *  - it never touches `device/platform`, so a store genuinely copied between
 *    platforms still fails with "was made on different platform";
 *  - it never restores a missing `device-file` xattr, so a store moved WITHOUT
 *    its metadata still fails with "was moved unsafely" — a different fault that
 *    deserves its own distinct error rather than being papered over here.
 */

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The device-file corestore writes at the root of a store directory. */
export const DEVICE_FILE_NAME = 'CORESTORE';

export type DeviceFileHealOutcome =
  /** No device file at `<storeDir>/CORESTORE` — a fresh store; nothing to heal. */
  | { action: 'absent' }
  /** The recorded inode already matches; the guard would have passed. */
  | { action: 'ok'; inode: number }
  /** Left alone on purpose — `reason` names the guard we must not mask. */
  | { action: 'skipped'; reason: string }
  /** Rewritten in place; the guard will now pass. */
  | { action: 'healed'; fromInode: number; toInode: number }
  /** Unreadable/unwritable. Never throws — the caller proceeds and lets the real open report. */
  | { action: 'failed'; error: string };

function parseDeviceFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i === -1) continue;
    out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return out;
}

function render(fields: Map<string, string>, order: readonly string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of order) {
    const v = fields.get(k);
    if (v !== undefined) {
      lines.push(`${k}=${v}`);
      seen.add(k);
    }
  }
  for (const [k, v] of fields) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Heal `<storeDir>/CORESTORE` if — and only if — it was invalidated by a
 * relocation. Safe to call unconditionally before every writable store open;
 * it is a no-op for a healthy or absent device file and NEVER throws.
 */
export async function healRelocatedDeviceFile(storeDir: string): Promise<DeviceFileHealOutcome> {
  const path = join(storeDir, DEVICE_FILE_NAME);

  let handle;
  try {
    handle = await open(path, 'r+');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { action: 'absent' };
    return { action: 'failed', error: `${code ?? ''} ${String(error)}`.trim() };
  }

  try {
    const text = await handle.readFile('utf8');
    const fields = parseDeviceFile(text);

    const recorded = Number(fields.get('device/inode'));
    if (!Number.isFinite(recorded)) {
      return { action: 'skipped', reason: 'no parsable device/inode' };
    }

    // Stat THROUGH THE OPEN HANDLE: the inode we record must be the inode of the
    // very file we are about to write, even if the path is re-pointed under us.
    const st = await handle.stat();
    const actual = Number(st.ino);
    if (recorded === actual) return { action: 'ok', inode: actual };

    // A cross-platform copy is a genuinely different fault; leave it to fail loudly.
    const platform = fields.get('device/platform');
    if (platform && platform !== process.platform) {
      return { action: 'skipped', reason: `device/platform=${platform} !== ${process.platform}` };
    }

    fields.set('device/inode', String(actual));
    // The write below sets mtime to now, and the guard also compares
    // |max(mtime, birthtime) - created| against a 5s slack — so `created` has to
    // move with it or we would trade one guard failure for the other.
    fields.set('device/created', String(Date.now()));

    const next = Buffer.from(
      render(fields, ['device/platform', 'device/inode', 'device/created', 'device/attribute']),
      'utf8',
    );
    // In place, so the inode (and the xattr the guard also checks) is preserved.
    await handle.write(next, 0, next.length, 0);
    await handle.truncate(next.length);
    await handle.sync();

    return { action: 'healed', fromInode: recorded, toInode: actual };
  } catch (error) {
    return { action: 'failed', error: String(error) };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * {@link healRelocatedDeviceFile} plus the one-line operator log. Split out so
 * the heal itself stays silent and testable.
 */
export async function healRelocatedDeviceFileAndLog(
  storeDir: string,
  label: string,
): Promise<DeviceFileHealOutcome> {
  const outcome = await healRelocatedDeviceFile(storeDir);
  if (outcome.action === 'healed') {
    console.warn(
      `[device-file] ${label}: HEALED a relocated corestore device file at ${storeDir} ` +
        `(recorded inode ${outcome.fromInode} → actual ${outcome.toInode}). The store directory was ` +
        `moved or restored with its metadata intact; without this the open fails permanently with ` +
        `"Invalid device file, was modified" and the harness never boots.`,
    );
  } else if (outcome.action === 'failed') {
    console.warn(
      `[device-file] ${label}: could not inspect the device file at ${storeDir} (${outcome.error}). ` +
        `Proceeding to open anyway — the store open reports the authoritative error.`,
    );
  } else if (outcome.action === 'skipped') {
    console.warn(
      `[device-file] ${label}: device file at ${storeDir} is invalid but NOT the relocation case ` +
        `(${outcome.reason}); left untouched so the real guard error stands.`,
    );
  }
  return outcome;
}
