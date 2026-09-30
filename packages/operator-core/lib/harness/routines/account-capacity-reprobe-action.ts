/**
 * Durable system action for the scheduled account-capacity re-probe
 * (EI-21921833535413808).
 *
 * THE GAP THIS CLOSES. `accounts:probe-capacity` (agent-tools/accounts/probe-capacity.ts) already
 * does everything needed to correct a FALSE wall: one minimal upstream request per walled account,
 * recording the truth into the account-pool projection, and converging the gateway's separate
 * in-memory exclusion set. But before this action existed, NOTHING ever called it except a human or
 * agent thinking to run it by hand. `usageWalled` (account-pool-store.ts) is a THRESHOLD CHECK on a
 * projected `utilization`/`utilization7d` figure, not an observation of an upstream refusal — and a
 * walled account is routed no live traffic, so its projection never self-corrects. Measured
 * 2026-08-30: one manual probe recovered +50% of the usable Claude pool (2 -> 3 accounts) because a
 * 7d-window projection had drifted stale while the account's own 5h window was empty. Left
 * uncorrected, that capacity stays silently lost for as long as it takes someone to notice and run
 * the probe — here, potentially days, until the (possibly wrong) projected reset arrives.
 *
 * THE FIX. Fire the SAME `runCapacityProbe` core the tool uses, `walledOnly: true, apply: true`, on
 * a short cadence, for every provider this workspace has accounts for. `walledOnly` keeps the cost
 * bounded to accounts already flagged full (typically a handful), and a genuinely-walled account is
 * merely re-confirmed (a 429 carries the true reset and changes nothing) — only a FALSE wall is
 * corrected. `runCapacityProbe` already records any burn-verdict transition as a fact + severe-event
 * (WI-41147 leg c), so an unwall this action performs is never silent; this action itself only logs
 * a one-line per-tick summary for local operational visibility.
 *
 * Injectable `probe` dep (mirrors dead-citation-sweep-action.ts's `run`/`file` seam) so the action is
 * unit-testable without a live account pool, gateway, or network.
 */
import type { AccountProvider } from '../../deployment/account-pool';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const ACCOUNT_CAPACITY_REPROBE = 'account-capacity-reprobe';

/** Every provider this action re-probes each tick. Both are cheap: `walledOnly` means a provider
 *  with no walled accounts (or no accounts at all) costs nothing beyond loading the pool. */
const PROVIDERS: AccountProvider[] = ['claude', 'codex'];

export interface AccountCapacityReprobeSummary {
  probed: number;
  serving: string[];
  unwalled: string[];
  confirmedWalled: string[];
  failed: string[];
}

export interface AccountCapacityReprobeActionDeps {
  probe: (opts: { workspace: string; provider: AccountProvider }) => Promise<AccountCapacityReprobeSummary>;
  log: (message: string) => void;
}

async function productionProbe(opts: {
  workspace: string;
  provider: AccountProvider;
}): Promise<AccountCapacityReprobeSummary> {
  const { runCapacityProbe } = await import('../../agent-tools/accounts/probe-capacity');
  return runCapacityProbe({ workspace: opts.workspace, provider: opts.provider, walledOnly: true, apply: true });
}

export function makeAccountCapacityReprobeAction(overrides: Partial<AccountCapacityReprobeActionDeps> = {}) {
  const deps: AccountCapacityReprobeActionDeps = {
    probe: productionProbe,
    log: (message) => console.log(`[${ACCOUNT_CAPACITY_REPROBE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    for (const provider of PROVIDERS) {
      let summary: AccountCapacityReprobeSummary;
      try {
        summary = await deps.probe({ workspace: ctx.workspaceId, provider });
      } catch (err) {
        // A probe sweep failure (e.g. the gateway is down for readmit) must not take out the OTHER
        // provider's tick, and must not throw the whole action — there is always a next tick.
        deps.log(`${provider}: probe FAILED — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (summary.probed === 0) continue; // nothing walled for this provider right now — quiet by design
      deps.log(
        `${provider}: probed=${summary.probed} confirmedWalled=${summary.confirmedWalled.length} ` +
          `unwalled=${summary.unwalled.length}${summary.unwalled.length ? ` [${summary.unwalled.join(', ')}]` : ''} ` +
          `failed=${summary.failed.length}`,
      );
    }
  };
}

registerSystemAction(ACCOUNT_CAPACITY_REPROBE, makeAccountCapacityReprobeAction());
