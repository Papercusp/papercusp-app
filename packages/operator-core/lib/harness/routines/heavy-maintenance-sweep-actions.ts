/**
 * Dedicated routine actions for the two expensive maintenance sweeps removed
 * from routinesTick by WI-10000846.
 *
 * The sweep implementations remain the authorities for fail-soft behaviour and
 * per-target safety. This adapter owns only scheduling concerns: apply the
 * shared heavy-work shed policy, retain compact DBOS diagnostics, and keep noisy
 * healthy rows out of the journal.
 */
import { shouldShedHeavyTick } from '../../dbos/tick-load-shed';
import type { SignalAccumulatorSweepResult } from '../../scout/signal-accumulator';
import type { DeadTargetResult } from './dead-target-sweep';
import { registerSystemAction, type SystemAction, type SystemActionResult } from './system-actions';

export const SCOUT_SIGNAL_ACCUMULATOR_SWEEP = 'scout-signal-accumulator-sweep';
export const DEAD_TARGET_REAPER_SWEEP = 'dead-target-reaper-sweep';

interface SignalAccumulatorActionDeps {
  shouldShed: (name: string) => boolean;
  run: () => Promise<SignalAccumulatorSweepResult[]>;
  warn: (message: string) => void;
}

interface DeadTargetReaperActionDeps {
  shouldShed: (name: string) => boolean;
  run: () => Promise<DeadTargetResult[]>;
  info: (message: string) => void;
  warn: (message: string) => void;
}

function shedResult(action: string): SystemActionResult {
  return { diagnostics: { action, outcome: 'shed' } };
}

function summarizeSignalAccumulator(results: readonly SignalAccumulatorSweepResult[]): Record<string, unknown> {
  const eligibleByWorkspace = new Map<string, number>();
  for (const result of results) {
    if (!eligibleByWorkspace.has(result.workspaceId)) {
      eligibleByWorkspace.set(result.workspaceId, result.eligibleBacklogCount);
    }
  }
  return {
    action: SCOUT_SIGNAL_ACCUMULATOR_SWEEP,
    outcome: 'ran',
    ranAtMs: Date.now(),
    resultCount: results.length,
    errorCount: results.filter((result) => result.outcome === 'error').length,
    evaluatedWorkspaceCount: results[0]?.evaluatedWorkspaceCount ?? 0,
    evaluatedScopeCount: results[0]?.evaluatedScopeCount ?? 0,
    eligibleBacklogCount: [...eligibleByWorkspace.values()].reduce((total, count) => total + count, 0),
    results: results.slice(0, 25),
  };
}

export function makeScoutSignalAccumulatorSweepAction(
  overrides: Partial<SignalAccumulatorActionDeps> = {},
): SystemAction {
  const deps: SignalAccumulatorActionDeps = {
    shouldShed: shouldShedHeavyTick,
    run: async () => (await import('../../scout/signal-accumulator')).scoutSignalAccumulatorSweep(),
    warn: (message) => console.warn(message),
    ...overrides,
  };

  return async () => {
    if (deps.shouldShed(SCOUT_SIGNAL_ACCUMULATOR_SWEEP)) {
      deps.warn(`[signal-accumulator] shed ${SCOUT_SIGNAL_ACCUMULATOR_SWEEP} under resource pressure`);
      return shedResult(SCOUT_SIGNAL_ACCUMULATOR_SWEEP);
    }
    const results = await deps.run();
    for (const result of results) {
      if (result.outcome === 'error') {
        deps.warn(`[signal-accumulator] error: ${result.installSlug} — ${result.reason}`);
      }
    }
    return { diagnostics: summarizeSignalAccumulator(results) };
  };
}

export function makeDeadTargetReaperSweepAction(overrides: Partial<DeadTargetReaperActionDeps> = {}): SystemAction {
  const deps: DeadTargetReaperActionDeps = {
    shouldShed: shouldShedHeavyTick,
    run: async () => (await import('./dead-target-sweep')).deadTargetReaperSweep(),
    info: (message) => console.info(message),
    warn: (message) => console.warn(message),
    ...overrides,
  };

  return async () => {
    if (deps.shouldShed(DEAD_TARGET_REAPER_SWEEP)) {
      deps.warn(`[dead-target] shed ${DEAD_TARGET_REAPER_SWEEP} under resource pressure`);
      return shedResult(DEAD_TARGET_REAPER_SWEEP);
    }
    const results = await deps.run();
    for (const result of results) {
      if (result.outcome === 'healthy' || result.outcome === 'protected' || result.outcome === 'inconclusive') {
        continue;
      }
      const line = `[dead-target] ${result.outcome}: ${result.installSlug} (${result.state}) — ${result.reason.slice(0, 200)}`;
      if (result.outcome === 'parked' || result.outcome === 'error') deps.warn(line);
      else deps.info(line);
    }
    const outcomeCounts = Object.fromEntries(
      [...new Set(results.map((result) => result.outcome))].map((outcome) => [
        outcome,
        results.filter((result) => result.outcome === outcome).length,
      ]),
    );
    return {
      diagnostics: {
        action: DEAD_TARGET_REAPER_SWEEP,
        outcome: 'ran',
        ranAtMs: Date.now(),
        resultCount: results.length,
        errorCount: results.filter((result) => result.outcome === 'error').length,
        outcomeCounts,
        results: results
          .filter((result) => result.outcome !== 'healthy' && result.outcome !== 'protected')
          .slice(0, 25),
      },
    };
  };
}

registerSystemAction(SCOUT_SIGNAL_ACCUMULATOR_SWEEP, makeScoutSignalAccumulatorSweepAction());
registerSystemAction(DEAD_TARGET_REAPER_SWEEP, makeDeadTargetReaperSweepAction());
