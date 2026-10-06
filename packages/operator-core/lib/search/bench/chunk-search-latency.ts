/**
 * chunk-search-latency.ts — the fixed query set and the pure summary math behind
 * the chunk-aware search latency bench (plan generic-rag-chunking-2026-09-29,
 * acceptance BAR R-33, baseline Decision D-024).
 *
 * WHY IT IS COMMITTED
 * R-33 compares each search site's p95 after chunk registration with the p95 that
 * D-024 recorded before any collection registered, and D-024 says the comparison
 * must replay the SAME 30 queries. That query set used to live only in a
 * gitignored scratch script, so nobody but its author could re-run R-33. The set
 * now lives here, and `chunk-search-latency.test.ts` pins its hash to the value
 * D-024 recorded — editing a query is caught before it silently changes the
 * baseline the bound is measured against.
 *
 * The runnable bench is `chunk-search-latency-cli.ts`; this module has no I/O so
 * the test can import it without starting a run.
 */
import { createHash } from 'node:crypto';

/** The fixed 30-query set of D-024. Order matters: the hash covers it. */
export const CHUNK_SEARCH_LATENCY_QUERIES: readonly string[] = [
  'green checkpoint gate stays red after the fix lands',
  'git-sync push stalled for hours',
  'embedding backfill coverage for work items',
  'file lock held by a dead session',
  'mutation probe restores the file after the test',
  'carry-respawn loses background bash tasks',
  'fleet leader stand-down wind-down order',
  'HNSW iterative scan returns too few rows',
  'chunk long documents before embedding them',
  'desktop app webview headless verification',
  'postgres connection pool exhausted under load',
  'owner directive disposition and the orders list',
  'acceptance rubric vetting and independent grading',
  'release deploy auto-rollback crash loop',
  'frozen repair queue admit paths',
  'session transcript search by owner',
  'consult router picks the wrong expert',
  'SSE sync invalidation after a write commits',
  'feature flag default off dark allowlist',
  'migration number allocator reservation race',
  'typecheck baseline errors in operator-vite',
  'mcp proxy handshake starvation under load',
  'work item claim conflict with a live peer',
  'loop rewake not guaranteed after compaction',
  'embed sidecar down so search degrades to lexical only',
  'plan decision recorded for a cross-lane ruling',
  'test affected selects zero workspaces',
  'task manager cgroup kill by task id',
  'reciprocal rank fusion of lexical and semantic legs',
  'stale deploy sha on port 3070',
];

/** The query-set hash D-024 recorded with its baseline. */
export const D024_QUERY_SET_HASH = 'a7b47c0b2e7aa900f19185f6a8f9d57626b18bf635a9b0c9d42c810464af2e10';

/** sha256 over the queries joined by newlines — the form D-024 recorded. */
export function querySetHash(queries: readonly string[] = CHUNK_SEARCH_LATENCY_QUERIES): string {
  return createHash('sha256').update(queries.join('\n')).digest('hex');
}

/**
 * The R-33 bound per site: p95 after registration at most 1.25x the D-024
 * baseline p95 (milliseconds). Keys match the bench's site names.
 */
export const D024_BASELINE_P95_MS: Readonly<Record<string, number>> = {
  plans: 1652,
  turns: 1392,
  work_item: 1609,
  work_items_search: 400,
  consult: 14,
};
export const R33_RATIO = 1.25;

/** Nearest-rank percentile (the definition the D-024 baseline used). */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface LatencySample {
  round: number;
  q: number;
  ms: number;
  ok: boolean;
  degraded: boolean;
  retries?: number;
  error?: string;
}

export interface SiteSummary {
  n: number;
  ok: number;
  errors: number;
  degraded: number;
  transportRetries: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  perRoundP95: Array<number | null>;
  firstErrors: string[];
}

/**
 * Summarise one site's samples. Failed calls are counted as errors and kept OUT
 * of the percentiles: an error is not a latency reading.
 */
export function summariseSite(samples: readonly LatencySample[], rounds: number): SiteSummary {
  const ok = samples.filter((s) => s.ok);
  const ms = ok.map((s) => s.ms);
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    n: samples.length,
    ok: ok.length,
    errors: samples.length - ok.length,
    degraded: samples.filter((s) => s.degraded).length,
    transportRetries: samples.reduce((a, s) => a + (s.retries ?? 0), 0),
    p50: round(percentile(ms, 50)),
    p95: round(percentile(ms, 95)),
    max: ms.length ? Math.round(Math.max(...ms)) : null,
    perRoundP95: Array.from({ length: rounds }, (_, r) =>
      round(percentile(ok.filter((s) => s.round === r).map((s) => s.ms), 95)),
    ),
    firstErrors: samples
      .filter((s) => !s.ok)
      .slice(0, 3)
      .map((s) => s.error ?? 'unknown error'),
  };
}

export interface R33SiteVerdict {
  site: string;
  p95: number | null;
  baselineP95: number;
  bound: number;
  withinBound: boolean | null;
}

/**
 * Compare each summarised site with its D-024 bound. `withinBound` is null when
 * the site produced no successful sample, so a site that never answered can not
 * read as a pass.
 */
export function r33Verdicts(summaries: Readonly<Record<string, SiteSummary>>): R33SiteVerdict[] {
  return Object.entries(D024_BASELINE_P95_MS).map(([site, baselineP95]) => {
    const p95 = summaries[site]?.p95 ?? null;
    const bound = Math.round(baselineP95 * R33_RATIO * 10) / 10;
    return { site, p95, baselineP95, bound, withinBound: p95 === null ? null : p95 <= bound };
  });
}

/** Load averages (1, 5, 15 min) when the D-024 baseline run started. */
export const D024_LOADAVG_START: readonly [number, number, number] = [69.9, 75.9, 90.2];
/** D-024's re-measure rule: load within 20% of the baseline run's. */
export const D024_LOAD_TOLERANCE = 0.2;

const LOAD_WINDOWS = ['1m', '5m', '15m'] as const;

export interface LoadMatch {
  /** True only when all three averages are in band at both the start and the end. */
  matched: boolean;
  band: Record<(typeof LOAD_WINDOWS)[number], { min: number; max: number }>;
  start: readonly number[];
  end: readonly number[];
  /** Each average that left the band, e.g. "start 5m 111 > 91.1". */
  outOfBand: string[];
}

/**
 * Whether a run's load matched the D-024 baseline run (plan D-038). D-024 keeps a
 * re-measure only "with load average within 20% of this baseline"; D-038 reads that as
 * all three averages, at the start AND the end of the run. A 1-min-only check passed
 * runs whose 5- and 15-min averages were 100-150 against D-024's 75.9 / 90.2.
 */
export function d024LoadMatch(start: readonly number[], end: readonly number[]): LoadMatch {
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const band = Object.fromEntries(
    LOAD_WINDOWS.map((w, i) => [
      w,
      {
        min: round1(D024_LOADAVG_START[i] * (1 - D024_LOAD_TOLERANCE)),
        max: round1(D024_LOADAVG_START[i] * (1 + D024_LOAD_TOLERANCE)),
      },
    ]),
  ) as LoadMatch['band'];
  const outOfBand: string[] = [];
  for (const [label, triple] of [
    ['start', start],
    ['end', end],
  ] as const) {
    LOAD_WINDOWS.forEach((w, i) => {
      const v = triple[i];
      const { min, max } = band[w];
      if (typeof v !== 'number' || !Number.isFinite(v)) outOfBand.push(`${label} ${w} missing`);
      else if (v < min) outOfBand.push(`${label} ${w} ${round1(v)} < ${min}`);
      else if (v > max) outOfBand.push(`${label} ${w} ${round1(v)} > ${max}`);
    });
  }
  return { matched: outOfBand.length === 0, band, start: [...start], end: [...end], outOfBand };
}
