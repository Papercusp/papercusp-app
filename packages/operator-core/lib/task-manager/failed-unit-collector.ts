/**
 * Age-bounded fallback collection for failed transient task services.
 *
 * Ordinary task completion snapshots systemd terminal state into task_ledger and
 * then resets the failed unit. This pass handles only residue that escaped those
 * live-row paths. Its ordering is the contract: discover -> persist -> reset.
 * No durable terminal evidence means no reset, and reset-failed never signals a
 * process (the candidate is already ActiveState=failed with an empty cgroup).
 */
import { persistFailedTaskUnitTerminal } from './store';
import { resetFailedTaskUnit, scanStaleFailedTaskUnitTerminals } from './scope-terminal-state';

export const FAILED_TASK_UNIT_MIN_AGE_MS = 60 * 60_000;
export const FAILED_TASK_UNIT_PASS_LIMIT = 64;

export interface FailedTaskUnitCollectionResult {
  listed: number;
  inspected: number;
  candidates: number;
  evidenceDurable: number;
  reset: number;
  refused: number;
  resetFailed: number;
  errors: number;
  truncated: boolean;
  nextCursor: number;
}

export interface FailedTaskUnitCollectorDeps {
  workspaceId?: string;
  harnessSlug?: string | null;
  minAgeMs?: number;
  limit?: number;
  cursor?: number;
  scan?: typeof scanStaleFailedTaskUnitTerminals;
  persist?: typeof persistFailedTaskUnitTerminal;
  reset?: typeof resetFailedTaskUnit;
}

export async function collectStaleFailedTaskUnits(
  deps: FailedTaskUnitCollectorDeps = {},
): Promise<FailedTaskUnitCollectionResult> {
  const scan = await (deps.scan ?? scanStaleFailedTaskUnitTerminals)({
    minAgeMs: deps.minAgeMs ?? FAILED_TASK_UNIT_MIN_AGE_MS,
    limit: deps.limit ?? FAILED_TASK_UNIT_PASS_LIMIT,
    cursor: deps.cursor ?? 0,
  });
  const result: FailedTaskUnitCollectionResult = {
    listed: scan.listed,
    inspected: scan.inspected,
    candidates: scan.terminals.length,
    evidenceDurable: 0,
    reset: 0,
    refused: 0,
    resetFailed: 0,
    errors: 0,
    truncated: scan.truncated,
    nextCursor: scan.nextCursor,
  };
  const persist = deps.persist ?? persistFailedTaskUnitTerminal;
  const reset = deps.reset ?? resetFailedTaskUnit;

  for (const terminal of scan.terminals) {
    try {
      const persisted = await persist(terminal, {
        workspaceId: deps.workspaceId,
        harnessSlug: deps.harnessSlug,
      });
      if (!persisted.durable) {
        result.refused++;
        continue;
      }
      result.evidenceDurable++;
      if (await reset(terminal)) result.reset++;
      else result.resetFailed++;
    } catch {
      // One corrupt/conflicting unit must not suppress collection of the rest.
      // Its evidence remains loaded and the rotating cursor retries it later.
      result.errors++;
    }
  }
  return result;
}
