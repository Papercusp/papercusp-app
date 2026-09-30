/** Live `system:template-gym` handler.  The active routine row predates the
 * staging branch migration; registering the handler here closes the previous
 * silent "no handler registered" path. */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { captureImprovement } from '../improvements/capture-core';
import { findIssuesByWatchdogKeys } from '../../issues-engineer';
import { runGym, type GymRunSummary } from './template-gym-runner';

export function gymWatchdogKey(leg: string): string {
  return `template-gym:${leg}`;
}

async function openKeys(keys: string[]): Promise<Set<string>> {
  const rows = await findIssuesByWatchdogKeys(keys).catch(() => []);
  return new Set(
    rows
      .filter((row) => row.state === 'open')
      .map((row) => (row.payload as Record<string, unknown> | null)?.watchdogKey)
      .filter((key): key is string => typeof key === 'string'),
  );
}

export async function fileTemplateGymReds(summary: GymRunSummary): Promise<void> {
  const red = summary.legs.filter((leg) => !leg.ok);
  const existing = await openKeys(red.map((leg) => gymWatchdogKey(leg.leg)));
  for (const leg of red) {
    const watchdogKey = gymWatchdogKey(leg.leg);
    if (existing.has(watchdogKey)) continue;
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `template-drift: gym leg '${leg.leg}' is RED`,
      body:
        `system:template-gym run ${summary.runId} failed '${leg.leg}'.\n\n${leg.detail}\n\n` +
        `Re-run: npx tsx packages/operator-core/lib/harness/routines/template-gym-runner.ts --legs ${leg.leg}`,
      source: 'su',
      sourceRole: 'system',
      createdBy: 'system:template-gym',
      dedupScope: 'open',
      watchdogKey,
    }).catch(() => undefined);
  }
}

let inFlight = false;

registerSystemAction('template-gym', async (ctx: SystemActionCtx) => {
  if (inFlight) {
    console.info('[template-gym] prior in-process run still active; skipping overlapping fire');
    return;
  }
  inFlight = true;
  try {
    const summary = await runGym({
      papercuspMobileRoot:
        typeof ctx.triggerConfig?.papercuspMobileRoot === 'string' ? ctx.triggerConfig.papercuspMobileRoot : undefined,
      sidestageMobileRoot:
        typeof ctx.triggerConfig?.sidestageMobileRoot === 'string' ? ctx.triggerConfig.sidestageMobileRoot : undefined,
    });
    console.info(
      `[template-gym] ${summary.runId}: ${summary.green ? 'ALL GREEN' : 'RED'} — ${summary.legs
        .map((leg) => `${leg.leg}=${leg.ok ? 'green' : 'RED'}`)
        .join(', ')}`,
    );
    await fileTemplateGymReds(summary);
  } finally {
    inFlight = false;
  }
});
