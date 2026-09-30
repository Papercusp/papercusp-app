/**
 * Log pruner. Mirrors bash prune_logs:
 *
 *   - Lists *.out files in <logDir>, oldest first by name (files are
 *     `<unix-ts>-<role>[-<fid>].out`, so name-sort = time-sort)
 *   - If count > config.logRetention (default 500), drops the oldest
 *     (count - retention) sets — including each .out's .err and .jsonl
 *     siblings.
 *   - Hook logs (under <logDir>/hooks/) and run.log itself are untouched.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface PruneResult {
  /** Files kept after prune. */
  kept: number;
  /** Files dropped by prune (each = 1 .out + .err + .jsonl). */
  dropped: number;
}

export function pruneLogs(logDir: string, cfg: HarnessConfig): PruneResult {
  const retention = parseInt(
    String(configGet<unknown>(cfg, 'logRetention', 500)),
    10,
  );
  const limit = Number.isFinite(retention) && retention > 0 ? retention : 500;

  if (!existsSync(logDir)) return { kept: 0, dropped: 0 };

  let outs: string[] = [];
  try {
    outs = readdirSync(logDir).filter((n) => n.endsWith('.out'));
  } catch {
    return { kept: 0, dropped: 0 };
  }
  outs.sort(); // ts prefix means name sort = oldest first

  if (outs.length <= limit) {
    return { kept: outs.length, dropped: 0 };
  }
  const dropCount = outs.length - limit;
  for (const outName of outs.slice(0, dropCount)) {
    const stem = outName.slice(0, -'.out'.length);
    for (const ext of ['.out', '.err', '.jsonl'] as const) {
      const p = join(logDir, `${stem}${ext}`);
      try {
        unlinkSync(p);
      } catch {
        // ignore — file may already be gone
      }
    }
  }
  return { kept: limit, dropped: dropCount };
}
