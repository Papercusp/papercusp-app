/**
 * METR HCAST result ACCUMULATION (plan benchmark-suite-metr-hcast-2026-06-17 P-005).
 *
 * Persist each completed per-(task×arm×seed) {@link MetrHcastTaskResult} to a per-arm JSONL the instant it
 * settles, and load the union back. This is the answer to "opus only opens in brief windows": instead of a
 * single long clean run, every partial run BANKS its completed rows, and the horizon report is built from the
 * cumulative accumulation across runs. A killed/timed-out run loses nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MetrHcastTaskResult } from './metr-hcast-runner';

/** The accumulation dir for a run output dir (`<dir>/accum`). */
export function accumDir(dir: string): string {
  return join(dir, 'accum');
}

/** The per-arm JSONL path. */
export function accumArmPath(dir: string, arm: string): string {
  return join(accumDir(dir), `${arm.replace(/[^a-zA-Z0-9_.-]/g, '_')}.jsonl`);
}

/** Append one settled result to its arm's accumulation JSONL (creates the dir/file as needed). */
export function appendAccumResult(dir: string, arm: string, result: MetrHcastTaskResult): void {
  const d = accumDir(dir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  appendFileSync(accumArmPath(dir, arm), JSON.stringify(result) + '\n', 'utf8');
}

/** Load every banked result, keyed by arm, from `<dir>/accum/*.jsonl` (empty when none). */
export function loadAccumulatedResults(dir: string): Record<string, MetrHcastTaskResult[]> {
  const d = accumDir(dir);
  const out: Record<string, MetrHcastTaskResult[]> = {};
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    const arm = f.replace(/\.jsonl$/, '');
    const rows = readFileSync(join(d, f), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MetrHcastTaskResult);
    if (rows.length > 0) out[arm] = rows;
  }
  return out;
}

/**
 * Coverage of the accumulation toward a non-degenerate fit: per arm, how many DISTINCT human-time-baselined
 * tasks have ≥1 SCORED attempt (resolved !== null). The horizon fit needs ≥2 distinct human-times with a
 * non-trivial success spread, so this is the "are we there yet" signal the loop can gate on.
 */
export function accumCoverage(resultsByArm: Record<string, MetrHcastTaskResult[]>): Record<string, { scoredTasks: number; baselinedTasks: number }> {
  const out: Record<string, { scoredTasks: number; baselinedTasks: number }> = {};
  for (const [arm, rows] of Object.entries(resultsByArm)) {
    const scored = new Set<string>();
    const baselined = new Set<string>();
    for (const r of rows) {
      if (r.humanMinutes != null) {
        baselined.add(r.attempt.instanceId);
        if (r.grade.resolved !== null) scored.add(r.attempt.instanceId);
      }
    }
    out[arm] = { scoredTasks: scored.size, baselinedTasks: baselined.size };
  }
  return out;
}
