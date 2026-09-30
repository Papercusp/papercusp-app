/**
 * tsc-red-observations.mjs — persist WHAT `lint:tsc` already knows, so a red that
 * outlives its author stops being invisible (EI-19342686127995790).
 *
 * ## The gap this closes
 *
 * `tsc-baseline-gate.mjs` prints, on nearly every run:
 *
 *     ⚠ N NEW file(s) (absent from the baseline) also have type errors …
 *     <path>: 0 → N  ← COMMITTED: a standing red that WILL red the fleet
 *
 * On a causally settled tree that line is correct and was thrown away every time. When other
 * paths are still uncommitted, the hot-path reporter now withholds the stronger "COMMITTED"
 * attribution because TypeScript names the diagnostic site rather than the edit that caused it;
 * persistence across later samples is what establishes a real standing red.
 *
 * EI-19340874432965755 added a THIRD wording to that same line — when the named file's own last
 * commit is older than the landing-race window it reads `← UNCHANGED <n>min; error SURFACES here,
 * so the cause is a change ELSEWHERE`. This module is unaffected: `recordStandingReds` takes
 * STRUCTURED entries, never the rendered text, so the illustration above is documentation rather
 * than a parsed contract. Note that an UNCHANGED file is still passed to this sampler on purpose —
 * its red is real and does persist (it clears only when the file that CAUSED it is fixed), and
 * suppressing it here would trade a mis-attribution problem for an invisible-red one. Measured 2026-08-02:
 * 20 heavy jobs queued on this box in one 10-minute window, 9 of them identical
 * `lint-tsc --files` compiles — so the finding is computed ~9x/hour and recorded ZERO
 * times. Meanwhile a scoped run deliberately does NOT fail you for a new file you did
 * not name (EI-19305736771912430), which is right for attribution and is exactly why
 * nobody is accountable: N agents each read the line, each correctly conclude "not
 * mine", and it survives until the green-checkpoint reds the whole fleet.
 *
 * ## Why this does NOT file on first sight
 *
 * Because most of these reds fix themselves. Measured the same day, two runs 15 minutes
 * apart over the same 5 files: 14 errors → 1, unaided (4 of 5 gone). Corroborated
 * independently by EI-19323682652730682: "lint:tsc flagged 3 separate committed reds to
 * me this session… ALL THREE were fixed by peers within ~20 min while I was
 * mid-investigation."
 *
 * So filing per sighting would have manufactured 5 work-items that day, 4 of which
 * would have closed themselves unread — trading a silent-log problem for a
 * backlog-noise problem. The valuable subset is the reds that PERSIST, because those
 * are the ones whose author has moved on and which therefore have no owner.
 *
 * The redundancy above is what makes persistence measurable at all: ~9 compiles/hour is
 * a free high-frequency sampler. This module is the memory that sampler never had.
 *
 * ## Shape: the hot path only ever appends
 *
 * `scripts/lib/tsc-baseline-gate.mjs` is shared, hot infrastructure the whole fleet
 * blocks on after every edit. It must never gain a call that can hang or fail: a
 * network/DB write there would wedge the fleet's verify step under exactly the load
 * that makes hangs likely. So the hot path does a local `appendFileSync` and nothing
 * else, wrapped so ANY failure is swallowed — `TSC_EXIT` and the `✓ tsc-clean` /
 * `YOU NAMED` verdict must keep meaning precisely what they mean today, because the
 * entire fleet reads them as authoritative. Interpretation happens off the hot path,
 * later, in a sweeper.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Default store location. Runtime dir when available so it dies with the boot, /tmp otherwise. */
export const DEFAULT_OBSERVATION_PATH = join(
  process.env.XDG_RUNTIME_DIR || '/tmp',
  'papercusp-tsc-new-file-reds.jsonl',
);

/**
 * How long a red must keep being observed before it counts as OWNERLESS.
 *
 * 45 minutes, sized from the measurement rather than taste: the observed self-heal times
 * were ~15min (the 4-of-5 dissolution) and ~26min (delegated-spawn-honor.test.ts, commit
 * 82cbf01999 11:43Z → fixed d4d26a030d 12:09Z). 45min clears the longest observed
 * self-heal with margin. Erring LONG is the safe direction here — a late filing costs a
 * delay, an early one costs a false work-item plus the peer collision that comes with it.
 *
 * Note this is deliberately longer than LANDING_RACE_WINDOW_SEC (20min) in
 * tsc-baseline-gate.mjs, which answers a DIFFERENT question: that window asks "might this
 * be half of a multi-file change still landing?", this one asks "has the author stopped
 * working on it?". A red can clear the landing-race window and still be actively owned —
 * delegated-spawn-honor.test.ts was exactly that at 22 minutes.
 */
export const DWELL_SEC = 45 * 60;

/**
 * An observation older than this is dropped: it describes a tree that no longer exists.
 * Also bounds the file, which nothing else prunes.
 */
export const RETENTION_SEC = 6 * 60 * 60;

/**
 * A path whose most recent sighting is older than this is treated as RESOLVED rather than
 * persisting. Without it, a red fixed an hour ago still looks "long-lived" — its old
 * observations span more than DWELL — and would be filed after it had already been fixed.
 * Sized above the ~9/hour observed sampling rate so a genuinely-still-red path is
 * re-observed well within it.
 */
export const STALE_SEC = 30 * 60;

/**
 * Append one observation per STANDING red. Fail-soft by construction: every failure is
 * swallowed and reported in the return value, never thrown, so a full disk / read-only
 * runtime dir / bad path can never change the gate's exit code or its stdout verdict.
 *
 * Pass ONLY the committed (`standing`) population — never `liveEdits`. A dirty path is a
 * peer mid-edit and filing against it is the documented `uncommitted` false positive.
 * Callers get that split for free from `partitionNewFilesByLiveEdit`.
 *
 * `root` is the tree the entries were MEASURED against, and stamping it is what keeps this
 * store honest (EI-21985631427355996). The store path is process-global, but `file` is only
 * ever relative to the root the gate ran from — so an observation is meaningless outside it.
 * Measured 2026-08-31: 10+ suites here drive this gate, and `lint-tsc.test.ts` drives it
 * against a synthetic `mkdtempSync` root. One run of its `old-peer.ts` case appended
 * `lib/old-peer.ts` — a path that has never existed in this repository — straight into the
 * fleet's live store; 15 such records accumulated over 172 minutes and the sweep filed a
 * work-item for it. That one suite is all that was observed polluting, but the mechanism
 * admits any of them, and per-test discipline cannot fix it (a new gate-driving test would
 * simply forget). Scoping the record to its root does, because the reader then discards it
 * without anyone having to remember.
 *
 * Omitting `root` writes no stamp, which readers admit — legacy lines and callers that
 * genuinely do not know their root keep working exactly as before.
 *
 * @param {object} opts
 * @param {{file: string, current?: number, baseline?: number}[]} opts.entries - standing reds
 * @param {string} [opts.path] - store path
 * @param {number} [opts.nowMs]
 * @param {string} [opts.project] - which tsc project observed it (several gates share the store)
 * @param {string} [opts.root] - tree the entries are relative to; unstamped when omitted
 * @returns {{ok: boolean, written: number, error?: string}}
 */
export function recordStandingReds({ entries, path = DEFAULT_OBSERVATION_PATH, nowMs = Date.now(), project = '', root = '' }) {
  if (!Array.isArray(entries) || entries.length === 0) return { ok: true, written: 0 };
  try {
    const ts = Math.floor(nowMs / 1000);
    const lines = entries
      .filter((e) => e && typeof e.file === 'string' && e.file.length > 0)
      .map((e) =>
        JSON.stringify(root ? { ts, file: e.file, count: e.current ?? null, project, root } : { ts, file: e.file, count: e.current ?? null, project }),
      )
      .join('\n');
    if (lines.length === 0) return { ok: true, written: 0 };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, lines + '\n');
    return { ok: true, written: entries.length };
  } catch (err) {
    // Deliberately swallowed — see the module header. The gate's verdict outranks this.
    return { ok: false, written: 0, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * The gate verdicts on which the COMPLETE standing new-file red set is known.
 *
 * This list is the soundness boundary of the whole resolution path below, so it is an
 * ALLOW-list, never a `!startsWith('fail-')` test: a verdict nobody has classified must
 * default to "we do not know", and a deny-list silently admits every future verdict.
 *
 * Why exactly these four. `newFiles` is computed only on the unattributed-regression path
 * (tsc-baseline-gate.mjs) — so:
 *   - `ok-peer-drift` computes it AND records it via recordStandingReds(): known, complete.
 *   - `ok` / `ok-below` / `ok-ratchet` are reached only when NOTHING regressed above
 *     baseline. A new file with type errors IS a regression (absent baseline => 0 -> N), so
 *     these verdicts entail an EMPTY standing set. Known, complete, and empty.
 *   - every `fail-*` verdict exits before the standing set is recorded (and `fail-regressed`
 *     never computes it at all), so a run that ended in one proves NOTHING about whether a
 *     given file is still red. Emitting a heartbeat there would be the false-clean bug this
 *     whole module exists to avoid.
 */
export const COMPLETE_STANDING_SET_VERDICTS = Object.freeze(['ok', 'ok-below', 'ok-peer-drift', 'ok-ratchet']);

/**
 * Did a run ending in `verdict` observe the complete standing set? Pure, so the soundness
 * boundary is unit-testable without running a compile.
 */
export function verdictObservesCompleteStandingSet(verdict) {
  return COMPLETE_STANDING_SET_VERDICTS.includes(verdict);
}

/**
 * Append ONE run heartbeat — "a full compile of `project` completed at T and the standing set
 * it observed is recorded in this same store".
 *
 * THIS IS THE MISSING HALF OF THE SAMPLER. Observations alone can only ever say a red EXISTS;
 * nothing in the store distinguishes "still red" from "the sampler stopped running", so a red
 * that gets FIXED simply stops being mentioned and its work-item sits open forever as a
 * severity:major false critical (measured 2026-08-10: 5 of 5 open ones were stale, 4 of them
 * by ~30h). A heartbeat is what makes silence readable: a run that completed AFTER a file's
 * last sighting, and did not re-sight it, is POSITIVE evidence the red is gone — because a run
 * that still saw it would have appended a fresh observation for it in this very store.
 *
 * That inference is only valid when the run actually knew the complete standing set, which is
 * why the verdict is REQUIRED and filtered here rather than at the call site: a caller that
 * forgets the guard gets a no-op, not an unsound heartbeat.
 *
 * Fail-soft on the same terms as recordStandingReds — this runs on the gate's hot path, which
 * the whole fleet blocks on, so every failure is swallowed and TSC_EXIT is never affected.
 *
 * @param {object} opts
 * @param {string} opts.verdict - the gate verdict this run ended on
 * @param {string} [opts.project] - which tsc project ran (several gates share the store)
 * @param {number} [opts.standingCount] - how many standing reds it observed (0 on the ok paths)
 * @param {string} [opts.path]
 * @param {number} [opts.nowMs]
 * @returns {{ok: boolean, written: number, skipped?: string, error?: string}}
 */
export function recordGateRun({
  verdict,
  project = '',
  standingCount = 0,
  path = DEFAULT_OBSERVATION_PATH,
  nowMs = Date.now(),
}) {
  if (!verdictObservesCompleteStandingSet(verdict)) {
    return { ok: true, written: 0, skipped: 'incomplete-standing-set' };
  }
  try {
    const ts = Math.floor(nowMs / 1000);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts, kind: 'run', project, verdict, standingCount }) + '\n');
    return { ok: true, written: 1 };
  } catch (err) {
    // Deliberately swallowed — see the module header. The gate's verdict outranks this.
    return { ok: false, written: 0, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Read the run heartbeats, dropping anything unparseable or past RETENTION_SEC.
 *
 * @returns {{ts: number, project: string, verdict: string, standingCount: number}[]}
 */
export function readRunHeartbeats({ path = DEFAULT_OBSERVATION_PATH, nowMs = Date.now(), retentionSec = RETENTION_SEC } = {}) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const cutoff = Math.floor(nowMs / 1000) - retentionSec;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.kind !== 'run' || typeof rec.ts !== 'number') continue;
    if (rec.ts < cutoff) continue;
    out.push({
      ts: rec.ts,
      project: rec.project ?? '',
      verdict: rec.verdict ?? '',
      standingCount: typeof rec.standingCount === 'number' ? rec.standingCount : 0,
    });
  }
  return out;
}

/**
 * Read observations, dropping anything unparseable or past RETENTION_SEC.
 *
 * A corrupt line is skipped rather than fatal: concurrent appenders (9 compiles/hour, several
 * at once) can in principle interleave a partial write, and one bad line must not blind the
 * sweeper to every good one.
 *
 * `root` (when supplied) drops observations STAMPED with a different tree — see
 * `recordStandingReds`. This is deliberately not symmetric: an UNSTAMPED line is admitted,
 * because "no stamp" means unknown, and a reader that discarded unknowns would silently
 * blind itself to every legacy line and to any caller that cannot name its root. So the
 * filter only ever acts on positive evidence that a line belongs to some OTHER tree —
 * which is exactly the fixture-pollution case and nothing else.
 *
 * @returns {{ts: number, file: string, count: number|null, project: string}[]}
 */
export function readObservations({ path = DEFAULT_OBSERVATION_PATH, nowMs = Date.now(), retentionSec = RETENTION_SEC, root = '' } = {}) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const cutoff = Math.floor(nowMs / 1000) - retentionSec;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Run heartbeats share this store but are NOT observations of a red — never let one
    // reach selectDwelledReds. They have no `file`, so the shape guard below already
    // excludes them; this is explicit so a future heartbeat field cannot smuggle one in.
    if (rec && rec.kind === 'run') continue;
    if (!rec || typeof rec.file !== 'string' || typeof rec.ts !== 'number') continue;
    if (rec.ts < cutoff) continue;
    // Positive evidence of a foreign tree only — an absent/blank stamp is UNKNOWN, and
    // unknown is admitted (see the header). `root` unset disables the filter entirely.
    if (root && typeof rec.root === 'string' && rec.root && rec.root !== root) continue;
    out.push({ ts: rec.ts, file: rec.file, count: rec.count ?? null, project: rec.project ?? '' });
  }
  return out;
}

/**
 * THE DECISION — which observed reds have persisted long enough to be considered ownerless.
 *
 * Pure (no fs, no clock, no git) so it is testable without a tree. A path qualifies only when
 * ALL of:
 *   - its observations span >= dwellSec (first sighting to last), i.e. it SURVIVED rather than
 *     merely appeared;
 *   - it was seen at least twice — one sighting cannot establish persistence, only existence;
 *   - its most recent sighting is within staleSec, i.e. it is still being observed and has not
 *     silently been fixed since.
 *
 * The two-sighting floor and the staleness ceiling are the controls: without the first, a single
 * old observation reads as a long-lived red; without the second, a red fixed an hour ago still
 * qualifies forever on the strength of its history.
 *
 * @param {{ts: number, file: string, count: number|null}[]} observations
 * @param {object} [opts]
 * @returns {{file: string, firstSeen: number, lastSeen: number, sightings: number, spanSec: number, latestCount: number|null}[]}
 */
export function selectDwelledReds(observations, { nowMs = Date.now(), dwellSec = DWELL_SEC, staleSec = STALE_SEC } = {}) {
  const nowSec = Math.floor(nowMs / 1000);
  /** @type {Map<string, {ts: number, count: number|null}[]>} */
  const byFile = new Map();
  for (const o of observations) {
    if (!byFile.has(o.file)) byFile.set(o.file, []);
    byFile.get(o.file).push({ ts: o.ts, count: o.count ?? null });
  }
  const out = [];
  for (const [file, seen] of byFile) {
    if (seen.length < 2) continue;
    seen.sort((a, b) => a.ts - b.ts);
    const firstSeen = seen[0].ts;
    const lastSeen = seen[seen.length - 1].ts;
    const spanSec = lastSeen - firstSeen;
    if (spanSec < dwellSec) continue;
    if (nowSec - lastSeen > staleSec) continue;
    out.push({
      file,
      firstSeen,
      lastSeen,
      sightings: seen.length,
      spanSec,
      latestCount: seen[seen.length - 1].count,
    });
  }
  // Longest-standing first: that ordering is the triage order.
  out.sort((a, b) => b.spanSec - a.spanSec);
  return out;
}

/**
 * Rewrite the store keeping only observations still inside retention. Called by the sweeper,
 * never by the gate — the hot path only ever appends.
 *
 * @returns {{ok: boolean, kept: number, error?: string}}
 */
export function pruneObservations({ path = DEFAULT_OBSERVATION_PATH, nowMs = Date.now(), retentionSec = RETENTION_SEC } = {}) {
  try {
    const kept = readObservations({ path, nowMs, retentionSec });
    // Heartbeats live in this same file and MUST survive the prune. Rewriting from
    // readObservations alone silently deleted every one of them — which would not fail
    // anything, it would just make the resolution path permanently unable to find evidence
    // and therefore permanently silent. That is the exact failure shape this module is
    // being extended to remove, so it gets its own line rather than a comment.
    const keptRuns = readRunHeartbeats({ path, nowMs, retentionSec });
    if (!existsSync(path)) return { ok: true, kept: 0, keptRuns: 0 };
    const rows = [
      ...kept.map((o) => ({ ts: o.ts, rec: o })),
      ...keptRuns.map((r) => ({
        ts: r.ts,
        rec: { ts: r.ts, kind: 'run', project: r.project, verdict: r.verdict, standingCount: r.standingCount },
      })),
    ].sort((a, b) => a.ts - b.ts);
    writeFileSync(path, rows.map((r) => JSON.stringify(r.rec)).join('\n') + (rows.length ? '\n' : ''));
    return { ok: true, kept: kept.length, keptRuns: keptRuns.length };
  } catch (err) {
    return { ok: false, kept: 0, keptRuns: 0, error: String(err && err.message ? err.message : err) };
  }
}
