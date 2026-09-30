/**
 * pc-heavy after-ready / PSI-finalization marker publication — the ONE
 * implementation of the exclusive-create rule and its debris reclamation.
 *
 * WHY THIS MODULE EXISTS. The rule below lived in `scripts/test-files.mjs`
 * only, because that is where the failure was first observed
 * (EI-21882371330313535: an EEXIST on the after-ready marker aborted the whole
 * run as `TEST_FILE_ROUTE_ERROR` exit 75). `scripts/affected-tests.mjs` carried
 * a SECOND, independent copy of the same publication logic with no liveness
 * check at all — any EEXIST was fatal there too, on the runner the
 * green-checkpoint gate itself invokes, where an abort means zero files were
 * measured and therefore reads as a real red rather than as infra debris
 * (EI-21884510946030513).
 *
 * The divergence between those two copies WAS the bug, so the fix is a shared
 * module rather than a third copy. `affected-tests.mjs` deliberately imports
 * from HERE and not from `test-files.mjs`: that module runs top-level side
 * effects (`ensurePapercuspTmpdir()`, `applyWorkerCapEnv(...)`) which must not
 * be dragged onto the gate's runner.
 *
 * THE CONTRACT, which is asymmetric on purpose:
 *   - a LIVE owner still wins — exclusivity is only protecting something then;
 *   - dead or long-stale debris is reclaimed rather than aborting the run;
 *   - anything ambiguous resolves to LIVE, because wrongly refusing costs one
 *     run while wrongly stealing breaks a peer's barrier and lets its cleanup
 *     remove a file it no longer owns.
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How long a ZERO-LENGTH marker may sit before the publisher calls it debris.
 * A marker is created with O_CREAT|O_EXCL and the pid is written immediately
 * after, so a process killed between them leaves a zero-length file with NO pid
 * recorded. That gap is microseconds, so seconds of slack is generous while
 * still refusing to steal a marker from a peer that is publishing right now.
 */
const EMPTY_MARKER_DEBRIS_MS = 5_000;

/**
 * Filenames this sweep is willing to consider. pc-heavy allocates both marker
 * families itself with `mktemp "$dir/ready.XXXXXX"` and
 * `mktemp "$dir/finalization.XXXXXX"` (scripts/pc-heavy.sh:2815-2820), so the
 * shape is known exactly. Anything else in the directory belongs to something
 * we know nothing about and is never touched.
 */
const PREEMPT_MARKER_NAME_RE = /^(?:ready|finalization)\.[A-Za-z0-9]{6}$/;

/**
 * Generous empty-marker bound for the SWEEP (the publisher keeps the tight 5s).
 * The observed debris was up to 20 HOURS old, so an hour is still decisive while
 * leaving enormous headroom over the microsecond open()/write() gap that creates
 * these files.
 */
const SWEEP_EMPTY_DEBRIS_MS = 3_600_000;

/**
 * A floor under the whole sweep: nothing younger than this is removed no matter
 * what its contents say. This is what makes the sweep unable to interfere with a
 * run that is starting right now — including pc-heavy's own allocation window,
 * where `mktemp` briefly leaves a zero-length file before deleting it.
 */
const SWEEP_MIN_AGE_MS = 120_000;

/** Bound the work: this runs on the hot path of the repo's busiest test entrypoints. */
const SWEEP_MAX_ENTRIES = 500;

/**
 * Is the marker at `marker` held by a LIVE owner?
 *
 * Deliberately biased toward TRUE: every ambiguous or unreadable case answers
 * "live", because wrongly claiming a peer's barrier is far worse than wrongly
 * refusing our own — a refusal costs one run, a theft breaks the peer's
 * protection and lets its cleanup remove a file it no longer owns.
 *
 * `emptyDebrisMs` is a PARAMETER rather than the constant because the two
 * callers judge different things and must not share a bound. The publisher is
 * deciding about the ONE path it needs and can afford the tight 5s default; the
 * directory sweep judges OTHER runs' files, where a false positive steals a live
 * peer's barrier, so it passes a far more generous bound (EI-21883357870313468).
 *
 * @param {string} marker
 * @param {number} [emptyDebrisMs] how long a zero-length marker may sit before it is debris
 * @returns {boolean}
 */
function preemptMarkerOwnerIsAlive(marker, emptyDebrisMs = EMPTY_MARKER_DEBRIS_MS) {
  let raw;
  try {
    raw = readFileSync(marker, 'utf8');
  } catch (error) {
    // Vanished between the failed create and this read ⇒ nothing holds it.
    if (error?.code === 'ENOENT') return false;
    return true;
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH ⇒ the recorded owner is gone. EPERM ⇒ it is alive but not ours,
      // which is still alive. Anything else is unknown, so assume alive.
      if (error?.code === 'ESRCH') return false;
      return true;
    }
  }

  // No pid recorded: an interrupted exclusive-create. Provenance cannot help
  // here — there is nothing to check liveness against — so age is the only
  // available signal.
  try {
    return Date.now() - statSync(marker).mtimeMs < emptyDebrisMs;
  } catch {
    return false;
  }
}

/**
 * Remove abandoned pc-heavy markers from the directory we are publishing into.
 *
 * WHY THIS EXISTS. pc-heavy designates its monitor as the cleanup backstop for a
 * child that dies before its own `exit` handler runs — but the monitor is itself
 * killable, and under preemption the whole process group is torn down together,
 * so the backstop shares a fate with the thing it is backing up. Markers then
 * survive with no owner left to remove them (EI-21883357870313468: 7 of 10 files
 * present were provably dead, one 20 hours old).
 *
 * This adds the missing fate-independent reclamation path: a LATER, unrelated,
 * demonstrably-alive process cleans up, so debris cannot outlive the next run
 * that publishes here. It is pure hygiene — every failure is swallowed, because
 * failing to tidy must never fail a test run.
 *
 * @param {string} dir directory to sweep
 * @param {{ self?: string, now?: number, minAgeMs?: number, emptyDebrisMs?: number, maxEntries?: number }} [options]
 * @returns {string[]} names actually removed
 */
export function reapPreemptMarkerDebris(dir, options = {}) {
  const {
    self,
    now = Date.now(),
    minAgeMs = SWEEP_MIN_AGE_MS,
    emptyDebrisMs = SWEEP_EMPTY_DEBRIS_MS,
    maxEntries = SWEEP_MAX_ENTRIES,
  } = options;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const removed = [];
  let examined = 0;
  for (const name of entries) {
    if (examined >= maxEntries) break;
    if (!PREEMPT_MARKER_NAME_RE.test(name)) continue;
    examined += 1;

    const path = join(dir, name);
    // Never judge the marker this process owns.
    if (self && path === self) continue;

    try {
      // The age floor is checked FIRST and independently of contents: a file
      // young enough to belong to a starting run is never a candidate, so no
      // contents-based rule can reach it.
      if (now - statSync(path).mtimeMs < minAgeMs) continue;
      if (preemptMarkerOwnerIsAlive(path, emptyDebrisMs)) continue;
      unlinkSync(path);
      removed.push(name);
    } catch {
      // Vanished, unreadable, or owned by another user — all mean "not ours to
      // reclaim". Skip it; a sweep must never turn into a failure.
    }
  }

  return removed;
}

/**
 * Create `marker` exclusively, reclaiming it when — and only when — the
 * incumbent is provably not a live owner.
 *
 * This is the whole EEXIST rule in one place. It does NOT log and does NOT
 * decide what a failure means: the two runners report differently (one throws
 * to its caller, one exits 75) and each keeps its own policy, which is why this
 * returns an outcome instead of handling it.
 *
 * @param {string} marker absolute path to create
 * @returns {'created'|'reclaimed'} how the marker came to be ours
 * @throws the original EEXIST when a LIVE owner holds the path, and any other
 *   filesystem error unchanged — both mean "this run does not own the barrier".
 */
export function createPreemptMarkerExclusive(marker) {
  try {
    writeFileSync(marker, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    // Exclusivity is only protecting something when a LIVE owner holds the
    // path, so refuse in exactly that case and reclaim otherwise.
    if (preemptMarkerOwnerIsAlive(marker)) throw error;

    try {
      unlinkSync(marker);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    // Re-create exclusively rather than truncating: if a peer claimed the path
    // in this window it wins, and its EEXIST propagates as genuine contention.
    writeFileSync(marker, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return 'reclaimed';
  }
}
