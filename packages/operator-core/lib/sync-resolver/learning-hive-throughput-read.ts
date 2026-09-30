/**
 * learning-hive-throughput-read.ts — the read behind the Learning tab's
 * "Throughput" sub-view (queen-autonomous-execution-2026-06-13, B-11 / P-050).
 *
 * Reads `harness_shared.pot_throughput_ticks` (migration 261), grouped by hive:
 * the latest tick (the live metric cards) + a recent trend window (sparkline)
 * + the operating-well verdict (the health tone). Pure SQL over an injected
 * `Sql` (mirrors learning-scout-read.ts) so the resolver test stubs the seam.
 *
 * Best-effort: the migration may not be applied yet on a given substrate, so an
 * undefined-table (42P01) degrades to the EMPTY snapshot — the tab renders
 * "no throughput recorded yet", never a 500.
 */
import type { Sql } from 'postgres';
import { degraded, isUndefinedTable, type DegradedProvenance } from './degraded-snapshot';
import {
  isOperatingWell,
  normalizeThroughputRow,
  type PotThroughputTickRow,
  type RawThroughputTickRow,
} from '../pot/throughput';

/** One hive's throughput view: latest metrics + recent trend + health verdict. */
export interface PotThroughputView {
  potSlug: string;
  /** The newest tick (the live cards), or null when none recorded. */
  latest: PotThroughputTickRow | null;
  /** Recent ticks, newest-first, for the trend sparkline. */
  recent: PotThroughputTickRow[];
  /** The operating-well yardstick over the latest tick (false when none yet). */
  operatingWell: boolean;
}

/**
 * WI-6382: `Partial<DegradedProvenance>` so a degraded read is TYPED, not just
 * conventionally tagged — a consumer that forgets `unavailable` exists is the
 * failure mode this closes. A snapshot WITHOUT `unavailable` is a genuine,
 * trustworthy empty; with it, the substrate could not be read.
 */
export interface HiveThroughputSnapshot extends Partial<DegradedProvenance> {
  hives: PotThroughputView[];
}

// `isUndefinedTable` lives in ./degraded-snapshot — it had drifted into two
// byte-identical copies (here and learning-scout-read.ts). One rule, one
// definition: a rule that exists twice is a rule that can come to disagree
// with itself. Re-exported so existing importers keep their call site.
export { isUndefinedTable };

/** Group recent throughput ticks into per-hive views (newest-first per hive). */
export async function readHiveThroughputSnapshot(
  sql: Sql,
  workspaceId: string,
  opts: { potSlug?: string; recentLimit?: number } = {},
): Promise<HiveThroughputSnapshot> {
  const recentLimit = Math.min(Math.max(opts.recentLimit ?? 60, 1), 500);
  let rows: RawThroughputTickRow[] = [];
  try {
    // Cap the scan generously; per-hive trend slicing happens in memory below.
    rows = (await sql`
      SELECT pot_slug, tick_at, frontier_depth, placements, cups_busy, cups_cap,
             stuck_count, completed, mttc_ms, question_rungs, detail
        FROM harness_shared.pot_throughput_ticks
       WHERE workspace_id = ${workspaceId}
         ${opts.potSlug ? sql`AND pot_slug = ${opts.potSlug}` : sql``}
       ORDER BY tick_at DESC
       LIMIT 2000
    `) as RawThroughputTickRow[];
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.hiveThroughput] tick read failed:', err instanceof Error ? err.message : err);
    }
    // WI-6382: still never a 500 — but the degraded snapshot now SAYS it is
    // degraded. Returning a bare `{ hives: [] }` made a broken/pre-migration
    // substrate byte-identical to a healthy idle one, so the panel confidently
    // told the user "No throughput recorded yet — start a pot and its metrics
    // appear here": an instruction to wait for something that will never come.
    return degraded({ hives: [] }, err);
  }

  // Group newest-first; the query is already DESC so insertion order is preserved.
  const byHive = new Map<string, PotThroughputTickRow[]>();
  for (const raw of rows) {
    const row = normalizeThroughputRow(raw);
    const list = byHive.get(row.potSlug);
    if (list) list.push(row);
    else byHive.set(row.potSlug, [row]);
  }

  const hives: PotThroughputView[] = [...byHive.entries()].map(([potSlug, ticks]) => {
    const latest = ticks[0] ?? null;
    return {
      potSlug,
      latest,
      recent: ticks.slice(0, recentLimit),
      operatingWell: latest ? isOperatingWell(latest) : false,
    };
  });
  // Stable order: hives with a stuck/starved latest tick first (attention), then alphabetical.
  hives.sort((a, b) => Number(a.operatingWell) - Number(b.operatingWell) || a.potSlug.localeCompare(b.potSlug));
  return { hives };
}
