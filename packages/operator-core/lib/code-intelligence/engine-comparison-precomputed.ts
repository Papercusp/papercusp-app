/**
 * P-005 — precomputed cold-index cost for the engine comparison.
 *
 * A cold GitNexus `analyze` over the bounded tree takes ~15 min and ~8 GB RSS on
 * this box, so the bench runs it ONCE under `/usr/bin/time -v` (stdout/stderr
 * persisted beside the arm) and `runEngineArm` re-uses that measurement instead
 * of repeating it. The cost is therefore a real wall/RSS measurement of a real
 * cold index, never an estimate — and the loader REFUSES (ok:false) when the
 * log does not prove a clean exit, so a half-finished or failed index can never
 * be reported as a pass.
 */
import type { EngineArm, PhaseCost } from './engine-comparison';

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** GNU `time -v` "Elapsed (wall clock) time (h:mm:ss or m:ss): 14:49.45" → ms. */
export function parseElapsedMs(timeV: string): number | null {
  // The label itself contains colons — "(h:mm:ss or m:ss):" — so anchor on the closing "):".
  const m = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(timeV);
  if (!m) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** First load-average figure from either `uptime` output or a `load-before: a b c` line. */
export function parseLoadAvg1(text: string): number | null {
  const up = /load average:\s*([\d.]+)/.exec(text);
  if (up) return num(up[1]);
  const plain = /load-(?:before|after):\s*([\d.]+)/.exec(text);
  return plain ? num(plain[1]) : null;
}

export interface PrecomputedIndexLogs {
  /** stderr of the `/usr/bin/time -v <analyze>` run. */
  readonly timeV: string;
  /** stdout of the same run (a clean analyzer prints no failure here). */
  readonly stdout: string;
  readonly loadAfter: string | null;
}

/** Turn the persisted logs of one real cold index into a `PhaseCost`. Never throws. */
export function phaseCostFromTimeLogs(logs: PrecomputedIndexLogs): PhaseCost {
  const wallMs = parseElapsedMs(logs.timeV);
  const exit = /Exit status:\s*(\d+)/.exec(logs.timeV);
  const rss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(logs.timeV);
  const loadAvg1 = logs.loadAfter === null ? null : parseLoadAvg1(logs.loadAfter);
  if (wallMs === null || !exit) {
    return { wallMs: wallMs ?? 0, peakRssKb: num(rss?.[1]), ok: false, loadAvg1, error: 'precomputed cold index log has no Elapsed/Exit status (run unfinished or not under time -v)' };
  }
  const code = Number(exit[1]);
  return {
    wallMs,
    peakRssKb: num(rss?.[1]),
    ok: code === 0,
    loadAvg1,
    error: code === 0 ? null : `cold index exit ${code}: ${logs.stdout.trim().slice(-200)}`,
  };
}

/**
 * Wrap an arm so `index()` returns an already-measured cold-index cost instead of
 * re-running it. Everything else — refresh, query, index size — stays live.
 */
export function withPrecomputedIndex(arm: EngineArm, load: () => Promise<PhaseCost>): EngineArm {
  return {
    id: arm.id,
    version: arm.version,
    treeRoot: arm.treeRoot,
    unavailable: arm.unavailable,
    index: load,
    refresh: () => arm.refresh(),
    query: (kase) => arm.query(kase),
    indexBytes: () => arm.indexBytes(),
  };
}
