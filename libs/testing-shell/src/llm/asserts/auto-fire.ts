import { registerEvaluator } from './index';
import type { ContinueChainRow } from '../types';

/**
 * Auto-fire detection — derives from the operator_continue_chains
 * ledger written by the provider on each chain turn.
 *
 *   trigger='continue'              → <continue/>-tagged chain turn
 *   trigger='auto_fire_terminal'    → V8 terminal-question auto-fire
 *   trigger='reset'                 → user input reset the chain
 *
 * `auto_fire_did_not_happen` ignores 'reset' rows.
 */

function isAutoFire(r: ContinueChainRow): boolean {
  return r.trigger === 'continue' || r.trigger === 'auto_fire_terminal';
}

registerEvaluator('auto_fire_happened', (a, run) => {
  const matches = run.continueChainRows.filter((r) =>
    a.trigger === 'continue' ? r.trigger === 'continue' : r.trigger === 'auto_fire_terminal',
  );
  if (matches.length === 0) {
    return [{
      assertKind: 'auto_fire_happened',
      severity: 'error',
      claim: `Expected auto-fire trigger='${a.trigger}' to occur — none seen.`,
      suggestion: `Verify operator_continue_chains is being written for this trigger kind, and that the SUT actually fired.`,
    }];
  }
  return [];
});

registerEvaluator('auto_fire_did_not_happen', (_a, run) => {
  const fires = run.continueChainRows.filter(isAutoFire);
  if (fires.length > 0) {
    return [{
      assertKind: 'auto_fire_did_not_happen',
      severity: 'error',
      claim: `Auto-fire happened ${fires.length}× (${fires.map((f) => f.trigger).join(', ')}) but scenario forbids it.`,
    }];
  }
  return [];
});
