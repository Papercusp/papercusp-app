/**
 * FrontierSWE resumability core (plan benchmark-suite-frontier-swe-2026-06-18 P-010). Ultra-long-horizon runs
 * (4–20 h/task × 5 trials × N topologies) WILL be interrupted — so the run driver must be able to re-run ONLY
 * the missing (task, seed) trials, never redo completed ones (su-37e53a76's "make it resumable: durable per-task
 * results.jsonl + a self-healing wrapper"). This module is the PURE core the run driver composes: a durable
 * append-only results.jsonl + the "what's still missing" computation. The driver owns the live loop (poll the
 * spawn to TERMINAL before recording — else a still-running bee is mis-recorded as $0/infra); this owns the
 * bookkeeping, unit-tested with a temp file (no run).
 *
 * C6 discipline: an INFRA non-completion (graderStatus 'error'/'timeout') is recorded (for the audit trail) but
 * does NOT count as a completed trial — it is RE-RUN on resume (self-healing). Only a genuine graded outcome
 * (a numeric score / boolean resolved, non-infra) marks a (task, seed) done.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One durable trial record appended to the run's results.jsonl. */
export interface FrontierSweResultRecord {
  instanceId: string;
  /** Trial ordinal (0..k-1). */
  seed: number;
  /** Topology arm id (omit for single-arm runs). */
  arm?: string;
  score: number | null;
  resolved: boolean | null;
  /** 'passed' | 'failed' | 'error' | 'timeout' — error/timeout = infra, re-run on resume. */
  graderStatus: string;
  /** Optional epoch-ms stamp (the driver supplies it; omitted here since Date.now() is non-deterministic). */
  ts?: number;
}

/** A scored (non-infra) trial we never need to re-run. */
export function isScoredRecord(r: FrontierSweResultRecord): boolean {
  return r.graderStatus !== 'error' && r.graderStatus !== 'timeout' && (r.score != null || r.resolved != null);
}

/** Read the durable results.jsonl (missing/empty file → []). Malformed lines are skipped, not fatal. */
export function readRunResults(path: string): FrontierSweResultRecord[] {
  if (!existsSync(path)) return [];
  const out: FrontierSweResultRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as FrontierSweResultRecord);
    } catch {
      /* skip a torn final line from an interrupted write */
    }
  }
  return out;
}

/** Durably append one trial record (creating the dir/file as needed). Append-only → crash-safe. */
export function appendRunResult(path: string, rec: FrontierSweResultRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + '\n');
}

/** instanceId → set of seeds with a SCORED result for `arm` (the trials we can skip on resume). */
export function scoredTrials(records: readonly FrontierSweResultRecord[], arm?: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const r of records) {
    if (arm !== undefined && r.arm !== arm) continue;
    if (!isScoredRecord(r)) continue;
    const set = out.get(r.instanceId) ?? new Set<number>();
    set.add(r.seed);
    out.set(r.instanceId, set);
  }
  return out;
}

/**
 * The resume plan: for each task, the seeds in [0, k) that still lack a SCORED result for `arm`. An infra row
 * (error/timeout) leaves its seed missing → it is re-run (self-healing). Tasks fully complete are omitted.
 */
export function missingTrials(
  taskIds: readonly string[],
  k: number,
  records: readonly FrontierSweResultRecord[],
  arm?: string,
): Array<{ instanceId: string; seeds: number[] }> {
  if (!Number.isInteger(k) || k < 1) throw new Error(`frontier-swe-resume: k must be an integer ≥ 1 (got ${k})`);
  const done = scoredTrials(records, arm);
  const out: Array<{ instanceId: string; seeds: number[] }> = [];
  for (const instanceId of taskIds) {
    const haveSeeds = done.get(instanceId) ?? new Set<number>();
    const seeds: number[] = [];
    for (let s = 0; s < k; s++) if (!haveSeeds.has(s)) seeds.push(s);
    if (seeds.length > 0) out.push({ instanceId, seeds });
  }
  return out;
}

/** True iff every (task, seed) in the grid has a scored result for `arm` — the run is fully resumed/complete. */
export function isRunComplete(
  taskIds: readonly string[],
  k: number,
  records: readonly FrontierSweResultRecord[],
  arm?: string,
): boolean {
  return missingTrials(taskIds, k, records, arm).length === 0;
}
