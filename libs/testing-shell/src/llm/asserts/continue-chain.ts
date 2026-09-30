import { registerEvaluator } from './index';
import type { ContinueChainRow, Violation } from '../types';

registerEvaluator('continue_chain_within_cap', (a, run) => {
  const v: Violation[] = [];
  const chains = groupByChain(run.continueChainRows);
  for (const [chainId, rows] of chains) {
    const sorted = [...rows].sort((x, y) => x.turnIdx - y.turnIdx);
    const last = sorted[sorted.length - 1];
    if (sorted.length > a.maxTurns) {
      v.push({
        assertKind: 'continue_chain_within_cap',
        severity: 'error',
        claim: `Chain ${chainId.slice(0, 8)} ran ${sorted.length} turns — cap was ${a.maxTurns}`,
      });
    }
    if (last && last.elapsedSecsInChain > a.maxSecs) {
      v.push({
        assertKind: 'continue_chain_within_cap',
        severity: 'error',
        claim: `Chain ${chainId.slice(0, 8)} ran ${last.elapsedSecsInChain.toFixed(1)}s — cap was ${a.maxSecs}s`,
      });
    }
  }
  return v;
});

function groupByChain(rows: ContinueChainRow[]): Map<string, ContinueChainRow[]> {
  const m = new Map<string, ContinueChainRow[]>();
  for (const r of rows) {
    if (!m.has(r.chainId)) m.set(r.chainId, []);
    m.get(r.chainId)!.push(r);
  }
  return m;
}
