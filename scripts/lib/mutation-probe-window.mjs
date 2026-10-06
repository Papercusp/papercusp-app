// EI-18750303030034478 — name an ACTIVE in-tree mutation-probe window on a failing raw test run.
//
// `scripts/mutation-probe.sh --in-tree` deliberately breaks a tracked file for the length of a
// guard run. A peer's `npm run test:file` / `npm run test:affected` in the same checkout can read
// that mutant and report a red with zero connection to the peer's own change (measured twice: a
// ledger row on 2026-07-26 and a peer's two-markdown-file `test:affected` on 2026-08-10). The
// ledger half is already fixed (`PAPERCUSP_MUTATION_PROBE=1` stamps `source='mutation-probe'`) and
// `testing:run` refuses fenced tests (`mutation-probe-fence.ts`), but the raw CLI routes cannot
// query the file-lock store — so they read the probe's OWN filesystem marker instead.
//
// THE MARKER. The probe publishes `<admission dir>/original.manifest` — four NUL-terminated
// fields `<checkout root> <subject> <snapshot> <owner pid>` — BEFORE it mutates anything and
// removes it only AFTER the verified restore, so the file exists exactly while a mutant may be in
// the tree. The directory defaults to `/tmp/papercusp-mutation-probe-<uid>-<sha256(realpath root)>`;
// tests can set `PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT` to isolate it. The shell writer, overlay
// reader, and this reader share that base, pinned by `packages/operator-core/lib/mutation-probe-window.test.ts`.
//
// This is a DIAGNOSTIC, never a gate: it can only add one line to a failing run's output. It
// cannot mask or excuse a red, and a missing/unreadable marker reads as "no window", never as an
// error — the instrument must not be able to fail a run.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The admission directory `mutation-probe.sh` uses for one physical checkout.
 *
 * @param {string} checkoutRoot git toplevel of the checkout (symlinks are resolved, as the script does)
 * @param {{ uid?: number, tmpDir?: string }} [options] tmpDir defaults to PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT or /tmp, matching the shell writer
 * @returns {string}
 */
export function mutationProbeAdmissionDir(checkoutRoot, {
  uid,
  tmpDir = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT || '/tmp',
} = {}) {
  const resolvedUid = uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const key = createHash('sha256').update(realpathSync(checkoutRoot)).digest('hex');
  return join(tmpDir, `papercusp-mutation-probe-${resolvedUid}-${key}`);
}

/**
 * @param {number} pid
 * @returns {boolean} true when the process exists (EPERM still means it exists)
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Read the live mutation-probe window for a checkout, if any.
 *
 * `state` is `active` (owner alive — the subject is mutated right now), `orphaned` (owner died
 * mid-window — the mutant may STILL be in the file until the next probe recovers it) or
 * `unreadable` (a marker exists but is not the four-field shape; the subject is unknown).
 * Returns `null` for "no marker", and for any failure to look — never throws.
 *
 * @param {string} checkoutRoot
 * @param {{ uid?: number, tmpDir?: string, now?: () => number }} [options]
 * @returns {{ state: 'active' | 'orphaned' | 'unreadable', subject: string | null, ownerPid: number | null, ageSec: number | null, manifestPath: string } | null}
 */
export function readMutationProbeWindow(checkoutRoot, options = {}) {
  let manifestPath;
  try {
    manifestPath = join(mutationProbeAdmissionDir(checkoutRoot, options), 'original.manifest');
  } catch {
    return null;
  }
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(manifestPath, 'latin1');
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    return null;
  }
  const now = (options.now ?? Date.now)();
  const ageSec = Math.max(0, Math.round((now - mtimeMs) / 1000));
  // The writer terminates EVERY field with NUL, so a well-formed file splits into 4 fields + ''.
  const fields = raw.split('\0');
  const trailing = fields.pop();
  const subject = fields[1];
  const ownerPid = Number(fields[3]);
  if (trailing !== '' || fields.length !== 4 || !subject || !Number.isInteger(ownerPid) || ownerPid < 1) {
    return { state: 'unreadable', subject: null, snapshot: null, ownerPid: null, ageSec, manifestPath };
  }
  const snapshot = fields[2] || null;
  return { state: pidAlive(ownerPid) ? 'active' : 'orphaned', subject, snapshot, ownerPid, ageSec, manifestPath };
}

// ─── WI-10005321: the BUILD gate ────────────────────────────────────────────────────────────
//
// Everything above is a diagnostic that may only add a line to a failing run. A BUILD is
// different: a bundler that reads the shared tree while a probe holds a file mutated ships the
// mutant in a running service, and the probe's verified restore cannot reach it. Measured
// 2026-10-02: bg-host bundled at 05:41:55Z inside a probe window (05:40:20-05:42:01Z) on
// identity-grants-port.ts, so the tool-ceiling denial ran DISABLED until a rebuild ~8 min later.
// The functions below are the gate `apps/operator/bin/bundle-host.sh` runs around esbuild.

/**
 * Every checkout root a build of `root` reads: `root` plus each checked-out submodule,
 * recursively, from `.gitmodules` (pure fs, no git spawn). A probe keys its admission directory
 * by the toplevel of the file it mutates, so a submodule file's window never appears under the
 * superproject's key; reading only `root` would miss it.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function checkoutRootsUnder(root) {
  /** @type {string[]} */
  const roots = [];
  /** @param {string} dir @param {number} depth */
  const visit = (dir, depth) => {
    roots.push(dir);
    if (depth >= 8) return;
    let text;
    try {
      text = readFileSync(join(dir, '.gitmodules'), 'utf8');
    } catch {
      return;
    }
    for (const match of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
      const child = join(dir, match[1]);
      try {
        if (statSync(child).isDirectory()) visit(child, depth + 1);
      } catch {
        // not checked out: nothing there to bundle
      }
    }
  };
  visit(root, 0);
  return roots;
}

/** @param {string | null} a @param {string | null} b */
function sameBytes(a, b) {
  if (!a || !b) return false;
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * May a build read `root` right now? `clear` is false while any window under it may hold a
 * mutant: an ACTIVE one (worth waiting for, so `waitable`), an ORPHANED one whose subject still
 * differs from its snapshot, or an UNREADABLE marker (subject unknown). An orphaned marker whose
 * subject already equals its snapshot is not a mutant, so it is a note, not a block.
 *
 * @param {string} root
 * @param {{ uid?: number, tmpDir?: string, now?: () => number }} [options]
 */
export function buildWindowVerdict(root, options = {}) {
  /** @type {Array<NonNullable<ReturnType<typeof readMutationProbeWindow>> & { checkout: string }>} */
  const blocking = [];
  /** @type {string[]} */
  const notes = [];
  for (const checkout of checkoutRootsUnder(root)) {
    const window = readMutationProbeWindow(checkout, options);
    if (!window) continue;
    if (window.state === 'orphaned' && sameBytes(window.subject, window.snapshot)) {
      notes.push(`orphaned mutation-probe marker for ${window.subject}, but it already equals its snapshot (not mutated)`);
      continue;
    }
    blocking.push({ checkout, ...window });
  }
  return {
    clear: blocking.length === 0,
    waitable: blocking.length > 0 && blocking.every((w) => w.state === 'active'),
    blocking,
    notes,
  };
}

/**
 * The admission-directory mtimes under `root`. A probe creates and removes `original.manifest`
 * inside that directory, so a window that opened at all (even one that closed again) between two
 * stamps moves an mtime. `null` = no directory yet.
 *
 * @param {string} root
 * @param {{ uid?: number, tmpDir?: string }} [options]
 * @returns {Record<string, number | null>}
 */
export function buildWindowStamp(root, options = {}) {
  /** @type {Record<string, number | null>} */
  const stamp = {};
  for (const checkout of checkoutRootsUnder(root)) {
    try {
      stamp[checkout] = statSync(mutationProbeAdmissionDir(checkout, options)).mtimeMs;
    } catch {
      stamp[checkout] = null;
    }
  }
  return stamp;
}

/** The interactive default: a peer's in-tree probe window is capped at 600 s, so 90 s is a guess. */
export const BUILD_WINDOW_DEFAULT_WAIT_SEC = 90;

/**
 * How long a build waits for a mutation-probe window to close (WI-10006268). The specific
 * PAPERCUSP_BUNDLE_PROBE_WAIT_SEC wins; otherwise PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC
 * (EI-24961470606265468), the one knob an unattended build (a systemd-run capacity build, a
 * scheduled gate) sets so EVERY lock/window wait queues behind a peer instead of dying at an
 * interactive-sized default; otherwise 90 s. Same precedence and umbrella semantics as
 * scripts/lib/fs-mutex.mjs: an umbrella that is unset, non-numeric or <= 0 is ignored. A specific
 * knob that is set but not a non-negative number throws, as a bad `--timeout-sec` does.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ sec: number, source: 'PAPERCUSP_BUNDLE_PROBE_WAIT_SEC' | 'PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC' | 'default' }}
 */
export function resolveBuildWindowWaitSec(env = process.env) {
  const specific = env.PAPERCUSP_BUNDLE_PROBE_WAIT_SEC;
  if (specific !== undefined && specific !== '') {
    const sec = Number(specific);
    if (!Number.isFinite(sec) || sec < 0) {
      throw new Error(`PAPERCUSP_BUNDLE_PROBE_WAIT_SEC must be a non-negative number of seconds, got "${specific}"`);
    }
    return { sec, source: 'PAPERCUSP_BUNDLE_PROBE_WAIT_SEC' };
  }
  const unattended = Number(env.PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC);
  if (env.PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC && Number.isFinite(unattended) && unattended > 0) {
    return { sec: unattended, source: 'PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC' };
  }
  return { sec: BUILD_WINDOW_DEFAULT_WAIT_SEC, source: 'default' };
}

/**
 * Wait (bounded) until a build may read `root`. Only an all-ACTIVE block is waited on: an orphan
 * or an unreadable marker will not clear by itself. The stamp is taken BEFORE the verdict, so a
 * window opening after a clear verdict still moves it for `verifyBuildWindowUnchanged`.
 *
 * @param {string} root
 * @param {{ uid?: number, tmpDir?: string, timeoutMs?: number, pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} [options]
 */
export async function waitForBuildWindowClear(root, options = {}) {
  const { timeoutMs = BUILD_WINDOW_DEFAULT_WAIT_SEC * 1000, pollMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const now = options.now ?? Date.now;
  const started = now();
  for (let polls = 0; ; polls += 1) {
    const stamp = buildWindowStamp(root, options);
    const verdict = buildWindowVerdict(root, options);
    const waitedMs = now() - started;
    if (verdict.clear) return { ok: true, verdict, stamp, waitedMs, polls };
    if (!verdict.waitable || waitedMs >= timeoutMs) return { ok: false, verdict, stamp, waitedMs, polls };
    await sleep(pollMs);
  }
}

/**
 * After the build: was the tree probe-free for the whole build? Fails when a window is open now,
 * or when an admission directory moved since `stamp` (a window opened, and perhaps closed,
 * while the bundler was reading files).
 *
 * @param {string} root
 * @param {Record<string, number | null>} stamp from `waitForBuildWindowClear`
 * @param {{ uid?: number, tmpDir?: string }} [options]
 */
export function verifyBuildWindowUnchanged(root, stamp, options = {}) {
  const verdict = buildWindowVerdict(root, options);
  if (!verdict.clear) return { ok: false, reason: 'window-open', verdict, moved: [] };
  const after = buildWindowStamp(root, options);
  const moved = [...new Set([...Object.keys(stamp), ...Object.keys(after)])].filter(
    (checkout) => (stamp[checkout] ?? null) !== (after[checkout] ?? null),
  );
  if (moved.length) return { ok: false, reason: 'window-opened-during-build', verdict, moved };
  return { ok: true, reason: 'unchanged', verdict, moved };
}

/**
 * One greppable line per blocking window, for the build log.
 *
 * @param {ReturnType<typeof buildWindowVerdict>} verdict
 * @param {string} root
 * @returns {string[]}
 */
export function formatBuildWindowBlock(verdict, root) {
  return verdict.blocking.map((w) => {
    const subject = w.subject ? relative(root, w.subject) || w.subject : 'unknown';
    return (
      `BUILD_MUTATION_PROBE_WINDOW state=${w.state} subject=${subject} ownerPid=${w.ownerPid ?? 'unknown'} ` +
      `ageSec=${w.ageSec ?? 'unknown'} manifest=${w.manifestPath}`
    );
  });
}

/**
 * One greppable line naming the window, or `''` when there is none.
 *
 * @param {ReturnType<typeof readMutationProbeWindow>} window
 * @param {string} checkoutRoot used only to print the subject repo-relative
 * @returns {string}
 */
export function formatMutationProbeWindow(window, checkoutRoot) {
  if (!window) return '';
  const subject = window.subject ? relative(checkoutRoot, window.subject) || window.subject : 'unknown';
  const meaning =
    window.state === 'active'
      ? 'an in-tree mutation probe has DELIBERATELY broken that file right now'
      : window.state === 'orphaned'
        ? 'a mutation probe died mid-window, so that file may STILL be mutated until the next probe recovers it'
        : 'a mutation-probe marker exists but could not be parsed, so the mutated file is unknown';
  return (
    `TEST_FILE_MUTATION_PROBE_WINDOW state=${window.state} subject=${subject} ` +
    `ownerPid=${window.ownerPid ?? 'unknown'} ageSec=${window.ageSec ?? 'unknown'} — ${meaning}. ` +
    'A red that names it, or a file that imports it, may be probe evidence rather than a regression in your change: ' +
    're-run in isolation once the window closes before attributing it (`testing:run` fences this; raw test:file/test:affected cannot).'
  );
}
